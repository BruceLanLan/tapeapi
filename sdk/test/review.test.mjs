// Evidence-backed reviews (@experimental, draft TAPs #54) on the fake chain: createReviewKit reads identities, holders,
// delegates, signers and EIP-1271 with the strict readers of createAgentKit, the reviewer's site file and public TapeSend
// messages. Adversarial cases are named FIXED RV-xx; each was checked by removing the line that implements it (the test
// turns red). / 评价记录在假链上：身份、持有人、委托钥匙、签名者与 EIP-1271 用 createAgentKit 的严格读取；站点文件与 TapeSend。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as R from '@tapeapi/sdk/review'
import * as sig from '../src/sig.js'
import { receiptOf, hashReceipt } from '../src/mcp.js'
import { seal, encodePublic } from '../src/tapesend.js'
import { x25519 } from '@noble/curves/ed25519'
import * as A from '../src/agent-sig.js'
import { checksumAddress } from '../src/abi.js'
import {
  standardWorld, mandateOf, deliverMsg, verdictMsg, KEYS, addrOf, P, AG, S, S2, ADDR, NOW, nowS, SITE_STORE,
} from './helpers/agent-chain.mjs'

const HUB = ADDR.hub
const ep = (c) => R.endpointId(56, c)
const kitOf = (x, o = {}) => R.createReviewKit(x.api(), { clock: () => NOW, ...o })
const NEW_HOLDER = '0x' + 'ab'.repeat(32)
let nonceSeq = 0
// A TAP-13 answer of S to a request whose id names `reviewer`, as a hash-only receipt / S 对一个写明评价方的请求的签名回答
function answer({ reviewer = AG, service = S, signerKey = KEYS.providerSigner, tokenId = 13, ts = NOW - 600, id } = {}) {
  const rid = id ?? R.reviewRequestId(reviewer, String(++nonceSeq).padStart(32, '0'))
  const method = 'read', params = { block: 1 }, body = { holders: 3 }
  const envelope = { container: service, id: rid, ts, ok: true, result: body, sig: sig.signResponse({ container: service, id: rid, method, params, ok: true, body, ts }, signerKey) }
  return { kind: 'response', receipt: hashReceipt(receiptOf({ envelope, method, params, circuits: ADDR.circuits, tokenId })) }
}
function record({ reviewer = AG, reviewee = S, key = KEYS.agentHolder, score = 5, evidence, text, kind = 1, subject, issued = NOW - 60, keepText = true } = {}) {
  const b = R.makeReview({ reviewer: ep(reviewer), reviewee: ep(reviewee), kind, score, evidence, text, subject, issued, hub: HUB })
  const rec = { review: b.review, sig: R.signReview(b.review, key, { hub: HUB }) }
  if (b.text && keepText) rec.text = b.text
  if (b.evidence) rec.evidence = b.evidence
  return rec
}

test('level 1 on chain: the reviewer\'s holder signs, the reviewee\'s current signer signed the answer: counted, with names and holders', async () => {
  const x = standardWorld()
  const rec = record({ evidence: answer(), text: { body: 'fast and right', tags: ['fast'] } })
  const r = await kitOf(x).verifyReview(rec)
  assert.deepEqual(r.problems, [])
  assert.equal(r.valid, true); assert.equal(r.level, 1); assert.equal(r.signedBy, 'holder'); assert.equal(r.counted, true)
  assert.equal(r.hash, R.reviewHashOf(rec.review, { hub: HUB }))
  assert.equal(r.reviewer.holder, addrOf(KEYS.agentHolder)); assert.equal(r.reviewer.delegate, addrOf(KEYS.agentSigner))
  assert.equal(r.reviewee.signer, addrOf(KEYS.providerSigner))
  assert.match(r.reviewer.name, /^12\.\d+\.tape$/); assert.match(r.reviewee.name, /^13\.\d+\.tape$/)
  assert.deepEqual(R.reviewTextForDisplay(rec), { body: 'fast and right', tags: ['fast'], statedBy: 'the reviewer' })
})

