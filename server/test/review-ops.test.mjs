// Adversarial checks of the 2.5 operator helpers. The receipt's price against an
// independent reading of the price rule for random usage, through the real sidecar (createAIProxy) for two formats; the
// worst-case bound against amountOf; what the upstream-header allowlist lets through. No network; seeded randomness.
// 2.5 运营方辅助的对抗检查。随机用量下，经由真实旁路签出的回执价格与独立实现的价格规则逐一比对；最坏情况上限
// 与 amountOf 比对；上游响应头白名单放过了什么。不联网，随机数有种子。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createAIProxy } from '../src/ai-proxy.js'
import { ai } from '@tapeapi/sdk'

const VEC = JSON.parse(readFileSync(new URL('../../sdk/test/fixtures/ai-receipt-vectors.json', import.meta.url), 'utf8'))
const MODELS = VEC.manifest.ai.models
const KEY = '0x' + '42'.repeat(32)
const CIRCUITS = '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', CONTAINER = '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8'
const BASE = 'https://ai.example'
// a small seeded generator (mulberry32) so a failure can be replayed / 带种子的随机数，失败可复现
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const int = (r, n) => Math.floor(r() * (n + 1))

// The price rule read independently from the receipt format's text (disjoint buckets, prices per 1M tokens, one rounding
// up to 8 decimals on the sum), in rationals over BigInt: not the SDK's code. / 独立读出的价格规则（有理数、BigInt），不是 SDK 的代码。
function reference(price, u) {
  const dec = (s) => { const [i, f = ''] = s.split('.'); return { n: BigInt(i + f), d: 10n ** BigInt(f.length) } }
  const has = (k) => price[k] !== undefined && price[k] !== null
  const cw = has('cacheWrite') ? price.cacheWrite : price.input
  const buckets = [
    [u.prompt_tokens - (u.cache_read_tokens ?? 0) - (u.cache_write_tokens ?? 0), price.input],
    [u.cache_read_tokens ?? 0, has('cacheRead') ? price.cacheRead : price.input],
    [(u.cache_write_tokens ?? 0) - (u.cache_write_1h_tokens ?? 0), cw],
    [u.cache_write_1h_tokens ?? 0, has('cacheWrite1h') ? price.cacheWrite1h : cw],
    [u.completion_tokens - (has('reasoning') ? (u.reasoning_tokens ?? 0) : 0), price.output],
    [has('reasoning') ? (u.reasoning_tokens ?? 0) : 0, has('reasoning') ? price.reasoning : '0'],
  ]
  // sum of count × price / 1e6, as a fraction n / D with a common denominator / 以公分母求和
  const D = 10n ** 30n
  let n = 0n
  for (const [count, p] of buckets) { const q = dec(p); n += BigInt(count) * q.n * (D / q.d) }
  const scaled = n * 10n ** 8n, den = D * 1_000_000n
  const units = (scaled + den - 1n) / den
  const s = units.toString().padStart(9, '0')
  return `${s.slice(0, -8)}.${s.slice(-8)}`
}
function randomUsage(r, withCacheWrite) {
  const prompt = int(r, 1) ? int(r, 400_000) : int(r, 50)
  const cacheRead = int(r, 1) ? int(r, prompt) : 0
  const cacheWrite = withCacheWrite && int(r, 1) ? int(r, prompt - cacheRead) : 0
  const cacheWrite1h = cacheWrite && int(r, 1) ? int(r, cacheWrite) : 0
  const completion = int(r, 1) ? int(r, 128_000) : int(r, 5)
  const reasoning = int(r, 1) ? int(r, completion) : 0
  return { prompt, cacheRead, cacheWrite, cacheWrite1h, completion, reasoning }
}
// the upstream's own usage shape for each format / 各格式上游自己的用量形状
const UPSTREAM = {
  'openai-chat': (x) => ({ path: '/v1/chat/completions', model: 'gpt-x', answer: { id: 'chatcmpl-' + 'A'.repeat(29), object: 'chat.completion', model: 'gpt-x', choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: x.prompt, completion_tokens: x.completion, total_tokens: x.prompt + x.completion, prompt_tokens_details: { cached_tokens: x.cacheRead }, completion_tokens_details: { reasoning_tokens: x.reasoning } } } }),
  'anthropic-messages': (x) => ({ path: '/v1/messages', model: 'claude-x', answer: { id: 'msg_' + 'B'.repeat(24), type: 'message', role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn', usage: { input_tokens: x.prompt - x.cacheRead - x.cacheWrite, cache_read_input_tokens: x.cacheRead, cache_creation_input_tokens: x.cacheWrite, cache_creation: { ephemeral_5m_input_tokens: x.cacheWrite - x.cacheWrite1h, ephemeral_1h_input_tokens: x.cacheWrite1h }, output_tokens: x.completion } } }),
}
let current = null
const proxyFor = (answer, extra = {}) => createAIProxy({ upstream: { baseUrl: 'https://up.example/v1' }, manifestBase: { name: 'AI', circuits: CIRCUITS, tokenId: '11', container: CONTAINER, delegation: null, endpoints: { live: [`${BASE}/tapeapi/v1`], async: false } }, signerKey: KEY, models: MODELS, fetch: async () => new Response(JSON.stringify(answer ?? current), { headers: { 'content-type': 'application/json' } }), log: () => {}, rateLimit: false, ...extra })

test('CONFIRMED OPS-P1: the sidecar\'s signed prices equal ai.pricesOf on the receipt\'s usage and an independent reading of the rule, for 300 random usages in two formats', async () => {
  const r = rng(20261022)
  let n = 0
  for (const format of ['openai-chat', 'anthropic-messages']) {
    const p = proxyFor(null)
    for (let i = 0; i < 150; i++) {
      const x = randomUsage(r, format === 'anthropic-messages')
      const up = UPSTREAM[format](x)
      current = { ...up.answer, id: up.answer.id.slice(0, -4) + String(i).padStart(4, '0') }
      const res = await p.handleRequest(new Request(BASE + up.path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: up.model, max_tokens: 10, messages: [{ role: 'user', content: 'Hi' }] }) }), { clientIp: '1.1.1.1' })
      await res.arrayBuffer()
      const env = ai.decodeReceiptHeader(res.headers.get(ai.RECEIPT_HEADER))
      const u = env.result.usage, entry = MODELS.find((m) => m.id === up.model)
      assert.deepEqual(env.result.prices, ai.pricesOf(entry, u), `${format} ${JSON.stringify(x)}`)
      for (const [j, price] of entry.prices.entries()) {
        assert.equal(env.result.prices[j].amount, reference(price, u), `${format} ${price.currency} ${JSON.stringify(u)}`)
        // the worst case over the counts is never below the receipt / 计数以内的最坏情况绝不低于回执
        const max = ai.maxAmountOf(price, { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens })
        assert.ok(Number(max) >= Number(env.result.prices[j].amount) && BigInt(max.replace('.', '')) >= BigInt(env.result.prices[j].amount.replace('.', '')), `${max} < ${env.result.prices[j].amount}`)
      }
      n++
    }
  }
  assert.equal(n, 300)
})

