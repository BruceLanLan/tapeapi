// TAP-26 通道的密码学部分：握手、帧、以及每一种应当失败的方式。
// The cryptographic core of TAP-26: the handshake, frames, and every way each of them is supposed to fail.
import test from 'node:test'
import assert from 'node:assert/strict'
import { channel, TapeAPIError } from '../src/index.js'

const { createInvite, acceptInvite, completeInvite, generateKeyPair, roomsFor, encodeWire, decodeWire, toBase64, fromBase64, _keySchedule, endpointBytes } = channel
const A = { container: '0x86DDaEF00401E3F10418398D67D7189fc458eA95', chainId: 56 }
const B = { container: '0x19366c3c69ffeb3b286d9fa6cc5e616375baafd3', chainId: 56 }
const RELAY = [{ url: 'https://relay.example/tapeapi/v1', container: '0x3e1a3e1a3e1a3e1a3e1a3e1a3e1a3e1a3e1a3e1a' }]
const bad = (re) => (e) => e instanceof TapeAPIError && e.code === 'CHANNEL_INVALID' && re.test(e.message)

function keys() { return { a: generateKeyPair(), b: generateKeyPair() } }
function handshake(k = keys()) {
  const { invite, pending } = createInvite({ self: { ...A, staticSecret: k.a.secretKey }, peer: { ...B, staticPublic: k.b.publicKey }, relays: RELAY })
  const { accept, session: bob } = acceptInvite({ self: { ...B, staticSecret: k.b.secretKey }, peer: { ...A, staticPublic: k.a.publicKey }, invite })
  const { ready, session: alice } = completeInvite(pending, accept)
  bob.confirm(ready)
  return { k, invite, pending, accept, ready, alice, bob }
}

test('a full handshake gives both sides the same channel, and messages flow both ways', () => {
  const { alice, bob, invite } = handshake()
  assert.equal(invite.kind, 'tape.channel/invite')
  assert.equal(invite.v, 1, 'TapeSend decodes a non-"message" kind as unsupported rather than rejecting it, so this rides TapeSend unchanged')
  assert.equal(alice.transcript, bob.transcript)
  assert.equal(alice.cid, bob.cid)
  assert.deepEqual(alice.rooms.outbound, bob.rooms.inbound)
  assert.deepEqual(alice.rooms.inbound, bob.rooms.outbound)
  for (let i = 0; i < 50; i++) {
    assert.equal(bob.open(alice.seal(`a${i}`), { text: true }).data, `a${i}`)
    assert.equal(alice.open(bob.seal(`b${i}`), { text: true }).data, `b${i}`)
  }
  const bin = new Uint8Array(16 * 1024).map((_, i) => i & 0xff)
  assert.deepEqual(bob.open(alice.seal(bin)).data, bin, 'a full-size binary frame round-trips')
})

test('the responder may send at once, but refuses inbound frames until the initiator has confirmed', () => {
  const k = keys()
  const { invite, pending } = createInvite({ self: { ...A, staticSecret: k.a.secretKey }, peer: { ...B, staticPublic: k.b.publicKey } })
  const { accept, session: bob } = acceptInvite({ self: { ...B, staticSecret: k.b.secretKey }, peer: { ...A, staticPublic: k.a.publicKey }, invite })
  const early = bob.seal('sent with the accept')                 // 0.5 RTT saved; only A can read it / 省半个往返，只有 A 读得了
  const { ready, session: alice } = completeInvite(pending, accept)
  assert.equal(alice.open(early, { text: true }).data, 'sent with the accept')
  const f = alice.seal('hi')
  assert.throws(() => bob.open(f), bad(/has not confirmed/))
  bob.confirm(ready)
  assert.equal(bob.open(f, { text: true }).data, 'hi')
})

