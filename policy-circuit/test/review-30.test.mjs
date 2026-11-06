// Review 3.0 (adversarial, local): reproducers for the findings on @tapeapi/policy-circuit and pins for what held. Each
// test names its finding (R30-C<n>) as the internal review lists it; a `todo` test is a finding left as a
// recommendation (it asserts the behaviour the review asks for and fails until that is decided).
// 3.0 对抗性审查（本地）：@tapeapi/policy-circuit 各发现的复现用例与钉住用例。todo 测试是留作建议的发现（断言建议的行为，决定之前会失败）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { signDigest } from '@tapeapi/sdk/sig'
import { TapeAPIError } from '@tapeapi/sdk'
import * as pc from '@tapeapi/policy-circuit'
import { parseLossless } from './policy-circuit-helpers.mjs'

const HERE = new URL('./vectors/', import.meta.url)
const v = parseLossless(readFileSync(new URL('vectors.json', HERE), 'utf8'))
const file = (name) => new Uint8Array(readFileSync(new URL(v.policies[name].file, HERE)))
const TABLES = v.tables.tables
const [K1, K2] = [v.keys['1'], v.keys['2']]
const D0 = 1793008800, DAY = 86400, UNIT = 10n ** 15n
const ASSET = '0x' + 'aa'.repeat(20), P1 = '0x' + '11'.repeat(20)
const CONTRACT = '0x' + 'c0'.repeat(20)
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const fixed = (byte) => {
  const head = [0x54, 0x41, 0x50, 0x4e, 0x45, 0x54, 1, 0, 0, 0, 0, 128, 0, 0, 0, 8]
  const one = [0, 0, 0, 0, 0, 0, 0], zero = [0, 0, 0, 1, 0, 0, 1]
  return Uint8Array.from([...head, ...Array.from({ length: 8 }, (_, i) => ((byte >> i) & 1 ? one : zero)).flat()])
}
const ALLOW_ALL = fixed(0x01)
const bindingOf = (over = {}) => ({ netlistHash: pc.policyNetlistHash(ALLOW_ALL), ...pc.policySubject.account('0x' + '0c'.repeat(20)), tablesHash: v.tables.tablesHash, notBefore: D0, expires: D0 + 7 * DAY, issued: D0 - 3600, ...over })
const signed = (b, key = K1, chainId = 56) => signDigest(pc.policyBindingHash(chainId, b), key.priv)
const pay = (units) => ({ amount: (BigInt(units) * UNIT).toString(), asset: ASSET, counterparty: P1, kind: 1 })
const opts = (o = {}) => ({ now: D0 + 60, policyFile: ALLOW_ALL, ...o })

test('R30-C1 (fixed): an EIP-1271 reader that answers anything but true or false leaves the binder unchecked, never a pass', async () => {
  const b = bindingOf(); const sig = signed(b, K2)   // an owner key of the contract binder, say / 合约绑定者的某个所有者钥匙
  for (const odd of ['0x00000000', 1, {}, 'false', [], 0]) {
    const reader = { resolve: async () => ({ binder: CONTRACT, pinned: null }), isValidSignature: async () => odd }
    const r = await pc.verifyPolicyBinding(56, b, sig, TABLES, opts({ binder: reader }))
    assert.deepEqual([r.binderChecked, r.enforceable, r.eip1271], [false, null, false], JSON.stringify(odd))
    assert.match(r.binderError, /EIP-1271/)
    const g = await pc.createPolicyGate({ chainId: 56, binding: b, sig, tables: TABLES, policyFile: ALLOW_ALL, binder: reader, clock: () => D0 + 60 })
    assert.equal((await g.admit(pay(1))).verdict, 'deny', JSON.stringify(odd))
  }
  // true and false still mean what they say / true 与 false 照旧
  const yes = { resolve: async () => ({ binder: CONTRACT, pinned: null }), isValidSignature: async () => true }
  assert.equal((await pc.verifyPolicyBinding(56, b, sig, TABLES, opts({ binder: yes }))).enforceable, true)
  const no = { resolve: async () => ({ binder: CONTRACT, pinned: null }), isValidSignature: async () => false }
  const rn = await pc.verifyPolicyBinding(56, b, sig, TABLES, opts({ binder: no }))
  assert.deepEqual([rn.binderChecked, rn.enforceable, rn.problems], [true, false, ['not-signed-by-binder']])
  // a revocation the reader answers oddly: the binding is unchecked, never unrevoked / 撤销的回答古怪：绑定未核对，绝不当作未撤销
  const revocation = { bindingHashes: [pc.policyBindingHash(56, b)], revokedBefore: 0, issued: D0 }
  const revSig = signDigest(pc.policyRevocationHash(56, revocation), K2.priv)
  const half = { resolve: async () => ({ binder: CONTRACT, pinned: null }), isValidSignature: async (a, digest) => (digest === pc.policyBindingHash(56, b) ? true : 'yes') }
  const rr = await pc.verifyPolicyBinding(56, b, sig, TABLES, opts({ binder: half, revocations: [{ revocation, sig: revSig }] }))
  assert.deepEqual([rr.binderChecked, rr.enforceable], [false, null])
})

