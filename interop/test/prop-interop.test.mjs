// Properties of the visitor-grant formats (spec/TAPI-28, experimental; interop/src/interop-sig.js):
//   - the call proof preimage is exactly "TAPI-grant/call1" ‖ audience ‖ grantHash ‖ keccak(id) ‖
//     keccak(canonicalJSON({ method, params })) ‖ uint64 ts, 140 bytes: a decoder written here takes it apart and gets
//     every input back; params that differ only in key order give the same preimage; a signed proof recovers to the
//     caller's key, and any one changed input (audience, grant hash, id, method, one params value, ts) does not;
//   - grant canonicalisation is idempotent: normalizeGrant(normalizeGrant(m)) = normalizeGrant(m); the result is a wire
//     message (exactly the 14 members); its hash does not depend on the case of the addresses it was given; wireGrant
//     survives JSON text and normalises back to the same message with the same hash and a statement that still matches;
//     any one changed member changes the hash.
// A failure prints its seed; PROP_SEED=<n> PROP_RUNS=1 node --test interop/test/prop-interop.test.mjs replays one iteration.
// 访客授权格式的性质：调用证明原像可被这里写的解码器完整拆回、params 键序无关、签名恢复出调用方钥匙且任一输入改变即不再恢复；
// 授权规范化幂等、结果恰为 14 个成员、哈希与地址大小写无关、wireGrant 经 JSON 文本往返后规范化结果与哈希不变、任一成员改变哈希即变。
import test from 'node:test'
import assert from 'node:assert/strict'
import { keccak_256 } from '@noble/hashes/sha3'
import { canonicalJSON } from '@tapeapi/sdk/canon'
import { privateKeyToAddress } from '@tapeapi/sdk/sig'
import { parseTapeName } from '@tapeapi/sdk/chains'
import {
  callProofPreimage, signCallProof, recoverCallProofSigner, CALL_PROOF_PREFIX, CALL_PROOF_PREIMAGE_BYTES,
  makeGrant, normalizeGrant, grantHashOf, wireGrant, statementMatches, METHOD_NAME_RE, MAX_GRANT_METHODS, MAX_GRANT_CALLS, MAX_GRANT_LIFE_S,
} from '../src/interop-sig.js'
import { forAll, runsOf, seedOf } from '../../sdk/test/helpers/prng.mjs'

const HUB = '0xe61A9C7213a6Aa616C246a2B569e555B417b25ee'
const te = new TextEncoder()
const hex = (b) => '0x' + Buffer.from(b).toString('hex')
const keyOf = (r) => '0x' + r.hex(32).slice(2).replace(/^0/, '1')
const nonZeroAddr = (r) => { const a = r.hex(20); return /^0x0{40}$/.test(a) ? '0x' + '01'.repeat(20) : a }
const casing = (r, a) => '0x' + [...a.slice(2)].map((c) => (r.bool() ? c.toUpperCase() : c.toLowerCase())).join('')
const tapeName = (r) => { const n = r.bool() ? `${1 + r.int(1_000_000)}.${r.int(1000)}.tape` : `${1 + r.int(5000)}.${r.pick([2, 3])}.${r.int(10)}.tape`; assert.equal(parseTapeName(n)?.name, n); return n }
const methodName = (r) => { const first = 'abcXYZ_'; const rest = 'abcxyz019_Q'; let s = r.pick([...first]); for (let i = 0; i < r.int(20); i++) s += r.pick([...rest]); assert.match(s, METHOD_NAME_RE); return s }
const paramsOf = (r) => { const o = {}; for (let i = 0; i < r.int(5); i++) o[r.text(6)] = r.pick([r.text(10), r.int(1e9), r.bool(), null, [r.int(9), r.text(2)], { z: r.text(3), a: r.int(5) }]); return o }
const shuffleKeys = (r, v) => (Array.isArray(v) ? v.map((x) => shuffleKeys(r, x)) : v && typeof v === 'object' ? Object.fromEntries(r.shuffle(Object.entries(v)).map(([k, x]) => [k, shuffleKeys(r, x)])) : v)

