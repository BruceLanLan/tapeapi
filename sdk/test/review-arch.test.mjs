// Architecture review, SDK findings A4, B1, B7, B8, B10, B13, B14, and the second-round review (R2-*). Every `FIXED <id>` test replays the scenario the
// review described and asserts the CORRECT behaviour now.
// 架构审查中 SDK 部分的发现 A4、B1、B7、B8、B10、B13、B14。每个 `FIXED <id>` 测试重放审查描述的场景，断言现在的正确行为。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as channel from '../src/channel.js'   // the implementation module, test hooks included / 实现模块，含测试钩子
import { TapeAPIError, createTapeAPI, sig, CHANNEL_KEYS_KEY, canonicalJSON } from '../src/index.js'
// The implementation module: buildEpoch and senderKey are not in the public `group` namespace (review RC-7).
// 实现模块：buildEpoch 与 senderKey 不在公开的 group 命名空间里。
import * as G from '../src/group.js'
import { validateManifest } from '../src/manifest.js'
import { createRpc } from '../src/rpc.js'
import { createFakeChain, ADDR, eachCall } from './helpers/fake-chain.mjs'
import { createRelayCore } from '../../examples/relay-service/relay-core.mjs'

const { createInvite, acceptInvite, completeInvite, generateKeyPair, encodeWire, decodeWire, relayTransport, fanIn, roomsFor } = channel
// The scanner tests in this file predate review R5-1 and test other behaviour: they take a "serves no logs" verdict as
// soon as it is known before the poll (verdictMs: 0). The R5-1 tests use channel.busTransport with the real default.
// 本文件的扫描器测试早于 R5-1，测的是其它行为：它们让"不提供日志"的结论在本次轮询之前已知即生效。R5-1 的测试用真实默认值。
const busTransport = (o) => channel.busTransport({ verdictMs: 0, ...o })
const busReader = (o) => channel.busReader({ verdictMs: 0, ...o })
const A = { container: '0x86DDaEF00401E3F10418398D67D7189fc458eA95', chainId: 56 }
const B = { container: '0x19366c3c69ffeb3b286d9fa6cc5e616375baafd3', chainId: 56 }
const BUS = '0x' + 'cb'.repeat(20)
const RPC = ['http://rpc1', 'http://rpc2']
const hex = (b) => '0x' + Buffer.from(b).toString('hex')
const C = (n) => '0x' + n.toString(16).padStart(40, '0')
const TRUST = { verifyMember: 'trust-roster' }
const isGroupErr = (re) => (e) => e instanceof TapeAPIError && e.code === 'GROUP_INVALID' && (!re || re.test(e.message))
const entry = (m) => ({ container: m.container, chainId: 56, x25519: hex(m.identity.x25519.publicKey), ed25519: hex(m.identity.ed25519.publicKey) })
const seqOf = (wire) => new DataView(wire.buffer, wire.byteOffset + 29, 8).getBigUint64(0)   // TAP-27 message header / 消息头
// Move Date.now (all SDK clocks read it) for the duration of fn / 在 fn 执行期间拨动 Date.now
async function shifted(ms, fn) { const real = Date.now; Date.now = () => real() + ms; try { return await fn() } finally { Date.now = real } }

// ================================================================================================ B10 ====
const manifest = (extra = {}) => ({
  tapeapi: '0.1', name: 'T', circuits: ADDR.circuits, tokenId: '1', container: ADDR.container, signer: '0x' + '11'.repeat(20), delegation: null,
  endpoints: { live: ['https://svc.example/tapeapi/v1'], async: false },
  methods: [{ name: 'work', priceBEM: '0', params: {}, returns: {} }],
  ...extra,
})
const opts = { requireDelegation: false }

test('FIXED B10: tapeapi is MAJOR.MINOR: "0.1" as before, "0.2" with a field 0.1 does not know is accepted (and kept), "1.0" is refused', () => {
  assert.equal(validateManifest(manifest(), opts).tapeapi, '0.1')
  const v2 = validateManifest(manifest({ tapeapi: '0.2', streaming: { ws: 'wss://svc.example/ws' } }), opts)
  assert.equal(v2.tapeapi, '0.2')
  assert.deepEqual(v2.streaming, { ws: 'wss://svc.example/ws' }, 'an additive field of a later minor is ignored, not refused')
  assert.equal(validateManifest(manifest({ tapeapi: '0.17' }), opts).tapeapi, '0.17')
  const invalid = (e) => e instanceof TapeAPIError && e.code === 'MANIFEST_INVALID' && /tapeapi version/.test(e.message)
  for (const v of ['1.0', '2.1', '0.0', '0.01', '0.1.0', '0', '0.', ' 0.1', 0.1, 1, null, undefined]) {
    assert.throws(() => validateManifest(manifest({ tapeapi: v }), opts), invalid, JSON.stringify(v))
  }
  // 0.1 is exactly as strict as before for the fields it defines: a later minor is no way around them
  // 0.1 定义的字段仍与以前一样严格：更高的次版本号绕不过它们
  assert.throws(() => validateManifest(manifest({ tapeapi: '0.2', methods: [{ name: 'work', params: {}, returns: {} }] }), opts), /priceBEM/)
})

// ================================================================================================ B14 ====
async function trio({ ownerNow } = {}) {
  const ids = [1, 2, 3].map(() => channel.generateIdentity())
  const ms = ids.map((identity, i) => ({ container: C(0xa000 + i), chainId: 56, identity }))
  const { group: owner, epochWire } = await G.createGroup({ self: ms[0], identity: ids[0], members: [entry(ms[1]), entry(ms[2])], bus: BUS, ...TRUST, ...(ownerNow ? { clock: ownerNow } : {}) })
  const fresh = (m, o = {}) => G.joinGroup({ self: m, identity: m.identity, invite: { gid: owner.gid, owner: { container: ms[0].container, chainId: 56 } }, ownerKeys: entry(ms[0]), ...o })
  const join = async (m, o) => { const g = fresh(m, o); await g.acceptEpoch(epochWire, TRUST); return g }
  return { ms, owner, epochWire, fresh, join }
}

test('FIXED B14: an owner whose clock runs 6 minutes fast no longer kills the group; a roster issued hours ahead is still refused', async () => {
  assert.equal(G.FUTURE_SKEW_S, 3600)
  const { ms, join, fresh, owner } = await trio({ ownerNow: () => (Date.now() + 6 * 60_000) / 1000 })
  const gb = await join(ms[1])
  assert.equal(gb.epoch, 0, 'the member accepts the epoch despite the owner\'s skew')
  assert.equal(gb.open(owner.seal('hi'), { text: true }).data, 'hi')
  const future = G.buildEpoch({ gid: Buffer.from(owner.gid, 'hex'), epoch: 0, issued: Math.floor(Date.now() / 1000) + G.FUTURE_SKEW_S + 60, prev: '00'.repeat(32), owner: { container: ms[0].container, chainId: 56 }, members: owner.members, bus: BUS, ownerEdSecret: ms[0].identity.ed25519.secretKey })
  await assert.rejects(fresh(ms[1]).acceptEpoch(future.wire, TRUST), isGroupErr(/in the future/))
})

test('FIXED B14: a member restarting with a clock that stepped back keeps its seq above the last one it used (snapshot().lastSeq), so receivers do not take its messages for replays', async () => {
  const T = Date.now()
  const { ms, join, fresh, epochWire } = await trio()
  const gb = await join(ms[1], { clock: () => T / 1000 })
  const gc = await join(ms[2])
  assert.equal(gb.snapshot().lastSeq, undefined, 'nothing sealed yet: no lastSeq')
  for (const t of ['one', 'two']) gc.open(gb.seal(t))
  const snap = gb.snapshot()
  assert.equal(snap.lastSeq, ((BigInt(T) << 16n) + 1n).toString(), 'the last seq used, as a decimal string (it is beyond 2^53)')
  // B restarts; its clock is now a minute behind (NTP step, a VM restored from a snapshot).
  // B 重启；它的时钟慢了一分钟（NTP 校时、虚拟机从快照恢复）。
  const back = () => (T - 60_000) / 1000
  const b2 = fresh(ms[1], { clock: back, minEpoch: snap.epoch, lastSeq: snap.lastSeq })
  await b2.acceptEpoch(epochWire, TRUST)
  const w = b2.seal('after restart')
  assert.ok(seqOf(w) > BigInt(snap.lastSeq), 'max(clock_ms << 16, lastSeq + 1)')
  const got = gc.open(w, { text: true })
  assert.equal(got.data, 'after restart')
  assert.equal(b2.snapshot().lastSeq, seqOf(w).toString(), 'the restarted sender reports its new last seq')
  // Without lastSeq the new seq comes from the stepped-back clock and C refuses it: what the fix is for.
  // 不传 lastSeq 时，新序号来自回拨的时钟，C 会拒绝：这正是修复的对象。
  const b3 = fresh(ms[1], { clock: back })
  await b3.acceptEpoch(epochWire, TRUST)
  assert.throws(() => gc.open(b3.seal('lost')), isGroupErr(/already seen/))
  for (const bad of ['-1', '01', '1.5', 'x', 12, '1' + '0'.repeat(20)]) assert.throws(() => fresh(ms[1], { lastSeq: bad }), isGroupErr(/lastSeq/), String(bad))
})

test('FIXED B14: resumeGroup restores the owner\'s lastSeq from snapshot(); the wire format is unchanged', async () => {
  const { ms, owner, join } = await trio()
  const gb = await join(ms[1])
  gb.open(owner.seal('before'))
  const snap = owner.snapshot()
  assert.match(snap.lastSeq, /^\d+$/)
  const { group: again } = await shifted(-10 * 60_000, () => G.resumeGroup({ self: ms[0], identity: ms[0].identity, snapshot: JSON.parse(JSON.stringify(snap)), ...TRUST }))
  const w = await shifted(-10 * 60_000, async () => again.seal('after'))
  assert.ok(seqOf(w) > BigInt(snap.lastSeq), 'the owner\'s seq did not follow its clock backwards')
  assert.equal(w.length, 61 + 5 + 16 + 64, 'header, ciphertext, tag, signature: the same layout as before')
})

// ================================================================================================ B13 ====
function busPair(opts = {}) {
  const chain = createFakeChain()
  const rpc = createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch })
  const rooms = roomsFor('11'.repeat(16))
  const start = chain.state.block
  const mk = (inbound, outbound, o = {}) => busTransport({ rpc, bus: BUS, inbound, outbound, sendTx: async (tx) => chain.submit(tx), fromBlock: start, ...opts, ...o })
  return { chain, rpc, rooms, start, a: mk(rooms.toInitiator, rooms.toResponder), b: mk(rooms.toResponder, rooms.toInitiator), mk }
}
// Post `wire` as if its transaction had been included in an OLDER block: what a shallow reorg does to a peer's tx.
// 把 `wire` 当作被打包进更早的区块来发送：浅重组对对端交易的效果。
async function includeAt(chain, t, block, wire) { const head = chain.state.block; chain.state.block = block; try { await t.send(wire) } finally { chain.state.block = head } }

test('FIXED B13: busTransport defaults to 2 confirmations (about 1 s on BSC)', async () => {
  const { chain, a, b } = busPair()
  await b.send(Uint8Array.of(0x02, 1))
  chain.mine(1)
  assert.deepEqual(await a.poll(), [], 'one block deep: not read yet')
  chain.mine(1)
  assert.equal((await a.poll()).length, 1, 'two blocks deep: read')
  assert.throws(() => busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: 'aa'.repeat(32), outbound: 'bb'.repeat(32), overlap: -1 }), /overlap/)
})

test('FIXED B13: a peer tx re-included by a reorg in a block already scanned is still delivered, exactly once', async () => {
  const { chain, a, b, rooms, start, mk } = busPair()
  chain.mine(10)
  assert.deepEqual(await a.poll(), [])
  const cursor = a.cursor
  assert.equal(cursor, start + 10 - 2 + 1)
  // the peer's tx was in a block that got reorged out, and lands 5 blocks below our cursor
  // 对端交易所在区块被重组掉，重新落在我们游标之下 5 个区块处
  const lost = Uint8Array.of(0x02, 0xaa)
  await includeAt(chain, b, cursor - 5, lost)
  assert.deepEqual(await a.poll(), [lost], 'the overlap re-read finds it (it used to be skipped for ever)')
  chain.mine(3)
  assert.deepEqual(await a.poll(), [], 'read again in the overlap, but not handed over twice')
  // a restart from the persisted cursor re-reads the overlap too; the session layer drops what it already had
  // 从持久化游标重启同样重读重叠区；会话层丢弃已有的内容
  const restarted = mk(rooms.toInitiator, rooms.toResponder, { fromBlock: cursor })
  assert.deepEqual(await restarted.poll(), [lost])
  // A reorg deeper than the overlap is still lost (and shows up as a channel gap): the documented limit.
  // 比重叠更深的重组仍会丢失（在通道里表现为空洞）：这是文档写明的界限。
  await includeAt(chain, b, a.cursor - 17, Uint8Array.of(0x02, 0xbb))
  assert.deepEqual(await a.poll(), [])
})

// ================================================================================================= B1 ====
// Two in-process relays and a ChannelBus on the fake chain, all named by A's invite. B posts its accept to only
// one of them, as TAP-26 allows. / 两个进程内中继加假链上的 ChannelBus，都写在 A 的邀请里。B 只往其中一个发 accept。
const R1 = { url: 'http://127.0.0.1:1/r1/tapeapi/v1', container: '0x' + 'a1'.repeat(20) }
const R2 = { url: 'http://127.0.0.1:1/r2/tapeapi/v1', container: '0x' + 'a2'.repeat(20) }
const apiFor = (core) => ({ call: async (_svc, method, p) => ({ result: method === 'relayRecv' ? await core.recv(p.room, p.after, Math.min(p.waitMs ?? 0, 20), p.epoch) : core.send(p.room, p.frame) }) })

function world() {
  const chain = createFakeChain()
  const rpc = createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch })
  const cores = [createRelayCore(), createRelayCore()]
  const ka = generateKeyPair(), kb = generateKeyPair()
  const { invite, pending } = createInvite({ self: { ...A, staticSecret: ka.secretKey }, peer: { ...B, staticPublic: kb.publicKey }, relays: [R1, R2], bus: BUS })
  const rooms = roomsFor(invite.cid)
  const start = chain.state.block
  const relayLink = (i, inbound, outbound) => relayTransport({ api: apiFor(cores[i]), svc: {}, inbound, outbound, waitMs: 20, retryMs: 5 })
  const busLink = (inbound, outbound) => busTransport({ rpc, bus: BUS, inbound, outbound, sendTx: async (tx) => { const h = chain.submit(tx); chain.mine(3); return h }, fromBlock: start, pollMs: 10 })
  // A: listens on toInitiator, writes to toResponder, on every transport the invite names / A 在邀请所列的每个传输上监听
  const aLinks = () => [relayLink(0, rooms.toInitiator, rooms.toResponder), relayLink(1, rooms.toInitiator, rooms.toResponder), busLink(rooms.toInitiator, rooms.toResponder)]
  const bLinks = () => [relayLink(0, rooms.toResponder, rooms.toInitiator), relayLink(1, rooms.toResponder, rooms.toInitiator), busLink(rooms.toResponder, rooms.toInitiator)]
  const { accept, session: bob } = acceptInvite({ self: { ...B, staticSecret: kb.secretKey }, peer: { ...A, staticPublic: ka.publicKey }, invite })
  return { chain, invite, pending, accept, bob, aLinks, bLinks }
}
// Run a transport until an accept completes the handshake, or give up after `ms`. / 跑到握手完成，或 ms 后放弃。
function handshake(t, pending, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { t.stop(); resolve(null) }, ms)
    t.start(async (w, info) => {
      const { handshake: h } = decodeWire(w)
      if (h?.t !== 'accept') return
      const done = completeInvite(pending, h)
      clearTimeout(timer); t.stop()
      resolve({ ...done, index: info?.index ?? t.from?.(w) })
    })
  })
}

for (const [label, via] of [['relay R2', 1], ['the bus', 2]]) {
  test(`FIXED B1: B posts accept only to ${label}; A listening on R1 alone never completes, A listening through fanIn does, and the channel works`, async () => {
    const w = world()
    await w.bLinks()[via].send(encodeWire(w.accept))
    const [r1Only] = w.aLinks()
    assert.deepEqual(await r1Only.poll(0), [], 'nothing on R1')
    assert.equal(await handshake(r1Only, w.pending, 150), null, 'A on R1 alone waits in vain until the invite expires')
    const fan = fanIn(w.aLinks())
    const got = await handshake(fan, w.pending, 3000)
    assert.ok(got, 'the fan-in completes the handshake')
    assert.equal(got.index, via, 'and says which transport the accept came on')
    // ready and a first frame go back the way the accept came, where B listens / ready 与首帧沿 accept 来路返回
    await fan.send(encodeWire(got.ready), { index: got.index })
    await fan.send(encodeWire(got.session.seal('hello')), { index: got.index })
    const bSide = w.bLinks()[via]
    const back = await bSide.poll(0)
    w.bob.confirm(decodeWire(back[0]).handshake)
    assert.equal(w.bob.open(decodeWire(back[1]).frame, { text: true }).data, 'hello')
  })
}

test('FIXED B1: an accept posted everywhere is handed over once; send goes to the first transport that takes it, or to all', async () => {
  const w = world()
  const bFan = fanIn(w.bLinks(), { all: true })
  const results = await bFan.send(encodeWire(w.accept))
  assert.equal(results.length, 3, 'posted to R1, R2 and the bus')
  const aFan = fanIn(w.aLinks())
  const got = await aFan.poll(0)
  assert.equal(got.length, 1, 'three copies of the same bytes, one delivery')
  assert.equal(aFan.from(got[0]), 0, 'the first transport to deliver it')
  assert.ok(completeInvite(w.pending, decodeWire(got[0]).handshake).session)
  assert.deepEqual(await aFan.poll(0), [], 'nothing twice')
  // send: first that succeeds, in order; every one failing is an error naming each
  // 发送：按顺序第一个成功的；全部失败则报错并逐一指明
  const sent = []
  const stub = (name, ok) => ({ send: async (x) => { if (!ok) throw new Error(`${name} down`); sent.push(name); return name }, poll: async () => [], start() {}, stop() {} })
  assert.equal(await fanIn([stub('r1', false), stub('r2', true), stub('bus', true)]).send(Uint8Array.of(2)), 'r2')
  assert.deepEqual(sent, ['r2'])
  await assert.rejects(fanIn([stub('r1', false), stub('r2', false)]).send(Uint8Array.of(2)), (e) => e.code === 'CHANNEL_INVALID' && /r1 down.*r2 down/.test(e.message))
  await assert.rejects(fanIn([{ ...stub('x', true), poll: async () => { throw new Error('gone') } }]).poll(), /every transport failed/)
  assert.throws(() => fanIn([]), /non-empty/)
  assert.throws(() => fanIn([{ send() {} }]), /send, poll, start and stop/)
})

// ---------------------------------------------------------------------------------------------- A3 (consumer side)
test('FIXED A3 (consumer): a lapsed provider\'s unsigned 503 is reported as DELEGATION_INVALID only when our own manifest agrees', async () => {
  const { createProvider } = await import('../../server/src/index.js')
  const { MANIFEST_KEY, createTapeAPI } = await import('../src/index.js')
  const { privateKeyToAddress: addrOf, signDigest: signD, delegationDigest: delD } = await import('../src/sig.js')
  const { createFakeChain: fakeChain, ADDR: A } = await import('./helpers/fake-chain.mjs')
  const HK = '0x' + '11'.repeat(32), SK = '0x' + '22'.repeat(32), signerA = addrOf(SK)
  const exp = Math.floor(Date.now() / 1000) + 3600
  const mf = (url) => ({
    tapeapi: '0.1', name: 'Lapse', circuits: A.circuits, tokenId: '4246', container: A.container, signer: signerA,
    delegation: { expires: exp, sig: signD(delD(56, A.hub, { container: A.container, signer: signerA, expires: exp }), HK) },
    endpoints: { live: [url], async: false }, methods: [{ name: 'ping', priceBEM: '0', params: {}, returns: {} }],
  })
  const cc = fakeChain()
  cc.setOwner(4246, addrOf(HK)); cc.setAccount(4246, A.container)
  const provider = createProvider({ minVoucherLifeS: 0, manifest: mf('http://127.0.0.1:1/tapeapi/v1'), signerKey: SK, allowHttp: true, log: () => {}, rateLimit: false, methods: { ping: async () => ({ pong: true }) } })
  const srv = await provider.listen(0)
  try {
    const url = `http://127.0.0.1:${srv.address().port}/tapeapi/v1`
    provider.manifest.endpoints.live = [url]
    cc.writeFile(A.container, MANIFEST_KEY, JSON.stringify(mf(url)))
    const api = createTapeAPI({ rpcUrls: ['http://rpc1', 'http://rpc2'], quorum: 2, chainId: 56, hub: A.hub, siteRegistry: A.siteRegistry, allowHttp: true, fetch: cc.fetchWith((u, init) => fetch(u, init)), rpcTimeoutMs: 1000 })
    const svc = await api.resolve(A.container)
    assert.equal((await api.call(svc, 'ping', {})).verified, true)
    provider.manifest.delegation.expires = Math.floor(Date.now() / 1000)          // lapses on the provider / 提供者一侧过期
    // Our manifest still says it is valid: an unsigned claim is not believed, only passed on as a hint.
    // 本地清单仍说有效：未签名的说法不被采信，只作为提示转述。
    await assert.rejects(api.call(svc, 'ping', {}), (e) => e.code === 'PROVIDER_UNAVAILABLE' && /unsigned claim: DELEGATION_INVALID/.test(e.message))
    // Our copy agrees it expired: the caller gets the real reason. / 本地清单也确认过期：调用方得到真正原因。
    svc.manifest.delegation.expires = Math.floor(Date.now() / 1000)
    await assert.rejects(api.call(svc, 'ping', {}), (e) => e.code === 'DELEGATION_INVALID')
  } finally { await provider.close() }
})

test('a file of another format that also calls itself "tapeapi" (version "0", site root) is never taken for a TAP-20 manifest', () => {
  // Another project on TapeOut publishes `tapeapi.json` at the site root with `"tapeapi": "0"`. Different path, and
  // even at our path the version alone refuses it: "0.N" requires N >= 1.
  // TapeOut 上另一个项目在站点根目录发布 `tapeapi.json`（`"tapeapi": "0"`）。路径不同；即便放到我们的路径，版本号也会拒绝它。
  assert.throws(() => validateManifest({ tapeapi: '0', kind: 'relay', endpoints: [{ protocol: 'tape-relay/1', url: 'wss://relay.example' }] }), (e) => e.code === 'MANIFEST_INVALID')
})

// ================================================================================================= B7 ====
// A container with a circuit and a holder; `record: true` also publishes its channel record (TAP-26 §3.1).
// 有电路与持有人的容器；`record: true` 时还发布其通道记录。
const HOLDER = '0x' + '41'.repeat(32)
const nowS = () => Math.floor(Date.now() / 1000)
function container(chain, tokenId, { record = true, issued = nowS() - 60 } = {}) {
  const c = C(0xc000 + tokenId)
  chain.setContainerToken(c, { tokenId }); chain.setAccount(tokenId, c); chain.setOwner(tokenId, sig.privateKeyToAddress(HOLDER))
  const identity = channel.generateIdentity()
  if (record) {
    const keys = { container: c, x25519: hex(identity.x25519.publicKey), ed25519: hex(identity.ed25519.publicKey), inbox: {}, issued, expires: nowS() + 30 * 86400 }
    chain.writeFile(c, CHANNEL_KEYS_KEY, canonicalJSON({ tapechannel: '1', chainId: 56, ...keys, sig: sig.signDigest(sig.channelKeysDigest(56, ADDR.hub, keys), HOLDER) }))
  }
  return { container: c, chainId: 56, tokenId, identity }
}
// Every JSON-RPC request the client sends, by method / 客户端发出的每个 JSON-RPC 请求，按方法计数
function counted(chain) {
  const n = { all: 0 }
  const fetch = (url, init) => { const { method } = JSON.parse(init.body); n.all++; n[method] = (n[method] || 0) + 1; return chain.fetch(url, init) }
  return { n, fetch }
}
const client = (chain, fetch, o = {}) => createTapeAPI({ rpcUrls: RPC, quorum: 2, chainId: 56, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, fetch, ...o })
async function later(ms, fn) { const real = Date.now; Date.now = () => real() + ms; try { return await fn() } finally { Date.now = real } }