test('a man in the middle who swaps in his own ephemeral key is caught by the confirmation MAC', () => {
  const k = keys(), mallory = generateKeyPair()
  const { invite, pending } = createInvite({ self: { ...A, staticSecret: k.a.secretKey }, peer: { ...B, staticPublic: k.b.publicKey } })
  // Mallory does not hold B's static secret, so he answers with a key pair of his own.
  // Mallory 没有 B 的长期私钥，只能用自己的一对密钥来应答。
  const { accept: forged } = acceptInvite({ self: { ...B, staticSecret: mallory.secretKey }, peer: { ...A, staticPublic: k.a.publicKey }, invite })
  assert.throws(() => completeInvite(pending, forged), bad(/does not hold the static key/))
  // and a forged ready to B is caught the same way / 伪造给 B 的 ready 同样被拦下
  const { accept, session: bob } = acceptInvite({ self: { ...B, staticSecret: k.b.secretKey }, peer: { ...A, staticPublic: k.a.publicKey }, invite })
  assert.throws(() => bob.confirm({ t: 'ready', cid: accept.cid, confirm: '00'.repeat(32) }), bad(/does not hold the static key/))
})

test('an invite forged in the name of A cannot produce a working channel (the static-key DH authenticates A)', () => {
  const k = keys(), mallory = generateKeyPair()
  // Mallory writes an invite claiming to be A but signs nothing with A's key. B uses A's REAL published key.
  // Mallory 冒充 A 写了一份邀请，但他没有 A 的私钥。B 用的是 A 在链上发布的真实公钥。
  const { invite, pending } = createInvite({ self: { ...A, staticSecret: mallory.secretKey }, peer: { ...B, staticPublic: k.b.publicKey } })
  const { accept, session: bob } = acceptInvite({ self: { ...B, staticSecret: k.b.secretKey }, peer: { ...A, staticPublic: k.a.publicKey }, invite })
  // Mallory's own view of the keys disagrees with B's, so B's accept fails for him ...
  assert.throws(() => completeInvite(pending, accept), bad(/does not verify/))
  // ... and anything he sends B is refused / 他发给 B 的任何东西都被拒绝
  assert.throws(() => bob.confirm({ t: 'ready', cid: accept.cid, confirm: '11'.repeat(32) }), bad(/does not verify/))
})

test('replayed, duplicated, reordered, tampered, reflected and cross-channel frames are all refused', () => {
  const { alice, bob } = handshake()
  const f0 = alice.seal('zero'), f1 = alice.seal('one'), f2 = alice.seal('two')
  assert.equal(bob.open(f0, { text: true }).data, 'zero')
  assert.throws(() => bob.open(f0), bad(/replayed, duplicated or reordered/))
  assert.equal(bob.open(f2, { text: true }).skipped, 1, 'a lost frame is reported, not hidden')
  assert.throws(() => bob.open(f1), bad(/replayed, duplicated or reordered/), 'a late frame cannot rewind the counter')

  const t = alice.seal('tamper'); t[t.length - 1] ^= 1
  assert.throws(() => bob.open(t), bad(/failed authentication/))
  const s = alice.seal('seq'); s[7] ^= 1                          // bump the sequence number / 改序号
  assert.throws(() => bob.open(s), bad(/failed authentication/), 'the sequence number is authenticated')

  // Reflection: A's own frame fed back to A. Different key and direction byte, so it cannot open.
  // 反射：把 A 自己发出的帧送回给 A。密钥和方向字节都不同，打不开。
  assert.throws(() => alice.open(alice.seal('mirror')), bad(/failed authentication/))

  const other = handshake()
  assert.throws(() => other.bob.open(alice.seal('wrong channel')), bad(/failed authentication/))
})

test('expired, far-future and malformed invites are refused, and keys are validated', () => {
  const k = keys()
  const mk = (over = {}) => createInvite({ self: { ...A, staticSecret: k.a.secretKey }, peer: { ...B, staticPublic: k.b.publicKey }, ...over })
  const accept = (invite, extra) => acceptInvite({ self: { ...B, staticSecret: k.b.secretKey }, peer: { ...A, staticPublic: k.a.publicKey }, invite, ...extra })
  const { invite } = mk()
  assert.throws(() => accept(invite, { now: invite.exp }), bad(/expired/))
  assert.throws(() => accept({ ...invite, exp: Math.floor(Date.now() / 1000) + 99999 }), bad(/further ahead/))
  assert.throws(() => accept({ ...invite, kind: 'message' }), bad(/not a TAP-26 invite/))
  assert.throws(() => accept({ ...invite, cid: 'zz' }), bad(/not hex/))
  // a low-order point: every DH with it is a known value / 低阶点：与它做的每一次 DH 都是已知值
  const lowOrder = 'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800'
  assert.throws(() => accept({ ...invite, e: lowOrder }), bad(/low-order|failed/))
  assert.throws(() => accept({ ...invite, e: 'ff'.repeat(32) }), bad(/top bit|canonical/))
  assert.throws(() => mk({ ttlS: 5 }), bad(/ttlS/))
  assert.throws(() => mk({ relays: [{ url: 'ftp://x' }] }), bad(/http/))
})

