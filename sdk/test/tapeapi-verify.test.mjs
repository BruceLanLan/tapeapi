// tapeapi-verify (sdk/bin/tapeapi-verify.js), the local verifying proxy for AI clients, spawned for real in front of an
// in-process signing sidecar (server/src/ai-proxy.js) over the fake upstream (examples/ai-proxy/fake-upstream.mjs): the
// requests Claude Code and Codex send (Anthropic Messages with ?beta=true, OpenAI Responses) go through with their bytes
// unchanged, each receipt is checked and logged (stderr verdict, JSONL file), free paths pass through, and --strict turns
// a tampered answer into an error the client sees: HTTP 502 for JSON, and for a stream an error event in place of the
// final event, even when the receipt comment arrives split across chunks. No network beyond 127.0.0.1.
// tapeapi-verify 本地核验代理：真实启动，放在进程内签名旁路（背后是模拟上游）之前。Claude Code 与 Codex 的请求字节原样通过，
// 每份回执都被核验并记录，免费路径透传，--strict 让被篡改的回答变成客户端看得到的错误（JSON 为 502，流为代替最终事件的错误
// 事件，回执注释被切成多块到达时也一样）。只访问 127.0.0.1。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ai from '../src/ai.js'
import { routesOf, route } from '../bin/tapeapi-verify.js'
import { createAIProxy } from '../../server/src/ai-proxy.js'
import { createFakeUpstream } from '../../examples/ai-proxy/fake-upstream.mjs'

const BIN = fileURLToPath(new URL('../bin/tapeapi-verify.js', import.meta.url))
const KEY = '0x' + '42'.repeat(32)
const MODELS = [
  { id: 'claude-demo', formats: ['anthropic-messages'], prices: [{ currency: 'BEM', unit: '1M tokens', input: '3', output: '15', cacheRead: '0.3', cacheWrite: '3.75' }] },
  { id: 'codex-demo', formats: ['openai-responses'], prices: [{ currency: 'BEM', unit: '1M tokens', input: '1.25', output: '10', cacheRead: '0.125' }] },
]
const TMP = mkdtempSync(join(tmpdir(), 'tapeapi-verify-test-'))
const closers = []
test.after(async () => { for (const c of closers.reverse()) await c(); rmSync(TMP, { recursive: true, force: true }) })