test('R30-C2 (fixed): the gate does not replay its whole trace after each of its own decisions (per-decision cost stays flat)', async () => {
  let reads = 0
  const tables = {}
  Object.defineProperty(tables, 'assets', { enumerable: true, get() { reads++; return TABLES.assets } })
  Object.defineProperty(tables, 'counterparties', { enumerable: true, value: TABLES.counterparties })
  const b = bindingOf({ netlistHash: v.policies['daily-cap'].sha256 })
  let t = D0 + 60
  const g = await pc.createPolicyGate({ chainId: 56, binding: b, sig: signed(b), tables, policyFile: file('daily-cap'), binder: K1.address, clock: () => t })
  await g.startTrace({ reason: 'review' })
  const costAt = async (n) => { while (g.trace().length < n) { await g.admit({ ...pay(0), amount: '1' }); t++ } const r0 = reads; await g.admit({ ...pay(0), amount: '1' }); t++; return reads - r0 }
  const early = await costAt(5), late = await costAt(60)
  assert.equal(late, early, `table reads per decision: ${early} after 5 entries, ${late} after 60`)
  // another gate's line in between still makes it re-read and replay (shared store) / 中间有别的守门方写入时仍会重读重放
  const store = pc.memoryPolicyTraceStore()
  const g1 = await pc.createPolicyGate({ chainId: 56, binding: b, sig: signed(b), tables: TABLES, policyFile: file('daily-cap'), binder: K1.address, clock: () => t, store })
  const g2 = await pc.createPolicyGate({ chainId: 56, binding: b, sig: signed(b), tables: TABLES, policyFile: file('daily-cap'), binder: K1.address, clock: () => t, store })
  await g1.startTrace({ reason: 'review' })
  for (let i = 0; i < 3; i++) { assert.equal((await g1.admit(pay(500))).verdict, 'allow'); t++ }
  assert.equal((await g2.admit(pay(500))).verdict, 'allow', 'the fourth of 500 fits')
  assert.equal((await g1.admit(pay(500))).reasonName, 'period-limit-reached', 'g1 saw g2\'s line')
  assert.equal(g1.trace().length, 5)
})

