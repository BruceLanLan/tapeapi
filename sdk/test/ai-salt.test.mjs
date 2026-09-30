// Request salt (the 2026 Q4 plan, privacy item 3 of the "do now" list): createVerifyingFetch appends 64 random
// whitespace characters to a JSON request body, so the receipt's requestSha256 cannot be confirmed by hashing guessed
// prompts. The upstream parses the same request (`user`, `metadata.user_id` and every other field untouched);
// compressed and non-JSON bodies are sent as they are; the hash is over the bytes actually sent; the receipts of all
// four formats still verify end to end through the real sidecar. No network.
// 请求加盐：createVerifyingFetch 在 JSON 请求正文末尾追加 64 个随机空白字符，回执里的 requestSha256 因此无法靠对猜测的提示词取
// 哈希来确认。上游解析出的请求不变（user、metadata.user_id 等字段都不动）；压缩或非 JSON 的正文原样发送；哈希按实际发出的字节
// 计算；四种格式的回执经真实旁路端到端核验仍然通过。不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import * as ai from '../src/ai.js'
import { createAIProxy } from '../../server/src/ai-proxy.js'

const KEY = '0x' + '42'.repeat(32)
const CIRCUITS = '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', CONTAINER = '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8'
const te = new TextEncoder(), td = new TextDecoder()
const price = (currency, input, output) => ({ currency, unit: '1M tokens', input, output })
const MODELS = [
  { id: 'demo-chat', prices: [price('BEM', '1', '2')] },
  { id: 'claude-demo', formats: ['anthropic-messages'], prices: [price('BEM', '3', '15')] },
  { id: 'demo-embed', formats: ['openai-embeddings'], prices: [price('USDT', '0.02', '0')] },
]
const WS_RE = /^[ \t\n\r]*$/

test('saltRequestBody: 64 characters from the four JSON whitespace characters, a fresh salt each time, the parsed JSON unchanged', () => {
  const body = te.encode(JSON.stringify({ model: 'demo-chat', user: 'user-7', metadata: { user_id: 'user_abc_account_1_session_x' }, messages: [{ role: 'user', content: 'yes' }] }))
  const a = ai.saltRequestBody(body, { 'content-type': 'application/json' })
  const b = ai.saltRequestBody(body, new Headers({ 'content-type': 'application/json; charset=utf-8' }))
  assert.equal(ai.SALT_LENGTH, 64)
  assert.equal(a.length, body.length + 64)
  assert.deepEqual(a.subarray(0, body.length), body, 'the original bytes first, untouched')
  assert.match(td.decode(a.subarray(body.length)), WS_RE)
  assert.deepEqual(JSON.parse(td.decode(a)), JSON.parse(td.decode(body)), 'user and metadata.user_id included')
  assert.notDeepEqual(a.subarray(body.length), b.subarray(body.length), 'fresh each time')
  assert.notEqual(ai.sha256Hex(a), ai.sha256Hex(body))
  // Roughly uniform over the four characters (128 bits in 64 characters). / 四种字符大致均匀。
  const counts = [0, 0, 0, 0]
  for (let i = 0; i < 200; i++) for (const c of ai.saltRequestBody(body).subarray(body.length)) counts[[0x20, 0x09, 0x0a, 0x0d].indexOf(c)]++
  for (const n of counts) assert.ok(n > 2400 && n < 4000, `counts ${counts}`)
  // Arrays, JSON with a +json type, no content-type, identity coding, leading whitespace: salted.
  // 数组、+json 类型、没有 content-type、identity 编码、开头有空白：都加盐。
  assert.ok(ai.saltRequestBody(te.encode('[1,2]')))
  assert.ok(ai.saltRequestBody(te.encode('{"a":1}'), { 'content-type': 'application/vnd.api+json' }))
  assert.ok(ai.saltRequestBody(te.encode('{"a":1}'), { 'content-encoding': 'identity' }))
  assert.ok(ai.saltRequestBody(te.encode('\n {"a":1}')))
})

