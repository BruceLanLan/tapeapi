// Adversarial review of the client-side budget (3.0) and the reconcile checks (review BR-*, RC-*; internal, local only).
// Each finding is a test: FIXED <id> when this branch changes the code, CONFIRMED <id> when the behaviour stands as
// designed and is pinned here. On the reference sidecar (createAIProxy, real signatures) in front of a scripted upstream
// (made-up model names, no real key), on the budget alone with crafted envelopes, and through the real tapeapi-verify
// process for the privacy items. Property-style tests use a seeded generator (no new dependency).
// 客户端预算与对账检查的对抗性审查：每条发现一项测试（FIXED 为本分支修了代码，CONFIRMED 为按设计成立并钉住）。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, chmodSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAIProxy } from '../../server/src/ai-proxy.js'
import * as AI from '../src/ai.js'
import { createBudget, budgetFileStore, memoryBudgetStore, readBudgetLines } from '../src/budget.js'
import { units8, fromUnits8, policyOf, policyCheck } from '../src/policy.js'
import { readRecords, parseTime } from '../src/receipts-cli.js'
import { parseMap, columnsFor, reconcile, parseCsv } from '../src/reconcile-cli.js'
import { receiptStatement } from '../src/statement-cli.js'
import { cannedWorld, MODELS as CANNED } from './helpers/ai-canned.mjs'

const KEY = '0x' + '42'.repeat(32)
const CONTAINER = '0x' + '7c'.repeat(20)
const TMP = mkdtempSync(join(tmpdir(), 'tapeapi-review-budget-'))
test.after(() => rmSync(TMP, { recursive: true, force: true }))
const FS = { readFileSync, appendFileSync, chmodSync }
const HOST = { readFileSync, readdirSync, statSync, writeFileSync, join, dirname, relative, isAbsolute }
const total = (rules) => ({ tapeapiPolicy: 1, rules })
const tick = () => new Promise((r) => setTimeout(r, 10))

