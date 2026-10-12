// examples/agent-service, phase 1 milestone M4 (EXPERIMENTAL, local chains only; the internal phase-1 draft, its
// spend flow, residual windows and milestone M4): one spend order end to end on the SDK's fake chain, with the
// escrow's state changes modelled (sdk/test/helpers/escrow-model.mjs; contracts/test/Phase1Spend.t.sol runs the same kind
// of transactions on the unchanged v3): offer, the holder's plan sent (approve, fund, authorizeSession), the mandate, the
// agent's calls to a priced provider with vouchers its agent key signs through the spend limiter, the provider (L0: the
// reference provider as it ships) settling them, the close-out (requestWithdraw, then withdraw 48 h later). Adversarial
// cases: a leaked key settling directly, a full requestWithdraw stopping the honest provider, cancelWithdraw restarting it
// at once, a lapsed request exposing the channel again, the cap, an escrow change, a price rise. Named FIXED P1M4-Exx;
// each was checked by removing what implements it. Nothing leaves this process; every key is a fixture of the fake chain.
// 阶段 1 的 M4：一单 spend 在假链上端到端（托管状态变化由模型执行）：报价、持有人计划、授权书、代理经限额器签凭证调用收费服务、
// 服务端（L0，原样）结算、收尾取回。对抗用例：泄露的钥匙直接结算、全额提现请求让诚实服务停服、cancelWithdraw 立即恢复、
// 过期请求重新暴露、cap、换托管、涨价。
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { sig, abi } from '@tapeapi/sdk'
import { createDemoWorld, restoreTime, KEYS, AG, S, S2 } from './demo-world.mjs'
import { receiptOfCall } from './agent.mjs'
import { offerMsg, mandateOf, mandateMsg, addrOf, nowS, BEM_TOKEN, nameEscrow, escrowContract, revocationFile, revocationMsg } from '../../sdk/test/helpers/agent-chain.mjs'

afterEach(restoreTime)
const E1 = '0x00000000000000000000000000000000000E5C71', E2 = '0x00000000000000000000000000000000000E5c72'   // checksummed (EIP-55)
const HOLDER = addrOf(KEYS.principalHolder)
const SETTLER = addrOf(KEYS.providerHolder)        // whoever sends settle: anyone may / 任何人都能调 settle
const STRANGER = addrOf(KEYS.stranger)
const PRICE = 10_000n                              // 0.0001 BEM, 8 decimals
const P1 = 'https://provider-1.example'
const D48 = 48 * 3600, D7 = 7 * 86400

// a task that calls provider S `n` times, running hooks[i] before call i, and records each outcome (data only)
// 调用服务 S n 次的任务；第 i 次调用前运行 hooks[i]，记录每次结果（只是数据）
function callsTask(n, hooks = {}) {
  return {
    needsProviders: true,
    async run(task, ctx) {
      const results = []
      for (let i = 0; i < n; i++) {
        if (hooks[i]) await hooks[i]()
        try { const r = await ctx.call(S, 'blockNumber', {}); results.push(Number.isSafeInteger(r?.blockNumber) ? 'ok' : 'bad') } catch (e) { results.push(e?.data?.reason ?? e?.code ?? 'error') }
      }
      return { kind: 'calls', results }
    },
  }
}
const TASK = { kind: 'calls', spec: 'call the provider' }

