// @experimental Evidence-backed reviews between containers: verification (§6), withdrawal and correction (§7), the two
// carriages (§8: the reviewer's site file and a public TapeSend message) and summaries (§9) of the draft "Evidence-Backed
// Reviews between Containers" (TapeOutProtocol/TAPs pull request #54, tap TBD). Outside the 2.x compatibility promise.
//
// One set of rules, two sources of chain facts:
//   - checkReview(record, facts): the facts (current holders, current TAP-11 signers, holders with code) are given, as the
//     draft's test vectors give them. It declines EIP-1271, as TAP-11 §4.4 allows a verifier to.
//   - createReviewKit(api).verifyReview(record): the facts are read from the chain with the strict readers of
//     createAgentKit (TAP-10 §4.3 identities, holders and EIP-1271 at ONE pinned block per chain and verification, under
//     strict agreement; TAP-11 §2 resolutions), one agent kit per chain (api.forChain for the other chain of a pair).
// A chain or node failure is thrown (the verification is unavailable); it is never reported as a problem of the record.
// 一套规则，两种链上事实来源：给定事实（向量）或经 createAgentKit 的严格读取从链上读（每条链每次核验一个钉块）。链或节点
// 失败一律抛出（核验不可用），绝不当作记录的问题。
import { TapeAPIError } from './errors.js'
import { safeParseJSON } from './canon.js'
import { toHex, isAddress, eqAddr, checksumAddress } from './abi.js'
import { recoverAddress, recoverResponseSigner, recoverResponseSignerFromHashes, responseDigestFromHashes } from './sig.js'
import { normalizeMandate, normalizeTaskVerdict, mandateDigest, taskVerdictDigest, phase0Problems } from './agent-sig.js'
import { createAgentKit, agentKitInternals, agentMessageProblem, hashOnlyReceiptProblem, plainText } from './agent-verify.js'
import { createPaymentKit, paymentKitInternals, decodeContent, INBOX_PAGE_MAX } from './agent-pay.js'
import { open as openPayload, encodePublic, endpoint as tapesendEndpoint, MAX_PAYLOAD } from './tapesend.js'
import {
  normalizeReview, parseEndpoint, endpointId, reviewDigest, jsonHash, textProblem, isTapeOutChain, ReviewFormError,
  REVIEW_KIND, REVIEW_ID_PREFIX, MAX_EVIDENCE_AGE_S, ISSUED_SKEW_S, ZERO32,
} from './review-sig.js'
import { chainById } from './chains.js'

export const REVIEWS_KEY = '.well-known/tapeapi-reviews.json'   // §8.1
export const REVIEWS_LIMIT = 262_144                            // §8.1, bytes
export const REVIEWS_FORMAT = '1'                               // the `tapeapi-reviews` member
export const MAX_REVIEW_TEXT_DISPLAY = 2000
/** Every problem name of the draft, in the order of its sections / 草稿里的全部问题名 */
export const REVIEW_PROBLEMS = Object.freeze([
  'record-malformed', 'unsupported-chain', 'self-review', 'issued-in-future', 'text-mismatch', 'record-signature',
  'not-tapeout', 'no-such-token', 'signer-not-current', 'holder-signature-unsupported',
  'evidence-missing', 'evidence-malformed', 'evidence-mismatch', 'evidence-unknown', 'evidence-wrong-party', 'evidence-unbound',
  'subject-mismatch', 'evidence-time', 'evidence-signature', 'verdict-mismatch', 'related-parties', 'conflict',
])
export const REVIEW_PROVES = 'who signed the record for the reviewer now (its current holder or delegate), and at level 1 or 2 that the two containers exchanged a signed answer or a delegated, delivered and judged task'
export const REVIEW_DOES_NOT_PROVE = Object.freeze(['that the reviewer is independent of the reviewee', 'that the answer or the work was right', 'that the score is fair', 'who held the reviewer when the record was signed (except a TapeSend copy, §8.2)'])

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const isHash = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v)
const isU64 = (v) => Number.isSafeInteger(v) && v >= 0
const SIG65_RE = /^0x[0-9a-fA-F]{130}$/
const SIGANY_RE = /^0x(?:[0-9a-fA-F]{2}){65,1024}$/
const METHOD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const lc = (a) => String(a).toLowerCase()
const epKey = (ep) => endpointId(ep.chainId, ep.container)
class Problem extends Error { constructor(code, message) { super(message ?? code); this.code = code } }
const stop = (code, message) => { throw new Problem(code, message) }

