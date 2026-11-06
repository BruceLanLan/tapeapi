// The client-side budget (3.0, experimental; sdk/src/budget.js, createVerifyingFetch({ policy }), the agent kit's
// limiter payer({ budget })) and `tapeapi receipts statement` (sdk/src/statement-cli.js). On the reference sidecar
// (createAIProxy, real signatures) in front of the scripted upstream of the reconcile fixture (made-up model names,
// no real key), and on the fake chain for the limiter. What is shown: a call over a cap is refused BEFORE anything is
// sent; a call that cannot be bounded is refused too; the count survives a restart (a file store, mode 600); a call
// with no verified receipt counts at its worst case; the statement's totals are reconcile's. What is not: anything
// about what a service bills or what is paid; the budget bounds the prices the receipts claim, in this process.
// 客户端预算与 receipts statement 的测试：超出上限的调用在发出之前被拒绝；无法给出上界的调用同样拒绝；重启后计数仍在（文件存储，600）；
// 没有核验成功的回执的调用按最坏情况计；声明的合计与 reconcile 相同。不说明服务方如何计费、实际付了多少。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, chmodSync, statSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, relative, isAbsolute } from 'node:path'
import { createAIProxy } from '../../server/src/ai-proxy.js'
import * as AI from '../src/ai.js'
import * as pubAI from '@tapeapi/sdk/ai'
import * as pubAgent from '@tapeapi/sdk/agent'
import { createBudget, budgetFileStore, memoryBudgetStore, readBudgetLines, BUDGET_REFUSALS } from '../src/budget.js'
import { units8, fromUnits8 } from '../src/policy.js'
import { runReconcile } from '../src/reconcile-cli.js'
import { runReceipts } from '../src/receipts-cli.js'
import { createSpendLimiter } from '../src/agent-pay.js'
import * as agent from '../src/agent-public.js'
import { standardWorld, KEYS, addrOf, S, S2, BEM_TOKEN, NOW } from './helpers/agent-chain.mjs'
import { noonClock } from './helpers/noon-clock.mjs'

// Day and month windows read the clock (the budget's, the sidecar's receipt ts, the mandate times below): the whole file
// runs on a clock that starts at 12:00 UTC (helpers/noon-clock.mjs), so "2 calls a day" never straddles a midnight
// (FIXED, flaky day window). / 日与月窗口读时钟：整个文件用从 UTC 12:00 开始的时钟，"一天 2 次"绝不跨午夜。
noonClock()

const KEY = '0x' + '42'.repeat(32)
const CONTAINER = '0x' + '7c'.repeat(20)
const OTHER = '0x' + '5d'.repeat(20)
const BEM = '0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a'
const TMP = mkdtempSync(join(tmpdir(), 'tapeapi-budget-'))
test.after(() => rmSync(TMP, { recursive: true, force: true }))
const HOST = { readFileSync, readdirSync, statSync, writeFileSync, join, dirname, relative, isAbsolute }
const FS = { readFileSync, appendFileSync, chmodSync }
const FORBIDDEN = /认证|合作伙伴|推荐|欺诈|作弊|诈骗|骗|通过|采用|成为标准|已审计|主网可用|批准|certified|partner|recommend|fraud|cheat|scam|dishonest|\bfake\b|\blie[sd]?\b|substitut|swapped|hidden prompt|隐藏提示/i

