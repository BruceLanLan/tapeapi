// Independent adversarial audit of TAPI-26 (Tape Channel). Every test either demonstrates that an attack is refused
// ("CONFIRMED: ...") or demonstrates a defect ("FINDING <id>: ..."). FINDING tests PASS when the defect is present,
// so the suite stays green while documenting the current behaviour; each one says what a fixed build would do.
// Report: docs/AUDIT-tap26.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { x25519 } from '@noble/curves/ed25519'
import { chacha20poly1305 } from '@noble/ciphers/chacha'
import { randomBytes } from '@noble/hashes/utils'
import { TapeAPIError, createTapeAPI } from '../src/index.js'
import * as channel from '../src/channel.js'   // the implementation module, test hooks included / 实现模块，含测试钩子
import { createFakeChain, ADDR } from './helpers/fake-chain.mjs'
import { createRelayCore } from '../../examples/relay-service/relay-core.mjs'
import { RelayRoom } from '../../examples/cloudflare-worker/relay-room.js'

const {
  createInvite, acceptInvite, completeInvite, generateKeyPair, roomsFor, encodeWire, decodeWire, toBase64, fromBase64,
  _keySchedule, endpointBytes, relayTransport, toHex, fromHex, MAX_FRAME_BYTES,
} = channel

const A = { container: '0x86DDaEF00401E3F10418398D67D7189fc458eA95', chainId: 56 }
const B = { container: '0x19366c3c69ffeb3b286d9fa6cc5e616375baafd3', chainId: 56 }
const E = { container: '0x000000000000000000000000000000000000dEaD', chainId: 56 }
const NOW = Math.floor(Date.now() / 1000)   // real time: the responder now refuses a ready after exp
const te = new TextEncoder()
const invalid = (re) => (e) => e instanceof TapeAPIError && e.code === 'CHANNEL_INVALID' && (!re || re.test(e.message))
const cat = (...p) => { const o = new Uint8Array(p.reduce((a, x) => a + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length } return o }
const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b }
const dhRaw = (s, p) => x25519.getSharedSecret(s, p)

// Deterministic handshake: we keep copies of every secret so the test can recompute the keys an attacker would need.
function det({ now = NOW, ttlS = 600, self = A, peer = B } = {}) {
  const sA = randomBytes(32), sB = randomBytes(32), eA = randomBytes(32), eB = randomBytes(32), cid = randomBytes(16)
  const SA = x25519.getPublicKey(sA), SB = x25519.getPublicKey(sB), EA = x25519.getPublicKey(eA), EB = x25519.getPublicKey(eB)
  const initRand = [cid, eA].map((x) => x.slice()); let ir = 0
  const respRand = [eB.slice()]; let rr = 0
  const { invite, pending } = createInvite({ self: { ...self, staticSecret: sA }, peer: { ...peer, staticPublic: SB }, ttlS, now, random: () => initRand[ir++] })
  const { accept, session: bob } = acceptInvite({ self: { ...peer, staticSecret: sB }, peer: { ...self, staticPublic: SA }, invite, now, random: () => respRand[rr++] })
  const ks = _keySchedule({ cid, epA: endpointBytes(self.container, 56), epB: endpointBytes(peer.container, 56), SA, SB, EA, EB, exp: invite.exp, ih: channel.inviteHash(invite), dh1: dhRaw(eA, SB), dh2: dhRaw(sA, EB), dh3: dhRaw(eA, EB) })
  return { sA, sB, eA, eB, SA, SB, EA, EB, cid, invite, pending, accept, bob, ks, now }
}
function craft(key, cid, dir, seq, pt) {
  const aad = cat(te.encode('TAP-26/frame/v1'), cid, Uint8Array.of(dir), u64(seq))
  return cat(u64(seq), chacha20poly1305(key, cat(new Uint8Array(4), u64(seq)), aad).encrypt(pt))
}
function full(opts) {
  const h = det(opts)
  const { ready, session: alice } = completeInvite(h.pending, h.accept, { now: h.now })
  h.bob.confirm(ready)
  return { ...h, ready, alice }
}
// Build the accept an attacker would send given a guess for each DH (he knows some, must guess others).
function forgedAccept(h, EM, dh1, dh2, dh3, SBused = h.SB) {
  const ks = _keySchedule({ cid: h.cid, epA: endpointBytes(A.container), epB: endpointBytes(B.container), SA: h.SA, SB: SBused, EA: h.EA, EB: EM, exp: h.invite.exp, ih: channel.inviteHash(h.invite), dh1, dh2, dh3 })
  return { t: 'accept', cid: h.invite.cid, e: toHex(EM), confirm: toHex(ks.confirmB) }
}

// ===================================================================================== protocol: authentication ===

test('CONFIRMED KCI-1: with A\'s static secret leaked, Mallory still cannot pose as B to A', () => {
  const h = det()
  const m = generateKeyPair()
  // Mallory knows sA, EA (from the invite), SB, and his own eM. He can compute DH(sA,EM) and DH(eM,EA) exactly.
  // The one he lacks is DH(eA,SB): he has neither eA nor sB. Try every value he CAN compute in its place.
  const known = { dh2: dhRaw(h.sA, m.publicKey), dh3: dhRaw(m.secretKey, h.EA) }
  const guesses = [dhRaw(h.sA, h.SB), dhRaw(m.secretKey, h.SB), dhRaw(h.sA, h.EA), dhRaw(m.secretKey, h.EA), new Uint8Array(32)]
  for (const g of guesses) assert.throws(() => completeInvite(h.pending, forgedAccept(h, m.publicKey, g, known.dh2, known.dh3), { now: h.now }), invalid(/does not verify/))
  // Using sA as if it were B's secret through the SDK itself fails too.
  const { accept: viaSdk } = acceptInvite({ self: { ...B, staticSecret: h.sA }, peer: { ...A, staticPublic: h.SA }, invite: h.invite, now: h.now })
  assert.throws(() => completeInvite(h.pending, viaSdk, { now: h.now }), invalid(/does not verify/))
  // ... and none of those failed attempts consumed the pending state: the genuine accept still completes.
  assert.ok(completeInvite(h.pending, h.accept, { now: h.now }).session.confirmed)
})