test('R30-C3 (fixed): after the circuit changes hands, the gate refuses the earlier holder\'s binding at the next decision', async () => {
  let holder = K1.address
  // the new holder is an account with no code: EIP-1271 says no / 新持有人是没有代码的账户：EIP-1271 回答否
  const reader = { resolve: async () => ({ binder: holder, pinned: null }), isValidSignature: async () => false }
  const b = bindingOf(); const sig = signed(b, K1)
  const g = await pc.createPolicyGate({ chainId: 56, binding: b, sig, tables: TABLES, policyFile: ALLOW_ALL, binder: reader, clock: () => D0 + 60 })
  assert.equal((await g.admit(pay(1))).verdict, 'allow')
  holder = K2.address   // the circuit is transferred; the new holder signed nothing / 电路转手；新持有人什么都没签
  const r = await g.admit(pay(1))
  assert.deepEqual([r.verdict, r.problem], ['deny', 'not-signed-by-binder'])
  // the same through policyBinderFromApi: one siteStatus read per decision, after the one at creation / 经 policyBinderFromApi：创建一次，此后每次判定一次
  let reads = 0, who = K1.address
  const api = { siteStatus: async () => { reads++; return { status: 'ok', holder: who, pinned: { number: 9 + reads, hash: '0x' + (9 + reads).toString(16).padStart(64, '0') } } } }
  const rpc = { call: async () => '0x', ethCall: async () => { throw new Error('no code, never asked') }, tap10Block: async () => ({ number: 9, hash: '0x' + '99'.repeat(32) }) }
  const g2 = await pc.createPolicyGate({ chainId: 56, binding: b, sig, tables: TABLES, policyFile: ALLOW_ALL, binder: pc.policyBinderFromApi(api, { rpc }), clock: () => D0 + 60 })
  assert.equal(reads, 1)
  for (let i = 0; i < 3; i++) assert.equal((await g2.admit(pay(1))).verdict, 'allow')
  assert.equal(reads, 4, 'one siteStatus read per decision')
  who = K2.address
  assert.deepEqual([(await g2.admit(pay(1))).problem, reads], ['not-signed-by-binder', 5])
})

test('R30-C3 (fixed): a binder read that fails on a later decision denies; the earlier answer is not reused', async () => {
  let down = false
  const b = bindingOf()
  const reader = { resolve: async () => { if (down) throw new Error('nodes down'); return { binder: K1.address, pinned: null } } }
  const g = await pc.createPolicyGate({ chainId: 56, binding: b, sig: signed(b, K1), tables: TABLES, policyFile: ALLOW_ALL, binder: reader, clock: () => D0 + 60 })
  assert.equal((await g.admit(pay(1))).verdict, 'allow')
  down = true
  const r = await g.admit(pay(1))
  assert.deepEqual([r.verdict, r.problem], ['deny', 'binder-not-checked'])
  assert.match(r.detail, /nodes down/)
  down = false
  assert.equal((await g.admit(pay(1))).verdict, 'allow', 'the reads are back')
  // a contract binder: an EIP-1271 "yes" is not kept past its block, and a failed EIP-1271 read denies
  // 合约绑定者：EIP-1271 的"是"不越过它所在的块保留；EIP-1271 读取失败即拒绝
  let block = 1, owner = true, broken = false
  const cb = bindingOf(); const csig = signed(cb, K2)
  const contract = {
    resolve: async () => ({ binder: CONTRACT, pinned: { number: block, hash: '0x' + block.toString(16).padStart(64, '0') } }),
    isValidSignature: async () => { if (broken) throw new Error('RPC down'); return owner },
  }
  const gc = await pc.createPolicyGate({ chainId: 56, binding: cb, sig: csig, tables: TABLES, policyFile: ALLOW_ALL, binder: contract, clock: () => D0 + 60 })
  assert.equal((await gc.admit(pay(1))).verdict, 'allow')
  block = 2; broken = true
  assert.deepEqual([(await gc.admit(pay(1))).verdict, (await gc.admit(pay(1))).problem], ['deny', 'binder-not-checked'])
  block = 3; broken = false; owner = false   // the contract dropped the owner key / 合约去掉了这把所有者钥匙
  assert.equal((await gc.admit(pay(1))).problem, 'not-signed-by-binder')
})

