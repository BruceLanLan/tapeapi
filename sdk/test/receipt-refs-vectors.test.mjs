// Test vectors for a PROPOSAL (not normative): the price basis `result.priceRef` and the receipt reference `receiptRef`
// (not part of TAPI-21 or of any TAP; see the CHANGELOG, 3.0). Two new files, made by the real code: spec/vectors/tapi-21-price-ref.json
// (the reference sidecar with `priceRef: true`, and the same requests with it off) and spec/vectors/tapi-21-receipt-ref.json
// (ai.receiptRef over the receipts of sdk/test/fixtures/ai-receipt-vectors.json, which is read and never written, and of
// the first file). This test regenerates both and requires them to be identical; spec/vectors/verify.py checks them
// independently, from the rules it writes out.
//   TAPEAPI_WRITE_VECTORS=1 node --test sdk/test/receipt-refs-vectors.test.mjs     # rewrite after a deliberate change
// 提案（非规范）的测试向量：价格依据 result.priceRef 与回执引用 receiptRef。两个新文件均由真实代码生成：价格依据文件来自开启
// priceRef 的参考旁路（以及关闭时的同样请求）；回执引用文件来自 ai.receiptRef，作用于现有回执向量（只读，绝不改写）与第一个文件的
// 回执。本测试重新生成两者并要求完全一致；spec/vectors/verify.py 按它自己写出的规则独立核对。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import * as ai from '../src/ai.js'
import { privateKeyToAddress, responseDigest } from '../src/sig.js'
import { canonicalJSON } from '../src/canon.js'
import { createAIProxy } from '../../server/src/ai-proxy.js'

const PRICE_FILE = new URL('../../spec/vectors/tapi-21-price-ref.json', import.meta.url)
const REF_FILE = new URL('../../spec/vectors/tapi-21-receipt-ref.json', import.meta.url)
const RECEIPT_FIXTURE = new URL('./fixtures/ai-receipt-vectors.json', import.meta.url)
const PROPOSAL = 'not part of TAPI-21 or of any TAP; see the CHANGELOG, 3.0'
const KEY = '0x' + '4b'.repeat(32)   // the published test key of ai-receipt-vectors.json: never use it for anything else / 测试密钥
const CONTAINER = '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8', CIRCUITS = '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414'
const NOW_MS = 1_790_000_000_000
const b64 = (s) => Buffer.from(s).toString('base64')
const pr = (currency, input, output, extra = {}) => ({ currency, unit: '1M tokens', input, output, ...extra })
const hex = (b) => (typeof b === 'string' ? b : '0x' + Buffer.from(b).toString('hex'))
const digestOf = (e) => hex(responseDigest({ container: e.container, id: e.id, method: e.method, params: e.params, ok: true, body: e.result, ts: e.ts }))

