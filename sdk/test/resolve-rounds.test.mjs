// resolve() round trips (rc review O-1 / P2-1): how many HTTP requests and serial rounds a resolve costs, the JSON-RPC
// batch and its fallback, and the cache of immutable facts -- with every check of TAPI-20 §3.6 still made on every resolve.
// resolve() 的往返次数（RC 审查 O-1 / P2-1）：一次解析的 HTTP 请求数与串行轮数、JSON-RPC 批量及其退回、不可变事实的缓存——
// 每次解析仍做 TAPI-20 §3.6 的每一项检查。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTapeAPI, MANIFEST_KEY, MAINNET, CHAINS, security } from '../src/index.js'
import { functionBySelector } from '../src/abi.js'
import * as sig from '../src/sig.js'
import { createFakeChain, ADDR } from './helpers/fake-chain.mjs'

const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32)
const holder = sig.privateKeyToAddress(HOLDER_KEY), signer = sig.privateKeyToAddress(SIGNER_KEY)
const RPC = ['http://rpc1', 'http://rpc2', 'http://rpc3']   // three operators, like the BSC defaults / 三家运营方，与 BSC 默认相同
const NAME = '4246.7.tape'                                   // processor 7 is ADDR.circuits on the fake chain / 假链上 7 号处理器
const nowS = () => Math.floor(Date.now() / 1000)

function manifestFor(chainId, container, { tokenId = '4246' } = {}) {
  const expires = nowS() + 30 * 86400
  return {
    tapeapi: '0.1', name: 'Rounds', circuits: ADDR.circuits, tokenId, container, signer,
    delegation: { expires, sig: sig.signDigest(sig.delegationDigest(chainId, ADDR.hub, { container, signer, expires }), HOLDER_KEY) },
    endpoints: { live: ['https://api.example.com/tapeapi/v1'], async: false },
    methods: [{ name: 'ping', priceBEM: '0', params: {}, returns: {} }],
  }
}
function service(chain = createFakeChain(), { chainId = 56, container = ADDR.container } = {}) {
  chain.setOwner(4246, holder); chain.setAccount(4246, container)
  chain.writeFile(container, MANIFEST_KEY, JSON.stringify(manifestFor(chainId, container)))
  return chain
}

// Every HTTP request, with the functions it asked for; a round is a moment the in-flight count leaves 0. Each answer
// is held 5 ms so that the requests of one round overlap, as they do on a network.
// 记录每个 HTTP 请求及其调用的函数；在途数从 0 变为非 0 即一轮。每个回答延迟 5 毫秒，使同一轮的请求像在网络上那样重叠。
function meter(fetchInner) {
  const m = { http: [], rounds: 0, inflight: 0 }
  m.reset = () => { m.http = []; m.rounds = 0 }
  m.fetch = async (url, init) => {
    if (m.inflight === 0) m.rounds++
    m.inflight++
    const body = JSON.parse(init.body)
    const list = Array.isArray(body) ? body : [body]
    m.http.push({ url, batch: Array.isArray(body), fns: list.map((r) => (r.method === 'eth_call' ? functionBySelector(r.params[0].data) : r.method)) })
    try { await new Promise((r) => setTimeout(r, 5)); return await fetchInner(url, init) } finally { m.inflight-- }
  }
  m.calls = () => m.http.reduce((n, h) => n + h.fns.length, 0)
  m.of = (url) => m.http.filter((h) => h.url === url).map((h) => h.fns)
  return m
}
const client = (fetch, o = {}) => createTapeAPI({ rpcUrls: RPC, quorum: 2, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, factory: ADDR.factory, fetch, ...o })

