// tapeapi-doctor (sdk/src/doctor.js, sdk/bin/tapeapi-doctor.js), tested the way the conformance suite tests itself: a
// reference service passes every check, and each deliberately broken one fails exactly on the check that names its
// defect, with the checks after it skipped rather than failed. The chain is the in-process fake chain; the service is the
// real signing sidecar (server/src/ai-proxy.js) on a random 127.0.0.1 port, over the fake upstream. No other network.
// tapeapi-doctor 的测试，与一致性套件的自测方式相同：参考服务通过全部检查；每个故意做坏的服务恰好失败在点名其缺陷的那一项上，
// 后面的检查记为跳过而非失败。链是进程内假链；服务是真实的签名旁路（随机 127.0.0.1 端口），背后是模拟上游。不访问其它网络。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { createTapeAPI, CHAINS } from '../src/index.js'
import { diagnose, formatReport, DOCTOR_CHECKS, INVALID_KEY, doctorCommands, releaseTgz } from '../src/doctor.js'
import { howRun } from '../bin/tapeapi-doctor.js'
import { privateKeyToAddress, signDigest, delegationDigest } from '../src/sig.js'
import { ADDR } from './helpers/fake-chain.mjs'
import { createActivationChain } from './helpers/activation-chain.mjs'
import { createAIProxy } from '../../server/src/ai-proxy.js'
import { createFakeUpstream } from '../../examples/ai-proxy/fake-upstream.mjs'
import { startSidecar } from '../../examples/new-api-sidecar/server.mjs'

const BIN = fileURLToPath(new URL('../bin/tapeapi-doctor.js', import.meta.url))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const RPC = ['http://rpc1', 'http://rpc2']
const NAME = '42.7.tape'   // processor 7 is ADDR.circuits on the fake chain / 假链上 7 号处理器
const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32), OTHER_KEY = '0x' + '77'.repeat(32)
const holder = privateKeyToAddress(HOLDER_KEY), signer = privateKeyToAddress(SIGNER_KEY)
const nowS = () => Math.floor(Date.now() / 1000)
const MODELS = [
  { id: 'demo-chat', prices: [{ currency: 'USDT', unit: '1M tokens', input: '0.15', output: '0.6' }] },
  { id: 'demo-claude', formats: ['anthropic-messages'], prices: [{ currency: 'USDT', unit: '1M tokens', input: '3', output: '15' }] },
]
const delegation = (expires, key = HOLDER_KEY, s = signer) => ({ expires, sig: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer: s, expires }), key) })

// The sidecar on a real port, with knobs / 真实端口上的旁路，带开关：
// direct: /v1/* goes to the gateway, not through the sidecar; tamper: one byte changed after signing; nocors: every
// Access-Control-* header removed; setup: health in setup mode; key: the key the sidecar signs with.
const knobs = { direct: false, tamper: false, nocors: false, setup: false }
const fake = createFakeUpstream({ keys: ['sk-real'], models: MODELS.map((m) => m.id) })
let proxy = null, sidecarUrl = null, server = null
function makeProxy(signerKey = SIGNER_KEY, del = delegation(nowS() + 90 * 86_400)) {
  proxy = createAIProxy({
    upstream: { baseUrl: 'http://fake.local/v1' }, fetch: (u, init) => fake.fetch(u, init), signerKey, models: MODELS, allowHttp: true, rateLimit: false, receiptRateLimit: false, log: () => {},
    manifestBase: { name: 'Doctor test relay', circuits: ADDR.circuits, tokenId: '42', container: ADDR.container, delegation: del, endpoints: { live: [`${sidecarUrl}/tapeapi/v1`], async: false } },
  })
}
test.before(async () => {
  server = http.createServer(async (req, res) => {
    const parts = []
    for await (const c of req) parts.push(c)
    const headers = new Headers()
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1])
    const request = new Request(new URL(req.url, 'http://127.0.0.1'), { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(parts) })
    let r
    if (knobs.setup && req.url.startsWith('/tapeapi/v1/health')) r = new Response(JSON.stringify({ ok: false, setup: true, signer, missing: ['DELEGATION_SIG'] }), { headers: { 'content-type': 'application/json' } })
    else if (knobs.direct && req.url.startsWith('/v1/')) r = await fake.fetch(new Request(new URL(req.url, 'http://fake.local'), request))
    else r = await proxy.handleRequest(request, { clientIp: '127.0.0.1' })
    let bytes = r.body ? Buffer.from(await r.arrayBuffer()) : null
    if (bytes && knobs.tamper && req.url.startsWith('/v1/')) { bytes = Buffer.from(bytes); bytes[bytes.length - 2] ^= 1 }
    const out = Object.fromEntries([...r.headers].filter(([k]) => !(knobs.nocors && k.startsWith('access-control-'))))
    res.writeHead(r.status, out)
    res.end(bytes ?? undefined)
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  sidecarUrl = `http://127.0.0.1:${server.address().port}`
  makeProxy()
})
test.after(() => new Promise((ok) => server.close(ok)))

