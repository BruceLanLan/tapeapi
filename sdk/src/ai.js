// AI usage receipts (docs/PLAN-2026Q4.md, "A1/A2"): the rules both sides share. A signing sidecar in front of an AI API
// (@tapeapi/server/ai-proxy) signs every metered answer as a TAP-21 envelope; the client keeps the bytes it sent and
// received, hashes them the same way and checks the signature against the service's on-chain signer and the amounts
// against the manifest's price table. The hashing, the event-stream scanner, the price arithmetic, the receipt codec and
// the verifier live here, once, so the sidecar and every verifier compute exactly the same thing.
// AI 用量回执：两端共用的规则。签名旁路把每个计量的回答签成 TAP-21 信封；客户端保留自己发出和收到的字节，按同样的方法取哈希，
// 对照链上 signer 核验签名、对照清单价目表核验金额。哈希、事件流扫描、价格运算、回执编解码与核验都只在这里写一次。
//
// THE MANIFEST FIELD (manifest.ai, TAP-20 extension; validateAIField is normative):
//   { endpoints: [ { format, baseUrl } ],                                1..16, one per format, https (http in dev only)
//     models: [ { id, aliases?: [string] (<= 16), formats?: [format], prices: [ { currency, unit: "1M tokens", input,
//                 output, cacheRead?, cacheWrite?, cacheWrite1h?, reasoning? } ] } ] }                    1..256 models
//   `prices` holds 1..7 entries, one per currency, currencies unique among BEM, BNB, USDT, USDC, ETH, USD1, USD; every price
//   is a decimal string (at most 18 integer digits and 8 decimals) per 1M tokens. Every id and alias is 1..256 characters
//   without control characters and appears at most once in the whole table. `formats`, when given, names formats among the
//   endpoints and limits the entry to them.
//
// MODEL MATCHING: the entry used is the one whose `id` or one of whose `aliases` equals, exactly and case-sensitively,
//   the model the upstream REPORTED, among the entries allowed for the answer's format. Only when the upstream reported no
//   model is the model the REQUEST asked for (the format's requestModel) matched the same way; the receipt then carries
//   that requested model as `model` and says modelMatchedBy "request". No prefix matching, no case folding.
//
// USAGE, one convention for every format:
//   { prompt_tokens      ALL input tokens, cache reads and writes included
//     completion_tokens  ALL output tokens, reasoning included (0 when the format has none, e.g. embeddings)
//     total_tokens       as reported, else prompt + completion
//     cache_read_tokens?  cache_write_tokens?  cache_write_1h_tokens?  reasoning_tokens?     subsets, only when reported
//     other?: { name: count } }                          per-use counts above 0 (e.g. web_search_requests), sorted by name
//   Keys in exactly this order. cache_read + cache_write <= prompt, cache_write_1h <= cache_write, reasoning <= completion.
//
// AMOUNT, per currency entry, over disjoint buckets, per 1M tokens:
//     input × (prompt − cache_read − cache_write) + cacheRead × cache_read + cacheWrite × (cache_write − cache_write_1h)
//   + cacheWrite1h × cache_write_1h + output × (completion − reasoning) + reasoning × reasoning_tokens
//   cacheRead and cacheWrite default to input; cacheWrite1h to cacheWrite, then input; without `reasoning` the reasoning
//   tokens stay in output. Per-use counts (`other`) add 0 and are listed in `unpriced`. The sum is divided by 1 000 000 and
//   rounded UP once to 8 decimals; the amount is a string with exactly 8 decimals. Integer (BigInt) arithmetic only.
//
// THE RECEIPT: a TAP-21 envelope { id, ok: true, container, ts, method, params, result, sig } signed by the manifest's
//   signer, where method is the format's receipt method (openai_chat, openai_responses, anthropic_messages,
//   openai_embeddings), id is the answer's id (or one the sidecar generated when the answer has none), and
//     params = { path, requestSha256 }       the API path from the service root (no query), sha256 of the request body
//                                            bytes exactly as the client sent them
//     result = { model, usage, responseSha256, stream, complete, status, prices, modelMatchedBy?, unpriced?, usageInjected? }
//       model           the model the upstream reported, or the requested one when modelMatchedBy is "request"; null if none
//       usage           as above, or null (no usage reported, or status not 2xx)
//       responseSha256  see below
//       stream          whether the answer was an event stream (a streaming format answered with text/event-stream)
//       complete        true for a 2xx whole answer that is not itself marked unfinished, and for a stream that reached
//                       its format's final success event (Chat: a choice with a finish_reason and no error chunk;
//                       Responses: response.completed; Anthropic: message_stop and no error event); false otherwise.
//                       An incomplete answer is still priced from the usage it reported.
//       status          the upstream's HTTP status; a status outside 2xx carries usage null and prices null
//       prices          [ { currency, amount } ], one per entry of the matched model's `prices`, in the same order; null
//                       when no model matched or there is no usage
//       modelMatchedBy  "response" | "request", present exactly when a price-table entry matched
//       unpriced        the names in usage.other (billed per use, no token price), present only with prices
//       usageInjected   true when the sidecar asked the upstream for usage the client did not ask for (and removed
//                       from the client's copy what that request added)
//
// RESPONSE HASH (responseSha256). A whole answer: sha256 of the body bytes exactly as the client received them. An event
//   stream: parse the bytes the client received as server-sent events (WHATWG: lines end at CRLF, LF or CR; one leading
//   U+FEFF is skipped; lines starting with ":" are comments and ignored, which includes the receipt comment; a line
//   "field: value" drops one space after the colon; a line without a colon is a field with an empty value; the values
//   of all `data` fields of an event are joined with "\n"; an event is dispatched only at a blank line, and only if it
//   had a `data` field; an unfinished event at the end is discarded). For each dispatched event in order take its data
//   as UTF-8 bytes; leave out every event whose data is exactly the format's sentinel ("[DONE]" for Chat and Responses,
//   none for Anthropic); hash the concatenation of each remaining data followed by one "\n" byte. Event names, ids and
//   comments are not hashed.
//
// DELIVERY: a whole answer carries the receipt in the `x-tapeapi-receipt` header (base64url of the envelope JSON). A
//   stream carries it as one SSE comment block ": tapeapi-receipt <base64url>\n\n" inserted right before the format's
//   final event (data: [DONE], event: response.completed|incomplete|failed, event: message_stop); with no final event
//   the line ": tapeapi-receipt <base64url>\n" is appended at the end (after a line end when the stream stopped mid-line).
//   The free manifest method `receipt` returns a stored envelope by id for an hour.
// 清单字段、模型匹配、用量、金额、回执、响应哈希与送达规则见上（英文为准）。
//
// API formats are adapters, one small module each (ai-openai-chat.js, ai-openai-responses.js, ai-anthropic-messages.js,
// ai-openai-embeddings.js). Nothing in this file knows a vendor's JSON; it knows server-sent events, bytes, prices and
// signatures. An adapter is
//   { name, method, baseSuffix, match({ verb, path }), headers?, exposeHeaders?, requestModel(body),
//     stream: { framing: 'sse', sentinel, final: { event?: [...], data?: [...] } } | null,
//     prepareUpstream?(body) -> { body, strip } | null, isInjectedEvent?(json),
//     response(json) -> { id, model, usage, complete? },
//     streamState() -> { event(json, eventName), result() -> { id, model, usage, complete } } }
// - `name` is the format ('openai-chat'), `method` the receipt method ('openai_chat');
// - `path` is the API path from the service root ('/v1/chat/completions'); `baseSuffix` is what a client's base URL adds
//   to that root ('/v1' for OpenAI's SDKs, '' for Anthropic's);
// - `headers` are the caller headers the format needs upstream (its auth, its version and beta flags);
// - `sentinel` is a data payload left out of the hash; `final` names the stream's last event by its first line;
// - `prepareUpstream` may change the body sent upstream (e.g. to ask for usage); events it caused are stripped
//   (`isInjectedEvent`), so the client receives, and the hash covers, exactly what it asked for.
// API 格式是适配器（每种一个小模块）。本文件不认识任何厂商的 JSON，只认识 SSE、字节、价格与签名。
//
// Only leaf modules are imported, no node: imports: this file runs in Workers, browsers and Node.
// 只引用叶子模块、不引用 node:，可在 Workers、浏览器与 Node 中运行。
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { TapeAPIError } from './errors.js'
import { recoverResponseSigner } from './sig.js'
import { isAddress, eqAddr } from './abi.js'
import { toBase64Url, fromBase64Url } from './mcp.js'
import { openaiChat } from './ai-openai-chat.js'
import { openaiResponses } from './ai-openai-responses.js'
import { anthropicMessages } from './ai-anthropic-messages.js'
import { openaiEmbeddings } from './ai-openai-embeddings.js'

/**
 * The manifest field that carries { endpoints: [{ format, baseUrl }], models: [{ id, formats?, price }] } (TAP-20
 * extension A1). One constant, so a rename is one line. / 携带 AI 端点与价目表的清单字段。只有这一个常量，改名只改一行。
 */
