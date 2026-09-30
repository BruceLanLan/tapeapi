// Mainnet review of 1.2.0 on BSC, X Layer and Base (2026-09-30): what public nodes actually answered, as tests.
// RPC2-1 rate limits in the codes and words nodes use; RPC2-2 publicnode's "block not found: canonical hash";
// RPC2-3 the pin age limits per chain; RPC2-4 one retry of a request whose connection broke; RPC2-5 createTapeAPI quiet.
// 1.2.0 在 BSC、X Layer、Base 主网上的复核（2026-09-30）：公共节点的真实回答写成测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRpc, isNodeLimit } from '../src/rpc.js'
import { createTapeAPI, MANIFEST_KEY, CHAINS } from '../src/index.js'
import * as sig from '../src/sig.js'
import { createFakeChain, ADDR } from './helpers/fake-chain.mjs'

const TO = '0x' + '22'.repeat(20)
const OK = '0x' + '00'.repeat(31) + '01'
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
// Base's default nodes, as operators / Base 的默认节点（按运营方）
const BASE = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://base.gateway.tenderly.co']

// A node set where `limited(url)` gives the error one node answers with (or null), per call, single or in a batch.
// 某个节点对每个调用（单个或批量元素）回 `limited(url)` 给出的错误，其余节点正常作答。
function world(limited) {
  const sent = []
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    sent.push({ url, batch: Array.isArray(body) })
    const one = (r) => (limited(url) ? { jsonrpc: '2.0', id: r.id, error: limited(url) } : { jsonrpc: '2.0', id: r.id, result: OK })
    return json(Array.isArray(body) ? body.map(one) : one(body))
  }
  return { fetch, sent }
}
const three = (rpc) => Promise.allSettled([1, 2, 3].map(() => rpc.ethCall(TO, '0x')))
const outcomes = (settled) => settled.map((s) => (s.status === 'fulfilled' ? s.value : s.reason.code))

// ------------------------------------------------------------------------------------------------ RPC2-1 ----
const LIMITS = [
  ['Coinbase -32016 "over rate limit"', 'mainnet.base.org', { code: -32016, message: 'over rate limit' }],
  ['dRPC 15 "You reached Public endpoint rate limit"', 'drpc', { code: 15, message: 'You reached Public endpoint rate limit, please upgrade to paid plan' }],
  ['429 "Too Many Requests"', 'tenderly', { code: 429, message: 'Too Many Requests' }],
  ['routeme -32029', 'publicnode', { code: -32029, message: 'public rate limit exceeded' }],
  ['-32603 "request throttled"', 'publicnode', { code: -32603, message: 'request throttled, try later' }],
  ['-32603 "daily quota used up"', 'publicnode', { code: -32603, message: 'daily quota used up' }],
  ['-32099 "at capacity"', 'tenderly', { code: -32099, message: 'node at capacity' }],
]

test('FIXED RPC2-1: a rate limit inside an HTTP 200 batch element is that node not answering, never a disagreement', async () => {
  for (const [what, host, err] of LIMITS) {
    const w = world((url) => (url.includes(host) ? err : null))
    const rpc = createRpc({ urls: BASE, quorum: 2, fetch: w.fetch, quiet: true, disagreeRetryMs: 0 })
    assert.deepEqual(outcomes(await three(rpc)), [OK, OK, OK], what)
    assert.ok(w.sent.some((s) => s.url.includes(host) && s.batch), `${what}: the limited node was sent a batch`)
  }
})

test('FIXED RPC2-1: a rate limit as the answer to a single request (HTTP 200) is that node not answering', async () => {
  for (const [what, host, err] of LIMITS) {
    const w = world((url) => (url.includes(host) ? err : null))
    const rpc = createRpc({ urls: BASE, quorum: 2, fetch: w.fetch, quiet: true, disagreeRetryMs: 0 })
    assert.equal(await rpc.call('eth_chainId', []), OK, what)
    assert.equal(await rpc.ethCall(TO, '0x'), OK, what)
    // quorum 4: the limited operator is missing, and what it said is kept as a refusal / 被限流的运营方缺席，原话记为拒绝
    const all = createRpc({ urls: BASE, quorum: 4, fetch: w.fetch, quiet: true, disagreeRetryMs: 0 })
    await assert.rejects(all.ethCall(TO, '0x'), (e) => e.code === 'RPC_UNAVAILABLE' && e.data?.refusals?.[0]?.code === err.code, what)
  }
})

