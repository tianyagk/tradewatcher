/**
 * 数据层：偏好 / 自选 / 持仓 / 流水账本 / 预警。
 * 全部落在 chrome.storage.local；持仓的数量与成本「不落盘」，一律由流水推导。
 */
import { DEFAULT_PREFS, KEYS, WATCH_SEED, makeAlert, uid } from '../shared/model.js';
import { get, set, getMerged } from './storage.js';

/* ─────────────────────────────── 偏好 ────────────────────────────────── */

export async function getPrefs() {
  const prefs = await getMerged(KEYS.prefs, DEFAULT_PREFS);
  prefs.rescue = { ...DEFAULT_PREFS.rescue, ...(prefs.rescue ?? {}) };
  return prefs;
}

export async function setPrefs(patch) {
  const cur = await getPrefs();
  const next = { ...cur, ...patch };
  if (patch && patch.rescue) next.rescue = { ...cur.rescue, ...patch.rescue };
  await set(KEYS.prefs, next);
  return next;
}

/* ─────────────────────────────── 自选 ────────────────────────────────── */

async function defaultWatch() {
  const groupId = uid('wg');
  return {
    v: 1,
    groups: [{ id: groupId, name: '我的自选', order: 0 }],
    items: WATCH_SEED.map((s, i) => ({
      id: uid('wi'),
      groupId,
      secid: s.secid,
      name: s.name,
      createdAt: Date.now() + i,
    })),
  };
}

export async function getWatch() {
  let w = await get(KEYS.watch, null);
  if (!w || !Array.isArray(w.groups) || !Array.isArray(w.items)) {
    w = await defaultWatch();
    await set(KEYS.watch, w);
  }
  return w;
}

export async function mutateWatch(body) {
  const w = await getWatch();
  const op = body?.op;
  switch (op) {
    case 'addGroup': {
      const name = String(body.name || '新分组').trim() || '新分组';
      w.groups.push({ id: uid('wg'), name, order: w.groups.length, note: body.note });
      break;
    }
    case 'renameGroup': {
      const g = w.groups.find((x) => x.id === body.groupId);
      if (g && body.name) g.name = String(body.name).trim();
      break;
    }
    case 'noteGroup': {
      const g = w.groups.find((x) => x.id === body.groupId);
      if (g) g.note = body.note ?? '';
      break;
    }
    case 'archiveGroup': {
      const ts = w.groups.filter((g) => g.archived).length;
      if (ts >= w.groups.length - 1) throw new Error('至少保留一个分组');
      const g = w.groups.find((x) => x.id === body.groupId);
      if (g) g.archived = true;
      break;
    }
    case 'restoreGroup': {
      const g = w.groups.find((x) => x.id === body.groupId);
      if (g) delete g.archived;
      break;
    }
    case 'moveGroup': {
      const g = w.groups.find((x) => x.id === body.groupId);
      if (g && Number.isFinite(body.order)) g.order = body.order;
      break;
    }
    case 'addItem': {
      const secid = String(body.secid ?? '').toUpperCase();
      if (!secid) throw new Error('缺少代码');
      const groupId = body.groupId || w.groups.find((g) => !g.archived)?.id;
      if (!groupId) throw new Error('请先创建分组');
      if (w.items.some((i) => i.secid === secid)) throw new Error('该标的已在自选中');
      w.items.push({ id: uid('wi'), groupId, secid, name: body.symbolName || secid, note: body.note, createdAt: Date.now() });
      break;
    }
    case 'editItem': {
      const it = w.items.find((x) => x.id === body.itemId);
      if (it) {
        if (body.symbolName) it.name = body.symbolName;
        if (body.note !== undefined) it.note = body.note;
      }
      break;
    }
    case 'moveItem': {
      const it = w.items.find((x) => x.id === body.itemId);
      if (it && body.groupId) it.groupId = body.groupId;
      break;
    }
    case 'removeItem': {
      w.items = w.items.filter((x) => x.id !== body.itemId);
      break;
    }
    default:
      throw new Error(`未知操作 ${op}`);
  }
  await set(KEYS.watch, w);
  return w;
}

/* ─────────────────────────────── 持仓 ────────────────────────────────── */

async function defaultPortfolio() {
  return { v: 1, groups: [{ id: uid('pg'), name: '默认账户', order: 0 }], items: [] };
}

