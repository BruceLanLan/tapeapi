// Regression (review G1 M14, M15): the official `openai` and `@anthropic-ai/sdk` packages, streaming and not, through
// ai.createVerifyingFetch and through tapeapi-verify, against the reference sidecar (server/src/ai-proxy.js over
// examples/ai-proxy/fake-upstream.mjs). Found with openai 7.23: the SDK stops reading at `data: [DONE]` and cancels the
// body, so a check that ran at the end of the stream never ran, and strict let an unverified stream through; a base URL
// that named the service by another host (localhost for 127.0.0.1) was passed through unverified and unreported.
// The packages are devDependencies of the repository root only; without them these tests are skipped.
// 回归测试：官方 openai 与 @anthropic-ai/sdk 包，流式与非流式，经由 createVerifyingFetch 与 tapeapi-verify，对着参考旁路。
// openai 7.23 读到 [DONE] 就停止并取消正文，流末尾的核验从未执行；主机名不同的 base URL 被原样放行且不报告。两个包只是仓库根的
// devDependencies；没装时跳过。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createTapeAPI, ai, TapeAPIError } from '../src/index.js'
import { createAIProxy } from '../../server/src/ai-proxy.js'
import { createFakeUpstream } from '../../examples/ai-proxy/fake-upstream.mjs'

let OpenAI = null, Anthropic = null
try { ({ default: OpenAI } = await import('openai')) } catch { /* not installed */ }
try { ({ default: Anthropic } = await import('@anthropic-ai/sdk')) } catch { /* not installed */ }
const skip = !OpenAI || !Anthropic ? 'the official openai / @anthropic-ai/sdk packages are not installed (npm install at the repository root)' : false

const KEY = '0x' + '42'.repeat(32)
const MODELS = [
  { id: 'demo-chat', formats: ['openai-chat', 'openai-responses'], prices: [{ currency: 'BEM', unit: '1M tokens', input: '0.15', output: '0.6' }] },
  { id: 'demo-claude', formats: ['anthropic-messages'], prices: [{ currency: 'BEM', unit: '1M tokens', input: '3', output: '15' }] },
]
const BASE = 'http://127.0.0.1:8798'
const manifestBase = (live = `${BASE}/tapeapi/v1`) => ({ name: 'Official SDK test', circuits: '0x0000000000000000000000000000000000000000', tokenId: '0', container: '0x0000000000000000000000000000000000000000', delegation: null, dev: true, endpoints: { live: [live], async: false } })

// What may happen to an answer between the sidecar and the client. / 旁路与客户端之间对回答可能发生的事。
const EDITS = {
  none: (s) => s,
  tamper: (s) => s.replace(/"model":"demo-(chat|claude)"/g, '"model":"demo-$1X"'),
  strip: (s) => s.replace(/: ?tapeapi-receipt [A-Za-z0-9_-]*\r?\n/g, ''),
}
async function edited(r, edit) {
  if (edit === 'none' || !r.body) return r
  const text = EDITS[edit](Buffer.from(await r.arrayBuffer()).toString('utf8'))
  const h = new Headers(r.headers)
  if (edit === 'strip') h.delete(ai.RECEIPT_HEADER)
  if (edit === 'tamper' && h.get(ai.RECEIPT_HEADER)) { /* the header receipt stays: the body no longer matches it */ }
  h.delete('content-length')
  return new Response(text, { status: r.status, headers: h })
}

