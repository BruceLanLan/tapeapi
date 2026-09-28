// The OpenAI signing sidecar (A3): /v1/* passed through byte for byte, a signed usage receipt on every
// chat/completions/embeddings answer (header, SSE comment before [DONE], or appended), receipts served by the free
// `receipt` method, prices from the manifest's table, only the allowed caller headers upstream, no redirects followed,
// caps and time limits, upstream errors passed through and signed, and 50 concurrent streams kept apart. No network.
// OpenAI 签名旁路：/v1/* 逐字节透传；每个 chat/completions/embeddings 回答都有签名的用量回执（响应头、[DONE] 之前的 SSE 注释，
// 或追加在末尾）；回执由免费方法 receipt 提供；价格来自清单价目表；只有允许的调用方请求头到达上游；不跟随重定向；上限与时限；
// 上游错误透传并签名；50 个并发流互不串扰。不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAIProxy, REQUEST_LIMIT, RESPONSE_LIMIT, HOLD_LIMIT } from '../src/ai-proxy.js'
import { ai as oa } from '@tapeapi/sdk'
// Not in the public face (review RC-7): the implementation module. / 不在公开门面里：用实现模块。
import { sentinelOf, sseDigestOfPayloads } from '../../sdk/src/ai.js'
import { privateKeyToAddress, recoverResponseSigner } from '../../sdk/src/sig.js'

const KEY = '0x' + '42'.repeat(32)
const SIGNER = privateKeyToAddress(KEY)
const CIRCUITS = '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', CONTAINER = '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8'
const BASE = 'https://ai.example'
const UP = 'https://upstream.example/api/v1'
const price = (currency, input, output, extra = {}) => ({ currency, unit: '1M tokens', input, output, ...extra })
// One price per model here (the multi-currency table is covered in sdk/test/ai.test.mjs). / 这里每个模型一个价格。
const MODELS = [
  { id: 'demo-chat', price: price('USD', '0.15', '0.6') },
  { id: 'tiny', price: price('BEM', '0.00000001', '1.23456789') },
  { id: 'demo-embed', formats: ['openai-embeddings'], price: price('USDT', '0.02', '0') },
  { id: 'claude-demo', formats: ['anthropic-messages'], price: price('BEM', '3', '15', { cacheRead: '0.3', cacheWrite: '3.75' }) },
  { id: 'o-demo', formats: ['openai-responses', 'openai-chat'], price: price('USDC', '1', '4', { cacheRead: '0.25', reasoning: '8' }) },
].map(({ price: p, ...m }) => ({ ...m, prices: [p] }))
const ENDPOINTS = [
  { format: 'openai-chat', baseUrl: `${BASE}/v1` }, { format: 'openai-responses', baseUrl: `${BASE}/v1` },
  { format: 'anthropic-messages', baseUrl: BASE }, { format: 'openai-embeddings', baseUrl: `${BASE}/v1` },
]
const manifestBase = () => ({ name: 'Demo AI', circuits: CIRCUITS, tokenId: '11', container: CONTAINER, delegation: null, endpoints: { live: [`${BASE}/tapeapi/v1`], async: false } })
const te = new TextEncoder(), td = new TextDecoder()
const bytesOf = (s) => (typeof s === 'string' ? te.encode(s) : s)

// A stub upstream: records every request and answers with `handler`. / 桩上游：记录每个请求，由 handler 作答。
function stub(handler) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const body = init.body == null ? null : new Uint8Array(init.body)
    const call = { url, method: init.method, headers: Object.fromEntries(new Headers(init.headers)), body, redirect: init.redirect, signal: init.signal }
    calls.push(call)
    return handler(call)
  }
  return { fetch, calls }
}
// Bytes as a stream cut into `size`-byte chunks, optionally with a pause between them. / 按 size 切块的字节流。
function chunked(bytes, size, { delayMs = 0, onCancel } = {}) {
  let i = 0
  return new ReadableStream({
    async pull(c) {
      if (i >= bytes.length) return c.close()
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      c.enqueue(bytes.slice(i, i + size)); i += size
    },
    cancel() { onCancel?.() },
  })
}
const sseResponse = (text, size = 7, extra = {}) => new Response(chunked(bytesOf(text), size, extra), { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'x-request-id': 'req_1', ...(extra.headers || {}) } })
const jsonResponse = (text, status = 200, headers = {}) => new Response(bytesOf(text), { status, headers: { 'content-type': 'application/json', ...headers } })

