// 2.5 (experimental): the price arithmetic a billing layer in front of a sidecar needs, from the public `ai` entry, so an
// operator does not re-implement it: amountOf / pricesOf (the rule every receipt is signed with), maxAmountOf /
// maxPricesOf (a worst-case hold before forwarding) and completionLimitOf (the completion limit a request declares).
// amountOf is checked against every receipt of the shared test vectors (sdk/test/fixtures/ai-receipt-vectors.json).
// 2.5（实验性）：计费层需要的价格计算，从公开的 ai 入口导出，运营方不必自己重写。amountOf 对照共享测试向量里的每一张回执。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as pub from '@tapeapi/sdk/ai'
import { ai as rootAi } from '@tapeapi/sdk'

const VECTORS = JSON.parse(readFileSync(new URL('./fixtures/ai-receipt-vectors.json', import.meta.url), 'utf8'))
const NAMES = ['amountOf', 'pricesOf', 'maxAmountOf', 'maxPricesOf', 'completionLimitOf']

test('2.5: the billing helpers are exported from @tapeapi/sdk/ai and from the root ai namespace', () => {
  for (const n of NAMES) {
    assert.equal(typeof pub[n], 'function', `@tapeapi/sdk/ai ${n}`)
    assert.equal(rootAi[n], pub[n], `root ai.${n} is the same function`)
  }
})

test('2.5: the public amountOf and pricesOf reproduce every amount of the receipt test vectors', () => {
  let checked = 0
  for (const c of VECTORS.cases) {
    const r = c.expected.result
    if (!r.prices) continue
    const entry = pub.modelEntryOf(VECTORS.manifest.ai.models, r.model)
    assert.ok(entry, `${c.name}: model ${r.model} is in the vectors' price table`)
    assert.deepEqual(pub.pricesOf(entry, r.usage), r.prices, c.name)
    for (const [i, p] of entry.prices.entries()) { assert.equal(pub.amountOf(p, r.usage), r.prices[i].amount, `${c.name} ${p.currency}`); checked++ }
  }
  assert.ok(checked >= 10, `checked ${checked} amounts`)
})

test('2.5: amountOf refuses what a receipt could not carry', () => {
  assert.throws(() => pub.amountOf({ input: 1, output: '1' }, { prompt_tokens: 1 }), { code: 'BAD_REQUEST' })
  assert.throws(() => pub.amountOf({ input: '1', output: '1' }, { completion_tokens: 1 }), { code: 'BAD_REQUEST' })
  assert.equal(pub.pricesOf({ prices: [{ currency: 'USDT', input: '1', output: '1' }] }, null), null)
})

test('2.5: maxAmountOf prices every prompt token at the dearest prompt bucket and every completion token at the dearer of output and reasoning', () => {
  // claude-x of the vectors: cacheWrite 3.75 and cacheWrite1h 6 are dearer than input 3. / 缓存写比输入贵。
  const bem = VECTORS.manifest.ai.models.find((m) => m.id === 'claude-x').prices[0]
  assert.equal(pub.maxAmountOf(bem, { promptTokens: 1_000_000, completionTokens: 0 }), '6.00000000')
  assert.equal(pub.maxAmountOf(bem, { promptTokens: 0, completionTokens: 1_000_000 }), '15.00000000')
  // gpt-x USDT: reasoning 12 is dearer than output 10. / 推理价高于输出价。
  const usdt = VECTORS.manifest.ai.models.find((m) => m.id === 'gpt-x').prices[0]
  assert.equal(pub.maxAmountOf(usdt, { promptTokens: 0, completionTokens: 1_000_000 }), '12.00000000')
  assert.equal(pub.maxAmountOf({ input: '1', output: '2' }, { promptTokens: 1, completionTokens: 0 }), '0.00000100')
  assert.equal(pub.maxAmountOf({ input: '0.00000001', output: '0' }, { promptTokens: 1, completionTokens: 0 }), '0.00000001', 'rounded up, never to 0')
  assert.equal(pub.maxAmountOf({ input: '1', output: '2' }, { promptTokens: 0, completionTokens: 0 }), '0.00000000')
  for (const bad of [{ promptTokens: -1, completionTokens: 0 }, { promptTokens: 1.5, completionTokens: 0 }, { promptTokens: 1 }, {}]) {
    assert.throws(() => pub.maxAmountOf({ input: '1', output: '1' }, bad), { code: 'BAD_REQUEST' }, JSON.stringify(bad))
  }
  assert.throws(() => pub.maxAmountOf({ input: '1', output: '1', cacheRead: '0.1234567891' }, { promptTokens: 1, completionTokens: 1 }), { code: 'BAD_REQUEST' })
})

