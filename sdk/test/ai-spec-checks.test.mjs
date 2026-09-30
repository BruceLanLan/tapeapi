// The client checks of TAPI-21 §3.5 and the resolve rules of TAPI-20 §3.9, as the spec states them (2026-09-28):
// - the answer's id is compared with the receipt's only when it is one the sidecar would use (1 to 128 characters in
//   U+0021–U+007E); an envelope id is at most 128 characters;
// - holding the answer, the client re-reads model, usage and complete from it with the format's own adapter and requires
//   the receipt to say the same (the usage cannot be compared when usageInjected is set: reported as not made);
// - a check that could not be made is listed in `unchecked`, never passed;
// - an invalid `ai` field is dropped on resolve (svc.aiProblems) without failing the rest of the manifest, and the
//   verifying fetch uses only validated endpoints;
// - an answer the sidecar made itself (x-tapeapi-sidecar-error) is a transport failure (PROVIDER_UNAVAILABLE, or
//   RATE_LIMITED for its 429), not RECEIPT_INVALID, and never a verified answer.
// TAPI-21 §3.5 的客户端检查与 TAPI-20 §3.9 的解析规则，按规范原文逐条检验。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import * as ai from '../src/ai.js'
import { createTapeAPI } from '../src/index.js'
import { signResponse, privateKeyToAddress } from '../src/sig.js'
import { createAIProxy } from '../../server/src/ai-proxy.js'

const KEY = '0x' + '42'.repeat(32)
const CIRCUITS = '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', CONTAINER = '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8'
const sha = (b) => createHash('sha256').update(b).digest('hex')
const pr = (currency, input, output) => ({ currency, unit: '1M tokens', input, output })
const MODELS = [{ id: 'demo-chat', prices: [pr('BEM', '0.15', '0.6')] }, { id: 'other-chat', prices: [pr('BEM', '1', '1')] }]
const V = JSON.parse(readFileSync(new URL('./fixtures/ai-receipt-vectors.json', import.meta.url), 'utf8'))
const vec = (name) => V.cases.find((c) => c.name === name)
const b = (s) => Buffer.from(s, 'base64')