// ---- the rules (§4, §6), over a reader of chain facts / 规则本身，读链交给 reader ----
// reader: { hubOf(chainId), identity(ep) -> { holder, name? } | { problem }, signer(ep) -> address | null (TAP-11 §2),
//           hasCode(ep, address) -> boolean, holderSigned(ep, holder, digest, sig) -> boolean (ECDSA or EIP-1271),
//           eip1271: boolean }
async function checkWith(rec, reader, now) {
  const out = { valid: false, hash: null, level: 0, signedBy: null, counted: false, problems: [], textWithheld: false, details: [], reviewer: null, reviewee: null }
  const note = (code, message) => { out.problems.push(code); out.details.push({ code, message: message ?? code }) }
  try {
    // 1. form (§2.2, §2.1)
    if (!isObj(rec)) stop('record-malformed', 'a record is a JSON object')
    let r
    try { r = normalizeReview(rec.review) } catch (e) { if (e instanceof ReviewFormError) stop('record-malformed', e.message); throw e }
    if (typeof rec.sig !== 'string' || !SIGANY_RE.test(rec.sig)) stop('record-malformed', 'sig is 0x and 65 to 1,024 bytes in hex')
    const rv = parseEndpoint(r.reviewer), re = parseEndpoint(r.reviewee)
    // 2. chains of TAP-10 §2.1
    if (!isTapeOutChain(rv.chainId) || !isTapeOutChain(re.chainId)) stop('unsupported-chain', `chain ${isTapeOutChain(rv.chainId) ? re.chainId : rv.chainId} is not in the TAP-10 chain table`)
    const digest = reviewDigest(r, { hub: reader.hubOf(rv.chainId) })
    out.hash = toHex(digest)
    // 3. self-review
    if (rv.chainId === re.chainId && eqAddr(rv.container, re.container)) stop('self-review')
    // 4. time
    if (r.issued > now + ISSUED_SKEW_S) stop('issued-in-future', `issued ${r.issued} is more than ${ISSUED_SKEW_S} s after ${now}`)
    // 5. text (§3)
    if (r.textHash === ZERO32) { if (rec.text !== undefined) stop('text-mismatch', 'text is present while textHash is zero') }
    else if (rec.text === undefined) out.textWithheld = true
    else {
      const p = textProblem(rec.text)
      if (p) stop('text-mismatch', p)
      if (jsonHash(rec.text) !== r.textHash) stop('text-mismatch', 'text does not hash to textHash')
    }
    // 6a. a 65-byte signature outside the range rules of TAP-11 §4.4 item 1 rejects the record
    let who = null
    if (SIG65_RE.test(rec.sig)) { try { who = recoverAddress(digest, rec.sig) } catch (e) { stop('record-signature', `the signature breaks TAP-11 §4.4 item 1: ${e.message}`) } }
    // TAP-10 §4.3 identities: not-tapeout and no-such-token reject the record (§6); the node outcomes are thrown
    const [idRv, idRe] = await Promise.all([reader.identity(rv), reader.identity(re)])
    for (const id of [idRv, idRe]) if (id.problem) stop(id.problem.code, id.problem.message)
    const [delegate, revieweeSigner] = await Promise.all([reader.signer(rv), reader.signer(re)])
    out.reviewer = { chainId: rv.chainId, container: rv.container, endpoint: r.reviewer, holder: idRv.holder, delegate, ...(idRv.name ? { name: idRv.name } : {}) }
    out.reviewee = { chainId: re.chainId, container: re.container, endpoint: r.reviewee, holder: idRe.holder, signer: revieweeSigner, ...(idRe.name ? { name: idRe.name } : {}) }
    out.valid = true
    // 6b. by whom (§5): the current holder (ECDSA, or EIP-1271 for a holder with code) or the current delegate (65 bytes)
    if (who && eqAddr(who, idRv.holder)) out.signedBy = 'holder'
    else if (who && delegate && eqAddr(who, delegate)) out.signedBy = 'delegate'
    else if (await reader.hasCode(rv, idRv.holder)) {
      if (!reader.eip1271) note('holder-signature-unsupported', `the reviewer's holder ${idRv.holder} is a contract and this verifier declines EIP-1271`)
      else if (await reader.holderSigned(rv, idRv.holder, digest, rec.sig)) out.signedBy = 'holder'
      else note('signer-not-current', `the contract holder ${idRv.holder} does not accept the signature (EIP-1271), and it is not the delegate's`)
    } else note('signer-not-current', `signed by ${who ?? 'no address (not a 65-byte signature)'}: neither the reviewer's current holder ${idRv.holder} nor its current delegate ${delegate ?? '(none)'}`)
    // 7. evidence (ignored, and never shown, when evidenceHash is zero)
    let extra = {}
    if (r.kind === REVIEW_KIND && r.subject !== ZERO32) {
      try {
        if (rec.evidence === undefined) stop('evidence-missing', 'evidenceHash is set and the record carries no evidence')
        if (!isObj(rec.evidence)) stop('evidence-malformed', 'evidence is a JSON object')
        let h
        try { h = jsonHash(rec.evidence) } catch { stop('evidence-malformed', 'evidence has no canonical form') }
        if (h !== r.evidenceHash) stop('evidence-mismatch', 'evidence does not hash to evidenceHash')
        const ev = rec.evidence
        if (ev.kind === 'response') { await responseEvidence(ev, r, rv, re, reader); out.level = 1 }
        else if (ev.kind === 'task') { extra = await taskEvidence(ev, r, rv, re, reader); out.level = 2 }
        else stop('evidence-unknown', 'evidence of a reserved kind is level 0')
      } catch (e) { if (!(e instanceof Problem)) throw e; note(e.code, e.message) }
    }
    // 8. related parties (the agent key of a level-2 mandate counts as an address of the agent)
    const a = [idRv.holder, delegate], b = [idRe.holder, revieweeSigner]
    if (out.level === 2) (extra.agentIsReviewer ? a : b).push(extra.agentKey)
    const A = a.filter(Boolean).map(lc), B = b.filter(Boolean).map(lc)
    if (A.some((x) => B.includes(x))) note('related-parties', 'the reviewer and the reviewee share an address (holder, delegate, signer or agent key)')
    out.counted = r.kind === REVIEW_KIND && out.signedBy !== null && out.level > 0 && !out.problems.includes('related-parties')
  } catch (e) {
    if (!(e instanceof Problem)) throw e
    Object.assign(out, { valid: false, level: 0, signedBy: null, counted: false })
    note(e.code, e.message)
  }
  out.rejected = !out.valid
  return out
}

