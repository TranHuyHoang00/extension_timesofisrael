// Hàm dùng chung cho các file sites/*.js. Chạy trong tab của site (script thường, không phải module).
// Background tiêm file này trước file của site, rồi tới content.js.
(function (g) {
  // Nơi các file sites/*.js tự đăng ký: CRAWLER_SITES[id] = { parseList, pageUrl, parseArticle, ... }
  g.CRAWLER_SITES = g.CRAWLER_SITES || {};

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
  //   selector: chỉ lấy thẻ <a> nằm trong vùng này (mặc định cả trang)
  function extractLinks(root, base, re, selector = "a[href]") {
    const out = [];
    const seen = new Set();
    for (const a of root.querySelectorAll(selector)) {
      const url = normalizeUrl(a.getAttribute("href"), base);
      if (!url || seen.has(url) || !re.test(url)) continue;
      seen.add(url);
      out.push(url);
    }
    return out;
  }

  // Chữ trong một thẻ, gộp khoảng trắng. Không có → null
  const clean = (el) =>
    (el ? el.textContent.replace(/\s+/g, " ").trim() : null) || null;

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
    const p = (t) => Number(parts.find((x) => x.type === t).value);
    return (
      Date.UTC(p("year"), p("month") - 1, p("day"), p("hour"), p("minute"), p("second")) - ts
    );
  }

  // Giờ hiển thị trên site (theo múi giờ tz) → ISO UTC. month tính từ 0.
  function zonedToIso(year, month, day, hour, minute, tz) {
    const asUtc = Date.UTC(year, month, day, hour, minute);
    return new Date(asUtc - tzOffset(asUtc, tz)).toISOString();
  }

  // HTML gửi đi, theo chế độ:
  //   'raw'     = nguyên văn server trả về, không đụng gì
  //   'full'    = cả trang, đã làm sạch
  //   'article' = chỉ khối bài viết (mainSelector), đã làm sạch
  // Làm sạch = bỏ <script> (trừ application/ld+json: dữ liệu có cấu trúc của bài), <style>, <noscript>, comment,
  // rồi gộp khoảng trắng GIỮA hai thẻ thành một dấu cách (chữ bên trong thẻ không đổi).
  // Làm trên bản sao, nên các trường đã bóc không bị ảnh hưởng.
  function prepareHtml(html, doc, htmlMode, mainSelector) {
    if (htmlMode === "raw") return html;

    const mainEl = mainSelector ? doc.querySelector(mainSelector) : null;
    const root = (
      htmlMode === "article" && mainEl ? mainEl : doc.documentElement
    ).cloneNode(true);

    root
      .querySelectorAll('script:not([type="application/ld+json"]), style, noscript')
      .forEach((el) => el.remove());
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach((c) => c.remove());

    // Khối bài viết không có <head>: lấy thêm JSON-LD ở <head> để không mất dữ liệu có cấu trúc
    let out = root.outerHTML;
    if (htmlMode === "article" && mainEl) {
      const ld = [...doc.querySelectorAll('head script[type="application/ld+json"]')]
        .map((s) => s.outerHTML)
        .join("");
      out = ld + out;
    } else {
      out = "<!DOCTYPE html>" + out;
    }
    return out.replace(/>\s+</g, "> <").trim();
  }

  g.CrawlerUtils = {
    normalizeUrl,
    extractLinks,
    clean,
    tzOffset,
    zonedToIso,
    prepareHtml,
  };
})(globalThis);
