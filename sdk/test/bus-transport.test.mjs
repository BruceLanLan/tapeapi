// TAP-26 §3.7: a Tape Channel whose only transport is the chain (a ChannelBus `send` per wire message, the Wire log
// read back). No relay, no server. / 只用链作为传输的 Tape Channel：每条线路消息一笔 ChannelBus send，读回 Wire 日志。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { channel, TapeAPIError } from '../src/index.js'
import { createRpc } from '../src/rpc.js'
import { createFakeChain } from './helpers/fake-chain.mjs'

const { createInvite, acceptInvite, completeInvite, generateKeyPair, encodeWire, decodeWire, busTransport, CHANNELBUS_MAX_WIRE, CHANNELBUS_MAX_BATCH } = channel
const A = { container: '0x86DDaEF00401E3F10418398D67D7189fc458eA95', chainId: 56 }
const B = { container: '0x19366c3c69ffeb3b286d9fa6cc5e616375baafd3', chainId: 56 }
// a ChannelBus address (contracts/src/ChannelBus.sol; not deployed yet) / ChannelBus 地址（尚未部署）
const BUS = '0x' + 'cb'.repeat(20)
const RPC = ['http://rpc1', 'http://rpc2']

function setup(opts = {}) {
  const chain = createFakeChain()
  const rpc = createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch })
  const ka = generateKeyPair(), kb = generateKeyPair()
  const { invite, pending } = createInvite({ self: { ...A, staticSecret: ka.secretKey }, peer: { ...B, staticPublic: kb.publicKey }, bus: BUS })
  // the initiator listens on toInitiator and posts to toResponder; the responder the other way round
  // 发起方监听 toInitiator、发往 toResponder；响应方相反
  const rooms = channel.roomsFor(invite.cid)
  const start = chain.state.block
  // These tests mine one block and read at once: they pin the transport, not the confirmation depth, so they keep
  // the old default of 0 (the default is 2 since arch B13; the confirmations test below and review-arch cover it).
  // 这些测试出一个块就读：测的是传输本身而不是确认深度，所以沿用旧默认值 0（arch B13 起默认为 2）。
  const busA = busTransport({ rpc, bus: BUS, inbound: rooms.toInitiator, outbound: rooms.toResponder, sendTx: async (tx) => chain.submit(tx), fromBlock: start, confirmations: 0, ...opts })
  const busB = busTransport({ rpc, bus: BUS, inbound: rooms.toResponder, outbound: rooms.toInitiator, sendTx: async (tx) => chain.submit(tx), fromBlock: start, confirmations: 0, ...opts })
  return { chain, rpc, ka, kb, invite, pending, busA, busB, rooms }
}

test('a whole channel -- handshake and frames both ways -- over the chain alone', async () => {
  const { chain, ka, kb, invite, pending, busA, busB } = setup()
  // B accepts and posts the accept on chain / B 接受并把 accept 发上链
  const { accept, session: bob } = acceptInvite({ self: { ...B, staticSecret: kb.secretKey }, peer: { ...A, staticPublic: ka.publicKey }, invite })
  await busB.send(encodeWire(accept))
  chain.mine()
  const [w1] = await busA.poll()
  const { ready, session: alice } = completeInvite(pending, decodeWire(w1).handshake)
  // ready and the first two frames in ONE transaction / ready 与前两帧放进同一笔交易
  await busA.sendMany([encodeWire(ready), encodeWire(alice.seal('first move')), encodeWire(alice.seal('second move'))])
  chain.mine()
  const got = await busB.poll()
  assert.equal(got.length, 3, 'three wire messages from one sendMany arrive in order')
  bob.confirm(decodeWire(got[0]).handshake)
  assert.equal(bob.open(decodeWire(got[1]).frame, { text: true }).data, 'first move')
  assert.equal(bob.open(decodeWire(got[2]).frame, { text: true }).data, 'second move')
  await busB.send(encodeWire(bob.seal('reply')))
  chain.mine()
  assert.equal(alice.open(decodeWire((await busA.poll())[0]).frame, { text: true }).data, 'reply')
  assert.deepEqual(await busA.poll(), [], 'nothing is delivered twice')
})