// The per-call ceiling defaults to 10% of the cap (Bruce, 2026-10-08): a world whose cap is fewer than 10 prices sets
// maxCallPrice to one price explicitly (allowed: above 10% of the cap, never above it), so that its tests stay about
// what they test; `maxCallPrice: null` keeps the default. / 单次上限默认是 cap 的 10%：cap 不足 10 个价格的世界显式把
// maxCallPrice 设为一个价格（允许：高于 10%、不高于 cap），测试仍测原来的东西；null 即用默认值
async function spendWorld({ n = 1, hooks, cap = 10n * PRICE, expires = nowS() + 86400, agentSpend = {}, maxCallPrice = cap < 10n * PRICE ? PRICE.toString() : null } = {}) {
  const w = await createDemoWorld({ spend: { escrow: E1, holderBalance: 10n ** 12n }, agentOptions: { tasks: { calls: callsTask(n, hooks) }, spend: { ...(maxCallPrice !== null ? { maxCallPrice } : {}), ...agentSpend } } })
  const svc = await w.principalApi.resolve(AG)
  const call = (method, params) => w.principalApi.call(svc, method, params)
  return { w, call, cap, expires }
}
// offer, accept, the mandate signed, the holder's plan sent, then the mandate given to the agent: the order works
// 报价、接单、签授权书、发出持有人计划，再把授权书交给代理：开工
async function hireSpend(t, { nonce = '1', scope } = {}) {
  const { w, call } = t
  const offer = offerMsg({ task: TASK, mode: 1, nonce })
  const acc = (await call('task_offer', { message: offer })).result
  const m = mandateOf({ task: TASK, agentKey: acc.agentKey, mode: 1, nonce, scope: scope ?? [{ provider: S, token: BEM_TOKEN, cap: t.cap.toString() }], expires: t.expires })
  const msg = mandateMsg(m)
  const plan = await w.principalKit.holderPlan(m, { holder: HOLDER, path: 'holder', history: [], signed: { mandate: m, sig: msg.sig } })
  for (const step of plan.steps) w.escrow.send(HOLDER, step.tx)
  const applied = await w.principalKit.afterPlan(plan, m)
  assert.deepEqual(applied.problems, [], 'the plan is applied')
  const started = (await call('task_mandate', { offerHash: acc.offerHash, message: msg })).result
  const mandateHash = started.mandateHash
  await w.service.order(mandateHash).work
  return { m, msg, plan, acc, mandateHash, started }
}
// the provider settles what it holds, as its operator's settler would / 服务端按运营方结算程序那样结算
async function settleAll(w) {
  const p = w.providerAt(P1)
  const out = []
  for (const v of await p.pendingSettlements()) { try { out.push(w.escrow.send(SETTLER, p.settleTx(v))) } catch (e) { out.push(e.revert ?? e.message) } }
  return out
}

test('FIXED P1M4-E01: one spend order end to end: offer, plan, mandate, a paid call, settle, delivery, close-out; the holder gets back cap − spent', async () => {
  const t = await spendWorld({ n: 1 })
  const { w, call } = t
  const before = w.escrow.balanceOf(HOLDER)
  const o = await hireSpend(t)
  assert.equal(o.started.enforcement, 'escrow-channel')
  const status = (await call('task_status', { mandateHash: o.mandateHash })).result
  assert.equal(status.state, 'ready')
  // the provider holds one voucher of the agent key for one price, carrying the unsigned mandateHash it ignores
  assert.deepEqual(await settleAll(w), ['settle'])
  assert.equal(w.escrow.claimedOf(HOLDER, S), PRICE)
  assert.equal(w.escrow.channelOf(HOLDER, S), t.cap - PRICE)
  assert.equal(w.escrow.balanceOf(S), PRICE - PRICE / 100n, '1% contribution')
  const delivered = (await call('task_deliver', { mandateHash: o.mandateHash })).result
  assert.equal(delivered.kind, 'tape.agent/deliver')
  // the close-out: requestWithdraw of the whole channel, then withdraw inside [48 h, 48 h + 7 d]
  const c1 = await w.principalKit.closeOut(o.m, { holder: HOLDER, path: 'holder', history: o.plan.record })
  assert.deepEqual(c1.steps.map((s) => s.kind), ['requestWithdraw', 'withdraw'])
  w.escrow.send(HOLDER, c1.steps[0].tx)
  assert.throws(() => w.escrow.send(HOLDER, c1.steps[1].tx), (e) => e.revert === 'CooldownActive')
  w.advance(D48)
  w.escrow.send(HOLDER, c1.steps[1].tx)
  assert.equal(w.escrow.channelOf(HOLDER, S), 0n)
  assert.equal(w.escrow.balanceOf(HOLDER), before - PRICE, 'the holder paid exactly what the agent spent')
})