export const MANIFEST_FIELD = 'ai'
/** Response header carrying a non-stream receipt. / 非流式回执所在的响应头。 */
export const RECEIPT_HEADER = 'x-tapeapi-receipt'
/** SSE comment that carries a stream's receipt (the line is `: tapeapi-receipt <base64url>`). / 流式回执所在的 SSE 注释。 */
export const SSE_RECEIPT_PREFIX = ': tapeapi-receipt '
/** Response header marking an error the sidecar made itself (no upstream answer, no receipt, no signature): a transport
 *  failure to the client. Informative: anyone on the path can set or strip it, so it never makes an answer verified.
 *  标记旁路自己产生的错误（没有上游回答、没有回执、没有签名）的响应头：对客户端是传输失败。仅供参考，不会让回答变成已核验。 */
export const SIDECAR_ERROR_HEADER = 'x-tapeapi-sidecar-error'
/** The free manifest method that returns a stored receipt by response id. / 按响应 id 取回回执的免费清单方法。 */
export const RECEIPT_METHOD = 'receipt'
export const PRICE_UNIT = '1M tokens'
/** BEM first (the network's token); BNB, USDT, USDC, ETH as BSC tokens; USD for display only. / 价目币种。 */
export const CURRENCIES = Object.freeze(['BEM', 'BNB', 'USDT', 'USDC', 'ETH', 'USD1', 'USD'])
export const MODELS_MAX = 256
export const MODEL_ID_MAX = 256
/** At most this many aliases per model entry. / 每个模型条目至多这么多别名。 */
export const ALIASES_MAX = 16
/** At most this many price entries (one per currency) per model. / 每个模型至多这么多价格条目（每币种一个）。 */
export const PRICES_MAX = 7
/** Prices carry at most, amounts exactly, this many decimals. / 价格至多、金额恰好这么多位小数。 */
export const AMOUNT_DECIMALS = 8
/** A decoded event's data is parsed as JSON (for the adapter) up to this size, the same bound as a whole non-stream
 *  answer (a final event such as response.completed repeats the whole output); larger events are hashed as they arrive
 *  and not parsed, so a usage inside one is not read. / 解码后的事件数据在此大小以内才按 JSON 解析（与整体回答上限相同：
 *  response.completed 这类最终事件会重复整个输出）；更大的事件边到边哈希、不解析，其中的 usage 读不到。 */
export const EVENT_PARSE_LIMIT = 16 * 1024 * 1024
export const ENDPOINTS_MAX = 16
/** The built-in formats. Gemini follows as a further adapter. / 内置格式。 */
export const FORMATS = Object.freeze([openaiChat, openaiResponses, anthropicMessages, openaiEmbeddings])

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const HEX64 = /^[0-9a-f]{64}$/
const SIG_RE = /^0x[0-9a-fA-F]{130}$/
const PRICE_RE = /^(0|[1-9]\d{0,17})(\.\d{1,8})?$/
const METHOD_RE = /^[a-z][a-z0-9_]{0,63}$/
const FORMAT_RE = /^[a-z][a-z0-9-]{0,63}$/
const PRICE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'reasoning']
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const enc = new TextEncoder()
const toBytes = (v) => (typeof v === 'string' ? enc.encode(v) : v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : null)
const NL = new Uint8Array([0x0a])

/** The adapter a request goes to, or null (then it passes through without a receipt). / 请求对应的适配器，没有则为 null。 */
export const formatFor = (verb, path, formats = FORMATS) => (typeof path === 'string' && formats.find((f) => f.match({ verb: String(verb).toUpperCase(), path }))) || null
/**
 * Caller headers a proxy passes upstream, verbatim: content-type and accept; the client's identity and session headers
 * (user-agent, x-app, x-claude-code-session-id, session-id, thread-id, originator, x-client-request-id,
 * anthropic-dangerous-direct-browser-access, every x-codex-* and x-stainless-*); and each format's own `headers` (auth,
 * version and beta flags). Never: cookies, forwarding and client-address headers (forwarded, x-forwarded-*, x-real-ip,
 * cf-*), hop-by-hop headers, host and content-length. One rule for the sidecar and tapeapi-verify.
 * 代理原样转发到上游的调用方请求头：content-type、accept；客户端身份与会话头；以及各格式自己声明的头。永不转发：Cookie、
 * 转发与客户端地址头、逐跳头、host 与 content-length。旁路与 tapeapi-verify 共用这一条规则。
 */
export const FORWARD_HEADERS = Object.freeze(['content-type', 'accept', 'user-agent', 'x-app', 'x-claude-code-session-id', 'session-id', 'thread-id', 'originator', 'x-client-request-id', 'anthropic-dangerous-direct-browser-access', 'content-encoding'])
export const FORWARD_PREFIXES = Object.freeze(['x-codex-', 'x-stainless-'])
/**
 * The session headers among those: they tie a caller's requests into one conversation for whoever receives them (Claude
 * Code's x-claude-code-session-id, Codex's session-id, thread-id). Forwarded by default, as the clients expect; the
 * sidecar (forwardSessionHeaders: false) and tapeapi-verify (--strip-session-headers) can leave them out.
 * 其中的会话头：把同一个调用方的请求串成一段对话。默认转发（客户端期望如此）；旁路与 tapeapi-verify 可以不转发。
 */