async function world() {
  const fake = createFakeUpstream({ models: MODELS.map((m) => m.id) })
  const proxy = createAIProxy({ upstream: { baseUrl: 'http://fake.local/v1' }, fetch: fake.fetch, manifestBase: manifestBase(), signerKey: KEY, models: MODELS, allowHttp: true, rateLimit: false, log: () => {} })
  await proxy.ready
  const state = { edit: 'none', sent: 0, deliver: null }
  const route = async (input, init) => {
    state.sent++
    const r = await proxy.handleRequest(new Request(input, init))
    return state.deliver ? state.deliver(r) : edited(r, state.edit)
  }
  const api = createTapeAPI({ dev: true, fetch: (u, i) => proxy.handleRequest(new Request(u, i)) })
  const service = await api.resolve({ dev: BASE })
  const eps = Object.fromEntries(service.manifest.ai.endpoints.map((e) => [e.format, e.baseUrl]))
  return { proxy, state, route, api, service, eps }
}
// As a network delivers a stream: one chunk per event, then optionally a connection held open (`delayMs`) and reset
// (`error`) after the last byte (review RC-2, RC-4). / 按网络的方式送达：每个事件一块，最后一个字节之后可选地保持连接、再重置。
const perEvent = (edit = (s) => s, { stripHeader = false, delayMs = 0, error = false } = {}) => async (r) => {
  if (!r.body) return r
  const text = edit(Buffer.from(await r.arrayBuffer()).toString('utf8'))
  const h = new Headers(r.headers); h.delete('content-length')
  if (stripHeader) h.delete(ai.RECEIPT_HEADER)
  const te = new TextEncoder()
  const chunks = text.split(/(?<=\n\n)/)
  const body = new ReadableStream({
    async start(c) {
      for (const ch of chunks) c.enqueue(te.encode(ch))
      if (delayMs) await new Promise((ok) => setTimeout(ok, delayMs))
      if (error) c.error(new TypeError('socket reset')); else c.close()
    },
  })
  return new Response(body, { status: r.status, headers: h })
}
const stripReceipt = (s) => s.replace(/: ?tapeapi-receipt [A-Za-z0-9_-]*\r?\n/g, '')
const doneBeforeCompleted = (s) => s.replace(/event: response\.completed\n/, 'data: [DONE]\n\nevent: response.completed\n')
const verifying = (w, opts = {}) => {
  const reports = []
  const fetch = ai.createVerifyingFetch({ api: w.api, service: w.service, fetch: w.route, onReport: (r) => reports.push(r), ...opts })
  return { fetch, reports }
}
const openaiText = async (stream) => { let t = ''; for await (const c of stream) t += c.choices?.[0]?.delta?.content ?? ''; return t }
const anthropicText = async (stream) => { let t = ''; for await (const e of stream) if (e.type === 'content_block_delta') t += e.delta.text ?? ''; return t }
const responsesText = async (stream) => { let t = ''; for await (const e of stream) if (e.type === 'response.output_text.delta') t += e.delta; return t }
// A strict failure thrown from fetch (a stream's) reaches the caller wrapped by the SDK (APIConnectionError, cause = ours).
// 从 fetch 抛出的 strict 失败（流的）被 SDK 包装后到达调用方（APIConnectionError，cause 为我们的错误）。
// A whole answer that fails comes back as an HTTP 502 with code RECEIPT_INVALID (review RC-5): openai puts the code on
// the error, Anthropic in error.error. / 核验不过的整体回答以 HTTP 502 返回：openai 的 code 在错误上，Anthropic 的在 error.error 里。
const codeOf = (e) => (e instanceof TapeAPIError ? e.code : e?.cause instanceof TapeAPIError ? e.cause.code : e?.error?.error?.code ?? e?.code)

test('FIXED G1-M14: official SDKs, strict: every stream and every JSON answer is verified; nothing is "not read to the end"', { skip }, async () => {
  const w = await world()
  const { fetch, reports } = verifying(w)
  const oa = new OpenAI({ baseURL: w.eps['openai-chat'], apiKey: 'sk-demo', fetch, maxRetries: 0 })
  const an = new Anthropic({ baseURL: w.eps['anthropic-messages'], apiKey: 'sk-demo', fetch, maxRetries: 0 })
  assert.match(await openaiText(await oa.chat.completions.create({ model: 'demo-chat', stream: true, messages: [{ role: 'user', content: 'hello there' }] })), /hello there/)
  assert.match(await openaiText(await oa.chat.completions.create({ model: 'demo-chat', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'with usage' }] })), /with usage/)
  assert.match((await oa.chat.completions.create({ model: 'demo-chat', messages: [{ role: 'user', content: 'plain' }] })).choices[0].message.content, /plain/)
  assert.match(await responsesText(await oa.responses.create({ model: 'demo-chat', stream: true, input: 'responses stream' })), /responses stream/)
  assert.match(await anthropicText(await an.messages.create({ model: 'demo-claude', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'claude stream' }] })), /claude stream/)
  assert.match((await an.messages.create({ model: 'demo-claude', max_tokens: 64, messages: [{ role: 'user', content: 'claude plain' }] })).content[0].text, /claude plain/)
  assert.deepEqual(reports.map((r) => [r.stream, r.ok, r.warnings.length]), [[true, true, 0], [true, true, 0], [false, true, 0], [true, true, 0], [true, true, 0], [false, true, 0]],
    reports.map((r) => r.problems.concat(r.warnings).join('; ')).join(' | '))
})

