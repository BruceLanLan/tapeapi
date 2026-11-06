// tapeapi reconcile's buyer-side checks (sdk/src/reconcile-checks.js, wired in sdk/src/reconcile-cli.js; experimental):
// three patterns a buyer met when it set an upstream's usage against its own requests, reproduced with SYNTHETIC data
// (made-up model names, a scripted upstream in this file, no real key, nothing copied from anyone's logs):
//   1. input tokens the request does not account for: the same short request is counted 13, 83 and 323 prompt tokens by
//      three models, and 83 then 133 by one model;
//   2. an output limit not kept: max_tokens 8, completion_tokens 202 (194 of them reasoning);
//   3. one requested model reported under two names, one for streams and one for whole answers.
// The receipts are real signatures: the reference sidecar (createAIProxy) signs what the scripted upstream answers. The
// checks list facts with their receipt lines; they decide nothing, and nothing here says which model ran.
// 买家侧检查：用合成数据复现三类模式（虚构的模型名、本文件里的脚本化上游、没有真实密钥、不拷贝任何人的日志）。回执是真实签名。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, relative, isAbsolute } from 'node:path'
import { createAIProxy } from '../../server/src/ai-proxy.js'
import * as AI from '../src/ai.js'
import { fromBase64Url } from '../src/mcp.js'
import { runReconcile } from '../src/reconcile-cli.js'
import { requestFacts, units8, fromUnits8, policyOf, mandateSpend, patternChecks, CLASS_IGNORES } from '../src/reconcile-checks.js'

const KEY = '0x' + '42'.repeat(32)
const CONTAINER = '0x' + '7c'.repeat(20)
const OTHER = '0x' + '5d'.repeat(20)
const BEM = '0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a'
const TMP = mkdtempSync(join(tmpdir(), 'tapeapi-reconcile-checks-'))
test.after(() => rmSync(TMP, { recursive: true, force: true }))
const HOST = { readFileSync, readdirSync, statSync, writeFileSync, join, dirname, relative, isAbsolute }

// The price table: five made-up models, priced in USD and BEM; quirk-alias-s is an alias of quirk-alias.
// 价目表：五个虚构的模型，以 USD 与 BEM 计价；quirk-alias-s 是 quirk-alias 的别名。
const price = (input, output) => [{ currency: 'USD', unit: '1M tokens', input, output }, { currency: 'BEM', unit: '1M tokens', input: String(Number(input) * 10), output: String(Number(output) * 10) }]
const MODELS = [
  { id: 'quirk-small', formats: ['openai-chat'], prices: price('1', '2') },
  { id: 'quirk-hidden', formats: ['openai-chat'], prices: price('1', '2') },
  { id: 'quirk-hidden-big', formats: ['openai-chat'], prices: price('1', '2') },
  { id: 'quirk-long', formats: ['openai-chat'], prices: price('1', '2') },
  { id: 'quirk-alias', aliases: ['quirk-alias-s'], formats: ['openai-chat'], prices: price('1', '2') },
]

/**
 * The scripted upstream (OpenAI Chat Completions, JSON and server-sent events). prompt_tokens = 12 + the words of the
 * messages + what the model adds unseen: quirk-hidden 70 (then 50 more on each later call), quirk-hidden-big 310.
 * quirk-long answers 202 completion tokens, 194 of them reasoning, whatever max_tokens says. quirk-alias reports
 * itself as quirk-alias-s on a stream. / 脚本化上游：按模型加上看不见的输入 token、无视 max_tokens、流式时换一个模型名。
 */
