// Receipt checker (tapeapi.fun/verify/): the pure part. Reads a receipt out of whatever the user has (the verify link,
// its fragment, the bare base64url, the receipt JSON, or a whole MCP tool result / JSON-RPC response), checks its shape
// strictly, and turns the facts the page gathered (recovered signer, the service as resolved on chain) into a verdict.
// No DOM, no network, no storage: Node tests it offline (scripts/verify-page.test.mjs).
// A receipt is untrusted input. Nothing it claims about itself is believed: the page recovers the signer from the
// signature and reads the service's key from the chain, and only the two together make a verdict.
// 回执核验页的纯函数部分：从用户手里的任何形式（核验链接、它的片段、base64url、回执 JSON、整个 MCP 工具结果或 JSON-RPC 回应）
// 取出回执，严格检查结构，再把页面收集到的事实（恢复出的签名者、链上解析出的服务）变成结论。不碰 DOM、网络与存储。
// 回执是不可信输入：它对自己的任何说法都不采信。签名者从签名恢复，服务密钥从链上读取，两者一起才构成结论。
// AI usage receipts (a TAPI-21 envelope with its method and params; x-tapeapi-receipt header, `: tapeapi-receipt` SSE
// comment, or the `receipt` method's answer) are read too. They carry no circuit and #ID, so the service is resolved from
// the container; their hashes bind the exact request and response bytes, checked only when those are pasted as well.
// 也读 AI 用量回执（带 method 与 params 的 TAPI-21 信封；来自响应头、SSE 注释或 receipt 方法的回答）。它不带电路与 #ID，
// 所以按容器解析服务；它的两个哈希绑定确切的请求与回应字节，只有一并粘贴了这些字节才核对。
// Two forms of MCP / TAPI-21 receipt (sdk mcp.js): v 1 carries the params and the result in clear; v 2, what verify links
// carry by default, carries only the two hashes the signature is computed over (requestHash, bodyHash), and is checked
// by rebuilding the digest from them. / MCP / TAPI-21 回执有两种形态：v 1 带明文参数与结果；v 2（核验链接默认的形态）只带签名
// 所依据的两个哈希，按它们重建摘要来核对。
import { fromBase64Url, RECEIPT_META_KEY } from '../playground/vendor/87f18f4a0b/tapeapi-sdk/mcp.js'
import { findDuplicateKey, FORBIDDEN_KEYS } from '../playground/vendor/87f18f4a0b/tapeapi-sdk/canon.js'
import { envelopeProblems, priceProblems, formatOfMethod, validateAIField, MANIFEST_FIELD, sha256Hex, scanSse, answerProblems, completeOf, isWholeJson } from '../playground/vendor/87f18f4a0b/tapeapi-sdk/ai.js'
import { parseTapeName } from '../playground/vendor/87f18f4a0b/tapeapi-sdk/chains.js'

export { RECEIPT_META_KEY }
export const MAX_INPUT = 64 * 1024   // bytes of pasted text or link / 粘贴文本或链接的字节上限

