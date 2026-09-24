/**
 * 界面层数据缓存：让首屏与页签切换「先出内容、再补刷新」。
 *
 * 与 bg/em.js 里 ttlCache 的分工：
 *  - ttlCache 活在 service worker 内，SW 被回收即失效，只解决同一次唤醒内的重复请求；
 *  - 本模块活在面板（侧边栏 / 弹窗）进程内，并把热点数据镜像到 chrome.storage.local，
 *    因此**面板重开、浏览器重启后依然能立刻画出上一次的内容**。
 *
 * 采用 stale-while-revalidate：
 *  - 命中且未过期 → 直接返回，完全不发请求
 *  - 命中但已过期 → **立刻**返回旧值渲染，同时后台刷新，完成后通知订阅者重绘
 *  - 未命中       → 等待请求（只有首次打开某页签才会发生）
 */

const PREFIX = 'tw:cache:';

/**
 * 需要跨会话持久化的键。
 * 只放「体积小 + 首屏立刻要用 + 允许略旧」的数据；行情快照单独处理（见 panel.js）。
 */
const PERSIST = new Set([
  'quotes',
  'breadth',
  'distribution',
  'turnover',
  'margin',
  'breadthSeries',
  'hsgt',
  'meta',
]);

/** key → { value, at } */
const mem = new Map();
/** key → Promise（同一 key 的并发请求合并） */
const inflight = new Map();
/** key → Set<cb> */
const subs = new Map();
/** 全局订阅（面板据此防抖重绘当前页签） */
const anySubs = new Set();

let hydrated = false;

/* ── 读 ───────────────────────────────────────────────────────────────── */

/** 同步取缓存值（没有则 null）。用于「渲染前先铺一层旧数据」。 */
export function peek(key) {
  const hit = mem.get(key);
  return hit ? hit.value : null;
}

/** 缓存年龄（ms）；未命中为 Infinity。 */
export function ageOf(key) {
  const hit = mem.get(key);
  return hit ? Date.now() - hit.at : Infinity;
}

export function has(key) {
  return mem.has(key);
}

/* ── 写 ───────────────────────────────────────────────────────────────── */

/** 直接写入缓存并通知订阅者（不触发请求）。 */
export function put(key, value, { persist = true } = {}) {
  mem.set(key, { value, at: Date.now() });
  if (persist && PERSIST.has(key)) queueWrite(key);
  notify(key, value);
}

export function invalidate(key) {
  mem.delete(key);
  if (PERSIST.has(key)) {
    chrome.storage.local.remove(PREFIX + key).catch(() => {});
  }
}

/**
 * 按前缀失效。用于键里带动态参数的缓存（如 `calendar:<from>:<to>`），
 * 逐个枚举键不可靠，按前缀整体清掉更稳。
 */
export function invalidatePrefix(prefix) {
  for (const key of [...mem.keys()]) {
    if (key.startsWith(prefix)) invalidate(key);
  }
}

/**
 * 落盘做 600ms 合并：行情快照这类高频写入不会把 storage 打满。
 * 注意取的是 flush 时刻的 mem 值（而非入队时的值），因此连续写入只落最新一份。
 */
const dirty = new Set();
let writeTimer = null;

function queueWrite(key) {
  dirty.add(key);
  if (writeTimer) return;
  writeTimer = setTimeout(flushWrites, 600);
}

async function flushWrites() {
  writeTimer = null;
  const patch = {};
  for (const k of dirty) {
    const hit = mem.get(k);
    if (hit) patch[PREFIX + k] = { v: hit.value, at: hit.at };
  }
  dirty.clear();
  try {
    await chrome.storage.local.set(patch);
  } catch {
    /* 配额或权限问题：缓存失败不影响主流程 */
  }
}

/* ── 订阅 ─────────────────────────────────────────────────────────────── */

export function subscribe(key, cb) {
  if (!subs.has(key)) subs.set(key, new Set());
  subs.get(key).add(cb);
  return () => subs.get(key)?.delete(cb);
}

/** 任意键更新时回调（面板用它防抖重绘，避免为每个键单独接线）。 */
export function onAnyUpdate(cb) {
  anySubs.add(cb);
  return () => anySubs.delete(cb);
}

function notify(key, value) {
  for (const cb of subs.get(key) ?? []) {
    try {
      cb(value, key);
    } catch {
      /* 单个订阅者出错不影响其他订阅者 */
    }
  }
  for (const cb of anySubs) {
    try {
      cb(value, key);
    } catch {
      /* 同上 */
    }
  }
}

/* ── 核心：stale-while-revalidate ─────────────────────────────────────── */

/**
 * 取数据（带缓存）。
 * @param {string} key
 * @param {number} ttlMs 新鲜期；超过则后台刷新
 * @param {() => Promise<any>} loader 真正取数的函数
 * @param {{persist?: boolean}} [opts]
 * @returns {Promise<any>}
 */
export function memo(key, ttlMs, loader, opts = {}) {
  const hit = mem.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value);

  let p = inflight.get(key);
  if (!p) {
    p = Promise.resolve()
      .then(loader)
      .then((value) => {
        inflight.delete(key);
        // loader 返回 undefined 视为「本次无数据」，保留旧值，避免把缓存打空
        if (value !== undefined) put(key, value, opts);
        return value;
      })
      .catch((error) => {
        inflight.delete(key);
        throw error;
      });
    inflight.set(key, p);
    // 后台刷新失败不应产生 unhandled rejection
    p.catch(() => {});
  }

  // 有旧值就先用旧值渲染，刷新结果通过订阅者回来重绘
  if (hit) return Promise.resolve(hit.value);
  return p;
}

/** 强制刷新（忽略 TTL），返回最新值。 */
export async function refresh(key, loader, opts = {}) {
  const p = Promise.resolve().then(loader).then((value) => {
    inflight.delete(key);
    if (value !== undefined) put(key, value, opts);
    return value;
  });
  inflight.set(key, p);
  return p;
}

/* ── 冷启动水合 ───────────────────────────────────────────────────────── */

/** 从 chrome.storage.local 恢复持久化的键。应在面板启动时最先调用一次。 */
export async function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const keys = [...PERSIST].map((k) => PREFIX + k);
    const raw = await chrome.storage.local.get(keys);
    for (const k of PERSIST) {
      const rec = raw[PREFIX + k];
      if (rec && typeof rec === 'object' && 'v' in rec && typeof rec.at === 'number') {
        mem.set(k, { value: rec.v, at: rec.at });
      }
    }
  } catch {
    /* 首次运行没有缓存 */
  }
}

/** 诊断用：当前缓存的键与年龄。 */
export function debugSnapshot() {
  return [...mem.entries()].map(([k, v]) => ({ key: k, ageMs: Date.now() - v.at }));
}
