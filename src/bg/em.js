/**
 * 多源行情中继（东方财富为主，腾讯 / 新浪兜底）。
 *
 * 设计要点
 *  1. 浏览器扩展后台 fetch 不受 CORS 限制（host_permissions 已授权），但不代表上游稳定：
 *     东财对高频/批量访问会限流甚至短暂封 IP（实测 push2delay 在密集请求后整段返回空），
 *     因此所有请求都走「多主机 × 多轮重试 + 抖动退避 + TTL 缓存」，并尽量批量合并。
 *  2. TTL 缓存真正命中（写 + 读），并在上游失败时用 last-known-good 回填字段，
 *     避免价格在「数字 / —」之间闪烁。
 *  3. K 线历史缓存落在 chrome.storage.local，首次拉全量、之后增量合并。
 */
import { num, sessionPos, inSamplingWindow } from '../shared/format.js';
import { SECID_RE, KEYS } from '../shared/model.js';
import { sget, sset, get, set } from './storage.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const REFERER = 'https://quote.eastmoney.com/';
const SUGGEST_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8';

const QUOTE_HOSTS = ['push2delay.eastmoney.com', 'push2.eastmoney.com', 'push2his.eastmoney.com'];
const HISTORY_HOSTS = ['push2his.eastmoney.com', 'push2delay.eastmoney.com', 'push2.eastmoney.com'];
const SEARCH_HOST = 'searchapi.eastmoney.com';
const EX_HOST = 'push2ex.eastmoney.com';

/* ───────────────────────────── TTL 缓存 ───────────────────────────────── */

const cache = new Map(); // key -> { exp, value }
const inflight = new Map();

export function peekCache(key, maxAgeMs = 0) {
  const slot = cache.get(key);
  if (slot === undefined) return undefined;
  if (Date.now() > slot.exp + maxAgeMs) return undefined;
  return slot.value;
}

export async function ttlCache(key, ttlMs, loader) {
  const slot = cache.get(key);
  if (slot !== undefined && Date.now() < slot.exp) return slot.value;
  const pending = inflight.get(key);
  if (pending !== undefined) return pending;
  const run = (async () => {
    const value = await loader();
    cache.set(key, { exp: Date.now() + ttlMs, value });
    return value;
  })();
  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}

/* ─────────────────────────── 底层请求 ─────────────────────────────────── */

