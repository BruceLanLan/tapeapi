// @experimental (1.7) Container agents, phase 0: verifying a mandate, a task thread and the evidence a delivery carries.
// Every decision reads the chain through the client it is given (createAgentKit(api)) under TAP-10 strict agreement
// ({ answers: 'tap10', strict: true }: every configured node, from at least max(2, min(3, operators)) operators), so one
// operator that lies cannot make a check pass. An RPC failure is thrown, never turned into a verdict.
// Since 1.8 every read of one verification (verifyMandate, verifyTaskThread, verifyEvidence, readRevocations, identityOf)
// is made at ONE TAP-10 pinned block (§5.3, draft TAP §4 and §6.2): the principal's identity and holder, the EIP-1271
// calls, both implementation slots and the revocation file. Agents and providers are resolved by `resolve` (TAP-11 §2:
// their own resolution, with its own pinned block when the client is createTapeAPI({ conform: 'tap10' })).
// 1.8 起一次核验的全部读取都钉在同一个 TAP-10 钉块上：委托方身份与持有人、EIP-1271、两个实现槽与撤销文件。代理与上游服务由 resolve 解析。
// What phase 0 does NOT do, and every result says so with `enforcement: 'none'`: no contract enforces any amount, time or
// counterparty. A mandate is a holder's signed statement that a counterparty can check; nothing more.
// See docs/DESIGN-container-agent.md (internal draft). Not covered by the 1.x compatibility promise.
import { sha256 } from '@noble/hashes/sha256'
import { TapeAPIError } from './errors.js'
import { safeParseJSON } from './canon.js'
import { selector, encodeParams, encodeCall, decodeReturn, hexToBytes, toHex, bytesToHex, isAddress, eqAddr, checksumAddress, ZERO_ADDRESS } from './abi.js'
import { recoverAddress, recoverResponseSigner, recoverResponseSignerFromHashes } from './sig.js'
import { chainById, formatTapeName, IMPL_SLOT, MAX_TOKEN_ID } from './chains.js'
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
const isU64 = (v) => Number.isSafeInteger(v) && v >= 0                     // draft TAP §3.7 uint64 form / uint64 形式
const isHash = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v)   // draft TAP §3.7 bytes32 form / bytes32 形式
const isStore = (s) => s && typeof s.get === 'function' && typeof s.set === 'function'
// TAP-11 §2.3: an outcome of resolving the agent or a provider other than "resolved" is that party's problem
// (agent-unresolvable, provider-unresolvable, draft TAP §7.2 step 4 and §8), except the chain and node outcomes
// (stale-block, unavailable, wrong-chain), which make the verification unavailable and are thrown. A conformance-mode
// client (createTapeAPI({ conform: 'tap10' })) says which in data.status; a default client's codes are read the same way.
// Such a client without allChains calls an address that is no container of its chain `unsupported` (it might be one on
// another chain): here the chain is fixed by the mandate's domain, so that is a verdict about the party too.
// TAP-11 §2.3：解析代理或上游服务的结果不是 resolved 即对方的问题；链与节点的结果使核验不可用，抛出。一致模式客户端不开 allChains 时
// 把不是本链容器的地址报为 unsupported：这里的链由授权书的域固定，所以它同样是对方的问题。
const NODE_OUTCOMES = new Set(['stale-block', 'unavailable', 'wrong-chain'])
const partyCannotResolve = (e) => e instanceof TapeAPIError && !NODE_OUTCOMES.has(e.data?.status) &&
  (['MANIFEST_INVALID', 'DELEGATION_INVALID', 'NOT_FOUND', 'SITE_STATUS'].includes(e.code) || (e.code === 'CONTRACT_UNKNOWN' && e.data?.status === 'store-changed') ||
   (e.code === 'INVALID_ARGUMENT' && e.data?.status === 'unsupported'))

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

// ---- the forms of the two receipts (draft TAP §7.2, §8), checked without the chain / 两种回执的形式，不读链 ----
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
// TAP-13 §3, §4: id a string of 1 to 128 UTF-16 code units (the empty id exists only under binding rule 1, TAP-13 §8, where
// the call is refused: a hash-only receipt with ok false), the path segment, params an object when present, sig 65 bytes in
// hex / TAP-13 的 id（1 到 128 个码元；空串只在 §8 规则 1 下出现，此时 ok 为 false）、路径段、params、sig 形式
const isId = (v, allowEmpty = false) => typeof v === 'string' && v.length <= 128 && (allowEmpty || v.length >= 1)
const isSig65 = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{130}$/.test(v)
const METHOD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
/**
 * @experimental (1.8) Draft TAP §7.2 steps 1-3 for the receipt of an agent message (`kind`: 'accept' or 'deliver'), the
 * thread's agent container `agent`: the form (v 1, a service object naming a container, the TAP-13 request's method and
 * params, the envelope's id, ts, ok true, an object result and sig), then service.container equal to `agent`, then
 * result.kind and the uint64 form (0 to 2^53 − 1) of ts and result.exp. Returns the first problem ({ code, message }:
 * message-malformed or agent-mismatch) or null. Steps 4-5 (resolution, signature) need the chain: createAgentKit.
 * 代理消息回执的第 1–3 步（形式、代理容器、kind 与时间的 uint64 形式），不读链；返回第一个问题或 null。
 */
