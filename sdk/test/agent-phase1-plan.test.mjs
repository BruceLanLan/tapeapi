// Container agents, phase 1, milestone M3 (experimental, internal design notes, phase 1, §2.3-§2.6,
// §6.1 S4/S4b): the holder's plan with the facts read on chain, its close-out, the read-back after it and the console's
// session history. Pure functions against the vectors here; the kit (createAgentKit(api).holderPlan, closeOut,
// afterPlan, sessionLogs) on the fake chain in the second half. contracts/test/Phase1Plan.t.sol executes the very
// transactions these plans build on the unchanged v3 escrow. Every case named FIXED P1M3-xx was checked by removing the
// line that implements it (the test turns red). Every clock is fixed.
// 容器代理阶段 1 的 M3：带链上事实的持有人计划、收尾计划、计划后的读回与控制台会话历史。前半是纯函数对向量，后半是假链上的 kit。
// Phase1Plan.t.sol 在未改的 v3 托管上执行这些计划构造的交易。FIXED P1M3-xx 都做过反向检查；时钟固定。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as agent from '@tapeapi/sdk/agent'
import { decodeCall, decodeParams, hexToBytes } from '../src/abi.js'

const { escrowPlan, closeOutPlan, planApplied, sessionHistory, sessionEntry } = agent
const vectors = JSON.parse(readFileSync(new URL('../../spec/vectors/container-agent.json', import.meta.url), 'utf8')).phase1
const eqTo = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const reason = (f) => { try { f(); return 'ACCEPTED' } catch (e) { return e.data?.reason ?? e.code } }
const innerOf = (tx, principal) => {
  if (!eqTo(tx.to, principal)) return tx
  const [to, value, data, op] = decodeParams(['address', 'uint256', 'bytes', 'uint8'], hexToBytes('0x' + tx.data.slice(10)))
  assert.equal(value, 0n); assert.equal(Number(op), 0)
  return { to, data: typeof data === 'string' ? data : '0x' + Buffer.from(data).toString('hex') }
}
const planOpts = (c, base) => ({
  chainId: base.chainId, path: c.path, providers: c.providers, allowEscrows: base.allowEscrows,
  ...(c.path === 'holder' ? { holder: base.holder } : { executeFee: base.executeFee, maxExecuteFee: base.maxExecuteFee, holder: c.holder ?? base.holder }),
  ...(c.now !== undefined ? { now: c.now } : {}), ...(c.facts ?? {}), ...(c.history ? { history: c.history, hub: base.hub } : {}),
})

test('FIXED P1M3-01: one constant is the default funding path of the plan, the close-out and the check (pending decision D3)', () => {
  assert.equal(agent.DEFAULT_FUNDING_PATH, 'holder')
  assert.deepEqual([...agent.FUNDING_PATHS], ['holder', 'container'])
  assert.equal(agent.ESCROW_PLAN_PATHS, agent.FUNDING_PATHS)
  const c = vectors.plan[0], base = vectors.planBase
  // without `path`, the plan and the close-out take the constant / 不给 path 时取这个常量
  assert.equal(escrowPlan(c.mandate, { chainId: 56, holder: base.holder, providers: c.providers, allowEscrows: base.allowEscrows }).path, agent.DEFAULT_FUNDING_PATH)
  const cb = vectors.closeOutBase, k = vectors.closeOut[0]
  assert.equal(closeOutPlan(k.mandate, { chainId: 56, holder: cb.holder, now: cb.now, channels: k.channels }).path, agent.DEFAULT_FUNDING_PATH)
})

test('FIXED P1M3-02: the plan lists the history entries to record, with this mandate\'s hash when the hub is given', () => {
  const base = vectors.planBase
  const c = vectors.plan.find((x) => x.name.startsWith('S4b the key recorded for this very mandate'))
  const plan = escrowPlan(c.mandate, planOpts(c, base))
  assert.equal(plan.mandateHash, agent.mandateHashOf(56, base.hub, c.mandate))
  assert.deepEqual(plan.record.map(sessionEntry), [sessionEntry({ chainId: 56, escrow: c.providers[0].escrow, consumer: base.holder, provider: c.providers[0].provider, key: c.mandate.agentKey, expires: c.mandate.expires, mandateHash: plan.mandateHash })])
  // recorded, the plan of the same mandate still passes; another mandate with that key is key-reused
  // 记下之后同一授权书的计划照样通过；同一钥匙的另一张授权书即 key-reused
  const h = sessionHistory(); h.record(plan.record)
  assert.equal(escrowPlan(c.mandate, { ...planOpts(c, base), history: h.entries() }).steps.length, 3)
  assert.equal(reason(() => escrowPlan({ ...c.mandate, nonce: '99' }, { ...planOpts(c, base), history: h.entries() })), 'key-reused')
  // without the hub there is no hash, and a history cannot be used / 没有 hub 就没有哈希，也不能用历史
  assert.equal(escrowPlan(c.mandate, { ...planOpts(c, base), history: undefined, hub: undefined }).mandateHash, null)
  assert.equal(reason(() => escrowPlan(c.mandate, { ...planOpts(c, base), hub: undefined })), 'INVALID_ARGUMENT')
  assert.equal(reason(() => escrowPlan(c.mandate, { ...planOpts(c, base), now: undefined })), 'INVALID_ARGUMENT')
})

test('FIXED P1M3-03: the session history keeps one entry per session, a log entry (no hash) adds nothing to one recorded with its hash, and it is plain JSON', () => {
  const base = vectors.planBase
  const e = { chainId: 56, escrow: base.allowEscrows[0], consumer: base.holder, provider: '0x00000000000000000000000000000000000005e1', key: '0xAe72A48c1a36bd18Af168541c53037965d26e4A8', expires: 1789086400, mandateHash: '0x' + 'ab'.repeat(32) }
  const h = sessionHistory([e])
  h.record([e, { ...e, mandateHash: null }, { ...e, escrow: e.escrow.toLowerCase() }])
  assert.equal(h.entries().length, 1)
  h.record({ ...e, expires: e.expires + 1, mandateHash: null })
  assert.equal(h.entries().length, 2)
  assert.deepEqual(JSON.parse(JSON.stringify(h.entries())), h.entries())
  assert.deepEqual(sessionHistory(h.entries()).entries(), h.entries())
  for (const bad of [{ ...e, chainId: 0 }, { ...e, key: '0x' + '00'.repeat(20) }, { ...e, expires: -1 }, { ...e, mandateHash: '0x12' }, null]) assert.throws(() => sessionHistory([bad]), (x) => x.code === 'INVALID_ARGUMENT')
})

test('FIXED P1M3-04: every phase1.closeOut vector: the steps in order, each channel\'s state, its withdraw window, where each goes, or the reason it is refused', () => {
  const cb = vectors.closeOutBase
  assert.ok(vectors.closeOut.length >= 10)
  for (const c of vectors.closeOut) {
    const opts = { chainId: cb.chainId, path: c.path, now: cb.now, channels: c.channels, ...(c.path === 'holder' ? { holder: cb.holder } : { executeFee: cb.executeFee, maxExecuteFee: cb.maxExecuteFee, holder: c.holder ?? cb.holder }), ...(c.facts ?? {}), ...(c.history ? { history: c.history } : {}), ...(c.fullRequest !== undefined ? { fullRequest: c.fullRequest } : {}) }
    if (c.expect.refused) { assert.equal(reason(() => closeOutPlan(c.mandate, opts)), c.expect.refused, c.name); continue }
    const plan = closeOutPlan(c.mandate, opts)
    const lc = (row) => row.map((v) => (typeof v === 'string' ? v.toLowerCase() : v))
    assert.deepEqual(plan.steps.map((s) => lc([s.kind, s.provider, s.kind === 'withdraw' ? null : s.amount])), c.expect.steps.map(lc), c.name)
    assert.deepEqual(plan.items.map((it) => lc([it.provider, it.state, it.amount ?? null, it.remaining])), c.expect.items.map(lc), c.name)
    if (c.expect.fees) assert.deepEqual(plan.fees, c.expect.fees, c.name)
    if (c.expect.checked) assert.deepEqual(plan.checked, c.expect.checked, c.name)
    for (const [prov, from, until] of c.expect.windows ?? []) {
      const it = plan.items.find((x) => eqTo(x.provider, prov))
      assert.equal(it.withdrawFrom, from, c.name); assert.equal(it.withdrawUntil, until, c.name)
      const w = plan.steps.find((s) => s.kind === 'withdraw' && eqTo(s.provider, prov))
      assert.equal(w.sendAfter, from, c.name); assert.equal(w.sendBefore, until, c.name)
    }
    for (const s of plan.steps) {
      if (c.expect.to === 'principal') { assert.ok(eqTo(s.tx.to, c.mandate.principal)); assert.equal(s.tx.value, '0x' + BigInt(cb.executeFee).toString(16)) } else { assert.ok(eqTo(s.tx.to, s.escrow)); assert.equal(s.tx.value, '0x0') }
      const call = innerOf(s.tx, c.mandate.principal)
      assert.ok(eqTo(call.to, s.escrow))
      if (s.kind === 'requestWithdraw') { const [pv, amt] = decodeCall('requestWithdraw', call.data); assert.ok(eqTo(pv, s.provider)); assert.equal(amt.toString(), s.amount) }
      if (s.kind === 'withdraw') {
        const [pv] = decodeCall('withdraw', call.data); assert.ok(eqTo(pv, s.provider))
        const it = plan.items.find((x) => eqTo(x.provider, s.provider))
        // a withdraw after a new request is timed from that request / 新请求之后的 withdraw 从请求起算
        if (it.state !== 'requested') { assert.equal(s.sendAfterRequestS, cb.cooldown); assert.equal(s.sendBeforeRequestS, cb.cooldown + cb.window); assert.deepEqual(it.withdrawFrom, { afterRequestS: cb.cooldown }) }
      }
    }
  }
})

test('FIXED P1M3-05: closeOutPlan on the holder path is the funding wallet\'s, whoever holds the circuit now; its required inputs', () => {
  const cb = vectors.closeOutBase, k = vectors.closeOut[0]
  // F2: the seller's wallet closes its own channels after the circuit changed hands: currentHolder is not taken
  // F2：电路转手后卖方钱包照样收自己的通道：不接受 currentHolder
  assert.equal(reason(() => closeOutPlan(k.mandate, { chainId: 56, holder: cb.holder, now: cb.now, channels: k.channels, currentHolder: '0x' + 'aa'.repeat(20) })), 'INVALID_ARGUMENT')
  assert.equal(reason(() => closeOutPlan(k.mandate, { chainId: 56, holder: cb.holder, channels: k.channels })), 'INVALID_ARGUMENT')
  assert.equal(reason(() => closeOutPlan(k.mandate, { chainId: 56, now: cb.now, channels: k.channels })), 'INVALID_ARGUMENT')
  assert.equal(reason(() => closeOutPlan(k.mandate, { chainId: 56, holder: cb.holder, now: cb.now, channels: [k.channels[0]] })), 'INVALID_ARGUMENT')
  const plan = closeOutPlan(k.mandate, { chainId: 56, holder: cb.holder, now: cb.now, channels: k.channels })
  assert.ok(plan.notes.some((n) => /session lasts until/.test(n)))
})

