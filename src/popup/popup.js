/** 弹窗：指数条 + 自选/持仓/大盘 三视图，点击行打开完整面板。 */
import { h, mount, qs, toast, applyPrefs, watchSystemTheme } from '../ui/dom.js';
import * as api from '../ui/api.js';
import { sparkline } from '../ui/charts.js';
import { CORE_INDICES } from '../shared/model.js';
import { fmtAmt, fmtInt, fmtPct, fmtPrice, marketStatus, pctClass } from '../shared/format.js';

const state = {
  prefs: null,
  tab: 'watch',
  quotes: {},
  trends: new Map(), // secid -> { at, points }
  watch: null,
  portfolio: null,
  breadth: null,
  limits: { zt: null, dt: null },
  windowId: null,
  timer: null,
  busy: false,
};

const TABS = [
  { key: 'watch', label: '自选' },
  { key: 'pos', label: '持仓' },
  { key: 'market', label: '大盘' },
];

/* ── 打开完整面板 ─────────────────────────────────────────────────────── */

function openPanel(secid) {
  if (secid) chrome.storage.local.set({ twPendingDrawer: secid });
  const fail = () => {
    const q = secid ? `?secid=${encodeURIComponent(secid)}` : '';
    chrome.tabs.create({ url: chrome.runtime.getURL('src/sidepanel/panel.html') + q });
    window.close();
  };
  if (state.windowId === null) return fail();
  chrome.sidePanel
    .open({ windowId: state.windowId })
    .then(() => window.close())
    .catch(fail);
}

/* ── 取数 ─────────────────────────────────────────────────────────────── */

async function loadTrends(secids) {
  if (!state.prefs?.sparkline) return;
  const now = Date.now();
  const need = secids.filter((s) => {
    const hit = state.trends.get(s);
    return !hit || now - hit.at > 60000;
  });
  if (need.length === 0) return;
  const results = await Promise.allSettled(need.slice(0, 10).map((s) => api.trend(s, 1)));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value?.points?.length > 1) state.trends.set(need[i], { at: now, points: r.value.points });
  });
}

async function refresh() {
  if (state.busy) return;
  state.busy = true;
  try {
    const [strip, breadth] = await Promise.all([api.quotes(CORE_INDICES.map((i) => i.secid)), api.breadth().catch(() => null)]);
    state.quotes = strip;
    state.breadth = breadth;
    if (state.tab === 'watch') {
      state.watch = await api.watch.get();
      const ids = liveWatchItems().map((i) => i.secid);
      if (ids.length > 0) Object.assign(state.quotes, await api.quotes(ids));
      await loadTrends(ids);
    } else if (state.tab === 'pos') {
      state.portfolio = await api.portfolio.get();
    } else {
      const [zt, dt] = await Promise.all([api.limitPool('zt').catch(() => null), api.limitPool('dt').catch(() => null)]);
      state.limits = { zt, dt };
    }
    renderStrip();
    renderBody();
    const ids = CORE_INDICES.map((i) => i.secid);
    const got = ids.filter((id) => state.quotes[id] && state.quotes[id].price !== null).length;
    qs('#status').textContent =
      got === 0
        ? '行情源暂不可用（可能被限流），自动重试中…'
        : `更新于 ${new Date().toLocaleTimeString('zh-CN')} · 延迟行情`;
  } catch (error) {
    qs('#status').textContent = `刷新失败：${error.message}`;
  } finally {
    state.busy = false;
  }
}

function liveWatchItems() {
  if (!state.watch) return [];
  const archived = new Set(state.watch.groups.filter((g) => g.archived).map((g) => g.id));
  return state.watch.items.filter((i) => !archived.has(i.groupId));
}

/* ── 渲染 ─────────────────────────────────────────────────────────────── */

function renderStrip() {
  const box = qs('#strip');
  mount(box);
  for (const idx of CORE_INDICES) {
    const q = state.quotes[idx.secid];
    const pc = pctClass(q?.pct, state.prefs.redUp);
    box.append(
      h(
        'div',
        { class: 'pp-idx', onclick: () => openPanel(idx.secid), title: idx.name },
        h('div', { class: 'n', text: idx.name }),
        h('div', { class: `v ${pc}` }, fmtPrice(q?.price)),
        h('div', { class: `p ${pc}` }, fmtPct(q?.pct)),
      ),
    );
  }
}

function renderTabs() {
  const nav = qs('#tabs');
  mount(nav);
  for (const t of TABS) {
    nav.append(h('button', { class: `tw-tab ${state.tab === t.key ? 'on' : ''}`, onclick: () => switchTab(t.key) }, t.label));
  }
}

