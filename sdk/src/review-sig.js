// @experimental Evidence-backed reviews between containers: the record, its hashes and its signature, without the chain.
// The format is the draft "Evidence-Backed Reviews between Containers" (TapeOutProtocol/TAPs pull request #54, tap TBD):
// one EIP-712 type `Review` in the TAP-11 delegation domain, with the domain's chainId the reviewer's chain. Nothing here
// reads the chain; verification is review-verify.js. Outside the 2.x compatibility promise: the draft may change.
// 评价记录（实验性）：类型、哈希与签名，不读链。格式按 TAPs PR #54 草稿；核验在 review-verify.js。
import { keccak_256 } from '@noble/hashes/sha3'
import { TapeAPIError } from './errors.js'
import { canonicalJSON } from './canon.js'
import { encodeParams, hexToBytes, toHex, utf8ToBytes, isAddress, checksumAddress } from './abi.js'
import { typedDigest, delegationDomain, signDigest, responseDigestFromHashes } from './sig.js'
import { chainById, CHAIN_IDS } from './chains.js'
import { normalizeMandate, mandateHashOf } from './agent-sig.js'

export const REVIEW_TYPE = 'Review(bytes32 reviewer,bytes32 reviewee,uint8 kind,uint8 score,bytes32 subject,bytes32 evidenceHash,bytes32 textHash,uint64 issued)'
export const REVIEW_TYPEHASH = keccak_256(utf8ToBytes(REVIEW_TYPE))
export const REVIEW_KIND = 1                       // a review / 评价
export const WITHDRAWAL_KIND = 2                   // a withdrawal (§7) / 撤回
export const REVIEW_ID_PREFIX = 'tape-review:'     // §4.2: the request id names the reviewer / 请求 id 写明评价方
export const MAX_EVIDENCE_AGE_S = 7_776_000        // §4.2 step 5: 90 days
export const ISSUED_SKEW_S = 300                   // §6 step 4
export const MAX_TEXT_CODE_POINTS = 2000           // §3
export const MAX_TAGS = 8                          // §3
export const ZERO32 = '0x' + '00'.repeat(32)
const HASH_RE = /^0x[0-9a-f]{64}$/
const WORD_RE = /^[a-z0-9][a-z0-9._/-]{0,63}$/
const MAX_SAFE = Number.MAX_SAFE_INTEGER
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/** @experimental A record's shape is wrong (§2): INVALID_ARGUMENT with data.reason the draft's problem name. / 记录形式错误 */
export class ReviewFormError extends TapeAPIError {
  constructor(reason, message) { super('INVALID_ARGUMENT', message ?? reason, { data: { reason } }) }
}
const bad = (reason, message) => { throw new ReviewFormError(reason, message) }

// ---- endpoint IDs (TAP-10 §12.1): uint32(0) ‖ uint64(chainId) ‖ container / 端点号 ----
/** @experimental The endpoint ID of `container` on `chainId`, as 0x and 64 lower-case hex digits. */
export function endpointId(chainId, container) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new TapeAPIError('INVALID_ARGUMENT', 'chainId must be a positive integer of at most 2^53 - 1')
  if (!isAddress(container) || /^0x0{40}$/.test(container)) throw new TapeAPIError('INVALID_ARGUMENT', 'container must be a non-zero address')
  return '0x' + '00000000' + BigInt(chainId).toString(16).padStart(16, '0') + container.slice(2).toLowerCase()
}
/** @experimental { chainId, container } of an endpoint ID in the form of §2.1; otherwise a ReviewFormError (record-malformed). */
export function parseEndpoint(e) {
  if (typeof e !== 'string' || !HASH_RE.test(e)) bad('record-malformed', 'an endpoint ID is 0x and 64 lower-case hex digits')
  if (e.slice(2, 10) !== '00000000') bad('record-malformed', 'an endpoint ID has its top 4 bytes zero')
  const chainId = BigInt('0x' + e.slice(10, 26)), container = '0x' + e.slice(26)
  if (chainId === 0n || chainId > BigInt(MAX_SAFE)) bad('record-malformed', 'an endpoint ID carries a chain ID from 1 to 2^53 - 1')
  if (/^0x0{40}$/.test(container)) bad('record-malformed', 'an endpoint ID names a non-zero container')
  return { chainId: Number(chainId), container: checksumAddress(container) }
}
/** @experimental Whether the endpoint's chain is in the TAP-10 §2.1 chain table (the chains this SDK knows). */
export const isTapeOutChain = (chainId) => CHAIN_IDS.includes(Number(chainId))