export async function getPortfolio() {
  let p = await get(KEYS.portfolio, null);
  if (!p || !Array.isArray(p.groups) || !Array.isArray(p.items)) {
    p = await defaultPortfolio();
    await set(KEYS.portfolio, p);
  }
  return p;
}

export async function getLedger() {
  const l = await get(KEYS.ledger, null);
  if (!l || !Array.isArray(l.entries)) return { v: 1, entries: [] };
  return l;
}

async function appendLedger(entries) {
  const l = await getLedger();
  l.entries.push(...entries);
  // 控制体积：保留最近 20000 条
  if (l.entries.length > 20000) l.entries = l.entries.slice(l.entries.length - 20000);
  await set(KEYS.ledger, l);
  return l;
}

const entry = (verb, patch) => ({ id: uid('lg'), ts: Date.now(), actor: 'ui', verb, ...patch });

export async function mutatePortfolio(body) {
  const p = await getPortfolio();
  const op = body?.op;
  const logs = [];
  switch (op) {
    case 'addGroup': {
      const name = String(body.name || '新账户').trim() || '新账户';
      const g = { id: uid('pg'), name, order: p.groups.length, note: body.note };
      p.groups.push(g);
      logs.push(entry('gcreate', { groupId: g.id, name }));
      break;
    }
    case 'renameGroup': {
      const g = p.groups.find((x) => x.id === body.groupId);
      if (g && body.name) {
        const old = g.name;
        g.name = String(body.name).trim();
        logs.push(entry('grename', { groupId: g.id, name: g.name, meta: { old } }));
      }
      break;
    }
    case 'noteGroup': {
      const g = p.groups.find((x) => x.id === body.groupId);
      if (g) {
        g.note = body.note ?? '';
        logs.push(entry('pnote', { groupId: g.id, note: g.note, meta: { scope: 'group' } }));
      }
      break;
    }
    case 'archiveGroup': {
      const live = p.groups.filter((g) => !g.archived);
      if (live.length <= 1) throw new Error('至少保留一个账户');
      const g = p.groups.find((x) => x.id === body.groupId);
      if (g) {
        g.archived = true;
        logs.push(entry('gdelete', { groupId: g.id, name: g.name }));
      }
      break;
    }
    case 'restoreGroup': {
      const g = p.groups.find((x) => x.id === body.groupId);
      if (g) {
        delete g.archived;
        logs.push(entry('grestore', { groupId: g.id, name: g.name }));
      }
      break;
    }
    case 'addPos': {
      const secid = String(body.secid ?? '').toUpperCase();
      if (!secid) throw new Error('缺少代码');
      const groupId = body.groupId || p.groups.find((g) => !g.archived)?.id;
      if (!groupId) throw new Error('请先创建账户');
      if (p.items.some((i) => i.secid === secid && i.groupId === groupId)) throw new Error('该标已在此账户中');
      const item = { id: uid('pi'), groupId, secid, name: body.symbolName || secid, note: body.note, createdAt: Date.now() };
      p.items.push(item);
      logs.push(entry('add', { groupId, posId: item.id, secid, name: item.name }));
      break;
    }
    case 'editPos': {
      const it = p.items.find((x) => x.id === body.posId);
      if (it) {
        if (body.symbolName) it.name = body.symbolName;
        if (body.note !== undefined) it.note = body.note;
        if (body.groupId) it.groupId = body.groupId;
      }
      break;
    }
    case 'removePos': {
      const it = p.items.find((x) => x.id === body.posId);
      if (!it) break;
      const qty = netQty(await getLedger(), it.id);
      if (Math.abs(qty) > 1e-9) throw new Error('请先卖出至数量为 0 再移除持仓');
      p.items = p.items.filter((x) => x.id !== body.posId);
      logs.push(entry('remove', { groupId: it.groupId, posId: it.id, secid: it.secid, name: it.name }));
      break;
    }
    case 'buy':
    case 'sell': {
      const it = p.items.find((x) => x.id === body.posId);
      if (!it) throw new Error('持仓不存在');
      const qty = Number(body.qty);
      const price = Number(body.price);
      const fee = Number(body.fee) || 0;
      if (!Number.isFinite(qty) || qty <= 0) throw new Error('数量必须为正数');
      if (!Number.isFinite(price) || price < 0) throw new Error('价格无效');
      if (op === 'sell') {
        const held = netQty(await getLedger(), it.id);
        if (qty > held + 1e-9) throw new Error(`卖出数量超过持仓（当前 ${held}）`);
      }
      logs.push(entry(op, { groupId: it.groupId, posId: it.id, secid: it.secid, name: it.name, qty, price, fee, ts: Number(body.ts) || Date.now() }));
      break;
    }
    case 'adjust': {
      const it = p.items.find((x) => x.id === body.posId);
      if (!it) throw new Error('持仓不存在');
      logs.push(
        entry('adjust', {
          groupId: it.groupId,
          posId: it.id,
          secid: it.secid,
          name: it.name,
          qty: Number(body.qty),
          price: Number.isFinite(Number(body.price)) ? Number(body.price) : undefined,
          note: body.note,
          ts: Number(body.ts) || Date.now(),
        }),
      );
      break;
    }
    default:
      throw new Error(`未知操作 ${op}`);
  }
  await set(KEYS.portfolio, p);
  if (logs.length > 0) await appendLedger(logs);
  return p;
}

