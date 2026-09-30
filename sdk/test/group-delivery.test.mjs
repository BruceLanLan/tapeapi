// TAPI-27 delivery in one call: deliverGroupUpdate (owner) and checkGroupInvites (member), over the reference relay's
// in-memory core. Covers the four ways an application lost its invites (TAPQQ, 2026-09-28): the wallet or a wrong
// chainId instead of the container, a cursor from another room without its epoch, a relay that forgot an idle room,
// and the per-source limit on invites / epoch messages.
// TAPI-27 一步投递：群主端 deliverGroupUpdate、成员端 checkGroupInvites，基于参考中继的内存核心。覆盖应用丢失邀请的
// 四种方式：用了钱包地址或错的 chainId、拿别的房间的游标又不带 epoch、中继遗忘空闲房间、按来源的邀请 / 纪元消息限流。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { channel, group as G, deliverGroupUpdate, checkGroupInvites, TapeAPIError } from '../src/index.js'
import { toBase64 } from '../src/channel.js'   // a test helper, not public / 测试辅助，非公开
import { decodeCall } from '../src/abi.js'
import { createRelayCore, relayMethods } from '../../examples/relay-service/relay-core.mjs'

const hex = (b) => '0x' + Buffer.from(b).toString('hex')
const C = (n) => '0x' + n.toString(16).padStart(40, '0')
const SVC = { container: '0x' + '9c'.repeat(20) }
const SVC2 = { container: '0x' + '7d'.repeat(20) }
const TRUST = { verifyMember: 'trust-roster' }
const delivery = (re) => (e) => e instanceof TapeAPIError && e.code === 'GROUP_DELIVERY' && re.test(e.message)
const invalid = (re) => (e) => e instanceof TapeAPIError && e.code === 'INVALID_ARGUMENT' && re.test(e.message)

// A TapeAPI-shaped client over the relay core: the core sees the caller's IP as the source, as the provider runtime vouches it.
// 形如 TapeAPI 客户端、背后是中继核心：核心把调用方 IP 当作来源，与运行时的担保一致。
function relayApi(core, { ip = '10.0.0.1' } = {}) {
  const m = relayMethods(core)
  const calls = []
  return { calls, call: async (_svc, method, params) => { calls.push({ method, params }); return { result: await m[method](params, { clientIp: ip }) } } }
}
function person(n, chainId = 56) {
  const identity = channel.generateIdentity()
  const container = C(0xc000 + n)
  return {
    container, chainId, identity, wallet: C(0xe000 + n),
    entry: { container, chainId, x25519: hex(identity.x25519.publicKey), ed25519: hex(identity.ed25519.publicKey) },
    self: { container, chainId },
  }
}
async function setup(nMembers = 2, coreOpts = {}) {
  const core = createRelayCore(coreOpts)
  const api = relayApi(core)
  const owner = person(1)
  const members = Array.from({ length: nMembers }, (_, i) => person(2 + i))
  const created = await G.createGroup({ self: owner.self, identity: owner.identity, members: members.map((m) => m.entry), relays: [{ url: 'https://relay.example/tapeapi/v1', container: SVC.container }], ...TRUST })
  return { core, api, owner, members, created, group: created.group, relay: { api, service: SVC } }
}
// A member joins from an invite and reads the group room / 成员凭邀请入群并读取群房间
async function join(m, invite, owner, relay) {
  assert.equal(invite.owner.container, owner.container.toLowerCase())
  const g = G.joinGroup({ self: m.self, identity: m.identity, invite, ownerKeys: owner.entry })
  const link = channel.relayTransport({ api: relay.api, service: relay.service, inbound: g.room, outbound: g.room, waitMs: 0 })
  // Older epoch messages in the group room do not open with a new member's key: refused, and the next one is tried
  // 群房间里更早的纪元消息打不开（新成员的密钥不在其中）：拒绝后继续下一条
  const refused = []
  for (const w of await link.poll()) if (w[0] === 0x04) await g.acceptEpoch(w, TRUST).catch((e) => refused.push(e.message))
  return { g, link, refused }
}