test('a range read again (reorg, restart from an older block) cannot replay: the channel sequence refuses it', async () => {
  const { chain, ka, kb, invite, pending, busA, busB, rpc, rooms } = setup()
  const { accept, session: bob } = acceptInvite({ self: { ...B, staticSecret: kb.secretKey }, peer: { ...A, staticPublic: ka.publicKey }, invite })
  await busB.send(encodeWire(accept)); chain.mine()
  const { ready, session: alice } = completeInvite(pending, decodeWire((await busA.poll())[0]).handshake)
  await busA.send(encodeWire(ready)); await busA.send(encodeWire(alice.seal('once'))); chain.mine()
  const first = await busB.poll()
  bob.confirm(decodeWire(first[0]).handshake)
  bob.open(decodeWire(first[1]).frame)
  // a second reader of B's room restarting from an older block sees the same frame again. (It used to start at block 0:
  // 62 million blocks, which overran the per-poll budget on a loaded machine and held, a flaky test, not a bug.)
  // 从更早区块重新读的第二个读者再次看到同一帧。（以前从 0 号区块读：6200 万个区块，机器繁忙时超出每轮预算而停住，是测试不稳，不是缺陷。）
  const again = busTransport({ rpc, bus: BUS, inbound: rooms.toResponder, outbound: '00'.repeat(32), fromBlock: chain.state.block - 50, confirmations: 0 })
  const replayed = await again.poll()
  assert.ok(replayed.length >= 2)
  assert.throws(() => bob.open(decodeWire(replayed[1]).frame), (e) => e instanceof TapeAPIError && e.code === 'CHANNEL_INVALID')
})

test('junk posted to a room by someone who saw its id is skipped or refused, never fatal', async () => {
  const { chain, ka, kb, invite, pending, busA, busB, rooms } = setup()
  const { accept } = acceptInvite({ self: { ...B, staticSecret: kb.secretKey }, peer: { ...A, staticPublic: ka.publicKey }, invite })
  const outsider = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: '00'.repeat(32), outbound: rooms.toInitiator, sendTx: async (tx) => chain.submit(tx) })
  await outsider.send(new Uint8Array([0x02, 1, 2, 3]))   // a "frame" that authenticates under no key / 在任何密钥下都认证不了的"帧"
  await busB.send(encodeWire(accept))
  chain.mine()
  const got = await busA.poll()
  assert.equal(got.length, 2)
  assert.equal(decodeWire(got[0]).handshake, undefined, 'the junk is a wire frame, not an accept: the initiator ignores it')
  assert.ok(completeInvite(pending, decodeWire(got[1]).handshake).session, 'the genuine accept still completes')
})

test('confirmations keep reads behind the head; decoration such as blockTimestamp is not a disagreement', async () => {
  const { chain, ka, kb, invite, busA, busB } = setup({ confirmations: 2 })
  const { accept } = acceptInvite({ self: { ...B, staticSecret: kb.secretKey }, peer: { ...A, staticPublic: ka.publicKey }, invite })
  await busB.send(encodeWire(accept))
  chain.mine(1)
  assert.deepEqual(await busA.poll(), [], 'one block old: not yet read')
  chain.mine(2)
  assert.equal((await busA.poll()).length, 1, 'rpc2 adds blockTimestamp to its logs, rpc1 does not; the reads still agree')
})

