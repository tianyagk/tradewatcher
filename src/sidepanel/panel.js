/**
 * 侧边栏外壳：行情条（含悬浮分时卡）+ 页签路由 + 刷新调度 + 抽屉挂载。
 * 具体页签内容见 views.js。
 */
import { h, mount, qs, toast, applyPrefs, watchSystemTheme } from '../ui/dom.js';
import * as api from '../ui/api.js';
import { openDrawer, closeDrawer, DRAWER_CSS } from '../ui/drawer.js';
import { sparkline, trendChart, palette } from '../ui/charts.js';
import { STRIP_ROWS, CORE_INDICES } from '../shared/model.js';
import { fmtAmt, fmtChg, fmtPct, fmtPrice, fmtVol, marketStatus, pctClass } from '../shared/format.js';
import { VIEWS } from './views.js';

const TABS = [
  { key: 'overview', label: '概览' },
  { key: 'watch', label: '自选' },
  { key: 'pos', label: '持仓' },
  { key: 'market', label: '大盘' },
  { key: 'boards', label: '板块' },
  { key: 'money', label: '资金' },
  { key: 'limit', label: '涨停' },
  { key: 'calendar', label: '日历' },
  { key: 'alerts', label: '预警' },
];

const state = {
  prefs: null,
  tab: 'overview',
  quotes: {},
  trends: new Map(),
  industry: {},
  watch: null,
  portfolio: null,
  breadth: null,
  collapsed: new Set(),
  qnodes: [],
  timer: null,
  tick: 0,
  busy: false,
  hover: null,
};

let modalMask = null;

/* ── 行情节点绑定（局部刷新，避免整表重建闪烁） ───────────────────────── */

function paintQuote(entry) {
  const q = state.quotes[entry.secid];
  const v = q ? q[entry.field] : null;
  entry.el.textContent = entry.fmt(v);
  const cls = ['tw-num'];
  if (entry.opts.strong) cls.push('tw-strong');
  if (entry.opts.colorize) {
    const basis = entry.field === 'price' ? (q?.pct ?? null) : v;
    cls.push(pctClass(basis, state.prefs?.redUp !== false));
  }
  entry.el.className = cls.join(' ');
}

function registerQuote(secid, field, fmt, opts = {}) {
  const el = h('span', { class: 'tw-num' });
  const entry = { el, secid, field, fmt, opts };
  state.qnodes.push(entry);
  paintQuote(entry);
  return el;
}

function patchQuotes() {
  for (const e of state.qnodes) paintQuote(e);
}

/* ── ctx ──────────────────────────────────────────────────────────────── */

const ctx = {
  state,
  body: null,
  get redUp() {
    return state.prefs?.redUp !== false;
  },
  registerQuote,
  patchQuotes,
  setStatus: (msg) => { const el = qs('#status'); if (el) el.textContent = msg; },
  go: (tab) => switchTab(tab),
  render: () => renderTab(),
  openDrawer: (secid) => openDrawer(secid, { redUp: state.prefs?.redUp !== false, onChanged: () => reloadData() }),
  openModal,
  closeModal,
};

function openModal(title, rows, opts = {}) {
  closeModal();
  const body = h('div', { class: 'tw-col' }, ...(Array.isArray(rows) ? rows : [rows]));
  modalMask = h(
    'div',
    { class: 'tw-modal-mask', onclick: (e) => e.target === modalMask && closeModal() },
    h('div', { class: 'tw-modal', style: { width: opts.width ?? 'min(560px, 94vw)' } },
      h('div', { class: 'tw-modal-h' }, h('span', { class: 'tw-1', text: title }), h('button', { class: 'tw-icon-btn', onclick: closeModal }, '✕')),
      h('div', { class: 'tw-modal-b' }, body),
    ),
  );
  document.body.append(modalMask);
}

function closeModal() {
  if (modalMask) {
    modalMask.remove();
    modalMask = null;
  }
}

/* ── 行情条 ───────────────────────────────────────────────────────────── */

function renderStrips() {
  const box = qs('#strips');
  mount(box);
  const order = Array.isArray(state.prefs.showStrip) && state.prefs.showStrip.length > 0 ? state.prefs.showStrip : STRIP_ROWS.map((r) => r.key);
  for (const key of order) {
    const row = STRIP_ROWS.find((r) => r.key === key);
    if (!row) continue;
    const collapsed = state.collapsed.has(row.key);
    const strip = h('div', { class: `pn-strip ${collapsed ? 'collapsed' : ''}` });
    strip.append(
      h('div', { class: 'pn-strip-h', onclick: () => {
        if (state.collapsed.has(row.key)) state.collapsed.delete(row.key);
        else state.collapsed.add(row.key);
        renderStrips();
      } }, h('span', { class: 'arrow' }, '▼'), h('span', { class: 't', text: row.label })),
    );
    const items = h('div', { class: 'pn-strip-items' });
    for (const it of row.items) items.append(stripQuote(it));
    strip.append(items);
    box.append(strip);
  }
}

