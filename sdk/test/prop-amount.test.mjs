// Properties of the AI price arithmetic (TAPI-20 §3.9): ai.amountOf is pure and equals an independent reference written
// from the spec's table (disjoint buckets, the fallbacks of cacheRead / cacheWrite / cacheWrite1h / reasoning, one
// rounding UP to 8 decimals on the sum); the reference sidecar's receipt prices equal both, for random price tables
// (cache tiers included) and random usage in each format's own shape; maxAmountOf is never below amountOf for any usage
// within its bounds; completionLimitOf is monotone in every input it reads.
// A failure prints its seed; PROP_SEED=<n> PROP_RUNS=1 node --test sdk/test/prop-amount.test.mjs replays one iteration.
// AI 价格算术的性质：amountOf 是纯函数，且等于按规范表格独立写出的参考实现；参考旁路回执里的价格与二者相等（随机价目表含缓存档位、
// 各格式自己的用量形状）；maxAmountOf 对界内任何用量都不低于 amountOf；completionLimitOf 对它读取的每个输入单调。
import test from 'node:test'
import assert from 'node:assert/strict'
import * as ai from '../src/ai.js'
import { createAIProxy } from '../../server/src/ai-proxy.js'
import { forAll, runsOf, seedOf } from './helpers/prng.mjs'

// ---------- the reference, from the spec's text only / 参考实现，只依据规范文字 ----------
// A decimal (^(0|[1-9][0-9]{0,17})(\.[0-9]{1,8})?$) as an exact fraction n / 10^8. / 小数 -> n / 10^8。
const E8 = 100_000_000n
function frac8(s) {
  assert.match(s, /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,8})?$/)
  const [i, f = ''] = s.split('.')
  return BigInt(i) * E8 + (f ? BigInt(f) * 10n ** BigInt(8 - f.length) : 0n)
}
// The amount of TAPI-20 §3.9, in 1e-8 units: sum(tokens_b × price_b) / 1 000 000, rounded up once. / 金额（1e-8 单位）。
function reference(price, u) {
  const p = (k, ...fallbacks) => { for (const x of [k, ...fallbacks]) if (price[x] !== undefined) return frac8(price[x]); throw new Error('no price') }
  const cr = BigInt(u.cache_read_tokens ?? 0), cw = BigInt(u.cache_write_tokens ?? 0), cw1h = BigInt(u.cache_write_1h_tokens ?? 0)
  const rs = price.reasoning !== undefined ? BigInt(u.reasoning_tokens ?? 0) : 0n
  const num = (BigInt(u.prompt_tokens) - cr - cw) * p('input') + cr * p('cacheRead', 'input') + (cw - cw1h) * p('cacheWrite', 'input')
    + cw1h * p('cacheWrite1h', 'cacheWrite', 'input') + (BigInt(u.completion_tokens) - rs) * p('output') + rs * (price.reasoning !== undefined ? p('reasoning') : 0n)
  const q = num / 1_000_000n
  return q * 1_000_000n === num ? q : q + 1n
}
const units = (amount) => { assert.match(amount, /^\d+\.\d{8}$/, `${amount} has exactly 8 decimals`); return BigInt(amount.replace('.', '')) }

// ---------- generators / 生成器 ----------
function decimal(r) {
  const shape = r.int(10)
  if (shape === 0) return '0'
  const intPart = shape < 4 ? '0' : shape < 9 ? String(1 + r.int(999)) : String(1 + r.int(9)) + Array.from({ length: r.int(17) }, () => r.int(10)).join('')
  if (r.p(0.3)) return intPart
  const dec = Array.from({ length: 1 + r.int(8) }, () => r.int(10)).join('')
  return `${intPart}.${dec}`
}
function drawPrice(r, currency = 'USD') {
  const p = { currency, unit: '1M tokens', input: decimal(r), output: decimal(r) }
  for (const k of ['cacheRead', 'cacheWrite', 'cacheWrite1h', 'reasoning']) if (r.p(0.5)) p[k] = decimal(r)
  return p
}
function drawUsage(r, max = 2_000_000) {
  const prompt = r.int(max), completion = r.int(max)
  const read = r.p(0.6) ? r.int(prompt + 1) : undefined
  const write = r.p(0.6) ? r.int(prompt - (read ?? 0) + 1) : undefined
  const write1h = write !== undefined && r.p(0.5) ? r.int(write + 1) : undefined
  const reasoning = r.p(0.6) ? r.int(completion + 1) : undefined
  const u = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
  if (read !== undefined) u.cache_read_tokens = read
  if (write !== undefined) u.cache_write_tokens = write
  if (write1h !== undefined) u.cache_write_1h_tokens = write1h
  if (reasoning !== undefined) u.reasoning_tokens = reasoning
  return u
}
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o) } return o }