function scriptedUpstream() {
  let hiddenCalls = 0
  return async (url, init) => {
    const body = JSON.parse(new TextDecoder().decode(init.body))
    const words = body.messages.map((m) => String(m.content).split(/\s+/).filter(Boolean).length).reduce((a, b) => a + b, 0)
    const hidden = body.model === 'quirk-hidden' ? 70 + 50 * hiddenCalls++ : body.model === 'quirk-hidden-big' ? 310 : 0
    const prompt = 12 + words + hidden
    const usage = body.model === 'quirk-long'
      ? { prompt_tokens: prompt, completion_tokens: 202, total_tokens: prompt + 202, completion_tokens_details: { reasoning_tokens: 194 } }
      : { prompt_tokens: prompt, completion_tokens: 3, total_tokens: prompt + 3 }
    const model = body.model === 'quirk-alias' && body.stream ? 'quirk-alias-s' : body.model
    const id = `chatcmpl-${Math.random().toString(36).slice(2, 10)}`
    if (!body.stream) {
      return new Response(JSON.stringify({ id, object: 'chat.completion', created: 1790000000, model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop', logprobs: null }], usage }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const ev = (o) => `data: ${JSON.stringify(o)}\n\n`
    const chunk = (delta, finish = null) => ({ id, object: 'chat.completion.chunk', created: 1790000000, model, choices: [{ index: 0, delta, finish_reason: finish }] })
    const text = ev(chunk({ role: 'assistant', content: 'ok' })) + ev(chunk({}, 'stop')) + (body.stream_options?.include_usage ? ev({ id, object: 'chat.completion.chunk', created: 1790000000, model, choices: [], usage }) : '') + 'data: [DONE]\n\n'
    return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
}

/**
 * The fixture: nine calls through the sidecar, each request's exact bytes saved in requests/, each signed receipt in
 * receipts.jsonl as a bare envelope (line n = call n), and the manifest next to them. / 夹具：九次调用、请求字节、回执与清单。
 */
let FIX = null
async function fixture() {
  if (FIX) return FIX
  const proxy = createAIProxy({
    upstream: { baseUrl: 'http://upstream.local/v1' }, fetch: scriptedUpstream(), signerKey: KEY, allowHttp: true, rateLimit: false, log: () => {},
    models: MODELS, formats: AI.FORMATS.filter((f) => f.name === 'openai-chat'),
    manifestBase: { name: 'Reconcile checks relay', circuits: '0x0000000000000000000000000000000000000000', tokenId: '0', container: CONTAINER, delegation: null, dev: true, endpoints: { live: ['http://127.0.0.1:1/tapeapi/v1'], async: false } },
  })
  const dir = join(TMP, 'fixture')
  mkdirSync(join(dir, 'requests'), { recursive: true })
  const calls = [
    { model: 'quirk-small', messages: [{ role: 'user', content: 'hi' }] },
    { model: 'quirk-hidden', messages: [{ role: 'user', content: 'hi' }] },
    { model: 'quirk-hidden-big', messages: [{ role: 'user', content: 'hi' }] },
    { model: 'quirk-hidden', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }] },
    { model: 'quirk-long', max_tokens: 8, messages: [{ role: 'user', content: 'count to three please' }] },
    { model: 'quirk-long', max_tokens: 500, messages: [{ role: 'user', content: 'count to four please' }] },
    { model: 'quirk-alias', messages: [{ role: 'user', content: 'name a colour for me' }] },
    { model: 'quirk-alias', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'name a fruit for me' }] },
    { model: 'quirk-alias', messages: [{ role: 'user', content: 'name a tree for me' }] },
  ]
  const envelopes = []
  for (const [i, body] of calls.entries()) {
    const bytes = JSON.stringify(body)
    const r = await proxy.handleRequest(new Request('http://127.0.0.1/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' }, body: bytes }), { clientIp: '127.0.0.1' })
    const text = await r.text()
    assert.equal(r.status, 200, text)
    const b64 = r.headers.get('x-tapeapi-receipt') ?? text.match(/^: tapeapi-receipt (\S+)$/m)?.[1]
    assert.ok(b64, `call ${i + 1} carries a receipt`)
    const env = JSON.parse(fromBase64Url(b64))
    const v = AI.verifyUsageReceipt({ envelope: env, manifest: proxy.manifest(), requestBytes: bytes })
    assert.ok(v.ok, `call ${i + 1}: the receipt verifies: ${v.problems.join('; ')}`)
    envelopes.push(env)
    writeFileSync(join(dir, 'requests', `call-${String(i + 1).padStart(2, '0')}.json`), bytes)
  }
  writeFileSync(join(dir, 'requests', 'unrelated.json'), JSON.stringify({ model: 'quirk-small', messages: [{ role: 'user', content: 'never sent' }] }))
  writeFileSync(join(dir, 'receipts.jsonl'), envelopes.map((e) => JSON.stringify(e)).join('\n') + '\n')
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(proxy.manifest(), null, 2))
  FIX = { dir, envelopes, calls, manifest: proxy.manifest() }
  return FIX
}

const seen = []
async function run(args, { cwd } = {}) {
  let out = '', err = ''
  const saved = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('no network in reconcile') }
  try {
    const r = await runReconcile(args, { host: HOST, cmd: 'tapeapi', version: '0.0.0-test', env: {}, isTTY: false, cwd: cwd ?? FIX.dir, stdout: (s) => { out += s }, stderr: (s) => { err += s } })
    seen.push(out, err)
    return { code: r.exitCode, out, err, json: out.startsWith('{') ? JSON.parse(out) : null }
  } finally { globalThis.fetch = saved }
}
const line = (n) => `receipts.jsonl:${n}`

test('the fixture: nine real receipts reproduce the three patterns (synthetic models, scripted upstream)', async () => {
  const f = await fixture()
  const u = f.envelopes.map((e) => e.result.usage)
  assert.deepEqual(u.slice(0, 4).map((x) => x.prompt_tokens), [13, 83, 323, 133], 'the same "hi": 13, 83, 323, then 133 on quirk-hidden again')
  assert.equal(u[4].completion_tokens, 202); assert.equal(u[4].reasoning_tokens, 194)
  assert.deepEqual(f.envelopes.slice(6).map((e) => [e.result.model, e.result.stream]), [['quirk-alias', false], ['quirk-alias-s', true], ['quirk-alias', false]])
  assert.equal(f.envelopes[7].result.modelMatchedBy, 'response', 'the alias is priced: the receipt names what the upstream reported')
})