// ── the sidecar fixture (the reconcile fixture's prices; a scripted upstream) / 旁路夹具 ─────────────────────────────────────
// "snapshot": the upstream reports a dated name the price table does not list; "nousage": a 200 with no usage.
// "snapshot"：上游报告价目表里没有的带日期名字；"nousage"：不带 usage 的 200。
const price = (input, output) => [{ currency: 'USD', unit: '1M tokens', input, output }]
const MODELS = [
  { id: 'quirk-small', formats: ['openai-chat'], prices: price('1', '2') },
  { id: 'quirk-alias', aliases: ['quirk-alias-s'], formats: ['openai-chat'], prices: price('1', '2') },
]
function sidecar() {
  const seen = { calls: 0 }
  const upstream = async (url, init) => {
    const body = JSON.parse(new TextDecoder().decode(init.body))
    seen.calls++
    const text = body.messages.map((m) => m.content).join(' ')
    const usage = { prompt_tokens: 13, completion_tokens: 3, total_tokens: 16 }
    const model = text.includes('snapshot') ? `${body.model}-2026-01-01` : body.model === 'quirk-alias' && body.stream ? 'quirk-alias-s' : body.model
    const id = `chatcmpl-${Math.random().toString(36).slice(2, 10)}`
    if (!body.stream) {
      const o = { id, object: 'chat.completion', created: 1790000000, model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop', logprobs: null }] }
      if (!text.includes('nousage')) o.usage = usage
      return new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const ev = (o) => `data: ${JSON.stringify(o)}\n\n`
    const chunk = (delta, finish = null) => ({ id, object: 'chat.completion.chunk', created: 1790000000, model, choices: [{ index: 0, delta, finish_reason: finish }] })
    return new Response(ev(chunk({ role: 'assistant', content: 'ok' })) + ev(chunk({}, 'stop')) + (body.stream_options?.include_usage ? ev({ id, object: 'chat.completion.chunk', created: 1790000000, model, choices: [], usage }) : '') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const proxy = createAIProxy({
    upstream: { baseUrl: 'http://upstream.local/v1' }, fetch: upstream, signerKey: KEY, allowHttp: true, rateLimit: false, log: () => {},
    models: MODELS, formats: AI.FORMATS.filter((f) => f.name === 'openai-chat'),
    manifestBase: { name: 'Review relay', circuits: '0x0000000000000000000000000000000000000000', tokenId: '0', container: CONTAINER, delegation: null, dev: true, endpoints: { live: ['http://127.0.0.1:1/tapeapi/v1'], async: false } },
  })
  const service = { manifest: proxy.manifest(), container: CONTAINER, verified: { dev: true } }
  const fetch = (u, i) => proxy.handleRequest(new Request(u, i), { clientIp: '127.0.0.1' })
  return { seen, service, fetch, url: `${proxy.manifest().ai.endpoints[0].baseUrl}/chat/completions` }
}
const hi = (o = {}) => ({ model: 'quirk-small', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }], ...o })
async function call(vf, sc, body) {
  const res = await vf(sc.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' }, body: JSON.stringify(body) })
  if (body.stream) { const r = res.body.getReader(); for (;;) { const x = await r.read(); if (x.done) break } } else await res.text()
  return res
}
const worstOf = (body) => units8(AI.maxAmountOf(MODELS.find((m) => m.id === body.model).prices[0], { promptTokens: new TextEncoder().encode(JSON.stringify(body)).length + 64, completionTokens: body.max_tokens }))
// how many calls a fetch admits before it refuses / 一个 fetch 在拒绝之前放行几次
async function admitted(vf, sc, body, max = 8) {
  let n = 0
  for (; n < max; n++) {
    try { await call(vf, sc, body); await tick() } catch (e) { if (e.code === 'BUDGET_EXCEEDED' || e.code === 'INVALID_ARGUMENT') return { n, e }; throw e }
  }
  return { n, e: null }
}

// crafted envelopes for the budget alone (it does not verify: the fetch does) / 只给预算用的构造信封
const H = (i) => i.toString(16).padStart(64, '0')
let sigN = 0
const env = ({ ts = 1790000000, h, status = 200, model = 'm', usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, prices = [{ currency: 'USD', amount: '0.50000000' }], extra = {} }) =>
  ({ ...extra, container: CONTAINER, id: `chatcmpl-${++sigN}`, method: 'openai.chat.completions', params: { path: '/v1/chat/completions', requestSha256: h }, ok: true, ts, result: { status, model, usage, prices, responseSha256: H(0), stream: false, complete: true }, sig: '0x' + (++sigN).toString(16).padStart(130, '0') })
const aiCall = (i, o = {}) => ({ kind: 'ai', container: CONTAINER, models: ['m'], worstCase: { USD: '0.60000000' }, promptTokens: 10, completionTokens: 10, requestSha256: H(i), ...o })

// ── BR-1: a receipt that answers a sent line but is not counted / 回执关闭了 sent 行却没有被计入 ──────────────────
test('FIXED BR-1: a receipt reporting another name of the model (an alias, a dated snapshot) still counts under the model rule; one with no usage or no price counts at the worst case', async () => {
  const sc = sidecar()
  // (a) stream: the upstream reports the alias quirk-alias-s; the rule names quirk-alias. Before: claimed 0, every call admitted.
  // 流式：上游报告别名 quirk-alias-s，规则写的是 quirk-alias。修之前：声称计 0，每次都放行。
  const s = hi({ model: 'quirk-alias', stream: true })
  const w = worstOf(s), claim = units8(AI.amountOf({ input: '1', output: '2' }, { prompt_tokens: 13, completion_tokens: 3 }))
  const vf = AI.createVerifyingFetch({ service: sc.service, fetch: sc.fetch, policy: total([{ model: 'quirk-alias', period: 'total', maxAmount: fromUnits8(2n * claim + w), currency: 'USD' }]) })
  const a = await admitted(vf, sc, s)
  assert.equal(a.n, 3, 'exactly three fit, as the claims add up (before: all eight)')
  assert.equal(a.e?.code, 'BUDGET_EXCEEDED')
  // (b) the upstream reports a name the price table lacks: the receipt carries prices null; a "*" rule counted 0 before.
  // 上游报告价目表没有的名字：回执 prices 为 null；修之前 "*" 规则计 0。
  const snap = hi({ messages: [{ role: 'user', content: 'snapshot' }] })
  const reports = []
  const vf2 = AI.createVerifyingFetch({ service: sc.service, fetch: sc.fetch, onReport: (r) => reports.push(r), policy: total([{ period: 'total', maxAmount: fromUnits8(2n * worstOf(snap)), currency: 'USD' }]) })
  const b = await admitted(vf2, sc, snap)
  assert.ok(reports.some((r) => r.ok && r.receipt?.result?.prices === null), 'the receipt verified with no price')
  assert.equal(b.n, 2, 'counted at the worst case: two fit, the third is refused')
  // (c) a 200 with no usage (the receipt claims nothing): maxCalls counted it as no call before / 不带 usage 的 200：修之前 maxCalls 不计
  const nu = hi({ messages: [{ role: 'user', content: 'nousage' }] })
  const reports3 = []
  const vf3 = AI.createVerifyingFetch({ service: sc.service, fetch: sc.fetch, onReport: (r) => reports3.push(r), policy: total([{ period: 'total', maxCalls: 2 }]) })
  const c = await admitted(vf3, sc, nu)
  assert.ok(reports3.some((r) => r.ok && r.receipt?.result?.usage === null), 'the receipt verified with no usage')
  assert.equal(c.n, 2)
  // a signed status outside 2xx claims nothing and still closes its line / 签名的非 2xx 不声称任何数，照样关闭
  const bud = createBudget({ policy: total([{ period: 'total', maxAmount: '1', currency: 'USD' }]), clock: () => 1790000000 })
  await bud.admit(aiCall(1)); await bud.receipt(env({ h: H(1), status: 400, usage: null, prices: null }))
  assert.equal(bud.state().windows[0].worstCase.amount, '0.00000000'); assert.equal(bud.state().windows[0].claimed.amount, '0.00000000')
})

test('FIXED BR-2: a model the price table does not know is covered by every model rule of its service (fails closed), not skipped', async () => {
  const sc = sidecar()
  const vf = AI.createVerifyingFetch({ service: sc.service, fetch: sc.fetch, policy: total([{ model: 'quirk-small', period: 'day', maxAmount: '1', currency: 'USD' }]) })
  // another spelling an upstream may take for the same model / 上游可能接受的同一模型的另一种写法
  await assert.rejects(call(vf, sc, hi({ model: 'QUIRK-SMALL' })), (e) => e.code === 'INVALID_ARGUMENT' && e.data.reason === 'budget-no-price')
  assert.equal(sc.seen.calls, 0)
  // a known model of another entry is still not this rule's / 另一个已知条目的模型仍不归这条规则
  const other = AI.createVerifyingFetch({ service: sc.service, fetch: sc.fetch, policy: total([{ model: 'quirk-small', period: 'total', maxCalls: 0 }]) })
  await call(other, sc, hi({ model: 'quirk-alias' }))
  assert.equal(sc.seen.calls, 1)
})

test('FIXED BR-3: limits an upstream may not apply fail closed: max_tokens 0, an n that is not a whole number >= 1, Responses previous_response_id / conversation', async () => {
  const s = { container: CONTAINER, manifest: { container: CONTAINER, ai: { endpoints: [{ format: 'openai-chat', baseUrl: 'http://x/v1' }, { format: 'openai-responses', baseUrl: 'http://x/v1' }], models: [{ id: 'm', prices: price('1', '2') }] } }, verified: { dev: true } }
  const chat = AI.FORMATS.find((f) => f.name === 'openai-chat'), resp = AI.FORMATS.find((f) => f.name === 'openai-responses')
  const of = (f, b) => AI.budgetCallOf(s, f, new TextEncoder().encode(JSON.stringify(b)))
  assert.equal(of(chat, { model: 'm', max_tokens: 10, messages: [] }).completionTokens, 10)
  assert.equal(of(chat, { model: 'm', max_tokens: 0, messages: [] }).completionTokens, null, 'a Go relay drops a zero max_tokens: no limit')
  assert.equal(of(chat, { model: 'm', max_tokens: 10, n: 1e300, messages: [] }).completionTokens, null, 'completionLimitOf would say 10')
  assert.equal(of(chat, { model: 'm', max_tokens: 10, n: 2.5, messages: [] }).completionTokens, null)
  assert.equal(of(chat, { model: 'm', max_tokens: 10, n: 3, messages: [] }).completionTokens, 30)
  assert.equal(of(resp, { model: 'm', max_output_tokens: 10, input: 'x' }).promptTokens > 0, true)
  assert.equal(of(resp, { model: 'm', max_output_tokens: 10, input: 'x', previous_response_id: 'resp_1' }).promptTokens, null)
  assert.equal(of(resp, { model: 'm', max_output_tokens: 10, input: 'x', conversation: 'conv_1' }).promptTokens, null)
  const b = createBudget({ policy: total([{ period: 'day', maxAmount: '1', currency: 'USD' }]) })
  for (const body of [{ model: 'm', max_tokens: 0, messages: [] }]) await assert.rejects(b.admit(of(chat, body)), (e) => e.data?.reason === 'budget-no-limit')
  await assert.rejects(b.admit(of(resp, { model: 'm', max_output_tokens: 10, previous_response_id: 'r' })), (e) => e.data?.reason === 'budget-no-limit' && /previous_response_id/.test(e.message))
  const p = createBudget({ policy: total([{ period: 'day', maxPromptTokens: 1000 }]) })
  await assert.rejects(p.admit(of(resp, { model: 'm', max_output_tokens: 10, previous_response_id: 'r' })), (e) => e.data?.reason === 'budget-no-limit')
  // the public completionLimitOf (2.5, shared with the server-side hold) is unchanged / 公开函数不变
  assert.equal(AI.completionLimitOf({ max_tokens: 0 }, 'openai-chat'), 0)
})

test('FIXED BR-4: a receipt answering a sent line is windowed at the sent line\'s time (the budget\'s clock), not the signer\'s', async () => {
  const now = Date.UTC(2026, 9, 22, 23, 59, 0) / 1000
  const b = createBudget({ policy: total([{ period: 'day', maxAmount: '1', currency: 'USD' }]), clock: () => now })
  let n = 0
  for (let i = 0; i < 5; i++) {
    try { await b.admit(aiCall(i)); n++; await b.receipt(env({ ts: now + 120, h: H(i) })) } catch (e) { assert.equal(e.code, 'BUDGET_EXCEEDED'); break }
  }
  assert.equal(n, 1, 'before: 5 (each claim landed in the next day)')
})

test('FIXED BR-5: a last line cut short by a crash does not swallow the next line written', async () => {
  const st = memoryBudgetStore('{"tapeapiSent":1,"id":"x","ts":1,"kind":"ai","conta')
  const b = createBudget({ policy: total([{ period: 'total', maxCalls: 3 }]), store: st, clock: () => 1790000000 })
  await b.admit(aiCall(1))
  const r = readBudgetLines(st.read())
  assert.deepEqual([r.sent.length, r.skipped.length], [1, 1])
  // and on a file, across a restart / 文件上，跨重启
  const file = join(TMP, 'cut.jsonl')
  writeFileSync(file, '{"tapeapiSent":1,"id":"y","ts":17', { mode: 0o600 })
  const one = createBudget({ policy: total([{ period: 'total', maxCalls: 2 }]), store: budgetFileStore(file, FS), clock: () => 1790000000 })
  await one.admit(aiCall(1))
  const again = createBudget({ policy: total([{ period: 'total', maxCalls: 2 }]), store: budgetFileStore(file, FS), clock: () => 1790000000 })
  await again.admit(aiCall(2))
  await assert.rejects(again.admit(aiCall(3)), (e) => e.code === 'BUDGET_EXCEEDED')
})

test('FIXED BR-6: a verified envelope carrying "tapeapiSent" or "tapeapiReleased" (top-level keys are not signed) is still read as a receipt', async () => {
  const forged = env({ h: H(7), extra: { tapeapiSent: 1, tapeapiReleased: 1 } })
  const text = JSON.stringify(forged) + '\n'
  const r = readBudgetLines(text)
  assert.deepEqual([r.receipts.length, r.sent.length, r.released.length], [1, 0, 0])
  const file = join(TMP, 'forged.jsonl'); writeFileSync(file, text)
  const rr = readRecords([file], { ...HOST, cwd: TMP })
  assert.deepEqual([rr.records.length, rr.sent.length, rr.released.length], [1, 0, 0])
})

test('FIXED BR-7: two budgets on one store file see each other\'s calls at the next admit (no lock: two admits at the same moment may still both pass)', async () => {
  const file = join(TMP, 'two.jsonl')
  const mk = () => createBudget({ policy: total([{ period: 'total', maxCalls: 3 }]), store: budgetFileStore(file, FS), clock: () => 1790000000 })
  const a = mk(), b = mk()
  await a.admit(aiCall(1)); await b.admit(aiCall(2)); await a.admit(aiCall(3))
  await assert.rejects(b.admit(aiCall(4)), (e) => e.code === 'BUDGET_EXCEEDED' && e.data.spent === 3, 'before: b saw only its own call')
  await assert.rejects(a.admit(aiCall(5)), (e) => e.code === 'BUDGET_EXCEEDED')
  // each line once, whoever reads it / 每行只计一次
  assert.equal(readBudgetLines(readFileSync(file, 'utf8')).sent.length, 3)
  assert.equal(mk().state().sent, 0, 'state() before the first read'); const c = mk(); await c.ready(); assert.equal(c.state().sent, 3)
})

test('CONFIRMED BR-8: a released line needs an HTTP 4xx/5xx with no receipt header; a sidecar can always answer one, and then nothing is claimed either', async () => {
  const sc = sidecar()
  const b = createBudget({ policy: total([{ period: 'total', maxAmount: '1', currency: 'USD' }]) })
  // a 4xx that carries a receipt header (even one that does not decode) is not released / 带回执头的 4xx 不撤下
  const withHeader = AI.createVerifyingFetch({ service: sc.service, fetch: async () => new Response('{}', { status: 400, headers: { 'content-type': 'application/json', 'x-tapeapi-receipt': 'garbage' } }), budget: b })
  await call(withHeader, sc, hi())
  await tick()
  assert.deepEqual([b.state().open, b.state().released], [1, 0])
  const without = AI.createVerifyingFetch({ service: sc.service, fetch: async () => new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } }), budget: b })
  await call(without, sc, hi())
  await tick()
  assert.deepEqual([b.state().open, b.state().released], [1, 1])
})

