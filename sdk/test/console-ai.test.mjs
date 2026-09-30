// The holder console publishes an AI service's `ai` field (TAPI-20 §3.9: endpoints and price table). The page loads no
// library, so its check (site/console/lib.js aiProblems / normalizeAI) is a port of the SDK's ai.validateAIField; here
// every valid and invalid sample, and a few thousand random mutations of them, go through both, and the answers must be
// identical: accepted by both or refused by both with the same message, and the same normalised bytes.
// 持有人操作台发布 AI 服务的 ai 字段。页面不加载库，它的检查是 SDK validateAIField 的移植；这里把每个合法与非法样例、以及几千个
// 随机变异同时交给两边，结果必须完全相同：同时接受或同时以同一条消息拒绝，规范化后的字节也相同。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as C from '../../site/console/lib.js'
import { sig, MAINNET, MANIFEST_KEY, createTapeAPI } from '../src/index.js'
// The implementation module: CURRENCIES and the other limits are not in the public face (review RC-7). / 实现模块。
import * as ai from '../src/ai.js'
import { privateKeyToAddress } from '../src/sig.js'
import { validateManifest } from '../src/manifest.js'
import { createAIProxy } from '../../server/src/ai-proxy.js'
import { createFakeChain } from './helpers/fake-chain.mjs'

const V = JSON.parse(readFileSync(new URL('./fixtures/ai-receipt-vectors.json', import.meta.url), 'utf8'))
const EXAMPLE_MODELS = JSON.parse(readFileSync(new URL('../../examples/new-api-sidecar/models.example.json', import.meta.url), 'utf8'))
const BASE = 'https://api.example.com'

// ---------------------------------------------------------------- the corpus / 样例 ----
const P0 = { currency: 'USDT', unit: '1M tokens', input: '1', output: '2' }
// sdk/test/ai.test.mjs's `ok`: two endpoints (one of a future format, one with a trailing slash), every currency, unknown
// keys that are dropped, every price key in a scrambled order. / 与 ai.test.mjs 的 ok 相同。
const OK = { endpoints: [{ format: 'openai-chat', baseUrl: 'https://ai.example/v1/' }, { format: 'future-format', baseUrl: 'https://ai.example' }],
  models: ai.CURRENCIES.map((currency, i) => ({ id: `m${i}`, extra: 1, ...(i ? {} : { formats: ['openai-chat'], aliases: ['m0-2026'] }), prices: [{ currency, unit: '1M tokens', input: '1', output: '2.12345678', cacheRead: '0.5', junk: 1 }] })) }
OK.models[1].prices = ai.CURRENCIES.map((currency) => ({ reasoning: '3', cacheWrite1h: '2', cacheWrite: '1', cacheRead: '0.5', output: '2', input: '1', unit: '1M tokens', currency }))
// The example of TAPI-20 §3.9, as the spec writes it. / TAPI-20 §3.9 的示例。
const SPEC = { endpoints: [{ format: 'openai-chat', baseUrl: 'https://ai.example/v1' }, { format: 'anthropic-messages', baseUrl: 'https://ai.example' }],
  models: [
    { id: 'gpt-x', aliases: ['gpt-x-2026-09-01'], formats: ['openai-chat'], prices: [
      { currency: 'USDT', unit: '1M tokens', input: '1.25', output: '10', cacheRead: '0.125', reasoning: '12' },
      { currency: 'BEM', unit: '1M tokens', input: '12.5', output: '100', cacheRead: '1.25' }] },
    { id: 'claude-x', formats: ['anthropic-messages'], prices: [
      { currency: 'BEM', unit: '1M tokens', input: '3', output: '15', cacheRead: '0.3', cacheWrite: '3.75', cacheWrite1h: '6' }] }] }