test('owner: one call posts each invite to the member\'s INBOX room and the epoch message to the GROUP room, and reports every post', async () => {
  const { core, owner, members, created, group, relay } = await setup(2)
  assert.deepEqual(created.added.map((m) => m.container), members.map((m) => m.container.toLowerCase()), 'createGroup says who is new')
  assert.equal(created.epoch, 0)
  assert.equal(group.epochWire, created.epochWire, 'the owner handle keeps the latest epoch message for reposts')

  const r = await deliverGroupUpdate({ group, update: created, relayClients: [relay] })
  assert.equal(r.ok, true)
  assert.equal(r.groupEpoch, 0)
  assert.equal(r.room, group.room)
  assert.deepEqual(r.deliveries.map((d) => d.what), ['invite', 'invite', 'epoch'], 'invites first, then the epoch message (§3.5)')
  for (const [k, m] of members.entries()) {
    const d = r.deliveries[k]
    assert.equal(d.room, channel.inboxRoom(m.container, 56), 'the invite went to the container\'s inbox room')
    assert.notEqual(d.room, group.room)
    assert.equal(d.container, m.container.toLowerCase()); assert.equal(d.chainId, 56)
    assert.equal(d.via, 'relay'); assert.equal(d.relay, SVC.container)
    assert.equal(d.i, 0); assert.match(d.epoch, /^[0-9a-f]+$/, 'the relay\'s { i, epoch } is reported')
  }
  assert.equal(r.deliveries[2].room, group.room)

  // Each member finds its invite, joins, and the three talk / 每个成员找到邀请、入群，三方对话
  const joined = []
  for (const m of members) {
    const found = await checkGroupInvites({ self: m.self, identity: m.identity, relayClients: [relay] })
    assert.equal(found.ok, true)
    assert.equal(found.room, r.deliveries[members.indexOf(m)].room, 'the member reads the room the owner posted to')
    assert.equal(found.invites.length, 1); assert.equal(found.skipped, 0)
    assert.equal(found.invites[0].invite.gid, group.gid)
    joined.push(await join(m, found.invites[0].invite, owner, relay))
  }
  for (const { g } of joined) assert.equal(g.epoch, 0)
  const ownerLink = channel.relayTransport({ api: relay.api, service: relay.service, inbound: group.room, outbound: group.room, waitMs: 0 })
  await ownerLink.send(group.seal('hello from the owner'))
  await joined[0].link.send(joined[0].g.seal('hello from member 1'))
  const heard = []
  for (const w of await joined[1].link.poll()) if (w[0] === 0x05) heard.push(joined[1].g.open(w, { text: true }).data)
  assert.deepEqual(heard, ['hello from the owner', 'hello from member 1'])
  assert.ok(core.dump().every((f) => !Buffer.from(f, 'base64').toString('latin1').includes('hello')), 'the relay holds no plaintext')
})

test('addMembers says who is new; the default invites only them, and a member\'s cursor store means an invite is seen once', async () => {
  const { owner, members, group, created, relay } = await setup(1)
  await deliverGroupUpdate({ group, update: created, relayClients: [relay] })
  const cursors = new Map()
  const [m1] = members
  assert.equal((await checkGroupInvites({ self: m1.self, identity: m1.identity, relayClients: [relay], cursors })).invites.length, 1)
  assert.equal((await checkGroupInvites({ self: m1.self, identity: m1.identity, relayClients: [relay], cursors })).invites.length, 0, 'seen once per cursor store')
  const [key] = cursors.keys()
  assert.equal(key, `relay:${SVC.container}:${channel.inboxRoom(m1.container, 56)}`, 'one cursor per relay and room')
  assert.equal(cursors.get(key).after, 0); assert.match(cursors.get(key).epoch, /^[0-9a-f]+$/, 'the cursor carries the relay\'s room epoch')

  const m2 = person(9)
  const up = await group.addMembers([m2.entry], TRUST)
  assert.equal(up.epoch, 1)
  assert.deepEqual(up.added.map((m) => m.container), [m2.container.toLowerCase()])
  assert.deepEqual(up.dropped, [])
  const r = await deliverGroupUpdate({ group, update: up, relayClients: [relay] })
  assert.deepEqual(r.deliveries.map((d) => [d.what, d.container ?? null]), [['invite', m2.container.toLowerCase()], ['epoch', null]], 'only the new member is invited')
  assert.equal((await checkGroupInvites({ self: m1.self, identity: m1.identity, relayClients: [relay], cursors })).invites.length, 0, 'the old member gets no new invite')
  const found = await checkGroupInvites({ self: m2.self, identity: m2.identity, relayClients: [relay] })
  const { g, refused } = await join(m2, found.invites[0].invite, owner, relay)
  assert.equal(g.epoch, 1, 'the new member reads epoch 1 from the group room')
  assert.match(refused[0], /not a member/, 'epoch 0 does not open with its key and is refused')

  // 'all' re-invites everyone but the owner; a list names members of the roster
  // 'all' 重新邀请除群主外的所有人；列表点名名单中的成员
  const all = await deliverGroupUpdate({ group, invite: 'all', relayClients: [relay] })
  assert.deepEqual(all.deliveries.filter((d) => d.what === 'invite').map((d) => d.container).sort(), [m1.container, m2.container].map((c) => c.toLowerCase()).sort())
  const one = await deliverGroupUpdate({ group, invite: [m2.container], relayClients: [relay] })
  assert.equal(one.deliveries.filter((d) => d.what === 'invite').length, 1)
  const none = await deliverGroupUpdate({ group, relayClients: [relay] })
  assert.deepEqual(none.deliveries.map((d) => d.what), ['epoch'], 'no update: repost the current epoch message only')

  const gone = await group.removeMembers([m1.container])
  assert.deepEqual(gone.added, [])
  const rot = await group.rotate({ ...TRUST })
  assert.deepEqual(rot.added, [])
})