test('FIXED P1M4-E02: the cap: the agent signs no voucher above claimedAtCheck + cap; the 4th call of 3 prices is refused before any request', async () => {
  const t = await spendWorld({ n: 4, cap: 3n * PRICE })
  const o = await hireSpend(t)
  const order = t.w.service.order(o.mandateHash)
  assert.deepEqual(order.deliverable.results, ['ok', 'ok', 'ok', 'spend-cap-exceeded'])
  assert.deepEqual(t.w.upstreamCalls(), { 'provider-1': 3 }, 'the refused call never reached the provider')
  await settleAll(t.w)
  assert.equal(t.w.escrow.claimedOf(HOLDER, S), 3n * PRICE)
  const rec = await t.w.service.limiter.record({ chainId: 56, agentKey: o.acc.agentKey })
  assert.deepEqual([rec.providers[0].base, rec.providers[0].hi], ['0', (3n * PRICE).toString()])
})

test('FIXED P1M4-E03: a leaked agent key settles every scope channel directly, without the provider; the money goes to the provider, never to the attacker, and no further', async () => {
  const t = await spendWorld({ n: 0, cap: 5n * PRICE })
  const o = await hireSpend(t)
  // the attacker holds the key: here a mandate whose agent key the test made (the agent's own never leaves its runtime)
  const leaked = sig.randomPrivateKey()
  const key = sig.privateKeyToAddress(leaked)
  const m = mandateOf({ task: TASK, agentKey: key, mode: 1, nonce: '9', scope: [{ provider: S2, token: BEM_TOKEN, cap: (5n * PRICE).toString() }], expires: t.expires })
  const plan = await t.w.principalKit.holderPlan(m, { holder: HOLDER, path: 'holder', history: o.plan.record })
  for (const step of plan.steps) t.w.escrow.send(HOLDER, step.tx)
  const voucher = (provider, cumulative) => {
    const v = { consumer: HOLDER, provider, cumulative, expires: nowS() + 3600 }
    return sig.signDigest(sig.voucherDigest(56, E1, v), leaked)
  }
  const settleData = (provider, cumulative) => t.w.providerAt(P1).settleTx({ consumer: HOLDER, provider, cumulative: cumulative.toString(), expires: nowS() + 3600, sig: voucher(provider, cumulative) })
  // the whole channel and more in one voucher: settle pays min(delta, channel) to the provider
  t.w.escrow.send(STRANGER, settleData(S2, 50n * PRICE))
  assert.equal(t.w.escrow.channelOf(HOLDER, S2), 0n)
  assert.equal(t.w.escrow.balanceOf(STRANGER), 0n, 'the attacker gains nothing unless it controls a scope provider')
  assert.equal(t.w.escrow.balanceOf(S2), 5n * PRICE - (5n * PRICE) / 100n)
  // the key has no session on the first mandate's channel (S) nor anywhere else: no voucher of it settles there
  assert.throws(() => t.w.escrow.send(STRANGER, settleData(S, PRICE)), (e) => e.revert === 'BadSignature')
  // and the second voucher finds nothing left
  assert.throws(() => t.w.escrow.send(STRANGER, settleData(S2, 60n * PRICE)), (e) => e.revert === 'InsufficientBalance')
})

test('FIXED P1M4-E04: a full requestWithdraw stops the honest L0 provider and the agent; cancelWithdraw restarts both at once (draft §2.6 rows 3, 4)', async () => {
  let t
  const req = () => { t.w.escrow.send(HOLDER, { to: E1, data: encode('requestWithdraw', [S, t.w.escrow.channelOf(HOLDER, S)]) }) }
  const cancel = () => { t.w.escrow.send(HOLDER, { to: E1, data: encode('cancelWithdraw', [S]) }) }
  t = await spendWorld({ n: 4, hooks: { 1: req, 3: cancel } })
  const o = await hireSpend(t)
  // calls 1 and 2 (after the request): the agent's own check refuses the step (withdraw-pending), the order is not stopped
  assert.deepEqual(t.w.service.order(o.mandateHash).deliverable.results, ['ok', 'mandate-not-valid', 'mandate-not-valid', 'ok'])
  assert.equal(t.w.service.order(o.mandateHash).state, 'ready')
  // the provider itself, given a voucher of the same channel while the request is live (a payer that does not check):
  // BAD_VOUCHER, nothing available; after cancelWithdraw it serves at once
  const direct = await directPayer(t)
  req()
  await assert.rejects(direct.call(), (e) => e.code === 'BAD_VOUCHER' && /available channel 0/.test(e.message))
  cancel()
  assert.equal((await direct.call()).verified, true)
})