test('an invite may name a bus, which the key schedule then authenticates', () => {
  const ka = generateKeyPair(), kb = generateKeyPair()
  const { invite, pending } = createInvite({ self: { ...A, staticSecret: ka.secretKey }, peer: { ...B, staticPublic: kb.publicKey }, bus: BUS })
  assert.equal(invite.bus, BUS)
  assert.throws(() => createInvite({ self: { ...A, staticSecret: ka.secretKey }, peer: { ...B, staticPublic: kb.publicKey }, bus: 'nope' }), /bus must be/)
  // swapping the bus in transit breaks the handshake: B's confirm will not verify at A / 途中换掉总线，握手失败
  const { accept } = acceptInvite({ self: { ...B, staticSecret: kb.secretKey }, peer: { ...A, staticPublic: ka.publicKey }, invite: { ...invite, bus: '0x' + '66'.repeat(20) } })
  assert.throws(() => completeInvite(pending, accept), TapeAPIError)
})

test('send / sendMany build ChannelBus calls; oversize, empty, too many and wallet-less sends are refused', async () => {
  const { busA } = setup()
  const tx = busA.tx(new Uint8Array([1, 2, 3]))
  assert.equal(tx.to, BUS)
  assert.ok(tx.data.startsWith('0x4fdf7085'), 'send(bytes32,bytes)')
  assert.equal(tx.value, '0x0')
  assert.ok(busA.txMany([new Uint8Array([1]), new Uint8Array([2, 3])]).data.startsWith('0x95b97a92'), 'sendMany(bytes32,bytes)')
  // the packed layout is uint16 length ‖ wire, the same the contract parses / 打包格式与合约解析一致
  assert.ok(busA.txMany([new Uint8Array([0xaa]), new Uint8Array([0xbb, 0xcc])]).data.includes('0001aa0002bbcc'))
  assert.throws(() => busA.tx(new Uint8Array(CHANNELBUS_MAX_WIRE + 1)), /exceeds/)
  assert.throws(() => busA.tx(new Uint8Array(0)), /non-empty/)
  assert.throws(() => busA.txMany([]), /1\.\.16/)
  assert.throws(() => busA.txMany(Array.from({ length: CHANNELBUS_MAX_BATCH + 1 }, () => new Uint8Array([1]))), /1\.\.16/)
  const noWallet = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: createFakeChain().fetch }), bus: BUS, inbound: 'aa'.repeat(32), outbound: 'bb'.repeat(32) })
  await assert.rejects(noWallet.send(new Uint8Array([1])), /holds no wallet/)
  assert.throws(() => busTransport({ rpc: {}, bus: BUS, inbound: 'aa'.repeat(32), outbound: 'bb'.repeat(32) }), /rpc/)
  assert.throws(() => busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: createFakeChain().fetch }), bus: 'nope', inbound: 'aa'.repeat(32), outbound: 'bb'.repeat(32) }), /bus/)
})


test('one honest node is enough: a node that refuses eth_getLogs does not stop the channel', async () => {
  const { chain, ka, kb, invite, busA, busB } = setup()
  const { accept } = acceptInvite({ self: { ...B, staticSecret: kb.secretKey }, peer: { ...A, staticPublic: ka.publicKey }, invite })
  await busB.send(encodeWire(accept))
  chain.mine()
  // the BNB Chain dataseed nodes answer every eth_getLogs with an error; the other node still has the frame
  // BNB 链的 dataseed 节点对任何 eth_getLogs 都报错；另一个节点仍然有这一帧
  chain.setFault('http://rpc2', 'nologs')
  assert.equal((await busA.poll()).length, 1)
  // with every node refusing, the read fails loudly and names the nodes by hostname, never by keyed URL
  // 所有节点都拒绝时明确报错，只按主机名指出节点
  chain.setFault('http://rpc1', 'nologs')
  const fresh = busTransport({ rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, inbound: 'aa'.repeat(32), outbound: 'bb'.repeat(32), fromBlock: 0, confirmations: 0 })
  await assert.rejects(fresh.poll(), (e) => e.code === 'RPC_UNAVAILABLE' && /rpc1/.test(e.message) && !/http:/.test(e.message))
  chain.setFault('http://rpc1', null); chain.setFault('http://rpc2', null)
})
