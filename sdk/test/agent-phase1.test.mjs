// Container agents, phase 1 (experimental, internal design notes, phase 1): the static rules behind
// { enforcement: 'escrow-channel' }, the phase-1 wallet payload and the holder's transaction plan (escrowPlan, pure).
// Every case named FIXED P1-xx was checked by removing the line that implements it (the test turns red). Every clock is
// fixed (NOW): no assertion depends on the wall clock.
// 容器代理阶段 1（实验）：开关下的静态规则、阶段 1 钱包载荷与持有人交易计划（纯函数）。FIXED P1-xx 都做过反向检查；时钟固定。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as agent from '@tapeapi/sdk/agent'
import { decodeCall, decodeParams, hexToBytes, ZERO_ADDRESS } from '../src/abi.js'
import { standardWorld, happyThread, mandateOf, KEYS, addrOf, P, AG, S, S2, ADDR, NOW, nameEscrow, escrowContract, channelState } from './helpers/agent-chain.mjs'

const { createAgentKit, signMandate, mandateTypedData, forWallet, escrowPlan } = agent
const HUB = ADDR.hub
const EXP = { chainId: 56, hub: HUB }
const BEM = '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a'
const codes = (r) => r.problems.map((p) => p.code)
const signed = (m, key = KEYS.principalHolder) => ({ mandate: m, sig: signMandate(56, HUB, m, key, { allowFunds: true }) })
const kitOf = (x, o) => createAgentKit(x.api(), { clock: () => NOW, ...o })
const ON = { enforcement: 'escrow-channel' }
const STATIC = new Set(['phase0-no-funds', 'subdelegate-not-allowed', 'scope-token-cap-mismatch', 'fee-token-cap-mismatch', 'scope-duplicate-provider', 'mode-scope-mismatch'])
const vectors = JSON.parse(readFileSync(new URL('../../spec/vectors/container-agent.json', import.meta.url), 'utf8')).phase1
// a funded spend mandate of the standard world: provider S, 1 BEM / 标准世界里一张带金额的 spend 授权书
const funded = (o = {}) => ({ ...mandateOf({ mode: 1, scope: [{ provider: S, token: BEM, cap: '100000000' }], ...o }), ...(o.feeToken ? { feeToken: o.feeToken } : {}) })

test('FIXED P1-01: without the switch every check is phase 0 exactly as in 1.8: a funded mandate is phase0-no-funds, enforcement none, no phase-1 member', async () => {
  const x = standardWorld()
  for (const opt of [{}, { enforcement: 'none' }, { enforcement: 'Escrow-Channel' }, { enforcement: true }, { fundingPath: 'container' }]) {
    const r = await kitOf(x).verifyMandate(signed(funded()), opt)
    assert.deepEqual(codes(r), ['phase0-no-funds'], JSON.stringify(opt))
    assert.equal(r.enforcement, 'none'); assert.equal(r.phase, 0)
    for (const k of ['warnings', 'consumer', 'fundingPath', 'scope', 'fee']) assert.equal(k in r, false, k)
  }
  // a mandate that names no funds is phase 0 with the switch too / 不带金额的授权书带开关也是阶段 0
  const r0 = await kitOf(x).verifyMandate(signed(mandateOf()), ON)
  assert.equal(r0.ok, true); assert.equal(r0.phase, 0); assert.equal(r0.enforcement, 'none'); assert.equal('warnings' in r0, false)
})