async function fetchFromHost(host, pathAndQuery, timeoutMs = 8000) {
  const url = `https://${host}${pathAndQuery}`;
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json, text/plain, */*' },
    referrer: REFERER,
    referrerPolicy: 'no-referrer-when-downgrade',
    signal: AbortSignal.timeout(timeoutMs),
    credentials: 'omit',
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${host}`);
  const text = await res.text();
  if (text === '') throw new Error(`空响应 @ ${host}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`非 JSON 响应 @ ${host}: ${text.slice(0, 60)}`);
  }
}

const ROUNDS = 3;
const ATTEMPTS_PER_HOST = 2;
const DEADLINE_MS = 12000;

/** 多主机多轮重试取数：任何一次成功即返回；HTTP 4xx 不重试。 */
export async function fetchAny(hosts, pathAndQuery, timeoutMs = 8000, deadlineMs = DEADLINE_MS) {
  const deadline = Date.now() + deadlineMs;
  let lastError = null;
  for (let round = 0; round < ROUNDS; round += 1) {
    for (const host of hosts) {
      for (let attempt = 0; attempt < ATTEMPTS_PER_HOST; attempt += 1) {
        const left = deadline - Date.now();
        if (left <= 250) throw lastError ?? new Error('上游请求超时');
        try {
          return await fetchFromHost(host, pathAndQuery, Math.min(timeoutMs, left));
        } catch (error) {
          lastError = error;
          const message = error instanceof Error ? error.message : String(error);
          if (/HTTP 4\d\d/.test(message)) break;
          await sleep(60 + attempt * 120 + Math.random() * 140);
        }
      }
    }
  }
  throw lastError ?? new Error('上游请求失败');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function bodyOf(d) {
  return d !== null && typeof d === 'object' ? d : undefined;
}

function dataOf(d) {
  const b = bodyOf(d);
  return b && typeof b.data === 'object' && b.data !== null ? b.data : undefined;
}

function diffList(d) {
  const data = dataOf(d);
  const diff = data?.diff;
  if (Array.isArray(diff)) return diff;
  if (diff !== null && typeof diff === 'object') return [diff];
  return [];
}

/* ───────────────────── 非东财兜底源（新浪 / datacenter） ───────────────── */

const SINA_REFERER = 'https://finance.sina.com.cn/';
const SINA_FLOW_HOST = 'vip.stock.finance.sina.com.cn';
const DC_HOST = 'datacenter-web.eastmoney.com';

/** 通用原始请求：拿文本（可选 GBK 解码），用于 JSONP / 非标准 JSON 源 */
async function fetchText(url, { referer = REFERER, timeoutMs = 8000, encoding } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json, text/plain, */*' },
    referrer: referer,
    referrerPolicy: 'no-referrer-when-downgrade',
    signal: AbortSignal.timeout(timeoutMs),
    credentials: 'omit',
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (encoding === 'gbk') {
    const buf = await res.arrayBuffer();
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return new TextDecoder('utf-8').decode(buf);
    }
  }
  return res.text();
}

/** `sh600519` / `sz300750` → secid */
function secidFromSinaSymbol(sym) {
  const s = String(sym ?? '').trim();
  if (s.length < 3) return undefined;
  const pre = s.slice(0, 2).toLowerCase();
  const code = s.slice(2);
  if (!/^\d{6}$/.test(code)) return undefined;
  if (pre === 'sh' || pre === 'sz' || pre === 'bj') return `${pre === 'sh' ? '1' : '0'}.${code}`;
  return undefined;
}

/** `000001.SZ` → secid */
function secidFromSecucode(secucode) {
  const s = String(secucode ?? '').trim().toUpperCase();
  const dot = s.indexOf('.');
  if (dot <= 0) return undefined;
  const code = s.slice(0, dot);
  const suffix = s.slice(dot + 1);
  if (!/^\d{6}$/.test(code)) return undefined;
  if (suffix === 'SH') return `1.${code}`;
  if (suffix === 'SZ' || suffix === 'BJ') return `0.${code}`;
  return undefined;
}

/** 板块榜兜底：新浪「板块资金流」，同时给出涨跌幅 / 领涨股 / 主力净额（元） */
const SINA_BOARD_FENLEI = { industry: 0, concept: 1 };

async function boardsFromSina(scope, sort, pn, pz) {
  const fenlei = SINA_BOARD_FENLEI[scope];
  if (fenlei === undefined) return null; // ETF 无对应口径
  // 新浪一次给全量（行业约 48、概念约 180），取全量后本地排序/分页更准确
  const want = Math.min(300, Math.max(pz * 4, 200));
  const path =
    `/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_bk` +
    `?page=${pn}&num=${want}&sort=netamount&asc=0&fenlei=${fenlei}`;
  const text = await fetchText(`https://${SINA_FLOW_HOST}${path}`, { referer: SINA_REFERER });
  let arr;
  try {
    arr = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const total = arr.length;
  let rows = arr.map((it) => {
    const inAmt = num(it.inamount);
    const outAmt = num(it.outamount);
    const chg = num(it.avg_changeratio);
    const leadChg = num(it.ts_changeratio);
    const ratio = num(it.ratioamount);
    return {
      secid: undefined,
      code: String(it.category ?? ''),
      name: String(it.name ?? ''),
      pct: chg === null ? null : chg * 100,
      chg: null,
      price: num(it.avg_price),
      up: null,
      down: null,
      leader: it.ts_name ? String(it.ts_name) : null,
      leaderPct: leadChg === null ? null : leadChg * 100,
      leaderSecid: secidFromSinaSymbol(it.ts_symbol),
      money: num(it.netamount),
      superMoney: null,
      bigMoney: null,
      midMoney: null,
      smallMoney: null,
      moneyPct: ratio === null ? null : ratio * 100,
      vol: null,
      amount: inAmt === null && outAmt === null ? null : (inAmt ?? 0) + (outAmt ?? 0),
      turnover: null,
      source: 'sina',
    };
  });
  if (sort === 'pct') rows.sort((a, b) => (b.pct ?? -Infinity) - (a.pct ?? -Infinity));
  else if (sort === 'amount') rows.sort((a, b) => (b.amount ?? -1) - (a.amount ?? -1));
  else rows.sort((a, b) => (b.money ?? -Infinity) - (a.money ?? -Infinity));
  rows = rows.slice(0, pz);
  return { total, rows, source: 'sina' };
}

/** 个股当日资金流兜底：新浪「历史资金流向」（日频，主力净额 / 超大单净额） */
async function flowFromSina(secid) {
  const sym = sinaSymbol(secid);
  if (sym === null) return null;
  const path =
    `/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_zjlrqs` +
    `?page=1&num=20&sort=opendate&asc=0&daima=${sym}`;
  const text = await fetchText(`https://${SINA_FLOW_HOST}${path}`, { referer: SINA_REFERER });
  let arr;
  try {
    arr = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const last = arr[0];
  const main = num(last.netamount);
  if (main === null) return null;
  const superIn = num(last.r0_net);
  const ratio = num(last.ratioamount);
  return {
    secid,
    main,
    super: superIn,
    big: superIn === null ? null : main - superIn,
    small: null,
    mid: null,
    mainPct: ratio === null ? null : ratio * 100,
    // 新浪只提供日频，无当日分时序列
    series: [],
    firstLabel: arr.length > 0 ? String(arr[arr.length - 1].opendate ?? '') : null,
    lastLabel: String(last.opendate ?? ''),
    source: 'sina',
  };
}

/** 个股资金流排行兜底：东财 datacenter（push2 不可用时的替代口径） */
const DC_FLOW_SORT = { pct: 'CHANGE_RATE', amount: 'TURNOVERRATE', money: 'SUPERDEAL_INFLOW' };

async function stockFlowRankFromDatacenter(sort, pn, pz) {
  const col = DC_FLOW_SORT[sort] ?? DC_FLOW_SORT.money;
  const path =
    `/api/data/v1/get?reportName=RPT_DMSK_TS_STOCKNEW&columns=ALL` +
    `&pageSize=${Math.max(pz * 2, 40)}&pageNumber=${pn}` +
    `&sortColumns=${col}&sortTypes=-1`;
  const json = await fetchFromHost(DC_HOST, path, 9000);
  const data = json?.result?.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const rows = data.map((it) => {
    const sup = (num(it.SUPERDEAL_INFLOW) ?? 0) - (num(it.SUPERDEAL_OUTFLOW) ?? 0);
    const big = (num(it.BIGDEAL_INFLOW) ?? 0) - (num(it.BIGDEAL_OUTFLOW) ?? 0);
    return {
      secid: secidFromSecucode(it.SECUCODE),
      code: String(it.SECURITY_CODE ?? ''),
      name: String(it.SECURITY_NAME_ABBR ?? ''),
      price: num(it.CLOSE_PRICE),
      pct: num(it.CHANGE_RATE),
      amount: null,
      turnover: num(it.TURNOVERRATE),
      money: sup + big,
      superMoney: sup,
      bigMoney: big,
      moneyPct: num(it.RATIO),
      source: 'datacenter',
    };
  });
  if (sort === 'pct') rows.sort((a, b) => (b.pct ?? -Infinity) - (a.pct ?? -Infinity));
  else if (sort === 'amount') rows.sort((a, b) => (b.turnover ?? -Infinity) - (a.turnover ?? -Infinity));
  else rows.sort((a, b) => (b.money ?? -Infinity) - (a.money ?? -Infinity));
  return { total: num(json?.result?.count) ?? rows.length, rows: rows.slice(0, pz), source: 'datacenter' };
}

/* ─────────────────────── 行情 last-known-good ─────────────────────────── */

const LKG_KEY = 'tw:lkg';
const LKG_MAX = 1200;
const LKG_PERSIST_MS = 30000;

const lastGood = new Map();
let lkgLoaded = null;
let lkgDirty = false;
let lkgLastWrite = 0;

async function loadLkg() {
  if (lkgLoaded !== null) return lkgLoaded;
  lkgLoaded = (async () => {
    try {
      const raw = await sget(LKG_KEY, null);
      const rows = Array.isArray(raw?.rows) ? raw.rows : [];
      for (const row of rows) {
        if (!row || typeof row.secid !== 'string') continue;
        if (!SECID_RE.test(row.secid)) continue;
        if (typeof row.price !== 'number') continue;
        lastGood.set(row.secid, row);
      }
    } catch {
      /* 首次：无快照 */
    }
  })();
  return lkgLoaded;
}

function persistLkg() {
  if (!lkgDirty) return;
  const now = Date.now();
  if (now - lkgLastWrite < LKG_PERSIST_MS) return;
  lkgLastWrite = now;
  lkgDirty = false;
  if (lastGood.size > LKG_MAX) {
    let drop = lastGood.size - LKG_MAX;
    for (const key of lastGood.keys()) {
      if (drop <= 0) break;
      lastGood.delete(key);
      drop -= 1;
    }
  }
  sset(LKG_KEY, { ts: Date.now(), rows: [...lastGood.values()] }).catch(() => {});
}

/** 字段级 last-known-good 回填 */
export function fillLastGood(list, rows, bank = lastGood) {
  for (const secid of list) {
    const row = rows.get(secid);
    const good = bank.get(secid);
    if (row === undefined) {
      if (good !== undefined && good.price !== null) rows.set(secid, { ...good });
      continue;
    }
    if (row.price !== null) {
      if (bank === lastGood) {
        lastGood.set(secid, { ...row });
        lkgDirty = true;
        persistLkg();
      } else {
        bank.set(secid, { ...row });
      }
      continue;
    }
    if (good !== undefined && good.price !== null) {
      for (const f of ['price', 'chg', 'pct', 'prev', 'open', 'high', 'low', 'time', 'vol', 'amount']) {
        if (row[f] === null || row[f] === undefined) row[f] = good[f];
      }
    }
  }
}

/* ─────────────────────────────── 批量行情 ─────────────────────────────── */

const QUOTE_FIELDS = 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23,f24,f25,f62,f104,f105,f106,f124,f152';

function rowsFrom(json) {
  const rows = new Map();
  for (const it of diffList(json)) {
    const market = String(it.f13 ?? '');
    const code = String(it.f12 ?? '');
    if (market === '' || code === '' || code === 'undefined') continue;
    const secid = `${market}.${code}`;
    rows.set(secid, {
      secid,
      code,
      name: String(it.f14 ?? secid),
      price: num(it.f2),
      pct: num(it.f3),
      chg: num(it.f4),
      vol: num(it.f5),
      amount: num(it.f6),
      turnover: num(it.f8),
      pe: num(it.f9),
      volumeRatio: num(it.f10),
      high: num(it.f15),
      low: num(it.f16),
      open: num(it.f17),
      prev: num(it.f18),
      totalMv: num(it.f20),
      floatMv: num(it.f21),
      pb: num(it.f23),
      mainNet: num(it.f62),
      up: num(it.f104),
      down: num(it.f105),
      even: num(it.f106),
      time: normTime(it.f124),
    });
  }
  return rows;
}

function normTime(v) {
  const n = num(v);
  if (n === null) return null;
  if (n > 1e12) return n;
  if (n > 1e9) return n * 1000;
  return null;
}

/**
 * 批量行情：TTL 2.5s，返回路径（新鲜 / peek）都做 LKG 回填。
 * 单批上限 160 只，超出自动分片。
 */
export async function fetchQuotes(secids) {
  const list = [...new Set(secids.filter((s) => SECID_RE.test(s)))];
  if (list.length === 0) return {};
  await loadLkg();
  const out = {};
  const CHUNK = 120;
  for (let i = 0; i < list.length; i += CHUNK) {
    const part = list.slice(i, i + CHUNK);
    const key = `quotes:${part.join(',')}`;
    const quick = peekCache(key, 40000);
    const map = new Map();
    if (quick !== undefined) {
      const entries = quick instanceof Map ? quick.entries() : Object.entries(quick ?? {});
      for (const [k, v] of entries) map.set(k, v);
      fillLastGood(part, map);
      Object.assign(out, Object.fromEntries(map));
      continue;
    }
    const rows = await ttlCache(key, 2500, () => rawQuotes(part));
    fillLastGood(part, rows);
    for (const row of rows.values()) out[row.secid] = row;
  }
  return out;
}

async function rawQuotes(list) {
  const rows = new Map();
  const q = `secids=${encodeURIComponent(list.join(','))}&fltt=2&invt=2&fields=${QUOTE_FIELDS}`;
  for (const host of QUOTE_HOSTS) {
    try {
      const json = await fetchFromHost(host, `/api/qt/ulist.np/get?${q}`);
      for (const [secid, row] of rowsFrom(json)) rows.set(secid, row);
    } catch {
      /* 换主机 */
    }
    if (list.every((s) => rows.has(s))) break;
  }
  // 东财全挂或被限流时，用腾讯批量行情补齐（独立数据源，A股/ETF/指数/港股/美股）
  let missing = list.filter((s) => !rows.has(s));
  if (missing.length > 0) {
    const used = ['eastmoney'];
    try {
      const fb = await quotesFromTencent(missing);
      for (const [secid, row] of fb) if (!rows.has(secid)) rows.set(secid, row);
      if (fb.size > 0) used.push('tencent');
    } catch {
      /* 保留原有结果 */
    }
    // 腾讯只认 sh/sz/hk/us —— 欧洲指数与商品期货它没有，再补一层新浪
    missing = list.filter((s) => !rows.has(s));
    if (missing.length > 0) {
      try {
        const sg = await quotesFromSinaGlobal(missing);
        for (const [secid, row] of sg) if (!rows.has(secid)) rows.set(secid, row);
        if (sg.size > 0) used.push('sina');
      } catch {
        /* 保留原有结果 */
      }
    }
    noteSource(used.join('+'));
  } else if (rows.size > 0) {
    noteSource('eastmoney');
  }
  return rows;
}

/* ───────────────── 全球指数 / 大宗商品：腾讯 + 新浪 双源兜底 ────────────── */

/**
 * 东财 secid → 免费源符号。
 *
 * 为什么需要这张表：东财 push2 的 `/api/**` 在部分网络被**按路径拦截**（实测 TCP 直接 RST，
 * 三个 push2 主机全都如此），而腾讯批量行情（qt.gtimg.cn）只认 sh/sz/hk/us 前缀，
 * 覆盖不到欧洲指数与商品期货 —— 于是「欧美市场」「大宗商品」两组长期整片显示 `—`。
 *
 * 下面两家都实测可用、无需 key：
 *   q: 腾讯 qt.gtimg.cn   s: 新浪 hq.sinajs.cn（需 Referer: finance.sina.com.cn）
 *
 * 找不到免费源的标的**不要**往这里塞猜测值：宁可在界面上显示 `—`，也不要显示错的价格。
 * 例如「法国CAC40」「韩国KOSPI200」「澳洲标普200」目前无可用免费源（见 SKILL 记录）。
 */
const GLOBAL_SYMBOL = {
  // 欧美市场
  '100.SPX': { q: 'usINX' },              // 标普500
  '100.NDX': { q: 'usNDX' },              // 纳斯达克100
  '100.DJIA': { q: 'usDJI' },             // 道琼斯
  '100.FTSE': { s: 'int_ftse' },          // 英国富时100
  '100.GDAXI': { s: 'int_dax30' },        // 德国DAX30
  // 新浪口径下欧盟50指数即欧洲斯托克50，名称会不一致，展示时以本地名称为准
  '100.SX5E': { s: 'int_djstoxx50' },     // 欧洲斯托克50
  // 亚太
  '100.N225': { s: 'int_nikkei' },        // 日经225
  // 大宗商品（外盘 hf_ / 国内期货 nf_）
  '122.XAU': { s: 'hf_XAU' },             // 伦敦金现
  '101.SI00Y': { s: 'hf_SI' },            // COMEX白银
  '101.HG00Y': { s: 'hf_HG' },            // COMEX铜
  '112.B00Y': { s: 'hf_OIL' },            // 布伦特原油
  '113.rbm': { s: 'nf_RB0' },             // 螺纹钢主连
  '114.jmm': { s: 'nf_JM0' },             // 焦煤主连
  '114.mm': { s: 'nf_M0' },               // 豆粕主连
  '114.lhm': { s: 'nf_LH0' },             // 生猪主连
};

/* ───────────────── 腾讯批量行情兜底（独立第二数据源） ─────────────────── */

/**
 * qt.gtimg.cn 返回 GBK 编码的 `v_sh600519="1~名称~代码~现价~昨收~今开~…"` 文本，
 * 一次最多取数十只。字段位置（按 ~ 切分）：
 *   1 名称 2 代码 3 现价 4 昨收 5 今开 6 成交量(手)
 *   30 时间(yyyyMMddHHmmss) 31 涨跌 32 涨跌% 33 最高 34 最低
 *   36 成交量(手) 37 成交额(万) 38 换手率 39 市盈率 43 振幅
 *   44 流通市值(亿) 45 总市值(亿) 46 市净率
 */
async function quotesFromTencent(list) {
  const out = new Map();
  const pairs = [];
  for (const secid of list) {
    const sym = tencentSymbol(secid);
    if (sym !== null) pairs.push([secid, sym]);
  }
  if (pairs.length === 0) return out;
  const CHUNK = 50;
  for (let i = 0; i < pairs.length; i += CHUNK) {
    const chunk = pairs.slice(i, i + CHUNK);
    const bySym = new Map(chunk.map(([secid, sym]) => [sym, secid]));
    const url = `https://qt.gtimg.cn/q=${chunk.map((p) => p[1]).join(',')}`;
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA },
        referer: 'https://gu.qq.com/',
        signal: AbortSignal.timeout(8000),
        credentials: 'omit',
      });
      if (!res.ok) continue;
      let text;
      const buf = await res.arrayBuffer();
      try {
        text = new TextDecoder('gbk').decode(buf);
      } catch {
        text = new TextDecoder('utf-8').decode(buf);
      }
      for (const part of text.split(';')) {
        const m = /v_([A-Za-z0-9]+)="([^"]*)"/.exec(part);
        if (m === null) continue;
        const secid = bySym.get(m[1]);
        if (secid === undefined) continue;
        const f = m[2].split('~');
        if (f.length < 47) continue;
        const code = f[2] || secid.split('.')[1];
        const price = num(f[3]);
        const prev = num(f[4]);
        out.set(secid, {
          secid,
          code,
          name: f[1] || secid,
          price,
          prev,
          open: num(f[5]),
          high: num(f[33]),
          low: num(f[34]),
          chg: num(f[31]),
          pct: num(f[32]),
          vol: num(f[36]),
          amount: num(f[37]) !== null ? num(f[37]) * 10000 : null,
          turnover: num(f[38]),
          pe: num(f[39]),
          amplitude: num(f[43]),
          floatMv: num(f[44]) !== null ? num(f[44]) * 1e8 : null,
          totalMv: num(f[45]) !== null ? num(f[45]) * 1e8 : null,
          pb: num(f[46]),
          up: null,
          down: null,
          even: null,
          time: parseTencentTime(f[30]),
          source: 'tencent',
        });
      }
    } catch {
      /* 该批失败，继续下一批 */
    }
  }
  return out;
}