for (const edit of ['tamper', 'strip']) {
  test(`FIXED G1-M14: official SDKs, strict: a ${edit === 'tamper' ? 'tampered answer' : 'stripped receipt'} makes the stream iterator throw RECEIPT_INVALID (and the JSON call fail)`, { skip }, async () => {
    const w = await world()
    w.state.edit = edit
    const { fetch, reports } = verifying(w)
    const oa = new OpenAI({ baseURL: w.eps['openai-chat'], apiKey: 'sk-demo', fetch, maxRetries: 0 })
    const an = new Anthropic({ baseURL: w.eps['anthropic-messages'], apiKey: 'sk-demo', fetch, maxRetries: 0 })
    const cases = [
      ['openai chat stream', async () => openaiText(await oa.chat.completions.create({ model: 'demo-chat', stream: true, messages: [{ role: 'user', content: 'hi' }] }))],
      ['openai responses stream', async () => responsesText(await oa.responses.create({ model: 'demo-chat', stream: true, input: 'hi' }))],
      ['anthropic stream', async () => anthropicText(await an.messages.create({ model: 'demo-claude', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }))],
      ['openai json', async () => oa.chat.completions.create({ model: 'demo-chat', messages: [{ role: 'user', content: 'hi' }] })],
      ['anthropic json', async () => an.messages.create({ model: 'demo-claude', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] })],
    ]
    for (const [what, run] of cases) await assert.rejects(run(), (e) => codeOf(e) === 'RECEIPT_INVALID', what)
    assert.equal(reports.length, cases.length)
    assert.ok(reports.every((r) => r.ok === false && r.problems.length > 0 && !r.warnings.some((x) => /not read to the end/.test(x))), reports.map((r) => r.problems.join('; ')).join(' | '))
  })
}

