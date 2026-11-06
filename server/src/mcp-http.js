// MCP revision 2026-07-28 over Streamable HTTP (@experimental, 2.5), shared by createMcpEndpoint (mcp.js) and
// createMcpProxy (mcp-proxy.js). A single JSON-RPC request whose `_meta` makes it modern (sdk mcp.requestEra) is
// checked; also a batch that holds one or comes with MCP-Protocol-Version
// 2026-07-28 (refused), and a single request whose 2026-07-28 header contradicts its body. Every other request, and
// every batch of older-revision messages, is answered exactly as before.
// Spec, https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http (read 2026-10-21):
// "Protocol Version Header" (the header MUST match _meta; an unsupported version is 400 with
// UnsupportedProtocolVersionError; an unimplemented method is 404 with -32601), "Standard Request Headers" (Mcp-Method
// for all requests, Mcp-Name for tools/call, resources/read, prompts/get), "Value Encoding" (=?base64?...?=), "Server
// Validation" (400 with HeaderMismatch -32020); basic/index "Per-request protocol fields" (a missing required field is
// -32602, on HTTP 400).
// MCP 2026-07-28 版在 Streamable HTTP 上的处理（实验性，2.5），远程端点与签名代理共用。检查 `_meta` 使其成为新版请求的单条请求；
// 也拒绝含新版消息或带 2026-07-28 头部的批量，以及 2026-07-28 头部与正文矛盾的单条请求。其余请求与旧版批量
// 的回答与以前完全相同。
import { mcp, TapeAPIError } from '@tapeapi/sdk'

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const NAMED = Object.freeze({ 'tools/call': 'name', 'prompts/get': 'name', 'resources/read': 'uri' })
const SENTINEL = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/

// A header value as the body value it mirrors: the Base64 sentinel decoded (UTF-8), anything else as it is; null when
// the sentinel does not decode. / 头部值还原为它镜像的正文值：Base64 哨兵格式解码（UTF-8），其余原样；解不出时为 null。
function headerValue(v) {
  const m = SENTINEL.exec(v)
  if (!m) return v
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0))) } catch { return null }
}

const era = (msg) => {
  if (!isObj(msg) || typeof msg.method !== 'string' || (typeof msg.id !== 'string' && typeof msg.id !== 'number')) return { era: 'legacy' }
  const params = msg.params === undefined ? {} : msg.params
  return isObj(params) ? { ...mcp.requestEra(msg.method, params), request: true } : { era: 'legacy' }
}
// MCP-Protocol-Version names a modern revision this server implements (2026-07-28): a gateway in front of us may trust
// the mirrored headers of such a request (Streamable HTTP "Server Validation", the note on intermediaries). Any other
// value (a legacy revision, garbage) is answered as 2.4.0 answered it. / 头部写的是本服务器实现的新版版本（2026-07-28）：
// 前面的网关可能信任这种请求的镜像头部。其它值（旧版本、乱写）照 2.4.0 回答。
const claimsModern = (v) => v !== null && mcp.MCP_MODERN_PROTOCOL_VERSIONS.includes(v)

