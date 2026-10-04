// @experimental (1.7) Container agents, phase 0: the EIP-712 types a circuit's HOLDER signs (Mandate, TaskOffer,
// TaskVerdict, MandateRevocation), their hashes, digests and wallet payloads. Pure: no chain reads, no network.
// See docs/DESIGN-container-agent.md (internal draft). Nothing here is covered by the 1.x compatibility promise: the
// format follows the public Idea TapeOutProtocol/TAPs#40/#41 and may change with that discussion.
//
// Every type lives in the TAP-11 delegation domain (name "TapeAPI", version "1", chainId, verifyingContract = the DeWEB
// hub), next to Delegation, ChannelKeys and ManifestContent. The type name is part of every struct hash, so a signature
// over one type is never a signature over another (tested both ways). A message hash (`mandateHash`, `offerHash`) is the
// full typed digest, domain included: the same mandate on another chain or under another hub has another hash.
// Agent-side messages are NOT new EIP-712 types: they are TAPI-21 signed responses (receipts) of the agent's methods.
import { keccak_256 } from '@noble/hashes/sha3'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils'
import { TapeAPIError } from './errors.js'
import { canonicalJSON } from './canon.js'
import { encodeParams, hexToBytes, toHex, isAddress, eqAddr, checksumAddress, ZERO_ADDRESS } from './abi.js'
import { typedDigest, delegationDomain, signDigest } from './sig.js'

const fail = (msg) => { throw new TapeAPIError('AGENT_INVALID', msg) }

export const AGENT_FORMAT_VERSION = 0
export const MODE_PAY = 0      // the agent is paid for the task (the principal pays the agent's container)
export const MODE_SPEND = 1    // the agent spends the principal's budget on third parties
export const VERDICT_ACCEPT = 1
export const VERDICT_REJECT = 2
export const MAX_SCOPE_ITEMS = 16
// A revocation list in the principal's site file must fit MANDATES_LIMIT (4096 bytes) written compactly, even with a
// contract holder's longest EIP-1271 signature (1,024 bytes): about 300 bytes of members, 2,050 of signature and 69 per
// hash leave room for 24 with margin. Revoke more at once by date (revokedBefore). / 站点文件必须放得下：最长签名下 24 个哈希仍有余量
export const MAX_REVOKED_HASHES = 24

export const SCOPE_TYPE = 'Scope(address provider,address token,uint256 cap)'
// encodeType of Mandate: the primary type, then every referenced struct type (EIP-712 §"Definition of encodeType")
export const MANDATE_TYPE = 'Mandate(address principal,address agent,address agentKey,uint8 mode,bytes32 taskHash,Scope[] scope,address feeToken,uint256 feeCap,uint64 notBefore,uint64 expires,uint256 nonce,bool subdelegate)' + SCOPE_TYPE
export const TASK_OFFER_TYPE = 'TaskOffer(address principal,address agent,bytes32 taskHash,uint8 mode,address feeToken,uint256 fee,uint64 deadline,uint64 exp,uint256 nonce)'
export const TASK_VERDICT_TYPE = 'TaskVerdict(bytes32 mandateHash,bytes32 deliverableHash,uint8 verdict,bytes32 reasonHash,uint64 issued)'
export const MANDATE_REVOCATION_TYPE = 'MandateRevocation(address principal,bytes32[] mandateHashes,uint64 revokedBefore,uint64 issued)'

const th = (s) => keccak_256(utf8ToBytes(s))
export const SCOPE_TYPEHASH = th(SCOPE_TYPE)
export const MANDATE_TYPEHASH = th(MANDATE_TYPE)
export const TASK_OFFER_TYPEHASH = th(TASK_OFFER_TYPE)
export const TASK_VERDICT_TYPEHASH = th(TASK_VERDICT_TYPE)
export const MANDATE_REVOCATION_TYPEHASH = th(MANDATE_REVOCATION_TYPE)