/** A chain on which NAME is a complete AI service (edit it to break it). / NAME 是完整 AI 服务的链（改它来制造故障）。 */
function world({ manifest = proxy.manifest(), open = true, owner = holder, file = true } = {}) {
  const chain = createActivationChain()   // activated by default; the activation tests (ACT-n) change that / 默认已激活
  if (owner) chain.setOwner('42', owner)
  chain.setAccount('42', ADDR.container)
  chain.setContainerToken(ADDR.container, { tokenId: 42 })
  if (open) chain.setCode(ADDR.container)
  if (file) chain.writeFile(ADDR.container, '.well-known/tapeapi.json', typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  const api = createTapeAPI({ rpcUrls: RPC, quorum: 2, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, factory: ADDR.factory, fetch: chain.fetchWith(), allowHttp: true })
  return { chain, api }
}
const run = (api, target = NAME, o = {}) => diagnose(target, { api, allowHttp: true, fetch: globalThis.fetch, ...o })
const status = (rep) => Object.fromEntries(rep.checks.map((c) => [c.id, c.status]))
const byId = (rep, id) => rep.checks.find((c) => c.id === id)
/** Exactly `id` fails; everything before passes; everything after is skipped. / 恰好 id 失败；之前全过；之后全部跳过。 */
function failsExactlyAt(rep, id) {
  const st = status(rep), at = DOCTOR_CHECKS.indexOf(id)
  assert.equal(st[id], 'fail', `${id} should fail:\n${formatReport(rep, { lang: 'en' })}`)
  for (const [i, c] of DOCTOR_CHECKS.entries()) {
    if (i < at) assert.equal(st[c], 'pass', `${c} before ${id} should pass:\n${formatReport(rep, { lang: 'en' })}`)
    if (i > at) assert.equal(st[c], 'skip', `${c} after ${id} should be skipped:\n${formatReport(rep, { lang: 'en' })}`)
  }
  assert.equal(rep.exitCode, 1)
  const c = byId(rep, id)
  assert.ok(c.fix?.en && c.fix?.zh, 'a failure carries a fix in English and Chinese')
  return c
}
// A port nothing listens on: opened, then closed. / 没有服务监听的端口：先打开再关闭。
const closedPort = async () => { const s = http.createServer(); await new Promise((ok) => s.listen(0, '127.0.0.1', ok)); const { port } = s.address(); await new Promise((ok) => s.close(ok)); return port }
const reset = () => { Object.assign(knobs, { direct: false, tamper: false, nocors: false, setup: false }); makeProxy() }

test('reference AI service: every check passes, in the fixed order, exit 0', async () => {
  reset()
  const { api } = world()
  const rep = await run(api)
  assert.deepEqual(rep.checks.map((c) => c.id), DOCTOR_CHECKS)
  assert.deepEqual(rep.checks.filter((c) => c.status !== 'pass').map((c) => `${c.id}: ${c.detail}`), [], formatReport(rep, { lang: 'en' }))
  assert.equal(rep.exitCode, 0)
  assert.match(byId(rep, 'delegation').detail, /^89 days left|^90 days left/)
  assert.match(byId(rep, 'receipt').detail, /HTTP 401 to an invalid key, receipt verified/)
  assert.match(byId(rep, 'receipt-lookup').detail, /same signature/)
  // Both languages in the text report; the key used is never printed. / 文本报告双语；从不打印所用的密钥。
  const text = formatReport(rep)
  assert.match(text, /A real request gets a verifiable receipt \/ 真实请求拿到可核验的回执/)
  assert.ok(!text.includes(INVALID_KEY))
})

test('with the operator\'s own key: one real call per endpoint, priced receipts', async () => {
  reset()
  const { api } = world()
  const rep = await run(api, NAME, { key: 'sk-real' })
  assert.equal(byId(rep, 'receipt').status, 'pass', formatReport(rep, { lang: 'en' }))
  assert.match(byId(rep, 'receipt').detail, /\(your key\): HTTP 200, model demo-chat, tokens \d+\+\d+, [\d.]+ USDT, receipt verified/)
  assert.ok(!JSON.stringify(rep).includes('sk-real'), 'the key is not in the report')
})

test('broken: a processor that does not exist fails "name"', async () => {
  const { api } = world()
  failsExactlyAt(await run(api, '42.8.tape'), 'name')
})

test('broken: a circuit never minted (the documentation\'s 42.1013.tape today) fails "circuit" and points at the local trial', async () => {
  const { api } = world({ owner: null })
  const c = failsExactlyAt(await run(api), 'circuit')
  assert.match(c.fix.en, /tapeout\.net/); assert.match(c.fix.zh, /示例名/)
  assert.equal(c.next, 'node examples/relay-trial/trial.mjs')
})

test('broken: a container not opened fails "container"', async () => {
  const { api } = world({ open: false })
  const c = failsExactlyAt(await run(api), 'container')
  assert.match(c.detail, /has not been opened/)
})

test('broken: no manifest on chain fails "manifest-file" (the error tapeapi-verify reports as "no file at")', async () => {
  const { api } = world({ file: false })
  const c = failsExactlyAt(await run(api), 'manifest-file')
  assert.match(c.fix.en, /console.*step 5/); assert.match(c.hint.zh, /本地试跑/)
})

test('broken: manifest bytes that do not match the SiteRegistry index fail "manifest-file"', async () => {
  const { api, chain } = world()
  chain.setFileBytes(ADDR.container, '.well-known/tapeapi.json', JSON.stringify(proxy.manifest()).replace('Doctor', 'Dxctor'))
  failsExactlyAt(await run(api), 'manifest-file')
})

test('broken: a manifest that is not valid fails "manifest-format"', async () => {
  const { api } = world({ manifest: '{"tapeapi":"0.1","name":' })
  failsExactlyAt(await run(api), 'manifest-format')
  const { api: api2 } = world({ manifest: { ...proxy.manifest(), container: '0x' + '61'.repeat(20) } })
  failsExactlyAt(await run(api2), 'manifest-format')
})

test('broken: the delegation expired, signed by someone else, or too far ahead fails "delegation"; under 30 days warns', async () => {
  reset()
  const expired = { ...proxy.manifest(), delegation: delegation(nowS() - 60) }
  assert.match(failsExactlyAt(await run(world({ manifest: expired }).api), 'delegation').detail, /^expired on/)
  const stranger = { ...proxy.manifest(), delegation: delegation(nowS() + 90 * 86_400, OTHER_KEY) }
  assert.match(failsExactlyAt(await run(world({ manifest: stranger }).api), 'delegation').detail, /holder is/)
  const far = { ...proxy.manifest(), delegation: delegation(nowS() + 400 * 86_400) }
  assert.match(failsExactlyAt(await run(world({ manifest: far }).api), 'delegation').detail, /366 days/)
  makeProxy(SIGNER_KEY, delegation(nowS() + 10 * 86_400))
  const rep = await run(world().api)
  assert.equal(byId(rep, 'delegation').status, 'warn', formatReport(rep, { lang: 'en' }))
  assert.match(byId(rep, 'delegation').fix.zh, /续期/)
  assert.equal(rep.exitCode, 0, 'a warning alone does not fail')
  reset()
})

test('broken: no ai field (a TapeAPI service that is not an AI service, like 11.1013.tape) fails "ai-field"', async () => {
  const m = proxy.manifest()
  const { ai: _drop, ...plain } = m
  const c = failsExactlyAt(await run(world({ manifest: plain }).api), 'ai-field')
  assert.match(c.detail, /not an AI service/)
})

test('broken: an invalid ai field fails "ai-field"', async () => {
  const m = proxy.manifest()
  const bad = { ...m, ai: { ...m.ai, models: [{ id: 'x', prices: [{ currency: 'USDT', unit: '1M tokens', input: '1' }] }] } }
  const c = failsExactlyAt(await run(world({ manifest: bad }).api), 'ai-field')
  assert.match(c.detail, /output is required/)
})

test('price hints warn and never fail', async () => {
  const m = proxy.manifest()
  const odd = { ...m, ai: { ...m.ai, models: [{ id: 'demo-chat', prices: [{ currency: 'USDT', unit: '1M tokens', input: '5', output: '0.5' }] }, m.ai.models[1]] } }
  const rep = await run(world({ manifest: odd }).api)
  assert.equal(byId(rep, 'prices').status, 'warn')
  assert.match(byId(rep, 'prices').fix.zh, /填反/)
})

test('FIXED DOCR-3: the sidecar down (connection refused) leaves "reach" undecided with a connection hint: exit 3, retry', async () => {
  const m = proxy.manifest()
  const dead = JSON.parse(JSON.stringify(m).replaceAll(sidecarUrl, `http://127.0.0.1:${await closedPort()}`))
  const rep = await run(world({ manifest: dead }).api)
  const c = byId(rep, 'reach')
  assert.equal(c.status, 'error', formatReport(rep, { lang: 'en' }))
  assert.match(c.detail, /refused the connection/); assert.match(c.fix.zh, /启动旁路/); assert.match(c.fix.en, /exit code 3 means: retry/)
  for (const id of ['cors', 'receipt', 'receipt-lookup']) assert.equal(byId(rep, id).status, 'skip')
  assert.equal(rep.exitCode, 3)
})

test('broken: the sidecar in setup mode fails "reach" naming what is missing', async () => {
  reset(); knobs.setup = true
  const c = failsExactlyAt(await run(world().api), 'reach')
  assert.match(c.detail, /SETUP MODE.*DELEGATION_SIG/)
  reset()
})

test('broken: the sidecar signs with another key than the manifest names: "reach" fails', async () => {
  reset()
  const onChain = proxy.manifest()
  makeProxy(OTHER_KEY)   // the running sidecar now signs with another key / 运行中的旁路改用另一把密钥
  const c = failsExactlyAt(await run(world({ manifest: onChain }).api), 'reach')
  assert.match(c.detail, /signs as .* the manifest names/)
  reset()
})

test('broken: the public address goes to the gateway, not through the sidecar: "receipt" fails', async () => {
  reset(); knobs.direct = true
  const rep = await run(world().api)
  const c = byId(rep, 'receipt')
  assert.equal(c.status, 'fail', formatReport(rep, { lang: 'en' }))
  assert.match(c.detail, /does not go through the sidecar/); assert.match(c.fix.zh, /指向旁路/)
  assert.equal(rep.exitCode, 1)
  reset()
})

test('broken: bytes changed after signing: "receipt" fails, the receipt does not verify', async () => {
  reset(); knobs.tamper = true
  const rep = await run(world().api)
  assert.equal(byId(rep, 'receipt').status, 'fail')
  assert.match(byId(rep, 'receipt').detail, /does not verify: responseSha256 does not match/)
  reset()
})

test('CORS stripped by a reverse proxy: "cors" warns, exit 0 (1 with the CLI\'s --strict)', async () => {
  reset(); knobs.nocors = true
  const rep = await run(world().api)
  assert.equal(byId(rep, 'cors').status, 'warn', formatReport(rep, { lang: 'en' }))
  assert.equal(byId(rep, 'receipt').status, 'pass')
  assert.equal(rep.exitCode, 0)
  reset()
})

test('the chain cannot be read: undecided, exit 3 (retry), never a false failure', async () => {
  const { api, chain } = world()
  for (const u of RPC) chain.setFault(u, 'http500')
  const rep = await run(api)
  assert.equal(byId(rep, 'name').status, 'error')
  assert.equal(rep.exitCode, 3)
})

test('URL mode: a sidecar before publishing; on chain it says what is left, offline it checks the service alone', async () => {
  reset()
  // With the chain: identity from the served manifest, not yet published -> manifest-file warns. / 读链：尚未发布 -> 警告。
  const { chain } = world({ file: false })
  const api = createTapeAPI({ rpcUrls: RPC, quorum: 2, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, factory: ADDR.factory, fetch: chain.fetchWith(), allowHttp: true, dev: true })
  const rep = await run(api, sidecarUrl)
  assert.equal(rep.mode, 'url')
  assert.equal(byId(rep, 'manifest-file').status, 'warn', formatReport(rep, { lang: 'en' }))
  for (const id of ['circuit', 'container', 'delegation', 'ai-field', 'reach', 'receipt']) assert.equal(byId(rep, id).status, 'pass', `${id}\n${formatReport(rep, { lang: 'en' })}`)
  // Offline. / 离线。
  const off = await run(null, sidecarUrl, { offline: true })
  assert.equal(off.exitCode, 0, formatReport(off, { lang: 'en' }))
  for (const id of ['circuit', 'container', 'manifest-file']) assert.equal(byId(off, id).status, 'skip')
  assert.match(byId(off, 'delegation').detail, /holder not checked/)
  // Nothing listening: a network failure, undecided, exit 3 (DOCR-3). / 没有服务在监听：网络故障，未判定，退出码 3。
  const none = await run(null, `http://127.0.0.1:${await closedPort()}`, { offline: true })
  assert.equal(byId(none, 'manifest-format').status, 'error')
  assert.equal(none.exitCode, 3)
})

test('URL mode: a freshly started new-api sidecar in setup mode is reported as such, with its signing address', async () => {
  const sc = await startSidecar({ env: { SIGNER_KEY }, port: 0, host: '127.0.0.1', quiet: true, localPublicUrl: true, log: () => {} })
  try {
    const rep = await run(null, sc.url, { offline: true })
    const c = byId(rep, 'manifest-format')
    assert.equal(c.status, 'fail')
    assert.match(c.detail, new RegExp(`SETUP MODE: missing .*DELEGATION_SIG.*signing address is ${signer}`))
    assert.match(c.fix.zh, /身份补齐之前这是正常的/)
  } finally { await sc.close() }
})

// ---- the command / 命令行 ----
function cli(args, env = {}, cwd = ROOT) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { err += d })
    child.on('exit', (code) => ok({ code, out, err }))
  })
}