test('CONFIRMED BR-10: store lines cannot be injected through model names or ids (JSON escapes CR, LF; U+2028 does not split a line)', async () => {
  const st = memoryBudgetStore()
  const b = createBudget({ policy: total([{ period: 'total', maxCalls: 9 }]), store: st, clock: () => 1790000000 })
  await b.admit(aiCall(1, { models: ['m\n{"tapeapiReleased":1,"id":"x"}', 'm\r\n', 'm x'] }))
  await b.receipt(env({ h: H(1), model: 'm\n{"tapeapiSent":1,"ts":1}' }))
  const r = readBudgetLines(st.read())
  assert.deepEqual([r.sent.length, r.receipts.length, r.released.length, r.skipped.length], [1, 1, 0, 0])
})

test('CONFIRMED BR-11: policy edge cases: overlapping rules all apply; zero caps refuse; unknown keys fail; the service matches in any case', async () => {
  const C2 = CONTAINER.toUpperCase().replace('0X', '0x')
  const b = createBudget({ policy: total([{ period: 'total', maxCalls: 5 }, { service: C2, model: 'm', period: 'total', maxCalls: 1 }]), clock: () => 1790000000 })
  await b.admit(aiCall(1))
  await assert.rejects(b.admit(aiCall(2)), (e) => e.data.rule === 'rules[1]')
  const z = createBudget({ policy: total([{ period: 'call', maxAmount: '0', currency: 'USD' }]) })
  await assert.rejects(z.admit(aiCall(3)), (e) => e.code === 'BUDGET_EXCEEDED')
  assert.equal((await z.admit(aiCall(4, { worstCase: { USD: '0.00000000' } }))).kind, 'ai', 'a free call fits a zero cap')
  for (const bad of [{ period: 'total', maxCalls: 1, maxcalls: 2 }, { period: 'total' }, { period: 'total', maxAmount: '1' }, { period: 'total', maxCalls: -1 }, { period: 'total', maxAmount: '1.123456789', currency: 'USD' }, { period: 'total', maxCalls: 1, service: '0x12' }]) {
    assert.throws(() => policyOf(total([bad])), JSON.stringify(bad))
  }
})

