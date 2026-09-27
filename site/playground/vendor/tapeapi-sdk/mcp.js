// A Model Context Protocol (MCP) server core with no transport: one JSON-RPC message in, one out. The remote endpoint
// (server/src/mcp.js, Streamable HTTP) and the local command (sdk/bin/tapeapi-mcp.js, stdio) both run on it.
// What TapeAPI adds to MCP is in the results: every tool result is a TAP-21 envelope signed by the service's on-chain
// delegated key, returned with a receipt anyone can check again later (receiptOf, verifyLink).
// 无传输层的 MCP 服务器核心：一条 JSON-RPC 进，一条出。远程端点（Streamable HTTP）与本地命令（stdio）都跑在它上面。
// TapeAPI 给 MCP 加的东西在结果里：每个工具结果都是服务链上委托密钥签名的 TAP-21 信封，并附带任何人事后都能再核验的回执。
//
// Only leaf modules are imported, no node: imports: this file runs in Workers, browsers and Node.
// 只引用叶子模块、不引用 node:，可在 Workers、浏览器与 Node 中运行。
import { TapeAPIError } from './errors.js'

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
  if (!info?.name || !info?.version) throw new TapeAPIError('BAD_REQUEST', 'info.name and info.version are required')
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

// Only MCP's tool fields leave the server (manifestToTools adds method/price bookkeeping). / 只输出 MCP 的工具字段。
function publicTool(t) {
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

// The receipt rides in the URL fragment, which browsers never send to a server. / 回执放在 URL 片段里，浏览器不会发给服务器。
export const verifyLink = (receipt, base = VERIFY_BASE) => `${base}#r=${toBase64Url(JSON.stringify(receipt))}`

/**
 * A signed envelope -> an MCP CallToolResult: the data as text and structuredContent, a one-line provenance note the
 * model can quote, the receipt in _meta, isError for a signed refusal.
 * 签名信封 -> MCP 工具结果：数据（文本与 structuredContent）、模型可以引用的一行来源说明、_meta 里的回执、签名拒绝时 isError。
 * @param {object} o
 * @param {object} o.receipt   from receiptOf / 来自 receiptOf
 * @param {string} o.checkedBy  who verified the signature before returning: 'client' (this process checked it) or
 *        'service' (the remote service is speaking for itself; the link lets anyone check) / 返回前谁核验过签名
 */
export function toolResultOf({ receipt, checkedBy, signer, link = verifyLink(receipt) }) {
  const who = receipt.service.name || `circuit #${receipt.service.tokenId} of ${receipt.service.circuits}`
  const where = Number.isInteger(receipt.block) ? ` at BNB Chain block ${receipt.block}` : ''
  const check = checkedBy === 'client'
    ? 'The signature was verified against the on-chain delegation before this result was returned.'
    : 'Anyone can verify this signature against the chain with the link.'
  const note = `Signed by TapeAPI service ${who} (container ${receipt.service.container}${signer ? `, signer ${signer}` : ''})${where}. ${check} Verify: ${link}`
  if (!receipt.ok) {
    const e = receipt.error || {}
    return { content: [{ type: 'text', text: `The service refused: ${e.code || 'ERROR'}: ${e.message || ''}` }, { type: 'text', text: note }], isError: true, _meta: { [RECEIPT_META_KEY]: receipt } }
  }
  const out = { content: [{ type: 'text', text: JSON.stringify(receipt.result) }, { type: 'text', text: note }], isError: false, _meta: { [RECEIPT_META_KEY]: receipt } }
  if (isObj(receipt.result)) out.structuredContent = receipt.result
  return out
}