test('FIXED RV-01: the delegate (the reviewer\'s TAP-11 signer) may sign; any other key is signer-not-current, shown and never counted', async () => {
  const x = standardWorld()
  const ev = answer()
  const kit = kitOf(x)
  const d = await kit.verifyReview(record({ evidence: ev, key: KEYS.agentSigner }))
  assert.equal(d.signedBy, 'delegate'); assert.equal(d.counted, true)
  const s = await kit.verifyReview(record({ evidence: ev, key: KEYS.stranger }))
  assert.deepEqual([s.valid, s.signedBy, s.counted, s.problems], [true, null, false, ['signer-not-current']])
  // a principal without a service has no delegate: its own signer key would not count / 没有服务的容器没有委托钥匙
  const p = await kit.verifyReview(record({ reviewer: P, key: KEYS.agentSigner, evidence: answer({ reviewer: P }) }))
  assert.deepEqual(p.problems, ['signer-not-current'])
  assert.equal(p.reviewer.delegate, null)
})

test('FIXED RV-02: a transfer: the old holder\'s record stops counting, the delegation lapses, and the new holder re-signs the same review hash', async () => {
  const x = standardWorld()
  const ev = answer()
  const old = record({ evidence: ev })
  const del = record({ evidence: ev, key: KEYS.agentSigner, issued: NOW - 59 })
  assert.equal((await kitOf(x).verifyReview(old)).counted, true)
  x.chain.setOwner(12, addrOf(NEW_HOLDER))   // AG (#12) changes hands / AG 易主
  const kit = kitOf(x)
  const a = await kit.verifyReview(old)
  assert.deepEqual([a.signedBy, a.counted, a.problems], [null, false, ['signer-not-current']])
  assert.equal(a.reviewer.holder, addrOf(NEW_HOLDER))
  // the old holder's delegation no longer resolves: the delegate's records stop counting too (TAP-11 §7.2)
  const b = await kit.verifyReview(del)
  assert.equal(b.reviewer.delegate, null); assert.deepEqual(b.problems, ['signer-not-current'])
  const again = { ...old, sig: R.signReview(old.review, NEW_HOLDER, { hub: HUB }) }
  const c = await kit.verifyReview(again)
  assert.equal(c.hash, a.hash, 'the same record, the same review hash')
  assert.deepEqual([c.signedBy, c.counted], ['holder', true])
})

test('FIXED RV-03: a stranger\'s withdrawal or conflicting record on chain changes nothing in the summary; the holder\'s withdrawal does', async () => {
  const x = standardWorld()
  const ev = answer()
  const rev = record({ evidence: ev })
  const subject = rev.review.subject
  const stranger = record({ kind: 2, score: 0, subject, issued: NOW, key: KEYS.stranger })
  const strangerSame = record({ evidence: ev, score: 1, key: KEYS.stranger })   // same key and issued
  const holderW = record({ kind: 2, score: 0, subject, issued: NOW })
  const items = await kitOf(x).verifyReviews([rev, stranger, strangerSame, holderW])
  const without = R.summarizeReviews(items.slice(0, 3))
  assert.deepEqual([without.level1.reviewers, without.level1.scores, without.conflicts], [1, [0, 0, 0, 0, 1], 0])
  assert.equal(without.level1.holders, 1)
  const withW = R.summarizeReviews(items)
  assert.deepEqual([withW.level1.reviewers, withW.uncountedPairs, withW.conflicts], [0, 0, 0])
})

test('FIXED RV-04: related parties: a reviewer held by the reviewee\'s holder is shown and never counted; so is a level-2 agent key held by the principal', async () => {
  const x = standardWorld()
  // S2 (#14) has the same holder as S (#13) / S2 与 S 同一持有人
  const r = await kitOf(x).verifyReview(record({ reviewer: S2, key: KEYS.providerHolder, evidence: answer({ reviewer: S2 }) }))
  assert.deepEqual([r.level, r.signedBy, r.counted, r.problems], [1, 'holder', false, ['related-parties']])
})

