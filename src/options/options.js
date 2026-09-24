/** 设置页：外观与刷新 / 预警管理 / 数据 / 关于。 */
import { h, mount, qs, toast, applyPrefs, watchSystemTheme, promptModal, confirmModal } from '../ui/dom.js';
import * as api from '../ui/api.js';
import * as updater from '../bg/updater.js';
import { ALERT_FIELD_LABEL, CORE_INDICES, STRIP_ROWS, UPDATE_REPO } from '../shared/model.js';
import { fmtDateTime, fmtPct, pctClass } from '../shared/format.js';

const SECTIONS = [
  { key: 'appearance', label: '外观与刷新' },
  { key: 'alerts', label: '价格预警' },
  { key: 'data', label: '数据管理' },
  { key: 'about', label: '关于' },
];

const state = { prefs: null, section: 'appearance', watch: null, alerts: [], log: [] };

/* ── 通用控件 ─────────────────────────────────────────────────────────── */

function row(label, desc, control) {
  return h('div', { class: 'op-row' }, h('div', { class: 'lbl' }, h('b', { text: label }), desc ? h('span', { text: desc }) : null), h('div', { class: 'ctl' }, control));
}

function switchCtl(value, onChange) {
  const el = h('div', { class: `tw-switch ${value ? 'on' : ''}`, onclick: () => onChange(!value) });
  return el;
}

function seg(value, options, onChange) {
  const box = h('div', { class: 'tw-seg' });
  for (const o of options) box.append(h('button', { class: o.value === value ? 'on' : '', onclick: () => onChange(o.value) }, o.label));
  return box;
}

async function patch(p) {
  state.prefs = await api.prefs.set(p);
  applyPrefs(state.prefs);
  render();
}

/** 保存偏好但**不重渲染**。用于「关于」页的输入框/开关：整页重绘会打断输入与更新进度。 */
async function patchQuiet(p) {
  state.prefs = await api.prefs.set(p);
  applyPrefs(state.prefs);
}

/** 自带状态的小开关（patchQuiet 场景下不能依赖重渲染更新外观） */
function toggleCtl(value, onChange) {
  const el = h('div', {
    class: `tw-switch ${value ? 'on' : ''}`,
    onclick: async () => {
      const next = !el.classList.contains('on');
      el.classList.toggle('on', next);
      await onChange(next);
    },
  });
  return el;
}

/* ── 外观 ─────────────────────────────────────────────────────────────── */

