// tapeapi-verify --policy / --budget-store (3.0, experimental): the client-side budget in the local proxy, through the
// real process. The reference sidecar (canned upstream, real signatures) behind an HTTP server; tapeapi-verify --dev in
// front of it. Shown: a call over the cap gets HTTP 400 budget_exceeded and is not forwarded; one that cannot be bounded
// gets 400 budget_no_limit; the count survives a restart of the process (the store file, mode 600); an HTTP 5xx answered
// with no receipt releases its worst case, a broken connection does not; the --log line of a refusal says why.
// tapeapi-verify --policy / --budget-store：经真实进程验证本地代理里的客户端预算。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as AI from '../src/ai.js'
import { readBudgetLines } from '../src/budget.js'
import { fromUnits8, units8 } from '../src/policy.js'
import { cannedWorld, MODELS } from './helpers/ai-canned.mjs'
import { noonClock } from './helpers/noon-clock.mjs'

// The budget's day window reads the clock in this process (the sidecar's receipt ts) and in the tapeapi-verify child:
// both run on one clock that starts at 12:00 UTC (helpers/noon-clock.mjs), so a store written before midnight is never
// read after it (FIXED, flaky day window). / 预算的日窗口在本进程与子进程都读时钟：二者共用从 UTC 12:00 开始的时钟。
const CLOCK = noonClock()

const CLI = fileURLToPath(new URL('../bin/tapeapi-verify.js', import.meta.url))
const DIR = mkdtempSync(join(tmpdir(), 'tapeapi-budget-cli-'))
test.after(() => rmSync(DIR, { recursive: true, force: true }))
const H = { 'content-type': 'application/json', authorization: 'Bearer sk-demo' }
const body = (o = {}) => JSON.stringify({ model: 'demo-chat', max_tokens: 16, messages: [{ role: 'user', content: 'Say hello' }], ...o })
const BEM = MODELS.find((m) => m.id === 'demo-chat').prices[0]
// the canned answer claims 9 prompt and 3 completion tokens / 固定回答声称 9 个输入、3 个输出 token
const CLAIM = units8(AI.amountOf(BEM, { prompt_tokens: 9, completion_tokens: 3 }))
const worst = (b) => units8(AI.maxAmountOf(BEM, { promptTokens: new TextEncoder().encode(b).length + 64, completionTokens: JSON.parse(b).max_tokens }))

// The sidecar behind an HTTP server; a body with "boom" gets an HTTP 503 with no receipt from this server itself, one
// with "drop" a closed connection. / HTTP 服务器后的旁路；"boom" 由本服务器直接回 503（无回执），"drop" 直接断开。
async function sidecarServer() {
  let w = null
  const seen = { forwarded: 0 }
  const srv = http.createServer(async (req, res) => {
    const parts = []; for await (const c of req) parts.push(c)
    const raw = Buffer.concat(parts)
    if (req.method === 'POST') seen.forwarded++
    if (raw.includes('"boom"')) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"overloaded"}}') }
    if (raw.includes('"drop"')) return req.socket.destroy()
    const headers = new Headers(); for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1])
    const r = await w.proxy.handleRequest(new Request(new URL(req.url, 'http://127.0.0.1'), { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw }))
    const h = Object.fromEntries(r.headers); delete h['content-length']
    res.writeHead(r.status, h)
    res.end(r.body ? Buffer.from(await r.arrayBuffer()) : undefined)
  })
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
  const url = `http://127.0.0.1:${srv.address().port}`
  w = await cannedWorld({ live: `${url}/tapeapi/v1` })
  return { url, seen, close: () => new Promise((ok) => { srv.closeAllConnections(); srv.close(ok) }) }
}
async function verifyProcess(url, flags) {
  const child = spawn(process.execPath, [...CLOCK.importArgs, CLI, '--dev', url, '--port', '0', ...flags], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 300_000, killSignal: 'SIGKILL' })
  let err = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { err += d })
  const local = await new Promise((ok, fail) => {
    // A start that takes over 20 s fails the test, and the child is killed then, so it cannot outlive the run.
    // 20 秒内没起来则测试失败，同时结束子进程，免得它比整个测试运行活得更久。
    const t = setTimeout(() => { child.kill('SIGKILL'); fail(new Error(`tapeapi-verify did not start: ${err}`)) }, 20_000)
    const on = () => { const m = /listening on (http:\/\/\S+)/.exec(err); if (m) { clearTimeout(t); ok(m[1]) } }
    child.stderr.on('data', on); on()
    child.once('exit', (c) => { clearTimeout(t); fail(new Error(`tapeapi-verify exited ${c}: ${err}`)) })
  })
  const send = async (b) => {
    const res = await fetch(`${local}/v1/chat/completions`, { method: 'POST', headers: H, body: b })
    return { status: res.status, json: await res.json().catch(() => null) }
  }
  const stop = () => new Promise((ok) => { if (child.exitCode !== null) return ok(); child.once('exit', ok); child.kill('SIGTERM') })
  return { send, stop, stderr: () => err }
}
const settle = () => new Promise((r) => setTimeout(r, 50))