// ---- the Review type (§2.1) ----
/**
 * @experimental The eight fields of a review in the form of §2.1 and §2.2, checked (kind 1: score 1 to 5, subject and
 * evidenceHash both zero or both non-zero; kind 2: score 0, evidenceHash zero). Throws ReviewFormError (record-malformed).
 * 评价的八个字段按 §2.1、§2.2 检查；不合规抛 record-malformed。
 */
export function normalizeReview(r) {
  if (!isObj(r)) bad('record-malformed', 'review must be an object')
  for (const k of ['reviewer', 'reviewee', 'kind', 'score', 'subject', 'evidenceHash', 'textHash', 'issued']) if (!(k in r)) bad('record-malformed', `review.${k} is missing`)
  parseEndpoint(r.reviewer); parseEndpoint(r.reviewee)
  for (const k of ['subject', 'evidenceHash', 'textHash']) if (typeof r[k] !== 'string' || !HASH_RE.test(r[k])) bad('record-malformed', `review.${k} must be 0x and 64 lower-case hex digits`)
  if (!Number.isSafeInteger(r.issued) || r.issued < 0) bad('record-malformed', 'review.issued must be an integer from 0 to 2^53 - 1')
  if (r.kind === REVIEW_KIND) {
    if (!Number.isInteger(r.score) || r.score < 1 || r.score > 5) bad('record-malformed', 'a review (kind 1) has a score from 1 to 5')
    if ((r.subject === ZERO32) !== (r.evidenceHash === ZERO32)) bad('record-malformed', 'subject and evidenceHash are both zero or both non-zero')
  } else if (r.kind === WITHDRAWAL_KIND) {
    if (r.score !== 0) bad('record-malformed', 'a withdrawal (kind 2) has score 0')
    if (r.evidenceHash !== ZERO32) bad('record-malformed', 'a withdrawal (kind 2) has evidenceHash zero')
  } else bad('record-malformed', 'kind must be 1 (a review) or 2 (a withdrawal); other values are reserved')
  return { reviewer: r.reviewer, reviewee: r.reviewee, kind: r.kind, score: r.score, subject: r.subject, evidenceHash: r.evidenceHash, textHash: r.textHash, issued: r.issued }
}
/** @experimental hashStruct of a review (32 bytes). */
export function hashReview(review) {
  const n = normalizeReview(review)
  return keccak_256(encodeParams(['bytes32', 'bytes32', 'bytes32', 'uint8', 'uint8', 'bytes32', 'bytes32', 'bytes32', 'uint64'],
    [REVIEW_TYPEHASH, hexToBytes(n.reviewer), hexToBytes(n.reviewee), n.kind, n.score, hexToBytes(n.subject), hexToBytes(n.evidenceHash), hexToBytes(n.textHash), BigInt(n.issued)]))
}
const hubFor = (chainId, hub) => {
  const h = hub ?? chainById(chainId)?.hub
  if (!isAddress(h)) throw new TapeAPIError('INVALID_ARGUMENT', `no hub address for chain ${chainId}: pass { hub }`)
  return h
}
/** @experimental The EIP-712 digest (§2.1): TAP-11 domain, chainId the reviewer's chain, hub the chain's (or `hub`). */
export function reviewDigest(review, { hub } = {}) {
  const n = normalizeReview(review)
  const { chainId } = parseEndpoint(n.reviewer)
  return typedDigest(delegationDomain(chainId, hubFor(chainId, hub)), hashReview(n))
}
/** @experimental The review hash: the record's identity (§2.1), 0x and 64 lower-case hex digits. */
export const reviewHashOf = (review, o) => toHex(reviewDigest(review, o))
/**
 * @experimental Sign a review with `privateKey`: the reviewer's current holder, or its delegate (the TAP-11 signer of the
 * reviewer's service). The key decides who signed; a verifier accepts only those two (§5). Returns the 65-byte signature.
 * 用持有人或委托钥匙（评价方服务的 TAP-11 签名者）签名；核验方只认这两者。
 */
export function signReview(review, privateKey, o) { return signDigest(reviewDigest(review, o), privateKey) }

