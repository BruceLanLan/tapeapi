// @experimental Visitor grants: the EIP-712 types a VISITOR's wallet signs to let one app
// call a few methods of another app's TapeAPI service on the visitor's behalf (VisitorGrant, GrantRevocation), their
// hashes, the human-readable `statement`, the wallet payload, and the per-request call proof the calling app signs with
// its one-off key. Pure: no chain reads, no network. Nothing here is covered by the package's compatibility promise
// (2.x): it is a PROTOTYPE, NOT a TAP, and no service knows it. Its format text is spec/TAPI-28.md (Experimental under
// TAPI-1 §4.1); where the two differ, this code is authoritative.
// 访客授权（实验性）：访客钱包签的 EIP-712 类型（VisitorGrant、GrantRevocation）、哈希、人话 statement、
// 钱包载荷，以及调用方用一次性钥匙对每次请求签的调用证明。纯函数：不读链、不联网。不受本包兼容承诺约束；是**原型**，
// 不是 TAP，没有任何服务认识它。格式说明见 spec/TAPI-28.md（实验性）；两者不一致时以本代码为准。
//
// Domain: its OWN EIP-712 domain, name "TapeAPI Visitor Grant", version "1", chainId = the called app's chain,
// verifyingContract = that chain's DeWEB hub (this prototype uses the hub, not the called app's container; the other
// choice would be a new domain version). It is never the TAP-11 domain (name
// "TapeAPI"): a visitor flow never builds a TAP-11 type, and a signature over one type is never a signature over another
// (tested both ways, also against Delegation, Mandate, Voucher).
// 域：独立的 EIP-712 域（"TapeAPI Visitor Grant"、"1"、被调用方所在链、该链 DeWEB hub）。此处用 hub（不是被调用方的容器），
// 改选即新的域版本。永不与 TAP-11 域（"TapeAPI"）或付款凭证域复用。
//
// Choices made here that could go another way: / 此处做出、可以另选的选择：
//  D1 the type strings below are EIP-712 encodeType: no spaces and no line breaks, however a document may lay them
//     out for reading. / 类型串是 EIP-712 的 encodeType：没有空格与换行，不论文档怎样排版。
//  D2 the statement's time format is "YYYY-MM-DD HH:MM:SS UTC" (exact to the second, so the rebuilt text is
//     unambiguous); notBefore / expires are therefore bounded by 9999-12-31 23:59:59 (a 4-digit year).
//     时间格式精确到秒；因此时间上限为 9999 年末（四位年份）。
//  D3 GrantRevocation.grantHashes is bounded at 24, as MandateRevocation's list is.
//     撤销列表上限 24，与 MandateRevocation 一致。
//  D4 the statement wording (zh and en) is a first draft; a change of wording is a new `v`, never an edit of v1.
//     / 措辞是初稿；改措辞即升 v，不改 v1。
import { keccak_256 } from '@noble/hashes/sha3'
import { concatBytes, utf8ToBytes, randomBytes } from '@noble/hashes/utils'
import { TapeAPIError } from '@tapeapi/sdk'
import { canonicalJSON } from '@tapeapi/sdk/canon'
import { encodeParams, hexToBytes, toHex, isAddress, eqAddr, checksumAddress, ZERO_ADDRESS } from '@tapeapi/sdk/abi'
import { typedDigest, domainSeparator, signDigest, personalDigest, recoverAddress } from '@tapeapi/sdk/sig'
import { parseTapeName } from '@tapeapi/sdk/chains'

const fail = (msg) => { throw new TapeAPIError('GRANT_INVALID', msg) }

