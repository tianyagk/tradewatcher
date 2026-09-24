/** 与后台 service worker 通信的统一入口。 */
import { esc } from '../shared/format.js';

export async function bg(type, payload = {}) {
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type, payload });
  } catch (error) {
    throw new Error(`后台连接失败：${String(error?.message ?? error)}`);
  }
  if (!res) throw new Error('后台无响应（service worker 可能正在重启，请重试）');
  if (!res.ok) throw new Error(res.error || '请求失败');
  return res.data;
}

/* ── 常用封装 ────────────────────────────────────────────────────────── */

export const quotes = (secids) => bg('quotes', { secids });
export const trend = (secid, ndays = 1) => bg('trend', { secid, ndays });
export const kline = (secid, klt = 101, lmt = 0) => bg('kline', { secid, klt, lmt });
export const detail = (secid) => bg('detail', { secid });
export const boards = (scope = 'industry', sort = 'pct', pn = 1, pz = 50) => bg('boards', { scope, sort, pn, pz });
export const suggest = (q) => bg('suggest', { q });
export const industryMap = (secids) => bg('industry', { secids });
export const limitPool = (kind = 'zt', date) => bg('limit', { kind, date });
export const moneyFlow = (secid) => bg('flow', { secid });
export const stockFlowRank = (sort = 'money', pn = 1, pz = 30) => bg('stockflow', { sort, pn, pz });
export const hsgt = () => bg('hsgt');
export const breadth = () => bg('breadth');
export const distribution = () => bg('distribution');
export const turnover = () => bg('turnover');
export const trades = (secid) => bg('trades', { secid });
export const rescue = (universe) => bg('rescue', { universe });

export const watch = {
  get: () => bg('watch.get'),
  mutate: (body) => bg('watch.mutate', body),
};

export const portfolio = {
  get: () => bg('portfolio.get'),
  mutate: (body) => bg('portfolio.mutate', body),
  ledger: (opts) => bg('ledger.get', opts ?? {}),
  deleteLedger: (id) => bg('ledger.delete', { id }),
};

export const prefs = {
  get: () => bg('prefs.get'),
  set: (patch) => bg('prefs.set', patch),
};

export const alerts = {
  get: () => bg('alerts.get'),
  mutate: (body) => bg('alerts.mutate', body),
  log: () => bg('alerts.log'),
};

export const calendar = {
  get: (opts = {}) => bg('calendar.get', opts),
  mutate: (body) => bg('calendar.mutate', body),
  range: (from, to) => bg('calendar.range', { from, to }),
};

export const data = {
  export: () => bg('export'),
  import: (payload, merge = false) => bg('import', { data: payload, merge }),
  reset: () => bg('reset'),
};

export const meta = () => bg('meta.get');

/* ── 错误处理 ────────────────────────────────────────────────────────── */

export function errText(el, message) {
  if (el) el.innerHTML = `<div class="tw-empty">${esc(message)}</div>`;
}
