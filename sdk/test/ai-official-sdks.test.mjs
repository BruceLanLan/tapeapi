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
// `hold`: a promise that keeps the connection open after the last byte until the test settles it (a gate instead of a timer;
// FIXED RC-4 deflake). / `hold`：最后一个字节之后保持连接，直到测试放行的 promise（用门代替定时器）。
// `cut` (FIXED SSE-END): 'event' (one chunk per event), 'whole' (one chunk), or 'tail' (one chunk per event up to the first end
// marker, `[DONE]` or a final event, then it and everything after it in one chunk). The chunks are enqueued at once, so the
// cutting is the test's own, not a timer's. / `cut`：每事件一块、整块，或在第一个结束标记之前每事件一块、其后全部一块。各块一次性
// 放入，分块完全由测试决定，与定时无关。
const CUTS = ['event', 'whole', 'tail']
function cutText(text, cut) {
  const ev = text.split(/(?<=\r?\n\r?\n)/)
  if (cut === 'whole') return [text]
  const i = ev.findIndex((e) => /^data: ?\[DONE\]\r?\n/.test(e) || /^event: ?(response\.completed|response\.incomplete|response\.failed|message_stop)\r?\n/.test(e))
  return cut === 'tail' && i >= 0 ? [...ev.slice(0, i), ev.slice(i).join('')] : ev
}
const perEvent = (edit = (s) => s, { stripHeader = false, delayMs = 0, error = false, hold = null, cut = 'event' } = {}) => async (r) => {
  if (!r.body) return r
  const text = edit(Buffer.from(await r.arrayBuffer()).toString('utf8'))
  const h = new Headers(r.headers); h.delete('content-length')
  if (stripHeader) h.delete(ai.RECEIPT_HEADER)
  const te = new TextEncoder()
  const chunks = cutText(text, cut)
  const body = new ReadableStream({
    async start(c) {
      for (const ch of chunks) c.enqueue(te.encode(ch))
      if (hold) await hold
      else if (delayMs) await new Promise((ok) => setTimeout(ok, delayMs))
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
// Waits for a condition by yielding to the event loop, not by a fixed pause; `cap` only keeps a broken run from hanging.
// 靠让出事件循环等待条件成立，而不是固定的暂停；`cap` 只是防止出错的运行挂死。
async function until(cond, what, cap = 10_000) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > cap) assert.fail(`timed out waiting for ${what}`)
    await new Promise((ok) => setImmediate(ok))
  }
}
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
// FIXED SSE-END: the same cases with the end and what follows it in one chunk ('whole', 'tail'): the verdict used to depend
// on the cutting (a `[DONE]` before response.completed with the receipt kept verified when both came in one chunk), and the
// receipt moved to the start with a `[DONE]` inserted before a word cut the answer short and still verified.
// FIXED SSE-END：同样的用例，结束点与其后内容在同一块（'whole'、'tail'）：结论曾取决于切分（保留回执、在 response.completed 之前
// 插入 [DONE]，两者同块到达时核验通过）；把回执移到开头、在某个词前插入 [DONE] 会截断回答而核验照样通过。
const receiptToStart = (s) => { const m = /: ?tapeapi-receipt [A-Za-z0-9_-]*\r?\n\r?\n/.exec(s); return m[0] + s.replace(m[0], '') }
const doneBefore = (word) => (s) => { const ev = s.split(/(?<=\n\n)/); const i = ev.findIndex((e) => e.includes(`" ${word}"`)); assert.ok(i > 0, word); ev.splice(i, 0, 'data: [DONE]\n\n'); return ev.join('') }
for (const cut of CUTS) {
  test(`FIXED RC-2${cut === 'event' ? '' : ', FIXED SSE-END'}: strict, ${cut === 'event' ? 'one chunk per event' : cut === 'whole' ? 'the whole answer in one chunk' : 'the end and the rest in one chunk'}: [DONE] before response.completed, a stripped receipt, a cut-short answer, or no final event: every iterator throws RECEIPT_INVALID`, { skip }, async () => {
    const w = await world()
    const { fetch, reports } = verifying(w)
    const oa = new OpenAI({ baseURL: w.eps['openai-chat'], apiKey: 'sk-demo', fetch, maxRetries: 0 })
    const an = new Anthropic({ baseURL: w.eps['anthropic-messages'], apiKey: 'sk-demo', fetch, maxRetries: 0 })
    const responses = async () => responsesText(await oa.responses.create({ model: 'demo-chat', stream: true, input: 'secret answer never' }))
    const chat = async () => openaiText(await oa.chat.completions.create({ model: 'demo-chat', stream: true, messages: [{ role: 'user', content: 'secret answer never' }] }))
    const claude = async () => anthropicText(await an.messages.create({ model: 'demo-claude', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'secret answer never' }] }))
    const deliver = (edit) => perEvent(edit, { cut })
    // Honest: all verified. / 诚实的流：全部核验通过。
    w.state.deliver = deliver()
    for (const run of [responses, chat, claude]) assert.match(await run(), /secret answer never/)
    assert.deepEqual(reports.splice(0).map((r) => r.ok), [true, true, true])
    const cases = [
      ['responses: receipt stripped, [DONE] before response.completed', responses, deliver((s) => doneBeforeCompleted(stripReceipt(s)))],
      ['responses: receipt kept, [DONE] before response.completed', responses, deliver(doneBeforeCompleted)],
      ['responses: receipt stripped, tampered, [DONE] before response.completed', responses, deliver((s) => doneBeforeCompleted(stripReceipt(s)).replace(/secret answer/g, 'FORGED ANSWER'))],
      ['responses: receipt stripped', responses, deliver(stripReceipt)],
      ['responses: receipt moved to the start, [DONE] before " never"', responses, deliver((s) => doneBefore('never')(receiptToStart(s)))],
      ['chat: receipt stripped', chat, deliver(stripReceipt)],
      ['chat: receipt moved to the start, [DONE] before " never"', chat, deliver((s) => doneBefore('never')(receiptToStart(s)))],
      ['anthropic: receipt stripped', claude, deliver(stripReceipt)],
      ['anthropic: receipt moved after message_stop', claude, deliver((s) => { const m = /: ?tapeapi-receipt [A-Za-z0-9_-]*\r?\n\r?\n/.exec(s); return stripReceipt(s) + m[0] })],
      ['chat: receipt stripped, cut before [DONE]', chat, deliver((s) => stripReceipt(s).replace(/data: \[DONE\]\n\n$/, ''))],
    ]
    for (const [what, run, d] of cases) {
      w.state.deliver = d
      await assert.rejects(run(), (e) => codeOf(e) === 'RECEIPT_INVALID', `${cut}: ${what}`)
    }
    assert.equal(reports.length, cases.length, cut)
    assert.ok(reports.every((r) => r.ok === false && r.problems.length > 0), reports.map((r) => r.problems.concat(r.warnings).join('; ')).join(' | '))
  })
}