// ── privacy through the real tapeapi-verify process / 经真实 tapeapi-verify 进程的隐私项 ───────────────────────
const CLI = fileURLToPath(new URL('../bin/tapeapi-verify.js', import.meta.url))
test('FIXED BR-9 / CONFIRMED BR-12: --save-requests keeps no copy of a call the budget refused; neither it nor the budget store holds the Authorization header', async () => {
  let w = null
  const srv = http.createServer(async (req, res) => {
    const parts = []; for await (const c of req) parts.push(c)
    const headers = new Headers(); for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1])
    const r = await w.proxy.handleRequest(new Request(new URL(req.url, 'http://127.0.0.1'), { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(parts) }))
    const h = Object.fromEntries(r.headers); delete h['content-length']
    res.writeHead(r.status, h); res.end(r.body ? Buffer.from(await r.arrayBuffer()) : undefined)
  })
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
  const url = `http://127.0.0.1:${srv.address().port}`
  w = await cannedWorld({ live: `${url}/tapeapi/v1` })
  const dir = mkdtempSync(join(TMP, 'save-')), saved = join(dir, 'req'), store = join(dir, 'store.jsonl'), pol = join(dir, 'policy.json')
  writeFileSync(pol, JSON.stringify(total([{ period: 'total', maxCalls: 1 }])))
  const child = spawn(process.execPath, [CLI, '--dev', url, '--port', '0', '--save-requests', saved, '--policy', pol, '--budget-store', store], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 300_000, killSignal: 'SIGKILL' })
  let err = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { err += d })
  try {
    const local = await new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error(err)), 20_000)
      child.stderr.on('data', () => { const m = /listening on (http:\/\/\S+)/.exec(err); if (m) { clearTimeout(t); ok(m[1]) } })
    })
    const SECRET = 'sk-review-secret-' + 'q'.repeat(24)
    const send = (content) => fetch(`${local}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}`, 'x-api-key': SECRET }, body: JSON.stringify({ model: CANNED[0].id, max_tokens: 16, messages: [{ role: 'user', content }] }) }).then(async (r) => ({ status: r.status, text: await r.text() }))
    assert.equal((await send('first')).status, 200)
    const refused = await send('second-never-sent')
    assert.equal(refused.status, 400); assert.match(refused.text, /budget_exceeded/)
    await tick()
    const files = readdirSync(saved)
    assert.equal(files.length, 1, 'only the call that was sent is saved')
    assert.match(files[0], /^[0-9a-f]{64}\.request$/, 'named by its hash: no path from the request')
    const all = [...files.map((f) => readFileSync(join(saved, f), 'utf8')), readFileSync(store, 'utf8')].join('\n')
    assert.ok(!all.includes(SECRET) && !/authorization|x-api-key/i.test(all), 'no header is written')
    assert.ok(!all.includes('second-never-sent'))
    assert.equal(statSync(store).mode & 0o777, 0o600); assert.equal(statSync(saved).mode & 0o777, 0o700)
  } finally {
    await new Promise((ok) => { if (child.exitCode !== null) return ok(); child.once('exit', ok); child.kill('SIGTERM') })
    srv.closeAllConnections(); await new Promise((ok) => srv.close(ok))
  }
})