test('mistake 1: the holder\'s wallet or a wrong chainId instead of the container is another room; the SDK refuses what it can tell', async () => {
  const { members, group, created, relay } = await setup(1)
  const [m] = members
  const sent = await deliverGroupUpdate({ group, update: created, relayClients: [relay] })

  // Reading the wallet's room or the wrong chain's room finds nothing, and says which room it read
  // 读钱包的房间或错链的房间什么也读不到，并告知读的是哪个房间
  const byWallet = await checkGroupInvites({ self: { container: m.wallet, chainId: 56 }, identity: m.identity, relayClients: [relay] })
  assert.equal(byWallet.invites.length, 0)
  assert.notEqual(byWallet.room, sent.deliveries[0].room, 'compare the two rooms to see the mistake')
  const byChain = await checkGroupInvites({ self: { container: m.container, chainId: 1 }, identity: m.identity, relayClients: [relay] })
  assert.equal(byChain.invites.length, 0)
  assert.notEqual(byChain.room, sent.deliveries[0].room)
  assert.equal((await checkGroupInvites({ self: m.self, identity: m.identity, relayClients: [relay] })).invites.length, 1)

  // Given the holder, the wallet-for-container mix-up is refused outright / 给出持有人时，直接拒绝把钱包当容器
  await assert.rejects(checkGroupInvites({ self: { container: m.wallet }, holder: m.wallet.toUpperCase().replace('0X', '0x'), identity: m.identity, relayClients: [relay] }), invalid(/holder's wallet/))
  await assert.rejects(checkGroupInvites({ self: { container: 'wallet' }, identity: m.identity, relayClients: [relay] }), invalid(/CONTAINER address/))

  // The owner may only invite roster members: a wallet address is not one / 群主只能邀请名单成员：钱包地址不是
  await assert.rejects(deliverGroupUpdate({ group, invite: [m.wallet], relayClients: [relay] }), invalid(/not in the current roster.*never the holder's wallet/))
  await assert.rejects(deliverGroupUpdate({ group, invite: [{ container: m.container, chainId: 97 }], relayClients: [relay] }), invalid(/on chain 97 is not in the current roster/))

  // checkSelf reads the container's channel record: a wallet is no container, a wrong chainId or a stale identity is caught
  // checkSelf 读取容器的通道记录：钱包不是容器，错的 chainId 或过期的身份文件都会被发现
  const chainApi = (rec, chainId = 56) => ({ chainId, chain: { channelKeys: async (c) => { if (typeof rec === 'function') return rec(c); return rec } } })
  const notFound = chainApi(() => { throw new TapeAPIError('NOT_FOUND', `${m.wallet} does not answer ERC-6551 token(): not a TapeOut container`) })
  await assert.rejects(checkGroupInvites({ self: { container: m.wallet }, identity: m.identity, relayClients: [relay], checkSelf: notFound }), delivery(/not a TapeOut container on chain 56.*holder's wallet\? Pass the container/))
  await assert.rejects(checkGroupInvites({ self: m.self, identity: m.identity, relayClients: [relay], checkSelf: chainApi(m.entry, 97) }), invalid(/client reads chain 97/))
  await assert.rejects(checkGroupInvites({ self: m.self, identity: channel.generateIdentity(), relayClients: [relay], checkSelf: chainApi(m.entry) }), delivery(/stale identity file/))
  const rpcDown = chainApi(() => { throw new TapeAPIError('RPC_UNAVAILABLE', 'all nodes down') })
  await assert.rejects(checkGroupInvites({ self: m.self, identity: m.identity, relayClients: [relay], checkSelf: rpcDown }), (e) => e.code === 'RPC_UNAVAILABLE', 'an outage is passed on as it is')
  const ok = await checkGroupInvites({ self: m.self, identity: m.identity, relayClients: [{ ...relay, api: { ...relay.api, ...chainApi(m.entry) } }], checkSelf: true })
  assert.equal(ok.invites.length, 1, 'checkSelf: true uses the relay\'s client')
})

test('mistake 2: a cursor from another room, without its epoch, skips invite 0 on a raw read; checkGroupInvites does not', async () => {
  const { core, members, group, created, relay } = await setup(1)
  const [m] = members
  // The group room already has frames 0..3 / 群房间已有 0..3 号帧
  for (let k = 0; k < 3; k++) await relay.api.call(SVC, 'relaySend', { room: group.room, frame: toBase64(group.seal(`m${k}`)) })
  await deliverGroupUpdate({ group, update: created, relayClients: [relay] })
  const inbox = channel.inboxRoom(m.container, 56)
  const groupCursor = (await core.recv(group.room, -1)).next
  assert.equal(groupCursor, 3)

  // The bug as an application wrote it: the group room's `after`, no epoch -- the invite at index 0 is skipped
  // 应用里的写法：拿群房间的 `after`、不带 epoch——序号 0 的邀请被跳过
  assert.equal((await core.recv(inbox, groupCursor)).frames.length, 0, 'raw read: the invite is skipped')

  // A store poisoned the same ways: no epoch, or another room's epoch / 同样被污染的游标存储：没有 epoch，或别的房间的 epoch
  const key = `relay:${SVC.container}:${inbox}`
  const groupEpoch = (await core.recv(group.room, -1)).epoch
  for (const poisoned of [{ after: groupCursor }, { after: groupCursor, epoch: null }, { after: groupCursor, epoch: groupEpoch }, 'garbage']) {
    const cursors = new Map([[key, poisoned]])
    const found = await checkGroupInvites({ self: m.self, identity: m.identity, relayClients: [relay], cursors })
    assert.equal(found.invites.length, 1, `found with a cursor of ${JSON.stringify(poisoned)}`)
    assert.equal(found.invites[0].i, 0)
    assert.equal(cursors.get(key).after, 0)
    assert.equal(cursors.get(key).epoch, (await core.recv(inbox, -1)).epoch)
  }
  // The first read sends after: -1, epoch: null / 首次读取发送 after: -1、epoch: null
  relay.api.calls.length = 0
  await checkGroupInvites({ self: m.self, identity: m.identity, relayClients: [relay] })
  assert.deepEqual(relay.api.calls[0], { method: 'relayRecv', params: { room: inbox, after: -1, waitMs: 0, epoch: null } })

  // An async store (a database) works as well / 异步存储（数据库）同样可用
  const db = new Map()
  const asyncStore = { get: async (k) => db.get(k), set: async (k, v) => { db.set(k, structuredClone(v)) } }
  assert.equal((await checkGroupInvites({ self: m.self, identity: m.identity, relayClients: [relay], cursors: asyncStore })).invites.length, 1)
  assert.equal((await checkGroupInvites({ self: m.self, identity: m.identity, relayClients: [relay], cursors: asyncStore })).invites.length, 0)
  await assert.rejects(checkGroupInvites({ self: m.self, identity: m.identity, relayClients: [relay], cursors: {} }), invalid(/get\(key\) and set/))
})

test('mistake 3: a relay forgets a room 15 idle minutes after the last access; the stale cursor still finds the invite in the new room', async () => {
  let t = 1_000_000
  const { core, owner, members, group, created, relay } = await setup(1, { now: () => t })
  const [m] = members
  const cursors = new Map()
  await deliverGroupUpdate({ group, update: created, relayClients: [relay] })
  const first = await checkGroupInvites({ self: m.self, identity: m.identity, relayClients: [relay], cursors })
  assert.equal(first.invites.length, 1)
  const key = `relay:${SVC.container}:${first.room}`
  const oldEpoch = cursors.get(key).epoch

  // 14 minutes after the last read the room is still there; 16 minutes after, it is gone (memory only)
  // 最后一次读取 14 分钟后房间仍在；16 分钟后就没了（只在内存里）
  t += 14 * 60_000; core.sweep()
  assert.ok((await core.recv(first.room, -1)).epoch, 'a read touches the room')
  t += 16 * 60_000; core.sweep()
  assert.equal((await core.recv(first.room, -1)).epoch, null, 'forgotten')
  assert.equal((await core.recv(group.room, -1)).epoch, null, 'the group room too')

  // The owner delivers again ('all': members who have not joined yet need their invite again). The member's stored
  // cursor { after: 0, epoch: old } would skip index 0 of the new room without the epoch; with it, it is read.
  // 群主重新投递（'all'：尚未入群的成员需要再收一次邀请）。成员存着的游标 { after: 0, epoch: 旧 } 不带 epoch 会跳过
  // 新房间的 0 号；带上 epoch 就能读到。
  const again = await deliverGroupUpdate({ group, invite: 'all', relayClients: [relay] })
  assert.equal(again.deliveries[0].i, 0)
  assert.notEqual(again.deliveries[0].epoch, oldEpoch, 'a new room epoch')
  assert.equal(cursors.get(key).after, 0)
  const second = await checkGroupInvites({ self: m.self, identity: m.identity, relayClients: [relay], cursors })
  assert.equal(second.invites.length, 1, 'the invite at index 0 of the re-created room is read')
  const { g } = await join(m, second.invites[0].invite, owner, relay)
  assert.equal(g.epoch, 0, 'the reposted epoch message is there to join from')

  // A read while the room is gone resets the cursor to the start / 房间不在时读取，游标重置到起点
  t += 16 * 60_000; core.sweep()
  const empty = await checkGroupInvites({ self: m.self, identity: m.identity, relayClients: [relay], cursors })
  assert.equal(empty.invites.length, 0)
  assert.deepEqual(cursors.get(key), { after: -1, epoch: null })
})

test('mistake 4: the relay\'s per-source limit on invites / epoch messages is thrown, never swallowed; throwOnError: false says ok: false', async () => {
  const { core, group, created, relay } = await setup(1)
  await deliverGroupUpdate({ group, update: created, relayClients: [relay] })   // one 0x04 in the group room / 群房间第 1 条 0x04
  for (let k = 2; k <= 8; k++) await deliverGroupUpdate({ group, relayClients: [relay] })
  let err
  await assert.rejects(deliverGroupUpdate({ group, relayClients: [relay] }), (e) => { err = e; return delivery(/1 of 1 group posts failed.*epoch message.*too many invites.*wait and deliver again/)(e) })
  const d = err.data.deliveries[0]
  assert.equal(d.ok, false); assert.equal(d.error.code, 'BAD_REQUEST'); assert.equal(d.error.rateLimited, true)
  assert.ok(d.error.retryAfterS > 0 && d.error.retryAfterS <= 600)
  assert.equal(err.data.ok, false)
  const soft = await deliverGroupUpdate({ group, relayClients: [relay], throwOnError: false })
  assert.equal(soft.ok, false); assert.equal(soft.deliveries[0].error.rateLimited, true)

  // Another source (another IP) is not limited by this one / 另一个来源不受影响
  const other = { api: relayApi(core, { ip: '10.0.0.2' }), service: SVC }
  assert.equal((await deliverGroupUpdate({ group, relayClients: [other] })).ok, true)
})

test('every post is tried and reported: a relay that fails the invites still gets the epoch message tried, and the error names the room', async () => {
  const { members, group, created, relay } = await setup(2)
  const flaky = { service: SVC, api: { call: async (svc, method, p) => { if (p.room !== group.room) throw new TapeAPIError('UNAVAILABLE', 'relay is full'); return relay.api.call(svc, method, p) } } }
  let err
  await assert.rejects(deliverGroupUpdate({ group, update: created, relayClients: [flaky] }), (e) => { err = e; return delivery(/2 of 3 group posts failed; first: the invite for 0x[0-9a-f]{40} \(inbox room [0-9a-f]{64}\) via relay: relay is full/)(e) })
  assert.deepEqual(err.data.deliveries.map((d) => [d.what, d.ok]), [['invite', false], ['invite', false], ['epoch', true]])
  assert.equal(err.data.deliveries[0].room, channel.inboxRoom(members[0].container, 56))
  // A relay that answers without { i } is a failure too / 回答里没有 { i } 也算失败
  const odd = { service: SVC, api: { call: async () => ({ result: { ok: true } }) } }
  await assert.rejects(deliverGroupUpdate({ group, relayClients: [odd] }), delivery(/not \{ i, epoch \}/))
})

test('ChannelBus: one ChannelBus.send transaction per room through the caller\'s sendTx; relay and bus together; a failing wallet is reported', async () => {
  const { members, group, created, relay } = await setup(1)
  const BUS = '0x' + 'cb'.repeat(20)
  const txs = []
  const bus = { address: BUS, sendTx: async (tx) => { txs.push(tx); return '0x' + String(txs.length).padStart(64, '0') } }
  const r = await deliverGroupUpdate({ group, update: created, relayClients: [relay], busClients: [bus] })
  assert.deepEqual(r.deliveries.map((d) => [d.what, d.via]), [['invite', 'relay'], ['invite', 'bus'], ['epoch', 'relay'], ['epoch', 'bus']])
  assert.equal(txs.length, 2)
  const [room0, wire0] = decodeCall('send', txs[0].data)
  assert.equal(String(room0).toLowerCase(), '0x' + channel.inboxRoom(members[0].container, 56))
  assert.equal(txs[0].to, BUS); assert.equal(txs[0].value, '0x0')
  const [room1, wire1] = decodeCall('send', txs[1].data)
  assert.equal(String(room1).toLowerCase(), '0x' + group.room)
  assert.equal(hex(wire1 instanceof Uint8Array ? wire1 : Buffer.from(String(wire1).slice(2), 'hex')), hex(created.epochWire))
  assert.equal(r.deliveries[1].txHash, '0x' + '1'.padStart(64, '0'))
  // The same sealed invite went to the relay and the bus / 同一份密封邀请发往中继与总线
  const onRelay = (await relay.api.call(SVC, 'relayRecv', { room: r.deliveries[0].room })).result.frames[0].frame
  assert.equal(Buffer.from(onRelay, 'base64').toString('hex'), Buffer.from(String(wire0 instanceof Uint8Array ? hex(wire0) : wire0).slice(2), 'hex').toString('hex'))

  const broke = { address: BUS, sendTx: async () => { throw new Error('user rejected the transaction') } }
  await assert.rejects(deliverGroupUpdate({ group, busClients: [broke] }), delivery(/via bus: user rejected/))
  await assert.rejects(deliverGroupUpdate({ group, busClients: [{ address: BUS, sendTx: async () => undefined }] }), delivery(/sendTx returned nothing/))
  await assert.rejects(deliverGroupUpdate({ group, busClients: [{ address: BUS }] }), invalid(/sendTx is required/))
  await assert.rejects(deliverGroupUpdate({ group, busClients: [{ address: 'nope', sendTx: async () => '0x' }] }), invalid(/ChannelBus contract/))
})

test('member: frames that are not a group invite for us are skipped and counted; a channel invite in the same inbox is told apart', async () => {
  const { members, group, created, relay } = await setup(1)
  const [m] = members
  const inbox = channel.inboxRoom(m.container, 56)
  const post = (bytes) => relay.api.call(SVC, 'relaySend', { room: inbox, frame: toBase64(bytes) })
  await post(Uint8Array.of(0x02, 1, 2, 3))                                                  // a frame, not a sealed invite
  await post(Uint8Array.from([0x03, ...new Uint8Array(100).fill(7)]))                      // garbage sealed to nobody
  const stranger = person(50)
  await post(group.inviteFor({ ...stranger.entry, container: m.container }))              // sealed to another key, posted here
  const peer = channel.generateKeyPair()
  const { invite: chInvite } = channel.createInvite({ self: { container: C(0xd1), staticSecret: peer.secretKey }, peer: { container: m.container, staticPublic: m.identity.x25519.publicKey }, relays: [{ url: 'https://relay.example/tapeapi/v1', container: SVC.container }] })
  await post(channel.sealInvite(chInvite, { to: { container: m.container, chainId: 56, staticPublic: m.identity.x25519.publicKey } }))
  await post(channel.sealToInbox({ v: 1, kind: 'something.else' }, { to: { container: m.container, chainId: 56, staticPublic: m.identity.x25519.publicKey } }))
  await relay.api.call(SVC, 'relaySend', { room: inbox, frame: '!!!!' }).catch(() => {})   // the relay refuses non-base64 itself
  await deliverGroupUpdate({ group, update: created, relayClients: [relay] })
  const found = await checkGroupInvites({ self: m.self, identity: m.identity, relayClients: [relay] })
  assert.equal(found.invites.length, 1)
  assert.deepEqual(found.skippedBy, { unreadable: 2, channelInvite: 1, otherKind: 1, notSealed: 1 })
  assert.equal(found.skipped, 5)
})

test('member: two relays carrying the same invite yield it once; one relay down is reported (ok: false), all down throws', async () => {
  const { members, group, created, relay } = await setup(1)
  const core2 = createRelayCore()
  const relay2 = { api: relayApi(core2), service: SVC2 }
  const r = await deliverGroupUpdate({ group, update: created, relayClients: [relay, relay2] })
  assert.equal(r.deliveries.length, 4)
  const [m] = members
  const both = await checkGroupInvites({ self: m.self, identity: m.identity, relayClients: [relay, relay2] })
  assert.equal(both.invites.length, 1, 'the same sealed bytes on two relays count once')
  const down = { service: { container: '0x' + 'dd'.repeat(20) }, api: { call: async () => { throw new TapeAPIError('UNAVAILABLE', 'connection refused') } } }
  const partly = await checkGroupInvites({ self: m.self, identity: m.identity, relayClients: [down, relay] })
  assert.equal(partly.ok, false)
  assert.equal(partly.invites.length, 1)
  assert.deepEqual(partly.failed.map((f) => [f.relay, f.error.code]), [['0x' + 'dd'.repeat(20), 'UNAVAILABLE']])
  await assert.rejects(checkGroupInvites({ self: m.self, identity: m.identity, relayClients: [down] }), delivery(/could not read inbox room [0-9a-f]{64} on any relay: .*connection refused/))
})

test('owner restart: resumeGroup reports added: [] and deliverGroupUpdate reposts its epoch message; bad calls are refused with a reason', async () => {
  const { owner, members, group, created, relay } = await setup(1)
  await deliverGroupUpdate({ group, update: created, relayClients: [relay] })
  const resumed = await G.resumeGroup({ self: owner.self, identity: owner.identity, snapshot: group.snapshot(), ...TRUST })
  assert.deepEqual(resumed.added, [])
  assert.equal(resumed.epoch, 1)
  const r = await deliverGroupUpdate({ group: resumed.group, update: resumed, relayClients: [relay] })
  assert.deepEqual(r.deliveries.map((d) => d.what), ['epoch'])
  assert.equal(r.groupEpoch, 1)

  const [m] = members
  const found = await checkGroupInvites({ self: m.self, identity: m.identity, relayClients: [relay] })
  const member = G.joinGroup({ self: m.self, identity: m.identity, invite: found.invites[0].invite, ownerKeys: owner.entry })
  await assert.rejects(deliverGroupUpdate({ group: member, relayClients: [relay] }), invalid(/owner's group handle/))
  await assert.rejects(deliverGroupUpdate({ group }), invalid(/at least one transport/))
  await assert.rejects(deliverGroupUpdate({ group, relayClients: [{ service: SVC }] }), invalid(/TapeAPI client/))
  await assert.rejects(deliverGroupUpdate({ group, relayClients: [{ api: relay.api }] }), invalid(/resolved relay service/))
  await assert.rejects(deliverGroupUpdate({ group, update: { epochWire: new Uint8Array([5]) }, relayClients: [relay] }), invalid(/no epoch message/))
  await assert.rejects(deliverGroupUpdate({ group, invite: 'everyone', relayClients: [relay] }), invalid(/invite must be/))
  const other = await G.createGroup({ self: owner.self, identity: owner.identity, members: [], ...TRUST })
  await assert.rejects(deliverGroupUpdate({ group, update: other, relayClients: [relay] }), invalid(/belongs to another group/))
  await assert.rejects(checkGroupInvites({ self: m.self, relayClients: [relay] }), invalid(/identity\.x25519\.secretKey/))
  await assert.rejects(checkGroupInvites({ self: m.self, identity: m.identity }), invalid(/relayClients \[\{ api, service \}\] is required/))
  await assert.rejects(checkGroupInvites({ self: { container: m.container, chainId: 0 }, identity: m.identity, relayClients: [relay] }), invalid(/positive integer/))
})
