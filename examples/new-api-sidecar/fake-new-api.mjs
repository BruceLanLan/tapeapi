#!/usr/bin/env node
// A FAKE new-api for local runs, with the parts of new-api's shape the package relies on: the OpenAI-compatible relay
// under /v1 (the repository's fake upstream: no real model, no real key), the public price list GET /api/pricing (read
// from a file on every request, so a test can change a price), GET /api/status with usd_exchange_rate and
// quota_per_unit, and the usage log of what the relay answered: GET /api/log/self (the shape `tapeapi reconcile
// --preset new-api` expects: data.items with upstream_request_id, model_name, prompt_tokens, completion_tokens, quota,
// created_at; those field names were read in new-api's source code, model/log.go, and are not checked against a real
// instance) and GET /api/log/token (the same rows for one relay key). It is not new-api and proves nothing about new-api
// itself; it stands in for it on 127.0.0.1.
// 本地演练用的**模拟** new-api，只有一键包依赖的那几处形状：/v1 下的 OpenAI 兼容转发（仓库的模拟上游：没有真实模型、没有真实密钥），
// 公开价目 GET /api/pricing（每次请求都重新读文件，测试可以改价），带 usd_exchange_rate 与 quota_per_unit 的 GET /api/status，
// 以及转发所答内容的用量日志：GET /api/log/self（`tapeapi reconcile --preset new-api` 期待的形状：data.items，字段名取自 new-api
// 源码 model/log.go，尚未用真实实例核对）与 GET /api/log/token（同样的行，按一把转发密钥）。它不是 new-api，不证明 new-api 本身
// 的任何行为；只在 127.0.0.1 上代替它。
//
// The log rows / 日志行: one per answered metered call (HTTP 200 with usage; a stream counts when its last chunk carries
// usage), with `quota` computed the way the mock reads new-api's rule: round((prompt_tokens + completion_tokens x
// completion_ratio) x model_ratio x group_ratio), at least 1 when the ratio is not 0; the ratios come from the pricing
// file at the time of the call. `upstream_request_id` is filled with the answer's id (the `chatcmpl-...` a receipt
// carries); whether a real new-api puts that id there is not known (reconcile falls back to time, model and tokens).
// 每个有用量的回答（HTTP 200；流式以带 usage 的最后一块为准）一行；quota 按本模拟对 new-api 规则的理解计算：round((prompt_tokens
// + completion_tokens x completion_ratio) x model_ratio x group_ratio)，倍率非 0 时至少 1；倍率取调用时价目文件的值。
// upstream_request_id 填回答的 id（回执里的 chatcmpl-...）；真实 new-api 是否放这个 id 并不知道（reconcile 会退回按时间、模型与 token 数对应）。
//
// Who may read the log, as in new-api's source (read, not checked against an instance) / 谁能读日志（取自源码，未用实例核对）:
// /api/log/self is a user route (a dashboard session or a `nap_` access token with the usage:read scope; a relay key is
// refused), /api/log/token takes the relay key itself and answers its own rows only. Here: Bearer USER_TOKEN for the
// first, Bearer DEMO_KEY for the second; anything else is 401.
//
//   node examples/new-api-sidecar/fake-new-api.mjs [--port 0] [--pricing <file>] [--usd-exchange-rate 7] [--quota-per-unit 500000]
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createFakeUpstream, DEMO_KEY } from '../ai-proxy/fake-upstream.mjs'

export const SAMPLE_PRICING = fileURLToPath(new URL('fixtures/new-api-pricing.sample.json', import.meta.url))
/** The fake dashboard credential GET /api/log/self accepts (a stand-in for a `nap_` access token). / 模拟的用户级凭据。 */
export const USER_TOKEN = 'nap_demo'
/** new-api's default quota per $1 (common/constants.go, as read; a site may change it). / new-api 默认每 1 美元的额度。 */
export const DEFAULT_QUOTA_PER_UNIT = 500000
const MAX_PAGE_SIZE = 100
const MAX_TOKEN_LOG = 1000

const int = (v, d) => (v !== null && /^\d{1,12}$/.test(v) ? Number(v) : d)
const bearer = (req) => String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()

