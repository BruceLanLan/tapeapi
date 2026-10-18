// 2.3 (@experimental): a read whose round found too few answers, every failing node having failed by a network failure
// (a broken or refused connection, a DNS failure, an HTTP 5xx with no JSON-RPC answer other than a gateway timeout; never
// a timeout or an abort, decided 2026-10-16) and the round having taken less than rpcRetryFastMs (2000, decided
// 2026-10-17), is asked again as a whole: up to
// rpcRetries (2) more rounds, waits from retryDelays adding up to at most rpcRetryMaxMs (2000). Each round asks every node
// and needs the same agreement as the first (strict: every configured node). Never retried: a disagreement (beyond the
// one re-ask of 1.x), a JSON-RPC error, a refusal, anything a node answered. rpcRetries 0 is the 2.2 client exactly.
// 2.3（实验性）：某轮作答太少、每个失败节点都属网络类故障（连接断开或被拒、DNS 失败、网关超时以外不带 JSON-RPC 回答的 HTTP 5xx；
// 超时与中止不算，2026-10-16 决定）、且该轮用时少于 rpcRetryFastMs（2000，2026-10-17 决定）时，整次读取再问：
// 最多再 rpcRetries（2）轮，等待（retryDelays）总和至多 rpcRetryMaxMs（2000）。每轮都问全部节点、一致要求与第一轮相同（严格：每个配置
// 节点）。绝不重试：分歧（1.x 的那一次重问之外）、JSON-RPC 错误、拒绝、节点的任何回答。rpcRetries 0 即 2.2 的客户端。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRpc, retryDelays, networkFailure } from '../src/rpc.js'
import { createTapeAPI, sig as SIG, MAINNET, TapeAPIError } from '../src/index.js'
import { diagnose, formatReport } from '../src/doctor.js'
import { createConformChain } from './helpers/conform-chain.mjs'
import { virtualClock, withClock } from './helpers/clock.mjs'

const URLS = ['http://rpc1', 'http://rpc2', 'http://rpc3']
const OK = '0x38'
const json = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } })
const answer = (body, result) => json(Array.isArray(body) ? body.map((r) => ({ jsonrpc: '2.0', id: r.id, result })) : { jsonrpc: '2.0', id: body.id, result })
const rpcError = (body, code, message) => json({ jsonrpc: '2.0', id: body.id, error: { code, message } })
const resetError = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })
const refusedError = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' }) })
const down503 = () => new Response('bad gateway', { status: 503 })

// Three nodes. `fault(url, n, body)` (n: the how-many-th request to that url) returns undefined to answer `result(url)`,
// a Response to send, or throws. `asked` counts requests per url. / 三个节点；fault 返回 undefined 时正常作答。
function nodes(fault = () => undefined, result = () => OK) {
  const asked = Object.fromEntries(URLS.map((u) => [u, 0]))
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    const n = ++asked[url]
    const f = await fault(url, n, body, init)
    return f ?? answer(body, result(url, n, body))
  }
  return { fetch, asked, total: () => Object.values(asked).reduce((a, b) => a + b, 0) }
}
const mk = (fetch, o = {}) => createRpc({ urls: URLS, quorum: 2, fetch, quiet: true, transportRetryMs: 1, disagreeRetryMs: 0, ...o })
const strictChainId = (rpc) => rpc.call('eth_chainId', [], { strict: true })
const errorOf = async (p) => { try { await p } catch (e) { return e } assert.fail('expected a rejection') }
const sameError = (a, b) => {
  assert.equal(a.code, b.code); assert.equal(a.message, b.message); assert.deepEqual(a.data, b.data)
  assert.deepEqual(Object.keys(a), Object.keys(b))
  assert.equal(JSON.stringify(a), JSON.stringify(b))
}