// ---------- field checks / 字段检查 ----------
const HASH_RE = /^0x[0-9a-fA-F]{64}$/
const UINT_RE = /^(0|[1-9][0-9]*)$/
const U64 = (1n << 64n) - 1n
const U256 = (1n << 256n) - 1n
function addr(v, name, { zero = false } = {}) {
  if (!isAddress(v)) fail(`${name} must be a 20-byte 0x address`)
  if (!zero && v.toLowerCase() === ZERO_ADDRESS) fail(`${name} must not be the zero address`)
  return checksumAddress(v)
}
function hash32(v, name, { zero = false } = {}) {
  if (v instanceof Uint8Array) { if (v.length !== 32) fail(`${name} must be 32 bytes`); v = toHex(v) }
  if (typeof v !== 'string' || !HASH_RE.test(v)) fail(`${name} must be 0x and 64 hex digits`)
  if (!zero && /^0x0{64}$/.test(v)) fail(`${name} must not be zero`)
  return v.toLowerCase()
}
// uint256 amounts travel as decimal strings (exact at any size); a bigint or a safe integer is accepted on input
function uintStr(v, name, max = U256) {
  let n
  if (typeof v === 'bigint') n = v
  else if (typeof v === 'number' && Number.isSafeInteger(v)) n = BigInt(v)
  else if (typeof v === 'string' && UINT_RE.test(v) && v.length <= 78) n = BigInt(v)
  else fail(`${name} must be a decimal string without leading zeros`)
  if (n < 0n || n > max) fail(`${name} is out of range`)
  return n.toString()
}
function u64num(v, name) {
  if (!Number.isSafeInteger(v) || v < 0) fail(`${name} must be a whole number of Unix seconds`)
  if (BigInt(v) > U64) fail(`${name} is out of uint64`)
  return v
}
function u8(v, name, allowed) {
  if (!Number.isInteger(v) || !allowed.includes(v)) fail(`${name} must be one of ${allowed.join(', ')}`)
  return v
}

/** keccak256(UTF-8(canonicalJSON(task))), 0x hex. The task is data, never instructions. / 任务文本的哈希 */
export function taskHashOf(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) fail('task must be a JSON object')
  return toHex(keccak_256(utf8ToBytes(canonicalJSON(task))))
}
/** keccak256(UTF-8(canonicalJSON(value))) for any canonical JSON value (deliverables, receipt bundles, reasons). */
export function jsonHashOf(value) { return toHex(keccak_256(utf8ToBytes(canonicalJSON(value)))) }

// ---------- Mandate ----------
/** Checks the shape of a mandate and returns a normalised copy (checksummed addresses, decimal strings). It does NOT
 *  apply the phase-0 rules (cap = feeCap = 0, subdelegate = false): verifyMandate does. / 只查形状，不查阶段 0 规则 */
export function normalizeMandate(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) fail('mandate must be an object')
  if (!Array.isArray(m.scope)) fail('scope must be an array (it may be empty)')
  if (m.scope.length > MAX_SCOPE_ITEMS) fail(`scope holds at most ${MAX_SCOPE_ITEMS} items`)
  const scope = m.scope.map((s, i) => {
    if (!s || typeof s !== 'object') fail(`scope[${i}] must be an object`)
    return { provider: addr(s.provider, `scope[${i}].provider`), token: addr(s.token, `scope[${i}].token`, { zero: true }), cap: uintStr(s.cap, `scope[${i}].cap`) }
  })
  const out = {
    principal: addr(m.principal, 'principal'), agent: addr(m.agent, 'agent'), agentKey: addr(m.agentKey, 'agentKey'),
    mode: u8(m.mode, 'mode', [MODE_PAY, MODE_SPEND]), taskHash: hash32(m.taskHash, 'taskHash'), scope,
    feeToken: addr(m.feeToken, 'feeToken', { zero: true }), feeCap: uintStr(m.feeCap, 'feeCap'),
    notBefore: u64num(m.notBefore, 'notBefore'), expires: u64num(m.expires, 'expires'),
    nonce: uintStr(m.nonce, 'nonce'), subdelegate: m.subdelegate,
  }
  if (typeof out.subdelegate !== 'boolean') fail('subdelegate must be a boolean')
  if (out.expires <= out.notBefore) fail('expires must be after notBefore')
  return out
}
export function hashScope(s) {
  return keccak_256(encodeParams(['bytes32', 'address', 'address', 'uint256'], [SCOPE_TYPEHASH, s.provider, s.token, BigInt(s.cap)]))
}
/** EIP-712 hashStruct(Mandate); a Scope[] member is keccak256 of the concatenated hashStruct of its items. */
export function hashMandate(mandate) {
  const m = normalizeMandate(mandate)
  const scopeHash = keccak_256(concatBytes(...m.scope.map(hashScope)))
  return keccak_256(encodeParams(
    ['bytes32', 'address', 'address', 'address', 'uint8', 'bytes32', 'bytes32', 'address', 'uint256', 'uint64', 'uint64', 'uint256', 'bool'],
    [MANDATE_TYPEHASH, m.principal, m.agent, m.agentKey, m.mode, m.taskHash, scopeHash, m.feeToken, BigInt(m.feeCap), BigInt(m.notBefore), BigInt(m.expires), BigInt(m.nonce), m.subdelegate],
  ))
}
/** The 32 bytes the holder signs; also the mandate's identity (`mandateHash`), 0x hex via mandateHashOf. */
export function mandateDigest(chainId, hub, m) { return typedDigest(delegationDomain(chainId, hub), hashMandate(m)) }
export function mandateHashOf(chainId, hub, m) { return toHex(mandateDigest(chainId, hub, m)) }