test('FIXED P1M3-06: every phase1.applied vector: what the read-back after a plan reports, and the approve(escrow, 0) to send', () => {
  const base = vectors.planBase
  for (const c of vectors.applied) {
    const pc = vectors.plan[c.plan]
    const plan = escrowPlan(pc.mandate, planOpts(pc, base))
    const r = planApplied(plan, pc.mandate, c.readings)
    assert.deepEqual(r.problems.map((p) => p.code), c.expect.problems, c.name)
    // review p1m3 recheck (3): why a channel is not at its target / 复核建议 3：通道不在目标上的原因
    if (c.expect.causes) assert.deepEqual(r.problems.filter((p) => p.code === 'channel-not-at-cap').map((p) => p.cause), c.expect.causes, c.name)
    assert.equal(r.ok, c.expect.problems.length === 0, c.name)
    assert.deepEqual(r.approveZero.map((s) => s.escrow.toLowerCase()), c.expect.approveZero.map((e) => e.toLowerCase()), c.name)
    for (const s of r.approveZero) { const [sp, amt] = decodeCall('approve', s.tx.data); assert.ok(eqTo(sp, s.escrow)); assert.equal(amt, 0n) }
  }
})

// ---- the kit on the fake chain: every fact at one pinned block / 假链上的 kit：全部事实在一个钉块上 ----
import { selector } from '../src/abi.js'
import { standardWorld, mandateOf, KEYS, addrOf, P, AG, S, S2, RPC, NOW, BEM_TOKEN, nameEscrow, escrowContract, channelState } from './helpers/agent-chain.mjs'
const { createAgentKit } = agent
const HOLDER = addrOf(KEYS.principalHolder)
const STRANGER = addrOf(KEYS.stranger)
const KEY = addrOf(KEYS.agentKey)
const E1 = '0x' + 'e1'.repeat(20), E2 = '0x' + 'e2'.repeat(20)
const FEE = 200000000000000n
const EXPIRES = NOW + 86400
const m1 = (o = {}) => mandateOf({ mode: 1, expires: EXPIRES, scope: [{ provider: S, token: BEM_TOKEN, cap: '100' }], ...o })
const m2 = (o = {}) => mandateOf({ mode: 1, expires: EXPIRES, scope: [{ provider: S, token: BEM_TOKEN, cap: '100' }, { provider: S2, token: BEM_TOKEN, cap: '50' }], ...o })
// provider S (and S2) on escrow E1 holding BEM; nothing funded yet / provider 在 E1 上，尚未充值
function world() {
  const x = standardWorld()
  nameEscrow(x, S, E1); nameEscrow(x, S2, E1); escrowContract(x, E1, BEM_TOKEN)
  return x
}
const kitOf = (x, o) => createAgentKit(x.api(), { clock: () => NOW, allowEscrows: [E1, E2], ...o })
const kitReason = async (p) => { try { await p; return 'ACCEPTED' } catch (e) { return e.data?.reason ?? e.code } }
// the earlier run's transactions are final: the chain moves on, so the next pin is after the record's block
// (review p1m3 recheck 3, pin-not-after-record) / 之前运行的交易已最终化：链前进，下一个钉块在记录的块之后
const final = (x, n = 5) => { x.st.block += n }
// the container path's world: P deployed, opened, its execute owned by the holder and taking FEE / 容器路径的世界
const containerWorld = (conf = {}) => { const x = world(); x.chain.setCode(P); x.setExecute(P, { fee: FEE, owner: HOLDER, ...conf }); return x }

test('FIXED P1M3-07: holderPlan (F2) reads every fact at one pinned block, strictly, and builds the plan escrowPlan builds from them', async () => {
  const x = world()
  channelState(x, HOLDER, S2, { channel: '20' })
  x.st.reads.length = 0
  const plan = await kitOf(x).holderPlan(m2(), { history: [], holder: HOLDER })
  assert.equal(plan.path, 'holder'); assert.equal(plan.consumer, HOLDER)
  const lc = (v) => (typeof v === 'string' ? v.toLowerCase() : v)
  assert.deepEqual(plan.steps.map((s) => [s.kind, lc(s.provider ?? null), s.amount ?? null]), [['approve', null, '130'], ['fund', S, '100'], ['fund', S2, '30'], ['authorizeSession', S, null], ['authorizeSession', S2, null]])
  assert.equal(plan.facts.currentHolder, HOLDER)
  assert.deepEqual(plan.facts.providers.map((p) => [p.escrow, p.token, p.channel, p.pendingLive, p.session]), [[agent.sessionEntry({ chainId: 56, escrow: E1, consumer: HOLDER, provider: S, key: KEY, expires: 1 }).escrow, BEM_TOKEN, '0', false, '0'], [agent.sessionEntry({ chainId: 56, escrow: E1, consumer: HOLDER, provider: S, key: KEY, expires: 1 }).escrow, BEM_TOKEN, '20', false, '0']])
  // the same plan as the pure function over the same facts / 与纯函数在同一事实上的计划相同
  const pure = escrowPlan(m2(), { chainId: 56, holder: HOLDER, providers: plan.facts.providers, allowEscrows: [E1, E2], now: NOW, hub: x.api().addresses.hub, currentHolder: HOLDER })
  assert.deepEqual(plan.steps.map((s) => s.tx), pure.steps.map((s) => s.tx))
  assert.equal(plan.mandateHash, agent.mandateHashOf(56, x.api().addresses.hub, m2()))
  // every escrow and manifest read at the one pinned block / 每个托管与清单读取都在同一个钉块上
  // (the provider's resolution, TAP-11 §2, has its own pin; the manifest and the escrow are read at this one)
  const fns = ['channelOf', 'sessionExpiry', 'pendingWithdraw']
  const reads = x.st.reads.filter((q) => fns.includes(q.fn) || q.method === 'eth_getCode')
  for (const f of fns) assert.ok(reads.some((q) => q.fn === f), f)
  assert.equal(new Set(reads.map((q) => JSON.stringify(q.block))).size, 1)
  assert.equal(reads[0].block.blockHash, plan.pin.hash)
  for (const f of ['channelOf', 'sessionExpiry']) assert.deepEqual(new Set(x.st.reads.filter((q) => q.fn === f).map((q) => q.url)), new Set(RPC), f)
})

test('FIXED P1M3-08: holderPlan refuses a holder that is not the principal\'s current holder, on both paths (owner\'s decision 1)', async () => {
  const x = containerWorld()
  assert.equal(await kitReason(kitOf(x).holderPlan(m1(), { history: [], holder: STRANGER })), 'holder-not-current')
  assert.equal(await kitReason(kitOf(x).holderPlan(m1(), { history: [], holder: STRANGER, path: 'container', maxExecuteFee: FEE })), 'holder-not-current')
  assert.equal((await kitOf(x).holderPlan(m1(), { history: [], holder: HOLDER })).steps.length, 3)
  // the circuit changed hands: the former holder can no longer plan / 电路转手后原持有人不能再出计划
  x.chain.setOwner(11, STRANGER)
  assert.equal(await kitReason(kitOf(x).holderPlan(m1(), { history: [], holder: HOLDER })), 'holder-not-current')
  assert.equal((await kitOf(x).holderPlan(m1(), { history: [], holder: STRANGER })).consumer, STRANGER)
  // the holder is required on both paths / 两条路径都要 holder
  for (const path of ['holder', 'container']) assert.equal(await kitReason(kitOf(x).holderPlan(m1(), { history: [], path })), 'INVALID_ARGUMENT')
})

test('FIXED P1M3-09: the container path (F1): not deployed, not opened, the fee found by simulation and attached, a gate that still reverts', async () => {
  // not deployed: no code at the principal / 未部署
  const a = world()
  assert.equal(await kitReason(kitOf(a).holderPlan(m1(), { history: [], holder: HOLDER, path: 'container', maxExecuteFee: FEE })), 'principal-not-deployed')
  // deployed, not opened / 已部署未开通
  const b = containerWorld(); b.setOpened(11, false)
  assert.equal(await kitReason(kitOf(b).holderPlan(m1(), { history: [], holder: HOLDER, path: 'container', maxExecuteFee: FEE })), 'principal-not-opened')
  // the fee: a revert 0xafd49700(0, FEE), then the call passes with FEE: every execute carries it / 找到费用并附在每次 execute 上
  const c = containerWorld()
  const plan = await kitOf(c).holderPlan(m1(), { history: [], holder: HOLDER, path: 'container', maxExecuteFee: FEE })
  assert.equal(plan.facts.executeFee, FEE.toString()); assert.equal(plan.facts.executeReverts, null)
  assert.equal(plan.consumer, P)
  for (const s of plan.steps) { assert.ok(eqTo(s.tx.to, P)); assert.equal(s.tx.value, '0x' + FEE.toString(16)); assert.ok(s.tx.data.startsWith(agent.EXECUTE_SELECTOR)) }
  // the simulations were made from the holder, at the pinned block, with value 0 then FEE / 模拟从持有人发出，先 0 后 FEE
  const sims = c.simulations
  assert.deepEqual([...new Set(sims.map((q) => q.value))], [0n, FEE])
  assert.ok(sims.every((q) => q.from === HOLDER.toLowerCase()))
  assert.equal(new Set(sims.map((q) => JSON.stringify(q.block))).size, 1); assert.equal(sims[0].block.blockHash, plan.pin.hash)
  // a container without a fee: executeFee 0 / 不收费的容器
  const d = containerWorld({ fee: 0n })
  assert.equal((await kitOf(d).holderPlan(m1(), { history: [], holder: HOLDER, path: 'container', maxExecuteFee: FEE })).facts.executeFee, '0')
  // a gate (payment, listing) that still reverts with the fee: refused, its data said / 带费后仍回滚的门槛
  const e = containerWorld({ gate: '0x5d3b5b49' })
  const r = await kitReason(kitOf(e).holderPlan(m1(), { history: [], holder: HOLDER, path: 'container', maxExecuteFee: FEE }))
  assert.equal(r, 'execute-reverts')
  // the holder path reads none of this / 持有人路径不读这些
  const f = world()
  f.st.reads.length = 0
  await kitOf(f).holderPlan(m1(), { history: [], holder: HOLDER })
  assert.equal(f.st.reads.filter((q) => q.fn === 'execute' || q.fn === 'isOpened').length, 0)
})