export const SESSION_HEADERS = Object.freeze(['x-claude-code-session-id', 'session-id', 'thread-id'])
/** Is this one of SESSION_HEADERS? / 是否为会话头。 */
export const isSessionHeader = (name) => SESSION_HEADERS.includes(String(name).toLowerCase())
const NEVER_FORWARD = new Set(['cookie', 'cookie2', 'forwarded', 'x-real-ip', 'host', 'content-length', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
/** Does a proxy pass this caller header upstream (for these formats)? / 代理是否把这个调用方请求头转发到上游？ */
export function forwardsHeader(name, formats = FORMATS) {
  const k = String(name).toLowerCase()
  if (NEVER_FORWARD.has(k) || k.startsWith('x-forwarded-') || k.startsWith('cf-')) return false
  return FORWARD_HEADERS.includes(k) || FORWARD_PREFIXES.some((p) => k.startsWith(p)) || formats.some((f) => Array.isArray(f.headers) && f.headers.some((h) => String(h).toLowerCase() === k))
}
/**
 * Is this an answer id a sidecar uses as the receipt id (TAP-21 §3.5: 1 to 128 characters in U+0021–U+007E)? Otherwise
 * the sidecar generates one, and a verifier does not compare them. / 旁路是否把它用作回执 id；否则旁路自己生成，核验方不比较。
 */
export const isAnswerId = (v) => typeof v === 'string' && /^[\x21-\x7e]{1,128}$/.test(v)
/** The adapter that signs receipts of `method`, or null. / 签发该方法回执的适配器。 */
export const formatOfMethod = (method, formats = FORMATS) => formats.find((f) => f.method === method) || null
/**
 * The API path a request names: its URL path with the service root's path taken off (the URL path '/relay/v1/messages'
 * under the root '/relay' names '/v1/messages'), or null when it is not under the root. One rule for the sidecar and the
 * verifiers. / 请求所指的 API 路径：URL 路径去掉服务根路径（根为 '/relay' 时，'/relay/v1/messages' 所指的是 '/v1/messages'）；
 * 不在根之下则为 null。旁路与核验方共用这一条规则。
 */
export function apiPath(pathname, rootPath) {
  const rp = String(rootPath).replace(/\/+$/, '')
  return typeof pathname === 'string' && pathname.startsWith(rp + '/') ? pathname.slice(rp.length) : null
}
/** The service root of an endpoint's baseUrl (the baseUrl minus the format's suffix), or null. / 端点 baseUrl 对应的服务根。 */
export function rootOf(baseUrl, format) {
  const b = String(baseUrl).replace(/\/+$/, ''), suf = format?.baseSuffix ?? ''
  if (!b.endsWith(suf)) return null
  return b.slice(0, b.length - suf.length)
}
/** The stream sentinel of a receipt method ('[DONE]' for openai_chat), null when it has none. / 回执方法的流结束标记。 */
export const sentinelOf = (method, formats = FORMATS) => formatOfMethod(method, formats)?.stream?.sentinel ?? null

// ---------------------------------------------------------------------------------------------------------------
// Hashing / 哈希
// ---------------------------------------------------------------------------------------------------------------
/** sha256 of bytes (a string is hashed as UTF-8), lowercase hex without 0x. / 字节的 sha256，小写十六进制、无 0x。 */
export function sha256Hex(data) {
  const b = toBytes(data ?? new Uint8Array(0))
  if (!b) throw new TapeAPIError('BAD_REQUEST', 'sha256Hex takes bytes or a string')
  return bytesToHex(sha256(b))
}

const same = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true }

/**
 * A stream's responseSha256 from its data payloads, in order: sha256 of each payload followed by one "\n", every event
 * whose data is exactly the format's sentinel left out. Strings are UTF-8.
 * 按顺序拼接每个 data 载荷并各加一个 "\n"（数据恰为结束标记的事件除外），取 sha256。
 * @param {Array<string|Uint8Array>} payloads
 * @param {{ sentinel?: string|null }} [o]  e.g. '[DONE]' (sentinelOf(method)) / 例如 '[DONE]'
 */
export function sseDigestOfPayloads(payloads, { sentinel = null } = {}) {
  if (!Array.isArray(payloads)) throw new TapeAPIError('BAD_REQUEST', 'payloads must be an array')
  const end = sentinel == null ? null : enc.encode(sentinel)
  const h = sha256.create()
  for (const p of payloads) {
    const b = toBytes(p)
    if (!b) throw new TapeAPIError('BAD_REQUEST', 'each payload must be a string or bytes')
    if (end && same(b, end)) continue
    h.update(b); h.update(NL)
  }
  return bytesToHex(h.digest())
}

/**
 * An incremental, byte-level parser of a server-sent event stream (the WHATWG rules: LF, CR or CRLF line ends, a CR at a
 * chunk end waits for a possible LF, one leading U+FEFF skipped, comment lines ignored, `data` lines joined with "\n",
 * an event dispatched on a blank line only, an unfinished event at the end discarded). It hashes each dispatched event's
 * data by the receipt rule, hands each event's JSON to `onEvent(json, eventName)` (an adapter's streamState), and
 * collects `: tapeapi-receipt` comments. Memory is O(1) in the stream's length: an event larger than eventParseLimit is
 * hashed as it arrives and not parsed. Vendor-neutral: the proxy and every verifier run this same code.
 * 增量的、字节级的 SSE 解析器（WHATWG 规则）。按回执规则对每个已分派事件的数据取哈希，把每个事件的 JSON 交给 onEvent
 * （适配器的 streamState），并收集 `: tapeapi-receipt` 注释。内存与流长无关。与厂商无关：旁路与各核验方运行同一份代码。
 * @param {{ sentinel?: string|null, onEvent?: (json: any, eventName: string) => void, eventParseLimit?: number }} [o]
 */
export function createSseScanner({ sentinel = null, onEvent, eventParseLimit = EVENT_PARSE_LIMIT } = {}) {
  const LF = 0x0a, CR = 0x0d, COLON = 0x3a, SPACE = 0x20
  const COMMENT_LIMIT = 64 * 1024
  const RECEIPTS_MAX = 16
  const BOM = [0xef, 0xbb, 0xbf]
  const end = sentinel == null ? null : enc.encode(sentinel)
  const hash = sha256.create()
  const info = { events: 0, done: false, receipts: [] }
  let bomMatched = 0, bomDone = false
  let lastCR = false
  // the line / 当前行
  let lineLen = 0, comment = false, commentParts = [], commentLen = 0, colon = false, field = [], fieldLen = 0, fieldOver = false
  let isData = false, isEvent = false, eventParts = [], eventLen = 0, skipSpace = false
  // the event / 当前事件
  let evData = false, evFields = false, evName = '', pieces = [], size = 0, over = false

  const concat = (parts, n) => { const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length } return out }
  const fieldName = () => (fieldOver ? null : String.fromCharCode(...concat(field, fieldLen)))
  function appendData(b) {
    if (over) { hash.update(b); return }
    if (size + b.length > eventParseLimit) {
      over = true
      for (const p of pieces) hash.update(p)
      pieces = []; size = 0
      hash.update(b)
      return
    }
    pieces.push(b.slice()); size += b.length
  }
  function startDataLine() { if (evData) appendData(NL); evData = true }
  function dispatch() {
    if (evData) {
      if (over) { hash.update(NL); info.events++ } else {
        const data = concat(pieces, size)
        if (end && same(data, end)) info.done = true
        else {
          hash.update(data); hash.update(NL); info.events++
          if (onEvent) { let v; try { v = JSON.parse(new TextDecoder().decode(data)) } catch { v = undefined } if (v !== undefined) onEvent(v, evName) }
        }
      }
    }
    evData = false; evFields = false; evName = ''; pieces = []; size = 0; over = false
  }
  function value(b) {
    if (skipSpace && b.length) { skipSpace = false; if (b[0] === SPACE) b = b.subarray(1) }
    if (!b.length) return
    if (isData) appendData(b)
    else if (isEvent && eventLen < 256) { const t = b.subarray(0, 256 - eventLen); eventParts.push(t.slice()); eventLen += t.length }
  }
  function lineBytes(b) {
    if (lineLen === 0) comment = b[0] === COLON
    lineLen += b.length
    if (comment) {
      if (commentLen < COMMENT_LIMIT) { const take = b.subarray(0, COMMENT_LIMIT - commentLen); commentParts.push(take.slice()); commentLen += take.length }
      return
    }
    if (!colon) {
      const k = b.indexOf(COLON)
      const head = k < 0 ? b : b.subarray(0, k)
      if (!fieldOver) { if (fieldLen + head.length > 8) fieldOver = true; else { field.push(head.slice()); fieldLen += head.length } }
      if (k < 0) return
      colon = true
      const name = fieldName()
      isData = name === 'data'; isEvent = name === 'event'
      if (isData) startDataLine()
      skipSpace = true
      b = b.subarray(k + 1)
    }
    value(b)
  }
  function endLine() {
    if (lineLen === 0) dispatch()
    else if (comment) {
      if (commentLen < COMMENT_LIMIT && info.receipts.length < RECEIPTS_MAX) {
        const m = /^: ?tapeapi-receipt ([A-Za-z0-9_-]+)$/.exec(new TextDecoder().decode(concat(commentParts, commentLen)))
        if (m) info.receipts.push(m[1])
      }
    } else {
      evFields = true
      const name = colon ? null : fieldName()
      if (name === 'data') startDataLine()
      if (isEvent || name === 'event') evName = new TextDecoder().decode(concat(eventParts, eventLen))
    }
    lineLen = 0; comment = false; commentParts = []; commentLen = 0; colon = false; field = []; fieldLen = 0; fieldOver = false
    isData = false; isEvent = false; eventParts = []; eventLen = 0; skipSpace = false
  }
  function scan(chunk, i) {
    const n = chunk.length
    if (lastCR && i < n) { if (chunk[i] === LF) i++; lastCR = false }
    // Next CR / LF positions, cached so a chunk of many lines is scanned once, not once per line.
    // 缓存下一个 CR / LF 的位置：多行的块只扫描一遍，而不是每行扫一遍。
    let nextLF = -2, nextCR = -2
    while (i < n) {
      if (nextLF !== -1 && nextLF < i) nextLF = chunk.indexOf(LF, i)
      if (nextCR !== -1 && nextCR < i) nextCR = chunk.indexOf(CR, i)
      const j = nextLF < 0 ? (nextCR < 0 ? n : nextCR) : nextCR < 0 ? nextLF : Math.min(nextLF, nextCR)
      if (j > i) lineBytes(chunk.subarray(i, j))
      if (j === n) break
      endLine()
      let k = j + 1
      if (chunk[j] === CR) { if (k < n) { if (chunk[k] === LF) k++ } else lastCR = true }
      i = k
    }
  }
  function push(chunk) {
    const b = toBytes(chunk)
    if (!b) throw new TapeAPIError('BAD_REQUEST', 'push takes bytes')
    let i = 0
    if (!bomDone) {
      while (i < b.length && bomMatched < 3 && b[i] === BOM[bomMatched]) { bomMatched++; i++ }
      if (bomMatched === 3) bomDone = true
      else if (i < b.length) { bomDone = true; if (bomMatched) scan(Uint8Array.from(BOM.slice(0, bomMatched)), 0) }
      else return
    }
    scan(b, i)
  }
  function finish() { if (!bomDone && bomMatched) { bomDone = true; scan(Uint8Array.from(BOM.slice(0, bomMatched)), 0) } }
  return {
    push, end: finish, info,
    /** The receipt hash of the events dispatched so far. / 到目前为止已分派事件的回执哈希。 */
    digest: () => bytesToHex(hash.clone().digest()),
    /** Where the parser stands, for a writer that must insert a line at an event boundary. / 解析位置，供需要在事件边界插入行的写入方使用。 */
    state: () => ({ atLineStart: lineLen === 0, pendingCR: lastCR, eventHasData: evData, eventHasFields: evFields }),
  }
}

/**
 * A whole event stream at once: its receipt hash, what the adapter read from it (when `format` is given), and its
 * receipt comments. / 一次处理整段事件流：回执哈希、适配器读出的内容（给了 format 时）与回执注释。
 * @param {Uint8Array|ArrayBuffer|string} body
 * @param {{ format?: object, sentinel?: string|null }} [o]  the adapter (its sentinel and streamState), or just a sentinel
 */
export function scanSse(body, { format, sentinel } = {}) {
  const b = toBytes(body)
  if (!b) throw new TapeAPIError('BAD_REQUEST', 'scanSse takes bytes or a string')
  const st = format?.streamState ? format.streamState() : null
  const s = createSseScanner({ sentinel: sentinel !== undefined ? sentinel : format?.stream?.sentinel ?? null, onEvent: st ? (j, n) => st.event(j, n) : undefined })
  s.push(b); s.end()
  const read = st ? st.result() : { id: null, model: null, usage: null, complete: false }
  return { responseSha256: s.digest(), id: read.id ?? null, model: read.model ?? null, usage: usageOf(read.usage), complete: read.complete === true, events: s.info.events, done: s.info.done, receipts: s.info.receipts.slice() }
}

