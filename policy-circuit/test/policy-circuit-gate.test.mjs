// The gatekeeper fails closed in every row of the draft's §7, keeps a trace that replays, never restarts a stateful
// trace from zero without a record, re-reads time and revocations before every decision, and counts escrow vouchers by
// their cumulative delta. / 守门方在 §7 每一行都失败即拒绝；轨迹可重放；有状态轨迹不会无记录地从零重来；每次判定前重查时间与撤销；
// 托管凭单按累计差额计。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signDigest } from '@tapeapi/sdk/sig'
import * as pc from '@tapeapi/policy-circuit'
import { parseLossless } from './policy-circuit-helpers.mjs'

const HERE = new URL('./vectors/', import.meta.url)
const v = parseLossless(readFileSync(new URL('vectors.json', HERE), 'utf8'))
const file = (name) => new Uint8Array(readFileSync(new URL(v.policies[name].file, HERE)))
const TABLES = v.tables.tables
const [K1, K2] = [v.keys['1'], v.keys['2']]
const D0 = 1793008800, DAY = 86400, UNIT = 10n ** 15n
const ASSET = '0x' + 'aa'.repeat(20), P1 = '0x' + '11'.repeat(20)
// a combinational file whose 8 outputs are fixed: 0x01 allows everything, 0x03 is an invalid result
// 输出固定的组合文件：0x01 放行一切，0x03 是无效结果
const fixed = (byte) => {
  const head = [0x54, 0x41, 0x50, 0x4e, 0x45, 0x54, 1, 0, 0, 0, 0, 128, 0, 0, 0, 8]
  const one = [0, 0, 0, 0, 0, 0, 0], zero = [0, 0, 0, 1, 0, 0, 1]   // NAND(0,0) = 1, NAND(1,1) = 0
  return Uint8Array.from([...head, ...Array.from({ length: 8 }, (_, i) => ((byte >> i) & 1 ? one : zero)).flat()])
}
const ALLOW_ALL = fixed(0x01), INVALID = fixed(0x03)
const bind = (over = {}, key = K1, chainId = 56) => {
  const binding = { netlistHash: v.policies['daily-cap'].sha256, ...pc.policySubject.account('0x' + '0c'.repeat(20)), tablesHash: v.tables.tablesHash, notBefore: D0, expires: D0 + 7 * DAY, issued: D0 - 3600, ...over }
  return { binding, sig: signDigest(pc.policyBindingHash(chainId, binding), key.priv) }
}
const clockAt = (t0) => { const c = { t: t0, fn: () => c.t }; return c }
const pay = (units, extra = {}) => ({ amount: (BigInt(units) * UNIT).toString(), asset: ASSET, counterparty: P1, kind: 1, ...extra })
const gateOf = async (over = {}) => {
  const clock = over.clock ?? clockAt(D0 + 60)
  const { binding, sig } = over.bound ?? bind(over.binding ?? {})
  const g = await pc.createPolicyGate({ chainId: 56, binding, sig, tables: TABLES, policyFile: file('daily-cap'), binder: K1.address, clock: clock.fn, ...over.opts })
  return { g, clock, binding, sig }
}

test('§7 file rows: not obtainable, hash differs, invalid or wrong pins: every request denied', async () => {
  const { binding, sig } = bind()
  const make = (o) => pc.createPolicyGate({ chainId: 56, binding, sig, tables: TABLES, binder: K1.address, clock: () => D0 + 60, ...o })
  for (const [o, problem] of [
    [{}, 'policy-file-unavailable'],
    [{ fetchPolicyFile: async () => { throw new Error('gateway down') } }, 'policy-file-unavailable'],
    [{ fetchPolicyFile: async () => null }, 'policy-file-unavailable'],
    [{ policyFile: file('allowlist') }, 'policy-hash-mismatch'],
    [{ policyFile: Uint8Array.from(Buffer.from(v.policyChecks[0].hex, 'hex')) }, 'policy-bad-pins'],
  ]) {
    const g = await make(o)
    assert.equal(g.status().open, false)
    const r = await g.admit(pay(1))
    assert.deepEqual([r.verdict, r.problem], ['deny', problem], JSON.stringify(Object.keys(o)))
    assert.notEqual(g.status().enforceable, true)
  }
  const ok = await make({ fetchPolicyFile: async (h) => (h === v.policies['daily-cap'].sha256 ? file('daily-cap') : null) })
  assert.equal(ok.status().open, true)
})

