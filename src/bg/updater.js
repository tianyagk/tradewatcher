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
import { KEYS, UPDATE_REPO } from '../shared/model.js';

/** 默认（也是唯一）更新源：本项目仓库 */
export const DEFAULT_REPO = UPDATE_REPO;

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

/**
 * 已知的 API 配额冷却截止时间（毫秒时间戳）。
 *
 * 为什么要记：一旦撞上配额用尽，**后续每一次请求都注定失败**，再来回试只是白等。
 * 记下来之后，配额期内所有 API 调用直接短路，改走免配额路径（见 fetchLatest）。
 * 时间取自响应头 `x-ratelimit-reset`（unix 秒），比"等一小时"精确。
 */
let apiBlockedUntil = 0;

/** 当前是否处于「已知配额用尽」状态（据此跳过注定失败的 API 调用） */
export function apiQuotaExhausted() {
  return Date.now() < apiBlockedUntil;
}

/** 仅供测试复位 */
export function __resetApiQuota() {
  apiBlockedUntil = 0;
}

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
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    // 配额确实用尽时把这个时间点记下来，后续 API 调用直接短路
    if (remain === '0' && Number.isFinite(reset) && reset > 0) apiBlockedUntil = reset * 1000 + 5000;
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

  // ① 免配额主路径：远端 manifest.json（raw → 归档 zip）。
  //    「有没有新版本」比的就是扩展的版本号，而这个号就写在远端 manifest 里，
  //    读它不需要任何 API 配额。这条路径拿到结果就直接返回 —— 正常情况下一个
  //    api.github.com 请求都不会发，配额用尽也照样能检查。
  const mf = await remoteManifest(full).catch(() => null);
  if (mf !== null) {
    return {
      repo: full,
      source: 'manifest',
      tag: null,
      name: `${mf.branch} 分支`,
      publishedAt: null,
      notes: '',
      htmlUrl: `https://github.com/${full}/tree/${mf.branch}`,
      zipUrl: `https://github.com/${full}/archive/refs/heads/${mf.branch}.zip`,
      prerelease: false,
      ref: mf.branch,
      version: mf.version,
    };
  }

  // ② 免配额路径拿不到版本，才动用需要配额的 API（Releases → Tags）。
  //    配额已用尽就直接跳过，不发起注定失败的请求。
  //
  //    注意这里的取舍：API 是**兜底**而不是「始终执行的增强」。上游用 tag 当发布身份
  //    时确实信息更全（changelog / 发布时间），但对本扩展而言 manifest 里的版本号
  //    才是「代码实际处于哪个版本」的权威值，而且免配额 —— 不值得为了 changelog
  //    每次都烧掉 2/60 的配额。
  let api = null;
  if (!apiQuotaExhausted()) {
    try {
      api = await tryReleaseOrTag(full, includePrerelease);
    } catch (error) {
      if (error.kind === 'notfound' || error.kind === 'invalid') throw error;
      // 限流/网络问题都不致命，下面还有 commits 这条最后的路
    }
  }
  if (api !== null) {
    return { ...api, ref: api.ref ?? null, version: looksLikeVersion(api.tag) ? api.tag : null };
  }

  // ③ 兜底到底：默认分支最新提交（仍要配额）。
  //    走到这里通常意味着：仓库没有 manifest.json，且 raw/归档都读不到。
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
    version: null,
  };
}

/**
 * Releases → Tags（**消耗 API 配额**，故调用方应先确认配额可用）。
 * 两级都拿不到可用的发布信息时返回 null，而不是抛错 —— 让调用方继续走免配额路径。
 */
async function tryReleaseOrTag(full, includePrerelease) {
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
    // 限流/网络问题：继续尝试 tags
  }

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

  return null;
}

/** 从 manifest.json 文本里取版本号；不是合法 manifest 就返回 null（不抛错） */
function versionOfManifestText(text) {
  try {
    const v = JSON.parse(text)?.version;
    return typeof v === 'string' && looksLikeVersion(v) ? v : null;
  } catch {
    return null;
  }
}

/** 检查路径上「只为读 manifest 而下载归档」的体积上限：2.8MB 的本项目绰绰有余 */
const MANIFEST_PROBE_MAX_BYTES = 12 * 1024 * 1024;

/**
 * **免配额**地拿到远端版本号 —— 这是「检查更新」的主路径。
 *
 * 为什么不靠 API：匿名 API 只有 60 次/小时，一撞上限整个检查就废了（用户实际遇到的就是
 * 「检查失败 · 配额已用尽」）。而扩展的版本号本来就写在远端 manifest.json 里，
 * 读它根本不需要 API 配额：
 *
 *   ① raw.githubusercontent.com 直读（最省，一次请求；该域名被墙时由熔断秒过）
 *   ② 归档 zip 里读（走 codeload，仍然零配额；用实际更新时同一条链路）
 *
 * @returns {Promise<{branch:string, version:string}|null>}
 */