function parseTencentTime(s) {
  const t = String(s ?? '');
  if (!/^\d{14}$/.test(t)) return null;
  return Date.parse(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}`);
}

/** 记录最近一次行情来源，供界面提示数据新鲜度 */
let lastSource = { source: 'unknown', at: 0 };
function noteSource(source) {
  lastSource = { source, at: Date.now() };
}
export function quoteSourceInfo() {
  return lastSource;
}

/** 单只标的详细（含换手/量比/市盈率/市值）；东财不可用时用腾讯兜底 */
export async function fetchDetail(secid) {
  if (!SECID_RE.test(secid)) return null;
  const key = `detail:${secid}`;
  const cached = peekCache(key, 30000);
  if (cached !== undefined) return cached;
  let row = null;
  try {
    const json = await fetchAny(
      QUOTE_HOSTS,
      `/api/qt/ulist.np/get?secids=${encodeURIComponent(secid)}&fltt=2&invt=2&fields=${QUOTE_FIELDS}`,
    );
    row = rowsFrom(json).get(secid) ?? null;
    if (row !== null) noteSource('eastmoney');
  } catch {
    /* 交给腾讯兜底 */
  }
  if (row === null || row.price === null) {
    try {
      const fb = await quotesFromTencent([secid]);
      row = fb.get(secid) ?? row;
      if (row !== null) noteSource('tencent');
    } catch {
      /* 保留原结果 */
    }
  }
  cache.set(key, { exp: Date.now() + 8000, value: row });
  return row;
}

/* ─────────────────────────────── 分时 ─────────────────────────────────── */

function parseTrendRow(row) {
  const parts = String(row).split(',');
  if (parts.length < 3) return null;
  const label = parts[0];
  const price = num(parts.length > 7 ? parts[2] : parts[1]);
  if (price === null) return null;
  const t = Date.parse(label.replace(' ', 'T'));
  return {
    t: Number.isFinite(t) ? t : 0,
    label,
    price,
    avg: num(parts.length > 7 ? parts[7] : parts[2]),
    vol: parts.length > 5 ? num(parts[5]) : null,
    amount: parts.length > 6 ? num(parts[6]) : null,
  };
}

const trendLkg = new Map();
let trendLkgLoaded = null;
let trendLkgDirty = false;
let trendLkgLastWrite = 0;
const TREND_LKG_KEY = 'tw:trend-lkg';

async function loadTrendLkg() {
  if (trendLkgLoaded !== null) return trendLkgLoaded;
  trendLkgLoaded = (async () => {
    try {
      const raw = await sget(TREND_LKG_KEY, null);
      for (const e of Array.isArray(raw?.entries) ? raw.entries : []) {
        if (typeof e?.key !== 'string') continue;
        if (!Array.isArray(e?.trend?.points) || e.trend.points.length < 2) continue;
        trendLkg.set(e.key, { at: e.at ?? 0, trend: e.trend });
      }
    } catch {
      /* 首次 */
    }
  })();
  return trendLkgLoaded;
}

function persistTrendLkg() {
  if (!trendLkgDirty) return;
  const now = Date.now();
  if (now - trendLkgLastWrite < 5000) return;
  trendLkgLastWrite = now;
  trendLkgDirty = false;
  if (trendLkg.size > 300) {
    let drop = trendLkg.size - 300;
    for (const k of trendLkg.keys()) {
      if (drop <= 0) break;
      trendLkg.delete(k);
      drop -= 1;
    }
  }
  sset(TREND_LKG_KEY, { ts: Date.now(), entries: [...trendLkg.entries()].map(([key, v]) => ({ key, at: v.at, trend: v.trend })) }).catch(() => {});
}

export function lastGoodTrend(secid, ndays, maxAgeMs = Infinity) {
  const hit = trendLkg.get(`${secid}|${ndays}`);
  if (hit === undefined) return null;
  if (Date.now() - hit.at > maxAgeMs) return null;
  return { ...hit.trend, staleAt: hit.at };
}

async function trendWithFallback(secid, ndays, loader) {
  await loadTrendLkg();
  const key = `trend:${secid}:${ndays}`;
  const fresh = peekCache(key, 45000);
  if (fresh !== undefined) return fresh;
  try {
    const data = await loader();
    if (data === null || !Array.isArray(data.points) || data.points.length < 2) {
      return lastGoodTrend(secid, ndays) ?? data;
    }
    cache.set(key, { exp: Date.now() + 60000, value: data });
    trendLkg.set(`${secid}|${ndays}`, { at: Date.now(), trend: data });
    trendLkgDirty = true;
    persistTrendLkg();
    return data;
  } catch (error) {
    const lkg = lastGoodTrend(secid, ndays);
    if (lkg !== null) {
      cache.set(key, { exp: Date.now() + 20000, value: lkg });
      return lkg;
    }
    throw error;
  }
}

async function fetchTrendSingleDay(secid) {
  const fields2 = 'f51,f52,f53,f54,f55,f56,f57,f58';
  return trendWithFallback(secid, 1, async () => {
    try {
      const em = await trendFromEastmoney(secid, fields2);
      if (em !== null && em.points.length > 1) {
        noteSource('eastmoney');
        return em;
      }
    } catch {
      /* 交给腾讯当日分时兜底 */
    }
    const tx = await fetchTencentMinute(secid);
    if (tx !== null) {
      noteSource('tencent');
      return tx;
    }
    return null;
  });
}

async function trendFromEastmoney(secid, fields2, ndays = 1) {
  const days = Math.min(5, Math.max(1, Math.round(ndays)));
  const json = await fetchAny(
    HISTORY_HOSTS,
    `/api/qt/stock/trends2/get?secid=${encodeURIComponent(secid)}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=${fields2}&ndays=${days}&iscr=0`,
  );
  const data = dataOf(json);
  if (!data) return null;
  const raw = Array.isArray(data.trends) ? data.trends : [];
  const points = [];
  for (const r of raw) {
    if (typeof r !== 'string') continue;
    const p = parseTrendRow(r);
    if (p !== null) points.push(p);
  }
  if (points.length === 0) return null;
  const pre = num(data.prePrice) ?? num(data.preClose) ?? null;
  return { secid, prePrice: pre, points, last: points[points.length - 1].price };
}

/**
 * 腾讯当日分时兜底：`/appstock/app/minute/query?code=sh600519`
 * 每条 "HHmm 价格 累计成交量(手) 累计成交额(元)"，据此还原每分钟量额与均价线(VWAP)。
 */
export async function fetchTencentMinute(secid) {
  const sym = tencentSymbol(secid);
  if (sym === null) return null;
  const json = await fetchFromHost('web.ifzq.gtimg.cn', `/appstock/app/minute/query?code=${sym}`, 9000);
  const outer = json?.data?.[sym];
  const node = outer?.data;
  if (!node || !Array.isArray(node.data)) return null;
  const date = String(node.date ?? '');
  if (!/^\d{8}$/.test(date)) return null;
  const raw = [];
  for (const item of node.data) {
    const p = String(item).split(' ');
    if (p.length < 4) continue;
    const hm = p[0];
    if (!/^\d{4}$/.test(hm)) continue;
    const price = num(p[1]);
    if (price === null) continue;
    raw.push({ hm, price, cumVol: num(p[2]), cumAmt: num(p[3]) });
  }
  if (raw.length < 2) return null;
  const ymd = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const points = [];
  let pv = 0;
  let pa = 0;
  for (const r of raw) {
    const label = `${ymd} ${r.hm.slice(0, 2)}:${r.hm.slice(2, 4)}`;
    const t = Date.parse(label.replace(' ', 'T'));
    const vol = r.cumVol !== null ? Math.max(0, r.cumVol - pv) : null;
    const amount = r.cumAmt !== null ? Math.max(0, r.cumAmt - pa) : null;
    if (r.cumVol !== null) pv = r.cumVol;
    if (r.cumAmt !== null) pa = r.cumAmt;
    points.push({ t: Number.isFinite(t) ? t : 0, label, price: r.price, avg: null, vol, amount });
  }
  // 均价线：股票口径 cumAmt / (cumVol × 100)；指数口径不成立，用合理性校验剔除
  const prices = points.map((p) => p.price);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  pv = 0;
  pa = 0;
  let i = 0;
  for (const r of raw) {
    if (r.cumVol !== null) pv = r.cumVol;
    if (r.cumAmt !== null) pa = r.cumAmt;
    const vwap = pv > 0 && pa > 0 ? pa / (pv * 100) : null;
    points[i].avg = vwap !== null && vwap > lo * 0.9 && vwap < hi * 1.1 ? vwap : null;
    i += 1;
  }
  const qt = outer?.qt?.[sym];
  const pre = Array.isArray(qt) ? num(qt[4]) : null;
  return { secid, prePrice: pre, points, last: points[points.length - 1].price, source: 'tencent' };
}

/** secid → 新浪代码（仅 A股/深沪 ETF） */
function sinaSymbol(secid) {
  const dot = secid.indexOf('.');
  if (dot <= 0) return null;
  const mkt = secid.slice(0, dot);
  const code = secid.slice(dot + 1);
  if (mkt === '1') return `sh${code}`;
  if (mkt === '0') return `sz${code}`;
  return null;
}

/** secid → 腾讯代码（sh/sz/hk/us + 部分全球指数） */
function tencentSymbol(secid) {
  // 显式映射优先：东财的全球指数 secid（100.SPX 之类）与腾讯符号毫无规律，只能逐个列。
  const mapped = GLOBAL_SYMBOL[secid];
  if (mapped) return mapped.q ?? null;   // 只配了 s: 的标的走新浪，这里返回 null 让调用方跳过
  const dot = secid.indexOf('.');
  if (dot <= 0) return null;
  const mkt = secid.slice(0, dot);
  const code = secid.slice(dot + 1);
  if (mkt === '1') return `sh${code}`;
  if (mkt === '0') return `sz${code}`;
  if (mkt === '116') return `hk${code}`;
  if (mkt === '105' || mkt === '106' || mkt === '107') return `us${code.toUpperCase()}`;
  if (mkt === '100') {
    // 腾讯覆盖的少数海外指数
    const map = { HSI: 'hkHSI', HSCEI: 'hkHSCEI', HSTECH: 'hkHSTECH' };
    return map[code.toUpperCase()] ?? null;
  }
  return null;
}

/**
 * 新浪全球指数 / 外盘期货 / 国内期货兜底。
 *
 * 三种格式的字段位置**各不相同**，且都不是自描述的，所以逐一写清并注明依据：
 *   int_*  国际指数：`名称, 现价, 涨跌额, 涨跌幅%`
 *   hf_*   外盘期货：`现价, ?, 买价, 卖价, 最高, 最低, 时间, 昨收, 开盘, …, 日期, 名称`
 *                    涨跌幅没有直接给，用 现价/昨收 自算（已用腾讯同代码的涨跌幅字段交叉验证一致）
 *   nf_*   国内期货：`名称, 时间, 开盘, 最高, 最低, …, [8] 最新价, …, [10] 昨结算, …`
 *                    **期货涨跌幅按「最新价 / 昨结算 − 1」算，不是昨收盘** —— 这是期货与股票的
 *                    关键差别，用昨收盘会算出错误（甚至恒为 0）的涨跌幅。
 */
async function quotesFromSinaGlobal(list) {
  const out = new Map();
  const pairs = [];
  for (const secid of list) {
    const sym = GLOBAL_SYMBOL[secid]?.s;
    if (sym) pairs.push([secid, sym]);
  }
  if (pairs.length === 0) return out;

  let text;
  try {
    text = await fetchText(`https://hq.sinajs.cn/list=${pairs.map((p) => p[1]).join(',')}`, {
      referer: SINA_REFERER,
      encoding: 'gbk',        // hq.sinajs.cn 返回 GBK
      timeoutMs: 9000,
    });
  } catch {
    return out;
  }

  const bySym = new Map(pairs.map(([secid, sym]) => [sym, secid]));
  for (const line of text.split('\n')) {
    const m = /hq_str_([A-Za-z0-9_]+)="([^"]*)"/.exec(line);
    if (m === null || m[2] === '') continue;   // 停牌/无数据的代码返回空串
    const secid = bySym.get(m[1]);
    if (secid === undefined) continue;
    const row = sinaGlobalRow(secid, m[1], m[2].split(','));
    if (row !== null) out.set(secid, row);
  }
  return out;
}

