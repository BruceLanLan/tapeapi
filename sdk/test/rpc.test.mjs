import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRpc } from '../src/rpc.js'
import { createFakeChain } from './helpers/fake-chain.mjs'

const URLS = ['http://rpc1', 'http://rpc2', 'http://rpc3']

// Canned per-node answers: node url -> result string | { error: code } | 'timeout'. `calls` counts rounds.
// 按节点给定的应答：url -> 结果字符串 | { error: code } | 'timeout'
function canned(answers) {
  const f = async (url, init) => {
    const r = JSON.parse(init.body)
    let a = answers[url]
    if (typeof a === 'function') a = a()
    if (a === 'timeout') throw new Error('timeout')
    if (a && typeof a === 'object') return new Response(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: { code: a.error, message: 'no' } }))
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: a }))
  }
  return f
}
const TO = '0x' + '11'.repeat(20)

test('TAP-20 §3.2: a 2-vs-1 eth_call split is RPC_DISAGREE, never resolved by majority', async () => {
  const rpc = createRpc({ urls: URLS, quorum: 2, disagreeRetryMs: 0, fetch: canned({ 'http://rpc1': '0x01', 'http://rpc2': '0x01', 'http://rpc3': '0x02' }) })
  await assert.rejects(rpc.ethCall(TO, '0x'), (e) => e.code === 'RPC_DISAGREE')
  // the same with quorum 1: more nodes can only add refusals, never outvote / quorum 1 也一样：多出的节点只会增加拒绝
  const q1 = createRpc({ urls: URLS, quorum: 1, disagreeRetryMs: 0, fetch: canned({ 'http://rpc1': '0x01', 'http://rpc2': '0x01', 'http://rpc3': '0x02' }) })
  await assert.rejects(q1.ethCall(TO, '0x'), (e) => e.code === 'RPC_DISAGREE')
})
test('a revert on one node and a value on others is a disagreement, not a value', async () => {
  const rpc = createRpc({ urls: URLS, quorum: 2, disagreeRetryMs: 0, fetch: canned({ 'http://rpc1': '0x01', 'http://rpc2': '0x01', 'http://rpc3': { error: 3 } }) })
  await assert.rejects(rpc.ethCall(TO, '0x'), (e) => e.code === 'RPC_DISAGREE')
})
test('a node that fails in transport did not answer: two identical answers and one timeout is accepted', async () => {
  const rpc = createRpc({ urls: URLS, quorum: 2, disagreeRetryMs: 0, fetch: canned({ 'http://rpc1': '0x01', 'http://rpc2': '0x01', 'http://rpc3': 'timeout' }) })
  assert.equal(await rpc.ethCall(TO, '0x'), '0x01')
})
test('one re-ask absorbs a block-boundary race, and the re-ask must itself be unanimous', async () => {
  let n = 0
  const flaky = () => (n++ === 0 ? '0x02' : '0x01')   // behind on the first round only / 只在第一轮落后
  const rpc = createRpc({ urls: URLS, quorum: 2, disagreeRetryMs: 0, fetch: canned({ 'http://rpc1': '0x01', 'http://rpc2': '0x01', 'http://rpc3': flaky }) })
  assert.equal(await rpc.ethCall(TO, '0x'), '0x01')
  const stuck = createRpc({ urls: URLS, quorum: 2, disagreeRetryMs: 0, fetch: canned({ 'http://rpc1': '0x01', 'http://rpc2': '0x01', 'http://rpc3': '0x02' }) })
  await assert.rejects(stuck.call('eth_chainId'), (e) => e.code === 'RPC_DISAGREE')
  const noRetry = createRpc({ urls: URLS, quorum: 2, disagreeRetryMs: -1, fetch: canned({ 'http://rpc1': '0x01', 'http://rpc2': '0x01', 'http://rpc3': (() => { let k = 0; return () => (k++ === 0 ? '0x02' : '0x01') })() }) })
  await assert.rejects(noRetry.ethCall(TO, '0x'), (e) => e.code === 'RPC_DISAGREE', 'disagreeRetryMs: -1 turns the re-ask off')
})
test('blockNumber takes the lowest head when nodes are a few blocks apart, and refuses a wide spread', async () => {
  const chain = createFakeChain()
  const rpc = createRpc({ urls: URLS, quorum: 2, fetch: chain.fetch })
  assert.equal(await rpc.blockNumber(), 62_000_000)
  chain.setFault('http://rpc3', 'disagree')   // rpc3 reports 7 blocks ahead / 领先 7 块
  assert.equal(await rpc.blockNumber(), 62_000_000, 'the head every answering node has reached')
  const wide = createRpc({ urls: URLS, quorum: 2, fetch: canned({ 'http://rpc1': '0x100', 'http://rpc2': '0x100', 'http://rpc3': '0x1000' }) })
  await assert.rejects(wide.blockNumber(), (e) => e.code === 'RPC_DISAGREE' && /more than 64 blocks/.test(e.message))
})
test('RPC_DISAGREE when two nodes answer differently', async () => {
  const chain = createFakeChain()
  const rpc = createRpc({ urls: URLS.slice(0, 2), quorum: 2, disagreeRetryMs: 0, fetch: chain.fetch })
  chain.setFault('http://rpc2', 'disagree')
  await assert.rejects(rpc.call('eth_blockNumber'), (e) => e.code === 'RPC_DISAGREE')
})
test('RPC_UNAVAILABLE on timeouts / http errors when too few answer', async () => {
  const chain = createFakeChain()
  chain.setFault('http://rpc1', 'timeout'); chain.setFault('http://rpc2', 'http500')
  const rpc = createRpc({ urls: URLS, quorum: 2, timeoutMs: 50, fetch: chain.fetch })
  const t0 = Date.now()
  await assert.rejects(rpc.blockNumber(), (e) => e.code === 'RPC_UNAVAILABLE' && /1\/2 nodes answered/.test(e.message))
  assert.ok(Date.now() - t0 < 2000)
})
test('one timeout still reaches quorum with the remaining two', async () => {
  const chain = createFakeChain()
  chain.setFault('http://rpc1', 'timeout')
  const rpc = createRpc({ urls: URLS, quorum: 2, timeoutMs: 50, fetch: chain.fetch })
  assert.equal(await rpc.blockNumber(), 62_000_000)
})
test('agreed JSON-RPC error surfaces as RPC_ERROR; errors bucket by code, not message text (M-12)', async () => {
  const chain = createFakeChain()
  chain.setFault('http://rpc1', 'rpcerror'); chain.setFault('http://rpc2', 'rpcerror')
  const rpc = createRpc({ urls: URLS.slice(0, 2), quorum: 2, fetch: chain.fetch })
  await assert.rejects(rpc.call('eth_blockNumber'), (e) => e.code === 'RPC_ERROR' && e.rpcCode === -32000)
  // same code, different revert text from each node -> still one agreed RPC_ERROR / 同 code 不同文本仍视为一致
  let i = 0
  const f = async (url, init) => { const r = JSON.parse(init.body); return new Response(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: { code: 3, message: `execution reverted: node ${i++}` } })) }
  await assert.rejects(createRpc({ urls: ['http://a', 'http://b'], quorum: 2, fetch: f }).call('eth_call', []), (e) => e.code === 'RPC_ERROR' && e.rpcCode === 3)
})
test('M-11: fewer urls than quorum throws unless allowSingleNode: true; duplicates do not count twice', async () => {
  const chain = createFakeChain()
  assert.throws(() => createRpc({ urls: URLS.slice(0, 2), quorum: 5, fetch: chain.fetch }), (e) => e.code === 'RPC_UNAVAILABLE' && /allowSingleNode/.test(e.message))
  assert.throws(() => createRpc({ urls: ['http://rpc9'], quorum: 2, fetch: chain.fetch }), (e) => e.code === 'RPC_UNAVAILABLE')
  assert.throws(() => createRpc({ urls: ['http://rpc1', 'http://rpc1'], quorum: 2, fetch: chain.fetch }), (e) => e.code === 'RPC_UNAVAILABLE')
  const single = createRpc({ urls: ['http://rpc9'], quorum: 2, fetch: chain.fetch, allowSingleNode: true })
  assert.equal(single.quorum, 1); assert.equal(single.degraded, true)
  assert.equal(await single.blockNumber(), 62_000_000)
  const strict = createRpc({ urls: URLS, quorum: 2, fetch: chain.fetch })
  assert.equal(strict.degraded, false)
})
test('M-13: failure messages name nodes by index/hostname, never by full URL', async () => {
  const chain = createFakeChain()
  const keyed = 'http://rpc1/v1/SECRET-API-KEY-123'
  chain.setFault(keyed, 'timeout'); chain.setFault('http://rpc2', 'http500')
  const rpc = createRpc({ urls: [keyed, 'http://rpc2', 'http://rpc3'], quorum: 2, timeoutMs: 50, fetch: chain.fetch })
  await assert.rejects(rpc.blockNumber(), (e) => e.code === 'RPC_UNAVAILABLE' && !/SECRET/.test(e.message) && /node#0\(rpc1\)/.test(e.message))
})
test('L-24: oversized JSON-RPC bodies are rejected as node failures', async () => {
  const big = async () => new Response('{"jsonrpc":"2.0","id":1,"result":"' + 'a'.repeat(5000) + '"}')
  const rpc = createRpc({ urls: ['http://a', 'http://b'], quorum: 2, fetch: big, bodyLimit: 1000 })
  await assert.rejects(rpc.call('eth_blockNumber'), (e) => e.code === 'RPC_UNAVAILABLE' && /exceeds limit/.test(e.message))
})
test('ethCall sends {to,data} and block tag', async () => {
  const seen = []
  const f = async (url, init) => { const r = JSON.parse(init.body); seen.push(r); return new Response(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: '0x01' })) }
  const rpc = createRpc({ urls: ['a', 'b'], quorum: 2, fetch: f })
  assert.equal(await rpc.ethCall('0x' + '11'.repeat(20), '0x70a08231', '0x10'), '0x01')
  assert.deepEqual(seen[0].params, [{ to: '0x' + '11'.repeat(20), data: '0x70a08231' }, '0x10'])
  assert.equal(seen[0].method, 'eth_call')
})