test('--requests: the three patterns as findings, each with its receipt line and request file; exit 0 (facts do not change it)', async () => {
  await fixture()
  const r = await run(['--receipts', 'receipts.jsonl', '--requests', 'requests', '--json'])
  assert.equal(r.code, 0, r.err)
  const c = r.json.checks
  assert.equal(c.requests.files, 10); assert.equal(c.requests.joined, 9); assert.equal(c.requests.unused, 1)
  assert.equal(r.json.bill, null); assert.equal(r.json.counts.match, 0); assert.deepEqual(r.json.items, [])
  const by = (k) => c.findings.filter((x) => x.kind === k)
  // 1. prompt tokens: across models, and within quirk-hidden / 跨模型，以及 quirk-hidden 自身
  const across = by('prompt-tokens-spread').find((x) => x.scope === 'across-models')
  assert.ok(across, 'the same "hi" across models')
  assert.equal(across.basis, 'request-bytes'); assert.equal(across.min, 13); assert.equal(across.max, 323)
  assert.deepEqual(across.items.map((x) => x.receipt), [line(1), line(2), line(3), line(4)])
  assert.ok(across.items.every((x) => /^requests\/call-0[1-4]\.json$/.test(x.request)), 'each item names its request file')
  const same = by('prompt-tokens-spread').find((x) => x.scope === 'same-model')
  assert.equal(same.model, 'quirk-hidden'); assert.equal(same.min, 83); assert.equal(same.max, 133)
  assert.deepEqual(same.items.map((x) => [x.receipt, x.stream]), [[line(2), false], [line(4), true]])
  const above = by('prompt-tokens-above-request-bytes')
  assert.deepEqual(above.map((x) => x.items[0].receipt), [line(2), line(3), line(4)], 'quirk-small: 13 tokens for a 67-byte request is not listed')
  assert.ok(above.every((x) => x.prompt_tokens > x.requestBytes))
  // 2. the output limit / 输出上限
  const lim = by('completion-above-request-limit')
  assert.equal(lim.length, 1, 'max_tokens 500 is kept, 8 is not')
  assert.deepEqual([lim[0].limit, lim[0].limitField, lim[0].completion_tokens, lim[0].reasoning_tokens, lim[0].ratio], [8, 'max_tokens', 202, 194, 25.25])
  assert.equal(lim[0].items[0].receipt, line(5))
  // 3. model names / 模型名
  const names = by('model-names-vary')
  assert.equal(names.length, 1)
  assert.equal(names[0].basis, 'requested-model'); assert.equal(names[0].requested, 'quirk-alias')
  assert.deepEqual(names[0].names, [{ name: 'quirk-alias', receipts: 2, stream: 0, nonStream: 2 }, { name: 'quirk-alias-s', receipts: 1, stream: 1, nonStream: 0 }])
  assert.deepEqual(names[0].items.map((x) => x.receipt), [line(7), line(8), line(9)])
  assert.deepEqual(c.counts, { 'prompt-tokens-spread': 2, 'prompt-tokens-above-request-bytes': 3, 'completion-above-request-limit': 1, 'model-names-vary': 1, 'model-name-differs-from-bill': 0 })
  assert.match(r.json.notes.findings.en, /does not prove which model ran/)
  assert.match(r.json.notes.salt.en, /salts each request/)
})

test('--requests text: a FINDINGS section with the lines, the limit of what a receipt proves, no verdict words', async () => {
  await fixture()
  const r = await run(['--receipts', 'receipts.jsonl', '--requests', 'requests', '--lang', 'en'])
  assert.equal(r.code, 0)
  assert.match(r.out, /FINDINGS: 7 \(facts, not verdicts\)/)
  assert.match(r.out, /prompt_tokens differ for one request: across 4 models|prompt_tokens differ for one request: across 3 models/)
  assert.match(r.out, /completion_tokens 202 \(of which reasoning 194\), the request set max_tokens 8 \(25\.25×\)/)
  assert.match(r.out, /requested quirk-alias: quirk-alias ×2 \(stream 0, non-stream 2\); quirk-alias-s ×1 \(stream 1, non-stream 0\)/)
  assert.match(r.out, /receipt receipts\.jsonl:5 .* request requests\/call-05\.json \d+ B model quirk-long max_tokens 8/)
  assert.match(r.out, /it does not prove which model ran/)
  const zh = await run(['--receipts', 'receipts.jsonl', '--requests', 'requests', '--lang', 'zh'])
  assert.match(zh.out, /发现：7 条（事实，不是结论）/)
  assert.match(zh.out, /completion_tokens 202（其中推理 194），请求设的 max_tokens 为 8（25\.25 倍）/)
})

test('without request bytes: a --no-salt log repeats a hash only for identical bytes; a snapshot groups names by price-table entry', async () => {
  await fixture()
  const r = await run(['--receipts', 'receipts.jsonl', '--policy', writePolicy('p-any.json', { tapeapiPolicy: 1, rules: [{ period: 'total', maxCalls: 100 }] }), '--json'])
  assert.equal(r.code, 0)
  const k = r.json.checks.findings.map((x) => `${x.kind}/${x.basis}`)
  assert.deepEqual(k, ['model-names-vary/manifest-entry'], 'no request facts: no prompt or limit finding; the names by the snapshot entry')
  assert.equal(r.json.checks.findings[0].entry, 'quirk-alias')
  // two byte-identical requests (as a --no-salt log has them) share a requestSha256 / 字节相同的请求共享哈希
  const claims = [1, 2].map((n) => ({ source: `x:${n}`, id: `a${n}`, container: CONTAINER, model: 'm', stream: false, prompt: n === 1 ? 20 : 40, completion: 1, reasoning: null, requestSha256: 'ab'.repeat(32), req: null, row: null }))
  const p = patternChecks(claims)
  assert.equal(p.findings[0].basis, 'request-sha256'); assert.equal(p.findings[0].scope, 'same-model')
})

