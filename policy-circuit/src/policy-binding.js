// @experimental PolicyBinding and PolicyBindingRevocation (Policy Circuit Gate TAP draft §5), subjects, the ordered checks
// and the `enforceable` ladder, binding choice (§5.4), and the two `tap.policy` metadata members (§6). The EIP-712 domain is
// TAP-11's, unchanged (TapeAPI's delegation domain: name "TapeAPI", version "1", the hub, the subject's chain): the SDK's
// delegationDomain, typedDigest and recoverAddress do the hashing and recovery. Pure except verifyPolicyBinding, which
// awaits the binder reader it is given; runs in a browser.
// 实验性：PolicyBinding 与撤销（草稿 §5）、主体、有序检查与 enforceable 阶梯、绑定选择（§5.4）、两个 tap.policy 元数据成员（§6）。
// EIP-712 域就是 TAP-11 的（TapeAPI 委托域），哈希与恢复都用 SDK 的 delegationDomain、typedDigest、recoverAddress。
// 除 verifyPolicyBinding（等待调用方给的绑定者读取函数）外都是纯函数，浏览器可用。
//
// Fixed in code, no option changes them (draft §0.1, §5.1, §5.3):
//  - kinds 1 (mandate) and 2 (escrow-session) are reported `conditional` at best, NEVER `enforceable: true`, whatever
//    this program believes about the drafts they rest on (TAP-18 from #47 is merged as a Draft, merging is not adoption; #59, #60 are submitted, in review; the escrow contract is not
//    audited and not deployed);
//  - `enforceable` reports the binder's authority (draft §5.3, §5.5), never that anyone enforces the binding;
//  - kind 4 (label) is always `false`, shown with "display only, binds nobody";
//  - without a checked policy file, `enforceable` is never true nor `conditional` (no file, no verdict);
//  - a binder that was not checked gives `enforceable: null`, never a pass. A contract binder is checked under EIP-1271
//    only through a chain reader (policyBinderFromApi: strict reads at one pinned block); without one, or when a read
//    fails, `binderChecked` is false.
// 写死在代码里、没有选项能改：第 1、2 类至多 conditional，绝不 true；第 4 类永远 false 并显示"仅供展示，不约束任何人"；
// 没有核对过的策略文件就没有结论；没核对绑定者即 null。合约绑定者只经链读取（钉块上的严格读取）按 EIP-1271 核对；
// 没有读取函数或读取失败，binderChecked 为 false。
//
// Kind 2 names a channel of the #59 / #60 escrow interface only. An x402 batch-settlement channel also has a session key
// (payerAuthorizer), but it is another contract, another voucher type and has no session expiry: it is NOT a kind-2
// subject, and policySubject.escrowSession refuses one (INVALID_ARGUMENT, data.reason 'policy-subject-x402', a TapeAPI
// name, not one of the draft's problems). Use kind 3 (account) or kind 4 (label, display only) for such a channel.
// 第 2 类只指 #59/#60 托管接口的通道。x402 批量结算通道也有会话钥匙，但合约、凭单类型都不同，也没有会话到期：不是第 2 类主体，
// policySubject.escrowSession 拒绝它（INVALID_ARGUMENT，data.reason 'policy-subject-x402'，TapeAPI 自己的原因名，不是草稿的问题名）。
//
// Signing: this package gives the binder's console the typed data only. A runtime that reads text from other parties
// (an agent) must not sign a binding or a revocation (draft §5.1), so there is no signing function here.
// 签名：本包只给持有人控制台类型数据。读取他人文本的运行时（代理）不得签绑定或撤销，所以这里没有签名函数。
import { keccak_256 } from '@noble/hashes/sha3'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils'
import { TapeAPIError } from '@tapeapi/sdk'
import { delegationDomain, domainSeparator, typedDigest, recoverAddress } from '@tapeapi/sdk/sig'
import { isAddress, eqAddr } from '@tapeapi/sdk/abi'
import { mandateHashOf, X402_SETTLEMENT, ENFORCEMENT_X402_BATCH } from '@tapeapi/sdk/agent'
import { fail, PolicyCircuitError, POLICY_CONVENTION, POLICY_N_IN, POLICY_N_OUT, checkPolicyCircuit, policyNetlistHash } from './tapnet.js'
import { decOf, isObj, sameKeys, hex, fromHex, checkPolicyTables, policyTablesHash } from './policy-word.js'

const HEX32 = /^0x[0-9a-f]{64}$/
const DEC = /^(0|[1-9][0-9]*)$/
const te = (s) => utf8ToBytes(s)
const invalid = (msg, reason) => { throw new TapeAPIError('INVALID_ARGUMENT', msg, reason ? { data: { reason } } : undefined) }

