// Container agents phase 1, restart (experimental, internal; the internal phase-1 draft §10.9): an order resumes after a
// restart with its agent key kept sealed in the store. The vectors phase1.resume (by hand; verify.py runs its own
// predicates), then the limiter on the fake chain: the key is sealed (never in the clear), a new limiter over the same
// store resumes it only when the record, the key and a fresh check agree, and the ceiling claimedAtCheck + cap holds
// across the restart; a stopped, revoked or moved order never resumes and its sealed key is destroyed; a wrong passphrase,
// a changed blob or another key's blob fails closed. Named FIXED P1RS-*; each was checked by removing what implements it.
// 阶段 1 的重启：订单的代理钥匙密封在存储里，重启后恢复。先跑手写向量，再在假链上验证：钥匙只以密文存储；同一存储上的新限额器只在
// 记录、钥匙与新的核验一致时恢复；上限跨重启成立；已停工、撤销、换托管的单绝不恢复且密文被销毁；错口令、改过的密文、别的钥匙的密文
// 一律失败关闭。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomBytes } from '@noble/hashes/utils'
import * as agent from '../src/agent-public.js'
import { createSpendLimiter, spendResume, SPEND_RESUME_REFUSALS } from '../src/agent-pay.js'
import { passphraseKeyVault, keyVaultSeal, keyVaultOpen, spendKeyContext } from '../src/agent-vault.js'
import { standardWorld, KEYS, addrOf, S, S2, BEM_TOKEN, NOW } from './helpers/agent-chain.mjs'

const v = JSON.parse(readFileSync(new URL('../../spec/vectors/container-agent.json', import.meta.url), 'utf8')).phase1
const E1 = '0x00000000000000000000000000000000000E5c71', E2 = '0x00000000000000000000000000000000000E5c72', E3 = '0x00000000000000000000000000000000000E5c73'
const HOLDER = addrOf(KEYS.principalHolder)
const AGENT_KEY = KEYS.agentKey, AGENT = addrOf(AGENT_KEY)
const MH = '0x' + 'cd'.repeat(32)
const PASS = 'correct horse battery staple'
const PRICE = 10n
const svcOf = (provider, escrow) => ({ container: provider, manifest: { payment: { escrow } } })
const refusedWith = (p, reason) => assert.rejects(p, (e) => { assert.equal(e.code, 'AGENT_SPEND_REFUSED', e.message); assert.equal(e.data?.reason, reason, e.message); return true })
// a vault on a key of the operator's own (no scrypt: fast), the other kind the interface allows / 运营方自己的密钥（不经 scrypt）
function keyVault(key = randomBytes(32)) {
  return { seal: (b, { context }) => keyVaultSeal(key, { salt: randomBytes(16), nonce: randomBytes(24), context, plaintext: b }), open: (blob, { context }) => keyVaultOpen(key, blob, { context }) }
}
// a check as verifyMandate(…, { enforcement: 'escrow-channel' }) returns it / 核验结果
function checkOf({ claimed = ['0', '0'], escrows = [E1, E2], consumer = HOLDER, extra = {} } = {}) {
  const mandate = agent.normalizeMandate({ principal: '0x86DDaEF00401E3F10418398D67D7189fc458eA95', agent: '0x' + 'a6'.repeat(20), agentKey: AGENT, mode: 1, taskHash: '0x' + '12'.repeat(32), scope: [{ provider: S, token: BEM_TOKEN, cap: '100' }, { provider: S2, token: BEM_TOKEN, cap: '50' }], feeToken: '0x' + '00'.repeat(20), feeCap: '0', notBefore: NOW - 60, expires: NOW + 86400, nonce: '1', subdelegate: false })
  return { ok: true, enforcement: 'escrow-channel', phase: 1, mandate, mandateHash: MH, consumer, problems: [], scope: [{ provider: S, escrow: escrows[0], claimedAtCheck: claimed[0] }, { provider: S2, escrow: escrows[1], claimedAtCheck: claimed[1] }], ...extra }
}
// a store that persists across "processes": every value a string, as a disk keeps it / 跨"进程"保留的存储，值都是字符串
function diskStore() {
  const m = new Map()
  return { m, get: async (k) => m.get(k) ?? null, set: async (k, val, o) => { if (o && 'ifSeq' in o) { const cur = m.get(k); const seq = cur == null || cur === '' ? null : (JSON.parse(cur).seq ?? 0); if (seq !== o.ifSeq) return false } m.set(k, val); return true }, delete: async (k) => { m.delete(k) } }
}
// one process: a limiter over the store with its vault, and a payer whose counters live in the same store
// 一个进程：存储上的限额器与保险箱，付款器的计数器也在同一存储里
function processOn(store, vault, x) {
  const lim = createSpendLimiter({ store, vault, clock: () => NOW })
  const api = x.api()
  const payerStore = { get: (k) => store.get(`payer:${k}`), set: (k, val) => store.set(`payer:${k}`, val) }
  const payerFor = (secret, maxPrice = { [S]: '100', [S2]: '50' }) => lim.payer({ chainId: 56, payer: api.payer({ consumer: HOLDER, sessionKey: secret, store: payerStore }), maxPrice })
  return { lim, payerFor }
}
const blobKey = (agentKey = AGENT) => `tapeapi-spend:56:${agentKey.toLowerCase()}:key`
async function startedOn(store, vault, x, check = checkOf()) {
  const p = processOn(store, vault, x)
  await p.lim.accept({ chainId: 56, agentKey: AGENT })
  await p.lim.keepKey({ chainId: 56, agentKey: AGENT, secret: AGENT_KEY })
  await p.lim.start({ chainId: 56, check })
  return p
}
// every form the secret could take in a store / 密钥在存储里可能出现的各种形式
function plaintextIn(store, secret = AGENT_KEY) {
  const hex = secret.slice(2).toLowerCase()
  const forms = [hex, Buffer.from(hex, 'hex').toString('base64'), Buffer.from(hex, 'hex').toString('base64url'), Buffer.from(hex, 'hex').toString('latin1')]
  return [...store.m.entries()].filter(([k, val]) => forms.some((f) => String(val).toLowerCase().includes(f.toLowerCase()) || k.toLowerCase().includes(hex)))
}