// The reconcile fixture's price table and scripted upstream (sdk/test/tapeapi-reconcile-checks.test.mjs), with one
// more behaviours: a message "boom" makes the upstream fail (the sidecar then answers itself, HTTP 502 with no receipt:
// a definite failure); "drop" breaks the connection before any answer, and "strip" takes the receipt off a 200 answer
// (both: not definite, the call keeps counting).
// 对账夹具的价目表与脚本化上游；另加："boom" 让上游失败（旁路自己以 502 作答、没有回执：确定的失败）；"drop" 在回答之前断开连接，
// "strip" 去掉 200 回答的回执（两者都不确定，调用继续计入）。
const price = (input, output) => [{ currency: 'USD', unit: '1M tokens', input, output }, { currency: 'BEM', unit: '1M tokens', input: String(Number(input) * 10), output: String(Number(output) * 10) }]
const MODELS = [
  { id: 'quirk-small', formats: ['openai-chat'], prices: price('1', '2') },
  { id: 'quirk-long', formats: ['openai-chat'], prices: price('1', '2') },
  { id: 'quirk-alias', aliases: ['quirk-alias-s'], formats: ['openai-chat'], prices: price('1', '2') },
]
function scriptedUpstream(seen) {
  return async (url, init) => {
    const body = JSON.parse(new TextDecoder().decode(init.body))
    seen.calls++
    if (body.messages.some((m) => m.content === 'boom')) throw new Error('upstream down')
    const words = body.messages.map((m) => String(m.content).split(/\s+/).filter(Boolean).length).reduce((a, b) => a + b, 0)
    const prompt = 12 + words
    const usage = body.model === 'quirk-long'
      ? { prompt_tokens: prompt, completion_tokens: 202, total_tokens: prompt + 202, completion_tokens_details: { reasoning_tokens: 194 } }
      : { prompt_tokens: prompt, completion_tokens: 3, total_tokens: prompt + 3 }
    const model = body.model === 'quirk-alias' && body.stream ? 'quirk-alias-s' : body.model
    const id = `chatcmpl-${Math.random().toString(36).slice(2, 10)}`
    if (!body.stream) return new Response(JSON.stringify({ id, object: 'chat.completion', created: 1790000000, model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop', logprobs: null }], usage }), { status: 200, headers: { 'content-type': 'application/json' } })
    const ev = (o) => `data: ${JSON.stringify(o)}\n\n`
    const chunk = (delta, finish = null) => ({ id, object: 'chat.completion.chunk', created: 1790000000, model, choices: [{ index: 0, delta, finish_reason: finish }] })
    const text = ev(chunk({ role: 'assistant', content: 'ok' })) + ev(chunk({}, 'stop')) + (body.stream_options?.include_usage ? ev({ id, object: 'chat.completion.chunk', created: 1790000000, model, choices: [], usage }) : '') + 'data: [DONE]\n\n'
    return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
}
function sidecar() {
  const seen = { calls: 0 }
  const proxy = createAIProxy({
    upstream: { baseUrl: 'http://upstream.local/v1' }, fetch: scriptedUpstream(seen), signerKey: KEY, allowHttp: true, rateLimit: false, log: () => {},
    models: MODELS, formats: AI.FORMATS.filter((f) => f.name === 'openai-chat'),
    manifestBase: { name: 'Budget relay', circuits: '0x0000000000000000000000000000000000000000', tokenId: '0', container: CONTAINER, delegation: null, dev: true, endpoints: { live: ['http://127.0.0.1:1/tapeapi/v1'], async: false } },
  })
  const service = { manifest: proxy.manifest(), container: CONTAINER, verified: { dev: true } }
  const fetch = async (u, i) => {
    const text = new TextDecoder().decode(i.body)
    if (text.includes('"drop"')) { seen.calls++; throw new TypeError('fetch failed: socket hang up') }
    const r = await proxy.handleRequest(new Request(u, i), { clientIp: '127.0.0.1' })
    if (!text.includes('"strip"')) return r
    const h = new Headers(r.headers); h.delete('x-tapeapi-receipt')
    return new Response(await r.arrayBuffer(), { status: r.status, headers: h })
  }
  return { proxy, seen, service, fetch, url: `${proxy.manifest().ai.endpoints[0].baseUrl}/chat/completions` }
}
const hi = (o = {}) => ({ model: 'quirk-small', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }], ...o })
async function call(vf, sc, body) {
  const res = await vf(sc.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' }, body: JSON.stringify(body) })
  const text = await res.text()
  return { res, text }
}
// The worst case the fetch computes for a body: the bytes sent (the JSON text and the 64 salt characters) as the prompt
// bound, max_tokens as the completion bound, priced at the dearest bucket. / fetch 对一个请求算出的最坏情况。
const worstOf = (body, currency = 'USD') => {
  const p = MODELS.find((m) => m.id === body.model).prices.find((x) => x.currency === currency)
  return units8(AI.maxAmountOf(p, { promptTokens: new TextEncoder().encode(JSON.stringify(body)).length + 64, completionTokens: body.max_tokens }))
}
// What the scripted upstream makes the receipt claim for a quirk-small "hi": 13 prompt and 3 completion tokens.
const CLAIM_HI = units8(AI.amountOf({ input: '1', output: '2' }, { prompt_tokens: 13, completion_tokens: 3 }))
const total = (rules) => ({ tapeapiPolicy: 1, rules })

test('defaults unchanged: without policy nothing is counted or refused; the options are checked when the fetch is made', async () => {
  const sc = sidecar()
  const reports = []
  const vf = AI.createVerifyingFetch({ service: sc.service, fetch: sc.fetch, onReport: (r) => reports.push(r) })
  for (let i = 0; i < 3; i++) assert.equal((await call(vf, sc, hi({ max_tokens: undefined }))).res.status, 200, 'no max_tokens is fine without a policy')
  assert.equal(sc.seen.calls, 3)
  assert.ok(reports.every((r) => r.ok && !('budget' in r)))
  const bad = (o, re) => assert.throws(() => AI.createVerifyingFetch({ service: sc.service, fetch: sc.fetch, ...o }), (e) => e.code === 'INVALID_ARGUMENT' && re.test(e.message))
  bad({ budgetStore: memoryBudgetStore() }, /budgetStore applies with policy only/)
  bad({ policy: total([{ period: 'total', maxCalls: 1 }]), budget: createBudget({ policy: total([{ period: 'total', maxCalls: 1 }]) }) }, /policy or budget, not both/)
  bad({ policy: total([{ period: 'total', maxCals: 1 }]) }, /unknown key "maxCals"/)
  bad({ policy: { tapeapiPolicy: 1, rules: [{ period: 'week', maxCalls: 1 }] } }, /period must be one of/)
  bad({ budget: {} }, /createBudget/)
  for (const n of ['createBudget', 'budgetFileStore', 'memoryBudgetStore']) { assert.equal(typeof pubAI[n], 'function', n); assert.equal(pubAgent[n], pubAI[n], n) }
})

test('refused before sending: a total maxAmount stops the call whose worst case would go over; data { cap, spent, worstCase }; nothing reaches the upstream', async () => {
  const sc = sidecar()
  const w = worstOf(hi())
  // a cap that admits exactly three calls: the third one lands exactly on it (spent + worst = cap is allowed)
  // 恰好允许三次的上限：第三次正好等于上限（spent + worst = cap 允许）
  const cap = 2n * CLAIM_HI + w
  const reports = []
  const vf = AI.createVerifyingFetch({ service: sc.service, fetch: sc.fetch, policy: total([{ name: 'all USD', period: 'total', maxAmount: fromUnits8(cap), currency: 'USD' }]), onReport: (r) => reports.push(r) })
  for (let i = 0; i < 3; i++) {
    const { res } = await call(vf, sc, hi())
    assert.equal(res.status, 200)
    assert.equal(reports.at(-1).ok, true)
  }
  assert.equal(sc.seen.calls, 3)
  await assert.rejects(call(vf, sc, hi()), (e) => {
    assert.equal(e.code, 'BUDGET_EXCEEDED', e.message)
    assert.deepEqual(e.data, { reason: 'budget-cap', rule: 'all USD', period: 'total', window: 'total', limit: 'maxAmount', currency: 'USD', cap: fromUnits8(cap), spent: fromUnits8(3n * CLAIM_HI), worstCase: fromUnits8(w) })
    assert.match(e.message, /client-side cap of your own policy file; it bounds the prices the receipts claim/)
    return true
  })
  assert.equal(sc.seen.calls, 3, 'the refused call was not sent')
  assert.equal(reports.at(-1).ok, false); assert.equal(reports.at(-1).budget.reason, 'budget-cap'); assert.match(reports.at(-1).problems[0], /^not sent: /)
  // strict: false refuses all the same (it is the caller's cap, not a verification problem) / 非 strict 也同样拒绝
  const loose = AI.createVerifyingFetch({ service: sc.service, fetch: sc.fetch, strict: false, policy: total([{ period: 'call', maxAmount: fromUnits8(w - 1n), currency: 'USD' }]) })
  await assert.rejects(call(loose, sc, hi()), (e) => e.code === 'BUDGET_EXCEEDED' && e.data.period === 'call' && e.data.spent === '0.00000000')
  assert.equal(sc.seen.calls, 3)
})

test('fails closed: no output limit, no price-table entry, no price in the rule\'s currency, an unreadable body; rules that do not cover the call do not apply', async () => {
  const sc = sidecar()
  const refused = async (policy, body, reason, init) => {
    const vf = AI.createVerifyingFetch({ service: sc.service, fetch: sc.fetch, policy })
    const before = sc.seen.calls
    const p = init ? vf(sc.url, init) : call(vf, sc, body)
    await assert.rejects(p, (e) => { assert.equal(e.code, 'INVALID_ARGUMENT', e.message); assert.equal(e.data.reason, reason, e.message); return true })
    assert.equal(sc.seen.calls, before, `${reason}: nothing sent`)
  }
  const usd = total([{ period: 'day', maxAmount: '1', currency: 'USD' }])
  await refused(usd, hi({ max_tokens: undefined }), 'budget-no-limit')
  await refused(total([{ period: 'total', maxCompletionTokens: 1000 }]), hi({ max_tokens: undefined }), 'budget-no-limit')
  await refused(usd, hi({ model: 'quirk-unknown' }), 'budget-no-price')
  await refused(total([{ period: 'day', maxAmount: '1', currency: 'USDT' }]), hi(), 'budget-no-currency')
  await refused(usd, null, 'budget-unreadable-request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' })
  for (const r of ['budget-cap', 'budget-no-limit', 'budget-no-price', 'budget-no-currency', 'budget-unreadable-request', 'budget-store-unwritable']) assert.ok(BUDGET_REFUSALS.includes(r))
  // another service's rule, another model's rule: not this call's / 别的服务、别的模型的规则：不管这次调用
  const free = AI.createVerifyingFetch({ service: sc.service, fetch: sc.fetch, policy: total([{ service: OTHER, period: 'total', maxCalls: 0 }, { model: 'quirk-long', period: 'total', maxCalls: 0 }]) })
  assert.equal((await call(free, sc, hi({ max_tokens: undefined }))).res.status, 200, 'no covering rule: nothing needs a bound')
  // a model rule covers the alias of its entry / 模型规则覆盖其条目的别名
  const alias = AI.createVerifyingFetch({ service: sc.service, fetch: sc.fetch, policy: total([{ model: 'quirk-alias-s', period: 'total', maxCalls: 0 }]) })
  await assert.rejects(call(alias, sc, hi({ model: 'quirk-alias' })), (e) => e.code === 'BUDGET_EXCEEDED' && e.data.limit === 'maxCalls')
  // maxCalls, and a per-call completion cap read from max_tokens / 次数上限，以及按 max_tokens 读的单次补全上限
  const calls = AI.createVerifyingFetch({ service: sc.service, fetch: sc.fetch, policy: total([{ period: 'day', maxCalls: 2 }, { name: 'short', period: 'call', maxCompletionTokens: 100 }]) })
  await assert.rejects(call(calls, sc, hi({ max_tokens: 500 })), (e) => e.code === 'BUDGET_EXCEEDED' && e.data.rule === 'short' && e.data.worstCase === 500 && e.data.cap === 100)
  await call(calls, sc, hi()); await call(calls, sc, hi())
  await assert.rejects(call(calls, sc, hi()), (e) => e.code === 'BUDGET_EXCEEDED' && e.data.limit === 'maxCalls' && e.data.spent === 2 && e.data.cap === 2)
  // a store that cannot be written: nothing is sent / 写不了存储：不发送
  const before = sc.seen.calls
  const broken = AI.createVerifyingFetch({ service: sc.service, fetch: sc.fetch, policy: usd, budgetStore: { read: () => '', append: () => { throw new Error('disk full') } } })
  await assert.rejects(call(broken, sc, hi()), (e) => e.code === 'INVALID_ARGUMENT' && e.data.reason === 'budget-store-unwritable')
  assert.equal(sc.seen.calls, before)
})

test('counting across restarts: a file store (mode 600, JSON lines), a new fetch on it refuses where the first would have; a call with no receipt counts at its worst case', async () => {
  const dir = join(TMP, 'restart'); mkdirSync(dir, { recursive: true })
  const file = join(dir, 'spend.jsonl')
  const sc = sidecar()
  const w = worstOf(hi())
  const boom = hi({ messages: [{ role: 'user', content: 'boom' }] }), drop = hi({ messages: [{ role: 'user', content: 'drop' }] })
  // three receipts, one call at its worst case (the dropped one; the 502 is released), then room for one more call
  // 三张回执、一次按最坏情况计（断开的那次；502 那次已撤下），再容纳一次
  const cap = 3n * CLAIM_HI + worstOf(drop) + w
  const policy = total([{ name: 'cap', period: 'total', maxAmount: fromUnits8(cap), currency: 'USD' }])
  const first = AI.createVerifyingFetch({ service: sc.service, fetch: sc.fetch, policy, budgetStore: budgetFileStore(file, FS) })
  for (let i = 0; i < 3; i++) assert.equal((await call(first, sc, hi())).res.status, 200)
  // the upstream fails: the sidecar answers itself, no receipt; strict throws PROVIDER_UNAVAILABLE after sending
  // 上游失败：旁路自己作答、没有回执；strict 在发出之后抛 PROVIDER_UNAVAILABLE
  await assert.rejects(call(first, sc, boom), (e) => e.code === 'PROVIDER_UNAVAILABLE')
  // the connection breaks before any answer: not definite, it keeps counting / 回答之前连接断开：不确定，继续计入
  await assert.rejects(call(first, sc, drop), /socket hang up/)
  await new Promise((r) => setImmediate(r))
  assert.equal(statSync(file).mode & 0o777, 0o600, 'the store is mode 600')
  const lines = readBudgetLines(readFileSync(file, 'utf8'), 'spend.jsonl')
  assert.equal(lines.sent.length, 5); assert.equal(lines.receipts.length, 3); assert.equal(lines.skipped.length, 0)
  assert.equal(lines.released.length, 1); assert.deepEqual([lines.released[0].why, lines.released[0].status], ['sidecar-error', 502])
  assert.equal(lines.released[0].id, lines.sent[3].id, 'the 502 call is the one released')
  for (const r of lines.receipts) assert.ok(lines.sent.some((s) => s.requestSha256 === r.envelope.params.requestSha256), 'each receipt answers a sent line')
  // the process restarts: a new budget on the same file / 进程重启：同一个文件上的新预算
  const b = createBudget({ policy, store: budgetFileStore(file, FS) })
  await b.ready()
  const st = b.state()
  assert.deepEqual([st.receipts, st.sent, st.released, st.open], [3, 5, 1, 1])
  assert.equal(st.windows[0].claimed.amount, fromUnits8(3n * CLAIM_HI))
  assert.equal(st.windows[0].worstCase.amount, fromUnits8(worstOf(drop)))
  const second = AI.createVerifyingFetch({ service: sc.service, fetch: sc.fetch, budget: b })
  assert.equal((await call(second, sc, hi())).res.status, 200, 'one more fits')
  const sent = sc.seen.calls
  await assert.rejects(call(second, sc, hi()), (e) => e.code === 'BUDGET_EXCEEDED' && e.data.spent === fromUnits8(4n * CLAIM_HI + worstOf(drop)))
  assert.equal(sc.seen.calls, sent)
  // a fresh fetch on the same file, without the budget object: the same answer / 不共用对象、同一文件上的新 fetch：结果相同
  const third = AI.createVerifyingFetch({ service: sc.service, fetch: sc.fetch, policy, budgetStore: budgetFileStore(file, FS) })
  await assert.rejects(call(third, sc, hi()), (e) => e.code === 'BUDGET_EXCEEDED')
  // the receipt readers read the store: sent lines are not receipts and not skipped lines / 回执读取器能读存储：sent 行既不是回执也不算跳过
  let out = ''
  const r = await runReceipts(['tail', '--receipts', file, '--json'], { host: HOST, cmd: 'tapeapi', version: '0.0.0-test', env: {}, isTTY: false, cwd: dir, stdout: (s) => { out += s }, stderr: () => {} })
  assert.equal(r.exitCode, 0)
  const j = JSON.parse(out)
  assert.equal(j.counts.records, 4); assert.equal(j.counts.skipped, 0)
})

test('released: an HTTP 4xx/5xx with no receipt drops the worst case at once; a 200 whose receipt is missing does not', async () => {
  const sc = sidecar()
  const w = worstOf(hi())
  const b = createBudget({ policy: total([{ period: 'total', maxAmount: '1', currency: 'USD' }]) })
  const vf = AI.createVerifyingFetch({ service: sc.service, fetch: sc.fetch, budget: b })
  await assert.rejects(call(vf, sc, hi({ messages: [{ role: 'user', content: 'boom' }] })), (e) => e.code === 'PROVIDER_UNAVAILABLE')
  await new Promise((r) => setImmediate(r))
  assert.deepEqual([b.state().open, b.state().released], [0, 1])
  // a 4xx the service answers without a receipt (here: a bad request the scripted upstream never sees) / 服务方不带回执的 4xx
  const bad = AI.createVerifyingFetch({ service: sc.service, fetch: async () => new Response('{"error":{"message":"bad request"}}', { status: 400, headers: { 'content-type': 'application/json' } }), budget: b })
  const r400 = await call(bad, sc, hi())
  assert.equal(r400.res.status, 502, 'strict: no receipt is still RECEIPT_INVALID to the caller')
  await new Promise((r) => setImmediate(r))
  assert.deepEqual([b.state().open, b.state().released], [0, 2])
  // a 200 with the receipt taken off: not definite (it may have been charged), it stays at its worst case
  // 去掉回执的 200：不确定（可能已计费），继续按最坏情况计
  const strip = hi({ messages: [{ role: 'user', content: 'strip' }] })
  const r200 = await call(vf, sc, strip)
  assert.equal(r200.res.status, 502)
  await new Promise((r) => setImmediate(r))
  assert.deepEqual([b.state().open, b.state().released], [1, 2])
  assert.equal(b.state().windows[0].worstCase.amount, fromUnits8(worstOf(strip)))
  void w
})

test('concurrent calls in one process see each other: what is claimed plus what is open never goes over the cap', async () => {
  const sc = sidecar()
  const w = worstOf(hi())
  const cap = 3n * w
  const policy = total([{ period: 'total', maxAmount: fromUnits8(cap), currency: 'USD' }])
  const b = createBudget({ policy })
  const vf = AI.createVerifyingFetch({ service: sc.service, fetch: sc.fetch, budget: b })
  const all = await Promise.allSettled(Array.from({ length: 12 }, () => call(vf, sc, hi())))
  const ok = all.filter((x) => x.status === 'fulfilled').length
  assert.ok(ok >= 3, `at least the three worst cases fit (${ok})`)
  assert.ok(all.filter((x) => x.status === 'rejected').every((x) => x.reason.code === 'BUDGET_EXCEEDED'))
  assert.ok(ok < 12, 'some were refused')
  assert.equal(sc.seen.calls, ok)
  await new Promise((r) => setImmediate(r))
  const s = b.state().windows[0]
  assert.ok(units8(s.claimed.amount) + units8(s.worstCase.amount) <= cap)
})

// ── statement / 花费声明 ──────────────────────────────────────────────────────────────────────────────────────────
const now = () => Math.floor(Date.now() / 1000)
const day = (t) => new Date(t * 1000).toISOString().slice(0, 10)
const mandateOf = (scope) => ({
  principal: '0x' + '11'.repeat(20), agent: '0x' + '22'.repeat(20), agentKey: '0x' + '33'.repeat(20), mode: 0, taskHash: '0x' + 'ab'.repeat(32), scope,
  feeToken: '0x0000000000000000000000000000000000000000', feeCap: '0', notBefore: now() - 3600, expires: now() + 3600, nonce: '1', subdelegate: false,
})
async function cli(fn, args, cwd) {
  let out = '', err = ''
  const saved = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('no network in this command') }
  try {
    const r = await fn(args, { host: HOST, cmd: 'tapeapi', version: '0.0.0-test', env: {}, isTTY: false, cwd, stdout: (s) => { out += s }, stderr: (s) => { err += s } })
    return { code: r.exitCode, out, err, json: out.startsWith('{') ? JSON.parse(out) : null }
  } finally { globalThis.fetch = saved }
}

test('receipts statement: per service, model and day; totals equal tapeapi reconcile\'s (mandate spent, policy windows); unsigned, files only; zh and en', async () => {
  const dir = join(TMP, 'statement'); mkdirSync(dir, { recursive: true })
  const file = join(dir, 'spend.jsonl')
  const sc = sidecar()
  const policy = total([{ name: 'usd day', period: 'day', maxAmount: '1', currency: 'USD' }, { name: 'bem total', period: 'total', maxAmount: '100', currency: 'BEM' }])
  const vf = AI.createVerifyingFetch({ service: sc.service, fetch: sc.fetch, policy, budgetStore: budgetFileStore(file, FS) })
  const bodies = [hi(), hi(), hi({ model: 'quirk-long', max_tokens: 500, messages: [{ role: 'user', content: 'count to four please' }] }),
    hi({ model: 'quirk-alias', max_tokens: 16, messages: [{ role: 'user', content: 'name a colour' }] }),
    hi({ model: 'quirk-alias', max_tokens: 16, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'name a fruit' }] })]
  for (const b of bodies) assert.equal((await call(vf, sc, b)).res.status, 200)
  await assert.rejects(call(vf, sc, hi({ messages: [{ role: 'user', content: 'boom' }] })), (e) => e.code === 'PROVIDER_UNAVAILABLE')   // released
  await assert.rejects(call(vf, sc, hi({ messages: [{ role: 'user', content: 'drop' }] })), /socket hang up/)                  // stays open
  await new Promise((r) => setImmediate(r))
  writeFileSync(join(dir, 'policy.json'), JSON.stringify(policy))
  // every window "over" a cap of 0, so reconcile prints each window's sum / 上限为 0，reconcile 列出每个窗口的合计
  writeFileSync(join(dir, 'zero.json'), JSON.stringify(total([{ name: 'usd', period: 'day', maxAmount: '0', currency: 'USD' }, { name: 'bem', period: 'total', maxAmount: '0', currency: 'BEM' }, { name: 'calls', period: 'day', maxCalls: 0 }])))
  writeFileSync(join(dir, 'mandate.json'), JSON.stringify({ mandate: mandateOf([{ provider: CONTAINER, token: BEM, cap: '100000000000' }]), signature: '0x00' }))
  const from = day(now() - 86400), to = day(now() + 2 * 86400)
  const st = await cli(runReceipts, ['statement', '--receipts', 'spend.jsonl', '--from', from, '--to', to, '--policy', 'zero.json', '--mandate', 'mandate.json', '--token-decimals', '8', '--json'], dir)
  assert.equal(st.code, 0, st.err)
  const s = st.json.statement
  assert.equal(s.format, 'tapeapi-statement/1'); assert.equal(s.signed, false)
  assert.deepEqual(s.counts, { records: 5, claims: 5, notClaims: 0, duplicates: 0, openSent: 1 })
  assert.equal(s.totals.receipts, 5)
  assert.deepEqual(s.groups.map((g) => [g.model, g.receipts]), [['quirk-alias', 1], ['quirk-alias-s', 1], ['quirk-long', 1], ['quirk-small', 2]].map(([m, n]) => [m, n]).sort((a, b) => (a[0] < b[0] ? -1 : 1)))
  assert.equal(s.open.calls, 1)
  assert.equal(s.services.length, 1); assert.deepEqual(s.services[0].amounts, s.totals.amounts)
  // the same files through reconcile / 同样的文件交给 reconcile
  const rc = await cli(runReconcile, ['--receipts', 'spend.jsonl', '--since', from, '--until', to, '--policy', 'zero.json', '--mandate', 'mandate.json', '--token-decimals', '8', '--json'], dir)
  assert.equal(rc.code, 0, rc.err)
  assert.equal(rc.json.receipts.claims, s.counts.claims)
  assert.equal(rc.json.receipts.skipped.length, 0, 'reconcile does not count the sent lines as skipped')
  const rcOver = (name) => rc.json.policy.rules.find((r) => r.rule.name === name).over
  const usdOver = rcOver('usd'), bemOver = rcOver('bem'), callsOver = rcOver('calls')
  const usdWin = s.policy.rules.find((r) => r.rule === 'usd').windows, bemWin = s.policy.rules.find((r) => r.rule === 'bem').windows
  assert.deepEqual(usdOver.map((x) => [x.window, x.value]), usdWin.map((x) => [x.window, `${x.claimed.amount} USD`]))
  assert.deepEqual(bemOver.map((x) => x.value), [`${s.totals.amounts.BEM} BEM`])
  assert.deepEqual(callsOver.map((x) => x.value), s.policy.rules.find((r) => r.rule === 'calls').windows.map((x) => x.claimed.calls))
  assert.equal(usdWin.reduce((a, x) => a + units8(x.claimed.amount), 0n), units8(s.totals.amounts.USD))
  assert.equal(rc.json.mandate.scope[0].spent, s.mandate.scope[0].spent)
  assert.equal(s.mandate.scope[0].spent, s.totals.amounts.BEM)
  assert.deepEqual(s.policy.rules.find((r) => r.rule === 'bem').over, bemOver, 'the over facts are reconcile\'s own')
  // the open call is beside the claims, at its worst case, not in the totals / 未结的调用按最坏情况并列，不计入合计
  assert.equal(bemWin[0].worstCase.calls, 1)
  assert.equal(bemWin[0].worstCase.amount, fromUnits8(worstOf(hi({ messages: [{ role: 'user', content: 'drop' }] }), 'BEM')))
  // text, both languages / 文本，中英文
  const en = await cli(runReceipts, ['statement', '--receipts', 'spend.jsonl', '--from', from, '--to', to, '--policy', 'policy.json', '--mandate', 'mandate.json', '--token-decimals', '8', '--lang', 'en'], dir)
  assert.equal(en.code, 0, en.err)
  for (const re of [/your own summary, signed by nothing/, /per service/, /total: 5 receipts/, /SENT, NO VERIFIED RECEIPT: 1/, /POLICY policy\.json/, /MANDATE mandate\.json/, /Not the agent kit's spendStatement/, /quirk-long/]) assert.match(en.out, re)
  const zh = await cli(runReceipts, ['statement', '--receipts', 'spend.jsonl', '--from', from, '--to', to, '--lang', 'zh'], dir)
  for (const re of [/你自己的汇总，没有任何签名/, /按服务/, /合计: 5 张回执/, /已发出、没有核验过的回执：1 次/, /不是 agent 套件的 spendStatement/]) assert.match(zh.out, re)
  // the period: nothing before --from / 期间：--from 之前的不计
  const later = await cli(runReceipts, ['statement', '--receipts', 'spend.jsonl', '--from', day(now() + 86400), '--to', to, '--json'], dir)
  assert.equal(later.json.statement.totals.receipts, 0); assert.equal(later.json.statement.open.calls, 0)
  // usage mistakes / 用法错误
  for (const args of [['--from', from], ['--from', to, '--to', from], ['--from', from, '--to', to, '--near', '0.5'], ['--from', from, '--to', to, '--policy', 'mandate.json']]) {
    const r = await cli(runReceipts, ['statement', '--receipts', 'spend.jsonl', ...args], dir)
    assert.equal(r.code, 2, args.join(' ')); assert.match(r.err, /next: \/ 下一条命令: tapeapi receipts statement --help/)
  }
  const help = await cli(runReceipts, ['statement', '--help'], dir)
  assert.match(help.out, /signed by nothing|Nothing signs the statement/)
  for (const text of [st.out, en.out, zh.out, help.out]) assert.doesNotMatch(text, FORBIDDEN)
  for (const p of ['../src/budget.js', '../src/policy.js', '../src/statement-cli.js']) assert.doesNotMatch(readFileSync(new URL(p, import.meta.url), 'utf8'), FORBIDDEN, p)
})

test('the statement and the budget read no network and import nothing Node-only', () => {
  for (const p of ['../src/budget.js', '../src/policy.js', '../src/statement-cli.js']) {
    const src = readFileSync(new URL(p, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /from 'node:|require\(|fetch\(/, p)
  }
})

// ── the agent kit's limiter co-reads the policy / agent 套件的限额器共读策略 ──────────────────────────────────────
const E1 = '0x00000000000000000000000000000000000E5c71', E2 = '0x00000000000000000000000000000000000E5c72'
const HOLDER = addrOf(KEYS.principalHolder)
const AGENT_KEY = KEYS.agentKey, AGENT = addrOf(AGENT_KEY)
function checkOf() {
  const mandate = agent.normalizeMandate({ principal: '0x86DDaEF00401E3F10418398D67D7189fc458eA95', agent: '0x' + 'a6'.repeat(20), agentKey: AGENT, mode: 1, taskHash: '0x' + '12'.repeat(32), scope: [{ provider: S, token: BEM_TOKEN, cap: '100' }, { provider: S2, token: BEM_TOKEN, cap: '50' }], feeToken: '0x' + '00'.repeat(20), feeCap: '0', notBefore: NOW - 60, expires: NOW + 86400, nonce: '1', subdelegate: false })
  return { ok: true, enforcement: 'escrow-channel', phase: 1, mandate, mandateHash: '0x' + 'cd'.repeat(32), consumer: HOLDER, problems: [], scope: [{ provider: S, escrow: E1, claimedAtCheck: '0', available: null }, { provider: S2, escrow: E2, claimedAtCheck: '0', available: null }] }
}
test('limiter: payer({ budget, tokenDecimals }) admits each voucher\'s price (BEM, 8 places) before it is handed out; over the policy: BUDGET_EXCEEDED, released', async () => {
  const x = standardWorld()
  const api = x.api()
  const store = new Map()
  const lim = createSpendLimiter({ store: { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v) } }, clock: () => NOW })
  await lim.accept({ chainId: 56, agentKey: AGENT })
  await lim.start({ chainId: 56, check: checkOf() })
  const inner = () => api.payer({ consumer: HOLDER, sessionKey: AGENT_KEY })
  // 10 base units of an 8-decimal token = 0.0000001 BEM: two vouchers fit 0.00000025, the third does not
  const policy = total([{ name: 'agent BEM', service: S, period: 'total', maxAmount: '0.00000025', currency: 'BEM' }, { model: 'quirk-small', period: 'total', maxCalls: 0 }])
  const budget = createBudget({ policy })
  assert.throws(() => lim.payer({ chainId: 56, payer: inner(), budget }), (e) => e.code === 'INVALID_ARGUMENT' && /tokenDecimals/.test(e.message))
  assert.throws(() => lim.payer({ chainId: 56, payer: inner(), tokenDecimals: 8 }), (e) => e.code === 'INVALID_ARGUMENT' && /tokenDecimals applies with budget only/.test(e.message))
  const p = lim.payer({ chainId: 56, payer: inner(), maxPrice: { [S]: '100', [S2]: '50' }, budget, tokenDecimals: 8 })
  const svc = { container: S, manifest: { payment: { escrow: E1 } } }
  for (let i = 0; i < 2; i++) await (await p.reserve(svc, 10n)).commit()
  await assert.rejects(p.reserve(svc, 10n), (e) => { assert.equal(e.code, 'BUDGET_EXCEEDED', e.message); assert.deepEqual([e.data.spent, e.data.worstCase, e.data.cap], ['0.00000020', '0.00000010', '0.00000025']); return true })
  assert.equal(p.inflightOf(svc), 0, 'the refused voucher was released')
  assert.equal(p.cumulativeOf(svc), 20n)
  assert.deepEqual(budget.state().windows.map((w) => w.claimed.calls + w.worstCase.calls), [2, 0], 'two voucher lines; the model rule does not cover vouchers')
  // another provider, not covered by the service rule / 另一个 provider，不在服务规则内
  const s2 = { container: S2, manifest: { payment: { escrow: E2 } } }
  await (await p.reserve(s2, 5n)).commit()
  // a voucher released before it is accepted: its line is offset; signed again, it counts again (once)
  // 被接受之前释放的凭证：它的行被抵消；再签一次时再计入（一次）
  const before = budget.state()
  const l = await p.reserve(s2, 5n)
  assert.equal(budget.state().open, before.open + 1)
  l.release()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual([budget.state().open, budget.state().released], [before.open, before.released + 1])
  const again = await p.reserve(s2, 5n)
  assert.equal(again.next, l.next, 'the payer signs the released cumulative again')
  await again.commit()
  again.release()   // after commit: nothing to offset / 已接受之后释放：没有可抵消的
  await new Promise((r) => setImmediate(r))
  assert.deepEqual([budget.state().open, budget.state().released], [before.open + 1, before.released + 1])
  // without the budget the limiter is as before / 不给预算时限额器与以前相同
  const plain = lim.payer({ chainId: 56, payer: inner(), maxPrice: { [S]: '100', [S2]: '50' } })
  assert.equal(plain.mandateLimited, true)
})

// ── 3.0: the limiter's ceilings (with the method's listed priceBEM) and the budget, both on ─────────────────────
// The merged reserve path checks, in this order: the limiter's rules (spendDecision: maxCallPrice or 10% of the cap,
// lowered by the method's priceBEM when extra.method names it; the cap; the stops), the voucher's signature, then the
// budget (budget.admit). A voucher must fit all of them; the budget counts the voucher's price, not the listed one.
// 3.0：限额器上限（含方法公布的 priceBEM）与预算同时打开。顺序：限额器规则 → 凭证签名 → 预算；预算计的是凭证价格，不是公布价。
async function bothOn({ cap = '0.00000025', wrapInner } = {}) {
  const x = standardWorld()
  const api = x.api()
  const store = new Map()
  const lim = createSpendLimiter({ store: { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v) } }, clock: () => NOW })
  await lim.accept({ chainId: 56, agentKey: AGENT })
  await lim.start({ chainId: 56, check: checkOf() })
  const real = createBudget({ policy: total([{ name: 'agent BEM', service: S, period: 'total', maxAmount: cap, currency: 'BEM' }]) })
  const admits = []
  const budget = { admit: async (c) => { admits.push(c); return real.admit(c) }, release: (...a) => real.release(...a), state: () => real.state() }
  const raw = api.payer({ consumer: HOLDER, sessionKey: AGENT_KEY })
  const inner = wrapInner ? wrapInner(raw) : raw
  const p = lim.payer({ chainId: 56, payer: inner, maxPrice: { [S]: '100', [S2]: '50' }, budget, tokenDecimals: 8 })
  // priceBEM in BEM's 8 decimals: 'read' is listed at 20 units, 'cheap' at 5, 'free' at 0
  const svc = { container: S, manifest: { payment: { escrow: E1 }, methods: [{ name: 'read', priceBEM: '0.0000002' }, { name: 'cheap', priceBEM: '0.00000005' }, { name: 'free', priceBEM: '0' }] } }
  return { p, svc, real, admits }
}
const settle = () => new Promise((r) => setImmediate(r))
const spendRefused = (reason) => (e) => { assert.equal(e.code, 'AGENT_SPEND_REFUSED', e.message); assert.equal(e.data?.reason, reason, e.message); return true }

