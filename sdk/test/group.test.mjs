// TAP-27 Tape Group: a group over the chain alone, and every way it is supposed to refuse.
// TAP-27 群聊：只经链上完成一次群聊，以及它应当拒绝的每一种情形。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTapeAPI, channel, sig, TapeAPIError, CHANNEL_KEYS_KEY, canonicalJSON } from '../src/index.js'
// The implementation module: buildEpoch and senderKey are not in the public `group` namespace (review RC-7).
// 实现模块：buildEpoch 与 senderKey 不在公开的 group 命名空间里。
import * as G from '../src/group.js'
import { createRpc } from '../src/rpc.js'
import { createFakeChain, ADDR } from './helpers/fake-chain.mjs'

const RPC = ['http://rpc1', 'http://rpc2']
const BUS = '0x' + 'cb'.repeat(20)
const hex = (b) => '0x' + Buffer.from(b).toString('hex')
const nowS = () => Math.floor(Date.now() / 1000)
const C = (n) => '0x' + n.toString(16).padStart(40, '0')
const bad = (re) => (e) => e instanceof TapeAPIError && e.code === 'GROUP_INVALID' && re.test(e.message)

// A container with a circuit, a holder and a published channel identity / 有电路、持有人与已发布通道身份的容器
function member(chain, n) {
  const container = C(0xa000 + n)
  const holderKey = '0x' + (0x40 + n).toString(16).padStart(2, '0').repeat(32)
  chain.setContainerToken(container, { tokenId: n })
  chain.setAccount(n, container)
  chain.setOwner(n, sig.privateKeyToAddress(holderKey))
  const identity = channel.generateIdentity()
  const keys = { container, x25519: hex(identity.x25519.publicKey), ed25519: hex(identity.ed25519.publicKey), inbox: { bus: BUS }, issued: nowS() - 60, expires: nowS() + 86400 }
  const record = { tapechannel: '1', container, chainId: 56, ...keys, sig: sig.signDigest(sig.channelKeysDigest(56, ADDR.hub, keys), holderKey) }
  chain.writeFile(container, CHANNEL_KEYS_KEY, canonicalJSON(record))
  return { container, chainId: 56, identity, self: { container, chainId: 56, staticSecret: identity.x25519.secretKey } }
}
const entry = (m) => ({ container: m.container, chainId: 56, x25519: hex(m.identity.x25519.publicKey), ed25519: hex(m.identity.ed25519.publicKey) })