test('FIXED P1M3-10: holderPlan turns what it reads into the plan\'s refusals: no escrow, no code, another token, a key already authorised, a live request; a second run is idempotent', async () => {
  const cases = [
    ['provider-unresolvable', (x) => nameEscrow(x, S, null)],
    ['escrow-other-chain', (x) => escrowContract(x, E1, BEM_TOKEN, { code: false })],
    ['escrow-token-mismatch', (x) => escrowContract(x, E1, '0x' + 'cc'.repeat(20))],
    ['escrow-not-allowed', (x) => { nameEscrow(x, S, '0x' + 'e9'.repeat(20)); escrowContract(x, '0x' + 'e9'.repeat(20), BEM_TOKEN) }],
    ['key-already-authorised', (x) => channelState(x, HOLDER, S, { channel: '0', session: EXPIRES - 1 })],
    ['withdraw-pending', (x) => channelState(x, HOLDER, S, { channel: '10', pending: ['10', NOW - 60] })],
    ['channel-exceeds-cap', (x) => channelState(x, HOLDER, S, { channel: '101' })],
  ]
  for (const [want, set] of cases) { const x = world(); set(x); assert.equal(await kitReason(kitOf(x).holderPlan(m1(), { history: [], holder: HOLDER })), want, want) }
  // a lapsed request is not live: planned / 过期请求不算存活
  const l = world(); channelState(l, HOLDER, S, { channel: '10', pending: ['10', NOW - agent.WITHDRAW_COOLDOWN_S - agent.WITHDRAW_WINDOW_S - 1] })
  assert.deepEqual((await kitOf(l).holderPlan(m1(), { history: [], holder: HOLDER })).steps.map((s) => s.kind), ['approve', 'fund', 'authorizeSession'])
  // after the plan was executed: nothing left to send / 计划执行后再跑一次：无事可做
  const done = world(); channelState(done, HOLDER, S, { channel: '100', session: EXPIRES })
  assert.deepEqual((await kitOf(done).holderPlan(m1(), { history: [], holder: HOLDER })).steps, [])
})

test('FIXED P1M3-11: the session history and the SessionAuthorized logs: key-reused, channel-session-live, and a log of this mandate\'s own session', async () => {
  const x = world()
  const kit = kitOf(x)
  const first = await kit.holderPlan(m1({ nonce: '7' }), { history: [], holder: HOLDER })
  const h = agent.sessionHistory(); h.record(first.record); final(x)
  // another mandate with the same key / 同一把钥匙的另一张授权书
  assert.equal(await kitReason(kit.holderPlan(m1({ nonce: '8' }), { holder: HOLDER, history: h.entries() })), 'key-reused')
  // another key whose session on this channel has not ended / 同一通道上另一把尚未到期的钥匙
  const other = m1({ nonce: '9', agentKey: STRANGER })
  assert.equal(await kitReason(kit.holderPlan(other, { holder: HOLDER, history: h.entries() })), 'channel-session-live')
  assert.equal((await kit.holderPlan(other, { holder: HOLDER, history: h.entries(), now: EXPIRES + 1 }).catch((e) => e.data?.reason)), 'session-expired')
  // a lost history rebuilt from the logs: the entry has no hash; on this mandate's channel at its expires it is its own
  // 从日志重建的历史：条目没有哈希；在本授权书通道上、到期等于 expires 即本授权书自己的
  x.sessionLog({ escrow: E1, consumer: HOLDER, provider: S, key: KEY, expires: EXPIRES })
  x.sessionLog({ escrow: E1, consumer: STRANGER, provider: S, key: KEY, expires: EXPIRES })   // another consumer: filtered by topic
  const logs = await kit.sessionLogs({ escrow: E1, consumer: HOLDER, fromBlock: x.st.block - 100, toBlock: x.st.block })
  assert.deepEqual(logs.map((l) => [l.consumer, l.provider, l.key, l.expires, l.mandateHash]), [[HOLDER, agent.sessionEntry({ chainId: 56, escrow: E1, consumer: HOLDER, provider: S, key: KEY, expires: 1 }).provider, KEY, EXPIRES, null]])
  assert.equal((await kit.holderPlan(m1({ nonce: '7' }), { holder: HOLDER, history: logs })).steps.length, 3)
  assert.equal(await kitReason(kit.holderPlan(m1({ nonce: '7', expires: EXPIRES + 60 }), { holder: HOLDER, history: logs })), 'key-reused')
  // a node failure while reading the logs is thrown / 读日志时的节点故障抛出
  x.lie(RPC[1], (method, params, honest) => (method === 'eth_getLogs' ? [] : honest))
  await assert.rejects(kit.sessionLogs({ escrow: E1, consumer: HOLDER, fromBlock: x.st.block - 100, toBlock: x.st.block }), (e) => e.code === 'RPC_DISAGREE' || e.code === 'RPC_UNAVAILABLE')
})

test('FIXED P1M3-12: closeOut reads each channel at one pinned block; the escrow the money is in may be named (R23); the container path needs execute', async () => {
  const x = world()
  channelState(x, HOLDER, S, { channel: '70' })
  const kit = kitOf(x)
  const c = await kit.closeOut(m2(), { history: [], holder: HOLDER, now: EXPIRES + 600 })
  assert.deepEqual(c.steps.map((s) => [s.kind, s.provider.toLowerCase(), s.amount ?? null]), [['requestWithdraw', S, '70'], ['withdraw', S, null]])
  assert.deepEqual(c.items.map((i) => i.state), ['request', 'empty'])
  // a live request: the withdraw only, in its window / 存活请求：只 withdraw
  channelState(x, HOLDER, S, { channel: '70', pending: ['70', EXPIRES] })
  const w = await kit.closeOut(m2(), { history: [], holder: HOLDER, now: EXPIRES + 600 })
  assert.deepEqual(w.steps.map((s) => [s.kind, s.sendAfter]), [['withdraw', EXPIRES + agent.WITHDRAW_COOLDOWN_S]])
  // the provider moved to another escrow since: the money is still in E1 (R23) / provider 换了托管：钱还在 E1
  const y = world(); channelState(y, HOLDER, S, { channel: '70' }); nameEscrow(y, S, E2)
  assert.equal(await kitReason(kitOf(y).closeOut(m1(), { history: [], holder: HOLDER, now: EXPIRES + 600 })), 'escrow-unknown')
  const named = await kitOf(y).closeOut(m1(), { history: [], holder: HOLDER, now: EXPIRES + 600, escrows: { [S]: E1 } })
  assert.deepEqual(named.steps.map((s) => [s.kind, s.escrow.toLowerCase()]), [['requestWithdraw', E1], ['withdraw', E1]])
  // F1: the fee found by simulation; a gate refuses (R20); not the current holder refuses / F1：模拟找费；门槛拒绝；非当前持有人拒绝
  const z = containerWorld(); channelState(z, P, S, { channel: '40' })
  const f1 = await kitOf(z).closeOut(m1(), { history: [], holder: HOLDER, path: 'container', maxExecuteFee: FEE, now: EXPIRES + 600 })
  for (const s of f1.steps) { assert.ok(eqTo(s.tx.to, P)); assert.equal(s.tx.value, '0x' + FEE.toString(16)) }
  z.setExecute(P, { fee: FEE, owner: HOLDER, gate: '0x5d3b5b49' })
  assert.equal(await kitReason(kitOf(z).closeOut(m1(), { history: [], holder: HOLDER, path: 'container', maxExecuteFee: FEE, now: EXPIRES + 600 })), 'execute-reverts')
  z.setExecute(P, { fee: FEE, owner: HOLDER })
  assert.equal(await kitReason(kitOf(z).closeOut(m1(), { history: [], holder: STRANGER, path: 'container', maxExecuteFee: FEE, now: EXPIRES + 600 })), 'holder-not-current')
})

test('FIXED P1M3-13: afterPlan reads at a new pinned block: the allowance left by a failed fund, the channels and the sessions', async () => {
  const x = world()
  const kit = kitOf(x)
  const plan = await kit.holderPlan(m2(), { history: [], holder: HOLDER })
  // the holder sent approve(130) and fund(S, 100); fund(S2, 50) failed; one session sent / 部分执行
  x.chain.mine(5)
  x.setAllowance(BEM_TOKEN, HOLDER, E1, 50)
  channelState(x, HOLDER, S, { channel: '100', session: EXPIRES })
  const a = await kit.afterPlan(plan, m2())
  assert.notEqual(a.pin.hash, plan.pin.hash)
  assert.deepEqual(a.problems.map((p) => p.code), ['allowance-not-zero', 'channel-not-at-cap', 'session-not-set'])
  assert.deepEqual(a.approveZero.map((s) => [s.kind, s.tx.to.toLowerCase()]), [['approve-zero', BEM_TOKEN.toLowerCase()]])
  assert.deepEqual(a.readings.allowances, [{ escrow: plan.checks[0].escrow, allowance: '50' }])
  // the holder cleared the allowance and finished the plan / 清零并补完
  x.setAllowance(BEM_TOKEN, HOLDER, E1, 0)
  channelState(x, HOLDER, S2, { channel: '50', session: EXPIRES })
  const b = await kit.afterPlan(plan, m2())
  assert.equal(b.ok, true); assert.deepEqual(b.problems, [])
  // the check that follows agrees: escrow-channel / 随后的核验一致
  const signed = { mandate: m2(), sig: agent.signMandate(56, x.api().addresses.hub, m2(), KEYS.principalHolder, { allowFunds: true }) }
  assert.equal((await kit.verifyMandate(signed, { enforcement: 'escrow-channel' })).enforcement, 'escrow-channel')
})

test('FIXED P1M3-14: a node failure in a plan\'s read is thrown, never a refusal of the plan', async () => {
  for (const sig of ['sessionExpiry(address,address,address)', 'channelOf(address,address)']) {
    const x = world()
    x.lie(RPC[1], (method, params, honest) => (method === 'eth_call' && String(params[0].data).startsWith(selector(sig)) ? '0x' + '00'.repeat(31) + '07' : honest))
    await assert.rejects(kitOf(x).holderPlan(m1(), { history: [], holder: HOLDER }), (e) => e.code === 'RPC_DISAGREE' || e.code === 'RPC_UNAVAILABLE', sig)
  }
  // a simulation the nodes answer differently is thrown too / 节点对模拟答得不一样也抛出
  const c = containerWorld()
  c.lie(RPC[1], (method, params, honest) => (method === 'eth_call' && String(params[0].data).startsWith(agent.EXECUTE_SELECTOR) ? '0x01' : honest))
  await assert.rejects(kitOf(c).holderPlan(m1(), { history: [], holder: HOLDER, path: 'container', maxExecuteFee: FEE }), (e) => e.code === 'RPC_DISAGREE' || e.code === 'RPC_UNAVAILABLE')
})

