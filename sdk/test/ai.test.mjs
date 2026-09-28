// AI usage receipts, client side: the event-stream scanner against a reference parser at every chunk boundary, the
// price arithmetic (BigInt, rounded up), the manifest field, the receipt codec, verifyUsageReceipt catching each kind
// of tampering or mismatch, and the verifying fetch for official SDKs (non-stream, stream without delay, strict and
// report-only, pass-through, key rotation). No network.
// AI 用量回执（客户端）：事件流扫描器在每个分块边界上与参考解析器一致；价格运算（BigInt、向上取整）；清单字段；回执编解码；
// verifyUsageReceipt 能发现每一种篡改或不符；给官方 SDK 用的核验 fetch（非流式、流式不延迟、严格与仅报告、透传、换钥）。不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as ai from '../src/ai.js'
import { signResponse, privateKeyToAddress } from '../src/sig.js'
import { createAIProxy } from '../../server/src/ai-proxy.js'

const KEY = '0x' + '42'.repeat(32), OTHER_KEY = '0x' + '43'.repeat(32)
const SIGNER = privateKeyToAddress(KEY)
const CIRCUITS = '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', CONTAINER = '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8'
const price = (currency, input, output, extra = {}) => ({ currency, unit: '1M tokens', input, output, ...extra })
const MODELS = [
  { id: 'demo-chat', prices: [price('BEM', '0.15', '0.6')] },
  { id: 'gpt-4o', aliases: ['gpt-4o-2024-08-06'], prices: [price('USDT', '2.5', '10'), price('BEM', '25', '100')] },
  { id: 'gpt-4o-mini', formats: ['openai-chat'], prices: [price('USDC', '0.15', '0.6')] },
  { id: 'claude-demo', aliases: ['claude-demo-20260901'], formats: ['anthropic-messages'], prices: [price('BEM', '3', '15', { cacheRead: '0.3', cacheWrite: '3.75', cacheWrite1h: '6' })] },
]
const ENDPOINTS = [
  { format: 'openai-chat', baseUrl: 'https://ai.example/v1' }, { format: 'openai-responses', baseUrl: 'https://ai.example/v1' },
  { format: 'anthropic-messages', baseUrl: 'https://ai.example' }, { format: 'openai-embeddings', baseUrl: 'https://ai.example/v1' },
]
const MANIFEST = { tapeapi: '0.1', name: 'AI', circuits: CIRCUITS, tokenId: '11', container: CONTAINER, signer: SIGNER, delegation: null, endpoints: { live: ['https://ai.example/tapeapi/v1'], async: false }, methods: [], ai: { endpoints: ENDPOINTS, models: MODELS } }
const te = new TextEncoder()
const sha = (b) => createHash('sha256').update(typeof b === 'string' ? te.encode(b) : b).digest('hex')

// ── the scanner / 扫描器 ─────────────────────────────────────────────────────────────────────────────────────────
// Reference: the WHATWG algorithm, written the obvious way over the whole text. / 参考实现：对整段文本直接按 WHATWG 算法。
function reference(text, sentinel = '[DONE]') {
  if (text.startsWith('﻿')) text = text.slice(1)
  const lines = text.split(/\r\n|\r|\n/)
  lines.pop()   // an unterminated last line is not a line / 未结束的最后一行不算行
  const out = []
  let data = null
  for (const line of lines) {
    if (line === '') { if (data !== null) out.push(data.join('\n')); data = null; continue }
    if (line.startsWith(':')) continue
    const k = line.indexOf(':')
    const field = k < 0 ? line : line.slice(0, k)
    let v = k < 0 ? '' : line.slice(k + 1)
    if (v.startsWith(' ')) v = v.slice(1)
    if (field === 'data') (data ??= []).push(v)
  }
  const kept = out.filter((d) => d !== sentinel)
  return sha(kept.map((d) => d + '\n').join(''))
}
const scanInChunks = (text, cuts, o) => {
  const b = te.encode(text), s = ai.createSseScanner(o)
  let at = 0
  for (const c of [...cuts, b.length]) { s.push(b.subarray(at, c)); at = c }
  s.end()
  return s
}
const SAMPLES = [
  'data: {"a":1}\n\ndata: [DONE]\n\n',
  'data: one\r\ndata: two\r\n\r\ndata:three\r\rdata:  four\n\n',                 // CRLF, CR, no space, two spaces / 各种行尾与空格
  ': comment\nevent: x\nid: 7\nretry: 10\ndata\n\ndata:\n\nfoo: bar\ndata: é✓\n\n', // fields, "data" alone, empty data / 各种字段
  '﻿data: bom\n\ndata: [DONE]\n\ndata: after\n\n',                            // BOM, events after the sentinel / BOM 与结束标记之后的事件
  'data: unfinished\n',                                                             // never dispatched / 不会分派
  'data: [DONE] \n\ndata: [DONE]x\n\ndata:[DONE]\n\n',                              // only the exact sentinel is left out / 只排除精确的结束标记
  'dataX: no\ndat: no\nDATA: no\n\n',                                               // not data fields / 不是 data 字段
]