// ---- §5.2 the types / 类型 ----
/** The hub of TAP-11 §4.1 (the verifyingContract of every binding; the chain ID separates chains). / 域里的中枢地址。 */
export const POLICY_HUB = '0xe61A9C7213a6Aa616C246a2B569e555B417b25ee'
export const POLICY_BINDING_TYPE = 'PolicyBinding(bytes32 netlistHash,uint8 subjectKind,bytes32 subject,bytes32 tablesHash,uint64 notBefore,uint64 expires,uint64 issued)'
export const POLICY_REVOCATION_TYPE = 'PolicyBindingRevocation(bytes32[] bindingHashes,uint64 revokedBefore,uint64 issued)'
export const POLICY_BINDING_TYPEHASH = hex(keccak_256(te(POLICY_BINDING_TYPE)))
export const POLICY_REVOCATION_TYPEHASH = hex(keccak_256(te(POLICY_REVOCATION_TYPE)))
/** Subject kinds (§5.1). / 主体种类。 */
export const POLICY_SUBJECT_KINDS = Object.freeze({ 1: 'mandate', 2: 'escrow-session', 3: 'account', 4: 'label' })
/** At most this many hashes in one revocation (§5.4). / 一次撤销至多列出的哈希数。 */
export const MAX_REVOKED_POLICY_HASHES = 24
/** The window policyBindingTypedData proposes by default (7 days), and the longest default a tool may propose (30 days). */
export const POLICY_BINDING_DEFAULT_WINDOW_S = 7 * 86400
export const POLICY_BINDING_MAX_DEFAULT_WINDOW_S = 30 * 86400

const BINDING_FIELDS = [['netlistHash', 'bytes32'], ['subjectKind', 'uint8'], ['subject', 'bytes32'], ['tablesHash', 'bytes32'], ['notBefore', 'uint64'], ['expires', 'uint64'], ['issued', 'uint64']]
const REVOCATION_FIELDS = [['bindingHashes', 'bytes32[]'], ['revokedBefore', 'uint64'], ['issued', 'uint64']]
const domainOf = (chainId) => {
  if (!(Number.isSafeInteger(chainId) && chainId > 0)) invalid('chainId must be a positive safe integer')
  return delegationDomain(chainId, POLICY_HUB)
}
/** The TAP-11 domain separator on `chainId` (0xa73ee348... on 56). / 域分隔符。 */
export const policyDomainSeparator = (chainId) => hex(domainSeparator(domainOf(chainId)))

const word = (n) => { const b = new Uint8Array(32); let x = n; for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n } return b }
const h32 = (v, where, code) => { if (typeof v !== 'string' || !HEX32.test(v)) fail(code, `${where}: 0x + 64 lowercase hex digits`); return fromHex(v) }
const uintOf = (v, bits, where, code) => { const n = decOf(v, where, code); if (n >= 1n << BigInt(bits)) fail(code, `${where}: at most 2^${bits} - 1`); return n }
function enc(ft, v, where, code) {
  if (ft === 'bytes32') return h32(v, where, code)
  if (ft === 'bytes32[]') { if (!Array.isArray(v)) fail(code, `${where}: an array`); return keccak_256(concatBytes(...v.map((x, i) => h32(x, `${where}[${i}]`, code)))) }
  return word(uintOf(v, Number(ft.slice(4)), where, code))
}
function structHash(fields, typehash, m, code) {
  if (!sameKeys(m, fields.map(([n]) => n))) fail(code, `members must be exactly ${fields.map(([n]) => n).join(', ')}`)
  return keccak_256(concatBytes(fromHex(typehash), ...fields.map(([n, ft]) => enc(ft, m[n], n, code))))
}
/** The binding hash: its EIP-712 digest on `chainId`, its identity (§5.2). / 绑定哈希。 */
export const policyBindingHash = (chainId, b) => hex(typedDigest(domainOf(chainId), structHash(BINDING_FIELDS, POLICY_BINDING_TYPEHASH, b, 'binding-malformed')))
/** A revocation's EIP-712 digest (§5.4). / 撤销的摘要。 */
export const policyRevocationHash = (chainId, r) => hex(typedDigest(domainOf(chainId), structHash(REVOCATION_FIELDS, POLICY_REVOCATION_TYPEHASH, r, 'revocation-malformed')))

/**
 * §5.2 static rules: the seven members in form, non-zero netlistHash and subject, a known kind, a padded account
 * subject, `expires > notBefore`, `issued <= expires`. Throws the draft's problem. / §5.2 静态规则，不合格即抛出问题名。
 */