test('resolve(name): 4 rounds and 12 HTTP requests cold (was 7 and 21), 2 rounds and 6 requests again on the same client (was 6 and 18)', async () => {
  const chain = service()
  const m = meter(chain.fetch)
  const api = client(m.fetch)
  const svc = await api.resolve(NAME)
  assert.deepEqual(svc.verified, { delegation: true, holder })
  assert.equal(m.rounds, 4)
  assert.equal(m.http.length, 12)
  assert.equal(m.calls(), 18, 'six reads per node: accountOf is read once, not twice')
  // Per node: cpuAt; then accountOf with steps 3 and 4 read ahead; fileInfo; read (still after fileInfo, TAPI-20 §3.6 step 2)
  // 每个节点：cpuAt；accountOf 与提前读的第 3、4 步；fileInfo；read（仍在 fileInfo 之后）
  for (const u of RPC) assert.deepEqual(m.of(u), [['cpuAt'], ['accountOf', 'isCPU', 'ownerOf'], ['fileInfo'], ['read']], u)
  m.reset()
  const again = await api.resolve(NAME)
  assert.deepEqual(again.verified, svc.verified)
  assert.equal(m.rounds, 2)
  assert.equal(m.http.length, 6)
  // cpuAt and accountOf are cached facts, isCPU true was already remembered; ownerOf and the file are read every time
  // cpuAt 与 accountOf 是缓存的事实，isCPU 为真本来就记住；ownerOf 与文件每次都读
  for (const u of RPC) assert.deepEqual(m.of(u), [['ownerOf', 'fileInfo'], ['read']], u)
})

// Security 1.1 budget. The default client above is unchanged: unpinned, and no sentinel for contracts chains.js does not
// list. A client on the chain's own contracts (the default configuration) also reads the two ERC-1967 slots, sent alone
// in the same turn as read() (never inside an eth_call batch, FIXED SECR-5): the same rounds, 2 more requests and calls
// per node, cached like facts. A pinning client (opt-in) pays one more round
// and one more request per node for the pin, two when the nodes' tagged blocks differ.
// 安全加固 1.1 的预算。上面的默认客户端不变：不钉块；chains.js 不认识的合约不启用哨兵。用本链自己合约的客户端（默认配置）另读两个
// ERC-1967 槽，与 read() 同一轮单独发出（绝不进 eth_call 批量，FIXED SECR-5）：轮数不变，每节点多 2 个请求与调用，像事实一样缓存。钉块的客户端（需显式开启）为钉块多付一轮、每节点
// 多一个请求；各节点标签所指的区块不同时多付两轮。
function mainnetService(chain = createFakeChain()) {
  const c = CHAINS[56]
  const container = security.erc6551Account({ registry: c.erc6551Registry, implementation: c.accountImplementation, chainId: 56, tokenContract: ADDR.circuits, tokenId: 4246 })
  const expires = nowS() + 30 * 86400
  const m = {
    tapeapi: '0.1', name: 'Rounds', circuits: ADDR.circuits, tokenId: '4246', container, signer,
    delegation: { expires, sig: sig.signDigest(sig.delegationDigest(56, MAINNET.hub, { container, signer, expires }), HOLDER_KEY) },
    endpoints: { live: ['https://api.example.com/tapeapi/v1'], async: false },
    methods: [{ name: 'ping', priceBEM: '0', params: {}, returns: {} }],
  }
  chain.setOwner(4246, holder); chain.setAccount(4246, container)
  chain.writeFile(container, MANIFEST_KEY, JSON.stringify(m))
  return chain
}

