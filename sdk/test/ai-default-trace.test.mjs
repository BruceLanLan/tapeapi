// GOLDEN AI-1.5: the AI receipt path in its default mode, byte by byte. Recorded on 1.5.0 (31a8105) BEFORE any 1.6 code
// (requestUsage, the byte-level member setter) was written, over a canned upstream, a fixed clock and a seeded random
// source: for each request below, through createVerifyingFetch (salt on and off, strict and not, several body forms),
// through the reference sidecar alone, and through tapeapi-verify (default, --no-salt, --strict), the bytes the
// verifying hop sent, the bytes the upstream received, the bytes the application read, and every report (onReport, or
// the --log line without its wall-clock `ts`). Without requestUsage, 1.x must keep all of it, byte for byte.
// The one allowed exception is M3 (1.6, TAPI-21 §3.5 "MUST NOT change … in any other way"): where the sidecar injects
// the usage request it used to re-serialise the body with JSON.stringify, which changed values (integers beyond 2^53,
// 1e400 -> null), merged nested duplicate keys, rewrote whitespace and escapes and dropped the client's salt. Those cases
// carry `m3: <reason>`: only their `upstream` may change, and the 1.5 bytes are kept beside as `upstream_1_5`.
// Regenerate only on purpose: UPDATE_GOLDEN=1 node --test sdk/test/ai-default-trace.test.mjs (it refuses any change
// outside `upstream` of an m3 case; UPDATE_GOLDEN=force overrides, and the commit says why).
// 黄金测试 AI-1.5：AI 回执路径的默认模式，逐字节。在 1.5.0（31a8105）上、写任何 1.6 代码之前录制：固定上游、固定时钟、带种子的
// 随机源。下面每个请求经 createVerifyingFetch（加盐与不加盐、strict 与否、多种正文形态）、单独经参考旁路、经 tapeapi-verify（默认、
// --no-salt、--strict），记录核验方发出的字节、上游收到的字节、应用读到的字节与每份报告（onReport，或去掉墙钟 ts 的 --log 行）。
// 不开 requestUsage 时，1.x 必须逐字节保持不变。唯一允许的例外是 M3：旁路注入用量请求时曾用 JSON.stringify 重新序列化正文，会改值
// （超过 2^53 的整数、1e400 变 null）、合并嵌套的重复键、改写空白与转义、丢掉客户端的盐。这些用例标 m3：只有 upstream 可以变，
// 1.5 的字节保留为 upstream_1_5。只在有意时重新生成（除 m3 用例的 upstream 外有任何变化都会被拒绝；force 可强制，并在提交里说明）。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ai } from '../src/index.js'
import { requestUsageBody } from '../src/ai.js'
import { deterministic } from './helpers/deterministic.mjs'
import { cannedWorld, show, BASE } from './helpers/ai-canned.mjs'

const FIXTURE = fileURLToPath(new URL('./fixtures/ai-default-trace.json', import.meta.url))
const HELPER = fileURLToPath(new URL('./helpers/deterministic.mjs', import.meta.url))
const CLI = fileURLToPath(new URL('../bin/tapeapi-verify.js', import.meta.url))
const te = new TextEncoder()
const CHAT = '/v1/chat/completions', RESP = '/v1/responses', MSG = '/v1/messages', EMB = '/v1/embeddings'
const J = (o, ...a) => JSON.stringify(o, ...a)
const hi = [{ role: 'user', content: 'Say hello' }]

