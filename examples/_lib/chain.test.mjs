// `_lib/chain.mjs` 的单测：注入假节点，不开 socket、不碰网络。
// Unit tests for `_lib/chain.mjs` with injected fake nodes: no sockets, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { TapeAPIError } from '@tapeapi/sdk'
import { createChainReader, createChainReaders, chainReaderOf, blockTag, blockPinnedOf, rejectsBlockObject } from './chain.mjs'

const H = (n) => '0x' + String(n).padStart(64, 'a')

/** 一个假节点：可以指定它在每个块号/标签上报什么，或让它直接失败。 */
function fakeNode({ head = 100, finalized = 90, hash = H(1), timestamp = 1700000000, lacksTag = false, down = false } = {}) {
  return {
    quorum: 1,
    async blockNumber() { if (down) throw new Error('node down'); return head },
    async call(method, params) {
      if (down) throw new Error('node down')
      if (method === 'eth_blockNumber') return '0x' + head.toString(16)
      if (method !== 'eth_getBlockByNumber') throw new Error(`unexpected ${method}`)
      const [tag] = params
      if (tag === 'finalized' || tag === 'safe') {
        if (lacksTag) throw new TapeAPIError('RPC_ERROR', 'unsupported block tag')
        return { number: '0x' + finalized.toString(16), hash, timestamp: '0x' + timestamp.toString(16) }
      }
      return { number: tag, hash, timestamp: '0x' + timestamp.toString(16) }
    },
    async ethCall() { throw new Error('not used') },
  }
}

const readerWith = (nodes, { quorum = 2, ...rest } = {}) =>
  createChainReader({ name: 'test', rpc: { quorum, ethCall: async () => '0x' }, singles: nodes, ...rest })

test('blockTag renders a block number as a hex block parameter', () => {
  assert.equal(blockTag(0), '0x0')
  assert.equal(blockTag(123015808), '0x7551280')
  assert.equal(blockTag('255'), '0xff')
})

test('pinBlock defaults to finalized and takes the minimum across nodes', async () => {
  const r = readerWith([fakeNode({ finalized: 90 }), fakeNode({ finalized: 88 })])
  const pinned = await r.pinBlock()
  assert.equal(pinned.blockNumber, 88)
  assert.equal(pinned.blockHash, H(1))
  assert.equal(pinned.tag, blockTag(88))
  assert.equal(pinned.timestamp, 1700000000)
})

test('pinBlock degrades to a lagged head only when the tag was not asked for explicitly', async () => {
  const nodes = () => [fakeNode({ head: 100, lacksTag: true }), fakeNode({ head: 102, lacksTag: true })]
  const r = readerWith(nodes(), { lag: 15 })
  assert.equal((await r.pinBlock()).blockNumber, 85) // min(100, 102) - 15
  // 明确要求 'finalized' 的调用方不该悄悄拿到一个近期块 / an explicit tag must never silently become a recent block
  await assert.rejects(() => readerWith(nodes(), { lag: 15 }).pinBlock('finalized'), (e) => e.code === 'INTERNAL')
})

test("block: 'latest' means min(head) - lag", async () => {
  const r = readerWith([fakeNode({ head: 100 }), fakeNode({ head: 104 })], { lag: 15 })
  assert.equal((await r.pinBlock('latest')).blockNumber, 85)
})

test('an explicit block number or hex string is used as given', async () => {
  const r = readerWith([fakeNode(), fakeNode()])
  assert.equal((await r.pinBlock(42)).blockNumber, 42)
  assert.equal((await r.pinBlock('0x2a')).blockNumber, 42)
  assert.equal((await r.pinBlock('42')).blockNumber, 42)
})

test('an unusable block parameter is the caller\'s mistake, not the chain\'s', async () => {
  const r = readerWith([fakeNode(), fakeNode()])
  for (const b of ['pending', -1, 1.5, {}, true]) {
    await assert.rejects(() => r.pinBlock(b), (e) => e.code === 'BAD_REQUEST', `block: ${JSON.stringify(b)}`)
  }
})

test('pinBlock refuses a block whose hash the nodes do not agree on', async () => {
  const r = readerWith([fakeNode({ hash: H(1) }), fakeNode({ hash: H(2) })])
  await assert.rejects(() => r.pinBlock(42), (e) => e.code === 'INTERNAL' && /disagree on the hash/.test(e.message))
})

test('pinBlock never takes a majority: 2 of 3 nodes agreeing on a hash is still refused', async () => {
  const r = createChainReader({ rpc: { quorum: 2 }, singles: [fakeNode({ hash: H(1) }), fakeNode({ hash: H(1) }), fakeNode({ hash: H(2) })] })
  await assert.rejects(() => r.pinBlock(42), (e) => e.code === 'INTERNAL' && /2 different hashes/.test(e.message))
})

test('errors name the chain, so a cross-chain caller can tell which one failed', async () => {
  const r = createChainReader({ name: 'ethereum', rpc: { quorum: 2 }, singles: [fakeNode({ down: true }), fakeNode({ down: true })] })
  await assert.rejects(() => r.pinBlock('latest'), (e) => /^ethereum: /.test(e.message))
})