// ---------------------------------------------------------------------------------------------------------------
// Usage and price / 用量与价格
// ---------------------------------------------------------------------------------------------------------------
const safeCount = (n) => Number.isSafeInteger(n) && n >= 0
const given = (v) => v !== undefined && v !== null
const USAGE_SUBSETS = ['cache_read_tokens', 'cache_write_tokens', 'cache_write_1h_tokens', 'reasoning_tokens']
/**
 * Counts an adapter read -> the receipt's usage, in a fixed key order: { prompt_tokens, completion_tokens, total_tokens,
 * cache_read_tokens?, cache_write_tokens?, cache_write_1h_tokens?, reasoning_tokens?, other? }, or null when they do not
 * say how many prompt tokens or do not add up (cache reads plus writes above prompt_tokens, 1-hour cache writes above
 * cache writes, reasoning above completion_tokens). completion_tokens defaults to 0 (embeddings have none) and
 * total_tokens to prompt + completion. `other` keeps the per-use counts above zero, sorted by name.
 * 适配器读出的计数 -> 回执的 usage（键顺序固定）；没有 prompt_tokens 或数目对不上时为 null。
 */
export function usageOf(u) {
  if (!isObj(u) || !safeCount(u.prompt_tokens)) return null
  const completion = given(u.completion_tokens) ? u.completion_tokens : 0
  if (!safeCount(completion)) return null
  const total = given(u.total_tokens) ? u.total_tokens : u.prompt_tokens + completion
  if (!safeCount(total)) return null
  const out = { prompt_tokens: u.prompt_tokens, completion_tokens: completion, total_tokens: total }
  for (const k of USAGE_SUBSETS) {
    if (!given(u[k])) continue
    if (!safeCount(u[k])) return null
    out[k] = u[k]
  }
  if ((out.cache_read_tokens ?? 0) + (out.cache_write_tokens ?? 0) > out.prompt_tokens || (out.cache_write_1h_tokens ?? 0) > (out.cache_write_tokens ?? 0) ||
    (out.reasoning_tokens ?? 0) > out.completion_tokens) return null
  if (given(u.other)) {
    if (!isObj(u.other)) return null
    const o = Object.entries(u.other).filter(([k, v]) => METHOD_RE.test(k) && safeCount(v) && v > 0).sort(([a], [b]) => (a < b ? -1 : 1))
    if (o.length) out.other = Object.fromEntries(o)
  }
  return out
}

const SCALE = 10n ** BigInt(AMOUNT_DECIMALS)
const PER = 1_000_000n   // prices are per 1M tokens / 价格按每百万 token
function units(price) {
  const [i, f = ''] = price.split('.')
  return BigInt(i) * SCALE + BigInt((f + '0'.repeat(AMOUNT_DECIMALS)).slice(0, AMOUNT_DECIMALS))
}
function formatAmount(u) { const s = u.toString().padStart(AMOUNT_DECIMALS + 1, '0'); return `${s.slice(0, -AMOUNT_DECIMALS)}.${s.slice(-AMOUNT_DECIMALS)}` }

/**
 * The amount for one call in one currency, per 1M tokens, over disjoint buckets:
 *   input × (prompt − cache_read − cache_write) + cacheRead × cache_read + cacheWrite × (cache_write − cache_write_1h)
 *   + cacheWrite1h × cache_write_1h + output × (completion − reasoning) + reasoning × reasoning_tokens
 * cacheRead and cacheWrite fall back to `input`, cacheWrite1h to cacheWrite and then `input`; without a `reasoning` price,
 * reasoning tokens stay in output. Per-use counts (`other`) have no token price and add 0. Divided by 1 000 000 and rounded
 * UP once, on the sum, to 8 decimals; exactly 8 decimals out. BigInt only: no floating point.
 * 一次调用在一个币种下的金额（每百万 token 计价，分桶互不重叠）。缓存读写价缺省按 input，1 小时缓存写缺省按 cacheWrite 再按
 * input；没有 reasoning 价时推理 token 计入 output；按次计费的计数计 0。对总和向上取整一次到 8 位小数。只用 BigInt。
 * @param {{ input: string, output: string, cacheRead?: string, cacheWrite?: string, cacheWrite1h?: string, reasoning?: string }} price
 */
export function amountOf(price, usage) {
  const dec = (v) => typeof v === 'string' && PRICE_RE.test(v)
  if (!isObj(price) || !dec(price.input) || !dec(price.output) || PRICE_KEYS.some((k) => given(price[k]) && !dec(price[k]))) throw new TapeAPIError('BAD_REQUEST', 'prices must be decimal strings')
  const u = usageOf(usage)
  if (!u) throw new TapeAPIError('BAD_REQUEST', 'usage needs prompt_tokens')
  const cr = BigInt(u.cache_read_tokens ?? 0), cw = BigInt(u.cache_write_tokens ?? 0), cw1h = BigInt(u.cache_write_1h_tokens ?? 0)
  const rs = given(price.reasoning) ? BigInt(u.reasoning_tokens ?? 0) : 0n
  const cacheWrite = given(price.cacheWrite) ? price.cacheWrite : price.input
  const num = (BigInt(u.prompt_tokens) - cr - cw) * units(price.input)
    + cr * units(given(price.cacheRead) ? price.cacheRead : price.input)
    + (cw - cw1h) * units(cacheWrite)
    + cw1h * units(given(price.cacheWrite1h) ? price.cacheWrite1h : cacheWrite)
    + (BigInt(u.completion_tokens) - rs) * units(price.output)
    + (given(price.reasoning) ? rs * units(price.reasoning) : 0n)
  return formatAmount((num + PER - 1n) / PER)
}

/**
 * The price-table entry for a model id: the one whose `id` or one of whose `aliases` equals it exactly (case-sensitive),
 * among the entries allowed for `format` (no `formats`, or `formats` listing it); null when none. No prefix matching.
 * 某个模型 id 对应的价目表条目：id 或某个别名与之精确相等（区分大小写），且允许用于该格式；没有则为 null。不做前缀匹配。
 */
export function modelEntryOf(models, model, format) {
  if (typeof model !== 'string' || !model || !Array.isArray(models)) return null
  return models.find((m) => isObj(m) && (m.id === model || (Array.isArray(m.aliases) && m.aliases.includes(model))) && (!Array.isArray(m.formats) || format === undefined || m.formats.includes(format))) || null
}

/** The `prices` of a receipt for a matched entry and a usage: [{ currency, amount }] in the entry's order. / 回执的 prices。 */
export function pricesOf(entry, usage) {
  if (!isObj(entry) || !Array.isArray(entry.prices)) return null
  const u = usageOf(usage)
  if (!u) return null
  return entry.prices.map((p) => ({ currency: p.currency, amount: amountOf(p, u) }))
}

/**
 * Everything price-related a receipt carries, from what the upstream reported and what the request asked for:
 *   { model, prices, modelMatchedBy?, unpriced? }
 * The reported model is matched first; only when the upstream reported none is the requested model matched, and then it
 * becomes the receipt's `model` with modelMatchedBy "request". `prices` is null when no entry matched or there is no
 * usage; `modelMatchedBy` is present exactly when an entry matched; `unpriced` lists usage.other's names, with prices.
 * 回执里与价格有关的全部内容：先匹配上游报告的模型；上游没报时才匹配请求的模型，此时它成为回执的 model，modelMatchedBy 为
 * "request"。没匹配到条目或没有 usage 时 prices 为 null；匹配到条目时才有 modelMatchedBy；有 prices 时 unpriced 列出按次计费项。
 */
export function pricingOf(models, { reported = null, requested = null, usage = null, format } = {}) {
  const rep = typeof reported === 'string' && reported ? reported : null
  let model = rep, by = null, entry = null
  if (rep) { entry = modelEntryOf(models, rep, format); if (entry) by = 'response' }
  else if (typeof requested === 'string' && requested) { entry = modelEntryOf(models, requested, format); if (entry) { model = requested; by = 'request' } }
  const out = { model, prices: entry ? pricesOf(entry, usage) : null }
  if (by) out.modelMatchedBy = by
  const u = usageOf(usage)
  if (out.prices && u?.other) out.unpriced = Object.keys(u.other)
  return out
}

/**
 * Validate a manifest's AI field (manifest[MANIFEST_FIELD], TAP-20 extension) and return a normalised copy (only the
 * known keys, in a fixed order). See the header of this file for the shape. Unknown format names are accepted (a later
 * adapter may know them). Throws MANIFEST_INVALID.
 * 校验清单的 AI 字段并返回规范化副本（只保留已知键，顺序固定）；不合规抛 MANIFEST_INVALID。
 * @param {unknown} o
 * @param {{ allowHttp?: boolean }} [opts]
 */