test('scanner: agrees with the reference parser at every chunk boundary, CR/LF splits included', () => {
  for (const text of SAMPLES) {
    const want = reference(text)
    const n = te.encode(text).length
    assert.equal(scanInChunks(text, [], { sentinel: '[DONE]' }).digest(), want, JSON.stringify(text))
    for (let i = 1; i < n; i++) assert.equal(scanInChunks(text, [i], { sentinel: '[DONE]' }).digest(), want, `${JSON.stringify(text)} cut at ${i}`)
    assert.equal(scanInChunks(text, Array.from({ length: n - 1 }, (_, i) => i + 1), { sentinel: '[DONE]' }).digest(), want, 'one byte at a time')
  }
  // Random texts, random cuts. / 随机文本、随机切分。
  let seed = 7
  const rnd = (k) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % k }
  const parts = ['data: ', 'data:', 'data', ': c', 'event: e', '[DONE]', 'x', 'é', '\n', '\r', '\r\n', '\n\n', ' ', '{"id":"a"}']
  for (let t = 0; t < 300; t++) {
    let text = ''
    for (let i = 0; i < 30; i++) text += parts[rnd(parts.length)]
    const n = te.encode(text).length
    const cuts = [...new Set(Array.from({ length: rnd(6) }, () => 1 + rnd(Math.max(1, n - 1))))].sort((a, b) => a - b).filter((c) => c < n)
    assert.equal(scanInChunks(text, cuts, { sentinel: '[DONE]' }).digest(), reference(text), JSON.stringify(text))
  }
})

test('scanner: a large event is hashed the same when it is past the parse limit; no sentinel means every event counts', () => {
  const big = `data: ${'y'.repeat(5000)}\ndata: z\n\ndata: [DONE]\n\n`
  assert.equal(scanInChunks(big, [7, 4000], { sentinel: '[DONE]', eventParseLimit: 100 }).digest(), reference(big))
  assert.equal(scanInChunks(big, [], { sentinel: null }).digest(), sha(`${'y'.repeat(5000)}\nz\n[DONE]\n`))
  const events = []
  scanInChunks('event: start\ndata: {"n":1}\n\ndata: not json\n\nevent: stop\ndata: {"n":2}\n\n', [3, 20], { onEvent: (j, name) => events.push([name, j]) })
  assert.deepEqual(events, [['start', { n: 1 }], ['stop', { n: 2 }]], 'JSON events go to the adapter with their names')
  assert.equal(ai.sseDigestOfPayloads(['a', te.encode('b'), '[DONE]'], { sentinel: '[DONE]' }), sha('a\nb\n'))
  assert.equal(ai.sseDigestOfPayloads(['a', '[DONE]']), sha('a\n[DONE]\n'), 'no sentinel given: nothing left out')
  assert.equal(ai.sentinelOf('openai_chat'), '[DONE]'); assert.equal(ai.sentinelOf('openai_embeddings'), null); assert.equal(ai.sentinelOf('nope'), null)
})

test('scanner: receipt comments are collected (the last is the outermost); readSseReceipt decodes it', () => {
  const env = { id: 'a', ok: true }
  const text = `: tapeapi-receipt ${ai.encodeReceipt({ id: 'inner' })}\ndata: x\n\n${ai.receiptComment(env)}\n\n:tapeapi-receipt ${ai.encodeReceipt({ id: 'last' })}\n`
  assert.equal(ai.scanSse(text).receipts.length, 3)
  assert.deepEqual(ai.readSseReceipt(text), { id: 'last' })
  assert.equal(ai.readSseReceipt('data: x\n\n'), null)
  assert.throws(() => ai.decodeReceiptHeader('!!'), /base64url/)
  assert.throws(() => ai.decodeReceiptHeader(null), /no receipt/)
  assert.throws(() => ai.decodeReceiptHeader(ai.encodeReceipt([1])), /not a JSON object/)
  assert.deepEqual(ai.decodeReceiptHeader(ai.encodeReceipt({ id: 'é✓' })), { id: 'é✓' })
})

