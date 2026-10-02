// TapeSend (TAP-10) interop: our seal/open must agree byte for byte with the reference module @tapekit/send, as
// pinned by its own test vectors (sdk/test/fixtures/tapesend-vectors.json, MIT, TapeOutProtocol/TapeKit f1831a4).
// TapeSend 互通：我们的封装/打开必须与参考模块逐字节一致，以其官方测试向量为准。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { x25519 } from '@noble/curves/ed25519'
import { tapesend, TapeAPIError, channel, createTapeAPI } from '../src/index.js'
import { createConformChain } from './helpers/conform-chain.mjs'
import { hexToBytes, toHex, decodeParams } from '../src/abi.js'
import { keccak_256 } from '@noble/hashes/sha3'

const V = JSON.parse(await readFile(new URL('./fixtures/tapesend-vectors.json', import.meta.url), 'utf8'))
const h = (x) => hexToBytes(x)

test('seal reproduces the official sealed vector byte for byte', () => {
  const s = V.sealed, i = s.input
  const queue = [h(i.ephemeralSecret), h(i.nonce), h(i.contentKey)]   // the reference draws e, N, K in this order / 参考实现按此顺序取随机数
  const payload = tapesend.seal({
    content: h(i.content), recipients: i.recipientSecretKeys.map((k) => x25519.getPublicKey(h(k))),
    to: i.to, from: i.from, hub: i.hub, ref: i.ref, chainId: i.chainId, random: () => queue.shift(),
  })
  assert.equal(toHex(payload), s.payload)
  assert.equal(payload.length, s.payloadLength)
})

test('every official opening case gives the same outcome', () => {
  for (const c of V.opening) {
    const run = () => tapesend.open({ payload: h(c.payload), secretKey: c.secretKey ? h(c.secretKey) : undefined, to: c.to, from: c.from, hub: c.hub, ref: c.ref })
    if (c.expect === 'ok') assert.equal(toHex(run().content), V.sealed.input.content, c.name)
    else assert.throws(run, (e) => e instanceof TapeAPIError && e.reason === c.expect, `${c.name}: expected ${c.expect}`)
  }
})

test('public payloads, rejected recipient keys and message ids match the reference', () => {
  assert.equal(toHex(tapesend.encodePublic(h(V.public.content))), V.public.payload)
  for (const r of V.rejectedRecipientKeys) assert.throws(() => tapesend.assertValidPublicKey(h(r.key)), (e) => e.reason === 'bad-key', r.name)
  for (const m of V.messageIds) assert.equal(tapesend.messageId(m), m.id)
})