test('CONFIRMED KCI-2: with B\'s static secret leaked, Mallory cannot pose as A to B (ready, and B\'s early frames)', () => {
  const sA = randomBytes(32), SA = x25519.getPublicKey(sA), sB = randomBytes(32), SB = x25519.getPublicKey(sB)
  const eM = randomBytes(32)
  // Mallory writes an invite "from A" with his own ephemeral, and holds sB.
  const { invite } = createInvite({ self: { ...A, staticSecret: randomBytes(32) }, peer: { ...B, staticPublic: SB }, now: NOW, random: (n) => (n === 32 ? eM.slice() : randomBytes(n)) })
  const { accept, session: bob } = acceptInvite({ self: { ...B, staticSecret: sB }, peer: { ...A, staticPublic: SA }, invite, now: NOW })
  const early = bob.seal('secret sent before ready')
  const EM = x25519.getPublicKey(eM), EB = fromHex(accept.e, 32)
  // Known to Mallory: DH(eM,SB) (=DH(sB,EM)), DH(eM,EB). Missing: DH(sA,EB) -- needs sA or eB.
  const dh1 = dhRaw(eM, SB), dh3 = dhRaw(eM, EB)
  const cid = fromHex(invite.cid, 16)
  for (const g of [dhRaw(sB, SA), dhRaw(eM, SA), dhRaw(sB, EB), dhRaw(eM, EB), new Uint8Array(32)]) {
    const ks = _keySchedule({ cid, epA: endpointBytes(A.container), epB: endpointBytes(B.container), SA, SB, EA: EM, EB, exp: invite.exp, ih: channel.inviteHash(invite), dh1, dh2: g, dh3 })
    assert.throws(() => bob.confirm({ t: 'ready', cid: invite.cid, confirm: toHex(ks.confirmA) }), invalid(/does not verify/))
    // nor can he read B's early frame with those keys
    assert.throws(() => chacha20poly1305(ks.kBA, cat(new Uint8Array(4), u64(0)), cat(te.encode('TAP-26/frame/v1'), cid, Uint8Array.of(1), u64(0))).decrypt(early.subarray(8)))
  }
  assert.equal(bob.confirmed, false)
})

test('CONFIRMED (expected): a leaked static secret lets the thief initiate as that container', () => {
  const h = det()
  // The thief holds sA and runs the initiator side himself: B completes a channel it believes is with A.
  const { invite, pending } = createInvite({ self: { ...A, staticSecret: h.sA }, peer: { ...B, staticPublic: h.SB }, now: NOW })
  const { accept, session: bob } = acceptInvite({ self: { ...B, staticSecret: h.sB }, peer: { ...A, staticPublic: h.SA }, invite, now: NOW })
  const { ready } = completeInvite(pending, accept, { now: NOW })
  bob.confirm(ready)
  assert.ok(bob.confirmed)
})

test('CONFIRMED UKS: Eve republishing A\'s static key as her own and relabelling A\'s invite as hers is caught', () => {
  const h = det()
  // B is told the invite comes from Eve (whose published key is SA). The invite itself names A, so the mismatch is
  // refused before any key is used. / 邀请本身写明来自 A，于是这种不一致在动用任何密钥之前就被拒绝。
  assert.throws(() => acceptInvite({ self: { ...B, staticSecret: h.sB }, peer: { ...E, staticPublic: h.SA }, invite: h.invite, now: h.now }), invalid(/invite.from/))
  // Eve rewrites `from` to herself: B now binds endpointE AND a different inviteHash, so A's confirm fails.
  // Eve 把 from 改成自己：B 于是绑定了 endpointE 和不同的 inviteHash，A 那边确认失败。
  const relabelled = { ...h.invite, from: { container: E.container, chainId: E.chainId ?? 56 } }
  const { accept } = acceptInvite({ self: { ...B, staticSecret: h.sB }, peer: { ...E, staticPublic: h.SA }, invite: relabelled, now: h.now })
  assert.throws(() => completeInvite(h.pending, accept, { now: h.now }), invalid(/does not verify/))
})

test('CONFIRMED misbinding: A\'s invite for B redirected to B2, which shares B\'s static key, fails at A', () => {
  const h = det()
  const B2 = { container: '0x2222222222222222222222222222222222222222', chainId: 56 }
  const { accept } = acceptInvite({ self: { ...B2, staticSecret: h.sB }, peer: { ...A, staticPublic: h.SA }, invite: h.invite, now: h.now })
  assert.throws(() => completeInvite(h.pending, accept, { now: h.now }), invalid(/does not verify/))
  // same container on another chain: the endpoint carries the chainId
  const { accept: other } = acceptInvite({ self: { ...B, chainId: 97, staticSecret: h.sB }, peer: { ...A, staticPublic: h.SA }, invite: h.invite, now: h.now })
  assert.throws(() => completeInvite(h.pending, other, { now: h.now }), invalid(/does not verify/))
})

test('CONFIRMED reflection: A\'s invite fed back to A as responder cannot complete', () => {
  const h = det()
  const { accept } = acceptInvite({ self: { ...A, staticSecret: h.sA }, peer: { ...A, staticPublic: h.SA }, invite: h.invite, now: h.now })
  assert.throws(() => completeInvite(h.pending, accept, { now: h.now }), invalid(/does not verify/))
})

test('CONFIRMED role confusion: accept.confirm used as ready.confirm, ready retyped as accept, both refused', () => {
  const h = det()
  assert.throws(() => h.bob.confirm({ t: 'ready', cid: h.accept.cid, confirm: h.accept.confirm }), invalid(/does not verify/))
  const { ready } = completeInvite(h.pending, h.accept, { now: h.now })
  const h2 = det()
  assert.throws(() => completeInvite(h2.pending, { t: 'accept', cid: h2.invite.cid, e: h2.accept.e, confirm: ready.confirm }, { now: h2.now }), invalid(/does not verify/))
  assert.throws(() => completeInvite(h2.pending, { ...h2.accept, t: 'ready' }, { now: h2.now }), invalid(/not an accept/))
})