export function checkPolicyBindingForm(b) {
  structHash(BINDING_FIELDS, POLICY_BINDING_TYPEHASH, b, 'binding-malformed')
  const kind = Number(uintOf(b.subjectKind, 8, 'subjectKind', 'binding-malformed'))
  if (!POLICY_SUBJECT_KINDS[kind]) fail('binding-unknown-subject-kind', String(kind))
  if (kind === 3 && !b.subject.startsWith('0x' + '00'.repeat(12))) fail('binding-malformed', 'an account subject is left-padded with 12 zero bytes')
  if (BigInt(b.netlistHash) === 0n || BigInt(b.subject) === 0n) fail('binding-malformed', 'netlistHash and subject are non-zero')
  const [nb, ex, iss] = ['notBefore', 'expires', 'issued'].map((k) => uintOf(b[k], 64, k, 'binding-malformed'))
  if (ex <= nb) fail('binding-window-empty', `expires ${ex} <= notBefore ${nb}`)
  if (iss > ex) fail('binding-issued-after-expiry')
}
/** §5.4 form: at most 24 non-zero hashes, uint64 times. / 撤销的形式。 */
export function checkPolicyRevocationForm(r) {
  structHash(REVOCATION_FIELDS, POLICY_REVOCATION_TYPEHASH, r, 'revocation-malformed')
  if (r.bindingHashes.length > MAX_REVOKED_POLICY_HASHES) fail('revocation-too-many-hashes', `${r.bindingHashes.length} hashes`)
  if (r.bindingHashes.some((x) => BigInt(x) === 0n)) fail('revocation-malformed', 'zero hash')
}
/**
 * §5.4: does the revocation cover the binding? Its hash is listed, or the binding's `issued` is strictly below
 * `revokedBefore` (0: no time cut-off). Whose signature it is, is the caller's check. / 撤销是否覆盖该绑定。
 */
export function policyRevocationCovers(r, bindingHash, issued) {
  checkPolicyRevocationForm(r)
  return r.bindingHashes.includes(bindingHash) || decOf(issued, 'issued', 'binding-malformed') < BigInt(r.revokedBefore)
}

// ---- §5.1 subjects / 主体 ----
const lowAddr = (a, where) => { if (!isAddress(a)) invalid(`${where}: an address`); return a.toLowerCase() }
const isX402 = (s) => s.enforcement === ENFORCEMENT_X402_BATCH || 'channelId' in s || isObj(s.channelConfig) || (typeof s.escrow === 'string' && eqAddr(s.escrow, X402_SETTLEMENT))
/**
 * The `subject` of each kind, as `{ subjectKind, subject }`:
 *  - `mandate(hashOrMandate, { chainId })`: the mandate hash (the SDK's mandateHashOf in TAP-11's domain, checked equal
 *    to the TAP-18 draft (#47) at commit 50a5a6f), or a mandate to hash on `chainId`;
 *  - `escrowSession({ escrow, consumer, provider, key })`: keccak256(escrow ‖ consumer ‖ provider ‖ key), a #59 / #60
 *    escrow channel only (an x402-batch channel is refused: 'policy-subject-x402');
 *  - `account(address)`: the container address of a TapeOut circuit, left-padded;
 *  - `label(text)`: keccak256(utf8(text)), display only.
 * 各类主体的 subject 值。第 2 类只接受 #59/#60 托管通道，x402-batch 通道被拒绝。
 */
export const policySubject = Object.freeze({
  mandate(m, { chainId } = {}) {
    if (typeof m === 'string') {
      if (!HEX32.test(m) || BigInt(m) === 0n) invalid('a mandate hash is 0x + 64 lowercase hex digits, not zero')
      return { subjectKind: 1, subject: m }
    }
    if (!isObj(m)) invalid('policySubject.mandate takes a mandate hash or a mandate')
    if (!(Number.isSafeInteger(chainId) && chainId > 0)) invalid('policySubject.mandate(mandate) needs { chainId }: the principal\'s chain')
    return { subjectKind: 1, subject: mandateHashOf(chainId, POLICY_HUB, m).toLowerCase() }
  },
  escrowSession(s) {
    if (!isObj(s)) invalid('policySubject.escrowSession takes { escrow, consumer, provider, key }')
    if (isX402(s)) invalid('an x402 batch-settlement channel is not a kind-2 subject: kind 2 names #59 / #60 escrow channels only; use an account or a label binding', 'policy-subject-x402')
    const parts = ['escrow', 'consumer', 'provider', 'key'].map((k) => fromHex(lowAddr(s[k], k)))
    return { subjectKind: 2, subject: hex(keccak_256(concatBytes(...parts))) }
  },
  account(a) { return { subjectKind: 3, subject: '0x' + '00'.repeat(12) + lowAddr(a, 'account').slice(2) } },
  label(text) {
    if (typeof text !== 'string' || !text) invalid('a label is a non-empty string')
    return { subjectKind: 4, subject: hex(keccak_256(te(text))) }
  },
})

