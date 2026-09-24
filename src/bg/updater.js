/**
 * 版本检查与更新。
 *
 * ⚠️ 关于「自动更新」能到什么程度，先说清楚边界：
 *   本扩展以「加载已解压的扩展（开发者模式）」方式安装时，扩展目录对扩展自身的 JS
 *   是**只读**的 —— 没有任何扩展 API 能写入自己的安装目录。因此提供三级能力：
 *
 *   1. 检查：GitHub Releases / Tags API 对比版本，展示发布时间与更新说明
 *   2. 取包：打开发布页 / 源码 zip（由浏览器下载，不经过扩展）
 *   3. 就地更新：借助 **File System Access API** —— 用户在「关于」页授权一次扩展根目录，
 *      随后即可逐文件比对并覆盖写入，完成后提示点「重新加载」生效
 *
 *   第 3 条是唯一称得上「自动拉取更新」的路径，且必须由用户显式授权目录，
 *   这是浏览器的安全边界，不是实现偷懒。
 *
 *   若扩展是从 Edge 加载项商店安装的，另有 chrome.runtime.requestUpdateCheck()，
 *   由浏览器自行完成更新，见 checkStoreUpdate()。
 */
import { get, set } from './storage.js';
import { KEYS, DEFAULT_PREFS } from '../shared/model.js';

export const DEFAULT_REPO = DEFAULT_PREFS.updateRepo;

/* ───────────────────────────── 版本号 ─────────────────────────────────── */

/** "v1.2.3-beta.1" → [1,2,3]（只取点分数字段，忽略 v 前缀与 pre-release 后缀） */
export function parseVersion(input) {
  const s = String(input ?? '').trim().replace(/^v/i, '');
  const m = /^(\d+(?:\.\d+)*)/.exec(s);
  if (!m) return null;
  return m[1].split('.').map((n) => Number(n));
}

/** -1 / 0 / 1；无法解析的一侧按 -1 处理（视为更旧，避免误报有更新） */
export function compareVersion(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null && pb === null) return 0;
  if (pa === null) return -1;
  if (pb === null) return 1;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 是否形如 x.y.z（用于判断 tag 能不能当版本号用） */
export function looksLikeVersion(s) {
  return parseVersion(s) !== null;
}

/* ───────────────────────────── 仓库地址 ───────────────────────────────── */