const DOMAIN_FIELDS = [
  { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
]
// Phase 0 has no enforcement, so a mandate names no amount and no asset: every scope cap and feeCap is 0, every token and
// feeToken the zero address, and subdelegate is false. A verifier refuses anything else (phase0-no-funds). The SDK's own
// wallet payload (mandateTypedData) and local signing (signMandate) do not produce such a mandate unless the caller passes
// { allowFunds: true } (vectors, later phases). This guards against misuse, not against a malicious console: the digest
// stays computable (mandateDigest, three-way vectors) and any console can sign it or build its own typed-data payload
// without this SDK. The holder's defence remains what the console and the wallet show: every token and feeToken the zero
// address, every cap and feeCap 0, subdelegate false.
// 阶段 0 的授权书不写金额也不写资产。SDK 自己的钱包载荷与本地签名入口默认不生成；这防误用，不防恶意控制台（摘要仍可算、
// 控制台可以自己拼载荷）。持有人的防线仍是控制台显示与钱包字段：代币为零地址、上限为 0、subdelegate 为 false。
export function phase0Problems(m) {
  const out = []
  const funded = m.scope.filter((s) => s.cap !== '0' || s.token !== ZERO_ADDRESS).map((s) => s.provider)
  if (funded.length || m.feeCap !== '0' || m.feeToken !== ZERO_ADDRESS) out.push({ code: 'phase0-no-funds', message: `phase 0 has no enforcement: every scope cap and feeCap must be 0 and every token and feeToken the zero address${funded.length ? ` (scope: ${funded.join(', ')})` : ''}${m.feeCap !== '0' || m.feeToken !== ZERO_ADDRESS ? ` (fee: ${m.feeToken} cap ${m.feeCap})` : ''}` })
  if (m.subdelegate) out.push({ code: 'subdelegate-not-allowed', message: 'sub-delegation is not allowed in this version' })
  return out
}
function gate(m, opts, what) {
  if (opts?.allowFunds === true) return
  const p = phase0Problems(m)
  if (p.length) throw new TapeAPIError('AGENT_INVALID', `${what}: ${p.map((x) => x.message).join('; ')}; pass { allowFunds: true } only outside phase 0`, { reason: p[0].code })
}
// What the console shows next to the wallet prompt, in the same words everywhere. `warnings` and `display` are for the
// console and MUST be removed before the payload goes to the wallet (wallets read domain, types, primaryType and message);
// neither is hashed or signed. / warnings 与 display 只给控制台，交给钱包前去掉；都不进哈希与签名
export const MANDATE_PHASE0_NOTICE = 'phase 0: this mandate authorises no amount and no asset; it is only a verifiable record that you asked this agent to act for your container on this task'
export const MANDATE_FUNDED_WARNING = 'this mandate names an amount, an asset or sub-delegation: phase 0 verifiers refuse it, and a later phase may treat it as a spending authorisation'
const isoDate = (s) => { try { return new Date(s * 1000).toISOString() } catch { return null } }
/** eth_signTypedData_v4 payload: the wallet shows every field, not a hash. Refuses a mandate that names an amount, an
 *  asset or sub-delegation unless { allowFunds: true }. `task` (optional): the task text, checked against taskHash and
 *  returned in `display` with the dates in words. / 钱包逐字段显示；默认拒绝写了金额、资产或转委托的授权书 */
export function mandateTypedData(chainId, hub, mandate, opts = {}) {
  const m = normalizeMandate(mandate)
  gate(m, opts, 'mandateTypedData')
  if (opts.task !== undefined && taskHashOf(opts.task) !== m.taskHash) fail('task does not hash to the mandate\'s taskHash')
  const funded = phase0Problems(m).length > 0
  return {
    warnings: [funded ? MANDATE_FUNDED_WARNING : MANDATE_PHASE0_NOTICE],
    display: { ...(opts.task !== undefined ? { task: JSON.parse(canonicalJSON(opts.task)) } : {}), notBefore: isoDate(m.notBefore), expires: isoDate(m.expires) },
    domain: delegationDomain(chainId, hub),
    types: {
      EIP712Domain: DOMAIN_FIELDS,
      Mandate: [
        { name: 'principal', type: 'address' }, { name: 'agent', type: 'address' }, { name: 'agentKey', type: 'address' },
        { name: 'mode', type: 'uint8' }, { name: 'taskHash', type: 'bytes32' }, { name: 'scope', type: 'Scope[]' },
        { name: 'feeToken', type: 'address' }, { name: 'feeCap', type: 'uint256' }, { name: 'notBefore', type: 'uint64' },
        { name: 'expires', type: 'uint64' }, { name: 'nonce', type: 'uint256' }, { name: 'subdelegate', type: 'bool' },
      ],
      Scope: [{ name: 'provider', type: 'address' }, { name: 'token', type: 'address' }, { name: 'cap', type: 'uint256' }],
    },
    primaryType: 'Mandate',
    message: { ...m, scope: m.scope.map((s) => ({ ...s })) },
  }
}

// ---------- TaskOffer ----------
export function normalizeTaskOffer(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) fail('offer must be an object')
  return {
    principal: addr(o.principal, 'principal'), agent: addr(o.agent, 'agent'), taskHash: hash32(o.taskHash, 'taskHash'),
    mode: u8(o.mode, 'mode', [MODE_PAY, MODE_SPEND]), feeToken: addr(o.feeToken, 'feeToken', { zero: true }), fee: uintStr(o.fee, 'fee'),
    deadline: u64num(o.deadline, 'deadline'), exp: u64num(o.exp, 'exp'), nonce: uintStr(o.nonce, 'nonce'),
  }
}
export function hashTaskOffer(offer) {
  const o = normalizeTaskOffer(offer)
  return keccak_256(encodeParams(
    ['bytes32', 'address', 'address', 'bytes32', 'uint8', 'address', 'uint256', 'uint64', 'uint64', 'uint256'],
    [TASK_OFFER_TYPEHASH, o.principal, o.agent, o.taskHash, o.mode, o.feeToken, BigInt(o.fee), BigInt(o.deadline), BigInt(o.exp), BigInt(o.nonce)],
  ))
}
export function taskOfferDigest(chainId, hub, o) { return typedDigest(delegationDomain(chainId, hub), hashTaskOffer(o)) }
export function offerHashOf(chainId, hub, o) { return toHex(taskOfferDigest(chainId, hub, o)) }
// A non-zero fee is a price statement, never a payment: the payload says so in `warnings` for the console to show (wallets
// read only domain, types, primaryType and message). / 非零 fee 只是价格陈述：warnings 供控制台显示
export const OFFER_FEE_WARNING = 'fee is a price statement, not a payment: signing this offer authorises no transfer, and payment is a separate transfer you make yourself'
export function taskOfferTypedData(chainId, hub, offer) {
  const o = normalizeTaskOffer(offer)
  return {
    ...(o.fee !== '0' ? { warnings: [OFFER_FEE_WARNING] } : {}),
    domain: delegationDomain(chainId, hub),
    types: {
      EIP712Domain: DOMAIN_FIELDS,
      TaskOffer: [
        { name: 'principal', type: 'address' }, { name: 'agent', type: 'address' }, { name: 'taskHash', type: 'bytes32' },
        { name: 'mode', type: 'uint8' }, { name: 'feeToken', type: 'address' }, { name: 'fee', type: 'uint256' },
        { name: 'deadline', type: 'uint64' }, { name: 'exp', type: 'uint64' }, { name: 'nonce', type: 'uint256' },
      ],
    },
    primaryType: 'TaskOffer',
    message: o,
  }
}