// ---------- constants / 常量 ----------
/** the wire format version; it also pins the statement templates / 线上格式版本，同时钉住 statement 模板 */
export const GRANT_FORMAT_VERSION = 1
export const GRANT_DOMAIN_NAME = 'TapeAPI Visitor Grant'
export const GRANT_DOMAIN_VERSION = '1'
export const VISITOR_GRANT_TYPE = 'VisitorGrant(string statement,address user,address caller,string callerName,address callerHolder,address callerKey,address audience,string audienceName,address audienceHolder,string[] methods,uint32 maxCalls,uint64 notBefore,uint64 expires,bytes32 nonce)'
export const GRANT_REVOCATION_TYPE = 'GrantRevocation(address user,bytes32[] grantHashes,uint64 revokedBefore,uint64 issued)'
const th = (s) => keccak_256(utf8ToBytes(s))
export const VISITOR_GRANT_TYPEHASH = th(VISITOR_GRANT_TYPE)
export const GRANT_REVOCATION_TYPEHASH = th(GRANT_REVOCATION_TYPE)
export const MAX_GRANT_METHODS = 8
export const MAX_GRANT_CALLS = 10_000
export const MAX_GRANT_LIFE_S = 7 * 86400
export const DEFAULT_GRANT_LIFE_S = 3600
/** notBefore may lie at most this far ahead; a call proof's ts may differ from the service's clock by at most this */
export const GRANT_SKEW_S = 300
export const MAX_REVOKED_GRANTS = 24                      // D3
export const MAX_USER_SIG_BYTES = 1024                    // an EIP-1271 signature may be longer than 65 bytes
export const METHOD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
/** ASCII "TAPI-grant/call1": 16 bytes, unlike TAP-13's "TAPI-1/resp/v2" (14) / 调用证明前缀 */
export const CALL_PROOF_PREFIX = 'TAPI-grant/call1'
export const CALL_PROOF_PREIMAGE_BYTES = 140
const MAX_TIME_S = 253_402_300_799                        // 9999-12-31 23:59:59 UTC (D2)
const MAX_STATEMENT_CHARS = 2048
const HASH_RE = /^0x[0-9a-f]{64}$/
const SIG65_RE = /^0x[0-9a-fA-F]{130}$/
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const MESSAGE_KEYS = ['statement', 'user', 'caller', 'callerName', 'callerHolder', 'callerKey', 'audience', 'audienceName', 'audienceHolder', 'methods', 'maxCalls', 'notBefore', 'expires', 'nonce']

// ---------- field checks / 字段检查 ----------
function addr(v, name) {
  if (!isAddress(v)) fail(`${name} must be a 20-byte 0x address`)
  if (v.toLowerCase() === ZERO_ADDRESS) fail(`${name} must not be the zero address`)
  return checksumAddress(v)
}
function hash32(v, name) {
  if (v instanceof Uint8Array) { if (v.length !== 32) fail(`${name} must be 32 bytes`); v = toHex(v) }
  if (typeof v !== 'string' || !HASH_RE.test(v)) fail(`${name} must be 0x and 64 lower-case hex digits`)
  if (/^0x0{64}$/.test(v)) fail(`${name} must not be zero`)
  return v
}
function time(v, name) {
  if (!Number.isSafeInteger(v) || v < 0 || v > MAX_TIME_S) fail(`${name} must be whole Unix seconds up to ${MAX_TIME_S}`)
  return v
}
/** TAP-10 §3.1: the canonical on-chain name, `<#ID>.<processor>.tape` (or with an area code), exactly as written */
function tapeName(v, name) {
  const p = typeof v === 'string' ? parseTapeName(v) : null
  if (!p || p.error || p.name !== v) fail(`${name} must be a TapeOut name in canonical form (TAP-10 §3.1), like 4246.0.tape`)
  return v
}

/**
 * Check a VisitorGrant message and return a normalised copy (checksummed addresses). Shape rules only:
 * NOT the statement (statementMatches), NOT time against a clock (the verifier), NOT the chain. `{ wire: true }`: a
 * message received from someone else: exactly the 14 members, nothing else.
 * 检查形状并返回规范化副本；不查 statement（statementMatches）、不按时钟查时间、不读链。wire：恰好 14 个成员。
 */
