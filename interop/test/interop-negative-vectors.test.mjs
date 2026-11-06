// spec/vectors/interop-visitor-grant-negative.json: REFUSAL vectors for visitor grants (review 2026-10-22). The vector
// file interop-visitor-grant.json holds only grants that verify; this second file holds requests the service must
// refuse at steps 1-8 (the steps that need no chain read: the EIP-1271 path is not exercised), each with the reason,
// plus one control case that passes them. The first file's bytes are unchanged. spec/vectors/verify.py recomputes the
// reason of every case independently (its labels begin `grant-neg/`).
// Regenerate (only when a case is added on purpose): TAPEAPI_WRITE_VECTORS=1 node --test interop/test/interop-negative-vectors.test.mjs
// 拒绝向量：服务在第 1–8 步（不读链）必须拒绝的请求及原因，外加能过这些步骤的对照。第一个向量文件字节不变；verify.py 独立复算原因。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import * as g from '@tapeapi/interop'
import * as sig from '@tapeapi/sdk/sig'
import { CHAINS } from '@tapeapi/sdk/chains'

const FILE = new URL('../../spec/vectors/interop-visitor-grant-negative.json', import.meta.url)
const HUB = CHAINS[56].hub
const USER_KEY = '0x' + '3a'.repeat(32)            // fake keys, repeated bytes / 假钥匙
const CALLER_KEY = '0x' + '4b'.repeat(32)
const NOW = 1_791_000_000
const ME = { container: '0x' + '5e'.repeat(20), name: '13.7.tape' }
const MANIFEST = { methods: [{ name: 'history', grant: 'required', priceBEM: '0' }, { name: 'notes', grant: 'optional', priceBEM: '0' }, { name: 'profile', priceBEM: '0' }] }
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const message = (over = {}) => ({ ...g.makeGrant({
  user: sig.privateKeyToAddress(USER_KEY), caller: '0x' + 'a6'.repeat(20), callerName: '12.7.tape', callerHolder: '0x' + '44'.repeat(20),
  callerKey: sig.privateKeyToAddress(CALLER_KEY), audience: ME.container, audienceName: ME.name, audienceHolder: '0x' + '66'.repeat(20),
  methods: ['history', 'notes'], maxCalls: 1, now: NOW, nonce: '0x' + '01'.repeat(32), ...over,
}) })
const userSigOf = (m, chainId = 56) => sig.signDigest(g.grantDigest(chainId, HUB, m), USER_KEY)
const proofOf = (m, { id = 'n-1', method = 'history', params = {}, ts = NOW, audience = ME.container } = {}) =>
  g.signCallProof({ audience, grantHash: g.grantHashOf(56, HUB, m), id, method, params, ts }, CALLER_KEY)
// s -> n - s and v flipped: the same signer, high s / 高 s：同一签名者
const highS = (s65) => {
  const r = s65.slice(2, 66), s = BigInt('0x' + s65.slice(66, 130)), v = parseInt(s65.slice(130), 16)
  return '0x' + r + (N - s).toString(16).padStart(64, '0') + (v === 27 ? 28 : 27).toString(16)
}
const v01 = (s65) => s65.slice(0, -2) + (parseInt(s65.slice(-2), 16) - 27).toString(16).padStart(2, '0')