// ---------- TaskVerdict (acceptance or rejection of one delivery) ----------
export function normalizeTaskVerdict(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail('verdict must be an object')
  return {
    mandateHash: hash32(v.mandateHash, 'mandateHash'), deliverableHash: hash32(v.deliverableHash, 'deliverableHash'),
    verdict: u8(v.verdict, 'verdict', [VERDICT_ACCEPT, VERDICT_REJECT]), reasonHash: hash32(v.reasonHash ?? '0x' + '00'.repeat(32), 'reasonHash', { zero: true }),
    issued: u64num(v.issued, 'issued'),
  }
}
export function hashTaskVerdict(verdict) {
  const v = normalizeTaskVerdict(verdict)
  return keccak_256(encodeParams(['bytes32', 'bytes32', 'bytes32', 'uint8', 'bytes32', 'uint64'],
    [TASK_VERDICT_TYPEHASH, v.mandateHash, v.deliverableHash, v.verdict, v.reasonHash, BigInt(v.issued)]))
}
export function taskVerdictDigest(chainId, hub, v) { return typedDigest(delegationDomain(chainId, hub), hashTaskVerdict(v)) }
export function verdictHashOf(chainId, hub, v) { return toHex(taskVerdictDigest(chainId, hub, v)) }
export function taskVerdictTypedData(chainId, hub, verdict) {
  const v = normalizeTaskVerdict(verdict)
  return {
    domain: delegationDomain(chainId, hub),
    types: {
      EIP712Domain: DOMAIN_FIELDS,
      TaskVerdict: [
        { name: 'mandateHash', type: 'bytes32' }, { name: 'deliverableHash', type: 'bytes32' }, { name: 'verdict', type: 'uint8' },
        { name: 'reasonHash', type: 'bytes32' }, { name: 'issued', type: 'uint64' },
      ],
    },
    primaryType: 'TaskVerdict',
    message: v,
  }
}

