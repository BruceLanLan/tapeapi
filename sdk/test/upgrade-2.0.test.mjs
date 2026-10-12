// 2.0, item 2 of the 2.0 list (P2, P3): the breaking changes 1.x deferred to 2.0.
//   P2: TapeAPIError has no deprecated top-level aliases any more; details are read as e.data.*.
//   P3: sdk/src/channel.js is unfrozen: a mistake in the caller's own options or arguments is INVALID_ARGUMENT (TAPI-26
//       data stays CHANNEL_INVALID), the implementation takes `service` (not `svc`), and it reads e.data.* itself.
// docs/guides/upgrade-2.0.md lists each change. The first four tests fail on the 1.x code (1.8.1 with the 2.0 label
// default, 8d155c8); the fifth guards what must not change. The 1.8.1 `labels` option is covered under both versions.
// 2.0：1.x 留到 2.0 的破坏性修改。P2：TapeAPIError 不再有顶层弃用别名，细节读 e.data.*。P3：channel.js 解冻：调用方
// 自己的选项或参数有误报 INVALID_ARGUMENT（TAPI-26 数据仍报 CHANNEL_INVALID），实现接受 `service`（不再是 `svc`），自己读 e.data.*。
import test from 'node:test'
import assert from 'node:assert/strict'
import { TapeAPIError, channel as pub } from '../src/index.js'
import * as channel from '../src/channel.js'   // the implementation module, test hooks included / 实现模块，含测试钩子

const { createInvite, acceptInvite, completeInvite, generateKeyPair, encodeWire, decodeWire, sealToInbox, openFromInbox, fanIn, busTransport, busReader, relayTransport } = channel
const A = { container: '0x86DDaEF00401E3F10418398D67D7189fc458eA95', chainId: 56 }
const B = { container: '0x19366c3c69ffeb3b286d9fa6cc5e616375baafd3', chainId: 56 }
const ROOM = 'ab'.repeat(32)
const BUS = '0x' + 'cb'.repeat(20)
const code = (c, re) => (e) => e instanceof TapeAPIError && e.code === c && (!re || re.test(e.message))
const arg = (re) => code('INVALID_ARGUMENT', re)
const data = (re) => code('CHANNEL_INVALID', re)

function handshake() {
  const a = generateKeyPair(), b = generateKeyPair()
  const { invite, pending } = createInvite({ self: { ...A, staticSecret: a.secretKey }, peer: { ...B, staticPublic: b.publicKey } })
  const { accept, session: bob } = acceptInvite({ self: { ...B, staticSecret: b.secretKey }, peer: { ...A, staticPublic: a.publicKey }, invite })
  const { ready, session: alice } = completeInvite(pending, accept)
  bob.confirm(ready)
  return { a, b, invite, pending, accept, ready, alice, bob }
}

test('P2: TapeAPIError has no top-level alias; every detail is in data', () => {
  const e = new TapeAPIError('QUORUM_FAILED', 'x', { agreed: [], failed: [{ code: 'INTERNAL' }], tooLarge: true, rpcCode: 3, httpStatus: 502 })
  assert.deepEqual(e.data, { agreed: [], failed: [{ code: 'INTERNAL' }], tooLarge: true, rpcCode: 3 })
  for (const k of ['agreed', 'failed', 'tooLarge', 'rpcCode']) {
    assert.equal(k in e, false, `${k} is not a property of the error`)
    assert.equal(Object.getOwnPropertyDescriptor(e, k), undefined, k)
  }
  assert.equal(e.httpStatus, 502, 'the fixed top-level fields stay')
  assert.deepEqual(Object.getOwnPropertyNames(e).sort(), ['code', 'data', 'httpStatus', 'message', 'name', 'stack'])
})

