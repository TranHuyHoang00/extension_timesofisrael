import { parseCron, nextRun } from "./lib/cron.js";
import {
  normalizeConfig,
  normalizeGlobal,
  gatewayOriginPattern,
  DEFAULTS,
  GLOBAL_DEFAULTS,
} from "./lib/config.js";
import * as store from "./lib/cache.js";

// ---------- Hằng số ----------
// chrome.storage.local: cấu hình/trạng thái/log gắn theo tab id, cấu hình gateway dùng chung.
// IndexedDB (lib/cache.js): cache đã gửi, hàng chờ gửi, giữ chỗ.
const K = {
  cfg: (id) => `cfg:${id}`,
  st: (id) => `st:${id}`,
  log: (id) => `log:${id}`,
  global: "global",
};
const ALARM_PREFIX = "crawl:";
const DAY_MS = 24 * 3600 * 1000;
const IDLE_MS = 10 * 60 * 1000; // lượt chạy 10 phút liền không có hoạt động gì → coi như treo
const CLAIM_TTL_MS = 10 * 60 * 1000; // giữ chỗ một bài tối đa 10 phút
const MAX_BATCH_BYTES = 4 * 1024 * 1024; // dữ liệu một batch ~4 MB (body request ~5 MB sau khi mã hoá chuỗi)
const OUTBOX_MAX = 300; // hàng chờ tối đa 300 bài, đầy thì dừng crawl
const OUTBOX_TTL_MS = 7 * DAY_MS; // bài chờ gửi quá 7 ngày thì bỏ
const RETRY_DELAYS = [2000, 5000]; // thử lại 2 lần sau lần đầu → tổng 3 lần
const MAX_RELOADS = 10; // tự F5 tối đa 10 lần liên tiếp mà không tiến thêm được bài nào
const WATCH_MS = 3 * 60 * 1000; // watchdog: tab đang chạy mà 3 phút không có tín hiệu → F5
const RESUME_DELAY_MS = 5000; // trang tải lại xong, chờ 5 giây rồi mới chạy tiếp

// chrome.storage.session (chỉ trong RAM, tắt Chrome là mất):
//   bf:<tabId>   = tab đang ở chế độ "Lấy toàn bộ"
//   rs:<tabId>   = { mode, reloads, pending } — đang chờ tự chạy tiếp sau khi F5
//   beat:<tabId> = lần cuối tab báo "còn sống"
// chrome.storage.local "bfpos" = { [linkCate]: { params, pages, done } } — dấu trang của chế độ Lấy toàn bộ,
//   lưu theo link cate nên đóng tab / tắt Chrome vẫn còn.
const S = {
  bf: (id) => `bf:${id}`,
  rs: (id) => `rs:${id}`,
  beat: (id) => `beat:${id}`,
};
const BF_POS_KEY = "bfpos";
const sget = async (key) => (await chrome.storage.session.get(key))[key];
const sset = (key, val) => chrome.storage.session.set({ [key]: val });
const sdel = (keys) => chrome.storage.session.remove(keys);

const hostOf = (cfg) => new URL(cfg?.home || DEFAULTS.home).host;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const get = async (key, def) =>
  (await chrome.storage.local.get(key))[key] ?? def;
const set = (key, val) => chrome.storage.local.set({ [key]: val });

// Ghi storage tuần tự để các lần ghi log/status không đè nhau
let chain = Promise.resolve();
const serial = (fn) => {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
};

const patchStatus = (tabId, patch) =>
  serial(async () => {
    const st = {
      ...(await get(K.st(tabId), {})),
      ...(typeof patch === "function"
        ? patch(await get(K.st(tabId), {}))
        : patch),
    };
    await set(K.st(tabId), st);
    return st;
  });

const timeStr = () => new Date().toLocaleTimeString("vi-VN", { hour12: false });
const log = (tabId, text) =>
  tabId == null
    ? Promise.resolve()
    : serial(async () => {
        const arr = await get(K.log(tabId), []);
        arr.push(`${timeStr()}  ${text}`);
        await set(K.log(tabId), arr.slice(-150));
      });

// Bản cũ lưu cache dạng mảng trong chrome.storage.local (khoá seen:<host>) → chuyển sang IndexedDB một lần
async function migrateOldCache() {
  const all = await chrome.storage.local.get(null);
  for (const [key, urls] of Object.entries(all)) {
    const m = key.match(/^seen:(.+)$/);
    if (!m || !Array.isArray(urls)) continue;
    const now = Date.now();
    await store.addMany(
      urls.map((url) => ({ url, host: m[1], post_id: null, savedAt: now })),
    );
    await chrome.storage.local.remove(key);
  }
}

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

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  const tabId = Number(alarm.name.slice(ALARM_PREFIX.length));
  if (!(await tabExists(tabId))) return cleanup(tabId);
  await schedule(tabId); // đặt lịch lượt sau trước, rồi mới chạy lượt này
  await startRun(tabId, "lịch cron");
});

