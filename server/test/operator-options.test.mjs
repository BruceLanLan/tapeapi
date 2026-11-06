// 2.5 (experimental) operator options of the sidecar, both off by default: upstreamResponseHeaders (an allowlist of the
// upstream response headers passed on to callers; UPSTREAM_RESPONSE_HEADERS in the new-api sidecar) and the receipt
// method's own budget read from RECEIPT_LOOKUPS_PER_MIN in the new-api sidecar (the Worker already read it). Headers are
// not part of a receipt, so the receipts and the body bytes are the same with the allowlist on or off. No network.
// 2.5（实验性）旁路的运营方选项，默认都不开：上游响应头白名单，以及从 RECEIPT_LOOKUPS_PER_MIN 读取 receipt 方法的预算。响应头不在
// 回执里，所以白名单开或不开，回执与正文字节都相同。不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAIProxy, RECEIPT_LOOKUPS_PER_MIN } from '../src/ai-proxy.js'
import { ai } from '@tapeapi/sdk'
import { readConfig, buildProxy } from '../../examples/new-api-sidecar/server.mjs'
import { readConfig as readLiteLLMConfig } from '../../examples/litellm-sidecar/server.mjs'
import { throwawayIdentity, EXAMPLE_MODELS } from '../../examples/new-api-sidecar/smoke.mjs'

const KEY = '0x' + '42'.repeat(32)
const CIRCUITS = '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', CONTAINER = '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8'
const BASE = 'https://ai.example'
const MODELS = [{ id: 'demo-chat', prices: [{ currency: 'USDT', unit: '1M tokens', input: '1', output: '2' }] }]
// What an upstream may say about itself in headers: its channel, its cost, its provider. / 上游可能在响应头里透露的渠道、成本与供应方。
const UPSTREAM_HEADERS = {
  'x-request-id': 'req-1', 'retry-after': '1', 'x-upstream-channel': 'channel-7', 'x-upstream-cost': '0.0001', 'x-provider': 'some-provider',
  'set-cookie': 'a=b', 'access-control-allow-origin': 'https://up.example', [ai.RECEIPT_HEADER]: 'forged',
}
const JSON_ANSWER = '{"id":"chatcmpl-B9MHDbslfkBeAs8l4bebGdFOJ6PeG","object":"chat.completion","model":"demo-chat","choices":[{"index":0,"message":{"role":"assistant","content":"Hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}'
const chunk = (o) => `data: ${JSON.stringify({ id: 'chatcmpl-B9MHDbslfkBeAs8l4bebGdFOJ6PeH', object: 'chat.completion.chunk', model: 'demo-chat', ...o })}\n\n`
const STREAM_ANSWER = chunk({ choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }] }) + chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }) + 'data: [DONE]\n\n'
const fetchOf = () => async (url) => {
  const path = new URL(url).pathname
  if (path.endsWith('/models')) return new Response('{"data":[]}', { headers: { 'content-type': 'application/json', ...UPSTREAM_HEADERS } })
  return new Response(globalThis.__stream ? STREAM_ANSWER : JSON_ANSWER, { headers: { 'content-type': globalThis.__stream ? 'text/event-stream' : 'application/json', ...UPSTREAM_HEADERS } })
}
const make = (extra = {}) => createAIProxy({ upstream: { baseUrl: 'https://up.example/v1' }, manifestBase: { name: 'AI', circuits: CIRCUITS, tokenId: '11', container: CONTAINER, delegation: null, endpoints: { live: [`${BASE}/tapeapi/v1`], async: false } }, signerKey: KEY, models: MODELS, fetch: fetchOf(), log: () => {}, ...extra })