test('2.5: maxAmountOf is never below amountOf for any usage within the bounds (every vector price, many splits)', () => {
  const units = (s) => { const [i, f = ''] = s.split('.'); return BigInt(i) * 10n ** 8n + BigInt((f + '00000000').slice(0, 8)) }
  for (const m of VECTORS.manifest.ai.models) {
    for (const p of m.prices) {
      for (const [P, C] of [[1, 1], [999, 7], [8100, 200], [123457, 4321], [1_000_000, 1]]) {
        const hold = units(pub.maxAmountOf(p, { promptTokens: P, completionTokens: C }))
        for (const cr of [0, Math.floor(P / 3)]) {
          for (const cw of [0, Math.floor(P / 2)]) {
            if (cr + cw > P) continue
            for (const cw1h of [0, Math.floor(cw / 2)]) {
              for (const rs of [0, C]) {
                for (const used of [[P, C], [Math.floor(P / 2), Math.floor(C / 2)]]) {
                  const u = { prompt_tokens: used[0], completion_tokens: used[1] }
                  if (cr + cw <= used[0]) Object.assign(u, { cache_read_tokens: cr, cache_write_tokens: cw, cache_write_1h_tokens: cw1h })
                  if (rs <= used[1]) u.reasoning_tokens = rs
                  assert.ok(units(pub.amountOf(p, u)) <= hold, `${m.id} ${p.currency} ${JSON.stringify(u)} within ${P}/${C}`)
                }
              }
            }
          }
        }
      }
    }
  }
})

test('2.5: maxPricesOf gives one hold per currency, in the entry order', () => {
  const entry = VECTORS.manifest.ai.models.find((m) => m.id === 'gpt-x')
  const hold = pub.maxPricesOf(entry, { promptTokens: 100_000, completionTokens: 32_000 })
  assert.deepEqual(hold.map((h) => h.currency), entry.prices.map((p) => p.currency))
  // USDT: 100k × 1.25 + 32k × 12 = 0.125 + 0.384 / 1e6 scale. / 按每百万 token 计。
  assert.equal(hold[0].amount, '0.50900000')
  assert.equal(pub.maxPricesOf({ id: 'x' }, { promptTokens: 1, completionTokens: 1 }), null)
})

test('2.5: completionLimitOf reads the completion limit each format declares, or null', () => {
  const L = pub.completionLimitOf
  assert.equal(L({ max_tokens: 256 }, 'openai-chat'), 256)
  assert.equal(L({ max_completion_tokens: 300, max_tokens: 256 }, 'openai-chat'), 300, 'the larger of the two')
  assert.equal(L({ max_completion_tokens: 100, n: 3 }, 'openai-chat'), 300, 'n choices are billed')
  assert.equal(L({ messages: [] }, 'openai-chat'), null)
  assert.equal(L({ max_output_tokens: 2048 }, 'openai-responses'), 2048)
  assert.equal(L({ max_tokens: 2048 }, 'openai-responses'), null, 'Responses names it max_output_tokens')
  assert.equal(L({ max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 2048 } }, 'anthropic-messages'), 4096)
  assert.equal(L({ input: 'x' }, 'openai-embeddings'), 0)
  assert.equal(L({ max_tokens: 10 }, pub.FORMATS.find((f) => f.name === 'anthropic-messages')), 10, 'an adapter works as well as its name')
  for (const bad of [-1, 1.5, '100', null]) assert.equal(L({ max_tokens: bad }, 'anthropic-messages'), null, String(bad))
  assert.equal(L('not an object', 'openai-chat'), null)
  assert.equal(L({ max_tokens: 1 }, 'some-future-format'), null)
})