// Table A, and B: A with the USDT output price of gpt-x raised from 10 to 12. / 价目表 A；B 只把 gpt-x 的 USDT 输出价从 10 提到 12。
const MODELS_A = [
  { id: 'gpt-x', aliases: ['gpt-x-2026-09-01'], formats: ['openai-chat', 'openai-responses'], prices: [pr('USDT', '1.25', '10', { cacheRead: '0.125', reasoning: '12' }), pr('BEM', '12.5', '100', { cacheRead: '1.25' })] },
  { id: 'claude-x', aliases: ['claude-x-20260901'], formats: ['anthropic-messages'], prices: [pr('BEM', '3', '15', { cacheRead: '0.3', cacheWrite: '3.75', cacheWrite1h: '6' })] },
]
const MODELS_B = structuredClone(MODELS_A); MODELS_B[0].prices[0].output = '12'
const ev = (name, o) => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...o })}\n\n`
const CASES = [
  {
    name: 'openai-chat-json', description: 'Chat Completions, whole answer, priced in two currencies',
    path: '/v1/chat/completions', request: '{"model":"gpt-x","messages":[{"role":"user","content":"Hello"}]}',
    upstream: { contentType: 'application/json', body: '{"id":"chatcmpl-v1","object":"chat.completion","created":1790000000,"model":"gpt-x","choices":[{"index":0,"message":{"role":"assistant","content":"Hi!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1200,"completion_tokens":300,"total_tokens":1500,"prompt_tokens_details":{"cached_tokens":1000},"completion_tokens_details":{"reasoning_tokens":100}}}' },
  },
  {
    name: 'anthropic-messages-stream', description: 'Anthropic Messages stream: the receipt rides in an SSE comment',
    path: '/v1/messages', request: '{"model":"claude-x","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"Hello"}]}',
    upstream: {
      contentType: 'text/event-stream',
      body: ev('message_start', { message: { id: 'msg_v4', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } }) +
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hi!' } }) + ev('content_block_stop', { index: 0 }) +
        ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }) + ev('message_stop', {}),
    },
  },
  {
    name: 'unpriced-model', description: 'A model the table does not list: prices null, but the receipt still names the table it was checked against',
    path: '/v1/chat/completions', request: '{"model":"other-model","messages":[{"role":"user","content":"Hello"}]}',
    upstream: { contentType: 'application/json', body: '{"id":"chatcmpl-v3","object":"chat.completion","created":1790000000,"model":"other-model","choices":[{"index":0,"message":{"role":"assistant","content":"Hi!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}' },
  },
  {
    name: 'openai-chat-http-error', description: 'An upstream HTTP 429: usage and prices null; the price basis is signed all the same',
    path: '/v1/chat/completions', request: '{"model":"gpt-x","messages":[{"role":"user","content":"Hello"}]}',
    upstream: { status: 429, contentType: 'application/json', body: '{"error":{"message":"Rate limit reached","type":"rate_limit_exceeded","param":null,"code":null}}' },
  },
]

async function run(models, priceRef) {
  const realNow = Date.now, realRandom = crypto.getRandomValues.bind(crypto)
  Date.now = () => NOW_MS
  crypto.getRandomValues = (b) => { b.fill(0x11); return b }
  try {
    let current = null
    const p = createAIProxy({
      upstream: { baseUrl: 'https://upstream.example/v1' }, signerKey: KEY, models, log: () => {}, rateLimit: false, priceRef,
      formats: ai.FORMATS.filter((f) => f.name !== 'openai-embeddings'),
      manifestBase: { name: 'Receipt reference vectors', circuits: CIRCUITS, tokenId: '11', container: CONTAINER, delegation: null, endpoints: { live: ['https://ai.example/tapeapi/v1'], async: false } },
      fetch: async () => new Response(current.upstream.body, { status: current.upstream.status ?? 200, headers: { 'content-type': current.upstream.contentType } }),
    })
    const out = []
    for (const c of CASES) {
      current = c
      const res = await p.handleRequest(new Request('https://ai.example' + c.path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' }, body: c.request }), { clientIp: '127.0.0.1' })
      const bytes = new Uint8Array(await res.arrayBuffer())
      const stream = (res.headers.get('content-type') || '').includes('text/event-stream')
      const envelope = stream ? ai.readSseReceipt(bytes) : ai.decodeReceiptHeader(res.headers.get(ai.RECEIPT_HEADER))
      out.push({ c, status: res.status, stream, bytes, envelope })
    }
    return { manifest: p.manifest(), out }
  } finally { Date.now = realNow; crypto.getRandomValues = realRandom }
}

const tableOf = (name, description, field) => ({ name, description, ai: field, canonicalModels: canonicalJSON(ai.validateAIField(field, { allowHttp: true }).models), priceRef: ai.priceRefOf(field) })

async function generatePriceRef() {
  const on = await run(MODELS_A, true), off = await run(MODELS_A, false), onB = await run(MODELS_B, true)
  const A = on.manifest.ai, B = onB.manifest.ai
  // Members TAPI-20 §3.9 does not define are not part of the basis; a respelled decimal is. / 未定义成员不计入；改写的小数计入。
  const extra = structuredClone(A); extra.models[0].note = 'a member TAPI-20 §3.9 does not define'
  const respelled = structuredClone(A); respelled.models[0].prices[0].output = '10.00'
  const moved = structuredClone(A); moved.endpoints = moved.endpoints.map((e) => ({ ...e, baseUrl: e.baseUrl.replace('ai.example', 'ai2.example') }))
  const tables = [
    tableOf('A', 'the table the sidecar published and priced with', A),
    tableOf('B', 'A with the USDT output price of gpt-x raised from 10 to 12', B),
    tableOf('A-unknown-member', 'A with a member TAPI-20 §3.9 does not define on one model: the same basis as A', extra),
    tableOf('A-endpoints-moved', 'A served from another host (endpoints only): the same basis as A', moved),
    tableOf('A-respelled', 'A with "10" written "10.00": the same amounts, another basis (decimals are hashed as written)', respelled),
  ]
  const cases = on.out.map((x, i) => {
    const o = off.out[i]
    const { priceRef, ...rest } = x.envelope.result
    assert.deepEqual(rest, o.envelope.result, `${x.c.name}: with the option off, the result is the same without priceRef`)
    return {
      name: x.c.name, description: x.c.description, path: x.c.path, status: x.status, stream: x.stream,
      requestBase64: b64(x.c.request), responseBase64: Buffer.from(x.bytes).toString('base64'),
      envelope: x.envelope, digest: digestOf(x.envelope), receiptRef: ai.receiptRef(x.envelope),
      withoutPriceRef: { envelope: o.envelope, digest: digestOf(o.envelope), receiptRef: ai.receiptRef(o.envelope) },
    }
  })
  // A receipt priced under A, checked against a manifest with table B: the basis differs and so do the amounts.
  // 按 A 定价的回执，对照价目表为 B 的清单核验：依据不同，金额也不同。
  const r0 = on.out[0], mB = { container: onB.manifest.container, signer: onB.manifest.signer, ai: B }
  const vB = ai.verifyUsageReceipt({ envelope: r0.envelope, manifest: mB, requestBytes: r0.c.request, responseBytes: r0.bytes, stream: false, path: r0.c.path, status: r0.status })
  const vA = ai.verifyUsageReceipt({ envelope: r0.envelope, manifest: { container: on.manifest.container, signer: on.manifest.signer, ai: A }, requestBytes: r0.c.request, responseBytes: r0.bytes, stream: false, path: r0.c.path, status: r0.status })
  return {
    description: 'PROPOSAL, not normative (' + PROPOSAL + '): the price basis result.priceRef of an AI usage receipt (TAPI-21 §3.5), SHA-256 of the canonical JSON (TAPI-21 §3.3) of the ai.models table reduced to the members of TAPI-20 §3.9. Generated by sdk/test/receipt-refs-vectors.test.mjs with the reference sidecar (server/src/ai-proxy.js, priceRef: true, and the same requests with it off); the signer key is a published TEST key.',
    signerKey: KEY, signer: privateKeyToAddress(KEY), container: CONTAINER, ts: Math.floor(NOW_MS / 1000),
    tables, cases,
    crossTable: {
      description: 'The receipt of case openai-chat-json (priced under table A) checked against table A and against table B',
      case: 'openai-chat-json',
      againstA: { priceRefMatches: true, problems: vA.problems.length, warnings: vA.warnings.length },
      againstB: { priceRefMatches: false, amountsMatch: false, problems: vB.problems.length, warnings: vB.warnings.length, expectedPricesUnderB: ai.pricesOf(ai.modelEntryOf(B.models, 'gpt-x', 'openai-chat'), r0.envelope.result.usage) },
    },
  }
}

function generateReceiptRef(priceFile) {
  const fixture = JSON.parse(readFileSync(RECEIPT_FIXTURE, 'utf8'))
  const receipts = [
    ...fixture.cases.map((c) => ({ name: c.name, source: 'sdk/test/fixtures/ai-receipt-vectors.json', envelope: c.expected.envelope })),
    ...priceFile.cases.map((c) => ({ name: c.name + '-priceRef', source: 'spec/vectors/tapi-21-price-ref.json', envelope: c.envelope })),
  ].map((r) => {
    const e = r.envelope
    const canon = canonicalJSON({ id: e.id, ok: e.ok, container: e.container.toLowerCase(), ts: e.ts, method: e.method, params: e.params, result: e.result, sig: e.sig.toLowerCase() })
    return { ...r, canonical: canon, receiptRef: ai.receiptRef(e), digest: digestOf(e) }
  })
  const base = receipts[0].envelope, ref0 = receipts[0].receiptRef
  const vLow = (s) => s.slice(0, 130) + (s.slice(130).toLowerCase() === '1b' ? '00' : '01')
  const reorder = (e) => Object.fromEntries(Object.entries(e).reverse())
  const sameReceipt = [
    { name: 'members in another order, with whitespace', json: JSON.stringify(reorder(base), null, 2) },
    { name: 'sig in upper-case hex', json: JSON.stringify({ ...base, sig: '0x' + base.sig.slice(2).toUpperCase() }) },
    { name: 'sig with v as 0 or 1', json: JSON.stringify({ ...base, sig: vLow(base.sig) }) },
    { name: 'container in lower case', json: JSON.stringify({ ...base, container: base.container.toLowerCase() }) },
    { name: 'a top-level member that is not part of a receipt', json: JSON.stringify({ ...base, block: 62000000 }) },
  ].map((x) => ({ ...x, receiptRef: ai.receiptRef(JSON.parse(x.json)) }))
  for (const x of sameReceipt) assert.equal(x.receiptRef, ref0, x.name)
  const otherReceipt = [
    { name: 'ts changed (the signature no longer holds; the reference still differs)', json: JSON.stringify({ ...base, ts: base.ts + 1 }) },
    { name: 'a result member added (signed content changes)', json: JSON.stringify({ ...base, result: { ...base.result, priceRef: '00'.repeat(32) } }) },
  ].map((x) => ({ ...x, receiptRef: ai.receiptRef(JSON.parse(x.json)) }))
  for (const x of otherReceipt) assert.notEqual(x.receiptRef, ref0, x.name)
  const refused = [
    { name: 'ok false: not a usage receipt', json: JSON.stringify({ ...base, ok: false }) },
    { name: 'no sig', json: JSON.stringify({ ...base, sig: undefined }) },
  ]
  for (const x of refused) assert.throws(() => ai.receiptRef(JSON.parse(x.json)), { code: 'RECEIPT_INVALID' }, x.name)
  return {
    description: 'PROPOSAL, not normative (' + PROPOSAL + '): the receipt reference of an AI usage receipt, SHA-256 (64 lowercase hex) of the canonical JSON (TAPI-21 §3.3) of its eight members id, ok, container, ts, method, params, result, sig, with container and sig in lower case and v as 27 or 28. Generated by sdk/test/receipt-refs-vectors.test.mjs with ai.receiptRef; the receipts come from sdk/test/fixtures/ai-receipt-vectors.json and spec/vectors/tapi-21-price-ref.json.',
    receipts, sameReceipt, otherReceipt, refused,
  }
}

async function generateAll() {
  const priceFile = await generatePriceRef()
  return { priceFile, refFile: generateReceiptRef(priceFile) }
}

const write = (u, v) => writeFileSync(u, JSON.stringify(v, null, 1) + '\n')

test('both proposal vector files are exactly what the code produces today (the existing receipt vectors are only read)', async () => {
  const before = readFileSync(RECEIPT_FIXTURE)
  const { priceFile, refFile } = await generateAll()
  if (process.env.TAPEAPI_WRITE_VECTORS === '1') { write(PRICE_FILE, priceFile); write(REF_FILE, refFile) }
  assert.deepEqual(priceFile, JSON.parse(readFileSync(PRICE_FILE, 'utf8')), 'regenerate with TAPEAPI_WRITE_VECTORS=1 only after a deliberate change')
  assert.deepEqual(refFile, JSON.parse(readFileSync(REF_FILE, 'utf8')), 'regenerate with TAPEAPI_WRITE_VECTORS=1 only after a deliberate change')
  assert.ok(Buffer.compare(before, readFileSync(RECEIPT_FIXTURE)) === 0, 'ai-receipt-vectors.json untouched')
})

test('priceRef: off by default (receipts exactly as before), signed when on, and what a verifier makes of it', async () => {
  const V = JSON.parse(readFileSync(PRICE_FILE, 'utf8'))
  const [A, B, unknown, moved, respelled] = V.tables
  assert.equal(unknown.priceRef, A.priceRef); assert.equal(moved.priceRef, A.priceRef)
  assert.notEqual(B.priceRef, A.priceRef); assert.notEqual(respelled.priceRef, A.priceRef)
  for (const c of V.cases) {
    assert.equal(c.envelope.result.priceRef, A.priceRef, c.name)
    assert.equal('priceRef' in c.withoutPriceRef.envelope.result, false, c.name)
    assert.notEqual(c.digest, c.withoutPriceRef.digest, `${c.name}: the signed content changes only because priceRef is there`)
    const manifest = { container: V.container, signer: V.signer, ai: A.ai }
    const v = ai.verifyUsageReceipt({ envelope: c.envelope, manifest, requestBytes: Buffer.from(c.requestBase64, 'base64'), responseBytes: Buffer.from(c.responseBase64, 'base64'), stream: c.stream, path: c.path, status: c.status })
    assert.deepEqual([v.problems, v.warnings.filter((w) => /another version of the price table/.test(w))], [[], []], c.name)
  }
  // Against B: the amounts fail check 5 as they always did, and the warning says why. / 对照 B：金额照旧不过，警告说明原因。
  assert.equal(V.crossTable.againstA.problems, 0)
  assert.ok(V.crossTable.againstB.problems > 0 && V.crossTable.againstB.warnings > 0)
  // The default sidecar signs no priceRef: the existing vectors (made with the default) carry none. / 默认不签。
  const fixture = JSON.parse(readFileSync(RECEIPT_FIXTURE, 'utf8'))
  for (const c of fixture.cases) assert.equal('priceRef' in c.expected.result, false)
  assert.throws(() => createAIProxy({ upstream: { baseUrl: 'https://u.example/v1' }, signerKey: KEY, models: MODELS_A, manifestBase: { circuits: CIRCUITS, tokenId: '1', container: CONTAINER, endpoints: { live: ['https://ai.example/tapeapi/v1'], async: false } }, priceRef: 'yes', log: () => {} }), { code: 'INVALID_ARGUMENT' })
  // A malformed priceRef is a shape problem (only for receipts that carry the member). / 格式错误的 priceRef 是结构问题。
  const bad = structuredClone(V.cases[0].envelope); bad.result.priceRef = 'ABC'
  assert.match(ai.envelopeProblems(bad).join('\n'), /priceRef must be 64 lowercase hex/)
})

test('receiptRef: one reference per signed receipt, however it is serialised or carried', () => {
  const R = JSON.parse(readFileSync(REF_FILE, 'utf8'))
  assert.equal(R.receipts.length, 11)
  for (const r of R.receipts) {
    assert.equal(ai.receiptRef(r.envelope), r.receiptRef, r.name)
    assert.equal(ai.sha256Hex(r.canonical), r.receiptRef, r.name)
    assert.ok(/^[0-9a-f]{64}$/.test(r.receiptRef))
  }
  assert.equal(new Set(R.receipts.map((r) => r.receiptRef)).size, R.receipts.length, 'every receipt has its own reference')
  // The header form and the retrieved form (a result re-serialised by the receipt method) have the same reference.
  // 响应头里的形式与经 receipt 方法取回（重新序列化）的形式引用相同。
  const fixture = JSON.parse(readFileSync(RECEIPT_FIXTURE, 'utf8'))
  const h = fixture.cases.find((c) => c.receiptDelivery === 'header')
  assert.equal(ai.receiptRef(ai.decodeReceiptHeader(h.expected.encoded)), ai.receiptRef(JSON.parse(JSON.stringify(h.expected.envelope, null, 3))))
})