// §4.2 level 1, steps 1-6
async function responseEvidence(ev, r, rv, re, reader) {
  const rc = ev.receipt
  if (hashOnlyReceiptProblem(rc) || typeof rc.method !== 'string') stop('evidence-malformed', 'level 1 carries a hash-only (v 2) receipt')
  if (!eqAddr(rc.service.container, re.container)) stop('evidence-wrong-party', `the receipt is from ${rc.service.container}, not the reviewee`)
  const prefix = REVIEW_ID_PREFIX + lc(rv.container) + ':'
  if (!rc.id.startsWith(prefix) || rc.id.length === prefix.length) stop('evidence-unbound', `the request id does not begin with ${prefix}`)
  const d = responseDigestFromHashes({ container: re.container, id: rc.id, requestHash: rc.requestHash, ok: rc.ok, bodyHash: rc.bodyHash, ts: rc.ts })
  if (toHex(d) !== r.subject) stop('subject-mismatch', 'subject is not the TAP-13 §5 digest of the receipt')
  if (!(rc.ts <= r.issued && r.issued - rc.ts <= MAX_EVIDENCE_AGE_S)) stop('evidence-time', 'the receipt is later than the review or more than 90 days before it')
  const signer = await reader.signer(re)
  let got = null
  try { got = recoverResponseSignerFromHashes({ container: re.container, id: rc.id, requestHash: rc.requestHash, ok: rc.ok, bodyHash: rc.bodyHash, ts: rc.ts }, rc.sig) } catch { /* high s or malformed */ }
  if (!signer || !got || !eqAddr(got, signer)) stop('evidence-signature', signer ? `the receipt is not signed by the reviewee's current signer ${signer}` : 'the reviewee does not resolve as a TAP-11 service')
}

