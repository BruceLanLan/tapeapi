// What the draft's vectors do not cover: the `enforceable` ladder over every binding vector and thousands of random
// bindings (kinds 1 and 2 never true, no file no verdict, labels never), the mandate hash of the #47 draft (G4),
// binding-outlives-subject, binding choice (§5.4), EIP-1271 binders through a reader, the x402-batch refusal, the typed
// data, the word's boundaries and hostile files.
// 草稿向量没覆盖的部分：对全部绑定向量与数千个随机绑定检查 enforceable 阶梯、#47 授权书哈希（G4）、binding-outlives-subject、
// 绑定选择、经读取函数的 EIP-1271 绑定者、拒绝 x402-batch、类型数据、请求字的边界与恶意文件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { signDigest, privateKeyToAddress } from '@tapeapi/sdk/sig'
import { mandateHashOf, MANDATE_TYPE, X402_SETTLEMENT } from '@tapeapi/sdk/agent'
import * as pc from '@tapeapi/policy-circuit'
import { parseLossless, checkPolicyBindingTrustingGivenSigners } from './policy-circuit-helpers.mjs'

const HERE = new URL('./vectors/', import.meta.url)
const v = parseLossless(readFileSync(new URL('vectors.json', HERE), 'utf8'))
const fx = JSON.parse(readFileSync(new URL('./policy-circuit-fixtures.json', import.meta.url), 'utf8'))
const file = (name) => new Uint8Array(readFileSync(new URL(v.policies[name].file, HERE)))
const TABLES = v.tables.tables
const KEYS = Object.values(v.keys).map((k) => ({ priv: k.priv, address: k.address }))
const sign = (chainId, b, priv) => signDigest(pc.policyBindingHash(chainId, b), priv)
const D0 = 1793008800
const base = (over = {}) => ({ netlistHash: v.policies['daily-cap'].sha256, subjectKind: 1, subject: v.subjects.mandate, tablesHash: v.tables.tablesHash, notBefore: D0, expires: D0 + 7 * 86400, issued: D0 - 3600, ...over })

// the ladder's invariants, as the draft states them (§0.1, §5.1, §5.3) / 阶梯的不变量
function assertLadder(r, kind, what) {
  if (kind === 1 || kind === 2) assert.notEqual(r.enforceable, true, `${what}: kind ${kind} is never enforceable: true`)
  if (!r.fileChecked) assert.ok(r.enforceable !== true && r.enforceable !== 'conditional', `${what}: no file, no verdict`)
  if (kind === 4) { assert.equal(r.enforceable, false, `${what}: a label is never enforced`); assert.equal(r.displayOnly, true); assert.match(r.display.en, /display only, binds nobody/) }
  if (kind === 3 && r.problems.includes('binding-self-signed')) assert.notEqual(r.enforceable, true, `${what}: self-signed`)
  if (!r.binderChecked && kind !== 4) assert.equal(r.enforceable, null, `${what}: binder unchecked`)
  if (r.problems.length && kind !== 4 && r.binderChecked) assert.equal(r.enforceable, false, `${what}: a problem`)
  if (r.enforceable === 'conditional') assert.match(r.display.zh, /有条件/)
}

test('the enforceable ladder over all 36 binding vectors, both revocation modes', () => {
  for (const b of v.bindings) {
    const src = fx.bindingPolicyFile[b.name]
    const policyFile = src === undefined ? null : src.startsWith('policyChecks:') ? Uint8Array.from(Buffer.from(v.policyChecks.find((c) => c.name === src.slice(13)).hex, 'hex')) : file(src)
    for (const trust of [true, false]) {
      let r
      try { r = (trust ? checkPolicyBindingTrustingGivenSigners : pc.checkPolicyBinding)(b.chainId, b.binding, b.sig, { ...TABLES, ...(fx.bindingTables[b.name] ?? {}) }, { now: b.now ?? fx.bindingNow, policyFile, binder: b.expectedSigner ?? null, declaredStateful: b.declaredStateful ?? null, revocations: b.revocations ?? null }) } catch (e) { assert.ok(e instanceof pc.PolicyCircuitError, b.name); continue }
      assertLadder(r, Number(b.binding.subjectKind), b.name)
    }
  }
})