test('FIXED P1RS-01: every phase1.resume vector: resumes, or the first refusal in order', () => {
  assert.ok(v.resume.length >= 15)
  for (const c of v.resume) {
    const d = spendResume(c.record, c.request)
    assert.deepEqual(d.ok ? { ok: true } : { ok: false, refused: d.refused }, c.expect, c.name)
    if (!d.ok) assert.ok(SPEND_RESUME_REFUSALS.includes(d.refused), d.refused)
  }
  for (const n of ['spendResume', 'SPEND_RESUME_REFUSALS', 'passphraseKeyVault']) assert.ok(n in agent, n)
})

test('FIXED P1RS-02: signed, restarted, resumed, signed on: a new limiter and a new passphrase vault over the same store resume the order, the key stays sealed, and the ceiling claimedAtCheck + cap holds across the restart', async () => {
  const x = standardWorld()
  const store = diskStore()
  const before = await startedOn(store, passphraseKeyVault({ passphrase: PASS }), x, checkOf({ claimed: ['0', '0'] }))
  const s1 = svcOf(S, E1)
  const pay1 = before.payerFor(AGENT_KEY)
  for (let i = 0; i < 6; i++) { const l = await pay1.reserve(s1, PRICE); await l.commit() }
  assert.deepEqual(plaintextIn(store), [], 'the secret is nowhere in the store, in no encoding')
  const seqBefore = (await before.lim.record({ chainId: 56, agentKey: AGENT })).seq
  // the restart: nothing of the first process is used again but the store / 重启：第一个进程只留下存储
  const after = processOn(store, passphraseKeyVault({ passphrase: PASS }), x)
  // the provider settled 20 meanwhile: hi stays the 60 signed, base the 0 of the start / provider 期间结算了 20
  const r = await after.lim.resume({ chainId: 56, agentKey: AGENT, check: checkOf({ claimed: ['20', '0'] }) })
  assert.equal(r.secret.toLowerCase(), AGENT_KEY.toLowerCase())
  assert.equal(r.recheck.ok, true)
  assert.deepEqual([r.record.providers[0].base, r.record.providers[0].hi], ['0', '60'], 'base never moves; hi is the highest signed')
  const rec = await after.lim.record({ chainId: 56, agentKey: AGENT })
  assert.equal(rec.providers[0].base, '0')
  assert.ok(rec.seq >= seqBefore, 'seq carries on')
  const pay2 = after.payerFor(r.secret)
  assert.equal(pay2.cumulativeOf(s1), 0n, 'not loaded until used')
  const signed = []
  for (let i = 0; i < 10; i++) {
    try { const l = await pay2.reserve(s1, PRICE); await l.commit(); signed.push(BigInt(l.voucher.cumulative)) } catch (e) { assert.equal(e.data?.reason, 'spend-cap-exceeded', e.message); break }
  }
  assert.deepEqual(signed, [70n, 80n, 90n, 100n], 'the counter carried on from the store, and stopped at base + cap')
  const fin = await after.lim.record({ chainId: 56, agentKey: AGENT })
  assert.equal(fin.providers[0].hi, '100')
  assert.deepEqual(plaintextIn(store), [])
})

