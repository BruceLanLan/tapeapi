// Evidence-backed reviews (@experimental, draft TAPs #54): the SDK reproduces every case and every summary of the draft's
// test vectors (spec/vectors/tap-draft-container-reviews.json, a byte-for-byte copy of the draft's reviews.json), through
// the public subpath @tapeapi/sdk/review (the rules here are the SDK's, in review-verify.js, not the draft's prototype).
// 评价记录（实验，草稿 TAPs #54）：SDK 经公开子路径复现草稿向量的全部用例与汇总；这里跑的是 SDK 自己的规则，不是草稿原型。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as R from '@tapeapi/sdk/review'
import { toHex } from '../src/abi.js'
import * as sig from '../src/sig.js'

const V = JSON.parse(readFileSync(new URL('../../spec/vectors/tap-draft-container-reviews.json', import.meta.url), 'utf8'))
const factsFor = (c) => ({ holders: { ...V.facts.holders, ...(c.facts?.holders ?? {}) }, signers: { ...V.facts.signers, ...(c.facts?.signers ?? {}) }, contracts: V.facts.contracts })
const resultOf = (c) => R.checkReview(c.record, factsFor(c), { now: V.now })

test('the vectors are the draft\'s: 59 cases (10 counted, 14 rejected) and 6 summaries, at every level', () => {
  assert.equal(V.cases.length, 59)
  assert.equal(V.cases.filter((c) => c.expect.counted).length, 10)
  assert.equal(V.cases.filter((c) => !c.expect.valid).length, 14)
  assert.equal(V.summaries.scenarios.length, 6)
  for (const l of [0, 1, 2]) assert.ok(V.cases.some((c) => c.expect.valid && c.expect.level === l), `level ${l}`)
})

test('constants: the type string and hash, the domains of chains 56, 8453 and 196 (56 equals TAP-11\'s), the id prefix and the limits', () => {
  assert.equal(R.REVIEW_TYPE, V.constants.REVIEW_TYPE)
  assert.equal(toHex(R.REVIEW_TYPEHASH), V.constants.REVIEW_TYPEHASH)
  assert.equal(toHex(R.REVIEW_TYPEHASH), '0xb9c66a727a6fba79714dcc4f0dfdbaf876840b1a35de576ed8fe3eef1f1b9a0b', 'the type hash the draft prints')
  for (const [c, d] of Object.entries(V.constants.domainSeparator)) assert.equal(toHex(sig.domainSeparator(sig.delegationDomain(Number(c), V.constants.hub))), d, `chain ${c}`)
  assert.equal(V.constants.domainSeparator['56'], '0xa73ee348b5672f12dbc174f66a7d162c69e0d64befdba88475d9d7e3c0fd3ac7')
  assert.equal(R.REVIEW_ID_PREFIX, V.constants.ID_PREFIX)
  assert.equal(R.MAX_EVIDENCE_AGE_S, V.constants.MAX_EVIDENCE_AGE_S)
  assert.equal(R.ISSUED_SKEW_S, V.constants.ISSUED_SKEW_S)
  assert.equal(R.REVIEWS_LIMIT, 262_144)
})

test('every case: valid, level, signedBy, counted, problems, textWithheld and the review hash, as the draft expects', async () => {
  for (const c of V.cases) {
    const got = await resultOf(c)
    for (const k of Object.keys(c.expect)) assert.deepEqual(got[k], c.expect[k], `${c.name}: ${k}`)
    assert.equal(got.rejected, !c.expect.valid, c.name)
    // every problem the SDK reports is a name of the draft / SDK 报的每个问题都是草稿里的名字
    for (const p of got.problems) assert.ok(R.REVIEW_PROBLEMS.includes(p), `${c.name}: ${p}`)
    assert.equal(got.details.length, got.problems.length)
  }
})