test('CLI: usage mistakes exit 2; --help names the local trial', async () => {
  assert.equal((await cli([])).code, 2)
  assert.equal((await cli(['not-a-name'])).code, 2)
  assert.equal((await cli(['http://example.com'])).code, 2, 'http only on loopback')
  assert.equal((await cli(['--offline', '11.1013.tape'])).code, 2, '--offline is for a URL')
  assert.equal((await cli(['--key-env', 'sk-live-123', sidecarUrl])).code, 2, '--key-env takes a variable name, never a key')
  assert.equal((await cli(['--key-env', 'NOPE_EMPTY', '--offline', sidecarUrl], { NOPE_EMPTY: '' })).code, 2)
  assert.equal((await cli(['--escrows', 'nope', '11.1013.tape'])).code, 2, '--escrows takes addresses')
  const h = await cli(['--help'])
  assert.equal(h.code, 0)
  assert.match(h.out, /node examples\/relay-trial\/trial\.mjs/)
  assert.match(h.out, /3 the\s+chain or the network could not be read/)
  assert.match(h.out, /--escrows <a,b,\.\.\.>\s+experimental/)
})

test('CLI: --offline --json against the sidecar: exit 0, a JSON report for CI; --lang zh prints Chinese only', async () => {
  reset()
  const r = await cli(['--offline', '--json', sidecarUrl])
  assert.equal(r.code, 0, r.out + r.err)
  const j = JSON.parse(r.out)
  assert.equal(j.tool, 'tapeapi-doctor'); assert.equal(j.ok, true); assert.equal(j.exitCode, 0)
  assert.deepEqual(j.checks.map((c) => c.id), DOCTOR_CHECKS)
  const zh = await cli(['--offline', '--lang', 'zh', sidecarUrl])
  assert.equal(zh.code, 0)
  assert.match(zh.out, /真实请求拿到可核验的回执/)
  assert.ok(!/A real request gets/.test(zh.out))
  knobs.nocors = true
  const strict = await cli(['--offline', '--strict', sidecarUrl])
  assert.equal(strict.code, 1, 'a CORS warning fails under --strict')
  reset()
})

// ---- review of 8c8a7e5: FIXED DOCR-<n> / 8c8a7e5 的审查 ----
const KEY = 'sk-live-SECRET-1234567890'
// A gateway that echoes the caller's key in its 401 body, in several forms / 在 401 正文里以多种形式回显调用方密钥的网关
const echoUpstream = async (u, init) => {
  const h = new Headers(init?.headers ?? (u instanceof Request ? u.headers : {}))
  const given = h.get('x-api-key') || h.get('authorization') || ''
  const bare = given.replace(/^Bearer /, '')
  const message = `Incorrect API key provided: ${bare}. Header was "${given}"; encoded ${encodeURIComponent(bare)}; b64 ${Buffer.from(bare).toString('base64')}`
  return new Response(JSON.stringify({ error: { message } }), { status: 401, headers: { 'content-type': 'application/json' } })
}

test('FIXED DOCR-1: a gateway that echoes the key: the report (text, JSON, onCheck) shows *** and never the key, in any form', async () => {
  reset()
  proxy = createAIProxy({
    upstream: { baseUrl: 'http://fake.local/v1' }, fetch: echoUpstream, signerKey: SIGNER_KEY, models: MODELS, allowHttp: true, rateLimit: false, receiptRateLimit: false, log: () => {},
    manifestBase: { name: 'Doctor test relay', circuits: ADDR.circuits, tokenId: '42', container: ADDR.container, delegation: delegation(nowS() + 90 * 86_400), endpoints: { live: [`${sidecarUrl}/tapeapi/v1`], async: false } },
  })
  const seen = []
  for (const key of [KEY, `Bearer ${KEY}`]) {
    const rep = await run(world().api, NAME, { key, onCheck: (c) => seen.push(JSON.stringify(c)) })
    const receipt = byId(rep, 'receipt')
    assert.equal(receipt.status, 'warn', formatReport(rep, { lang: 'en' }))
    assert.match(receipt.detail, /\(your key\): HTTP 401 \(receipt verified\): .*Incorrect API key provided: \*\*\*/)
    for (const out of [JSON.stringify(rep), formatReport(rep), formatReport(rep, { lang: 'en' }), ...seen]) {
      for (const form of [KEY, encodeURIComponent(KEY), Buffer.from(KEY).toString('base64')]) assert.ok(!out.includes(form), `the key leaked as ${form}`)
    }
  }
  // the CLI: text and --json / 命令行：文本与 --json
  for (const args of [['--offline', '--allow-http', '--key-env', 'DOCTOR_TEST_KEY', sidecarUrl], ['--offline', '--allow-http', '--json', '--key-env', 'DOCTOR_TEST_KEY', sidecarUrl]]) {
    const r = await cli(args, { DOCTOR_TEST_KEY: KEY })
    assert.ok(r.out.includes('Incorrect API key provided: ***'), r.out)
    assert.ok(!r.out.includes(KEY) && !r.err.includes(KEY), 'the CLI prints no key')
  }
  reset()
})