test('--bill with request columns: the bill gives the request class, size and limit; an alias the join hides is listed', async () => {
  const f = await fixture()
  const rows = f.envelopes.map((e, i) => ({
    id: e.id, model: f.calls[i].model, prompt: e.result.usage.prompt_tokens, completion: e.result.usage.completion_tokens, time: e.ts,
    request: f.calls[i].messages[0].content === 'hi' ? 'R-hi' : `R-${i}`, bytes: JSON.stringify(f.calls[i]).length, max: f.calls[i].max_tokens ?? '',
  }))
  const csv = ['id,model,in,out,at,req,size,limit', ...rows.map((x) => [x.id, x.model, x.prompt, x.completion, x.time, x.request, x.bytes, x.max].join(','))].join('\n') + '\n'
  writeFileSync(join(f.dir, 'bill-req.csv'), csv)
  const r = await run(['--receipts', 'receipts.jsonl', '--bill', 'bill-req.csv', '--map', 'id=id,model=model,prompt=in,completion=out,time=at,request=req,request_bytes=size,max_tokens=limit', '--json'])
  assert.equal(r.code, 0, 'every row matches: the alias counts as the same model with the snapshot')
  assert.equal(r.json.counts.match, 9)
  const k = r.json.checks.findings.map((x) => `${x.kind}/${x.basis ?? '-'}`)
  assert.ok(k.includes('prompt-tokens-spread/bill-request-column'))
  assert.ok(k.includes('prompt-tokens-above-request-bytes/bill-request-bytes-column'))
  assert.ok(k.includes('completion-above-request-limit/bill-max-tokens-column'))
  assert.ok(k.includes('model-names-vary/bill-model-column'))
  const alias = r.json.checks.findings.find((x) => x.kind === 'model-name-differs-from-bill')
  assert.deepEqual([alias.receiptModel, alias.billModel, alias.items[0].receipt, alias.items[0].bill], ['quirk-alias-s', 'quirk-alias', line(8), 'bill-req.csv:9'])
  // an optional request column the bill lacks, when named, is still a usage mistake / 点名而账单没有的列仍是用法错误
  const bad = await run(['--receipts', 'receipts.jsonl', '--bill', 'bill-req.csv', '--map', 'id=id,model=model,prompt=in,completion=out,time=at,max_tokens=nope'])
  assert.equal(bad.code, 2); assert.match(bad.err, /no column max_tokens=nope/)
})

test('requestFacts: the output limit per format, the class leaves out model, stream and limits, a non-JSON body gives size only', () => {
  // CHANGED in 2.5: the limit is ai.completionLimitOf's (the larger of the two Chat members, times n), no longer the
  // first member present. / 上限改用 ai.completionLimitOf（Chat 两个字段取较大者再乘 n），不再取第一个出现的字段。
  const a = requestFacts(JSON.stringify({ model: 'x', max_completion_tokens: 5, max_tokens: 9, messages: [{ role: 'user', content: 'hi' }] }), 'openai-chat')
  assert.deepEqual([a.limit, a.limitField, a.limitN, a.requestedModel], [9, 'max_tokens', null, 'x'])
  const b = requestFacts(JSON.stringify({ messages: [{ content: 'hi', role: 'user' }], stream: true, model: 'y', max_tokens: 1 }) + ' \n\t ', 'openai-chat')
  assert.equal(a.classKey, b.classKey, 'key order, model, stream, the limits and a trailing salt do not change the class')
  assert.notEqual(a.sha256, b.sha256)
  assert.equal(requestFacts(JSON.stringify({ max_output_tokens: 7, input: 'q' }), 'openai-responses').limit, 7)
  assert.equal(requestFacts(JSON.stringify({ max_tokens: 3, messages: [] }), 'anthropic-messages').limitField, 'max_tokens')
  assert.deepEqual(Object.values((({ limit, limitField }) => ({ limit, limitField }))(requestFacts(JSON.stringify({ max_tokens: 3, input: 'e' }), 'openai-embeddings'))), [0, 'embeddings'], 'CHANGED in 2.5: Embeddings 0, as completionLimitOf')
  const c = requestFacts(new Uint8Array([0xff, 0xfe, 1]), 'openai-chat')
  assert.deepEqual([c.bytes, c.json, c.classKey], [3, false, null])
  assert.ok(CLASS_IGNORES.includes('stream_options'))
})