export function normalizeGrant(m, { wire = false } = {}) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) fail('grant message must be an object')
  if (wire) {
    const keys = Object.keys(m).sort()
    if (keys.length !== MESSAGE_KEYS.length || keys.join() !== [...MESSAGE_KEYS].sort().join()) fail(`grant message must have exactly the members ${MESSAGE_KEYS.join(', ')}`)
  }
  if (typeof m.statement !== 'string' || m.statement.length > MAX_STATEMENT_CHARS) fail(`statement must be a string of at most ${MAX_STATEMENT_CHARS} characters`)
  const out = {
    statement: m.statement,
    user: addr(m.user, 'user'), caller: addr(m.caller, 'caller'), callerName: tapeName(m.callerName, 'callerName'),
    callerHolder: addr(m.callerHolder, 'callerHolder'), callerKey: addr(m.callerKey, 'callerKey'),
    audience: addr(m.audience, 'audience'), audienceName: tapeName(m.audienceName, 'audienceName'), audienceHolder: addr(m.audienceHolder, 'audienceHolder'),
    methods: null, maxCalls: m.maxCalls, notBefore: time(m.notBefore, 'notBefore'), expires: time(m.expires, 'expires'), nonce: hash32(m.nonce, 'nonce'),
  }
  // callerKey is required and is not the user: there is no bearer path
  // callerKey 必填且不等于 user：没有"持有即用"路径
  if (eqAddr(out.callerKey, out.user)) fail('callerKey must not be the user')
  if (!Array.isArray(m.methods) || m.methods.length < 1 || m.methods.length > MAX_GRANT_METHODS) fail(`methods must list 1 to ${MAX_GRANT_METHODS} method names`)
  const seen = new Set()
  out.methods = m.methods.map((x, i) => {
    // no wildcard can be written: `*` is not a method name / 通配不可表达
    if (typeof x !== 'string' || !METHOD_NAME_RE.test(x)) fail(`methods[${i}] must match ${METHOD_NAME_RE} (no wildcard)`)
    if (seen.has(x)) fail(`methods[${i}] repeats ${x}`)
    seen.add(x)
    return x
  })
  // unlimited calls cannot be written: 1..10,000 / 不限次不可表达
  if (!Number.isSafeInteger(out.maxCalls) || out.maxCalls < 1 || out.maxCalls > MAX_GRANT_CALLS) fail(`maxCalls must be a whole number from 1 to ${MAX_GRANT_CALLS}`)
  if (out.expires <= out.notBefore) fail('expires must be after notBefore')
  if (out.expires - out.notBefore > MAX_GRANT_LIFE_S) fail(`a grant lives at most ${MAX_GRANT_LIFE_S} s (7 days): expires - notBefore is ${out.expires - out.notBefore}`)
  return out
}

// ---------- the statement (v1 templates) / 人话 statement（v1 模板） ----------
// Generated from the other fields, never free text; the service rebuilds it and compares it character for character.
// Only the two names, the methods, the count, the times (UTC), "no payment" and how to revoke; no address, no key.
// 由其余字段确定性生成，不是自由文本；服务方重建并逐字比对。只含两个名字、方法、次数、起止时间（UTC）、"不含付款"与撤销方式。
const utc = (s) => new Date(s * 1000).toISOString().slice(0, 19).replace('T', ' ')
export const STATEMENT_TEMPLATES = Object.freeze({
  zh: (m) => `允许 ${m.callerName} 代表我调用 ${m.audienceName} 的方法：${m.methods.join(', ')}。最多 ${m.maxCalls} 次，${utc(m.notBefore)} 至 ${utc(m.expires)} UTC 有效。本授权不含任何付款。可随时向 ${m.audienceName} 撤销。`,
  en: (m) => `Allow ${m.callerName} to call these methods of ${m.audienceName} on my behalf: ${m.methods.join(', ')}. At most ${m.maxCalls} call${m.maxCalls === 1 ? '' : 's'}, valid from ${utc(m.notBefore)} to ${utc(m.expires)} UTC. This grant includes no payment. Revocable at any time with ${m.audienceName}.`,
})
export const STATEMENT_LANGS = Object.freeze(Object.keys(STATEMENT_TEMPLATES))
/** The statement of `m` in `lang` ('zh' or 'en'), from the fields other than `statement`. / 由其余字段生成 */
export function renderStatement(m, lang = 'en') {
  const t = STATEMENT_TEMPLATES[lang]
  if (!t) fail(`statement language must be one of ${STATEMENT_LANGS.join(', ')}`)
  return t(normalizeGrant({ ...m, statement: '' }))
}
/** true when m.statement is, character for character, one of the v1 renderings / 逐字等于某个 v1 渲染 */
export function statementMatches(m) {
  let n
  try { n = normalizeGrant(m) } catch { return false }
  return STATEMENT_LANGS.some((l) => STATEMENT_TEMPLATES[l](n) === n.statement)
}