const LEVEL_NAMES = { 0: 'no evidence (shown, never counted)', 1: 'a signed answer (level 1)', 2: 'a task (level 2)' }
export const REVIEW_PUBLIC_NOTICE = 'A review is a public statement: everything in the record (reviewer, reviewee, score, text unless withheld, evidence) is public and permanent once published.'
/**
 * @experimental The EIP-712 payload for a wallet (eth_signTypedData_v4), with what the console should show beside it
 * (§5): the reviewee's name (`revieweeName`, read from the chain by the caller), the score, the evidence level and the
 * text. The typed data itself shows only endpoint IDs and hashes.
 * 钱包载荷，附控制台应显示的内容：被评方名字、分数、证据等级与文字（类型数据本身只有端点号与哈希）。
 */
export function reviewTypedData(review, { hub, revieweeName, text, evidence } = {}) {
  const n = normalizeReview(review)
  const { chainId } = parseEndpoint(n.reviewer)
  const level = n.kind !== REVIEW_KIND || n.subject === ZERO32 ? 0 : evidence?.kind === 'response' ? 1 : evidence?.kind === 'task' ? 2 : null
  return {
    warnings: [REVIEW_PUBLIC_NOTICE],
    display: {
      kind: n.kind === REVIEW_KIND ? 'review' : 'withdrawal',
      reviewer: parseEndpoint(n.reviewer), reviewee: parseEndpoint(n.reviewee),
      ...(revieweeName !== undefined ? { revieweeName: String(revieweeName) } : {}),
      score: n.score, evidence: level === null ? 'evidence not given to the console' : LEVEL_NAMES[level],
      text: n.textHash === ZERO32 ? null : text !== undefined ? text : 'withheld (only its hash is signed)',
      issued: new Date(n.issued * 1000).toISOString(),
    },
    domain: delegationDomain(chainId, hubFor(chainId, hub)),
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      Review: [
        { name: 'reviewer', type: 'bytes32' }, { name: 'reviewee', type: 'bytes32' }, { name: 'kind', type: 'uint8' }, { name: 'score', type: 'uint8' },
        { name: 'subject', type: 'bytes32' }, { name: 'evidenceHash', type: 'bytes32' }, { name: 'textHash', type: 'bytes32' }, { name: 'issued', type: 'uint64' },
      ],
    },
    primaryType: 'Review',
    message: n,
  }
}

// ---- text (§3) ----
/** @experimental jsonHash of any JSON value: keccak256(utf8(canonicalJSON(v))). */
export const jsonHash = (v) => toHex(keccak_256(utf8ToBytes(canonicalJSON(v))))
/** @experimental Why a text object breaks §3, or null. / 文字对象不符合 §3 的原因，或 null */
export function textProblem(t) {
  if (!isObj(t)) return 'text must be an object'
  if (typeof t.body !== 'string') return 'text.body must be a string'
  if ([...t.body].length > MAX_TEXT_CODE_POINTS) return `text.body has more than ${MAX_TEXT_CODE_POINTS} code points`
  if (t.tags !== undefined) {
    if (!Array.isArray(t.tags) || t.tags.length > MAX_TAGS) return `text.tags must be an array of at most ${MAX_TAGS} words`
    if (!t.tags.every((w) => typeof w === 'string' && WORD_RE.test(w))) return 'a tag is not a word (^[a-z0-9][a-z0-9._/-]{0,63}$)'
    if (new Set(t.tags).size !== t.tags.length) return 'text.tags repeat a word'
  }
  try { canonicalJSON(t) } catch { return 'text has no canonical form' }
  return null
}
/** @experimental textHash of a text object (§3); throws INVALID_ARGUMENT when it breaks §3. */
export function textHashOf(text) {
  const p = textProblem(text)
  if (p) throw new TapeAPIError('INVALID_ARGUMENT', p)
  return jsonHash(text)
}
/** @experimental evidenceHash of an evidence object (§4); throws INVALID_ARGUMENT without a canonical form. */
export function evidenceHashOf(evidence) {
  if (!isObj(evidence)) throw new TapeAPIError('INVALID_ARGUMENT', 'evidence must be an object')
  return jsonHash(evidence)
}

// ---- evidence (§4) ----
/**
 * @experimental A TAP-13 request id that names the reviewer (§4.2): `tape-review:` ‖ the reviewer's container in lower
 * case ‖ `:` ‖ `nonce` (default 16 random bytes in hex). It is a label for reviews, never the caller's identity.
 * 写明评价方的请求 id；它只是评价用的标签，不是调用者身份。
 */