// A local sidecar behind tapeapi-verify, its answers delivered one chunk per event (review RC-2).
// tapeapi-verify 后面的本地旁路，回答按每个事件一块送达。
// "One chunk per event" is what the test is about, but over a real TCP connection into another process the reader's chunks
// are the kernel's and node's to cut: two writes a few ms apart arrive as one read on a busy machine (the old 5 ms pause
// between writes lost that race 1 in 40..120 runs under load, and the CLI then saw `[DONE]` and the final event in one
// chunk, a different input from the one asserted on). The test now makes the chunking its own: the sidecar writes the next
// chunk only after the CLI has handed everything written so far to the client (`got >= sent`, counted by `cli.fetch`, the
// fetch the test's SDK clients use) or has hung up on the sidecar (it aborts a stream it fails). Nothing waits on a clock;
// the only timer is a 10 s fail-safe against a hang.
// 「每个事件一块」是本测试要的输入，但经真实 TCP 进入另一个进程时，读取方的分块由内核与 node 决定：忙的机器上，隔几毫秒的两次写入
// 会合成一次读取（旧的写间 5 ms 暂停在高负载下 40..120 次里输一次，CLI 随后在同一块里看到 `[DONE]` 与最终事件，与断言所针对的输入
// 不同）。现在由测试自己决定分块：旁路只在 CLI 把已写出的全部内容交给客户端（`got >= sent`，由测试的 SDK 客户端所用的 `cli.fetch`
// 计数）或 CLI 挂断旁路（它会中止自己判失败的流）之后才写下一块。不再等时钟；唯一的定时器是防挂死的 10 秒保险。
async function verifyCli(args = ['--strict']) {
  const fake = createFakeUpstream({ models: MODELS.map((m) => m.id) })
  let proxy
  // cut: as perEvent's (FIXED SSE-END); hold: a promise the sidecar waits on before it ends an answer (a gate, not a timer);
  // last: the last answer as the sidecar wrote it. / cut 同 perEvent；hold：旁路结束回答之前等待的 promise（门，不是定时器）；
  // last：旁路最近写出的回答。
  const knobs = { edit: (s) => s, cut: 'event', hold: null, last: null }
  // One flow per request: bytes the sidecar wrote, bytes the client read back from the CLI, whether the CLI hung up.
  // 每个请求一个流量记录：旁路写出的字节、客户端从 CLI 读回的字节、CLI 是否已挂断。
  let current = null
  const poke = (f) => { for (const w of [...f.waiters]) w() }
  const cliFetch = async (url, init) => {
    const f = { sent: 0, got: 0, closed: false, waiters: new Set() }
    current = f
    const r = await fetch(url, init)
    if (!r.body) return r
    const counted = r.body.pipeThrough(new TransformStream({ transform(c, ctl) { f.got += c.byteLength; poke(f); ctl.enqueue(c) } }))
    return new Response(counted, { status: r.status, statusText: r.statusText, headers: r.headers })
  }
  const handedOn = (f) => new Promise((ok) => {
    const w = () => { if (f.got >= f.sent || f.closed) { f.waiters.delete(w); clearTimeout(t); ok() } }
    const t = setTimeout(ok, 10_000)
    f.waiters.add(w); w()
  })
  const srv = http.createServer(async (req, res) => {
    const parts = []; for await (const c of req) parts.push(c)
    const headers = new Headers(); for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1])
    const r = await proxy.handleRequest(new Request(new URL(req.url, 'http://127.0.0.1'), { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(parts) }))
    const h = Object.fromEntries(r.headers); delete h['content-length']
    res.writeHead(r.status, h)
    if (!r.body) return res.end()
    // (the CLI's own requests, e.g. at start-up, did not come through cliFetch: written whole, no flow control)
    // （CLI 自己的请求，例如启动时的，不经过 cliFetch：整块写出，不做流控）
    const f = current
    if (f) res.on('close', () => { f.closed = true; poke(f) })
    const text = knobs.edit(Buffer.from(await r.arrayBuffer()).toString('utf8'))
    if (req.method === 'POST') knobs.last = text
    for (const ch of cutText(text, knobs.cut)) {
      if (f?.closed) break
      res.write(ch)
      if (f) { f.sent += Buffer.byteLength(ch); await handedOn(f) }
    }
    if (knobs.hold) await knobs.hold
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
    return { local, knobs, close, fetch: cliFetch, log: () => err }
  } catch (e) { await close(); throw e }
}

