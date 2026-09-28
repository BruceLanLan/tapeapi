// A signing sidecar in front of an AI API (docs/PLAN-2026Q4.md A3). The provider keeps its upstream, its keys and its
// billing; the sidecar passes /v1/* through byte for byte and signs every answer a format adapter recognises (sdk
// ai.FORMATS: OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, OpenAI Embeddings) as an AI usage receipt
// (A2): a TAP-21 envelope by the service's delegated key over { path, requestSha256 } and { model, usage,
// responseSha256, stream, price, status, usageInjected? }. Whole answers carry it in `x-tapeapi-receipt`; in an event
// stream the format's final event (`data: [DONE]`, `response.completed`, `message_stop`) is held back, the receipt is
// signed, sent as one SSE comment block (clients ignore comments), and then the final event is released; with no final
// event the comment is appended at the end. Every receipt is also kept for an hour and served by the free manifest
// method `receipt`. The manifest's AI field (ai.MANIFEST_FIELD) pins one endpoint per format and the price table on
// chain (A1). Manifest, /.well-known, health and `receipt` are createProvider's. Nothing here knows a vendor's JSON:
// adapters do (one small module per API format, in the SDK, where the verifiers use the same ones).
// 放在 AI 接口前面的签名旁路。服务方保留自己的上游、密钥与计费；旁路把 /v1/* 原样透传，并把格式适配器认得的每个回答签成 AI
// 用量回执（TAP-21 信封）。整体回答放在 x-tapeapi-receipt 响应头；事件流里先扣住格式的最终事件，签名，以一个 SSE 注释块发出
// 回执（客户端忽略注释），再放出最终事件；没有最终事件则把注释追加在末尾。所有回执另在内存保留一小时，由免费方法 receipt 提供。
// 清单的 AI 字段把每种格式的端点与价目表钉在链上。本文件不认识任何厂商的 JSON：那是适配器的事。
//
// What a receipt proves: who answered (the on-chain signer), to exactly which request bytes, with exactly which response
// bytes, and what usage and price were claimed. It does not prove which model actually ran.
// 回执证明的是：谁回答的（链上 signer）、针对哪些确切的请求字节、给出了哪些确切的回应字节、声称了多少用量与价格；
// 它不证明实际运行的是哪个模型。
//
// No node: imports: runs in Workers and Node alike. / 不引用 node:，Workers 与 Node 都能运行。
import { sig, ai, TapeAPIError } from '@tapeapi/sdk'
import { createProvider, VERSION } from './index.js'
import { readCappedBytes, TooLarge } from './read-capped.js'

/** Request bodies are refused past this many bytes (4 MiB). / 请求正文上限。 */
export const REQUEST_LIMIT = 4 * 1024 * 1024
/** A non-stream upstream answer is refused past this many bytes (16 MiB); streams are not capped. / 非流式上游回答上限。 */
export const RESPONSE_LIMIT = 16 * 1024 * 1024
/** A non-stream answer must be complete, and a stream must have started, within this many ms. / 上游时限。 */
export const UPSTREAM_TIMEOUT_MS = 120_000
export const RECEIPT_TTL_MS = 3_600_000
export const MAX_RECEIPTS = 50_000
/** At most this many bytes of one event are held back (a final event, or a chunk that may be stripped); past it the
 *  event streams through and the receipt is appended at the end. / 单个事件至多扣住这么多字节；超过则照常转发，回执追加在末尾。 */
export const HOLD_LIMIT = 4 * 1024 * 1024
/** The API namespace the sidecar proxies, under the service root. / 旁路代理的 API 命名空间（在服务根之下）。 */
const API_PREFIX = '/v1/'
const MANIFEST_LIMIT = 64 * 1024
const CONSOLE_MANIFEST_LIMIT = 24_000
const UNPRICED_LOG_MAX = 64
const LF = 0x0a, CR = 0x0d, COLON = 0x3a
const enc = new TextEncoder()
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const byteLength = (s) => enc.encode(s).length

// The one free method the sidecar adds: a receipt by response id (A2). / 旁路添加的唯一免费方法：按响应 id 取回执。
const RECEIPT_METHOD = Object.freeze({
  name: ai.RECEIPT_METHOD, priceBEM: '0', params: { id: 'string' },
  returns: { id: 'string', ok: 'boolean', result: 'object', container: 'string', ts: 'number', method: 'string', params: 'object', sig: 'string' },
  description: 'The signed usage receipt of an AI response, by the response id (kept for 1 hour after the answer).',
})