function task({ agentKey = addrOf(KEYS.agentKey), nonce = '1', verdict = 1 } = {}) {
  const m = mandateOf({ agentKey, nonce })
  const mandateHash = A.mandateHashOf(56, HUB, m)
  const d = deliverMsg({ mandateHash })
  const v = verdictMsg({ mandateHash, deliverableHash: d.receipt.result.deliverableHash, verdict })
  return { kind: 'task', mandate: m, mandateSig: A.signMandate(56, HUB, m, KEYS.principalHolder), deliver: d.receipt, verdict: v.verdict, verdictSig: v.sig }
}
test('level 2 on chain: the principal reviews the agent and the agent the principal; the agent key of the principal is related-parties', async () => {
  const x = standardWorld()
  const ev = task()
  const kit = kitOf(x)
  const pr = await kit.verifyReview(record({ reviewer: P, reviewee: AG, key: KEYS.principalHolder, evidence: ev, issued: NOW }))
  assert.deepEqual([pr.problems, pr.level, pr.counted], [[], 2, true])
  const ar = await kit.verifyReview(record({ reviewer: AG, reviewee: P, key: KEYS.agentHolder, evidence: ev, issued: NOW, score: 2 }))
  assert.deepEqual([ar.problems, ar.level, ar.counted], [[], 2, true])
  const self = task({ agentKey: addrOf(KEYS.principalHolder), nonce: '2' })
  const sr = await kit.verifyReview(record({ reviewer: P, reviewee: AG, key: KEYS.principalHolder, evidence: self, issued: NOW }))
  assert.deepEqual([sr.level, sr.counted, sr.problems], [2, false, ['related-parties']])
  // a delivery signed by the principal, not the agent / 委托方自己签的交付
  const forged = task({ nonce: '3' })
  forged.deliver = { ...forged.deliver, sig: sig.signResponse({ container: AG, id: forged.deliver.id, method: forged.deliver.method, params: forged.deliver.params, ok: true, body: forged.deliver.result, ts: forged.deliver.ts }, KEYS.principalHolder) }
  const fr = await kit.verifyReview(record({ reviewer: P, reviewee: AG, key: KEYS.principalHolder, evidence: forged, issued: NOW }))
  assert.deepEqual([fr.level, fr.counted, fr.problems], [0, false, ['evidence-signature']])
})

test('FIXED RV-05: a contract holder: EIP-1271 accepts its record (strict, at the pinned block); a verifier that declines EIP-1271 says holder-signature-unsupported', async () => {
  const x = standardWorld()
  const SAFE = '0x' + '5a'.repeat(20)
  x.chain.setOwner(11, SAFE)   // P (#11) is held by a contract / P 由合约持有
  const b = R.makeReview({ reviewer: ep(P), reviewee: ep(S), score: 4, evidence: answer({ reviewer: P }), issued: NOW - 60, hub: HUB })
  x.chain.setContractHolder(SAFE, R.reviewDigest(b.review, { hub: HUB }))
  const rec = { review: b.review, sig: '0x' + 'cd'.repeat(97), evidence: b.evidence }
  const r = await kitOf(x).verifyReview(rec)
  assert.deepEqual([r.signedBy, r.counted, r.problems], ['holder', true, []])
  const d = await kitOf(x, { eip1271: false }).verifyReview(rec)
  assert.deepEqual([d.signedBy, d.counted, d.problems], [null, false, ['holder-signature-unsupported']])
  // another digest: the contract does not accept it / 别的摘要：合约不认可
  const other = { ...rec, review: { ...rec.review, score: 1 } }
  assert.deepEqual((await kitOf(x).verifyReview(other)).problems, ['signer-not-current'])
})

test('FIXED RV-06: identities: an address that is no TapeOut container rejects the record (not-tapeout); a node that lies makes the check throw, never a verdict', async () => {
  const x = standardWorld()
  const nobody = '0x' + '0d'.repeat(20)
  const r = await kitOf(x).verifyReview(record({ reviewee: nobody }))
  assert.deepEqual([r.valid, r.rejected, r.problems], [false, true, ['not-tapeout']])
  const ownerOf = sig.privateKeyToAddress(KEYS.stranger).toLowerCase().slice(2)
  x.lie('http://rpc2', (method, params, honest) => (method === 'eth_call' && String(params[0]?.data).startsWith('0x6352211e') ? '0x' + '00'.repeat(12) + ownerOf : honest))
  await assert.rejects(kitOf(x).verifyReview(record({ evidence: answer() })), (e) => e.code === 'RPC_DISAGREE', 'strict agreement refuses the read: thrown, not a problem of the record')
})

