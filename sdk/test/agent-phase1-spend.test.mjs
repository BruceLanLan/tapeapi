// Container agents, phase 1, milestone M4 (experimental, internal design notes, phase 1, §3b.2, §6.1
// S5, §10.7): the agent runtime's spend limiter. The vectors phase1.spend and phase1.recheck (expectations written by hand,
// spec/vectors/verify.py runs its own model over them), then the stateful limiter around a real api.payer on the fake
// chain: the ceiling claimedAtCheck + cap holds under concurrency, a restart, a released and re-signed voucher, a
// provider's resync, another escrow and a store that fails. Each FIXED test was checked by removing what implements it.
// 阶段 1 的 M4：代理运行时的花费限额器。先跑手写向量，再在假链上用真的 api.payer 验证有状态的限额器：并发、重启、释放后重签、
// provider 的重新同步、换托管、存储失败时上限都成立。每个 FIXED 用例都做过反向检查。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as agent from '../src/agent-public.js'
import { createSpendLimiter, spendDecision, spendRecheck, spendPin, spendRecord, SPEND_REFUSALS, SPEND_STOPS } from '../src/agent-pay.js'
import { standardWorld, KEYS, addrOf, S, S2, BEM_TOKEN, NOW } from './helpers/agent-chain.mjs'
import * as sig from '../src/sig.js'

const v = JSON.parse(readFileSync(new URL('../../spec/vectors/container-agent.json', import.meta.url), 'utf8')).phase1
const E1 = '0x00000000000000000000000000000000000E5c71', E2 = '0x00000000000000000000000000000000000E5c72'
const HOLDER = addrOf(KEYS.principalHolder)
const AGENT_KEY = KEYS.agentKey, AGENT = addrOf(AGENT_KEY)
const MH = '0x' + 'cd'.repeat(32)

test('FIXED P1M4-01: every phase1.spend vector: allowed with hi, spent and remaining, or the first refusal in order and whether it stops', () => {
  assert.ok(v.spend.length >= 25)
  for (const c of v.spend) {
    const d = spendDecision(c.record, c.request)
    const got = d.ok ? { hi: d.hi, spent: d.spent, remaining: d.remaining } : { refused: d.refused, stop: d.stop }
    assert.deepEqual(got, c.expect, c.name)
    if (!d.ok) assert.ok(SPEND_REFUSALS.includes(d.refused), d.refused)
  }
})

test('FIXED P1M4-02: every phase1.recheck vector: the stops in order, the check\'s problems, hi raised to what was settled', () => {
  assert.ok(v.recheck.length >= 12)
  for (const c of v.recheck) {
    const r = spendRecheck(c.record, { ...c.check, problems: c.check.problems.map((code) => ({ code, message: code })) })
    assert.deepEqual({ ok: r.ok, stop: r.stop, problems: r.problems, hi: r.hi }, c.expect, c.name)
    for (const s of r.stop) assert.ok(SPEND_STOPS.includes(s), s)
  }
})

test('the limiter is exported by @tapeapi/sdk/agent and a record is checked', () => {
  for (const n of ['createSpendLimiter', 'spendDecision', 'spendRecheck', 'spendPin', 'spendRecord', 'SPEND_REFUSALS', 'SPEND_STOPS']) assert.ok(n in agent, n)
  assert.throws(() => spendRecord({ ...v.spendBase.record, providers: [{ ...v.spendBase.record.providers[0], hi: '999' }] }), (e) => e.code === 'INVALID_ARGUMENT')
  assert.throws(() => spendRecord({ ...v.spendBase.record, providers: [{ ...v.spendBase.record.providers[0], cap: '0' }] }), (e) => e.code === 'INVALID_ARGUMENT')
  assert.throws(() => createSpendLimiter({ store: {} }), (e) => e.code === 'INVALID_ARGUMENT')
})

// ---- the stateful limiter on the fake chain: a real api.payer({ consumer, sessionKey }) signs ----
const PRICE = 10n
const svcOf = (provider, escrow) => ({ container: provider, manifest: { payment: { escrow } } })
// a check as verifyMandate(…, { enforcement: 'escrow-channel' }) returns it when everything passed
function checkOf({ claimed = ['1000', '0'], escrows = [E1, E2], consumer = HOLDER, caps = ['100', '50'], available = [null, null], extra = {} } = {}) {
  const mandate = agent.normalizeMandate({ principal: '0x86DDaEF00401E3F10418398D67D7189fc458eA95', agent: '0x' + 'a6'.repeat(20), agentKey: AGENT, mode: 1, taskHash: '0x' + '12'.repeat(32), scope: [{ provider: S, token: BEM_TOKEN, cap: caps[0] }, { provider: S2, token: BEM_TOKEN, cap: caps[1] }], feeToken: '0x' + '00'.repeat(20), feeCap: '0', notBefore: NOW - 60, expires: NOW + 86400, nonce: '1', subdelegate: false })
  return { ok: true, enforcement: 'escrow-channel', phase: 1, mandate, mandateHash: MH, consumer, problems: [], scope: [{ provider: S, escrow: escrows[0], claimedAtCheck: claimed[0], available: available[0] }, { provider: S2, escrow: escrows[1], claimedAtCheck: claimed[1], available: available[1] }], ...extra }
}
function world() {
  const x = standardWorld()
  const api = x.api()
  return { x, api, inner: () => api.payer({ consumer: HOLDER, sessionKey: AGENT_KEY }) }
}
async function started(o = {}) {
  const w = world()
  const store = o.store ?? new Map()
  // an asynchronous store, as a disk or a database is / 异步存储，像磁盘或数据库那样
  const st = { get: async (k) => store.get(k) ?? null, set: async (k, val) => { await null; if (o.failSet?.()) throw new Error('disk full'); store.set(k, val) } }
  const lim = createSpendLimiter({ store: st, clock: () => NOW })
  await lim.accept({ chainId: 56, agentKey: AGENT })
  await lim.start({ chainId: 56, check: checkOf(o) })
  // the per-call ceiling: these tests are about the cumulative cap, so each provider's is its cap unless a test says
  // otherwise (null: the default, 10% of the cap) / 这些测试关注累计上限，单次上限默认取各自的 cap；null 即用默认值
  const caps = o.caps ?? ['100', '50']
  const maxPrice = o.maxPrice !== undefined ? o.maxPrice : { [S]: caps[0], [S2]: caps[1] }
  return { ...w, lim, store, st, payer: lim.payer({ chainId: 56, payer: w.inner(), maxPrice: maxPrice ?? undefined, signed: o.signed }) }
}
const refusedWith = (p, reason) => assert.rejects(p, (e) => { assert.equal(e.code, 'AGENT_SPEND_REFUSED', e.message); assert.equal(e.data?.reason, reason, e.message); return true })