test('limiter and budget both on (a): a limiter refusal (over the listed priceBEM, a free method, over maxCallPrice) writes no budget line', async () => {
  const { p, svc, real, admits } = await bothOn()
  await assert.rejects(p.reserve(svc, 10n, { method: 'cheap' }), spendRefused('spend-call-price-above-ceiling'))
  await assert.rejects(p.reserve(svc, 1n, { method: 'free' }), spendRefused('spend-call-price-above-ceiling'))
  await assert.rejects(p.reserve(svc, 101n), spendRefused('spend-call-price-above-ceiling'))
  assert.equal(admits.length, 0, 'the budget was never asked')
  assert.deepEqual([real.state().sent, real.state().released, real.state().open], [0, 0, 0])
  assert.equal(p.inflightOf(svc), 0)
  assert.equal(p.cumulativeOf(svc), 0n)
})

test('limiter and budget both on (b): a budget refusal releases the lease (nothing in flight, cumulative unchanged) and leaves no open line; an admitted voucher released before acceptance gets a released offset', async () => {
  const { p, svc, real, admits } = await bothOn({ cap: '0.00000015' })
  await (await p.reserve(svc, 10n, { method: 'read' })).commit()
  await assert.rejects(p.reserve(svc, 10n, { method: 'read' }), (e) => { assert.equal(e.code, 'BUDGET_EXCEEDED', e.message); assert.equal(e.data.reason, 'budget-cap'); return true })
  assert.equal(admits.length, 2, 'the refused voucher reached the budget after the limiter and the signature check')
  assert.equal(p.inflightOf(svc), 0, 'the lease was released')
  assert.equal(p.cumulativeOf(svc), 10n, 'the refused voucher was not counted by the payer')
  assert.deepEqual([real.state().sent, real.state().open], [1, 1], 'the refusal wrote no sent line')
  // admitted, then released before it is accepted: one released line offsets its sent line
  const l = await p.reserve(svc, 5n, { method: 'read' })
  assert.deepEqual([real.state().sent, real.state().open], [2, 2])
  l.release()
  await settle()
  assert.deepEqual([real.state().sent, real.state().released, real.state().open], [2, 1, 1])
})