// ---------- Watchdog: tab đang chạy mà im lặng quá lâu → tự F5 rồi tự chạy tiếp ----------
// Dùng khi mất mạng / proxy chết (F5 ra trang lỗi, không có script nào chạy được)
// hoặc kẹt ở trang kiểm tra Cloudflare quá lâu.
chrome.alarms.create("watchdog", { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "watchdog") return;
  const ses = await chrome.storage.session.get(null);
  const loc = await chrome.storage.local.get(null);
  const ids = new Set();
  for (const k of Object.keys(ses)) {
    const m = k.match(/^(bf|rs):(\d+)$/);
    if (m) ids.add(Number(m[2]));
  }
  for (const [k, v] of Object.entries(loc)) {
    const m = k.match(/^st:(\d+)$/);
    if (m && v?.running) ids.add(Number(m[1]));
  }
  const now = Date.now();
  for (const tabId of ids) {
    const bf = ses[S.bf(tabId)];
    const rs = ses[S.rs(tabId)];
    const st = loc[K.st(tabId)] || {};
    if (!bf && !rs?.pending && !st.running) continue;
    if (starting.has(tabId)) continue;
    const last = Math.max(
      ses[S.beat(tabId)] || 0,
      rs?.at || 0,
      st.lastActivity || 0,
      bf?.startedAt || 0,
    );
    if (now - last < WATCH_MS) continue;
    if (!(await tabExists(tabId))) {
      await cleanup(tabId);
      continue;
    }
    const quiet = now - last;
    await log(
      tabId,
      `Tab ${quiet >= 60000 ? `${Math.round(quiet / 60000)} phút` : `${Math.round(quiet / 1000)} giây`} không có tín hiệu → tự tải lại trang`,
    );
    await patchStatus(tabId, { running: false });
    await handleBlocked(tabId, bf ? "backfill" : rs?.mode || "schedule");
  }
});

// Bị chặn (hoặc tab im lặng quá lâu): F5 trang rồi tự chạy tiếp; quá MAX_RELOADS lần liên tiếp thì dừng hẳn
async function handleBlocked(tabId, mode) {
  const rs = (await sget(S.rs(tabId))) || { reloads: 0 };
  const reloads = (rs.reloads || 0) + 1;
  if (reloads > MAX_RELOADS) {
    await sdel([S.rs(tabId), S.bf(tabId)]);
    const msg = `Đã tự tải lại ${MAX_RELOADS} lần liên tiếp mà vẫn bị chặn → dừng hẳn`;
    await patchStatus(tabId, { running: false, lastError: msg });
    await log(tabId, `${msg}. ${mode === "backfill" ? 'Bấm "Bắt đầu / Tiếp tục" để thử lại (vị trí đã lưu)' : "Lượt lịch sau sẽ thử lại"}`);
    return;
  }
  await sset(S.rs(tabId), { mode, reloads, pending: true, at: Date.now() });
  await sset(S.beat(tabId), Date.now());
  await log(tabId, `Tự tải lại trang để vượt chặn (${reloads}/${MAX_RELOADS}), xong sẽ tự chạy tiếp`);
  try {
    await chrome.tabs.reload(tabId);
  } catch {}
}

// Có tiến triển (lưu được bài / dấu trang) → reset bộ đếm số lần tự F5
async function resetReloads(tabId) {
  const rs = await sget(S.rs(tabId));
  if (rs?.reloads) await sset(S.rs(tabId), { ...rs, reloads: 0 });
}

// ---------- Tab ----------
async function tabExists(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

async function cleanup(tabId) {
  await chrome.alarms.clear(ALARM_PREFIX + tabId);
  await chrome.storage.local.remove([K.cfg(tabId), K.st(tabId), K.log(tabId)]);
  await sdel([S.bf(tabId), S.rs(tabId), S.beat(tabId)]).catch(() => {});
}

function waitComplete(tabId, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      done();
      reject(new Error("Tab tải trang quá lâu"));
    }, timeoutMs);
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        done();
        resolve();
      }
    };
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t.status === "complete") {
          done();
          resolve();
        }
      })
      .catch(() => {});
  });
}

// Tab phải đang ở đúng site (cùng origin với link home) để fetch mang cookie của site
async function ensureOnSite(tabId, home) {
  const tab = await chrome.tabs.get(tabId);
  const want = new URL(home).origin;
  let have = null;
  try {
    have = new URL(tab.url).origin;
  } catch {}
  if (have !== want) {
    await log(tabId, `Tab không ở ${want}, chuyển về link home`);
    await chrome.tabs.update(tabId, { url: home });
    await sleep(300);
  }
  await waitComplete(tabId);
}