// TAPI-26 §3.2 "TapeSend (durable fallback)", as corrected in 1.5 (erratum): TAP-10 governs such a message completely, so the
// invite is sealed to B's USABLE TAP-10 key, read from the hub (TAP-10 §14.4, §15.3 step 2), never to B's channel key. A key
// TAP-10 clients never seal to could only ever be not-for-key to the official app. Here B's key comes from
// api.chain.tapeSendKey, in the conformance mode (strict, §14.4 steps 1-3), on a fake chain.
// TAPI-26 §3.2 的 TapeSend 兜底（1.5 勘误）：此时消息完全由 TAP-10 支配，邀请封给 B 在中枢上**可用**的 TAP-10 密钥，绝不封给通道密钥。
test('a TAPI-26 invite sent by TapeSend is sealed to the recipient\'s usable TAP-10 key from the hub (erratum, 1.5); a TapeSend client sees an unsupported kind, B opens it', async () => {
  const ka = channel.generateKeyPair(), kb = channel.generateKeyPair()   // channel (static) keys of the handshake / 握手的通道密钥
  const tb = channel.generateKeyPair()                                   // B's TapeSend (TAP-10) key pair / B 的 TapeSend 密钥对
  const fake = createConformChain()
  const b = fake.circuit(4246, { holder: '0x' + '0b'.repeat(20) })
  fake.setTapeSendKey(b.container, { circuits: b.circuits, tokenId: 4246, key: toHex(tb.publicKey), holder: '0x' + '0b'.repeat(20) })
  const api = createTapeAPI({ conform: 'tap10', rpcUrls: ['http://rpc1', 'http://rpc2', 'http://rpc3'], fetch: fake.fetch, quiet: true, onWarning: () => {} })
  const bKey = await api.chain.tapeSendKey(b.container)
  assert.equal(bKey.tap10.status, 'ok')
  const A = { container: '0x86DDaEF00401E3F10418398D67D7189fc458eA95', chainId: 56 }
  const B = { container: b.container, chainId: 56 }
  const HUB = '0xe61A9C7213a6Aa616C246a2B569e555B417b25ee'
  const { invite } = channel.createInvite({ self: { ...A, staticSecret: ka.secretKey }, peer: { ...B, staticPublic: kb.publicKey }, relays: [{ url: 'https://relay.example/tapeapi/v1', container: '0x3e1a3e1a3e1a3e1a3e1a3e1a3e1a3e1a3e1a3e1a' }] })
  const content = channel.encodeInviteContent(invite)
  const payload = tapesend.seal({ content, recipients: [hexToBytes(bKey.staticPublic)], to: B.container, from: A.container, hub: HUB, conform: 'tap10' })
  assert.ok(payload.length <= tapesend.MAX_PAYLOAD)
  // B opens it with its TapeSend secret, as the official app would; the channel secret does not open it
  // B 用 TapeSend 私钥打开（与官方应用相同）；通道私钥打不开
  const opened = tapesend.open({ payload, secretKey: tb.secretKey, to: B.container, from: A.container, hub: HUB })
  assert.deepEqual(channel.decodeInviteContent(opened.content), invite)
  assert.throws(() => tapesend.open({ payload, secretKey: kb.secretKey, to: B.container, from: A.container, hub: HUB }), (e) => e.reason === 'not-for-key')
  // the TapeSend content rules: v is 1 and kind is not "message", so the official app shows it as unsupported
  // TapeSend 内容规则：v 为 1、kind 不是 "message"，官方应用显示为"不支持"
  const asJson = JSON.parse(new TextDecoder().decode(opened.content))
  assert.equal(asJson.v, 1)
  assert.notEqual(asJson.kind, 'message')
  // the hub call / 中枢调用
  const tx = tapesend.sendTx({ hub: HUB, circuits: '0x50a994e7' + '00'.repeat(16), tokenId: 4246, to: B.container, payload })
  assert.ok(tx.data.startsWith('0xa181b579'))
  const [circuits, tokenId, to, ref, sent] = decodeParams(['address', 'uint256', 'bytes32', 'bytes32', 'bytes'], hexToBytes('0x' + tx.data.slice(10)))
  assert.equal(tokenId, 4246n)
  assert.equal(to, toHex(tapesend.endpoint(B.container)))
  assert.equal(ref, '0x' + '00'.repeat(32))
  assert.equal(sent, toHex(payload))
})

// ---- TAP10-X: cross-chain endpoints. TAP-10 §15.3: `to` is on the recipient's chain, `from` on the sending chain; §17: the
// message ID's chainId is the chain whose hub holds the entry. TAP-10 publishes no sealed vector with two different chains
// (its message-ID vector #2 is one), so the sealed cases below are derived by hand from §12.1 / §15.3 and written out as
// literal 32-byte endpoints that do not go through `endpoint()` at all.
// TAP10-X：跨链端点。§15.3：`to` 在收件方所在链，`from` 在发送链；§17：消息 ID 的 chainId 是存放该条目的中枢所在链。
// TAP-10 没有发布两条不同链的密封向量（其消息 ID 向量 #2 是跨链的），所以下面的密封用例按 §12.1 / §15.3 手算，并写成不经过 endpoint() 的字面 32 字节端点。
const BNB = 56, BASE = 8453   // 8453 = 0x2105
const HUB = V.sealed.input.hub
const SENDER = V.sealed.input.from                    // a container on BNB Smart Chain / 在 BNB Smart Chain 上的容器
const RECIPIENT = V.sealed.input.to                   // a container on Base / 在 Base 上的容器
// uint32(0) ‖ uint64(chainId) ‖ container, typed out by hand / 手写：uint32(0) ‖ uint64(chainId) ‖ container
const EP_SENDER_BNB = '0x' + '00000000' + '0000000000000038' + SENDER.slice(2)
const EP_RECIPIENT_BASE = '0x' + '00000000' + '0000000000002105' + RECIPIENT.slice(2)
const EP_RECIPIENT_BNB = '0x' + '00000000' + '0000000000000038' + RECIPIENT.slice(2)
const sealWith = (over) => {
  const i = V.sealed.input, queue = [h(i.ephemeralSecret), h(i.nonce), h(i.contentKey)]
  return tapesend.seal({ content: h(i.content), recipients: i.recipientSecretKeys.map((k) => x25519.getPublicKey(h(k))), hub: HUB, ref: i.ref, random: () => queue.shift(), ...over })
}
const openWith = (payload, over) => tapesend.open({ payload, secretKey: h(V.sealed.input.recipientSecretKeys[0]), hub: HUB, ref: V.sealed.input.ref, ...over })
const reason = (e) => e instanceof TapeAPIError && e.reason

