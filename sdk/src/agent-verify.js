// @experimental (1.7) Container agents, phase 0: verifying a mandate, a task thread and the evidence a delivery carries.
// Every decision reads the chain through the client it is given (createAgentKit(api)) under TAP-10 strict agreement
// ({ answers: 'tap10', strict: true }: every configured node, from at least max(2, min(3, operators)) operators), so one
// operator that lies cannot make a check pass. An RPC failure is thrown, never turned into a verdict.
// What phase 0 does NOT do, and every result says so with `enforcement: 'none'`: no contract enforces any amount, time or
// counterparty. A mandate is a holder's signed statement that a counterparty can check; nothing more.
// See docs/DESIGN-container-agent.md (internal draft). Not covered by the 1.x compatibility promise.
import { sha256 } from '@noble/hashes/sha256'
import { TapeAPIError } from './errors.js'
import { safeParseJSON } from './canon.js'
import { selector, encodeParams, encodeCall, decodeReturn, hexToBytes, toHex, bytesToHex, isAddress, eqAddr, checksumAddress, ZERO_ADDRESS } from './abi.js'
import { recoverAddress, recoverResponseSigner, recoverResponseSignerFromHashes } from './sig.js'
import { chainById, formatTapeName } from './chains.js'
import { PROCESSORS_SNAPSHOT } from './processors-snapshot.js'
import {
  normalizeMandate, mandateDigest, normalizeTaskOffer, taskOfferDigest, normalizeTaskVerdict, taskVerdictDigest,
  normalizeMandateRevocation, mandateRevocationDigest, taskHashOf, jsonHashOf, VERDICT_ACCEPT, VERDICT_REJECT, phase0Problems,
} from './agent-sig.js'

export const MANDATES_KEY = '.well-known/tapeapi-mandates.json'   // the principal's revocation list (site file)
export const MANDATES_LIMIT = 4 * 1024
export const MANDATES_FORMAT = '0'                                // `tapeapi-mandates` member of the file
export const MAX_MANDATE_S = 30 * 86400                           // expires − notBefore, as TAPI-22's MAX_SESSION
export const REVOCATION_ISSUED_SKEW_S = 300
/**
 * The bytes of the principal's revocation list (MANDATES_KEY), serialised compactly (no whitespace: a pretty-printed
 * list of the maximum size can exceed MANDATES_LIMIT and then makes every mandate of that principal unavailable). Checks
 * the revocation, the signature's shape and the size; the holder signs mandateRevocationTypedData first.
 * 撤销清单文件的字节：紧凑序列化（美化输出的最大清单会超限），并检查撤销、签名形状与尺寸。
 */
export function revocationFileBytes({ chainId, revocation, sig } = {}) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new TapeAPIError('INVALID_ARGUMENT', 'chainId must be a positive integer')
  if (typeof sig !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){65,1024}$/.test(sig)) throw new TapeAPIError('INVALID_ARGUMENT', 'sig must be a signature of 65 to 1024 bytes')
  const r = normalizeMandateRevocation(revocation)
  const bytes = new TextEncoder().encode(JSON.stringify({ 'tapeapi-mandates': MANDATES_FORMAT, chainId, revocation: r, sig }))
  if (bytes.length > MANDATES_LIMIT) throw new TapeAPIError('INVALID_ARGUMENT', `the revocation list is ${bytes.length} bytes, over ${MANDATES_LIMIT}`)
  return bytes
}
export const THREAD_KINDS = Object.freeze(['offer', 'accept', 'mandate', 'deliver', 'acceptance', 'revocation'])
// Named in the public Idea (#41) and kept as names only: a thread that carries one is refused, not guessed at.
export const RESERVED_KINDS = Object.freeze(['quote', 'progress', 'reject', 'cancel', 'dispute'])
export const KIND_PREFIX = 'tape.agent/'
export const TASK_STATES = Object.freeze(['Offered', 'Accepted', 'Active', 'Delivered', 'Settled', 'Expired', 'Rejected', 'Cancelled'])
// What an evidence bundle proves, in the words every result carries / 证据包证明什么、不证明什么
export const EVIDENCE_PROVES = 'each listed call was answered and signed by the signer the named container\'s current manifest publishes; its time is the time the receipt itself states'
export const EVIDENCE_DOES_NOT_PROVE = Object.freeze(['that the calls were needed', 'that the answers were right', 'that the deliverable is correct or complete'])

const STRICT = Object.freeze({ answers: 'tap10', strict: true })
const CACHE_MS = 60_000
const NONCE_BLOCKING = new Set(['phase0-no-funds', 'subdelegate-not-allowed', 'mandate-too-long', 'agent-key-mismatch', 'agent-mismatch'])
const ZERO32 = '0x' + '00'.repeat(32)
const isRevert = (e) => e instanceof TapeAPIError && e.code === 'RPC_ERROR' && (Number(e.data?.rpcCode) === 3 || e.data?.rpcRevert === true)
const notAnAnswer = (e) => isRevert(e) || (e instanceof TapeAPIError && e.code === 'ABI_INVALID')
const problem = (code, message) => ({ code, message })
const isStore = (s) => s && typeof s.get === 'function' && typeof s.set === 'function'

