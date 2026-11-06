// Container agents, phase 1 (experimental): the close-out in explicit, resumable steps (BEM drill F10).
// closeOutPlan lists the whole close-out at once and a withdraw sent with its requestWithdraw reverts (the drill paid
// 29,482 gas for one); closeOutNext / kit.closeOutStep hand out only what may be sent now, from the chain facts at one
// pinned block and the caller's state, and a restart anywhere in the 48 hours resumes. Every clock is passed in (time
// control); the chain is the fake one. Every case named FIXED P1CO-xx was checked by removing the line that implements it.
// 阶段 1（实验）：分步、可恢复的收尾（演练 F10）。closeOutNext / kit.closeOutStep 只给出现在能发的；48 小时内任意时刻重启都能恢复。
// 时钟全部由测试给出；假链。FIXED P1CO-xx 都做过反向检查。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as agent from '@tapeapi/sdk/agent'
import { decodeCall } from '../src/abi.js'
import { standardWorld, mandateOf, KEYS, addrOf, P, S, S2, NOW, BEM_TOKEN, nameEscrow, escrowContract, channelState } from './helpers/agent-chain.mjs'

const { createAgentKit, closeOutPlan, closeOutNext, WITHDRAW_COOLDOWN_S, WITHDRAW_WINDOW_S, CLOSE_OUT_RESEND_S } = agent
const HOLDER = addrOf(KEYS.principalHolder)
const E1 = '0x' + 'e1'.repeat(20)
const EXPIRES = NOW + 86400
const m2 = (o = {}) => mandateOf({ mode: 1, expires: EXPIRES, scope: [{ provider: S, token: BEM_TOKEN, cap: '100' }, { provider: S2, token: BEM_TOKEN, cap: '50' }], ...o })
function world() {
  const x = standardWorld()
  nameEscrow(x, S, E1); nameEscrow(x, S2, E1); escrowContract(x, E1, BEM_TOKEN)
  channelState(x, HOLDER, S, { channel: '70' }); channelState(x, HOLDER, S2, { channel: '30' })
  return x
}
// a new kit each time: a restarted console has nothing in memory but the state it kept / 每次新建 kit：重启后的控制台只剩它保存的状态
const kitOf = (x) => createAgentKit(x.api(), { clock: () => NOW, allowEscrows: [E1] })
const kitReason = async (p) => { try { await p; return 'ACCEPTED' } catch (e) { return e.data?.reason ?? e.code } }
const kinds = (steps) => steps.map((s) => [s.kind, s.provider.toLowerCase()])
const keep = (r) => JSON.parse(JSON.stringify(r.state))   // what a console writes to disk / 控制台写盘的内容
const step = (x, now, state, o = {}) => kitOf(x).closeOutStep(m2(), { holder: HOLDER, history: [], now, state, ...o })
const T0 = EXPIRES + 600

test('FIXED P1CO-01 (F10): closeOutPlan splits the close-out into sendNow and sendLater; a withdraw before its window is never in sendNow', async () => {
  const x = world()
  const plan = await kitOf(x).closeOut(m2(), { holder: HOLDER, history: [], now: T0 })
  assert.deepEqual(kinds(plan.steps), [['requestWithdraw', S], ['requestWithdraw', S2], ['withdraw', S], ['withdraw', S2]], 'steps unchanged')
  assert.deepEqual(kinds(plan.sendNow), [['requestWithdraw', S], ['requestWithdraw', S2]])
  assert.deepEqual(kinds(plan.sendLater), [['withdraw', S], ['withdraw', S2]])
  assert.ok(plan.notes.some((n) => /sendNow/.test(n) && /F10/.test(n)))
  // a live request whose window is open: its withdraw is in sendNow; one still cooling: in sendLater
  // 窗口已开的存活请求：withdraw 在 sendNow；仍在冷静期的：在 sendLater
  x.chain.setPendingWithdraw(HOLDER, S, 70, T0 - WITHDRAW_COOLDOWN_S)
  x.chain.setPendingWithdraw(HOLDER, S2, 30, T0 - 60)
  const p2 = await kitOf(x).closeOut(m2(), { holder: HOLDER, history: [], now: T0 })
  assert.deepEqual(kinds(p2.sendNow), [['withdraw', S]])
  assert.deepEqual(kinds(p2.sendLater), [['withdraw', S2]])
})