// The sidecar on a real port, with knobs: `tamper` changes "Hi!" after signing; `strip` removes the receipt comment; `reset` breaks the connection 50 ms after the answer; `chunk` writes the answer in pieces of
// that many bytes, a millisecond apart. / 真实端口上的旁路：tamper 在签名后改动 "Hi!"；chunk 把回答切成这么多字节一块写出。
const knobs = { tamper: false, strip: false, reset: false, chunk: 0, down: false, bodies: [] }
async function startSidecar() {
  const fake = createFakeUpstream({ keys: ['sk-demo'], models: MODELS.map((m) => m.id) })
  let proxy
  const srv = http.createServer(async (req, res) => {
    const parts = []
    for await (const c of req) parts.push(c)
    knobs.bodies.push(Buffer.concat(parts))   // what reached the sidecar / 到达旁路的字节
    knobs.headers = Object.fromEntries(Object.entries(req.headers))
    const headers = new Headers()
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1])
    const r = await proxy.handleRequest(new Request(new URL(req.url, 'http://127.0.0.1'), { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(parts) }), { clientIp: '127.0.0.1' })
    let bytes = r.body ? Buffer.from(await r.arrayBuffer()) : null
    if (bytes && knobs.tamper) bytes = Buffer.from(bytes.toString('utf8').replace('Hi!', 'Hi?'))
    if (bytes && knobs.strip) bytes = Buffer.from(bytes.toString('utf8').replace(/: ?tapeapi-receipt [A-Za-z0-9_-]*\r?\n/g, ''))
    res.writeHead(r.status, Object.fromEntries(r.headers))
    if (!bytes || req.method === 'HEAD') return res.end()
    if (knobs.reset) { res.write(bytes); await new Promise((ok) => setTimeout(ok, 50)); return res.socket.destroy() }
    if (!knobs.chunk) return res.end(bytes)
    for (let i = 0; i < bytes.length; i += knobs.chunk) { res.write(bytes.subarray(i, i + knobs.chunk)); await new Promise((ok) => setTimeout(ok, 1)) }
    res.end()
  })
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
  const url = `http://127.0.0.1:${srv.address().port}`
  proxy = createAIProxy({
    upstream: { baseUrl: 'http://fake.local/v1' }, fetch: (u, init) => { if (knobs.down) throw new Error('connect ECONNREFUSED'); return fake.fetch(u, init) }, signerKey: KEY, models: MODELS, allowHttp: true, rateLimit: false, log: () => {},
    manifestBase: { name: 'Verify test', circuits: '0x0000000000000000000000000000000000000000', tokenId: '0', container: '0x0000000000000000000000000000000000000000', delegation: null, dev: true, endpoints: { live: [`${url}/tapeapi/v1`], async: false } },
  })
  closers.push(() => new Promise((ok) => { srv.closeAllConnections(); srv.close(ok) }))
  return { url, manifest: proxy.manifest() }
}
async function startVerify(sidecarUrl, extra = []) {
  const logFile = join(TMP, `log-${Math.random().toString(36).slice(2)}.jsonl`)
  const child = spawn(process.execPath, [BIN, '--dev', sidecarUrl, '--port', '0', '--log', logFile, ...extra], { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => { err += d })
  closers.push(() => new Promise((ok) => { if (child.exitCode !== null) return ok(); child.once('exit', ok); child.kill('SIGTERM') }))
  const url = await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`not started: ${err}`)), 15_000)
    const on = () => { const m = /listening on (http:\/\/\S+)/.exec(err); if (m) { clearTimeout(t); child.stderr.off('data', on); ok(m[1]) } }
    child.stderr.on('data', on); on()
    child.once('exit', (c) => fail(new Error(`exited ${c}: ${err}`)))
  })
  return { url, stderr: () => err, log: () => { try { return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } } }
}
// What an SSE client dispatches. / SSE 客户端分派的事件。
function events(text) {
  const out = []
  let data = null, event = ''
  for (const line of text.split(/\r\n|\r|\n/).slice(0, -1)) {
    if (line === '') { if (data !== null) out.push({ event, data: data.join('\n') }); data = null; event = ''; continue }
    if (line.startsWith(':')) continue
    const k = line.indexOf(':'), field = k < 0 ? line : line.slice(0, k)
    let v = k < 0 ? '' : line.slice(k + 1)
    if (v.startsWith(' ')) v = v.slice(1)
    if (field === 'data') (data ??= []).push(v); else if (field === 'event') event = v
  }
  return out
}
const CLAUDE_HEADERS = { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': 'sk-demo', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14', 'x-app': 'cli', 'user-agent': 'claude-cli/2.1.237 (external, sdk-cli)' }
const CODEX_HEADERS = { 'content-type': 'application/json', accept: 'text/event-stream', authorization: 'Bearer sk-demo', originator: 'codex_exec', 'session-id': 's-1' }
const claudeBody = (stream, text = 'say hi') => JSON.stringify({ model: 'claude-demo', max_tokens: 64, stream, messages: [{ role: 'user', content: [{ type: 'text', text }] }] })
const codexBody = (text = 'say hi') => JSON.stringify({ model: 'codex-demo', stream: true, store: false, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }] })
const waitFor = async (cond, what) => { for (let i = 0; i < 1000 && !cond(); i++) await new Promise((ok) => setTimeout(ok, 10)); assert.ok(cond(), what) }

test('routing: metered paths to their format\'s endpoint; other paths to Anthropic when the request speaks Anthropic, else OpenAI', () => {
  const routes = routesOf({ ai: { endpoints: [{ format: 'openai-responses', baseUrl: 'https://o.example/v1' }, { format: 'anthropic-messages', baseUrl: 'https://a.example/relay' }] } })
  const h = (o = {}) => new Headers(o)
  assert.deepEqual([route(routes, 'POST', '/v1/messages', h()).root, route(routes, 'POST', '/v1/messages', h()).metered], ['https://a.example/relay', true])
  assert.equal(route(routes, 'POST', '/v1/responses', h()).root, 'https://o.example')
  assert.equal(route(routes, 'GET', '/v1/models', h({ 'anthropic-version': '2023-06-01' })).root, 'https://a.example/relay')
  assert.equal(route(routes, 'POST', '/v1/messages/count_tokens', h({ 'anthropic-version': '2023-06-01' })).metered, false)
  assert.equal(route(routes, 'GET', '/v1/models', h({ authorization: 'Bearer k' })).root, 'https://o.example')
  assert.throws(() => routesOf({ ai: { endpoints: [{ format: 'gemini', baseUrl: 'https://g.example' }] } }), /no format this version knows|has a format/)
})