// Text a counterparty wrote (a manifest name, a task title) is rendered as plain text with every invisible character
// removed: format characters (Cf), Default_Ignorable_Code_Point (assigned or not: tag characters U+E0001-E007F can hide a
// whole sentence), controls other than line feed and tab (Cc), the line and paragraph separators, the braille blank and
// U+1D159. Stricter than the list of TAP-10 §16, and the same predicate as mcp.js invisibleProblems.
// 对方写的文字去掉一切不可见字符：Cf、Default_Ignorable（含能藏整句话的 tag 字符）、除换行与制表符外的 Cc、行/段分隔符、
// 盲文空白与 U+1D159。比 TAP-10 §16 的列表更严，与 mcp.js invisibleProblems 同一谓词。
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]|(?![\n\t])\p{Cc}/gu
const BLANKS = new Set([0x2800, 0x1d159])
export function plainText(s, max = 200) {
  if (typeof s !== 'string') return ''
  return [...s.replace(INVISIBLE, '')].filter((c) => !BLANKS.has(c.codePointAt(0))).slice(0, max).join('')
}

/**
 * @experimental (1.7) Container-agent checks bound to one client. `api` is a createTapeAPI() client with rpcUrls.
 *   clock             () => Unix seconds (default: the system clock)
 *   revocationFloor   { get, set }: highest `issued` of a principal's revocation list seen (default: this kit only).
 *                     Keep it where the principals you check cannot write. / 撤销清单 issued 下限
 *   nonces            { get, set }: (chain, principal, nonce) -> the mandateHash first seen with it (default: this kit
 *                     only). Nonce reuse is detectable only by whoever keeps this store. / nonce 存储
 *   resolve           (container) => resolved service; default api.resolve. Only the function can be replaced, never the
 *                     signer it yields. / 只能替换解析函数
 */