// An upstream chat stream as the OpenAI API sends it. / 与 OpenAI 接口一致的对话流。
function chatStream({ id = 'chatcmpl-1', model = 'demo-chat', words = ['Hello', ' there', ', ünïcödé ✓'], usage = { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }, done = true, nl = '\n' } = {}) {
  const ev = (o) => `data: ${JSON.stringify(o)}${nl}${nl}`
  let s = ev({ id, object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
  for (const w of words) s += ev({ id, object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { content: w }, finish_reason: null }] })
  s += ev({ id, object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  if (usage) s += ev({ id, object: 'chat.completion.chunk', created: 1, model, choices: [], usage })
  if (done) s += `data: [DONE]${nl}${nl}`
  return s
}

// A minimal, spec-compliant SSE consumer (what the official SDKs do): comment lines ignored, data lines joined, an event
// dispatched on a blank line only, an unfinished event at the end dropped. / 最小的、符合规范的 SSE 消费者。
function parseSse(text) {
  const events = []
  let data = null, event = ''
  for (const line of text.split(/\r\n|\r|\n/).slice(0, -1)) {
    if (line === '') { if (data !== null) events.push({ event, data: data.join('\n') }); data = null; event = ''; continue }
    if (line.startsWith(':')) continue
    const k = line.indexOf(':')
    const field = k < 0 ? line : line.slice(0, k)
    let value = k < 0 ? '' : line.slice(k + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') (data ??= []).push(value)
    else if (field === 'event') event = value
  }
  return events
}

const logs = []
const make = (fetch, extra = {}) => createAIProxy({ upstream: { baseUrl: UP }, manifestBase: manifestBase(), signerKey: KEY, models: MODELS, fetch, log: (...a) => logs.push(a.join(' ')), ...extra })
const post = (p, path, body, { headers = {}, ip = '1.1.1.1' } = {}) => p.handleRequest(new Request(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-caller', ...headers }, body }), { clientIp: ip })
const CHAT = '/v1/chat/completions'
const chatBody = (extra = {}) => JSON.stringify({ model: 'demo-chat', messages: [{ role: 'user', content: 'Hi  there,\n  ünïcödé' }], ...extra })
const RECEIPT_LINE = /: tapeapi-receipt ([A-Za-z0-9_-]+)\n\n?/

test('the manifest: the AI field { endpoints (one per format), models } and a free receipt method; served at /.well-known; health says so', async () => {
  const p = make(stub(() => jsonResponse('{}')).fetch)
  const m = await p.ready
  assert.equal(m.signer, SIGNER)
  assert.equal(oa.MANIFEST_FIELD, 'ai')
  assert.deepEqual(m.ai, { endpoints: ENDPOINTS, models: MODELS })
  assert.deepEqual(m.methods.map((x) => [x.name, x.priceBEM, x.params]), [['receipt', '0', { id: 'string' }]])
  assert.deepEqual(await (await p.handleRequest(new Request(`${BASE}/.well-known/tapeapi.json`))).json(), m)
  const h = await (await p.handleRequest(new Request(`${BASE}/tapeapi/v1/health`))).json()
  assert.equal(h.ok, true); assert.equal(h.signer, SIGNER); assert.deepEqual(h.ai, { endpoints: ENDPOINTS, models: 5, receiptsKept: 0 })
  // Mounted under a path: every endpoint follows, the Anthropic one without /v1. / 挂在子路径下：各端点随之变化。
  const sub = make(stub(() => jsonResponse('{}')).fetch, { publicUrl: `${BASE}/relay/` })
  assert.deepEqual(sub.manifest().ai.endpoints.map((e) => e.baseUrl), [`${BASE}/relay/v1`, `${BASE}/relay/v1`, `${BASE}/relay`, `${BASE}/relay/v1`])
})

test('boot refuses a bad price table or upstream, before serving anything', () => {
  const boot = (over) => { try { createAIProxy({ upstream: { baseUrl: UP }, manifestBase: manifestBase(), signerKey: KEY, models: MODELS, log: () => {}, ...over }); return 'booted' } catch (e) { return e.code } }
  assert.equal(boot({}), 'booted')
  const m = (patch) => [{ id: 'x', prices: [{ ...MODELS[0].prices[0], ...patch }] }]
  assert.equal(boot({ models: [] }), 'MANIFEST_INVALID')
  assert.equal(boot({ models: Array.from({ length: 257 }, (_, i) => ({ ...MODELS[0], id: `m${i}` })) }), 'MANIFEST_INVALID')
  assert.equal(boot({ models: [MODELS[0], MODELS[0]] }), 'MANIFEST_INVALID', 'ids are unique')
  assert.equal(boot({ models: m({ unit: '1K tokens' }) }), 'MANIFEST_INVALID')
  assert.equal(boot({ models: m({ currency: 'EUR' }) }), 'MANIFEST_INVALID')
  for (const c of ['BEM', 'BNB', 'USDT', 'USDC', 'ETH', 'USD1', 'USD']) assert.equal(boot({ models: m({ currency: c }) }), 'booted', c)
  assert.equal(boot({ models: m({ input: '0.123456789' }) }), 'MANIFEST_INVALID', 'at most 8 decimals')
  assert.equal(boot({ models: m({ output: 0.6 }) }), 'MANIFEST_INVALID', 'decimal strings, never numbers')
  assert.equal(boot({ models: m({ cacheRead: 0.1 }) }), 'MANIFEST_INVALID')
  assert.equal(boot({ models: m({ input: '-1' }) }), 'MANIFEST_INVALID')
  assert.equal(boot({ models: [{ id: 'a\u0000b', prices: MODELS[0].prices }] }), 'MANIFEST_INVALID')
  assert.equal(boot({ models: [{ id: 'x', price: MODELS[0].prices[0] }] }), 'MANIFEST_INVALID', 'the single price object is gone')
  assert.equal(boot({ models: [{ ...MODELS[0], formats: ['gemini'] }] }), 'MANIFEST_INVALID', 'formats name configured endpoints')
  assert.equal(boot({ models: [{ id: 'x', input: '1', output: '1', unit: '1M tokens', currency: 'BEM' }] }), 'MANIFEST_INVALID', 'the old flat shape')
  assert.equal(boot({ upstream: { baseUrl: 'ftp://upstream.example/v1' } }), 'INVALID_ARGUMENT')
  assert.equal(boot({ upstream: { baseUrl: 'https://user:pw@upstream.example/v1' } }), 'INVALID_ARGUMENT', 'no credentials in the URL')
  assert.equal(boot({ upstream: { baseUrl: `${UP}?key=1` } }), 'INVALID_ARGUMENT')
  assert.equal(boot({ upstream: { baseUrl: UP, headers: { 'x-key': 7 } } }), 'INVALID_ARGUMENT')
  assert.equal(boot({ manifestBase: { ...manifestBase(), endpoints: { live: ['http://ai.example/tapeapi/v1'], async: false } } }), 'MANIFEST_INVALID', 'https unless dev / allowHttp')
  assert.equal(boot({ receiptTtlMs: 0 }), 'INVALID_ARGUMENT')
})

test('non-stream: request and response bytes pass through unchanged; the receipt header verifies', async () => {
  const answer = '{ "id":"chatcmpl-abc", "object":"chat.completion","model":"demo-chat",\n  "choices":[{"index":0,"message":{"role":"assistant","content":"ünïcödé ✓"}}],\n"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17} }\n'
  const up = stub(() => jsonResponse(answer, 200, { 'x-request-id': 'req_42', 'openai-processing-ms': '7' }))
  const p = make(up.fetch)
  const m = await p.ready
  const body = chatBody({ temperature: 0.1 }).replace('{', '{  ')   // odd whitespace survives / 奇怪的空白也原样保留
  const res = await post(p, CHAT, body)
  const got = new Uint8Array(await res.arrayBuffer())
  assert.equal(res.status, 200)
  assert.equal(td.decode(got), answer, 'response bytes unchanged')
  assert.deepEqual(up.calls[0].body, te.encode(body), 'request bytes unchanged')
  assert.equal(up.calls[0].url, `${UP}/chat/completions`)
  assert.equal(res.headers.get('x-request-id'), 'req_42')
  assert.equal(res.headers.get('openai-processing-ms'), '7')
  const env = oa.decodeReceiptHeader(res.headers.get('x-tapeapi-receipt'))
  assert.equal(env.id, 'chatcmpl-abc')
  assert.equal(env.method, 'openai_chat')
  assert.deepEqual(env.params, { path: '/v1/chat/completions', requestSha256: oa.sha256Hex(body) })
  assert.deepEqual(env.result, { model: 'demo-chat', usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }, responseSha256: oa.sha256Hex(answer), stream: false, complete: true, status: 200, prices: [{ currency: 'USD', amount: '0.00000480' }], modelMatchedBy: 'response' })
  assert.equal(env.container, CONTAINER)
  assert.equal(recoverResponseSigner({ container: env.container, id: env.id, method: env.method, params: env.params, ok: true, body: env.result, ts: env.ts }, env.sig), SIGNER)
  const v = oa.verifyUsageReceipt({ envelope: env, manifest: m, requestBytes: body, responseBytes: got, stream: false, path: CHAT, status: 200, maxSkewS: 300 })
  assert.deepEqual(v.problems, []); assert.equal(v.ok, true)
  // Tampered either way: detected. / 任一方向被篡改都能发现。
  const flipped = got.slice(); flipped[20] ^= 1
  assert.match(oa.verifyUsageReceipt({ envelope: env, manifest: m, requestBytes: body, responseBytes: flipped }).problems.join(), /responseSha256 does not match/)
  assert.match(oa.verifyUsageReceipt({ envelope: env, manifest: m, requestBytes: body.replace('0.1', '0.9'), responseBytes: got }).problems.join(), /requestSha256 does not match/)
  // completions and embeddings are receipt paths too; embeddings have no completion_tokens and no id.
  // completions 与 embeddings 同样有回执；embeddings 没有 completion_tokens，也没有 id。
  const emb = '{"object":"list","model":"demo-embed","data":[{"object":"embedding","index":0,"embedding":[0.1]}],"usage":{"prompt_tokens":1000000,"total_tokens":1000000}}'
  const resp = '{"id":"resp_1","object":"response","model":"o-demo","output":[],"usage":{"input_tokens":1000,"input_tokens_details":{"cached_tokens":400},"output_tokens":300,"output_tokens_details":{"reasoning_tokens":100},"total_tokens":1300}}'
  const p2 = make(stub((c) => jsonResponse(c.url.endsWith('/embeddings') ? emb : c.url.endsWith('/responses') ? resp : '{"id":"cmpl-1","model":"demo-chat","choices":[]}')).fetch)
  const e1 = oa.decodeReceiptHeader((await post(p2, '/v1/embeddings', '{"model":"demo-embed","input":"x"}')).headers.get('x-tapeapi-receipt'))
  assert.equal(e1.method, 'openai_embeddings'); assert.match(e1.id, /^tapeapi-[0-9a-f]{24}$/, 'a generated id when the upstream gives none')
  assert.deepEqual(e1.result.usage, { prompt_tokens: 1000000, completion_tokens: 0, total_tokens: 1000000 })
  assert.deepEqual(e1.result.prices, [{ currency: 'USDT', amount: '0.02000000' }])
  const e2 = oa.decodeReceiptHeader((await post(p2, '/v1/responses', '{"model":"o-demo","input":"x"}')).headers.get('x-tapeapi-receipt'))
  assert.equal(e2.method, 'openai_responses'); assert.equal(e2.id, 'resp_1')
  assert.deepEqual(e2.result.usage, { prompt_tokens: 1000, completion_tokens: 300, total_tokens: 1300, cache_read_tokens: 400, reasoning_tokens: 100 })
  // 600 × 1 + 400 × 0.25 + 200 × 4 + 100 × 8 = 2300 per 1M / 每百万
  assert.deepEqual(e2.result.prices, [{ currency: 'USDC', amount: '0.00230000' }])
  // The legacy completions endpoint is not a receipt format: passed through, unsigned. / 旧版 completions 不是回执格式：原样透传、不签名。
  const e3 = await post(p2, '/v1/completions', '{"model":"demo-chat","prompt":"x"}')
  assert.equal(e3.headers.get('x-tapeapi-receipt'), null); assert.equal(await e3.text(), '{"id":"cmpl-1","model":"demo-chat","choices":[]}')
})

for (const size of [1, 7, 64, 4096]) {
  test(`stream in ${size}-byte chunks: bytes unchanged but for one comment right before [DONE]; parsing unaffected; the receipt verifies`, async () => {
    for (const nl of ['\n', '\r\n']) {
      const upstreamText = chatStream({ nl })
      const up = stub(() => sseResponse(upstreamText, size))
      const p = make(up.fetch)
      const m = await p.ready
      const body = chatBody({ stream: true, stream_options: { include_usage: true } })
      const res = await post(p, CHAT, body)
      assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8')
      assert.equal(res.headers.get('x-tapeapi-receipt'), null, 'a stream carries its receipt in the body')
      const out = await res.text()
      const at = out.indexOf(': tapeapi-receipt ')
      assert.ok(at > 0 && out.slice(at).match(RECEIPT_LINE).index === 0)
      assert.ok(out.slice(at).replace(RECEIPT_LINE, '').startsWith(`data: [DONE]${nl}`), 'right before the [DONE] line')
      assert.equal(out.replace(RECEIPT_LINE, ''), upstreamText, 'everything else byte for byte')
      assert.deepEqual(parseSse(out), parseSse(upstreamText), 'a spec-compliant client sees exactly the upstream events')
      const env = oa.readSseReceipt(out)
      assert.equal(env.id, 'chatcmpl-1')
      assert.deepEqual(env.result.usage, { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 })
      assert.equal(env.result.stream, true)
      assert.equal(env.result.prices[0].amount, '0.00000480')
      assert.equal(env.result.usageInjected, undefined, 'the client asked for usage itself')
      const payloads = parseSse(out).map((e) => e.data)
      assert.equal(env.result.responseSha256, sseDigestOfPayloads(payloads, { sentinel: sentinelOf('openai_chat') }))
      const v = oa.verifyUsageReceipt({ envelope: env, manifest: m, requestBytes: body, responseBytes: out, stream: true, maxSkewS: 300 })
      assert.deepEqual(v.problems, [], `${JSON.stringify(nl)}`)
      assert.equal(oa.verifyUsageReceipt({ envelope: env, manifest: m, requestBytes: body, sseDataPayloads: payloads, stream: true }).ok, true)
      const tampered = out.replace('Hello', 'Hellp')
      assert.match(oa.verifyUsageReceipt({ envelope: env, manifest: m, requestBytes: body, responseBytes: tampered, stream: true }).problems.join(), /responseSha256/)
    }
  })
}

test('stream without [DONE]: the comment is appended; an unfinished last event stays unfinished; no usage -> usage null', async () => {
  const cases = [
    chatStream({ done: false, usage: null }),                                      // ends at an event boundary / 结束在事件边界
    chatStream({ done: false }) + 'data: {"partial":',                             // ends mid-line / 结束在行中
    chatStream({ done: false }) + 'data: {"unfinished":true}\n',                  // ends inside an event / 结束在事件中
  ]
  for (const [i, upstreamText] of cases.entries()) {
    for (const size of [1, 5, 4096]) {
      const p = make(stub(() => sseResponse(upstreamText, size)).fetch)
      const m = await p.ready
      const body = chatBody({ stream: true, stream_options: { include_usage: true } })
      const out = await (await post(p, CHAT, body)).text()
      const pre = i === 1 ? '\n' : ''
      assert.ok(out.startsWith(upstreamText), `case ${i}: upstream bytes first`)
      assert.match(out.slice(upstreamText.length), new RegExp(`^${pre}: tapeapi-receipt [A-Za-z0-9_-]+\\n$`), `case ${i}: then one comment line`)
      assert.deepEqual(parseSse(out), parseSse(upstreamText + pre), `case ${i}: no event added or completed`)
      const env = oa.readSseReceipt(out)
      if (i === 0) { assert.equal(env.result.usage, null); assert.equal(env.result.prices, null) }
      assert.equal(oa.verifyUsageReceipt({ envelope: env, manifest: m, requestBytes: body, responseBytes: out, stream: true }).ok, true, `case ${i} size ${size}`)
    }
  }
})

test('stream edge cases: data:[DONE] without a space, a comment before it, a CRLF split, [DONE] after a field (appended), events after it', async () => {
  const ev = (o) => `data: ${JSON.stringify(o)}\n\n`
  const head = ev({ id: 'c-1', model: 'demo-chat', choices: [] })
  const variants = [
    [head + 'data:[DONE]\n\n', 'before'],
    [head + ': keep-alive\ndata: [DONE]\n\n', 'before-comment'],   // the comment belongs to the held event / 注释属于被扣住的事件
    [head.replace(/\n/g, '\r\n') + 'data: [DONE]\r\n\r\n', 'before'],
    [head + 'event: end\ndata: [DONE]\n\n', 'appended'],           // not recognised at its first line: appended / 首行认不出：追加在末尾
    [head + 'data: [DONE]\r\rdata: {"late":1}\n\n', 'late'],      // a late event is not covered: the verifier says so / 迟到的事件不在回执内
  ]
  for (const [i, [text, where]] of variants.entries()) {
    for (const size of [1, 2, 3, 64]) {
      const p = make(stub(() => sseResponse(text, size)).fetch)
      const m = await p.ready
      const out = await (await post(p, CHAT, chatBody({ stream: true, stream_options: { include_usage: true } }))).text()
      assert.equal(out.replace(RECEIPT_LINE, ''), text, `variant ${i} size ${size}`)
      assert.deepEqual(parseSse(out), parseSse(text), `variant ${i}`)
      const at = out.search(RECEIPT_LINE)
      if (where === 'before') assert.match(out.slice(at).replace(RECEIPT_LINE, ''), /^data: ?\[DONE\]/, `variant ${i}: right before [DONE]`)
      if (where === 'before-comment') assert.ok(out.slice(at).replace(RECEIPT_LINE, '').startsWith(': keep-alive\ndata: [DONE]'))
      if (where === 'appended') assert.equal(at + out.slice(at).match(RECEIPT_LINE)[0].length, out.length, 'at the very end')
      const v = oa.verifyUsageReceipt({ envelope: oa.readSseReceipt(out), manifest: m, responseBytes: out, stream: true })
      assert.equal(v.ok, where !== 'late', `variant ${i}: ${v.problems}`)
    }
  }
})

test('chat usage injection: the sidecar asks upstream for usage, strips the chunk the client did not ask for, and signs exactly what the client got', async () => {
  const upstreamText = chatStream({ usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, prompt_tokens_details: { cached_tokens: 2 } } })
  for (const size of [1, 7, 64, 4096]) {
    const up = stub(() => sseResponse(upstreamText, size))
    const p = make(up.fetch)
    const m = await p.ready
    const body = chatBody({ stream: true })
    const res = await post(p, CHAT, body)
    const out = await res.text()
    const sent = JSON.parse(td.decode(up.calls[0].body))
    assert.deepEqual(sent.stream_options, { include_usage: true }, 'asked upstream for usage')
    assert.deepEqual({ ...sent, stream_options: undefined }, { ...JSON.parse(body), stream_options: undefined }, 'and changed nothing else')
    const usageChunk = upstreamText.split('\n\n').find((e) => e.includes('"usage"')) + '\n\n'
    assert.equal(out.replace(RECEIPT_LINE, ''), upstreamText.replace(usageChunk, ''), `size ${size}: the upstream bytes minus the usage chunk`)
    assert.ok(parseSse(out).every((e) => !e.data.includes('"usage"')), 'the client never sees usage it did not ask for')
    const env = oa.readSseReceipt(out)
    assert.deepEqual(env.result.usage, { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, cache_read_tokens: 2 })
    assert.equal(env.result.usageInjected, true)
    assert.equal(env.params.requestSha256, oa.sha256Hex(body), 'the hash is of the client\'s own bytes')
    assert.deepEqual(oa.verifyUsageReceipt({ envelope: env, manifest: m, requestBytes: body, responseBytes: out, stream: true }).problems, [])
  }
  // include_usage: false is treated like "not asked": same bytes for the client, usage in the receipt.
  // include_usage: false 与"没要"一样处理：客户端收到的字节相同，回执里有用量。
  const up = stub(() => sseResponse(upstreamText, 9))
  const out = await (await post(make(up.fetch), CHAT, chatBody({ stream: true, stream_options: { include_usage: false, other: 1 } }))).text()
  assert.deepEqual(JSON.parse(td.decode(up.calls[0].body)).stream_options, { include_usage: true, other: 1 })
  assert.equal(oa.readSseReceipt(out).result.usage.total_tokens, 17)
  // Non-stream requests are sent as they are. / 非流式请求原样发送。
  const up2 = stub(() => jsonResponse('{"id":"x","model":"demo-chat"}'))
  const body = chatBody()
  await post(make(up2.fetch), CHAT, body)
  assert.deepEqual(up2.calls[0].body, te.encode(body))
})

test('OpenAI Responses stream: the receipt block goes right before event: response.completed, whose usage it prices; a trailing [DONE] is optional', async () => {
  const ev = (name, o) => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...o })}\n\n`
  const r0 = { id: 'resp_9', object: 'response', model: 'o-demo', status: 'in_progress', output: [] }
  const usage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 400 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 100 }, total_tokens: 1300 }
  const body = ev('response.created', { sequence_number: 0, response: r0 }) + ev('response.output_text.delta', { sequence_number: 1, delta: 'Hi' }) +
    ev('response.completed', { sequence_number: 2, response: { ...r0, status: 'completed', usage } })
  for (const [text, tail] of [[body, ''], [body + 'data: [DONE]\n\n', 'data: [DONE]\n\n']]) {
    for (const size of [1, 5, 4096]) {
      const p = make(stub(() => sseResponse(text, size)).fetch)
      const m = await p.ready
      const req = '{"model":"o-demo","stream":true,"input":"hi"}'
      const out = await (await post(p, '/v1/responses', req)).text()
      assert.equal(out.replace(RECEIPT_LINE, ''), text)
      assert.ok(out.includes(`\n\n: tapeapi-receipt `) && out.slice(out.search(RECEIPT_LINE)).replace(RECEIPT_LINE, '').startsWith('event: response.completed\n'), 'right before the final event')
      assert.ok(out.endsWith(tail))
      const env = oa.readSseReceipt(out)
      assert.deepEqual([env.id, env.method, env.result.model], ['resp_9', 'openai_responses', 'o-demo'])
      assert.deepEqual(env.result.usage, { prompt_tokens: 1000, completion_tokens: 300, total_tokens: 1300, cache_read_tokens: 400, reasoning_tokens: 100 })
      assert.equal(env.result.prices[0].amount, '0.00230000')
      assert.deepEqual(oa.verifyUsageReceipt({ envelope: env, manifest: m, requestBytes: req, responseBytes: out, stream: true }).problems, [])
    }
  }
  // Without event: lines the final event cannot be seen at its first line: the receipt is appended, and still verifies.
  // 没有 event: 行时无法在首行认出最终事件：回执追加在末尾，照样能核验。
  const dataOnly = body.replace(/^event: .*\n/gm, '')
  const p = make(stub(() => sseResponse(dataOnly, 7)).fetch)
  const out = await (await post(p, '/v1/responses', '{"stream":true}')).text()
  assert.ok(out.startsWith(dataOnly)); assert.match(out.slice(dataOnly.length), /^: tapeapi-receipt [A-Za-z0-9_-]+\n$/)
  assert.equal(oa.readSseReceipt(out).result.usage.total_tokens, 1300)
})

test('Anthropic Messages: its own headers verbatim, ping passed through, cumulative usage with cache priced, receipt right before message_stop', async () => {
  const ev = (name, o) => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...o })}\n\n`
  const text = ev('message_start', { message: { id: 'msg_7', type: 'message', role: 'assistant', model: 'claude-demo', content: [], usage: { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2000, output_tokens: 1 } } }) +
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + 'event: ping\ndata: {"type": "ping"}\n\n' +
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hello' } }) + ev('content_block_stop', { index: 0 }) +
    ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50, server_tool_use: { web_search_requests: 2 } } }) + ev('message_stop', {})
  for (const size of [1, 7, 4096]) {
    const up = stub(() => sseResponse(text, size))
    const p = make(up.fetch)
    const m = await p.ready
    const req = '{"model":"claude-demo","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"hi"}]}'
    const res = await post(p, '/v1/messages', req, { headers: { authorization: '', 'x-api-key': 'sk-ant-caller', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'a-2025-01-01,b-2026-02-02', 'x-claude-code-session-id': 's' } })
    assert.equal(up.calls[0].url, `${UP}/messages`)
    const h = up.calls[0].headers
    assert.deepEqual([h['x-api-key'], h['anthropic-version'], h['anthropic-beta']], ['sk-ant-caller', '2023-06-01', 'a-2025-01-01,b-2026-02-02'], 'verbatim')
    assert.equal(h['x-claude-code-session-id'], 's', 'Claude Code\'s session header goes upstream (relays key sessions on it)')
    const out = await res.text()
    assert.equal(out.replace(RECEIPT_LINE, ''), text)
    assert.ok(out.includes('event: ping\ndata: {"type": "ping"}\n\n'), 'ping passed through untouched')
    assert.ok(out.slice(out.search(RECEIPT_LINE)).replace(RECEIPT_LINE, '') === ev('message_stop', {}), 'right before message_stop, which ends the stream')
    const env = oa.readSseReceipt(out)
    assert.deepEqual([env.id, env.method, env.params.path], ['msg_7', 'anthropic_messages', '/v1/messages'])
    // input 100 + cache write 1000 + cache read 2000 = prompt 3100; output 50 (message_delta is cumulative and wins).
    assert.deepEqual(env.result.usage, { prompt_tokens: 3100, completion_tokens: 50, total_tokens: 3150, cache_read_tokens: 2000, cache_write_tokens: 1000, other: { web_search_requests: 2 } })
    // 100 × 3 + 2000 × 0.3 + 1000 × 3.75 + 50 × 15 = 5400 per 1M; searches have no token price. / 搜索次数没有 token 价。
    assert.deepEqual([env.result.prices, env.result.unpriced, env.result.modelMatchedBy, env.result.complete], [[{ currency: 'BEM', amount: '0.00540000' }], ['web_search_requests'], 'response', true])
    const v = oa.verifyUsageReceipt({ envelope: env, manifest: m, requestBytes: req, responseBytes: out, stream: true })
    assert.deepEqual(v.problems, []); assert.match(v.warnings.join(), /web_search_requests/)
  }
  // count_tokens and the model list are free: passed through without a receipt, Anthropic headers and all.
  // count_tokens 与模型列表免费：原样透传、无回执，Anthropic 的头照样转发。
  const up = stub((c) => jsonResponse(c.url.endsWith('count_tokens') ? '{"input_tokens":12}' : '{"data":[{"id":"claude-demo","type":"model"}],"has_more":false}'))
  const p = make(up.fetch)
  const c = await post(p, '/v1/messages/count_tokens', '{"model":"claude-demo","messages":[]}', { headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' } })
  assert.equal(await c.text(), '{"input_tokens":12}'); assert.equal(c.headers.get('x-tapeapi-receipt'), null)
  const l = await p.handleRequest(new Request(`${BASE}/v1/models?limit=1000`, { headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' } }), { clientIp: '1.1.1.1' })
  assert.equal(l.status, 200); assert.equal(up.calls[1].url, `${UP}/models?limit=1000`); assert.equal(up.calls[1].headers['x-api-key'], 'k')
  assert.equal(up.calls.length, 2, 'one upstream call each, nothing extra')
})

test('an upstream that sends its own receipt comment or header cannot pass it off: ours comes last and replaces the header', async () => {
  const fake = `: tapeapi-receipt ${oa.encodeReceipt({ id: 'forged', ok: true })}\n\n`
  const p = make(stub((c) => (JSON.parse(td.decode(c.body)).stream ? sseResponse(fake + chatStream(), 9) : jsonResponse('{"id":"x","model":"demo-chat"}', 200, { 'x-tapeapi-receipt': 'forged' }))).fetch)
  const m = await p.ready
  const out = await (await post(p, CHAT, chatBody({ stream: true }))).text()
  const env = oa.readSseReceipt(out)
  assert.equal(env.id, 'chatcmpl-1', 'the last receipt comment is ours')
  assert.equal(oa.verifyUsageReceipt({ envelope: env, manifest: m, responseBytes: out, stream: true }).ok, true)
  const res = await post(p, CHAT, chatBody())
  assert.equal(oa.decodeReceiptHeader(res.headers.get('x-tapeapi-receipt')).id, 'x')
})

test('usage and amount: from the upstream usage and the table, rounded up to 8 decimals; unlisted models are priced null and logged once', async () => {
  const answer = (model, usage) => JSON.stringify({ id: `r-${model}`, model, usage })
  let next
  const p = make(stub(() => jsonResponse(next)).fetch)
  const m = await p.ready
  const receipt = async (model, usage) => { next = answer(model, usage); return oa.decodeReceiptHeader((await post(p, CHAT, chatBody())).headers.get('x-tapeapi-receipt')).result }
  // 1 × 0.00000001 + 1 × 1.23456789 per 1M = 0.0000012345679 -> rounded up / 向上取整
  assert.equal((await receipt('tiny', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })).prices[0].amount, '0.00000124')
  assert.equal((await receipt('tiny', { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 })).prices[0].amount, '0.00000001', 'any fraction of a unit rounds up')
  assert.equal((await receipt('demo-chat', { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })).prices[0].amount, '0.00000000')
  assert.equal((await receipt('demo-chat', { prompt_tokens: 1_000_000, completion_tokens: 2_000_000, total_tokens: 3_000_000 })).prices[0].amount, '1.35000000')
  assert.equal((await receipt('demo-chat', { prompt_tokens: 9_007_199_254_740_991, completion_tokens: 1, total_tokens: 9_007_199_254_740_992 })).usage, null, 'unsafe counts are not trusted')
  const r = await receipt('demo-chat-2025', { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 })
  assert.equal(r.prices, null, 'exact ids only: demo-chat-2025 is not demo-chat')
  assert.equal(r.modelMatchedBy, undefined)
  await receipt('demo-chat-2025', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })
  assert.equal(logs.filter((l) => l.includes('"demo-chat-2025"')).length, 1, 'logged once')
  assert.deepEqual(p.stats().unpricedModels, ['demo-chat-2025'])
  const env = oa.decodeReceiptHeader((await post(p, CHAT, chatBody())).headers.get('x-tapeapi-receipt'))
  assert.equal(oa.verifyUsageReceipt({ envelope: env, manifest: m }).ok, true, 'the table check agrees with an unpriced model')
})

test('receipts are served by POST /tapeapi/v1/receipt as the original signed envelope; kept for receiptTtlMs, at most maxReceipts', async () => {
  let n = 0
  const p = make(stub((c) => (JSON.parse(td.decode(c.body)).stream ? sseResponse(chatStream({ id: `s-${++n}` }), 13) : jsonResponse(JSON.stringify({ id: `j-${++n}`, model: 'demo-chat' })))).fetch, { maxReceipts: 3, receiptTtlMs: 200 })
  const fetchReceipt = async (id) => {
    const res = await p.handleRequest(new Request(`${BASE}/tapeapi/v1/receipt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'q', params: { id } }) }), { clientIp: '2.2.2.2' })
    return { status: res.status, env: await res.json() }
  }
  const a = oa.decodeReceiptHeader((await post(p, CHAT, chatBody())).headers.get('x-tapeapi-receipt'))
  const b = oa.readSseReceipt(await (await post(p, CHAT, chatBody({ stream: true }))).text())
  const got = await fetchReceipt(a.id)
  assert.equal(got.status, 200)
  assert.deepEqual(got.env.result, a, 'the original envelope, as it was delivered')
  assert.equal(recoverResponseSigner({ container: got.env.container, id: 'q', method: 'receipt', params: { id: a.id }, ok: true, body: got.env.result, ts: got.env.ts }, got.env.sig), SIGNER, 'and the answer is itself signed')
  assert.deepEqual((await fetchReceipt(b.id)).env.result, b)
  const miss = await fetchReceipt('nope')
  assert.equal(miss.status, 400); assert.equal(miss.env.error.code, 'BAD_REQUEST'); assert.match(miss.env.error.message, /no receipt for nope/)
  assert.equal((await fetchReceipt('')).env.error.code, 'BAD_REQUEST')
  // maxReceipts 3: the oldest goes first. / 最多 3 份：最早的先淘汰。
  for (let i = 0; i < 3; i++) await post(p, CHAT, chatBody())
  assert.equal((await fetchReceipt(a.id)).status, 400, 'evicted')
  assert.equal(p.stats().receiptsKept, 3)
  // receiptTtlMs 200: gone after it. / 过期即不再提供。
  const c = oa.decodeReceiptHeader((await post(p, CHAT, chatBody())).headers.get('x-tapeapi-receipt'))
  assert.equal((await fetchReceipt(c.id)).status, 200)
  await new Promise((r) => setTimeout(r, 250))
  assert.equal((await fetchReceipt(c.id)).status, 400, 'expired')
})

test('an upstream reusing a response id: the latest receipt is served, the reuse is counted and logged once', async () => {
  const p = make(stub(() => jsonResponse('{"id":"same","model":"demo-chat"}')).fetch)
  const first = oa.decodeReceiptHeader((await post(p, CHAT, chatBody())).headers.get('x-tapeapi-receipt'))
  const second = oa.decodeReceiptHeader((await post(p, CHAT, chatBody({ n: 2 }))).headers.get('x-tapeapi-receipt'))
  assert.notEqual(first.params.requestSha256, second.params.requestSha256)
  const res = await p.handleRequest(new Request(`${BASE}/tapeapi/v1/receipt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'q', params: { id: 'same' } }) }), { clientIp: '2.2.2.2' })
  assert.deepEqual((await res.json()).result, second)
  assert.equal(p.stats().duplicateIds, 1)
})