// ---- signatures (TAP-11 §4.4 item 1, with the draft's problem names) / 签名 ----
// The SDK's recoverAddress throws one BAD_SIGNATURE for every failure; the draft names four, so they are told apart here
// first, in TAP-11's order: length, v (0 and 1 map to 27 and 28), r and s in range, low s.
// SDK 的 recoverAddress 对所有失败只抛一个 BAD_SIGNATURE；草稿区分四种，这里按 TAP-11 的顺序先行区分。
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const SIG_HEX = /^0x(?:[0-9a-fA-F]{2})*$/
function recoverWithCode(digestHex, sig) {
  if (typeof sig !== 'string' || !SIG_HEX.test(sig)) return { code: 'signature-bad-signature-length' }
  const b = fromHex(sig)
  if (b.length !== 65) return { code: 'signature-bad-signature-length', long: b.length > 65 }
  if (![0, 1, 27, 28].includes(b[64])) return { code: 'signature-bad-v' }
  const r = BigInt(hex(b.subarray(0, 32))), s = BigInt(hex(b.subarray(32, 64)))
  if (!(r >= 1n && r < N && s >= 1n && s < N)) return { code: 'signature-bad-r-s' }
  if (s > N / 2n) return { code: 'signature-high-s' }
  try { return { signer: recoverAddress(digestHex, sig).toLowerCase() } } catch { return { code: 'signature-bad-r-s' } }
}

// ---- §5.3 the checks / 检查 ----
const DISPLAY = Object.freeze({
  label: { en: 'display only, binds nobody', zh: '仅供展示，不约束任何人' },
  binder: { en: 'binder not checked: no enforcement is reported', zh: '绑定者未核对：不报告可否执行' },
  problems: { en: 'not reported as enforceable: the checks found problems', zh: '不报告为可强制执行：检查发现问题' },
  file: { en: 'policy file not checked: no verdict', zh: '策略文件未核对：没有结论' },
  conditional: { en: 'conditional: the binder rule rests on drafts that can still change; binds only the parties that check it', zh: '有条件：绑定者规则依托的草稿仍可能改动；只约束去核查它的一方' },
  account: { en: 'the signer had the authority to bind this account; it binds only the parties that check it, no one is shown to enforce it, and the agent\'s wallet may ignore it', zh: '签名者有权约束这个账户；它只约束去核查它的一方，不表示有谁在强制执行，代理的钱包可以不理会它' },
})
const subjectAccountOf = (b) => '0x' + b.subject.slice(26)
const inWindowOf = (o, where) => {
  const nb = decOf(o?.notBefore, `${where}.notBefore`, 'binding-malformed'), ex = decOf(o?.expires, `${where}.expires`, 'binding-malformed')
  return { nb, ex }
}

// The ordered problems and the ladder, once the signature view is known (who signed, was it the binder, was the binder
// checked) and each revocation's signer is known. / 签名结论与各撤销的签名者已知之后：按序列出问题并走阶梯。
function assemble(chainId, b, h, view, tables, o) {
  const kind = Number(b.subjectKind)
  const problems = []
  if (view.sigProblem) problems.push(view.sigProblem)
  else {
    if (kind === 3 && view.signer === subjectAccountOf(b)) problems.push('binding-self-signed')
    if (view.binderChecked && !view.signedByBinder) problems.push('not-signed-by-binder')
  }
  try { if (policyTablesHash(tables) !== b.tablesHash) problems.push('tables-hash-mismatch') } catch (e) { if (e instanceof PolicyCircuitError) problems.push(e.code); else throw e }
  const fileChecked = o.policyFile !== null && o.policyFile !== undefined
  if (fileChecked) {
    try { checkPolicyCircuit(o.policyFile, { declaredStateful: o.declaredStateful }) } catch (e) { if (e instanceof PolicyCircuitError) problems.push(e.code); else throw e }
    // the hash is compared whatever the file computes or fails (§2.2) / 无论文件内容如何、是否有效，都比对哈希
    let nh = null
    try { nh = policyNetlistHash(o.policyFile) } catch { /* not bytes: no hash */ }
    if (nh !== b.netlistHash) problems.push('policy-hash-mismatch')
  } else if (o.fileUnavailable) problems.push('policy-file-unavailable')
  const now = decOf(o.now, 'now', 'binding-malformed')
  if (now < BigInt(b.notBefore)) problems.push('binding-not-yet')
  else if (now > BigInt(b.expires)) problems.push('binding-expired')
  if (view.signer !== null) {
    for (const x of o.revocations) if (x.signer === view.signer && policyRevocationCovers(x.revocation, h, b.issued)) { problems.push('binding-revoked'); break }
  }
  // §8.1 / §8.2 (the Python reference does not do these: it has neither the mandate nor the session)
  // §8.1、§8.2（Python 参考实现没有授权书与会话，不做这一项）
  if (o.mandate) {
    const m = inWindowOf(o.mandate, 'mandate')
    if (BigInt(b.notBefore) < m.nb || BigInt(b.expires) > m.ex) problems.push('binding-outlives-subject')
  } else if (o.session) {
    if (BigInt(b.expires) > decOf(o.session.expires, 'session.expires', 'binding-malformed')) problems.push('binding-outlives-subject')
  }
  const binderChecked = view.binderChecked
  // the ladder, in the draft's order (§5.3), fixed: no option changes it / 阶梯，按草稿顺序写死，没有选项可改
  let enforceable, display
  if (kind === 4) { enforceable = false; display = DISPLAY.label }
  else if (!binderChecked) { enforceable = null; display = DISPLAY.binder }
  else if (problems.length) { enforceable = false; display = DISPLAY.problems }
  else if (!fileChecked) { enforceable = false; display = DISPLAY.file }
  else if (kind === 1 || kind === 2) { enforceable = 'conditional'; display = DISPLAY.conditional }
  else { enforceable = true; display = DISPLAY.account }
  return {
    bindingHash: h, signer: view.signer, subjectKind: POLICY_SUBJECT_KINDS[kind], status: problems.length ? 'problems' : 'ok', problems,
    binderChecked, fileChecked, displayOnly: kind === 4, enforceable, display: { ...display },
  }
}