/** "https://github.com/owner/repo" / "owner/repo" / "git@github.com:owner/repo.git" → "owner/repo" */
export function normalizeRepo(input) {
  let s = String(input ?? '').trim();
  if (s === '') return null;
  s = s.replace(/^git@github\.com:/i, '').replace(/\.git$/i, '');
  s = s.replace(/^https?:\/\/(?:www\.)?github\.com\//i, '');
  s = s.replace(/^\/+|\/+$/g, '');
  const m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(s);
  return m ? `${m[1]}/${m[2]}` : null;
}

/* ───────────────────────────── 请求 ───────────────────────────────────── */

const API = 'https://api.github.com';
const UA = 'tradewatcher-updater';

export class UpdateError extends Error {
  constructor(message, { status = 0, kind = 'unknown' } = {}) {
    super(message);
    this.name = 'UpdateError';
    this.status = status;
    this.kind = kind;   // http | notfound | ratelimit | network | parse | invalid
  }
}

async function ghJson(path, { timeoutMs = 12000 } = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch (error) {
    throw new UpdateError(`无法连接 GitHub：${String(error?.message ?? error)}`, { kind: 'network' });
  }
  if (res.status === 404) throw new UpdateError('仓库不存在或未公开（404）', { status: 404, kind: 'notfound' });
  if (res.status === 403 || res.status === 429) {
    const remain = res.headers.get('x-ratelimit-remaining');
    throw new UpdateError(
      remain === '0' ? 'GitHub API 匿名配额已用尽（每小时 60 次），请稍后再试' : 'GitHub 拒绝访问（403/429），可能触发限流',
      { status: res.status, kind: 'ratelimit' },
    );
  }
  if (!res.ok) throw new UpdateError(`GitHub 返回 HTTP ${res.status}`, { status: res.status, kind: 'http' });
  try {
    return await res.json();
  } catch {
    throw new UpdateError('GitHub 返回了非 JSON 内容', { kind: 'parse' });
  }
}

/* ───────────────────────── 查询最新版本 ───────────────────────────────── */

/**
 * 依次尝试 Releases → Tags → 默认分支最新提交。
 * 仓库只推了代码、没打 tag 时也能给出可用信息（用 commit sha 作标识）。
 */
export async function fetchLatest(repo, { includePrerelease = false } = {}) {
  const full = normalizeRepo(repo);
  if (full === null) throw new UpdateError(`仓库地址无法解析：${repo}`, { kind: 'invalid' });

  // 1) Releases
  try {
    const list = await ghJson(`/repos/${full}/releases?per_page=20`);
    if (Array.isArray(list) && list.length > 0) {
      const usable = list.filter((r) => includePrerelease || !r.prerelease);
      const pick = (usable.length > 0 ? usable : list).find((r) => looksLikeVersion(r.tag_name)) ?? (usable.length > 0 ? usable[0] : list[0]);
      if (pick) {
        const asset = (pick.assets ?? []).find((a) => /\.zip$/i.test(a.name ?? ''));
        return {
          repo: full,
          source: 'release',
          tag: pick.tag_name ?? null,
          name: pick.name || pick.tag_name || '未命名发布',
          publishedAt: pick.published_at ?? pick.created_at ?? null,
          notes: pick.body ?? '',
          htmlUrl: pick.html_url ?? `https://github.com/${full}/releases`,
          zipUrl: asset?.browser_download_url ?? pick.zipball_url ?? `https://github.com/${full}/archive/refs/tags/${pick.tag_name}.zip`,
          prerelease: !!pick.prerelease,
        };
      }
    }
  } catch (error) {
    if (error.kind === 'notfound' || error.kind === 'invalid') throw error;
    // 限流/网络问题：继续尝试 tags（不吃同一条配额路径）
  }

  // 2) Tags
  try {
    const tags = await ghJson(`/repos/${full}/tags?per_page=20`);
    if (Array.isArray(tags) && tags.length > 0) {
      const pick = tags.find((t) => looksLikeVersion(t.name)) ?? tags[0];
      return {
        repo: full,
        source: 'tag',
        tag: pick.name,
        name: pick.name,
        publishedAt: null,
        notes: '',
        htmlUrl: `https://github.com/${full}/releases/tag/${pick.name}`,
        zipUrl: `https://github.com/${full}/archive/refs/tags/${pick.name}.zip`,
        prerelease: false,
      };
    }
  } catch (error) {
    if (error.kind === 'notfound' || error.kind === 'invalid') throw error;
  }

  // 3) 默认分支最新提交（完全没有 tag 的仓库）
  const info = await ghJson(`/repos/${full}`);
  const branch = info.default_branch ?? 'main';
  const commits = await ghJson(`/repos/${full}/commits?per_page=1&sha=${encodeURIComponent(branch)}`);
  const head = Array.isArray(commits) && commits.length > 0 ? commits[0] : null;
  return {
    repo: full,
    source: 'commit',
    tag: null,
    name: `${branch} @ ${head ? String(head.sha).slice(0, 7) : 'HEAD'}`,
    publishedAt: head?.commit?.author?.date ?? null,
    notes: head?.commit?.message ?? '',
    htmlUrl: `https://github.com/${full}/commits/${branch}`,
    zipUrl: `https://github.com/${full}/archive/refs/heads/${branch}.zip`,
    prerelease: false,
    ref: branch,
  };
}

/**
 * 完整检查：返回可直接落盘 / 渲染的状态对象。
 * 永不抛错（错误写进 state.error），方便定时任务与 UI 复用。
 */
export async function checkForUpdate({ repo = DEFAULT_REPO, currentVersion, includePrerelease = false } = {}) {
  const current = currentVersion ?? chrome.runtime.getManifest().version;
  const base = { checkedAt: Date.now(), repo: normalizeRepo(repo) ?? String(repo), current };
  try {
    const latest = await fetchLatest(repo, { includePrerelease });
    const version = latest.tag ?? null;
    const hasUpdate = version !== null && looksLikeVersion(version) ? compareVersion(version, current) > 0 : false;
    return {
      ...base,
      ok: true,
      error: null,
      ...latest,
      version,
      hasUpdate,
      // 没有可比版本号（仓库无 tag）时无法判断新旧，前端应提示「以提交为准」
      comparable: version !== null && looksLikeVersion(version),
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      errorKind: error?.kind ?? 'unknown',
      hasUpdate: false,
      comparable: false,
    };
  }
}

/** 读取上次检查结果（不发起请求） */
export async function getUpdateState() {
  return (await get(KEYS.update, null)) ?? null;
}

/** 检查并落盘 */
export async function refreshUpdateState(opts = {}) {
  const state = await checkForUpdate(opts);
  await set(KEYS.update, state);
  return state;
}

/* ───────────────────── 商店安装时的原生更新通道 ───────────────────────── */

/**
 * 若扩展由 Edge 加载项商店分发，浏览器自身就能静默升级。
 * 非商店安装会返回 no_update 或抛错，属正常情况。
 */
export async function checkStoreUpdate() {
  if (typeof chrome.runtime.requestUpdateCheck !== 'function') {
    return { available: false, reason: '当前浏览器不支持 requestUpdateCheck' };
  }
  try {
    const r = await chrome.runtime.requestUpdateCheck();
    return {
      available: true,
      status: r?.status ?? 'unknown',   // no_update | update_available | throttle
      version: r?.version ?? null,
      note: r?.status === 'update_available' ? '浏览器已发现新版本，重启浏览器后生效' : null,
    };
  } catch (error) {
    return { available: false, reason: String(error?.message ?? error) };
  }
}

/* ───────────────────── 列出远端文件（就地更新用） ─────────────────────── */

/** 用 git tree API 递归取文件清单；返回 [{ path, size }] */
export async function listRemoteFiles(repo, ref) {
  const full = normalizeRepo(repo);
  if (full === null) throw new UpdateError(`仓库地址无法解析：${repo}`, { kind: 'invalid' });
  const target = ref ?? (await ghJson(`/repos/${full}`)).default_branch ?? 'main';
  const tree = await ghJson(`/repos/${full}/git/trees/${encodeURIComponent(target)}?recursive=1`);
  const nodes = tree?.tree;
  if (!Array.isArray(nodes)) throw new UpdateError('无法读取仓库文件清单', { kind: 'parse' });
  return nodes
    .filter((n) => n.type === 'blob')
    .map((n) => ({ path: n.path, size: n.size ?? 0 }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** 取远端单个文件内容。
 *  先走 raw.githubusercontent（不占 API 配额）；它被网络策略阻断时退回 API contents
 *  （带 Accept: application/vnd.github.raw，直接返回原始字节，不消耗额外的 base64 解码）。
 */
export async function fetchRemoteFile(repo, ref, path) {
  const full = normalizeRepo(repo);
  if (full === null) throw new UpdateError(`仓库地址无法解析：${repo}`, { kind: 'invalid' });
  const encoded = path.split('/').map(encodeURIComponent).join('/');

  const viaRaw = `https://raw.githubusercontent.com/${full}/${encodeURIComponent(ref)}/${encoded}`;
  try {
    const res = await fetch(viaRaw, { signal: AbortSignal.timeout(20000), cache: 'no-store', credentials: 'omit' });
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    if (res.status === 404) throw new UpdateError(`${path} 在远端不存在（404）`, { status: 404, kind: 'notfound' });
  } catch (error) {
    if (error instanceof UpdateError && error.status === 404) throw error;
    // 网络层失败（如 raw 域名被墙）：落到 API
  }

  const viaApi = `${API}/repos/${full}/contents/${encoded}?ref=${encodeURIComponent(ref)}`;
  let res2;
  try {
    res2 = await fetch(viaApi, {
      headers: { accept: 'application/vnd.github.raw', 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(20000),
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch (error) {
    throw new UpdateError(`下载 ${path} 失败（raw 与 API 均不可达）：${String(error?.message ?? error)}`, { kind: 'network' });
  }
  if (res2.status === 403 || res2.status === 429) {
    throw new UpdateError(`下载 ${path} 失败：GitHub API 配额不足（403/429）`, { status: res2.status, kind: 'ratelimit' });
  }
  if (!res2.ok) throw new UpdateError(`下载 ${path} 失败：HTTP ${res2.status}`, { status: res2.status, kind: 'http' });
  return new Uint8Array(await res2.arrayBuffer());
}

/* ─────────────────── 整包下载 + 内置 ZIP 解压（首选传输） ──────────────── */

/**
 * 为什么优先整包而不是逐文件 raw：
 *  - 逐文件需要 N 次请求，任一域名被网络策略阻断就整体失败（raw.githubusercontent 在国内常见被阻断）；
 *  - 整包只需 1 次 codeload 请求，天然规避 N 次往返与配额消耗。
 * 代价是要自己解 ZIP —— 下面用 DecompressionStream('deflate-raw') 实现，约 60 行。
 */

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') throw new UpdateError('当前浏览器不支持 DecompressionStream，无法解压 zip', { kind: 'unsupported' });
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 最小 ZIP 读取器：只支持 store(0) 与 deflate(8)，足够读 GitHub 归档包 */
export async function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 从尾部往前找 EOCD（0x06054b50），注释最长 64KB，故最多回退 65557 字节
  let eocd = -1;
  const minPos = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= minPos; i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new UpdateError('不是有效的 zip（未找到 EOCD 记录）', { kind: 'parse' });

  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const files = new Map();

  for (let n = 0; n < count; n += 1) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new UpdateError('zip 中央目录结构损坏', { kind: 'parse' });
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;   // 目录项

    // 本地头的 name/extra 长度可能与中央目录不同，必须重新读，否则数据起点会错位
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);

    if (method === 0) files.set(name, raw.slice());
    else if (method === 8) files.set(name, await inflateRaw(raw));
    else throw new UpdateError(`不支持的压缩方式 ${method}（${name}）`, { kind: 'unsupported' });
  }
  return files;
}

/**
 * 下载并解压 GitHub 归档包。
 * @returns {Promise<Map<string, Uint8Array>>} key 为**去掉顶层目录**后的仓库相对路径
 */
export async function downloadRepoZip(repo, ref, { signal } = {}) {
  const full = normalizeRepo(repo);
  if (full === null) throw new UpdateError(`仓库地址无法解析：${repo}`, { kind: 'invalid' });
  if (!ref) throw new UpdateError('缺少要下载的版本标识（tag / 分支）', { kind: 'invalid' });

  // github.com/.../archive/<ref>.zip 会 302 到 codeload，tag 与分支都能解析
  const url = `https://github.com/${full}/archive/${encodeURIComponent(ref)}.zip`;
  let res;
  try {
    res = await fetch(url, { signal: signal ?? AbortSignal.timeout(60000), cache: 'no-store', credentials: 'omit' });
  } catch (error) {
    throw new UpdateError(`下载归档包失败：${String(error?.message ?? error)}`, { kind: 'network' });
  }
  if (res.status === 404) throw new UpdateError(`远端没有 ${ref} 这个 tag / 分支（404）`, { status: 404, kind: 'notfound' });
  if (!res.ok) throw new UpdateError(`下载归档包失败：HTTP ${res.status}`, { status: res.status, kind: 'http' });

  const buf = new Uint8Array(await res.arrayBuffer());
  const entries = await unzip(buf);

  // 去掉 GitHub 自动加的 "<仓库名>-<ref>/" 顶层目录
  const out = new Map();
  for (const [name, data] of entries) {
    const slash = name.indexOf('/');
    if (slash < 0) continue;   // 顶层没有目录的异常包，跳过
    out.set(name.slice(slash + 1), data);
  }
  if (out.size === 0) throw new UpdateError('归档包解压后没有文件', { kind: 'parse' });
  return out;
}

/* ───────────────────── 目录写入（File System Access） ─────────────────── */

export function supportsDirectoryWrite() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function' && window.isSecureContext;
}

/** 逐级取（必要时创建）子目录句柄 */
async function dirAt(root, segments, { create }) {
  let cur = root;
  for (const seg of segments) cur = await cur.getDirectoryHandle(seg, { create });
  return cur;
}

async function readLocal(root, path) {
  try {
    const parts = path.split('/');
    const dir = await dirAt(root, parts.slice(0, -1), { create: false });
    const fh = await dir.getFileHandle(parts[parts.length - 1]);
    return new Uint8Array(await (await fh.getFile()).arrayBuffer());
  } catch {
    return null;   // 不存在 / 无权限
  }
}

async function writeLocal(root, path, bytes) {
  const parts = path.split('/');
  const dir = await dirAt(root, parts.slice(0, -1), { create: true });
  const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
  const w = await fh.createWritable();
  await w.write(bytes);
  await w.close();
}

function bytesEqual(a, b) {
  if (a === null || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 把远端仓库的文件同步到用户授权的扩展目录。
 *  - 传输优先「整包 zip」（1 次请求），失败才退回逐文件 raw / API
 *  - 只写「新增」与「内容有变化」的文件，内容一致则跳过
 *  - **不会删除**本地多出来的文件（用户自己的截图、日志等安全）
 *  - dryRun 只比对不写入，用于更新前预览
 *
 * @param {{repo:string, ref:string, dirHandle:FileSystemDirectoryHandle, dryRun?:boolean,
 *          onProgress?:Function, signal?:AbortSignal, transport?:'auto'|'zip'|'files'}} opts
 *   onProgress 回调载荷：{ phase:'download'|'compare', done, total, path? }
 */
export async function syncFromGitHub({ repo, ref, dirHandle, dryRun = false, onProgress, signal, transport = 'auto' }) {
  let zipMap = null;
  let zipError = null;

  if (transport !== 'files') {
    onProgress?.({ phase: 'download', done: 0, total: 1 });
    try {
      zipMap = await downloadRepoZip(repo, ref, { signal });
      onProgress?.({ phase: 'download', done: 1, total: 1 });
    } catch (error) {
      zipError = error;
      if (transport === 'zip') throw error;
      // auto 模式下退回逐文件
    }
  }

  let files;
  if (zipMap !== null) {
    files = [...zipMap.entries()].map(([path, data]) => ({ path, size: data.length })).sort((a, b) => a.path.localeCompare(b.path));
  } else {
    try {
      files = await listRemoteFiles(repo, ref);
    } catch (error) {
      // 两条路都不通时，把更有信息量的一条错误抛出去
      throw zipError ?? error;
    }
  }

  const added = [];
  const updated = [];
  const unchanged = [];
  const failed = [];

  for (let i = 0; i < files.length; i += 1) {
    if (signal?.aborted) throw new Error('已取消');
    const f = files[i];
    try {
      const remote = zipMap !== null ? zipMap.get(f.path) : await fetchRemoteFile(repo, ref, f.path);
      const local = await readLocal(dirHandle, f.path);
      if (bytesEqual(local, remote)) {
        unchanged.push(f.path);
      } else if (local === null) {
        if (!dryRun) await writeLocal(dirHandle, f.path, remote);
        added.push(f.path);
      } else {
        if (!dryRun) await writeLocal(dirHandle, f.path, remote);
        updated.push(f.path);
      }
    } catch (error) {
      failed.push({ path: f.path, error: String(error?.message ?? error) });
    }
    onProgress?.({ phase: 'compare', done: i + 1, total: files.length, path: f.path });
  }

  return {
    total: files.length,
    added,
    updated,
    unchanged,
    failed,
    dryRun,
    transport: zipMap !== null ? 'zip' : 'files',
  };
}

/* ───────────────────────── 旧句柄的复用 ──────────────────────────────── */

const HANDLE_DB = 'tw-update';
const HANDLE_STORE = 'handles';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(HANDLE_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 记住上次授权的目录句柄，下次不必再选（权限仍需每会话确认一次） */
export async function saveDirHandle(handle) {
  const db = await idb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite');
    tx.objectStore(HANDLE_STORE).put(handle, 'root');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadDirHandle() {
  try {
    const db = await idb();
    const handle = await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const req = tx.objectStore(HANDLE_STORE).get('root');
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle ?? null;
  } catch {
    return null;
  }
}

/** 查询/申请目录读写权限 */
export async function ensurePermission(handle, { request = true } = {}) {
  if (!handle) return false;
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if (!request) return false;
  return (await handle.requestPermission(opts)) === 'granted';
}