test('RPC-RETRY: a connection reset on the first try, then an answer: the strict read succeeds, every node asked again', async () => {
  // two resets: the per-request re-ask of 1.x (RPC2-4) is used up, the round fails, the next round answers
  // 两次重置：1.x 的单请求重问（RPC2-4）用掉，这一轮失败，下一轮作答
  const w = nodes((url, n) => { if (url === 'http://rpc2' && n <= 2) throw resetError() })
  assert.equal(await strictChainId(mk(w.fetch)), OK)
  assert.deepEqual(w.asked, { 'http://rpc1': 2, 'http://rpc2': 3, 'http://rpc3': 2 })
  // the same with an HTTP 503 and with a refused connection / HTTP 503 与连接被拒同样
  for (const fail of [down503, () => { throw refusedError() }]) {
    const x = nodes((url, n) => (url === 'http://rpc2' && n === 1 ? fail() : undefined))
    assert.equal(await strictChainId(mk(x.fetch, { transportRetryMs: 0 })), OK)
    assert.deepEqual(x.asked, { 'http://rpc1': 2, 'http://rpc2': 2, 'http://rpc3': 2 })
  }
  // and a DNS failure / DNS 失败同样
  const dns = nodes((url, n) => { if (url === 'http://rpc2' && n === 1) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND rpc2'), { code: 'ENOTFOUND' }) }) })
  assert.equal(await strictChainId(mk(dns.fetch, { transportRetryMs: 0 })), OK)
  assert.deepEqual(dns.asked, { 'http://rpc1': 2, 'http://rpc2': 2, 'http://rpc3': 2 })
  // before 2.3 (rpcRetries 0): RPC_UNAVAILABLE / 2.3 之前：RPC_UNAVAILABLE
  const off = nodes((url, n) => { if (url === 'http://rpc2' && n <= 2) throw resetError() })
  const e = await errorOf(strictChainId(mk(off.fetch, { rpcRetries: 0 })))
  assert.equal(e.code, 'RPC_UNAVAILABLE')
  assert.equal(e.message, 'eth_chainId: only 2/3 nodes answered (node#1(rpc2): fetch failed); strict agreement (TAP-10 §5.2) needs every configured node to agree, from max(2, min(3, 3 operators), quorum 2) = 3 operators')
})

// A timeout or an abort is not retried (decided 2026-10-16): only failures that come back fast are, so a node that keeps
// timing out costs a failing read one request timeout, as before 2.3, not 1 + rpcRetries of them.
// 超时与中止不重试（2026-10-16 决定）：只重试很快返回的失败，所以一直超时的节点让一次失败的读取只花一个请求超时（与 2.3 之前相同），
// 而不是 1 + rpcRetries 个。
const hang = (init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))))
test('RPC-RETRY: a timeout is not retried: one round, one request timeout, the same error and requests as rpcRetries 0', async () => {
  // this client's own timer, once (the node would answer the next time): still RPC_UNAVAILABLE, nothing asked again
  // 本客户端计时器超时一次（下次本会作答）：仍是 RPC_UNAVAILABLE，不再问
  const once = nodes((url, n, body, init) => (url === 'http://rpc3' && n === 1 ? hang(init) : undefined))
  const e1 = await errorOf(strictChainId(mk(once.fetch, { rpcTimeoutMs: 50 })))
  assert.equal(e1.code, 'RPC_UNAVAILABLE')
  assert.deepEqual(once.asked, { 'http://rpc1': 1, 'http://rpc2': 1, 'http://rpc3': 1 })
  // a node that keeps timing out: byte for byte what rpcRetries 0 gives, in about one timeout, not three
  // 一直超时的节点：与 rpcRetries 0 逐字节相同，用时约一个超时，而不是三个
  const on = nodes((url, n, body, init) => (url === 'http://rpc3' ? hang(init) : undefined))
  const off = nodes((url, n, body, init) => (url === 'http://rpc3' ? hang(init) : undefined))
  // one round, so one timeout and no wait: counted in requests, not measured on the clock of a busy machine (review T-1)
  // 一轮，所以只有一个超时、没有等待：按请求数而不是在繁忙机器的时钟上量（审查 T-1）
  const a = await errorOf(strictChainId(mk(on.fetch, { rpcTimeoutMs: 150 })))
  const b = await errorOf(strictChainId(mk(off.fetch, { rpcTimeoutMs: 150, rpcRetries: 0 })))
  sameError(a, b)
  assert.deepEqual(on.asked, off.asked)
  assert.deepEqual(on.asked, { 'http://rpc1': 1, 'http://rpc2': 1, 'http://rpc3': 1 })
  // a batched eth_call whose batch times out: not retried either / 整批超时的 eth_call：同样不重试
  const ethCall = ['eth_call', [{ to: '0x' + '11'.repeat(20), data: '0x' }, 'latest']]
  const bt = nodes((url, n, body, init) => (url === 'http://rpc3' ? hang(init) : undefined))
  const bOff = nodes((url, n, body, init) => (url === 'http://rpc3' ? hang(init) : undefined))
  const ea = await errorOf(mk(bt.fetch, { rpcTimeoutMs: 50 }).call(...ethCall, { strict: true }))
  const eb = await errorOf(mk(bOff.fetch, { rpcTimeoutMs: 50, rpcRetries: 0 }).call(...ethCall, { strict: true }))
  sameError(ea, eb)
  assert.deepEqual(bt.asked, bOff.asked)
  // fetch's own timeout errors (undici's connect, headers and body timeouts; the OS's ETIMEDOUT): not retried
  // fetch 自己的超时错误（undici 的连接、响应头、响应体超时；系统的 ETIMEDOUT）：不重试
  for (const code of ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT']) {
    const w = nodes((url) => { if (url === 'http://rpc2') throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('timed out'), { code }) }) })
    assert.equal((await errorOf(strictChainId(mk(w.fetch)))).code, 'RPC_UNAVAILABLE', code)
    assert.equal(w.asked['http://rpc1'], 1, code)
  }
  // a round where one node resets and another times out: not every failure is fast, so it is not retried
  // 一个节点重置、另一个超时的一轮：并非每个失败都很快返回，所以不重试
  const mixed = nodes((url, n, body, init) => (url === 'http://rpc2' ? (() => { throw resetError() })() : url === 'http://rpc3' ? hang(init) : undefined))
  assert.equal((await errorOf(strictChainId(mk(mixed.fetch, { rpcTimeoutMs: 50 })))).code, 'RPC_UNAVAILABLE')
  assert.equal(mixed.asked['http://rpc1'], 1)
})

