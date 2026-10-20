// tapeapi (sdk/bin/tapeapi.js, experimental): `tapeapi doctor|verify|mcp` run the existing bins as child processes, so
// their stdout, stderr and exit status are byte for byte those of tapeapi-doctor / tapeapi-verify / tapeapi-mcp, with
// the same arguments; signals reach the child; the dispatcher writes nothing itself. Only 127.0.0.1, no chain.
// tapeapi（实验性）：doctor|verify|mcp 以子进程运行现有命令，输出与退出码逐字节相同；信号转给子进程；分发器自己不写任何字节。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAIProxy } from '../../server/src/ai-proxy.js'
import { createProvider } from '../../server/src/index.js'
import { createMcpProxy } from '../../server/src/mcp-proxy.js'
import { TOOLS as DEMO_TOOLS, startDemoServer } from '../../examples/mcp-proxy/demo-server.mjs'
import * as MCP from '../src/mcp.js'
import { privateKeyToAddress } from '../src/sig.js'
import { createFakeUpstream } from '../../examples/ai-proxy/fake-upstream.mjs'
import { sig as SIG, MAINNET, createTapeAPI } from '../src/index.js'
import * as AI from '../src/ai.js'
import { CHAINS } from '../src/chains.js'
import { runConnect } from '../src/connect-cli.js'
import { createConformChain } from './helpers/conform-chain.mjs'

const BIN = fileURLToPath(new URL('../bin/tapeapi.js', import.meta.url))
const ORIGINAL = { doctor: 'tapeapi-doctor.js', verify: 'tapeapi-verify.js', mcp: 'tapeapi-mcp.js' }
const binOf = (name) => fileURLToPath(new URL(`../bin/${name}`, import.meta.url))
const KEY = '0x' + '42'.repeat(32)
const TMP = mkdtempSync(join(tmpdir(), 'tapeapi-cli-test-'))
const closers = []
test.after(async () => { for (const c of closers.reverse()) await c(); rmSync(TMP, { recursive: true, force: true }) })

/**
 * Run node with `args`; `until(stderr)` (optional) is awaited on stderr, then `then(child)` runs (e.g. a signal); stdin
 * gets `input` lines, each sent once the previous reply line is on stdout. Resolves to raw stdout / stderr bytes and the exit.
 * 运行 node；可等待 stderr 出现某行后做某事（如发信号）；stdin 逐行写入 input，每行等上一行的回复到达 stdout 后再写。
 */
function run(args, { until = null, then = null, input = null, env = process.env } = {}) {
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], env })
    closers.push(() => new Promise((r) => { if (child.exitCode !== null || child.signalCode !== null) return r(); child.once('exit', r); child.kill('SIGKILL') }))
    const out = [], err = []
    let errText = '', outLines = 0, fired = false
    const pending = input ? [...input] : null
    const feed = () => { if (!pending) return; if (pending.length) child.stdin.write(pending.shift() + '\n'); else child.stdin.end() }
    child.stdout.on('data', (d) => {
      out.push(d)
      const n = Buffer.concat(out).toString('utf8').split('\n').length - 1
      if (n > outLines) { outLines = n; feed() }
    })
    child.stderr.on('data', (d) => {
      err.push(d); errText += d
      if (until && !fired && until(errText)) { fired = true; then?.(child) }
    })
    if (pending) feed(); else child.stdin.end()
    const t = setTimeout(() => { child.kill('SIGKILL'); fail(new Error(`timed out: ${args.join(' ')}\n${errText}`)) }, 30_000)
    child.once('exit', (code, signal) => { clearTimeout(t); ok({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), code, signal }) })
  })
}
const same = (a, b, what) => {
  assert.equal(a.code, b.code, `${what}: exit status`)
  assert.equal(a.signal, b.signal, `${what}: signal`)
  assert.ok(a.stdout.equals(b.stdout), `${what}: stdout differs\n--- tapeapi\n${a.stdout}\n--- original\n${b.stdout}`)
  assert.ok(a.stderr.equals(b.stderr), `${what}: stderr differs\n--- tapeapi\n${a.stderr}\n--- original\n${b.stderr}`)
}

// The signing sidecar over the fake upstream, on a real port (as in tapeapi-verify.test.mjs). / 真实端口上的签名旁路。
async function startSidecar() {
  const fake = createFakeUpstream({ keys: ['sk-demo'] })
  let proxy
  const srv = http.createServer(async (req, res) => {
    const parts = []
    for await (const c of req) parts.push(c)
    const r = await proxy.handleRequest(new Request(new URL(req.url, 'http://127.0.0.1'), { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(parts) }), { clientIp: '127.0.0.1' })
    res.writeHead(r.status, Object.fromEntries(r.headers))
    res.end(r.body ? Buffer.from(await r.arrayBuffer()) : undefined)
  })
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
  const url = `http://127.0.0.1:${srv.address().port}`
  proxy = createAIProxy({
    upstream: { baseUrl: 'http://fake.local/v1' }, fetch: (u, init) => fake.fetch(u, init), signerKey: KEY, allowHttp: true, rateLimit: false, log: () => {},
    models: [{ id: 'demo-chat', formats: ['openai-chat'], prices: [{ currency: 'USD', unit: '1M tokens', input: '0.5', output: '1.5' }] }],
    formats: AI.FORMATS.filter((f) => f.name === 'openai-chat'),
    manifestBase: { name: 'CLI test', circuits: '0x0000000000000000000000000000000000000000', tokenId: '0', container: '0x0000000000000000000000000000000000000000', delegation: null, dev: true, endpoints: { live: [`${url}/tapeapi/v1`], async: false } },
  })
  closers.push(() => new Promise((ok) => { srv.closeAllConnections(); srv.close(ok) }))
  return url
}
const freePort = () => new Promise((ok) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) }) })

test('tapeapi doctor|verify|mcp: --help, --version and a usage mistake are byte for byte the original command\'s', async () => {
  for (const [sub, file] of Object.entries(ORIGINAL)) {
    for (const args of [['--help'], ['--version'], ['--no-such-option'], []]) {
      if (sub === 'mcp' && !args.length) continue   // no target: still a usage mistake, covered by --no-such-option
      same(await run([BIN, sub, ...args]), await run([binOf(file), ...args]), `${sub} ${args.join(' ')}`)
    }
  }
})

test('tapeapi doctor: a real check (--offline, --json and the text report) is byte for byte tapeapi-doctor\'s', async () => {
  // Nothing listens on this port: the whole report is deterministic, compared as it is. / 端口无人监听：整份报告确定，原样比较。
  const dead = `http://127.0.0.1:${await freePort()}`
  for (const extra of [['--json'], []]) same(await run([BIN, 'doctor', '--offline', dead, ...extra]), await run([binOf(ORIGINAL.doctor), '--offline', dead, ...extra]), `doctor --offline (nothing there) ${extra.join(' ')}`)
  // A live sidecar: each run gets an answer with a receipt id the sidecar draws at random (tapeapi-<24 hex>), the only
  // bytes that differ between two runs of the same command; they are set to one value before comparing.
  // 运行中的旁路：每次运行得到的回答带旁路随机生成的回执 id（tapeapi-<24 位十六进制>），这是同一命令两次运行之间唯一不同的字节；比较前统一替换。
  const url = await startSidecar()
  const fix = (r) => ({ ...r, stdout: Buffer.from(r.stdout.toString('utf8').replace(/tapeapi-[0-9a-f]{24}/g, 'tapeapi-<id>')) })
  for (const extra of [['--json'], ['--lang', 'zh'], []]) {
    const a = await run([BIN, 'doctor', '--offline', url, ...extra]), b = await run([binOf(ORIGINAL.doctor), '--offline', url, ...extra])
    same(fix(a), fix(b), `doctor --offline ${extra.join(' ')}`)
    assert.ok([0, 1].includes(a.code), a.stderr.toString())
  }
})

test('tapeapi verify: the proxy run is byte for byte tapeapi-verify\'s, and a SIGTERM to tapeapi reaches it (it prints its totals and exits 0)', async () => {
  const url = await startSidecar()
  const port = await freePort(), logFile = join(TMP, 'verify.jsonl')
  const listening = (t) => /ANTHROPIC_BASE_URL=/.test(t)
  const kill = (c) => setTimeout(() => c.kill('SIGTERM'), 300)   // its handler is set right after that line / 处理函数在那一行之后才设置
  const a = await run([BIN, 'verify', '--dev', url, '--port', String(port), '--log', logFile], { until: listening, then: kill })
  const b = await run([binOf(ORIGINAL.verify), '--dev', url, '--port', String(port), '--log', logFile], { until: listening, then: kill })
  same(a, b, 'verify --dev')
  assert.equal(a.code, 0)
  assert.match(a.stderr.toString(), /SIGTERM: 0 verified, 0 failed/)
})