test('FIXED P1-02: with the switch a funded mandate is checked by the phase-1 static rules; a valid one has no static problem and phase 1', async () => {
  const x = standardWorld()
  const r = await kitOf(x).verifyMandate(signed(funded()), ON)
  assert.equal(r.phase, 1)
  assert.deepEqual(codes(r).filter((c) => STATIC.has(c)), [])
  assert.deepEqual(r.warnings, [])
  const bad = await kitOf(x).verifyMandate(signed(funded({ mode: 0, nonce: '2' })), ON)
  assert.deepEqual(codes(bad), ['mode-scope-mismatch'])
  assert.equal(bad.ok, false); assert.equal(bad.enforcement, 'none')
  // bad option values are refused before any request / 选项值错误在任何请求之前就拒绝
  await assert.rejects(kitOf(x).verifyMandate(signed(funded()), { ...ON, fundingPath: 'wallet' }), (e) => e.code === 'INVALID_ARGUMENT')
  await assert.rejects(kitOf(x).verifyMandate(signed(funded()), { ...ON, feeDue: 5 }), (e) => e.code === 'INVALID_ARGUMENT')
  assert.throws(() => createAgentKit(x.api(), { allowEscrows: 'all' }), (e) => e.code === 'INVALID_ARGUMENT')
})

// The abstract cases of spec/vectors/container-agent.json phase1.static, run through verifyMandate on the fake chain:
// the vectors' addresses are mapped to the standard world (principal P, agent AG, providers S and S2).
// 向量里的抽象用例经 verifyMandate 在假链上运行：地址映射到标准世界。
test('FIXED P1-03: every phase1.static vector: phase, static problems in order, warnings and the nonce, as the draft requires', async () => {
  assert.ok(vectors.static.length >= 20)
  const map = (a) => ({ [vectors.static[0].mandate.principal.toLowerCase()]: P, [vectors.static[0].mandate.agent.toLowerCase()]: AG, '0x00000000000000000000000000000000000005e1': S, '0x00000000000000000000000000000000000005e2': S2 }[a.toLowerCase()] ?? a)
  for (const [i, c] of vectors.static.entries()) {
    const x = standardWorld()
    const nonces = new Map()
    const m = { ...c.mandate, principal: P, agent: AG, agentKey: addrOf(KEYS.agentKey), notBefore: NOW - 60, expires: NOW + 86400, nonce: String(100 + i), scope: c.mandate.scope.map((s) => ({ ...s, provider: map(s.provider) })) }
    const without = await kitOf(x, { nonces }).verifyMandate(signed(m))
    assert.deepEqual(codes(without).filter((k) => STATIC.has(k)), c.expect.withoutSwitch, `${c.name} (without the switch)`)
    assert.equal(agent.mandateNamesFunds(agent.normalizeMandate(m)), c.expect.funded, c.name)
    const nonces2 = new Map()
    const r = await kitOf(x, { nonces: nonces2 }).verifyMandate(signed(m), ON)
    assert.equal(r.phase, c.expect.phase, c.name)
    assert.deepEqual(codes(r).filter((k) => STATIC.has(k)), c.expect.problems, c.name)
    assert.deepEqual((r.warnings ?? []).map((w) => w.code), c.expect.warnings, c.name)
    assert.equal(nonces2.size === 1, c.expect.recordsNonce, `${c.name}: nonce`)
  }
})