function sinaGlobalRow(secid, sym, f) {
  const code = secid.split('.')[1];
  const base = { secid, code, open: null, high: null, low: null, vol: null, amount: null, time: null };

  if (sym.startsWith('int_')) {
    const price = num(f[1]);
    if (price === null) return null;
    return { ...base, name: f[0] || secid, price, prev: null, chg: num(f[2]), pct: num(f[3]), source: 'sina-int' };
  }

  if (sym.startsWith('hf_')) {
    const price = num(f[0]);
    const prev = num(f[7]);
    if (price === null) return null;
    return {
      ...base,
      name: f[13] || secid,
      price,
      prev,
      open: num(f[8]),
      high: num(f[4]),
      low: num(f[5]),
      chg: prev === null ? null : price - prev,
      pct: prev ? ((price - prev) / prev) * 100 : null,
      time: sinaDateTime(f[12], f[6]),
      source: 'sina-hf',
    };
  }

  if (sym.startsWith('nf_')) {
    const price = num(f[8]);
    const prev = num(f[10]);   // 昨结算
    if (price === null) return null;
    return {
      ...base,
      name: f[0] || secid,
      price,
      prev,
      open: num(f[2]),
      high: num(f[3]),
      low: num(f[4]),
      chg: prev === null ? null : price - prev,
      pct: prev ? ((price - prev) / prev) * 100 : null,
      vol: num(f[14]),
      time: sinaDateTime(f[17], f[1]),
      source: 'sina-nf',
    };
  }

  return null;
}

/** `'2026-09-25'` + `'10:26:30'` 或 `'102630'` → 毫秒时间戳（拿不到就 null） */
function sinaDateTime(date, time) {
  const d = String(date ?? '').trim();
  const t = String(time ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const hhmmss = /^\d{6}$/.test(t) ? `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}` : t;
  if (!/^\d{2}:\d{2}:\d{2}$/.test(hhmmss)) return null;
  const ms = Date.parse(`${d}T${hhmmss}`);
  return Number.isFinite(ms) ? ms : null;
}

async function fetchSina5Min(sym, datalen) {
  const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${sym}&scale=5&ma=no&datalen=${datalen}`;
  const res = await fetch(url, {
    headers: { 'user-agent': UA },
    referrer: 'https://finance.sina.com.cn',
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`sina HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    const label = typeof r.day === 'string' ? r.day.slice(0, 16) : null;
    const price = num(r.close);
    if (label === null || price === null) continue;
    const t = Date.parse(label.replace(' ', 'T'));
    if (!Number.isFinite(t)) continue;
    out.push({ t, label, price, vol: num(r.volume) });
  }
  return out;
}