function renderAppearance() {
  const p = state.prefs;
  const sec = h('div');

  const tabsBox = h('div', { class: 'op-chips' });
  for (const r of STRIP_ROWS) {
    const on = (p.showStrip ?? []).includes(r.key);
    tabsBox.append(h('button', {
      class: `tw-pill ${on ? 'on' : ''}`,
      onclick: () => {
        const cur = new Set(p.showStrip ?? []);
        if (cur.has(r.key)) cur.delete(r.key); else cur.add(r.key);
        patch({ showStrip: [...cur] });
      },
    }, r.label));
  }

  const badgeTargets = h('select', { class: 'tw-select', onchange: (e) => patch({ badgeTarget: e.target.value }) });
  for (const i of CORE_INDICES) badgeTargets.append(h('option', { value: i.secid, selected: p.badgeTarget === i.secid }, i.name));
  for (const it of (state.watch?.items ?? []).slice(0, 60)) badgeTargets.append(h('option', { value: it.secid, selected: p.badgeTarget === it.secid }, it.name || it.secid));

  sec.append(
    h('div', { class: 'op-card' },
      h('h3', { text: '外观' }),
      row('主题', '跟随系统 / 固定浅色 / 固定深色', seg(p.theme, [
        { value: 'auto', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' },
      ], (v) => patch({ theme: v }))),
      row('红涨绿跌', 'A 股配色习惯；关闭后为绿涨红跌（欧美习惯）', switchCtl(p.redUp, (v) => patch({ redUp: v }))),
      row('极简 / 隐蔽模式', '整体去色，只有强弱对比，适合上班摸鱼盯盘', switchCtl(p.maskMode, (v) => patch({ maskMode: v }))),
      row('不透明度', '降低整体不透明度，配合极简模式更隐蔽', h('div', { class: 'op-range' },
        h('input', { type: 'range', min: 40, max: 100, step: 5, value: p.opacity, oninput: (e) => { e.target.nextElementSibling.textContent = `${e.target.value}%`; }, onchange: (e) => patch({ opacity: Number(e.target.value) }) }),
        h('span', { class: 'tw-hint tw-num', text: `${p.opacity}%` }),
      )),
      row('背景虚化', '给面板叠加毛玻璃效果（部分内核可能不支持）', h('div', { class: 'op-range' },
        h('input', { type: 'range', min: 0, max: 20, step: 1, value: p.blur, oninput: (e) => { e.target.nextElementSibling.textContent = `${e.target.value}px`; }, onchange: (e) => patch({ blur: Number(e.target.value) }) }),
        h('span', { class: 'tw-hint tw-num', text: `${p.blur}px` }),
      )),
    ),
    h('div', { class: 'op-card' },
      h('h3', { text: '行情与刷新' }),
      row('刷新间隔', '侧边栏与弹窗的行情轮询间隔（秒）。过快可能被上游限流', h('input', { class: 'tw-input', type: 'number', min: 3, max: 120, value: p.refreshSec, style: { width: '82px' }, onchange: (e) => patch({ refreshSec: Math.max(3, Math.min(120, Number(e.target.value) || 10)) }) })),
      row('缩略分时线', '在自选/持仓列表内绘制当日分时缩略图（会额外请求分时数据）', switchCtl(p.sparkline, (v) => patch({ sparkline: v }))),
      row('显示的行情条', '顶部行情条按分组显示', tabsBox),
    ),
    h('div', { class: 'op-card' },
      h('h3', { text: '工具栏角标' }),
      row('角标内容', '浏览器工具栏图标上的数字角标', seg(p.badgeMode, [
        { value: 'sh', label: '大盘指数' }, { value: 'watchFirst', label: '自选首只' }, { value: 'portfolio', label: '持仓当日%' }, { value: 'off', label: '关闭' },
      ], (v) => patch({ badgeMode: v }))),
      row('角标标的', '「大盘指数」模式监测的指数 / 标的', badgeTargets),
      row('系统通知', '预警触发时通过系统通知提醒（需浏览器允许通知）', switchCtl(p.notifyEnabled, (v) => patch({ notifyEnabled: v }))),
    ),
  );
  return sec;
}

/* ── 预警 ─────────────────────────────────────────────────────────────── */

function renderAlerts() {
  const sec = h('div');
  const tbl = h('table', { class: 'op-tbl' },
    h('thead', {}, h('tr', {}, h('th', { text: '标的' }), h('th', { text: '字段' }), h('th', { text: '条件' }), h('th', { text: '冷却' }), h('th', { text: '上次触发' }), h('th', { text: '状态' }), h('th', { text: '操作' }))),
  );
  const tbody = h('tbody');
  for (const a of state.alerts) {
    tbody.append(h('tr', {},
      h('td', {}, h('b', { text: a.name || a.secid }), h('div', { class: 'tw-hint', text: a.note ?? '' })),
      h('td', { text: ALERT_FIELD_LABEL[a.field] ?? a.field }),
      h('td', { class: 'tw-num', text: `${a.op === '>=' ? '≥' : '≤'} ${a.value}${a.field === 'pct' ? '%' : ''}` }),
      h('td', { class: 'tw-num', text: `${a.cooldownSec ?? 600}s` }),
      h('td', { class: 'tw-num', text: a.lastFiredAt ? fmtDateTime(a.lastFiredAt) : '—' }),
      h('td', {}, h('span', { class: `tw-chip ${a.enabled ? 'accent' : ''}`, text: a.enabled ? '启用' : '停用' })),
      h('td', {},
        h('button', { class: 'tw-btn xs', onclick: async () => { await api.alerts.mutate({ op: 'toggle', id: a.id }); await loadAlerts(); render(); } }, a.enabled ? '停用' : '启用'),
        ' ',
        h('button', { class: 'tw-btn xs', onclick: () => editAlert(a) }, '编辑'),
        ' ',
        h('button', { class: 'tw-btn xs danger', onclick: async () => { await api.alerts.mutate({ op: 'remove', id: a.id }); await loadAlerts(); render(); } }, '删除'),
      ),
    ));
  }
  tbl.append(tbody);

  sec.append(
    h('div', { class: 'op-card' },
      h('h3', { text: `预警规则（${state.alerts.length}）` }),
      h('div', { class: 'tw-flex tw-gap8', style: { marginBottom: '12px' } },
        h('button', { class: 'tw-btn primary', onclick: () => editAlert(null) }, '＋ 新增预警'),
        h('button', { class: 'tw-btn', onclick: () => chrome.runtime.sendMessage({ type: 'notify.test' }) }, '发送测试通知'),
        h('span', { class: 'tw-1' }),
        h('button', { class: 'tw-btn', onclick: async () => { await api.alerts.mutate({ op: 'clearLog' }); await loadAlerts(); render(); } }, '清空触发历史'),
      ),
      state.alerts.length === 0 ? h('div', { class: 'tw-hint', text: '还没有预警规则。' }) : tbl,
      h('div', { class: 'tw-hint', style: { marginTop: '10px' }, text: '预警由后台 Service Worker 每分钟检查一次（浏览器运行中），触发后按冷却时间(默认 10 分钟)去重，并推送系统通知。' }),
    ),
  );

  const logTbl = h('table', { class: 'op-tbl' }, h('thead', {}, h('tr', {}, h('th', { text: '时间' }), h('th', { text: '标的' }), h('th', { text: '触发值' }), h('th', { text: '备注' }))));
  const logBody = h('tbody');
  for (const r of state.log.slice(0, 60)) {
    logBody.append(h('tr', {},
      h('td', { class: 'tw-num', text: fmtDateTime(r.ts) }),
      h('td', { text: r.name || r.secid }),
      h('td', { class: `tw-num ${pctClass(r.actual, state.prefs.redUp)}`, text: r.field === 'pct' ? fmtPct(r.actual) : String(r.actual) }),
      h('td', { class: 'tw-hint', text: r.note ?? '' }),
    ));
  }
  logTbl.append(logBody);
  sec.append(h('div', { class: 'op-card' }, h('h3', { text: `触发历史（${state.log.length}）` }), state.log.length === 0 ? h('div', { class: 'tw-hint', text: '暂无记录。' }) : logTbl));
  return sec;
}

async function loadAlerts() {
  [state.alerts, state.log] = await Promise.all([api.alerts.get(), api.alerts.log()]);
}

async function editAlert(a) {
  const isNew = !a;
  const res = await promptModal({
    title: isNew ? '新增预警' : `编辑预警 · ${a.name || a.secid}`,
    width: 400,
    fields: [
      ...(isNew ? [{ key: 'secid', label: '标的代码（东财 secid，如 1.600519）', required: true, placeholder: '1.600519' }, { key: 'name', label: '名称', placeholder: '贵州茅台' }] : []),
      { key: 'field', label: '监测字段', type: 'select', value: a?.field ?? 'pct', options: [{ value: 'pct', label: '涨跌幅 %' }, { value: 'price', label: '现价' }] },
      { key: 'op', label: '条件', type: 'select', value: a?.op ?? '>=', options: [{ value: '>=', label: '≥ 大于等于' }, { value: '<=', label: '≤ 小于等于' }] },
      { key: 'value', label: '阈值', type: 'number', value: a?.value ?? 5, step: '0.01', required: true },
      { key: 'cooldownSec', label: '冷却（秒）', type: 'number', value: a?.cooldownSec ?? 600 },
      { key: 'note', label: '备注', value: a?.note ?? '' },
    ],
  });
  if (!res) return;
  if (isNew) await api.alerts.mutate({ op: 'add', alert: res });
  else await api.alerts.mutate({ op: 'update', id: a.id, patch: res });
  await loadAlerts();
  chrome.runtime.sendMessage({ type: 'badge.refresh' }).catch(() => {});
  render();
  toast(isNew ? '预警已创建' : '预警已更新');
}

/* ── 数据 ─────────────────────────────────────────────────────────────── */

async function renderData() {
  const sec = h('div');
  const usage = await chrome.storage.local.getBytesInUse(null).catch(() => 0);
  const usageMb = (usage / 1024 / 1024).toFixed(2);

  const fileInput = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
  fileInput.onchange = async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const parsed = JSON.parse(text);
      const merge = await confirmModal('导入方式', '点击「确定」= 合并导入（保留现有数据，追加新记录）；点击「取消」= 覆盖导入（清空后重建）。');
      await api.data.import(parsed, merge);
      toast('导入完成');
      await boot(true);
    } catch (error) {
      toast(`导入失败：${error.message}`);
    } finally {
      fileInput.value = '';
    }
  };

  sec.append(
    h('div', { class: 'op-card' },
      h('h3', { text: '备份与恢复' }),
      h('div', { class: 'tw-flex tw-gap8', style: { flexWrap: 'wrap' } },
        h('button', { class: 'tw-btn primary', onclick: exportJson }, '导出全部数据（JSON）'),
        h('button', { class: 'tw-btn', onclick: () => fileInput.click() }, '导入 JSON'),
        h('button', { class: 'tw-btn', onclick: copyJson }, '复制到剪贴板'),
        fileInput,
      ),
      h('div', { class: 'tw-hint', style: { marginTop: '10px', lineHeight: '1.7' } },
        '导出内容包含：偏好设置、自选分组与标的、持仓分组、append-only 交易流水、预警规则。',
        h('br'),
        '持仓的数量与成本不落盘，全部由流水实时推导，因此导入流水即可完整还原持仓与盈亏。',
      ),
      h('div', { class: 'tw-hint', style: { marginTop: '10px' } }, `当前扩展本地存储占用约 ${usageMb} MB（含 K 线缓存）。`),
    ),
    h('div', { class: 'op-card' },
      h('h3', { text: '缓存与重置' }),
      h('div', { class: 'tw-flex tw-gap8', style: { flexWrap: 'wrap' } },
        h('button', { class: 'tw-btn', onclick: async () => {
          const all = await chrome.storage.local.get(null);
          const keys = Object.keys(all).filter((k) => k.startsWith('tw:kline:') || k.startsWith('tw:lkg') || k.startsWith('tw:trend-lkg'));
          await chrome.storage.local.remove(keys);
          toast(`已清理 ${keys.length} 项行情缓存`);
          render();
        } }, '清理行情 / K线缓存'),
        h('button', { class: 'tw-btn danger', onclick: async () => {
          if (!(await confirmModal('重置全部数据', '将清空自选、持仓、流水、预警与偏好，恢复为初始状态。此操作不可撤销！'))) return;
          await api.data.reset();
          toast('已重置');
          await boot(true);
        } }, '重置全部数据'),
      ),
    ),
  );
  return sec;
}

