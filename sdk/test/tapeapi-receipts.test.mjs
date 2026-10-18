// tapeapi receipts tail|show|export and tapeapi reconcile (sdk/src/receipts-cli.js, sdk/src/reconcile-cli.js;
// experimental): files on this machine only. The receipts are real ones: the reference sidecar (createAIProxy) over the
// fake upstream signs them, the real tapeapi-verify --log writes them (only 127.0.0.1, no chain, no signature written
// by hand). / 回执是真实的：参考旁路在假上游前签名，真实的 tapeapi-verify --log 写下它们（只用 127.0.0.1，不碰链，不手写签名）。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, relative, isAbsolute } from 'node:path'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createAIProxy } from '../../server/src/ai-proxy.js'
import { createFakeUpstream } from '../../examples/ai-proxy/fake-upstream.mjs'
import * as AI from '../src/ai.js'
import { runReceipts, EXPORT_COLUMNS, parseTime, redactKeeping } from '../src/receipts-cli.js'
import { runReconcile, parseCsv, BILL_PRESETS } from '../src/reconcile-cli.js'

const BIN = fileURLToPath(new URL('../bin/tapeapi.js', import.meta.url))
const VERIFY = fileURLToPath(new URL('../bin/tapeapi-verify.js', import.meta.url))
const KEY = '0x' + '42'.repeat(32)
const CONTAINER = '0x' + '7c'.repeat(20)
const TMP = mkdtempSync(join(tmpdir(), 'tapeapi-receipts-test-'))
const closers = []
test.after(async () => { for (const c of closers.reverse()) await c(); rmSync(TMP, { recursive: true, force: true }) })

const MODELS = [
  { id: 'demo-chat', aliases: ['demo-chat-latest'], formats: ['openai-chat'], prices: [{ currency: 'USD', unit: '1M tokens', input: '0.5', output: '1.5' }] },
  { id: 'demo-mini', formats: ['openai-chat'], prices: [{ currency: 'USD', unit: '1M tokens', input: '0.1', output: '0.2' }] },
]
const freePort = () => new Promise((ok) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) }) })

/**
 * The fixture, made once: the sidecar over the fake upstream, tapeapi-verify --dev --no-salt --log in front of it, four
 * calls through it (a whole answer, a stream, another model, a whole answer), then the manifest it serves saved next to
 * the log as manifest.json. Keeps the exact bytes of the first call. / 夹具：四次真实调用的回执与旁边的清单快照。
 */
let FIX = null
async function fixture() {
  if (FIX) return FIX
  const fake = createFakeUpstream({ keys: ['sk-demo'], models: ['demo-chat', 'demo-mini'] })
  let proxy
  const srv = http.createServer(async (req, res) => {
    const parts = []
    for await (const c of req) parts.push(c)
    const r = await proxy.handleRequest(new Request(new URL(req.url, 'http://127.0.0.1'), { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(parts) }), { clientIp: '127.0.0.1' })
    res.writeHead(r.status, Object.fromEntries(r.headers))
    res.end(r.body ? Buffer.from(await r.arrayBuffer()) : undefined)
  })
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
  closers.push(() => new Promise((ok) => { srv.closeAllConnections(); srv.close(ok) }))
  const url = `http://127.0.0.1:${srv.address().port}`
  proxy = createAIProxy({
    upstream: { baseUrl: 'http://fake.local/v1' }, fetch: (u, init) => fake.fetch(u, init), signerKey: KEY, allowHttp: true, rateLimit: false, log: () => {},
    models: MODELS, formats: AI.FORMATS.filter((f) => f.name === 'openai-chat'),
    manifestBase: { name: 'Receipts test relay', circuits: '0x0000000000000000000000000000000000000000', tokenId: '0', container: CONTAINER, delegation: null, dev: true, endpoints: { live: [`${url}/tapeapi/v1`], async: false } },
  })
  const dir = join(TMP, 'fixture')
  mkdirSync(dir)
  const log = join(dir, 'receipts.jsonl')
  const port = await freePort()
  const child = spawn(process.execPath, [VERIFY, '--dev', url, '--port', String(port), '--no-salt', '--log', log], { stdio: ['ignore', 'ignore', 'pipe'] })
  closers.push(() => new Promise((r) => { if (child.exitCode !== null || child.signalCode !== null) return r(); child.once('exit', r); child.kill('SIGKILL') }))
  await new Promise((ok, fail) => {
    let t = ''
    const timer = setTimeout(() => fail(new Error(`tapeapi-verify did not start\n${t}`)), 20_000)
    child.stderr.on('data', (d) => { t += d; if (/BASE_URL=/.test(t)) { clearTimeout(timer); ok() } })
  })
  const call = async (body) => {
    const bytes = JSON.stringify(body)
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-demo' }, body: bytes })
    const res = new Uint8Array(await r.arrayBuffer())
    assert.equal(r.status, 200)
    return { req: bytes, res }
  }
  const first = await call({ model: 'demo-chat', messages: [{ role: 'user', content: 'hello there' }] })
  await call({ model: 'demo-chat', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'a streamed answer please' }] })
  await call({ model: 'demo-mini', messages: [{ role: 'user', content: 'one two three four' }] })
  await call({ model: 'demo-chat', messages: [{ role: 'user', content: 'the fourth call' }] })
  await new Promise((ok) => { child.once('exit', ok); child.kill('SIGTERM') })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(proxy.manifest(), null, 2))
  writeFileSync(join(dir, 'first.request'), first.req)
  writeFileSync(join(dir, 'first.response'), first.res)
  const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 4, 'four logged calls')
  assert.ok(lines.every((l) => l.ok === true && l.receipt), 'tapeapi-verify verified all four')
  FIX = { dir, log, lines, manifest: proxy.manifest(), ids: lines.map((l) => l.receipt.id) }
  return FIX
}