/** 某持仓当前净数量（由流水推导） */
export function netQty(ledger, posId) {
  let qty = 0;
  for (const e of ledger.entries) {
    if (e.posId !== posId) continue;
    if (e.verb === 'buy') qty += e.qty ?? 0;
    else if (e.verb === 'sell') qty -= e.qty ?? 0;
    else if (e.verb === 'adjust') qty = e.qty ?? qty;
  }
  return Math.round(qty * 10000) / 10000;
}

/* ────────────────────── 流水重放 → 持仓核算 ──────────────────────────── */

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 单只持仓核算（纯函数）。
 *  - avgCost：买入移动加权均价（含买入费用；卖出不改成本）
 *  - dilutedCost：摊薄成本 = (累计买入含费 − 累计卖出净额) ÷ 剩余数量
 *  - realized：卖出时确认的已实现盈亏（扣卖出费用）
 *  - 恒等式：dilutedPnl = floatPnl + realized
 */
export function accounting(entries, quote, today) {
  let qty = 0;
  let avgCost = 0;
  let buyGross = 0;
  let sellNet = 0;
  let realized = 0;
  let feesToday = 0;
  let buyQtyToday = 0;
  let sellQtyToday = 0;
  let buyCostToday = 0;

  const sorted = [...entries].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  for (const e of sorted) {
    const q = Number(e.qty) || 0;
    const price = Number(e.price) || 0;
    const fee = Number(e.fee) || 0;
    const isToday = today !== undefined && dayKey(e.ts ?? Date.now()) === today;
    if (e.verb === 'buy') {
      const cost = price * q + fee;
      const newQty = qty + q;
      avgCost = newQty > 0 ? (avgCost * qty + cost) / newQty : 0;
      buyGross += cost;
      qty = newQty;
      if (isToday) {
        feesToday += fee;
        buyQtyToday += q;
        buyCostToday += cost;
      }
    } else if (e.verb === 'sell') {
      const proceeds = price * q - fee;
      sellNet += proceeds;
      realized += proceeds - avgCost * q;
      qty -= q;
      if (isToday) {
        feesToday += fee;
        sellQtyToday += q;
      }
    } else if (e.verb === 'adjust') {
      if (Number.isFinite(q)) qty = q;
      if (Number.isFinite(Number(e.price))) {
        // 成本修正：把均价直接改写为给定值（不影响已实现）
        avgCost = Number(e.price);
      }
    }
  }
  qty = Math.round(qty * 10000) / 10000;
  if (qty < 1e-9) qty = 0;

  const price = quote?.price ?? null;
  const prev = quote?.prev ?? null;
  const dilutedCost = qty > 0 ? (buyGross - sellNet) / qty : null;
  const mv = price !== null && qty > 0 ? price * qty : 0;
  const floatPnl = price !== null && qty > 0 ? (price - avgCost) * qty : 0;
  const floatPnlPct = avgCost > 0 && qty > 0 ? (floatPnl / (avgCost * qty)) * 100 : null;
  const dilutedPnl = dilutedCost !== null && price !== null && qty > 0 ? (price - dilutedCost) * qty : null;
  const dilutedPnlPct = dilutedCost !== null && dilutedCost !== 0 && dilutedPnl !== null ? (dilutedPnl / (Math.abs(dilutedCost) * qty)) * 100 : null;

  // 当日盈亏：隔夜持仓相对昨收 + 今日买入相对成本 + 今日卖出相对昨收 − 今日费用
  let dayPnl = 0;
  let dayOk = false;
  const qtyOvernight = qty - buyQtyToday + sellQtyToday;
  if (prev !== null && price !== null) {
    dayOk = true;
    dayPnl += (price - prev) * qtyOvernight;
  }
  for (const e of sorted) {
    if (dayKey(e.ts ?? Date.now()) !== today) continue;
    if (e.verb === 'buy' && price !== null) dayPnl += (price - (Number(e.price) || 0)) * (Number(e.qty) || 0);
    if (e.verb === 'sell' && prev !== null) dayPnl += ((Number(e.price) || 0) - prev) * (Number(e.qty) || 0);
  }
  dayPnl -= feesToday;
  const dayBase = (prev !== null ? qtyOvernight * prev : 0) + buyCostToday;
  const dayPnlPct = dayOk && dayBase > 0 ? (dayPnl / dayBase) * 100 : null;

  return {
    qty,
    avgCost,
    dilutedCost,
    realized,
    buyGross,
    sellNet,
    mv,
    floatPnl,
    floatPnlPct,
    dilutedPnl,
    dilutedPnlPct,
    dayPnl: dayOk ? dayPnl : 0,
    dayPnlPct,
    price,
    prev,
    pct: quote?.pct ?? null,
    chg: quote?.chg ?? null,
    qtyOvernight,
  };
}

