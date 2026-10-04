// tapeapi-verify --request-usage (1.6): the same rule as createVerifyingFetch({ requestUsage: true }), as a differential:
// for the same requests through the same sidecar, the CLI forwards the same bytes, its client reads the same bytes, and its
// --log lines carry the same verdicts (ok, problems, warnings, unchecked, receipt, usageRequested, usageRequestSkipped) as
// the SDK's onReport. Plus --strict refusing a body the gates refuse (HTTP 400, nothing forwarded), FIXED AI-ASK-1
// through the CLI, and the help text.
// tapeapi-verify --request-usage：与 createVerifyingFetch({ requestUsage: true }) 同一规则，以差分验证：同样的请求经同一旁路，
// CLI 转发的字节、客户端读到的字节、--log 行里的结论都与 SDK 的 onReport 相同。另测 --strict 拒绝门槛不过的正文、经 CLI 的
// FIXED AI-ASK-1，以及帮助文本。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ai } from '../src/index.js'
import { receiptComment } from '../src/ai.js'
import { signResponse } from '../src/sig.js'
import { cannedWorld, show, KEY, MODELS } from './helpers/ai-canned.mjs'

const CLI = fileURLToPath(new URL('../bin/tapeapi-verify.js', import.meta.url))
const J = JSON.stringify
const hi = [{ role: 'user', content: 'Say hello' }]
const CHAT = '/v1/chat/completions'
const H = { 'content-type': 'application/json', authorization: 'Bearer sk-demo' }
const CASES = {
  'chat-stream': { path: CHAT, body: J({ model: 'demo-chat', messages: hi, stream: true }) },
  'chat-stream-formatted': { path: CHAT, body: J({ model: 'demo-chat', messages: hi, stream: true }, null, 2) },
  'chat-stream-big-integer': { path: CHAT, body: '{"model":"demo-chat","seed":12345678901234567890,"messages":[],"stream":true}' },
  'chat-stream-usage': { path: CHAT, body: J({ model: 'demo-chat', messages: hi, stream: true, stream_options: { include_usage: true } }) },
  'chat-json': { path: CHAT, body: J({ model: 'demo-chat', messages: hi }) },
  'responses-stream': { path: '/v1/responses', body: J({ model: 'demo-chat', input: 'Hi', stream: true }) },
  'anthropic-json': { path: '/v1/messages', body: J({ model: 'demo-claude', max_tokens: 64, messages: hi }), headers: { 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-demo' } },
  'skip-top-duplicate': { path: CHAT, body: '{"model":"demo-chat","model":"demo-chat","messages":[],"stream":true}', skip: 'duplicate-member' },
  'skip-bom': { path: CHAT, body: '\ufeff{"model":"demo-chat","messages":[],"stream":true}', skip: 'not-object' },
  'skip-text-plain': { path: CHAT, body: J({ model: 'demo-chat', messages: hi, stream: true }), headers: { 'content-type': 'text/plain' }, skip: 'content-type' },
}
const headersOf = (c) => ({ ...H, ...(c.headers ?? {}) })

// The sidecar behind an HTTP server (with an optional edit of its answers), and tapeapi-verify in front of it.
// HTTP 服务器后的旁路（可选地改动其回答），以及前面的 tapeapi-verify。
async function cliWorld(flags, { edit = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tapeapi-ru-'))
  const logFile = join(dir, 'log.jsonl')
  let w = null
  const received = []
  const srv = http.createServer(async (req, res) => {
    const parts = []; for await (const c of req) parts.push(c)
    const body = Buffer.concat(parts)
    if (req.method === 'POST') received.push(new Uint8Array(body))
    const headers = new Headers(); for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1])
    const r = await w.proxy.handleRequest(new Request(new URL(req.url, 'http://127.0.0.1'), { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }))
    const h = Object.fromEntries(r.headers); delete h['content-length']
    let out = r.body ? Buffer.from(await r.arrayBuffer()) : undefined
    if (out && edit && /event-stream/.test(h['content-type'] || '')) out = Buffer.from(edit(out.toString('utf8')))
    res.writeHead(r.status, h)
    res.end(out)
  })
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
  const url = `http://127.0.0.1:${srv.address().port}`
  w = await cannedWorld({ live: `${url}/tapeapi/v1` })
  const child = spawn(process.execPath, [CLI, '--dev', url, '--port', '0', '--log', logFile, ...flags], { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { err += d })
  const local = await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`tapeapi-verify did not start: ${err}`)), 20_000)
    const on = () => { const m = /listening on (http:\/\/\S+)/.exec(err); if (m) { clearTimeout(t); ok(m[1]) } }
    child.stderr.on('data', on); on()
  })
  let lines = 0
  const send = async (c) => {
    const r0 = received.length
    const res = await fetch(local + c.path, { method: 'POST', headers: headersOf(c), body: c.body })
    const delivered = new Uint8Array(await res.arrayBuffer())
    const all = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : []
    const log = all.slice(lines).map((l) => JSON.parse(l)); lines = all.length
    return { status: res.status, sent: received.slice(r0), delivered, log }
  }
  const close = async () => {
    await new Promise((ok) => { if (child.exitCode !== null) return ok(); child.once('exit', ok); child.kill('SIGTERM') })
    await new Promise((ok) => { srv.closeAllConnections(); srv.close(ok) })
    rmSync(dir, { recursive: true, force: true })
  }
  return { send, close, stderr: () => err, url }
}
// The same request through createVerifyingFetch, against a fresh sidecar of the same canned world.
// 同一请求经 createVerifyingFetch，对着同一固定世界的新旁路。
async function viaSdk(c, opts) {
  const w = await cannedWorld()
  const sent = [], reports = []
  const vf = ai.createVerifyingFetch({ service: w.service, onReport: (r) => reports.push(r), fetch: async (u, i) => { sent.push(new Uint8Array(await new Response(i.body).arrayBuffer())); return w.proxy.handleRequest(new Request(u, i)) }, ...opts })
  try {
    const res = await vf(`http://127.0.0.1:8797${c.path}`, { method: 'POST', headers: headersOf(c), body: c.body })
    return { status: res.status, sent, delivered: new Uint8Array(await res.arrayBuffer()), reports }
  } catch (e) { return { error: e, sent, reports } }
}
// The verdict fields both report, receipts compared by their result (the CLI's sidecar has another URL, not another key).
// 两者都报告的结论字段，回执按 result 比较。
const verdict = (r) => ({ ok: r.ok, problems: r.problems, warnings: r.warnings, unchecked: r.unchecked, result: r.receipt?.result ?? null, usageRequested: r.usageRequested, usageRequestSkipped: r.usageRequestSkipped })