async function inject(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["lib/toi.js", "content.js"],
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  cleanup(tabId);
});

// Tab tải lại / chuyển trang giữa lượt chạy → content script mất, đánh dấu lượt đó dừng
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status === "complete") {
    scheduleResume(tabId);
    return;
  }
  if (info.status !== "loading") return;
  const st = await get(K.st(tabId));
  if (st?.running) {
    const willResume = (await sget(S.bf(tabId))) || (await sget(S.rs(tabId)))?.pending;
    await patchStatus(tabId, {
      running: false,
      lastError: willResume ? null : "Tab tải lại hoặc chuyển trang giữa lượt chạy",
    });
    await log(
      tabId,
      willResume
        ? "Trang đang tải lại, xong sẽ tự chạy tiếp"
        : "Lượt chạy bị ngắt vì tab tải lại / chuyển trang (bài đã crawl vẫn nằm trong hàng chờ gửi)",
    );
  }
});

// ---------- Tự chạy tiếp sau khi trang tải lại ----------
// Content script được tiêm khi chạy, F5 là mất → background theo dõi trang tải xong rồi tiêm lại và chạy tiếp.
const resumeTimers = new Map();
function scheduleResume(tabId) {
  clearTimeout(resumeTimers.get(tabId));
  resumeTimers.set(
    tabId,
    setTimeout(() => {
      resumeTimers.delete(tabId);
      maybeResume(tabId).catch(() => {});
    }, RESUME_DELAY_MS),
  );
}

async function maybeResume(tabId) {
  const bf = await sget(S.bf(tabId));
  const rs = await sget(S.rs(tabId));
  if (!bf && !rs?.pending) return; // tab này không có gì cần chạy tiếp
  if (starting.has(tabId)) return; // đang khởi động (chính lần tải trang này do ensureOnSite gây ra)
  const st = await get(K.st(tabId), {});
  if (st.running) return;
  if (!(await get(K.cfg(tabId)))) return;

  // Còn ở trang kiểm tra Cloudflare thì chờ: giải xong trang tự tải lại, lúc đó kiểm tra lại.
  let challenge;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        /just a moment|attention required|checking your browser/i.test(document.title || "") ||
        !!document.querySelector(
          "#challenge-form, #challenge-running, #cf-challenge-running, .cf-browser-verification",
        ),
    });
    challenge = result;
  } catch {
    return; // trang lỗi (mất mạng / proxy) → watchdog sẽ tự tải lại sau 3 phút
  }
  if (challenge) {
    await log(tabId, "Đang ở trang kiểm tra Cloudflare, chờ giải xong...");
    return;
  }
  if (rs) await sset(S.rs(tabId), { ...rs, pending: false, at: Date.now() });
  if (bf) await startBackfill(tabId, "tự chạy tiếp sau khi tải lại");
  else await startRun(tabId, "tự chạy tiếp sau khi tải lại");
}

// Mở lại trình duyệt thì tab id cũ không còn: dọn cấu hình mồ côi
async function sweepOrphans() {
  const all = await chrome.storage.local.get(null);
  for (const key of Object.keys(all)) {
    const m = key.match(/^cfg:(\d+)$/);
    if (m && !(await tabExists(Number(m[1])))) await cleanup(Number(m[1]));
  }
}

// ---------- Side panel: chỉ hiện ở tab đã bấm icon ----------
const panelPath = (tabId) => `sidepanel.html?tabId=${tabId}`;

// Tắt panel mặc định → tab chưa bấm icon thì không có panel.
// Bấm icon phải gọi action.onClicked, nên tắt chế độ "bấm icon tự mở panel".
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: false })
  .catch(() => {});
chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});

// Bấm icon → bật panel riêng cho tab này rồi mở.
// Không await giữa hai lệnh: sidePanel.open phải chạy ngay trong thao tác bấm.
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: panelPath(tab.id),
    enabled: true,
  });
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  sweepOrphans();
});
chrome.runtime.onInstalled.addListener(() => {
  sweepOrphans();
  migrateOldCache();
});

// ---------- Gateway Kafka ----------
async function getGlobal() {
  return { ...GLOBAL_DEFAULTS, ...(await get(K.global, {})) };
}

async function checkGateway(g = null) {
  g = g || (await getGlobal());
  const { errors } = normalizeGlobal(g);
  if (errors.length)
    throw new Error(`Cấu hình gateway chưa đủ: ${errors.join("; ")}`);
  const pattern = gatewayOriginPattern(g.gatewayUrl);
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    throw new Error(
      `Chưa cấp quyền truy cập ${pattern} — bấm "Lưu & bật lịch" để Chrome hỏi cấp quyền`,
    );
  }
  return g;
}

