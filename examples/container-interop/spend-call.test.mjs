// Scenario (a), end to end on the SDK's fake chain: container A's agent calls container B's paid method inside the cap A's
// holder signed (EXPERIMENTAL, phase 1; local chain model only: the escrow contract is not audited and not deployed).
// Nothing leaves this process; every key is a fixture. Each test opens one world (the world holds Date.now at its fixed clock).
// 场景 (a) 的端到端测试（SDK 假链）：容器 A 的代理在 A 的持有人签署的 cap 之内调用容器 B 的付费方法（实验性，阶段 1；只在本地链模型上，
// 托管合约没有经过审计、也没有部署）。不出本进程；密钥都是夹具。每个测试开一个世界。
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { sig } from '@tapeapi/sdk'
import { createSpendWorld, runSpendCall, closeOut, settleAll, PRICE, HOLDER, revokeOnSite } from './spend-call.mjs'
import { verifyReceipt } from './receipts.mjs'
import { restoreTime, S, S2, AG } from './world.mjs'

afterEach(restoreTime)
const P1 = 'https://provider-1.example'

test('a: three paid calls inside a cap of ten: every call is one voucher, the receipts verify, the spend reconciles, A gets back cap minus spent', async () => {
  const w = await createSpendWorld({ n: 3, cap: 10n })
  const lines = []
  const holderBefore = w.escrow.balanceOf(HOLDER)
  const r = await runSpendCall({ world: w, cap: 10n, print: (l) => lines.push(l) })
  // the call sequence: offer, mandate, funding, start, three calls, settlement, delivery, checks
  assert.deepEqual(r.steps.map((s) => s.actor), ['A -> A\'', 'A', 'A (wallet)', 'A\'', 'A\' -> B', 'A\' -> B', 'A\' -> B', 'B', 'A\' -> A', 'A', 'A'])
  assert.deepEqual(r.plan.steps.map((s) => s.kind), ['approve', 'fund', 'authorizeSession'], 'the holder funds ONE channel and authorises the agentKey on it')
  assert.equal(r.started.enforcement, 'escrow-channel')
  assert.deepEqual(r.results.map((x) => x.ok), [true, true, true])
  assert.deepEqual(r.upstream, { 'provider-1': 3 }, 'B answered three requests, one voucher each')
  // what A's agent signed for B is exactly three prices, and B holds them until it settles (here it has)
  assert.equal(w.escrow.claimedOf(HOLDER, S), 3n * PRICE)
  assert.equal(w.escrow.channelOf(HOLDER, S), 7n * PRICE)
  assert.equal(r.delivered.spend[0].spent, (3n * PRICE).toString())
  // receipts: three, each signed by the signer B's manifest publishes now, for method blockNumber with params {}
  assert.equal(r.delivered.receipts.length, 3)
  assert.deepEqual(r.receiptChecks.map((c) => c.ok), [true, true, true])
  const svc = await w.principalApi.resolve(S)
  assert.ok(r.receiptChecks.every((c) => c.signer.toLowerCase() === svc.manifest.signer.toLowerCase()))
  // the thread check reconciles the statement with the chain and with receipts x manifest price
  assert.deepEqual(r.check.problems.map((p) => p.code), [])
  assert.equal(r.check.state, 'Delivered')
  assert.equal(r.check.enforcement, 'escrow-channel')
  const item = r.check.evidence.spend.items[0]
  assert.deepEqual([item.reconciled, item.calls, item.expected, item.spentNow], ['equal', 3, (3n * PRICE).toString(), (3n * PRICE).toString()])
  // close-out: the holder gets back the unspent channel; it paid exactly what the agent spent
  const c = await closeOut(w, r)
  assert.deepEqual(c.steps, ['requestWithdraw', 'withdraw'])
  assert.equal(c.returned, 7n * PRICE)
  assert.equal(w.escrow.balanceOf(HOLDER), holderBefore - 3n * PRICE)
  assert.ok(lines.length === r.steps.length)
  w.close()
})