function cases() {
  const m = message()
  const req = (wire, o = {}) => ({ id: 'n-1', method: 'history', params: {}, now: NOW, ...o, grant: wire })
  const w = (msg = m, o = {}) => ({ v: 1, chainId: 56, message: msg, userSig: o.userSig ?? userSigOf(msg), proof: o.proof ?? proofOf(msg, o.p) })
  const out = []
  const add = (name, reason, r) => out.push({ name, reason, request: r })
  add('control: passes steps 1-8', null, req(w()))
  // 1 malformed
  add('v is 2', 'malformed', req({ ...w(), v: 2 }))
  add('chainId is another chain', 'malformed', req({ ...w(), chainId: 8453 }))
  add('a sixth member in grant', 'malformed', req({ ...w(), extra: 1 }))
  add('message has a 15th member', 'malformed', req(w({ ...m, extra: 'x' })))
  add('message lacks nonce', 'malformed', req(w((({ nonce, ...rest }) => rest)(m), { userSig: userSigOf(m), proof: proofOf(m) })))
  add('method "*" (no wildcard)', 'malformed', req(w({ ...m, methods: ['*'] }, { userSig: userSigOf(m), proof: proofOf(m) })))
  add('method repeated', 'malformed', req(w({ ...m, methods: ['history', 'history'] }, { userSig: userSigOf(m), proof: proofOf(m) })))
  add('nine methods', 'malformed', req(w({ ...m, methods: Array.from({ length: 9 }, (_, i) => `m${i}`) }, { userSig: userSigOf(m), proof: proofOf(m) })))
  add('maxCalls 0', 'malformed', req(w({ ...m, maxCalls: 0 }, { userSig: userSigOf(m), proof: proofOf(m) })))
  add('maxCalls 10001', 'malformed', req(w({ ...m, maxCalls: 10_001 }, { userSig: userSigOf(m), proof: proofOf(m) })))
  add('maxCalls true (a JSON boolean, not a number)', 'malformed', req(w({ ...m, maxCalls: true }, { userSig: userSigOf(m), proof: proofOf(m) })))
  add('maxCalls "1" (a string)', 'malformed', req(w({ ...m, maxCalls: '1' }, { userSig: userSigOf(m), proof: proofOf(m) })))
  add('life of 7 days + 1 s', 'malformed', req(w({ ...m, expires: m.notBefore + 604_801 }, { userSig: userSigOf(m), proof: proofOf(m) })))
  add('callerKey equals user', 'malformed', req(w({ ...m, callerKey: m.user }, { userSig: userSigOf(m), proof: proofOf(m) })))
  add('nonce with upper-case hex', 'malformed', req(w({ ...m, nonce: '0x' + 'AB'.repeat(32) }, { userSig: userSigOf(m), proof: proofOf(m) })))
  add('nonce zero', 'malformed', req(w({ ...m, nonce: '0x' + '00'.repeat(32) }, { userSig: userSigOf(m), proof: proofOf(m) })))
  add('callerName with a leading zero', 'malformed', req(w({ ...m, callerName: '12.07.tape' }, { userSig: userSigOf(m), proof: proofOf(m) })))
  add('callerName in upper case', 'malformed', req(w({ ...m, callerName: '12.7.TAPE' }, { userSig: userSigOf(m), proof: proofOf(m) })))
  add('user is the zero address', 'malformed', req(w({ ...m, user: '0x' + '00'.repeat(20) }, { userSig: userSigOf(m), proof: proofOf(m) })))
  add('userSig of 64 bytes', 'malformed', req(w(m, { userSig: '0x' + '11'.repeat(64) })))
  add('proof.ts negative', 'malformed', req(w(m, { proof: { ts: -1, sig: proofOf(m).sig } })))
  add('proof with a third member', 'malformed', req(w(m, { proof: { ...proofOf(m), x: 1 } })))
  // 2 wrong-audience
  const other = message({ audience: '0x' + '5f'.repeat(20) })
  add('another audience container', 'wrong-audience', req(w(other, { p: { audience: other.audience } })))
  const otherName = message({ audienceName: '14.7.tape' })
  add('another audience name', 'wrong-audience', req(w(otherName)))
  // 3 method-out-of-scope
  add('called method not in the grant', 'method-out-of-scope', req(w(), { method: 'profile' }))
  const withProfile = message({ methods: ['history', 'profile'] })
  add('a granted method that takes no grant here', 'method-out-of-scope', req(w(withProfile)))
  add('method name in another case', 'method-out-of-scope', req(w(message({ methods: ['History'] }))))
  // 4 expired
  add('now = expires', 'expired', req(w(), { now: m.expires }))
  const early = message({ notBefore: NOW + 300, expires: NOW + 3900 })
  add('notBefore = now + 301', 'expired', req(w(early), { now: NOW - 1 }))
  add('notBefore = now + 300 (boundary, valid)', null, req(w(early, { p: { ts: NOW } })))
  // 5 statement-mismatch
  add('statement with a trailing space', 'statement-mismatch', req(w({ ...m, statement: m.statement + ' ' })))
  add('statement "1 calls" for maxCalls 1', 'statement-mismatch', req(w({ ...m, statement: m.statement.replace('1 call,', '1 calls,') })))
  add('statement in local time, not UTC', 'statement-mismatch', req(w({ ...m, statement: m.statement.replace(/(\d\d):(\d\d):(\d\d) to/, (x, h, mi, s) => `${String((+h + 8) % 24).padStart(2, '0')}:${mi}:${s} to`) })))
  add('statement of the other language with these members swapped', 'statement-mismatch', req(w({ ...m, statement: g.renderStatement({ ...m, callerName: m.audienceName, audienceName: m.callerName }, 'zh') })))
  // 6 bad-proof
  add('proof ts 301 s old', 'bad-proof', req(w(m, { p: { ts: NOW - 301 } })))
  add('proof ts 300 s old (boundary, valid)', null, req(w(m, { p: { ts: NOW - 300 } })))
  add('proof v 0/1', 'bad-proof', req(w(m, { proof: { ts: NOW, sig: v01(proofOf(m).sig) } })))
  add('proof high s', 'bad-proof', req(w(m, { proof: { ts: NOW, sig: highS(proofOf(m).sig) } })))
  add('proof over other params', 'bad-proof', req(w(m, { p: { params: { limit: 1 } } })))
  add('proof over another id', 'bad-proof', req(w(m, { p: { id: 'n-2' } })))
  add('proof for another audience', 'bad-proof', req(w(m, { p: { audience: '0x' + '5f'.repeat(20) } })))
  add('proof.sig of 64 bytes', 'bad-proof', req(w(m, { proof: { ts: NOW, sig: '0x' + '11'.repeat(64) } })))
  add('id with a lone surrogate', 'bad-proof', req(w(m, { proof: g.signCallProof({ audience: ME.container, grantHash: g.grantHashOf(56, HUB, m), id: 'n-�', method: 'history', params: {}, ts: NOW }, CALLER_KEY) }), { id: 'n-\ud800' }))
  // 8 bad-user-signature (ECDSA only: no contract code at `user` in these vectors)
  add('userSig over the grant on chain 8453', 'bad-user-signature', req(w(m, { userSig: userSigOf(m, 8453) })))
  add('userSig high s', 'bad-user-signature', req(w(m, { userSig: highS(userSigOf(m)) })))
  add('userSig by the caller key', 'bad-user-signature', req(w(m, { userSig: sig.signDigest(g.grantDigest(56, HUB, m), CALLER_KEY) })))
  add('userSig v 0/1 (accepted for the visitor\'s signature)', null, req(w(m, { userSig: v01(userSigOf(m)) })))
  return out
}

