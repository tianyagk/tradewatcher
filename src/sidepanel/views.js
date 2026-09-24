/**
 * 侧边栏各页签视图。每个 render 函数负责取数 + 渲染，通过 ctx 与外壳通信。
 * ctx: { state, body, redUp, setStatus, reschedule, render, openDrawer, registerQuote, patchQuotes }
 */
import { h, mount, toast, promptModal, confirmModal } from '../ui/dom.js';
import * as api from '../ui/api.js';
import { sparkline, distributionChart, marginChart, breadthChart } from '../ui/charts.js';
import {
  fmtAmt, fmtAmtLike, fmtChg, fmtDate, fmtInt, fmtPct, fmtPrice, marketLabel,
  pctClass, secidSplit,
} from '../shared/format.js';
import { ALERT_FIELD_LABEL, BOARD_SCOPES, CAL_CATEGORY_LABEL } from '../shared/model.js';

/* ── 通用小组件 ───────────────────────────────────────────────────────── */

export function kpi(label, value, cls = '', onClick = null, sub = null) {
  const el = h(
    'div',
    { class: `pn-kpi ${onClick ? 'clickable' : ''}` },
    h('div', { class: 'l', text: label }),
    h('div', { class: `v ${cls}` }, value),
    sub ? h('div', { class: `tw-hint ${cls} tw-num`, text: sub }) : null,
  );
  if (onClick) el.onclick = onClick;
  return el;
}

function secHeader(title, ...right) {
  return h('div', { class: 'pn-sec-h' }, h('span', { class: 't', text: title }), h('span', { class: 'tw-flex tw-gap6' }, ...right));
}