test('the enforceable ladder over 1,500 random bindings (random kind, signer, binder, file, time, revocation)', () => {
  // mulberry32: deterministic, and its low bits are not periodic as a small LCG's are / 确定性，低位不像小 LCG 那样有周期
  let seed = 7
  const rnd = (n) => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) % n }
  const files = [null, file('daily-cap'), file('allowlist'), Uint8Array.from(Buffer.from(v.policyChecks[0].hex, 'hex'))]
  const seen = { true: 0, conditional: 0, false: 0, null: 0 }
  for (let i = 0; i < 1500; i++) {
    const kind = 1 + rnd(4)
    const key = KEYS[rnd(KEYS.length)]
    const subject = kind === 1 ? v.subjects.mandate : kind === 2 ? v.subjects.escrowSession.subject : kind === 3 ? pc.policySubject.account(rnd(3) === 0 ? key.address : KEYS[rnd(3)].address).subject : pc.policySubject.label(`label ${rnd(5)}`).subject
    const fileIx = rnd(files.length)
    // biased toward a binding that checks out, so that every rung of the ladder is reached / 偏向能核对成功的绑定，使每一级都出现
    const netlistHash = rnd(3) ? (fileIx === 2 ? v.policies.allowlist.sha256 : v.policies['daily-cap'].sha256) : v.policies.allowlist.sha256
    const b = base({ subjectKind: kind, subject, netlistHash, issued: D0 - rnd(7200) })
    const sig = rnd(10) === 0 ? null : sign(rnd(5) === 0 ? 97 : 56, b, key.priv)
    const binder = rnd(4) === 0 ? null : rnd(2) ? key.address : KEYS[rnd(KEYS.length)].address
    const revs = rnd(4) === 0 ? [{ revocation: { bindingHashes: [], revokedBefore: D0, issued: D0 }, sig: signDigest(pc.policyRevocationHash(56, { bindingHashes: [], revokedBefore: D0, issued: D0 }), key.priv) }] : null
    const r = pc.checkPolicyBinding(56, b, sig, TABLES, { now: D0 + rnd(9) * 86400, policyFile: files[fileIx], binder, revocations: revs })
    assertLadder(r, kind, `random ${i}`)
    seen[String(r.enforceable)]++
  }
  // every rung is reached, so the invariants are not vacuous / 每一级都出现过，不变量不是空转
  for (const k of Object.keys(seen)) assert.ok(seen[k] > 0, `enforceable ${k} reached`)
})

test('G4: the kind-1 subject is the #47 draft\'s mandate hash (commit 50a5a6f): the SDK type string and every digest agree', () => {
  const g = fx.mandateDraft
  assert.equal(MANDATE_TYPE, g.mandateType)
  assert.equal(g.hub, pc.POLICY_HUB)
  for (const { mandate, digest } of g.mandates) {
    assert.equal(mandateHashOf(56, pc.POLICY_HUB, mandate).toLowerCase(), digest.toLowerCase())
    assert.equal(pc.policySubject.mandate(mandate, { chainId: 56 }).subject, digest.toLowerCase())
  }
  const o = g.otherChain
  assert.equal(pc.policySubject.mandate(g.mandates[o.mandate].mandate, { chainId: o.chainId }).subject, o.digest.toLowerCase())
  assert.throws(() => pc.policySubject.mandate(g.mandates[0].mandate), (e) => e.code === 'INVALID_ARGUMENT', 'a mandate object needs its chain')
})