// One call with the clock fixed, so two proxies sign byte-identical receipts. / 固定时钟调用一次，两个旁路签出的回执逐字节相同。
async function call(p, { stream = false, path = '/v1/chat/completions' } = {}) {
  const realNow = Date.now
  Date.now = () => 1_790_000_000_000
  globalThis.__stream = stream
  try {
    const body = JSON.stringify({ model: 'demo-chat', stream, stream_options: stream ? { include_usage: true } : undefined, messages: [{ role: 'user', content: 'Hi' }] })
    const res = await p.handleRequest(new Request(BASE + path, { method: path.endsWith('/models') ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: path.endsWith('/models') ? undefined : body }), { clientIp: '1.1.1.1' })
    const bytes = new Uint8Array(await res.arrayBuffer())
    return { res, bytes, headers: Object.fromEntries(res.headers), receipt: res.headers.get(ai.RECEIPT_HEADER) ?? ai.readSseReceipt(new TextDecoder().decode(bytes)) }
  } finally { Date.now = realNow; globalThis.__stream = false }
}
const asText = (r) => (typeof r === 'string' ? r : JSON.stringify(r))

test('upstreamResponseHeaders unset: every upstream header is passed on as before (only the ones dropped today are dropped)', async () => {
  const { headers } = await call(make())
  for (const h of ['x-request-id', 'retry-after', 'x-upstream-channel', 'x-upstream-cost', 'x-provider']) assert.equal(headers[h], UPSTREAM_HEADERS[h], h)
  assert.equal(headers['set-cookie'], undefined)
  assert.equal(headers['access-control-allow-origin'], '*', 'ours, not the upstream\'s')
  assert.notEqual(headers[ai.RECEIPT_HEADER], 'forged')
})

test('upstreamResponseHeaders: only the listed headers and content-type pass; the sidecar\'s own headers stay', async () => {
  const p = make({ upstreamResponseHeaders: ['X-Request-Id', 'retry-after'] })
  for (const opts of [{}, { stream: true }, { path: '/v1/models' }]) {
    const { res, headers } = await call(p, opts)
    assert.equal(headers['x-request-id'], 'req-1', JSON.stringify(opts)); assert.equal(headers['retry-after'], '1')
    for (const h of ['x-upstream-channel', 'x-upstream-cost', 'x-provider', 'set-cookie']) assert.equal(headers[h], undefined, `${h} ${JSON.stringify(opts)}`)
    assert.ok(headers['content-type'], 'content-type is always kept')
    assert.equal(headers['access-control-allow-origin'], '*')
    assert.match(headers['access-control-expose-headers'], new RegExp(ai.RECEIPT_HEADER))
    if (!opts.path && !opts.stream) assert.ok(ai.decodeReceiptHeader(res.headers.get(ai.RECEIPT_HEADER)).sig, 'the receipt header is the sidecar\'s own')
  }
  // decision 4 (2026-10-22): retry-after is always kept too, so clients can back off / 决定 4：retry-after 也始终保留，客户端才能退避
  const onlyType = make({ upstreamResponseHeaders: [] })
  const { headers } = await call(onlyType)
  assert.deepEqual(Object.keys(headers).filter((h) => !h.startsWith('access-control-') && h !== ai.RECEIPT_HEADER).sort(), ['content-type', 'retry-after'])
})

test('upstreamResponseHeaders changes no receipt and no body byte, whole answers and streams alike', async () => {
  const off = make(), on = make({ upstreamResponseHeaders: ['x-request-id'] })
  for (const stream of [false, true]) {
    const a = await call(off, { stream }), b = await call(on, { stream })
    assert.ok(a.receipt, `a receipt (${stream ? 'stream' : 'whole'})`)
    assert.equal(asText(b.receipt), asText(a.receipt), `same signed receipt (${stream ? 'stream' : 'whole'})`)
    assert.deepEqual(b.bytes, a.bytes, `same body bytes (${stream ? 'stream' : 'whole'})`)
    const env = stream ? a.receipt : ai.decodeReceiptHeader(a.receipt)
    assert.ok(env?.sig)
  }
})

test('upstreamResponseHeaders must be a list of header names', () => {
  for (const bad of ['x-request-id', [1], ['bad header'], ['a:b'], [''], {}]) assert.throws(() => make({ upstreamResponseHeaders: bad }), /upstreamResponseHeaders/, JSON.stringify(bad))
})