const ep = (baseUrl, format = 'openai-chat') => ({ endpoints: [{ format, baseUrl }], models: [{ id: 'a', prices: [P0] }] })
const one = (m) => ({ ...OK, models: [{ id: 'a', prices: [P0], ...m }] })
const VALID = {
  'the receipt vectors\' ai field': V.manifest.ai,
  'ai.test.mjs ok': OK,
  'the TAPI-20 §3.9 example': SPEC,
  'models.example.json on the sidecar\'s endpoints': { endpoints: ai.FORMATS.map((f) => ({ format: f.name, baseUrl: BASE + f.baseSuffix })), models: EXAMPLE_MODELS },
  '16 aliases': one({ aliases: Array.from({ length: 16 }, (_, i) => `a${i}`) }),
  '256 models': { ...OK, models: Array.from({ length: 256 }, (_, i) => ({ id: `m${i}`, prices: [P0] })) },
  '16 endpoints': { endpoints: Array.from({ length: 16 }, (_, i) => ({ format: `f${i}`, baseUrl: `https://ai.example/${i}` })), models: [{ id: 'a', prices: [P0] }] },
  'an id of 256 code units, CJK and emoji': one({ id: '模'.repeat(254) + '😀' }),
  'the largest decimal': one({ prices: [{ ...P0, input: '999999999999999999.99999999' }] }),
  'zero prices': one({ prices: [{ ...P0, input: '0', output: '0.0', cacheRead: '0.00000000' }] }),
  'a port, a path, an IDN host and upper case': ep('https://AI.Example:8443/Relay/v1///'),
  'a lenient URL the parser repairs': ep('https:ai.example/v1'),
  'a null optional price': one({ prices: [{ ...P0, cacheRead: null }] }),
  'an unknown top-level key': { ...SPEC, note: 'x' },
}
const INVALID = {
  'not an object': 'ai', null: null, array: [SPEC], number: 1,
  'http endpoint': ep('http://ai.example/v1'),
  'query': ep('https://ai.example/v1?x=1'), fragment: ep('https://ai.example/v1#x'), credentials: ep('https://u:p@ai.example/v1'),
  'not a URL': ep('ai.example/v1'), 'a baseUrl that is not a string': ep(1),
  'no endpoints': { ...OK, endpoints: [] }, 'endpoints not an array': { ...OK, endpoints: {} },
  '17 endpoints': { endpoints: Array.from({ length: 17 }, (_, i) => ({ format: `f${i}`, baseUrl: `https://ai.example/${i}` })), models: [{ id: 'a', prices: [P0] }] },
  'one format twice': { ...OK, endpoints: [OK.endpoints[0], OK.endpoints[0]] },
  'a format name with a space': { ...OK, endpoints: [{ format: 'Bad Name', baseUrl: 'https://x.example' }] },
  'a format name of 65 characters': ep('https://ai.example/v1', 'a'.repeat(65)),
  'no models': { ...OK, models: [] }, '257 models': { ...OK, models: Array.from({ length: 257 }, (_, i) => ({ id: `m${i}`, prices: [P0] })) },
  'a model that is not an object': { ...OK, models: ['a'] },
  EUR: one({ prices: [{ ...P0, currency: 'EUR' }] }), 'lower-case currency': one({ prices: [{ ...P0, currency: 'usdt' }] }),
  'an exponent': one({ prices: [{ ...P0, input: '1e3' }] }), 'a number': one({ prices: [{ ...P0, reasoning: 2 }] }),
  '9 decimals': one({ prices: [{ ...P0, cacheWrite1h: '1.123456789' }] }), 'a leading zero': one({ prices: [{ ...P0, input: '01' }] }),
  'a sign': one({ prices: [{ ...P0, input: '-1' }] }), 'a space': one({ prices: [{ ...P0, input: ' 1' }] }), '19 integer digits': one({ prices: [{ ...P0, input: '1'.repeat(19) }] }),
  'no output': one({ prices: [{ ...P0, output: undefined }] }), 'a null input': one({ prices: [{ ...P0, input: null }] }),
  'another unit': one({ prices: [{ ...P0, unit: '1K tokens' }] }),
  'one currency twice': one({ prices: [P0, P0] }), 'no prices': one({ prices: [] }), 'a price object, not a list': one({ prices: P0 }),
  '8 prices': one({ prices: [...ai.CURRENCIES.map((currency) => ({ ...P0, currency })), P0] }),
  'the single price object': one({ prices: undefined, price: P0 }), 'price and prices': one({ price: P0 }),
  'an empty id': one({ id: '' }), 'an id of 257 code units': one({ id: 'x'.repeat(257) }), 'a control character in an id': one({ id: 'a\u0085' }),
  'no aliases in the list': one({ aliases: [] }), 'an alias equal to the id': one({ aliases: ['a'] }), 'an alias twice': one({ aliases: ['b', 'b'] }),
  'a control character in an alias': one({ aliases: ['x\u0007'] }), '17 aliases': one({ aliases: Array.from({ length: 17 }, (_, i) => `a${i}`) }),
  'an alias of one entry is the id of another': { ...OK, models: [{ id: 'a', prices: [P0] }, { id: 'b', aliases: ['a'], prices: [P0] }] },
  'two entries share an alias': { ...OK, models: [{ id: 'a', aliases: ['x'], prices: [P0] }, { id: 'b', aliases: ['x'], prices: [P0] }] },
  'one model twice': { ...OK, models: [OK.models[1], OK.models[1]] },
  'formats not among the endpoints': { ...OK, models: [{ ...OK.models[1], formats: ['anthropic-messages'] }] },
  'empty formats': one({ formats: [] }), 'a format twice': one({ formats: ['openai-chat', 'openai-chat'] }),
}

