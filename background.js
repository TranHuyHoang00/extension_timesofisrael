import { parseCron, nextRun } from './lib/cron.js';
import { normalizeConfig } from './lib/config.js';

// ---------- Khoá lưu trữ (mọi thứ gắn theo tab id, cache gắn theo host) ----------
const K = {
  cfg: id => `cfg:${id}`,
  st: id => `st:${id}`,
  log: id => `log:${id}`,
  seen: host => `seen:${host}`,
};
const ALARM_PREFIX = 'crawl:';
const SEEN_MAX = 5000;              // giữ tối đa 5000 link gần nhất mỗi site
const STALE_MS = 30 * 60 * 1000;    // cờ "đang chạy" quá 30 phút coi như treo

const get = async (key, def) => (await chrome.storage.local.get(key))[key] ?? def;
const set = (key, val) => chrome.storage.local.set({ [key]: val });

// Ghi storage tuần tự để các lần ghi log/status/cache không đè nhau
let chain = Promise.resolve();
const serial = fn => {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
};

const patchStatus = (tabId, patch) => serial(async () => {
  const st = { ...(await get(K.st(tabId), {})), ...patch };
  await set(K.st(tabId), st);
  return st;
});

const timeStr = () => new Date().toLocaleTimeString('vi-VN', { hour12: false });
const log = (tabId, text) => serial(async () => {
  const arr = await get(K.log(tabId), []);
  arr.push(`${timeStr()}  ${text}`);
  await set(K.log(tabId), arr.slice(-150));
});

const markSeen = (host, url) => serial(async () => {
  const arr = await get(K.seen(host), []);
  if (!arr.includes(url)) arr.push(url);
  await set(K.seen(host), arr.slice(-SEEN_MAX));
});

// ---------- Lịch chạy ----------
async function schedule(tabId) {
  await chrome.alarms.clear(ALARM_PREFIX + tabId);
  const cfg = await get(K.cfg(tabId));
  const st = await get(K.st(tabId), {});
  if (!cfg || !st.enabled) {
    await patchStatus(tabId, { nextRunAt: null });
    return;
  }
  const next = nextRun(parseCron(cfg.cron));
  if (!next) return;
  await chrome.alarms.create(ALARM_PREFIX + tabId, { when: next.getTime() });
  await patchStatus(tabId, { nextRunAt: next.getTime() });
}

chrome.alarms.onAlarm.addListener(async alarm => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  const tabId = Number(alarm.name.slice(ALARM_PREFIX.length));
  if (!(await tabExists(tabId))) return cleanup(tabId);
  await schedule(tabId);          // đặt lịch lượt sau trước, rồi mới chạy lượt này
  await startRun(tabId, 'lịch cron');
});

// ---------- Tab ----------
async function tabExists(tabId) {
  try { await chrome.tabs.get(tabId); return true; } catch { return false; }
}

async function cleanup(tabId) {
  await chrome.alarms.clear(ALARM_PREFIX + tabId);
  await chrome.storage.local.remove([K.cfg(tabId), K.st(tabId), K.log(tabId)]);
}

function waitComplete(tabId, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { done(); reject(new Error('Tab tải trang quá lâu')); }, timeoutMs);
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') { done(); resolve(); } };
    const done = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(t => { if (t.status === 'complete') { done(); resolve(); } }).catch(() => {});
  });
}

// Tab phải đang ở đúng site (cùng origin với link home) để fetch mang cookie của site
async function ensureOnSite(tabId, home) {
  const tab = await chrome.tabs.get(tabId);
  const want = new URL(home).origin;
  let have = null;
  try { have = new URL(tab.url).origin; } catch {}
  if (have !== want) {
    await log(tabId, `Tab không ở ${want}, chuyển về link home`);
    await chrome.tabs.update(tabId, { url: home });
    await new Promise(r => setTimeout(r, 300));
  }
  await waitComplete(tabId);
}

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['lib/toi.js', 'content.js'] });
}