test('FIXED P1RS-02b: the start before a restart was claimedOf 1000: after it the same base, never re-based on what the restart reads', async () => {
  const x = standardWorld()
  const store = diskStore(), vault = keyVault()
  const before = await startedOn(store, vault, x, checkOf({ claimed: ['1000', '0'] }))
  const pay1 = before.payerFor(AGENT_KEY)
  await before.lim.recheck({ chainId: 56, check: checkOf({ claimed: ['1000', '0'] }) })
  const l = await pay1.reserve(svcOf(S, E1), PRICE); await l.commit()
  const after = processOn(store, vault, x)
  const r = await after.lim.resume({ chainId: 56, agentKey: AGENT, check: checkOf({ claimed: ['1060', '0'] }) })
  assert.deepEqual([r.record.providers[0].base, r.record.providers[0].hi], ['1000', '1060'], 'base kept; hi raised to what was settled')
})

test('FIXED P1RS-03: a stopped order never resumes, and its sealed key is destroyed; a stop found by the resume check is written and destroys it too', async () => {
  const x = standardWorld()
  for (const [why, act] of [
    ['stopped while running', async (lim) => lim.stop({ chainId: 56, agentKey: AGENT, reason: 'spend-revoked' })],
    ['stopped by a recheck (another escrow)', async (lim) => lim.recheck({ chainId: 56, check: checkOf({ escrows: [E3, E2] }) })],
  ]) {
    const store = diskStore(), vault = keyVault()
    const before = await startedOn(store, vault, x)
    await act(before.lim)
    assert.equal(store.m.has(blobKey()), false, `${why}: the stop destroyed the sealed key`)
    const after = processOn(store, vault, x)
    await refusedWith(after.lim.resume({ chainId: 56, agentKey: AGENT, check: checkOf() }), 'spend-stopped')
  }
  // during the restart: the mandate was revoked, the provider moved, the holder changed: the resume check stops it
  // 重启期间：授权书被撤销、provider 换了托管、换了持有人：恢复时的核验让它停工
  for (const [check, reason] of [
    [checkOf({ extra: { ok: false, problems: [{ code: 'mandate-revoked', message: '' }] } }), 'spend-revoked'],
    [checkOf({ escrows: [E1, E3] }), 'spend-escrow-changed'],
    [checkOf({ consumer: addrOf(KEYS.stranger) }), 'spend-consumer-changed'],
    [checkOf({ extra: { ok: false, problems: [{ code: 'mandate-expired', message: '' }] } }), 'spend-expired'],
  ]) {
    const store = diskStore(), vault = keyVault()
    await startedOn(store, vault, x)
    const after = processOn(store, vault, x)
    await refusedWith(after.lim.resume({ chainId: 56, agentKey: AGENT, check }), reason)
    const rec = await after.lim.record({ chainId: 56, agentKey: AGENT })
    assert.deepEqual(rec.stopped.reasons.includes(reason), true, reason)
    assert.equal(store.m.has(blobKey()), false, `${reason}: the sealed key is destroyed`)
    await refusedWith(after.lim.resume({ chainId: 56, agentKey: AGENT, check: checkOf() }), 'spend-stopped')
    await refusedWith(after.payerFor(AGENT_KEY).reserve(svcOf(S, E1), PRICE), 'spend-stopped')
  }
})