test('saltRequestBody leaves alone: compressed bodies, non-JSON types, bytes that are not JSON, an empty body', () => {
  const json = te.encode('{"model":"demo-chat","messages":[]}')
  assert.equal(ai.saltRequestBody(new Uint8Array(gzipSync(json)), { 'content-encoding': 'gzip', 'content-type': 'application/json' }), null)
  assert.equal(ai.saltRequestBody(json, { 'content-encoding': 'br' }), null, 'a declared coding is enough')
  assert.equal(ai.saltRequestBody(json, { 'content-encoding': 'zstd' }), null)
  assert.equal(ai.saltRequestBody(new Uint8Array(gzipSync(json))), null, 'undeclared gzip is not JSON text either')
  assert.equal(ai.saltRequestBody(te.encode('--x\r\ncontent-disposition: form-data\r\n\r\n{}\r\n--x--'), { 'content-type': 'multipart/form-data; boundary=x' }), null)
  assert.equal(ai.saltRequestBody(json, { 'content-type': 'text/plain' }), null)
  assert.equal(ai.saltRequestBody(te.encode('{"a":'), {}), null, 'not a whole JSON text')
  assert.equal(ai.saltRequestBody(te.encode('"just a string"')), null, 'a JSON text that is not an object or array')
  assert.equal(ai.saltRequestBody(new Uint8Array([0x7b, 0xff, 0x7d])), null, 'not UTF-8')
  assert.equal(ai.saltRequestBody(new Uint8Array(0)), null)
  assert.equal(ai.saltRequestBody('{"a":1}'), null, 'bytes only')
})

// The real sidecar over a recording stub upstream. / 真实旁路，背后是记录请求的桩上游。
function sidecar(answer) {
  const got = []
  const p = createAIProxy({
    upstream: { baseUrl: 'https://up.example/v1' }, signerKey: KEY, models: MODELS, log: () => {},
    manifestBase: { name: 'AI', circuits: CIRCUITS, tokenId: '11', container: CONTAINER, delegation: null, endpoints: { live: ['https://ai.example/tapeapi/v1'], async: false } },
    fetch: async (url, init) => { const bytes = init.body == null ? new Uint8Array(0) : new Uint8Array(init.body); got.push({ url, bytes, headers: new Headers(init.headers) }); return answer(url, bytes) },
  })
  const sent = []
  const fetch = (u, i) => { sent.push({ body: new Uint8Array(i.body), headers: new Headers(i.headers) }); return p.handleRequest(new Request(u, i), { clientIp: '1.1.1.1' }) }
  return { p, fetch, got, sent }
}
const svcOf = (p) => ({ manifest: p.manifest(), container: CONTAINER, verified: { dev: true } })
const json = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } })
const sse = (text) => new Response(te.encode(text), { headers: { 'content-type': 'text/event-stream' } })
const CHAT_STREAM = 'data: {"id":"c-1","model":"demo-chat","choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: {"id":"c-1","model":"demo-chat","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\ndata: [DONE]\n\n'
const MSG_STREAM = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-demo","usage":{"input_tokens":10,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":5}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
const RESP_STREAM = 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"demo-chat"}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","model":"demo-chat","usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}\n\n'
const answer = (url) => (url.endsWith('/messages') ? sse(MSG_STREAM) : url.endsWith('/responses') ? sse(RESP_STREAM) : url.endsWith('/embeddings') ? json({ object: 'list', model: 'demo-embed', data: [], usage: { prompt_tokens: 1, total_tokens: 1 } }) : null)