export function validateAIField(o, { allowHttp = false } = {}) {
  const fail = (m) => { throw new TapeAPIError('MANIFEST_INVALID', `${MANIFEST_FIELD}: ${m}`) }
  if (!isObj(o)) fail('must be an object')
  if (!Array.isArray(o.endpoints) || o.endpoints.length < 1 || o.endpoints.length > ENDPOINTS_MAX) fail(`endpoints must hold 1 to ${ENDPOINTS_MAX} entries`)
  const names = new Set()
  const endpoints = o.endpoints.map((e, i) => {
    if (!isObj(e) || typeof e.format !== 'string' || !FORMAT_RE.test(e.format)) fail(`endpoints[${i}].format must be a format name`)
    if (names.has(e.format)) fail(`format ${e.format} appears twice`)
    names.add(e.format)
    if (typeof e.baseUrl !== 'string') fail(`endpoints[${i}].baseUrl must be a URL`)
    let url
    try { url = new URL(e.baseUrl) } catch { fail(`endpoints[${i}].baseUrl must be a URL`) }
    if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) fail(`endpoints[${i}].baseUrl must be https (http only in dev)`)
    if (url.search || url.hash || url.username || url.password) fail(`endpoints[${i}].baseUrl must not carry a query, fragment or credentials`)
    return { format: e.format, baseUrl: url.href.replace(/\/+$/, '') }
  })
  if (!Array.isArray(o.models) || o.models.length < 1 || o.models.length > MODELS_MAX) fail(`models must hold 1 to ${MODELS_MAX} entries`)
  const seen = new Set()
  const goodId = (v) => typeof v === 'string' && v.length >= 1 && v.length <= MODEL_ID_MAX && !CONTROL.test(v)
  const claim = (v, what) => { if (seen.has(v)) fail(`${what} ${v.slice(0, 64)} appears twice in the table (ids and aliases must be unique)`); seen.add(v) }
  const models = o.models.map((m, i) => {
    if (!isObj(m)) fail(`models[${i}] must be an object`)
    if (!goodId(m.id)) fail(`models[${i}].id must be 1 to ${MODEL_ID_MAX} characters, no control characters`)
    claim(m.id, 'model')
    const out = { id: m.id }
    if (m.aliases !== undefined) {
      if (!Array.isArray(m.aliases) || m.aliases.length < 1 || m.aliases.length > ALIASES_MAX || !m.aliases.every(goodId)) fail(`models[${i}].aliases must list 1 to ${ALIASES_MAX} model ids`)
      for (const a of m.aliases) claim(a, 'alias')
      out.aliases = [...m.aliases]
    }
    if (m.formats !== undefined) {
      if (!Array.isArray(m.formats) || !m.formats.length || !m.formats.every((f) => typeof f === 'string' && names.has(f)) || new Set(m.formats).size !== m.formats.length) fail(`models[${i}].formats must list formats among the endpoints`)
      out.formats = [...m.formats]
    }
    if (m.price !== undefined) fail(`models[${i}].price is not a field: use prices, a list with one entry per currency`)
    if (!Array.isArray(m.prices) || m.prices.length < 1 || m.prices.length > PRICES_MAX) fail(`models[${i}].prices must hold 1 to ${PRICES_MAX} entries, one per currency`)
    const currencies = new Set()
    out.prices = m.prices.map((p, j) => {
      const at = `models[${i}].prices[${j}]`
      if (!isObj(p)) fail(`${at} must be an object`)
      if (!CURRENCIES.includes(p.currency)) fail(`${at}.currency must be one of ${CURRENCIES.join(', ')}`)
      if (currencies.has(p.currency)) fail(`${at}: currency ${p.currency} appears twice`)
      currencies.add(p.currency)
      if (p.unit !== PRICE_UNIT) fail(`${at}.unit must be "${PRICE_UNIT}"`)
      const price = { currency: p.currency, unit: PRICE_UNIT }
      for (const k of PRICE_KEYS) {
        if (!given(p[k])) { if (k === 'input' || k === 'output') fail(`${at}.${k} is required`); continue }
        if (typeof p[k] !== 'string' || !PRICE_RE.test(p[k])) fail(`${at}.${k} must be a decimal string with at most ${AMOUNT_DECIMALS} decimals`)
        price[k] = p[k]
      }
      return price
    })
    return out
  })
  return { endpoints, models }
}

// ---------------------------------------------------------------------------------------------------------------
// Receipt codec / 回执编解码
// ---------------------------------------------------------------------------------------------------------------
/** envelope -> base64url of its JSON (the header value and the SSE comment's payload). / 信封 -> 其 JSON 的 base64url。 */
export const encodeReceipt = (envelope) => toBase64Url(JSON.stringify(envelope))
/** The SSE comment line carrying an envelope, without its line end. / 携带信封的 SSE 注释行（不含行尾）。 */
export const receiptComment = (envelope) => SSE_RECEIPT_PREFIX + encodeReceipt(envelope)

/** `x-tapeapi-receipt` header value -> envelope object. Throws BAD_REQUEST. / 响应头的值 -> 信封对象。 */
export function decodeReceiptHeader(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TapeAPIError('BAD_REQUEST', 'no receipt')
  if (value.length > 256 * 1024) throw new TapeAPIError('BAD_REQUEST', 'receipt too large')
  let v
  try { v = JSON.parse(fromBase64Url(value.trim())) } catch { throw new TapeAPIError('BAD_REQUEST', 'the receipt is not base64url JSON') }
  if (!isObj(v)) throw new TapeAPIError('BAD_REQUEST', 'the receipt is not a JSON object')
  return v
}

/**
 * The receipt in an event-stream text (the last `: tapeapi-receipt` comment), as an envelope object, or null when there
 * is none. A stream that passed through two sidecars carries two; the outer one is last.
 * 事件流文本里的回执（最后一个 `: tapeapi-receipt` 注释），没有则为 null。经过两层旁路的流带两个，外层的在最后。
 */
export function readSseReceipt(text) {
  const all = scanSse(typeof text === 'string' ? text : toBytes(text) ?? '').receipts
  return all.length ? decodeReceiptHeader(all[all.length - 1]) : null
}

// ---------------------------------------------------------------------------------------------------------------
// Verification / 核验
// ---------------------------------------------------------------------------------------------------------------
const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const jsonOf = (bytes) => { try { return JSON.parse(new TextDecoder().decode(bytes)) } catch { return undefined } }
const AMOUNT_RE = /^\d+\.\d{8}$/

/**
 * Is the answer complete? A whole answer: a 2xx status and the adapter does not mark it unfinished. A stream: a 2xx
 * status and the adapter saw the format's final success event. / 回答是否完整：整体回答为 2xx 且适配器未标记为未完成；流为 2xx
 * 且适配器看到了格式的最终成功事件。
 */
export function completeOf({ status, stream, read }) {
  if (!(status >= 200 && status < 300)) return false
  return stream ? read?.complete === true : read?.complete !== false
}

/** The shape problems of a usage-receipt envelope ([] when it is well-formed). / 用量回执信封的结构问题（合规为 []）。 */
export function envelopeProblems(env) {
  const p = []
  if (!isObj(env)) return ['the receipt is not an object']
  if (typeof env.id !== 'string' || !env.id || env.id.length > 128) p.push('id must be a string of 1 to 128 characters')
  if (env.ok !== true) p.push('ok must be true')
  if (typeof env.method !== 'string' || !METHOD_RE.test(env.method)) p.push('method must be a receipt method name')
  if (!isObj(env.params) || typeof env.params.path !== 'string' || typeof env.params.requestSha256 !== 'string' || !HEX64.test(env.params.requestSha256)) p.push('params must be { path, requestSha256 (64 hex) }')
  if (typeof env.container !== 'string' || !isAddress(env.container)) p.push('container must be an address')
  if (!Number.isSafeInteger(env.ts) || env.ts < 0) p.push('ts must be a unix time')
  if (typeof env.sig !== 'string' || !SIG_RE.test(env.sig)) p.push('sig must be 65 bytes of hex')
  const r = env.result
  if (!isObj(r)) { p.push('result must be an object'); return p }
  if (r.model !== null && typeof r.model !== 'string') p.push('result.model must be a string or null')
  if (r.usage !== null && !(isObj(r.usage) && sameJSON(usageOf(r.usage), r.usage))) p.push('result.usage must be { prompt_tokens, completion_tokens, total_tokens, cache_read_tokens?, cache_write_tokens?, cache_write_1h_tokens?, reasoning_tokens?, other? } in that order, or null')
  if (typeof r.responseSha256 !== 'string' || !HEX64.test(r.responseSha256)) p.push('result.responseSha256 must be 64 hex')
  if (typeof r.stream !== 'boolean') p.push('result.stream must be a boolean')
  if (typeof r.complete !== 'boolean') p.push('result.complete must be a boolean')
  if (!(Number.isInteger(r.status) && r.status >= 100 && r.status <= 599)) p.push('result.status must be an HTTP status')
  if (r.prices !== null) {
    const ok = Array.isArray(r.prices) && r.prices.length >= 1 && r.prices.length <= PRICES_MAX &&
      r.prices.every((x) => isObj(x) && Object.keys(x).join() === 'currency,amount' && CURRENCIES.includes(x.currency) && typeof x.amount === 'string' && AMOUNT_RE.test(x.amount)) &&
      new Set(r.prices.map((x) => x.currency)).size === r.prices.length
    if (!ok) p.push(`result.prices must be null or 1 to ${PRICES_MAX} entries { currency, amount (8 decimals) }, currencies unique`)
    else if (r.usage === null) p.push('result.prices needs a usage')
  }
  if (r.modelMatchedBy !== undefined && r.modelMatchedBy !== 'response' && r.modelMatchedBy !== 'request') p.push('result.modelMatchedBy must be "response" or "request" when present')
  if (r.prices !== null && r.modelMatchedBy === undefined) p.push('result.prices needs modelMatchedBy')
  if (r.modelMatchedBy !== undefined && typeof r.model !== 'string') p.push('result.modelMatchedBy needs a model')
  if (r.unpriced !== undefined && !(Array.isArray(r.unpriced) && r.unpriced.length && r.unpriced.every((k) => typeof k === 'string' && METHOD_RE.test(k)) && r.prices !== null)) p.push('result.unpriced must be a non-empty list of names, only with prices')
  if (r.usageInjected !== undefined && r.usageInjected !== true) p.push('result.usageInjected must be true when present')
  if (!(r.status >= 200 && r.status < 300) && (r.usage !== null || r.prices !== null)) p.push('a failed call (status outside 2xx) carries usage null and prices null')
  return p
}