/** 组装持仓视图 */
export function assemblePortfolio(groups, items, ledger, quotes, today = dayKey(Date.now())) {
  const live = items.filter((i) => groups.some((g) => g.id === i.groupId && !g.archived));
  const positions = [];
  for (const it of live) {
    const entries = ledger.entries.filter((e) => e.posId === it.id && (e.verb === 'buy' || e.verb === 'sell' || e.verb === 'adjust'));
    if (entries.length === 0) {
      // 只有持仓记录、没有流水：按 0 数量占位（提示补录）
      const q = quotes[it.secid];
      positions.push({
        posId: it.id, groupId: it.groupId, secid: it.secid, name: it.name, note: it.note,
        qty: 0, avgCost: 0, dilutedCost: null, realized: 0, mv: 0, floatPnl: 0, floatPnlPct: null,
        dilutedPnl: null, dilutedPnlPct: null, dayPnl: 0, dayPnlPct: null,
        price: q?.price ?? null, prev: q?.prev ?? null, pct: q?.pct ?? null, chg: q?.chg ?? null,
        empty: true, qtyOvernight: 0,
      });
      continue;
    }
    const acc = accounting(entries, quotes[it.secid], today);
    positions.push({ posId: it.id, groupId: it.groupId, secid: it.secid, name: it.name, note: it.note, ...acc });
  }

  const groupViews = groups
    .filter((g) => !g.archived)
    .map((g) => {
      const rows = positions.filter((p) => p.groupId === g.id);
      const sum = (f) => rows.reduce((a, r) => a + (Number(r[f]) || 0), 0);
      return {
        id: g.id, name: g.name, order: g.order ?? 0, note: g.note,
        totalMv: sum('mv'),
        floatPnl: sum('floatPnl'),
        dilutedPnl: sum('dilutedPnl'),
        dayPnl: sum('dayPnl'),
        realized: sum('realized'),
        count: rows.filter((r) => r.qty > 0 || r.empty).length,
      };
    });

  const allLive = positions.filter((p) => p.qty > 0 || p.empty);
  const sumAll = (f) => allLive.reduce((a, r) => a + (Number(r[f]) || 0), 0);
  return {
    generatedAt: Date.now(),
    groups: groupViews,
    positions: positions.filter((p) => p.qty > 0 || p.empty),
    grand: {
      totalMv: sumAll('mv'),
      floatPnl: sumAll('floatPnl'),
      dilutedPnl: sumAll('dilutedPnl'),
      dayPnl: sumAll('dayPnl'),
      realized: sumAll('realized'),
      cost: allLive.reduce((a, r) => a + (r.qty > 0 && r.avgCost > 0 ? r.avgCost * r.qty : 0), 0),
    },
  };
}

/** 某只标的的买卖点（供 K 线标注） */
export function tradesOf(ledger, secid, positions) {
  const posName = new Map(positions.map((p) => [p.posId, p.name]));
  return ledger.entries
    .filter((e) => (e.verb === 'buy' || e.verb === 'sell') && e.secid === secid && Number.isFinite(e.price) && Number.isFinite(e.qty))
    .map((e) => ({
      id: e.id,
      ts: e.ts,
      verb: e.verb,
      qty: e.qty,
      price: e.price,
      posName: (e.posId && posName.get(e.posId)) || e.name || null,
    }))
    .sort((a, b) => a.ts - b.ts);
}