// §4.3 level 2, steps 1-7, with the #47 types and checks of agent-sig.js and agent-verify.js
async function taskEvidence(ev, r, rv, re, reader) {
  let m, v
  try { m = normalizeMandate(ev.mandate, { wire: true }); v = normalizeTaskVerdict(ev.verdict, { wire: true }) } catch (e) { stop('evidence-malformed', `mandate or verdict: ${e.message}`) }
  const d = ev.deliver
  const deliverForm = isObj(d) && d.v === 1 && isObj(d.service) && isAddress(d.service.container) && typeof d.method === 'string' && METHOD_RE.test(d.method) &&
    (d.params === undefined || isObj(d.params)) && typeof d.id === 'string' && d.id.length >= 1 && d.id.length <= 128 && isU64(d.ts) &&
    d.ok === true && isObj(d.result) && typeof d.sig === 'string' && SIG65_RE.test(d.sig)
  if (!deliverForm || typeof ev.mandateSig !== 'string' || !SIGANY_RE.test(ev.mandateSig) || typeof ev.verdictSig !== 'string' || !SIGANY_RE.test(ev.verdictSig)) stop('evidence-malformed', 'deliver (a full v 1 receipt), mandateSig or verdictSig')
  let principal, agentEp, agentIsReviewer
  if (eqAddr(m.principal, rv.container) && eqAddr(m.agent, re.container)) { principal = rv; agentEp = re; agentIsReviewer = false }
  else if (eqAddr(m.principal, re.container) && eqAddr(m.agent, rv.container)) { principal = re; agentEp = rv; agentIsReviewer = true }
  else stop('evidence-wrong-party', 'the mandate is not between the reviewer and the reviewee')
  const hub = reader.hubOf(principal.chainId)
  const mDigest = mandateDigest(principal.chainId, hub, m)
  const mandateHash = toHex(mDigest)
  if (mandateHash !== r.subject) stop('subject-mismatch', 'subject is not the mandate hash')
  const p0 = phase0Problems(m)
  if (p0.length) stop('evidence-malformed', `the mandate breaks the phase-0 rule: ${p0.map((p) => p.code).join(', ')}`)
  const form = agentMessageProblem(d, 'deliver', agentEp.container)
  if (form) stop('evidence-malformed', `deliver: ${form.message}`)
  const res = d.result
  if (res.mandateHash !== mandateHash || !isHash(res.deliverableHash)) stop('evidence-malformed', 'deliver does not name this mandate, or has no bytes32 deliverableHash')
  if (!(m.notBefore <= d.ts && d.ts <= m.expires && v.issued >= d.ts && r.issued >= v.issued)) stop('evidence-time', 'the delivery is outside the mandate\'s window, the verdict before the delivery, or the review before the verdict')
  if (v.mandateHash !== mandateHash || v.deliverableHash !== res.deliverableHash) stop('verdict-mismatch', 'the verdict is about another mandate or delivery')
  const principalId = await reader.identity(principal)
  const holder = principalId.holder
  const holderSigned = async (digest, sig) => {
    if (SIG65_RE.test(sig)) { try { if (eqAddr(recoverAddress(digest, sig), holder)) return true } catch { /* fall through */ } }
    return reader.eip1271 && (await reader.hasCode(principal, holder)) && reader.holderSigned(principal, holder, digest, sig)
  }
  if (!(await holderSigned(mDigest, ev.mandateSig))) stop('evidence-signature', `the mandate is not signed by the principal's current holder ${holder}`)
  if (!(await holderSigned(taskVerdictDigest(principal.chainId, hub, v), ev.verdictSig))) stop('evidence-signature', `the verdict is not signed by the principal's current holder ${holder}`)
  const signer = await reader.signer(agentEp)
  let got = null
  try { got = recoverResponseSigner({ container: agentEp.container, id: d.id, method: d.method, params: d.params ?? {}, ok: true, body: res, ts: d.ts }, d.sig) } catch { /* high s */ }
  if (!signer || !got || !eqAddr(got, signer)) stop('evidence-signature', signer ? `deliver is not signed by the agent's current signer ${signer}` : 'the agent does not resolve as a TAP-11 service')
  return { agentKey: m.agentKey, agentIsReviewer }
}

// ---- given facts (the draft's vectors) / 给定事实 ----
/**
 * @experimental Verify one record against given chain facts, as the draft's test vectors state them:
 *   facts: { holders: { [endpointId]: address }, signers: { [endpointId]: address }, contracts: [address] }
 *   (signers: an absent entry is a container that does not resolve under TAP-11 §2; contracts: holders with code).
 * This verifier declines EIP-1271 (TAP-11 §4.4 allows it): a contract holder's record is holder-signature-unsupported.
 * Options: now (Unix seconds, required), hub (default: each chain's hub in chains.js).
 * Returns { valid, rejected, hash, level, signedBy, counted, problems, details, textWithheld, reviewer, reviewee }.
 * 按给定的链上事实核验一条记录（与草稿向量相同的输入）；不支持 EIP-1271。
 */
export function checkReview(record, facts, { now, hub } = {}) {
  if (!Number.isSafeInteger(now)) throw new TapeAPIError('INVALID_ARGUMENT', 'checkReview needs now (Unix seconds)')
  if (!isObj(facts)) throw new TapeAPIError('INVALID_ARGUMENT', 'facts must be { holders, signers, contracts }')
  const get = (map, ep) => { const k = epKey(ep); for (const [x, a] of Object.entries(map ?? {})) if (lc(x) === k) return a; return null }
  const reader = {
    eip1271: false,
    hubOf: (c) => hub ?? chainById(c)?.hub,
    identity: async (ep) => { const h = get(facts.holders, ep); return h ? { holder: checksumAddress(h) } : { problem: { code: 'no-such-token', message: `no holder of ${ep.container} on chain ${ep.chainId} in the facts` } } },
    signer: async (ep) => { const s = get(facts.signers, ep); return s ? checksumAddress(s) : null },
    hasCode: async (_ep, a) => (facts.contracts ?? []).some((c) => eqAddr(c, a)),
    holderSigned: async () => false,
  }
  return checkWith(record, reader, now)
}