/** The usage a relay answer carries: JSON, or the last SSE chunk with usage. Null when there is none. / 回答里的用量。 */
export function usageOfAnswer(bytes, contentType = '') {
  const text = Buffer.from(bytes).toString('utf8')
  const pick = (o) => (o && typeof o === 'object' && o.usage && typeof o.usage === 'object' && Number.isInteger(o.usage.prompt_tokens) ? { id: typeof o.id === 'string' ? o.id : '', model: typeof o.model === 'string' ? o.model : '', prompt: o.usage.prompt_tokens, completion: Number.isInteger(o.usage.completion_tokens) ? o.usage.completion_tokens : 0 } : null)
  if (/^text\/event-stream/i.test(contentType) || /^data: /m.test(text)) {
    let found = null
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
      try { found = pick(JSON.parse(line.slice(6))) ?? found } catch { /* not JSON: not a usage chunk / 不是 JSON，不是用量块 */ }
    }
    return found
  }
  try { return pick(JSON.parse(text)) } catch { return null }
}

/** new-api's quota for a call, as this mock reads the rule (see the header). / 按本模拟对规则的理解算出的额度。 */
export function quotaOf(pricing, model, prompt, completion) {
  const m = Array.isArray(pricing?.data) ? pricing.data.find((x) => x?.model_name === model) : null
  const ratio = Number(m?.model_ratio ?? 0), comp = m?.completion_ratio === undefined || m?.completion_ratio === null ? 1 : Number(m.completion_ratio)
  const group = Array.isArray(m?.enable_groups) && m.enable_groups.length ? Number(pricing?.group_ratio?.[m.enable_groups[0]] ?? 1) : 1
  if (!(ratio > 0) || !(comp >= 0) || !(group >= 0)) return { quota: 0, model_ratio: ratio, completion_ratio: comp, group_ratio: group }
  const quota = Math.max(1, Math.round((prompt + completion * comp) * ratio * group))
  return { quota, model_ratio: ratio, completion_ratio: comp, group_ratio: group }
}

/**
 * Start it. Resolves with { url, baseUrl (the /v1 base), logs() (the rows so far), close }.
 * @param {{ port?: number, host?: string, pricingFile?: string, usdExchangeRate?: number, topUpPrice?: number, quotaPerUnit?: number, models?: string[] }} [o]
 */