test('headers: the formats\' own caller headers (auth, version, beta, org), content-type, accept and the clients\' identity and session headers reach the upstream; never cookies, forwarded / x-forwarded-* / x-real-ip, cf-* or host', async () => {
  const up = stub(() => jsonResponse('{"id":"h","model":"demo-chat"}', 200, {
    'set-cookie': 'upstream_session=1; Path=/', 'content-encoding': 'identity', 'access-control-allow-origin': 'https://upstream.example',
    'x-request-id': 'req_9', 'retry-after': '1',
  }))
  const p = make(up.fetch, { upstream: { baseUrl: UP, headers: { 'x-gateway': 'g-1' } } })
  const res = await post(p, CHAT, chatBody(), { headers: {
    authorization: 'Bearer sk-caller-XYZ', cookie: 'session=secret', 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9', 'x-stainless-os': 'MacOS',
    'openai-beta': 'assistants=v2', accept: 'application/json', 'openai-organization': 'org-1', 'x-api-key': 'k', host: 'evil.example', origin: 'https://evil.example',
    'x-forwarded-proto': 'http', 'x-forwarded-host': 'evil.example', 'cf-connecting-ip': '203.0.113.9', 'cf-ray': 'r', 'x-stainless-lang': 'js',
    forwarded: 'for=203.0.113.9', 'user-agent': 'codex_exec/0.158.0', originator: 'codex_exec', 'session-id': 's-1', 'thread-id': 't-1', 'x-client-request-id': 'c-1',
    'x-codex-turn-metadata': '{"a":1}', 'x-codex-window-id': 'w:0', 'x-app': 'cli', 'x-claude-code-session-id': 'cc-1', 'anthropic-dangerous-direct-browser-access': 'true',
    'accept-encoding': 'gzip', 'x-other': 'no', 'proxy-authorization': 'Basic x',
  } })
  assert.equal(res.status, 200)
  assert.deepEqual(Object.keys(up.calls[0].headers).sort(), ['accept', 'anthropic-dangerous-direct-browser-access', 'authorization', 'content-type', 'openai-beta', 'openai-organization', 'originator', 'session-id', 'thread-id', 'user-agent',
    'x-api-key', 'x-app', 'x-claude-code-session-id', 'x-client-request-id', 'x-codex-turn-metadata', 'x-codex-window-id', 'x-gateway', 'x-stainless-lang', 'x-stainless-os'])
  assert.equal(up.calls[0].headers['x-codex-turn-metadata'], '{"a":1}', 'verbatim')
  assert.equal(up.calls[0].headers['user-agent'], 'codex_exec/0.158.0')
  assert.equal(up.calls[0].headers.authorization, 'Bearer sk-caller-XYZ', 'the caller\'s key goes upstream as it is')
  assert.equal(up.calls[0].headers['x-gateway'], 'g-1')
  assert.equal(res.headers.get('set-cookie'), null, 'upstream cookies are not passed on')
  assert.equal(res.headers.get('content-encoding'), null)
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
  assert.match(res.headers.get('access-control-expose-headers'), /x-tapeapi-receipt/)
  assert.equal(res.headers.get('x-request-id'), 'req_9'); assert.equal(res.headers.get('retry-after'), '1')
  // An operator Authorization replaces the caller's, loudly. / 运营者设置的 Authorization 会替换调用方的，并大声记录。
  const up2 = stub(() => jsonResponse('{}'))
  const p2 = make(up2.fetch, { upstream: { baseUrl: UP, headers: { authorization: 'Bearer sk-operator' } } })
  await post(p2, CHAT, chatBody())
  assert.equal(up2.calls[0].headers.authorization, 'Bearer sk-operator')
  assert.ok(logs.some((l) => l.includes('authenticates no one')))
  // CORS preflight for a browser SDK: Authorization and the SDK's own headers allowed. / 浏览器 SDK 的预检。
  const pre = await p.handleRequest(new Request(`${BASE}${CHAT}`, { method: 'OPTIONS', headers: { 'access-control-request-headers': 'authorization, content-type, x-stainless-os' } }))
  assert.equal(pre.status, 204)
  const LISTED = [...oa.FORWARD_HEADERS, 'authorization', 'openai-beta', 'openai-organization', 'openai-project', 'x-api-key', 'anthropic-version', 'anthropic-beta'].join(', ')
  assert.equal(pre.headers.get('access-control-allow-headers'), `${LISTED}, authorization, content-type, x-stainless-os`)
  assert.equal(up.calls.length, 1, 'a preflight never reaches the upstream')
  const bad = await p.handleRequest(new Request(`${BASE}${CHAT}`, { method: 'OPTIONS', headers: { 'access-control-request-headers': 'xÿ' } }))
  assert.equal(bad.headers.get('access-control-allow-headers'), LISTED)
})

