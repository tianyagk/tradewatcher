/** 与后台 service worker 通信的统一入口。读接口统一走 UI 缓存（详见 ui/cache.js）。 */
import { esc } from '../shared/format.js';
import { memo, invalidatePrefix } from './cache.js';

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

/* ── 读接口（带缓存：命中即返回，过期则先出旧值再后台刷新） ─────────────── */

/**
 * quotes 刻意**不走**这条路径：面板自己维护 state.quotes 快照并整体落盘，
 * 逐 secid 缓存会产生大量碎片键，且与「行情要尽量新」的诉求相冲突。
 */
export const quotes = (secids) => bg('quotes', { secids });

export const trend = (secid, ndays = 1) => memo(`trend:${secid}:${ndays}`, 20000, () => bg('trend', { secid, ndays }));
export const kline = (secid, klt = 101, lmt = 0) => memo(`kline:${secid}:${klt}:${lmt}`, 60000, () => bg('kline', { secid, klt, lmt }));
export const detail = (secid) => memo(`detail:${secid}`, 12000, () => bg('detail', { secid }));

export const boards = (scope = 'industry', sort = 'pct', pn = 1, pz = 50) =>
  memo(`boards:${scope}:${sort}:${pn}:${pz}`, 30000, () => bg('boards', { scope, sort, pn, pz }));

/** 搜索必须实时，不缓存 */
export const suggest = (q) => bg('suggest', { q });

export const industryMap = (secids) => memo(`industry:${[...secids].sort().join(',')}`, 120000, () => bg('industry', { secids }));

export const limitPool = (kind = 'zt', date) => memo(`limit:${kind}:${date ?? 'today'}`, 30000, () => bg('limit', { kind, date }));

export const moneyFlow = (secid) => memo(`flow:${secid}`, 30000, () => bg('flow', { secid }));
export const stockFlowRank = (sort = 'money', pn = 1, pz = 30) => memo(`stockflow:${sort}:${pn}:${pz}`, 30000, () => bg('stockflow', { sort, pn, pz }));

export const hsgt = () => memo('hsgt', 45000, () => bg('hsgt'));
export const breadth = () => memo('breadth', 15000, () => bg('breadth'));
export const distribution = () => memo('distribution', 90000, () => bg('distribution'));
export const turnover = () => memo('turnover', 45000, () => bg('turnover'));
/** 两融是 T+1 数据，日内不会变，缓存可以给得很长 */
export const margin = () => memo('margin', 1200000, () => bg('margin'));
export const breadthSeries = () => memo('breadthSeries', 20000, () => bg('breadthSeries'));

export const trades = (secid) => memo(`trades:${secid}`, 30000, () => bg('trades', { secid }));
export const rescue = (universe) => memo(`rescue:${universe ?? ''}`, 45000, () => bg('rescue', { universe }));

/* ── 本地数据（不缓存：读写都在本地，必须立刻反映最新状态） ─────────────── */

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
  // 取日历会触发一次上游同步（较慢），所以缓存；增删改后立即按前缀失效
  get: (opts = {}) => memo(`calendar:${opts.from ?? ''}:${opts.to ?? ''}`, 120000, () => bg('calendar.get', opts)),
  mutate: async (body) => {
    const r = await bg('calendar.mutate', body);
    invalidatePrefix('calendar:');
    return r;
  },
  range: (from, to) => bg('calendar.range', { from, to }),
};

export const data = {
  export: () => bg('export'),
  import: (payload, merge = false) => bg('import', { data: payload, merge }),
  reset: () => bg('reset'),
};

export const meta = () => memo('meta', 60000, () => bg('meta.get'));

/** 更新检查刻意不缓存：用户点「检查更新」就是要打一次网络 */
export const update = {
  check: (force = false) => bg('update.check', { force }),
  state: () => bg('update.state'),
  storeCheck: () => bg('update.storeCheck'),
};

/* ── 缓存失效 ────────────────────────────────────────────────────────── */

/**
 * 手动刷新（header 的 ⟳）时调用：清掉派生数据的缓存，
 * 否则「刷新」只会把缓存里的旧值再画一遍，用户会以为按钮失灵。
 */
export function invalidateDerived() {
  for (const k of ['breadth', 'distribution', 'turnover', 'margin', 'breadthSeries', 'hsgt', 'limit', 'boards', 'stockflow', 'flow']) {
    invalidatePrefix(k);
  }
}

/* ── 错误处理 ────────────────────────────────────────────────────────── */

export function errText(el, message) {
  if (el) el.innerHTML = `<div class="tw-empty">${esc(message)}</div>`;
}
