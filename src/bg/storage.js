/**
 * chrome.storage 轻封装（Promise 化）+ 内存级缓存。
 * 后台与各界面模块共用。
 */

export const local = chrome.storage.local;
export const session = chrome.storage.session ?? chrome.storage.local;

/** 读取单个键（local） */
export async function get(key, fallback = undefined) {
  const obj = await local.get(key);
  return obj[key] === undefined ? fallback : obj[key];
}

/** 读取多个键 */
export async function getMany(keys) {
  return local.get(keys);
}

/** 写入单个/多个键（local） */
export async function set(keyOrObj, value) {
  if (typeof keyOrObj === 'string') await local.set({ [keyOrObj]: value });
  else await local.set(keyOrObj);
}

/** 删除键 */
export async function del(key) {
  await local.remove(key);
}

/** 会话级读写（不落盘；service worker 重启后仍保留，适合 last-known-good） */
export async function sget(key, fallback = undefined) {
  const obj = await session.get(key);
  return obj[key] === undefined ? fallback : obj[key];
}

export async function sset(keyOrObj, value) {
  if (typeof keyOrObj === 'string') await session.set({ [keyOrObj]: value });
  else await session.set(keyOrObj);
}

/** 带默认值的读取 + 浅合并（用于偏好设置） */
export async function getMerged(key, defaults) {
  const cur = (await get(key, null)) ?? {};
  return { ...defaults, ...cur };
}

/** 简单的内存 LRU（进程内），避免对相同入参重复读 storage */
const memCache = new Map();
const MEM_MAX = 400;

export function memGet(key) {
  const hit = memCache.get(key);
  if (hit === undefined) return undefined;
  if (Date.now() > hit.exp) {
    memCache.delete(key);
    return undefined;
  }
  return hit.value;
}

export function memSet(key, value, ttlMs) {
  if (memCache.size > MEM_MAX) {
    const drop = memCache.size - MEM_MAX;
    let n = 0;
    for (const k of memCache.keys()) {
      memCache.delete(k);
      if (++n >= drop) break;
    }
  }
  memCache.set(key, { exp: Date.now() + ttlMs, value });
}
