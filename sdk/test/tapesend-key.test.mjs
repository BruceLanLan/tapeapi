// TAP-26 §3.1：对方的长期公钥 MUST 来自 DeWebHub。这里既用主网录制数据回放，也用假链覆盖每一种拒绝路径。
// TAP-26 §3.1: the peer's static key MUST come from the DeWebHub. Replayed from recorded mainnet responses, and
// every refusal path covered on the fake chain.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createTapeAPI, channel, TapeAPIError } from '../src/index.js'
import { createFakeChain, ADDR } from './helpers/fake-chain.mjs'

const fx = JSON.parse(readFileSync(new URL('./fixtures/mainnet-4246-tapesend-key.json', import.meta.url), 'utf8'))
// Keyed by (to, data): a call to the wrong address (factory.isCPU on another factory) is not in the fixture (review R2-6)
// 按 (to, data) 取：发往错误地址的调用（例如别的工厂的 isCPU）不在录制数据里
const byCall = new Map(Object.values(fx.calls).map((c) => [`${c.to.toLowerCase()}:${c.data.toLowerCase()}`, c]))
const replay = async (url, init) => {
  const req = JSON.parse(init.body); const c = byCall.get(`${String(req.params[0].to).toLowerCase()}:${req.params[0].data.toLowerCase()}`)
  const body = c ? { jsonrpc: '2.0', id: req.id, result: c.result } : { jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted (not in fixture)' } }
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

test('mainnet vector: container 4246 has a usable X25519 TapeSend key, and a TAP-26 invite to it builds', async () => {
  const api = createTapeAPI({ rpcUrls: ['https://a.invalid', 'https://b.invalid'], quorum: 2, fetch: replay })
  const k = await api.chain.tapeSendKey(fx.container)
  assert.equal(k.container.toLowerCase(), fx.container.toLowerCase())
  assert.equal(k.tokenId, '4246')
  assert.equal(k.staticPublic, '0xc38ae9542694453d43fc9e06c08fb23dd11fea9aaaa1286dd6ce9d2536d36820')
  assert.equal(k.holder.toLowerCase(), '0x571d447f4f24688ec35ccf07f1d6993655f6af15')
  channel.assertPublicKey(channel.fromHex(k.staticPublic, 32), 'the mainnet key')   // canonical, top bit clear
  // The record spreads straight into `peer`. / 返回值可以直接展开成 `peer`。
  const me = channel.generateKeyPair()
  const { invite } = channel.createInvite({ self: { container: '0x0000000000000000000000000000000000000A11', chainId: 56, staticSecret: me.secretKey }, peer: k })
  assert.ok(JSON.stringify(invite).length < 16_000)
})

test('the hub is the only source: a revoked key or a circuit that changed hands is refused, and so is a lying hub', async () => {
  const chain = createFakeChain()
  const api = createTapeAPI({ rpcUrls: ['http://rpc1', 'http://rpc2'], quorum: 2, hub: ADDR.hub, fetch: chain.fetch })
  const key = channel.toHex(channel.generateKeyPair().publicKey)
  chain.setTapeSendKey(ADDR.container, { tokenId: 4246, key: '0x' + key, holder: ADDR.treasury })
  const ok = await api.chain.tapeSendKey(ADDR.container)
  assert.equal(ok.staticPublic, '0x' + key)
  assert.deepEqual(await api.chain.tapeSendKey({ circuits: ADDR.circuits, tokenId: 4246 }), ok, 'both lookup forms agree')

  // The circuit is sold: the hub withholds the previous holder's key. / 电路易主：hub 不再返回前任的钥匙。
  chain.setTapeSendKey(ADDR.container, { tokenId: 4246, key: '0x' + key, usable: false })
  await assert.rejects(api.chain.tapeSendKey(ADDR.container), (e) => e instanceof TapeAPIError && e.code === 'NOT_FOUND' && /no usable TapeSend key/.test(e.message))

  // An unknown suite is not X25519, whatever the bytes look like. / 未知套件就不是 X25519，不管字节长什么样。
  chain.setTapeSendKey(ADDR.container, { tokenId: 4246, key: '0x' + key, suite: 2 })
  await assert.rejects(api.chain.tapeSendKey(ADDR.container), (e) => e.code === 'CHANNEL_INVALID' && /suite/.test(e.message))

  // A hub that answers for a different container than the one we asked about. / hub 回答的是另一个容器。
  const other = '0x000000000000000000000000000000000000dEaD'
  chain.setTapeSendKey(other, { tokenId: 4246, key: '0x' + key })              // same (circuits, tokenId) now maps elsewhere
  chain.state.tokens.set(ADDR.container.toLowerCase(), [56n, ADDR.circuits, 4246n])
  await assert.rejects(api.chain.tapeSendKey(ADDR.container), (e) => e.code === 'CHANNEL_INVALID' && /derives/.test(e.message))

  // Not a container at all, and a container on another chain. / 根本不是容器；以及另一条链上的容器。
  await assert.rejects(api.chain.tapeSendKey('0x0000000000000000000000000000000000001234'), (e) => e.code === 'NOT_FOUND' && /token\(\)/.test(e.message))
  chain.setTapeSendKey(ADDR.escrow, { tokenId: 99, key: '0x' + key, chainId: 8453 })
  await assert.rejects(api.chain.tapeSendKey(ADDR.escrow), (e) => e.code === 'CHANNEL_INVALID' && /chain 8453/.test(e.message))
})