test('FIXED B7: 20 forged invites naming the same unpublished `from` cost the chain reads of one; 20 at once share one read', async () => {
  const chain = createFakeChain()
  const { n, fetch } = counted(chain)
  const api = client(chain, fetch)
  const bob = container(chain, 2)
  const bobKeys = await api.chain.channelKeys(bob.container)
  const X = container(chain, 9, { record: false })        // a real circuit and container, no channel record / 真实电路与容器，但没有通道记录
  // The attacker posts 20 sealed invites to Bob's inbox, each naming X; each is free to post. Bob opens each and
  // resolves invite.from before he could accept. / 攻击者往 Bob 的收件房间投 20 份都写着 X 的密封邀请；Bob 逐份打开并解析 invite.from。
  const sealed = Array.from({ length: 20 }, () => {
    const { invite } = createInvite({ self: { container: X.container, chainId: 56, staticSecret: generateKeyPair().secretKey }, peer: bobKeys, bus: BUS })
    return channel.sealInvite(invite, { to: bobKeys })
  })
  const start = n.all
  let one = null
  for (const w of sealed) {
    const inv = channel.openInvite(w, { self: { ...bob, staticSecret: bob.identity.x25519.secretKey } })
    await assert.rejects(api.chain.channelKeys(inv.from.container), (e) => e.code === 'CHANNEL_INVALID' && /no file/.test(e.message))
    one ??= n.all - start
  }
  assert.ok(one >= 6, `the first resolution reads the chain (${one} node requests)`)
  assert.equal(n.all - start, one, 'the other 19 are answered from the negative cache')
  // Not a container at all (NOT_FOUND) is a definitive answer too / 根本不是容器（NOT_FOUND）同样是确定的回答
  const before = n.all
  for (let i = 0; i < 20; i++) await assert.rejects(api.chain.channelKeys(C(0xdead)), (e) => e.code === 'NOT_FOUND')
  assert.equal(n.all - before, RPC.length, 'one token() read on each node, once')
  // Concurrent: a fresh client, 20 lookups in flight together, the reads of one / 并发：20 个查询同时在途，只读一次
  const c2 = counted(chain)
  const api2 = client(chain, c2.fetch)
  const got = await Promise.allSettled(Array.from({ length: 20 }, () => api2.chain.channelKeys(X.container)))
  assert.ok(got.every((r) => r.status === 'rejected' && r.reason.code === 'CHANNEL_INVALID'))
  // + one factory.isCPU read per node: a new client checks the processor once, then remembers it / 新客户端先核对一次处理器，之后记住
  assert.equal(c2.n.all, one + RPC.length, 'in-flight lookups of one container share one read')
  // After the TTL the chain is read again, once / 过了缓存期再读一次链
  await later(301_000, () => assert.rejects(api.chain.channelKeys(X.container), /no file/))
  assert.equal(n.all - start, one * 2 + RPC.length)
  // A positive answer is shared the same way / 正面结果同样共享
  const c3 = counted(chain)
  const api3 = client(chain, c3.fetch)
  const recs = await Promise.all(Array.from({ length: 20 }, () => api3.chain.channelKeys(bob.container)))
  const per = c3.n.all
  for (let i = 0; i < 20; i++) await api3.chain.channelKeys(bob.container)
  assert.equal(c3.n.all, per, 'resolved once for 40 lookups')
  recs[0].inbox.relays.push({ url: 'https://evil.example/tapeapi/v1', container: C(1) }); recs[0].x25519 = '0x00'
  const again = await api3.chain.channelKeys(bob.container)
  assert.deepEqual([again.x25519, again.inbox.relays], [bobKeys.x25519, []], 'a caller mutating its copy does not poison the cache')
})

test('FIXED B7: an RPC outage is never cached, a sold circuit is noticed after the TTL (at once with { fresh: true }), and the cache is bounded', async () => {
  const chain = createFakeChain()
  const { n, fetch } = counted(chain)
  const api = client(chain, fetch)
  const Y = container(chain, 3)
  const Z = container(chain, 4, { record: false })
  const verify = api.groupVerifier()
  const entryY = { container: Y.container, chainId: 56, x25519: hex(Y.identity.x25519.publicKey), ed25519: hex(Y.identity.ed25519.publicKey) }
  assert.equal(await verify(entryY), true)
  // every node down / 所有节点宕机
  for (const u of RPC) chain.setFault(u, 'http500')
  const down = n.all
  assert.equal((await api.chain.channelKeys(Y.container)).x25519, entryY.x25519, 'a cached record still answers')
  assert.equal(n.all, down, 'from the cache, no request')
  await assert.rejects(api.chain.channelKeys(Y.container, { fresh: true }), (e) => e.code === 'RPC_UNAVAILABLE')
  await assert.rejects(api.chain.channelKeys(Z.container), (e) => e.code === 'RPC_UNAVAILABLE', 'a miss during the outage is an error, not a verdict')
  await assert.rejects(verify({ ...entryY, container: Z.container }), (e) => e.code === 'RPC_UNAVAILABLE', 'the verifier throws: nobody is dropped for an outage')
  for (const u of RPC) chain.setFault(u, null)
  const up = n.all
  await assert.rejects(api.chain.channelKeys(Z.container), (e) => e.code === 'CHANNEL_INVALID')
  assert.ok(n.all > up, 'the outage was not cached: Z is read again as soon as the nodes are back')
  assert.equal((await api.chain.channelKeys(Y.container)).x25519, entryY.x25519, 'and the failed fresh read did not evict Y')
  // Y's circuit is sold / Y 的电路被卖
  chain.setOwner(Y.tokenId, '0x' + '99'.repeat(20))
  assert.equal(await verify(entryY), true, 'within the cache window (at most 300 s, TAP-27 §3.3 step 6) the record stands')
  assert.equal(await later(301_000, () => verify(entryY)), false, 'after it, the sale is noticed')
  const api2 = client(chain, chain.fetch)
  await api2.chain.channelKeys(Y.container, { fresh: true }).catch(() => {})
  chain.setOwner(Y.tokenId, sig.privateKeyToAddress(HOLDER))              // bought back / 又买回来了
  assert.equal((await api2.chain.channelKeys(Y.container, { fresh: true })).x25519, entryY.x25519, 'fresh reads the chain now and refreshes the cache')
  assert.equal(await api2.groupVerifier()(entryY), true, '...which the verifier then shares')
  // Bounded: with room for 4, the oldest of 5 is evicted; a TTL above 300 s is clamped to 300 s
  // 有上限：容量 4 时 5 个中最旧的被淘汰；超过 300 秒的缓存期被压到 300 秒
  const c = counted(chain)
  const small = client(chain, c.fetch, { identityCacheSize: 4, identityCacheS: 3600 })
  const five = [1, 2, 3, 4, 5].map((i) => C(0xe000 + i))
  for (const a of five) await small.chain.channelKeys(a).catch(() => {})
  const after5 = c.n.all
  await small.chain.channelKeys(five[4]).catch(() => {})
  assert.equal(c.n.all, after5, 'the newest is cached')
  await small.chain.channelKeys(five[0]).catch(() => {})
  assert.ok(c.n.all > after5, 'the oldest was evicted')
  const mid = c.n.all
  await later(301_000, () => small.chain.channelKeys(five[0]).catch(() => {}))
  assert.ok(c.n.all > mid, 'identityCacheS: 3600 still expires after 300 s')
  const none = counted(chain)
  const off = client(chain, none.fetch, { identityCacheS: 0 })
  await off.chain.channelKeys(Y.container); const once = none.n.all
  await off.chain.channelKeys(Y.container)
  assert.equal(none.n.all - once, once - RPC.length, 'identityCacheS: 0 disables the cache (the processor check alone stays remembered)')
})

test('FIXED B7: the cache never lets an older record back in (arch B4), and the floor still advances, across clients sharing channelRecordFloor', async () => {
  const chain = createFakeChain()
  const floor = new Map()
  const [c1, c2] = [client(chain, chain.fetch, { channelRecordFloor: floor }), client(chain, chain.fetch, { channelRecordFloor: floor })]
  const A1 = container(chain, 5, { issued: nowS() - 3600 })
  const oldBytes = chain.state.files.get(`${A1.container.toLowerCase()}:${CHANNEL_KEYS_KEY}`).bytes
  const old = await c1.chain.channelKeys(A1.container)                       // c1 caches the old record / c1 缓存旧记录
  const A2 = container(chain, 5, { issued: nowS() - 60 })                     // the holder rotates / 持有人轮换密钥
  const cur = await c2.chain.channelKeys(A2.container)
  assert.notEqual(cur.x25519, old.x25519)
  assert.equal(floor.get(`56:${A2.container.toLowerCase()}`), cur.issued, "the floor advanced, under the 1.0 key <chainId>:<container>")
  assert.equal((await c1.chain.channelKeys(A1.container)).x25519, cur.x25519, 'c1\'s cached record is below the shared floor: a miss, read again, the new one')
  chain.writeFile(A1.container, CHANNEL_KEYS_KEY, oldBytes)                   // a site writer puts the old one back / 旧记录被放回
  assert.equal((await c1.chain.channelKeys(A1.container)).x25519, cur.x25519, 'the cache holds the newer one')
  await assert.rejects(c1.chain.channelKeys(A1.container, { fresh: true }), /older than a record already seen/)
  await assert.rejects(c1.chain.channelKeys(A1.container), /older than a record already seen/, 'a definitive refusal, cached as one')
})

test('FIXED B7: the owner re-verifies members past the cache when it starts an epoch; members and the first epoch use it', async () => {
  const seen = []
  const spy = async (m, o) => { seen.push(o?.fresh === true); return true }
  const ids = [1, 2, 3].map(() => channel.generateIdentity())
  const ms = ids.map((identity, i) => ({ container: C(0xa100 + i), chainId: 56, identity }))
  const { group: owner, epochWire } = await G.createGroup({ self: ms[0], identity: ids[0], members: [entry(ms[1]), entry(ms[2])], bus: BUS, verifyMember: spy })
  assert.deepEqual(seen.splice(0), [false, false], 'createGroup: the members were just resolved')
  const gb = G.joinGroup({ self: ms[1], identity: ids[1], invite: { gid: owner.gid, owner: { container: ms[0].container, chainId: 56 } }, ownerKeys: entry(ms[0]) })
  await gb.acceptEpoch(epochWire, { verifyMember: spy })
  assert.deepEqual(seen.splice(0), [false, false, false], 'a member may use the cache (TAP-27 §3.3 step 6)')
  await owner.rotate({ verifyMember: spy })
  assert.deepEqual(seen.splice(0), [true, true], 'rotate: a record cached before a sale would otherwise keep the sold member a whole epoch')
})

// ================================================================================================= A4 ====
// Post `wire` to `room` as if included in block `at` / 当作被打包进区块 `at` 发送
async function postAt(chain, t, at, wire) { const head = chain.state.block; chain.state.block = at; try { await t.send(wire) } finally { chain.state.block = head } }
function logsCounted(chain) {
  const per = {}
  const filters = []
  const fetch = (url, init) => { const b = JSON.parse(init.body); if (b.method === 'eth_getLogs') { per[url] = (per[url] || 0) + 1; filters.push({ ...b.params[0], url }) } return chain.fetch(url, init) }
  return { per, filters, fetch, total: () => Object.values(per).reduce((a, b) => a + b, 0) }
}

test('FIXED A4: busTransport learns how far back the nodes serve logs, warns once about blocks no node serves, and reads on from there', async () => {
  const chain = createFakeChain()
  const KEEP = 5000
  chain.setFault('http://rpc1', `history:${KEEP}`)       // publicnode-style window / publicnode 式窗口
  chain.setFault('http://rpc2', 'nologs')                // a dataseed-style node / dataseed 式节点
  const L = logsCounted(chain)
  const rpc = createRpc({ urls: RPC, quorum: 2, fetch: L.fetch })
  const head = chain.state.block
  const room = 'a4'.repeat(32)
  const poster = busTransport({ rpc, bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
  const lost = Uint8Array.of(0x02, 1), kept = Uint8Array.of(0x02, 2), edge = Uint8Array.of(0x02, 3)
  await postAt(chain, poster, head - 8000, lost)          // older than the node keeps / 早于节点保留的范围
  await postAt(chain, poster, head - KEEP, edge)          // the oldest block it serves / 它提供的最早区块
  await postAt(chain, poster, head - 100, kept)
  const warns = []
  // a cursor saved 15,000 blocks (~1.9 h) ago: before A4 every poll failed for ever and the cursor never moved
  // 15,000 个区块（约 1.9 小时）前保存的游标：A4 之前每次轮询都失败，游标永远不动
  const t = busTransport({ rpc, bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head - 15_000, confirmations: 0, warn: (m, d) => warns.push({ m, d }) })
  assert.equal(t.oldestServed, null, 'unknown until a node refuses')
  const f0 = L.filters.length
  // The poll that learns rpc2 serves no logs holds: a verdict counts from the next poll on (review R3-1)
  // 得知 rpc2 不提供日志的那次轮询停住：结论从下一次轮询起才生效
  await assert.rejects(t.poll(), (e) => e.code === 'RPC_UNAVAILABLE' && /next poll/.test(e.message))
  assert.equal(t.cursor, head - 15_000)
  assert.deepEqual(warns, [])
  assert.deepEqual(await t.poll(), [edge, kept], 'everything a node still serves is delivered')
  // the probe: the refused block, the head, then a binary search over ~15,000 blocks, single-block reads, once
  // 探测：被拒的区块、链头，再在约 15,000 个区块上二分，单区块读取，只做一次
  const probes = L.filters.slice(f0).filter((f) => f.url === 'http://rpc1' && f.fromBlock === f.toBlock).length
  // + 2: each poll's walk now chunks from the floor, so its last chunk is the one block [head, head] (review R4 restructure)
  // + 2：每次轮询的读取现在从下限开始分块，最后一块是单个区块 [head, head]
  assert.ok(probes >= 3 && probes <= 2 + Math.ceil(Math.log2(15_016)) + 2, `${probes} single-block probe reads`)
  // and one single-block read at the head that finds rpc2 serves no logs at all, once (review R2-1)
  // 另有一次链头单区块读取，判定 rpc2 根本不提供日志，只做一次
  assert.equal(L.filters.slice(f0).filter((f) => f.url === 'http://rpc2' && f.fromBlock === f.toBlock).length, 1)
  assert.equal(t.cursor, head + 1, 'the cursor moved past the unreachable blocks')
  assert.equal(t.oldestServed, head - KEEP)
  assert.equal(warns.length, 1, 'said once')
  // from: the saved cursor less the 16-block overlap a restart re-reads (arch B13) / 游标减去重启时重读的 16 个重叠区块
  assert.deepEqual(warns[0].d, { from: head - 15_000 - 16, to: head - KEEP - 1, oldestServed: head - KEEP })
  assert.match(warns[0].m, /no node serves logs for blocks .* frames posted there cannot be read/)
  assert.ok(!/http:/.test(warns[0].m), 'never a node URL')
  assert.equal(t.stats().nodes[0].oldestServed, head - KEEP)
  // later polls: no warning, no probe, one getLogs per node / 之后的轮询：不再警告、不再探测，每节点一次 getLogs
  chain.mine(5)
  const next = Uint8Array.of(0x02, 4)
  await poster.send(next); chain.mine(1)
  const before = { ...L.per }
  assert.deepEqual(await t.poll(), [next])
  assert.equal(L.per['http://rpc1'] - before['http://rpc1'], 1)
  assert.equal(L.per['http://rpc2'] - before['http://rpc2'], 1)
  assert.equal(warns.length, 1)
  // `lookback` beyond the window: the same, from the first poll / lookback 超出窗口：首次轮询即同样处理
  const w2 = []
  const t2 = busTransport({ rpc, bus: BUS, inbound: room, outbound: '00'.repeat(32), lookback: 20_000, confirmations: 0, warn: (m) => w2.push(m) })
  // the window has slid 6 blocks since: `edge` is out of it now / 窗口已滑过 6 个区块：`edge` 已在窗口之外
  await assert.rejects(t2.poll(), (e) => e.code === 'RPC_UNAVAILABLE' && /next poll/.test(e.message))   // R3-1: one hold / 停一次
  assert.deepEqual(await t2.poll(), [kept, next])
  assert.equal(w2.length, 1)
  assert.equal(t2.oldestServed, chain.state.block - KEEP)
})

test('FIXED A4: in the normal case the probe costs nothing: one getLogs per node per chunk, no warning, oldestServed stays null', async () => {
  const chain = createFakeChain()
  const L = logsCounted(chain)
  const rpc = createRpc({ urls: RPC, quorum: 2, fetch: L.fetch })
  const warns = []
  const t = busTransport({ rpc, bus: BUS, inbound: 'a5'.repeat(32), outbound: '00'.repeat(32), confirmations: 0, warn: (m) => warns.push(m) })
  await t.poll(); chain.mine(3); await t.poll()
  assert.deepEqual(L.per, { 'http://rpc1': 2, 'http://rpc2': 2 })
  assert.deepEqual(warns, [])
  assert.equal(t.oldestServed, null)
  // a range limit whose wording mentions "history" is still halved, not taken for a history window
  // 措辞里带 "history" 的区间限制仍按区间拆分，不被当作历史窗口
  const asked = []
  const capped = { call: async (_m, [f]) => { const lo = Number(f.fromBlock), hi = Number(f.toBlock); asked.push(hi - lo + 1); if (hi - lo + 1 > 50) throw new TapeAPIError('RPC_ERROR', 'eth_getLogs: range exceeds the maximum of 50 blocks of history per query'); return [] } }
  const t3 = busTransport({ rpc: { urls: ['http://n'], blockNumber: async () => 2000, call: capped.call, single: () => capped }, bus: BUS, inbound: 'a5'.repeat(32), outbound: '00'.repeat(32), fromBlock: 1000, confirmations: 0, warn: (m) => warns.push(m) })
  assert.deepEqual(await t3.poll(), [])
  assert.equal(t3.cursor, 2001)
  assert.ok(asked.includes(40), 'halved to minChunk')
  assert.deepEqual(warns, [])
  assert.equal(t3.oldestServed, null)
  // a node refusing every range as too wide is still a node failure, not history / 区间一律嫌宽的节点仍是节点故障，不是历史限制
  chain.setFault('http://rpc1', 'nologs'); chain.setFault('http://rpc2', 'nologs')
  await assert.rejects(busTransport({ rpc, bus: BUS, inbound: 'a5'.repeat(32), outbound: '00'.repeat(32), warn: (m) => warns.push(m) }).poll(), (e) => e.code === 'RPC_UNAVAILABLE')
  assert.deepEqual(warns, [])
})

// ================================================================================================= B8 ====
const roomN = (i) => i.toString(16).padStart(4, '0').repeat(16)

test('FIXED B8: busReader reads 20 rooms with ONE getLogs per node per poll and hands each room\'s frames to its own handler, exactly once', async () => {
  const chain = createFakeChain()
  const L = logsCounted(chain)
  const rpc = createRpc({ urls: RPC, quorum: 2, fetch: L.fetch })
  const start = chain.state.block
  const rooms = Array.from({ length: 20 }, (_, i) => roomN(i + 1))
  const got = new Map(rooms.map((r) => [r, []]))
  const reader = busReader({ rpc, bus: BUS, rooms: Object.fromEntries(rooms.map((r) => [r, (w, info) => { assert.equal(info.room, r); got.get(r).push(w) }])), fromBlock: start, confirmations: 0, pollMs: 5 })
  const posterOf = (r) => busTransport({ rpc, bus: BUS, inbound: '00'.repeat(32), outbound: r, sendTx: async (tx) => chain.submit(tx) })
  const want = new Map()
  for (const [i, r] of rooms.entries()) {
    const ws = Array.from({ length: (i % 3) + 1 }, (_, k) => Uint8Array.of(0x02, i, k))
    want.set(r, ws)
    await posterOf(r).sendMany(ws)
  }
  await posterOf(roomN(999)).send(Uint8Array.of(0x02, 0xff))   // a room nobody here reads / 这里没人读的房间
  chain.mine(1)
  const before = L.total()
  const polled = await reader.poll()
  assert.deepEqual(L.per, { 'http://rpc1': 1, 'http://rpc2': 1 }, 'one eth_getLogs per node for all 20 rooms')
  assert.equal(L.total() - before, 2)
  const f = L.filters.at(-1)
  assert.equal(f.topics[0], channel.CHANNELBUS_WIRE_TOPIC)
  assert.deepEqual(f.topics[1], rooms.map((r) => '0x' + r), 'topic 1 is an OR over the rooms')
  assert.equal(polled.length, [...want.values()].flat().length)
  for (const r of rooms) assert.deepEqual(polled.filter((x) => x.room === r).map((x) => x.wire), want.get(r), `room ${r.slice(0, 4)}: its frames, in order`)
  // The same through the loop: each handler gets its room's frames once, even across overlap re-reads and a reorg
  // 通过循环也一样：即使重叠重读与重组，每个处理器也只收到本房间的帧各一次
  const live = busReader({ rpc, bus: BUS, rooms: Object.fromEntries(rooms.map((r) => [r, (w) => got.get(r).push(w)])), fromBlock: start, confirmations: 0, pollMs: 5 })
  const errors = []
  live.start(undefined, { onError: (e) => errors.push(e) })
  await sleep(40)
  const late = Uint8Array.of(0x02, 0x77)
  await includeAt(chain, posterOf(rooms[7]), live.cursor - 5, late)   // re-included below the cursor / 重新打包到游标之下
  want.get(rooms[7]).push(late)
  chain.mine(2)
  await sleep(40)
  live.stop()
  assert.deepEqual(errors, [])
  for (const r of rooms) assert.deepEqual(got.get(r), want.get(r), `room ${r.slice(0, 4)}: exactly once`)
  // For comparison: 20 single-room transports cost 20 getLogs per node per poll / 对照：20 个单房间传输每次轮询每节点 20 次
  const L2 = logsCounted(chain)
  const rpc2 = createRpc({ urls: RPC, quorum: 2, fetch: L2.fetch })
  await Promise.all(rooms.map((r) => busTransport({ rpc: rpc2, bus: BUS, inbound: r, outbound: '00'.repeat(32), fromBlock: start, confirmations: 0 }).poll()))
  assert.deepEqual(L2.per, { 'http://rpc1': 20, 'http://rpc2': 20 })
})

test('FIXED B8: rooms added at run time have their past read once; removed rooms stop; halving, union and confirmations are the single-room code', async () => {
  const chain = createFakeChain()
  const L = logsCounted(chain)
  const rpc = createRpc({ urls: RPC, quorum: 2, fetch: L.fetch })
  const start = chain.state.block
  const [r1, r2, r3] = [roomN(1), roomN(2), roomN(3)]
  const poster = (r) => busTransport({ rpc, bus: BUS, inbound: '00'.repeat(32), outbound: r, sendTx: async (tx) => chain.submit(tx) })
  const reader = busReader({ rpc, bus: BUS, rooms: [r1], fromBlock: start })       // default confirmations: 2 / 默认 2 个确认
  const early = Uint8Array.of(0x02, 0xe0)
  await poster(r2).send(early)                          // posted before r2 is read by anyone / r2 还没人读时就发了
  chain.mine(30)
  assert.deepEqual(await reader.poll(), [])
  assert.equal(reader.cursor, start + 30 - 2 + 1, 'reads stay 2 blocks behind the head, as busTransport')
  reader.add(r2); reader.add(r3)
  let n = L.total()
  const back = await reader.poll()
  assert.deepEqual(back, [{ room: r2, wire: early }], 'r2\'s past, read on the next poll')
  assert.equal(L.total() - n, 4, 'one catch-up read (r2 and r3 together) and one regular read, per node')
  n = L.total()
  chain.mine(1)
  assert.deepEqual(await reader.poll(), [])
  assert.equal(L.total() - n, 2, 'then one read per node again')
  reader.remove(r1)
  assert.deepEqual(reader.rooms, [r2, r3])
  await poster(r1).send(Uint8Array.of(0x02, 1)); await poster(r3).send(Uint8Array.of(0x02, 3)); chain.mine(2)
  assert.deepEqual(await reader.poll(), [{ room: r3, wire: Uint8Array.of(0x02, 3) }], 'r1 was removed')
  assert.deepEqual(L.filters.at(-1).topics[1], ['0x' + r2, '0x' + r3])
  // One room: the filter is exactly the single-room one / 一个房间时过滤条件与单房间完全相同
  const one = busReader({ rpc, bus: BUS, rooms: [r3], fromBlock: start, confirmations: 0 })
  await one.poll()
  assert.deepEqual(L.filters.at(-1).topics, [channel.CHANNELBUS_WIRE_TOPIC, '0x' + r3])
  assert.deepEqual(await busReader({ rpc, bus: BUS }).poll(), [], 'no rooms: nothing to read, nothing asked')
  assert.throws(() => reader.add('zz'), /room id/)
  assert.throws(() => busReader({ rpc, bus: BUS, rooms: [r1], overlap: -1 }), /overlap/)
})

test('FIXED B8: a node that files an honest log under another room cannot take it away from its room', async () => {
  const [r1, r2] = [roomN(1), roomN(2)]
  const wire = Uint8Array.of(0x02, 0x42)
  const { encodeParams, bytesToHex } = await import('../src/abi.js')
  const log = (room) => ({ blockNumber: '0x64', logIndex: '0x0', data: '0x' + bytesToHex(encodeParams(['bytes'], [wire])), topics: [channel.CHANNELBUS_WIRE_TOPIC, '0x' + room], removed: false })
  // the honest node answers first, the liar last: before the fix the liar's copy replaced the honest one in the union
  // 诚实节点先答、撒谎节点后答：修复前撒谎者的副本会在并集中顶替诚实的那条
  const nodeOf = (room) => ({ call: async (_m, [f], { project }) => project(Number(f.fromBlock) <= 100 && Number(f.toBlock) >= 100 ? [log(room)] : []) })
  const rpc = { urls: ['http://honest', 'http://liar'], blockNumber: async () => 200, call: async () => { throw new Error('unused') }, single: (u) => nodeOf(u === 'http://honest' ? r1 : r2) }
  const got = await busReader({ rpc, bus: BUS, rooms: [r1, r2], fromBlock: 50, confirmations: 0 }).poll()
  assert.deepEqual(got.filter((x) => x.room === r1).map((x) => x.wire), [wire], 'r1 still gets its frame (r2 gets a copy that will not open there)')
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('FIXED X1: a counterfeit ERC-721 is not a TapeOut circuit: its account is refused as a channel identity, a service and a TapeSend key', async () => {
  // accountOf derives an address for ANY token contract, so without factory.isCPU anyone could mint unlimited
  // "containers" for the price of one contract deployment (TapeKit SPEC §3.3 step 2; found 2026-09-24).
  // accountOf 对任何代币合约都能推导地址；没有 factory.isCPU，任何人只需部署一个合约就能造出无数"容器"。
  const chain = createFakeChain()
  const api = client(chain, chain.fetch)
  const real = container(chain, 5)
  assert.ok((await api.chain.channelKeys(real.container)).x25519, 'a factory-made circuit resolves')
  chain.setCounterfeit(ADDR.circuits)
  const fresh = client(chain, chain.fetch)
  await assert.rejects(fresh.chain.channelKeys(real.container), (e) => e.code === 'CHANNEL_INVALID' && /not a TapeOut processor/.test(e.message))
  await assert.rejects(fresh.chain.tapeSendKey({ circuits: ADDR.circuits, tokenId: 5 }), (e) => e.code === 'CHANNEL_INVALID' && /not a TapeOut processor/.test(e.message))
  assert.equal(await fresh.chain.isCPU(ADDR.circuits), false, 'false is never cached')
  chain.setCounterfeit(ADDR.circuits, false)
  assert.equal(await fresh.chain.isCPU(ADDR.circuits), true)
})

test('FIXED X1 (TAP-20 §3.6 step 3): a manifest whose circuits contract is not a TapeOut processor is refused', async () => {
  const { MANIFEST_KEY } = await import('../src/index.js')
  const { privateKeyToAddress: addrOf, signDigest: signD, delegationDigest: delD } = await import('../src/sig.js')
  const HK = '0x' + '11'.repeat(32), signerA = addrOf('0x' + '22'.repeat(32)), exp = nowS() + 86400
  const chain = createFakeChain()
  chain.setOwner(4246, addrOf(HK)); chain.setAccount(4246, ADDR.container)
  chain.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify({
    tapeapi: '0.1', name: 'X1', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer: signerA,
    delegation: { expires: exp, sig: signD(delD(56, ADDR.hub, { container: ADDR.container, signer: signerA, expires: exp }), HK) },
    endpoints: { live: ['https://api.example.com/tapeapi/v1'], async: false }, methods: [{ name: 'ping', priceBEM: '0', params: {}, returns: {} }],
  }))
  assert.equal((await client(chain, chain.fetch).resolve(ADDR.container)).container.toLowerCase(), ADDR.container.toLowerCase())
  chain.setCounterfeit(ADDR.circuits)
  await assert.rejects(client(chain, chain.fetch).resolve(ADDR.container), (e) => e.code === 'MANIFEST_INVALID' && /not a TapeOut processor/.test(e.message))
})

// ================================================================================================= R2 ====
// Second-round review of the fixes above. / 对上述修复的第二轮审查。
const RPC3 = ['http://rpc1', 'http://rpc2', 'http://rpc3']
const refuseOld = (b) => new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, error: { code: -32602, message: 'Archive requests require a personal token' } }), { headers: { 'content-type': 'application/json' } })