test('FIXED P1M4-03: the payer signs up to claimedAtCheck + cap and no further; a refused voucher is released, never returned', async () => {
  const t = await started({ claimed: ['1000', '0'] })
  const s1 = svcOf(S, E1)
  await t.payer.setCumulative(s1, 1000n)   // the counter resumes from the chain's claimedOf, as a payer does
  for (let i = 0; i < 10; i++) { const l = await t.payer.reserve(s1, PRICE); await l.commit() }
  assert.equal(t.payer.cumulativeOf(s1), 1100n)
  await refusedWith(t.payer.reserve(s1, 1n), 'spend-cap-exceeded')
  assert.equal(t.payer.inflightOf(s1), 0, 'the refused voucher was released')
  const r = await t.lim.record({ chainId: 56, agentKey: AGENT })
  assert.equal(r.providers[0].hi, '1100')
  assert.equal(r.stopped, null, 'the cap refuses a voucher, it does not stop the order')
  // the other provider has its own ceiling (0 + 50)
  const s2 = svcOf(S2, E2)
  const l2 = await t.payer.reserve(s2, 50n)
  assert.equal(l2.remaining, '0')
})

test('FIXED P1M4-04: concurrent reserves: never more than the cap in flight; released ones may be signed again without more exposure', async () => {
  const t = await started({ claimed: ['0', '0'], caps: ['100', '50'] })
  const s1 = svcOf(S, E1)
  const all = await Promise.allSettled(Array.from({ length: 15 }, () => t.payer.reserve(s1, PRICE)))
  const ok = all.filter((x) => x.status === 'fulfilled').map((x) => x.value)
  assert.equal(ok.length, 10)
  assert.ok(all.filter((x) => x.status === 'rejected').every((x) => x.reason.data.reason === 'spend-cap-exceeded'))
  assert.equal(BigInt(Math.max(...ok.map((l) => Number(l.next)))), 100n)
  // release the top one: the payer signs that cumulative again, which the record already counts
  const top = ok.find((l) => l.next === 100n); top.release()
  const again = await t.payer.reserve(s1, PRICE)
  assert.equal(again.next, 100n)
  assert.equal((await t.lim.record({ chainId: 56, agentKey: AGENT })).providers[0].hi, '100')
})

test('FIXED P1M4-05: a restart keeps the ceiling: the same store, a new limiter and payer, the start is not re-based; a lost store never signs', async () => {
  const store = new Map()
  const a = await started({ store, claimed: ['0', '0'] })
  const s1 = svcOf(S, E1)
  for (let i = 0; i < 6; i++) await (await a.payer.reserve(s1, PRICE)).commit()
  // the process restarts: a new limiter on the same store; the payer's own counter is gone (memory) and is
  // resumed from the chain, where the provider settled 60
  const lim = createSpendLimiter({ store: { get: (k) => store.get(k) ?? null, set: (k, val) => { store.set(k, val) } }, clock: () => NOW })
  // the same mandate checked again reads claimedOf 60: start keeps base 0 (never moves up), and accept refuses the key
  const r = await lim.start({ chainId: 56, check: checkOf({ claimed: ['60', '0'] }) })
  assert.equal(r.providers[0].base, '0')
  // a start that reads more settled than was signed raises hi (never base) / 读到的已结算多于签出的：抬高 hi，不动 base
  const r2 = await lim.start({ chainId: 56, check: checkOf({ claimed: ['65', '0'] }) })
  assert.deepEqual([r2.providers[0].base, r2.providers[0].hi], ['0', '65'])
  await refusedWith(lim.accept({ chainId: 56, agentKey: AGENT }), 'spend-key-known')
  const p = lim.payer({ chainId: 56, payer: a.inner() })
  await p.setCumulative(s1, 60n)
  for (let i = 0; i < 4; i++) await (await p.reserve(s1, PRICE)).commit()
  await refusedWith(p.reserve(s1, PRICE), 'spend-cap-exceeded')
  assert.equal(p.cumulativeOf(s1), 100n, 'the ceiling is 0 + cap, whatever the restart')
  // a restart WITHOUT the store: the key has no record, so it never signs, and start does not make one
  const fresh = createSpendLimiter({ clock: () => NOW })
  await refusedWith(fresh.start({ chainId: 56, check: checkOf({ claimed: ['60', '0'] }) }), 'spend-state-lost')
  await refusedWith(fresh.payer({ chainId: 56, payer: a.inner() }).reserve(s1, PRICE), 'spend-state-lost')
})