test('CONFIRMED self-channel: a container talking to itself gets distinct directional keys; frames do not reflect', () => {
  const s = generateKeyPair()
  const { invite, pending } = createInvite({ self: { ...A, staticSecret: s.secretKey }, peer: { ...A, staticPublic: s.publicKey }, now: NOW })
  const { accept, session: resp } = acceptInvite({ self: { ...A, staticSecret: s.secretKey }, peer: { ...A, staticPublic: s.publicKey }, invite, now: NOW })
  const { ready, session: init } = completeInvite(pending, accept, { now: NOW })
  resp.confirm(ready)
  assert.throws(() => init.open(init.seal('mirror')), invalid(/authentication/))
  assert.throws(() => resp.open(resp.seal('mirror')), invalid(/authentication/))
  assert.equal(resp.open(init.seal('ok'), { text: true }).data, 'ok')
})

test('CONFIRMED transcript: every input and every role swap changes the keys (no omissions, roles bound)', () => {
  const h = det()
  const base = { cid: h.cid, epA: endpointBytes(A.container), epB: endpointBytes(B.container), SA: h.SA, SB: h.SB, EA: h.EA, EB: h.EB, exp: h.invite.exp, ih: channel.inviteHash(h.invite), dh1: dhRaw(h.eA, h.SB), dh2: dhRaw(h.sA, h.EB), dh3: dhRaw(h.eA, h.EB) }
  const k0 = _keySchedule(base)
  assert.deepEqual(k0.confirmB, fromHex(h.accept.confirm, 32), 'our independent recomputation matches the SDK')
  for (const f of ['cid', 'epA', 'epB', 'SA', 'SB', 'EA', 'EB', 'ih', 'dh1', 'dh2', 'dh3']) {   // ih: the invite hash is bound too / 邀请哈希也被绑定
    for (const pos of [0, base[f].length - 1]) {
      const alt = { ...base, [f]: base[f].map((x, i) => (i === pos ? x ^ 0x80 : x)) }
      assert.notDeepEqual(_keySchedule(alt).confirmA, k0.confirmA, `${f}[${pos}]`)
    }
  }
  for (const [x, y] of [['epA', 'epB'], ['SA', 'SB'], ['EA', 'EB'], ['dh1', 'dh2']]) {
    assert.notDeepEqual(_keySchedule({ ...base, [x]: base[y], [y]: base[x] }).kAB, k0.kAB, `swap ${x}/${y}`)
  }
  assert.notDeepEqual(_keySchedule({ ...base, exp: base.exp + 2 ** 32 }).kAB, k0.kAB, 'high bits of exp are bound')
})

// ===================================================================================== protocol: replay ===========

test('CONFIRMED replay: accept/ready across channels and after completion are refused', () => {
  const c1 = full(), c2 = det()
  assert.throws(() => completeInvite(c2.pending, c1.accept, { now: c2.now }), invalid(/different channel/))
  assert.throws(() => completeInvite(c2.pending, { ...c1.accept, cid: c2.invite.cid }, { now: c2.now }), invalid(/does not verify/))
  assert.throws(() => c2.bob.confirm(c1.ready), invalid(/different channel/))
  assert.throws(() => c2.bob.confirm({ ...c1.ready, cid: c2.invite.cid }), invalid(/does not verify/))
  assert.throws(() => completeInvite(c1.pending, c1.accept, { now: c1.now }), invalid(/already used|not an original handle/))
})

test('CONFIRMED stale invite: B re-accepting a replayed invite yields a session nobody can read or confirm', () => {
  const c = full()
  const { accept: again, session: bob2 } = acceptInvite({ self: { ...B, staticSecret: c.sB }, peer: { ...A, staticPublic: c.SA }, invite: c.invite, now: c.now })
  const early = bob2.seal('early data on the replayed invite')
  assert.throws(() => c.alice.open(early), invalid(/authentication/), 'A\'s real session has different keys')
  assert.throws(() => completeInvite(c.pending, again, { now: c.now }), invalid(/already used|not an original handle/))
  assert.throws(() => bob2.confirm(c.ready), invalid(/does not verify/), 'the old ready does not confirm the new session')
})

test('FIXED L-6: a responder that passes `seen` refuses an invite it has already accepted', () => {
  const h = det()
  const seen = new Set()
  const fresh = det()
  acceptInvite({ self: { ...B, staticSecret: fresh.sB }, peer: { ...A, staticPublic: fresh.SA }, invite: fresh.invite, now: fresh.now, seen })
  assert.ok(seen.has(fresh.invite.cid))
  assert.throws(() => acceptInvite({ self: { ...B, staticSecret: fresh.sB }, peer: { ...A, staticPublic: fresh.SA }, invite: fresh.invite, now: fresh.now, seen }), invalid(/already accepted/))
  assert.throws(() => acceptInvite({ self: { ...B, staticSecret: h.sB }, peer: { ...A, staticPublic: h.SA }, invite: h.invite, now: h.now, seen: ['x'] }), invalid(/must be a Set/))
})

// ===================================================================================== protocol: key checks =======

const LOW_ORDER = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
  '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
]
test('CONFIRMED: every canonical low-order point is refused as EA and as EB; non-canonical and top-bit keys too', () => {
  for (const lo of LOW_ORDER) {
    const h = det()
    assert.throws(() => acceptInvite({ self: { ...B, staticSecret: h.sB }, peer: { ...A, staticPublic: h.SA }, invite: { ...h.invite, e: lo }, now: h.now }), invalid(/low-order|failed/), `EA=${lo}`)
    assert.throws(() => completeInvite(h.pending, { ...h.accept, e: lo }, { now: h.now }), invalid(/low-order|failed/), `EB=${lo}`)
  }
  const h = det()
  assert.throws(() => completeInvite(h.pending, { ...h.accept, e: 'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f' }, { now: h.now }), invalid(/canonical/))
  assert.throws(() => completeInvite(h.pending, { ...h.accept, e: '00'.repeat(31) + '80' }, { now: h.now }), invalid(/top bit/))
})

test('FIXED I-4: createInvite refuses a low-order peer static key at once', () => {
  const s = generateKeyPair()
  assert.throws(() => createInvite({ self: { ...A, staticSecret: s.secretKey }, peer: { ...B, staticPublic: LOW_ORDER[0] }, now: NOW }), invalid(/low-order|failed/))
})