test('FIXED R2-1: an archive node failing for one poll holds the cursor; a history-limited node alone cannot declare the blocks it keeps a gap', async () => {
  const chain = createFakeChain()
  chain.setFault('http://rpc1', 'history:5000')          // publicnode-style window / publicnode 式窗口
  chain.setFault('http://rpc2', 'nologs')                // dataseed-style / dataseed 式
  let down = true                                        // rpc3: the archive node, rate limited (HTTP 500) for a while / 归档节点，暂时被限流
  const fetch = (url, init) => (down && url === 'http://rpc3' && JSON.parse(init.body).method === 'eth_getLogs') ? new Response('rate limited', { status: 500 }) : chain.fetch(url, init)
  const rpc = createRpc({ urls: RPC3, quorum: 2, fetch })
  const head = chain.state.block
  const room = 'a4'.repeat(32)
  const poster = busTransport({ rpc, bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
  const old = Uint8Array.of(0x02, 1), recent = Uint8Array.of(0x02, 2)
  await postAt(chain, poster, head - 8000, old)           // older than rpc1 keeps; rpc3 has it / 早于 rpc1 的窗口，rpc3 有
  await postAt(chain, poster, head - 100, recent)
  const warns = []
  const t = busTransport({ rpc, bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head - 15_000, confirmations: 0, warn: (m, d) => warns.push(d) })
  await assert.rejects(t.poll(), (e) => e.code === 'RPC_UNAVAILABLE' && /node#2\(rpc3\)/.test(e.message) && /next poll/.test(e.message))
  assert.equal(t.cursor, head - 15_000, 'the cursor holds')
  assert.deepEqual(warns, [], 'no gap is declared while a node that may keep those blocks is only failing')
  down = false
  assert.deepEqual(await t.poll(), [old, recent], 'the next poll reads them')
  assert.deepEqual(warns, [])
  // rpc3 has served now. Changed by review R5-3 (was: "failing again where rpc1 covers every block does not stop
  // anything"): a node that served lately may hold what no other node has, so its failure holds the cursor even where
  // rpc1 answered, and the frame comes once it is back. / 由 R5-3 改变：最近提供过日志的节点可能有别人没有的，它失败时即使
  // rpc1 答了也停住，恢复后帧送达。
  down = true
  chain.mine(3)
  const next = Uint8Array.of(0x02, 3)
  await poster.send(next); chain.mine(1)
  await assert.rejects(t.poll(), (e) => e.code === 'RPC_UNAVAILABLE' && /node#2\(rpc3\)/.test(e.message))
  down = false
  assert.deepEqual(await t.poll(), [next])
  // the default set (a history-limited node and nologs nodes) still never holds the cursor: A4 as before
  // 默认节点组合（有历史窗口的节点与拒绝日志的节点）仍然不会卡住游标：与 A4 相同
  const w2 = []
  const rpc2 = createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch })
  const t2 = busTransport({ rpc: rpc2, bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head - 15_000, confirmations: 0, warn: (m, d) => w2.push(d) })
  await assert.rejects(t2.poll(), (e) => e.code === 'RPC_UNAVAILABLE' && /next poll/.test(e.message))   // R3-1: the poll that classifies rpc2 holds / 判定 rpc2 的那次轮询停住
  assert.deepEqual(await t2.poll(), [recent, next])
  assert.equal(w2.length, 1)
  assert.equal(t2.cursor, chain.state.block + 1)
  // The same when the archive node rate limits with a JSON-RPC answer (-32005 "quota exceeded") and the dataseed
  // node says -32005 "limit exceeded": a rate limit is "not now", never "serves no logs"
  // 归档节点以 JSON-RPC 作答限流（-32005 "quota exceeded"）、dataseed 节点答 -32005 "limit exceeded" 时同样如此：限流是"现在不行"，绝不是"不提供日志"
  chain.setFault('http://rpc2', null)
  let limited = true
  const answer = (b, message) => new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, error: { code: -32005, message } }), { headers: { 'content-type': 'application/json' } })
  const fetch3 = (url, init) => {
    const b = JSON.parse(init.body)
    if (b.method === 'eth_getLogs' && url === 'http://rpc2') return answer(b, 'limit exceeded')
    if (b.method === 'eth_getLogs' && url === 'http://rpc3' && limited) return answer(b, 'quota exceeded')
    return chain.fetch(url, init)
  }
  const w3 = []
  const t3 = busTransport({ rpc: createRpc({ urls: RPC3, quorum: 2, fetch: fetch3 }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head - 15_000, confirmations: 0, warn: (m, d) => w3.push(d) })
  await assert.rejects(t3.poll(), (e) => e.code === 'RPC_UNAVAILABLE' && /next poll/.test(e.message))
  assert.equal(t3.cursor, head - 15_000)
  assert.deepEqual(w3, [])
  limited = false
  assert.deepEqual(await t3.poll(), [old, recent, next])
  assert.deepEqual(w3, [])
  // with rpc3 gone, the -32005 "limit exceeded" node is known to serve no logs: the default set reads on
  // 去掉 rpc3 后，答 -32005 "limit exceeded" 的节点已知不提供日志：默认组合照常往下读
  const w4 = []
  const t4 = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: fetch3 }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head - 15_000, confirmations: 0, warn: (m, d) => w4.push(d) })
  await assert.rejects(t4.poll(), (e) => e.code === 'RPC_UNAVAILABLE' && /next poll/.test(e.message))   // R3-1
  assert.deepEqual(await t4.poll(), [recent, next])
  assert.equal(w4.length, 1)
})

// A node that refuses every range starting below head−5 as too old, and moves its claimed window to one block past
// whatever it last refused (poc-a4-amp). / 把 head−5 以下起始的区间一律当作太旧拒绝、并把声称的窗口挪到刚拒绝处之后一格的节点。
function windowGamer(chain, url) {
  const head = chain.state.block
  const calls = {}
  let T = -Infinity
  const fetch = (u, init) => {
    const b = JSON.parse(init.body)
    if (b.method !== 'eth_getLogs') return chain.fetch(u, init)
    calls[u] = (calls[u] || 0) + 1
    if (u === url) {
      const lo = Number(BigInt(b.params[0].fromBlock)), hi = Number(BigInt(b.params[0].toBlock))
      if (lo < head - 5) {
        if (lo !== hi) { T = Math.max(T, lo); return refuseOld(b) }
        if (lo <= T) return refuseOld(b)
      }
    }
    return chain.fetch(u, init)
  }
  return { fetch, calls }
}

test('FIXED R2-3: a node that keeps moving its "too old" window is probed once per read, not once per block; it cannot hold the cursor either', async () => {
  const chain = createFakeChain()
  const head = chain.state.block
  const g = windowGamer(chain, 'http://rpc2')
  const rpc = createRpc({ urls: RPC, quorum: 2, fetch: g.fetch })
  const room = 'a4'.repeat(32)
  const poster = busTransport({ rpc, bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
  const wire = Uint8Array.of(0x02, 9)
  await poster.send(wire); chain.mine(1)
  const warns = []
  const t = busTransport({ rpc, bus: BUS, inbound: room, outbound: '00'.repeat(32), lookback: 1000, confirmations: 0, warn: (m) => warns.push(m) })
  assert.deepEqual(await t.poll(), [wire], 'the honest node delivers')
  // 1,002 blocks are two chunks. Per chunk: one range read, one probe (the refused block, the head, ~log2(1000)
  // halvings), then a doubling walk over the chunk (~log2(1000)). Before: 10,963 requests.
  // 1,002 个区块是两块。每块：一次区间读取、一次探测、再对本块做倍增前进。修复前是 10,963 次。
  assert.equal(g.calls['http://rpc1'], 2, 'the honest node: one read per chunk')
  const bound = 2 * (3 + 2 * Math.ceil(Math.log2(1001)) + 2)
  assert.ok(g.calls['http://rpc2'] <= bound, `the gaming node was asked ${g.calls['http://rpc2']} times (bound ${bound})`)
  assert.deepEqual(warns, [], 'rpc1 covered every block')
  // With no honest node beside it (a nologs node), the poll still completes: history-limited, not transient (after
  // the one poll that classifies the nologs node, review R3-1)
  // 旁边没有诚实节点（只有拒绝日志的节点）时，轮询照样完成：这是历史受限，不是暂时故障（判定 nologs 节点的那次轮询除外）
  chain.setFault('http://rpc1', 'nologs')
  const t2 = busTransport({ rpc, bus: BUS, inbound: room, outbound: '00'.repeat(32), lookback: 1000, confirmations: 0, warn: (m) => warns.push(m) })
  await assert.rejects(t2.poll(), (e) => e.code === 'RPC_UNAVAILABLE' && /next poll/.test(e.message))
  await t2.poll()
  assert.equal(t2.cursor, chain.state.block + 1, 'the cursor moves on')
  assert.equal(warns.length, 1, 'the blocks nobody served are reported once')
  chain.mine(2)
  await t2.poll()
})

test('FIXED R2-3: a real window that slides while it is probed still has what lies well inside it read: no second probe, no chase', async () => {
  const chain = createFakeChain()
  const head = chain.state.block
  let n = 0
  // rpc1 keeps the last 5,000 blocks and its window moves one block per request (slow round trips on a 0.45 s chain).
  // Before, the scanner re-probed at every refusal and chased the edge until the frame had left the window; marking
  // the node failed on the second refusal would declare the whole chunk a gap. Walking forward reads it.
  // rpc1 保留最近 5,000 个区块，窗口每个请求前移一个区块。修复前每次被拒都重新探测，追着窗口边缘跑到帧已滑出窗口；
  // 第二次被拒就判节点失败则会把整块当作空洞。向前走就能读到。
  const fetch = (u, init) => {
    const b = JSON.parse(init.body)
    if (u === 'http://rpc1' && b.method === 'eth_getLogs' && Number(BigInt(b.params[0].fromBlock)) < head - 5000 + (++n)) return refuseOld(b)
    return chain.fetch(u, init)
  }
  chain.setFault('http://rpc2', 'nologs')
  const rpc = createRpc({ urls: RPC, quorum: 2, fetch })
  const room = 'a6'.repeat(32)
  const poster = busTransport({ rpc, bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
  const edge = Uint8Array.of(0x02, 7)
  await postAt(chain, poster, head - 4900, edge)
  const t = busTransport({ rpc, bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head - 5100, confirmations: 0, warn: () => {} })
  await assert.rejects(t.poll(), (e) => e.code === 'RPC_UNAVAILABLE' && /next poll/.test(e.message))   // R3-1: the poll that classifies rpc2 holds / 判定 rpc2 的那次轮询停住
  assert.deepEqual(await t.poll(), [edge], 'a frame 100 blocks inside the window is read although the window moved during the probe')
})

test('FIXED R2-4: a room added while the first poll is in flight has its past read', async () => {
  const chain = createFakeChain()
  const rpc = createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch })
  const head = chain.state.block
  const [r1, r2] = [roomN(1), roomN(2)]
  const poster = busTransport({ rpc, bus: BUS, inbound: '00'.repeat(32), outbound: r2, sendTx: async (tx) => chain.submit(tx) })
  const w = Uint8Array.of(0x02, 42)
  await postAt(chain, poster, head - 100, w)                 // inside the 600-block lookback / 在 600 区块回看范围内
  const reader = busReader({ rpc, bus: BUS, rooms: [r1], confirmations: 0 })
  const first = reader.poll()
  reader.add(r2)                                              // same tick, first poll in flight / 同一拍，首次轮询在途
  const got = [...await first]
  chain.mine(1); got.push(...await reader.poll())
  chain.mine(1); got.push(...await reader.poll())
  assert.deepEqual(got.filter((x) => x.room === r2).map((x) => x.wire), [w])
})

test('FIXED R2-4: a head that moves back on the poll a late room catches up leaves no hole for that room', async () => {
  const chain = createFakeChain()
  const rpc = createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch })
  const H = chain.state.block
  const heads = []
  // rpc.blockNumber is the lowest answering head: one lagging node can move it back up to maxHeadSpread (64)
  // rpc.blockNumber 取作答节点中最低的链头：一个落后的节点能让它回退至多 maxHeadSpread（64）
  const scripted = { ...rpc, blockNumber: async () => (heads.length ? heads.shift() : rpc.blockNumber()) }
  const [r1, r2] = [roomN(1), roomN(2)]
  const reader = busReader({ rpc: scripted, bus: BUS, rooms: [r1], confirmations: 0 })
  heads.push(H); await reader.poll()
  const w = Uint8Array.of(0x02, 7)
  await postAt(chain, busTransport({ rpc, bus: BUS, inbound: '00'.repeat(32), outbound: r2, sendTx: async (tx) => chain.submit(tx) }), H - 30, w)
  reader.add(r2)
  heads.push(H - 50)
  const got = [...await reader.poll()]
  chain.mine(10)
  got.push(...await reader.poll(), ...await reader.poll())
  assert.deepEqual(got.filter((x) => x.room === r2).map((x) => x.wire), [w])
})

// A Safe-held (EIP-1271) container: the holder is a contract that accepts exactly the record's digest.
// Safe（EIP-1271）持有的容器：持有人是合约，只认可该记录的摘要。
const SAFE = '0x' + '5a'.repeat(20)
function safeContainer(chain, tokenId) {
  const c = C(0xc000 + tokenId)
  chain.setContainerToken(c, { tokenId }); chain.setAccount(tokenId, c); chain.setOwner(tokenId, SAFE)
  const identity = channel.generateIdentity()
  const keys = { container: c, x25519: hex(identity.x25519.publicKey), ed25519: hex(identity.ed25519.publicKey), inbox: {}, issued: nowS() - 60, expires: nowS() + 30 * 86400 }
  chain.setContractHolder(SAFE, sig.channelKeysDigest(56, ADDR.hub, keys))
  chain.writeFile(c, CHANNEL_KEYS_KEY, canonicalJSON({ tapechannel: '1', chainId: 56, ...keys, sig: '0x' + 'ab'.repeat(130) }))
  return { container: c, chainId: 56, tokenId, identity }
}
// rpc2 fails eth_getCode and isValidSignature while `outage.on` (quorum 2 of 2: RPC_UNAVAILABLE)
// outage.on 期间 rpc2 对 eth_getCode 与 isValidSignature 失败（2 取 2：RPC_UNAVAILABLE）
function holderOutage(chain) {
  const outage = { on: false, n: 0 }
  outage.fetch = (url, init) => {
    const b = JSON.parse(init.body); outage.n++
    const is1271 = b.method === 'eth_call' && String(b.params[0].data).startsWith('0x1626ba7e')
    if (outage.on && url === 'http://rpc2' && (b.method === 'eth_getCode' || is1271)) return new Response('boom', { status: 500 })
    return chain.fetch(url, init)
  }
  return outage
}

test('FIXED R2-2: an outage during the EIP-1271 check is an error, never cached, never a CHANNEL_INVALID verdict (B7 for a contract holder)', async () => {
  const chain = createFakeChain()
  const o = holderOutage(chain)
  const api = client(chain, o.fetch)
  const B2 = safeContainer(chain, 2)
  assert.equal((await api.chain.channelKeys(B2.container)).holder.toLowerCase(), SAFE)
  const api2 = client(chain, o.fetch)                     // nothing cached yet / 尚无缓存
  o.on = true
  await assert.rejects(api.chain.channelKeys(B2.container, { fresh: true }), (e) => e.code === 'RPC_UNAVAILABLE')
  await assert.rejects(api.groupVerifier()(entry(B2), { fresh: true }), (e) => e.code === 'RPC_UNAVAILABLE', 'the verifier throws instead of answering false')
  await assert.rejects(api2.chain.channelKeys(B2.container), (e) => e.code === 'RPC_UNAVAILABLE', 'a miss during the outage: an error')
  o.on = false
  assert.equal((await api.chain.channelKeys(B2.container)).holder.toLowerCase(), SAFE, 'the failed fresh reads did not evict the record')
  const before = o.n
  assert.equal((await api2.chain.channelKeys(B2.container)).holder.toLowerCase(), SAFE, 'after the outage it resolves')
  assert.ok(o.n > before, 'read from the chain: the outage was not cached')
  // a contract that says no, or reverts, is still a definitive "no" / 合约说不或回滚，仍是确定的"否"
  chain.state.contractHolders.set(SAFE, new Set())
  await assert.rejects(api.chain.channelKeys(B2.container, { fresh: true }), (e) => e.code === 'CHANNEL_INVALID' && /not authorised/.test(e.message))
})

test('FIXED R2-2: G-05b for a contract holder: the owner rotating during a one-node outage keeps a Safe-held member', async () => {
  const chain = createFakeChain()
  const o = holderOutage(chain)
  const api = client(chain, o.fetch)
  const A2 = container(chain, 1)
  const B2 = safeContainer(chain, 2)
  const verify = api.groupVerifier()
  const { group: owner } = await G.createGroup({ self: A2, identity: A2.identity, members: [entry(B2)], bus: BUS, verifyMember: verify })
  o.on = true
  await assert.rejects(owner.rotate(), (e) => /RPC_UNAVAILABLE|only 1\/2/.test(`${e.code} ${e.message}`))
  assert.equal(owner.members.length, 2, 'nobody was dropped')
  o.on = false
  const r = await owner.rotate()
  assert.deepEqual(r.dropped, [])
  assert.equal(owner.members.length, 2)
})

test('FIXED R2-2: token() failing on every node with a JSON-RPC error that is not a revert is not "not a container", and is not cached', async () => {
  const chain = createFakeChain()
  const { n, fetch } = counted(chain)
  const api = client(chain, fetch)
  const Y = container(chain, 3)
  for (const u of RPC) chain.setFault(u, 'rpcerror')     // every node: -32000 "node says no" (e.g. "header not found") / 每个节点都答非回滚的错误
  await assert.rejects(api.chain.channelKeys(Y.container), (e) => e.code === 'RPC_ERROR')
  await assert.rejects(api.groupVerifier()(entry(Y)), (e) => e.code === 'RPC_ERROR', 'the verifier throws: nobody is dropped')
  for (const u of RPC) chain.setFault(u, null)
  const before = n.all
  assert.ok((await api.chain.channelKeys(Y.container)).x25519)
  assert.ok(n.all > before)
  // a revert still is: NOT_FOUND, cached / 回滚仍然是：NOT_FOUND，并缓存
  await assert.rejects(api.chain.channelKeys(C(0xdead)), (e) => e.code === 'NOT_FOUND')
  await assert.rejects(api.chain.tapeSendKey(C(0xdead)), (e) => e.code === 'NOT_FOUND')
  for (const u of RPC) chain.setFault(u, 'rpcerror')
  await assert.rejects(api.chain.tapeSendKey(C(0xbeef)), (e) => e.code === 'RPC_ERROR', 'tapeSendKey shares tokenOf')
  for (const u of RPC) chain.setFault(u, null)
})