// The requests. `injects`: the sidecar asks the upstream for usage (a stream Chat request that did not); `m3`: what
// re-serialising changes in it (beyond the salt). / 请求。injects：旁路会替它向上游要用量；m3：重新序列化会改掉它的什么（盐之外）。
const BODIES = {
  'chat-stream': { path: CHAT, body: J({ model: 'demo-chat', messages: hi, stream: true }), injects: true },
  'chat-stream-usage': { path: CHAT, body: J({ model: 'demo-chat', messages: hi, stream: true, stream_options: { include_usage: true } }) },
  'chat-json': { path: CHAT, body: J({ model: 'demo-chat', messages: hi }) },
  'chat-stream-false': { path: CHAT, body: J({ model: 'demo-chat', messages: hi, stream: false }) },
  'chat-stream-options-empty': { path: CHAT, body: J({ model: 'demo-chat', stream: true, stream_options: {}, messages: hi }), injects: true },
  'chat-stream-usage-false': { path: CHAT, body: J({ model: 'demo-chat', stream: true, stream_options: { include_usage: false }, messages: hi }), injects: true },
  'chat-stream-options-null': { path: CHAT, body: J({ model: 'demo-chat', stream: true, stream_options: null, messages: hi }), injects: true },
  'chat-stream-big-integer': { path: CHAT, body: '{"model":"demo-chat","seed":12345678901234567890,"messages":[{"role":"user","content":"Say hello"}],"stream":true}', injects: true, m3: 'big-integer' },
  'chat-stream-1e400': { path: CHAT, body: '{"model":"demo-chat","temperature":1e400,"messages":[{"role":"user","content":"Say hello"}],"stream":true}', injects: true, m3: '1e400' },
  'chat-stream-nested-duplicate': { path: CHAT, body: '{"model":"demo-chat","messages":[{"role":"user","content":"first","content":"Say hello"}],"stream":true}', injects: true, m3: 'nested-duplicate-key' },
  'chat-stream-formatted': { path: CHAT, body: J({ model: 'demo-chat', messages: hi, stream: true }, null, 2) + '\n', injects: true, m3: 'whitespace' },
  'chat-stream-escapes': { path: CHAT, body: '{"model":"demo-chat","messages":[{"role":"user","content":"caf\\u00e9 \\ud83d\\ude00 a\\/b"}],"stream":true}', injects: true, m3: 'escapes' },
  // Kept as 1.5 sends them: a duplicate at the top level, and a leading byte order mark (the 1.6 setter refuses both).
  // 保持 1.5 的发送方式：顶层重复键与开头的字节序标记（1.6 的成员设置器对二者都拒绝）。
  'chat-stream-top-duplicate': { path: CHAT, body: '{"model":"demo-chat","model":"demo-chat","messages":[{"role":"user","content":"Say hello"}],"stream":true}', injects: true, refused: true },
  'chat-stream-bom': { path: CHAT, body: '\ufeff' + J({ model: 'demo-chat', messages: hi, stream: true }), injects: true, refused: true },
  'responses-stream': { path: RESP, body: J({ model: 'demo-chat', input: 'Hi', stream: true }) },
  'responses-json': { path: RESP, body: J({ model: 'demo-chat', input: 'Hi' }) },
  'anthropic-stream': { path: MSG, body: J({ model: 'demo-claude', max_tokens: 64, messages: hi, stream: true }), headers: { 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-demo' } },
  'anthropic-json': { path: MSG, body: J({ model: 'demo-claude', max_tokens: 64, messages: hi }), headers: { 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-demo' } },
  'embeddings': { path: EMB, body: J({ model: 'demo-embed', input: 'one word' }) },
}
const headersOf = (b) => ({ 'content-type': 'application/json', authorization: 'Bearer sk-demo', ...(b.headers ?? {}) })
// The m3 reason of a case: its body's own, or the salt when a salted body is one the sidecar injects into.
// 用例的 m3 原因：正文自己的，或者旁路会注入、且加了盐的正文的"盐"。
const m3Of = (b, salted) => b.m3 ?? (salted && b.injects && !b.refused ? 'salt' : undefined)

// The body forms createVerifyingFetch is given (the bytes must be the same whatever the form). / 传给核验 fetch 的正文形态。
const FORMS = {
  string: (url, b) => [url, { method: 'POST', headers: headersOf(b), body: b.body }],
  bytes: (url, b) => [url, { method: 'POST', headers: headersOf(b), body: te.encode(b.body) }],
  arraybuffer: (url, b) => [url, { method: 'POST', headers: headersOf(b), body: te.encode(b.body).buffer }],
  stream: (url, b) => [url, { method: 'POST', headers: headersOf(b), duplex: 'half', body: new ReadableStream({ start(c) { const x = te.encode(b.body); c.enqueue(x.subarray(0, 7)); c.enqueue(x.subarray(7)); c.close() } }) }],
  request: (url, b) => [new Request(url, { method: 'POST', headers: headersOf(b), body: b.body })],
}

// ---- recording / 录制 ----
async function recordSdk(name, { salt, strict, form }) {
  const b = BODIES[name]
  const restore = deterministic({ seed: 7 })
  try {
    const w = await cannedWorld()
    const sent = []
    const reports = []
    const vf = ai.createVerifyingFetch({ service: w.service, salt, strict, onReport: (r) => reports.push(r), fetch: async (u, i) => { sent.push(new Uint8Array(await new Response(i.body).arrayBuffer())); return w.proxy.handleRequest(new Request(u, i)) } })
    const res = await vf(...FORMS[form](BASE + b.path, b))
    const delivered = new Uint8Array(await res.arrayBuffer())
    return { status: res.status, sent: sent.map(show), upstream: w.up.seen.map((x) => show(x.body)), delivered: show(delivered), reports: JSON.parse(J(reports)) }
  } finally { restore() }
}
async function recordSidecar(name) {
  const b = BODIES[name]
  const restore = deterministic({ seed: 7 })
  try {
    const w = await cannedWorld()
    const res = await w.proxy.handleRequest(new Request(BASE + b.path, { method: 'POST', headers: headersOf(b), body: b.body }))
    const delivered = new Uint8Array(await res.arrayBuffer())
    return { status: res.status, upstream: w.up.seen.map((x) => show(x.body)), delivered: show(delivered), receipt: res.headers.get(ai.RECEIPT_HEADER) }
  } finally { restore() }
}
// tapeapi-verify in a child (fixed clock and seeded salt there too), in front of the sidecar behind an HTTP server.
// 子进程里的 tapeapi-verify（同样固定时钟与带种子的盐），前面是 HTTP 服务器后的旁路。
async function recordCli(names, flags) {
  const restore = deterministic({ seed: 7 })
  const dir = mkdtempSync(join(tmpdir(), 'tapeapi-golden-'))
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
    res.writeHead(r.status, h)
    res.end(r.body ? Buffer.from(await r.arrayBuffer()) : undefined)
  })
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
  const url = `http://127.0.0.1:${srv.address().port}`
  w = await cannedWorld({ live: `${url}/tapeapi/v1` })
  const child = spawn(process.execPath, ['--import', HELPER, CLI, '--dev', url, '--port', '0', '--log', logFile, ...flags], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TAPEAPI_TEST_DETERMINISTIC: '1', TAPEAPI_TEST_SEED: '7' } })
  let err = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { err += d })
  const out = {}
  try {
    const local = await new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error(`tapeapi-verify did not start: ${err}`)), 20_000)
      const on = () => { const m = /listening on (http:\/\/\S+)/.exec(err); if (m) { clearTimeout(t); ok(m[1]) } }
      child.stderr.on('data', on); on()
    })
    let lines = 0
    for (const name of names) {
      const b = BODIES[name]
      const r0 = received.length, u0 = w.up.seen.length
      const res = await fetch(local + b.path, { method: 'POST', headers: headersOf(b), body: b.body })
      const delivered = new Uint8Array(await res.arrayBuffer())
      const all = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : []
      const log = all.slice(lines).map((l) => { const o = JSON.parse(l); delete o.ts; return o })
      lines = all.length
      out[name] = { status: res.status, sent: received.slice(r0).map(show), upstream: w.up.seen.slice(u0).map((x) => show(x.body)), delivered: show(delivered), reports: log }
    }
  } finally {
    await new Promise((ok) => { if (child.exitCode !== null) return ok(); child.once('exit', ok); child.kill('SIGTERM') })
    await new Promise((ok) => { srv.closeAllConnections(); srv.close(ok) })
    rmSync(dir, { recursive: true, force: true })
    restore()
  }
  return out
}

