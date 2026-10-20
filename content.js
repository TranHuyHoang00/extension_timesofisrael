// Content script: phần CHUNG cho mọi site. Chạy trong tab của site, gọi fetch cùng origin nên mang theo cookie của trang.
// Background tiêm lib/site-utils.js + sites/<site>.js + file này mỗi lần chạy; cờ bên dưới chống đăng ký listener 2 lần.
// Phần riêng của từng site (đọc trang danh sách, bóc bài) lấy từ CRAWLER_SITES[cfg.site].
(() => {
  if (window.__crawlerLoaded) return;
  window.__crawlerLoaded = true;

  let abortFlag = false;

  // ===================== Cấu hình chống chặn =====================
  const BLOCK_RETRY_MS = 20000; // bị chặn: chờ 20 giây rồi thử lại tại chỗ
  const RETRIES_BEFORE_RELOAD = 2; // thử lại tại chỗ 2 lần, vẫn bị → báo background tự F5 trang
  const BEAT_MS = 30000; // trong lúc chờ lâu, cứ 30 giây báo background "vẫn còn sống"

  const send = (msg) => chrome.runtime.sendMessage(msg);
  const beat = () => send({ type: "CR_BEAT" }).catch(() => {});

  class Aborted extends Error {}
  class Fatal extends Error {} // lỗi khiến cả lượt chạy phải dừng (gateway lỗi, hàng chờ đầy)
  class Blocked extends Error {} // bị chặn / mất mạng sau khi đã thử lại → F5 rồi tự chạy tiếp
  const checkAbort = () => {
    if (abortFlag) throw new Aborted("Đã dừng");
  };

  // Phần riêng của site đang chạy (sites/<site>.js tự đăng ký vào CRAWLER_SITES)
  function siteOf(cfg) {
    const s = globalThis.CRAWLER_SITES?.[cfg.site || "timesofisrael"];
    if (!s) throw new Fatal(`Chưa nạp được phần xử lý của site "${cfg.site}"`);
    return s;
  }

  // Chờ theo từng nhịp ngắn: bấm Dừng là thoát ngay, và gửi nhịp tim cho watchdog
  async function sleep(ms) {
    const end = Date.now() + ms;
    let lastBeat = Date.now();
    while (Date.now() < end) {
      checkAbort();
      await new Promise((r) => setTimeout(r, Math.min(1000, end - Date.now())));
      if (Date.now() - lastBeat >= BEAT_MS) {
        beat();
        lastBeat = Date.now();
      }
    }
  }
  const randomDelay = (cfg) =>
    sleep((cfg.delayMin + Math.random() * (cfg.delayMax - cfg.delayMin)) * 1000);

  const log = (text) =>
    chrome.runtime.sendMessage({ type: "CR_LOG", text }).catch(() => {});

  // Trang trả về là trang kiểm tra của Cloudflare (chưa giải)?
  function isChallengeDoc(doc) {
    const title = doc.title || "";
    if (/just a moment|attention required|checking your browser/i.test(title))
      return true;
    return !!doc.querySelector(
      "#challenge-form, #challenge-running, #cf-challenge-running, .cf-browser-verification",
    );
  }

  // Tải một trang. Bị chặn / giới hạn tạm thời (403, 407, 408, 429, 5xx, trang Cloudflare, lỗi mạng):
  //   chờ 20 giây thử lại tại chỗ, tối đa 2 lần; vẫn bị → Blocked (background sẽ F5 rồi tự chạy tiếp).
  // Lỗi khác (ví dụ 404) → Error thường: bỏ qua bài / trang đó.
  async function fetchDoc(url) {
    for (let attempt = 0; ; attempt++) {
      checkAbort();
      let reason;
      try {
        const res = await fetch(url, { credentials: "include" });
        if (res.ok) {
          const html = await res.text();
          const doc = new DOMParser().parseFromString(html, "text/html");
          if (!isChallengeDoc(doc)) return { html, finalUrl: res.url, doc };
          reason = "trang kiểm tra Cloudflare";
        } else if (
          [403, 407, 408, 429].includes(res.status) ||
          res.status >= 500
        ) {
          reason = `HTTP ${res.status}`;
        } else {
          throw new Error(`HTTP ${res.status} khi tải ${url}`);
        }
      } catch (e) {
        if (e instanceof Aborted || e.message.startsWith("HTTP ")) throw e;
        reason = `lỗi mạng: ${e.message}`;
      }
      if (attempt >= RETRIES_BEFORE_RELOAD)
        throw new Blocked(`Bị chặn sau ${RETRIES_BEFORE_RELOAD + 1} lần thử (${reason})`);
      log(
        `Bị chặn (${reason}), thử lại sau ${BLOCK_RETRY_MS / 1000}s: ${url}`,
      );
      await sleep(BLOCK_RETRY_MS);
    }
  }

  // Hỏi background: link nào không cần crawl (đã gửi Kafka, đang chờ gửi, hoặc lượt chạy khác đang giữ chỗ)
  async function cachedOf(urls, owner = null) {
    if (!urls.length) return new Set();
    const r = await send({ type: "CACHE_FILTER", urls, owner });
    if (!r?.ok) throw new Error(r?.error || "Không đọc được cache");
    return new Set(r.seen);
  }

  // Trang cate (hoặc home) + vài trang kế tiếp → danh sách link bài mới
  //   skip: link đã xử lý trong lượt chạy này (bài nằm ở nhiều cate chỉ lấy một lần)
  //   useCache: false khi test, để thấy hết link
  async function collectFromListing(
    startUrl,
    cfg,
    re,
    { skip = new Set(), useCache = true, maxPages, owner = null },
  ) {
    const S = siteOf(cfg);
    const found = [];
    const foundSet = new Set();

    checkAbort();
    await randomDelay(cfg);
    let url = startUrl;
    let cursor = null; // con trỏ của trang đang đọc (trang 1 = null)
    let { doc } = await fetchDoc(url);

    for (let page = 0; ; page++) {
      checkAbort();
      const { links, next } = S.parseList(doc, { pageUrl: url, cateUrl: startUrl, re, cursor });
      const cached = useCache ? await cachedOf(links, owner) : new Set();
      const fresh = links.filter(
        (u) => !cached.has(u) && !skip.has(u) && !foundSet.has(u),
      );
      fresh.forEach((u) => {
        foundSet.add(u);
        found.push(u);
      });
      log(
        `${page === 0 ? "Trang cate" : `Quét trang #${page}`}: ${links.length} link bài, ${fresh.length} mới`,
      );

      if (links.length && fresh.length === 0) break; // toàn bài đã crawl → các trang sau còn cũ hơn
      if (page >= maxPages) break;
      if (!next) break; // hết trang

      checkAbort();
      await randomDelay(cfg);
      cursor = next;
      url = S.pageUrl(cursor, { cateUrl: startUrl });
      ({ doc } = await fetchDoc(url));
    }
    return found;
  }

  // Xử lý một bài: giữ chỗ → tải → bóc → đưa vào hàng chờ gửi Kafka (background gửi khi đủ batch)
  async function processArticle(url, src, cfg, runId, stats) {
    const c = await send({ type: "CLAIM", url, owner: runId });
    if (c?.stale)
      throw new Fatal("Lượt chạy này đã được thay bằng lượt mới, dừng");
    if (!c?.granted) {
      stats.skipped++;
      log(`Bỏ qua (đã gửi / đang chờ gửi / tab khác đang xử lý): ${url}`);
      return;
    }
    let r;
    try {
      await randomDelay(cfg); // trong try: bấm Dừng lúc đang chờ thì vẫn trả lại chỗ đã giữ
      const { html, doc, finalUrl } = await fetchDoc(url);
      const record = siteOf(cfg).parseArticle({
        url,
        finalUrl,
        html,
        doc,
        source: src,
        htmlMode: cfg.htmlMode,
      });
      // record.ts = Date.now(); // thời điểm crawl (ms), mở ra nếu cần
      r = await send({ type: "CR_RECORD", runId, record });
    } catch (e) {
      await send({ type: "RELEASE", url, owner: runId }).catch(() => {});
      throw e;
    }
    if (!r) throw new Error("Background không phản hồi");
    if (!r.ok) {
      if (r?.fatal) throw new Fatal(r.error);
      throw new Error(r?.error || "Background không nhận bài");
    }
    if (r.dup) {
      stats.dup++;
      return;
    }
    stats.queued++;
    if (r.gatewayError) {
      throw new Fatal(
        `Gateway lỗi: ${r.gatewayError}. Dừng lượt chạy, bài đã crawl nằm trong hàng chờ và sẽ gửi lại lượt sau`,
      );
    }
  }

  // Lỗi khiến cả lượt phải dừng (không bỏ qua để làm tiếp bài/cate khác)
  const isStopError = (e) =>
    e instanceof Aborted || e instanceof Fatal || e instanceof Blocked;

  // Kết thúc lượt: báo background biết lý do để quyết định F5 / dừng / xong
  function doneMessage(runId, mode, stats, e, finished = false) {
    return {
      type: "CR_DONE",
      runId,
      mode,
      stats,
      finished,
      error: !e ? null : e instanceof Aborted ? "Đã dừng theo yêu cầu" : e.message,
      gatewayDown: e instanceof Fatal,
      blocked: e instanceof Blocked,
      aborted: e instanceof Aborted,
    };
  }

  // Chế độ LỊCH: lần lượt từng cate → quét vài trang đầu → lấy các bài mới
  async function run({ runId, config: cfg }) {
    const stats = { found: 0, queued: 0, dup: 0, skipped: 0, errors: 0 };
    let err = null;
    try {
      const re = new RegExp(cfg.regex);
      const done = new Set();
      const sources = cfg.cates.length ? cfg.cates : [cfg.home];

      for (const src of sources) {
        checkAbort();
        log(`Mở ${src}`);
        let links;
        try {
          links = await collectFromListing(src, cfg, re, {
            skip: done,
            maxPages: cfg.maxPages,
            owner: runId,
          });
        } catch (e) {
          if (isStopError(e)) throw e;
          stats.errors++;
          log(`Lỗi khi đọc ${src}: ${e.message}`);
          continue;
        }
        stats.found += links.length;

        for (const url of links) {
          checkAbort();
          done.add(url); // bài nằm ở nhiều cate chỉ xử lý một lần trong lượt này
          try {
            await processArticle(url, src, cfg, runId, stats);
          } catch (e) {
            if (isStopError(e)) throw e;
            stats.errors++;
            log(`Lỗi bài ${url}: ${e.message}`);
          }
        }
      }
    } catch (e) {
      err = e;
    }
    await send(doneMessage(runId, "schedule", stats, err)).catch(() => {});
  }

  // Chế độ LẤY TOÀN BỘ: mỗi cate đi từ trang đầu tới trang cuối, từng trang một.
  // Xong trọn một trang thì lưu "dấu trang" (con trỏ của trang kế tiếp, do sites/<site>.js tạo ra),
  // bị ngắt thì lần sau đi tiếp từ dấu trang đó. Gặp trang toàn bài đã lấy vẫn đi tiếp (không dừng như lịch).
  //   positions: { [linkCate]: { cursor, label, pages, done } } do background gửi xuống
  async function backfill({ runId, config: cfg, positions = {} }) {
    const stats = { found: 0, queued: 0, dup: 0, skipped: 0, errors: 0 };
    let err = null;
    let finished = false;
    try {
      const S = siteOf(cfg);
      const label = (c) => (c && S.cursorLabel ? S.cursorLabel(c) : "") || "";
      const re = new RegExp(cfg.regex);
      const done = new Set();
      const sources = cfg.cates.length ? cfg.cates : [cfg.home];

      for (const src of sources) {
        checkAbort();
        const pos = positions[src] || {};
        if (pos.done) {
          log(`[Lấy toàn bộ] ${src}: đã xong từ trước, bỏ qua`);
          continue;
        }
        let cursor = pos.cursor ?? pos.params ?? null; // con trỏ của trang sắp lấy (params = tên cũ)
        let pageNo = (pos.pages || 0) + 1;
        let url, doc;

        await randomDelay(cfg);
        if (cursor) {
          const l = label(cursor);
          log(`[Lấy toàn bộ] ${src}: chạy tiếp từ trang ${pageNo}${l ? ` (${l})` : ""}`);
          url = S.pageUrl(cursor, { cateUrl: src });
        } else {
          log(`[Lấy toàn bộ] ${src}: bắt đầu từ trang 1`);
          url = src;
        }
        ({ doc } = await fetchDoc(url));

        while (true) {
          checkAbort();
          const { links, next } = S.parseList(doc, { pageUrl: url, cateUrl: src, re, cursor });
          const cached = await cachedOf(links, runId);
          const fresh = links.filter((u) => !cached.has(u) && !done.has(u));
          stats.found += fresh.length;
          log(`[Lấy toàn bộ] Trang ${pageNo}: ${links.length} link bài, ${fresh.length} mới`);

          for (const url of fresh) {
            checkAbort();
            done.add(url);
            try {
              await processArticle(url, src, cfg, runId, stats);
            } catch (e) {
              if (isStopError(e)) throw e;
              stats.errors++;
              log(`Lỗi bài ${url}: ${e.message}`);
            }
          }

          // Hết khi: không có trang kế tiếp, trang rỗng, hoặc con trỏ không đổi (tránh lặp vô hạn)
          const ended =
            !next || !links.length || JSON.stringify(next) === JSON.stringify(cursor);
          const r = await send({
            type: "BF_POS",
            runId,
            cate: src,
            pos: ended
              ? { done: true, pages: pageNo, cursor: cursor || null, label: label(cursor) }
              : { done: false, pages: pageNo, cursor: next, label: label(next) },
          });
          if (!r?.ok) throw new Fatal(r?.error || "Không lưu được vị trí");
          if (ended) {
            log(`[Lấy toàn bộ] ${src}: XONG (${pageNo} trang)`);
            break;
          }

          cursor = next;
          pageNo++;
          await randomDelay(cfg);
          url = S.pageUrl(cursor, { cateUrl: src });
          ({ doc } = await fetchDoc(url));
        }
      }
      finished = true;
    } catch (e) {
      err = e;
    }
    await send(doneMessage(runId, "backfill", stats, err, finished)).catch(() => {});
  }

  // Test: không gửi Kafka, không ghi cache. Lấy link của nguồn đầu tiên + bóc thử 1 bài.
  async function test(cfg) {
    const re = new RegExp(cfg.regex);
    const src = cfg.cates[0] || cfg.home;
    const links = await collectFromListing(src, cfg, re, {
      useCache: false,
      maxPages: Math.min(1, cfg.maxPages),
    });
    const result = {
      source: src,
      total: links.length,
      alreadySeen: (await cachedOf(links)).size,
      links: links.slice(0, 50),
      sample: null,
    };
    if (links.length) {
      await randomDelay(cfg);
      const { html, doc, finalUrl } = await fetchDoc(links[0]);
      const rec = siteOf(cfg).parseArticle({
        url: links[0],
        finalUrl,
        html,
        doc,
        source: src,
        htmlMode: cfg.htmlMode,
      });
      // rec.ts = Date.now();
      result.sample = { ...rec, html: rec.html.slice(0, 300) + "…" };
      if (rec.content_text)
        result.sample.content_text =
          rec.content_text.slice(0, 400) + (rec.content_text.length > 400 ? "…" : "");
    }
    return result;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "CR_RUN") {
      abortFlag = false;
      run(msg);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "CR_BACKFILL") {
      abortFlag = false;
      backfill(msg);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "CR_TEST") {
      abortFlag = false;
      test(msg.config).then(
        (r) => sendResponse({ ok: true, result: r }),
        (e) => sendResponse({ ok: false, error: e.message }),
      );
      return true;
    }
    if (msg.type === "CR_ABORT") {
      abortFlag = true;
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "CR_PING") {
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();