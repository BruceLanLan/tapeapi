#!/usr/bin/env node
// "Tape out your MCP server": the signing proxy in front of an MCP server. With no UPSTREAM_URL it starts the in-repo
// demo server (demo-server.mjs) on a free loopback port and wraps that; set UPSTREAM_URL to wrap your own.
// "Tape out 你的 MCP 服务器"：放在 MCP 服务器前面的签名代理。未设置 UPSTREAM_URL 时，先在回环地址的空闲端口启动仓库内的
// 演示服务器（demo-server.mjs）并包裹它；设置 UPSTREAM_URL 即包裹你自己的服务器。
//
//   node examples/mcp-proxy/index.mjs          # :8796, ephemeral signer, dev manifest
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { createMcpProxy } from '@tapeapi/server/mcp-proxy'
import { exampleEnv, applyEnvToManifest } from '../_lib/service.mjs'
import { startDemoServer } from './demo-server.mjs'

const manifest = JSON.parse(await readFile(new URL('manifest.json', import.meta.url), 'utf8'))
const env = exampleEnv('mcp-proxy', { port: 8796 })
const { log } = env

const demo = process.env.UPSTREAM_URL ? null : await startDemoServer()
const upstreamUrl = process.env.UPSTREAM_URL || demo.url
// An operator-set header for an upstream that needs one; a caller's headers never reach the upstream.
// 上游需要鉴权时由运营者设置的头；调用方的请求头永远到不了上游。
const upstream = { url: upstreamUrl, ...(process.env.UPSTREAM_AUTHORIZATION ? { headers: { authorization: process.env.UPSTREAM_AUTHORIZATION } } : {}) }

// Node's http -> the proxy's fetch-style handleRequest, and back. / Node http 与代理的 fetch 风格 handleRequest 之间的转换。
let proxy = null
const server = http.createServer(async (req, res) => {
  try {
    if (!proxy) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":{"code":"INTERNAL","message":"starting"}}') }
    const chunks = []; let n = 0
    for await (const c of req) { n += c.length; if (n > 1024 * 1024) { res.writeHead(413); return res.end() } chunks.push(c) }
    const headers = new Headers()
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) { try { headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]) } catch { /* not a fetch header */ } }
    const hasBody = !['GET', 'HEAD'].includes(req.method)
    const request = new Request(new URL(req.url, 'http://127.0.0.1'), { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined })
    const r = await proxy.handleRequest(request, { clientIp: req.socket.remoteAddress || 'unknown' })
    res.writeHead(r.status, Object.fromEntries(r.headers))
    res.end(Buffer.from(await r.arrayBuffer()))
  } catch (e) {
    log('request failed', e?.message || e)
    if (!res.headersSent) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"ok":false,"error":{"code":"BAD_REQUEST","message":"malformed request"}}') } else res.destroy()
  }
})
server.requestTimeout = 30_000
server.headersTimeout = 15_000
await new Promise((resolve, reject) => server.once('error', reject).listen(env.PORT, env.HOST, resolve))
const { port } = server.address()

// Listen first, so the endpoints in the manifest name the real port (PORT=0). / 先监听，清单里的端点才是真实端口。
applyEnvToManifest(manifest, { ...env, PORT: port })
const live = manifest.endpoints.live[0]
proxy = createMcpProxy({
  upstream, manifestBase: manifest, signerKey: env.SIGNER_KEY, log,
  // http only for a loopback endpoint (local testing); a real one must be https. / 只有回环地址允许 http。
  allowHttp: /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(live),
  identity: { name: process.env.TAPE_NAME || undefined },
  toolsSha256: process.env.TOOLS_SHA256 || undefined,
})
let m
try { m = await proxy.ready } catch (e) {
  console.error(`[mcp-proxy] cannot start: ${e.message}`)
  process.exit(1)
}
const s = proxy.stats()
console.log(`[mcp-proxy] ${m.name} listening on http://${env.HOST}:${port}`)
console.log(`[mcp-proxy] upstream ${s.upstream}${demo ? ' (the in-repo demo server)' : ''}: ${s.tools} tools, ${s.methods} proxied${s.skipped.length ? `, skipped: ${s.skipped.map((x) => x.name).join(', ')}` : ''}`)
console.log(`[mcp-proxy] signer   ${m.signer}   container ${m.container}   dev=${m.dev}`)
console.log(`[mcp-proxy] manifest http://127.0.0.1:${port}/.well-known/tapeapi.json`)
console.log(`[mcp-proxy] mcp      ${m.mcp.endpoint}   toolsSha256 ${m.mcp.toolsSha256}${s.drift ? '   DRIFTED: calls are refused' : ''}`)

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await new Promise((r) => server.close(() => r()))
    await demo?.close()
    process.exit(0)
  })
}