function stripQuote(item) {
  const el = h('div', { class: 'pn-q' });
  el.append(
    h('div', { class: 'n', text: item.name }),
    h('div', { class: 'r' },
      registerQuote(item.secid, 'price', (v) => fmtPrice(v), { colorize: true, strong: true }),
      registerQuote(item.secid, 'pct', (v) => fmtPct(v), { colorize: true }),
    ),
  );
  el.onclick = () => ctx.openDrawer(item.secid);
  el.onmouseenter = () => showHoverCard(item, el);
  el.onmouseleave = hideHoverCard;
  return el;
}

/* ── 悬浮分时卡 ───────────────────────────────────────────────────────── */

async function showHoverCard(item, anchor) {
  hideHoverCard();
  const card = h('div', { class: 'pn-hover' });
  state.hover = card;
  document.body.append(card);

  const rect = anchor.getBoundingClientRect();
  const width = 276;
  const cardH = 186;
  let left = Math.min(window.innerWidth - width - 10, rect.left);
  if (left < 6) left = 6;
  card.style.left = `${left}px`;

  // 不要盖住页签栏：若下方落点会压到 tabs，就改放到 tabs 之下
  const tabsEl = qs('#tabs');
  const tabsBottom = tabsEl ? tabsEl.getBoundingClientRect().bottom : 0;
  let top = rect.bottom + 6;
  if (top < tabsBottom && top + cardH > tabsBottom - 33) top = tabsBottom + 4;
  top = Math.max(4, Math.min(window.innerHeight - cardH - 6, top));
  card.style.top = `${top}px`;

  const q = state.quotes[item.secid];
  const pc = pctClass(q?.pct, ctx.redUp);
  mount(card,
    h('div', { class: 'pn-hover-h' },
      h('span', { class: 'tw-strong', text: item.name }),
      h('span', { class: `tw-num ${pc}`, text: `${fmtPrice(q?.price)} ${fmtPct(q?.pct)}` }),
    ),
    h('div', { class: 'tw-hint tw-num' }, `开 ${fmtPrice(q?.open)} 高 ${fmtPrice(q?.high)} 低 ${fmtPrice(q?.low)} 昨 ${fmtPrice(q?.prev)}`),
    h('div', { class: 'tw-chart', style: { height: '112px', marginTop: '4px' } }),
    h('div', { class: 'tw-hint', style: { marginTop: '3px' } }, '加载分时…'),
  );
  const chartBox = card.querySelector('.tw-chart');
  const foot = card.querySelector('.tw-hint:last-of-type');
  try {
    let tr = state.trends.get(item.secid);
    if (!tr || Date.now() - tr.at > 90000) {
      const data = await api.trend(item.secid, 1);
      tr = { at: Date.now(), points: data?.points ?? [] };
      state.trends.set(item.secid, tr);
    }
    if (state.hover !== card) return;
    if (!tr.points || tr.points.length < 2) {
      mount(chartBox, h('div', { class: 'tw-hint tw-center', style: { paddingTop: '36px' }, text: '无当日分时（可能未开盘/停牌）' }));
    } else {
      const chart = trendChart(chartBox, { redUp: ctx.redUp, height: 108, showVolume: false });
      chart.update({ points: tr.points, prePrice: q?.prev ?? tr.points[0].price });
    }
    mount(foot, h('span', { text: `成交额 ${fmtAmt(q?.amount)} · ${q?.time ? new Date(q.time).toLocaleTimeString('zh-CN', { hour12: false }) : '延迟行情'}` }));
  } catch (error) {
    if (state.hover === card) mount(chartBox, h('div', { class: 'tw-hint tw-center', style: { paddingTop: '36px' }, text: '分时加载失败' }));
  }
}

function hideHoverCard() {
  if (state.hover) {
    state.hover.remove();
    state.hover = null;
  }
}

/* ── 页签 ─────────────────────────────────────────────────────────────── */

function renderTabs() {
  const nav = qs('#tabs');
  mount(nav);
  for (const t of TABS) nav.append(h('button', { class: `tw-tab ${state.tab === t.key ? 'on' : ''}`, onclick: () => switchTab(t.key) }, t.label));
}

async function switchTab(key) {
  state.tab = key;
  state.prefs.panelTab = key;
  api.prefs.set({ panelTab: key }).catch(() => {});
  renderTabs();
  await renderTab();
}

async function renderTab() {
  state.qnodes = [];
  const view = VIEWS[state.tab];
  if (!view) return;
  try {
    await view(ctx);
  } catch (error) {
    mount(ctx.body, h('div', { class: 'tw-empty', text: `页面加载失败：${error.message}` }));
  }
}

/* ── 刷新 ─────────────────────────────────────────────────────────────── */

function neededSecids() {
  const ids = new Set([...CORE_INDICES.map((i) => i.secid)]);
  for (const row of STRIP_ROWS) for (const it of row.items) ids.add(it.secid);
  const live = (state.watch?.items ?? []).filter((i) => !(state.watch?.groups ?? []).some((g) => g.id === i.groupId && g.archived));
  for (const i of live) ids.add(i.secid);
  for (const p of state.portfolio?.view?.positions ?? []) ids.add(p.secid);
  return [...ids];
}