for (const cut of CUTS) {
  test(`FIXED RC-2${cut === 'event' ? '' : ', FIXED SSE-END'}: tapeapi-verify --strict, ${cut === 'event' ? 'one chunk per event' : cut === 'whole' ? 'the whole answer in one chunk' : 'the end and the rest in one chunk'}: [DONE] before response.completed (receipt stripped or kept) or a cut-short answer ends in response.failed (receipt_invalid); chat and anthropic iterators throw`, { skip }, async () => {
    const cli = await verifyCli(['--strict'])
    cli.knobs.cut = cut
    try {
      const oa = new OpenAI({ baseURL: `${cli.local}/v1`, apiKey: 'sk-demo', maxRetries: 0, fetch: cli.fetch })
      const an = new Anthropic({ baseURL: cli.local, apiKey: 'sk-demo', maxRetries: 0, fetch: cli.fetch })
      const events = async () => { const out = []; for await (const e of await oa.responses.create({ model: 'demo-chat', stream: true, input: 'secret answer never' })) out.push(e); return out }
      const chat = async () => openaiText(await oa.chat.completions.create({ model: 'demo-chat', stream: true, messages: [{ role: 'user', content: 'secret answer never' }] }))
      // honest: completes, verified / 诚实：正常完成、核验通过
      const ok = await events()
      assert.equal(ok.at(-1).type, 'response.completed')
      assert.match(await chat(), /secret answer never/)
      for (const edit of [(s) => doneBeforeCompleted(stripReceipt(s)), doneBeforeCompleted, stripReceipt, (s) => doneBefore('never')(receiptToStart(s))]) {
        cli.knobs.edit = edit
        const got = await events()
        const last = got.at(-1)
        assert.equal(last.type, 'response.failed', `${cut}: ${JSON.stringify(got.map((e) => e.type))}`)
        assert.equal(last.response.error.code, 'receipt_invalid')
        assert.ok(!got.some((e) => e.type === 'response.completed'))
      }
      cli.knobs.edit = (s) => doneBefore('never')(receiptToStart(s))
      await assert.rejects(chat(), /usage receipt did not verify/, cut)
      cli.knobs.edit = stripReceipt
      await assert.rejects(chat(), /usage receipt did not verify/, cut)
      await assert.rejects(anthropicText(await an.messages.create({ model: 'demo-claude', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] })), /usage receipt did not verify/)
    } finally { await cli.close() }
  })
}