test('R30-C3 (fixed): a revocation the contract binder accepts only from a later block is honoured at the next decision', async () => {
  let block = 1
  const b = bindingOf(); const sig = signed(b, K2)   // signed with an owner key of the contract binder / 合约绑定者的所有者钥匙所签
  const revocation = { bindingHashes: [pc.policyBindingHash(56, b)], revokedBefore: 0, issued: D0 + 30 }
  const rh = pc.policyRevocationHash(56, revocation)
  const revSig = signDigest(rh, K2.priv)
  const asked = []
  const reader = {
    resolve: async () => ({ binder: CONTRACT, pinned: { number: block, hash: '0x' + block.toString(16).padStart(64, '0') } }),
    // the binding is the contract's at every block; the revocation is registered at block 2 / 绑定在每个块上都成立；撤销在第 2 块登记
    isValidSignature: async (a, digest, s, pinned) => { asked.push(pinned?.number); return digest === rh ? pinned?.number >= 2 : true },
  }
  const g = await pc.createPolicyGate({ chainId: 56, binding: b, sig, tables: TABLES, policyFile: ALLOW_ALL, binder: reader, revocations: () => [{ revocation, sig: revSig }], clock: () => D0 + 60 })
  assert.equal((await g.admit(pay(1))).verdict, 'allow', 'not yet registered')
  block = 2
  const r = await g.admit(pay(1))
  assert.deepEqual([r.verdict, r.problem], ['deny', 'binding-revoked'])
  assert.deepEqual(asked.slice(-2), [2, 2], 'the binding and the revocation are asked at the fresh pin')
})

test('N4 (fixed): the binder and revocation reads of a decision run before the trace lock is taken, not while it is held', async () => {
  const inner = pc.memoryPolicyTraceStore()
  let held = false, readsUnderLock = 0, reads = 0
  const store = { read: () => inner.read(), append: (x) => inner.append(x), lock: async () => { held = true; return () => { held = false } } }
  const note = () => { reads++; if (held) readsUnderLock++ }
  const b = bindingOf()
  const reader = { resolve: async () => { note(); return { binder: K1.address, pinned: null } } }
  const g = await pc.createPolicyGate({ chainId: 56, binding: b, sig: signed(b), tables: TABLES, policyFile: ALLOW_ALL, binder: reader, revocations: async () => { note(); return [] }, store, clock: () => D0 + 60 })
  for (let i = 0; i < 3; i++) assert.equal((await g.admit(pay(1))).verdict, 'allow')
  assert.deepEqual([reads, readsUnderLock], [8, 0], 'two reads at creation and two per decision, none under the lock')
})

test('R30 pin (CONFIRMED): signature forms: high s, v other than 0/1/27/28, 64 or 66 bytes are refused before any EIP-1271 read; v 0/1 map to 27/28', async () => {
  const b = bindingOf(); const sig = signed(b)
  const bytes = Buffer.from(sig.slice(2), 'hex')
  const s = BigInt('0x' + bytes.subarray(32, 64).toString('hex'))
  const high = Buffer.from(bytes); high.set(Buffer.from((N - s).toString(16).padStart(64, '0'), 'hex'), 32); high[64] = bytes[64] === 27 ? 28 : 27
  const vAt = (x) => { const c = Buffer.from(bytes); c[64] = x; return '0x' + c.toString('hex') }
  let asked = 0
  const reader = { resolve: async () => ({ binder: K1.address, pinned: null }), isValidSignature: async () => { asked++; return true } }
  for (const [s2, problem] of [['0x' + high.toString('hex'), 'signature-high-s'], [vAt(29), 'signature-bad-v'], [vAt(26), 'signature-bad-v'], [sig.slice(0, 130), 'signature-bad-signature-length'], ['0x', 'signature-bad-signature-length']]) {
    const r = await pc.verifyPolicyBinding(56, b, s2, TABLES, opts({ binder: reader }))
    assert.equal(r.problems[0], problem); assert.notEqual(r.enforceable, true)
  }
  assert.equal(asked, 0, 'a malformed 65-byte (or shorter) signature is refused without asking')
  assert.equal((await pc.verifyPolicyBinding(56, b, vAt(bytes[64] - 27), TABLES, opts({ binder: K1.address }))).enforceable, true, 'v 0/1 read as 27/28 (TAP-11 §4.4)')
  // another chain's signature recovers to someone else / 别的链上的签名恢复出别人
  assert.deepEqual((await pc.verifyPolicyBinding(56, b, signed(b, K1, 97), TABLES, opts({ binder: K1.address }))).problems, ['not-signed-by-binder'])
})

