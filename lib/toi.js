// Các hàm xử lý riêng cho Times of Israel. Chạy trong content script (script thường, không phải module).
(function (global) {
  const LOAD_MORE_PATH = "/wp-content/themes/rgb/ajax/topics_for_terms.php";
  const SITE_TZ = "Asia/Jerusalem";
  const MONTHS = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];

  // Bỏ #hash và ?query để cùng một bài luôn ra cùng một URL (dùng cho cache)
  function normalizeUrl(href, base) {
    try {
      const u = new URL(href, base);
      u.hash = "";
      u.search = "";
      return u.href;
    } catch {
      return null;
    }
  }

  // Lấy link bài viết (đã lọc regex, bỏ trùng, giữ thứ tự xuất hiện)
  function extractLinks(root, base, re) {
    const out = [];
    const seen = new Set();
    for (const a of root.querySelectorAll("a[href]")) {
      const url = normalizeUrl(a.getAttribute("href"), base);
      if (!url || seen.has(url) || !re.test(url)) continue;
      seen.add(url);
      out.push(url);
    }
    return out;
  }

  // Tham số Load more nằm sẵn trên nút: data-before_date, data-term_id, ...
  function getLoadMoreParams(root) {
    const a = root.querySelector(".load-more a[data-before_date]");
    return a ? { ...a.dataset } : null;
  }

  // Dựng URL API giống hệt request trình duyệt gửi khi bấm Load more
  function buildLoadMoreUrl(p, origin, isMobile) {
    const q = new URLSearchParams({
      taxonomy: p.taxonomy || "category",
      term_id: p.term_id || "",
      post_tag: p.post_tag || "",
      before_date: p.before_date,
      numposts: p.numposts || "15",
      is_mobile: isMobile ? "true" : "false",
      post_type: p.post_type || "",
      is_load_more: "0",
    });
    if (p.exclude_posts) q.set("exclude_posts", p.exclude_posts);
    return `${origin}${LOAD_MORE_PATH}?${q}`;
  }

  // Độ lệch (ms) của múi giờ tz tại thời điểm ts
  function tzOffset(ts, tz) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(ts);
    const g = (t) => Number(parts.find((p) => p.type === t).value);
    return (
      Date.UTC(
        g("year"),
        g("month") - 1,
        g("day"),
        g("hour"),
        g("minute"),
        g("second"),
      ) - ts
    );
  }

  // "14 October 2026, 7:45 pm" (trang bài) hoặc "October 7, 2026, 9:53 am" (trang danh sách)
  // Giả định giờ hiển thị là giờ Israel. Trả về ISO UTC hoặc null.
  function parseToiDate(text) {
    if (!text) return null;
    const s = text.replace(/\s+/g, " ").trim();
    let m = s.match(
      /^(\d{1,2}) ([A-Za-z]+),? (\d{4}),? (\d{1,2}):(\d{2}) ?(am|pm)$/i,
    );
    let day, monthName, year, hh, mm, ap;
    if (m) {
      [, day, monthName, year, hh, mm, ap] = m;
    } else {
      m = s.match(
        /^([A-Za-z]+) (\d{1,2}),? (\d{4}),? (\d{1,2}):(\d{2}) ?(am|pm)$/i,
      );
      if (!m) return null;
      [, monthName, day, year, hh, mm, ap] = m;
    }
    const month = MONTHS.indexOf(monthName.toLowerCase());
    if (month < 0) return null;
    const hour = (Number(hh) % 12) + (ap.toLowerCase() === "pm" ? 12 : 0);
    const asUtc = Date.UTC(Number(year), month, Number(day), hour, Number(mm));
    return new Date(asUtc - tzOffset(asUtc, SITE_TZ)).toISOString();
  }

  const clean = (el) =>
    (el ? el.textContent.replace(/\s+/g, " ").trim() : null) || null;

  // HTML gửi đi, theo chế độ:
  //   'raw'     = nguyên văn server trả về, không đụng gì (cho lưu trữ / bóc lại sau)
  //   'full'    = cả trang, đã làm sạch
  //   'article' = chỉ khối #main-content, đã làm sạch
  // Làm sạch = bỏ <script> (trừ application/ld+json: dữ liệu có cấu trúc của bài), <style>, <noscript>, comment,
  // rồi gộp khoảng trắng GIỮA hai thẻ thành một dấu cách (chữ bên trong thẻ không đổi).
  // Làm trên bản sao, nên các trường bóc ở trên không bị ảnh hưởng.
  function prepareHtml(html, doc, htmlMode) {
    if (htmlMode === "raw") return html;

    const mainEl = doc.querySelector("#main-content");
    const root = (
      htmlMode === "article" && mainEl ? mainEl : doc.documentElement
    ).cloneNode(true);

    root
      .querySelectorAll(
        'script:not([type="application/ld+json"]), style, noscript',
      )
      .forEach((el) => el.remove());
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach((c) => c.remove());

    // Khối bài viết không có <head>: lấy thêm JSON-LD ở <head> để không mất dữ liệu có cấu trúc
    let out = root.outerHTML;
    if (htmlMode === "article" && mainEl) {
      const ld = [
        ...doc.querySelectorAll('head script[type="application/ld+json"]'),
      ]
        .map((s) => s.outerHTML)
        .join("");
      out = ld + out;
    } else {
      out = "<!DOCTYPE html>" + out;
    }
    return out.replace(/>\s+</g, "> <").trim();
  }

  // Bóc các trường chính từ trang bài viết + gắn HTML
  function buildRecord({ url, finalUrl, html, doc, source, htmlMode }) {
    const q = (sel) => doc.querySelector(sel);
    const main = q("#main-content") || doc;

    const postId =
      q("#openwebComments")?.dataset.postId ||
      main.querySelector(".edit a[data-id]")?.dataset.id ||
      null;

    const authors = [...main.querySelectorAll("header .byline a")].map((a) => ({
      name: clean(a),
      url: normalizeUrl(a.getAttribute("href"), url),
    }));

    const dateText = clean(main.querySelector(".under-headline .date"));

    const topics = [...doc.querySelectorAll(".article-topics a")].map((a) => ({
      name: clean(a),
      url: normalizeUrl(a.getAttribute("href"), url),
    }));

    const body = main.querySelector(".the-content");
    const paragraphs = body
      ? [...body.querySelectorAll(":scope > p")].map(clean).filter(Boolean)
      : [];

    const image =
      main.querySelector(".wp-post-image")?.getAttribute("src") || null;

    const outHtml = prepareHtml(html, doc, htmlMode);

    const record = {
      site: "timesofisrael",
      url,
      post_id: postId,
      title: clean(main.querySelector("h1.headline")),
      sapo: clean(main.querySelector("h2.underline")),
      authors,
      published_text: dateText,
      published_at: parseToiDate(dateText),
      topics,
      image,
      content_text: paragraphs.join("\n\n") || null,
      category_url: source,
      crawled_at: new Date().toISOString(),
      html_mode: htmlMode,
      html_length: outHtml.length,
      html: outHtml,
    };
    if (finalUrl && finalUrl !== url) record.final_url = finalUrl;
    return record;
  }

  global.TOI = {
    normalizeUrl,
    extractLinks,
    getLoadMoreParams,
    buildLoadMoreUrl,
    parseToiDate,
    buildRecord,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