// FIXED SSE-END, SSE-EOF, SSE-BOM: tapeapi-verify, strict and not, read raw to the end: the logged verdicts are the same
// whether the stream came one event per chunk, whole, or with the end and the rest in one chunk; strict passes the stream
// on up to its end and no further, not strict passes every byte. A free request after each call marks where that call's
// log lines end (the CLI writes them before it ends the answer, and stderr keeps their order), so nothing waits on a clock.
// tapeapi-verify（严格与非严格），按原始字节读到底：无论每事件一块、整块还是结束点与其余同块，记录的结论都相同；严格模式只转交到
// 结束为止，非严格转交每个字节。每次调用之后的一个免费请求标出该调用日志的结尾（CLI 在结束回答之前写日志，stderr 保持顺序），不等时钟。
const BOM = '﻿'
const lateChatCli = 'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"demo-chat","choices":[{"index":0,"delta":{"content":" EXTRA"},"finish_reason":null}]}\n\n'
const lateResponsesCli = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"x","output_index":0,"content_index":0,"delta":" EXTRA","logprobs":[]}\n\n'
const lateAnthropicCli = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" EXTRA"}}\n\n'
const insertBefore = (word, what) => (s) => { const ev = s.split(/(?<=\n\n)/); const i = ev.findIndex((e) => e.includes(`" ${word}"`)); assert.ok(i > 0, word); ev.splice(i, 0, what); return ev.join('') }
const withBom = (late) => late.replace(/(^|\n)data:/, `$1${BOM}data:`)
// [which, what, edit, verdict with --strict, verdict without] / [格式, 名称, 改动, --strict 的结论, 非严格的结论]
const CLI_CASES = [
  ['responses', 'honest', (s) => s, 'OK', 'OK'],
  ['chat', 'honest', (s) => s, 'OK', 'OK'],
  ['anthropic', 'honest', (s) => s, 'OK', 'OK'],
  ['responses', 'honest, [DONE] after response.completed', (s) => s + 'data: [DONE]\n\n', 'OK', 'OK'],
  ['chat', 'a comment, a data-less event and a second [DONE] after the end', (s) => s + ': hello\n\nevent: injected\n\ndata: [DONE]\n\n', 'OK', 'OK'],
  ['responses', 'R-a: [DONE] before response.completed', doneBeforeCompleted, 'FAIL', 'FAIL'],
  ['responses', 'R-b: receipt to the start, [DONE] before " never"', (s) => doneBefore('never')(receiptToStart(s)), 'FAIL', 'FAIL'],
  ['chat', 'C-b: receipt to the start, [DONE] before " never"', (s) => doneBefore('never')(receiptToStart(s)), 'FAIL', 'FAIL'],
  ['anthropic', 'A-b: receipt to the start, a message_stop before " never"', (s) => insertBefore('never', 'event: message_stop\ndata: {"type":"message_stop"}\n\n')(receiptToStart(s)), 'FAIL', 'FAIL'],
  ['responses', 'R-c: receipt to the start, a delta renamed response.completed', (s) => receiptToStart(s).replace('event: response.output_text.delta\n', 'event: response.completed\n'), 'FAIL', 'FAIL'],
  ['responses', 'R-d: an event after response.completed', (s) => s + lateResponsesCli, 'OK', 'FAIL'],
  ['chat', 'C-d: a chunk after [DONE]', (s) => s + lateChatCli, 'OK', 'FAIL'],
  ['anthropic', 'A-d: an event after message_stop', (s) => s + lateAnthropicCli, 'OK', 'FAIL'],
  ['chat', 'EOF: [DONE] stripped, an unterminated chunk appended', (s) => s.replace(/data: \[DONE\]\n\n$/, '') + lateChatCli.trim(), 'FAIL', 'FAIL'],
  ['responses', 'EOF: an unterminated delta after response.completed', (s) => s + lateResponsesCli.trim(), 'OK', 'FAIL'],
  ['chat', 'BOM: a data line led by U+FEFF before " never"', insertBefore('never', withBom(lateChatCli)), 'FAIL', 'FAIL'],
  ['responses', 'BOM: a data line led by U+FEFF before " never"', insertBefore('never', withBom(lateResponsesCli)), 'FAIL', 'FAIL'],
  ['anthropic', 'BOM: a data line led by U+FEFF before " never"', insertBefore('never', withBom(lateAnthropicCli)), 'FAIL', 'FAIL'],
]
const CLI_FORMAT = { responses: 'openai-responses', chat: 'openai-chat', anthropic: 'anthropic-messages' }
const upToEndOf = (which, text) => {
  const f = ai.FORMATS.find((x) => x.name === CLI_FORMAT[which])
  const sc = ai.createSseScanner({ sentinel: f.stream.sentinel ?? null, final: f.stream.final ?? null })
  const b = new TextEncoder().encode(text)
  sc.push(b)
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(b.subarray(0, sc.info.endOffset ?? b.length))
}
for (const strict of [true, false]) {
  test(`FIXED SSE-END, SSE-EOF, SSE-BOM: tapeapi-verify${strict ? ' --strict' : ''}, read raw: the logged verdict is the same one event per chunk, whole, and with the end and the rest in one chunk; ${strict ? 'the stream goes on up to its end only' : 'every byte goes on'}`, async () => {
    const cli = await verifyCli(strict ? ['--strict'] : [])
    const H = { 'content-type': 'application/json', authorization: 'Bearer sk-demo', 'x-api-key': 'sk-demo', 'anthropic-version': '2023-06-01' }
    const CALL = {
      responses: [`${cli.local}/v1/responses`, { model: 'demo-chat', stream: true, input: 'secret answer never' }],
      chat: [`${cli.local}/v1/chat/completions`, { model: 'demo-chat', stream: true, messages: [{ role: 'user', content: 'secret answer never' }] }],
      anthropic: [`${cli.local}/v1/messages`, { model: 'demo-claude', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'secret answer never' }] }],
    }
    let marks = 0
    const run = async (which, edit, cut) => {
      const from = cli.log().length
      const [url, body] = CALL[which]
      cli.knobs.edit = edit; cli.knobs.cut = cut
      const res = await cli.fetch(url, { method: 'POST', headers: H, body: JSON.stringify(body) })
      const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(await res.arrayBuffer()))
      const sent = cli.knobs.last
      cli.knobs.edit = (s) => s   // the marker's answer is passed as it is / 标记请求的回答原样通过
      await (await cli.fetch(`${cli.local}/v1/models`, { headers: H })).text()
      marks++
      await until(() => (cli.log().match(/GET \/v1\/models/g) ?? []).length >= marks, 'the marker')
      const lines = cli.log().slice(from).split('\n')
      const end = lines.findIndex((l) => l.includes('GET /v1/models'))
      const verdicts = lines.slice(0, end).filter((l) => /\] (OK|FAIL) /.test(l)).map((l) => (/\] OK /.test(l) ? 'OK' : `FAIL(${/problems: (.*?)(  |$)/.exec(l)?.[1] ?? ''})`))
      return { text, sent, verdicts }
    }
    try {
      for (const [which, what, edit, inStrict, notStrict] of CLI_CASES) {
        const want = strict ? inStrict : notStrict
        let ref = null
        for (const cut of CUTS) {
          const { text, sent, verdicts } = await run(which, edit, cut)
          const v = [...new Set(verdicts)].sort()
          if (want === 'OK') assert.deepEqual(v, ['OK'], `${which} ${what} ${cut}`)
          else assert.ok(v.some((x) => x.startsWith('FAIL')), `${which} ${what} ${cut}: ${verdicts}`)
          if (!strict) assert.equal(text, sent, `${which} ${what} ${cut}: every byte goes on`)
          else if (want === 'OK') assert.equal(text, upToEndOf(which, sent), `${which} ${what} ${cut}: up to the end only`)
          else assert.match(text, /usage receipt did not verify/, `${which} ${what} ${cut}: an error event`)
          if (!ref) ref = { cut, v }
          else assert.deepEqual(v, ref.v, `${which} ${what}: the verdict under ${cut} differs from ${ref.cut}`)
        }
      }
    } finally { cli.knobs.edit = (s) => s; cli.knobs.cut = 'event'; await cli.close() }
  })
}

