/**
 * 真实扩展上下文里的截图 + 控制台捕获（零依赖，Node 22 自带 WebSocket）
 *
 * 为什么需要它：`--screenshot --virtual-time-budget=N` 与 `--dump-dom` **不会等
 * ES module 加载完**（虚拟时间跑得比网络快），所以先前几张「渲染错」的截图其实
 * 是「根本没执行」。本脚本用 CDP 显式等待，并同时回收 console error / 未捕获异常。
 *
 * 用法：
 *   # 1) 先起一个带扩展的无头浏览器（注意：必须与第 2 步在同一次 shell 调用里，
 *   #    否则父 shell 退出时浏览器会被一起杀掉）
 *   msedge.exe --headless=new --remote-debugging-port=9222 \
 *     --user-data-dir="<临时 profile>" --no-first-run --disable-gpu \
 *     --load-extension="C:\\path\\to\\tradewatcher" about:blank &
 *   # 2) 等端口就绪后截图
 *   node tools/shot.mjs <url> <out.png> [width] [height] [waitMs] [port]
 *
 * 默认宽 360（模拟真实侧边栏）、高 900、等 25s。
 *
 * 拿扩展 ID 的坑：**不要自己按「路径 sha256 取前 16 字节、每位映射 a-p」推算**，
 * 实测推出来的 ID 与浏览器实际分配的不一致。改成读取调试端口的 target 列表：
 *   curl -s http://127.0.0.1:9222/json/list | grep -o '"url": "[^"]*"'
 * 里面 `chrome-extension://<id>/...` 的 <id> 就是真实 ID。
 *
 * 另一个坑：冷 profile 下首屏可能要 10~25s（服务休眠 + 大量并行取数），
 * 等太短会误判成「卡住」。看到「加载中…」就把 waitMs 加大再试。
 */
const [, , target, out, wStr, hStr, waitStr, portStr] = process.argv;
if (!target || !out) {
  console.error('用法：node tools/shot.mjs <url> <out.png> [width] [height] [waitMs] [port]');
  process.exit(2);
}
const W = Number(wStr) || 360;
const H = Number(hStr) || 900;
const WAIT = Number(waitStr) || 25000;
const PORT = Number(portStr) || 9222;

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const t = list.find((x) => x.type === 'page');
if (!t) throw new Error('没有可用的 page target');

const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let id = 0;
const waiting = new Map();
const events = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) {
    const { res, rej } = waiting.get(m.id);
    waiting.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  } else if (m.method) {
    events.push(m);
  }
};
function send(method, params = {}) {
  const mid = ++id;
  return new Promise((res, rej) => {
    waiting.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
await send('Page.navigate', { url: target });
await new Promise((r) => setTimeout(r, WAIT));

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const { writeFileSync } = await import('node:fs');
writeFileSync(out, Buffer.from(shot.data, 'base64'));

/* ── 回收 console error / warning / 未捕获异常 ── */
const noise = /Download the React|DevTools|^\[?Extension/i;
const lines = [];
for (const e of events) {
  if (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) {
    const txt = (e.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    if (!noise.test(txt)) lines.push(`[${e.params.type}] ${txt}`);
  }
  if (e.method === 'Runtime.exceptionThrown') {
    const d = e.params.exceptionDetails;
    lines.push(`[exception] ${d.exception?.description ?? d.text}`);
  }
  if (e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level)) {
    const txt = `${e.params.entry.text} ${e.params.entry.url ?? ''}`;
    if (!noise.test(txt)) lines.push(`[log:${e.params.entry.level}] ${txt}`);
  }
}

/* ── 关键结构自检：容器查询是否生效、SVG 是否按容器宽度渲染 ── */
const probe = await send('Runtime.evaluate', {
  expression: `(() => {
    const ovCol = document.querySelector('.pn-ov-2col');
    return JSON.stringify({
      title: document.title,
      tabs: [...document.querySelectorAll('#tabs .tw-tab')].map(t => t.textContent.trim()),
      hasSearch: !!document.querySelector('#btn-search'),
      loading: !!document.querySelector('.tw-loading'),
      secs: [...document.querySelectorAll('.pn-sec')].map(s => s.className),
      svgs: [...document.querySelectorAll('svg')].map(s => s.getAttribute('viewBox')),
      ovCols: ovCol ? getComputedStyle(ovCol).gridTemplateColumns : null,
      errbar: document.querySelector('#errbar')?.textContent || null,
    }, null, 1);
  })()`,
  returnByValue: true,
});
console.log(probe.result?.value ?? JSON.stringify(probe));
console.log('--- console ---');
console.log(lines.length ? lines.join('\n') : '（无 error / warning）');
ws.close();
process.exit(0);