// ---------- MandateRevocation (a direct message, or the list in the principal's site file) ----------
// Revokes every mandate whose hash is listed, and every mandate of `principal` whose notBefore is below
// `revokedBefore` (0: none by date). `issued` orders revocation lists (a client keeps the highest seen, TAPI-26 style).
export function normalizeMandateRevocation(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) fail('revocation must be an object')
  if (!Array.isArray(r.mandateHashes)) fail('mandateHashes must be an array')
  if (r.mandateHashes.length > MAX_REVOKED_HASHES) fail(`mandateHashes holds at most ${MAX_REVOKED_HASHES} hashes`)
  return {
    principal: addr(r.principal, 'principal'),
    mandateHashes: r.mandateHashes.map((h, i) => hash32(h, `mandateHashes[${i}]`)),
    revokedBefore: u64num(r.revokedBefore, 'revokedBefore'), issued: u64num(r.issued, 'issued'),
  }
}
export function hashMandateRevocation(revocation) {
  const r = normalizeMandateRevocation(revocation)
  const list = keccak_256(concatBytes(...r.mandateHashes.map((h) => hexToBytes(h))))
  return keccak_256(encodeParams(['bytes32', 'address', 'bytes32', 'uint64', 'uint64'],
    [MANDATE_REVOCATION_TYPEHASH, r.principal, list, BigInt(r.revokedBefore), BigInt(r.issued)]))
}
export function mandateRevocationDigest(chainId, hub, r) { return typedDigest(delegationDomain(chainId, hub), hashMandateRevocation(r)) }
export function mandateRevocationTypedData(chainId, hub, revocation) {
  const r = normalizeMandateRevocation(revocation)
  return {
    domain: delegationDomain(chainId, hub),
    types: {
      EIP712Domain: DOMAIN_FIELDS,
      MandateRevocation: [
        { name: 'principal', type: 'address' }, { name: 'mandateHashes', type: 'bytes32[]' },
        { name: 'revokedBefore', type: 'uint64' }, { name: 'issued', type: 'uint64' },
      ],
    },
    primaryType: 'MandateRevocation',
    message: { ...r, mandateHashes: [...r.mandateHashes] },
  }
}

// ---------- signing with a local key (tests, scripts; a wallet signs the typed data instead) ----------
// No EIP-191 prefix: the holder signs the typed digest itself, as TAP-11 §4.2 does for a delegation.
export const signMandate = (chainId, hub, m, pk, opts = {}) => { gate(normalizeMandate(m), opts, 'signMandate'); return signDigest(mandateDigest(chainId, hub, m), pk) }
export const signTaskOffer = (chainId, hub, o, pk) => signDigest(taskOfferDigest(chainId, hub, o), pk)
export const signTaskVerdict = (chainId, hub, v, pk) => signDigest(taskVerdictDigest(chainId, hub, v), pk)
export const signMandateRevocation = (chainId, hub, r, pk) => signDigest(mandateRevocationDigest(chainId, hub, r), pk)

