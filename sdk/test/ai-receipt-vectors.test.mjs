// Test vectors for AI usage receipts (sdk/test/fixtures/ai-receipt-vectors.json), for the TAP text and for other
// implementations: per case the exact request bytes, the upstream answer, the bytes the client receives, the manifest
// `ai` field, the signer key (a test key), and the expected receipt envelope, hashes and amounts. They are made by the real
// sidecar with the clock and the id generator fixed, and this test regenerates them and requires the file to be identical;
// it also recomputes every hash with an independent, whole-text SSE reference parser and verifies every receipt.
//   TAPEAPI_WRITE_VECTORS=1 node --test sdk/test/ai-receipt-vectors.test.mjs     # rewrite the file after a deliberate change
// AI 用量回执的测试向量：每个用例给出确切的请求字节、上游回答、客户端收到的字节、清单 ai 字段、签名密钥（测试密钥）以及期望的
// 回执信封、哈希与金额。由真实旁路在固定时钟与固定 id 生成器下生成；本测试重新生成并要求与文件完全一致，另用独立的整段 SSE 参考
// 解析器重算每个哈希，并核验每份回执。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import * as ai from '../src/ai.js'
import { privateKeyToAddress, recoverResponseSigner } from '../src/sig.js'
import { createAIProxy } from '../../server/src/ai-proxy.js'

