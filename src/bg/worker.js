/**
 * Service Worker：统一消息路由 + 定时任务（角标 / 预警 / 日历同步）+ 上下文菜单。
 *
 * 说明：MV3 后台会被回收，因此不依赖常驻定时器；界面自身负责高频刷新（消息驱动），
 * 后台只承担低频但必须持续的工作（角标、预警、日历）。
 */
import * as em from './em.js';
import * as cal from './calendar.js';
import * as store from './store.js';
import * as updater from './updater.js';
import { marketStatus, pctClass } from '../shared/format.js';
import { STRIP_ALL_SECIDS, CORE_INDICES, rescueUniverse } from '../shared/model.js';

/* ─────────────────────────── 消息路由 ────────────────────────────────── */

const handlers = {
  // 行情
  quotes: ({ secids }) => em.fetchQuotes(secids ?? []),
  detail: ({ secid }) => em.fetchDetail(secid),
  trend: ({ secid, ndays }) => em.fetchTrend(secid, ndays ?? 1),
  kline: ({ secid, klt, lmt }) => em.fetchKline(secid, klt ?? 101, lmt ?? 0),
  boards: ({ scope, sort, pn, pz }) => em.fetchBoards(scope ?? 'industry', sort ?? 'pct', pn ?? 1, pz ?? 50),
  suggest: ({ q }) => em.searchSymbols(q),
  industry: ({ secids }) => em.fetchIndustryMap(secids ?? []),
  limit: ({ kind, date }) => em.fetchLimitPool(kind ?? 'zt', date, 80),
  flow: ({ secid }) => em.fetchMoneyFlow(secid),
  stockflow: ({ sort, pn, pz }) => em.fetchStockFlowRank(sort ?? 'money', pn ?? 1, pz ?? 30),
  hsgt: () => em.fetchHsgt(),
  breadth: () => em.fetchBreadth(),
  distribution: () => em.fetchDistribution(),
  // 顺带把「交易时段进度」一起给出，前端据此推算全天成交额
  turnover: async () => {
    const t = await em.fetchTurnover();
    return t === null ? null : { ...t, progress: timeProgress() };
  },
  margin: () => em.fetchMargin(),
  breadthSeries: () => em.fetchBreadthSeries(),
  stripQuotes: () => em.fetchQuotes([...new Set([...STRIP_ALL_SECIDS, ...CORE_INDICES.map((i) => i.secid)])]),

  // 自选
  'watch.get': () => store.getWatch(),
  'watch.mutate': (p) => store.mutateWatch(p),

  // 持仓
  'portfolio.get': async () => {
    const [p, ledger] = await Promise.all([store.getPortfolio(), store.getLedger()]);
    const secids = [...new Set(p.items.map((i) => i.secid))];
    const quotes = secids.length > 0 ? await em.fetchQuotes(secids) : {};
    return { view: store.assemblePortfolio(p.groups, p.items, ledger, quotes), data: p, ledger };
  },
  'portfolio.mutate': (p) => store.mutatePortfolio(p),
  'ledger.get': ({ groupId, posId, limit } = {}) =>
    store.getLedger().then(async (l) => {
      const p = await store.getPortfolio();
      return store.ledgerView(l, p.groups, p.items, { groupId, posId, limit });
    }),
  'ledger.delete': ({ id }) => store.deleteLedgerEntry(id),
  'trades.get': async ({ secid }) => {
    const [l, p] = await Promise.all([store.getLedger(), store.getPortfolio()]);
    return store.tradesOf(l, secid, p.items);
  },

  // 偏好
  'prefs.get': () => store.getPrefs(),
  'prefs.set': (p) => store.setPrefs(p),

  // 预警
  'alerts.get': () => store.getAlerts(),
  'alerts.mutate': (p) => store.mutateAlerts(p),
  'alerts.log': () => store.getAlertLog(),

  // 日历
  'calendar.get': async ({ from, to, sync, force } = {}) => {
    let c = await cal.getCal();
    if (sync !== false) {
      try {
        const codes = await focusCodes();
        c = await cal.sync({ codes, force });
      } catch {
        /* 同步失败仍返回本地事件 */
      }
    }
    return { data: c, events: from && to ? cal.listRange(c, from, to) : c.events };
  },
  'calendar.mutate': (p) => cal.mutateCal(p),
  'calendar.range': async ({ from, to }) => cal.listRange(await cal.getCal(), from, to),

  // 护盘（简化版：只用宽基 ETF 量价 + 资金流做概率性提示）
  rescue: ({ universe } = {}) => sampleRescue(universe),

  // 数据
  export: () => store.exportAll(),
  import: (p) => store.importAll(p?.data, { merge: !!p?.merge }),
  reset: () => store.resetAll(),

  // 系统
  'badge.refresh': () => refreshBadge(),
  'notify.test': () => notify('tradewatcher 测试通知', '通知通道正常，预警触发时会在此提醒。'),
  'meta.get': async () => ({
    market: marketStatus(),
    version: chrome.runtime.getManifest().version,
    platform: 'Edge / Chromium',
  }),

  // 更新检查（详见 bg/updater.js）
  'update.check': ({ force } = {}) => checkUpdate({ force: !!force }),
  'update.state': () => updater.getUpdateState(),
  'update.storeCheck': () => updater.checkStoreUpdate(),
};