test('tapeapi-verify --request-usage --no-salt is createVerifyingFetch({ requestUsage: true, salt: false, strict: false }): the same bytes forwarded, the same bytes delivered, the same verdicts', { timeout: 120_000 }, async () => {
  const cli = await cliWorld(['--request-usage', '--no-salt'])
  try {
    for (const [name, c] of Object.entries(CASES)) {
      const a = await cli.send(c)
      const b = await viaSdk(c, { requestUsage: true, salt: false, strict: false })
      assert.deepEqual(a.sent.map(show), b.sent.map(show), `${name}: forwarded`)
      // The receipt comments differ by their signing time only (two sidecars, one key); everything else is the same.
      // 回执注释只差签名时间（两个旁路、同一把钥匙）；其余完全相同。
      const plain = (x) => show(x).replace(/: tapeapi-receipt [A-Za-z0-9_-]+\n\n/g, ': tapeapi-receipt …\n\n')
      assert.equal(plain(a.delivered), plain(b.delivered), `${name}: delivered`)
      assert.deepEqual(a.log.map(verdict), b.reports.map(verdict), `${name}: verdicts`)
      if (c.skip) assert.equal(a.log[0].usageRequestSkipped, c.skip, name)
      if (name.startsWith('chat-stream') && name !== 'chat-stream-usage') {
        assert.equal(a.log[0].usageRequested, true, name)
        assert.match(show(a.sent[0]), /"stream_options":\{"include_usage":true\}\s*\}$/, name)
        assert.ok(!a.log[0].unchecked.some((x) => /^usage/.test(x)), `${name}: usage checked`)
      }
    }
    // The verdict line says it. / 结论行注明。
    assert.match(cli.stderr(), /OK {4}POST \/v1\/chat\/completions {2}stream {2}200 {2}usage=asked {2}model=demo-chat/)
    assert.match(cli.stderr(), /OK {4}POST \/v1\/chat\/completions {2}stream {2}200 {2}usage-request-skipped=duplicate-member {2}model=demo-chat/)
    assert.match(cli.stderr(), /listening on \S+ {2}\(no salt\) {2}\(usage requested\)/)
  } finally { await cli.close() }
})