async function reasonOf(c) {
  const r = c.request
  const v = await g.verifyVisitorGrant(r.grant, {
    chainId: 56, hub: HUB, me: ME, manifest: MANIFEST, method: r.method, id: r.id, params: r.params, voucherSent: false, now: r.now,
    store: g.memoryGrantStore({ clock: () => r.now }),
    chain: { holderOf: async () => { throw new Error('step 10 reached') }, resolveName: async () => null, isValidSignature: async () => false },
  }).catch((e) => ({ ok: false, reason: /step 10 reached/.test(e.message) ? null : `threw: ${e.message}` }))
  return v.ok === false ? v.reason : null
}

test('grant refusal vectors: the reference refuses every case for its reason at steps 1-8; the control cases reach step 10; the file is rebuilt byte for byte', async () => {
  const list = cases()
  for (const c of list) assert.equal(await reasonOf(c), c.reason, c.name)
  const doc = {
    note: 'Visitor grants (experimental prototype, TAPI-28; not a TAP): requests a service must refuse at the steps that need no chain read (TAPI-28 §3.10 steps 1-8, the order of the review branch 2026-10-22: 6 call proof, 7 replay, 8 visitor signature), each with its reason; reason null = passes steps 1-8. Fake keys (repeated bytes); 12.7.tape and 13.7.tape are example names. Companion of interop-visitor-grant.json, whose bytes are unchanged.',
    chainId: 56, hub: HUB, me: ME, manifest: MANIFEST, cases: list,
  }
  const text = JSON.stringify(doc, null, 2) + '\n'
  if (process.env.TAPEAPI_WRITE_VECTORS === '1') writeFileSync(FILE, text)
  assert.equal(readFileSync(FILE, 'utf8'), text, 'regenerate with TAPEAPI_WRITE_VECTORS=1 only when a case is added on purpose')
  assert.ok(list.filter((c) => c.reason).length >= 40)
})