// Gửi một batch. message là mảng bài đã JSON.stringify (đúng định dạng gateway yêu cầu).
// Thử tối đa 3 lần với lỗi mạng / 5xx / 408 / 429. Lỗi 4xx khác (sai key, sai topic…) không thử lại.
async function sendBatch(topic, records, g = null) {
  g = await checkGateway(g);
  const url = new URL(g.gatewayUrl);
  url.searchParams.set("apikey", g.apiKey);
  const body = JSON.stringify({ topic, message: JSON.stringify(records) });

  let lastError = "";
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS[attempt - 1]);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const text = (await res.text()).slice(0, 300);
      if (res.ok)
        return { ok: true, status: res.status, text, bytes: body.length };
      lastError = `HTTP ${res.status}${text ? `: ${text}` : ""}`;
      const retryable =
        res.status >= 500 || res.status === 408 || res.status === 429;
      if (!retryable) break;
    } catch (e) {
      lastError = `Lỗi mạng: ${e.message}`;
    }
  }
  return { ok: false, error: lastError };
}

// Chỉ một lần gửi tại một thời điểm, để không gửi trùng cùng một bài
let flushChain = Promise.resolve();
const withFlushLock = (fn) => {
  const p = flushChain.then(fn, fn);
  flushChain = p.catch(() => {});
  return p;
};

// Gửi hàng chờ của một topic.
//   all = false: chỉ gửi khi đủ batch (theo số bài hoặc dung lượng)
//   all = true : gửi hết, kể cả batch cuối chưa đủ
// Trả về { sent, ok, error }
function flushTopic(
  topic,
  { all = false, tabId = null, batchSize = null } = {},
) {
  return withFlushLock(async () => {
    let sent = 0;
    while (true) {
      const first = await store.peekBatch(topic, 1, Infinity);
      if (!first.items.length) return { sent, ok: true };
      const size = batchSize || first.items[0].batchSize || DEFAULTS.batchSize;
      const batch = await store.peekBatch(topic, size, MAX_BATCH_BYTES);
      if (!batch.full && !all) return { sent, ok: true };

      const records = batch.items.map((it) => it.record);
      const r = await sendBatch(topic, records);
      if (!r.ok) {
        await store.markFailed(batch.items, r.error);
        await log(
          tabId,
          `Gửi batch ${batch.items.length} bài lên topic "${topic}" thất bại: ${r.error}`,
        );
        return { sent, ok: false, error: r.error };
      }
      await store.commitSent(batch.items);
      sent += batch.items.length;
      await log(
        tabId,
        `Đã gửi ${batch.items.length} bài (${(r.bytes / 1024).toFixed(0)} KB) lên topic "${topic}"`,
      );
      // Cộng số đã gửi cho đúng tab đã crawl bài đó (hai tab cùng topic dùng chung hàng chờ)
      const perTab = new Map();
      for (const it of batch.items)
        if (it.tabId != null)
          perTab.set(it.tabId, (perTab.get(it.tabId) || 0) + 1);
      for (const [id, n] of perTab) {
        if (!(await tabExists(id))) continue;
        await patchStatus(id, (st) => ({
          runSent: (st.runSent || 0) + n,
          totalSent: (st.totalSent || 0) + n,
        }));
      }
    }
  });
}

// batchSize: dùng batch size hiện tại của tab (không dùng batch size cũ ghi kèm bài trong hàng chờ)
async function flushAll({ tabId = null, batchSize = null } = {}) {
  let sent = 0;
  for (const topic of await store.outboxTopics()) {
    const r = await flushTopic(topic, { all: true, tabId, batchSize });
    sent += r.sent;
    if (!r.ok) return { sent, ok: false, error: r.error };
  }
  return { sent, ok: true };
}

// ---------- Chạy ----------
async function housekeeping(tabId, cfg) {
  const days = cfg.cacheDays || DEFAULTS.cacheDays;
  const purged = await store.purgeOlderThan(
    hostOf(cfg),
    Date.now() - days * DAY_MS,
  );
  if (purged)
    await log(tabId, `Dọn ${purged} link quá ${days} ngày khỏi cache`);
  await store.purgeClaims();
  const dropped = await store.purgeOutbox(Date.now() - OUTBOX_TTL_MS);
  if (dropped) await log(tabId, `Bỏ ${dropped} bài chờ gửi quá 7 ngày`);
}