// Both sides on one input: the same verdict, message and bytes. / 两边对同一输入：结论、消息与字节都相同。
function same(x, opts, what) {
  let want, err
  try { want = ai.validateAIField(x, opts) } catch (e) { err = e }
  const got = C.aiProblems(x, opts)
  if (err) {
    assert.equal(err.code, 'MANIFEST_INVALID', what)
    assert.deepEqual(got, [err.message], `${what}: the SDK refuses with "${err.message}"`)
    assert.throws(() => C.normalizeAI(x, opts), { message: err.message }, what)
    return false
  }
  assert.deepEqual(got, [], `${what}: the SDK accepts it`)
  assert.equal(JSON.stringify(C.normalizeAI(x, opts)), JSON.stringify(want), `${what}: the same normalised bytes`)
  return true
}

test('the console\'s AI constants are the SDK\'s', () => {
  assert.deepEqual(C.AI_FORMATS.map((f) => [f.name, f.baseSuffix]), ai.FORMATS.map((f) => [f.name, f.baseSuffix]))
  assert.deepEqual(C.AI_CURRENCIES, ai.CURRENCIES)
  assert.deepEqual(Object.keys(C.AI_HUGE).sort(), [...ai.CURRENCIES].sort(), 'a hint threshold for every currency')
})

test('aiProblems / normalizeAI answer exactly as sdk ai.validateAIField on every sample, with and without allowHttp', () => {
  for (const allowHttp of [false, true]) {
    for (const [what, x] of Object.entries(VALID)) assert.equal(same(x, { allowHttp }, what), true, `${what} is a valid sample`)
    for (const [what, x] of Object.entries(INVALID)) {
      const ok = same(x, { allowHttp }, what)
      if (!(allowHttp && /http endpoint/.test(what))) assert.equal(ok, false, `${what} is an invalid sample`)
    }
  }
  assert.equal(same(ep('http://ai.example/v1'), { allowHttp: true }, 'http in dev'), true)
  assert.equal(same(ep('http://ai.example/v1'), {}, 'http by default'), false)
  // The fixture's field is already normalised, as the vectors test says. / 向量文件里的字段已是规范化形式。
  assert.deepEqual(C.normalizeAI(V.manifest.ai), V.manifest.ai)
})

test('aiProblems / normalizeAI agree with the SDK on 4,000 random mutations of the valid samples', () => {
  let seed = 0x5eed
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n }
  const pick = (a) => a[rnd(a.length)]
  const POOL = [undefined, null, '', 'x', 'a', 0, 1, -1, 1.5, true, [], {}, [1], { a: 1 }, '0', '01', '1e3', '1.123456789', ' 1', '1.', '.5', '12345678901234567890',
    'USDT', 'EUR', 'BEM', '1M tokens', '1m tokens', 'openai-chat', 'anthropic-messages', 'Bad Format', 'x'.repeat(257), 'a\u0007', 'a\u009f', '模型',
    'https://a.example/v1', 'https://a.example/v1?q=1', 'http://a.example/v1', 'https://u@a.example', 'ftp://a.example', 'https:a.example', 'gpt-x', 'm0', 'm0-2026']
  const paths = (v, at = []) => (v && typeof v === 'object') ? [at, ...Object.keys(v).flatMap((k) => paths(v[k], [...at, k]))] : [at]
  const bases = Object.values(VALID)
  let accepted = 0, refused = 0
  for (let i = 0; i < 4000; i++) {
    const x = structuredClone(pick(bases))
    for (let j = 0, n = 1 + rnd(2); j < n; j++) {
      const p = pick(paths(x))
      if (!p.length) continue
      const parent = p.slice(0, -1).reduce((o, k) => o[k], x), k = p.at(-1)
      const op = rnd(6)
      if (op === 0) { if (Array.isArray(parent)) parent.splice(Number(k), 1); else delete parent[k] }
      else if (op === 1 && Array.isArray(parent)) parent.push(structuredClone(parent[k]))                 // a duplicate / 重复一项
      else if (op === 2 && typeof parent[k] === 'string') parent[k] = parent[k] + pick(['0', '/', ' ', '.1', '\u0000', 'x'])
      else parent[k] = structuredClone(pick(POOL))
    }
    if (same(x, { allowHttp: rnd(2) === 1 }, `mutation ${i}: ${JSON.stringify(x).slice(0, 200)}`)) accepted++; else refused++
  }
  assert.ok(accepted > 400 && refused > 1500, `the fuzz reaches both answers (${accepted} accepted, ${refused} refused)`)
})