test('FIXED R2-6: a factory address with no code is a configuration error, never a verdict about the container', async () => {
  const chain = createFakeChain({ chainId: 97 })
  const c = C(0xc0de)
  chain.setContainerToken(c, { tokenId: 1 }); chain.setAccount(1, c); chain.setOwner(1, sig.privateKeyToAddress(HOLDER))
  const identity = channel.generateIdentity()
  const keys = { container: c, x25519: hex(identity.x25519.publicKey), ed25519: hex(identity.ed25519.publicKey), inbox: {}, issued: nowS() - 60, expires: nowS() + 30 * 86400 }
  chain.writeFile(c, CHANNEL_KEYS_KEY, canonicalJSON({ tapechannel: '1', chainId: 97, ...keys, sig: sig.signDigest(sig.channelKeysDigest(97, ADDR.hub, keys), HOLDER) }))
  // a chain-97 client with no `factory` asks the mainnet address; on a real chain 97 it has no code: model that
  // 链 97 的客户端没传 `factory`，就会去问主网地址；真实的 97 链上那里没有代码：照此模拟
  const { MAINNET } = await import('../src/index.js')
  const { n, fetch } = counted(chain)
  const noCode = (url, init) => { const b = JSON.parse(init.body); return b.method === 'eth_call' && String(b.params[0].to).toLowerCase() === MAINNET.factory.toLowerCase() ? new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result: '0x' }), { headers: { 'content-type': 'application/json' } }) : fetch(url, init) }
  const api97 = createTapeAPI({ rpcUrls: RPC, quorum: 2, chainId: 97, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, fetch: noCode })
  const config = (e) => e.code === 'BAD_KEY' && /no code on chain 97/.test(e.message) && /opts\.factory/.test(e.message)
  await assert.rejects(api97.chain.channelKeys(c), config)
  const before = n.all
  await assert.rejects(api97.chain.channelKeys(c), config, 'not cached as a negative answer')
  assert.ok(n.all > before)
  await assert.rejects(api97.groupVerifier()({ container: c, chainId: 97, x25519: keys.x25519, ed25519: keys.ed25519 }), config, 'the verifier throws: nobody is dropped for it')
  assert.equal((await createTapeAPI({ rpcUrls: RPC, quorum: 2, chainId: 97, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, factory: ADDR.factory, fetch: noCode }).chain.channelKeys(c)).x25519, keys.x25519, 'with opts.factory it resolves')
  // on chain 56, a wrong factory is caught the same way (the fake answers isCPU only at ADDR.factory and the mainnet address)
  // 56 链上配错工厂同样被发现（假链只在 ADDR.factory 与主网地址回答 isCPU）
  const chain56 = createFakeChain()
  const Y = container(chain56, 3)
  await assert.rejects(client(chain56, chain56.fetch, { factory: '0x' + '81'.repeat(20) }).chain.channelKeys(Y.container), (e) => e.code === 'BAD_KEY' && /no code on chain 56/.test(e.message))
  assert.ok((await client(chain56, chain56.fetch, { factory: ADDR.factory }).chain.channelKeys(Y.container)).x25519)
  // and on the manifest path (TAP-20 §3.6 step 3): BAD_KEY, not MANIFEST_INVALID / 清单路径上同样是 BAD_KEY，而不是 MANIFEST_INVALID
  const { MANIFEST_KEY } = await import('../src/index.js')
  const { privateKeyToAddress: addrOf, signDigest: signD, delegationDigest: delD } = await import('../src/sig.js')
  const HK = '0x' + '11'.repeat(32), signerA = addrOf('0x' + '22'.repeat(32)), exp = nowS() + 86400
  chain56.setOwner(4246, addrOf(HK)); chain56.setAccount(4246, ADDR.container)
  chain56.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify({
    tapeapi: '0.1', name: 'R26', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer: signerA,
    delegation: { expires: exp, sig: signD(delD(56, ADDR.hub, { container: ADDR.container, signer: signerA, expires: exp }), HK) },
    endpoints: { live: ['https://api.example.com/tapeapi/v1'], async: false }, methods: [{ name: 'ping', priceBEM: '0', params: {}, returns: {} }],
  }))
  assert.ok((await client(chain56, chain56.fetch, { factory: ADDR.factory }).resolve(ADDR.container)).manifest)
  await assert.rejects(client(chain56, chain56.fetch, { factory: '0x' + '81'.repeat(20) }).resolve(ADDR.container), (e) => e.code === 'BAD_KEY' && /no code on chain 56/.test(e.message))
})

test('FIXED R2-N2: a channel record whose keys lack the 0x prefix is refused (TAP-26 §3.1 "0x<64 hex>"), not accepted and then never matched', async () => {
  const chain = createFakeChain()
  const c = C(0xc0df)
  chain.setContainerToken(c, { tokenId: 7 }); chain.setAccount(7, c); chain.setOwner(7, sig.privateKeyToAddress(HOLDER))
  const identity = channel.generateIdentity()
  for (const [x, e] of [[channel.toHex(identity.x25519.publicKey), hex(identity.ed25519.publicKey)], [hex(identity.x25519.publicKey), channel.toHex(identity.ed25519.publicKey)]]) {
    const keys = { container: c, x25519: x, ed25519: e, inbox: {}, issued: nowS() - 60, expires: nowS() + 30 * 86400 }
    chain.writeFile(c, CHANNEL_KEYS_KEY, canonicalJSON({ tapechannel: '1', chainId: 56, ...keys, sig: sig.signDigest(sig.channelKeysDigest(56, ADDR.hub, keys), HOLDER) }))
    await assert.rejects(client(chain, chain.fetch).chain.channelKeys(c), (err) => err.code === 'CHANNEL_INVALID' && /0x/.test(err.message))
  }
})

// ================================================================================================= R3 ====
// Third-round review (review R3-n). / 第三轮审查。
const rpcAnswer = (b, code, message) => new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, error: { code, message } }), { headers: { 'content-type': 'application/json' } })
const { selector: selectorOf, signatureOf } = await import('../src/abi.js')
// Every node answers `message` (-32000) to eth_calls whose selector is `fn` / 每个节点对选择器为 `fn` 的 eth_call 答 `message`
function failCall(chain, fn, message = 'header not found') {
  const sel = selectorOf(signatureOf(fn))
  const s = { on: true }
  s.fetch = (url, init) => { const b = JSON.parse(init.body); if (Array.isArray(b)) return eachCall(url, init, s.fetch); return s.on && b.method === 'eth_call' && String(b.params[0].data).startsWith(sel) ? rpcAnswer(b, -32000, message) : chain.fetch(url, init) }
  return s
}

test('FIXED R3-1: an archive node answering a transient JSON-RPC error on eth_getLogs is never taken for one that serves no logs: the cursor holds and the frame comes once it recovers', async () => {
  for (const [code, message] of [[-32000, 'header not found'], [-32000, 'invalid block range params'], [-32602, 'unknown block']]) {
    const chain = createFakeChain()
    chain.setFault('http://rpc1', 'history:5000')        // publicnode-style window / publicnode 式窗口
    chain.setFault('http://rpc2', 'nologs')              // dataseed-style / dataseed 式
    let lagging = true                                   // rpc3: the archive node, a lagging LB backend / 归档节点，负载均衡后端落后
    const fetch = (url, init) => { const b = JSON.parse(init.body); return lagging && url === 'http://rpc3' && b.method === 'eth_getLogs' ? rpcAnswer(b, code, message) : chain.fetch(url, init) }
    const rpc = createRpc({ urls: RPC3, quorum: 2, fetch })
    const head = chain.state.block
    const room = 'a4'.repeat(32)
    const poster = busTransport({ rpc: createRpc({ urls: RPC3, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
    const old = Uint8Array.of(0x02, 1), recent = Uint8Array.of(0x02, 2)
    await postAt(chain, poster, head - 8000, old)        // only rpc3 has it / 只有 rpc3 有
    await postAt(chain, poster, head - 100, recent)
    const warns = []
    const t = busTransport({ rpc, bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head - 15_000, confirmations: 0, warn: (m, d) => warns.push(d) })
    for (let k = 1; k <= 2; k++) await assert.rejects(t.poll(), (e) => e.code === 'RPC_UNAVAILABLE' && /node#2/.test(e.message), `"${message}": poll ${k} holds`)
    assert.equal(t.cursor, head - 15_000, `"${message}": the cursor holds`)
    assert.deepEqual(warns, [], `"${message}": no gap`)
    lagging = false
    assert.deepEqual(await t.poll(), [old, recent], `"${message}": delivered once the node recovers`)
    assert.deepEqual(warns, [])
  }
  // Only an allowlisted answer means "serves no logs" -- and only from the poll AFTER the one that reached it: a node
  // answering -32601 "method not found" holds one poll, then the blocks nobody serves are a gap.
  // 只有白名单里的回答才表示"不提供日志"，而且要到得出结论之后的那次轮询才生效：答 -32601 的节点先让游标停一次，之后才算空洞。
  for (const [code, message] of [[-32601, 'the method eth_getLogs does not exist/is not available'], [-32000, 'eth_getLogs is disabled on this node']]) {
    const chain = createFakeChain()
    chain.setFault('http://rpc1', 'history:5000'); chain.setFault('http://rpc2', 'nologs')
    const fetch = (url, init) => { const b = JSON.parse(init.body); return url === 'http://rpc3' && b.method === 'eth_getLogs' ? rpcAnswer(b, code, message) : chain.fetch(url, init) }
    const head = chain.state.block
    const room = 'a4'.repeat(32)
    const poster = busTransport({ rpc: createRpc({ urls: RPC3, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
    const recent = Uint8Array.of(0x02, 2)
    await postAt(chain, poster, head - 100, recent)
    const warns = []
    const t = busTransport({ rpc: createRpc({ urls: RPC3, quorum: 2, fetch }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head - 15_000, confirmations: 0, warn: (m, d) => warns.push(d) })
    await assert.rejects(t.poll(), (e) => e.code === 'RPC_UNAVAILABLE', `"${message}": the poll that reaches the verdict holds`)
    assert.deepEqual(warns, [])
    assert.deepEqual(await t.poll(), [recent], `"${message}": the next one reads on`)
    assert.equal(warns.length, 1)
  }
})

test('FIXED R3-2: a window that slides 2 or 3 blocks a request while it is walked: every block above the gap is read, every block in the gap was refused', async () => {
  for (const s of [2, 3]) {
    const chain = createFakeChain()
    const head = chain.state.block
    const W = head - 5000
    chain.setFault('http://rpc2', 'nologs')
    let n = 0
    let refusedTop = -Infinity                           // the highest fromBlock rpc1 refused: every block up to it is gone / rpc1 拒绝过的最高起始区块
    const served = new Set()                             // blocks rpc1 answered at some point / rpc1 回答过的区块
    const fetch = (u, init) => {
      const b = JSON.parse(init.body)
      if (u === 'http://rpc1' && b.method === 'eth_getLogs') {
        const from = Number(BigInt(b.params[0].fromBlock))
        if (from < W + (++n) * s) { refusedTop = Math.max(refusedTop, from); return refuseOld(b) }
        for (let k = from; k <= Number(BigInt(b.params[0].toBlock)); k++) served.add(k)
      }
      return chain.fetch(u, init)
    }
    const room = 'a6'.repeat(32)
    const poster = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
    const K = 300
    for (let k = 0; k < K; k++) await postAt(chain, poster, W + k, Uint8Array.of(0x02, k & 0xff, k >> 8))
    const warns = []
    const t = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head - 5100, confirmations: 0, warn: (m, d) => warns.push(d) })
    const got = []
    for (let p = 0; p < 4 && t.cursor <= head; p++) {
      try { got.push(...(await t.poll()).map((w) => w[1] | (w[2] << 8))) } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE') }
    }
    assert.equal(t.cursor, head + 1, `slide ${s}: the reader got through`)
    const gapTo = Math.max(...warns.map((w) => w.to))
    assert.ok(gapTo <= refusedTop, `slide ${s}: blocks up to ${gapTo - W} declared a gap, but rpc1 only ever refused up to ${refusedTop - W}`)
    const want = [...Array(K).keys()].filter((k) => W + k > gapTo)
    assert.ok(want.length > 100, `slide ${s}: the test still has frames to lose (${want.length})`)
    assert.deepEqual(got.filter((k) => W + k > gapTo), want, `slide ${s}: every frame above the gap, once, in order`)
    // Changed in review R4-2: a frame inside the gap's span that a probe read DID serve is delivered now (it used to be
    // dropped), once, in order. / R4-2 起：探测时确实读到的、位于空洞范围内的帧现在也会交出（以前被丢弃），一次、按顺序。
    assert.deepEqual(got, [...new Set(got)].sort((x, y) => x - y), `slide ${s}: once, in order`)
    assert.ok(got.every((k) => W + k > gapTo || served.has(W + k)), `slide ${s}: below the gap only what rpc1 served`)
  }
})

test('FIXED R3-3: SiteRegistry.read() failing on every node with "header not found" is not "no file": nothing negative is cached, the verifier throws, rotate drops nobody', async () => {
  const chain = createFakeChain()
  const f = failCall(chain, 'read')
  const api = client(chain, f.fetch)
  const A2 = container(chain, 1)
  const B2 = container(chain, 2)
  const verify = api.groupVerifier()
  f.on = false
  const { group: owner } = await G.createGroup({ self: A2, identity: A2.identity, members: [entry(B2)], bus: BUS, verifyMember: verify })
  f.on = true
  await assert.rejects(api.chain.channelKeys(B2.container, { fresh: true }), (e) => e.code === 'RPC_ERROR' && /header not found/.test(e.message))
  await assert.rejects(verify(entry(B2), { fresh: true }), (e) => e.code === 'RPC_ERROR', 'the verifier throws instead of answering false')
  await assert.rejects(owner.rotate(), (e) => /header not found/.test(e.message))
  assert.equal(owner.members.length, 2, 'nobody was dropped')
  f.on = false
  assert.equal(await verify(entry(B2)), true, 'nothing negative was cached')
  assert.deepEqual((await owner.rotate()).dropped, [])
  // a file that is not there still is a definitive answer (mainnet read() reverts with 0x2a9df442)
  // 真没有文件仍是确定的回答（主网 read() 以 0x2a9df442 回滚）
  const N = container(chain, 3, { record: false })
  await assert.rejects(api.chain.channelKeys(N.container), (e) => e.code === 'CHANNEL_INVALID')
})

// A paid service at ADDR.container with a directory configured / ADDR.container 上的付费服务，配置了目录
function paidService(chain) {
  const HK = '0x' + '11'.repeat(32), signerA = sig.privateKeyToAddress('0x' + '22'.repeat(32)), exp = nowS() + 86400
  chain.setOwner(4246, sig.privateKeyToAddress(HK)); chain.setAccount(4246, ADDR.container)
  chain.register({ label: 'r3', container: ADDR.container, tokenId: 4246 })
  chain.writeFile(ADDR.container, '/.well-known/tapeapi.json', JSON.stringify({
    tapeapi: '0.1', name: 'R33', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer: signerA,
    delegation: { expires: exp, sig: sig.signDigest(sig.delegationDigest(56, ADDR.hub, { container: ADDR.container, signer: signerA, expires: exp }), HK) },
    endpoints: { live: ['https://api.example.com/tapeapi/v1'], async: false }, methods: [{ name: 'ping', priceBEM: '0', params: {}, returns: {} }],
    payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 },
  }))
}

test('FIXED R3-3: on the manifest path a JSON-RPC error that is not a revert (read, ownerOf, contributionOf, serviceOf) is an error, never MANIFEST_INVALID nor a quiet default', async () => {
  const chain = createFakeChain()
  paidService(chain)
  chain.setContribution(ADDR.container, 100)
  const opts = { directory: ADDR.directory, escrow: ADDR.escrow }
  const svc = await client(chain, chain.fetch, opts).resolve(ADDR.container)
  assert.equal(svc.contribution, 100)
  assert.ok(chain.state.calls.some((c) => c.name === 'serviceOf'), 'the directory record is read')
  for (const fn of ['read', 'ownerOf', 'contributionOf', 'serviceOf']) {
    const f = failCall(chain, fn)
    await assert.rejects(client(chain, f.fetch, opts).resolve(ADDR.container), (e) => e.code === 'RPC_ERROR' && /header not found/.test(e.message), `${fn}: an RPC failure propagates`)
  }
  // reverts keep their meaning: an escrow without contributionOf is 0 (flow.test), a missing token is MANIFEST_INVALID
  // 回滚保持原义：没有 contributionOf 的托管为 0（见 flow.test），不存在的 token 为 MANIFEST_INVALID
  chain.state.owners.delete('4246')
  await assert.rejects(client(chain, chain.fetch, opts).resolve(ADDR.container), (e) => e.code === 'MANIFEST_INVALID' && /ownerOf/.test(e.message))
})

test('FIXED R3-4: "execution reverted" on one node and "header not found" (same -32000) on the other is not a revert, in either order', async () => {
  for (const order of [['execution reverted', 'header not found'], ['header not found', 'execution reverted']]) {
    const chain = createFakeChain()
    const Y = container(chain, 5)
    let flaky = true
    const fetch = (url, init) => { const b = JSON.parse(init.body); return flaky && b.method === 'eth_call' && String(b.params[0].to).toLowerCase() === Y.container ? rpcAnswer(b, -32000, url === 'http://rpc1' ? order[0] : order[1]) : chain.fetch(url, init) }
    const api = client(chain, fetch)
    await assert.rejects(api.groupVerifier()(entry(Y)), (e) => e.code !== 'NOT_FOUND' && e.code !== 'CHANNEL_INVALID', `${order}: the verifier throws, it does not answer false`)
    flaky = false
    assert.equal((await api.chain.channelKeys(Y.container)).x25519, entry(Y).x25519, `${order}: no NOT_FOUND was cached`)
  }
  // rpc.js: `rpcRevert` only when every node's error is revert-shaped / 只有每个节点的错误都是回滚形态时才标 rpcRevert
  const rpcOf = (a, b, code = -32000) => createRpc({ urls: RPC, quorum: 2, disagreeRetryMs: 0, fetch: (url, init) => rpcAnswer(JSON.parse(init.body), code, url === 'http://rpc1' ? a : b) })
  for (const [a, b] of [['execution reverted', 'header not found'], ['header not found', 'execution reverted']]) {
    await assert.rejects(rpcOf(a, b).call('eth_call', []), (e) => e.code === 'RPC_DISAGREE', `${a} / ${b}`)
  }
  await assert.rejects(rpcOf('execution reverted', 'VM execution error: reverted').call('eth_call', []), (e) => e.code === 'RPC_ERROR' && e.rpcRevert === true)
  await assert.rejects(rpcOf('execution reverted', 'execution reverted', 3).call('eth_call', []), (e) => e.code === 'RPC_ERROR' && e.rpcRevert === true)
  await assert.rejects(rpcOf('header not found', 'header not found').call('eth_call', []), (e) => e.code === 'RPC_ERROR' && e.rpcRevert !== true)
})

test('FIXED R3-7: a node that never comes back keeps the cursor held (safe), and after 10 holds `warn` says so once, naming the node by index, the blocks, and the way out', async () => {
  const chain = createFakeChain()
  chain.setFault('http://rpc1', 'history:5000'); chain.setFault('http://rpc2', 'nologs')
  const fetch = (u, init) => (u === 'http://rpc3' ? new Response('unauthorized', { status: 401 }) : chain.fetch(u, init))   // an expired key / 过期的 key
  const head = chain.state.block
  const warns = []
  const t = busTransport({ rpc: createRpc({ urls: RPC3, quorum: 2, fetch }), bus: BUS, inbound: roomN(9), outbound: '00'.repeat(32), fromBlock: head - 6000, confirmations: 0, warn: (m, d) => warns.push({ m, d }) })
  for (let i = 1; i <= 12; i++) {
    await assert.rejects(t.poll(), (e) => e.code === 'RPC_UNAVAILABLE')
    assert.equal(warns.length, i < 10 ? 0 : 1, `after ${i} holds`)
    chain.mine(3)
  }
  assert.equal(t.cursor, head - 6000, 'still held: a dead node is never taken for one that serves nothing')
  const [{ m, d }] = warns
  assert.match(m, /node#2\b/)
  assert.ok(!/rpc3|http/.test(m), 'never a node URL or host')
  assert.match(m, /fromBlock/)
  assert.match(m, /remove/)
  assert.deepEqual(d.nodes, [2])
  assert.equal(d.from, head - 6000 - 16)
  assert.ok(d.to >= d.from)
})

test('FIXED R3-8 (as changed by R4-7): busReader: remove() then add() of a room while a poll is in flight reads its past again, never loses it; add(known room, { fromBlock }) reads from there', async () => {
  const chain = createFakeChain()
  const rpc = createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch })
  const head = chain.state.block
  const [r1, r2] = [roomN(1), roomN(2)]
  const poster = busTransport({ rpc, bus: BUS, inbound: '00'.repeat(32), outbound: r2, sendTx: async (tx) => chain.submit(tx) })
  const w = Uint8Array.of(0x02, 42)
  await postAt(chain, poster, head - 100, w)
  const reader = busReader({ rpc, bus: BUS, rooms: [r1, r2], confirmations: 0 })
  const got = [...await reader.poll()]
  chain.mine(1)
  const p = reader.poll(); reader.remove(r2); reader.add(r2)          // in flight / 在途
  got.push(...await p); chain.mine(1); got.push(...await reader.poll()); chain.mine(1); got.push(...await reader.poll())
  // Changed by review R4-7: a room removed and added again is a new room whose past is read again, so the frame may come
  // twice (§3.4's sequence check refuses the copy); the R3-8 special case could lose that past for good.
  // R4-7 起：移除后又加入的房间是新房间，过去会再读一次，帧可能来两次（§3.4 的序号检查拒绝副本）；R3-8 的特例可能永久丢掉过去。
  const r2got = got.filter((x) => x.room === r2).map((x) => x.wire)
  assert.ok(r2got.length >= 1 && r2got.length <= 2 && r2got.every((x) => x[1] === 42), 'at least once, at most twice')
  // a known room with an explicit fromBlock / 已知房间带显式 fromBlock
  const old = Uint8Array.of(0x02, 7)
  await postAt(chain, poster, head - 2000, old)                         // outside the 600-block lookback / 在 600 区块回看之外
  const reader2 = busReader({ rpc, bus: BUS, rooms: [r2], confirmations: 0 })
  reader2.add(r2, null, { fromBlock: head - 2100 })
  const got2 = [...await reader2.poll()]; chain.mine(1); got2.push(...await reader2.poll())
  assert.ok(got2.some((x) => x.room === r2 && x.wire[1] === 7), 'fromBlock is honoured')
  assert.equal(got2.filter((x) => x.wire[1] === 42).length, 1, 'and the frame inside the lookback comes once')
})

// ================================================================================================= R4 ====
// Fourth-round review: the scanner rebuilt as `walk` (each node on its own) + `_busMerge` (one pure predicate).
// 第四轮审查：扫描器重建为 `walk`（每个节点各自读取）+ `_busMerge`（一个纯函数判定）。
const { readFileSync } = await import('node:fs')
const ANSWERS = JSON.parse(readFileSync(new URL('./fixtures/bsc-getlogs-answers.json', import.meta.url), 'utf8')).answers
// A recorded answer, replayed with the request's id / 以请求的 id 重放记录下的回答
const recorded = (a, id) => new Response(JSON.stringify({ ...a.body, id }), { status: a.status, headers: { 'content-type': a.contentType } })
const LIMIT = (b) => rpcAnswer(b, -32005, 'limit exceeded')   // what the bsc-dataseed nodes answer / bsc-dataseed 节点的回答
const hx = (n) => '0x' + n.toString(16)

test('FIXED R4-1: a JSON-RPC error sent with an HTTP error status is read (bounded) and kept as a refusal; a non-JSON body is a plain HTTP failure; a 403 is never a disagreement', async () => {
  const [old403] = ANSWERS
  const one = (fetch, o = {}) => createRpc({ urls: ['https://bsc-rpc.publicnode.com'], quorum: 1, fetch, ...o })
  await assert.rejects(one(async (_u, init) => recorded(old403, JSON.parse(init.body).id)).call('eth_getLogs', [{}]),
    (e) => e.code === 'RPC_UNAVAILABLE' && e.refusals?.[0]?.code === -32602 && /^Archive requests/.test(e.refusals[0].message) && /http 403/.test(e.message))
  // Cloudflare's HTML 520: nothing the node said / Cloudflare 的 HTML 520：没有节点原话
  await assert.rejects(one(async () => new Response('<html>520</html>', { status: 520, headers: { 'content-type': 'text/html' } })).call('eth_getLogs', [{}]),
    (e) => e.code === 'RPC_UNAVAILABLE' && e.refusals === undefined && /http 520/.test(e.message))
  // the body is read with the same cap as any answer / 响应体与任何回答同样有上限
  await assert.rejects(one(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'x'.repeat(5000) } }), { status: 403, headers: { 'content-type': 'application/json' } }), { bodyLimit: 1000 }).call('eth_getLogs', [{}]),
    (e) => e.code === 'RPC_UNAVAILABLE' && e.refusals === undefined && /http 403/.test(e.message))
  // A 403 from one node on an eth_call is "did not answer": two others agree and the call succeeds (never RPC_DISAGREE)
  // 一个节点对 eth_call 返回 403 是"没有作答"：另两个一致即成功，绝不是分歧
  const urls = ['http://rpc1', 'http://rpc2', 'http://rpc3']
  const f = async (url, init) => { const b = JSON.parse(init.body); return url === 'http://rpc3' ? recorded(old403, b.id) : new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result: '0x01' }), { headers: { 'content-type': 'application/json' } }) }
  assert.equal(await createRpc({ urls, quorum: 2, disagreeRetryMs: 0, fetch: f }).ethCall('0x' + '11'.repeat(20), '0x'), '0x01')
  await assert.rejects(createRpc({ urls, quorum: 3, disagreeRetryMs: 0, fetch: f }).ethCall('0x' + '11'.repeat(20), '0x'), (e) => e.code === 'RPC_UNAVAILABLE' && e.refusals?.[0]?.code === -32602)
})