// Ghi nhận "lượt chạy vẫn đang làm việc" (mỗi lần quét trang, giữ chỗ bài, gửi bài, nhịp tim lúc chờ).
// Ghi tối đa 15 giây một lần cho đỡ tốn.
const lastTouch = new Map();
async function touch(tabId) {
  if (tabId == null) return;
  const now = Date.now();
  if (now - (lastTouch.get(tabId) || 0) < 15000) return;
  lastTouch.set(tabId, now);
  await sset(S.beat(tabId), now);
  await patchStatus(tabId, (st) => (st.running ? { lastActivity: now } : {}));
}

// Tab đang trong quá trình khởi động một lượt (tránh hai lượt cùng khởi động một lúc)
const starting = new Set();

// Lượt trước còn chạy? Còn đang làm việc (dù đã chạy bao lâu) → true.
// Chỉ khi 10 phút liền không có hoạt động gì mới coi là treo → false (cho chạy lượt mới).
async function stillRunning(tabId, reason) {
  const st = await get(K.st(tabId), {});
  if (!st.running) return false;
  const idle = Date.now() - (st.lastActivity || st.runningSince || 0);
  if (idle < IDLE_MS) {
    await log(tabId, `Bỏ qua (${reason}): lượt trước chưa xong`);
    return true;
  }
  await log(
    tabId,
    `Lượt trước ${Math.round(idle / 60000)} phút không hoạt động, coi như treo → chạy lượt mới`,
  );
  return false;
}

// Phần chung để khởi động một lượt (lịch hoặc lấy toàn bộ):
// kiểm tra gateway → dọn dẹp → gửi nốt hàng chờ → đưa tab về site → tiêm script → ra lệnh chạy
async function launch(tabId, cfg, mode, reason, buildMessage) {
  starting.add(tabId);
  try {
    try {
      await checkGateway();
    } catch (e) {
      e.gateway = true;
      throw e;
    }
    await housekeeping(tabId, cfg);
    // Mỗi tab chỉ chạy một lượt: chỗ giữ bài của các lượt cũ trong tab này (chết vì F5 / treo) trả lại hết,
    // nếu không lượt mới sẽ tưởng "tab khác đang xử lý" mà bỏ qua → Lấy toàn bộ bị sót bài.
    const freed = await store.releaseByOwnerPrefix(`${tabId}-`);
    if (freed) await log(tabId, `Trả lại ${freed} bài đang giữ dở của lượt trước`);

    // Gửi nốt hàng chờ còn lại từ các lượt trước; gateway lỗi thì không crawl thêm
    const pending = await store.outboxCount();
    if (pending) {
      await log(
        tabId,
        `Còn ${pending} bài chờ gửi từ lượt trước, gửi trước khi crawl`,
      );
      const r = await flushAll({ tabId, batchSize: cfg.batchSize });
      if (!r.ok) {
        const e = new Error(`Gateway lỗi, chưa crawl: ${r.error}`);
        e.gateway = true;
        throw e;
      }
    }

    await ensureOnSite(tabId, cfg.home);
    await inject(tabId);
    const runId = `${tabId}-${Date.now()}`;
    await patchStatus(tabId, {
      running: true,
      mode,
      runningSince: Date.now(),
      lastActivity: Date.now(),
      runId,
      runSent: 0,
      lastError: null,
    });
    await sset(S.beat(tabId), Date.now());
    await log(tabId, `Bắt đầu chạy (${reason})`);
    await chrome.tabs.sendMessage(tabId, await buildMessage(runId));
    return { ok: true };
  } catch (e) {
    await patchStatus(tabId, { running: false, lastError: e.message });
    await log(tabId, `Không chạy được: ${e.message}`);
    // Lỗi gateway: tự chạy tiếp cũng vô ích → thôi tự chạy tiếp, chờ người xử lý
    if (e.gateway) {
      await sdel(S.rs(tabId));
      if (mode === "backfill") {
        await sdel(S.bf(tabId));
        await log(tabId, 'Đã dừng lấy toàn bộ vì lỗi gateway. Xử lý xong bấm "Bắt đầu / Tiếp tục" (vị trí đã lưu)');
      }
    }
    return { ok: false, error: e.message };
  } finally {
    starting.delete(tabId);
  }
}

// Chế độ LỊCH
async function startRun(tabId, reason) {
  const cfg = await get(K.cfg(tabId));
  if (!cfg) return { ok: false, error: "Tab này chưa lưu cấu hình" };
  if (starting.has(tabId)) return { ok: false, error: "Đang khởi động" };
  if (await sget(S.bf(tabId))) {
    await log(tabId, `Bỏ qua (${reason}): tab đang Lấy toàn bộ`);
    return { ok: false, error: "Tab đang Lấy toàn bộ" };
  }
  if (await stillRunning(tabId, reason))
    return { ok: false, error: "Lượt trước chưa xong" };
  return launch(tabId, cfg, "schedule", reason, (runId) => ({
    type: "TOI_RUN",
    runId,
    config: cfg,
  }));
}

