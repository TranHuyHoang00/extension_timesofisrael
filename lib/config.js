import { parseCron } from "./cron.js";

export const DEFAULTS = {
  home: "https://www.timesofisrael.com/",
  cates: [],
  cron: "*/30 * * * *",
  // Link bài TOI: một đoạn slug dài ngay sau domain, ví dụ /ten-bai-viet-rat-dai/
  regex: "^https://www\\.timesofisrael\\.com/(?:[a-z0-9]+-){4,}[a-z0-9]+/$",
  delayMin: 3,
  delayMax: 8,
  maxPages: 2, // số lần gọi Load more tối đa cho mỗi cate
  htmlMode: "article", // 'full' = cả trang, 'article' = chỉ khối #main-content
  cacheDays: 30, // link đã gửi được nhớ bao nhiêu ngày (chống crawl trùng)
  topic: "", // Kafka topic của tab này
  batchSize: 30, // số bài gửi lên gateway trong một request
};

// Cấu hình dùng chung cho mọi tab
export const GLOBAL_DEFAULTS = {
  gatewayUrl: "",
  apiKey: "",
};

export const LIMITS = {
  batchMax: 100,
};

const ALLOWED_HOST = "www.timesofisrael.com";

function checkUrl(value, label, errors) {
  try {
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol)) throw new Error();
    if (u.host !== ALLOWED_HOST) {
      errors.push(`${label} phải thuộc ${ALLOWED_HOST}: ${value}`);
      return null;
    }
    return u.href;
  } catch {
    errors.push(`${label} không phải URL hợp lệ: ${value}`);
    return null;
  }
}

// Chuẩn hoá + kiểm tra cấu hình của một tab. Trả về { cfg, errors }
//   requireKafka: true khi lưu để chạy thật (bắt buộc có topic); false khi chỉ test crawl
export function normalizeConfig(raw = {}, { requireKafka = true } = {}) {
  const errors = [];
  const cfg = { ...DEFAULTS };

  cfg.home =
    checkUrl(String(raw.home || "").trim(), "Link home", errors) || cfg.home;

  const cates = Array.isArray(raw.cates)
    ? raw.cates
    : String(raw.cates || "").split(/\r?\n/);
  cfg.cates = cates
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => checkUrl(s, "Link cate", errors))
    .filter(Boolean);

  cfg.cron = String(raw.cron || "").trim();
  try {
    parseCron(cfg.cron);
  } catch (e) {
    errors.push(e.message);
  }

  cfg.regex = String(raw.regex || "").trim();
  try {
    new RegExp(cfg.regex);
  } catch (e) {
    errors.push(`Regex lỗi: ${e.message}`);
  }

  cfg.delayMin = Number(raw.delayMin);
  cfg.delayMax = Number(raw.delayMax);
  if (
    !Number.isFinite(cfg.delayMin) ||
    !Number.isFinite(cfg.delayMax) ||
    cfg.delayMin < 0
  ) {
    errors.push("Delay phải là số giây không âm");
  } else if (cfg.delayMin > cfg.delayMax) {
    errors.push("Delay tối thiểu phải nhỏ hơn hoặc bằng tối đa");
  } else if (cfg.delayMax > 120) {
    errors.push("Delay tối đa không quá 120 giây");
  }

  cfg.maxPages = Number(raw.maxPages);
  if (
    !Number.isInteger(cfg.maxPages) ||
    cfg.maxPages < 0 ||
    cfg.maxPages > 20
  ) {
    errors.push("Số lần Load more phải là số nguyên từ 0 đến 20");
  }

  cfg.htmlMode = raw.htmlMode === "article" ? "article" : "full";

  cfg.cacheDays = Number(raw.cacheDays ?? DEFAULTS.cacheDays);
  if (
    !Number.isInteger(cfg.cacheDays) ||
    cfg.cacheDays < 1 ||
    cfg.cacheDays > 365
  ) {
    errors.push("Số ngày giữ cache phải là số nguyên từ 1 đến 365");
  }

  cfg.topic = String(raw.topic || "").trim();
  if (cfg.topic && !/^[A-Za-z0-9._-]{1,249}$/.test(cfg.topic)) {
    errors.push("Topic chỉ gồm chữ, số, dấu chấm, gạch ngang, gạch dưới");
  } else if (!cfg.topic && requireKafka) {
    errors.push("Chưa nhập Kafka topic");
  }

  cfg.batchSize = Number(raw.batchSize ?? DEFAULTS.batchSize);
  if (
    !Number.isInteger(cfg.batchSize) ||
    cfg.batchSize < 1 ||
    cfg.batchSize > LIMITS.batchMax
  ) {
    errors.push(`Batch size phải là số nguyên từ 1 đến ${LIMITS.batchMax}`);
  }
  return { cfg, errors };
}

// Chuẩn hoá + kiểm tra cấu hình gateway dùng chung. Trả về { global, errors }
export function normalizeGlobal(raw = {}) {
  const errors = [];
  const global = { ...GLOBAL_DEFAULTS };

  const url = String(raw.gatewayUrl || "").trim();
  if (!url) {
    errors.push("Chưa nhập Gateway URL");
  } else {
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) throw new Error();
      u.searchParams.delete("apikey"); // API key nhập ở ô riêng
      global.gatewayUrl = u.href;
    } catch {
      errors.push(`Gateway URL không hợp lệ: ${url}`);
    }
  }

  global.apiKey = String(raw.apiKey || "").trim();
  if (!global.apiKey) errors.push("Chưa nhập API key");
  return { global, errors };
}

// Origin dạng "https://host/*" để xin quyền truy cập gateway
export function gatewayOriginPattern(gatewayUrl) {
  try {
    const u = new URL(String(gatewayUrl || "").trim());
    if (!/^https?:$/.test(u.protocol)) return null;
    return `${u.origin}/*`;
  } catch {
    return null;
  }
}