test('R30 pin (CONFIRMED): kinds 1 and 2 are never enforceable true, kind 4 never anything but false, with every check passing', async () => {
  const s = v.subjects.escrowSession
  const session = { escrow: s.escrow, consumer: s.consumer, provider: s.provider, key: s.key, expires: D0 + 7 * DAY }
  for (const [sub, want] of [[pc.policySubject.mandate('0x' + '5a'.repeat(32)), 'conditional'], [pc.policySubject.escrowSession(session), 'conditional'], [pc.policySubject.label('x'), false]]) {
    const b = bindingOf(sub)
    const r = await pc.verifyPolicyBinding(56, b, signed(b), TABLES, opts({ binder: K1.address }))
    assert.equal(r.enforceable, want, sub.subjectKind)
  }
  assert.throws(() => pc.policySubject.escrowSession({ ...session, escrow: '0x4020074e9df2ce1dee5a9c1b5c3f541d02a10003' }), (e) => e.data?.reason === 'policy-subject-x402')
  assert.throws(() => pc.policySubject.escrowSession({ ...session, channelId: '0x' + '00'.repeat(32) }), (e) => e.data?.reason === 'policy-subject-x402')
})

test('R30 pin (CONFIRMED): policyBinderFromApi reads EIP-1271 as OpenZeppelin does (the whole first word), and fails closed', async () => {
  const MAGIC = '0x1626ba7e' + '0'.repeat(56)
  const api = { siteStatus: async () => ({ status: 'ok', holder: CONTRACT, pinned: { number: 9, hash: '0x' + '99'.repeat(32) } }) }
  const rpcAnswering = (ret) => ({ call: async (m) => (m === 'eth_getCode' ? '0x6080' : null), ethCall: async () => { if (ret instanceof Error) throw ret; return ret }, tap10Block: async () => ({ number: 9, hash: '0x' + '99'.repeat(32) }) })
  const b = bindingOf(); const sig = signed(b, K2)
  const cases = [
    [MAGIC, true], [MAGIC + 'ff'.repeat(32), true], ['0x1626ba7e', false], ['0x' + '00'.repeat(32), false], ['0x' + '1626ba7e'.padStart(64, '0'), false],
    [new TapeAPIError('RPC_ERROR', 'execution reverted', { rpcCode: 3, rpcRevert: true }), false],
  ]
  for (const [ret, ok] of cases) {
    const r = await pc.verifyPolicyBinding(56, b, sig, TABLES, opts({ binder: pc.policyBinderFromApi(api, { rpc: rpcAnswering(ret) }) }))
    assert.equal(r.enforceable === true, ok, String(ret).slice(0, 20))
  }
  const down = await pc.verifyPolicyBinding(56, b, sig, TABLES, opts({ binder: pc.policyBinderFromApi(api, { rpc: rpcAnswering(new TapeAPIError('RPC_UNAVAILABLE', 'nodes down')) }) }))
  assert.deepEqual([down.binderChecked, down.enforceable], [false, null])
  const eoa = { call: async () => '0x', ethCall: async () => MAGIC, tap10Block: async () => ({ number: 9, hash: '0x' + '99'.repeat(32) }) }
  assert.notEqual((await pc.verifyPolicyBinding(56, b, sig, TABLES, opts({ binder: pc.policyBinderFromApi(api, { rpc: eoa }) }))).enforceable, true, 'no code: never EIP-1271')
})