// ── reconcile / 对账 ──────────────────────────────────────────────────────────────────────────────────────────────
test('FIXED RC-1: a bill time with no offset is UTC on every machine (it was read in the machine\'s zone)', () => {
  const src = fileURLToPath(new URL('../src/receipts-cli.js', import.meta.url))
  const run = (tz) => spawnSync(process.execPath, ['--input-type=module', '-e', `import { parseTime } from ${JSON.stringify(src)}; console.log([parseTime('2026-10-22 10:00:00'), parseTime('2026-10-22T10:00'), parseTime('2026-10-22T10:00:00+08:00'), parseTime('2026-10-22')].join(','))`], { env: { ...process.env, TZ: tz }, encoding: 'utf8', timeout: 300_000, killSignal: 'SIGKILL' }).stdout.trim()
  const utc = run('UTC')
  assert.equal(run('Asia/Shanghai'), utc); assert.equal(run('America/Los_Angeles'), utc)
  assert.equal(utc, [Date.UTC(2026, 9, 22, 10) / 1000, Date.UTC(2026, 9, 22, 10) / 1000, Date.UTC(2026, 9, 22, 2) / 1000, Date.UTC(2026, 9, 22) / 1000].join(','))
  assert.equal(parseTime('1790000000000'), 1790000000)
})

