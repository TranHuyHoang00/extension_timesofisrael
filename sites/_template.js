// MẪU cho site mới. Chép file này thành sites/<id>.js (id viết liền, không dấu, ví dụ "vnexpress"),
// sửa 4 hàm bên dưới cho đúng cấu trúc trang của site, rồi:
//   - khai báo site trong lib/sites.js (tên, host, link home, regex link bài, đường dẫn file này)
//   - thêm "https://<host>/*" vào host_permissions trong manifest.json
// Phần còn lại (lịch, Lấy toàn bộ, cache, Kafka, tự F5 khi bị chặn) dùng chung, không phải viết lại.
//
// File chạy trong tab của site (script thường, không phải module). CrawlerUtils (lib/site-utils.js) có sẵn:
//   normalizeUrl, extractLinks, clean, zonedToIso, prepareHtml
(function (g) {
  const U = g.CrawlerUtils;
  const ID = "template"; // ← đổi thành id của site, trùng với khoá trong lib/sites.js

  // 1. Đọc một trang danh sách (trang cate, hoặc trang kế tiếp).
  //    doc: trang đã tải; pageUrl: URL của trang đó; re: regex link bài; cursor: con trỏ của trang này (trang 1 = null)
  //    Trả về { links, next }:
  //      links = link bài trên trang (đã lọc regex)
  //      next  = con trỏ của trang kế tiếp, hoặc null nếu hết bài.
  //              Con trỏ phải là dữ liệu JSON (số, chuỗi, object) vì được lưu lại để Lấy toàn bộ chạy tiếp.
  //    Ví dụ dưới: site phân trang kiểu /cate/page/2/, /cate/page/3/ ...
  function parseList(doc, { pageUrl, re, cursor }) {
    const links = U.extractLinks(doc, pageUrl, re);
    const page = cursor?.page || 1;
    const hasNext = !!doc.querySelector('a.next, a[rel="next"]');
    return { links, next: hasNext && links.length ? { page: page + 1 } : null };
  }

  // 2. Con trỏ → URL cần tải (trang 1 không gọi hàm này, mà tải thẳng link cate)
  function pageUrl(cursor, { cateUrl }) {
    return new URL(`page/${cursor.page}/`, cateUrl).href;
  }

  // 3. Con trỏ → chữ hiện trong nhật ký / tiến độ (không bắt buộc)
  function cursorLabel(cursor) {
    return cursor?.page ? `trang ${cursor.page}` : "";
  }

  // 4. Bóc một bài. Giữ đúng các trường dưới đây để phía Kafka không phải đổi.
  //    post_id: mã bài của site (dùng chống trùng khi cùng bài có nhiều URL). Không có thì để null.
  function parseArticle({ url, finalUrl, html, doc, source, htmlMode }) {
    const q = (sel) => doc.querySelector(sel);
    const MAIN = "article"; // ← vùng chứa bài viết
    const outHtml = U.prepareHtml(html, doc, htmlMode, MAIN);
    const record = {
      site: ID,
      url,
      post_id: null,
      title: U.clean(q("h1")),
      sapo: q('meta[name="description"]')?.content || null,
      authors: [],
      published_text: null,
      published_at: q('meta[property="article:published_time"]')?.content || null,
      topics: [],
      image: q('meta[property="og:image"]')?.content || null,
      content_text: [...doc.querySelectorAll(`${MAIN} p`)].map(U.clean).filter(Boolean).join("\n\n") || null,
      category_url: source,
      crawled_at: new Date().toISOString(),
      html_mode: htmlMode,
      html_length: outHtml.length,
      html: outHtml,
    };
    if (finalUrl && finalUrl !== url) record.final_url = finalUrl;
    return record;
  }

  g.CRAWLER_SITES[ID] = { parseList, pageUrl, cursorLabel, parseArticle };
})(globalThis);