// ===================================================================================== protocol: forward secrecy ==

test('CONFIRMED FS: the ephemeral arrays actually used are zeroed, and no secret is reachable from any returned object', () => {
  const capI = [], capR = []
  const tap = (arr) => (n) => { const b = randomBytes(n); arr.push(b); return b }
  const sA = randomBytes(32), sB = randomBytes(32)
  const { invite, pending } = createInvite({ self: { ...A, staticSecret: sA }, peer: { ...B, staticPublic: x25519.getPublicKey(sB) }, now: NOW, random: tap(capI) })
  const eA = capI.find((b) => b.length === 32)
  const walk = (o, seen = new Set()) => { if (!o || typeof o !== 'object' || seen.has(o)) return []; seen.add(o); if (o instanceof Uint8Array) return [o]; return Object.values(o).flatMap((v) => walk(v, seen)) }
  assert.deepEqual(walk(pending), [], 'the pending handle carries no key material (audit M-3 fix)')
  const { accept, session: bob } = acceptInvite({ self: { ...B, staticSecret: sB }, peer: { ...A, staticPublic: x25519.getPublicKey(sA) }, invite, now: NOW, random: tap(capR) })
  assert.ok(capR[0].every((x) => x === 0), 'eB zeroed before acceptInvite returns')
  assert.ok(eA.some((x) => x !== 0), 'eA is (necessarily) live until an accept verifies')
  assert.throws(() => completeInvite(pending, { ...accept, confirm: '00'.repeat(32) }, { now: NOW }))
  assert.ok(eA.some((x) => x !== 0), 'a FAILED completion keeps eA (so the genuine accept can still complete)')
  const { session: alice } = completeInvite(pending, accept, { now: NOW })
  assert.ok(eA.every((x) => x === 0), 'eA zeroed on success')
  assert.deepEqual(walk(alice), []); assert.deepEqual(walk(bob), [])
  alice.close(); bob.close()
  assert.throws(() => alice.seal('x'), invalid(/closed/)); assert.throws(() => bob.open(new Uint8Array(40)), invalid(/closed/))
})

test('FIXED I-3: acceptInvite erases eB on the error path too', () => {
  const cap = []
  const s = generateKeyPair(), a = generateKeyPair()
  const { invite } = createInvite({ self: { ...A, staticSecret: a.secretKey }, peer: { ...B, staticPublic: s.publicKey }, now: NOW })
  assert.throws(() => acceptInvite({ self: { ...B, staticSecret: s.secretKey }, peer: { ...A, staticPublic: LOW_ORDER[1] }, invite, now: NOW, random: (n) => { const b = randomBytes(n); cap.push(b); return b } }))
  assert.ok(cap.length === 0 || cap[0].every((x) => x === 0), 'eB is zero after the throw (or was never drawn)')
})

test('FIXED M-3: a structured clone of pending carries no secret and cannot complete, so no nonce is ever reused', () => {
  const h = det()
  const copy = structuredClone(h.pending)
  assert.throws(() => completeInvite(copy, h.accept, { now: h.now }), invalid(/not an original handle/))
  const { session: s1 } = completeInvite(h.pending, h.accept, { now: h.now })
  assert.ok(s1.seal('only one session exists for this ephemeral'))
  assert.throws(() => completeInvite(copy, h.accept, { now: h.now }), invalid(/not an original handle/))
  assert.throws(() => completeInvite(JSON.parse(JSON.stringify(h.pending)), h.accept, { now: h.now }), invalid(/not an original handle/))
})

test('CONFIRMED: a SHALLOW copy of pending cannot complete at all (secrets live outside the handle)', () => {
  const h = det()
  const copy = { ...h.pending }
  completeInvite(h.pending, h.accept, { now: h.now })
  assert.throws(() => completeInvite(copy, h.accept, { now: h.now }), invalid(/not an original handle/))
})

// ===================================================================================== key confirmation ===========

test('CONFIRMED: both confirmation tags are checked over every byte, in both directions', () => {
  const h = det()
  for (let i = 0; i < 32; i++) {
    const bad = fromHex(h.accept.confirm, 32); bad[i] ^= 1
    assert.throws(() => completeInvite(h.pending, { ...h.accept, confirm: toHex(bad) }, { now: h.now }), invalid(/does not verify/))
  }
  const { ready } = completeInvite(h.pending, h.accept, { now: h.now })
  for (let i = 0; i < 32; i++) {
    const bad = fromHex(ready.confirm, 32); bad[i] ^= 0x80
    assert.throws(() => h.bob.confirm({ ...ready, confirm: toHex(bad) }), invalid(/does not verify/))
  }
  assert.throws(() => h.bob.confirm({ ...ready, confirm: ready.confirm.slice(0, 62) }), invalid(/32 bytes/))
  h.bob.confirm(ready); assert.ok(h.bob.confirmed)
})

test('CONFIRMED early responder frames: before ready, B refuses every inbound frame, even authentic ones', () => {
  const h = det()
  const authentic = craft(h.ks.kAB, h.cid, 0, 0, te.encode('hi'))
  assert.throws(() => h.bob.open(authentic), invalid(/has not confirmed/))
  const early = h.bob.seal('early')
  const { ready, session: alice } = completeInvite(h.pending, h.accept, { now: h.now })
  assert.equal(alice.open(early, { text: true }).data, 'early')
  h.bob.confirm(ready)
  assert.equal(h.bob.open(authentic, { text: true }).data, 'hi', 'the refused frame was not burned by the refusal')
})

// ===================================================================================== frames =====================

test('CONFIRMED: our independent frame construction matches the SDK (so crafted-frame tests below are meaningful)', () => {
  const c = full()
  assert.deepEqual(c.alice.seal('x'), craft(c.ks.kAB, c.cid, 0, 0, te.encode('x')))
  assert.deepEqual(c.bob.seal('y'), craft(c.ks.kBA, c.cid, 1, 0, te.encode('y')))
})