test('three containers, one group, nothing but the chain: invites to inboxes, a hidden roster, signed messages', async () => {
  const chain = createFakeChain()
  const api = createTapeAPI({ rpcUrls: RPC, quorum: 2, chainId: 56, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, fetch: chain.fetch })
  const rpc = createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch })
  const verifyMember = api.groupVerifier()
  const [A, B, Cm] = [member(chain, 1), member(chain, 2), member(chain, 3)]
  const start = chain.state.block
  const post = (room) => channel.busTransport({ rpc, bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx), fromBlock: start, confirmations: 0 })   // mines 1 block, reads at once (default is 2 since arch B13) / 出一块即读
  const read = (room) => channel.busTransport({ rpc, bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: start, confirmations: 0 })

  // The owner looks the others up on chain and creates the group / 群主从链上查出其他人并建群
  const others = await Promise.all([B, Cm].map((m) => api.chain.channelKeys(m.container)))
  const { group: owner, epochWire } = await G.createGroup({ self: A, identity: A.identity, members: others, bus: BUS, verifyMember })
  assert.equal(owner.epoch, 0)
  await post(owner.room).send(epochWire)
  for (const m of [B, Cm]) await post(channel.inboxRoom(m.container)).send(owner.inviteFor(entry(m)))
  chain.mine()

  // The roster is not in the clear: an observer of the room sees a count, not containers or keys
  // 名单不是明文：房间的旁观者只看到人数，看不到容器或密钥
  const onChain = Buffer.from(epochWire).toString('hex')
  for (const m of [A, B, Cm]) assert.ok(!onChain.includes(m.container.slice(2).toLowerCase()), 'no member address in the epoch message')

  // Each member opens its invite, looks the owner up ON CHAIN, joins and reads the epoch from the group room
  // 每个成员打开邀请、从链上查出群主、入群，并从群房间读取纪元消息
  const joined = []
  for (const m of [B, Cm]) {
    const [sealed] = await read(channel.inboxRoom(m.container)).poll()
    const inv = G.openGroupInvite(sealed, { self: m.self })
    const ownerKeys = await api.chain.channelKeys(inv.owner.container)
    const g = G.joinGroup({ self: m, identity: m.identity, invite: inv, ownerKeys })
    const [ew] = await read(g.room).poll()
    const { roster } = await g.acceptEpoch(ew, { verifyMember })
    assert.deepEqual(roster.members.map((x) => x.container.toLowerCase()), [A.container, B.container, Cm.container])
    joined.push(g)
  }
  const [gb, gc] = joined

  // Everyone talks; everyone learns who said what / 大家发言，每个人都知道是谁说的
  const wires = [owner.seal('hello from the owner'), gb.seal('hi, B here'), gc.seal('C too')]
  const got = (g, w) => g.open(w, { text: true })
  const seenByC = [wires[0], wires[1]].map((w) => got(gc, w))
  assert.deepEqual(seenByC.map((r) => [r.from.toLowerCase(), r.data]), [[A.container, 'hello from the owner'], [B.container, 'hi, B here']])
  assert.equal(got(gb, wires[0]).data, 'hello from the owner')
  const fromC = got(owner, wires[2])
  assert.equal(fromC.data, 'C too')
  assert.equal(fromC.from.toLowerCase(), Cm.container)
  const own = owner.open(wires[0])
  assert.equal(own.own, true, 'our own message comes back as own')
  assert.equal(own.epoch, 0)
})

// A small in-memory harness for the refusal tests (trusting rosters: key checks are tested above)
// 拒绝类测试用的小工具（信任名单：密钥核验已在上面测过）
async function trio() {
  const ids = [1, 2, 3].map(() => channel.generateIdentity())
  const ms = ids.map((identity, i) => ({ container: C(0xb000 + i), chainId: 56, identity }))
  const { group: owner, epochWire } = await G.createGroup({ self: ms[0], identity: ids[0], members: [entry(ms[1]), entry(ms[2])], bus: BUS, verifyMember: 'trust-roster' })
  const join = async (m, wire = epochWire) => {
    const g = G.joinGroup({ self: m, identity: m.identity, invite: { gid: owner.gid, owner: { container: ms[0].container, chainId: 56 } }, ownerKeys: { ...entry(ms[0]) } })
    await g.acceptEpoch(wire, { verifyMember: 'trust-roster' })
    return g
  }
  return { ms, owner, epochWire, join }
}

test('a removed member cannot read the next epoch; a new member cannot read the one before it joined', async () => {
  const { ms, owner, join } = await trio()
  const [gb, gc] = [await join(ms[1]), await join(ms[2])]
  const before = owner.seal('epoch 0, C can read this')
  assert.equal(gc.open(before, { text: true }).data, 'epoch 0, C can read this')
  const { epochWire: e1 } = await owner.removeMembers([ms[2].container])
  await gb.acceptEpoch(e1, { verifyMember: 'trust-roster' })
  await assert.rejects(gc.acceptEpoch(e1, { verifyMember: 'trust-roster' }), bad(/not a member/))
  const after = owner.seal('epoch 1, C must not read this')
  assert.equal(gb.open(after, { text: true }).data, 'epoch 1, C must not read this')
  assert.throws(() => gc.open(after), bad(/no key for epoch 1/))
  // D joins at epoch 2 and cannot read epoch 1 / D 在纪元 2 加入，读不到纪元 1
  const D = { container: C(0xbd00), chainId: 56, identity: channel.generateIdentity() }
  const { epochWire: e2 } = await owner.addMembers([entry(D)], { verifyMember: 'trust-roster' })
  const gd = await join(D, e2)
  assert.throws(() => gd.open(after), bad(/no key for epoch 1/))
  assert.equal(gd.open(owner.seal('welcome D'), { text: true }).data, 'welcome D')
})