// The subject record the caller hands over (a mandate, a session) must be the binding's subject.
// 调用方给的主体记录（授权书、会话）必须就是绑定的主体。
function subjectRecords(chainId, b, { mandate = null, session = null }) {
  const kind = Number(b.subjectKind)
  if (mandate !== null && mandate !== undefined) {
    if (kind !== 1) invalid('`mandate` applies to a mandate binding (kind 1) only')
    if (policySubject.mandate(mandate, { chainId }).subject !== b.subject) invalid('the mandate given does not hash to the binding\'s subject', 'policy-subject-mismatch')
  }
  if (session !== null && session !== undefined) {
    if (kind !== 2) invalid('`session` applies to an escrow-session binding (kind 2) only')
    if (policySubject.escrowSession(session).subject !== b.subject) invalid('the session given is not the binding\'s subject', 'policy-subject-mismatch')
  }
  return { mandate: mandate ?? null, session: session ?? null }
}
function revocationList(revocations) {
  if (revocations === null || revocations === undefined) return []
  if (!Array.isArray(revocations)) invalid('revocations is an array of { revocation, sig }')
  return revocations
}

/**
 * §5.3, synchronous: the binding's form (§5.2, thrown), then every problem that applies, in the draft's order, and the
 * `enforceable` ladder. `binder` is the address the subject kind requires as the signer, read by the caller (for kind 3
 * the holder of the circuit whose container is the account); without it the signature is only recovered and
 * `enforceable` is null. An ECDSA signature only: for a contract binder use verifyPolicyBinding with a chain reader.
 * `revocations` are `[{ revocation, sig }]`: the signer is RECOVERED from `sig` and an entry without one is ignored.
 * `mandate` (kind 1) / `session` (kind 2): the subject record, which must be the binding's subject; given, the binding
 * window must fit inside it (`binding-outlives-subject`).
 * §5.3 同步版：先查形式（抛出），再按草稿顺序列出全部问题并走 enforceable 阶梯。撤销的签名者从签名恢复，没有签名的条目忽略。
 */
export function checkPolicyBinding(chainId, binding, sig, tables, opts = {}) {
  return checkPolicyBindingWithSigners(chainId, binding, sig, tables, opts, (x) => {
    if (x.sig === undefined || x.sig === null) return null
    return recoverWithCode(policyRevocationHash(chainId, x.revocation), x.sig).signer ?? null
  })
}

// Internal, not in the package's entry (its `exports` map does not reach this file): checkPolicyBinding with the rule
// that names each revocation's signer passed in (`signerOf(entry) -> address | null`, null drops the entry). The public
// check recovers the signer from the signature; only the tests pass another rule, to replay the draft's binding vectors,
// whose reference takes a revocation's `signer` as given (F2).
// 内部函数，不在包入口里（exports 映射到不了本文件）：撤销签名者的取法由调用方给。公开的检查从签名恢复；只有测试为复现草稿向量
//（参考实现信任给定的 signer，F2）传另一种取法。
export function checkPolicyBindingWithSigners(chainId, binding, sig, tables, opts, signerOf) {
  const { now, policyFile = null, binder = null, declaredStateful = null, revocations = null, fileUnavailable = false } = opts
  checkPolicyBindingForm(binding)
  const records = subjectRecords(chainId, binding, opts)
  const h = policyBindingHash(chainId, binding)
  const binderAddr = binder === null || binder === undefined ? null : lowAddr(binder, 'binder')
  const rec = sig === null || sig === undefined ? { code: 'binding-unsigned' } : recoverWithCode(h, sig)
  const view = { signer: rec.signer ?? null, sigProblem: rec.code ?? null, binderChecked: binderAddr !== null, signedByBinder: rec.signer !== undefined && rec.signer === binderAddr }
  const revs = []
  for (const x of revocationList(revocations)) {
    if (!isObj(x)) invalid('a revocation entry is { revocation, sig }')
    const signer = signerOf(x)
    if (signer !== null && signer !== undefined) revs.push({ revocation: x.revocation, signer })
  }
  return assemble(chainId, binding, h, view, tables, { now, policyFile, declaredStateful, revocations: revs, fileUnavailable, ...records })
}