// Caller headers that reach the upstream: these, plus each configured format's own (`headers`: OpenAI's authorization,
// openai-beta, -organization, -project; Anthropic's x-api-key, anthropic-version, anthropic-beta), passed verbatim.
// Nothing else a caller sent does: no cookie, no x-forwarded-*, no cf-*, no x-stainless-*.
// 能到达上游的调用方请求头：这些，加上各格式声明的，原样转发。调用方发来的其它任何头都到不了上游。
const FORWARD_BASE = ['content-type', 'accept']
// Upstream response headers that are not passed on: hop-by-hop, those that describe the transfer rather than the body
// (fetch has already decoded it), cookies of the upstream's own domain, the upstream's CORS (ours replaces it), and any
// receipt header an upstream tries to set (ours replaces it).
// 不转交的上游响应头：逐跳头、描述传输而非正文的头（fetch 已解码）、上游自己域名的 Cookie、上游的 CORS、上游试图设置的回执头。
const DROP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authenticate',
  'proxy-authorization', 'content-encoding', 'content-length', 'set-cookie', 'set-cookie2', 'alt-svc', ai.RECEIPT_HEADER])
const EXPOSE_BASE = [ai.RECEIPT_HEADER, 'retry-after']
const TOKEN_LIST = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+(?:\s*,\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+)*$/
const NULL_BODY = new Set([101, 204, 205, 304])