test('FIXED RPC2-1: a revert, or an answer about gas, stays an answer whatever limit words it carries (single and batched)', async () => {
  const answers = [
    { code: 3, message: 'execution reverted: rate limit exceeded' },
    { code: -32000, message: 'execution reverted: quota exceeded' },
    { code: -32015, message: 'VM execution error: revert Too Many Requests' },
    { code: -32000, message: 'gas required exceeds allowance (30000000)' },
  ]
  for (const err of answers) {
    assert.equal(isNodeLimit(err), false, err.message)
    const w = world((url) => (url.includes('publicnode') ? err : null))
    const rpc = createRpc({ urls: BASE, quorum: 2, fetch: w.fetch, quiet: true, disagreeRetryMs: 0 })
    await assert.rejects(rpc.ethCall(TO, '0x'), (e) => e.code === 'RPC_DISAGREE', `single: ${err.message}`)
    assert.deepEqual(outcomes(await three(rpc)), ['RPC_DISAGREE', 'RPC_DISAGREE', 'RPC_DISAGREE'], `batched: ${err.message}`)
  }
  // every node reverting with such words is the chain's answer: RPC_ERROR, a revert / 所有节点都这样回滚：链的回答
  const w = world(() => ({ code: 3, message: 'execution reverted: rate limit exceeded' }))
  await assert.rejects(createRpc({ urls: BASE, quorum: 2, fetch: w.fetch, quiet: true }).ethCall(TO, '0x'), (e) => e.code === 'RPC_ERROR' && e.data.rpcRevert === true)
  // the limits themselves / 限流本身
  for (const [, , err] of LIMITS) assert.equal(isNodeLimit(err), true, err.message)
  assert.equal(isNodeLimit({ code: -32000, message: 'header not found' }), false, 'a missing block is not a limit')
})

// ------------------------------------------------------------------------------------------------ RPC2-2 ----
test('FIXED RPC2-2: publicnode\'s -32001 "block not found: canonical hash" on a pinned read is that node lacking the block', async () => {
  const H = '0x' + 'cd'.repeat(32)
  const lagging = (err) => createRpc({ urls: BASE, quorum: 2, quiet: true, disagreeRetryMs: 0, fetch: world((url) => (url.includes('publicnode') ? err : null)).fetch })
  for (const err of [
    { code: -32001, message: `block not found: canonical hash ${H}` },   // publicnode, measured 2026-09-30
    { code: -32001, message: `block not found: hash ${H}` },             // dRPC
    { code: -32000, message: 'header for hash not found' },               // BSC dataseed
    { code: -32000, message: `block ${H} not found` },                    // OKX
  ]) assert.equal(await lagging(err).ethCall(TO, '0x', { blockHash: H, requireCanonical: true }), OK, err.message)
  // "not canonical" / "not currently canonical" is what the node says about the chain: still an answer
  // "not canonical" / "not currently canonical" 是节点对链的陈述：仍是回答
  for (const message of [`block ${H} is not currently canonical`, `hash ${H} is not canonical`]) {
    await assert.rejects(lagging({ code: -32000, message }).ethCall(TO, '0x', { blockHash: H, requireCanonical: true }), (e) => e.code === 'RPC_DISAGREE', message)
  }
  // an unpinned read: "block not found" is an answer, as before / 未钉块的读取：照旧算回答
  await assert.rejects(lagging({ code: -32001, message: `block not found: canonical hash ${H}` }).ethCall(TO, '0x'), (e) => e.code === 'RPC_DISAGREE')
})

// ------------------------------------------------------------------------------------------------ RPC2-3 ----
test('FIXED RPC2-3: pin age limits per chain: BSC 120 s, X Layer 600 s (its safe block reaches 248 s), Base 300 s', () => {
  assert.equal(CHAINS[56].maxPinAgeS, 120)
  assert.equal(CHAINS[196].maxPinAgeS, 600)
  assert.equal(CHAINS[8453].maxPinAgeS, 300)
  for (const id of [56, 196, 8453]) assert.ok(CHAINS[id].maxPinLagBlocks > 0 && Number.isInteger(CHAINS[id].maxPinLagBlocks))
})