test('forged, tampered and inconsistent epoch messages are refused', async () => {
  const { ms, owner, epochWire, join } = await trio()
  // not signed by the owner / 不是群主签的
  const eve = channel.generateIdentity()
  const forged = G.buildEpoch({ gid: Buffer.from(owner.gid, 'hex'), epoch: 5, issued: nowS(), prev: '00'.repeat(32), owner: { container: ms[0].container, chainId: 56 },
    members: [entry(ms[0]), entry(ms[1])], bus: BUS, ownerEdSecret: eve.ed25519.secretKey }).wire
  await assert.rejects(join(ms[1], forged), bad(/not signed by the owner/))
  // any flipped byte breaks the owner's signature / 任意改一个字节，群主签名即失效
  for (const at of [20, 90, 120, epochWire.length - 80]) {
    const t = Uint8Array.from(epochWire); t[at] ^= 1
    await assert.rejects(join(ms[1], t), bad(/signed by the owner|not an epoch|length|out of range/))
  }
  // the same epoch message again (the owner reposts it) is a quiet duplicate / 同一条纪元消息再来一次（群主重发）只是重复
  const gb = await join(ms[1])
  assert.equal((await gb.acceptEpoch(epochWire, { verifyMember: 'trust-roster' })).duplicate, true)
  // a roster naming a key its record does not carry is refused by the verifier / 名单里的密钥与记录不符，被核验器拒绝
  const { epochWire: e1 } = await owner.rotate()
  await assert.rejects(gb.acceptEpoch(e1, { verifyMember: async (m) => m.container !== ms[2].container }), bad(/do not match its channel record/))
  await assert.rejects(gb.acceptEpoch(e1, {}), bad(/verifyMember is required/))
  // an older epoch is refused once a newer one is held / 持有新纪元后，旧纪元被拒绝
  await gb.acceptEpoch(e1, { verifyMember: 'trust-roster' })
  const { epochWire: e2 } = await owner.rotate()
  await gb.acceptEpoch(e2, { verifyMember: 'trust-roster' })
  // an epoch it already accepted is a quiet duplicate; one it never saw is refused / 已接受过的旧纪元只是重复；没见过的被拒绝
  assert.equal((await gb.acceptEpoch(epochWire, { verifyMember: 'trust-roster' })).duplicate, true)
  const gd = await join(ms[2], e2)
  await assert.rejects(gd.acceptEpoch(e1, { verifyMember: 'trust-roster' }), bad(/not newer/))
  // an epoch message for another group / 别的群的纪元消息
  const other = await trio()
  await assert.rejects(gb.acceptEpoch(other.epochWire, { verifyMember: 'trust-roster' }), bad(/another group|signed by the owner/))
})

test('a malicious owner cannot hand members different keys: the signed commitment catches it', async () => {
  const { ms, owner, join } = await trio()
  const gb = await join(ms[1])
  // Build epoch 1, then swap B's wrapped key for one wrapping a different K, and re-sign as the owner.
  // 构造纪元 1，把 B 那格换成包裹另一把 K 的密钥，并以群主身份重新签名。
  const ownerId = { container: ms[0].container, chainId: 56 }
  const members = [entry(ms[0]), entry(ms[1]), entry(ms[2])]
  const gid = Buffer.from(owner.gid, 'hex')
  const honest = G.buildEpoch({ gid, epoch: 1, issued: nowS(), prev: '00'.repeat(32), owner: ownerId, members, bus: BUS, ownerEdSecret: ms[0].identity.ed25519.secretKey })
  const liar = G.buildEpoch({ gid, epoch: 1, issued: nowS(), prev: '00'.repeat(32), owner: ownerId, members, bus: BUS, ownerEdSecret: ms[0].identity.ed25519.secretKey })
  // same header except the wrap for member 1 comes from the other build; header E/N/commit differ, so re-assemble
  // with honest's header and liar's slot: the slot no longer decrypts under honest's E/N, or its K fails the commit
  const w = Uint8Array.from(honest.wire)
  w.set(liar.wire.slice(114 + 48, 114 + 96), 114 + 48)   // slot 1 (slots are 48 bytes) / 第 1 格（每格 48 字节）
  const { ed25519 } = await import('@noble/curves/ed25519')
  const body = w.slice(0, w.length - 64)
  w.set(ed25519.sign(new Uint8Array([...new TextEncoder().encode('TAP-27/epoch/v1'), ...body]), ms[0].identity.ed25519.secretKey), w.length - 64)
  await assert.rejects(gb.acceptEpoch(w, { verifyMember: 'trust-roster' }), bad(/not a member|commitment/))
})