async function fetchTencent5Min(sym, lmt) {
  const json = await fetchFromHost('proxy.finance.qq.com', `/ifzqgtimg/appstock/app/kline/mkline?param=${sym},m5,,${lmt}`, 9000);
  const rows = json?.data?.[sym]?.m5;
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 3) continue;
    const raw = String(r[0]);
    if (raw.length < 12) continue;
    const label = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} ${raw.slice(8, 10)}:${raw.slice(10, 12)}`;
    const price = num(r[2]);
    if (price === null) continue;
    const t = Date.parse(label.replace(' ', 'T'));
    if (!Number.isFinite(t)) continue;
    out.push({ t, label, price, vol: num(r[5]) });
  }
  return out;
}

/**
 * 腾讯多日分时：`/appstock/app/day/query?code=sh600519`
 * 返回最近 5 个交易日，每日 `"HHmm 价格 累计量 累计额"`。覆盖沪深与港股指数（hkHSI 等），
 * 是「五日」视图最贴合的数据源（真正的一分钟分时，而非 5 分钟 K 重采样）。
 */
async function fetchTencentDayTrend(secid, days) {
  const sym = tencentSymbol(secid);
  if (sym === null) return null;
  const json = await fetchFromHost('web.ifzq.gtimg.cn', `/appstock/app/day/query?code=${sym}`, 9000);
  const arr = json?.data?.[sym]?.data;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  // 腾讯按「最新在前」返回，改为升序后取最后 N 天
  const ordered = [...arr]
    .filter((d) => /^\d{8}$/.test(String(d?.date ?? '')))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-days);
  const points = [];
  for (const day of ordered) {
    const date = String(day.date);
    const ymd = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    let prevCum = 0;
    for (const item of day.data ?? []) {
      const f = String(item).split(' ');
      if (f.length < 4) continue;
      const hm = f[0];
      if (!/^\d{4}$/.test(hm)) continue;
      const price = num(f[1]);
      if (price === null) continue;
      const cum = num(f[2]);
      const label = `${ymd} ${hm.slice(0, 2)}:${hm.slice(2)}`;
      points.push({
        t: Date.parse(label.replace(' ', 'T')),
        label,
        price,
        avg: null,
        vol: cum === null ? null : Math.max(0, cum - prevCum),
      });
      if (cum !== null) prevCum = cum;
    }
  }
  if (points.length < 2) return null;
  const span = new Set(points.map((p) => p.label.slice(0, 10))).size;
  return { secid, prePrice: null, points, last: points[points.length - 1].price, days: span, source: 'tencent' };
}

/**
 * 多日（五日）分时。
 * 依次尝试：腾讯 day/query（沪深+港股指数，真分时）→ 东财 trends2?ndays=N（另覆盖美股）
 * → 5 分钟 K 线拼接（仅沪深）。
 * 此前只有最后一条，而它依赖 sinaSymbol（只认 sh/sz），所以港股标的的五日会静默回退成当日。
 */
async function fetchMultiDayTrend(secid, days) {
  const fields2 = 'f51,f52,f53,f54,f55,f56,f57,f58';
  const key = `trend-md:${secid}:${days}`;
  return ttlCache(key, 90000, async () => {
    // 1) 腾讯多日分时（沪深 + 港股指数）
    try {
      const tx = await fetchTencentDayTrend(secid, days);
      if (tx !== null && tx.points.length > 1) {
        noteSource('tencent');
        return tx;
      }
    } catch {
      /* 下一个源 */
    }
    // 2) 东财多日分时（可用时覆盖美股等更广市场）
    try {
      const em = await trendFromEastmoney(secid, fields2, days);
      if (em !== null && em.points.length > 1) {
        const span = new Set(em.points.map((p) => String(p.label ?? '').slice(0, 10))).size;
        noteSource('eastmoney');
        return { ...em, days: span, source: 'eastmoney' };
      }
    } catch {
      /* 走 5 分钟 K 拼接 */
    }
    // 3) 5 分钟 K 拼接（新浪主 / 腾讯备，仅沪深）
    const sym = sinaSymbol(secid);
    if (sym === null) return null;
    const datalen = Math.min(1000, days * 48 + 24);
    const bars = await ttlCache(`trend-md5:${sym}:${datalen}`, 90000, async () => {
      try {
        const s = await fetchSina5Min(sym, datalen);
        if (s.length > 0) return s;
      } catch {
        /* 换腾讯 */
      }
      try {
        return await fetchTencent5Min(sym, datalen);
      } catch {
        return [];
      }
    });
    if (bars.length === 0) return null;
    const dates = [...new Set(bars.map((b) => b.label.slice(0, 10)))].sort();
    const keep = new Set(dates.slice(-days));
    const points = bars
      .filter((b) => keep.has(b.label.slice(0, 10)))
      .map((b) => ({ t: b.t, label: b.label, price: b.price, avg: null, vol: b.vol }));
    if (points.length === 0) return null;
    noteSource('sina');
    return { secid, prePrice: null, points, last: points[points.length - 1].price, days: keep.size, source: 'sina' };
  });
}

/** 分时序列：ndays=1 当日分时；>1 用 5 分钟 K 拼接（新浪主 / 腾讯备） */
export async function fetchTrend(secid, ndays = 1) {
  if (!SECID_RE.test(secid)) return null;
  const days = Math.min(5, Math.max(1, Math.round(ndays)));
  if (days > 1) {
    const multi = await trendWithFallback(secid, days, async () => {
      const got = await fetchMultiDayTrend(secid, days);
      return got !== null && got.points.length > 1 ? got : null;
    });
    if (multi !== null && multi.points.length > 1) return multi;
  }
  return fetchTrendSingleDay(secid);
}

/* ───────────────────────────────  K 线 ────────────────────────────────── */

const KLINE_FULL_LMT = { 101: 800, 102: 400, 103: 240 };
const KLINE_RECENT_LMT = { 101: 10, 102: 5, 103: 3 };
const KLINE_CAP = { 101: 1200, 102: 800, 103: 600 };
const KLINE_TTL_FULL = 3600000;
const KLINE_TTL_INCR = 120000;

const klineMem = new Map();

function klineKey(secid, klt) {
  return `tw:kline:${secid}:${klt}`;
}

async function loadKlineCache(secid, klt) {
  const key = `${secid}|${klt}`;
  const hit = klineMem.get(key);
  if (hit !== undefined && hit.loaded) return hit;
  const entry = hit ?? { bars: [], loaded: false };
  try {
    const raw = await get(klineKey(secid, klt), null);
    if (Array.isArray(raw?.bars) && raw.bars.length > 0) {
      entry.bars = raw.bars.filter((b) => b && typeof b.date === 'string' && Number.isFinite(b.close));
    }
  } catch {
    /* 首次 */
  }
  entry.loaded = true;
  klineMem.set(key, entry);
  return entry;
}

async function saveKlineCache(secid, klt, bars) {
  try {
    await set(klineKey(secid, klt), { v: 1, secid, klt, updatedAt: Date.now(), bars });
  } catch (error) {
    console.warn('[tradewatcher] 保存K线缓存失败', String(error));
  }
}

/** 按日期合并（新覆盖旧、升序、截断） */
export function mergeBars(oldBars, freshBars, cap) {
  const byDate = new Map();
  for (const b of oldBars) byDate.set(b.date, b);
  for (const b of freshBars) byDate.set(b.date, b);
  const merged = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return cap > 0 && merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

/** 月K → 年K 重采样 */
export function resampleYearly(monthly) {
  const out = [];
  let curYear = '';
  let cur = null;
  let prevClose = null;
  for (const b of monthly) {
    const year = b.date.slice(0, 4);
    if (cur === null || year !== curYear) {
      if (cur !== null) out.push(cur);
      cur = { date: b.date, open: b.open, close: b.close, high: b.high, low: b.low, vol: b.vol, pct: null };
      curYear = year;
    } else {
      cur.date = b.date;
      cur.close = b.close;
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.vol = (cur.vol ?? 0) + (b.vol ?? 0);
    }
  }
  if (cur !== null) out.push(cur);
  for (const bar of out) {
    const base = prevClose ?? bar.open;
    bar.pct = base > 0 ? Math.round(((bar.close - base) / base) * 10000) / 100 : null;
    prevClose = bar.close;
  }
  return out;
}

async function klineFromTencent(secid, klt, lmt) {
  const sym = tencentSymbol(secid);
  if (sym === null) return null;
  const period = klt === 101 ? 'day' : klt === 102 ? 'week' : 'month';
  try {
    const json = await fetchFromHost('web.ifzq.gtimg.cn', `/appstock/app/fqkline/get?param=${sym},${period},,,${Math.min(1000, Math.max(5, lmt))},`, 9000);
    const node = json?.data?.[sym];
    if (!node) return null;
    const rows = node[period] ?? node[`qfq${period}`];
    if (!Array.isArray(rows)) return null;
    const bars = [];
    for (const r of rows) {
      if (!Array.isArray(r) || r.length < 5) continue;
      const close = num(r[2]);
      const open = num(r[1]);
      if (close === null || open === null) continue;
      bars.push({ date: String(r[0]), open, close, high: num(r[3]) ?? close, low: num(r[4]) ?? close, vol: r.length > 5 ? num(r[5]) : null, pct: null });
    }
    return bars.length > 0 ? bars : null;
  } catch {
    return null;
  }
}

async function klineFromEastmoney(secid, klt, lmt) {
  const fields2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';
  const path = `/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}&klt=${klt}&fqt=0&lmt=${lmt}&end=20500101&fields1=f1,f2,f3&fields2=${fields2}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const host of HISTORY_HOSTS) {
      try {
        const json = await fetchFromHost(host, path, 9000);
        const raw = Array.isArray(dataOf(json)?.klines) ? dataOf(json).klines : [];
        const bars = [];
        for (const r of raw) {
          if (typeof r !== 'string') continue;
          const p = r.split(',');
          if (p.length < 6) continue;
          const close = num(p[2]);
          if (close === null) continue;
          bars.push({ date: p[0], open: num(p[1]) ?? close, close, high: num(p[3]) ?? close, low: num(p[4]) ?? close, vol: num(p[5]), pct: num(p[8]) });
        }
        if (bars.length > 0) return bars;
      } catch {
        /* 换主机 */
      }
    }
    if (attempt === 0) await sleep(500);
  }
  return null;
}

/** 取 K 线（本地缓存 + 增量更新 + 上游失败回退缓存） */
export async function fetchKline(secid, klt = 101, lmt = 0) {
  if (!SECID_RE.test(secid)) return null;
  const baseKlt = klt === 104 ? 103 : klt;
  const entry = await loadKlineCache(secid, baseKlt);
  const needFull = entry.bars.length === 0;
  const cap = KLINE_CAP[baseKlt] ?? 800;
  const want = lmt > 0 ? lmt : needFull ? KLINE_FULL_LMT[baseKlt] ?? 300 : KLINE_RECENT_LMT[baseKlt] ?? 10;
  const key = `kline:${secid}:${baseKlt}:${needFull ? 'full' : 'incr'}`;
  const fetched = await ttlCache(key, needFull ? KLINE_TTL_FULL : KLINE_TTL_INCR, async () => {
    const t = await klineFromTencent(secid, baseKlt, want);
    if (t !== null) return t;
    return klineFromEastmoney(secid, baseKlt, want);
  });
  let stale = false;
  if (fetched !== null && fetched.length > 0) {
    const before = entry.bars.length;
    const beforeLast = entry.bars[entry.bars.length - 1]?.date ?? '';
    entry.bars = mergeBars(entry.bars, fetched, cap);
    const afterLast = entry.bars[entry.bars.length - 1]?.date ?? '';
    if (before !== entry.bars.length || beforeLast !== afterLast) saveKlineCache(secid, baseKlt, entry.bars);
  } else if (entry.bars.length === 0) {
    return null;
  } else {
    stale = true;
  }
  const series = baseKlt === 103 && klt === 104 ? resampleYearly(entry.bars) : entry.bars;
  const take = lmt > 0 ? Math.max(1, Math.min(Math.round(lmt), series.length)) : series.length;
  return { secid, klt, days: series.slice(series.length - take), stale, total: series.length };
}

/* ─────────────────────────────── 板块榜 ───────────────────────────────── */

const BOARD_FS = { industry: 'm:90+t:2', concept: 'm:90+t:3', etf: 'b:MK0021,b:MK0023,b:MK0022' };
const BOARD_FIELDS = 'f2,f3,f4,f5,f6,f8,f12,f13,f14,f62,f66,f72,f78,f84,f104,f105,f128,f136,f184';

export async function fetchBoards(scope = 'industry', sort = 'pct', pn = 1, pz = 50) {
  const fs = BOARD_FS[scope] ?? BOARD_FS.industry;
  const fid = sort === 'money' ? 'f62' : sort === 'amount' ? 'f6' : 'f3';
  const q = `pn=${pn}&pz=${pz}&po=1&np=1&fltt=2&invt=2&fid=${fid}&fs=${encodeURIComponent(fs)}&fields=${BOARD_FIELDS}`;
  const key = `board:${scope}:${sort}:${pn}:${pz}`;
  return ttlCache(key, 30000, async () => {
    let json = null;
    try {
      json = await fetchAny(QUOTE_HOSTS, `/api/qt/clist/get?${q}`);
    } catch {
      json = null; // 上游全部失败 → 走兜底源
    }
    const raw = diffList(json);
    if (raw.length > 0) {
      const rows = raw.map((it) => {
        const code = String(it.f12 ?? '');
        const mkt = String(it.f13 ?? '');
        return {
          secid: code !== '' && (mkt === '0' || mkt === '1') ? `${mkt}.${code}` : undefined,
          code,
          name: String(it.f14 ?? ''),
          pct: num(it.f3),
          chg: num(it.f4),
          price: num(it.f2),
          up: num(it.f104),
          down: num(it.f105),
          leader: it.f128 === '-' || it.f128 === undefined || it.f128 === null ? null : String(it.f128),
          leaderPct: num(it.f136),
          money: num(it.f62),
          superMoney: num(it.f66),
          bigMoney: num(it.f72),
          midMoney: num(it.f78),
          smallMoney: num(it.f84),
          moneyPct: num(it.f184),
          vol: num(it.f5),
          amount: num(it.f6),
          turnover: num(it.f8),
          source: 'eastmoney',
        };
      });
      return { total: num(dataOf(json)?.total) ?? rows.length, rows, source: 'eastmoney' };
    }
    const fb = await boardsFromSina(scope, sort, pn, pz).catch(() => null);
    if (fb !== null) return fb;
    throw new Error('板块数据暂不可用（东财行情主机限流，且新浪兜底失败）');
  });
}

