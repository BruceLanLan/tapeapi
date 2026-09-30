// TapeSend (TAP-10) interop: our seal/open must agree byte for byte with the reference module @tapekit/send, as
// pinned by its own test vectors (sdk/test/fixtures/tapesend-vectors.json, MIT, TapeOutProtocol/TapeKit f1831a4).
// TapeSend 互通：我们的封装/打开必须与参考模块逐字节一致，以其官方测试向量为准。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { x25519 } from '@noble/curves/ed25519'
import { tapesend, TapeAPIError, channel } from '../src/index.js'
import { hexToBytes, toHex, decodeParams } from '../src/abi.js'

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

test('a TAPI-26 invite rides a sealed TapeSend message; a TapeSend client sees an unsupported kind, B opens it', () => {
  const ka = channel.generateKeyPair(), kb = channel.generateKeyPair()
  const A = { container: '0x86DDaEF00401E3F10418398D67D7189fc458eA95', chainId: 56 }
  const B = { container: '0x19366c3c69ffeb3b286d9fa6cc5e616375baafd3', chainId: 56 }
  const HUB = '0xe61A9C7213a6Aa616C246a2B569e555B417b25ee'
  const { invite } = channel.createInvite({ self: { ...A, staticSecret: ka.secretKey }, peer: { ...B, staticPublic: kb.publicKey }, relays: [{ url: 'https://relay.example/tapeapi/v1', container: '0x3e1a3e1a3e1a3e1a3e1a3e1a3e1a3e1a3e1a3e1a' }] })
  const content = channel.encodeInviteContent(invite)
  const payload = tapesend.seal({ content, recipients: [kb.publicKey], to: B.container, from: A.container, hub: HUB })
  assert.ok(payload.length <= tapesend.MAX_PAYLOAD)
  const opened = tapesend.open({ payload, secretKey: kb.secretKey, to: B.container, from: A.container, hub: HUB })
  assert.deepEqual(channel.decodeInviteContent(opened.content), invite)
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
