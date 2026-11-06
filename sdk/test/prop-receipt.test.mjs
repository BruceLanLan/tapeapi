// Property: the AI usage receipt (TAPI-21 §3.5) binds exactly the bytes and the fields it signs. Random request bodies
// (random members, random JSON whitespace, random text) and random upstream answers (random usage in each format's own
// shape, random ids, a known or an unknown model) go through the reference sidecar; the receipt it signs must verify
// against those bytes, and must still verify after its JSON is re-serialised with the keys in another order (the
// envelope is canonicalised before signing). Then one mutation at a time: any single byte of the request or the
// response, or any one signed field of the envelope, and verifyUsageReceipt must refuse.
// A failure prints its seed; PROP_SEED=<n> PROP_RUNS=1 node --test sdk/test/prop-receipt.test.mjs replays one iteration.
// 性质：AI 用量回执精确绑定它签过的字节与字段。随机请求体与随机上游回答经参考旁路签出回执：必须按这些字节核验成功，键序打乱后
// 重新序列化也成功（信封签名前已规范化）；随后一次只改一处（请求或回答的任一字节、信封的任一签名字段），核验必须拒绝。
import test from 'node:test'
import assert from 'node:assert/strict'
import * as ai from '../src/ai.js'
import { createAIProxy } from '../../server/src/ai-proxy.js'
import { forAll, runsOf, seedOf } from './helpers/prng.mjs'

const KEY = '0x' + '42'.repeat(32)   // a test key / 测试密钥
const CONTAINER = '0x' + '7a'.repeat(20)
const pr = (currency, input, output, extra = {}) => ({ currency, unit: '1M tokens', input, output, ...extra })
const MODELS = [
  { id: 'p-chat', aliases: ['p-chat-2026'], formats: ['openai-chat', 'openai-responses'], prices: [pr('USDT', '1.25', '10', { cacheRead: '0.125', reasoning: '12' }), pr('BEM', '12.5', '100', { cacheRead: '1.25' })] },
  { id: 'p-claude', aliases: ['p-claude-20260901'], formats: ['anthropic-messages'], prices: [pr('BEM', '3', '15', { cacheRead: '0.3', cacheWrite: '3.75', cacheWrite1h: '6' }), pr('USD1', '0.3', '1.5', { cacheRead: '0.03', cacheWrite: '0.375' })] },
  { id: 'p-embed', formats: ['openai-embeddings'], prices: [pr('USDC', '0.02', '0')] },
]
const PATHS = { 'openai-chat': '/v1/chat/completions', 'openai-responses': '/v1/responses', 'anthropic-messages': '/v1/messages', 'openai-embeddings': '/v1/embeddings' }
const BASE = 'http://127.0.0.1:8797'

// The upstream answers whatever the iteration put in `answer`. / 上游回答当前迭代放进 answer 的内容。
let answer = null
const proxy = createAIProxy({
  upstream: { baseUrl: 'http://upstream.local/v1' }, fetch: async () => new Response(answer.body, { status: 200, headers: { 'content-type': 'application/json' } }),
  manifestBase: { name: 'Property relay', circuits: '0x0000000000000000000000000000000000000000', tokenId: '0', container: CONTAINER, delegation: null, dev: true, endpoints: { live: [`${BASE}/tapeapi/v1`], async: false } },
  signerKey: KEY, models: MODELS, allowHttp: true, rateLimit: false, log: () => {},
})