test('CONFIRMED: a failed open never advances recvHigh', () => {
  const c = full()
  const forged = cat(u64(1000), randomBytes(40))
  assert.throws(() => c.bob.open(forged), invalid(/authentication/))
  const wrongDir = craft(c.ks.kAB, c.cid, 1, 500, te.encode('wrong dir byte'))
  assert.throws(() => c.bob.open(wrongDir), invalid(/authentication/))
  const r = c.bob.open(craft(c.ks.kAB, c.cid, 0, 0, te.encode('first')), { text: true })
  assert.equal(r.seq, 0); assert.equal(r.skipped, 0)
})

test('CONFIRMED seq bounds: 2^32-1 is the last accepted seq; 2^32 and 2^64-1 are refused even when authentic', () => {
  const c = full()
  const top = c.bob.open(craft(c.ks.kAB, c.cid, 0, 2 ** 32 - 1, te.encode('last')), { text: true })
  assert.equal(top.seq, 4294967295); assert.equal(top.skipped, 4294967295)
  const c2 = full()
  assert.throws(() => c2.bob.open(craft(c2.ks.kAB, c2.cid, 0, 2n ** 32n, te.encode('x'))), invalid(/out of range/))
  assert.throws(() => c2.bob.open(craft(c2.ks.kAB, c2.cid, 0, 2n ** 64n - 1n, te.encode('x'))), invalid(/out of range/))
  assert.equal(c2.bob.open(craft(c2.ks.kAB, c2.cid, 0, 7, te.encode('x'))).skipped, 7, 'refusals did not move the counter')
  assert.equal(channel.MAX_SEQ, 2n ** 32n)
})

test('CONFIRMED: an authentic but oversize frame is refused; the maximum size and the empty frame round-trip', () => {
  const c = full()
  assert.throws(() => c.bob.open(craft(c.ks.kAB, c.cid, 0, 0, new Uint8Array(MAX_FRAME_BYTES + 1))), invalid(/too long/))
  assert.throws(() => c.alice.seal(new Uint8Array(MAX_FRAME_BYTES + 1)), invalid(/exceeds/))
  assert.equal(c.bob.open(c.alice.seal(new Uint8Array(MAX_FRAME_BYTES))).data.length, MAX_FRAME_BYTES)
  assert.equal(c.bob.open(c.alice.seal(new Uint8Array(0))).data.length, 0)
})

test('CONFIRMED: truncation, extension, cross-channel, cross-direction and wire-type confusion are refused', () => {
  const c = full(), d = full()
  const f = c.alice.seal('payload')
  assert.throws(() => c.bob.open(f.subarray(0, f.length - 1)), invalid(/authentication/))
  assert.throws(() => c.bob.open(cat(f, Uint8Array.of(0))), invalid(/authentication/))
  assert.throws(() => c.bob.open(f.subarray(0, 23)), invalid(/too short/))
  assert.throws(() => d.bob.open(f), invalid(/authentication/))
  assert.throws(() => c.bob.open(c.bob.seal('self')), invalid(/authentication/))
  // wire type byte is not authenticated, but flipping it only turns a frame into unparseable JSON or vice versa
  const w = encodeWire(f); w[0] = 0x01
  assert.throws(() => decodeWire(w), invalid(/not UTF-8 JSON|unknown handshake/))
  const hsw = encodeWire(c.ready); hsw[0] = 0x02
  assert.throws(() => c.bob.open(decodeWire(hsw).frame), invalid())
  assert.equal(c.bob.open(f, { text: true }).data, 'payload')
})

test('FIXED L-5: an authentic non-UTF-8 frame opened as text is refused WITHOUT consuming it, and opens as bytes', () => {
  const c = full()
  const f = craft(c.ks.kAB, c.cid, 0, 0, Uint8Array.of(0xff, 0xfe))
  assert.throws(() => c.bob.open(f, { text: true }), invalid(/not UTF-8/))
  assert.deepEqual(c.bob.open(f).data, Uint8Array.of(0xff, 0xfe), 'the same frame still opens as bytes')
  assert.throws(() => c.bob.open(f), invalid(/replayed/), 'and only then is it consumed')
})

// ===================================================================================== clocks =====================

test('CONFIRMED + FIXED L-4: exp tolerance window, and the responder bounds completion time by exp', () => {
  const s = generateKeyPair(), b = generateKeyPair()
  const { invite, pending } = createInvite({ self: { ...A, staticSecret: s.secretKey }, peer: { ...B, staticPublic: b.publicKey }, now: NOW, ttlS: 600 })
  const acc = (now) => acceptInvite({ self: { ...B, staticSecret: b.secretKey }, peer: { ...A, staticPublic: s.publicKey }, invite, now })
  assert.throws(() => acc(NOW - 3001), invalid(/further ahead/), 'B slow by >3000 s rejects a 600 s invite')
  assert.ok(acc(NOW - 3000))
  assert.ok(acc(NOW + 599))
  assert.throws(() => acc(NOW + 600), invalid(/expired/), 'B fast by >=ttl rejects')
  const { accept, session: bob } = acc(NOW)
  assert.throws(() => completeInvite(pending, accept, { now: NOW + 600 }), invalid(/expired/))
  const { ready } = completeInvite(pending, accept, { now: NOW + 599 })
  // FIXED L-4: the responder refuses a ready that arrives after the invite expired.
  assert.throws(() => bob.confirm(ready, { now: NOW + 601 }), invalid(/after the invite expired/))
  bob.confirm(ready, { now: NOW + 599 })
  assert.ok(bob.confirmed)
  for (const exp of [NOW + 0.5, String(NOW + 60), 2 ** 53, -1, null]) assert.throws(() => acceptInvite({ self: { ...B, staticSecret: b.secretKey }, peer: { ...A, staticPublic: s.publicKey }, invite: { ...invite, exp }, now: NOW }), invalid())
})

// ===================================================================================== interop ====================

