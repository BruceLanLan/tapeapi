// Container agents, phase 1 (experimental, internal design notes, phase 1, §3b.2, R21): the channel
// mapping behind { enforcement: 'escrow-channel' }, on the fake chain. contracts/test/Phase1Mapping.t.sol checks, on the
// unchanged v3 escrow, the contract behaviour these readings rely on. Every case named FIXED P1-xx was checked by removing
// the line that implements it (the test turns red). Every clock is fixed (NOW).
// 阶段 1（实验）：开关下的通道映射核验（假链）。Phase1Mapping.t.sol 在未改的 v3 托管上核对这些读数依赖的合约行为。时钟固定。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as agent from '@tapeapi/sdk/agent'
import { selector } from '../src/abi.js'
import {
  standardWorld, happyThread, mandateOf, revocationMsg, KEYS, addrOf, P, AG, S, S2, RPC, NOW, TOKEN, BEM_TOKEN,
  nameEscrow, escrowContract, channelState,
} from './helpers/agent-chain.mjs'

const { createAgentKit, signMandate, withdrawRequestLive } = agent
const HUB = '0x' + '10'.repeat(20)
const codes = (r) => r.problems.map((p) => p.code)
const signed = (m, key = KEYS.principalHolder) => ({ mandate: m, sig: signMandate(56, HUB, m, key, { allowFunds: true }) })
const ON = { enforcement: 'escrow-channel' }
const HOLDER = addrOf(KEYS.principalHolder)
const KEY = addrOf(KEYS.agentKey)
const v = JSON.parse(readFileSync(new URL('../../spec/vectors/container-agent.json', import.meta.url), 'utf8')).phase1
const T = v.mapping.times
assert.equal(T.N, NOW, 'the vectors\' N is the tests\' fixed now')
const S1 = T.expires
const ESC = { P1: '0x' + 'e1'.repeat(20), P2: '0x' + 'e2'.repeat(20), agent: '0x' + 'ea'.repeat(20) }
const PARTY = { P1: S, P2: S2, agent: AG }
const TOK = { A: BEM_TOKEN, B: TOKEN, C: '0x' + 'cc'.repeat(20) }   // C has no decimals() / C 没有 decimals()
const fundedMandate = (o = {}) => ({ ...mandateOf({ mode: 1, notBefore: T.notBefore, expires: S1, scope: [{ provider: S, token: BEM_TOKEN, cap: '100' }], ...o }), ...(o.feeToken ? { feeToken: o.feeToken } : {}) })
// one provider S on escrow ESC.P1 holding BEM; the holder's channel at its cap with the key's session / 一个 provider、一条满额通道
function world({ channel = '100', session = S1, pending = null, consumer = HOLDER } = {}) {
  const x = standardWorld()
  nameEscrow(x, S, ESC.P1); escrowContract(x, ESC.P1, BEM_TOKEN)
  channelState(x, consumer, S, { channel, session, pending })
  return x
}
const kitOf = (x, o) => createAgentKit(x.api(), { clock: () => NOW, allowEscrows: [ESC.P1, ESC.P2, ESC.agent], ...o })