async function exportJson() {
  const data = await api.data.export();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `tradewatcher-backup-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('已导出');
}

async function copyJson() {
  const data = await api.data.export();
  try {
    await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    toast('已复制到剪贴板');
  } catch {
    toast('复制失败（剪贴板权限被拒绝）');
  }
}

/* ── 关于 ─────────────────────────────────────────────────────────────── */

async function renderAbout() {
  const m = chrome.runtime.getManifest();
  const box = h('div', {});

  box.append(
    h('div', { class: 'op-card' },
      h('h3', { text: `tradewatcher v${m.version}` }),
      h('div', { style: { fontSize: '13px', lineHeight: '1.85' } },
        '综合盯盘 Edge/Chromium 浏览器扩展。整合了 DeepSeek Harness 插件 dsh-tradewatcher 的数据模型与核算方式，以及「爱盯盘」的界面组织思路，并在此基础上扩展了板块资金流、涨跌停复盘、市场宽度、多源兜底与价格预警等能力。',
      ),
    ),
  );

  box.append(await updateCard());
  box.append(dataSourceCard());
  box.append(hotkeyCard());
  box.append(disclaimerCard());
  return box;
}

/* ── 版本与更新卡片 ────────────────────────────────────────────────────── */

/** 只做安全的最简 Markdown 渲染：先转义，再套用少量行内规则 */
function renderNotes(md) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = esc(md ?? '').trim();
  if (html === '') return null;
  html = html
    .replace(/^#{1,6}\s*(.+)$/gm, '<b>$1</b>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^\s*[-*]\s+(.+)$/gm, '· $1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1');
  return h('div', { class: 'op-pre op-notes', html });
}

async function updateCard() {
  const m = chrome.runtime.getManifest();
  const card = h('div', { class: 'op-card' });
  card.append(h('h3', { text: '版本与更新' }));

  const status = h('div', { class: 'op-upd-status' });
  const progress = h('div', { class: 'op-bar' }, h('i', { style: { width: '0%' } }));
  const logBox = h('div', { class: 'op-pre', style: { display: 'none' } });
  let latest = null;

  /* 更新源：固定为本项目仓库，只读展示 */
  const repoLink = h('a', {
    class: 'op-link',
    href: `https://github.com/${UPDATE_REPO}`,
    target: '_blank',
    rel: 'noreferrer',
    title: '在 GitHub 打开本项目仓库',
  }, UPDATE_REPO);

  const autoCtl = toggleCtl(state.prefs.autoUpdateCheck !== false, (v) => patchQuiet({ autoUpdateCheck: v }));
  const preCtl = toggleCtl(!!state.prefs.includePrerelease, (v) => patchQuiet({ includePrerelease: v }));

  const btnCheck = h('button', { class: 'tw-btn sm primary' }, '检查更新');
  const btnOpen = h('button', { class: 'tw-btn sm' }, '打开发布页');
  const btnZip = h('button', { class: 'tw-btn sm' }, '下载更新包');
  const btnApply = h('button', { class: 'tw-btn sm' }, '选择扩展目录并更新');
  const btnReload = h('button', { class: 'tw-btn sm primary' }, '重新加载扩展');

  for (const b of [btnOpen, btnZip, btnApply, btnReload]) b.disabled = true;
  btnOpen.onclick = () => latest?.htmlUrl && window.open(latest.htmlUrl, '_blank', 'noopener');
  btnZip.onclick = () => latest?.zipUrl && window.open(latest.zipUrl, '_blank', 'noopener');

  /* ── 状态渲染 ── */
  const fmtTime = (ts) => (ts ? fmtDateTime(ts) : '—');

  function paint() {
    mount(status);
    const l = latest;
    if (!l) {
      status.append(h('div', { class: 'tw-hint', text: '尚未检查。点击「检查更新」从 GitHub 读取最新版本信息。' }));
      return;
    }
    if (!l.ok) {
      status.append(
        h('div', { class: 'op-badge warn', text: '检查失败' }),
        h('div', { class: 'tw-hint', style: { marginTop: '5px', whiteSpace: 'pre-wrap' }, text: l.error ?? '未知错误' }),
      );
      if (l.errorKind === 'notfound') {
        const [owner, repoName] = UPDATE_REPO.split('/');
        const createUrl = `https://github.com/new${repoName ? `?name=${encodeURIComponent(repoName)}` : ''}`;
        status.append(
          h('div', { class: 'tw-hint', style: { marginTop: '6px' } },
            `更新源固定为 ${UPDATE_REPO}，但该仓库当前无法匿名访问 —— 要么还没创建，要么是私有仓库。`),
          // 匿名 API 对「还没建」和「建了但私有」都返回 404，客户端分不出来，所以两种可能都要说。
          h('div', { class: 'tw-flex tw-gap6', style: { marginTop: '7px', alignItems: 'center', flexWrap: 'wrap' } },
            h('button', { class: 'tw-btn sm', onclick: () => window.open(createUrl, '_blank', 'noopener') }, '去 GitHub 创建仓库'),
            h('span', { class: 'tw-hint', text: `需在 ${owner} 账号下建一个名为 ${repoName} 的 Public 仓库并推送代码。` }),
          ),
        );
      }
      return;
    }
    const badge = l.comparable
      ? l.hasUpdate
        ? h('span', { class: 'op-badge up', text: '有新版本' })
        : h('span', { class: 'op-badge ok', text: '已是最新' })
      : h('span', { class: 'op-badge', text: '无法比较版本' });
    status.append(
      h('div', { class: 'tw-flex tw-gap6', style: { alignItems: 'center', flexWrap: 'wrap' } },
        badge,
        h('span', { style: { fontSize: '13px' } }, `当前 v${l.current}`),
        h('span', { class: 'tw-hint' }, '→'),
        // 有可比版本号时优先显示版本；无 tag 的仓库退到 name（「分支 @ 短 SHA」），
        // 它才是唯一在所有分支（release/tag/commit）都会被赋值的标识字段。
        h('span', { style: { fontSize: '13px', fontWeight: '600' } }, l.version ? `v${l.version}` : l.tag || l.name || '未知'),
      ),
      h('div', { class: 'tw-hint', style: { marginTop: '4px' } },
        `来源：${sourceLabel(l.source)}${l.source === 'commit' && l.name ? `（${l.name}）` : ''} · 检查于 ${fmtTime(l.checkedAt)}`),
    );
    if (l.comparable && !l.hasUpdate) {
      status.append(h('div', { class: 'tw-hint', style: { marginTop: '4px' } }, '本机版本不低于远端，无需更新。'));
    }
    if (!l.comparable) {
      status.append(h('div', { class: 'tw-hint', style: { marginTop: '4px' } },
        '远端既没有 tag / Release，也没能从远端 manifest.json 读到版本号，无法判断新旧；可点「下载更新包」自行比对。'));
    }
    const notes = renderNotes(l.notes);
    if (notes) {
      status.append(h('div', { class: 'tw-label', style: { marginTop: '9px' }, text: '更新说明' }), notes);
    }
    btnOpen.disabled = !l.htmlUrl;
    btnZip.disabled = !l.zipUrl;
    // 必须能拿到一个可下载的 git ref，否则「就地更新」无从下手
    btnApply.disabled = !refOf(l);
  }

  const sourceLabel = (s) => ({ release: 'GitHub Release', tag: 'Git tag', commit: '默认分支最新提交' }[s] ?? s ?? '未知');

  /** 就地更新用的 git ref：优先 tag，其次分支 */
  const refOf = (l) => l?.tag ?? l?.ref ?? null;

  async function doCheck(force) {
    btnCheck.disabled = true;
    btnCheck.textContent = '检查中…';
    try {
      latest = await api.update.check(!!force);
    } catch (error) {
      latest = { ok: false, error: String(error?.message ?? error), current: chrome.runtime.getManifest().version };
    } finally {
      btnCheck.disabled = false;
      btnCheck.textContent = '检查更新';
      paint();
    }
  }

  btnCheck.onclick = () => doCheck(true);

  /* ── 一键就地更新 ── */
  btnApply.onclick = async () => {
    const ref = refOf(latest);
    if (!ref) return;
    if (!updater.supportsDirectoryWrite()) {
      toast('当前浏览器不支持目录写入（需要 Chromium 系且为安全上下文）');
      return;
    }
    try {
      let handle = await updater.loadDirHandle();
      if (!handle || !(await updater.ensurePermission(handle, { request: false }))) {
        handle = await window.showDirectoryPicker({ id: 'tw-ext-root', mode: 'readwrite' });
        // 防呆：选错目录会把一堆源码写到别处
        try {
          await handle.getFileHandle('manifest.json');
        } catch {
          toast('这个目录里没有 manifest.json，看起来不是扩展根目录');
          return;
        }
        if (!(await updater.ensurePermission(handle))) {
          toast('未获得该目录的读写权限');
          return;
        }
        await updater.saveDirHandle(handle);
      }

      const ok = await confirmModal(
        '就地更新',
        `将把 ${latest.repo} @ ${ref} 的文件写入所选目录，只覆盖「新增」和「内容有变化」的文件，不会删除你本地多出来的文件。\n\n写入后需要点「重新加载扩展」才会生效。是否继续？`,
      );
      if (!ok) return;

      btnApply.disabled = true;
      logBox.style.display = 'block';
      progress.style.display = 'block';
      const bar = progress.querySelector('i');

      const res = await updater.syncFromGitHub({
        repo: latest.repo,
        ref,
        dirHandle: handle,
        onProgress: ({ phase, done, total, path }) => {
          if (phase === 'download') {
            bar.style.width = '8%';
            logBox.textContent = '正在下载归档包…';
            return;
          }
          bar.style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
          logBox.textContent = `(${done}/${total}) ${path}`;
        },
      });

      bar.style.width = '100%';
      logBox.textContent =
        `完成（传输方式：${res.transport === 'zip' ? '整包 zip' : '逐文件'}）：共 ${res.total} 个文件\n` +
        `  新增 ${res.added.length} 个\n` +
        `  覆盖 ${res.updated.length} 个\n` +
        `  未变 ${res.unchanged.length} 个\n` +
        (res.failed.length > 0 ? `  失败 ${res.failed.length} 个：\n${res.failed.map((f) => `    ${f.path} — ${f.error}`).join('\n')}` : '') +
        (res.failed.length === 0 ? '\n\n点下方「重新加载扩展」即可生效。' : '\n\n部分文件失败，可稍后重试。');
      toast(res.failed.length === 0 ? '更新文件已写入，请重新加载扩展' : '更新完成，但有文件失败');
      if (res.failed.length === 0) btnReload.disabled = false;
    } catch (error) {
      if (error?.name === 'AbortError') toast('已取消');
      else toast(`更新失败：${String(error?.message ?? error)}`);
    } finally {
      btnApply.disabled = false;
    }
  };

  btnReload.onclick = () => chrome.runtime.reload();

  /* ── 组装 ── */
  card.append(
    h('div', { class: 'op-row' },
      h('div', { class: 'lbl' }, h('b', { text: '当前版本' }), h('span', { text: `v${m.version} · Manifest V${m.manifest_version}` })),
      h('div', { class: 'ctl' }, btnCheck),
    ),
    h('div', { class: 'op-row' },
      h('div', { class: 'lbl' }, h('b', { text: '更新仓库' }), h('span', { text: '固定来源 · 本项目 GitHub 仓库' })),
      h('div', { class: 'ctl' }, repoLink),
    ),
    h('div', { class: 'op-row' },
      h('div', { class: 'lbl' }, h('b', { text: '自动检查' }), h('span', { text: '每天检查一次，发现新版本时发系统通知' })),
      h('div', { class: 'ctl' }, autoCtl),
    ),
    h('div', { class: 'op-row' },
      h('div', { class: 'lbl' }, h('b', { text: '包含预发布' }), h('span', { text: '把 pre-release 也视为新版本' })),
      h('div', { class: 'ctl' }, preCtl),
    ),
    h('div', { style: { marginTop: '8px' } }, status),
    h('div', { class: 'op-actions', style: { marginTop: '10px' } }, btnOpen, btnZip),
    h('div', { class: 'op-sep' }),
    h('div', { style: { fontSize: '12.5px', lineHeight: '1.85', color: 'var(--tw-ink-2)' } },
      h('b', { text: '一键更新（就地覆盖）' }),
      h('br'),
      '本扩展以「加载已解压的扩展」方式安装时，扩展目录对扩展自身的脚本是只读的 —— 浏览器不允许任何扩展 API 写自己的安装目录。',
      '这里借助 File System Access API：你授权一次扩展根目录后，即可逐文件比对并覆盖写入，再点「重新加载扩展」生效。',
      h('br'),
      h('span', { class: 'tw-hint', text: '若扩展是从 Edge 加载项商店安装的，浏览器会自动升级，无需此操作。' }),
    ),
    h('div', { class: 'op-actions', style: { marginTop: '9px' } }, btnApply, btnReload),
    progress,
    logBox,
  );

  progress.style.display = 'none';
  btnReload.disabled = true;
  paint();
  // 进页面即展示上次结果（若有），但不主动打网络
  try {
    const cached = await api.update.state();
    if (cached) {
      latest = cached;
      paint();
    }
  } catch {
    /* 忽略 */
  }
  return card;
}

