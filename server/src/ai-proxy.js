// A signing sidecar in front of an AI API (docs/PLAN-2026Q4.md A3). The provider keeps its upstream, its keys and its
// billing; the sidecar passes /v1/* through byte for byte and signs every answer a format adapter recognises (sdk
// ai.FORMATS: OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, OpenAI Embeddings) as an AI usage receipt
// (A2): a TAP-21 envelope by the service's delegated key over { path, requestSha256 } and { model, usage,
// responseSha256, stream, complete, status, prices, modelMatchedBy?, unpriced?, usageInjected? } (sdk ai.js states the
// rules). Whole answers carry it in `x-tapeapi-receipt`; in an event
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

/** Request bodies are refused past this many bytes (32 MiB, Anthropic's own request limit: images and PDFs ride in the
 *  body). / 请求正文上限（32 MiB，与 Anthropic 自己的上限相同：图片与 PDF 都在正文里）。 */
export const REQUEST_LIMIT = 32 * 1024 * 1024
/** A non-stream upstream answer is refused past this many bytes (16 MiB); streams are not capped. / 非流式上游回答上限。 */
export const RESPONSE_LIMIT = 16 * 1024 * 1024
/** A non-stream answer must be complete, and a stream must have started, within this many ms (600 s, the official SDKs'
 *  own timeout: Claude Code falls back to a non-streaming call after a stream error, and that call may be long).
 *  / 非流式回答须在此时限内完成、流须在此时限内开始（600 秒，与官方 SDK 的超时相同）。 */
export const UPSTREAM_TIMEOUT_MS = 600_000
/** A stream that sends nothing for this many ms is ended there (its receipt appended, complete false). / 流在这么久没有
 *  任何字节时就此结束（回执追加在末尾，complete 为 false）。 */
export const STREAM_IDLE_MS = 300_000
export const RECEIPT_TTL_MS = 3_600_000
export const MAX_RECEIPTS = 50_000
/** The free `receipt` method has a budget of its own: this many lookups per client IP per minute. An answer id is all a
 *  lookup needs, and some upstreams' ids are guessable (below), so the generous free budget of createProvider would let
 *  one IP walk through every id. / 免费的 receipt 方法有自己的预算：每个客户端 IP 每分钟这么多次。取回只需要回答 id，而有些上游
 *  的 id 可以猜（见下），createProvider 宽松的免费预算会让一个 IP 把所有 id 走一遍。 */
export const RECEIPT_LOOKUPS_PER_MIN = 10
/** Upstream answer ids estimated below this many bits of randomness are called guessable (idEntropyBits). / 估计随机性
 *  低于这么多比特的上游回答 id 视为可猜。 */
export const ID_ENTROPY_MIN_BITS = 64
const HEX64_RE = /^[0-9a-f]{64}$/

/**
 * A rough estimate of the random bits in one answer id, from its shape: a leading word and its separator ("chatcmpl-",
 * "msg_", "resp_") are taken off, as are the separators "-" and "_"; the rest counts log2 of its alphabet per character
 * (digits 10, hex 16, else the letter cases, digits and other characters it uses). An upper bound: a counter or a
 * timestamp looks as random as its digits. Ollama's OpenAI-compatible ids ("chatcmpl-" and a number below 999,
 * ollama/ollama#18655) come out at about 10 bits; OpenAI's, Anthropic's and this sidecar's own ids at well over 100.
 * 按形状粗估一个回答 id 的随机比特：去掉开头的单词与分隔符（"chatcmpl-"、"msg_"、"resp_"）以及分隔符 "-"、"_"，其余每个字符计
 * log2(字母表大小)（纯数字 10、十六进制 16，否则按用到的大小写字母、数字与其它字符）。这是上界：计数器或时间戳看上去和同样
 * 位数的随机数一样随机。Ollama 的 OpenAI 兼容 id（"chatcmpl-" 加一个小于 999 的数）约 10 比特；OpenAI、Anthropic 与本旁路自己的
 * id 都在 100 比特以上。
 * @param {string} id
 * @returns {number}  whole bits, 0 for an empty or non-string id / 整数比特数
 */