test('FIXED RC-2: --map naming a key twice, or a column the header has twice, is a usage mistake (the last one was taken silently)', () => {
  assert.throws(() => parseMap('model=a,model=b,prompt=p,completion=c,time=t'), (e) => e.usage && /twice/.test(e.message))
  assert.throws(() => columnsFor(['m', 'p', 'p', 'c', 't'], { map: parseMap('model=m,prompt=p,completion=c,time=t') }), (e) => e.usage && /more than once/.test(e.message))
  assert.ok(columnsFor(['m', 'p', 'c', 't', 't2', 't2'], { map: parseMap('model=m,prompt=p,completion=c,time=t') }).cols, 'a repeated column not used is fine')
  // CSV quoting: "" in a quoted cell, a line break inside, CRLF / CSV 引号
  assert.deepEqual(parseCsv('a,"b ""q"", c","x\ny"\r\n1,2,3').map((r) => r.cells), [['a', 'b "q", c', 'x\ny'], ['1', '2', '3']])
  assert.throws(() => parseCsv('a,"b'))
})

test('FIXED RC-3: a row whose id is a receipt\'s id already joined (the same id billed twice) is bill-only, not joined to another receipt by time', () => {
  const rec = (i, id) => ({ source: `r:${i}`, envelope: { ...env({ ts: 1790000000 + i, h: H(i), model: 'm', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }), id } })
  const receipts = [rec(1, 'chatcmpl-a'), rec(2, 'chatcmpl-b')]
  const row = (i, id) => ({ source: `bill:${i}`, id, model: 'm', prompt: 5, completion: 2, time: 1790000000 + i })
  const res = reconcile(receipts, [row(1, 'chatcmpl-a'), row(2, 'chatcmpl-a')])
  assert.deepEqual(res.counts, { match: 1, missing: { receiptsOnly: 1, billOnly: 1 }, mismatch: 0 }, 'before: two matches, the double billing hidden')
  // a row with an id no receipt has still falls back to time / 没有任何回执带此 id 的行仍按时间对
  assert.equal(reconcile(receipts, [row(1, 'chatcmpl-a'), row(2, 'upstream-xyz')]).counts.match, 2)
})

// ── property-style (seeded) / 性质测试（固定种子）─────────────────────────────────────────────────────────────────
function rng(seed) { let x = seed >>> 0; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 2 ** 32 } }
const pick = (r, n) => Math.floor(r() * n)
const dec = (r) => `${pick(r, 50)}.${String(pick(r, 1e6)).padStart(6, '0')}`