function sidecar(answer, extra = {}) {
  return createAIProxy({
    upstream: { baseUrl: 'https://up.example/v1' }, signerKey: KEY, models: MODELS, log: () => {},
    manifestBase: { name: 'AI', circuits: CIRCUITS, tokenId: '11', container: CONTAINER, delegation: null, dev: true, endpoints: { live: ['https://ai.example/tapeapi/v1'], async: false } },
    fetch: async (url, init) => answer(url, init), ...extra,
  })
}
const post = (p, body, path = '/v1/chat/completions') => p.handleRequest(new Request('https://ai.example' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body }), { clientIp: '1.1.1.1' })
const json = (o, status = 200) => new Response(typeof o === 'string' ? o : JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
// Re-sign a receipt after editing its result: the right key, a result that disagrees with the bytes. / 改动 result 后以正确密钥重签。
function resign(env, patch) {
  const result = { ...env.result, ...patch }
  for (const k of Object.keys(result)) if (result[k] === undefined) delete result[k]
  return { ...env, result, sig: signResponse({ container: env.container, id: env.id, method: env.method, params: env.params, ok: true, body: result, ts: env.ts }, KEY) }
}

test('id: an answer id the sidecar would not use (a space, over 128 characters) is not compared; an envelope id is at most 128 characters', async () => {
  for (const id of ['a b', 'x'.repeat(129), 'ünï']) {
    const p = sidecar(() => json({ id, model: 'demo-chat', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    const res = await post(p, '{"model":"demo-chat"}')
    const bytes = await res.text()
    const env = ai.decodeReceiptHeader(res.headers.get(ai.RECEIPT_HEADER))
    assert.match(env.id, /^tapeapi-[0-9a-f]{24}$/, 'the sidecar generated an id')
    assert.deepEqual(ai.verifyUsageReceipt({ envelope: env, manifest: p.manifest(), requestBytes: '{"model":"demo-chat"}', responseBytes: bytes }).problems, [], JSON.stringify(id))
  }
  // A usable answer id must still match. / 可用的回答 id 仍须一致。
  const p = sidecar(() => json({ id: 'chatcmpl-9', model: 'demo-chat', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  const res = await post(p, '{"model":"demo-chat"}')
  const bytes = await res.text()
  const env = ai.decodeReceiptHeader(res.headers.get(ai.RECEIPT_HEADER))
  assert.match(ai.verifyUsageReceipt({ envelope: env, manifest: p.manifest(), responseBytes: bytes.replace('chatcmpl-9', 'chatcmpl-8') }).problems.join(), /response's id is chatcmpl-8/)
  assert.ok(ai.envelopeProblems({ ...env, id: 'x'.repeat(129) }).some((x) => /^id /.test(x)), 'an envelope id over 128 characters')
  assert.deepEqual(ai.envelopeProblems({ ...env, id: 'x'.repeat(128) }), [])
})

test('holding the answer, model, usage and complete are re-read from it and must match the receipt, even re-signed by the right key', async () => {
  const body = '{"model":"demo-chat","messages":[]}'
  const answer = '{"id":"chatcmpl-1","model":"demo-chat","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}'
  const p = sidecar(() => json(answer))
  const res = await post(p, body)
  const env = ai.decodeReceiptHeader(res.headers.get(ai.RECEIPT_HEADER))
  const m = p.manifest()
  const check = (e) => ai.verifyUsageReceipt({ envelope: e, manifest: m, requestBytes: body, responseBytes: answer, stream: false })
  assert.deepEqual(check(env).problems, [])
  assert.deepEqual(check(env).unchecked, ['freshness'])
  // Another listed model, priced right for it: signed by the right key, but not what the answer says. / 另一个模型，按它正确计价。
  const otherModel = resign(env, { model: 'other-chat', prices: [{ currency: 'BEM', amount: '0.00003000' }] })
  assert.match(check(otherModel).problems.join(' | '), /model other-chat, but the answer reports demo-chat/)
  // More tokens, priced right for them. / 更多 token，按它们正确计价。
  const moreTokens = resign(env, { usage: { prompt_tokens: 10, completion_tokens: 21, total_tokens: 31 }, prices: [{ currency: 'BEM', amount: '0.00001410' }] })
  assert.match(check(moreTokens).problems.join(' | '), /usage .* but the answer reports/)
  const noUsage = resign(env, { usage: null, prices: null })
  assert.match(check(noUsage).problems.join(' | '), /usage null, but the answer reports/)
  // The answer reports no model: null, unless it was priced as the requested model. / 回答没报模型：为 null，除非按请求模型计价。
  const noModel = '{"id":"chatcmpl-2","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}'
  const p2 = sidecar(() => json(noModel))
  const env2 = ai.decodeReceiptHeader((await post(p2, body)).headers.get(ai.RECEIPT_HEADER))
  assert.deepEqual([env2.result.model, env2.result.modelMatchedBy], ['demo-chat', 'request'])
  assert.deepEqual(ai.verifyUsageReceipt({ envelope: env2, manifest: p2.manifest(), requestBytes: body, responseBytes: noModel }).problems, [])
  const claimed = resign(env2, { model: 'other-chat', modelMatchedBy: undefined, prices: null })
  assert.match(ai.verifyUsageReceipt({ envelope: claimed, manifest: p2.manifest(), responseBytes: noModel }).problems.join(), /model other-chat, but the answer reports none/)
})

test('streams: the adapter\'s reading of the bytes; with usageInjected the usage cannot be compared and is listed as not checked', () => {
  for (const c of V.cases) {
    const r = ai.verifyUsageReceipt({ envelope: c.expected.envelope, manifest: V.manifest, requestBytes: b(c.requestBase64), responseBytes: b(c.responseBase64), stream: c.stream })
    assert.deepEqual(r.problems, [], c.name)
    if (c.expected.result.usageInjected) assert.ok(r.unchecked.some((x) => /^usage/.test(x)), `${c.name}: ${r.unchecked}`)
    else assert.ok(!r.unchecked.some((x) => /^usage/.test(x)), c.name)
  }
  // A stream receipt whose usage was edited and re-signed. / 用量被改后重签的流回执。
  const c = vec('anthropic-messages-stream-cache-thinking')
  const edited = { ...c.expected.envelope, result: { ...c.expected.envelope.result, usage: { ...c.expected.envelope.result.usage, completion_tokens: 199, total_tokens: 8299 } } }
  const key = V.signerKey
  edited.result.prices = V.manifest.ai.models[1].prices.map((p) => ({ currency: p.currency, amount: ai.amountOf(p, edited.result.usage) }))
  edited.sig = signResponse({ container: edited.container, id: edited.id, method: edited.method, params: edited.params, ok: true, body: edited.result, ts: edited.ts }, key)
  const r = ai.verifyUsageReceipt({ envelope: edited, manifest: V.manifest, responseBytes: b(c.responseBase64) })
  assert.match(r.problems.join(' | '), /usage .* but the answer reports/)
  // Only a hash: nothing to re-read, and it says so; an `answer` can be given instead. / 只有哈希：无从重读并如实列出；可改传 answer。
  const e = vec('openai-responses-stream').expected
  const onlyHash = ai.verifyUsageReceipt({ envelope: e.envelope, manifest: V.manifest, responseSha256: e.responseSha256 })
  assert.deepEqual(onlyHash.problems, [])
  assert.ok(['id', 'model', 'usage', 'complete'].every((k) => onlyHash.unchecked.includes(k)), onlyHash.unchecked.join())
  const read = ai.scanSse(b(vec('openai-responses-stream').responseBase64), { format: ai.formatFor('POST', '/v1/responses') })
  const withAnswer = ai.verifyUsageReceipt({ envelope: e.envelope, manifest: V.manifest, responseSha256: e.responseSha256, answer: read })
  assert.deepEqual([withAnswer.problems, withAnswer.unchecked.filter((k) => ['id', 'model', 'usage', 'complete'].includes(k))], [[], []])
  assert.match(ai.verifyUsageReceipt({ envelope: e.envelope, manifest: V.manifest, responseSha256: e.responseSha256, answer: { ...read, model: 'gpt-y' } }).problems.join(), /the answer reports gpt-y/)
})

test('resolve: an invalid ai field is dropped with svc.aiProblems, the rest of the manifest stays usable; the verifying fetch uses only validated endpoints', async () => {
  const p = sidecar(() => json('{}'))
  const good = p.manifest()
  const api = createTapeAPI({ dev: true })
  const ok = await api.resolve({ dev: structuredClone(good) })
  assert.equal(ok.aiProblems, undefined)
  assert.deepEqual(ok.manifest.ai, good.ai)
  const bad = structuredClone(good); bad.ai.models = []
  const svc = await api.resolve({ dev: bad })
  assert.equal(svc.manifest.ai, undefined, 'dropped')
  assert.match(svc.aiProblems.join(), /models must hold 1 to 256/)
  assert.equal(svc.manifest.name, 'AI'); assert.equal(svc.manifest.signer, good.signer)
  await assert.rejects(ai.createVerifyingFetch({ service: svc, fetch: () => assert.fail('nothing is sent') })('https://ai.example/v1/chat/completions', { method: 'POST', body: '{}' }),
    (e) => e.code === 'MANIFEST_INVALID' && /models must hold/.test(e.message))
  // A raw manifest handed straight to the verifying fetch is validated too. / 直接交给核验 fetch 的原始清单同样要校验。
  await assert.rejects(ai.createVerifyingFetch({ service: { manifest: bad, container: CONTAINER, verified: { dev: true } }, fetch: () => assert.fail('nothing is sent') })('https://ai.example/v1/chat/completions', { method: 'POST', body: '{}' }),
    (e) => e.code === 'MANIFEST_INVALID')
  // An endpoint whose baseUrl lacks its format's suffix is ignored: its requests pass through unverified. / 缺少后缀的端点被忽略。
  const noSuffix = structuredClone(good); noSuffix.ai.endpoints = noSuffix.ai.endpoints.map((e) => (e.format === 'openai-chat' ? { ...e, baseUrl: 'https://other.example' } : e))
  const sent = []
  const vf = ai.createVerifyingFetch({ service: { manifest: noSuffix, container: CONTAINER, verified: { dev: true } }, fetch: async (u) => { sent.push(u); return json('{}') }, onReport: () => assert.fail('not a verified endpoint') })
  await vf('https://other.example/v1/chat/completions', { method: 'POST', body: '{}' })
  assert.equal(sent.length, 1)
})

test('an error the sidecar made itself is marked, and the verifying fetch reports it as PROVIDER_UNAVAILABLE (RATE_LIMITED for 429), never as a verified answer', async () => {
  const down = sidecar(() => { throw new Error('connect ECONNREFUSED') })
  const svc = { manifest: down.manifest(), container: CONTAINER, verified: { dev: true } }
  const through = (px) => (u, i) => px.handleRequest(new Request(u, i), { clientIp: '1.1.1.1' })
  const res = await post(down, '{"model":"demo-chat"}')
  assert.equal(res.status, 502)
  assert.equal(res.headers.get('x-tapeapi-sidecar-error'), '1')
  assert.match(res.headers.get('access-control-expose-headers'), /x-tapeapi-sidecar-error/)
  assert.equal(res.headers.get(ai.RECEIPT_HEADER), null)
  await assert.rejects(ai.createVerifyingFetch({ service: svc, fetch: through(down) })('https://ai.example/v1/chat/completions', { method: 'POST', body: '{"model":"demo-chat"}' }), (e) => e.code === 'PROVIDER_UNAVAILABLE' && /502/.test(e.message))
  const reports = []
  const lax = await ai.createVerifyingFetch({ service: svc, fetch: through(down), strict: false, onReport: (r) => reports.push(r) })('https://ai.example/v1/chat/completions', { method: 'POST', body: '{"model":"demo-chat"}' })
  assert.equal(lax.status, 502)
  assert.deepEqual([reports[0].ok, reports[0].sidecarError, reports[0].code], [false, true, 'PROVIDER_UNAVAILABLE'])
  // The sidecar's own rate limit. / 旁路自己的限流。
  const limited = sidecar(() => json('{}'), { rateLimit: { ip: 1, windowMs: 60_000 } })
  const vf = ai.createVerifyingFetch({ service: { manifest: limited.manifest(), container: CONTAINER, verified: { dev: true } }, fetch: through(limited), strict: true })
  await vf('https://ai.example/v1/chat/completions', { method: 'POST', body: '{}' }).catch(() => {})
  await assert.rejects(vf('https://ai.example/v1/chat/completions', { method: 'POST', body: '{}' }), (e) => e.code === 'RATE_LIMITED')
  // An upstream error is not a sidecar error: it is signed, and verifies. / 上游错误不是旁路错误：它有签名，可以核验。
  const upErr = sidecar(() => json({ error: { message: 'x' } }, 500))
  const r500 = await post(upErr, '{"model":"demo-chat"}')
  assert.equal(r500.headers.get('x-tapeapi-sidecar-error'), null)
  assert.ok(r500.headers.get(ai.RECEIPT_HEADER))
})
