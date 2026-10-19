import { nextRuns } from './lib/cron.js';
import { DEFAULTS, GLOBAL_DEFAULTS, gatewayOriginPattern } from './lib/config.js';
import { SITES, getSite } from './lib/sites.js';

const $ = id => document.getElementById(id);
const send = msg => chrome.runtime.sendMessage(msg);
const fmt = ts => (ts ? new Date(ts).toLocaleString('vi-VN', { hour12: false }) : '—');

let tabId = null;
let formFilled = false;
let currentSite = null; // site đang chọn trên form

// Danh sách site cho ô chọn
function fillSiteOptions() {
  const sel = $('site');
  sel.innerHTML = '';
  for (const [id, s] of Object.entries(SITES)) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = s.name;
    sel.appendChild(o);
  }
}

// Đổi site: link home / regex còn là mặc định của site cũ (hoặc trống) thì đổi sang mặc định của site mới
function applySite(id) {
  const prev = getSite(currentSite);
  const next = getSite(id);
  if (!next) return;
  if (!$('home').value.trim() || $('home').value.trim() === prev?.home) $('home').value = next.home;
  if (!$('regex').value.trim() || $('regex').value.trim() === prev?.regex) $('regex').value = next.regex;
  $('home').placeholder = next.home;
  $('cates').placeholder = next.catePlaceholder || next.home;
  currentSite = id;
  updateHints();
}

function readForm() {
  return {
    site: $('site').value,
    home: $('home').value,
    cates: $('cates').value,
    cron: $('cron').value,
    regex: $('regex').value,
    delayMin: $('delayMin').value,
    delayMax: $('delayMax').value,
    maxPages: $('maxPages').value,
    htmlMode: $('htmlMode').value,
    cacheDays: $('cacheDays').value,
    topic: $('topic').value,
    batchSize: $('batchSize').value,
  };
}

function readGlobal() {
  return { gatewayUrl: $('gatewayUrl').value, apiKey: $('apiKey').value };
}

function fillGlobal(g) {
  const v = { ...GLOBAL_DEFAULTS, ...(g || {}) };
  $('gatewayUrl').value = v.gatewayUrl;
  $('apiKey').value = v.apiKey;
}

// Xin quyền truy cập domain gateway. Phải gọi ngay trong thao tác bấm nút (Chrome yêu cầu).
async function requestGatewayPermission() {
  const pattern = gatewayOriginPattern($('gatewayUrl').value);
  if (!pattern) return true; // URL sai sẽ được báo lỗi ở bước kiểm tra cấu hình
  const ok = await chrome.permissions.request({ origins: [pattern] });
  if (!ok) showErrors([`Chưa được cấp quyền truy cập ${pattern}, extension không gửi được dữ liệu lên gateway`]);
  return ok;
}

function fillForm(cfg) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  if (!getSite(c.site)) c.site = DEFAULTS.site;
  $('site').value = c.site;
  currentSite = c.site;
  $('home').placeholder = getSite(c.site).home;
  $('cates').placeholder = getSite(c.site).catePlaceholder || getSite(c.site).home;
  $('home').value = c.home;
  $('cates').value = (c.cates || []).join('\n');
  $('cron').value = c.cron;
  $('regex').value = c.regex;
  $('delayMin').value = c.delayMin;
  $('delayMax').value = c.delayMax;
  $('maxPages').value = c.maxPages;
  $('htmlMode').value = c.htmlMode;
  $('cacheDays').value = c.cacheDays;
  $('topic').value = c.topic;
  $('batchSize').value = c.batchSize;
  updateHints();
}

function updateHints() {
  const cronHint = $('cronHint');
  try {
    const runs = nextRuns($('cron').value, 3);
    cronHint.textContent = runs.length ? `Tiếp theo: ${runs.map(d => fmt(d)).join(' · ')}` : 'Không có lần chạy nào';
    cronHint.classList.remove('bad');
  } catch (e) {
    cronHint.textContent = e.message;
    cronHint.classList.add('bad');
  }

  const regexHint = $('regexHint');
  try {
    new RegExp($('regex').value);
    regexHint.textContent = 'Regex hợp lệ';
    regexHint.classList.remove('bad');
  } catch (e) {
    regexHint.textContent = `Regex lỗi: ${e.message}`;
    regexHint.classList.add('bad');
  }
}

function showErrors(list) {
  const box = $('errors');
  box.hidden = !list?.length;
  box.textContent = (list || []).join('\n');
}