test('FIXED P1M3-15: contracts/test/Phase1PlanFixture.sol, which Phase1Plan.t.sol executes on the v3 escrow, is what the SDK builds today', async () => {
  const { phase1PlanFixture, FIXTURE_PATH } = await import('../../scripts/gen-phase1-plan-fixture.mjs')
  assert.equal(readFileSync(FIXTURE_PATH, 'utf8'), phase1PlanFixture(), 'run node scripts/gen-phase1-plan-fixture.mjs, then forge test --match-contract Phase1PlanTest')
})

test('FIXED P1M3-16 (review p1m3 B1): a plan run again after the agent key spent never funds back what it spent; the read-back counts the spending', async () => {
  const x = world()
  const kit = kitOf(x)
  const first = await kit.holderPlan(m1(), { history: [], holder: HOLDER })
  assert.deepEqual(first.record.map((r) => r.claimedAtPlan), ['0'])
  const h = agent.sessionHistory(); h.record(first.record); final(x)
  assert.equal(h.entries()[0].claimedAtPlan, '0')
  // the plan was applied (channel 100, session = expires), then the key settled 60: channel 40, claimedOf 60
  // 计划已应用，随后钥匙结算了 60：通道 40、claimedOf 60
  channelState(x, HOLDER, S, { channel: '40', session: EXPIRES, claimed: '60' })
  // the read-back: 40 + 60 is the cap, nothing to top up / 读回：40 + 60 等于 cap，无需补齐
  const a = await kit.afterPlan(first, m1())
  assert.deepEqual(a.problems, []); assert.equal(a.readings.channels[0].claimed, '60')
  // run again without the history: refused, never approve + fund 60 / 不带历史重跑：拒绝，绝不再 approve + fund 60
  assert.equal(await kitReason(kit.holderPlan(m1(), { history: [], holder: HOLDER })), 'channel-spent')
  // with the history: nothing to send, and the record carries the first run's claimedAtPlan / 带历史：无事可做，记录沿用首次的 claimedAtPlan
  const again = await kit.holderPlan(m1(), { holder: HOLDER, history: h.entries() })
  assert.deepEqual(again.steps, []); assert.deepEqual(again.record.map((r) => r.claimedAtPlan), ['0'])
  assert.equal(again.facts.providers[0].claimed, '60')
  // topped up by hand to 100 after spending 60: above the budget, refused / 花掉 60 后手工补到 100：超出预算，拒绝
  channelState(x, HOLDER, S, { channel: '100', session: EXPIRES, claimed: '60' })
  assert.equal(await kitReason(kit.holderPlan(m1(), { holder: HOLDER, history: h.entries() })), 'channel-exceeds-budget')
  assert.deepEqual((await kit.afterPlan(first, m1())).problems.map((p) => p.code), ['channel-not-at-cap'])
  // a fund that failed after the session was sent (channel 0, nothing spent): with the history it is funded to the cap
  // session 已发而 fund 失败（通道 0、未花）：带历史时补到 cap
  const y = world(); channelState(y, HOLDER, S, { claimed: '5' })
  const p = await kitOf(y).holderPlan(m1(), { history: [], holder: HOLDER })
  const hy = agent.sessionHistory(); hy.record(p.record); final(y)
  channelState(y, HOLDER, S, { channel: '0', session: EXPIRES, claimed: '5' })
  assert.equal(await kitReason(kitOf(y).holderPlan(m1(), { history: [], holder: HOLDER })), 'channel-spent')
  assert.deepEqual((await kitOf(y).holderPlan(m1(), { holder: HOLDER, history: hy.entries() })).steps.map((s) => [s.kind, s.amount]), [['approve', '100'], ['fund', '100']])
  // the key spent 60, then a fund of the repair failed halfway: funded by 20 to the budget 40 / 花掉 60 后通道 20：只补 20
  channelState(y, HOLDER, S, { channel: '20', session: EXPIRES, claimed: '65' })
  assert.deepEqual((await kitOf(y).holderPlan(m1(), { holder: HOLDER, history: hy.entries() })).steps.map((s) => [s.kind, s.amount]), [['approve', '20'], ['fund', '20']])
  // a history entry whose claimedAtPlan is above claimedOf is not this channel's: refused as an input error
  assert.equal(reason(() => escrowPlan(m1(), { chainId: 56, holder: HOLDER, providers: [{ provider: S, escrow: E1, token: BEM_TOKEN, channel: '40', session: String(EXPIRES), claimed: '4' }], allowEscrows: [E1], now: NOW, hub: x.api().addresses.hub, history: hy.entries() })), 'INVALID_ARGUMENT')
  // planApplied needs claimed when the record has claimedAtPlan / 记录带 claimedAtPlan 时读数必须有 claimed
  assert.equal(reason(() => planApplied(first, m1(), { allowances: [], channels: [{ provider: S, channel: '40', session: EXPIRES }] })), 'INVALID_ARGUMENT')
})

test('FIXED P1M3-17 (review p1m3 R1): the container path\'s fee has the caller\'s ceiling: missing is an input error, above it is execute-fee-too-high; the total is said in whole coins', async () => {
  // CONFIRMED on 4d8cdf4: a container (or the nodes simulating it) that said required = 5 BNB had 5 BNB attached to every
  // execute / 修复前：容器（或模拟它的节点）说要 5 BNB，每笔 execute 就附 5 BNB
  const big = 5n * 10n ** 18n
  const x = containerWorld({ fee: big })
  assert.equal(await kitReason(kitOf(x).holderPlan(m1(), { history: [], holder: HOLDER, path: 'container' })), 'INVALID_ARGUMENT')
  assert.equal(await kitReason(kitOf(x).holderPlan(m1(), { history: [], holder: HOLDER, path: 'container', maxExecuteFee: 'lots' })), 'INVALID_ARGUMENT')
  assert.equal(await kitReason(kitOf(x).holderPlan(m1(), { history: [], holder: HOLDER, maxExecuteFee: FEE })), 'INVALID_ARGUMENT')   // holder path
  x.simulations.length = 0
  assert.equal(await kitReason(kitOf(x).holderPlan(m1(), { history: [], holder: HOLDER, path: 'container', maxExecuteFee: FEE })), 'execute-fee-too-high')
  assert.deepEqual([...new Set(x.simulations.map((q) => q.value))], [0n])   // never simulated with the fee above the ceiling / 超过上限不再带费模拟
  channelState(x, P, S, { channel: '40' })
  assert.equal(await kitReason(kitOf(x).closeOut(m1(), { history: [], holder: HOLDER, path: 'container', maxExecuteFee: FEE, now: EXPIRES + 600 })), 'execute-fee-too-high')
  assert.equal(await kitReason(kitOf(x).closeOut(m1(), { history: [], holder: HOLDER, path: 'container', now: EXPIRES + 600 })), 'INVALID_ARGUMENT')
  // at the ceiling: planned, and the total said: 0.0002 BNB × 3 = 0.0006 BNB / 恰在上限：出计划并写明合计
  const y = containerWorld()
  const plan = await kitOf(y).holderPlan(m1(), { history: [], holder: HOLDER, path: 'container', maxExecuteFee: FEE.toString() })
  assert.deepEqual(plan.fees, { perExecute: FEE.toString(), executes: 3, total: (3n * FEE).toString() })
  assert.ok(plan.notes.some((n) => n.includes('0.0002 BNB per execute × 3 executes = 0.0006 BNB in all')), plan.notes.join('\n'))
  channelState(y, P, S, { channel: '40' })
  const close = await kitOf(y).closeOut(m1(), { history: [], holder: HOLDER, path: 'container', maxExecuteFee: FEE, now: EXPIRES + 600 })
  assert.deepEqual(close.fees, { perExecute: FEE.toString(), executes: 2, total: (2n * FEE).toString() })
  // the pure functions: the same rule when maxExecuteFee is given; the holder path takes none / 纯函数同一规则
  const pure = { chainId: 56, path: 'container', holder: HOLDER, providers: [{ provider: S, escrow: E1, token: BEM_TOKEN }], allowEscrows: [E1] }
  assert.equal(reason(() => escrowPlan(m1(), { ...pure, executeFee: FEE + 1n, maxExecuteFee: FEE })), 'execute-fee-too-high')
  assert.equal(escrowPlan(m1(), { ...pure, executeFee: FEE, maxExecuteFee: FEE }).steps.length, 3)
  assert.equal(reason(() => escrowPlan(m1(), { ...pure, path: 'holder', maxExecuteFee: FEE })), 'INVALID_ARGUMENT')
  assert.equal(escrowPlan(m1(), { ...pure, path: 'holder' }).fees, undefined)
})

test('FIXED P1M3-18 (review p1m3 S1): a plan on one funding path refuses a mandate the other path already funded (other-path-funded)', async () => {
  // the principal funded and authorised the key (F1); the holder now plans F2: before the fix, a second full funding
  // 委托方（F1）已充值并授权钥匙；持有人再按 F2 出计划：修复前会再充一份
  const x = containerWorld()
  channelState(x, P, S, { channel: '100', session: EXPIRES })
  assert.equal(await kitReason(kitOf(x).holderPlan(m1(), { history: [], holder: HOLDER })), 'other-path-funded')
  // only a session of the key on the other path, or only money there: refused too / 只有会话或只有钱也拒绝
  channelState(x, P, S, { channel: '0', session: EXPIRES })
  assert.equal(await kitReason(kitOf(x).holderPlan(m1(), { history: [], holder: HOLDER })), 'other-path-funded')
  channelState(x, P, S, { channel: '5', session: 0 })
  assert.equal(await kitReason(kitOf(x).holderPlan(m1(), { history: [], holder: HOLDER })), 'other-path-funded')
  // the other way: the holder funded F2, the plan is F1 / 反过来：持有人已按 F2 充值，计划按 F1
  const y = containerWorld()
  channelState(y, HOLDER, S, { channel: '100', session: EXPIRES })
  assert.equal(await kitReason(kitOf(y).holderPlan(m1(), { history: [], holder: HOLDER, path: 'container', maxExecuteFee: FEE })), 'other-path-funded')
  // both empty: planned, and the facts say what the other path holds / 两边都空：出计划，事实里写明另一条路径
  const z = containerWorld()
  const plan = await kitOf(z).holderPlan(m1(), { history: [], holder: HOLDER })
  assert.deepEqual(plan.facts.providers[0].otherPath, { channel: '0', session: '0' })
  // a key session on the other path of ANOTHER key does not count (the channel itself is empty) / 另一把钥匙的会话不算
  channelState(z, P, S, { channel: '0', session: EXPIRES }, STRANGER)
  assert.equal((await kitOf(z).holderPlan(m1(), { history: [], holder: HOLDER })).steps.length, 3)
})