test('FIXED RPC2-3: a pinned X Layer resolution accepts a safe block 400 s old (RPC_STALE under the old 300) and refuses 601 s', async () => {
  const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32)
  const holder = sig.privateKeyToAddress(HOLDER_KEY), signer = sig.privateKeyToAddress(SIGNER_KEY)
  const expires = Math.floor(Date.now() / 1000) + 30 * 86400
  const chain = createFakeChain()
  chain.setOwner(4246, holder); chain.setAccount(4246, ADDR.container)
  // signed for chain 56, so the X Layer resolution ends in DELEGATION_INVALID: past the freshness check
  // 为链 56 签名，X Layer 的解析因此以 DELEGATION_INVALID 结束：说明已通过新鲜度检查
  chain.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify({
    tapeapi: '0.1', name: 'RPC2-3', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
    delegation: { expires, sig: sig.signDigest(sig.delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires }), HOLDER_KEY) },
    endpoints: { live: ['https://api.example.com/tapeapi/v1'], async: false }, methods: [{ name: 'ping', priceBEM: '0', params: {}, returns: {} }],
  }))
  const t0 = Math.floor(Date.now() / 1000)
  chain.state.headTime = t0
  // the fake chain's safe block is head − 40, so 40 s old at t0 / 假链的 safe 块为 head − 40，t0 时 40 秒旧
  const client = (dt) => createTapeAPI({ chainId: 196, rpcUrls: ['http://rpc1', 'http://rpc2', 'http://rpc3'], quorum: 2, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, factory: ADDR.factory, fetch: chain.fetch, pin: true, clock: () => t0 + dt })
  const target = { circuits: ADDR.circuits, tokenId: 4246, chainId: 196 }
  await assert.rejects(client(360).resolve(target), (e) => e.code === 'DELEGATION_INVALID')
  await assert.rejects(client(561).resolve(target), (e) => e.code === 'RPC_STALE' && e.data.ageS === 601 && e.data.maxAgeS === 600)
})

// ------------------------------------------------------------------------------------------------ RPC2-4 ----
const XLAYER = ['https://rpc.xlayer.tech', 'https://xlayerrpc.okx.com', 'https://xlayer.drpc.org']
const resetError = () => new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })
// dRPC fails the first `times` requests with `fault`; everything else answers. `asked` counts requests per host.
// dRPC 的前 `times` 个请求以 `fault` 失败，其余正常作答；`asked` 按主机计数。
function flaky(fault, times = 1) {
  const asked = {}
  let failed = 0
  const fetch = async (url, init) => {
    const host = new URL(url).hostname
    asked[host] = (asked[host] ?? 0) + 1
    const b = JSON.parse(init.body)
    if (host === 'xlayer.drpc.org' && failed < times) { failed++; return fault(init) }
    const one = (r) => ({ jsonrpc: '2.0', id: r.id, result: r.method === 'eth_blockNumber' ? '0x10' : OK })
    return json(Array.isArray(b) ? b.map(one) : one(b))
  }
  return { fetch, asked }
}
const xlayer = (fetch, o = {}) => createRpc({ urls: XLAYER, quorum: 2, fetch, quiet: true, disagreeRetryMs: 0, transportRetryMs: 1, ...o })

test('FIXED RPC2-4: a request whose connection broke is asked once more: one reset no longer stops an X Layer read', async () => {
  const broken = {
    'fetch failed (ECONNRESET)': () => { throw resetError() },
    'socket hang up': () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) },
    'fetch failed (UND_ERR_SOCKET, other side closed)': () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }) },
    'a body cut off mid-read': () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0",')); c.error(new TypeError('terminated')) } }), { headers: { 'content-type': 'application/json' } }),
    'a browser network error': () => { throw new TypeError('Failed to fetch') },
  }
  for (const [what, fault] of Object.entries(broken)) {
    const w = flaky(fault)
    assert.equal(await xlayer(w.fetch).ethCall(TO, '0x'), OK, what)
    assert.deepEqual(w.asked, { 'rpc.xlayer.tech': 1, 'xlayerrpc.okx.com': 1, 'xlayer.drpc.org': 2 }, what)
  }
  // blockNumber and confirmedBlock go through the same path / blockNumber 与 confirmedBlock 走同一路径
  const w = flaky(() => { throw resetError() })
  assert.equal(await xlayer(w.fetch).blockNumber(), 16)
  assert.equal(w.asked['xlayer.drpc.org'], 2)
  // before the fix: the same reset was RPC_UNAVAILABLE / 修复前：同样的重置就是 RPC_UNAVAILABLE
  const off = flaky(() => { throw resetError() })
  await assert.rejects(xlayer(off.fetch, { transportRetryMs: 0 }).ethCall(TO, '0x'), (e) => e.code === 'RPC_UNAVAILABLE' && /ECONNRESET|fetch failed/.test(e.message))
  assert.equal(off.asked['xlayer.drpc.org'], 1, 'transportRetryMs: 0 turns the retry off')
})