// The manifest a sidecar serves, with the ai endpoints moved to another host (r9) / ai 端点指向另一主机的清单
function divertedFetch(man, calls) {
  return async (url, init = {}) => {
    url = String(url)
    const h = new Headers(init.headers ?? {})
    calls.push({ url, method: init.method ?? 'GET', auth: h.get('authorization') ?? h.get('x-api-key') })
    const j = (o, st = 200, hd = {}) => new Response(JSON.stringify(o), { status: st, headers: { 'content-type': 'application/json', ...hd } })
    if (url.endsWith('/.well-known/tapeapi.json')) return j(man)
    if (url.endsWith('/tapeapi/v1/health')) return j({ ok: true, signer: man.signer })
    if (init.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
    return j({ error: { message: 'no' } }, 401)
  }
}

test('FIXED DOCR-2: the key goes only to the host being checked, over https: never to another host a manifest names, never over http without --allow-http', async () => {
  reset()
  // URL mode: the served manifest points its ai endpoints at another host. Since ONB2-5 every probe goes to the address
  // given, so that host receives nothing at all, the key only the host being checked; the endpoints check warns.
  // 地址模式：清单把 ai 端点指向另一主机。ONB2-5 起所有探测都打给出的地址：那个主机什么都收不到，密钥只发往被检查的主机；端点检查警告。
  const man = JSON.parse(JSON.stringify(proxy.manifest()))
  man.dev = true
  man.ai = { ...man.ai, endpoints: man.ai.endpoints.map((e) => ({ ...e, baseUrl: e.baseUrl.replace(sidecarUrl, 'https://attacker.example') })) }
  const calls = []
  const rep = await diagnose('http://127.0.0.1:8080', { offline: true, allowHttp: true, fetch: divertedFetch(man, calls), key: KEY })
  assert.deepEqual(calls.filter((c) => c.url.includes('attacker.example')), [], 'no request at all goes to the host the manifest names')
  assert.ok(calls.filter((c) => c.auth?.includes(KEY)).every((c) => c.url.startsWith('http://127.0.0.1:8080/')), 'the key goes to the host being checked only')
  assert.ok(calls.some((c) => c.url === 'http://127.0.0.1:8080/v1/chat/completions' && c.method === 'POST'), 'the invalid-key probe runs against the address given')
  assert.match(byId(rep, 'endpoints').detail, /the manifest publishes https:\/\/attacker\.example, not the address you gave \(http:\/\/127\.0\.0\.1:8080\)/)
  // name mode: endpoints.live (signed) on one host, ai endpoints on another / 名字模式：已签名的 endpoints.live 在一处，ai 端点在另一处
  const onChain = JSON.parse(JSON.stringify(proxy.manifest()))
  onChain.ai = man.ai
  const calls2 = []
  const rep2 = await run(world({ manifest: onChain }).api, NAME, { key: KEY, fetch: divertedFetch(onChain, calls2) })
  assert.deepEqual(calls2.filter((c) => c.auth?.includes(KEY)), [])
  assert.match(byId(rep2, 'receipt').detail, /not sent: attacker\.example is not the host being checked/)
  // the right host over plain http: only a loopback host, and only with allowHttp (--allow-http) / 正确主机但为 http：仅回环地址且显式 allowHttp
  const calls3 = []
  const own = JSON.parse(JSON.stringify(proxy.manifest())); own.dev = true
  const rep3 = await diagnose(sidecarUrl, { offline: true, fetch: divertedFetch(own, calls3), key: KEY })
  assert.deepEqual(calls3.filter((c) => c.auth?.includes(KEY)), [])
  assert.match(byId(rep3, 'receipt').detail, /not sent: .* is plain http: .*--allow-http/)
  const calls4 = []
  await diagnose(sidecarUrl, { offline: true, allowHttp: true, fetch: divertedFetch(own, calls4), key: KEY })
  assert.ok(calls4.some((c) => c.auth?.includes(KEY)), 'loopback + allowHttp: sent')
  // the CLI: --allow-http only for a loopback URL / 命令行：--allow-http 只用于回环地址
  assert.equal((await cli(['--allow-http', 'https://api.example.com'])).code, 2)
  assert.equal((await cli(['--allow-http', NAME])).code, 2)
})

test('FIXED DOCR-3: DNS failures and timeouts are undecided (exit 3); a TLS failure is a configuration failure (exit 1)', async () => {
  const thrower = (code, name) => async () => { const e = new TypeError('fetch failed'); if (name) e.name = name; else e.cause = Object.assign(new Error(code), { code }); throw e }
  for (const [f, want] of [[thrower('ENOTFOUND'), 3], [thrower('EAI_AGAIN'), 3], [thrower(null, 'TimeoutError'), 3], [thrower('ECONNREFUSED'), 3], [thrower('CERT_HAS_EXPIRED'), 1]]) {
    const rep = await diagnose('https://api.example.com', { offline: true, fetch: f })
    assert.equal(rep.exitCode, want, formatReport(rep, { lang: 'en' }))
    assert.equal(byId(rep, 'manifest-format').status, want === 3 ? 'error' : 'fail')
  }
})

test('FIXED DOCR-4: the help and the guides say what the probes can cost: a few input tokens and 1 to 16 output tokens per endpoint', async () => {
  const h = await cli(['--help'])
  assert.match(h.out, /1 output token, 16 on\s+openai-responses/)
  assert.match(h.out, /unless your gateway accepts any key/)
  assert.ok(!/1-token answer/.test(h.out))
  const { readFileSync } = await import('node:fs')
  const en = readFileSync(new URL('../../docs/guides/ai-providers.md', import.meta.url), 'utf8')
  const zh = readFileSync(new URL('../../docs/guides/zh-CN/ai-providers.md', import.meta.url), 'utf8')
  assert.match(en, /accepts any key, it answers instead/); assert.match(zh, /接受任意密钥/)
})

// ---- the onboarding review of 1.2.0: FIXED ONB2-<n> / 1.2.0 接入走查 ----
// A stub web: each host answers as the case needs; every request is recorded. / 模拟网络：每个主机按用例应答，记录每个请求。
function stubWeb(routes, calls = []) {
  return async (url, init = {}) => {
    url = String(url); calls.push({ url, method: init.method ?? 'GET' })
    for (const [re, answer] of routes) if (re.test(url)) return typeof answer === 'function' ? answer(url, init) : answer.clone()
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } })
  }
}
const html = (status = 200) => new Response('<html><body><h1>Welcome to nginx!</h1></body></html>', { status, headers: { 'content-type': 'text/html' } })