test('FIXED SEC11-2 / FIXED SECR-5 budget: on the chain\'s own contracts the sentinel costs no round: 4 rounds, 18 HTTP requests (the two slots alone, never in an eth_call batch), 24 calls cold; the slots are cached like facts', async () => {
  const chain = mainnetService()
  const m = meter(chain.fetch)
  const api = createTapeAPI({ rpcUrls: RPC, quorum: 2, fetch: m.fetch, onWarning: (w) => assert.fail(w.message) })
  const svc = await api.resolve(NAME)
  assert.equal(svc.sentinel.container, 'match')
  assert.deepEqual(svc.sentinel.implementations.map((x) => x.expected), [true, true])
  assert.equal(m.rounds, 4)
  assert.equal(m.http.length, 18)
  assert.equal(m.calls(), 24, 'six reads per node, and two ERC-1967 slots')
  // the eth_call batches are exactly those of the default client above (1.1.0); the slots go out alone in read()'s round
  // eth_call 批量与上面默认客户端（1.1.0）完全相同；实现槽在 read() 那一轮单独发出
  for (const u of RPC) {
    assert.deepEqual(m.of(u).slice(0, 3), [['cpuAt'], ['accountOf', 'isCPU', 'ownerOf'], ['fileInfo']], u)
    assert.deepEqual(m.of(u).slice(3).map((f) => f.join(',')).sort(), ['eth_getStorageAt', 'eth_getStorageAt', 'read'], u)
  }
  assert.ok(!m.http.some((h) => h.batch && h.fns.includes('eth_getStorageAt')), 'no batch holds a storage read')
  m.reset()
  await api.resolve(NAME)
  assert.equal(m.rounds, 2)
  assert.equal(m.http.length, 6)
  for (const u of RPC) assert.deepEqual(m.of(u), [['ownerOf', 'fileInfo'], ['read']], u)
})

test('FIXED SEC11-1 budget: a pinning client pays one round and one request per node for the pin (5 rounds, 15 requests), two when the tagged blocks differ (6 and 18)', async () => {
  const chain = service()
  const m = meter(chain.fetch)
  const svc = await client(m.fetch, { pin: true }).resolve(NAME)
  assert.equal(svc.pinned.tag, 'finalized')
  assert.equal(m.rounds, 5)
  assert.equal(m.http.length, 15)
  for (const u of RPC) assert.deepEqual(m.of(u), [['eth_getBlockByNumber'], ['cpuAt'], ['accountOf', 'isCPU', 'ownerOf'], ['fileInfo'], ['read']], u)
  // One node far behind (1rpc's finalized was latest − 5000 on BSC) does not matter while two operators agree.
  // 一个节点远远落后（1rpc 在 BSC 上的 finalized 曾是 latest − 5000）无关紧要，只要有两家运营方一致。
  chain.setTagLag('http://rpc3', 'finalized', 5000)
  m.reset(); await client(m.fetch, { pin: true }).resolve(NAME)
  assert.equal(m.rounds, 5)
  assert.equal(m.http.length, 15)
  // Three different answers: the second-highest is asked of every node, in a second round.
  // 三个不同的回答：向每个节点询问第二高的块号，多一轮。
  chain.setTagLag('http://rpc2', 'finalized', 3)
  m.reset(); const again = await client(m.fetch, { pin: true }).resolve(NAME)
  assert.equal(again.pinned.number, chain.state.block - 3)
  assert.equal(m.rounds, 6)
  assert.equal(m.http.length, 18)
  for (const u of RPC) assert.deepEqual(m.of(u).slice(0, 2), [['eth_getBlockByNumber'], ['eth_getBlockByNumber']], u)
})

test('resolve(container) and resolve({ circuits, tokenId }): steps 3-5 go out as one round', async () => {
  const chain = service()
  const m = meter(chain.fetch)
  await client(m.fetch).resolve(ADDR.container)
  assert.equal(m.rounds, 3)
  for (const u of RPC) assert.deepEqual(m.of(u), [['fileInfo'], ['read'], ['accountOf', 'isCPU', 'ownerOf']], u)
  m.reset()
  await client(m.fetch).resolve({ circuits: ADDR.circuits, tokenId: '4246' })
  assert.equal(m.rounds, 3)
  for (const u of RPC) assert.deepEqual(m.of(u), [['accountOf', 'isCPU', 'ownerOf'], ['fileInfo'], ['read']], u)
})

