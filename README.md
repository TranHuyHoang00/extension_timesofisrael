Extension Chrome (Manifest V3) crawl bài viết theo lịch cron và gửi lên Kafka qua gateway theo batch. Mỗi tab có cấu hình riêng nên chạy được nhiều tab cùng lúc.

Phần chung (lịch, Lấy toàn bộ, cache, Kafka, tự F5 khi bị chặn) dùng cho mọi site; mỗi site chỉ cần một file riêng để đọc trang của site đó. Hiện có: **Times of Israel**. Thêm site: xem mục [Thêm site mới](#thêm-site-mới).

## Cài đặt

1. Mở `chrome://extensions`, bật **Developer mode**.
2. Bấm **Load unpacked**, chọn thư mục `extension_timesofisrael`.

## Dùng

1. Mở một tab `https://www.timesofisrael.com/` (tab này dành riêng cho crawler, đừng dùng để lướt web).
2. Bấm icon extension (hoặc chuột phải vào icon → **Open side panel**). Side panel **riêng của tab này** mở ở bên phải (cần Chrome 116+). Nhập cấu hình:
   - **Site**: chọn site. Đổi site thì link home và regex tự đổi theo mặc định của site đó.
   - **Link home**: trang chủ.
   - **Link cate**: mỗi dòng một chuyên mục, ví dụ `https://www.timesofisrael.com/jewish-times/`. Để trống thì crawl từ home.
   - **Cron**: ví dụ `*/30 * * * *`. Ô bên dưới hiện 3 lần chạy tiếp theo để kiểm tra.
   - **Regex**: lọc link bài. Để trống thì dùng regex mặc định của site (TOI: link dạng `https://www.timesofisrael.com/<slug-dai-nhieu-tu>/`).
   - **Delay ngẫu nhiên**: chờ ngẫu nhiên trong khoảng này trước mỗi request tới site.
   - **Số trang quét mỗi Cate**: ngoài trang cate, quét thêm bao nhiêu trang kế tiếp (TOI: mỗi trang = một lần bấm Load more; 0 = chỉ trang cate).
   - **HTML gửi đi**: chỉ khối `#main-content` của bài viết
   - **Giữ cache (ngày)**: link đã gửi được nhớ bao lâu để không gửi lại (mặc định 30).
   - **Kafka**:
     - **Gateway URL**, **API key**: dùng chung cho mọi tab, nhập một lần.
     - **Topic**, **Batch size** (1–100, mặc định 10): riêng từng tab.
3. Bấm **Test crawl**: xem số link tìm được, bài nào đã gửi, và một bài mẫu đã bóc. Không gửi Kafka, không ghi cache.
4. Bấm **Lưu & bật lịch**. Lần đầu Chrome sẽ hỏi cấp quyền truy cập domain gateway, chọn **Allow**. Muốn chạy ngay thì bấm **Chạy ngay**.

## Luồng chạy

1. Đầu lượt: dọn cache quá hạn, gửi nốt **hàng chờ** còn lại từ lượt trước. Gateway lỗi thì dừng, không crawl thêm.
2. Với từng link cate (không có thì home): tải trang → lọc link bài bằng regex → sang trang kế tiếp → dừng khi hết trang, đủ số trang, hoặc cả trang toàn bài đã biết.
3. Với từng bài mới: **giữ chỗ** → tải → bóc dữ liệu → đưa vào **hàng chờ gửi**.
4. Hàng chờ đủ **batch size** hoặc khoảng **4 MB dữ liệu** thì gửi một request lên gateway. Hết lượt thì gửi nốt phần còn lại.
5. Batch gửi thành công thì các bài được xoá khỏi hàng chờ và ghi vào **cache**.

Mọi request tới site chạy bằng `fetch` từ trong tab của site nên mang cookie của trang.

## Lấy toàn bộ bài cũ

**Lấy toàn bộ bài cũ** trong side panel: đi từ trang đầu tới **trang cuối** của từng cate (không giới hạn số trang), xong cate này sang cate kia.

- **Mỗi tab một chế độ**: tab đang bật lịch thì khoá Lấy toàn bộ (tắt lịch trước), tab đang Lấy toàn bộ thì khoá lịch, Chạy ngay, Test crawl.
- **Dấu trang**: xong trọn một trang thì lưu **con trỏ** của trang kế tiếp cho cate đó. Lưu theo **link cate** trong `chrome.storage.local` (khoá `bfpos`), nên đóng tab / tắt Chrome vẫn còn. Với TOI, con trỏ là tham số Load more (gồm mốc thời gian `before_date`), nên site đăng thêm bài mới trong lúc lấy cũng không làm lệch vị trí.
- **Bắt đầu / Tiếp tục**: chạy tiếp từ dấu trang; cate đã xong thì bỏ qua. Trang đang dở lúc bị ngắt được làm lại, bài đã gửi được cache bỏ qua nên không gửi trùng.
- **Dừng**: dừng ngay, giữ dấu trang. **Làm lại từ đầu**: xoá dấu trang của các cate đang cấu hình.
- Khác chế độ lịch: gặp trang toàn bài đã lấy vẫn đi tiếp (lịch thì dừng ở đó).
- Xong hết các cate thì tự thoát chế độ Lấy toàn bộ; lúc đó có thể bật lịch để lấy bài mới.

## Bị chặn, mất mạng: tự F5 và tự chạy tiếp

Áp dụng cho cả chế độ lịch và Lấy toàn bộ.

1. Tải trang / bài bị **403, 407, 408, 429, 5xx, trang kiểm tra Cloudflare, lỗi mạng** → chờ 20 giây thử lại tại chỗ, tối đa 2 lần.
2. Vẫn bị → **tự F5 tab**. Trang tải xong, chờ 5 giây: còn ở trang kiểm tra Cloudflare thì đợi giải xong; không thì **tự chạy tiếp** (Lấy toàn bộ: từ dấu trang; lịch: chạy lại lượt, bài đã gửi được bỏ qua).
3. **Watchdog** (mỗi phút): tab đang chạy mà **3 phút** không có tín hiệu (mất mạng ra trang lỗi, kẹt ở trang Cloudflare) → tự F5.
4. Tự F5 **10 lần liên tiếp** mà không lấy thêm được bài nào → dừng hẳn, ghi "Lỗi gần nhất". Lấy được bài thì bộ đếm về 0.
5. Gateway lỗi → dừng (F5 không giúp gì), bài đã crawl nằm trong hàng chờ.
6. Người dùng tự F5 tab đang Lấy toàn bộ → cũng tự chạy tiếp.

Trạng thái "đang Lấy toàn bộ" / "chờ tự chạy tiếp" nằm trong `chrome.storage.session` (chỉ trong RAM, tắt Chrome là mất). Mở lại Chrome, cấu hình lại tab rồi bấm **Bắt đầu / Tiếp tục**: chạy tiếp từ dấu trang đã lưu.

## Cấu trúc thư mục

| File | Việc |
| --- | --- |
| `background.js` | Lịch, khởi động lượt chạy, Lấy toàn bộ, tự F5, gửi Kafka (chung) |
| `content.js` | Chạy trong tab: tải trang, đi qua các trang, xử lý từng bài, chống chặn (chung) |
| `lib/sites.js` | **Danh sách site**: tên, host, link home, regex mặc định, file xử lý |
| `lib/site-utils.js` | Hàm dùng chung cho các file site (lọc link, làm sạch HTML, đổi giờ) |
| `sites/<site>.js` | **Phần riêng của từng site**: đọc trang danh sách, sang trang kế tiếp, bóc bài |
| `sites/_template.js` | Mẫu để làm site mới |
| `lib/config.js`, `lib/cache.js`, `lib/cron.js` | Kiểm tra cấu hình, IndexedDB, cron (chung) |

## Thêm site mới

1. Chép `sites/_template.js` thành `sites/<id>.js` (id viết liền không dấu, ví dụ `vnexpress`), đổi `ID` trong file.
2. Sửa 4 hàm trong file đó theo trang của site:
   - `parseList(doc, { pageUrl, re, cursor })` → `{ links, next }`: link bài trên trang, và **con trỏ** của trang kế tiếp (`null` = hết). Con trỏ là dữ liệu JSON (số trang, mốc thời gian, tham số API…), được lưu lại để Lấy toàn bộ chạy tiếp.
   - `pageUrl(cursor, { cateUrl })` → URL cần tải cho con trỏ đó.
   - `cursorLabel(cursor)` → chữ hiện trong tiến độ (không bắt buộc).
   - `parseArticle({ url, finalUrl, html, doc, source, htmlMode })` → bản ghi, **giữ đúng các trường** ở mục dưới để phía Kafka không phải đổi.
3. Khai báo site trong `lib/sites.js`: `name`, `hosts`, `script`, `home`, `regex`, `catePlaceholder`.
4. Thêm `"https://<host>/*"` vào `host_permissions` trong `manifest.json`.
5. Reload extension, chọn site trong side panel, bấm **Test crawl** để kiểm tra.

Lưu ý: cache chống trùng nằm trong từng Chrome profile. Nếu chạy mỗi site / mỗi nhóm cate ở một profile riêng thì các profile không biết bài của nhau, nên đừng cho hai profile quét cùng một cate.

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
  "domain":"https://www.timesofisrael.com",
  // "site": "timesofisrael",
  "url": "https://www.timesofisrael.com/...",
  // "post_id": "3914542",
  // "title": "...",
  // "sapo": "...",
  // "authors": [
  //   {
  //     "name": "Andrew Lapin",
  //     "url": "https://www.timesofisrael.com/writers/andrew-lapin/"
  //   }
  // ],
  // "published_text": "14 October 2026, 7:45 pm",
  // "published_at": "2026-10-14T16:45:00.000Z",
  // "topics": [{ "name": "Jewish Times", "url": "..." }],
  // "image": "https://static-cdn.toi-media.com/...",
  // "content_text": "Đoạn 1\n\nĐoạn 2 ...",
  // "category_url": "https://www.timesofisrael.com/jewish-times/",
  // "crawled_at": "2026-10-15T03:39:34.000Z",
  // "ts": 1792044574000,
  // "html_mode": "full",
  // "html_length": 117115,
  "html": "<!doctype html>..."
}
```

## Chống trùng

Dữ liệu nằm trong **IndexedDB** của extension (database `toi_crawler`), mỗi link ở một trong ba trạng thái:

| Bảng     | Ý nghĩa                                                                                               |
| -------- | ----------------------------------------------------------------------------------------------------- |
| `claims` | Đang được một lượt chạy xử lý (giữ chỗ 10 phút). Tab khác thấy thì bỏ qua. Tab bắt đầu lượt mới thì trả lại chỗ giữ của các lượt cũ trong chính tab đó |
| `outbox` | Đã crawl, đang chờ gửi Kafka. Tối đa 300 bài; đầy thì lượt chạy dừng. Quá 7 ngày chưa gửi được thì bỏ |
| `seen`   | Đã gửi Kafka thành công (cache). Giữ theo số ngày cài đặt                                             |

- Trùng **URL**: link đã nằm ở một trong ba bảng thì không crawl.
- Trùng **post_id**: cùng bài nhưng khác URL (đổi slug, chuyển hướng) thì không gửi lại, chỉ ghi nhận URL mới vào cache.
- Cache gắn theo **site**, các tab cùng site dùng chung.
- Quyền `unlimitedStorage` giúp Chrome không tự xoá dữ liệu khi ổ đĩa gần đầy.
- Nút **xoá cache** trong side panel để crawl và gửi lại từ đầu. Nút **gửi ngay** để gửi hàng chờ mà không cần đợi lượt sau.
- Xem dữ liệu: `chrome://extensions` → bấm **service worker** của extension → DevTools → tab **Application** → **IndexedDB** → `toi_crawler`.

**Lưu ý:** số ngày giữ cache nên dài hơn tuổi của bài cũ nhất mà crawler còn với tới (trang cate + số trang quét mỗi cate). Backend vẫn nên chống trùng theo `post_id`, vì cài lại extension hay chạy trên máy khác sẽ mất cache.

## Giới hạn

- Cấu hình gắn theo **tab id**. Đóng tab hoặc khởi động lại Chrome thì tab id đổi, cấu hình cũ bị dọn, cần cấu hình lại. Cấu hình gateway (URL, API key) và dữ liệu chống trùng vẫn giữ nguyên.
- Tab phải mở và ở đúng site. Nếu tab bị chuyển trang, extension tự quay về link home ở lượt sau; lượt đang chạy dở sẽ dừng, bài đã crawl vẫn nằm trong hàng chờ.
- Lịch cron tính theo giờ máy tính; Chrome có thể trễ tối đa ~30 giây và không chạy khi máy ngủ.
- TOI: bộ bóc dữ liệu viết cho bài thường; bài liveblog, blog (`blogs.timesofisrael.com`) có cấu trúc khác, regex mặc định không lấy.