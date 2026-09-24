/**
 * 共享常量与数据模型（后台 / 弹窗 / 侧边栏 / 设置页 共用）。
 * 纯数据，无副作用。
 */

/** 东财 secid 形式：<市场>.<代码>，如 1.600519 / 116.00700 */
export const SECID_RE = /^\d{1,3}\.[A-Za-z0-9_]+$/;

/** 顶部行情条：三组标的 */
export const STRIP_ROWS = [
  {
    key: 'cn',
    label: 'A股指数',
    items: [
      { secid: '1.000001', name: '上证指数' },
      { secid: '0.399001', name: '深证成指' },
      { secid: '0.399006', name: '创业板指' },
      { secid: '1.000688', name: '科创50' },
      { secid: '1.000300', name: '沪深300' },
      { secid: '1.000905', name: '中证500' },
      { secid: '1.000852', name: '中证1000' },
      { secid: '1.000016', name: '上证50' },
    ],
  },
  {
    key: 'hk',
    label: '中国香港 / 亚太',
    items: [
      { secid: '100.HSI', name: '恒生指数' },
      { secid: '100.HSCEI', name: '国企指数' },
      { secid: '100.HSTECH', name: '恒生科技' },
      { secid: '100.N225', name: '日经225' },
      { secid: '100.KOSPI200', name: '韩国KOSPI200' },
      { secid: '100.AS51', name: '澳洲标普200' },
    ],
  },
  {
    key: 'intl',
    label: '欧美市场',
    items: [
      { secid: '100.SPX', name: '标普500' },
      { secid: '100.NDX', name: '纳斯达克100' },
      { secid: '100.DJIA', name: '道琼斯' },
      { secid: '100.FTSE', name: '英国富时100' },
      { secid: '100.GDAXI', name: '德国DAX30' },
      { secid: '100.FCHI', name: '法国CAC40' },
      { secid: '100.SX5E', name: '欧洲斯托克50' },
    ],
  },
  {
    key: 'commodity',
    label: '大宗商品',
    items: [
      { secid: '122.XAU', name: '伦敦金现' },
      { secid: '101.SI00Y', name: 'COMEX白银' },
      { secid: '101.HG00Y', name: 'COMEX铜' },
      { secid: '112.B00Y', name: '布伦特原油' },
      { secid: '113.rbm', name: '螺纹钢主连' },
      { secid: '114.jmm', name: '焦煤主连' },
      { secid: '114.mm', name: '豆粕主连' },
      { secid: '114.lhm', name: '生猪主连' },
    ],
  },
];

export const STRIP_ALL_SECIDS = STRIP_ROWS.flatMap((r) => r.items.map((it) => it.secid));

/** 大盘页六大核心指数 */
export const CORE_INDICES = [
  { secid: '1.000001', name: '上证指数' },
  { secid: '0.399001', name: '深证成指' },
  { secid: '0.399006', name: '创业板指' },
  { secid: '1.000688', name: '科创50' },
  { secid: '1.000300', name: '沪深300' },
  { secid: '1.000905', name: '中证500' },
];

/** 首次安装的自选种子 */
export const WATCH_SEED = [
  { name: '贵州茅台', secid: '1.600519' },
  { name: '宁德时代', secid: '0.300750' },
  { name: '比亚迪', secid: '0.002594' },
  { name: '中芯国际', secid: '1.688981' },
  { name: '沪深300ETF', secid: '1.510300' },
  { name: '科创50ETF', secid: '1.588000' },
];

/** 护盘通道池（宽基 ETF） */
export const RESCUE_CATALOG = [
  { secid: '1.510300', name: '沪深300ETF华泰柏瑞', index: '沪深300', core: true },
  { secid: '1.510050', name: '上证50ETF华夏', index: '上证50', core: true },
  { secid: '1.510500', name: '中证500ETF南方', index: '中证500', core: true },
  { secid: '1.512100', name: '中证1000ETF华夏', index: '中证1000', core: true },
  { secid: '1.588000', name: '科创50ETF华夏', index: '科创50', core: true },
  { secid: '0.159915', name: '创业板ETF易方达', index: '创业板指', core: true },
  { secid: '1.510310', name: '沪深300ETF易方达', index: '沪深300', core: false },
  { secid: '1.510330', name: '沪深300ETF华夏', index: '沪深300', core: false },
  { secid: '0.159919', name: '沪深300ETF嘉实', index: '沪深300', core: false },
  { secid: '1.588080', name: '科创50ETF易方达', index: '科创50', core: false },
];