test('FIXED L-3: cids are compared as bytes, and emitted in canonical lowercase', () => {
  const h = det()
  const upper = { ...h.invite, cid: h.invite.cid.toUpperCase() }
  // An uppercased invite hashes differently, so its keys differ from A's -- the channel id itself is not the problem.
  // 改成大写的邀请哈希不同，因此密钥与 A 的不同；问题不在通道号本身。
  const { accept } = acceptInvite({ self: { ...B, staticSecret: h.sB }, peer: { ...A, staticPublic: h.SA }, invite: upper, now: h.now })
  assert.equal(accept.cid, h.invite.cid, 'the responder emits the canonical lowercase form, not the text it was given')
  // An accept from a second implementation that uppercases or 0x-prefixes the cid is judged by its bytes.
  // 另一个实现把 cid 写成大写或加 0x，按字节判断。
  const { ready } = completeInvite(h.pending, { ...h.accept, cid: '0x' + h.accept.cid.toUpperCase() }, { now: h.now })
  assert.equal(ready.cid, h.invite.cid)
  h.bob.confirm({ ...ready, cid: '0x' + ready.cid.toUpperCase() }, { now: h.now })
  assert.ok(h.bob.confirmed)
})

test('FIXED L-2: relays are validated, and the whole invite is bound into the transcript, whatever path it took', () => {
  const h = det()
  const tooMany = Array.from({ length: 5 }, (_, i) => ({ url: `https://r${i}.example/tapeapi/v1` }))
  assert.throws(() => acceptInvite({ self: { ...B, staticSecret: h.sB }, peer: { ...A, staticPublic: h.SA }, invite: { ...h.invite, relays: tooMany }, now: h.now }), invalid(/at most 4/))
  assert.throws(() => acceptInvite({ self: { ...B, staticSecret: h.sB }, peer: { ...A, staticPublic: h.SA }, invite: { ...h.invite, relays: [{ url: 'ftp://x', container: '0x' + '11'.repeat(20) }] }, now: h.now }), invalid(/http/))
  assert.throws(() => acceptInvite({ self: { ...B, staticSecret: h.sB }, peer: { ...A, staticPublic: h.SA }, invite: { ...h.invite, relays: [{ url: 'https://x', container: 'nope' }] }, now: h.now }), invalid(/address/))
  // A relay list or SDP swapped in transit now changes the keys: A's completion fails.
  // 途中被换掉的中继列表或 SDP 现在会改变密钥：A 的完成步骤失败。
  for (const tampered of [{ ...h.invite, relays: [{ url: 'https://evil.example/tapeapi/v1', container: '0x' + '11'.repeat(20) }] }, { ...h.invite, webrtc: { sdp: 'attacker' } }]) {
    const r = acceptInvite({ self: { ...B, staticSecret: h.sB }, peer: { ...A, staticPublic: h.SA }, invite: tampered, now: h.now })
    assert.throws(() => completeInvite(h.pending, r.accept, { now: h.now }), invalid(/does not verify/))
  }
  assert.ok(completeInvite(h.pending, h.accept, { now: h.now }).session, 'the genuine accept still completes afterwards')
})

// ===================================================================================== relay core =================

const ROOM = (n) => n.toString(16).padStart(64, '0')

test('FIXED H-1: a re-created room carries a new epoch, and a client presenting the old epoch reads it from the start', async () => {
  let t = 0
  const core = createRelayCore({ now: () => t })
  const r = ROOM(1)
  for (let k = 0; k < 5; k++) core.send(r, 'AAAA')
  const first = await core.recv(r, -1, 0)
  const cursor = first.next, epoch = first.epoch
  assert.equal(cursor, 4); assert.match(epoch, /^[0-9a-f]{16}$/)
  t += 901_000; core.sweep()                   // idle 15 minutes (or: a Node relay restart)
  assert.equal(core.size, 0)
  const sent = core.send(r, 'BBBB')
  assert.equal(sent.i, 0, 'indices still restart in a new room ...')
  assert.notEqual(sent.epoch, epoch, '... but the room says it is a different room')
  const after = await core.recv(r, cursor, 0, epoch)
  assert.deepEqual(after.frames, [{ i: 0, frame: 'BBBB' }], 'the new frame is delivered to the client whose cursor was 4')
  assert.equal(after.epoch, sent.epoch)
  // Two RelayRoom instances that share no storage (a room re-created from nothing) have different epochs. An instance
  // recreated on the same storage keeps the epoch (FIXED RELAY-1, relay-persist.test.mjs).
  const room1 = new RelayRoom({}, {}), room2 = new RelayRoom({}, {})
  const post = (o, path, body) => o.fetch(new Request(`https://room${path}`, { method: 'POST', body: JSON.stringify(body) })).then((x) => x.json())
  const e1 = (await post(room1, '/send', { room: r, frame: 'AAAA' })).epoch
  const e2 = (await post(room2, '/send', { room: r, frame: 'AAAA' })).epoch
  assert.notEqual(e1, e2)
})

test('FIXED H-1 end to end: through relayTransport, a relay restart loses nothing sent after it', async () => {
  const c = full()
  let core = createRelayCore()
  const api = { call: async (_svc, method, p) => ({ result: method === 'relaySend' ? core.send(p.room, p.frame) : await core.recv(p.room, p.after, 0, p.epoch) }) }
  const bobLink = relayTransport({ api, svc: {}, inbound: c.bob.rooms.inbound, outbound: c.bob.rooms.outbound })
  const aliceLink = relayTransport({ api, svc: {}, inbound: c.alice.rooms.inbound, outbound: c.alice.rooms.outbound })
  for (let k = 0; k < 5; k++) await aliceLink.send(encodeWire(c.alice.seal(`pre ${k}`)))
  for (const w of await bobLink.poll(0)) c.bob.open(decodeWire(w).frame)
  assert.equal(bobLink.cursor, 4)
  core = createRelayCore()                          // relay process restarts (deploy, crash, OOM)
  for (let k = 0; k < 5; k++) await aliceLink.send(encodeWire(c.alice.seal(`post ${k}`)))
  const got = (await bobLink.poll(0)).map((w) => c.bob.open(decodeWire(w).frame, { text: true }))
  assert.deepEqual(got.map((x) => x.data), ['post 0', 'post 1', 'post 2', 'post 3', 'post 4'], 'every honest frame arrives')
  assert.ok(got.every((x) => x.skipped === 0), 'and the channel sees no gap')
})