test('FIXED R4-1: the recorded BSC answers replayed through rpc.js and the scanner: the default node set, cursor older than the window, advances with one warning and loses nothing inside it', async () => {
  const [pnOld, pnRecent, pnPruned, ds1, ds2] = ANSWERS
  assert.deepEqual([pnOld.status, pnRecent.status, pnPruned.status, ds1.status, ds2.status], [403, 200, 200, 200, 200], 'the fixture as recorded')
  const chain = createFakeChain()
  const head = chain.state.block
  const WINDOW = 5200
  const URLS = ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io']
  let lagging = false        // publicnode answering "pruned" to every read: its answer for blocks past its head / 对一切读取答 "pruned"
  const fetch = async (url, init) => {
    const b = JSON.parse(init.body)
    if (b.method !== 'eth_getLogs') return chain.fetch('http://node', init)
    if (url === URLS[1]) return recorded(ds1, b.id)
    if (url === URLS[2]) return recorded(ds2, b.id)
    const from = Number(BigInt(b.params[0].fromBlock))
    if (lagging || from > chain.state.block) return recorded(pnPruned, b.id)
    if (from < chain.state.block - WINDOW) return recorded(pnOld, b.id)
    return chain.fetch('http://node', init)             // 200 and the logs (the recorded 200 [] with content) / 200 加日志
  }
  // How the scanner reads each recorded refusal / 扫描器如何理解每个记录下的拒绝
  const kind = async (u, x, y) => { try { await createRpc({ urls: [u], quorum: 1, fetch }).call('eth_getLogs', [{ address: BUS, fromBlock: hx(x), toBlock: hx(y) }]); return null } catch (e) { return channel._busKindOf(e) } }
  const k0 = await kind(URLS[0], head - 20_000, head - 19_001)
  assert.deepEqual([k0.history, k0.range, k0.noLogs, k0.refusal.code], [true, false, false, -32602], 'publicnode 20,000 blocks back: too old')
  assert.equal((await kind(URLS[0], head + 1000, head + 1000)).history, true, '-32701 "pruned" reads as history too (the probe keeps it from making a floor)')
  for (const u of URLS.slice(1)) { const k = await kind(u, head, head); assert.deepEqual([k.noLogs, k.history, k.refusal.code], [true, false, -32005], `${u}: serves no logs`) }
  assert.equal(await kind(URLS[0], head - 100, head), null, 'a recent range is served')
  // The whole default set / 整个默认节点组合
  const room = 'b1'.repeat(32)
  const poster = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
  const lost = Uint8Array.of(0x02, 1), edge = Uint8Array.of(0x02, 2), recent = Uint8Array.of(0x02, 3)
  await postAt(chain, poster, head - 8000, lost); await postAt(chain, poster, head - WINDOW, edge); await postAt(chain, poster, head - 100, recent)
  const warns = []
  const t = busTransport({ rpc: createRpc({ urls: URLS, quorum: 2, fetch }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head - 20_000, confirmations: 0, warn: (m, d) => warns.push(d) })
  const got = []
  let polls = 0
  for (; polls < 5 && t.cursor <= head; polls++) { try { got.push(...await t.poll()) } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE') } }
  assert.equal(t.cursor, head + 1, 'never stalls: before R4-1 every poll failed with "http 403", silently, for ever')
  assert.equal(polls, 2, 'one hold (verdicts learnt), then on')
  assert.deepEqual(got, [edge, recent], 'everything inside the window, once, in order')
  assert.deepEqual(warns, [{ from: head - 20_000 - 16, to: head - WINDOW - 1, oldestServed: head - WINDOW }], 'one warning')
  assert.deepEqual(t.stats().nodes.map((n) => [n.oldestServed, n.servesLogs]), [[head - WINDOW, true], [null, false], [null, false]])
  // publicnode refusing even the head as "pruned" (a lagging backend) is failing, not history-limited: it holds
  // publicnode 连链头都答 "pruned"（后端落后）是出故障，不是历史受限：停住
  lagging = true
  const w2 = []
  const t2 = busTransport({ rpc: createRpc({ urls: URLS, quorum: 2, fetch }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head - 20_000, confirmations: 0, warn: (m, d) => w2.push(d) })
  for (let p = 0; p < 3; p++) await assert.rejects(t2.poll(), (e) => e.code === 'RPC_UNAVAILABLE' && /next poll/.test(e.message))
  assert.equal(t2.cursor, head - 20_000)
  assert.deepEqual(w2, [])
  assert.equal(t2.stats().nodes[0].oldestServed, null)
})

test('FIXED R4-2: what a node served during a hold is kept: a window that slides before the next poll cannot take it away; probe reads are kept too', async () => {
  const chain = createFakeChain()
  const head = chain.state.block
  let edge = head - 5000                                  // the oldest block rpc1 serves, moved by the test / rpc1 提供的最早区块，由测试移动
  const fetch = (u, init) => {
    const b = JSON.parse(init.body)
    if (b.method === 'eth_getLogs') { if (u !== 'http://rpc1') return LIMIT(b); if (Number(BigInt(b.params[0].fromBlock)) < edge) return refuseOld(b) }
    return chain.fetch(u, init)
  }
  const room = 'b2'.repeat(32)
  const poster = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
  const K = 100
  for (let k = 0; k < K; k++) await postAt(chain, poster, edge + k, Uint8Array.of(0x02, k))
  const warns = []
  const t = busTransport({ rpc: createRpc({ urls: RPC3, quorum: 2, fetch }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: edge - 500, confirmations: 0, warn: (m, d) => warns.push(d) })
  await assert.rejects(t.poll(), (e) => e.code === 'RPC_UNAVAILABLE' && /next poll/.test(e.message))   // verdicts learnt this poll: hold once / 本次得出结论：停一次
  edge += 50                                               // the window slides past half the frames meanwhile / 期间窗口滑过一半的帧
  assert.deepEqual((await t.poll()).map((w) => w[1]), [...Array(K).keys()], 'the 50 frames the window slid past come from the hold poll (they used to be thrown away)')
  assert.equal(t.cursor, head + 1)
  assert.equal(warns.length, 1)
  assert.equal(warns[0].to, head - 5000 - 1, 'the gap ends below the first frame')
  // Probe reads: a window sliding one block per request (R3-2's model); every block whose log rpc1 returned is delivered
  // 探测读取：窗口每个请求滑动一个区块；rpc1 返回过日志的每个区块都被交出
  for (const slide of [1, 3]) {
    const c2 = createFakeChain()
    const h2 = c2.state.block
    const W = h2 - 5000
    let n = 0
    const returned = new Set()
    const f2 = async (u, init) => {
      const b = JSON.parse(init.body)
      if (b.method === 'eth_getLogs' && u === 'http://rpc2') return LIMIT(b)
      if (b.method === 'eth_getLogs') {
        if (Number(BigInt(b.params[0].fromBlock)) < W + (++n) * slide) return refuseOld(b)
        const res = await c2.fetch(u, init)
        for (const l of (await res.clone().json()).result) returned.add(Number(BigInt(l.blockNumber)))
        return res
      }
      return c2.fetch(u, init)
    }
    const p2 = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: c2.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => c2.submit(tx) })
    for (let k = 0; k < 300; k++) await postAt(c2, p2, W + k, Uint8Array.of(0x02, k & 0xff, k >> 8))
    const t2 = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: f2 }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: h2 - 5100, confirmations: 0, warn: () => {} })
    const got = []
    for (let p = 0; p < 4 && t2.cursor <= h2; p++) { try { got.push(...(await t2.poll()).map((w) => W + (w[1] | (w[2] << 8)))) } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE') } }
    assert.equal(t2.cursor, h2 + 1, `slide ${slide}: through`)
    assert.deepEqual([...returned].filter((x) => !got.includes(x)), [], `slide ${slide}: every block a node returned was delivered`)
    assert.deepEqual(got, [...new Set(got)].sort((x, y) => x - y), `slide ${slide}: once, in order`)
  }
})

test('FIXED R4-3: "too old" and "too wide" are read only from what a node said: a host called "archive…" that times out holds, it is never "too old"', async () => {
  const urls = ['http://bsc-archive.rpc', 'http://rpc2', 'http://rpc3']
  const chain = createFakeChain()
  const head = chain.state.block
  let cold = true                                         // the archive node is slow on old blocks (cold storage) / 归档节点读旧区块慢
  const fetch = (u, init) => {
    const b = JSON.parse(init.body)
    if (b.method === 'eth_getLogs' && u !== urls[0]) return LIMIT(b)
    if (cold && b.method === 'eth_getLogs' && Number(BigInt(b.params[0].fromBlock)) < head - 3000) return new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    return chain.fetch(u, init)
  }
  const room = 'b3'.repeat(32)
  const poster = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
  const old = Uint8Array.of(0x02, 1), recent = Uint8Array.of(0x02, 2)
  await postAt(chain, poster, head - 3500, old); await postAt(chain, poster, head - 100, recent)
  const warns = []
  const t = busTransport({ rpc: createRpc({ urls, quorum: 2, fetch, timeoutMs: 30 }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head - 4000, confirmations: 0, warn: (m, d) => warns.push(d) })
  for (let p = 1; p <= 3; p++) await assert.rejects(t.poll(), (e) => e.code === 'RPC_UNAVAILABLE' && /next poll/.test(e.message), `poll ${p} holds`)
  assert.equal(t.cursor, head - 4000, 'a timeout is not a verdict')
  assert.deepEqual(warns.filter((d) => 'oldestServed' in d), [], 'no gap')
  assert.equal(t.stats().nodes[0].oldestServed, null)
  assert.equal(t.stats().nodes[0].span, 1000, 'nor "too wide"')
  cold = false
  assert.deepEqual(await t.poll(), [old, recent])
  // the classifier itself: a transport failure naming such a host is nothing at all / 分类本身：点名这种主机的传输失败什么都不是
  const k = channel._busKindOf(new TapeAPIError('RPC_UNAVAILABLE', 'eth_getLogs: only 0/1 nodes answered (node#0(archive-history-range-limit.example): http 500)'))
  assert.deepEqual([k.refusal, k.history, k.range, k.noLogs], [null, false, false, false])
})

test('FIXED R4-4: nodes are walked independently -- a slow node paces nobody -- and a per-node budget bounds a poll without skipping', async () => {
  const chain = createFakeChain()
  const head = chain.state.block
  let release; const gate = new Promise((r) => { release = r })
  const asked = { 'http://rpc1': 0, 'http://rpc2': 0 }
  const fetch = async (u, init) => { const b = JSON.parse(init.body); if (b.method === 'eth_getLogs') { asked[u]++; if (u === 'http://rpc2') await gate } return chain.fetch(u, init) }
  const room = 'b4'.repeat(32)
  const poster = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
  const w = Uint8Array.of(0x02, 4)
  await postAt(chain, poster, head - 50, w)
  // 300 blocks in 100-block chunks / 300 个区块，每块 100
  const t = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch, timeoutMs: 5000 }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head - 283, chunk: 100, minChunk: 40, confirmations: 0 })
  const p = t.poll()
  for (let k = 0; k < 100 && asked['http://rpc1'] < 3; k++) await sleep(2)
  assert.equal(asked['http://rpc1'], 3, 'rpc1 read all three chunks while rpc2 sat on its first request (it used to wait for rpc2 at every chunk)')
  assert.equal(asked['http://rpc2'], 1)
  release()
  assert.deepEqual(await p, [w])
  // The budget: the only node with logs is slow (40 ms a request) and takes 40 blocks at a time; budgetMs 150 ends each
  // poll early with what it read handed over, and the rest held -- never skipped.
  // 预算：唯一有日志的节点很慢（每请求 40 毫秒）且一次只读 40 个区块；budgetMs 150 让每次轮询提前结束，已读的交出，其余停住——绝不跳过。
  const c2 = createFakeChain()
  const h2 = c2.state.block
  const slow = async (u, init) => {
    const b = JSON.parse(init.body)
    if (b.method !== 'eth_getLogs') return c2.fetch(u, init)
    if (u === 'http://rpc2') return LIMIT(b)
    await sleep(40)
    const f = b.params[0]
    return Number(BigInt(f.toBlock)) - Number(BigInt(f.fromBlock)) + 1 > 40 ? rpcAnswer(b, -32005, 'block range too large, max 40') : c2.fetch(u, init)
  }
  const p2 = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: c2.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => c2.submit(tx) })
  const want = []
  for (let k = 0; k < 12; k++) { const wk = Uint8Array.of(0x02, k); want.push(wk); await postAt(c2, p2, h2 - 590 + k * 50, wk) }
  const t2 = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: slow, timeoutMs: 1000 }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: h2 - 584, confirmations: 0, budgetMs: 150 })
  const got = [], took = []
  let last = t2.cursor
  for (let p = 0; p < 30 && t2.cursor <= h2; p++) {
    const t0 = Date.now()
    try { got.push(...await t2.poll()) } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE') }
    took.push(Date.now() - t0)
    assert.ok(t2.cursor >= last); last = t2.cursor
  }
  assert.equal(t2.cursor, h2 + 1)
  assert.deepEqual(got, want, 'every frame, once, in order')
  assert.ok(took.length >= 3, `several polls (${took.length})`)
  assert.ok(Math.max(...took) < 150 + 40 + 250, `each poll ends near its budget (${took.join(', ')} ms)`)
  assert.throws(() => busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: c2.fetch }), bus: BUS, inbound: room, outbound: '00'.repeat(32), budgetMs: 0 }), /budgetMs/)
})

test('FIXED R4-5: logs outside the range asked for are dropped before any bookkeeping, and only what decodes is remembered: fabricated logs cannot grow the reorg memory', async () => {
  const chain = createFakeChain()
  const room = 'a8'.repeat(32)
  let polls = 0
  const fetch = async (u, init) => {
    const b = JSON.parse(init.body)
    if (u === 'http://rpc2' && b.method === 'eth_getLogs') {
      const lo = Number(BigInt(b.params[0].fromBlock))
      const far = Array.from({ length: 500 }, (_, i) => ({ address: BUS, topics: [channel.CHANNELBUS_WIRE_TOPIC, '0x' + room], data: '0x' + (polls * 500 + i).toString(16).padStart(8, '0'), blockNumber: '0x10000000000000', logIndex: hx(i), removed: false }))
      const junk = Array.from({ length: 100 }, (_, i) => ({ ...far[0], data: '0x' + (polls * 100 + i).toString(16).padStart(8, '0'), blockNumber: hx(lo), logIndex: hx(1000 + i) }))   // in range, undecodable / 区间内、无法解码
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result: [...far, ...junk] }), { headers: { 'content-type': 'application/json' } })
    }
    return chain.fetch(u, init)
  }
  const poster = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
  const t = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch }), bus: BUS, inbound: room, outbound: '00'.repeat(32), confirmations: 0 })
  const got = []
  for (polls = 0; polls < 20; polls++) { if (polls % 5 === 0) await poster.send(Uint8Array.of(0x02, polls)); chain.mine(1); got.push(...await t.poll()) }
  assert.deepEqual(got.map((w) => w[1]), [0, 5, 10, 15], 'the honest frames, once each')
  assert.ok(t.stats().remembered <= 4, `${t.stats().remembered} logs remembered (it used to be 10,000 after 20 polls)`)
})

test('FIXED R4-6: "serves no logs" releases a hold only while the node keeps saying so; a node that served lately is not believed at once, and is not trapped for good either', async () => {
  // (a) said once, then HTTP 502: that is not "serves no logs" again, so the cursor holds / 说过一次、之后 502：不算又说了一遍，停住
  const chain = createFakeChain()
  chain.setFault('http://rpc1', 'history:5000')
  const head = chain.state.block
  let down = false
  const fetch = (u, init) => { const b = JSON.parse(init.body); if (b.method === 'eth_getLogs' && u === 'http://rpc2') return down ? new Response('bad gateway', { status: 502 }) : LIMIT(b); return chain.fetch(u, init) }
  const room = 'b6'.repeat(32)
  const poster = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
  const recent = Uint8Array.of(0x02, 6)
  await postAt(chain, poster, head - 100, recent)
  const warns = []
  const t = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head - 8000, confirmations: 0, warn: (m, d) => warns.push(d) })
  await assert.rejects(t.poll(), (e) => e.code === 'RPC_UNAVAILABLE' && /next poll/.test(e.message))
  down = true
  await assert.rejects(t.poll(), (e) => e.code === 'RPC_UNAVAILABLE' && /node#1\(rpc2\)/.test(e.message), 'rpc2 did not say it again: hold (it used to skip)')
  assert.equal(t.cursor, head - 8000)
  assert.deepEqual(warns, [])
  down = false
  assert.deepEqual(await t.poll(), [recent])
  assert.equal(warns.length, 1)
  // (b) rpc3 served, then answers every read "limit exceeded": believed only after 20 polls without serving (a node that
  // served lately and says that is rate limiting), then the late room's catch-up goes on; it used to hold for ever.
  // rpc3 提供过，之后对一切读取答 "limit exceeded"：没有提供满 20 次轮询才相信（最近提供过又这么说的是限流），然后补读继续；以前永远停住。
  const c2 = createFakeChain()
  c2.setFault('http://rpc1', 'history:5000')
  const h = c2.state.block
  let turned = false
  const f2 = (u, init) => { const b = JSON.parse(init.body); if (b.method === 'eth_getLogs' && (u === 'http://rpc2' || (turned && u === 'http://rpc3'))) return LIMIT(b); return c2.fetch(u, init) }
  const [ra, rb] = [roomN(0xa1), roomN(0xa2)]
  const p2 = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: c2.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: rb, sendTx: async (tx) => c2.submit(tx) })
  const mid = Uint8Array.of(0x02, 0x3d)
  await postAt(c2, p2, h - 100, mid)
  const w2 = []
  const reader = busReader({ rpc: createRpc({ urls: RPC3, quorum: 2, fetch: f2 }), bus: BUS, rooms: [ra], fromBlock: h - 50, confirmations: 0, warn: (m, d) => w2.push(d) })
  assert.deepEqual(await reader.poll(), [], 'rpc1 and rpc3 answer everything: no hold')
  turned = true
  reader.add(rb, null, { fromBlock: h - 9000 })
  const got = []
  let polls = 0
  for (; polls < 30 && !got.length; polls++) { try { got.push(...await reader.poll()) } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE') } }
  assert.deepEqual(got, [{ room: rb, wire: mid }])
  assert.ok(polls >= 20 && polls <= 23, `${polls} polls: not at once, and not never`)
  assert.equal(w2.filter((d) => 'oldestServed' in d).length, 1, 'the gap below rpc1\'s window, once')
})

test('FIXED R4-6 (TAP-26 §3.7 "known before the current poll", both halves): a history floor learnt by a probe holds once; a floor the node later contradicts is dropped and the blocks are read', async () => {
  const chain = createFakeChain()
  chain.setFault('http://rpc1', 'history:5000'); chain.setFault('http://rpc2', 'nologs')
  const rpc = createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch })
  const head = chain.state.block
  const [ra, rb] = [roomN(0xb1), roomN(0xb2)]
  const poster = busTransport({ rpc, bus: BUS, inbound: '00'.repeat(32), outbound: rb, sendTx: async (tx) => chain.submit(tx) })
  const inside = Uint8Array.of(0x02, 0x44)
  await postAt(chain, poster, head - 4000, inside)
  const warns = []
  const reader = busReader({ rpc, bus: BUS, rooms: [ra], fromBlock: head - 50, confirmations: 0, warn: (m, d) => warns.push(d) })
  assert.deepEqual(await reader.poll(), [], 'rpc1 answers everything; rpc2 is learnt')
  assert.deepEqual(await reader.poll(), [])
  reader.add(rb, null, { fromBlock: head - 8000 })       // a catch-up below rpc1's window / 在 rpc1 窗口之下的补读
  await assert.rejects(reader.poll(), (e) => e.code === 'RPC_UNAVAILABLE' && /next poll/.test(e.message), 'the floor was learnt this poll: hold once (it used to be applied at once)')
  assert.deepEqual(warns, [])
  assert.deepEqual(await reader.poll(), [{ room: rb, wire: inside }])
  assert.deepEqual(warns, [{ from: head - 8000, to: head - 5001, oldestServed: head - 5000 }])
  // A misrouted backend says "too old" for one poll; next poll the node serves below that floor: the floor goes
  // 路由错的后端说了一次"太旧"；下一次轮询节点在该下限之下也提供了：下限作废
  const c2 = createFakeChain()
  c2.setFault('http://rpc2', 'nologs')
  const h = c2.state.block
  let misrouted = true
  const f2 = (u, init) => { const b = JSON.parse(init.body); return misrouted && u === 'http://rpc1' && b.method === 'eth_getLogs' && Number(BigInt(b.params[0].fromBlock)) < h - 5000 ? refuseOld(b) : c2.fetch(u, init) }
  const room = 'b7'.repeat(32)
  const p2 = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: c2.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => c2.submit(tx) })
  const deep = Uint8Array.of(0x02, 0x55)
  await postAt(c2, p2, h - 8000, deep)
  const w2 = []
  const t = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: f2 }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: h - 9000, confirmations: 0, warn: (m, d) => w2.push(d) })
  await assert.rejects(t.poll(), (e) => e.code === 'RPC_UNAVAILABLE' && /next poll/.test(e.message))
  misrouted = false
  assert.deepEqual(await t.poll(), [deep], 'read below the floor it gave (it used to start at the floor: the frame was lost)')
  assert.deepEqual(w2, [])
  assert.equal(t.stats().nodes[0].oldestServed, null)
})

