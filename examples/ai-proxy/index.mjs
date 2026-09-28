#!/usr/bin/env node
// The AI signing sidecar in front of an OpenAI-compatible API. With no UPSTREAM_BASE_URL it starts the in-repo FAKE
// upstream (fake-upstream.mjs: no real model, no real key) on a free loopback port and wraps that; set
// UPSTREAM_BASE_URL to wrap your own (a gateway, an aggregator, your model server).
// 放在 OpenAI 兼容接口前面的 AI 签名旁路。未设置 UPSTREAM_BASE_URL 时，先在回环地址的空闲端口启动仓库内的**模拟**上游
// （fake-upstream.mjs：没有真实模型、没有真实密钥）并包裹它；设置 UPSTREAM_BASE_URL 即包裹你自己的上游。
//
//   node examples/ai-proxy/index.mjs          # :8798, ephemeral signer, dev manifest
//   node examples/ai-proxy/client.mjs         # calls it and verifies every receipt
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { createAIProxy } from '@tapeapi/server/ai-proxy'
import { exampleEnv, applyEnvToManifest } from '../_lib/service.mjs'
import { startFakeUpstream, DEMO_KEY } from './fake-upstream.mjs'

const manifest = JSON.parse(await readFile(new URL('manifest.json', import.meta.url), 'utf8'))
const models = JSON.parse(await readFile(process.env.MODELS_FILE || new URL('models.json', import.meta.url), 'utf8'))
const env = exampleEnv('ai-proxy', { port: 8798 })
const { log } = env

const fake = process.env.UPSTREAM_BASE_URL ? null : await startFakeUpstream()
const upstream = {
  baseUrl: process.env.UPSTREAM_BASE_URL || fake.baseUrl,
  // Only for an upstream that needs a key of the operator's own; callers' keys are otherwise passed through as they are.
  // 仅当上游需要运营者自己的密钥时设置；否则调用方的密钥原样透传。
  ...(process.env.UPSTREAM_AUTHORIZATION ? { headers: { authorization: process.env.UPSTREAM_AUTHORIZATION } } : {}),
}

// Node's http <-> the sidecar's fetch-style handleRequest, streaming both ways: an event stream is written chunk by
// chunk as it comes, never buffered. / Node http 与旁路的 fetch 风格 handleRequest 之间双向流式转换：事件流逐块写出，从不缓冲。
let proxy = null
const server = http.createServer(async (req, res) => {
  try {
    if (!proxy) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"starting","type":"tapeapi_proxy_error","code":"starting"}}') }
    const headers = new Headers()
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) { try { headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]) } catch { /* not a fetch header */ } }
    const hasBody = !['GET', 'HEAD'].includes(req.method)
    let it = null
    const body = hasBody ? new ReadableStream({
      async pull(c) { it ??= req[Symbol.asyncIterator](); const { done, value } = await it.next(); if (done) c.close(); else c.enqueue(new Uint8Array(value)) },
      cancel() { req.destroy() },
    }, { highWaterMark: 0 }) : undefined
    const r = await proxy.handleRequest(new Request(new URL(req.url, 'http://127.0.0.1'), { method: req.method, headers, body, duplex: 'half' }), { clientIp: req.socket.remoteAddress || 'unknown' })
    res.writeHead(r.status, Object.fromEntries(r.headers))
    if (!r.body) return res.end()
    res.on('close', () => { if (!res.writableEnded) r.body.cancel().catch(() => {}) })   // the client went away / 客户端离开
    for await (const chunk of r.body) res.write(chunk)
    res.end()
  } catch (e) {
    log('request failed', e?.message || e)
    if (!res.headersSent) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"malformed request","type":"tapeapi_proxy_error","code":"bad_request"}}') } else res.destroy()
  }
})
// No overall request timeout: a stream may run for minutes. Headers must still arrive in 15 s.
// 不设整体请求超时：流可能持续数分钟。请求头仍须在 15 秒内到达。
server.requestTimeout = 0
server.headersTimeout = 15_000
await new Promise((resolve, reject) => server.once('error', reject).listen(env.PORT, env.HOST, resolve))
const { port } = server.address()

// Listen first, so the endpoints in the manifest name the real port (PORT=0). / 先监听，清单里的端点才是真实端口。
applyEnvToManifest(manifest, { ...env, PORT: port })
const live = manifest.endpoints.live[0]
try {
  proxy = createAIProxy({
    upstream, manifestBase: manifest, signerKey: env.SIGNER_KEY, models, log,
    // http only for a loopback endpoint (local testing); a real one must be https. / 只有回环地址允许 http。
    allowHttp: /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(live),
  })
} catch (e) {
  console.error(`[ai-proxy] cannot start: ${e.message}`)
  process.exit(1)
}
const m = await proxy.ready
const base = m.ai.endpoints.find((e) => e.format === 'openai-chat').baseUrl
console.log(`[ai-proxy] ${m.name} listening on http://${env.HOST}:${port}`)
console.log(`[ai-proxy] upstream ${proxy.stats().upstream}${fake ? ` (the in-repo FAKE upstream; key ${DEMO_KEY})` : ''}`)
console.log(`[ai-proxy] signer   ${m.signer}   container ${m.container}   dev=${m.dev}`)
console.log(`[ai-proxy] manifest http://127.0.0.1:${port}/.well-known/tapeapi.json`)
for (const e of m.ai.endpoints) console.log(`[ai-proxy] ${e.format.padEnd(18)} ${e.baseUrl}`)
console.log(`[ai-proxy] models   ${models.map((x) => `${x.id} ${x.price.input}/${x.price.output} ${x.price.currency}`).join('; ')}`)
console.log(`[ai-proxy] try      curl -si ${base}/chat/completions -H 'authorization: Bearer ${fake ? DEMO_KEY : '<your key>'}' -H 'content-type: application/json' -d '{"model":"demo-chat","messages":[{"role":"user","content":"hello"}]}'`)

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await new Promise((r) => server.close(() => r()))
    await fake?.close()
    process.exit(0)
  })
}