test('binding-outlives-subject (§8.1, §8.2): the binding window must fit the mandate; its expiry must not pass the session\'s', () => {
  const m = fx.mandateDraft.mandates[0].mandate
  const subject = pc.policySubject.mandate(m, { chainId: 56 }).subject
  const holder = KEYS[0]
  const inside = base({ subject, notBefore: m.notBefore, expires: m.expires, issued: m.notBefore - 60 })
  const outside = base({ subject, notBefore: m.notBefore, expires: m.expires + 1, issued: m.notBefore - 60 })
  const opts = { now: m.notBefore + 10, policyFile: file('daily-cap'), binder: holder.address, mandate: m }
  assert.deepEqual(pc.checkPolicyBinding(56, inside, sign(56, inside, holder.priv), TABLES, opts).problems, [])
  assert.deepEqual(pc.checkPolicyBinding(56, outside, sign(56, outside, holder.priv), TABLES, opts).problems, ['binding-outlives-subject'])
  assert.throws(() => pc.checkPolicyBinding(56, base(), sign(56, base(), holder.priv), TABLES, opts), (e) => e.data?.reason === 'policy-subject-mismatch', 'another mandate is not this subject')
  const s = v.subjects.escrowSession
  const kb = base({ subjectKind: 2, subject: s.subject })
  const sess = { escrow: s.escrow, consumer: s.consumer, provider: s.provider, key: s.key }
  const r1 = pc.checkPolicyBinding(56, kb, sign(56, kb, holder.priv), TABLES, { now: D0, binder: holder.address, policyFile: file('daily-cap'), session: { ...sess, expires: kb.expires } })
  assert.deepEqual(r1.problems, [])
  assert.equal(r1.enforceable, 'conditional', 'kind 2 at best conditional')
  const r2 = pc.checkPolicyBinding(56, kb, sign(56, kb, holder.priv), TABLES, { now: D0, binder: holder.address, policyFile: file('daily-cap'), session: { ...sess, expires: kb.expires - 1 } })
  assert.deepEqual(r2.problems, ['binding-outlives-subject'])
})

test('kind 2 names #59 / #60 escrow channels only: an x402-batch channel is refused (policy-subject-x402)', () => {
  const s = v.subjects.escrowSession
  const ch = { escrow: s.escrow, consumer: s.consumer, provider: s.provider, key: s.key }
  for (const x402 of [{ ...ch, enforcement: 'x402-batch' }, { ...ch, channelId: '0x' + '11'.repeat(32) }, { ...ch, escrow: X402_SETTLEMENT }, { ...ch, channelConfig: { payer: s.consumer } }]) {
    assert.throws(() => pc.policySubject.escrowSession(x402), (e) => e.code === 'INVALID_ARGUMENT' && e.data?.reason === 'policy-subject-x402')
  }
  assert.equal(pc.policySubject.escrowSession({ ...ch, enforcement: 'escrow-channel' }).subject, s.subject)
})

test('§5.4 choice: the later issued wins; equal issued with different hashes is binding-ambiguous and neither is used', () => {
  const k = KEYS[0]
  const opts = { now: D0, binder: k.address, policyFile: file('daily-cap') }
  const entry = (b) => ({ binding: b, result: pc.checkPolicyBinding(56, b, sign(56, b, k.priv), TABLES, opts) })
  const early = entry(base({ issued: D0 - 7200 })), late = entry(base({ issued: D0 - 60 }))
  assert.equal(pc.choosePolicyBinding([early, late]).chosen, late)
  const tieA = entry(base({ issued: D0 - 60, expires: D0 + 86400 }))
  assert.deepEqual(pc.choosePolicyBinding([late, tieA]), { chosen: null, problem: 'binding-ambiguous' })
  assert.equal(pc.choosePolicyBinding([late, late]).chosen, late, 'the same binding twice is one binding')
  const revoked = { binding: late.binding, result: { ...late.result, status: 'problems', problems: ['binding-revoked'] } }
  assert.equal(pc.choosePolicyBinding([early, revoked]).chosen, early, 'a binding with a problem is not a candidate')
})