test('FIXED G1-M14: official SDKs, not strict: streams are verified and reported, and the answer still arrives', { skip }, async () => {
  const w = await world()
  w.state.edit = 'tamper'
  const { fetch, reports } = verifying(w, { strict: false })
  const oa = new OpenAI({ baseURL: w.eps['openai-chat'], apiKey: 'sk-demo', fetch, maxRetries: 0 })
  const an = new Anthropic({ baseURL: w.eps['anthropic-messages'], apiKey: 'sk-demo', fetch, maxRetries: 0 })
  assert.match(await openaiText(await oa.chat.completions.create({ model: 'demo-chat', stream: true, messages: [{ role: 'user', content: 'hi you' }] })), /hi you/)
  assert.match(await anthropicText(await an.messages.create({ model: 'demo-claude', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi you' }] })), /hi you/)
  assert.deepEqual(reports.map((r) => [r.stream, r.ok]), [[true, false], [true, false]])
  assert.ok(reports.every((r) => r.problems.some((p) => /responseSha256|model/.test(p))))
})

test('FIXED G1-M15: a base URL that is not the manifest\'s endpoint (localhost for 127.0.0.1): strict refuses before sending; otherwise onReport says "not verified: endpoint mismatch"', { skip }, async () => {
  const w = await world()
  const other = (u) => u.replace('127.0.0.1', 'localhost')
  const strict = verifying(w)
  const oa = new OpenAI({ baseURL: other(w.eps['openai-chat']), apiKey: 'sk-demo', fetch: strict.fetch, maxRetries: 0 })
  const an = new Anthropic({ baseURL: other(w.eps['anthropic-messages']), apiKey: 'sk-demo', fetch: strict.fetch, maxRetries: 0 })
  const sent = w.state.sent
  for (const run of [
    async () => openaiText(await oa.chat.completions.create({ model: 'demo-chat', stream: true, messages: [{ role: 'user', content: 'hi' }] })),
    async () => oa.chat.completions.create({ model: 'demo-chat', messages: [{ role: 'user', content: 'hi' }] }),
    async () => anthropicText(await an.messages.create({ model: 'demo-claude', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] })),
  ]) {
    await assert.rejects(run(), (e) => {
      const err = e instanceof TapeAPIError ? e : e.cause
      return err?.code === 'INVALID_ARGUMENT' && /localhost:8798.*endpoint is http:\/\/127\.0\.0\.1:8798/.test(err.message) && err.data.expected.startsWith('http://127.0.0.1:8798')
    })
  }
  assert.equal(w.state.sent, sent, 'nothing was sent')
  // not strict: the call goes on, and says it was not verified / 非 strict：照常发出，并说明未核验
  const loose = verifying(w, { strict: false })
  const oa2 = new OpenAI({ baseURL: other(w.eps['openai-chat']), apiKey: 'sk-demo', fetch: async (u, i) => loose.fetch(u, i), maxRetries: 0 })
  // the loose fetch passes the request on to the given fetch (here the sidecar, whatever the host) / 放行给所给的 fetch
  assert.match((await oa2.chat.completions.create({ model: 'demo-chat', messages: [{ role: 'user', content: 'hi' }] })).choices[0].message.content, /hi/)
  assert.equal(loose.reports.length, 1)
  assert.equal(loose.reports[0].ok, false); assert.equal(loose.reports[0].mismatch, true)
  assert.match(loose.reports[0].problems[0], /^not verified: endpoint mismatch: POST http:\/\/localhost:8798\/v1\/chat\/completions/)
  // a path no format meters is not a mismatch: it passes as before / 不计量的路径不算不匹配
  const models = await strict.fetch('http://localhost:8798/v1/models', { headers: { authorization: 'Bearer sk-demo' } })
  assert.equal(models.status, 200)
})

// tapeapi-verify --strict with the official openai SDK: a stripped receipt must not let [DONE] through first.
// tapeapi-verify --strict 配官方 openai SDK：回执被剥掉时，[DONE] 不能先送达。
test('FIXED G1-M14: tapeapi-verify --strict: with the receipt stripped, the openai and anthropic stream iterators fail instead of completing', { skip }, async () => {
  const fake = createFakeUpstream({ models: MODELS.map((m) => m.id) })
  let proxy
  const knobs = { edit: 'none' }
  const srv = http.createServer(async (req, res) => {
    const parts = []; for await (const c of req) parts.push(c)
    const headers = new Headers(); for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1])
    const r = await edited(await proxy.handleRequest(new Request(new URL(req.url, 'http://127.0.0.1'), { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(parts) })), knobs.edit)
    res.writeHead(r.status, Object.fromEntries(r.headers))
    if (!r.body) return res.end()
    res.end(Buffer.from(await r.arrayBuffer()))
  })
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
  const url = `http://127.0.0.1:${srv.address().port}`
  proxy = createAIProxy({ upstream: { baseUrl: 'http://fake.local/v1' }, fetch: fake.fetch, manifestBase: manifestBase(`${url}/tapeapi/v1`), signerKey: KEY, models: MODELS, allowHttp: true, rateLimit: false, log: () => {} })
  await proxy.ready
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/tapeapi-verify.js', import.meta.url)), '--dev', url, '--port', '0', '--strict'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { err += d })
  try {
    const local = await new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error(`not started: ${err}`)), 15_000)
      const on = () => { const m = /listening on (http:\/\/\S+)/.exec(err); if (m) { clearTimeout(t); ok(m[1]) } }
      child.stderr.on('data', on); on()
    })
    const oa = new OpenAI({ baseURL: `${local}/v1`, apiKey: 'sk-demo', maxRetries: 0 })
    const an = new Anthropic({ baseURL: local, apiKey: 'sk-demo', maxRetries: 0 })
    assert.match(await openaiText(await oa.chat.completions.create({ model: 'demo-chat', stream: true, messages: [{ role: 'user', content: 'fine' }] })), /fine/)
    knobs.edit = 'strip'
    await assert.rejects(openaiText(await oa.chat.completions.create({ model: 'demo-chat', stream: true, messages: [{ role: 'user', content: 'hi' }] })), /usage receipt did not verify|receipt/)
    await assert.rejects(anthropicText(await an.messages.create({ model: 'demo-claude', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] })), /usage receipt did not verify|receipt/)
  } finally {
    await new Promise((ok) => { if (child.exitCode !== null) return ok(); child.once('exit', ok); child.kill('SIGTERM') })
    await new Promise((ok) => { srv.closeAllConnections(); srv.close(ok) })
  }
})