test('requestFacts uses ai.completionLimitOf: both Chat members, n > 1, each format, undeclared (the billing layer\'s rule)', () => {
  const chat = (o) => requestFacts(JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }], ...o }), 'openai-chat')
  const f = (r) => [r.limit, r.limitField, r.limitN]
  assert.deepEqual(f(chat({ max_completion_tokens: 100, max_tokens: 500 })), [500, 'max_tokens', null], 'the larger of the two')
  assert.deepEqual(f(chat({ max_completion_tokens: 500, max_tokens: 100 })), [500, 'max_completion_tokens', null])
  assert.deepEqual(f(chat({ max_completion_tokens: 7, max_tokens: 7 })), [7, 'max_completion_tokens', null], 'a tie names the first listed')
  assert.deepEqual(f(chat({ max_tokens: 8, n: 4 })), [32, 'max_tokens', 4], 'n choices are all billed')
  assert.deepEqual(f(chat({ max_completion_tokens: 10, max_tokens: 3, n: 3 })), [30, 'max_completion_tokens', 3])
  assert.deepEqual(f(chat({ max_tokens: 8, n: 1 })), [8, 'max_tokens', null])
  assert.deepEqual(f(chat({ n: 4 })), [null, null, null], 'undeclared')
  assert.deepEqual(f(chat({ max_tokens: -1 })), [null, null, null])
  // The same number as the public helper, over a grid of bodies and formats. / 与公开函数逐一相同。
  const bodies = []
  for (const mct of [undefined, 0, 5, 900]) for (const mt of [undefined, 0, 8, 500]) for (const n of [undefined, 1, 2, 4]) for (const mot of [undefined, 64]) {
    bodies.push(Object.fromEntries(Object.entries({ model: 'x', messages: [], max_completion_tokens: mct, max_tokens: mt, n, max_output_tokens: mot }).filter(([, v]) => v !== undefined)))
  }
  for (const format of ['openai-chat', 'openai-responses', 'anthropic-messages', 'openai-embeddings']) {
    for (const b of bodies) assert.equal(requestFacts(JSON.stringify(b), format).limit, AI.completionLimitOf(b, format), `${format} ${JSON.stringify(b)}`)
  }
})

test('completion-above-request-limit: n > 1 multiplies the limit (not listed within it, listed beyond it, with n in text and JSON)', async () => {
  const proxy = createAIProxy({
    upstream: { baseUrl: 'http://upstream.local/v1' }, fetch: scriptedUpstream(), signerKey: KEY, allowHttp: true, rateLimit: false, log: () => {},
    models: MODELS, formats: AI.FORMATS.filter((x) => x.name === 'openai-chat'),
    manifestBase: { name: 'Reconcile checks relay', circuits: '0x0000000000000000000000000000000000000000', tokenId: '0', container: CONTAINER, delegation: null, dev: true, endpoints: { live: ['http://127.0.0.1:1/tapeapi/v1'], async: false } },
  })
  const dir = join(TMP, 'fixture-n')
  mkdirSync(join(dir, 'requests'), { recursive: true })
  const calls = [
    { model: 'quirk-long', max_tokens: 64, n: 4, messages: [{ role: 'user', content: 'count to five please' }] }, // 256 >= 202: not listed
    { model: 'quirk-long', max_tokens: 40, n: 4, messages: [{ role: 'user', content: 'count to six please' }] }, // 160 < 202: listed
    { model: 'quirk-long', max_completion_tokens: 50, max_tokens: 300, messages: [{ role: 'user', content: 'count to seven please' }] }, // 300: not listed
  ]
  const envs = []
  for (const [i, body] of calls.entries()) {
    const bytes = JSON.stringify(body)
    const r = await proxy.handleRequest(new Request('http://127.0.0.1/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' }, body: bytes }), { clientIp: '127.0.0.1' })
    const text = await r.text()
    assert.equal(r.status, 200, text)
    envs.push(JSON.parse(fromBase64Url(r.headers.get('x-tapeapi-receipt'))))
    writeFileSync(join(dir, 'requests', `n-${i + 1}.json`), bytes)
  }
  writeFileSync(join(dir, 'receipts.jsonl'), envs.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const j = await run(['--receipts', 'receipts.jsonl', '--requests', 'requests', '--json'], { cwd: dir })
  assert.equal(j.code, 0, j.err)
  const lim = j.json.checks.findings.filter((x) => x.kind === 'completion-above-request-limit')
  assert.equal(lim.length, 1, 'only max_tokens 40 x n 4 = 160 is below 202')
  assert.deepEqual([lim[0].limit, lim[0].limitField, lim[0].limitN, lim[0].completion_tokens, lim[0].items[0].receipt], [160, 'max_tokens', 4, 202, 'receipts.jsonl:2'])
  const en = await run(['--receipts', 'receipts.jsonl', '--requests', 'requests', '--lang', 'en'], { cwd: dir })
  assert.match(en.out, /the request set max_tokens 40 × n 4 = 160/)
  const zh = await run(['--receipts', 'receipts.jsonl', '--requests', 'requests', '--lang', 'zh'], { cwd: dir })
  assert.match(zh.out, /请求设的 max_tokens 40 × n 4 = 160/)
})

// ── mandate / 授权书 ─────────────────────────────────────────────────────────────────────────────────────────────
const now = () => Math.floor(Date.now() / 1000)
const mandate = (scope, o = {}) => ({
  principal: '0x' + '11'.repeat(20), agent: '0x' + '22'.repeat(20), agentKey: '0x' + '33'.repeat(20), mode: 0, taskHash: '0x' + 'ab'.repeat(32), scope,
  feeToken: '0x0000000000000000000000000000000000000000', feeCap: '0', notBefore: now() - 3600, expires: now() + 3600, nonce: '1', subdelegate: false, ...o,
})
const writeJson = (name, v) => { writeFileSync(join(FIX.dir, name), JSON.stringify(v)); return name }
const writePolicy = writeJson