/** A copy of the fixture directory, to change. / 夹具目录的副本，供修改。 */
function copyFixture(name, { manifest = true } = {}) {
  const d = join(TMP, name)
  mkdirSync(d)
  copyFileSync(FIX.log, join(d, 'receipts.jsonl'))
  if (manifest) copyFileSync(join(FIX.dir, 'manifest.json'), join(d, 'manifest.json'))
  for (const f of ['first.request', 'first.response']) copyFileSync(join(FIX.dir, f), join(d, f))
  return d
}

const seen = []
const lastLine = (s) => s.trimEnd().split('\n').pop()
const NEXT = /^(next: \/ 下一条命令:|next:|下一条命令:) \S/
function keep(r) {
  seen.push(r.out, r.err)
  if (r.code !== 0) {
    if (r.out.startsWith('{')) assert.ok(typeof JSON.parse(r.out).next === 'string', `--json exit ${r.code} without next`)
    else assert.match(lastLine(r.out + r.err), NEXT, `exit ${r.code} without a next line:\n${r.out}${r.err}`)
  }
  return r
}
let fetches = 0
const HOST = { readFileSync, readdirSync, statSync, writeFileSync, join, dirname, relative, isAbsolute }
async function run(fn, args, { env = {}, isTTY = false, cwd = FIX.dir } = {}) {
  let out = '', err = ''
  const saved = globalThis.fetch
  globalThis.fetch = async () => { fetches++; throw new Error('no network in receipts / reconcile') }
  try {
    const r = await fn(args, { host: HOST, cmd: 'tapeapi', version: '0.0.0-test', env, isTTY, cwd, stdout: (s) => { out += s }, stderr: (s) => { err += s } })
    return keep({ code: r.exitCode, out, err })
  } finally { globalThis.fetch = saved }
}
const receipts = (args, o) => run(runReceipts, args, o)
const reconcile = (args, o) => run(runReconcile, args, o)

// ════ receipts tail ═════════════════════════════════════════════════════════════════════════════════════════════════
test('receipts tail: the logged calls, newest last, with model, tokens, price and full id; filters narrow them', async () => {
  const f = await fixture()
  const r = await receipts(['tail', '--receipts', 'receipts.jsonl'])
  assert.equal(r.code, 0, r.out + r.err)
  assert.equal(r.err, '')
  assert.match(r.out, /^tapeapi receipts tail 0\.0\.0-test \(experimental \/ 实验性\)\n {2}receipts\.jsonl {3}4 records, 4 receipts, 0 marked failed\n/)
  for (const id of f.ids) assert.ok(r.out.includes(id), `id ${id} shown in full`)
  assert.match(r.out, /OK {2}.*\/v1\/chat\/completions.*demo-mini/)
  assert.ok(r.out.includes(f.lines[0].receipt.result.prices[0].amount + ' USD'))
  assert.ok(r.out.includes('does not prove which model ran') && r.out.includes('不证明实际运行的是哪个模型'))
  assert.ok(r.out.includes('https://tapeapi.fun/verify/'))
  const ids = (out) => f.ids.filter((id) => out.includes(id))
  assert.deepEqual(ids((await receipts(['tail', '--receipts', '.', '--model', 'demo-mini'])).out), [f.ids[2]], 'a directory, one model')
  assert.deepEqual(ids((await receipts(['tail', '--receipts', 'receipts.jsonl', '-n', '2'])).out), f.ids.slice(2), 'the last two')
  assert.deepEqual(ids((await receipts(['tail', '--receipts', 'receipts.jsonl', '--service', 'Receipts test relay'])).out), f.ids, 'by the snapshot\'s name')
  assert.deepEqual(ids((await receipts(['tail', '--receipts', 'receipts.jsonl', '--service', CONTAINER.toUpperCase().replace('0X', '0x')])).out), f.ids, 'by container, any case')
  assert.deepEqual(ids((await receipts(['tail', '--receipts', 'receipts.jsonl', '--container', '0x' + '11'.repeat(20)])).out), [], 'another container')
  const ts2 = f.lines[1].receipt.ts
  assert.deepEqual(ids((await receipts(['tail', '--receipts', 'receipts.jsonl', '--since', String(ts2 + 3600)])).out), [], 'nothing signed in the future')
  assert.deepEqual(ids((await receipts(['tail', '--receipts', 'receipts.jsonl', '--until', '2000-01-01'])).out), [])
  const none = await receipts(['tail', '--receipts', 'receipts.jsonl', '--fail'])
  assert.match(none.out, /No receipt matches\./)
  // a name no snapshot has is a usage mistake: the log holds addresses only / 快照里没有的名字是用法错误
  const bad = await receipts(['tail', '--receipts', 'receipts.jsonl', '--service', 'Nobody'])
  assert.equal(bad.code, 2); assert.match(bad.err, /the log holds container addresses, not names/)
})

test('receipts tail --json: one object, nothing on stderr; --lang en has no Chinese, zh no English labels', async () => {
  const f = await fixture()
  const j = await receipts(['tail', '--receipts', 'receipts.jsonl', '--json'])
  assert.equal(j.err, '')
  const o = JSON.parse(j.out)
  assert.equal(o.command, 'receipts tail'); assert.equal(o.experimental, true); assert.equal(o.exitCode, 0)
  assert.deepEqual(o.items.map((x) => x.id), f.ids)
  assert.deepEqual(Object.keys(o.items[0]), EXPORT_COLUMNS)
  assert.equal(o.items[0].source, 'receipts.jsonl:1')
  const en = await receipts(['tail', '--receipts', 'receipts.jsonl', '--lang', 'en'])
  assert.doesNotMatch(en.out, /[一-鿿]/)
  const zh = await receipts(['tail', '--receipts', 'receipts.jsonl', '--lang', 'zh'])
  assert.match(zh.out, /4 条记录，4 张回执，0 条标记失败/); assert.match(zh.out, /签名时间/)
  assert.doesNotMatch(zh.out, /does not prove|signed at/)
})