test('RPC-RETRY: a node that stays down: the same RPC_UNAVAILABLE as without retries (code, message, data, keys), after 2 more rounds', async () => {
  for (const [what, fail] of [['http 503', down503], ['reset', () => { throw resetError() }], ['refused', () => { throw refusedError() }]]) {
    const on = nodes((url) => (url === 'http://rpc2' ? fail() : undefined))
    const off = nodes((url) => (url === 'http://rpc2' ? fail() : undefined))
    const a = await errorOf(strictChainId(mk(on.fetch, { rpcRetryMaxMs: 30 })))
    const b = await errorOf(strictChainId(mk(off.fetch, { rpcRetries: 0 })))
    sameError(a, b)
    assert.equal(a.code, 'RPC_UNAVAILABLE', what)
    // rpcRetryMaxMs 30: the first wait takes all of it, so one extra round / 第一次等待就用完 30 毫秒，所以只多一轮
    assert.equal(on.asked['http://rpc1'], 2, what)
    assert.equal(off.asked['http://rpc1'], 1, what)
  }
  const on = nodes((url) => (url === 'http://rpc2' ? down503() : undefined))
  await errorOf(strictChainId(mk(on.fetch)))
  assert.deepEqual(on.asked, { 'http://rpc1': 3, 'http://rpc2': 3, 'http://rpc3': 3 }, 'default: 1 + 2 rounds, every node each time')
})

test('RPC-RETRY: strict agreement is never lowered: a retried round still needs every configured node', async () => {
  // rpc2 down in every round, rpc1 and rpc3 agree: 2 of 3 would do for a default read, never for a strict one
  // rpc2 每轮都宕机，rpc1 与 rpc3 一致：默认读取 2/3 就够，严格读取永远不够
  const w = nodes((url) => (url === 'http://rpc2' ? down503() : undefined))
  const rpc = mk(w.fetch)
  assert.equal(await rpc.call('eth_chainId', []), OK, 'a default read: 2 operators agree, no retry needed')
  assert.deepEqual(w.asked, { 'http://rpc1': 1, 'http://rpc2': 1, 'http://rpc3': 1 })
  const e = await errorOf(strictChainId(rpc))
  assert.equal(e.code, 'RPC_UNAVAILABLE')
  assert.match(e.message, /only 2\/3 nodes answered/)
})

test('RPC-RETRY: a disagreement is not retried: one round (disagreeRetryMs -1), or the one re-ask of 1.x, never more', async () => {
  const split = () => nodes(() => undefined, (url) => (url === 'http://rpc3' ? '0x01' : OK))
  const one = split()
  assert.equal((await errorOf(strictChainId(mk(one.fetch, { disagreeRetryMs: -1 })))).code, 'RPC_DISAGREE')
  assert.deepEqual(one.asked, { 'http://rpc1': 1, 'http://rpc2': 1, 'http://rpc3': 1 })
  const two = split()
  assert.equal((await errorOf(strictChainId(mk(two.fetch)))).code, 'RPC_DISAGREE')
  assert.deepEqual(two.asked, { 'http://rpc1': 2, 'http://rpc2': 2, 'http://rpc3': 2 }, 'the re-ask of 1.x only')
  // a round with a node down AND a disagreement among the others is too few answers, but is not retried
  // 一个节点宕机、其余节点又有分歧的一轮：作答太少，但不重试
  const mixed = nodes((url) => (url === 'http://rpc1' ? down503() : undefined), (url) => (url === 'http://rpc3' ? '0x01' : OK))
  assert.equal((await errorOf(strictChainId(mk(mixed.fetch, { disagreeRetryMs: -1 })))).code, 'RPC_UNAVAILABLE')
  assert.deepEqual(mixed.asked, { 'http://rpc1': 1, 'http://rpc2': 1, 'http://rpc3': 1 })
  // the 1.x re-ask happens once per read even when a network failure comes between / 中间夹着网络故障，1.x 的重问也只有一次
  // round 1 disagrees, round 2 (the re-ask) has rpc1 down and the others agree -> retried, round 3 disagrees again ->
  // thrown, no second re-ask / 第 1 轮分歧，第 2 轮（重问）rpc1 宕机、其余一致 -> 重试，第 3 轮又分歧 -> 抛出，没有第二次重问
  const f = nodes((url, n) => (n === 2 && url === 'http://rpc1' ? down503() : undefined), (url, n) => (url === 'http://rpc3' && n !== 2 ? '0x01' : OK))
  assert.equal((await errorOf(strictChainId(mk(f.fetch)))).code, 'RPC_DISAGREE')
  assert.deepEqual(f.asked, { 'http://rpc1': 3, 'http://rpc2': 3, 'http://rpc3': 3 })
})