async function refreshQuotes() {
  try {
    const ids = neededSecids();
    const q = await api.quotes(ids);
    Object.assign(state.quotes, q);
    patchQuotes();
    const got = ids.filter((id) => q[id] && q[id].price !== null && q[id].price !== undefined).length;
    state.stale = got === 0 && ids.length > 0;
    return true;
  } catch (error) {
    state.stale = true;
    ctx.setStatus(`刷新失败：${error.message}`);
    return false;
  }
}

async function reloadData() {
  const [w, p] = await Promise.all([api.watch.get().catch(() => null), api.portfolio.get().catch(() => null)]);
  if (w) state.watch = w;
  if (p) state.portfolio = p;
  await refreshQuotes();
  await renderTab();
}

function schedule() {
  clearInterval(state.timer);
  const sec = Math.max(3, Number(state.prefs?.refreshSec) || 10);
  let left = sec;
  state.timer = setInterval(async () => {
    left -= 1;
    const cd = qs('#countdown');
    if (cd) cd.textContent = `${left}s 后刷新`;
    if (left > 0) {
      tickClock();
      return;
    }
    left = sec;
    state.tick += 1;
    tickClock();
    if (state.busy) return;
    state.busy = true;
    try {
      await refreshQuotes();
      // 概览/大盘/资金等含衍生数据的页面按 60s 重算
      if ((state.tab === 'overview' || state.tab === 'market') && state.tick % Math.max(2, Math.round(60 / sec)) === 0) await renderTab();
      if (state.stale) ctx.setStatus('行情源暂不可用（可能被限流），已展示缓存值并自动重试…');
      else ctx.setStatus(`更新于 ${new Date().toLocaleTimeString('zh-CN')} · 延迟行情（非 L2）`);
    } finally {
      state.busy = false;
    }
  }, 1000);
}

function tickClock() {
  const st = marketStatus();
  const el = qs('#market');
  if (el) {
    el.textContent = `${st.label}${st.hint ? ` · ${st.hint}` : ''}`;
    el.className = `tw-chip ${st.open ? 'up' : ''}`;
  }
  const c = qs('#clock');
  if (c) c.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

/* ── 启动 ─────────────────────────────────────────────────────────────── */

function injectDrawerCss() {
  const style = document.createElement('style');
  style.textContent = DRAWER_CSS;
  document.head.append(style);
}

async function init() {
  injectDrawerCss();
  state.prefs = await api.prefs.get();
  applyPrefs(state.prefs);
  state.tab = state.prefs.panelTab && TABS.some((t) => t.key === state.prefs.panelTab) ? state.prefs.panelTab : 'overview';
  ctx.body = qs('#body');

  qs('#btn-refresh').onclick = async () => {
    state.tick = 0;
    await refreshQuotes();
    await renderTab();
    toast('已刷新');
  };
  qs('#btn-mask').onclick = async () => {
    state.prefs = await api.prefs.set({ maskMode: !state.prefs.maskMode });
    applyPrefs(state.prefs);
  };
  qs('#btn-theme').onclick = async () => {
    const next = state.prefs.theme === 'auto' ? 'light' : state.prefs.theme === 'light' ? 'dark' : 'auto';
    state.prefs = await api.prefs.set({ theme: next });
    applyPrefs(state.prefs);
    toast(`主题：${next === 'auto' ? '跟随系统' : next === 'light' ? '浅色' : '深色'}`);
  };
  qs('#btn-tab').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('src/sidepanel/panel.html') });
  qs('#btn-settings').onclick = () => chrome.runtime.openOptionsPage();
  watchSystemTheme(() => applyPrefs(state.prefs));

  // 外观偏好可能被设置页改动
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['tw:prefs']) {
      state.prefs = changes['tw:prefs'].newValue ?? state.prefs;
      applyPrefs(state.prefs);
      renderStrips();
      schedule();
    }
  });

  renderTabs();
  renderStrips();
  tickClock();

  await Promise.all([
    api.watch.get().then((w) => { state.watch = w; }).catch(() => {}),
    api.portfolio.get().then((p) => { state.portfolio = p; }).catch(() => {}),
    refreshQuotes(),
  ]);

  await renderTab();
  schedule();

  // 打开抽屉：URL 参数或弹窗传递
  const params = new URLSearchParams(location.search);
  const secid = params.get('secid');
  if (secid) {
    setTimeout(() => ctx.openDrawer(secid), 300);
  } else {
    chrome.storage.local.get('twPendingDrawer').then((r) => {
      if (r.twPendingDrawer) {
        chrome.storage.local.remove('twPendingDrawer');
        setTimeout(() => ctx.openDrawer(r.twPendingDrawer), 250);
      }
    });
  }
}

init().catch((error) => {
  mount(qs('#body'), h('div', { class: 'tw-empty', text: `初始化失败：${error.message}` }));
});

window.addEventListener('beforeunload', () => clearInterval(state.timer));
