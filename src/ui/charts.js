/**
 * 图表引擎（纯 SVG，无第三方依赖）。
 *  - sparkline：列表缩略分时
 *  - dayBar：日内位置条（今开/最高/最低/现价，零额外请求）
 *  - trendChart：分时 / 五日（主图 + 成交量 + 十字光标）
 *  - klineChart：多周期 K 线（MA 叠加 + 成交量 + MACD + 滚轮缩放 + 拖拽平移）
 */
import { s, h } from './dom.js';
import { SMA, MACD, MA_CONFIG } from '../shared/indicators.js';
import { fmtAmt, fmtInt, fmtPct, fmtPrice, fmtVol, isNum, sessionLabel } from '../shared/format.js';

/** 读取当前主题的调色板（把 CSS 变量解析成具体颜色） */
export function palette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fb) => (cs.getPropertyValue(name) || fb).trim();
  return {
    up: v('--tw-up-ink', '#e03131'),
    down: v('--tw-down-ink', '#0f9d58'),
    flat: v('--tw-flat-ink', '#7a8698'),
    upBg: v('--tw-up-bg', '#ffe8e6'),
    downBg: v('--tw-down-bg', '#e3f6ec'),
    ink: v('--tw-ink', '#10151c'),
    ink2: v('--tw-ink-2', '#4a5568'),
    ink3: v('--tw-ink-3', '#8b97a8'),
    border: v('--tw-border', '#e2e8f0'),
    grid: v('--tw-border', '#e2e8f0'),
    panel: v('--tw-panel', '#fff'),
    accent: v('--tw-accent', '#2563eb'),
  };
}

function colorOf(pct, redUp, p) {
  if (pct === null || pct === undefined || Math.abs(pct) < 1e-9) return p.flat;
  return (pct > 0) === redUp ? p.up : p.down;
}

/** 生成「好看」的刻度值 */
function niceTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const span = max - min;
  const step0 = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const out = [];
  for (let v = start; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

function fmtAxis(v, span) {
  if (span < 0.02) return v.toFixed(4);
  if (span < 0.5) return v.toFixed(3);
  if (span < 20) return v.toFixed(2);
  return v.toFixed(0);
}

/* ── 自适应宽度 ───────────────────────────────────────────────────────── */

/**
 * 按容器**实测宽度**渲染，并在宽度变化时重绘。
 *
 * 为什么不能固定 640 再靠 viewBox 缩放：
 * 侧边栏实际只有 300~420px，viewBox 640 缩到 320px 会把 9px 的字号压成 4.5px，
 * 图例、档位标签、时间刻度全部糊成一团。用真实宽度画，字号才是所见即所得。
 *
 * 返回 destroy()（当前调用方都不需要，保留以备后用）。
 */
function withWidth(container, fallback = 640, render) {
  const measure = () => {
    const w = container.clientWidth || container.getBoundingClientRect?.().width || 0;
    return Math.max(220, Math.round(w || fallback));
  };
  render(measure());
  if (typeof ResizeObserver !== 'function') return () => {};
  let last = measure();
  const ro = new ResizeObserver(() => {
    const w = measure();
    if (Math.abs(w - last) < 8) return;   // 阈值避免滚动条出现/消失引发的抖动循环
    last = w;
    render(w);
  });
  ro.observe(container);
  return () => ro.disconnect();
}

/* ───────────────────────────── 缩略线 ───────────────────────────────── */

/** 列表用缩略分时线（宽度自适应，高度固定 22） */
export function sparkline(points, { redUp = true, height = 22, width = 76 } = {}) {
  const p = palette();
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, width, height, style: 'display:block' });
  if (!Array.isArray(points) || points.length < 2) {
    svg.append(s('line', { x1: 0, y1: height / 2, x2: width, y2: height / 2, stroke: p.grid, 'stroke-width': 1, 'stroke-dasharray': '2 2' }));
    return svg;
  }
  const prices = points.map((x) => x.price).filter(isNum);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const base = points[0].price;
  const col = colorOf(points[points.length - 1].price - base, redUp, p);
  const span = max - min || 1;
  const X = (i) => (i / (points.length - 1)) * width;
  const Y = (v) => height - 2 - ((v - min) / span) * (height - 4);
  const d = points.map((pt, i) => `${i === 0 ? 'M' : 'L'}${X(i).toFixed(2)},${Y(pt.price).toFixed(2)}`).join(' ');
  svg.append(s('path', { d: `${d} L${width},${height} L0,${height} Z`, fill: col, opacity: 0.12 }));
  svg.append(s('path', { d, fill: 'none', stroke: col, 'stroke-width': 1.2, 'stroke-linejoin': 'round' }));
  // 昨收基准
  if (isNum(points[0]?.avg) === false && isNum(base)) {
    const y = Y(base);
    if (y > 0 && y < height) svg.append(s('line', { x1: 0, y1: y, x2: width, y2: y, stroke: p.grid, 'stroke-width': 0.6, 'stroke-dasharray': '2 2' }));
  }
  return svg;
}

/* ─────────────────────────── 日内位置条 ─────────────────────────────── */

/** 用行情自身字段画出「今日价格所处位置」，无需额外请求 */
export function dayBar(q, { redUp = true } = {}) {
  const p = palette();
  const wrap = h('div', { class: 'tw-daybar' });
  const low = q?.low;
  const high = q?.high;
  const price = q?.price;
  if (!isNum(low) || !isNum(high) || high <= low) return wrap;
  const pos = (v) => `${Math.max(0, Math.min(100, ((v - low) / (high - low)) * 100))}%`;
  if (isNum(q.open)) wrap.append(h('i', { class: 'mk', style: { left: pos(q.open), background: p.ink3 } }));
  if (isNum(price)) {
    const col = colorOf(q.pct, redUp, p);
    wrap.append(h('i', { class: 'mk now', style: { left: pos(price), background: col } }));
  }
  return wrap;
}