const SDK_RUNS = [
  ...Object.keys(BODIES).flatMap((name) => [{ name, salt: true, strict: true, form: 'string' }, { name, salt: false, strict: true, form: 'string' }]),
  ...['chat-stream', 'chat-stream-usage', 'chat-json', 'responses-stream', 'anthropic-stream'].map((name) => ({ name, salt: true, strict: false, form: 'string' })),
  ...['bytes', 'arraybuffer', 'stream', 'request'].flatMap((form) => ['chat-stream', 'chat-stream-usage', 'anthropic-json'].map((name) => ({ name, salt: true, strict: true, form }))),
]
const CLI_NAMES = ['chat-stream', 'chat-stream-usage', 'chat-json', 'chat-stream-big-integer', 'chat-stream-formatted', 'responses-stream', 'responses-json', 'anthropic-stream', 'anthropic-json', 'embeddings']
const CLI_RUNS = [{ label: 'default', flags: [] }, { label: 'no-salt', flags: ['--no-salt'] }, { label: 'strict', flags: ['--strict'] }]

async function recordAll() {
  const cases = {}
  for (const r of SDK_RUNS) {
    const key = `sdk ${r.name} salt=${r.salt} strict=${r.strict} form=${r.form}`
    cases[key] = { m3: m3Of(BODIES[r.name], r.salt), request: BODIES[r.name].body, ...(await recordSdk(r.name, r)) }
  }
  for (const name of Object.keys(BODIES)) cases[`sidecar ${name}`] = { m3: BODIES[name].m3, request: BODIES[name].body, ...(await recordSidecar(name)) }
  for (const run of CLI_RUNS) {
    const got = await recordCli(CLI_NAMES, run.flags)
    for (const name of CLI_NAMES) cases[`cli ${name} ${run.label}`] = { m3: m3Of(BODIES[name], !run.flags.includes('--no-salt')), request: BODIES[name].body, ...got[name] }
  }
  for (const c of Object.values(cases)) if (c.m3 === undefined) delete c.m3
  return cases
}