test('tapeapi-verify --request-usage (salted): the member first, then the salt; the receipt hashes the bytes forwarded', { timeout: 60_000 }, async () => {
  const cli = await cliWorld(['--request-usage'])
  try {
    const c = CASES['chat-stream']
    const a = await cli.send(c)
    const sent = show(a.sent[0])
    const spliced = c.body.slice(0, -1) + ',"stream_options":{"include_usage":true}}'
    assert.equal(sent.slice(0, spliced.length), spliced)
    assert.match(sent.slice(spliced.length), /^[ \t\r\n]{64}$/)
    assert.equal(a.log[0].receipt.params.requestSha256, ai.sha256Hex(a.sent[0]))
    assert.deepEqual([a.log[0].ok, a.log[0].usageRequested], [true, true])
    assert.match(show(a.delivered), /"choices":\[\],"usage":\{"prompt_tokens":9/, 'the client receives the usage chunk')
  } finally { await cli.close() }
})

test('tapeapi-verify --request-usage --strict: a body the gates refuse gets HTTP 400 usage_request_skipped and is not forwarded (the SDK throws INVALID_ARGUMENT); bodies it can change go on', { timeout: 60_000 }, async () => {
  const cli = await cliWorld(['--request-usage', '--strict'])
  try {
    for (const [name, c] of Object.entries(CASES).filter(([, x]) => x.skip)) {
      const a = await cli.send(c)
      assert.equal(a.status, 400, name)
      assert.deepEqual(a.sent, [], `${name}: nothing forwarded`)
      const err = JSON.parse(show(a.delivered)).error
      assert.equal(err.code, 'usage_request_skipped', name)
      assert.match(err.message, new RegExp(`\\(${c.skip}: `), name)
      const b = await viaSdk(c, { requestUsage: true })
      assert.ok(b.error instanceof Error && b.error.code === 'INVALID_ARGUMENT' && b.error.data.reason === c.skip && b.sent.length === 0, name)
    }
    const ok = await cli.send(CASES['chat-stream-formatted'])
    assert.deepEqual([ok.status, ok.log[0].ok, ok.log[0].usageRequested], [200, true, true])
    assert.match(cli.stderr(), /FAIL POST \/v1\/chat\/completions: requestUsage: .*\(duplicate-member: .*not forwarded \(--strict\)/)
  } finally { await cli.close() }
})

// Raise the usage in the stream's receipt and re-sign it with the service key. / 抬高流回执里的用量并用服务密钥重签。
function inflate(text) {
  const m = /: tapeapi-receipt ([A-Za-z0-9_-]+)\n\n/.exec(text)
  if (!m) return text
  const env = ai.decodeReceiptHeader(m[1])
  const usage = { prompt_tokens: 9_000_009, completion_tokens: 3, total_tokens: 9_000_012 }
  const result = { ...env.result, usage, prices: ai.pricingOf(MODELS, { reported: env.result.model, usage, format: 'openai-chat' }).prices }
  const forged = { ...env, result, sig: signResponse({ container: env.container, id: env.id, method: env.method, params: env.params, ok: true, body: result, ts: env.ts }, KEY) }
  return text.replace(m[0], receiptComment(forged) + '\n\n')
}
test('FIXED AI-ASK-1 through tapeapi-verify: a raised, re-signed usage fails with --request-usage (--strict: an error event in place of [DONE]); without it the forgery passes unchecked', { timeout: 60_000 }, async () => {
  const asked = await cliWorld(['--request-usage', '--strict', '--no-salt'], { edit: inflate })
  try {
    const a = await asked.send(CASES['chat-stream'])
    assert.equal(a.log[0].ok, false)
    assert.match(a.log[0].problems.join(' | '), /the receipt says usage .*9000009.*but the answer reports/)
    assert.match(show(a.delivered), /receipt_invalid/)
    assert.doesNotMatch(show(a.delivered), /data: \[DONE\]/)
  } finally { await asked.close() }
  const old = await cliWorld(['--strict', '--no-salt'], { edit: inflate })
  try {
    const a = await old.send(CASES['chat-stream'])
    assert.equal(a.log[0].ok, true, '1.5: usageInjected, the usage unchecked')
    assert.ok(a.log[0].unchecked.some((x) => /^usage/.test(x)))
    assert.ok(!('usageRequested' in a.log[0]), 'off: no new field in the log line')
  } finally { await old.close() }
})

test('tapeapi-verify --help lists --request-usage, in English and Chinese', () => {
  const out = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }).stdout
  assert.match(out, /--request-usage +ask for the usage of a streamed OpenAI Chat request/)
  assert.match(out, /替未要用量的流式 OpenAI Chat 请求在字节里要用量/)
})