test('FIXED P1-11: every phase1.mapping vector on the fake chain: problems in order, warnings, enforcement and the readings, as the draft requires', async () => {
  assert.ok(v.mapping.cases.length >= 30)
  for (const [i, c] of v.mapping.cases.entries()) {
    const x = standardWorld()
    const listed = []
    for (const [name, st] of Object.entries(c.chain)) {
      const party = PARTY[name]
      if (st.manifest === 'none') x.st.files.delete(`${party.toLowerCase()}:.well-known/tapeapi.json`)
      else if (st.manifest === 'no-escrow') nameEscrow(x, party, null)
      else {
        nameEscrow(x, party, ESC[name])
        escrowContract(x, ESC[name], st.escrow.token ? TOK[st.escrow.token] : null, { code: st.escrow.code })
        if (st.escrow.listed) listed.push(ESC[name])
      }
      for (const [who, consumer] of [['holder', HOLDER], ['principal', P]]) if (st[who]) channelState(x, consumer, party, st[who])
    }
    const m = fundedMandate({ nonce: String(1000 + i), scope: c.scope.map((s) => ({ provider: PARTY[s.provider], token: TOK[s.token], cap: s.cap })), ...(c.fee ? { feeToken: TOK[c.fee.token], feeCap: c.fee.cap } : {}) })
    const r = await kitOf(x, { allowEscrows: listed }).verifyMandate(signed(m), { ...ON, fundingPath: c.path, at: c.at ?? T.N, ...(c.feeDue ? { feeDue: c.feeDue } : {}) })
    assert.deepEqual(codes(r), c.expect.problems, c.name)
    assert.deepEqual(r.warnings.map((w) => w.code), c.expect.warnings, c.name)
    assert.equal(r.enforcement, c.expect.enforcement, c.name)
    assert.equal(r.ok, c.expect.problems.length === 0, c.name)
    assert.equal(r.consumer, c.path === 'container' ? P : HOLDER, c.name)
    if (c.expect.live) assert.deepEqual(r.scope.map((s) => s.pendingWithdraw?.live ?? null), c.expect.live, c.name)
    if (c.expect.available) assert.deepEqual(r.scope.map((s) => s.available), c.expect.available, c.name)
    if (c.expect.sessionExpiry) assert.deepEqual(r.scope.map((s) => s.sessionExpiry), c.expect.sessionExpiry, c.name)
    if (c.expect.decimals) assert.deepEqual(r.scope.map((s) => s.decimals), c.expect.decimals, c.name)
  }
})

test('FIXED P1-12: the lifetime of a withdraw request (R21): live until requestedAt + 48 h + 7 d inclusive, never by the view alone', () => {
  assert.equal(agent.WITHDRAW_COOLDOWN_S + agent.WITHDRAW_WINDOW_S, T.lifetime)
  for (const [at, now, live] of v.liveness.cases) assert.equal(withdrawRequestLive(at, now), live, `${at} ${now}`)
})

test('FIXED P1-13: every phase-1 escrow read is made at the verification\'s pinned block (EIP-1898 blockHash), strict', async () => {
  const x = world()
  x.st.reads.length = 0
  const r = await kitOf(x).verifyMandate(signed(fundedMandate()), ON)
  assert.equal(r.enforcement, 'escrow-channel')
  const fns = ['channelOf', 'sessionExpiry', 'pendingWithdraw', 'claimedOf', 'token']
  const reads = x.st.reads.filter((q) => fns.includes(q.fn) || (q.method === 'eth_getCode' && true) || (q.method === 'eth_call' && q.fn === null))
  for (const f of fns) assert.ok(reads.some((q) => q.fn === f), f)
  const hashes = new Set(reads.map((q) => JSON.stringify(q.block)))
  assert.equal(hashes.size, 1, [...hashes].join(' '))
  const [only] = [...hashes].map((h) => JSON.parse(h))
  assert.match(only.blockHash, /^0x[0-9a-f]{64}$/); assert.equal(only.requireCanonical, true)
  // both nodes are asked every read (strict agreement) / 每次读取两个节点都问（严格共识）
  for (const f of ['channelOf', 'sessionExpiry']) assert.deepEqual(new Set(x.st.reads.filter((q) => q.fn === f).map((q) => q.url)), new Set(RPC), f)
})