// ---------- generators / 生成器 ----------
// Counts that add up (usageOf refuses the rest, and the receipt would carry no usage). / 对得上的计数。
function drawCounts(r) {
  const prompt = r.int(5000), completion = r.int(3000)
  const cacheRead = r.p(0.5) ? r.int(prompt + 1) : 0
  const cacheWrite = r.p(0.5) ? r.int(prompt - cacheRead + 1) : 0
  const write1h = cacheWrite && r.p(0.5) ? r.int(cacheWrite + 1) : 0
  const reasoning = r.p(0.5) ? r.int(completion + 1) : 0
  return { prompt, completion, cacheRead, cacheWrite, write1h, reasoning }
}
const printableId = (r) => { const n = 1 + r.int(40); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(0x21 + r.int(0x7e - 0x21 + 1)); return s }
const modelFor = (r, format) => {
  const ok = MODELS.filter((m) => m.formats.includes(format))
  const m = r.pick(ok)
  return r.p(0.15) ? `unknown-${r.int(1000)}` : r.p(0.3) && m.aliases ? m.aliases[0] : m.id
}
// A JSON text with random whitespace between its tokens and after it. / 记号之间与末尾带随机空白的 JSON 文本。
function loose(r, value) {
  const ws = () => r.pick(['', '', '', ' ', '\t', '\n', '\r\n', '  '])
  const go = (v) => Array.isArray(v) ? `[${ws()}${v.map((x) => ws() + go(x) + ws()).join(',')}${ws()}]`
    : v && typeof v === 'object' ? `{${ws()}${Object.entries(v).map(([k, x]) => `${ws()}${JSON.stringify(k)}${ws()}:${ws()}${go(x)}${ws()}`).join(',')}}`
    : JSON.stringify(v)
  return ws() + go(value) + ws()
}
function drawRequest(r, format, model) {
  const extra = {}
  for (let i = 0; i < r.int(4); i++) extra[r.text(6)] = r.pick([r.text(20), r.int(1e6), r.bool(), null, [r.text(3), r.int(9)], { k: r.text(4) }])
  const body = format === 'openai-embeddings' ? { model, input: r.text(30), ...extra }
    : format === 'anthropic-messages' ? { model, max_tokens: 1 + r.int(4000), messages: [{ role: 'user', content: r.text(40) }], ...extra }
    : format === 'openai-responses' ? { model, input: r.text(40), ...(r.p(0.5) ? { max_output_tokens: 1 + r.int(4000) } : {}), ...extra }
    : { model, messages: [{ role: 'user', content: r.text(40) }], ...(r.p(0.5) ? { max_tokens: 1 + r.int(4000) } : {}), ...extra }
  return new TextEncoder().encode(loose(r, body))
}
// The upstream's answer in the format's own usage shape, and the usage the receipt should carry. / 上游回答与期望用量。
function drawAnswer(r, format, model) {
  const c = drawCounts(r), id = printableId(r)
  const details = (k, v) => (r.p(0.5) || v ? { [k]: v } : {})
  if (format === 'openai-embeddings') {
    return { body: loose(r, { object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.25, -0.5] }], model, usage: { prompt_tokens: c.prompt, total_tokens: c.prompt } }), expect: { prompt_tokens: c.prompt, completion_tokens: 0, total_tokens: c.prompt } }
  }
  if (format === 'anthropic-messages') {
    const usage = { input_tokens: c.prompt - c.cacheRead - c.cacheWrite, output_tokens: c.completion, ...(c.cacheRead || r.bool() ? { cache_read_input_tokens: c.cacheRead } : {}), ...(c.cacheWrite || r.bool() ? { cache_creation_input_tokens: c.cacheWrite } : {}), ...(c.write1h ? { cache_creation: { ephemeral_5m_input_tokens: c.cacheWrite - c.write1h, ephemeral_1h_input_tokens: c.write1h } } : {}) }
    const expect = { prompt_tokens: c.prompt, completion_tokens: c.completion, total_tokens: c.prompt + c.completion, ...(usage.cache_read_input_tokens !== undefined ? { cache_read_tokens: c.cacheRead } : {}), ...(usage.cache_creation_input_tokens !== undefined ? { cache_write_tokens: c.cacheWrite } : {}), ...(c.write1h ? { cache_write_1h_tokens: c.write1h } : {}) }
    return { body: loose(r, { id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: r.text(30) }], stop_reason: 'end_turn', usage }), expect }
  }
  const total = c.prompt + c.completion
  if (format === 'openai-responses') {
    const usage = { input_tokens: c.prompt, output_tokens: c.completion, total_tokens: total, ...(details('input_tokens_details', c.cacheRead).input_tokens_details !== undefined ? { input_tokens_details: { cached_tokens: c.cacheRead } } : {}), ...(c.reasoning || r.bool() ? { output_tokens_details: { reasoning_tokens: c.reasoning } } : {}) }
    const expect = { prompt_tokens: c.prompt, completion_tokens: c.completion, total_tokens: total, ...(usage.input_tokens_details ? { cache_read_tokens: c.cacheRead } : {}), ...(usage.output_tokens_details ? { reasoning_tokens: c.reasoning } : {}) }
    return { body: loose(r, { id, object: 'response', status: 'completed', model, output: [{ type: 'message', id: 'msg_' + id, role: 'assistant', content: [{ type: 'output_text', text: r.text(30) }] }], usage }), expect }
  }
  const usage = { prompt_tokens: c.prompt, completion_tokens: c.completion, total_tokens: total, ...(c.cacheRead || r.bool() ? { prompt_tokens_details: { cached_tokens: c.cacheRead } } : {}), ...(c.reasoning || r.bool() ? { completion_tokens_details: { reasoning_tokens: c.reasoning } } : {}) }
  const expect = { prompt_tokens: c.prompt, completion_tokens: c.completion, total_tokens: total, ...(usage.prompt_tokens_details ? { cache_read_tokens: c.cacheRead } : {}), ...(usage.completion_tokens_details ? { reasoning_tokens: c.reasoning } : {}) }
  return { body: loose(r, { id, object: 'chat.completion', created: 1790000000, model, choices: [{ index: 0, message: { role: 'assistant', content: r.text(30) }, finish_reason: 'stop' }], usage }), expect }
}