// ---- §7 and §9 ----
/**
 * @experimental A summary of verified records (§7 then §9). `items`: [{ record, result }] with `result` from verifyReview
 * or checkReview. Only accepted records (signed by the holder or the delegate) take part in §7: one with the problem
 * signer-not-current or holder-signature-unsupported is never current, never corrects or withdraws, and never causes a
 * conflict. Copies of one review hash are one record (the counted copy, else the highest level, else one with text).
 * Each pair (reviewer, reviewee) counts at most once; level 1 and level 2 are separate; nothing is weighted by an amount.
 * Options: reviewee (endpoint ID: only records about it), holderOf(endpointId) -> the reviewer's current holder (default:
 * result.reviewer.holder). Returns { level1, level2, uncountedPairs, conflicts }, each level { reviewers, holders,
 * scores: [n1..n5], issued: [first, last] | null }. A summary is not proof of quality, honesty or availability.
 * 汇总（§7 后 §9）：只有被认可的记录参与更正、撤回与冲突；每对只算一条；1、2 级分开；不按金额加权；汇总不是质量证明。
 */
export function summarizeReviews(items, { reviewee, holderOf } = {}) {
  if (!Array.isArray(items)) throw new TapeAPIError('INVALID_ARGUMENT', 'summarizeReviews takes [{ record, result }]')
  const holder = holderOf ?? ((ep, x) => x.result.reviewer?.holder)
  const accepted = items.filter((x) => x?.result?.valid && x.result.signedBy !== null && (!reviewee || x.record.review.reviewee === reviewee))
  const byKey = new Map()
  const rank = (y) => (y.result.counted ? 8 : 0) + y.result.level * 2 + (y.record.text !== undefined ? 1 : 0)
  for (const x of accepted) {
    const r = x.record.review, k = `${r.reviewer}|${r.reviewee}|${r.subject}`
    if (!byKey.has(k)) byKey.set(k, [])
    const list = byKey.get(k), i = list.findIndex((y) => y.result.hash === x.result.hash)
    if (i < 0) list.push(x); else if (rank(x) > rank(list[i])) list[i] = x
  }
  let conflicts = 0
  const current = []
  for (const [, list] of byKey) {
    const top = Math.max(...list.map((x) => x.record.review.issued))
    const best = list.filter((x) => x.record.review.issued === top)
    if (best.length > 1) { conflicts++; continue }
    if (best[0].record.review.kind === REVIEW_KIND) current.push(best[0])
  }
  const pairs = new Map()
  for (const x of current) {
    const r = x.record.review, k = `${r.reviewer}|${r.reviewee}`
    if (!pairs.has(k)) pairs.set(k, [])
    pairs.get(k).push(x)
  }
  const levels = { 1: [], 2: [] }
  let uncountedPairs = 0
  for (const [, list] of pairs) {
    const c = list.filter((x) => x.result.counted)
    if (!c.length) { uncountedPairs++; continue }
    c.sort((p, q) => (q.record.review.issued - p.record.review.issued) || (q.result.hash > p.result.hash ? 1 : -1))
    levels[c[0].result.level].push(c[0])
  }
  const stats = (list) => ({
    reviewers: new Set(list.map((x) => x.record.review.reviewer)).size,
    holders: new Set(list.map((x) => lc(holder(x.record.review.reviewer, x)))).size,
    scores: [1, 2, 3, 4, 5].map((s) => list.filter((x) => x.record.review.score === s).length),
    issued: list.length ? [Math.min(...list.map((x) => x.record.review.issued)), Math.max(...list.map((x) => x.record.review.issued))] : null,
  })
  return { level1: stats(levels[1]), level2: stats(levels[2]), uncountedPairs, conflicts }
}

/** @experimental The text of a record for display (§10): plain text, invisible code points removed; null when none. */
export function reviewTextForDisplay(record) {
  const t = record?.text
  if (!isObj(t) || typeof t.body !== 'string') return null
  return { body: plainText(t.body, MAX_REVIEW_TEXT_DISPLAY), tags: Array.isArray(t.tags) ? t.tags.filter((w) => typeof w === 'string').map((w) => plainText(w, 64)) : [], statedBy: 'the reviewer' }
}

// ---- carriages (§8) ----
/**
 * @experimental The bytes of a reviewer's site file (§8.1), compact JSON: { "tapeapi-reviews": "1", "reviews": [...] }.
 * Every record must name the same reviewer (a reader ignores the others); at most 262,144 bytes.
 * 评价方站点文件的字节（紧凑 JSON）；所有记录须是同一评价方；不超过 262,144 字节。
 */