// FIXED RC-2 (review 2026-09-29, O P0-1): in strict mode the end of a stream is `data: [DONE]`, the format's final event
// (response.completed, message_stop, ...) or the upstream closing, whichever comes first, and at that point a receipt must
// already have verified. openai 7.23 stops reading every stream at `[DONE]`: with the receipt stripped and a `[DONE]`
// inserted before response.completed, the Responses iterator used to complete with the unverified text.
// FIXED RC-2：strict 下，流的结束是 [DONE]、格式的最终事件或上游关闭（先到者），此时回执必须已经核验通过。openai 7.23 对所有流
// 读到 [DONE] 就停止：回执被剥掉、又在 response.completed 之前插入 [DONE] 时，Responses 迭代器曾以未核验的文本正常结束。
test('FIXED RC-2: strict, one chunk per event: [DONE] before response.completed, a stripped receipt, or no final event: every iterator throws RECEIPT_INVALID', { skip }, async () => {
  const w = await world()
  const { fetch, reports } = verifying(w)
  const oa = new OpenAI({ baseURL: w.eps['openai-chat'], apiKey: 'sk-demo', fetch, maxRetries: 0 })
  const an = new Anthropic({ baseURL: w.eps['anthropic-messages'], apiKey: 'sk-demo', fetch, maxRetries: 0 })
  const responses = async () => responsesText(await oa.responses.create({ model: 'demo-chat', stream: true, input: 'secret answer' }))
  const chat = async () => openaiText(await oa.chat.completions.create({ model: 'demo-chat', stream: true, messages: [{ role: 'user', content: 'secret answer' }] }))
  const claude = async () => anthropicText(await an.messages.create({ model: 'demo-claude', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'secret answer' }] }))
  // Honest, one chunk per event: all verified. / 诚实的流，每个事件一块：全部核验通过。
  w.state.deliver = perEvent()
  for (const run of [responses, chat, claude]) assert.match(await run(), /secret answer/)
  assert.deepEqual(reports.splice(0).map((r) => r.ok), [true, true, true])
  const cases = [
    ['responses: receipt stripped, [DONE] before response.completed', responses, perEvent((s) => doneBeforeCompleted(stripReceipt(s)))],
    ['responses: receipt kept, [DONE] before response.completed', responses, perEvent(doneBeforeCompleted)],
    ['responses: receipt stripped, tampered, [DONE] before response.completed', responses, perEvent((s) => doneBeforeCompleted(stripReceipt(s)).replace(/secret answer/g, 'FORGED ANSWER'))],
    ['responses: receipt stripped', responses, perEvent(stripReceipt)],
    ['chat: receipt stripped', chat, perEvent(stripReceipt)],
    ['anthropic: receipt stripped', claude, perEvent(stripReceipt)],
    ['anthropic: receipt moved after message_stop', claude, perEvent((s) => { const m = /: ?tapeapi-receipt [A-Za-z0-9_-]*\r?\n\r?\n/.exec(s); return stripReceipt(s) + m[0] })],
    ['chat: receipt stripped, cut before [DONE]', chat, perEvent((s) => stripReceipt(s).replace(/data: \[DONE\]\n\n$/, ''))],
  ]
  for (const [what, run, deliver] of cases) {
    w.state.deliver = deliver
    await assert.rejects(run(), (e) => codeOf(e) === 'RECEIPT_INVALID', what)
  }
  assert.equal(reports.length, cases.length)
  assert.ok(reports.every((r) => r.ok === false && r.problems.length > 0), reports.map((r) => r.problems.concat(r.warnings).join('; ')).join(' | '))
})