test('FIXED P1CO-02 (F10): closeOutStep hands out requestWithdraw, waits through the cooldown across a restart, then withdraw, then says done; each step once', async () => {
  const x = world()
  // 1. begin: both requests, no withdraw / 开始：两个请求，没有 withdraw
  const a = await step(x, T0, null)
  assert.equal(a.phase, 'send')
  assert.deepEqual(kinds(a.send), [['requestWithdraw', S], ['requestWithdraw', S2]])
  assert.deepEqual(a.send.map((s) => decodeCall('requestWithdraw', s.tx.data).map((v) => String(v).toLowerCase())), [[S.toLowerCase(), '70'], [S2.toLowerCase(), '30']])
  assert.deepEqual(a.items.map((i) => i.stage), ['request-issued', 'request-issued'])
  assert.deepEqual(a.log.map((l) => l.event), ['request-issued', 'request-issued'])
  assert.equal(a.state.log.length, 2); assert.equal(a.log[0].block, a.pin.number)
  let st = keep(a)
  // 2. a minute later, the requests not yet in a block: nothing handed out again (it would restart the 48 hours)
  // 一分钟后请求尚未进块：不再给出（否则 48 小时重新计时）
  const b = await step(x, T0 + 60, st)
  assert.equal(b.phase, 'wait'); assert.deepEqual(b.send, []); assert.equal(b.waitUntil, T0 + CLOSE_OUT_RESEND_S)
  st = keep(b)
  // 3. the requests landed at T0 + 30; the console restarts an hour later with its state: cooling, nothing to send
  // 请求在 T0 + 30 落块；一小时后控制台带着状态重启：冷静期，不发
  x.chain.setPendingWithdraw(HOLDER, S, 70, T0 + 30); x.chain.setPendingWithdraw(HOLDER, S2, 30, T0 + 30)
  const from = T0 + 30 + WITHDRAW_COOLDOWN_S
  const c = await step(x, T0 + 3600, st)
  assert.equal(c.phase, 'wait'); assert.deepEqual(c.send, []); assert.equal(c.waitUntil, from)
  assert.deepEqual(c.items.map((i) => [i.stage, i.withdrawFrom, i.withdrawUntil]), [['cooling', from, from + WITHDRAW_WINDOW_S], ['cooling', from, from + WITHDRAW_WINDOW_S]])
  assert.deepEqual(c.log.map((l) => l.event), ['request-seen', 'request-seen'])
  st = keep(c)
  // 4. one second before the window: still nothing (a withdraw now reverts CooldownActive) / 窗口前一秒：仍不发
  const d = await step(x, from - 1, st)
  assert.equal(d.phase, 'wait'); assert.deepEqual(d.send, []); assert.deepEqual(d.log, [], 'nothing new to log')
  st = keep(d)
  // 5. the window opens: both withdraws / 窗口打开：两个 withdraw
  const e = await step(x, from, st)
  assert.equal(e.phase, 'send'); assert.deepEqual(kinds(e.send), [['withdraw', S], ['withdraw', S2]])
  assert.deepEqual(e.send.map((s) => [s.sendAfter, s.sendBefore]), [[from, from + WITHDRAW_WINDOW_S], [from, from + WITHDRAW_WINDOW_S]])
  st = keep(e)
  // 6. asked again at once (a retry, a second process with the same state): not handed out twice / 立即再问：不重复给出
  const f = await step(x, from + 5, st)
  assert.equal(f.phase, 'wait'); assert.deepEqual(f.send, [])
  st = keep(f)
  // 7. the withdraws landed: done, logged once / withdraw 落块：完成，只记一次
  for (const p of [S, S2]) { x.chain.setChannel(HOLDER, p, 0); x.chain.setPendingWithdraw(HOLDER, p, 0, 0) }
  const g = await step(x, from + 120, st)
  assert.equal(g.phase, 'done'); assert.deepEqual(g.send, []); assert.equal(g.waitUntil, null)
  assert.deepEqual(g.items.map((i) => i.stage), ['done', 'done'])
  assert.deepEqual(g.log.map((l) => l.event), ['channel-empty', 'channel-empty', 'close-out-done'])
  assert.equal(g.state.done, true)
  const h = await step(x, from + 240, keep(g))
  assert.equal(h.phase, 'done'); assert.deepEqual(h.log, [], 'done is logged once')
  // the whole story is in the kept log / 全过程都在保存的日志里
  assert.deepEqual(h.state.log.map((l) => l.event), ['request-issued', 'request-issued', 'request-seen', 'request-seen', 'withdraw-issued', 'withdraw-issued', 'channel-empty', 'channel-empty', 'close-out-done'])
})