test('limiter and budget both on (c): the budget counts the voucher\'s price (10 units), not the method\'s listed priceBEM (20 units)', async () => {
  const { p, svc, real } = await bothOn()
  await (await p.reserve(svc, 10n, { method: 'read' })).commit()
  await (await p.reserve(svc, 10n, { method: 'read' })).commit()
  const w = real.state().windows[0]
  assert.equal(w.worstCase.amount, '0.00000020', 'two vouchers of 10 units = 0.0000002 BEM; at the listed price it would be 0.0000004')
  // the third fits the listed price but not the budget (0.00000030 > 0.00000025): the budget decides on actual prices
  await assert.rejects(p.reserve(svc, 10n, { method: 'read' }), (e) => e.code === 'BUDGET_EXCEEDED' && e.data.worstCase === '0.00000010' && e.data.spent === '0.00000020')
  // a smaller voucher still fits: 0.00000020 + 0.00000005 = 0.00000025
  await (await p.reserve(svc, 5n, { method: 'read' })).commit()
  assert.equal(real.state().windows[0].worstCase.amount, '0.00000025')
})

test('limiter and budget both on (d): the priceBEM ceiling applies only when extra.method names the method; a direct reserve keeps maxCallPrice alone, and the budget admits either', async () => {
  const { p, svc, admits } = await bothOn({ cap: '1' })
  await assert.rejects(p.reserve(svc, 10n, { method: 'cheap' }), spendRefused('spend-call-price-above-ceiling'))
  await assert.rejects(p.reserve(svc, 10n, { method: 'not-listed' }), spendRefused('spend-call-price-above-ceiling'))
  assert.equal(admits.length, 0)
  const direct = await p.reserve(svc, 10n)   // no extra: maxCallPrice 100 bounds it, the listed 5 does not
  await direct.commit()
  const noMethod = await p.reserve(svc, 10n, {})   // extra without a method: the same
  await noMethod.commit()
  assert.equal(admits.length, 2)
  assert.equal(p.cumulativeOf(svc), 20n)
})

