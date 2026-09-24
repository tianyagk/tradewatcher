/**
 * 详情抽屉：固定信息头 + 分时/五日/多周期K线 + 资金流 + 快捷操作。
 * 侧边栏与弹窗共用（openDrawer(secid, { redUp, onChanged })）。
 */
import { h, mount, qs, toast, promptModal } from './dom.js';
import * as api from './api.js';
import { trendChart, klineChart } from './charts.js';
import { fmtAmt, fmtPct, fmtPrice, fmtVol, fmtInt, pctClass, esc, marketLabel } from '../shared/format.js';
import { KLT, RANGE_TABS } from '../shared/model.js';

const CHART_TABS = [
  { key: 'trend', label: '分时' },
  { key: 'trend5', label: '五日' },
  { key: '101', label: '日K' },
  { key: '102', label: '周K' },
  { key: '103', label: '月K' },
  { key: '104', label: '年K' },
];

let current = null;
let onChanged = null;

export function openDrawer(secid, opts = {}) {
  closeDrawer();
  const redUp = opts.redUp !== false;
  onChanged = opts.onChanged ?? null;

  const body = h('div', { class: 'tw-drawer-b tw-scroll' });
  const head = h('div', { class: 'tw-drawer-h' });
  const title = h('div', { class: 'tw-flex tw-gap8', style: { alignItems: 'baseline', minWidth: 0 } });
  const actions = h('div', { class: 'tw-flex tw-gap6' });
  head.append(h('div', { class: 'tw-1', style: { minWidth: 0 } }, title), actions);

  const panel = h('div', { class: 'tw-drawer' }, head, body);
  const mask = h('div', { class: 'tw-drawer-mask', onclick: (e) => e.target === mask && closeDrawer() });
  document.body.append(mask, panel);
  requestAnimationFrame(() => panel.classList.add('in'));

  const state = { secid, tab: 'trend', range: '3m', chart: null, detail: null, trades: [] };
  current = { close: () => closeDrawer(), state };

  /* ── 头部渲染 ── */
  function renderHead() {
    const d = state.detail;
    mount(title);
    mount(actions);
    if (!d) {
      title.append(h('span', { class: 'tw-strong', text: secid }));
      actions.append(h('span', { class: 'tw-spin' }));
      return;
    }
    title.append(
      h('span', { class: 'tw-strong', style: { fontSize: '15px' }, text: d.name }),
      h('span', { class: 'tw-code', text: d.code }),
      h('span', { class: 'tw-tag', text: marketLabel(d.secid) }),
    );
    const pc = pctClass(d.pct, redUp);
    actions.append(
      h('span', { class: `tw-num tw-strong ${pc}`, style: { fontSize: '17px' } }, fmtPrice(d.price, 3)),
      h('span', { class: `tw-num ${pc}` }, `${fmtPct(d.pct)} ${fmtPrice(d.chg)}`),
      h('button', { class: 'tw-icon-btn', title: '加入自选', onclick: addWatch }, '★'),
      h('button', { class: 'tw-icon-btn', title: '加入持仓', onclick: addPos }, '＋'),
      h('button', { class: 'tw-icon-btn', title: '设置预警', onclick: addAlert }, '🔔'),
      h('button', { class: 'tw-icon-btn', title: '关闭', onclick: closeDrawer }, '✕'),
    );
  }

  /* ── 关键信息 ── */
  function statGrid() {
    const d = state.detail;
    if (!d) return h('div');
    const cell = (label, value, cls = '') => h('div', { class: 'tw-drawer-stat' }, h('span', { class: 'tw-label', text: label }), h('span', { class: `tw-num ${cls}` }, value));
    return h(
      'div',
      { class: 'tw-drawer-grid' },
      cell('今开', fmtPrice(d.open, 3), pctClass(d.open !== null && d.prev !== null ? d.open - d.prev : null, redUp)),
      cell('昨收', fmtPrice(d.prev, 3)),
      cell('最高', fmtPrice(d.high, 3), pctClass(d.high !== null && d.prev !== null ? d.high - d.prev : null, redUp)),
      cell('最低', fmtPrice(d.low, 3), pctClass(d.low !== null && d.prev !== null ? d.low - d.prev : null, redUp)),
      cell('成交量', fmtVol(d.vol)),
      cell('成交额', fmtAmt(d.amount)),
      cell('换手率', d.turnover !== null ? `${d.turnover}%` : '—'),
      cell('量比', d.volumeRatio !== null ? String(d.volumeRatio) : '—'),
      d.pe !== null ? cell('市盈率', String(d.pe)) : null,
      d.pb !== null ? cell('市净率', String(d.pb)) : null,
      d.totalMv !== null ? cell('总市值', fmtAmt(d.totalMv)) : null,
      d.floatMv !== null ? cell('流通市值', fmtAmt(d.floatMv)) : null,
    );
  }

  /* ── 图表区 ── */
  function renderChart() {
    const tabBar = h('div', { class: 'tw-tabs', style: { border: 'none', background: 'transparent' } });
    for (const t of CHART_TABS) {
      tabBar.append(h('button', { class: `tw-tab ${state.tab === t.key ? 'on' : ''}`, onclick: () => switchTab(t.key) }, t.label));
    }
    const rangeBar = h('div', { class: 'tw-flex tw-gap6 tw-center', style: { padding: '2px 0 6px' } });
    const chartBox = h('div', { class: 'tw-chart', style: { minHeight: '300px' } });
    const foot = h('div', { class: 'tw-hint tw-center', style: { padding: '4px 0' } });

    if (state.tab === '101' || state.tab === '102' || state.tab === '103' || state.tab === '104') {
      for (const r of RANGE_TABS) {
        rangeBar.append(h('button', {
          class: `tw-btn xs ${state.range === r.key ? 'on' : ''}`,
          onclick: () => {
            state.range = r.key;
            renderBody();
          },
        }, r.label));
      }
    }

    // 先布局再画图（需要容器宽度）
    body.append(tabBar, rangeBar, chartBox, foot);
    requestAnimationFrame(async () => {
      try {
        if (state.chart) {
          state.chart.destroy();
          state.chart = null;
        }
        if (state.tab === 'trend' || state.tab === 'trend5') {
          const ndays = state.tab === 'trend5' ? 5 : 1;
          const t = await api.trend(state.secid, ndays);
          state.chart = trendChart(chartBox, { redUp, height: 230, markers: state.trades });
          state.chart.update(t);
          const days = t?.points ? new Set(t.points.map((x) => (x.label ?? '').slice(0, 10))).size : 0;
          const srcLabel = { tencent: '腾讯分时', eastmoney: '东财分时', sina: '新浪 5 分钟 K' }[t?.source] ?? '公开接口';
          foot.textContent =
            state.tab === 'trend5'
              ? days >= 2
                ? `五日视图 · ${days} 个交易日（${srcLabel}，午休/隔夜已折叠）`
                : '该标的无多日分时数据，已回退当日分时'
              : t?.staleAt
                ? `上游暂不可用，展示快照 ${new Date(t.staleAt).toLocaleTimeString('zh-CN')}`
                : '分时数据来自免费公开接口（延迟行情）';
        } else {
          const klt = Number(state.tab);
          const k = await api.kline(state.secid, klt, 0);
          state.chart = klineChart(chartBox, {
            redUp,
            height: 330,
            markers: state.trades,
            onRangeChange: () => {},
          });
          state.chart.update(k?.days ?? []);
          const days = RANGE_TABS.find((r) => r.key === state.range)?.days ?? 0;
          if (days > 0) state.chart.setRange(days);
          foot.textContent = k?.stale ? '上游不可用，展示本地缓存（可能非最新）' : '滚轮缩放 · 拖拽平移 · 主图 MA5/10/20/60 · 副图 VOL / MACD(12,26,9)';
        }
      } catch (error) {
        mount(foot, h('span', { class: 'tw-muted', text: `图表加载失败：${error.message}` }));
      }
    });
    return { tabBar, rangeBar, chartBox, foot };
  }

  async function switchTab(key) {
    state.tab = key;
    renderBody();
  }

  /* ── 资金流 ── */
  async function renderFlow(box) {
    try {
      const f = await api.moneyFlow(state.secid);
      if (!f) {
        box.append(h('div', { class: 'tw-hint', text: '暂无资金流数据' }));
        return;
      }
      const row = (label, v) =>
        h('div', { class: 'tw-kv' }, h('span', { class: 'tw-label', text: label }), h('span', { class: `tw-num ${pctClass(v, redUp)}` }, fmtAmt(v)));
      box.append(
        row('主力净额', f.main),
        row('超大单', f.super),
        row('大单', f.big),
        row('中单', f.mid),
        row('小单', f.small),
      );
      if (f.source === 'sina') {
        box.append(h('div', { class: 'tw-hint', style: { marginTop: '2px' }, text: `数据源：新浪 · ${f.lastLabel ?? ''}（日频口径，东财分时不可用时启用）` }));
      }
    } catch {
      box.append(h('div', { class: 'tw-hint', text: '资金流加载失败' }));
    }
  }

  /* ── 整体渲染 ── */
  function renderBody() {
    mount(body);
    body.append(statGrid(), h('div', { class: 'tw-divider' }));
    renderChart();
    const flowBox = h('div', { class: 'tw-card tw-col tw-gap4', style: { marginTop: '8px' } }, h('div', { class: 'tw-label tw-bold', text: '当日资金流' }));
    body.append(flowBox);
    renderFlow(flowBox);
    if (state.trades.length > 0) {
      body.append(
        h('div', { class: 'tw-hint', style: { marginTop: '8px' }, text: `K 线已标注本标的的 ${state.trades.length} 笔买卖点（B 买入 / S 卖出）` }),
      );
    }
  }

  /* ── 操作 ── */
  async function addWatch() {
    const d = state.detail;
    try {
      await api.watch.mutate({ op: 'addItem', secid: state.secid, symbolName: d?.name });
      toast('已加入自选');
      onChanged?.();
    } catch (error) {
      toast(error.message);
    }
  }

  async function addPos() {
    const d = state.detail;
    try {
      await api.portfolio.mutate({ op: 'addPos', secid: state.secid, symbolName: d?.name });
      toast('已加入持仓，请补充买卖流水');
      onChanged?.();
    } catch (error) {
      toast(error.message);
    }
  }

  async function addAlert() {
    const d = state.detail;
    const res = await promptModal({
      title: `设置预警 · ${d?.name ?? state.secid}`,
      fields: [
        { key: 'field', label: '监测字段', type: 'select', value: 'pct', options: [{ value: 'pct', label: '涨跌幅 %' }, { value: 'price', label: '现价' }] },
        { key: 'op', label: '条件', type: 'select', value: '>=', options: [{ value: '>=', label: '大于等于 ≥' }, { value: '<=', label: '小于等于 ≤' }] },
        { key: 'value', label: '阈值', type: 'number', value: 5, step: '0.01', required: true, hint: '如涨跌幅 5 表示 +5%' },
        { key: 'note', label: '备注（可选）', type: 'text', placeholder: '例如：冲高减仓' },
      ],
    });
    if (!res) return;
    await api.alerts.mutate({ op: 'add', alert: { secid: state.secid, name: d?.name ?? state.secid, ...res } });
    toast('预警已创建');
    chrome.runtime.sendMessage({ type: 'badge.refresh' }).catch(() => {});
  }

  renderHead();
  renderBody();

  /* ── 数据加载 ── */
  (async () => {
    try {
      const [d, t] = await Promise.all([api.detail(secid), api.trades(secid).catch(() => [])]);
      state.detail = d;
      state.trades = t ?? [];
      renderHead();
      renderBody();
    } catch (error) {
      mount(title, h('span', { class: 'tw-muted', text: `${secid} 详情加载失败：${error.message}` }));
    }
  })();

  const onKey = (e) => {
    if (e.key === 'Escape') closeDrawer();
  };
  document.addEventListener('keydown', onKey);
  panel._onKey = onKey;
  return current;
}

