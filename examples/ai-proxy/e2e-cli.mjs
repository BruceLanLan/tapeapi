#!/usr/bin/env node
// End-to-end run of the AI signing sidecar with the REAL Claude Code and OpenAI Codex CLIs, with no real key and no real
// model: CLI -> sidecar -> the in-repo fake upstream (fake-upstream.mjs), and CLI -> tapeapi-verify --strict -> sidecar ->
// fake upstream. Every CLI turn (a streamed reply, a tool-use turn, a thinking turn) also runs against the fake directly
// (the control): the output and the CLI's own warnings must be the same with the sidecar in between. Every receipt is
// verified with ai.verifyUsageReceipt against the exact bytes the CLI sent and received (teed in the sidecar's HTTP
// server). A tampered answer must be refused by tapeapi-verify --strict. Not part of `npm test`: it needs the CLIs.
// 用**真实的** Claude Code 与 OpenAI Codex CLI 端到端运行 AI 签名旁路，不用真实密钥、不调真实模型：CLI -> 旁路 -> 仓库内的模拟
// 上游，以及 CLI -> tapeapi-verify --strict -> 旁路 -> 模拟上游。每个回合（流式回复、工具调用、思考块）也直接对模拟上游跑一遍
// （对照组）：中间加了旁路，输出与 CLI 自己的警告必须不变。每份回执都按 CLI 收发的确切字节（在旁路 HTTP 服务器里旁路抄录）
// 用 ai.verifyUsageReceipt 核验。被篡改的回答必须被 tapeapi-verify --strict 拒绝。不在 npm test 里：需要这两个 CLI。
//
//   node examples/ai-proxy/e2e-cli.mjs [--only claude|codex] [--save-fixtures] [--keep]
//
// Claude Code: CLAUDE_BIN, else `claude` on PATH, else ~/.local/bin/claude. It runs with --bare (API-key auth only:
//   OAuth and the keychain are never read), HOME and CLAUDE_CONFIG_DIR in a fresh temporary directory, ANTHROPIC_API_KEY
//   a dummy. Codex: CODEX_BIN, else `codex` on PATH, else (CODEX_NPX=1) `npx -y @openai/codex`; CODEX_HOME in a fresh
//   temporary directory with a config.toml whose provider points at the proxy (wire_api "responses"), OPENAI_API_KEY a
//   dummy, read-only sandbox, no approvals. A CLI that is not found is skipped.
// --save-fixtures writes what the CLIs sent and what the upstream answered (paths, long texts trimmed) to
//   sdk/test/fixtures/ai-cli.json, which server/test/ai-cli-replay.test.mjs and sdk/test/ai-cli.test.mjs replay without the CLIs.
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAIProxy } from '@tapeapi/server/ai-proxy'
import { ai, sig } from '@tapeapi/sdk'
import { startFakeUpstream, DEMO_KEY } from './fake-upstream.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const args = process.argv.slice(2)
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null
const SAVE = args.includes('--save-fixtures')
const KEEP = args.includes('--keep')
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5'
const CODEX_MODEL = process.env.CODEX_MODEL || 'gpt-5-codex'
const RUN_TIMEOUT_MS = 180_000
const td = new TextDecoder()

// ---- finding the CLIs / 找到 CLI ----
const which = (cmd) => { const r = spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null }
function findClaude() {
  if (process.env.CLAUDE_BIN) return existsSync(process.env.CLAUDE_BIN) ? [process.env.CLAUDE_BIN] : null
  const p = which('claude') || (existsSync(join(homedir(), '.local/bin/claude')) ? join(homedir(), '.local/bin/claude') : null)
  return p ? [p] : null
}
function findCodex() {
  if (process.env.CODEX_BIN) return existsSync(process.env.CODEX_BIN) ? [process.env.CODEX_BIN] : null
  const p = which('codex')
  if (p) return [p]
  if (process.env.CODEX_NPX === '1' && which('npx')) return [which('npx'), '-y', '@openai/codex']
  return null
}