test('every summary of §7 and §9 (strangers cannot withdraw or conflict; the delegate withdraws; correction; a conflict between accepted records)', async () => {
  for (const sc of V.summaries.scenarios) {
    const records = sc.cases ? [...V.cases.filter((c) => sc.cases.includes(c.name)).map((c) => c.record), ...sc.extra] : sc.records
    if (sc.cases) assert.equal(records.length, sc.cases.length + sc.extra.length, sc.name)
    const items = []
    for (const record of records) items.push({ record, result: await R.checkReview(record, V.facts, { now: V.now }) })
    assert.deepEqual(R.summarizeReviews(items, { holderOf: (e) => V.facts.holders[e] }), sc.expect, sc.name)
    assert.deepEqual(R.summarizeReviews(items, { holderOf: (e) => V.facts.holders[e], reviewee: V.summaries.reviewee }), sc.expect, `${sc.name}: filtered to the reviewee`)
  }
})

test('signing with the SDK gives the vectors\' signatures byte for byte (RFC 6979), for the holder and the delegate', () => {
  const keyOf = Object.fromEntries(Object.values(V.keys).map((k) => [k.address.toLowerCase(), k.privateKey]))
  let n = 0
  for (const c of V.cases) {
    if (!c.expect.signedBy) continue
    const f = factsFor(c)
    const who = c.expect.signedBy === 'holder' ? f.holders[c.record.review.reviewer] : f.signers[c.record.review.reviewer]
    assert.equal(R.signReview(c.record.review, keyOf[who.toLowerCase()]), c.record.sig, c.name)
    assert.equal(R.reviewHashOf(c.record.review), c.expect.hash, c.name)
    n++
  }
  assert.equal(n, 39, "39 cases are signed by the holder or the delegate")
})

test('makeReview rebuilds the counted records\' fields from their parts (subject, evidenceHash and textHash computed here)', () => {
  for (const c of V.cases.filter((x) => x.expect.counted)) {
    const r = c.record.review
    const built = R.makeReview({ reviewer: r.reviewer, reviewee: r.reviewee, score: r.score, issued: r.issued, evidence: c.record.evidence, text: c.record.text })
    if (c.expect.textWithheld) built.review.textHash = r.textHash   // the withheld text is not in the vectors
    assert.deepEqual(built.review, r, c.name)
  }
  const id = R.reviewRequestId(V.parties.A.container, '00000000000000000000000000000001')
  assert.equal(id, `tape-review:${V.parties.A.container.toLowerCase()}:00000000000000000000000000000001`)
  assert.equal(V.cases[0].record.evidence.receipt.id, id, 'the first case\'s request id')
  assert.match(R.reviewRequestId(V.parties.A.container), /^tape-review:0x[0-9a-f]{40}:[0-9a-f]{32}$/)
  assert.throws(() => R.reviewRequestId(V.parties.A.container, 'short'), /at least 16/)
})

test('the whole review subpath is @experimental: every declaration says so, and the subpath is the only way in', async () => {
  const lines = readFileSync(new URL('../types/review.d.ts', import.meta.url), 'utf8').split('\n')
  let n = 0
  for (let i = 0; i < lines.length; i++) {
    const m = /^export\s+(?:declare\s+(?:function|const|class)|interface|type)\s+([A-Za-z_$][\w$]*)/.exec(lines[i])
    if (!m) continue
    n++
    assert.match(lines[i - 1] ?? '', /@experimental.*\*\/\s*$/, `${m[1]} is @experimental`)
  }
  assert.ok(n >= 50, `${n} declarations`)
  const root = await import('../src/index.js')
  for (const name of ['createReviewKit', 'checkReview', 'summarizeReviews', 'signReview', 'reviewHashOf']) assert.equal(name in root, false, `${name} is not in the package root`)
  const agent = await import('@tapeapi/sdk/agent')
  for (const name of ['agentKitInternals', 'paymentKitInternals']) assert.equal(name in agent, false, `${name} stays internal`)
})