// ---------------------------------------------------------------- import: models.json -> ai / 导入 ----
test('modelsToAIField turns models.json into the field the new-api sidecar builds; aiFieldOf reads the three shapes', () => {
  const field = C.modelsToAIField(EXAMPLE_MODELS, BASE + '/')
  assert.deepEqual(field, { endpoints: ai.FORMATS.map((f) => ({ format: f.name, baseUrl: BASE + f.baseSuffix })), models: EXAMPLE_MODELS }, 'as examples/new-api-sidecar/server.mjs readModels builds it')
  assert.deepEqual(C.aiProblems(field), [])
  assert.deepEqual(C.normalizeAI(field), ai.validateAIField(field))
  assert.deepEqual(C.modelsToAIField(EXAMPLE_MODELS, 'http://127.0.0.1:8080').endpoints[2], { format: 'anthropic-messages', baseUrl: 'http://127.0.0.1:8080' }, 'a local sidecar')
  assert.deepEqual(C.aiProblems(C.modelsToAIField(EXAMPLE_MODELS, 'http://127.0.0.1:8080'), { allowHttp: true }), [])
  for (const base of ['', undefined, 'http://api.example.com', 'https://api.example.com/v1', 'https://u@api.example.com', 'api.example.com']) assert.throws(() => C.modelsToAIField(EXAMPLE_MODELS, base), /service URL/, String(base))
  assert.throws(() => C.modelsToAIField({ models: [] }, BASE), /array/)
  // The three shapes a holder may paste. / 持有人可能粘贴的三种形状。
  assert.deepEqual(C.aiFieldOf(EXAMPLE_MODELS, { base: BASE }), field)
  assert.equal(C.aiFieldOf(V.manifest.ai), V.manifest.ai)
  assert.equal(C.aiFieldOf(V.manifest), V.manifest.ai)
  for (const x of [null, 'x', 1, {}, { name: 'no ai' }]) assert.throws(() => C.aiFieldOf(x, { base: BASE }), /expected a models\.json array/)
  // Whatever an array of models holds, the page's verdict on its field is the SDK's. / 数组里是什么都行，结论与 SDK 相同。
  for (const models of [[], [{}], [{ id: 'a', price: P0 }], [...EXAMPLE_MODELS, EXAMPLE_MODELS[0]]]) same(C.modelsToAIField(models, BASE), {}, JSON.stringify(models).slice(0, 80))
  // A pasted file with a repeated key is refused before anything else, as the SDK's safeParseJSON would.
  assert.throws(() => C.strictParseJSON('[{"id":"a","id":"b","prices":[]}]'), /duplicate key/)
})

// ---------------------------------------------------------------- the published manifest / 发布的清单 ----
const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32)
const signer = privateKeyToAddress(SIGNER_KEY)
const container = V.container, circuits = '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414'
const expires = Math.floor(Date.now() / 1000) + 86400
const dsig = sig.signDigest(sig.delegationDigest(56, MAINNET.hub, { container, signer, expires }), HOLDER_KEY)
const S = { container, circuits, tokenId: '11', signer, expires, sig: dsig, endpoint: `${BASE}/tapeapi/v1` }
const sidecar = (models = EXAMPLE_MODELS, base = BASE) => createAIProxy({
  upstream: { baseUrl: 'http://127.0.0.1:9/v1' }, signerKey: SIGNER_KEY, models, log: () => {}, rateLimit: false, allowHttp: base.startsWith('http:'),
  manifestBase: { name: 'AI relay (TapeAPI sidecar)', circuits, tokenId: '11', container, delegation: { expires, sig: dsig }, endpoints: { live: [`${base}/tapeapi/v1`], async: false } },
})
const served = async (p, base = BASE) => (await p.handleRequest(new Request(`${base}/.well-known/tapeapi.json`))).text()