test('FIXED P1CO-03: a live request is never requested again, even by a console that lost its state (it would restart the 48 hours)', async () => {
  const x = world()
  x.chain.setPendingWithdraw(HOLDER, S, 70, T0 - 3600); x.chain.setPendingWithdraw(HOLDER, S2, 30, T0 - 3600)
  const r = await step(x, T0, null)
  assert.equal(r.phase, 'wait'); assert.deepEqual(r.send, [])
  assert.deepEqual(r.items.map((i) => i.stage), ['cooling', 'cooling'])
})

test('FIXED P1CO-04: a step that never landed is handed out again after resendAfterS; a lapsed request and a request that disappeared are requested again, and logged', async () => {
  // never landed / 从未落块
  const x = world()
  const st = keep(await step(x, T0, null))
  const again = await step(x, T0 + CLOSE_OUT_RESEND_S, st)
  assert.deepEqual(kinds(again.send), [['requestWithdraw', S], ['requestWithdraw', S2]])
  assert.deepEqual(again.log.map((l) => l.event), ['request-reissued', 'request-reissued'])
  const quick = await step(x, T0 + 30, st, { resendAfterS: 10 })
  assert.equal(quick.send.length, 2, 'resendAfterS is the caller\'s')
  // lapsed: 48 h + 7 d after the request, the withdraw never sent / 过期：请求后 48 小时 + 7 天，withdraw 一直没发
  const y = world()
  y.chain.setPendingWithdraw(HOLDER, S, 70, T0); y.chain.setPendingWithdraw(HOLDER, S2, 30, T0)
  const cooling = keep(await step(y, T0 + 60, null))
  const late = T0 + WITHDRAW_COOLDOWN_S + WITHDRAW_WINDOW_S + 1
  const l = await step(y, late, cooling)
  assert.deepEqual(kinds(l.send), [['requestWithdraw', S], ['requestWithdraw', S2]])
  assert.deepEqual(l.log.map((e) => e.event), ['request-lapsed', 'request-lapsed'])
  // cancelled (or replaced) behind the console's back: requested again / 背着控制台被撤回：重新请求
  const z = world()
  z.chain.setPendingWithdraw(HOLDER, S, 70, T0); z.chain.setPendingWithdraw(HOLDER, S2, 30, T0)
  const seen = keep(await step(z, T0 + 60, null))
  z.chain.setPendingWithdraw(HOLDER, S, 0, 0)
  const g = await step(z, T0 + 120, seen)
  assert.deepEqual(kinds(g.send), [['requestWithdraw', S]])
  assert.deepEqual(g.log.map((e) => e.event), ['request-gone'])
  assert.deepEqual(g.items.map((i) => i.stage), ['request-issued', 'cooling'])
})

