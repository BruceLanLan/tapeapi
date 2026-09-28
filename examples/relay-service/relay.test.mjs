// 端到端：两个容器经由一个真实的 relay.tape 服务握手并通信；中继自身是一个经过完整验证的 TapeAPI 服务。
// End to end: two containers handshake and talk through a real relay.tape service, which is itself a fully
// verified TapeAPI service (resolved from the chain, every answer signature-checked).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createProvider } from '../../server/src/index.js'
import { createTapeAPI, parseUnits, MANIFEST_KEY } from '../../sdk/src/index.js'
import * as channel from '../../sdk/src/channel.js'   // the implementation module (svc, toBase64) / 实现模块
import { privateKeyToAddress, signDigest, delegationDigest } from '../../sdk/src/sig.js'
import { createFakeChain, ADDR } from '../../sdk/test/helpers/fake-chain.mjs'
import { createRelayCore, relayMethods, relayManifestMethods } from './relay-core.mjs'

const { createInvite, acceptInvite, completeInvite, generateKeyPair, relayTransport, encodeWire, decodeWire, fromBase64, toBase64 } = channel
const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32), PAYER_KEY = '0x' + '33'.repeat(32), SESSION_KEY = '0x' + '44'.repeat(32)
const holder = privateKeyToAddress(HOLDER_KEY), signer = privateKeyToAddress(SIGNER_KEY)
const payerAddr = privateKeyToAddress(PAYER_KEY), sessionAddr = privateKeyToAddress(SESSION_KEY)
const RPC = ['http://rpc1', 'http://rpc2']
const EXPIRES = Math.floor(Date.now() / 1000) + 300 * 86400
const A = { container: '0x0000000000000000000000000000000000000A11', chainId: 56 }
const B = { container: '0x0000000000000000000000000000000000000B0B', chainId: 56 }
const PRICE = '0.00001'

let chain, core, srv, api, svc, url

async function startRelay(priceBEM) {
  core = createRelayCore()
  const manifest = {
    tapeapi: '0.1', name: 'relay.tape', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
    delegation: { expires: EXPIRES, sig: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires: EXPIRES }), HOLDER_KEY) },
    endpoints: { live: ['http://127.0.0.1:1/tapeapi/v1'], async: false },
    methods: relayManifestMethods({ priceBEM }),
    ...(priceBEM !== '0' ? { payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 } } : {}),
  }
  const provider = createProvider({ minVoucherLifeS: 0, manifest, signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: chain.fetch, allowHttp: true, escrowCacheMs: 0, log: () => {}, methods: relayMethods(core) })
  srv = await provider.listen(0)
  url = `http://127.0.0.1:${srv.address().port}/tapeapi/v1`
  provider.manifest.endpoints.live = [url]
  chain.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify({ ...manifest, endpoints: { live: [url], async: false } }))
  // These tests check what arrives, not how fast: a generous timeout keeps a loaded machine from failing a 1 MiB answer
  // 这些测试检查送达什么而不是多快：宽松的超时让负载高的机器不会让 1 MiB 的回答超时失败
  api = createTapeAPI({ rpcUrls: RPC, quorum: 2, chainId: 56, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, escrow: ADDR.escrow, allowHttp: true, fetch: chain.fetchWith(), rpcTimeoutMs: 30_000 })
  svc = await api.resolve(ADDR.container)
}

before(async () => {
  chain = createFakeChain()
  chain.setOwner(4246, holder); chain.setAccount(4246, ADDR.container)
  chain.setChannel(payerAddr, ADDR.container, parseUnits('1'))
  chain.setSession(payerAddr, ADDR.container, sessionAddr, 1900000000)
  await startRelay('0')
})
after(() => srv?.close())