async function switchTab(key) {
  state.tab = key;
  renderTabs();
  mount(qs('#body'), h('div', { class: 'tw-loading' }, h('span', { class: 'tw-spin' }), ' 加载中…'));
  await refresh();
}

function row(q, name, onClick) {
  const pc = pctClass(q?.pct, state.prefs.redUp);
  const tr = state.trends.get(q?.secid);
  const sparkBox = h('div', { class: 'spark' });
  if (tr?.points?.length > 1) sparkBox.append(sparkline(tr.points, { redUp: state.prefs.redUp, width: 78, height: 20 }));
  return h(
    'div',
    { class: 'pp-row', onclick: onClick },
    h('div', { class: 'nm' }, h('b', { text: name ?? q?.name ?? '—' }), h('span', { class: 'tw-code', text: q?.code ?? '' })),
    sparkBox,
    h('div', { class: `px ${pc}` }, fmtPrice(q?.price)),
    h('div', { class: `pc ${pc}` }, fmtPct(q?.pct)),
  );
}

function renderBody() {
  const box = qs('#body');
  mount(box);
  if (state.tab === 'watch') return renderWatch(box);
  if (state.tab === 'pos') return renderPos(box);
  return renderMarket(box);
}

function renderWatch(box) {
  const items = liveWatchItems();
  if (items.length === 0) {
    box.append(h('div', { class: 'tw-empty', text: '自选为空。点击下方「完整面板」搜索并添加标的。' }));
    return;
  }
  for (const it of items) {
    const q = state.quotes[it.secid] ?? { secid: it.secid, name: it.name };
    box.append(row(q, it.name, () => openPanel(it.secid)));
  }
  box.append(h('div', { style: { padding: '8px 10px' } }, h('button', { class: 'tw-btn sm tw-1', onclick: () => openPanel() }, '管理自选 / 添加标的')));
}

function renderPos(box) {
  const view = state.portfolio?.view;
  if (!view) {
    box.append(h('div', { class: 'tw-empty', text: '暂无持仓数据' }));
    return;
  }
  const g = view.grand;
  const base = g.totalMv - g.dayPnl;
  const dayPct = base > 0 ? (g.dayPnl / base) * 100 : null;
  const costBase = g.cost;
  const floatPct = costBase > 0 ? (g.floatPnl / costBase) * 100 : null;
  box.append(
    h(
      'div',
      { class: 'pp-sec' },
      h('div', { class: 'pp-sec-h' }, h('span', { text: '账户总览' }), h('span', { class: 'tw-hint', text: `${view.positions.length} 只持仓` })),
      h(
        'div',
        { class: 'pp-kpis' },
        kpi('总市值', fmtAmt(g.totalMv)),
        kpi('当日盈亏', fmtAmt(g.dayPnl), pctClass(dayPct, state.prefs.redUp), dayPct),
        kpi('浮动盈亏', fmtAmt(g.floatPnl), pctClass(floatPct, state.prefs.redUp), floatPct),
      ),
      h(
        'div',
        { class: 'pp-kpis', style: { marginTop: '6px' } },
        kpi('累计已实现', fmtAmt(g.realized)),
        kpi('持仓市值成本', fmtAmt(costBase)),
        kpi('持仓只数', String(view.positions.length)),
      ),
    ),
  );
  if (view.positions.length === 0) {
    box.append(h('div', { class: 'tw-empty', text: '还没有持仓，点击「完整面板」→ 持仓 添加并录入买卖流水。' }));
    return;
  }
  for (const p of view.positions) {
    const q = { secid: p.secid, code: p.secid.split('.')[1], price: p.price, pct: p.pct };
    const pc = pctClass(p.dayPnlPct, state.prefs.redUp);
    box.append(
      h(
        'div',
        { class: 'pp-row', onclick: () => openPanel(p.secid) },
        h('div', { class: 'nm' }, h('b', { text: p.name }), h('span', { class: 'tw-code', text: `${p.qty} 股 · 成本 ${fmtPrice(p.avgCost, 3)}` })),
        h('div', { class: 'tw-num', style: { textAlign: 'right' } }, fmtPrice(p.price)),
        h('div', { class: `px ${pc}` }, fmtAmt(p.dayPnl)),
        h('div', { class: `pc ${pc}` }, p.dayPnlPct === null ? '—' : fmtPct(p.dayPnlPct)),
      ),
    );
  }
}

