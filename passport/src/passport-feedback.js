// @tapeapi/passport/feedback (@experimental, OPTIONAL, CONDITIONAL): §10 of the Agent Passport draft, reviews written as
// ERC-8004 feedback and their summary. §10 applies only to tools that implement the review draft #54 at commit
// 703b2a91 (TAPs pull request #54, NOT merged): this subpath is not loaded by the main entry, and nobody has written
// such feedback yet. The #54 verdict of each record (counted, level) is an INPUT here, as in the reference
// (snapshot.review54 / opts.review54): this package does not implement #54's verification.
// §10（可选、有条件）：评价写成 ERC-8004 反馈及其汇总。只适用于实现 #54（提交 703b2a91，未合并）的工具；主入口不加载本子路径，
// 也还没有人写过这类反馈。每条记录的 #54 判定（是否计入、级别）在这里是输入（与参考实现相同）：本包不实现 #54 的核验。
import { keccak_256 } from '@noble/hashes/sha3'
import { sha256 } from '@noble/hashes/sha2'
import { concatBytes, utf8ToBytes } from '@tapeapi/sdk/abi'
import { addr, hx, unhex, strictJson, canonicalJson, snapshotReads, Unavailable, NoCanonicalForm, PASSPORT_CONFIG, internal } from './passport-core.js'

/** What this subpath follows: #54 at 703b2a9, unmerged. / 本子路径依据 #54@703b2a9，未合并。 */
export const FEEDBACK_DRAFT = Object.freeze({ pr: 54, head: '703b2a91edf7545b3179a08b8041b49190fd4a0a', merged: false, section: '§10 of TAPs #83 at cae25e6', status: 'experimental, conditional' })
const HUB = '0xe61a9c7213a6aa616c246a2b569e555b417b25ee'
export const REVIEW_TYPEHASH = '0xb9c66a727a6fba79714dcc4f0dfdbaf876840b1a35de576ed8fe3eef1f1b9a0b'
const DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
const TAG2 = { 'level-1': 1, 'level-2': 2 }
const keccak = (b) => keccak_256(b)
const u256 = (v) => { const o = new Uint8Array(32); let x = BigInt(v); for (let i = 31; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n } return o }
const b32 = (s) => { if (typeof s !== 'string' || !/^0x[0-9a-f]{64}$/.test(s)) throw new Error('bytes32'); return unhex(s) }
const endpointId = (chainId, container) => hx(concatBytes(new Uint8Array(4), u256(chainId).subarray(24), unhex(addr(container))))

/** #54 §2.1 review hash of a review object (EIP-712 digest in the TapeAPI domain). / #54 的评价哈希。 */
export function reviewHash(r) {
  const reviewer = b32(r.reviewer); const chainId = BigInt(hx(reviewer.subarray(4, 12)))
  for (const k of ['kind', 'score', 'issued']) if (typeof r[k] !== 'number') throw new Error(k)
  const dom = keccak(concatBytes(keccak(utf8ToBytes(DOMAIN_TYPE)), keccak(utf8ToBytes('TapeAPI')), keccak(utf8ToBytes('1')), u256(chainId), new Uint8Array(12), unhex(HUB)))
  const sh = keccak(concatBytes(unhex(REVIEW_TYPEHASH), reviewer, b32(r.reviewee), u256(r.kind), u256(r.score), b32(r.subject), b32(r.evidenceHash), b32(r.textHash), u256(r.issued)))
  return hx(keccak(concatBytes(Uint8Array.of(0x19, 0x01), dom, sh)))
}
export const reviewFileKey = (h) => `.well-known/tapeapi-reviews/${h}.json`
/**
 * §10.2: the arguments of giveFeedback for a #54 record, and the file to store first. Building them sends nothing:
 * the reviewer's holder submits the transaction from their own wallet (and pays for it).
 * §10.2：giveFeedback 的参数与要先存的文件。构造它们不发送任何东西：由评价方的持有人用自己的钱包提交（费用自付）。
 */
export function feedbackParams(record, agentId, reviewerName, gatewayDomain, level) {
  const text = canonicalJson(record); const rh = reviewHash(record.review); const label = reviewerName.slice(0, -'.tape'.length).replace(/\./g, '-')
  return { agentId, value: record.review.score, valueDecimals: 0, tag1: 'tap-review', tag2: `level-${level}`, endpoint: '', feedbackURI: `https://${label}.${gatewayDomain}/${reviewFileKey(rh)}`, feedbackHash: hx(keccak(utf8ToBytes(text))), fileKey: reviewFileKey(rh), fileBytes: text }
}