test('FIXED P1-14: a node failure is thrown, never a problem of the mandate: one node lying about channelOf or sessionExpiry, a stale pin, a node on another chain', async () => {
  for (const sig of ['channelOf(address,address)', 'sessionExpiry(address,address,address)', 'pendingWithdraw(address,address)']) {
    const x = world()
    let lied = 0
    x.lie(RPC[1], (method, params, honest) => (method === 'eth_call' && String(params[0].data).startsWith(selector(sig)) ? (lied++, '0x' + '00'.repeat(31) + '07' + (sig.startsWith('pending') ? '00'.repeat(32) : '')) : honest))
    await assert.rejects(kitOf(x).verifyMandate(signed(fundedMandate()), ON), (e) => e.code === 'RPC_DISAGREE' || e.code === 'RPC_UNAVAILABLE', sig)
    assert.ok(lied > 0, `${sig}: the lie was reached`)
    // the same world without the lie passes: the failure was the lie / 去掉谎言即通过：失败来自谎言
    x.lie(RPC[1], null)
    assert.equal((await kitOf(x).verifyMandate(signed(fundedMandate()), ON)).enforcement, 'escrow-channel', sig)
  }
  const z = world()
  z.lie(RPC[1], (method, params, honest) => (method === 'eth_blockNumber' ? '0x' + (z.chain.state.block - 500).toString(16) : honest))
  await assert.rejects(kitOf(z).verifyMandate(signed(fundedMandate()), ON), (e) => e.code === 'RPC_STALE' && e.data?.status === 'stale-block')
  const w = world()
  for (const url of RPC) w.lie(url, (method, params, honest) => (method === 'eth_chainId' ? '0xc4' : honest))
  await assert.rejects(kitOf(w).verifyMandate(signed(fundedMandate()), ON), (e) => e.data?.status === 'wrong-chain')
  // what the counterparty chose is a problem, not an exception: an escrow without token(), a token without decimals()
  // 对方选的东西是问题，不是异常：没有 token() 的托管、没有 decimals() 的代币
  const y = world(); escrowContract(y, ESC.P1, null)
  assert.deepEqual(codes(await kitOf(y).verifyMandate(signed(fundedMandate()), ON)), ['escrow-token-mismatch'])
})

test('FIXED P1-15: one read per escrow fact per verification: a thread read twice (two passes) reads the channel once per node, like one mandate check', async () => {
  const x = world()
  const m = fundedMandate()
  const count = () => x.st.calls.filter((q) => q.name === 'channelOf').length
  let before = count()
  await kitOf(x).verifyMandate(signed(m), ON)
  const single = count() - before
  assert.equal(single, RPC.length)
  // a revocation issued after `at` makes the thread take two passes (draft §7.5) without cancelling it
  // 在 at 之后签发的撤销让线程走两遍，但不取消它
  const t = happyThread({ m })
  before = count()
  const r = await kitOf(x).verifyTaskThread([...t.messages.slice(0, 3), revocationMsg({ mandateHashes: [t.mandateHash], issued: NOW + 500 })], ON)
  assert.equal(r.state, 'Active'); assert.equal(r.revoked.at, NOW + 500)
  assert.equal(r.enforcement, 'escrow-channel')
  assert.equal(count() - before, single)
})

test('FIXED P1-16: chain problems do not keep the nonce unrecorded (the holder fixes the channel with a transaction; the mandate itself was right)', async () => {
  const x = world({ session: 0 })
  const nonces = new Map()
  const kit = kitOf(x, { nonces })
  const m = fundedMandate({ nonce: '55' })
  assert.deepEqual(codes(await kit.verifyMandate(signed(m), ON)), ['session-missing'])
  assert.equal(nonces.size, 1)
  // the holder authorises the session: the same mandate passes; another with this nonce is nonce-reused
  channelState(x, HOLDER, S, { channel: '100', session: S1 })
  assert.equal((await kit.verifyMandate(signed(m), ON)).enforcement, 'escrow-channel')
  assert.ok(codes(await kit.verifyMandate(signed(fundedMandate({ nonce: '55', scope: [{ provider: S, token: BEM_TOKEN, cap: '99' }] })), ON)).includes('nonce-reused'))
})