// ---- the stack: fake upstream, sidecar (bytes teed), tapeapi-verify / 组件：模拟上游、旁路（抄录字节）、tapeapi-verify ----
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'tapeapi-e2e-')))
const upstreamSeen = []
const fake = await startFakeUpstream({ models: [CLAUDE_MODEL, CODEX_MODEL], onRequest: (r) => upstreamSeen.push(r) })
const fakeRoot = fake.baseUrl.replace(/\/v1$/, '')

const KEY = sig.randomPrivateKey()
const MODELS = [
  { id: CLAUDE_MODEL, formats: ['anthropic-messages'], prices: [{ currency: 'BEM', unit: '1M tokens', input: '3', output: '15', cacheRead: '0.3', cacheWrite: '3.75', cacheWrite1h: '6' }, { currency: 'USDT', unit: '1M tokens', input: '0.3', output: '1.5' }] },
  { id: CODEX_MODEL, formats: ['openai-responses', 'openai-chat'], prices: [{ currency: 'BEM', unit: '1M tokens', input: '1.25', output: '10', cacheRead: '0.125' }] },
]
const calls = []          // every call to the sidecar, with the exact bytes both ways / 旁路收到的每次调用及双向确切字节
const upstreamCalls = []  // what the sidecar sent upstream and got back / 旁路发往上游的请求与回应
let tamper = false        // flip a byte of each answer after the sidecar signed it / 在旁路签名之后改动回答的一个字节
const sidecarLog = []

async function teeFetch(url, init) {
  const rec = { url, method: init.method, headers: Object.fromEntries(new Headers(init.headers)), body: init.body ? new Uint8Array(init.body) : null, chunks: [] }
  upstreamCalls.push(rec)
  const res = await fetch(url, init)
  rec.status = res.status; rec.resHeaders = Object.fromEntries(res.headers)
  if (!res.body) return res
  const body = res.body.pipeThrough(new TransformStream({ transform(c, ctl) { rec.chunks.push(c.slice()); ctl.enqueue(c) } }))
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
}

let proxy = null
const sidecar = http.createServer(async (req, res) => {
  const rec = { method: req.method, url: req.url, rawHeaders: req.rawHeaders.slice(), reqChunks: [], resChunks: [], t: Date.now() }
  calls.push(rec)
  const headers = new Headers()
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) { try { headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]) } catch { /* not a fetch header */ } }
  const hasBody = !['GET', 'HEAD'].includes(req.method)
  let it = null
  const body = hasBody ? new ReadableStream({
    async pull(c) { it ??= req[Symbol.asyncIterator](); const { done, value } = await it.next(); if (done) c.close(); else { rec.reqChunks.push(new Uint8Array(value)); c.enqueue(new Uint8Array(value)) } },
  }, { highWaterMark: 0 }) : undefined
  const r = await proxy.handleRequest(new Request(new URL(req.url, 'http://127.0.0.1'), { method: req.method, headers, body, duplex: 'half' }), { clientIp: '127.0.0.1' })
  rec.status = r.status; rec.resHeaders = Object.fromEntries(r.headers)
  res.writeHead(r.status, Object.fromEntries(r.headers))
  if (!r.body || req.method === 'HEAD') { rec.done = true; return res.end() }
  for await (let chunk of r.body) {
    if (tamper) { const s = td.decode(chunk); if (s.includes('Hi!')) chunk = new TextEncoder().encode(s.replace('Hi!', 'Hi?')) }
    rec.resChunks.push(chunk.slice())
    res.write(chunk)
  }
  rec.done = true
  res.end()
})
sidecar.requestTimeout = 0
await new Promise((r) => sidecar.listen(0, '127.0.0.1', r))
const SIDECAR = `http://127.0.0.1:${sidecar.address().port}`
proxy = createAIProxy({
  upstream: { baseUrl: fake.baseUrl }, fetch: teeFetch, signerKey: KEY, models: MODELS, allowHttp: true, rateLimit: false,
  manifestBase: { tapeapi: '0.1', name: 'E2E AI sidecar', circuits: '0x0000000000000000000000000000000000000000', tokenId: '0', container: '0x0000000000000000000000000000000000000000', delegation: null, dev: true, endpoints: { live: [`${SIDECAR}/tapeapi/v1`], async: false } },
  log: (...a) => sidecarLog.push(a.join(' ')),
})
const MANIFEST = proxy.manifest()