test('tapeapi-verify (--no-salt) passes Claude Code and Codex calls through unchanged, verifies every receipt, logs a verdict and a JSONL line', async () => {
  const side = await startSidecar()
  const v = await startVerify(side.url, ['--no-salt'])
  assert.match(v.stderr(), /\(no salt\)/)
  assert.match(v.stderr(), /--dev is for TESTING ONLY/)
  // free paths / 免费路径
  const models = await fetch(`${v.url}/v1/models?limit=1000`, { headers: { 'x-api-key': 'sk-demo', 'anthropic-version': '2023-06-01' } })
  assert.equal(models.status, 200)
  assert.equal((await models.json()).data[0].type, 'model', 'Anthropic\'s list shape: the request went to the Anthropic endpoint')
  const count = await fetch(`${v.url}/v1/messages/count_tokens?beta=true`, { method: 'POST', headers: CLAUDE_HEADERS, body: claudeBody(false) })
  assert.equal(count.status, 200); assert.equal(count.headers.get(ai.RECEIPT_HEADER), null)
  // Claude Code: a stream, then the non-streaming fallback / Claude Code：流式，然后非流式回退
  const s = await fetch(`${v.url}/v1/messages?beta=true`, { method: 'POST', headers: CLAUDE_HEADERS, body: claudeBody(true) })
  const sText = await s.text()
  const env = ai.readSseReceipt(sText)
  assert.deepEqual(ai.verifyUsageReceipt({ envelope: env, manifest: side.manifest, requestBytes: claudeBody(true), responseBytes: sText, stream: true }).problems, [], 'the client got the signed bytes unchanged')
  assert.equal(events(sText).at(-1).event, 'message_stop')
  const j = await fetch(`${v.url}/v1/messages?beta=true`, { method: 'POST', headers: CLAUDE_HEADERS, body: claudeBody(false) })
  const jBytes = new Uint8Array(await j.arrayBuffer())
  assert.deepEqual(ai.verifyUsageReceipt({ envelope: ai.decodeReceiptHeader(j.headers.get(ai.RECEIPT_HEADER)), manifest: side.manifest, requestBytes: claudeBody(false), responseBytes: jBytes, stream: false }).problems, [])
  // Codex / Codex
  const c = await fetch(`${v.url}/v1/responses`, { method: 'POST', headers: CODEX_HEADERS, body: codexBody() })
  const cText = await c.text()
  assert.equal(events(cText).at(-1).event, 'response.completed')
  await waitFor(() => v.log().length === 3, 'three metered calls logged')
  const lines = v.stderr().split('\n')
  assert.ok(lines.some((l) => /--\s+GET \/v1\/models 200/.test(l)), 'the model list is reported as passed through')
  assert.equal(lines.filter((l) => /\] OK\s+POST \/v1\/(messages|responses)/.test(l)).length, 3, v.stderr())
  assert.ok(lines.some((l) => /OK\s+POST \/v1\/messages\s+stream\s+200\s+model=claude-demo\s+tokens in=\d+ out=\d+ cache_read=\d+ cache_write=\d+\s+price=0\.\d{8} BEM/.test(l)), 'a verdict names the model, tokens and price')
  const log = v.log()
  assert.deepEqual(log.map((l) => [l.ok, l.format, l.stream]), [[true, 'anthropic-messages', true], [true, 'anthropic-messages', false], [true, 'openai-responses', true]])
  assert.ok(log.every((l) => l.receipt?.sig && l.receipt.result.prices), 'the signed receipts are in the log')
  assert.ok(!JSON.stringify(log).includes('sk-demo'), 'no key in the log')
})