test('FIXED ONB2-1: the commands the doctor names are the way it was run: a checkout (relative to the working directory), npx from the release package, or an installed package', async () => {
  const bin = fileURLToPath(new URL('../bin/tapeapi-doctor.js', import.meta.url))
  assert.deepEqual(howRun(bin, ROOT), { run: 'checkout', bin: 'sdk/bin/tapeapi-doctor.js', trial: 'examples/relay-trial/trial.mjs' })
  const sub = howRun(bin, `${ROOT}examples/new-api-sidecar`)
  assert.equal(doctorCommands(sub).doctor('x.tape'), 'node ../../sdk/bin/tapeapi-doctor.js x.tape', 'ONB2-3: from examples/new-api-sidecar the path still works')
  // an installed package's path, built so that the exports-map scan (packages.test.mjs) does not read it as an import
  const pkgBin = (prefix) => `${prefix}/node_modules/${'@tapeapi'}/sdk/bin/tapeapi-doctor.js`
  const npx = howRun(pkgBin('/home/u/.npm/_npx/0a1b'), '/home/u', '1.2.0')
  assert.deepEqual(npx, { run: 'npx', version: '1.2.0' })
  assert.equal(doctorCommands(npx).doctor('42.1013.tape'), `npx -y --package=${releaseTgz('1.2.0')} tapeapi-doctor 42.1013.tape`)
  assert.equal(releaseTgz('1.2.0'), 'https://github.com/BruceLanLan/tapeapi/releases/download/v1.2.0/tapeapi-sdk-1.2.0.tgz')
  const inst = doctorCommands(howRun(pkgBin('/srv/app'), '/srv/app', '1.2.0'))
  assert.equal(inst.doctor('42.1013.tape'), 'npx tapeapi-doctor 42.1013.tape')
  assert.match(inst.trial, /git clone .* && npm ci .* && node examples\/relay-trial\/trial\.mjs/, 'a package has no trial: the hint says how to get one')
  // diagnose() uses the commands it is given, in the next command and in the fix / diagnose() 在下一条命令与修复提示里用给定的命令
  const { api } = world({ open: false })
  const c = byId(await run(api, NAME, { commands: doctorCommands(npx) }), 'container')
  assert.equal(c.next, `npx -y --package=${releaseTgz('1.2.0')} tapeapi-doctor ${NAME}`)
  assert.ok(!/node sdk\/bin/.test(JSON.stringify(c)))
  // the command itself, run from a subdirectory of the checkout / 在检出的子目录里运行命令本身
  const h = await cli(['--help'], {}, `${ROOT}examples/new-api-sidecar`)
  assert.match(h.out, /Usage: node \.\.\/\.\.\/sdk\/bin\/tapeapi-doctor\.js \[options\] <target>/)
  assert.match(h.out, /node \.\.\/relay-trial\/trial\.mjs/)
})

test('FIXED ONB2-4: an address that is not the sidecar (a welcome page, broken JSON, 404 everywhere) says: check the reverse proxy and the port', async () => {
  const cases = [
    ['a web server welcome page', [[/./, html()]], /an HTML page/],
    ['broken JSON', [[/tapeapi\.json$/, new Response('{"name":"x"', { headers: { 'content-type': 'application/json' } })]], /invalid JSON/],
    ['404 everywhere', [], /HTTP 404, and no TapeAPI sidecar answers/],
  ]
  for (const [what, routes, detail] of cases) {
    const rep = await diagnose('https://api.example.com', { offline: true, fetch: stubWeb(routes) })
    const c = byId(rep, 'manifest-format')
    assert.equal(c.status, 'fail', what)
    assert.match(c.detail, detail, what)
    assert.match(c.fix.en, /does not reach a TapeAPI sidecar\. Check your reverse proxy and its port/, what)
    assert.match(c.fix.zh, /检查反向代理与端口/, what)
    assert.ok(!/models\.json|variables the sidecar reports/.test(c.fix.en), `${what}: not the sidecar-variables hint`)
    assert.equal(c.next, 'curl -s https://api.example.com/tapeapi/v1/health', what)
  }
  // The sidecar answers its health check but the manifest path is not forwarded / 旁路回答了 health，但清单路径没有被转发
  const part = await diagnose('https://api.example.com', { offline: true, fetch: stubWeb([[/\/tapeapi\/v1\/health$/, new Response(JSON.stringify({ ok: true, signer }), { headers: { 'content-type': 'application/json' } })]]) })
  assert.match(byId(part, 'manifest-format').detail, /the reverse proxy does not forward \/\.well-known\/tapeapi\.json/)
  assert.match(byId(part, 'manifest-format').fix.en, /Forward every path/)
})

test('FIXED ONB2-4: a self-signed certificate is said in words (never DEPTH_ZERO_SELF_SIGNED_CERT), and the next command is the doctor again, not the trial', async () => {
  const tls = (code) => async () => { const e = new TypeError('fetch failed'); e.cause = Object.assign(new Error(code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ? 'self-signed certificate' : code), { code }); throw e }
  for (const [code, words, zh] of [['DEPTH_ZERO_SELF_SIGNED_CERT', /self-signed/, /自签名/], ['CERT_HAS_EXPIRED', /expired/, /过期/], ['ERR_TLS_CERT_ALTNAME_INVALID', /names another host/, /域名与这个地址不符/], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', /intermediate/, /中间证书/]]) {
    const rep = await diagnose('https://api.example.com', { offline: true, fetch: tls(code) })
    const c = byId(rep, 'manifest-format')
    assert.equal(c.status, 'fail'); assert.equal(rep.exitCode, 1)
    assert.match(c.detail, words); assert.match(c.detailZh, zh)
    assert.ok(!formatReport(rep).includes(code), `${code} is not shown`)
    assert.equal(c.next, 'node sdk/bin/tapeapi-doctor.js https://api.example.com')
    assert.equal(c.hint, undefined, 'no "run the local trial" note for a TLS problem')
  }
})

test('FIXED ONB2-4: an opened container with no manifest: the steps in order (sidecar, service key, delegation, publish), not straight to step 5', async () => {
  const { api } = world({ file: false })
  const c = failsExactlyAt(await run(api), 'manifest-file')
  const at = (re) => c.fix.en.search(re)
  assert.ok(at(/run the sidecar/) >= 0 && at(/run the sidecar/) < at(/service key/) && at(/service key/) < at(/delegation/) && at(/delegation/) < at(/publish the manifest \(step 5/), c.fix.en)
  assert.match(c.fix.zh, /运行旁路.*生成服务密钥.*签委托.*发布清单/)
  assert.equal(c.next, 'node sdk/bin/tapeapi-doctor.js <your sidecar URL>')
})

test('FIXED ONB2-5: URL mode probes the address given, not the one the manifest publishes, and warns when they differ', async () => {
  reset()
  // A proxy in front of the sidecar that strips its headers, while the manifest still names the sidecar itself: before
  // the fix the probes went to the sidecar and passed. / 旁路前面一个去掉其响应头的代理，而清单仍写旁路本身：修复前探测打到旁路并通过。
  const strip = http.createServer(async (req, res) => {
    const parts = []; for await (const c of req) parts.push(c)
    const r = await fetch(sidecarUrl + req.url, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k))), body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(parts) })
    res.writeHead(r.status, Object.fromEntries([...r.headers].filter(([k]) => !k.startsWith('x-tapeapi') && k !== 'content-length' && k !== 'content-encoding')))
    res.end(Buffer.from(await r.arrayBuffer()))
  })
  await new Promise((ok) => strip.listen(0, '127.0.0.1', ok))
  try {
    const given = `http://127.0.0.1:${strip.address().port}`
    const calls = []
    const rep = await diagnose(given, { offline: true, fetch: async (u, i) => { calls.push(String(u)); return fetch(u, i) } })
    assert.ok(calls.every((u) => u.startsWith(given + '/')), `every probe goes to ${given}:\n${calls.join('\n')}`)
    assert.equal(byId(rep, 'endpoints').status, 'warn')
    assert.match(byId(rep, 'endpoints').detail, new RegExp(`the manifest publishes ${sidecarUrl}, not the address you gave \\(${given}\\)`))
    assert.match(byId(rep, 'endpoints').fix.en, /PUBLIC_URL/)
    assert.equal(byId(rep, 'receipt').status, 'fail')
    assert.match(byId(rep, 'receipt').detail, /no x-tapeapi-receipt header/)
    // the sidecar itself: the same address, no warning / 旁路本身：同一地址，没有警告
    assert.equal(byId(await diagnose(sidecarUrl, { offline: true }), 'endpoints').status, 'pass')
  } finally { await new Promise((ok) => strip.close(ok)) }
})