test('receipts tail colors: only on a terminal without NO_COLOR or --no-color; removing them gives the plain text', async () => {
  await fixture()
  const plain = await receipts(['tail', '--receipts', 'receipts.jsonl'])
  const tty = await receipts(['tail', '--receipts', 'receipts.jsonl'], { isTTY: true })
  assert.match(tty.out, /\x1b\[32mOK/)
  // eslint-disable-next-line no-control-regex
  assert.equal(tty.out.replace(/\x1b\[[0-9;]*m/g, ''), plain.out)
  assert.doesNotMatch((await receipts(['tail', '--receipts', 'receipts.jsonl'], { isTTY: true, env: { NO_COLOR: '1' } })).out, /\x1b\[/)
  assert.doesNotMatch((await receipts(['tail', '--receipts', 'receipts.jsonl', '--no-color'], { isTTY: true })).out, /\x1b\[/)
})

// ════ receipts show ═════════════════════════════════════════════════════════════════════════════════════════════════
test('receipts show: the fields of one receipt and an offline replay against the snapshot next to it (exit 0); the bytes check both hashes', async () => {
  const f = await fixture()
  const id = f.ids[0], env = f.lines[0].receipt
  const r = await receipts(['show', id, '--receipts', 'receipts.jsonl'])
  assert.equal(r.code, 0, r.out + r.err)
  for (const want of ['source / 出处', 'receipts.jsonl:1', env.container, 'openai-chat  POST /v1/chat/completions', env.params.requestSha256, env.result.responseSha256, env.sig,
    'replay: VERIFIED / 离线重放：通过', 'against / 依据 manifest.json', `signer ${f.manifest.signer}`, 'signature and signer, container, method and path, price table',
    'request hash: give --request <file>', 'the time window: applied when the receipt arrives', 'taken as given']) {
    assert.ok(r.out.includes(want), `missing ${want}\n${r.out}`)
  }
  assert.match(r.out, /\n {2}logged verdict \/ 记录的结论 +OK {2}\(tapeapi-verify, /)
  // The verdict's limit sits on the lines right under it, in both languages (review B-2). / 结论的限定紧接在下一行，中英两行。
  assert.match(r.out, /\n {2}replay: VERIFIED \/ 离线重放：通过 [^\n]*\n {4}\(snapshot taken as given: whether its signer is the service's currently delegated key was not checked on chain here\)\n {4}（快照按原样采用：签名地址是否为服务当前委托的钥匙，这里未读链核对）\n/)
  for (const [lang, line] of [['en', "    (snapshot taken as given: whether its signer is the service's currently delegated key was not checked on chain here)"], ['zh', '    （快照按原样采用：签名地址是否为服务当前委托的钥匙，这里未读链核对）']]) {
    const one = (await receipts(['show', id, '--receipts', 'receipts.jsonl', '--lang', lang])).out.split('\n')
    const at = one.findIndex((l) => /^ {2}(replay: VERIFIED|离线重放：通过)/.test(l))
    assert.ok(at > 0, one.join('\n')); assert.equal(one[at + 1], line, lang)
  }
  assert.doesNotMatch(r.out, /\*\*\*/, 'the hashes, the id, the signature and the addresses a receipt carries are not redacted')
  assert.doesNotMatch(r.out, /next:/)
  const bytes = await receipts(['show', id, '--receipts', 'receipts.jsonl', '--request', 'first.request', '--response', 'first.response', '--lang', 'en'])
  assert.equal(bytes.code, 0, bytes.out)
  assert.match(bytes.out, /checked: signature and signer, container, method and path, price table, request hash, response hash, id, model, usage/)
  assert.doesNotMatch(bytes.out, /not checked: (request|response) hash/)
  // A response that is not the one received: the response hash does not match. / 不是收到的那份回答：回答哈希不符。
  const other = join(FIX.dir, 'other.response')
  writeFileSync(other, readFileSync(join(FIX.dir, 'first.response'), 'utf8').replace('hello', 'jello'))
  const wrong = await receipts(['show', id, '--receipts', 'receipts.jsonl', '--response', 'other.response', '--lang', 'en'])
  assert.equal(wrong.code, 1)
  assert.match(wrong.out, /problem: responseSha256 does not match the response that was received/)
  const j = await receipts(['show', id, '--receipts', 'receipts.jsonl', '--json'])
  const o = JSON.parse(j.out)
  assert.equal(o.exitCode, 0); assert.equal(o.items[0].replay.ok, true); assert.equal(o.items[0].receipt.sig, env.sig); assert.equal(o.next, null)
  assert.equal(o.items[0].replay.signerCheckedOnChain, false, 'the JSON says the snapshot signer was not checked on chain')
})

test('receipts show: one byte changed in a logged receipt is refused (exit 1, signed by another address)', async () => {
  await fixture()
  const d = copyFixture('tampered')
  const file = join(d, 'receipts.jsonl')
  const lines = readFileSync(file, 'utf8').split('\n')
  const env = JSON.parse(lines[0]).receipt
  const h = env.result.responseSha256
  const flipped = h.slice(0, 10) + (h[10] === 'a' ? 'b' : 'a') + h.slice(11)
  lines[0] = lines[0].replace(h, flipped)
  assert.equal(lines.join('\n').length, readFileSync(file, 'utf8').length, 'one byte, same length')
  writeFileSync(file, lines.join('\n'))
  const r = await receipts(['show', env.id, '--receipts', 'receipts.jsonl'], { cwd: d })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /replay: FAILED \/ 离线重放：未通过[^\n]*\n {4}\(snapshot taken as given/)
  assert.match(r.out, new RegExp(`signed by 0x[0-9a-fA-F]{40}, but the manifest's signer is ${FIX.manifest.signer}`))
  assert.match(lastLine(r.out), /^next: \/ 下一条命令: tapeapi receipts tail --receipts receipts\.jsonl --fail$/)
  // A changed token count: refused as well. / 改了 token 数：同样被拒。
  const lines2 = readFileSync(join(FIX.dir, 'receipts.jsonl'), 'utf8').split('\n')
  const u = JSON.parse(lines2[2]).receipt.result.usage
  lines2[2] = lines2[2].replace(`"completion_tokens":${u.completion_tokens}`, `"completion_tokens":${u.completion_tokens - 1}`).replace(`"total_tokens":${u.total_tokens}`, `"total_tokens":${u.total_tokens - 1}`)
  writeFileSync(file, lines2.join('\n'))
  const r2 = await receipts(['show', JSON.parse(lines2[2]).receipt.id, '--receipts', 'receipts.jsonl', '--lang', 'en'], { cwd: d })
  assert.equal(r2.code, 1, r2.out)
  assert.match(r2.out, /problem: signed by/)
})

test('receipts show: no manifest snapshot is exit 3 (nothing decided, nothing fetched); --manifest supplies one', async () => {
  const f = await fixture()
  const d = copyFixture('no-manifest', { manifest: false })
  const r = await receipts(['show', f.ids[1], '--receipts', 'receipts.jsonl'], { cwd: d })
  assert.equal(r.code, 3, r.out)
  assert.match(r.out, /replay: CANNOT DECIDE \/ 离线重放：无法判定/)
  assert.match(r.out, /no manifest snapshot: none was given \(--manifest\) and there is none next to the receipts/)
  assert.ok(r.out.includes(f.lines[1].receipt.result.responseSha256), 'the fields are still shown')
  assert.equal(lastLine(r.out), `next: / 下一条命令: tapeapi receipts show ${f.ids[1]} --receipts receipts.jsonl --manifest <manifest.json>`)
  const j = await receipts(['show', f.ids[1], '--receipts', 'receipts.jsonl', '--json'], { cwd: d })
  assert.equal(JSON.parse(j.out).exitCode, 3); assert.equal(JSON.parse(j.out).items[0].replay.decided, false)
  const given = await receipts(['show', f.ids[1], '--receipts', 'receipts.jsonl', '--manifest', join(FIX.dir, 'manifest.json')], { cwd: d })
  assert.equal(given.code, 0, given.out)
  // A snapshot of another container is no help either: exit 3 when several are there and none is for it.
  // 别的容器的快照也帮不上：有几份而没有这个容器的，退出 3。
  for (const n of ['a.manifest.json', 'b.manifest.json']) writeFileSync(join(d, n), JSON.stringify({ ...FIX.manifest, container: '0x' + (n[0] === 'a' ? '11' : '22').repeat(20) }))
  const others = await receipts(['show', f.ids[1], '--receipts', 'receipts.jsonl', '--lang', 'en'], { cwd: d })
  assert.equal(others.code, 3)
  assert.match(others.out, /none of the 2 manifest snapshots is for container/)
  // an id that is not in the files: exit 2 / 文件里没有的 id：退出 2
  const missing = await receipts(['show', 'chatcmpl-nope', '--receipts', 'receipts.jsonl'])
  assert.equal(missing.code, 2); assert.match(missing.err, /no receipt with id "chatcmpl-nope"/)
})

// ════ receipts export ═══════════════════════════════════════════════════════════════════════════════════════════════
test('receipts export: CSV with the stable header, JSON with the same keys, --out written mode 600, filters apply', async () => {
  const f = await fixture()
  const csv = await receipts(['export', '--receipts', 'receipts.jsonl'])
  assert.equal(csv.code, 0)
  const rows = parseCsv(csv.out)
  assert.deepEqual(rows[0].cells, ['ts', 'logged_at', 'id', 'container', 'format', 'path', 'status', 'stream', 'complete', 'model', 'prompt_tokens', 'completion_tokens', 'cache_read', 'cache_write', 'amount', 'currency', 'prices', 'ok', 'problems', 'source'])
  assert.equal(rows.length, 5)
  const r1 = Object.fromEntries(rows[0].cells.map((c, i) => [c, rows[1].cells[i]]))
  const e1 = f.lines[0].receipt
  assert.equal(r1.id, e1.id); assert.equal(r1.model, 'demo-chat'); assert.equal(r1.prompt_tokens, String(e1.result.usage.prompt_tokens)); assert.equal(r1.amount, e1.result.prices[0].amount)
  assert.equal(r1.currency, 'USD'); assert.equal(r1.ok, 'true'); assert.equal(r1.source, 'receipts.jsonl:1'); assert.equal(r1.ts, new Date(e1.ts * 1000).toISOString().replace('.000Z', 'Z'))
  const j = JSON.parse((await receipts(['export', '--receipts', 'receipts.jsonl', '--format', 'json', '--model', 'demo-mini'])).out)
  assert.deepEqual(j.columns, EXPORT_COLUMNS); assert.equal(j.items.length, 1); assert.deepEqual(Object.keys(j.items[0]), EXPORT_COLUMNS)
  assert.equal(JSON.parse((await receipts(['export', '--receipts', 'receipts.jsonl', '--json'])).out).items.length, 4)
  const out = await receipts(['export', '--receipts', 'receipts.jsonl', '--out', 'export.csv'])
  assert.equal(out.out, ''); assert.match(out.err, /4 rows written to export\.csv \(csv\)/)
  assert.equal(statSync(join(FIX.dir, 'export.csv')).mode & 0o777, 0o600)
  assert.equal(readFileSync(join(FIX.dir, 'export.csv'), 'utf8'), csv.out)
  const both = await receipts(['export', '--receipts', 'receipts.jsonl', '--csv', '--json'])
  assert.equal(both.code, 2)
})

test('receipts usage mistakes: exit 2 on stderr, nothing on stdout, last line the next command', async () => {
  await fixture()
  for (const args of [[], ['list'], ['tail'], ['tail', '--receipts', 'nope.jsonl'], ['tail', '--receipts', 'receipts.jsonl', '-n', 'x'], ['show', '--receipts', 'receipts.jsonl'],
    ['tail', '--receipts', 'receipts.jsonl', '--since', 'yesterday'], ['tail', '--receipts', 'receipts.jsonl', '--request', 'first.request'], ['export', '--receipts', 'receipts.jsonl', '--format', 'xml'],
    ['tail', '--receipts', 'receipts.jsonl', '--lang', 'fr'], ['tail', '--receipts', 'receipts.jsonl', '--bogus'], ['tail', '--receipts', 'receipts.jsonl', '--container', 'abc']]) {
    const r = await receipts(args)
    assert.equal(r.code, 2, args.join(' '))
    assert.equal(r.out, '')
    assert.equal(lastLine(r.err), 'next: / 下一条命令: tapeapi receipts --help')
  }
  const help = await receipts(['--help'])
  assert.equal(help.code, 0); assert.match(help.out, /Usage:\n {2}tapeapi receipts tail/)
})

test('receipts: a bare envelope file and lines that are not receipts are read and counted; parseTime', async () => {
  const f = await fixture()
  const d = join(TMP, 'bare'); mkdirSync(d)
  writeFileSync(join(d, 'one.json'), JSON.stringify(f.lines[3].receipt))
  writeFileSync(join(d, 'mixed.jsonl'), `${JSON.stringify(f.lines[2].receipt)}\nnot json\n{"hello":1}\n`)
  const r = await receipts(['tail', '--receipts', '.', '--lang', 'en'], { cwd: d })
  assert.equal(r.code, 0)
  assert.match(r.out, /2 records, 2 receipts, 0 marked failed, 2 lines skipped \(mixed\.jsonl:2, mixed\.jsonl:3\)/)
  assert.match(r.out, /\n {2}\S+ +-- {3}/, "a bare receipt has no logged verdict: '--'")
  assert.equal(parseTime('2026-10-01'), Date.UTC(2026, 9, 1) / 1000)
  assert.equal(parseTime('1760000000000'), 1760000000)
  assert.equal(parseTime(1760000000), 1760000000)
  assert.equal(parseTime('soon'), null)
})

// ════ reconcile ═════════════════════════════════════════════════════════════════════════════════════════════════════
const NEWAPI_HEADER = ['id', 'created_at', 'token_name', 'model_name', 'prompt_tokens', 'completion_tokens', 'quota', 'upstream_request_id']
const quotaOf = (env, scale = 500000) => String(Math.round(Number(env.result.prices[0].amount) * scale))
/** A new-api style CSV made from the fixture's receipts, then changed by `edit`. / 由夹具回执生成的 new-api 风格 CSV。 */
function newApiBill(name, edit = (rows) => rows) {
  const rows = FIX.lines.map((l, i) => {
    const e = l.receipt, u = e.result.usage
    return { id: String(100 + i), created_at: String(e.ts + 1), token_name: 'my token', model_name: e.result.model, prompt_tokens: String(u.prompt_tokens), completion_tokens: String(u.completion_tokens), quota: quotaOf(e), upstream_request_id: e.id }
  })
  const out = edit(rows)
  const cell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  writeFileSync(join(FIX.dir, name), [NEWAPI_HEADER.join(','), ...out.map((r) => NEWAPI_HEADER.map((h) => cell(r[h] ?? '')).join(','))].join('\r\n') + '\r\n')
  return name
}

test('reconcile: a bill that agrees with every receipt is exit 0 (new-api preset found in the header, amounts compared with --amount-scale)', async () => {
  await fixture()
  const bill = newApiBill('bill-ok.csv')
  const r = await reconcile(['--receipts', 'receipts.jsonl', '--bill', bill, '--amount-scale', '500000'])
  assert.equal(r.code, 0, r.out + r.err)
  assert.match(r.out, /MATCH \/ 匹配 +4/)
  assert.match(r.out, /MISSING \/ 缺失 +0/); assert.match(r.out, /MISMATCH \/ 不一致 +0/)
  assert.match(r.out, /new-api preset, found in the header/)
  assert.match(r.out, /the field names of the JSON new-api's GET \/api\/log\/self returns \(data\.items\), read in its source code, not yet checked against a real instance/)
  assert.match(r.out, /new-api's web CSV export is not that file .*: name its columns with --map/)
  assert.match(r.out, /new-api 的 GET \/api\/log\/self 返回的 JSON（data\.items）的字段名/)
  assert.match(r.out, /bill ÷ 500000 = the receipt's first currency/)
  assert.doesNotMatch(r.out, /next:/)
  const noScale = await reconcile(['--receipts', 'receipts.jsonl', '--bill', bill, '--lang', 'en'])
  assert.equal(noScale.code, 0)
  assert.match(noScale.out, /amounts +not compared: give --amount-scale/)
  assert.deepEqual(BILL_PRESETS['new-api'], { id: 'upstream_request_id', model: 'model_name', prompt: 'prompt_tokens', completion: 'completion_tokens', amount: 'quota', time: 'created_at' })
})

test('reconcile: match, missing on each side and mismatch, each with the receipt line and the bill line; exit 1; facts, no verdict', async () => {
  const f = await fixture()
  const bill = newApiBill('bill-diff.csv', (rows) => {
    rows[1].upstream_request_id = ''                                                   // joined by time, model and tokens
    rows[2].completion_tokens = String(Number(rows[2].completion_tokens) + 2)          // differs from the receipt
    rows[2].quota = String(Number(rows[2].quota) + 40)
    const extra = { ...rows[0], id: '999', created_at: String(Number(rows[0].created_at) + 86_400), upstream_request_id: 'chatcmpl-not-in-receipts' }
    return [rows[0], rows[1], rows[2], extra]                                          // the fourth receipt has no row
  })
  const r = await reconcile(['--receipts', 'receipts.jsonl', '--bill', bill, '--amount-scale', '500000'])
  assert.equal(r.code, 1, r.out + r.err)
  assert.match(r.out, /MATCH \/ 匹配 +2/)
  assert.match(r.out, /MISSING \/ 缺失 +2 +1 in the receipts with no bill row, 1 bill row with no receipt/)
  assert.match(r.out, /MISMATCH \/ 不一致 +1 +differs from what the receipt claims \/ 与回执声称不一致/)
  const e3 = f.lines[2].receipt
  assert.ok(r.out.includes(`receipt / 回执 receipts.jsonl:3`), r.out)
  assert.ok(r.out.includes(`bill / 账单 ${bill}:4`), r.out)
  assert.ok(r.out.includes(`completion_tokens: receipt / 回执 ${e3.result.usage.completion_tokens}, bill / 账单 ${e3.result.usage.completion_tokens + 2}`), r.out)
  assert.match(r.out, /amount: receipt \/ 回执 \d+\.\d{8} USD \(= [\d.]+ in bill units \/ 个账单单位\), bill \/ 账单 \d+, difference \/ 差额 [\d.]+/)
  assert.ok(r.out.includes(`receipts.jsonl:4`) && r.out.includes(f.ids[3]), 'the receipt with no row, by its line')
  assert.ok(r.out.includes(`${bill}:5`) && r.out.includes('chatcmpl-not-in-receipts'), 'the row with no receipt, by its line')
  assert.match(r.out, /decides nothing/); assert.match(r.out, /不下结论/)
  assert.equal(lastLine(r.out), `next: / 下一条命令: tapeapi receipts show ${f.ids[2]} --receipts receipts.jsonl`)
  const j = JSON.parse((await reconcile(['--receipts', 'receipts.jsonl', '--bill', bill, '--amount-scale', '500000', '--json', '--lang', 'en'])).out)
  assert.equal(j.exitCode, 1); assert.equal(j.ok, false)
  assert.deepEqual(j.counts, { match: 2, missing: { receiptsOnly: 1, billOnly: 1 }, mismatch: 1 })
  const byBasis = j.items.filter((x) => x.basis).map((x) => [x.class, x.basis, x.receipt.source, x.bill.source])
  assert.deepEqual(byBasis, [['match', 'id', 'receipts.jsonl:1', `${bill}:2`], ['mismatch', 'id', 'receipts.jsonl:3', `${bill}:4`], ['match', 'time-model-tokens', 'receipts.jsonl:2', `${bill}:3`]])
  const mm = j.items.find((x) => x.class === 'mismatch')
  assert.deepEqual(mm.differences.map((d) => d.field), ['completion_tokens', 'amount'])
  assert.equal(j.bill.presetUnverified, true); assert.equal(j.amounts.compared, true)
  assert.match(j.notes.facts, /decides nothing/)
  // A tolerance covers the token difference; the amount still differs. / 容差覆盖 token 差异；金额仍不同。
  const tol = JSON.parse((await reconcile(['--receipts', 'receipts.jsonl', '--bill', bill, '--json', '--tolerance-tokens', '2', '--amount-scale', '500000'])).out)
  assert.deepEqual(tol.items.find((x) => x.class === 'mismatch').differences.map((d) => d.field), ['amount'])
})

test('reconcile: another format with --map (a JSON bill), aliases count as the same model with a snapshot, --since bounds both sides', async () => {
  const f = await fixture()
  const rows = f.lines.map((l) => ({ req: '', at: new Date(l.receipt.ts * 1000).toISOString(), m: l.receipt.result.model === 'demo-chat' ? 'demo-chat-latest' : l.receipt.result.model,
    in: l.receipt.result.usage.prompt_tokens, out: l.receipt.result.usage.completion_tokens, cost: l.receipt.result.prices[0].amount }))
  writeFileSync(join(FIX.dir, 'bill.json'), JSON.stringify({ data: rows }))
  const map = ['--map', 'id=req,time=at,model=m,prompt=in,completion=out,amount=cost']
  const r = await reconcile(['--receipts', 'receipts.jsonl', '--bill', 'bill.json', ...map, '--amount-scale', '1', '--lang', 'en'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /MATCH +4/)
  assert.match(r.out, /columns +id=req, time=at, model=m, prompt=in, completion=out, amount=cost\n/)
  // without the snapshot the alias is another name: those rows find no receipt / 没有快照时别名是另一个名字
  const d = copyFixture('no-snapshot-reconcile', { manifest: false })
  copyFileSync(join(FIX.dir, 'bill.json'), join(d, 'bill.json'))
  const alias = JSON.parse((await reconcile(['--receipts', 'receipts.jsonl', '--bill', 'bill.json', ...map, '--json'], { cwd: d })).out)
  assert.equal(alias.exitCode, 1)
  assert.deepEqual(alias.counts, { match: 1, missing: { receiptsOnly: 3, billOnly: 3 }, mismatch: 0 })
  const since = JSON.parse((await reconcile(['--receipts', 'receipts.jsonl', '--bill', 'bill.json', ...map, '--json', '--since', String(f.lines[3].receipt.ts)])).out)
  const later = f.lines.filter((l) => l.receipt.ts >= f.lines[3].receipt.ts).length   // calls in the same second count too
  assert.equal(since.bill.rows, later); assert.equal(since.counts.match, later); assert.equal(since.exitCode, 0)
  const none = JSON.parse((await reconcile(['--receipts', 'receipts.jsonl', '--bill', 'bill.json', ...map, '--json', '--since', String(f.lines[3].receipt.ts + 3600)])).out)
  assert.equal(none.exitCode, 3, 'nothing left on either side: nothing to compare')
})

test('reconcile usage mistakes are exit 2 (no --bill, a column the bill lacks, no column names); nothing to compare is exit 3', async () => {
  await fixture()
  writeFileSync(join(FIX.dir, 'odd.csv'), 'when,what,n\n1,2,3\n')
  for (const [args, why] of [
    [['--receipts', 'receipts.jsonl'], /--bill <file> is needed/],
    [['--bill', 'odd.csv'], /--receipts <file\|dir> is needed/],
    [['--receipts', 'receipts.jsonl', '--bill', 'odd.csv'], /name the bill's columns: --map model=<column>.*Its header: when, what, n/],
    [['--receipts', 'receipts.jsonl', '--bill', 'odd.csv', '--map', 'model=what,prompt=n,completion=nope,time=when'], /the bill has no column completion=nope/],
    [['--receipts', 'receipts.jsonl', '--bill', 'odd.csv', '--map', 'model=what,prompt=n,completion=n'], /must name id or time/],
    [['--receipts', 'receipts.jsonl', '--bill', 'odd.csv', '--map', 'colour=what'], /--map takes <key>=<column> pairs/],
    [['--receipts', 'receipts.jsonl', '--bill', 'odd.csv', '--preset', 'one-api'], /--preset must be one of new-api/],
    [['--receipts', 'receipts.jsonl', '--bill', 'missing.csv', '--preset', 'new-api'], /cannot read the bill missing\.csv/],
    [['--receipts', 'receipts.jsonl', '--bill', 'odd.csv', '--tolerance-amount', '1', '--map', 'model=what,prompt=n,completion=n,time=when'], /--tolerance-amount applies with --amount-scale only/],
    [['--receipts', 'receipts.jsonl', '--bill', 'odd.csv', '--window', '-5'], /--window must be a number/],
  ]) {
    const r = await reconcile(args)
    assert.equal(r.code, 2, args.join(' '))
    assert.equal(r.out, '')
    assert.match(r.err, why)
    assert.equal(lastLine(r.err), 'next: / 下一条命令: tapeapi reconcile --help')
  }
  const d = join(TMP, 'empty'); mkdirSync(d)
  writeFileSync(join(d, 'receipts.jsonl'), '')
  writeFileSync(join(d, 'bill.csv'), NEWAPI_HEADER.join(',') + '\n')
  const r = await reconcile(['--receipts', 'receipts.jsonl', '--bill', 'bill.csv'], { cwd: d })
  assert.equal(r.code, 3, r.out)
  assert.equal(lastLine(r.out), 'next: / 下一条命令: tapeapi receipts tail --receipts receipts.jsonl')
  assert.equal((await reconcile(['--help'])).code, 0)
})

// new-api's web CSV export (web/src/features/usage-logs/lib/export.ts) has display headers, not the /api/log/self field
// names: the preset never matches it, and it fails safe (exit 2, the header shown, --map asked for), never a silent join.
// new-api 网页端的 CSV 导出是显示标题，不是 /api/log/self 的字段名：预设对它匹配不上，安全失败（退出 2，列出表头，要求 --map）。
test('reconcile: new-api\'s web CSV export (localized headers, formatted Cost, request_id) is not the preset: exit 2 asking for --map', async () => {
  await fixture()
  writeFileSync(join(FIX.dir, 'web-export.csv'), 'Time,Type,Token,Group,Model,Stream,Input Tokens,Output Tokens,Cache Read,Cache Write,Cost,Duration,IP,Request ID,Details\n' +
    '2026-10-15 10:00:00,Consume,my token,default,chat-model,false,10,20,0,0,$0.000034,1.2s,127.0.0.1,abc,\n')
  const given = await reconcile(['--receipts', 'receipts.jsonl', '--bill', 'web-export.csv', '--preset', 'new-api'])
  assert.equal(given.code, 2, given.out + given.err)
  assert.match(given.err, /the bill has no column model=model_name, prompt=prompt_tokens, completion=completion_tokens, time=created_at; its header: Time, Type, Token/)
  const found = await reconcile(['--receipts', 'receipts.jsonl', '--bill', 'web-export.csv'])
  assert.equal(found.code, 2, found.out + found.err)
  assert.match(found.err, /name the bill's columns: --map model=<column>/)
  const help = await reconcile(['--help'])
  assert.match(help.out, /the field names of the JSON new-api's GET \/api\/log\/self returns \(data\.items\)/)
  assert.match(help.out, /new-api's web CSV export has other headers\s+\(localized; Cost formatted, not a comparable amount; request_id\): name them with --map/)
  assert.doesNotMatch(help.out, /real export/)
  assert.match(help.out, /\(also --relay-export <file>\)/, 'the alias of --bill is listed (review B-7)')
})

test('reconcile --lang: en has no Chinese, zh has no English labels', async () => {
  await fixture()
  const bill = newApiBill('bill-lang.csv', (rows) => rows.slice(1))
  const en = await reconcile(['--receipts', 'receipts.jsonl', '--bill', bill, '--lang', 'en'])
  assert.equal(en.code, 1)
  assert.doesNotMatch(en.out, /[一-鿿]/)
  assert.match(lastLine(en.out), /^next: tapeapi receipts show /)
  const zh = await reconcile(['--receipts', 'receipts.jsonl', '--bill', bill, '--lang', 'zh'])
  assert.match(zh.out, /缺失：有回执，账单里没有对应行/); assert.match(zh.out, /^ {2}匹配 +3/m)
  assert.doesNotMatch(zh.out, /MISSING|MATCH|receipts claiming/)
  assert.match(lastLine(zh.out), /^下一条命令: tapeapi receipts show /)
})

// ════ Redaction, network, wording, the dispatcher ═══════════════════════════════════════════════════════════════════
test('redaction: key shapes and secret environment values in a bill or a receipt file are ***; the hashes, ids and addresses of receipts are not', async () => {
  const f = await fixture()
  const SENTINEL = 'sk-SENTINEL-0123456789abcdef', PK = '0x' + '5a'.repeat(31) + '7c', HEX = 'c0ffee'.repeat(6)
  const bill = newApiBill('bill-secret.csv', (rows) => [...rows, { ...rows[0], id: '7', created_at: '1', model_name: `m ${SENTINEL} ${PK} ${HEX}`, upstream_request_id: `Bearer ${'tOk3n'.repeat(5)}` }])
  const env = { SIGNER_KEY: SENTINEL, PATH: '/usr/bin' }
  for (const extra of [[], ['--json']]) {
    const r = await reconcile(['--receipts', 'receipts.jsonl', '--bill', bill, ...extra], { env })
    assert.equal(r.code, 1)
    for (const v of [SENTINEL, PK, HEX, 'tOk3n'.repeat(5)]) assert.ok(!r.out.includes(v), `${v} is redacted (${extra.join(' ') || 'text'})`)
    assert.ok(r.out.includes('***'))
  }
  const show = await receipts(['show', f.ids[0], '--receipts', 'receipts.jsonl'], { env })
  for (const v of [f.lines[0].receipt.params.requestSha256, f.lines[0].receipt.result.responseSha256, f.ids[0], f.lines[0].receipt.container, f.lines[0].receipt.sig]) assert.ok(show.out.includes(v), `${v} stays`)
  // The rule itself: what a receipt carries stays; a hash-shaped run elsewhere and a token in an id go.
  // 规则本身：回执带的值保留；其它地方的哈希形串与 id 里的令牌照样脱敏。
  const h = 'ab'.repeat(32)
  assert.equal(redactKeeping(`x ${h} y`, [h], {}), `x ${h} y`)
  assert.equal(redactKeeping(`x ${h} y`, [], {}), 'x *** y')
  assert.equal(redactKeeping(`id ${SENTINEL}`, [SENTINEL], {}), 'id ***')
  assert.equal(redactKeeping(`k ${h}`, [h], { SIGNER_KEY: h }), 'k ***', 'a value this machine holds as a secret goes, whatever the receipt says')
})

test('receipts and reconcile make no network request and import no network module', async () => {
  await fixture()
  assert.equal(fetches, 0, 'fetch was never called during any run above')
  for (const p of ['../src/receipts-cli.js', '../src/reconcile-cli.js']) {
    const src = readFileSync(new URL(p, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /from 'node:(http|https|net|dns|tls|dgram|child_process)'|\bfetch\(|XMLHttpRequest|WebSocket/, p)
  }
})

test('the dispatcher runs receipts and reconcile; an unknown subcommand is exit 2 with a next line', async () => {
  const f = await fixture()
  const spawnRun = (args) => new Promise((ok) => {
    const c = spawn(process.execPath, [BIN, ...args], { cwd: f.dir, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    c.stdout.on('data', (d) => { out += d }); c.stderr.on('data', (d) => { err += d })
    c.once('exit', (code) => ok({ code, out, err }))
  })
  const t = await spawnRun(['receipts', 'tail', '--receipts', 'receipts.jsonl', '--lang', 'en'])
  assert.equal(t.code, 0, t.err)
  assert.match(t.out, /^tapeapi receipts tail \d+\.\d+\.\d+ \(experimental\)\n/)
  const s = await spawnRun(['receipts', 'show', f.ids[0], '--receipts', 'receipts.jsonl', '--json'])
  assert.equal(s.code, 0); assert.equal(JSON.parse(s.out).items[0].replay.ok, true)
  const u = await spawnRun(['receipts', 'frob'])
  assert.equal(u.code, 2); assert.equal(u.out, ''); assert.match(lastLine(u.err), /^next: \/ 下一条命令: node \S*tapeapi\.js receipts --help$/)
  const rc = await spawnRun(['reconcile', '--receipts', 'receipts.jsonl', '--bill', newApiBill('bill-spawn.csv')])
  assert.equal(rc.code, 0, rc.out + rc.err)
})

const FORBIDDEN = /认证|合作伙伴|推荐|支持 ?Claude Code|欺诈|作弊|诈骗|骗|certified|partner|recommend|supports Claude Code|fraud|cheat|scam|dishonest|\bfake\b|\blie[sd]?\b/i
test('wording: no output and no source line says fraud or cheating (只写“与回执声称不一致”), certified, partner or recommended', async () => {
  assert.ok(seen.length > 40)
  for (const text of seen) assert.doesNotMatch(text, FORBIDDEN)
  for (const p of ['../src/receipts-cli.js', '../src/reconcile-cli.js']) assert.doesNotMatch(readFileSync(new URL(p, import.meta.url), 'utf8'), FORBIDDEN, p)
})