// FIXED SSE-EOF, SSE-BOM, through the official SDKs and createVerifyingFetch: an unterminated event appended before the
// connection closes (openai 7.23 dispatches it when the body ends) and a data line led by U+FEFF (both SDKs strip the mark
// from every line) used to reach the application as verified content. Strict: the iterator throws RECEIPT_INVALID, or the
// stream ends at its verified end and the appended content never arrives; not strict: the content arrives and a failure
// is reported. / 经官方 SDK 与 createVerifyingFetch：连接关闭前追加的未结束事件（openai 7.23 在正文结束时分派它）与以 U+FEFF
// 开头的 data 行（两家 SDK 都逐行去掉该标记）曾作为已核验的内容到达应用。strict：迭代器抛出 RECEIPT_INVALID，或流在已核验的结束处
// 结束、追加的内容不会到达；非 strict：内容到达，但报告失败。
test('FIXED SSE-EOF, SSE-BOM: official SDKs: an unterminated event before the close and a data line led by U+FEFF are never verified content (strict and not, one chunk per event and whole)', { skip }, async () => {
  const w = await world()
  const runs = {
    chat: async (oa) => openaiText(await oa.chat.completions.create({ model: 'demo-chat', stream: true, messages: [{ role: 'user', content: 'secret answer never' }] })),
    responses: async (oa) => responsesText(await oa.responses.create({ model: 'demo-chat', stream: true, input: 'secret answer never' })),
    anthropic: async (oa, an) => anthropicText(await an.messages.create({ model: 'demo-claude', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'secret answer never' }] })),
  }
  const cases = [
    ['chat', 'EOF: [DONE] stripped, an unterminated chunk appended', (s) => s.replace(/data: \[DONE\]\n\n$/, '') + lateChatCli.replace('EXTRA', 'INJECTED').trim(), 'throws'],
    ['responses', 'EOF: an unterminated delta after response.completed', (s) => s + lateResponsesCli.replace('EXTRA', 'INJECTED').trim(), 'cut'],
    ['chat', 'BOM: a data line led by U+FEFF', insertBefore('never', withBom(lateChatCli.replace('EXTRA', 'INJECTED'))), 'throws'],
    ['responses', 'BOM: a data line led by U+FEFF', insertBefore('never', withBom(lateResponsesCli.replace('EXTRA', 'INJECTED'))), 'throws'],
    ['anthropic', 'BOM: a data line led by U+FEFF', insertBefore('never', withBom(lateAnthropicCli.replace('EXTRA', 'INJECTED'))), 'throws'],
  ]
  for (const strict of [true, false]) for (const cut of ['event', 'whole']) for (const [which, what, edit, inStrict] of cases) {
    const v = verifying(w, { strict })
    w.state.deliver = perEvent(edit, { cut })
    const oa = new OpenAI({ baseURL: w.eps['openai-chat'], apiKey: 'sk-demo', fetch: v.fetch, maxRetries: 0 })
    const an = new Anthropic({ baseURL: w.eps['anthropic-messages'], apiKey: 'sk-demo', fetch: v.fetch, maxRetries: 0 })
    const label = `strict=${strict} ${cut} ${which}: ${what}`
    const go = () => runs[which](oa, an)
    if (strict && inStrict === 'throws') await assert.rejects(go(), (e) => codeOf(e) === 'RECEIPT_INVALID', label)
    else {
      const text = await go()
      assert.equal(text.includes('INJECTED'), !strict, `${label}: ${JSON.stringify(text)}`)
      await until(() => v.reports.length >= (strict ? 1 : 2), `${label}: the reports`)
      assert.equal(v.reports.some((r) => !r.ok), !strict, `${label}: ${v.reports.map((r) => r.problems.join('; ')).join(' | ')}`)
    }
  }
})