test('tapeapi mcp: stdin passes through and stdout carries the same JSON-RPC lines only', async () => {
  const signerKey = '0x' + '5a'.repeat(32)
  const manifest = { tapeapi: '0.1', name: 'Local Test', circuits: '0x' + '7e'.repeat(20), tokenId: '9', container: '0x' + '7c'.repeat(20), signer: privateKeyToAddress(signerKey), endpoints: { live: ['http://127.0.0.1:1/tapeapi/v1'], async: false }, methods: [{ name: 'echo', priceBEM: '0', params: { text: 'string' }, returns: { echo: 'object' } }], payment: { escrow: '0x' + '00'.repeat(20) }, dev: true }
  const provider = createProvider({ manifest, signerKey, dev: true, rateLimit: false, methods: { echo: async (p) => ({ echo: p }) }, log: () => {} })
  const srv = await provider.listen(0)
  closers.push(() => provider.close?.())
  const url = `http://127.0.0.1:${srv.address().port}`
  manifest.endpoints.live = [`${url}/tapeapi/v1`]
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  ]
  const a = await run([BIN, 'mcp', '--dev', url, '--no-pin'], { input: [...input] })
  const b = await run([binOf(ORIGINAL.mcp), '--dev', url, '--no-pin'], { input: [...input] })
  assert.equal(a.code, b.code)
  assert.ok(a.stdout.equals(b.stdout), `stdout differs\n${a.stdout}\n---\n${b.stdout}`)
  const lines = a.stdout.toString('utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 2)
  for (const l of lines) assert.equal(JSON.parse(l).jsonrpc, '2.0')
  assert.ok(JSON.parse(lines[1]).result.tools.length >= 1)
})

test('tapeapi with no command or an unknown one: exit 2, nothing on stdout, the last line names the next command', async () => {
  for (const args of [[], ['frobnicate']]) {
    const r = await run([BIN, ...args])
    assert.equal(r.code, 2)
    assert.equal(r.stdout.length, 0)
    const last = r.stderr.toString().trimEnd().split('\n').pop()
    assert.match(last, /^next: \/ 下一条命令: node \S*tapeapi\.js --help$/)
  }
  const h = await run([BIN, '--help'])
  assert.equal(h.code, 0)
  assert.match(h.stdout.toString(), /experimental/)
  assert.equal(readFileSync(BIN, 'utf8').startsWith('#!/usr/bin/env node\n'), true)
})

// ════ tapeapi connect ═══════════════════════════════════════════════════════════════════════════════════════════════
// In process against the SDK's TAP-10 test chain (createConformChain, as the new-api chain demo uses it): circuit #42 of
// processor 7 (42.7.tape), its container opened and activated, a manifest made by the reference sidecar code with the
// formats a test chooses, published as the container's file. Its endpoints (https://api.example.com) are never contacted:
// connect reads the chain and the manifest only. / 进程内，对 SDK 的 TAP-10 测试链；端点从不访问：connect 只读链与清单。
const NAME = '42.7.tape'
const RPC_ARGS = ['--rpc', 'http://rpc1,http://rpc2,http://rpc3']
const ALL_MODELS = [
  { id: 'chat-model', aliases: ['chat-alias'], formats: ['openai-chat'], prices: [{ currency: 'USD', unit: '1M tokens', input: '0.56', output: '1.68', cacheRead: '0.07' }] },
  { id: 'claude-model', formats: ['anthropic-messages'], prices: [{ currency: 'USD', unit: '1M tokens', input: '3', output: '15' }] },
  { id: 'codex-model', formats: ['openai-responses'], prices: [{ currency: 'USD', unit: '1M tokens', input: '1.25', output: '10' }] },
  { id: 'embed-model', formats: ['openai-embeddings'], prices: [{ currency: 'USD', unit: '1M tokens', input: '0.02', output: '0' }] },
]
function world({ formats = ['openai-chat'], name = 'Example relay', extraModels = [] } = {}) {
  const holderKey = SIG.randomPrivateKey(), signerKey = SIG.randomPrivateKey()
  // Root cause of the flaky "89 days vs 90 days" (review T-1): renderConnect reads Date.now() itself, so with expires a
  // whole number of days ahead, two runs a second apart could floor to different day counts. Half a day more keeps the
  // count at 90 for any run inside the next 12 hours. / 偶发根因：renderConnect 自己读 Date.now()，expires 恰好整天时，
  // 相隔一秒的两次运行会向下取整到不同天数；多加半天，12 小时内任何一次运行都是 90 天。
  const now = Math.floor(Date.now() / 1000), expires = now + 90 * 86_400 + 43_200
  const chain = createConformChain()
  chain.state.headTime = now
  const c = chain.circuit(42, { holder: SIG.privateKeyToAddress(holderKey) })
  chain.setAccount('42', c.container); chain.setCode(c.container)
  const delegationSig = SIG.signDigest(SIG.delegationDigest(56, MAINNET.hub, { container: c.container, signer: SIG.privateKeyToAddress(signerKey), expires }), holderKey)
  const proxy = createAIProxy({
    upstream: { baseUrl: 'https://upstream.example/v1' }, signerKey, log: () => {}, rateLimit: false, formats: AI.FORMATS.filter((f) => formats.includes(f.name)),
    models: [...ALL_MODELS.filter((m) => formats.includes(m.formats[0])), ...extraModels],
    manifestBase: { name, circuits: c.circuits, tokenId: '42', container: c.container, delegation: { expires, sig: delegationSig }, endpoints: { live: ['https://api.example.com/tapeapi/v1'], async: false } },
  })
  chain.writeFile(c.container, '.well-known/tapeapi.json', JSON.stringify(proxy.manifest()))
  return { chain, c, now, expires, apiOptions: { clock: () => now, quiet: true, onWarning: () => {}, fetch: (u, init) => chain.fetch(String(u), init) } }
}
/** runConnect in process; resolves to { code, out, err, child }. / 进程内运行 connect。 */
async function connect(w, args, { env = {}, isTTY = false, runChild = null } = {}) {
  let out = '', err = ''
  const calls = []
  const r = await runConnect(args, { cmd: 'tapeapi', version: '0.0.0-test', verifyBin: '/x/tapeapi-verify.js', env, isTTY, apiOptions: w?.apiOptions ?? {}, stdout: (s) => { out += s }, stderr: (s) => { err += s }, runChild: runChild ?? (async (file, a) => { calls.push([file, a]); return { code: 0, signal: null } }) })
  return { code: r.exitCode ?? r.child?.code, out, err, calls, child: r.child }
}
const lastLine = (s) => s.trimEnd().split('\n').pop()
const NEXT = /^(next: \/ 下一条命令:|next:|下一条命令:) \S/
// Every exit other than 0 ends with the next command, on stdout or stderr. / 每个非 0 退出都以下一条命令结尾。
const assertNext = (r) => {
  if (r.code === 0) return
  if (r.out.startsWith('{')) { const n = JSON.parse(r.out).next; assert.ok(typeof n === 'string' && n.length, `--json exit ${r.code} without next`); return }
  assert.match(lastLine(r.out + r.err), NEXT, `exit ${r.code} without a next line:\n${r.out}${r.err}`)
}
const FORBIDDEN = /认证|合作伙伴|推荐|支持 ?Claude Code|certified|partner|recommend|supports Claude Code/i
const seen = []   // every connect output, for the wording check at the end / 收集全部输出，最后做措辞检查
const keep = (r) => { seen.push(r.out, r.err); assertNext(r); return r }

test('connect: a service that declares openai-chat only gets the OpenAI SDK, proxy and curl settings, and nothing for Claude Code or Codex', async () => {
  const w = world()
  const r = keep(await connect(w, [NAME, ...RPC_ARGS]))
  assert.equal(r.code, 0, r.out + r.err)
  assert.equal(r.err, '')
  for (const want of ['"Example relay"', NAME, 'BNB Smart Chain', w.c.container, 'openai-chat -> https://api.example.com/v1', 'chat-model', 'in 0.56  out 1.68  cacheRead 0.07', 'chat-alias',
    "ai.createVerifyingFetch({ api, service })", "baseURL: 'https://api.example.com/v1'", 'OPENAI_BASE_URL=http://127.0.0.1:8790/v1', 'tapeapi connect 42.7.tape --proxy', 'curl -sS', '$API_KEY',
    "this service's manifest declares openai-chat only", AI_NOTE_RECEIPT, 'does not prove which model ran', '不证明实际运行的是哪个模型', 'USD is for display only', '仅作展示', 'asks for no key or password', 'resolution: TAP-10 / TAP-11']) {
    assert.ok(r.out.includes(want), `missing ${want}\n${r.out}`)
  }
  assert.doesNotMatch(r.out, /claude|codex|ANTHROPIC_BASE_URL|wire_api|anthropic-messages|openai-responses/i)
  assert.doesNotMatch(r.out, /--no-conform/)
  assert.doesNotMatch(r.out, /next:/)
  // No secret in the environment and none in the manifest: nothing is redacted (FIXED C-1, the other direction).
  // 环境与清单里都没有机密：什么都不替换。
  assert.doesNotMatch(r.out, /\*\*\*/)
  const j = keep(await connect(w, [NAME, ...RPC_ARGS, '--json']))
  assert.doesNotMatch(j.out, /\*\*\*/)
})
const AI_NOTE_RECEIPT = 'A receipt proves who signed which request and response bytes'