/* ── 关于页的其余卡片 ──────────────────────────────────────────────────── */

function dataSourceCard() {
  return h('div', { class: 'op-card' },
    h('h3', { text: '数据源（均为免费公开接口，延迟行情）' }),
    h('table', { class: 'op-tbl' },
      h('thead', {}, h('tr', {}, h('th', { text: '用途' }), h('th', { text: '来源' }))),
      h('tbody', {},
        tr('批量行情 / 板块榜 / 资金流', '东方财富 push2 / push2delay'),
        tr('分时序列', '东方财富 trends2（多主机回退）'),
        tr('多日分时（五日）', '腾讯 day/query 一分钟级（东财 trends2、5 分钟 K 线依次兜底）'),
        tr('历史 K 线', '腾讯 fqkline（东财 push2his 兜底，本地缓存 + 增量更新）'),
        tr('标的搜索', '东方财富 searchapi suggest'),
        tr('涨跌停 / 炸板池', '东方财富 push2ex'),
        tr('全市场涨跌幅分布 / 涨跌家数', '东方财富 push2 clist 全 A 快照自行分档（新浪行情中心兜底）'),
        tr('两市成交额', '腾讯 day/query 末条累计成交额（不依赖 push2）'),
        tr('财经日历', '东方财富数据中心（新股申购、财报预约披露、分红除权）'),
        tr('大盘云图', '52etf.site 内嵌 iframe'),
        tr('版本更新', 'GitHub Releases / Tags API + raw 文件同步'),
      ),
    ),
  );
}