export function agentMessageProblem(receipt, kind, agent) {
  const what = `${kind}: an agent message is a full (v 1) receipt of a successful call`
  if (!isObj(receipt) || receipt.v !== 1 || !isObj(receipt.service) || !isAddress(receipt.service.container) || receipt.ok !== true || !isObj(receipt.result)) return problem('message-malformed', what)
  if (typeof receipt.method !== 'string' || !METHOD_RE.test(receipt.method) || (receipt.params !== undefined && !isObj(receipt.params)) || !isId(receipt.id) || !isSig65(receipt.sig)) return problem('message-malformed', `${what}: method, params, id and sig as TAP-13 §3 and §4 give them`)
  if (!eqAddr(receipt.service.container, agent)) return problem('agent-mismatch', `${kind} is signed for ${receipt.service.container}, not the agent ${agent}`)
  if (receipt.result.kind !== KIND_PREFIX + kind) return problem('message-malformed', `${kind}: result.kind is ${JSON.stringify(receipt.result.kind)?.slice(0, 40)}`)
  // the uint64 form of draft TAP §3.7: an integer from 0 to 2^53 − 1 (1.8: a negative one is malformed)
  // §3.7 的 uint64 形式：0 到 2^53 − 1 的整数（1.8：负数即格式错误）
  if (!isU64(receipt.ts) || !isU64(receipt.result.exp)) return problem('message-malformed', `${kind}: ts and result.exp must be Unix seconds (0 to 2^53 - 1)`)
  return null
}
/**
 * @experimental (1.8) The form of one hash-only (v 2) receipt of a delivery's evidence (draft TAP §8): a service object
 * naming a container, requestHash and bodyHash in the bytes32 form (lower case), id, ts in the uint64 form, ok a JSON
 * boolean and a 65-byte sig. Returns { code: 'receipt-not-hash-only', message } or null; never reads ok as false.
 * 证据里一个只含哈希的回执（v 2）的形式；返回 receipt-not-hash-only 或 null；绝不把非布尔的 ok 当作 false。
 */
