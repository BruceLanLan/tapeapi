// Container agents, phase 1, M7 (experimental, internal design notes, phase 1, §2.3 rule 5, §6.1 S8, R16): the thread and
// the evidence. A check carries each capped channel's claimedAtCheck; a delivery may carry the agent's spend statement
// (claimedOf at delivery minus claimedOf at the check that started the work), reconciled against the verifier's own
// reading and the receipts × the providers' prices. Phase 0 ignores the statement exactly as before. The vectors
// phase1.statement and phase1.evidence (expectations by hand) are checked here and by spec/vectors/verify.py. Every case
// named FIXED P1M7-xx was checked by removing what implements it (the test turns red). Every clock is fixed (NOW).
// 阶段 1 的 M7：线程与证据。核验带每条通道的 claimedAtCheck；交付可带代理的花费说明，与核验方自己的读数和回执 × 单价对账；
// 阶段 0 照旧忽略它。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as agent from '@tapeapi/sdk/agent'
import {
  standardWorld, happyThread, mandateOf, agentReceipt, providerReceipt, KEYS, addrOf, S, NOW, BEM_TOKEN,
  nameEscrow, escrowContract, channelState,
} from './helpers/agent-chain.mjs'

const { createAgentKit, signMandate, spendStatement, spendEvidence, jsonHashOf, SPEND_EVIDENCE_PROBLEMS, SPEND_EVIDENCE_WARNINGS } = agent
const HUB = '0x' + '10'.repeat(20)
const codes = (r) => r.problems.map((p) => p.code)
const ON = { enforcement: 'escrow-channel' }
const HOLDER = addrOf(KEYS.principalHolder)
const v = JSON.parse(readFileSync(new URL('../../spec/vectors/container-agent.json', import.meta.url), 'utf8')).phase1
const T = v.mapping.times
const ESC = '0x' + 'e1'.repeat(20)
const lower = (x) => JSON.parse(JSON.stringify(x).toLowerCase())
const fundedMandate = (o = {}) => mandateOf({ mode: 1, notBefore: T.notBefore, expires: T.expires, scope: [{ provider: S, token: BEM_TOKEN, cap: '100' }], ...o })
// provider S on escrow ESC, its method `read` priced `priceBEM`; the holder's channel with what was settled (`claimed`)
// provider S 在托管 ESC 上，方法 read 定价 priceBEM；持有人的通道与已结算额
function world({ channel = '70', claimed = '30', priceBEM = '0.0000001' } = {}) {
  const x = standardWorld()
  nameEscrow(x, S, ESC); escrowContract(x, ESC, BEM_TOKEN)
  const key = `${S.toLowerCase()}:.well-known/tapeapi.json`
  const m = JSON.parse(new TextDecoder().decode(x.st.files.get(key).bytes))
  m.methods = m.methods.map((d) => (d.name === 'read' ? { ...d, priceBEM } : d))
  x.chain.writeFile(S, '.well-known/tapeapi.json', JSON.stringify(m))
  channelState(x, HOLDER, S, { channel, session: T.expires, claimed })
  return x
}
const kitOf = (x) => createAgentKit(x.api(), { clock: () => NOW, allowEscrows: [ESC] })
// a thread whose deliver result carries `spend` (or not, when undefined) and three priced receipts from S
// 交付结果带 spend（undefined 则不带）、三张来自 S 的收费回执的线程
const RECEIPTS = [1, 2, 3].map((i) => providerReceipt({ params: { block: i } }))
function threadWith(spend, { m = fundedMandate(), receipts = RECEIPTS } = {}) {
  const t = happyThread({ m })
  const result = { mandateHash: t.mandateHash, deliverableHash: jsonHashOf({ report: 'three holders' }), receiptsHash: jsonHashOf(receipts), receipts, exp: NOW + 3600, ...(spend !== undefined ? { spend } : {}) }
  const deliver = { v: 0, kind: 'tape.agent/deliver', receipt: agentReceipt({ kind: 'deliver', method: 'task_deliver', params: { mandateHash: t.mandateHash }, result }) }
  return [t.offer, t.accept, t.mandate, deliver]
}
const statement = (o = {}) => [{ provider: S, escrow: ESC, claimedAtStart: '0', claimedAtDelivery: '30', spent: '30', ...o }]

test('FIXED P1M7-01: every phase1.statement vector: one entry per pinned channel read at delivery, none made up', () => {
  assert.equal(v.statement.length, 10)
  for (const c of v.statement) assert.deepEqual(lower(spendStatement(c.record, c.check)), lower(c.expect), c.name)
  assert.throws(() => spendStatement({ v: 1, chainId: 56, agentKey: addrOf(KEYS.agentKey), state: 'accepted' }, { consumer: HOLDER }), (e) => e.code === 'INVALID_ARGUMENT')
})