test('P3: channel.js reads e.data.* (rpcCode, refusals, tooLarge), not a top-level field', () => {
  const kindOf = channel._busKindOf
  // the shape rpc.js throws / rpc.js 抛出的形状
  const noMethod = kindOf(new TapeAPIError('RPC_ERROR', 'eth_getLogs: the method eth_getLogs does not exist', { rpcCode: -32601 }))
  assert.deepEqual([noMethod.refusal?.code, noMethod.noLogs], [-32601, true])
  const capped = kindOf(new TapeAPIError('RPC_UNAVAILABLE', 'x', { refusals: [{ code: -32005, message: 'limit exceeded' }] }))
  assert.deepEqual([capped.refusal?.code, capped.noLogs], [-32005, true])
  assert.equal(kindOf(new TapeAPIError('RPC_UNAVAILABLE', 'x', { tooLarge: true })).big, true)
  // the 1.x alias shape (fields at the top level, no data) is no longer read / 1.x 别名的形状（字段在顶层、无 data）不再被读取
  const old = Object.assign(new Error('eth_getLogs: x'), { code: 'RPC_ERROR', rpcCode: -32601 })
  assert.ok(Number.isNaN(kindOf(old).refusal.code))
  assert.equal(kindOf(Object.assign(new Error('x'), { code: 'RPC_UNAVAILABLE', tooLarge: true })).big, false)
  assert.equal(kindOf(Object.assign(new Error('x'), { code: 'RPC_UNAVAILABLE', refusals: [{ code: -32005, message: 'limit exceeded' }] })).refusal, null)
})

test('P3: the implementation takes `service`, and the public face passes it through unchanged', async () => {
  const seen = []
  const api = { call: async (svc, method) => { seen.push([svc, method]); return { result: { frames: [], next: -1, epoch: null } } } }
  const service = { manifest: { methods: [] } }
  const t = relayTransport({ api, service, inbound: ROOM, outbound: 'cd'.repeat(32), waitMs: 0 })
  await t.poll(0)
  assert.equal(seen[0][0], service); assert.equal(seen[0][1], 'relayRecv')
  assert.throws(() => relayTransport({ api, svc: service, inbound: ROOM, outbound: 'cd'.repeat(32) }), arg(/needs \{ api, service \}/), 'svc is not read')
  const t2 = pub.relayTransport({ api, service, inbound: ROOM, outbound: 'cd'.repeat(32), waitMs: 0 })
  await t2.poll(0)
  assert.equal(seen[1][0], service)
  assert.throws(() => pub.relayTransport({ api, svc: service, inbound: ROOM, outbound: 'cd'.repeat(32) }), arg(/renamed in 1\.0/))
})

test('P3: the caller\'s own options and arguments are INVALID_ARGUMENT', () => {
  const a = generateKeyPair(), b = generateKeyPair()
  const self = { ...A, staticSecret: a.secretKey }, peer = { ...B, staticPublic: b.publicKey }
  assert.throws(() => createInvite({ peer }), arg(/self is required/))
  assert.throws(() => createInvite({ self: { ...A, staticSecret: new Uint8Array(31) }, peer }), arg(/self\.staticSecret/))
  assert.throws(() => createInvite({ self: { ...self, container: 'nope' }, peer }), arg(/container must be an address/))
  assert.throws(() => createInvite({ self, peer, ttlS: 5 }), arg(/ttlS/))
  assert.throws(() => createInvite({ self, peer, keys: 'other/v1' }), arg(/keys must be one of/))
  assert.throws(() => createInvite({ self, peer, relays: [{ url: 'http://example.com', container: A.container }] }), arg(/https/))
  assert.throws(() => createInvite({ self, peer, bus: 'nope' }), arg(/bus must be/))
  const { invite, pending } = createInvite({ self, peer })
  assert.throws(() => acceptInvite({ self: { ...B, staticSecret: b.secretKey }, peer: { ...A, staticPublic: a.publicKey }, invite, seen: [] }), arg(/seen must be a Set/))
  assert.throws(() => completeInvite({ ...pending }, {}), arg(/not an original handle/))
  const h = handshake()
  assert.throws(() => h.alice.seal(42), arg(/seal takes/))
  assert.throws(() => h.alice.seal(new Uint8Array(16 * 1024 + 1)), arg(/exceeds/))
  assert.throws(() => h.alice.confirm(h.ready), arg(/only the responder confirms/))
  h.alice.close()
  assert.throws(() => h.alice.seal('x'), arg(/closed/))
  assert.throws(() => encodeWire(42), arg(/encodeWire takes/))
  assert.throws(() => relayTransport({ service: {}, inbound: ROOM, outbound: ROOM }), arg(/TapeAPI client/))
  assert.throws(() => relayTransport({ api: { call() {} }, service: {}, inbound: 'x', outbound: ROOM }), arg(/inbound must be a room id/))
  assert.throws(() => busTransport({ rpc: {}, bus: BUS, inbound: ROOM, outbound: ROOM }), arg(/multi-node rpc/))
  const rpc = { call: async () => [], blockNumber: async () => 0 }
  assert.throws(() => busTransport({ rpc, bus: 'nope', inbound: ROOM, outbound: ROOM }), arg(/ChannelBus contract address/))
  assert.throws(() => busTransport({ rpc, bus: BUS, inbound: ROOM, outbound: ROOM, chunk: 0 }), arg(/chunk/))
  assert.throws(() => busReader({ rpc, bus: BUS, rooms: ['x'] }), arg(/room must be a room id/))
  assert.throws(() => fanIn([]), arg(/non-empty array/))
  assert.throws(() => openFromInbox(sealToInbox({ v: 1, kind: 'x' }, { to: { ...B, staticPublic: b.publicKey } }), { self: { staticSecret: b.secretKey } }), arg(/container must be an address/))
  assert.throws(() => sealToInbox({ v: 1, kind: 'x' }, { to: { container: 'nope', staticPublic: b.publicKey } }), arg(/container must be an address/))
  assert.throws(() => openFromInbox(sealToInbox({ v: 1, kind: 'x' }, { to: { ...B, staticPublic: b.publicKey } }), { self: {} }), arg(/self\.staticSecret/))
  // the same under either label version (1.8.1's option; v2 is the default from 2.0) / 两个标签版本下相同
  for (const labels of ['v1', 'v2']) {
    assert.throws(() => sealToInbox({ v: 1, kind: 'x' }, { to: { container: 'nope', staticPublic: b.publicKey }, labels }), arg(/container must be an address/), labels)
    assert.throws(() => openFromInbox(sealToInbox({ v: 1, kind: 'x' }, { to: { ...B, staticPublic: b.publicKey }, labels }), { self: { staticSecret: b.secretKey }, labels }), arg(/container must be an address/), labels)
    assert.throws(() => createInvite({ self: { ...self, container: 'nope' }, peer, labels }), arg(/container must be an address/), labels)
  }
  assert.throws(() => createInvite({ self, peer, labels: 'v3' }), arg(/labels must be 'v2'/))
})