test('a node answering -32005 (rate limited) has failed, it has not disagreed', async () => {
  const f = async (url, init) => {
    const r = JSON.parse(init.body)
    if (url === 'http://rpc3') return new Response(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: { code: -32005, message: 'limit exceeded' } }))
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: '0x01' }))
  }
  assert.equal(await createRpc({ urls: URLS, quorum: 2, disagreeRetryMs: 0, fetch: f }).ethCall('0x' + '11'.repeat(20), '0x'), '0x01')
  await assert.rejects(createRpc({ urls: URLS, quorum: 3, disagreeRetryMs: 0, fetch: f }).ethCall('0x' + '11'.repeat(20), '0x'), (e) => e.code === 'RPC_UNAVAILABLE' && /-32005/.test(e.message))
})

test('a node describing itself (rate limit, missing method, range refusal) has not answered; a revert has', async () => {
  const err = (code, message) => async (url, init) => {
    const r = JSON.parse(init.body)
    if (url === 'http://rpc3') return new Response(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: { code, message } }))
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: '0x01' }))
  }
  const to = '0x' + '11'.repeat(20)
  // the node is unavailable to us: the other two agree and the call succeeds / 该节点对我们不可用：另两个一致即可
  for (const [code, message] of [[-32005, 'limit exceeded'], [-32601, 'the method eth_getLogs does not exist'], [-32000, 'query returned more than 10000 results'], [-32000, 'eth_getLogs is limited to 0 - 50 blocks range']]) {
    assert.equal(await createRpc({ urls: URLS, quorum: 2, disagreeRetryMs: 0, fetch: err(code, message) }).ethCall(to, '0x'), '0x01', message)
  }
  // a revert is an answer about the chain, so one node reverting while two return data is a disagreement
  // 回滚是关于链的回答：一个节点回滚、两个返回数据，属于不一致
  await assert.rejects(createRpc({ urls: URLS, quorum: 2, disagreeRetryMs: 0, fetch: err(3, 'execution reverted: limit') }).ethCall(to, '0x'), (e) => e.code === 'RPC_DISAGREE')
  // some clients report a revert as -32000: the word "revert" keeps it an answer, whatever else it says
  // 有些客户端把回滚报为 -32000：只要消息里有 revert，它就仍是回答，不管还写了什么
  await assert.rejects(createRpc({ urls: URLS, quorum: 2, disagreeRetryMs: 0, fetch: err(-32000, 'execution reverted: rate limit reached') }).ethCall(to, '0x'), (e) => e.code === 'RPC_DISAGREE')
})
