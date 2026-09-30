// Worker 版 relay.tape：两个互不共享内存的"隔离实例"通过同一个 Durable Object 命名空间看到同一个房间。
// relay.tape as a Worker: two "isolates" that share no memory see the same room through one Durable Object
// namespace -- the property an in-isolate relay cannot have.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRelay, RelayRoom } from './relay-worker.js'
import * as channel from '../../sdk/src/channel.js'   // the implementation module (toBase64, fromBase64) / 实现模块
import { privateKeyToAddress, signDigest, delegationDigest, recoverResponseSigner } from '../../sdk/src/sig.js'
import { ADDR } from '../../sdk/test/helpers/fake-chain.mjs'

const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32)
const signer = privateKeyToAddress(SIGNER_KEY)
const EXPIRES = Math.floor(Date.now() / 1000) + 30 * 86400

// What Cloudflare provides: one object per name, shared by every isolate. / Cloudflare 提供的语义：每个名字一个对象，所有隔离实例共享。
function durableNamespace(Cls) {
  const objects = new Map()
  return {
    idFromName: (name) => `id:${name}`,
    get: (id) => {
      if (!objects.has(id)) objects.set(id, new Cls({}, {}))
      const o = objects.get(id)
      return { fetch: (url, init) => o.fetch(new Request(url, init)) }
    },
    get count() { return objects.size },
  }
}
const ROOMS = durableNamespace(RelayRoom)
const env = {
  ROOMS, SIGNER_KEY, SIGNER_ADDRESS: signer, CIRCUITS: ADDR.circuits, TOKEN_ID: '4246', CONTAINER: ADDR.container,
  DELEGATION_EXPIRES: String(EXPIRES),
  DELEGATION_SIG: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires: EXPIRES }), HOLDER_KEY),
  PUBLIC_URL: 'https://relay.example', RPC_URLS: 'http://127.0.0.1:9,http://localhost:10',
}
// Two isolates: separately built providers, no shared memory, one shared namespace. / 两个隔离实例
const isolate1 = buildRelay(env), isolate2 = buildRelay(env)
const call = async (iso, method, params, ip = '1.2.3.4') => {
  const res = await iso.handleRequest(new Request(`https://relay.example/tapeapi/v1/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ id: `r${Math.random()}`, params }) }))
  const env_ = await res.json()
  const signerOk = recoverResponseSigner({ container: env_.container, id: env_.id, method, params, ok: env_.ok, body: env_.ok ? env_.result : env_.error, ts: env_.ts }, env_.sig)
  assert.equal(signerOk.toLowerCase(), signer.toLowerCase(), 'every relay answer is a TAPI-21 envelope signed by the relay')
  return env_
}
const room = (n) => n.toString(16).padStart(64, '0')

test('a frame posted through one isolate is received through another: the room lives in the Durable Object', async () => {
  const r = room(1)
  const sent = await call(isolate1, 'relaySend', { room: r, frame: 'aGVsbG8=' })
  assert.equal(sent.ok, true); assert.equal(sent.result.i, 0)
  const got = await call(isolate2, 'relayRecv', { room: r, after: -1, waitMs: 0 })
  assert.deepEqual(got.result.frames, [{ i: 0, frame: 'aGVsbG8=' }])
  assert.equal((await call(isolate2, 'relayRecv', { room: room(2), after: -1, waitMs: 0 })).result.frames.length, 0, 'rooms are isolated from each other')
})

test('long-poll across isolates: a peer waiting on isolate 2 gets a frame posted to isolate 1 at once', async () => {
  const r = room(3)
  const waiting = call(isolate2, 'relayRecv', { room: r, after: -1, waitMs: 4000 })
  await new Promise((res) => setTimeout(res, 120))
  const t = Date.now()
  await call(isolate1, 'relaySend', { room: r, frame: 'd2FrZQ==' })
  const got = await waiting
  assert.equal(got.result.frames[0].frame, 'd2FrZQ==')
  assert.ok(Date.now() - t < 1000, 'delivered one round trip after posting, not at the 4 s timeout')
})

test('a bad room name is a signed BAD_REQUEST, not a crash', async () => {
  const bad = await call(isolate1, 'relaySend', { room: 'NOT-HEX', frame: 'aGk=' })
  assert.equal(bad.ok, false); assert.equal(bad.error.code, 'BAD_REQUEST')
})

test('a full TAPI-26 channel runs through the Worker relay, with each side on a different isolate', async () => {
  const ka = channel.generateKeyPair(), kb = channel.generateKeyPair()
  const A = { container: '0x0000000000000000000000000000000000000A11', chainId: 56 }, B = { container: '0x0000000000000000000000000000000000000B0B', chainId: 56 }
  const post = (iso, rm, wire) => call(iso, 'relaySend', { room: rm, frame: channel.toBase64(wire) })
  const cursors = new Map()
  const pull = async (iso, rm) => {
    const after = cursors.get(rm) ?? -1
    const { result } = await call(iso, 'relayRecv', { room: rm, after, waitMs: 2000 })
    if (result.frames.length) cursors.set(rm, result.next)
    return result.frames.map((f) => channel.decodeWire(channel.fromBase64(f.frame)))
  }
  const { invite, pending } = channel.createInvite({ self: { ...A, staticSecret: ka.secretKey }, peer: { ...B, staticPublic: kb.publicKey }, relays: [{ url: 'https://relay.example/tapeapi/v1', container: ADDR.container }] })
  const { accept, session: bob } = channel.acceptInvite({ self: { ...B, staticSecret: kb.secretKey }, peer: { ...A, staticPublic: ka.publicKey }, invite })
  await post(isolate2, bob.rooms.outbound, channel.encodeWire(accept))                    // Bob is served by isolate 2 / Bob 走实例 2
  const [a1] = await pull(isolate1, channel.roomsFor(invite.cid).toInitiator)           // Alice by isolate 1 / Alice 走实例 1
  const { ready, session: alice } = channel.completeInvite(pending, a1.handshake)
  await post(isolate1, alice.rooms.outbound, channel.encodeWire(ready))
  const [b1] = await pull(isolate2, bob.rooms.inbound)
  bob.confirm(b1.handshake)
  for (let i = 0; i < 10; i++) {
    await post(isolate1, alice.rooms.outbound, channel.encodeWire(alice.seal(`a${i}`)))
    await post(isolate2, bob.rooms.outbound, channel.encodeWire(bob.seal(`b${i}`)))
    const [fa] = await pull(isolate2, bob.rooms.inbound)
    const [fb] = await pull(isolate1, alice.rooms.inbound)
    assert.equal(bob.open(fa.frame, { text: true }).data, `a${i}`)
    assert.equal(alice.open(fb.frame, { text: true }).data, `b${i}`)
  }
})

// The public relay is set up from a phone like the provider: deployed first with only SIGNER_KEY, it answers its health
// naming the signer, so the holder console can build the delegation; the manifest then names the derived signer.
// 公共中继和服务一样从手机设置：先只带 SIGNER_KEY 部署，健康检查写明签名地址供控制台构造委托；之后清单里的签名地址由密钥推导。
test('relay setup mode: health names the signer derived from SIGNER_KEY until the holder has signed; the manifest uses it', async () => {
  const { default: fresh } = await import('./relay-worker.js?setup')
  const h = await fresh.fetch(new Request('https://relay.tapeapi.fun/tapeapi/v1/health'), { ROOMS, SIGNER_KEY: ` ${SIGNER_KEY}\n`, PUBLIC_URL: 'https://relay.tapeapi.fun' })
  const body = await h.json()
  assert.deepEqual([h.status, body.ok, body.setup, body.signer], [200, false, true, signer])
  assert.deepEqual(body.missing, ['CIRCUITS', 'TOKEN_ID', 'CONTAINER', 'DELEGATION_EXPIRES', 'DELEGATION_SIG'])
  const send = await fresh.fetch(new Request('https://relay.tapeapi.fun/tapeapi/v1/relaySend', { method: 'POST', body: '{}' }), { ROOMS, SIGNER_KEY })
  assert.equal(send.status, 503, 'nothing is relayed before the holder has authorised the key')
  const { SIGNER_ADDRESS, ...noAddress } = env
  const m = await (await buildRelay(noAddress).handleRequest(new Request('https://relay.example/.well-known/tapeapi.json'))).json()
  assert.equal(m.signer, signer, 'SIGNER_ADDRESS is no longer needed')
  assert.throws(() => buildRelay({ ...env, SIGNER_ADDRESS: '0x' + '99'.repeat(20) }), /does not match SIGNER_KEY/)
})