// ---------- hashes / 哈希 ----------
export function grantDomain(chainId, hub) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) fail('chainId must be a positive safe integer')
  if (!isAddress(hub)) fail('hub must be an address (the chain\'s DeWEB hub)')
  return { name: GRANT_DOMAIN_NAME, version: GRANT_DOMAIN_VERSION, chainId, verifyingContract: checksumAddress(hub) }
}
const strHash = (s) => keccak_256(utf8ToBytes(s))
/** EIP-712 hashStruct(VisitorGrant); string[] is keccak256 of the concatenated keccak256 of each UTF-8 element */
export function hashVisitorGrant(grant) {
  const m = normalizeGrant(grant)
  const methods = keccak_256(concatBytes(...m.methods.map(strHash)))
  return keccak_256(encodeParams(
    ['bytes32', 'bytes32', 'address', 'address', 'bytes32', 'address', 'address', 'address', 'bytes32', 'address', 'bytes32', 'uint32', 'uint64', 'uint64', 'bytes32'],
    [VISITOR_GRANT_TYPEHASH, strHash(m.statement), m.user, m.caller, strHash(m.callerName), m.callerHolder, m.callerKey, m.audience, strHash(m.audienceName), m.audienceHolder, methods, BigInt(m.maxCalls), BigInt(m.notBefore), BigInt(m.expires), hexToBytes(m.nonce)],
  ))
}
/** The 32 bytes the visitor's wallet signs; also the grant's identity `grantHash` (another chain or hub, another hash) */
export function grantDigest(chainId, hub, m) { return typedDigest(grantDomain(chainId, hub), hashVisitorGrant(m)) }
export function grantHashOf(chainId, hub, m) { return toHex(grantDigest(chainId, hub, m)) }
export function grantDomainSeparator(chainId, hub) { return toHex(domainSeparator(grantDomain(chainId, hub))) }

// ---------- building a grant (the calling app, for the visitor's wallet) / 构造授权 ----------
/**
 * The message the calling app asks the visitor's wallet to sign, with the statement generated. Defaults: notBefore =
 * now, a life of DEFAULT_GRANT_LIFE_S (1 h), a random nonce, the English statement. Refuses notBefore more than
 * GRANT_SKEW_S ahead of `now`. The identities (caller / callerHolder / audienceHolder) must come from chain reads, never
 * from the request (prepareGrant in interop-verify.js reads them).
 * 构造交给访客钱包签的消息并生成 statement。默认 notBefore = now、1 小时、随机 nonce、英文。身份字段必须来自读链。
 */
export function makeGrant({ user, caller, callerName, callerHolder, callerKey, audience, audienceName, audienceHolder, methods, maxCalls, notBefore, expires, lifeS = DEFAULT_GRANT_LIFE_S, nonce, lang = 'en', now }) {
  if (!Number.isSafeInteger(now)) fail('makeGrant needs `now` in Unix seconds')
  const nb = notBefore ?? now
  const m = { statement: '', user, caller, callerName, callerHolder, callerKey, audience, audienceName, audienceHolder, methods, maxCalls, notBefore: nb, expires: expires ?? nb + lifeS, nonce: nonce ?? toHex(randomBytes(32)) }
  const n = normalizeGrant(m)
  if (n.notBefore > now + GRANT_SKEW_S) fail(`notBefore lies more than ${GRANT_SKEW_S} s ahead`)
  n.statement = renderStatement(n, lang)
  return n
}