/* ─────────────────────── 涨跌分布柱状图 ─────────────────────────────── */

/**
 * 全市场涨跌分布（11 档，涨→平→跌）。
 * bins: [{ label, side: 'up'|'flat'|'down', count }]
 *
 * 宽度按容器实测值走：侧边栏里 11 档要挤进 ~300px，
 * 窄的时候自动缩小字号并去掉最次要的占比行，避免标签糊成一团。
 */
export function distributionChart(container, { bins, redUp = true, height = 158 } = {}) {
  const p = palette();
  const list = Array.isArray(bins) ? bins : [];
  container.textContent = '';
  if (list.length === 0) {
    container.append(h('div', { class: 'tw-hint tw-center', style: { padding: '20px 0' }, text: '暂无涨跌分布数据' }));
    return;
  }
  const H = height;
  const max = Math.max(1, ...list.map((b) => Number(b.count) || 0));
  const total = list.reduce((a, b) => a + (Number(b.count) || 0), 0);
  const colOf = (side) => (side === 'flat' ? p.flat : (side === 'up') === redUp ? p.up : p.down);

  withWidth(container, 640, (W) => {
    [...container.querySelectorAll('svg')].forEach((n) => n.remove());
    const narrow = W < 440;
    const padL = narrow ? 26 : 34;
    const padR = 8;
    const padT = 20;
    const padB = narrow ? 26 : 28;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const step = innerW / list.length;
    const barW = Math.max(6, step * 0.62);
    const fsVal = narrow ? 7.5 : 9;
    const fsLabel = narrow ? 7 : 8.5;

    // 注意：s() 走 setAttribute，style 必须传字符串；传对象会被序列化成 "[object Object]" 而失效
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet', style: 'width:100%;height:auto;display:block' });

    // 横向网格 + 刻度
    for (const t of niceTicks(0, max, 3)) {
      const y = padT + innerH - (t / max) * innerH;
      svg.append(s('line', { x1: padL, y1: y, x2: padL + innerW, y2: y, stroke: p.grid, 'stroke-width': 0.6, 'stroke-dasharray': '2 4' }));
      svg.append(s('text', { x: padL - 4, y: y + 3, 'text-anchor': 'end', fill: p.ink3, 'font-size': fsVal, 'font-family': 'var(--tw-mono)' }, String(Math.round(t))));
    }

    list.forEach((b, i) => {
      const n = Number(b.count) || 0;
      const bh = max > 0 ? (n / max) * innerH : 0;
      const x = padL + step * i + (step - barW) / 2;
      const y = padT + innerH - bh;
      const col = colOf(b.side);
      svg.append(s('rect', { x, y, width: barW, height: Math.max(bh, n > 0 ? 1.5 : 0), rx: Math.min(2, barW / 3), fill: col, opacity: n === max ? 1 : 0.82 }));
      // 数值
      svg.append(s('text', { x: x + barW / 2, y: y - 3.5, 'text-anchor': 'middle', fill: p.ink2, 'font-size': fsVal, 'font-weight': 600, 'font-family': 'var(--tw-mono)' }, String(n)));
      // 档位
      svg.append(s('text', { x: x + barW / 2, y: padT + innerH + 12, 'text-anchor': 'middle', fill: i === 5 ? p.ink2 : col, 'font-size': fsLabel }, b.label));
      // 占比（窄容器下省掉，它是最次要的一行）
      if (!narrow && total > 0 && n > 0) {
        svg.append(s('text', { x: x + barW / 2, y: padT + innerH + 21, 'text-anchor': 'middle', fill: p.ink3, 'font-size': 7.5, 'font-family': 'var(--tw-mono)' }, `${((n / total) * 100).toFixed(1)}%`));
      }
    });

    // 基准轴
    svg.append(s('line', { x1: padL, y1: padT + innerH, x2: padL + innerW, y2: padT + innerH, stroke: p.grid, 'stroke-width': 1 }));
    container.append(svg);
  });
}

/* ───────────────────────────── 分时图 ───────────────────────────────── */

/**
 * 分时图（主图 + 成交量 + 十字光标）。
 * 返回 { update(trend), destroy() }
 */