const showPrices = (ps) => (ps ? ps.map((x) => `${x.amount} ${x.currency}`).join(' / ') : 'nothing')
/**
 * Are the receipt's prices what the manifest's table says for the model and usage it reports? [] when they are.
 * 回执的价格是否就是清单价目表对它所报 model 与 usage 给出的价格？一致则为 []。
 * @param {{ models: Array<object> }} field  manifest[MANIFEST_FIELD]
 * @param {object} result  the receipt's result / 回执的 result
 * @param {string} [format]  the receipt's format name (for models listed with `formats`) / 回执的格式名
 */
export function priceProblems(field, result, format) {
  if (!isObj(field) || !Array.isArray(field.models)) return ['the manifest has no AI price table']
  if (!isObj(result)) return ['the receipt has no result']
  const entry = modelEntryOf(field.models, result.model, format)
  const model = String(result.model).slice(0, 80)
  if (!entry) {
    if (result.prices) return [`the receipt charges ${showPrices(result.prices)}, but the manifest lists no price for model ${model}`]
    if (result.modelMatchedBy) return [`the receipt says model ${model} matched the price table, but the manifest lists no such model`]
    return []
  }
  const want = pricesOf(entry, result.usage)
  const p = []
  if (!result.modelMatchedBy) p.push(`the manifest prices model ${model}, but the receipt does not say it matched`)
  if (!sameJSON(want, result.prices ?? null)) {
    if (!want) p.push(`the receipt charges ${showPrices(result.prices)}, but there is no usage to price`)
    else if (!result.prices) p.push(`the receipt carries no prices, but the manifest prices model ${model} (${showPrices(want)} for this usage)`)
    else p.push(`the receipt charges ${showPrices(result.prices)}; the manifest gives ${showPrices(want)}`)
  }
  const u = usageOf(result.usage)
  const wantUnpriced = want && u?.other ? Object.keys(u.other) : undefined
  if (!sameJSON(wantUnpriced, result.unpriced)) p.push(`the receipt lists unpriced ${JSON.stringify(result.unpriced ?? [])}, the usage says ${JSON.stringify(wantUnpriced ?? [])}`)
  return p
}

/**
 * Check one AI usage receipt. Pure: no network. `manifest` must be a manifest you trust (api.resolve() checked its
 * delegation, which is what makes `manifest.signer` the service's key).
 * 核验一份 AI 用量回执。纯函数、不联网。`manifest` 必须可信（api.resolve() 核验过委托，signer 才是服务的密钥）。
 *
 * The two hashes bind the exact bytes: pass `requestBytes` (what you sent) and either `responseBytes` (what you received;
 * for a stream, the raw event-stream bytes), `sseDataPayloads` (a stream's data payloads, in order) or `responseSha256`
 * (if you hashed them yourself). What you do not pass is not checked and is listed in `unchecked`.
 * Holding the answer, the client re-reads it with the format's adapter (TAP-21 §3.5, check 4): its id (compared only when
 * it is one the sidecar would use, isAnswerId), model, usage and completeness must be what the receipt says. From
 * `responseBytes` this reading is done here; with only a hash, pass it as `answer` ({ id, model, usage, complete }, e.g.
 * an adapter's streamState().result()). The usage cannot be compared when the receipt says usageInjected (the client's
 * copy lacks the usage chunk): listed in `unchecked`, like every check that could not be made.
 * 持有回答时，客户端用格式适配器重读它：id（仅当旁路会用它时才比较）、model、usage 与完整性必须与回执一致。usageInjected 时
 * 无法比较 usage，列入 unchecked；做不了的检查一律列入 unchecked，绝不算通过。
 * 两个哈希绑定确切字节：传入 requestBytes 与 responseBytes / sseDataPayloads / responseSha256 之一；没传的不核验，列在 unchecked。
 *
 * @returns {{ ok: boolean, problems: string[], warnings: string[], unchecked: string[], receipt: object|null }}
 */
export function verifyUsageReceipt({ envelope, manifest, requestBytes, responseBytes, sseDataPayloads, responseSha256, answer, stream, path, status, complete, now, maxSkewS, formats = FORMATS } = {}) {
  const problems = [], warnings = [], unchecked = []
  const out = () => ({ ok: problems.length === 0 && !!envelope, problems, warnings, unchecked, receipt: isObj(envelope) ? envelope : null })
  if (!envelope) { problems.push('no receipt'); return out() }
  problems.push(...envelopeProblems(envelope))
  if (problems.length) return out()
  const r = envelope.result
  const format = formatOfMethod(envelope.method, formats)
  if (!format) problems.push(`unknown receipt method ${envelope.method}`)
  else if (!format.match({ verb: 'POST', path: envelope.params.path })) problems.push(`method ${envelope.method} does not belong to path ${envelope.params.path.slice(0, 80)}`)
  let field = null
  if (!isObj(manifest)) problems.push('no manifest to check against')
  else {
    try { field = validateAIField(manifest[MANIFEST_FIELD], { allowHttp: true }) } catch (e) { problems.push(`the manifest's ${MANIFEST_FIELD} field: ${e.message}`) }
    if (!isAddress(manifest.container) || !eqAddr(manifest.container, envelope.container)) problems.push(`the receipt names container ${envelope.container}, the manifest ${manifest.container}`)
    let signer = null
    try { signer = recoverResponseSigner({ container: envelope.container, id: envelope.id, method: envelope.method, params: envelope.params, ok: true, body: r, ts: envelope.ts }, envelope.sig) } catch (e) { problems.push(`the signature does not hold: ${e.message}`) }
    if (signer && !eqAddr(signer, manifest.signer)) problems.push(`signed by ${signer}, but the manifest's signer is ${manifest.signer}`)
  }
  if (path !== undefined && path !== envelope.params.path) problems.push(`the receipt is for ${envelope.params.path.slice(0, 80)}, the request went to ${String(path).slice(0, 80)}`)
  if (status !== undefined && r.status !== status) problems.push(`the receipt says HTTP ${r.status}, the response was ${status}`)
  // Request / 请求
  if (requestBytes === undefined) unchecked.push('request')
  else {
    const b = toBytes(requestBytes)
    if (!b) problems.push('requestBytes must be bytes or a string')
    else {
      if (sha256Hex(b) !== envelope.params.requestSha256) problems.push('requestSha256 does not match the request that was sent')
      const asked = typeof format?.requestModel === 'function' ? format.requestModel(jsonOf(b)) : null
      if (r.modelMatchedBy === 'request') {
        if (asked !== r.model) problems.push(`the receipt prices the requested model ${String(r.model).slice(0, 80)}, but the request asked for ${String(asked).slice(0, 80)}`)
      } else if (asked && typeof r.model === 'string' && asked !== r.model) {
        // The same entry under an alias is the same model as far as the price table goes. / 同一条目的别名在价目表看来是同一个模型。
        const a = field && modelEntryOf(field.models, asked, format?.name), m = field && modelEntryOf(field.models, r.model, format?.name)
        if (!a || a !== m) warnings.push(`asked for model ${asked.slice(0, 80)}, the upstream reported ${r.model.slice(0, 80)}`)
      }
    }
  }
  // Response / 回应
  if (stream !== undefined && r.stream !== stream) problems.push(`the receipt says stream ${r.stream}, the response was ${stream ? '' : 'not '}a stream`)
  let got = null, read = isObj(answer) ? answer : null
  const sentinel = format?.stream?.sentinel ?? null
  if (responseSha256 !== undefined) got = String(responseSha256)
  else if (sseDataPayloads !== undefined) got = sseDigestOfPayloads(sseDataPayloads, { sentinel })
  else if (responseBytes !== undefined) {
    const b = toBytes(responseBytes)
    if (!b) problems.push('responseBytes must be bytes or a string')
    else if (r.stream) {
      const s = scanSse(b, format ? { format } : { sentinel }); got = s.responseSha256
      if (format) read = s
    } else {
      got = sha256Hex(b)
      if (format) read = format.response(jsonOf(b)) ?? null
    }
  }
  if (got === null) unchecked.push('response')
  else if (got !== r.responseSha256) problems.push('responseSha256 does not match the response that was received')
  // The client's own reading of the answer (check 4). / 客户端自己对回答的读取。
  if (!read) unchecked.push('id', 'model', 'usage', ...(complete === undefined ? ['complete'] : []))
  else {
    if (isAnswerId(read.id) && read.id !== envelope.id) problems.push(`the receipt is for response ${envelope.id.slice(0, 80)}, the response's id is ${read.id.slice(0, 80)}`)
    const said = typeof read.model === 'string' && read.model.length >= 1 && read.model.length <= MODEL_ID_MAX ? read.model : null
    if (said !== null && r.model !== said) problems.push(`the receipt says model ${String(r.model).slice(0, 80)}, but the answer reports ${said.slice(0, 80)}`)
    if (said === null && r.model !== null && r.modelMatchedBy !== 'request') problems.push(`the receipt says model ${String(r.model).slice(0, 80)}, but the answer reports none`)
    if (r.usageInjected) unchecked.push('usage (usageInjected: the answer the client received lacks the usage chunk the sidecar read)')
    else {
      const u = r.status >= 200 && r.status < 300 ? usageOf(read.usage) : null
      if (!sameJSON(u, r.usage)) problems.push(`the receipt says usage ${JSON.stringify(r.usage)}, but the answer reports ${JSON.stringify(u)}`)
    }
  }
  const seenComplete = complete !== undefined ? complete : read ? completeOf({ status: r.status, stream: r.stream, read }) : undefined
  if (seenComplete !== undefined && seenComplete !== r.complete) problems.push(`the receipt says complete ${r.complete}, but the answer ${seenComplete ? 'is' : 'is not'} complete`)
  if (r.complete === false && r.status >= 200 && r.status < 300) warnings.push(`the answer did not complete (no final success event); it is ${r.prices ? 'priced from the usage it reported' : 'not priced'}`)
  // Amount / 金额
  if (field) problems.push(...priceProblems(field, r, format?.name))
  if (field && r.prices === null && r.usage && typeof r.model === 'string' && !modelEntryOf(field.models, r.model, format?.name)) warnings.push(`model ${r.model.slice(0, 80)} is not in the manifest's price table`)
  if (r.unpriced) warnings.push(`billed per use and not priced by the table: ${r.unpriced.join(', ')}`)
  // Freshness / 时效
  if (maxSkewS !== undefined) {
    const t = now ?? Math.floor(Date.now() / 1000)
    if (Math.abs(t - envelope.ts) > maxSkewS) problems.push(`signed at ${envelope.ts}, outside ±${maxSkewS} s of now (${t})`)
  } else unchecked.push('freshness')
  return out()
}