test('FIXED P1M4-06: a provider\'s proved resync above the ceiling (claimedOf moved by others) cannot lift what this key signs', async () => {
  const t = await started({ claimed: ['0', '0'] })
  const s1 = svcOf(S, E1)
  await (await t.payer.reserve(s1, PRICE)).commit()
  // the chain says 95 was settled on the channel (the holder's own key, say): the payer adopts it, the next voucher
  // would be 105 > 0 + 100
  t.x.chain.setClaimed(HOLDER, S, 95)
  await t.payer.resync({ ...s1, manifest: { payment: { escrow: E1 } } }, '95', {})
  assert.equal(t.payer.cumulativeOf(s1), 95n)
  await (await t.payer.reserve(s1, 5n)).commit()
  await refusedWith(t.payer.reserve(s1, PRICE), 'spend-cap-exceeded')
  // a bare lastCumulative without proof is refused by the payer itself (unchanged SDK behaviour)
  t.x.chain.setClaimed(HOLDER, S, 0)
  await assert.rejects(t.payer.resync(s1, '1000000', {}), (e) => e.code === 'BAD_VOUCHER')
})

test('FIXED P1M4-07: another escrow in the provider\'s manifest stops the order for good (R23); another consumer, chain or a stopped record too', async () => {
  const t = await started({ claimed: ['0', '0'] })
  await (await t.payer.reserve(svcOf(S, E1), PRICE)).commit()
  await refusedWith(t.payer.reserve(svcOf(S, E2), PRICE), 'spend-escrow-changed')
  const r = await t.lim.record({ chainId: 56, agentKey: AGENT })
  assert.deepEqual(r.stopped.reasons, ['spend-escrow-changed'])
  // stopped: nothing more on any provider, on the old escrow either
  await refusedWith(t.payer.reserve(svcOf(S, E1), PRICE), 'spend-stopped')
  await refusedWith(t.payer.reserve(svcOf(S2, E2), PRICE), 'spend-stopped')
  // a payer of another chain or consumer is refused before signing
  const u = await started({ claimed: ['0', '0'] })
  const other = u.lim.payer({ chainId: 56, payer: u.api.payer({ consumer: addrOf(KEYS.stranger), sessionKey: AGENT_KEY }) })
  await refusedWith(other.reserve(svcOf(S, E1), PRICE), 'spend-consumer-changed')
  const v2 = await started({ claimed: ['0', '0'] })
  const out = v2.lim.payer({ chainId: 56, payer: v2.inner() })
  await refusedWith(out.reserve(svcOf('0x' + '5d'.repeat(20), E1), PRICE), 'spend-out-of-scope')
})

test('FIXED P1M4-08: a voucher that is not the one counted (another escrow\'s domain, another signer) is refused, released, and stops the order', async () => {
  const t = await started({ claimed: ['0', '0'] })
  const s1 = svcOf(S, E1)
  // an inner payer that signs for the right fields under another escrow's domain (what a manifest swapped under the call would do)
  const real = t.inner()
  let released = 0
  const liar = {
    consumer: real.consumer, signer: real.signer, cumulativeOf: () => 0n, inflightOf: () => 0,
    async reserve(svc, price) {
      const vch = { consumer: HOLDER, provider: svc.container, cumulative: BigInt(price), expires: NOW + 3600 }
      return { next: BigInt(price), amount: BigInt(price), voucher: { ...vch, cumulative: vch.cumulative.toString(), sig: sig.signDigest(sig.voucherDigest(56, E2, vch), AGENT_KEY), signer: AGENT }, commit: async () => {}, release: () => { released++ } }
    },
  }
  await refusedWith(t.lim.payer({ chainId: 56, payer: liar }).reserve(s1, PRICE), 'spend-voucher-mismatch')
  assert.equal(released, 1)
  assert.deepEqual((await t.lim.record({ chainId: 56, agentKey: AGENT })).stopped.reasons, ['spend-voucher-mismatch'])
})

test('FIXED P1M4-09: write-ahead: when the record cannot be written the voucher is released and refused, never returned', async () => {
  let fail = false
  const t = await started({ claimed: ['0', '0'], failSet: () => fail })
  const s1 = svcOf(S, E1)
  fail = true
  await assert.rejects(t.payer.reserve(s1, PRICE), /disk full/)
  assert.equal(t.payer.inflightOf(s1), 0)
  fail = false
  assert.equal((await t.lim.record({ chainId: 56, agentKey: AGENT })).providers[0].hi, '0')
})