test('FIXED M-1: long-polls do not create rooms, the number of held polls is capped, and sends keep working', async () => {
  const core = createRelayCore({ maxRooms: 3, maxWaitMs: 200, maxWaiters: 2 })
  const polls = [ROOM(10), ROOM(11), ROOM(12)].map((r) => core.recv(r, -1, 200))
  assert.equal(core.size, 0, 'no room was created by a poll')
  assert.equal(core.waiting, 2, 'only maxWaiters polls are held; the third answered at once')
  assert.equal(core.send(ROOM(99), 'AAAA').i, 0, 'a live channel can post its accept')
  await Promise.all(polls)
  assert.equal(core.waiting, 0)
})

test('FIXED M-2: a full relay keeps live rooms and refuses new ones; only expired rooms make space', async () => {
  let t = 0
  const core = createRelayCore({ maxRooms: 3, now: () => t })
  const live = ROOM(1)
  core.send(live, 'bGl2ZQ==')                        // a real channel's frame, its reader is between polls
  core.send(ROOM(50), 'AAAA'); core.send(ROOM(51), 'AAAA')
  assert.throws(() => core.send(ROOM(52), 'AAAA'), (e) => e.code === 'UNAVAILABLE', 'a 4th fresh room is refused')
  assert.deepEqual((await core.recv(live, -1, 0)).frames, [{ i: 0, frame: 'bGl2ZQ==' }], 'the live room kept its frame')
  t += 901_000                                       // now everything is idle past the TTL / 全部空闲超时
  assert.equal(core.send(ROOM(52), 'AAAA').i, 0, 'expired rooms are swept to make space')
})

test('CONFIRMED relay bounds: max valid wire fits maxFrameB64; larger/empty/non-base64 frames and bad params refused', async () => {
  const core = createRelayCore()
  const maxWire = new Uint8Array(1 + 8 + MAX_FRAME_BYTES + 16)
  assert.equal(core.send(ROOM(1), toBase64(maxWire)).i, 0)
  assert.throws(() => core.send(ROOM(1), 'A'.repeat(22_004)), (e) => e.code === 'BAD_REQUEST')
  for (const f of ['', 'A', '====', 'AA=A', 'AA==\n', 42]) assert.throws(() => core.send(ROOM(1), f), (e) => e.code === 'BAD_REQUEST', String(f))
  for (const bad of ['X'.repeat(64), ROOM(0xabcdef).toUpperCase(), '']) assert.throws(() => core.send(bad, 'AAAA'), (e) => e.code === 'BAD_REQUEST')
  await assert.rejects(core.recv(ROOM(1), -2, 0), (e) => e.code === 'BAD_REQUEST')
  await assert.rejects(core.recv(ROOM(1), 0.5, 0), (e) => e.code === 'BAD_REQUEST')
  await assert.rejects(core.recv(ROOM(1), 0, -1), (e) => e.code === 'BAD_REQUEST')
  const t0 = Date.now(); await createRelayCore({ maxWaitMs: 50 }).recv(ROOM(2), -1, 10_000_000); assert.ok(Date.now() - t0 < 1000, 'waitMs is capped')
  assert.equal(createRelayCore().size, 0)
  const c2 = createRelayCore(); await c2.recv(ROOM(3), -1, 0); assert.equal(c2.size, 0, 'a zero-wait recv creates nothing')
  const c3 = createRelayCore({ maxFramesPerRoom: 4 })
  for (let k = 0; k < 6; k++) c3.send(ROOM(4), 'AAAA')
  assert.deepEqual((await c3.recv(ROOM(4), -1, 0)).frames.map((f) => f.i), [2, 3, 4, 5], 'oldest dropped, indices keep increasing')
})

test('FIXED I-6: the Durable Object answers UNAVAILABLE with 503, not 400', async () => {
  const o = new RelayRoom({}, {})
  const post = (path, body) => o.fetch(new Request(`https://room${path}`, { method: 'POST', body: JSON.stringify(body) }))
  await post('/send', { room: ROOM(1), frame: 'AAAA' })
  const res = await post('/send', { room: ROOM(2), frame: 'AAAA' })   // a DO asked about a room other than its own
  assert.equal(res.status, 503); assert.equal((await res.json()).error.code, 'UNAVAILABLE')
  assert.equal((await post('/send', { room: 'NOT-HEX', frame: 'AAAA' })).status, 400, 'a caller error stays 400')
})

// ===================================================================================== relay transport ============

function fakeApi(batches) {
  const calls = []
  return { calls, call: async (_svc, method, params) => { calls.push({ method, params }); const b = batches.shift(); if (b instanceof Error) throw b; return { result: b ?? { frames: [] } } } }
}
const good = (s) => toBase64(encodeWire(te.encode(s)))

test('FIXED L-8: a malformed frame in a batch is skipped; the good frames on either side are delivered', async () => {
  const api = fakeApi([{ frames: [{ i: 0, frame: good('a') }, { i: 1, frame: '!!!!' }, { i: 2, frame: good('c') }] }, { frames: [] }])
  const link = relayTransport({ api, svc: {}, inbound: ROOM(1), outbound: ROOM(2) })
  const got = await link.poll(0)
  assert.equal(got.length, 2, 'frames 0 and 2 are delivered')
  assert.equal(link.cursor, 2)
  await link.poll(0)
  assert.equal(api.calls[1].params.after, 2)
})

test('FIXED L-8b: an onWire exception is reported and the rest of the batch is still delivered', async () => {
  const api = fakeApi([{ frames: [{ i: 0, frame: good('x') }, { i: 1, frame: good('y') }, { i: 2, frame: good('z') }] }])
  const link = relayTransport({ api, svc: {}, inbound: ROOM(1), outbound: ROOM(2), retryMs: 5 })
  const seen = [], errors = []
  await new Promise((resolve) => {
    link.start(async (w) => { seen.push(w.length); if (seen.length === 1) throw new Error('bad frame'); if (seen.length === 3) { link.stop(); resolve() } }, { onError: (e) => errors.push(e) })
  })
  assert.equal(seen.length, 3, 'frames 1 and 2 were handed to onWire after frame 0 threw')
  assert.equal(errors.length, 1)
})