test('the new-api sidecar\'s manifest, ai field included, is publishable as served, and the page publishes exactly it', async () => {
  const text = await served(sidecar())
  const m = JSON.parse(text)
  assert.deepEqual(C.manifestProblems(text, S), [])
  const mine = C.manifestText({ ...S, name: m.name, methods: m.methods, ai: m.ai })
  assert.deepEqual(JSON.parse(mine), m, 'the page publishes exactly what the sidecar serves')
  assert.deepEqual(JSON.parse(mine).ai, C.normalizeAI(C.modelsToAIField(EXAMPLE_MODELS, BASE)), 'which is the imported models.json, converted')
  assert.doesNotThrow(() => validateManifest(JSON.parse(mine), { requireDelegation: true }), 'a valid TAPI-20 manifest')
  assert.equal(Object.keys(JSON.parse(mine)).at(-1), 'ai', 'ai comes last')
  const svc = await createTapeAPI({ dev: true }).resolve({ dev: JSON.parse(mine) })
  assert.equal(svc.aiProblems, undefined, 'a client keeps the field')
  assert.deepEqual(svc.manifest.ai, m.ai)
  // A local sidecar (loopback http) is publishable too, as a local service is. / 本地旁路（回环 http）同样可以发布。
  const local = 'http://127.0.0.1:8080'
  assert.deepEqual(C.manifestProblems(await served(sidecar(EXAMPLE_MODELS, local), local), { ...S, endpoint: `${local}/tapeapi/v1` }), [])
  // Nothing changes for a manifest without ai. / 没有 ai 的清单一个字节都不变。
  assert.equal(C.manifestText({ ...S }), C.manifestText({ ...S, ai: undefined }))
  assert.equal(JSON.parse(C.manifestText({ ...S })).ai, undefined)
})

test('manifestProblems refuses an ai field the SDK refuses, or one not in its normalised form', async () => {
  const good = JSON.parse(await served(sidecar()))
  const bad = (patch) => C.manifestProblems(JSON.stringify({ ...good, ai: patch(structuredClone(good.ai)) }), S)
  assert.deepEqual(bad((a) => { a.models = []; return a }), ['ai: models must hold 1 to 256 entries'], 'the SDK\'s message')
  assert.deepEqual(bad((a) => { a.models[0].prices[0].input = '1e3'; return a }), ['ai: models[0].prices[0].input must be a decimal string with at most 8 decimals'])
  assert.deepEqual(bad((a) => { a.endpoints[0].baseUrl = 'http://api.example.com/v1'; return a }), ['ai: endpoints[0].baseUrl must be https (http only in dev)'], 'http only for a local service')
  assert.match(bad((a) => { a.endpoints[0].baseUrl += '/'; return a }).join(), /^ai is .*expected/, 'a trailing slash: valid, but not what the page publishes')
  assert.match(bad((a) => { a.models[0].note = 'x'; return a }).join(), /^ai is .*expected/, 'an unknown key: dropped by the SDK, so not published as served')
  assert.deepEqual(bad((a) => { a.models.reverse(); return a }), [], 'another valid order is published as served (and shown so)')
  assert.throws(() => C.manifestText({ ...S, ai: { endpoints: [] } }), /ai: endpoints must hold/)
  // mcp and ai may both be present; anything else new is still refused. / mcp 与 ai 可以同时出现；别的新字段仍然拒绝。
  assert.ok(C.manifestProblems(JSON.stringify({ ...good, aix: good.ai }), S).some((p) => /unexpected field "aix"/.test(p)))
})

// ---------------------------------------------------------------- the price table the holder reads / 价目表 ----
const tableOf = (x) => C.aiPriceTable(C.normalizeAI(x))
const codes = (tb) => tb.hints.map((h) => `${h.code}${h.model ? ` ${h.model}` : ''}${h.currency ? ` ${h.currency}` : ''}${h.key ? ` ${h.key}` : ''}`)