/* ─────────────────────────────── 搜索 ─────────────────────────────────── */

const EXCLUDE_MARKETS = new Set(['90', '150', '151', '152', '80']);

function suggestKind(it, name) {
  const mkt = String(it.MktNum ?? '');
  const cls = String(it.Classify ?? '');
  const secType = String(it.SecurityTypeName ?? '');
  if (name.includes('ETF') || name.includes('LOF')) return 'ETF';
  if (mkt === '116') return '港股';
  if (mkt === '105' || mkt === '106' || mkt === '107') return '美股';
  if (cls === 'UniversalIndex' || cls === 'Index' || mkt === '100') return '指数';
  if (cls === 'Futures') return '期货';
  if (cls === 'Spot') return '现货';
  if (secType.includes('科创')) return '科创板';
  if (secType.includes('创业')) return '创业板';
  if (cls === 'AStock' || cls === 'Stock') return 'A股';
  if (cls === 'Fund' || cls === 'OTCFUND') return '基金';
  return '行情';
}

export async function searchSymbols(query) {
  const q = String(query ?? '').trim();
  if (q === '' || q.length > 40) return [];
  const key = `suggest:${q}`;
  const json = await ttlCache(key, 8000, () =>
    fetchAny([SEARCH_HOST], `/api/suggest/get?input=${encodeURIComponent(q)}&type=14&token=${SUGGEST_TOKEN}&count=14`),
  );
  const data = json?.QuotationCodeTable?.Data;
  if (!Array.isArray(data)) return [];
  const out = [];
  const seen = new Set();
  for (const it of data) {
    const quoteId = String(it.QuoteID ?? '');
    const code = String(it.Code ?? '');
    const mkt = String(it.MktNum ?? '');
    const name = String(it.Name ?? '');
    if (!SECID_RE.test(quoteId) || code === '' || code.includes('_') || name === '') continue;
    if (!/^\d{1,3}$/.test(mkt) || EXCLUDE_MARKETS.has(mkt)) continue;
    if (seen.has(quoteId)) continue;
    seen.add(quoteId);
    out.push({ secid: quoteId, code, name, kind: suggestKind(it, name), market: mkt });
    if (out.length >= 12) break;
  }
  return out;
}

export async function searchBest(query) {
  const hits = await searchSymbols(query);
  if (hits.length === 0) return null;
  const bare = String(query).trim().toUpperCase();
  return hits.find((h) => h.code.toUpperCase() === bare || h.name === String(query).trim()) ?? hits[0];
}

/* ─────────────────────────── 行业归属 / 相对强度 ──────────────────────── */

const INDUSTRY_TTL = 600000;
let industryBoardCache = null;
let industryBoardAt = 0;

async function industryBoardMap() {
  if (industryBoardCache !== null && Date.now() - industryBoardAt < 30000) return industryBoardCache;
  const map = new Map();
  let total = Infinity;
  for (let pn = 1; pn <= 8 && map.size < total; pn += 1) {
    const board = await fetchBoards('industry', 'pct', pn, 100);
    total = board.total;
    for (const r of board.rows) if (!map.has(r.name)) map.set(r.name, r.pct);
  }
  industryBoardCache = map;
  industryBoardAt = Date.now();
  return map;
}

async function industryNameOf(secid) {
  try {
    const json = await ttlCache(`industry-name:${secid}`, INDUSTRY_TTL, () =>
      fetchAny(QUOTE_HOSTS, `/api/qt/stock/get?secid=${encodeURIComponent(secid)}&fltt=2&invt=2&fields=f57,f58,f127`),
    );
    const raw = dataOf(json)?.f127;
    if (raw === null || raw === undefined || raw === '-' || raw === '') return null;
    return String(raw);
  } catch {
    return null;
  }
}