test('§7 binding rows: not yet, expired (the clock moves on), unsigned, wrong signer, another chain, tables changed, label, no binder', async () => {
  const cases = [
    [{ clock: clockAt(D0 - 1) }, 'binding-not-yet'],
    [{ bound: { ...bind(), sig: null } }, 'binding-unsigned'],
    [{ bound: bind({}, K2) }, 'not-signed-by-binder'],
    [{ bound: bind({}, K1, 97) }, 'not-signed-by-binder'],
    [{ opts: { tables: { ...TABLES, assets: { ...TABLES.assets, [Object.keys(TABLES.assets)[1]]: { ...Object.values(TABLES.assets)[1], unit: '1000' } } } } }, 'tables-hash-mismatch'],
    [{ bound: bind(pc.policySubject.label('limits')) }, 'binding-display-only'],
    [{ opts: { binder: null } }, 'binder-not-checked'],
    [{ bound: bind(pc.policySubject.account(K1.address)) }, 'binding-self-signed'],
  ]
  for (const [over, problem] of cases) {
    const { g } = await gateOf(over)
    const r = await g.admit(pay(1))
    assert.deepEqual([r.verdict, r.problem], ['deny', problem], problem)
  }
  const { g, clock } = await gateOf({ opts: { policyFile: ALLOW_ALL }, binding: { netlistHash: pc.policyNetlistHash(ALLOW_ALL) } })
  assert.equal((await g.admit(pay(1))).verdict, 'allow')
  clock.t = D0 + 7 * DAY + 1
  const late = await g.admit(pay(1))
  assert.deepEqual([late.verdict, late.problem], ['deny', 'binding-expired'], 'time is checked before every decision')
})

test('§4.4: revocations are read again before every decision; a revocation source that fails denies', async () => {
  let revs = []
  const { g, binding } = await gateOf({ opts: { revocations: () => revs } })
  await g.startTrace({ reason: 'first use' })
  assert.equal((await g.admit(pay(1))).verdict, 'allow')
  const revocation = { bindingHashes: [pc.policyBindingHash(56, binding)], revokedBefore: 0, issued: D0 + 120 }
  revs = [{ revocation, sig: signDigest(pc.policyRevocationHash(56, revocation), K2.priv) }]
  assert.equal((await g.admit(pay(1))).verdict, 'allow', 'another signer\'s revocation does not apply')
  revs = [{ revocation, sig: signDigest(pc.policyRevocationHash(56, revocation), K1.priv) }]
  assert.deepEqual([(await g.admit(pay(1))).problem], ['binding-revoked'])
  revs = null
  const { g: g2 } = await gateOf({ opts: { revocations: () => { throw new Error('unreadable') } } })
  assert.equal((await g2.admit(pay(1))).problem, 'revocations-unavailable')
})

test('§2.3: an invalid result (allow bit with a reason) is denied and flagged; only 0x01 allows', async () => {
  const { g } = await gateOf({ opts: { policyFile: INVALID }, binding: { netlistHash: pc.policyNetlistHash(INVALID) } })
  const r = await g.admit(pay(1))
  assert.deepEqual([r.verdict, r.invalidResult, r.reason], ['deny', true, 1])
})

test('§7 trace rows: a stateful policy refuses until a trace is started; a broken or tampered trace is trace-unavailable', async () => {
  const store = pc.memoryPolicyTraceStore()
  const { g } = await gateOf({ opts: { store } })
  assert.equal(g.status().stateful, true)
  const r0 = await g.admit(pay(1))
  assert.deepEqual([r0.verdict, r0.problem], ['deny', 'trace-unavailable'], 'no silent start from zero')
  await assert.rejects(g.startTrace({}), /reason/)
  await g.startTrace({ reason: 'first use of this binding' })
  assert.match(store.read(), /"type":"start".*"reason":"first use of this binding"/)
  for (let i = 0; i < 4; i++) assert.equal((await g.admit(pay(500))).verdict, 'allow')
  const fifth = await g.admit(pay(500))
  assert.deepEqual([fifth.verdict, fifth.reasonName], ['deny', 'period-limit-reached'])
  // tamper: flip a recorded verdict; the replay disagrees, so the trace is unavailable, never trusted
  // 篡改一条记录的结论：重放不一致，轨迹即不可用，绝不信任
  const tampered = pc.memoryPolicyTraceStore()
  tampered.append(store.read().replace('"verdict":"deny"', '"verdict":"allow"'))
  const { g: gt } = await gateOf({ opts: { store: tampered } })
  assert.equal((await gt.admit(pay(1))).problem, 'trace-unavailable')
  assert.match(gt.status().traceProblem, /does not replay/)
  // a broken line after the start / start 之后的坏行
  const broken = pc.memoryPolicyTraceStore()
  broken.append(store.read() + '{"tapeapiPolicyTr\n')
  const { g: gb } = await gateOf({ opts: { store: broken } })
  assert.equal((await gb.admit(pay(1))).problem, 'trace-unavailable')
  // an unreadable store / 读不出的存储
  const { g: gu } = await gateOf({ opts: { store: { read() { throw new Error('EIO') }, append() {} } } })
  assert.equal((await gu.admit(pay(1))).problem, 'trace-unavailable')
  // a restart is explicit and recorded: the limit starts over, and the trace says so / 重开要显式且有记录
  await gt.startTrace({ reason: 'operator restart after a tampered trace' })
  assert.equal((await gt.admit(pay(500))).verdict, 'allow')
  assert.equal((tampered.read().match(/"type":"start"/g) ?? []).length, 2)
})