test('FIXED R4-7: busReader catch-up bookkeeping is compare-and-set: add(room, { fromBlock }) during an in-flight catch-up stands; remove+add while the catch-up fails midway still reads the past', async () => {
  { // D
    const chain = createFakeChain()
    const head = chain.state.block
    const [r1, r2] = [roomN(1), roomN(2)]
    let release; const gate = new Promise((r) => { release = r })
    let gated = false
    const fetch = async (u, init) => { const b = JSON.parse(init.body); if (gated && b.method === 'eth_getLogs' && u === 'http://rpc1') await gate; return chain.fetch(u, init) }
    const poster = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: r2, sendTx: async (tx) => chain.submit(tx) })
    const deep = Uint8Array.of(0x02, 7)
    await postAt(chain, poster, head - 3000, deep)                  // far below the 600-block lookback / 远在 600 区块回看之外
    const reader = busReader({ rpc: createRpc({ urls: RPC, quorum: 2, fetch }), bus: BUS, rooms: [r1], confirmations: 0 })
    await reader.poll(); chain.mine(1)
    reader.add(r2)
    gated = true
    const p = reader.poll()                                         // in flight: catching r2 up from the lookback / 在途：从回看处补读 r2
    await sleep(20)
    reader.add(r2, null, { fromBlock: head - 3100 })                // the app asks for more of r2's past / 应用要求读更早的历史
    release(); gated = false
    const got = [...await p]
    for (let i = 0; i < 3; i++) { chain.mine(1); got.push(...await reader.poll()) }
    assert.ok(got.some((x) => x.room === r2 && x.wire[1] === 7), 'the explicit fromBlock stands (the in-flight poll used to overwrite it)')
  }
  { // E
    const chain = createFakeChain()
    const head = chain.state.block
    const [r1, r2] = [roomN(1), roomN(2)]
    const poster = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: r2, sendTx: async (tx) => chain.submit(tx) })
    await postAt(chain, poster, head - 590, Uint8Array.of(0x02, 1))
    await postAt(chain, poster, head - 150, Uint8Array.of(0x02, 2))
    let release; const gate = new Promise((r) => { release = r })
    let phase = 'idle'
    const fetch = async (u, init) => {
      const b = JSON.parse(init.body)
      // r2's catch-up fails on every node from head−400 on, while the poll is in flight / 在途时 r2 的补读从 head−400 起在每个节点上都失败
      if (b.method === 'eth_getLogs' && phase === 'inflight' && Number(BigInt(b.params[0].fromBlock)) >= head - 400) { await gate; return rpcAnswer(b, -32000, 'header not found') }
      return chain.fetch(u, init)
    }
    const reader = busReader({ rpc: createRpc({ urls: RPC, quorum: 2, fetch }), bus: BUS, rooms: [r1], confirmations: 0, chunk: 200, minChunk: 40 })
    await reader.poll(); chain.mine(1)
    reader.add(r2)
    phase = 'inflight'
    const p = reader.poll()
    await sleep(20)
    reader.remove(r2); reader.add(r2)                               // in flight / 在途
    release()
    const got = [...await p]
    phase = 'idle'
    for (let i = 0; i < 3; i++) { chain.mine(1); got.push(...await reader.poll()) }
    const wires = got.filter((x) => x.room === r2).map((x) => x.wire[1])
    assert.ok(wires.includes(1) && wires.includes(2), `r2's past is read (got ${wires}; the frame at head−150 used to be lost)`)
  }
})

test('FIXED R4-8: the R3-7 warning is reachable when every node fails (all unreachable: said once, after 10 holds)', async () => {
  const chain = createFakeChain()
  const head = chain.state.block
  const fetch = (u, init) => (JSON.parse(init.body).method === 'eth_getLogs' ? new Response('unauthorized', { status: 401 }) : chain.fetch(u, init))
  const warns = []
  const t = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch }), bus: BUS, inbound: roomN(0xc8), outbound: '00'.repeat(32), fromBlock: head - 100, confirmations: 0, warn: (m, d) => warns.push({ m, d }) })
  for (let i = 1; i <= 12; i++) {
    await assert.rejects(t.poll(), (e) => e.code === 'RPC_UNAVAILABLE' && /next poll/.test(e.message))
    assert.equal(warns.length, i < 10 ? 0 : 1, `after ${i} holds`)
  }
  assert.equal(t.cursor, head - 100)
  assert.deepEqual(warns[0].d.nodes, [0, 1])
  assert.equal(warns[0].d.from, head - 116)
  assert.ok(!/rpc1|rpc2|http/.test(warns[0].m), 'never a node URL or host')
})

test('FIXED R4 (restructure): _busMerge decides hold or advance from coverage and pre-poll verdicts alone', () => {
  const M = channel._busMerge
  const n = (cov = [], o = {}) => ({ cov, noLogs: false, floor: null, ...o })
  assert.deepEqual(M([n([[10, 20]]), n()], 10, 20), { advanceTo: 21, gaps: [], hold: false, pending: [], stuck: null }, 'one node answered all: done, whatever the other did')
  assert.deepEqual(M([n([[10, 14], [17, 20]]), n()], 10, 20), { advanceTo: 15, gaps: [], hold: true, pending: [0, 1], stuck: [15, 16] }, 'a hole nobody excuses: hold there')
  assert.deepEqual(M([n([[15, 20]], { floor: 15 }), n([], { noLogs: true })], 10, 20), { advanceTo: 21, gaps: [[10, 14]], hold: false, pending: [], stuck: null }, 'below the floor and no logs: a gap')
  assert.deepEqual(M([n([], { floor: 15 }), n([], { noLogs: true })], 10, 20), { advanceTo: 15, gaps: [[10, 14]], hold: true, pending: [0], stuck: [15, 20] }, 'a floor excuses only what lies below it')
  assert.deepEqual(M([n([[12, 12]], { floor: 18 }), n([], { noLogs: true })], 10, 20), { advanceTo: 18, gaps: [[10, 11], [13, 17]], hold: true, pending: [0], stuck: [18, 20] })
  assert.deepEqual(M([n()], 5, 4), { advanceTo: 5, gaps: [], hold: false, pending: [], stuck: null }, 'an empty range')
})

test('FIXED R4 (restructure): _busMerge, property-style: never past a block nobody answered that some node does not excuse; always past blocks answered or excused by all', () => {
  const M = channel._busMerge
  let seed = 0x5eed
  const rnd = (k) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k }
  for (let run = 0; run < 5000; run++) {
    const lo = rnd(50), hi = lo + rnd(70) - 5
    const nodes = Array.from({ length: 1 + rnd(4) }, () => ({
      cov: Array.from({ length: rnd(4) }, () => { const a = lo - 5 + rnd(80); return [a, a + rnd(25)] }),
      noLogs: rnd(5) === 0,
      floor: rnd(3) === 0 ? lo - 5 + rnd(80) : null,
      mustCover: rnd(2) === 0,                                   // review R5-3
      softFloor: rnd(4) === 0 ? lo - 5 + rnd(80) : null,
      cannot: Array.from({ length: rnd(3) }, () => { const a = lo - 5 + rnd(80); return [a, a + rnd(3)] }),   // review R8-1
    }))
    const r = M(nodes, lo, hi)
    // No node serves logs at all: there is no reader, so the merge holds (review R5-8) / 没有任何节点提供日志：没有读者，停住
    if (hi >= lo && nodes.every((v) => v.noLogs)) { assert.deepEqual([r.hold, r.advanceTo, r.gaps], [true, lo, []], JSON.stringify({ lo, hi, nodes })); continue }
    const answered = (b) => nodes.some((v) => v.cov.some(([a, c]) => a <= b && b <= c))
    const excused = (v, b) => v.noLogs || (v.floor != null && b < v.floor)
    const covers = (v, b) => v.cov.some(([a, c]) => a <= b && b <= c)
    // R5-3: an answered block still waits for every lately-serving node that neither answered, excuses, nor refused it
    // as too old this poll / 有人答过的区块，仍要等每个既没答、也不豁免、本次也没以太旧拒绝它的"最近提供过"的节点
    const blockers = (b) => (answered(b)
      ? nodes.flatMap((v, i) => (v.mustCover && !covers(v, b) && !excused(v, b) && !(v.softFloor != null && b < v.softFloor) && !v.cannot.some(([a, c]) => a <= b && b <= c) ? [i] : []))
      // `cannot` never makes a block nobody answered a gap (R8-1) / `cannot` 绝不会让没人答过的区块变成空洞
      : nodes.flatMap((v, i) => (excused(v, b) ? [] : [i])))
    const done = (b) => blockers(b).length === 0
    let first = lo
    while (first <= hi && done(first)) first++
    const ctx = JSON.stringify({ lo, hi, nodes })
    assert.equal(r.advanceTo, first, ctx)
    assert.equal(r.hold, first <= hi, ctx)
    for (let b = lo; b < r.advanceTo; b++) assert.ok(done(b), ctx)
    const gapBlocks = []
    for (const [a, c] of r.gaps) for (let b = a; b <= c; b++) gapBlocks.push(b)
    assert.deepEqual(gapBlocks, [...Array(Math.max(0, r.advanceTo - lo)).keys()].map((k) => lo + k).filter((b) => !answered(b)), ctx)
    if (r.hold) {
      assert.deepEqual(r.pending, blockers(first), ctx)
      assert.equal(r.stuck[0], first, ctx)
      for (let b = r.stuck[0]; b <= r.stuck[1]; b++) assert.ok(!done(b), ctx)
    }
  }
})

// ------------------------------------------------------------------------------------------ review round 5 ----
test('FIXED R5-7: a non-JSON error body (a Cloudflare 520 page) is cancelled, not left holding the connection', async () => {
  let cancelled = 0
  const f = async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode('<html>520</html>')) }, cancel() { cancelled++ } }), { status: 520, headers: { 'content-type': 'text/html' } })
  const rpc = createRpc({ urls: ['http://rpc1', 'http://rpc2'], quorum: 2, fetch: f, quiet: true })
  await assert.rejects(rpc.call('eth_blockNumber', []), (e) => e.code === 'RPC_UNAVAILABLE' && /http 520/.test(e.message))
  assert.equal(cancelled, 2, 'both bodies cancelled')
})

test('FIXED R5-8: _busMerge itself holds when every node serves no logs (there is no reader, not a gap)', () => {
  const r = channel._busMerge([{ cov: [], noLogs: true, floor: null }, { cov: [], noLogs: true, floor: null }], 10, 20)
  assert.equal(r.hold, true)
  assert.equal(r.advanceTo, 10)
  assert.deepEqual(r.gaps, [])
  assert.equal(r.none, true)
  // one node that serves logs and excuses the range below its floor still makes a gap, as before / 仍按原样
  const g = channel._busMerge([{ cov: [[15, 20]], noLogs: false, floor: 15 }, { cov: [], noLogs: true, floor: null }], 10, 20)
  assert.deepEqual([g.hold, g.advanceTo, g.gaps], [false, 21, [[10, 14]]])
})

test('FIXED R5-1: an archive node rate limited with the generic "limit exceeded" at start-up is not taken for a dataseed; a real dataseed is believed only after verdictMs', async () => {
  const setup = (archiveLimitedPolls) => {
    const chain = createFakeChain()
    const head = chain.state.block, edge = head - 5000, room = 'c4'.repeat(32)
    const poster = channel.busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
    let polls = 0
    const fetch = (u, init) => {
      const b = JSON.parse(init.body)
      if (b.method !== 'eth_getLogs') return chain.fetch(u, init)
      if (u === 'http://rpc1') return Number(BigInt(b.params[0].fromBlock)) < edge ? refuseOld(b) : chain.fetch(u, init)
      if (polls <= archiveLimitedPolls) return LIMIT(b)            // rpc2 says "limit exceeded" / rpc2 答 "limit exceeded"
      return chain.fetch(u, init)
    }
    const warns = []
    const t = channel.busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: edge - 300, confirmations: 0, warn: (m, d) => warns.push(d) })
    return { chain, edge, poster, t, warns, setPoll: (n) => { polls = n } }
  }
  const pollAll = async (w, n, advanceMs = 0) => {
    const got = []
    const realNow = Date.now
    let skew = 0
    try {
      for (let i = 1; i <= n; i++) {
        w.setPoll(i); Date.now = () => realNow() + skew
        try { got.push(...(await w.t.poll()).map((x) => x[1])) } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE', e.message) }
        skew += advanceMs
      }
    } finally { Date.now = realNow }
    return got
  }
  // An archive node limited for two polls, then healthy: its 50 frames below rpc1's window all arrive, no gap declared.
  // 归档节点前两次轮询被限流，之后恢复：它独有的 50 帧全部送达，不宣布空洞。
  const a = setup(2)
  for (let k = 0; k < 50; k++) await postAt(a.chain, a.poster, a.edge - 200 + k, Uint8Array.of(0x02, k))
  const gotA = await pollAll(a, 5)
  assert.deepEqual([...new Set(gotA)].sort((x, y) => x - y), [...Array(50).keys()], 'every frame only the archive node had')
  assert.equal(a.warns.filter((d) => d.oldestServed).length, 0, 'no gap declared')
  // A real dataseed ("limit exceeded" for ever): the cursor older than rpc1's window holds for verdictMs, then moves on
  // with one warning. / 真正的 dataseed：早于 rpc1 窗口的游标停住 verdictMs，之后带一次警告继续。
  const d = setup(Infinity)
  await postAt(d.chain, d.poster, d.edge + 10, Uint8Array.of(0x02, 77))   // inside rpc1's window / rpc1 窗口内
  assert.deepEqual(await pollAll(d, 4, 10_000), [], 'held: 40 s is well under verdictMs')
  assert.equal(d.warns.filter((d2) => d2.oldestServed).length, 0)
  const later = await pollAll(d, 3, channel.VERDICT_MS)
  assert.deepEqual(later, [77], 'after verdictMs the gap is declared and the frame inside the window arrives')
  assert.equal(d.warns.filter((d2) => d2.oldestServed).length, 1)
})

test('FIXED R5-3 + R5-6: a fast node answering [] cannot outrun a slow honest one; a held node goes on where it stopped', async () => {
  const run = async (liar) => {
    const chain = createFakeChain()
    const head = chain.state.block, room = 'f5'.repeat(32)
    const poster = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
    for (let k = 0; k < 60; k++) await postAt(chain, poster, head - 3000 + k * 50, Uint8Array.of(0x02, k))
    const asked = { 'http://rpc1': 0 }
    const fetch = async (u, init) => {
      const b = JSON.parse(init.body)
      if (b.method !== 'eth_getLogs') return chain.fetch(u, init)
      if (u === 'http://rpc1') { asked[u]++; await sleep(60); return chain.fetch(u, init) }            // honest, slow / 诚实但慢
      return liar ? new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result: [] }), { headers: { 'content-type': 'application/json' } }) : chain.fetch(u, init)
    }
    const t = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch, timeoutMs: 1000 }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head - 3000, confirmations: 0, budgetMs: 100, warn: () => {} })
    const got = []
    for (let i = 0; i < 40 && t.cursor <= head; i++) { try { got.push(...(await t.poll()).map((w) => w[1])) } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE') } }
    return { got, asked: asked['http://rpc1'], done: t.cursor > head }
  }
  const honest = await run(false)
  const liar = await run(true)
  assert.deepEqual(liar.got, [...Array(60).keys()], 'every frame, in order, although the liar answered every range at once')
  assert.ok(liar.done, 'and the cursor reaches the head')
  // R5-6: the slow node is not asked for its first chunk again every poll: about one request per chunk it reads
  // R5-6：不会每次都重问慢节点的第一段：大约每读一段一个请求
  assert.ok(liar.asked <= 12, `rpc1 asked ${liar.asked} times for 3 chunks`)
  assert.deepEqual(honest.got, [...Array(60).keys()])
})

test('FIXED R5-5: a node that uses its whole budget poll after poll is visible: counted in stats, warned about once per streak, by index', async () => {
  const chain = createFakeChain()
  const room = 'e5'.repeat(32)
  const fetch = async (u, init) => {
    const b = JSON.parse(init.body)
    if (b.method === 'eth_getLogs' && u === 'http://rpc2') { await sleep(120); return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result: [] }), { headers: { 'content-type': 'application/json' } }) }
    return chain.fetch(u, init)
  }
  const warns = []
  const t = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch, timeoutMs: 1000 }), bus: BUS, inbound: room, outbound: '00'.repeat(32), lookback: 3000, chunk: 100, minChunk: 50, confirmations: 0, budgetMs: 60, warn: (m, d) => warns.push({ m, d }) })
  for (let i = 0; i < 12; i++) { try { await t.poll() } catch { /* a hold is fine here / 这里停住无妨 */ } chain.mine(1) }
  const slow = warns.filter((w) => /whole per-poll budget/.test(w.m))
  assert.equal(slow.length, 1, 'once per streak')
  assert.equal(slow[0].d.node, 1)
  assert.ok(!/rpc2|http:/.test(slow[0].m), 'no URL in the warning')
  assert.ok(t.stats().nodes[1].outOfTime >= 10)
  assert.equal(t.stats().nodes[0].outOfTime, 0)
})

test('FIXED R5-4: with few requests a poll, a cursor older than a sliding window still gets through: the search goes on across polls', async () => {
  // A virtual clock that moves 10 ms per eth_getLogs, so "N requests a poll" does not depend on the machine's load.
  // 虚拟时钟：每个 eth_getLogs 前进 10 毫秒，"每轮 N 个请求"与机器负载无关。
  const realNow = Date.now
  const run = async (reqPerPoll) => {
    const chain = createFakeChain()
    let edge = chain.state.block - 5000
    const start = edge - 700
    let clock = realNow()
    const fetch = async (u, init) => {
      const b = JSON.parse(init.body)
      if (b.method !== 'eth_getLogs') return chain.fetch(u, init)
      if (u !== 'http://rpc1') return LIMIT(b)
      clock += 10
      return Number(BigInt(b.params[0].fromBlock)) < edge ? refuseOld(b) : chain.fetch(u, init)
    }
    Date.now = () => clock
    try {
      const t = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch, timeoutMs: 60_000 }), bus: BUS, inbound: 'c7'.repeat(32), outbound: '00'.repeat(32), fromBlock: start, confirmations: 0, budgetMs: reqPerPoll * 10 + 5, warn: () => {} })
      for (let i = 1; i <= 25; i++) {
        try { await t.poll() } catch { /* hold */ }
        if (t.cursor > chain.state.block) return i
        chain.mine(48); edge += 48                                // the window slides / 窗口滑动
      }
      return null
    } finally { Date.now = realNow }
  }
  // Before: 18 requests a poll were needed. Now 14 are enough (about 1.4 s a request at the default 20 s budget); below
  // that the node cannot be read faster than its window slides, and the cursor holds with the warning (safe, R3-7).
  // 之前每轮需要 18 个请求，现在 14 个就够（默认 20 秒预算下约每请求 1.4 秒）；再少，节点读得比窗口滑得还慢，游标停住并警告（安全）。
  for (const r of [14, 18, 24]) assert.ok(await run(r), `${r} requests a poll: through within 25 polls`)
})

test('FIXED R5-2: a room added or removed during a hold does not void what the other rooms were served', async () => {
  const run = async (mutate, rooms0) => {
    const chain = createFakeChain()
    const head = chain.state.block
    let edge = head - 5000
    const fetch = (u, init) => {
      const b = JSON.parse(init.body)
      if (b.method === 'eth_getLogs') { if (u !== 'http://rpc1') return LIMIT(b); if (Number(BigInt(b.params[0].fromBlock)) < edge) return refuseOld(b) }
      return chain.fetch(u, init)
    }
    const r1 = 'a1'.repeat(32)
    const p1 = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: r1, sendTx: async (tx) => chain.submit(tx) })
    for (let k = 0; k < 100; k++) await postAt(chain, p1, edge + k, Uint8Array.of(0x02, k))
    const reader = busReader({ rpc: createRpc({ urls: RPC3, quorum: 2, fetch }), bus: BUS, rooms: rooms0, fromBlock: edge - 500, confirmations: 0, warn: () => {} })
    const got = []
    const poll = async () => { try { got.push(...(await reader.poll()).filter((x) => x.room === r1).map((x) => x.wire[1])) } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE') } }
    await poll()                                   // verdicts learnt: holds; rpc1's answers go to the stash / 停住，rpc1 的回答进暂存
    mutate(reader)
    edge += 50                                     // the window slides past half the frames / 窗口滑过一半的帧
    for (let i = 0; i < 3; i++) await poll()
    return [...Array(100).keys()].filter((k) => !got.includes(k)).length
  }
  const r1 = 'a1'.repeat(32), r2 = 'a2'.repeat(32)
  assert.equal(await run(() => {}, [r1]), 0, 'control')
  assert.equal(await run((rd) => rd.add(r2), [r1]), 0, 'add during the hold')
  assert.equal(await run((rd) => rd.remove(r2), [r1, r2]), 0, 'remove during the hold')
})

test('FIXED R6-1: during a hold, a stashed block shallower than the overlap is read again, so a log a reorg moves in arrives', async () => {
  // rpc1 serves logs from `edge` on; rpc2 answers "limit exceeded" (a dataseed): poll 1 holds and stashes rpc1's answers
  // up to its head. A 3-deep reorg then puts a frame into a block rpc1 answered empty at depth 2, and 50 blocks follow.
  // rpc1 在 edge 之后提供日志；rpc2 回答 "limit exceeded"：第一次轮询停住并暂存 rpc1 的回答。随后 3 层重组把一帧放进 rpc1
  // 在深度 2 时答为空的区块，又出了 50 个块。
  const run = async (mine) => {
    const chain = createFakeChain()
    const room = 'a6'.repeat(32)
    const poster = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
    const edge = chain.state.block - 5000
    for (let k = 0; k < 10; k++) await postAt(chain, poster, edge + 10 + k * 20, Uint8Array.of(0x02, k))
    const fetch = async (u, init) => {
      const b = JSON.parse(init.body)
      if (b.method === 'eth_getLogs') {
        if (u === 'http://rpc2') return LIMIT(b)
        if (Number(BigInt(b.params[0].fromBlock)) < edge) return refuseOld(b)
      }
      return chain.fetch(u, init)
    }
    const t = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: edge - 300, confirmations: 2, overlap: 16, warn: () => {} })
    const got = []
    const poll = async () => { try { got.push(...(await t.poll()).map((w) => w[1])) } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE', e.message) } }
    await poll()
    assert.deepEqual(got, [], 'poll 1 holds: rpc2\'s answer is not believed yet')
    const top1 = chain.state.block - 2
    await postAt(chain, poster, top1 - 3, Uint8Array.of(0x02, 99))   // the reorg / 重组
    chain.mine(mine)
    for (let i = 0; i < 3; i++) { await poll(); chain.mine(5) }
    return got
  }
  for (const mine of [50, 5]) assert.deepEqual(await run(mine), [...Array(10).keys(), 99], `mine ${mine}: every frame, the reorged one too`)
})

test('FIXED R6-2: a room removed while a poll is in flight and added again gets that poll\'s frames, not zero times', async () => {
  const chain = createFakeChain()
  const room = 'b6'.repeat(32)
  const poster = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
  const fetch = async (u, init) => { if (JSON.parse(init.body).method === 'eth_getLogs') await sleep(30); return chain.fetch(u, init) }
  const reader = busReader({ rpc: createRpc({ urls: RPC, quorum: 2, fetch }), bus: BUS, rooms: [room], confirmations: 0, lookback: 100, warn: () => {} })
  const got = []
  const take = (xs) => got.push(...xs.filter((x) => x.room === room).map((x) => x.wire[1]))
  take(await reader.poll())
  chain.mine(3)
  await postAt(chain, poster, chain.state.block - 1, Uint8Array.of(0x02, 7))
  const inFlight = reader.poll()
  await sleep(10)
  reader.remove(room)
  const during = await inFlight
  assert.deepEqual(during.filter((x) => x.room === room), [], 'not handed over for a room that was removed')
  reader.add(room)
  take(await reader.poll())
  chain.mine(1); take(await reader.poll())
  assert.deepEqual(got, [7], 'handed over once, after the room came back')
  assert.ok(!('key' in (during[0] ?? {})), 'items carry only room and wire')
})