async function startVerify({ strict = true } = {}) {
  const logFile = join(TMP, `verify-${Date.now()}.jsonl`)
  const child = spawn(process.execPath, [join(ROOT, 'sdk/bin/tapeapi-verify.js'), '--dev', SIDECAR, '--port', '0', '--log', logFile, ...(strict ? ['--strict'] : [])], { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  const url = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`tapeapi-verify did not start: ${err}`)), 15_000)
    child.stderr.on('data', (d) => { err += d; const m = /listening on (http:\/\/\S+)/.exec(err); if (m) { clearTimeout(t); resolve(m[1]) } })
    child.on('exit', (code) => reject(new Error(`tapeapi-verify exited ${code}: ${err}`)))
  })
  return { url, logFile, stderr: () => err, stop: () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM') }) }
}

// ---- running a CLI / 运行 CLI ----
function run(cmd, argv, { env, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { err += d })
    const t = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS)
    child.on('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal, out, err }) })
  })
}
const BASE_ENV = { PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':'), TERM: 'dumb', NO_COLOR: '1', LANG: 'en_US.UTF-8' }
const norm = (s) => String(s).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<t>').replace(/127\.0\.0\.1:\d+/g, '<host>').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>').replace(/\b(msg|resp|rs|fc|call|toolu|req)_[A-Za-z0-9]+/g, '$1_<id>').replace(/\d+(\.\d+)?\s?ms\b/g, '<ms>').replace(/Chunk ID: \w+/g, 'Chunk ID: <id>').replace(/Wall time: [\d.]+ seconds/g, 'Wall time: <t>').replace(/"(duration_ms|duration_api_ms|ttft_ms|ttft_stream_ms|time_to_request_ms)":\d+/g, '"$1":0').trim()

async function claudeTurn(bin, base, label, prompt) {
  const dir = join(TMP, `claude-${label}`), work = join(dir, 'work')
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'hello.txt'), 'hello from the tapeapi e2e test\n')
  const env = {
    ...BASE_ENV, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, '.claude'), ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: DEMO_KEY, ANTHROPIC_SMALL_FAST_MODEL: CLAUDE_MODEL,
    DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
  const debug = join(dir, 'debug.log')
  const r = await run(bin[0], [...bin.slice(1), '--bare', '-p', prompt.replaceAll('<work>', work), '--output-format', 'json', '--model', CLAUDE_MODEL, '--max-turns', '4', '--allowedTools', 'Read', '--no-session-persistence', '--debug-file', debug], { env, cwd: work })
  writeFileSync(join(dir, 'stdout.json'), r.out); writeFileSync(join(dir, 'stderr.txt'), r.err)
  let result = null
  try { result = JSON.parse(r.out) } catch { /* printed below */ }
  const dbg = existsSync(debug) ? readFileSync(debug, 'utf8') : ''
  const noise = dbg.split('\n').filter((l) => /\[(WARN|ERROR)\]/.test(l)).map((l) => norm(l.replace(/^\S+\s+/, '').replaceAll(dir, '<dir>')))
  return { ok: r.code === 0 && result && result.is_error === false, code: r.code, text: result?.result ?? null, turns: result?.num_turns, denials: result?.permission_denials, stderr: norm(r.err.replaceAll(dir, '<dir>')), noise, raw: r }
}