test('FIXED P1RS-04: a wrong passphrase, a changed blob, another key\'s blob or a vault that opens to another key fail closed: nothing resumes, nothing is stopped, the blob is kept', async () => {
  const x = standardWorld()
  const store = diskStore()
  await startedOn(store, passphraseKeyVault({ passphrase: PASS }), x)
  const blob = store.m.get(blobKey())
  const wrong = processOn(store, passphraseKeyVault({ passphrase: PASS + '!' }), x)
  await refusedWith(wrong.lim.resume({ chainId: 56, agentKey: AGENT, check: checkOf() }), 'spend-key-unreadable')
  assert.equal(store.m.get(blobKey()), blob, 'kept: the operator may restart with the right passphrase')
  assert.equal((await wrong.lim.record({ chainId: 56, agentKey: AGENT })).stopped, null)
  // one bit of the ciphertext changed / 密文改一位
  const right = processOn(store, passphraseKeyVault({ passphrase: PASS }), x)
  const flipped = blob.slice(0, -10) + (blob.at(-10) === '0' ? '1' : '0') + blob.slice(-9)
  store.m.set(blobKey(), flipped)
  await refusedWith(right.lim.resume({ chainId: 56, agentKey: AGENT, check: checkOf() }), 'spend-key-unreadable')
  // another key's blob, sealed by the same vault, copied under this key: its context names the other key
  // 别的钥匙的密文（同一保险箱封存）被拷到这把钥匙下：它的 context 写的是另一把钥匙
  const other = '0x' + '5a'.repeat(32)
  const v2 = passphraseKeyVault({ passphrase: PASS })
  store.m.set(blobKey(), await v2.seal(Buffer.from(other.slice(2), 'hex'), { context: spendKeyContext(56, addrOf(other)) }))
  await refusedWith(right.lim.resume({ chainId: 56, agentKey: AGENT, check: checkOf() }), 'spend-key-unreadable')
  // a vault that opens whatever it is given to another key (a broken or hostile KMS) / 把任何密文都开成另一把钥匙的保险箱
  const liar = { seal: async () => 'x', open: async () => Buffer.from(other.slice(2), 'hex') }
  const lp = processOn(store, liar, x)
  await refusedWith(lp.lim.resume({ chainId: 56, agentKey: AGENT, check: checkOf() }), 'spend-key-mismatch')
  // no blob at all / 根本没有密文
  store.m.delete(blobKey())
  await refusedWith(right.lim.resume({ chainId: 56, agentKey: AGENT, check: checkOf() }), 'spend-key-lost')
  // another mandate's check, and none / 另一张授权书的核验，或没有核验
  store.m.set(blobKey(), blob)
  await refusedWith(right.lim.resume({ chainId: 56, agentKey: AGENT, check: { ...checkOf(), mandateHash: '0x' + 'ef'.repeat(32) } }), 'spend-resume-mismatch')
  await refusedWith(right.lim.resume({ chainId: 56, agentKey: AGENT }), 'spend-resume-mismatch')
  assert.equal((await right.lim.record({ chainId: 56, agentKey: AGENT })).stopped, null, 'none of these stops the order')
  const ok = await right.lim.resume({ chainId: 56, agentKey: AGENT, check: checkOf() })
  assert.equal(ok.secret.toLowerCase(), AGENT_KEY.toLowerCase(), 'with the right passphrase and the blob back, it resumes')
})

test('FIXED P1RS-05: a lost record is not a fresh start; a key is kept only for a live record; keepKey and resume need a vault; the secret must be the key\'s', async () => {
  const x = standardWorld()
  const store = diskStore(), vault = keyVault()
  const p = processOn(store, vault, x)
  await refusedWith(p.lim.keepKey({ chainId: 56, agentKey: AGENT, secret: AGENT_KEY }), 'spend-state-lost')
  await p.lim.accept({ chainId: 56, agentKey: AGENT })
  assert.throws(() => createSpendLimiter({ vault: {} }), (e) => e.code === 'INVALID_ARGUMENT')
  await assert.rejects(createSpendLimiter({ store }).keepKey({ chainId: 56, agentKey: AGENT, secret: AGENT_KEY }), (e) => e.code === 'INVALID_ARGUMENT')
  await assert.rejects(createSpendLimiter({ store }).resume({ chainId: 56, agentKey: AGENT }), (e) => e.code === 'INVALID_ARGUMENT')
  await assert.rejects(p.lim.keepKey({ chainId: 56, agentKey: AGENT, secret: '0x' + '5a'.repeat(32) }), (e) => e.code === 'INVALID_ARGUMENT')
  await p.lim.keepKey({ chainId: 56, agentKey: AGENT, secret: AGENT_KEY })
  // an accepted order (no mandate yet) resumes with its key, and with no check / 尚无授权书的单凭钥匙恢复，不需要核验
  const r = await processOn(store, vault, x).lim.resume({ chainId: 56, agentKey: AGENT })
  assert.equal(r.record.state, 'accepted')
  assert.equal(r.recheck, null)
  // the record lost, the blob still there: never resumed / 记录丢了、密文还在：绝不恢复
  store.m.delete(`tapeapi-spend:56:${AGENT.toLowerCase()}`)
  await refusedWith(processOn(store, vault, x).lim.resume({ chainId: 56, agentKey: AGENT }), 'spend-state-lost')
  // forgetKey destroys the blob (the order ended) / 订单结束时 forgetKey 销毁密文
  await p.lim.forgetKey({ chainId: 56, agentKey: AGENT })
  assert.equal(store.m.has(blobKey()), false)
  // a stopped record keeps no key / 已停工的记录不再保存钥匙
  const s2 = diskStore()
  const q = await startedOn(s2, vault, x)
  await q.lim.stop({ chainId: 56, agentKey: AGENT })
  await refusedWith(q.lim.keepKey({ chainId: 56, agentKey: AGENT, secret: AGENT_KEY }), 'spend-stopped')
  assert.equal(s2.m.has(blobKey()), false)
})

