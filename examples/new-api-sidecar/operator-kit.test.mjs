// The operator's kit for a new-api relay (OPERATOR-KIT.md): GET / and OPERATOR_SITE_URL, a signing key made on the
// operator's own server (never printed), the compose fragment that adds the sidecar to an existing new-api compose,
// add-sidecar.sh (run with a stand-in `docker`, so no container starts) and the Worker's wrangler.toml.
// Network-free: loopback only, no Docker.
// 运营者工具包：GET / 与 OPERATOR_SITE_URL、在运营者自己服务器上生成的签名密钥（从不打印）、把旁路加进现有 new-api compose 的片段、
// add-sidecar.sh（用替身 docker 运行，不启动任何容器）以及 Worker 的 wrangler.toml。不联网（只用回环地址），不用 Docker。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { sig } from '@tapeapi/sdk'
import { readConfig, createSidecar, startSidecar, operatorSiteOf, ensureSignerKeyFile, CONSOLE_URL } from './server.mjs'
import { throwawayIdentity, EXAMPLE_MODELS } from './smoke.mjs'
import worker, { operatorSite, build as buildWorker } from '../ai-proxy/worker.js'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const read = (p) => readFileSync(here(p), 'utf8')
const tmp = mkdtempSync(join(tmpdir(), 'operator-kit-'))
test.after(() => rmSync(tmp, { recursive: true, force: true }))
const complete = (extra = {}) => ({ ...throwawayIdentity(), PUBLIC_URL: 'https://tape.example.com', MODELS_FILE: EXAMPLE_MODELS, FORMATS: 'all', ...extra })
const quietLog = { log: () => {} }
const KEY_HEX = /(0x)?[0-9a-fA-F]{64}/
const get = (s, path, method = 'GET') => s.handleRequest(new Request(`https://tape.example.com${path}`, { method }))

test('E8-1: GET / is unchanged without OPERATOR_SITE_URL: 404 NOT_FOUND when running, 503 in setup mode, never the console', async () => {
  const running = createSidecar(complete(), quietLog)
  assert.equal(running.state.ok, true, running.state.problem)
  const r = await get(running, '/')
  assert.equal(r.status, 404)
  assert.equal((await r.json()).error.code, 'NOT_FOUND')
  assert.equal(r.headers.get('location'), null)
  assert.equal((await get(running, '/', 'HEAD')).status, 404)
  const setup = createSidecar({}, quietLog)
  const s = await get(setup, '/')
  assert.equal(s.status, 503)
  assert.equal(s.headers.get('location'), null)
  // The holder console's address is never a default destination. / 持有人操作台的地址从不是默认去处。
  for (const res of [r, s]) assert.notEqual(res.headers.get('location'), CONSOLE_URL)
})

test('E8-2: OPERATOR_SITE_URL: GET / and HEAD / answer 302 to it exactly, nothing added; other paths and methods unchanged', async () => {
  const s = createSidecar(complete({ OPERATOR_SITE_URL: 'https://www.example.com/zh/' }), quietLog)
  assert.equal(s.state.ok, true, s.state.problem)
  assert.equal(s.config.operatorSiteUrl, 'https://www.example.com/zh/')
  for (const method of ['GET', 'HEAD']) {
    const r = await get(s, '/', method)
    assert.equal(r.status, 302)
    assert.equal(r.headers.get('location'), 'https://www.example.com/zh/')
    assert.equal(r.headers.get('cache-control'), 'no-store')
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer')
  }
  // A query on the request is not carried over: the location is the configured one. / 请求上的查询串不会带过去。
  assert.equal((await get(s, '/?aff=abc')).headers.get('location'), 'https://www.example.com/zh/')
  assert.equal((await get(s, '/index.html')).status, 404)
  assert.equal((await get(s, '/', 'POST')).status, 404)
  const health = await get(s, '/tapeapi/v1/health')
  assert.equal(health.status, 200)
  assert.equal((await get(s, '/.well-known/tapeapi.json')).status, 200)
  // Setup mode too, so a link to the sidecar's host lands on the operator's site. / 设置模式下也跳转。
  const setup = createSidecar({ OPERATOR_SITE_URL: 'https://www.example.com', PUBLIC_URL: 'https://tape.example.com' }, quietLog)
  assert.equal(setup.state.ok, false)
  const r = await get(setup, '/')
  assert.equal(r.status, 302)
  assert.equal(r.headers.get('location'), 'https://www.example.com/')
  assert.equal((await get(setup, '/tapeapi/v1/health')).status, 200)
})