async function codexTurn(bin, base, label, prompt) {
  const dir = join(TMP, `codex-${label}`), work = join(dir, 'work'), home = join(dir, 'codex')
  mkdirSync(work, { recursive: true }); mkdirSync(home, { recursive: true })
  writeFileSync(join(work, 'hello.txt'), 'hello from the tapeapi e2e test\n')
  writeFileSync(join(home, 'config.toml'), [
    `model = "${CODEX_MODEL}"`, 'model_provider = "tapeapi"', 'approval_policy = "never"', 'sandbox_mode = "read-only"', '',
    '[model_providers.tapeapi]', 'name = "TapeAPI sidecar (e2e)"', `base_url = "${base}/v1"`, 'env_key = "OPENAI_API_KEY"', 'wire_api = "responses"', 'stream_max_retries = 1', 'request_max_retries = 1', '',
  ].join('\n'))
  const env = { ...BASE_ENV, HOME: dir, CODEX_HOME: home, OPENAI_API_KEY: DEMO_KEY, ...(bin[0].endsWith('npx') ? { npm_config_cache: join(homedir(), '.npm'), npm_config_update_notifier: 'false' } : {}) }
  const last = join(dir, 'last.txt')
  const r = await run(bin[0], [...bin.slice(1), 'exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-m', CODEX_MODEL, '--json', '-o', last, prompt], { env, cwd: work })
  writeFileSync(join(dir, 'stdout.jsonl'), r.out); writeFileSync(join(dir, 'stderr.txt'), r.err)
  const events = r.out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const text = existsSync(last) ? readFileSync(last, 'utf8').trim() : null
  const noise = r.err.split('\n').filter((l) => /\b(ERROR|WARN)\b/.test(l)).map((l) => norm(l.replace(/^\S+Z\s+/, '').replaceAll(dir, '<dir>')))
  // Codex reports its own warnings (e.g. unknown model metadata) as error items: they are compared with the control.
  // Codex 把自己的警告（如未知模型元数据）报告成 error 项：与对照组比较。
  // Top-level error events are Codex's own notices (e.g. "Reconnecting... 1/1"): compared with the control too; only
  // turn.failed fails the turn. / 顶层 error 事件是 Codex 自己的提示（如重连）：同样与对照组比较；只有 turn.failed 算失败。
  const failed = events.filter((e) => e.type === 'turn.failed')
  const errorItems = events.filter((e) => e.item?.type === 'error' || e.type === 'error').map((e) => norm(e.item?.message ?? e.message))
  const tools = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'command_execution').map((e) => ({ command: e.item.command, exit: e.item.exit_code, output: String(e.item.aggregated_output ?? '').trim() }))
  return { ok: r.code === 0 && !failed.length && text !== null, code: r.code, text, events: events.map((e) => e.type + (e.item?.type ? `:${e.item.type}` : '')), failed, tools, noise: [...noise, ...errorItems], error: failed.map((e) => e.message ?? e.error?.message).join(' | '), stderr: norm(r.err.replaceAll(dir, '<dir>')), raw: r }
}

// ---- verifying the receipts of the calls made since `from` / 核验自 from 起的调用的回执 ----
const bytesOf = (chunks) => { const n = chunks.reduce((a, c) => a + c.length, 0); const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length } return out }
function receiptsSince(from) {
  const out = []
  for (const c of calls.slice(from)) {
    const path = new URL(c.url, 'http://x').pathname
    const format = ai.formatFor(c.method, path)
    if (!format) { out.push({ path, method: c.method, status: c.status, metered: false }); continue }
    const requestBytes = bytesOf(c.reqChunks), responseBytes = bytesOf(c.resChunks)
    const stream = !!format.stream && String(c.resHeaders['content-type'] || '').includes('text/event-stream')
    const envelope = stream ? ai.readSseReceipt(responseBytes) : ai.decodeReceiptHeader(c.resHeaders[ai.RECEIPT_HEADER])
    const v = ai.verifyUsageReceipt({ envelope, manifest: MANIFEST, requestBytes, responseBytes, stream, path, status: c.status, maxSkewS: 300 })
    out.push({ path, method: c.method, status: c.status, metered: true, stream, ok: v.ok, problems: v.problems, warnings: v.warnings, unchecked: v.unchecked, model: envelope?.result?.model, usage: envelope?.result?.usage, prices: envelope?.result?.prices, complete: envelope?.result?.complete })
  }
  return out
}

// ---- the report / 报告 ----
const results = []
const fail = (msg) => { results.push({ ok: false, msg }); console.log(`  FAIL ${msg}`) }
const pass = (msg) => { results.push({ ok: true, msg }); console.log(`  ok   ${msg}`) }
const check = (cond, msg) => (cond ? pass(msg) : fail(msg))
function sameNoise(control, other) {
  const a = new Set(control), extra = [...new Set(other)].filter((x) => !a.has(x))
  return extra
}