chrome.tabs.onRemoved.addListener(tabId => { cleanup(tabId); });

// Tab tải lại / chuyển trang giữa lượt chạy → content script mất, đánh dấu lượt đó dừng
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'loading') return;
  const st = await get(K.st(tabId));
  if (st?.running) {
    await patchStatus(tabId, { running: false, lastError: 'Tab tải lại hoặc chuyển trang giữa lượt chạy' });
    await log(tabId, 'Lượt chạy bị ngắt vì tab tải lại / chuyển trang');
  }
});

// Mở lại trình duyệt thì tab id cũ không còn: dọn cấu hình mồ côi
async function sweepOrphans() {
  const all = await chrome.storage.local.get(null);
  for (const key of Object.keys(all)) {
    const m = key.match(/^cfg:(\d+)$/);
    if (m && !(await tabExists(Number(m[1])))) await cleanup(Number(m[1]));
  }
}
chrome.runtime.onStartup.addListener(sweepOrphans);
chrome.runtime.onInstalled.addListener(sweepOrphans);

// ---------- Side panel: mỗi tab một bảng cài đặt riêng ----------
// Tắt panel mặc định, chỉ bật cho tab nào được bấm icon → panel không hiện lẫn sang tab khác
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});
});

chrome.action.onClicked.addListener(tab => {
  // Không await giữa hai lệnh: sidePanel.open phải chạy ngay trong thao tác bấm của người dùng
  chrome.sidePanel.setOptions({ tabId: tab.id, path: `sidepanel.html?tabId=${tab.id}`, enabled: true });
  chrome.sidePanel.open({ tabId: tab.id }).catch(e => console.warn('Không mở được side panel:', e));
});