export function trendChart(container, { redUp = true, height = 200, showVolume = true, markers = [] } = {}) {
  const p = palette();
  const tip = h('div', { class: 'tw-tip', style: { display: 'none' } });
  container.classList.add('tw-chart');
  container.append(tip);

  let data = null;
  const volH = showVolume ? Math.round(height * 0.24) : 0;
  const priceH = height - volH - 18;

  function render() {
    [...container.querySelectorAll('svg')].forEach((n) => n.remove());
    const W = Math.max(200, container.clientWidth || 320);
    const H = height;
    const padL = 6;
    const padR = 46;
    const innerW = W - padL - padR;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H });

    if (!data || !Array.isArray(data.points) || data.points.length < 2) {
      svg.append(s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: p.ink3, 'font-size': 12 }, '暂无分时数据'));
      container.append(svg);
      return;
    }
    const pts = data.points;
    const pre = data.prePrice ?? pts[0].price;
    const prices = pts.map((x) => x.price);
    const maxAbs = Math.max(...prices.map((v) => Math.abs(v - pre)), pre * 0.002);
    const hi = pre + maxAbs * 1.08;
    const lo = pre - maxAbs * 1.08;
    const X = (i) => padL + (i / (pts.length - 1)) * innerW;
    const Y = (v) => 8 + ((hi - v) / (hi - lo || 1)) * (priceH - 16);

    // 网格 + 价格轴
    for (const t of niceTicks(lo, hi, 4)) {
      const y = Y(t);
      if (y < 6 || y > priceH - 6) continue;
      svg.append(s('line', { x1: padL, y1: y, x2: padL + innerW, y2: y, stroke: p.grid, 'stroke-width': t === pre ? 0 : 0.6, 'stroke-dasharray': t === pre ? '3 3' : '2 4' }));
      const pct = ((t - pre) / pre) * 100;
      const col = colorOf(pct, redUp, p);
      svg.append(s('text', { x: padL + innerW + 4, y: y + 3, fill: t === pre ? p.ink2 : col, 'font-size': 9.5, 'font-family': 'var(--tw-mono)' }, `${fmtAxis(t, hi - lo)}`));
      svg.append(s('text', { x: padL + innerW + 4, y: y + 12, fill: col, 'font-size': 9, 'font-family': 'var(--tw-mono)', opacity: 0.75 }, `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`));
    }
    // 昨收基准线（多日视图为区间起始基准）
    const preY = Y(pre);
    if (preY >= 6 && preY <= priceH - 6) {
      svg.append(s('line', { x1: padL, y1: preY, x2: padL + innerW, y2: preY, stroke: p.ink3, 'stroke-width': 0.9, 'stroke-dasharray': '4 3', opacity: 0.75 }));
    }
    // 时间轴
    const times = [0, Math.floor(pts.length / 2), pts.length - 1];
    for (const i of times) {
      const label = (pts[i]?.label ?? '').slice(11, 16);
      svg.append(s('text', { x: X(i), y: H - 4, fill: p.ink3, 'font-size': 9.5, 'text-anchor': i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle' }, label));
    }

    // 价格与均价线
    const lineD = pts.map((pt, i) => `${i === 0 ? 'M' : 'L'}${X(i).toFixed(1)},${Y(pt.price).toFixed(1)}`).join(' ');
    const last = pts[pts.length - 1];
    const col = colorOf(last.price - pre, redUp, p);
    svg.append(s('path', { d: `${lineD} L${X(pts.length - 1).toFixed(1)},${priceH - 6} L${padL},${priceH - 6} Z`, fill: col, opacity: 0.1 }));
    svg.append(s('path', { d: lineD, fill: 'none', stroke: col, 'stroke-width': 1.4, 'stroke-linejoin': 'round' }));

    if (pts.some((x) => isNum(x.avg))) {
      const avgD = pts.map((pt, i) => (isNum(pt.avg) ? `${i === 0 ? 'M' : 'L'}${X(i).toFixed(1)},${Y(pt.avg).toFixed(1)}` : '')).filter(Boolean).join(' ');
      svg.append(s('path', { d: avgD, fill: 'none', stroke: '#e8a33d', 'stroke-width': 1, 'stroke-dasharray': '3 2', opacity: 0.9 }));
    }

    // 成交量
    if (showVolume) {
      const vols = pts.map((x) => x.vol ?? 0);
      const vmax = Math.max(...vols, 1);
      const vy0 = priceH + 14;
      for (let i = 0; i < pts.length; i += 1) {
        const bh = (vols[i] / vmax) * (volH - 16);
        const c = pts[i].price >= (pts[i - 1]?.price ?? pre) ? colorOf(1, redUp, p) : colorOf(-1, redUp, p);
        const bw = Math.max(0.6, innerW / pts.length - 0.4);
        svg.append(s('rect', { x: X(i) - bw / 2, y: vy0 + (volH - 16) - bh, width: bw, height: Math.max(0.5, bh), fill: c, opacity: 0.75 }));
      }
      svg.append(s('text', { x: padL, y: vy0 + 9, fill: p.ink3, 'font-size': 9 }, `成交量 ${fmtVol(Math.max(...vols))}`));
    }

    // 买卖点标记
    if (Array.isArray(markers) && markers.length > 0 && pts.length > 1) {
      const t0 = pts[0].t;
      const t1 = pts[pts.length - 1].t;
      for (const m of markers) {
        if (m.ts < t0 || m.ts > t1) continue;
        const ratio = (m.ts - t0) / (t1 - t0 || 1);
        const x = padL + ratio * innerW;
        const y = Y(Math.min(hi, Math.max(lo, m.price)));
        const c = m.verb === 'buy' ? (redUp ? p.up : p.down) : (redUp ? p.down : p.up);
        svg.append(s('circle', { cx: x, cy: y, r: 6.5, fill: c, opacity: 0.92 }));
        svg.append(s('text', { x, y: y + 3, fill: '#fff', 'font-size': 8.5, 'text-anchor': 'middle', 'font-weight': 700 }, m.verb === 'buy' ? 'B' : 'S'));
      }
    }

    // 最后价格标
    const ly = Y(last.price);
    svg.append(s('circle', { cx: X(pts.length - 1), cy: ly, r: 2.4, fill: col }));
    svg.append(s('rect', { x: padL + innerW + 1, y: ly - 7, width: 44, height: 14, rx: 3, fill: col }));
    svg.append(s('text', { x: padL + innerW + 23, y: ly + 3.2, fill: '#fff', 'font-size': 9.5, 'text-anchor': 'middle', 'font-family': 'var(--tw-mono)' }, fmtAxis(last.price, hi - lo)));

    // 十字光标层
    const crossV = s('line', { x1: 0, y1: 8, x2: 0, y2: priceH - 6, stroke: p.ink3, 'stroke-width': 0.8, 'stroke-dasharray': '3 3', opacity: 0 });
    const crossH = s('line', { x1: padL, y1: 0, x2: padL + innerW, y2: 0, stroke: p.ink3, 'stroke-width': 0.8, 'stroke-dasharray': '3 3', opacity: 0 });
    svg.append(crossV, crossH);

    const overlay = s('rect', { x: padL, y: 0, width: innerW, height: H, fill: 'transparent', style: 'cursor:crosshair' });
    overlay.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * W;
      const idx = Math.max(0, Math.min(pts.length - 1, Math.round(((x - padL) / innerW) * (pts.length - 1))));
      const pt = pts[idx];
      const px = X(idx);
      const py = Y(pt.price);
      crossV.setAttribute('x1', px);
      crossV.setAttribute('x2', px);
      crossV.setAttribute('opacity', 0.8);
      crossH.setAttribute('y1', py);
      crossH.setAttribute('y2', py);
      crossH.setAttribute('opacity', 0.8);
      const pct = ((pt.price - pre) / pre) * 100;
      tip.innerHTML = [
        `<b>${(pt.label ?? '').slice(5)}</b>`,
        `价 ${fmtPrice(pt.price, 3)} <span style="color:${colorOf(pct, redUp, p)}">${fmtPct(pct)}</span>`,
        isNum(pt.avg) ? `均 ${fmtPrice(pt.avg, 3)}` : '',
        isNum(pt.vol) ? `量 ${fmtVol(pt.vol)}` : '',
        isNum(pt.amount) ? `额 ${fmtAmt(pt.amount)}` : '',
      ]
        .filter(Boolean)
        .join('<br>');
      tip.style.display = 'block';
      const left = (px / W) * rect.width;
      tip.style.left = `${Math.min(Math.max(4, left + 10), Math.max(4, rect.width - tip.offsetWidth - 6))}px`;
      tip.style.top = '6px';
    });
    overlay.addEventListener('mouseleave', () => {
      tip.style.display = 'none';
      crossV.setAttribute('opacity', 0);
      crossH.setAttribute('opacity', 0);
    });
    svg.append(overlay);
    container.append(svg);
  }

  render();
  const ro = new ResizeObserver(() => render());
  ro.observe(container);
  return {
    update(next) {
      data = next;
      render();
    },
    destroy() {
      ro.disconnect();
      tip.remove();
    },
  };
}