export async function startFakeNewApi({ port = 0, host = '127.0.0.1', pricingFile = SAMPLE_PRICING, usdExchangeRate = 7, topUpPrice = 7.3, quotaPerUnit = DEFAULT_QUOTA_PER_UNIT, models } = {}) {
  const relay = createFakeUpstream(models ? { models } : {})
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)) }
  const unauthorized = (res) => json(res, 401, { success: false, message: 'unauthorized' })
  const rows = []
  let nextId = 1
  const record = ({ model, prompt, completion, answerId, isStream, startedAt, created }) => {
    let pricing = null
    try { pricing = JSON.parse(readFileSync(pricingFile, 'utf8')) } catch { /* no pricing: quota 0 / 没有价目：额度 0 */ }
    const q = quotaOf(pricing, model, prompt, completion)
    const id = nextId++
    rows.push({
      id, user_id: 1, created_at: created, type: 2, content: `模型倍率 ${q.model_ratio}，补全倍率 ${q.completion_ratio}，分组倍率 ${q.group_ratio}`,
      username: 'demo', token_name: 'demo token', model_name: model, quota: q.quota, prompt_tokens: prompt, completion_tokens: completion,
      use_time: Math.max(0, Math.round((Date.now() - startedAt) / 1000)), is_stream: isStream, channel: 1, token_id: 1, group: '1x', ip: '127.0.0.1',
      request_id: `${new Date(created * 1000).toISOString().slice(0, 10).replace(/-/g, '')}${String(id).padStart(6, '0')}`, upstream_request_id: answerId,
      other: JSON.stringify({ model_ratio: q.model_ratio, completion_ratio: q.completion_ratio, group_ratio: q.group_ratio, is_stream: isStream }),
    })
  }
  const filtered = (query) => {
    const start = int(query.get('start_timestamp'), null), end = int(query.get('end_timestamp'), null), type = int(query.get('type'), 0), model = query.get('model_name') || ''
    return rows.filter((r) => (type === 0 || r.type === type) && (start === null || r.created_at >= start) && (end === null || r.created_at <= end) && (!model || r.model_name === model))
  }
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://x')
      const path = u.pathname
      if (req.method === 'GET' && path === '/api/pricing') return json(res, 200, readFileSync(pricingFile))
      // new-api's /api/status carries many more fields; these are the ones the converter reads. / 真实接口字段更多；这里只有转换器读的。
      if (req.method === 'GET' && path === '/api/status') return json(res, 200, { success: true, message: '', data: { usd_exchange_rate: usdExchangeRate, price: topUpPrice, quota_per_unit: quotaPerUnit, version: 'fake' } })
      if (req.method === 'GET' && path === '/api/log/self') {
        if (bearer(req) !== USER_TOKEN) return unauthorized(res)
        const page = Math.max(1, int(u.searchParams.get('p'), 1)), size = Math.min(MAX_PAGE_SIZE, Math.max(1, int(u.searchParams.get('page_size'), 10)))
        const all = filtered(u.searchParams).reverse()   // newest first, as a log page shows / 最新的在前
        return json(res, 200, { success: true, message: '', data: { items: all.slice((page - 1) * size, page * size), total: all.length, page, page_size: size } })
      }
      if (req.method === 'GET' && path === '/api/log/token') {
        if (bearer(req) !== DEMO_KEY) return unauthorized(res)
        return json(res, 200, { success: true, message: '', data: filtered(u.searchParams).slice(-MAX_TOKEN_LOG).reverse() })
      }
      if (!path.startsWith('/v1/')) return json(res, 404, '{"success":false,"message":"not found"}')
      const startedAt = Date.now()
      const chunks = []
      for await (const c of req) chunks.push(c)
      const headers = new Headers()
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) { try { headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]) } catch { /* not a fetch header */ } }
      let reqBody = null
      try { reqBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* not JSON: the relay answers 400 / 不是 JSON：转发层答 400 */ }
      const r = await relay.handle(new Request(new URL(req.url, `http://${host}`), { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }))
      res.writeHead(r.status, Object.fromEntries(r.headers))
      if (!r.body || req.method === 'HEAD') return res.end()
      // The bytes go to the client unchanged; a copy is read for the log once the answer is complete.
      // 字节原样发给客户端；回答完整后读一份副本记日志。
      const copy = []
      for await (const c of r.body) { res.write(c); copy.push(Buffer.from(c)) }
      res.end()
      if (r.status === 200 && req.method === 'POST') {
        const used = usageOfAnswer(Buffer.concat(copy), r.headers.get('content-type') ?? '')
        if (used) record({ model: used.model || String(reqBody?.model ?? ''), prompt: used.prompt, completion: used.completion, answerId: used.id, isStream: reqBody?.stream === true, startedAt, created: Math.floor(Date.now() / 1000) })
      }
    } catch (e) { if (!res.headersSent) json(res, 500, { success: false, message: String(e?.message || e) }); else res.destroy() }
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, host, resolve))
  const url = `http://${host}:${server.address().port}`
  return { url, baseUrl: `${url}/v1`, logs: () => rows.map((r) => ({ ...r })), close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) }) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d)
  const s = await startFakeNewApi({ port: Number(arg('--port', 0)), pricingFile: arg('--pricing', SAMPLE_PRICING), usdExchangeRate: Number(arg('--usd-exchange-rate', 7)), quotaPerUnit: Number(arg('--quota-per-unit', DEFAULT_QUOTA_PER_UNIT)) })
  // One line the parent reads; the key is the fake upstream's demo key. / 父进程读取这一行；密钥是模拟上游的演示密钥。
  console.log(`[fake-new-api] listening on ${s.url} (relay ${s.baseUrl}, key ${DEMO_KEY}; log GET /api/log/self with Bearer ${USER_TOKEN}, GET /api/log/token with the key)`)
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await s.close(); process.exit(0) })
}
