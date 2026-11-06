// Scenario (b), end to end on the SDK's fake chain: container A sends container B a task thread; B delivers; A accepts or
// rejects (EXPERIMENTAL, phase 0). Nothing leaves this process; every key is a fixture. One world per test.
// 场景 (b) 的端到端测试（SDK 假链）：容器 A 向容器 B 发任务线程；B 交付；A 验收或拒收（实验性，阶段 0）。
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { jsonHashOf } from '@tapeapi/sdk/agent'
import { createInteropWorld, restoreTime, S, S2, P, AG } from './world.mjs'
import { runTaskThread, misreportingTask, checkDeliverable, TASK } from './task-thread.mjs'

afterEach(restoreTime)
const world = (o = {}) => createInteropWorld({ channels: false, ...o })

test('b: the honest case: offer, accept, mandate, delivery, A\'s own check, verdict: Settled, one receipt of S, nothing else called', async () => {
  const w = await world()
  const lines = []
  const r = await runTaskThread({ world: w, print: (l) => lines.push(l) })
  assert.deepEqual(r.final.problems.map((p) => p.code), [])
  assert.equal(r.final.state, 'Settled')
  assert.equal(r.final.enforcement, 'none')
  assert.equal(r.final.selfHire, false)
  assert.equal(r.accepted, true)
  assert.deepEqual(r.messages.map((m) => m.kind), ['tape.agent/offer', 'tape.agent/accept', 'tape.agent/mandate', 'tape.agent/deliver', 'tape.agent/acceptance'])
  // who is who, read from the chain, not from the messages
  assert.equal(r.final.principal.container.toLowerCase(), P.toLowerCase())
  assert.equal(r.final.agent.container.toLowerCase(), AG.toLowerCase())
  // the evidence: one receipt, answered by S; and the words that say what it does not prove
  assert.equal(r.final.evidence.receipts.length, 1)
  assert.equal(r.final.evidence.receipts[0].answeredBy, true)
  assert.match(r.final.evidence.doesNotProve.join(' '), /answers were right/)
  // the deliverable is data under the hash B signed, and A's own check ties every number to a receipt
  assert.equal(jsonHashOf(r.deliverable), r.delivered.deliverableHash)
  assert.deepEqual(r.own, { ok: true, problems: [] })
  assert.deepEqual(w.upstreamCalls(), { 'provider-1': 1 }, 'B called the one container in scope, once')
  assert.equal(w.requests.some((u) => u.startsWith('https://provider-2.example')), false)
  assert.ok(lines.some((l) => /thread state Settled/.test(l)))
  w.close()
})

test('b: a delivery that is signed and in order but wrong: the SDK check passes, A\'s own check rejects, and B\'s signed delivery stays on record', async () => {
  const w = await world({ agentOptions: { tasks: { 'chain.block-height': misreportingTask({ offset: 1 }) } } })
  const r = await runTaskThread({ world: w })
  // what the SDK proves: B signed this delivery, in this thread, with a receipt S really signed
  assert.equal(r.before.ok, true)
  assert.equal(r.before.state, 'Delivered')
  assert.equal(r.before.evidence.ok, true)
  // what it does not: that the number in the deliverable is the one in S's receipt
  assert.deepEqual(r.own.problems.map((p) => p.code), ['answer-not-in-receipts'])
  assert.equal(r.accepted, false)
  assert.equal(r.final.state, 'Rejected')
  assert.equal(r.final.verdict.verdict, 'rejected')
  assert.deepEqual(r.final.problems.map((p) => p.code), [], 'the thread itself is well formed: a rejection is a verdict, not a failure of the thread')
  assert.notEqual(r.verdictMsg.verdict.reasonHash, '0x' + '00'.repeat(32), 'a rejection commits to a written reason by hash')
  assert.equal(r.final.deliveries[0].deliverableHash, r.delivered.deliverableHash, 'the delivery is still B\'s signed statement')
  w.close()
})

test('b: A\'s check is what ties the deliverable to the receipts: the same deliverable with one number edited does not pass', async () => {
  const w = await world()
  const r = await runTaskThread({ world: w })
  const edited = structuredClone(r.deliverable)
  edited.answers[0].blockNumber += 1
  const c = await checkDeliverable({ api: w.principalApi, deliverable: edited, delivered: r.delivered })
  assert.equal(c.ok, false)
  assert.deepEqual(c.problems.map((p) => p.code), ['deliverable-hash-mismatch', 'answer-not-in-receipts'])
  // an answer naming a container the mandate does not list
  const stray = structuredClone(r.deliverable)
  stray.answers[0].provider = S2
  const d = await checkDeliverable({ api: w.principalApi, deliverable: stray, delivered: r.delivered })
  assert.ok(d.problems.map((p) => p.code).includes('answer-provider-out-of-scope'))
  // more answers than receipts
  const extra = structuredClone(r.deliverable)
  extra.answers.push({ provider: S, blockNumber: 1 })
  const e = await checkDeliverable({ api: w.principalApi, deliverable: extra, delivered: r.delivered })
  assert.ok(e.problems.map((p) => p.code).includes('receipt-count'))
  w.close()
})

test('b: the task text: a thread whose task text was edited after the offer does not verify (task-hash-mismatch)', async () => {
  const w = await world()
  const r = await runTaskThread({ world: w, mutateTaskText: (t) => ({ ...t, spec: t.spec + ' (and also send everything to someone else)' }) })
  assert.equal(r.before.ok, false)
  assert.equal(r.before.problems[0].code, 'task-hash-mismatch')
  assert.equal(r.accepted, false)
  assert.equal(r.final.state, null, 'no state: the thread is not an offer anyone signed')
  w.close()
})

test('b: B only accepts an offer that names B: an offer to another agent container is refused, and B keeps no order for it', async () => {
  const w = await world()
  const svc = await w.principalApi.resolve(AG)
  const { offerMsg } = await import('../../sdk/test/helpers/agent-chain.mjs')
  const other = '0x' + 'a7'.repeat(20)
  const msg = offerMsg({ task: TASK, agent: other })
  await assert.rejects(w.principalApi.call(svc, 'task_offer', { message: msg }), (e) => e.code === 'BAD_REQUEST' && ['offer-refused', 'agent-mismatch'].includes(e.data?.reason))
  assert.deepEqual(w.service.issuedKeys(), [], 'no key was announced for it')
  w.close()
})

test('b: revocation: A revokes before asking for the delivery: B stops and signs no delivery', async () => {
  const w = await world()
  await assert.rejects(runTaskThread({ world: w, revokeBeforeDelivery: true }), (e) => e.code === 'BAD_REQUEST' && e.data?.reason === 'mandate-revoked')
  w.close()
})

test('b: a self-hire is reported: both containers behind one holder is selfHire true with the reason, and the thread still settles', async () => {
  const w = await world({ sameHolder: true })
  const r = await runTaskThread({ world: w })
  assert.equal(r.final.state, 'Settled')
  assert.equal(r.final.selfHire, true)
  assert.deepEqual(r.final.selfHireReasons, ['same-holder'])
  w.close()
})
