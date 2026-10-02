// FIXED AI-INJ (adversarial review of 1.5.0, 2026-10): `usageInjected` in a receipt used to switch the client's usage
// comparison off unconditionally. A sidecar holding the service key could take an honest receipt for a whole answer, raise
// the usage, recompute the prices, add `usageInjected: true`, re-sign, and a client holding the whole body accepted it.
// The flag now counts only where the client's copy can lack the usage: a stream, of a format that injects
// (prepareUpstream), for a request that did not itself ask for usage (TAPI-21 §3.5, check 4).
// FIXED AI-INJ（1.5.0 对抗式审查）：回执里的 usageInjected 过去会无条件关掉客户端的用量比对。现在只有客户端副本可能缺用量时
// 它才算数：流式、格式会注入、且请求本身没有要用量。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as ai from '../src/ai.js'
import { createTapeAPI } from '../src/index.js'
import { signResponse } from '../src/sig.js'
import { createAIProxy } from '../../server/src/ai-proxy.js'

const KEY = '0x' + '42'.repeat(32)
const CIRCUITS = '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', CONTAINER = '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8'
const MODELS = [{ id: 'demo-chat', prices: [{ currency: 'BEM', unit: '1M tokens', input: '0.15', output: '0.6' }] }]
const V = JSON.parse(readFileSync(new URL('./fixtures/ai-receipt-vectors.json', import.meta.url), 'utf8'))
const vec = (name) => V.cases.find((c) => c.name === name)
const b64 = (s) => Buffer.from(s, 'base64')