test('FIXED P1M7-02: every phase1.evidence vector: the problems and warnings in order, and each item\'s reconciliation', () => {
  assert.equal(v.evidence.length, 36)
  for (const c of v.evidence) {
    const r = spendEvidence(c.spend, { mandate: c.mandate, calls: c.calls, readings: c.readings, prices: c.prices })
    assert.deepEqual(codes(r), c.expect.problems, c.name)
    assert.deepEqual(r.warnings.map((w) => w.code), c.expect.warnings, c.name)
    assert.deepEqual(r.items.map((i) => i.reconciled), c.expect.reconciled, c.name)
    assert.deepEqual(r.items.map((i) => i.spentNow), c.expect.spentNow, c.name)
    assert.deepEqual(r.items.map((i) => i.expected), c.expect.expected, c.name)
    assert.equal(r.ok, c.expect.problems.length === 0, c.name)
    for (const p of r.problems) assert.ok(SPEND_EVIDENCE_PROBLEMS.includes(p.code), p.code)
    for (const w of r.warnings) assert.ok(SPEND_EVIDENCE_WARNINGS.includes(w.code), w.code)
  }
  // every code the rules name is reached by some vector / 规则里的每个码都有向量用到
  const seen = new Set(v.evidence.flatMap((c) => [...c.expect.problems, ...c.expect.warnings]))
  for (const c of [...SPEND_EVIDENCE_PROBLEMS, ...SPEND_EVIDENCE_WARNINGS]) assert.ok(seen.has(c), c)
})

test('FIXED P1M7-03: a phase-1 check and a phase-1 thread carry each capped channel\'s claimedAtCheck, read at the pinned block', async () => {
  const x = world({ claimed: '30' })
  const m = fundedMandate()
  const c = await kitOf(x).verifyMandate({ mandate: m, sig: signMandate(56, HUB, m, KEYS.principalHolder, { allowFunds: true }) }, ON)
  assert.equal(c.enforcement, 'escrow-channel'); assert.equal(c.scope[0].claimedAtCheck, '30')
  const t = await kitOf(x).verifyTaskThread(threadWith(undefined), ON)
  assert.deepEqual(codes(t), []); assert.equal(t.enforcement, 'escrow-channel')
  assert.equal(t.scope[0].claimedAtCheck, '30'); assert.equal(t.mandateCheck.scope[0].claimedAtCheck, '30')
  x.chain.setClaimed(HOLDER, S, '45')
  assert.equal((await kitOf(x).verifyTaskThread(threadWith(undefined), ON)).scope[0].claimedAtCheck, '45')
})

test('FIXED P1M7-04: with the switch, a delivery\'s spend statement is reconciled against the thread\'s readings and the receipts at the manifest\'s price', async () => {
  // 3 calls at 10 each (priceBEM 0.0000001, 8 decimals), 30 settled since a start at 0: equal / 三次调用各 10，开工以来结算 30：相等
  const ok = await kitOf(world()).verifyTaskThread(threadWith(statement()), ON)
  assert.deepEqual(codes(ok), []); assert.equal(ok.enforcement, 'escrow-channel'); assert.equal(ok.state, 'Delivered')
  assert.deepEqual(ok.evidence.spend.warnings, [])
  assert.deepEqual(lower(ok.evidence.spend.items), lower([{ provider: S, escrow: ESC, claimedAtStart: '0', claimedAtDelivery: '30', spent: '30', claimedNow: '30', spentNow: '30', calls: 3, expected: '30', reconciled: 'equal' }]))
  assert.deepEqual(ok.deliveries[0].evidence.spend, ok.evidence.spend)
  // not settled yet: the chain reads 20, three calls were receipted: a warning, the thread stays ok
  // 尚未结算完：链上 20、回执三次：只是警告，线程仍 ok
  const lag = await kitOf(world({ claimed: '20' })).verifyTaskThread(threadWith(statement({ claimedAtDelivery: '20', spent: '20' })), ON)
  assert.deepEqual(codes(lag), []); assert.equal(lag.enforcement, 'escrow-channel')
  assert.deepEqual(lag.evidence.spend.warnings.map((w) => w.code), ['spend-below-receipts'])
  // a statement above the chain (the agent says 40 were settled; the chain reads 30) / 说明高于链上读数
  const above = await kitOf(world()).verifyTaskThread(threadWith(statement({ claimedAtDelivery: '40', spent: '40' })), ON)
  assert.deepEqual(codes(above), []); assert.deepEqual(above.evidence.spend.warnings.map((w) => w.code), ['spend-above-chain'])
  // a method the manifest does not price as a decimal: not reconciled; a price of 0 makes 30 paid "above" 0 receipted
  // 单价为 0：开工以来付了 30，回执按 0 计，报“多于回执”
  const free = await kitOf(world({ priceBEM: '0' })).verifyTaskThread(threadWith(statement()), ON)
  assert.deepEqual(free.evidence.spend.warnings.map((w) => w.code), ['spend-exceeds-receipts'])
  // a statement that does not add up is a problem: the thread is not ok and its enforcement is none
  // 算不平即问题：线程不 ok，enforcement 为 none
  const bad = await kitOf(world()).verifyTaskThread(threadWith(statement({ spent: '31' })), ON)
  assert.deepEqual(codes(bad), ['spend-evidence-inconsistent']); assert.equal(bad.enforcement, 'none'); assert.equal(bad.mandateCheck.enforcement, 'escrow-channel')
  assert.match(bad.problems[0].message, /^messages\[3\]: spend: /)
  const mal = await kitOf(world()).verifyTaskThread(threadWith({ spent: '30' }), ON)
  assert.deepEqual(codes(mal), ['spend-evidence-malformed'])
  // the statement is not under receiptsHash: receiptsHash still covers the receipts only / spend 不在 receiptsHash 里
  assert.equal(codes(ok).includes('receipts-hash-mismatch'), false)
})