/**
 * §5.3 with the binder looked up and, for a contract binder, EIP-1271. `binder` is an address (then this is
 * checkPolicyBinding) or a reader `{ resolve(subjectKind, subject, { chainId, mandate, session }) -> { binder, pinned }
 * | address | null, isValidSignature?(address, digest, sig, pinned) -> boolean }`, such as policyBinderFromApi. A
 * signature that is the binder's under ECDSA is checked with no read; one that recovers to someone else, or a longer
 * one, is asked of the binder under EIP-1271 (TAP-11 §4.4: a malformed 65-byte one is refused without asking). A reader
 * that is missing or fails leaves `binderChecked: false` (`binderError` says why): never a pass.
 * Extra members: `binder` (the address checked against), `eip1271` (true when the binder accepted the signature under EIP-1271).
 * §5.3 加上绑定者查找与合约绑定者的 EIP-1271。读取函数缺失或失败时 binderChecked 为 false（binderError 写明原因），绝不算核对成功。
 */
export async function verifyPolicyBinding(chainId, binding, sig, tables, opts = {}) {
  const { binder = null, ...rest } = opts
  if (binder === null || binder === undefined || typeof binder === 'string') {
    const r = checkPolicyBinding(chainId, binding, sig, tables, opts)
    return { ...r, binder: binder ? binder.toLowerCase() : null, eip1271: false, binderError: binder ? null : 'no binder given' }
  }
  if (!isObj(binder) || typeof binder.resolve !== 'function') invalid('binder is an address or a reader { resolve, isValidSignature? }')
  checkPolicyBindingForm(binding)
  const records = subjectRecords(chainId, binding, rest)
  const h = policyBindingHash(chainId, binding)
  const kind = Number(binding.subjectKind)
  let binderAddr = null, pinned = null, binderError = null, eip1271 = false
  try {
    const got = await binder.resolve(kind, binding.subject, { chainId, mandate: records.mandate, session: records.session })
    const a = typeof got === 'string' ? got : got?.binder
    if (a !== null && a !== undefined) binderAddr = lowAddr(a, 'the resolved binder')
    else binderError = 'the reader names no binder for this subject'
    pinned = isObj(got) ? got.pinned ?? null : null
  } catch (e) { binderError = `binder unavailable: ${e?.message ?? e}` }
  const ask = typeof binder.isValidSignature === 'function' ? binder.isValidSignature.bind(binder) : null
  // Only true or false is an answer: '0x00000000', 1 or {} from a reader is a failed read, never a yes (FIXED R30-C1).
  // 只有 true 或 false 算回答：读取函数给出 '0x00000000'、1 或 {} 都是读取失败，绝不算"是"。
  const asked = async (...a) => { const ok = await ask(...a); if (typeof ok !== 'boolean') throw new Error(`isValidSignature answered ${typeof ok}, not true or false`); return ok }
  const rec = sig === null || sig === undefined ? { code: 'binding-unsigned' } : recoverWithCode(h, sig)
  let view = { signer: rec.signer ?? null, sigProblem: rec.code ?? null, binderChecked: false, signedByBinder: false }
  if (binderAddr !== null) {
    if (rec.signer && rec.signer === binderAddr) view = { ...view, binderChecked: true, signedByBinder: true }
    else if (rec.signer || rec.long) {
      if (!ask) binderError = 'the signature is not the binder\'s under ECDSA and no EIP-1271 reader was given'
      else {
        try {
          if (await asked(binderAddr, h, sig, pinned)) { view = { signer: binderAddr, sigProblem: null, binderChecked: true, signedByBinder: true }; eip1271 = true }
          else view = { ...view, binderChecked: true }
        } catch (e) { binderError = `EIP-1271 read failed: ${e?.message ?? e}` }
      }
    } else view = { ...view, binderChecked: true }   // unsigned, or a malformed 65-byte signature: refused without asking
  }
  const revs = []
  for (const x of revocationList(rest.revocations)) {
    if (!isObj(x)) invalid('a revocation entry is { revocation, sig }')
    if (x.sig === undefined || x.sig === null) continue
    const rh = policyRevocationHash(chainId, x.revocation)
    const rr = recoverWithCode(rh, x.sig)
    if (rr.signer && rr.signer === view.signer) { revs.push({ revocation: x.revocation, signer: rr.signer }); continue }
    if (eip1271 && ask && (rr.signer || rr.long)) {
      try { if (await asked(binderAddr, rh, x.sig, pinned)) revs.push({ revocation: x.revocation, signer: binderAddr }) } catch (e) {
        // an unreadable revocation leaves the binding unchecked, never unrevoked / 读不出的撤销使绑定未核对，绝不当作未撤销
        binderError = `EIP-1271 read of a revocation failed: ${e?.message ?? e}`
        view = { ...view, binderChecked: false }
      }
    } else if (rr.signer) revs.push({ revocation: x.revocation, signer: rr.signer })
  }
  if (binderError) view = { ...view, binderChecked: false }
  const r = assemble(chainId, binding, h, view, tables, { now: rest.now, policyFile: rest.policyFile ?? null, declaredStateful: rest.declaredStateful ?? null, revocations: revs, fileUnavailable: !!rest.fileUnavailable, ...records })
  return { ...r, binder: binderAddr, eip1271, binderError }
}