// FIXED SSE-END (review round 2): tapeapi-verify --strict, a stream with CR line ends whose last byte, the CR of the blank
// line that ends it, is the last byte the sidecar sends before holding the connection open: the answer ends at the CR
// instead of waiting for an LF that never comes. The sidecar's gate opens only after the client has read the answer to its
// end, so a hang fails at `until`'s cap, not on a clock. / 以 CR 作行尾的流，结束空行的 CR 是旁路保持连接之前发出的最后一个
// 字节：回答在 CR 处结束，而不是等一个永远不来的 LF。旁路的门在客户端把回答读到底之后才打开，挂住会在 `until` 的上限处失败。
test('FIXED SSE-END: tapeapi-verify --strict ends the answer at a bare CR that ends the stream, while the upstream keeps the connection open', async () => {
  const cli = await verifyCli(['--strict'])
  const H = { 'content-type': 'application/json', authorization: 'Bearer sk-demo', 'x-api-key': 'sk-demo', 'anthropic-version': '2023-06-01' }
  try {
    for (const [url, body] of [
      [`${cli.local}/v1/chat/completions`, { model: 'demo-chat', stream: true, messages: [{ role: 'user', content: 'hello' }] }],
      [`${cli.local}/v1/messages`, { model: 'demo-claude', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hello' }] }],
    ]) {
      let release
      cli.knobs.edit = (s) => s.replace(/\n/g, '\r'); cli.knobs.cut = 'whole'; cli.knobs.hold = new Promise((ok) => { release = ok })
      try {
        let text = null
        const read = cli.fetch(url, { method: 'POST', headers: H, body: JSON.stringify(body) }).then((r) => r.text()).then((t) => { text = t })
        await until(() => text !== null, `${url}: the answer ends at the CR`)
        await read
        assert.ok(text.endsWith('\r\r') && text === cli.knobs.last, `${url}: ${JSON.stringify(text.slice(-30))}`)
      } finally { cli.knobs.hold = null; release() }
    }
  } finally { cli.knobs.edit = (s) => s; cli.knobs.cut = 'event'; await cli.close() }
})

// FIXED SSE-LOG: without --strict, the openai SDK hangs up at [DONE] while the sidecar keeps the connection open: the CLI
// used to check the receipt only when the upstream closed, and a client that hung up first left no verdict at all. It is
// now checked and logged as soon as the stream ends. The sidecar holds the connection behind a gate the test opens only
// after the verdict is logged (or the 10 s cap of `until` fails the test), so nothing depends on timing.
// FIXED SSE-LOG：非严格模式下，openai SDK 在 [DONE] 处挂断，而旁路一直保持连接：CLI 原先只在上游关闭时核验回执，客户端先挂断就
// 没有任何结论。现在流一结束就核验并记录。旁路的连接由一道门保持，测试在结论记录之后才打开（否则 `until` 的 10 秒上限让测试失败），
// 不依赖时序。
test('FIXED SSE-LOG: tapeapi-verify without --strict logs its verdict when the client hangs up at the end while the upstream keeps the connection open', { skip }, async () => {
  const cli = await verifyCli([])
  try {
    const oa = new OpenAI({ baseURL: `${cli.local}/v1`, apiKey: 'sk-demo', maxRetries: 0, fetch: cli.fetch })
    for (const cut of CUTS) {
      let release
      cli.knobs.cut = cut; cli.knobs.hold = new Promise((ok) => { release = ok })
      try {
        const from = cli.log().length
        assert.match(await openaiText(await oa.chat.completions.create({ model: 'demo-chat', stream: true, messages: [{ role: 'user', content: 'hello' }] })), /hello/)
        await until(() => /\] (OK|FAIL) /.test(cli.log().slice(from)), `${cut}: a verdict while the upstream is still open`)
        assert.match(cli.log().slice(from), /\] OK +POST \/v1\/chat\/completions/, cut)
      } finally { cli.knobs.hold = null; release() }
    }
  } finally { cli.knobs.cut = 'event'; await cli.close() }
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
    const text = await f(oa, an)
    return { text, reports: v.reports }
  }
  // FIXED RC-4 (deflake): this asserted that the iterator finished within 700 ms of wall time although the connection was
  // held for 1500 ms, a margin a busy machine can eat. What it means is that the iterator does not wait for the upstream to
  // close, so the connection is now held open by a gate the test opens only after the iterator is done: if the iterator
  // waited for the close it would never finish (the 20 s race below fails it), and no threshold on elapsed time is left.
  // 修复 RC-4（去抖）：原先断言迭代器在 700 ms 墙钟内结束（连接被扣 1500 ms），高负载机器会吃掉这点余量。它真正要说的是迭代器
  // 不等上游关闭，所以现在连接由一道门保持，测试在迭代器结束后才打开：若迭代器等关闭，就永远结束不了（下面 20 秒的竞速让它失败），
  // 不再有任何耗时阈值。
  for (const strict of [true, false]) {
    let release
    const gate = new Promise((ok) => { release = ok })
    let guard
    try {
      const r = await Promise.race([
        run({ strict }, perEvent((s) => s, { hold: gate }), chat),
        new Promise((_, fail) => { guard = setTimeout(() => fail(new Error(`strict=${strict}: the iterator waited for the upstream to close`)), 20_000) }),
      ])
      assert.match(r.text, /hello/)
      await until(() => r.reports.length >= 1, `strict=${strict}: the report`)
      await new Promise((ok) => setTimeout(ok, 20))   // room for a wrong second report; waiting longer cannot fail the test / 留给错误的第二份报告；多等不会让测试失败
      assert.deepEqual(r.reports.map((x) => x.ok), [true], `strict=${strict}`)
    } finally { clearTimeout(guard); release() }
  }
  // Not strict: the upstream resets the connection 100 ms after the final event. / 非 strict：上游在最终事件后 100 ms 重置连接。
  for (const [what, f] of [['openai', chat], ['anthropic', claude]]) {
    const r = await run({ strict: false }, perEvent((s) => s, { delayMs: 100, error: true }), f)
    assert.match(r.text, /hello/, what)
    await until(() => r.reports.length >= 1, `${what}: the report`)
    await new Promise((ok) => setTimeout(ok, 150))   // the reset comes at 100 ms; a late wrong report is caught, a slow machine cannot fail this / 100 ms 时重置；迟到的错误报告会被抓到，慢机器不会让它失败
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