test('FIXED R5-6 + R6-1: during a long hold an honest node re-reads only the shallow top of what it answered, poll after poll', async () => {
  // rpc1 keeps logs from `edge` on (publicnode); rpc2 answers "limit exceeded" (a dataseed) until verdictMs has passed:
  // the cursor 300 blocks below rpc1's window holds for many polls. What rpc1 answered at least `overlap` deep is not
  // asked again; the shallow top is. / rpc1 从 edge 起保留日志；rpc2 在 verdictMs 之前一直 "limit exceeded"：游标停住多次。
  // rpc1 已至少 overlap 深答过的不再问；浅的顶端照问。
  const chain = createFakeChain()
  const room = 'c6'.repeat(32), edge = chain.state.block - 5000
  const asked = []
  const fetch = async (u, init) => {
    const b = JSON.parse(init.body)
    if (b.method === 'eth_getLogs') {
      if (u === 'http://rpc2') return LIMIT(b)
      if (Number(BigInt(b.params[0].fromBlock)) < edge) return refuseOld(b)
      asked.push(b.params[0])
    }
    return chain.fetch(u, init)
  }
  const t = channel.busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: edge - 300, confirmations: 2, warn: () => {} })
  const perPoll = []
  for (let i = 0; i < 6; i++) {
    const n = asked.length
    try { await t.poll() } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE') }
    perPoll.push(asked.length - n)
    chain.mine(3)
  }
  assert.equal(t.cursor, edge - 300, `still held: verdictMs has not passed (${perPoll})`)
  assert.ok(perPoll[0] >= 5, `poll 1 reads rpc1's whole window (${perPoll})`)
  for (const n of perPoll.slice(1)) assert.ok(n <= 1, `later polls read only the new, shallow top: ${perPoll}`)
  const top = chain.state.block - 3 - 2
  assert.ok(Number(BigInt(asked.at(-1).fromBlock)) >= top - 3 - 16, 'and that top starts within the overlap of the last read')
})

test('FIXED R6-3: a block stuffed with frames cannot stop a room: split to one block, read through its receipts', async () => {
  // Anyone can post to an inbox room (§3.2). One block full of junk frames is more than a node returns (a result cap, as
  // Alchemy's 10,000 here scaled to 100) or than this client accepts (bodyLimit): the reader must still get past it.
  // 任何人都能往收件房间发帧。一个塞满垃圾帧的区块超过节点单次返回上限或本客户端接受的大小：读取方仍须越过它。
  const setup = async ({ cap = Infinity, bodyLimit } = {}) => {
    const chain = createFakeChain()
    const room = 'd7'.repeat(32), other = 'd8'.repeat(32), head = chain.state.block
    const posterTo = (r) => busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: r, sendTx: async (tx) => chain.submit(tx) })
    const poster = posterTo(room)
    for (let k = 0; k < 5; k++) await postAt(chain, poster, head - 200 + k * 10, Uint8Array.of(0x02, k))
    const junk = new Uint8Array(4096); junk[0] = 0x02; junk[1] = 0xee
    const at = head - 100, saved = chain.state.block
    chain.state.block = at
    for (let i = 0; i < 8; i++) await poster.sendMany(Array.from({ length: 16 }, () => junk))   // 128 frames in one block
    await posterTo(other).send(Uint8Array.of(0x02, 0xdd))                                       // another room, same block
    chain.state.block = saved
    for (let k = 5; k < 10; k++) await postAt(chain, poster, head - 50 + k, Uint8Array.of(0x02, k))
    const asked = { receipts: 0 }
    const fetch = async (u, init) => {
      const b = JSON.parse(init.body)
      if (b.method === 'eth_getBlockReceipts') asked.receipts++
      const res = await chain.fetch(u, init)
      if (b.method !== 'eth_getLogs' || cap === Infinity) return res
      const j = await res.clone().json()
      return Array.isArray(j.result) && j.result.length > cap ? rpcAnswer(b, -32005, `query returned more than ${cap} results`) : res
    }
    const t = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch, ...(bodyLimit ? { bodyLimit } : {}) }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head - 300, confirmations: 0, warn: () => {} })
    const got = []
    for (let i = 0; i < 12 && t.cursor <= chain.state.block; i++) { try { got.push(...(await t.poll()).map((w) => w[1])) } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE', e.message) } chain.mine(3) }
    return { got, t, asked, chain }
  }
  for (const [name, o] of [['node result cap', { cap: 100 }], ['over bodyLimit', { bodyLimit: 256 * 1024 }]]) {
    const { got, t, asked } = await setup(o)
    assert.deepEqual(got.filter((k) => k !== 0xee), [...Array(10).keys()], `${name}: every honest frame, before and after the stuffed block`)
    assert.equal(got.filter((k) => k === 0xee).length, 128, `${name}: the junk is handed over too (it fails authentication in the session)`)
    assert.ok(!got.includes(0xdd), `${name}: another room's frame in that block is not this room's`)
    // A node's result cap needs the receipts; an answer over OUR bodyLimit is read as the block's logs with room enough.
    // 节点的结果上限要读回执；超过我们自己 bodyLimit 的，给足空间读该区块的日志即可。
    if (o.cap) assert.ok(asked.receipts >= 1 && asked.receipts <= 4, `${name}: the one block is read through its receipts (${asked.receipts} requests)`)
    else assert.equal(asked.receipts, 0, `${name}: the block's own logs, no receipts needed`)
    assert.deepEqual(t.stats().nodes.map((n) => n.span), [1000, 1000], `${name}: the spans are left alone: one full block slows no later read`)
  }
})

test('FIXED R6-3: only a cap on logs is split; a node refusing every range, whatever the wording, still holds (R3-1) within a bounded number of requests', () => {
  const k = (message, extra = {}) => channel._busKindOf(Object.assign(new Error('x'), { code: 'RPC_UNAVAILABLE', refusals: [{ code: -32005, message }] }, extra))
  for (const m of ['query returned more than 10000 results', 'Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range', 'too many logs']) assert.equal(k(m).big, true, m)
  for (const m of ['invalid block range params', 'block range too large', 'limit exceeded', 'exceed maximum block range: 50', 'rate limit exceeded']) assert.equal(k(m).big, false, m)
  assert.equal(channel._busKindOf(Object.assign(new Error('x'), { code: 'RPC_UNAVAILABLE', tooLarge: true })).big, true, 'our own body limit, set by rpc.js')
  assert.equal(channel._busKindOf(Object.assign(new Error('response body exceeds limit'), { code: 'RPC_UNAVAILABLE' })).big, false, 'never read from words')
})

test('FIXED R7-1: publicnode\'s real result cap ("query exceeds max results 20000, retry with the range A-B", recorded) splits and reads receipts', async () => {
  const cap = ANSWERS.find((a) => a.case.startsWith('result cap'))
  assert.ok(cap, 'the recorded answer is in fixtures/bsc-getlogs-answers.json')
  const said = (b) => new Response(JSON.stringify({ ...cap.body, id: b.id }), { status: cap.status, headers: { 'content-type': cap.contentType } })
  assert.equal(channel._busKindOf(Object.assign(new Error('x'), { code: 'RPC_ERROR', rpcCode: cap.body.error.code, message: `eth_getLogs: ${cap.body.error.message}` })).big, true, 'the recorded wording is a cap on logs')
  // The production node set in miniature: rpc1 = publicnode (answers the recorded cap when a range holds more than 100
  // logs, the 20,000 scaled down), rpc2 = a dataseed (limit exceeded). A block stuffed with junk must not stop the room.
  // 缩小版的生产节点集：rpc1 = publicnode（一个区间超过 100 条就答录制的原话），rpc2 = dataseed。塞满的区块不能让房间停住。
  const chain = createFakeChain()
  const room = 'e7'.repeat(32), head = chain.state.block
  const poster = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
  for (let k = 0; k < 3; k++) await postAt(chain, poster, head - 200 + k * 10, Uint8Array.of(0x02, k))
  const at = head - 100, saved = chain.state.block
  chain.state.block = at
  for (let i = 0; i < 8; i++) await poster.sendMany(Array.from({ length: 16 }, () => Uint8Array.of(0x02, 0xee)))
  chain.state.block = saved
  for (let k = 3; k < 6; k++) await postAt(chain, poster, head - 50 + k, Uint8Array.of(0x02, k))
  let receipts = 0
  const fetch = async (u, init) => {
    const b = JSON.parse(init.body)
    if (b.method === 'eth_getBlockReceipts') receipts++
    if (b.method !== 'eth_getLogs') return chain.fetch(u, init)
    if (u === 'http://rpc2') return LIMIT(b)
    const res = await chain.fetch(u, init), j = await res.clone().json()
    return Array.isArray(j.result) && j.result.length > 100 ? said(b) : res
  }
  const t = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head - 300, confirmations: 0, warn: () => {} })
  const got = []
  for (let i = 0; i < 10 && t.cursor <= chain.state.block; i++) { try { got.push(...(await t.poll()).map((w) => w[1])) } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE', e.message) } chain.mine(3) }
  assert.deepEqual(got.filter((k) => k !== 0xee), [0, 1, 2, 3, 4, 5], 'every honest frame, before and after the stuffed block')
  assert.ok(receipts >= 1, 'the stuffed block was read through its receipts')
})

test('FIXED R7-4: a block found too full is remembered, so the overlap re-reads it through its receipts instead of splitting again', async () => {
  // Real nodes stream large answers without content-length (checked 2026-09-25), so every read that covers a stuffed
  // block pulls bodyLimit bytes before it is cut off. Splitting once is unavoidable; splitting again in every poll whose
  // overlap still covers the block is not. / 真实节点的大回答不带 content-length，每次覆盖塞满区块的读取都要先拉满上限才被切断。
  // 拆分一次无法避免；重叠区每次还覆盖它时再拆一遍则不必。
  const chain = createFakeChain()
  const room = 'f7'.repeat(32), head = chain.state.block
  const poster = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
  const junk = new Uint8Array(4096); junk[0] = 0x02; junk[1] = 0xee
  const at = head - 5, saved = chain.state.block
  chain.state.block = at
  for (let i = 0; i < 8; i++) await poster.sendMany(Array.from({ length: 16 }, () => junk))
  chain.state.block = saved
  let big = 0
  const fetch = async (u, init) => {
    const res = await chain.fetch(u, init)
    const b = JSON.parse(init.body)
    if (b.method !== 'eth_getLogs') return res
    const text = await res.text()
    // An oversized answer to a range is pulled only to be cut off; the block alone, read with room enough, is the read itself
    // 对一个区间的超大回答只会被拉满后切断；单独读该区块（给足空间）才是真正的读取
    if (text.length > 256 * 1024 && b.params[0].fromBlock !== b.params[0].toBlock) big++
    return new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } })
  }
  const t = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch, bodyLimit: 256 * 1024 }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head - 30, confirmations: 0, overlap: 16, warn: () => {} })
  const got = []
  const perPoll = []
  for (let i = 0; i < 6; i++) { const n = big; got.push(...(await t.poll()).map((w) => w[1])); perPoll.push(big - n); chain.mine(2) }
  assert.equal(got.filter((k) => k === 0xee).length, 128, 'the stuffed block\'s frames, once')
  assert.ok(perPoll[0] >= 1, `poll 1 finds the block too full (${perPoll})`)
  assert.deepEqual(perPoll.slice(1), [0, 0, 0, 0, 0], `later polls, whose overlap still covers it, pull no oversized answer (${perPoll})`)
})

test('FIXED R8-1: a node that cannot read a stuffed block\'s receipts does not hold a block another node answered; alone, it still holds', async () => {
  // rpc1 serves logs but refuses eth_getBlockReceipts (older geth: -32601; or a history refusal); rpc2 has receipts. Both
  // cap results at 100 logs. rpc1 keeps serving the blocks around, so it stays "lately serving" (R5-3), and the merge used to
  // wait for it at the stuffed block for ever although rpc2 had read it. / rpc1 提供日志但拒绝回执；rpc2 有回执。rpc1 一直在提供
  // 周围的区块，所以一直算"最近提供过"，合并过去会在塞满的区块永远等它，尽管 rpc2 已经读到了。
  const run = async (answer, { alone = false, receipts2 = true } = {}) => {
    const chain = createFakeChain()
    const room = 'ab'.repeat(32), head0 = chain.state.block
    const poster = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
    const saved = chain.state.block
    chain.state.block = head0 - 2
    for (let i = 0; i < 8; i++) await poster.sendMany(Array.from({ length: 16 }, () => Uint8Array.of(0x02, 0xee)))
    chain.state.block = saved
    const fetch = async (u, init) => {
      const b = JSON.parse(init.body)
      if (u === 'http://rpc1' && b.method === 'eth_getBlockReceipts') return answer(b)
      if (alone && u === 'http://rpc2' && b.method === 'eth_getLogs') return LIMIT(b)   // a dataseed: no logs at all
      if (!receipts2 && u === 'http://rpc2' && b.method === 'eth_getBlockReceipts') return rpcAnswer(b, -32601, 'the method eth_getBlockReceipts does not exist/is not available')
      const res = await chain.fetch(u, init)
      if (b.method !== 'eth_getLogs') return res
      const j = await res.clone().json()
      return Array.isArray(j.result) && j.result.length > 100 ? rpcAnswer(b, -32005, 'query returned more than 100 results') : res
    }
    const t = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head0 - 40, confirmations: 0, warn: () => {} })
    const got = []
    for (let k = 0; k < 8; k++) {
      await postAt(chain, poster, chain.state.block, Uint8Array.of(0x02, k))
      try { got.push(...(await t.poll()).map((w) => w[1])) } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE', e.message) }
      chain.mine(3)
    }
    return { honest: got.filter((k) => k !== 0xee), junk: got.filter((k) => k === 0xee).length, cursor: t.cursor - head0 }
  }
  for (const [name, answer] of [['no such method', (b) => rpcAnswer(b, -32601, 'the method eth_getBlockReceipts does not exist/is not available')], ['history refusal', refuseOld]]) {
    const r = await run(answer)
    assert.deepEqual(r.honest, [...Array(8).keys()], `${name}: every honest frame`)
    assert.equal(r.junk, 128, `${name}: the stuffed block, from rpc2's receipts`)
    // rpc2 serves no logs (a dataseed) but has receipts: it reads the stuffed block for the others (R8-C1).
    // rpc2 不提供日志（dataseed）但有回执：它替别人读塞满的区块。
    const d = await run(answer, { alone: true })
    assert.deepEqual(d.honest, [...Array(8).keys()], `${name}: a dataseed's receipts carry the stuffed block`)
    // Nobody has the stuffed block (rpc2 has neither logs nor receipts): it holds there, never skips.
    // 没有任何节点读得到塞满的区块（rpc2 既没日志也没回执）：停在那里，绝不跳过。
    const a = await run(answer, { alone: true, receipts2: false })
    assert.ok(a.cursor <= -2, `${name}: alone, the cursor holds at the stuffed block (${a.cursor})`)
  }  // A transient answer excuses nobody: rpc1 may have the block after all, so it holds (R3-1, R5-3).
  // 临时回答不豁免任何节点：rpc1 可能其实有这个区块，所以停住。
  const blip = await run((b) => rpcAnswer(b, -32000, 'header not found'))
  assert.ok(blip.cursor <= -2, `a transient receipts error holds (${blip.cursor})`)
})

test('FIXED R8-C1/C2/C3: `cannot` is only a definitive refusal, is remembered across polls, and passing a block on another node\'s word is said once', async () => {
  // rpc1 serves logs but not receipts; rpc2 serves both. Both cap results at 100. / rpc1 提供日志不提供回执；rpc2 都提供。
  const setup = (receipts1) => {
    const chain = createFakeChain()
    const room = 'e9'.repeat(32), head0 = chain.state.block
    const poster = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
    const stuff = async (at) => { const h = chain.state.block; chain.state.block = at; for (let i = 0; i < 8; i++) await poster.sendMany(Array.from({ length: 16 }, () => Uint8Array.of(0x02, 0xee))); chain.state.block = h }
    const counts = { logs1: 0 }
    const fetch = async (u, init) => {
      const b = JSON.parse(init.body)
      if (u === 'http://rpc1' && b.method === 'eth_getBlockReceipts') return receipts1(b)
      if (u === 'http://rpc1' && b.method === 'eth_getLogs') counts.logs1++
      const res = await chain.fetch(u, init)
      if (b.method !== 'eth_getLogs') return res
      const j = await res.clone().json()
      return Array.isArray(j.result) && j.result.length > 100 ? rpcAnswer(b, -32005, 'query returned more than 100 results') : res
    }
    const warns = []
    const t = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head0 - 50, confirmations: 0, warn: (m, d) => warns.push({ m, d }) })
    return { chain, poster, stuff, counts, t, warns, head0 }
  }
  // C3: one stuffed block every poll. rpc1 re-split every one of them every poll and fell behind without bound (lag 71
  // after 30 polls); remembered, it keeps up. / 每轮一个塞满的区块。rpc1 过去每轮把每个都重新拆分、越落越远；记住之后跟得上。
  const nomethod = (b) => rpcAnswer(b, -32601, 'the method eth_getBlockReceipts does not exist/is not available')
  const s = setup(nomethod)
  const got = []
  for (let i = 0; i < 20; i++) {
    try { got.push(...(await s.t.poll()).map((w) => w[1])) } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE', e.message) }
    s.chain.mine(3)
    await s.stuff(s.chain.state.block - 1)
    await postAt(s.chain, s.poster, s.chain.state.block, Uint8Array.of(0x02, i))
  }
  try { got.push(...(await s.t.poll()).map((w) => w[1])) } catch { /* the last may hold / 最后一次可能停住 */ }
  assert.deepEqual(got.filter((k) => k !== 0xee), [...Array(20).keys()], 'every honest frame')
  assert.ok(s.chain.state.block + 1 - s.t.cursor <= 3, `and the cursor keeps up (lag ${s.chain.state.block + 1 - s.t.cursor})`)
  assert.ok(s.counts.logs1 / 21 < 18, `rpc1 does not re-split remembered blocks (was 25-26 a poll before R8-C3) (${(s.counts.logs1 / 21).toFixed(1)} eth_getLogs a poll)`)
  // C1: a block passed on rpc2's word alone is said once, naming the block. / 只凭 rpc2 越过的区块说一次，点名区块。
  const passed = s.warns.filter((w) => w.d?.cannot != null)
  assert.ok(passed.length >= 1, 'warned')
  assert.equal(new Set(passed.map((w) => w.d.cannot)).size, passed.length, 'once per block')
  assert.match(passed[0].m, /cannot read/)
  // C2: "does not exist" about a block, not the method, is not definitive: it holds. / 说的是区块不存在而不是方法不存在：不算确定，停住。
  const t = setup((b) => rpcAnswer(b, -32000, `block ${b.params[0]} does not exist`))
  await t.stuff(t.head0 - 2)
  for (let i = 0; i < 4; i++) { try { await t.t.poll() } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE') } t.chain.mine(3) }
  assert.ok(t.t.cursor <= t.head0 - 2, `a transient-looking refusal holds (${t.t.cursor - t.head0})`)
})

test('FIXED R9-1: every recorded BSC node answer, taken through rpc.js as it arrives, is classified as it means', async () => {
  // What each recorded answer must mean to the scanner / 每条录制的回答对扫描器必须意味着什么
  const want = (a) => {
    const m = a.body.error?.message ?? ''
    if (/Archive requests/.test(m)) return { history: true, big: false, noLogs: false }
    if (/^limit exceeded$/.test(m)) return { noLogs: true, big: false, history: false }
    if (/exceeds max results/.test(m)) return { big: true, history: false, noLogs: false }
    // a lagging backend: "not now", never "too wide" (it used to halve the span for good) / 后端落后："现在不行"，绝不是"太宽"
    if (/beyond current head|header not found/.test(m)) return { range: false, big: false, history: false, noLogs: false }
    return null
  }
  let checked = 0
  for (const a of ANSWERS) {
    const w = want(a)
    if (!a.body.error || !w) continue
    const rpc = createRpc({ urls: ['http://n1'], quorum: 1, allowSingleNode: true, fetch: async () => new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': a.contentType } }) })
    const e = await rpc.call(a.method || 'eth_getLogs', [{}]).then(() => null, (x) => x)
    assert.ok(e, `${a.node} ${a.case}: an error`)
    const k = channel._busKindOf(e)
    for (const [f, v] of Object.entries(w)) assert.equal(k[f], v, `${a.node} / ${a.case}: ${f}`)
    checked++
  }
  assert.ok(checked >= 7, `${checked} recorded answers checked`)
})

test('FIXED R8-S1: a block too full for the stash no longer drops what was read above it during a hold', async () => {
  // Both nodes keep 200 blocks and cap results at 100; rpc2 fails poll 1 after serving once (so the cursor holds). The
  // block b holds 20,001 junk frames (over STASH_MAX) and an honest frame; honest frames also sit at b+5 and b+60. After
  // the held poll the window slides past b and b+5. / 两个节点都保留 200 块、每次最多 100 条；b 塞了 20001 条垃圾帧（超过暂存上限）。
  const WIN = 200, CAP = 100
  const chain = createFakeChain()
  const room = 'ad'.repeat(32), head0 = chain.state.block, b = head0 - WIN + 40
  const poster = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
  const saved = chain.state.block
  chain.state.block = b
  for (let i = 0; i < Math.ceil(20_001 / 16); i++) await poster.sendMany(Array.from({ length: 16 }, () => Uint8Array.of(0x02, 0xee)))
  chain.state.block = saved
  for (const [k, at] of [[0, b], [1, b + 5], [2, b + 60]]) await postAt(chain, poster, at, Uint8Array.of(0x02, k))
  chain.setFault('http://rpc1', `history:${WIN}`); chain.setFault('http://rpc2', `history:${WIN}`)
  let poll = 0, served2 = 0
  const fetch = async (u, init) => {
    const q = JSON.parse(init.body)
    if (q.method === 'eth_blockNumber' && u === 'http://rpc1') poll++
    if (q.method === 'eth_getBlockReceipts' && Number(BigInt(q.params[0])) < chain.state.block - WIN) return refuseOld(q)
    if (u === 'http://rpc2' && q.method === 'eth_getLogs' && poll <= 1) { if (served2++ === 0) return chain.fetch(u, init); return new Response('boom', { status: 500 }) }
    const res = await chain.fetch(u, init)
    if (q.method !== 'eth_getLogs') return res
    const j = await res.clone().json()
    return Array.isArray(j.result) && j.result.length > CAP ? rpcAnswer(q, -32602, `query exceeds max results ${CAP}, retry with the range 1-1`) : res
  }
  const warns = []
  const t = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: b - 10, confirmations: 0, verdictMs: 0, chunk: 10, minChunk: 1, warn: (m, d) => warns.push(d || {}) })
  const got = []
  for (let i = 0; i < 6; i++) {
    try { got.push(...(await t.poll()).filter((w) => w[1] !== 0xee).map((w) => w[1])) } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE', e.message) }
    chain.mine(i === 0 ? 60 : 3)
  }
  assert.ok(got.includes(1) && got.includes(2), `the frames above the full block, read during the hold, arrive (${got})`)
  if (!got.includes(0)) assert.ok(warns.some((d) => d.oldestServed != null && d.from <= b && b <= d.to), 'the full block itself, if lost, is a reported gap')
})

test('FIXED R9-2: a range over OUR bodyLimit is read once more with room enough; publicnode\'s "retry with the range" is taken, a wrong one is not', async () => {
  const setup = async ({ cap = Infinity, hint = null, bodyLimit } = {}) => {
    const chain = createFakeChain()
    const room = 'c9'.repeat(32), head = chain.state.block
    const poster = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
    for (let k = 0; k < 5; k++) await postAt(chain, poster, head - 150 + k * 20, Uint8Array.of(0x02, k))
    const junk = new Uint8Array(4096); junk[0] = 0x02; junk[1] = 0xee
    const at = head - 60, saved = chain.state.block
    chain.state.block = at
    for (let i = 0; i < 8; i++) await poster.sendMany(Array.from({ length: 16 }, () => junk))
    chain.state.block = saved
    for (let k = 5; k < 8; k++) await postAt(chain, poster, head - 40 + k, Uint8Array.of(0x02, k))
    const seen = { truncated: 0, logs: 0 }
    const fetch = async (u, init) => {
      const q = JSON.parse(init.body)
      if (u === 'http://rpc2' && q.method === 'eth_getLogs') return LIMIT(q)   // one reader: rpc1 / 只有 rpc1 读
      const res = await chain.fetch(u, init)
      if (q.method !== 'eth_getLogs' || u !== 'http://rpc1') return res
      seen.logs++
      const text = await res.text(), j = JSON.parse(text)
      if (bodyLimit && text.length > bodyLimit && q.params[0].fromBlock !== q.params[0].toBlock) seen.truncated++
      if (Array.isArray(j.result) && j.result.length > cap) {
        const lo = Number(BigInt(q.params[0].fromBlock))
        return rpcAnswer(q, -32602, `query exceeds max results ${cap}, retry with the range ${lo}-${hint === 'wrong' ? lo + 100000 : at - 1}`)
      }
      return new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } })
    }
    const t = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch, ...(bodyLimit ? { bodyLimit } : {}) }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head - 200, confirmations: 0, verdictMs: 0, warn: () => {} })
    const got = []
    for (let i = 0; i < 4; i++) { try { got.push(...(await t.poll()).filter((w) => w[1] !== 0xee).map((w) => w[1])) } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE') } }
    return { got, seen }
  }
  const all = [...Array(8).keys()]
  const big = await setup({ bodyLimit: 128 * 1024 })
  assert.deepEqual(big.got, all, 'over bodyLimit: every frame')
  assert.ok(big.seen.truncated <= 2, `over bodyLimit: ${big.seen.truncated} truncated range answers, not one per bisection step`)
  const hinted = await setup({ cap: 100, hint: 'right' })
  const bisected = await setup({ cap: 100, hint: 'wrong' })
  assert.deepEqual(hinted.got, all, 'with the hint: every frame')
  assert.deepEqual(bisected.got, all, 'with a hint beyond the range: every frame, by bisection')
  assert.ok(hinted.seen.logs < bisected.seen.logs, `the hint saves requests (${hinted.seen.logs} vs ${bisected.seen.logs})`)
})