test('FIXED L-1: stop() then start() while a poll is in flight leaves exactly one polling loop', async () => {
  let inflight = 0
  const gates = []
  const api = { call: (_s, _m, p) => { inflight++; return new Promise((res) => gates.push(() => { inflight--; res({ result: { frames: [] } }) })) } }
  const link = relayTransport({ api, svc: {}, inbound: ROOM(1), outbound: ROOM(2), retryMs: 1 })
  link.start(() => {})
  await new Promise((r) => setTimeout(r, 5))
  link.stop(); link.start(() => {})
  await new Promise((r) => setTimeout(r, 5))
  gates.shift()()                                       // the first (stopped) loop's poll returns
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(inflight, 1, 'the stopped loop exited instead of polling again')
  link.stop(); while (gates.length) gates.shift()()
  await new Promise((r) => setTimeout(r, 20)); while (gates.length) gates.shift()()
})

test('FIXED L-9: an onError that throws cannot kill the loop or the process', () => {
  const mod = pathToFileURL(fileURLToPath(new URL('../src/channel.js', import.meta.url))).href
  const script = `
    import { relayTransport } from ${JSON.stringify(mod)}
    let calls = 0
    const api = { call: async () => { calls++; throw new Error('relay down') } }
    const link = relayTransport({ api, svc: {}, inbound: '${ROOM(1)}', outbound: '${ROOM(2)}', retryMs: 5 })
    link.start(() => {}, { onError: () => { throw new Error('logger failed') } })
    setTimeout(() => { console.log('still alive after ' + calls + ' polls'); link.stop(); process.exit(0) }, 300)`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: fileURLToPath(new URL('..', import.meta.url)) })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /still alive after ([2-9]|\d{2,}) polls/, 'the loop kept retrying')
})

test('CONFIRMED/INFO: a malicious relay\'s replay, reorder, injection and cursor poisoning are caught or reduce to dropping', async () => {
  const c = full()
  const f0 = encodeWire(c.alice.seal('m0')), f1 = encodeWire(c.alice.seal('m1')), f2 = encodeWire(c.alice.seal('m2'))
  const api = fakeApi([
    { frames: [{ i: 5, frame: toBase64(f1) }, { i: 4, frame: toBase64(f0) }, { i: 6, frame: toBase64(f1) }, { i: 7, frame: toBase64(cat(Uint8Array.of(2), randomBytes(60))) }, { i: 'x', frame: toBase64(f2) }] },
    { frames: [{ i: Number.MAX_SAFE_INTEGER, frame: toBase64(f2) }] },
    { frames: [{ i: 8, frame: toBase64(f2) }] },
  ])
  const link = relayTransport({ api, svc: {}, inbound: c.bob.rooms.inbound, outbound: c.bob.rooms.outbound })
  const out = []
  for (const w of await link.poll(0)) { try { out.push(c.bob.open(decodeWire(w).frame, { text: true }).data) } catch (e) { out.push(e.code) } }
  assert.deepEqual(out, ['m1', 'CHANNEL_INVALID', 'CHANNEL_INVALID'], 'reordered i:4 dropped by cursor, replay and injection refused by the channel')
  const [w2] = await link.poll(0)
  assert.equal(c.bob.open(decodeWire(w2).frame, { text: true }).data, 'm2')
  assert.equal(link.cursor, Number.MAX_SAFE_INTEGER)
  assert.deepEqual(await link.poll(0), [], 'after cursor poisoning every later frame is ignored: equivalent to the relay dropping everything')
})

// ===================================================================================== identity lookup ============

test('CONFIRMED tapeSendKey: a non-6551 contract returning a crafted token() cannot borrow another container\'s key', async () => {
  const chain = createFakeChain()
  const api = createTapeAPI({ rpcUrls: ['http://rpc1', 'http://rpc2'], quorum: 2, hub: ADDR.hub, fetch: chain.fetch })
  const key = '0x' + toHex(generateKeyPair().publicKey)
  chain.setTapeSendKey(ADDR.container, { tokenId: 4246, key })
  const evil = '0x00000000000000000000000000000000000beef1'
  chain.state.tokens.set(evil, [56n, ADDR.circuits, 4246n])              // points at the victim's circuit
  await assert.rejects(api.chain.tapeSendKey(evil), (e) => e.code === 'CHANNEL_INVALID' && /derives/.test(e.message))
  // pointing at a fake circuits contract: the hub reports usable=false (DeWebHub checks _circuitsGenuine)
  const fakeCircuits = '0x00000000000000000000000000000000000c1c1c'
  chain.setTapeSendKey(evil, { circuits: fakeCircuits, tokenId: 1, key, usable: false })
  await assert.rejects(api.chain.tapeSendKey(evil), (e) => e.code === 'NOT_FOUND')
  // wrong chain configured on the client: the hub's endpoint embeds block.chainid, so the endpoint check fails
  const api97 = createTapeAPI({ chainId: 97, rpcUrls: ['http://rpc1', 'http://rpc2'], quorum: 2, hub: ADDR.hub, fetch: chain.fetch })
  await assert.rejects(api97.chain.tapeSendKey({ circuits: ADDR.circuits, tokenId: 4246 }), (e) => e.code === 'CHANNEL_INVALID' && /endpoint/.test(e.message))
  await assert.rejects(api97.chain.tapeSendKey(ADDR.container), (e) => e.code === 'CHANNEL_INVALID' && /chain 56/.test(e.message))
  for (const bad of ['0x123', 'x'.repeat(42), 42, null, { circuits: 'nope', tokenId: 1 }, { circuits: ADDR.circuits }]) {
    await assert.rejects(api.chain.tapeSendKey(bad), (e) => e.code === 'INVALID_ARGUMENT')
  }
})

test('CONFIRMED tapeSendKey -> channel: a hub key with top bit set or non-canonical is refused when used as peer', async () => {
  const chain = createFakeChain()
  const api = createTapeAPI({ rpcUrls: ['http://rpc1', 'http://rpc2'], quorum: 2, hub: ADDR.hub, fetch: chain.fetch })
  const s = generateKeyPair()
  for (const bad of ['0x' + 'ff'.repeat(32), '0xedffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f']) {
    chain.setTapeSendKey(ADDR.container, { tokenId: 4246, key: bad })
    const k = await api.chain.tapeSendKey(ADDR.container)
    assert.throws(() => createInvite({ self: { ...A, staticSecret: s.secretKey }, peer: k, now: NOW }), invalid(/top bit|canonical/))
  }
})