test('FIXED P1CO-05: closeOutStep needs a state (null to begin); a state of another close-out is refused; a new close-out with nothing to close is nothing-to-close', async () => {
  const x = world()
  assert.equal(await kitReason(kitOf(x).closeOutStep(m2(), { holder: HOLDER, history: [], now: T0 })), 'INVALID_ARGUMENT')
  const st = keep(await step(x, T0, null))
  // another mandate (another expires) / 另一张授权书
  const other = kitOf(x).closeOutStep(m2({ expires: EXPIRES + 1 }), { holder: HOLDER, history: [], now: T0 + 1, state: st })
  await assert.rejects(other, (e) => e.code === 'INVALID_ARGUMENT' && /another close-out/.test(e.message))
  // another consumer / 另一个 consumer
  await assert.rejects(step(x, T0 + 1, { ...st, consumer: P }), (e) => e.code === 'INVALID_ARGUMENT')
  await assert.rejects(step(x, T0 + 1, { ...st, v: 2 }), (e) => e.code === 'INVALID_ARGUMENT')
  // nothing funded: a new close-out refuses, as closeOut does / 没有充值：新收尾与 closeOut 一样拒绝
  const empty = standardWorld(); nameEscrow(empty, S, E1); nameEscrow(empty, S2, E1); escrowContract(empty, E1, BEM_TOKEN)
  assert.equal(await kitReason(step(empty, T0, null)), 'nothing-to-close')
  // closeOut's own refusals hold here too: the escrow is not known (R23) / closeOut 自己的拒绝在这里同样成立
  const lost = world(); nameEscrow(lost, S, null)
  assert.equal(await kitReason(step(lost, T0, null)), 'escrow-unknown')
})

test('FIXED P1CO-06: closeOutNext is pure: the same facts and state give the same answer; the state is plain JSON', () => {
  const m = m2()
  const channels = [{ provider: S, escrow: E1, channel: '70', pending: null }, { provider: S2, escrow: E1, channel: '0', pending: null }]
  const o = { chainId: 56, holder: HOLDER, now: T0, channels, history: [] }
  const a = closeOutNext(m, { ...o, state: null, pinBlock: 7 })
  assert.deepEqual(kinds(a.send), [['requestWithdraw', S]])
  assert.deepEqual(a.items.map((i) => i.stage), ['request-issued', 'empty'])
  assert.deepEqual(JSON.parse(JSON.stringify(a.state)), a.state)
  assert.deepEqual(closeOutNext(m, { ...o, state: null, pinBlock: 7 }), a)
  // the same as closeOutPlan's first step / 与 closeOutPlan 的第一步相同
  assert.deepEqual(a.send[0].tx, closeOutPlan(m, o).sendNow[0].tx)
  assert.throws(() => closeOutNext(m, { ...o, now: undefined, state: null }), (e) => e.code === 'INVALID_ARGUMENT')
  assert.throws(() => closeOutNext(m, { ...o, state: { v: 1 } }), (e) => e.code === 'INVALID_ARGUMENT')
})

// ---- review 2026-10-22 / 审查 ----
test('FIXED OPS-A1: a state whose issuedAt is after now (a tampered file, a clock set back) does not hold the close-out in wait forever', () => {
  const m = m2()
  const channels = [{ provider: S, escrow: E1, channel: '70', pending: null }, { provider: S2, escrow: E1, channel: '0', pending: null }]
  const o = { chainId: 56, holder: HOLDER, channels, history: [] }
  const a = closeOutNext(m, { ...o, now: T0, state: null, pinBlock: 7 })
  // the file says the request was handed out a year from now / 文件说请求是一年之后给出的
  const bad = keep(a); bad.channels[0].issuedAt = T0 + 365 * 86400
  const b = closeOutNext(m, { ...o, now: T0 + 60, state: bad, pinBlock: 8 })
  assert.equal(b.phase, 'send', 'before the fix: wait, until a year from now'); assert.deepEqual(kinds(b.send), [['requestWithdraw', S]])
  assert.ok(b.log.some((l) => l.event === 'state-from-future'))
  // an honest state one minute old still waits / 诚实的、一分钟前的状态照样等
  assert.equal(closeOutNext(m, { ...o, now: T0 + 60, state: keep(a), pinBlock: 8 }).phase, 'wait')
})