const { call: readCall, decAddress, decDyn } = internal
const asBytes = async (rd, key) => { const r = await readCall(rd, key); return r instanceof Uint8Array ? r : null }
const word = (b, i) => b.subarray(32 * i, 32 * i + 32)
const decUint = (b, i) => BigInt(hx(word(b, i)))

/**
 * §10.3 (F-0 to F-10) for a CONFIRMED passport `res`, over `reads` (snapshotReads(snap) for the vectors, or live reads
 * at the same pinned block). opts: { config, clientAddresses (F-0, required), maxEntries?, review54 (the #54 verdict per
 * review hash: { counted, level }), feedback? (the NewFeedback list; else read as logs.NewFeedback(agentId)) }.
 * Never a weighted or averaged score: level 1 and level 2 apart, with reviewers, holders and score counts.
 * §10.3：对 CONFIRMED 的护照计算汇总。绝不给加权或平均分：一级与二级分开，各给评价方数、持有人数与各分数的条数。
 */
export async function summariseFeedback(reads, res, opts = {}) {
  if (res.state !== 'CONFIRMED') return { computed: false, why: 'passport not confirmed', draft: FEEDBACK_DRAFT }
  const cfg = opts.config ?? PASSPORT_CONFIG; const rd = reads; const chain = cfg.chainId; const agentId = BigInt(res.agentId)
  const me = endpointId(chain, res.container); const epoch = res.holderEpoch; const verdicts = opts.review54 || {}
  const named = new Set((opts.clientAddresses || []).map(addr))
  if (!named.size) return { computed: false, why: 'no-client-set', draft: FEEDBACK_DRAFT }
  const cap = opts.maxEntries ?? null
  let items
  try {
    const impl = '0x' + String(await rd.get('implSlot:' + addr(cfg.reputationRegistry))).slice(-40).toLowerCase()
    if (!cfg.reputationImplementations.map(addr).includes(impl)) return { computed: false, why: 'registry-changed', draft: FEEDBACK_DRAFT }
    items = opts.feedback ?? await rd.get(`logs.NewFeedback(${agentId})`)
    if (items && typeof items === 'object' && !Array.isArray(items) && items.unavailable) return { computed: false, why: 'unavailable', draft: FEEDBACK_DRAFT }
  } catch (e) { if (e instanceof Unavailable) return { computed: false, why: e.reason, draft: FEEDBACK_DRAFT }; throw e }
  const excluded = []; const candidates = []; let outside = 0, examined = 0
  const uriRe = /^(?:https:\/\/([0-9-]+)\.[A-Za-z0-9.-]+|tape:\/\/([0-9.]+\.tape))\/(\.well-known\/tapeapi-reviews\/(0x[0-9a-f]{64})\.json)$/
  for (const fb of items) {
    const tag = `${fb.client}#${fb.index}`
    if (fb.tag1 !== 'tap-review') continue                              // F-1
    if (!named.has(addr(fb.client))) { outside++; continue }             // F-0: counted, never fetched / 只计数，不读取
    examined++
    if (cap !== null && examined > cap) return { computed: false, why: 'summary-truncated', draft: FEEDBACK_DRAFT }
    const out = (reason) => excluded.push({ feedback: tag, reason })
    if (fb.revoked) { out('revoked'); continue }                        // F-8
    if (!(fb.tag2 in TAG2)) { out('bad-tag2'); continue }               // F-2
    const m = uriRe.exec(fb.feedbackURI); if (!m) { out('bad-uri'); continue }
    const [, label, name, key, fh] = m
    try {
      const nm = /^([1-9][0-9]*)[-.](0|[1-9][0-9]*)(?:\.tape)?$/.exec(label ?? name); if (!nm) { out('bad-uri'); continue }
      const rTid = BigInt(nm[1]), rNum = Number(nm[2])
      let r = await asBytes(rd, `${addr(cfg.factory)}.cpuAt(${rNum})`); if (!r) { out('bad-uri'); continue }
      const rProc = decAddress(r)
      const container = decAddress(await asBytes(rd, `${addr(cfg.opener)}.accountOf(${rProc},${rTid})`))
      r = await asBytes(rd, `${rProc}.ownerOf(${rTid})`); if (!r) { out('bad-uri'); continue }
      const rHolder = decAddress(r); const s = addr(cfg.siteRegistry)
      const info = await asBytes(rd, `${s}.fileInfo(${container},${key})`)
      if (decUint(info, 4) === 0n) { out('file-missing'); continue }   // F-3
      const data = decDyn(await asBytes(rd, `${s}.read(${container},${key})`), 0)
      if (BigInt(data.length) !== decUint(info, 0) || hx(sha256(data)) !== hx(word(info, 2))) { out('file-incomplete'); continue }
      if (hx(keccak(data)) !== fb.feedbackHash) { out('hash-mismatch'); continue }
      let rec; try { rec = strictJson(data) } catch (e) { if (e instanceof SyntaxError || e instanceof NoCanonicalForm || e instanceof TypeError) { out('not-canonical'); continue } throw e }
      if (hx(utf8ToBytes(canonicalJson(rec))) !== hx(data)) { out('not-canonical'); continue }
      const rv = rec && typeof rec === 'object' ? rec.review : null
      if (!rv || typeof rv !== 'object' || Array.isArray(rv)) { out('not-a-review'); continue }
      const rh = reviewHash(rv)
      if (rh !== fh) { out('review-hash-mismatch'); continue }
      if (rv.reviewer !== endpointId(chain, container)) { out('uri-not-reviewer'); continue }
      if (rv.reviewee !== me) { out('wrong-reviewee'); continue }       // F-4
      if (rv.kind !== 1) { out('withdrawal'); continue }                // F-8
      if (fb.value !== rv.score || fb.valueDecimals !== 0) { out('value-mismatch'); continue }   // F-10
      const v = verdicts[rh]; if (!v || !v.counted) { out('not-counted'); continue }             // F-5
      if (v.level !== TAG2[fb.tag2]) { out('level-mismatch'); continue }
      if (addr(fb.client) !== rHolder) { out('client-not-reviewer-holder'); continue }           // F-6
      if (epoch === null) { out('epoch-unknown'); continue }                                     // F-7
      // a record whose block is not a whole number cannot be placed in the epoch: never counted (FIXED R30-P4: NaN < n
      // is false, so it was) / 块号不是整数的记录无法放进持有人纪元：绝不计入（原先 NaN < n 为假，会被计入）
      const at = Number.isSafeInteger(fb.block) ? fb.block : typeof fb.block === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(fb.block) ? Number(fb.block) : NaN
      if (!Number.isSafeInteger(at)) { out('epoch-unknown'); continue }
      if (at < epoch.startBlock) { out('earlier-holder'); continue }
      candidates.push({ reviewer: container, holder: rHolder, level: v.level, score: rv.score, issued: rv.issued, reviewHash: rh, feedback: tag })
    } catch (e) { if (e instanceof Unavailable) { out('unavailable:' + e.reason); continue } throw e }
  }
  const best = new Map()                                                  // F-9
  for (const c of candidates) { const b = best.get(c.reviewer); if (!b || c.issued > b.issued || (c.issued === b.issued && c.reviewHash > b.reviewHash)) best.set(c.reviewer, c) }
  const summary = {}
  for (const lvl of [1, 2]) {
    const sel = [...best.values()].filter((c) => c.level === lvl)
    summary[`level-${lvl}`] = { reviewers: new Set(sel.map((c) => c.reviewer)).size, holders: new Set(sel.map((c) => c.holder)).size, scores: Object.fromEntries([1, 2, 3, 4, 5].map((s) => [String(s), sel.filter((c) => c.score === s).length])) }
  }
  const clients = [...new Set([...best.values()].map((c) => c.holder))].sort()
  return {
    computed: true, counted: [...best.values()].map((c) => c.feedback).sort(), excluded, summary, outsideClientSet: outside,
    earlierHolders: excluded.filter((x) => x.reason === 'earlier-holder').length, getSummaryClientAddresses: clients.length ? clients : null,
    clientAddresses: [...named].sort(), draft: FEEDBACK_DRAFT,
  }
}

/** §10 over a recorded snapshot (the vectors' form): snapshot.summary and snapshot.review54 as the reference reads them. */
export function summariseFeedbackFromSnapshot(snap, res) {
  return summariseFeedback(snapshotReads(snap), res, { config: snap.config, clientAddresses: snap.summary?.clientAddresses, maxEntries: snap.summary?.maxEntries ?? null, review54: snap.review54 })
}