test('FIXED ONB2-7: --lang zh prints what went wrong in Chinese, --lang en has no Chinese, usage mistakes are bilingual', async () => {
  const rep = await diagnose('https://api.example.com', { offline: true, fetch: stubWeb([[/./, html()]]) })
  const zh = formatReport(rep, { lang: 'zh' }), en = formatReport(rep, { lang: 'en' })
  assert.ok(!/[一-鿿]/.test(en), `English only:\n${en}`)
  for (const english of ['not checked', 'an HTML page', 'result:', 'next:', 'sidecar URL']) assert.ok(!zh.includes(english), `"${english}" in the Chinese report:\n${zh}`)
  assert.match(zh, /一个 HTML 网页/); assert.match(zh, /未检查："manifest-format" 未通过/); assert.match(zh, /结果：/); assert.match(zh, /下一条命令:/)
  // the undecided case too / 无法判定的情形也一样
  const down = await diagnose('https://api.example.com', { offline: true, fetch: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) } })
  assert.match(formatReport(down, { lang: 'zh' }), /无法判定：.*拒绝连接/)
  // the command: every usage mistake in both languages, and no TapeKit source path / 命令行：每个用法错误都双语，且不暴露 TapeKit 源码路径
  for (const args of [[], ['--lang', 'fr', NAME], ['--bogus'], ['a', 'b'], ['http://example.com'], ['--offline', NAME], ['42.01013.tape']]) {
    const r = await cli(args)
    assert.equal(r.code, 2, args.join(' '))
    const first = r.err.split('\n\n')[0]
    assert.match(first, /[一-鿿]/, `${args.join(' ')}: ${first}`)
    assert.match(first, /tapeapi-doctor: [A-Za-z"-]/, `${args.join(' ')}: ${first}`)
    assert.ok(!/kernel\/src|name what to check/.test(r.err), r.err)
  }
})

// ---- the documents of the onboarding path / 接入路径上的文档 ----
const doc = (p) => readFileSync(`${ROOT}${p}`, 'utf8')
// the current release: the documents name the package of the version being released, whatever it is
// 当前版本：文档写的是正在发布的那个版本的安装包，不写死版本号
const TGZ = releaseTgz(JSON.parse(doc('sdk/package.json')).version)
const GUIDES = ['docs/guides/ai-providers.md', 'docs/guides/zh-CN/ai-providers.md']
/** The table rows of "From zero to live", keyed by step number. / “从零到上线”表格的各行，按步骤号取。 */
const stepRows = (text) => Object.fromEntries(text.split('\n').filter((l) => /^\| [0-7]b? \|/.test(l)).map((l) => [l.split('|')[1].trim(), l]))

test('FIXED ONB2-1: the documents say tapeapi-doctor ships in the release package, give its npx form, and write steps 1 to 7 one way', () => {
  for (const p of [...GUIDES, 'sdk/README.md', 'sdk/src/doctor.js']) {
    const t = doc(p)
    assert.ok(!/1\.1\.0 (package|的发布包)|from a checkout of (this|the) repository for now|目前从本仓库的检出运行|Until tapeapi-doctor ships in a release|进入发布包之前/.test(t), `${p} still says the doctor is not released`)
  }
  for (const p of [...GUIDES, 'sdk/README.md']) assert.ok(doc(p).includes(`npx -y --package=${TGZ} tapeapi-doctor`), `${p}: the npx form`)
  for (const p of GUIDES) {
    const rows = stepRows(doc(p))
    assert.deepEqual(Object.keys(rows).sort(), ['0', '1', '2', '2b', '3', '4', '5', '6', '7'], p)
    for (const n of ['1', '2', '3', '4', '5', '7']) {
      assert.match(rows[n], /`tapeapi-doctor (--offline )?(<[^>]+>|https:\/\/api\.example\.com)`/, `${p} step ${n}`)
      assert.ok(!rows[n].includes('node sdk/bin'), `${p} step ${n} is written one way`)
    }
  }
})

test('FIXED ONB2-2: step 0 says to run npm ci at the repository root first, everywhere it is given', () => {
  for (const p of [...GUIDES, 'README.md', 'README.zh-CN.md', 'examples/relay-trial/README.md']) {
    const t = doc(p)
    const trial = t.indexOf('node examples/relay-trial/trial.mjs')
    assert.ok(trial > 0, p)
    const ci = t.indexOf('npm ci')
    assert.ok(ci > 0 && ci < trial, `${p}: npm ci comes before the trial`)
    assert.ok(!/npm install --no-audit/.test(t), `${p}: npm ci, not npm install`)
  }
  for (const p of GUIDES) assert.match(stepRows(doc(p))['0'], /npm ci/, `${p}: step 0 names npm ci`)
})

