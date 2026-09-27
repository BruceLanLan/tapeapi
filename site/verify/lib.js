// Receipt checker (tapeapi.fun/verify/): the pure part. Reads a receipt out of whatever the user has (the verify link,
// its fragment, the bare base64url, the receipt JSON, or a whole MCP tool result / JSON-RPC response), checks its shape
// strictly, and turns the facts the page gathered (recovered signer, the service as resolved on chain) into a verdict.
// No DOM, no network, no storage: Node tests it offline (scripts/verify-page.test.mjs).
// A receipt is untrusted input. Nothing it claims about itself is believed: the page recovers the signer from the
// signature and reads the service's key from the chain, and only the two together make a verdict.
// 回执核验页的纯函数部分：从用户手里的任何形式（核验链接、它的片段、base64url、回执 JSON、整个 MCP 工具结果或 JSON-RPC 回应）
// 取出回执，严格检查结构，再把页面收集到的事实（恢复出的签名者、链上解析出的服务）变成结论。不碰 DOM、网络与存储。
// 回执是不可信输入：它对自己的任何说法都不采信。签名者从签名恢复，服务密钥从链上读取，两者一起才构成结论。
import { fromBase64Url, RECEIPT_META_KEY } from '../playground/vendor/tapeapi-sdk/mcp.js'
import { findDuplicateKey, FORBIDDEN_KEYS } from '../playground/vendor/tapeapi-sdk/canon.js'

export { RECEIPT_META_KEY }
export const MAX_INPUT = 64 * 1024   // bytes of pasted text or link / 粘贴文本或链接的字节上限