// FIXED MR-2, MR-2b: a single request whose MCP-Protocol-Version header is 2026-07-28 while its body
// is not modern (no `_meta` version, or a legacy one) is a malformed 2026-07-28 request: 400. -32020 when a header it
// carries contradicts the body (Streamable HTTP "Server Validation": a load balancer may route on the header while the
// server executes the body), else -32602, the required `_meta` field missing (basic/index "Per-request protocol
// fields"). initialize is left alone: it selects the legacy semantics (versioning "Backward Compatibility").
// CHANGED MR-2b: until then a request with only the header was answered as a legacy one (fixture case "POST ping with
// MCP-Protocol-Version 2026-07-28 but no _meta"); no client of an earlier revision sends that header value.
// 单条请求的 MCP-Protocol-Version 为 2026-07-28、正文却不是新版：是格式错误的新版请求，400。镜像头部与正文矛盾为 -32020，否则为
// -32602（缺必填的 _meta 字段）。initialize 不受影响。CHANGED MR-2b：此前只有头部的请求按旧版回答；旧版客户端不会发这个头部值。
function claimedRefusal(h, msg, mismatch, fail) {
  const v = h('mcp-protocol-version')
  if (!claimsModern(v) || msg.method === 'initialize') return null
  const meta = isObj(msg.params) && isObj(msg.params._meta) ? msg.params._meta : null
  if (meta && Object.prototype.hasOwnProperty.call(meta, mcp.PROTOCOL_VERSION_META) && meta[mcp.PROTOCOL_VERSION_META] !== v) {
    return mismatch('MCP-Protocol-Version header value does not match the body value of _meta')
  }
  const m = h('mcp-method')
  if (m !== null && m !== msg.method) return mismatch('Mcp-Method header value does not match the body value')
  const n = h('mcp-name')
  const field = NAMED[msg.method]
  const want = field && isObj(msg.params) ? msg.params[field] : undefined
  if (n !== null && typeof want === 'string' && headerValue(n) !== want) return mismatch(`Mcp-Name header value does not match the body value of params.${field}`)
  return fail(mcp.JSONRPC.INVALID_PARAMS, `_meta["${mcp.PROTOCOL_VERSION_META}"] is required: the MCP-Protocol-Version header is ${v}`)
}

// ---- Origin (FIXED MR-8) / Origin 校验 ----
// Streamable HTTP "Security & Endpoint" 1: servers MUST validate Origin; an invalid one is 403, whose body MAY be a
// JSON-RPC error without id. createMcpEndpoint: opt-in, so its default (any origin, CORS *) answers byte for byte as
// before. createMcpProxy (3.0): on by default, every browser Origin refused until listed; '*' is the 2.x behaviour.
// createMcpEndpoint 选用：默认（任何来源、CORS *）与以前逐字节相同。createMcpProxy（3.0）默认开启：未列出的浏览器来源一律拒绝；'*' 即 2.x 行为。

/**
 * The `allowedOrigins` option as a Set, or null for every origin (CORS *): `'*'`, or not given when `byDefault` is
 * null (createMcpEndpoint). Not given with a `byDefault` Set (createMcpProxy: an empty one) is that Set. Each entry is
 * an exact origin: scheme, host and port, no path (`https://app.example`, `http://localhost:5173`).
 * / allowedOrigins 选项转成 Set；'*' 或（byDefault 为 null 时）未给出即 null：任何来源。
 * @param {unknown} v
 * @param {Set<string> | null} [byDefault=null]
 * @returns {Set<string> | null}
 */
export function allowedOriginsOf(v, byDefault = null) {
  if (v === undefined || v === null) return byDefault
  if (v === '*') return null
  if (!Array.isArray(v) || !v.length) throw new TapeAPIError('INVALID_ARGUMENT', 'allowedOrigins must be \'*\' or a non-empty array of origins, e.g. ["https://app.example"]')
  for (const o of v) {
    let ok = false
    try { ok = typeof o === 'string' && new URL(o).origin === o } catch { /* below / 见下 */ }
    if (!ok) throw new TapeAPIError('INVALID_ARGUMENT', `allowedOrigins: ${JSON.stringify(String(o).slice(0, 80))} is not an origin (scheme://host[:port], no path or trailing slash)`)
  }
  return new Set(v)
}

/**
 * Answers `handle(request)` under an origin allow-list: a request whose Origin header is present and not listed is 403
 * (body: a JSON-RPC error without id), unanswered; a listed origin is echoed in access-control-allow-origin (with vary:
 * origin) instead of `*`. A request without Origin (not a browser) is answered as before. allowed null: handle as is.
 * 在来源白名单下应答：带 Origin 且不在名单内的请求 403、不处理；名单内的来源回显在 access-control-allow-origin 里（代替 *）。
 * 不带 Origin 的请求（不是浏览器）照常。allowed 为 null 时原样调用。
 * @param {Request} request
 * @param {Set<string> | null} allowed
 * @param {() => Promise<Response>} handle
 * @returns {Promise<Response>}
 */