test('RPC-RETRY: JSON-RPC answers and refusals are not retried: a revert, invalid params, a non-answer under TAP-10, a rate limit, a body that is not JSON', async () => {
  const cases = [
    ['revert on every node', () => (url, n, b) => rpcError(b, 3, 'execution reverted'), 'RPC_ERROR', {}],
    ['invalid params on every node', () => (url, n, b) => rpcError(b, -32602, 'invalid params'), 'RPC_ERROR', {}],
    ['a non-answer under TAP-10 (-32000)', () => (url, n, b) => (url === 'http://rpc2' ? rpcError(b, -32000, 'node says no') : undefined), 'RPC_UNAVAILABLE', { answers: 'tap10' }],
    ['a rate limit (-32005)', () => (url, n, b) => (url === 'http://rpc2' ? rpcError(b, -32005, 'rate limit') : undefined), 'RPC_UNAVAILABLE', {}],
    ['HTTP 429 with a JSON-RPC refusal', () => (url, n, b) => (url === 'http://rpc2' ? json({ jsonrpc: '2.0', id: null, error: { code: -32005, message: 'too many requests' } }, 429) : undefined), 'RPC_UNAVAILABLE', {}],
    ['HTTP 429 without a body', () => (url) => (url === 'http://rpc2' ? new Response('', { status: 429 }) : undefined), 'RPC_UNAVAILABLE', {}],
    ['HTTP 403', () => (url) => (url === 'http://rpc2' ? new Response('', { status: 403 }) : undefined), 'RPC_UNAVAILABLE', {}],
    ['a 200 body that is not JSON', () => (url) => (url === 'http://rpc2' ? new Response('<html>', { headers: { 'content-type': 'text/html' } }) : undefined), 'RPC_UNAVAILABLE', {}],
    ['an answer to another request', () => (url, n, b) => (url === 'http://rpc2' ? json({ jsonrpc: '2.0', id: 999999, result: OK }) : undefined), 'RPC_UNAVAILABLE', {}],
    ['a metered fetch whose budget is spent', () => (url) => { if (url === 'http://rpc2') throw new TapeAPIError('RPC_UNAVAILABLE', 'budget spent') }, 'RPC_UNAVAILABLE', {}],
  ]
  for (const [what, fault, code, o] of cases) {
    const w = nodes(fault())
    const e = await errorOf(mk(w.fetch).call('eth_chainId', [], { strict: true, ...o }))
    assert.equal(e.code, code, what)
    assert.deepEqual(w.asked, { 'http://rpc1': 1, 'http://rpc2': 1, 'http://rpc3': 1 }, what)
  }
  // a pinned read a lagging node answers "header not found" for / 落后节点对钉块读取答 "header not found"
  const lag = nodes((url, n, b) => (url === 'http://rpc2' ? rpcError(b, -32000, 'header not found') : undefined))
  assert.equal((await errorOf(mk(lag.fetch).call('eth_getStorageAt', ['0x' + '11'.repeat(20), '0x0', '0x10'], { strict: true }))).code, 'RPC_UNAVAILABLE')
  assert.equal(lag.asked['http://rpc1'], 1)
})

test('RPC-RETRY: what counts as a network failure', () => {
  for (const e of [resetError(), refusedError(), new TypeError('Failed to fetch'), new Error('http 500'), new Error('http 502'), new Error('http 503'), new Error('http 520'), new Error('http 521'),
    Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }), Object.assign(new Error('fetch failed'), { cause: { code: 'EAI_AGAIN' } }),
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'EHOSTUNREACH' } }), Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CLOSED' } }),
    Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }), new Error('socket hang up')]) {
    assert.equal(networkFailure(e), true, `${e.name} ${e.message} ${e.cause?.code ?? ''}`)
  }
  // timeouts and aborts (decided 2026-10-16): not network failures here, whoever's timer it was
  // 超时与中止（2026-10-16 决定）：这里不算网络类故障，无论是谁的计时器
  for (const e of [Object.assign(new Error('aborted'), { name: 'AbortError' }), Object.assign(new Error('x'), { timedOut: true }), Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }),
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }), Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Connect Timeout Error'), { name: 'ConnectTimeoutError' }) }),
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } }), Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_BODY_TIMEOUT' } }),
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } }), Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNABORTED' } }),
    Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }) }),
    Object.assign(new TypeError('fetch failed'), { cause: { cause: { code: 'ETIMEDOUT' } } }),
    // gateway timeouts (review E-2): HTTP 504, Cloudflare's 522 (connection timed out) and 524 (a timeout occurred)
    // 网关超时（审查 E-2）：HTTP 504，Cloudflare 的 522（连接超时）与 524（发生超时）
    new Error('http 504'), new Error('http 522'), new Error('http 524')]) {
    assert.equal(networkFailure(e), false, `${e.name} ${e.message} ${e.cause?.code ?? e.cause?.name ?? ''}`)
  }
  for (const e of [new Error('http 429'), new Error('http 403'), new Error('http 404'), Object.assign(new Error('http 503, node cannot answer'), { refusal: { code: -32005 } }),
    new TapeAPIError('CANON_INVALID', 'not JSON'), new TapeAPIError('RPC_UNAVAILABLE', 'budget spent'), new Error('the answer is for another request (id mismatch)'), new Error('no answer in batch'),
    new Error('bad json-rpc body'), Object.assign(new Error('big'), { data: { tooLarge: true } }), null, 'fetch failed']) {
    assert.equal(networkFailure(e), false, String(e?.message ?? e))
  }
})