test(`property (b1): amountOf is pure and equals the spec's reference, cache tiers and fallbacks included (${runsOf(2000)} iterations, seed ${seedOf(0xb1)})`, async () => {
  await forAll(import.meta.url, (r) => {
    const price = deepFreeze(drawPrice(r)), u = deepFreeze(drawUsage(r))
    const snapshot = JSON.stringify([price, u])
    const a = ai.amountOf(price, u)
    assert.equal(ai.amountOf(price, u), a, 'the same inputs give the same amount')
    assert.equal(JSON.stringify([price, u]), snapshot, 'the inputs are not changed')
    assert.equal(units(a), reference(price, u), `amountOf(${JSON.stringify(price)}, ${JSON.stringify(u)}) = ${a}`)
    // Trailing zeros after the point carry no meaning (TAPI-20 §3.9). / 小数点后的尾零没有含义。
    const padded = Object.fromEntries(Object.entries(price).map(([k, v]) => [k, typeof v === 'string' && /^\d/.test(v) && v.includes('.') && v.split('.')[1].length < 8 ? v + '0' : v]))
    assert.equal(ai.amountOf(padded, u), a, 'a trailing zero does not change the amount')
  }, { runs: runsOf(2000), seed: seedOf(0xb1) })
})

test(`property (b2): maxAmountOf(bounds) >= amountOf(usage) for every usage within the bounds, and is reached by some usage (${runsOf(2000)} iterations, seed ${seedOf(0xb2)})`, async () => {
  await forAll(import.meta.url, (r) => {
    const price = drawPrice(r)
    const bounds = { promptTokens: r.int(3_000_000), completionTokens: r.int(3_000_000) }
    const max = units(ai.maxAmountOf(price, bounds))
    for (let k = 0; k < 4; k++) {
      const u = drawUsage(r, 1)
      // a usage within the bounds: scale a random draw into them / 界内的用量
      const prompt = r.int(bounds.promptTokens + 1), completion = r.int(bounds.completionTokens + 1)
      const read = r.p(0.6) ? r.int(prompt + 1) : 0, write = r.p(0.6) ? r.int(prompt - read + 1) : 0
      Object.assign(u, { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, cache_read_tokens: read, cache_write_tokens: write, cache_write_1h_tokens: write ? r.int(write + 1) : 0, reasoning_tokens: r.int(completion + 1) })
      const a = units(ai.amountOf(price, u))
      assert.ok(a <= max, `amountOf ${a} above maxAmountOf ${max} for ${JSON.stringify({ price, bounds, u })}`)
    }
    // tight: the dearest bucket for every token reaches it exactly / 上限可达：每个 token 都落在最贵的桶
    const top = (keys) => keys.filter((k) => price[k] !== undefined).reduce((a, k) => (frac8(price[k]) > frac8(price[a]) ? k : a), keys[0])
    const pIn = top(['input', 'cacheRead', 'cacheWrite', 'cacheWrite1h']), pOut = top(['output', 'reasoning'])
    const P = bounds.promptTokens, C = bounds.completionTokens
    const worst = { prompt_tokens: P, completion_tokens: C, total_tokens: P + C }
    if (pIn === 'cacheRead') worst.cache_read_tokens = P
    if (pIn === 'cacheWrite') worst.cache_write_tokens = P
    if (pIn === 'cacheWrite1h') { worst.cache_write_tokens = P; worst.cache_write_1h_tokens = P }
    if (pOut === 'reasoning') worst.reasoning_tokens = C
    assert.equal(units(ai.amountOf(price, worst)), max, `the bound is reached: ${JSON.stringify({ price, bounds, worst })}`)
  }, { runs: runsOf(2000), seed: seedOf(0xb2) })
})