export function idEntropyBits(id) {
  if (typeof id !== 'string') return 0
  const rest = id.replace(/^[A-Za-z]+[-_]/, '').replace(/[-_]/g, '')
  if (!rest) return 0
  let size
  if (/^[0-9]+$/.test(rest)) size = 10
  else if (/^[0-9a-f]+$/.test(rest) || /^[0-9A-F]+$/.test(rest)) size = 16
  else size = (/[a-z]/.test(rest) ? 26 : 0) + (/[A-Z]/.test(rest) ? 26 : 0) + (/[0-9]/.test(rest) ? 10 : 0) + (/[^A-Za-z0-9]/.test(rest) ? 32 : 0)
  return Math.floor(rest.length * Math.log2(size))
}
// "1 hour", "15 min", "90 s": the receipt lifetime as the method's description states it. / 方法说明里的回执保留时长。
const lifetime = (ms) => (ms < 1000 ? `${ms} ms` : ms % 3_600_000 === 0 ? `${ms / 3_600_000} hour${ms === 3_600_000 ? '' : 's'}` : ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`)
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

// The one free method the sidecar adds: a receipt by response id (A2). Its manifest entry names `id` only, as TAP-21
// §3.5 fixes it; the optional `requestSha256` (§3.5, MAY) is accepted on the wire. The description states the lifetime.
// 旁路添加的唯一免费方法：按响应 id 取回执。清单条目只写 id（TAP-21 §3.5 规定如此）；可选的 requestSha256 在请求里接受。
// 说明里写明保留时长。
const RECEIPT_METHOD = Object.freeze({
  name: ai.RECEIPT_METHOD, priceBEM: '0', params: { id: 'string' },
  returns: { id: 'string', ok: 'boolean', result: 'object', container: 'string', ts: 'number', method: 'string', params: 'object', sig: 'string' },
})
const receiptDescription = (ttlMs) => `The signed usage receipt of an AI response, by the response id (kept for ${lifetime(ttlMs)} after the answer).`

// Caller headers that reach the upstream, verbatim: sdk ai.forwardsHeader decides (content-type, accept, the clients'
// identity and session headers such as user-agent, x-claude-code-session-id, session-id, x-codex-*, x-stainless-*, and
// each format's own auth, version and beta headers). Never a cookie, forwarded / x-forwarded-* / x-real-ip / cf-*, or a
// hop-by-hop header. / 能到达上游的调用方请求头由 ai.forwardsHeader 决定，原样转发；Cookie、转发与客户端地址头、逐跳头永不转发。
const FORWARD_BASE = ai.FORWARD_HEADERS
// Upstream response headers that are not passed on: hop-by-hop, those that describe the transfer rather than the body
// (fetch has already decoded it), cookies of the upstream's own domain, the upstream's CORS (ours replaces it), and any
// receipt header an upstream tries to set (ours replaces it).
// 不转交的上游响应头：逐跳头、描述传输而非正文的头（fetch 已解码）、上游自己域名的 Cookie、上游的 CORS、上游试图设置的回执头。
const DROP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authenticate',
  'proxy-authorization', 'content-encoding', 'content-length', 'set-cookie', 'set-cookie2', 'alt-svc', ai.RECEIPT_HEADER])
const EXPOSE_BASE = [ai.RECEIPT_HEADER, ai.SIDECAR_ERROR_HEADER, 'retry-after']
const TOKEN_LIST = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+(?:\s*,\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+)*$/
const NULL_BODY = new Set([101, 204, 205, 304])

// Errors of the sidecar itself, in the OpenAI error shape (the most widely read one). Unsigned: no upstream answer
// exists to bind. / 旁路自己的错误，按 OpenAI 的错误格式。未签名：没有可绑定的上游回答。
// Marked with x-tapeapi-sidecar-error: 1 (ai.SIDECAR_ERROR_HEADER), so a verifying client reports a transport failure
// rather than a failed receipt; the mark is informative and never makes an answer verified.
// 带 x-tapeapi-sidecar-error: 1，核验方据此报告传输失败而不是回执失败；该标记仅供参考，不会让回答变成已核验。
const errorResponse = (status, code, message, headers) => new Response(JSON.stringify({ error: { message, type: 'tapeapi_proxy_error', param: null, code } }), {
  status, headers: { 'content-type': 'application/json', [ai.SIDECAR_ERROR_HEADER]: '1', ...headers },
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
const goodId = ai.isAnswerId   // TAP-21 §3.5: the answer's id when it is 1 to 128 characters in U+0021–U+007E / 回答自己的 id
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
// A stream that ends quietly after `ms` without a chunk (the upstream is cancelled); `onIdle` is told.
// 超过 ms 没有新块时悄然结束的流（取消上游），并告知 onIdle。
function untilIdle(body, ms, onIdle) {
  const reader = body.getReader()
  return new ReadableStream({
    async pull(c) {
      let timer
      const idle = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms) })
      let got
      try { got = await Promise.race([reader.read(), idle]) } catch (e) { clearTimeout(timer); return c.error(e) }
      clearTimeout(timer)
      if (got === null) { onIdle(); reader.cancel().catch(() => {}); return c.close() }
      if (got.done) return c.close()
      c.enqueue(got.value)
    },
    cancel(reason) { return reader.cancel(reason) },
  }, { highWaterMark: 0 })
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
 * @param {number} [o.receiptTtlMs=3600000]  how long receipts stay retrievable; shorter narrows what a guessed id reaches
 *        (TAP-21 §3.5 recommends at least an hour) / 回执可取回的时长；越短，猜中的 id 能拿到的越少（规范建议至少一小时）
 * @param {number} [o.maxReceipts=50000]
 * @param {{ ip?: number, windowMs?: number }|false} [o.receiptRateLimit]  the `receipt` method's own budget per client IP
 *        (default 10 per 60 000 ms), answered with an unsigned 429 like every rate limit; false: off
 *        / receipt 方法自己的按 IP 预算（默认每分钟 10 次），超出回未签名的 429；false 关闭
 * @param {boolean} [o.forwardSessionHeaders=true]  pass the clients' session headers (ai.SESSION_HEADERS:
 *        x-claude-code-session-id, session-id, thread-id) upstream, as they are by default; false leaves them out, so
 *        the upstream cannot tie a caller's requests into one session by them (it still sees the caller's key)
 *        / 是否把客户端的会话头转发给上游（默认转发）；false 则不转发，上游无法凭它们把同一调用方的请求串成一段会话（仍看得到密钥）
 * @param {boolean} [o.requireRequestHash=false]  answer a `receipt` lookup only when it names `requestSha256` too
 *        (TAP-21 §3.5 MAY): a stranger who guesses an id does not have the hash. For an upstream with guessable ids.
 *        / 取回执时必须同时给出 requestSha256：猜中 id 的陌生人没有这个哈希。适用于 id 可猜的上游。
 * @param {string} [o.publicUrl]  the service root the endpoints are built on; default endpoints.live[0] without /tapeapi/v1
 * @param {boolean} [o.allowHttp]  http endpoints (local testing)
 * @param {number} [o.upstreamTimeoutMs=600000]
 * @param {number} [o.streamIdleMs=300000]  a stream silent this long is ended (0: never) / 流静默这么久即结束（0：不限）
 */
export function createAIProxy(opts = {}) {
  const { upstream, manifestBase, signerKey, models, receiptTtlMs = RECEIPT_TTL_MS, maxReceipts = MAX_RECEIPTS, formats = ai.FORMATS, requireRequestHash = false, forwardSessionHeaders = true } = opts
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
  if (typeof requireRequestHash !== 'boolean') throw new TapeAPIError('BAD_REQUEST', 'requireRequestHash must be true or false')
  if (typeof forwardSessionHeaders !== 'boolean') throw new TapeAPIError('BAD_REQUEST', 'forwardSessionHeaders must be true or false')
  const receiptRl = opts.receiptRateLimit === false ? null : {
    ip: Number(opts.receiptRateLimit?.ip ?? RECEIPT_LOOKUPS_PER_MIN),
    windowMs: Number(opts.receiptRateLimit?.windowMs ?? 60_000),
  }
  if (receiptRl && (!Number.isInteger(receiptRl.ip) || receiptRl.ip < 0 || !Number.isInteger(receiptRl.windowMs) || receiptRl.windowMs <= 0)) throw new TapeAPIError('BAD_REQUEST', 'receiptRateLimit must be false or { ip: a non-negative integer, windowMs: a positive integer }')
  if (!Array.isArray(formats) || !formats.length || !formats.every(validFormat)) throw new TapeAPIError('BAD_REQUEST', 'formats must be a non-empty list of adapters (see sdk ai.js)')
  if (new Set(formats.map((f) => f.method)).size !== formats.length || new Set(formats.map((f) => f.name)).size !== formats.length) throw new TapeAPIError('BAD_REQUEST', 'two formats share a name or a receipt method')
  const listOf = (k) => formats.flatMap((f) => (Array.isArray(f[k]) ? f[k].map((h) => String(h).toLowerCase()) : []))
  const forward = [...new Set([...FORWARD_BASE, ...listOf('headers')])]
  const allowHeaders = forward.join(', ')
  const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': [...new Set([...EXPOSE_BASE, ...listOf('exposeHeaders')])].join(', ') }
  const oaError = (status, code, message, extra = {}) => errorResponse(status, code, message, { ...CORS, ...extra })
  const timeoutMs = Number(opts.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TapeAPIError('BAD_REQUEST', 'upstreamTimeoutMs must be a positive number')
  const idleMs = Number(opts.streamIdleMs ?? STREAM_IDLE_MS)
  if (!Number.isFinite(idleMs) || idleMs < 0) throw new TapeAPIError('BAD_REQUEST', 'streamIdleMs must be 0 or a positive number')
  const signer = sig.privateKeyToAddress(signerKey)
  const log = opts.log || ((...a) => console.error('[tapeapi/ai-proxy]', ...a))
  const fetchImpl = opts.fetch || ((...a) => globalThis.fetch(...a))
  const label = up.origin + upPath
  // An operator key sent on every request means the sidecar serves anyone who reaches it with that key: it does no
  // authentication of its own. Said out loud. / 运营者密钥随每个请求发送，意味着任何能访问旁路的人都在用这把密钥：旁路自己不做鉴权。
  for (const k of ['authorization', 'x-api-key']) if (operatorHeaders.has(k)) log(`upstream.headers sets ${k}: every caller's request goes upstream with the operator's key (callers' own ${k} is replaced) and this sidecar authenticates no one; put your own gateway in front, or let callers' keys through`)
  if (receiptTtlMs < RECEIPT_TTL_MS) log(`receipts are kept for ${lifetime(receiptTtlMs)}, less than the hour TAP-21 §3.5 recommends: a client that looks one up later may find it gone (the copy delivered with each answer is unaffected)`)

  // ---- the manifest: one endpoint per format on the service root / 清单：每种格式一个端点，建在服务根上 ----
  const { tapeapi = '0.1', ...base } = manifestBase
  const live = base.endpoints?.live?.[0]
  const root = (opts.publicUrl ?? (typeof live === 'string' ? live.replace(/\/tapeapi\/v1\/*$/, '') : null))?.replace(/\/+$/, '')
  if (!root) throw new TapeAPIError('MANIFEST_INVALID', 'publicUrl is required when endpoints.live is empty')
  const field = ai.validateAIField({ endpoints: formats.map((f) => ({ format: f.name, baseUrl: root + f.baseSuffix })), models }, { allowHttp: opts.allowHttp === true || base.dev === true })
  const rootPath = new URL(root).pathname.replace(/\/+$/, '')
  const manifest = { tapeapi, ...base, signer, methods: [{ ...RECEIPT_METHOD, params: { ...RECEIPT_METHOD.params }, returns: { ...RECEIPT_METHOD.returns }, description: receiptDescription(receiptTtlMs) }], [ai.MANIFEST_FIELD]: field }
  const size = byteLength(JSON.stringify(manifest))
  if (size > MANIFEST_LIMIT) throw new TapeAPIError('MANIFEST_INVALID', `the manifest would be ${size} bytes, over TAP-20's ${MANIFEST_LIMIT}; shorten the price table`)
  if (size > CONSOLE_MANIFEST_LIMIT) log(`the manifest is ${size} bytes; the holder console publishes at most ${CONSOLE_MANIFEST_LIMIT} in one transaction`)

  const st = { requests: 0, receipts: 0, streams: 0, passThrough: 0, upstreamErrors: 0, upstreamFailures: 0, timeouts: 0, idleTimeouts: 0, tooLarge: 0, redirects: 0, rateLimited: 0, duplicateIds: 0, lookups: 0, misses: 0, usageInjected: 0, appended: 0, incomplete: 0, receiptRateLimited: 0, guessableIds: 0 }
  const unpriced = new Set()
  // The fewest bits an upstream id has shown (null until one is seen), and whether its ids look guessable: estimated
  // below ID_ENTROPY_MIN_BITS, or one id seen twice while its receipts are kept. Said once in the log.
  // 上游 id 出现过的最少比特（见到之前为 null），以及它的 id 是否像可猜的：估计低于 ID_ENTROPY_MIN_BITS，或同一 id 在回执保留期内
  // 出现两次。日志里只说一次。
  const ids = { minBits: null, guessable: false }
  function guessable(why) {
    if (ids.guessable) return
    ids.guessable = true
    log(`the upstream's response ids look guessable (${why}): anyone can walk through them with the free receipt method and read those receipts (model, usage, time and the two hashes). ${requireRequestHash ? 'requireRequestHash is on: a lookup must name the request hash too.' : 'Set requireRequestHash (RECEIPT_REQUIRE_HASH=1 in the Worker) so a lookup must name the request hash too, and consider a shorter receiptTtlMs.'}`)
  }
  function assessId(id) {
    const bits = idEntropyBits(id)
    if (ids.minBits === null || bits < ids.minBits) ids.minBits = bits
    if (bits < ID_ENTROPY_MIN_BITS) { st.guessableIds++; guessable(`about ${bits} bits in ${JSON.stringify(id.slice(0, 80))}`) }
  }

  // ---- the receipt store: insertion-ordered, bounded, each entry dated / 回执存储：按插入排序、有界、逐条带期限 ----
  // Keyed by (id, requestSha256): two answers that share an id (an upstream reusing ids, or ids drawn from a small set)
  // keep a receipt each. An id-only lookup gets the later one (TAP-21 §3.5); one that also names requestSha256 gets the
  // receipt of that request. The same id for the same request bytes is a replay: the later receipt replaces the earlier.
  // 按 (id, requestSha256) 存：共用一个 id 的两个回答（上游重复使用 id，或 id 取自很小的集合）各留一份回执。只给 id 的取回得到
  // 后一个；同时给出 requestSha256 的得到那个请求的回执。同一 id、同样的请求字节是重放：后一份替换前一份。
  const receipts = new Map()   // `${id}\n${requestSha256}` -> { env, exp }
  const byId = new Map()       // id -> Set of keys above, oldest first / id -> 上述键的集合，旧的在前
  const keyOf = (id, hash) => `${id}\n${hash}`
  function drop(k) {
    const e = receipts.get(k)
    if (!e) return
    receipts.delete(k)
    const set = byId.get(e.env.id)
    if (set) { set.delete(k); if (!set.size) byId.delete(e.env.id) }
  }
  function keep(env, upstreamId) {
    const t = Date.now()
    const k = keyOf(env.id, env.params.requestSha256)
    if (byId.has(env.id)) {
      // Two answers with one id: both are kept apart by their request hash; both were delivered inline.
      // 同一 id 的两个回答：按请求哈希分开保存；两者都已随回答送达。
      if (st.duplicateIds++ === 0) log(`the upstream reused response id ${env.id.slice(0, 80)}; each answer's receipt is kept under (id, requestSha256), and an id-only lookup serves the latest`)
      if (upstreamId) guessable(`the id ${JSON.stringify(env.id.slice(0, 80))} came twice within ${lifetime(receiptTtlMs)}`)
      drop(k)
    }
    receipts.set(k, { env, exp: t + receiptTtlMs })
    if (!byId.has(env.id)) byId.set(env.id, new Set())
    byId.get(env.id).add(k)
    for (const [key, v] of receipts) { if (v.exp > t && receipts.size <= maxReceipts) break; drop(key) }
  }
  function lookup(id, hash) {
    let k = null
    if (hash !== undefined) k = keyOf(id, hash)
    else { const set = byId.get(id); if (set) for (const x of set) k = x }   // the latest / 最新的
    const e = k === null ? undefined : receipts.get(k)
    if (!e) return null
    if (e.exp <= Date.now()) { drop(k); return null }
    return e.env
  }

  const provider = createProvider({
    manifest, signerKey, log,
    methods: {
      [ai.RECEIPT_METHOD]: async (params) => {
        st.lookups++
        const id = params?.id
        if (typeof id !== 'string' || !id || id.length > 256) throw new TapeAPIError('BAD_REQUEST', 'params.id must be the response id (the id of the answer, or of the receipt)')
        // TAP-21 §3.5: the optional requestSha256 picks the receipt of that request among answers that share the id.
        // 可选的 requestSha256 在共用 id 的回答里挑出那个请求的回执。
        const hash = params?.requestSha256
        if (hash !== undefined && (typeof hash !== 'string' || !HEX64_RE.test(hash))) throw new TapeAPIError('BAD_REQUEST', 'params.requestSha256, when given, must be 64 lowercase hex digits: the SHA-256 of the request body you sent')
        if (hash === undefined && requireRequestHash) throw new TapeAPIError('BAD_REQUEST', 'this service answers a receipt lookup only with params.requestSha256 as well (the SHA-256 of the request body you sent), since answer ids can be guessed')
        const env = lookup(id, hash)
        if (!env) { st.misses++; throw new TapeAPIError('BAD_REQUEST', `no receipt for ${id.slice(0, 128)}: receipts are kept for ${Math.round(receiptTtlMs / 60_000)} min, in this process only`) }
        return env
      },
    },
    ...(opts.rateLimit !== undefined ? { rateLimit: opts.rateLimit } : {}),
    ...(opts.allowHttp ? { allowHttp: true } : {}),
  })
  const container = provider.container

  // ---- signing / 签名 ----
  function resultOf({ format, read, requested, responseSha256, stream, status, usageInjected }) {
    const ok = status >= 200 && status < 300
    const model = typeof read.model === 'string' && read.model.length <= ai.MODEL_ID_MAX ? read.model : null
    // A failed call claims no usage, so it carries no price: the receipt makes the failure attributable, not billable.
    // 失败的调用不声称用量，也就没有价格：回执让失败可追责，而不是可计费。
    const u = ok ? ai.usageOf(read.usage) : null
    const p = ai.pricingOf(field.models, { reported: model, requested: typeof requested === 'string' && requested.length <= ai.MODEL_ID_MAX ? requested : null, usage: u, format: format.name })
    if (u && model !== null && !p.modelMatchedBy && !unpriced.has(model) && unpriced.size < UNPRICED_LOG_MAX) {
      unpriced.add(model)
      log(`the upstream reported model ${JSON.stringify(model.slice(0, 80))}, which is not priced for ${format.name}: its receipts carry prices null (add it to models as an id or an alias to price it)`)
    }
    const complete = ai.completeOf({ status, stream, read })
    if (!complete && ok) st.incomplete++
    const r = { model: p.model, usage: u, responseSha256, stream, complete, status, prices: p.prices }
    if (p.modelMatchedBy) r.modelMatchedBy = p.modelMatchedBy
    if (p.unpriced) r.unpriced = p.unpriced
    if (usageInjected) r.usageInjected = true
    return r
  }
  function signReceipt({ id, method, params, result }, upstreamId = false) {
    const ts = Math.floor(Date.now() / 1000)
    const env = { id, ok: true, result, container, ts, method, params }
    env.sig = sig.signResponse({ container, id, method, params, ok: true, body: result, ts }, signerKey)
    if (upstreamId) assessId(id)
    keep(env, upstreamId)
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
  function receiptStream({ format, params, status, strip, usageInjected, requested }) {
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
      const env = signReceipt({ id: goodId(r.id) ? r.id : newId(), method: format.method, params, result: resultOf({ format, read: r, requested, responseSha256: scanner.digest(), stream: true, status, usageInjected }) }, goodId(r.id))
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
  // Fixed window, bounded map; returns the seconds to wait when over budget, else 0. / 固定窗口、有界表；超出预算时返回需等待的秒数。
  function hit(buckets, key, budget, windowMs, max) {
    const t = Date.now()
    let b = buckets.get(key)
    if (!b || t >= b.reset) { b = { n: 0, reset: t + windowMs }; buckets.delete(key); buckets.set(key, b) }
    b.n++
    while (buckets.size > max) buckets.delete(buckets.keys().next().value)
    return b.n > budget ? Math.max(1, Math.ceil((b.reset - t) / 1000)) : 0
  }
  const buckets = new Map()
  const limited = (ip) => (!rl || !rl.budget ? 0 : hit(buckets, ip, rl.budget, rl.windowMs, rl.max))
  const receiptBuckets = new Map()
  const receiptLimited = (ip) => (!receiptRl ? 0 : hit(receiptBuckets, ip, receiptRl.ip, receiptRl.windowMs, rl?.max ?? 50_000))

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
    for (const [k, v] of request.headers) if (ai.forwardsHeader(k, formats) && (forwardSessionHeaders || !ai.isSessionHeader(k))) headers.set(k, v)
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
    let requested = null
    try { requested = typeof format.requestModel === 'function' ? format.requestModel(jsonOf(body ?? new Uint8Array(0))) : null } catch { /* not the adapter's JSON */ }
    // A stream only for a format that streams, answered as an event stream (the verifiers apply the same rule).
    // 只有会流式的格式、且以事件流作答时才按流处理（核验方用同一条规则）。
    const stream = !!format.stream && (res.headers.get('content-type') || '').toLowerCase().includes('text/event-stream') && !!res.body && !NULL_BODY.has(res.status)
    if (stream) {
      clearTimeout(timer); st.streams++
      const s = receiptStream({ format, params, status: res.status, strip: !!prepared?.strip, usageInjected: !!prepared, requested })
      const upBody = idleMs ? untilIdle(res.body, idleMs, () => { st.idleTimeouts++; log(`${path}: the upstream stream sent nothing for ${idleMs} ms; ended there`) }) : res.body
      return new Response(upBody.pipeThrough(s), { status: res.status, statusText: res.statusText, headers: out })
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
      result: resultOf({ format, read: r, requested, responseSha256: ai.sha256Hex(bytes), stream: false, status: res.status, usageInjected: !!prepared }),
    }, goodId(r.id))
    out.set(ai.RECEIPT_HEADER, ai.encodeReceipt(env))
    return new Response(NULL_BODY.has(res.status) ? null : bytes, { status: res.status, statusText: res.statusText, headers: out })
  }

  // The `receipt` method's own budget, checked before the provider reads the body, and refused like every rate limit:
  // an unsigned HTTP 429 with Retry-After and { ok: false, error: { code: RATE_LIMITED, data: { retryAfterS } } }
  // (TAP-21 §3.4). / receipt 方法自己的预算，在提供者读正文之前检查；超出时与所有限流一样回未签名的 429。
  const RECEIPT_PATH = `/tapeapi/v1/${ai.RECEIPT_METHOD}`
  function receiptRefusal(request, pathname, path, clientIp) {
    if (!receiptRl || request.method !== 'POST') return null
    if (pathname.replace(/\/+$/, '') !== RECEIPT_PATH && path?.replace(/\/+$/, '') !== RECEIPT_PATH) return null
    const wait = receiptLimited(clientIp || 'unknown')
    if (!wait) return null
    st.receiptRateLimited++
    return new Response(JSON.stringify({ ok: false, error: { code: 'RATE_LIMITED', message: `too many receipt lookups; retry in ${wait}s`, data: { retryAfterS: wait } } }), {
      status: 429, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'retry-after': String(wait) },
    })
  }

  async function handleRequest(request, { clientIp } = {}) {
    const pathname = new URL(request.url).pathname
    const path = ai.apiPath(pathname, rootPath)
    const refused = receiptRefusal(request, pathname, path, clientIp)
    if (refused) return refused
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
      ...st, idEntropyMinBits: ids.minBits, guessableIdsSeen: ids.guessable, requireRequestHash, forwardSessionHeaders, unpricedModels: [...unpriced], provider: provider.stats(),
    }),
  }
}