test('batch fallback: a node that answers a batch with one error object is asked call by call, once and for all; the others keep batching', async () => {
  const chain = service()
  chain.setFault('http://rpc2', 'nobatch')
  const m = meter(chain.fetch)
  const api = client(m.fetch)
  const svc = await api.resolve(NAME)
  assert.deepEqual(svc.verified, { delegation: true, holder })
  // rpc2: one refused batch, then the same three reads alone, in the same round / 一次被拒的批量，然后同一轮里逐个再问
  assert.deepEqual(m.of('http://rpc2'), [['cpuAt'], ['accountOf', 'isCPU', 'ownerOf'], ['accountOf'], ['isCPU'], ['ownerOf'], ['fileInfo'], ['read']])
  assert.deepEqual(m.of('http://rpc1'), [['cpuAt'], ['accountOf', 'isCPU', 'ownerOf'], ['fileInfo'], ['read']])
  // rpc2's fileInfo may even start while its read-ahead isCPU / ownerOf are still out / rpc2 的 fileInfo 甚至可能在其提前读取尚未返回时就发出
  assert.ok(m.rounds <= 4, 'the fallback costs no extra round')
  m.reset()
  await api.resolve(NAME)
  assert.ok(m.http.filter((h) => h.url === 'http://rpc2').every((h) => !h.batch), 'no second batch is sent to rpc2')
  assert.ok(m.http.some((h) => h.url === 'http://rpc1' && h.batch), 'rpc1 still batches')
})

test('batch fallback: an HTTP error on a batch is never read as answers (dRPC free plan: HTTP 500, code 31 per call); a timeout is not asked twice', async () => {
  // dRPC's free plan answers a batch of more than 3 with HTTP 500 and an error per call (measured 2026-09-29): read as
  // answers, those would disagree with the other nodes. / dRPC 免费档对超过 3 个调用的批量回 HTTP 500、每个调用一个错误。
  const chain = service()
  const drpc = async (url, init) => {
    const body = JSON.parse(init.body)
    if (url === 'http://rpc3' && Array.isArray(body)) {
      return new Response(JSON.stringify(body.map((r) => ({ jsonrpc: '2.0', id: r.id, error: { code: 31, message: 'Batch of more than 3 requests are not allowed on free plan' } }))), { status: 500, headers: { 'content-type': 'application/json' } })
    }
    return chain.fetch(url, init)
  }
  const m = meter(drpc)
  const svc = await client(m.fetch).resolve(NAME)
  assert.deepEqual(svc.verified, { delegation: true, holder })
  assert.deepEqual(m.of('http://rpc3').slice(1, 5), [['accountOf', 'isCPU', 'ownerOf'], ['accountOf'], ['isCPU'], ['ownerOf']])
  // A node that times out on a batch has not answered: each call fails as a single one would, with no second wait.
  // 批量超时的节点没有作答：每个调用都像单个请求那样失败，不再等第二次。
  const slow = service()
  slow.setFault('http://rpc1', 'timeout')
  const t = meter(slow.fetch)
  const svc2 = await client(t.fetch, { rpcTimeoutMs: 100 }).resolve(NAME)
  assert.deepEqual(svc2.verified, { delegation: true, holder })
  assert.deepEqual(t.of('http://rpc1'), [['cpuAt'], ['accountOf', 'isCPU', 'ownerOf'], ['fileInfo'], ['read']])
})

test('inside a batch the quorum rule is per call: one node disagreeing on one call is RPC_DISAGREE, never a majority', async () => {
  const chain = service()
  let batches = 0
  const lie = async (url, init) => {
    const body = JSON.parse(init.body)
    const res = await chain.fetch(url, init)
    if (url !== 'http://rpc2') return res
    if (Array.isArray(body)) batches++
    // rpc2 names another holder in ownerOf, in a batch and alone (the one re-ask) / rpc2 在 ownerOf 里给出另一个持有人，批量与单个（那一次重问）都如此
    const list = Array.isArray(body) ? body : [body]
    const answers = await res.json()
    for (const a of Array.isArray(answers) ? answers : [answers]) {
      const r = list.find((x) => x.id === a.id)
      if (r?.method === 'eth_call' && functionBySelector(r.params[0].data) === 'ownerOf') a.result = '0x' + '00'.repeat(12) + '99'.repeat(20)
    }
    return new Response(JSON.stringify(answers), { headers: { 'content-type': 'application/json' } })
  }
  await assert.rejects(client(lie).resolve(NAME), (e) => e.code === 'RPC_DISAGREE' && /eth_call/.test(e.message))
  assert.ok(batches > 0, 'ownerOf was asked in a batch')
})