test('FIXED P1M4-10: recheck: a live request refuses the step, another escrow stops the order, claimedOf raises hi; the start is never re-based', async () => {
  const t = await started({ claimed: ['0', '0'] })
  const pending = await t.lim.recheck({ chainId: 56, check: checkOf({ claimed: ['0', '0'], extra: { ok: false, problems: [{ code: 'withdraw-pending' }] } }) })
  assert.deepEqual([pending.ok, pending.stop, pending.problems, pending.stopped], [false, [], ['withdraw-pending'], null])
  const raised = await t.lim.recheck({ chainId: 56, check: checkOf({ claimed: ['70', '0'] }) })
  assert.equal(raised.ok, true)
  const r = await t.lim.record({ chainId: 56, agentKey: AGENT })
  assert.deepEqual([r.providers[0].base, r.providers[0].hi], ['0', '70'])
  // with 70 settled, a voucher can pay only above 70: the payer resumes there and 30 is left (a voucher below 70 pays
  // nothing and counts nothing)
  const s1 = svcOf(S, E1)
  await t.payer.setCumulative(s1, 70n)
  await refusedWith(t.payer.reserve(s1, 31n), 'spend-cap-exceeded')
  assert.equal((await t.payer.reserve(s1, 30n)).remaining, '0')
  const moved = await t.lim.recheck({ chainId: 56, check: checkOf({ escrows: [E2, E2] }) })
  assert.deepEqual(moved.stop, ['spend-escrow-changed'])
  await refusedWith(t.payer.reserve(s1, PRICE), 'spend-stopped')
})

test('FIXED P1M4-11: one key, one mandate: a start for another mandate is refused; only an ok escrow-channel check starts', async () => {
  const t = await started({ claimed: ['0', '0'] })
  await refusedWith(t.lim.start({ chainId: 56, check: { ...checkOf(), mandateHash: '0x' + 'ef'.repeat(32) } }), 'spend-key-reused')
  await refusedWith(t.lim.start({ chainId: 56, check: { ...checkOf(), ok: false, problems: [{ code: 'session-missing' }] } }), 'spend-not-enforced')
  await refusedWith(t.lim.start({ chainId: 56, check: { ...checkOf(), enforcement: 'none' } }), 'spend-not-enforced')
  assert.throws(() => spendPin(checkOf(), { chainId: 56, agentKey: addrOf(KEYS.stranger) }), (e) => e.data?.reason === 'spend-key-mismatch')
})

test('FIXED P1M4-12: maxPrice bounds one call; the voucher carries the unsigned mandateHash, and the signed mandate on the first one to a provider', async () => {
  const signed = { mandate: { any: 'thing' }, sig: '0x' + '11'.repeat(65) }
  const t = await started({ claimed: ['0', '0'], maxPrice: '20', signed })
  const s1 = svcOf(S, E1)
  await refusedWith(t.payer.reserve(s1, 21n), 'spend-call-price-above-ceiling')
  const first = await t.payer.reserve(s1, PRICE)
  assert.equal(first.voucher.mandateHash, MH)
  assert.deepEqual(first.voucher.mandate, signed)
  await first.commit()
  const second = await t.payer.reserve(s1, PRICE)
  assert.equal(second.voucher.mandateHash, MH)
  assert.equal('mandate' in second.voucher, false)
  // the signed part is untouched: the voucher still recovers to the agent key on E1
  const vv = second.voucher
  assert.equal(sig.recoverAddress(sig.voucherDigest(56, E1, { consumer: vv.consumer, provider: vv.provider, cumulative: BigInt(vv.cumulative), expires: vv.expires }), vv.sig), AGENT)
})

test('the mandate window: before notBefore nothing is signed; after expires the order stops', async () => {
  const store = new Map()
  let now = NOW - 120
  const lim = createSpendLimiter({ store: { get: (k) => store.get(k) ?? null, set: (k, val) => { store.set(k, val) } }, clock: () => now })
  const w = world()
  await lim.accept({ chainId: 56, agentKey: AGENT })
  await lim.start({ chainId: 56, check: checkOf({ claimed: ['0', '0'] }) })
  const p = lim.payer({ chainId: 56, payer: w.inner() })
  await refusedWith(p.reserve(svcOf(S, E1), PRICE), 'spend-not-yet')
  now = NOW + 86401
  await refusedWith(p.reserve(svcOf(S, E1), PRICE), 'spend-expired')
  assert.deepEqual((await lim.record({ chainId: 56, agentKey: AGENT })).stopped.reasons, ['spend-expired'])
})

