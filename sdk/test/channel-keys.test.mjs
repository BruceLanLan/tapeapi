// TAP-26 §3.1: a container's channel identity, authorised by the circuit's current holder and published in its site.
// It replaces the TapeSend key as the default identity, because deriving that key asks the holder to sign text that
// says "only sign this on www.tapesend.com" -- which any third-party app would be training users to ignore.
// 容器的通道身份：由电路当前持有人授权、发布在其站点里。它取代 TapeSend 密钥成为默认身份，因为派生那把密钥要求持有人
// 签署"只在 www.tapesend.com 签署"的文字——任何第三方应用都会因此在训练用户无视这条警告。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTapeAPI, channel, sig, TapeAPIError, CHANNEL_KEYS_KEY, canonicalJSON } from '../src/index.js'
import { createRpc } from '../src/rpc.js'
import { createFakeChain, ADDR } from './helpers/fake-chain.mjs'

const RPC = ['http://rpc1', 'http://rpc2']
const HOLDER_KEY = '0x' + '11'.repeat(32)
const holder = sig.privateKeyToAddress(HOLDER_KEY)
const hex = (b) => '0x' + Buffer.from(b).toString('hex')
const nowS = () => Math.floor(Date.now() / 1000)
const A = '0x86DDaEF00401E3F10418398D67D7189fc458eA95'
const B = '0x19366c3c69FFEB3b286D9fA6cC5e616375BAafd3'

// A container with a circuit, a holder and a published channel identity / 一个有电路、有持有人、已发布通道身份的容器
function publish(chain, container, tokenId, { holderKey = HOLDER_KEY, issued = nowS() - 60, expires = nowS() + 30 * 86400, inbox = {}, mutate } = {}) {
  chain.setContainerToken(container, { tokenId })
  chain.setAccount(tokenId, container)
  chain.setOwner(tokenId, sig.privateKeyToAddress(holderKey))
  const id = channel.generateIdentity()
  const keys = { container, x25519: hex(id.x25519.publicKey), ed25519: hex(id.ed25519.publicKey), inbox, issued, expires }
  let record = { tapechannel: '1', container, chainId: 56, ...keys, sig: sig.signDigest(sig.channelKeysDigest(56, ADDR.hub, keys), holderKey) }
  if (mutate) record = mutate(record)
  chain.writeFile(container, CHANNEL_KEYS_KEY, canonicalJSON(record))
  return { id, record }
}
const api = (chain) => createTapeAPI({ rpcUrls: RPC, quorum: 2, chainId: 56, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, fetch: chain.fetch })

test('a published, holder-authorised identity resolves; its keys spread straight into createInvite', async () => {
  const chain = createFakeChain()
  const { id } = publish(chain, A, 4246, { inbox: { relays: [{ url: 'https://relay.example/tapeapi/v1', container: '0x' + '3e'.repeat(20) }] } })
  const k = await api(chain).chain.channelKeys(A)
  assert.equal(k.x25519, hex(id.x25519.publicKey))
  assert.equal(k.ed25519, hex(id.ed25519.publicKey))
  assert.equal(k.holder, holder)
  assert.equal(k.keys, channel.KEYS_CHANNEL)
  assert.equal(k.inbox.room, channel.inboxRoom(A))
  const me = channel.generateIdentity()
  const { invite } = channel.createInvite({ self: { container: B, chainId: 56, staticSecret: me.x25519.secretKey }, peer: k })
  assert.equal(invite.keys, channel.KEYS_CHANNEL)
})

test('the identity lapses by itself when the circuit changes hands, and is refused when anyone else signed it', async () => {
  const chain = createFakeChain()
  publish(chain, A, 4246)
  chain.setOwner(4246, '0x' + '99'.repeat(20))            // sold / 电路卖掉了
  await assert.rejects(api(chain).chain.channelKeys(A), (e) => e.code === 'CHANNEL_INVALID' && /current holder/.test(e.message))
  const c2 = createFakeChain()
  publish(c2, A, 4246, { mutate: (r) => ({ ...r, sig: sig.signDigest(sig.channelKeysDigest(56, ADDR.hub, r), '0x' + '22'.repeat(32)) }) })
  await assert.rejects(api(c2).chain.channelKeys(A), (e) => e.code === 'CHANNEL_INVALID' && /current holder/.test(e.message))
})