function kpi(label, value, cls = '', pct = null) {
  return h(
    'div',
    { class: 'pp-kpi' },
    h('div', { class: 'l', text: label }),
    h('div', { class: `v ${cls}` }, value),
    pct !== null && pct !== undefined ? h('div', { class: `tw-hint ${cls} tw-num` }, fmtPct(pct)) : null,
  );
}

function renderMarket(box) {
  const b = state.breadth;
  const zt = state.limits.zt?.total ?? null;
  const dt = state.limits.dt?.total ?? null;
  box.append(
    h(
      'div',
      { class: 'pp-sec' },
      h('div', { class: 'pp-sec-h' }, h('span', { text: '市场情绪' }), h('span', { class: 'tw-hint', text: b?.available ? '沪深两市' : '涨跌家数暂不可得' })),
      b?.available
        ? h(
            'div',
            { class: 'pp-breadth' },
            h('div', { style: { flex: String(Math.max(1, b.up)), background: 'var(--tw-up-ink)' }, text: `涨 ${b.up}` }),
            h('div', { style: { flex: '0 0 34px', background: 'var(--tw-flat-ink)' }, text: `${b.even}` }),
            h('div', { style: { flex: String(Math.max(1, b.down)), background: 'var(--tw-down-ink)' }, text: `跌 ${b.down}` }),
          )
        : h('div', { class: 'tw-hint', text: '上游暂未返回涨跌家数，稍后自动重试。' }),
      h(
        'div',
        { class: 'pp-kpis', style: { marginTop: '8px' } },
        kpi('涨停家数', zt === null ? '—' : String(zt), zt === null ? '' : 'tw-up'),
        kpi('跌停家数', dt === null ? '—' : String(dt), dt === null ? '' : 'tw-down'),
        kpi('两市成交额', fmtAmt(b?.amount ?? null)),
      ),
    ),
  );
  box.append(
    h(
      'div',
      { class: 'pp-sec' },
      h('div', { class: 'pp-sec-h' }, h('span', { text: '核心指数' })),
      h(
        'div',
        { class: 'pp-kpis' },
        ...CORE_INDICES.slice(0, 6).map((idx) => {
          const q = state.quotes[idx.secid];
          const pc = pctClass(q?.pct, state.prefs.redUp);
          return h('div', { class: 'pp-kpi', style: { cursor: 'pointer' }, onclick: () => openPanel(idx.secid) }, h('div', { class: 'l', text: idx.name }), h('div', { class: `v ${pc}` }, fmtPct(q?.pct)), h('div', { class: `tw-hint tw-num ${pc}` }, fmtPrice(q?.price)));
        }),
      ),
    ),
  );
  box.append(
    h('div', { style: { padding: '10px' } }, h('button', { class: 'tw-btn sm tw-1', onclick: () => openPanel() }, '打开完整面板（板块 / 资金 / 涨停 / 日历 / 预警）')),
  );
}

/* ── 启动 ─────────────────────────────────────────────────────────────── */

function tickClock() {
  const st = marketStatus();
  const el = qs('#market');
  el.textContent = `${st.label}${st.hint ? ` · ${st.hint}` : ''}`;
  el.className = `tw-chip ${st.open ? 'up' : ''}`;
  qs('#clock').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function schedule() {
  clearInterval(state.timer);
  const sec = Math.max(3, Number(state.prefs?.refreshSec) || 10);
  state.timer = setInterval(() => {
    tickClock();
    refresh();
  }, sec * 1000);
}

async function init() {
  state.prefs = await api.prefs.get();
  applyPrefs(state.prefs);
  chrome.windows.getCurrent().then((w) => { state.windowId = w.id; }).catch(() => {});
  chrome.storage.local.get('twPendingDrawer').then((r) => {
    if (r.twPendingDrawer) {
      chrome.storage.local.remove('twPendingDrawer');
      openPanel(r.twPendingDrawer);
    }
  });
  qs('#btn-refresh').onclick = () => refresh();
  qs('#btn-panel').onclick = () => openPanel();
  qs('#btn-full').onclick = () => openPanel();
  qs('#btn-cloud').onclick = () => chrome.tabs.create({ url: state.prefs.cloudMapUrl || 'https://52etf.site/' });
  qs('#btn-settings').onclick = () => { chrome.runtime.openOptionsPage(); window.close(); };
  watchSystemTheme(() => applyPrefs(state.prefs));

  renderTabs();
  tickClock();
  await refresh();
  schedule();
}

init().catch((error) => {
  mount(qs('#body'), h('div', { class: 'tw-empty', text: `初始化失败：${error.message}` }));
});