test('RPC-RETRY: the waits: exponential with jitter, at most rpcRetries of them, their sum at most rpcRetryMaxMs; options checked', async () => {
  assert.deepEqual(retryDelays({ retries: 2, maxMs: 2000, random: () => 1 }), [400, 800])
  assert.deepEqual(retryDelays({ retries: 2, maxMs: 2000, random: () => 0 }), [200, 400])
  assert.deepEqual(retryDelays({ retries: 2, maxMs: 500, random: () => 1 }), [400, 100])
  assert.deepEqual(retryDelays({ retries: 2, maxMs: 0 }), [])
  assert.deepEqual(retryDelays({ retries: 0, maxMs: 2000 }), [])
  let seed = 7
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  for (let retries = 0; retries <= 5; retries++) {
    for (const maxMs of [0, 1, 30, 500, 1200, 2000, 10000]) {
      for (let k = 0; k < 50; k++) {
        const d = retryDelays({ retries, maxMs, random: rnd })
        assert.ok(d.length <= retries && d.every((x) => Number.isInteger(x) && x > 0) && d.reduce((a, b) => a + b, 0) <= maxMs, `${retries} ${maxMs} ${d}`)
      }
    }
  }
  // the default schedule (2 waits) adds at most 1200 ms; the cap of 2000 is never reached by it
  // 默认（两次等待）至多增加 1200 毫秒；2000 的上限默认用不到
  // A timer never fires early, so the lower bound holds on any machine; the upper bound is the schedule above (random 1:
  // 1200), not measured here, since a busy machine only adds time (review T-1). Three rounds, every node each time.
  // 计时器从不提前触发，所以下界在任何机器上都成立；上界是上面的等待表（random 为 1 时 1200），这里不量，因为繁忙的机器只会多花时间
  // （审查 T-1）。三轮，每轮问全部节点。
  const w = nodes((url) => (url === 'http://rpc2' ? down503() : undefined))
  const t0 = Date.now()
  await errorOf(strictChainId(mk(w.fetch)))
  assert.ok(Date.now() - t0 >= 600, `${Date.now() - t0} ms`)
  assert.deepEqual(w.asked, { 'http://rpc1': 3, 'http://rpc2': 3, 'http://rpc3': 3 })
  for (const bad of [-1, 6, 1.5, '2', null]) assert.throws(() => mk(w.fetch, { rpcRetries: bad }), (e) => e.code === 'INVALID_ARGUMENT', String(bad))
  for (const bad of [-1, 10_001, NaN, Infinity, '2000', null]) assert.throws(() => mk(w.fetch, { rpcRetryMaxMs: bad }), (e) => e.code === 'INVALID_ARGUMENT', String(bad))
  for (const bad of [-1, 10_001, NaN, Infinity, '2000', null]) assert.throws(() => mk(w.fetch, { rpcRetryFastMs: bad }), (e) => e.code === 'INVALID_ARGUMENT', String(bad))
  assert.throws(() => createTapeAPI({ rpcUrls: URLS, fetch: w.fetch, quiet: true, rpcRetryFastMs: -1 }), (e) => e.code === 'INVALID_ARGUMENT')
  assert.throws(() => createTapeAPI({ rpcUrls: URLS, fetch: w.fetch, quiet: true, rpcRetries: 9 }), (e) => e.code === 'INVALID_ARGUMENT')
})