test('CONFIRMED OPS-P2: the receipt is priced on the REPORTED model; maxAmountOf on the requested model\'s entry is below the receipt when the upstream reports a dearer one', async () => {
  const models = [{ id: 'cheap', prices: [{ currency: 'USDT', unit: '1M tokens', input: '1', output: '2' }] }, { id: 'dear', prices: [{ currency: 'USDT', unit: '1M tokens', input: '10', output: '40' }] }]
  const answer = { id: 'chatcmpl-' + 'C'.repeat(29), object: 'chat.completion', model: 'dear', choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }
  const res = await proxyFor(answer, { models }).handleRequest(new Request(BASE + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'cheap', max_tokens: 100, messages: [] }) }), { clientIp: '1.1.1.1' })
  const env = ai.decodeReceiptHeader(res.headers.get(ai.RECEIPT_HEADER))
  assert.equal(env.result.model, 'dear'); assert.equal(env.result.modelMatchedBy, 'response')
  const held = ai.maxPricesOf(models[0], { promptTokens: 1000, completionTokens: 100 })[0].amount
  assert.ok(Number(held) < Number(env.result.prices[0].amount), `held ${held}, receipt ${env.result.prices[0].amount}: a billing layer must bound over every entry the format allows, or refuse a reported model it did not price`)
})

// ---- the upstream-header allowlist / 上游响应头白名单 ----
const HEADERS = [['content-type', 'application/json; charset=utf-8; channel=azure-east-7; cost=0.00042'], ['x-request-id', 'req-1'], ['X-Upstream-Channel', 'ch-7'], ['set-cookie', 'a=b'], ['set-cookie', 'c=d'], ['x-dup', 'one'], ['x-dup', 'two']]
const headersProxy = (extra) => createAIProxy({ upstream: { baseUrl: 'https://up.example/v1' }, manifestBase: { name: 'AI', circuits: CIRCUITS, tokenId: '11', container: CONTAINER, delegation: null, endpoints: { live: [`${BASE}/tapeapi/v1`], async: false } }, signerKey: KEY, models: MODELS,
  fetch: async () => { const h = new Headers(); for (const [k, v] of HEADERS) h.append(k, v); return new Response(JSON.stringify(UPSTREAM['openai-chat'](randomUsage(rng(1), false)).answer), { headers: h }) }, log: () => {}, ...extra })
const headersOf = async (p) => { const res = await p.handleRequest(new Request(BASE + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"gpt-x","messages":[]}' }), { clientIp: '1.1.1.1' }); await res.arrayBuffer(); return res }

test('FIXED OPS-H1: with the allowlist on, content-type keeps its media type and charset only: its other parameters can carry what the allowlist hides', async () => {
  const on = await headersOf(headersProxy({ upstreamResponseHeaders: ['x-request-id'] }))
  assert.equal(on.headers.get('content-type'), 'application/json; charset=utf-8', 'before the fix: the channel and the cost rode along in content-type')
  assert.ok(ai.decodeReceiptHeader(on.headers.get(ai.RECEIPT_HEADER)).sig)
  // off: verbatim, as 2.4 / 未开：原样，与 2.4 相同
  const off = await headersOf(headersProxy({}))
  assert.equal(off.headers.get('content-type'), HEADERS[0][1])
})

test('CONFIRMED OPS-H2: the allowlist is case-insensitive, never lets set-cookie or the receipt header through even when listed, and duplicates come through joined as fetch joins them', async () => {
  const res = await headersOf(headersProxy({ upstreamResponseHeaders: ['X-UPSTREAM-CHANNEL', 'set-cookie', 'x-dup', ai.RECEIPT_HEADER] }))
  assert.equal(res.headers.get('x-upstream-channel'), 'ch-7')
  assert.equal(res.headers.get('set-cookie'), null)
  assert.equal(res.headers.get('x-dup'), 'one, two')
  assert.equal(res.headers.get('x-request-id'), null)
  assert.ok(ai.decodeReceiptHeader(res.headers.get(ai.RECEIPT_HEADER)).sig, 'the receipt header is the sidecar\'s own')
})