async function focusCodes() {
  const [w, p] = await Promise.all([store.getWatch(), store.getPortfolio()]);
  const codes = new Set();
  for (const it of [...w.items, ...p.items]) {
    const m = /^(\d{1,3})\.([A-Za-z0-9]+)$/.exec(it.secid);
    if (m && (m[1] === '0' || m[1] === '1')) codes.add(m[2]);
  }
  return [...codes];
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = handlers[msg?.type];
  if (typeof fn !== 'function') {
    sendResponse({ ok: false, error: `未知消息类型 ${msg?.type}` });
    return false;
  }
  Promise.resolve()
    .then(() => fn(msg.payload ?? {}))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => {
      console.warn('[tradewatcher]', msg?.type, String(error));
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
  return true; // 异步响应
});

/* ─────────────────────────── 角标 ───────────────────────────────────── */

async function refreshBadge() {
  const prefs = await store.getPrefs();
  const mode = prefs.badgeMode ?? 'sh';
  if (mode === 'off') {
    await chrome.action.setBadgeText({ text: '' });
    return null;
  }
  try {
    let secid = prefs.badgeTarget || '1.000001';
    let label = null;
    if (mode === 'watchFirst') {
      const w = await store.getWatch();
      const live = w.items.filter((i) => !w.groups.find((g) => g.id === i.groupId && g.archived));
      secid = live[0]?.secid ?? '1.000001';
      label = live[0]?.name ?? null;
    }
    if (mode === 'portfolio') {
      const p = await store.getPortfolio();
      const ledger = await store.getLedger();
      const secids = [...new Set(p.items.map((i) => i.secid))];
      const quotes = secids.length > 0 ? await em.fetchQuotes(secids) : {};
      const view = store.assemblePortfolio(p.groups, p.items, ledger, quotes);
      const base = view.grand.totalMv - view.grand.dayPnl;
      const pct = base > 0 ? (view.grand.dayPnl / base) * 100 : null;
      if (pct === null) {
        await chrome.action.setBadgeText({ text: '' });
        return null;
      }
      await paintBadge(pct, prefs.redUp);
      return pct;
    }
    const rows = await em.fetchQuotes([secid]);
    const row = rows[secid];
    if (!row || row.pct === null) {
      await chrome.action.setBadgeText({ text: '' });
      return null;
    }
    await paintBadge(row.pct, prefs.redUp);
    return { secid, label, pct: row.pct };
  } catch {
    return null;
  }
}

async function paintBadge(pct, redUp) {
  const text = `${pct > 0 ? '+' : ''}${pct.toFixed(1)}`;
  await chrome.action.setBadgeText({ text });
  const up = pct > 0;
  const color = pct === 0 ? '#7a8698' : up === redUp ? '#e03131' : '#0f9d58';
  try {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  } catch {
    /* 旧内核无 setBadgeTextColor */
  }
}