/* ─────────────────────────────  K 线 ───────────────────────────────── */

/**
 * 多周期 K 线：主图（蜡烛 + MA）+ 成交量 + MACD，支持滚轮缩放与拖拽平移。
 * 返回 { update(bars), setRange(days), destroy() }
 */
export function klineChart(container, { redUp = true, height = 320, markers = [], onRangeChange = null } = {}) {
  const p = palette();
  const root = h('div', { class: 'tw-col', style: { position: 'relative' } });
  const tip = h('div', { class: 'tw-tip', style: { display: 'none' } });
  root.append(tip);
  container.classList.add('tw-chart');
  container.append(root);

  let bars = [];
  let view = { start: 0, end: 0 }; // 可见区间 [start, end)
  let drag = null;

  const mainH = Math.round(height * 0.6);
  const volH = Math.round(height * 0.16);
  const macdH = height - mainH - volH - 22;

  function setAll() {
    const n = bars.length;
    const visible = Math.min(n, 90);
    view = { start: Math.max(0, n - visible), end: n };
  }

  function render() {
    [...root.querySelectorAll('svg')].forEach((n) => n.remove());
    const W = Math.max(240, container.clientWidth || 420);
    const H = height;
    const padL = 6;
    const padR = 50;
    const innerW = W - padL - padR;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H });

    if (bars.length < 2) {
      svg.append(s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: p.ink3, 'font-size': 12 }, '暂无K线数据'));
      root.append(svg);
      return;
    }
    const closes = bars.map((b) => b.close);
    const maLines = MA_CONFIG.map((m) => ({ ...m, values: SMA(closes, m.n) }));
    const { dif, dea, hist } = MACD(closes);

    const vis = bars.slice(view.start, view.end);
    const visIdx0 = view.start;
    const n = vis.length;
    const cw = innerW / n;
    const bodyW = Math.max(1, Math.min(14, cw * 0.68));
    const X = (i) => padL + (i + 0.5) * cw;

    const lo = Math.min(...vis.map((b) => b.low));
    const hi = Math.max(...vis.map((b) => b.high));
    const pad = (hi - lo) * 0.06 || hi * 0.01 || 1;
    const yLo = lo - pad;
    const yHi = hi + pad;
    const Y = (v) => 8 + ((yHi - v) / (yHi - yLo || 1)) * (mainH - 16);

    // 主图网格
    for (const t of niceTicks(yLo, yHi, 4)) {
      const y = Y(t);
      if (y < 6 || y > mainH - 6) continue;
      svg.append(s('line', { x1: padL, y1: y, x2: padL + innerW, y2: y, stroke: p.grid, 'stroke-width': 0.6, 'stroke-dasharray': '2 4' }));
      svg.append(s('text', { x: padL + innerW + 4, y: y + 3, fill: p.ink3, 'font-size': 9.5, 'font-family': 'var(--tw-mono)' }, fmtAxis(t, yHi - yLo)));
    }

    // 蜡烛
    for (let i = 0; i < n; i += 1) {
      const b = vis[i];
      const up = b.close >= b.open;
      const c = up === redUp ? p.up : p.down;
      const x = X(i);
      svg.append(s('line', { x1: x, y1: Y(b.high), x2: x, y2: Y(b.low), stroke: c, 'stroke-width': 1 }));
      const y1 = Y(Math.max(b.open, b.close));
      const y2 = Y(Math.min(b.open, b.close));
      const hollow = Math.abs(b.close - b.open) < 1e-9;
      svg.append(s('rect', {
        x: x - bodyW / 2,
        y: y1,
        width: bodyW,
        height: Math.max(1, y2 - y1),
        fill: hollow ? 'none' : c,
        stroke: c,
        'stroke-width': 0.9,
      }));
    }

    // 均线
    for (const line of maLines) {
      const d = [];
      for (let i = 0; i < n; i += 1) {
        const v = line.values[visIdx0 + i];
        if (!isNum(v)) continue;
        d.push(`${d.length === 0 ? 'M' : 'L'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`);
      }
      if (d.length > 0) svg.append(s('path', { d: d.join(' '), fill: 'none', stroke: line.color, 'stroke-width': 1, opacity: 0.9 }));
    }

    // 图例（当前值）
    const li = n - 1;
    let lx = padL + 2;
    for (const line of maLines) {
      const v = line.values[visIdx0 + li];
      if (!isNum(v)) continue;
      const txt = `MA${line.n} ${fmtAxis(v, yHi - yLo)}`;
      const node = s('text', { x: lx, y: 12, fill: line.color, 'font-size': 9.5, 'font-family': 'var(--tw-mono)' }, txt);
      svg.append(node);
      lx += txt.length * 5.6 + 8;
    }

    // 成交量
    const volTop = mainH + 4;
    const vols = vis.map((b) => b.vol ?? 0);
    const vmax = Math.max(...vols, 1);
    for (let i = 0; i < n; i += 1) {
      const b = vis[i];
      const up = b.close >= b.open;
      const c = up === redUp ? p.up : p.down;
      const bh = ((b.vol ?? 0) / vmax) * (volH - 14);
      svg.append(s('rect', { x: X(i) - bodyW / 2, y: volTop + (volH - 14) - bh, width: bodyW, height: Math.max(0.5, bh), fill: c, opacity: 0.7 }));
    }
    svg.append(s('text', { x: padL, y: volTop + 9, fill: p.ink3, 'font-size': 9 }, 'VOL'));

    // MACD
    const macdTop = volTop + volH + 2;
    const hVis = hist.slice(visIdx0, view.end);
    const difVis = dif.slice(visIdx0, view.end);
    const deaVis = dea.slice(visIdx0, view.end);
    const absMax = Math.max(...hVis.filter(isNum).map(Math.abs), 1e-9);
    const MY = (v) => macdTop + (macdH - 12) / 2 - (v / absMax) * ((macdH - 12) / 2);
    svg.append(s('line', { x1: padL, y1: MY(0), x2: padL + innerW, y2: MY(0), stroke: p.grid, 'stroke-width': 0.6 }));
    for (let i = 0; i < n; i += 1) {
      const v = hVis[i];
      if (!isNum(v)) continue;
      const y0 = MY(0);
      const y1 = MY(v);
      svg.append(s('rect', { x: X(i) - bodyW / 2, y: Math.min(y0, y1), width: bodyW, height: Math.max(0.6, Math.abs(y1 - y0)), fill: v >= 0 ? p.up : p.down, opacity: 0.8 }));
    }
    for (const [arr, color] of [[difVis, '#e8a33d'], [deaVis, '#3b8ff3']]) {
      const d = [];
      for (let i = 0; i < n; i += 1) {
        const v = arr[i];
        if (!isNum(v)) continue;
        d.push(`${d.length === 0 ? 'M' : 'L'}${X(i).toFixed(1)},${MY(v).toFixed(1)}`);
      }
      if (d.length > 0) svg.append(s('path', { d: d.join(' '), fill: 'none', stroke: color, 'stroke-width': 1 }));
    }
    svg.append(s('text', { x: padL, y: macdTop + 9, fill: p.ink3, 'font-size': 9 }, 'MACD(12,26,9)'));

    // 日期轴
    for (const i of [0, Math.floor(n / 2), n - 1]) {
      if (i < 0 || i >= n) continue;
      svg.append(s('text', { x: X(i), y: H - 4, fill: p.ink3, 'font-size': 9, 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle' }, vis[i].date));
    }

    // 买卖点
    if (Array.isArray(markers) && markers.length > 0) {
      const t0 = new Date(`${vis[0].date}T00:00:00`).getTime();
      const t1 = new Date(`${vis[n - 1].date}T23:59:59`).getTime();
      for (const m of markers) {
        if (m.ts < t0 || m.ts > t1) continue;
        // 找到最近的 bar
        let bi = 0;
        for (let i = 0; i < n; i += 1) {
          if (new Date(`${vis[i].date}T23:59:59`).getTime() >= m.ts) {
            bi = i;
            break;
          }
        }
        const c = m.verb === 'buy' ? (redUp ? p.up : p.down) : (redUp ? p.down : p.up);
        const y = Y(Math.min(yHi, Math.max(yLo, m.price)));
        const yy = m.verb === 'buy' ? y + 14 : y - 14;
        svg.append(s('circle', { cx: X(bi), cy: yy, r: 6.5, fill: c, opacity: 0.92 }));
        svg.append(s('text', { x: X(bi), y: yy + 3, fill: '#fff', 'font-size': 8.5, 'text-anchor': 'middle', 'font-weight': 700 }, m.verb === 'buy' ? 'B' : 'S'));
      }
    }

    // 十字光标
    const crossV = s('line', { y1: 8, y2: H - 18, stroke: p.ink3, 'stroke-width': 0.8, 'stroke-dasharray': '3 3', opacity: 0 });
    const crossH = s('line', { x1: padL, x2: padL + innerW, stroke: p.ink3, 'stroke-width': 0.8, 'stroke-dasharray': '3 3', opacity: 0 });
    svg.append(crossV, crossH);

    const overlay = s('rect', { x: padL, y: 0, width: innerW, height: H, fill: 'transparent', style: 'cursor:crosshair' });
    overlay.addEventListener('mousemove', (e) => {
      if (drag) return;
      const rect = svg.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * W;
      const i = Math.max(0, Math.min(n - 1, Math.floor((x - padL) / cw)));
      const b = vis[i];
      const px = X(i);
      crossV.setAttribute('x1', px);
      crossV.setAttribute('x2', px);
      crossV.setAttribute('opacity', 0.75);
      crossH.setAttribute('y1', Y(b.close));
      crossH.setAttribute('y2', Y(b.close));
      crossH.setAttribute('opacity', 0.75);
      const chg = b.close - b.open;
      tip.innerHTML = [
        `<b>${b.date}</b>`,
        `开 ${fmtPrice(b.open, 3)} 收 <span style="color:${colorOf(chg, redUp, p)}">${fmtPrice(b.close, 3)}</span>`,
        `高 ${fmtPrice(b.high, 3)} 低 ${fmtPrice(b.low, 3)}`,
        isNum(b.pct) ? `涨跌 ${fmtPct(b.pct)}` : '',
        isNum(b.vol) ? `量 ${fmtVol(b.vol)}` : '',
      ].filter(Boolean).join('<br>');
      tip.style.display = 'block';
      tip.style.left = `${Math.min(Math.max(4, (px / W) * rect.width + 10), Math.max(4, rect.width - tip.offsetWidth - 6))}px`;
      tip.style.top = '6px';
    });
    overlay.addEventListener('mouseleave', () => {
      if (drag) return;
      tip.style.display = 'none';
      crossV.setAttribute('opacity', 0);
      crossH.setAttribute('opacity', 0);
    });
    // 滚轮缩放
    overlay.addEventListener('wheel', (e) => {
      e.preventDefault();
      const n2 = view.end - view.start;
      const delta = e.deltaY > 0 ? Math.round(n2 * 0.15) : -Math.round(n2 * 0.15);
      const next = Math.max(12, Math.min(bars.length, n2 + delta));
      const rect = svg.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * W;
      const anchor = Math.max(0, Math.min(1, (x - padL) / innerW));
      const center = view.start + anchor * n2;
      let start = Math.round(center - anchor * next);
      start = Math.max(0, Math.min(bars.length - next, start));
      view = { start, end: start + next };
      render();
      if (onRangeChange) onRangeChange(view.end - view.start, bars.length);
    }, { passive: false });
    // 拖拽平移
    overlay.addEventListener('mousedown', (e) => {
      drag = { x: e.clientX, start: view.start, end: view.end, w: overlay.getBoundingClientRect().width || 1 };
    });
    const onMove = (e) => {
      if (!drag) return;
      const n2 = drag.end - drag.start;
      const dx = ((e.clientX - drag.x) / drag.w) * n2;
      let start = Math.round(drag.start - dx);
      start = Math.max(0, Math.min(bars.length - n2, start));
      view = { start, end: start + n2 };
      render();
    };
    overlay.addEventListener('mousemove', onMove);
    svg.append(overlay);
    root.append(svg);
  }

  // 全局 mouseup 只注册一次，避免每次重绘累积监听器
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    if (onRangeChange) onRangeChange(view.end - view.start, bars.length);
  };
  window.addEventListener('mouseup', endDrag);

  let ro = null;
  return {
    update(next) {
      const prevLen = bars.length;
      bars = Array.isArray(next) ? next : [];
      if (prevLen !== bars.length || view.end === 0) setAll();
      else view = { start: Math.max(0, bars.length - (view.end - view.start)), end: bars.length };
      if (!ro) {
        ro = new ResizeObserver(() => render());
        ro.observe(container);
      }
      render();
    },
    setRange(days) {
      if (!days || days <= 0) setAll();
      else view = { start: Math.max(0, bars.length - days), end: bars.length };
      render();
    },
    getRange() {
      return view.end - view.start;
    },
    destroy() {
      if (ro) ro.disconnect();
      window.removeEventListener('mouseup', endDrag);
      tip.remove();
    },
  };
}