function sidecar(answer) {
  return createAIProxy({
    upstream: { baseUrl: 'https://up.example/v1' }, signerKey: KEY, models: MODELS, log: () => {},
    manifestBase: { name: 'AI', circuits: CIRCUITS, tokenId: '11', container: CONTAINER, delegation: null, dev: true, endpoints: { live: ['https://ai.example/tapeapi/v1'], async: false } },
    fetch: async (url, init) => answer(url, init),
  })
}
const post = (p, body) => p.handleRequest(new Request('https://ai.example/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body }), { clientIp: '1.1.1.1' })
const WHOLE = JSON.stringify({ id: 'chatcmpl-inj1', object: 'chat.completion', model: 'demo-chat', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
const json = (s) => new Response(s, { status: 200, headers: { 'content-type': 'application/json' } })
const sse = (s) => new Response(s, { status: 200, headers: { 'content-type': 'text/event-stream' } })
// Edit a receipt's result and re-sign it with the right key (what the operator of a sidecar can do). / 改 result 后用正确密钥重签。
function resign(env, patch, key = KEY, manifest) {
  const result = { ...env.result, ...patch }
  for (const k of Object.keys(result)) if (result[k] === undefined) delete result[k]
  if (manifest && result.usage) result.prices = ai.pricingOf(manifest.ai.models, { reported: result.model, usage: result.usage, format: ai.formatOfMethod(env.method).name }).prices
  return { ...env, result, sig: signResponse({ container: env.container, id: env.id, method: env.method, params: env.params, ok: true, body: result, ts: env.ts }, key) }
}
const INFLATED = { prompt_tokens: 1_000_010, completion_tokens: 5, total_tokens: 1_000_015 }
const usageUnchecked = (r) => r.unchecked.some((x) => /^usage/.test(x))

test('FIXED AI-INJ: a whole answer is always compared: usage raised, prices recomputed, usageInjected added and re-signed fails', async () => {
  const p = sidecar(() => json(WHOLE))
  const req = '{"model":"demo-chat","messages":[{"role":"user","content":"hi"}]}'
  const res = await post(p, req)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const honest = ai.decodeReceiptHeader(res.headers.get(ai.RECEIPT_HEADER))
  const m = p.manifest()
  const check = (env, more = {}) => ai.verifyUsageReceipt({ envelope: env, manifest: m, requestBytes: req, responseBytes: bytes, stream: false, path: '/v1/chat/completions', status: 200, ...more })
  assert.deepEqual(check(honest).problems, [])
  const forged = resign(honest, { usage: INFLATED, usageInjected: true }, KEY, m)
  assert.notDeepEqual(forged.result.prices, honest.result.prices, 'the prices follow the raised usage')
  const r = check(forged)
  assert.equal(r.ok, false)
  assert.match(r.problems.join(' | '), /the receipt says usage .*1000010.*but the answer reports .*"prompt_tokens":10/)
  assert.ok(!usageUnchecked(r), r.unchecked.join())
  // Without the request bytes too: a whole answer has nothing taken out of it. / 没有请求字节也一样。
  assert.match(check(forged, { requestBytes: undefined }).problems.join(), /but the answer reports/)
  // The same through the verifying fetch. / 经由核验 fetch 也一样。
  const svc = await createTapeAPI({ dev: true }).resolve({ dev: structuredClone(m) })
  const reports = []
  const vf = ai.createVerifyingFetch({ service: svc, strict: false, salt: false, onReport: (x) => reports.push(x), fetch: async () => {
    const h = new Headers(res.headers); h.set(ai.RECEIPT_HEADER, ai.encodeReceipt(forged)); return new Response(bytes, { status: 200, headers: h })
  } })
  await (await vf('https://ai.example/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: req })).arrayBuffer()
  assert.equal(reports[0].ok, false)
  assert.match(reports[0].problems.join(), /but the answer reports/)
})

test('AI-INJ: the honest sidecar\'s receipt for a stream request answered as JSON (usageInjected on a whole answer) still verifies, usage compared', async () => {
  let sent = null
  const p = sidecar((url, init) => { sent = JSON.parse(Buffer.from(init.body).toString()); return json(WHOLE) })
  const req = '{"model":"demo-chat","stream":true,"messages":[{"role":"user","content":"hi"}]}'
  const res = await post(p, req)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const env = ai.decodeReceiptHeader(res.headers.get(ai.RECEIPT_HEADER))
  assert.deepEqual(sent.stream_options, { include_usage: true }, 'the sidecar asked the upstream for usage')
  assert.deepEqual([env.result.stream, env.result.usageInjected], [false, true])
  assert.deepEqual(env.result.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
  const m = p.manifest()
  const r = ai.verifyUsageReceipt({ envelope: env, manifest: m, requestBytes: req, responseBytes: bytes, stream: false, path: '/v1/chat/completions', status: 200 })
  assert.deepEqual([r.ok, r.problems], [true, []])
  assert.ok(!usageUnchecked(r), r.unchecked.join())
  // Through the verifying fetch, end to end. / 经由核验 fetch，端到端。
  const svc = await createTapeAPI({ dev: true }).resolve({ dev: structuredClone(m) })
  const reports = []
  const vf = ai.createVerifyingFetch({ service: svc, strict: true, salt: false, onReport: (x) => reports.push(x), fetch: (u, i) => post(p, i.body) })
  await (await vf('https://ai.example/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: req })).arrayBuffer()
  assert.deepEqual([reports[0].ok, reports[0].problems], [true, []])
})

test('AI-INJ: an injected stream (the client did not ask for usage) verifies with the usage listed as not checked; without request bytes too', () => {
  const c = vec('openai-chat-stream-usage-injected')
  const base = { envelope: c.expected.envelope, manifest: V.manifest, responseBytes: b64(c.responseBase64), stream: true }
  const r = ai.verifyUsageReceipt({ ...base, requestBytes: b64(c.requestBase64) })
  assert.deepEqual(r.problems, [])
  assert.ok(usageUnchecked(r))
  const noReq = ai.verifyUsageReceipt(base)
  assert.deepEqual(noReq.problems, [])
  assert.ok(usageUnchecked(noReq) && noReq.unchecked.includes('request'), noReq.unchecked.join())
})

test('FIXED AI-INJ: a stream whose request already asked for usage, or of a format that never injects, cannot claim usageInjected', async () => {
  const chunk = (o) => `data: ${JSON.stringify({ id: 'chatcmpl-s1', object: 'chat.completion.chunk', model: 'demo-chat', ...o })}\n\n`
  const stream = chunk({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }) + chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + 'data: [DONE]\n\n'
  const p = sidecar(() => sse(stream))
  const req = '{"model":"demo-chat","stream":true,"stream_options":{"include_usage":true},"messages":[]}'
  const bytes = new Uint8Array(await (await post(p, req)).arrayBuffer())
  const honest = ai.readSseReceipt(bytes)
  const m = p.manifest()
  assert.equal(honest.result.usageInjected, undefined)
  const check = (env) => ai.verifyUsageReceipt({ envelope: env, manifest: m, requestBytes: req, responseBytes: bytes, stream: true })
  assert.deepEqual(check(honest).problems, [])
  const r = check(resign(honest, { usage: INFLATED, usageInjected: true }, KEY, m))
  assert.match(r.problems.join(' | '), /usageInjected, but the request already asked for the usage/)
  assert.match(r.problems.join(' | '), /the receipt says usage .*1000010.*but the answer reports/)
  assert.ok(!usageUnchecked(r))
  // The flag alone (usage untouched) is still a problem: an honest sidecar never sets it here. / 只加标记也是问题。
  assert.match(check(resign(honest, { usageInjected: true })).problems.join(), /already asked for the usage/)
  // Anthropic Messages has no prepareUpstream: its streams always carry their usage. / Anthropic 没有 prepareUpstream。
  const a = vec('anthropic-messages-stream-cache-thinking')
  const ae = a.expected.envelope
  const forged = resign(ae, { usage: { ...ae.result.usage, completion_tokens: 2000, total_tokens: 10100 }, usageInjected: true }, V.signerKey, V.manifest)
  const ar = ai.verifyUsageReceipt({ envelope: forged, manifest: V.manifest, requestBytes: b64(a.requestBase64), responseBytes: b64(a.responseBase64), stream: true })
  assert.match(ar.problems.join(' | '), /anthropic-messages never injects/)
  assert.match(ar.problems.join(' | '), /but the answer reports/)
})

test('AI-INJ: answerProblems is the one check 4 for the SDK and the verify page', () => {
  const c = vec('openai-chat-json')
  const env = c.expected.envelope
  const format = ai.formatOfMethod(env.method)
  const read = format.response(JSON.parse(b64(c.responseBase64).toString()))
  assert.deepEqual(ai.answerProblems({ envelope: env, read, format }), { problems: [], unchecked: [] })
  const flagged = { ...env, result: { ...env.result, usageInjected: true, usage: INFLATED } }
  assert.match(ai.answerProblems({ envelope: flagged, read, format }).problems.join(), /but the answer reports/)
})

// FIXED AI-WHOLE (review of c4cd6c1): a verifier with no content type of its own trusted the receipt's own `stream`. A whole
// JSON answer (to a stream request the client made without include_usage) under a receipt re-signed as stream: true with
// usageInjected, raised usage, its responseSha256 recomputed by the stream rule over those bytes, was read as a stream
// that carries no usage, and the usage went unchecked. / 没有自己 content-type 的核验方只信回执自称的 stream：整段 JSON
// 回答配上改签为流、带 usageInjected 的回执，会被当作没有用量的流读，用量不被核对。
async function relabelled() {
  const p = sidecar(() => json(WHOLE + '\n\n'))
  const req = '{"model":"demo-chat","stream":true,"messages":[{"role":"user","content":"hi"}]}'
  const res = await post(p, req)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const honest = ai.decodeReceiptHeader(res.headers.get(ai.RECEIPT_HEADER))
  const format = ai.formatOfMethod(honest.method)
  const scanned = ai.scanSse(bytes, { format })
  const forged = resign(honest, { stream: true, usageInjected: true, usage: INFLATED, responseSha256: scanned.responseSha256, complete: ai.completeOf({ status: 200, stream: true, read: scanned }), modelMatchedBy: 'request' }, KEY, p.manifest())
  return { p, req, bytes, honest, forged, manifest: p.manifest() }
}
test('FIXED AI-WHOLE: a receipt that calls a whole JSON answer a stream is refused when the verifier was not told `stream`', async () => {
  const { req, bytes, honest, forged, manifest } = await relabelled()
  assert.equal(honest.result.stream, false)
  assert.deepEqual(ai.verifyUsageReceipt({ envelope: honest, manifest, requestBytes: req, responseBytes: bytes }).problems, [], 'the honest receipt')
  const r = ai.verifyUsageReceipt({ envelope: forged, manifest, requestBytes: req, responseBytes: bytes })
  assert.equal(r.ok, false)
  assert.match(r.problems.join(' | '), /the receipt says the answer was a stream, but the response is one whole JSON value/)
  assert.match(ai.verifyUsageReceipt({ envelope: forged, manifest, responseBytes: bytes }).problems.join(), /one whole JSON value/, 'without the request too')
  assert.match(ai.verifyUsageReceipt({ envelope: forged, manifest, requestBytes: req, responseBytes: bytes, stream: false }).problems.join(), /the response was not a stream/, 'told the truth: as before')
  for (const tail of ['', '\n', '\r\n\r\n', ' \t ']) assert.equal(ai.isWholeJson(new TextEncoder().encode(WHOLE + tail)), true, JSON.stringify(tail))
  // Real streams are never whole JSON. / 真实的流绝不是整段 JSON。
  for (const c of V.cases.filter((x) => x.stream)) {
    assert.equal(ai.isWholeJson(b64(c.responseBase64)), false, c.name)
    assert.deepEqual(ai.verifyUsageReceipt({ envelope: c.expected.envelope, manifest: V.manifest, requestBytes: b64(c.requestBase64), responseBytes: b64(c.responseBase64) }).problems, [], c.name)
  }
  assert.equal(ai.isWholeJson(new TextEncoder().encode('data: {"a":1}\n\n')), false)
})