test('FIXED P1M3-19 (review p1m3 S2): closeOut for a consumer the session history does not name is consumer-unknown, never nothing-to-close; unconfirmed, it says so', async () => {
  const x = world()
  const plan = await kitOf(x).holderPlan(m1(), { history: [], holder: HOLDER })
  channelState(x, HOLDER, S, { channel: '100', session: EXPIRES })
  // the money is in (HOLDER, S); the close-out is asked for the container path (consumer P): before the fix,
  // nothing-to-close / 钱在 (HOLDER, S)，却按容器路径（consumer P）收尾：修复前报 nothing-to-close
  x.chain.setCode(P); x.setExecute(P, { fee: FEE, owner: HOLDER })
  const asked = { holder: HOLDER, path: 'container', maxExecuteFee: FEE, now: EXPIRES + 600 }
  const bare = await kitOf(x).closeOut(m1(), { ...asked, history: [] }).catch((e) => e)
  assert.equal(bare.data.reason, 'nothing-to-close'); assert.equal(bare.data.consumerConfirmed, false)
  assert.match(bare.message, /Not confirmed by the session history/)
  assert.equal(await kitReason(kitOf(x).closeOut(m1(), { ...asked, history: plan.record })), 'consumer-unknown')
  // the right consumer with the history: planned, nothing said about it / 正确的 consumer：出计划
  const ok = await kitOf(x).closeOut(m1(), { holder: HOLDER, now: EXPIRES + 600, history: plan.record })
  assert.deepEqual(ok.steps.map((s) => s.kind), ['requestWithdraw', 'withdraw'])
  assert.ok(!ok.notes.some((n) => /was not checked against the session history/.test(n)))
  assert.ok((await kitOf(x).closeOut(m1(), { history: [], holder: HOLDER, now: EXPIRES + 600 })).notes.some((n) => /was not checked against the session history/.test(n)))
  // a history of another mandate (another key) says nothing about this one / 别的授权书的历史不算
  const other = { ...plan.record[0], key: STRANGER, consumer: P }
  assert.equal((await kitOf(x).closeOut(m1(), { holder: HOLDER, now: EXPIRES + 600, history: [other] })).steps.length, 2)
})

test('FIXED P1M3-20 (review p1m3 S3): sessionLogs keeps only logs of this consumer inside the range, and reads no further than the kit\'s pinned block', async () => {
  const x = world()
  const kit = kitOf(x)
  x.sessionLog({ escrow: E1, consumer: HOLDER, provider: S, key: KEY, expires: EXPIRES, block: x.st.block - 10 })
  x.sessionLog({ escrow: E1, consumer: HOLDER, provider: S2, key: KEY, expires: EXPIRES, block: x.st.block })   // above the pin (head - 2)
  // nodes that ignore the topic filter and add another consumer's log: dropped, never taken as this consumer's
  // 节点无视主题过滤、塞进别的 consumer 的日志：丢弃，绝不当成本 consumer 的
  const asked = []
  const foreign = (method, params, honest) => {
    if (method !== 'eth_getLogs' || !Array.isArray(honest)) return honest
    asked.push(Number(BigInt(params[0].toBlock)))
    const l = honest[0]
    return l ? [...honest, { ...l, topics: [l.topics[0], '0x' + '00'.repeat(12) + STRANGER.slice(2).toLowerCase(), l.topics[2], l.topics[3]] }] : honest
  }
  for (const u of RPC) x.lie(u, foreign)
  const pin = (await kit.holderPlan(m1(), { history: [], holder: HOLDER })).pin.number
  const logs = await kit.sessionLogs({ escrow: E1, consumer: HOLDER, fromBlock: x.st.block - 100, toBlock: x.st.block + 5 })
  assert.deepEqual(logs.map((l) => [l.consumer, l.block]), [[HOLDER, x.st.block - 10]])
  assert.ok(logs.every((l) => l.block <= pin))
  // the filter sent asks no further than the pin / 请求的区间不超过钉块
  assert.ok(asked.length > 0); assert.ok(asked.every((b) => b === pin), String(asked))
  await assert.rejects(kit.sessionLogs({ escrow: E1, consumer: HOLDER, fromBlock: x.st.block, toBlock: x.st.block }), (e) => e.code === 'INVALID_ARGUMENT')
})

test('FIXED P1M3-21 (review p1m3 S4): a holder short of the native coin for the fee is holder-short-of-fee, read by consensus, never a node failure', async () => {
  // before the fix the simulation with the fee got "insufficient funds" from every node: RPC_UNAVAILABLE
  // 修复前带费模拟从每个节点得到 "insufficient funds"：报 RPC_UNAVAILABLE
  const x = containerWorld(); x.setNative(HOLDER, FEE - 1n)
  const e = await kitOf(x).holderPlan(m1(), { history: [], holder: HOLDER, path: 'container', maxExecuteFee: FEE }).catch((err) => err)
  assert.equal(e.data?.reason, 'holder-short-of-fee'); assert.equal(e.data.balance, (FEE - 1n).toString())
  // enough for one execute, not for the plan's three / 够一笔，不够三笔
  x.setNative(HOLDER, 3n * FEE - 1n)
  assert.equal(await kitReason(kitOf(x).holderPlan(m1(), { history: [], holder: HOLDER, path: 'container', maxExecuteFee: FEE })), 'holder-short-of-fee')
  x.setNative(HOLDER, 3n * FEE)
  const plan = await kitOf(x).holderPlan(m1(), { history: [], holder: HOLDER, path: 'container', maxExecuteFee: FEE })
  assert.equal(plan.facts.holderBalance, (3n * FEE).toString())
  // the close-out: two executes / 收尾：两笔
  channelState(x, P, S, { channel: '40' })
  x.setNative(HOLDER, 2n * FEE - 1n)
  assert.equal(await kitReason(kitOf(x).closeOut(m1(), { history: [], holder: HOLDER, path: 'container', maxExecuteFee: FEE, now: EXPIRES + 600 })), 'holder-short-of-fee')
  // one node that lies about the balance cannot make the refusal: the reading disagrees and is thrown
  // 单个节点谎报余额决定不了拒绝：读数不一致即抛出
  x.setNative(HOLDER, 10n ** 18n)
  x.lie(RPC[1], (method, params, honest) => (method === 'eth_getBalance' ? '0x1' : honest))
  await assert.rejects(kitOf(x).holderPlan(m1(), { history: [], holder: HOLDER, path: 'container', maxExecuteFee: FEE }), (err) => err.code === 'RPC_DISAGREE' || err.code === 'RPC_UNAVAILABLE')
})

test('FIXED P1M3-22 (review p1m3 S5): closeOut with fullRequest replaces a live partial request by one for the whole channel; the default keeps it', async () => {
  const x = world()
  channelState(x, HOLDER, S, { channel: '100', pending: ['40', EXPIRES] })
  const kit = kitOf(x)
  const def = await kit.closeOut(m1(), { history: [], holder: HOLDER, now: EXPIRES + 600 })
  assert.deepEqual(def.steps.map((s) => [s.kind, s.amount ?? null]), [['withdraw', null]])
  assert.equal(def.items[0].remaining, '60')
  const full = await kit.closeOut(m1(), { history: [], holder: HOLDER, now: EXPIRES + 600, fullRequest: true })
  assert.deepEqual(full.steps.map((s) => [s.kind, s.amount ?? null]), [['requestWithdraw', '100'], ['withdraw', null]])
  assert.deepEqual([full.items[0].state, full.items[0].remaining, full.items[0].replaces], ['replace', '0', { amount: '40', requestedAt: EXPIRES }])
  assert.equal(full.steps[1].sendAfterRequestS, agent.WITHDRAW_COOLDOWN_S)
  assert.ok(full.notes.some((n) => /restarts its clock/.test(n)))
  // a live request for the whole channel is kept even with fullRequest / 全额请求即便 fullRequest 也保留
  channelState(x, HOLDER, S, { channel: '100', pending: ['100', EXPIRES] })
  assert.deepEqual((await kit.closeOut(m1(), { history: [], holder: HOLDER, now: EXPIRES + 600, fullRequest: true })).steps.map((s) => s.kind), ['withdraw'])
  assert.equal(await kitReason(kit.closeOut(m1(), { history: [], holder: HOLDER, now: EXPIRES + 600, fullRequest: 'yes' })), 'INVALID_ARGUMENT')
})

// ---- review p1m3 recheck: the cap holds per (mandate, provider) over every channel the history records ----
// 复核 p1m3：cap 按（授权书, provider）对历史记录的全部通道成立
// the world of CE-3: the plan applied on E1 (cap 100), the key spent 60 there (channel 40); then the provider's manifest
// names E2, an escrow with its own (empty) channels / CE-3 的世界：计划在 E1 上已应用、钥匙花了 60；随后清单改写为 E2
async function movedWorld() {
  const x = world()
  const kit = kitOf(x)
  const first = await kit.holderPlan(m1(), { history: [], holder: HOLDER })
  const h = agent.sessionHistory(); h.record(first.record); final(x)
  channelState(x, HOLDER, S, { channel: '40', session: EXPIRES, claimed: '60' })
  nameEscrow(x, S, E2); escrowContract(x, E2, BEM_TOKEN); x.escrowChannel(E2, HOLDER, S, {})
  return { x, kit, first, h }
}

