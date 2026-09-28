// Quorums count OPERATORS, not URLs. TapeKit's audit (kernel/src/config.js, 2026-09-19) found every bsc-dataseed host
// (bnbchain.org, defibit.io, ninicoin.io, binance.org) is NodeReal's, so the old default "2 of 3 dataseeds" was one
// operator agreeing with itself. / 法定数按运营方计，不按 URL。旧默认"三个 dataseed 取二"是 NodeReal 一家与自己一致。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRpc } from '../src/rpc.js'
import { RPC_DEFAULTS, rpcUrlsFor, operatorOf, createTapeAPI } from '../src/index.js'

const DATASEEDS = ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-dataseed1.ninicoin.io']
const NODEREAL = 'https://bsc-dataseed.bnbchain.org', NODEREAL2 = 'https://bsc-dataseed1.defibit.io'
const ALCHEMY = 'https://bsc-mainnet.public.blastapi.io', CLUB48 = 'https://rpc-bsc.48.club'
const TO = '0x' + '11'.repeat(20)

// url -> result | 'timeout' | { error } / 每个节点的应答
const canned = (answers) => async (url, init) => {
  const r = JSON.parse(init.body)
  const a = answers[url]
  if (a === 'timeout' || a === undefined) throw new Error('timeout')
  if (a && typeof a === 'object') return new Response(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: { code: a.error, message: 'no' } }))
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: a }))
}

test('operatorOf: every dataseed host is NodeReal; Blast API is Alchemy; thirdweb is dRPC; an unknown host is its own operator', () => {
  for (const u of [...DATASEEDS, 'https://bsc-dataseed2.bnbchain.org', 'https://bsc-dataseed4.defibit.io', 'https://bsc-dataseed3.ninicoin.io',
    'https://bsc-dataseed.binance.org', 'https://bsc-dataseed1.binance.org/', 'https://bsc-mainnet.nodereal.io/v1/KEY']) assert.equal(operatorOf(u), 'nodereal', u)
  assert.equal(operatorOf(ALCHEMY), 'alchemy')
  assert.equal(operatorOf('https://bnb-mainnet.g.alchemy.com/v2/KEY'), 'alchemy')
  assert.equal(operatorOf(CLUB48), '48club')
  assert.equal(operatorOf('https://bsc-rpc.publicnode.com'), 'allnodes')
  assert.equal(operatorOf('https://bsc.drpc.org'), 'drpc')
  assert.equal(operatorOf('https://56.rpc.thirdweb.com'), 'drpc', 'thirdweb forwards dRPC on BSC (TapeKit audit)')
  assert.equal(operatorOf('https://rpc.ankr.com/bsc'), 'ankr')
  assert.equal(operatorOf('https://binance.llamarpc.com'), 'llamarpc')
  assert.equal(operatorOf('https://1rpc.io/bnb'), '1rpc')
  assert.equal(operatorOf('https://RPC.Example.ORG./x'), 'rpc.example.org', 'hostname, lowercased')
  assert.equal(operatorOf('https://notdefibit.io'), 'notdefibit.io', 'a suffix matches at a label boundary only')
  assert.equal(operatorOf('http://rpc1'), 'rpc1')
  assert.equal(operatorOf('not a url'), 'not a url')
})

test('RPC_DEFAULTS[56] is three distinct operators, and rpcUrlsFor hands out a fresh copy', () => {
  const nodes = RPC_DEFAULTS[56]
  assert.deepEqual(nodes.map((n) => n.url), [NODEREAL, ALCHEMY, CLUB48])
  for (const n of nodes) assert.equal(operatorOf(n.url), n.operator, `${n.url}: the table and operatorOf agree`)
  assert.equal(new Set(nodes.map((n) => n.operator)).size, 3)
  assert.ok(Object.isFrozen(RPC_DEFAULTS) && Object.isFrozen(nodes) && Object.isFrozen(nodes[0]))
  const a = rpcUrlsFor(56); a.push('x')
  assert.deepEqual(rpcUrlsFor(56), [NODEREAL, ALCHEMY, CLUB48])
  assert.deepEqual(rpcUrlsFor('56'), rpcUrlsFor(56))
  assert.deepEqual(rpcUrlsFor(1), [])
  const rpc = createRpc({ urls: rpcUrlsFor(56), quorum: 2, fetch: canned({}) })
  assert.deepEqual([rpc.quorum, rpc.degraded, rpc.operators], [2, false, ['nodereal', 'alchemy', '48club']])
})

