import { parseCron } from './cron.js';

export const DEFAULTS = {
  home: 'https://www.timesofisrael.com/',
  cates: [],
  cron: '*/30 * * * *',
  // Link bài TOI: một đoạn slug dài ngay sau domain, ví dụ /ten-bai-viet-rat-dai/
  regex: '^https://www\\.timesofisrael\\.com/(?:[a-z0-9]+-){4,}[a-z0-9]+/$',
  delayMin: 3,
  delayMax: 8,
  maxPages: 2,       // số lần gọi Load more tối đa cho mỗi cate
  htmlMode: 'full',  // 'full' = cả trang, 'article' = chỉ khối #main-content
};

const ALLOWED_HOST = 'www.timesofisrael.com';

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

// Chuẩn hoá + kiểm tra cấu hình. Trả về { cfg, errors }
export function normalizeConfig(raw = {}) {
  const errors = [];
  const cfg = { ...DEFAULTS };

  cfg.home = checkUrl(String(raw.home || '').trim(), 'Link home', errors) || cfg.home;

  const cates = Array.isArray(raw.cates)
    ? raw.cates
    : String(raw.cates || '').split(/\r?\n/);
  cfg.cates = cates
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => checkUrl(s, 'Link cate', errors))
    .filter(Boolean);

  cfg.cron = String(raw.cron || '').trim();
  try { parseCron(cfg.cron); } catch (e) { errors.push(e.message); }

  cfg.regex = String(raw.regex || '').trim();
  try { new RegExp(cfg.regex); } catch (e) { errors.push(`Regex lỗi: ${e.message}`); }

  cfg.delayMin = Number(raw.delayMin);
  cfg.delayMax = Number(raw.delayMax);
  if (!Number.isFinite(cfg.delayMin) || !Number.isFinite(cfg.delayMax) || cfg.delayMin < 0) {
    errors.push('Delay phải là số giây không âm');
  } else if (cfg.delayMin > cfg.delayMax) {
    errors.push('Delay tối thiểu phải nhỏ hơn hoặc bằng tối đa');
  } else if (cfg.delayMax > 120) {
    errors.push('Delay tối đa không quá 120 giây');
  }

  cfg.maxPages = Number(raw.maxPages);
  if (!Number.isInteger(cfg.maxPages) || cfg.maxPages < 0 || cfg.maxPages > 20) {
    errors.push('Số lần Load more phải là số nguyên từ 0 đến 20');
  }

  cfg.htmlMode = raw.htmlMode === 'article' ? 'article' : 'full';
  return { cfg, errors };
}