/* ─────────────────────────── 预警引擎 ───────────────────────────────── */

async function evaluateAlerts() {
  const prefs = await store.getPrefs();
  if (!prefs.notifyEnabled) return;
  const alerts = await store.getAlerts();
  const active = alerts.filter((a) => a.enabled && a.secid);
  if (active.length === 0) return;
  const quotes = await em.fetchQuotes([...new Set(active.map((a) => a.secid))]);
  const now = Date.now();
  for (const a of active) {
    const row = quotes[a.secid];
    if (!row) continue;
    const val = a.field === 'price' ? row.price : row.pct;
    if (val === null || val === undefined) continue;
    const hit = a.op === '<=' ? val <= a.value : val >= a.value;
    if (!hit) continue;
    if (now - (a.lastFiredAt ?? 0) < (a.cooldownSec ?? 600) * 1000) continue;
    await store.mutateAlerts({ op: 'update', id: a.id, patch: { lastFiredAt: now } });
    const desc = a.field === 'price' ? `现价 ${val.toFixed(3)}` : `涨跌幅 ${val.toFixed(2)}%`;
    const title = `${a.name || a.secid} 触发预警`;
    const message = `${a.field === 'price' ? '价格' : '涨跌幅'}满足 ${a.op === '<=' ? '≤' : '≥'} ${a.value}（当前 ${desc}）${a.note ? `\n${a.note}` : ''}`;
    await notify(title, message, `${a.secid}-${a.id}`);
    await store.pushAlertLog({ id: a.id, secid: a.secid, name: a.name, field: a.field, op: a.op, value: a.value, actual: val, ts: now, note: a.note });
  }
}

let notifySeq = 0;
/**
 * @param {string} [contextMessage] 通知右上角的小字
 * @param {{id?:string, durationMs?:number, requireInteraction?:boolean}} [opts]
 *   传 id 时固定前缀，便于 onClicked 里分流（tw-update-* 打开设置页，其余打开面板）
 */
async function notify(title, message, contextMessage, opts = {}) {
  try {
    const id = opts.id ? `${opts.id}-${Date.now()}` : `tw-${Date.now()}-${notifySeq++}`;
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
      contextMessage: contextMessage ?? 'tradewatcher',
      priority: 2,
      ...(opts.requireInteraction ? { requireInteraction: true } : {}),
      ...(opts.durationMs ? { duration: opts.durationMs } : {}),
    });
  } catch (error) {
    console.warn('[tradewatcher] notify failed', String(error));
  }
}

/* ─────────────────────────── 护盘信号（轻量版） ─────────────────────── */

/**
 * 概率性信号：宽基 ETF「同时点量能倍数 + 超大单资金」共振 + 指数承压。
 * 仅识别行为模式，不能证明买入方身份。
 */
