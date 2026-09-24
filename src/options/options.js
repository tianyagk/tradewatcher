/** 设置页：外观与刷新 / 预警管理 / 数据 / 关于。 */
import { h, mount, qs, toast, applyPrefs, watchSystemTheme, promptModal, confirmModal } from '../ui/dom.js';
import * as api from '../ui/api.js';
import { ALERT_FIELD_LABEL, CORE_INDICES, STRIP_ROWS } from '../shared/model.js';
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

function renderAbout() {
  const m = chrome.runtime.getManifest();
  return h('div', {},
    h('div', { class: 'op-card' },
      h('h3', { text: `tradewatcher v${m.version}` }),
      h('div', { style: { fontSize: '13px', lineHeight: '1.85' } },
        '综合盯盘 Edge/Chromium 浏览器扩展。整合了 DeepSeek Harness 插件 dsh-tradewatcher 的数据模型与核算方式，以及「爱盯盘」的界面组织思路，并在此基础上扩展了板块资金流、涨跌停复盘、市场宽度、多源兜底与价格预警等能力。',
      ),
    ),
    h('div', { class: 'op-card' },
      h('h3', { text: '数据源（均为免费公开接口，延迟行情）' }),
      h('table', { class: 'op-tbl' },
        h('thead', {}, h('tr', {}, h('th', { text: '用途' }), h('th', { text: '来源' }))),
        h('tbody', {},
          tr('批量行情 / 板块榜 / 资金流', '东方财富 push2 / push2delay'),
          tr('分时序列', '东方财富 trends2（多主机回退）'),
          tr('多日分时（五日）', '新浪 5 分钟 K 线（腾讯兜底）'),
          tr('历史 K 线', '腾讯 fqkline（东财 push2his 兜底，本地缓存 + 增量更新）'),
          tr('标的搜索', '东方财富 searchapi suggest'),
          tr('涨跌停 / 炸板池', '东方财富 push2ex'),
          tr('财经日历', '东方财富数据中心（新股申购、财报预约披露、分红除权）'),
          tr('大盘云图', '52etf.site 内嵌 iframe'),
        ),
      ),
    ),
    h('div', { class: 'op-card' },
      h('h3', { text: '快捷键' }),
      h('div', { class: 'op-row' }, h('div', { class: 'lbl' }, h('b', { text: '打开弹窗' }), h('span', { text: '浏览器默认快捷键' })), h('div', { class: 'ctl' }, h('span', { class: 'op-kbd', text: 'Alt+Shift+T' }))),
      h('div', { class: 'op-row' }, h('div', { class: 'lbl' }, h('b', { text: '缩放 K 线' }), h('span', { text: '在详情抽屉的 K 线区域' })), h('div', { class: 'ctl' }, h('span', { class: 'op-kbd', text: '滚轮' }))),
      h('div', { class: 'op-row' }, h('div', { class: 'lbl' }, h('b', { text: '平移 K 线' }), h('span', { text: '在详情抽屉的 K 线区域' })), h('div', { class: 'ctl' }, h('span', { class: 'op-kbd', text: '拖拽' }))),
      h('div', { class: 'op-row' }, h('div', { class: 'lbl' }, h('b', { text: '关闭抽屉 / 弹窗' }), h('span', { text: '' })), h('div', { class: 'ctl' }, h('span', { class: 'op-kbd', text: 'Esc' }))),
    ),
    h('div', { class: 'op-card' },
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
  const head = { appearance: ['外观与刷新', '调整主题、配色、隐私模式与刷新节奏'], alerts: ['价格预警', '设置价格 / 涨跌幅提醒，触发后推送系统通知'], data: ['数据管理', '导出、导入与重置本地数据'], about: ['关于', '版本信息、数据源与免责声明'] }[state.section];
  mount(main, h('h2', { class: 'op-h', text: head[0] }), h('div', { class: 'op-sub', text: head[1] }));
  const content = map[state.section]();
  if (content instanceof Promise) content.then((node) => main.append(node));
  else main.append(content);
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