async function poolRun(items, concurrency, worker) {
  const queue = [...items];
  const runners = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/** A股 secids → { 行业名, 板块今日涨幅 } */
export async function fetchIndustryMap(secids) {
  const targets = [...new Set(secids)].filter((s) => SECID_RE.test(s) && (s.startsWith('0.') || s.startsWith('1.'))).slice(0, 60);
  if (targets.length === 0) return {};
  const names = new Map();
  await poolRun(targets, 4, async (secid) => {
    const name = await industryNameOf(secid);
    if (name !== null) names.set(secid, name);
  });
  if (names.size === 0) return {};
  const board = await industryBoardMap();
  const out = {};
  for (const [secid, name] of names) out[secid] = { name, pct: board.get(name) ?? null };
  return out;
}

/* ────────────────────────────── 涨跌停池 ──────────────────────────────── */

const POOL_UT = '7eea3edcaed734bea9cbfc24409ed989';

function ymd(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function hhmm(v) {
  const s = String(v ?? '').padStart(6, '0');
  if (s.length < 6) return '';
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
}

/** 涨跌停 / 炸板池：kind = zt | dt | zb */
export async function fetchLimitPool(kind = 'zt', date = ymd(), pagesize = 60) {
  const api = kind === 'dt' ? 'getTopicDTPool' : kind === 'zb' ? 'getTopicZBPool' : 'getTopicZTPool';
  const sort = kind === 'dt' ? 'fund:asc' : 'fbt:asc';
  const key = `pool:${kind}:${date}`;
  const json = await ttlCache(key, 60000, () =>
    fetchAny(
      [EX_HOST],
      `/${api}?ut=${POOL_UT}&dpt=wz.ztzt&Pageindex=0&pagesize=${pagesize}&sort=${encodeURIComponent(sort)}&date=${date}`,
      8000,
      16000,
    ),
  );
  const data = dataOf(json);
  if (!data) return { date, total: 0, rows: [] };
  const rows = (Array.isArray(data.pool) ? data.pool : []).map((it) => ({
    code: String(it.c ?? ''),
    market: String(it.m ?? ''),
    name: String(it.n ?? ''),
    price: num(it.p) !== null ? num(it.p) / 1000 : null,
    pct: num(it.zdp),
    amount: num(it.amount),
    floatMv: num(it.ltsz),
    turnover: num(it.hs),
    boards: num(it.lbc),          // 连板数
    firstSeal: hhmm(it.fbt),      // 首次封板
    lastSeal: hhmm(it.lbt),       // 最后封板
    sealFund: num(it.fund),       // 封单额
    brokenCount: num(it.zbc),     // 炸板次数
    industry: String(it.hybk ?? ''),
    stat: it.zttj ? { days: num(it.zttj.days), count: num(it.zttj.ct) } : null,
    secid: `${it.m}.${it.c}`,
  }));
  return { date, total: num(data.tc) ?? rows.length, rows };
}

/* ─────────────────────────── 个股 / 板块资金流 ────────────────────────── */

/** 单只标的当日资金流（主力/超大单/大单/中单/小单净额，元） */
export async function fetchMoneyFlow(secid) {
  if (!SECID_RE.test(secid)) return null;
  const key = `flow:${secid}`;
  return ttlCache(key, 60000, async () => {
    let json = null;
    try {
      json = await fetchAny(
        QUOTE_HOSTS,
        `/api/qt/stock/fflow/kline/get?lmt=0&klt=1&secid=${encodeURIComponent(secid)}&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`,
      );
    } catch {
      json = null;
    }
    const klines = Array.isArray(dataOf(json)?.klines) ? dataOf(json).klines : [];
    if (klines.length > 0) {
      const last = String(klines[klines.length - 1]).split(',');
      const first = String(klines[0]).split(',');
      return {
        secid,
        main: num(last[1]),
        small: num(last[2]),
        mid: num(last[3]),
        big: num(last[4]),
        super: num(last[5]),
        mainPct: num(last[6]),
        // 分时序列（主力净额累计）
        series: klines.map((k) => {
          const p = String(k).split(',');
          return { label: p[0], main: num(p[1]) };
        }),
        firstLabel: first[0],
        lastLabel: last[0],
        source: 'eastmoney',
      };
    }
    // push2 不可用时退到新浪日频口径
    return flowFromSina(secid).catch(() => null);
  });
}

/** 沪深A股过滤（主板/创业板/科创板） */
const ASHARE_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';

/** 个股资金流排行（主力净额 / 涨跌幅 / 成交额） */
export async function fetchStockFlowRank(sort = 'money', pn = 1, pz = 30) {
  const fid = sort === 'pct' ? 'f3' : sort === 'amount' ? 'f6' : 'f62';
  const q = `pn=${pn}&pz=${pz}&po=1&np=1&fltt=2&invt=2&fid=${fid}&fs=${encodeURIComponent(ASHARE_FS)}&fields=f2,f3,f5,f6,f8,f12,f13,f14,f62,f66,f72,f78,f84,f184`;
  const key = `stockflow:${sort}:${pn}:${pz}`;
  return ttlCache(key, 45000, async () => {
    let json = null;
    try {
      json = await fetchAny(QUOTE_HOSTS, `/api/qt/clist/get?${q}`);
    } catch {
      json = null;
    }
    const raw = diffList(json);
    if (raw.length > 0) {
      const rows = raw.map((it) => ({
        secid: `${it.f13}.${it.f12}`,
        code: String(it.f12 ?? ''),
        name: String(it.f14 ?? ''),
        price: num(it.f2),
        pct: num(it.f3),
        amount: num(it.f6),
        turnover: num(it.f8),
        money: num(it.f62),
        superMoney: num(it.f66),
        bigMoney: num(it.f72),
        moneyPct: num(it.f184),
        source: 'eastmoney',
      }));
      return { total: num(dataOf(json)?.total) ?? rows.length, rows, source: 'eastmoney' };
    }
    const fb = await stockFlowRankFromDatacenter(sort, pn, pz).catch(() => null);
    if (fb !== null) return fb;
    throw new Error('个股资金榜暂不可用（东财行情主机限流，且 datacenter 兜底失败）');
  });
}

/* ──────────────────────────── 沪深港通 ────────────────────────────────── */

export async function fetchHsgt() {
  const key = 'hsgt';
  return ttlCache(key, 120000, async () => {
    const json = await fetchAny(['push2.eastmoney.com', 'push2delay.eastmoney.com'], '/api/qt/kamt/get?fields1=f1,f2,f3,f4&fields2=f51,f52,f54,f56');
    const d = dataOf(json);
    if (!d) return { available: false, north: null, south: null };
    const pick = (node) => (node ? { net: num(node.dayNetAmtIn), quota: num(node.dayAmtThreshold), date: node.date2 ?? null, status: num(node.status) } : null);
    const north = { sh: pick(d.hk2sh), sz: pick(d.hk2sz) };
    const south = { sh: pick(d.sh2hk), sz: pick(d.sz2hk) };
    const northNet = (north.sh?.net ?? 0) + (north.sz?.net ?? 0);
    const southNet = (south.sh?.net ?? 0) + (south.sz?.net ?? 0);
    return {
      available: true,
      north: { ...north, net: northNet },
      south: { ...south, net: southNet },
      // 北向自 2024-08 起已停止盘中实时披露，若全为 0 则标记
      northDisclosed: northNet !== 0,
    };
  });
}

/* ─────────────────────────── 大盘宽度（涨跌家数） ─────────────────────── */

/** 沪深两市统计：上涨/下跌/平盘家数 + 两市成交额 */
export async function fetchBreadth() {
  return ttlCache('breadth', 15000, async () => {
    const ids = ['1.000001', '0.399001'];
    const rows = await fetchQuotes(ids);
    let up = 0;
    let down = 0;
    let even = 0;
    let amount = 0;
    let ok = false;
    for (const id of ids) {
      const r = rows[id];
      if (!r) continue;
      if (r.up !== null || r.down !== null) {
        ok = true;
        up += r.up ?? 0;
        down += r.down ?? 0;
        even += r.even ?? 0;
      }
      amount += r.amount ?? 0;
    }
    if (ok) return { up, down, even, amount, available: true, source: 'eastmoney' };

    // 廉价路径失效（push2 的 f104/f105/f106 拿不到）→ 复用同一份新浪全市场快照。
    // 快照本身有 240s TTL，所以这里 15s 的调用节奏不会放大成请求风暴。
    const snap = await sinaMarketSnapshot().catch(() => null);
    if (snap !== null) {
      let sUp = 0;
      let sDown = 0;
      let sEven = 0;
      let sAmount = 0;
      for (const r of snap.rows) {
        if (r.pct > 0) sUp += 1;
        else if (r.pct < 0) sDown += 1;
        else sEven += 1;
        sAmount += r.amount ?? 0;
      }
      noteSource('sina');
      // 成交额优先用两市指数口径（官方值），拿不到才退回逐股求和
      return { up: sUp, down: sDown, even: sEven, amount: amount > 0 ? amount : sAmount, available: true, source: 'sina' };
    }
    return { up: null, down: null, even: null, amount, available: false, source: null };
  });
}

/* ─────────────────── 涨跌分布（全市场分档统计） ───────────────────────── */

/** 全 A（沪主板+科创+深主板+创业+北交所） */
const ALL_A_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';

/** 11 档分布，顺序按「涨 → 平 → 跌」排列（与盯盘习惯一致：红在左、绿在右） */
export const DIST_BUCKETS = [
  { key: 'u10', label: '≥10%', side: 'up', min: 10 },
  { key: 'u7', label: '7~10', side: 'up', min: 7 },
  { key: 'u5', label: '5~7', side: 'up', min: 5 },
  { key: 'u3', label: '3~5', side: 'up', min: 3 },
  { key: 'u0', label: '0~3', side: 'up', min: 0 },
  { key: 'f0', label: '平盘', side: 'flat', min: 0 },
  { key: 'd0', label: '0~3', side: 'down', min: 0 },
  { key: 'd3', label: '3~5', side: 'down', min: 3 },
  { key: 'd5', label: '5~7', side: 'down', min: 5 },
  { key: 'd7', label: '7~10', side: 'down', min: 7 },
  { key: 'd10', label: '≥10%', side: 'down', min: 10 },
];

/** 涨跌幅（%）落到第几档；返回 DIST_BUCKETS 下标，-1 表示未知 */
export function bucketIndex(pct) {
  if (pct === null || !Number.isFinite(pct)) return -1;
  if (pct === 0) return 5;
  const a = Math.abs(pct);
  const edges = [10, 7, 5, 3, 0];
  let i = -1;
  for (let k = 0; k < edges.length; k += 1) {
    const lo = edges[k];
    const hi = k === 0 ? Infinity : edges[k - 1];
    if (a >= lo && a < hi) {
      i = k;
      break;
    }
  }
  if (i < 0) return -1;
  // 涨档按幅度递减排列（≥10 → 0~3），跌档按幅度递增排列（0~3 → ≥10），故跌档需镜像
  return pct > 0 ? i : 6 + (edges.length - 1 - i);
}

/**
 * 全市场涨跌分布：逐页拉 A 股涨跌幅后本地分档。
 * 12 页 × 500 条 ≈ 全市场 5500 只；TTL 3 分钟，避免把上游打爆。
 */
/* ─────────────── 全市场快照（新浪兜底源）───────────────────────────────
 * 为什么必须有这条兜底：`push2*` 的 `/api/**` 可能在网络层被整族阻断
 * （curl 根路径 404 说明主机活着，但任意 /api/ 路径立即 RST、返回 000）。
 * 一旦如此，「全市场涨跌幅分布」与「涨跌家数」会同时失效 —— 概览右栏
 * 两张图只剩占位文案。新浪行情中心返回逐股 changepercent / amount，
 * 可分页取全量，正好补上这个缺口。
 *
 * ⚠️ 单页上限 **100 条**（num 传 500/2000 也只回 100），全 A ~5500 只
 *     → 约 56 次请求；实测 8 并发约 2.3s、0 失败页、相邻页无重叠。
 *     因此**必须**由 TTL 缓存兜住：否则 15s TTL 的 fetchBreadth 会把它
 *     变成每小时上千次请求，很快被新浪限流。
 */
const SINA_NODE_ALL_A = 'hs_a';
const SINA_SNAP_TTL = 240000;
const SINA_PAGE_SIZE = 100;
const SINA_CONC = 8;

/** 上次全市场快照成功用的是新浪（而非东财）时，在此时间戳前优先新浪 */
let preferSinaUntil = 0;

async function sinaMarketSnapshot() {
  return ttlCache('sina-snap', SINA_SNAP_TTL, async () => {
    const api = '/quotes_service/api/json_v2.php/Market_Center.getHQNode';
    let total = null;
    try {
      const t = await fetchText(`https://${SINA_FLOW_HOST}${api}StockCount?node=${SINA_NODE_ALL_A}`, {
        referer: SINA_REFERER,
        timeoutMs: 9000,
      });
      total = num(JSON.parse(t));
    } catch {
      total = null;
    }
    if (total === null || total <= 0) return null;

    const pages = Math.ceil(total / SINA_PAGE_SIZE);
    const rows = [];
    let failed = 0;
    await poolRun(
      Array.from({ length: pages }, (_, i) => i + 1),
      SINA_CONC,
      async (p) => {
        try {
          const text = await fetchText(
            `https://${SINA_FLOW_HOST}${api}Data?page=${p}&num=${SINA_PAGE_SIZE}&sort=changepercent&asc=0&node=${SINA_NODE_ALL_A}`,
            { referer: SINA_REFERER, timeoutMs: 12000 },
          );
          const arr = JSON.parse(text);
          if (!Array.isArray(arr)) {
            failed += 1;
            return;
          }
          for (const it of arr) {
            const pct = num(it.changepercent);
            if (pct === null) continue;
            rows.push({ code: String(it.code ?? ''), name: String(it.name ?? ''), pct, amount: num(it.amount) });
          }
        } catch {
          failed += 1;
        }
      },
    );
    // 残缺快照比没有更糟（会把分档和家数一起做偏），失败页超阈值就整体放弃
    if (failed > Math.max(2, Math.floor(pages * 0.08))) return null;
    if (rows.length < total * 0.9) return null;
    return { total: rows.length, rows };
  });
}

/** 按 11 档口径统计一组涨跌幅 */
function bucketCounts(pcts) {
  const counts = new Array(DIST_BUCKETS.length).fill(0);
  let up = 0;
  let down = 0;
  let flat = 0;
  for (const p of pcts) {
    const i = bucketIndex(p);
    if (i >= 0) counts[i] += 1;
    if (p > 0) up += 1;
    else if (p < 0) down += 1;
    else flat += 1;
  }
  return {
    up,
    down,
    flat,
    bins: DIST_BUCKETS.map((b, i) => ({ key: b.key, label: b.label, side: b.side, count: counts[i] })),
  };
}

/** 东财 push2 clist 全 A 快照（14 页） */
async function distributionFromEastmoney() {
  const pcts = [];
  let expected = null;
  const pageSize = 500;
  for (let pn = 1; pn <= 14; pn += 1) {
    const q = `pn=${pn}&pz=${pageSize}&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${encodeURIComponent(ALL_A_FS)}&fields=f3`;
    let json = null;
    try {
      json = await fetchAny(QUOTE_HOSTS, `/api/qt/clist/get?${q}`, 9000, 15000);
    } catch {
      json = null;
    }
    const list = diffList(json);
    if (list.length === 0) break;
    if (expected === null) expected = num(dataOf(json)?.total) ?? null;
    for (const it of list) {
      const p = num(it.f3);
      if (p !== null) pcts.push(p);
    }
    if (list.length < pageSize) break;
    if (expected !== null && pcts.length >= expected) break;
  }
  if (pcts.length === 0) return null;
  return { total: pcts.length, expected, ...bucketCounts(pcts), source: 'eastmoney' };
}

/** 新浪全市场快照 → 同样口径 */
async function distributionFromSina() {
  const snap = await sinaMarketSnapshot();
  if (snap === null) return null;
  return { total: snap.total, expected: snap.total, ...bucketCounts(snap.rows.map((r) => r.pct)), source: 'sina' };
}

/** 东财 / 新浪对冲取全市场快照
 *
 * 直接「东财失败再走新浪」会串行叠加：东财被阻断时它内部的 3 主机 × 3 轮重试
 * 要耗掉约 3.6s，之后才开始跑新浪，首屏要等 ~7s。
 * 这里让新浪**延迟启动**（hedge）：东财 1.2s 内成功就取消新浪，一个多余请求都不发；
 * 东财挂掉时新浪早已并行跑完，总耗时 ≈ 东财的失败耗时而不是两者之和。
 */
async function distributionHedged() {
  let cancelled = false;
  const emP = distributionFromEastmoney().catch(() => null);
  const sinaP = (async () => {
    await sleep(1200);
    if (cancelled) return null;
    return distributionFromSina().catch(() => null);
  })();
  const em = await emP;
  if (em !== null) {
    cancelled = true;
    return em;
  }
  return sinaP;
}

/** 全市场涨跌幅分档：东财优先，被阻断时自动降级到新浪 */
export async function fetchDistribution() {
  return ttlCache('dist', 180000, async () => {
    // 已知东财不可用时直接走新浪，省掉那 1.2s 对冲窗口
    const got = Date.now() < preferSinaUntil ? await distributionFromSina().catch(() => null) : await distributionHedged();
    if (got === null) return null;
    noteSource(got.source);
    // 新浪成功 → 10 分钟内优先新浪；东财恢复 → 立刻切回东财并清掉偏好
    preferSinaUntil = got.source === 'sina' ? Date.now() + 600000 : 0;
    return got;
  });
}

/* ───────────────────────── 两市成交额走势 ─────────────────────────────── */

/** 腾讯多日分时 → 每日成交额（取当日分钟序列末条的累计成交额，单位：元） */
async function tencentDayTurnovers(secid) {
  const sym = tencentSymbol(secid);
  if (sym === null) return null;
  const json = await fetchFromHost('web.ifzq.gtimg.cn', `/appstock/app/day/query?code=${sym}`, 9000);
  const arr = json?.data?.[sym]?.data;
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const d of arr) {
    const date = String(d?.date ?? '');
    const list = Array.isArray(d?.data) ? d.data : [];
    if (!/^\d{8}$/.test(date) || list.length === 0) continue;
    const amt = num(String(list[list.length - 1]).split(' ')[3]);
    if (amt !== null) out.push({ date, amount: amt });
  }
  return out.length > 0 ? out : null;
}

/**
 * 两市成交额：当日 / 昨日 / 较昨日变动 / 近 5 日序列（单位：元）。
 * 走腾讯多日分时（末条累计成交额），与涨跌分布同源可比，不依赖 push2。
 */
export async function fetchTurnover() {
  return ttlCache('turnover', 60000, async () => {
    const [sh, sz] = await Promise.all([
      tencentDayTurnovers('1.000001').catch(() => null),
      tencentDayTurnovers('0.399001').catch(() => null),
    ]);
    if (sh === null && sz === null) return null;
    const merged = new Map();
    for (const list of [sh, sz]) {
      if (list === null) continue;
      for (const r of list) merged.set(r.date, (merged.get(r.date) ?? 0) + r.amount);
    }
    const dates = [...merged.keys()].sort();
    if (dates.length === 0) return null;
    const series = dates.map((d) => ({ date: d, amount: merged.get(d) }));
    const today = series[series.length - 1];
    const prev = series.length >= 2 ? series[series.length - 2] : null;
    const change = prev !== null ? today.amount - prev.amount : null;
    return {
      date: today.date,
      today: today.amount,
      prev: prev?.amount ?? null,
      prevDate: prev?.date ?? null,
      change,
      changePct: change !== null && prev.amount > 0 ? (change / prev.amount) * 100 : null,
      series,
      source: 'tencent',
    };
  });
}

/* ───────────────────────── 两融（融资融券）走势 ───────────────────────── */

/** 腾讯日 K 收盘序列 → Map<'YYYY-MM-DD', close> */
async function tencentDailyCloses(secid, count = 120) {
  const sym = tencentSymbol(secid);
  if (sym === null) return null;
  const json = await fetchFromHost('web.ifzq.gtimg.cn', `/appstock/app/fqkline/get?param=${sym},day,,,${count},qfq`, 9000);
  const node = json?.data?.[sym];
  const arr = node?.qfqday ?? node?.day;
  if (!Array.isArray(arr)) return null;
  const out = new Map();
  for (const row of arr) {
    const date = String(row?.[0] ?? '');
    const close = num(row?.[2]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && close !== null) out.set(date, close);
  }
  return out.size > 0 ? out : null;
}

/**
 * 两融走势：近 N 个交易日的 两融余额 / 融资净买 / 参照指数。
 * 源：datacenter-web `RPTA_RZRQ_LSHJ`（沪深两市融资融券历史合计）。
 *
 * 该主机通常**不受 push2 限流影响**（实测 push2* 全挂时仍正常），因此是独立链路。
 *
 * ⚠️ 报表里的 `NEW` 字段不是上证指数 —— 实测 2026-09-23 `NEW`=4517.28 而上证收 3936.52，
 * 口径不明，故**不用它**，指数序列另从腾讯日 K 取沪深300（与「沪深两市」口径最匹配）。
 */
export async function fetchMargin(days = 90) {
  const n = Math.min(250, Math.max(20, Math.round(days)));
  return ttlCache(`margin:${n}`, 1800000, async () => {
    const q = new URLSearchParams({
      reportName: 'RPTA_RZRQ_LSHJ',
      columns: 'DIM_DATE,RZRQYE,RZJME,RZYE,RQYE',
      sortColumns: 'DIM_DATE',
      sortTypes: '-1',
      pageSize: String(n),
      pageNumber: '1',
      source: 'WEB',
      client: 'WEB',
    });
    let json = null;
    try {
      json = await fetchFromHost(DC_HOST, `/api/data/v1/get?${q}`, 12000);
    } catch {
      return null;
    }
    const rows = json?.result?.data;
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const byDate = new Map();
    for (const r of rows) {
      const date = String(r.DIM_DATE ?? '').slice(0, 10);
      const balance = num(r.RZRQYE);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || balance === null) continue;
      byDate.set(date, { date, balance, netBuy: num(r.RZJME), finance: num(r.RZYE), short: num(r.RQYE) });
    }
    if (byDate.size < 2) return null;

    const indexCloses = await tencentDailyCloses('1.000300', n + 20).catch(() => null);
    const series = [...byDate.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => ({ ...r, index: indexCloses?.get(r.date) ?? null }));

    const first = series[0];
    const last = series[series.length - 1];
    return {
      series,
      latest: last,
      firstDate: first.date,
      lastDate: last.date,
      balanceChange: last.balance - first.balance,
      indexChangePct: first.index && last.index ? ((last.index - first.index) / first.index) * 100 : null,
      indexName: '沪深300',
      source: 'eastmoney',
    };
  });
}