// ── usage and price / 用量与价格 ─────────────────────────────────────────────────────────────────────────────────
test('usage and amount: one bucket convention, BigInt only, rounded up once on the sum, exactly 8 decimals; prices by exact model id or alias and format', () => {
  assert.deepEqual(ai.usageOf({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 9 }), { prompt_tokens: 3, completion_tokens: 4, total_tokens: 9 })
  assert.deepEqual(ai.usageOf({ prompt_tokens: 3 }), { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 })
  // Fixed key order whatever the input order; zero per-use counts dropped. / 键顺序固定；为 0 的按次计数去掉。
  assert.deepEqual(JSON.stringify(ai.usageOf({ other: { b: 1, a: 2, z: 0 }, reasoning_tokens: 1, cache_write_tokens: 2, cache_read_tokens: 3, total_tokens: 20, completion_tokens: 5, prompt_tokens: 10 })),
    '{"prompt_tokens":10,"completion_tokens":5,"total_tokens":20,"cache_read_tokens":3,"cache_write_tokens":2,"reasoning_tokens":1,"other":{"a":2,"b":1}}')
  for (const bad of [null, {}, { prompt_tokens: -1 }, { prompt_tokens: 1.5 }, { prompt_tokens: '3' }, { prompt_tokens: 1, completion_tokens: 2 ** 53 },
    { prompt_tokens: 5, cache_read_tokens: 3, cache_write_tokens: 3 }, { prompt_tokens: 5, completion_tokens: 1, reasoning_tokens: 2 }, { prompt_tokens: 1, other: 7 },
    { prompt_tokens: 5, cache_write_tokens: 1, cache_write_1h_tokens: 2 }, { prompt_tokens: 5, cache_write_1h_tokens: 1 }]) assert.equal(ai.usageOf(bad), null, JSON.stringify(bad))
  assert.equal(JSON.stringify(ai.usageOf({ cache_write_1h_tokens: 1, cache_write_tokens: 2, prompt_tokens: 5 })), '{"prompt_tokens":5,"completion_tokens":0,"total_tokens":5,"cache_write_tokens":2,"cache_write_1h_tokens":1}', 'the 1-hour writes right after the writes')
  const e = (input, output, extra = {}) => ({ input, output, ...extra })
  // Buckets: 1000 prompt (300 cache reads, 200 cache writes), 100 completion (40 reasoning). / 分桶。
  const u = { prompt_tokens: 1000, completion_tokens: 100, cache_read_tokens: 300, cache_write_tokens: 200, reasoning_tokens: 40 }
  assert.equal(ai.amountOf(e('1', '2'), u), '0.00120000', 'no cache or reasoning price: everything at input/output')
  assert.equal(ai.amountOf(e('1', '2', { cacheRead: '0.1', cacheWrite: '1.25' }), u), '0.00098000', '500 + 30 + 250 + 200')
  assert.equal(ai.amountOf(e('1', '2', { reasoning: '5' }), u), '0.00132000', '1000 + 60 × 2 + 40 × 5')
  // 1-hour cache writes: their own price, else cacheWrite, else input. / 1 小时缓存写：自己的价格，否则 cacheWrite，再否则 input。
  const u1h = { ...u, cache_write_1h_tokens: 50 }
  assert.equal(ai.amountOf(e('1', '2', { cacheRead: '0.1', cacheWrite: '1.25', cacheWrite1h: '2' }), u1h), '0.00101750', '500 + 30 + 150 × 1.25 + 50 × 2 + 200')
  assert.equal(ai.amountOf(e('1', '2', { cacheRead: '0.1', cacheWrite: '1.25' }), u1h), '0.00098000', 'no cacheWrite1h: the 1-hour writes at cacheWrite')
  assert.equal(ai.amountOf(e('1', '2', { cacheWrite1h: '2' }), u1h), '0.00125000', 'no cacheWrite: 5-minute writes at input, 1-hour ones at cacheWrite1h')
  assert.equal(ai.amountOf(e('0.1', '0.2'), { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }), '0.30000000', 'no 0.30000000000000004')
  assert.equal(ai.amountOf(e('0.00000001', '0'), { prompt_tokens: 1 }), '0.00000001', '1e-14 rounds up to the smallest unit')
  assert.equal(ai.amountOf(e('0.00000001', '0.00000001'), { prompt_tokens: 500_000, completion_tokens: 500_000 }), '0.00000001', 'rounded once, on the sum')
  assert.equal(ai.amountOf(e('0', '0'), { prompt_tokens: 10 }), '0.00000000')
  assert.equal(ai.amountOf(e('999999999999999999.99999999', '0'), { prompt_tokens: Number.MAX_SAFE_INTEGER }), '9007199254740990999999999909.92800746', 'far past float precision (checked with Python Decimal, ROUND_CEILING)')
  assert.equal(ai.amountOf(e('2.5', '10'), { prompt_tokens: 1234, completion_tokens: 567 }), '0.00875500')
  assert.throws(() => ai.amountOf(e(0.1, '1'), { prompt_tokens: 1 }), /decimal/)
  const P = (o) => ai.pricingOf(MODELS, o)
  assert.deepEqual(P({ reported: 'gpt-4o-mini', usage: { prompt_tokens: 1_000_000 }, format: 'openai-chat' }), { model: 'gpt-4o-mini', prices: [{ currency: 'USDC', amount: '0.15000000' }], modelMatchedBy: 'response' })
  assert.deepEqual(P({ reported: 'gpt-4o-mini', usage: { prompt_tokens: 1_000_000 }, format: 'openai-responses' }), { model: 'gpt-4o-mini', prices: null }, 'listed for other formats only')
  assert.deepEqual(P({ reported: 'gpt-4o', usage: { prompt_tokens: 1 }, format: 'openai-responses' }).prices, [{ currency: 'USDT', amount: '0.00000250' }, { currency: 'BEM', amount: '0.00002500' }], 'no formats: every format; one amount per currency, in the table\'s order')
  assert.deepEqual(P({ reported: 'gpt-4o-2024-08-06', usage: { prompt_tokens: 1 }, format: 'openai-chat' }), { model: 'gpt-4o-2024-08-06', prices: [{ currency: 'USDT', amount: '0.00000250' }, { currency: 'BEM', amount: '0.00002500' }], modelMatchedBy: 'response' }, 'an alias matches; the reported id is kept')
  assert.deepEqual(P({ reported: 'gpt-4o-2024-11-20', usage: { prompt_tokens: 1 }, format: 'openai-chat' }), { model: 'gpt-4o-2024-11-20', prices: null }, 'no prefix matching')
  assert.deepEqual(P({ reported: 'GPT-4O', usage: { prompt_tokens: 1 }, format: 'openai-chat' }).prices, null, 'case-sensitive')
  assert.deepEqual(P({ reported: 'gpt-4o', usage: null, format: 'openai-chat' }), { model: 'gpt-4o', prices: null, modelMatchedBy: 'response' }, 'matched, but nothing to price')
  // No reported model: the requested one, marked as such; a reported model always wins. / 上游没报模型：用请求的模型并注明；上游报了就以它为准。
  assert.deepEqual(P({ reported: null, requested: 'demo-chat', usage: { prompt_tokens: 1_000_000 }, format: 'openai-chat' }), { model: 'demo-chat', prices: [{ currency: 'BEM', amount: '0.15000000' }], modelMatchedBy: 'request' })
  assert.deepEqual(P({ reported: 'unlisted', requested: 'demo-chat', usage: { prompt_tokens: 1 }, format: 'openai-chat' }), { model: 'unlisted', prices: null })
  assert.deepEqual(P({ reported: null, requested: 'unlisted', usage: { prompt_tokens: 1 }, format: 'openai-chat' }), { model: null, prices: null })
  assert.deepEqual(P({ reported: 'claude-demo-20260901', usage: { prompt_tokens: 3100, completion_tokens: 50, cache_read_tokens: 2000, cache_write_tokens: 1000, cache_write_1h_tokens: 400, other: { web_search_requests: 2 } }, format: 'anthropic-messages' }),
    // 100 × 3 + 2000 × 0.3 + 600 × 3.75 + 400 × 6 + 50 × 15 = 6300 per 1M / 每百万
    { model: 'claude-demo-20260901', prices: [{ currency: 'BEM', amount: '0.00630000' }], modelMatchedBy: 'response', unpriced: ['web_search_requests'] })
  assert.equal(ai.modelEntryOf(MODELS, 'claude-demo', 'openai-chat'), null)
  assert.equal(ai.modelEntryOf(MODELS, 'claude-demo', 'anthropic-messages').id, 'claude-demo')
})

