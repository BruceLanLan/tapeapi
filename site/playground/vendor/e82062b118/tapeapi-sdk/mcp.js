// A Model Context Protocol (MCP) server core with no transport: one JSON-RPC message in, one out. The remote endpoint
// (server/src/mcp.js, Streamable HTTP) and the local command (sdk/bin/tapeapi-mcp.js, stdio) both run on it.
// What TapeAPI adds to MCP is in the results: every tool result is a TAPI-21 envelope signed by the service's on-chain
// delegated key, returned with a receipt anyone can check again later (receiptOf, verifyLink).
// 无传输层的 MCP 服务器核心：一条 JSON-RPC 进，一条出。远程端点（Streamable HTTP）与本地命令（stdio）都跑在它上面。
// TapeAPI 给 MCP 加的东西在结果里：每个工具结果都是服务链上委托密钥签名的 TAPI-21 信封，并附带任何人事后都能再核验的回执。
//
// Only leaf modules are imported, no node: imports: this file runs in Workers, browsers and Node.
// 只引用叶子模块、不引用 node:，可在 Workers、浏览器与 Node 中运行。
import { TapeAPIError } from './errors.js'
import { canonicalJSON } from './canon.js'
import { parseTapeName, CHAINS } from './chains.js'
import { responseRequestHash, responseBodyHash } from './sig.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

// Newest first. The server answers with the client's version when it knows it, else with its newest (MCP lifecycle).
// 新的在前。认识客户端的版本就用它，否则用自己最新的（MCP 生命周期约定）。
export const MCP_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26'])
export const RECEIPT_META_KEY = 'fun.tapeapi/receipt'
export const VERIFY_BASE = 'https://tapeapi.fun/verify/'

export const JSONRPC = Object.freeze({ PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 })

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } })
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result })

/**
 * @param {object} o
 * @param {{ name: string, version: string, title?: string }} o.info  serverInfo / 服务器信息
 * @param {string} [o.instructions]  shown to the model by most clients / 多数客户端会展示给模型
 * @param {() => Promise<Array<{ name, title?, description, inputSchema, annotations? }>>} o.listTools
 * @param {(name: string, args: object) => Promise<object>} o.callTool  returns an MCP CallToolResult; throw
 *        TapeAPIError('BAD_REQUEST'|'METHOD_NOT_FOUND') for a bad tool name or arguments / 返回 CallToolResult
 * @returns {{ handle(message: any): Promise<object|null> }}  null for a notification (nothing to send) / 通知返回 null
 */
export function createMcpServer({ info, instructions, listTools, callTool }) {
  if (!info?.name || !info?.version) throw new TapeAPIError('INVALID_ARGUMENT', 'info.name and info.version are required')
  async function handle(msg) {
    if (!isObj(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return rpcError(isObj(msg) ? msg.id : null, JSONRPC.INVALID_REQUEST, 'not a JSON-RPC 2.0 request')
    }
    const { id, method } = msg
    const params = msg.params === undefined ? {} : msg.params
    // A message without an id is a notification: never answered (initialized, cancelled, progress...).
    // 没有 id 的是通知：从不应答（initialized、cancelled、progress……）。
    if (id === undefined) return null
    if (typeof id !== 'string' && typeof id !== 'number') return rpcError(null, JSONRPC.INVALID_REQUEST, 'id must be a string or a number')
    if (!isObj(params)) return rpcError(id, JSONRPC.INVALID_PARAMS, 'params must be an object')
    try {
      switch (method) {
        case 'initialize': {
          const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : null
          const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0]
          const result = { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { ...info } }
          if (instructions) result.instructions = instructions
          return rpcResult(id, result)
        }
        case 'ping': return rpcResult(id, {})
        case 'tools/list': return rpcResult(id, { tools: (await listTools()).map(publicTool) })
        case 'tools/call': {
          if (typeof params.name !== 'string') return rpcError(id, JSONRPC.INVALID_PARAMS, 'params.name must be the tool name')
          const args = params.arguments === undefined ? {} : params.arguments
          if (!isObj(args)) return rpcError(id, JSONRPC.INVALID_PARAMS, 'params.arguments must be an object')
          try { return rpcResult(id, await callTool(params.name, args)) } catch (e) {
            // An unknown tool or malformed arguments is a protocol error; anything the service answered is a tool
            // result with isError (callTool builds those itself). / 未知工具或参数格式错误是协议错误；服务的回答都是工具结果。
            if (e instanceof TapeAPIError && (e.code === 'METHOD_NOT_FOUND' || e.code === 'BAD_REQUEST')) return rpcError(id, JSONRPC.INVALID_PARAMS, e.message)
            throw e
          }
        }
        // Capabilities we do not declare, answered politely so generic clients do not fail. / 未声明的能力，礼貌应答。
        case 'resources/list': return rpcResult(id, { resources: [] })
        case 'resources/templates/list': return rpcResult(id, { resourceTemplates: [] })
        case 'prompts/list': return rpcResult(id, { prompts: [] })
        default: return rpcError(id, JSONRPC.METHOD_NOT_FOUND, `method ${String(method).slice(0, 64)} is not supported`)
      }
    } catch (e) {
      return rpcError(id, JSONRPC.INTERNAL, 'internal error')
    }
  }
  return { handle }
}