/* ─────────────────── 涨跌家数分时（本地采样累积） ────────────────────── */

/**
 * 涨跌家数的**日内**序列没有任何免费历史端点 —— 上游只能给「当前值」。
 * 因此改为「边盯盘边累积」：service worker 借 1 分钟的 alarm 采样并落盘，
 * 多个面板共用同一份数据，且跨浏览器重启保留（按交易日分桶，保留最近 N 天）。
 *
 * 代价必须讲清：当天首次打开时曲线是从当前时刻开始长出来的，需要挂着才逐渐完整。
 *
 * 采样成本控制（很关键，别把免费接口点爆）：
 *  - 优先廉价路径 `fetchBreadth()`（2 次指数行情，指望 f104/f105/f106）
 *  - 只有它拿不到家数时才退回 `fetchDistribution()`（全市场 14 页）
 *  - 且昂贵路径**限制为每 3 分钟最多一次**，与其内部 180s TTL 对齐
 *  - 点位间隔 3 分钟：240 分钟交易日 → 约 80 个点，足够看形状
 */

const BSERIES_KEEP = 5;
const SAMPLE_MIN_GAP = 170000;      // 两个采样点至少间隔 ~3 分钟
const DIST_MIN_GAP = 170000;        // 昂贵路径的最小间隔
let lastDistSampleAt = 0;

/**
 * 昂贵路径的退避。
 * push2 主机被限流/不可达时，廉价款与昂贵款会**一起失败**；
 * 若每 3 分钟都去轰 14 页全市场快照，纯属浪费（实测某环境 push2 整段返回连接重置）。
 * 连续失败 3 次 → 停 30 分钟再试，成功即清零。
 */
let distFails = 0;
let distSkipUntil = 0;

export async function sampleBreadthSeries(now = Date.now()) {
  if (!inSamplingWindow(now)) return null;

  const store = (await get(KEYS.breadthSeries, null)) ?? {};
  const today = ymd(now);
  const points = Array.isArray(store[today]) ? store[today] : [];
  const last = points[points.length - 1];
  if (last !== undefined && now - last.t < SAMPLE_MIN_GAP) return points;

  let up = null;
  let down = null;
  let flat = null;
  let source = null;

  const b = await fetchBreadth().catch(() => null);
  if (b?.available && b.up !== null && b.down !== null) {
    up = b.up;
    down = b.down;
    flat = b.even;
    // 记下真实来源：东财指数统计字段 vs 新浪全市场快照兜底
    source = b.source === 'sina' ? 'sina' : 'index';
  } else if (now >= distSkipUntil && now - lastDistSampleAt >= DIST_MIN_GAP) {
    lastDistSampleAt = now;
    const dist = await fetchDistribution().catch(() => null);
    if (dist !== null) {
      up = dist.up;
      down = dist.down;
      flat = dist.flat;
      source = 'market';
      distFails = 0;
      distSkipUntil = 0;
    } else {
      distFails += 1;
      if (distFails >= 3) {
        distFails = 0;
        distSkipUntil = now + 30 * 60000;
      }
    }
  }

  if (up === null || down === null) return points;

  points.push({ t: now, p: Number(sessionPos(now).toFixed(5)), up, down, flat: flat ?? 0, source });
  if (points.length > 400) points.splice(0, points.length - 400);

  store[today] = points;
  const dates = Object.keys(store).sort();
  for (const k of dates.slice(0, Math.max(0, dates.length - BSERIES_KEEP))) delete store[k];
  await set(KEYS.breadthSeries, store);
  return points;
}

/** 读取累积的涨跌家数分时（含上一交易日，供虚线对照） */
export async function fetchBreadthSeries(now = Date.now()) {
  const store = (await get(KEYS.breadthSeries, null)) ?? {};
  const today = ymd(now);
  const dates = Object.keys(store).sort();
  const prev = dates.filter((d) => d < today).pop() ?? null;
  const points = Array.isArray(store[today]) ? store[today] : [];
  return {
    // 存储键用紧凑的 YYYYMMDD，但对外给**可读**的 YYYY-MM-DD（界面直接拿去当标签用）
    date: dashDate(today),
    prevDate: prev ? dashDate(prev) : null,
    points,
    prevPoints: prev ? store[prev] ?? [] : [],
    days: dates.length,
    // 采样中但还画不出曲线时，前端要提示「累积中」而不是「无数据」
    sampling: points.length < 2,
  };
}

/** YYYYMMDD → YYYY-MM-DD（已是连字符格式则原样返回） */
function dashDate(s) {
  const t = String(s ?? '');
  return /^\d{8}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : t;
}