export function hashOnlyReceiptProblem(r) {
  if (!isObj(r) || r.v !== 2 || !isObj(r.service) || !isAddress(r.service.container)) return problem('receipt-not-hash-only', 'evidence carries hash-only (v 2) receipts, so the principal\'s requests are not published')
  // the rest of the form (1.8): ok a JSON boolean, both hashes bytes32, ts uint64, id and sig as TAP-13 §4; anything else is
  // refused, never read as false or as another time / 其余形式（1.8）：ok 为布尔、两个哈希为 bytes32、ts 为 uint64、id 与 sig 按 TAP-13
  if (typeof r.ok !== 'boolean' || !isHash(r.requestHash) || !isHash(r.bodyHash) || !isU64(r.ts) || !isId(r.id, r.ok === false) || !isSig65(r.sig)) return problem('receipt-not-hash-only', 'a hash-only receipt has a boolean ok, requestHash and bodyHash as 0x and 64 lower-case hex digits, ts as Unix seconds, and the envelope\'s id (1 to 128 code units; empty only when ok is false) and 65-byte sig')
  return null
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
  // TAP-10 §6.1 needs, for this chain, the implementations accepted for the site store and the payment contract: without
  // them every revocation list would read as invalid, so it is refused here, as the conformance mode does
  // (INVALID_ARGUMENT), not reported as revocation-unavailable on every check. / 没有接受的实现列表即配置错误，构造时就拒绝
  const known = chainById(chainId)
  if (!known) throw new TapeAPIError('INVALID_ARGUMENT', `createAgentKit: chain ${chainId} is not a TapeOut chain this SDK knows`)
  for (const [role, a] of [['site store (siteRegistry)', siteRegistry], ['payment contract', known.binding]]) {
    if (!isAddress(a) || !known.expectedImpl?.[a.toLowerCase()]) throw new TapeAPIError('INVALID_ARGUMENT', `createAgentKit: the ${role} ${a ?? '(none)'} of chain ${chainId} has no implementation TAP-10 lists as accepted (chains.js expectedImpl); the principal's revocation list could never be read (TAP-10 §6.1)`)
  }
  // TAP-10 §2.2, §4.3: the container comes from the chain's container OPENER (opener.accountOf), its pinned block from
  // §5.3 (the chain's max pin lag); both only from chains.js. / 容器取自开通器，钉块按 §5.3，均只取自 chains.js
  const opener = known.opener
  if (!isAddress(opener) || !Number.isSafeInteger(known.tap10MaxPinLag)) throw new TapeAPIError('INVALID_ARGUMENT', `createAgentKit: chain ${chainId} has no container opener or TAP-10 max pin lag in chains.js`)
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

  // ---- one pinned block per verification (TAP-10 §5.3) / 每次核验一个钉块 ----
  // TAP-10 §5.4 under strict agreement, once per kit (only a success is kept): nodes on another chain are wrong-chain, a
  // node outcome that makes the verification unavailable (thrown, never a problem of a message, draft TAP §4, §10).
  // 严格共识的 §5.4，每个 kit 一次（只保留成功）：节点在别的链上即 wrong-chain，使核验不可用（抛出，绝不是消息的问题）。
  let chainChecked = null
  function checkChain() {
    if (chainChecked) return chainChecked
    const p = (async () => {
      const got = Number(BigInt(await needRpc().call('eth_chainId', [], STRICT)))
      if (got !== chainId) throw new TapeAPIError('INVALID_ARGUMENT', `wrong-chain: the nodes of this client answer eth_chainId ${got}, not ${chainId} (TAP-10 §5.4)`, { data: { status: 'wrong-chain' } })
      return true
    })()
    chainChecked = p
    p.catch(() => { if (chainChecked === p) chainChecked = null })
    return p
  }
  // A verification's context: its pinned block (read on first use: the Q-th highest operator head minus 2, refused as
  // stale-block beyond the chain's max pin lag, every read then pinned to its hash, EIP-1898) and what was read at that
  // block, kept for the rest of the verification only: identities, the implementation slots, the revocation file of each
  // principal (both passes of verifyTaskThread share them; the slots are also kept per block, storeChanged). Nothing read at
  // one block is used at another.
  // 一次核验的上下文：钉块（首次用到时读取）以及在这个块上读到的东西，只在本次核验内复用：身份、实现槽、各委托方的撤销文件（线程两遍共用）。
  // 在一个块上读到的东西绝不用到另一个块上。
  function context() {
    let pinP = null
    return {
      pin() {
        pinP ??= Promise.all([needRpc().tap10Block({ maxLag: known.tap10MaxPinLag }), checkChain()])
          .then(([b]) => ({ number: b.number, hash: b.hash, lag: b.lag, maxLag: b.maxLag, at: { blockHash: b.hash, requireCanonical: true } }))
        return pinP
      },
      identities: new Map(), revocations: new Map(),
    }
  }
  const blockOf = async (ctx) => (await ctx.pin()).at
  // a read started now, awaited later: its failure is handled where it is awaited / 先发出、后等待的读取
  const early = (f) => { const p = f(); p.catch(() => {}); return p }

  // ---- strict reads at the pinned block / 钉块上的严格读取 ----
  const strictCall = async (to, name, args, block) => decodeReturn(name, await needRpc().ethCall(to, encodeCall(name, args), block, STRICT))
  async function hasCode(a, block) { return String(await needRpc().call('eth_getCode', [a, block], STRICT)) !== '0x' }
  // TAP-11 §4.4: a 65-byte signature is ECDSA first, and a malformed one is refused WITHOUT trying EIP-1271; a well-formed
  // one that recovers to someone else, or a longer one, is asked of the holder under EIP-1271 (strict reads).
  async function holderSigned(holder, digest, sig, ctx) {
    if (typeof sig !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){65,1024}$/.test(sig)) return false
    if (sig.length === 132) {
      let recovered
      try { recovered = recoverAddress(digest, sig) } catch { return false }
      if (eqAddr(recovered, holder)) return true
    }
    const block = await blockOf(ctx)
    if (!(await hasCode(holder, block))) return false
    const data = selector('isValidSignature(bytes32,bytes)') + bytesToHex(encodeParams(['bytes32', 'bytes'], [toHex(digest), sig]))
    let out
    try { out = String(await needRpc().ethCall(holder, data, block, STRICT)).toLowerCase() } catch (e) { if (notAnAnswer(e)) return false; throw e }
    return out.length >= 66 && out.slice(0, 66) === '0x1626ba7e' + '0'.repeat(56)
  }
  // ---- the processor table (TAP-10 §4.3 step 3) / 处理器表 ----
  // The processor number of a processor contract whose isCPU is true. Numbers are append-only and never reused, so the
  // table is kept for the life of the kit (TAP-10 §11). In order: the kept table; the snapshot shipped with this version
  // (processors-snapshot.js), only for this chain's own factory, a hit confirmed by one strict cpuAt at the pinned block;
  // then a strict scan of cpuAt at the pinned block, at most SCAN_MAX reads per processor looked up, per verification (the
  // budget is per scanFor call, so a verification that looks up several unknown processors reads up to SCAN_MAX each),
  // resumed on the next one (unavailable until then, never not-tapeout). Not found among cpuCount numbers: not-tapeout.
  // The same order as the conformance mode's resolve (index.js processorNumberOf). / 处理器号：已保留的表、本链工厂的快照
  // （钉块上一次严格 cpuAt 核实）、钉块上的严格扫描（每个待查处理器、每次核验至多 SCAN_MAX 次读取，下次继续；之前报
  // unavailable，绝不报 not-tapeout）。cpuCount 个编号里都没有即 not-tapeout。
  const SCAN_PAGE = 8, SCAN_MAX = 256, TABLE_MAX = 65_536
  const procByNumber = new Map(), numberByProc = new Map()
  const snapshot = (() => { const t = PROCESSORS_SNAPSHOT[chainId]; return t && eqAddr(t.factory, factory) ? t : null })()
  let snapshotIndex = null, snapshotAgrees = null, scan = null, scanQueue = Promise.resolve()
  const keepProcessor = (i, c) => {
    if (procByNumber.has(i)) return
    if (procByNumber.size >= TABLE_MAX) throw new TapeAPIError('RPC_UNAVAILABLE', `unavailable: the processor table this kit keeps is full (${TABLE_MAX} entries); use a new kit (TAP-10 §4.3 step 3)`, { data: { status: 'unavailable' } })
    procByNumber.set(i, String(c).toLowerCase()); numberByProc.set(String(c).toLowerCase(), i)
  }
  async function processorNumberOf(circuits, block) {
    const k = String(circuits).toLowerCase()
    if (numberByProc.has(k)) return numberByProc.get(k)
    if (snapshot && snapshotAgrees !== false) {
      snapshotIndex ??= new Map(snapshot.list.map((a, i) => [a.toLowerCase(), i]))
      const i = snapshotIndex.get(k)
      if (i !== undefined) {
        let got = null
        try { got = await strictCall(factory, 'cpuAt', [BigInt(i)], block) } catch (e) { if (!notAnAnswer(e)) throw e }
        if (got !== null && eqAddr(got, circuits)) { keepProcessor(i, got); return i }
        snapshotAgrees = false   // the chain says otherwise: scan everything / 链给出不同答案：全部扫描
      }
    }
    // one scan at a time, or two would share scan.next and skip numbers / 同一时间只扫描一次
    const run = scanQueue.then(() => scanFor(k, block))
    scanQueue = run.catch(() => {})
    return run
  }
  async function scanFor(k, block) {
    if (numberByProc.has(k)) return numberByProc.get(k)
    const count = Number(await strictCall(factory, 'cpuCount', [], block))
    if (snapshot && snapshotAgrees === null && snapshot.count > 0) {
      let last = null
      try { last = await strictCall(factory, 'cpuAt', [BigInt(snapshot.count - 1)], block) } catch (e) { if (!notAnAnswer(e)) throw e }
      snapshotAgrees = count >= snapshot.count && last !== null && eqAddr(last, snapshot.list[snapshot.count - 1])
    }
    const from = snapshot && snapshotAgrees ? snapshot.count : 0
    if (!scan || scan.from !== from) scan = { from, next: from }
    for (let budget = SCAN_MAX; scan.next < count && budget > 0;) {
      const idx = Array.from({ length: Math.min(SCAN_PAGE, count - scan.next, budget) }, (_, j) => scan.next + j)
      const page = await Promise.all(idx.map((i) => procByNumber.get(i) ?? strictCall(factory, 'cpuAt', [BigInt(i)], block)))
      idx.forEach((i, j) => keepProcessor(i, page[j]))
      scan.next += idx.length; budget -= idx.length
      const hit = page.findIndex((a) => String(a).toLowerCase() === k)
      if (hit >= 0) return idx[hit]
    }
    if (scan.next >= count) return null
    throw new TapeAPIError('RPC_UNAVAILABLE', `unavailable: ${k} is a TapeOut processor (isCPU), but its processor number is not among the ${scan.next - from} read so far (of ${count}); the scan reads at most ${SCAN_MAX} per processor looked up, per verification, and goes on from there next time (TAP-10 §4.3 step 3)`, { data: { status: 'unavailable' } })
  }

  // ---- a container's identity: TAP-10 §4.3 (container address input) at the pinned block, every read strict ----
  // 1. token() fails, has no code or names another chain: not-tapeout; 2. factory.isCPU false: not-tapeout; 3. no processor
  // number: not-tapeout; 4. opener.accountOf(processor contract, #ID) must be this very address: not-tapeout; then ownerOf
  // (a revert: no-such-token) is the holder. Draft TAP §4: these two outcomes are problems; the chain and node outcomes
  // (unavailable, stale-block, wrong-chain) are thrown. Returns { identity } or { problem }; kept for the verification only.
  // 容器身份：钉块上按 TAP-10 §4.3，每个读取严格共识。not-tapeout 与 no-such-token 是问题；链与节点的结果抛出。只在本次核验内复用。
  function identityOf(container, ctx) {
    const k = String(container).toLowerCase()
    let p = ctx.identities.get(k)
    if (!p) { p = readIdentity(container, ctx); ctx.identities.set(k, p) }
    return p
  }
  async function readIdentity(container, ctx) {
    const nt = (why) => ({ problem: problem('not-tapeout', `${container} ${why}: not a TapeOut circuit container of chain ${chainId} (TAP-10 §4.3)`) })
    if (!isAddress(container) || eqAddr(container, ZERO_ADDRESS)) return nt('is not a container address')
    const block = await blockOf(ctx)
    let tok
    try { tok = await strictCall(container, 'token', [], block) } catch (e) { if (notAnAnswer(e)) return nt('does not answer ERC-6551 token()'); throw e }
    const [cid, circuits, rawId] = tok
    const tokenId = BigInt(rawId)
    if (BigInt(cid) !== BigInt(chainId)) return nt(`answers token() for chain ${cid}`)
    if (tokenId < 1n || tokenId > MAX_TOKEN_ID) return nt(`names #${tokenId}, outside TAP-10 §3.1`)
    // steps 4 and 5 go out with step 2; they are judged in order / 第 4、5 步与第 2 步同轮发出，按顺序判断
    const accountP = early(() => strictCall(opener, 'accountOf', [circuits, tokenId], block))
    const holderP = early(() => strictCall(circuits, 'ownerOf', [tokenId], block))
    let cpu
    try { cpu = (await strictCall(factory, 'isCPU', [circuits], block)) === true } catch (e) { if (notAnAnswer(e)) cpu = false; else throw e }
    if (!cpu) return nt(`names ${checksumAddress(circuits)}, which is not a TapeOut processor (factory.isCPU is false)`)
    const processor = await processorNumberOf(circuits, block)
    if (processor === null) return nt(`names ${checksumAddress(circuits)}, which is not in the factory's processor list (cpuAt)`)
    let derived
    try { derived = await accountP } catch (e) { if (notAnAnswer(e)) return nt('has no container the opener derives'); throw e }
    if (!eqAddr(derived, container)) return nt(`is not opener.accountOf(${checksumAddress(circuits)}, ${tokenId}) = ${checksumAddress(derived)}`)
    let holder
    try { holder = await holderP } catch (e) { if (notAnAnswer(e)) return { problem: problem('no-such-token', `ownerOf(${tokenId}) reverted on ${checksumAddress(circuits)}: the processor has no circuit with this #ID (TAP-10 §4.2 step 4)`) }; throw e }
    const name = formatTapeName({ tokenId, processor, chainId })
    return { identity: { container: checksumAddress(container), chainId, circuits: checksumAddress(circuits), tokenId: tokenId.toString(), processor, holder: checksumAddress(holder), name } }
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
  // TAP-10 §6.1: the implementations of both proxies of this chain, the site store and the payment contract, must be
  // ones TAP-10 lists as accepted (chains.js expectedImpl), read from the ERC-1967 slot (never implementation()). A
  // store whose code was replaced is not read: the list is then invalid (revocation-unavailable), never "not revoked".
  // TAP-10 §6.1：站点存储与付费合约两个代理的实现必须是 TAP-10 列为接受的；否则不读，清单视为无效（失败关闭）。
  // Read at the verification's pinned block (1.8). The answer is kept per pinned block for at most CACHE_MS by the kit's
  // clock (TAP-10 §11 lets a resolution result be kept up to 60 s): verifications that pin the same block share one read,
  // one that pins another block reads the slots again, so a slot is never taken from another block. Only answers are
  // kept. / 在本次核验的钉块上读（1.8）。结果按钉块保留至多 CACHE_MS（按 kit 的时钟）：钉在同一块上的核验共用一次读取，钉在别的块上
  // 就重读，实现槽绝不取自别的块。只保留回答。
  const storeCache = new Map()   // pinned block hash -> { at: clock seconds, p } / 钉块哈希 -> 读取
  async function storeChanged(ctx) {
    const { hash } = await ctx.pin()
    const now = clock()
    const e = storeCache.get(hash)
    if (e && now >= e.at && now - e.at < CACHE_MS / 1000) return e.p
    const p = storeChangedAt(ctx)
    storeCache.set(hash, { at: now, p })
    p.catch(() => { if (storeCache.get(hash)?.p === p) storeCache.delete(hash) })
    if (storeCache.size > 64) storeCache.delete(storeCache.keys().next().value)
    return p
  }
  async function storeChangedAt(ctx) {
    const block = await blockOf(ctx)
    for (const [role, proxy] of [['site store', siteRegistry], ['payment contract', known.binding]]) {
      const accepted = isAddress(proxy) ? known.expectedImpl?.[proxy.toLowerCase()] : null
      if (!accepted) return `store-changed: no accepted implementation is listed for the ${role} ${proxy ?? '(none)'} on chain ${chainId}`
      const word = String(await needRpc().call('eth_getStorageAt', [proxy, IMPL_SLOT, block], STRICT)).toLowerCase()
      const impl = /^0x0{24}[0-9a-f]{40}$/.test(word) ? '0x' + word.slice(26) : null
      if (!impl || !accepted.map((a) => a.toLowerCase()).includes(impl)) return `store-changed: the ${role} ${proxy} runs ${impl ?? word.slice(0, 66)}, not an implementation TAP-10 accepts`
    }
    return null
  }
  // Read at the pinned block of the principal's identity (draft TAP §6.2), once per principal and verification (1.8):
  // both passes of verifyTaskThread use one read. / 在委托方身份的钉块上读，每个委托方每次核验一次（1.8）：线程两遍共用一次读取。
  function readRevocations(container, identity, ctx) {
    const k = String(container).toLowerCase()
    let p = ctx.revocations.get(k)
    if (!p) { p = readRevocationsAt(container, identity, ctx); ctx.revocations.set(k, p) }
    return p
  }
  async function readRevocationsAt(container, identity, ctx) {
    const floorKey = `${chainId}:${String(container).toLowerCase()}`
    const floor = Number((await floors.get(floorKey)) ?? 0)
    const changed = await storeChanged(ctx)
    if (changed) return { status: 'invalid', reason: changed }
    const block = await blockOf(ctx)
    // TAP-11 §2.2 step 3: the first site store listed for the chain that has any path for the container (one per chain
    // today); none with a path, or fileInfo's chunkCount 0 (TAP-10 §7.1 step 1), is no file
    // TAP-11 §2.2 第 3 步：链上列出的第一个对该容器有路径的站点存储；没有路径或 chunkCount 为 0 即没有文件
    const paths = BigInt(await strictCall(siteRegistry, 'pathCount', [container], block))
    const info = paths === 0n ? null : await strictCall(siteRegistry, 'fileInfo', [container, MANDATES_KEY], block)
    if (!info || BigInt(info.chunkCount) === 0n) return floor > 0 ? { status: 'invalid', reason: `the revocation list (issued ${floor}) was removed from the site` } : { status: 'none-published' }
    const size = Number(info.size)
    if (size > MANDATES_LIMIT) return { status: 'invalid', reason: `${MANDATES_KEY} declares ${size} bytes, limit ${MANDATES_LIMIT}` }
    if (String(info.sha256Hash).toLowerCase() === ZERO32) return { status: 'invalid', reason: `${MANDATES_KEY} has no on-chain SHA-256` }
    let raw
    try { raw = hexToBytes(await strictCall(siteRegistry, 'read', [container, MANDATES_KEY], block)) } catch (e) { if (isRevert(e)) return { status: 'invalid', reason: `read(${MANDATES_KEY}) reverted` }; throw e }
    if (raw.length !== size || toHex(sha256(raw)) !== String(info.sha256Hash).toLowerCase()) return { status: 'invalid', reason: `${MANDATES_KEY}: the bytes do not match fileInfo` }
    let f
    // a byte order mark makes the file invalid (TextDecoder would drop it silently) / 以 BOM 开头即无效
    if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) return { status: 'invalid', reason: `${MANDATES_KEY} begins with a byte order mark` }
    try { f = safeParseJSON(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)) } catch (e) { return { status: 'invalid', reason: `${MANDATES_KEY}: ${e.message}` } }
    if (!f || typeof f !== 'object' || f['tapeapi-mandates'] !== MANDATES_FORMAT || f.chainId !== chainId) return { status: 'invalid', reason: `${MANDATES_KEY}: not a format ${MANDATES_FORMAT} list for chain ${chainId}` }
    let r
    try { r = normalizeMandateRevocation(f.revocation) } catch (e) { return { status: 'invalid', reason: `${MANDATES_KEY}: ${e.message}` } }
    if (!eqAddr(r.principal, container)) return { status: 'invalid', reason: `${MANDATES_KEY} names principal ${r.principal}` }
    if (r.issued > clock() + REVOCATION_ISSUED_SKEW_S) return { status: 'invalid', reason: `${MANDATES_KEY}: issued is in the future` }
    if (!(await holderSigned(identity.holder, mandateRevocationDigest(chainId, hub, r), f.sig, ctx))) return { status: 'invalid', reason: `${MANDATES_KEY} is not signed by the current holder ${identity.holder}` }
    if (r.issued < floor) return { status: 'invalid', reason: `${MANDATES_KEY}: issued ${r.issued} is older than a list already seen (${floor}): a replaced list was put back` }
    if (r.issued > floor) await floors.set(floorKey, r.issued)
    return { status: 'published', issued: r.issued, revokedBefore: r.revokedBefore, mandateHashes: r.mandateHashes }
  }
  const revokes = (r, mandateHash, m) => r.mandateHashes.includes(mandateHash) || m.notBefore < r.revokedBefore

  // A signed revocation message (the direct path): checked against the current holder; returns the normalised revocation
  // or a problem. / 直发的撤销消息
  async function checkRevocationMessage(msg, identity, ctx) {
    let r
    try { r = normalizeMandateRevocation(msg?.revocation) } catch (e) { return { problem: problem('message-malformed', `revocation: ${e.message}`) } }
    if (!eqAddr(r.principal, identity.container)) return { problem: problem('revocation-mismatch', `revocation names principal ${r.principal}, not ${identity.container}`) }
    if (!(await holderSigned(identity.holder, mandateRevocationDigest(chainId, hub, r), msg.sig, ctx))) return { problem: problem('not-signed-by-holder', `revocation is not signed by the current holder ${identity.holder}`) }
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
   * mandate-expired, mandate-too-long, agent-key-mismatch, agent-mismatch, not-tapeout, no-such-token,
   * not-signed-by-holder, nonce-reused, mandate-revoked, revocation-unavailable. Every read at one pinned block (1.8).
   */
  function verifyMandate(signed, o = {}) { return verifyMandateIn(signed, o, context()) }
  async function verifyMandateIn(signed, o, ctx) {
    const problems = []
    const out = { ok: false, problems, enforcement: 'none', phase: 0 }
    let m
    // the JSON forms of draft TAP §3.7 only (1.8): a uint256 as a JSON number, an upper-case bytes32 or a missing member is
    // malformed / 只接受草稿 §3.7 的 JSON 形式（1.8）
    try { m = normalizeMandate(signed?.mandate, { wire: true }) } catch (e) { problems.push(problem('mandate-malformed', e.message)); return out }
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
    const id = await identityOf(m.principal, ctx)
    if (id.problem) { problems.push(id.problem); return out }
    out.principal = id.identity
    // TAP-11 §4.4 against the CURRENT holder of the principal's circuit; a manifest-delegated signer is never accepted
    if (!(await holderSigned(id.identity.holder, digest, signed.sig, ctx))) { problems.push(problem('not-signed-by-holder', `not signed by the current holder ${id.identity.holder} of ${m.principal}`)); return out }
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
      const site = await readRevocations(m.principal, id.identity, ctx)
      Object.assign(rev, { site })
      rev.status = site.status
      if (site.status === 'invalid') problems.push(problem('revocation-unavailable', `the principal's revocation list cannot be relied on: ${site.reason}`))
      else if (site.status === 'published' && revokes(site, mandateHash, m)) { rev.revoked = true; rev.at = site.issued; rev.via = 'site' }
    }
    for (const msg of o.revocations ?? []) {
      const c = await checkRevocationMessage(msg, id.identity, ctx)
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
    const form = agentMessageProblem(receipt, kind, agentContainer)
    if (form) return { problem: form }
    let svc
    try { svc = await serviceOf(agentContainer) } catch (e) {
      // the counterparty's failure is a verdict (as provider-unresolvable is); an RPC failure is still thrown
      if (partyCannotResolve(e)) return { problem: problem('agent-unresolvable', `${kind}: the agent ${agentContainer} does not resolve: ${e.message}`) }
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
  function verifyEvidence(deliver, o = {}) { return verifyEvidenceIn(deliver, o, context()) }
  async function verifyEvidenceIn(deliver, { mandate } = {}, ctx) {
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
      const form = hashOnlyReceiptProblem(r)
      if (form) { problems.push({ ...form, message: `${at}: ${form.message}` }); continue }
      if (sigs.has(String(r.sig).toLowerCase())) { problems.push(problem('receipt-repeated', `${at} repeats an earlier receipt`)); continue }
      sigs.add(String(r.sig).toLowerCase())
      const entry = { container: checksumAddress(r.service.container), name: null, method: plainText(r.method, 64), ts: r.ts, ok: r.ok, answeredBy: false }
      out.receipts.push(entry)
      if (!scope.has(entry.container.toLowerCase())) problems.push(problem('receipt-provider-out-of-scope', `${at}: ${entry.container} is not a provider in the mandate's scope`))
      if (r.ts < m.notBefore || r.ts > m.expires) problems.push(problem('receipt-outside-mandate', `${at}: answered at ${r.ts}, outside the mandate's window ${m.notBefore}..${m.expires}`))
      let svc
      try { svc = await serviceOf(entry.container) } catch (e) {
        if (partyCannotResolve(e)) { problems.push(problem('provider-unresolvable', `${at}: ${entry.container}: ${e.message}`)); continue }
        throw e
      }
      let signer
      try { signer = recoverResponseSignerFromHashes({ container: entry.container, id: r.id, requestHash: r.requestHash, ok: r.ok, bodyHash: r.bodyHash, ts: r.ts }, r.sig) } catch (e) { problems.push(problem('receipt-invalid', `${at}: ${e.message}`)); continue }
      if (!eqAddr(signer, svc.manifest.signer)) { problems.push(problem('receipt-invalid', `${at}: signed by ${signer}, ${entry.container} publishes signer ${svc.manifest.signer}`)); continue }
      entry.answeredBy = true
      const idn = await identityOf(entry.container, ctx)
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
   *
   * Revocation (draft TAP §7.5, §7.6): a revocation, from a `revocation` message or from the principal's site list found
   * while checking the applied mandate, only sets the thread's revocation time R (the smallest `issued` of those that
   * apply). It never changes the state when met: an agent message signed after R is refused (message-after-revocation),
   * a verdict is allowed whatever its `issued`, and only the final checks turn Offered, Accepted or Active into
   * Cancelled (before Expired). R depends on the applied mandate, which depends on the accept, so the thread is read
   * twice: the first pass, without the message-after-revocation checks, finds R; the second applies them with that R,
   * and its problems are the ones reported. Whether a revocation applies is judged against the mandate applied in the
   * first pass. mandate-revoked is not reported in a thread.
   * 撤销（草稿 §7.5、§7.6）：撤销只设定撤销时间 R，遇到时不改状态；签名晚于 R 的代理消息被拒；判决不受 R 限制；只在最后检查时把
   * Offered/Accepted/Active 判为 Cancelled（先于 Expired）。两遍处理：第一遍不做 message-after-revocation 检查以求 R，第二遍用这个 R
   * 做检查，报告第二遍的问题。撤销是否适用按第一遍应用的授权书判断。线程里不报 mandate-revoked。
   */
  async function verifyTaskThread(messages, o = {}) {
    const out = { ok: false, state: null, problems: [], enforcement: 'none', selfHire: false, selfHireReasons: [], deliveries: [], verdict: null, revoked: null, unaccepted: false }
    if (!Array.isArray(messages) || messages.length === 0) { out.problems.push(problem('thread-empty', 'a thread is a non-empty array of messages')); return out }
    const now = o.at ?? clock()
    // one pinned block for the whole thread, both passes included (1.8) / 整个线程一个钉块，两遍都用它（1.8）
    const ctx = context()
    // first pass: no message-after-revocation checks / 第一遍：不做撤销后检查
    const first = await threadPass(messages, Infinity, o, ctx)
    const revs = await threadRevocations(messages, first, ctx)
    const times = [...revs.applying]
    if (first.siteRevocation) times.push(first.siteRevocation)
    const R = times.reduce((min, t) => (!min || t.at < min.at ? t : min), null)
    // second pass with R; its problems are the ones reported / 第二遍用 R，报告这一遍的问题
    const pass = Number.isFinite(R?.at) ? await threadPass(messages, R.at, o, ctx) : first
    const problems = [...pass.problems, ...revs.problems]
    const { offer, accept, mandate, lastDeliver, principalId, agentSvc } = pass
    Object.assign(out, { problems, state: pass.state, deliveries: pass.deliveries, verdict: pass.verdict, revoked: R ? { at: R.at, via: R.via } : null })
    if (offer) Object.assign(out, { offerHash: pass.offerHash, taskHash: offer.taskHash, principal: principalId })
    if (mandate) Object.assign(out, { mandateHash: pass.mandateHash, mandate, mandateCheck: pass.mandateCheck })
    if (pass.evidence) out.evidence = pass.evidence
    // ---- final checks, in this order (§7.6) / 最后检查，按此顺序 ----
    if (['Offered', 'Accepted', 'Active'].includes(out.state) && R && R.at <= now) out.state = 'Cancelled'
    else if (out.state === 'Offered' && now > offer.exp) out.state = 'Expired'
    else if (out.state === 'Accepted' && Number.isSafeInteger(accept.exp) && now > accept.exp) out.state = 'Expired'
    else if (out.state === 'Active' && now > mandate.expires) out.state = 'Expired'
    // the delivery's own exp is how long the agent waits for a verdict: past it, delivered and never accepted (no arbiter)
    else if (out.state === 'Delivered' && now > lastDeliver.exp) out.unaccepted = true
    // ---- parties and self-hire / 双方与自雇自 ----
    if (offer) {
      const agentId = await identityOf(offer.agent, ctx)
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

  // The `revocation` messages of a thread, wherever they appear, judged against the mandate applied in the first pass
  // (§7.5): valid (§6.1) and covering that mandate, or carrying a date when no mandate is applied. Each that applies
  // contributes its `issued`; one that does not is revocation-mismatch; one in a thread without an offer is out-of-order.
  // 线程里的 revocation 消息（不论位置），按第一遍应用的授权书判断是否适用。
  async function threadRevocations(messages, first, ctx) {
    const problems = [], applying = []
    for (const [i, msg] of messages.entries()) {
      if (msg?.v !== 0 || msg?.kind !== KIND_PREFIX + 'revocation') continue
      const where = `messages[${i}]`
      if (!first.principalId) { problems.push(problem('out-of-order', `${where}: a revocation in a thread without an offer`)); continue }
      const c = await checkRevocationMessage(msg, first.principalId, ctx)
      if (c.problem) { problems.push({ ...c.problem, message: `${where}: ${c.problem.message}` }); continue }
      const r = c.revocation
      const applies = first.mandate ? revokes(r, first.mandateHash, first.mandate) : r.revokedBefore > 0
      if (!applies) { problems.push(problem('revocation-mismatch', `${where}: the revocation does not cover this thread's mandate`)); continue }
      applying.push({ at: r.issued, via: 'message' })
    }
    return { problems, applying }
  }

  // One pass over the messages other than `revocation`, in the order presented (§7.4). `R`: the revocation time, Infinity
  // in the first pass. Returns the state and what it applied; `siteRevocation` is the covering revocation found in the
  // principal's site list while checking the APPLIED mandate (a refused mandate leaves no trace).
  // 按顺序处理 revocation 以外的消息一遍。R 在第一遍为 Infinity。siteRevocation 只来自已应用的授权书。
  async function threadPass(messages, R, o, ctx) {
    const problems = []
    const st = { state: null, deliveries: [], verdict: null, evidence: null, siteRevocation: null }
    let offer = null, offerHash = null, accept = null, mandate = null, mandateHash = null, principalId = null, agentSvc = null, lastDeliver = null
    for (const [i, msg] of messages.entries()) {
      const where = `messages[${i}]`
      const kind = typeof msg?.kind === 'string' && msg.kind.startsWith(KIND_PREFIX) ? msg.kind.slice(KIND_PREFIX.length) : null
      if (!msg || msg.v !== 0 || kind === null) { problems.push(problem('message-malformed', `${where}: not a v 0 ${KIND_PREFIX}* message`)); continue }
      if (RESERVED_KINDS.includes(kind)) { problems.push(problem('kind-not-implemented', `${where}: ${kind} is a reserved message name this version does not implement`)); continue }
      if (!THREAD_KINDS.includes(kind)) { problems.push(problem('kind-unknown', `${where}: unknown kind ${plainText(kind, 40)}`)); continue }
      if (kind === 'revocation') continue   // considered apart, wherever it appears (§7.5) / 单独处理，不论位置
      const order = (want) => { if (!want.includes(st.state)) { problems.push(problem('out-of-order', `${where}: ${kind} in state ${st.state ?? 'none'} (expected ${want.map((x) => x ?? 'none').join(' or ')})`)); return false } return true }
      if (kind === 'offer') {
        if (!order([null])) continue
        let ofr
        try { ofr = normalizeTaskOffer(msg.offer, { wire: true }) } catch (e) { problems.push(problem('message-malformed', `${where}: ${e.message}`)); continue }
        try { if (taskHashOf(msg.task) !== ofr.taskHash) { problems.push(problem('task-hash-mismatch', `${where}: the task text does not hash to offer.taskHash`)); continue } } catch (e) { problems.push(problem('message-malformed', `${where}: ${e.message}`)); continue }
        const id = await identityOf(ofr.principal, ctx)
        if (id.problem) { problems.push(id.problem); continue }
        const digest = taskOfferDigest(chainId, hub, ofr)
        if (!(await holderSigned(id.identity.holder, digest, msg.sig, ctx))) { problems.push(problem('not-signed-by-holder', `${where}: the offer is not signed by the current holder ${id.identity.holder} of ${ofr.principal}`)); continue }
        offer = ofr; offerHash = toHex(digest); principalId = id.identity
        st.state = 'Offered'
      } else if (kind === 'accept') {
        if (!order(['Offered'])) continue
        const c = await checkAgentReceipt(msg.receipt, offer.agent, 'accept')
        if (c.problem) { problems.push(c.problem); continue }
        const r = msg.receipt.result
        if (r.offerHash !== offerHash) { problems.push(problem('offer-mismatch', `${where}: accept names offer ${plainText(String(r.offerHash), 70)}, not ${offerHash}`)); continue }
        if (!isAddress(r.agentKey) || eqAddr(r.agentKey, ZERO_ADDRESS)) { problems.push(problem('message-malformed', `${where}: accept must announce a non-zero agentKey`)); continue }
        if (msg.receipt.ts > offer.exp) { problems.push(problem('offer-expired', `${where}: accepted at ${msg.receipt.ts}, the offer expired at ${offer.exp}`)); continue }
        if (msg.receipt.ts > R) { problems.push(problem('message-after-revocation', `${where}: accept signed at ${msg.receipt.ts}, after the revocation at ${R}`)); continue }
        accept = { agentKey: checksumAddress(r.agentKey), exp: r.exp, ts: msg.receipt.ts }
        agentSvc = c.svc
        st.state = 'Accepted'
      } else if (kind === 'mandate') {
        if (!order(['Accepted'])) continue
        // The fields compared with the offer first, without the chain: a mandate that names another principal, task, mode
        // or nonce is refused before verifyMandate records its nonce, so a mistaken mandate does not use up the offer's
        // nonce (the corrected one must carry the same nonce). No revocation is missed: none is read for it either.
        // 先不读链地比对字段：写错的授权书在记录 nonce 之前就被拒，不会用掉报价的 nonce。
        let pre = null
        try { pre = normalizeMandate(msg?.mandate, { wire: true }) } catch { /* reported by verifyMandate as mandate-malformed */ }
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
        const v = await verifyMandateIn(msg, { agentKey: accept.agentKey, agent: offer.agent, at: o.at, readSite: o.readSite }, ctx)
        const mm = v.mandate
        // the window is checked against what the agent did (deliveries) and by the final time checks, not against `at`;
        // mandate-revoked is not reported in a thread: a covering revocation only sets R (§7.5)
        const silent = ['mandate-expired', 'mandate-not-yet', 'mandate-revoked']
        for (const p of v.problems) if (!silent.includes(p.code)) problems.push({ ...p, message: `${where}: ${p.message}` })
        if (!mm || v.problems.some((p) => !silent.includes(p.code))) continue
        mandate = mm; mandateHash = v.mandateHash
        st.mandateCheck = v
        // a site revocation counts only for the applied mandate (a refused one leaves no trace, §7.4)
        if (v.revocation?.revoked && v.revocation.via === 'site') st.siteRevocation = { at: v.revocation.at, via: 'site' }
        st.state = 'Active'
      } else if (kind === 'deliver') {
        if (!order(['Active', 'Rejected'])) continue
        const c = await checkAgentReceipt(msg.receipt, mandate.agent, 'deliver')
        if (c.problem) { problems.push(c.problem); continue }
        const r = msg.receipt.result
        if (r.mandateHash !== mandateHash) { problems.push(problem('mandate-mismatch', `${where}: deliver names mandate ${plainText(String(r.mandateHash), 70)}, not ${mandateHash}`)); continue }
        if (typeof r.deliverableHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(r.deliverableHash)) { problems.push(problem('message-malformed', `${where}: deliverableHash must be 0x and 64 lowercase hex digits`)); continue }
        const ts = msg.receipt.ts
        if (ts > R) { problems.push(problem('message-after-revocation', `${where}: delivered at ${ts}, after the revocation at ${R}`)); continue }
        if (ts < mandate.notBefore || ts > mandate.expires) { problems.push(problem('deliver-outside-mandate', `${where}: delivered at ${ts}, outside the mandate's window ${mandate.notBefore}..${mandate.expires}`)); continue }
        if (r.exp < ts) { problems.push(problem('message-malformed', `${where}: deliver expires (${r.exp}) before it was signed (${ts})`)); continue }
        if (ts < accept.ts) { problems.push(problem('deliver-before-accept', `${where}: delivered at ${ts}, before the agent accepted at ${accept.ts}`)); continue }
        // the offer's deadline is the principal's: a late delivery is recorded (it is a fact) and reported
        if (ts > offer.deadline) problems.push(problem('deliver-after-deadline', `${where}: delivered at ${ts}, after the offer's deadline ${offer.deadline}`))
        const ev = await verifyEvidenceIn(r, { mandate }, ctx)
        for (const p of ev.problems) problems.push({ ...p, message: `${where}: ${p.message}` })
        lastDeliver = { deliverableHash: r.deliverableHash, ts, exp: r.exp, receiptsHash: r.receiptsHash }
        st.deliveries.push({ ...lastDeliver, evidence: ev })
        st.evidence = ev
        st.state = 'Delivered'
      } else if (kind === 'acceptance') {
        if (!order(['Delivered'])) continue
        let v
        try { v = normalizeTaskVerdict(msg.verdict, { wire: true }) } catch (e) { problems.push(problem('message-malformed', `${where}: ${e.message}`)); continue }
        if (!(await holderSigned(principalId.holder, taskVerdictDigest(chainId, hub, v), msg.sig, ctx))) { problems.push(problem('not-signed-by-holder', `${where}: the verdict is not signed by the current holder ${principalId.holder}`)); continue }
        if (v.mandateHash !== mandateHash || v.deliverableHash !== lastDeliver.deliverableHash) { problems.push(problem('verdict-mismatch', `${where}: the verdict is for another mandate or deliverable`)); continue }
        if (v.issued < lastDeliver.ts) { problems.push(problem('verdict-before-delivery', `${where}: issued ${v.issued}, before the delivery at ${lastDeliver.ts}`)); continue }
        st.verdict = { verdict: v.verdict === VERDICT_ACCEPT ? 'accepted' : 'rejected', issued: v.issued, reasonHash: v.reasonHash, deliverableHash: v.deliverableHash, verdictHash: toHex(taskVerdictDigest(chainId, hub, v)) }
        st.state = v.verdict === VERDICT_ACCEPT ? 'Settled' : 'Rejected'
      }
    }
    return { ...st, problems, offer, offerHash, accept, mandate, mandateHash, principalId, agentSvc, lastDeliver }
  }

  return {
    verifyMandate, verifyTaskThread, verifyEvidence,
    readRevocations: async (container) => { const ctx = context(); const id = await identityOf(container, ctx); if (id.problem) return { status: 'invalid', reason: id.problem.message }; return readRevocations(container, id.identity, ctx) },
    identityOf: async (container) => { const id = await identityOf(container, context()); if (id.problem) throw new TapeAPIError('AGENT_INVALID', id.problem.message, { reason: id.problem.code }); return id.identity },
    chainId, hub,
  }
}

// The verdict constants again, for a caller that only imports this module / 方便只引入本模块的调用方
export { VERDICT_ACCEPT, VERDICT_REJECT }