test('limiter and budget both on (e): the order is limiter, then the voucher\'s signature, then the budget: a bad signature never reaches the budget (and stops the order)', async () => {
  const BAD_SIG = '0x' + '11'.repeat(65)
  const wrapInner = (raw) => new Proxy(raw, { get(t, k) {
    if (k === 'reserve') return async (...a) => { const l = await t.reserve(...a); return { ...l, voucher: { ...l.voucher, sig: BAD_SIG } } }
    const v = t[k]; return typeof v === 'function' ? v.bind(t) : v
  } })
  const { p, svc, real, admits } = await bothOn({ cap: '0.00000001', wrapInner })
  // 1. the limiter first: over the listed price, refused before the signature or the budget is looked at
  await assert.rejects(p.reserve(svc, 10n, { method: 'cheap' }), spendRefused('spend-call-price-above-ceiling'))
  assert.equal(admits.length, 0)
  // 2. then the signature: this voucher is also over the budget (10 units > 1), yet the refusal is the signature's
  await assert.rejects(p.reserve(svc, 10n, { method: 'read' }), spendRefused('spend-voucher-mismatch'))
  assert.equal(admits.length, 0, 'the budget was not asked for a voucher whose signature does not match')
  assert.deepEqual([real.state().sent, real.state().open], [0, 0])
  assert.equal(p.inflightOf(svc), 0)
  // the mismatch stopped the order: the next call is refused by the limiter, still before the budget
  await assert.rejects(p.reserve(svc, 1n), (e) => e.code === 'AGENT_SPEND_REFUSED')
  assert.equal(admits.length, 0)
})