const DOMAIN_FIELDS = [
  { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
]
const GRANT_FIELDS = [
  { name: 'statement', type: 'string' }, { name: 'user', type: 'address' }, { name: 'caller', type: 'address' },
  { name: 'callerName', type: 'string' }, { name: 'callerHolder', type: 'address' }, { name: 'callerKey', type: 'address' },
  { name: 'audience', type: 'address' }, { name: 'audienceName', type: 'string' }, { name: 'audienceHolder', type: 'address' },
  { name: 'methods', type: 'string[]' }, { name: 'maxCalls', type: 'uint32' }, { name: 'notBefore', type: 'uint64' },
  { name: 'expires', type: 'uint64' }, { name: 'nonce', type: 'bytes32' },
]
/** The notice shown next to (never instead of) the wallet: the one thing the visitor checks. / 提示：用户只需核对一件事 */
export const GRANT_WALLET_NOTICE = 'Check one thing: the caller named in the first line must be the site your wallet says the request comes from. This grant includes no payment.'
export const GRANT_WALLET_NOTICE_ZH = '只需核对一件事：第一行里的调用方名字，必须与钱包顶部"请求来自"的站点是同一个。本授权不含任何付款。'
/**
 * eth_signTypedData_v4 payload; the statement is the FIRST field, so a wallet showing fields in order shows the sentence
 * first. Refuses a message whose statement is not a v1 rendering of its fields. `display` (for the page, never the
 * wallet): the notice and the times in words.
 * 钱包载荷；statement 是第一个字段。statement 不是 v1 渲染的消息一律拒绝。display 只给页面，不给钱包。
 */
export function grantTypedData(chainId, hub, grant) {
  const m = normalizeGrant(grant)
  if (!statementMatches(m)) fail('statement is not a v1 rendering of the grant\'s fields (it must be generated, never written)')
  return {
    display: { notice: [GRANT_WALLET_NOTICE, GRANT_WALLET_NOTICE_ZH], notBefore: utc(m.notBefore) + ' UTC', expires: utc(m.expires) + ' UTC' },
    domain: grantDomain(chainId, hub),
    types: { EIP712Domain: DOMAIN_FIELDS, VisitorGrant: GRANT_FIELDS },
    primaryType: 'VisitorGrant',
    message: { ...m, methods: [...m.methods] },
  }
}

// ---------- GrantRevocation ----------
// Revokes every listed grant of `user`, and every grant of `user` whose notBefore is below `revokedBefore` (0: none by
// date). / 撤销列出的授权，以及 notBefore 早于 revokedBefore 的全部授权（0 表示不按时间）
export function normalizeGrantRevocation(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) fail('revocation must be an object')
  const keys = Object.keys(r).sort().join()
  if (keys !== 'grantHashes,issued,revokedBefore,user') fail('revocation must have exactly the members user, grantHashes, revokedBefore, issued')
  if (!Array.isArray(r.grantHashes) || r.grantHashes.length > MAX_REVOKED_GRANTS) fail(`grantHashes must be an array of at most ${MAX_REVOKED_GRANTS} hashes`)
  const out = { user: addr(r.user, 'user'), grantHashes: r.grantHashes.map((h, i) => hash32(h, `grantHashes[${i}]`)), revokedBefore: time(r.revokedBefore, 'revokedBefore'), issued: time(r.issued, 'issued') }
  if (!out.grantHashes.length && out.revokedBefore === 0) fail('a revocation must list a grant hash or set revokedBefore')
  return out
}
export function hashGrantRevocation(revocation) {
  const r = normalizeGrantRevocation(revocation)
  const list = keccak_256(concatBytes(...r.grantHashes.map((h) => hexToBytes(h))))
  return keccak_256(encodeParams(['bytes32', 'address', 'bytes32', 'uint64', 'uint64'], [GRANT_REVOCATION_TYPEHASH, r.user, list, BigInt(r.revokedBefore), BigInt(r.issued)]))
}
export function grantRevocationDigest(chainId, hub, r) { return typedDigest(grantDomain(chainId, hub), hashGrantRevocation(r)) }
export function grantRevocationTypedData(chainId, hub, revocation) {
  const r = normalizeGrantRevocation(revocation)
  return {
    domain: grantDomain(chainId, hub),
    types: { EIP712Domain: DOMAIN_FIELDS, GrantRevocation: [{ name: 'user', type: 'address' }, { name: 'grantHashes', type: 'bytes32[]' }, { name: 'revokedBefore', type: 'uint64' }, { name: 'issued', type: 'uint64' }] },
    primaryType: 'GrantRevocation',
    message: { ...r, grantHashes: [...r.grantHashes] },
  }
}