test('a TAP-20 service delegation can never pass as a channel authorisation', async () => {
  const chain = createFakeChain()
  publish(chain, A, 4246, { mutate: (r) => ({ ...r, sig: sig.signDigest(sig.delegationDigest(56, ADDR.hub, { container: A, signer: holder, expires: r.expires }), HOLDER_KEY) }) })
  await assert.rejects(api(chain).chain.channelKeys(A), (e) => e.code === 'CHANNEL_INVALID')
  assert.notEqual(hex(sig.CHANNEL_KEYS_TYPEHASH), hex(sig.DELEGATION_TYPEHASH))
})

test('malformed, expired, far-future, foreign and tampered records are refused', async () => {
  const cases = [
    [(r) => ({ ...r, tapechannel: '2' }), /tapechannel/],
    [(r) => ({ ...r, container: B }), /names container/],
    [(r) => ({ ...r, chainId: 97 }), /chain 97/],
    [(r) => ({ ...r, x25519: '0x' + '00'.repeat(32) }), /x25519|low-order|zero/],
    [(r) => ({ ...r, ed25519: '0x' + 'ff'.repeat(32) }), /Ed25519/],
    [(r) => ({ ...r, inbox: { relays: [{ url: 'ftp://x', container: '0x' + '3e'.repeat(20) }] } }), /inbox/],
    [(r) => ({ ...r, x25519: hex(channel.generateKeyPair().publicKey) }), /current holder/],   // key swapped after signing / 签名后换钥
  ]
  for (const [mutate, re] of cases) {
    const chain = createFakeChain()
    publish(chain, A, 4246, { mutate })
    await assert.rejects(api(chain).chain.channelKeys(A), (e) => e.code === 'CHANNEL_INVALID' && re.test(e.message), String(re))
  }
  for (const [expires, re] of [[nowS() - 1, /expired/], [nowS() + 400 * 86400, /366 days/]]) {
    const chain = createFakeChain()
    publish(chain, A, 4246, { expires })
    await assert.rejects(api(chain).chain.channelKeys(A), (e) => re.test(e.message))
  }
  const none = createFakeChain()
  none.setContainerToken(A, { tokenId: 4246 }); none.setAccount(4246, A); none.setOwner(4246, holder)
  await assert.rejects(api(none).chain.channelKeys(A), (e) => e.code === 'CHANNEL_INVALID' && /no file/.test(e.message))
})

test('a Safe holder authorises through EIP-1271', async () => {
  const chain = createFakeChain()
  const safe = '0x' + '5a'.repeat(20)
  const { record } = publish(chain, A, 4246, { holderKey: '0x' + '33'.repeat(32) })
  chain.setOwner(4246, safe)
  await assert.rejects(api(chain).chain.channelKeys(A), (e) => e.code === 'CHANNEL_INVALID')
  chain.setContractHolder(safe, sig.channelKeysDigest(56, ADDR.hub, record))
  assert.equal((await api(chain).chain.channelKeys(A)).holder.toLowerCase(), safe)
})

test('publishChannelKeys writes the canonical record with its hash; removeChannelKeys withdraws it', () => {
  const t = createTapeAPI({ chainId: 56, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry })
  const { record } = publish(createFakeChain(), A, 4246)
  const out = t.tx.publishChannelKeys({ container: A, record })
  assert.equal(out.txs.length, 1)
  assert.equal(out.txs[0].to, ADDR.siteRegistry)
  assert.equal(out.key, CHANNEL_KEYS_KEY)
  assert.throws(() => t.tx.publishChannelKeys({ container: B, record }), /for this container/)
  assert.equal(t.tx.removeChannelKeys(A).to, ADDR.siteRegistry)
})