async function sampleRescue(universe) {
  const meta = rescueUniverse(universe ?? []);
  const secids = [...new Set([...meta.map((m) => m.secid), '1.000300'])];
  const quotes = await em.fetchQuotes(secids);
  const etfs = meta.map((m) => {
    const q = quotes[m.secid];
    return {
      secid: m.secid,
      name: m.name,
      index: m.index,
      price: q?.price ?? null,
      pct: q?.pct ?? null,
      amount: q?.amount ?? null,
      volRatio: q?.volumeRatio ?? null,
      mainNet: q?.mainNet ?? null,
      turnover: q?.turnover ?? null,
    };
  });
  const idx = quotes['1.000300'];
  const indexPct = idx?.pct ?? null;

  // 时点进度（按交易分钟数归一）
  const coef = timeProgress();
  const factors = [];
  const heavy = etfs.filter((e) => (e.volRatio ?? 0) >= 1.5);
  const inflow = etfs.filter((e) => (e.mainNet ?? 0) > 0);
  const strongInflow = etfs.filter((e) => (e.mainNet ?? 0) > 3e8);

  factors.push({
    id: 'volume',
    label: '量能放大',
    score: clamp((heavy.length / Math.max(1, etfs.length)) * 100 * Math.min(1.4, Math.max(...etfs.map((e) => e.volRatio ?? 0)) / 1.5)),
    weight: 0.3,
    actual: heavy.length > 0 ? `${heavy.length} 只量比 ≥1.5（最高 ${Math.max(...etfs.map((e) => e.volRatio ?? 0)).toFixed(2)}）` : '无量比异动',
    threshold: '量比 ≥ 1.5 视为放量',
    hit: heavy.length > 0,
  });
  factors.push({
    id: 'superflow',
    label: '主力净流入',
    score: clamp((strongInflow.length / Math.max(1, etfs.length)) * 100 * 1.2),
    weight: 0.34,
    actual: `${inflow.length}/${etfs.length} 只主力净流入`,
    threshold: '主力净额 > 3 亿视为强流入',
    hit: strongInflow.length > 0,
  });
  factors.push({
    id: 'divergence',
    label: '量价背离',
    score: indexPct !== null && indexPct < 0 && heavy.length > 0 ? 70 : 0,
    weight: 0.2,
    actual: indexPct === null ? '无指数数据' : `沪深300 ${indexPct.toFixed(2)}%`,
    threshold: '指数下跌且 ETF 放量',
    hit: indexPct !== null && indexPct < 0 && heavy.length > 0,
  });
  factors.push({
    id: 'pulse',
    label: '时点进度',
    score: coef * 100,
    weight: 0.16,
    actual: `日内进度 ${(coef * 100).toFixed(0)}%`,
    threshold: '按交易分钟归一，尾盘权重更高',
    hit: coef > 0.5,
  });

  const totalW = factors.reduce((a, f) => a + f.weight, 0);
  let score = Math.round((factors.reduce((a, f) => a + f.score * f.weight, 0) / totalW) * clamp(0.55 + coef * 0.55, 0.55, 1.1));
  // 防误报：指数明显上涨时封顶
  if (indexPct !== null && indexPct >= 1.0) score = Math.min(score, 54);
  else if (indexPct !== null && indexPct >= 0.3) score = Math.min(score, 74);
  if (strongInflow.length === 0) score = Math.min(score, 54);

  const level = score >= 75 ? 3 : score >= 55 ? 2 : score >= 35 ? 1 : 0;
  const summary =
    level === 0
      ? '宽基 ETF 量能与资金流均在常态区间'
      : level === 1
        ? '出现放量或资金流入，尚不构成护盘特征'
        : level === 2
          ? '量能放大 + 主力净流入 + 指数承压，具备护盘特征'
          : '多通道共振的放量买入，符合历史上护盘行为模式';

  return {
    ts: Date.now(),
    trading: marketStatus().open,
    level,
    score,
    summary,
    factors,
    etfs,
    indexPct,
    indexName: '沪深300',
    timeCoef: coef,
    note: '概率性信号：仅识别「放量 + 主力净流入」的行为模式，不能证明买入方身份；ETF 天量含做市与套利盘。',
  };
}

function timeProgress(now = Date.now()) {
  const d = new Date(now);
  const mins = d.getHours() * 60 + d.getMinutes();
  const open = 9 * 60 + 30;
  const close = 15 * 60;
  const lunchS = 11 * 60 + 30;
  const lunchE = 13 * 60;
  const total = (lunchS - open) + (close - lunchE);
  if (mins <= open) return 0;
  if (mins >= close) return 1;
  if (mins <= lunchS) return (mins - open) / total;
  if (mins < lunchE) return (lunchS - open) / total;
  return ((lunchS - open) + (mins - lunchE)) / total;
}

function clamp(v, lo = 0, hi = 100) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(lo, Math.min(hi, v));
}

/* ─────────────────────────── 更新检查 ───────────────────────────────── */

/** 6 小时内不重复打 GitHub（匿名配额 60 次/小时，但没必要天天点满） */
const UPDATE_MIN_INTERVAL = 6 * 3600 * 1000;