test('aiPriceTable lists every endpoint and every model\'s prices per currency, with the spec\'s defaults marked', () => {
  const tb = tableOf(SPEC)
  assert.deepEqual(tb.endpoints, [{ format: 'openai-chat', api: 'OpenAI Chat Completions', baseUrl: 'https://ai.example/v1' }, { format: 'anthropic-messages', api: 'Anthropic Messages', baseUrl: 'https://ai.example' }])
  assert.deepEqual(tb.models.map((m) => [m.id, m.aliases, m.formats, m.prices.map((p) => p.currency)]), [['gpt-x', ['gpt-x-2026-09-01'], ['openai-chat'], ['USDT', 'BEM']], ['claude-x', [], ['anthropic-messages'], ['BEM']]])
  const [usdt, bem] = tb.models[0].prices
  assert.deepEqual(usdt.cells, { input: { value: '1.25', from: null }, output: { value: '10', from: null }, cacheRead: { value: '0.125', from: null }, cacheWrite: { value: '1.25', from: 'input' }, cacheWrite1h: { value: '1.25', from: 'input' }, reasoning: { value: '12', from: null } })
  assert.deepEqual(bem.cells.reasoning, { value: '100', from: 'output' }, 'without a reasoning price, reasoning tokens are output tokens')
  assert.deepEqual(tb.models[1].prices[0].cells.cacheWrite1h, { value: '6', from: null })
  assert.deepEqual(tableOf(one({ prices: [{ ...P0, cacheWrite: '3' }] })).models[0].prices[0].cells.cacheWrite1h, { value: '3', from: 'cacheWrite' }, '1-hour writes default to cacheWrite, then input')
  assert.deepEqual(codes(tb), [], 'the spec\'s example raises no hint')
  assert.deepEqual(codes(tableOf(V.manifest.ai)), [], 'nor the receipt vectors\' table')
  // The shipped example: only the display-only note for USD, and no false alarm for embeddings (output 0, below input).
  // 发布的示例：只有 USD 仅作展示的说明；嵌入模型（output 为 0、低于 input）不误报。
  const ex = tableOf(C.modelsToAIField(EXAMPLE_MODELS, BASE))
  assert.deepEqual(codes(ex), ['USD_DISPLAY'])
  assert.deepEqual(ex.hints[0].models, ['gpt-5-mini', 'claude-sonnet-4-5'])
  assert.equal(ex.endpoints.length, 4)
  assert.equal(ex.bytes, Buffer.byteLength(JSON.stringify(C.normalizeAI(C.modelsToAIField(EXAMPLE_MODELS, BASE)))))
})

test('aiPriceTable hints at zero, huge and inverted prices and at endpoints clients ignore, in both languages, never refusing', () => {
  const field = { endpoints: [{ format: 'openai-chat', baseUrl: 'https://ai.example/v1' }, { format: 'anthropic-messages', baseUrl: 'https://ai.example/v1' }, { format: 'openai-responses', baseUrl: 'https://ai.example' }, { format: 'gemini-x', baseUrl: 'https://ai.example' }],
    models: [
      { id: 'free', prices: [{ ...P0, input: '0' }] },
      { id: 'typo', prices: [{ ...P0, output: '15000' }, { currency: 'BNB', unit: '1M tokens', input: '0.001', output: '3' }, { currency: 'ETH', unit: '1M tokens', input: '0.6', output: '0.7' }, { currency: 'BEM', unit: '1M tokens', input: '1', output: '100000.1' }] },
      { id: 'swapped', prices: [{ ...P0, input: '10', output: '2.5', cacheRead: '11' }] },
      { id: 'embed', formats: ['openai-chat'], prices: [{ ...P0, output: '0' }] },
      { id: 'embed-ok', formats: ['openai-responses'], prices: [{ ...P0, output: '0' }] },
    ] }
  // formats must be among the endpoints: an embeddings-only entry needs the embeddings endpoint / formats 必须在端点之中
  field.endpoints.push({ format: 'openai-embeddings', baseUrl: 'https://ai.example/v1' })
  field.models[4].formats = ['openai-embeddings']
  assert.deepEqual(C.aiProblems(field), [], 'every hint is about a valid table: hints never block')
  const tb = C.aiPriceTable(C.normalizeAI(field))
  assert.deepEqual(codes(tb), [
    'BAD_SUFFIX', 'BAD_SUFFIX', 'UNKNOWN_FORMAT',
    'ZERO free USDT input',
    'HUGE typo USDT output', 'HUGE typo BNB output', 'HUGE typo ETH input', 'HUGE typo ETH output', 'HUGE typo BEM output',
    'OUTPUT_BELOW_INPUT swapped USDT', 'CACHE_READ_ABOVE_INPUT swapped USDT',
    'ZERO embed USDT output', 'OUTPUT_BELOW_INPUT embed USDT',
  ])
  assert.equal(tb.hints.find((h) => h.format === 'anthropic-messages').en, 'the anthropic-messages baseUrl is the service root itself, without /v1 (the official SDKs add /v1)')
  assert.equal(tb.hints.find((h) => h.format === 'openai-responses').en, 'the openai-responses baseUrl should end with /v1, or clients ignore this endpoint')
  for (const h of tb.hints) {
    assert.ok(h.zh && h.en && h.zh !== h.en, `${h.code} is bilingual`)
    assert.match(h.zh, /[一-鿿]/, `${h.code}: the Chinese text is Chinese`)
    assert.equal(h.level, 'warn')
  }
  assert.deepEqual(codes(tableOf({ ...ep('https://ai.example/v1'), models: [{ id: 'a', prices: [{ ...P0, input: '1000', output: '1000' }] }] })), [], 'the thresholds themselves are not hinted')
  // A table close to one transaction's limit. / 接近一笔交易上限的价目表。
  const big = { ...OK, models: Array.from({ length: 200 }, (_, i) => ({ id: `model-with-a-long-name-${i}`, prices: [{ ...P0, cacheRead: '0.1' }] })) }
  const tb2 = tableOf(big)
  assert.ok(tb2.bytes > C.MANIFEST_LIMIT - 1500)
  assert.ok(codes(tb2).includes('TOO_LARGE'))
})