test('FIXED P1-17: escrow-channel is reported only when every check passed; a phase-0 mandate with the switch reads no channel', async () => {
  const x = world()
  const ok = await kitOf(x).verifyMandate(signed(fundedMandate()), ON)
  assert.equal(ok.ok, true); assert.equal(ok.enforcement, 'escrow-channel'); assert.equal(ok.fundingPath, 'holder')
  assert.deepEqual(ok.scope, [{ provider: ok.mandate.scope[0].provider, escrow: ok.scope[0].escrow, token: BEM_TOKEN, decimals: 8, cap: '100', channel: '100', available: '100', pendingWithdraw: { amount: '0', requestedAt: 0, live: false }, sessionExpiry: S1, claimedAtCheck: '0' }])
  assert.equal(ok.scope[0].escrow.toLowerCase(), ESC.P1)
  // a revoked mandate, an expired one: problems, so no escrow-channel / 被撤销或过期：有问题，不报 escrow-channel
  const late = await kitOf(x).verifyMandate(signed(fundedMandate()), { ...ON, at: S1 + 1 })
  assert.ok(codes(late).includes('mandate-expired')); assert.equal(late.enforcement, 'none')
  const p0 = await kitOf(x).verifyMandate(signed(mandateOf()), ON)
  assert.equal(p0.enforcement, 'none'); assert.equal('scope' in p0, false)
  x.st.calls.length = 0
  await kitOf(x).verifyMandate(signed(mandateOf({ nonce: '2' })), ON)
  assert.equal(x.st.calls.filter((q) => ['channelOf', 'sessionExpiry', 'pendingWithdraw'].includes(q.name)).length, 0)
})

// The nine on-chain scenarios of the design's review (RV), as the chain looks afterwards, and what the verifier says.
// contracts/test/Phase1Mapping.t.sol drives the same scenarios on the real v3 escrow. / 设计审查的 9 个链上场景之后的链状态
test('FIXED P1-18: the RV scenarios as fixtures: drained channels, a session on someone else\'s channel, a full request, a lapsed one, a top-up during a request, the session edge, a reused key, a cancelled request', async () => {
  const check = async (x, o = {}, m = fundedMandate()) => kitOf(x).verifyMandate(signed(m), { ...ON, ...o })
  // 1. a leaked key drained the channel in one transaction: nothing is left to spend
  assert.deepEqual(codes(await check(world({ channel: '0' }))), ['channel-empty'])
  // 2. the attacker authorised the key on ITS OWN channel (attacker, provider): the holder's channel has no session
  { const x = world({ session: 0 }); channelState(x, '0x' + 'ba'.repeat(20), S, { channel: '5', session: S1 }); assert.deepEqual(codes(await check(x)), ['session-missing']) }
  // 3. a full requestWithdraw: honest parties stop (the key itself is not stopped: Phase1Mapping.t.sol)
  assert.deepEqual(codes(await check(world({ pending: ['100', NOW - 47 * 3600] }))), ['withdraw-pending', 'channel-empty'])
  // 4./5. a request lapsed (48 h + 7 d + 1 s ago) under a still-live session: the view still shows it, the channel is
  // spendable again, and the verifier says so (no withdraw-pending)
  { const r = await check(world({ pending: ['100', NOW - T.lifetime - 1] })); assert.deepEqual(codes(r), []); assert.equal(r.scope[0].pendingWithdraw.amount, '100'); assert.equal(r.scope[0].pendingWithdraw.live, false) }
  // 6. a top-up during a live request (R24): the channel is above the cap (a problem since review p1m12 F2) and only part
  // of it is available
  { const r = await check(world({ channel: '150', pending: ['100', NOW - 40 * 3600] })); assert.deepEqual(codes(r), ['withdraw-pending', 'channel-exceeds-cap']); assert.deepEqual(r.warnings, []); assert.equal(r.scope[0].available, '50') }
  // 7. the session edge: at S the session is live; at S + 1 the mandate has expired and the session too
  assert.equal((await check(world(), { at: S1 })).enforcement, 'escrow-channel')
  assert.deepEqual(codes(await check(world(), { at: S1 + 1 })), ['mandate-expired', 'session-missing'])
  // 8. an old key authorised again for a new mandate (N-03): the verifier sees a session equal to the new expiry and
  // cannot tell (N9): the console's session history is the defence (M3), so this passes
  { const exp2 = NOW + 3600; const r = await check(world({ session: exp2 }), {}, fundedMandate({ expires: exp2, nonce: '8' })); assert.equal(r.enforcement, 'escrow-channel') }
  // 9. cancelWithdraw is immediate: the view is (0, 0) and the channel is fully available at once
  { const r = await check(world({ pending: ['0', 0] })); assert.deepEqual(codes(r), []); assert.equal(r.scope[0].pendingWithdraw.live, false) }
})