test('FIXED RV-07: the reviewee rotated its signer: its old answers no longer back reviews (evidence-signature), favourable and unfavourable alike', async () => {
  const x = standardWorld()
  const good = record({ evidence: answer(), score: 5 })
  const bad = record({ reviewer: P, key: KEYS.principalHolder, evidence: answer({ reviewer: P }), score: 1 })
  x.service(S, 13, { holderKey: KEYS.providerHolder, signerKey: '0x' + '5c'.repeat(32), name: 'Provider' })
  const kit = kitOf(x)
  for (const rec of [good, bad]) assert.deepEqual((await kit.verifyReview(rec)).problems, ['evidence-signature'])
})

// ---- the site file (§8.1) ----
test('FIXED RV-08: the reviewer\'s site file: read at one pinned block, records of other reviewers ignored, a filter by reviewee', async () => {
  const x = standardWorld()
  const mine = record({ evidence: answer() })
  const aboutP = record({ reviewee: P, issued: NOW - 30 })
  const notMine = record({ reviewer: P, key: KEYS.principalHolder, evidence: answer({ reviewer: P }) })
  const bytes = new TextEncoder().encode(JSON.stringify({ 'tapeapi-reviews': '1', reviews: [mine, aboutP, notMine] }))
  x.chain.writeFile(AG, R.REVIEWS_KEY, bytes)
  const kit = kitOf(x)
  const f = await kit.readReviewFile(AG)
  assert.equal(f.status, 'ok'); assert.equal(f.ignored, 1); assert.equal(f.items.length, 2)
  assert.deepEqual(f.items.map((i) => [i.result.level, i.result.counted]), [[1, true], [0, false]])
  assert.deepEqual(f.items[0].carriage, { kind: 'site-file', chainId: 56, container: checksumAddress(AG) })
  const only = await kit.readReviewFile(AG, { reviewee: S })
  assert.deepEqual([only.items.length, only.skipped, only.ignored], [1, 1, 1])
  assert.equal((await kit.readReviewFile(P)).status, 'none')
  // reviewFileBytes refuses a mix of reviewers and builds the same file for one / 拒绝混合评价方
  assert.throws(() => R.reviewFileBytes([mine, notMine]), /same reviewer/)
  assert.deepEqual(JSON.parse(new TextDecoder().decode(R.reviewFileBytes([mine]))), { 'tapeapi-reviews': '1', reviews: [mine] })
})

test('FIXED RV-09: a file whose declared size is over 262,144 bytes is invalid and never read; a broken file yields no record', async () => {
  const x = standardWorld()
  x.chain.writeFile(AG, R.REVIEWS_KEY, JSON.stringify({ 'tapeapi-reviews': '1', reviews: [record({ evidence: answer() })] }))
  x.chain.setFileInfo(AG, R.REVIEWS_KEY, { size: R.REVIEWS_LIMIT + 1 })
  const before = x.st.calls.length
  const f = await kitOf(x).readReviewFile(AG)
  assert.equal(f.status, 'invalid'); assert.equal(f.items.length, 0)
  assert.ok(!x.st.calls.slice(before).some((c) => c.name === 'read'), 'read() was never called')
  for (const [bad, why] of [
    ['{"tapeapi-reviews":"1","reviews":[],"reviews":[]}', 'a repeated member'],
    ['{"tapeapi-reviews":"2","reviews":[]}', 'another format'],
    ['{"tapeapi-reviews":"1","__proto__":{},"reviews":[]}', '__proto__'],
    ['﻿{"tapeapi-reviews":"1","reviews":[]}', 'a byte order mark'],
    ['{"tapeapi-reviews":"1"}', 'no reviews'],
  ]) {
    x.chain.writeFile(AG, R.REVIEWS_KEY, bad)
    assert.equal((await kitOf(x).readReviewFile(AG)).status, 'invalid', why)
  }
})