async function refresh() {
  const s = await send({ type: 'GET_STATE', tabId });
  if (!s?.ok) return;
  if (!formFilled) { fillForm(s.cfg); fillGlobal(s.global); formFilled = true; }

  const st = s.status || {};
  const badge = $('badge');
  if (s.bfActive) { badge.textContent = `Lấy toàn bộ${st.running ? ` · đã gửi ${st.runSent || 0}` : ' · chờ chạy tiếp'}`; badge.className = 'badge backfill'; }
  else if (st.running) { badge.textContent = `Đang chạy · đã gửi ${st.runSent || 0}`; badge.className = 'badge running'; }
  else if (st.enabled) { badge.textContent = 'Đang bật'; badge.className = 'badge on'; }
  else { badge.textContent = 'Tắt'; badge.className = 'badge off'; }

  // Mỗi tab một chế độ: đang bật lịch thì khoá Lấy toàn bộ, đang Lấy toàn bộ thì khoá lịch
  const bf = !!s.bfActive;
  $('btnSave').disabled = bf;
  $('btnBfStart').disabled = bf || !!st.enabled || !!st.running;
  $('btnBfStop').disabled = !bf;
  $('btnBfReset').disabled = bf || !!st.running || !s.bfProgress?.some(p => p.pages || p.done);
  $('btnTest').disabled = bf || !!st.running;
  $('bfHint').textContent = st.enabled
    ? 'Đang bật lịch: tắt lịch để dùng Lấy toàn bộ.'
    : bf ? 'Đang Lấy toàn bộ: lịch bị khoá cho đến khi xong hoặc bấm Dừng.' : '';
  renderBfProgress(s.bfProgress || []);

  $('nextRun').textContent = st.enabled ? fmt(st.nextRunAt) : '— (lịch đang tắt)';
  $('lastRun').textContent = st.lastRunAt ? `${fmt(st.lastRunAt)} · ${st.lastRunSummary || ''}` : '—';
  $('totalSent').textContent = st.totalSent || 0;
  $('pendingCount').textContent = s.pendingCount;
  $('btnFlush').hidden = !s.pendingCount;
  $('seenCount').textContent = s.seenCount;
  $('cacheKeep').textContent = s.cfg ? ` (giữ ${s.cfg.cacheDays ?? DEFAULTS.cacheDays} ngày)` : '';

  const err = $('lastError');
  err.hidden = !st.lastError;
  err.textContent = st.lastError ? `Lỗi gần nhất: ${st.lastError}` : '';

  $('btnRun').disabled = !!st.running || !s.cfg || bf;
  $('btnStop').disabled = bf || (!st.enabled && !st.running);

  const logs = $('logs');
  const atBottom = logs.scrollTop + logs.clientHeight >= logs.scrollHeight - 4;
  logs.textContent = (s.logs || []).slice(-60).join('\n') || 'Chưa có hoạt động';
  if (atBottom) logs.scrollTop = logs.scrollHeight;
}

// Tiến độ Lấy toàn bộ của từng cate: số trang đã xong, đã lùi tới ngày nào, xong chưa
function renderBfProgress(list) {
  const ul = $('bfProgress');
  ul.innerHTML = '';
  for (const p of list) {
    const li = document.createElement('li');
    const cate = document.createElement('span');
    cate.className = 'cate';
    cate.textContent = p.cate.replace(/^https?:\/\/[^/]+/, '') || '/';
    const state = document.createElement('span');
    state.className = 'state' + (p.done ? ' done' : '');
    state.textContent = p.done
      ? `Xong · ${p.pages} trang`
      : p.pages
        ? `${p.pages} trang${p.label ? ` · tới ${p.label}` : ''}`
        : 'Chưa bắt đầu';
    li.append(cate, state);
    ul.appendChild(li);
  }
}

function showTest(r) {
  $('testBox').hidden = false;
  $('testSummary').textContent =
    `Nguồn: ${r.source}\nTìm thấy ${r.total} link bài (trang cate + tối đa 1 trang kế tiếp), ` +
    `${r.alreadySeen} link đã có trong cache.`;
  $('testSummary').style.whiteSpace = 'pre-wrap';
  const ol = $('testLinks');
  ol.innerHTML = '';
  for (const u of r.links) {
    const li = document.createElement('li');
    li.textContent = u;
    ol.appendChild(li);
  }
  $('testSample').textContent = r.sample ? JSON.stringify(r.sample, null, 2) : 'Không có bài nào để lấy mẫu — kiểm tra lại regex hoặc link cate.';
}

// fn được gọi ngay (đồng bộ) để chrome.permissions.request vẫn nằm trong thao tác bấm
async function withBusy(btn, label, fn) {
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = label;
  try { await fn(); } finally { btn.innerHTML = old; btn.disabled = false; refresh(); }
}

// Mỗi tab có panel riêng: tab id nằm trên URL (sidepanel.html?tabId=123).
// Nếu mở bằng panel mặc định (không có tabId) thì làm việc với tab đang xem và đổi theo khi chuyển tab.
const pinnedTabId = Number(new URLSearchParams(location.search).get('tabId')) || null;

async function resolveTabId() {
  if (pinnedTabId) return pinnedTabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab.id;
}

