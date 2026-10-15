// Service worker không tạo được blob URL, nên trang ẩn này làm hộ để chrome.downloads lưu file.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'BLOB_URL') return false;
  const url = URL.createObjectURL(new Blob([msg.text], { type: 'application/json' }));
  setTimeout(() => URL.revokeObjectURL(url), 2 * 60 * 1000);
  sendResponse({ url });
  return false;
});
