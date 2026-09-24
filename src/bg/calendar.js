/**
 * 财经日历：自动同步（东财数据中心）+ 手动事件。
 * 自动来源（免费公开接口，6 小时缓存）：
 *   · 新股申购 / 上市（全市场）
 *   · 自选 + 持仓标的的财报预约披露、分红除权
 * 手动事件用于补录源里没有的日程（如海外 CPI、未上市公司 IPO、自定义提醒）。
 */
import { KEYS } from '../shared/model.js';
import { get, set } from './storage.js';
import { fetchAny } from './em.js';
import { uid } from '../shared/model.js';

const DC_HOSTS = ['datacenter-web.eastmoney.com'];
const SYNC_TTL = 6 * 3600 * 1000;

function dstr(v) {
  if (!v) return null;
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function shiftDay(days, base = Date.now()) {
  const d = new Date(base + days * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function dc(reportName, { filter = '', sortColumns = '', sortTypes = '-1', pageSize = 200, pageNumber = 1 } = {}) {
  const parts = [
    `reportName=${reportName}`,
    'columns=ALL',
    `pageSize=${pageSize}`,
    `pageNumber=${pageNumber}`,
    'source=WEB',
    'client=WEB',
  ];
  if (sortColumns) parts.push(`sortColumns=${sortColumns}`, `sortTypes=${sortTypes}`);
  if (filter) parts.push(`filter=${encodeURIComponent(filter)}`);
  const json = await fetchAny(DC_HOSTS, `/api/data/v1/get?${parts.join('&')}`, 9000, 20000);
  return Array.isArray(json?.result?.data) ? json.result.data : [];
}

function codeOf(secid) {
  const i = String(secid).indexOf('.');
  if (i <= 0) return null;
  const mkt = secid.slice(0, i);
  const code = secid.slice(i + 1);
  if (mkt !== '0' && mkt !== '1') return null;
  return code;
}

/* ───────────────────────────── 自动同步 ──────────────────────────────── */

async function syncIpo(window) {
  const out = [];
  const rows = await dc('RPTA_APP_IPOAPPLY', { sortColumns: 'APPLY_DATE', sortTypes: '-1', pageSize: 120 });
  for (const r of rows) {
    const name = r.SECURITY_NAME_ABBR ?? r.SECURITY_CODE;
    const apply = dstr(r.APPLY_DATE);
    const listing = dstr(r.LISTING_DATE);
    if (apply && inWindow(apply, window)) {
      out.push({
        id: uid('cal'),
        date: apply,
        title: `新股申购 · ${name}（${r.SECURITY_CODE}）`,
        category: 'ipo',
        importance: 2,
        note: `${r.TRADE_MARKET ?? ''} 申购`,
        symbol: r.SECURITY_CODE,
        source: 'auto',
        autoKey: `ipo-apply:${r.SECURITY_CODE}:${apply}`,
      });
    }
    if (listing && inWindow(listing, window)) {
      out.push({
        id: uid('cal'),
        date: listing,
        title: `新股上市 · ${name}（${r.SECURITY_CODE}）`,
        category: 'ipo',
        importance: 3,
        note: `${r.TRADE_MARKET ?? ''} 上市首日`,
        symbol: r.SECURITY_CODE,
        source: 'auto',
        autoKey: `ipo-list:${r.SECURITY_CODE}:${listing}`,
      });
    }
  }
  return out;
}

async function syncEarnings(codes, window) {
  if (codes.length === 0) return [];
  const out = [];
  const filter = `(SECURITY_CODE in (${codes.map((c) => `"${c}"`).join(',')}))`;
  const rows = await dc('RPT_PUBLIC_BS_APPOIN', { filter, pageSize: 300 });
  for (const r of rows) {
    const name = r.SECURITY_NAME_ABBR ?? r.SECURITY_CODE;
    const plan = dstr(r.FIRST_APPOINT_DATE);
    const actual = dstr(r.ACTUAL_PUBLISH_DATE);
    const reportName = String(r.REPORT_DATE ?? '').slice(0, 10);
    if (actual && inWindow(actual, window) && !r.FIRST_CHANGE_DATE) {
      out.push({
        id: uid('cal'),
        date: actual,
        title: `财报披露 · ${name}（${reportTypeLabel(r.REPORT_TYPE)}）`,
        category: 'earnings',
        importance: 3,
        note: `报告期 ${reportName}`,
        symbol: r.SECURITY_CODE,
        source: 'auto',
        autoKey: `earn:${r.SECURITY_CODE}:${actual}:${reportName}`,
      });
    } else if (plan && inWindow(plan, window) && plan !== actual) {
      out.push({
        id: uid('cal'),
        date: plan,
        title: `财报预约披露 · ${name}（${reportTypeLabel(r.REPORT_TYPE)}）`,
        category: 'earnings',
        importance: 2,
        note: `报告期 ${reportName}（计划日，可能变更）`,
        symbol: r.SECURITY_CODE,
        source: 'auto',
        autoKey: `earn-plan:${r.SECURITY_CODE}:${plan}:${reportName}`,
      });
    }
  }
  return out;
}

function reportTypeLabel(t) {
  return { 1: '一季报', 2: '中报', 3: '三季报', 4: '年报' }[String(t)] ?? '定期报告';
}

async function syncDividend(codes, window) {
  if (codes.length === 0) return [];
  const out = [];
  const filter = `(SECURITY_CODE in (${codes.map((c) => `"${c}"`).join(',')}))`;
  const rows = await dc('RPT_SHAREBONUS_DET', { filter, pageSize: 300 });
  for (const r of rows) {
    const name = r.SECURITY_NAME_ABBR ?? r.SECURITY_CODE;
    const ex = dstr(r.EX_DIVIDEND_DATE);
    const record = dstr(r.EQUITY_RECORD_DATE);
    const plan = dstr(r.PLAN_NOTICE_DATE);
    const cash = r.PRETAX_BONUS_RMB;
    const note = cash !== null && cash !== undefined ? `每10股派 ${Number(cash).toFixed(2)} 元（税前）` : '分红送转';
    if (record && inWindow(record, window)) {
      out.push({ id: uid('cal'), date: record, title: `股权登记日 · ${name}`, category: 'dividend', importance: 3, note, symbol: r.SECURITY_CODE, source: 'auto', autoKey: `div-rec:${r.SECURITY_CODE}:${record}` });
    }
    if (ex && inWindow(ex, window)) {
      out.push({ id: uid('cal'), date: ex, title: `除权除息日 · ${name}`, category: 'dividend', importance: 2, note, symbol: r.SECURITY_CODE, source: 'auto', autoKey: `div-ex:${r.SECURITY_CODE}:${ex}` });
    }
    if (plan && inWindow(plan, window)) {
      out.push({ id: uid('cal'), date: plan, title: `分红预案公告 · ${name}`, category: 'dividend', importance: 1, note, symbol: r.SECURITY_CODE, source: 'auto', autoKey: `div-plan:${r.SECURITY_CODE}:${plan}` });
    }
  }
  return out;
}

function inWindow(date, window) {
  return date >= window.from && date <= window.to;
}

/** 同步：返回完整事件库 */
export async function sync({ codes = [], force = false } = {}) {
  const cur = await getCal();
  if (!force && cur.syncedAt && Date.now() - cur.syncedAt < SYNC_TTL) return cur;
  const window = { from: shiftDay(-14), to: shiftDay(95) };
  const aCodes = [...new Set(codes.map(codeOf).filter(Boolean))].slice(0, 40);
  const results = await Promise.allSettled([syncIpo(window), syncEarnings(aCodes, window), syncDividend(aCodes, window)]);
  const auto = [];
  for (const r of results) if (r.status === 'fulfilled') auto.push(...r.value);

  // 去重：autoKey 相同只留一条；被用户隐藏的自动事件不再出现；手动事件始终保留
  const manual = (cur.events ?? []).filter((e) => e.source === 'manual');
  const hidden = new Set((cur.hidden ?? []));
  const map = new Map();
  for (const e of auto) {
    if (hidden.has(e.autoKey)) continue;
    if (!map.has(e.autoKey)) map.set(e.autoKey, e);
  }
  const events = [...map.values(), ...manual];
  const next = { v: 1, events, hidden: [...hidden], syncedAt: Date.now(), symbolCount: aCodes.length };
  await set(KEYS.calendar, next);
  return next;
}

export async function getCal() {
  const c = await get(KEYS.calendar, null);
  if (!c || !Array.isArray(c.events)) return { v: 1, events: [], hidden: [], syncedAt: 0, symbolCount: 0 };
  return c;
}

export async function mutateCal(body) {
  const c = await getCal();
  switch (body?.op) {
    case 'add':
      c.events.push({
        id: uid('cal'),
        date: body.date,
        endDate: body.endDate,
        time: body.time,
        title: String(body.title || '新事件'),
        category: body.category || 'other',
        importance: Number(body.importance) || 2,
        note: body.note,
        symbol: body.symbol,
        source: 'manual',
      });
      break;
    case 'update': {
      const i = c.events.findIndex((e) => e.id === body.id);
      if (i >= 0) c.events[i] = { ...c.events[i], ...(body.patch ?? {}) };
      break;
    }
    case 'remove':
      c.events = c.events.filter((e) => e.id !== body.id);
      break;
    case 'hide': {
      const e = c.events.find((x) => x.id === body.id);
      if (e?.autoKey) {
        c.hidden = [...new Set([...(c.hidden ?? []), e.autoKey])];
        c.events = c.events.filter((x) => x.id !== e.id);
      }
      break;
    }
    case 'clearAuto':
      c.events = c.events.filter((e) => e.source === 'manual');
      break;
    default:
      break;
  }
  await set(KEYS.calendar, c);
  return c;
}

export function listRange(cal, from, to) {
  return (cal.events ?? [])
    .filter((e) => e.date >= from && e.date <= to)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (b.importance ?? 0) - (a.importance ?? 0)));
}
