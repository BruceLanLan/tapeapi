// End to end: the group-chat example against a real relay service on localhost (the reference relay behind a verified
// TapeAPI provider), with two independent clients that each resolve the relay from the chain and check every answer.
// The owner delivers, the member receives, joins, and the two exchange a message each.
// 端到端：群聊示例对接本机上一个真实的中继服务（经过完整验证的 TapeAPI 提供者背后的参考中继），两个独立客户端各自从链上
// 解析中继并核验每个回答。群主投递、成员收到、入群、双方各发一条消息。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createProvider } from '../../server/src/index.js'
import { createTapeAPI, channel, MANIFEST_KEY } from '../../sdk/src/index.js'
import { privateKeyToAddress, signDigest, delegationDigest } from '../../sdk/src/sig.js'
import { createFakeChain, ADDR } from '../../sdk/test/helpers/fake-chain.mjs'
import { createRelayCore, relayMethods, relayManifestMethods } from '../relay-service/relay-core.mjs'
import { runGroupChat } from './index.mjs'

const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32)
const holder = privateKeyToAddress(HOLDER_KEY), signer = privateKeyToAddress(SIGNER_KEY)
const RPC = ['http://rpc1', 'http://rpc2']
const EXPIRES = Math.floor(Date.now() / 1000) + 300 * 86400

let chain, core, srv, url

before(async () => {
  chain = createFakeChain()
  chain.setOwner(4246, holder); chain.setAccount(4246, ADDR.container)
  core = createRelayCore()
  const manifest = {
    tapeapi: '0.1', name: 'relay.tape', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
    delegation: { expires: EXPIRES, sig: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires: EXPIRES }), HOLDER_KEY) },
    endpoints: { live: ['http://127.0.0.1:1/tapeapi/v1'], async: false },
    methods: relayManifestMethods({ priceBEM: '0' }),
  }
  const provider = createProvider({ minVoucherLifeS: 0, manifest, signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: chain.fetch, allowHttp: true, log: () => {}, methods: relayMethods(core) })
  srv = await provider.listen(0)
  url = `http://127.0.0.1:${srv.address().port}/tapeapi/v1`
  provider.manifest.endpoints.live = [url]
  chain.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify({ ...manifest, endpoints: { live: [url], async: false } }))
})
after(() => srv?.close())

// Each side is its own client: its own RPC reads, its own resolve, its own signature checks.
// 每一方各自一个客户端：各自读链、各自解析、各自验签。
async function client() {
  const api = createTapeAPI({ rpcUrls: RPC, quorum: 2, chainId: 56, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, allowHttp: true, fetch: chain.fetchWith(), timeoutMs: 30_000 })
  return { api, svc: await api.resolve(ADDR.container) }
}

test('group-chat example, two independent clients through a verified relay: deliver, receive, join, one message each way', async () => {
  const [owner, member] = await Promise.all([client(), client()])
  assert.notEqual(owner.api, member.api)
  const lines = []
  const r = await runGroupChat({ owner, member, relayUrl: url, log: (l) => lines.push(l), waitMs: 200 })

  assert.deepEqual(r.deliveries.map((d) => d.what), ['invite', 'epoch'])
  assert.ok(r.deliveries.every((d) => d.ok && Number.isInteger(d.i) && typeof d.epoch === 'string'), 'every post has the relay\'s { i, epoch }')
  assert.equal(r.deliveries[0].room, r.inboxRoom, 'the member read the room the owner posted its invite to')
  assert.equal(r.deliveries[1].room, r.groupRoom)
  assert.notEqual(r.inboxRoom, r.groupRoom, 'two different rooms')
  assert.deepEqual(r.heard, { alice: ['hi Alice, Bob here'], bob: ['welcome, Bob'] })
  assert.ok(lines.some((l) => /Bob joined at epoch 0; members: 2/.test(l)))

  // The relay holds ciphertext only: no message text, no invite JSON / 中继只持有密文
  for (const f of core.dump()) {
    const bytes = Buffer.from(f, 'base64').toString('latin1')
    for (const leak of ['Bob here', 'welcome', 'tape.group/invite', r.gid]) assert.ok(!bytes.includes(leak), `no "${leak}" on the relay`)
  }
  // And a sealed invite cannot be read out of the member's inbox by anyone else / 别人读不出成员收件房间里的密封邀请
  const stranger = channel.generateIdentity()
  const [inv] = (await core.recv(r.inboxRoom, -1)).frames
  assert.throws(() => channel.openFromInbox(channel.fromBase64(inv.frame), { self: { container: '0x' + '00'.repeat(20), staticSecret: stranger.x25519.secretKey } }))
})