test('FIXED P1RS-06: a stop another writer left under the stop key is honoured by the resume, whatever the record says (the M4 rule)', async () => {
  const x = standardWorld()
  const store = diskStore(), vault = keyVault()
  await startedOn(store, vault, x)
  // another writer's stop, on its own key only (its record write lost) / 另一个写者的停工，只写在停工键上
  store.m.set(`tapeapi-spend:56:${AGENT.toLowerCase()}:stopped`, JSON.stringify({ reasons: ['spend-revoked'], at: NOW }))
  const after = processOn(store, vault, x)
  await refusedWith(after.lim.resume({ chainId: 56, agentKey: AGENT, check: checkOf() }), 'spend-stopped')
  assert.equal(store.m.has(blobKey()), false, 'and the sealed key is destroyed')
})

test('FIXED P1RS-07: a live withdraw request at the restart resumes the order, but refuses its steps until it is gone (it is no stop)', async () => {
  const x = standardWorld()
  const store = diskStore(), vault = keyVault()
  await startedOn(store, vault, x)
  const after = processOn(store, vault, x)
  const r = await after.lim.resume({ chainId: 56, agentKey: AGENT, check: checkOf({ extra: { ok: false, problems: [{ code: 'withdraw-pending', message: '' }] } }) })
  assert.equal(r.recheck.ok, false)
  assert.deepEqual(r.recheck.problems, ['withdraw-pending'])
  assert.equal(r.record.stopped, null)
  assert.ok(store.m.has(blobKey()), 'the key is kept: the order is alive')
})

test('FIXED P1RR-05: resume reads the record first: no record, or a stopped one, refuses before the vault is asked to open the sealed key (and a stopped one\'s blob is destroyed)', async () => {
  const x = standardWorld()
  const store = diskStore()
  const inner = keyVault()
  let opens = 0
  const counting = { seal: inner.seal, open: (blob, o) => { opens++; return inner.open(blob, o) } }
  // a blob without a record (the record lost): spend-state-lost, the vault never asked / 有密文无记录：不让保险箱打开
  const lone = processOn(store, counting, x)
  store.m.set(blobKey(), await inner.seal(Buffer.from(AGENT_KEY.slice(2), 'hex'), { context: spendKeyContext(56, AGENT) }))
  await refusedWith(lone.lim.resume({ chainId: 56, agentKey: AGENT, check: checkOf() }), 'spend-state-lost')
  assert.equal(opens, 0)
  store.m.delete(blobKey())
  // a stopped order: spend-stopped, the vault never asked, the blob destroyed / 已停工：不让保险箱打开，密文销毁
  const p = await startedOn(store, counting, x)
  await p.lim.stop({ chainId: 56, agentKey: AGENT, reason: 'spend-revoked' })
  store.m.set(blobKey(), await inner.seal(Buffer.from(AGENT_KEY.slice(2), 'hex'), { context: spendKeyContext(56, AGENT) }))   // a blob put back / 放回的密文
  await refusedWith(processOn(store, counting, x).lim.resume({ chainId: 56, agentKey: AGENT, check: checkOf() }), 'spend-stopped')
  assert.equal(opens, 0)
  assert.equal(store.m.has(blobKey()), false, 'the stopped order\'s blob is destroyed')
  // a live record: the vault opens it once / 有效记录：保险箱打开一次
  const y = standardWorld(), s2 = diskStore()
  await startedOn(s2, counting, y)
  const r = await processOn(s2, counting, y).lim.resume({ chainId: 56, agentKey: AGENT, check: checkOf() })
  assert.equal(opens, 1); assert.equal(r.secret.toLowerCase(), AGENT_KEY.toLowerCase())
})