/* ─────────────────── 两融走势（净买额柱 + 指数线） ───────────────────── */

/**
 * 两融走势：近期每个交易日的**融资净买额**（正负双色柱，零轴居中）
 * 叠加**参照指数**（沪深300，右轴归一化）折线。
 *
 * 为什么不做「余额柱」：两融余额是存量，90 个交易日里只在 2.6 万亿附近缓慢漂移，
 * 柱高几乎一样，视觉上传达不出信息。净买额才是流量口径，正负分明、日间差异大。
 * 余额的最新值与区间变化改由副标题承载。
 *
 * @param {HTMLElement} container
 * @param {{series:Array<{date:string,balance:number,netBuy:number,index:number|null}>, indexName?:string, height?:number}} opts
 */
export function marginChart(container, { series = [], indexName = '沪深300', redUp = true, height = 158 } = {}) {
  const p = palette();
  container.textContent = '';
  const all = (Array.isArray(series) ? series : []).filter((r) => r && typeof r.date === 'string');
  if (all.length < 2) {
    container.append(h('div', { class: 'tw-hint tw-center', style: { padding: '18px 0' }, text: '两融数据暂不可用' }));
    return;
  }
  const list = all.slice(-60);   // 面板窄，取近 60 个交易日足够看趋势

  const yi = (v) => (isNum(v) ? v / 1e8 : null);         // 元 → 亿元
  let flow = list.map((r) => yi(r.netBuy));
  const hasFlow = flow.some(isNum);
  // 净买额整体缺失时退化用余额（截断到区间极值，避免全平柱）
  if (!hasFlow) {
    const bal = list.map((r) => yi(r.balance)).filter(isNum);
    if (bal.length > 1) {
      const lo = Math.min(...bal);
      flow = list.map((r) => {
        const v = yi(r.balance);
        return isNum(v) ? v - lo : null;
      });
    }
  }
  const maxAbs = Math.max(1e-6, ...flow.filter(isNum).map(Math.abs));

  const closes = list.map((r) => (isNum(r.index) ? r.index : null));
  const validClose = closes.filter(isNum);
  const cMin = validClose.length > 1 ? Math.min(...validClose) : null;
  const cMax = validClose.length > 1 ? Math.max(...validClose) : null;
  const hasIndex = cMin !== null && cMax !== null && cMax > cMin;

  const H = height;

  withWidth(container, 640, (W) => {
    [...container.querySelectorAll('svg,.tw-legend')].forEach((n) => n.remove());
    const padL = 34;
    const padR = hasIndex ? 42 : 10;
    const padT = 16;
    const padB = 20;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const zeroY = padT + innerH / 2;
    const axisFs = W < 420 ? 7.5 : 8.5;

    // 注意：s() 走 setAttribute，style 必须是字符串
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet', style: 'width:100%;height:auto;display:block' });
    const X = (i) => padL + (list.length === 1 ? innerW / 2 : (i / (list.length - 1)) * innerW);

    // 横向网格（对称零轴）
    for (const f of [1, 0.5, 0, -0.5, -1]) {
      const y = zeroY - f * (innerH / 2);
      svg.append(s('line', { x1: padL, y1: y, x2: padL + innerW, y2: y, stroke: p.grid, 'stroke-width': f === 0 ? 0.9 : 0.6, 'stroke-dasharray': f === 0 ? 'none' : '2 4' }));
      if (f === 1 || f === 0 || f === -1) {
        const v = f * maxAbs;
        svg.append(s('text', { x: padL - 4, y: y + 3, 'text-anchor': 'end', fill: p.ink3, 'font-size': axisFs, 'font-family': 'var(--tw-mono)' }, `${v >= 0 ? '' : '-'}${Math.abs(v) >= 100 ? Math.round(Math.abs(v)) : Math.abs(v).toFixed(0)}`));
      }
    }

    // 净买额柱
    const step = innerW / Math.max(1, list.length);
    const barW = Math.max(1.2, step * 0.62);
    list.forEach((r, i) => {
      const v = flow[i];
      if (!isNum(v)) return;
      const h2 = (Math.abs(v) / maxAbs) * (innerH / 2);
      const up = v >= 0;
      const col = up === redUp ? p.up : p.down;
      const x = X(i) - barW / 2;
      svg.append(s('rect', { x, y: up ? zeroY - h2 : zeroY, width: barW, height: Math.max(h2, 0.8), rx: Math.min(1.5, barW / 3), fill: col, opacity: 0.85 }));
    });

    // 指数折线（右轴归一化）
    if (hasIndex) {
      const Y = (v) => padT + (1 - (v - cMin) / (cMax - cMin)) * innerH;
      let d = '';
      let started = false;
      closes.forEach((v, i) => {
        if (!isNum(v)) {
          started = false;
          return;
        }
        d += `${started ? 'L' : 'M'}${X(i).toFixed(2)},${Y(v).toFixed(2)} `;
        started = true;
      });
      if (d) {
        svg.append(s('path', { d: d.trim(), fill: 'none', stroke: p.accent, 'stroke-width': 1.3, 'stroke-linejoin': 'round', opacity: 0.9 }));
        const lastIdx = closes.reduce((acc, v, i) => (isNum(v) ? i : acc), -1);
        if (lastIdx >= 0) svg.append(s('circle', { cx: X(lastIdx), cy: Y(closes[lastIdx]), r: 2, fill: p.accent }));
        svg.append(s('text', { x: padL + innerW + 3, y: padT + 6, 'text-anchor': 'start', fill: p.accent, 'font-size': axisFs }, indexName));
        svg.append(s('text', { x: padL + innerW + 3, y: padT + 17, 'text-anchor': 'start', fill: p.ink3, 'font-size': axisFs - 0.5, 'font-family': 'var(--tw-mono)' }, String(Math.round(cMax))));
        svg.append(s('text', { x: padL + innerW + 3, y: padT + innerH, 'text-anchor': 'start', fill: p.ink3, 'font-size': axisFs - 0.5, 'font-family': 'var(--tw-mono)' }, String(Math.round(cMin))));
      }
    }

    // 首尾日期
    svg.append(s('text', { x: padL, y: H - 5, 'text-anchor': 'start', fill: p.ink3, 'font-size': 8, 'font-family': 'var(--tw-mono)' }, list[0].date.slice(5)));
    svg.append(s('text', { x: padL + innerW, y: H - 5, 'text-anchor': 'end', fill: p.ink3, 'font-size': 8, 'font-family': 'var(--tw-mono)' }, list[list.length - 1].date.slice(5)));

    container.append(svg);

    container.append(
      h('div', { class: 'tw-legend' },
        h('span', { class: 'tw-legend-i' }, h('i', { class: 'sw up' }), hasFlow ? '融资净买额（亿元）' : '两融余额（区间）'),
        hasIndex ? h('span', { class: 'tw-legend-i' }, h('i', { class: 'sw line' }), indexName) : null,
      ),
    );
  });
}