const complete = () => ({ ...throwawayIdentity(), PUBLIC_URL: 'https://api.example.com', MODELS_FILE: EXAMPLE_MODELS, FORMATS: 'all' })
const lookup = async (p, ip) => (await p.handleRequest(new Request('https://api.example.com/tapeapi/v1/receipt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'q', params: { id: 'nope' } }) }), { clientIp: ip })).status

test('RECEIPT_LOOKUPS_PER_MIN in the new-api sidecar: unset keeps the default of 10; set raises or lowers it; 0 refuses every lookup', async () => {
  const env = complete()
  const unset = readConfig(env)
  assert.equal(unset.ok, true, unset.problem); assert.equal(unset.config.receiptLookupsPerMin, null)
  const dflt = buildProxy(unset.config, { log: () => {} })
  const statuses = []
  for (let i = 0; i <= RECEIPT_LOOKUPS_PER_MIN; i++) statuses.push(await lookup(dflt, '5.5.5.5'))
  assert.equal(RECEIPT_LOOKUPS_PER_MIN, 10)
  assert.deepEqual(statuses.filter((s) => s === 429).length, 1, 'the 11th lookup is refused, as before')
  assert.equal(statuses.at(-1), 429)
  assert.equal(readConfig({ ...env, RECEIPT_LOOKUPS_PER_MIN: '' }).config.receiptLookupsPerMin, null, 'empty is unset')

  const wide = readConfig({ ...env, RECEIPT_LOOKUPS_PER_MIN: '600' })
  assert.equal(wide.config.receiptLookupsPerMin, 600)
  const pw = buildProxy(wide.config, { log: () => {} })
  for (let i = 0; i < 30; i++) assert.notEqual(await lookup(pw, '6.6.6.6'), 429, `lookup ${i + 1} of 600`)

  const two = buildProxy(readConfig({ ...env, RECEIPT_LOOKUPS_PER_MIN: '2' }).config, { log: () => {} })
  assert.deepEqual([await lookup(two, '7.7.7.7'), await lookup(two, '7.7.7.7'), await lookup(two, '7.7.7.7')].map((s) => s === 429), [false, false, true])

  const zero = buildProxy(readConfig({ ...env, RECEIPT_LOOKUPS_PER_MIN: '0' }).config, { log: () => {} })
  assert.equal(await lookup(zero, '8.8.8.8'), 429, '0 refuses every lookup, as in the Worker')

  for (const bad of ['-1', '1.5', 'ten', '1e3', '99999999']) assert.match(readConfig({ ...env, RECEIPT_LOOKUPS_PER_MIN: bad }).problem ?? '', /RECEIPT_LOOKUPS_PER_MIN/, bad)
  // The LiteLLM package reads the same variable through the same code. / LiteLLM 一键包经同一段代码读取同一变量。
  const lite = readLiteLLMConfig({ ...env, RECEIPT_LOOKUPS_PER_MIN: '120' })
  assert.equal(lite.ok, true, lite.problem); assert.equal(lite.config.receiptLookupsPerMin, 120)
})

test('UPSTREAM_RESPONSE_HEADERS in the new-api sidecar: unset passes every header as before; set, only those', async () => {
  const env = complete()
  assert.equal(readConfig(env).config.upstreamResponseHeaders, null)
  const c = readConfig({ ...env, UPSTREAM_RESPONSE_HEADERS: 'X-Request-Id, retry-after' })
  assert.equal(c.ok, true, c.problem); assert.deepEqual(c.config.upstreamResponseHeaders, ['x-request-id', 'retry-after'])
  const p = buildProxy(c.config, { fetch: fetchOf(), log: () => {} })
  const res = await p.handleRequest(new Request('https://api.example.com/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"gpt-4o-mini","messages":[]}' }), { clientIp: '1.1.1.1' })
  await res.arrayBuffer()
  assert.equal(res.headers.get('x-request-id'), 'req-1'); assert.equal(res.headers.get('x-upstream-channel'), null)
  const plain = buildProxy(readConfig(env).config, { fetch: fetchOf(), log: () => {} })
  const r2 = await plain.handleRequest(new Request('https://api.example.com/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"gpt-4o-mini","messages":[]}' }), { clientIp: '1.1.1.1' })
  await r2.arrayBuffer()
  assert.equal(r2.headers.get('x-upstream-channel'), 'channel-7', 'unset: as before')
  for (const bad of [',', 'x(y)', 'a:b']) assert.match(readConfig({ ...env, UPSTREAM_RESPONSE_HEADERS: bad }).problem ?? '', /UPSTREAM_RESPONSE_HEADERS/, bad)
})

// Review N8 was "the variable is set but the sidecar does not read it": a variable it reads must also be findable in the
// package's README, in both languages. / N8：旁路读取的变量，README 中英文两部分都要能找到。
test('the new-api sidecar README names RECEIPT_LOOKUPS_PER_MIN and UPSTREAM_RESPONSE_HEADERS in both languages', async () => {
  const { readFileSync } = await import('node:fs')
  const readme = readFileSync(new URL('../../examples/new-api-sidecar/README.md', import.meta.url), 'utf8')
  for (const name of ['RECEIPT_LOOKUPS_PER_MIN', 'UPSTREAM_RESPONSE_HEADERS']) {
    const at = [...readme.matchAll(new RegExp(name, 'g'))].map((m) => m.index)
    assert.ok(at.some((i) => /[一-鿿]/.test(readme.slice(Math.max(0, i - 200), i + 200))), `${name} in the Chinese part`)
    assert.ok(at.length >= 2, `${name} in both parts`)
  }
})

// ---- review decisions 3 and 4 (2026-10-22) / 审查决定 3、4 ----
test('FIXED OPS-R1 (decision 3): RECEIPT_LOOKUPS_PER_MIN=off leaves the receipt method to RATE_IP alone in the sidecar and the Worker; 0 still refuses every lookup; a bad value is setup mode in the Worker too, never a throw', async () => {
  const env = complete()
  for (const v of ['off', 'OFF', 'Off']) {
    const c = readConfig({ ...env, RECEIPT_LOOKUPS_PER_MIN: v })
    assert.equal(c.ok, true, c.problem); assert.equal(c.config.receiptLookupsPerMin, 'off')
  }
  const off = buildProxy(readConfig({ ...env, RECEIPT_LOOKUPS_PER_MIN: 'off' }).config, { log: () => {} })
  for (let i = 0; i < 20; i++) assert.notEqual(await lookup(off, '9.9.9.9'), 429, `lookup ${i + 1} with off`)
  assert.match(readConfig({ ...env, RECEIPT_LOOKUPS_PER_MIN: 'offf' }).problem, /or off/)
  const { receiptLimitOf, default: worker } = await import('../../examples/ai-proxy/worker.js')
  assert.equal(receiptLimitOf({}), undefined); assert.equal(receiptLimitOf({ RECEIPT_LOOKUPS_PER_MIN: 'off' }), false)
  assert.deepEqual(receiptLimitOf({ RECEIPT_LOOKUPS_PER_MIN: '0' }), { ip: 0, windowMs: 60_000 })
  assert.match(receiptLimitOf({ RECEIPT_LOOKUPS_PER_MIN: 'ten' }), /RECEIPT_LOOKUPS_PER_MIN/)
  // the Worker with a bad value: setup mode naming the variable (before the fix: createAIProxy threw INVALID_ARGUMENT)
  // Worker 遇到坏值：设置模式并点名变量（修复前：createAIProxy 抛 INVALID_ARGUMENT）
  const wenv = { ...throwawayIdentity(), PUBLIC_URL: 'https://api.example.com', UPSTREAM_BASE_URL: 'https://up.example/v1', MODELS_JSON: JSON.stringify(MODELS), FORMATS: 'openai-chat', RECEIPT_LOOKUPS_PER_MIN: '1e3' }
  const res = await worker.fetch(new Request('https://api.example.com/tapeapi/v1/health'), wenv)
  const body = await res.json()
  assert.equal(body.setup, true); assert.match(JSON.stringify(body), /RECEIPT_LOOKUPS_PER_MIN/)
})
