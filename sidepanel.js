import { nextRuns } from './lib/cron.js';
import { DEFAULTS } from './lib/config.js';

const $ = id => document.getElementById(id);
const send = msg => chrome.runtime.sendMessage(msg);
const fmt = ts => (ts ? new Date(ts).toLocaleString('vi-VN', { hour12: false }) : '—');

let tabId = null;
let formFilled = false;

function readForm() {
  return {
    home: $('home').value,
    cates: $('cates').value,
    cron: $('cron').value,
    regex: $('regex').value,
    delayMin: $('delayMin').value,
    delayMax: $('delayMax').value,
    maxPages: $('maxPages').value,
    htmlMode: $('htmlMode').value,
    cacheDays: $('cacheDays').value,
  };
}

function fillForm(cfg) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  $('home').value = c.home;
  $('cates').value = (c.cates || []).join('\n');
  $('cron').value = c.cron;
  $('regex').value = c.regex;
  $('delayMin').value = c.delayMin;
  $('delayMax').value = c.delayMax;
  $('maxPages').value = c.maxPages;
  $('htmlMode').value = c.htmlMode;
  $('cacheDays').value = c.cacheDays;
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
  if (!formFilled) { fillForm(s.cfg); formFilled = true; }

  const st = s.status || {};
  const badge = $('badge');
  if (st.running) { badge.textContent = `Đang chạy · ${st.runSaved || 0} bài`; badge.className = 'badge running'; }
  else if (st.enabled) { badge.textContent = 'Đang bật'; badge.className = 'badge on'; }
  else { badge.textContent = 'Tắt'; badge.className = 'badge off'; }

  $('nextRun').textContent = st.enabled ? fmt(st.nextRunAt) : '— (lịch đang tắt)';
  $('lastRun').textContent = st.lastRunAt ? `${fmt(st.lastRunAt)} · ${st.lastRunSummary || ''}` : '—';
  $('totalSaved').textContent = st.totalSaved || 0;
  $('seenCount').textContent = s.seenCount;
  $('cacheKeep').textContent = s.cfg ? ` (giữ ${s.cfg.cacheDays ?? DEFAULTS.cacheDays} ngày)` : '';

  const err = $('lastError');
  err.hidden = !st.lastError;
  err.textContent = st.lastError ? `Lỗi gần nhất: ${st.lastError}` : '';

  $('btnRun').disabled = !!st.running || !s.cfg;
  $('btnStop').disabled = !st.enabled && !st.running;

  const logs = $('logs');
  const atBottom = logs.scrollTop + logs.clientHeight >= logs.scrollHeight - 4;
  logs.textContent = (s.logs || []).slice(-60).join('\n') || 'Chưa có hoạt động';
  if (atBottom) logs.scrollTop = logs.scrollHeight;
}

function showTest(r) {
  $('testBox').hidden = false;
  $('testSummary').textContent =
    `Nguồn: ${r.source}\nTìm thấy ${r.total} link bài (trang cate + tối đa 1 lượt Load more), ` +
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

async function withBusy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { await fn(); } finally { btn.textContent = old; btn.disabled = false; refresh(); }
}

// Side panel dùng chung cho cả cửa sổ: luôn làm việc với tab đang được xem.
// (Có thể ép một tab cố định bằng sidepanel.html?tabId=123)
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

  $('btnSave').addEventListener('click', () => withBusy($('btnSave'), 'Đang lưu…', async () => {
    const r = await send({ type: 'SAVE', tabId, raw: readForm(), enable: true });
    showErrors(r?.ok ? [] : (r?.errors || [r?.error]));
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

  $('btnClear').addEventListener('click', async () => {
    if (!confirm('Xoá cache? Lần chạy sau sẽ crawl lại cả những bài đã lấy.')) return;
    await send({ type: 'CLEAR_CACHE', tabId });
    refresh();
  });

  await refresh();
  setInterval(refresh, 1500);
}

init();