test('EIP-1271 binders through a reader: accept, refuse, fail; no reader is binderChecked false, never a pass', async () => {
  const contract = '0x' + '5a'.repeat(20)
  const owner = KEYS[1]
  const b = base({ subjectKind: 3, subject: pc.policySubject.account('0x' + '0c'.repeat(20)).subject })
  const sig = sign(56, b, owner.priv)
  const opts = (reader) => ({ now: D0, policyFile: file('daily-cap'), binder: reader })
  const asked = []
  const approve = { resolve: async (kind, subject) => { asked.push(['resolve', kind, subject]); return { binder: contract, pinned: { number: 1, hash: '0x' + 'ab'.repeat(32) } } }, isValidSignature: async (...a) => { asked.push(['1271', ...a]); return true } }
  const ok = await pc.verifyPolicyBinding(56, b, sig, TABLES, opts(approve))
  assert.equal(ok.enforceable, true)
  assert.equal(ok.eip1271, true)
  assert.equal(ok.signer, contract)
  assert.deepEqual(asked[1].slice(1, 3), [contract, ok.bindingHash])
  assert.deepEqual(asked[1][4], { number: 1, hash: '0x' + 'ab'.repeat(32) }, 'asked at the block the holder was read at')
  const no = await pc.verifyPolicyBinding(56, b, sig, TABLES, opts({ ...approve, isValidSignature: async () => false }))
  assert.deepEqual([no.binderChecked, no.problems, no.enforceable], [true, ['not-signed-by-binder'], false])
  const down = await pc.verifyPolicyBinding(56, b, sig, TABLES, opts({ ...approve, isValidSignature: async () => { throw new Error('nodes disagree') } }))
  assert.deepEqual([down.binderChecked, down.enforceable], [false, null])
  assert.match(down.binderError, /EIP-1271 read failed/)
  const none = await pc.verifyPolicyBinding(56, b, sig, TABLES, opts({ resolve: approve.resolve }))
  assert.deepEqual([none.binderChecked, none.enforceable], [false, null])
  const unresolved = await pc.verifyPolicyBinding(56, b, sig, TABLES, opts({ resolve: async () => { throw new Error('site status unavailable') } }))
  assert.deepEqual([unresolved.binderChecked, unresolved.enforceable], [false, null])
  // an EOA holder signing for itself needs no read / 外部账户持有人自己签，无需读取
  const eoa = await pc.verifyPolicyBinding(56, b, sig, TABLES, opts({ resolve: async () => owner.address, isValidSignature: async () => { throw new Error('not asked') } }))
  assert.deepEqual([eoa.enforceable, eoa.eip1271], [true, false])
  // a 65-byte signature with a bad v is refused without asking (TAP-11 §4.4) / 坏 v 的 65 字节签名不询问即拒绝
  const badV = sig.slice(0, -2) + '05'
  const bv = await pc.verifyPolicyBinding(56, b, badV, TABLES, opts({ ...approve, isValidSignature: async () => { throw new Error('not asked') } }))
  assert.deepEqual([bv.problems, bv.binderChecked], [['signature-bad-v'], true])
  // a kind-1 binding the binder accepts under EIP-1271 is still only conditional / 绑定者按 EIP-1271 接受的第 1 类绑定仍只是 conditional
  const m1 = base()
  const r1 = await pc.verifyPolicyBinding(56, m1, sign(56, m1, owner.priv), TABLES, opts(approve))
  assert.equal(r1.enforceable, 'conditional')
})

test('policyBinderFromApi reads the holder at a TAP-10 pinned block and asks EIP-1271 there, with strict agreement', async () => {
  const holder = '0x' + '7c'.repeat(20)
  const pinned = { number: 100, hash: '0x' + 'cd'.repeat(32), lag: 2, maxLag: 400 }
  const calls = []
  const api = { siteStatus: async (t) => { calls.push(['siteStatus', t]); return { status: 'ok', holder, pinned } } }
  const rpc = {
    call: async (m, p, o) => { calls.push([m, p, o]); return '0x6000' },
    ethCall: async (to, data, block, o) => { calls.push(['eth_call', to, data.slice(0, 10), block, o]); return '0x1626ba7e' + '0'.repeat(56) },
    tap10Block: async () => { throw new Error('not needed') },
  }
  const r = pc.policyBinderFromApi(api, { rpc, chainId: 56 })
  const got = await r.resolve(3, '0x' + '00'.repeat(12) + '0c'.repeat(20))
  assert.deepEqual(got, { binder: holder, pinned: { number: 100, hash: pinned.hash } })
  assert.deepEqual(calls[0], ['siteStatus', { chainId: 56, container: '0x' + '0c'.repeat(20) }])
  assert.equal(await r.isValidSignature(holder, '0x' + '11'.repeat(32), '0x' + '22'.repeat(65), got.pinned), true)
  const block = { blockHash: pinned.hash, requireCanonical: true }, strict = { answers: 'tap10', strict: true }
  assert.deepEqual(calls[1], ['eth_getCode', [holder, block], strict])
  assert.deepEqual(calls[2], ['eth_call', holder, '0x1626ba7e', block, strict])
  const noRpc = pc.policyBinderFromApi(api, { chainId: 56 })
  await assert.rejects(noRpc.isValidSignature(holder, '0x' + '11'.repeat(32), '0x' + '22'.repeat(65), got.pinned), /needs `rpc`/)
  const unpaidless = pc.policyBinderFromApi({ siteStatus: async () => ({ status: 'not-tapeout', holder: null }) }, { chainId: 56 })
  await assert.rejects(unpaidless.resolve(3, '0x' + '00'.repeat(12) + '0c'.repeat(20)), /no holder/)
  assert.equal(await r.resolve(4, v.subjects.label.subject), null, 'a label has no binder')
})