test('the manifest AI field: endpoints (one per format), 1-256 models, unique ids, formats among the endpoints, nested prices', () => {
  assert.equal(ai.MANIFEST_FIELD, 'ai')
  assert.deepEqual(ai.CURRENCIES, ['BEM', 'BNB', 'USDT', 'USDC', 'ETH', 'USD1', 'USD'])
  assert.deepEqual(ai.FORMATS.map((f) => [f.name, f.method, f.baseSuffix]), [['openai-chat', 'openai_chat', '/v1'], ['openai-responses', 'openai_responses', '/v1'], ['anthropic-messages', 'anthropic_messages', ''], ['openai-embeddings', 'openai_embeddings', '/v1']])
  const ok = { endpoints: [{ format: 'openai-chat', baseUrl: 'https://ai.example/v1/' }, { format: 'future-format', baseUrl: 'https://ai.example' }],
    models: ai.CURRENCIES.map((currency, i) => ({ id: `m${i}`, extra: 1, ...(i ? {} : { formats: ['openai-chat'], aliases: ['m0-2026'] }), prices: [{ currency, unit: '1M tokens', input: '1', output: '2.12345678', cacheRead: '0.5', junk: 1 }] })) }
  ok.models[1].prices = ai.CURRENCIES.map((currency) => ({ reasoning: '3', cacheWrite1h: '2', cacheWrite: '1', cacheRead: '0.5', output: '2', input: '1', unit: '1M tokens', currency }))
  const v = ai.validateAIField(ok)
  assert.equal(v.endpoints[0].baseUrl, 'https://ai.example/v1')
  assert.deepEqual(v.models[0], { id: 'm0', aliases: ['m0-2026'], formats: ['openai-chat'], prices: [{ currency: 'BEM', unit: '1M tokens', input: '1', output: '2.12345678', cacheRead: '0.5' }] }, 'only the known fields')
  assert.equal(JSON.stringify(v.models[1].prices[0]), '{"currency":"BEM","unit":"1M tokens","input":"1","output":"2","cacheRead":"0.5","cacheWrite":"1","cacheWrite1h":"2","reasoning":"3"}', 'a fixed key order')
  assert.equal(v.models[1].prices.length, 7, 'one entry per currency, all seven')
  const bad = (patch, o = {}) => { try { ai.validateAIField({ ...ok, ...patch }, o); return 'ok' } catch (e) { return e.code } }
  const P0 = ok.models[2].prices[0]
  const ep = (x) => ({ endpoints: [{ format: 'openai-chat', baseUrl: x }] , models: [{ id: 'a', prices: [P0] }] })
  assert.equal(bad(ep('http://ai.example/v1')), 'MANIFEST_INVALID')
  assert.equal(bad(ep('http://ai.example/v1'), { allowHttp: true }), 'ok')
  assert.equal(bad(ep('https://ai.example/v1?x=1')), 'MANIFEST_INVALID')
  assert.equal(bad({ endpoints: [] }), 'MANIFEST_INVALID')
  assert.equal(bad({ endpoints: [ok.endpoints[0], ok.endpoints[0]] }), 'MANIFEST_INVALID', 'one endpoint per format')
  assert.equal(bad({ endpoints: [{ format: 'Bad Name', baseUrl: 'https://x.example' }] }), 'MANIFEST_INVALID')
  assert.equal(bad({ models: [] }), 'MANIFEST_INVALID')
  const one = (m) => bad({ models: [{ id: 'a', prices: [P0], ...m }] })
  assert.equal(one({ prices: [{ ...P0, currency: 'EUR' }] }), 'MANIFEST_INVALID')
  assert.equal(one({ prices: [{ ...P0, input: '1e3' }] }), 'MANIFEST_INVALID')
  assert.equal(one({ prices: [{ ...P0, reasoning: 2 }] }), 'MANIFEST_INVALID')
  assert.equal(one({ prices: [{ ...P0, cacheWrite1h: '1.123456789' }] }), 'MANIFEST_INVALID')
  assert.equal(one({ prices: [{ ...P0, output: undefined }] }), 'MANIFEST_INVALID')
  assert.equal(one({ prices: [P0, P0] }), 'MANIFEST_INVALID', 'one entry per currency')
  assert.equal(one({ prices: [] }), 'MANIFEST_INVALID')
  assert.equal(one({ prices: P0 }), 'MANIFEST_INVALID', 'a list')
  assert.equal(one({ prices: undefined, price: P0 }), 'MANIFEST_INVALID', 'the single price object is not accepted')
  assert.equal(one({ id: '' }), 'MANIFEST_INVALID')
  assert.equal(one({ aliases: [] }), 'MANIFEST_INVALID')
  assert.equal(one({ aliases: ['a'] }), 'MANIFEST_INVALID', 'an alias equal to an id')
  assert.equal(one({ aliases: ['b', 'b'] }), 'MANIFEST_INVALID')
  assert.equal(one({ aliases: ['x\u0007'] }), 'MANIFEST_INVALID')
  assert.equal(one({ aliases: Array.from({ length: 17 }, (_, i) => `a${i}`) }), 'MANIFEST_INVALID', 'at most 16 aliases')
  assert.equal(one({ aliases: Array.from({ length: 16 }, (_, i) => `a${i}`) }), 'ok')
  assert.equal(bad({ models: [{ id: 'a', prices: [P0] }, { id: 'b', aliases: ['a'], prices: [P0] }] }), 'MANIFEST_INVALID', 'an alias of one entry is the id of another')
  assert.equal(bad({ models: [{ id: 'a', aliases: ['x'], prices: [P0] }, { id: 'b', aliases: ['x'], prices: [P0] }] }), 'MANIFEST_INVALID', 'two entries share an alias')
  assert.equal(bad({ models: [ok.models[1], ok.models[1]] }), 'MANIFEST_INVALID')
  assert.equal(bad({ models: [{ ...ok.models[1], formats: ['anthropic-messages'] }] }), 'MANIFEST_INVALID', 'formats must be among the endpoints')
})