test('FIXED P1M4-E05: a request not withdrawn within 48 h + 7 d lapses: the provider serves the key again and the key can spend the channel (R21, §2.6 row 6)', async () => {
  const t = await spendWorld({ n: 1, expires: nowS() + 20 * 86400 })
  const o = await hireSpend(t)
  const direct = await directPayer(t)
  t.w.escrow.send(HOLDER, { to: E1, data: encode('requestWithdraw', [S, t.w.escrow.channelOf(HOLDER, S)]) })
  await assert.rejects(direct.call(), (e) => e.code === 'BAD_VOUCHER')
  t.w.advance(D48 + D7 + 1)
  // the escrow keeps the lapsed request in its view; withdraw can no longer run, and the money is exposed again
  assert.notEqual(t.w.escrow.pendingOf(HOLDER, S)[1], 0n)
  assert.throws(() => t.w.escrow.send(HOLDER, { to: E1, data: encode('withdraw', [S]) }), (e) => e.revert === 'WithdrawWindowClosed')
  assert.equal((await direct.call()).verified, true)
  await settleAll(t.w)
  assert.equal(t.w.escrow.claimedOf(HOLDER, S), 2n * PRICE)
})

test('FIXED P1M4-E06: the provider names another escrow mid-order: the agent stops the order for good and signs nothing more (R23)', async () => {
  let t
  const move = () => { escrowContract(t.w.x, E2, BEM_TOKEN); nameEscrow(t.w.x, S, E2) }
  t = await spendWorld({ n: 3, hooks: { 1: move } })
  const o = await hireSpend(t)
  const order = t.w.service.order(o.mandateHash)
  assert.deepEqual(order.deliverable.results, ['ok', 'spend-stopped', 'spend-stopped'])
  assert.equal(order.state, 'stopped')
  assert.deepEqual(order.stopped.reasons, ['spend-escrow-changed'])
  assert.deepEqual(t.w.upstreamCalls(), { 'provider-1': 1 })
  await assert.rejects(t.call('task_deliver', { mandateHash: o.mandateHash }), (e) => e.data?.reason === 'spend-stopped')
  const status = (await t.call('task_status', { mandateHash: o.mandateHash })).result
  assert.deepEqual(status.stopped.reasons, ['spend-escrow-changed'])
})

test('FIXED P1M4-E07: a provider that raises its price is not paid the new price without consent (PRICE_CHANGED), whatever its error says', async () => {
  let t
  // the holder of S publishes ten times the price; an hour later the agent's client re-reads the manifest (TAPI-20 §3.6, MANIFEST_TTL_MS)
  // S 的持有人把价格提到十倍；一小时后代理的客户端重读清单
  const raise = async () => {
    await settleAll(t.w)   // the provider settles before its vouchers expire / 服务端在凭证到期前结算
    const m = { ...t.w.providerAt(P1).manifest }
    m.methods = [{ ...m.methods[0], priceBEM: '0.001' }]
    t.w.x.chain.writeFile(S, '.well-known/tapeapi.json', JSON.stringify(m))
    t.w.advance(3601)
  }
  t = await spendWorld({ n: 2, hooks: { 1: raise }, cap: 100n * PRICE })   // room for the new price: only consent refuses it
  const o = await hireSpend(t)
  assert.deepEqual(t.w.service.order(o.mandateHash).deliverable.results, ['ok', 'PRICE_CHANGED'])
  await settleAll(t.w)
  assert.equal(t.w.escrow.claimedOf(HOLDER, S), PRICE)
})