// Only MCP's tool fields leave the server (manifestToTools adds method/price bookkeeping). A tool that carries
// `mcpPublic` (an upstream MCP tool, published as is and pinned by digest) is shown exactly as that object.
// 只输出 MCP 的工具字段。带 mcpPublic 的工具（上游 MCP 工具，按原样发布并以摘要钉住）原样展示该对象。
function publicTool(t) {
  if (isObj(t.mcpPublic)) return t.mcpPublic
  const out = { name: t.name, description: t.description, inputSchema: t.inputSchema }
  if (t.title) out.title = t.title
  if (t.annotations) out.annotations = { readOnlyHint: t.paid !== true, openWorldHint: true, ...pickMcpAnnotations(t.annotations) }
  return out
}
const pickMcpAnnotations = (a) => Object.fromEntries(Object.entries(a).filter(([k]) => ['title', 'readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'].includes(k)))

/**
 * Everything needed to check a signed answer again later, with no trust in whoever passes it on: the service's
 * identity (circuits, tokenId, container), the request the signature is bound to, and the envelope.
 * 事后重新核验签名回答所需的一切，不必信任转交它的人：服务身份、签名绑定的请求，以及信封。
 */
export function receiptOf({ envelope, method, params, circuits, tokenId, name }) {
  if (!isObj(envelope)) throw new TapeAPIError('BAD_REQUEST', 'envelope must be an object')
  const r = {
    v: 1, service: { circuits, tokenId: String(tokenId), container: envelope.container },
    method, params, id: envelope.id, ts: envelope.ts, ok: envelope.ok === true,
  }
  if (name) r.service.name = name
  if (r.ok) r.result = envelope.result; else r.error = envelope.error
  if (envelope.block !== undefined) r.block = envelope.block
  r.sig = envelope.sig
  return r
}

/**
 * The hash-only form of a receipt (v 2): the request's params and the result (or error) are replaced by the two hashes
 * the signature is computed over, so it still verifies (sig.recoverResponseSignerFromHashes) and can be shared without
 * the content of the call. It keeps the service, the method name, the id, the time, success or refusal, and the block.
 *   { v: 2, service, method, requestHash, id, ts, ok, bodyHash, block?, sig }
 *   requestHash = keccak256(canonicalJSON({ method, params })), bodyHash = keccak256(canonicalJSON(result or error))
 * `method` is shown as the receipt states it; only requestHash is bound by the signature, and it covers the method and
 * the params together. Hashes hide only what cannot be guessed: params from a small set (an address, a token id, a
 * price pair) can be confirmed by hashing candidates, and so can a short result. A v 2 receipt is returned as it is.
 * 回执的只带哈希形态（v 2）：请求参数与结果（或错误）换成签名所依据的两个哈希，签名仍可核验，分享时不带调用内容。保留服务、
 * 方法名、id、时间、成功或拒绝、区块。method 按回执所写展示；签名绑定的只有 requestHash，它把方法与参数一起覆盖。哈希只能藏住
 * 猜不到的内容：取自小集合的参数（地址、token id、交易对）可以通过对候选取哈希来确认，简短的结果也一样。v 2 回执原样返回。
 * @param {object} receipt  from receiptOf / 来自 receiptOf
 */