// ---------- the wallet payload / 钱包载荷 ----------
const WALLET_SPEC = {
  VisitorGrant: (td) => grantTypedData(td.domain.chainId, td.domain.verifyingContract, td.message),
  GrantRevocation: (td) => grantRevocationTypedData(td.domain.chainId, td.domain.verifyingContract, td.message),
}
/**
 * What goes to eth_signTypedData_v4: domain, types, primaryType and message only, REBUILT by this module and compared
 * with the input (a member more or less, a changed domain or a statement that does not match its fields is refused).
 * `expect` (required): { chainId, hub } the page expects, and for a grant also { callerName, audienceName }: the names
 * the page itself resolved. / 交给钱包前重建比对；expect 必传：页面期望的链、hub，授权还要页面自己解析过的两个名字。
 */
export function grantForWallet(td, expect) {
  const what = 'grantForWallet takes a typed-data result of grantTypedData or grantRevocationTypedData'
  if (!td || typeof td !== 'object' || !td.domain || typeof td.domain !== 'object' || !td.types || !td.message || !WALLET_SPEC[td.primaryType]) fail(what)
  if (!expect || typeof expect !== 'object' || !Number.isSafeInteger(expect.chainId) || !isAddress(expect.hub)) fail('grantForWallet: pass the chainId and hub the page expects: grantForWallet(td, { chainId, hub, ... })')
  const d = td.domain
  if (d.name !== GRANT_DOMAIN_NAME || d.version !== GRANT_DOMAIN_VERSION) fail(`grantForWallet: the domain must be "${GRANT_DOMAIN_NAME}" version "${GRANT_DOMAIN_VERSION}" (never the TAP-11 "TapeAPI" domain)`)
  if (d.chainId !== expect.chainId) fail(`grantForWallet: the payload is for chain ${d.chainId}, the page expects ${expect.chainId}`)
  if (!isAddress(d.verifyingContract) || !eqAddr(d.verifyingContract, expect.hub)) fail(`grantForWallet: the payload names verifyingContract ${d.verifyingContract}, the page expects ${expect.hub}`)
  if (td.primaryType === 'VisitorGrant') {
    if (typeof expect.callerName !== 'string' || typeof expect.audienceName !== 'string') fail('grantForWallet: for a grant, pass the callerName and audienceName the page resolved itself')
    if (td.message.callerName !== expect.callerName || td.message.audienceName !== expect.audienceName) fail(`grantForWallet: the grant names ${td.message.callerName} -> ${td.message.audienceName}, the page expects ${expect.callerName} -> ${expect.audienceName}`)
  }
  const copy = (v) => { try { return JSON.parse(JSON.stringify(v)) } catch (e) { fail(`${what}: ${e.message}`) } }
  let want
  try { want = WALLET_SPEC[td.primaryType](td) } catch (e) { fail(`${what}: ${e.message}`) }
  const same = (a, b) => { try { return canonicalJSON(copy(a)) === canonicalJSON(copy(b)) } catch { return false } }
  for (const k of ['domain', 'types', 'message']) if (!same(td[k], want[k])) fail(`${what}: its ${k} differs from what this module builds`)
  return { payload: { domain: copy(want.domain), types: copy(want.types), primaryType: want.primaryType, message: copy(want.message) }, ...(want.display ? { display: copy(want.display) } : {}) }
}

