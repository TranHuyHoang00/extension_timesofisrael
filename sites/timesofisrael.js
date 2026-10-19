// Phần riêng của Times of Israel. Chạy trong tab của site (script thường, không phải module).
// Cần lib/site-utils.js tiêm trước. Các hàm cần có: xem sites/_template.js.
(function (g) {
  const U = g.CrawlerUtils;
  const LOAD_MORE_PATH = "/wp-content/themes/rgb/ajax/topics_for_terms.php";
  const SITE_TZ = "Asia/Jerusalem";
  const MONTHS = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ];

  // ---------- Trang danh sách ----------
  // Phân trang bằng nút "Load more": tham số nằm sẵn trên nút (data-before_date, data-term_id, ...).
  // Con trỏ (cursor) = các tham số đó. Giữ tham số của trang đầu (exclude_posts…) vì các trang sau không có;
  // chỉ before_date thay đổi.
  function parseList(doc, { pageUrl, re, cursor }) {
    const links = U.extractLinks(doc, pageUrl, re);
    const a = doc.querySelector(".load-more a[data-before_date]");
    let next = a ? { ...(cursor || {}), ...a.dataset } : null;
    if (next && cursor && next.before_date === cursor.before_date) next = null; // không lùi thêm được → hết
    return { links, next };
  }

  // URL của trang kế tiếp, giống hệt request trình duyệt gửi khi bấm Load more
  function pageUrl(p, { cateUrl }) {
    const isMobile = document.body?.classList.contains("mobile") ?? false;
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
    return `${new URL(cateUrl).origin}${LOAD_MORE_PATH}?${q}`;
  }

  // Con trỏ → chữ dễ đọc cho nhật ký / tiến độ: đã lùi tới ngày nào
  function cursorLabel(p) {
    const n = Number(p?.before_date);
    return n ? new Date(n * 1000).toLocaleDateString("vi-VN") : "";
  }

  // ---------- Trang bài viết ----------
  // "14 October 2026, 7:45 pm" (trang bài) hoặc "October 7, 2026, 9:53 am" (trang danh sách)
  // Giả định giờ hiển thị là giờ Israel. Trả về ISO UTC hoặc null.
  function parseDate(text) {
    if (!text) return null;
    const s = text.replace(/\s+/g, " ").trim();
    let m = s.match(/^(\d{1,2}) ([A-Za-z]+),? (\d{4}),? (\d{1,2}):(\d{2}) ?(am|pm)$/i);
    let day, monthName, year, hh, mm, ap;
    if (m) {
      [, day, monthName, year, hh, mm, ap] = m;
    } else {
      m = s.match(/^([A-Za-z]+) (\d{1,2}),? (\d{4}),? (\d{1,2}):(\d{2}) ?(am|pm)$/i);
      if (!m) return null;
      [, monthName, day, year, hh, mm, ap] = m;
    }
    const month = MONTHS.indexOf(monthName.toLowerCase());
    if (month < 0) return null;
    const hour = (Number(hh) % 12) + (ap.toLowerCase() === "pm" ? 12 : 0);
    return U.zonedToIso(Number(year), month, Number(day), hour, Number(mm), SITE_TZ);
  }

  function parseArticle({ url, finalUrl, html, doc, source, htmlMode }) {
    const q = (sel) => doc.querySelector(sel);
    const main = q("#main-content") || doc;
    const clean = U.clean;

    const postId =
      q("#openwebComments")?.dataset.postId ||
      main.querySelector(".edit a[data-id]")?.dataset.id ||
      null;

    const authors = [...main.querySelectorAll("header .byline a")].map((a) => ({
      name: clean(a),
      url: U.normalizeUrl(a.getAttribute("href"), url),
    }));

    const dateText = clean(main.querySelector(".under-headline .date"));

    const topics = [...doc.querySelectorAll(".article-topics a")].map((a) => ({
      name: clean(a),
      url: U.normalizeUrl(a.getAttribute("href"), url),
    }));

    const body = main.querySelector(".the-content");
    const paragraphs = body
      ? [...body.querySelectorAll(":scope > p")].map(clean).filter(Boolean)
      : [];

    const image = main.querySelector(".wp-post-image")?.getAttribute("src") || null;

    const outHtml = U.prepareHtml(html, doc, htmlMode, "#main-content");

    const record = {
      site: "timesofisrael",
      url,
      post_id: postId,
      title: clean(main.querySelector("h1.headline")),
      sapo: clean(main.querySelector("h2.underline")),
      authors,
      published_text: dateText,
      published_at: parseDate(dateText),
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

  g.CRAWLER_SITES.timesofisrael = { parseList, pageUrl, cursorLabel, parseArticle };
})(globalThis);