test('salt (the default): a metered JSON body reaches the sidecar with 64 random whitespace characters appended, parses to the same request, and its receipt verifies over the salted bytes; free paths are not salted', async () => {
  const side = await startSidecar()
  const v = await startVerify(side.url)
  assert.doesNotMatch(v.stderr(), /no salt/)
  knobs.bodies = []
  const body = claudeBody(false, 'yes')
  const j = await fetch(`${v.url}/v1/messages?beta=true`, { method: 'POST', headers: CLAUDE_HEADERS, body })
  const env = ai.decodeReceiptHeader(j.headers.get(ai.RECEIPT_HEADER))
  const sent = knobs.bodies.at(-1)
  assert.equal(sent.length, Buffer.byteLength(body) + ai.SALT_LENGTH)
  assert.equal(sent.subarray(0, Buffer.byteLength(body)).toString('utf8'), body, 'the client\'s bytes, then the salt')
  assert.match(sent.subarray(Buffer.byteLength(body)).toString('latin1'), /^[ \t\n\r]{64}$/)
  assert.deepEqual(JSON.parse(sent.toString('utf8')), JSON.parse(body), 'the same request once parsed')
  assert.equal(env.params.requestSha256, ai.sha256Hex(sent), 'the receipt hashes the bytes actually sent')
  assert.notEqual(env.params.requestSha256, ai.sha256Hex(body), 'so hashing the guessed prompt no longer confirms it')
  await j.arrayBuffer()
  const s = await (await fetch(`${v.url}/v1/messages?beta=true`, { method: 'POST', headers: CLAUDE_HEADERS, body: claudeBody(true, 'yes') })).text()
  assert.equal(events(s).at(-1).event, 'message_stop')
  const second = knobs.bodies.at(-1)
  assert.notEqual(ai.sha256Hex(second.subarray(second.length - 64)), ai.sha256Hex(sent.subarray(sent.length - 64)), 'a fresh salt per request')
  await waitFor(() => v.log().length === 2, 'two metered calls logged')
  assert.deepEqual(v.log().map((l) => l.ok), [true, true], v.stderr())
  // count_tokens is not a receipt path: sent as written. / count_tokens 不是回执路径：原样发送。
  await (await fetch(`${v.url}/v1/messages/count_tokens?beta=true`, { method: 'POST', headers: CLAUDE_HEADERS, body })).arrayBuffer()
  assert.equal(knobs.bodies.at(-1).toString('utf8'), body)
})

test('--strip-session-headers: the client\'s session headers do not reach the service; without it they do (the default)', async () => {
  const side = await startSidecar()
  const withSession = { ...CODEX_HEADERS, 'x-claude-code-session-id': 'cc-1', 'thread-id': 't-1' }
  const strip = await startVerify(side.url, ['--strip-session-headers'])
  assert.match(strip.stderr(), /\(session headers stripped\)/)
  await (await fetch(`${strip.url}/v1/responses`, { method: 'POST', headers: withSession, body: codexBody() })).text()
  for (const h of ['session-id', 'x-claude-code-session-id', 'thread-id']) assert.equal(knobs.headers[h], undefined, h)
  assert.equal(knobs.headers.originator, 'codex_exec', 'other client headers still go through')
  assert.equal(knobs.headers.authorization, 'Bearer sk-demo')
  await waitFor(() => strip.log().length === 1, 'logged'); assert.equal(strip.log()[0].ok, true)
  const keep = await startVerify(side.url)
  await (await fetch(`${keep.url}/v1/responses`, { method: 'POST', headers: withSession, body: codexBody() })).text()
  assert.deepEqual([knobs.headers['session-id'], knobs.headers['x-claude-code-session-id'], knobs.headers['thread-id']], ['s-1', 'cc-1', 't-1'])
})