export function reviewRequestId(reviewerContainer, nonce) {
  if (!isAddress(reviewerContainer)) throw new TapeAPIError('INVALID_ARGUMENT', 'reviewRequestId takes the reviewer\'s container address')
  const n = nonce ?? toHex(globalThis.crypto.getRandomValues(new Uint8Array(16))).slice(2)
  if (typeof n !== 'string' || n.length < 16 || !/^[\x21-\x7e]+$/.test(n)) throw new TapeAPIError('INVALID_ARGUMENT', 'the nonce is at least 16 characters from U+0021 to U+007E')
  const id = `${REVIEW_ID_PREFIX}${reviewerContainer.toLowerCase()}:${n}`
  if (id.length > 128) throw new TapeAPIError('INVALID_ARGUMENT', 'a TAP-13 request id has at most 128 UTF-16 code units')
  return id
}
/**
 * @experimental The `subject` that evidence names (§4.1), computed without the chain: the TAP-13 §5 digest of a level-1
 * receipt (with the reviewee's container), or the mandate hash of a level-2 task (in the domain of the principal's
 * chain, which is the chain of whichever of reviewer and reviewee is the principal). Throws INVALID_ARGUMENT otherwise.
 * 证据对应的 subject，不读链：1 级为 TAP-13 摘要，2 级为委托书哈希（委托方所在链的域）。
 */
export function subjectOf(evidence, { reviewer, reviewee, hub } = {}) {
  const re = parseEndpoint(reviewee), rv = parseEndpoint(reviewer)
  if (evidence?.kind === 'response') {
    const r = evidence.receipt
    try { return toHex(responseDigestFromHashes({ container: re.container, id: r.id, requestHash: r.requestHash, ok: r.ok, bodyHash: r.bodyHash, ts: r.ts })) } catch (e) { throw new TapeAPIError('INVALID_ARGUMENT', `level-1 evidence: ${e.message}`) }
  }
  if (evidence?.kind === 'task') {
    let m
    try { m = normalizeMandate(evidence.mandate, { wire: true }) } catch (e) { throw new TapeAPIError('INVALID_ARGUMENT', `level-2 evidence: ${e.message}`) }
    const principal = m.principal.toLowerCase() === rv.container.toLowerCase() ? rv : m.principal.toLowerCase() === re.container.toLowerCase() ? re : null
    if (!principal) throw new TapeAPIError('INVALID_ARGUMENT', 'level-2 evidence: the mandate\'s principal is neither the reviewer nor the reviewee')
    return mandateHashOf(principal.chainId, hubFor(principal.chainId, hub), m)
  }
  throw new TapeAPIError('INVALID_ARGUMENT', 'evidence kind must be "response" (level 1) or "task" (level 2)')
}
/**
 * @experimental Build a record's review fields from its parts (hashes computed here): { review, text?, evidence? }.
 * `kind` 1 (default) or 2; `score` 1 to 5 (kind 2: 0); `subject` for a withdrawal of a review of one interaction.
 * Sign `review` with signReview and publish { review, sig, text, evidence } (leave text out to withhold it).
 * 由各部分构造评价字段（在这里计算哈希）；签名后发布 { review, sig, text, evidence }（不带 text 即保留文字）。
 */
export function makeReview({ reviewer, reviewee, kind = REVIEW_KIND, score, text, evidence, subject, issued, hub } = {}) {
  const ep = (x, what) => (typeof x === 'string' ? (parseEndpoint(x), x) : isObj(x) ? endpointId(x.chainId, x.container) : bad('record-malformed', `${what} must be an endpoint ID or { chainId, container }`))
  const rv = ep(reviewer, 'reviewer'), re = ep(reviewee, 'reviewee')
  const out = {
    review: normalizeReview({
      reviewer: rv, reviewee: re, kind, score: kind === WITHDRAWAL_KIND ? (score ?? 0) : score,
      subject: evidence !== undefined && kind === REVIEW_KIND ? subjectOf(evidence, { reviewer: rv, reviewee: re, hub }) : (subject ?? ZERO32),
      evidenceHash: evidence !== undefined && kind === REVIEW_KIND ? evidenceHashOf(evidence) : ZERO32,
      textHash: text !== undefined ? textHashOf(text) : ZERO32,
      issued: issued ?? Math.floor(Date.now() / 1000),
    }),
  }
  if (text !== undefined) out.text = text
  if (evidence !== undefined && kind === REVIEW_KIND) out.evidence = evidence
  return out
}