test('FIXED RPC2-4: only once, and never a timeout or anything the node answered', async () => {
  // a connection that keeps breaking: asked twice, then the node has not answered / 一直断：问两次，然后算没作答
  const again = flaky(() => { throw resetError() }, 5)
  await assert.rejects(xlayer(again.fetch).ethCall(TO, '0x'), (e) => e.code === 'RPC_UNAVAILABLE')
  assert.equal(again.asked['xlayer.drpc.org'], 2)
  const notRetried = {
    'a timeout (our timer)': (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')))),
    'a connect timeout (undici)': () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }) },
    'a TimeoutError': () => { throw new DOMException('The operation timed out', 'TimeoutError') },
    'HTTP 502': () => new Response('bad gateway', { status: 502 }),
    'HTTP 429 with a JSON-RPC refusal': () => json({ jsonrpc: '2.0', id: 1, error: { code: -32016, message: 'over rate limit' } }, 429),
    'a 200 that is not JSON': () => new Response('<html>nope</html>', { headers: { 'content-type': 'text/html' } }),
    'an answer too large': () => new Response('x'.repeat(2048), { headers: { 'content-type': 'application/json' } }),
    'a plain Error from a custom fetch': () => { throw new Error('boom') },
  }
  for (const [what, fault] of Object.entries(notRetried)) {
    const w = flaky(fault)
    await assert.rejects(xlayer(w.fetch, { timeoutMs: 50, bodyLimit: 1024 }).ethCall(TO, '0x'), (e) => e.code === 'RPC_UNAVAILABLE', what)
    assert.equal(w.asked['xlayer.drpc.org'], 1, `${what}: not asked again`)
  }
  // a healthy read costs one request per node, as in 1.2.0 / 正常读取每个节点一个请求，与 1.2.0 相同
  const healthy = flaky(() => { throw new Error('unused') }, 0)
  await xlayer(healthy.fetch).ethCall(TO, '0x')
  assert.deepEqual(healthy.asked, { 'rpc.xlayer.tech': 1, 'xlayerrpc.okx.com': 1, 'xlayer.drpc.org': 1 })
})

test('FIXED RPC2-4: a batch that broke is not re-sent as a batch; its calls are asked alone (P101-3), each with the one retry', async () => {
  const log = []
  let resets = 0
  const fetch = async (url, init) => {
    const b = JSON.parse(init.body)
    log.push({ host: new URL(url).hostname, batch: Array.isArray(b) })
    // dRPC: its batch and then the first call asked alone both break / dRPC：批量与第一个单独重问的调用都断开
    if (url.includes('drpc') && resets < 2) { resets++; throw resetError() }
    const one = (r) => ({ jsonrpc: '2.0', id: r.id, result: OK })
    return json(Array.isArray(b) ? b.map(one) : one(b))
  }
  const rpc = xlayer(fetch)
  assert.deepEqual(outcomes(await three(rpc)), [OK, OK, OK])
  assert.deepEqual(log.filter((l) => l.host === 'xlayer.drpc.org').map((l) => l.batch), [true, false, false, false, false], 'one batch, then three calls alone, one of them asked twice')
})

// ------------------------------------------------------------------------------------------------ RPC2-5 ----
test('FIXED RPC2-5: createTapeAPI passes quiet to its rpc client and to the other chains\' clients', (t) => {
  const warned = []
  t.mock.method(console, 'warn', (...a) => { warned.push(a.join(' ')) })
  // Hosts used nowhere else: createRpc says it once per node set per process / 别处不用的主机名：每个节点集合每个进程只说一次
  const pair = (tag) => [`https://a-${tag}.rpc2-5.tapeapi-test.net`, `https://b-${tag}.rpc2-5.tapeapi-test.net`]
  createTapeAPI({ rpcUrls: pair('loud'), quorum: 2, fetch: async () => json({}) })
  assert.equal(warned.length, 1, 'without quiet the notice is shown (the spy works)')
  assert.match(warned[0], /leaves no spare/)
  createTapeAPI({ rpcUrls: pair('quiet'), quorum: 2, quiet: true, fetch: async () => json({}) })
  assert.equal(warned.length, 1, 'quiet: true silences it')
  // X Layer through forChain, with the chain's own nodes (two operators) / 通过 forChain 的 X Layer（两家运营方）
  const api = createTapeAPI({ rpcUrls: pair('home'), quorum: 2, quiet: true, fetch: async () => json({}), chains: { 196: { rpcUrls: pair('x1') } } })
  api.forChain(196)
  assert.equal(warned.length, 1, 'the other chain\'s client is quiet too')
  const loudSub = createTapeAPI({ rpcUrls: pair('home2'), quorum: 2, quiet: true, fetch: async () => json({}), chains: { 196: { rpcUrls: pair('x2'), quiet: false } } })
  loudSub.forChain(196)
  assert.equal(warned.length, 2, 'chains[id].quiet: false overrides it for that chain')
})