// The whole choreography, as an application would write it. / 应用会这样写的完整流程。
async function connect({ payer } = {}) {
  const ka = generateKeyPair(), kb = generateKeyPair()
  const { invite, pending } = createInvite({ self: { ...A, staticSecret: ka.secretKey }, peer: { ...B, staticPublic: kb.publicKey }, relays: [{ url, container: ADDR.container }] })
  // (the invite now travels sealed to B as a TapeSend message; B reads A's static key from the DeWebHub)
  // （邀请此时作为 TapeSend 消息密封发给 B；B 从 DeWebHub 读取 A 的长期公钥）
  const { accept, session: bob } = acceptInvite({ self: { ...B, staticSecret: kb.secretKey }, peer: { ...A, staticPublic: ka.publicKey }, invite })
  const bobLink = relayTransport({ api, svc, payer, inbound: bob.rooms.inbound, outbound: bob.rooms.outbound, waitMs: 2000 })
  await bobLink.send(encodeWire(accept))
  // A holds only the channel id from its own invite until the accept arrives / 收到 accept 之前，A 只知道自己邀请里的通道号
  const rooms = channel.roomsFor(invite.cid)
  const aliceLink = relayTransport({ api, svc, payer, inbound: rooms.toInitiator, outbound: rooms.toResponder, waitMs: 2000 })
  const [w] = await aliceLink.poll()
  const { ready, session: alice } = completeInvite(pending, decodeWire(w).handshake)
  await aliceLink.send(encodeWire(ready))
  const [r] = await bobLink.poll()
  bob.confirm(decodeWire(r).handshake)
  return { invite, alice, bob, aliceLink, bobLink }
}

test('two containers handshake through relay.tape and talk both ways; the relay never holds a readable byte', async () => {
  const { invite, alice, bob, aliceLink, bobLink } = await connect()
  assert.ok(JSON.stringify(invite).length < 16_000, 'the invite fits one TapeSend message (MAX_PAYLOAD 16,000)')
  assert.equal(alice.transcript, bob.transcript)
  const said = []
  for (let i = 0; i < 20; i++) {
    const a = `alice says secret-${i}`, b = `bob says secret-${i}`
    said.push(a, b)
    await aliceLink.send(encodeWire(alice.seal(a)))
    await bobLink.send(encodeWire(bob.seal(b)))
    const [fa] = await bobLink.poll(); const [fb] = await aliceLink.poll()
    assert.equal(bob.open(decodeWire(fa).frame, { text: true }).data, a)
    assert.equal(alice.open(decodeWire(fb).frame, { text: true }).data, b)
  }
  // Search everything the relay stored for anything anyone said. / 在中继存下的一切里搜索任何一句话。
  const stored = core.dump().map((f) => Buffer.from(fromBase64(f)).toString('latin1')).join('\n')
  for (const s of said) assert.ok(!stored.includes(s), `the relay must not hold "${s}" in the clear`)
  assert.ok(!stored.includes('secret-'), 'not even a fragment')
})

test('long-poll: a waiting peer receives a frame one round trip after it is posted', async () => {
  const { alice, bob, aliceLink, bobLink } = await connect()
  const t0 = Date.now()
  const waiting = bobLink.poll(5000)
  await new Promise((r) => setTimeout(r, 150))
  const sentAt = Date.now()
  await aliceLink.send(encodeWire(alice.seal('ping')))
  const [f] = await waiting
  const latency = Date.now() - sentAt
  assert.equal(bob.open(decodeWire(f).frame, { text: true }).data, 'ping')
  assert.ok(latency < 1000, `delivered ${latency} ms after posting, not after the 5 s timeout`)
  assert.ok(Date.now() - t0 < 3000)
  const idle = Date.now(); assert.deepEqual(await bobLink.poll(300), []); assert.ok(Date.now() - idle >= 250, 'an empty poll waits, then returns empty')
})

test('a malicious relay that replays an old frame as new cannot fool the channel', async () => {
  const { alice, bob, aliceLink, bobLink } = await connect()
  const wire = encodeWire(alice.seal('pay 10'))
  await aliceLink.send(wire)
  const [first] = await bobLink.poll()
  assert.equal(bob.open(decodeWire(first).frame, { text: true }).data, 'pay 10')
  // The relay re-posts the same ciphertext under a fresh index. The transport passes it up; the channel refuses.
  // 中继用一个新的序号把同一段密文再发一遍。传输层会把它交上来，通道会拒绝。
  core.send(bob.rooms.inbound, toBase64(wire))
  const [again] = await bobLink.poll()
  assert.throws(() => bob.open(decodeWire(again).frame), (e) => e.code === 'CHANNEL_INVALID' && /replayed/.test(e.message))
})

