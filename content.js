// Content script: chạy trong tab của site, gọi fetch cùng origin nên mang theo cookie của trang.
// Background tiêm file này (cùng lib/toi.js) mỗi lần chạy; cờ bên dưới chống đăng ký listener 2 lần.
(() => {
  if (window.__toiCrawlerLoaded) return;
  window.__toiCrawlerLoaded = true;

  const T = globalThis.TOI;
  let abortFlag = false;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const randomDelay = cfg => {
    const ms = (cfg.delayMin + Math.random() * (cfg.delayMax - cfg.delayMin)) * 1000;
    return sleep(ms);
  };

  const log = text => chrome.runtime.sendMessage({ type: 'TOI_LOG', text }).catch(() => {});

  class Aborted extends Error {}
  class Fatal extends Error {}     // lỗi khiến cả lượt chạy phải dừng (gateway lỗi, hàng chờ đầy)
  const checkAbort = () => { if (abortFlag) throw new Aborted('Đã dừng'); };
  const send = msg => chrome.runtime.sendMessage(msg);

  async function fetchDoc(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status} khi tải ${url}`);
    const html = await res.text();
    return { html, finalUrl: res.url, doc: new DOMParser().parseFromString(html, 'text/html') };
  }

  // Hỏi background: link nào không cần crawl (đã gửi Kafka, đang chờ gửi, hoặc lượt chạy khác đang giữ chỗ)
  async function cachedOf(urls, owner = null) {
    if (!urls.length) return new Set();
    const r = await send({ type: 'CACHE_FILTER', urls, owner });
    if (!r?.ok) throw new Error(r?.error || 'Không đọc được cache');
    return new Set(r.seen);
  }

  // Trang cate (hoặc home) + các lượt Load more → danh sách link bài mới
  //   skip: link đã xử lý trong lượt chạy này (bài nằm ở nhiều cate chỉ lấy một lần)
  //   useCache: false khi test, để thấy hết link
  async function collectFromListing(startUrl, cfg, re, { skip = new Set(), useCache = true, maxPages, owner = null }) {
    const origin = new URL(startUrl).origin;
    const found = [];
    const foundSet = new Set();

    checkAbort();
    await randomDelay(cfg);
    let { doc } = await fetchDoc(startUrl);
    const isMobile = doc.body?.classList.contains('mobile') ?? false;

    for (let page = 0; ; page++) {
      checkAbort();
      const links = T.extractLinks(doc, startUrl, re);
      const cached = useCache ? await cachedOf(links, owner) : new Set();
      const fresh = links.filter(u => !cached.has(u) && !skip.has(u) && !foundSet.has(u));
      fresh.forEach(u => { foundSet.add(u); found.push(u); });
      log(`${page === 0 ? 'Trang cate' : `Load more #${page}`}: ${links.length} link bài, ${fresh.length} mới`);

      if (links.length && fresh.length === 0) break;   // toàn bài đã crawl → các lượt sau còn cũ hơn
      if (page >= maxPages) break;

      const p = T.getLoadMoreParams(doc);
      if (!p) break;                                   // không còn nút Load more → hết bài

      checkAbort();
      await randomDelay(cfg);
      ({ doc } = await fetchDoc(T.buildLoadMoreUrl(p, origin, isMobile)));
    }
    return found;
  }

  // Xử lý một bài: giữ chỗ → tải → bóc → đưa vào hàng chờ gửi Kafka (background gửi khi đủ batch)
  async function processArticle(url, src, cfg, runId, stats) {
    const c = await send({ type: 'CLAIM', url, owner: runId });
    if (!c?.granted) {
      stats.skipped++;
      log(`Bỏ qua (đã gửi / đang chờ gửi / tab khác đang xử lý): ${url}`);
      return;
    }
    await randomDelay(cfg);
    let r;
    try {
      const { html, doc, finalUrl } = await fetchDoc(url);
      const record = T.buildRecord({ url, finalUrl, html, doc, source: src, htmlMode: cfg.htmlMode });
      record.ts = Date.now();
      r = await send({ type: 'TOI_RECORD', runId, record });
    } catch (e) {
      await send({ type: 'RELEASE', url, owner: runId }).catch(() => {});
      throw e;
    }
    if (!r?.ok) {
      if (r?.fatal) throw new Fatal(r.error);
      throw new Error(r?.error || 'Background không nhận bài');
    }
    if (r.dup) { stats.dup++; return; }
    stats.queued++;
    if (r.gatewayError) {
      throw new Fatal(`Gateway lỗi: ${r.gatewayError}. Dừng lượt chạy, bài đã crawl nằm trong hàng chờ và sẽ gửi lại lượt sau`);
    }
  }

  // Lượt chạy thật: lần lượt từng cate → từng bài
  async function run({ runId, config: cfg }) {
    const stats = { found: 0, queued: 0, dup: 0, skipped: 0, errors: 0 };
    let error = null;
    let gatewayDown = false;
    try {
      const re = new RegExp(cfg.regex);
      const done = new Set();
      const sources = cfg.cates.length ? cfg.cates : [cfg.home];

      for (const src of sources) {
        checkAbort();
        log(`Mở ${src}`);
        let links;
        try {
          links = await collectFromListing(src, cfg, re, { skip: done, maxPages: cfg.maxPages, owner: runId });
        } catch (e) {
          if (e instanceof Aborted) throw e;
          stats.errors++;
          log(`Lỗi khi đọc ${src}: ${e.message}`);
          continue;
        }
        stats.found += links.length;

        for (const url of links) {
          checkAbort();
          done.add(url);   // bài nằm ở nhiều cate chỉ xử lý một lần trong lượt này
          try {
            await processArticle(url, src, cfg, runId, stats);
          } catch (e) {
            if (e instanceof Fatal) throw e;
            stats.errors++;
            log(`Lỗi bài ${url}: ${e.message}`);
          }
        }
      }
    } catch (e) {
      error = e instanceof Aborted ? 'Đã dừng theo yêu cầu' : e.message;
      gatewayDown = e instanceof Fatal;
    }
    await send({ type: 'TOI_DONE', runId, stats, error, gatewayDown }).catch(() => {});
  }

  // Test: không gửi Kafka, không ghi cache. Lấy link của nguồn đầu tiên + bóc thử 1 bài.
  async function test(cfg) {
    const re = new RegExp(cfg.regex);
    const src = cfg.cates[0] || cfg.home;
    const links = await collectFromListing(src, cfg, re, { useCache: false, maxPages: Math.min(1, cfg.maxPages) });
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
      const rec = T.buildRecord({ url: links[0], finalUrl, html, doc, source: src, htmlMode: cfg.htmlMode });
      rec.ts = Date.now();
      result.sample = {
        ...rec,
        content_text: rec.content_text ? rec.content_text.slice(0, 400) + (rec.content_text.length > 400 ? '…' : '') : null,
        html: rec.html.slice(0, 300) + '…',
      };
    }
    return result;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'TOI_RUN') {
      abortFlag = false;
      run(msg);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'TOI_TEST') {
      abortFlag = false;
      test(msg.config).then(
        r => sendResponse({ ok: true, result: r }),
        e => sendResponse({ ok: false, error: e.message }),
      );
      return true;
    }
    if (msg.type === 'TOI_ABORT') {
      abortFlag = true;
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'TOI_PING') {
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();