test('R30-C4 (fixed): policyBinderFromApi never reads the binder on another chain than the one the binding is checked on', async () => {
  const api = { siteStatus: async ({ chainId }) => ({ status: 'ok', holder: chainId === 56 ? K1.address : K2.address, pinned: null }) }
  const b = bindingOf()
  const on97 = await pc.verifyPolicyBinding(97, b, signed(b, K1, 97), TABLES, opts({ binder: pc.policyBinderFromApi(api) }))
  assert.deepEqual([on97.binderChecked, on97.enforceable], [false, null], 'a chain-56 reader for a chain-97 binding')
  assert.match(on97.binderError, /chain 56/)
  const on56 = await pc.verifyPolicyBinding(56, b, signed(b, K1, 56), TABLES, opts({ binder: pc.policyBinderFromApi(api) }))
  assert.equal(on56.enforceable, true)
  const g = await pc.createPolicyGate({ chainId: 97, binding: b, sig: signed(b, K1, 97), tables: TABLES, policyFile: ALLOW_ALL, binder: pc.policyBinderFromApi(api), clock: () => D0 + 60 })
  assert.equal((await g.admit(pay(1))).verdict, 'deny')
})

test('R30 pin (CONFIRMED): the request word saturates exactly at 2^32 units, rounds up, and refuses what it cannot encode', () => {
  const unit = BigInt(TABLES.assets[ASSET].unit)
  const f = (amount) => pc.policyRequestFields({ amount: amount.toString(), asset: ASSET, counterparty: P1, kind: 1, ts: D0 }, TABLES)
  assert.deepEqual([f(0n).amount, f(0n).overflow], [0, 0])
  assert.deepEqual([f(1n).amount, f(1n).overflow], [1, 0], 'one base unit rounds up to one unit')
  assert.deepEqual([f((2n ** 32n - 1n) * unit).amount, f((2n ** 32n - 1n) * unit).overflow], [0xffffffff, 0])
  assert.deepEqual([f((2n ** 32n - 1n) * unit + 1n).amount, f((2n ** 32n - 1n) * unit + 1n).overflow], [0xffffffff, 1])
  assert.deepEqual([f(2n ** 256n - 1n).amount, f(2n ** 256n - 1n).overflow], [0xffffffff, 1])
  for (const bad of [{ amount: (2n ** 256n).toString() }, { amount: -1 }, { amount: 2 ** 53 }, { amount: '1e3' }, { ts: (2n ** 64n).toString() }, { kind: 8 }, { kind: 1.5 }]) {
    assert.throws(() => pc.policyRequestWord({ amount: '1', asset: ASSET, counterparty: P1, kind: 1, ts: D0, ...bad }, TABLES), (e) => e.code === 'request-malformed', JSON.stringify(bad, (k, x) => (typeof x === 'bigint' ? String(x) : x)))
  }
  // prototype keys never reach a table or a request / 原型键进不了表与请求
  assert.throws(() => pc.checkPolicyTables(JSON.parse('{"assets":{"__proto__":{"class":1,"unit":"1"}},"counterparties":{}}')), (e) => e.code === 'tables-malformed')
  assert.throws(() => pc.checkPolicyRequest(JSON.parse(`{"amount":"1","asset":"${ASSET}","counterparty":"${P1}","kind":1,"ts":1,"__proto__":{}}`)), (e) => e.code === 'request-malformed')
})

test('R30 pin (CONFIRMED): a policy file is bounded before it is parsed; a NAND naming a later signal is refused; the largest file runs one beat in bounded time', () => {
  const big = new Uint8Array(pc.MAX_POLICY_BYTES + 1); big.set([0x54, 0x41, 0x50, 0x4e, 0x45, 0x54, 1, 0, 0, 0, 0, 128, 0, 0, 0, 8])
  assert.throws(() => pc.checkPolicyCircuit(big), (e) => e.code === 'policy-too-large')
  const fwd = Uint8Array.from([...ALLOW_ALL.subarray(0, 16), 0, 0, 0, 0xff, 0, 0, 0, ...ALLOW_ALL.subarray(23)])
  assert.throws(() => pc.checkPolicyCircuit(fwd), (e) => e.code === 'policy-invalid-file')
  // 7,019 NAND records (49,149 bytes), each naming the two signals before it / 7019 条 NAND，各引用前两个信号
  const n = Math.floor((pc.MAX_POLICY_BYTES - 16) / 7)
  const recs = new Uint8Array(16 + 7 * n); recs.set(ALLOW_ALL.subarray(0, 16))
  for (let k = 0; k < n; k++) { const at = 16 + 7 * k, a = 130 + k - 1, bb = 130 + k - 2; recs.set([0, a >> 16, (a >> 8) & 255, a & 255, bb >> 16, (bb >> 8) & 255, bb & 255], at) }
  const c = pc.loadPolicyCircuit(recs)
  assert.equal(c.nand, n)
  const t0 = performance.now()
  for (let i = 0; i < 100; i++) c.step(new Uint8Array(0), new Uint8Array(16))
  const per = (performance.now() - t0) / 100
  assert.ok(per < 50, `${per.toFixed(3)} ms per beat`)
})