test('end to end with no TapeSend at all: A finds B by its record, posts a sealed invite to B\'s inbox room, they talk', async () => {
  const chain = createFakeChain()
  const a = publish(chain, A, 1, { holderKey: '0x' + '41'.repeat(32) })
  const b = publish(chain, B, 2, { holderKey: '0x' + '42'.repeat(32), inbox: { bus: '0x' + 'cb'.repeat(20) } })
  const client = api(chain)
  const rpc = createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch })
  const start = chain.state.block
  // A looks B up, invites it on B's own bus, and posts the sealed invite to B's inbox room
  // A 查出 B，在 B 自己的总线上发出邀请，把密封邀请投进 B 的收件房间
  const kb = await client.chain.channelKeys(B)
  const { invite, pending } = channel.createInvite({ self: { container: A, chainId: 56, staticSecret: a.id.x25519.secretKey }, peer: kb, bus: kb.inbox.bus })
  // confirmations: 0 below: this test mines one block and reads at once (the default is 2 since arch B13)
  // 下面的 confirmations: 0：本测试出一块即读（arch B13 起默认为 2）
  const aInbox = channel.busTransport({ rpc, bus: kb.inbox.bus, inbound: channel.roomsFor(invite.cid).toInitiator, outbound: kb.inbox.room, sendTx: async (tx) => chain.submit(tx), fromBlock: start, confirmations: 0 })
  await aInbox.send(channel.sealInvite(invite, { to: kb }))
  chain.mine()
  // B watches its inbox, opens the invite, looks A up by invite.from, and accepts on the rooms of the channel
  // B 监听收件房间，打开邀请，按 invite.from 查出 A，在通道的房间里接受
  const bInbox = channel.busTransport({ rpc, bus: kb.inbox.bus, inbound: kb.inbox.room, outbound: '00'.repeat(32), fromBlock: start, confirmations: 0 })
  const [sealed] = await bInbox.poll()
  const got = channel.openInvite(sealed, { self: { container: B, chainId: 56, staticSecret: b.id.x25519.secretKey } })
  const ka = await client.chain.channelKeys(got.from.container)
  const { accept, session: bob } = channel.acceptInvite({ self: { container: B, chainId: 56, staticSecret: b.id.x25519.secretKey }, peer: ka, invite: got })
  const rooms = channel.roomsFor(got.cid)
  const bLink = channel.busTransport({ rpc, bus: got.bus, inbound: rooms.toResponder, outbound: rooms.toInitiator, sendTx: async (tx) => chain.submit(tx), fromBlock: start, confirmations: 0 })
  await bLink.send(channel.encodeWire(accept)); chain.mine()
  const aLink = channel.busTransport({ rpc, bus: got.bus, inbound: rooms.toInitiator, outbound: rooms.toResponder, sendTx: async (tx) => chain.submit(tx), fromBlock: start, confirmations: 0 })
  const { ready, session: alice } = channel.completeInvite(pending, channel.decodeWire((await aLink.poll())[0]).handshake)
  await aLink.sendMany([channel.encodeWire(ready), channel.encodeWire(alice.seal('hello from A'))]); chain.mine()
  const [r, f] = await bLink.poll()
  bob.confirm(channel.decodeWire(r).handshake)
  assert.equal(bob.open(channel.decodeWire(f).frame, { text: true }).data, 'hello from A')
  // a sealed invite opens for B only / 密封邀请只有 B 打得开
  assert.throws(() => channel.openInvite(sealed, { self: { container: A, chainId: 56, staticSecret: a.id.x25519.secretKey } }), TapeAPIError)
})

test('FIXED arch B4: a record the holder replaced cannot be put back by whoever writes the site', async () => {
  // Nothing in the old record was forged: it carries the holder's real signature. Only the signed `issued` and the
  // client's floor tell it apart. / 旧记录没有任何伪造，签名是持有人真的；只有签名内的 issued 与客户端下限能区分它。
  const chain = createFakeChain()
  const client = api(chain)
  const { record: old } = publish(chain, A, 4246, { issued: nowS() - 3600 })
  await client.chain.channelKeys(A)
  const { id: fresh } = publish(chain, A, 4246, { issued: nowS() - 60 })          // holder rotates the keys / 持有人轮换密钥
  // { fresh: true }: the same client cached the first record (arch B7) / 同一客户端缓存了第一条记录
  assert.equal((await client.chain.channelKeys(A, { fresh: true })).x25519, hex(fresh.x25519.publicKey))
  chain.writeFile(A, CHANNEL_KEYS_KEY, canonicalJSON(old))                        // the old record comes back / 旧记录被放回
  await assert.rejects(client.chain.channelKeys(A, { fresh: true }), (e) => e.code === 'CHANNEL_INVALID' && /older than a record already seen/.test(e.message))
  // a floor passed in survives a restart / 传入的下限可跨重启保留
  const floor = new Map([[A.toLowerCase(), nowS() - 60]])
  const restarted = createTapeAPI({ rpcUrls: RPC, quorum: 2, chainId: 56, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, fetch: chain.fetch, channelRecordFloor: floor })
  await assert.rejects(restarted.chain.channelKeys(A), /older than a record already seen/)
  // issued is signed, in the past or near-present, and before expires / issued 在签名内，不能在未来，且早于 expires
  publish(chain, A, 4246, { issued: nowS() + 3600 })
  await assert.rejects(api(chain).chain.channelKeys(A), /issued is in the future/)
  publish(chain, A, 4246, { mutate: (r) => ({ ...r, issued: r.issued + 1 }) })
  await assert.rejects(api(chain).chain.channelKeys(A), /not authorised by the current holder/)
})