test('tapeapi-verify --policy: refused before forwarding (HTTP 400 budget_exceeded, budget_no_limit), counted across a restart of the process', async () => {
  const sc = await sidecarServer()
  const store = join(DIR, 'spend.jsonl'), logFile = join(DIR, 'log.jsonl'), policyFile = join(DIR, 'policy.json')
  const cap = 2n * CLAIM + worst(body())   // three calls fit, the third exactly / 恰好三次，第三次正好等于上限
  writeFileSync(policyFile, JSON.stringify({ tapeapiPolicy: 1, rules: [{ name: 'all BEM', period: 'total', maxAmount: fromUnits8(cap), currency: 'BEM' }] }))
  let p = await verifyProcess(sc.url, ['--policy', policyFile, '--budget-store', store, '--log', logFile])
  try {
    for (let i = 0; i < 3; i++) assert.equal((await p.send(body())).status, 200, p.stderr())
    assert.equal(sc.seen.forwarded, 3)
    const r = await p.send(body())
    assert.equal(r.status, 400)
    assert.equal(r.json.error.code, 'budget_exceeded')
    assert.match(r.json.error.message, /^tapeapi-verify: budget: rule "all BEM" \(total\): maxAmount/)
    assert.equal(sc.seen.forwarded, 3, 'not forwarded')
    const nl = await p.send(body({ max_tokens: undefined }))
    assert.equal(nl.status, 400); assert.equal(nl.json.error.code, 'budget_no_limit'); assert.equal(sc.seen.forwarded, 3)
    await settle()
    const log = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const refused = log.filter((l) => l.budget)
    assert.deepEqual(refused.map((l) => [l.status, l.ok, l.budget.reason]), [[400, false, 'budget-cap'], [400, false, 'budget-no-limit']])
    assert.deepEqual([refused[0].budget.spent, refused[0].budget.worstCase, refused[0].budget.cap], [fromUnits8(3n * CLAIM), fromUnits8(worst(body())), fromUnits8(cap)])
    assert.match(p.stderr(), /--policy: 1 rule\(s\) from .*refused before it is sent \(client-side, this process only/)
  } finally { await p.stop() }
  assert.equal(statSync(store).mode & 0o777, 0o600)
  const lines = readBudgetLines(readFileSync(store, 'utf8'))
  assert.deepEqual([lines.sent.length, lines.receipts.length, lines.skipped.length], [3, 3, 0])
  // a new process on the same store: the first call is already over / 同一存储上的新进程：第一次调用就已超出
  p = await verifyProcess(sc.url, ['--policy', policyFile, '--budget-store', store])
  try {
    assert.match(p.stderr(), /3 receipt\(s\), 0 call\(s\) at their worst case so far/)
    const r = await p.send(body())
    assert.equal(r.status, 400); assert.equal(r.json.error.code, 'budget_exceeded')
    assert.equal(sc.seen.forwarded, 3)
  } finally { await p.stop(); await sc.close() }
})

test('tapeapi-verify --policy: an HTTP 5xx with no receipt is released, a broken connection keeps counting; usage mistakes exit 2; help in en and zh', async () => {
  const sc = await sidecarServer()
  const store = join(DIR, 'release.jsonl'), policyFile = join(DIR, 'policy-big.json')
  writeFileSync(policyFile, JSON.stringify({ tapeapiPolicy: 1, rules: [{ period: 'day', maxAmount: '1', currency: 'BEM' }] }))
  // --no-strict: the 503 the sidecar made with no receipt is passed on as it is (strict, the default since 3.0, answers
  // 502 receipt_invalid instead). / --no-strict：旁路的无回执 503 原样转交（3.0 起默认的严格模式改回 502）。
  const p = await verifyProcess(sc.url, ['--policy', policyFile, '--budget-store', store, '--no-strict'])
  try {
    const boom = await p.send(body({ messages: [{ role: 'user', content: 'boom' }] }))
    assert.equal(boom.status, 503)
    const drop = await p.send(body({ messages: [{ role: 'user', content: 'drop' }] }))
    assert.equal(drop.status, 502); assert.equal(drop.json.error.code, 'service_unreachable')
    await settle()
  } finally { await p.stop(); await sc.close() }
  const lines = readBudgetLines(readFileSync(store, 'utf8'))
  assert.equal(lines.sent.length, 2)
  assert.deepEqual(lines.released.map((x) => [x.id, x.why, x.status]), [[lines.sent[0].id, 'http-error-no-receipt', 503]], 'only the 503 is released')
  // usage mistakes / 用法错误
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 300_000, killSignal: 'SIGKILL' })
  const a = run(['--dev', 'http://127.0.0.1:1', '--budget-store', store])
  assert.equal(a.status, 2); assert.match(a.stderr, /--budget-store applies with --policy only/)
  writeFileSync(join(DIR, 'bad.json'), JSON.stringify({ tapeapiPolicy: 1, rules: [{ period: 'day', maxAmout: '1' }] }))
  const b = run(['--dev', 'http://127.0.0.1:1', '--policy', join(DIR, 'bad.json')])
  assert.equal(b.status, 2); assert.match(b.stderr, /unknown key "maxAmout"/)
  const c = run(['--dev', 'http://127.0.0.1:1', '--policy', join(DIR, 'missing.json')])
  assert.equal(c.status, 2); assert.match(c.stderr, /cannot read --policy/)
  const help = run(['--help'])
  assert.match(help.stdout, /--policy <file>\s+EXPERIMENTAL \(3\.0\)/)
  assert.match(help.stdout, /--budget-store <file>/)
  assert.match(help.stdout, /实验性，默认关闭：你自己的策略文件/)
  assert.doesNotMatch(help.stdout.slice(help.stdout.indexOf('--policy'), help.stdout.indexOf('--strip-session-headers')), /认证|合作伙伴|推荐|通过|采用|成为标准|已审计|主网可用|批准|partner|recommend/)
  void existsSync
})
