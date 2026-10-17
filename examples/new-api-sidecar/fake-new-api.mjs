#!/usr/bin/env node
// A FAKE new-api for local runs, with the parts of new-api's shape the package relies on: the OpenAI-compatible relay
// under /v1 (the repository's fake upstream: no real model, no real key), the public price list GET /api/pricing (read
// from a file on every request, so a test can change a price), and GET /api/status with usd_exchange_rate. It is not
// new-api and proves nothing about new-api itself; it stands in for it on 127.0.0.1.
// 本地演练用的**模拟** new-api，只有一键包依赖的那几处形状：/v1 下的 OpenAI 兼容转发（仓库的模拟上游：没有真实模型、没有真实密钥），
// 公开价目 GET /api/pricing（每次请求都重新读文件，测试可以改价），以及带 usd_exchange_rate 的 GET /api/status。它不是 new-api，
// 不证明 new-api 本身的任何行为；只在 127.0.0.1 上代替它。
//
//   node examples/new-api-sidecar/fake-new-api.mjs [--port 0] [--pricing <file>] [--usd-exchange-rate 7]
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createFakeUpstream, DEMO_KEY } from '../ai-proxy/fake-upstream.mjs'

export const SAMPLE_PRICING = fileURLToPath(new URL('fixtures/new-api-pricing.sample.json', import.meta.url))

/**
 * Start it. Resolves with { url, baseUrl (the /v1 base), close }.
 * @param {{ port?: number, host?: string, pricingFile?: string, usdExchangeRate?: number, topUpPrice?: number, models?: string[] }} [o]
 */
export async function startFakeNewApi({ port = 0, host = '127.0.0.1', pricingFile = SAMPLE_PRICING, usdExchangeRate = 7, topUpPrice = 7.3, models } = {}) {
  const relay = createFakeUpstream(models ? { models } : {})
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body) }
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://x').pathname
      if (req.method === 'GET' && path === '/api/pricing') return json(res, 200, readFileSync(pricingFile))
      // new-api's /api/status carries many more fields; these are the ones the converter reads. / 真实接口字段更多；这里只有转换器读的。
      if (req.method === 'GET' && path === '/api/status') return json(res, 200, JSON.stringify({ success: true, message: '', data: { usd_exchange_rate: usdExchangeRate, price: topUpPrice, quota_per_unit: 500000, version: 'fake' } }))
      if (!path.startsWith('/v1/')) return json(res, 404, '{"success":false,"message":"not found"}')
      const chunks = []
      for await (const c of req) chunks.push(c)
      const headers = new Headers()
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) { try { headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]) } catch { /* not a fetch header */ } }
      const r = await relay.handle(new Request(new URL(req.url, `http://${host}`), { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }))
      res.writeHead(r.status, Object.fromEntries(r.headers))
      if (!r.body || req.method === 'HEAD') return res.end()
      for await (const c of r.body) res.write(c)
      res.end()
    } catch (e) { if (!res.headersSent) json(res, 500, JSON.stringify({ success: false, message: String(e?.message || e) })); else res.destroy() }
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, host, resolve))
  const url = `http://${host}:${server.address().port}`
  return { url, baseUrl: `${url}/v1`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) }) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d)
  const s = await startFakeNewApi({ port: Number(arg('--port', 0)), pricingFile: arg('--pricing', SAMPLE_PRICING), usdExchangeRate: Number(arg('--usd-exchange-rate', 7)) })
  // One line the parent reads; the key is the fake upstream's demo key. / 父进程读取这一行；密钥是模拟上游的演示密钥。
  console.log(`[fake-new-api] listening on ${s.url} (relay ${s.baseUrl}, key ${DEMO_KEY})`)
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await s.close(); process.exit(0) })
}