export function hashReceipt(receipt) {
  if (!isObj(receipt)) throw new TapeAPIError('BAD_REQUEST', 'receipt must be an object')
  if (receipt.v === 2) return receipt
  const r = {
    v: 2, service: { ...receipt.service }, method: receipt.method,
    requestHash: responseRequestHash({ method: receipt.method, params: receipt.params }),
    id: receipt.id, ts: receipt.ts, ok: receipt.ok,
    bodyHash: responseBodyHash(receipt.ok ? receipt.result : receipt.error),
  }
  if (receipt.block !== undefined) r.block = receipt.block
  r.sig = receipt.sig
  return r
}

// base64url of UTF-8, without padding; works in Workers, browsers and Node. / UTF-8 的 base64url，无填充。
export function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function fromBase64Url(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new TapeAPIError('BAD_REQUEST', 'not base64url')
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

/**
 * A link to the verify page with the receipt in the URL fragment, which browsers never send to a server. By default the
 * link carries the hash-only form (hashReceipt): whoever the link reaches can check who signed what and when, but does
 * not see the call's params or result. `{ content: true }` puts the whole receipt in the link instead, params and result
 * in clear: the page then shows what was asked and answered, and anyone the link is passed to reads the conversation.
 * 指向核验页的链接，回执放在 URL 片段里，浏览器不会发给服务器。默认放只带哈希的形态：拿到链接的人能核对谁在何时签了什么，但看
 * 不到调用的参数与结果。{ content: true } 改放完整回执（参数与结果为明文）：核验页能显示问了什么、答了什么，链接转给谁，谁就读到
 * 这段对话。
 * @param {object} receipt
 * @param {string} [base]
 * @param {{ content?: boolean }} [o]
 */
export function verifyLink(receipt, base = VERIFY_BASE, { content = false } = {}) {
  const r = content && receipt?.v !== 2 ? receipt : hashReceipt(receipt)
  return `${base}#r=${toBase64Url(JSON.stringify(r))}`
}

/**
 * A signed envelope -> an MCP CallToolResult: the data as text and structuredContent, a one-line provenance note the
 * model can quote, the receipt in _meta, isError for a signed refusal.
 * 签名信封 -> MCP 工具结果：数据（文本与 structuredContent）、模型可以引用的一行来源说明、_meta 里的回执、签名拒绝时 isError。
 * @param {object} o
 * @param {object} o.receipt   from receiptOf / 来自 receiptOf
 * @param {string} o.checkedBy  who verified the signature before returning: 'client' (this process checked it) or
 *        'service' (the remote service is speaking for itself; the link lets anyone check) / 返回前谁核验过签名
 * @param {boolean} [o.linkContent=false]  a verify link with the params and result in clear (verifyLink `content`);
 *        default: hashes only. The note says which. / 核验链接是否带明文参数与结果；默认只带哈希。说明行会写明是哪一种。
 */
export function toolResultOf({ receipt, checkedBy, signer, linkContent = false, link = verifyLink(receipt, VERIFY_BASE, { content: linkContent }) }) {
  const who = receipt.service.name || `circuit #${receipt.service.tokenId} of ${receipt.service.circuits}`
  // block is unsigned and informative; 0 means the service ran without chain nodes. / block 未签名、仅供参考；0 表示没有链节点。
  // The block is on the service's chain: the chain its name names (an area code), BNB Chain otherwise.
  // 区块在服务所在的链上：名字的区号所指的链，否则为 BNB Chain。
  const named = typeof receipt.service.name === 'string' ? parseTapeName(receipt.service.name) : null
  const chainName = named && !named.error && named.chainId !== 56 ? CHAINS[named.chainId].name : 'BNB Chain'
  const where = Number.isInteger(receipt.block) && receipt.block > 0 ? ` at ${chainName} block ${receipt.block}` : ''
  const check = checkedBy === 'client'
    ? 'The signature was verified against the on-chain delegation before this result was returned.'
    : 'Anyone can verify this signature against the chain with the link.'
  // Say what the link carries: whoever it is passed to sees the call's content only in the content form.
  // 写明链接里带什么：只有带原文的形态，拿到链接的人才看得到调用内容。
  const carries = linkContent ? 'The link contains this call\'s params and result.' : 'The link carries hashes only, not the params or result.'
  const note = `Signed by TapeAPI service ${who} (container ${receipt.service.container}${signer ? `, signer ${signer}` : ''})${where}. ${check} Verify: ${link} (${carries})`
  if (!receipt.ok) {
    const e = receipt.error || {}
    return { content: [{ type: 'text', text: `The service refused: ${e.code || 'ERROR'}: ${e.message || ''}` }, { type: 'text', text: note }], isError: true, _meta: { [RECEIPT_META_KEY]: receipt } }
  }
  const out = { content: [{ type: 'text', text: JSON.stringify(receipt.result) }, { type: 'text', text: note }], isError: false, _meta: { [RECEIPT_META_KEY]: receipt } }
  if (isObj(receipt.result)) out.structuredContent = receipt.result
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Tool-definition digest / 工具定义摘要
// ---------------------------------------------------------------------------------------------------------------
// The fields of an MCP tool that tell a model what the tool does and how to call it. A change to any of them is a
// change to the tool (an MCP "rug pull" edits exactly these); anything else (icons, _meta) is left out.
// MCP 工具里告诉模型"做什么、怎么调"的字段。任何一处变化都是工具的变化（MCP "rug pull" 改的正是这些）；其余（图标、_meta）不计。
export const TOOL_DIGEST_FIELDS = Object.freeze(['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations'])

/** The tools as they are hashed: those fields only, sorted by name; a repeated name is refused. / 参与哈希的形式。 */
export function normalizeTools(tools) {
  if (!Array.isArray(tools)) throw new TapeAPIError('BAD_REQUEST', 'tools must be an array')
  const seen = new Set()
  const out = tools.map((t) => {
    if (!isObj(t) || typeof t.name !== 'string' || !t.name) throw new TapeAPIError('BAD_REQUEST', 'every tool needs a name')
    if (seen.has(t.name)) throw new TapeAPIError('BAD_REQUEST', `tool ${t.name.slice(0, 64)} appears twice`)
    seen.add(t.name)
    return Object.fromEntries(TOOL_DIGEST_FIELDS.filter((k) => t[k] !== undefined).map((k) => [k, t[k]]))
  })
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * sha256 (hex, no 0x) of the canonical JSON (RFC 8785) of normalizeTools(tools). A manifest's `mcp.toolsSha256` pins
 * it on chain: a client compares it with the tools/list it receives and refuses a difference.
 * normalizeTools(tools) 规范 JSON 的 sha256（十六进制、无 0x）。清单的 mcp.toolsSha256 把它钉在链上：客户端比对收到的
 * tools/list，不一致就拒绝。
 */
export function toolsDigest(tools) {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJSON(normalizeTools(tools)))))
}