test('a: the cap: five calls at a cap of three: the fourth and fifth are refused before any request, B answered three', async () => {
  const w = await createSpendWorld({ n: 5, cap: 3n })
  const r = await runSpendCall({ world: w, cap: 3n })
  assert.deepEqual(r.results.map((x) => x.ok ? 'ok' : x.reason), ['ok', 'ok', 'ok', 'spend-cap-exceeded', 'spend-cap-exceeded'])
  assert.deepEqual(w.upstreamCalls(), { 'provider-1': 3 }, 'the refused calls never reached B')
  assert.equal(r.delivered.receipts.length, 3)
  const rec = await w.service.limiter.record({ chainId: 56, agentKey: r.accept.agentKey })
  assert.deepEqual([rec.providers[0].base, rec.providers[0].hi], ['0', (3n * PRICE).toString()], 'the key signed up to claimedAtStart + cap and no further')
  assert.equal(w.escrow.claimedOf(HOLDER, S), 3n * PRICE)
  assert.equal(w.escrow.channelOf(HOLDER, S), 0n)
  w.close()
})

test('a: a cap spent in full and settled leaves the principal\'s thread check with nothing to read: channel-empty, Accepted (point in time)', async () => {
  // CONFIRMED: not a failure of the order (the agent delivered, B was paid, A paid exactly the cap): the check reads the funded
  // channel NOW, and a channel spent in full has no funds and (after settlement) nothing to pin. See README, Gaps.
  const w = await createSpendWorld({ n: 3, cap: 3n })
  const r = await runSpendCall({ world: w, cap: 3n })
  assert.equal(r.delivered.spend[0].spent, (3n * PRICE).toString())
  assert.equal(r.check.ok, false)
  assert.equal(r.check.state, 'Accepted')
  assert.deepEqual(r.check.problems.map((p) => p.code), ['channel-empty', 'out-of-order'])
  // before B settles, the same delivery verifies, with a warning that the statement is below the receipts
  const u = await createSpendWorld({ n: 3, cap: 3n })
  const unsettled = await runSpendCall({ world: u, cap: 3n, settleBefore: false })
  assert.equal(unsettled.check.ok, true)
  assert.deepEqual(unsettled.check.evidence.spend.warnings.map((x) => x.code), ['spend-below-receipts'])
  w.close()
})

test('a: after close-out the same thread no longer verifies as funded (point in time), while every receipt still does', async () => {
  const w = await createSpendWorld({ n: 3, cap: 10n })
  const r = await runSpendCall({ world: w, cap: 10n })
  assert.equal(r.check.ok, true)
  await closeOut(w, r)
  const later = await w.principalKit.verifyTaskThread(r.thread, { enforcement: 'escrow-channel' })
  assert.equal(later.ok, false)
  assert.ok(later.problems.map((p) => p.code).includes('session-missing'), 'the key has no live session after the close-out')
  // the receipts are signatures of B and do not depend on the channel
  for (const rec of r.delivered.receipts) assert.equal((await verifyReceipt(w.principalApi, rec, { container: S, method: 'blockNumber', params: {} })).ok, true)
  w.close()
})

test('a: per-call ceiling: with no maxCallPrice the runtime pays no price above 10% of the cap; a cap of five prices pays nothing', async () => {
  const w = await createSpendWorld({ n: 2, cap: 5n, maxCallPrice: null })
  const r = await runSpendCall({ world: w, cap: 5n })
  assert.deepEqual(r.results.map((x) => x.reason), ['spend-call-price-above-ceiling', 'spend-call-price-above-ceiling'])
  assert.deepEqual(w.upstreamCalls(), {}, 'no request reached B')
  assert.equal(r.order.state, 'delivered', 'a price above the ceiling refuses the step only; the order is not stopped and still delivers')
  assert.equal(r.order.stopped, undefined)
  w.close()
})

test('a: scope: the task asks for a container the mandate does not list: refused before any request', async () => {
  const w = await createSpendWorld({ n: 2, cap: 10n, target: S2 })
  const r = await runSpendCall({ world: w, cap: 10n })
  assert.deepEqual(r.results.map((x) => x.reason), ['out-of-scope', 'out-of-scope'])
  assert.deepEqual(w.upstreamCalls(), {})
  assert.equal(w.requests.some((u) => u.startsWith('https://provider-2.example')), false, 'the other container was never contacted')
  w.close()
})