test('connect: four declared formats give Claude Code, Codex, embeddings and chat settings, in manifest order; --tool and --format narrow them', async () => {
  const w = world({ formats: ['openai-chat', 'openai-responses', 'anthropic-messages', 'openai-embeddings'] })
  const r = keep(await connect(w, [NAME, ...RPC_ARGS, '--lang', 'en']))
  assert.equal(r.code, 0, r.out)
  for (const want of ['ANTHROPIC_BASE_URL=http://127.0.0.1:8790 ANTHROPIC_AUTH_TOKEN="$API_KEY" claude', 'ANTHROPIC_BASE_URL=https://api.example.com ANTHROPIC_AUTH_TOKEN="$API_KEY" claude', 'wire_api = "responses"', 'base_url = "http://127.0.0.1:8790/v1"', 'client.embeddings.create', "model: 'embed-model'"]) assert.ok(r.out.includes(want), want)
  const codex = keep(await connect(w, [NAME, ...RPC_ARGS, '--tool', 'codex', '--port', '9001', '--proxy'], {}))
  assert.equal(codex.code, 0)
  assert.doesNotMatch(codex.out.split('configure your client')[1], /claude|OpenAI SDK|curl/i)
  assert.match(codex.out, /tapeapi connect 42\.7\.tape --proxy --port 9001\n/)
  const emb = keep(await connect(w, [NAME, ...RPC_ARGS, '--format', 'openai-embeddings', '--json']))
  assert.deepEqual(JSON.parse(emb.out).snippets.map((s) => [s.tool, s.format]), [['openai-sdk', 'openai-embeddings']])
})

test('connect: --tool or --format naming a format the manifest does not declare is exit 2, with the reason and a next line', async () => {
  const w = world()
  for (const [args, need] of [[['--tool', 'codex'], 'openai-responses'], [['--tool', 'claude-code'], 'anthropic-messages'], [['--format', 'openai-embeddings'], 'openai-embeddings']]) {
    const r = keep(await connect(w, [NAME, ...RPC_ARGS, ...args]))
    assert.equal(r.code, 2)
    assert.match(r.out, new RegExp(`does not declare ${need}, so no .* settings are generated`))
    assert.match(r.out, new RegExp(`没有声明 ${need}`))
    assert.match(lastLine(r.out), /^next: \/ 下一条命令: tapeapi connect 42\.7\.tape$/)
    assert.doesNotMatch(r.out, /configure your client/)
  }
})

test('connect: unpaid, not-opened and store-changed are shown as unavailable with the reason (exit 1, no settings, a next line), and --proxy starts nothing', async () => {
  const cases = [
    ['unpaid', (w) => w.chain.setUnactivated(), /not activated, or its payment ran out \(TAP-10 §6\.3\)/, /名字未激活或付费已到期/],
    ['not-opened', (w) => w.chain.setOpened(w.c.circuits, 42, false), /container has not been opened \(TAP-10 §6\.2\)/, /容器尚未开通/],
    ['store-changed', (w) => w.chain.setImplementation(CHAINS[56].siteRegistry, '0x' + 'ab'.repeat(20)), /runs an implementation this SDK does not accept \(TAP-10 §6\.1\)/, /本 SDK 不接受的实现/],
  ]
  for (const [status, apply, en, zh] of cases) {
    const w = world()
    apply(w)
    const r = keep(await connect(w, [NAME, ...RPC_ARGS, '--proxy']))
    assert.equal(r.code, 1, `${status}\n${r.out}`)
    assert.ok(r.out.includes(`UNAVAILABLE: ${status} — `), r.out)
    assert.ok(r.out.includes(`不可用：${status} —— `), r.out)
    assert.match(r.out, en); assert.match(r.out, zh)
    assert.match(r.out, /not generated: the service cannot be used/)
    assert.doesNotMatch(r.out, /configure your client|createVerifyingFetch|OPENAI_BASE_URL/)
    assert.equal(lastLine(r.out), 'next: / 下一条命令: tapeapi doctor 42.7.tape')
    assert.equal(r.calls.length, 0, 'tapeapi-verify is not started')
    const j = keep(await connect(w, [NAME, ...RPC_ARGS, '--json']))
    const o = JSON.parse(j.out)
    assert.equal(o.exitCode, 1); assert.equal(o.status, status); assert.deepEqual(o.snippets, []); assert.equal(o.next, 'tapeapi doctor 42.7.tape')
    if (status !== 'store-changed') assert.equal(o.service.container, w.c.container)
  }
})

test('connect: nodes of another chain (wrong-chain) are exit 2 with the reason shown; a container address resolves like the name', async () => {
  const w = world()
  for (const u of ['http://rpc1', 'http://rpc2', 'http://rpc3']) w.chain.setChainIdAnswer(u, 1)
  const r = keep(await connect(w, [NAME, ...RPC_ARGS]))
  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /wrong-chain/)
  assert.doesNotMatch(r.out, /Without --tool/)
  assert.equal(lastLine(r.out), 'next: / 下一条命令: tapeapi connect --help')
  const ok = world()
  const byContainer = keep(await connect(ok, [ok.c.container, ...RPC_ARGS, '--lang', 'en']))
  assert.equal(byContainer.code, 0, byContainer.out)
  assert.match(byContainer.out, /openai-chat -> https:\/\/api\.example\.com\/v1/)
})

test('connect: an RPC outage is exit 3 (nothing decided) and the next line repeats the command', async () => {
  const w = world()
  w.apiOptions.fetch = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }
  const r = keep(await connect(w, [NAME, ...RPC_ARGS]))
  assert.equal(r.code, 3)
  assert.match(r.out, /COULD NOT BE READ: unavailable/)
  assert.equal(lastLine(r.out), 'next: / 下一条命令: tapeapi connect 42.7.tape --rpc http://rpc1,http://rpc2,http://rpc3')
})

test('FIXED B-5: a --dev manifest that cannot be reached is exit 3 (could not be read), as tapeapi-doctor counts it, not 1', async () => {
  // Port 1 on loopback: refused at once, no network. / 回环地址的 1 号端口：立即拒绝，不联网。
  const r = keep(await connect(null, ['--dev', 'http://127.0.0.1:1']))
  assert.equal(r.code, 3, r.out)
  assert.match(r.out, /COULD NOT BE READ: unavailable — the chain or the service could not be read: nothing was decided/)
  assert.match(r.out, /cannot reach the dev manifest at http:\/\/127\.0\.0\.1:1/)
  assert.equal(lastLine(r.out), 'next: / 下一条命令: tapeapi connect --dev http://127.0.0.1:1')
  const j = keep(await connect(null, ['--dev', 'http://127.0.0.1:1', '--json']))
  const o = JSON.parse(j.out)
  assert.equal(o.exitCode, 3); assert.equal(o.status, 'unavailable'); assert.equal(o.next, 'tapeapi connect --dev http://127.0.0.1:1 --json')
  // --tool naming an undeclared format stays 2 (the design and the help: a usage mistake). / 仍为 2（用法错误）。
  assert.match((await connect(null, ['--help'])).out, /2 a usage mistake \(also --tool \/ --format naming a\nformat the manifest does not declare\); 3 could not be read \(the chain, or the --dev manifest\)/)
})

test('connect --json: one JSON object on stdout, nothing on stderr, titles in the chosen language', async () => {
  const w = world({ formats: ['openai-chat', 'anthropic-messages'] })
  const r = keep(await connect(w, [NAME, ...RPC_ARGS, '--json', '--lang', 'zh']))
  assert.equal(r.code, 0); assert.equal(r.err, '')
  const o = JSON.parse(r.out)
  assert.equal(o.tool, 'tapeapi'); assert.equal(o.command, 'connect'); assert.equal(o.experimental, true); assert.equal(o.ok, true); assert.equal(o.resolution, 'tap10')
  assert.deepEqual(o.formats, ['openai-chat', 'anthropic-messages'])
  assert.equal(o.service.holder, (await createTapeAPI({ rpcUrls: ['http://rpc1', 'http://rpc2'], quorum: 2, conform: 'tap10', ...w.apiOptions }).resolve(NAME)).verified.holder)
  assert.ok(o.snippets.every((s) => typeof s.title === 'string' && /[一-鿿]/.test(s.title)))
  assert.match(o.notes.receipt, /不证明实际运行的是哪个模型/)
  assert.equal(o.next, null)
  const both = JSON.parse((await connect(w, [NAME, ...RPC_ARGS, '--json'])).out)
  assert.deepEqual(Object.keys(both.snippets[0].title), ['en', 'zh'])
})

test('connect --lang: en has no Chinese, zh has no English labels, both has both', async () => {
  const w = world()
  const en = keep(await connect(w, [NAME, ...RPC_ARGS, '--lang', 'en']))
  const zh = keep(await connect(w, [NAME, ...RPC_ARGS, '--lang', 'zh']))
  const both = keep(await connect(w, [NAME, ...RPC_ARGS]))
  assert.doesNotMatch(en.out, /[一-鿿]/)
  assert.match(zh.out, /^服务 +"Example relay"/m); assert.doesNotMatch(zh.out, /^(service|container|holder|signer) /m)
  assert.match(both.out, /^service \/ 服务 +"Example relay"/m)
  const bad = keep(await connect(w, [NAME, '--lang', 'fr']))
  assert.equal(bad.code, 2)
})

