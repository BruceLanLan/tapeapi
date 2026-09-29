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
import { createTapeAPI } from '../src/index.js'
import { diagnose, formatReport, DOCTOR_CHECKS, INVALID_KEY } from '../src/doctor.js'
import { privateKeyToAddress, signDigest, delegationDigest } from '../src/sig.js'
import { createFakeChain, ADDR } from './helpers/fake-chain.mjs'
import { createAIProxy } from '../../server/src/ai-proxy.js'
import { createFakeUpstream } from '../../examples/ai-proxy/fake-upstream.mjs'
import { startSidecar } from '../../examples/new-api-sidecar/server.mjs'

const BIN = fileURLToPath(new URL('../bin/tapeapi-doctor.js', import.meta.url))
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
  const chain = createFakeChain()
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
function cli(args, env = {}) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
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
  const h = await cli(['--help'])
  assert.equal(h.code, 0)
  assert.match(h.out, /node examples\/relay-trial\/trial\.mjs/)
  assert.match(h.out, /3 the\s+chain or the network could not be read/)
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
  // URL mode: the served manifest points its ai endpoints at another host / 地址模式：清单把 ai 端点指向另一主机
  const man = JSON.parse(JSON.stringify(proxy.manifest()))
  man.dev = true
  man.ai = { ...man.ai, endpoints: man.ai.endpoints.map((e) => ({ ...e, baseUrl: e.baseUrl.replace(sidecarUrl, 'https://attacker.example') })) }
  const calls = []
  const rep = await diagnose('http://127.0.0.1:8080', { offline: true, allowHttp: true, fetch: divertedFetch(man, calls), key: KEY })
  assert.deepEqual(calls.filter((c) => c.auth?.includes(KEY)), [], 'no request carries the key')
  assert.ok(calls.some((c) => c.url.startsWith('https://attacker.example') && c.method === 'POST'), 'the invalid-key probe still runs')
  assert.match(byId(rep, 'receipt').detail, /\(your key\): not sent: attacker\.example is not the host being checked \(127\.0\.0\.1:8080\)/)
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