export function rescueUniverse(universe) {
  if (!Array.isArray(universe) || universe.length === 0) return RESCUE_CATALOG.filter((e) => e.core);
  const want = new Set(universe);
  const picked = RESCUE_CATALOG.filter((e) => want.has(e.secid));
  return picked.length > 0 ? picked : RESCUE_CATALOG.filter((e) => e.core);
}

/** 护盘等级 */
export const RESCUE_LEVEL_LABEL = ['平静', '资金异动', '疑似护盘', '强护盘信号'];

/** 财报日历分类 */
export const CAL_CATEGORY_LABEL = {
  'macro-intl': '国际宏观',
  'macro-cn': '国内宏观',
  ipo: '新股IPO',
  earnings: '财报',
  dividend: '分红',
  other: '其他',
};

/** 默认偏好 */
export const DEFAULT_PREFS = {
  theme: 'auto',          // auto | light | dark
  redUp: true,            // 红涨绿跌
  refreshSec: 10,         // 界面刷新间隔（秒）
  costBasis: 'diluted',   // diluted 摊薄 | average 均价
  maskMode: false,        // 极简/隐蔽模式
  opacity: 100,           // 不透明度 60-100
  blur: 0,                // 背景虚化 0-20
  sparkline: true,        // 列表内缩略分时
  density: 'normal',      // normal | compact
  badgeMode: 'sh',        // off | sh | watchFirst | portfolio
  badgeTarget: '1.000001',
  notifyEnabled: true,
  showStrip: ['cn', 'hk', 'intl', 'commodity'],
  panelTab: 'overview',
  cloudMapUrl: 'https://52etf.site/',
  rescue: { enabled: true, universe: [] },
  // 更新检查（关于页）
  updateRepo: 'tianyagk/tradewatcher',   // <owner>/<repo>，可改成自己的仓库
  autoUpdateCheck: true,                 // 每天自动检查一次
  includePrerelease: false,              // 是否把 pre-release 视为新版本
};

/** 单条预警规则 */
export function makeAlert(patch = {}) {
  return {
    id: patch.id ?? `al_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    secid: patch.secid ?? '',
    name: patch.name ?? '',
    field: patch.field ?? 'pct',       // pct | price
    op: patch.op ?? '>=',              // >= | <=
    value: patch.value ?? 0,
    note: patch.note ?? '',
    enabled: patch.enabled !== false,
    cooldownSec: patch.cooldownSec ?? 600,
    lastFiredAt: patch.lastFiredAt ?? 0,
    createdAt: patch.createdAt ?? Date.now(),
  };
}

export const ALERT_FIELD_LABEL = { pct: '涨跌幅%', price: '现价' };

/** 预警去重默认窗口（秒） */
export const ALERT_DEFAULT_COOLDOWN = 600;

/** K 线周期 */
export const KLT = { day: 101, week: 102, month: 103, year: 104 };
export const KLT_LABEL = { 101: '日K', 102: '周K', 103: '月K', 104: '年K' };

/** 图表时间范围 */
export const RANGE_TABS = [
  { key: '1m', label: '近1月', days: 22 },
  { key: '3m', label: '近3月', days: 66 },
  { key: '6m', label: '近6月', days: 130 },
  { key: '1y', label: '近1年', days: 250 },
  { key: 'all', label: '全部', days: 0 },
];

/** 存储键 */
export const KEYS = {
  prefs: 'tw:prefs',
  watch: 'tw:watch',
  portfolio: 'tw:portfolio',
  ledger: 'tw:ledger',
  alerts: 'tw:alerts',
  alertLog: 'tw:alertLog',
  calendar: 'tw:calendar',
  kline: (secid, klt) => `tw:kline:${secid}:${klt}`,
  lkg: 'tw:lkg',
  meta: 'tw:meta',
  update: 'tw:update',
  breadthSeries: 'tw:bseries',
};

/** 生成短 id */
export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** 板块范围 */
export const BOARD_SCOPES = [
  { key: 'industry', label: '行业板块' },
  { key: 'concept', label: '概念板块' },
  { key: 'etf', label: 'ETF排行' },
];
