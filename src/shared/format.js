/**
 * 数值 / 时间格式化工具。
 * 全部为纯函数，后台与界面共用。
 */

/** 是否有效数字 */
export function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 解析东财标量：'-' / '' / null → null */
export function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 价格：保留位数据标定（低价标的不会被抹平） */
export function fmtPrice(v, digits = 2) {
  if (!isNum(v)) return '—';
  const abs = Math.abs(v);
  const d = abs >= 100 ? Math.min(digits, 2) : abs >= 10 ? Math.min(Math.max(digits, 2), 3) : Math.max(digits, 3);
  return v.toFixed(d);
}

/** 带符号涨跌值 */
export function fmtChg(v, digits = 2) {
  if (!isNum(v)) return '—';
  return (v > 0 ? '+' : '') + fmtPrice(v, digits);
}

/** 涨跌幅（%），带符号 */
export function fmtPct(v, digits = 2) {
  if (!isNum(v)) return '—';
  return (v > 0 ? '+' : '') + v.toFixed(digits) + '%';
}

/** 金额：自动 亿 / 万 */
export function fmtAmt(v) {
  if (!isNum(v)) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e12) return sign + (abs / 1e12).toFixed(2) + '万亿';
  if (abs >= 1e8) return sign + (abs / 1e8).toFixed(2) + '亿';
  if (abs >= 1e4) return sign + (abs / 1e4).toFixed(2) + '万';
  return sign + abs.toFixed(0);
}

/**
 * 金额：单位跟随参考值。
 * 用于「同期对比」场景（如 当日成交额 vs 较昨日变动），保证两侧单位一致、
 * 避免出现「1.65万亿」和「-1116.19亿」并排而无法直观比较量级。
 */
export function fmtAmtLike(v, ref) {
  if (!isNum(v)) return '—';
  const abs = Math.abs(v);
  const absRef = Math.abs(isNum(ref) ? ref : 0);
  const sign = v < 0 ? '-' : '';
  if (absRef >= 1e12) return sign + (abs / 1e12).toFixed(2) + '万亿';
  if (absRef >= 1e8) return sign + (abs / 1e8).toFixed(2) + '亿';
  if (absRef >= 1e4) return sign + (abs / 1e4).toFixed(2) + '万';
  return sign + abs.toFixed(0);
}

/** 成交量（股/手） */
export function fmtVol(v) {
  if (!isNum(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e8) return (abs / 1e8).toFixed(2) + '亿';
  if (abs >= 1e4) return (abs / 1e4).toFixed(2) + '万';
  return abs.toFixed(0);
}

/** 千分位整数 */
export function fmtInt(v) {
  if (!isNum(v)) return '—';
  return Math.round(v).toLocaleString('zh-CN');
}

/** 时间戳 → HH:mm:ss */
export function fmtClock(ts) {
  if (!isNum(ts)) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 时间戳 → YYYY-MM-DD */
export function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 时间戳 → YYYY-MM-DD HH:mm */
export function fmtDateTime(ts) {
  return `${fmtDate(ts)} ${fmtClock(ts).slice(0, 5)}`;
}

/** 涨跌方向：1 涨 / -1 跌 / 0 平 */
export function dir(v) {
  if (!isNum(v) || v === 0) return 0;
  return v > 0 ? 1 : -1;
}

/**
 * 涨跌配色类名。
 * 遵循 A 股习惯：红涨绿跌（redUp = true）。
 */
export function pctClass(v, redUp = true) {
  const d = dir(v);
  if (d === 0) return 'tw-flat';
  const up = d > 0;
  return up === redUp ? 'tw-up' : 'tw-down';
}

/** 配色十六进制值（图表内用） */
export function pctColor(v, redUp = true) {
  const d = dir(v);
  if (d === 0) return 'var(--tw-flat-ink)';
  const up = d > 0;
  return up === redUp ? 'var(--tw-up-ink)' : 'var(--tw-down-ink)';
}

/** secid → A股/深沪代码 */
export function secidSplit(secid) {
  const i = String(secid).indexOf('.');
  if (i <= 0) return { market: '', code: '' };
  return { market: secid.slice(0, i), code: secid.slice(i + 1) };
}

/** 是否 A 股（沪 1 / 深 0） */
export function isAShare(secid) {
  const { market } = secidSplit(secid);
  return market === '0' || market === '1';
}

/** 市场中文名 */
export function marketLabel(secid) {
  const { market } = secidSplit(secid);
  const map = {
    0: '深市', 1: '沪市', 100: '全球指数', 101: '境外市场', 105: '美股', 106: '美股',
    107: '美股', 113: '上期所', 114: '大商所', 116: '港股', 122: '伦敦', 142: '广期所',
  };
  return map[market] ?? '行情';
}

/**
 * 判断 A 股交易时段状态。
 * 返回 { open, label } —— 仅作展示提示，不参与取数逻辑。
 */
export function marketStatus(now = Date.now()) {
  const d = new Date(now);
  const day = d.getDay();
  const hm = d.getHours() * 100 + d.getMinutes();
  const weekend = day === 0 || day === 6;
  if (weekend) return { open: false, label: '休市', hint: '周末' };
  if (hm >= 930 && hm <= 1130) return { open: true, label: '交易中', hint: '上午盘' };
  if (hm >= 1300 && hm <= 1500) return { open: true, label: '交易中', hint: '下午盘' };
  if (hm > 1130 && hm < 1300) return { open: false, label: '午间休市', hint: '13:00 开盘' };
  if (hm >= 915 && hm < 930) return { open: false, label: '集合竞价', hint: '09:30 开盘' };
  if (hm > 1500 && hm <= 1530) return { open: false, label: '已收盘', hint: '盘后' };
  return { open: false, label: '休市', hint: '' };
}

/** 安全转义（用于插入 innerHTML 的文本） */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ── 交易时段标尺 ──────────────────────────────────────────────────────── */

const S_OPEN = 9 * 60 + 30;
const S_LUNCH_S = 11 * 60 + 30;
const S_LUNCH_E = 13 * 60;
const S_CLOSE = 15 * 60;
const S_TOTAL = S_LUNCH_S - S_OPEN + (S_CLOSE - S_LUNCH_E);   // 240 分钟

/**
 * 时间戳 → 交易时段进度 0..1（**午休与隔夜折叠**）。
 * 用于把 09:30–11:30 / 13:00–15:00 的采样点均匀铺在一条轴上，
 * 否则中午 90 分钟的空档会在图上留下一段无意义的水平直线。
 */
export function sessionPos(ts) {
  const d = new Date(ts);
  const m = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  if (m <= S_OPEN) return 0;
  if (m >= S_CLOSE) return 1;
  if (m <= S_LUNCH_S) return (m - S_OPEN) / S_TOTAL;
  if (m < S_LUNCH_E) return (S_LUNCH_S - S_OPEN) / S_TOTAL;
  return (S_LUNCH_S - S_OPEN + (m - S_LUNCH_E)) / S_TOTAL;
}

/** 进度 0..1 → "HH:MM"（sessionPos 的逆映射，用于画时间轴刻度） */
export function sessionLabel(pos) {
  const m = Math.round(Math.max(0, Math.min(1, pos)) * S_TOTAL) + S_OPEN;
  const real = m <= S_LUNCH_S ? m : m + (S_LUNCH_E - S_LUNCH_S);
  const h = Math.floor(real / 60);
  const mm = Math.round(real % 60);
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** 是否处于（或刚过）可采样的时段：09:30–11:30 / 13:00–15:05 */
export function inSamplingWindow(now = Date.now()) {
  const st = marketStatus(now);
  return st.open || st.hint === '盘后';
}