test('a write that fails is not counted: the state does not move, and the request is denied', async () => {
  let fail = false
  const inner = pc.memoryPolicyTraceStore()
  const store = { read: () => inner.read(), append: (s) => { if (fail) throw new Error('disk full'); inner.append(s) } }
  const { g } = await gateOf({ opts: { store } })
  await g.startTrace({ reason: 'first use' })
  for (let i = 0; i < 3; i++) assert.equal((await g.admit(pay(500))).verdict, 'allow')
  fail = true
  assert.equal((await g.admit(pay(500))).problem, 'trace-unavailable')
  fail = false
  assert.equal((await g.admit(pay(500))).verdict, 'allow', 'the failed request took nothing')
  assert.equal((await g.admit(pay(500))).reasonName, 'period-limit-reached')
})

test('requests: the gatekeeper assigns ts; time going backwards, a malformed or unsafe amount, a wrong field: denied', async () => {
  const { g, clock } = await gateOf({ opts: { policyFile: ALLOW_ALL }, binding: { netlistHash: pc.policyNetlistHash(ALLOW_ALL) } })
  const ok = await g.admit(pay(1))
  assert.deepEqual([ok.verdict, ok.ts], ['allow', D0 + 60])
  assert.equal((await g.admit(pay(1, { ts: 1 }))).verdict, 'allow', 'a requester\'s ts is ignored')
  assert.equal(g.trace()[1].request.ts, D0 + 60)
  clock.t -= 10
  assert.equal((await g.admit(pay(1))).problem, 'trace-not-monotone')
  clock.t += 10
  assert.equal((await g.admit({ ...pay(1), amount: 2 ** 60 })).problem, 'request-malformed', 'an unsafe JS number is refused')
  assert.equal((await g.admit({ ...pay(1), amount: '01' })).problem, 'request-malformed')
  assert.equal((await g.admit({ ...pay(1), asset: ASSET.toUpperCase().replace('0X', '0x') })).problem, 'request-malformed')
  assert.equal((await g.admit({ ...pay(1), cumulative: '5' })).problem, 'request-malformed')
  assert.equal((await g.admit(null)).problem, 'request-malformed')
  assert.equal((await g.admit({ ...pay(1), amount: 10n ** 30n })).verdict, 'allow', 'a bigint amount is taken')
})

test('the trace a gate keeps replays to the same verdicts (replayPolicyTrace), across midnight', async () => {
  const { g, clock, binding } = await gateOf()
  await g.startTrace({ reason: 'first use' })
  const verdicts = []
  for (let i = 0; i < 6; i++) { verdicts.push((await g.admit(pay(500))).verdict); clock.t += 60 }
  clock.t = D0 + DAY + 10
  verdicts.push((await g.admit(pay(500))).verdict)
  assert.deepEqual(verdicts, ['allow', 'allow', 'allow', 'allow', 'deny', 'deny', 'allow'])
  const r = pc.replayPolicyTrace(pc.loadPolicyCircuit(file('daily-cap')), TABLES, g.trace(), { notBefore: binding.notBefore, expires: binding.expires })
  assert.deepEqual(r.results.map((x) => x.verdict), verdicts)
})