// ---------------------------------------------------------------------------------------------------------------
// Request salt / 请求加盐
// ---------------------------------------------------------------------------------------------------------------
/** How many whitespace characters saltRequestBody appends: 64, two random bits each, 128 bits. / 追加的空白字符数。 */
export const SALT_LENGTH = 64
// The four characters JSON allows between tokens (RFC 8259 §2): space, tab, line feed, carriage return.
// JSON 允许出现在记号之间的四个字符：空格、制表、换行、回车。
const JSON_WS = Object.freeze([0x20, 0x09, 0x0a, 0x0d])
const isWs = (b) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d
/**
 * A JSON request body with SALT_LENGTH random whitespace characters appended, or null when the body is left alone.
 *
 * Why: a receipt carries `requestSha256`, the SHA-256 of the exact request bytes, and the official SDKs serialise a
 * request deterministically, so a short prompt ("yes", one word to embed, a question from a known list) can be confirmed
 * from a receipt by hashing guesses (TAP-21 §8). 128 random bits after the JSON text make the hash unguessable. What the
 * upstream parses is unchanged: RFC 8259 allows whitespace after the value, so the parsed request (every field,
 * `user` and `metadata.user_id` included) is identical, no token is added, and prompt caching, which keys on the
 * parsed prompt's tokens (OpenAI's prefix cache, Anthropic's `cache_control`), sees the same prompt. No field is added
 * or changed, since `user` and `metadata.user_id` steer cache routing and abuse tracking upstream. `requestSha256` is
 * the hash of the salted bytes, which are the bytes actually sent. That every upstream accepts the trailing whitespace
 * is what the JSON grammar says; it has not been measured against the live APIs of the three formats here.
 *
 * Left alone (null): an empty body; a body with a Content-Encoding other than identity (compressed bytes are not JSON
 * text, and appending would corrupt them); a Content-Type that is not JSON; bytes that are not a JSON text in UTF-8.
 *
 * 为什么：回执带 requestSha256，即确切请求字节的 SHA-256；官方 SDK 的序列化是确定的，所以短提示词（"是"、一个要做嵌入的词、
 * 已知问题清单里的一问）可以通过对猜测取哈希、从回执上确认（TAP-21 §8）。JSON 文本之后的 128 个随机比特让哈希无法猜测。上游解析
 * 出来的内容不变：RFC 8259 允许值之后出现空白，所以解析出的请求（每个字段，包括 user 与 metadata.user_id）完全相同，不增加任何
 * token；提示词缓存按解析后提示词的 token 取键（OpenAI 的前缀缓存、Anthropic 的 cache_control），看到的是同一个提示词。不增加也
 * 不修改任何字段：user 与 metadata.user_id 在上游影响缓存路由与滥用追踪。requestSha256 是加盐后字节的哈希，也就是实际发出的字节。
 * 各上游都接受尾随空白是 JSON 语法所规定的；这里没有对三种格式的线上接口实测过。
 * 不处理（返回 null）：空正文；Content-Encoding 不是 identity 的正文（压缩后的字节不是 JSON 文本，追加会破坏它）；Content-Type 不是
 * JSON；不是 UTF-8 JSON 文本的字节。
 *
 * @param {Uint8Array} bytes  the request body as it would be sent / 原本要发出的请求正文
 * @param {Headers|Record<string, string>} [headers]  the request's headers / 请求头
 * @returns {Uint8Array|null}
 */
export function saltRequestBody(bytes, headers) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) return null
  const h = headers instanceof Headers ? headers : new Headers(headers || {})
  const coding = (h.get('content-encoding') || '').trim().toLowerCase()
  if (coding && coding !== 'identity') return null
  const type = h.get('content-type')
  if (type && !/(^|[/+])json\b/i.test(type)) return null
  let i = 0
  while (i < bytes.length && isWs(bytes[i])) i++
  if (bytes[i] !== 0x7b && bytes[i] !== 0x5b) return null   // an object or an array / 对象或数组
  try { JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return null }
  const r = new Uint8Array(SALT_LENGTH / 4)
  crypto.getRandomValues(r)
  const out = new Uint8Array(bytes.length + SALT_LENGTH)
  out.set(bytes)
  for (let k = 0; k < SALT_LENGTH; k++) out[bytes.length + k] = JSON_WS[(r[k >> 2] >> ((k & 3) * 2)) & 3]
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// A verifying fetch for official SDKs / 给官方 SDK 用的核验 fetch
// ---------------------------------------------------------------------------------------------------------------
async function bodyBytes(url, init) {
  const b = init?.body
  if (b == null) return new Uint8Array(0)
  const direct = toBytes(b)
  if (direct) return direct
  if (b instanceof URLSearchParams) return enc.encode(b.toString())
  // A stream, Blob or FormData: materialised once so the bytes sent are exactly the bytes hashed.
  // 流、Blob 或 FormData：先物化一次，发出的字节与参与哈希的字节才完全相同。
  const req = new Request(url, { method: init.method || 'POST', headers: init.headers, body: b, duplex: 'half' })
  return { bytes: new Uint8Array(await req.arrayBuffer()), contentType: req.headers.get('content-type') }
}

/**
 * A fetch for an official SDK that takes one (e.g. `new OpenAI({ baseURL: svc.manifest.openai.baseUrl, fetch })`):
 * requests on a receipt path are sent as they are, their bytes kept; every answer is checked with verifyUsageReceipt
 * against the resolved manifest. A stream is passed on chunk by chunk as it arrives and checked when it ends; a problem
 * then errors the stream (strict) so the SDK's iterator throws. Everything else passes through untouched.
 * 给接受自定义 fetch 的官方 SDK 用：回执路径上的请求原样发送并保留字节；每个回答都按已解析的清单核验。流按到达逐块转交，
 * 结束时核验；有问题时（strict）让流出错，SDK 的迭代器随之抛出。其余请求不做任何处理。
 *
 * @param {object} o
 * @param {object} o.service  from api.resolve() (or a target api.resolve accepts, resolved on first use) / 来自 api.resolve()
 * @param {object} [o.api]    the createTapeAPI instance: resolves `service` if needed and re-reads the manifest once when
 *                            a receipt is signed by another key (the service may have rotated) / 用于解析与换钥后重读
 * @param {Function} [o.fetch]
 * @param {(report: object) => void} [o.onReport]  every check: { ok, problems, warnings, unchecked, receipt, url, stream, status,
 *        sidecarError?, code? }
 * An answer the sidecar made itself (SIDECAR_ERROR_HEADER, no receipt) is a transport failure, reported with
 * sidecarError: true and thrown (strict) as PROVIDER_UNAVAILABLE, or RATE_LIMITED for its 429; it is never verified.
 * 旁路自己产生的回答（带 SIDECAR_ERROR_HEADER、没有回执）是传输失败：报告 sidecarError，严格模式下抛 PROVIDER_UNAVAILABLE
 * （429 为 RATE_LIMITED）；它永远不算已核验。
 * @param {boolean} [o.salt=true]  append SALT_LENGTH random whitespace characters to a JSON request body on a receipt path
 *        (saltRequestBody: the parsed request is unchanged, the request hash becomes unguessable); compressed and
 *        non-JSON bodies are sent as they are. false: send the bytes exactly as given. Reports carry `salted`.
 *        在回执路径上的 JSON 请求正文末尾追加随机空白（解析出的请求不变，请求哈希无法猜测）；压缩或非 JSON 正文原样发送。
 *        false：完全按给定字节发送。报告带 salted。
 * @param {boolean} [o.strict=true]  throw (or error the stream) on any problem; false: report only / 有问题即抛错；false 只报告
 * @param {number} [o.maxSkewS=300]  the receipt's ts must be this close to now / 回执时间与当前时间的最大偏差
 * @param {object[]} [o.formats]  the adapters (default FORMATS) / 适配器
 */