test('FIXED P1M4-E08: a mandate that names no funds stays phase 0 in a spend-enabled runtime: enforcement none, no payer, the key dropped', async () => {
  const t = await spendWorld({ n: 0 })
  const offer = offerMsg({ task: TASK, mode: 0, nonce: '5' })
  const acc = (await t.call('task_offer', { message: offer })).result
  const m = mandateOf({ task: TASK, agentKey: acc.agentKey, nonce: '5', scope: [{ provider: S, token: '0x' + '00'.repeat(20), cap: '0' }] })
  const r = (await t.call('task_mandate', { offerHash: acc.offerHash, message: mandateMsg(m) })).result
  assert.equal(r.enforcement, 'none')
  assert.equal('payer' in t.w.service.order(r.mandateHash), false)
  assert.equal(t.w.service.order(r.mandateHash).spend, undefined)
})

test('FIXED P1M4-E09: a spend order delivers after its whole cap was spent and settled (an empty channel is not a reason to withhold the delivery)', async () => {
  const t = await spendWorld({ n: 3, cap: 3n * PRICE })
  const o = await hireSpend(t)
  assert.deepEqual(t.w.service.order(o.mandateHash).deliverable.results, ['ok', 'ok', 'ok'])
  await settleAll(t.w)
  assert.equal(t.w.escrow.channelOf(HOLDER, S), 0n)
  const d = (await t.call('task_deliver', { mandateHash: o.mandateHash })).result
  assert.equal(d.kind, 'tape.agent/deliver')
})

test('FIXED P1M4-E10: a spend order delivers while the principal closes out (a live full request); a revoked one does not', async () => {
  const t = await spendWorld({ n: 1, cap: 5n * PRICE })
  const o = await hireSpend(t)
  t.w.escrow.send(HOLDER, { to: E1, data: encode('requestWithdraw', [S, t.w.escrow.channelOf(HOLDER, S)]) })
  const d = (await t.call('task_deliver', { mandateHash: o.mandateHash })).result
  assert.equal(d.kind, 'tape.agent/deliver')
  // a revocation still stops the delivery of another order / 撤销仍然挡住交付
  const t2 = await spendWorld({ n: 1, cap: 5n * PRICE })
  const o2 = await hireSpend(t2)
  revocationFile(t2.w.x, { mandateHashes: [o2.mandateHash] })
  await assert.rejects(t2.call('task_deliver', { mandateHash: o2.mandateHash }), (e) => e.data?.reason === 'mandate-revoked')
})

test('FIXED P1M4-E11: a revocation received directly (task_status) stops the limiter\'s record too: nothing on its store signs for the key again', async () => {
  const t = await spendWorld({ n: 1, cap: 5n * PRICE })
  const o = await hireSpend(t)
  const st = (await t.call('task_status', { mandateHash: o.mandateHash, revocation: revocationMsg({ mandateHashes: [o.mandateHash] }) })).result
  assert.equal(st.state, 'revoked')
  const rec = await t.w.service.limiter.record({ chainId: 56, agentKey: o.acc.agentKey })
  assert.deepEqual(rec.stopped.reasons, ['spend-revoked'])
  // a restart of the same mandate on that store is refused / 同一存储上重新开工被拒绝
  const c = await t.w.principalKit.verifyMandate({ mandate: o.m, sig: o.msg.sig }, { enforcement: 'escrow-channel', readSite: false })
  await assert.rejects(t.w.service.limiter.start({ chainId: 56, check: c }), (e) => e.data?.reason === 'spend-stopped')
})