test('FIXED OPS-A2 (decision 6): a requestWithdraw handed out again carries the nonce of the stuck one (closeOutSent), so it replaces it instead of restarting the 48 hours', () => {
  const { closeOutSent } = agent
  const m = m2()
  const channels = [{ provider: S, escrow: E1, channel: '70', pending: null }, { provider: S2, escrow: E1, channel: '0', pending: null }]
  const o = { chainId: 56, holder: HOLDER, channels, history: [] }
  const a = closeOutNext(m, { ...o, now: T0, state: null, pinBlock: 7 })
  const sent = closeOutSent(keep(a), { provider: S, nonce: 41 })
  assert.equal(sent.channels[0].nonce, 41); assert.equal(keep(a).channels[0].nonce, null, 'the old state is not changed')
  // within resendAfterS: wait, the nonce kept / resendAfterS 之内：等待，nonce 保留
  const w = closeOutNext(m, { ...o, now: T0 + 60, state: sent, pinBlock: 8 })
  assert.equal(w.phase, 'wait'); assert.equal(w.state.channels[0].nonce, 41)
  // after it, still not on chain: handed out again WITH that nonce / 之后链上仍没有：带着那个 nonce 再给一次
  const r = closeOutNext(m, { ...o, now: T0 + CLOSE_OUT_RESEND_S + 1, state: w.state, pinBlock: 9 })
  assert.deepEqual(kinds(r.send), [['requestWithdraw', S]]); assert.equal(r.send[0].replaceNonce, 41, 'before the fix: no nonce, a second transaction')
  assert.ok(r.log.some((l) => l.event === 'request-reissued' && /nonce 41/.test(l.detail)))
  // not recorded: handed out again without one, and the log says to reuse the stuck one's / 没记 nonce：照样给出，日志提示沿用卡住那笔的
  const r2 = closeOutNext(m, { ...o, now: T0 + CLOSE_OUT_RESEND_S + 1, state: keep(a), pinBlock: 9 })
  assert.equal(r2.send[0].replaceNonce, undefined); assert.ok(r2.log.some((l) => /never a new one/.test(l.detail)))
  // a first step never carries one; closeOutSent refuses a channel with nothing sent / 第一步从不带；没发过的通道拒绝
  assert.equal(a.send[0].replaceNonce, undefined)
  assert.throws(() => closeOutSent(keep(a), { provider: S2, nonce: 1 }), (e) => e.code === 'INVALID_ARGUMENT')
  assert.throws(() => closeOutSent(keep(a), { provider: S, nonce: -1 }), (e) => e.code === 'INVALID_ARGUMENT')
})

test('FIXED OPS-A3 (decisions 5, 7): closeOutStep reads its facts at the finalized block and is due by the chain\'s time, not a clock ahead of it', async () => {
  const x = world()
  const at = T0 - 3600
  x.chain.setPendingWithdraw(HOLDER, S, 70, at); x.chain.setPendingWithdraw(HOLDER, S2, 30, at)
  const from = at + WITHDRAW_COOLDOWN_S
  // the clock says the window is open, the chain is 30 s short of it / 本机时钟说窗口已开，链上还差 30 秒
  x.chain.state.headTime = from - 30
  const early = await step(x, from + 5, null)
  assert.equal(early.phase, 'wait', 'before the fix: send, a withdraw that reverts CooldownActive'); assert.equal(early.send.length, 0)
  assert.equal(early.pin.tag, 'finalized'); assert.equal(early.pin.timestamp, from - 30 - 2)
  x.chain.state.headTime = from + 10
  const due = await step(x, from + 15, keep(early))
  assert.deepEqual(kinds(due.send), [['withdraw', S], ['withdraw', S2]])
  assert.equal(due.pin.tag, 'finalized'); assert.equal(due.pin.number, x.st.block - 2)   // finalized = head − 2 on this chain / 本假链 finalized 为 head − 2
})