test('TAP10-X1 endpoints: an address on Base and one on BNB get their own chain; a 32-byte endpoint is taken as given', () => {
  assert.equal(toHex(tapesend.endpoint(RECIPIENT, BASE)), EP_RECIPIENT_BASE)
  assert.equal(toHex(tapesend.endpoint(SENDER, BNB)), EP_SENDER_BNB)
  assert.equal(toHex(tapesend.endpoint(EP_RECIPIENT_BASE, BNB)), EP_RECIPIENT_BASE)   // the chain argument is ignored / 链参数被忽略
})

test('TAP10-X2 seal across chains (sender on BNB, recipient on Base): X is built from to@Base and from@BNB (§15.3)', () => {
  const viaToChainId = sealWith({ to: RECIPIENT, from: SENDER, chainId: BNB, toChainId: BASE })
  const viaEndpoints = sealWith({ to: EP_RECIPIENT_BASE, from: EP_SENDER_BNB })
  assert.equal(toHex(viaToChainId), toHex(viaEndpoints))                                   // toChainId == the hand-built endpoints
  assert.equal(toHex(sealWith({ to: EP_RECIPIENT_BASE, from: EP_SENDER_BNB, chainId: 1, toChainId: 2 })), toHex(viaEndpoints))   // 32-byte endpoints ignore both / 32 字节端点忽略两者
  // the old behaviour (both endpoints on one chain) is a different payload, and it is not what a TAP-10 client expects
  // 旧行为（两个端点同链）得到不同的载荷，TAP-10 客户端不认
  assert.notEqual(toHex(sealWith({ to: RECIPIENT, from: SENDER, chainId: BNB })), toHex(viaToChainId))
  assert.notEqual(toHex(sealWith({ to: RECIPIENT, from: SENDER, chainId: BASE })), toHex(viaToChainId))
  // the recipient opens it with the real endpoints, in either spelling; with the old single-chain spelling it is `damaged`
  // 收件人用真实端点（两种写法皆可）能打开；用旧的单链写法打开是 damaged
  for (const o of [{ to: RECIPIENT, from: SENDER, chainId: BNB, toChainId: BASE }, { to: EP_RECIPIENT_BASE, from: EP_SENDER_BNB }])
    assert.equal(toHex(openWith(viaToChainId, o).content), V.sealed.input.content)
  assert.throws(() => openWith(viaToChainId, { to: RECIPIENT, from: SENDER, chainId: BNB }), (e) => reason(e) === 'damaged')
  assert.throws(() => openWith(viaToChainId, { to: EP_RECIPIENT_BNB, from: EP_SENDER_BNB }), (e) => reason(e) === 'damaged')
})

test('TAP10-X3 without toChainId nothing changes: same chain gives the same bytes as before, and equals the official vector', () => {
  const sameChain = sealWith({ to: RECIPIENT, from: SENDER, chainId: BNB })
  assert.equal(toHex(sameChain), V.sealed.payload)                                          // the official vector, chainId 56 for both / 官方向量
  assert.equal(toHex(sealWith({ to: RECIPIENT, from: SENDER, chainId: BNB, toChainId: BNB })), V.sealed.payload)
  assert.equal(toHex(sealWith({ to: EP_RECIPIENT_BNB, from: EP_SENDER_BNB })), V.sealed.payload)
  assert.equal(toHex(sealWith({ to: RECIPIENT, from: SENDER })), V.sealed.payload)          // chainId defaults to 56 / 默认 56
  assert.equal(toHex(openWith(h(V.sealed.payload), { to: RECIPIENT, from: SENDER, toChainId: BNB }).content), V.sealed.input.content)
  assert.throws(() => sealWith({ to: RECIPIENT, from: SENDER, toChainId: 0 }), (e) => reason(e) === 'bad-input')
})

