// @experimental (1.7) Container agents, phase 0: verifying a mandate, a task thread and the evidence a delivery carries.
// Every decision reads the chain through the client it is given (createAgentKit(api)) under TAP-10 strict agreement
// ({ answers: 'tap10', strict: true }: every configured node, from at least max(2, min(3, operators)) operators), so one
// operator that lies cannot make a check pass. An RPC failure is thrown, never turned into a verdict.
// Since 1.8 every read of one verification (verifyMandate, verifyTaskThread, verifyEvidence, readRevocations, identityOf)
// is made at ONE TAP-10 pinned block (§5.3, draft TAP §4 and §6.2): the principal's identity and holder, the EIP-1271
// calls, both implementation slots and the revocation file. Agents and providers are resolved as TAP-11 §2 says (their
// own resolution, with its own pinned block): since 2.0.0, without a `resolve` option, by the conformance mode
// (conform: 'tap10') made from the kit's client (kit.resolution, below).
// 1.8 起一次核验的全部读取都钉在同一个 TAP-10 钉块上：委托方身份与持有人、EIP-1271、两个实现槽与撤销文件。代理与上游服务按
// TAP-11 §2 解析（各自的解析、各自的钉块）：2.0.0 起不给 resolve 时，由 kit 的客户端建立的一致模式解析（见下面的 kit.resolution）。
// What phase 0 does NOT do, and every result says so with `enforcement: 'none'`: no contract enforces any amount, time or
// counterparty. A mandate is a holder's signed statement that a counterparty can check; nothing more.
// Phase 1 (experimental, local chains only; internal design notes, phase 1): with
// { enforcement: 'escrow-channel' } a mandate that names funds is checked against the escrow channels that enforce it.
// 阶段 1（实验，仅本地链）：带 { enforcement: 'escrow-channel' } 时，带金额的授权书对照强制执行它的托管通道核验。
// Designed in internal notes (container agents, phase 0). Not covered by the 2.x compatibility promise.
import { sha256 } from '@noble/hashes/sha256'
import { TapeAPIError } from './errors.js'
import { safeParseJSON } from './canon.js'
import { selector, encodeParams, decodeParams, encodeCall, decodeReturn, hexToBytes, toHex, bytesToHex, isAddress, eqAddr, checksumAddress, keccak256, ZERO_ADDRESS } from './abi.js'
import { recoverAddress, recoverResponseSigner, recoverResponseSignerFromHashes } from './sig.js'
import { chainById, formatTapeName, IMPL_SLOT, MAX_TOKEN_ID, AUDITED_ESCROWS } from './chains.js'
import { PROCESSORS_SNAPSHOT } from './processors-snapshot.js'
import { validateManifest, findMethod, methodPrice } from './manifest.js'
import {
  normalizeMandate, mandateDigest, normalizeTaskOffer, taskOfferDigest, normalizeTaskVerdict, taskVerdictDigest,
  normalizeMandateRevocation, mandateRevocationDigest, taskHashOf, jsonHashOf, VERDICT_ACCEPT, VERDICT_REJECT, phase0Problems,
  phase1Problems, phase1Warnings, mandateNamesFunds, ENFORCEMENT_ESCROW_CHANNEL, DEFAULT_FUNDING_PATH, FUNDING_PATHS,
  WITHDRAW_COOLDOWN_S, WITHDRAW_WINDOW_S, withdrawRequestLive,
} from './agent-sig.js'
import { CONFORM_SIBLINGS } from './conform-sibling.js'
import { escrowPlan, closeOutPlan, planApplied, sessionEntry, mandateChannelsElsewhere, requireHistory, spendEvidence, EXECUTE_SELECTOR, EXECUTE_FEE_SELECTOR } from './agent-pay.js'

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
// ---- phase 1 (experimental): a withdraw request's lifetime (draft §2.6, R21), defined in agent-sig.js (the plan's
// close-out uses it too) / 阶段 1：提现请求的存活，定义在 agent-sig.js（收尾计划也用） ----
export { WITHDRAW_COOLDOWN_S, WITHDRAW_WINDOW_S, withdrawRequestLive }
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
// Phase 1 (experimental, draft §5.2): its static problems burn no nonce, as phase0-no-funds does; its chain problems (the
// channel's state, which the holder fixes with a transaction) do not keep the nonce unrecorded.
// 阶段 1：静态问题与 phase0-no-funds 一样不消耗 nonce；链上问题（通道状态，持有人补交易即可）不影响 nonce 记录。
const NONCE_BLOCKING = new Set(['phase0-no-funds', 'subdelegate-not-allowed', 'mandate-too-long', 'agent-key-mismatch', 'agent-mismatch',
  'scope-token-cap-mismatch', 'fee-token-cap-mismatch', 'scope-duplicate-provider', 'mode-scope-mismatch'])
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
// client (createTapeAPI({ conform: 'tap10' })) says which in data.status; a conform: false client's codes are read the same way.
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
// TAP-13 §3, §4: id a string of 1 to 128 UTF-16 code units (the empty id exists only under binding rule 1, TAP-13 §4, where
// the call is refused: a hash-only receipt with ok false), the path segment, params an object when present, sig 65 bytes in
// hex / TAP-13 的 id（1 到 128 个码元；空串只在 §4 规则 1 下出现，此时 ok 为 false）、路径段、params、sig 形式
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
 *   resolve           (container) => resolved service. Only the function can be replaced, never the signer it yields.
 *                     Default (2.0.0): as TAP-11 §2 says, by createTapeAPI({ conform: 'tap10' }) with the client's own options
 *                     and nodes (`api` itself when it is in that mode), never with allChains; a client whose contracts are
 *                     not the ones TAP-10 lists for its chain (a local or test deployment) resolves with api.resolve.
 *                     `kit.resolution` says which: 'tap10', 'client' or 'caller' (this option).
 *                     只能替换解析函数。默认（2.0.0）：按 TAP-11 §2，用客户端自己的选项与节点建立的一致模式解析（客户端本身已是
 *                     一致模式就用它），绝不开 allChains；合约不是 TAP-10 为该链列出的那些（本地或测试部署）时用 api.resolve。
 *                     kit.resolution 说明是哪一种。
 */
