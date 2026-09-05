import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--port')) {
  console.error('用法：node examples/3180/serve.mjs [--port 3181]');
  process.exit(1);
}
const port = args.length ? Number(args[1]) : 3180;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('端口必须是 1–65535 的整数。');
  process.exit(1);
}
const html = await readFile(new URL('./index.html', import.meta.url));
const server = createServer((req, res) => {
  const path = req.url?.split('?')[0];
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
  } else if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : html);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});
server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE'
    ? `端口 ${port} 已被使用。可加 --port 3181，或关闭已有预览。`
    : error.message);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`3180 案例 · 柔光鸢尾·浅 · 第五轮\nhttp://127.0.0.1:${port}/index.html\nCtrl+C 关闭预览。`);
});