// M7 (draft §6.1 S8): the delivery states what the channel paid since the work started; the principal's thread check
// reconciles it with the chain and with the receipts at the manifest's price. Built as hire.mjs builds a thread.
// M7：交付写明开工以来通道付出的金额；委托方核验线程时与链上读数、回执 × 清单单价对账（照 hire.mjs 组装线程）。
async function threadOf(t, { settleBefore = true } = {}) {
  const { w } = t
  const svc = await w.principalApi.resolve(AG)
  const offer = offerMsg({ task: TASK, mode: 1, nonce: '5' })
  const accR = await w.principalApi.call(svc, 'task_offer', { message: offer })
  const m = mandateOf({ task: TASK, agentKey: accR.result.agentKey, mode: 1, nonce: '5', scope: [{ provider: S, token: BEM_TOKEN, cap: t.cap.toString() }], expires: t.expires })
  const msg = mandateMsg(m)
  const plan = await w.principalKit.holderPlan(m, { holder: HOLDER, path: 'holder', history: [], signed: { mandate: m, sig: msg.sig } })
  for (const step of plan.steps) w.escrow.send(HOLDER, step.tx)
  const started = (await w.principalApi.call(svc, 'task_mandate', { offerHash: accR.result.offerHash, message: msg })).result
  await w.service.order(started.mandateHash).work
  if (settleBefore) await settleAll(w)
  const delParams = { mandateHash: started.mandateHash }
  const delR = await w.principalApi.call(svc, 'task_deliver', delParams)
  const thread = [offer, { v: 0, kind: 'tape.agent/accept', receipt: receiptOfCall(svc, 'task_offer', { message: offer }, accR) }, msg, { v: 0, kind: 'tape.agent/deliver', receipt: receiptOfCall(svc, 'task_deliver', delParams, delR) }]
  return { m, thread, delivered: delR.result }
}

test('FIXED P1M7-E01: a spend delivery states what its channel paid since the start; the thread check finds it equal to 3 receipted calls at the manifest price', async () => {
  const t = await spendWorld({ n: 3 })
  const { delivered, thread } = await threadOf(t)
  assert.deepEqual(delivered.spend, [{ provider: abi.checksumAddress(S), escrow: E1, claimedAtStart: '0', claimedAtDelivery: (3n * PRICE).toString(), spent: (3n * PRICE).toString() }])
  // the statement is signed with the delivery and is not under receiptsHash / 说明随交付签名，不在 receiptsHash 里
  assert.equal(delivered.receipts.length, 3)
  const r = await t.w.principalKit.verifyTaskThread(thread, { enforcement: 'escrow-channel' })
  assert.deepEqual(r.problems.map((p) => p.code), []); assert.equal(r.state, 'Delivered'); assert.equal(r.enforcement, 'escrow-channel')
  assert.equal(r.scope[0].claimedAtCheck, (3n * PRICE).toString())
  assert.deepEqual(r.evidence.spend.warnings, [])
  assert.equal(r.evidence.spend.items[0].reconciled, 'equal'); assert.equal(r.evidence.spend.items[0].expected, (3n * PRICE).toString()); assert.equal(r.evidence.spend.items[0].calls, 3)
})

test('FIXED P1M7-E02: delivered before the provider settled: the statement says 0, the check says below the receipts until the provider settles', async () => {
  const t = await spendWorld({ n: 2 })
  const { delivered, thread } = await threadOf(t, { settleBefore: false })
  assert.equal(delivered.spend[0].spent, '0')
  const before = await t.w.principalKit.verifyTaskThread(thread, { enforcement: 'escrow-channel' })
  assert.deepEqual(before.problems.map((p) => p.code), [])
  assert.deepEqual(before.evidence.spend.warnings.map((w) => w.code), ['spend-below-receipts'])
  // the provider settles later (TAPI-22 gives it 48 hours): the same delivery now reconciles / 之后结算：同一交付对上了
  await settleAll(t.w)
  const after = await t.w.principalKit.verifyTaskThread(thread, { enforcement: 'escrow-channel' })
  assert.deepEqual(after.evidence.spend.warnings, []); assert.equal(after.evidence.spend.items[0].spentNow, (2n * PRICE).toString())
  assert.equal(after.evidence.spend.items[0].spent, '0', 'the signed statement does not change')
})

test('FIXED P1M7-E03: a phase-0 order delivers no spend statement (the deliver result is as before)', async () => {
  const t = await spendWorld({ n: 1 })
  const offer = offerMsg({ task: TASK, mode: 0, nonce: '9' })
  const acc = (await t.call('task_offer', { message: offer })).result
  const m = mandateOf({ task: TASK, agentKey: acc.agentKey, mode: 0, nonce: '9', expires: t.expires })
  const r = (await t.call('task_mandate', { offerHash: acc.offerHash, message: mandateMsg(m) })).result
  assert.equal(r.enforcement, 'none')
  await t.w.service.order(r.mandateHash).work
  const d = (await t.call('task_deliver', { mandateHash: r.mandateHash })).result
  assert.deepEqual(Object.keys(d).sort(), ['deliverableHash', 'exp', 'kind', 'mandateHash', 'receipts', 'receiptsHash'])
})