// ── verifyUsageReceipt ─────────────────────────────────────────────────────────────────────────────────────────
const REQ = '{"model":"demo-chat","messages":[{"role":"user","content":"hi"}]}'
const RES = '{"id":"chatcmpl-1","model":"demo-chat","usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}'
function receipt({ key = KEY, container = CONTAINER, method = 'openai_chat', path = '/v1/chat/completions', req = REQ, res = RES, result = {}, id = 'chatcmpl-1', ts = Math.floor(Date.now() / 1000) } = {}) {
  const params = { path, requestSha256: sha(req) }
  const r = { model: 'demo-chat', usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }, responseSha256: sha(res), stream: false, complete: true, status: 200, prices: [{ currency: 'BEM', amount: '0.00001350' }], modelMatchedBy: 'response', ...result }
  for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k]
  return { id, ok: true, result: r, container, ts, method, params, sig: signResponse({ container, id, method, params, ok: true, body: r, ts }, key) }
}
const verify = (env, extra = {}) => ai.verifyUsageReceipt({ envelope: env, manifest: MANIFEST, requestBytes: REQ, responseBytes: RES, stream: false, ...extra })
const problems = (env, extra) => verify(env, extra).problems.join(' | ')

test('verifyUsageReceipt: a good receipt passes; what was not given is listed as unchecked', () => {
  const r = verify(receipt(), { path: '/v1/chat/completions', status: 200, maxSkewS: 300 })
  assert.deepEqual(r.problems, []); assert.equal(r.ok, true); assert.deepEqual(r.unchecked, [])
  const bare = ai.verifyUsageReceipt({ envelope: receipt(), manifest: MANIFEST })
  assert.equal(bare.ok, true); assert.deepEqual(bare.unchecked, ['request', 'response', 'id', 'model', 'usage', 'complete', 'freshness'], 'a check that could not be made is reported as not made')
  assert.equal(ai.verifyUsageReceipt({ envelope: null, manifest: MANIFEST }).ok, false)
})