// ---- TapeSend (§8.2) ----
const HEAD = 62_000_000
test('FIXED RV-10: TapeSend: a public message from the reviewer carries the record; the sending wallet is shown and marked after a transfer', async () => {
  const x = standardWorld()
  const rec = record({ evidence: answer() })
  x.send({ from: AG, wallet: addrOf(KEYS.agentHolder), to: S, content: R.reviewMessageContent(rec), block: HEAD - 1000 })
  x.send({ from: P, wallet: addrOf(KEYS.principalHolder), to: S, content: new TextEncoder().encode(JSON.stringify({ v: 1, kind: 'message', body: 'hi' })), block: HEAD - 999 })
  // P forwards AG's record: not from the reviewer, ignored / P 转发 AG 的记录：发件方不是评价方，忽略
  x.send({ from: P, wallet: addrOf(KEYS.principalHolder), to: S, content: R.reviewMessageContent(rec), block: HEAD - 998 })
  const got = await kitOf(x).readReviewMessages(S)
  assert.equal(got.count, 3)
  assert.equal(got.items.length, 1)
  assert.deepEqual(got.skipped, [{ inboxIndex: 2, why: 'not-from-the-reviewer' }])
  const it = got.items[0]
  assert.deepEqual([it.result.level, it.result.counted], [1, true])
  assert.equal(it.carriage.sendingWallet, addrOf(KEYS.agentHolder)); assert.equal(it.carriage.walletDiffersFromHolder, false)
  assert.equal(it.carriage.inboxIndex, 0); assert.match(it.carriage.body, /score 5 of 5/)
  x.chain.setOwner(12, addrOf(NEW_HOLDER))
  const after = (await kitOf(x).readReviewMessages(S)).items[0]
  assert.equal(after.carriage.walletDiffersFromHolder, true, 'the circuit changed hands after the message was sent')
  assert.deepEqual(after.result.problems, ['signer-not-current'])
})

test('FIXED RV-11: TapeSend: the block time stands in for now (§6 step 4); pending and sealed messages are not read', async () => {
  const x = standardWorld()
  const old = HEAD - 9_100_000                         // a block well before NOW / 远早于 NOW 的块
  const blockTime = x.timeOf(old)
  assert.ok(blockTime + 301 <= NOW)
  const late = record({ issued: blockTime + 301 })      // fine against NOW, too late against the block / 对 NOW 没问题，对区块时间太晚
  x.send({ from: AG, wallet: addrOf(KEYS.agentHolder), to: S, content: R.reviewMessageContent(late), block: old })
  x.send({ from: AG, wallet: addrOf(KEYS.agentHolder), to: S, content: R.reviewMessageContent(record({ issued: NOW - 10 })), block: HEAD - 1 })   // pending
  const sk = x25519.utils.randomPrivateKey()
  const sealed = seal({ content: R.reviewMessageContent(record({ issued: NOW - 20 })), recipients: [x25519.getPublicKey(sk)], to: S, from: AG, hub: HUB, chainId: 56 })
  x.send({ from: AG, wallet: addrOf(KEYS.agentHolder), to: S, payload: sealed, block: HEAD - 900 })
  const kit = kitOf(x)
  assert.equal((await kit.verifyReview(late)).valid, true, 'valid against the clock')
  const got = await kit.readReviewMessages(S)
  assert.deepEqual(got.items.map((i) => i.result.problems), [['issued-in-future']])
  assert.equal(got.items[0].result.valid, false)
  assert.deepEqual(got.skipped, [{ inboxIndex: 1, why: 'pending' }, { inboxIndex: 2, why: 'sealed' }])
})

test('FIXED RV-12: a TapeSend copy without evidence and the full record from the site file are one record: counted once, at level 1', async () => {
  const x = standardWorld()
  const rec = record({ evidence: answer(), text: { body: 'ok' } })
  const copy = { review: rec.review, sig: rec.sig }   // no evidence, text withheld / 不带证据与文字
  x.send({ from: AG, wallet: addrOf(KEYS.agentHolder), to: S, content: R.reviewMessageContent(copy), block: HEAD - 1000 })
  x.chain.writeFile(AG, R.REVIEWS_KEY, R.reviewFileBytes([rec]))
  const kit = kitOf(x)
  const sent = await kit.readReviewMessages(S)
  assert.deepEqual([sent.items[0].result.level, sent.items[0].result.problems, sent.items[0].result.textWithheld], [0, ['evidence-missing'], true])
  const file = await kit.readReviewFile(AG)
  const s = R.summarizeReviews([...sent.items, ...file.items])
  assert.deepEqual([s.level1.reviewers, s.level1.scores, s.uncountedPairs, s.conflicts], [1, [0, 0, 0, 0, 1], 0, 0])
  // a record too large for one public payload is refused / 超过公开载荷上限即拒绝
  const big = { ...rec, text: { body: 'x'.repeat(2000) }, filler: 'y'.repeat(16_000) }
  assert.throws(() => R.reviewMessageContent(big), /over 16000 bytes: send the record without evidence/)
  assert.ok(encodePublic(R.reviewMessageContent(rec)).length <= 16_000)
})