test('a file store (mode 600) survives a restart: a new gate rebuilds the state from the trace, and two gates share one file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tapeapi-policy-trace-'))
  try {
    const path = join(dir, 'trace.jsonl')
    const store = () => pc.policyTraceFileStore(path, fs)
    const clock = clockAt(D0 + 60)
    const { g: a } = await gateOf({ clock, opts: { store: store() } })
    await a.startTrace({ reason: 'first use' })
    assert.equal(statSync(path).mode & 0o777, 0o600)
    for (let i = 0; i < 3; i++) assert.equal((await a.admit(pay(500))).verdict, 'allow')
    const { g: b } = await gateOf({ clock, opts: { store: store() } })   // a restart, or a second process / 重启或第二个进程
    assert.equal((await b.admit(pay(500))).verdict, 'allow', 'the fourth of 500 still fits')
    assert.equal((await a.admit(pay(500))).reasonName, 'period-limit-reached', 'gate a reads b\'s line before deciding')
    assert.equal((await b.admit(pay(1))).reasonName, 'period-limit-reached')
    assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 1 + 6)
    // lost file: a stateful trace is not restarted silently / 文件丢失：有状态轨迹不会悄悄重来
    rmSync(path)
    const { g: c } = await gateOf({ clock, opts: { store: store() } })
    assert.equal((await c.admit(pay(1))).problem, 'trace-unavailable')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('§5.4 in the gate: two live bindings of one signer and subject with equal issued are binding-ambiguous; the later issued wins', async () => {
  const a = bind({ netlistHash: pc.policyNetlistHash(ALLOW_ALL) }), b = bind({ expires: D0 + 6 * DAY })
  const files = { [pc.policyNetlistHash(ALLOW_ALL)]: ALLOW_ALL, [v.policies['daily-cap'].sha256]: file('daily-cap') }
  const mk = (bindings) => pc.createPolicyGate({ chainId: 56, bindings, tables: TABLES, fetchPolicyFile: async (h) => files[h] ?? null, binder: K1.address, clock: () => D0 + 60 })
  const tie = await mk([a, b])
  assert.equal((await tie.admit(pay(1))).problem, 'binding-ambiguous')
  const later = bind({ netlistHash: pc.policyNetlistHash(ALLOW_ALL), issued: D0 })
  const g = await mk([b, later])
  assert.equal(g.status().bindingHash, pc.policyBindingHash(56, later.binding))
  assert.equal((await g.admit(pay(100000))).verdict, 'allow')
})

test('kind 2: amounts are cumulative deltas over the last allowed voucher; a decrease is refused; an x402 channel never gates', async () => {
  const s = v.subjects.escrowSession
  const session = { escrow: s.escrow, consumer: s.consumer, provider: s.provider, key: s.key, expires: D0 + 7 * DAY }
  const bound = bind({ ...pc.policySubject.escrowSession(session) })
  const clock = clockAt(D0 + 60)
  const g = await pc.createPolicyGate({ chainId: 56, ...bound, tables: TABLES, policyFile: file('daily-cap'), binder: K1.address, session, clock: clock.fn })
  assert.equal(g.status().enforceable, 'conditional', 'an escrow-session binding is conditional, never true')
  await g.startTrace({ reason: 'first use' })
  const cum = (units) => ({ cumulative: (BigInt(units) * UNIT).toString(), asset: ASSET, counterparty: P1, kind: 1 })
  assert.deepEqual([(await g.admit(cum(400))).verdict, (await g.admit(cum(900))).verdict], ['allow', 'allow'])
  const big = await g.admit(cum(1501))
  assert.deepEqual([big.verdict, big.amount], ['deny', (601n * UNIT).toString()], 'the delta over the last allowed cumulative')
  assert.equal((await g.admit(cum(800))).problem, 'trace-cumulative-decreases')
  assert.equal((await g.admit(cum(1000))).verdict, 'allow', '100 over the last allowed 900')
  assert.equal((await g.admit(pay(1))).problem, 'trace-malformed', 'an escrow gate takes the cumulative, not an amount')
  const replay = pc.replayPolicyTrace(pc.loadPolicyCircuit(file('daily-cap')), TABLES, g.trace(), { escrowCumulative: true })
  assert.deepEqual(replay.results.map((r) => r.verdict), ['allow', 'allow', 'deny', 'allow'])
  await assert.rejects(pc.createPolicyGate({ chainId: 56, ...bound, tables: TABLES, policyFile: file('daily-cap'), binder: K1.address, session: { ...session, enforcement: 'x402-batch' } }), (e) => e.data?.reason === 'policy-subject-x402')
})

test('a gate that throws inside is a denial, not a crash, and a binder reader that fails leaves the gate closed', async () => {
  const { binding, sig } = bind()
  const g = await pc.createPolicyGate({ chainId: 56, binding, sig, tables: TABLES, policyFile: file('daily-cap'), binder: { resolve: async () => { throw new Error('nodes down') } }, clock: () => D0 + 60 })
  assert.deepEqual([g.status().open, (await g.admit(pay(1))).verdict], [false, 'deny'])
  let broke = false
  const open = bind({ netlistHash: pc.policyNetlistHash(ALLOW_ALL) })
  const g2 = await pc.createPolicyGate({ chainId: 56, ...open, tables: TABLES, policyFile: ALLOW_ALL, binder: K1.address, clock: () => { if (broke) throw new Error('clock broke'); return D0 + 60 } })
  assert.equal((await g2.admit(pay(1))).verdict, 'allow')
  broke = true
  const r = await g2.admit(pay(1))
  assert.deepEqual([r.verdict, r.problem], ['deny', 'gate-error'])
})