// Chế độ LẤY TOÀN BỘ
async function startBackfill(tabId, reason) {
  const cfg = await get(K.cfg(tabId));
  if (!cfg) return { ok: false, error: "Tab này chưa lưu cấu hình" };
  if (starting.has(tabId)) return { ok: false, error: "Đang khởi động" };
  if (!(await sget(S.bf(tabId))))
    return { ok: false, error: "Tab này chưa bật Lấy toàn bộ" };
  if (await stillRunning(tabId, reason))
    return { ok: false, error: "Lượt trước chưa xong" };
  return launch(tabId, cfg, "backfill", reason, async (runId) => ({
    type: "TOI_BACKFILL",
    runId,
    config: cfg,
    positions: await get(BF_POS_KEY, {}),
  }));
}

// Tiến độ Lấy toàn bộ của các cate trong cấu hình, để hiện trên side panel
async function backfillProgress(cfg) {
  if (!cfg) return [];
  const all = await get(BF_POS_KEY, {});
  const sources = cfg.cates?.length ? cfg.cates : [cfg.home];
  return sources.map((cate) => {
    const p = all[cate] || {};
    return {
      cate,
      pages: p.pages || 0,
      done: !!p.done,
      beforeDate: p.params?.before_date ? Number(p.params.before_date) * 1000 : null,
    };
  });
}

