// Danh sách site extension hỗ trợ (background + side panel dùng).
// Phần xử lý riêng của từng site (đọc trang danh sách, bóc bài) nằm ở sites/<id>.js, chạy trong tab của site.
//
// Thêm site mới: xem hướng dẫn trong sites/_template.js và README (mục "Thêm site mới").
//   1. Chép sites/_template.js thành sites/<id>.js, sửa phần đọc trang của site đó.
//   2. Khai báo site ở SITES bên dưới.
//   3. Thêm "https://<host>/*" vào host_permissions trong manifest.json.

export const SITES = {
  timesofisrael: {
    name: "Times of Israel",
    hosts: ["www.timesofisrael.com"], // link home / link cate phải thuộc các host này
    script: "sites/timesofisrael.js",
    home: "https://www.timesofisrael.com/",
    catePlaceholder: "https://www.timesofisrael.com/jewish-times/",
    // Link bài: một đoạn slug dài ngay sau domain, ví dụ /ten-bai-viet-rat-dai/
    regex: "^https://www\\.timesofisrael\\.com/(?:[a-z0-9]+-){4,}[a-z0-9]+/$",
  },
};

export const DEFAULT_SITE = "timesofisrael";

// Cấu hình cũ (trước khi có nhiều site) không có trường site → coi là site mặc định
export const getSite = (id) => SITES[id || DEFAULT_SITE] || null;