test('a completed pending state cannot be reused, and a closed session refuses everything', () => {
  const { pending, accept, alice } = handshake()
  assert.throws(() => completeInvite(pending, accept), bad(/already used|not an original handle/))
  alice.close()
  assert.throws(() => alice.seal('x'), bad(/closed/))
})

test('rooms are unguessable without the channel id, differ by direction, and reveal no identity', () => {
  const { alice } = handshake()
  const r = roomsFor(alice.cid)
  assert.notEqual(r.toInitiator, r.toResponder)
  assert.match(r.toInitiator, /^[0-9a-f]{64}$/)
  assert.ok(!r.toInitiator.includes(A.container.slice(2).toLowerCase()))
})

test('wire encoding carries handshake messages and frames through one relay room', () => {
  const { alice, bob, accept, ready } = handshake()
  const roundTrip = (x) => decodeWire(fromBase64(toBase64(encodeWire(x))))
  assert.deepEqual(roundTrip(accept).handshake, accept)
  assert.deepEqual(roundTrip(ready).handshake, ready)
  assert.equal(bob.open(roundTrip(alice.seal('via wire')).frame, { text: true }).data, 'via wire')
  assert.throws(() => decodeWire(Uint8Array.of(9)), bad(/unknown wire type/))
})

test('the key schedule is symmetric and every input changes the keys', () => {
  const r = (n) => new Uint8Array(n).map((_, i) => (i * 7 + n) & 0xff)
  const base = { cid: r(16), epA: endpointBytes(A.container), epB: endpointBytes(B.container), SA: r(32), SB: r(33).slice(1), EA: r(34).slice(2), EB: r(35).slice(3), exp: 1789000000, ih: r(39).slice(7), dh1: r(36).slice(4), dh2: r(37).slice(5), dh3: r(38).slice(6) }
  const ks = _keySchedule(base)
  for (const f of ['cid', 'epA', 'epB', 'SA', 'SB', 'EA', 'EB', 'ih', 'dh1', 'dh2', 'dh3']) {
    const alt = { ...base, [f]: base[f].map((x, i) => (i === 0 ? x ^ 1 : x)) }
    assert.notDeepEqual(_keySchedule(alt).kAB, ks.kAB, `${f} must be bound into the keys`)
  }
  assert.notDeepEqual(_keySchedule({ ...base, exp: base.exp + 1 }).kAB, ks.kAB, 'exp must be bound into the keys')
  assert.notDeepEqual(ks.kAB, ks.kBA, 'the two directions never share a key')
})

test('D22: relays must be https (http only on loopback), and handshake messages get the strict parser', async () => {
  const k = keys()
  const base = (relays) => () => createInvite({ self: { ...A, staticSecret: k.a.secretKey }, peer: { ...B, staticPublic: k.b.publicKey }, relays })
  assert.throws(base([{ url: 'http://relay.example/tapeapi/v1', container: '0x3e1a3e1a3e1a3e1a3e1a3e1a3e1a3e1a3e1a3e1a' }]), /https/)
  assert.ok(base([{ url: 'http://127.0.0.1:8788/tapeapi/v1', container: '0x3e1a3e1a3e1a3e1a3e1a3e1a3e1a3e1a3e1a3e1a' }])())
  assert.ok(base([{ url: 'https://relay.example/tapeapi/v1', container: '0x3e1a3e1a3e1a3e1a3e1a3e1a3e1a3e1a3e1a3e1a' }])())
  const wire = (json) => new Uint8Array([0x01, ...new TextEncoder().encode(json)])
  assert.throws(() => decodeWire(wire('{"t":"accept","t":"ready"}')), /duplicate or prototype/)
  assert.throws(() => decodeWire(wire('{"t":"accept","__proto__":{"x":1}}')), /duplicate or prototype/)
  assert.throws(() => decodeWire(new Uint8Array([0x01, 0x7b, 0xff, 0x7d])), /not UTF-8/)
})
