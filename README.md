Extension Chrome (Manifest V3) crawl bài viết Times of Israel theo lịch cron và gửi lên Kafka qua gateway theo batch. Mỗi tab có cấu hình riêng nên chạy được nhiều tab cùng lúc.

## Cài đặt

1. Mở `chrome://extensions`, bật **Developer mode**.
2. Bấm **Load unpacked**, chọn thư mục `extension_timesofisrael`.
3. Cập nhật từ bản cũ: chép đè file rồi bấm **Reload** (mũi tên tròn) ở extension. Bản 0.2.0 đã bỏ phần lưu file, có thể xoá `offscreen.html` và `offscreen.js` nếu còn.

## Dùng

1. Mở một tab `https://www.timesofisrael.com/` (tab này dành riêng cho crawler, đừng dùng để lướt web).
2. Bấm icon extension (hoặc chuột phải vào icon → **Open side panel**). Side panel **riêng của tab này** mở ở bên phải (cần Chrome 116+). Nhập cấu hình:
   - **Link home**: trang chủ.
   - **Link cate**: mỗi dòng một chuyên mục, ví dụ `https://www.timesofisrael.com/jewish-times/`. Để trống thì crawl từ home.
   - **Cron**: ví dụ `*/30 * * * *`. Ô bên dưới hiện 3 lần chạy tiếp theo để kiểm tra.
   - **Regex**: mặc định lấy link dạng `https://www.timesofisrael.com/<slug-dai-nhieu-tu>/`.
   - **Delay ngẫu nhiên**: chờ ngẫu nhiên trong khoảng này trước mỗi request tới site.
   - **Load more tối đa**: số lần gọi API Load more cho mỗi cate (0 = chỉ lấy bài render sẵn).
   - **HTML gửi đi**: toàn trang, hoặc chỉ khối `#main-content` (nhẹ hơn khoảng 10–20%).
   - **Giữ cache (ngày)**: link đã gửi được nhớ bao lâu để không gửi lại (mặc định 30).
   - **Kafka**:
     - **Gateway URL**, **API key**: dùng chung cho mọi tab, nhập một lần.
     - **Topic**, **Batch size** (1–100, mặc định 10): riêng từng tab.
3. Bấm **Test crawl**: xem số link tìm được, bài nào đã gửi, và một bài mẫu đã bóc. Không gửi Kafka, không ghi cache.
4. Bấm **Test gateway**: gửi một message `{"type":"test","source":"toi-crawler","ts":...}` vào topic để kiểm tra URL, API key, topic. Phía consumer nên bỏ qua message có `type = "test"`.
5. Bấm **Lưu & bật lịch**. Lần đầu Chrome sẽ hỏi cấp quyền truy cập domain gateway, chọn **Allow**. Muốn chạy ngay thì bấm **Chạy ngay**.

## Luồng chạy

1. Đầu lượt: dọn cache quá hạn, gửi nốt **hàng chờ** còn lại từ lượt trước. Gateway lỗi thì dừng, không crawl thêm.
2. Với từng link cate (không có thì home): tải trang → lọc link bài bằng regex → gọi API Load more → dừng khi hết nút, đủ số lần, hoặc cả lượt toàn bài đã biết.
3. Với từng bài mới: **giữ chỗ** → tải → bóc dữ liệu → đưa vào **hàng chờ gửi**.
4. Hàng chờ đủ **batch size** hoặc khoảng **4 MB dữ liệu** thì gửi một request lên gateway. Hết lượt thì gửi nốt phần còn lại.
5. Batch gửi thành công thì các bài được xoá khỏi hàng chờ và ghi vào **cache**.

Mọi request tới site chạy bằng `fetch` từ trong tab của site nên mang cookie của trang.

## Request gửi lên gateway

```
POST {gatewayUrl}?apikey={apiKey}
Content-Type: application/json

{ "topic": "<topic>", "message": "<JSON.stringify(mảng bài)>" }
```

- HTTP 2xx là thành công.
- Lỗi mạng, 5xx, 408, 429: thử lại tối đa 3 lần (chờ 2 giây, rồi 5 giây). Lỗi 4xx khác (sai key, sai topic) không thử lại.
- Gửi thất bại: bài vẫn nằm trong hàng chờ, lượt sau gửi lại mà không cần crawl lại. Lượt đang chạy dừng để không crawl thêm khi gateway lỗi.

Mỗi phần tử trong `message`:

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
  "ts": 1792044574000,
  "html_mode": "full",
  "html_length": 117115,
  "html": "<!doctype html>..."
}
```

`published_at` quy đổi với giả định giờ hiển thị trên site là giờ Israel.

## Chống trùng

Dữ liệu nằm trong **IndexedDB** của extension (database `toi_crawler`), mỗi link ở một trong ba trạng thái:

| Bảng     | Ý nghĩa                                                                                               |
| -------- | ----------------------------------------------------------------------------------------------------- |
| `claims` | Đang được một lượt chạy xử lý (giữ chỗ 10 phút). Tab khác thấy thì bỏ qua                             |
| `outbox` | Đã crawl, đang chờ gửi Kafka. Tối đa 300 bài; đầy thì lượt chạy dừng. Quá 7 ngày chưa gửi được thì bỏ |
| `seen`   | Đã gửi Kafka thành công (cache). Giữ theo số ngày cài đặt                                             |

- Trùng **URL**: link đã nằm ở một trong ba bảng thì không crawl.
- Trùng **post_id**: cùng bài nhưng khác URL (đổi slug, chuyển hướng) thì không gửi lại, chỉ ghi nhận URL mới vào cache.
- Cache gắn theo **site**, các tab cùng site dùng chung.
- Quyền `unlimitedStorage` giúp Chrome không tự xoá dữ liệu khi ổ đĩa gần đầy.
- Nút **xoá cache** trong side panel để crawl và gửi lại từ đầu. Nút **gửi ngay** để gửi hàng chờ mà không cần đợi lượt sau.
- Xem dữ liệu: `chrome://extensions` → bấm **service worker** của extension → DevTools → tab **Application** → **IndexedDB** → `toi_crawler`.

**Lưu ý:** số ngày giữ cache nên dài hơn tuổi của bài cũ nhất mà crawler còn với tới (trang cate + số lần Load more). Backend vẫn nên chống trùng theo `post_id`, vì cài lại extension hay chạy trên máy khác sẽ mất cache.

## Giới hạn

- Cấu hình gắn theo **tab id**. Đóng tab hoặc khởi động lại Chrome thì tab id đổi, cấu hình cũ bị dọn, cần cấu hình lại. Cấu hình gateway (URL, API key) và dữ liệu chống trùng vẫn giữ nguyên.
- Tab phải mở và ở đúng site. Nếu tab bị chuyển trang, extension tự quay về link home ở lượt sau; lượt đang chạy dở sẽ dừng, bài đã crawl vẫn nằm trong hàng chờ.
- Lịch cron tính theo giờ máy tính; Chrome có thể trễ tối đa ~30 giây và không chạy khi máy ngủ.
- Bộ bóc dữ liệu viết cho bài thường; bài liveblog, blog (`blogs.timesofisrael.com`) có cấu trúc khác, regex mặc định không lấy.
