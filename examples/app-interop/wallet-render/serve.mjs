// examples/app-interop/wallet-render: a static server for the page, on this machine only (127.0.0.1), serving exactly the
// page's three files and nothing else. No dependencies.
//   node examples/app-interop/wallet-render/serve.mjs [port]      then open http://localhost:<port>/  (default 8787)
// 只在本机（127.0.0.1）提供本页的三个文件，别的一概不提供。无依赖。
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

const FILES = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/payloads.js': ['payloads.js', 'text/javascript; charset=utf-8'] }

export function startServer(port = 8787) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    const f = req.method === 'GET' || req.method === 'HEAD' ? FILES[path] : null
    if (!f) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('not found') }
    const body = readFileSync(new URL(f[0], import.meta.url))
    res.writeHead(200, { 'content-type': f[1], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
    res.end(req.method === 'HEAD' ? undefined : body)
  })
  return new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', () => resolve(server)))
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const port = Number(process.argv[2] ?? 8787)
  const server = await startServer(port)
  console.log(`wallet-render: http://localhost:${server.address().port}/   (127.0.0.1 only; Ctrl+C to stop)`)
  console.log('实验性原型，不是 TAP，不发送任何交易。/ Experimental prototype. Not a TAP. Sends no transaction.')
}