test('typed data for the binder\'s console: 7 days by default, longWindow flagged, hash agrees, no signing function exported', () => {
  const td = pc.policyBindingTypedData(56, { netlistHash: v.policies['daily-cap'].sha256, ...pc.policySubject.mandate(v.subjects.mandate), tables: TABLES }, { now: D0 })
  assert.equal(td.primaryType, 'PolicyBinding')
  assert.deepEqual([td.binding.notBefore, td.binding.expires, td.binding.issued], [D0, D0 + pc.POLICY_BINDING_DEFAULT_WINDOW_S, D0])
  assert.equal(td.binding.tablesHash, v.tables.tablesHash)
  assert.equal(td.bindingHash, pc.policyBindingHash(56, td.binding))
  assert.equal(td.longWindow, false)
  assert.equal(td.domain.verifyingContract, pc.POLICY_HUB)
  assert.equal(pc.policyBindingTypedData(56, { ...td.binding, expires: D0 + 31 * 86400 }, { now: D0 }).longWindow, true)
  assert.match(pc.policyBindingTypedData(56, { ...td.binding, ...pc.policySubject.label('x') }, { now: D0 }).display.zh, /仅供展示，不约束任何人/)
  const r = pc.checkPolicyBinding(56, td.binding, signDigest(td.bindingHash, KEYS[0].priv), TABLES, { now: D0, binder: privateKeyToAddress(KEYS[0].priv), policyFile: file('daily-cap') })
  assert.equal(r.enforceable, 'conditional')
  const rv = pc.policyRevocationTypedData(56, { bindingHashes: [td.bindingHash] }, { now: D0 })
  assert.equal(rv.revocationHash, pc.policyRevocationHash(56, rv.revocation))
  assert.ok(!Object.keys(pc).some((n) => /^sign/i.test(n)), 'the package signs nothing (draft §5.1)')
})

test('a revocation signed by the binder applies in the default mode; one without a signature does not', () => {
  const k = KEYS[0], b = base()
  const rev = { bindingHashes: [], revokedBefore: b.issued + 1, issued: D0 }
  const opts = (revocations) => ({ now: D0, binder: k.address, policyFile: file('daily-cap'), revocations })
  assert.deepEqual(pc.checkPolicyBinding(56, b, sign(56, b, k.priv), TABLES, opts([{ revocation: rev, signer: k.address }])).problems, [], 'a given signer is not trusted')
  assert.deepEqual(pc.checkPolicyBinding(56, b, sign(56, b, k.priv), TABLES, opts([{ revocation: rev, sig: signDigest(pc.policyRevocationHash(56, rev), k.priv) }])).problems, ['binding-revoked'])
  assert.deepEqual(pc.checkPolicyBinding(56, b, sign(56, b, k.priv), TABLES, opts([{ revocation: rev, sig: signDigest(pc.policyRevocationHash(56, rev), KEYS[1].priv) }])).problems, [], 'another signer\'s revocation is ignored')
})

test('the word at its boundaries: the cap, one base unit over (rounds up), saturation, midnight, the 65,536-day wrap, weekdays', () => {
  const unit = 10n ** 15n
  const req = (amount, ts = D0) => ({ amount: amount.toString(), asset: '0x' + 'aa'.repeat(20), counterparty: '0x' + '11'.repeat(20), kind: 1, ts })
  const f = (a, ts) => pc.policyRequestFields(req(a, ts), TABLES)
  assert.equal(f(500n * unit).amount, 500)
  assert.equal(f(500n * unit + 1n).amount, 501, 'one base unit above rounds up')
  assert.deepEqual([f((2n ** 32n - 1n) * unit).amount, f((2n ** 32n - 1n) * unit).overflow], [0xffffffff, 0])
  assert.deepEqual([f((2n ** 32n - 1n) * unit + 1n).amount, f((2n ** 32n - 1n) * unit + 1n).overflow], [0xffffffff, 1])
  const midnight = 1793059200   // 2026-10-27 00:00:00 UTC
  assert.equal(f(1n, midnight - 1).day + 1, f(1n, midnight).day)
  assert.deepEqual([f(1n, midnight - 1).hour, f(1n, midnight).hour], [23, 0])
  assert.equal(f(1n, D0).day, f(1n, D0 + 65536 * 86400).day, 'the day index wraps')
  for (let d = 0; d < 14; d++) {
    const ts = D0 + d * 86400
    assert.equal(f(1n, ts).weekday, (new Date(ts * 1000).getUTCDay() + 6) % 7, 'Monday is 0, as the calendar says')
  }
  const daily = pc.loadPolicyCircuit(file('daily-cap'))
  assert.equal(pc.evaluatePolicyRequest(daily, req(500n * unit), TABLES).verdict, 'allow')
  assert.equal(pc.evaluatePolicyRequest(daily, req(500n * unit + 1n), TABLES).reasonName, 'amount-over-limit')
  assert.throws(() => pc.decodePolicyWord(new Uint8Array(15)), (e) => e.code === 'word-malformed')
})

