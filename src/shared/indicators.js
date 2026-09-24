/**
 * 技术指标：MA / EMA / MACD / BOLL / KDJ / RSI。
 * 输入为数值数组（旧 → 新），返回等长数组，前置不足位为 null。
 */

export function SMA(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    sum += v;
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function EMA(values, n) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    prev = prev === null ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** MACD(12,26,9)：返回 { dif, dea, hist }，hist = (dif − dea) × 2 */
export function MACD(values, fast = 12, slow = 26, signal = 9) {
  const ef = EMA(values, fast);
  const es = EMA(values, slow);
  const dif = values.map((_, i) => (ef[i] === null || es[i] === null ? null : ef[i] - es[i]));
  const valid = dif.filter((v) => v !== null);
  const deaValid = EMA(valid, signal);
  const dea = new Array(values.length).fill(null);
  const offset = dif.findIndex((v) => v !== null);
  if (offset >= 0) for (let i = 0; i < deaValid.length; i += 1) dea[offset + i] = deaValid[i];
  const hist = values.map((_, i) => (dif[i] === null || dea[i] === null ? null : (dif[i] - dea[i]) * 2));
  return { dif, dea, hist };
}

/** BOLL(20,2) */
export function BOLL(values, n = 20, k = 2) {
  const mid = SMA(values, n);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let i = n - 1; i < values.length; i += 1) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j += 1) s += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / n);
    upper[i] = mid[i] + k * sd;
    lower[i] = mid[i] - k * sd;
  }
  return { mid, upper, lower };
}

/** KDJ(9,3,3) */
export function KDJ(high, low, close, n = 9) {
  const len = close.length;
  const K = new Array(len).fill(null);
  const D = new Array(len).fill(null);
  const J = new Array(len).fill(null);
  let k = 50;
  let d = 50;
  for (let i = 0; i < len; i += 1) {
    const s = Math.max(0, i - n + 1);
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = s; j <= i; j += 1) {
      hh = Math.max(hh, high[j]);
      ll = Math.min(ll, low[j]);
    }
    const rsv = hh === ll ? 50 : ((close[i] - ll) / (hh - ll)) * 100;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
    K[i] = k;
    D[i] = d;
    J[i] = 3 * k - 2 * d;
  }
  return { K, D, J };
}

export function RSI(values, n = 14) {
  const out = new Array(values.length).fill(null);
  let up = 0;
  let dn = 0;
  for (let i = 1; i < values.length; i += 1) {
    const ch = values[i] - values[i - 1];
    const u = Math.max(ch, 0);
    const d = Math.max(-ch, 0);
    if (i <= n) {
      up += u;
      dn += d;
      if (i === n) out[i] = dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
    } else {
      up = (up * (n - 1) + u) / n;
      dn = (dn * (n - 1) + d) / n;
      out[i] = dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
    }
  }
  return out;
}

/** 主图均线组 */
export const MA_CONFIG = [
  { n: 5, color: '#e8a33d' },
  { n: 10, color: '#3b8ff3' },
  { n: 20, color: '#b46ef0' },
  { n: 60, color: '#7d8b9c' },
];