test('FIXED RPC-OP-1: three dataseed URLs with quorum 2 are refused: one operator', () => {
  assert.throws(() => createRpc({ urls: DATASEEDS, quorum: 2, fetch: canned({}) }), (e) => e.code === 'INVALID_ARGUMENT' && /at least 2 independent operators, got 1 \(nodereal\)/.test(e.message))
  // ...through createTapeAPI too / 经 createTapeAPI 同样拒绝
  assert.throws(() => createTapeAPI({ rpcUrls: DATASEEDS, quorum: 2, fetch: canned({}) }), (e) => e.code === 'INVALID_ARGUMENT')
  // Two dataseeds and Alchemy: two operators, quorum 2 is allowed; quorum 3 is not / 两家：quorum 2 可以，3 不行
  assert.equal(createRpc({ urls: [NODEREAL, NODEREAL2, ALCHEMY], quorum: 2, fetch: canned({}), quiet: true }).quorum, 2)
  assert.throws(() => createRpc({ urls: [NODEREAL, NODEREAL2, ALCHEMY], quorum: 3, fetch: canned({}) }), /at least 3 independent operators, got 2/)
  // allowSingleNode (a dev setup) clamps to the operators there are, and says so / 开发用：下调到实际运营方数
  const dev = createRpc({ urls: DATASEEDS, quorum: 2, fetch: canned({}), allowSingleNode: true })
  assert.deepEqual([dev.quorum, dev.degraded, dev.urls.length], [1, true, 3])
})

test('FIXED RPC-OP-2: NodeReal and Alchemy agreeing is a quorum', async () => {
  const rpc = createRpc({ urls: [NODEREAL, ALCHEMY], quorum: 2, disagreeRetryMs: 0, quiet: true, fetch: canned({ [NODEREAL]: '0x01', [ALCHEMY]: '0x01' }) })
  assert.equal(await rpc.ethCall(TO, '0x'), '0x01')
  const heads = createRpc({ urls: [NODEREAL, ALCHEMY], quorum: 2, quiet: true, fetch: canned({ [NODEREAL]: '0x10', [ALCHEMY]: '0x11' }) })
  assert.equal(await heads.blockNumber(), 16)
})

test('FIXED RPC-OP-3: two NodeReal URLs agreeing count once: Alchemy disagreeing is RPC_DISAGREE, Alchemy silent is RPC_UNAVAILABLE', async () => {
  const urls = [NODEREAL, NODEREAL2, ALCHEMY]
  const split = createRpc({ urls, quorum: 2, disagreeRetryMs: 0, fetch: canned({ [NODEREAL]: '0x01', [NODEREAL2]: '0x01', [ALCHEMY]: '0x02' }) })
  await assert.rejects(split.ethCall(TO, '0x'), (e) => e.code === 'RPC_DISAGREE')
  // The case that counting URLs would get wrong: two answers, one operator / 按 URL 计会判错的情形：两个回答、一家运营方
  const silent = createRpc({ urls, quorum: 2, disagreeRetryMs: 0, fetch: canned({ [NODEREAL]: '0x01', [NODEREAL2]: '0x01', [ALCHEMY]: 'timeout' }) })
  await assert.rejects(silent.ethCall(TO, '0x'), (e) => e.code === 'RPC_UNAVAILABLE' && /only 1\/2 operators answered/.test(e.message))
  const refusing = createRpc({ urls, quorum: 2, disagreeRetryMs: 0, fetch: canned({ [NODEREAL]: '0x01', [NODEREAL2]: '0x01', [ALCHEMY]: { error: -32005 } }) })
  await assert.rejects(refusing.ethCall(TO, '0x'), (e) => e.code === 'RPC_UNAVAILABLE' && e.refusals?.[0]?.code === -32005)
  // eth_blockNumber counts operators as well / eth_blockNumber 同样按运营方计
  const heads = createRpc({ urls, quorum: 2, fetch: canned({ [NODEREAL]: '0x10', [NODEREAL2]: '0x10', [ALCHEMY]: 'timeout' }) })
  await assert.rejects(heads.blockNumber(), (e) => e.code === 'RPC_UNAVAILABLE' && /only 1\/2 operators answered/.test(e.message))
  // ...and a NodeReal URL down is no loss while another operator answers / 某个 NodeReal URL 宕机无妨
  const spare = createRpc({ urls, quorum: 2, disagreeRetryMs: 0, fetch: canned({ [NODEREAL]: 'timeout', [NODEREAL2]: '0x01', [ALCHEMY]: '0x01' }) })
  assert.equal(await spare.ethCall(TO, '0x'), '0x01')
})

test('the no-spare warning counts operators: 2 operators over 3 URLs with quorum 2 has no spare', () => {
  const warned = []
  // A set no other test builds: the warning is said once per node set per process / 其它测试没建过的集合：每个集合每进程只说一次
  createRpc({ urls: ['https://bsc-dataseed3.bnbchain.org', 'https://bsc-dataseed3.defibit.io', 'https://bnb-mainnet.g.alchemy.com/v2/k'], quorum: 2, fetch: canned({}), warn: (m) => warned.push(m) })
  assert.equal(warned.length, 1)
  assert.match(warned[0], /quorum 2 of 2 operators leaves no spare/)
  createRpc({ urls: [...rpcUrlsFor(56), 'https://bsc-dataseed4.bnbchain.org'], quorum: 2, fetch: canned({}), warn: (m) => warned.push(m) })
  assert.equal(warned.length, 1, 'the default set has a spare operator')
})