test('connect colors: only on a terminal without NO_COLOR or --no-color, and removing them gives the uncolored text', async () => {
  const w = world()
  const plain = await connect(w, [NAME, ...RPC_ARGS])
  const tty = await connect(w, [NAME, ...RPC_ARGS], { isTTY: true })
  assert.match(tty.out, /\x1b\[/)
  // eslint-disable-next-line no-control-regex
  assert.equal(tty.out.replace(/\x1b\[[0-9;]*m/g, ''), plain.out)
  assert.doesNotMatch((await connect(w, [NAME, ...RPC_ARGS], { isTTY: true, env: { NO_COLOR: '1' } })).out, /\x1b\[/)
  assert.doesNotMatch((await connect(w, [NAME, ...RPC_ARGS, '--no-color'], { isTTY: true })).out, /\x1b\[/)
  assert.doesNotMatch((await connect(w, [NAME, ...RPC_ARGS, '--json'], { isTTY: true })).out, /\x1b\[/)
  const un = world(); un.chain.setUnactivated()
  const a = await connect(un, [NAME, ...RPC_ARGS], { isTTY: true }), b = await connect(un, [NAME, ...RPC_ARGS])
  // eslint-disable-next-line no-control-regex
  assert.equal(a.out.replace(/\x1b\[[0-9;]*m/g, ''), b.out)
})

test('connect: no value of a secret-looking environment variable is printed, even when the manifest carries it (text and --json)', async () => {
  const SENTINEL = 'sk-SENTINEL-0123456789abcdef'
  const w = world({ name: `relay ${SENTINEL}` })
  const env = { SIGNER_KEY: SENTINEL, DELEGATION_SIG: '0xdeadbeefdeadbeefdeadbeef', PATH: '/usr/bin' }
  for (const extra of [[], ['--json'], ['--lang', 'zh']]) {
    const r = keep(await connect(w, [NAME, ...RPC_ARGS, ...extra], { env }))
    assert.equal(r.code, 0)
    assert.ok(!r.out.includes(SENTINEL) && !r.err.includes(SENTINEL), 'the sentinel is redacted')
    assert.ok(r.out.includes('***'))
  }
})

test('FIXED C-1: key-shaped strings in the manifest are redacted wherever they come from; ordinary text in a secret-named variable is not', async () => {
  const PK = '0x' + '5a'.repeat(31) + '7c', HEX = 'c0ffee'.repeat(6), SK = 'sk-live-' + 'Ab9'.repeat(8), BEARER = 'Bearer ' + 'tOk3n'.repeat(5)
  const w = world()
  // Model ids carrying a private-key-shaped value, a long hex run, an sk- token and a Bearer token: shown as *** (none of
  // them is in this environment). / 模型 id 里带着私钥形状的值、长十六进制串、sk- 令牌与 Bearer 令牌：显示为 ***（环境里都没有）。
  const price = [{ currency: 'USD', unit: '1M tokens', input: '1', output: '2' }]
  const shaped = world({ name: 'relay', extraModels: [PK, HEX, SK, `m ${BEARER}`].map((id) => ({ id, prices: price })) })
  for (const extra of [[], ['--json']]) {
    const r = keep(await connect(shaped, [NAME, ...RPC_ARGS, ...extra], { env: { PATH: '/usr/bin' } }))
    assert.equal(r.code, 0, r.out)
    for (const v of [PK, HEX, SK, BEARER.slice(7)]) assert.ok(!r.out.includes(v), `${v} is redacted (${extra.join(' ') || 'text'})`)
    assert.ok(r.out.includes('Bearer ***'), 'the word Bearer stays, the token goes')
    // Addresses (0x + 40 hex) and the snippets' own "Bearer $API_KEY" are untouched. / 地址与片段里的 Bearer $API_KEY 不受影响。
    assert.ok(r.out.includes(shaped.c.container), 'the container address is shown')
  }
  const plain = keep(await connect(w, [NAME, ...RPC_ARGS, '--lang', 'en', '--format', 'openai-chat']))
  assert.ok(plain.out.includes('-H "authorization: Bearer $API_KEY"'), plain.out)
  // Ordinary text in secret-named variables is printed as it is (review C-1: WEIRD_TOKEN='in 1  out 2' blanked a price
  // line); a value that reads as a secret is still redacted. / 机密名变量里的普通文本照常显示；像机密的值仍然脱敏。
  const env = { DEPLOY_TOKEN: 'production', WEIRD_TOKEN: 'in 0.56  out 1.68', MODEL_KEY: 'chat-model', API_KEY: 'hunter2hunter2', SIGNER_KEY: 'Example relay is long' }
  const r = keep(await connect(w, [NAME, ...RPC_ARGS, '--lang', 'en'], { env }))
  assert.equal(r.code, 0, r.out)
  for (const want of ['in 0.56  out 1.68', 'chat-model', '"Example relay"']) assert.ok(r.out.includes(want), `${want} is shown:\n${r.out}`)
  const named = keep(await connect(world({ name: 'production hunter2hunter2' }), [NAME, ...RPC_ARGS, '--lang', 'en'], { env }))
  assert.ok(named.out.includes('"production ***"'), named.out)
  // The rule itself, both ways. / 规则本身，两个方向。
  const { envValueIsSecret, redactKeyShapes } = await import('../src/connect-cli.js')
  for (const v of ['production', 'development', 'staging-eu', 'in 1  out 2', 'short', '', 'Bearer production']) assert.equal(envValueIsSecret(v), false, v)
  for (const v of ['hunter2hunter2', 'abcdefghijklmnopq', PK, SK, 'Bearer ' + 'x1'.repeat(10), 'us-east-1x']) assert.equal(envValueIsSecret(v), true, v)
  assert.equal(redactKeyShapes(`a ${PK} b`), 'a *** b')
  assert.equal(redactKeyShapes('0x' + 'ab'.repeat(20)), '0x' + 'ab'.repeat(20), 'an address stays')
  assert.equal(redactKeyShapes('0x' + 'ab'.repeat(65)), '0x' + 'ab'.repeat(65), 'a signature (65 bytes) stays')
  assert.equal(redactKeyShapes('9'.repeat(40)), '9'.repeat(40), 'a decimal number stays')
  assert.equal(redactKeyShapes('task-' + 'a'.repeat(20)), 'task-' + 'a'.repeat(20), 'sk- inside a word is not a token')
})

test('connect usage mistakes: exit 2 on stderr, nothing on stdout, last line the next command', async () => {
  for (const args of [[], ['not a name'], [NAME, '--proxy', '--json'], [NAME, '--strict'], [NAME, '--log', 'x.jsonl'], [NAME, '--tool', 'vim'], [NAME, '--format', 'grpc'], [NAME, '--rpc', 'http://a.example,http://a.example/2'], [NAME, NAME], [NAME, '--dev', 'http://127.0.0.1:1'], ['--bogus']]) {
    const r = keep(await connect(null, args))
    assert.equal(r.code, 2, args.join(' '))
    assert.equal(r.out, '')
    assert.equal(lastLine(r.err), 'next: / 下一条命令: tapeapi connect --help')
  }
  const none = await connect(null, [])
  assert.match(none.err, /no ranking, no picks/)
  const help = await connect(null, ['--help'])
  assert.equal(help.code, 0); assert.match(help.out, /Usage: tapeapi connect <name>/)
})

test('connect --proxy: an available service starts tapeapi-verify with the options given, in a fixed order, after the card', async () => {
  const w = world()
  const r = keep(await connect(w, [NAME, ...RPC_ARGS, '--proxy', '--port', '0', '--strict', '--log', '/tmp/r.jsonl', '--request-usage', '--lang', 'en']))
  assert.equal(r.code, 0)
  assert.deepEqual(r.calls, [['/x/tapeapi-verify.js', [NAME, '--port', '0', '--strict', '--log', '/tmp/r.jsonl', '--request-usage', '--rpc', 'http://rpc1,http://rpc2,http://rpc3']]])
  assert.equal(r.err, '', 'nothing on stderr before tapeapi-verify')
  assert.match(lastLine(r.out), /^starting tapeapi-verify \(Ctrl-C stops it\): tapeapi-verify 42\.7\.tape --port 0 --strict/)
  // the child's exit is passed back as it is / 子进程的退出原样返回
  const failed = await connect(w, [NAME, ...RPC_ARGS, '--proxy'], { runChild: async () => ({ code: 1, signal: null }) })
  assert.deepEqual(failed.child, { code: 1, signal: null })
})

// The 2.x line: connect resolves with conform: 'tap10' and tapeapi-verify (so --proxy) uses the 2.0 default, which is the
// same resolution. On 1.8.1, where this command was written, tapeapi-verify resolved the 1.x way; here the card, the
// proxy and a default client agree on every state connect shows as unavailable.
// 2.x 线：connect 以 conform: 'tap10' 解析，tapeapi-verify（因而 --proxy）用 2.0 默认，两者相同。1.8.1 上 tapeapi-verify 按 1.x
// 解析；这里卡片、代理与默认客户端对 connect 判为不可用的每种状态结论一致。
test('connect --proxy on the 2.x line: tapeapi-verify resolves as the card does (the 2.0 default) and refuses the states connect shows as unavailable', async () => {
  const urls = ['http://rpc1', 'http://rpc2', 'http://rpc3']
  // tapeapi-verify makes its client with no conform option (sdk/bin/tapeapi-verify.js): the 2.0 default.
  // tapeapi-verify 建客户端时不给 conform：即 2.0 默认。
  const defaultClient = (w) => createTapeAPI({ rpcUrls: urls, quorum: 2, ...w.apiOptions })
  const w = world()
  const r = keep(await connect(w, [NAME, ...RPC_ARGS, '--proxy']))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /resolution: TAP-10 \/ TAP-11 \(conform: 'tap10'\)/)
  const [[, args]] = r.calls
  for (const flag of ['--no-conform', '--dev']) assert.ok(!args.includes(flag), `${flag} is never passed: ${args.join(' ')}`)
  // The default client finds the same usable service, under the same conformance profile. / 默认客户端得到同一个可用服务、同一配置档。
  const svc = await defaultClient(w).resolve(NAME)
  const card = await createTapeAPI({ rpcUrls: urls, quorum: 2, conform: 'tap10', ...w.apiOptions }).resolve(NAME)
  assert.ok(svc.conform?.profile, 'the default client resolves in the conformance mode')
  assert.deepEqual(svc.conform, card.conform)
  assert.equal(svc.verified.holder, card.verified.holder)
  // Each state connect shows as unavailable (and so never proxies) is a refusal of the default client with the same
  // status: tapeapi-verify would refuse it too. / connect 判为不可用（因而不启动代理）的每种状态，默认客户端以同一状态拒绝。
  const cases = [
    ['unpaid', (x) => x.chain.setUnactivated()],
    ['not-opened', (x) => x.chain.setOpened(x.c.circuits, 42, false)],
    ['store-changed', (x) => x.chain.setImplementation(CHAINS[56].siteRegistry, '0x' + 'ab'.repeat(20))],
  ]
  for (const [status, apply] of cases) {
    const x = world()
    apply(x)
    const j = JSON.parse(keep(await connect(x, [NAME, ...RPC_ARGS, '--json'])).out)
    assert.equal(j.status, status)
    await assert.rejects(defaultClient(x).resolve(NAME), (e) => e.data?.status === status, `the 2.0 default refuses ${status} too`)
  }
  // The proxy itself, spawned with the arguments connect gives it, its nodes being the same test chain over HTTP (two
  // operators: 127.0.0.1 and localhost): it resolves by TAP-10 / TAP-11 and starts for the usable service, and refuses
  // the unpaid one, which the 1.x resolution would have accepted.
  // 用 connect 给出的参数真正启动代理，节点是经 HTTP 提供的同一条测试链（两家运营方）：可用的服务它按 TAP-10 / TAP-11 解析并启动；
  // 未激活的服务它拒绝（1.x 解析会接受）。
  const spawnProxy = async (x) => {
    const rpc = http.createServer(async (req, res) => {
      const parts = []
      for await (const p of req) parts.push(p)
      const up = await x.chain.fetch('http://rpc1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(parts).toString('utf8') })
      res.writeHead(up.status, { 'content-type': 'application/json' }).end(await up.text())
    })
    await new Promise((ok) => rpc.listen(0, '127.0.0.1', ok))
    closers.push(() => new Promise((ok) => { rpc.closeAllConnections?.(); rpc.close(ok) }))
    const p = rpc.address().port
    const a = args.map((s) => (s === urls.join(',') ? `http://127.0.0.1:${p},http://localhost:${p}` : s))
    assert.notDeepEqual(a, args)
    return run([binOf(ORIGINAL.verify), ...a, '--port', '0'], { until: (t) => /BASE_URL=/.test(t), then: (c) => setTimeout(() => c.kill('SIGTERM'), 100) })
  }
  const up = await spawnProxy(w)
  const upText = up.stderr.toString('utf8')
  assert.match(upText.split('\n')[0], /^\[tapeapi-verify\] resolution: TAP-10 \/ TAP-11 \(the default since 2\.0; --no-conform for the 1\.x one\)$/)
  assert.match(upText, /BASE_URL=/, upText)
  assert.equal(up.code, 0, upText)
  const unpaid = world()
  unpaid.chain.setUnactivated()
  const down = await spawnProxy(unpaid)
  const downText = down.stderr.toString('utf8')
  assert.equal(down.code, 1, downText)
  assert.match(downText, /unpaid/, downText)
  assert.doesNotMatch(downText, /BASE_URL=/)
})

test('tapeapi connect --dev --proxy (spawned): after the card, stderr is byte for byte tapeapi-verify\'s own run with the same options', async () => {
  const url = await startSidecar()
  const port = await freePort(), logFile = join(TMP, 'proxy.jsonl')
  const listening = (t) => /ANTHROPIC_BASE_URL=/.test(t)
  const kill = (c) => setTimeout(() => c.kill('SIGTERM'), 300)
  const a = await run([BIN, 'connect', '--dev', url, '--proxy', '--port', String(port), '--log', logFile], { until: listening, then: kill })
  const b = await run([binOf(ORIGINAL.verify), '--dev', url, '--port', String(port), '--log', logFile], { until: listening, then: kill })
  assert.equal(a.code, b.code); assert.equal(a.code, 0)
  assert.ok(a.stderr.equals(b.stderr), `stderr differs\n--- connect --proxy\n${a.stderr}\n--- tapeapi-verify\n${b.stderr}`)
  assert.equal(b.stdout.length, 0)
  const card = a.stdout.toString('utf8')
  assert.match(card, /resolution: development \(--dev\): the identity is NOT checked on chain/)
  assert.match(card, new RegExp(`OPENAI_BASE_URL=http://127\\.0\\.0\\.1:${port}/v1`))
  assert.match(card, new RegExp(`tapeapi\\.js connect --dev ${url.replace(/[.]/g, '\\.')} --proxy --port ${port}\\n`))
  assert.match(card, new RegExp(`starting tapeapi-verify .*: tapeapi-verify --dev ${url.replace(/[.]/g, '\\.')} --port ${port} --log `))
})

// ════ tapeapi connect: MCP tool services (TAPI-20 §3.8, experimental) ═══════════════════════════════════════════════
// The same TAP-10 test chain; the manifest is made by the signing MCP proxy (server/src/mcp-proxy.js) over the demo MCP
// server's tools (examples/mcp-proxy/demo-server.mjs), in process. Its endpoint (https://api.example.com/mcp) is never
// contacted: connect reads the chain and the manifest only. / 同一条 TAP-10 测试链；清单由签名 MCP 代理在演示 MCP 服务器的工具上生成；端点从不访问。
async function mcpWorld({ name = 'Example tools', edit = null } = {}) {
  const w = world()
  const signerKey = SIG.randomPrivateKey(), holderKey = SIG.randomPrivateKey()
  const chain = createConformChain()
  chain.state.headTime = w.now
  const c = chain.circuit(42, { holder: SIG.privateKeyToAddress(holderKey) })
  chain.setAccount('42', c.container); chain.setCode(c.container)
  // world()'s expiry: half a day past 90 days (review T-1), so the card's day count is the same for every run of a test.
  // / 沿用 world() 的到期时间：90 天再加半天（审查 T-1），卡片上的天数在一个测试的各次运行中相同。
  const expires = w.expires
  const delegationSig = SIG.signDigest(SIG.delegationDigest(56, MAINNET.hub, { container: c.container, signer: SIG.privateKeyToAddress(signerKey), expires }), holderKey)
  const core = MCP.createMcpServer({ info: { name: 'demo', version: '1' }, listTools: async () => DEMO_TOOLS, callTool: async () => ({ content: [] }) })
  const proxy = createMcpProxy({ upstream: { call: (m) => core.handle(m) }, signerKey, log: () => {}, rateLimit: false,
    manifestBase: { name, circuits: c.circuits, tokenId: '42', container: c.container, delegation: { expires, sig: delegationSig }, endpoints: { live: ['https://api.example.com/tapeapi/v1'], async: false } } })
  const manifest = structuredClone(await proxy.ready)
  if (edit) edit(manifest)
  chain.writeFile(c.container, '.well-known/tapeapi.json', JSON.stringify(manifest))
  return { chain, c, now: w.now, manifest, apiOptions: { clock: () => w.now, quiet: true, onWarning: () => {}, fetch: (u, init) => chain.fetch(String(u), init) } }
}
const MCP_BIN = '/x/tapeapi-mcp.js'
async function connectMcp(w, args, o = {}) {
  let out = '', err = ''
  const calls = []
  const r = await runConnect(args, { cmd: 'tapeapi', version: '0.0.0-test', verifyBin: '/x/tapeapi-verify.js', mcpBin: MCP_BIN, env: o.env ?? {}, isTTY: o.isTTY ?? false, apiOptions: w?.apiOptions ?? {}, stdout: (s) => { out += s }, stderr: (s) => { err += s }, runChild: async (file, a) => { calls.push([file, a]); return { code: 0, signal: null } } })
  return { code: r.exitCode ?? r.child?.code, out, err, calls, child: r.child }
}
const PKG = '--package=https://github.com/BruceLanLan/tapeapi/releases/download/v0.0.0-test/tapeapi-sdk-0.0.0-test.tgz'
// What an MCP card must never carry: an AI setting, a key placeholder, the AI proxy, the 1.x resolution. / MCP 卡片绝不出现的内容。
const NOT_IN_MCP = /OPENAI_BASE_URL|ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|API_KEY|wire_api|createVerifyingFetch|connect 42\.7\.tape --proxy|--no-conform|tapeapi-verify/

test('connect, MCP tool service: a manifest with mcp and no ai gets a usable card (endpoint, tools, toolsSha256 prefix) and Claude Code / Claude Desktop settings from the manifest only', async () => {
  const w = await mcpWorld()
  const digest = MCP.toolsDigest(DEMO_TOOLS)
  assert.equal(w.manifest.mcp.toolsSha256, digest)
  const r = keep(await connectMcp(w, [NAME, ...RPC_ARGS]))
  assert.equal(r.code, 0, r.out + r.err)
  assert.equal(r.err, '')
  for (const want of ['"Example tools"', NAME, w.c.container, 'usable: an MCP tool service (experimental) / 可用：MCP 工具服务（实验性）', 'https://api.example.com/mcp   (MCP Streamable HTTP, as the manifest declares',
    `2 (the manifest's free methods; the tools are the ones tools/list names / 清单里的免费方法；工具是其中 tools/list 列出的)   toolsSha256 ${digest.slice(0, 8)}…`, 'add, shout', 'it does not prove which program produced the answer', '不证明回答由哪个程序产生', 'this command does not contact the endpoint',
    `claude mcp add tapeapi-42-7 -- npx -y ${PKG} tapeapi-mcp 42.7.tape`, 'claude mcp add --transport http tapeapi-42-7 https://api.example.com/mcp', 'URL: https://api.example.com/mcp', 'asks for no key or password', 'resolution: TAP-10 / TAP-11']) {
    assert.ok(r.out.includes(want), `missing ${want}\n${r.out}`)
  }
  assert.ok(!r.out.includes(digest), 'the card shows the prefix only (--json has it whole)')
  assert.doesNotMatch(r.out, NOT_IN_MCP)
  assert.doesNotMatch(r.out, /\*\*\*/)
  // The two direct settings are marked as not checked; the two through tapeapi-mcp are not. / 两个直连配置标为不核验。
  assert.equal(r.out.match(/^ {2}! /gm).length, 2)
  // Review M-1, TAPs #16 §4.2: a direct answer is not a signed envelope; no title claims receipts or a verify link for it.
  // 审查 M-1：直连的回答不是签名信封；任何标题都不声称直连带回执或核验链接。
  for (const t of ['Claude Code, the declared endpoint direct (MCP Streamable HTTP): not checked here; a direct answer is not a signed envelope, do not treat it as signed or verified (only tapeapi-mcp, above, checks answers)',
    'Claude Code，直连声明的端点（MCP Streamable HTTP）：这里不核验；直连的回答不是签名信封，不要当作已签名或已核验（只有经上面的 tapeapi-mcp 才核验回答）',
    'Claude Desktop, the declared endpoint direct (Settings > Connectors > Add custom connector): not checked here; a direct answer is not a signed envelope, do not treat it as signed or verified',
    'Claude Desktop，直连声明的端点（设置 > 连接器 > 添加自定义连接器）：这里不核验；直连的回答不是签名信封，不要当作已签名或已核验']) {
    assert.ok(r.out.includes(t), `missing ${t}\n${r.out}`)
  }
  assert.doesNotMatch(r.out, /each result carries a receipt|每个结果带回执|verify link|核验链接/)
  // --json: kind 'mcp' (added), the whole digest, the tool names, the four settings in order, the MCP notes.
  const o = JSON.parse(keep(await connectMcp(w, [NAME, ...RPC_ARGS, '--json', '--lang', 'en'])).out)
  assert.equal(o.kind, 'mcp'); assert.equal(o.ok, true); assert.equal(o.exitCode, 0); assert.equal(o.status, 'ok')
  assert.deepEqual(o.service.mcp, { endpoint: 'https://api.example.com/mcp', toolsSha256: digest })
  assert.deepEqual(o.service.tools, ['add', 'shout'])
  assert.deepEqual(o.formats, [])
  assert.deepEqual(o.snippets.map((s) => [s.tool, s.format, s.via, s.verifies]), [['claude-code', 'mcp', 'stdio', true], ['claude-desktop', 'mcp', 'stdio', true], ['claude-code', 'mcp', 'direct', false], ['claude-desktop', 'mcp', 'direct', false]])
  assert.deepEqual(Object.keys(o.notes), ['receipt', 'tools', 'boundary'])
  // --json gives the title in the language asked for / --json 按所选语言给出标题
  const oz = JSON.parse(keep(await connectMcp(w, [NAME, ...RPC_ARGS, '--json', '--lang', 'zh'])).out)
  for (const k of [2, 3]) {
    assert.match(o.snippets[k].title, /not checked here; a direct answer is not a signed envelope, do not treat it as signed or verified/)
    assert.match(oz.snippets[k].title, /这里不核验；直连的回答不是签名信封，不要当作已签名或已核验/)
  }
  // The Claude Desktop setting is valid JSON naming tapeapi-mcp and the service, with no key; the card prints the same
  // text. / Claude Desktop 配置是合法 JSON，卡片里是同一段文本。
  assert.deepEqual(JSON.parse(o.snippets[1].text), { mcpServers: { 'tapeapi-42-7': { command: 'npx', args: ['-y', PKG, 'tapeapi-mcp', NAME] } } })
  assert.ok(r.out.includes(o.snippets[1].text.split('\n').map((l) => `    ${l}`).join('\n')))
  assert.equal(o.next, null)
  // An AI service's --json says kind 'ai'; the key comes last, the others are as they were. / AI 服务为 kind 'ai'，其余键不变。
  const ai = JSON.parse(keep(await connect(world(), [NAME, ...RPC_ARGS, '--json'])).out)
  assert.equal(ai.kind, 'ai'); assert.equal(Object.keys(ai).at(-1), 'kind')
  assert.deepEqual(Object.keys(ai.notes), ['receipt', 'prices', 'boundary', 'token'])
  // Languages. / 语言。
  const en = keep(await connectMcp(w, [NAME, ...RPC_ARGS, '--lang', 'en'])), zh = keep(await connectMcp(w, [NAME, ...RPC_ARGS, '--lang', 'zh']))
  assert.doesNotMatch(en.out, /[一-鿿]/)
  assert.match(zh.out, /^状态 +可用：MCP 工具服务（实验性）$/m); assert.match(zh.out, /^方法 +2 \(清单里的免费方法；工具是其中 tools\/list 列出的\)/m); assert.match(zh.out, /配置你的 MCP 客户端/)
  assert.doesNotMatch(zh.out, /^(status|tools|methods|mcp) /m)
  assert.match(en.out, /^methods +2 \(the manifest's free methods; the tools are the ones tools\/list names\)/m)
  // Colors as for an AI card: stripped, the same text. / 颜色规则同 AI 卡片。
  const tty = await connectMcp(w, [NAME, ...RPC_ARGS], { isTTY: true })
  assert.match(tty.out, /\x1b\[/)
  // eslint-disable-next-line no-control-regex
  assert.equal(tty.out.replace(/\x1b\[[0-9;]*m/g, ''), r.out)
  // Review R-3: a priced method is not counted or listed as a tool (tapeapi-mcp offers no priced method), in the card
  // and in --json alike. / 审查 R-3：收费方法不计入、不列为工具（tapeapi-mcp 不提供收费方法），卡片与 --json 一致。
  const priced = await mcpWorld({ edit: (m) => { m.methods.push({ name: 'premium', priceBEM: '0.0001', params: {}, returns: {} }); m.payment = { escrow: '0x' + '55'.repeat(20), unit: 'BEM', decimals: 8 } } })
  const pr = keep(await connectMcp(priced, [NAME, ...RPC_ARGS, '--lang', 'en']))
  assert.equal(pr.code, 0, pr.out + pr.err)
  assert.ok(pr.out.includes(`2 (the manifest's free methods; the tools are the ones tools/list names)   toolsSha256`), pr.out)
  assert.ok(pr.out.includes('add, shout'), pr.out)
  assert.doesNotMatch(pr.out, /premium/)
  assert.deepEqual(JSON.parse(keep(await connectMcp(priced, [NAME, ...RPC_ARGS, '--json'])).out).service.tools, ['add', 'shout'])
})

test('connect, MCP tool service (2.4): a manifest that binds only some of its methods (TAPs #16 §4.1) gets a card that lists the free methods as methods and never states a tool count it cannot know', async () => {
  // A free method that is not a tool of the endpoint (its tools/list has add and shout only): the card cannot tell, since
  // it does not contact the endpoint, so the row says methods, not tools; --json keeps service.tools (2.3) as the same
  // candidate list. / 一个不是端点工具的免费方法：卡片不访问端点、分不出来，所以那一行写“方法”而不是“工具”；--json 仍是 service.tools。
  const w = await mcpWorld({ edit: (m) => { m.methods.push({ name: 'plain', priceBEM: '0', params: {}, returns: {} }) } })
  for (const lang of ['en', 'zh', 'both']) {
    const r = keep(await connectMcp(w, [NAME, ...RPC_ARGS, '--lang', lang]))
    assert.equal(r.code, 0, r.out + r.err)
    assert.match(r.out, lang === 'zh' ? /^方法 +3 \(清单里的免费方法；工具是其中 tools\/list 列出的\)/m : /^methods(?: \/ 方法)? +3 \(the manifest's free methods; the tools are the ones tools\/list names/m)
    assert.doesNotMatch(r.out, /^(tools|工具)( \/ 工具)? +\d/m, 'no row counts tools')
    assert.doesNotMatch(r.out, /\b3 tools\b|3 个工具/)
    assert.ok(r.out.includes('add, shout, plain'), r.out)
    if (lang !== 'zh') assert.ok(r.out.includes('so it does not say which or how many'), r.out)
    if (lang !== 'en') assert.ok(r.out.includes('所以不说是哪些、有几个'), r.out)
  }
  const o = JSON.parse(keep(await connectMcp(w, [NAME, ...RPC_ARGS, '--json'])).out)
  assert.deepEqual(o.service.tools, ['add', 'shout', 'plain'])
  assert.match(o.notes.tools.en, /^The methods shown are the manifest's free methods/)
})

test('connect, MCP tool service: settings appear only as declared (gating), --tool / --format narrow or refuse them, an invalid mcp field and a manifest with neither field are unavailable', async () => {
  const w = await mcpWorld()
  const desk = keep(await connectMcp(w, [NAME, ...RPC_ARGS, '--tool', 'claude-desktop', '--json']))
  assert.deepEqual(JSON.parse(desk.out).snippets.map((s) => [s.tool, s.via]), [['claude-desktop', 'stdio'], ['claude-desktop', 'direct']])
  for (const [args, need] of [[['--tool', 'codex'], 'openai-responses'], [['--tool', 'openai-sdk'], 'openai-chat or openai-embeddings'], [['--format', 'openai-chat'], 'openai-chat']]) {
    const r = keep(await connectMcp(w, [NAME, ...RPC_ARGS, ...args]))
    assert.equal(r.code, 2, r.out)
    assert.ok(r.out.includes(`does not declare ${need}, so no`), r.out)
    assert.doesNotMatch(r.out, /configure your MCP client|claude mcp add/)
    assert.equal(lastLine(r.out), 'next: / 下一条命令: tapeapi connect 42.7.tape')
    assert.match(r.out, /every setting its mcp field allows/)
  }
  // An AI service asked for Claude Desktop: its manifest does not declare mcp (exit 2). / AI 服务点名 Claude Desktop：退出 2。
  const aiDesk = keep(await connect(world(), [NAME, ...RPC_ARGS, '--tool', 'claude-desktop']))
  assert.equal(aiDesk.code, 2)
  assert.match(aiDesk.out, /does not declare mcp, so no Claude Desktop settings are generated/)
  // An invalid mcp field: unavailable (mcp-invalid, exit 1), the detail says why, no settings. / mcp 字段无效：不可用。
  for (const [edit, detail] of [
    [(m) => { m.mcp.toolsSha256 = 'abc' }, 'mcp.toolsSha256 must be 64 lowercase hex characters'],
    // 2.3: only lowercase, as TAPI-20 §3.8, TAPs #16 §2 and the holder console (the same digest in capitals is refused).
    // 2.3：只收小写，与 TAPI-20 §3.8、TAPs #16 §2 和持有人操作台一致（同一摘要写成大写也拒绝）。
    [(m) => { m.mcp.toolsSha256 = m.mcp.toolsSha256.toUpperCase() }, 'mcp.toolsSha256 must be 64 lowercase hex characters'],
    [(m) => { m.mcp.endpoint = 'http://mcp.example.com/mcp' }, 'mcp.endpoint must be https'],
    [(m) => { m.mcp.endpoint = 'https://mcp.example.com/mcp?x=1' }, 'mcp.endpoint must have no query or fragment'],
    [(m) => { m.mcp.endpoint = 'https://mcp.example.com/mcp#tools' }, 'mcp.endpoint must have no query or fragment'],
    [(m) => { m.mcp = 'https://mcp.example.com/mcp' }, 'mcp must be an object'],
  ]) {
    const r = keep(await connectMcp(await mcpWorld({ edit }), [NAME, ...RPC_ARGS, '--proxy']))
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes('UNAVAILABLE: mcp-invalid — its mcp field is invalid (see the detail)'), r.out)
    assert.ok(r.out.includes(detail), r.out)
    assert.doesNotMatch(r.out, /claude mcp add|mcpServers/)
    assert.equal(r.calls.length, 0)
  }
  // Both fields: the AI card, as before; the mcp field is not used. / 两个字段都有：AI 卡片照旧，不用 mcp 字段。
  const both = await mcpWorld({ edit: (m) => { m.ai = { endpoints: [{ format: 'openai-chat', baseUrl: 'https://api.example.com/v1' }], models: [{ id: 'chat-model', prices: [{ currency: 'USD', unit: '1M tokens', input: '1', output: '2' }] }] } } })
  const bothR = keep(await connectMcp(both, [NAME, ...RPC_ARGS, '--json']))
  assert.equal(JSON.parse(bothR.out).kind, 'ai', bothR.out)
  assert.doesNotMatch(bothR.out, /tapeapi-mcp|claude-desktop/)
  // Neither field: not-ai with the reason naming both, exit 1 (the one line that changed). / 两者都没有：not-ai，原因同时点名两者。
  const plain = await mcpWorld({ edit: (m) => { delete m.mcp } })
  for (const [lang, want] of [['en', 'UNAVAILABLE: not-ai — its manifest has no ai field and no MCP tool declaration (mcp, TAPI-20 §3.8): it is neither an AI service nor an MCP tool service'], ['zh', '不可用：not-ai —— 它的清单没有 ai 字段，也没有 MCP 工具声明（mcp，TAPI-20 §3.8）：既不是 AI 服务，也不是 MCP 工具服务']]) {
    const r = keep(await connectMcp(plain, [NAME, ...RPC_ARGS, '--lang', lang, '--proxy']))
    assert.equal(r.code, 1); assert.ok(r.out.includes(want), r.out); assert.equal(r.calls.length, 0)
    assert.equal(lastLine(r.out), lang === 'en' ? 'next: tapeapi doctor 42.7.tape' : '下一条命令: tapeapi doctor 42.7.tape')
  }
  assert.equal(JSON.parse(keep(await connectMcp(plain, [NAME, ...RPC_ARGS, '--json'])).out).kind, null)
  // The pure function: [] without a usable mcp field or with an ai field; --dev names the dev URL; never a key.
  const { mcpSnippetsFor, MCP_SNIPPET_TOOLS } = await import('@tapeapi/sdk/connect')
  assert.deepEqual(MCP_SNIPPET_TOOLS, ['claude-code', 'claude-desktop'])
  assert.deepEqual(mcpSnippetsFor(null), [])
  assert.deepEqual(mcpSnippetsFor({ mcp: { endpoint: 'https://x.example/mcp', toolsSha256: 'zz' } }), [])
  assert.deepEqual(mcpSnippetsFor({ mcp: { endpoint: 'https://x.example/mcp', toolsSha256: 'A'.repeat(64) } }), [], 'uppercase hex is refused (2.3)')
  assert.equal(mcpSnippetsFor({ mcp: { endpoint: 'https://x.example/mcp', toolsSha256: 'a'.repeat(64) } }).length > 0, true)
  assert.deepEqual(mcpSnippetsFor({ ai: {}, mcp: w.manifest.mcp }), [])
  const dev = mcpSnippetsFor({ mcp: { endpoint: 'http://127.0.0.1:9/mcp', toolsSha256: 'a'.repeat(64) } }, { dev: 'http://127.0.0.1:9', version: '2.1.0' })
  assert.match(dev[0].text, /tapeapi-mcp --dev http:\/\/127\.0\.0\.1:9$/)
  assert.deepEqual(mcpSnippetsFor({ mcp: { endpoint: 'http://127.0.0.1:9/mcp', toolsSha256: 'a'.repeat(64) } }), [], 'http://127.0.0.1 only with --dev')
  for (const s of [...dev, ...mcpSnippetsFor(w.manifest, { target: NAME })]) assert.doesNotMatch(s.text, /sk-|Bearer|KEY|TOKEN|SECRET/)
})

test('connect, MCP tool service: unpaid, not-opened and store-changed are unavailable with the reason (exit 1, no settings), an RPC outage is exit 3, as for an AI service', async () => {
  const cases = [
    ['unpaid', (w) => w.chain.setUnactivated(), 1],
    ['not-opened', (w) => w.chain.setOpened(w.c.circuits, 42, false), 1],
    ['store-changed', (w) => w.chain.setImplementation(CHAINS[56].siteRegistry, '0x' + 'ab'.repeat(20)), 1],
    ['unavailable', (w) => { w.apiOptions.fetch = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) } }, 3],
  ]
  for (const [status, apply, code] of cases) {
    const w = await mcpWorld()
    apply(w)
    const r = keep(await connectMcp(w, [NAME, ...RPC_ARGS, '--proxy']))
    assert.equal(r.code, code, `${status}\n${r.out}`)
    assert.ok(r.out.includes(`${code === 3 ? 'COULD NOT BE READ' : 'UNAVAILABLE'}: ${status} — `), r.out)
    assert.match(r.out, /not generated: the service cannot be used/)
    assert.doesNotMatch(r.out, /claude mcp add|mcpServers|tapeapi-mcp|MCP tool service/)
    assert.equal(r.calls.length, 0, 'tapeapi-mcp is not started')
    const o = JSON.parse(keep(await connectMcp(w, [NAME, ...RPC_ARGS, '--json'])).out)
    assert.equal(o.status, status); assert.equal(o.kind, null); assert.deepEqual(o.snippets, [])
  }
})

test('connect --proxy, MCP tool service: runs tapeapi-mcp with the nodes and the name (never --no-conform), the card on stderr and nothing on stdout; tapeapi-verify options are a usage mistake', async () => {
  const w = await mcpWorld()
  const r = keep(await connectMcp(w, [NAME, ...RPC_ARGS, '--rpc-xlayer', 'http://x1,http://x2', '--proxy', '--lang', 'en']))
  assert.equal(r.code, 0)
  assert.equal(r.out, '', 'stdout is left to tapeapi-mcp\'s JSON-RPC')
  assert.deepEqual(r.calls, [[MCP_BIN, ['--rpc', 'http://rpc1,http://rpc2,http://rpc3', '--rpc-xlayer', 'http://x1,http://x2', NAME]]])
  assert.ok(!r.calls[0][1].includes('--no-conform'))
  assert.match(r.err, /usable: an MCP tool service/)
  assert.match(lastLine(r.err), /^starting tapeapi-mcp \(stdio; it waits for an MCP client on stdin; Ctrl-C stops it\): tapeapi-mcp --rpc /)
  for (const extra of [['--port', '9'], ['--strict'], ['--log', '/tmp/r.jsonl'], ['--request-usage']]) {
    const bad = keep(await connectMcp(w, [NAME, ...RPC_ARGS, '--proxy', ...extra]))
    assert.equal(bad.code, 2, extra.join(' ')); assert.equal(bad.out, ''); assert.equal(bad.calls.length, 0)
    assert.match(bad.err, /tapeapi-verify's options; this is an MCP tool service/)
    assert.equal(lastLine(bad.err), 'next: / 下一条命令: tapeapi connect 42.7.tape --proxy')
  }
  const failed = await connectMcp(w, [NAME, ...RPC_ARGS, '--proxy'])
  assert.deepEqual(failed.child, { code: 0, signal: null })
})

test('tapeapi connect --dev --proxy for an MCP tool service (spawned): stdout is byte for byte tapeapi-mcp --dev\'s JSON-RPC over the demo MCP server; the card is on stderr', async () => {
  // The demo MCP server (the fake upstream) behind the signing MCP proxy, on real ports. / 演示 MCP 服务器在签名代理之后，真实端口。
  const demo = await startDemoServer({ port: 0, host: '127.0.0.1' })
  closers.push(demo.close)
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
  proxy = createMcpProxy({ upstream: { url: demo.url }, signerKey: KEY, allowHttp: true, rateLimit: false, log: () => {},
    manifestBase: { name: 'MCP CLI test', circuits: '0x' + '00'.repeat(20), tokenId: '0', container: '0x' + '00'.repeat(20), delegation: null, dev: true, endpoints: { live: [`${url}/tapeapi/v1`], async: false } } })
  await proxy.ready
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  ]
  // tapeapi-mcp pins in ~/.tapeapi: each run gets its own empty home. / tapeapi-mcp 在 ~/.tapeapi 钉住：每次运行用自己的空 home。
  const home = (n) => { const d = join(TMP, `home-${n}`); mkdirSync(d, { recursive: true }); return { ...process.env, HOME: d, USERPROFILE: d } }
  const a = await run([BIN, 'connect', '--dev', url, '--proxy'], { input: [...input], env: home('a') })
  const b = await run([binOf(ORIGINAL.mcp), '--dev', url], { input: [...input], env: home('b') })
  assert.equal(a.code, b.code, a.stderr.toString())
  assert.ok(a.stdout.equals(b.stdout), `stdout differs\n--- connect --proxy\n${a.stdout}\n--- tapeapi-mcp\n${b.stdout}`)
  const lines = a.stdout.toString('utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 2)
  for (const l of lines) assert.equal(JSON.parse(l).jsonrpc, '2.0')
  assert.deepEqual(JSON.parse(lines[1]).result.tools.map((t) => t.name).sort(), ['add', 'shout'])
  const err = a.stderr.toString('utf8')
  assert.match(err, /resolution: development \(--dev\): the identity is NOT checked on chain/)
  assert.match(err, /usable: an MCP tool service/)
  assert.ok(err.includes(`tapeapi-mcp --dev ${url}`), err)
  assert.ok(err.includes(b.stderr.toString('utf8').split('\n')[0]), 'tapeapi-mcp\'s own log follows the card')
})

test('connect, MCP tool service: no secret-looking environment value and no key-shaped string in the manifest is printed (text and --json)', async () => {
  const SENTINEL = 'sk-SENTINEL-0123456789abcdef', HEX = 'c0ffee'.repeat(5) + 'ab'
  const w = await mcpWorld({ name: `${SENTINEL} ${HEX}` })
  const env = { SIGNER_KEY: SENTINEL, PATH: '/usr/bin' }
  for (const extra of [[], ['--json'], ['--lang', 'zh'], ['--proxy']]) {
    const r = keep(await connectMcp(w, [NAME, ...RPC_ARGS, ...extra], { env }))
    assert.equal(r.code, 0)
    const all = r.out + r.err
    assert.ok(!all.includes(SENTINEL) && !all.includes(HEX), 'redacted')
    assert.ok(all.includes('***'))
    assert.ok(all.includes(w.c.container), 'the container address is shown')
    // The published digest (64 hex, which the key-shape rule would blank) is shown as it is in --json. / 发布的摘要原样显示。
    if (extra[0] === '--json') assert.equal(JSON.parse(r.out).service.mcp.toolsSha256, w.manifest.mcp.toolsSha256)
  }
})

test('wording: no connect output and no source line of the entry, connect or snippets says certified, partner, recommended or "supports Claude Code"', async () => {
  assert.ok(seen.length > 20)
  for (const text of seen) assert.doesNotMatch(text, FORBIDDEN)
  const src = ['../bin/tapeapi.js', '../src/connect.js', '../src/connect-cli.js'].map((p) => readFileSync(new URL(p, import.meta.url), 'utf8'))
  const ai = readFileSync(new URL('../src/ai.js', import.meta.url), 'utf8')
  src.push(ai.slice(ai.indexOf('Client settings (@experimental)')))
  for (const s of src) assert.doesNotMatch(s, FORBIDDEN)
})

test('ai.snippetsFor (@tapeapi/sdk/connect, experimental): pure, only declared formats, unknown formats ignored, the token never written', async () => {
  const sub = await import('@tapeapi/sdk/connect')
  assert.equal(sub.snippetsFor, AI.snippetsFor)
  assert.deepEqual(AI.snippetsFor(null), [])
  assert.deepEqual(AI.snippetsFor({ ai: { endpoints: [{ format: 'grpc-chat', baseUrl: 'https://x.example' }], models: [] } }), [])
  const m = { ai: { endpoints: [{ format: 'anthropic-messages', baseUrl: 'https://api.example.com' }], models: [{ id: 'c', prices: [] }] } }
  const all = AI.snippetsFor(m, { target: '42.7.tape' })
  assert.deepEqual(all.map((s) => [s.tool, s.via, s.verifies]), [['claude-code', 'proxy', true], ['claude-code', 'direct', false]])
  assert.deepEqual(AI.snippetsFor(m, { tool: 'codex' }), [])
  assert.deepEqual(AI.snippetsFor(m, { format: 'openai-chat' }), [])
  for (const s of all) assert.doesNotMatch(s.text, /sk-|Bearer [^$]/)
  const dev = AI.snippetsFor({ ai: { endpoints: [{ format: 'openai-chat', baseUrl: 'http://127.0.0.1:9/v1' }], models: [{ id: 'x', prices: [] }] } }, { dev: 'http://127.0.0.1:9' })
  assert.match(dev[0].text, /createTapeAPI\(\{ dev: true \}\)/); assert.match(dev[1].text, /^tapeapi connect --dev http:\/\/127\.0\.0\.1:9 --proxy$/m)
  // the module a web page would load imports nothing Node-only / 网页会加载的模块不引用仅限 Node 的模块
  assert.doesNotMatch(readFileSync(new URL('../src/connect.js', import.meta.url), 'utf8'), /from 'node:|require\(/)
})