test('FIXED P1M3-23 (review p1m3 recheck CE-3): the provider moved its escrow; a re-run never funds a second cap on the new one', async () => {
  // CONFIRMED on e5da5b7: approve 100, fund 100, authorizeSession on E2 (the key could spend 60 + 40 + 100 = 2 × cap)
  // 修复前：在 E2 上 approve 100、fund 100、authorizeSession（钥匙可花 60 + 40 + 100 = 2 × cap）
  const { x, kit, first, h } = await movedWorld()
  const e = await kit.holderPlan(m1(), { holder: HOLDER, history: h.entries() }).catch((err) => err)
  assert.equal(e.data?.reason, 'funded-elsewhere'); assert.equal(e.data.escrow.toLowerCase(), E1); assert.equal(e.data.consumer, HOLDER)
  assert.match(e.message, /closeOut\(mandate, \{ holder: .*, escrows: \{ .*: 0x[eE]1/)
  // the facts read for it: the old channel at the pinned block / 读到的事实：钉块上的旧通道
  const planned = (await kit.holderPlan(m1(), { holder: HOLDER, history: h.entries(), now: NOW }).catch((err) => err))
  assert.equal(planned.data?.reason, 'funded-elsewhere')
  // the close-out the message names: requestWithdraw 40 on E1 / 消息所指的收尾：在 E1 上 requestWithdraw 40
  const close = await kit.closeOut(m1(), { holder: HOLDER, now: NOW, escrows: { [S]: E1 }, history: h.entries() })
  assert.deepEqual(close.steps.map((s) => [s.kind, s.escrow.toLowerCase(), s.amount ?? null]), [['requestWithdraw', E1, '40'], ['withdraw', E1, null]])
  // a live request on the emptied old channel: still refused / 旧通道已空但请求仍存活：照样拒绝
  channelState(x, HOLDER, S, { channel: '0', session: EXPIRES, claimed: '60', pending: ['40', NOW - 60] })
  assert.equal(await kitReason(kit.holderPlan(m1(), { holder: HOLDER, history: h.entries() })), 'funded-elsewhere')
  // the old channel emptied by the withdraw (the escrow clears the request): released, and the new channel is funded to
  // cap − 60 = 40 only / withdraw 取空旧通道（托管清除请求）：放行，新通道只充 cap − 60 = 40
  x.chain.setPendingWithdraw(HOLDER, S, 0, 0)
  channelState(x, HOLDER, S, { channel: '0', session: EXPIRES, claimed: '60' })
  const second = await kit.holderPlan(m1(), { holder: HOLDER, history: h.entries() })
  assert.deepEqual(second.steps.map((s) => [s.kind, s.escrow.toLowerCase(), s.amount ?? null]), [['approve', E2, '40'], ['fund', E2, '40'], ['authorizeSession', E2, null]])
  assert.deepEqual(second.record.map((r) => [r.escrow.toLowerCase(), r.claimedAtPlan, r.spentElsewhere]), [[E2, '0', '60']])
  assert.deepEqual(second.facts.providers[0].elsewhere, [{ escrow: agent.sessionEntry({ chainId: 56, escrow: E1, consumer: HOLDER, provider: S, key: KEY, expires: 1 }).escrow, consumer: HOLDER, channel: '0', pendingLive: false, claimed: '60', session: String(EXPIRES) }])
  assert.ok(second.notes.some((n) => /never fund those earlier channels again/.test(n)))
  // applied on E2: the read-back compares with cap − 60, not the cap / 在 E2 上应用：读回按 cap − 60 比较
  h.record(second.record); final(x)
  x.escrowChannel(E2, HOLDER, S, { channel: '40', session: EXPIRES })
  assert.deepEqual((await kit.afterPlan(second, m1())).problems, [])
  assert.equal((await kit.afterPlan(first, m1())).ok, false)   // the first plan's channel was emptied / 第一次计划的通道已取空
  // run again: nothing; the key spends 25 on E2: still nothing (60 + 25 + 15 = cap) / 再跑：无事；钥匙在 E2 花 25：仍无事
  assert.deepEqual((await kit.holderPlan(m1(), { holder: HOLDER, history: h.entries() })).steps, [])
  x.escrowChannel(E2, HOLDER, S, { channel: '15', session: EXPIRES, claimed: '25' })
  assert.deepEqual((await kit.holderPlan(m1(), { holder: HOLDER, history: h.entries() })).steps, [])
  assert.deepEqual((await kit.afterPlan(second, m1())).problems, [])
  // E2 topped up by hand to 40 after the key spent 25 there: above the budget / 花掉 25 后手工补到 40：超出预算
  x.escrowChannel(E2, HOLDER, S, { channel: '40', session: EXPIRES, claimed: '25' })
  assert.equal(await kitReason(kit.holderPlan(m1(), { holder: HOLDER, history: h.entries() })), 'channel-exceeds-budget')
  // the old channel funded again (by hand) after the release: refused again / 放行后旧通道又被充值：再次拒绝
  x.escrowChannel(E2, HOLDER, S, { channel: '15', session: EXPIRES, claimed: '25' })
  channelState(x, HOLDER, S, { channel: '1', session: EXPIRES, claimed: '60' })
  assert.equal(await kitReason(kit.holderPlan(m1(), { holder: HOLDER, history: h.entries() })), 'funded-elsewhere')
})

test('FIXED P1M3-24 (review p1m3 recheck CE-4): a new holder (or the same person\'s second wallet) with the old record never funds a second cap', async () => {
  // CONFIRMED on e5da5b7: approve 100, fund 100, authorizeSession for (STRANGER, S) while (HOLDER, S) kept 40 for the key
  // 修复前：为 (STRANGER, S) 再充 100 并授权，而 (HOLDER, S) 仍给钥匙留着 40
  const x = world()
  const kit = kitOf(x)
  const first = await kit.holderPlan(m1(), { history: [], holder: HOLDER })
  const h = agent.sessionHistory(); h.record(first.record); final(x)
  channelState(x, HOLDER, S, { channel: '40', session: EXPIRES, claimed: '60' })
  x.chain.setOwner(11, STRANGER)
  const e = await kit.holderPlan(m1(), { holder: STRANGER, history: h.entries() }).catch((err) => err)
  assert.equal(e.data?.reason, 'funded-elsewhere'); assert.equal(e.data.consumer, HOLDER)
  assert.match(e.message, /never released/)
  // even once the old holder emptied its channel: another consumer's channel is never released (that wallet can fund
  // it again while the key's session lasts) / 旧持有人取空通道后仍拒绝：别的 consumer 的通道永不放行
  channelState(x, HOLDER, S, { channel: '0', session: EXPIRES, claimed: '60' })
  assert.equal(await kitReason(kit.holderPlan(m1(), { holder: STRANGER, history: h.entries() })), 'funded-elsewhere')
  // the container path (consumer: the principal) with the holder path's record: refused the same way
  // 容器路径（consumer 为委托方）带持有人路径的记录：同样拒绝
  x.chain.setOwner(11, HOLDER); x.chain.setCode(P); x.setExecute(P, { fee: FEE, owner: HOLDER })
  assert.equal(await kitReason(kit.holderPlan(m1(), { holder: HOLDER, path: 'container', maxExecuteFee: FEE, history: h.entries() })), 'funded-elsewhere')
})

test('FIXED P1M3-25 (review p1m3 recheck S1): the other path\'s channel is read on every escrow the history names, not only the manifest\'s', async () => {
  // the container path funded on E1 (record kept); the holder path also funded on E1 (its record lost); the provider moved
  // to E2; the container path's own E1 channel was emptied. Before the fix otherPath read (HOLDER, S) on E2 only: 0
  // 容器路径在 E1 上充值（有记录）；持有人路径也在 E1 上充值（记录丢了）；provider 搬到 E2；容器路径自己的 E1 通道已取空。修复前只读 E2 上的 (HOLDER, S)
  const x = containerWorld()
  const kit = kitOf(x)
  const first = await kit.holderPlan(m1(), { history: [], holder: HOLDER, path: 'container', maxExecuteFee: FEE })
  const h = agent.sessionHistory(); h.record(first.record); final(x)
  channelState(x, P, S, { channel: '0', session: EXPIRES, claimed: '30' })
  channelState(x, HOLDER, S, { channel: '50', session: EXPIRES })
  nameEscrow(x, S, E2); escrowContract(x, E2, BEM_TOKEN); x.escrowChannel(E2, P, S, {})
  const e = await kit.holderPlan(m1(), { holder: HOLDER, path: 'container', maxExecuteFee: FEE, history: h.entries() }).catch((err) => err)
  assert.equal(e.data?.reason, 'other-path-funded')
  // the holder's E1 channel emptied, the key's session there stays: still refused (as S1) / 持有人 E1 通道已空、会话仍在：照样拒绝
  channelState(x, HOLDER, S, { channel: '0', session: EXPIRES })
  assert.equal(await kitReason(kit.holderPlan(m1(), { holder: HOLDER, path: 'container', maxExecuteFee: FEE, history: h.entries() })), 'other-path-funded')
  // never touched by the other path: released, funded to cap − 30 / 另一条路径从未用过：放行，只充 cap − 30
  channelState(x, HOLDER, S, {})
  const plan = await kit.holderPlan(m1(), { holder: HOLDER, path: 'container', maxExecuteFee: FEE, history: h.entries() })
  assert.deepEqual(plan.steps.map((s) => [s.kind, s.escrow.toLowerCase(), s.amount ?? null]), [['approve', E2, '70'], ['fund', E2, '70'], ['authorizeSession', E2, null]])
})

test('FIXED P1M3-26 (review p1m3 recheck suggestions 1-3): the pure functions never attach a fee without its ceiling; the baseline is never reset; a short channel says whether a fund failed', () => {
  const hub = vectors.planBase.hub
  const pure = { chainId: 56, path: 'container', holder: HOLDER, providers: [{ provider: S, escrow: E1, token: BEM_TOKEN }], allowEscrows: [E1], hub, now: NOW }
  // (1) CONFIRMED on e5da5b7: escrowPlan with executeFee 5 BNB and no maxExecuteFee attached 5 BNB to every execute
  // (1) 修复前：纯函数给了 executeFee 5 BNB 而没给 maxExecuteFee，每笔 execute 附 5 BNB
  assert.equal(reason(() => escrowPlan(m1(), { ...pure, executeFee: 5n * 10n ** 18n })), 'INVALID_ARGUMENT')
  assert.equal(reason(() => closeOutPlan(m1(), { chainId: 56, path: 'container', holder: HOLDER, now: NOW, executeFee: FEE, channels: [{ provider: S, escrow: E1, channel: '40' }] })), 'INVALID_ARGUMENT')
  assert.equal(escrowPlan(m1(), { ...pure, maxExecuteFee: FEE }).steps[0].tx.value, '0x0')   // the ceiling alone: no fee attached / 只有上限：不附费
  // (2) CONFIRMED on e5da5b7: applied, channel at its cap, 60 settled, no history: planned with claimedAtPlan 60 (the 60
  // the key may have spent forgotten); and a re-run without claimed lost the history's baseline (null)
  // (2) 修复前：无历史时以今天的 60 为基线（忘掉钥匙可能已花的 60）；不给 claimed 重跑时丢掉历史基线（null）
  const prov = (o) => ({ ...pure, path: 'holder', providers: [{ provider: S, escrow: E1, token: BEM_TOKEN, channel: '100', session: String(EXPIRES), ...o }] })
  assert.equal(reason(() => escrowPlan(m1(), prov({ claimed: '60' }))), 'channel-spent')
  const rec = { chainId: 56, escrow: E1, consumer: HOLDER, provider: S, key: KEY, expires: EXPIRES, mandateHash: agent.mandateHashOf(56, hub, m1()), claimedAtPlan: '0' }
  assert.deepEqual(escrowPlan(m1(), { ...prov({}), history: [rec] }).record.map((r) => r.claimedAtPlan), ['0'])
  // (3) CONFIRMED on e5da5b7: a channel the holder withdrew from was told "a fund failed; run the plan again"
  // (3) 修复前：持有人自己取回的通道也被说成"fund 失败，再跑一次计划"
  const first = escrowPlan(m1(), { ...pure, path: 'holder', providers: [{ provider: S, escrow: E1, token: BEM_TOKEN, claimed: '0' }] })
  const read = (allowance, channel, claimed) => planApplied(first, m1(), { allowances: [{ escrow: E1, allowance }], channels: [{ provider: S, channel, session: EXPIRES, claimed }] }).problems.find((p) => p.code === 'channel-not-at-cap')
  const w = read('0', '10', '60')
  assert.equal(w.cause, 'withdrawn-or-not-sent'); assert.match(w.message, /withdrawn from since the plan/); assert.doesNotMatch(w.message, /a fund failed/)
  const f = read('100', '0', '0')
  assert.equal(f.cause, 'fund-failed'); assert.match(f.message, /a fund failed midway \(the allowance is still 100\)/)
  assert.equal(read('0', '100', '60').cause, 'excess')
})

// ---- review p1m3 recheck 3 / 第三轮复核 ----
test('FIXED P1M3-27 (review p1m3 recheck 3, N1): the kit never plans without a session history; omitted is not [], and the pure functions say which', async () => {
  // CONFIRMED on 1808c40 (N1): after E1 was applied and the key spent 60, the provider moved to E2 and
  // kit.holderPlan(m, { holder }) without history planned approve 100, fund 100, authorizeSession on E2 (2 × cap in all)
  // 修复前（N1）：E1 应用、钥匙花掉 60、provider 搬到 E2 之后，不带 history 的 holderPlan 在 E2 上再充 100（合计 2 × cap）
  const { x, kit, h } = await movedWorld()
  const e = await kit.holderPlan(m1(), { holder: HOLDER }).catch((err) => err)
  assert.equal(e.code, 'INVALID_ARGUMENT'); assert.match(e.message, /needs history/); assert.match(e.message, /\[\] when the console confirms it has none/)
  assert.equal(await kitReason(kit.holderPlan(m1(), { holder: HOLDER, history: undefined })), 'INVALID_ARGUMENT')
  assert.equal(await kitReason(kit.holderPlan(m1(), { holder: HOLDER, history: null })), 'INVALID_ARGUMENT')
  assert.equal(await kitReason(kit.holderPlan(m1(), { holder: HOLDER, history: h })), 'INVALID_ARGUMENT')   // the object, not its entries()
  // the container path and the new holder (CE-4 without history) too / 容器路径与新持有人同样
  x.chain.setCode(P); x.setExecute(P, { fee: FEE, owner: HOLDER })
  assert.equal(await kitReason(kit.holderPlan(m1(), { holder: HOLDER, path: 'container', maxExecuteFee: FEE })), 'INVALID_ARGUMENT')
  // closeOut the same / closeOut 同样
  assert.equal(await kitReason(kit.closeOut(m1(), { holder: HOLDER, now: NOW, escrows: { [S]: E1 } })), 'INVALID_ARGUMENT')
  assert.deepEqual((await kit.closeOut(m1(), { holder: HOLDER, now: NOW, escrows: { [S]: E1 }, history: [] })).checked, { history: true })
  // with the history: funded-elsewhere (P1M3-23); with [] the console says it has no record: planned, and said so
  // 带历史：funded-elsewhere；[] 是控制台声明没有记录：照常出计划，并写明已检查
  assert.equal(await kitReason(kit.holderPlan(m1(), { holder: HOLDER, history: h.entries() })), 'funded-elsewhere')
  const empty = await kit.holderPlan(m1(), { holder: HOLDER, history: [] })
  assert.deepEqual(empty.checked, { history: true, signer: false })
  assert.ok(!empty.notes.some((n) => /were NOT checked/.test(n)))
  // the pure functions: omitted is checked.history false with a note naming the rules not checked; [] is true
  // 纯函数：省略即 checked.history 为 false，并在 notes 写明未检查的规则；[] 为 true
  const hub = x.api().addresses.hub
  const pure = { chainId: 56, holder: HOLDER, providers: [{ provider: S, escrow: E2, token: BEM_TOKEN, claimed: '0' }], allowEscrows: [E1, E2] }
  const bare = escrowPlan(m1(), pure)
  assert.deepEqual(bare.checked, { history: false, signer: false })
  assert.ok(bare.notes.some((n) => /key-reused, funded-elsewhere and channel-session-live were NOT checked/.test(n)))
  const given = escrowPlan(m1(), { ...pure, history: [], hub, now: NOW })
  assert.deepEqual(given.checked, { history: true, signer: false })
  assert.ok(!given.notes.some((n) => /were NOT checked/.test(n)))
  assert.equal(reason(() => escrowPlan(m1(), { ...pure, history: h.entries(), hub, now: NOW })), 'funded-elsewhere')
  const close = { chainId: 56, holder: HOLDER, now: NOW, channels: [{ provider: S, escrow: E1, channel: '40' }] }
  assert.deepEqual(closeOutPlan(m1(), close).checked, { history: false })
  assert.deepEqual(closeOutPlan(m1(), { ...close, history: [] }).checked, { history: true })
})

test('FIXED P1M3-28 (review p1m3 recheck 3, N3): a re-run\'s record fills a null claimedAtPlan of the same session (null -> a value only, never a value -> another)', () => {
  // CONFIRMED on 1808c40 (N3): a first plan made without the claimed fact recorded claimedAtPlan null; the re-run's
  // record with the baseline 0 was dropped as a duplicate, so every later re-run was channel-spent for good
  // 修复前（N3）：首跑无 claimed 记下 null；重跑带基线 0 的记录被当作重复丢掉，此后每次重跑都是 channel-spent
  const hub = vectors.planBase.hub
  const base = { chainId: 56, holder: HOLDER, allowEscrows: [E1], now: NOW, hub }
  const prov = (o = {}) => [{ provider: S, escrow: E1, token: BEM_TOKEN, otherPath: { channel: '0', session: '0' }, ...o }]
  const first = escrowPlan(m1(), { ...base, history: [], providers: prov() })
  assert.equal(first.record[0].claimedAtPlan, null)
  const h = sessionHistory(); h.record(first.record)
  // applied, nothing settled yet: the re-run takes the exact baseline 0, and the history keeps it
  // 已应用、尚未结算：重跑取准确的基线 0，历史保留它
  const again = escrowPlan(m1(), { ...base, history: h.entries(), providers: prov({ channel: '100', session: String(EXPIRES), claimed: '0' }) })
  assert.equal(again.record[0].claimedAtPlan, '0')
  h.record(again.record)
  assert.deepEqual(h.entries().map((e) => e.claimedAtPlan), ['0'])
  // so once the key spent 60, a re-run is planned over the budget (nothing to fund), never channel-spent for good
  // 钥匙花掉 60 后，重跑按预算出计划（无须充值），不再永远 channel-spent
  assert.deepEqual(escrowPlan(m1(), { ...base, history: h.entries(), providers: prov({ channel: '40', session: String(EXPIRES), claimed: '60' }) }).steps, [])
  // a value is never replaced, by another value or by null: the first baseline is kept (less funded, never more)
  // 已有的值绝不被替换（另一个值或 null）：保留第一个基线
  h.record({ ...again.record[0], claimedAtPlan: '50' })
  h.record({ ...again.record[0], claimedAtPlan: null })
  assert.deepEqual(h.entries().map((e) => e.claimedAtPlan), ['0'])
  // a log entry (no hash) of the session adds nothing and fills nothing / 日志条目不新增也不填充
  const g = sessionHistory([{ ...first.record[0] }])
  g.record({ ...first.record[0], mandateHash: null, claimedAtPlan: '9' })
  assert.deepEqual(g.entries().map((e) => [e.mandateHash !== null, e.claimedAtPlan]), [[true, null]])
  // the same through the vectors' cases / 向量用例
  for (const c of vectors.history) {
    const k = sessionHistory(); for (const r of c.records) k.record(r)
    assert.deepEqual(k.entries().map((e, i) => [e.escrow.toLowerCase(), e.mandateHash, e.claimedAtPlan, e.block].slice(0, c.expect[i]?.length ?? 4)), c.expect.map(([a, ...rest]) => [a.toLowerCase(), ...rest]), c.name)
  }
})

test('FIXED P1M3-29 (review p1m3 recheck 3, N2): nothing left of the cap on a fresh channel is budget-exhausted, never an authorizeSession alone', async () => {
  // CONFIRMED on 1808c40 (N2): the key spent the whole cap on E1 (emptied), the provider moved to E2: the plan was one
  // authorizeSession on the empty E2 channel / 修复前（N2）：钥匙在 E1 上花完整个 cap（已空），provider 搬到 E2：计划是在空的 E2 通道上单发 authorizeSession
  const x = world(); const kit = kitOf(x)
  const first = await kit.holderPlan(m1(), { history: [], holder: HOLDER })
  const h = sessionHistory(); h.record(first.record); final(x)
  channelState(x, HOLDER, S, { channel: '0', session: EXPIRES, claimed: '100' })
  nameEscrow(x, S, E2); escrowContract(x, E2, BEM_TOKEN); x.escrowChannel(E2, HOLDER, S, {})
  const e = await kit.holderPlan(m1(), { holder: HOLDER, history: h.entries() }).catch((err) => err)
  assert.equal(e.data?.reason, 'budget-exhausted'); assert.equal(e.data.spent, '100'); assert.equal(e.data.cap, '100')
  // one unit left: planned as before (fund 1 and the session) / 还剩 1：照常出计划
  channelState(x, HOLDER, S, { channel: '0', session: EXPIRES, claimed: '99' })
  assert.deepEqual((await kit.holderPlan(m1(), { holder: HOLDER, history: h.entries() })).steps.map((s) => [s.kind, s.escrow.toLowerCase(), s.amount ?? null]), [['approve', E2, '1'], ['fund', E2, '1'], ['authorizeSession', E2, null]])
  // the key already authorised on E2 by an earlier run, nothing left: nothing to send, not refused / 已在 E2 授权过、没有余量：无事可做，不拒绝
  channelState(x, HOLDER, S, { channel: '0', session: EXPIRES, claimed: '100' })
  h.record({ ...first.record[0], escrow: E2, claimedAtPlan: '0' }); final(x)
  x.escrowChannel(E2, HOLDER, S, { session: EXPIRES })
  assert.deepEqual((await kit.holderPlan(m1(), { holder: HOLDER, history: h.entries() })).steps, [])
})

test('FIXED P1M3-30 (review p1m3 recheck 3): funded-elsewhere for the principal container\'s channel points to the container path\'s close-out, never to a new key', async () => {
  // CONFIRMED on 1808c40: the message said closeOut(mandate, { holder: <the principal>, ... }) "sent from" the container
  // and "have the agent accept a new key" / 修复前：消息让"从容器发出" closeOut(holder: 委托方) 并"换钥匙"
  const x = containerWorld(); const kit = kitOf(x)
  const first = await kit.holderPlan(m1(), { history: [], holder: HOLDER, path: 'container', maxExecuteFee: FEE })
  const h = sessionHistory(); h.record(first.record); final(x)
  channelState(x, P, S, { channel: '100', session: EXPIRES, claimed: '0' })
  // the holder path with the container path's record: the old consumer is the principal / 持有人路径带容器路径的记录
  const e = await kit.holderPlan(m1(), { holder: HOLDER, history: h.entries() }).catch((err) => err)
  assert.equal(e.data?.reason, 'funded-elsewhere'); assert.equal(e.data.consumer, P)
  assert.ok(e.message.toLowerCase().includes(`closeout(mandate, { path: 'container', holder: ${HOLDER}, escrows: { ${S}: ${E1} }`.toLowerCase()), e.message)
  assert.match(e.message, /keep planning this mandate on the container path/)
  assert.doesNotMatch(e.message, /new key/); assert.doesNotMatch(e.message, /sent from 0x/)
  // the container path after the provider moved to E2, the old container channel still funded: the same close-out
  // 容器路径、provider 搬到 E2、旧的容器通道仍有钱：同样的收尾指引
  nameEscrow(x, S, E2); escrowContract(x, E2, BEM_TOKEN); x.escrowChannel(E2, P, S, {})
  const c = await kit.holderPlan(m1(), { holder: HOLDER, path: 'container', maxExecuteFee: FEE, history: h.entries() }).catch((err) => err)
  assert.equal(c.data?.reason, 'funded-elsewhere')
  assert.ok(c.message.toLowerCase().includes(`closeout(mandate, { path: 'container', holder: ${HOLDER}, escrows: { ${S}: ${E1} }`.toLowerCase()), c.message)
  assert.doesNotMatch(c.message, /new key/)
  // a holder's channel on the container path is still the other consumer's: a new key (unchanged) / 持有人的通道：仍是换钥匙
  const y = containerWorld(); const ky = kitOf(y)
  const hp = await ky.holderPlan(m1(), { history: [], holder: HOLDER })
  const g = sessionHistory(); g.record(hp.record); final(y)
  const d = await ky.holderPlan(m1(), { holder: HOLDER, path: 'container', maxExecuteFee: FEE, history: g.entries() }).catch((err) => err)
  assert.equal(d.data?.reason, 'funded-elsewhere'); assert.match(d.message, /closeOut\(mandate, \{ holder: .* sent from /); assert.match(d.message, /new key/)
})

test('FIXED P1M3-31 (review p1m3 recheck 3): the record carries the pinned block; a re-run pinned at or before a record\'s block is pin-not-after-record', async () => {
  // CONFIRMED on 1808c40: the record had no block, and a re-run pinned at the first run's block (its transactions not yet
  // visible) planned the whole cap again / 修复前：record 没有块号，钉在首跑同一块（交易尚不可见）的重跑再充整笔 cap
  const x = world(); const kit = kitOf(x)
  const first = await kit.holderPlan(m1(), { history: [], holder: HOLDER })
  assert.ok(Number.isSafeInteger(first.pin.number))
  assert.deepEqual(first.record.map((r) => r.block), [first.pin.number])
  const h = sessionHistory(); h.record(first.record)
  assert.equal(h.entries()[0].block, first.pin.number)
  // the same pin (the holder sent the plan; nothing is final yet): refused / 同一钉块：拒绝
  const e = await kit.holderPlan(m1(), { holder: HOLDER, history: h.entries() }).catch((err) => err)
  assert.equal(e.data?.reason, 'pin-not-after-record'); assert.equal(e.data.pinBlock, first.pin.number); assert.equal(e.data.recordBlock, first.pin.number)
  assert.match(e.message, /Wait until they are final/)
  // a pin behind the record (a lagging node set): refused too / 钉块落后于记录：同样拒绝
  x.st.block -= 3
  assert.equal(await kitReason(kit.holderPlan(m1(), { holder: HOLDER, history: h.entries() })), 'pin-not-after-record')
  // the run applied and final, the chain moved on: planned (nothing to send), and its record carries the later pin
  // 首跑已应用且最终化、链前进：出计划（无事可做），记录带新的钉块
  x.st.block += 3; channelState(x, HOLDER, S, { channel: '100', session: EXPIRES, claimed: '0' }); final(x)
  const again = await kit.holderPlan(m1(), { holder: HOLDER, history: h.entries() })
  assert.deepEqual(again.steps, []); assert.ok(again.pin.number > first.pin.number)
  h.record(again.record)
  assert.equal(h.entries().length, 1); assert.equal(h.entries()[0].block, again.pin.number)   // raised to the later pin / 升到较晚的钉块
  // a record of another mandate on the channel this plan funds, above the pin: refused; on another provider's channel: not
  // 另一授权书在本计划所充通道上的记录高于钉块：拒绝；在别的 provider 的通道上：不拒绝
  final(x)
  const other = { ...first.record[0], key: STRANGER, mandateHash: '0x' + 'ab'.repeat(32), expires: NOW - 1, claimedAtPlan: null, block: x.st.block + 100 }
  assert.equal(await kitReason(kit.holderPlan(m1(), { holder: HOLDER, history: [...h.entries(), other] })), 'pin-not-after-record')
  assert.deepEqual((await kit.holderPlan(m1(), { holder: HOLDER, history: [...h.entries(), { ...other, provider: S2 }] })).steps, [])
  // the pure function: a record's block is null without pinBlock; pinBlock must be a block number
  // 纯函数：不给 pinBlock 时 record 的 block 为 null；pinBlock 必须是块号
  const hub = x.api().addresses.hub
  const pure = { chainId: 56, holder: HOLDER, providers: [{ provider: S, escrow: E1, token: BEM_TOKEN }], allowEscrows: [E1], hub, now: NOW }
  assert.deepEqual(escrowPlan(m1(), pure).record.map((r) => r.block), [null])
  assert.deepEqual(escrowPlan(m1(), { ...pure, pinBlock: 0 }).record.map((r) => r.block), [0])
  for (const b of [-1, 1.5, '7', null]) assert.equal(reason(() => escrowPlan(m1(), { ...pure, pinBlock: b })), 'INVALID_ARGUMENT')
  assert.equal(reason(() => sessionEntry({ ...first.record[0], block: -1 })), 'INVALID_ARGUMENT')
  // a log entry carries its block too (sessionLogs) and is kept by the history / 日志条目也带块号并被历史保留
  assert.equal(sessionEntry({ ...first.record[0], mandateHash: null, block: 9 }).block, 9)
})

test('FIXED P1M3-32 (review p1m3 recheck 3, CE-4 without a history): with the signed mandate, a holder that is not its signer is holder-changed-since-signing', async () => {
  // CONFIRMED on 1808c40: the circuit changed hands and the new holder planned the old mandate with no history: a whole
  // cap for (STRANGER, S) while (HOLDER, S) kept what the key had not spent / 修复前：电路转手后新持有人不带历史为旧授权书再充整笔 cap
  const x = world(); const kit = kitOf(x)
  const hub = x.api().addresses.hub
  const m = m1()
  const signed = { mandate: m, sig: agent.signMandate(56, hub, m, KEYS.principalHolder, { allowFunds: true }) }
  // the holder that signed it: planned, the signer said / 签署它的持有人：出计划，并写明签署人
  const ok = await kit.holderPlan(m, { holder: HOLDER, history: [], signed })
  assert.equal(ok.steps.length, 3); assert.deepEqual(ok.checked, { history: true, signer: true }); assert.equal(ok.facts.signer, HOLDER)
  await kit.holderPlan(m, { holder: HOLDER, history: [] }).then((p) => assert.deepEqual(p.checked, { history: true, signer: false }))
  channelState(x, HOLDER, S, { channel: '40', session: EXPIRES, claimed: '60' })
  x.chain.setOwner(11, STRANGER)
  // the new holder with no record of the old channel: refused by the signature alone / 新持有人没有旧通道的记录：仅凭签名即拒绝
  const e = await kit.holderPlan(m, { holder: STRANGER, history: [], signed }).catch((err) => err)
  assert.equal(e.data?.reason, 'holder-changed-since-signing'); assert.equal(e.data.signer, HOLDER)
  assert.match(e.message, /not-signed-by-holder/)
  assert.equal(await kitReason(kit.holderPlan(m, { holder: STRANGER, history: [], signer: HOLDER })), 'holder-changed-since-signing')
  assert.equal(await kitReason(kit.holderPlan(m, { holder: STRANGER, history: [], signer: STRANGER })), 'ACCEPTED')   // the caller's word / 调用方之言
  // without either it is not checked (the history is what catches it then, P1M3-24) / 两者都不给时不检查（由历史拦下）
  assert.equal(await kitReason(kit.holderPlan(m, { holder: STRANGER, history: [] })), 'ACCEPTED')
  // the container path: the holder calling execute is not the signer / 容器路径：调用 execute 的持有人不是签署人
  x.chain.setCode(P); x.setExecute(P, { fee: FEE, owner: STRANGER })
  assert.equal(await kitReason(kit.holderPlan(m, { holder: STRANGER, path: 'container', maxExecuteFee: FEE, history: [], signed })), 'holder-changed-since-signing')
  // a longer signature (EIP-1271 form) the holder does not accept names no one: refused (signer null)
  // 更长的签名（EIP-1271 形式）且 holder 不接受：无人可指认，拒绝（signer 为 null）
  const long = await kit.holderPlan(m, { holder: STRANGER, history: [], signed: { mandate: m, sig: '0x' + '11'.repeat(66) } }).catch((err) => err)
  assert.equal(long.data?.reason, 'holder-changed-since-signing'); assert.equal(long.data.signer, null)
  // input errors: both given, another mandate, a malformed signature / 参数错误：两者都给、另一张授权书、签名格式不对
  assert.equal(await kitReason(kit.holderPlan(m, { holder: STRANGER, history: [], signed, signer: HOLDER })), 'INVALID_ARGUMENT')
  assert.equal(await kitReason(kit.holderPlan(m, { holder: STRANGER, history: [], signed: { ...signed, mandate: { ...m, nonce: '2' } } })), 'INVALID_ARGUMENT')
  assert.equal(await kitReason(kit.holderPlan(m, { holder: STRANGER, history: [], signed: { mandate: m, sig: '0x12' } })), 'INVALID_ARGUMENT')
  assert.equal(await kitReason(kit.holderPlan(m, { holder: STRANGER, history: [], signer: '0x' + '00'.repeat(20) })), 'INVALID_ARGUMENT')
  // the pure function: null and another address refuse; the holder passes / 纯函数
  const pure = { chainId: 56, holder: HOLDER, providers: [{ provider: S, escrow: E1, token: BEM_TOKEN }], allowEscrows: [E1] }
  assert.equal(reason(() => escrowPlan(m, { ...pure, signer: null })), 'holder-changed-since-signing')
  assert.equal(reason(() => escrowPlan(m, { ...pure, signer: STRANGER })), 'holder-changed-since-signing')
  assert.equal(escrowPlan(m, { ...pure, signer: HOLDER.toLowerCase() }).steps.length, 3)
  assert.equal(reason(() => escrowPlan(m, { ...pure, signer: 'me' })), 'INVALID_ARGUMENT')
})