test('aiDiff: the previewed table and the served one must be the same to the byte', () => {
  const a = C.normalizeAI(SPEC)
  assert.deepEqual(C.aiDiff(a, structuredClone(a)), [])
  const b = structuredClone(a); b.models[0].prices[0].output = '11'
  assert.deepEqual(C.aiDiff(a, b), ['model "gpt-x" differs'])
  const c = structuredClone(a); c.models.pop(); c.models.push({ id: 'GPT-X', prices: [P0] })
  assert.deepEqual(C.aiDiff(a, c), ['model "claude-x" is only in the previewed table', 'model "GPT-X" is only in the served table'], 'ids are case-sensitive')
  const d = structuredClone(a); d.endpoints[0].baseUrl = 'https://other.example/v1'
  assert.match(C.aiDiff(a, d).join(), /^endpoints: previewed/)
  const e = structuredClone(a); e.models.reverse()
  assert.deepEqual(C.aiDiff(a, e), ['the models are in another order'])
})

// ---------------------------------------------------------------- after publishing: read back / 发布后回读 ----
const sha256 = async (b) => createHash('sha256').update(b).digest('hex')
const chainCall = (chain) => async (to, data) => {
  const r = await (await chain.fetch('http://rpc', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) })).json()
  if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code })
  return r.result
}

test('readBackProblems: the bytes read back from the chain are exactly the ones sent, price table included', async () => {
  const m = JSON.parse(await served(sidecar()))
  const text = C.manifestText({ ...S, name: m.name, methods: m.methods, ai: m.ai })
  const chain = createFakeChain()
  assert.deepEqual(C.readBackProblems(await C.readManifestFile(chainCall(chain), container, sha256), text), ['there is no manifest on chain yet'], 'a node a block behind')
  chain.writeFile(container, MANIFEST_KEY, text)
  assert.deepEqual(C.readBackProblems(await C.readManifestFile(chainCall(chain), container, sha256), text), [])
  // Someone else's write in between: another price, another signer. / 中间有别人写入：别的价格、别的签名地址。
  const other = JSON.parse(text); other.ai.models[0].prices[0].input = '9'; other.signer = '0x' + '99'.repeat(20)
  chain.writeFile(container, MANIFEST_KEY, JSON.stringify(other))
  assert.deepEqual(C.readBackProblems(await C.readManifestFile(chainCall(chain), container, sha256), text), ['signer on chain differs from the one sent', 'ai on chain differs from the one sent'])
  const noAi = JSON.parse(text); delete noAi.ai
  assert.deepEqual(C.readBackProblems(JSON.stringify(noAi), text), ['ai was sent but is not on chain'])
  assert.deepEqual(C.readBackProblems(JSON.stringify(JSON.parse(text), null, 1), text), ['the manifest on chain has the same fields but other bytes'])
  assert.deepEqual(C.readBackProblems('nope', text), ['the manifest on chain is not the one sent'])
})

// ---------------------------------------------------------------- the page / 页面 ----
const js = readFileSync(new URL('../../site/console/console.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../../site/console/index.html', import.meta.url), 'utf8')