export function reviewFileBytes(records) {
  if (!Array.isArray(records)) throw new TapeAPIError('INVALID_ARGUMENT', 'reviewFileBytes takes an array of records')
  const reviewers = new Set(records.map((x) => x?.review?.reviewer))
  if (reviewers.size > 1) throw new TapeAPIError('INVALID_ARGUMENT', 'every record of a site file names the same reviewer: the one whose site holds it')
  for (const x of records) normalizeReview(x?.review)
  const bytes = new TextEncoder().encode(JSON.stringify({ 'tapeapi-reviews': REVIEWS_FORMAT, reviews: records }))
  if (bytes.length > REVIEWS_LIMIT) throw new TapeAPIError('INVALID_ARGUMENT', `the file is ${bytes.length} bytes, over ${REVIEWS_LIMIT}`)
  return bytes
}
/**
 * @experimental The content of a public TapeSend message carrying a record (§8.2): { v: 1, kind: "message", body,
 * review }. `body` states the review in words (default: a short sentence). Refuses a record whose public payload would
 * exceed 16,000 bytes: send a copy without `evidence` or `text` and publish the whole record by another carriage.
 * Send it from the reviewer's container to the reviewee, public (tapesend.encodePublic), ideally with ref = review hash.
 * 携带记录的公开 TapeSend 内容；载荷超过 16,000 字节即拒绝（改发不带 evidence 或 text 的副本，完整记录走别的承载）。
 */
export function reviewMessageContent(record, { body } = {}) {
  const r = normalizeReview(record?.review)
  const text = body ?? (r.kind === REVIEW_KIND ? `A review (score ${r.score} of 5) of ${parseEndpoint(r.reviewee).container} by ${parseEndpoint(r.reviewer).container}.` : `A withdrawal of a review of ${parseEndpoint(r.reviewee).container}.`)
  if (typeof text !== 'string') throw new TapeAPIError('INVALID_ARGUMENT', 'body must be a string')
  const content = new TextEncoder().encode(JSON.stringify({ v: 1, kind: 'message', body: text, review: record }))
  // a public payload is a 4-byte header and the content (TAP-10 §15.2) / 公开载荷 = 4 字节头 + 内容
  let size = null
  try { size = encodePublic(content).length } catch { /* over the limit */ }
  if (size === null || size > MAX_PAYLOAD) throw new TapeAPIError('INVALID_ARGUMENT', `the public payload would be over ${MAX_PAYLOAD} bytes: send the record without evidence or without text, and publish the whole record in the site file`)
  return content
}

// ---- reading the chain / 读链 ----
/**
 * @experimental Review checks bound to one client (rpcUrls of at least two operators: every read is strict).
 *   clock     () => Unix seconds (default: the system clock)
 *   eip1271   false: decline EIP-1271 (a contract holder's record is holder-signature-unsupported). Default true.
 *   kits      { [chainId]: createAgentKit(...) }: the agent kit used on that chain (default: createAgentKit(api) on the
 *             client's chain, createAgentKit(api.forChain(chainId)) on another)
 * Returns { verifyReview, verifyReviews, readReviewFile, readReviewMessages, chainId }.
 * 绑定一个客户端的评价核验（至少两家运营方的节点，严格读取）。
 */