test('FIXED P1-19: F1 and F2 read different channels: the consumer is the principal or its current holder; a change of holder changes the consumer', async () => {
  const x = world({ consumer: P })
  assert.deepEqual(codes(await kitOf(x).verifyMandate(signed(fundedMandate()), { ...ON, fundingPath: 'container' })), [])
  assert.deepEqual(codes(await kitOf(x).verifyMandate(signed(fundedMandate({ nonce: '3' })), ON)), ['session-missing', 'channel-empty'])
  // the circuit changes hands: the old holder's channel is no longer the mandate's (and its signature no longer verifies)
  const y = world()
  y.chain.setOwner(11, addrOf(KEYS.stranger))
  assert.deepEqual(codes(await kitOf(y).verifyMandate(signed(fundedMandate()), ON)), ['not-signed-by-holder'])
})

// ---- review p1m12 (independent adversarial review of M1-M2) / 审查 p1m12 ----
test('FIXED P1M12-F1a (review B1): a provider that changes payment.escrow is seen by the next verification of the SAME kit once the chain moved on, not after a 60 s cache', async () => {
  const x = world()
  const kit = kitOf(x)
  const r1 = await kit.verifyMandate(signed(fundedMandate()), ON)
  assert.equal(r1.enforcement, 'escrow-channel'); assert.equal(r1.scope[0].escrow.toLowerCase(), ESC.P1)
  // the provider now names E2, which has no code on this chain, and the chain moves on a few blocks
  nameEscrow(x, S, ESC.P2); x.chain.setCode(ESC.P2, false)
  x.chain.state.block += 3
  const r2 = await kit.verifyMandate(signed(fundedMandate({ nonce: '2' })), ON)
  assert.deepEqual(codes(r2), ['escrow-other-chain'])
  assert.equal(r2.enforcement, 'none'); assert.equal(r2.scope[0].escrow.toLowerCase(), ESC.P2)
  // and back to E1, with code: the same kit follows again
  nameEscrow(x, S, ESC.P1); x.chain.state.block += 1
  assert.equal((await kit.verifyMandate(signed(fundedMandate({ nonce: '3' })), ON)).enforcement, 'escrow-channel')
})