test('--strict: a tampered JSON answer becomes HTTP 502 (not retried), a tampered stream ends in an error event instead of its final event, even when the receipt comment arrives in pieces', async () => {
  const side = await startSidecar()
  const v = await startVerify(side.url, ['--strict'])
  const lax = await startVerify(side.url)
  try {
    knobs.tamper = true
    const j = await fetch(`${v.url}/v1/messages?beta=true`, { method: 'POST', headers: CLAUDE_HEADERS, body: claudeBody(false) })
    assert.equal(j.status, 502)
    assert.equal(j.headers.get('x-should-retry'), 'false')
    const err = await j.json()
    assert.equal(err.type, 'error'); assert.match(err.error.message, /responseSha256 does not match/)
    for (const chunk of [0, 5, 3]) {
      knobs.chunk = chunk
      const a = await (await fetch(`${v.url}/v1/messages?beta=true`, { method: 'POST', headers: CLAUDE_HEADERS, body: claudeBody(true) })).text()
      const ae = events(a)
      assert.equal(ae.at(-1).event, 'error', `chunk ${chunk}: the stream ends in an error event`)
      assert.match(JSON.parse(ae.at(-1).data).error.message, /tapeapi-verify: the usage receipt did not verify/)
      assert.ok(!ae.some((e) => e.event === 'message_stop'), `chunk ${chunk}: the final event is never delivered`)
      assert.equal(ae.filter((e) => e.event === 'error').length, 1)
      const o = await (await fetch(`${v.url}/v1/responses`, { method: 'POST', headers: CODEX_HEADERS, body: codexBody() })).text()
      const oe = events(o)
      assert.equal(oe.at(-1).event, 'response.failed', `chunk ${chunk}: Codex reads response.failed`)
      assert.equal(JSON.parse(oe.at(-1).data).response.error.code, 'receipt_invalid')
      assert.ok(!oe.some((e) => e.event === 'response.completed'))
    }
    // Without --strict the bytes go through as they came, and the failure is only reported. / 非严格模式：字节照常通过，只报告。
    knobs.chunk = 0
    const l = await (await fetch(`${lax.url}/v1/messages?beta=true`, { method: 'POST', headers: CLAUDE_HEADERS, body: claudeBody(true) })).text()
    assert.equal(events(l).at(-1).event, 'message_stop')
    await waitFor(() => lax.log().length === 1, 'logged')
    assert.equal(lax.log()[0].ok, false)
    assert.match(lax.stderr(), /FAIL\s+POST \/v1\/messages\s+stream .*responseSha256 does not match/)
  } finally { knobs.tamper = false; knobs.chunk = 0 }
  // Untampered, strict passes everything as it is. / 未篡改时严格模式原样放行。
  const ok = await (await fetch(`${v.url}/v1/messages?beta=true`, { method: 'POST', headers: CLAUDE_HEADERS, body: claudeBody(true) })).text()
  assert.equal(events(ok).at(-1).event, 'message_stop')
})

// FIXED RC-2 (review 2026-09-29): with the receipt stripped and the answer arriving in pieces, the old strict mode passed
// the final event's first bytes on and then wrote "\n\n" before its error event, which completed that final event: the
// client dispatched message_stop. Only whole events go on now. / 回执被剥掉、回答分块到达时，旧的严格模式先转出最终事件的前半截，
// 再在错误事件前写 "\n\n"，把那个最终事件补全了：客户端分派了 message_stop。现在只转交完整的事件。
test('FIXED RC-2: --strict, receipt stripped, any chunking: the stream ends in one error event and its final event is never dispatched', async () => {
  const side = await startSidecar()
  const v = await startVerify(side.url, ['--strict'])
  try {
    knobs.strip = true
    for (const chunk of [0, 5, 3, 64]) {
      knobs.chunk = chunk
      const ae = events(await (await fetch(`${v.url}/v1/messages?beta=true`, { method: 'POST', headers: CLAUDE_HEADERS, body: claudeBody(true) })).text())
      assert.equal(ae.at(-1).event, 'error', `chunk ${chunk}`)
      assert.ok(!ae.some((e) => e.event === 'message_stop'), `chunk ${chunk}: message_stop never dispatched`)
      assert.equal(ae.filter((e) => e.event === 'error').length, 1)
      const oe = events(await (await fetch(`${v.url}/v1/responses`, { method: 'POST', headers: CODEX_HEADERS, body: codexBody() })).text())
      assert.equal(oe.at(-1).event, 'response.failed', `chunk ${chunk}`)
      assert.ok(!oe.some((e) => e.event === 'response.completed'), `chunk ${chunk}: response.completed never dispatched`)
    }
  } finally { knobs.strip = false; knobs.chunk = 0 }
  // Untampered and in pieces, strict passes the stream whole. / 未篡改、分块到达时，严格模式完整放行。
  knobs.chunk = 5
  try {
    const ok = await (await fetch(`${v.url}/v1/messages?beta=true`, { method: 'POST', headers: CLAUDE_HEADERS, body: claudeBody(true) })).text()
    assert.equal(events(ok).at(-1).event, 'message_stop')
    assert.match(ok, /: tapeapi-receipt /)
  } finally { knobs.chunk = 0 }
})