export function createAgentKit(api, opts = {}) {
  if (!api || typeof api !== 'object' || !api.chain || !api.addresses) throw new TapeAPIError('INVALID_ARGUMENT', 'createAgentKit takes a createTapeAPI() client')
  if (opts.clock !== undefined && typeof opts.clock !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', 'clock must be a function returning Unix seconds')
  if (opts.revocationFloor !== undefined && !isStore(opts.revocationFloor)) throw new TapeAPIError('INVALID_ARGUMENT', 'revocationFloor must be a { get, set } store')
  if (opts.nonces !== undefined && !(opts.nonces instanceof Map) && typeof opts.nonces?.setIfAbsent !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', 'nonces must be a Map or a { setIfAbsent(key, value) => previous value } store (one atomic step)')
  if (opts.resolve !== undefined && typeof opts.resolve !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', 'resolve must be a function')
  if (opts.allowEscrows !== undefined && (!Array.isArray(opts.allowEscrows) || !opts.allowEscrows.every(isAddress))) throw new TapeAPIError('INVALID_ARGUMENT', 'allowEscrows must be an array of escrow addresses')
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
  const { resolution, resolveSvc } = resolverOf(api, opts.resolve)
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
  // One site file of `container` at the verification's pinned block, every read strict: the revocation list (MANDATES_KEY)
  // and, in phase 1, a provider's manifest (its payment.escrow). Returns { status: 'none' } (no file), { status:
  // 'invalid', reason } or { status: 'ok', bytes }. The caller checks storeChanged first.
  // 容器在钉块上的一个站点文件（严格读）：撤销清单，以及阶段 1 里 provider 的清单。调用方先检查 storeChanged。
  async function siteFileAt(container, key, limit, ctx) {
    const block = await blockOf(ctx)
    // TAP-11 §2.2 step 3: the first site store listed for the chain that has any path for the container (one per chain
    // today); none with a path, or fileInfo's chunkCount 0 (TAP-10 §7.1 step 1), is no file
    // TAP-11 §2.2 第 3 步：链上列出的第一个对该容器有路径的站点存储；没有路径或 chunkCount 为 0 即没有文件
    const paths = BigInt(await strictCall(siteRegistry, 'pathCount', [container], block))
    const info = paths === 0n ? null : await strictCall(siteRegistry, 'fileInfo', [container, key], block)
    if (!info || BigInt(info.chunkCount) === 0n) return { status: 'none' }
    const size = Number(info.size)
    if (size > limit) return { status: 'invalid', reason: `${key} declares ${size} bytes, limit ${limit}` }
    if (String(info.sha256Hash).toLowerCase() === ZERO32) return { status: 'invalid', reason: `${key} has no on-chain SHA-256` }
    let raw
    try { raw = hexToBytes(await strictCall(siteRegistry, 'read', [container, key], block)) } catch (e) { if (isRevert(e)) return { status: 'invalid', reason: `read(${key}) reverted` }; throw e }
    if (raw.length !== size || toHex(sha256(raw)) !== String(info.sha256Hash).toLowerCase()) return { status: 'invalid', reason: `${key}: the bytes do not match fileInfo` }
    // a byte order mark makes the file invalid (TextDecoder would drop it silently) / 以 BOM 开头即无效
    if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) return { status: 'invalid', reason: `${key} begins with a byte order mark` }
    return { status: 'ok', bytes: raw }
  }
  async function readRevocationsAt(container, identity, ctx) {
    const floorKey = `${chainId}:${String(container).toLowerCase()}`
    const floor = Number((await floors.get(floorKey)) ?? 0)
    const changed = await storeChanged(ctx)
    if (changed) return { status: 'invalid', reason: changed }
    const file = await siteFileAt(container, MANDATES_KEY, MANDATES_LIMIT, ctx)
    if (file.status === 'none') return floor > 0 ? { status: 'invalid', reason: `the revocation list (issued ${floor}) was removed from the site` } : { status: 'none-published' }
    if (file.status === 'invalid') return { status: 'invalid', reason: file.reason }
    const raw = file.bytes
    let f
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
   *   enforcement       @experimental phase 1: 'escrow-channel' checks a mandate that names funds by the phase-1 rules
   *                     (draft §5) instead of refusing it as phase0-no-funds. Any other value, or none: phase 0, as 1.8.
   * Returns { ok, problems, enforcement: 'none', phase: 0, mandateHash, mandate, principal, agent, agentKey, notBefore,
   * expires, revocation }. Problems (codes): mandate-malformed, phase0-no-funds, subdelegate-not-allowed, mandate-not-yet,
   * mandate-expired, mandate-too-long, agent-key-mismatch, agent-mismatch, not-tapeout, no-such-token,
   * not-signed-by-holder, nonce-reused, mandate-revoked, revocation-unavailable. Every read at one pinned block (1.8).
   * Phase 1 (a mandate that names funds, with the switch): phase 1, bound 'channel' (the chain bounds what the agent key
   * can spend by each channel's balance, never by the cap), `warnings` (scope-includes-agent: reported, never refused), and the static problems scope-token-cap-mismatch, fee-token-cap-mismatch, scope-duplicate-provider,
   * mode-scope-mismatch, subdelegate-not-allowed in place of phase0-no-funds; then, read at the pinned block, the chain
   * problems provider-unresolvable, agent-unresolvable, escrow-not-allowed, escrow-other-chain, escrow-token-mismatch,
   * session-missing, session-expiry-mismatch, withdraw-pending, channel-empty, agent-key-on-fee-channel,
   * fee-channel-short, channel-exceeds-cap (a channel above its cap fails closed); `consumer`, `fundingPath`, `scope` (one reading per capped
   * item) and `fee`. enforcement is 'escrow-channel' only when there is no problem at all. Options: fundingPath
   * ('holder', the default: the principal's current holder funded the channels, F2; 'container': the principal, F1),
   * feeDue (the amount agreed for the fee channel, a decimal string).
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
    // @experimental phase 1 (draft §5.1): only when the caller asks ({ enforcement: 'escrow-channel' }) and only for a
    // mandate that names funds, the static rules of §5.2 replace phase0-no-funds. Any other value of the option, or none,
    // is phase 0 exactly as in 1.8. A mandate that names no funds is checked by the phase-0 rules either way.
    // 阶段 1：只有调用方显式要求、且授权书带金额时，才以 §5.2 的静态规则代替 phase0-no-funds；否则与 1.8 完全相同。
    const p1 = o.enforcement === ENFORCEMENT_ESCROW_CHANNEL && mandateNamesFunds(m)
    if (p1) {
      if (o.fundingPath !== undefined && !FUNDING_PATHS.includes(o.fundingPath)) throw new TapeAPIError('INVALID_ARGUMENT', `fundingPath must be one of ${FUNDING_PATHS.join(', ')} (default ${DEFAULT_FUNDING_PATH})`)
      if (o.feeDue !== undefined && (typeof o.feeDue !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(o.feeDue))) throw new TapeAPIError('INVALID_ARGUMENT', 'feeDue must be a decimal string (the smallest unit of the fee token)')
      // bound 'channel' (review p1m12 F2): what the chain bounds is each channel's balance, never the mandate's cap
      // 链上最坏损失的上界是通道余额，不是授权书的 cap
      Object.assign(out, { phase: 1, bound: 'channel', warnings: [] })
    }
    const statics = p1 ? phase1Problems(m) : phase0Problems(m)
    problems.push(...statics)
    // the static half of scope-includes-agent, whatever the static problems (review p1m12 F7) / 静态的一半，不论有无静态问题
    if (p1) out.warnings.push(...phase1Warnings(m))
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
    // phase 1: what the static rules leave to the chain, at this verification's pinned block / 阶段 1：静态规则之外读链的部分
    if (p1 && statics.length === 0) {
      await phase1Chain(m, id.identity, { ...o, now }, ctx, out)
      // escrow-channel only when every check, static and on chain, passed (draft §1.1, §5.1) / 全部通过才报 escrow-channel
      if (problems.length === 0) out.enforcement = ENFORCEMENT_ESCROW_CHANNEL
    }
    out.ok = problems.length === 0
    return out
  }

  // ---- phase 1 (experimental): the chain part of draft §5.2 and §3b.2 / 阶段 1：§5.2 与 §3b.2 读链的部分 ----
  // scope-includes-agent (§5.2, R5), the chain half: a capped scope item whose provider is a container held by the agent's
  // holder. The static half (the agent's own container) is phase1Warnings, reported at the static stage (review p1m12 F7).
  // Reported, never refused (as selfHire is): `warnings`, not `problems`. Read at the pinned block; a provider that is no
  // container is left to the channel checks.
  // scope-includes-agent 的链上一半：与代理同持有人；provider 就是代理容器的静态一半由 phase1Warnings 在静态阶段报。只报不拒。
  async function scopeIncludesAgent(m, ctx, warnings) {
    const capped = m.scope.filter((s) => s.cap !== '0')
    if (!capped.length) return
    const agentId = await identityOf(m.agent, ctx)
    for (const s of capped) {
      if (eqAddr(s.provider, m.agent)) continue   // reported by phase1Warnings / 已由 phase1Warnings 报告
      if (!agentId.identity) continue
      const pid = await identityOf(s.provider, ctx)
      if (pid.identity && eqAddr(pid.identity.holder, agentId.identity.holder)) warnings.push(problem('scope-includes-agent', `${s.provider} is held by ${pid.identity.holder}, who also holds the agent ${m.agent}: a channel to it pays the agent's holder`))
    }
  }
  // The channel mapping (draft §3b.2 items 2-7), every read strict at this verification's pinned block and kept for the
  // verification only (both passes of a thread read once). The consumer is the principal's current holder (F2, the
  // default) or the principal container (F1, fundingPath 'container'), draft §2.1. A node failure, a stale pin or nodes on
  // another chain are thrown (the verification is unavailable), never a problem of the mandate; what the counterparty
  // chose (its manifest, its escrow) is a problem. Chain problems do not keep the nonce unrecorded (§5.2).
  // 通道映射核验（§3b.2 第 2–7 项）：钉块上严格读，只在本次核验内复用。consumer 默认是委托方当前持有人（F2），或委托方容器（F1）。
  // 节点故障、钉块过期、节点在别的链上一律抛出，不报成授权书的问题；对方选的清单与托管才是问题。链上问题不影响 nonce 记录。
  const allowedEscrows = new Set([...(AUDITED_ESCROWS[chainId] ?? []), ...(opts.allowEscrows ?? [])].map((a) => a.toLowerCase()))
  function escrowRead(ctx, to, name, args) {
    ctx.escrowReads ??= new Map()
    const k = `${name}:${String(to).toLowerCase()}:${args.map((a) => String(a).toLowerCase()).join(',')}`
    let p = ctx.escrowReads.get(k)
    if (!p) {
      p = (async () => {
        const block = await blockOf(ctx)
        if (name === 'code') return hasCode(to, block)
        if (name === 'decimals') {
          // ERC-20 decimals() has no entry in the ABI table: the raw selector, a uint8 / 原始选择器
          let w
          try { w = String(await needRpc().ethCall(to, selector('decimals()'), block, STRICT)) } catch (e) { if (notAnAnswer(e)) return null; throw e }
          if (!/^0x[0-9a-fA-F]{64}/.test(w)) return null
          const d = BigInt(w.slice(0, 66))
          return d <= 255n ? Number(d) : null
        }
        if (name === 'escrowToken') {
          try { return checksumAddress(await strictCall(to, 'escrowToken', [], block)) } catch (e) { if (notAnAnswer(e)) return null; throw e }
        }
        return strictCall(to, name, args, block)
      })()
      ctx.escrowReads.set(k, p)
      p.catch(() => {})
    }
    return p
  }
  // Review p1m12 F1: in phase 1 a party's escrow is never taken from a resolution kept across verifications. (a) The
  // resolution (TAP-11 §2: is it a service at all) is kept per pinned block, for at most CACHE_MS by the kit's clock, as
  // storeChanged does: a verification that pins another block resolves again. (b) The escrow address itself is read from
  // the party's manifest file AT THIS VERIFICATION'S PINNED BLOCK, by the same strict site-file reads as the revocation
  // list (siteFileAt), validated as a manifest and naming this container; kept for this verification only (both passes
  // of a thread read it once). So a provider that changes payment.escrow is seen by the next verification at a later
  // block. The phase-0 paths (verifyEvidence, agent messages) keep serviceOf unchanged.
  // 审查 p1m12 F1：阶段 1 绝不从跨核验保留的解析结果里取托管地址。(a) 解析结果按钉块保留（kit 时钟，至多 CACHE_MS），钉到别的块就重新
  // 解析；(b) 托管地址本身从对方清单文件在本次核验钉块上的内容读取（与撤销清单同一条严格读取路径），按清单校验、须写明本容器；只在本次
  // 核验内复用。provider 改了 payment.escrow，下一次在更晚的块上的核验立即看见。阶段 0 的路径不变。
  const MANIFEST_KEY = '.well-known/tapeapi.json', MANIFEST_LIMIT = 64 * 1024   // TAPI-20 §3.2 path, 64 KiB / 固定路径与上限
  const servicesAtPin = new Map()   // `${pinned block hash}:${container}` -> { at: clock seconds, p }
  async function serviceAtPin(container, ctx) {
    const { hash } = await ctx.pin()
    const k = `${hash}:${String(container).toLowerCase()}`
    const now = clock()
    const e = servicesAtPin.get(k)
    if (e && now >= e.at && now - e.at < CACHE_MS / 1000) return e.p
    const p = Promise.resolve().then(() => resolveSvc(container))
    servicesAtPin.set(k, { at: now, p })
    p.catch(() => { if (servicesAtPin.get(k)?.p === p) servicesAtPin.delete(k) })
    if (servicesAtPin.size > 1024) servicesAtPin.delete(servicesAtPin.keys().next().value)
    return p
  }
  function manifestAtPin(container, ctx) {
    ctx.manifests ??= new Map()
    const k = String(container).toLowerCase()
    let p = ctx.manifests.get(k)
    if (!p) { p = readManifestAtPin(container, ctx); ctx.manifests.set(k, p); p.catch(() => {}) }
    return p
  }
  async function readManifestAtPin(container, ctx) {
    const changed = await storeChanged(ctx)
    if (changed) return { problem: changed }
    const file = await siteFileAt(container, MANIFEST_KEY, MANIFEST_LIMIT, ctx)
    if (file.status === 'none') return { problem: `no ${MANIFEST_KEY} at the pinned block` }
    if (file.status === 'invalid') return { problem: file.reason }
    let m
    try { m = validateManifest(safeParseJSON(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)), { requireDelegation: true, now: clock() }) } catch (e) { return { problem: `${MANIFEST_KEY} at the pinned block: ${e.message}` } }
    if (!eqAddr(m.container, container)) return { problem: `${MANIFEST_KEY} at the pinned block names container ${m.container}` }
    return { manifest: m }
  }
  // One channel (consumer, provider) on an escrow a manifest named: resolution, the manifest at the pinned block, the
  // allowed list, code, token(), then the channel's state. Returns the reading and pushes the problems.
  // 一条通道：解析、钉块上的清单、名单、代码、token()，再读通道状态
  async function readChannel(ctx, { consumer, provider, token, unresolvable, now }, problems) {
    const r = { escrow: null, token, decimals: null, channel: null, available: null, pendingWithdraw: null, sessionExpiry: null, claimedAtCheck: null }
    try { await serviceAtPin(provider, ctx) } catch (e) {
      if (partyCannotResolve(e)) { problems.push(problem(unresolvable, `${provider} does not resolve: ${e.message}`)); return r }
      throw e
    }
    const pinned = await manifestAtPin(provider, ctx)
    if (pinned.problem) { problems.push(problem(unresolvable, `${provider}: its manifest cannot be read at the pinned block: ${pinned.problem}`)); return r }
    const esc = pinned.manifest.payment?.escrow
    if (!isAddress(esc) || eqAddr(esc, ZERO_ADDRESS)) { problems.push(problem(unresolvable, `${provider} names no escrow in its manifest (payment.escrow): it takes no payment, so no channel can pay it`)); return r }
    r.escrow = checksumAddress(esc)
    if (!allowedEscrows.has(esc.toLowerCase())) { problems.push(problem('escrow-not-allowed', `${provider} names escrow ${r.escrow}, which is neither an audited escrow this SDK knows (none is audited yet) nor in allowEscrows (TAPI-22 §3.5)`)); return r }
    if (!(await escrowRead(ctx, esc, 'code', []))) { problems.push(problem('escrow-other-chain', `escrow ${r.escrow} has no code on chain ${chainId}, the mandate's chain`)); return r }
    const held = await escrowRead(ctx, esc, 'escrowToken', [])
    if (!held || !eqAddr(held, token)) { problems.push(problem('escrow-token-mismatch', held ? `escrow ${r.escrow} holds ${held}, the mandate names ${token}` : `escrow ${r.escrow} answers no token(): the unit of its amounts is unknown`)); return r }
    const [decimals, channel, pending, claimed] = await Promise.all([
      escrowRead(ctx, held, 'decimals', []), escrowRead(ctx, esc, 'channelOf', [consumer, provider]),
      escrowRead(ctx, esc, 'pendingWithdraw', [consumer, provider]), escrowRead(ctx, esc, 'claimedOf', [consumer, provider]),
    ])
    const [amount, requestedAt] = pending
    const live = withdrawRequestLive(requestedAt, now)
    const ch = BigInt(channel)
    const avail = ch - (live ? BigInt(amount) : 0n)
    Object.assign(r, { decimals, channel: ch.toString(), available: (avail > 0n ? avail : 0n).toString(), pendingWithdraw: { amount: BigInt(amount).toString(), requestedAt: Number(requestedAt), live }, claimedAtCheck: BigInt(claimed).toString() })
    return r
  }
  async function phase1Chain(m, principalId, o, ctx, out) {
    await scopeIncludesAgent(m, ctx, out.warnings)
    const fundingPath = o.fundingPath ?? DEFAULT_FUNDING_PATH
    const consumer = fundingPath === 'container' ? m.principal : principalId.holder
    Object.assign(out, { consumer, fundingPath })
    const problems = out.problems, now = o.now
    out.scope = []
    for (const s of m.scope.filter((x) => x.cap !== '0')) {
      const before = problems.length
      const r = await readChannel(ctx, { consumer, provider: s.provider, token: s.token, unresolvable: 'provider-unresolvable', now }, problems)
      const item = { provider: s.provider, escrow: r.escrow, token: s.token, decimals: r.decimals, cap: s.cap, channel: r.channel, available: r.available, pendingWithdraw: r.pendingWithdraw, sessionExpiry: null, claimedAtCheck: r.claimedAtCheck }
      out.scope.push(item)
      if (problems.length > before || r.channel === null) continue
      // §3b.2 item 4, §2.4: the agent key's session on this channel ends exactly at mandate.expires; it is live while
      // sessionExpiry >= now (the escrow settles at S, not at S + 1) / 会话到期必须恰为 expires；sessionExpiry ≥ now 时有效
      const se = Number(await escrowRead(ctx, r.escrow, 'sessionExpiry', [consumer, s.provider, m.agentKey]))
      item.sessionExpiry = se
      if (se === 0 || se < now) problems.push(problem('session-missing', `the agent key ${m.agentKey} has no live session on the channel (${consumer}, ${s.provider})${se ? `: it ended at ${se}` : ''}`))
      else if (se !== m.expires) problems.push(problem('session-expiry-mismatch', `the agent key's session on (${consumer}, ${s.provider}) ends at ${se}, the mandate at ${m.expires}: they must be equal (a later end lets a leaked key spend after the mandate expired)`))
      // §3b.2 item 5: a live request (R21's lifetime rule, not the view alone) / 存活的提现请求（按存活规则，不只看视图）
      if (r.pendingWithdraw.live) problems.push(problem('withdraw-pending', `a withdraw request of ${r.pendingWithdraw.amount} on (${consumer}, ${s.provider}) made at ${r.pendingWithdraw.requestedAt} is live until ${r.pendingWithdraw.requestedAt + WITHDRAW_COOLDOWN_S + WITHDRAW_WINDOW_S}`))
      if (BigInt(r.available) === 0n) problems.push(problem('channel-empty', `nothing is available on (${consumer}, ${s.provider}): channel ${r.channel}${r.pendingWithdraw.live ? `, ${r.pendingWithdraw.amount} requested for withdrawal` : ''}`))
      // §3b.2 item 6 (review p1m12 F2): the cap is the console's funding target, never a bound the chain enforces: the
      // on-chain bound is always the channel (result.bound 'channel'). A channel above the cap fails closed: the console
      // never funds above it (§2.3 rule 2), so a holder who did has left the mandate's terms. A chain problem: it does not
      // keep the nonce unrecorded. / cap 是控制台的充值目标，链上上界恒为通道余额；通道超过 cap 即核验失败（链上问题，不影响 nonce 记录）
      if (BigInt(r.channel) > BigInt(s.cap)) problems.push(problem('channel-exceeds-cap', `the channel (${consumer}, ${s.provider}) holds ${r.channel}, above the mandate's cap ${s.cap}: the key could spend the whole channel, so the mandate's cap would not bound it; withdraw the excess or sign a mandate for the channel`))
    }
    // §3b.2 item 7: the fee channel (consumer, agent), when feeCap > 0 / 费用通道
    if (m.feeCap !== '0') {
      const before = problems.length
      const r = await readChannel(ctx, { consumer, provider: m.agent, token: m.feeToken, unresolvable: 'agent-unresolvable', now }, problems)
      const fee = { agent: m.agent, escrow: r.escrow, token: m.feeToken, decimals: r.decimals, cap: m.feeCap, channel: r.channel, available: r.available, pendingWithdraw: r.pendingWithdraw, agentKeySession: null }
      out.fee = fee
      if (problems.length === before && r.channel !== null) {
        // G5: the agent key has NO session on the agent's own channel / 代理钥匙在代理自己的通道上没有会话
        fee.agentKeySession = Number(await escrowRead(ctx, r.escrow, 'sessionExpiry', [consumer, m.agent, m.agentKey]))
        if (fee.agentKeySession !== 0) problems.push(problem('agent-key-on-fee-channel', `the agent key ${m.agentKey} has a session (until ${fee.agentKeySession}) on the fee channel (${consumer}, ${m.agent}): the agent could pay itself`))
        if (o.feeDue !== undefined && BigInt(r.available) < BigInt(o.feeDue)) problems.push(problem('fee-channel-short', `the fee channel (${consumer}, ${m.agent}) has ${r.available} available, below the ${o.feeDue} agreed`))
      }
    }
  }

  // ---- phase 1, M3 (experimental): the holder's plan and its close-out, from facts read at ONE pinned block ----
  // Draft §6.1 S4/S4b. Every fact escrowPlan and closeOutPlan take is read here at one pinned block, strictly: the
  // principal's identity and current holder, each capped provider's manifest (its escrow) at that block, the escrow's
  // code and token(), the channel, a live request and the agent key's session; on the container path the principal's
  // code, opener.isOpened, and a simulated execute that finds the TapeOut fee (a revert 0xafd49700(paid, required)) and
  // whether execute still reverts with it (a gate the SDK cannot name: payment or listing, draft §2.1, R10, R20). Nothing
  // is signed or sent; a node failure is thrown. afterPlan reads at a NEW pinned block, after the holder sent the plan.
  // 阶段 1 的 M3：计划与收尾所需的全部事实在同一个钉块上严格读取；容器路径上用模拟的 execute 找出 TapeOut 费以及带费后是否仍回滚。
  // 不签名、不发送；节点故障抛出。afterPlan 在计划发出后的新钉块上读。
  const ALLOWANCE_SELECTOR = selector('allowance(address,address)')
  const SESSION_AUTHORIZED_TOPIC = toHex(keccak256('SessionAuthorized(address,address,address,uint64)'))
  const planPathOf = (o) => {
    const path = o.path ?? DEFAULT_FUNDING_PATH
    if (!FUNDING_PATHS.includes(path)) throw new TapeAPIError('INVALID_ARGUMENT', `path must be one of ${FUNDING_PATHS.join(', ')} (default ${DEFAULT_FUNDING_PATH})`)
    if (!isAddress(o.holder) || eqAddr(o.holder, ZERO_ADDRESS)) throw new TapeAPIError('INVALID_ARGUMENT', 'holder must be the wallet that sends the plan (on the container path, the holder who calls execute)')
    // review p1m3 R1: the fee comes from a simulation (the container, or the nodes); it is never attached without a
    // ceiling the caller names / 审查 p1m3 R1：费用来自模拟（容器或节点之言），没有调用方给的上限绝不附上
    if (path === 'container' && o.maxExecuteFee === undefined) throw new TapeAPIError('INVALID_ARGUMENT', 'the container path needs maxExecuteFee: the most each execute may take as the TapeOut fee (smallest unit of the native coin); a found fee above it is refused (execute-fee-too-high)')
    if (path === 'holder' && o.maxExecuteFee !== undefined) throw new TapeAPIError('INVALID_ARGUMENT', 'maxExecuteFee is for the container path only')
    const mf = o.maxExecuteFee
    if (path === 'container' && !((typeof mf === 'bigint' && mf >= 0n && mf < 1n << 256n) || (Number.isSafeInteger(mf) && mf >= 0) || (typeof mf === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(mf) && BigInt(mf) < 1n << 256n))) throw new TapeAPIError('INVALID_ARGUMENT', 'maxExecuteFee must be a whole number of the native coin\'s smallest unit (a decimal string, a safe integer or a bigint)')
    return path
  }
  async function principalOf(m, ctx) {
    const id = await identityOf(m.principal, ctx)
    if (id.problem) throw new TapeAPIError('AGENT_INVALID', `the principal: ${id.problem.message}`, { reason: id.problem.code })
    return id.identity
  }
  // the escrow a provider's manifest names at the pinned block, or null (it names none, or does not resolve)
  // provider 清单在钉块上写明的托管；没有或解析不了为 null
  async function escrowAtPin(provider, ctx) {
    try { await serviceAtPin(provider, ctx) } catch (e) { if (partyCannotResolve(e)) return null; throw e }
    const pinned = await manifestAtPin(provider, ctx)
    const esc = pinned.problem ? null : pinned.manifest.payment?.escrow
    return isAddress(esc) && !eqAddr(esc, ZERO_ADDRESS) ? checksumAddress(esc) : null
  }
  // A simulated execute(inner) through the principal, from the holder, at the pinned block (eth_call with from and
  // value, strict): { ok } or { ok: false, data } when every node reports a revert. / 钉块上模拟一次 execute
  async function simulateExecute(principal, holder, inner, value, ctx) {
    const block = await blockOf(ctx)
    const data = EXECUTE_SELECTOR + bytesToHex(encodeParams(['address', 'uint256', 'bytes', 'uint8'], [inner.to, 0n, inner.data, 0]))
    try { await needRpc().call('eth_call', [{ from: holder, to: principal, data, value: '0x' + value.toString(16) }, block], STRICT); return { ok: true } } catch (e) { if (isRevert(e)) return { ok: false, data: String(e.data?.rpcData ?? '0x') }; throw e }
  }
  // The container path's facts: deployed (code), opened (opener.isOpened), and the fee found by simulation: value 0
  // first; a revert 0xafd49700(paid, required) states the fee, and the call is simulated again with it. Any other revert
  // (or one with the fee) is executeReverts. The probe is approve(escrow, 0) on the scope token, harmless, the call the
  // plan itself makes. / 容器路径：是否部署、是否开通、模拟找费；探测调用是对 scope 代币的 approve(escrow, 0)，无害。
  async function containerFacts(m, identity, holder, probe, ctx, maxFee) {
    const block = await blockOf(ctx)
    const principalDeployed = await escrowRead(ctx, m.principal, 'code', [])
    let principalOpened
    try { principalOpened = (await strictCall(opener, 'isOpened', [identity.circuits, BigInt(identity.tokenId)], block)) === true } catch (e) { if (notAnAnswer(e)) principalOpened = false; else throw e }
    const out = { principalDeployed, principalOpened, executeFee: undefined, executeReverts: null, holderBalance: undefined }
    if (!principalDeployed || !principalOpened || !probe) return out
    let r = await simulateExecute(m.principal, holder, probe, 0n, ctx)
    if (r.ok) { out.executeFee = '0'; return out }
    const d = r.data.toLowerCase()
    if (d.startsWith(EXECUTE_FEE_SELECTOR) && d.length >= 10 + 128) {
      const [, required] = decodeParams(['uint256', 'uint256'], hexToBytes('0x' + d.slice(10, 138)))
      out.executeFee = BigInt(required).toString()
      // above the caller's ceiling: refused by the plan (execute-fee-too-high), not simulated again / 超过上限：计划拒绝，不再模拟
      if (maxFee !== undefined && BigInt(required) > BigInt(maxFee)) return out
      // review p1m3 S4: the holder's native coin, read strictly at the pinned block BEFORE the simulation with the fee:
      // a node answers "insufficient funds" (not a revert) for a value the sender cannot pay, which no rule can tell
      // from a node failure; the balance is a reading all nodes must agree on, so no single node decides the refusal
      // 审查 p1m3 S4：带费模拟之前在钉块上严格读持有人的原生币余额：付不起的 value 节点答 "insufficient funds"（不是回滚），
      // 与节点故障分不开；余额是所有节点须一致的读数，单个节点决定不了拒绝
      if (BigInt(required) > 0n) {
        const w = String(await needRpc().call('eth_getBalance', [holder, block], STRICT))
        if (!/^0x[0-9a-fA-F]{1,64}$/.test(w)) throw new TapeAPIError('RPC_ERROR', `eth_getBalance of ${holder} gave no quantity`)
        out.holderBalance = BigInt(w).toString()
        if (BigInt(w) < BigInt(required)) return out   // holder-short-of-fee, from the plan / 由计划报 holder-short-of-fee
      }
      r = await simulateExecute(m.principal, holder, probe, BigInt(required), ctx)
      if (!r.ok) out.executeReverts = r.data
      return out
    }
    out.executeReverts = r.data
    return out
  }
  /**
   * @experimental (phase 1, M3) The holder's plan (escrowPlan) built from facts read at one pinned block.
   *   path (default DEFAULT_FUNDING_PATH), holder (REQUIRED: the wallet that sends the plan), history (REQUIRED, review
   *   p1m3 recheck 3: the console's sessionHistory().entries(), holding every plan's `record`; [] when the console
   *   confirms it has none, never left out: omitted is INVALID_ARGUMENT; to run the plan again after it was applied it
   *   must hold the first run's `record`, whose claimedAtPlan bounds what is funded again: review p1m3 B1), now (default
   *   the kit's clock), signed or signer (optional, review p1m3 recheck 3: the signed mandate { mandate, sig }, or the
   *   address that signed it; the plan is holder-changed-since-signing when `holder` is not the signer, which a history
   *   catches only when it holds the former holder's record), maxExecuteFee
   *   (REQUIRED on the container path, review p1m3 R1: the most each execute may take as the TapeOut fee; a found fee
   *   above it is execute-fee-too-high)
   * On the container path it also reads the holder's native coin before simulating with the fee (holder-short-of-fee,
   * review p1m3 S4); on both, each provider's channel of the other funding path (other-path-funded, review p1m3 S1),
   * summed over this escrow and every escrow the history names for that provider. With a history it also reads every
   * other channel to the provider on which the history records this mandate's key (another escrow, another consumer)
   * as the `elsewhere` fact: the plan is funded-elsewhere until such a channel is released, then funds only what the key
   * has not spent on any of them (review p1m3 recheck CE-3/CE-4).
   * Returns the plan with `pin` ({ number, hash }) and `facts` (what was read). Refusals as escrowPlan's; a principal
   * that is no container is AGENT_INVALID (not-tapeout, no-such-token).
   * The premise (draft §10.5): for each (mandate, provider), what the agent key spent on every channel the session history
   * records plus what is still open to it stays within the cap. Only the channels the history records are seen: a console
   * that lost its history (or passes [] while it had one) after the provider changed its escrow cannot find the earlier
   * channel on chain (the manifest names only the new escrow; sessionLogs scans the escrow you name), and the plan funds
   * a whole cap there again. Keep every plan's `record`.
   * Run it again only once the earlier run's transactions are final (review p1m3 recheck 3): the plan's `record` carries
   * the pinned block (`block`), and a later run pinned at or before the block of a record of this mandate, or of a channel
   * it funds, is refused (pin-not-after-record). A run pinned after that block but before the earlier transactions were
   * included still reads the channel without them and would fund it again: wait until they are final (afterPlan at a
   * later pin shows them), then plan again.
   */
  async function holderPlan(mandate, o = {}) {
    const m = normalizeMandate(mandate)
    const path = planPathOf(o)
    const history = requireHistory(o, 'holderPlan')
    // review p1m3 recheck 3 (CE-4 without a history): the signed mandate ({ mandate, sig }) or its signer, optional
    // 复核 3：可选的签名授权书或签署人
    if (o.signed !== undefined && o.signer !== undefined) throw new TapeAPIError('INVALID_ARGUMENT', 'give signed (the signed mandate) or signer, not both')
    if (o.signer !== undefined && (!isAddress(o.signer) || eqAddr(o.signer, ZERO_ADDRESS))) throw new TapeAPIError('INVALID_ARGUMENT', 'signer must be the address that signed the mandate')
    let digest = null
    if (o.signed !== undefined) {
      if (!o.signed || typeof o.signed !== 'object' || typeof o.signed.sig !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){65,1024}$/.test(o.signed.sig)) throw new TapeAPIError('INVALID_ARGUMENT', 'signed must be the signed mandate { mandate, sig } (a signature of 65 to 1024 bytes)')
      let sm
      try { sm = normalizeMandate(o.signed.mandate) } catch (e) { throw new TapeAPIError('INVALID_ARGUMENT', `signed.mandate: ${e.message}`) }
      digest = mandateDigest(chainId, hub, sm)
      if (toHex(digest) !== toHex(mandateDigest(chainId, hub, m))) throw new TapeAPIError('INVALID_ARGUMENT', 'signed.mandate is not the mandate being planned')
    }
    const now = o.now ?? clock()
    const ctx = context()
    const identity = await principalOf(m, ctx)
    const consumer = path === 'holder' ? checksumAddress(o.holder) : m.principal
    // review p1m3 S1: the consumer of the other funding path (the principal on the holder path, the holder on the
    // container path) / 审查 p1m3 S1：另一条出资路径的 consumer
    const other = path === 'holder' ? m.principal : checksumAddress(o.holder)
    const capped = m.scope.filter((s) => s.cap !== '0')
    const providers = []
    for (const s of capped) {
      const escrow = await escrowAtPin(s.provider, ctx)
      const e = { provider: s.provider, escrow, token: null }
      if (escrow) {
        e.escrowCode = await escrowRead(ctx, escrow, 'code', [])
        if (e.escrowCode) {
          // claimedOf too (review p1m3 B1): what the key spent since an earlier run of this plan / 也读 claimedOf：钥匙自上次计划以来花了多少
          const [token, channel, pending, session, claimed, otherChannel, otherSession] = await Promise.all([escrowRead(ctx, escrow, 'escrowToken', []), escrowRead(ctx, escrow, 'channelOf', [consumer, s.provider]), escrowRead(ctx, escrow, 'pendingWithdraw', [consumer, s.provider]), escrowRead(ctx, escrow, 'sessionExpiry', [consumer, s.provider, m.agentKey]), escrowRead(ctx, escrow, 'claimedOf', [consumer, s.provider]), escrowRead(ctx, escrow, 'channelOf', [other, s.provider]), escrowRead(ctx, escrow, 'sessionExpiry', [other, s.provider, m.agentKey])])
          Object.assign(e, { token, channel: BigInt(channel).toString(), pendingLive: withdrawRequestLive(pending[1], now), session: BigInt(session).toString(), claimed: BigInt(claimed).toString() })
          // review p1m3 recheck (CE-3, CE-4, S1): every other channel to this provider on which the history records this
          // mandate's key (another escrow, another consumer), read here at the pin; and the other path's channel on each
          // escrow the history names, summed into otherPath / 复核：历史里本授权书钥匙出现过的其它通道在钉块上逐一读取；另一条路径在历史托管上的通道并入 otherPath
          let oc = BigInt(otherChannel), os = BigInt(otherSession)
          {
            const prior = mandateChannelsElsewhere(m, { chainId, hub, consumer, provider: s.provider, escrow, history })
            const elsewhere = []
            for (const c of prior) {
              if (!(await escrowRead(ctx, c.escrow, 'code', []))) continue   // nothing readable there: escrowPlan refuses / 读不到：由计划拒绝
              const [ch, pw, cl, se] = await Promise.all([escrowRead(ctx, c.escrow, 'channelOf', [c.consumer, s.provider]), escrowRead(ctx, c.escrow, 'pendingWithdraw', [c.consumer, s.provider]), escrowRead(ctx, c.escrow, 'claimedOf', [c.consumer, s.provider]), escrowRead(ctx, c.escrow, 'sessionExpiry', [c.consumer, s.provider, m.agentKey])])
              elsewhere.push({ escrow: c.escrow, consumer: c.consumer, channel: BigInt(ch).toString(), pendingLive: withdrawRequestLive(pw[1], now), claimed: BigInt(cl).toString(), session: BigInt(se).toString() })
            }
            e.elsewhere = elsewhere
            for (const pe of new Set(prior.map((c) => c.escrow.toLowerCase()).filter((a) => !eqAddr(a, escrow)))) {
              if (!(await escrowRead(ctx, pe, 'code', []))) continue
              const [ch, se] = await Promise.all([escrowRead(ctx, pe, 'channelOf', [other, s.provider]), escrowRead(ctx, pe, 'sessionExpiry', [other, s.provider, m.agentKey])])
              oc += BigInt(ch); if (BigInt(se) > os) os = BigInt(se)
            }
          }
          e.otherPath = { channel: oc.toString(), session: os.toString() }
        }
      }
      providers.push(e)
    }
    const first = providers.find((e) => e.escrow)
    const cf = path === 'container' ? await containerFacts(m, identity, o.holder, first ? { to: capped[providers.indexOf(first)].token, data: encodeCall('approve', [first.escrow, 0n]) } : null, ctx, o.maxExecuteFee) : null
    // the signer: the holder when the signature holds for it at the pinned block (ECDSA, else EIP-1271 asked of the holder,
    // as verifyMandate does); else the address a 65-byte signature recovers to; else null (a longer signature that the
    // holder does not accept names no one) / 签署人：签名在钉块上对 holder 成立（ECDSA，否则向 holder 问 EIP-1271）即 holder；否则 65 字节签名恢复出的地址；否则 null
    let signer = o.signer
    if (digest) {
      if (await holderSigned(o.holder, digest, o.signed.sig, ctx)) signer = checksumAddress(o.holder)
      else if (o.signed.sig.length === 132) { try { signer = checksumAddress(recoverAddress(digest, o.signed.sig)) } catch { signer = null } }
      else signer = null
    }
    const pin = await ctx.pin()
    const facts = { currentHolder: identity.holder, ...(signer !== undefined ? { signer } : {}), ...(cf ? { principalDeployed: cf.principalDeployed, principalOpened: cf.principalOpened, executeReverts: cf.executeReverts, ...(cf.holderBalance !== undefined ? { holderBalance: cf.holderBalance } : {}) } : {}) }
    const plan = escrowPlan(m, { chainId, path, holder: o.holder, providers, allowEscrows: [...allowedEscrows], now, hub, ...(path === 'container' ? { maxExecuteFee: o.maxExecuteFee } : {}), ...facts, ...(cf?.executeFee !== undefined ? { executeFee: cf.executeFee } : {}), history, pinBlock: pin.number })
    return { ...plan, pin: { number: pin.number, hash: pin.hash }, facts: { ...facts, ...(cf ? { executeFee: cf.executeFee ?? null } : {}), providers } }
  }
  /**
   * @experimental (phase 1, M3) The close-out (closeOutPlan) from facts read at one pinned block: each capped channel's
   * balance and withdraw request on its escrow. `escrows` ({ [provider]: escrow }, optional) names where the money is
   * when the provider's manifest has changed since (draft R23): the plan's `record` has them; default, the manifest at
   * the pinned block. path, holder (REQUIRED), now (default the kit's clock), maxExecuteFee (REQUIRED on the container
   * path, as holderPlan's), history (REQUIRED as holderPlan's, [] when the console has none: the plan's record or the
   * session history, consumer-unknown, review p1m3 S2 and recheck 3),
   * fullRequest (replace a live partial request by a request for the whole channel, review p1m3 S5).
   */
  async function closeOut(mandate, o = {}) {
    const m = normalizeMandate(mandate)
    const path = planPathOf(o)
    const history = requireHistory(o, 'closeOut')
    const now = o.now ?? clock()
    if (o.escrows !== undefined && (typeof o.escrows !== 'object' || o.escrows === null || !Object.values(o.escrows).every(isAddress))) throw new TapeAPIError('INVALID_ARGUMENT', 'escrows must map providers to escrow addresses')
    const named = new Map(Object.entries(o.escrows ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    const ctx = context()
    const consumer = path === 'holder' ? checksumAddress(o.holder) : m.principal
    const capped = m.scope.filter((s) => s.cap !== '0')
    const channels = []
    for (const s of capped) {
      const escrow = named.get(s.provider.toLowerCase()) ?? await escrowAtPin(s.provider, ctx)
      // not known (no escrow, or one without code): escrow-unknown, never "nothing to close" (R23) / 未知即 escrow-unknown
      if (!escrow || !(await escrowRead(ctx, escrow, 'code', []))) { channels.push({ provider: s.provider, escrow: null, channel: '0', pending: null }); continue }
      const [channel, pending] = await Promise.all([escrowRead(ctx, escrow, 'channelOf', [consumer, s.provider]), escrowRead(ctx, escrow, 'pendingWithdraw', [consumer, s.provider])])
      channels.push({ provider: s.provider, escrow: checksumAddress(escrow), channel: BigInt(channel).toString(), pending: { amount: BigInt(pending[0]).toString(), requestedAt: Number(pending[1]) } })
    }
    let facts = {}
    if (path === 'container') {
      const identity = await principalOf(m, ctx)
      const first = channels.find((c) => c.escrow)
      const cf = await containerFacts(m, identity, o.holder, first ? { to: capped[channels.indexOf(first)].token, data: encodeCall('approve', [first.escrow, 0n]) } : null, ctx, o.maxExecuteFee)
      facts = { currentHolder: identity.holder, ...(cf.executeReverts != null ? { executeReverts: cf.executeReverts } : {}), ...(cf.executeFee !== undefined ? { executeFee: cf.executeFee } : {}), ...(cf.holderBalance !== undefined ? { holderBalance: cf.holderBalance } : {}) }
      if (!cf.principalDeployed || !cf.principalOpened) facts.executeReverts ??= `the principal is ${cf.principalDeployed ? 'not opened' : 'not deployed'}`
    }
    const pin = await ctx.pin()
    const plan = closeOutPlan(m, { chainId, path, holder: o.holder, now, channels, ...(path === 'container' ? { maxExecuteFee: o.maxExecuteFee } : {}), history, ...(o.fullRequest !== undefined ? { fullRequest: o.fullRequest } : {}), ...facts })
    return { ...plan, pin: { number: pin.number, hash: pin.hash } }
  }
  /**
   * @experimental (phase 1, M3) After the holder sent a plan: allowance(consumer, escrow) of each check, and each capped
   * channel and the agent key's session, at a NEW pinned block, compared with the plan (planApplied).
   */
  async function afterPlan(plan, mandate) {
    if (!plan || !Array.isArray(plan.record) || !Array.isArray(plan.checks)) throw new TapeAPIError('INVALID_ARGUMENT', 'plan must be an escrowPlan or holderPlan result')
    const m = normalizeMandate(mandate)
    const ctx = context()
    const block = await blockOf(ctx)
    const allowances = []
    for (const k of plan.checks) {
      const w = String(await needRpc().ethCall(k.token, ALLOWANCE_SELECTOR + bytesToHex(encodeParams(['address', 'address'], [plan.consumer, k.escrow])), block, STRICT))
      if (!/^0x[0-9a-fA-F]{64}/.test(w)) throw new TapeAPIError('RPC_ERROR', `allowance() of ${k.token} gave no uint256`)
      allowances.push({ escrow: k.escrow, allowance: BigInt(w.slice(0, 66)).toString() })
    }
    const channels = []
    for (const r of plan.record) {
      const [channel, session, claimed] = await Promise.all([escrowRead(ctx, r.escrow, 'channelOf', [plan.consumer, r.provider]), escrowRead(ctx, r.escrow, 'sessionExpiry', [plan.consumer, r.provider, m.agentKey]), escrowRead(ctx, r.escrow, 'claimedOf', [plan.consumer, r.provider])])
      channels.push({ provider: r.provider, channel: BigInt(channel).toString(), session: Number(session), claimed: BigInt(claimed).toString() })
    }
    const pin = await ctx.pin()
    return { ...planApplied(plan, m, { allowances, channels }), readings: { allowances, channels }, pin: { number: pin.number, hash: pin.hash } }
  }
  /**
   * @experimental (phase 1, S4b) The SessionAuthorized logs of `consumer` on `escrow` from fromBlock to toBlock (strict
   * eth_getLogs), as session entries without a mandate hash, for a console whose history was lost (draft N9, R25: public
   * nodes keep logs for a short window only; a refusal is thrown). Review p1m3 S3: only logs whose consumer topic is
   * `consumer`, inside the range, are kept (the node's filter is not taken on trust), and toBlock is clamped to the kit's
   * pinned block (the Q-th highest operator head minus 2): a log above it is not final for this kit; a fromBlock above
   * it is INVALID_ARGUMENT. Each entry carries its block.
   */
  async function sessionLogs({ escrow, consumer, fromBlock, toBlock } = {}) {
    if (!isAddress(escrow) || !isAddress(consumer)) throw new TapeAPIError('INVALID_ARGUMENT', 'sessionLogs needs escrow and consumer addresses')
    if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || fromBlock < 0 || toBlock < fromBlock) throw new TapeAPIError('INVALID_ARGUMENT', 'fromBlock and toBlock must be block numbers, fromBlock <= toBlock')
    await checkChain()
    const pinned = (await context().pin()).number
    if (fromBlock > pinned) throw new TapeAPIError('INVALID_ARGUMENT', `fromBlock ${fromBlock} is above the kit's pinned block ${pinned}: nothing there is final yet`)
    const to = toBlock > pinned ? pinned : toBlock
    const pad = (a) => '0x' + '00'.repeat(12) + a.slice(2).toLowerCase()
    const who = pad(consumer)
    const logs = await needRpc().call('eth_getLogs', [{ fromBlock: '0x' + fromBlock.toString(16), toBlock: '0x' + to.toString(16), address: escrow, topics: [SESSION_AUTHORIZED_TOPIC, who] }], {
      ...STRICT, project: (ls) => { if (!Array.isArray(ls)) throw new Error('not an array'); return ls.filter((l) => eqAddr(l.address, escrow) && Array.isArray(l.topics) && l.topics.length === 4 && String(l.topics[0]).toLowerCase() === SESSION_AUTHORIZED_TOPIC && String(l.topics[1]).toLowerCase() === who).map((l) => ({ topics: l.topics.map((t) => String(t).toLowerCase()), data: String(l.data).toLowerCase(), block: Number(BigInt(l.blockNumber)) })).filter((l) => l.block >= fromBlock && l.block <= to) },
    })
    return logs.map((l) => ({ ...sessionEntry({ chainId, escrow, consumer: '0x' + l.topics[1].slice(26), provider: '0x' + l.topics[2].slice(26), key: '0x' + l.topics[3].slice(26), expires: Number(BigInt(decodeParams(['uint64'], l.data)[0])), mandateHash: null }), block: l.block }))
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
   * @experimental (phase 1, M7) With `enforcement: 'escrow-channel'` and a mandate that names funds, a `spend` member of
   * the deliver result (the agent's statement of what each capped channel paid since the work started) is reconciled by
   * spendEvidence against `scope` (the readings of a phase-1 check, optional) and the receipts that verified, priced from
   * the providers' manifests as resolved here: its problems join the evidence's, the rest is `spend` ({ items,
   * warnings }). Without the option, or for a mandate without funds, `spend` is ignored exactly as before. With both and
   * no `spend` member at all, `spend` is { items: [], warnings: [spend-evidence-absent] } (a warning, never a problem).
   * 阶段 1 的 M7：带开关且授权书带金额时，交付结果的 spend 成员按 spendEvidence 对账；不带开关时照旧忽略。
   */
  function verifyEvidence(deliver, o = {}) {
    const phase1 = o.enforcement === ENFORCEMENT_ESCROW_CHANNEL ? { readings: Array.isArray(o.scope) ? o.scope : null } : null
    return verifyEvidenceIn(deliver, { mandate: o.mandate, phase1 }, context())
  }
  async function verifyEvidenceIn(deliver, { mandate, phase1 = null } = {}, ctx) {
    const problems = []
    const out = { ok: false, problems, enforcement: 'none', proves: EVIDENCE_PROVES, doesNotProve: [...EVIDENCE_DOES_NOT_PROVE], receipts: [] }
    const m = normalizeMandate(mandate)
    if (!deliver || !Array.isArray(deliver.receipts)) { problems.push(problem('evidence-malformed', 'receipts must be an array')); return out }
    let rh
    try { rh = jsonHashOf(deliver.receipts) } catch (e) { problems.push(problem('evidence-malformed', `receipts have no canonical form: ${e.message}`)); return out }
    if (deliver.receiptsHash !== rh) problems.push(problem('receipts-hash-mismatch', 'receiptsHash is not keccak256(canonicalJSON(receipts))'))
    const scope = new Set(m.scope.map((s) => s.provider.toLowerCase()))
    const sigs = new Set()
    const calls = [], prices = {}
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
      // phase 1 (M7): the receipts that verified, and the price of each method from the manifest resolved here
      // 阶段 1（M7）：验证通过的回执，以及按这里解析的清单取每个方法的单价
      if (phase1) {
        calls.push({ provider: entry.container, method: r.method, ok: r.ok })
        const k = entry.container.toLowerCase()
        prices[k] ??= {}
        const def = typeof r.method === 'string' ? findMethod(svc.manifest, r.method) : null
        if (def && !Object.hasOwn(prices[k], r.method)) { try { prices[k][r.method] = methodPrice(def).toString() } catch { /* no price: not reconciled */ } }
      }
      const idn = await identityOf(entry.container, ctx)
      if (idn.identity) entry.name = idn.identity.name
    }
    // phase 1 (M7, draft §6.1 S8): the spend statement, only with the switch and a mandate that names funds
    // 阶段 1（M7）：花费说明，只在带开关且授权书带金额时核对
    if (phase1 && mandateNamesFunds(m) && deliver.spend !== undefined) {
      const se = spendEvidence(deliver.spend, { mandate: m, calls, readings: phase1.readings, prices })
      for (const p of se.problems) problems.push({ ...p, message: `spend: ${p.message}` })
      out.spend = { items: se.items, warnings: se.warnings }
    } else if (phase1 && mandateNamesFunds(m)) {
      // review p1-restart: a phase-1 delivery without a statement is reported (a warning, never a problem: the member is
      // optional), so that its absence is seen rather than read as "nothing was spent"
      // 审查 p1-restart：阶段 1 的交付没带说明时报警告（不是问题：该成员可选），免得把"没写"读成"没花"
      out.spend = { items: [], warnings: [{ code: 'spend-evidence-absent', message: 'the delivery carries no spend statement: what the capped channels paid is read from the chain only' }] }
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
    // phase 1 (draft §5.1): the applied mandate's enforcement and its per-channel readings, from the same pinned block;
    // absent unless the switch was given and the applied mandate names funds / 阶段 1：取已应用授权书的值，同一钉块
    if (mandate && pass.mandateCheck?.phase === 1) {
      const mc = pass.mandateCheck
      // review p1m12 I1: the thread's own enforcement is 'escrow-channel' only when the whole thread is ok; the applied
      // mandate's check keeps its own value in mandateCheck / 线程整体 ok 时才报 escrow-channel；mandateCheck 保留授权书自己的值
      Object.assign(out, { enforcement: problems.length === 0 ? mc.enforcement : 'none', phase: 1, bound: mc.bound, warnings: [...mc.warnings] })
      for (const k of ['consumer', 'fundingPath', 'scope', 'fee']) if (mc[k] !== undefined) out[k] = mc[k]
    }
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

  // the phase-1 options a thread passes to its mandate's check / 线程传给授权书核验的阶段 1 选项
  function phase1Options(o) {
    const out = {}
    for (const k of ['enforcement', 'fundingPath', 'feeDue']) if (o[k] !== undefined) out[k] = o[k]
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
        // the phase-1 switch and its options go to the mandate's check unchanged (draft §5.1) / 阶段 1 开关原样传给授权书核验
        const v = await verifyMandateIn(msg, { agentKey: accept.agentKey, agent: offer.agent, at: o.at, readSite: o.readSite, ...phase1Options(o) }, ctx)
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
        // phase 1 (M7): an applied mandate checked by the phase-1 rules reconciles the delivery's spend statement against
        // that check's readings (the same pinned block) / 阶段 1（M7）：按阶段 1 核验的已应用授权书，用同一钉块的读数核对花费说明
        const ev = await verifyEvidenceIn(r, { mandate, phase1: st.mandateCheck?.phase === 1 ? { readings: Array.isArray(st.mandateCheck.scope) ? st.mandateCheck.scope : null } : null }, ctx)
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

  const kit = {
    verifyMandate, verifyTaskThread, verifyEvidence,
    // @experimental phase 1, M3 / 阶段 1 的 M3
    holderPlan, closeOut, afterPlan, sessionLogs,
    readRevocations: async (container) => { const ctx = context(); const id = await identityOf(container, ctx); if (id.problem) return { status: 'invalid', reason: id.problem.message }; return readRevocations(container, id.identity, ctx) },
    identityOf: async (container) => { const id = await identityOf(container, context()); if (id.problem) throw new TapeAPIError('AGENT_INVALID', id.problem.message, { reason: id.problem.code }); return id.identity },
    chainId, hub, resolution,
  }
  // @internal for review-verify.js (the experimental review subpath), never on the kit object: the same strict reads at one
  // pinned block, so reviews apply no second set of identity, holder or site-file rules. / 只给评价核验用，不在 kit 对象上
  KIT_INTERNALS.set(kit, {
    context, identityOf, holderSigned, serviceOf, storeChanged, siteFileAt, clock, partyCannotResolve,
    hasCode: async (a, ctx) => hasCode(a, await blockOf(ctx)),
  })
  return kit
}
const KIT_INTERNALS = new WeakMap()
/** @internal The strict readers of a createAgentKit() result (review-verify.js only); null for anything else. */
export function agentKitInternals(kit) { return KIT_INTERNALS.get(kit) ?? null }
// How the kit resolves the agent and the providers (TAP-11 §2): the caller's `resolve`, unchanged; else the client's
// conformance sibling (conform-sibling.js; the client itself in that mode), made now, which sends nothing; else, when the
// conformance mode cannot be made from the client's options (INVALID_ARGUMENT: contracts TAP-10 does not list for the
// chain, as on a local or test deployment), the client's own resolve, as before 2.0.0, and `resolution` says so.
// kit 如何解析代理与上游服务：调用方的 resolve 原样使用；否则用客户端的一致模式同胞（现在建立，不发请求）；客户端选项建立不了
// 一致模式时（INVALID_ARGUMENT：合约不是 TAP-10 为该链列出的，如本地或测试部署）用客户端自己的 resolve（与 2.0.0 之前相同），并在
// resolution 里写明。
function resolverOf(api, resolve) {
  if (resolve) return { resolution: 'caller', resolveSvc: resolve }
  const siblingOf = CONFORM_SIBLINGS.get(api)
  if (siblingOf) {
    let sibling = null
    try { sibling = siblingOf() } catch (e) { if (!(e instanceof TapeAPIError && e.code === 'INVALID_ARGUMENT')) throw e }
    if (sibling) return { resolution: 'tap10', resolveSvc: (c) => sibling.resolve(c) }
  }
  return { resolution: 'client', resolveSvc: (c) => api.resolve(c) }
}

// The verdict constants again, for a caller that only imports this module / 方便只引入本模块的调用方
export { VERDICT_ACCEPT, VERDICT_REJECT }