test('property: maxAmountOf >= amountOf for random prices (cache tiers, reasoning) and any usage within the bounds', () => {
  const r = rng(27)
  for (let i = 0; i < 3000; i++) {
    const p = { input: dec(r), output: dec(r) }
    for (const k of ['cacheRead', 'cacheWrite', 'cacheWrite1h', 'reasoning']) if (r() < 0.5) p[k] = dec(r)
    const P = pick(r, 200000), C = pick(r, 50000)
    const prompt = pick(r, P + 1), completion = pick(r, C + 1)
    const cr = pick(r, prompt + 1), cw = pick(r, prompt - cr + 1), cw1h = pick(r, cw + 1), rs = pick(r, completion + 1)
    const u = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, cache_read_tokens: cr, cache_write_tokens: cw, cache_write_1h_tokens: cw1h, reasoning_tokens: rs }
    assert.ok(units8(AI.maxAmountOf(p, { promptTokens: P, completionTokens: C })) >= units8(AI.amountOf(p, u)), JSON.stringify({ p, u, P, C }))
  }
})

test('property: under the documented model (each receipt claims at most its call\'s worst case), claimed + open never exceeds the cap at any admit', async () => {
  for (let seed = 1; seed <= 30; seed++) {
    const r = rng(seed)
    let t = Date.UTC(2026, 9, 22, 23, 50) / 1000
    const cap = units8(dec(r)) + 1n
    const period = ['total', 'day', 'month'][pick(r, 3)]
    const b = createBudget({ policy: total([{ period, maxAmount: fromUnits8(cap), currency: 'USD' }]), clock: () => t })
    const open = []
    for (let i = 0; i < 60; i++) {
      t += pick(r, 90)
      const op = r()
      if (op < 0.55) {
        const worst = units8(dec(r)) / BigInt(1 + pick(r, 20))
        try { open.push({ a: await b.admit(aiCall(seed * 1000 + i, { worstCase: { USD: fromUnits8(worst) } })), worst, h: H(seed * 1000 + i) }) } catch (e) { assert.equal(e.code, 'BUDGET_EXCEEDED') }
        const w = b.state().windows[0]
        assert.ok(units8(w.claimed.amount) + units8(w.worstCase.amount) <= cap, `seed ${seed} step ${i}`)
      } else if (open.length) {
        const x = open.splice(pick(r, open.length), 1)[0]
        if (op < 0.85) await b.receipt(env({ ts: t + pick(r, 600) - 300, h: x.h, prices: [{ currency: 'USD', amount: fromUnits8(x.worst * BigInt(pick(r, 101)) / 100n) }] }))
        else await b.release(x.a, { why: 'http-error-no-receipt', status: 500 })
        const w = b.state().windows[0]
        assert.ok(units8(w.claimed.amount) + units8(w.worstCase.amount) <= cap, `seed ${seed} step ${i} after settle`)
      }
    }
  }
})

test('property: the statement\'s totals equal what policyCheck sums for the same receipts (reconcile\'s counting)', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed * 7)
    const records = Array.from({ length: 1 + pick(r, 30) }, (_, i) => {
      const prices = r() < 0.2 ? null : [{ currency: 'USD', amount: fromUnits8(BigInt(pick(r, 1e9))) }]
      const e = env({ ts: 1790000000 + pick(r, 86400 * 3), h: H(i), model: ['a', 'b'][pick(r, 2)], status: r() < 0.1 ? 500 : 200, usage: { prompt_tokens: pick(r, 999), completion_tokens: pick(r, 99), total_tokens: 0 }, prices })
      return { source: `f:${i + 1}`, envelope: r() < 0.1 ? { ...e, sig: records0 } : e }
    })
    const st = receiptStatement({ records, from: null, to: null })
    // reconcile's own reading of the same records (one receipt once, by signature) / reconcile 对同样记录的读取
    const uniq = reconcile(records, []).claimList
    const sum = uniq.reduce((a, c) => a + (c.prices ? units8(c.prices[0].amount) : 0n), 0n)
    const pc = policyCheck(uniq, policyOf(total([{ period: 'total', maxAmount: '0', currency: 'USD' }])))[0]
    assert.equal(st.totals.amounts.USD ?? '0.00000000', fromUnits8(sum), `seed ${seed}`)
    assert.equal(pc.over.length ? pc.over[0].value : '0.00000000 USD', `${fromUnits8(sum)} USD`)
    assert.equal(st.totals.receipts, uniq.length)
  }
})
const records0 = '0x' + 'ee'.repeat(65)

test('CONFIRMED BR-13: a receipt that verifies but claims far more than the worst case is counted as claimed; the next call is refused', async () => {
  const b = createBudget({ policy: total([{ period: 'total', maxAmount: '1', currency: 'USD' }]), clock: () => 1790000000 })
  await b.admit(aiCall(1))
  await b.receipt(env({ h: H(1), usage: { prompt_tokens: 9999999, completion_tokens: 9999999, total_tokens: 19999998 }, prices: [{ currency: 'USD', amount: '60.00000000' }] }))
  await assert.rejects(b.admit(aiCall(2)), (e) => e.code === 'BUDGET_EXCEEDED' && e.data.spent === '60.00000000')
})