// The decoder, from the layout in the comment of interop-sig.js / TAPI-28 only. / 只依据格式说明写的解码器。
function decodePreimage(b) {
  assert.equal(b.length, 140)
  let o = 0
  const take = (n) => { const s = b.slice(o, o + n); o += n; return s }
  const prefix = new TextDecoder().decode(take(16)), audience = hex(take(20)), grantHash = hex(take(32)), idHash = hex(take(32)), callHash = hex(take(32))
  const ts = Number(Buffer.from(take(8)).readBigUInt64BE())
  return { prefix, audience, grantHash, idHash, callHash, ts }
}

test(`property (f1): the call proof preimage decodes back to its inputs, ignores params key order, and its signature binds every input (${runsOf()} iterations, seed ${seedOf(0xf1)})`, async () => {
  assert.equal(CALL_PROOF_PREIMAGE_BYTES, 140); assert.equal(CALL_PROOF_PREFIX.length, 16)
  await forAll(import.meta.url, (r) => {
    const o = { audience: casing(r, nonZeroAddr(r)), grantHash: r.hex(32), id: r.text(40).slice(0, 128), method: methodName(r), params: r.p(0.1) ? null : paramsOf(r), ts: r.pick([0, 1_790_000_000 + r.int(1e7), Number.MAX_SAFE_INTEGER, r.int(2 ** 32)]) }
    const pre = callProofPreimage(o)
    const d = decodePreimage(pre)
    assert.equal(d.prefix, CALL_PROOF_PREFIX)
    assert.equal(d.audience, o.audience.toLowerCase())
    assert.equal(d.grantHash, o.grantHash)
    assert.equal(d.idHash, hex(keccak_256(te.encode(o.id))))
    assert.equal(d.callHash, hex(keccak_256(te.encode(canonicalJSON({ method: o.method, params: o.params ?? {} })))))
    assert.equal(d.ts, o.ts)
    if (o.params) assert.deepEqual(callProofPreimage({ ...o, params: shuffleKeys(r, o.params) }), pre, 'params key order is not part of the proof')
    if (r.p(0.3)) {
      const pk = keyOf(r), who = privateKeyToAddress(pk)
      const p = signCallProof(o, pk)
      assert.equal(p.ts, o.ts)
      assert.equal(recoverCallProofSigner(o, p.sig), who)
      const field = r.pick(['audience', 'grantHash', 'id', 'method', 'params', 'ts'])
      const w = { ...o }
      if (field === 'audience') w.audience = '0x' + (BigInt(o.audience) ^ 1n).toString(16).padStart(40, '0')
      if (field === 'grantHash') w.grantHash = '0x' + (BigInt(o.grantHash) ^ 1n).toString(16).padStart(64, '0')
      if (field === 'id') w.id = o.id.length < 128 ? o.id + 'x' : 'y' + o.id.slice(1)
      if (field === 'method') w.method = o.method + 'x'
      if (field === 'params') w.params = { ...(o.params ?? {}), [`k${r.int(99)}`]: 'changed' }
      if (field === 'ts') w.ts = o.ts === 0 ? 1 : o.ts - 1
      assert.notEqual(recoverCallProofSigner(w, p.sig), who, `${field} changed, the proof still recovered to the caller key`)
    }
  }, { seed: seedOf(0xf1) })
})

function drawGrant(r) {
  const userPk = keyOf(r), callerKeyPk = keyOf(r)
  const methods = []
  while (methods.length < 1 + r.int(MAX_GRANT_METHODS)) { const m = methodName(r); if (!methods.includes(m)) methods.push(m) }
  const now = 1_790_000_000 + r.int(1e7)
  const notBefore = now - r.int(3600), life = 1 + r.int(MAX_GRANT_LIFE_S)
  return makeGrant({
    user: casing(r, privateKeyToAddress(userPk)), caller: casing(r, nonZeroAddr(r)), callerName: tapeName(r), callerHolder: casing(r, nonZeroAddr(r)), callerKey: casing(r, privateKeyToAddress(callerKeyPk)),
    audience: casing(r, nonZeroAddr(r)), audienceName: tapeName(r), audienceHolder: casing(r, nonZeroAddr(r)), methods, maxCalls: 1 + r.int(MAX_GRANT_CALLS),
    notBefore, expires: notBefore + life, nonce: r.hex(32).replace(/^0x0{64}$/, '0x' + '1'.repeat(64)), lang: r.pick(['en', 'zh']), now,
  })
}