// ---------- Tin nhắn ----------
async function handle(msg, sender) {
  const tabIdFromSender = sender.tab?.id;

  switch (msg.type) {
    // --- từ content script ---
    case "TOI_LOG":
      await log(tabIdFromSender, msg.text);
      await touch(tabIdFromSender);
      return { ok: true };

    // Nhịp tim lúc content script đang chờ (delay dài, chờ thử lại khi bị chặn)
    case "TOI_BEAT":
      await touch(tabIdFromSender);
      return { ok: true };

    // Lấy toàn bộ: xong trọn một trang → lưu dấu trang của cate đó
    case "BF_POS": {
      const tabId = tabIdFromSender;
      const st = await get(K.st(tabId), {});
      if (st.runId !== msg.runId)
        return { ok: false, error: "Lượt chạy này đã được thay bằng lượt mới" };
      await serial(async () => {
        const all = await get(BF_POS_KEY, {});
        all[msg.cate] = { ...msg.pos, updatedAt: Date.now() };
        await set(BF_POS_KEY, all);
      });
      await touch(tabId);
      await resetReloads(tabId);
      return { ok: true };
    }

    // Link nào không cần crawl (đã gửi / đang chờ gửi / lượt khác đang giữ chỗ)
    case "CACHE_FILTER":
      await touch(tabIdFromSender);
      return {
        ok: true,
        seen: await store.known(msg.urls || [], msg.owner || null),
      };

    case "CLAIM": {
      // Lượt cũ (đã bị thay bằng lượt mới) hỏi tiếp → báo nó dừng, không cho giữ chỗ
      const st = await get(K.st(tabIdFromSender), {});
      if (st.runId && st.runId !== msg.owner)
        return { ok: true, granted: false, stale: true };
      await touch(tabIdFromSender);
      return {
        ok: true,
        granted: await store.claim(msg.url, msg.owner, CLAIM_TTL_MS),
      };
    }

    case "RELEASE":
      await store.release(msg.url, msg.owner);
      return { ok: true };

    case "TOI_RECORD": {
      const tabId = tabIdFromSender;
      const st = await get(K.st(tabId), {});
      if (st.runId !== msg.runId) {
        await store.release(msg.record.url, msg.runId);
        return {
          ok: false,
          fatal: true,
          error: "Lượt chạy này đã được thay bằng lượt mới",
        };
      }
      await touch(tabId);
      const cfg = await get(K.cfg(tabId));
      const rec = msg.record;
      const host = new URL(rec.url).host;

      // Cùng post_id nhưng khác URL (đổi slug, chuyển hướng) → không gửi lại, chỉ ghi nhận URL mới
      await resetReloads(tabId); // tải được bài → có tiến triển

      if (await store.postIdKnown(rec.post_id, rec.url)) {
        await store.addSeen({ url: rec.url, host, post_id: rec.post_id });
        await store.release(rec.url, msg.runId);
        await log(tabId, `Bỏ qua (trùng post_id ${rec.post_id}): ${rec.url}`);
        return { ok: true, dup: true };
      }

      if ((await store.outboxCount()) >= OUTBOX_MAX) {
        await store.release(rec.url, msg.runId);
        return {
          ok: false,
          fatal: true,
          error: `Hàng chờ gửi đã đầy (${OUTBOX_MAX} bài) — kiểm tra gateway`,
        };
      }

      const bytes = JSON.stringify(rec).length;
      await store.enqueue({
        url: rec.url,
        host,
        post_id: rec.post_id ?? null,
        tabId,
        topic: cfg.topic,
        batchSize: cfg.batchSize,
        record: rec,
        bytes,
        createdAt: Date.now(),
      });

      const r = await flushTopic(cfg.topic, {
        tabId,
        batchSize: cfg.batchSize,
      });
      if (!r.ok) return { ok: true, queued: true, gatewayError: r.error };
      return { ok: true, queued: true };
    }

    case "TOI_DONE": {
      const tabId = tabIdFromSender;
      // Lượt cũ kết thúc sau khi đã có lượt mới → không đụng vào trạng thái của lượt mới
      const cur = await get(K.st(tabId), {});
      if (msg.runId && cur.runId && cur.runId !== msg.runId) {
        await log(tabId, "Lượt cũ (đã bị thay) đã dừng");
        return { ok: true };
      }
      const cfg = await get(K.cfg(tabId));
      const s = msg.stats || {};
      let error = msg.error || null;
      // Gửi nốt batch cuối chưa đủ số lượng (bỏ qua nếu lượt này dừng vì gateway lỗi)
      if (cfg?.topic && !msg.gatewayDown) {
        const r = await flushTopic(cfg.topic, {
          all: true,
          tabId,
          batchSize: cfg.batchSize,
        });
        if (!r.ok && !error) error = `Gửi batch cuối thất bại: ${r.error}`;
      }
      const pending = await store.outboxCount(cfg?.topic);
      const st = await get(K.st(tabId), {});
      const summary =
        `${msg.mode === "backfill" ? "[Lấy toàn bộ] " : ""}` +
        `${s.found ?? 0} link mới, crawl ${s.queued ?? 0}, đã gửi ${st.runSent || 0}` +
        `${s.dup ? `, trùng ${s.dup}` : ""}${s.errors ? `, lỗi ${s.errors}` : ""}${pending ? `, còn chờ gửi ${pending}` : ""}`;
      await patchStatus(tabId, {
        running: false,
        mode: null,
        lastRunAt: Date.now(),
        lastRunSummary: summary,
        lastError: msg.blocked ? null : error,
      });
      await log(tabId, `Kết thúc: ${summary}${error ? ` — ${error}` : ""}`);

      if (msg.blocked) {
        // Bị chặn sau khi đã thử lại tại chỗ → F5 rồi tự chạy tiếp
        await handleBlocked(tabId, msg.mode);
      } else {
        await sdel(S.rs(tabId));
        if (msg.mode === "backfill" && (await sget(S.bf(tabId)))) {
          await sdel(S.bf(tabId));
          await log(
            tabId,
            msg.finished
              ? "Lấy toàn bộ: HOÀN TẤT tất cả cate"
              : 'Lấy toàn bộ: đã dừng. Bấm "Bắt đầu / Tiếp tục" để chạy tiếp từ vị trí đã lưu',
          );
        }
      }
      return { ok: true };
    }

    // --- từ side panel ---
    case "GET_STATE": {
      const { tabId } = msg;
      const cfg = await get(K.cfg(tabId));
      const status = await get(K.st(tabId), {});
      const logs = await get(K.log(tabId), []);
      const seenCount = await store.countSeen(hostOf(cfg));
      const pendingCount = await store.outboxCount();
      return {
        ok: true,
        cfg,
        global: await getGlobal(),
        status,
        logs,
        seenCount,
        pendingCount,
        bfActive: !!(await sget(S.bf(tabId))),
        bfProgress: await backfillProgress(cfg),
      };
    }

    case "SAVE": {
      const { tabId, raw, rawGlobal, enable } = msg;
      if (enable && (await sget(S.bf(tabId))))
        return { ok: false, errors: ["Tab đang Lấy toàn bộ. Dừng lấy toàn bộ trước khi bật lịch."] };
      const a = normalizeConfig(raw, { requireKafka: true });
      const b = normalizeGlobal(rawGlobal);
      const errors = [...a.errors, ...b.errors];
      if (errors.length) return { ok: false, errors };
      await set(K.global, b.global);
      await set(K.cfg(tabId), a.cfg);
      await patchStatus(tabId, { enabled: !!enable });
      await schedule(tabId);
      await log(
        tabId,
        enable
          ? `Đã lưu và bật lịch "${a.cfg.cron}", topic "${a.cfg.topic}"`
          : "Đã lưu cấu hình (lịch đang tắt)",
      );
      if (enable) ensureOnSite(tabId, a.cfg.home).catch(() => {});
      return { ok: true };
    }

    case "STOP": {
      const { tabId } = msg;
      await patchStatus(tabId, { enabled: false });
      await schedule(tabId);
      await sdel(S.rs(tabId)); // không tự chạy tiếp sau khi tắt lịch
      await chrome.tabs
        .sendMessage(tabId, { type: "TOI_ABORT" })
        .catch(() => {});
      await log(tabId, "Đã tắt lịch");
      return { ok: true };
    }

    case "RUN_NOW":
      return startRun(msg.tabId, "chạy ngay");

    case "TEST": {
      const { tabId, raw } = msg;
      const { cfg, errors } = normalizeConfig(raw, { requireKafka: false });
      if (errors.length) return { ok: false, errors };
      await ensureOnSite(tabId, cfg.home);
      await inject(tabId);
      await log(tabId, "Chạy test crawl (không gửi Kafka, không ghi cache)");
      return chrome.tabs.sendMessage(tabId, { type: "TOI_TEST", config: cfg });
    }

    // Gửi thử 1 message nhỏ để kiểm tra URL, API key, topic
    case "TEST_GATEWAY": {
      const { tabId, rawGlobal, topic } = msg;
      const b = normalizeGlobal(rawGlobal);
      const t = normalizeConfig({ ...DEFAULTS, topic }, { requireKafka: true });
      const errors = [...b.errors, ...t.errors.filter((e) => /topic/i.test(e))];
      if (errors.length) return { ok: false, errors };
      const r = await sendBatch(
        t.cfg.topic,
        [{ type: "test", source: "toi-crawler", ts: Date.now() }],
        b.global,
      ).catch((e) => ({ ok: false, error: e.message }));
      await log(
        tabId,
        r.ok
          ? `Test gateway OK (HTTP ${r.status})${r.text ? `: ${r.text}` : ""}`
          : `Test gateway lỗi: ${r.error}`,
      );
      return r;
    }

    case "FLUSH_NOW": {
      const cfg = await get(K.cfg(msg.tabId));
      const r = await flushAll({
        tabId: msg.tabId,
        batchSize: cfg?.batchSize,
      }).catch((e) => ({
        ok: false,
        error: e.message,
      }));
      return r;
    }

    // ----- Lấy toàn bộ -----
    case "BF_START": {
      const { tabId, raw, rawGlobal } = msg;
      const st = await get(K.st(tabId), {});
      if (st.enabled)
        return { ok: false, errors: ["Tab đang bật lịch. Tắt lịch trước khi Lấy toàn bộ."] };
      if (st.running)
        return { ok: false, errors: ["Tab đang có lượt chạy, chờ xong rồi bấm lại."] };
      const a = normalizeConfig(raw, { requireKafka: true });
      const b = normalizeGlobal(rawGlobal);
      const errors = [...a.errors, ...b.errors];
      if (errors.length) return { ok: false, errors };
      await set(K.global, b.global);
      await set(K.cfg(tabId), a.cfg);
      await sset(S.bf(tabId), { startedAt: Date.now() });
      await sdel(S.rs(tabId));
      await log(tabId, "Bật Lấy toàn bộ");
      return startBackfill(tabId, "Lấy toàn bộ");
    }

    case "BF_STOP": {
      const { tabId } = msg;
      await sdel([S.bf(tabId), S.rs(tabId)]);
      await chrome.tabs.sendMessage(tabId, { type: "TOI_ABORT" }).catch(() => {});
      await log(tabId, "Dừng Lấy toàn bộ (vị trí đã lưu, bấm lại để chạy tiếp)");
      return { ok: true };
    }

    // Xoá dấu trang của các cate đang cấu hình → lần sau lấy lại từ trang 1
    case "BF_RESET": {
      const { tabId } = msg;
      if (await sget(S.bf(tabId)))
        return { ok: false, error: "Dừng Lấy toàn bộ trước khi làm lại từ đầu" };
      const cfg = await get(K.cfg(tabId));
      const sources = cfg ? (cfg.cates?.length ? cfg.cates : [cfg.home]) : [];
      await serial(async () => {
        const all = await get(BF_POS_KEY, {});
        for (const c of sources) delete all[c];
        await set(BF_POS_KEY, all);
      });
      await log(tabId, `Xoá vị trí Lấy toàn bộ của ${sources.length} cate, lần sau lấy lại từ trang 1`);
      return { ok: true };
    }

    case "CLEAR_CACHE": {
      const host = hostOf(await get(K.cfg(msg.tabId)));
      const n = await store.clearHost(host);
      await log(msg.tabId, `Đã xoá ${n} link khỏi cache của ${host}`);
      return { ok: true };
    }
  }
  return undefined;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(
    (r) => sendResponse(r),
    (e) => sendResponse({ ok: false, error: e?.message || String(e) }),
  );
  return true;
});