const FILE = new URL('./fixtures/ai-receipt-vectors.json', import.meta.url)
const KEY = '0x' + '4b'.repeat(32)   // a test key: never use it for anything else / 测试密钥，切勿他用
const CONTAINER = '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8', CIRCUITS = '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414'
const NOW_MS = 1_790_000_000_000
const b64 = (s) => Buffer.from(s).toString('base64')
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'))
const sha = (b) => createHash('sha256').update(b).digest('hex')
const pr = (currency, input, output, extra = {}) => ({ currency, unit: '1M tokens', input, output, ...extra })
const AI_FIELD = {
  endpoints: [
    { format: 'openai-chat', baseUrl: 'https://ai.example/v1' }, { format: 'openai-responses', baseUrl: 'https://ai.example/v1' },
    { format: 'anthropic-messages', baseUrl: 'https://ai.example' }, { format: 'openai-embeddings', baseUrl: 'https://ai.example/v1' },
  ],
  models: [
    { id: 'gpt-x', aliases: ['gpt-x-2026-09-01'], formats: ['openai-chat', 'openai-responses'], prices: [pr('USDT', '1.25', '10', { cacheRead: '0.125', reasoning: '12' }), pr('BEM', '12.5', '100', { cacheRead: '1.25' })] },
    { id: 'claude-x', aliases: ['claude-x-20260901'], formats: ['anthropic-messages'], prices: [pr('BEM', '3', '15', { cacheRead: '0.3', cacheWrite: '3.75', cacheWrite1h: '6' }), pr('USD1', '0.3', '1.5', { cacheRead: '0.03', cacheWrite: '0.375' })] },
    { id: 'embed-x', formats: ['openai-embeddings'], prices: [pr('USDC', '0.02', '0')] },
  ],
}
const ev = (name, o) => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...o })}\n\n`
const chunk = (o) => `data: ${JSON.stringify({ id: 'chatcmpl-v2', object: 'chat.completion.chunk', created: 1790000000, model: 'gpt-x', ...o })}\n\n`
const aStart = (usage, model = 'claude-x-20260901') => ev('message_start', { message: { id: 'msg_v4', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } })

// The cases: what the client sends, what the upstream answers. / 用例：客户端发什么、上游答什么。
const CASES = [
  {
    name: 'openai-chat-json', description: 'Chat Completions, whole answer: cached and reasoning tokens, two currencies',
    path: '/v1/chat/completions', request: '{"model":"gpt-x","messages":[{"role":"user","content":"Hello"}]}',
    upstream: { contentType: 'application/json', body: '{"id":"chatcmpl-v1","object":"chat.completion","created":1790000000,"model":"gpt-x","choices":[{"index":0,"message":{"role":"assistant","content":"Hi!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1200,"completion_tokens":300,"total_tokens":1500,"prompt_tokens_details":{"cached_tokens":1000},"completion_tokens_details":{"reasoning_tokens":100}}}' },
  },
  {
    name: 'openai-chat-stream-usage-injected', description: 'Chat Completions stream; the client did not ask for usage, so the sidecar asked for it upstream and removed the usage chunk from the client\'s copy',
    path: '/v1/chat/completions', request: '{"model":"gpt-x","stream":true,"messages":[{"role":"user","content":"Hello"}]}',
    upstream: { contentType: 'text/event-stream', body: chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }) + chunk({ choices: [{ index: 0, delta: { content: 'Hi!' }, finish_reason: null }] }) +
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + chunk({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } }) + 'data: [DONE]\n\n' },
  },
  {
    name: 'openai-responses-stream', description: 'Responses stream ending in response.completed; the reported model is an alias',
    path: '/v1/responses', request: '{"model":"gpt-x","stream":true,"input":"Hello"}',
    upstream: {
      contentType: 'text/event-stream',
      body: ev('response.created', { sequence_number: 0, response: { id: 'resp_v3', object: 'response', model: 'gpt-x-2026-09-01', status: 'in_progress', output: [] } }) +
        ev('response.output_text.delta', { sequence_number: 1, item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Hi!' }) +
        ev('response.completed', { sequence_number: 2, response: { id: 'resp_v3', object: 'response', model: 'gpt-x-2026-09-01', status: 'completed', output: [], usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 1500 }, output_tokens: 500, output_tokens_details: { reasoning_tokens: 400 }, total_tokens: 2500 } } }),
    },
  },
  {
    name: 'anthropic-messages-stream-cache-thinking', description: 'Anthropic Messages stream: thinking, ping, 5-minute and 1-hour cache writes, cache reads, cumulative message_delta usage',
    path: '/v1/messages', request: '{"model":"claude-x","max_tokens":1024,"stream":true,"thinking":{"type":"enabled","budget_tokens":512},"messages":[{"role":"user","content":"Hello"}]}',
    upstream: {
      contentType: 'text/event-stream',
      body: aStart({ input_tokens: 100, cache_creation_input_tokens: 3000, cache_read_input_tokens: 5000, cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 1000 }, output_tokens: 1 }) + ev('ping', {}) +
        ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }) + ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Greeting.' } }) +
        ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'c2lnbmF0dXJl' } }) + ev('content_block_stop', { index: 0 }) +
        ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }) + ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Hi!' } }) + ev('content_block_stop', { index: 1 }) +
        ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 100, cache_creation_input_tokens: 3000, cache_read_input_tokens: 5000, output_tokens: 200 } }) + ev('message_stop', {}),
    },
  },
  {
    name: 'openai-embeddings-model-from-request', description: 'Embeddings: no id (the sidecar generates one) and no model in the answer, so the requested model is priced (modelMatchedBy "request")',
    path: '/v1/embeddings', request: '{"model":"embed-x","input":["one","two"]}',
    upstream: { contentType: 'application/json', body: '{"object":"list","data":[{"object":"embedding","index":0,"embedding":[0.1,0.2]},{"object":"embedding","index":1,"embedding":[0.3,0.4]}],"usage":{"prompt_tokens":1000000,"total_tokens":1000000}}' },
  },
  {
    name: 'anthropic-messages-stream-failed', description: 'Anthropic Messages stream that ends in an error event: no message_stop, so complete is false and the receipt is appended; still priced from the usage reported',
    path: '/v1/messages', request: '{"model":"claude-x","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"Hello"}]}',
    upstream: { contentType: 'text/event-stream', body: aStart({ input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }, 'claude-x') + ev('ping', {}) + ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }) },
  },
  {
    name: 'openai-responses-http-error', description: 'An upstream error (HTTP 429): signed, attributable, not billable: usage and prices null, complete false',
    path: '/v1/responses', request: '{"model":"gpt-x","input":"Hello"}',
    upstream: { status: 429, contentType: 'application/json', body: '{"error":{"message":"Rate limit reached","type":"rate_limit_exceeded","param":null,"code":null}}' },
  },
]

async function generate() {
  const realNow = Date.now, realRandom = crypto.getRandomValues.bind(crypto)
  Date.now = () => NOW_MS
  crypto.getRandomValues = (b) => { b.fill(0x11); return b }
  try {
    const seen = []
    let current = null
    const p = createAIProxy({
      upstream: { baseUrl: 'https://upstream.example/v1' }, signerKey: KEY, models: AI_FIELD.models, log: () => {}, rateLimit: false,
      manifestBase: { name: 'Receipt vectors', circuits: CIRCUITS, tokenId: '11', container: CONTAINER, delegation: null, endpoints: { live: ['https://ai.example/tapeapi/v1'], async: false } },
      fetch: async (url, init) => { seen.push(new Uint8Array(init.body)); return new Response(current.upstream.body, { status: current.upstream.status ?? 200, headers: { 'content-type': current.upstream.contentType } }) },
    })
    const manifest = p.manifest()
    const cases = []
    for (const c of CASES) {
      current = c; seen.length = 0
      const res = await p.handleRequest(new Request('https://ai.example' + c.path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' }, body: c.request }), { clientIp: '127.0.0.1' })
      const bytes = new Uint8Array(await res.arrayBuffer())
      const stream = (res.headers.get('content-type') || '').includes('text/event-stream')
      const header = res.headers.get(ai.RECEIPT_HEADER)
      const envelope = stream ? ai.readSseReceipt(bytes) : ai.decodeReceiptHeader(header)
      const upReq = new TextDecoder().decode(seen[0])
      cases.push({
        name: c.name, description: c.description, method: envelope.method, path: c.path, status: res.status, stream,
        requestBase64: b64(c.request),
        ...(upReq !== c.request ? { upstreamRequestBase64: b64(upReq) } : {}),
        upstreamResponseBase64: b64(c.upstream.body),
        responseBase64: Buffer.from(bytes).toString('base64'),
        receiptDelivery: stream ? 'sse-comment' : 'header',
        expected: { requestSha256: envelope.params.requestSha256, responseSha256: envelope.result.responseSha256, result: envelope.result, envelope, encoded: stream ? ai.encodeReceipt(envelope) : header },
      })
    }
    return {
      description: 'AI usage receipt test vectors (TAPI-20 ai field, TAPI-21 envelope). Generated by sdk/test/ai-receipt-vectors.test.mjs with the real sidecar (server/src/ai-proxy.js); the signer key is a published TEST key.',
      signerKey: KEY, signer: privateKeyToAddress(KEY), container: CONTAINER, ts: Math.floor(NOW_MS / 1000),
      manifest: { container: manifest.container, signer: manifest.signer, ai: manifest.ai },
      cases,
    }
  } finally { Date.now = realNow; crypto.getRandomValues = realRandom }
}

// An independent reference for a stream's hash: the WHATWG event-stream rules over the whole text, no incremental state.
// 流哈希的独立参考实现：对整段文本按 WHATWG 规则，无增量状态。
function referenceStreamSha(text, sentinel) {
  if (text.startsWith('﻿')) text = text.slice(1)
  const lines = text.split(/\r\n|\r|\n/); lines.pop()
  const datas = []
  let data = null
  for (const line of lines) {
    if (line === '') { if (data !== null) datas.push(data.join('\n')); data = null; continue }
    if (line.startsWith(':')) continue
    const k = line.indexOf(':'), field = k < 0 ? line : line.slice(0, k)
    let v = k < 0 ? '' : line.slice(k + 1)
    if (v.startsWith(' ')) v = v.slice(1)
    if (field === 'data') (data ??= []).push(v)
  }
  return sha(Buffer.from(datas.filter((d) => d !== sentinel).map((d) => d + '\n').join(''), 'utf8'))
}

test('the vectors file is exactly what the sidecar produces today', async () => {
  const got = await generate()
  if (process.env.TAPEAPI_WRITE_VECTORS === '1') writeFileSync(FILE, JSON.stringify(got, null, 1) + '\n')
  const want = JSON.parse(readFileSync(FILE, 'utf8'))
  assert.deepEqual(got, want, 'regenerate with TAPEAPI_WRITE_VECTORS=1 only after a deliberate change to the receipt rules')
})

test('every vector: hashes recomputed independently, amounts from the table, receipt verifies and recovers to the signer', () => {
  const V = JSON.parse(readFileSync(FILE, 'utf8'))
  assert.equal(V.cases.length, 7)
  assert.deepEqual(ai.validateAIField(V.manifest.ai), V.manifest.ai, 'the manifest field is already normalised')
  for (const c of V.cases) {
    const req = unb64(c.requestBase64), res = unb64(c.responseBase64), e = c.expected
    const format = ai.formatFor('POST', c.path)
    assert.equal(e.requestSha256, sha(req), c.name)
    assert.equal(e.responseSha256, c.stream ? referenceStreamSha(Buffer.from(res).toString('utf8'), format.stream.sentinel) : sha(res), c.name)
    assert.equal(recoverResponseSigner({ container: e.envelope.container, id: e.envelope.id, method: e.envelope.method, params: e.envelope.params, ok: true, body: e.envelope.result, ts: e.envelope.ts }, e.envelope.sig), V.signer, c.name)
    const entry = ai.modelEntryOf(V.manifest.ai.models, e.result.model, format.name)
    assert.deepEqual(e.result.prices, entry && e.result.usage ? entry.prices.map((p) => ({ currency: p.currency, amount: ai.amountOf(p, e.result.usage) })) : null, c.name)
    const v = ai.verifyUsageReceipt({ envelope: e.envelope, manifest: V.manifest, requestBytes: req, responseBytes: res, stream: c.stream, path: c.path, status: c.status })
    assert.deepEqual(v.problems, [], c.name)
    if (c.receiptDelivery === 'header') assert.deepEqual(ai.decodeReceiptHeader(e.encoded), e.envelope)
    else assert.ok(Buffer.from(res).toString('utf8').includes(`: tapeapi-receipt ${e.encoded}\n`), c.name)
  }
  const byName = Object.fromEntries(V.cases.map((c) => [c.name, c.expected.result]))
  // Hand-checked amounts (per 1M tokens). / 手算核对的金额（每百万 token）。
  // chat: 200 × 1.25 + 1000 × 0.125 + 200 × 10 + 100 × 12 = 3575; BEM: 200 × 12.5 + 1000 × 1.25 + 300 × 100 = 33750.
  assert.deepEqual(byName['openai-chat-json'].prices, [{ currency: 'USDT', amount: '0.00357500' }, { currency: 'BEM', amount: '0.03375000' }])
  // anthropic: 100 × 3 + 5000 × 0.3 + 2000 × 3.75 + 1000 × 6 + 200 × 15 = 18300; USD1: 100 × 0.3 + 5000 × 0.03 + 3000 × 0.375 + 200 × 1.5 = 1605.
  assert.deepEqual(byName['anthropic-messages-stream-cache-thinking'].prices, [{ currency: 'BEM', amount: '0.01830000' }, { currency: 'USD1', amount: '0.00160500' }])
  assert.deepEqual(byName['anthropic-messages-stream-cache-thinking'].usage, { prompt_tokens: 8100, completion_tokens: 200, total_tokens: 8300, cache_read_tokens: 5000, cache_write_tokens: 3000, cache_write_1h_tokens: 1000 })
  assert.equal(byName['openai-chat-stream-usage-injected'].usageInjected, true)
  assert.deepEqual([byName['openai-embeddings-model-from-request'].model, byName['openai-embeddings-model-from-request'].modelMatchedBy], ['embed-x', 'request'])
  assert.deepEqual([byName['openai-responses-stream'].model, byName['openai-responses-stream'].modelMatchedBy], ['gpt-x-2026-09-01', 'response'])
  assert.deepEqual([byName['anthropic-messages-stream-failed'].complete, !!byName['anthropic-messages-stream-failed'].prices], [false, true])
  assert.deepEqual([byName['openai-responses-http-error'].usage, byName['openai-responses-http-error'].prices, byName['openai-responses-http-error'].complete], [null, null, false])
})