// The guard on regeneration: only `upstream` of an m3 case may change; its 1.5 value is kept. / 重新生成的守卫。
function merge(old, now, force) {
  const out = {}
  const bad = []
  for (const [k, c] of Object.entries(now)) {
    const o = old?.[k]
    const n = { ...c }
    if (o?.upstream_1_5 !== undefined) n.upstream_1_5 = o.upstream_1_5
    if (o) {
      for (const f of new Set([...Object.keys(o), ...Object.keys(c)])) {
        if (f === 'upstream_1_5') continue
        if (J(o[f]) === J(c[f])) continue
        if (f === 'upstream' && c.m3) { if (n.upstream_1_5 === undefined) n.upstream_1_5 = o.upstream; continue }
        bad.push(`${k}: ${f}`)
      }
    } else if (old) bad.push(`${k}: new case`)
    out[k] = n
  }
  if (old) for (const k of Object.keys(old)) if (!(k in now)) bad.push(`${k}: removed`)
  if (bad.length && !force) throw new Error(`refusing to regenerate: changes outside the upstream bytes of m3 cases:\n  ${bad.join('\n  ')}`)
  return out
}

test('GOLDEN AI-1.5: the default AI receipt path (createVerifyingFetch, the sidecar, tapeapi-verify) is byte for byte what 1.5.0 did', { timeout: 180_000 }, async () => {
  const now = await recordAll()
  const mode = process.env.UPDATE_GOLDEN
  if (mode) {
    const old = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, 'utf8')).cases : null
    const cases = merge(old, now, mode === 'force')
    writeFileSync(FIXTURE, J({ note: 'GOLDEN AI-1.5 (sdk/test/ai-default-trace.test.mjs): recorded on 1.5.0 at 31a8105; regenerate only on purpose', cases }, null, 1) + '\n')
    return
  }
  const want = JSON.parse(readFileSync(FIXTURE, 'utf8')).cases
  assert.deepEqual(Object.keys(now).sort(), Object.keys(want).sort(), 'the same cases')
  for (const [k, c] of Object.entries(now)) {
    const { upstream_1_5, ...w } = want[k]
    void upstream_1_5
    assert.deepEqual(c, w, k)
  }
})

test('GOLDEN AI-1.5: the record is honest: every report verified, salts where expected, the canned upstream answered each call once', () => {
  const want = JSON.parse(readFileSync(FIXTURE, 'utf8')).cases
  for (const [k, c] of Object.entries(want)) {
    assert.equal(c.status, 200, k)
    assert.equal(c.upstream.length, 1, k)
    if (c.reports) assert.ok(c.reports.length >= 1 && c.reports.every((r) => r.ok === true && r.problems.length === 0), `${k}: ${J(c.reports.map((r) => r.problems))}`)
    // A body led by a byte order mark is not a JSON text to the salt: sent as it is. / 以字节序标记开头的正文不加盐。
    if (k.startsWith('sdk ') && / salt=true /.test(k)) assert.ok(c.reports.every((r) => r.salted === !c.request.startsWith('\ufeff')), k)
    if (k.startsWith('sdk ') && / salt=false /.test(k)) assert.equal(c.sent[0], c.request, `${k}: sent as given`)
  }
  // M3 (FIXED AI-RESER, 1.6): where the upstream bytes changed, they are the bytes the sidecar received with the usage
  // member set by requestUsageBody, and they parse to what 1.5 sent. / M3：变化了的上游字节，正是旁路收到的字节按
  // requestUsageBody 设好成员的结果，解析后与 1.5 发出的相同。
  const chat = ai.FORMATS.find((f) => f.name === 'openai-chat')
  for (const [k, c] of Object.entries(want)) {
    if (c.upstream_1_5 === undefined) continue
    assert.ok(c.m3, k)
    const got = new TextEncoder().encode(c.sent ? c.sent[0] : c.request)
    assert.equal(c.upstream[0], new TextDecoder('utf-8', { ignoreBOM: true }).decode(requestUsageBody(got, { format: chat }).bytes), k)
    assert.equal(JSON.stringify(JSON.parse(c.upstream[0])), JSON.stringify(JSON.parse(c.upstream_1_5[0])), k)
  }
  // Each m3 reason is present, and no other case is marked. / 每个 m3 原因都在，其它用例都没有标记。
  const reasons = new Set(Object.values(want).map((c) => c.m3).filter(Boolean))
  assert.deepEqual([...reasons].sort(), ['1e400', 'big-integer', 'escapes', 'nested-duplicate-key', 'salt', 'whitespace'])
})