test('FIXED P1M12-F1b: the escrow is read from the provider\'s manifest file at the pinned block (strict fileInfo/read at its blockHash), never from the resolution', async () => {
  const x = world()
  // a resolver that answers an older manifest naming another escrow: the verdict must not use it
  const stale = { manifest: { signer: addrOf(KEYS.providerSigner), container: S, payment: { escrow: ESC.P2, unit: 'BEM', decimals: 8 } } }
  x.st.reads.length = 0
  const r = await kitOf(x, { resolve: async () => stale }).verifyMandate(signed(fundedMandate()), ON)
  assert.equal(r.enforcement, 'escrow-channel'); assert.equal(r.scope[0].escrow.toLowerCase(), ESC.P1)
  const pinOf = (fn) => x.st.reads.filter((q) => q.fn === fn).map((q) => JSON.stringify(q.block))
  const pin = pinOf('channelOf')[0]
  assert.match(pin, /blockHash/)
  for (const fn of ['fileInfo', 'read']) {
    assert.ok(pinOf(fn).length >= RPC.length, fn)
    assert.ok(pinOf(fn).every((b) => b === pin), `${fn} is read at the pinned block`)
  }
  // the manifest of the provider at the pinned block, asked of every node (strict) / 每个节点都问
  assert.deepEqual(new Set(x.st.reads.filter((q) => q.fn === 'read').map((q) => q.url)), new Set(RPC))
  // a manifest at the pinned block that names another container, or is no manifest: provider-unresolvable
  const y = world()
  const key = `${S.toLowerCase()}:.well-known/tapeapi.json`
  const m = JSON.parse(new TextDecoder().decode(y.st.files.get(key).bytes))
  y.chain.writeFile(S, '.well-known/tapeapi.json', JSON.stringify({ ...m, container: S2 }))
  assert.deepEqual(codes(await kitOf(y, { resolve: async () => stale }).verifyMandate(signed(fundedMandate()), ON)), ['provider-unresolvable'])
  y.chain.writeFile(S, '.well-known/tapeapi.json', '{"not":"a manifest"}')
  assert.deepEqual(codes(await kitOf(y, { resolve: async () => stale }).verifyMandate(signed(fundedMandate({ nonce: '2' })), ON)), ['provider-unresolvable'])
})

test('FIXED P1M12-F1c: the phase-1 resolution is kept per pinned block (kit clock), so a later block resolves again; the phase-0 paths are unchanged', async () => {
  const x = world()
  let n = 0
  const api = x.api()
  const kit = createAgentKit(api, { clock: () => NOW, allowEscrows: [ESC.P1], resolve: (c) => { n++; return api.resolve(c) } })
  await kit.verifyMandate(signed(fundedMandate()), ON)
  const first = n
  assert.ok(first >= 1)
  await kit.verifyMandate(signed(fundedMandate({ nonce: '2' })), ON)
  assert.equal(n, first, 'same pinned block: one resolution')
  x.chain.state.block += 2
  await kit.verifyMandate(signed(fundedMandate({ nonce: '3' })), ON)
  assert.equal(n, first * 2, 'another pinned block: resolved again')
})

test('FIXED P1M12-F2 (review A12): a channel above its cap fails closed; every phase-1 result says the chain bounds the channel (bound), the cap is the funding target', async () => {
  const big = await kitOf(world({ channel: '100000000000' })).verifyMandate(signed(fundedMandate()), ON)
  assert.deepEqual(codes(big), ['channel-exceeds-cap']); assert.equal(big.ok, false); assert.equal(big.enforcement, 'none')
  assert.deepEqual(big.warnings, []); assert.equal(big.bound, 'channel'); assert.equal(big.scope[0].channel, '100000000000')
  const at = await kitOf(world({ channel: '100' })).verifyMandate(signed(fundedMandate()), ON)
  assert.equal(at.enforcement, 'escrow-channel'); assert.equal(at.bound, 'channel')
  // a chain problem: the nonce is still recorded (the holder withdraws the excess; the mandate itself was right)
  const nonces = new Map()
  await kitOf(world({ channel: '101' }), { nonces }).verifyMandate(signed(fundedMandate({ nonce: '77' })), ON)
  assert.equal(nonces.size, 1)
  // a static problem also carries bound (a phase-1 result); phase 0 does not
  const st = await kitOf(world()).verifyMandate(signed(fundedMandate({ subdelegate: true })), ON)
  assert.equal(st.phase, 1); assert.equal(st.bound, 'channel')
  assert.equal('bound' in await kitOf(world()).verifyMandate(signed(mandateOf()), ON), false)
  // the thread copies it from its applied mandate's check / 线程从已应用的授权书核验里取
  const t = happyThread({ m: fundedMandate() })
  assert.equal((await kitOf(world()).verifyTaskThread(t.messages.slice(0, 3), ON)).bound, 'channel')
})