test('FIXED P1-04: scope-includes-agent: a capped provider held by the agent\'s holder is reported, never refused; an uncapped one is not', async () => {
  const x = standardWorld()
  x.service(S, 13, { holderKey: KEYS.agentHolder, signerKey: KEYS.providerSigner, name: 'Provider held by the agent\'s holder' })
  const r = await kitOf(x).verifyMandate(signed(funded()), ON)
  assert.deepEqual(r.warnings.map((w) => w.code), ['scope-includes-agent'])
  assert.match(r.warnings[0].message, /held by/)
  assert.equal(codes(r).includes('scope-includes-agent'), false)
  // the same provider without a cap (a fee keeps the mandate funded): nothing to report / 同一 provider 不带金额：不报
  const m = { ...mandateOf({ mode: 1, scope: [{ provider: S, token: ZERO_ADDRESS, cap: '0' }], feeCap: '5', nonce: '9' }), feeToken: BEM }
  const r2 = await kitOf(x).verifyMandate(signed(m), ON)
  assert.equal(r2.phase, 1); assert.deepEqual(r2.warnings, [])
  // the agent itself as a capped provider is reported by address, whether or not its identity can be read
  // 代理自己作为带金额的 provider：按地址报告，不论能否读出它的身份
  const NC = '0x' + 'ab'.repeat(20)
  const r3 = await kitOf(x).verifyMandate(signed(funded({ agent: NC, nonce: '10', scope: [{ provider: NC, token: BEM, cap: '1' }] })), ON)
  assert.deepEqual(r3.warnings.map((w) => w.code), ['scope-includes-agent'])
  assert.match(r3.warnings[0].message, /agent's own container/)
})

test('FIXED P1-05: a static problem keeps the nonce unrecorded, so the corrected mandate (same nonce) passes; a phase-1 mandate that passes records it', async () => {
  const x = standardWorld()
  const kit = kitOf(x)
  for (const wrong of [funded({ mode: 0, nonce: '77' }), funded({ nonce: '77', scope: [{ provider: S, token: BEM, cap: '0' }] }), funded({ nonce: '77', feeCap: '3' }), funded({ nonce: '77', scope: [{ provider: S, token: BEM, cap: '1' }, { provider: S, token: BEM, cap: '2' }] })]) {
    assert.equal((await kit.verifyMandate(signed(wrong), ON)).ok, false)
  }
  const right = funded({ nonce: '77' })
  assert.deepEqual(codes(await kit.verifyMandate(signed(right), ON)).filter((c) => c === 'nonce-reused'), [])
  // now recorded: another mandate with nonce 77 is nonce-reused / 已记录：同 nonce 的另一张即 nonce-reused
  assert.ok(codes(await kit.verifyMandate(signed(funded({ nonce: '77', scope: [{ provider: S, token: BEM, cap: '5' }] })), ON)).includes('nonce-reused'))
})

test('FIXED P1-06: a thread passes the switch to its mandate: with it a funded mandate is applied (phase 1 at the top); without it the mandate is refused as in 1.8', async () => {
  const x = standardWorld()
  // the channel the holder funded for it (M2 reads it) / 持有人为它开的通道（M2 会读）
  const E = '0x' + 'e1'.repeat(20)
  nameEscrow(x, S, E); escrowContract(x, E, BEM)
  channelState(x, addrOf(KEYS.principalHolder), S, { channel: '100000000', session: NOW + 86400 })
  const kitOf = (y, o) => createAgentKit(y.api(), { clock: () => NOW, allowEscrows: [E], ...o })
  const t = happyThread({ m: funded() })
  const off = await kitOf(x).verifyTaskThread(t.messages)
  assert.ok(codes(off).includes('phase0-no-funds'))
  assert.equal(off.state, 'Accepted'); assert.equal(off.enforcement, 'none'); assert.equal('phase' in off, false); assert.equal('warnings' in off, false)
  const on = await kitOf(x).verifyTaskThread(t.messages, ON)
  assert.equal(codes(on).includes('phase0-no-funds'), false)
  assert.equal(on.phase, 1)
  assert.equal(on.state, 'Settled')
  assert.deepEqual(on.problems, [])
  assert.equal(on.enforcement, 'escrow-channel')
  assert.deepEqual(on.warnings, [])
  assert.deepEqual(on.scope, on.mandateCheck.scope)
  assert.equal(on.scope[0].channel, '100000000')
  assert.equal(on.mandateCheck.phase, 1)
  // a thread whose mandate breaks a static rule stays Accepted with the switch too / 违反静态规则的授权书带开关也不被应用
  const t2 = happyThread({ m: funded({ scope: [{ provider: S, token: ZERO_ADDRESS, cap: '5' }] }) })
  const r2 = await kitOf(x).verifyTaskThread(t2.messages, ON)
  assert.ok(codes(r2).includes('scope-token-cap-mismatch')); assert.equal(r2.state, 'Accepted')
})

test('FIXED P1-07: the phase-1 wallet payload: its own warning, every amount in the smallest unit and, with decimals, in whole tokens (18, 8 and 6 decimals); a mandate that breaks a rule is refused', () => {
  const T18 = '0x' + '18'.repeat(20), T6 = '0x' + '06'.repeat(20)
  const m = { ...mandateOf({ mode: 1, scope: [{ provider: S, token: T18, cap: '1500000000000000000' }, { provider: S2, token: BEM, cap: '100000000' }], feeCap: '1' }), feeToken: T6 }
  const td = mandateTypedData(56, HUB, m, { enforcement: 'escrow-channel', decimals: { [T18]: 18, [BEM.toLowerCase()]: 8, [T6]: 6 } })
  assert.deepEqual(td.warnings, [agent.MANDATE_ESCROW_CHANNEL_WARNING])
  assert.deepEqual(td.display.amounts.map((a) => [a.amount, a.decimals]), [['1500000000000000000', 18], ['100000000', 8]])
  assert.match(td.display.amounts[0].display, /^1\.5 of /)
  assert.match(td.display.amounts[1].display, /^1 of /)
  assert.match(td.display.fee.display, /^0\.000001 of /)
  // without decimals: the smallest unit, never a guess / 没有小数位：只给最小单位，绝不猜
  const nod = mandateTypedData(56, HUB, m, { enforcement: 'escrow-channel' })
  assert.equal(nod.display.amounts[0].decimals, null); assert.match(nod.display.amounts[0].display, /smallest unit/)
  // the message, types and domain are those of 1.8: the type is unchanged / 消息、类型与域与 1.8 相同
  const old = mandateTypedData(56, HUB, m, { allowFunds: true })
  assert.deepEqual([td.domain, td.types, td.message], [old.domain, old.types, old.message])
  assert.deepEqual(old.warnings, [agent.MANDATE_FUNDED_WARNING]); assert.equal('amounts' in old.display, false)
  // refused under the phase-1 rules (no allowFunds needed, none accepted silently) / 按阶段 1 规则拒绝
  for (const [bad, reason] of [[{ ...m, mode: 0 }, 'mode-scope-mismatch'], [{ ...m, subdelegate: true }, 'subdelegate-not-allowed'], [{ ...m, feeToken: ZERO_ADDRESS }, 'fee-token-cap-mismatch']]) {
    assert.throws(() => mandateTypedData(56, HUB, bad, { enforcement: 'escrow-channel' }), (e) => e.code === 'AGENT_INVALID' && e.data?.reason === reason, reason)
    assert.throws(() => signMandate(56, HUB, bad, KEYS.principalHolder, { enforcement: 'escrow-channel' }), (e) => e.code === 'AGENT_INVALID', reason)
  }
  assert.throws(() => mandateTypedData(56, HUB, m, { enforcement: 'escrow-channel', decimals: { [T18]: 18.5 } }), (e) => e.code === 'AGENT_INVALID')
  // without any option a funded mandate is still refused, as in 1.8 / 不带任何选项仍拒绝，与 1.8 相同
  assert.throws(() => mandateTypedData(56, HUB, m), (e) => e.code === 'AGENT_INVALID' && /allowFunds/.test(e.message))
  // a phase-0 mandate with the switch: the phase-0 notice and no amounts / 阶段 0 授权书带开关：阶段 0 提示、无金额
  const p0 = mandateTypedData(56, HUB, mandateOf(), { enforcement: 'escrow-channel' })
  assert.deepEqual(p0.warnings, [agent.MANDATE_PHASE0_NOTICE]); assert.equal('amounts' in p0.display, false)
})

test('FIXED P1-08: forWallet with expect.enforcement rebuilds under the phase-1 rules: the phase-1 warning, the amounts from the console\'s decimals (never from the payload); without it, 1.8\'s funded warning', () => {
  const m = funded()
  const td = mandateTypedData(56, HUB, m, { enforcement: 'escrow-channel', decimals: { [BEM]: 8 } })
  const forged = { ...td, warnings: ['all fine'], display: { ...td.display, amounts: [{ provider: S, token: BEM, amount: '1', decimals: 8, display: '0.00000001 of BEM' }] } }
  const w = forWallet(forged, { ...EXP, enforcement: 'escrow-channel', decimals: { [BEM]: 8 } })
  assert.deepEqual(w.warnings, [agent.MANDATE_ESCROW_CHANNEL_WARNING])
  assert.equal(w.display.amounts[0].amount, '100000000'); assert.match(w.display.amounts[0].display, /^1 of /)
  assert.deepEqual(Object.keys(w.payload).sort(), ['domain', 'message', 'primaryType', 'types'])
  assert.deepEqual(forWallet(td, EXP).warnings, [agent.MANDATE_FUNDED_WARNING])
  assert.throws(() => forWallet(td, { ...EXP, enforcement: 'escrow' }), (e) => e.code === 'AGENT_INVALID')
  // a message changed to break a phase-1 rule is refused under the switch / 改成违反阶段 1 规则的消息在开关下被拒
  assert.throws(() => forWallet({ ...td, message: { ...td.message, mode: 0 } }, { ...EXP, enforcement: 'escrow-channel' }), (e) => e.code === 'AGENT_INVALID')
})

// ---- escrowPlan (pure) / 持有人交易计划（纯函数） ----
const inner = (step, principal) => {
  if (!eqTo(step.tx.to, principal)) return step.tx
  const [to, value, data, op] = decodeParams(['address', 'uint256', 'bytes', 'uint8'], hexToBytes('0x' + step.tx.data.slice(10)))
  assert.equal(value, 0n); assert.equal(Number(op), 0)
  return { to, data: typeof data === 'string' ? data : '0x' + Buffer.from(data).toString('hex') }
}
const eqTo = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
// the options of one phase1.plan case: its path, providers, now, the M3 facts and the session history (S4b)
// 一个 plan 用例的选项：路径、providers、now、M3 的链上事实与会话历史
const planOpts = (c, base) => ({
  chainId: base.chainId, path: c.path, providers: c.providers, allowEscrows: base.allowEscrows,
  ...(c.path === 'holder' ? { holder: base.holder } : { executeFee: base.executeFee, maxExecuteFee: base.maxExecuteFee, holder: c.holder ?? base.holder }),
  ...(c.now !== undefined ? { now: c.now } : {}), ...(c.facts ?? {}), ...(c.history ? { history: c.history, hub: base.hub } : {}),
})

test('FIXED P1-09: every phase1.plan vector: the steps, their order and amounts, the allowance checks, where each goes, or the reason it is refused', () => {
  const base = vectors.planBase
  assert.ok(vectors.plan.length >= 15)
  for (const c of vectors.plan) {
    const opts = planOpts(c, base)
    if (c.expect.refused) {
      assert.throws(() => escrowPlan(c.mandate, opts), (e) => (e.data?.reason ?? e.reason) === c.expect.refused, `${c.name}: ${c.expect.refused}`)
      continue
    }
    const plan = escrowPlan(c.mandate, opts)
    const got = plan.steps.map((s) => [s.kind, s.escrow, s.provider ?? null, s.kind === 'authorizeSession' ? null : s.amount])
    const lc = (row) => row.map((v) => (typeof v === 'string' ? v.toLowerCase() : v))
    assert.deepEqual(got.map(lc), c.expect.steps.map(lc), c.name)
    assert.deepEqual(plan.checks.map((k) => k.escrow.toLowerCase()), c.expect.checks.map((e) => e.toLowerCase()), c.name)
    // review p1m3 B1: what the record carries for the next run and the read-back / 记录里带给下次重跑与读回的 claimedAtPlan
    if (c.expect.claimedAtPlan) assert.deepEqual(plan.record.map((r) => r.claimedAtPlan), c.expect.claimedAtPlan, c.name)
    // review p1m3 recheck: what the key spent on the mandate's released channels elsewhere / 钥匙在已放行的其它通道上花掉的
    if (c.expect.spentElsewhere) assert.deepEqual(plan.record.map((r) => r.spentElsewhere), c.expect.spentElsewhere, c.name)
    // review p1m3 R1: the container path's fee in all / 容器路径的费用合计
    if (c.expect.fees) assert.deepEqual(plan.fees, c.expect.fees, c.name)
    // review p1m3 recheck 3: whether a history was given at all / 是否给了历史
    if (c.expect.checked) assert.deepEqual(plan.checked, c.expect.checked, c.name)
    if (c.expect.recordBlock) assert.deepEqual(plan.record.map((r) => r.block), c.expect.recordBlock, c.name)
    for (const s of plan.steps) {
      if (c.expect.to === 'principal') {
        assert.ok(eqTo(s.tx.to, c.mandate.principal), c.name)
        assert.equal(s.tx.value, '0x' + BigInt(base.executeFee).toString(16), c.name)
        assert.ok(s.tx.data.startsWith(agent.EXECUTE_SELECTOR), c.name)
      } else {
        assert.ok(eqTo(s.tx.to, s.kind === 'approve' ? s.token : s.escrow), c.name)
        assert.equal(s.tx.value, '0x0', c.name)
      }
      // the inner call decodes back to the step's own fields / 内层调用解码回步骤自己的字段
      const call = inner(s, c.mandate.principal)
      if (s.kind === 'approve') { const [sp, amt] = decodeCall('approve', call.data); assert.ok(eqTo(sp, s.escrow)); assert.equal(amt.toString(), s.amount); assert.ok(eqTo(call.to, s.token)) }
      if (s.kind === 'fund') { const [pv, amt] = decodeCall('fund', call.data); assert.ok(eqTo(pv, s.provider)); assert.equal(amt.toString(), s.amount); assert.ok(eqTo(call.to, s.escrow)) }
      if (s.kind === 'authorizeSession') {
        const [pv, key, exp] = decodeCall('authorizeSession', call.data)
        assert.ok(eqTo(pv, s.provider)); assert.ok(eqTo(key, c.mandate.agentKey)); assert.equal(Number(exp), c.mandate.expires); assert.ok(eqTo(call.to, s.escrow))
        assert.equal(s.sendAfter, c.mandate.notBefore)
      }
    }
    for (const k of plan.checks) { const call = inner(k.ifNot, c.mandate.principal); const [sp, amt] = decodeCall('approve', call.data); assert.ok(eqTo(sp, k.escrow)); assert.equal(amt, 0n); assert.ok(eqTo(call.to, k.token)) }
  }
})

test('FIXED P1-10: escrowPlan: the consumer is the holder (F2) or the principal (F1); F1 without a fee says so; nothing is written in that only the chain or the caller knows', () => {
  const v = vectors.plan[0]
  const base = vectors.planBase
  const f2 = escrowPlan(v.mandate, { chainId: 56, holder: base.holder, providers: v.providers, allowEscrows: base.allowEscrows })
  assert.equal(f2.path, 'holder'); assert.equal(f2.consumer.toLowerCase(), base.holder.toLowerCase())
  assert.match(f2.steps[0].summary.join('\n'), /approve\(spender = .*amount = 100000000\)/)
  const f1 = escrowPlan(v.mandate, { chainId: 56, path: 'container', holder: base.holder, providers: v.providers, allowEscrows: base.allowEscrows })
  // review p1m3 S6: the container path needs the holder too (it calls execute) / 容器路径也要 holder
  assert.throws(() => escrowPlan(v.mandate, { chainId: 56, path: 'container', providers: v.providers, allowEscrows: base.allowEscrows }), (e) => e.code === 'INVALID_ARGUMENT')
  assert.equal(f1.consumer, v.mandate.principal)
  for (const s of f1.steps) { assert.equal(s.tx.value, '0x0'); assert.match(s.summary.join('\n'), /outer value is 0/) }
  assert.ok(f1.notes.some((n) => /executeFee/.test(n)))
  // the holder path needs the holder, takes no fee; the chain id is required / F2 需要持有人、不收费；chainId 必填
  assert.throws(() => escrowPlan(v.mandate, { chainId: 56, providers: v.providers, allowEscrows: base.allowEscrows }), (e) => e.code === 'INVALID_ARGUMENT')
  assert.throws(() => escrowPlan(v.mandate, { chainId: 56, holder: base.holder, executeFee: '1', providers: v.providers, allowEscrows: base.allowEscrows }), (e) => e.code === 'INVALID_ARGUMENT')
  assert.throws(() => escrowPlan(v.mandate, { holder: base.holder, providers: v.providers, allowEscrows: base.allowEscrows }), (e) => e.code === 'INVALID_ARGUMENT')
  // every capped provider needs exactly one entry; none other / 每个带金额的 provider 恰好一条
  assert.throws(() => escrowPlan(v.mandate, { chainId: 56, holder: base.holder, providers: [], allowEscrows: base.allowEscrows }), (e) => e.code === 'INVALID_ARGUMENT')
  assert.throws(() => escrowPlan(v.mandate, { chainId: 56, holder: base.holder, providers: [...v.providers, v.providers[0]], allowEscrows: base.allowEscrows }), (e) => e.code === 'INVALID_ARGUMENT')
  assert.throws(() => escrowPlan(v.mandate, { chainId: 56, holder: base.holder, providers: [...v.providers, { provider: S2, escrow: base.allowEscrows[0], token: BEM }], allowEscrows: base.allowEscrows }), (e) => e.code === 'INVALID_ARGUMENT')
  // AUDITED_ESCROWS is empty: without allowEscrows nothing is planned / 审计名单为空：不给 allowEscrows 就不出计划
  assert.throws(() => escrowPlan(v.mandate, { chainId: 56, holder: base.holder, providers: v.providers }), (e) => e.data?.reason === 'escrow-not-allowed')
  // a phase-0 mandate needs no plan / 阶段 0 授权书不需要计划
  assert.throws(() => escrowPlan({ ...v.mandate, scope: [] }, { chainId: 56, holder: base.holder, providers: [], allowEscrows: base.allowEscrows }), (e) => e.data?.reason === 'nothing-to-plan')
})

// ---- review p1m12 (independent adversarial review of M1-M2) / 审查 p1m12 ----
test('FIXED P1M12-F3 (review B4, A13): escrowPlan refuses contradictory inputs instead of letting the last one win', () => {
  const base = vectors.planBase
  const E1 = base.allowEscrows[0]
  const TOK2 = '0x' + '70'.repeat(20)
  const opts = (providers, o = {}) => ({ chainId: 56, holder: base.holder, providers, allowEscrows: base.allowEscrows, ...o })
  const reason = (f) => { try { f(); return 'ACCEPTED' } catch (e) { return e.data?.reason ?? e.code } }
  // B4: one escrow, two caller tokens (each equal to its scope token): before the fix one approve on the LAST token was
  // built and the fund in the other token went unapproved / 修复前只对后一个代币构造 approve
  const two = funded({ scope: [{ provider: S, token: BEM, cap: '1' }, { provider: S2, token: TOK2, cap: '2' }] })
  assert.equal(reason(() => escrowPlan(two, opts([{ provider: S, escrow: E1, token: BEM }, { provider: S2, escrow: E1, token: TOK2 }]))), 'escrow-token-mismatch')
  // the same escrow with the same token twice is fine: one approve of the sum / 同托管同代币：一笔 approve
  const same = escrowPlan(funded({ scope: [{ provider: S, token: BEM, cap: '1' }, { provider: S2, token: BEM, cap: '2' }] }), opts([{ provider: S, escrow: E1, token: BEM }, { provider: S2, escrow: E1, token: BEM }]))
  assert.deepEqual(same.steps.filter((s) => s.kind === 'approve').map((s) => s.amount), ['3'])
  // a channel to the consumer itself: the holder on the holder path, the principal on the container path
  const self = funded({ scope: [{ provider: base.holder, token: BEM, cap: '5' }] })
  assert.equal(reason(() => escrowPlan(self, opts([{ provider: base.holder, escrow: E1, token: BEM }]))), 'provider-is-consumer')
  const selfP = funded({ scope: [{ provider: P, token: BEM, cap: '5' }] })
  assert.equal(reason(() => escrowPlan(selfP, opts([{ provider: P, escrow: E1, token: BEM }], { path: 'container' }))), 'provider-is-consumer')
  // the principal as a provider on the holder path is a channel (holder, principal): not the consumer, so planned
  assert.equal(escrowPlan(selfP, opts([{ provider: P, escrow: E1, token: BEM }])).steps.length, 3)
  // a provider that is an escrow of the plan (fund would revert BadProvider) / provider 是计划里的托管
  const esc = funded({ scope: [{ provider: E1, token: BEM, cap: '5' }] })
  assert.equal(reason(() => escrowPlan(esc, opts([{ provider: E1, escrow: E1, token: BEM }]))), 'provider-is-escrow')
  // the zero address as a provider never reaches the plan: the mandate itself is malformed / 零地址在授权书层面即被拒
  assert.throws(() => escrowPlan({ ...funded(), scope: [{ provider: ZERO_ADDRESS, token: BEM, cap: '1' }] }, opts([{ provider: ZERO_ADDRESS, escrow: E1, token: BEM }])), (e) => e.code === 'AGENT_INVALID' && /zero address/.test(e.message))
})

test('FIXED P1M12-F5 (review B5): allowFunds together with the phase-1 switch is checked by the phase-1 rules (the switch comes first)', () => {
  const both = { allowFunds: true, enforcement: 'escrow-channel' }
  const payWithCap = funded({ mode: 0 })   // mode 0 with a scope cap: mode-scope-mismatch
  assert.throws(() => mandateTypedData(56, HUB, payWithCap, both), (e) => e.code === 'AGENT_INVALID' && e.data?.reason === 'mode-scope-mismatch')
  assert.throws(() => signMandate(56, HUB, payWithCap, KEYS.principalHolder, both), (e) => e.code === 'AGENT_INVALID' && e.data?.reason === 'mode-scope-mismatch')
  // a mandate that keeps the phase-1 rules: the phase-1 payload, as with the switch alone / 合规时与只带开关相同
  const ok = mandateTypedData(56, HUB, funded(), both)
  assert.deepEqual(ok.warnings, [agent.MANDATE_ESCROW_CHANNEL_WARNING]); assert.equal(ok.display.amounts.length, 1)
  assert.deepEqual(ok, mandateTypedData(56, HUB, funded(), { enforcement: 'escrow-channel' }))
  // allowFunds alone is 1.8 exactly: the funded warning, no amounts, no phase-1 rule / 只给 allowFunds 与 1.8 完全相同
  const old = mandateTypedData(56, HUB, payWithCap, { allowFunds: true })
  assert.deepEqual(old.warnings, [agent.MANDATE_FUNDED_WARNING]); assert.equal('amounts' in old.display, false)
})

test('FIXED P1M12-F7 (review B2): the static half of scope-includes-agent is reported whatever the static problems; the agent\'s own container is reported once', async () => {
  const x = standardWorld()
  // a static problem and the agent in scope: the SDK used to drop the warning (the chain stage never ran); verify.py did not
  const r = await kitOf(x).verifyMandate(signed(funded({ mode: 0, scope: [{ provider: AG, token: BEM, cap: '1' }] })), ON)
  assert.deepEqual(codes(r).filter((k) => STATIC.has(k)), ['mode-scope-mismatch'])
  assert.deepEqual(r.warnings.map((w) => w.code), ['scope-includes-agent'])
  assert.deepEqual(agent.phase1Warnings(agent.normalizeMandate(funded({ scope: [{ provider: AG, token: BEM, cap: '1' }] }))).map((w) => w.code), ['scope-includes-agent'])
  assert.deepEqual(agent.phase1Warnings(agent.normalizeMandate(funded())), [])
  // the agent (a real container, same holder as itself) capped without static problems: one warning, not two
  const r2 = await kitOf(x).verifyMandate(signed(funded({ nonce: '2', scope: [{ provider: AG, token: BEM, cap: '1' }] })), ON)
  assert.deepEqual(r2.warnings.map((w) => w.code), ['scope-includes-agent'])
  assert.match(r2.warnings[0].message, /agent's own container/)
})