export async function withOrigin(request, allowed, handle) {
  if (!allowed) return handle()
  const origin = request.headers.get('origin')
  let res
  if (origin !== null && !allowed.has(origin)) {
    res = new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: mcp.JSONRPC.INVALID_REQUEST, message: 'Origin not allowed' } }), { status: 403, headers: { 'content-type': 'application/json' } })
  } else res = await handle()
  const headers = new Headers(res.headers)
  if (origin !== null && allowed.has(origin)) headers.set('access-control-allow-origin', origin)
  else headers.delete('access-control-allow-origin')
  headers.append('vary', 'origin')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

/**
 * FIXED MR-1: the refusal (HTTP 400, -32600, id null) for a JSON array body that holds a 2026-07-28
 * message, or that is sent with an MCP-Protocol-Version header claiming a modern revision; null for any other batch,
 * which is answered as before. Streamable HTTP "Sending Messages" 4: the body MUST be a single request or notification,
 * and a batch would otherwise carry a modern message past the header checks of modernRefusal.
 * 含 2026-07-28 消息、或带声称新版的 MCP-Protocol-Version 头部的 JSON 数组正文：400 拒绝；其余批量照旧。否则批量能把新版消息带过
 * 请求头校验。
 * @param {Request} request
 * @param {unknown[]} msgs
 * @returns {{ status: 400, body: object } | null}
 */
export function batchRefusal(request, msgs) {
  const modern = msgs.some((m) => isObj(m) && typeof m.method === 'string' && isObj(m.params) && mcp.requestEra(m.method, m.params).era === 'modern')
  if (!modern && !claimsModern(request.headers.get('mcp-protocol-version'))) return null
  return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: mcp.JSONRPC.INVALID_REQUEST, message: 'a request of MCP 2026-07-28 is a single JSON-RPC message, not a batch' } } }
}

/**
 * The refusal (HTTP 400 and a JSON-RPC error) for a single modern request that is malformed or whose headers do not
 * match its body; null when the request goes on to the server. / 单条新版请求格式错误或头部与正文不符时的拒绝（400）；否则 null。
 * @param {Request} request
 * @param {unknown} msg  the parsed body / 解析后的正文
 * @returns {{ status: 400, body: object } | null}
 */
export function modernRefusal(request, msg) {
  const e = era(msg)
  const h = (k) => request.headers.get(k)
  const fail = (code, message, data) => ({ status: 400, body: { jsonrpc: '2.0', id: msg.id, error: data === undefined ? { code, message } : { code, message, data } } })
  const mismatch = (message) => fail(mcp.MCP_ERRORS.HEADER_MISMATCH, `Header mismatch: ${message}`)
  if (e.era !== 'modern') return e.request ? claimedRefusal(h, msg, mismatch, fail) : null
  if (e.error) return fail(e.error.code, e.error.message, e.error.data)
  const v = h('mcp-protocol-version')
  if (v === null) return mismatch('the MCP-Protocol-Version header is required')
  if (v !== e.version) return mismatch(`MCP-Protocol-Version header value '${v.slice(0, 64)}' does not match the body value '${e.version}'`)
  const m = h('mcp-method')
  if (m === null) return mismatch('the Mcp-Method header is required')
  if (m !== msg.method) return mismatch(`Mcp-Method header value '${m.slice(0, 64)}' does not match the body value '${msg.method.slice(0, 64)}'`)
  const field = NAMED[msg.method]
  const want = field && isObj(msg.params) ? msg.params[field] : undefined
  // A name that is not a string is the server's to refuse (-32602), not the transport's. / 名字不是字符串由服务器拒绝。
  if (typeof want === 'string') {
    const n = h('mcp-name')
    if (n === null) return mismatch('the Mcp-Name header is required')
    if (headerValue(n) !== want) return mismatch(`Mcp-Name header value does not match the body value of params.${field}`)
  }
  return null
}

/**
 * The HTTP status of the answer to a single message: 404 for a modern request answered "method not found", else 200.
 * 单条消息回答的 HTTP 状态：新版请求得到 "method not found" 时为 404，否则 200。
 */
export function statusOf(msg, out) {
  return era(msg).era === 'modern' && !era(msg).error && out?.error?.code === mcp.JSONRPC.METHOD_NOT_FOUND ? 404 : 200
}