/**
 * §5.4 supersession over checked bindings of one signer and one subject: of those with no problem, the greatest
 * `issued` wins; two with the same `issued` and different hashes are `binding-ambiguous` and neither is used.
 * `entries`: `[{ binding, result }]` (result: checkPolicyBinding / verifyPolicyBinding). / §5.4 取 issued 最大者；并列即二者都不用。
 */
export function choosePolicyBinding(entries) {
  if (!Array.isArray(entries) || !entries.length) invalid('choosePolicyBinding takes [{ binding, result }]')
  const keyOf = (e) => `${e.result?.signer}|${e.binding?.subjectKind}|${e.binding?.subject}`
  if (new Set(entries.map(keyOf)).size > 1) invalid('choosePolicyBinding compares bindings of one signer and one subject')
  const ok = entries.filter((e) => e.result?.status === 'ok')
  if (!ok.length) return { chosen: null, problem: 'binding-unusable' }
  const top = ok.reduce((m, e) => (BigInt(e.binding.issued) > m ? BigInt(e.binding.issued) : m), -1n)
  const best = ok.filter((e) => BigInt(e.binding.issued) === top)
  if (new Set(best.map((e) => e.result.bindingHash)).size > 1) return { chosen: null, problem: 'binding-ambiguous' }
  return { chosen: best[0], problem: null }
}

// ---- typed data for the binder's console / 给持有人控制台的类型数据 ----
const EIP712_DOMAIN = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }]
const jsonInt = (n) => (n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n.toString())   // §5.2 JSON form / JSON 形式
const nowOf = (now) => (now === undefined ? Math.floor(Date.now() / 1000) : now)

/**
 * The typed data a binder signs (eth_signTypedData_v4), with the binding in its JSON form and its hash. Without
 * `notBefore` / `expires` the window is the next 7 days from `now` (a tool must not propose more than 30 days by
 * default; a longer window passed explicitly is the binder's own choice and is flagged `longWindow`). `tables` may be
 * given instead of `tablesHash`. Kind 4 says "display only, binds nobody".
 * 绑定者签的类型数据。默认窗口为 now 起 7 天；显式给出更长的窗口是绑定者自己的选择，标 longWindow。
 */
export function policyBindingTypedData(chainId, input, { now } = {}) {
  if (!isObj(input)) invalid('policyBindingTypedData takes { netlistHash, subjectKind, subject, tablesHash | tables, notBefore?, expires?, issued? }')
  const t = BigInt(decOf(nowOf(now), 'now', 'binding-malformed'))
  const nb = input.notBefore === undefined ? t : decOf(input.notBefore, 'notBefore', 'binding-malformed')
  const ex = input.expires === undefined ? nb + BigInt(POLICY_BINDING_DEFAULT_WINDOW_S) : decOf(input.expires, 'expires', 'binding-malformed')
  const iss = input.issued === undefined ? t : decOf(input.issued, 'issued', 'binding-malformed')
  const tablesHash = input.tablesHash ?? (input.tables !== undefined ? policyTablesHash(input.tables) : undefined)
  const binding = { netlistHash: input.netlistHash, subjectKind: input.subjectKind, subject: input.subject, tablesHash, notBefore: jsonInt(nb), expires: jsonInt(ex), issued: jsonInt(iss) }
  checkPolicyBindingForm(binding)
  const kind = Number(binding.subjectKind)
  const say = {
    en: `PolicyBinding (draft, TAPs pull request #84, not merged): the policy circuit ${binding.netlistHash} applies to this ${POLICY_SUBJECT_KINDS[kind]} from ${nb} to ${ex}; it binds only the parties that check it`,
    zh: `策略绑定（草稿，TAPs PR #84，未合并）：策略电路 ${binding.netlistHash} 在 ${nb} 至 ${ex} 之间适用于这个${{ 1: '授权书', 2: '托管会话', 3: '账户', 4: '标签' }[kind]}；它只约束去核查它的一方`,
  }
  if (kind === 4) { say.en += '; display only, binds nobody'; say.zh += '；仅供展示，不约束任何人' }
  return {
    domain: domainOf(chainId),
    types: { EIP712Domain: EIP712_DOMAIN, PolicyBinding: BINDING_FIELDS.map(([name, type]) => ({ name, type })) },
    primaryType: 'PolicyBinding', message: { ...binding }, binding, bindingHash: policyBindingHash(chainId, binding),
    longWindow: ex - nb > BigInt(POLICY_BINDING_MAX_DEFAULT_WINDOW_S), display: say,
  }
}
/** The typed data of a revocation (§5.4): `bindingHashes` (default none), `revokedBefore` (default 0), `issued` (default now). */
export function policyRevocationTypedData(chainId, input = {}, { now } = {}) {
  if (!isObj(input)) invalid('policyRevocationTypedData takes { bindingHashes?, revokedBefore?, issued? }')
  const revocation = {
    bindingHashes: input.bindingHashes ?? [], revokedBefore: jsonInt(decOf(input.revokedBefore ?? 0, 'revokedBefore', 'revocation-malformed')),
    issued: jsonInt(decOf(input.issued ?? nowOf(now), 'issued', 'revocation-malformed')),
  }
  checkPolicyRevocationForm(revocation)
  return {
    domain: domainOf(chainId),
    types: { EIP712Domain: EIP712_DOMAIN, PolicyBindingRevocation: REVOCATION_FIELDS.map(([name, type]) => ({ name, type })) },
    primaryType: 'PolicyBindingRevocation', message: { ...revocation }, revocation, revocationHash: policyRevocationHash(chainId, revocation),
  }
}