// ---------- the wallet payload without the console's fields ----------
const WALLET_TYPES = new Set(['Mandate', 'TaskOffer', 'TaskVerdict', 'MandateRevocation'])
/**
 * Split a typed-data result of this module (mandateTypedData, taskOfferTypedData, taskVerdictTypedData,
 * mandateRevocationTypedData) into what goes to the wallet (`payload`: domain, types, primaryType and message only) and
 * what the console shows (`warnings`, `display`). Use it, or remove warnings and display yourself, before
 * eth_signTypedData_v4. / 交给钱包前用它：payload 只含四个键，warnings 与 display 留给控制台
 */
// The types, domain and message forWallet accepts: exactly what this module's own builders produce. Anything added,
// removed or changed (an extra field in types.Mandate, a message member the types do not name) is refused.
// forWallet 只接受本模块自己生成的类型、域与消息：多一个、少一个或改动都拒绝。
const WALLET_SPEC = {
  // the task text in display is checked against message.taskHash again and the dates are recomputed
  Mandate: { build: (td) => mandateTypedData(td.domain.chainId, td.domain.verifyingContract, td.message, { allowFunds: true, ...(td.display?.task !== undefined ? { task: td.display.task } : {}) }) },
  TaskOffer: { build: (td) => taskOfferTypedData(td.domain.chainId, td.domain.verifyingContract, td.message) },
  TaskVerdict: { build: (td) => taskVerdictTypedData(td.domain.chainId, td.domain.verifyingContract, td.message) },
  MandateRevocation: { build: (td) => mandateRevocationTypedData(td.domain.chainId, td.domain.verifyingContract, td.message) },
}
// `expect` ({ chainId, hub }), REQUIRED: what the holder's console expects; the domain must name exactly that chain and
// hub (a payload rebuilt from its own domain cannot catch a changed chainId, which would let the signature be replayed on
// that chain). The holder's defence is still the fields the wallet shows.
// expect（必传）：控制台期望的链与 hub；domain 必须与之一致（按自己的 domain 重建无法发现被换的 chainId）。
export function forWallet(td, expect) {
  const what = 'forWallet takes a typed-data result of mandateTypedData, taskOfferTypedData, taskVerdictTypedData or mandateRevocationTypedData'
  if (!td || typeof td !== 'object' || !td.domain || typeof td.domain !== 'object' || !td.types || !td.message || !WALLET_TYPES.has(td.primaryType)) fail(what)
  const d = td.domain
  if (!Number.isSafeInteger(d.chainId) || d.chainId <= 0) fail(`${what}: domain.chainId must be a positive safe integer`)
  if (!isAddress(d.verifyingContract)) fail(`${what}: domain.verifyingContract must be an address`)
  const must = 'the holder\'s console must pass the chainId and hub it expects: forWallet(td, { chainId, hub })'
  if (!expect || typeof expect !== 'object' || !Number.isSafeInteger(expect.chainId) || expect.chainId <= 0 || !isAddress(expect.hub)) fail(`forWallet: ${must}`)
  if (expect.chainId !== d.chainId) fail(`forWallet: the payload is for chain ${d.chainId}, the console expects ${expect.chainId}`)
  if (!eqAddr(expect.hub, d.verifyingContract)) fail(`forWallet: the payload names verifyingContract ${d.verifyingContract}, the console expects ${expect.hub}`)
  if (td.display !== undefined && (td.display === null || typeof td.display !== 'object' || Array.isArray(td.display))) fail(`${what}: display must be an object`)
  const copy = (v) => { try { return JSON.parse(JSON.stringify(v)) } catch (e) { fail(`${what}: ${e.message}`) } }
  let want
  try { want = WALLET_SPEC[td.primaryType].build(td) } catch (e) { fail(`${what}: ${e.message}`) }
  const same = (a, b) => { try { return canonicalJSON(copy(a)) === canonicalJSON(copy(b)) } catch { return false } }
  for (const k of ['domain', 'types', 'message']) if (!same(td[k], want[k])) fail(`${what}: its ${k} differs from what this module builds`)
  // warnings and display come from the rebuilt payload, never from the input: a message changed to name an amount gets the
  // funded warning, a task text that no longer matches taskHash is refused, the dates are recomputed
  // warnings 与 display 取自重建结果，不取输入
  return {
    payload: { domain: copy(want.domain), types: copy(want.types), primaryType: want.primaryType, message: copy(want.message) },
    warnings: [...(want.warnings ?? [])],
    ...(want.display ? { display: copy(want.display) } : {}),
  }
}