/** 带行业/alpha 的自选行（两行布局） */
function watchRow(ctx, item) {
  const q = ctx.state.quotes[item.secid] ?? { secid: item.secid, name: item.name };
  const ind = ctx.state.industry?.[item.secid];
  const alpha = q.pct !== null && q.pct !== undefined && ind?.pct !== null && ind?.pct !== undefined ? q.pct - ind.pct : null;
  const pc = pctClass(q.pct, ctx.redUp);

  const nameBox = h(
    'div',
    { style: { minWidth: 0 } },
    h('div', { class: 'tw-flex tw-gap4', style: { alignItems: 'baseline', minWidth: 0 } },
      h('b', { class: 'tw-ellipsis', style: { fontSize: '12.5px' }, text: item.name || q.name || item.secid }),
      h('span', { class: 'pn-code', text: secidSplit(item.secid).code }),
    ),
    h('div', { class: 'tw-flex tw-gap4', style: { alignItems: 'center', marginTop: '1px' } },
      ind ? h('span', { class: 'tw-tag', text: ind.name }) : null,
      ind && ind.pct !== null ? h('span', { class: `tw-num ${pctClass(ind.pct, ctx.redUp)}`, style: { fontSize: '10.5px' } }, fmtPct(ind.pct)) : null,
      alpha !== null ? h('span', { class: `pn-alpha ${pctClass(alpha, ctx.redUp)}`, title: '个股相对所属行业板块的超额（alpha）' }, `α${fmtPct(alpha)}`) : null,
    ),
  );

  const sparkBox = h('div', { style: { height: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center' } });
  const tr = ctx.state.trends?.get(item.secid);
  if (ctx.state.prefs.sparkline && tr?.points?.length > 1) sparkBox.append(sparkline(tr.points, { redUp: ctx.redUp, width: 70, height: 22 }));

  const px = ctx.registerQuote(item.secid, 'price', (v) => fmtPrice(v));
  const pctEl = ctx.registerQuote(item.secid, 'pct', (v) => fmtPct(v), { colorize: true, strong: true });

  const row = h(
    'div',
    { class: 'pn-list-row w-watch' },
    nameBox,
    sparkBox,
    h('div', { class: 'tw-right tw-num' }, px),
    h('div', { class: 'tw-right' }, pctEl),
    h('div', { class: 'tw-right' }, ctx.registerQuote(item.secid, 'chg', (v) => fmtChg(v), { colorize: true })),
  );
  row.onclick = () => ctx.openDrawer(item.secid);
  return row;
}

/* ── 概览 ─────────────────────────────────────────────────────────────── */

/**
 * 概览 · 涨跌分布模块（宏观）。
 *
 * 两栏布局（窄侧边栏下由容器查询自动堆叠为单栏）：
 *   左栏 —— 涨跌趋势（上涨/平盘/下跌 + 涨停/跌停）、成交量、两融走势
 *   右栏 —— 全市场涨跌幅 11 档分布柱状图、上涨下跌家数分时
 *
 * 抽成独立函数便于在预览页复用同一份渲染逻辑。
 */
export function distributionSection(ctx, { breadth, zt, zb, dt, dist, turn, margin, bseries } = {}) {
  const up = dist?.up ?? breadth?.up ?? null;
  const down = dist?.down ?? breadth?.down ?? null;
  const flat = dist?.flat ?? breadth?.even ?? null;

  const sec = h('div', { class: 'pn-sec pn-ov' });
  sec.append(secHeader(
    '涨跌分布',
    h('span', { class: 'tw-hint', text: dist
      ? `全市场 ${fmtInt(dist.total)} 只${dist.source === 'sina' ? ' · 新浪兜底' : ''}`
      : breadth?.available ? '沪深两市' : '涨跌家数暂缺' }),
  ));

  const left = h('div', { class: 'pn-ov-col' });
  const right = h('div', { class: 'pn-ov-col' });

  /* ── 左栏 ①：涨跌趋势（单行 5 项） ── */
  left.append(h('div', { class: 'tw-label', text: '涨跌趋势' }));
  left.append(h('div', { class: 'pn-grid5', style: { marginTop: '4px' } },
    kpi('上涨', up === null ? '—' : fmtInt(up), pctClass(1, ctx.redUp)),
    kpi('平盘', flat === null ? '—' : fmtInt(flat), ''),
    kpi('下跌', down === null ? '—' : fmtInt(down), pctClass(-1, ctx.redUp)),
    kpi('涨停', String(zt?.total ?? '—'), pctClass(1, ctx.redUp)),
    kpi('跌停', String(dt?.total ?? '—'), pctClass(-1, ctx.redUp)),
  ));
  if (up !== null && down !== null) {
    left.append(h('div', { class: 'pn-breadth', style: { marginTop: '6px' } },
      h('div', { style: { flex: String(Math.max(1, up)), background: 'var(--tw-up-ink)' }, text: String(up) }),
      h('div', { style: { flex: '0 0 32px', background: 'var(--tw-flat-ink)' }, text: String(flat ?? 0) }),
      h('div', { style: { flex: String(Math.max(1, down)), background: 'var(--tw-down-ink)' }, text: String(down) }),
    ));
  } else {
    left.append(h('div', { class: 'tw-hint', style: { marginTop: '6px' }, text: '涨跌家数需行情主机返回统计字段，限流时短暂缺失，稍后自动重试。' }));
  }
  if (zb?.total && zt?.total) {
    left.append(h('div', { class: 'tw-hint', style: { marginTop: '3px' }, text: `炸板 ${zb.total} 只 · 炸板率 ${((zb.total / (zt.total + zb.total)) * 100).toFixed(0)}%` }));
  }

  /* ── 左栏 ②：成交量 ── */
  if (turn) {
    const prog = Number.isFinite(turn.progress) ? turn.progress : 1;
    const forecast = prog > 0.02 && prog < 0.995 ? turn.today / prog : turn.today;
    left.append(h('div', { class: 'tw-label', style: { marginTop: '10px' }, text: '成交量' }));
    left.append(h('div', { class: 'pn-grid2', style: { marginTop: '4px' } },
      kpi('当日成交额', fmtAmt(turn.today)),
      // 变动/前值刻意跟随当日成交额的单位，避免「1.65万亿」与「-1116.19亿」并排难以比较
      kpi('昨日成交', fmtAmt(turn.prev), '', null, turn.prevDate ? `较前日 ${fmtAmtLike(turn.change, turn.today)}` : null),
      kpi('较昨日变动', fmtAmtLike(turn.change, turn.today), pctClass(turn.change, ctx.redUp), null, turn.changePct !== null && turn.changePct !== undefined ? fmtPct(turn.changePct) : null),
      kpi('预测全天', fmtAmt(forecast), '', null, prog < 0.995 ? `已走 ${(prog * 100).toFixed(0)}%` : '已收盘'),
    ));
  }

  /* ── 左栏 ③：两融走势 ── */
  left.append(h('div', { class: 'tw-label', style: { marginTop: '10px' }, text: '两融走势' }));
  if (margin?.series?.length > 1) {
    const latest = margin.latest;
    left.append(h('div', { class: 'tw-hint tw-num', style: { marginTop: '2px' } },
      `最新两融余额 ${fmtAmt(latest?.balance)}（${latest?.date ?? ''}）`,
      Number.isFinite(margin.balanceChange) ? ` · 区间 ${fmtAmtLike(margin.balanceChange, latest?.balance)}` : '',
      Number.isFinite(margin.indexChangePct) ? ` · ${margin.indexName} ${fmtPct(margin.indexChangePct)}` : '',
    ));
    const mBox = h('div', { class: 'tw-dist' });
    left.append(mBox);
    marginChart(mBox, { series: margin.series, indexName: margin.indexName, redUp: ctx.redUp, height: 148 });
  } else {
    left.append(h('div', { class: 'tw-hint', style: { marginTop: '3px' }, text: '两融数据源（东财数据中心）暂不可达，稍后自动重试。' }));
  }

  /* ── 右栏 ①：涨跌幅分布柱状图 ── */
  right.append(h('div', { class: 'tw-label', text: '涨跌幅分布' }));
  if (dist?.bins?.length) {
    const chartBox = h('div', { class: 'tw-dist' });
    right.append(chartBox);
    distributionChart(chartBox, { bins: dist.bins, redUp: ctx.redUp, height: 150 });
  } else {
    right.append(h('div', { class: 'tw-hint', style: { marginTop: '4px' }, text: '涨跌幅分布需要全市场快照：东财 push2 与新浪兜底都未取到时才会跳过，稍后自动重试。' }));
  }

  /* ── 右栏 ②：上涨下跌家数分时 ── */
  right.append(h('div', { class: 'tw-label', style: { marginTop: '10px' } },
    '上涨下跌家数分时',
    bseries?.prevDate ? h('span', { class: 'tw-hint', style: { marginLeft: '6px' } }, `对照 ${bseries.prevDate}`) : null,
  ));
  const bBox = h('div', { class: 'tw-dist' });
  right.append(bBox);
  breadthChart(bBox, {
    points: bseries?.points ?? [],
    prevPoints: bseries?.prevPoints ?? [],
    prevDate: bseries?.prevDate ?? null,
    height: 150,
  });

  sec.append(h('div', { class: 'pn-ov-2col' }, left, right));
  return sec;
}

export async function renderOverview(ctx) {
  const box = ctx.body;
  mount(box, h('div', { class: 'tw-loading' }, h('span', { class: 'tw-spin' }), ' 加载中…'));
  const st = ctx.state;
  const [breadth, zt, zb, dt, distData, turn, margin, bseries, boardRank, port] = await Promise.all([
    api.breadth().catch(() => null),
    api.limitPool('zt').catch(() => null),
    api.limitPool('zb').catch(() => null),
    api.limitPool('dt').catch(() => null),
    api.distribution().catch(() => null),
    api.turnover().catch(() => null),
    api.margin().catch(() => null),
    api.breadthSeries().catch(() => null),
    api.boards('industry', 'pct', 1, 8).catch(() => null),
    api.portfolio.get().catch(() => null),
  ]);
  st.breadth = breadth;
  st.portfolio = port ?? st.portfolio;

  mount(box);

  // 涨跌分布（宏观）：左栏 涨跌趋势 / 成交量 / 两融走势，右栏 涨跌幅分布 / 涨跌家数分时
  box.append(distributionSection(ctx, { breadth, zt, zb, dt, dist: distData, turn, margin, bseries }));

  // 持仓汇总
  const v = port?.view;
  if (v) {
    const g = v.grand;
    const base = g.totalMv - g.dayPnl;
    const dayPct = base > 0 ? (g.dayPnl / base) * 100 : null;
    const floatPct = g.cost > 0 ? (g.floatPnl / g.cost) * 100 : null;
    box.append(
      h('div', { class: 'pn-sec' },
        secHeader('持仓概览', h('button', { class: 'tw-btn xs', onclick: () => ctx.go('pos') }, '查看全部')),
        h('div', { class: 'pn-grid2' },
          kpi('总市值', fmtAmt(g.totalMv)),
          kpi('当日盈亏', fmtAmt(g.dayPnl), pctClass(dayPct, ctx.redUp), null, dayPct !== null ? fmtPct(dayPct) : null),
          kpi('浮动盈亏', fmtAmt(g.floatPnl), pctClass(floatPct, ctx.redUp), null, floatPct !== null ? fmtPct(floatPct) : null),
          kpi('累计已实现', fmtAmt(g.realized), pctClass(g.realized, ctx.redUp)),
        ),
      ),
    );
  }

  // 板块
  const boards = boardRank?.rows ?? [];
  if (boards.length > 0) {
    const asc = [...boards].sort((a, b) => (a.pct ?? 0) - (b.pct ?? 0));
    box.append(
      h('div', { class: 'pn-sec' },
        secHeader('行业板块', h('button', { class: 'tw-btn xs', onclick: () => ctx.go('boards') }, '排行榜')),
        h('div', { class: 'pn-grid2' },
          h('div', {},
            h('div', { class: 'tw-label', text: '领涨' }),
            ...boards.slice(0, 4).map((b) => boardMini(ctx, b)),
          ),
          h('div', {},
            h('div', { class: 'tw-label', text: '领跌' }),
            ...asc.slice(0, 4).map((b) => boardMini(ctx, b)),
          ),
        ),
      ),
    );
  }

  // 大盘云图（原「大盘」页签内容，改为概览底部折叠区，默认收起不占首屏）
  box.append(cloudSection(ctx));

  ctx.patchQuotes();
}

/** 大盘云图 · A股热力图（折叠，默认收起。若设置里把 cloudMapUrl 清空则整体隐藏） */
function cloudSection(ctx) {
  const st = ctx.state;
  const url = st.prefs?.cloudMapUrl || 'https://52etf.site/';
  const sec = h('div', { class: 'pn-sec' });
  // pn-cloud 是必须的：.pn-cloud iframe 那条样式控制宽高，漏了这个类 iframe 会退回
  // 浏览器默认的 300×150，外部站点按桌面布局渲染再被压进小框 → 内容互相叠压。
  const body = h('div', { class: 'pn-fold-body pn-cloud', style: { display: 'none' } });
  const caret = h('span', { class: 'arrow', style: { display: 'inline-block', transition: 'transform .15s' }, text: '▶' });
  const head = h('div', { class: 'pn-fold-h' },
    caret,
    h('span', { class: 't', text: '大盘云图 · A股热力图' }),
    h('span', { class: 'tw-hint', text: '面积=流通市值 · 颜色=涨跌幅' }),
  );
  let on = false;
  let loaded = false;
  head.onclick = () => {
    on = !on;
    caret.style.transform = on ? 'rotate(90deg)' : '';
    body.style.display = on ? '' : 'none';
    if (on && !loaded) {
      loaded = true;
      const iframe = h('iframe', { src: url, title: '大盘云图', sandbox: 'allow-scripts allow-same-origin allow-popups allow-forms', allow: 'clipboard-write' });
      body.append(iframe);
    }
  };
  sec.append(
    head,
    h('div', { class: 'tw-hint', style: { marginTop: '3px' } },
      '热力图由 ', h('a', { href: url, target: '_blank', rel: 'noreferrer' }, url.replace(/^https?:\/\//, '').replace(/\/$/, '')), ' 提供，约 8 秒刷新；展开后滚轮缩放、双击看K线。'),
    body,
  );
  return sec;
}

function boardMini(ctx, b) {
  return h(
    'div',
    { class: 'tw-flex', style: { justifyContent: 'space-between', gap: '6px', padding: '2px 0', cursor: 'pointer' }, onclick: () => ctx.go('boards') },
    h('span', { class: 'tw-ellipsis', style: { fontSize: '12px' }, text: b.name }),
    h('span', { class: `tw-num ${pctClass(b.pct, ctx.redUp)}`, style: { fontSize: '12px' } }, fmtPct(b.pct)),
  );
}

/* ── 自选 ─────────────────────────────────────────────────────────────── */
export async function renderWatch(ctx) {
  const st = ctx.state;
  if (!st.watch) st.watch = await api.watch.get();
  const w = st.watch;
  const groups = w.groups.filter((g) => !g.archived);
  if (!st.watchGroupId || !groups.some((g) => g.id === st.watchGroupId)) st.watchGroupId = groups[0]?.id ?? null;

  const box = ctx.body;
  mount(box);

  const toolbar = h('div', { class: 'pn-toolbar' });
  const tabBox = h('div', { class: 'tw-flex tw-gap4', style: { flexWrap: 'wrap' } });
  for (const g of groups) {
    tabBox.append(h('button', { class: `tw-pill ${st.watchGroupId === g.id ? 'on' : ''}`, onclick: () => { st.watchGroupId = g.id; ctx.render(); } }, `${g.name} ${w.items.filter((i) => i.groupId === g.id).length}`));
  }
  toolbar.append(
    tabBox,
    h('button', { class: 'tw-btn xs', onclick: () => addWatchGroup(ctx) }, '＋分组'),
    h('button', { class: 'tw-btn xs primary', onclick: () => addWatchItem(ctx) }, '＋标的'),
    h('button', { class: 'tw-btn xs', onclick: () => manageGroups(ctx, 'watch') }, '管理'),
  );
  box.append(toolbar);

  const items = w.items.filter((i) => i.groupId === st.watchGroupId);
  if (items.length === 0) {
    box.append(h('div', { class: 'tw-empty', text: '该分组还没有标的，点击「＋标的」搜索添加（支持 A股/港股/美股/ETF/指数/期货）。' }));
    return;
  }

  // 先补全行业归属与缩略分时（带缓存，避免重复请求形成循环）
  const secids = items.map((i) => i.secid);
  await Promise.all([hydrateIndustry(ctx, secids), loadTrends(ctx, secids)]);

  box.append(
    h('div', { class: 'pn-list-row head w-watch' },
      h('span', {}, '名称 / 行业'), h('span', { class: 'tw-center' }, '分时'), h('span', { class: 'tw-right' }, '现价'), h('span', { class: 'tw-right' }, '涨跌幅'), h('span', { class: 'tw-right' }, '涨跌额'),
    ),
  );
  for (const it of items) box.append(watchRow(ctx, it));
  ctx.patchQuotes();
}

/** 补全 A股 自选标的的行业归属与板块涨幅（只补缺失项，10 分钟缓存） */
async function hydrateIndustry(ctx, secids) {
  const st = ctx.state;
  st.industry = st.industry ?? {};
  const need = secids.filter((s) => st.industry[s] === undefined);
  if (need.length === 0) return;
  try {
    const map = await api.industryMap(need.slice(0, 60));
    for (const s of need) st.industry[s] = map[s] ?? null;
  } catch {
    for (const s of need) st.industry[s] = null;
  }
}

async function loadTrends(ctx, secids) {
  if (!ctx.state.prefs.sparkline) return;
  ctx.state.trends = ctx.state.trends ?? new Map();
  const now = Date.now();
  const need = secids.filter((s) => {
    const hit = ctx.state.trends.get(s);
    return !hit || now - hit.at > 90000;
  });
  if (need.length === 0) return;
  const res = await Promise.allSettled(need.slice(0, 24).map((s) => api.trend(s, 1)));
  res.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value?.points?.length > 1) ctx.state.trends.set(need[i], { at: now, points: r.value.points });
  });
}

async function addWatchGroup(ctx) {
  const res = await promptModal({ title: '新建自选分组', fields: [{ key: 'name', label: '分组名称', value: '新分组' }] });
  if (!res) return;
  ctx.state.watch = await api.watch.mutate({ op: 'addGroup', name: res.name });
  ctx.render();
}

async function addWatchItem(ctx) {
  const picked = await pickSymbol(ctx, '添加自选');
  if (!picked) return;
  try {
    ctx.state.watch = await api.watch.mutate({ op: 'addItem', secid: picked.secid, symbolName: picked.name, groupId: ctx.state.watchGroupId });
    toast(`已添加 ${picked.name}`);
    ctx.state.quotes[picked.secid] = { secid: picked.secid, name: picked.name, code: picked.code };
    await api.quotes([picked.secid]).then((r) => Object.assign(ctx.state.quotes, r));
    ctx.render();
  } catch (error) {
    toast(error.message);
  }
}

/** 标的搜索选择器 */
export function pickSymbol(ctx, title) {
  return new Promise((resolve) => {
    let timer = null;
    const results = h('div', { class: 'tw-col' });
    const input = h('input', { class: 'tw-input', placeholder: '输入代码 / 名称 / 拼音（如 600519、茅台、gzmt、00700）' });
    const mask = h(
      'div',
      { class: 'tw-modal-mask', onclick: (e) => e.target === mask && done(null) },
      h('div', { class: 'tw-modal', style: { width: '400px' } },
        h('div', { class: 'tw-modal-h', text: title }),
        h('div', { class: 'tw-modal-b' }, h('div', { class: 'pn-search' }, input), results),
        h('div', { class: 'tw-modal-f' }, h('button', { class: 'tw-btn', onclick: () => done(null) }, '取消')),
      ),
    );
    const done = (v) => {
      mask.remove();
      resolve(v);
    };
    const run = async () => {
      const q = input.value.trim();
      if (q === '') return mount(results, h('div', { class: 'tw-hint', text: '输入关键字开始搜索…' }));
      mount(results, h('div', { class: 'tw-loading' }, h('span', { class: 'tw-spin' })));
      try {
        const hits = await api.suggest(q);
        if (hits.length === 0) return mount(results, h('div', { class: 'tw-empty', text: '无匹配标的' }));
        mount(results, ...hits.map((x) =>
          h('div', { class: 'pn-search-item', onclick: () => done(x) },
            h('span', { class: 'tw-tag', text: x.kind }),
            h('span', { class: 'tw-1 tw-ellipsis', text: x.name }),
            h('span', { class: 'pn-code', text: x.code }),
            h('span', { class: 'tw-hint', text: marketLabel(x.secid) }),
          ),
        ));
      } catch (error) {
        mount(results, h('div', { class: 'tw-empty', text: `搜索失败：${error.message}` }));
      }
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(run, 260);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    document.body.append(mask);
    setTimeout(() => input.focus(), 30);
  });
}

async function manageGroups(ctx, kind) {
  const isWatch = kind === 'watch';
  const data = isWatch ? ctx.state.watch : (await api.portfolio.get()).data;
  const groups = data.groups;
  const rows = groups.map((g) => {
    const count = isWatch ? ctx.state.watch.items.filter((i) => i.groupId === g.id).length : (ctx.state.portfolio?.view?.positions ?? []).filter((p) => p.groupId === g.id).length;
    return h('div', { class: 'pn-item' },
      h('span', { class: 'tw-1' }, g.name, g.archived ? h('span', { class: 'tw-tag', style: { marginLeft: '6px' }, text: '已归档' }) : null, h('span', { class: 'tw-hint', style: { marginLeft: '6px' }, text: `${count} 项` })),
      h('button', { class: 'tw-btn xs', onclick: async () => {
        const r = await promptModal({ title: '重命名分组', fields: [{ key: 'name', label: '名称', value: g.name }] });
        if (!r) return;
        if (isWatch) ctx.state.watch = await api.watch.mutate({ op: 'renameGroup', groupId: g.id, name: r.name });
        else { await api.portfolio.mutate({ op: 'renameGroup', groupId: g.id, name: r.name }); ctx.state.portfolio = await api.portfolio.get(); }
        ctx.closeModal();
        ctx.render();
      } }, '改名'),
      h('button', { class: 'tw-btn xs', onclick: async () => {
        if (isWatch) ctx.state.watch = await api.watch.mutate({ op: g.archived ? 'restoreGroup' : 'archiveGroup', groupId: g.id });
        else { await api.portfolio.mutate({ op: g.archived ? 'restoreGroup' : 'archiveGroup', groupId: g.id }); ctx.state.portfolio = await api.portfolio.get(); }
        ctx.closeModal();
        manageGroups(ctx, kind);
        ctx.render();
      } }, g.archived ? '恢复' : '归档'),
    );
  });
  ctx.openModal(`管理分组 · ${isWatch ? '自选' : '持仓'}`, rows);
}

/* ── 持仓 ─────────────────────────────────────────────────────────────── */

export async function renderPos(ctx) {
  const st = ctx.state;
  const port = await api.portfolio.get();
  st.portfolio = port;
  const view = port.view;
  const groups = port.data.groups.filter((g) => !g.archived);
  if (!st.posGroupId || !groups.some((g) => g.id === st.posGroupId)) st.posGroupId = groups[0]?.id ?? null;
  st.ledger = port.ledger;

  const box = ctx.body;
  mount(box);

  const toolbar = h('div', { class: 'pn-toolbar' });
  const tabBox = h('div', { class: 'tw-flex tw-gap4', style: { flexWrap: 'wrap' } });
  for (const g of groups) {
    const gv = view.groups.find((x) => x.id === g.id);
    tabBox.append(h('button', { class: `tw-pill ${st.posGroupId === g.id ? 'on' : ''}`, onclick: () => { st.posGroupId = g.id; ctx.render(); } }, `${g.name} ${gv?.count ?? 0}`));
  }
  const seg = h('div', { class: 'tw-seg' });
  for (const [k, label] of [['diluted', '摊薄成本'], ['average', '均价成本']]) {
    seg.append(h('button', { class: st.prefs.costBasis === k ? 'on' : '', onclick: async () => { st.prefs = await api.prefs.set({ costBasis: k }); ctx.render(); } }, label));
  }
  toolbar.append(tabBox, h('button', { class: 'tw-btn xs', onclick: () => addPortGroup(ctx) }, '＋账户'), h('button', { class: 'tw-btn xs primary', onclick: () => addPosition(ctx) }, '＋持仓'), h('button', { class: 'tw-btn xs', onclick: () => showLedger(ctx) }, '流水'), seg);
  box.append(toolbar);

  const gv = view.groups.find((x) => x.id === st.posGroupId);
  if (gv) {
    const pct = gv.totalMv - gv.dayPnl > 0 ? (gv.dayPnl / (gv.totalMv - gv.dayPnl)) * 100 : null;
    box.append(
      h('div', { class: 'pn-sec' },
        h('div', { class: 'pn-grid4' },
          kpi('总市值', fmtAmt(gv.totalMv)),
          kpi('当日盈亏', fmtAmt(gv.dayPnl), pctClass(pct, ctx.redUp), null, pct !== null ? fmtPct(pct) : null),
          kpi('浮动盈亏', fmtAmt(gv.dilutedPnl || gv.floatPnl), pctClass(gv.dilutedPnl || gv.floatPnl, ctx.redUp)),
          kpi('累计已实现', fmtAmt(gv.realized), pctClass(gv.realized, ctx.redUp)),
        ),
        ctx.state.prefs.costBasis === 'diluted'
          ? h('div', { class: 'tw-hint', style: { marginTop: '6px' }, text: '摊薄口径：持仓盈亏 = 浮动盈亏 + 累计已实现（与多数券商 App 一致）' })
          : h('div', { class: 'tw-hint', style: { marginTop: '6px' }, text: '均价口径：浮动盈亏按买入移动加权均价计，已实现盈亏单独列示' }),
      ),
    );
  }

  const rows = view.positions.filter((p) => p.groupId === st.posGroupId);
  if (rows.length === 0) {
    box.append(h('div', { class: 'tw-empty', text: '该账户暂无持仓。点击「＋持仓」添加标的，再用「买入」录入流水。' }));
    return;
  }
  const basis = st.prefs.costBasis;
  box.append(
    h('div', { class: 'pn-list-row head w-pos' },
      h('span', {}, '名称 / 数量'), h('span', { class: 'tw-right' }, '成本'), h('span', { class: 'tw-right' }, '现价'),
      h('span', { class: 'tw-right' }, '市值'), h('span', { class: 'tw-right' }, '浮动盈亏'), h('span', { class: 'tw-right' }, '当日盈亏'),
    ),
  );
  for (const p of rows) box.append(posRow(ctx, p, basis));
  ctx.patchQuotes();
}

function posRow(ctx, p, basis) {
  const cost = basis === 'diluted' ? (p.dilutedCost ?? p.avgCost) : p.avgCost;
  const pnl = basis === 'diluted' ? (p.dilutedPnl ?? p.floatPnl) : p.floatPnl;
  const pnlPct = basis === 'diluted' ? p.dilutedPnlPct : p.floatPnlPct;
  const row = h(
    'div',
    { class: 'pn-list-row w-pos' },
    h('div', { style: { minWidth: 0 } },
      h('div', { class: 'tw-flex tw-gap4', style: { alignItems: 'baseline' } },
        h('b', { class: 'tw-ellipsis', style: { fontSize: '12.5px' }, text: p.name }),
        h('span', { class: 'pn-code', text: secidSplit(p.secid).code }),
      ),
      h('div', { class: 'tw-hint tw-num', text: p.empty ? '未录入流水' : `${p.qty} 股` }),
    ),
    h('div', { class: 'tw-right tw-num' }, cost ? fmtPrice(cost, 3) : '—'),
    h('div', { class: 'tw-right' }, ctx.registerQuote(p.secid, 'price', (v) => fmtPrice(v))),
    h('div', { class: 'tw-right tw-num' }, p.empty ? '—' : fmtAmt(p.mv)),
    h('div', { class: 'tw-right' },
      h('div', { class: `tw-num ${pctClass(pnl, ctx.redUp)}` }, p.empty ? '—' : fmtAmt(pnl)),
      h('div', { class: `tw-hint tw-num ${pctClass(pnlPct, ctx.redUp)}` }, pnlPct === null || pnlPct === undefined ? '' : fmtPct(pnlPct)),
    ),
    h('div', { class: 'tw-right' },
      h('div', { class: `tw-num ${pctClass(p.dayPnl, ctx.redUp)}` }, p.empty ? '—' : fmtAmt(p.dayPnl)),
      h('div', { class: `tw-hint tw-num ${pctClass(p.dayPnlPct, ctx.redUp)}` }, p.dayPnlPct === null || p.dayPnlPct === undefined ? '' : fmtPct(p.dayPnlPct)),
    ),
  );
  row.onclick = () => tradeMenu(ctx, p);
  row.ondblclick = () => ctx.openDrawer(p.secid);
  return row;
}

function tradeMenu(ctx, p) {
  const box = h('div', { class: 'tw-col tw-gap6' },
    h('div', { class: 'tw-hint', text: `${p.name} · ${p.secid}${p.empty ? '' : ` · 持仓 ${p.qty} 股 · 均价 ${fmtPrice(p.avgCost, 3)}`}` }),
    h('div', { class: 'tw-flex tw-gap6', style: { flexWrap: 'wrap' } },
      h('button', { class: 'tw-btn sm', onclick: () => doTrade(ctx, p, 'buy') }, '买入'),
      h('button', { class: 'tw-btn sm', onclick: () => doTrade(ctx, p, 'sell') }, '卖出'),
      h('button', { class: 'tw-btn sm', onclick: () => doAdjust(ctx, p) }, '调整/更正'),
      h('button', { class: 'tw-btn sm', onclick: () => editPos(ctx, p) }, '编辑'),
      h('button', { class: 'tw-btn sm', onclick: () => posLedger(ctx, p) }, '该标的流水'),
      h('button', { class: 'tw-btn sm', onclick: () => ctx.openDrawer(p.secid) }, '看K线'),
      h('button', { class: 'tw-btn sm danger', onclick: () => removePos(ctx, p) }, '移除'),
    ),
  );
  ctx.openModal(`持仓操作 · ${p.name}`, [box], { raw: true });
}

async function doTrade(ctx, p, verb) {
  ctx.closeModal();
  const q = ctx.state.quotes[p.secid];
  const res = await promptModal({
    title: `${verb === 'buy' ? '买入' : '卖出'} · ${p.name}`,
    fields: [
      { key: 'qty', label: '数量（股）', type: 'number', value: verb === 'sell' ? p.qty : 100, min: 0, required: true },
      { key: 'price', label: '成交价', type: 'number', value: q?.price ?? 0, step: '0.001', required: true },
      { key: 'fee', label: '费用（佣金/印花税等）', type: 'number', value: 0, step: '0.01' },
      { key: 'ts', label: '成交时间（留空=现在，格式 YYYY-MM-DD HH:mm）', type: 'text', placeholder: '2026-09-23 10:30' },
      { key: 'note', label: '备注', type: 'text' },
    ],
  });
  if (!res) return;
  try {
    await api.portfolio.mutate({ op: verb, posId: p.posId, qty: res.qty, price: res.price, fee: res.fee, note: res.note, ts: parseTs(res.ts) });
    toast(verb === 'buy' ? '买入已记账' : '卖出已记账');
    ctx.state.portfolio = await api.portfolio.get();
    ctx.render();
  } catch (error) {
    toast(error.message);
  }
}

function parseTs(text) {
  if (!text) return undefined;
  const t = Date.parse(String(text).replace(' ', 'T'));
  return Number.isFinite(t) ? t : undefined;
}

async function doAdjust(ctx, p) {
  ctx.closeModal();
  const res = await promptModal({
    title: `调整 / 更正 · ${p.name}`,
    fields: [
      { key: 'qty', label: '更正后的持仓数量', type: 'number', value: p.qty, required: true, hint: '用于处理送转股、数据纠错等场景' },
      { key: 'price', label: '更正后的买入均价（留空则不变）', type: 'number', step: '0.001' },
      { key: 'note', label: '说明', type: 'text', value: '持仓调整' },
    ],
  });
  if (!res) return;
  try {
    await api.portfolio.mutate({ op: 'adjust', posId: p.posId, qty: res.qty, price: res.price, note: res.note });
    toast('已调整');
    ctx.state.portfolio = await api.portfolio.get();
    ctx.render();
  } catch (error) {
    toast(error.message);
  }
}

async function editPos(ctx, p) {
  ctx.closeModal();
  const res = await promptModal({
    title: `编辑持仓 · ${p.name}`,
    fields: [{ key: 'symbolName', label: '显示名称', value: p.name }, { key: 'note', label: '备注', value: p.note ?? '' }],
  });
  if (!res) return;
  await api.portfolio.mutate({ op: 'editPos', posId: p.posId, symbolName: res.symbolName, note: res.note });
  ctx.state.portfolio = await api.portfolio.get();
  ctx.render();
}

async function removePos(ctx, p) {
  ctx.closeModal();
  if (!(await confirmModal('移除持仓', `确认从账户移除「${p.name}」？需先把数量卖到 0（保留完整流水）。`))) return;
  try {
    await api.portfolio.mutate({ op: 'removePos', posId: p.posId });
    toast('已移除');
    ctx.state.portfolio = await api.portfolio.get();
    ctx.render();
  } catch (error) {
    toast(error.message);
  }
}

async function addPortGroup(ctx) {
  const res = await promptModal({ title: '新建账户', fields: [{ key: 'name', label: '账户名称', value: '新账户' }] });
  if (!res) return;
  const port = await api.portfolio.get();
  await api.portfolio.mutate({ op: 'addGroup', name: res.name });
  ctx.state.portfolio = await api.portfolio.get();
  ctx.render();
}

async function addPosition(ctx) {
  const picked = await pickSymbol(ctx, '添加持仓');
  if (!picked) return;
  try {
    await api.portfolio.mutate({ op: 'addPos', secid: picked.secid, symbolName: picked.name, groupId: ctx.state.posGroupId });
    toast('已添加，请录入买卖流水');
    ctx.state.portfolio = await api.portfolio.get();
    await api.quotes([picked.secid]).then((r) => Object.assign(ctx.state.quotes, r));
    ctx.render();
  } catch (error) {
    toast(error.message);
  }
}

const VERB_LABEL = {
  buy: '买入', sell: '卖出', adjust: '调整', add: '新建持仓', remove: '移除持仓',
  gcreate: '新建分组', grename: '分组改名', gdelete: '归档分组', grestore: '恢复分组', gmove: '移动/编辑', pnote: '备注',
};

async function posLedger(ctx, p) {
  ctx.closeModal();
  const entries = await api.portfolio.ledger({ posId: p.posId, limit: 200 });
  const rows = entries.map((e) =>
    h('div', { class: 'pn-item' },
      h('span', { class: 'tw-tag', text: VERB_LABEL[e.verb] ?? e.verb }),
      h('span', { class: 'tw-1 tw-num', text: e.qty ? `${e.qty} @ ${fmtPrice(e.price, 3)}` : (e.note ?? '') }),
      h('span', { class: 'tw-hint tw-num', text: new Date(e.ts).toLocaleString('zh-CN', { hour12: false }) }),
      h('button', { class: 'tw-btn xs danger', onclick: async () => {
        if (!(await confirmModal('删除流水', '删除后持仓核算会立即变化，确认删除这条流水？'))) return;
        await api.portfolio.deleteLedger(e.id);
        ctx.closeModal();
        ctx.state.portfolio = await api.portfolio.get();
        ctx.render();
      } }, '删'),
    ),
  );
  ctx.openModal(`流水明细 · ${p.name}`, rows.length > 0 ? rows : [h('div', { class: 'tw-empty', text: '暂无流水' })]);
}

async function showLedger(ctx) {
  const entries = await api.portfolio.ledger({ limit: 300 });
  const rows = entries.map((e) =>
    h('div', { class: 'pn-item' },
      h('span', { class: 'tw-tag', text: VERB_LABEL[e.verb] ?? e.verb }),
      h('span', { class: 'tw-1 tw-ellipsis', text: `${e.posName ?? e.groupName ?? ''} ${e.qty ? `· ${e.qty} @ ${fmtPrice(e.price, 3)}` : ''}` }),
      h('span', { class: 'tw-hint tw-num', text: new Date(e.ts).toLocaleDateString('zh-CN') }),
    ),
  );
  ctx.openModal('全部流水（append-only 账本）', rows.length > 0 ? rows : [h('div', { class: 'tw-empty', text: '暂无流水' })]);
}

/* ── 板块 ─────────────────────────────────────────────────────────────── */

export async function renderBoards(ctx) {
  const st = ctx.state;
  st.boardScope = st.boardScope ?? 'industry';
  st.boardSort = st.boardSort ?? 'pct';
  const box = ctx.body;
  mount(box);

  const toolbar = h('div', { class: 'pn-toolbar' });
  const scopeSeg = h('div', { class: 'tw-seg' });
  for (const sc of BOARD_SCOPES) scopeSeg.append(h('button', { class: st.boardScope === sc.key ? 'on' : '', onclick: () => { st.boardScope = sc.key; ctx.render(); } }, sc.label));
  const sortSeg = h('div', { class: 'tw-seg' });
  for (const [k, l] of [['pct', '涨幅'], ['money', '主力净额'], ['amount', '成交额']]) sortSeg.append(h('button', { class: st.boardSort === k ? 'on' : '', onclick: () => { st.boardSort = k; ctx.render(); } }, l));
  toolbar.append(scopeSeg, sortSeg, h('span', { class: 'tw-1' }), h('button', { class: 'tw-btn xs', onclick: () => ctx.render() }, '刷新'));
  box.append(toolbar);

  box.append(h('div', { class: 'pn-list-row head w-rank' },
    h('span', {}, '#'), h('span', {}, '板块'), h('span', { class: 'tw-right' }, '涨跌幅'), h('span', { class: 'tw-right' }, '主力净额'), h('span', { class: 'tw-right' }, '成交额'),
  ));

  const loading = h('div', { class: 'tw-loading' }, h('span', { class: 'tw-spin' }), ' 加载板块排行…');
  box.append(loading);
  try {
    const data = await api.boards(st.boardScope, st.boardSort, 1, 60);
    loading.remove();
    data.rows.forEach((b, i) => box.append(boardRow(ctx, b, i + 1)));
    const foot = h('div', { class: 'tw-hint', style: { padding: '8px 10px' } },
      `共 ${data.total} 个板块 · ${data.source === 'sina' ? '数据源：新浪（东财行情主机不可用，已降级）' : '数据 30 秒缓存'}`);
    box.append(foot);
  } catch (error) {
    mount(loading, h('span', { class: 'tw-muted', text: `加载失败：${error.message}` }));
  }
}

function boardRow(ctx, b, rank) {
  const row = h(
    'div',
    { class: 'pn-list-row w-rank' },
    h('span', { class: 'tw-hint tw-num', text: String(rank) }),
    h('div', { style: { minWidth: 0 } },
      h('div', { class: 'tw-ellipsis', style: { fontSize: '12.5px', fontWeight: 500 }, text: b.name }),
      h('div', { class: 'tw-hint tw-ellipsis', text: b.leader ? `领涨 ${b.leader} ${fmtPct(b.leaderPct)}` : b.code }),
    ),
    h('div', { class: `tw-right tw-num ${pctClass(b.pct, ctx.redUp)}`, style: { fontWeight: 600 } }, fmtPct(b.pct)),
    h('div', { class: `tw-right tw-num ${pctClass(b.money, ctx.redUp)}` }, fmtAmt(b.money)),
    h('div', { class: 'tw-right tw-num tw-muted' }, fmtAmt(b.amount)),
  );
  if (b.secid) row.onclick = () => ctx.openDrawer(b.secid);
  return row;
}

/* ── 资金 ─────────────────────────────────────────────────────────────── */

export async function renderMoney(ctx) {
  const box = ctx.body;
  mount(box);
  const st = ctx.state;
  const [industry, concept, stocks, hs] = await Promise.all([
    api.boards('industry', 'money', 1, 15).catch(() => null),
    api.boards('concept', 'money', 1, 15).catch(() => null),
    api.stockFlowRank('money', 1, 20).catch(() => null),
    api.hsgt().catch(() => null),
  ]);

  const sec = (title, node, hint) => h('div', { class: 'pn-sec' }, secHeader(title, hint ? h('span', { class: 'tw-hint', text: hint }) : null), node);

  if (hs?.available) {
    const north = hs.north;
    const south = hs.south;
    const net = (o) => fmtAmt((o?.net ?? 0) * 10000);
    box.append(
      sec('沪深港通资金', h('div', { class: 'pn-grid2' },
        kpi('南向（港股通）合计', net(south), pctClass(south?.net, ctx.redUp)),
        kpi('北向（沪深股通）合计', hs.northDisclosed ? net(north) : '已停止实时披露', pctClass(north?.net, ctx.redUp)),
      ), `更新 ${north?.sh?.date ?? ''}`),
    );
  }

  const boardTable = (rows) => h('div', { class: 'tw-list' },
    h('div', { class: 'pn-list-row head w-rank' }, h('span', {}, '#'), h('span', {}, '板块'), h('span', { class: 'tw-right' }, '涨跌幅'), h('span', { class: 'tw-right' }, '主力净额'), h('span', { class: 'tw-right' }, '净占比')),
    ...rows.map((b, i) => h('div', { class: 'pn-list-row w-rank', style: { cursor: 'default' } },
      h('span', { class: 'tw-hint tw-num', text: String(i + 1) }),
      h('span', { class: 'tw-ellipsis', text: b.name }),
      h('span', { class: `tw-right tw-num ${pctClass(b.pct, ctx.redUp)}` }, fmtPct(b.pct)),
      h('span', { class: `tw-right tw-num ${pctClass(b.money, ctx.redUp)}` }, fmtAmt(b.money)),
      h('span', { class: 'tw-right tw-num tw-muted' }, b.moneyPct !== null ? `${b.moneyPct}%` : '—'),
    )),
  );

  box.append(sec('行业板块 · 主力净流入 TOP', industry?.rows ? boardTable(industry.rows) : h('div', { class: 'tw-empty', text: '暂不可用' })));
  box.append(sec('概念板块 · 主力净流入 TOP', concept?.rows ? boardTable(concept.rows) : h('div', { class: 'tw-empty', text: '暂不可用' })));

  if (stocks?.rows) {
    box.append(
      sec('个股 · 主力净流入 TOP', h('div', { class: 'tw-list' },
        h('div', { class: 'pn-list-row head w-rank' }, h('span', {}, '#'), h('span', {}, '名称'), h('span', { class: 'tw-right' }, '现价'), h('span', { class: 'tw-right' }, '涨跌幅'), h('span', { class: 'tw-right' }, '主力净额')),
        ...stocks.rows.map((s, i) => {
          const row = h('div', { class: 'pn-list-row w-rank' },
            h('span', { class: 'tw-hint tw-num', text: String(i + 1) }),
            h('div', { style: { minWidth: 0 } }, h('div', { class: 'tw-ellipsis', text: s.name }), h('div', { class: 'tw-hint tw-num', text: `${s.code}` })),
            h('span', { class: 'tw-right tw-num' }, fmtPrice(s.price)),
            h('span', { class: `tw-right tw-num ${pctClass(s.pct, ctx.redUp)}` }, fmtPct(s.pct)),
            h('span', { class: `tw-right tw-num ${pctClass(s.money, ctx.redUp)}` }, fmtAmt(s.money)),
          );
          row.onclick = () => ctx.openDrawer(s.secid);
          return row;
        }),
      )),
    );
  }

  box.append(
    sec('个股资金流查询', h('div', { style: { display: 'flex', gap: '6px' } },
      h('span', { class: 'tw-hint tw-1', text: '在「自选」或搜索中打开标的详情，即可查看该股当日主力/超大单/大单/中单/小单净额。' }),
      h('button', { class: 'tw-btn sm', onclick: async () => { const p = await pickSymbol(ctx, '查询资金流'); if (p) ctx.openDrawer(p.secid); } }, '选择标的'),
    )),
  );
}

/* ── 涨停 ─────────────────────────────────────────────────────────────── */

export async function renderLimit(ctx) {
  const st = ctx.state;
  st.limitKind = st.limitKind ?? 'zt';
  const box = ctx.body;
  mount(box);

  const toolbar = h('div', { class: 'pn-toolbar' });
  const seg = h('div', { class: 'tw-seg' });
  for (const [k, l] of [['zt', '涨停池'], ['dt', '跌停池'], ['zb', '炸板池']]) seg.append(h('button', { class: st.limitKind === k ? 'on' : '', onclick: () => { st.limitKind = k; ctx.render(); } }, l));
  toolbar.append(seg, h('span', { class: 'tw-1' }), h('button', { class: 'tw-btn xs', onclick: () => ctx.render() }, '刷新'));
  box.append(toolbar);

  const [pool, zt, dt, zb] = await Promise.all([
    api.limitPool(st.limitKind).catch(() => null),
    api.limitPool('zt').catch(() => null),
    api.limitPool('dt').catch(() => null),
    api.limitPool('zb').catch(() => null),
  ]);

  const ztN = zt?.total ?? 0;
  const dtN = dt?.total ?? 0;
  const zbN = zb?.total ?? 0;
  const brokenRate = ztN + zbN > 0 ? (zbN / (ztN + zbN)) * 100 : null;
  const maxBoards = Math.max(0, ...(zt?.rows ?? []).map((r) => r.boards ?? 0));

  box.append(
    h('div', { class: 'pn-sec' },
      secHeader('市场情绪温度', h('span', { class: 'tw-hint', text: pool?.date ? `交易日 ${pool.date}` : '' })),
      h('div', { class: 'pn-grid4' },
        kpi('涨停', String(ztN), ctx.redUp ? 'tw-up' : 'tw-down'),
        kpi('跌停', String(dtN), ctx.redUp ? 'tw-down' : 'tw-up'),
        kpi('炸板率', brokenRate === null ? '—' : `${brokenRate.toFixed(1)}%`),
        kpi('最高连板', maxBoards > 0 ? `${maxBoards} 板` : '—'),
      ),
      h('div', { class: 'tw-hint', style: { marginTop: '6px' }, text: '炸板率 = 炸板数 ÷ (涨停数 + 炸板数)，反映情绪强弱与接力意愿。' }),
    ),
  );

  if (!pool || pool.rows.length === 0) {
    box.append(h('div', { class: 'tw-empty', text: '暂无数据（非交易日或上游限流，稍后重试）' }));
    return;
  }

  box.append(
    h('div', { class: 'pn-list-row head', style: { gridTemplateColumns: 'minmax(80px,1.5fr) 58px 56px 44px 60px 72px', display: 'grid' } },
      h('span', {}, '名称'), h('span', { class: 'tw-right' }, '现价'), h('span', { class: 'tw-right' }, '涨跌幅'), h('span', { class: 'tw-right' }, '连板'), h('span', { class: 'tw-right' }, '封板'), h('span', { class: 'tw-right' }, '封单额'),
    ),
  );
  for (const r of pool.rows) {
    const row = h('div', { class: 'pn-list-row', style: { gridTemplateColumns: 'minmax(80px,1.5fr) 58px 56px 44px 60px 72px', display: 'grid' } },
      h('div', { style: { minWidth: 0 } },
        h('div', { class: 'tw-ellipsis', style: { fontSize: '12.5px', fontWeight: 500 }, text: r.name }),
        h('div', { class: 'tw-hint tw-ellipsis', text: `${r.code}${r.industry ? ` · ${r.industry}` : ''}` }),
      ),
      h('span', { class: 'tw-right tw-num' }, fmtPrice(r.price)),
      h('span', { class: `tw-right tw-num ${pctClass(r.pct, ctx.redUp)}` }, fmtPct(r.pct)),
      h('span', { class: 'tw-right tw-num' }, r.boards ? `${r.boards}板` : '—'),
      h('span', { class: 'tw-right tw-hint tw-num' }, r.firstSeal || '—'),
      h('span', { class: 'tw-right tw-num tw-muted' }, fmtAmt(r.sealFund)),
    );
    row.onclick = () => ctx.openDrawer(r.secid);
    box.append(row);
  }
  box.append(h('div', { class: 'tw-hint', style: { padding: '8px 10px' } }, `共 ${pool.total} 只 · 数据 60 秒缓存 · 免费公开接口`));
}

/* ── 日历 ─────────────────────────────────────────────────────────────── */

export async function renderCalendar(ctx) {
  const st = ctx.state;
  const now = new Date();
  st.calYear = st.calYear ?? now.getFullYear();
  st.calMonth = st.calMonth ?? now.getMonth();
  st.calSel = st.calSel ?? fmtDate(Date.now());

  const box = ctx.body;
  mount(box);

  const from = `${st.calYear}-${String(st.calMonth + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(st.calYear, st.calMonth + 1, 0).getDate();
  const to = `${st.calYear}-${String(st.calMonth + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const resp = await api.calendar.get({ from, to }).catch(() => null);
  const events = resp?.events ?? [];
  const byDate = new Map();
  for (const e of events) {
    const arr = byDate.get(e.date) ?? [];
    arr.push(e);
    byDate.set(e.date, arr);
  }

  const toolbar = h('div', { class: 'pn-toolbar' },
    h('button', { class: 'tw-btn xs', onclick: () => { st.calMonth -= 1; if (st.calMonth < 0) { st.calMonth = 11; st.calYear -= 1; } ctx.render(); } }, '‹'),
    h('span', { class: 'tw-strong', style: { minWidth: '92px', textAlign: 'center' }, text: `${st.calYear} 年 ${st.calMonth + 1} 月` }),
    h('button', { class: 'tw-btn xs', onclick: () => { st.calMonth += 1; if (st.calMonth > 11) { st.calMonth = 0; st.calYear += 1; } ctx.render(); } }, '›'),
    h('span', { class: 'tw-1' }),
    h('button', { class: 'tw-btn xs', onclick: () => addCalEvent(ctx, st.calSel) }, '＋事件'),
    h('button', { class: 'tw-btn xs', onclick: async () => { toast('正在同步…'); await api.calendar.get({ from, to, force: true }).catch(() => {}); ctx.render(); } }, '同步'),
  );
  box.append(toolbar);

  const grid = h('div', { class: 'pn-cal-grid' });
  for (const wd of ['日', '一', '二', '三', '四', '五', '六']) grid.append(h('div', { class: 'pn-cal-wd', text: wd }));
  const first = new Date(st.calYear, st.calMonth, 1);
  const startPad = first.getDay();
  const today = fmtDate(Date.now());
  for (let i = 0; i < startPad; i += 1) grid.append(h('div', { class: 'pn-cal-cell other' }));
  for (let d = 1; d <= lastDay; d += 1) {
    const date = `${st.calYear}-${String(st.calMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const evs = byDate.get(date) ?? [];
    const cell = h('div', { class: `pn-cal-cell ${date === today ? 'today' : ''} ${date === st.calSel ? 'sel' : ''}`, onclick: () => { st.calSel = date; ctx.render(); } },
      h('div', { class: 'd', text: String(d) }),
      ...evs.slice(0, 3).map((e) => h('div', { class: `pn-cal-ev imp${e.importance ?? 1}`, title: e.title }, `${e.time ? `${e.time} ` : ''}${e.title}`)),
      evs.length > 3 ? h('div', { class: 'tw-hint', text: `＋${evs.length - 3}` }) : null,
    );
    grid.append(cell);
  }
  box.append(h('div', { class: 'pn-sec', style: { padding: '8px 6px' } }, grid));

  // 当日事件
  const dayEvents = byDate.get(st.calSel) ?? [];
  const daySec = h('div', { class: 'pn-sec' }, secHeader(`${st.calSel} 事件（${dayEvents.length}）`, h('button', { class: 'tw-btn xs', onclick: () => addCalEvent(ctx, st.calSel) }, '＋添加')));
  if (dayEvents.length === 0) {
    daySec.append(h('div', { class: 'tw-empty', text: '当天没有事件。可手动补录（源里未覆盖的海外数据、未上市公司日程等）。' }));
  } else {
    for (const e of dayEvents) {
      daySec.append(
        h('div', { class: 'pn-item' },
          h('span', { class: `tw-chip ${e.importance === 3 ? 'up' : e.importance === 2 ? '' : 'accent'}`, text: CAL_CATEGORY_LABEL[e.category] ?? '其他' }),
          h('div', { class: 'tw-1', style: { minWidth: 0 } },
            h('div', { style: { fontSize: '12.5px' } }, `${e.time ? `${e.time} ` : ''}${e.title}`),
            e.note ? h('div', { class: 'tw-hint tw-ellipsis', text: e.note }) : null,
          ),
          h('span', { class: 'tw-hint', text: e.source === 'auto' ? '自动' : '手动' }),
          h('button', { class: 'tw-btn xs danger', title: '删除/隐藏', onclick: async () => {
            await api.calendar.mutate({ op: e.source === 'auto' ? 'hide' : 'remove', id: e.id });
            ctx.render();
          } }, '×'),
        ),
      );
    }
  }
  box.append(daySec);
  box.append(h('div', { class: 'tw-hint', style: { padding: '8px 10px' } }, '自动来源：东财数据中心（新股申购/上市、自选与持仓标的的财报预约披露、分红除权）。海外 CPI 等源外事件请手动补录。'));
}

async function addCalEvent(ctx, date) {
  const res = await promptModal({
    title: '新增日历事件',
    fields: [
      { key: 'title', label: '事件名称', required: true, placeholder: '如：美国 8 月 CPI 公布' },
      { key: 'date', label: '日期', type: 'date', value: date ?? fmtDate(Date.now()), required: true },
      { key: 'time', label: '时刻（可选，HH:mm）', type: 'text', placeholder: '20:30' },
      { key: 'category', label: '分类', type: 'select', value: 'macro-intl', options: Object.entries(CAL_CATEGORY_LABEL).map(([value, label]) => ({ value, label })) },
      { key: 'importance', label: '重要度', type: 'select', value: '2', options: [{ value: '3', label: '高' }, { value: '2', label: '中' }, { value: '1', label: '低' }] },
      { key: 'note', label: '备注', type: 'text' },
    ],
  });
  if (!res) return;
  await api.calendar.mutate({ op: 'add', ...res, importance: Number(res.importance) });
  toast('已添加事件');
  ctx.render();
}

/* ── 预警 ─────────────────────────────────────────────────────────────── */

export async function renderAlerts(ctx) {
  const box = ctx.body;
  mount(box);
  const [list, log] = await Promise.all([api.alerts.get(), api.alerts.log()]);

  const toolbar = h('div', { class: 'pn-toolbar' },
    h('span', { class: 'tw-1 tw-hint', text: `共 ${list.length} 条规则 · 由后台每分钟检查并推送系统通知` }),
    h('button', { class: 'tw-btn xs primary', onclick: () => addAlertRule(ctx) }, '＋预警'),
    h('button', { class: 'tw-btn xs', onclick: () => chrome.runtime.sendMessage({ type: 'notify.test' }) }, '测试通知'),
  );
  box.append(toolbar);

  if (list.length === 0) {
    box.append(h('div', { class: 'tw-empty', text: '还没有预警规则。点击「＋预警」按涨跌幅或价格设置提醒。' }));
  }
  for (const a of list) {
    const field = ALERT_FIELD_LABEL[a.field] ?? a.field;
    box.append(
      h('div', { class: 'pn-item' },
        h('div', { class: 'tw-1', style: { minWidth: 0 } },
          h('div', { class: 'tw-flex tw-gap6', style: { alignItems: 'baseline' } },
            h('b', { style: { fontSize: '12.5px' }, text: a.name || a.secid }),
            h('span', { class: 'tw-tag', text: field }),
          ),
          h('div', { class: 'tw-hint', text: `${a.op === '>=' ? '达到或超过' : '低于或等于'} ${a.value}${a.field === 'pct' ? '%' : ''}${a.note ? ` · ${a.note}` : ''}` }),
        ),
        h('span', { class: 'tw-hint', text: a.lastFiredAt ? `上次 ${new Date(a.lastFiredAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '未触发' }),
        h('button', { class: `tw-switch ${a.enabled ? 'on' : ''}`, title: '启用/停用', onclick: async () => { await api.alerts.mutate({ op: 'toggle', id: a.id }); ctx.render(); } }),
        h('button', { class: 'tw-btn xs', onclick: () => editAlertRule(ctx, a) }, '编辑'),
        h('button', { class: 'tw-btn xs danger', onclick: async () => { await api.alerts.mutate({ op: 'remove', id: a.id }); ctx.render(); } }, '删'),
      ),
    );
  }

  const logSec = h('div', { class: 'pn-sec' }, secHeader('触发历史', h('button', { class: 'tw-btn xs', onclick: async () => { await api.alerts.mutate({ op: 'clearLog' }); ctx.render(); } }, '清空')));
  if (log.length === 0) logSec.append(h('div', { class: 'tw-hint', text: '暂无触发记录。' }));
  else for (const r of log.slice(0, 50)) {
    logSec.append(h('div', { class: 'pn-item' },
      h('span', { class: `tw-chip ${pctClass(r.actual, ctx.redUp)}`, text: `${r.field === 'pct' ? fmtPct(r.actual) : fmtPrice(r.actual, 3)}` }),
      h('span', { class: 'tw-1 tw-ellipsis', text: r.name || r.secid }),
      h('span', { class: 'tw-hint tw-num', text: new Date(r.ts).toLocaleString('zh-CN', { hour12: false }) }),
    ));
  }
  box.append(logSec);
}

async function addAlertRule(ctx) {
  const picked = await pickSymbol(ctx, '选择预警标的');
  if (!picked) return;
  await editAlertRule(ctx, { secid: picked.secid, name: picked.name, field: 'pct', op: '>=', value: 5, enabled: true, cooldownSec: 600 }, true);
}

async function editAlertRule(ctx, a, isNew = false) {
  ctx.closeModal();
  const res = await promptModal({
    title: `${isNew ? '新增' : '编辑'}预警 · ${a.name || a.secid}`,
    fields: [
      { key: 'field', label: '监测字段', type: 'select', value: a.field, options: [{ value: 'pct', label: '涨跌幅 %' }, { value: 'price', label: '现价' }] },
      { key: 'op', label: '条件', type: 'select', value: a.op, options: [{ value: '>=', label: '≥ 大于等于' }, { value: '<=', label: '≤ 小于等于' }] },
      { key: 'value', label: '阈值', type: 'number', value: a.value, step: '0.01', required: true },
      { key: 'cooldownSec', label: '重复提醒冷却（秒）', type: 'number', value: a.cooldownSec ?? 600 },
      { key: 'note', label: '备注', value: a.note ?? '' },
    ],
  });
  if (!res) return;
  if (isNew) await api.alerts.mutate({ op: 'add', alert: { secid: a.secid, name: a.name, ...res } });
  else await api.alerts.mutate({ op: 'update', id: a.id, patch: res });
  toast(isNew ? '预警已创建' : '预警已更新');
  chrome.runtime.sendMessage({ type: 'badge.refresh' }).catch(() => {});
  ctx.render();
}

/* ── 工具 ─────────────────────────────────────────────────────────────── */

/** 生效中的自选标的（排除已归档分组） */
export function liveItems(w) {
  if (!w) return [];
  const archived = new Set((w.groups ?? []).filter((g) => g.archived).map((g) => g.id));
  return (w.items ?? []).filter((i) => !archived.has(i.groupId));
}

export const VIEWS = {
  overview: renderOverview,
  watch: renderWatch,
  pos: renderPos,
  boards: renderBoards,
  money: renderMoney,
  limit: renderLimit,
  calendar: renderCalendar,
  alerts: renderAlerts,
};