export function createAgentKit(api, opts = {}) {
  if (!api || typeof api !== 'object' || !api.chain || !api.addresses) throw new TapeAPIError('INVALID_ARGUMENT', 'createAgentKit takes a createTapeAPI() client')
  if (opts.clock !== undefined && typeof opts.clock !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', 'clock must be a function returning Unix seconds')
  if (opts.revocationFloor !== undefined && !isStore(opts.revocationFloor)) throw new TapeAPIError('INVALID_ARGUMENT', 'revocationFloor must be a { get, set } store')
  if (opts.nonces !== undefined && !(opts.nonces instanceof Map) && typeof opts.nonces?.setIfAbsent !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', 'nonces must be a Map or a { setIfAbsent(key, value) => previous value } store (one atomic step)')
  if (opts.resolve !== undefined && typeof opts.resolve !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', 'resolve must be a function')
  const chainId = Number(api.chainId)
  const { hub, siteRegistry, factory } = api.addresses
  const clock = opts.clock ?? (() => Math.floor(Date.now() / 1000))
  const floors = opts.revocationFloor ?? new Map()
  // setIfAbsent in one step, so two mandates with one nonce checked at the same time cannot both pass; a Map is wrapped
  // (has and set run in the same turn). / 一步完成的 setIfAbsent：同时核验两张同 nonce 的授权书不会都通过
  const nonceMap = opts.nonces instanceof Map ? opts.nonces : (opts.nonces ? null : new Map())
  const nonces = nonceMap ? { setIfAbsent: (k, v) => { if (nonceMap.has(k)) return nonceMap.get(k); nonceMap.set(k, v); return undefined } } : opts.nonces
  const resolveSvc = opts.resolve ?? ((c) => api.resolve(c))
  // Strict agreement needs nodes of two operators at least: one operator could otherwise answer every check alone.
  // 严格共识至少要两家运营方的节点：否则一家就能独自回答每个检查。
  const needRpc = () => {
    if (!api.rpc) throw new TapeAPIError('INVALID_ARGUMENT', 'container-agent checks read the chain: create the client with rpcUrls')
    if (api.rpc.degraded || (api.rpc.operators?.length ?? 0) < 2) throw new TapeAPIError('INVALID_ARGUMENT', 'container-agent checks need nodes of at least two operators (strict agreement); a single-node client cannot make them')
    return api.rpc
  }

  // ---- strict reads / 严格读取 ----
  const strictCall = async (to, name, args) => decodeReturn(name, await needRpc().ethCall(to, encodeCall(name, args), 'latest', STRICT))
  async function hasCode(a) { return String(await needRpc().call('eth_getCode', [a, 'latest'], STRICT)) !== '0x' }
  // TAP-11 §4.4: a 65-byte signature is ECDSA first, and a malformed one is refused WITHOUT trying EIP-1271; a well-formed
  // one that recovers to someone else, or a longer one, is asked of the holder under EIP-1271 (strict reads).
  async function holderSigned(holder, digest, sig) {
    if (typeof sig !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){65,1024}$/.test(sig)) return false
    if (sig.length === 132) {
      let recovered
      try { recovered = recoverAddress(digest, sig) } catch { return false }
      if (eqAddr(recovered, holder)) return true
    }
    if (!(await hasCode(holder))) return false
    const data = selector('isValidSignature(bytes32,bytes)') + bytesToHex(encodeParams(['bytes32', 'bytes'], [toHex(digest), sig]))
    let out
    try { out = String(await needRpc().ethCall(holder, data, 'latest', STRICT)).toLowerCase() } catch (e) { if (notAnAnswer(e)) return false; throw e }
    return out.length >= 66 && out.slice(0, 66) === '0x1626ba7e' + '0'.repeat(56)
  }
  // The on-chain name <#ID>.<processor>.tape, from the processor table snapshot confirmed by one strict cpuAt read; null
  // when the processor is not in the snapshot (the container is still shown). Never a manifest's `name`.
  async function onchainName(circuits, tokenId) {
    const snap = PROCESSORS_SNAPSHOT[chainId]
    const n = snap ? snap.list.indexOf(String(circuits).toLowerCase()) : -1
    if (n < 0 || !chainById(chainId)) return null
    let at
    try { at = await strictCall(factory, 'cpuAt', [BigInt(n)]) } catch (e) { if (notAnAnswer(e)) return null; throw e }
    if (!eqAddr(at, circuits)) return null
    try { return formatTapeName({ tokenId, processor: n, chainId }) } catch { return null }
  }
  // A container's identity: token() is only a claim, so the hub must derive this very address from that circuit, the
  // factory must know the circuit (a counterfeit ERC-721 derives accounts too), and the holder is ownerOf now. Returns
  // { identity } or { problem }. / 容器身份：token() 只是声称；中枢推导、工厂认可、当前持有人。
  // Kept for at most CACHE_MS: TAP-11 §7.1, a holder read is not relied on for more than 60 s without a reread.
  const identities = new Map()
  function identityOf(container) { return cached(identities, container, () => readIdentity(container)) }
  async function readIdentity(container) {
    if (!isAddress(container) || eqAddr(container, ZERO_ADDRESS)) return { problem: problem('not-a-container', `${container} is not an address`) }
    let tok
    try { tok = await strictCall(container, 'token', []) } catch (e) { if (notAnAnswer(e)) return { problem: problem('not-a-container', `${container} does not answer ERC-6551 token(): not a TapeOut container`) }; throw e }
    const [cid, circuits, tokenId] = tok
    if (BigInt(cid) !== BigInt(chainId)) return { problem: problem('wrong-chain', `container ${container} belongs to chain ${cid}, not ${chainId}`) }
    const derived = await strictCall(hub, 'accountOf', [circuits, tokenId])
    if (!eqAddr(derived, container)) return { problem: problem('not-a-container', `hub.accountOf(${circuits}, ${tokenId}) is ${derived}, not ${container}`) }
    let cpu
    try { cpu = await strictCall(factory, 'isCPU', [circuits]) } catch (e) { if (notAnAnswer(e)) cpu = false; else throw e }
    if (cpu !== true) return { problem: problem('not-tapeout', `${circuits} is not a TapeOut processor (factory.isCPU is false)`) }
    let holder
    try { holder = await strictCall(circuits, 'ownerOf', [tokenId]) } catch (e) { if (notAnAnswer(e)) return { problem: problem('no-such-token', `ownerOf(${tokenId}) reverted on ${circuits}`) }; throw e }
    return { identity: { container: checksumAddress(container), chainId, circuits: checksumAddress(circuits), tokenId: tokenId.toString(), holder: checksumAddress(holder), name: await onchainName(circuits, tokenId) } }
  }
  // A resolved service's signer and display name. The name is plain text marked untrusted: it carries no identity.
  const services = new Map()
  function serviceOf(container) { return cached(services, container, () => Promise.resolve().then(() => resolveSvc(container))) }
  function cached(map, key, read) {
    const k = String(key).toLowerCase()
    const e = map.get(k)
    if (e && Date.now() - e.at < CACHE_MS) return e.p
    const p = read()
    map.set(k, { at: Date.now(), p })
    p.catch(() => { if (map.get(k)?.p === p) map.delete(k) })
    if (map.size > 1024) map.delete(map.keys().next().value)
    return p
  }

  // ---- the principal's revocation list (site file) / 委托方站点上的撤销清单 ----
  // Read like a TAPI-20 manifest (fileInfo then read, the bytes must match the declared size and SHA-256), every read
  // strict. Signed by the holder (MandateRevocation); `issued` may only grow (a floor, as TAPI-26 §3.1 does for channel
  // records), so whoever can write the site cannot put back a shorter list, nor remove it once one was seen.
  // 与清单一样读取并核对字节；持有人签名；issued 只增（下限），能写站点的人既不能放回更短的清单，也不能在见过之后删掉它。
  async function readRevocations(container, identity) {
    const floorKey = `${chainId}:${String(container).toLowerCase()}`
    const floor = Number((await floors.get(floorKey)) ?? 0)
    const info = await strictCall(siteRegistry, 'fileInfo', [container, MANDATES_KEY])
    const size = Number(info.size)
    if (size === 0) return floor > 0 ? { status: 'invalid', reason: `the revocation list (issued ${floor}) was removed from the site` } : { status: 'none-published' }
    if (size > MANDATES_LIMIT) return { status: 'invalid', reason: `${MANDATES_KEY} declares ${size} bytes, limit ${MANDATES_LIMIT}` }
    if (String(info.sha256Hash).toLowerCase() === ZERO32) return { status: 'invalid', reason: `${MANDATES_KEY} has no on-chain SHA-256` }
    let raw
    try { raw = hexToBytes(await strictCall(siteRegistry, 'read', [container, MANDATES_KEY])) } catch (e) { if (isRevert(e)) return { status: 'invalid', reason: `read(${MANDATES_KEY}) reverted` }; throw e }
    if (raw.length !== size || toHex(sha256(raw)) !== String(info.sha256Hash).toLowerCase()) return { status: 'invalid', reason: `${MANDATES_KEY}: the bytes do not match fileInfo` }
    let f
    try { f = safeParseJSON(new TextDecoder('utf-8', { fatal: true }).decode(raw)) } catch (e) { return { status: 'invalid', reason: `${MANDATES_KEY}: ${e.message}` } }
    if (!f || typeof f !== 'object' || f['tapeapi-mandates'] !== MANDATES_FORMAT || f.chainId !== chainId) return { status: 'invalid', reason: `${MANDATES_KEY}: not a format ${MANDATES_FORMAT} list for chain ${chainId}` }
    let r
    try { r = normalizeMandateRevocation(f.revocation) } catch (e) { return { status: 'invalid', reason: `${MANDATES_KEY}: ${e.message}` } }
    if (!eqAddr(r.principal, container)) return { status: 'invalid', reason: `${MANDATES_KEY} names principal ${r.principal}` }
    if (r.issued > clock() + REVOCATION_ISSUED_SKEW_S) return { status: 'invalid', reason: `${MANDATES_KEY}: issued is in the future` }
    if (!(await holderSigned(identity.holder, mandateRevocationDigest(chainId, hub, r), f.sig))) return { status: 'invalid', reason: `${MANDATES_KEY} is not signed by the current holder ${identity.holder}` }
    if (r.issued < floor) return { status: 'invalid', reason: `${MANDATES_KEY}: issued ${r.issued} is older than a list already seen (${floor}): a replaced list was put back` }
    if (r.issued > floor) await floors.set(floorKey, r.issued)
    return { status: 'published', issued: r.issued, revokedBefore: r.revokedBefore, mandateHashes: r.mandateHashes }
  }
  const revokes = (r, mandateHash, m) => r.mandateHashes.includes(mandateHash) || m.notBefore < r.revokedBefore

  // A signed revocation message (the direct path): checked against the current holder; returns the normalised revocation
  // or a problem. / 直发的撤销消息
  async function checkRevocationMessage(msg, identity) {
    let r
    try { r = normalizeMandateRevocation(msg?.revocation) } catch (e) { return { problem: problem('message-malformed', `revocation: ${e.message}`) } }
    if (!eqAddr(r.principal, identity.container)) return { problem: problem('revocation-mismatch', `revocation names principal ${r.principal}, not ${identity.container}`) }
    if (!(await holderSigned(identity.holder, mandateRevocationDigest(chainId, hub, r), msg.sig))) return { problem: problem('not-signed-by-holder', `revocation is not signed by the current holder ${identity.holder}`) }
    return { revocation: r }
  }

  /**
   * @experimental (1.7) Check a signed mandate `{ mandate, sig }` (or a `tape.agent/mandate` message).
   *   agentKey, agent   when given, the mandate must name exactly these (the key the agent announced, its container); a
   *                     mismatch also keeps the nonce unrecorded. Without them nothing is compared and the nonce is
   *                     recorded (when the other checks allow it)
   *   at                Unix seconds to check the time window at (default: the clock)
   *   readSite          read the principal's revocation list (default true)
   *   revocations       signed revocation messages received directly ({ revocation, sig }), applied as well
   * Returns { ok, problems, enforcement: 'none', phase: 0, mandateHash, mandate, principal, agent, agentKey, notBefore,
   * expires, revocation }. Problems (codes): mandate-malformed, phase0-no-funds, subdelegate-not-allowed, mandate-not-yet,
   * mandate-expired, mandate-too-long, agent-key-mismatch, agent-mismatch, not-a-container, wrong-chain, not-tapeout,
   * no-such-token, not-signed-by-holder, nonce-reused, mandate-revoked, revocation-unavailable.
   */
  async function verifyMandate(signed, o = {}) {
    const problems = []
    const out = { ok: false, problems, enforcement: 'none', phase: 0 }
    let m
    try { m = normalizeMandate(signed?.mandate) } catch (e) { problems.push(problem('mandate-malformed', e.message)); return out }
    const digest = mandateDigest(chainId, hub, m)
    const mandateHash = toHex(digest)
    Object.assign(out, { mandateHash, mandate: m, agent: m.agent, agentKey: m.agentKey, notBefore: m.notBefore, expires: m.expires })
    // Phase 0: nothing enforces an amount, so a mandate names none (caps and fee cap 0, tokens the zero address) and allows
    // no sub-delegation / 阶段 0：没有任何东西强制金额，所以授权书不写金额与资产，也不许转委托
    const phase0 = phase0Problems(m)
    problems.push(...phase0)
    const now = o.at ?? clock()
    if (now < m.notBefore) problems.push(problem('mandate-not-yet', `valid from ${m.notBefore}, now ${now}`))
    if (now > m.expires) problems.push(problem('mandate-expired', `expired at ${m.expires}, now ${now}`))
    if (m.expires - m.notBefore > MAX_MANDATE_S) problems.push(problem('mandate-too-long', `a mandate spans at most ${MAX_MANDATE_S} s, this one ${m.expires - m.notBefore} s`))
    if (o.agentKey !== undefined && !eqAddr(o.agentKey, m.agentKey)) problems.push(problem('agent-key-mismatch', `the mandate names agentKey ${m.agentKey}, the agent announced ${o.agentKey}`))
    if (o.agent !== undefined && !eqAddr(o.agent, m.agent)) problems.push(problem('agent-mismatch', `the mandate names agent ${m.agent}, expected ${o.agent}`))
    const id = await identityOf(m.principal)
    if (id.problem) { problems.push(id.problem); return out }
    out.principal = id.identity
    // TAP-11 §4.4 against the CURRENT holder of the principal's circuit; a manifest-delegated signer is never accepted
    if (!(await holderSigned(id.identity.holder, digest, signed.sig))) { problems.push(problem('not-signed-by-holder', `not signed by the current holder ${id.identity.holder} of ${m.principal}`)); return out }
    // nonce: recorded only once the holder's signature holds and the mandate is not unusable on its face: the phase-0
    // rules or a span over 30 days (the mandate's own content), or another agent or agentKey than the caller expected.
    // The last two depend on the caller's options o.agent and o.agentKey, not on the mandate: called alone without them,
    // the nonce is recorded. Such a mistaken mandate must not use up the nonce its corrected version will carry. An
    // expired or not-yet-valid mandate is recorded: it is a real mandate the holder issued, valid at another time.
    // 只有签名成立、且内容本身没有让它不可用的问题时才记录 nonce（阶段 0 规则、超过 30 天、代理或执行钥匙不符）；
    // 过期或未生效的授权书照记：它是持有人真实签发、在另一时间有效的授权书。一步完成的 setIfAbsent。
    if (!problems.some((p) => NONCE_BLOCKING.has(p.code))) {
      const nk = `${chainId}:${m.principal.toLowerCase()}:${m.nonce}`
      const seen = await nonces.setIfAbsent(nk, mandateHash)
      if (seen != null && seen !== mandateHash) problems.push(problem('nonce-reused', `nonce ${m.nonce} of ${m.principal} was already used by mandate ${seen}`))
    }
    const rev = { status: 'not-read', revoked: false }
    if (o.readSite !== false) {
      const site = await readRevocations(m.principal, id.identity)
      Object.assign(rev, { site })
      rev.status = site.status
      if (site.status === 'invalid') problems.push(problem('revocation-unavailable', `the principal's revocation list cannot be relied on: ${site.reason}`))
      else if (site.status === 'published' && revokes(site, mandateHash, m)) { rev.revoked = true; rev.at = site.issued; rev.via = 'site' }
    }
    for (const msg of o.revocations ?? []) {
      const c = await checkRevocationMessage(msg, id.identity)
      if (c.problem) { problems.push(c.problem); continue }
      if (revokes(c.revocation, mandateHash, m) && (!rev.revoked || c.revocation.issued < rev.at)) { rev.revoked = true; rev.at = c.revocation.issued; rev.via = 'message' }
    }
    if (rev.revoked) problems.push(problem('mandate-revoked', `revoked by the principal's holder at ${rev.at} (${rev.via})`))
    out.revocation = rev
    out.ok = problems.length === 0
    return out
  }

  // ---- agent-side messages: TAPI-21 signed responses (v1 receipts) of the agent's own methods ----
  // The signer must be the agent's manifest signer as resolved on chain (TAP-11 §4.5); the receipt's service container
  // must be the agent; result.kind names the message. / 代理侧消息 = 代理方法的签名回执；签名者必须是链上解析出的签名者。
  async function checkAgentReceipt(receipt, agentContainer, kind) {
    if (!receipt || typeof receipt !== 'object' || receipt.v !== 1 || !receipt.service || receipt.ok !== true || !receipt.result || typeof receipt.result !== 'object') return { problem: problem('message-malformed', `${kind}: an agent message is a full (v 1) receipt of a successful call`) }
    if (!eqAddr(receipt.service.container, agentContainer)) return { problem: problem('agent-mismatch', `${kind} is signed for ${receipt.service.container}, not the agent ${agentContainer}`) }
    if (receipt.result.kind !== KIND_PREFIX + kind) return { problem: problem('message-malformed', `${kind}: result.kind is ${JSON.stringify(receipt.result.kind)?.slice(0, 40)}`) }
    if (!Number.isSafeInteger(receipt.ts) || !Number.isSafeInteger(receipt.result.exp)) return { problem: problem('message-malformed', `${kind}: ts and result.exp must be Unix seconds`) }
    let svc
    try { svc = await serviceOf(agentContainer) } catch (e) {
      // the counterparty's failure is a verdict (as provider-unresolvable is); an RPC failure is still thrown
      if (e instanceof TapeAPIError && ['MANIFEST_INVALID', 'DELEGATION_INVALID', 'NOT_FOUND'].includes(e.code)) return { problem: problem('agent-unresolvable', `${kind}: the agent ${agentContainer} does not resolve: ${e.message}`) }
      throw e
    }
    let signer
    try { signer = recoverResponseSigner({ container: receipt.service.container, id: receipt.id, method: receipt.method, params: receipt.params, ok: true, body: receipt.result, ts: receipt.ts }, receipt.sig) } catch (e) { return { problem: problem('not-signed-by-agent', `${kind}: ${e.message}`) } }
    if (!eqAddr(signer, svc.manifest.signer)) return { problem: problem('not-signed-by-agent', `${kind} is signed by ${signer}; the agent's signer is ${svc.manifest.signer}`) }
    return { svc, signer: checksumAddress(signer) }
  }

  /**
   * @experimental (1.7) What a delivery's evidence proves: each hash-only (v 2) receipt verifies against the signer the
   * named provider publishes on chain, the provider is in the mandate's scope, and the call was answered inside the
   * mandate's window. It proves the calls were answered by those containers; never that they were right.
   * `deliver` is the deliver message's result ({ receipts, receiptsHash, ... }); `mandate` the normalised mandate.
   */
  async function verifyEvidence(deliver, { mandate } = {}) {
    const problems = []
    const out = { ok: false, problems, enforcement: 'none', proves: EVIDENCE_PROVES, doesNotProve: [...EVIDENCE_DOES_NOT_PROVE], receipts: [] }
    const m = normalizeMandate(mandate)
    if (!deliver || !Array.isArray(deliver.receipts)) { problems.push(problem('evidence-malformed', 'receipts must be an array')); return out }
    let rh
    try { rh = jsonHashOf(deliver.receipts) } catch (e) { problems.push(problem('evidence-malformed', `receipts have no canonical form: ${e.message}`)); return out }
    if (deliver.receiptsHash !== rh) problems.push(problem('receipts-hash-mismatch', 'receiptsHash is not keccak256(canonicalJSON(receipts))'))
    const scope = new Set(m.scope.map((s) => s.provider.toLowerCase()))
    const sigs = new Set()
    for (const [i, r] of deliver.receipts.entries()) {
      const at = `receipts[${i}]`
      if (!r || r.v !== 2 || !r.service || !isAddress(r.service.container)) { problems.push(problem('receipt-not-hash-only', `${at}: evidence carries hash-only (v 2) receipts, so the principal's requests are not published`)); continue }
      if (sigs.has(String(r.sig).toLowerCase())) { problems.push(problem('receipt-repeated', `${at} repeats an earlier receipt`)); continue }
      sigs.add(String(r.sig).toLowerCase())
      const entry = { container: checksumAddress(r.service.container), name: null, method: plainText(r.method, 64), ts: r.ts, ok: r.ok === true, answeredBy: false }
      out.receipts.push(entry)
      if (!scope.has(entry.container.toLowerCase())) problems.push(problem('receipt-provider-out-of-scope', `${at}: ${entry.container} is not a provider in the mandate's scope`))
      if (!Number.isSafeInteger(r.ts) || r.ts < m.notBefore || r.ts > m.expires) problems.push(problem('receipt-outside-mandate', `${at}: answered at ${r.ts}, outside the mandate's window ${m.notBefore}..${m.expires}`))
      let svc
      try { svc = await serviceOf(entry.container) } catch (e) {
        if (e instanceof TapeAPIError && ['MANIFEST_INVALID', 'DELEGATION_INVALID', 'NOT_FOUND'].includes(e.code)) { problems.push(problem('provider-unresolvable', `${at}: ${entry.container}: ${e.message}`)); continue }
        throw e
      }
      let signer
      try { signer = recoverResponseSignerFromHashes({ container: entry.container, id: r.id, requestHash: r.requestHash, ok: r.ok === true, bodyHash: r.bodyHash, ts: r.ts }, r.sig) } catch (e) { problems.push(problem('receipt-invalid', `${at}: ${e.message}`)); continue }
      if (!eqAddr(signer, svc.manifest.signer)) { problems.push(problem('receipt-invalid', `${at}: signed by ${signer}, ${entry.container} publishes signer ${svc.manifest.signer}`)); continue }
      entry.answeredBy = true
      const idn = await identityOf(entry.container)
      if (idn.identity) entry.name = idn.identity.name
    }
    out.ok = problems.length === 0
    return out
  }

  /**
   * @experimental (1.7) Check a whole task thread: the messages in the order they were received.
   *   at          Unix seconds for the final time checks (default: the clock)
   *   readSite    read the principal's revocation list (default true)
   * Returns { ok, state, problems, enforcement: 'none', selfHire, selfHireReasons, principal, agent, offerHash,
   * mandateHash, taskHash, mandate, deliveries, verdict, revoked, unaccepted, evidence }.
   * `state` is one of Offered, Accepted, Active, Delivered, Settled, Expired, Rejected, Cancelled (null before an
   * offer). Payment is a chain fact, not a state: it is checked separately (verifyAttachment).
   */
  async function verifyTaskThread(messages, o = {}) {
    const problems = []
    const out = { ok: false, state: null, problems, enforcement: 'none', selfHire: false, selfHireReasons: [], deliveries: [], verdict: null, revoked: null, unaccepted: false }
    if (!Array.isArray(messages) || messages.length === 0) { problems.push(problem('thread-empty', 'a thread is a non-empty array of messages')); return out }
    const now = o.at ?? clock()
    let offer = null, offerHash = null, accept = null, mandate = null, mandateHash = null, principalId = null, agentSvc = null, lastDeliver = null
    const revokedAt = () => out.revoked?.at ?? Infinity
    for (const [i, msg] of messages.entries()) {
      const where = `messages[${i}]`
      const kind = typeof msg?.kind === 'string' && msg.kind.startsWith(KIND_PREFIX) ? msg.kind.slice(KIND_PREFIX.length) : null
      if (!msg || msg.v !== 0 || kind === null) { problems.push(problem('message-malformed', `${where}: not a v 0 ${KIND_PREFIX}* message`)); continue }
      if (RESERVED_KINDS.includes(kind)) { problems.push(problem('kind-not-implemented', `${where}: ${kind} is a reserved message name this version does not implement`)); continue }
      if (!THREAD_KINDS.includes(kind)) { problems.push(problem('kind-unknown', `${where}: unknown kind ${plainText(kind, 40)}`)); continue }
      const order = (want) => { if (!want.includes(out.state)) { problems.push(problem('out-of-order', `${where}: ${kind} in state ${out.state ?? 'none'} (expected ${want.map((s) => s ?? 'none').join(' or ')})`)); return false } return true }
      if (kind === 'offer') {
        if (!order([null])) continue
        let ofr
        try { ofr = normalizeTaskOffer(msg.offer) } catch (e) { problems.push(problem('message-malformed', `${where}: ${e.message}`)); continue }
        try { if (taskHashOf(msg.task) !== ofr.taskHash) { problems.push(problem('task-hash-mismatch', `${where}: the task text does not hash to offer.taskHash`)); continue } } catch (e) { problems.push(problem('message-malformed', `${where}: ${e.message}`)); continue }
        const id = await identityOf(ofr.principal)
        if (id.problem) { problems.push(id.problem); continue }
        const digest = taskOfferDigest(chainId, hub, ofr)
        if (!(await holderSigned(id.identity.holder, digest, msg.sig))) { problems.push(problem('not-signed-by-holder', `${where}: the offer is not signed by the current holder ${id.identity.holder} of ${ofr.principal}`)); continue }
        offer = ofr; offerHash = toHex(digest); principalId = id.identity
        Object.assign(out, { state: 'Offered', offerHash, taskHash: ofr.taskHash, principal: principalId })
      } else if (kind === 'accept') {
        if (!order(['Offered'])) continue
        const c = await checkAgentReceipt(msg.receipt, offer.agent, 'accept')
        if (c.problem) { problems.push(c.problem); continue }
        const r = msg.receipt.result
        if (r.offerHash !== offerHash) { problems.push(problem('offer-mismatch', `${where}: accept names offer ${plainText(String(r.offerHash), 70)}, not ${offerHash}`)); continue }
        if (!isAddress(r.agentKey) || eqAddr(r.agentKey, ZERO_ADDRESS)) { problems.push(problem('message-malformed', `${where}: accept must announce a non-zero agentKey`)); continue }
        if (msg.receipt.ts > offer.exp) { problems.push(problem('offer-expired', `${where}: accepted at ${msg.receipt.ts}, the offer expired at ${offer.exp}`)); continue }
        if (msg.receipt.ts > revokedAt()) { problems.push(problem('message-after-revocation', `${where}: accept signed at ${msg.receipt.ts}, after the revocation at ${revokedAt()}`)); continue }
        accept = { agentKey: checksumAddress(r.agentKey), exp: r.exp, ts: msg.receipt.ts }
        agentSvc = c.svc
        out.state = 'Accepted'
      } else if (kind === 'mandate') {
        if (!order(['Accepted'])) continue
        // The fields compared with the offer first, without the chain: a mandate that names another principal, task, mode
        // or nonce is refused before verifyMandate records its nonce, so a mistaken mandate does not use up the offer's
        // nonce (the corrected one must carry the same nonce). No revocation is missed: none is read for it either.
        // 先不读链地比对字段：写错的授权书在记录 nonce 之前就被拒，不会用掉报价的 nonce。
        let pre = null
        try { pre = normalizeMandate(msg?.mandate) } catch { /* reported by verifyMandate as mandate-malformed */ }
        if (pre) {
          const mismatch = []
          if (!eqAddr(pre.principal, offer.principal)) mismatch.push('principal')
          if (pre.taskHash !== offer.taskHash) mismatch.push('taskHash')
          if (pre.mode !== offer.mode) mismatch.push('mode')
          // an SDK rule, not a type field: the mandate's nonce is the offer's, so one mandate cannot serve two threads even
          // when an agent reuses its key / SDK 规则：授权书的 nonce 等于报价的，一张授权书不能进两个线程
          if (pre.nonce !== offer.nonce) mismatch.push('nonce')
          if (mismatch.length) { problems.push(problem('mandate-mismatch', `${where}: the mandate's ${mismatch.join(', ')} differ from the offer`)); continue }
        }
        const v = await verifyMandate(msg, { agentKey: accept.agentKey, agent: offer.agent, at: o.at, readSite: o.readSite })
        const mm = v.mandate
        // the window is checked against what the agent did (deliveries) and by the final time checks, not against `at`
        const late = ['mandate-expired', 'mandate-not-yet']
        for (const p of v.problems) if (!late.includes(p.code)) problems.push({ ...p, message: `${where}: ${p.message}` })
        if (v.revocation?.revoked) { out.revoked = { at: v.revocation.at, via: v.revocation.via } }
        if (!mm || v.problems.some((p) => !late.includes(p.code) && p.code !== 'mandate-revoked')) continue
        mandate = mm; mandateHash = v.mandateHash
        Object.assign(out, { mandateHash, mandate, mandateCheck: v })
        out.state = out.revoked ? 'Cancelled' : 'Active'
      } else if (kind === 'deliver') {
        if (!order(['Active', 'Rejected'])) continue
        const c = await checkAgentReceipt(msg.receipt, mandate.agent, 'deliver')
        if (c.problem) { problems.push(c.problem); continue }
        const r = msg.receipt.result
        if (r.mandateHash !== mandateHash) { problems.push(problem('mandate-mismatch', `${where}: deliver names mandate ${plainText(String(r.mandateHash), 70)}, not ${mandateHash}`)); continue }
        if (typeof r.deliverableHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(r.deliverableHash)) { problems.push(problem('message-malformed', `${where}: deliverableHash must be 0x and 64 lowercase hex digits`)); continue }
        const ts = msg.receipt.ts
        if (ts > revokedAt()) { problems.push(problem('message-after-revocation', `${where}: delivered at ${ts}, after the revocation at ${revokedAt()}`)); continue }
        if (ts < mandate.notBefore || ts > mandate.expires) { problems.push(problem('deliver-outside-mandate', `${where}: delivered at ${ts}, outside the mandate's window ${mandate.notBefore}..${mandate.expires}`)); continue }
        if (r.exp < ts) { problems.push(problem('message-malformed', `${where}: deliver expires (${r.exp}) before it was signed (${ts})`)); continue }
        if (ts < accept.ts) { problems.push(problem('deliver-before-accept', `${where}: delivered at ${ts}, before the agent accepted at ${accept.ts}`)); continue }
        // the offer's deadline is the principal's: a late delivery is recorded (it is a fact) and reported
        if (ts > offer.deadline) problems.push(problem('deliver-after-deadline', `${where}: delivered at ${ts}, after the offer's deadline ${offer.deadline}`))
        const ev = await verifyEvidence(r, { mandate })
        for (const p of ev.problems) problems.push({ ...p, message: `${where}: ${p.message}` })
        lastDeliver = { deliverableHash: r.deliverableHash, ts, exp: r.exp, receiptsHash: r.receiptsHash }
        out.deliveries.push({ ...lastDeliver, evidence: ev })
        out.evidence = ev
        out.state = 'Delivered'
      } else if (kind === 'acceptance') {
        if (!order(['Delivered'])) continue
        let v
        try { v = normalizeTaskVerdict(msg.verdict) } catch (e) { problems.push(problem('message-malformed', `${where}: ${e.message}`)); continue }
        if (!(await holderSigned(principalId.holder, taskVerdictDigest(chainId, hub, v), msg.sig))) { problems.push(problem('not-signed-by-holder', `${where}: the verdict is not signed by the current holder ${principalId.holder}`)); continue }
        if (v.mandateHash !== mandateHash || v.deliverableHash !== lastDeliver.deliverableHash) { problems.push(problem('verdict-mismatch', `${where}: the verdict is for another mandate or deliverable`)); continue }
        if (v.issued < lastDeliver.ts) { problems.push(problem('verdict-before-delivery', `${where}: issued ${v.issued}, before the delivery at ${lastDeliver.ts}`)); continue }
        out.verdict = { verdict: v.verdict === VERDICT_ACCEPT ? 'accepted' : 'rejected', issued: v.issued, reasonHash: v.reasonHash, deliverableHash: v.deliverableHash, verdictHash: toHex(taskVerdictDigest(chainId, hub, v)) }
        out.state = v.verdict === VERDICT_ACCEPT ? 'Settled' : 'Rejected'
      } else if (kind === 'revocation') {
        if (!principalId) { problems.push(problem('out-of-order', `${where}: a revocation before any offer`)); continue }
        const c = await checkRevocationMessage(msg, principalId)
        if (c.problem) { problems.push({ ...c.problem, message: `${where}: ${c.problem.message}` }); continue }
        const r = c.revocation
        const applies = mandate ? revokes(r, mandateHash, mandate) : r.revokedBefore > 0
        if (!applies) { problems.push(problem('revocation-mismatch', `${where}: the revocation does not cover this thread's mandate`)); continue }
        if (!out.revoked || r.issued < out.revoked.at) out.revoked = { at: r.issued, via: 'message' }
        if (['Offered', 'Accepted', 'Active'].includes(out.state)) out.state = 'Cancelled'
        // Delivered / Rejected stay: a delivery made before the revocation can still be accepted; Settled is final
      }
    }
    // ---- final time checks / 最后的时间检查 ----
    if (out.state === 'Offered' && now > offer.exp) out.state = 'Expired'
    else if (out.state === 'Accepted' && Number.isSafeInteger(accept.exp) && now > accept.exp) out.state = 'Expired'
    else if (out.state === 'Active' && now > mandate.expires) out.state = 'Expired'
    // the delivery's own exp is how long the agent waits for a verdict: past it, delivered and never accepted (no arbiter)
    else if (out.state === 'Delivered' && now > lastDeliver.exp) out.unaccepted = true
    // ---- parties and self-hire / 双方与自雇自 ----
    if (offer) {
      const agentId = await identityOf(offer.agent)
      if (agentId.identity) {
        out.agent = { ...agentId.identity }
        if (agentSvc) {
          out.agent.signer = checksumAddress(agentSvc.manifest.signer)
          out.agent.displayName = { text: plainText(agentSvc.manifest.name, 64), untrusted: true }
        }
      } else out.agent = { container: checksumAddress(offer.agent) }
      const reasons = []
      if (eqAddr(offer.principal, offer.agent)) reasons.push('same-container')
      if (principalId && agentId.identity && eqAddr(principalId.holder, agentId.identity.holder)) reasons.push('same-holder')
      if (principalId && out.agent.signer && eqAddr(out.agent.signer, principalId.holder)) reasons.push('agent-signer-is-principal-holder')
      if (principalId && accept && eqAddr(accept.agentKey, principalId.holder)) reasons.push('agent-key-is-principal-holder')
      out.selfHire = reasons.length > 0
      out.selfHireReasons = reasons
    }
    out.ok = problems.length === 0
    return out
  }

  return { verifyMandate, verifyTaskThread, verifyEvidence, readRevocations: async (container) => { const id = await identityOf(container); if (id.problem) return { status: 'invalid', reason: id.problem.message }; return readRevocations(container, id.identity) }, identityOf: async (container) => { const id = await identityOf(container); if (id.problem) throw new TapeAPIError('AGENT_INVALID', id.problem.message, { reason: id.problem.code }); return id.identity }, chainId, hub }
}

// The verdict constants again, for a caller that only imports this module / 方便只引入本模块的调用方
export { VERDICT_ACCEPT, VERDICT_REJECT }