async function checkUpdate({ force = false } = {}) {
  const prefs = await store.getPrefs();
  const repo = prefs.updateRepo || undefined;
  if (!force) {
    const prev = await updater.getUpdateState();
    if (prev && prev.repo === repo && Date.now() - (prev.checkedAt ?? 0) < UPDATE_MIN_INTERVAL) return prev;
  }
  return updater.refreshUpdateState({ repo, includePrerelease: !!prefs.includePrerelease });
}

/** 每日自动检查：只在「首次发现某个新版本」时推送一次通知，避免天天骚扰 */
async function autoCheckUpdate() {
  const prefs = await store.getPrefs();
  if (prefs.autoUpdateCheck === false) return null;
  const before = await updater.getUpdateState();
  const state = await updater.refreshUpdateState({ repo: prefs.updateRepo, includePrerelease: !!prefs.includePrerelease });
  const isNewDiscovery = state.ok && state.hasUpdate && state.version && before?.version !== state.version;
  if (isNewDiscovery) {
    await notify(
      `tradewatcher 有新版本 ${state.version}`,
      `当前 v${chrome.runtime.getManifest().version} → 最新 v${state.version}。打开「设置 → 关于」可查看更新说明并一键更新。`,
      'tradewatcher · 更新提醒',
      { id: 'tw-update', durationMs: 15000 },
    );
  }
  return state;
}

/* ─────────────────────────── 定时任务 ───────────────────────────────── */

const ALARM_TICK = 'tw:tick';
const ALARM_CAL = 'tw:calendar';
const ALARM_UPDATE = 'tw:update';

async function ensureAlarms() {
  await chrome.alarms.create(ALARM_TICK, { periodInMinutes: 1, delayInMinutes: 0.1 });
  await chrome.alarms.create(ALARM_CAL, { periodInMinutes: 360, delayInMinutes: 0.5 });
  // 每天检查一次更新（首次延迟 3 分钟，避开启动瞬间的请求洪峰）
  await chrome.alarms.create(ALARM_UPDATE, { periodInMinutes: 1440, delayInMinutes: 3 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_TICK) {
    await refreshBadge().catch(() => {});
    await evaluateAlerts().catch(() => {});
    // 涨跌家数日内序列没有免费历史源，只能靠这里按分钟累积（内部自带 3 分钟节流与交易时段判断）
    await em.sampleBreadthSeries().catch(() => {});
  } else if (alarm.name === ALARM_CAL) {
    try {
      const codes = await focusCodes();
      await cal.sync({ codes, force: false });
    } catch {
      /* 忽略同步失败 */
    }
  } else if (alarm.name === ALARM_UPDATE) {
    await autoCheckUpdate().catch(() => {});
  }
});

/* ─────────────────────────── 生命周期 ───────────────────────────────── */

chrome.runtime.onInstalled.addListener(async (details) => {
  await store.getPrefs();
  await store.getWatch();
  await store.getPortfolio();
  await ensureAlarms();
  await refreshBadge().catch(() => {});

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'tw-open',
      title: 'tradewatcher：打开盯盘',
      contexts: ['action', 'page'],
    });
    chrome.contextMenus.create({
      id: 'tw-options',
      title: 'tradewatcher：打开设置',
      contexts: ['action', 'page'],
    });
  });

  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html?welcome=1') });
  }
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'tw-options') chrome.runtime.openOptionsPage();
  else chrome.tabs.create({ url: chrome.runtime.getURL('src/sidepanel/panel.html') });
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarms();
  await refreshBadge().catch(() => {});
});

chrome.notifications.onClicked.addListener((id) => {
  // 更新提醒直接跳到「设置 → 关于」，其余（价格预警）跳到盯盘面板
  if (id.startsWith('tw-update')) chrome.runtime.openOptionsPage();
  else if (id.startsWith('tw-')) chrome.tabs.create({ url: chrome.runtime.getURL('src/sidepanel/panel.html') });
});

// 首次执行（SW 冷启动）也确保闹钟存在
ensureAlarms().catch(() => {});