test('TAP10-X4 message id across chains (§17): chainId is the hub chain, the to endpoint is on the recipient chain', () => {
  // the official vector #2: hub on Base (8453), `to` the BNB endpoint 0x…38 ‖ 0x1111… / 官方向量 #2：中枢在 Base，to 是 BNB 端点
  const v = V.messageIds[1]
  assert.equal(v.chainId, BASE)
  assert.equal(tapesend.messageId({ chainId: BASE, toChainId: BNB, hub: v.hub, to: RECIPIENT, inboxIndex: v.inboxIndex }), v.id)   // the address spelling gives the official id / 地址写法得到官方 ID
  assert.notEqual(tapesend.messageId({ chainId: BASE, hub: v.hub, to: RECIPIENT, inboxIndex: v.inboxIndex }), v.id)               // without toChainId the endpoint would be on Base / 不给 toChainId 则端点在 Base
  // sender on BNB, recipient on Base: the entry lives in the BNB hub, so uint256(56) ‖ hub ‖ (to@Base) ‖ uint256(7).
  // Hand-derived: keccak256("TAP-10/msg/v2" ‖ 32 bytes of 56 ‖ hub ‖ EP_RECIPIENT_BASE ‖ 32 bytes of 7).
  // 发送方在 BNB、收件方在 Base：条目存放在 BNB 的中枢里，故为 uint256(56) ‖ hub ‖ (to@Base) ‖ uint256(7)。按规则手算。
  const u256 = (n) => { const b = new Uint8Array(32); b[31] = n; return b }
  const manual = toHex(keccak_256(Uint8Array.from([...new TextEncoder().encode('TAP-10/msg/v2'), ...u256(BNB), ...h(HUB), ...h(EP_RECIPIENT_BASE), ...u256(7)])))
  const id = tapesend.messageId({ chainId: BNB, toChainId: BASE, hub: HUB, to: RECIPIENT, inboxIndex: 7 })
  assert.equal(id, manual)
  assert.equal(id, tapesend.messageId({ chainId: BNB, hub: HUB, to: EP_RECIPIENT_BASE, inboxIndex: 7 }))   // a 32-byte endpoint gives the same / 32 字节端点结果相同
  assert.notEqual(id, tapesend.messageId({ chainId: BNB, hub: HUB, to: RECIPIENT, inboxIndex: 7 }))         // the single-chain spelling is a different id / 单链写法是另一个 ID
  // the default is unchanged / 默认不变
  assert.equal(tapesend.messageId(V.messageIds[0]), V.messageIds[0].id)
  assert.equal(tapesend.messageId({ ...V.messageIds[0], toChainId: V.messageIds[0].chainId }), V.messageIds[0].id)
})

test('TAP10-X5 sendTx: the `to` word is the recipient-chain endpoint; the default and 32-byte endpoints are unchanged', () => {
  const args = { hub: HUB, circuits: '0x50a994e7' + '00'.repeat(16), tokenId: 4246, payload: Uint8Array.of(1, 2, 3) }
  const toWord = (tx) => decodeParams(['address', 'uint256', 'bytes32', 'bytes32', 'bytes'], hexToBytes('0x' + tx.data.slice(10)))[2]
  assert.equal(toWord(tapesend.sendTx({ ...args, to: RECIPIENT, chainId: BNB, toChainId: BASE })), EP_RECIPIENT_BASE)
  assert.equal(toWord(tapesend.sendTx({ ...args, to: EP_RECIPIENT_BASE })), EP_RECIPIENT_BASE)
  assert.equal(toWord(tapesend.sendTx({ ...args, to: RECIPIENT })), EP_RECIPIENT_BNB)                         // default: the old behaviour / 默认：旧行为
  assert.equal(toWord(tapesend.sendTx({ ...args, to: RECIPIENT, chainId: BASE })), EP_RECIPIENT_BASE)         // hub chain applies to `to` when no toChainId / 不给 toChainId 时 to 用 chainId
  assert.equal(toWord(tapesend.sendTx({ ...args, to: EP_RECIPIENT_BASE, chainId: BNB, toChainId: 196 })), EP_RECIPIENT_BASE)
})