test(`property (f2): grant canonicalisation is idempotent, case-free in its addresses, survives the wire as JSON text, and its hash binds every member (${runsOf()} iterations, seed ${seedOf(0xf2)})`, async () => {
  await forAll(import.meta.url, (r) => {
    const g = drawGrant(r)
    const chainId = r.pick([56, 196, 8453])
    const n1 = normalizeGrant(g), n2 = normalizeGrant(n1)
    assert.deepEqual(n2, n1, 'normalizeGrant is idempotent')
    assert.deepEqual(normalizeGrant(n1, { wire: true }), n1, 'a normalised grant is a wire message (exactly the 14 members)')
    assert.ok(statementMatches(n1), 'the statement is the v1 rendering of the fields')
    const h = grantHashOf(chainId, HUB, n1)
    assert.match(h, /^0x[0-9a-f]{64}$/)
    // the case of the addresses given does not matter / 地址大小写无关
    const recased = Object.fromEntries(Object.entries(g).map(([k, v]) => [k, typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? casing(r, v) : v]))
    assert.equal(grantHashOf(chainId, HUB, normalizeGrant(recased)), h)
    // the wire form survives JSON text / 线上形式经 JSON 文本往返
    const wire = JSON.parse(JSON.stringify(wireGrant({ chainId, message: shuffleKeys(r, n1), userSig: '0x' + '11'.repeat(65), proof: { ts: 1, sig: '0x' + '22'.repeat(65) } })))
    assert.deepEqual(Object.keys(wire).sort(), ['chainId', 'message', 'proof', 'userSig', 'v'])
    const back = normalizeGrant(wire.message, { wire: true })
    assert.deepEqual(back, n1)
    assert.equal(grantHashOf(wire.chainId, HUB, back), h)
    // any one member changed -> another hash (or the change is refused) / 任一成员改变则哈希改变（或被拒绝）
    const keys = Object.keys(n1)
    const k = keys[r.int(keys.length)]
    const m = structuredClone(n1)
    if (typeof m[k] === 'string' && /^0x[0-9a-fA-F]{40}$/.test(m[k])) m[k] = '0x' + (BigInt(m[k]) ^ 2n).toString(16).padStart(40, '0')
    else if (k === 'nonce') m.nonce = '0x' + (BigInt(m.nonce) ^ 1n).toString(16).padStart(64, '0')
    else if (k === 'methods') m.methods = m.methods.length > 1 && r.bool() ? [...m.methods].reverse() : [...m.methods.slice(0, -1), m.methods.at(-1) + 'x']
    else if (k === 'maxCalls') m.maxCalls = m.maxCalls === 1 ? 2 : m.maxCalls - 1
    else if (k === 'notBefore') m.notBefore -= 1
    else if (k === 'expires') m.expires = m.expires - 1 > m.notBefore ? m.expires - 1 : m.expires + 1
    else if (k === 'callerName' || k === 'audienceName') m[k] = m[k].replace(/^(\d+)/, (d) => String(Number(d) + 1))
    else m[k] = m[k] + ' '
    let other = null
    try { other = grantHashOf(chainId, HUB, normalizeGrant(m)) } catch { other = 'refused' }
    if (k === 'methods' && m.methods.length > 1 && m.methods.join() === [...n1.methods].reverse().join()) assert.notEqual(other, h, 'the order of the methods is signed')
    else assert.notEqual(other, h, `${k} changed, the hash did not`)
    assert.notEqual(grantHashOf(chainId + 1, HUB, n1), h, 'the chain id is in the domain')
  }, { seed: seedOf(0xf2) })
})