// A local sidecar behind tapeapi-verify, its answers delivered one chunk per event (review RC-2).
// tapeapi-verify 后面的本地旁路，回答按每个事件一块送达。
async function verifyCli(args = ['--strict']) {
  const fake = createFakeUpstream({ models: MODELS.map((m) => m.id) })
  let proxy
  const knobs = { edit: (s) => s }
  const srv = http.createServer(async (req, res) => {
    const parts = []; for await (const c of req) parts.push(c)
    const headers = new Headers(); for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1])
    const r = await proxy.handleRequest(new Request(new URL(req.url, 'http://127.0.0.1'), { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(parts) }))
    const h = Object.fromEntries(r.headers); delete h['content-length']
    res.writeHead(r.status, h)
    if (!r.body) return res.end()
    for (const ch of knobs.edit(Buffer.from(await r.arrayBuffer()).toString('utf8')).split(/(?<=\n\n)/)) { res.write(ch); await new Promise((ok) => setTimeout(ok, 5)) }
    res.end()
  })
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
  const url = `http://127.0.0.1:${srv.address().port}`
  proxy = createAIProxy({ upstream: { baseUrl: 'http://fake.local/v1' }, fetch: fake.fetch, manifestBase: manifestBase(`${url}/tapeapi/v1`), signerKey: KEY, models: MODELS, allowHttp: true, rateLimit: false, log: () => {} })
  await proxy.ready
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/tapeapi-verify.js', import.meta.url)), '--dev', url, '--port', '0', ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { err += d })
  const close = async () => {
    await new Promise((ok) => { if (child.exitCode !== null) return ok(); child.once('exit', ok); child.kill('SIGTERM') })
    await new Promise((ok) => { srv.closeAllConnections(); srv.close(ok) })
  }
  try {
    const local = await new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error(`not started: ${err}`)), 15_000)
      const on = () => { const m = /listening on (http:\/\/\S+)/.exec(err); if (m) { clearTimeout(t); ok(m[1]) } }
      child.stderr.on('data', on); on()
    })
    return { local, knobs, close, log: () => err }
  } catch (e) { await close(); throw e }
}

test('FIXED RC-2: tapeapi-verify --strict, one chunk per event: [DONE] before response.completed with the receipt stripped ends in response.failed (receipt_invalid); chat and anthropic iterators throw', { skip }, async () => {
  const cli = await verifyCli(['--strict'])
  try {
    const oa = new OpenAI({ baseURL: `${cli.local}/v1`, apiKey: 'sk-demo', maxRetries: 0 })
    const an = new Anthropic({ baseURL: cli.local, apiKey: 'sk-demo', maxRetries: 0 })
    const events = async () => { const out = []; for await (const e of await oa.responses.create({ model: 'demo-chat', stream: true, input: 'secret answer' })) out.push(e); return out }
    // honest: completes, verified / 诚实：正常完成、核验通过
    const ok = await events()
    assert.equal(ok.at(-1).type, 'response.completed')
    for (const edit of [(s) => doneBeforeCompleted(stripReceipt(s)), doneBeforeCompleted, stripReceipt]) {
      cli.knobs.edit = edit
      const got = await events()
      const last = got.at(-1)
      assert.equal(last.type, 'response.failed', JSON.stringify(got.map((e) => e.type)))
      assert.equal(last.response.error.code, 'receipt_invalid')
      assert.ok(!got.some((e) => e.type === 'response.completed'))
    }
    cli.knobs.edit = stripReceipt
    await assert.rejects(openaiText(await oa.chat.completions.create({ model: 'demo-chat', stream: true, messages: [{ role: 'user', content: 'hi' }] })), /usage receipt did not verify/)
    await assert.rejects(anthropicText(await an.messages.create({ model: 'demo-claude', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] })), /usage receipt did not verify/)
  } finally { await cli.close() }
})