test('--mandate: per scope item the BEM the receipts claim against the cap (18 decimals); other containers and the period listed', async () => {
  const f = await fixture()
  const total = f.envelopes.reduce((a, e) => a + units8(e.result.prices.find((p) => p.currency === 'BEM').amount), 0n)
  const capFor = (units) => (units * 10n ** 10n).toString()   // 1e-8 units -> 18-decimal base units
  const file = writeJson('mandate.json', { mandate: mandate([{ provider: CONTAINER, token: BEM, cap: capFor(total * 9n / 10n) }, { provider: OTHER, token: BEM, cap: '1000' }]), signature: '0x00' })
  const r = await run(['--receipts', 'receipts.jsonl', '--mandate', file, '--token-decimals', '18', '--json'])
  assert.equal(r.code, 0)
  const m = r.json.mandate
  assert.equal(m.signatureChecked, false); assert.equal(m.phase0, false)
  assert.equal(m.scope[0].status, 'above-cap'); assert.equal(m.scope[0].receipts, 9); assert.equal(m.scope[0].spent, fromUnits8(total)); assert.equal(m.scope[0].currency, 'BEM')
  assert.deepEqual(m.scope[0].sources, f.envelopes.map((_, i) => line(i + 1)))
  assert.equal(m.scope[1].status, 'below-cap'); assert.equal(m.scope[1].receipts, 0)
  assert.deepEqual(m.counts, { aboveCap: 1, atCap: 0, nearCap: 0, belowCap: 1, notCompared: 0, outOfScopeReceipts: 0, outsidePeriod: 0 })
  assert.match(r.json.notes.mandate.en, /signature is not checked/)
  // near and at the cap / 接近与达到上限
  const near = await run(['--receipts', 'receipts.jsonl', '--mandate', writeJson('m-near.json', mandate([{ provider: CONTAINER, token: BEM, cap: capFor(total * 10n / 9n) }])), '--token-decimals', '18', '--json'])
  assert.equal(near.json.mandate.scope[0].status, 'near-cap')
  const at = await run(['--receipts', 'receipts.jsonl', '--mandate', writeJson('m-at.json', mandate([{ provider: CONTAINER, token: BEM, cap: capFor(total) }])), '--token-decimals', '18', '--json'])
  assert.equal(at.json.mandate.scope[0].status, 'at-cap')
  // without the decimals nothing is compared; text output says so / 不给小数位就不比较
  const nd = await run(['--receipts', 'receipts.jsonl', '--mandate', 'mandate.json', '--lang', 'en'])
  assert.equal(nd.code, 0)
  assert.match(nd.out, /MANDATE mandate\.json/)
  assert.match(nd.out, /not compared: give --token-decimals/)
})

test('--mandate: a phase-0 mandate names no funds (listed, not compared); a container outside the scope and a period that has ended', async () => {
  const f = await fixture()
  const r = await run(['--receipts', 'receipts.jsonl', '--mandate', writeJson('m0.json', mandate([{ provider: OTHER, token: '0x0000000000000000000000000000000000000000', cap: '0' }])), '--json'])
  const m = r.json.mandate
  assert.equal(m.phase0, true)
  assert.deepEqual([m.scope[0].status, m.scope[0].why], ['not-compared', 'phase-0-no-funds'])
  assert.equal(m.outOfScope.length, 1); assert.equal(m.outOfScope[0].receipts, 9)
  assert.equal(m.outOfScope[0].container.toLowerCase(), CONTAINER)
  assert.ok(m.outOfScope[0].spent.USD && m.outOfScope[0].spent.BEM)
  const t = await run(['--receipts', 'receipts.jsonl', '--mandate', 'm0.json', '--lang', 'zh'])
  assert.match(t.out, /阶段 0：不写金额/); assert.match(t.out, /不在 scope 里/)
  const old = await run(['--receipts', 'receipts.jsonl', '--mandate', writeJson('m-old.json', mandate([{ provider: CONTAINER, token: BEM, cap: '1' }], { notBefore: now() - 7200, expires: now() - 3600 })), '--token-decimals', '18', '--json'])
  assert.equal(old.json.mandate.outsidePeriod.receipts, 9); assert.equal(old.json.mandate.scope[0].receipts, 0)
  // a pure call: a token not listed needs a currency / 不在列表的代币需要指明币种
  const s = mandateSpend([], mandate([{ provider: OTHER, token: '0x' + '99'.repeat(20), cap: '5' }]), { tokenDecimals: 6 })
  assert.deepEqual([s.scope[0].status, s.scope[0].why], ['not-compared', 'no-currency'])
  assert.ok(f)
})