test('hostile files: bounded before parsing, truncated records, unknown opcodes, REF, forward references, too few elements', () => {
  const head = (nIn = 128, nOut = 8) => [0x54, 0x41, 0x50, 0x4e, 0x45, 0x54, 1, 0, nIn >>> 24, (nIn >> 16) & 255, (nIn >> 8) & 255, nIn & 255, 0, 0, 0, nOut]
  const code = (bytes) => { try { pc.checkPolicyCircuit(Uint8Array.from(bytes)); return 'ok' } catch (e) { return e.code } }
  const nand = (a, b) => [0, a >> 16, (a >> 8) & 255, a & 255, b >> 16, (b >> 8) & 255, b & 255]
  const eight = Array.from({ length: 8 }, () => nand(0, 0)).flat()
  assert.equal(code([...head(), ...eight]), 'ok')
  assert.equal(code(new Uint8Array(pc.MAX_POLICY_BYTES + 1).fill(0xff)), 'policy-too-large', 'the length is checked first')
  assert.equal(code([...head(), ...eight, 0, 1, 2]), 'policy-invalid-file', 'truncated record')
  assert.equal(code([...head(), ...eight, 0x03]), 'policy-invalid-file', 'unknown opcode')
  assert.equal(code([...head(), ...eight, 0x02, 0, 0, 0]), 'policy-invalid-file', 'REF')
  assert.equal(code([...head(), ...nand(130 + 1, 0), ...eight]), 'policy-invalid-file', 'a NAND naming itself or a later signal')
  assert.equal(code([...head(), ...nand(0, 0)]), 'policy-invalid-file', 'fewer elements than outputs')
  assert.equal(code([...head(64, 8), ...eight]), 'policy-bad-pins')
  assert.equal(code([...head().slice(0, 15)]), 'policy-invalid-file')
  assert.throws(() => pc.checkPolicyCircuit('TAPNET'), (e) => e.code === 'policy-invalid-file', 'bytes only')
  // exactly 0x01 allows; 0x03 (allow bit with a reason) is an invalid result, denied / 只有 0x01 放行；0x03 是无效结果，按拒绝
  const out3 = [...head(), ...nand(0, 0), ...nand(0, 0), ...Array.from({ length: 6 }, () => nand(1, 1)).flat()]
  const c3 = pc.loadPolicyCircuit(Uint8Array.from(out3))
  const r = pc.evaluatePolicyRequest(c3, { amount: '1', asset: '0x' + 'aa'.repeat(20), counterparty: '0x' + '11'.repeat(20), kind: 1, ts: D0 }, TABLES)
  assert.deepEqual([r.outputs, r.verdict, r.invalidResult], ['0x03', 'deny', true])
})

test('the package source is browser-plain: no node: import, no Buffer, no process outside a typeof guard', () => {
  const dir = new URL('../src/', import.meta.url)
  for (const f of ['tapnet.js', 'policy-word.js', 'policy-binding.js', 'policy-gate.js', 'policy-circuit-public.js']) {
    const code = readFileSync(new URL(f, dir), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n')
    assert.doesNotMatch(code, /from 'node:|require\(|\bBuffer\b/, f)
    const bare = code.replaceAll("typeof process !== 'undefined' ? process.pid", '').replace(/`[^`]*`|'(?:[^'\\]|\\.)*'/g, "''")
    assert.doesNotMatch(bare, /\bprocess\b/, `${f}: process only behind a typeof guard`)
  }
})