// A receipt that cannot be read. `code` picks the message; `field` names the part of the receipt that is wrong.
// 读不出来的回执。code 决定提示语，field 指出回执哪一部分不对。
export class ReceiptError extends Error {
  constructor(code, field) { super(field ? `${code}: ${field}` : code); this.name = 'ReceiptError'; this.code = code; this.field = field ?? null }
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/
const SIG_RE = /^0x[0-9a-fA-F]{130}$/
const TOKEN_ID_RE = /^(0|[1-9]\d{0,77})$/
const B64URL_RE = /^[A-Za-z0-9_-]+$/
const LINK_RE = /(?:^|[#&?\s])r=([A-Za-z0-9_-]+)(?=$|[\s&"'<>).,;\]])/   // the whole run, not a prefix of garbage / 整段，不取乱码的前缀
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
export const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && ADDR_RE.test(a) && ADDR_RE.test(b) && a.toLowerCase() === b.toLowerCase()
const byteLength = (s) => new TextEncoder().encode(s).length

// JSON with the SDK's rules for signed JSON: no repeated key (two parsers could keep different values), no key that
// JSON.parse keeps but an assignment would drop. / 与 SDK 对签名 JSON 的规则一致：不许重复键，不许原型相关的键。
function parseJson(text) {
  let v
  try { v = JSON.parse(text) } catch { throw new ReceiptError('bad-json') }
  if (findDuplicateKey(text) !== null) throw new ReceiptError('duplicate-key', findDuplicateKey(text))
  const walk = (x, depth) => {
    if (depth > 64) throw new ReceiptError('bad-json')
    if (Array.isArray(x)) { for (const y of x) walk(y, depth + 1); return }
    if (!x || typeof x !== 'object') return
    for (const k of Object.keys(x)) { if (FORBIDDEN_KEYS.has(k)) throw new ReceiptError('duplicate-key', k); walk(x[k], depth + 1) }
  }
  walk(v, 0)
  return v
}

function decodeB64(b64) {
  let text
  try { text = fromBase64Url(b64) } catch { throw new ReceiptError('bad-base64') }
  return parseJson(text)
}

/**
 * Whatever the user pasted or the link carried -> the receipt object (not yet shape-checked).
 * Accepted: the verify link (any host, the receipt is in `#r=`), the fragment `#r=…` or `r=…`, the bare base64url,
 * the receipt JSON, an MCP tool result with `_meta["fun.tapeapi/receipt"]`, or the JSON-RPC response around one.
 * JSON is tried first when the text is JSON: a tool result carries the link in its text too, and `_meta` is the receipt
 * itself. / 用户粘贴的或链接带来的内容 -> 回执对象（尚未检查结构）。文本是 JSON 时先按 JSON 读。
 */
export function extractReceipt(input) {
  if (typeof input !== 'string') throw new ReceiptError('empty')
  if (input.length > MAX_INPUT || byteLength(input) > MAX_INPUT) throw new ReceiptError('too-large')
  const s = input.trim()
  if (!s) throw new ReceiptError('empty')
  if (s.startsWith('{')) {
    const v = parseJson(s)
    const found = [v?._meta?.[RECEIPT_META_KEY], v?.result?._meta?.[RECEIPT_META_KEY], isObj(v) && 'sig' in v && 'service' in v ? v : undefined].find(isObj)
    if (!found) throw new ReceiptError('no-receipt')
    return found
  }
  const m = LINK_RE.exec(s)
  if (m) return decodeB64(m[1])
  if (B64URL_RE.test(s)) return decodeB64(s)
  throw new ReceiptError('unreadable')
}

/**
 * Strict shape check. Returns a fresh object with only the fields a v1 receipt has (anything else is ignored: it is
 * neither signed nor shown). Throws ReceiptError('shape', field).
 * 严格的结构检查。返回只含 v1 回执字段的新对象（其它字段忽略：既不在签名里，也不显示）。
 */
export function parseReceipt(r) {
  const bad = (field) => { throw new ReceiptError('shape', field) }
  if (!isObj(r)) bad('receipt')
  if (r.v !== 1) bad('v')
  const s = r.service
  if (!isObj(s)) bad('service')
  if (typeof s.circuits !== 'string' || !ADDR_RE.test(s.circuits)) bad('service.circuits')
  if (typeof s.tokenId !== 'string' || !TOKEN_ID_RE.test(s.tokenId)) bad('service.tokenId')
  if (typeof s.container !== 'string' || !ADDR_RE.test(s.container)) bad('service.container')
  if (s.name !== undefined && (typeof s.name !== 'string' || s.name.length > 200)) bad('service.name')
  if (typeof r.method !== 'string' || !r.method || r.method.length > 256) bad('method')
  if (r.params !== undefined && r.params !== null && !isObj(r.params)) bad('params')
  if (typeof r.id !== 'string' || r.id.length > 1024) bad('id')
  if (!Number.isSafeInteger(r.ts) || r.ts < 0) bad('ts')
  if (typeof r.ok !== 'boolean') bad('ok')
  if (r.ok && !('result' in r)) bad('result')
  if (!r.ok && !isObj(r.error)) bad('error')
  if (r.block !== undefined && (!Number.isSafeInteger(r.block) || r.block < 0)) bad('block')
  if (typeof r.sig !== 'string' || !SIG_RE.test(r.sig)) bad('sig')
  const out = {
    v: 1,
    service: { circuits: s.circuits, tokenId: s.tokenId, container: s.container, ...(s.name !== undefined ? { name: s.name } : {}) },
    method: r.method, params: r.params ?? {}, id: r.id, ts: r.ts, ok: r.ok,
  }
  if (r.ok) out.result = r.result; else out.error = r.error
  if (r.block !== undefined) out.block = r.block
  out.sig = r.sig
  return out
}

/** Text -> checked receipt. / 文本 -> 检查过的回执。 */
export const readReceipt = (input) => parseReceipt(extractReceipt(input))

/** The TAP-21 envelope fields the signature covers (sdk sig.responseDigest). block and service.name are NOT among them.
 *  签名覆盖的信封字段；block 与 service.name 不在其中。 */
export const envelopeOf = (r) => ({ container: r.service.container, id: r.id, method: r.method, params: r.params, ok: r.ok, body: r.ok ? r.result : r.error, ts: r.ts })

/** The block number inside the signed result (the public service pins its reads to one), or null.
 *  签名结果里的区块号（公共服务把读取固定在某个区块），没有则为 null。 */
export function signedBlock(r) {
  const n = r.ok && isObj(r.result) && isObj(r.result.blockPinned) ? r.result.blockPinned.blockNumber : undefined
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

/** '11.1013.tape' -> { tokenId: '11', processor: '1013' }; null when absent; 'malformed' when not canonical.
 *  回执里声称的 TapeOut 名字。 */
export function nameClaim(r) {
  const n = r.service.name
  if (n === undefined) return null
  const m = /^([1-9]\d{0,77})\.(0|[1-9]\d{0,77})\.tape$/.exec(n)
  return m ? { tokenId: m[1], processor: m[2] } : 'malformed'
}

// Resolve failures that say something about the service; anything else (RPC down, nodes disagree, timeouts, a
// network error) means the page could not check, not that the receipt is bad.
// 说明服务本身有问题的解析失败；其它（节点不可用、节点不一致、超时、网络错误）表示“没能核对”，不代表回执有问题。
export const DEFINITE_CODES = Object.freeze(['MANIFEST_INVALID', 'DELEGATION_INVALID', 'NOT_FOUND'])
export const isDefinite = (e) => !!e && DEFINITE_CODES.includes(e.code)

/**
 * Is the receipt's name this service's name? The name is not signed, so it is checked on chain: the factory's
 * processor `processor` must be the receipt's circuit contract and #ID its tokenId.
 * @param {(processor: string) => Promise<string>} cpuAt  factory lookup (api.chain.cpuAt)
 * @returns {Promise<{ state: 'pass'|'fail'|'unknown'|'skip', error?: any }>}
 * 回执里的名字是不是这个服务的名字？名字不在签名里，所以上链核对。
 */
export async function checkName(r, cpuAt) {
  const c = nameClaim(r)
  if (c === null) return { state: 'skip' }
  if (c === 'malformed' || c.tokenId !== r.service.tokenId) return { state: 'fail' }
  try { return { state: sameAddress(await cpuAt(c.processor), r.service.circuits) ? 'pass' : 'fail' } } catch (e) {
    return isDefinite(e) ? { state: 'fail', error: e } : { state: 'unknown', error: e }
  }
}

/**
 * The verdict, from facts only.
 * @param {object} f
 * @param {object} f.receipt        from parseReceipt
 * @param {string|null} f.recovered  the address the signature recovers to over envelopeOf(receipt), or null
 * @param {any} [f.recoverError]     why recovery failed
 * @param {object|null} f.svc        api.resolve({ circuits, tokenId }) result, or null
 * @param {any} [f.resolveError]     why resolve failed
 * @param {{ state: string }} [f.name]  checkName result
 * @param {number} [f.now]           unix seconds
 * @returns {{ verdict: 'valid'|'other-key'|'invalid'|'unchecked', failed: string|null, checks: Array<{ id: string, state: 'pass'|'fail'|'unknown'|'skip' }> }}
 *   valid: signed by the key today's on-chain manifest names, over exactly this request, result and time.
 *   other-key: a well-formed signature by some other key; the service may have rotated keys or the receipt was altered
 *     after signing, and the chain today cannot tell which (so: cannot confirm, not forged).
 *   invalid: `failed` names the check. unchecked: the chain could not be read; nothing is concluded.
 * 结论只来自事实。valid：由今天链上清单指定的密钥、对恰好这次请求/结果/时间签名。other-key：格式正确但属于别的密钥，
 * 可能是服务换了密钥，也可能是签名后被改过，今天的链无法区分（所以是“无法确认”，不是“伪造”）。invalid：failed 指出哪项。
 * unchecked：没能读链，不下结论。
 */
export function verdictOf({ receipt, recovered, recoverError, svc, resolveError, name = { state: 'skip' }, now = Math.floor(Date.now() / 1000) }) {
  const sigOk = !recoverError && typeof recovered === 'string' && ADDR_RE.test(recovered)
  const m = svc?.manifest
  const checks = {
    sig: sigOk ? 'pass' : 'fail',
    resolve: svc ? 'pass' : resolveError ? (isDefinite(resolveError) ? 'fail' : 'unknown') : 'skip',
    container: svc ? (sameAddress(svc.container, receipt.service.container) ? 'pass' : 'fail') : 'skip',
    delegation: svc ? (svc.verified?.delegation === true && Number.isSafeInteger(m?.delegation?.expires) && m.delegation.expires > now ? 'pass' : 'fail') : 'skip',
    name: name.state,
    signer: sigOk && svc ? (sameAddress(recovered, m?.signer) ? 'pass' : 'fail') : 'skip',
  }
  const list = Object.entries(checks).map(([id, state]) => ({ id, state }))
  const out = (verdict, failed = null) => ({ verdict, failed, checks: list })
  for (const id of ['sig', 'resolve', 'container', 'delegation', 'name']) if (checks[id] === 'fail') return out('invalid', id)
  if (checks.resolve === 'unknown' || checks.name === 'unknown' || !svc) return out('unchecked')
  return checks.signer === 'pass' ? out('valid') : out('other-key')
}

/**
 * The whole check with the network and crypto injected, so the page and the tests run the same steps.
 * @param {object} r  from parseReceipt
 * @param {{ recover: (env, sig) => string, resolve: (target) => Promise<object>, cpuAt: (p: string) => Promise<string>, now?: number }} io
 * 完整核对流程，网络与密码学由调用方注入：页面与测试走同样的步骤。
 */
export async function verifyReceipt(r, { recover, resolve, cpuAt, now }) {
  let recovered = null, recoverError = null
  try { recovered = recover(envelopeOf(r), r.sig) } catch (e) { recoverError = e }
  let svc = null, resolveError = null
  try { svc = await resolve({ circuits: r.service.circuits, tokenId: r.service.tokenId }) } catch (e) { resolveError = e }
  const name = await checkName(r, cpuAt)
  return { recovered, recoverError, svc, resolveError, name, ...verdictOf({ receipt: r, recovered, recoverError, svc, resolveError, name, now }) }
}

/** 1790530840 -> '2026-09-28 16:20:40 UTC' */
export function utc(ts) {
  const d = new Date(ts * 1000)
  return Number.isNaN(d.getTime()) ? String(ts) : d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
}