// A receipt that cannot be read. `code` picks the message; `field` names the part of the receipt that is wrong.
// 读不出来的回执。code 决定提示语，field 指出回执哪一部分不对。
export class ReceiptError extends Error {
  constructor(code, field) { super(field ? `${code}: ${field}` : code); this.name = 'ReceiptError'; this.code = code; this.field = field ?? null }
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/
const HASH32_RE = /^0x[0-9a-f]{64}$/
const SIG_RE = /^0x[0-9a-fA-F]{130}$/
const TOKEN_ID_RE = /^(0|[1-9]\d{0,77})$/
const B64URL_RE = /^[A-Za-z0-9_-]+$/
const LINK_RE = /(?:^|[#&?\s])r=([A-Za-z0-9_-]+)(?=$|[\s&"'<>).,;\]])/   // the whole run, not a prefix of garbage / 整段，不取乱码的前缀
// An AI receipt as a header line (`x-tapeapi-receipt: …`) or SSE comment (`: tapeapi-receipt …`); the last one wins,
// as in a stream that passed two sidecars. / 响应头行或 SSE 注释形式的 AI 回执；取最后一个（经过两层旁路的流里外层在后）。
const AI_LINE_RE = /(?:^|[\s:])(?:x-)?tapeapi-receipt\s*:?\s+([A-Za-z0-9_-]+)(?=$|\s)/gim
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
    const found = [
      v?._meta?.[RECEIPT_META_KEY], v?.result?._meta?.[RECEIPT_META_KEY], isObj(v) && 'sig' in v && 'service' in v ? v : undefined,
      isUsageShape(v?.result) ? v.result : undefined,   // the `receipt` method's answer around it / 外面包着 receipt 方法的回答
      isUsageShape(v) ? v : undefined,
    ].find(isObj)
    if (!found) throw new ReceiptError('no-receipt')
    return found
  }
  const lines = [...s.matchAll(AI_LINE_RE)]
  if (lines.length) return decodeB64(lines[lines.length - 1][1])
  const m = LINK_RE.exec(s)
  if (m) return decodeB64(m[1])
  if (B64URL_RE.test(s)) return decodeB64(s)
  throw new ReceiptError('unreadable')
}

/**
 * Strict shape check. Returns a fresh object with only the fields its form has (anything else is ignored: it is
 * neither signed nor shown): v 1 (params and result or error in clear) or v 2 (hash-only: requestHash and bodyHash in
 * their place). Throws ReceiptError('shape', field).
 * 严格的结构检查。返回只含该形态字段的新对象（其它字段忽略：既不在签名里，也不显示）：v 1（明文参数与结果或错误）或 v 2
 * （只带哈希：以 requestHash 与 bodyHash 代替）。
 */
export function parseReceipt(r) {
  const bad = (field) => { throw new ReceiptError('shape', field) }
  if (!isObj(r)) bad('receipt')
  if (r.v !== 1 && r.v !== 2) bad('v')
  const s = r.service
  if (!isObj(s)) bad('service')
  if (typeof s.circuits !== 'string' || !ADDR_RE.test(s.circuits)) bad('service.circuits')
  if (typeof s.tokenId !== 'string' || !TOKEN_ID_RE.test(s.tokenId)) bad('service.tokenId')
  if (typeof s.container !== 'string' || !ADDR_RE.test(s.container)) bad('service.container')
  if (s.name !== undefined && (typeof s.name !== 'string' || s.name.length > 200)) bad('service.name')
  if (typeof r.method !== 'string' || !r.method || r.method.length > 256) bad('method')
  if (r.v === 2) {
    if (typeof r.requestHash !== 'string' || !HASH32_RE.test(r.requestHash)) bad('requestHash')
    if (typeof r.id !== 'string' || r.id.length > 1024) bad('id')
    if (!Number.isSafeInteger(r.ts) || r.ts < 0) bad('ts')
    if (typeof r.ok !== 'boolean') bad('ok')
    if (typeof r.bodyHash !== 'string' || !HASH32_RE.test(r.bodyHash)) bad('bodyHash')
    if (r.block !== undefined && (!Number.isSafeInteger(r.block) || r.block < 0)) bad('block')
    if (typeof r.sig !== 'string' || !SIG_RE.test(r.sig)) bad('sig')
    const out = {
      v: 2,
      service: { circuits: s.circuits, tokenId: s.tokenId, container: s.container, ...(s.name !== undefined ? { name: s.name } : {}) },
      method: r.method, requestHash: r.requestHash, id: r.id, ts: r.ts, ok: r.ok, bodyHash: r.bodyHash,
    }
    if (r.block !== undefined) out.block = r.block
    out.sig = r.sig
    return out
  }
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

// ── AI usage receipts / AI 用量回执 ─────────────────────────────────────────────────────────────────────────────
/** Does this look like an AI usage receipt (an envelope with method and params, no `service`)? / 是否像 AI 用量回执。 */
export function isUsageShape(v) {
  return isObj(v) && !('service' in v) && typeof v.method === 'string' && isObj(v.params) && 'requestSha256' in v.params && 'container' in v && 'sig' in v
}

/**
 * Strict shape check of an AI usage receipt. The signed parts (params, result) are kept exactly as they came: the
 * signature covers them whole. Throws ReceiptError('shape', field).
 * AI 用量回执的严格结构检查。签名覆盖的部分（params、result）原样保留：签名覆盖的是它们整体。
 */
export function parseUsageReceipt(r) {
  const bad = (field) => { throw new ReceiptError('shape', field) }
  if (!isObj(r)) bad('receipt')
  if (typeof r.id !== 'string' || !r.id || r.id.length > 256) bad('id')
  if (r.ok !== true) bad('ok')
  if (typeof r.method !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(r.method)) bad('method')
  if (!isObj(r.params) || typeof r.params.path !== 'string' || r.params.path.length > 1024 || typeof r.params.requestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.params.requestSha256)) bad('params')
  if (typeof r.container !== 'string' || !ADDR_RE.test(r.container)) bad('container')
  if (!Number.isSafeInteger(r.ts) || r.ts < 0) bad('ts')
  if (typeof r.sig !== 'string' || !SIG_RE.test(r.sig)) bad('sig')
  const p = envelopeProblems(r).find((x) => x.startsWith('result'))
  if (p) bad(p.split(' ')[0])
  return { id: r.id, ok: true, result: r.result, container: r.container, ts: r.ts, method: r.method, params: r.params, sig: r.sig }
}

/** Text -> { kind: 'receipt' | 'usage', receipt }. / 文本 -> 回执种类与检查过的回执。 */
export function readAny(input) {
  const raw = extractReceipt(input)
  return isUsageShape(raw) ? { kind: 'usage', raw, receipt: parseUsageReceipt(raw) } : { kind: 'receipt', raw, receipt: parseReceipt(raw) }
}

/** The TAPI-21 fields an AI receipt's signature covers. / AI 回执签名覆盖的 TAPI-21 字段。 */
export const usageEnvelopeOf = (r) => ({ container: r.container, id: r.id, method: r.method, params: r.params, ok: true, body: r.result, ts: r.ts })

/**
 * The verdict for an AI usage receipt, from facts only. Checks, in order: sig, resolve, container, delegation, signer,
 * then method (the path belongs to the method), amount (the manifest's price table), request and response (only when
 * the bytes were given), and answer: the pasted answer read with the format's adapter, whose id, model, usage and
 * completeness must be what the receipt says (TAPI-21 §3.5 check 4, sdk ai.answerProblems; the usage of an injected
 * stream is not compared, and is listed in answerUnchecked). A receipt that does not recover to today's key is
 * "other-key" whatever else it says; one signed by today's key that contradicts the price table or the pasted bytes is
 * invalid, naming the check.
 * AI 用量回执的结论，只来自事实。签名不是今天的密钥即"无法确认"；由今天的密钥签名却与价目表或粘贴的字节不符，则为无效并指出哪一项。
 * answer 一项按格式适配器重读粘贴的回答：id、model、usage 与完整性必须与回执一致（第 4 项核验；注入用量的流不比较 usage，
 * 列在 answerUnchecked）。
 * @param {object} f  { receipt, recovered, recoverError, svc, resolveError, now, request?, response? }
 */
export function usageVerdictOf({ receipt: r, recovered, recoverError, svc, resolveError, now = Math.floor(Date.now() / 1000), request, response }) {
  const sigOk = !recoverError && typeof recovered === 'string' && ADDR_RE.test(recovered)
  const m = svc?.manifest
  const format = formatOfMethod(r.method)
  const fname = format?.name ?? null
  let field = null
  try { field = svc ? validateAIField(m?.[MANIFEST_FIELD], { allowHttp: true }) : null } catch { field = null }
  const hash = (text) => (typeof text === 'string' && text.length ? text : null)
  const req = hash(request), res = hash(response)
  // A pasted stream is read once: its hash, and the shapes that clients parse differently from the hash rule (a line led by
  // U+FEFF, an event left unfinished at the close; FIXED SSE-BOM, SSE-EOF), which fail the response check even when the
  // hash matches. / 粘贴的流只读一遍：哈希，以及客户端与哈希规则解析不一致的形态；即使哈希一致，这些形态也让回应检查失败。
  const scanned = res !== null && r.result.stream ? scanSse(res, format ? { format } : {}) : null
  // A receipt that says stream, over pasted bytes that are one whole JSON answer: the page has no content type of its own,
  // and read as a stream such bytes report no usage (FIXED AI-WHOLE). / 回执说是流，粘贴的却是一整段 JSON 回答：本页没有
  // 自己的 content-type，按流读它什么用量也读不到。
  const responseShape = scanned && isWholeJson(res) ? 'whole' : scanned?.ambiguous ? 'ambiguous' : scanned?.unfinished ? 'unfinished' : null
  // Check 4: the answer as the format's adapter reads it (FIXED AI-INJ: the page used to compare only the hashes).
  // 第 4 项：按格式适配器读出的回答（FIXED AI-INJ：本页以前只比较哈希）。
  let answer = null
  if (res !== null && format) {
    let read = scanned
    if (!read) { let j; try { j = JSON.parse(res) } catch { j = undefined } read = format.response(j) ?? { id: null, model: null, usage: null } }
    answer = answerProblems({ envelope: r, read, format, requestBytes: req ?? undefined })
    const complete = completeOf({ status: r.result.status, stream: r.result.stream, read })
    if (complete !== r.result.complete) answer.problems.push(`the receipt says complete ${r.result.complete}, but the answer ${complete ? 'is' : 'is not'} complete`)
  }
  const checks = {
    sig: sigOk ? 'pass' : 'fail',
    resolve: svc ? 'pass' : resolveError ? (isDefinite(resolveError) ? 'fail' : 'unknown') : 'skip',
    container: svc ? (sameAddress(svc.container, r.container) ? 'pass' : 'fail') : 'skip',
    delegation: svc ? (svc.verified?.delegation === true && Number.isSafeInteger(m?.delegation?.expires) && m.delegation.expires > now ? 'pass' : 'fail') : 'skip',
    signer: sigOk && svc ? (sameAddress(recovered, m?.signer) ? 'pass' : 'fail') : 'skip',
    method: !format ? 'unknown' : format.match({ verb: 'POST', path: r.params.path }) ? 'pass' : 'fail',
    amount: svc ? (field && priceProblems(field, r.result, fname).length === 0 ? 'pass' : 'fail') : 'skip',
    request: req === null ? 'skip' : sha256Hex(req) === r.params.requestSha256 ? 'pass' : 'fail',
    response: res === null ? 'skip' : (scanned ? scanned.responseSha256 : sha256Hex(res)) === r.result.responseSha256 && !responseShape ? 'pass' : 'fail',
    answer: res === null ? 'skip' : !answer ? 'unknown' : answer.problems.length ? 'fail' : 'pass',
  }
  const list = Object.entries(checks).map(([id, state]) => ({ id, state }))
  const out = (verdict, failed = null) => ({
    verdict, failed, checks: list, responseShape, amountProblems: field ? priceProblems(field, r.result, fname) : svc ? [`the manifest has no valid ${MANIFEST_FIELD} field`] : [],
    answerProblems: answer?.problems ?? [], answerUnchecked: answer?.unchecked ?? [],
  })
  for (const id of ['sig', 'resolve', 'container', 'delegation']) if (checks[id] === 'fail') return out('invalid', id)
  if (checks.resolve === 'unknown' || !svc) return out('unchecked')
  if (checks.signer !== 'pass') return out('other-key')
  for (const id of ['method', 'amount', 'request', 'response', 'answer']) if (checks[id] === 'fail') return out('invalid', id)
  return out('valid')
}

/**
 * The whole check of an AI usage receipt, network and crypto injected. `resolve` takes the container address.
 * AI 用量回执的完整核对流程，网络与密码学由调用方注入；resolve 接收容器地址。
 */
export async function verifyUsage(r, { recover, resolve, now, request, response }) {
  let recovered = null, recoverError = null
  try { recovered = recover(usageEnvelopeOf(r), r.sig) } catch (e) { recoverError = e }
  let svc = null, resolveError = null
  try { svc = await resolve(r.container) } catch (e) { resolveError = e }
  return { recovered, recoverError, svc, resolveError, ...usageVerdictOf({ receipt: r, recovered, recoverError, svc, resolveError, now, request, response }) }
}

/** The TAPI-21 envelope fields the signature covers (sdk sig.responseDigest). block and service.name are NOT among them.
 *  签名覆盖的信封字段；block 与 service.name 不在其中。 */
export const envelopeOf = (r) => ({ container: r.service.container, id: r.id, method: r.method, params: r.params, ok: r.ok, body: r.ok ? r.result : r.error, ts: r.ts })
/** The same for a hash-only (v 2) receipt, for sdk sig.recoverResponseSignerFromHashes: the two inner hashes of the
 *  digest in place of { method, params } and the body. / 只带哈希（v 2）回执的对应字段：以摘要里的两个内层哈希代替。 */
export const hashedEnvelopeOf = (r) => ({ container: r.service.container, id: r.id, requestHash: r.requestHash, ok: r.ok, bodyHash: r.bodyHash, ts: r.ts })

/** The block number inside the signed result (the public service pins its reads to one), or null.
 *  签名结果里的区块号（公共服务把读取固定在某个区块），没有则为 null。 */
export function signedBlock(r) {
  const n = r.v !== 2 && r.ok && isObj(r.result) && isObj(r.result.blockPinned) ? r.result.blockPinned.blockNumber : undefined
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

/** '11.1013.tape' -> { tokenId: '11', processor: '1013' }; an X Layer or Base name ('1.2.344.tape', area code 2 or 3)
 *  adds the chainId it names ({ tokenId: '1', processor: '344', chainId: 196 }); null when absent; 'malformed' when
 *  not a canonical name with its suffix on a supported chain.
 *  回执里声称的 TapeOut 名字；X Layer 或 Base 的名字（区号 2 或 3）另带它所指的 chainId。 */
export function nameClaim(r) {
  const n = r.service.name
  if (n === undefined) return null
  const p = parseTapeName(n)
  if (!p || p.error || p.name !== n) return 'malformed'
  return p.chainId === 56 ? { tokenId: p.tokenId, processor: p.processor } : { tokenId: p.tokenId, processor: p.processor, chainId: p.chainId }
}

/** The chain a receipt's service is on: the one its name names (56 without a name). The name is not signed, but the
 *  container is, and an ERC-6551 container address commits to its chain: a name that points at the wrong chain derives
 *  another container there and fails the container check. / 回执服务所在的链：名字所指的链（无名字则为 56）。名字不在签名里，
 *  但容器在，而 ERC-6551 容器地址包含链号：指错链的名字在那条链上推导出别的容器，过不了容器核对。 */
export function chainOfReceipt(r) {
  const c = nameClaim(r)
  return c && c !== 'malformed' && c.chainId ? c.chainId : 56
}

// Resolve failures that say something about the service; anything else (RPC down, nodes disagree, timeouts, a
// network error) means the page could not check, not that the receipt is bad.
// 说明服务本身有问题的解析失败；其它（节点不可用、节点不一致、超时、网络错误）表示“没能核对”，不代表回执有问题。
export const DEFINITE_CODES = Object.freeze(['MANIFEST_INVALID', 'DELEGATION_INVALID', 'NOT_FOUND'])
export const isDefinite = (e) => !!e && DEFINITE_CODES.includes(e.code)

/**
 * Is the receipt's name this service's name? The name is not signed, so it is checked on chain: the factory's
 * processor `processor` must be the receipt's circuit contract and #ID its tokenId.
 * @param {(processor: string, chainId?: number) => Promise<string>} cpuAt  factory lookup on the name's chain (api.chain.cpuAt;
 *   called with a chainId only for an X Layer or Base name)
 * @returns {Promise<{ state: 'pass'|'fail'|'unknown'|'skip', error?: any }>}
 * 回执里的名字是不是这个服务的名字？名字不在签名里，所以上链核对。
 */
export async function checkName(r, cpuAt) {
  const c = nameClaim(r)
  if (c === null) return { state: 'skip' }
  if (c === 'malformed' || c.tokenId !== r.service.tokenId) return { state: 'fail' }
  // on the chain the name names: cpuAt(processor, chainId); BNB names call cpuAt(processor) as before
  // 在名字所指的链上查：cpuAt(processor, chainId)；BNB 名字照旧调用 cpuAt(processor)
  try { return { state: sameAddress(await (c.chainId ? cpuAt(c.processor, c.chainId) : cpuAt(c.processor)), r.service.circuits) ? 'pass' : 'fail' } } catch (e) {
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
 * @param {{ recover: (env, sig) => string, recoverHashed?: (env, sig) => string, resolve: (target) => Promise<object>, cpuAt: (p: string, chainId?: number) => Promise<string>, now?: number }} io
 *   recover: sdk sig.recoverResponseSigner (v 1); recoverHashed: sdk sig.recoverResponseSignerFromHashes (v 2)
 * 完整核对流程，网络与密码学由调用方注入：页面与测试走同样的步骤。
 */
export async function verifyReceipt(r, { recover, recoverHashed, resolve, cpuAt, now }) {
  let recovered = null, recoverError = null
  try {
    if (r.v === 2) { if (typeof recoverHashed !== 'function') throw new Error('no recoverHashed for a hash-only receipt'); recovered = recoverHashed(hashedEnvelopeOf(r), r.sig) } else recovered = recover(envelopeOf(r), r.sig)
  } catch (e) { recoverError = e }
  let svc = null, resolveError = null
  const chainId = chainOfReceipt(r)
  try { svc = await resolve({ ...(chainId !== 56 ? { chainId } : {}), circuits: r.service.circuits, tokenId: r.service.tokenId }) } catch (e) { resolveError = e }
  const name = await checkName(r, cpuAt)
  return { recovered, recoverError, svc, resolveError, name, ...verdictOf({ receipt: r, recovered, recoverError, svc, resolveError, name, now }) }
}

/** 1790530840 -> '2026-09-28 16:20:40 UTC' */
export function utc(ts) {
  const d = new Date(ts * 1000)
  return Number.isNaN(d.getTime()) ? String(ts) : d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
}