const TURNS = {
  claude: [
    { name: 'streamed reply', prompt: 'say hi' },
    { name: 'tool use (Read)', prompt: '[[tool:Read {"file_path":"<work>/hello.txt"}]] read hello.txt and tell me what it says', tool: true },
    { name: 'thinking block', prompt: '[[think]] think first, then say hi' },
    { name: 'upstream 529 overloaded, retried', prompt: '[[fail:529]] say hi' },
    { name: 'stream cut by an error event, retried', prompt: '[[cut]] say hi' },
  ],
  codex: [
    { name: 'streamed reply', prompt: 'say hi' },
    { name: 'tool use (exec_command)', prompt: '[[tool:exec_command {"cmd":"cat hello.txt"}]] read hello.txt and tell me what it says', tool: true },
    { name: 'reasoning item', prompt: '[[think]] think first, then say hi' },
    { name: 'upstream 500, retried', prompt: '[[fail:500]] say hi' },
    { name: 'stream closed before response.completed, retried', prompt: '[[cut]] say hi' },
  ],
}

async function suite(name, bin, turnFn) {
  console.log(`\n== ${name}: ${bin.join(' ')}`)
  const verify = await startVerify({ strict: true })
  const shapes = { endpoints: {}, clientHeaders: new Set(), forwardedHeaders: new Set(), streamEvents: new Set(), fixtures: [] }
  for (const t of TURNS[name]) {
    console.log(`-- ${t.name}`)
    const control = await turnFn(bin, fakeRoot, `${t.name}-control`.replace(/\W+/g, '-'), t.prompt)
    check(control.ok, `control (CLI -> fake upstream): ${control.ok ? JSON.stringify(control.text).slice(0, 100) : `exit ${control.code}: ${control.raw.err.slice(-400)} ${control.raw.out.slice(-400)}`}`)
    const from = calls.length, upFrom = upstreamCalls.length
    const viaSidecar = await turnFn(bin, SIDECAR, `${t.name}-sidecar`.replace(/\W+/g, '-'), t.prompt)
    check(viaSidecar.ok, `CLI -> sidecar -> fake: ${viaSidecar.ok ? 'succeeded' : `exit ${viaSidecar.code}: ${viaSidecar.raw.err.slice(-400)} ${viaSidecar.raw.out.slice(-400)}`}`)
    check(norm(viaSidecar.text) === norm(control.text), `same final text as the control (${JSON.stringify(viaSidecar.text)?.slice(0, 80)})`)
    const extra = sameNoise(control.noise, viaSidecar.noise)
    check(!extra.length, `no warning or error the control run did not have${extra.length ? `: ${extra.slice(0, 5).join(' | ')}` : ''}`)
    if (t.tool) check(name === 'claude' ? (viaSidecar.turns ?? 0) >= 2 && !viaSidecar.denials?.length && /hello from the tapeapi e2e test/.test(viaSidecar.text) : viaSidecar.tools.some((x) => /hello from the tapeapi e2e test/.test(x.output)) && /hello from the tapeapi e2e test/.test(viaSidecar.text), 'the tool ran and its result came back through the sidecar')
    const recs = receiptsSince(from)
    const metered = recs.filter((r) => r.metered)
    check(metered.length > 0 && metered.every((r) => r.ok), `${metered.length} receipt(s) verify against the exact bytes${metered.filter((r) => !r.ok).map((r) => `; ${r.path}: ${r.problems.join(', ')}`).join('')}`)
    check(metered.every((r) => (r.usage ? !!r.prices : r.prices === null)), `every receipt with usage is priced, the others carry prices null (${metered.map((r) => `${r.status}${r.stream ? ' stream' : ''}${r.complete ? '' : ' incomplete'} ${r.model} ${r.prices ? r.prices.map((p) => `${p.amount} ${p.currency}`).join(' / ') : 'unpriced'}`).join('; ')})`)
    if (metered.some((r) => r.warnings.length)) console.log(`       warnings: ${[...new Set(metered.flatMap((r) => r.warnings))].join('; ')}`)
    for (const c of calls.slice(from)) {
      const u = new URL(c.url, 'http://x')
      const key = `${c.method} ${u.pathname}${u.search}`
      shapes.endpoints[key] = shapes.endpoints[key] ? `${shapes.endpoints[key].split(' x')[0]} x${Number(shapes.endpoints[key].split(' x')[1] || 1) + 1}` : `${c.status}`
      for (let i = 0; i < c.rawHeaders.length; i += 2) shapes.clientHeaders.add(c.rawHeaders[i].toLowerCase())
    }
    for (const u of upstreamCalls.slice(upFrom)) {
      for (const k of Object.keys(u.headers)) shapes.forwardedHeaders.add(k)
      const text = td.decode(bytesOf(u.chunks))
      for (const m of text.matchAll(/^event: ?(\S+)/gm)) shapes.streamEvents.add(m[1])
      for (const m of text.matchAll(/"type":"([a-z_.]+_delta|[a-z_.]+)"/g)) if (/delta$/.test(m[1])) shapes.streamEvents.add(`  delta ${m[1]}`)
    }
    // fixtures: what the CLI sent, what the upstream answered / 固件：CLI 发了什么、上游答了什么
    const ups = upstreamCalls.slice(upFrom)
    for (const c of calls.slice(from)) {
      const u = new URL(c.url, 'http://x')
      shapes.fixtures.push({ cli: name, turn: t.name, call: c, upstream: ups.find((x) => !x.used && x.url.endsWith(u.pathname + u.search) && (x.used = true)) })
    }

    // through tapeapi-verify --strict / 经由 tapeapi-verify --strict
    const vFrom = calls.length
    const viaVerify = await turnFn(bin, verify.url, `${t.name}-verify`.replace(/\W+/g, '-'), t.prompt)
    check(viaVerify.ok && norm(viaVerify.text) === norm(control.text), `CLI -> tapeapi-verify --strict -> sidecar: same answer${viaVerify.ok ? '' : `: exit ${viaVerify.code} ${viaVerify.raw.err.slice(-300)}`}`)
    const extraV = sameNoise(control.noise, viaVerify.noise)
    check(!extraV.length, `no new warning or error through tapeapi-verify${extraV.length ? `: ${extraV.slice(0, 5).join(' | ')}` : ''}`)
    const vrecs = receiptsSince(vFrom).filter((r) => r.metered)
    check(vrecs.length > 0 && vrecs.every((r) => r.ok), `the bytes tapeapi-verify passed on still verify (${vrecs.length})`)
  }
  // A tampered answer: tapeapi-verify --strict must refuse it, and the CLI must see an error. / 被篡改的回答必须被拒绝。
  console.log('-- tampered answer through tapeapi-verify --strict')
  tamper = true
  const t = await turnFn(bin, verify.url, 'tampered', 'say hi')
  tamper = false
  check(!t.ok || !/Hi\?/.test(t.text ?? ''), `the CLI did not accept the tampered answer (exit ${t.code}${t.text ? `, text ${JSON.stringify(t.text).slice(0, 120)}` : ''}${t.error ? `, error ${JSON.stringify(t.error).slice(0, 160)}` : ''})`)
  await verify.stop()
  const vlines = verify.stderr().split('\n').filter((l) => /\] (OK|FAIL|--) /.test(l))
  check(vlines.some((l) => /FAIL .*responseSha256 does not match/.test(l)), 'tapeapi-verify logged the failed receipt (responseSha256 does not match)')
  const logged = readFileSync(verify.logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  check(logged.length > 0 && logged.filter((l) => l.ok).every((l) => l.receipt?.sig), `--log wrote ${logged.length} JSON lines with the signed receipts`)
  console.log('   tapeapi-verify said:')
  for (const l of vlines) console.log(`     ${l.replace(/^\[tapeapi-verify\]\s*/, '').slice(0, 220)}`)
  console.log(`   endpoints (client -> sidecar): ${JSON.stringify(shapes.endpoints)}`)
  console.log(`   client headers: ${[...shapes.clientHeaders].sort().join(', ')}`)
  console.log(`   forwarded upstream: ${[...shapes.forwardedHeaders].sort().join(', ')}`)
  console.log(`   upstream stream events: ${[...shapes.streamEvents].join(', ')}`)
  return shapes
}