/**
 * Text a model reads but a person does not see: every code point of Unicode general category Cf (format: tag
 * characters U+E0000-E007F, zero-width U+200B-U+200F, U+2060-U+2064, U+FEFF, bidi controls, soft hyphen) and every C0/C1
 * control, except a line feed or a tab inside a `description`. Checked in every string of the digest-covered fields of
 * each tool, keys included, at any depth. Returns one "tool X: field path: U+XXXX" line per offending string ([] when
 * none). A pinned tool with any of these is refused: whoever approves a digest must be able to read what it pins.
 * The holder console (site/console/lib.js) carries the same function, character for character; a test keeps them equal.
 * 模型能读、人看不见的文本：Unicode 类别 Cf 的每个码点（格式字符：标签字符、零宽字符、双向控制符、软连字符）和每个
 * C0/C1 控制符（`description` 里的换行和制表符除外）。检查每个工具摘要字段里的所有字符串（含键、任意深度）。每个有问题的
 * 字符串返回一行 "tool X: field path: U+XXXX"（没有则为空）。带这些字符的工具一律拒绝：批准摘要的人必须能读到它钉住的内容。
 * 持有人操作台（site/console/lib.js）有逐字相同的副本，由测试保证一致。
 * @param {unknown} tools
 * @returns {string[]}
 */