async function signed(format, requestBytes) {
  const path = PATHS[format]
  const res = await proxy.handleRequest(new Request(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' }, body: requestBytes }), { clientIp: '127.0.0.1' })
  const responseBytes = new Uint8Array(await res.arrayBuffer())
  const envelope = ai.decodeReceiptHeader(res.headers.get(ai.RECEIPT_HEADER))
  return { path, status: res.status, responseBytes, envelope }
}
const verify = (o) => ai.verifyUsageReceipt({ manifest: proxy.manifest(), ...o })
const flipByte = (r, bytes) => { const b = bytes.slice(); const i = r.int(b.length); b[i] = (b[i] + 1 + r.int(255)) & 0xff; return b }
const shuffled = (r, v) => (Array.isArray(v) ? v.map((x) => shuffled(r, x)) : v && typeof v === 'object' ? Object.fromEntries(r.shuffle(Object.entries(v)).map(([k, x]) => [k, shuffled(r, x)])) : v)
const hexFlip = (r, h) => { const i = r.int(h.length); const d = '0123456789abcdef'; return h.slice(0, i) + d[(d.indexOf(h[i]) + 1 + r.int(15)) % 16] + h.slice(i + 1) }

// Every signed field of the envelope, each with one way to change it. / 信封的每个签名字段与一种改法。
const MUTATIONS = [
  ['params.requestSha256', (e, r) => { e.params.requestSha256 = hexFlip(r, e.params.requestSha256) }],
  ['result.responseSha256', (e, r) => { e.result.responseSha256 = hexFlip(r, e.result.responseSha256) }],
  ['params.path', (e) => { e.params.path += 'x' }],
  ['id', (e) => { e.id += 'x' }],
  ['ts', (e, r) => { e.ts += r.pick([1, -1, 60]) }],
  ['container', (e) => { e.container = '0x' + '7b'.repeat(20) }],
  ['method', (e) => { e.method = e.method === 'openai_chat' ? 'openai_responses' : 'openai_chat' }],
  ['result.status', (e) => { e.result.status = e.result.status === 200 ? 201 : 200 }],
  ['result.stream', (e) => { e.result.stream = !e.result.stream }],
  ['result.complete', (e) => { e.result.complete = !e.result.complete }],
  ['result.model', (e) => { e.result.model = (e.result.model ?? '') + 'x' }],
  ['result.usage.prompt_tokens', (e) => { if (e.result.usage) e.result.usage.prompt_tokens += 1; else e.result.usage = { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } }],
  ['result.usage.completion_tokens', (e) => { if (e.result.usage) e.result.usage.completion_tokens += 1; else e.result.usage = { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } }],
  ['result.usage.total_tokens', (e) => { if (e.result.usage) e.result.usage.total_tokens += 1; else e.result.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 1 } }],
  ['result.prices[].amount', (e, r) => {
    if (!e.result.prices) { e.result.prices = [{ currency: 'USD', amount: '0.00000001' }]; return }
    const p = r.pick(e.result.prices); const i = p.amount.length - 1 - r.int(8); p.amount = p.amount.slice(0, i) + String((Number(p.amount[i]) + 1) % 10) + p.amount.slice(i + 1)
  }],
  ['result.prices[].currency', (e) => { if (e.result.prices) e.result.prices[0].currency = e.result.prices[0].currency === 'BEM' ? 'USD' : 'BEM'; else e.result.prices = [] }],
  ['result.modelMatchedBy', (e) => { e.result.modelMatchedBy = e.result.modelMatchedBy === 'response' ? 'request' : 'response' }],
  ['sig', (e, r) => { e.sig = hexFlip(r, e.sig.slice(2)); e.sig = '0x' + e.sig }],
]

test(`property (a): random request/answer bytes -> the sidecar's receipt verifies, canonicalisation is key-order free (but for the order the spec fixes), and every single-byte or single-field mutation is refused (${runsOf()} iterations, seed ${seedOf(0xa1)})`, async () => {
  await proxy.ready
  const seenFormats = new Set(), seenMutations = new Set()
  await forAll(import.meta.url, async (r, i) => {
    const format = r.pick(Object.keys(PATHS))
    const model = modelFor(r, format)
    const requestBytes = drawRequest(r, format, model)
    const reported = r.p(0.1) ? null : modelFor(r, format)
    answer = drawAnswer(r, format, reported)
    const { path, status, responseBytes, envelope } = await signed(format, requestBytes)
    assert.equal(status, 200, `the sidecar answered ${status}`)
    assert.ok(envelope, 'a receipt came back in the header')
    seenFormats.add(format)
    // 1. the receipt verifies against the exact bytes, with status and path / 按确切字节核验成功
    const v = verify({ envelope, requestBytes, responseBytes, path, status, stream: false })
    assert.deepEqual(v.problems, [], `the sidecar's own receipt must verify (format ${format}, model ${model}, reported ${reported})`)
    assert.equal(v.ok, true)
    assert.deepEqual(v.unchecked, ['freshness'], 'with both byte streams and the status given, only the freshness is unchecked')
    assert.deepEqual(envelope.result.usage, answer.expect, 'the usage is the upstream\'s counts in the receipt\'s buckets')
    // 2. canonicalisation: the signature is over canonical JSON, so the keys may come in any order at every depth, and
    // any whitespace -- except where TAPI-21 §3.6 check 1 fixes the order: `usage` members (TAPI-20 §3.9 order) and each
    // price entry ({ currency, amount }). There the order is part of the shape, and a reordering must be refused.
    // 规范化：签名覆盖规范 JSON，键序与空白任意；但 TAPI-21 §3.6 第 1 条固定了 usage 成员顺序与价格条目 { currency, amount }，
    // 在那里顺序是形状的一部分，打乱必须被拒绝。
    const free = shuffled(r, envelope)
    free.result.usage = envelope.result.usage; free.result.prices = envelope.result.prices
    const again = JSON.parse(loose(r, free))
    assert.deepEqual(verify({ envelope: again, requestBytes, responseBytes, path, status }).problems, [], 'key order and whitespace are not part of what is signed')
    if (envelope.result.usage && Object.keys(envelope.result.usage).length > 1) {
      const keys = Object.keys(envelope.result.usage)
      const order = r.shuffle(keys); if (order.join() === keys.join()) order.reverse()
      const re = JSON.parse(JSON.stringify(envelope)); re.result.usage = Object.fromEntries(order.map((k) => [k, envelope.result.usage[k]]))
      assert.ok(verify({ envelope: re, requestBytes, responseBytes }).problems.some((x) => /result\.usage must be/.test(x)), 'a reordered usage is refused (the order is in the spec)')
    }
    if (envelope.result.prices) {
      const re = JSON.parse(JSON.stringify(envelope)); re.result.prices = re.result.prices.map((x) => ({ amount: x.amount, currency: x.currency }))
      assert.ok(verify({ envelope: re, requestBytes, responseBytes }).problems.some((x) => /result\.prices must be/.test(x)), 'a price entry as { amount, currency } is refused')
    }
    // 3. one byte of the request, one byte of the response / 请求或回答的任一字节
    const badReq = verify({ envelope, requestBytes: flipByte(r, requestBytes), responseBytes })
    assert.ok(badReq.problems.includes('requestSha256 does not match the request that was sent'), `a flipped request byte is seen: ${badReq.problems}`)
    const badRes = verify({ envelope, requestBytes, responseBytes: flipByte(r, responseBytes) })
    assert.ok(badRes.problems.includes('responseSha256 does not match the response that was received'), `a flipped response byte is seen: ${badRes.problems}`)
    assert.equal(badReq.ok, false); assert.equal(badRes.ok, false)
    // 4. one signed field of the envelope / 信封的任一签名字段
    const [name, mutate] = MUTATIONS[i % MUTATIONS.length]
    const m = JSON.parse(JSON.stringify(envelope))
    mutate(m, r)
    assert.notDeepEqual(m, envelope, `${name}: the mutation changed something`)
    const bad = verify({ envelope: m, requestBytes, responseBytes, path, status, stream: false })
    assert.equal(bad.ok, false, `${name} changed, but the receipt still verified: ${JSON.stringify(m)}`)
    assert.ok(bad.problems.length > 0, `${name}: a problem is named`)
    seenMutations.add(name)
  }, { seed: seedOf(0xa1) })
  if (runsOf() >= 40) {
    assert.equal(seenFormats.size, 4, 'all four formats were drawn')
    assert.equal(seenMutations.size, MUTATIONS.length, 'every mutation was tried')
  }
})