test('the page: the price table is checked, compared with the preview and shown before the wallet asks; read back after', () => {
  const pub = js.slice(js.indexOf("$('btn-publish').onclick"), js.indexOf("$('republish').onchange"))
  const at = (re) => { const i = pub.search(re); assert.ok(i > 0, String(re)); return i }
  const send = at(/eth_sendTransaction/)
  assert.ok(at(/C\.manifestProblems\(served, s\)/) < at(/C\.normalizeAI\(sm\.ai/), 'the served ai is checked as the SDK checks it first')
  assert.ok(at(/C\.aiDiff\(aiPreviewed, aiField\)/) < at(/C\.manifestText\(\{ \.\.\.s, name: sm\.name, methods: sm\.methods, mcp: sm\.mcp, ai: sm\.ai \}\)/), 'a previewed table must be the served one')
  assert.match(pub, /if \(diff\.length\) \{[^\n]*return \}/, 'a difference stops before anything is sent')
  assert.match(pub, /\} else if \(aiPreviewed\) \{[^\n]*return \}/, 'a preview without a served ai field stops too')
  const shown = at(/showPriceTable\(out, aiField\)/)
  assert.ok(shown < send, 'the price table is on screen before the wallet asks')
  const back = at(/C\.readBackProblems\(await readOnChain\(s\), text\)/)
  assert.ok(back > at(/eth_getTransactionReceipt/), 'read back once mined')
  assert.match(pub, /for \(let i = 0; i < 5; i\+\+\)[\s\S]*await sleep\(/, 'a lagging node gets a few tries')
  // The table is text, never markup; nothing about it is stored. / 价目表是纯文本；不存储。
  const show = js.slice(js.indexOf('function showPriceTable'), js.indexOf("$('btn-publish').onclick"))
  assert.match(show, /C\.aiPriceTable\(field\)/)
  // A DocumentFragment is emptied when appended: headers built once would vanish from the second table (the one shown
  // before the wallet asks, after a preview). / 片段插入后即清空：只建一次的表头会在第二次渲染（预览之后、钱包请求之前）消失。
  const cols = js.slice(js.indexOf('const AI_COLS'), js.indexOf('\n', js.indexOf('const AI_COLS')))
  assert.doesNotMatch(cols, /bi\(/, 'the column labels are strings')
  assert.match(show, /AI_COLS\.map\(\(\[, zh, en\]\) => cell\('th', bi\(zh, en\)\)\)/, 'built afresh on every render')
  assert.doesNotMatch(show, /innerHTML|insertAdjacentHTML|outerHTML/)
  assert.match(show, /h\.zh, h\.en/, 'every hint in both languages')
  assert.doesNotMatch(js, /localStorage[^\n]*ai|saveSvc\(\{[^}]*ai(Previewed|Field)?[,: }]/, 'the table is not stored')
  // The preview needs no wallet: enableSvc never touches it. / 预览不需要钱包：enableSvc 不管它。
  assert.doesNotMatch(js.slice(js.indexOf('const enableSvc'), js.indexOf('new MutationObserver')), /ai-/)
  assert.match(js, /C\.aiFieldOf\(C\.strictParseJSON\(text\), \{ base: aiBase\(\) \}\)/, 'pasted text is parsed strictly, then converted')
  assert.match(js, /\$\('ai-file'\)\.onchange/)
  assert.match(js, /\$\('ai-l2-note'\)\.hidden = CHAIN\.chainId === 56/, 'the L2 note shows on X Layer and Base')
})

test('the page: the price-table box sits in step 5 before the publish button, bilingual, and says prices are not settled', () => {
  const box = html.slice(html.indexOf('id="ai-box"'), html.indexOf('id="ai-out"'))
  assert.ok(html.indexOf('id="s-publish"') < html.indexOf('id="ai-box"') && html.indexOf('id="ai-box"') < html.indexOf('id="btn-publish"'))
  for (const id of ['ai-json', 'ai-file', 'btn-ai-preview', 'ai-l2-note']) assert.match(box, new RegExp(`id="${id}"`), id)
  assert.match(box, /<textarea id="ai-json"/)
  assert.match(box, /type="file" accept="application\/json,\.json"/)
  assert.match(box, /id="ai-l2-note" class="warn" hidden/)
  const zh = (box.match(/<span lang="zh">/g) || []).length, en = (box.match(/<span lang="en">/g) || []).length
  assert.ok(zh >= 5 && zh === en, `${zh} / ${en}`)
  assert.match(box, /价格只是公示/); assert.match(box, /Prices are published, not settled/)
  assert.match(box, /支付暂不开放/); assert.match(box, /payments are not open on these chains yet/)
  assert.match(box, /data-zh-placeholder=/); assert.match(box, /data-en-placeholder=/)
  assert.match(html, /\.scroll \{ overflow-x: auto/, 'a wide table scrolls in its box, not the page')
})