test('a priced relay meters one voucher per frame through TAP-22, and refuses an unpaid sender', async () => {
  srv.close(); await startRelay(PRICE)
  const payer = api.payer({ consumer: payerAddr, sessionKey: SESSION_KEY })
  const { alice, aliceLink } = await connect({ payer })
  const before = payer.cumulativeOf(svc)
  for (let i = 0; i < 5; i++) await aliceLink.send(encodeWire(alice.seal(`frame ${i}`)))
  assert.equal(payer.cumulativeOf(svc) - before, 5n * parseUnits(PRICE), 'exactly five frames billed')
  const free = relayTransport({ api, svc, inbound: alice.rooms.inbound, outbound: alice.rooms.outbound })
  await assert.rejects(free.send(encodeWire(alice.seal('no payer'))), (e) => e.code === 'PAYMENT_REQUIRED')
  srv.close(); await startRelay('0')
})

test('a backlog larger than the 1 MiB response cap is handed over across polls instead of wedging the channel', async () => {
  // Before the cap, 60 maximal frames made every relayRecv answer exceed TAP-21's 1 MiB limit: the provider
  // replied INTERNAL, the cursor never advanced and the channel was dead for good, free for anyone to trigger.
  // 加上限之前，60 个最大帧会让每次 relayRecv 的回答超过 TAP-21 的 1 MiB 上限：提供者回 INTERNAL、游标永不前进、通道彻底死掉。
  const { alice, bob, aliceLink, bobLink } = await connect()
  const big = new Uint8Array(16 * 1024).fill(7)
  for (let i = 0; i < 60; i++) await aliceLink.send(encodeWire(alice.seal(big)))
  let got = 0
  for (let poll = 0; poll < 10 && got < 60; poll++) {
    const wires = await bobLink.poll(0)
    for (const w of wires) { assert.deepEqual(bob.open(decodeWire(w).frame).data, big); got++ }
    if (!wires.length) break
  }
  assert.equal(got, 60, 'every frame arrived')
  assert.ok(bobLink.cursor >= 59)
})

test('a priced relay carries the handshake for free, so the responder can answer before funding anything', async () => {
  srv.close(); await startRelay(PRICE)
  const service = svc
  assert.ok(service.manifest.methods.some((m) => m.name === 'relayHandshake' && m.priceBEM === '0'))
  const ka = generateKeyPair(), kb = generateKeyPair()
  const { invite, pending } = createInvite({ self: { ...A, staticSecret: ka.secretKey }, peer: { ...B, staticPublic: kb.publicKey }, relays: [{ url, container: ADDR.container }] })
  const rooms = channel.roomsFor(invite.cid)
  const { accept, session: bob } = acceptInvite({ self: { ...B, staticSecret: kb.secretKey }, peer: { ...A, staticPublic: ka.publicKey }, invite })
  // B has no payer at all / B 完全没有付款方
  const bobLink = relayTransport({ api, svc: service, inbound: rooms.toResponder, outbound: rooms.toInitiator, waitMs: 500 })
  await bobLink.send(encodeWire(accept))          // free: a handshake message / 免费：握手消息
  await assert.rejects(bobLink.send(encodeWire(bob.seal('data needs payment'))), (e) => e.code === 'PAYMENT_REQUIRED')
  const aliceLink = relayTransport({ api, svc: service, inbound: rooms.toInitiator, outbound: rooms.toResponder, waitMs: 500 })
  const { ready } = completeInvite(pending, decodeWire((await aliceLink.poll(0))[0]).handshake)
  await aliceLink.send(encodeWire(ready))         // A's ready is free too / A 的 ready 同样免费
  bob.confirm(decodeWire((await bobLink.poll(0))[0]).handshake)
  srv.close(); await startRelay('0')
})