// Errors of the sidecar itself, in the OpenAI error shape (the most widely read one). Unsigned: no upstream answer
// exists to bind. / 旁路自己的错误，按 OpenAI 的错误格式。未签名：没有可绑定的上游回答。
const errorResponse = (status, code, message, headers) => new Response(JSON.stringify({ error: { message, type: 'tapeapi_proxy_error', param: null, code } }), {
  status, headers: { 'content-type': 'application/json', ...headers },
})

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const isPrefix = (a, b) => a.length <= b.length && a.every((x, i) => x === b[i])
// The first lines that open a format's final event: `data: X` / `data:X`, `event: Y` / `event:Y`.
// 开启最终事件的首行。
const finalLines = (final) => [...(final?.data ?? []).flatMap((d) => [`data: ${d}`, `data:${d}`]), ...(final?.event ?? []).flatMap((e) => [`event: ${e}`, `event:${e}`])].map((x) => enc.encode(x))
const DATA = enc.encode('data')
function concat(parts) {
  if (parts.length === 1) return parts[0]
  let n = 0; for (const p of parts) n += p.length
  const out = new Uint8Array(n); let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
const goodId = (v) => typeof v === 'string' && /^[\x21-\x7e]{1,128}$/.test(v)
function newId() {
  const b = new Uint8Array(12); crypto.getRandomValues(b)
  return 'tapeapi-' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}
const jsonOf = (bytes) => { try { return JSON.parse(new TextDecoder().decode(bytes)) } catch { return undefined } }
// One whole event's bytes -> its JSON data and name (for an adapter). / 一个完整事件的字节 -> 其 JSON 数据与事件名。
function eventOf(bytes) {
  let data = null, name = ''
  for (const line of new TextDecoder().decode(bytes).split(/\r\n|\r|\n/)) {
    if (line.startsWith(':') || !line) continue
    const k = line.indexOf(':'), field = k < 0 ? line : line.slice(0, k)
    let v = k < 0 ? '' : line.slice(k + 1)
    if (v.startsWith(' ')) v = v.slice(1)
    if (field === 'data') data = data === null ? v : `${data}\n${v}`
    else if (field === 'event') name = v
  }
  let json
  try { json = data === null ? undefined : JSON.parse(data) } catch { json = undefined }
  return { json, name }
}
function validFormat(f) {
  return isObj(f) && typeof f.name === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(f.name) && /^[a-z][a-z0-9_]{0,63}$/.test(f.method) &&
    typeof f.baseSuffix === 'string' && (f.baseSuffix === '' || /^\/[A-Za-z0-9._~/-]*[^/]$/.test(f.baseSuffix)) &&
    typeof f.match === 'function' && typeof f.response === 'function' && typeof f.streamState === 'function' &&
    (f.stream === null || (isObj(f.stream) && f.stream.framing === 'sse')) &&
    (f.prepareUpstream === undefined || (typeof f.prepareUpstream === 'function' && typeof f.isInjectedEvent === 'function'))
}

/**
 * @param {object} o
 * @param {{ baseUrl: string, headers?: Record<string, string> }} o.upstream  the upstream's `/v1` base, e.g.
 *        https://api.example/v1 (every format's /v1/... path goes under it); fixed by configuration, never by a
 *        request. `headers` are operator-set and sent on every upstream request. / 上游的 /v1 基址，只由配置决定。
 * @param {object} o.manifestBase  identity fields: name, circuits, tokenId, container, delegation, endpoints (dev, tapeapi)
 * @param {string} o.signerKey
 * @param {Array<{ id, formats?, price: { currency, unit: '1M tokens', input, output, cacheRead?, cacheWrite?, reasoning? } }>} o.models
 *        the price table published in the manifest / 发布在清单里的价目表
 * @param {object[]} [o.formats]  the API format adapters (default ai.FORMATS) / API 格式适配器
 * @param {Function} [o.fetch]
 * @param {Function} [o.log]
 * @param {object|false} [o.rateLimit]  passed to createProvider; its `ip` budget (default free + paid) also bounds /v1/* per IP
 * @param {number} [o.receiptTtlMs=3600000]
 * @param {number} [o.maxReceipts=50000]
 * @param {string} [o.publicUrl]  the service root the endpoints are built on; default endpoints.live[0] without /tapeapi/v1
 * @param {boolean} [o.allowHttp]  http endpoints (local testing)
 * @param {number} [o.upstreamTimeoutMs=120000]
 */
export function createAIProxy(opts = {}) {
  const { upstream, manifestBase, signerKey, models, receiptTtlMs = RECEIPT_TTL_MS, maxReceipts = MAX_RECEIPTS, formats = ai.FORMATS } = opts
  if (!isObj(upstream) || typeof upstream.baseUrl !== 'string') throw new TapeAPIError('BAD_REQUEST', 'upstream must be { baseUrl, headers? }')
  let up
  try { up = new URL(upstream.baseUrl) } catch { throw new TapeAPIError('BAD_REQUEST', 'upstream.baseUrl must be a URL') }
  if (up.protocol !== 'https:' && up.protocol !== 'http:') throw new TapeAPIError('BAD_REQUEST', 'upstream.baseUrl must be http(s)')
  if (up.username || up.password || up.search || up.hash) throw new TapeAPIError('BAD_REQUEST', 'upstream.baseUrl must not carry credentials, a query or a fragment (put a key in upstream.headers)')
  const upPath = up.pathname.replace(/\/+$/, '')
  const operatorHeaders = new Headers()
  if (upstream.headers !== undefined) {
    if (!isObj(upstream.headers)) throw new TapeAPIError('BAD_REQUEST', 'upstream.headers must be an object of strings')
    for (const [k, v] of Object.entries(upstream.headers)) {
      if (typeof v !== 'string') throw new TapeAPIError('BAD_REQUEST', `upstream.headers.${k} must be a string`)
      try { operatorHeaders.set(k, v) } catch { throw new TapeAPIError('BAD_REQUEST', `upstream.headers.${k} is not a valid header`) }
    }
  }
  if (!isObj(manifestBase)) throw new TapeAPIError('MANIFEST_INVALID', 'manifestBase must be an object')
  if (!signerKey) throw new TapeAPIError('BAD_KEY', 'signerKey required')
  if (!Number.isFinite(receiptTtlMs) || receiptTtlMs <= 0) throw new TapeAPIError('BAD_REQUEST', 'receiptTtlMs must be a positive number')
  if (!Number.isInteger(maxReceipts) || maxReceipts <= 0) throw new TapeAPIError('BAD_REQUEST', 'maxReceipts must be a positive integer')
  if (!Array.isArray(formats) || !formats.length || !formats.every(validFormat)) throw new TapeAPIError('BAD_REQUEST', 'formats must be a non-empty list of adapters (see sdk ai.js)')
  if (new Set(formats.map((f) => f.method)).size !== formats.length || new Set(formats.map((f) => f.name)).size !== formats.length) throw new TapeAPIError('BAD_REQUEST', 'two formats share a name or a receipt method')
  const listOf = (k) => formats.flatMap((f) => (Array.isArray(f[k]) ? f[k].map((h) => String(h).toLowerCase()) : []))
  const forward = [...new Set([...FORWARD_BASE, ...listOf('headers')])]
  const allowHeaders = forward.join(', ')
  const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': [...new Set([...EXPOSE_BASE, ...listOf('exposeHeaders')])].join(', ') }
  const oaError = (status, code, message, extra = {}) => errorResponse(status, code, message, { ...CORS, ...extra })
  const timeoutMs = Number(opts.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TapeAPIError('BAD_REQUEST', 'upstreamTimeoutMs must be a positive number')
  const signer = sig.privateKeyToAddress(signerKey)
  const log = opts.log || ((...a) => console.error('[tapeapi/ai-proxy]', ...a))
  const fetchImpl = opts.fetch || ((...a) => globalThis.fetch(...a))
  const label = up.origin + upPath
  // An operator key sent on every request means the sidecar serves anyone who reaches it with that key: it does no
  // authentication of its own. Said out loud. / 运营者密钥随每个请求发送，意味着任何能访问旁路的人都在用这把密钥：旁路自己不做鉴权。
  for (const k of ['authorization', 'x-api-key']) if (operatorHeaders.has(k)) log(`upstream.headers sets ${k}: every caller's request goes upstream with the operator's key (callers' own ${k} is replaced) and this sidecar authenticates no one; put your own gateway in front, or let callers' keys through`)

  // ---- the manifest: one endpoint per format on the service root / 清单：每种格式一个端点，建在服务根上 ----
  const { tapeapi = '0.1', ...base } = manifestBase
  const live = base.endpoints?.live?.[0]
  const root = (opts.publicUrl ?? (typeof live === 'string' ? live.replace(/\/tapeapi\/v1\/*$/, '') : null))?.replace(/\/+$/, '')
  if (!root) throw new TapeAPIError('MANIFEST_INVALID', 'publicUrl is required when endpoints.live is empty')
  const field = ai.validateAIField({ endpoints: formats.map((f) => ({ format: f.name, baseUrl: root + f.baseSuffix })), models }, { allowHttp: opts.allowHttp === true || base.dev === true })
  const rootPath = new URL(root).pathname.replace(/\/+$/, '')
  const manifest = { tapeapi, ...base, signer, methods: [{ ...RECEIPT_METHOD, params: { ...RECEIPT_METHOD.params }, returns: { ...RECEIPT_METHOD.returns } }], [ai.MANIFEST_FIELD]: field }
  const size = byteLength(JSON.stringify(manifest))
  if (size > MANIFEST_LIMIT) throw new TapeAPIError('MANIFEST_INVALID', `the manifest would be ${size} bytes, over TAP-20's ${MANIFEST_LIMIT}; shorten the price table`)
  if (size > CONSOLE_MANIFEST_LIMIT) log(`the manifest is ${size} bytes; the holder console publishes at most ${CONSOLE_MANIFEST_LIMIT} in one transaction`)

  const st = { requests: 0, receipts: 0, streams: 0, passThrough: 0, upstreamErrors: 0, upstreamFailures: 0, timeouts: 0, tooLarge: 0, redirects: 0, rateLimited: 0, duplicateIds: 0, lookups: 0, misses: 0, usageInjected: 0, appended: 0 }
  const unpriced = new Set()

  // ---- the receipt store: insertion-ordered, bounded, each entry dated / 回执存储：按插入排序、有界、逐条带期限 ----
  const receipts = new Map()   // id -> { env, exp }
  function keep(env) {
    const t = Date.now()
    if (receipts.has(env.id)) {
      // Two answers with one id (an upstream reusing ids): the later one is served; both were delivered inline.
      // 同一 id 的两个回答（上游重复使用 id）：取回时给后一个；两者都已随回答送达。
      if (st.duplicateIds++ === 0) log(`the upstream reused response id ${env.id.slice(0, 80)}; the receipt method serves the latest answer for an id`)
      receipts.delete(env.id)
    }
    receipts.set(env.id, { env, exp: t + receiptTtlMs })
    for (const [k, v] of receipts) { if (v.exp > t && receipts.size <= maxReceipts) break; receipts.delete(k) }
  }
  function lookup(id) {
    const e = receipts.get(id)
    if (!e) return null
    if (e.exp <= Date.now()) { receipts.delete(id); return null }
    return e.env
  }

  const provider = createProvider({
    manifest, signerKey, log,
    methods: {
      [ai.RECEIPT_METHOD]: async (params) => {
        st.lookups++
        const id = params?.id
        if (typeof id !== 'string' || !id || id.length > 256) throw new TapeAPIError('BAD_REQUEST', 'params.id must be the response id (the id of the answer, or of the receipt)')
        const env = lookup(id)
        if (!env) { st.misses++; throw new TapeAPIError('BAD_REQUEST', `no receipt for ${id.slice(0, 128)}: receipts are kept for ${Math.round(receiptTtlMs / 60_000)} min, in this process only`) }
        return env
      },
    },
    ...(opts.rateLimit !== undefined ? { rateLimit: opts.rateLimit } : {}),
    ...(opts.allowHttp ? { allowHttp: true } : {}),
  })
  const container = provider.container

  // ---- signing / 签名 ----
  function resultOf({ format, model, usage, responseSha256, stream, status, usageInjected }) {
    const ok = status >= 200 && status < 300
    const m = typeof model === 'string' && model.length <= ai.MODEL_ID_MAX ? model : null
    // A failed call claims no usage, so it carries no price: the receipt makes the failure attributable, not billable.
    // 失败的调用不声称用量，也就没有价格：回执让失败可追责，而不是可计费。
    const u = ok ? ai.usageOf(usage) : null
    const price = ai.priceOf(field.models, m, u, format.name)
    if (u && m !== null && !price && !unpriced.has(m) && unpriced.size < UNPRICED_LOG_MAX) {
      unpriced.add(m)
      log(`the upstream reported model ${JSON.stringify(m.slice(0, 80))}, which is not priced for ${format.name}: its receipts carry price null (add the exact id to models to price it)`)
    }
    const r = { model: m, usage: u, responseSha256, stream, price, status }
    if (usageInjected) r.usageInjected = true
    return r
  }
  function signReceipt({ id, method, params, result }) {
    const ts = Math.floor(Date.now() / 1000)
    const env = { id, ok: true, result, container, ts, method, params }
    env.sig = sig.signResponse({ container, id, method, params, ok: true, body: result, ts }, signerKey)
    keep(env)
    st.receipts++
    return env
  }

  // ---- an event stream / 事件流 ----
  // Passed on as it arrives, event by event, except for two kinds of event that are held until their blank line: the
  // format's final event (recognised by its first line), which is released right after the receipt comment block; and,
  // when the sidecar asked the upstream for usage the client did not ask for, every data event, so the usage chunk that
  // request caused can be stripped. Every other event streams through as soon as its first line shows it is not one of
  // those. What the client receives is exactly what the scanner hashes (the comment and a stripped chunk are neither).
  // 到达即转交，只有两类事件会扣到其空行：格式的最终事件（凭首行认出），在回执注释块之后放出；以及当旁路替客户端向上游要了
  // usage 时的每个 data 事件，以便去掉因此多出的 usage 块。其它事件一旦首行表明不属于这两类，就立即转发。
  // 客户端收到的正是扫描器取哈希的内容（注释与被去掉的块都不在其中）。
  function receiptStream({ format, params, status, strip, usageInjected }) {
    const finals = finalLines(format.stream.final)
    const read = format.streamState()
    const onEvent = (json, name) => { try { read.event(json, name) } catch (e) { log(`${format.name}: reading a stream event failed: ${e?.message || e}`) } }
    const scanner = ai.createSseScanner({ sentinel: format.stream.sentinel ?? null, onEvent })
    let injected = false, lastByte = -1, lastCR = false
    let mode = 'start'      // 'start' (first field line not seen) | 'pass' | 'final' | 'strip' / 当前事件的处理方式
    let held = [], heldLen = 0
    let line = [], lineLen = 0, lineComment = false
    let out = null
    const emit = (b) => { scanner.push(b); out.push(b) }
    const signed = () => {
      injected = true
      const r = read.result()
      const env = signReceipt({ id: goodId(r.id) ? r.id : newId(), method: format.method, params, result: resultOf({ format, model: r.model, usage: r.usage, responseSha256: scanner.digest(), stream: true, status, usageInjected }) })
      return enc.encode(ai.receiptComment(env))
    }
    const release = () => { for (const b of held) emit(b); held = []; heldLen = 0 }
    const route = (b) => {
      if (!b.length) return
      if (mode === 'pass') return emit(b)
      held.push(b.slice()); heldLen += b.length
      if (heldLen > HOLD_LIMIT) { release(); mode = 'pass' }   // too big to hold: it streams, the receipt goes at the end / 太大：照常转发，回执放末尾
    }
    // The first 64 bytes of the current line: enough to recognise a final line or a data line.
    // 当前行的前 64 字节：足以认出最终事件行或 data 行。
    const head = () => concat(line.length ? line : [new Uint8Array(0)])
    const dataLine = (h) => isPrefix(h.subarray(0, 4), DATA)   // 'd', 'da', 'dat' so far, or starting with 'data' / 目前为止是 data 的前缀，或以 data 开头
    // Could the event's first field line still turn out to be one we hold? / 事件首个字段行是否仍可能是要扣住的那种？
    const candidate = () => {
      if (lineComment) return true   // comments wait for the first field line or the blank line / 注释等待首个字段行或空行
      const h = head()
      if (strip && dataLine(h)) return true
      return !injected && lineLen <= 64 && finals.some((f) => isPrefix(h, f))
    }
    function content(b) {
      if (mode === 'start') {
        if (lineLen === 0) lineComment = b[0] === COLON
        if (lineLen < 64) line.push(b.subarray(0, 64 - lineLen))
        lineLen += b.length
        route(b)
        if (!candidate()) { release(); mode = 'pass' }
      } else { lineLen += b.length; route(b) }
    }
    function endLine(term) {
      const blank = lineLen === 0
      route(term)
      if (blank) endEvent()
      else if (mode === 'start' && !lineComment) {
        const h = head()
        if (!injected && lineLen <= 64 && finals.some((f) => sameBytes(h, f))) mode = 'final'
        else if (strip && h.length >= 4 && dataLine(h)) mode = 'strip'
        else { release(); mode = 'pass' }
      }
      line = []; lineLen = 0; lineComment = false
    }
    function endEvent() {
      if (mode === 'final') {
        // The final event goes into the hash (and the adapter reads its usage) before the receipt is signed.
        // 最终事件先计入哈希（适配器也读到它的 usage），再签回执。
        const ev = held; held = []; heldLen = 0
        for (const b of ev) scanner.push(b)
        out.push(signed(), enc.encode('\n\n'), ...ev)
      } else if (mode === 'strip') {
        const ev = concat(held)
        const { json, name } = eventOf(ev)
        if (json !== undefined && format.isInjectedEvent(json)) { onEvent(json, name); held = []; heldLen = 0 }   // ours: the client did not ask for it / 是我们要来的：客户端没要
        else release()
      } else release()
      mode = 'start'
    }
    const send = (controller) => {
      if (!out.length) return
      const b = concat(out)
      if (b.length) { lastByte = b[b.length - 1]; controller.enqueue(b) }
    }
    return new TransformStream({
      transform(chunk, controller) {
        out = []
        const n = chunk.length
        let i = 0
        if (lastCR && n) {
          lastCR = false
          if (chunk[0] === LF) {
            // The LF of a CRLF split across chunks belongs to the line already ended. / 跨块 CRLF 的 LF 属于已结束的那一行。
            if (mode === 'start' && !held.length) emit(chunk.subarray(0, 1)); else route(chunk.subarray(0, 1))
            i = 1
          }
        }
        let nextLF = -2, nextCR = -2
        while (i < n) {
          if (nextLF !== -1 && nextLF < i) nextLF = chunk.indexOf(LF, i)
          if (nextCR !== -1 && nextCR < i) nextCR = chunk.indexOf(CR, i)
          const j = nextLF < 0 ? (nextCR < 0 ? n : nextCR) : nextCR < 0 ? nextLF : Math.min(nextLF, nextCR)
          if (j > i) content(chunk.subarray(i, j))
          if (j === n) break
          let k = j + 1
          if (chunk[j] === CR) { if (k < n) { if (chunk[k] === LF) k++ } else lastCR = true }
          endLine(chunk.subarray(j, k))
          i = k
        }
        send(controller)
      },
      flush(controller) {
        out = []
        if (held.length) {
          if (mode === 'final' && !injected) {
            // The final event never finished (no blank line): no client dispatches it, so the receipt goes before it.
            // 最终事件没有结束（没有空行）：客户端都不会分派它，回执放在它前面。
            out.push(signed(), enc.encode('\n\n'))
          }
          release()
        }
        scanner.end()
        if (!injected) {
          // No final event: one comment line at the end, after a line end if the stream stopped mid-line. No blank line:
          // an unfinished event must stay unfinished, as a client's parser discards it.
          // 没有最终事件：在末尾追加一行注释（停在行中时先补换行）。不加空行：未结束的事件必须保持未结束。
          st.appended++
          const tail = out.length ? out[out.length - 1] : null
          const last = tail && tail.length ? tail[tail.length - 1] : lastByte
          if (last !== -1 && last !== LF && last !== CR) out.push(enc.encode('\n'))
          out.push(signed(), enc.encode('\n'))
        }
        send(controller)
      },
    })
  }

  // ---- /v1/* ----
  function preflight(request) {
    const asked = request.headers.get('access-control-request-headers')
    const allow = asked && asked.length <= 2048 && TOKEN_LIST.test(asked.trim()) ? `${allowHeaders}, ${asked.trim()}` : allowHeaders
    return new Response(null, { status: 204, headers: { ...CORS, 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-allow-headers': allow, 'access-control-max-age': '86400' } })
  }
  function responseHeaders(res) {
    const h = new Headers()
    for (const [k, v] of res.headers) { if (DROP.has(k) || k.startsWith('access-control-')) continue; h.append(k, v) }
    for (const [k, v] of Object.entries(CORS)) h.set(k, v)
    return h
  }

  // Per-IP fixed window for /v1/* (createProvider's limiter covers /tapeapi/v1/*): every answer here costs a signature
  // and a stored receipt. / /v1/* 的按 IP 固定窗口（/tapeapi/v1/* 由 createProvider 限流）：这里每个回答都要签名并存一份回执。
  const rl = opts.rateLimit === false ? null : {
    windowMs: Number(opts.rateLimit?.windowMs ?? 60_000),
    budget: Number(opts.rateLimit?.ip ?? Number(opts.rateLimit?.free ?? 600) + Number(opts.rateLimit?.paid ?? 6000)),
    max: Number(opts.rateLimit?.max ?? 50_000),
  }
  const buckets = new Map()
  function limited(ip) {
    if (!rl || !rl.budget) return 0
    const t = Date.now()
    let b = buckets.get(ip)
    if (!b || t >= b.reset) { b = { n: 0, reset: t + rl.windowMs }; buckets.delete(ip); buckets.set(ip, b) }
    b.n++
    while (buckets.size > rl.max) buckets.delete(buckets.keys().next().value)
    return b.n > rl.budget ? Math.max(1, Math.ceil((b.reset - t) / 1000)) : 0
  }

  async function proxy(request, path, clientIp) {
    st.requests++
    const wait = limited(clientIp || 'unknown')
    if (wait) { st.rateLimited++; return oaError(429, 'rate_limited', `too many requests; retry in ${wait}s`, { 'retry-after': String(wait) }) }
    const verb = request.method
    if (verb !== 'GET' && verb !== 'POST' && verb !== 'DELETE') return oaError(405, 'method_not_allowed', 'use GET, POST or DELETE', { allow: 'GET, POST, DELETE, OPTIONS' })
    const format = ai.formatFor(verb, path, formats)
    let body = null
    if (verb !== 'GET') {
      try { body = await readCappedBytes(request.body, REQUEST_LIMIT) } catch (e) {
        if (e instanceof TooLarge) { st.tooLarge++; return oaError(413, 'request_too_large', `the request body is larger than ${REQUEST_LIMIT} bytes`) }
        return oaError(400, 'unreadable_request', 'the request body could not be read')
      }
    }
    // Fixed by configuration: the origin and the base path can never come from the request ("//host" in a path must
    // not become a protocol-relative URL). / 由配置固定：来源与基路径绝不来自请求（路径里的 "//host" 不能变成协议相对 URL）。
    const url = new URL(up.origin + upPath + path.slice(API_PREFIX.length - 1) + new URL(request.url).search)
    if (url.origin !== up.origin || !url.pathname.startsWith(upPath + '/')) return oaError(400, 'bad_path', 'bad path')
    const headers = new Headers()
    for (const k of forward) { const v = request.headers.get(k); if (v !== null) headers.set(k, v) }
    for (const [k, v] of operatorHeaders) headers.set(k, v)
    // A format may change what goes upstream (to ask for usage); the receipt still hashes what the client sent.
    // 格式可以改变发往上游的内容（为了要到 usage）；回执哈希的仍是客户端发来的字节。
    let upstreamBody = body, prepared = null
    if (format?.prepareUpstream && body && body.length) {
      try { prepared = format.prepareUpstream(jsonOf(body)) } catch (e) { log(`${format.name}: preparing the upstream request failed: ${e?.message || e}`) }
      if (prepared) { upstreamBody = enc.encode(JSON.stringify(prepared.body)); st.usageInjected++ }
    }
    const ac = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ac.abort() }, timeoutMs)
    let res
    try {
      res = await fetchImpl(url.href, { method: verb, headers, body: upstreamBody && upstreamBody.length ? upstreamBody : verb === 'POST' ? upstreamBody : undefined, redirect: 'manual', signal: ac.signal })
    } catch (e) {
      clearTimeout(timer)
      if (timedOut) { st.timeouts++; return oaError(504, 'upstream_timeout', `the upstream did not answer within ${timeoutMs} ms`) }
      st.upstreamFailures++; log(`upstream fetch failed: ${e?.message || e}`)
      return oaError(502, 'upstream_unavailable', 'the upstream API could not be reached')
    }
    // Redirects are never followed, and never passed on (a Location would show the upstream's internals).
    // 重定向既不跟随，也不转交（Location 会暴露上游内部地址）。
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      clearTimeout(timer); try { await res.body?.cancel() } catch { /* ignore */ }
      st.redirects++; log(`the upstream answered ${path} with HTTP ${res.status} (a redirect); not followed`)
      return oaError(502, 'upstream_redirect', 'the upstream answered with a redirect, which this proxy does not follow')
    }
    if (res.status >= 400) st.upstreamErrors++
    const out = responseHeaders(res)
    if (!format) {
      // Not a receipt path (models, count_tokens, files, ...): passed through as it comes. / 非回执路径：原样透传。
      clearTimeout(timer); st.passThrough++
      return new Response(NULL_BODY.has(res.status) ? null : res.body, { status: res.status, statusText: res.statusText, headers: out })
    }
    const params = { path, requestSha256: ai.sha256Hex(body ?? new Uint8Array(0)) }
    // A stream only for a format that streams, answered as an event stream (the verifiers apply the same rule).
    // 只有会流式的格式、且以事件流作答时才按流处理（核验方用同一条规则）。
    const stream = !!format.stream && (res.headers.get('content-type') || '').toLowerCase().includes('text/event-stream') && !!res.body && !NULL_BODY.has(res.status)
    if (stream) {
      clearTimeout(timer); st.streams++
      const s = receiptStream({ format, params, status: res.status, strip: !!prepared?.strip, usageInjected: !!prepared })
      return new Response(res.body.pipeThrough(s), { status: res.status, statusText: res.statusText, headers: out })
    }
    let bytes
    try { bytes = NULL_BODY.has(res.status) ? new Uint8Array(0) : await readCappedBytes(res.body, RESPONSE_LIMIT, { signal: ac.signal }) } catch (e) {
      if (e instanceof TooLarge) { st.tooLarge++; return oaError(502, 'upstream_response_too_large', `the upstream answer is larger than ${RESPONSE_LIMIT} bytes`) }
      if (timedOut) { st.timeouts++; return oaError(504, 'upstream_timeout', `the upstream did not answer within ${timeoutMs} ms`) }
      st.upstreamFailures++; log(`reading the upstream answer failed: ${e?.message || e}`)
      return oaError(502, 'upstream_unavailable', 'the upstream answer could not be read')
    } finally { clearTimeout(timer) }
    let r = { id: null, model: null, usage: null }
    try { r = format.response(jsonOf(bytes)) ?? r } catch (e) { log(`${format.name}: reading the answer failed: ${e?.message || e}`) }
    const env = signReceipt({
      id: goodId(r.id) ? r.id : newId(), method: format.method, params,
      result: resultOf({ format, model: r.model, usage: r.usage, responseSha256: ai.sha256Hex(bytes), stream: false, status: res.status, usageInjected: !!prepared }),
    })
    out.set(ai.RECEIPT_HEADER, ai.encodeReceipt(env))
    return new Response(NULL_BODY.has(res.status) ? null : bytes, { status: res.status, statusText: res.statusText, headers: out })
  }

  async function handleRequest(request, { clientIp } = {}) {
    const path = ai.apiPath(new URL(request.url).pathname, rootPath)
    if (path && path.startsWith(API_PREFIX)) {
      if (request.method === 'OPTIONS') return preflight(request)
      try { return await proxy(request, path, clientIp) } catch (e) {
        log('proxy crashed', e)
        return oaError(500, 'internal_error', 'internal error')
      }
    }
    if (path?.replace(/\/+$/, '') === '/tapeapi/v1/health' && request.method === 'GET') {
      const res = await provider.handleRequest(request, { clientIp })
      const h = await res.json()
      return new Response(JSON.stringify({ ...h, ai: { endpoints: field.endpoints, models: field.models.length, receiptsKept: receipts.size } }), { status: res.status, headers: res.headers })
    }
    return provider.handleRequest(request, { clientIp })
  }

  return {
    ready: Promise.resolve(manifest),
    handleRequest,
    manifest: () => manifest,
    stats: () => ({
      ready: true, version: VERSION, upstream: label, endpoints: field.endpoints.map((e) => ({ ...e })), formats: formats.map((f) => f.name), models: field.models.length, receiptsKept: receipts.size,
      ...st, unpricedModels: [...unpriced], provider: provider.stats(),
    }),
  }
}