test('replayed, reattributed and cross-group messages are refused; gaps are reported', async () => {
  const { ms, owner, join } = await trio()
  const [gb, gc] = [await join(ms[1]), await join(ms[2])]
  const m0 = gb.seal('one'), m1 = gb.seal('two'), m2 = gb.seal('three')
  assert.equal(gc.open(m0, { text: true }).gap, null, 'the first message from a sender has nothing to measure a gap against')
  assert.throws(() => gc.open(m0), bad(/already seen/))
  assert.equal(gc.open(m2, { text: true }).gap, 1, 'm1 was skipped: a gap of one')
  assert.throws(() => gc.open(m1), bad(/already seen/), 'late m1 is refused, not reordered in')
  // claim B's message came from the owner: the owner's key does not verify B's signature
  // 把 B 的消息改署为群主：群主的密钥验不过 B 的签名
  const re = Uint8Array.from(gb.seal('mine')); re.set([0, 0, 0, 0], 25)
  assert.throws(() => gc.open(re), bad(/not signed by member 0|own/))
  // the same message dropped into another group / 同一条消息扔进另一个群
  const other = await trio()
  const og = await other.join(other.ms[1])
  assert.throws(() => og.open(gb.seal('wrong group')), bad(/another group/))
  // a flipped ciphertext byte / 改动密文的一个字节
  const t = Uint8Array.from(gb.seal('intact')); t[40] ^= 1
  assert.throws(() => gc.open(t), bad(/not signed|authentication/))
})

test('messages still in flight from the previous epoch are read for ten minutes, then refused', async () => {
  const { ms, owner, join } = await trio()
  const gb = await join(ms[1])
  const late = owner.seal('sent just before the rotation')
  const { epochWire: e1 } = await owner.rotate()
  await gb.acceptEpoch(e1, { verifyMember: 'trust-roster' })
  assert.equal(gb.open(late, { text: true }).data, 'sent just before the rotation')
  const again = owner.seal('epoch 1')
  assert.equal(gb.open(again, { text: true }).epoch, 1)
  const stale = (await trio())
  const g2 = await stale.join(stale.ms[1])
  const old = stale.owner.seal('old')
  await g2.acceptEpoch((await stale.owner.rotate()).epochWire, { verifyMember: 'trust-roster' })
  const t0 = Date.now()
  g2._clock.now = () => t0 + G.KEEP_PREVIOUS_MS + 1
  assert.throws(() => g2.open(old), bad(/no key for epoch 0/))
})

test('limits: 32 members fit one wire message; 33 do not; the owner cannot be removed', async () => {
  const owner = { container: C(0xc000), chainId: 56, identity: channel.generateIdentity() }
  const many = Array.from({ length: 31 }, (_, i) => entry({ container: C(0xc001 + i), identity: channel.generateIdentity() }))
  const { group, epochWire } = await G.createGroup({ self: owner, identity: owner.identity, members: many, bus: BUS, verifyMember: 'trust-roster' })
  assert.ok(epochWire.length <= channel.CHANNELBUS_MAX_WIRE, `32 members: ${epochWire.length} bytes`)
  await assert.rejects(group.addMembers([entry({ container: C(0xcfff), identity: channel.generateIdentity() })], { verifyMember: 'trust-roster' }), bad(/at most 32/))
  await assert.rejects(group.removeMembers([owner.container]), bad(/owner cannot be removed/))
  assert.throws(() => group.seal(new Uint8Array(G.MAX_PLAINTEXT + 1)), bad(/exceeds/))
})