export function createVerifyingFetch({ api, service, fetch: fetchImpl, onReport, strict = true, maxSkewS = 300, formats = FORMATS, salt = true } = {}) {
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a))
  let svc = isObj(service) && isObj(service.manifest) ? service : null
  let resolving = null
  async function current() {
    if (svc) return svc
    if (!api || typeof api.resolve !== 'function' || service == null) throw new TapeAPIError('MANIFEST_INVALID', 'createVerifyingFetch needs a resolved service, or api and a target to resolve')
    resolving ??= api.resolve(service).then((s) => { svc = s; return s }).finally(() => { resolving = null })
    return resolving
  }
  const report = (r) => {
    if (onReport) { try { onReport(r) } catch { /* the reporter's own failure is not the call's / 回调自己的错误不影响调用 */ } }
    else if (!r.ok && !strict && r.problems.length) console.warn('[tapeapi/ai] usage receipt problem:', r.problems.join('; '))
  }
  const failure = (r) => (r.sidecarError
    ? new TapeAPIError(r.code, r.problems.join('; '), { data: { status: r.status, problems: r.problems } })
    : new TapeAPIError('RECEIPT_INVALID', `usage receipt: ${r.problems.join('; ')}`, { data: { problems: r.problems, receipt: r.receipt } }))
  // Only a validated `ai` field is used (TAP-20 §3.9); an endpoint of an unknown format, or without its format's suffix,
  // is ignored. / 只使用校验过的 ai 字段；未知格式、或缺少格式后缀的端点被忽略。
  const endpointsOf = (s) => {
    if (Array.isArray(s.aiProblems) && s.aiProblems.length) throw new TapeAPIError('MANIFEST_INVALID', `${s.container}: its ${MANIFEST_FIELD} field is invalid and was dropped: ${s.aiProblems.join('; ')}`)
    const raw = s.manifest?.[MANIFEST_FIELD]
    if (raw === undefined) throw new TapeAPIError('MANIFEST_INVALID', `${s.container} publishes no ${MANIFEST_FIELD} field`)
    return validateAIField(raw, { allowHttp: s.verified?.dev === true }).endpoints
  }

  async function check(s, args) {
    let r = verifyUsageReceipt({ ...args, manifest: s.manifest, maxSkewS, formats })
    // Another key: the service may have rotated since we resolved it. Re-read once, then decide.
    // 另一把密钥：解析之后服务可能换了钥。重读一次再下结论。
    if (!r.ok && api && typeof api.refresh === 'function' && s.target !== undefined && r.problems.some((p) => p.startsWith('signed by '))) {
      try { await api.refresh(s); r = verifyUsageReceipt({ ...args, manifest: s.manifest, maxSkewS, formats }) } catch { /* keep the first verdict / 保留第一次的结论 */ }
    }
    return r
  }

  return async function verifyingFetch(input, init = {}) {
    const s = await current()
    if (!s.verified || (s.verified.delegation !== true && s.verified.dev !== true)) throw new TapeAPIError('DELEGATION_INVALID', 'the service must come from api.resolve(): its signer is only trustworthy once the delegation has been verified')
    const endpoints = endpointsOf(s)
    const isRequest = typeof Request !== 'undefined' && input instanceof Request
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
    const verb = String(init.method || (isRequest ? input.method : 'GET')).toUpperCase()
    // The request's format: an endpoint of the manifest whose root the URL is under, and whose adapter matches the path.
    // 请求的格式：URL 位于清单某个端点的根之下，且该端点格式的适配器认得这个路径。
    let rel = null, format = null
    try {
      const u = new URL(url)
      for (const ep of endpoints) {
        const f = formats.find((x) => x.name === ep?.format)
        const root = f && rootOf(ep.baseUrl, f)
        if (!root) continue
        const r = new URL(root)
        const p = r.origin === u.origin ? apiPath(u.pathname, r.pathname) : null
        if (p && f.match({ verb, path: p })) { rel = p; format = f; break }
      }
    } catch { /* not ours / 不是我们的 */ }
    if (!format) return doFetch(input, init)
    // A Request object: its body is read here, once, and sent as those bytes. / Request 对象：在此读出正文一次，按这些字节发送。
    if (isRequest) {
      const req = new Request(input, init)
      init = { method: req.method, headers: req.headers, body: new Uint8Array(await req.arrayBuffer()), signal: req.signal }
    }
    const got = await bodyBytes(url, init)
    let requestBytes = got instanceof Uint8Array ? got : got.bytes
    const sendInit = { ...init, body: requestBytes }
    if (!(got instanceof Uint8Array) && got.contentType) {
      const h = new Headers(init.headers); if (!h.has('content-type')) h.set('content-type', got.contentType); sendInit.headers = h
    }
    // The salt goes on the bytes that are sent, and the request hash is checked over exactly those bytes.
    // 盐加在实际发出的字节上，请求哈希也按这些字节核对。
    let salted = false
    if (salt) {
      const h = new Headers(sendInit.headers)
      const more = saltRequestBody(requestBytes, h)
      if (more) { requestBytes = more; salted = true; h.delete('content-length'); sendInit.headers = h; sendInit.body = more }
    }
    const res = await doFetch(url, sendInit)
    const type = (res.headers.get('content-type') || '').toLowerCase()
    const common = { requestBytes, path: rel, status: res.status }
    // The same rule as the sidecar: a stream only for a format that streams, answered as an event stream.
    // 与旁路相同的规则：只有会流式的格式、且以事件流作答时才算流。
    if (!format.stream || !type.includes('text/event-stream') || !res.body) {
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (res.headers.get(SIDECAR_ERROR_HEADER) === '1' && !res.headers.get(RECEIPT_HEADER)) {
        let why = ''
        try { why = String(JSON.parse(new TextDecoder().decode(bytes))?.error?.message ?? '').slice(0, 200) } catch { /* not JSON */ }
        const rep = { ok: false, sidecarError: true, code: res.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_UNAVAILABLE', problems: [`the sidecar answered HTTP ${res.status} itself${why ? ` (${why})` : ''}: no upstream answer, no receipt`], warnings: [], unchecked: ['request', 'response'], receipt: null, url, stream: false, status: res.status, salted }
        report(rep)
        if (strict) throw failure(rep)
        return new Response(bytes, { status: res.status, statusText: res.statusText, headers: res.headers })
      }
      let envelope = null, headerError = null
      try { envelope = decodeReceiptHeader(res.headers.get(RECEIPT_HEADER)) } catch (e) { headerError = e.message }
      const r = await check(s, { ...common, envelope, responseBytes: bytes, stream: false })
      if (headerError && !envelope) r.problems.splice(0, r.problems.length, headerError === 'no receipt' ? `no ${RECEIPT_HEADER} header` : headerError)
      const rep = { ...r, url, stream: false, status: res.status, salted }
      report(rep)
      if (!rep.ok && strict) throw failure(rep)
      return new Response(res.status === 204 || res.status === 205 || res.status === 304 ? null : bytes, { status: res.status, statusText: res.statusText, headers: res.headers })
    }
    // A stream: every chunk goes on at once; the check runs when the upstream ends. / 流：每块立即转交，上游结束时核验。
    const st = format.streamState()
    const scanner = createSseScanner({ sentinel: format.stream.sentinel ?? null, onEvent: (j, n) => st.event(j, n) })
    let finished = false
    const body = res.body.pipeThrough(new TransformStream({
      transform(chunk, controller) { controller.enqueue(chunk); scanner.push(chunk) },
      async flush(controller) {
        finished = true
        scanner.end()
        const receipts = scanner.info.receipts
        let rep = null
        // The last receipt first (the outermost sidecar's); an earlier one only if the last does not verify.
        // 先看最后一个回执（最外层旁路的）；它核验不过时才看更早的。
        for (let i = receipts.length - 1; i >= 0; i--) {
          let envelope = null
          try { envelope = decodeReceiptHeader(receipts[i]) } catch { continue }
          const r = await check(s, { ...common, envelope, responseSha256: scanner.digest(), stream: true, answer: st.result() })
          if (r.ok || !rep) rep = r
          if (r.ok) break
        }
        if (!rep) rep = { ok: false, problems: ['no tapeapi-receipt comment in the event stream'], warnings: [], unchecked: [], receipt: null }
        rep = { ...rep, url, stream: true, status: res.status, salted }
        report(rep)
        if (!rep.ok && strict) controller.error(failure(rep))
      },
      // The consumer stopped reading (break, abort): nothing to verify, which is not a receipt problem.
      // 消费方停止读取（break、abort）：没有可核验的内容，这不是回执问题。
      cancel() { if (!finished) report({ ok: false, incomplete: true, problems: [], warnings: ['the stream was not read to the end; its receipt was not checked'], unchecked: ['request', 'response'], receipt: null, url, stream: true, status: res.status, salted }) },
    }))
    const headers = new Headers(res.headers)
    headers.delete('content-length')
    return new Response(body, { status: res.status, statusText: res.statusText, headers })
  }
}