export function invisibleProblems(tools) {
  const FIELDS = ['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations']
  const obj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
  const u = (c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
  const bad = (c, text) => /\p{Cf}/u.test(c) || (/\p{Cc}/u.test(c) && !(text && (c === '\n' || c === '\t')))
  const first = (s, text) => { for (const c of s) if (bad(c, text)) return c; return null }
  const show = (s) => Array.from(s).slice(0, 64).map((c) => (bad(c, false) ? `<${u(c)}>` : c)).join('')
  const out = []
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!obj(t)) continue
    const who = `tool ${JSON.stringify(show(typeof t.name === 'string' ? t.name : String(t.name)))}`
    const walk = (v, path, key) => {
      if (typeof v === 'string') { const c = first(v, key === 'description'); if (c) out.push(`${who}: ${path}: ${u(c)}`); return }
      if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`, key)); return }
      if (!obj(v)) return
      for (const k of Object.keys(v)) {
        const c = first(k, false)
        if (c) out.push(`${who}: ${path} key ${JSON.stringify(show(k))}: ${u(c)}`)
        walk(v[k], /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(show(k))}]`, k)
      }
    }
    for (const f of FIELDS) if (t[f] !== undefined) walk(t[f], f, f)
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Provenance lines / 来源说明行
// ---------------------------------------------------------------------------------------------------------------
// A line of the form TapeAPI's own provenance line takes (toolResultOf), or a link to its verify page. Upstream text
// that carries one is the tool's own output imitating an attestation. No g flag: .test must not keep state.
// 形如 TapeAPI 自己的来源说明行（toolResultOf）或指向核验页的文本。上游文本里出现它，就是工具自己的输出在冒充证明。不带 g：.test 不能有状态。
export const PROVENANCE_RE = /^\s*Signed by TapeAPI service|tapeapi\.fun\/verify/im
export const QUOTED_PREFIX = "[quoted from the tool's own output, not a TapeAPI attestation] "
const SIGNED_PHRASE = /Signed by TapeAPI service/gi

/**
 * Upstream MCP content as the model is shown it: every text item that matches PROVENANCE_RE is prefixed with
 * QUOTED_PREFIX, and its "Signed by TapeAPI service" phrases become "Signed (claimed by the tool) by TapeAPI service",
 * so the genuine provenance line (first in the result) is the only one of its form. Other items are passed as they are.
 * The receipt keeps the original content: that is what was signed.
 * 展示给模型的上游 MCP 内容：匹配 PROVENANCE_RE 的文本项加上 QUOTED_PREFIX 前缀，其中的 "Signed by TapeAPI service" 改成
 * "Signed (claimed by the tool) by TapeAPI service"，使真正的来源说明行（结果中的第一项）是唯一这种形式的行。其余项原样。
 * 回执保留原始内容：签名的就是它。
 * @param {Array<object>} content
 * @returns {Array<object>}
 */
export function quoteProvenance(content) {
  return content.map((c) => (isObj(c) && c.type === 'text' && typeof c.text === 'string' && PROVENANCE_RE.test(c.text)
    ? { ...c, text: QUOTED_PREFIX + c.text.replace(SIGNED_PHRASE, 'Signed (claimed by the tool) by TapeAPI service') }
    : c))
}