/** palette 里 up/down 已按当前主题解析 */

/* ─────────────────── 涨跌家数分时（上涨 / 下跌面积） ─────────────────── */

/**
 * 全市场上涨/下跌家数的日内分时。
 *
 * 数据来源是 service worker 按分钟**累积采样**（免费源没有历史端点），
 * 所以当天首次打开时曲线很短，需要挂着才逐渐完整 —— 因此点位少时要给出明确提示，
 * 而不是画一条看起来「坏了」的直线。
 *
 * 横轴用 `p`（sessionPos 归一化的交易时段进度，午休已折叠），
 * 刻度用 `sessionLabel` 反查真实钟点。
 *
 * @param {HTMLElement} container
 * @param {{points:Array<{t:number,p:number,up:number,down:number,flat?:number}>, prevPoints?:Array, prevDate?:string|null, height?:number}} opts
 */
export function breadthChart(container, { points = [], prevPoints = [], prevDate = null, height = 158 } = {}) {
  const p = palette();
  container.textContent = '';
  const pts = (Array.isArray(points) ? points : [])
    .filter((d) => isNum(d?.p) && isNum(d?.up) && isNum(d?.down))
    .sort((a, b) => a.p - b.p);
  const prev = (Array.isArray(prevPoints) ? prevPoints : [])
    .filter((d) => isNum(d?.p) && isNum(d?.up))
    .sort((a, b) => a.p - b.p);

  if (pts.length < 2) {
    container.append(
      h('div', { class: 'tw-empty', style: { padding: '16px 0', fontSize: '11px' } },
        prev.length > 1 ? `今日采样累积中（已 ${pts.length} 点）· 下方虚线为 ${prevDate ?? '上一交易日'} 对照` : '上涨/下跌家数分时累积中：免费源没有历史端点，面板打开期间每分钟采样一次、约 3 分钟出一个点（需东财行情主机可用）。'),
    );
    // 只有昨日数据时也画出来，至少不是空白
    if (prev.length > 1) withWidth(container, 640, draw);
    return;
  }
  withWidth(container, 640, draw);

  function draw(W) {
    [...container.querySelectorAll('svg,.tw-legend')].forEach((n) => n.remove());
    const H = height;
    const padL = 30;
    const padR = 8;
    const padT = 16;
    const padB = 20;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const vals = [...pts.map((d) => d.up), ...pts.map((d) => d.down), ...prev.map((d) => d.up)];
    const max = Math.max(1, ...vals);
    const top = max * 1.08;
    const Y = (v) => padT + (1 - v / top) * innerH;
    const X = (q) => padL + Math.max(0, Math.min(1, q)) * innerW;
    const axisFs = W < 420 ? 7.5 : 8.5;

    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet', style: 'width:100%;height:auto;display:block' });

    for (const t of niceTicks(0, max, 3)) {
      const y = Y(t);
      svg.append(s('line', { x1: padL, y1: y, x2: padL + innerW, y2: y, stroke: p.grid, 'stroke-width': 0.6, 'stroke-dasharray': '2 4' }));
      svg.append(s('text', { x: padL - 4, y: y + 3, 'text-anchor': 'end', fill: p.ink3, 'font-size': axisFs, 'font-family': 'var(--tw-mono)' }, String(Math.round(t))));
    }
    // 时段刻度（午休折叠后均匀铺开）
    for (const q of [0, 0.25, 0.5, 0.75, 1]) {
      const x = X(q);
      svg.append(s('line', { x1: x, y1: padT, x2: x, y2: padT + innerH, stroke: p.grid, 'stroke-width': 0.5, 'stroke-dasharray': '2 4', opacity: 0.7 }));
      svg.append(s('text', { x, y: padT + innerH + 11, 'text-anchor': q === 0 ? 'start' : q === 1 ? 'end' : 'middle', fill: p.ink3, 'font-size': axisFs - 0.5, 'font-family': 'var(--tw-mono)' }, sessionLabel(q)));
    }

    // 昨日上涨家数（虚线对照）
    if (prev.length > 1) {
      svg.append(s('path', { d: linePath(prev.map((d) => [X(d.p), Y(d.up)]), false), fill: 'none', stroke: p.ink3, 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.65 }));
    }

    // 今日上涨 / 下跌（pts 可能为空 —— 比如当天还没采到点、只有昨日数据）
    if (pts.length > 0) {
      // 下跌画在下层，避免遮住上涨线
      svg.append(s('path', { d: areaPath(pts.map((d) => [X(d.p), Y(d.down)]), padT + innerH), fill: p.down, opacity: 0.1 }));
      svg.append(s('path', { d: linePath(pts.map((d) => [X(d.p), Y(d.down)])), fill: 'none', stroke: p.down, 'stroke-width': 1.3, 'stroke-linejoin': 'round' }));

      svg.append(s('path', { d: areaPath(pts.map((d) => [X(d.p), Y(d.up)]), padT + innerH), fill: p.up, opacity: 0.12 }));
      svg.append(s('path', { d: linePath(pts.map((d) => [X(d.p), Y(d.up)])), fill: 'none', stroke: p.up, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));

      const last = pts[pts.length - 1];
      svg.append(s('circle', { cx: X(last.p), cy: Y(last.up), r: 2.2, fill: p.up }));
      svg.append(s('circle', { cx: X(last.p), cy: Y(last.down), r: 2.2, fill: p.down }));
    }

    container.append(svg);

    const last = pts[pts.length - 1] ?? null;
    container.append(
      h('div', { class: 'tw-legend' },
        last ? h('span', { class: 'tw-legend-i' }, h('i', { class: 'sw up' }), `上涨 ${fmtInt(last.up)}`) : null,
        last ? h('span', { class: 'tw-legend-i' }, h('i', { class: 'sw down' }), `下跌 ${fmtInt(last.down)}`) : null,
        prev.length > 1 ? h('span', { class: 'tw-legend-i' }, h('i', { class: 'sw dash' }), `${prevDate ?? '上日'}上涨`) : null,
        h('span', { class: 'tw-hint', style: { marginLeft: 'auto' }, text: `${pts.length} 点采样` }),
      ),
    );
  }
}

function linePath(pairs, move = true) {
  return pairs.map(([x, y], i) => `${i === 0 && move ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
}

function areaPath(pairs, baseY) {
  if (pairs.length === 0) return '';
  const head = `M${pairs[0][0].toFixed(2)},${pairs[0][1].toFixed(2)}`;
  const body = pairs.slice(1).map(([x, y]) => `L${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const tail = ` L${pairs[pairs.length - 1][0].toFixed(2)},${baseY.toFixed(2)} L${pairs[0][0].toFixed(2)},${baseY.toFixed(2)} Z`;
  return `${head} ${body}${tail}`;
}