function hotkeyCard() {
  const row = (b, s, key) =>
    h('div', { class: 'op-row' },
      h('div', { class: 'lbl' }, h('b', { text: b }), h('span', { text: s })),
      h('div', { class: 'ctl' }, h('span', { class: 'op-kbd', text: key })));
  return h('div', { class: 'op-card' },
    h('h3', { text: '快捷键' }),
    row('打开弹窗', '浏览器默认快捷键', 'Alt+Shift+T'),
    row('缩放 K 线', '在详情抽屉的 K 线区域', '滚轮'),
    row('平移 K 线', '在详情抽屉的 K 线区域', '拖拽'),
    row('关闭抽屉 / 弹窗', '', 'Esc'),
  );
}

function disclaimerCard() {
  return h('div', { class: 'op-card' },
    h('h3', { text: '免责声明' }),
    h('div', { style: { fontSize: '12.5px', lineHeight: '1.9', color: 'var(--tw-ink-2)' } },
      '· 本扩展使用免费公开接口的延迟行情（非 Level-2），盘中可能存在缺口或延迟，仅作盯盘参考。',
      h('br'),
      '· 上游对高频访问会限流；扩展已做多主机重试、TTL 缓存与 last-known-good 回填，但仍可能出现短暂无数据。',
      h('br'),
      '· 持仓账本为个人记账工具，盈亏口径见「持仓」页说明；跨市场标的未做汇率折算。',
      h('br'),
      '· 护盘信号仅识别「放量 + 主力净流入」的行为模式，不能证明买入方身份。',
      h('br'),
      '· 本扩展不构成任何投资建议，使用风险自负。',
    ),
  );
}