// FIXED RC-4 (review 2026-09-29): an upstream that breaks off after the end of a stream (its final event) does not fail
// the call: strict once the receipt verified, and not strict at all. / 上游在流结束之后断开不算失败。
test('FIXED RC-4: the sidecar breaking the connection after the final event: the client still gets the whole stream, with and without --strict', async () => {
  const side = await startSidecar()
  const strict = await startVerify(side.url, ['--strict'])
  const lax = await startVerify(side.url)
  knobs.reset = true
  try {
    for (const v of [strict, lax]) {
      const text = await (await fetch(`${v.url}/v1/messages?beta=true`, { method: 'POST', headers: CLAUDE_HEADERS, body: claudeBody(true) })).text()
      assert.equal(events(text).at(-1).event, 'message_stop')
      await waitFor(() => v.log().length === 1, 'logged')
      assert.equal(v.log()[0].ok, true)
    }
  } finally { knobs.reset = false }
})

test('an error the sidecar made itself passes through as it is, reported as a sidecar error (not a failed receipt), even with --strict', async () => {
  const side = await startSidecar()
  const v = await startVerify(side.url, ['--strict'])
  knobs.down = true
  try {
    const res = await fetch(`${v.url}/v1/messages?beta=true`, { method: 'POST', headers: CLAUDE_HEADERS, body: claudeBody(true) })
    assert.equal(res.status, 502)
    assert.equal(res.headers.get('x-tapeapi-sidecar-error'), '1')
    assert.equal((await res.json()).error.code, 'upstream_unavailable', 'the sidecar\'s own answer, unchanged')
  } finally { knobs.down = false }
  await waitFor(() => v.log().length === 1, 'logged')
  assert.deepEqual([v.log()[0].ok, v.log()[0].sidecarError, v.log()[0].code], [false, true, 'PROVIDER_UNAVAILABLE'])
  assert.match(v.stderr(), /ERR\s+POST \/v1\/messages .*502 .*sidecar error/)
  assert.doesNotMatch(v.stderr(), /FAIL\s+POST/)
})

// FIXED P2-O1 / P2-F2 (rc review P2): a metered path written loosely ('/v1//messages', '/v1/%6Dessages') was passed on
// as a free path, unverified, even with --strict; OpenAI and Anthropic serve such paths. --strict now answers 400 and
// forwards nothing; without it the request goes on and the log says it was not verified.
// 计量路径的宽松写法曾被当作免费路径不经核验地转发（--strict 也一样）。--strict 现在回 400、不转发；不加时照常转发并在日志里说明。
test('FIXED P2-O1: --strict refuses a metered path written loosely before forwarding it; without --strict it is logged as not verified', async () => {
  const side = await startSidecar()
  const v = await startVerify(side.url, ['--strict'])
  const lax = await startVerify(side.url)
  const before = knobs.bodies.length
  for (const path of ['/v1//messages', '/v1/%6Dessages', '/v1/messages/', '//v1/messages']) {
    const r = await fetch(`${v.url}${path}`, { method: 'POST', headers: CLAUDE_HEADERS, body: claudeBody(false) })
    assert.equal(r.status, 400, path)
    const j = await r.json()
    assert.equal(j.type, 'error'); assert.match(j.error.message, /written exactly/)
  }
  assert.equal(knobs.bodies.length, before, 'nothing reached the service')
  const r = await fetch(`${lax.url}/v1//messages`, { method: 'POST', headers: CLAUDE_HEADERS, body: claudeBody(false) })
  await r.arrayBuffer()
  assert.equal(knobs.bodies.length, before + 1, 'forwarded without --strict')
  await waitFor(() => /not verified/.test(lax.stderr()), 'the log says it was not verified')
})

test('arguments: a service or --dev, not both; bad names refused before anything is read', async () => {
  const run = (args) => new Promise((ok) => { const c = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); let e = ''; c.stderr.on('data', (d) => { e += d }); c.on('exit', (code) => ok({ code, e })) })
  assert.equal((await run([])).code, 2)
  assert.match((await run(['not-a-name'])).e, /not a TapeOut name/)
  assert.match((await run(['11.1013.tape', '--dev', 'http://127.0.0.1:1'])).e, /not both/)
  assert.match((await run(['--dev', 'http://127.0.0.1:1'])).e, /cannot use/)
})