test('too few answering nodes is INTERNAL, never a silently degraded answer', async () => {
  const r = readerWith([fakeNode(), fakeNode({ down: true })])
  await assert.rejects(() => r.pinBlock(), (e) => e.code === 'INTERNAL' && /1\/2 nodes/.test(e.message))
})

test('quorum comes from the rpc client, so allowSingleNode reaches the pinning path too', async () => {
  // createRpc({ urls: [one], quorum: 2, allowSingleNode: true }) settles on quorum 1; the reader must follow.
  const r = createChainReader({ name: 'dev', rpc: { quorum: 1 }, singles: [fakeNode({ finalized: 90 })] })
  assert.equal(r.quorum, 1)
  assert.equal((await r.pinBlock()).blockNumber, 90)
})

test('readAt evaluates at the blockHash and reports blockRef', async () => {
  const r = readerWith([fakeNode(), fakeNode()])
  const pinned = await r.pinBlock(42)
  const seen = []
  const out = await r.readAt(pinned, async (blk) => { seen.push(blk); return 'ok' })
  assert.deepEqual(out, { value: 'ok', blockRef: 'hash' })
  assert.deepEqual(seen, [{ blockHash: H(1), requireCanonical: true }])
})

test('readAt falls back to the block number when the node rejects the EIP-1898 object', async () => {
  const r = readerWith([fakeNode(), fakeNode()])
  const pinned = await r.pinBlock(42)
  const seen = []
  const out = await r.readAt(pinned, async (blk) => {
    seen.push(blk)
    if (typeof blk === 'object') throw new TapeAPIError('RPC_ERROR', 'unsupported block parameter')
    return 'ok'
  })
  assert.deepEqual(out, { value: 'ok', blockRef: 'number' })
  assert.deepEqual(seen, [{ blockHash: H(1), requireCanonical: true }, blockTag(42)])
})

test('readAt never retries a contract revert as if the block parameter were at fault', async () => {
  const r = readerWith([fakeNode(), fakeNode()])
  const pinned = await r.pinBlock(42)
  let calls = 0
  const revert = new TapeAPIError('RPC_ERROR', 'execution reverted: OLD')
  await assert.rejects(() => r.readAt(pinned, async () => { calls++; throw revert }), (e) => e === revert)
  assert.equal(calls, 1)
  // rpcCode 3 是 eth_call 的 revert 约定，消息里可能没有 "revert" 字样 / rpcCode 3 is the revert convention
  assert.equal(rejectsBlockObject(Object.assign(new TapeAPIError('RPC_ERROR', 'OLD'), { rpcCode: 3 })), false)
  assert.equal(rejectsBlockObject(new TapeAPIError('RPC_UNAVAILABLE', 'no nodes')), false)
})

test('blockArg keeps follow-up reads on the same block as the first read', async () => {
  const r = readerWith([fakeNode(), fakeNode()])
  const pinned = await r.pinBlock(42)
  assert.deepEqual(r.blockArg(pinned, 'hash'), { blockHash: H(1), requireCanonical: true })
  assert.equal(r.blockArg(pinned, 'number'), blockTag(42))
})

test('blockPinnedOf is the block triple the BSC-local examples return', () => {
  assert.deepEqual(blockPinnedOf({ blockNumber: 7, blockHash: H(3), tag: '0x7', timestamp: 1 }, 'hash'),
    { blockNumber: 7, blockHash: H(3), blockRef: 'hash' })
})

test('createChainReaders reads chains.json and lets RPC_<chainId> override the urls', () => {
  const cfg = { 1: { name: 'ethereum', rpcUrls: ['https://a.example'], quorum: 2, lag: 2, symbol: 'ETH' } }
  const chains = createChainReaders(cfg, { env: { RPC_1: 'https://x.example, https://y.example' }, allowSingleNode: true })
  const eth = chainReaderOf(chains, 1)
  assert.deepEqual(eth.urls, ['https://x.example', 'https://y.example'])
  assert.equal(eth.name, 'ethereum')
  assert.equal(eth.symbol, 'ETH')
  assert.equal(eth.lag, 2)
  assert.throws(() => chainReaderOf(chains, 8453), (e) => e.code === 'BAD_REQUEST' && /not served/.test(e.message))
  assert.throws(() => chainReaderOf(chains, '1'), (e) => e.code === 'BAD_REQUEST')
})

test('createChainReaders: an explicit lag overrides every chain (the README QUORUM_FAILED demo)', () => {
  const cfg = { 1: { name: 'ethereum', rpcUrls: ['https://a.example'], lag: 2 }, 56: { name: 'bsc', rpcUrls: ['https://b.example'], lag: 15 } }
  const chains = createChainReaders(cfg, { env: {}, lag: 30, allowSingleNode: true })
  assert.deepEqual([...chains.values()].map((c) => c.lag), [30, 30])
})