// FIXED RC-4 (review 2026-09-29, O P1-1 / F P1-5): only strict holds anything, and only until the receipt verifies at the
// end of the stream, not until the upstream closes the connection. Not strict holds nothing, and an upstream that breaks
// off after the final event does not fail the call.
// FIXED RC-4：只有 strict 会扣留，而且只扣到流结束处回执核验通过为止，不再等上游关闭连接。非 strict 不扣留；上游在最终事件之后
// 断开不算失败。
test('FIXED RC-4: a connection held open after [DONE] no longer delays the openai iterator (strict and not); not strict, a reset after the final event is not a failure', { skip }, async () => {
  const w = await world()
  const chat = async (oa) => openaiText(await oa.chat.completions.create({ model: 'demo-chat', stream: true, messages: [{ role: 'user', content: 'hello' }] }))
  const claude = async (oa, an) => anthropicText(await an.messages.create({ model: 'demo-claude', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hello' }] }))
  const run = async (opts, deliver, f) => {
    w.state.deliver = deliver
    const v = verifying(w, opts)
    const oa = new OpenAI({ baseURL: w.eps['openai-chat'], apiKey: 'sk-demo', fetch: v.fetch, maxRetries: 0 })
    const an = new Anthropic({ baseURL: w.eps['anthropic-messages'], apiKey: 'sk-demo', fetch: v.fetch, maxRetries: 0 })
    const t0 = performance.now()
    const text = await f(oa, an)
    return { ms: performance.now() - t0, text, reports: v.reports }
  }
  for (const strict of [true, false]) {
    const r = await run({ strict }, perEvent((s) => s, { delayMs: 1500 }), chat)
    assert.match(r.text, /hello/)
    assert.ok(r.ms < 700, `strict=${strict}: ${r.ms.toFixed(0)} ms`)
    await new Promise((ok) => setTimeout(ok, 20))
    assert.deepEqual(r.reports.map((x) => x.ok), [true], `strict=${strict}`)
  }
  // Not strict: the upstream resets the connection 100 ms after the final event. / 非 strict：上游在最终事件后 100 ms 重置连接。
  for (const [what, f] of [['openai', chat], ['anthropic', claude]]) {
    const r = await run({ strict: false }, perEvent((s) => s, { delayMs: 100, error: true }), f)
    assert.match(r.text, /hello/, what)
    await new Promise((ok) => setTimeout(ok, 150))
    assert.deepEqual(r.reports.map((x) => x.ok), [true], what)
  }
})

// FIXED RC-5 (review 2026-09-29, O P1-2): a whole answer that fails its check used to be thrown from fetch; the official
// SDKs wrap that (APIConnectionError) and retry it twice by default, so one bad receipt meant 3 upstream requests, each
// possibly paid. Now strict answers with a synthetic HTTP 502 carrying x-should-retry: false, which openai 7.23 and
// @anthropic-ai/sdk 0.128 obey (shouldRetry reads the header before the status): an APIError, and 1 request.
// FIXED RC-5：核验不过的整体回答原先从 fetch 抛出，官方 SDK 包装后默认再重试两次：一份坏回执 = 3 次上游请求，每次都可能付费。
// 现在 strict 返回合成的 HTTP 502，带 x-should-retry: false，两个 SDK 都遵守：抛 APIError，只发 1 次请求。
test('FIXED RC-5: strict, a whole answer that fails: a synthetic 502 (x-should-retry: false), APIError with code RECEIPT_INVALID, 1 upstream request with the SDKs\' default retries', { skip }, async () => {
  const w = await world()
  const { fetch, reports } = verifying(w)
  const oa = new OpenAI({ baseURL: w.eps['openai-chat'], apiKey: 'sk-demo', fetch })          // default maxRetries (2) / 默认重试
  const an = new Anthropic({ baseURL: w.eps['anthropic-messages'], apiKey: 'sk-demo', fetch })
  for (const edit of ['tamper', 'strip']) {
    w.state.edit = edit
    let sent = w.state.sent
    await assert.rejects(oa.chat.completions.create({ model: 'demo-chat', messages: [{ role: 'user', content: 'hi' }] }), (e) => {
      assert.ok(e instanceof OpenAI.APIError && !(e instanceof OpenAI.APIConnectionError), e.constructor.name)
      assert.equal(e.status, 502); assert.equal(e.code, 'RECEIPT_INVALID'); assert.match(e.message, /usage receipt: /)
      return true
    })
    assert.equal(w.state.sent - sent, 1, `openai ${edit}: one upstream request`)
    sent = w.state.sent
    await assert.rejects(an.messages.create({ model: 'demo-claude', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }), (e) => {
      assert.ok(e instanceof Anthropic.APIError && !(e instanceof Anthropic.APIConnectionError), e.constructor.name)
      assert.equal(e.status, 502); assert.equal(e.error.type, 'error'); assert.equal(e.error.error.code, 'RECEIPT_INVALID')
      assert.match(e.error.error.message, /usage receipt: /)
      return true
    })
    assert.equal(w.state.sent - sent, 1, `anthropic ${edit}: one upstream request`)
    // A plain fetch caller checks res.ok. / 直接用 fetch 的调用方检查 res.ok。
    const res = await fetch(`${w.eps['openai-chat']}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-demo' }, body: JSON.stringify({ model: 'demo-chat', messages: [{ role: 'user', content: 'hi' }] }) })
    assert.equal(res.ok, false); assert.equal(res.status, 502)
    assert.equal(res.headers.get('x-should-retry'), 'false'); assert.equal(res.headers.get('x-tapeapi-verify-error'), 'RECEIPT_INVALID')
    const body = await res.json()
    assert.equal(body.error.code, 'RECEIPT_INVALID'); assert.equal(body.error.type, 'tapeapi_verify_error')
  }
  assert.equal(reports.length, 6)
  assert.ok(reports.every((r) => r.ok === false && r.problems.length && r.stream === false))
})