test('FIXED P1M4-13: contracts/test/Phase1SpendFixture.sol is what the SDK does (plan, the limiter\'s vouchers up to the cap, close-out): forge executes it on v3', async () => {
  const { phase1SpendFixture, SPEND_FIXTURE_PATH } = await import('../../scripts/gen-phase1-spend-fixture.mjs')
  const want = await phase1SpendFixture()
  assert.equal(readFileSync(SPEND_FIXTURE_PATH, 'utf8'), want, 'run node scripts/gen-phase1-spend-fixture.mjs, then forge test --match-contract Phase1SpendTest')
  assert.match(want, /SIGNED = 5;/)
  assert.match(want, /BASE_B = 20000;/)
  assert.match(want, /SIGNED_B = 5;/)
  assert.match(want, /v\[4\] = Voucher\(70000,/)
  assert.match(want, /refused the next voucher \(spend-cap-exceeded\)/)
})

// ---- review p1m4 ----
// a store shared by two limiters (two processes on one database). `cas` honours set(k, v, { ifSeq }); `gate` holds the
// n-th get or the n-th set of one limiter until the test opens it, so a write of the other lands in between, every time
// 两个限额器共用的存储（两个进程共用一个数据库）；gate 把某个限额器的第 n 次读或写挂起，让另一个的写入恰好落在中间
function shared({ cas = true } = {}) {
  const map = new Map()
  const seqOf = (s) => (s == null ? null : (JSON.parse(s).seq ?? 0))
  function view() {
    const holds = { get: new Map(), set: new Map() }, count = { get: 0, set: 0 }
    // only the record's own key is counted (not its stop key) / 只数记录本身的键
    const wait = async (op, k) => { if (k.endsWith(':stopped')) return; count[op]++; const h = holds[op].get(count[op]); if (h) { h.reached(); await h.open } }
    return {
      store: {
        get: async (k) => { await wait('get', k); return map.get(k) ?? null },
        set: async (k, v, o) => { await wait('set', k); if (cas && o && 'ifSeq' in o && seqOf(map.get(k)) !== o.ifSeq) return false; map.set(k, v); return true },
      },
      // hold the next n-th call of op (counted from now): { reached: a promise, open() } / 挂起从现在算起第 n 次调用
      hold(op, n) { let open, reached; const h = { open: new Promise((r) => { open = r }), reached: null }; h.reachedP = new Promise((r) => { reached = r }); h.reached = reached; holds[op].set(count[op] + n, h); return { reached: h.reachedP, open } },
    }
  }
  const key = () => [...map.keys()].find((k) => !k.endsWith(':stopped'))
  return { map, view, stored: () => JSON.parse(map.get(key())), stopKey: () => map.get(key() + ':stopped') ?? null }
}
async function twoLimiters(o) {
  const sh = shared(o)
  const va = sh.view(), vb = sh.view()
  const A = createSpendLimiter({ store: va.store, clock: () => NOW }), B = createSpendLimiter({ store: vb.store, clock: () => NOW })
  await A.accept({ chainId: 56, agentKey: AGENT })
  await A.start({ chainId: 56, check: checkOf({ claimed: ['0', '0'] }) })
  const w = world()
  return { sh, va, vb, A, B, w, pa: A.payer({ chainId: 56, payer: w.inner() }), pb: B.payer({ chainId: 56, payer: w.inner() }) }
}

test('FIXED P1M4R-1: two limiters on one store: a stop written by one is never overwritten by the other\'s write-ahead save (the re-read)', async () => {
  // probe2 of the review: A loaded the record (not stopped) and signed; B stops the order before A writes
  const t = await twoLimiters({ cas: false })
  const s1 = svcOf(S, E1)
  const h = t.va.hold('get', 2)                 // A's second read: the re-read before its write / A 写入前的重读
  const pA = t.pa.reserve(s1, PRICE)
  await h.reached
  await t.B.stop({ chainId: 56, agentKey: AGENT, reason: 'spend-escrow-changed' })
  h.open()
  await refusedWith(pA, 'spend-stopped')
  assert.equal(t.pa.inflightOf(s1), 0, 'A released the voucher it had signed')
  assert.deepEqual(t.sh.stored().stopped.reasons, ['spend-escrow-changed'], 'the stop is still on the store')
  assert.equal(t.sh.stored().providers[0].hi, '0', 'nothing A signed is on record: it never left')
  await refusedWith(t.pb.reserve(s1, PRICE), 'spend-stopped')
  await refusedWith(t.pa.reserve(s1, PRICE), 'spend-stopped')
})

test('FIXED P1M4R-2: with a compare-and-set store the window between the re-read and the write is closed too', async () => {
  const t = await twoLimiters({ cas: true })
  const s1 = svcOf(S, E1)
  const h = t.va.hold('set', 1)                 // A's write, after its re-read saw the record unchanged / A 重读之后的写入
  const pA = t.pa.reserve(s1, PRICE)
  await h.reached
  await t.B.stop({ chainId: 56, agentKey: AGENT, reason: 'spend-revoked' })
  h.open()
  await refusedWith(pA, 'spend-stopped')
  assert.equal(t.pa.inflightOf(s1), 0)
  assert.deepEqual(t.sh.stored().stopped.reasons, ['spend-revoked'])
  await refusedWith(t.pb.reserve(s1, PRICE), 'spend-stopped')
  // not only a stop: B records 30 while A's write of 10 is in flight; the store refuses A's stale write, A decides again
  // and keeps B's 30 (a store without ifSeq would leave 10: the single-writer premise) / 存储拒绝 A 的过期写入，A 重判并保留 30
  const u = await twoLimiters({ cas: true })
  await u.pb.setCumulative(s1, 20n)
  const g = u.va.hold('set', 1)
  const pA2 = u.pa.reserve(s1, PRICE)
  await g.reached
  await (await u.pb.reserve(s1, PRICE)).commit()
  g.open()
  assert.equal((await pA2).next, 10n)
  assert.equal(u.sh.stored().providers[0].hi, '30')
  assert.equal(u.sh.stored().seq, 3, 'accept 0, start 1, B 2, A written again on top: 3 (A\'s voucher is on record)')
})

test('FIXED P1M4R-3: probe2 as it was: a store without compare-and-set, the stop lands while A\'s write-ahead save is in flight', async () => {
  // A's write overwrites the record's own stopped field, but the stop is on its own key, which no record write touches:
  // the record still reads stopped, A's voucher does not leave, and B refuses / A 的写入覆盖了记录里的 stopped，但停工在自己的键上
  const t = await twoLimiters({ cas: false })
  const s1 = svcOf(S, E1)
  const h = t.va.hold('set', 1)
  const pA = t.pa.reserve(s1, PRICE)
  await h.reached
  await t.B.stop({ chainId: 56, agentKey: AGENT, reason: 'spend-revoked' })
  h.open()
  await refusedWith(pA, 'spend-stopped')
  assert.equal(t.pa.inflightOf(s1), 0)
  assert.equal(t.sh.stored().stopped, null, 'A\'s write did land over the record (no compare-and-set) ...')
  assert.deepEqual(JSON.parse(t.sh.stopKey()).reasons, ['spend-revoked'], '... and the stop key holds the stop')
  assert.deepEqual((await t.A.record({ chainId: 56, agentKey: AGENT })).stopped.reasons, ['spend-revoked'])
  await refusedWith(t.pb.reserve(s1, PRICE), 'spend-stopped')
  await refusedWith(t.pa.reserve(s1, PRICE), 'spend-stopped')
  // and the next write of any limiter puts the stop back on the record / 之后任何写入都会把停工写回记录
  await t.A.recheck({ chainId: 56, check: checkOf({ claimed: ['20', '0'] }) })
  assert.deepEqual([t.sh.stored().stopped.reasons, t.sh.stored().providers[0].hi], [['spend-revoked'], '20'])
})

test('FIXED P1M4R-4: a recheck and a reserve that lose the race decide again on the fresh record: the other\'s stop and hi are kept', async () => {
  const t = await twoLimiters({ cas: true })
  const s1 = svcOf(S, E1)
  // A's recheck (raising hi to 40) re-reads after B's stop: the stop stays, hi is raised on top of it
  let h = t.va.hold('get', 2)
  const pR = t.A.recheck({ chainId: 56, check: checkOf({ claimed: ['40', '0'] }) })
  await h.reached
  await t.B.stop({ chainId: 56, agentKey: AGENT, reason: 'spend-escrow-changed' })
  h.open()
  const r = await pR
  assert.deepEqual(r.stopped.reasons, ['spend-escrow-changed'])
  assert.deepEqual([t.sh.stored().stopped.reasons, t.sh.stored().providers[0].hi], [['spend-escrow-changed'], '40'])
  // another pair: B signs and records 30 while A's voucher of 10 waits; A decides again and keeps B's hi
  const u = await twoLimiters({ cas: true })
  await u.pb.setCumulative(s1, 20n)
  h = u.va.hold('get', 2)
  const pA = u.pa.reserve(s1, PRICE)
  await h.reached
  await (await u.pb.reserve(s1, PRICE)).commit()
  h.open()
  const lease = await pA
  assert.equal(lease.next, 10n)
  assert.equal(u.sh.stored().providers[0].hi, '30', 'hi is the larger of both: B\'s 30 is not lost')
  assert.equal(u.sh.stored().stopped, null)
})

test('FIXED P1M4R-5: start of the same mandate again: a stopped order stays stopped; a check of another escrow or consumer stops it', async () => {
  // probe1 (2) of the review
  const t = await started({ claimed: ['0', '0'] })
  await t.lim.stop({ chainId: 56, agentKey: AGENT, reason: 'spend-escrow-changed' })
  await t.lim.stop({ chainId: 56, agentKey: AGENT, reason: 'spend-revoked' })   // a later stop never replaces the first
  await refusedWith(t.lim.start({ chainId: 56, check: checkOf({ escrows: [E2, E2], consumer: addrOf(KEYS.stranger) }) }), 'spend-stopped')
  const r0 = await t.lim.record({ chainId: 56, agentKey: AGENT })
  assert.deepEqual([r0.stopped.reasons, r0.providers[0].escrow.toLowerCase(), r0.consumer], [['spend-escrow-changed'], E1.toLowerCase(), HOLDER])
  const u = await started({ claimed: ['0', '0'] })
  await refusedWith(u.lim.start({ chainId: 56, check: checkOf({ escrows: [E2, E2] }) }), 'spend-escrow-changed')
  assert.deepEqual((await u.lim.record({ chainId: 56, agentKey: AGENT })).stopped.reasons, ['spend-escrow-changed'])
  await refusedWith(u.payer.reserve(svcOf(S, E1), PRICE), 'spend-stopped')
  const v2 = await started({ claimed: ['0', '0'] })
  await refusedWith(v2.lim.start({ chainId: 56, check: checkOf({ consumer: addrOf(KEYS.stranger), claimed: ['90', '0'] }) }), 'spend-consumer-changed')
  const r2 = await v2.lim.record({ chainId: 56, agentKey: AGENT })
  assert.deepEqual([r2.stopped.reasons, r2.providers[0].hi], [['spend-consumer-changed'], '0'], 'another consumer\'s claimedOf raises nothing')
  // a recheck with a phase-0 result (no readings) refuses the step and stops nothing (probe1 (3))
  const w = await started({ claimed: ['0', '0'] })
  const p0 = await w.lim.recheck({ chainId: 56, check: { ok: true, enforcement: 'none', phase: 0, mandate: checkOf().mandate, mandateHash: MH, problems: [] } })
  assert.deepEqual([p0.ok, p0.problems, p0.stop, p0.stopped], [false, ['spend-not-enforced'], [], null])
})

test('FIXED P1M4R-6: the signed mandate rides on every voucher to a provider until one is accepted (committed) through this payer', async () => {
  const signed = { mandate: { any: 'thing' }, sig: '0x' + '11'.repeat(65) }
  const store = new Map()
  const t = await started({ claimed: ['0', '0'], signed, store })
  const s1 = svcOf(S, E1)
  const a = await t.payer.reserve(s1, PRICE)
  assert.deepEqual(a.voucher.mandate, signed)
  a.release()                                   // the call failed in transit / 传输失败
  const b = await t.payer.reserve(s1, PRICE)
  assert.deepEqual(b.voucher.mandate, signed, 'a released voucher introduced nothing')
  await b.commit()
  const c = await t.payer.reserve(s1, PRICE)
  assert.equal('mandate' in c.voucher, false)
  await c.commit()
  assert.deepEqual((await t.payer.reserve(svcOf(S2, E2), PRICE)).voucher.mandate, signed, 'each provider is introduced on its own')
  // a restart that raised hi (claimedOf read above it): the new payer introduces the mandate again
  const lim = createSpendLimiter({ store: { get: (k) => store.get(k) ?? null, set: (k, val) => { store.set(k, val) } }, clock: () => NOW })
  const r = await lim.start({ chainId: 56, check: checkOf({ claimed: ['20', '0'] }) })
  assert.equal(r.providers[0].hi, '20')
  const p = lim.payer({ chainId: 56, payer: t.inner(), signed })
  await p.setCumulative(s1, 20n)
  assert.deepEqual((await p.reserve(s1, PRICE)).voucher.mandate, signed)
})

test('FIXED P1M4R-7: a channel the last recheck read short of the price signs nothing (spend-channel-short) and stops nothing', async () => {
  const t = await started({ claimed: ['0', '0'] })
  const s1 = svcOf(S, E1)
  await t.lim.recheck({ chainId: 56, check: checkOf({ claimed: ['0', '0'], available: ['5', '50'] }) })
  await refusedWith(t.payer.reserve(s1, PRICE), 'spend-channel-short')
  assert.equal(t.payer.inflightOf(s1) ?? 0, 0)
  assert.equal((await t.lim.record({ chainId: 56, agentKey: AGENT })).stopped, null)
  await (await t.payer.reserve(svcOf(S2, E2), PRICE)).commit()     // the other channel has enough / 另一条通道够
  await t.lim.recheck({ chainId: 56, check: checkOf({ claimed: ['0', '0'], available: ['10', '40'] }) })
  assert.equal((await t.payer.reserve(s1, PRICE)).next, 10n)
})

test('FIXED P2 (payment-voucher draft review): the limited payer passes extra on, so draft reserves wait instead of stacking, and resync keeps { strictV }', async () => {
  const t = await started({ claimed: ['0', '0'] })
  const s1 = svcOf(S, E1)
  const a = await t.payer.reserve(s1, PRICE, { rate: '0.0004', strictV: true })
  assert.equal(a.voucher.rate, '0.0004', 'the rate reached the inner payer')
  let bDone = false
  const b = t.payer.reserve(s1, PRICE, { rate: '0.0004', strictV: true }).then((l) => { bDone = true; return l })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(bDone, false, 'the second draft reserve waits for the first')
  await a.commit()
  assert.equal((await b).next, 2n * PRICE)
  // a proof voucher with v written as 0/1: evidence for the 1.8.1 resync, not under { strictV: true }
  // v 写成 0/1 的证明凭证：1.8.1 的重同步认它，{ strictV: true } 不认
  const v = { consumer: HOLDER, provider: S, cumulative: 500n, expires: NOW + 3600 }
  const s = sig.signDigest(sig.voucherDigest(56, E1, v), AGENT_KEY)
  const v01 = s.slice(0, 130) + (parseInt(s.slice(130), 16) - 27).toString(16).padStart(2, '0')
  const t2 = await started({ claimed: ['0', '0'] })
  await assert.rejects(t2.payer.resync(s1, '500', { voucher: { cumulative: '500', expires: v.expires, sig: v01 } }, { strictV: true }), (e) => e.code === 'BAD_VOUCHER')
  assert.equal(await t2.payer.resync(s1, '500', { voucher: { cumulative: '500', expires: v.expires, sig: v01 } }), 500n)
})

// ---- the per-call price ceiling's default (Bruce, 2026-10-08): 10% of the (mandate, provider) cap, rounded down; 0 is
// no default; an explicit maxCallPrice may be above 10%, never above the cap; a price above it refuses the step only ----
// 单次调用价格上限的默认值：cap 的 10%，向下取整；为 0 即没有默认值；显式值可高于 10%、不得高于 cap；超过只拒绝这一步
test('FIXED P1CP-01: without maxPrice the payer\'s per-call ceiling is 10% of each provider\'s cap; above it nothing is signed, nothing stops, and the message says how to set it', async () => {
  const t = await started({ claimed: ['1000', '0'], maxPrice: null })
  const s1 = svcOf(S, E1), s2 = svcOf(S2, E2)
  assert.equal(agent.SPEND_DEFAULT_CALL_PRICE_PERCENT, 10)
  // S: cap 100, default ceiling 10 / S：cap 100，默认上限 10
  await assert.rejects(t.payer.reserve(s1, 11n), (e) => e.data?.reason === 'spend-call-price-above-ceiling' && /maxCallPrice/.test(e.message) && /10% of the cap 100/.test(e.message))
  const a = await t.payer.reserve(s1, 10n)
  assert.equal(a.voucher.cumulative, '10')
  await a.commit()
  // S2: cap 50, default ceiling 5 / S2：cap 50，默认上限 5
  await refusedWith(t.payer.reserve(s2, 6n), 'spend-call-price-above-ceiling')
  const b = await t.payer.reserve(s2, 5n)
  await b.commit()
  const r = await t.lim.record({ chainId: 56, agentKey: AGENT })
  assert.equal(r.stopped, null, 'a price above the ceiling refuses the step and stops nothing')
  assert.equal(t.payer.cumulativeOf(s1), 10n, 'the refused call was never signed or counted')
})

test('FIXED P1CP-02: an explicit maxCallPrice, one for all or one per provider, may be above 10% of the cap but never above it', async () => {
  // one per provider: S may take 60 a call (above its 10%), S2 has none given and keeps the default 5
  // 按 provider 给：S 每次可到 60（高于 10%），S2 没给，仍是默认的 5
  const t = await started({ claimed: ['1000', '0'], maxPrice: { [S.toLowerCase()]: '60' } })
  const s1 = svcOf(S, E1), s2 = svcOf(S2, E2)
  const a = await t.payer.reserve(s1, 60n)
  await a.commit()
  await refusedWith(t.payer.reserve(s1, 61n), 'spend-call-price-above-ceiling')
  await refusedWith(t.payer.reserve(s2, 6n), 'spend-call-price-above-ceiling')
  // one for all, above S2's cap 50: S2 refuses every call (the ceiling must be at most the cap), S signs
  // 给一个数，高于 S2 的 cap 50：S2 每次都拒绝（上限不得高于 cap），S 照签
  const u = await started({ claimed: ['1000', '0'], maxPrice: '60' })
  await refusedWith(u.payer.reserve(s2, 1n), 'spend-call-price-ceiling-above-cap')
  const c = await u.payer.reserve(s1, 60n)
  await c.commit()
  assert.equal((await u.lim.record({ chainId: 56, agentKey: AGENT })).stopped, null)
  // a malformed ceiling is an argument error at once / 格式错的上限立即是参数错误
  assert.throws(() => u.lim.payer({ chainId: 56, payer: u.inner(), maxPrice: { [S]: '-1' } }), (e) => e.code === 'INVALID_ARGUMENT')
  assert.throws(() => u.lim.payer({ chainId: 56, payer: u.inner(), maxPrice: { nope: '1' } }), (e) => e.code === 'INVALID_ARGUMENT')
})

test('FIXED P1CP-03: a cap whose 10% rounds down to 0 has no default: every call is refused until maxCallPrice is set', async () => {
  const t = await started({ claimed: ['0', '0'], caps: ['9', '50'], maxPrice: null })
  const s1 = svcOf(S, E1)
  await assert.rejects(t.payer.reserve(s1, 1n), (e) => e.data?.reason === 'spend-call-price-ceiling-unset' && /rounds down to 0/.test(e.message) && /set maxCallPrice/.test(e.message))
  const set = t.lim.payer({ chainId: 56, payer: t.inner(), maxPrice: { [S]: '9' } })
  const a = await set.reserve(s1, 9n)
  assert.equal(a.voucher.cumulative, '9')
  await a.commit()
  await refusedWith(set.reserve(s1, 1n), 'spend-cap-exceeded')
})

test('FIXED P1RR-06: an explicit maxPrice of 0 (any form), an array or a non-plain object is an argument error, never a payer that signs nothing', async () => {
  const u = await started({ claimed: ['1000', '0'], maxPrice: '60' })
  class Table { constructor() { this[S] = '10' } }
  for (const mp of [0, '0', 0n, [], [S, '10'], new Map([[S, '10']]), new Table(), { [S]: '0' }, { [S]: 0n }]) {
    assert.throws(() => u.lim.payer({ chainId: 56, payer: u.inner(), maxPrice: mp }), (e) => e.code === 'INVALID_ARGUMENT', String(mp?.constructor?.name ?? mp))
  }
  assert.throws(() => u.lim.payer({ chainId: 56, payer: u.inner(), maxPrice: '0' }), /above 0/)
  // what stays allowed: one amount above 0, a plain object (an empty one: the default for every provider), none
  // 仍然允许的：大于 0 的一个数、普通对象（空对象即每个 provider 用默认值）、不给
  for (const mp of [1, '1', 1n, {}, Object.assign(Object.create(null), { [S]: '10' }), undefined, null]) u.lim.payer({ chainId: 56, payer: u.inner(), maxPrice: mp })
})

test('FIXED L1 (payment-voucher draft, final re-check): a draft reserve that waits for the channel does not hold the limiter: another provider reserves and stop() lands at once, and the waiting voucher of the stopped order never leaves', async () => {
  const t = await started({ claimed: ['0', '0'] })
  const s1 = svcOf(S, E1), s2 = svcOf(S2, E2)
  const state = (p) => { let st = 'pending'; p.then(() => { st = 'resolved' }, () => { st = 'rejected' }); return () => st }
  const tick = (ms) => new Promise((r) => setTimeout(r, ms))
  const a = await t.payer.reserve(s1, PRICE, { rate: '0.0004', strictV: true })   // a draft voucher in flight on S
  const b = t.payer.reserve(s1, PRICE, { rate: '0.0004', strictV: true, waitMs: 5000 }); const bS = state(b)
  await tick(30); assert.equal(bS(), 'pending', 'b waits for a')
  const other = t.payer.reserve(s2, PRICE); const oS = state(other)
  const stop = t.lim.stop({ chainId: 56, agentKey: AGENT, reason: 'spend-stopped' }); const sS = state(stop)
  await tick(50)
  // the other reserve is decided at once (signed, or refused because the stop came first), never held
  // 对另一个 provider 的预留立即有结果（签出，或因停工在先而被拒），绝不被挡住
  assert.notEqual(oS(), 'pending', 'a reserve to another provider is not held behind the wait')
  assert.equal(sS(), 'resolved', 'stop() lands at once')
  await other.then((l) => l.release(), () => {})
  await a.commit()
  await assert.rejects(b, (e) => e.code === 'AGENT_SPEND_REFUSED')
  assert.equal(t.payer.inflightOf(s1), 0, 'nothing of the stopped order is in flight')
})