// ---- fixtures: trimmed, no local paths / 固件：裁剪过，不含本地路径 ----
const SCRUB = [[TMP, '<tmp>'], [TMP.replace(/^\/private\//, '/'), '<tmp>'], [homedir(), '<home>'], [ROOT, '<repo>']]
function scrubText(s) { let t = s; for (const [a, b] of SCRUB) t = t.split(a).join(b); return t }
function trim(v) {
  if (typeof v === 'string') { const s = scrubText(v); return s.length > 240 ? `<${s.length} chars>` : s }
  if (Array.isArray(v)) return v.map(trim)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x)]))
  return v
}
function fixtureOf({ cli, turn, call, upstream }) {
  const u = new URL(call.url, 'http://x')
  const reqText = td.decode(bytesOf(call.reqChunks))
  let body = null
  try { body = reqText ? JSON.stringify(trim(JSON.parse(reqText))) : null } catch { body = scrubText(reqText) }
  const headers = []
  for (let i = 0; i < call.rawHeaders.length; i += 2) {
    const k = call.rawHeaders[i]
    if (/^(host|content-length)$/i.test(k)) continue
    headers.push([k, /x-codex-turn-metadata/i.test(k) ? '<metadata>' : scrubText(call.rawHeaders[i + 1])])
  }
  return {
    cli, turn, method: call.method, path: u.pathname, search: u.search, headers, body,
    upstream: upstream ? { status: upstream.status, headers: Object.fromEntries(Object.entries(upstream.resHeaders).filter(([k]) => /^(content-type|request-id|x-request-id|anthropic-organization-id)$/.test(k))), body: scrubText(td.decode(bytesOf(upstream.chunks))), forwarded: Object.keys(upstream.headers).sort() } : null,
  }
}