test('FIXED ONB2-3: after `cd examples/new-api-sidecar` no document runs node sdk/bin/... as if at the root', () => {
  for (const p of [...GUIDES, 'examples/new-api-sidecar/README.md']) {
    for (const block of doc(p).split('```').filter((_, i) => i % 2 === 1)) {
      if (!/cd [^\n]*examples\/new-api-sidecar/.test(block)) continue
      assert.ok(!/(^|\s)node sdk\/bin\//.test(block), `${p}: ${block}`)
    }
  }
  const t = doc('examples/new-api-sidecar/README.md')
  assert.ok(!/(^|[\s`])node sdk\/bin\/tapeapi-doctor/.test(t), 'the package README, read inside examples/new-api-sidecar, never names the root-relative path')
  assert.match(t, /node \.\.\/\.\.\/sdk\/bin\/tapeapi-doctor\.js/)
  for (const p of GUIDES) assert.match(doc(p), /node \.\.\/\.\.\/sdk\/bin\/tapeapi-doctor\.js/, p)
})

test('FIXED ONB2-6: every bash client line has its PowerShell form, and tapeapi-verify is said to need a second terminal', () => {
  for (const p of [...GUIDES, 'README.md', 'README.zh-CN.md', 'sdk/README.md', 'examples/new-api-sidecar/README.md']) {
    const t = doc(p)
    assert.ok(t.includes('ANTHROPIC_BASE_URL=http://127.0.0.1:8790 claude'), p)
    assert.ok(t.includes('$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8790"; claude'), `${p}: PowerShell for Claude Code`)
    assert.ok(t.includes('$env:OPENAI_BASE_URL="http://127.0.0.1:8790/v1"; codex'), `${p}: PowerShell for Codex`)
    assert.match(t, /second terminal|Terminal 2|第二个终端|终端 2/, `${p}: a second terminal`)
    // the verifying proxy and the client never share one code block / 核验代理与客户端不在同一个代码块里
    for (const block of t.split('```').filter((_, i) => i % 2 === 1)) assert.ok(!(block.includes('tapeapi-verify 42') && block.includes('claude')), `${p}: ${block}`)
  }
})

test('FIXED ONB2-7: the documents agree on key names and Codex, mark the doctor experimental, and say the server package needs the SDK package', () => {
  for (const p of [...GUIDES, 'README.md', 'README.zh-CN.md']) {
    const t = doc(p)
    assert.ok(!t.includes('RELAY_KEY'), `${p}: API_KEY, as in the README`)
    assert.match(t, /OPENAI_BASE_URL/, p); assert.match(t, /config\.toml/, p)
  }
  assert.match(doc(GUIDES[0]), /`tapeapi-doctor` \(experimental\)/); assert.match(doc(GUIDES[0]), /It is experimental/)
  assert.match(doc(GUIDES[1]), /`tapeapi-doctor`（实验性）/); assert.match(doc(GUIDES[1]), /它是实验性的/)
  const ver = JSON.parse(doc('sdk/package.json')).version.replaceAll('.', '\\.')   // the current release / 当前版本
  const both = new RegExp(`npm install https://\\S+tapeapi-sdk-${ver}\\.tgz https://\\S+tapeapi-server-${ver}\\.tgz`)
  assert.match(doc('README.md'), both); assert.match(doc('README.zh-CN.md'), both)
  assert.match(doc('README.md'), /fails with a 404/); assert.match(doc('README.zh-CN.md'), /报 404/)
  const ignore = doc('.gitignore')
  assert.match(ignore, /^examples\/new-api-sidecar\/data\/$/m); assert.match(ignore, /^examples\/new-api-sidecar\/logs\/$/m)
})

// ---------------------------------------------------------------------------------------------------------------------
// Activation (TAP-10 §6.3, TAP-11): the name must be activated on DomainBinding, or a TAP-11 client answers `unpaid`.
// 激活：名字必须在 DomainBinding 上激活，否则按 TAP-11 的客户端得到 unpaid。只警告，绝不改变其它检查的结果。
// The chain is sdk/test/helpers/activation-chain.mjs (the fake chain plus a DomainBinding).
// ---------------------------------------------------------------------------------------------------------------------
const actWorld = (setup) => { reset(); const w = world(); setup?.(w.chain); return w }
const others = (rep) => Object.fromEntries(Object.entries(status(rep)).filter(([id]) => id !== 'activation'))

test('ACT-1: isLive(name, container) true, isContainerLive false: activated (pass), read with the on-chain name, exit 0', async () => {
  const { api, chain } = actWorld((c) => c.setActivation({ names: [[NAME, ADDR.container]], containerLive: false, paidUntil: 0 }))
  const rep = await run(api)
  const a = byId(rep, 'activation')
  assert.equal(a.status, 'pass', formatReport(rep, { lang: 'en' }))
  assert.match(a.detail, /^activated: isLive\(name, container\) is true$/)   // no expiry known: not shown / 到期未知：不显示
  assert.match(a.detailZh, /已激活：isLive\(名字, 容器\) 为真/)
  assert.equal(rep.exitCode, 0)
  const live = chain.activation.calls.find((c) => c.fn === 'isLive')
  assert.deepEqual(live.args, [NAME, ADDR.container], 'isLive gets the canonical on-chain name (with .tape) and the container derived from it')
  assert.equal(live.url.startsWith('http://rpc'), true)
  assert.ok(!chain.activation.calls.some((c) => c.fn === 'monthlyFee'), 'no fee is read for an activated name')
})

test('ACT-2: only isContainerLive true (one payment per container): activated, with the date it is paid until', async () => {
  const until = nowS() + 40 * 86_400
  const { api } = actWorld((c) => c.setActivation({ names: [], containerLive: true, paidUntil: until }))
  const rep = await run(api)
  const a = byId(rep, 'activation')
  assert.equal(a.status, 'pass', formatReport(rep, { lang: 'en' }))
  assert.match(a.detail, new RegExp(`^activated: isContainerLive\\(container\\) is true; paid until ${new Date(until * 1000).toISOString().slice(0, 10)} \\(containerPaidUntil\\)$`))
  assert.match(a.detailZh, /已激活：isContainerLive\(容器\) 为真；已付费至 \d{4}-\d{2}-\d{2}（containerPaidUntil）/)
  assert.equal(rep.exitCode, 0)
})

test('ACT-3: both false: a WARNING (not a failure) naming unpaid, the current monthlyFee and the bind call; every other check unchanged; exit 0', async () => {
  const activated = await run(actWorld().api)
  const { api, chain } = actWorld((c) => c.setUnactivated({ fee: 12_500_000_000_000_000n }))
  const rep = await run(api)
  const a = byId(rep, 'activation')
  assert.equal(a.status, 'warn', formatReport(rep, { lang: 'en' }))
  assert.match(a.detail, /^42\.7\.tape is not activated: isLive and isContainerLive are both false\. Under TAP-11 a client gets "unpaid" and does not resolve this service; the site files stay readable \(TAP-10 §6\.3\)\./)
  assert.match(a.detail, /The fee now: 0\.0125 BNB per 30 days \(monthlyFee\(\), read from the chain just now; it can change at any time\)\./)
  assert.match(a.detailZh, /尚未激活：isLive 与 isContainerLive 都为假。按 TAP-11，客户端会得到 unpaid、不解析此服务；站点文件仍可读取（TAP-10 §6\.3）。/)
  assert.match(a.detailZh, /当前月费：每 30 天 0\.0125 BNB（monthlyFee\(\)/)
  assert.match(a.fix.en, new RegExp(`bind\\("42\\.7\\.tape", ${ADDR.container}, months\\).*months x monthlyFee\\(\\) in BNB.*you pay it, plus gas`))
  assert.match(a.fix.zh, /调用 bind\("42\.7\.tape", 0x6060[0-9a-f]+, 月数\)，付 月数 × monthlyFee\(\)（BNB；费用与 gas 由你自己承担/)
  assert.ok(a.fix.en.includes(`DomainBinding (${CHAINS[56].binding})`), 'the fix names the DomainBinding of the chain')
  assert.ok(!/\b0\.01\b/.test(a.fix.en + a.fix.zh), 'no fee is written into the hint: it is read from the chain')
  // not a failure: exit 0, and the other thirteen checks are what they were / 不是失败：退出码 0，其余 13 项不变
  assert.equal(rep.exitCode, 0); assert.equal(rep.ok, true); assert.equal(rep.counts.warn, 1); assert.equal(rep.counts.fail, 0)
  assert.deepEqual(others(rep), others(activated))
  assert.equal(Object.keys(others(rep)).length, 13)
  assert.ok(chain.activation.calls.some((c) => c.fn === 'monthlyFee'))
  assert.match(formatReport(rep), /WARN {2}Name is activated \(TAP-10 §6\.3\) \/ 名字已激活（TAP-10 §6\.3）/)
})

test('ACT-3b: the fee that cannot be read is left out, the warning stays', async () => {
  const { api } = actWorld((c) => c.setUnactivated({ fee: null }))
  const rep = await run(api)
  const a = byId(rep, 'activation')
  assert.equal(a.status, 'warn')
  assert.ok(!/The fee now/.test(a.detail) && !/当前月费/.test(a.detailZh))
  assert.equal(rep.exitCode, 0)
})

test('ACT-3c: a warning on activation does not hide a later failure: it stays a warning, the failure is named by its own check', async () => {
  reset()
  const w = world({ file: false }); w.chain.setUnactivated()
  const rep = await run(w.api)
  assert.equal(byId(rep, 'activation').status, 'warn')
  assert.equal(byId(rep, 'manifest-file').status, 'fail')
  assert.equal(rep.exitCode, 1)
  for (const id of ['manifest-format', 'delegation', 'ai-field', 'receipt-lookup']) {
    assert.equal(byId(rep, id).status, 'skip'); assert.match(byId(rep, id).detail, /"manifest-file" did not pass/, id)
  }
})

test('ACT-4: isContainerLive reverts (a payment contract without it) = false (TAP-10 §6.3): with isLive true still activated, otherwise the warning, never an error', async () => {
  let r = await run(actWorld((c) => c.setActivation({ names: [[NAME, ADDR.container]], containerLive: 'revert', paidUntil: 0 })).api)
  assert.equal(byId(r, 'activation').status, 'pass', formatReport(r, { lang: 'en' }))
  assert.match(byId(r, 'activation').detail, /isLive\(name, container\) is true/)
  assert.equal(r.exitCode, 0)
  const { api, chain } = actWorld((c) => c.setUnactivated({ containerLive: 'revert' }))
  r = await run(api)
  assert.equal(byId(r, 'activation').status, 'warn', formatReport(r, { lang: 'en' }))
  assert.equal(r.exitCode, 0); assert.equal(r.counts.error, 0)
  assert.ok(chain.activation.calls.some((c) => c.fn === 'isContainerLive'), 'it was asked')
  assert.ok(chain.activation.calls.some((c) => c.fn === 'monthlyFee'))
})

test('ACT-5: the chain cannot be read (the nodes fail on the DomainBinding reads): activation is "error" (undecided), exit 3, nothing after it is decided', async () => {
  for (const failure of ['http500', 'rpcerror']) {
    const { api } = actWorld((c) => c.setActivation({ failure }))
    const rep = await run(api)
    const a = byId(rep, 'activation')
    assert.equal(a.status, 'error', `${failure}: ${formatReport(rep, { lang: 'en' })}`)
    assert.match(a.detail, /^could not decide: /)
    assert.match(a.fix.en, /exit code 3 means: retry/)
    assert.equal(rep.exitCode, 3)
    for (const id of ['name', 'circuit', 'container']) assert.equal(byId(rep, id).status, 'pass', `${failure}: ${id} read before it is not changed`)
    for (const id of ['manifest-file', 'manifest-format', 'delegation', 'receipt-lookup']) assert.equal(byId(rep, id).status, 'skip', `${failure}: ${id}`)
  }
})

test('ACT-6: container mode: only isContainerLive can be read (a container address does not give the name); the warning says so', async () => {
  const { api, chain } = actWorld((c) => c.setUnactivated())
  const rep = await run(api, ADDR.container)
  const a = byId(rep, 'activation')
  assert.equal(a.status, 'warn', formatReport(rep, { lang: 'en' }))
  assert.match(a.detail, /isContainerLive is false\..*Container mode: isLive was not checked/)
  assert.match(a.detailZh, /容器地址模式：没有检查 isLive/)
  assert.ok(!chain.activation.calls.some((c) => c.fn === 'isLive'))
  assert.equal(rep.exitCode, 0)
  const ok = await run(actWorld().api, ADDR.container)
  assert.equal(byId(ok, 'activation').status, 'pass')
})

test('ACT-7: URL mode has no name: activation is skipped with the way to check it, and nothing else changes', async () => {
  reset()
  const { chain } = world({ file: false })
  chain.setUnactivated()   // even an unpaid container: URL mode does not warn about what it cannot know / 未付费也不警告：地址模式不知道名字
  const api = createTapeAPI({ rpcUrls: RPC, quorum: 2, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, factory: ADDR.factory, fetch: chain.fetchWith(), allowHttp: true, dev: true })
  const rep = await run(api, sidecarUrl)
  const a = byId(rep, 'activation')
  assert.equal(a.status, 'skip'); assert.match(a.detail, /run the doctor with your TapeOut name/)
  assert.equal(byId(rep, 'container').status, 'pass'); assert.equal(byId(rep, 'manifest-file').status, 'warn'); assert.equal(rep.exitCode, 0)
  assert.equal(chain.activation.calls.length, 0, 'no DomainBinding read in URL mode')
  const off = await diagnose(sidecarUrl, { offline: true, allowHttp: true })
  assert.equal(byId(off, 'activation').status, 'skip')
  assert.deepEqual(off.checks.map((c) => c.id), DOCTOR_CHECKS)
})

test('ACT-8: 14 checks, activation between container and manifest-file, in the help and in both guides', async () => {
  assert.equal(DOCTOR_CHECKS.length, 14)
  assert.deepEqual(DOCTOR_CHECKS.slice(2, 5), ['container', 'activation', 'manifest-file'])
  const h = await cli(['--help'])
  assert.match(h.out, /14 checks, in order: name, circuit, container, activation, manifest-file/)
  assert.match(h.out, /14 项检查，依次为：名字、电路、容器、激活、清单文件/)
  assert.match(h.out, /--strict makes that warning fail too/)
  for (const p of GUIDES) {
    const t = doc(p)
    assert.match(t, /TAP-10 §6\.3/, p)
    assert.match(stepRows(t)['2b'], /bind\(.*monthlyFee\(\)/, `${p}: step 2b says the command and who pays`)
    assert.match(stepRows(t)['2b'], /`activation` (passes|通过)/, `${p}: step 2b says what you should see`)
  }
  assert.match(doc('sdk/README.md'), /14 checks/)
})

test('ACT-9: the activation read is read-only eth_call to the chain\'s DomainBinding, in a fixed order, and costs at most 3 reads', async () => {
  const { api, chain } = actWorld((c) => c.setUnactivated())
  await run(api)
  const fns = [...new Set(chain.activation.calls.map((c) => c.fn))]
  assert.deepEqual(fns, ['isLive', 'isContainerLive', 'monthlyFee'])
  assert.deepEqual(chain.activation.calls.filter((c) => c.url === 'http://rpc1').map((c) => c.fn), ['isLive', 'isContainerLive', 'monthlyFee'])
  const live = await actWorld()
  await run(live.api)
  assert.deepEqual(live.chain.activation.calls.filter((c) => c.url === 'http://rpc1').map((c) => c.fn), ['isLive', 'isContainerLive', 'containerPaidUntil'])
})

test('escrows (experimental): a contribution that differs across escrow instances is a note, never a check or a failure', async () => {
  const E1 = '0x' + '40'.repeat(20), E2 = '0x' + '41'.repeat(20)
  const { chain, api } = world()
  // (the differing case itself is in escrow-token.test.mjs: the fake keeps one contribution per provider)
  // （不一致的情形见 escrow-token.test.mjs：假链按提供者只存一个值）
  chain.setContribution(ADDR.container, 0)
  const same = await run(api, NAME, { escrows: [E1, E2] })
  assert.deepEqual(same.checks.map((c) => c.id), DOCTOR_CHECKS, 'still the 14 checks')
  assert.deepEqual(same.warnings, [], 'the same everywhere: nothing to say')
  // E2 is an escrow whose contributionOf reverts: partly read, said so / E2 的 contributionOf 回滚：只读到一部分，如实说明
  chain.markLegacyEscrow(E2)
  const part = await run(api, NAME, { escrows: [E1, E2] })
  assert.equal(part.exitCode, same.exitCode, 'a note never changes the exit code')
  assert.equal(part.warnings.length, 1)
  assert.match(part.warnings[0].detail, /only partly read/)
  assert.match(formatReport(part, { lang: 'en' }), /note: contribution across escrow instances only partly read/)
  assert.match(formatReport(part, { lang: 'zh' }), /提示: 多个托管实例上的贡献比例只读到一部分/)
  await assert.rejects(run(api, NAME, { escrows: ['nope'] }), (e) => e.code === 'INVALID_ARGUMENT')
  const none = await run(api, NAME)
  assert.equal(none.warnings, undefined, 'without escrows the report is as before')
  // differing: E1 answers 100 (the fake's value), E3 answers 0 through a wrapper / 不一致：E1 答 100，E3 经包装答 0
  const E3 = '0x' + '44'.repeat(20)
  chain.setContribution(ADDR.container, 100)
  const { functionBySelector, encodeReturn } = await import('../src/abi.js')
  const zero = (req) => (req.method === 'eth_call' && req.params[0].to.toLowerCase() === E3 && functionBySelector(req.params[0].data) === 'contributionOf') ? { jsonrpc: '2.0', id: req.id, result: encodeReturn('contributionOf', [0n]) } : null
  const rpcFetch = async (u, init) => {
    const body = JSON.parse(init.body)
    const json = (x) => new Response(JSON.stringify(x), { headers: { 'content-type': 'application/json' } })
    if (!Array.isArray(body)) return zero(body) ? json(zero(body)) : chain.fetch(u, init)
    return json(await Promise.all(body.map(async (req) => zero(req) ?? (await chain.fetch(u, { ...init, body: JSON.stringify(req) })).json())))
  }
  const api3 = createTapeAPI({ rpcUrls: RPC, quorum: 2, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, factory: ADDR.factory, allowHttp: true, fetch: (u, i) => (String(u).startsWith('http://rpc') ? rpcFetch(String(u), i) : fetch(u, i)) })
  const diff = await run(api3, NAME, { escrows: [E1, E3] })
  assert.equal(diff.exitCode, same.exitCode)
  assert.equal(diff.warnings.length, 1)
  assert.match(diff.warnings[0].detail, /differs across escrow instances: .*100 bps, .*0 bps/)
  assert.match(diff.warnings[0].detailZh, /贡献比例不一致/)
  assert.match(formatReport(diff, { lang: 'both' }), /note: the contribution of .* differs[\s\S]*提示: .*贡献比例不一致/)
})