// ---------- signing with a local key (tests, scripts; a wallet signs the typed data) / 本地钥匙签名 ----------
// No EIP-191 prefix: the wallet signs the typed digest itself (eth_signTypedData_v4). / 无 EIP-191 前缀
export function signGrant(chainId, hub, m, pk) {
  if (!statementMatches(m)) fail('signGrant: statement is not a v1 rendering of the grant\'s fields')
  return signDigest(grantDigest(chainId, hub, m), pk)
}
export const signGrantRevocation = (chainId, hub, r, pk) => signDigest(grantRevocationDigest(chainId, hub, r), pk)

// ---------- the call proof (the calling app's one-off key, every request) / 调用证明 ----------
// preimage (140 bytes) = "TAPI-grant/call1"(16) ‖ audience(20) ‖ grantHash(32) ‖ keccak(utf8(id))(32)
//                        ‖ keccak(utf8(canonicalJSON({method, params})))(32) ‖ uint64 ts(8)
// signed EIP-191 over the 32-byte keccak of the preimage, as TAP-13 §5 signs an answer; v 27/28, low s. Another prefix
// and another length than "TAPI-1/resp/v2", so a proof is never an answer nor the reverse; it binds the params, so a
// man in the middle cannot change them and race the request.
// 前缀与长度都不同于 TAP-13 的回答摘要；绑定 params，中间人改参数抢先重放会失败。
export function callProofPreimage({ audience, grantHash, id, method, params, ts }) {
  if (!isAddress(audience)) fail('audience must be an address')
  if (typeof grantHash !== 'string' || !HASH_RE.test(grantHash)) fail('grantHash must be 0x and 64 lower-case hex digits')
  if (typeof id !== 'string' || !id || id.length > 128) fail('id must be a string of 1..128 characters')
  // FIXED IR-4 (review 2026-10-22): utf8ToBytes writes U+FFFD for a lone surrogate, so two such ids would share a proof
  // 孤立代理项会被写成 U+FFFD，两个这样的 id 会共用一份证明
  if (LONE_SURROGATE.test(id)) fail('id must be well-formed Unicode (no lone UTF-16 surrogate)')
  if (typeof method !== 'string') fail('method must be a string')
  if (!Number.isSafeInteger(ts) || ts < 0) fail('ts must be whole Unix seconds')
  const out = concatBytes(
    utf8ToBytes(CALL_PROOF_PREFIX), hexToBytes(audience), hexToBytes(grantHash), keccak_256(utf8ToBytes(id)),
    keccak_256(utf8ToBytes(canonicalJSON({ method, params: params == null ? {} : params }))), encodeParams(['uint64'], [BigInt(ts)]).slice(24),
  )
  if (out.length !== CALL_PROOF_PREIMAGE_BYTES) fail('call proof preimage is not 140 bytes')
  return out
}
export function callProofDigest(o) { return keccak_256(callProofPreimage(o)) }
/** { ts, sig } for one request, signed with the calling app's one-off key / 用调用方一次性钥匙签一次请求 */
export function signCallProof(o, callerKeyPk) { return { ts: o.ts, sig: signDigest(personalDigest(callProofDigest(o)), callerKeyPk) } }
/** the key that signed a call proof, or null / 恢复调用证明的签名者 */
export function recoverCallProofSigner(o, sig) {
  if (typeof sig !== 'string' || !SIG65_RE.test(sig)) return null
  try { return recoverAddress(personalDigest(callProofDigest(o)), sig, { strictV: true }) } catch { return null }
}

/** The request's top-level `grant` member (wire form) / 请求顶层 grant 成员 */
export function wireGrant({ chainId, message, userSig, proof }) {
  return { v: GRANT_FORMAT_VERSION, chainId, message: { ...message, methods: [...message.methods] }, userSig, proof: { ts: proof.ts, sig: proof.sig } }
}