// ---------- Chạy ----------
async function startRun(tabId, reason) {
  const cfg = await get(K.cfg(tabId));
  if (!cfg) throw new Error('Tab này chưa lưu cấu hình');
  const st = await get(K.st(tabId), {});
  if (st.running && Date.now() - (st.runningSince || 0) < STALE_MS) {
    await log(tabId, `Bỏ qua (${reason}): lượt trước chưa xong`);
    return { ok: false, error: 'Lượt trước chưa xong' };
  }
  try {
    await ensureOnSite(tabId, cfg.home);
    await inject(tabId);
    const runId = `${tabId}-${Date.now()}`;
    await patchStatus(tabId, { running: true, runningSince: Date.now(), runId, runSaved: 0, lastError: null });
    await log(tabId, `Bắt đầu chạy (${reason})`);
    await chrome.tabs.sendMessage(tabId, { type: 'TOI_RUN', runId, config: cfg });
    return { ok: true };
  } catch (e) {
    await patchStatus(tabId, { running: false, lastError: e.message });
    await log(tabId, `Không chạy được: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ---------- Nơi nhận dữ liệu: hiện lưu file, sau này đổi sang Kafka ----------
async function sinkRecord(record) {
  return saveToFile(record);
  // Khi chuyển sang Kafka: thay bằng POST tới Kafka REST proxy / API trung gian, ví dụ
  // await fetch(KAFKA_PROXY_URL, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(record) });
}

let creatingOffscreen = null;
async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctx.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Tạo blob URL để lưu file JSON bài viết',
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

const pad = n => String(n).padStart(2, '0');
function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function saveToFile(record) {
  await ensureOffscreen();
  const json = JSON.stringify(record, null, 2);
  const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'BLOB_URL', text: json });
  if (!r?.url) throw new Error('Không tạo được blob URL');
  const slug = new URL(record.url).pathname.replace(/^\/|\/$/g, '').replace(/[^a-z0-9-]/gi, '_').slice(0, 80);
  const filename = `toi_crawl/${localDate()}/${record.post_id || 'no-id'}_${slug}.json`;
  await chrome.downloads.download({ url: r.url, filename, conflictAction: 'overwrite', saveAs: false });
  return filename;
}

// ---------- Tin nhắn ----------
async function handle(msg, sender) {
  const tabIdFromSender = sender.tab?.id;

  switch (msg.type) {
    // --- từ content script ---
    case 'TOI_LOG':
      await log(tabIdFromSender, msg.text);
      return { ok: true };

    case 'TOI_RECORD': {
      const tabId = tabIdFromSender;
      const st = await get(K.st(tabId), {});
      if (st.runId !== msg.runId) return { ok: false, error: 'Lượt chạy đã hết hiệu lực' };
      const file = await sinkRecord(msg.record);
      await markSeen(new URL(msg.record.url).host, msg.record.url);
      await patchStatus(tabId, {
        runSaved: (st.runSaved || 0) + 1,
        totalSaved: (st.totalSaved || 0) + 1,
      });
      await log(tabId, `Đã lưu ${file}`);
      return { ok: true, file };
    }

    case 'TOI_DONE': {
      const tabId = tabIdFromSender;
      const s = msg.stats || {};
      await patchStatus(tabId, {
        running: false,
        lastRunAt: Date.now(),
        lastRunSummary: `${s.found ?? 0} link mới, lưu ${s.saved ?? 0}, lỗi ${s.errors ?? 0}`,
        lastError: msg.error || null,
      });
      await log(tabId, `Kết thúc: ${s.found ?? 0} link mới, lưu ${s.saved ?? 0}, lỗi ${s.errors ?? 0}${msg.error ? ` — ${msg.error}` : ''}`);
      return { ok: true };
    }

    // --- từ side panel ---
    case 'GET_STATE': {
      const { tabId } = msg;
      const cfg = await get(K.cfg(tabId));
      const status = await get(K.st(tabId), {});
      const logs = await get(K.log(tabId), []);
      const host = cfg ? new URL(cfg.home).host : 'www.timesofisrael.com';
      const seenCount = (await get(K.seen(host), [])).length;
      return { ok: true, cfg, status, logs, seenCount };
    }

    case 'SAVE': {
      const { tabId, raw, enable } = msg;
      const { cfg, errors } = normalizeConfig(raw);
      if (errors.length) return { ok: false, errors };
      await set(K.cfg(tabId), cfg);
      await patchStatus(tabId, { enabled: !!enable });
      await schedule(tabId);
      await log(tabId, enable ? `Đã lưu và bật lịch "${cfg.cron}"` : 'Đã lưu cấu hình (lịch đang tắt)');
      if (enable) ensureOnSite(tabId, cfg.home).catch(() => {});
      return { ok: true };
    }

    case 'STOP': {
      const { tabId } = msg;
      await patchStatus(tabId, { enabled: false });
      await schedule(tabId);
      await chrome.tabs.sendMessage(tabId, { type: 'TOI_ABORT' }).catch(() => {});
      await log(tabId, 'Đã tắt lịch');
      return { ok: true };
    }

    case 'RUN_NOW':
      return startRun(msg.tabId, 'chạy ngay');

    case 'TEST': {
      const { tabId, raw } = msg;
      const { cfg, errors } = normalizeConfig(raw);
      if (errors.length) return { ok: false, errors };
      await ensureOnSite(tabId, cfg.home);
      await inject(tabId);
      await log(tabId, 'Chạy test (không lưu file, không ghi cache)');
      return chrome.tabs.sendMessage(tabId, { type: 'TOI_TEST', config: cfg });
    }

    case 'CLEAR_CACHE': {
      const cfg = await get(K.cfg(msg.tabId));
      const host = cfg ? new URL(cfg.home).host : 'www.timesofisrael.com';
      await serial(() => chrome.storage.local.remove(K.seen(host)));
      await log(msg.tabId, `Đã xoá cache của ${host}`);
      return { ok: true };
    }
  }
  return undefined;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false;
  handle(msg, sender).then(
    r => sendResponse(r),
    e => sendResponse({ ok: false, error: e?.message || String(e) }),
  );
  return true;
});