function tr(a, b) {
  return h('tr', {}, h('td', { text: a }), h('td', { text: b }));
}

/* ── 渲染 ─────────────────────────────────────────────────────────────── */

function render() {
  applyPrefs(state.prefs);
  const nav = qs('#nav');
  mount(nav);
  for (const s of SECTIONS) nav.append(h('button', { class: state.section === s.key ? 'on' : '', onclick: () => { state.section = s.key; render(); } }, s.label));

  const main = qs('#main');
  const map = { appearance: renderAppearance, alerts: renderAlerts, data: renderData, about: renderAbout };
  const head = { appearance: ['外观与刷新', '调整主题、配色、隐私模式与刷新节奏'], alerts: ['价格预警', '设置价格 / 涨跌幅提醒，触发后推送系统通知'], data: ['数据管理', '导出、导入与重置本地数据'], about: ['关于', '版本检查与更新、数据源与免责声明'] }[state.section];
  mount(main, h('h2', { class: 'op-h', text: head[0] }), h('div', { class: 'op-sub', text: head[1] }));
  const content = map[state.section]();
  // 注意：这里必须 catch。async 段一旦抛错，裸 .then() 会把异常吞成 rejected promise，
  // 页面只剩标题、正文一片空白且控制台无任何提示（曾因此在「关于」页排查了很久）。
  if (content instanceof Promise) {
    content.then((node) => main.append(node)).catch((error) => {
      main.append(
        h('div', { class: 'op-card' },
          h('h3', { text: '本页渲染失败' }),
          h('div', { class: 'tw-hint', text: String(error?.message ?? error) }),
        ),
      );
    });
  } else main.append(content);
}

async function boot(silent = false) {
  state.prefs = await api.prefs.get();
  state.watch = await api.watch.get().catch(() => null);
  await loadAlerts();
  const m = chrome.runtime.getManifest();
  qs('#ver').textContent = `综合盯盘助手 · v${m.version}`;
  qs('#btn-panel').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('src/sidepanel/panel.html') });
  watchSystemTheme(() => applyPrefs(state.prefs));
  render();
  if (!silent && new URLSearchParams(location.search).get('welcome')) {
    const banner = h('div', { class: 'op-banner' }, '欢迎使用 tradewatcher！点击浏览器工具栏图标即可查看行情弹窗，点击「▤」打开侧边栏完整面板。');
    qs('#main').prepend(banner);
  }
}

boot().catch((error) => mount(qs('#main'), h('div', { class: 'tw-empty', text: `加载失败：${error.message}` })));