test('P3: TAPI-26 data stays CHANNEL_INVALID', () => {
  const h = handshake()
  const b = generateKeyPair()
  assert.throws(() => acceptInvite({ self: { ...B, staticSecret: h.b.secretKey }, peer: { ...A, staticPublic: h.a.publicKey }, invite: { ...h.invite, kind: 'x' } }), data(/not a TAPI-26 invite/))
  assert.throws(() => acceptInvite({ self: { ...B, staticSecret: h.b.secretKey }, peer: { ...A, staticPublic: h.a.publicKey }, invite: { ...h.invite, relays: [{ url: 'http://example.com', container: A.container }] } }), data(/https/), 'a relay list read from an invite is data')
  assert.throws(() => acceptInvite({ self: { ...B, staticSecret: h.b.secretKey }, peer: { ...A, staticPublic: new Uint8Array(32) }, invite: h.invite }), data(), 'a peer key that is not a usable X25519 key is data')
  const frame = h.alice.seal('hi'); frame[frame.length - 1] ^= 1
  assert.throws(() => h.bob.open(frame), data(/authentication/))
  assert.throws(() => decodeWire(Uint8Array.of(9)), data(/unknown wire type/))
  assert.throws(() => openFromInbox(new Uint8Array(10), { self: { ...B, staticSecret: b.secretKey } }), data(/not a sealed invite/))
  assert.throws(() => openFromInbox(sealToInbox({ v: 1, kind: 'x' }, { to: { ...B, staticPublic: h.b.publicKey } }), { self: { ...B, staticSecret: b.secretKey } }), data(/does not open/))
  // a sealed invite of the other label version is data too, with data.labels / data.peerLabels (1.8.1)
  // 另一标签版本的密封邀请同样是数据错误，带 data.labels / data.peerLabels
  const v1wire = sealToInbox({ v: 1, kind: 'x' }, { to: { ...B, staticPublic: h.b.publicKey }, labels: 'v1' })
  assert.throws(() => openFromInbox(v1wire, { self: { ...B, staticSecret: h.b.secretKey } }), (e) => data(/other label version/)(e) && e.data?.labels === 'v2' && e.data?.peerLabels === 'v1')
})