test('redirects are not followed and not passed on; the upstream URL cannot be steered by the path', async () => {
  const up = stub((c) => (c.url.includes('/moved') ? new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/internal' } }) : jsonResponse('{"object":"list","data":[]}')))
  const p = make(up.fetch)
  const res = await post(p, '/v1/moved', '{}')
  assert.equal(up.calls[0].redirect, 'manual')
  assert.equal(res.status, 502)
  assert.equal(res.headers.get('location'), null)
  assert.equal((await res.json()).error.code, 'upstream_redirect')
  for (const path of ['/v1//evil.example/x', '/v1/%2F%2Fevil.example', '/v1/..%2F..%2Fadmin']) {
    await p.handleRequest(new Request(BASE + path), { clientIp: '1.1.1.1' })
    const u = new URL(up.calls.at(-1).url)
    assert.equal(u.origin, 'https://upstream.example', path)
    assert.ok(u.pathname.startsWith('/api/v1/'), `${path} -> ${u.pathname}`)
  }
  const before = up.calls.length
  const dots = await p.handleRequest(new Request(`${BASE}/v1/../tapeapi/v1/health`), { clientIp: '1.1.1.1' })
  assert.equal(dots.status, 200, 'dot segments are resolved before routing: this is the health route')
  assert.equal(up.calls.length, before)
})

test('other /v1 paths pass through without a receipt (models, GET of a receipt path)', async () => {
  const list = '{"object":"list","data":[{"id":"demo-chat"}]}'
  const up = stub(() => jsonResponse(list))
  const p = make(up.fetch)
  const res = await p.handleRequest(new Request(`${BASE}/v1/models?limit=2`, { headers: { authorization: 'Bearer k' } }), { clientIp: '1.1.1.1' })
  assert.equal(await res.text(), list)
  assert.equal(res.headers.get('x-tapeapi-receipt'), null)
  assert.equal(up.calls[0].url, `${UP}/models?limit=2`)
  assert.equal(up.calls[0].body, null)
  const g = await p.handleRequest(new Request(`${BASE}/v1/chat/completions`, { headers: { authorization: 'Bearer k' } }), { clientIp: '1.1.1.1' })
  assert.equal(g.headers.get('x-tapeapi-receipt'), null, 'GET /v1/chat/completions lists stored completions: no receipt')
  assert.equal((await p.handleRequest(new Request(`${BASE}/v1/models`, { method: 'PUT', body: '{}' }), { clientIp: '1.1.1.1' })).status, 405)
  assert.equal(p.stats().passThrough, 2)
})

test('upstream errors pass through unchanged and are signed too, with usage and prices null, complete false', async () => {
  for (const [status, text, headers] of [
    [401, '{"error":{"message":"Incorrect API key provided.","type":"invalid_request_error","code":"invalid_api_key"}}', {}],
    [429, '{"error":{"message":"Rate limit reached","type":"requests","code":"rate_limit_exceeded"}}', { 'retry-after': '20' }],
    [500, 'upstream exploded', { 'content-type': 'text/plain' }],
  ]) {
    const p = make(stub(() => jsonResponse(text, status, headers)).fetch)
    const m = await p.ready
    const body = chatBody({ stream: true })
    const res = await post(p, CHAT, body)
    assert.equal(res.status, status)
    const got = await res.text()
    assert.equal(got, text)
    if (headers['retry-after']) assert.equal(res.headers.get('retry-after'), '20')
    const env = oa.decodeReceiptHeader(res.headers.get('x-tapeapi-receipt'))
    assert.deepEqual({ usage: env.result.usage, prices: env.result.prices, stream: env.result.stream, status: env.result.status, complete: env.result.complete }, { usage: null, prices: null, stream: false, status, complete: false })
    assert.equal(oa.verifyUsageReceipt({ envelope: env, manifest: m, requestBytes: body, responseBytes: got, status, stream: false }).ok, true)
  }
  // A "usage" in an error body is not claimed. / 错误正文里的 usage 不被声称。
  const p = make(stub(() => jsonResponse('{"error":{},"model":"demo-chat","usage":{"prompt_tokens":5,"completion_tokens":5}}', 400)).fetch)
  assert.equal(oa.decodeReceiptHeader((await post(p, CHAT, chatBody())).headers.get('x-tapeapi-receipt')).result.usage, null)
})

test('the sidecar\'s own failures are OpenAI-shaped and unsigned: unreachable, timeout, oversize request and response', async () => {
  const unreachable = make(stub(() => { throw new TypeError('fetch failed') }).fetch)
  let res = await post(unreachable, CHAT, chatBody())
  assert.equal(res.status, 502); assert.equal((await res.json()).error.code, 'upstream_unavailable'); assert.equal(res.headers.get('x-tapeapi-receipt'), null)
  // A non-stream answer must be complete within the limit; the upstream request is aborted. / 非流式回答须在时限内完成；上游请求被中止。
  let aborted = false
  const slow = make(stub((c) => new Promise((_, reject) => c.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')) }))).fetch, { upstreamTimeoutMs: 50 })
  res = await post(slow, CHAT, chatBody())
  assert.equal(res.status, 504); assert.equal((await res.json()).error.code, 'upstream_timeout'); assert.ok(aborted)
  const drip = make(stub(() => new Response(chunked(te.encode('{"id":"x"}'), 1, { delayMs: 40 }), { headers: { 'content-type': 'application/json' } })).fetch, { upstreamTimeoutMs: 100 })
  res = await post(drip, CHAT, chatBody())
  assert.equal(res.status, 504, 'a body that drips in past the limit')
  // Request cap: refused before the upstream is called, and a chunked body is not read to its end.
  // 请求上限：在调用上游之前拒绝，分块正文不会被读到底。
  const up = stub(() => jsonResponse('{}'))
  const p = make(up.fetch)
  res = await post(p, CHAT, 'x'.repeat(REQUEST_LIMIT + 1))
  assert.equal(res.status, 413); assert.equal((await res.json()).error.code, 'request_too_large')
  let pulled = 0
  const big = new ReadableStream({ pull(c) { if (pulled >= 64 * 1024 * 1024) return c.close(); pulled += 1024 * 1024; c.enqueue(new Uint8Array(1024 * 1024)) } })
  res = await p.handleRequest(new Request(BASE + CHAT, { method: 'POST', body: big, duplex: 'half' }), { clientIp: '1.1.1.1' })
  assert.equal(res.status, 413)
  assert.ok(pulled <= REQUEST_LIMIT + 2 * 1024 * 1024, `read ${pulled} bytes`)
  assert.equal(up.calls.length, 0)
  res = await post(p, CHAT, 'x'.repeat(REQUEST_LIMIT))
  assert.equal(res.status, 200, 'exactly the limit is fine')
  // Response cap (non-stream): 16 MiB. / 非流式回答上限 16 MiB。
  const huge = make(stub(() => new Response(chunked(new Uint8Array(RESPONSE_LIMIT + 1).fill(0x20), 1024 * 1024), { headers: { 'content-type': 'application/json' } })).fetch)
  res = await post(huge, CHAT, chatBody())
  assert.equal(res.status, 502); assert.equal((await res.json()).error.code, 'upstream_response_too_large')
  assert.equal(huge.stats().tooLarge, 1)
})

test('a stream is not buffered: the first event reaches the client before the upstream has finished; a client that goes away cancels the upstream', async () => {
  let release, cancelled = false
  const gate = new Promise((r) => { release = r })
  const first = te.encode('data: {"id":"c-9","model":"demo-chat","choices":[]}\n\n')
  const upstreamBody = new ReadableStream({
    start(c) { c.enqueue(first) },
    async pull(c) { await gate; c.enqueue(te.encode('data: [DONE]\n\n')); c.close() },
    cancel() { cancelled = true },
  })
  const p = make(stub(() => new Response(upstreamBody, { headers: { 'content-type': 'text/event-stream' } })).fetch)
  const res = await post(p, CHAT, chatBody({ stream: true }))
  const reader = res.body.getReader()
  const { value } = await reader.read()
  assert.deepEqual(value, first, 'the first event arrived while the upstream is still open')
  await reader.cancel()
  for (let i = 0; i < 20 && !cancelled; i++) await new Promise((r) => setTimeout(r, 5))
  assert.ok(cancelled, 'the upstream stream was cancelled')
  release()
})

test('50 parallel streams keep their receipts apart', async () => {
  const up = stub((c) => {
    const n = JSON.parse(td.decode(c.body)).n
    const text = chatStream({ id: `chatcmpl-${n}`, words: [`answer ${n}`, ` ${'x'.repeat(n)}`], usage: { prompt_tokens: n, completion_tokens: 2 * n, total_tokens: 3 * n } })
    return sseResponse(text, 1 + (n % 17), { delayMs: n % 3 })
  })
  const p = make(up.fetch)
  const m = await p.ready
  const runs = await Promise.all(Array.from({ length: 50 }, async (_, n) => {
    const body = chatBody({ stream: true, n })
    const out = await (await post(p, CHAT, body, { ip: `10.0.0.${n}` })).text()
    return { n, body, out, env: oa.readSseReceipt(out) }
  }))
  const ids = new Set()
  for (const { n, body, out, env } of runs) {
    assert.equal(env.id, `chatcmpl-${n}`)
    assert.deepEqual(env.result.usage, { prompt_tokens: n, completion_tokens: 2 * n, total_tokens: 3 * n })
    const v = oa.verifyUsageReceipt({ envelope: env, manifest: m, requestBytes: body, responseBytes: out, stream: true })
    assert.deepEqual(v.problems, [], `stream ${n}`)
    // Another stream's receipt does not verify against this stream. / 别的流的回执对这个流核验不过。
    const other = runs[(n + 1) % 50].env
    assert.equal(oa.verifyUsageReceipt({ envelope: other, manifest: m, requestBytes: body, responseBytes: out, stream: true }).ok, false)
    ids.add(env.id)
  }
  assert.equal(ids.size, 50)
  assert.equal(p.stats().receiptsKept, 50)
  assert.equal(p.stats().streams, 50)
})

test('/v1/* is rate-limited per IP before the body is read', async () => {
  const up = stub(() => jsonResponse('{}'))
  const p = make(up.fetch, { rateLimit: { ip: 2, windowMs: 60_000 } })
  assert.equal((await post(p, CHAT, chatBody(), { ip: '9.9.9.9' })).status, 200)
  assert.equal((await post(p, CHAT, chatBody(), { ip: '9.9.9.9' })).status, 200)
  const res = await post(p, CHAT, chatBody(), { ip: '9.9.9.9' })
  assert.equal(res.status, 429); assert.ok(Number(res.headers.get('retry-after')) >= 1)
  assert.equal((await post(p, CHAT, chatBody(), { ip: '9.9.9.8' })).status, 200, 'another IP is not affected')
  assert.equal(up.calls.length, 3)
  const off = make(up.fetch, { rateLimit: false })
  for (let i = 0; i < 5; i++) assert.equal((await post(off, CHAT, chatBody(), { ip: '9.9.9.9' })).status, 200)
})

// The adapter boundary: a format that is not OpenAI's (named events, usage split over two events, no sentinel, its own
// auth header) plugs in without touching the sidecar; its stream is hashed and receipted by the same neutral code.
// 适配器边界：一个非 OpenAI 的格式（具名事件、用量分在两个事件里、没有结束标记、自己的鉴权头）无需改动旁路即可接入；
// 它的流由同一份与厂商无关的代码取哈希、附回执。
const eventsFormat = Object.freeze({
  name: 'test-events', method: 'test_events', baseSuffix: '/v1',
  match: ({ verb, path }) => verb === 'POST' && path === '/v1/events',
  headers: ['x-api-key', 'test-version'],
  requestModel: (b) => b?.model ?? null,
  stream: { framing: 'sse', sentinel: null },
  response: (j) => ({ id: j?.id ?? null, model: j?.model ?? null, usage: j?.usage ? { prompt_tokens: j.usage.input_tokens, completion_tokens: j.usage.output_tokens } : null }),
  streamState() {
    const s = { id: null, model: null, input: null, output: 0 }
    return {
      event(j, name) {
        if (name === 'message_start') { s.id = j.message.id; s.model = j.message.model; s.input = j.message.usage.input_tokens }
        if (name === 'message_delta') s.output = j.usage.output_tokens
      },
      result: () => ({ id: s.id, model: s.model, usage: s.input === null ? null : { prompt_tokens: s.input, completion_tokens: s.output } }),
    }
  },
})

test('a non-OpenAI format plugs in as an adapter: its headers, its events, no sentinel (receipt appended), verified with the same code', async () => {
  const ev = (name, o) => `event: ${name}\ndata: ${JSON.stringify(o)}\n\n`
  const text = ev('message_start', { type: 'message_start', message: { id: 'msg_1', model: 'demo-chat', usage: { input_tokens: 10, output_tokens: 1 } } }) +
    ev('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }) + ': ping\n\n' +
    ev('message_delta', { type: 'message_delta', usage: { output_tokens: 7 } }) + ev('message_stop', { type: 'message_stop' })
  for (const size of [1, 7, 4096]) {
    const up = stub(() => sseResponse(text, size))
    const p = make(up.fetch, { formats: [eventsFormat], models: [MODELS[0]] })
    const m = await p.ready
    const body = '{"model":"demo-chat","stream":true,"messages":[]}'
    const res = await post(p, '/v1/events', body, { headers: { 'x-api-key': 'k-1', 'test-version': '2023-06-01', authorization: 'Bearer not-for-this-format' } })
    assert.deepEqual(Object.keys(up.calls[0].headers).sort(), ['content-type', 'test-version', 'x-api-key'], 'the format\'s headers, and only those')
    const out = await res.text()
    assert.ok(out.startsWith(text)); assert.match(out.slice(text.length), /^: tapeapi-receipt [A-Za-z0-9_-]+\n$/)
    const env = oa.readSseReceipt(out)
    assert.deepEqual([env.id, env.method, env.result.model, env.result.usage], ['msg_1', 'test_events', 'demo-chat', { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 }])
    assert.equal(env.result.prices[0].amount, '0.00000570')
    assert.deepEqual(oa.verifyUsageReceipt({ envelope: env, manifest: m, requestBytes: body, responseBytes: out, stream: true, formats: [eventsFormat] }).problems, [])
    assert.match(oa.verifyUsageReceipt({ envelope: env, manifest: m }).problems.join(), /unknown receipt method test_events/, 'a verifier without the adapter says so')
  }
  const boot = (formats) => { try { make(stub(() => jsonResponse('{}')).fetch, { formats, models: [MODELS[0]] }); return 'booted' } catch (e) { return e.code } }
  assert.equal(boot([eventsFormat, { ...eventsFormat, name: 'twin' }]), 'INVALID_ARGUMENT', 'two adapters for one receipt method')
  assert.equal(boot([{ ...eventsFormat, streamState: undefined }]), 'INVALID_ARGUMENT')
  assert.equal(boot([{ ...eventsFormat, stream: { framing: 'json-array' } }]), 'INVALID_ARGUMENT', 'only SSE framing so far')
  assert.equal(boot([{ ...eventsFormat, baseSuffix: 'v1' }]), 'INVALID_ARGUMENT')
  assert.equal(boot([{ ...eventsFormat, prepareUpstream: () => null }]), 'INVALID_ARGUMENT', 'a format that changes requests must say which events it caused')
  assert.equal(boot([]), 'INVALID_ARGUMENT')
})

test('a final event larger than HOLD_LIMIT is not held: it streams through and the receipt is appended at the end, still verifying', async () => {
  const ev = (name, o) => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...o })}\n\n`
  const r0 = { id: 'resp_big', model: 'o-demo', output: [] }
  const big = 'x'.repeat(2 * HOLD_LIMIT)
  const text = ev('response.created', { response: r0 }) + ev('response.completed', { response: { ...r0, output: [{ type: 'message', content: [{ type: 'output_text', text: big }] }], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } })
  const p = make(stub(() => sseResponse(text, 256 * 1024)).fetch)
  const m = await p.ready
  const res = await post(p, '/v1/responses', '{"model":"o-demo","stream":true}')
  const reader = res.body.getReader()
  let got = 0, beforeEnd = false
  const parts = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value); got += value.length
    if (got > HOLD_LIMIT && got < text.length) beforeEnd = true   // bytes of the big event arrived before it ended / 大事件结束前就有字节到达
  }
  assert.ok(beforeEnd, 'the big event was streamed, not held to its end')
  const out = Buffer.concat(parts).toString()
  assert.ok(out.startsWith(text)); assert.match(out.slice(text.length), /^: tapeapi-receipt [A-Za-z0-9_-]+\n$/)
  const env = oa.readSseReceipt(out)
  assert.deepEqual(env.result.usage, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 })
  assert.equal(oa.verifyUsageReceipt({ envelope: env, manifest: m, responseBytes: out, stream: true }).ok, true)
  assert.equal(p.stats().appended, 1)
})