// ---- main / 主流程 ----
const all = []
const versions = {}
try {
  const claude = ONLY && ONLY !== 'claude' ? null : findClaude()
  const codex = ONLY && ONLY !== 'codex' ? null : findCodex()
  if (!claude) console.log(`\n== Claude Code: skipped (${ONLY && ONLY !== 'claude' ? '--only' : 'not found; set CLAUDE_BIN'})`)
  if (!codex) console.log(`\n== Codex: skipped (${ONLY && ONLY !== 'codex' ? '--only' : 'not found; set CODEX_BIN, or CODEX_NPX=1 to run it with npx -y @openai/codex'})`)
  const versionOf = async (bin) => (await run(bin[0], [...bin.slice(1), '--version'], { env: { ...BASE_ENV, HOME: TMP } })).out.trim()
  if (claude) { versions.claude = await versionOf(claude); console.log(`\n${versions.claude}`); all.push(...(await suite('claude', claude, claudeTurn)).fixtures) }
  if (codex) { versions.codex = await versionOf(codex); console.log(`\n${versions.codex}`); all.push(...(await suite('codex', codex, codexTurn)).fixtures) }
  if (sidecarLog.length) console.log(`\nsidecar log:\n  ${[...new Set(sidecarLog)].join('\n  ')}`)
  if (SAVE && all.length) {
    const file = join(ROOT, 'sdk/test/fixtures/ai-cli.json')
    mkdirSync(dirname(file), { recursive: true })
    const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { calls: [] }
    const clis = new Set(all.map((f) => f.cli))
    const out = { note: 'Captured by examples/ai-proxy/e2e-cli.mjs --save-fixtures from the real CLIs against the fake upstream; long strings trimmed, local paths scrubbed.', versions: { ...prev.versions, ...versions }, models: { claude: CLAUDE_MODEL, codex: CODEX_MODEL }, calls: [...prev.calls.filter((c) => !clis.has(c.cli)), ...all.map(fixtureOf)] }
    writeFileSync(file, JSON.stringify(out, null, 1) + '\n')
    console.log(`\nfixtures: ${out.calls.length} calls -> ${file}`)
  }
} finally {
  await fake.close()
  sidecar.closeAllConnections?.(); sidecar.close()
  if (!KEEP) rmSync(TMP, { recursive: true, force: true }); else console.log(`kept ${TMP}`)
}
const bad = results.filter((r) => !r.ok)
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed${results.length ? '' : ' (nothing ran)'}`)
process.exit(bad.length ? 1 : 0)