/** 流水视图（含分组/持仓名） */
export function ledgerView(ledger, groups, items, { groupId, posId, limit = 300 } = {}) {
  const gName = new Map(groups.map((g) => [g.id, g.name]));
  const pName = new Map(items.map((p) => [p.id, p.name]));
  return ledger.entries
    .filter((e) => (groupId === undefined || e.groupId === groupId) && (posId === undefined || e.posId === posId))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      ts: e.ts,
      verb: e.verb,
      groupName: e.groupId ? gName.get(e.groupId) ?? null : null,
      posName: e.posId ? pName.get(e.posId) ?? e.name ?? null : e.name ?? null,
      secid: e.secid,
      qty: e.qty,
      price: e.price,
      fee: e.fee,
      note: e.note,
      actor: e.actor,
    }));
}

/** 删除某条流水（纠错用） */
export async function deleteLedgerEntry(id) {
  const l = await getLedger();
  l.entries = l.entries.filter((e) => e.id !== id);
  await set(KEYS.ledger, l);
  return l;
}

/* ─────────────────────────────── 预警 ────────────────────────────────── */

export async function getAlerts() {
  const a = await get(KEYS.alerts, null);
  return Array.isArray(a) ? a : [];
}

export async function mutateAlerts(body) {
  let list = await getAlerts();
  switch (body?.op) {
    case 'add':
      list.push(makeAlert(body.alert ?? {}));
      break;
    case 'update': {
      const i = list.findIndex((x) => x.id === body.id);
      if (i >= 0) list[i] = { ...list[i], ...(body.patch ?? {}) };
      break;
    }
    case 'remove':
      list = list.filter((x) => x.id !== body.id);
      break;
    case 'toggle': {
      const a = list.find((x) => x.id === body.id);
      if (a) a.enabled = !a.enabled;
      break;
    }
    case 'clearLog':
      await set(KEYS.alertLog, []);
      return list;
    default:
      break;
  }
  await set(KEYS.alerts, list);
  return list;
}

export async function getAlertLog() {
  const l = await get(KEYS.alertLog, null);
  return Array.isArray(l) ? l : [];
}

export async function pushAlertLog(rec) {
  const l = await getAlertLog();
  l.unshift(rec);
  await set(KEYS.alertLog, l.slice(0, 200));
  return l;
}

/* ────────────────────────────── 导入导出 ─────────────────────────────── */

export async function exportAll() {
  const [prefs, watch, portfolio, ledger, alerts] = await Promise.all([
    getPrefs(), getWatch(), getPortfolio(), getLedger(), getAlerts(),
  ]);
  return { v: 1, exportedAt: Date.now(), prefs, watch, portfolio, ledger, alerts };
}

export async function importAll(data, { merge = false } = {}) {
  if (!data || typeof data !== 'object') throw new Error('数据格式不正确');
  if (data.prefs && !merge) await set(KEYS.prefs, { ...DEFAULT_PREFS, ...data.prefs });
  if (data.watch && Array.isArray(data.watch.groups)) await set(KEYS.watch, data.watch);
  if (data.portfolio && Array.isArray(data.portfolio.groups)) await set(KEYS.portfolio, data.portfolio);
  if (data.ledger && Array.isArray(data.ledger.entries)) {
    if (merge) {
      const cur = await getLedger();
      const ids = new Set(cur.entries.map((e) => e.id));
      cur.entries.push(...data.ledger.entries.filter((e) => !ids.has(e.id)));
      await set(KEYS.ledger, cur);
    } else {
      await set(KEYS.ledger, data.ledger);
    }
  }
  if (data.alerts && Array.isArray(data.alerts)) {
    if (merge) {
      const cur = await getAlerts();
      const ids = new Set(cur.map((e) => e.id));
      await set(KEYS.alerts, [...cur, ...data.alerts.filter((e) => !ids.has(e.id))]);
    } else {
      await set(KEYS.alerts, data.alerts);
    }
  }
  return true;
}

export async function resetAll() {
  await set(KEYS.prefs, DEFAULT_PREFS);
  await set(KEYS.watch, await defaultWatch());
  await set(KEYS.portfolio, await defaultPortfolio());
  await set(KEYS.ledger, { v: 1, entries: [] });
  await set(KEYS.alerts, []);
  await set(KEYS.alertLog, []);
  await set(KEYS.calendar, { v: 1, events: [], syncedAt: 0 });
}