// Đổi sang tab khác → nạp cấu hình của tab đó (thay đổi chưa lưu ở tab cũ sẽ bị bỏ)
async function switchTab(newId) {
  if (newId === tabId) return;
  tabId = newId;
  formFilled = false;
  showErrors([]);
  $('testBox').hidden = true;
  await updateTabInfo();
  await refresh();
}

async function updateTabInfo() {
  try {
    const tab = await chrome.tabs.get(tabId);
    $('tabInfo').textContent = `Tab #${tab.id} · ${tab.url || ''}`;
  } catch {
    $('tabInfo').textContent = `Tab #${tabId} đã đóng`;
  }
}

async function init() {
  fillSiteOptions();
  tabId = await resolveTabId();
  await updateTabInfo();
  chrome.tabs.onUpdated.addListener((id, info) => { if (id === tabId && info.url) updateTabInfo(); });
  if (!pinnedTabId) {
    const win = await chrome.windows.getCurrent();
    chrome.tabs.onActivated.addListener(({ tabId: id, windowId }) => {
      if (windowId === win.id) switchTab(id);
    });
  }

  ['cron', 'regex'].forEach(id => $(id).addEventListener('input', updateHints));
  $('site').addEventListener('change', () => applySite($('site').value));

  $('btnShowKey').addEventListener('click', () => {
    const input = $('apiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('btnShowKey').textContent = show ? 'Ẩn' : 'Hiện';
  });

  $('btnSave').addEventListener('click', () => withBusy($('btnSave'), 'Đang lưu…', async () => {
    showErrors([]);
    if (!(await requestGatewayPermission())) return;
    const r = await send({ type: 'SAVE', tabId, raw: readForm(), rawGlobal: readGlobal(), enable: true });
    showErrors(r?.ok ? [] : (r?.errors || [r?.error]));
  }));

  $('btnTestGw').addEventListener('click', () => withBusy($('btnTestGw'), 'Đang gửi thử…', async () => {
    showErrors([]);
    if (!(await requestGatewayPermission())) return;
    const r = await send({ type: 'TEST_GATEWAY', tabId, rawGlobal: readGlobal(), topic: $('topic').value });
    if (r?.ok) alert(`Gateway OK (HTTP ${r.status})${r.text ? `\n${r.text}` : ''}`);
    else showErrors(r?.errors || [`Gateway lỗi: ${r?.error || 'không rõ'}`]);
  }));

  $('btnFlush').addEventListener('click', () => withBusy($('btnFlush'), 'đang gửi…', async () => {
    const r = await send({ type: 'FLUSH_NOW', tabId });
    showErrors(r?.ok ? [] : [`Gửi hàng chờ thất bại: ${r?.error || 'không rõ'}`]);
  }));

  $('btnStop').addEventListener('click', () => withBusy($('btnStop'), 'Đang tắt…', async () => {
    await send({ type: 'STOP', tabId });
  }));

  $('btnRun').addEventListener('click', () => withBusy($('btnRun'), 'Đang khởi động…', async () => {
    const r = await send({ type: 'RUN_NOW', tabId });
    showErrors(r?.ok ? [] : [r?.error || 'Không chạy được']);
  }));

  $('btnTest').addEventListener('click', () => withBusy($('btnTest'), 'Đang test…', async () => {
    showErrors([]);
    const r = await send({ type: 'TEST', tabId, raw: readForm() });
    if (r?.ok) showTest(r.result);
    else showErrors(r?.errors || [r?.error || 'Test thất bại']);
  }));

  $('btnBfStart').addEventListener('click', () => withBusy($('btnBfStart'), 'Đang khởi động…', async () => {
    showErrors([]);
    if (!(await requestGatewayPermission())) return;
    const r = await send({ type: 'BF_START', tabId, raw: readForm(), rawGlobal: readGlobal() });
    showErrors(r?.ok ? [] : (r?.errors || [r?.error || 'Không chạy được']));
  }));

  $('btnBfStop').addEventListener('click', () => withBusy($('btnBfStop'), 'Đang dừng…', async () => {
    await send({ type: 'BF_STOP', tabId });
  }));

  $('btnBfReset').addEventListener('click', async () => {
    if (!confirm('Xoá vị trí đã lưu? Lần sau Lấy toàn bộ sẽ quét lại từ trang 1 (bài đã gửi vẫn được bỏ qua nhờ cache).')) return;
    const r = await send({ type: 'BF_RESET', tabId });
    showErrors(r?.ok ? [] : [r?.error || 'Không xoá được']);
    refresh();
  });

  $('btnClear').addEventListener('click', async () => {
    if (!confirm('Xoá cache? Lần chạy sau sẽ crawl và gửi lại cả những bài đã gửi.')) return;
    await send({ type: 'CLEAR_CACHE', tabId });
    refresh();
  });

  await refresh();
  setInterval(refresh, 1500);
}

init();