// "Fast" is checked, not assumed (review E-1, decided 2026-10-17): a round is retried only when it took less than
// rpcRetryFastMs (default 2000) from its first request to its last failure. The time is the virtual clock's: the fake node
// moves it by how long its failure took, so nothing here depends on how busy the machine is.
// “很快”是检查出来的，不是假设的（审查 E-1，2026-10-17 决定）：一轮只有从发出第一个请求到最后一个失败少于 rpcRetryFastMs
// （默认 2000）才重试。时间取虚拟时钟：假节点按它失败所用的时间推进时钟，所以这里的结果与机器多忙无关。
test('RPC-RETRY: only a round that failed fast is retried (rpcRetryFastMs, default 2000 ms); a gateway timeout is not retried', () => withClock(virtualClock(), async (clock) => {
  // a node that resets after `ms` every time / 每次都在 ms 之后重置的节点
  const slowReset = (ms) => nodes((url) => { if (url === 'http://rpc2') { clock.advance(ms); throw resetError() } })
  // reset after 100 ms: the per-request re-ask (RPC2-4) makes it 2 x 100 ms per round, fast: three rounds
  // 100 毫秒后重置：单请求重问（RPC2-4）使每轮为 2 x 100 毫秒，算快：三轮
  const fast = slowReset(100)
  assert.equal((await errorOf(strictChainId(mk(fast.fetch)))).code, 'RPC_UNAVAILABLE')
  assert.deepEqual(fast.asked, { 'http://rpc1': 3, 'http://rpc2': 6, 'http://rpc3': 3 })
  // the review's case: a node that resets just before the 8 s timeout (2 x 7.9 s a round): one round, as in 2.2
  // 审查的情形：在 8 秒超时之前一点重置的节点（每轮 2 x 7.9 秒）：一轮，与 2.2 相同
  for (const [ms, timeout] of [[7900, 8000], [24_900, 25_000], [1000, 8000]]) {
    const on = slowReset(ms), off = slowReset(ms)
    const t0 = clock.now()
    const a = await errorOf(strictChainId(mk(on.fetch, { rpcTimeoutMs: timeout })))
    assert.equal(clock.now() - t0, 2 * ms, `${ms}: one round of two requests to rpc2`)
    const b = await errorOf(strictChainId(mk(off.fetch, { rpcTimeoutMs: timeout, rpcRetries: 0 })))
    sameError(a, b)
    assert.deepEqual(on.asked, off.asked, String(ms))
    assert.deepEqual(on.asked, { 'http://rpc1': 1, 'http://rpc2': 2, 'http://rpc3': 1 }, String(ms))
  }
  // the edge: a round of exactly rpcRetryFastMs is not fast; just under it is / 边界：恰好 rpcRetryFastMs 的一轮不算快；略少于它算
  const at = slowReset(1000), under = slowReset(999)
  await errorOf(strictChainId(mk(at.fetch)))
  await errorOf(strictChainId(mk(under.fetch)))
  assert.equal(at.asked['http://rpc1'], 1)
  assert.equal(under.asked['http://rpc1'], 3)
  // the option: a smaller value makes fewer rounds fast; 0 turns retrying off / 选项：更小的值让更少的轮算快；0 关闭重试
  const small = slowReset(100)
  await errorOf(strictChainId(mk(small.fetch, { rpcRetryFastMs: 150 })))
  assert.equal(small.asked['http://rpc1'], 1)
  const zero = nodes((url) => (url === 'http://rpc2' ? down503() : undefined))
  await errorOf(strictChainId(mk(zero.fetch, { rpcRetryFastMs: 0 })))
  assert.equal(zero.asked['http://rpc1'], 1)
  // through createTapeAPI too / 经 createTapeAPI 同样
  const api = nodes((url) => (url === 'http://rpc2' ? down503() : undefined))
  await errorOf(createTapeAPI({ rpcUrls: URLS, fetch: api.fetch, quiet: true, rpcRetryFastMs: 0 }).rpc.call('eth_chainId', [], { strict: true }))
  assert.equal(api.asked['http://rpc1'], 1)
  // a node that answers slowly while another fails fast: the round was slow, so it is not retried
  // 一个节点作答慢、另一个很快失败：这一轮慢，所以不重试
  const slowAnswer = nodes((url) => { if (url === 'http://rpc1') clock.advance(2500); if (url === 'http://rpc2') return down503() })
  await errorOf(strictChainId(mk(slowAnswer.fetch)))
  assert.deepEqual(slowAnswer.asked, { 'http://rpc1': 1, 'http://rpc2': 1, 'http://rpc3': 1 })
  // a gateway timeout, at once: never retried, whatever the time / 网关超时，即使立即返回：不论用时都不重试
  for (const status of [504, 522, 524]) {
    const g = nodes((url) => (url === 'http://rpc2' ? new Response('gateway timeout', { status }) : undefined))
    const e = await errorOf(strictChainId(mk(g.fetch)))
    assert.match(e.message, new RegExp(`http ${status}`))
    assert.deepEqual(g.asked, { 'http://rpc1': 1, 'http://rpc2': 1, 'http://rpc3': 1 }, String(status))
  }
  // the bound: the retries add at most rpcRetries x rpcRetryFastMs (plus the real waits, not on this clock) to a read
  // whose rounds all fail just under rpcRetryFastMs / 上界：每轮都恰在 rpcRetryFastMs 之下失败时，重试至多增加 rpcRetries x
  // rpcRetryFastMs（另加真实的等待，不在这个时钟上）
  const edge = slowReset(999)
  const t1 = clock.now()
  await errorOf(strictChainId(mk(edge.fetch, { rpcTimeoutMs: 8000 })))
  assert.equal(clock.now() - t1, 3 * 1998)
}))

