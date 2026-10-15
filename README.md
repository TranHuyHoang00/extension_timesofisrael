# TOI Crawler (bản test – lưu file, chưa đẩy Kafka)

Extension Chrome (Manifest V3) crawl bài viết Times of Israel theo lịch cron. Mỗi tab có cấu hình riêng nên chạy được nhiều tab cùng lúc.

## Cài đặt

1. Giải nén thư mục `extension_timesofisrael`.
2. Mở `chrome://extensions`, bật **Developer mode**.
3. Bấm **Load unpacked**, chọn thư mục vừa giải nén.
4. Vào `chrome://settings/downloads`, **tắt** "Ask where to save each file before downloading", nếu không Chrome sẽ hỏi chỗ lưu cho từng bài.

## Dùng

1. Mở một tab `https://www.timesofisrael.com/` (tab này dành riêng cho crawler, đừng dùng để lướt web).
2. Bấm icon extension (hoặc chuột phải vào icon → **Open side panel**). Side panel **riêng của tab này** mở ở bên phải (cần Chrome 116+). Nhập cấu hình:
   - **Link home**: trang chủ.
   - **Link cate**: mỗi dòng một chuyên mục, ví dụ `https://www.timesofisrael.com/jewish-times/`. Để trống thì crawl từ home.
   - **Cron**: ví dụ `*/30 * * * *`. Ô bên dưới hiện 3 lần chạy tiếp theo để kiểm tra.
   - **Regex**: mặc định lấy link dạng `https://www.timesofisrael.com/<slug-dai-nhieu-tu>/`.
   - **Delay ngẫu nhiên**: chờ ngẫu nhiên trong khoảng này trước mỗi request.
   - **Load more tối đa**: số lần gọi API Load more cho mỗi cate (0 = chỉ lấy bài render sẵn).
   - **HTML lưu lại**: toàn trang, hoặc chỉ khối `#main-content`.
   - **Giữ cache (ngày)**: link đã crawl được nhớ bao lâu để không crawl lại (mặc định 30).
3. Bấm **Test** trước: xem số link tìm được, bài nào đã có trong cache, và một bài mẫu đã bóc. Test không lưu file, không ghi cache.
4. Bấm **Lưu & bật lịch**. Muốn chạy thử thật ngay thì bấm **Chạy ngay**.

Muốn crawl site/cate khác song song: mở tab khác, mở side panel của tab đó và cấu hình. Mỗi tab có panel riêng, giữ nguyên form, kết quả test và nhật ký khi chuyển qua lại giữa các tab.

## Luồng chạy

Đến giờ cron → với từng link cate (không có thì home): tải trang → lọc link bài bằng regex → gọi API Load more theo nút `.load-more` (tham số lấy sẵn trên nút, kể cả `before_date` cho lượt sau) → dừng khi hết nút, đủ số lần, hoặc cả lượt toàn bài đã crawl → tải từng bài mới → bóc dữ liệu → lưu file → ghi vào cache.

Mọi request chạy bằng `fetch` từ trong tab của site nên mang cookie của trang.

## File đầu ra

`Downloads/toi_crawl/<YYYY-MM-DD>/<post_id>_<slug>.json`, mỗi bài một file (tương ứng một message Kafka sau này):

```json
{
  "site": "timesofisrael",
  "url": "https://www.timesofisrael.com/...",
  "post_id": "3914542",
  "title": "...",
  "sapo": "...",
  "authors": [
    {
      "name": "Andrew Lapin",
      "url": "https://www.timesofisrael.com/writers/andrew-lapin/"
    }
  ],
  "published_text": "14 October 2026, 7:45 pm",
  "published_at": "2026-10-14T16:45:00.000Z",
  "topics": [{ "name": "Jewish Times", "url": "..." }],
  "image": "https://static-cdn.toi-media.com/...",
  "content_text": "Đoạn 1\n\nĐoạn 2 ...",
  "category_url": "https://www.timesofisrael.com/jewish-times/",
  "crawled_at": "2026-10-15T03:39:34.000Z",
  "html_mode": "full",
  "html_length": 117115,
  "html": "<!doctype html>..."
}
```

`published_at` quy đổi với giả định giờ hiển thị trên site là giờ Israel; đối chiếu với giờ thật trên trang để xác nhận.

## Cache

Lưu trong **IndexedDB** của extension (database `toi_crawler`, bảng `seen`). Mỗi link là một bản ghi `{ url, host, post_id, savedAt }`, chỉ ghi sau khi bài đã lưu thành công; bài lỗi không vào cache nên lần sau được thử lại.

- Cache gắn theo **site**: hai tab cùng site dùng chung, không lưu trùng.
- Đầu mỗi lượt chạy, link quá số ngày **Giữ cache** bị xoá tự động.
- Nút **xoá cache** trong side panel để crawl lại từ đầu.
- Cache dạng cũ (mảng trong `chrome.storage.local`) được tự chuyển sang IndexedDB khi cập nhật extension.
- Xem dữ liệu: `chrome://extensions` → bấm **service worker** của extension → DevTools → tab **Application** → **IndexedDB** → `toi_crawler`.

## Chuyển sang Kafka

Sửa hàm `sinkRecord` trong `background.js`: thay `saveToFile(record)` bằng request tới Kafka REST proxy / API trung gian (trình duyệt không kết nối thẳng Kafka được), và thêm domain đó vào `host_permissions` trong `manifest.json`.

## Giới hạn

- Cấu hình gắn theo **tab id**. Đóng tab hoặc khởi động lại Chrome thì tab id đổi, cấu hình cũ bị dọn, cần cấu hình lại.
- Tab phải mở và ở đúng site. Nếu tab bị chuyển trang, extension tự quay về link home ở lượt sau; lượt đang chạy dở sẽ dừng.
- Lịch cron tính theo giờ máy tính; Chrome có thể trễ tối đa ~30 giây và không chạy khi máy ngủ.
- Bộ bóc dữ liệu viết cho bài thường; bài liveblog, blog (`blogs.timesofisrael.com`) có cấu trúc khác, regex mặc định không lấy.