// ------------------------------------------------------------------------------------------ review round 9 ----
const busTransportGrace = (o) => channel.busTransport({ verdictMs: 0, ...o })   // keeps the default startGraceMs / 保留默认启动宽限

test('FIXED R9-PE1: on the first poll a liar cannot outrun an honest node\'s single transient failure', async () => {
  // rpc1 honest (one 502 on the first poll), rpc2 drops frame 0 from its answers, rpc3 a dataseed. / rpc1 诚实但首轮一次 502；rpc2 撒谎
  const chain = createFakeChain(); const room = 'a7'.repeat(32); const head0 = chain.state.block
  const poster = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
  await postAt(chain, poster, head0 - 40, Uint8Array.of(0x02, 0))
  let polls = 0, failed = false
  const fetch = async (u, init) => {
    const q = JSON.parse(init.body)
    if (q.method === 'eth_getLogs' && u === 'http://rpc1' && polls === 1 && !failed) { failed = true; return new Response('<html>502</html>', { status: 502 }) }
    if (q.method === 'eth_getLogs' && u === 'http://rpc3') return LIMIT(q)
    if (q.method === 'eth_getLogs' && u === 'http://rpc2') { const j = await (await chain.fetch(u, init)).json(); return new Response(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: [] }), { headers: { 'content-type': 'application/json' } }) && new Response(JSON.stringify({ ...j, result: [] }), { headers: { 'content-type': 'application/json' } }) }
    return chain.fetch(u, init)
  }
  const t = busTransportGrace({ rpc: createRpc({ urls: RPC3, quorum: 2, fetch }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head0 - 60, confirmations: 0, warn: () => {} })
  const got = []
  for (let p = 0; p < 4; p++) { polls++; chain.state.block += 5; try { got.push(...(await t.poll()).map((w) => w[1])) } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE') } }
  assert.deepEqual(got, [0], 'the frame only the honest node returns arrives')
  // With no start grace the old behaviour is back: the liar's [] passes the block on the first poll / 没有启动宽限就回到旧行为
  failed = false; polls = 0
  const chain2 = chain
  const t0 = busTransportGrace({ rpc: createRpc({ urls: RPC3, quorum: 2, fetch }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head0 - 60, confirmations: 0, startGraceMs: 0, warn: () => {} })
  const got0 = []
  for (let p = 0; p < 4; p++) { polls++; chain2.state.block += 5; try { got0.push(...(await t0.poll()).map((w) => w[1])) } catch { /* hold */ } }
  assert.deepEqual(got0, [], 'startGraceMs: 0 shows what the grace prevents')
})

test('FIXED R9-F3: a block passed only on a node-without-logs\'s receipts is warned about once; one read before is not', async () => {
  const run = async (mode, lie) => {
    const chain = createFakeChain(); const room = 'a7'.repeat(32); const head0 = chain.state.block, b = head0 - 8
    const poster = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
    const junk = Uint8Array.of(0x02, 0xee, 0xee, 0, 0, 0, 0, 0)
    const h = chain.state.block; chain.state.block = b
    for (let i = 0; i < 8; i++) await poster.sendMany(Array.from({ length: 16 }, () => junk))
    await poster.send(Uint8Array.of(0x02, 0, 0)); chain.state.block = h
    const W = 30
    const fetch = async (u, init) => {
      const q = JSON.parse(init.body), edge = chain.state.block - W
      if (u === 'http://rpc1') await sleep(5)   // the logs node is the slower one / 日志节点较慢
      if (u === 'http://rpc1' && q.method === 'eth_getLogs') {
        const lo = Number(BigInt(q.params[0].fromBlock))
        if (lo < edge) return refuseOld(q)
        const j = await (await chain.fetch(u, init)).json()
        if (j.result.length <= 100) return new Response(JSON.stringify(j), { headers: { 'content-type': 'application/json' } })
        const hi = Number(BigInt(q.params[0].toBlock))
        let k = 0, B = lo - 1
        for (let x = lo; x <= hi; x++) { k += j.result.filter((l) => Number(BigInt(l.blockNumber)) === x).length; if (k > 100) break; B = x }
        return rpcAnswer(q, -32602, `query exceeds max results 100, retry with the range ${lo}-${B}`)
      }
      if (u === 'http://rpc1' && q.method === 'eth_getBlockReceipts') return mode === 'nomethod' ? rpcAnswer(q, -32601, 'the method eth_getBlockReceipts does not exist/is not available') : (Number(BigInt(q.params[0])) < edge ? refuseOld(q) : chain.fetch(u, init))
      if (u === 'http://rpc2' && q.method === 'eth_getLogs') return LIMIT(q)
      if (u === 'http://rpc2' && q.method === 'eth_getBlockReceipts' && lie) {
        const j = await (await chain.fetch(u, init)).json()
        return new Response(JSON.stringify({ ...j, result: (j.result || []).map((r) => ({ ...r, logs: r.logs.filter((l) => !l.data.includes('0'.repeat(63) + '302000000')) })) }), { headers: { 'content-type': 'application/json' } })
      }
      return chain.fetch(u, init)
    }
    const warns = []
    const t = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: b - 4, confirmations: 0, warn: (m, d) => warns.push(d || {}) })
    const got = []
    for (let p = 0; p < 6; p++) { try { got.push(...(await t.poll()).filter((w) => w[1] !== 0xee).map((w) => w[1])) } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE') } chain.state.block += p === 0 ? 30 : 2 }
    return { got, passed: warns.filter((d) => d.cannot === b) }
  }
  const lied = await run('nomethod', true)
  assert.deepEqual(lied.got, [], 'the lying dataseed dropped frame 0 (the accepted trade-off)')
  assert.equal(lied.passed.length, 1, `and the reader says, once, that block b rests on nodes without logs (${JSON.stringify(lied)})`)
  const honest = await run('nomethod', false)
  assert.deepEqual(honest.got, [0], 'an honest dataseed carries it')
  const before = await run('history', true)
  assert.equal(before.passed.length, 0, 'a block the logs node read before is not warned about when the overlap passes it again')
})

test('FIXED R9-F2: a node cannot make nodes without logs read every block\'s receipts: only heavy blocks are remembered as full', async () => {
  // rpc1 answers every multi-block eth_getLogs with the cap wording "x-(x-1)" and single blocks cheaply (they are light);
  // rpc3 is a dataseed with receipts. / rpc1 对每个多块查询都答上限原话、单块照常（它们很轻）；rpc3 是有回执的 dataseed。
  const chain = createFakeChain(); const room = 'a8'.repeat(32); const head0 = chain.state.block
  const poster = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: room, sendTx: async (tx) => chain.submit(tx) })
  for (let k = 0; k < 5; k++) await postAt(chain, poster, head0 - 30 + k * 5, Uint8Array.of(0x02, k))
  let receipts3 = 0
  const fetch = async (u, init) => {
    const q = JSON.parse(init.body)
    if (u === 'http://rpc3' && q.method === 'eth_getLogs') return LIMIT(q)
    if (u === 'http://rpc3' && q.method === 'eth_getBlockReceipts') receipts3++
    if (u === 'http://rpc1' && q.method === 'eth_getLogs' && q.params[0].fromBlock !== q.params[0].toBlock) { const lo = Number(BigInt(q.params[0].fromBlock)); return rpcAnswer(q, -32602, `query exceeds max results 20000, retry with the range ${lo}-${lo - 1}`) }
    return chain.fetch(u, init)
  }
  const t = busTransport({ rpc: createRpc({ urls: RPC3, quorum: 2, fetch }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head0 - 40, confirmations: 0, warn: () => {} })
  const got = []
  for (let p = 0; p < 8; p++) { try { got.push(...(await t.poll()).map((w) => w[1])) } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE') } chain.mine(3) }
  assert.deepEqual(got, [0, 1, 2, 3, 4], `frames (dataseed receipts ${receipts3})`)
  assert.equal(receipts3, 0, 'the dataseed read no receipts: no block was heavy')
})

// ------------------------------------------------------------------------------------------ review round 10 ----
// Frames written straight into the fake chain's log list / 直接写进假链日志表的帧
const WIRE_TOPIC10 = '0x46fffab6f2033c7dc33390d2a1329b6809abdcb8baf711dc44a9144ccf4b1431'
async function emitter(chain, room) {
  const { encodeParams } = await import('../src/abi.js')
  const st = chain.state
  return (id, block, size = 3) => {
    const w = new Uint8Array(Math.max(3, size)); w[0] = 0x02; w[1] = id & 0xff; w[2] = id >> 8
    st.logs.push({ address: BUS.toLowerCase(), topics: [WIRE_TOPIC10, '0x' + room], data: '0x' + Buffer.from(encodeParams(['bytes'], [w])).toString('hex'), blockNumber: block, logIndex: st.logs.filter((l) => l.blockNumber === block).length })
  }
}

test('FIXED R10-1: a range of several stuffed blocks over blockBodyLimit does not disable the node: every frame arrives', async () => {
  // Six blocks of ~16 KiB each: none over blockBodyLimit (64 KiB) alone, the run of them is (the real sizes: ~12.5 MiB a
  // block, 64 MiB). / 六个各约 16 KiB 的区块：单个都不超过上限，合起来超过（真实尺寸：每块约 12.5 MiB，上限 64 MiB）。
  const chain = createFakeChain(), st = chain.state, head0 = st.block, room = 'a1'.repeat(32)
  const emit = await emitter(chain, room)
  const S = head0 - 30
  for (let k = 0; k < 6; k++) for (let j = 0; j < 4; j++) emit(0xffff, S + k, 2000)
  emit(1, S - 3); emit(2, S + 2); emit(3, S + 8)
  const fetch = async (u, init) => { const b = JSON.parse(init.body); return u === 'http://rpc2' && b.method === 'eth_getLogs' ? LIMIT(b) : chain.fetch(u, init) }
  const r = busReader({ rpc: createRpc({ urls: RPC, quorum: 2, fetch, bodyLimit: 8 * 1024 }), bus: BUS, rooms: [room], fromBlock: head0 - 60, confirmations: 0, blockBodyLimit: 64 * 1024, warn: () => {} })
  const got = []
  for (let p = 0; p < 12; p++) { st.block += 1; try { for (const x of await r.poll()) if (x.wire[1] !== 0xff) got.push(x.wire[1]) } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE') } }
  assert.deepEqual(got, [1, 2, 3])
})

test('FIXED R10-2: a node down at start delays a start by the first polls only, not by a minute', async () => {
  // The default set with one dataseed unreachable: the frame must come within a few polls. / 默认节点集、一个 dataseed 连不上
  const chain = createFakeChain(), head0 = chain.state.block, room = 'a2'.repeat(32)
  const emit = await emitter(chain, room)
  emit(1, head0 - 10)
  const fetch = async (u, init) => {
    const b = JSON.parse(init.body)
    if (u === 'http://rpc3') throw new TypeError('fetch failed')
    if (u === 'http://rpc2' && b.method === 'eth_getLogs') return LIMIT(b)
    return chain.fetch(u, init)
  }
  const t = channel.busTransport({ rpc: createRpc({ urls: ['http://rpc1', 'http://rpc2', 'http://rpc3'], quorum: 2, fetch }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head0 - 20, confirmations: 0, verdictMs: 0, warn: () => {} })
  const got = []
  let polls = 0
  const t0 = Date.now()
  while (!got.length && polls < 10) { polls++; chain.mine(1); try { got.push(...(await t.poll()).map((w) => w[1])) } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE') } }
  assert.deepEqual(got, [1])
  assert.ok(polls <= 4, `delivered after ${polls} polls (the grace covers only the first 3)`)
  assert.ok(Date.now() - t0 < 10_000, 'and well within the time cap')
})

test('FIXED R10-3: one node refusing even single blocks as over its cap makes each node without logs read at most 4 receipts a poll', async () => {
  for (const shape of ['cap', 'cant']) {
    const chain = createFakeChain(), head0 = chain.state.block, room = 'a3'.repeat(32)
    const emit = await emitter(chain, room)
    for (let k = 0; k < 5; k++) emit(k + 1, head0 - 30 + k * 5)
    let receipts3 = 0
    const perPoll = []
    const fetch = async (u, init) => {
      const b = JSON.parse(init.body)
      if (u === 'http://rpc1' && b.method === 'eth_getLogs') { const lo = Number(BigInt(b.params[0].fromBlock)); return rpcAnswer(b, -32602, `query exceeds max results 20000, retry with the range ${lo}-${lo - 1}`) }
      if (u === 'http://rpc1' && b.method === 'eth_getBlockReceipts') return shape === 'cap' ? new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result: [] }), { headers: { 'content-type': 'application/json' } }) : rpcAnswer(b, -32601, 'the method eth_getBlockReceipts does not exist/is not available')
      if (u === 'http://rpc3' && b.method === 'eth_getLogs') return LIMIT(b)
      if (u === 'http://rpc3' && b.method === 'eth_getBlockReceipts') receipts3++
      return chain.fetch(u, init)
    }
    const t = busTransport({ rpc: createRpc({ urls: ['http://rpc1', 'http://rpc2', 'http://rpc3'], quorum: 2, fetch }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head0 - 40, confirmations: 0, warn: () => {} })
    const got = []
    for (let p = 0; p < 10; p++) { const n = receipts3; try { got.push(...(await t.poll()).map((w) => w[1])) } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE') } perPoll.push(receipts3 - n); chain.mine(3) }
    assert.deepEqual(got, [1, 2, 3, 4, 5], `${shape}: every frame (rpc2 is honest)`)
    assert.ok(Math.max(...perPoll) <= 4, `${shape}: the dataseed read at most 4 receipts a poll (${perPoll})`)
  }
})

test('FIXED R9-F1: a single block answered over blockBodyLimit marks the node bad for the poll: no second oversized pull', async () => {
  const chain = createFakeChain(), head0 = chain.state.block, room = 'a4'.repeat(32)
  const emit = await emitter(chain, room)
  for (let j = 0; j < 8; j++) emit(0xffff, head0 - 10, 2000)   // one heavy block / 一个很重的区块
  emit(1, head0 - 20)
  let oversized = 0
  const fetch = async (u, init) => {
    const b = JSON.parse(init.body)
    if (u === 'http://rpc1' && (b.method === 'eth_getLogs' || b.method === 'eth_getBlockReceipts')) {
      const lo = b.method === 'eth_getLogs' ? b.params[0].fromBlock : b.params[0], hi = b.method === 'eth_getLogs' ? b.params[0].toBlock : b.params[0]
      if (lo === hi && Number(BigInt(lo)) === head0 - 10) { oversized++; return new Response('{"jsonrpc":"2.0","id":' + b.id + ',"result":["' + 'x'.repeat(80 * 1024) + '"]}', { headers: { 'content-type': 'application/json' } }) }
    }
    return chain.fetch(u, init)
  }
  const t = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch, bodyLimit: 8 * 1024 }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head0 - 30, confirmations: 0, blockBodyLimit: 64 * 1024, warn: () => {} })
  const per = []
  for (let p = 0; p < 3; p++) { const n = oversized; try { await t.poll() } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE') } per.push(oversized - n) }
  assert.ok(per.every((n) => n <= 1), `at most one oversized single-block answer a poll from the bad node (${per})`)
})

test('FIXED R10 (seed 1001479): a node given up on after SERVED_DECAY polls is announced once, with the block from which it is passed', async () => {
  // Given up on: rpc2 serves for a while, then fails every read; rpc1 lies by omission. / 放弃等待：rpc2 先提供，后一直失败
  const chain = createFakeChain(), head0 = chain.state.block, room = 'a5'.repeat(32)
  const emit = await emitter(chain, room)
  let down = false
  const fetch = async (u, init) => {
    const b = JSON.parse(init.body)
    if (u === 'http://rpc2' && b.method === 'eth_getLogs' && down) return new Response('<html>502</html>', { status: 502 })
    return chain.fetch(u, init)
  }
  const warns = []
  const t = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head0 - 5, confirmations: 0, warn: (m, d) => warns.push({ m, d: d || {} }) })
  for (let p = 0; p < 3; p++) { chain.mine(1); await t.poll() }
  down = true
  for (let p = 0; p < 24; p++) { chain.mine(1); emit(p + 1, chain.state.block); try { await t.poll() } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE') } }
  const gone = warns.filter((w) => w.d.abandoned != null)
  assert.equal(gone.length, 1, 'said once for the streak')
  assert.equal(gone[0].d.abandoned, 1)
  assert.match(gone[0].m, /has not served for 2\d polls, so blocks from \d+ on are passed without it/)
})

test('FIXED R10 (seed 42000007): a node that has not served since the start is announced too once the grace is over; a dataseed is not', async () => {
  const chain = createFakeChain(), head0 = chain.state.block, room = 'a6'.repeat(32)
  const emit = await emitter(chain, room)
  const fetch = async (u, init) => {
    const b = JSON.parse(init.body)
    if (u === 'http://rpc2' && b.method === 'eth_getLogs') return new Response('<html>502</html>', { status: 502 })   // down since the start
    if (u === 'http://rpc3' && b.method === 'eth_getLogs') return LIMIT(b)                                             // a dataseed
    return chain.fetch(u, init)
  }
  const warns = []
  const t = busTransport({ rpc: createRpc({ urls: ['http://rpc1', 'http://rpc2', 'http://rpc3'], quorum: 2, fetch }), bus: BUS, inbound: room, outbound: '00'.repeat(32), fromBlock: head0 - 5, confirmations: 0, warn: (m, d) => warns.push({ m, d: d || {} }) })
  const got = []
  for (let p = 0; p < 6; p++) { chain.mine(1); emit(p + 1, chain.state.block); try { got.push(...(await t.poll()).map((w) => w[1])) } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE') } }
  assert.deepEqual(got, [1, 2, 3, 4, 5, 6], 'the frames arrive from rpc1 once the grace is over')
  const gone = warns.filter((w) => w.d.abandoned != null)
  assert.deepEqual(gone.map((w) => w.d.abandoned), [1], 'rpc2 is announced, once; the dataseed is not')
  assert.match(gone[0].m, /has not served since the reader started/)
})

// ------------------------------------------------------------------------------------------ review round 11 ----
test('FIXED R11-C1: stuffed blocks a logs node cannot read (cap, no receipts) are all swept by a dataseed, the held one first', async () => {
  // rpc1 caps at 10 results and has no receipts; rpc2 and rpc3 are dataseeds with receipts. Five stuffed blocks in a
  // row used to hold the reader for ever: the per-node share swept the overlap's blocks every poll, never the held one.
  // rpc1 上限 10 条、没有回执；rpc2、rpc3 是有回执的 dataseed。连续五个塞满的区块过去会让读取永远停住。
  const chain = createFakeChain(), st = chain.state, head0 = st.block, room = 'a1'.repeat(32)
  const emit = await emitter(chain, room)
  const first = head0 + 5, NB = 5, CAP = 10
  st.block = head0 + 30
  for (let k = 0; k < NB; k++) { for (let j = 0; j < CAP * 2; j++) emit(0xffff, first + k); emit(k + 1, first + k) }
  emit(100, first + NB + 2)
  const fetch = async (u, init) => {
    const b = JSON.parse(init.body)
    if (u === 'http://rpc1' && b.method === 'eth_getBlockReceipts') return rpcAnswer(b, -32601, 'the method eth_getBlockReceipts does not exist/is not available')
    if (u === 'http://rpc1' && b.method === 'eth_getLogs') {
      const j = await (await chain.fetch(u, init)).json()
      if (j.result.length <= CAP) return new Response(JSON.stringify(j), { headers: { 'content-type': 'application/json' } })
      const lo = Number(BigInt(b.params[0].fromBlock)), hi = Number(BigInt(b.params[0].toBlock))
      let k = 0, B = lo - 1
      for (let x = lo; x <= hi; x++) { k += j.result.filter((l) => Number(BigInt(l.blockNumber)) === x).length; if (k > CAP) break; B = x }
      return rpcAnswer(b, -32602, `query exceeds max results ${CAP}, retry with the range ${lo}-${B}`)
    }
    if ((u === 'http://rpc2' || u === 'http://rpc3') && b.method === 'eth_getLogs') return LIMIT(b)
    return chain.fetch(u, init)
  }
  const reader = busReader({ rpc: createRpc({ urls: ['http://rpc1', 'http://rpc2', 'http://rpc3'], quorum: 2, fetch }), bus: BUS, rooms: [room], fromBlock: head0, confirmations: 2, warn: () => {} })
  const got = new Set()
  let holds = 0
  for (let p = 1; p <= 40; p++) { try { for (const x of await reader.poll()) got.add(x.wire[1] | (x.wire[2] << 8)) } catch { holds++ } st.block += 1 }
  assert.deepEqual([...got].filter((k) => k !== 0xffff).sort((a, b) => a - b), [1, 2, 3, 4, 5, 100], `every frame (${holds} holds in 40 polls)`)
  assert.ok(holds <= 3, `the stuffed run does not hold the reader (${holds} holds)`)
})

test('FIXED R11-C2: a room catching up that passes lower blocks without a node given up on is announced again', async () => {
  const chain = createFakeChain(), st = chain.state, head0 = st.block
  const A = 'a1'.repeat(32), B = 'b2'.repeat(32)
  const emitA = await emitter(chain, A), emitB = await emitter(chain, B)
  const start = head0 - 100
  for (let k = 0; k < 5; k++) emitB(10 + k, start + 10 + k * 15)
  emitA(1, start + 5)
  let poll = 0
  const fetch = async (u, init) => {
    const b = JSON.parse(init.body)
    if (u === 'http://rpc1' && poll >= 5 && (b.method === 'eth_getLogs' || b.method === 'eth_getBlockReceipts')) throw new TypeError('fetch failed')
    if (u === 'http://rpc2' && b.method === 'eth_getLogs') return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result: [] }), { headers: { 'content-type': 'application/json' } })
    if (u === 'http://rpc3' && b.method === 'eth_getLogs') return LIMIT(b)
    return chain.fetch(u, init)
  }
  const warns = []
  const r = busReader({ rpc: createRpc({ urls: ['http://rpc1', 'http://rpc2', 'http://rpc3'], quorum: 2, fetch }), bus: BUS, rooms: [A], fromBlock: start, confirmations: 2, warn: (m, d) => warns.push({ d: d || {}, poll }) })
  for (poll = 1; poll <= 50; poll++) {
    if (poll === 40) r.add(B, null, { fromBlock: start })
    try { await r.poll() } catch (e) { assert.equal(e.code, 'RPC_UNAVAILABLE') }
    st.block += 3
  }
  const ab = warns.filter((w) => w.d.abandoned != null)
  assert.equal(ab.length, 2, `said for the main read, and again for room B's catch-up (${ab.map((w) => `p${w.poll} from ${w.d.from - start}`)})`)
  assert.ok(ab[1].d.from <= start + 10, 'the second names the lower blocks room B passes')
})