test('FIXED P1M7-08: the spend statement is covered by the delivery\'s signature: changing it after signing is not-signed-by-agent', async () => {
  // review m7 F4: the statement is outside receiptsHash and inside the agent's signed deliver result / 说明不在 receiptsHash 里，但在代理签名的结果里
  const thread = threadWith(statement())
  assert.deepEqual(codes(await kitOf(world()).verifyTaskThread(thread, ON)), [])   // untouched: no problem / 未改动：无问题
  // the lowered amounts still add up (spent = delivery - start), so only the signature can tell / 改低后仍然算得平，只有签名能识破
  const tampered = JSON.parse(JSON.stringify(thread))
  const sp = tampered[3].receipt.result.spend[0]
  sp.claimedAtDelivery = '0'; sp.spent = '0'
  assert.notDeepEqual(tampered[3].receipt.result.spend, thread[3].receipt.result.spend)
  const r = await kitOf(world()).verifyTaskThread(tampered, ON)
  assert.ok(codes(r).includes('not-signed-by-agent'), JSON.stringify(codes(r)))
  assert.equal(r.ok, false)
})

test('FIXED P1M7-05: phase 0 unchanged: a spend member is ignored without the switch, and for a mandate without funds even with it', async () => {
  const strip = (r) => JSON.parse(JSON.stringify({ ok: r.ok, state: r.state, problems: r.problems, enforcement: r.enforcement, evidence: r.evidence, deliveries: r.deliveries.map((d) => ({ ...d })), verdict: r.verdict, selfHire: r.selfHire, mandateHash: r.mandateHash, mandateCheck: r.mandateCheck }))
  // review m7 S4: the keys only phase 1 adds are absent from every result without the switch or without funds, not merely equal in the projection
  // 审查 m7 S4：只有阶段 1 才有的键，在不带开关或不带金额的结果里不存在（而不只是投影相等）
  const PHASE1_KEYS = ['scope', 'bound', 'warnings', 'consumer', 'fundingPath']
  const noPhase1 = (r, label) => { for (const r1 of [r, r.mandateCheck].filter(Boolean)) { assert.notEqual(r1.phase, 1, `${label}: phase`); for (const k of PHASE1_KEYS) assert.equal(k in r1, false, `${label}: ${k}`) } }
  // a phase-0 thread (no funds), with and without the switch / 阶段 0 的线程（不带金额），带不带开关
  const m0 = mandateOf()
  for (const o of [{}, ON]) {
    const a = await kitOf(world()).verifyTaskThread(threadWith(undefined, { m: m0 }), o)
    const b = await kitOf(world()).verifyTaskThread(threadWith(statement({ spent: 'garbage' }), { m: m0 }), o)
    assert.deepEqual(codes(a), [], JSON.stringify(o)); assert.deepEqual(strip(b), strip(a), JSON.stringify(o))
    assert.equal('spend' in b.evidence, false); noPhase1(a, JSON.stringify(o)); noPhase1(b, JSON.stringify(o))
  }
  // a funded mandate without the switch: phase0-no-funds whether or not the delivery states anything
  // 带金额的授权书、不带开关：不论交付写不写说明都是 phase0-no-funds
  const a = await kitOf(world()).verifyTaskThread(threadWith(undefined))
  const b = await kitOf(world()).verifyTaskThread(threadWith(statement({ spent: 'garbage' })))
  assert.ok(codes(a).includes('phase0-no-funds')); assert.deepEqual(strip(b), strip(a)); noPhase1(a, 'funded, no switch'); noPhase1(b, 'funded, no switch')
  // standalone verifyEvidence: without the option the member is ignored; with it, only for a mandate that names funds
  // 单独的 verifyEvidence：不带选项即忽略；带选项也只对带金额的授权书核对
  const deliver = (spend) => ({ receipts: RECEIPTS, receiptsHash: jsonHashOf(RECEIPTS), ...(spend !== undefined ? { spend } : {}) })
  const plain = await kitOf(world()).verifyEvidence(deliver(undefined), { mandate: fundedMandate() })
  const ignored = await kitOf(world()).verifyEvidence(deliver(statement({ spent: 'garbage' })), { mandate: fundedMandate() })
  assert.deepEqual(ignored, plain); assert.equal('spend' in plain, false)
  const unfunded = await kitOf(world()).verifyEvidence(deliver(statement({ spent: 'garbage' })), { mandate: m0, enforcement: 'escrow-channel' })
  assert.deepEqual(unfunded, await kitOf(world()).verifyEvidence(deliver(undefined), { mandate: m0 }))
  const checked = await kitOf(world()).verifyEvidence(deliver(statement()), { mandate: fundedMandate(), enforcement: 'escrow-channel', scope: [{ provider: S, escrow: ESC, claimedAtCheck: '30' }] })
  assert.equal(checked.ok, true); assert.equal(checked.spend.items[0].reconciled, 'equal'); assert.equal(checked.spend.items[0].spentNow, '30')
  const noReadings = await kitOf(world()).verifyEvidence(deliver(statement()), { mandate: fundedMandate(), enforcement: 'escrow-channel' })
  assert.equal(noReadings.spend.items[0].spentNow, null); assert.equal(noReadings.spend.items[0].reconciled, 'equal')
})