test('--mandate and --policy mistakes are exit 2 with a next line; options that need another one are refused', async () => {
  await fixture()
  for (const [args, re] of [
    [['--mandate', writeJson('not-mandate.json', { hello: 1 })], /is not a mandate/],
    [['--mandate', 'nope.json'], /cannot read the mandate/],
    [['--requests', 'requests', '--token-decimals', '18'], /--token-decimals applies with --mandate only/],
    [['--policy', writePolicy('p-typo.json', { tapeapiPolicy: 1, rules: [{ period: 'day', maxAmout: '1' }] })], /unknown key "maxAmout"/],
    [['--policy', writePolicy('p-none.json', { tapeapiPolicy: 1, rules: [{ period: 'day' }] })], /sets no limit/],
    [['--policy', writePolicy('p-cur.json', { tapeapiPolicy: 1, rules: [{ period: 'day', maxAmount: '1' }] })], /needs "currency"/],
    [['--requests', 'no-such-dir'], /cannot read --requests/],
    [['--map', 'model=m'], /--bill <file> is needed/],
  ]) {
    const r = await run(['--receipts', 'receipts.jsonl', ...args])
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}`)
    assert.equal(r.out, '')
    assert.match(r.err, re)
    assert.match(r.err.trimEnd().split('\n').pop(), /^next: \/ 下一条命令: tapeapi reconcile --help$/)
  }
  const m = await run(['--receipts', 'receipts.jsonl', '--requests', 'requests', '--map', 'model=m'])
  assert.equal(m.code, 2); assert.match(m.err, /--map applies with --bill only/)
})

test('--policy: per call, day and total, the windows whose receipts claim more than the file says; not enforced anywhere', async () => {
  const f = await fixture()
  const day = new Date(f.envelopes[0].ts * 1000).toISOString().slice(0, 10)
  const file = writePolicy('policy.json', { tapeapiPolicy: 1, note: 'my own limits', rules: [
    { name: 'one long answer', model: 'quirk-long', period: 'call', maxCompletionTokens: 100 },
    { name: 'daily spend', service: CONTAINER, period: 'day', maxAmount: '0.00001', currency: 'USD' },
    { name: 'calls in total', period: 'total', maxCalls: 20 },
    { name: 'another service', service: OTHER, period: 'month', maxCalls: 0 },
  ] })
  const r = await run(['--receipts', 'receipts.jsonl', '--policy', file, '--json'])
  assert.equal(r.code, 0)
  const p = r.json.policy
  assert.equal(p.over, 3)
  assert.deepEqual(p.rules[0].over.map((x) => [x.window, x.limit, x.value, x.max]), [[line(5), 'maxCompletionTokens', 202, 100], [line(6), 'maxCompletionTokens', 202, 100]])
  assert.equal(p.rules[1].over[0].window, day); assert.equal(p.rules[1].over[0].limit, 'maxAmount'); assert.match(p.rules[1].over[0].value, / USD$/)
  assert.equal(p.rules[1].over[0].sources.length, 9)
  assert.deepEqual([p.rules[2].over.length, p.rules[3].receipts, p.rules[3].over.length], [0, 0, 0])
  const t = await run(['--receipts', 'receipts.jsonl', '--policy', file, '--lang', 'en'])
  assert.match(t.out, /POLICY policy\.json {3}4 rules/)
  assert.match(t.out, /daily spend: .* per day {2}maxAmount 0\.00001 USD {3}9 receipts, 1 windows, 1 over/)
  assert.match(t.out, /it was not enforced when the calls were made/)
  assert.throws(() => policyOf({ tapeapiPolicy: 2, rules: [] }), /must be 1/)
  assert.throws(() => policyOf({ tapeapiPolicy: 1, rules: [{ period: 'week', maxCalls: 1 }] }), /period must be one of call, day, month, total/)
  assert.throws(() => policyOf({ tapeapiPolicy: 1, rules: [{ period: 'day', maxAmount: '0.000000001', currency: 'USD' }] }), /at most 8 places/)
})

// --fail-on (2.5, experimental): exit 4 instead of 0 when a named kind is listed; without it the exit status is as before.
// --fail-on：点名的种类被列出时退出 4 而不是 0；不给时退出码不变。
test('--fail-on: the default exit status is unchanged with findings, a cap and a policy over; each kind named turns 0 into 4; JSON says why', async () => {
  const f = await fixture()
  const total = f.envelopes.reduce((a, e) => a + units8(e.result.prices.find((p) => p.currency === 'BEM').amount), 0n)
  const capFor = (units) => (units * 10n ** 10n).toString()
  const m = writeJson('m-fail.json', mandate([{ provider: CONTAINER, token: BEM, cap: capFor(total * 9n / 10n) }]))
  const mOk = writeJson('m-fail-ok.json', mandate([{ provider: CONTAINER, token: BEM, cap: capFor(total * 2n) }]))
  const p = writePolicy('p-fail.json', { tapeapiPolicy: 1, rules: [{ model: 'quirk-long', period: 'call', maxCompletionTokens: 100 }] })
  const pOk = writePolicy('p-fail-ok.json', { tapeapiPolicy: 1, rules: [{ period: 'total', maxCalls: 1000 }] })
  const all = ['--receipts', 'receipts.jsonl', '--requests', 'requests', '--mandate', m, '--token-decimals', '18', '--policy', p]
  // Without --fail-on: 0, as in 2.4 and 2.7, and no failOn key. / 不给 --fail-on：0，JSON 没有 failOn 键。
  const d = await run([...all, '--json'])
  assert.equal(d.code, 0)
  assert.ok(d.json.checks.findings.length > 0 && d.json.mandate.counts.aboveCap === 1 && d.json.policy.over > 0, 'all three are listed')
  assert.equal('failOn' in d.json, false)
  for (const [kind, extra] of [['findings', []], ['mandate-above-cap', []], ['policy', []]]) {
    const r = await run([...all, '--fail-on', kind, '--json', ...extra])
    assert.equal(r.code, 4, kind)
    assert.equal(r.json.exitCode, 4); assert.equal(r.json.ok, false); assert.equal(r.json.next, null)
    assert.deepEqual(r.json.failOn.kinds, [kind]); assert.deepEqual(r.json.failOn.listed, [kind]); assert.ok(r.json.failOn.counts[kind] > 0)
  }
  const both = await run([...all, '--fail-on', 'policy,mandate-above-cap', '--json'])
  assert.deepEqual(both.json.failOn.counts, { policy: 2, 'mandate-above-cap': 1 })
  // Named but not listed: 0. / 点名了但没有列出：0。
  const quiet = await run(['--receipts', 'receipts.jsonl', '--mandate', mOk, '--token-decimals', '18', '--policy', pOk, '--fail-on', 'mandate-above-cap,policy', '--json'])
  assert.equal(quiet.code, 0); assert.deepEqual(quiet.json.failOn.listed, [])
  // Text: one line saying what was counted. / 文本：一行说明计数。
  const t = await run([...all, '--fail-on', 'findings', '--lang', 'en'])
  assert.equal(t.code, 4)
  assert.match(t.out, /--fail-on findings: findings \d+: exit 4\n$/)
  const z = await run([...all, '--fail-on', 'findings', '--lang', 'zh'])
  assert.match(z.out, /--fail-on findings：findings \d+：退出 4\n$/)
})

test('--fail-on: an exit of 1 (missing or differs) stays 1; mistakes are exit 2 with a next line', async () => {
  await fixture()
  // A bill with one row only: the other receipts are missing from it, so 1 whatever --fail-on says. / 只有一行的账单：退出 1。
  const e = FIX.envelopes[0]
  writeFileSync(join(FIX.dir, 'bill-one.csv'), `id,model,prompt,completion\n${e.result.id},${e.result.model},${e.result.usage.prompt_tokens},${e.result.usage.completion_tokens}\n`)
  const r = await run(['--receipts', 'receipts.jsonl', '--bill', 'bill-one.csv', '--map', 'id=id,model=model,prompt=prompt,completion=completion', '--requests', 'requests', '--fail-on', 'findings', '--json'])
  assert.equal(r.code, 1, r.err); assert.deepEqual(r.json.failOn.listed, ['findings'])
  for (const [args, re] of [
    [['--requests', 'requests', '--fail-on', 'verdicts'], /--fail-on: unknown kind "verdicts"/],
    [['--requests', 'requests', '--fail-on', ','], /--fail-on needs one or more of findings, mandate-above-cap, policy/],
    [['--requests', 'requests', '--fail-on', 'policy'], /--fail-on policy needs --policy/],
    [['--requests', 'requests', '--fail-on', 'mandate-above-cap'], /needs --mandate and --token-decimals/],
    [['--mandate', writeJson('m-fail-nd.json', mandate([{ provider: CONTAINER, token: BEM, cap: '1' }])), '--fail-on', 'mandate-above-cap'], /needs --mandate and --token-decimals/],
  ]) {
    const x = await run(['--receipts', 'receipts.jsonl', ...args])
    assert.equal(x.code, 2, args.join(' ')); assert.equal(x.out, ''); assert.match(x.err, re)
    assert.match(x.err.trimEnd().split('\n').pop(), /^next: \/ 下一条命令: tapeapi reconcile --help$/)
  }
  const help = await run(['--help'])
  assert.match(help.out, /--fail-on <kinds> {4}EXPERIMENTAL \(2\.5\): exit 4 instead of 0/)
  assert.match(help.out, /4 only with --fail-on/)
})

test('units8 / fromUnits8: exact 8-place amounts', () => {
  assert.equal(units8('1.5'), 150000000n); assert.equal(units8('0.00000001'), 1n); assert.equal(units8('1.000000001'), null); assert.equal(units8('-1'), null)
  assert.equal(fromUnits8(150000001n), '1.50000001'); assert.equal(fromUnits8(1n), '0.00000001')
})

test('reconcile checks: no network, no network module; no verdict wording in the output or the sources', async () => {
  for (const p of ['../src/reconcile-checks.js', '../src/reconcile-cli.js']) {
    const src = readFileSync(new URL(p, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /from 'node:(http|https|net|dns|tls|dgram|child_process)'|\bfetch\(|XMLHttpRequest|WebSocket/, p)
  }
  const FORBIDDEN = /认证|合作伙伴|推荐|欺诈|作弊|诈骗|骗|通过|采用|成为标准|已审计|主网可用|批准|certified|partner|recommend|fraud|cheat|scam|dishonest|\bfake\b|\blie[sd]?\b|substitut|swapped|hidden prompt|隐藏提示/i
  assert.ok(seen.length > 20)
  for (const text of seen) assert.doesNotMatch(text, FORBIDDEN)
  for (const p of ['../src/reconcile-checks.js']) assert.doesNotMatch(readFileSync(new URL(p, import.meta.url), 'utf8'), FORBIDDEN, p)
})
