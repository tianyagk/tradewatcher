#!/usr/bin/env node
/**
 * 开发用静态服务（仅供 tools/ 下的预览页使用，不随扩展打包）。
 *
 * 为什么不用 `python -m http.server`：
 * Windows 上 .js 的 Content-Type 常被注册成 text/plain，
 * 而 Chromium 对 <script type="module"> 执行**严格 MIME 检查**，
 * 会直接报 "Expected a JavaScript-or-Wasm module script but the server responded
 * with a MIME type of text/plain" 并拒绝执行 —— 页面看起来就是一片空白。
 *
 * 用法：node tools/serve.mjs [port]     默认 8080
 */
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const port = Number(process.argv[2] ?? 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file = path.join(root, decodeURIComponent(url.pathname));
  // 防目录穿越
  if (!file.startsWith(root)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    if (statSync(file).isDirectory()) file = path.join(file, 'index.html');
    const st = statSync(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 ' + url.pathname);
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`static server → http://127.0.0.1:${port}/`);
  console.log(`预览页        → http://127.0.0.1:${port}/tools/preview-overview.html`);
});