test('a: revocation: A\'s holder publishes the list mid-order: the agent signs nothing more and refuses the delivery; B saw one call', async () => {
  let w
  const lines = []
  w = await createSpendWorld({ n: 3, cap: 10n, hooks: { 1: () => revokeOnSite(w, { before: w.clock() }) } })
  await assert.rejects(runSpendCall({ world: w, cap: 10n, print: (l) => lines.push(l) }), (e) => e.code === 'BAD_REQUEST' && e.data?.reason === 'mandate-revoked')
  assert.ok(lines.some((l) => /call 2: refused before any request \(mandate-revoked\)/.test(l)))
  assert.ok(lines.some((l) => /call 3: refused before any request \(mandate-revoked\)/.test(l)))
  assert.deepEqual(w.upstreamCalls(), { 'provider-1': 1 }, 'only the call before the revocation reached B')
  w.close()
})

test('a: receipts: every way a receipt can be made not to verify, is refused (another body, another request, another container, another id)', async () => {
  const w = await createSpendWorld({ n: 1, cap: 10n })
  const r = await runSpendCall({ world: w, cap: 10n })
  const [rec] = r.delivered.receipts
  const api = w.principalApi
  const good = { container: S, method: 'blockNumber', params: {} }
  assert.equal((await verifyReceipt(api, rec, good)).ok, true)
  // 1. the body: a different answer than the one B signed
  const t1 = await verifyReceipt(api, { ...rec, bodyHash: sig.responseBodyHash({ blockNumber: 1 }) }, good)
  assert.equal(t1.ok, false); assert.match(t1.problems.join(' '), /signed by|does not recover/)
  // 2. the request: the same receipt offered as the answer to other params
  const t2 = await verifyReceipt(api, rec, { ...good, params: { block: 1 } })
  assert.equal(t2.ok, false); assert.match(t2.problems.join(' '), /not the request that was made/)
  // 3. the container: the receipt relabelled to another container
  const t3 = await verifyReceipt(api, { ...rec, service: { ...rec.service, container: S2 } }, { ...good, container: S2 })
  assert.equal(t3.ok, false)
  const t3b = await verifyReceipt(api, rec, { ...good, container: S2 })
  assert.equal(t3b.ok, false); assert.match(t3b.problems.join(' '), /expected/)
  // 4. the id: an answer to another request id
  const t4 = await verifyReceipt(api, rec, { ...good, id: 'another-id' })
  assert.equal(t4.ok, false); assert.match(t4.problems.join(' '), /answers request id/)
  // 5. the time: moved
  const t5 = await verifyReceipt(api, { ...rec, ts: rec.ts + 1 }, good)
  assert.equal(t5.ok, false)
  // and the agent container itself is not B: the delivery's signer is the agent's, and it is a different key
  assert.notEqual((await api.resolve(AG)).manifest.signer.toLowerCase(), (await api.resolve(S)).manifest.signer.toLowerCase())
  w.close()
})

test('a: B itself: it is paid per voucher and settles what it holds; the amount B was paid is what A\'s statement says', async () => {
  const w = await createSpendWorld({ n: 2, cap: 10n })
  const r = await runSpendCall({ world: w, cap: 10n, settleBefore: false })
  const pending = await w.providerAt(P1).pendingSettlements()
  assert.equal(pending.length, 1, 'B holds one cumulative voucher for the channel')
  assert.equal(BigInt(pending[0].cumulative), 2n * PRICE)
  assert.deepEqual(await settleAll(w), ['settle'])
  assert.equal(w.escrow.claimedOf(HOLDER, S), 2n * PRICE)
  assert.equal(w.escrow.balanceOf(S), 2n * PRICE - (2n * PRICE) / 100n, '1% contribution, as the escrow model charges it')
  assert.equal(r.delivered.spend[0].spent, '0', 'the statement was made before B settled; it does not change afterwards')
  w.close()
})