test('end to end, all four formats: the salted bytes reach the upstream unchanged, parse to the same request, and every receipt verifies over them', async () => {
  const { p, fetch, got } = sidecar((url, bytes) => answer(url) ?? (JSON.parse(td.decode(bytes)).stream ? sse(CHAT_STREAM) : json({ id: 'c-2', model: 'demo-chat', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })))
  const reports = []
  const vf = ai.createVerifyingFetch({ service: svcOf(p), fetch, onReport: (r) => reports.push(r) })
  const calls = [
    ['https://ai.example/v1/chat/completions', { model: 'demo-chat', user: 'user-7', messages: [{ role: 'user', content: 'yes' }] }],
    ['https://ai.example/v1/chat/completions', { model: 'demo-chat', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'no' }] }],
    ['https://ai.example/v1/messages', { model: 'claude-demo', stream: true, max_tokens: 8, metadata: { user_id: 'user_abc_account_1_session_x' }, messages: [{ role: 'user', content: 'yes' }] }],
    ['https://ai.example/v1/responses', { model: 'demo-chat', stream: true, input: 'yes' }],
    ['https://ai.example/v1/embeddings', { model: 'demo-embed', input: 'yes' }],
  ]
  for (const [url, obj] of calls) {
    const body = JSON.stringify(obj)
    const res = await vf(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' }, body })
    await res.text()
    const r = reports.at(-1), up = got.at(-1)
    assert.equal(r.ok, true, `${url}: ${r.problems.join('; ')}`)
    assert.equal(r.salted, true)
    assert.equal(up.bytes.length, te.encode(body).length + 64, `${url}: the sidecar passed the salted bytes through`)
    assert.equal(td.decode(up.bytes.subarray(0, te.encode(body).length)), body)
    assert.match(td.decode(up.bytes.subarray(te.encode(body).length)), WS_RE)
    assert.deepEqual(JSON.parse(td.decode(up.bytes)), obj, `${url}: the upstream parses the same request, user and metadata.user_id included`)
    assert.equal(r.receipt.params.requestSha256, ai.sha256Hex(up.bytes), 'the hash of the bytes actually sent')
    assert.notEqual(r.receipt.params.requestSha256, ai.sha256Hex(body), 'not the hash of the guessable text')
  }
  assert.equal(reports.length, calls.length)
})

test('end to end: usage injection still works on a salted body (the sidecar re-serialises what goes upstream; the receipt hashes what the client sent)', async () => {
  const { p, fetch, got, sent } = sidecar(() => sse(CHAT_STREAM))
  const reports = []
  const vf = ai.createVerifyingFetch({ service: svcOf(p), fetch, onReport: (r) => reports.push(r) })
  const res = await vf('https://ai.example/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"demo-chat","stream":true,"messages":[]}' })
  await res.text()
  assert.equal(reports[0].ok, true, reports[0].problems.join())
  assert.equal(reports[0].receipt.result.usageInjected, true)
  assert.equal(reports[0].receipt.params.requestSha256, ai.sha256Hex(sent[0].body), 'the salted bytes the client sent')
  assert.equal(JSON.parse(td.decode(got[0].bytes)).stream_options.include_usage, true)
})

test('salt: false sends the bytes exactly as given; compressed and non-JSON bodies are never salted; an explicit content-length is dropped when the body grows', async () => {
  const { p, fetch, got, sent } = sidecar(() => json({ id: 'c-9', model: 'demo-chat', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  const reports = []
  const body = '{"model":"demo-chat","messages":[{"role":"user","content":"yes"}]}'
  const plain = ai.createVerifyingFetch({ service: svcOf(p), fetch, salt: false, onReport: (r) => reports.push(r) })
  await (await plain('https://ai.example/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).text()
  assert.equal(td.decode(got.at(-1).bytes), body)
  assert.equal(reports.at(-1).salted, false); assert.equal(reports.at(-1).ok, true)
  assert.equal(reports.at(-1).receipt.params.requestSha256, ai.sha256Hex(body), 'without salt the hash is that of the text, and guessable')

  const vf = ai.createVerifyingFetch({ service: svcOf(p), fetch, onReport: (r) => reports.push(r) })
  const gz = new Uint8Array(gzipSync(te.encode(body)))
  await (await vf('https://ai.example/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: gz })).text()
  assert.deepEqual(sent.at(-1).body, gz, 'compressed: sent as it is')
  assert.equal(reports.at(-1).salted, false)
  assert.equal(reports.at(-1).receipt.params.requestSha256, ai.sha256Hex(gz))

  await (await vf('https://ai.example/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'not json' })).text()
  assert.equal(td.decode(sent.at(-1).body), 'not json'); assert.equal(reports.at(-1).salted, false)

  await (await vf('https://ai.example/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(body.length) }, body })).text()
  assert.equal(sent.at(-1).headers.get('content-length'), null, 'the stale length is not sent')
  assert.equal(sent.at(-1).body.length, body.length + 64)
  assert.equal(reports.at(-1).salted, true); assert.equal(reports.at(-1).ok, true)
  // A Request object is salted too. / Request 对象同样加盐。
  await (await vf(new Request('https://ai.example/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body }))).text()
  assert.equal(sent.at(-1).body.length, body.length + 64); assert.equal(reports.at(-1).ok, true)
})