test('R30-C5 (fixed): a kind-2 gate needs the session, without which it cannot tell an x402 channel from a #59 / #60 one', async () => {
  // the subject of an x402 batch-settlement channel, hashed the kind-2 way / 按第 2 类方式哈希的 x402 通道
  const { keccak_256 } = await import('@noble/hashes/sha3')
  const parts = ['0x4020074e9df2ce1dee5a9c1b5c3f541d02a10003', '0x' + '11'.repeat(20), '0x' + '22'.repeat(20), '0x' + '33'.repeat(20)].map((a) => Buffer.from(a.slice(2), 'hex'))
  const b = bindingOf({ subjectKind: 2, subject: '0x' + Buffer.from(keccak_256(Buffer.concat(parts))).toString('hex') })
  const required = (e) => e instanceof TapeAPIError && e.code === 'INVALID_ARGUMENT' && e.data?.reason === 'policy-session-required'
  await assert.rejects(pc.createPolicyGate({ chainId: 56, binding: b, sig: signed(b), tables: TABLES, policyFile: ALLOW_ALL, binder: K1.address, clock: () => D0 + 60 }), required)
  await assert.rejects(pc.createPolicyGate({ chainId: 56, bindings: [{ binding: bindingOf(), sig: signed(bindingOf()) }, { binding: b, sig: signed(b) }], tables: TABLES, policyFile: ALLOW_ALL, binder: K1.address, clock: () => D0 + 60 }), required, 'one kind-2 candidate is enough')
  // with the session, a #59 / #60 channel opens as conditional (never true) and an x402 one is refused
  // 给了 session：#59/#60 通道以 conditional 开门（绝不为 true），x402 通道被拒绝
  const s = v.subjects.escrowSession
  const session = { escrow: s.escrow, consumer: s.consumer, provider: s.provider, key: s.key, expires: D0 + 7 * DAY }
  const ok = bindingOf(pc.policySubject.escrowSession(session))
  const g = await pc.createPolicyGate({ chainId: 56, binding: ok, sig: signed(ok), tables: TABLES, policyFile: ALLOW_ALL, binder: K1.address, session, clock: () => D0 + 60 })
  assert.deepEqual([g.status().open, g.status().enforceable], [true, 'conditional'])
  const x402 = { escrow: '0x4020074e9df2ce1dee5a9c1b5c3f541d02a10003', consumer: '0x' + '11'.repeat(20), provider: '0x' + '22'.repeat(20), key: '0x' + '33'.repeat(20), expires: D0 + 7 * DAY }
  await assert.rejects(pc.createPolicyGate({ chainId: 56, binding: b, sig: signed(b), tables: TABLES, policyFile: ALLOW_ALL, binder: K1.address, session: x402, clock: () => D0 + 60 }), (e) => e.data?.reason === 'policy-subject-x402')
  // kinds 1, 3, 4 take no session and are unchanged / 第 1、3、4 类不需要 session，行为不变
  const g3 = await pc.createPolicyGate({ chainId: 56, binding: bindingOf(), sig: signed(bindingOf()), tables: TABLES, policyFile: ALLOW_ALL, binder: K1.address, clock: () => D0 + 60 })
  assert.equal(g3.status().enforceable, true)
})