test('verifyUsageReceipt: every tampering and mismatch is reported', () => {
  assert.match(problems(receipt(), { responseBytes: RES.replace('20', '21') }), /responseSha256 does not match/)
  assert.match(problems(receipt(), { requestBytes: REQ.replace('hi', 'ho') }), /requestSha256 does not match/)
  assert.match(problems(receipt({ key: OTHER_KEY })), /signed by 0x.*but the manifest's signer is/)
  const edited = receipt(); edited.result.usage.completion_tokens = 2
  assert.match(problems(edited), /signed by/, 'an edited field changes the recovered signer')
  assert.match(problems(receipt({ container: '0x2222222222222222222222222222222222222222' })), /names container/)
  assert.match(problems(receipt({ method: 'openai_embeddings' })), /does not belong to path/)
  assert.match(problems(receipt({ method: 'anthropic_messages' })), /does not belong to path/)
  assert.match(problems(receipt({ method: 'gemini_generate' })), /unknown receipt method/)
  assert.match(problems(receipt(), { path: '/v1/completions' }), /the request went to/)
  assert.match(problems(receipt(), { status: 500 }), /HTTP 200, the response was 500/)
  assert.match(problems(receipt(), { stream: true }), /stream false/)
  assert.match(problems(receipt({ id: 'other' })), /response's id is chatcmpl-1/)
  assert.match(problems(receipt({ ts: 1_000_000 }), { maxSkewS: 300 }), /outside ±300 s/)
  // Amounts: signed by the right key, but not what the table says. / 金额：签名正确，但与价目表不符。
  assert.match(problems(receipt({ result: { prices: [{ currency: 'BEM', amount: '0.00001349' }] } })), /charges 0\.00001349 BEM; the manifest gives 0\.00001350 BEM/)
  assert.match(problems(receipt({ result: { prices: [{ currency: 'USDT', amount: '0.00001350' }] } })), /manifest gives 0\.00001350 BEM/, 'another currency')
  assert.match(problems(receipt({ result: { prices: [{ currency: 'BEM', amount: '0.00001350' }, { currency: 'USDT', amount: '0.00000001' }] } })), /manifest gives/, 'an extra currency')
  assert.match(problems(receipt({ result: { prices: null } })), /carries no prices, but the manifest prices/)
  assert.match(problems(receipt({ result: { modelMatchedBy: undefined, prices: null } })), /does not say it matched/)
  assert.match(problems(receipt({ result: { model: 'unlisted' } }), { requestBytes: undefined }), /lists no price for model unlisted/)
  assert.match(problems(receipt({ result: { model: 'unlisted', prices: null } }), { requestBytes: undefined }), /says model unlisted matched the price table/)
  assert.match(problems(receipt({ result: { unpriced: ['web_search_requests'] } })), /lists unpriced/)
  const RESU = RES.replace('demo-chat', 'unlisted')
  const unpriced = verify(receipt({ res: RESU, result: { model: 'unlisted', prices: null, modelMatchedBy: undefined } }), { responseBytes: RESU })
  assert.equal(unpriced.ok, true)
  assert.deepEqual(unpriced.warnings, ['asked for model demo-chat, the upstream reported unlisted', 'model unlisted is not in the manifest\'s price table'])
  // Matched by the request: the request must have asked for exactly that model. / 按请求匹配：请求必须恰好要的是这个模型。
  assert.equal(verify(receipt({ result: { modelMatchedBy: 'request' } })).ok, true)
  const REQ2 = REQ.replace('demo-chat', 'gpt-4o')
  assert.match(problems(receipt({ req: REQ2, result: { modelMatchedBy: 'request' } }), { requestBytes: REQ2 }), /prices the requested model demo-chat, but the request asked for gpt-4o/)
  // An alias is the same model: no warning. / 别名即同一模型：不警告。
  const REQ3 = REQ.replace('demo-chat', 'gpt-4o'), RES3 = RES.replace('demo-chat', 'gpt-4o-2024-08-06')
  const r3 = verify(receipt({ req: REQ3, res: RES3, result: { model: 'gpt-4o-2024-08-06', prices: [{ currency: 'USDT', amount: '0.00022500' }, { currency: 'BEM', amount: '0.00225000' }] } }), { requestBytes: REQ3, responseBytes: RES3 })
  assert.deepEqual([r3.problems, r3.warnings], [[], []])
  // Completeness: signed, and checked against the answer. / 完整性：已签名，并与回答核对。
  assert.match(problems(receipt({ result: { complete: false } })), /says complete false, but the answer is complete/)
  const failedRes = '{"id":"chatcmpl-1","error":"x"}'
  assert.deepEqual(verify(receipt({ res: failedRes, result: { status: 500, usage: null, prices: null, modelMatchedBy: 'request', complete: false } }), { responseBytes: failedRes, status: 500 }).problems, [], 'the error body names no model: the requested one, as the sidecar signs it')
  assert.match(problems(receipt({ result: { status: 500 } }), { status: 500 }), /a failed call .* carries usage null and prices null/)
  // Shape. / 结构。
  assert.match(problems({ ...receipt(), result: { ...receipt().result, usage: { prompt_tokens: 1 } } }), /result.usage must be/)
  assert.match(problems({ ...receipt(), ok: false }), /ok must be true/)
  assert.match(problems({ ...receipt(), params: { path: '/v1/chat/completions' } }), /params must be/)
  assert.match(ai.verifyUsageReceipt({ envelope: receipt(), manifest: { ...MANIFEST, ai: undefined } }).problems.join(), /ai field/)
  assert.match(problems({ ...receipt(), result: { ...receipt().result, usageInjected: false } }), /usageInjected/)
  for (const [k, v, re] of [['complete', undefined, /complete must be a boolean/], ['status', undefined, /status must be/], ['prices', [{ currency: 'BEM', amount: '1' }], /prices must be/], ['prices', [], /prices must be/],
    ['prices', [{ currency: 'BEM', amount: '0.00000001', extra: 1 }], /prices must be/], ['modelMatchedBy', 'guess', /modelMatchedBy must be/], ['unpriced', [], /unpriced must be/], ['prices', undefined, /prices must be/]]) {
    const r = { ...receipt().result, [k]: v }
    if (v === undefined) delete r[k]
    assert.match(problems({ ...receipt(), result: r }), re, `${k} = ${JSON.stringify(v)}`)
  }
})

// ── the verifying fetch, against the real sidecar / 核验 fetch，对照真实旁路 ────────────────────────────────────────
function sidecar(answer) {
  const p = createAIProxy({
    upstream: { baseUrl: 'https://up.example/v1' }, signerKey: KEY, models: MODELS, log: () => {},
    manifestBase: { name: 'AI', circuits: CIRCUITS, tokenId: '11', container: CONTAINER, delegation: null, endpoints: { live: ['https://ai.example/tapeapi/v1'], async: false } },
    fetch: async (url, init) => answer(url, init),
  })
  return { p, fetch: (u, i) => p.handleRequest(new Request(u, i), { clientIp: '1.1.1.1' }) }
}
const svcOf = (p) => ({ manifest: p.manifest(), container: CONTAINER, verified: { dev: true } })
const sse = (text, size = 5, gate) => {
  const b = te.encode(text)
  let i = 0
  return new Response(new ReadableStream({ async pull(c) { if (i >= b.length) return c.close(); if (gate && i > 0) await gate; c.enqueue(b.slice(i, i + size)); i += size } }), { headers: { 'content-type': 'text/event-stream' } })
}
const STREAM = 'data: {"id":"c-1","model":"demo-chat","choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"id":"c-1","model":"demo-chat","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\ndata: [DONE]\n\n'
// What an official SDK's stream reader does: split events, skip comments, stop at [DONE]. / 官方 SDK 读流的方式。
async function sdkRead(res) {
  const out = []
  let buf = ''
  const dec = new TextDecoder()
  for await (const c of res.body) {
    buf += dec.decode(c, { stream: true })
    let k
    while ((k = buf.indexOf('\n\n')) >= 0) {
      const ev = buf.slice(0, k); buf = buf.slice(k + 2)
      const data = ev.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')
      if (data && data !== '[DONE]') out.push(JSON.parse(data))
    }
  }
  return out
}

test('verifying fetch: a non-stream answer is checked, returned intact, and reported', async () => {
  const { p, fetch } = sidecar(() => new Response(RES, { headers: { 'content-type': 'application/json' } }))
  const reports = []
  const vf = ai.createVerifyingFetch({ service: svcOf(p), fetch, onReport: (r) => reports.push(r) })
  const res = await vf('https://ai.example/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: REQ })
  assert.equal(await res.text(), RES)
  assert.equal(reports.length, 1)
  assert.deepEqual(reports[0].problems, []); assert.equal(reports[0].ok, true); assert.equal(reports[0].stream, false)
  assert.deepEqual(reports[0].receipt.result.prices, [{ currency: 'BEM', amount: '0.00001350' }])
  // A Request object works too; the bytes it carries are the bytes hashed. / Request 对象同样可用。
  const r2 = await vf(new Request('https://ai.example/v1/chat/completions', { method: 'POST', body: REQ }))
  assert.equal(await r2.text(), RES); assert.equal(reports[1].ok, true)
})

test('verifying fetch: a tampered answer or a missing receipt throws (strict) or is reported (strict: false)', async () => {
  const tamper = (res) => { const h = new Headers(res.headers); return res.text().then((t) => new Response(t.replace('20', '21'), { status: res.status, headers: h })) }
  const { p, fetch } = sidecar(() => new Response(RES, { headers: { 'content-type': 'application/json' } }))
  const bad = async (u, i) => tamper(await fetch(u, i))
  const vf = ai.createVerifyingFetch({ service: svcOf(p), fetch: bad })
  await assert.rejects(vf('https://ai.example/v1/chat/completions', { method: 'POST', body: REQ }), (e) => e.code === 'RECEIPT_INVALID' && /responseSha256/.test(e.message))
  const reports = []
  const lax = ai.createVerifyingFetch({ service: svcOf(p), fetch: bad, strict: false, onReport: (r) => reports.push(r) })
  const res = await lax('https://ai.example/v1/chat/completions', { method: 'POST', body: REQ })
  assert.equal(res.status, 200); assert.equal(reports[0].ok, false)
  const bare = async (u, i) => { const r = await fetch(u, i); const h = new Headers(r.headers); h.delete('x-tapeapi-receipt'); return new Response(await r.text(), { headers: h }) }
  await assert.rejects(ai.createVerifyingFetch({ service: svcOf(p), fetch: bare })('https://ai.example/v1/chat/completions', { method: 'POST', body: REQ }), /no x-tapeapi-receipt header/)
})

test('verifying fetch: a stream reaches the reader chunk by chunk, is checked at its end, and a tampered one errors there', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const { p, fetch } = sidecar(() => sse(STREAM, 40, gate))
  const reports = []
  const vf = ai.createVerifyingFetch({ service: svcOf(p), fetch, onReport: (r) => reports.push(r) })
  // include_usage asked by the client: nothing to strip, so partial events stream at once too. / 客户端自己要了 usage：部分事件也立即转发。
  const res = await vf('https://ai.example/v1/chat/completions', { method: 'POST', body: '{"model":"demo-chat","stream":true,"stream_options":{"include_usage":true}}' })
  const reader = res.body.getReader()
  const first = await reader.read()
  assert.equal(new TextDecoder().decode(first.value), STREAM.slice(0, 40), 'the first chunk arrived while the upstream is held')
  assert.equal(reports.length, 0, 'not checked yet')
  release()
  let rest = ''
  for (;;) { const { done, value } = await reader.read(); if (done) break; rest += new TextDecoder().decode(value) }
  assert.equal(reports.length, 1); assert.deepEqual(reports[0].problems, []); assert.equal(reports[0].stream, true)
  assert.deepEqual(reports[0].receipt.result.usage, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 })
  // An SDK-style reader sees the upstream events, not the comment. / SDK 式读取者看到上游事件，看不到注释。
  const { p: p2, fetch: f2 } = sidecar(() => sse(STREAM, 3))
  const r2 = []
  const events = await sdkRead(await ai.createVerifyingFetch({ service: svcOf(p2), fetch: f2, onReport: (r) => r2.push(r) })('https://ai.example/v1/chat/completions', { method: 'POST', body: '{"stream":true}' }))
  assert.equal(events.length, 1, 'the usage chunk the client did not ask for is stripped')
  assert.equal(r2[0].ok, true); assert.equal(r2[0].receipt.result.usage.total_tokens, 5); assert.equal(r2[0].receipt.result.usageInjected, true)
  // Tampered in flight: the stream errors at its end. / 途中被改：流在结束时出错。
  const { p: p3, fetch: f3 } = sidecar(() => sse(STREAM, 7))
  const evil = async (u, i) => { const r = await f3(u, i); const t = (await r.text()).replace('"hi"', '"ho"'); return new Response(t, { headers: r.headers }) }
  const res3 = await ai.createVerifyingFetch({ service: svcOf(p3), fetch: evil })('https://ai.example/v1/chat/completions', { method: 'POST', body: '{"stream":true}' })
  await assert.rejects(sdkRead(res3), (e) => e.code === 'RECEIPT_INVALID')
  // A reader that stops early: reported as incomplete, not as a bad receipt. / 提前停止读取：报告为未读完，而不是回执有问题。
  const { p: p4, fetch: f4 } = sidecar(() => sse(STREAM, 5))
  const r4 = []
  const res4 = await ai.createVerifyingFetch({ service: svcOf(p4), fetch: f4, onReport: (r) => r4.push(r) })('https://ai.example/v1/chat/completions', { method: 'POST', body: '{"stream":true}' })
  const rd = res4.body.getReader(); await rd.read(); await rd.cancel()
  assert.equal(r4.length, 1); assert.equal(r4[0].incomplete, true); assert.deepEqual(r4[0].problems, [])
})

test('verifying fetch: other paths pass through untouched; the service must be verified; a rotated key is re-read once', async () => {
  const calls = []
  const passthrough = async (u, i) => { calls.push([u, i]); return new Response('{"data":[]}') }
  const svc = { manifest: MANIFEST, container: CONTAINER, verified: { dev: true } }
  const vf = ai.createVerifyingFetch({ service: svc, fetch: passthrough, onReport: () => assert.fail('no report for a pass-through') })
  const init = { method: 'GET', headers: { authorization: 'Bearer k' } }
  await vf('https://ai.example/v1/models', init)
  await vf('https://elsewhere.example/v1/chat/completions', { method: 'POST', body: '{}' })
  assert.equal(calls[0][1], init, 'the same init object, untouched')
  assert.equal(calls.length, 2)
  await assert.rejects(ai.createVerifyingFetch({ service: { manifest: MANIFEST, container: CONTAINER, verified: {} }, fetch: passthrough })('https://ai.example/v1/models'), (e) => e.code === 'DELEGATION_INVALID')
  await assert.rejects(ai.createVerifyingFetch({ service: { manifest: { ...MANIFEST, ai: undefined }, verified: { dev: true } }, fetch: passthrough })('https://ai.example/v1/models'), (e) => e.code === 'MANIFEST_INVALID')
  // A target is resolved on first use; a receipt by another key re-reads the manifest once. / 首次使用时解析；换钥时重读一次。
  const { p, fetch } = sidecar(() => new Response(RES, { headers: { 'content-type': 'application/json' } }))
  const stale = { ...p.manifest(), signer: privateKeyToAddress(OTHER_KEY) }
  let resolved = 0, refreshed = 0
  const api = {
    resolve: async (target) => { resolved++; assert.equal(target, '11.1013.tape'); return { manifest: stale, container: CONTAINER, verified: { dev: true }, target } },
    refresh: async (s) => { refreshed++; s.manifest = p.manifest(); return s },
  }
  const reports = []
  const vf2 = ai.createVerifyingFetch({ api, service: '11.1013.tape', fetch, onReport: (r) => reports.push(r) })
  await vf2('https://ai.example/v1/chat/completions', { method: 'POST', body: REQ })
  await vf2('https://ai.example/v1/chat/completions', { method: 'POST', body: REQ })
  assert.deepEqual([resolved, refreshed], [1, 1])
  assert.ok(reports.every((r) => r.ok))
})

test('verifying fetch: the manifest endpoints route each format, Anthropic\'s without /v1 in its base URL', async () => {
  const MSG = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-demo","usage":{"input_tokens":10,"cache_read_input_tokens":20,"output_tokens":1}}}\n\nevent: ping\ndata: {"type":"ping"}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":5}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
  const RESP = 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"gpt-4o"}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-4o","usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}\n\n'
  const { p, fetch } = sidecar((url) => (url.endsWith('/messages') ? sse(MSG, 11) : url.endsWith('/responses') ? sse(RESP, 13) : new Response('{"data":[]}')))
  const reports = []
  const vf = ai.createVerifyingFetch({ service: svcOf(p), fetch, onReport: (r) => reports.push(r) })
  const anthropicBase = p.manifest().ai.endpoints.find((e) => e.format === 'anthropic-messages').baseUrl
  assert.equal(anthropicBase, 'https://ai.example')
  const m = await vf(`${anthropicBase}/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'k' }, body: '{"model":"claude-demo","stream":true,"max_tokens":8,"messages":[]}' })
  const mt = await m.text()
  assert.ok(mt.includes('event: ping'))
  assert.equal(reports.at(-1).ok, true, reports.at(-1).problems.join())
  assert.deepEqual(reports.at(-1).receipt.result.prices, [{ currency: 'BEM', amount: '0.00011100' }], '10 × 3 + 20 × 0.3 + 5 × 15')
  const r = await vf('https://ai.example/v1/responses', { method: 'POST', body: '{"model":"gpt-4o","stream":true,"input":"x"}' })
  await r.text()
  assert.equal(reports.at(-1).ok, true); assert.equal(reports.at(-1).receipt.method, 'openai_responses'); assert.deepEqual(reports.at(-1).receipt.result.prices, [{ currency: 'USDT', amount: '0.00003000' }, { currency: 'BEM', amount: '0.00030000' }])
  await vf('https://ai.example/v1/messages/count_tokens', { method: 'POST', body: '{}' })
  assert.equal(reports.length, 2, 'count_tokens is not a receipt path')
})
