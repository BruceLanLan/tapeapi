// 1.8.1: the `labels` option. TAPI-26 and TAPI-27 version 1 (labels TAP-26/…, TAP-27/…) are Stable (v1) and stay the
// default, byte for byte. Version 2 (spec/TAPI-26-v2.md, spec/TAPI-27-v2.md, Draft: labels tape-channel/…, tape-group/…,
// at the request of the TAPs editors) is opt-in with { labels: 'v2' } and becomes the default in 2.0.
// The labels are the version marker: invites carry none, so both sides are told the version, a mismatch fails closed,
// and where the SDK can tell that a message was made under the other version it says so (data.labels/peerLabels).
// 1.8.1：`labels` 选项。TAPI-26、TAPI-27 第 1 版（标签 TAP-26/…、TAP-27/…）为 Stable (v1)，仍是默认，逐字节不变。第 2 版
// （spec/TAPI-26-v2.md、spec/TAPI-27-v2.md，Draft：标签 tape-channel/…、tape-group/…，应 TAPs 编辑要求）以 { labels: 'v2' } 选用，
// 2.0 起成为默认。标签本身就是版本标记：邀请里没有版本，所以要告诉双方同一个版本；不一致时失败关闭，SDK 能看出消息出自另一版本时会明说。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { sha256 } from '@noble/hashes/sha256'
import * as channel from '../src/channel.js'
import * as G from '../src/group.js'
import { channel as pubChannel, group as pubGroup, deliverGroupUpdate, checkGroupInvites, TapeAPIError } from '../src/index.js'
import { createRelayCore, relayMethods } from '../../examples/relay-service/relay-core.mjs'