// ---- §6 metadata members / 元数据成员 ----
/** §6.1: `tap.policy` on a policy token (and its agreement with `tap.netlist`). Returns the member. / 策略代币上的成员。 */
export function checkTokenPolicyMember(tap) {
  const p = isObj(tap) ? tap.policy : undefined
  if (!isObj(p)) fail('policy-member-missing')
  if (Object.keys(p).some((k) => !['convention', 'stateful', 'reasons'].includes(k)) || !('convention' in p) || !('stateful' in p)) fail('policy-member-malformed', 'members')
  if (p.convention !== POLICY_CONVENTION) fail('policy-unknown-convention', String(p.convention))
  if (typeof p.stateful !== 'boolean') fail('policy-member-malformed', 'stateful is a boolean')
  if ('reasons' in p) {
    if (!isObj(p.reasons)) fail('policy-member-malformed', 'reasons is an object')
    for (const [k, v] of Object.entries(p.reasons)) {
      if (!DEC.test(k) || +k < 64 || +k > 127) fail('policy-member-malformed', `reason code ${k}`)
      if (typeof v !== 'string' || te(v).length < 1 || te(v).length > 64) fail('policy-member-malformed', `reason ${k}: 1-64 UTF-8 bytes`)
    }
  }
  const n = tap.netlist
  if (isObj(n) && ('nIn' in n || 'nOut' in n) && (n.nIn !== POLICY_N_IN || n.nOut !== POLICY_N_OUT)) fail('policy-bad-pins')
  if (isObj(n) && 'latch' in n && (n.latch > 0) !== p.stateful) fail('policy-stateful-mismatch')
  return p
}
/**
 * §6.2: `tap.policy` in a subject record: `chainId`, `binding`, `sig`, `tables`, optionally `policy` { chainId,
 * contract, tokenId }. Form only: carrying it is not a verification (run checkPolicyBinding). / 主体记录里的成员，只查形式。
 */
export function checkSubjectPolicyMember(m) {
  const req = ['chainId', 'binding', 'sig', 'tables']
  if (!isObj(m) || !req.every((k) => k in m) || Object.keys(m).some((k) => ![...req, 'policy'].includes(k))) fail('policy-member-malformed', 'members')
  if (decOf(m.chainId, 'chainId', 'policy-member-malformed') >= 1n << 64n) fail('policy-member-malformed', 'chainId')
  checkPolicyBindingForm(m.binding)
  if (typeof m.sig !== 'string' || !/^0x[0-9a-f]{130}$/.test(m.sig)) fail('policy-member-malformed', 'sig is 0x + 130 hex digits')
  checkPolicyTables(m.tables)
  if ('policy' in m) {
    const p = m.policy
    if (!sameKeys(p, ['chainId', 'contract', 'tokenId'])) fail('policy-member-malformed', 'policy members')
    if (decOf(p.chainId, 'policy.chainId', 'policy-member-malformed') >= 1n << 64n) fail('policy-member-malformed', 'policy.chainId')
    if (typeof p.contract !== 'string' || !/^0x[0-9a-f]{40}$/.test(p.contract)) fail('policy-member-malformed', 'policy.contract')
    if (decOf(p.tokenId, 'policy.tokenId', 'policy-member-malformed') >= 1n << 256n) fail('policy-member-malformed', 'policy.tokenId')
  }
  return m
}