test('reviewTypedData shows the console what the wallet does not (§5); createReviewKit refuses a client it cannot use', () => {
  const rec = record({ evidence: answer(), text: { body: 'fine' } })
  const td = R.reviewTypedData(rec.review, { hub: HUB, revieweeName: '13.1013.tape', text: rec.text, evidence: rec.evidence })
  assert.equal(td.primaryType, 'Review'); assert.equal(td.domain.chainId, 56); assert.equal(td.domain.verifyingContract, HUB)
  assert.deepEqual([td.display.revieweeName, td.display.score, td.display.evidence, td.display.text], ['13.1013.tape', 5, 'a signed answer (level 1)', { body: 'fine' }])
  assert.equal(td.warnings[0], R.REVIEW_PUBLIC_NOTICE)
  assert.deepEqual(td.message, rec.review)
  assert.throws(() => R.createReviewKit({}), /createTapeAPI/)
  assert.equal(SITE_STORE.length, 42)
  assert.equal(nowS(), NOW)
})

// ---- the command (tapeapi-verify review) ----
test('FIXED RV-13: `tapeapi-verify review` prints every record and the summary from the site file, the inbox and a records file', async () => {
  const { runReview } = await import('../bin/tapeapi-verify.js')
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const x = standardWorld()
  const rec = record({ evidence: answer(), text: { body: 'fast‮ and right', tags: ['fast'] } })
  x.chain.writeFile(AG, R.REVIEWS_KEY, R.reviewFileBytes([rec]))
  x.send({ from: AG, wallet: addrOf(KEYS.agentHolder), to: S, content: R.reviewMessageContent({ review: rec.review, sig: rec.sig }), block: HEAD - 1000 })
  const dir = mkdtempSync(join(tmpdir(), 'tapeapi-review-'))
  try {
    const file = join(dir, 'records.json')
    writeFileSync(file, JSON.stringify([record({ reviewer: S2, key: KEYS.providerHolder, evidence: answer({ reviewer: S2 }), score: 1 }), record({ reviewer: P, key: KEYS.stranger })]))
    let stdout = '', stderr = ''
    const code = await runReview([S, '--reviewer', AG, '--inbox', '0:10', '--records', file], { api: x.api(), clock: () => NOW, out: (t) => { stdout += t }, err: (t) => { stderr += t } })
    assert.equal(code, 0, stderr)
    assert.match(stdout, /EXPERIMENTAL \(draft TAPs #54\)/)
    assert.match(stdout, /score 5\/5 {2}by 0x[0-9a-fA-F]{40} \(12\.\d+\.tape\) {2}level 1 {2}signed by the holder {2}counted {2}via site-file/)
    assert.match(stdout, /level 0 {2}signed by the holder {2}not counted {2}via tapesend/)
    assert.match(stdout, /problems: related-parties/)
    assert.match(stdout, /NOT signed for the reviewer now/)
    assert.match(stdout, /text \(stated by the reviewer\): "fast and right" tags fast/, 'the RTL override is removed')
    assert.match(stdout, /level 1: 1 reviewer\(s\), 1 holder\(s\), scores 1-5 0\/0\/0\/0\/1/)
    assert.match(stdout, /pairs with only uncounted records: 1; conflicts dropped: 0/, 'S2 is related; the stranger-signed record forms no pair')
    assert.match(stdout, /not proof of quality/)
    let e2 = ''
    assert.equal(await runReview([S], { api: x.api(), err: (t) => { e2 += t } }), 2)
    assert.match(e2, /give --reviewer, --records or --inbox/)
    assert.equal(await runReview([S, '--inbox', 'x'], { api: x.api(), err: () => {} }), 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