export function closeDrawer() {
  const panel = qs('.tw-drawer');
  const mask = qs('.tw-drawer-mask');
  if (panel?._onKey) document.removeEventListener('keydown', panel._onKey);
  if (panel) {
    panel.classList.remove('in');
    setTimeout(() => panel.remove(), 180);
  }
  if (mask) mask.remove();
  current = null;
}

/** 渲染抽屉样式（由各页面注入一次） */
export const DRAWER_CSS = `
.tw-drawer{position:fixed;top:0;right:0;bottom:0;width:min(560px,100%);background:var(--tw-panel);
  border-left:1px solid var(--tw-border);box-shadow:-8px 0 28px rgba(0,0,0,.14);z-index:8500;
  display:flex;flex-direction:column;transform:translateX(102%);transition:transform .18s ease-out}
.tw-drawer.in{transform:translateX(0)}
.tw-drawer-h{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--tw-border);flex-wrap:wrap}
.tw-drawer-b{padding:10px 12px 24px;overflow-y:auto;flex:1}
.tw-drawer-mask{position:fixed;inset:0;background:rgba(10,14,20,.28);z-index:8400}
.tw-drawer-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px 10px;padding:4px 0 8px}
.tw-drawer-stat{display:flex;flex-direction:column;gap:1px;font-size:12px}
@media (max-width:520px){.tw-drawer-grid{grid-template-columns:repeat(3,1fr)}}
`;