// ── BR-7 follow-up: a lock across processes / 跨进程的锁 ──────────────────────────────────────────────────────────
const BUDGET_SRC = fileURLToPath(new URL('../src/budget.js', import.meta.url))
const racer = (file, go, n, withLock) => `
import { createBudget, budgetFileStore } from ${JSON.stringify(BUDGET_SRC)}
import * as fs from 'node:fs'
const io = { readFileSync: fs.readFileSync, appendFileSync: fs.appendFileSync, chmodSync: fs.chmodSync${withLock ? ', writeFileSync: fs.writeFileSync, unlinkSync: fs.unlinkSync' : ''} }
const b = createBudget({ policy: { tapeapiPolicy: 1, rules: [{ period: 'total', maxCalls: ${n} }] }, store: budgetFileStore(${JSON.stringify(file)}, io), clock: () => 1790000000 })
await b.ready()
while (!fs.existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 1))
let ok = 0
for (let i = 0; i < ${n * 2}; i++) { try { await b.admit({ kind: 'ai', container: '${CONTAINER}', models: ['m'], worstCase: { USD: '0.1' }, promptTokens: 1, completionTokens: 1, requestSha256: null }); ok++ } catch (e) { if (e.code !== 'BUDGET_EXCEEDED') throw e } }
console.log(ok)
`
async function race(withLock, procs = 4, n = 40) {
  const dir = mkdtempSync(join(TMP, 'race-')), file = join(dir, 'store.jsonl'), go = join(dir, 'go')
  const kids = Array.from({ length: procs }, () => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', racer(file, go, n, withLock)], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000, killSignal: 'SIGKILL' })
    let out = '', err = ''; c.stdout.on('data', (d) => { out += d }); c.stderr.on('data', (d) => { err += d })
    return new Promise((ok) => c.on('exit', (code) => ok({ code, out, err })))
  })
  await new Promise((r) => setTimeout(r, 400))
  writeFileSync(go, '')
  const res = await Promise.all(kids)
  for (const r of res) assert.equal(r.code, 0, r.err)
  return { admitted: res.reduce((a, r) => a + Number(r.out.trim()), 0), lines: readBudgetLines(readFileSync(file, 'utf8')).sent.length, lock: existsLock(file) }
}
const existsLock = (file) => { try { statSync(`${file}.lock`); return true } catch { return false } }

test('FIXED BR-7 (lock): four processes racing on one store file admit exactly maxCalls in all; the lock file is gone afterwards', async () => {
  for (let round = 0; round < 3; round++) {
    const r = await race(true)
    assert.equal(r.admitted, 40, `round ${round}: ${r.admitted} admitted`)
    assert.equal(r.lines, 40)
    assert.equal(r.lock, false)
  }
})

test('FIXED BR-7 (lock): a stale lock is taken over; a held one makes the call wait, then refuses it (budget-store-unwritable)', async () => {
  const dir = mkdtempSync(join(TMP, 'lock-')), file = join(dir, 's.jsonl')
  const io = { ...FS, writeFileSync, unlinkSync: (p) => rmSync(p) }
  writeFileSync(`${file}.lock`, JSON.stringify({ pid: 1, ms: Date.now() - 60_000 }))
  const b = createBudget({ policy: total([{ period: 'total', maxCalls: 5 }]), store: budgetFileStore(file, io), clock: () => 1790000000 })
  await b.admit(aiCall(1))
  assert.equal(existsLock(file), false)
  writeFileSync(`${file}.lock`, JSON.stringify({ pid: 1, ms: Date.now() }))
  const c = createBudget({ policy: total([{ period: 'total', maxCalls: 5 }]), store: budgetFileStore(file, io, { waitMs: 100 }), clock: () => 1790000000 })
  await assert.rejects(c.admit(aiCall(2)), (e) => e.code === 'INVALID_ARGUMENT' && e.data.reason === 'budget-store-unwritable' && /locked by another budget/.test(e.message))
  assert.equal(readBudgetLines(readFileSync(file, 'utf8')).sent.length, 1, 'nothing written while locked')
  assert.ok(existsLock(file), 'another budget\'s lock is left alone')
})

test('FIXED BR-2 (message): the refusal names the unknown model and the rule\'s model', async () => {
  const sc = sidecar()
  const vf = AI.createVerifyingFetch({ service: sc.service, fetch: sc.fetch, policy: total([{ model: 'quirk-small', period: 'day', maxAmount: '1', currency: 'USD' }]) })
  await assert.rejects(call(vf, sc, hi({ model: 'QUIRK-SMALL' })), (e) => /model "QUIRK-SMALL" is not in the service's price table, so it cannot be told apart from the rule's model "quirk-small"/.test(e.message))
})