test('E8-3: a wrong OPERATOR_SITE_URL is setup mode with one sentence naming it, and never a redirect', async () => {
  const cases = [
    ['http://www.example.com', /must be https/],
    ['https://www.example.com/?aff=abc', /must not carry credentials, a query or a fragment/],
    ['https://www.example.com/#top', /must not carry credentials, a query or a fragment/],
    ['https://user:pw@www.example.com', /must not carry credentials/],
    [CONSOLE_URL, /must be your own site, not tapeapi\.fun/],
    ['https://tapeapi.fun', /not tapeapi\.fun/],
    ['https://docs.tapeapi.fun/x', /not tapeapi\.fun/],
    ['https://TAPEAPI.FUN./', /not tapeapi\.fun/],
    ['https://tape.example.com/', /another site than the sidecar's own PUBLIC_URL/],
    ['not a url', /must be a URL/],
    [`https://www.example.com/${'a'.repeat(200)}`, /at most 200 characters/],
  ]
  for (const [value, re] of cases) {
    const st = readConfig(complete({ OPERATOR_SITE_URL: value }))
    assert.equal(st.ok, false, value)
    assert.match(st.problem, /^OPERATOR_SITE_URL /, value)
    assert.match(st.problem, re, value)
    const s = createSidecar(complete({ OPERATOR_SITE_URL: value }), quietLog)
    assert.equal((await get(s, '/')).status, 503, value)
  }
  // http only for a loopback site (local testing); blank is unset. / http 只限回环地址；空白即未设。
  assert.equal(operatorSiteOf('http://127.0.0.1:3000').url, 'http://127.0.0.1:3000/')
  assert.equal(operatorSiteOf('  ').url, null)
  assert.equal(readConfig(complete({ OPERATOR_SITE_URL: '' })).ok, true)
})

test('E8-4: the Worker answers GET / the same way (operatorSite), and as before when unset or wrong', async () => {
  assert.equal(operatorSite({ OPERATOR_SITE_URL: 'https://www.example.com' }), 'https://www.example.com/')
  for (const v of ['http://www.example.com', 'https://www.example.com/?aff=1', CONSOLE_URL, 'https://x.tapeapi.fun', 'nope', `https://a.example/${'x'.repeat(200)}`]) assert.equal(operatorSite({ OPERATOR_SITE_URL: v }), null, v)
  assert.equal(operatorSite({ OPERATOR_SITE_URL: 'https://tape.example.com/', PUBLIC_URL: 'https://tape.example.com' }), null)
  const r = await worker.fetch(new Request('https://tape.example.com/'), { OPERATOR_SITE_URL: ' https://www.example.com ' })
  assert.equal(r.status, 302)
  assert.equal(r.headers.get('location'), 'https://www.example.com/')
  const other = await worker.fetch(new Request('https://tape.example.com/x'), { OPERATOR_SITE_URL: 'https://www.example.com' })
  assert.notEqual(other.status, 302)
  const unset = await worker.fetch(new Request('https://tape.example.com/'), {})
  assert.notEqual(unset.status, 302)
  assert.equal(unset.headers.get('location'), null)
})

test('E8-5: ensureSignerKeyFile makes a key file (0600, exclusive) only when asked, and logs the address, never the key', () => {
  const dir = join(tmp, 'keys-a'); mkdirSync(dir)
  const file = join(dir, 'signer.key')
  const lines = []
  const log = (l) => lines.push(l)
  // Off unless SIGNER_KEY_GENERATE=1. / 不设 SIGNER_KEY_GENERATE=1 就什么都不做。
  assert.deepEqual(ensureSignerKeyFile({ SIGNER_KEY_FILE: file }, { log }), { created: false, why: 'off' })
  assert.equal(existsSync(file), false)
  assert.equal(ensureSignerKeyFile({ SIGNER_KEY_GENERATE: '1', SIGNER_KEY_FILE: file, SIGNER_KEY: sig.randomPrivateKey() }, { log }).why, 'SIGNER_KEY is set')
  assert.equal(existsSync(file), false)
  assert.equal(ensureSignerKeyFile({ SIGNER_KEY_GENERATE: '1', SIGNER_KEY_FILE: file, SIGNER_ADDRESS: '0x' + '11'.repeat(20) }, { log }).why, 'SIGNER_ADDRESS is set')
  assert.equal(existsSync(file), false)
  assert.match(lines.at(-1), /does not exist and SIGNER_ADDRESS is set: no new key was created/)

  const r = ensureSignerKeyFile({ SIGNER_KEY_GENERATE: '1', SIGNER_KEY_FILE: file }, { log })
  assert.equal(r.created, true)
  const key = readFileSync(file, 'utf8').trim()
  assert.match(key, /^0x[0-9a-f]{64}$/)
  assert.equal(r.signer, sig.privateKeyToAddress(key))
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
  const said = lines.join('\n')
  assert.ok(said.includes(r.signer), 'the address is said')
  assert.ok(!said.includes(key.slice(2)), 'the key is never said')
  assert.doesNotMatch(said, KEY_HEX)
  // The sidecar reads it as SIGNER_KEY_FILE, and a second call keeps it. / 旁路按 SIGNER_KEY_FILE 读取；再调用一次保持不变。
  assert.equal(readConfig({ SIGNER_KEY_FILE: file }).signer, r.signer)
  assert.deepEqual(ensureSignerKeyFile({ SIGNER_KEY_GENERATE: '1', SIGNER_KEY_FILE: file }, { log }), { created: false, why: 'exists' })
  assert.equal(readFileSync(file, 'utf8').trim(), key)
  // Exclusive create: a file that appears in between is never overwritten. / 独占创建：中途出现的文件绝不被覆盖。
  const raced = join(dir, 'raced.key')
  const other = sig.randomPrivateKey()
  const out = ensureSignerKeyFile({ SIGNER_KEY_GENERATE: '1', SIGNER_KEY_FILE: raced }, { log, randomKey: () => { writeFileSync(raced, other); return sig.randomPrivateKey() } })
  assert.equal(out.created, false)
  assert.equal(out.why, 'EEXIST')
  assert.equal(readFileSync(raced, 'utf8'), other)
  // An existing key file others can read is worth a line (POSIX). / 他人可读的已有密钥文件会提示一句。
  if (process.platform !== 'win32') {
    chmodSync(file, 0o644)
    ensureSignerKeyFile({ SIGNER_KEY_GENERATE: '1', SIGNER_KEY_FILE: file }, { log })
    assert.match(lines.at(-1), /can be read by other users of this machine: chmod 600 it/)
  }
})

test('E8-6: the sidecar started with SIGNER_KEY_GENERATE=1 prints the new address and never the key; a restart keeps it', async () => {
  const dir = join(tmp, 'keys-b'); mkdirSync(dir)
  const file = join(dir, 'signer.key')
  const env = { SIGNER_KEY_GENERATE: '1', SIGNER_KEY_FILE: file, PUBLIC_URL: 'http://127.0.0.1:1', FORMATS: 'openai-chat' }
  const printed = []
  const orig = { log: console.log, error: console.error }
  console.log = (...a) => printed.push(a.join(' '))
  console.error = (...a) => printed.push(a.join(' '))
  let first, second
  try {
    first = await startSidecar({ env, port: 0, host: '127.0.0.1' })
    const h1 = await (await fetch(`${first.url}/tapeapi/v1/health`)).json()
    await first.close()
    second = await startSidecar({ env, port: 0, host: '127.0.0.1' })
    const h2 = await (await fetch(`${second.url}/tapeapi/v1/health`)).json()
    await second.close()
    const key = readFileSync(file, 'utf8').trim()
    const address = sig.privateKeyToAddress(key)
    assert.equal(h1.setup, true)
    assert.equal(h1.signer, address)
    assert.equal(h2.signer, address)
    const text = printed.join('\n')
    assert.match(text, new RegExp(`created a new signing key in .*Its address: ${address}`))
    assert.equal(text.match(/created a new signing key/g).length, 1, 'made once, then kept')
    assert.ok(!text.toLowerCase().includes(key.slice(2).toLowerCase()), 'the key never appears in the output')
    assert.doesNotMatch(text, KEY_HEX)
    assert.doesNotMatch(JSON.stringify([h1, h2]), KEY_HEX)
  } finally {
    console.log = orig.log
    console.error = orig.error
  }
})

// add-sidecar.sh with a stand-in `docker` on PATH: it records every call and answers `compose ... exec` with a health
// answer, so the script runs end to end with no container. / 用替身 docker 运行 add-sidecar.sh：记录每次调用，并对 exec 回一个
// health 回答，脚本因此能完整跑完而不启动任何容器。
const SH = process.platform === 'win32' ? null : ['/bin/sh', '/bin/dash', '/bin/bash'].filter((p) => existsSync(p))
function fakeDocker(dir, { signer, health } = {}) {
  const bin = join(dir, 'bin'); mkdirSync(bin, { recursive: true })
  const calls = join(dir, 'docker-calls.txt')
  const answer = health ?? JSON.stringify({ ok: false, setup: true, signer, missing: ['FORMATS'] })
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\ncase "$*" in *" exec "*) printf '%s' '${answer}' ;; esac\nexit 0\n`, { mode: 0o755 })
  return { PATH: `${bin}:/usr/bin:/bin`, calls }
}
const runScript = (shell, args, env) => spawnSync(shell, [here('add-sidecar.sh'), ...args], { encoding: 'utf8', env: { HOME: tmp, ...env }, timeout: 300_000, killSignal: 'SIGKILL' })

test('E8-7: add-sidecar.sh parses in every POSIX shell present', { skip: !SH?.length && 'no POSIX shell' }, () => {
  for (const shell of SH) {
    const r = spawnSync(shell, ['-n', here('add-sidecar.sh')], { encoding: 'utf8', timeout: 300_000, killSignal: 'SIGKILL' })
    assert.equal(r.status, 0, `${shell}: ${r.stderr}`)
  }
})

test('E8-8: add-sidecar.sh copies three files (never overwriting), starts the sidecar alone and prints only the address', { skip: !SH?.length && 'no POSIX shell' }, () => {
  for (const shell of SH) {
    const dir = mkdtempSync(join(tmp, 'relay-'))
    const compose = 'services:\n  new-api:\n    image: calciumion/new-api:v1.0.0-rc.40\n'
    writeFileSync(join(dir, 'docker-compose.yml'), compose)
    const signer = sig.privateKeyToAddress(sig.randomPrivateKey())
    const { PATH, calls } = fakeDocker(dir, { signer })
    const r = runScript(shell, [dir], { PATH })
    assert.equal(r.status, 0, `${shell}: ${r.stderr}\n${r.stdout}`)
    const out = r.stdout + r.stderr
    assert.match(out, new RegExp(`signing address \\(public\\) / 签名地址（公开值）: ${signer}`))
    assert.match(out, /in the holder console, sign the delegation for exactly this address/)
    assert.match(out, new RegExp(`SIGNER_ADDRESS=${signer}`))
    assert.doesNotMatch(out, KEY_HEX, 'nothing key-shaped is printed')
    // Files: created next to the operator's compose file; his own file untouched; the env file is 600.
    // 文件：建在运营者的 compose 文件旁；他自己的文件不动；env 文件权限 600。
    assert.equal(readFileSync(join(dir, 'docker-compose.yml'), 'utf8'), compose)
    assert.equal(readFileSync(join(dir, 'docker-compose.sidecar.yml'), 'utf8'), read('docker-compose.sidecar.yml'))
    assert.equal(readFileSync(join(dir, 'tapeapi-sidecar.env'), 'utf8'), read('tapeapi-sidecar.env.example'))
    assert.equal(statSync(join(dir, 'tapeapi-sidecar.env')).mode & 0o777, 0o600)
    assert.equal(readFileSync(join(dir, 'tapeapi-models.json'), 'utf8'), read('models.example.json'))
    // Docker: build from this checkout, then up the sidecar alone, then exec its health. / 先构建，再只启动旁路，再取 health。
    const c = readFileSync(calls, 'utf8').trim().split('\n')
    assert.match(c[0], /^build --build-context sdk=\.\.\/\.\.\/sdk --build-context server=\.\.\/\.\.\/server -t tapeapi-new-api-sidecar:local \.$/)
    assert.equal(c[1], 'compose -f docker-compose.yml -f docker-compose.sidecar.yml up -d tapeapi-sidecar')
    assert.match(c[2], /^compose -f docker-compose\.yml -f docker-compose\.sidecar\.yml exec -T tapeapi-sidecar wget -q -O - http:\/\/127\.0\.0\.1:8080\/tapeapi\/v1\/health$/)
    assert.ok(!c.some((l) => /signer\.key|\/keys|cat |cp /.test(l)), 'the key file is never read')

    // A second run keeps what the operator edited. / 第二次运行保留运营者改过的内容。
    writeFileSync(join(dir, 'tapeapi-sidecar.env'), 'PUBLIC_URL=https://tape.example.org\nFORMATS=openai-chat\n')
    const again = runScript(shell, ['--no-build', '--no-up', dir], { PATH })
    assert.equal(again.status, 0, again.stderr)
    assert.match(again.stdout, /kept .*tapeapi-sidecar\.env \(it exists: not overwritten/)
    assert.match(again.stdout, /same .*docker-compose\.sidecar\.yml/)
    assert.equal(readFileSync(join(dir, 'tapeapi-sidecar.env'), 'utf8'), 'PUBLIC_URL=https://tape.example.org\nFORMATS=openai-chat\n')
    assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 3, '--no-build --no-up calls docker no more')
  }
})

test('E8-9: add-sidecar.sh refuses what it cannot do, and says why', { skip: !SH?.length && 'no POSIX shell' }, () => {
  const shell = SH[0]
  const empty = mkdtempSync(join(tmp, 'empty-'))
  const { PATH } = fakeDocker(empty, { signer: null })
  assert.equal(runScript(shell, [], { PATH }).status, 2)
  assert.equal(runScript(shell, ['--bogus', empty], { PATH }).status, 2)
  const noCompose = runScript(shell, [empty], { PATH })
  assert.equal(noCompose.status, 2)
  assert.match(noCompose.stderr, /no compose file/)
  assert.equal(existsSync(join(empty, 'tapeapi-sidecar.env')), false)
  assert.match(runScript(shell, [here('.')], { PATH }).stderr, /not this example/)
  // No address reported (the key could not be made): exit 1 with the logs command, nothing key-shaped.
  // 没有报出地址（密钥没能生成）：退出码 1，给出查看日志的命令。
  writeFileSync(join(empty, 'compose.yaml'), 'services: {}\n')
  const none = runScript(shell, ['--no-build', empty], { PATH, TAPEAPI_ADD_SIDECAR_TRIES: '1' })
  assert.equal(none.status, 1, none.stdout + none.stderr)
  assert.match(none.stdout, /did not report a signing address yet/)
  assert.match(none.stdout, /docker compose -f compose\.yaml -f docker-compose\.sidecar\.yml logs tapeapi-sidecar/)
})

test('E8-10: the compose fragment adds the sidecar alone, with a key volume and no key variable', () => {
  const y = read('docker-compose.sidecar.yml')
  assert.match(y, /^services:\n {2}tapeapi-sidecar:\n/m)
  assert.doesNotMatch(y, /^ {2}new-api:/m, 'the operator\'s new-api service is not redefined')
  assert.match(y, /^ {6}SIGNER_KEY_FILE: \/keys\/signer\.key$/m)
  assert.match(y, /^ {6}SIGNER_KEY_GENERATE: "1"$/m)
  assert.doesNotMatch(y, /^\s*SIGNER_KEY:/m, 'the key is in no variable')
  assert.match(y, /^ {6}- tapeapi-signer:\/keys$/m)
  assert.match(y, /^volumes:\n(?:\s*#.*\n)* {2}tapeapi-signer:$/m)
  assert.match(y, /^ {4}read_only: true$/m)
  assert.match(y, /"\$\{TAPEAPI_SIDECAR_BIND:-127\.0\.0\.1\}:/)
  assert.match(y, /^ {6}- tapeapi-sidecar\.env$/m)
  assert.doesNotMatch(y, /^\s*build:/m, 'the image is built once from the checkout, not by the operator\'s compose')
  // The Dockerfile gives /keys to the user the sidecar runs as, before it switches to it. / Dockerfile 在切换用户前把 /keys 交给它。
  const d = read('Dockerfile')
  assert.ok(d.indexOf('chown node:node /keys') > 0 && d.indexOf('chown node:node /keys') < d.indexOf('USER node'))
  // The env template: placeholders only, the sidecar's own hostname, FORMATS empty, no SIGNER_KEY line.
  // env 模板：只有占位符、旁路自己的主机名、FORMATS 留空、没有 SIGNER_KEY 行。
  const e = read('tapeapi-sidecar.env.example')
  assert.match(e, /^PUBLIC_URL=https:\/\/tape\.example\.com$/m)
  assert.match(e, /^FORMATS=$/m)
  assert.doesNotMatch(e, /^\s*SIGNER_KEY=/m)
  assert.match(e, /^# OPERATOR_SITE_URL=https:\/\/www\.example\.com$/m)
  assert.doesNotMatch(e + y, /tapeapi\.fun/, 'no TapeAPI host is suggested as a destination')
})

test('E8-11: the compose fragment is valid YAML (when python3 has PyYAML)', (t) => {
  const probe = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8', timeout: 300_000, killSignal: 'SIGKILL' })
  if (probe.status !== 0) return t.skip('python3 with PyYAML is not available')
  const r = spawnSync('python3', ['-c', 'import sys, yaml, json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', here('docker-compose.sidecar.yml')], { encoding: 'utf8', timeout: 300_000, killSignal: 'SIGKILL' })
  assert.equal(r.status, 0, r.stderr)
  const doc = JSON.parse(r.stdout)
  assert.deepEqual(Object.keys(doc.services), ['tapeapi-sidecar'])
  const s = doc.services['tapeapi-sidecar']
  assert.equal(s.environment.SIGNER_KEY_GENERATE, '1')
  assert.deepEqual(s.cap_drop, ['ALL'])
  assert.ok('tapeapi-signer' in doc.volumes)
})

test('E8-12: the Worker config for a new-api relay: its own hostname, FORMATS left to choose, no key in the file', () => {
  const toml = read('wrangler.toml')
  assert.match(toml, /^main = "\.\.\/ai-proxy\/worker\.js"$/m)
  assert.ok(existsSync(here('../ai-proxy/worker.js')))
  assert.match(toml, /^UPSTREAM_BASE_URL = "https:\/\/api\.example\.com\/v1"$/m)
  assert.match(toml, /^# FORMATS = "openai-chat"$/m)
  assert.match(toml, /^# PUBLIC_URL = "https:\/\/tape\.example\.com"/m)
  assert.match(toml, /^# OPERATOR_SITE_URL = "https:\/\/www\.example\.com"$/m)
  assert.doesNotMatch(toml, /^\s*SIGNER_KEY\s*=/m)
  assert.doesNotMatch(toml, /^\s*(routes?|route)\s*=/m, 'no routes: a custom domain of the operator\'s')
})

// After the merge of the FORMATS refusal (2x-fixes) and OPERATOR_SITE_URL (relay-r3a): both act on the same sidecar
// and the same Worker. GET / answers 302 to the operator's site; a metered path of a format FORMATS leaves out is still
// refused (HTTP 400 naming FORMATS, never forwarded, never a redirect); the enabled format still reaches the upstream.
// 合并 FORMATS 拒绝与 OPERATOR_SITE_URL 之后：两者作用于同一个旁路与同一个 Worker。GET / 302 到运营者站点；FORMATS 未启用格式的计量
// 路径照样拒绝（400 点名 FORMATS，不转发，也不跳转）；已启用的格式照样到达上游。
test('E8-13: OPERATOR_SITE_URL and the FORMATS refusal together, in the sidecar and the Worker; FORMATS unset (all, with a warning) keeps the 302', async () => {
  const chatOnly = join(tmp, 'chat-only.json')
  writeFileSync(chatOnly, JSON.stringify([{ id: 'model-a', prices: [{ currency: 'USD', unit: '1M tokens', input: '0.25', output: '2' }] }]))
  const seen = []
  const upstream = async (url) => { seen.push(new URL(String(url)).pathname); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) }
  const site = 'https://www.example.com/'
  const post = (s, path) => s.handleRequest(new Request(`https://tape.example.com${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"model-a"}' }), { clientIp: '127.0.0.1' })
  const refused = async (r, path, name) => {
    assert.equal(r.status, 400, path)
    assert.equal(r.headers.get('location'), null, path)
    assert.equal(r.headers.get('x-tapeapi-sidecar-error'), '1', path)
    const { error } = await r.json()
    assert.equal(error.code, 'bad_path', path)
    assert.match(error.message, new RegExp(`is a ${name} path.*FORMATS does not enable it`), path)
  }

  // The Node sidecar. / Node 旁路。
  const s = createSidecar(complete({ FORMATS: 'openai-chat', MODELS_FILE: chatOnly, OPERATOR_SITE_URL: site, UPSTREAM_BASE_URL: 'http://new-api.invalid/v1' }), { fetch: upstream, log: () => {} })
  assert.equal(s.state.ok, true, s.state.problem)
  const r = await get(s, '/')
  assert.equal(r.status, 302)
  assert.equal(r.headers.get('location'), site)
  await refused(await post(s, '/v1/messages'), '/v1/messages', 'anthropic-messages')
  await refused(await post(s, '/v1/responses'), '/v1/responses', 'openai-responses')
  assert.deepEqual(seen, [], 'a refused format never reaches new-api')
  await post(s, '/v1/chat/completions')
  assert.deepEqual(seen, ['/v1/chat/completions'], 'the enabled format is forwarded')
  assert.deepEqual(s.proxy.manifest().ai.endpoints.map((e) => e.format), ['openai-chat'])

  // A 2.0.0 sidecar upgraded without FORMATS (B-6): it serves the four formats with a warning in health, and GET /
  // still goes to the site. / 未设 FORMATS 升级上来的 2.0.0 旁路：照常服务四种格式、health 带警告，GET / 仍然跳到运营者站点。
  const { FORMATS: _unset, ...noFormats } = complete({ OPERATOR_SITE_URL: site, MODELS_FILE: chatOnly, UPSTREAM_BASE_URL: 'http://new-api.invalid/v1' })
  const up = createSidecar(noFormats, { fetch: upstream, log: () => {} })
  assert.equal(up.state.ok, true, up.state.problem)
  assert.equal((await get(up, '/')).headers.get('location'), site)
  assert.match((await (await get(up, '/tapeapi/v1/health')).json()).warning, /^FORMATS is not set, so every format is published and signed/)
  seen.length = 0
  await post(up, '/v1/messages')
  assert.deepEqual(seen, ['/v1/messages'], 'with all four formats, /v1/messages is forwarded')

  // The Worker: the same two behaviours. / Worker：同样两种行为。
  seen.length = 0
  const env = { ...throwawayIdentity(), PUBLIC_URL: 'https://tape.example.com', UPSTREAM_BASE_URL: 'https://up.example/v1', MODELS_JSON: readFileSync(chatOnly, 'utf8'), FORMATS: 'openai-chat', OPERATOR_SITE_URL: site }
  const w = await worker.fetch(new Request('https://tape.example.com/'), env)
  assert.equal(w.status, 302)
  assert.equal(w.headers.get('location'), site)
  await refused(await worker.fetch(new Request('https://tape.example.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), env), '/v1/messages', 'anthropic-messages')
  const built = buildWorker(env, { fetch: upstream, log: () => {} })
  await refused(await post(built, '/v1/embeddings'), '/v1/embeddings', 'openai-embeddings')
  assert.deepEqual(seen, [])
  await post(built, '/v1/chat/completions')
  assert.deepEqual(seen, ['/v1/chat/completions'])
})