// ---- helpers / 辅助 ----
function encode(fn, args) {
  const types = { requestWithdraw: ['address', 'uint256'], cancelWithdraw: ['address'], withdraw: ['address'] }[fn]
  return abi.selector(`${fn}(${types.join(',')})`) + abi.bytesToHex(abi.encodeParams(types, args))
}
// A second agent runtime on the same channel cannot exist (one key per mandate); to show the provider's own rule, the
// test drives the SDK parts the agent uses (api.payer with an agent key, the limiter) itself: a mandate with a key the
// test holds, funded on the same escrow for provider S. / 为展示服务端自己的规则，测试直接驱动代理用的 SDK 部件。
async function directPayer(t) {
  const k = sig.randomPrivateKey(), key = sig.privateKeyToAddress(k)
  const m = mandateOf({ task: TASK, agentKey: key, mode: 1, nonce: '77', scope: [{ provider: S, token: BEM_TOKEN, cap: (10n * PRICE).toString() }], expires: t.expires })
  // the same channel (HOLDER, S): the first mandate's session is live there, so the plan refuses (channel-session-live,
  // §2.3 rule 3); this test authorises its key by hand, as a holder breaking that rule would
  t.w.escrow.send(HOLDER, { to: E1, data: abi.selector('authorizeSession(address,address,uint64)') + abi.bytesToHex(abi.encodeParams(['address', 'address', 'uint64'], [S, key, BigInt(m.expires)])) })
  const svc = await t.w.agentApi.resolve(S)
  const payer = t.w.agentApi.payer({ consumer: HOLDER, sessionKey: k })
  // the channel's meter is shared by every key on it: resume from what the provider holds (the agent's last voucher)
  // 通道的计量由其上所有钥匙共用：从服务端持有的最后一张凭证接着计
  const held = await t.w.providerAt(P1).store.get(HOLDER, S)
  await payer.setCumulative(svc, held ? BigInt(held.cumulative) : t.w.escrow.claimedOf(HOLDER, S))
  return { call: () => t.w.agentApi.call(svc, 'blockNumber', {}, { payer }) }
}

test('FIXED P1CP-E01: without maxCallPrice a provider priced above 10% of the cap is never paid: the call is refused before any request, the order is not stopped; with it the same order pays', async () => {
  // cap 5 prices: the default per-call ceiling is half a price / cap 为 5 个价格：默认单次上限是半个价格
  const t = await spendWorld({ n: 2, cap: 5n * PRICE, maxCallPrice: null })
  const o = await hireSpend(t)
  const order = t.w.service.order(o.mandateHash)
  assert.deepEqual(order.deliverable.results, ['spend-call-price-above-ceiling', 'spend-call-price-above-ceiling'])
  assert.deepEqual(t.w.upstreamCalls(), {}, 'no request reached the provider')
  assert.equal(order.state, 'ready', 'not stopped: a price above the ceiling refuses the step only')
  const rec = await t.w.service.limiter.record({ chainId: 56, agentKey: o.acc.agentKey })
  assert.equal(rec.stopped, null)
  // the same world with maxCallPrice of one price (20% of the cap, allowed) / 同一世界显式给一个价格（cap 的 20%，允许）
  const u = await spendWorld({ n: 2, cap: 5n * PRICE, maxCallPrice: PRICE.toString() })
  const p = await hireSpend(u)
  assert.deepEqual(u.w.service.order(p.mandateHash).deliverable.results, ['ok', 'ok'])
  // a maxCallPrice above the cap pays nothing / 高于 cap 的 maxCallPrice 什么都不付
  const v = await spendWorld({ n: 1, cap: 5n * PRICE, maxCallPrice: (6n * PRICE).toString() })
  const q = await hireSpend(v)
  assert.deepEqual(v.w.service.order(q.mandateHash).deliverable.results, ['spend-call-price-ceiling-above-cap'])
})