test(`property (b3): completionLimitOf is monotone in max_tokens, max_completion_tokens, n and max_output_tokens (${runsOf(2000)} iterations, seed ${seedOf(0xb3)})`, async () => {
  const maybe = (r, v) => (r.p(0.25) ? undefined : v)
  await forAll(import.meta.url, (r) => {
    const format = r.pick(['openai-chat', 'openai-responses', 'anthropic-messages', 'openai-embeddings'])
    const small = { max_tokens: maybe(r, r.int(100_000)), max_completion_tokens: maybe(r, r.int(100_000)), n: maybe(r, 1 + r.int(8)), max_output_tokens: maybe(r, r.int(100_000)) }
    // big >= small in every member small has; a member absent in small may be anything in big (absent is not a limit)
    const big = {}
    for (const [k, v] of Object.entries(small)) big[k] = v === undefined ? maybe(r, r.int(100_000)) : v + r.int(1000)
    const body = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
    const a = ai.completionLimitOf(body(small), format), b = ai.completionLimitOf(body(big), format)
    // monotone where the smaller one declares a limit: the bigger one declares one too, at least as large
    // 小的声明了上限时，大的也声明了上限，且不更小
    if (a !== null) {
      assert.notEqual(b, null, `${format}: ${JSON.stringify(body(small))} -> ${a} but ${JSON.stringify(body(big))} -> null`)
      assert.ok(b >= a, `${format}: ${JSON.stringify(body(small))} -> ${a}, ${JSON.stringify(body(big))} -> ${b}`)
    }
    if (format === 'openai-embeddings') assert.equal(a, 0)
    // pure: the body is not changed and the answer repeats / 纯函数
    const fb = deepFreeze(body(small)); assert.equal(ai.completionLimitOf(fb, format), a)
  }, { runs: runsOf(2000), seed: seedOf(0xb3) })
})

// ---------- end to end: the sidecar's receipt prices / 端到端：旁路回执里的价格 ----------
// Random tables; the upstream reports usage in the format's own shape; the receipt's usage must be the test's own mapping
// of those counts (an adapter bug shows here, which comparing with amountOf alone would not), and each price the reference.
// 随机价目表；上游以格式自身的形状报用量；回执的 usage 必须等于测试自己的映射（适配器缺陷在这里暴露），每个价格等于参考值。
const CURRENCIES = ['BEM', 'BNB', 'USDT', 'USDC', 'ETH', 'USD1', 'USD']
function nativeAnswer(r, format, model) {
  const prompt = r.int(500_000), completion = format === 'openai-embeddings' ? 0 : r.int(200_000)
  const read = r.p(0.5) ? r.int(prompt + 1) : 0, write = format === 'anthropic-messages' && r.p(0.5) ? r.int(prompt - read + 1) : 0
  const write1h = write && r.p(0.5) ? r.int(write + 1) : 0, reasoning = format !== 'anthropic-messages' && r.p(0.5) ? r.int(completion + 1) : 0
  const total = prompt + completion
  if (format === 'openai-embeddings') return { body: { object: 'list', data: [], model, usage: { prompt_tokens: prompt, total_tokens: prompt } }, expect: { prompt_tokens: prompt, completion_tokens: 0, total_tokens: prompt } }
  if (format === 'anthropic-messages') {
    const usage = { input_tokens: prompt - read - write, output_tokens: completion, cache_read_input_tokens: read, cache_creation_input_tokens: write, ...(write1h ? { cache_creation: { ephemeral_5m_input_tokens: write - write1h, ephemeral_1h_input_tokens: write1h } } : {}) }
    return { body: { id: 'msg_p', type: 'message', role: 'assistant', model, content: [], stop_reason: 'end_turn', usage }, expect: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total, cache_read_tokens: read, cache_write_tokens: write, ...(write1h ? { cache_write_1h_tokens: write1h } : {}) } }
  }
  if (format === 'openai-responses') {
    return { body: { id: 'resp_p', object: 'response', status: 'completed', model, output: [], usage: { input_tokens: prompt, output_tokens: completion, total_tokens: total, input_tokens_details: { cached_tokens: read }, output_tokens_details: { reasoning_tokens: reasoning } } }, expect: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total, cache_read_tokens: read, reasoning_tokens: reasoning } }
  }
  return { body: { id: 'chatcmpl-p', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total, prompt_tokens_details: { cached_tokens: read }, completion_tokens_details: { reasoning_tokens: reasoning } } }, expect: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total, cache_read_tokens: read, reasoning_tokens: reasoning } }
}
const PATHS = { 'openai-chat': '/v1/chat/completions', 'openai-responses': '/v1/responses', 'anthropic-messages': '/v1/messages', 'openai-embeddings': '/v1/embeddings' }