test('RPC-RETRY: the most requests one read can send: (2 + rpcRetries) rounds x nodes x 2 (the per-request re-ask), 24 with three nodes', async () => {
  // every node always resets: 3 rounds, each node asked twice per round (RPC2-4) / 每个节点一直重置：3 轮，每轮每节点问两次
  const all = nodes(() => { throw resetError() })
  await errorOf(strictChainId(mk(all.fetch)))
  assert.equal(all.total(), 3 * 3 * 2)
  // a disagreement first (the 1.x re-ask), then every node resets: 4 rounds / 先分歧（1.x 的重问），然后每个节点都重置：4 轮
  const worst = nodes((url, n) => { if (n > 1) throw resetError() }, (url) => (url === 'http://rpc3' ? '0x01' : OK))
  await errorOf(mk(worst.fetch).call('eth_chainId', []))
  assert.equal(worst.total(), 3 + 3 * 3 * 2)
  assert.ok(worst.total() <= (2 + 2) * URLS.length * 2)
  // rpcRetries 0: as 2.2, (1 + 1) rounds at most / rpcRetries 0：与 2.2 相同，至多 1 + 1 轮
  const off = nodes(() => { throw resetError() })
  await errorOf(strictChainId(mk(off.fetch, { rpcRetries: 0 })))
  assert.equal(off.total(), 3 * 2)
  // single() clients (the bus poller, proofs) never retry a round / single() 客户端（总线轮询、证明）从不整轮重试
  const one = nodes(() => down503())
  await errorOf(mk(one.fetch).single('http://rpc1').call('eth_chainId', []))
  assert.equal(one.total(), 1)
})

// ── a whole resolution and the doctor, on the TAP-10 test chain ───────────────────────────────────────────────────────
const NAME = '42.7.tape'
const NOW = 1792000000
const HOLDER = '0x' + '11'.repeat(32), SIGNER = '0x' + '22'.repeat(32)
function world() {
  const chain = createConformChain()
  chain.state.headTime = NOW
  const c = chain.circuit(42, { holder: SIG.privateKeyToAddress(HOLDER) })
  chain.setAccount('42', c.container); chain.setCode(c.container)
  const expires = NOW + 90 * 86400
  const delegationSig = SIG.signDigest(SIG.delegationDigest(56, MAINNET.hub, { container: c.container, signer: SIG.privateKeyToAddress(SIGNER), expires }), HOLDER)
  const manifest = {
    tapeapi: '0.1', name: 'Retry test', circuits: c.circuits, tokenId: '42', container: c.container, delegation: { expires, sig: delegationSig },
    endpoints: { live: ['https://api.example.com/tapeapi/v1'], async: false }, signer: SIG.privateKeyToAddress(SIGNER),
    methods: [{ name: 'echo', priceBEM: '0', params: { text: 'string' }, returns: { text: 'string' }, description: 'echo' }],
  }
  chain.writeFile(c.container, '.well-known/tapeapi.json', JSON.stringify(manifest))
  return { chain, c }
}
// rpc2 fails the first `times` requests of each distinct call (ids left out) with `fail`; counts every request
// rpc2 对每个不同的调用（不计 id）的前 times 个请求以 fail 失败；统计全部请求
function flakyWorld(times, fail = down503) {
  const w = world()
  const seen = new Map()
  let requests = 0
  const fetch = async (url, init) => {
    requests++
    if (String(url) === 'http://rpc2' && times > 0) {
      const b = JSON.parse(init.body)
      const key = JSON.stringify((Array.isArray(b) ? b : [b]).map((r) => [r.method, r.params]))
      const n = (seen.get(key) ?? 0) + 1
      seen.set(key, n)
      if (n <= times) return fail()
    }
    return w.chain.fetch(String(url), init)
  }
  return { ...w, fetch, requests: () => requests }
}
// the most HTTP requests one resolution can send with the defaults, 3 nodes (see the test below) / 默认值、3 个节点时一次解析至多发出的 HTTP 请求数
const WORST = 3 * 2 + 14 * (2 + 2) * 3 * 2
const apiOf = (fetch, o = {}) => createTapeAPI({ rpcUrls: URLS, fetch, clock: () => NOW, quiet: true, onWarning: () => {}, rpcTimeoutMs: 500, ...o })