test('FIXED P1M12-F6a (review A14, mutation M-A): a thread forwards fundingPath and feeDue to its mandate\'s check', async () => {
  // the principal funded (F1): only fundingPath 'container' reads the right channel / 委托方容器出资：只有带上 fundingPath 才读对通道
  const x = world({ consumer: P })
  const t = happyThread({ m: fundedMandate() })
  const f1 = await kitOf(x).verifyTaskThread(t.messages, { ...ON, fundingPath: 'container' })
  assert.deepEqual(codes(f1), []); assert.equal(f1.enforcement, 'escrow-channel'); assert.equal(f1.fundingPath, 'container'); assert.equal(f1.consumer, P)
  const f2 = await kitOf(x).verifyTaskThread(t.messages, ON)
  assert.ok(codes(f2).includes('session-missing') && codes(f2).includes('channel-empty'), codes(f2).join())
  // feeDue: a fee channel of 10 against 11 due is short; against 10 it is not / 费用通道 10，约定 11 则不足
  const y = world()
  nameEscrow(y, AG, ESC.agent); escrowContract(y, ESC.agent, BEM_TOKEN); channelState(y, HOLDER, AG, { channel: '10', session: 0 })
  const tf = happyThread({ m: fundedMandate({ feeToken: BEM_TOKEN, feeCap: '10' }) })
  assert.ok(codes(await kitOf(y).verifyTaskThread(tf.messages, { ...ON, feeDue: '11' })).some((c) => c === 'fee-channel-short'))
  const due = await kitOf(y).verifyTaskThread(tf.messages, { ...ON, feeDue: '10' })
  assert.deepEqual(codes(due), []); assert.equal(due.enforcement, 'escrow-channel'); assert.equal(due.fee.available, '10')
})

test('FIXED P1M12-F6b (review A4, mutation M-D): decimals() above 255 is shown as unknown (null), never thrown, and refuses nothing', async () => {
  for (const [i, d] of [[1, 256n], [2, 1n << 255n], [3, (1n << 256n) - 1n]]) {
    const x = world(); x.chain.setDecimals(BEM_TOKEN, d)
    const r = await kitOf(x).verifyMandate(signed(fundedMandate({ nonce: String(i) })), ON)
    assert.equal(r.scope[0].decimals, null, String(d)); assert.equal(r.enforcement, 'escrow-channel', String(d))
  }
  const z = world(); z.chain.setDecimals(BEM_TOKEN, 255n)
  assert.equal((await kitOf(z).verifyMandate(signed(fundedMandate()), ON)).scope[0].decimals, 255)
})

test('FIXED P1M12-I1 (review B7): a thread\'s top-level enforcement is escrow-channel only when the thread is ok; mandateCheck keeps the mandate\'s own value', async () => {
  const t = happyThread({ m: fundedMandate() })
  const good = await kitOf(world()).verifyTaskThread(t.messages, ON)
  assert.equal(good.ok, true); assert.equal(good.enforcement, 'escrow-channel')
  // the delivery's receipt signature is broken: the thread is not ok, the mandate still is / 交付回执签名坏了：线程不 ok，授权书仍 ok
  const msgs = [...t.messages]; msgs[3] = { ...msgs[3], receipt: { ...msgs[3].receipt, sig: '0x' + '22'.repeat(65) } }
  const bad = await kitOf(world()).verifyTaskThread(msgs, ON)
  assert.equal(bad.ok, false); assert.ok(bad.problems.length > 0)
  assert.equal(bad.enforcement, 'none'); assert.equal(bad.phase, 1)
  assert.equal(bad.mandateCheck.enforcement, 'escrow-channel'); assert.equal(bad.mandateCheck.ok, true)
})
