// The decisions taken to freeze the `ai` manifest field and the usage receipt (2026-09-28), end to end through the
// sidecar: model entries with aliases and one price per currency; the reported model matched first, the requested one
// only when none was reported (modelMatchedBy); `prices` per currency; `complete` false for a stream that never reached
// its final success event (still priced); Anthropic's 1-hour cache writes; POST /v1/responses/compact metered as
// openai_responses; the new limits (32 MiB requests, 600 s non-stream, a stream silent for 300 s ended there).
// 为冻结 ai 清单字段与用量回执所作的决定，经由旁路端到端检验。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAIProxy, REQUEST_LIMIT, AI_UPSTREAM_TIMEOUT_MS, STREAM_IDLE_MS } from '../src/ai-proxy.js'
import { ai } from '@tapeapi/sdk'

const KEY = '0x' + '42'.repeat(32)
const BASE = 'https://ai.example'
const UP = 'https://upstream.example/v1'
const pr = (currency, input, output, extra = {}) => ({ currency, unit: '1M tokens', input, output, ...extra })
const MODELS = [
  { id: 'claude-x', aliases: ['claude-x-20260901'], formats: ['anthropic-messages'], prices: [pr('BEM', '3', '15', { cacheRead: '0.3', cacheWrite: '3.75', cacheWrite1h: '6' }), pr('USD1', '0.3', '1.5')] },
  { id: 'gpt-x', formats: ['openai-chat', 'openai-responses'], prices: [pr('USDT', '1', '4')] },
  { id: 'embed-x', formats: ['openai-embeddings'], prices: [pr('BEM', '0.02', '0'), pr('USDC', '0.002', '0')] },
]
const manifestBase = () => ({ name: 'Freeze', circuits: '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', tokenId: '11', container: '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8', delegation: null, endpoints: { live: [`${BASE}/tapeapi/v1`], async: false } })
const te = new TextEncoder()
const make = (answer, extra = {}) => createAIProxy({ upstream: { baseUrl: UP }, manifestBase: manifestBase(), signerKey: KEY, models: MODELS, log: () => {}, rateLimit: false, fetch: async (url, init) => answer(url, init), ...extra })
const post = (p, path, body, headers = {}) => p.handleRequest(new Request(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }), { clientIp: '1.1.1.1' })
const sse = (text) => new Response(text, { headers: { 'content-type': 'text/event-stream' } })
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
const ev = (name, o) => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...o })}\n\n`
async function streamed(p, path, body, headers) {
  const res = await post(p, path, body, headers)
  const out = await res.text()
  const env = ai.readSseReceipt(out)
  return { out, env, v: ai.verifyUsageReceipt({ envelope: env, manifest: p.manifest(), requestBytes: body, responseBytes: out, stream: true, path, status: res.status }) }
}

test('the new defaults: 32 MiB requests, 600 s for a non-stream answer, a stream silent for 300 s is ended', () => {
  assert.equal(REQUEST_LIMIT, 32 * 1024 * 1024)
  assert.equal(AI_UPSTREAM_TIMEOUT_MS, 600_000)
  assert.equal(STREAM_IDLE_MS, 300_000)
})

test('Anthropic: 5-minute and 1-hour cache writes priced apart, an alias matched, one amount per currency', async () => {
  const start = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-x-20260901', content: [], usage: { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 400 }, output_tokens: 1 } }
  const text = ev('message_start', { message: start }) + ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }) +
    ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } }) + ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'c2ln' } }) + ev('content_block_stop', { index: 0 }) +
    ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2000, output_tokens: 50 } }) + ev('message_stop', {})
  const p = make(() => sse(text))
  const { env, v } = await streamed(p, '/v1/messages', '{"model":"claude-x","stream":true,"max_tokens":9,"messages":[]}', { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' })
  assert.deepEqual(v.problems, []); assert.deepEqual(v.warnings, [], 'the alias is the same model: no "asked for X, reported Y"')
  assert.deepEqual(env.result.usage, { prompt_tokens: 3100, completion_tokens: 50, total_tokens: 3150, cache_read_tokens: 2000, cache_write_tokens: 1000, cache_write_1h_tokens: 400 })
  // BEM: 100 × 3 + 2000 × 0.3 + 600 × 3.75 + 400 × 6 + 50 × 15 = 6300; USD1: (3100 × 0.3 + 50 × 1.5) = 1005, cache at input.
  assert.deepEqual(env.result.prices, [{ currency: 'BEM', amount: '0.00630000' }, { currency: 'USD1', amount: '0.00100500' }])
  assert.deepEqual([env.result.model, env.result.modelMatchedBy, env.result.complete], ['claude-x-20260901', 'response', true])
})

test('complete: false for a stream that never reached its final success event, and it is still priced from the usage it reported', async () => {
  // Anthropic: an error event after message_start (Claude Code retries this without streaming). / Anthropic：message_start 之后的错误事件。
  const a = ev('message_start', { message: { id: 'msg_2', model: 'claude-x', usage: { input_tokens: 10, output_tokens: 1 } } }) + ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } })
  let r = await streamed(make(() => sse(a)), '/v1/messages', '{"model":"claude-x","stream":true}')
  assert.deepEqual(r.v.problems, [])
  assert.deepEqual([r.env.result.complete, r.env.result.prices], [false, [{ currency: 'BEM', amount: '0.00004500' }, { currency: 'USD1', amount: '0.00000450' }]])
  assert.match(r.v.warnings.join(), /did not complete/)
  // Responses: response.incomplete is the final event, not a success. / Responses：response.incomplete 是最终事件，但不是成功。
  const base = { id: 'resp_3', object: 'response', model: 'gpt-x' }
  const b = ev('response.created', { response: { ...base, status: 'in_progress' } }) + ev('response.incomplete', { response: { ...base, status: 'incomplete', usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 } } })
  r = await streamed(make(() => sse(b)), '/v1/responses', '{"model":"gpt-x","stream":true}')
  assert.deepEqual(r.v.problems, [])
  assert.deepEqual([r.env.result.complete, r.env.result.prices], [false, [{ currency: 'USDT', amount: '0.00003300' }]])
  // Responses: response.completed. / Responses：response.completed。
  const c = ev('response.created', { response: { ...base, status: 'in_progress' } }) + ev('response.completed', { response: { ...base, status: 'completed', usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 } } })
  r = await streamed(make(() => sse(c)), '/v1/responses', '{"model":"gpt-x","stream":true}')
  assert.equal(r.env.result.complete, true)
  // Chat: no finish_reason before [DONE]. / Chat：[DONE] 之前没有 finish_reason。
  const chunk = (o) => `data: ${JSON.stringify({ id: 'c-4', model: 'gpt-x', ...o })}\n\n`
  const d = chunk({ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] }) + chunk({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }) + 'data: [DONE]\n\n'
  r = await streamed(make(() => sse(d)), '/v1/chat/completions', '{"model":"gpt-x","stream":true,"stream_options":{"include_usage":true}}')
  assert.deepEqual(r.v.problems, [])
  assert.deepEqual([r.env.result.complete, r.env.result.prices], [false, [{ currency: 'USDT', amount: '0.00000600' }]])
  const e = chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + chunk({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }) + 'data: [DONE]\n\n'
  r = await streamed(make(() => sse(e)), '/v1/chat/completions', '{"model":"gpt-x","stream":true,"stream_options":{"include_usage":true}}')
  assert.equal(r.env.result.complete, true)
  // A tampered `complete` does not verify against the stream: it is signed. / 篡改 complete 不能通过：它是签过名的。
  const forged = { ...r.env, result: { ...r.env.result, complete: false } }
  assert.match(ai.verifyUsageReceipt({ envelope: forged, manifest: make(() => sse(e)).manifest(), responseBytes: r.out }).problems.join(), /signed by|complete/)
})

test('no model reported: the requested model is matched and named, modelMatchedBy "request"; a reported model always wins', async () => {
  const p = make((url) => json({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1] }], usage: { prompt_tokens: 1000, total_tokens: 1000 } }))
  const body = '{"model":"embed-x","input":"hello"}'
  const res = await post(p, '/v1/embeddings', body)
  const bytes = await res.text()
  const env = ai.decodeReceiptHeader(res.headers.get(ai.RECEIPT_HEADER))
  assert.deepEqual([env.result.model, env.result.modelMatchedBy, env.result.prices], ['embed-x', 'request', [{ currency: 'BEM', amount: '0.00002000' }, { currency: 'USDC', amount: '0.00000200' }]])
  assert.deepEqual(ai.verifyUsageReceipt({ envelope: env, manifest: p.manifest(), requestBytes: body, responseBytes: bytes, stream: false }).problems, [])
  // Reported but unlisted: not priced, even though the request asked for a listed model. / 上游报了未列出的模型：不计价。
  const p2 = make(() => json({ model: 'embed-y', data: [], usage: { prompt_tokens: 1000, total_tokens: 1000 } }))
  const env2 = ai.decodeReceiptHeader((await post(p2, '/v1/embeddings', body)).headers.get(ai.RECEIPT_HEADER))
  assert.deepEqual([env2.result.model, env2.result.modelMatchedBy, env2.result.prices], ['embed-y', undefined, null])
})

test('POST /v1/responses/compact (Codex\'s conversation compaction) is metered as openai_responses', async () => {
  const seen = []
  const p = make((url) => { seen.push(url); return json({ id: 'resp_c', object: 'response.compaction', model: 'gpt-x', output: [], usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 } }) })
  const body = '{"model":"gpt-x","input":[]}'
  const res = await post(p, '/v1/responses/compact', body, { authorization: 'Bearer k' })
  assert.equal(seen[0], `${UP}/responses/compact`)
  const env = ai.decodeReceiptHeader(res.headers.get(ai.RECEIPT_HEADER))
  assert.deepEqual([env.method, env.params.path, env.result.prices], ['openai_responses', '/v1/responses/compact', [{ currency: 'USDT', amount: '0.00140000' }]])
  assert.deepEqual(ai.verifyUsageReceipt({ envelope: env, manifest: p.manifest(), requestBytes: body, responseBytes: await res.text(), path: '/v1/responses/compact' }).problems, [])
  assert.equal(ai.formatFor('POST', '/v1/responses/compact').method, 'openai_responses')
  assert.equal(ai.formatFor('GET', '/v1/responses/compact'), null)
  assert.equal(ai.formatFor('POST', '/v1/responses/other'), null)
})

test('a stream the upstream leaves silent for streamIdleMs ends there: receipt appended, complete false, the upstream cancelled', async () => {
  let cancelled = false
  const first = te.encode(ev('response.created', { response: { id: 'resp_i', model: 'gpt-x', status: 'in_progress' } }))
  const p = make(() => new Response(new ReadableStream({
    start(c) { c.enqueue(first) },
    pull() { return new Promise(() => {}) },   // never another byte / 再也没有字节
    cancel() { cancelled = true },
  }), { headers: { 'content-type': 'text/event-stream' } }), { streamIdleMs: 60 })
  const t0 = Date.now()
  const { out, env, v } = await streamed(p, '/v1/responses', '{"model":"gpt-x","stream":true}')
  assert.ok(Date.now() - t0 < 5000)
  assert.ok(out.startsWith(new TextDecoder().decode(first)))
  assert.match(out, /: tapeapi-receipt [A-Za-z0-9_-]+\n$/)
  assert.deepEqual(v.problems, [])
  assert.deepEqual([env.result.complete, env.result.prices], [false, null])
  assert.equal(cancelled, true)
  assert.equal(p.stats().idleTimeouts, 1)
  assert.throws(() => make(() => sse(''), { streamIdleMs: -1 }), /streamIdleMs/)
})

test('a compressed request body (Codex zstd) passes through untouched with its content-encoding; the receipt hashes the bytes as sent', async () => {
  const body = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3, 4, 250, 251])   // not JSON: nothing is injected / 不是 JSON：不注入任何东西
  let seen = null
  const base = { id: 'resp_z', object: 'response', model: 'gpt-x' }
  const p = make(async (url, init) => {
    seen = { enc: new Headers(init.headers).get('content-encoding'), bytes: new Uint8Array(await new Response(init.body).arrayBuffer()) }
    return sse(ev('response.created', { response: { ...base, status: 'in_progress' } }) + ev('response.completed', { response: { ...base, status: 'completed', usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } }))
  })
  const res = await post(p, '/v1/responses', body, { 'content-encoding': 'zstd', authorization: 'Bearer k' })
  const out = await res.text()
  assert.equal(seen.enc, 'zstd', 'content-encoding forwarded')
  assert.deepEqual([...seen.bytes], [...body], 'request bytes untouched')
  const env = ai.readSseReceipt(out)
  const v = ai.verifyUsageReceipt({ envelope: env, manifest: p.manifest(), requestBytes: body, responseBytes: out, stream: true, path: '/v1/responses', status: res.status })
  assert.deepEqual(v.problems, [])
  assert.equal(env.result.model, 'gpt-x')
  assert.equal(env.result.usageInjected, undefined)
})