test('FIXED P1M7-06: only receipts that verified count, and a provider outside the mandate\'s caps is a problem', async () => {
  // a receipt whose signature is broken is reported (receipt-invalid) and not counted: two calls, 30 paid: above
  // 签名坏掉的回执被报告且不计：两次调用、付了 30：多于回执
  const broken = [...RECEIPTS.slice(0, 2), { ...RECEIPTS[2], sig: '0x' + '22'.repeat(65) }]
  const r = await kitOf(world()).verifyTaskThread(threadWith(statement(), { receipts: broken }), ON)
  assert.deepEqual(codes(r), ['receipt-invalid'])
  assert.equal(r.evidence.spend.items[0].calls, 2); assert.deepEqual(r.evidence.spend.warnings.map((w) => w.code), ['spend-exceeds-receipts'])
  const out = await kitOf(world()).verifyTaskThread(threadWith([{ provider: '0x' + '77'.repeat(20), escrow: ESC, claimedAtStart: '0', claimedAtDelivery: '0', spent: '0' }]), ON)
  assert.deepEqual(codes(out), ['spend-provider-out-of-scope'])
  assert.deepEqual(out.evidence.spend.warnings.map((w) => w.code), ['spend-evidence-incomplete'])
})

test('FIXED P1RR-07: with the switch, a funded thread whose delivery carries no spend statement is warned spend-evidence-absent (never a problem); phase 0 and the unfunded mandate are unchanged', async () => {
  const r = await kitOf(world()).verifyTaskThread(threadWith(undefined), ON)
  assert.deepEqual(codes(r), []); assert.equal(r.enforcement, 'escrow-channel'); assert.equal(r.state, 'Delivered')
  assert.deepEqual(r.evidence.spend.items, [])
  assert.deepEqual(r.evidence.spend.warnings.map((w) => w.code), ['spend-evidence-absent'])
  assert.equal(SPEND_EVIDENCE_WARNINGS.includes('spend-evidence-absent'), false, 'the kit\'s code, not spendEvidence\'s')
  const deliver = { receipts: RECEIPTS, receiptsHash: jsonHashOf(RECEIPTS) }
  const alone = await kitOf(world()).verifyEvidence(deliver, { mandate: fundedMandate(), enforcement: 'escrow-channel' })
  assert.equal(alone.ok, true); assert.deepEqual(alone.spend.warnings.map((w) => w.code), ['spend-evidence-absent'])
  // without the switch, or for a mandate without funds: no spend member at all, as before / 不带开关或授权书不带金额：照旧没有 spend
  assert.equal('spend' in (await kitOf(world()).verifyEvidence(deliver, { mandate: fundedMandate() })), false)
  assert.equal('spend' in (await kitOf(world()).verifyEvidence(deliver, { mandate: mandateOf(), enforcement: 'escrow-channel' })), false)
  const t0 = await kitOf(world()).verifyTaskThread(threadWith(undefined, { m: mandateOf() }), ON)
  assert.equal('spend' in t0.evidence, false)
})