test(`property (b4): the sidecar's receipt prices equal amountOf and the reference, for random tables and native usage (${runsOf(200)} iterations, seed ${seedOf(0xb4)})`, async () => {
  await forAll(import.meta.url, async (r) => {
    const format = r.pick(Object.keys(PATHS))
    const currencies = r.shuffle(CURRENCIES).slice(0, 1 + r.int(3))
    const prices = currencies.map((c) => drawPrice(r, c))
    const model = `m-${r.int(1e6)}`
    let answer = null
    const proxy = createAIProxy({
      upstream: { baseUrl: 'http://upstream.local/v1' }, fetch: async () => new Response(JSON.stringify(answer.body), { status: 200, headers: { 'content-type': 'application/json' } }),
      manifestBase: { name: 'Price property', circuits: '0x0000000000000000000000000000000000000000', tokenId: '0', container: '0x' + '7a'.repeat(20), delegation: null, dev: true, endpoints: { live: ['http://127.0.0.1:8797/tapeapi/v1'], async: false } },
      signerKey: '0x' + '42'.repeat(32), models: [{ id: model, formats: [format], prices }], allowHttp: true, rateLimit: false, log: () => {},
    })
    await proxy.ready
    answer = nativeAnswer(r, format, model)
    const body = JSON.stringify({ model, ...(format === 'openai-embeddings' ? { input: 'x' } : format === 'openai-responses' ? { input: 'x' } : { messages: [], max_tokens: 9 }) })
    const res = await proxy.handleRequest(new Request('http://127.0.0.1:8797' + PATHS[format], { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer k', 'x-api-key': 'k' }, body }), { clientIp: '127.0.0.1' })
    const out = new Uint8Array(await res.arrayBuffer())
    const env = ai.decodeReceiptHeader(res.headers.get(ai.RECEIPT_HEADER))
    assert.equal(res.status, 200)
    assert.deepEqual(env.result.usage, answer.expect, `${format}: the receipt's usage is the upstream's counts in the receipt's buckets`)
    assert.deepEqual(env.result.prices.map((x) => x.currency), currencies, 'one amount per price entry, in the table\'s order')
    for (const [k, p] of prices.entries()) {
      assert.equal(env.result.prices[k].amount, ai.amountOf(p, env.result.usage))
      assert.equal(units(env.result.prices[k].amount), reference(p, answer.expect), `${p.currency}: ${JSON.stringify(p)} × ${JSON.stringify(answer.expect)}`)
    }
    const v = ai.verifyUsageReceipt({ envelope: env, manifest: proxy.manifest(), requestBytes: body, responseBytes: out, status: 200, stream: false })
    assert.deepEqual(v.problems, [])
  }, { runs: runsOf(200), seed: seedOf(0xb4) })
})