test('the fact cache never stands in for a check: the holder, the file and its hash are read on every resolve; errors are never cached', async () => {
  const chain = service()
  const api = client(chain.fetch)
  await api.resolve(NAME)
  // the circuit is sold: the next resolve reads ownerOf again / 电路被卖：下一次解析重新读 ownerOf
  chain.setOwner(4246, '0x' + '99'.repeat(20))
  await assert.rejects(api.resolve(NAME), (e) => e.code === 'DELEGATION_INVALID')
  chain.setOwner(4246, holder)
  // the bytes no longer match fileInfo: caught on the next resolve / 字节与 fileInfo 不再相符：下一次解析就发现
  chain.setFileBytes(ADDR.container, MANIFEST_KEY, JSON.stringify({ ...manifestFor(56, ADDR.container), name: 'Swapped' }))
  await assert.rejects(api.resolve(NAME), (e) => e.code === 'MANIFEST_INVALID' && /fileInfo|sha256/.test(e.message))
  // a processor that does not exist (cpuAt reverts) is not remembered as missing / 不存在的处理器不会被记成"没有"
  const c2 = service()
  const api2 = client(c2.fetch)
  await assert.rejects(api2.resolve('4246.8.tape'), (e) => e.code === 'NOT_FOUND')
  let asked = 0
  const counting = (url, init) => { asked++; return c2.fetch(url, init) }
  const api3 = client(counting)
  await assert.rejects(api3.resolve('4246.8.tape'), (e) => e.code === 'NOT_FOUND')
  const first = asked
  await assert.rejects(api3.resolve('4246.8.tape'), (e) => e.code === 'NOT_FOUND')
  assert.equal(asked, 2 * first, 'NOT_FOUND is read again, not cached')
  // an RPC outage is not cached either / RPC 故障同样不缓存
  const c3 = service()
  const api4 = client(c3.fetch)
  for (const u of RPC) c3.setFault(u, 'http500')
  await assert.rejects(api4.resolve(NAME), (e) => e.code === 'RPC_UNAVAILABLE')
  for (const u of RPC) c3.setFault(u, null)
  assert.deepEqual((await api4.resolve(NAME)).verified, { delegation: true, holder })
})

test('the fact cache lasts at most 300 s, and never crosses chains: the same (circuits, tokenId) derives a different container on each', async () => {
  const chain = service()
  const m = meter(chain.fetch)
  const api = client(m.fetch)
  await api.resolve(NAME)
  const real = Date.now
  try {
    Date.now = () => real() + 299_000
    m.reset(); await api.resolve(NAME)
    assert.ok(!m.http.some((h) => h.fns.includes('cpuAt') || h.fns.includes('accountOf')), 'within 300 s: cached')
    Date.now = () => real() + 301_000
    m.reset(); await api.resolve(NAME)
    assert.ok(m.http.some((h) => h.fns.includes('cpuAt')) && m.http.some((h) => h.fns.includes('accountOf')), 'after 300 s: read again')
  } finally { Date.now = real }
  // Two chains, one client: processor 7 and (circuits, 4246) are the same numbers, the containers differ.
  // 两条链、一个客户端：处理器 7 与 (circuits, 4246) 数字相同，容器不同。
  const X = '0x' + '6a'.repeat(20)
  const bsc = service()
  const xl = service(createFakeChain({ chainId: 196 }), { chainId: 196, container: X })
  const fetch = (url, init) => (String(url).startsWith('http://x') ? xl.fetch(url, init) : bsc.fetch(url, init))
  const both = client(fetch, { chains: { 196: { rpcUrls: ['http://x1', 'http://x2'], hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, factory: ADDR.factory } } })
  for (let i = 0; i < 2; i++) {
    const a = await both.resolve(NAME)
    const b = await both.resolve('4246.2.7.tape')
    assert.deepEqual([a.chainId, a.container.toLowerCase()], [56, ADDR.container])
    assert.deepEqual([b.chainId, b.container.toLowerCase()], [196, X])
  }
})