export function createReviewKit(api, opts = {}) {
  if (!api || typeof api !== 'object' || !api.chain || !api.addresses) throw new TapeAPIError('INVALID_ARGUMENT', 'createReviewKit takes a createTapeAPI() client')
  if (opts.clock !== undefined && typeof opts.clock !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', 'clock must be a function returning Unix seconds')
  if (opts.eip1271 !== undefined && typeof opts.eip1271 !== 'boolean') throw new TapeAPIError('INVALID_ARGUMENT', 'eip1271 must be a boolean')
  const chainId = Number(api.chainId)
  const clock = opts.clock ?? (() => Math.floor(Date.now() / 1000))
  const eip1271 = opts.eip1271 ?? true
  const apiFor = (c) => (c === chainId ? api : api.forChain(c))
  const agentKits = new Map(), payKits = new Map()
  for (const [c, k] of Object.entries(opts.kits ?? {})) {
    if (!agentKitInternals(k)) throw new TapeAPIError('INVALID_ARGUMENT', 'kits holds createAgentKit() results')
    agentKits.set(Number(c), k)
  }
  const agentKit = (c) => { if (!agentKits.has(c)) agentKits.set(c, createAgentKit(apiFor(c), { clock })); return agentKits.get(c) }
  const payKit = (c) => { if (!payKits.has(c)) payKits.set(c, createPaymentKit(apiFor(c))); return payKits.get(c) }

  // A session: one pinned block per chain for every read it makes (TAP-10 §5.3), and the TAP-11 resolutions it made.
  // 一个会话：每条链一个钉块，以及本会话的 TAP-11 解析。
  function session() {
    const ctxs = new Map(), signers = new Map()
    const I = (c) => agentKitInternals(agentKit(c))
    const ctx = (c) => { if (!ctxs.has(c)) ctxs.set(c, I(c).context()); return ctxs.get(c) }
    return {
      ctx, I,
      reader: {
        eip1271,
        hubOf: (c) => agentKit(c).hub,
        identity: async (ep) => { const r = await I(ep.chainId).identityOf(ep.container, ctx(ep.chainId)); return r.problem ? { problem: r.problem } : { holder: r.identity.holder, name: r.identity.name } },
        signer: (ep) => {
          const k = epKey(ep)
          if (!signers.has(k)) {
            const p = (async () => {
              try { return checksumAddress((await I(ep.chainId).serviceOf(ep.container)).manifest.signer) } catch (e) { if (I(ep.chainId).partyCannotResolve(e)) return null; throw e }
            })()
            signers.set(k, p)
          }
          return signers.get(k)
        },
        hasCode: (ep, a) => I(ep.chainId).hasCode(a, ctx(ep.chainId)),
        holderSigned: (ep, holder, digest, sig) => I(ep.chainId).holderSigned(holder, digest, sig, ctx(ep.chainId)),
      },
    }
  }
  const nowOf = (o) => { const n = o?.now ?? clock(); if (!Number.isSafeInteger(n)) throw new TapeAPIError('INVALID_ARGUMENT', 'now must be Unix seconds'); return n }

  /**
   * Verify one record (§6) at one pinned block per chain. `now` (Unix seconds) defaults to the clock. Returns { valid,
   * rejected, hash, level, signedBy, counted, problems, details, textWithheld, reviewer, reviewee } (reviewer and
   * reviewee with their current holder, delegate or signer, and on-chain name). A rejected record MUST NOT be shown.
   */
  async function verifyReview(record, o = {}) { return checkWith(record, session().reader, nowOf(o)) }
  /** Verify several records in one session (one pinned block per chain for all). Returns [{ record, result }]. */
  async function verifyReviews(records, o = {}) {
    if (!Array.isArray(records)) throw new TapeAPIError('INVALID_ARGUMENT', 'verifyReviews takes an array of records')
    const s = session(), now = nowOf(o)
    const out = []
    for (const record of records) out.push({ record, result: await checkWith(record, s.reader, now) })
    return out
  }
  const endpointOf = (x, what) => {
    if (isAddress(x)) return { chainId, container: checksumAddress(x) }
    if (typeof x === 'string') { try { return parseEndpoint(x) } catch { /* below */ } }
    if (isObj(x) && isAddress(x.container) && Number.isSafeInteger(x.chainId)) return { chainId: x.chainId, container: checksumAddress(x.container) }
    throw new TapeAPIError('INVALID_ARGUMENT', `${what}: a container address (this client's chain), an endpoint ID or { chainId, container }`)
  }

  /**
   * The reviewer's site file (§8.1), read at one pinned block of its chain and verified record by record in the same
   * session. A declared size over 262,144 bytes is invalid and the file is not read. A record naming another reviewer is
   * ignored. Options: reviewee (only records about it are verified; the rest are `skipped`), now.
   * Returns { status: 'none' | 'invalid' | 'ok', reason?, items: [{ record, result, carriage }], ignored, skipped }.
   * 读评价方站点文件（一个钉块）并在同一会话里逐条核验；声明大小超限即无效且不读；记录的评价方不是本容器即忽略。
   */
  async function readReviewFile(reviewer, o = {}) {
    const ep = endpointOf(reviewer, 'reviewer')
    if (!isTapeOutChain(ep.chainId)) throw new TapeAPIError('INVALID_ARGUMENT', `chain ${ep.chainId} is not a TapeOut chain`)
    const only = o.reviewee === undefined ? null : epKey(endpointOf(o.reviewee, 'reviewee'))
    const now = nowOf(o)
    const s = session()
    const I = s.I(ep.chainId), ctx = s.ctx(ep.chainId)
    const base = { items: [], ignored: 0, skipped: 0 }
    const changed = await I.storeChanged(ctx)
    if (changed) return { status: 'invalid', reason: changed, ...base }
    const file = await I.siteFileAt(ep.container, REVIEWS_KEY, REVIEWS_LIMIT, ctx)
    if (file.status !== 'ok') return { status: file.status === 'none' ? 'none' : 'invalid', ...(file.reason ? { reason: file.reason } : {}), ...base }
    let f
    try { f = safeParseJSON(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes)) } catch (e) { return { status: 'invalid', reason: `${REVIEWS_KEY}: ${e.message}`, ...base } }
    if (!isObj(f) || f['tapeapi-reviews'] !== REVIEWS_FORMAT || !Array.isArray(f.reviews)) return { status: 'invalid', reason: `${REVIEWS_KEY}: not a format ${REVIEWS_FORMAT} file with a reviews array`, ...base }
    const own = epKey(ep)
    for (const record of f.reviews) {
      const named = record?.review?.reviewer
      if (typeof named === 'string' && named !== own) { base.ignored++; continue }
      if (only && record?.review?.reviewee !== only) { base.skipped++; continue }
      base.items.push({ record, result: await checkWith(record, s.reader, now), carriage: { kind: 'site-file', chainId: ep.chainId, container: ep.container } })
    }
    return { status: 'ok', ...base }
  }

  /**
   * Public TapeSend messages to `reviewee` that carry a record (§8.2), from the inbox of the reviewee's endpoint in the
   * hub of chain `chainId` (default: the reviewee's chain; a reviewer on another chain sends through its own chain's
   * hub). Options: start (inbox index, default 0), limit (default 200), from (only messages from this reviewer container).
   * A message is read only when it is final (not pending, TAP-10 §17), its payload is public, its content a valid
   * TAP-10 §16 message with a `review` member whose reviewer is the sending container on this chain; the record is
   * verified with the message's block time in place of `now` for §6 step 4. Each item carries the sending wallet
   * (TAP-10 §18.5) and whether it differs from the reviewer's current holder (the circuit changed hands since).
   * Returns { count, items: [{ record, result, carriage }], skipped: [{ inboxIndex, why }] }.
   * 读收件箱里携带记录的公开 TapeSend 消息：只读已终结、公开、发件容器即评价方的；以区块时间代替 now；附发送钱包及其是否与当前持有人不同。
   */
  async function readReviewMessages(reviewee, o = {}) {
    const re = endpointOf(reviewee, 'reviewee')
    const hubChain = o.chainId ?? re.chainId
    if (!isTapeOutChain(hubChain) || !isTapeOutChain(re.chainId)) throw new TapeAPIError('INVALID_ARGUMENT', 'not a TapeOut chain')
    const start = o.start ?? 0, limit = o.limit ?? INBOX_PAGE_MAX
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new TapeAPIError('INVALID_ARGUMENT', 'start and limit are whole numbers (limit at least 1)')
    if (o.from !== undefined && !isAddress(o.from)) throw new TapeAPIError('INVALID_ARGUMENT', 'from is a container address')
    const P = paymentKitInternals(payKit(hubChain))
    const to = toHex(tapesendEndpoint(epKey(re)))
    const count = Number(await P.inboxCount(to))
    const items = [], skipped = []
    const s = session()
    for (let i = start; i < Math.min(count, start + limit); i += INBOX_PAGE_MAX) {
      const page = await P.inboxPage(to, i, Math.min(INBOX_PAGE_MAX, Math.min(count, start + limit) - i))
      for (const entry of page) {
        if (o.from && !eqAddr(entry.from, o.from)) continue
        const skip = (why) => skipped.push({ inboxIndex: entry.index, why })
        if (await P.isPending(entry.blockNumber)) { skip('pending'); continue }
        const sent = await P.sentOf(to, entry)
        if (!sent) { skip('unavailable'); continue }
        let content
        try { content = openPayload({ payload: sent.payload, to, from: toHex(tapesendEndpoint(entry.from, hubChain)), hub: P.hub, ref: sent.ref, chainId: hubChain }).content } catch (e) {
          if (e instanceof TapeAPIError && e.code === 'TAPESEND_INVALID') { skip(e.data?.reason === 'not-for-key' ? 'sealed' : (e.data?.reason ?? 'damaged')); continue }
          throw e
        }
        if (decodeContent(content).status !== 'ok') { skip('not-a-message'); continue }
        let c
        try { c = safeParseJSON(new TextDecoder('utf-8', { fatal: true }).decode(content)) } catch { skip('not-a-message'); continue }
        if (c.review === undefined) continue   // an ordinary message / 普通消息
        const record = c.review
        if (!isObj(record) || record.review?.reviewer !== endpointId(hubChain, entry.from)) { skip('not-from-the-reviewer'); continue }
        const result = await checkWith(record, s.reader, entry.timestamp)
        const w = await P.sendingWallet(to, entry, sent)
        const wallet = w.wallet ?? null
        items.push({
          record, result,
          carriage: {
            kind: 'tapesend', chainId: hubChain, inboxIndex: entry.index, blockNumber: entry.blockNumber, time: entry.timestamp, ref: sent.ref,
            body: typeof c.body === 'string' ? plainText(c.body, MAX_REVIEW_TEXT_DISPLAY) : '',
            sendingWallet: wallet, ...(w.indirect ? { indirect: true } : {}), ...(w.unavailable ? { walletUnavailable: w.unavailable } : {}),
            walletDiffersFromHolder: wallet && result.reviewer?.holder ? !eqAddr(wallet, result.reviewer.holder) : null,
          },
        })
      }
    }
    return { count, items, skipped }
  }

  return { verifyReview, verifyReviews, readReviewFile, readReviewMessages, chainId }
}