test('RPC-RETRY: a resolution where one node fails every read twice before answering succeeds; its worst case in requests is bounded and recorded', async () => {
  const ok = flakyWorld(0)
  const want = await apiOf(ok.fetch).resolve(NAME)
  const base = ok.requests()
  // twice per read beats the per-request re-ask for a reset, and an HTTP 503 is not re-asked per request at all
  // 每次读取失败两次：重置时用完单请求重问；HTTP 503 本来就不做单请求重问
  for (const fail of [down503, () => { throw resetError() }]) {
    const w = flakyWorld(2, fail)
    const got = await apiOf(w.fetch).resolve(NAME)
    assert.equal(got.container, want.container)
    assert.deepEqual(got.manifest, want.manifest)
    assert.ok(w.requests() <= WORST, `${w.requests()} requests, at most ${WORST}`)
  }
  // Recorded on this chain (3 nodes, 3 operators): a resolution is 33 HTTP requests carrying 45 calls: the pin's heads
  // (eth_blockNumber, 3 calls, never retried as a round: TAP-10 §5.3 takes 2 of 3) and 14 reads through call() (one
  // eth_getBlockByNumber, one strict eth_chainId, 3 eth_getStorageAt, 9 eth_call). The worst case, every request sent
  // alone and re-asked once (RPC2-4): heads 3 x 2, and per read (2 + rpcRetries) rounds x 3 nodes x 2, so
  // 6 + 14 x 24 = 342 with the default (2.2: 6 + 14 x 12 = 174). Only a strict read is retried when one node fails.
  // 本链上的记录（3 个节点、3 家运营方）：一次解析 33 个 HTTP 请求、45 个调用：钉块的头块（eth_blockNumber，3 个调用，从不整轮重试：
  // TAP-10 §5.3 取 3 家中的 2 家）与经 call() 的 14 次读取。最坏情况（每个请求单独发出且各重问一次）：头块 3 x 2，每次读取
  // (2 + rpcRetries) 轮 x 3 节点 x 2，默认即 6 + 14 x 24 = 342（2.2：6 + 14 x 12 = 174）。一个节点失败时只有严格读取会重试。
  const calls = { n: 0 }
  const c = flakyWorld(0)
  await apiOf(async (u, i) => { const b = JSON.parse(i.body); calls.n += Array.isArray(b) ? b.length : 1; return c.fetch(u, i) }).resolve(NAME)
  assert.equal(calls.n, 3 + 14 * 3)
  assert.equal(base, 33, 'requests of a resolution without faults (3 nodes)')
  const w = flakyWorld(2)
  await apiOf(w.fetch).resolve(NAME)
  assert.equal(w.requests(), 50, 'requests when rpc2 fails every read twice with HTTP 503')
  // rpcRetries 0: the same faults are RPC_UNAVAILABLE, as in 2.2 / rpcRetries 0：同样的故障就是 RPC_UNAVAILABLE，与 2.2 相同
  const off = flakyWorld(2)
  const e = await errorOf(apiOf(off.fetch, { rpcRetries: 0 }).resolve(NAME))
  assert.equal(e.code, 'RPC_UNAVAILABLE'); assert.equal(e.data.status, 'unavailable')
})

test('RPC-RETRY doctor: a node that fails twice then answers no longer makes check 7 undecided; a node that stays down is exit 3 with the same text as before', async () => {
  const httpOffline = async () => { throw new Error('offline (test)') }
  const run = async (w, o = {}) => diagnose(NAME, { api: apiOf(w.fetch, o), fetch: httpOffline, now: () => NOW, timeoutMs: 200 })
  // the field case of 2026-10-15: eth_chainId of the strict delegation check failed on one node once, then answered
  // 2026-10-15 的实际情形：严格的委托检查里，一个节点的 eth_chainId 失败一次后作答
  const flaky = await run(flakyWorld(2))
  const del = flaky.checks.find((c) => c.id === 'delegation')
  assert.equal(del.status, 'pass', del.detail)
  assert.ok(!flaky.checks.some((c) => c.status === 'error' && /RPC_/.test(c.detail)))
  const before = await run(flakyWorld(2), { rpcRetries: 0 })
  assert.equal(before.exitCode, 3)
  assert.match(before.checks.find((c) => c.status === 'error').detail, /^could not decide: RPC_UNAVAILABLE /)
  // stays down: exit 3, every check and the text report byte for byte what rpcRetries 0 gives
  // 一直宕机：退出码 3，每项检查与文字报告都与 rpcRetries 0 逐字节相同
  const down = () => { const w = world(); w.chain.setFault('http://rpc2', 'http500'); return { fetch: (u, i) => w.chain.fetch(String(u), i) } }
  const a = await run(down()), b = await run(down(), { rpcRetries: 0 })
  assert.equal(a.exitCode, 3)
  assert.deepEqual(a, b)
  assert.equal(formatReport(a, { lang: 'both' }), formatReport(b, { lang: 'both' }))
  assert.match(formatReport(a, { lang: 'both' }), /无法判定：RPC_UNAVAILABLE eth_chainId: only 2\/3 nodes answered \(node#1\(rpc2\): http 500\)/)
  assert.match(formatReport(a, { lang: 'both' }), /exit 3/)
})