async function remoteManifest(full) {
  const guesses = ['main', 'master'];
  const tried = new Set();

  /** 阶段一：只走 raw（零配额）。conclusive=true 表示 raw 给出了明确结论。 */
  const tryRaw = async (branch) => {
    if (!branch || tried.has(branch)) return { hit: null, conclusive: true };
    tried.add(branch);
    try {
      const bytes = await fetchRemoteFile(full, branch, 'manifest.json', { rawTimeoutMs: 6000, allowApi: false });
      const v = versionOfManifestText(new TextDecoder().decode(bytes));
      // 文件拿到了但没有合法 version → 归档里也是同一份，不必再下
      return { hit: v ? { branch, version: v } : null, conclusive: true };
    } catch (error) {
      // raw 明确回 404：这个分支没有 manifest.json → 不是这类项目
      return { hit: null, conclusive: error?.kind === 'notfound' };
    }
  };

  // 先按约定俗成试 main / master：**完全不花配额**。猜错的代价只是一次快速 404。
  let sawConclusive = false;
  for (const b of guesses) {
    const r = await tryRaw(b);
    if (r.hit) return r.hit;
    if (r.conclusive) sawConclusive = true;
  }
  // raw 是通的、且明确告诉我们「没有 manifest.json」→ 到此为止。
  // 少了这个判断，对 microsoft/vscode 之类的仓库每次检查都会白拉十几 MB。
  if (sawConclusive) return null;

  // 阶段二：raw 不可达（域名被墙等），才动用归档这条重路径。**依然零配额** ——
  // 这里刻意不调 `/repos/{full}` 去问体积或默认分支：那会把这个兜底重新绑回 API 配额，
  // 而「配额用尽时仍能检查」正是本轮要保证的性质。
  // 代价是大仓库可能白拉一段，由 downloadRepoZip 的流式上限兜住（超限即中断）。
  for (const branch of guesses) {
    try {
      const map = await downloadRepoZip(full, branch, { maxBytes: MANIFEST_PROBE_MAX_BYTES });
      const entry = map.get('manifest.json');
      if (!entry) continue;
      const v = versionOfManifestText(new TextDecoder().decode(entry));
      if (v) return { branch, version: v };
    } catch { /* 换下一个候选分支 */ }
  }
  return null;
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
    // fetchLatest 已把版本号收敛好：免配额的 manifest 路径直接给 version；
    // 只有走 API 兜底时才可能带 tag（tag 优先于 null）。
    const tagVersion = looksLikeVersion(latest.tag) ? latest.tag : null;
    const version = tagVersion ?? latest.version ?? null;
    const hasUpdate = version !== null ? compareVersion(version, current) > 0 : false;
    return {
      ...base,
      ok: true,
      error: null,
      ...latest,
      version,
      hasUpdate,
      // 没有可比版本号（既无 tag，也读不到远端 manifest 版本）时无法判断新旧
      comparable: version !== null,
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

/**
 * raw 域名的「熔断」负缓存。
 *
 * 在部分网络环境（国内常见）`raw.githubusercontent.com` **整条域名不可达**：
 * TCP 连接会一直挂住，不会立刻 RST，于是每次调用都要白等到超时才落回 API。
 * 实测该域名连接挂满 25s，而同一时刻 api.github.com 1.2s 就返回了 ——
 * 单次检查里白等 20s，足以让「检查更新」直接不可用。
 *
 * 所以：raw 一旦被判为「网络层不可用」，在冷却期内直接跳过、只走 API；
 * 冷却期到后再给 raw 一次机会（网络恢复无需重载扩展）。
 *
 * 只对**网络层失败**熔断。HTTP 404 说明 raw 是通的、只是这个文件/ref 不存在，
 * 属于正常业务结果，绝不能触发熔断。
 */
const RAW_COOLDOWN_MS = 10 * 60 * 1000;
let rawDownUntil = 0;

/** 取远端单个文件内容。
 *  先走 raw.githubusercontent（不占 API 配额）；它被网络策略阻断时退回 API contents
 *  （带 Accept: application/vnd.github.raw，直接返回原始字节，不消耗额外的 base64 解码）。
 *
 *  `rawTimeoutMs` 可调：调用方若只是读一个小文件、且对延迟敏感，可以给一个更短的预算，
 *  避免在 raw 不可达的环境里把首屏拖长。默认仍是 20s。
 *
 *  `allowApi=false` 时**完全不碰 api.github.com**：raw 不通就直接失败，把兜底留给调用方
 *  自己选（比如改用归档 zip）。用于「配额可能已用尽，不许再消耗配额」的场景。
 */
export async function fetchRemoteFile(repo, ref, path, { rawTimeoutMs = 20000, allowApi = true } = {}) {
  const full = normalizeRepo(repo);
  if (full === null) throw new UpdateError(`仓库地址无法解析：${repo}`, { kind: 'invalid' });
  const encoded = path.split('/').map(encodeURIComponent).join('/');

  const viaRaw = `https://raw.githubusercontent.com/${full}/${encodeURIComponent(ref)}/${encoded}`;
  if (Date.now() >= rawDownUntil) {
    try {
      const res = await fetch(viaRaw, { signal: AbortSignal.timeout(rawTimeoutMs), cache: 'no-store', credentials: 'omit' });
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      if (res.status === 404) throw new UpdateError(`${path} 在远端不存在（404）`, { status: 404, kind: 'notfound' });
      // 其余 HTTP 状态（如 5xx）不上报，继续走 API 兜底
    } catch (error) {
      if (error instanceof UpdateError && error.status === 404) throw error;
      // 网络层失败（域名被墙 / DNS 挂住 / 超时中止）→ 熔断 raw，后续请求直接走 API
      rawDownUntil = Date.now() + RAW_COOLDOWN_MS;
    }
  }

  if (!allowApi) {
    throw new UpdateError(`${path}：raw 不可用，且调用方已禁用 API 兜底`, { kind: 'network' });
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
 * 下载归档 zip 的原始字节，带**流式体积上限**。
 *
 * 两道保护都是被真机实测逼出来的：
 *  1. codeload **不返回 Content-Length**（实测响应头里只有 `Content-Type: application/zip`，
 *     是 chunked 流），所以没法先看大小再决定要不要下 —— 只能边读边累计，超限立刻中断。
 *     否则调用方一旦指向大仓库（如 microsoft/vscode），就会把几百 MB 拉进内存。
 *  2. codeload **忽略 Range**（实测 `-r 0-1023` 仍返回 200 并开始发全量），
 *     所以「只取 zip 尾部中央目录」这种省流量的取巧做法在这里不成立。
 */
async function fetchArchiveBytes(full, ref, { signal, maxBytes = Infinity } = {}) {
  // github.com/.../archive/<ref>.zip 会 302 到 codeload，tag 与分支都能解析
  const url = `https://github.com/${full}/archive/${encodeURIComponent(ref)}.zip`;
  let res;
  try {
    res = await fetch(url, { signal: signal ?? AbortSignal.timeout(120000), cache: 'no-store', credentials: 'omit' });
  } catch (error) {
    throw new UpdateError(`下载归档包失败：${String(error?.message ?? error)}`, { kind: 'network' });
  }
  if (res.status === 404) throw new UpdateError(`远端没有 ${ref} 这个 tag / 分支（404）`, { status: 404, kind: 'notfound' });
  if (!res.ok) throw new UpdateError(`下载归档包失败：HTTP ${res.status}`, { status: res.status, kind: 'http' });

  // 有 Content-Length 时先用它挡一次，省掉无谓的传输
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await res.body?.cancel(); } catch { /* 忽略 */ }
    throw new UpdateError(`归档包 ${declared} 字节，超出上限 ${maxBytes}，已跳过`, { kind: 'toobig' });
  }

  if (!res.body) return new Uint8Array(await res.arrayBuffer());   // 无流式 body 的降级路径

  const chunks = [];
  let total = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        throw new UpdateError(`归档包超过上限 ${maxBytes} 字节，已中断下载`, { kind: 'toobig' });
      }
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* 忽略 */ }
    if (error instanceof UpdateError) throw error;
    throw new UpdateError(`读取归档包失败：${String(error?.message ?? error)}`, { kind: 'network' });
  }

  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** 「就地更新」时整包的体积上限：够大以容纳正常扩展，又能挡住误配的大仓库 */
const UPDATE_MAX_BYTES = 128 * 1024 * 1024;

/**
 * 下载并解压 GitHub 归档包。
 * @param {{signal?:AbortSignal, maxBytes?:number}} [opts]
 * @returns {Promise<Map<string, Uint8Array>>} key 为**去掉顶层目录**后的仓库相对路径
 */
export async function downloadRepoZip(repo, ref, { signal, maxBytes = UPDATE_MAX_BYTES } = {}) {
  const full = normalizeRepo(repo);
  if (full === null) throw new UpdateError(`仓库地址无法解析：${repo}`, { kind: 'invalid' });
  if (!ref) throw new UpdateError('缺少要下载的版本标识（tag / 分支）', { kind: 'invalid' });

  const buf = await fetchArchiveBytes(full, ref, { signal, maxBytes });
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