const root = new URL('../../', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')
const vec = (n) => JSON.parse(read(`spec/vectors/${n}`))
const OLD = /TAP-2[67]\//
// a v2 label, not the key kind 'tape-channel/v1' that both versions carry / v2 标签，而不是两个版本都有的密钥类别 'tape-channel/v1'
const NEW = /tape-channel\/[a-z]+\/|tape-group\//
const hx = (h) => channel.fromHex(h)
const hex = (b) => '0x' + Buffer.from(b).toString('hex')
const unhex = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'))
const TRUST = { verifyMember: 'trust-roster' }
const isCode = (code, re) => (e) => e instanceof TapeAPIError && e.code === code && (!re || re.test(e.message))
const mismatch = (code, mine, theirs) => (e) => isCode(code)(e) && e.data?.labels === mine && e.data?.peerLabels === theirs &&
  /both sides must pass the same `labels`/.test(e.message) && /never switches versions/.test(e.message)

// The v1 vector files as TapeAPI 1.8.0 wrote them (8eef619). / TapeAPI 1.8.0（8eef619）写出的 v1 向量文件。
const V1_FILES = {
  'tapi-26-channel.json': '9c3511b50055d33594f87f3c8f1112cab446c91a7382dedd94e68cd069eb2253',
  'tapi-26-identity.json': '18b9b585c43ed641e783b6d50b26b8170d47457841ecada464302b73e725d4b9',
  'tapi-27-group.json': '7b64ea8aa44f46f515f835507fd84885f56b9e02e07fef6bf9f51fddd692890b',
  'tapi-27-group-v2.json': 'f052fa986b82fddc5751e602013149b88f214f469d554251765b3111a8e3c4cb',
}
const SETS = {
  v1: { channel: 'tapi-26-channel.json', identity: 'tapi-26-identity.json', group: 'tapi-27-group.json', format2: 'tapi-27-group-v2.json' },
  v2: { channel: 'tapi-26-v2-channel.json', identity: 'tapi-26-v2-identity.json', group: 'tapi-27-v2-group.json', format2: 'tapi-27-v2-group-format2.json' },
}
// undefined = the default, which must be v1 / undefined 即默认，必须等于 v1
const MODES = [['default', undefined, 'v1'], ['v1', 'v1', 'v1'], ['v2', 'v2', 'v2']]
const opt = (labels) => (labels === undefined ? {} : { labels })

// The handshake of a channel vector file, replayed through the SDK / 经 SDK 重放通道向量文件中的握手
function replayChannel(v, labels) {
  const replay = (...chunks) => { let i = 0; return (n) => { const c = chunks[i++]; assert.equal(c.length, n); return c } }
  const A = { container: v.initiator.container, chainId: v.initiator.chainId }
  const B = { container: v.responder.container, chainId: v.responder.chainId }
  const NOW = 1789000000
  const { invite, pending } = channel.createInvite({
    self: { ...A, staticSecret: hx(v.initiator.staticSecret) }, peer: { ...B, staticPublic: v.responder.staticPublic },
    relays: v.invite.relays, ttlS: v.invite.exp - NOW, now: NOW, random: replay(hx(v.invite.cid), hx(v.initiator.ephemeralSecret)), ...opt(labels),
  })
  const { accept, session: bob } = channel.acceptInvite({
    self: { ...B, staticSecret: hx(v.responder.staticSecret) }, peer: { ...A, staticPublic: v.initiator.staticPublic },
    invite, now: NOW, random: replay(hx(v.responder.ephemeralSecret)), ...opt(labels),
  })
  const { ready, session: alice } = channel.completeInvite(pending, accept, { now: NOW })
  bob.confirm(ready, { now: NOW })
  return { invite, pending, accept, ready, alice, bob, A, B, NOW }
}

test('TAPI-1 §4.1: the v1 vector files are byte for byte those of 1.8.0 and carry only v1 labels; the v2 files carry only v2 labels', () => {
  for (const [f, sha] of Object.entries(V1_FILES)) {
    assert.equal(createHash('sha256').update(readFileSync(new URL(`spec/vectors/${f}`, root))).digest('hex'), sha, `${f} changed`)
    assert.ok(OLD.test(read(`spec/vectors/${f}`)) && !NEW.test(read(`spec/vectors/${f}`)), `${f}: v1 labels only`)
  }
  for (const f of Object.values(SETS.v2)) {
    const t = read(`spec/vectors/${f}`)
    assert.ok(NEW.test(t), `${f} carries v2 labels`)
    assert.equal(t.split('\n').findIndex((l) => OLD.test(l)), -1, `${f} carries a v1 label`)
  }
})

test('the SDK holds both label tables, prefix for prefix: v1 TAP-26/ and TAP-27/, v2 tape-channel/ and tape-group/, same suffixes', () => {
  const ch = read('sdk/src/channel.js'), gr = read('sdk/src/group.js')
  for (const s of ['inbox/v1', 'transcript/v1', 'keys/v1', 'confirm/initiator', 'confirm/responder', 'frame/v1', 'room/v1']) {
    assert.ok(ch.includes(`'TAP-26/${s}'`) && ch.includes(`'tape-channel/${s}'`), s)
  }
  for (const s of ['room/v1', 'epoch/v1', 'msg/v1', 'sender/v1', 'wrap/v1', 'commit/v1', 'epoch/v2', 'msg/v2', 'sender/v2', 'wrap/v2', 'commit/v2']) {
    assert.ok(gr.includes(`'TAP-27/${s}'`) && gr.includes(`'tape-group/${s}'`), s)
  }
  // nowhere else in the SDK: every other module goes through these tables / SDK 其他模块都经由这两张表
  for (const n of readdirSync(new URL('sdk/src/', root)).filter((x) => x.endsWith('.js') && x !== 'channel.js' && x !== 'group.js')) {
    const code = read(`sdk/src/${n}`).split('\n').filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
    assert.equal(code.findIndex((l) => OLD.test(l) || NEW.test(l)), -1, `sdk/src/${n} spells a label`)
  }
})

for (const [name, labels, set] of MODES) {
  test(`channel vectors, labels ${name}: the real handshake reproduces ${SETS[set].channel} value for value`, () => {
    const v = vec(SETS[set].channel)
    const { invite, pending, accept, ready, alice, bob } = replayChannel(v, labels)
    assert.deepEqual(invite, v.invite, 'the invite object is the same in both versions')
    assert.deepEqual(accept, v.accept); assert.deepEqual(ready, v.ready)
    assert.equal(alice.transcript, v.intermediate.transcript); assert.equal(bob.transcript, v.intermediate.transcript)
    assert.equal(pending.labels, set); assert.equal(alice.labels, set); assert.equal(bob.labels, set)
    assert.deepEqual(channel.roomsFor(invite.cid, opt(labels)), v.intermediate.rooms)
    assert.deepEqual(alice.rooms, { inbound: v.intermediate.rooms.toInitiator, outbound: v.intermediate.rooms.toResponder })
    for (const f of v.frames) {
      const [from, to] = f.from === 'initiator' ? [alice, bob] : [bob, alice]
      assert.equal(channel.toHex(from.seal(f.plaintext)), f.frame)
      assert.equal(to.open(hx(f.frame), { text: true }).data, f.plaintext)
    }
    const X = v.intermediate
    const ks = channel._keySchedule({
      cid: hx(v.invite.cid), epA: hx(X.endpointA), epB: hx(X.endpointB), SA: hx(v.initiator.staticPublic), SB: hx(v.responder.staticPublic),
      EA: hx(v.initiator.ephemeralPublic), EB: hx(v.responder.ephemeralPublic), exp: v.invite.exp, ih: hx(X.inviteHash),
      dh1: hx(X.dh1), dh2: hx(X.dh2), dh3: hx(X.dh3), ...opt(labels),
    })
    assert.deepEqual([channel.toHex(ks.th), channel.toHex(ks.kAB), channel.toHex(ks.kBA), channel.toHex(ks.confirmA), channel.toHex(ks.confirmB)],
      [X.transcript, X.kAB, X.kBA, X.confirmInitiator, X.confirmResponder])
  })

  test(`inbox room and sealed invite, labels ${name}: the SDK reproduces ${SETS[set].identity}`, () => {
    const v = vec(SETS[set].identity), s = v.sealedInvite
    assert.equal(channel.inboxRoom(v.inbox.container, v.inbox.chainId, opt(labels)), v.inbox.room)
    assert.equal(pubChannel.inboxRoom(v.inbox.container, v.inbox.chainId, opt(labels)), v.inbox.room, 'the public subpath takes the option too')
    const draws = [hx(s.ephemeralSecret), hx(s.nonce)]
    const wire = channel.sealInvite(s.invite, { to: { container: s.recipientContainer, chainId: s.recipientChainId, staticPublic: channel.publicKeyOf(hx(s.recipientSecret)) }, random: () => draws.shift(), ...opt(labels) })
    assert.equal(hex(wire), s.wire)
    const self = { container: s.recipientContainer, chainId: s.recipientChainId, staticSecret: hx(s.recipientSecret) }
    assert.deepEqual(channel.openInvite(hx(s.wire), { self, ...opt(labels) }), s.invite)
  })

  test(`group vectors, labels ${name}: the SDK reproduces ${SETS[set].group} (format 1) and ${SETS[set].format2} (format 2)`, async () => {
    const v = vec(SETS[set].group)
    const ids = v.members.map((m) => ({ container: m.container, chainId: 56, identity: { x25519: { secretKey: unhex(m.x25519Secret), publicKey: unhex(m.x25519) }, ed25519: { secretKey: unhex(m.ed25519Secret), publicKey: unhex(m.ed25519) } } }))
    const entry = (p) => ({ container: p.container, chainId: 56, x25519: hex(p.identity.x25519.publicKey), ed25519: hex(p.identity.ed25519.publicKey) })
    const draws = [unhex(v.K), unhex(v.ephemeralSecret), unhex(v.nonce)]
    const built = G.buildEpoch({ gid: unhex(v.gid), epoch: 0, issued: v.roster.issued, prev: v.roster.prev, owner: { container: ids[0].container, chainId: 56 }, members: ids.map(entry), relays: v.roster.relays, ownerEdSecret: ids[0].identity.ed25519.secretKey, random: () => draws.shift(), ...opt(labels) })
    assert.equal(hex(built.wire), v.epochWire)
    v.senderKeys.forEach((k, i) => assert.equal(hex(G.senderKey(unhex(v.K), unhex(v.gid), 0, i, opt(labels))), k))
    const m1 = G.joinGroup({ self: ids[1], identity: ids[1].identity, invite: { gid: v.gid.slice(2), owner: { container: ids[0].container, chainId: 56 } }, ownerKeys: entry(ids[0]), clock: () => v.roster.issued, ...opt(labels) })
    assert.equal(m1.labels, set)
    assert.equal(m1.room, G.groupRoom(v.gid.slice(2), opt(labels)))
    await m1.acceptEpoch(unhex(v.epochWire), TRUST)
    const m = v.messages[0]
    assert.equal(m1.open(unhex(m.wire), { text: true }).data, m.plaintext)

    const f2 = vec(SETS[set].format2)
    let prev = '00'.repeat(32)
    for (const ep of f2.epochs) {
      const d = [unhex(ep.K), unhex(ep.ephemeralSecret), unhex(ep.nonce)]
      const b = G.buildEpochV2({ gid: unhex(f2.gid), epoch: ep.epoch, issued: f2.issued, prev, owner: { container: ids[0].container, chainId: 56 }, members: ids.map(entry), relays: f2.relays, bus: f2.bus, ownerEdSecret: ids[0].identity.ed25519.secretKey, random: () => d.shift(), ...opt(labels) })
      assert.equal(hex(b.wire), ep.epochWire, `format 2 epoch ${ep.epoch}`)
      prev = Buffer.from(sha256(b.rosterBytes)).toString('hex')
    }
    f2.senderKeys.forEach((k, i) => assert.equal(hex(G.senderKeyV2(unhex(f2.epochs[1].K), unhex(f2.gid), 1, i, opt(labels))), k))
    const m2 = G.joinGroup({ self: ids[2], identity: ids[2].identity, invite: { gid: f2.gid.slice(2), owner: { container: ids[0].container, chainId: 56 }, format: 2 }, ownerKeys: entry(ids[0]), clock: () => f2.issued, ...opt(labels) })
    for (const ep of f2.epochs) await m2.acceptEpoch(unhex(ep.epochWire), TRUST)
    for (const msg of f2.messages) assert.equal(m2.open(unhex(msg.wire), { text: true }).data, msg.plaintext)
  })
}

test('v1 and v2 are different rooms everywhere, and explicit v1 equals the default', () => {
  const v = vec(SETS.v1.channel), id1 = vec(SETS.v1.identity), id2 = vec(SETS.v2.identity)
  assert.notDeepEqual(channel.roomsFor(v.invite.cid, { labels: 'v2' }), channel.roomsFor(v.invite.cid))
  assert.deepEqual(channel.roomsFor(v.invite.cid, { labels: 'v1' }), channel.roomsFor(v.invite.cid))
  assert.equal(id1.inbox.container, id2.inbox.container)
  assert.notEqual(id1.inbox.room, id2.inbox.room)
  assert.equal(channel.inboxRoom(id2.inbox.container, 56), id1.inbox.room, 'the default inbox room is v1')
  const gid = vec(SETS.v1.group).gid.slice(2)
  const want = (p) => createHash('sha256').update(Buffer.concat([Buffer.from(p), Buffer.from(gid, 'hex')])).digest('hex')
  assert.equal(G.groupRoom(gid), want('TAP-27/room/v1'))
  assert.equal(G.groupRoom(gid, { labels: 'v1' }), want('TAP-27/room/v1'))
  assert.equal(G.groupRoom(gid, { labels: 'v2' }), want('tape-group/room/v1'))
  assert.equal(pubGroup.groupRoom(gid, { labels: 'v2' }), want('tape-group/room/v1'))
})

test('a labels value other than v1 / v2 is INVALID_ARGUMENT, never read as v1', async () => {
  const bad = isCode('INVALID_ARGUMENT', /labels must be 'v1'.*or 'v2'/)
  const a = channel.generateIdentity(), b = channel.generateIdentity()
  const A = { container: '0x' + 'a1'.repeat(20), chainId: 56 }, B = { container: '0x' + 'b2'.repeat(20), chainId: 56 }
  for (const labels of ['V2', 2, 'tape-channel', null, '']) {
    assert.throws(() => channel.createInvite({ self: { ...A, staticSecret: a.x25519.secretKey }, peer: { ...B, staticPublic: b.x25519.publicKey }, labels }), bad, String(labels))
    assert.throws(() => channel.inboxRoom(A.container, 56, { labels }), bad)
    assert.throws(() => channel.roomsFor('00'.repeat(16), { labels }), bad)
    assert.throws(() => G.groupRoom('00'.repeat(16), { labels }), bad)
    await assert.rejects(G.createGroup({ self: A, identity: a, members: [], labels, ...TRUST }), bad)
    await assert.rejects(checkGroupInvites({ self: A, identity: a, relayClients: [{ api: { call: async () => ({}) }, service: { container: '0x' + '9c'.repeat(20) } }], labels }), bad)
  }
})

test('cross handshake v1 <-> v2: the initiator refuses the accept, names the version, and keeps its handle for a genuine accept', () => {
  const a = channel.generateIdentity(), b = channel.generateIdentity()
  const A = { container: '0x' + 'a1'.repeat(20), chainId: 56 }, B = { container: '0x' + 'b2'.repeat(20), chainId: 56 }
  for (const [mine, theirs] of [['v1', 'v2'], ['v2', 'v1'], [undefined, 'v2']]) {
    const me = mine ?? 'v1'
    const { invite, pending } = channel.createInvite({ self: { ...A, staticSecret: a.x25519.secretKey }, peer: { ...B, staticPublic: b.x25519.publicKey }, ...opt(mine) })
    const wrong = channel.acceptInvite({ self: { ...B, staticSecret: b.x25519.secretKey }, peer: { ...A, staticPublic: a.x25519.publicKey }, invite, labels: theirs })
    // the responder of the other version posts to other rooms: the initiator would not even see it there
    // 另一版本的响应方投到的是别的房间：发起方在那里根本看不到
    assert.notEqual(wrong.session.rooms.outbound, channel.roomsFor(invite.cid, opt(mine)).toInitiator)
    assert.throws(() => channel.completeInvite(pending, wrong.accept), mismatch('CHANNEL_INVALID', me, theirs))
    // nothing was consumed: the genuine accept still completes, under the initiator's version / 什么都没消耗：真的 accept 仍能完成
    const right = channel.acceptInvite({ self: { ...B, staticSecret: b.x25519.secretKey }, peer: { ...A, staticPublic: a.x25519.publicKey }, invite, ...opt(mine) })
    const { ready, session } = channel.completeInvite(pending, right.accept)
    right.session.confirm(ready)
    assert.equal(session.labels, me)
    assert.equal(right.session.open(session.seal('same version')).data.length, 12)
  }
})

test('cross handshake: a responder refuses a ready made under the other version and names it; a forged tag stays a generic failure', () => {
  // The two vector files share secrets, random draws and the invite object; only the labels differ.
  // 两份向量文件的秘密值、随机抽取与邀请对象都相同，只有标签不同。
  const v1 = vec(SETS.v1.channel), v2 = vec(SETS.v2.channel)
  assert.deepEqual(v1.invite, v2.invite)
  for (const [labels, other] of [['v1', v2], ['v2', v1]]) {
    const r = replayChannel(labels === 'v1' ? v1 : v2, labels)
    const replay = (c) => () => c
    const { session } = channel.acceptInvite({
      self: { ...r.B, staticSecret: hx(v1.responder.staticSecret) }, peer: { ...r.A, staticPublic: v1.initiator.staticPublic },
      invite: v1.invite, now: r.NOW, random: replay(hx(v1.responder.ephemeralSecret)), labels,
    })
    assert.throws(() => session.confirm(other.ready, { now: r.NOW }), mismatch('CHANNEL_INVALID', labels, labels === 'v1' ? 'v2' : 'v1'))
    assert.throws(() => session.confirm({ ...other.ready, confirm: '00'.repeat(32) }, { now: r.NOW }), isCode('CHANNEL_INVALID', /ready\.confirm does not verify/))
    assert.equal(session.confirmed, false)
    assert.throws(() => session.open(new Uint8Array(40)), isCode('CHANNEL_INVALID', /has not confirmed/), 'still refusing frames')
  }
})

// A sealed invite can come from anyone: its error says how it was sealed, never that the other version would be right.
// 密封邀请可以来自任何人：错误只说明它是怎样密封的，绝不暗示另一版本才是对的。
const sealedMismatch = (mine, theirs) => (e) => isCode('CHANNEL_INVALID')(e) && e.data?.labels === mine && e.data?.peerLabels === theirs &&
  /opens under the other label version/.test(e.message) && /no evidence that the sender is genuine/.test(e.message) && !/would match/.test(e.message)
test('sealed invites: a wire sealed under one version does not open under the other, and the error names the version', () => {
  const v1 = vec(SETS.v1.identity).sealedInvite, v2 = vec(SETS.v2.identity).sealedInvite
  const self = { container: v1.recipientContainer, chainId: v1.recipientChainId, staticSecret: hx(v1.recipientSecret) }
  assert.throws(() => channel.openFromInbox(hx(v2.wire), { self }), sealedMismatch('v1', 'v2'))
  assert.throws(() => channel.openInvite(hx(v2.wire), { self, labels: 'v1' }), sealedMismatch('v1', 'v2'))
  assert.throws(() => channel.openFromInbox(hx(v1.wire), { self, labels: 'v2' }), sealedMismatch('v2', 'v1'))
  assert.throws(() => G.openGroupInvite(hx(v1.wire), { self, labels: 'v2' }), sealedMismatch('v2', 'v1'))
  // a tampered wire is still the generic failure, under either version / 被篡改的消息在两个版本下都仍是笼统失败
  const t = hx(v2.wire); t[t.length - 1] ^= 1
  for (const labels of ['v1', 'v2']) assert.throws(() => channel.openFromInbox(t, { self, labels }), isCode('CHANNEL_INVALID', /does not open with this key/))
  // and someone else's key gets no version hint / 别人的密钥得不到版本提示
  const other = { ...self, staticSecret: channel.generateIdentity().x25519.secretKey }
  assert.throws(() => channel.openFromInbox(hx(v2.wire), { self: other }), isCode('CHANNEL_INVALID', /does not open with this key/))
})

// ---------------------------------------------------------------- groups ----
const C = (n) => '0x' + n.toString(16).padStart(40, '0')
function person(n) {
  const identity = channel.generateIdentity()
  const container = C(0xc000 + n)
  return { container, chainId: 56, identity, self: { container, chainId: 56 }, entry: { container, chainId: 56, x25519: hex(identity.x25519.publicKey), ed25519: hex(identity.ed25519.publicKey) } }
}
const relays = [{ url: 'https://relay.example/tapeapi/v1', container: '0x' + '9c'.repeat(20) }]

test('groups v1 <-> v2: a member of the other version refuses the epoch message and names the version; formats 1 and 2', async () => {
  for (const format of [1, 2]) {
    for (const [ownerLabels, memberLabels] of [['v2', 'v1'], ['v1', 'v2'], ['v2', undefined]]) {
      const o = person(1), m = person(2)
      const { group, epochWire } = await G.createGroup({ self: o.self, identity: o.identity, members: [m.entry], relays, format, ...opt(ownerLabels), ...TRUST })
      assert.equal(group.labels, ownerLabels)
      const inv = { gid: group.gid, owner: o.self, ...(format === 2 ? { format: 2 } : {}) }
      const g = G.joinGroup({ self: m.self, identity: m.identity, invite: inv, ownerKeys: o.entry, ...opt(memberLabels), ...TRUST })
      assert.notEqual(g.room, group.room, 'the other version reads another group room')
      await assert.rejects(g.acceptEpoch(epochWire, TRUST), mismatch('GROUP_INVALID', memberLabels ?? 'v1', ownerLabels), `format ${format}, ${ownerLabels} -> ${memberLabels}`)
      assert.equal(g.epoch, null)
      // the same member under the owner's version joins / 同一成员按群主的版本即可入群
      const ok = G.joinGroup({ self: m.self, identity: m.identity, invite: inv, ownerKeys: o.entry, labels: ownerLabels, ...TRUST })
      await ok.acceptEpoch(epochWire, TRUST)
      assert.equal(ok.open(group.seal('hi'), { text: true }).data, 'hi')
      // an epoch message signed by someone else is still the generic failure / 别人签的纪元消息仍是笼统失败
      const forged = epochWire.slice(); forged[forged.length - 1] ^= 1
      const g2 = G.joinGroup({ self: m.self, identity: m.identity, invite: inv, ownerKeys: o.entry, ...opt(memberLabels), ...TRUST })
      await assert.rejects(g2.acceptEpoch(forged, TRUST), isCode('GROUP_INVALID', /^epoch message is not signed by the owner$/))
    }
  }
})

test('groups: a v2 snapshot is v: 3 with labels v2 (older resumeGroup refuses it); resumeGroup keeps the version and refuses a switch', async () => {
  for (const format of [1, 2]) {
    const o = person(1), m = person(2)
    const v1 = await G.createGroup({ self: o.self, identity: o.identity, members: [m.entry], relays, format, ...TRUST })
    const s1 = JSON.parse(JSON.stringify(v1.group.snapshot()))
    assert.equal(s1.v, format === 2 ? 2 : 1, 'a v1 snapshot is unchanged'); assert.equal('labels' in s1, false)
    const v2 = await G.createGroup({ self: o.self, identity: o.identity, members: [m.entry], relays, format, labels: 'v2', ...TRUST })
    const s2 = JSON.parse(JSON.stringify(v2.group.snapshot()))
    assert.deepEqual([s2.v, s2.labels, s2.format], [3, 'v2', format])
    // 1.0.0 to 1.8.0 accept only v: 1 and v: 2 in resumeGroup, so they refuse s2 (as with GRP2-2) / 旧版只收 v: 1、v: 2
    assert.ok(s2.v !== 1 && s2.v !== 2)
    const r = await G.resumeGroup({ self: o.self, identity: o.identity, snapshot: s2, ...TRUST })
    assert.equal(r.group.labels, 'v2'); assert.equal(r.group.room, v2.group.room)
    const ok = G.joinGroup({ self: m.self, identity: m.identity, invite: { gid: v2.group.gid, owner: o.self, ...(format === 2 ? { format: 2 } : {}) }, ownerKeys: o.entry, labels: 'v2', ...TRUST })
    await ok.acceptEpoch(r.epochWire, TRUST)
    assert.equal((await G.resumeGroup({ self: o.self, identity: o.identity, snapshot: s2, labels: 'v2', ...TRUST })).group.labels, 'v2')
    await assert.rejects(G.resumeGroup({ self: o.self, identity: o.identity, snapshot: s2, labels: 'v1', ...TRUST }), (e) => isCode('GROUP_INVALID', /keeps its labels for life/)(e) && e.data?.peerLabels === 'v2')
    await assert.rejects(G.resumeGroup({ self: o.self, identity: o.identity, snapshot: s1, labels: 'v2', ...TRUST }), isCode('GROUP_INVALID', /keeps its labels for life/))
    assert.equal((await G.resumeGroup({ self: o.self, identity: o.identity, snapshot: s1, ...TRUST })).group.labels, 'v1')
    await assert.rejects(G.resumeGroup({ self: o.self, identity: o.identity, snapshot: { ...s2, labels: undefined }, ...TRUST }), isCode('GROUP_INVALID', /v: 3 snapshot/))
    await assert.rejects(G.resumeGroup({ self: o.self, identity: o.identity, snapshot: { ...s1, labels: 'v2' }, ...TRUST }), isCode('GROUP_INVALID', /only a v: 3 snapshot is of a v2 group/))
    // a v1 snapshot that says labels: 'v1' is read, as 1.8.0 read it (it ignored the member) / 写着 labels: 'v1' 的 v1 快照照常读取
    assert.equal((await G.resumeGroup({ self: o.self, identity: o.identity, snapshot: { ...s1, labels: 'v1' }, ...TRUST })).group.labels, 'v1')
  }
})

test('groups: deliverGroupUpdate posts a v2 group\'s invites to the v2 inbox rooms, and checkGroupInvites({ labels: \'v2\' }) finds them', async () => {
  const core = createRelayCore()
  const m = relayMethods(core)
  const api = { call: async (_s, method, params) => ({ result: await m[method](params, { clientIp: '10.0.0.1' }) }) }
  const relay = { api, service: { container: relays[0].container } }
  const o = person(1), mem = person(2)
  const created = await G.createGroup({ self: o.self, identity: o.identity, members: [mem.entry], relays, labels: 'v2', ...TRUST })
  const r = await deliverGroupUpdate({ group: created.group, update: created, relayClients: [relay] })
  assert.equal(r.ok, true)
  assert.equal(r.deliveries[0].room, channel.inboxRoom(mem.container, 56, { labels: 'v2' }))
  assert.notEqual(r.deliveries[0].room, channel.inboxRoom(mem.container, 56))
  assert.equal(r.deliveries[1].room, G.groupRoom(created.group.gid, { labels: 'v2' }))
  // a v1 reader looks in the v1 room and finds nothing; it never reads the v2 room / v1 读取方看 v1 房间，什么也没有
  const none = await checkGroupInvites({ self: mem.self, identity: mem.identity, relayClients: [relay] })
  assert.equal(none.invites.length, 0); assert.equal(none.room, channel.inboxRoom(mem.container, 56))
  const found = await checkGroupInvites({ self: mem.self, identity: mem.identity, relayClients: [relay], labels: 'v2' })
  assert.equal(found.invites.length, 1); assert.equal(found.room, r.deliveries[0].room)
  const g = G.joinGroup({ self: mem.self, identity: mem.identity, invite: found.invites[0].invite, ownerKeys: o.entry, labels: 'v2' })
  await g.acceptEpoch(created.epochWire, TRUST)
  assert.equal(g.open(created.group.seal('v2 group'), { text: true }).data, 'v2 group')
})

test('defaults: pending, session and group handles report labels v1; verify.py checks both versions', async () => {
  const v = vec(SETS.v1.channel)
  const { pending, alice, bob } = replayChannel(v, undefined)
  assert.deepEqual([pending.labels, alice.labels, bob.labels], ['v1', 'v1', 'v1'])
  const o = person(1)
  const { group } = await G.createGroup({ self: o.self, identity: o.identity, members: [], relays, ...TRUST })
  assert.equal(group.labels, 'v1')
  const py = read('spec/vectors/verify.py')
  for (const f of [...Object.values(SETS.v1), ...Object.values(SETS.v2)]) assert.ok(py.includes(`'${f}'`), f)
  assert.ok(py.includes("b'TAP-26/', b'TAP-27/'") && py.includes("b'tape-channel/', b'tape-group/'"))
})

test('specs: v1 stays Stable (v1) with a non-normative note; v2 is a Draft, an option from 1.8.1 and the default from 2.0', () => {
  for (const n of [26, 27]) {
    const v1 = read(`spec/TAPI-${n}.md`), v2 = read(`spec/TAPI-${n}-v2.md`)
    assert.match(v1, /^\| Status \| Stable \(v1\)/m, `TAPI-${n} v1 stays Stable (v1)`)
    assert.match(v1, new RegExp(`TAPI-${n} v2\\]\\(TAPI-${n}-v2\\.md\\)`), `TAPI-${n} v1 points to v2`)
    assert.match(v2, /^\| Status \| Draft \|$/m, `TAPI-${n} v2 is a Draft`)
    assert.match(v2, /^\| Implementation \| Implemented as an option \(2026-10-08, TapeAPI 1\.8\.1\)/m)
    assert.match(v2, /^\| Target \| Stable \(v2\) at TapeAPI 2\.0\.0, where it becomes the SDK's default/m)
    assert.doesNotMatch(v2, /implements this version only|not released|内部分支/i, `TAPI-${n} v2 no longer describes the hard switch`)
  }
})
