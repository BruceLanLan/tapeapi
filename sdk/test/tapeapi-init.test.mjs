// tapeapi init (sdk/src/init-cli.js, experimental): the operator's wizard. In process, against the SDK's TAP-10 test chain
// (createConformChain: circuit #42 of processor 7, 42.7.tape), the fake new-api (its GET /api/pricing converted with
// tapeapi prices convert) and the new-api package's real sidecar (examples/new-api-sidecar/server.mjs) on 127.0.0.1, in
// setup mode first, then complete. Pinned here: FORMATS has no default (not chosen = exit 2; all four = a second
// confirmation that says the manifest on chain keeps them for good); the .env it writes says FORMATS= exactly the choice,
// leaves every secret empty, mode 600, and an existing .env is never read or changed; no secret value reaches any output,
// --json or the state file; no transaction is ever sent; each paying step says who pays (you) and that we do not advance it.
// tapeapi init（实验性）：运营者向导。进程内，对 SDK 的 TAP-10 测试链、模拟 new-api 与 new-api 一键包的真实旁路。钉住：FORMATS 没有默认值
// （不选即退出 2；四种要二次确认并写明链上清单删不掉）；写出的 .env 里 FORMATS 恰为所选、机密全空、权限 600，已有的 .env 从不读写；
// 任何输出、--json、状态文件都不含机密值；从不发送交易；每个花钱的步骤都写明由你自己付、我们不垫付。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { sig as SIG, MAINNET } from '../src/index.js'
import { doctorCommands } from '../src/doctor.js'
import { runInit, chooseFormats, envSkeleton, SETUP_LATER, INOTES, ALL_FORMATS_NOTE, STEPS, STATE_FILE, setupMissing } from '../src/init-cli.js'
import { runPrices } from '../src/prices-cli.js'
import { createConformChain } from './helpers/conform-chain.mjs'
import { createMcpServer } from '../src/mcp.js'
import { createMcpProxy } from '../../server/src/mcp-proxy.js'
import { TOOLS as DEMO_TOOLS } from '../../examples/mcp-proxy/demo-server.mjs'
import { startSidecar, selectFormats, readConfig } from '../../examples/new-api-sidecar/server.mjs'
import { startFakeNewApi } from '../../examples/new-api-sidecar/fake-new-api.mjs'
import * as converter from '../../examples/new-api-sidecar/pricing-convert.mjs'

const BIN = fileURLToPath(new URL('../bin/tapeapi.js', import.meta.url))
const ENV_EXAMPLE = fileURLToPath(new URL('../../examples/new-api-sidecar/env.example', import.meta.url))
const host = { ...fs, ...path }
const TMP = fs.mkdtempSync(path.join(tmpdir(), 'tapeapi-init-test-'))
const closers = []
test.after(async () => { for (const c of closers.reverse()) await c(); fs.rmSync(TMP, { recursive: true, force: true }) })
let n = 0
const newDir = () => { const d = path.join(TMP, `d${++n}`); fs.mkdirSync(d); return d }
const NAME = '42.7.tape'
const RPC = ['--rpc', 'http://rpc1,http://rpc2,http://rpc3']
const FORBIDDEN = /认证|合作伙伴|推荐|已审计|主网可用|成为标准|通过|采用|免费接入|零成本|certified|partner|recommend|audited|mainnet-ready|adopted|zero cost|free of charge/i
const NEXT = /^ *(next: \/ 下一条命令:|next:|下一条命令:) \S/
const SENTINEL = '0x' + '5e'.repeat(32)
const SENTINEL_TOKEN = 'sk-SENTINELtoken0123456789abcdef'
const seen = []   // the wizard's own lines from every run, for the wording test / 每次运行中向导自己的行
const lastLine = (s) => s.trimEnd().split('\n').pop()

/** runInit in process. / 进程内运行 init。 */
async function init(args, { env = {}, ask = null, w = null, isTTY = false } = {}) {
  let out = '', err = ''
  const r = await runInit([...args, ...(w ? RPC : [])], {
    cmd: 'tapeapi', version: '0.0.0-test', host, env, ask, isTTY, commands: doctorCommands(),
    apiOptions: w?.apiOptions ?? {}, diagnoseOptions: w ? { allowHttp: true } : {}, stdout: (s) => { out += s }, stderr: (s) => { err += s },
  })
  const res = { code: r.exitCode, out, err }
  seen.push(...(out + err).split('\n').filter((l) => !/^ {2}\| /.test(l)))
  if (res.code !== 0 && !out.startsWith('{')) assert.match(lastLine(out + err), NEXT, `exit ${res.code} without a next line:\n${out}${err}`)
  return res
}
const prices = async (args, io = {}) => {
  let out = '', err = ''
  const r = await runPrices(args, { cmd: 'tapeapi', version: '0.0.0-test', host, converter, env: {}, stdout: (s) => { out += s }, stderr: (s) => { err += s }, ...io })
  return { code: r.exitCode, out, err }
}
const answers = (dir, obj) => { const f = path.join(dir, 'answers.json'); fs.writeFileSync(f, JSON.stringify(obj)); return f }

// The fake chain, the fake new-api, the price table. / 假链、模拟 new-api、价目表。
let newApi = null
async function fakeNewApi() {
  if (newApi) return newApi
  newApi = await startFakeNewApi({ port: 0 })
  closers.push(() => newApi.close())
  return newApi
}
/** The operator's own step: save /api/pricing and /api/status, convert them with tapeapi prices convert into `dir`. */
async function convertInto(dir) {
  const api = await fakeNewApi()
  for (const p of ['pricing', 'status']) fs.writeFileSync(path.join(dir, `${p}.json`), Buffer.from(await (await fetch(`${api.url}/api/${p}`)).arrayBuffer()))
  const r = await prices(['convert', path.join(dir, 'pricing.json'), '--status', path.join(dir, 'status.json'), '--usd-exchange-rate', '7', '--fetched-as', 'anonymous', '--out', path.join(dir, 'models.json')])
  assert.equal(r.code, 0, r.err)
}
function world() {
  const holderKey = SIG.randomPrivateKey(), signerKey = SIG.randomPrivateKey()
  const now = Math.floor(Date.now() / 1000), expires = now + 90 * 86_400
  const chain = createConformChain()
  chain.state.headTime = now
  const c = chain.circuit(42, { holder: SIG.privateKeyToAddress(holderKey) })
  chain.setAccount('42', c.container); chain.setCode(c.container)
  const delegationSig = SIG.signDigest(SIG.delegationDigest(56, MAINNET.hub, { container: c.container, signer: SIG.privateKeyToAddress(signerKey), expires }), holderKey)
  const methods = []
  const fetchChain = (url, init) => {
    if (!String(url).startsWith('http://rpc')) return globalThis.fetch(url, init)
    try { const b = JSON.parse(init.body); for (const x of Array.isArray(b) ? b : [b]) methods.push(x.method) } catch { /* not JSON */ }
    return chain.fetch(String(url), init)
  }
  return {
    chain, c, now, methods, signerKey,
    identity: { CIRCUITS: c.circuits, TOKEN_ID: '42', CONTAINER: c.container, DELEGATION_EXPIRES: String(expires), DELEGATION_SIG: delegationSig, SIGNER_KEY: signerKey },
    apiOptions: { clock: () => now, quiet: true, onWarning: () => {}, allowHttp: true, fetch: fetchChain },
  }
}
async function sidecar(env) {
  const s = await startSidecar({ env, port: 0, host: '127.0.0.1', quiet: true, localPublicUrl: true, log: () => {} })
  closers.push(() => s.close())
  return s
}
async function publish(w, s) {
  w.chain.writeFile(w.c.container, '.well-known/tapeapi.json', await (await fetch(`${s.url}/.well-known/tapeapi.json`)).text())
}

// ════ the gateway (review C-4) ═══════════════════════════════════════════════════════════════════════════════════════
// Without a terminal the gateway is not assumed: the .env written is new-api's. / 没有终端时不假定网关：写出的是 new-api 的 .env。
test('--upstream: steps 3 and 4 without a terminal and without --upstream are exit 2 naming it, nothing written; --answers or the state file supply it', async () => {
  for (const [label, extra] of [['no flag', []], ['--yes', ['--yes']], ['--json', ['--json']]]) {
    for (const step of ['3', '4']) {
      const dir = newDir()
      const r = await init(['--dir', dir, '--step', step, '--sidecar-url', 'https://api.example.com', '--formats', 'openai-chat', ...extra])
      assert.equal(r.code, 2, `${label} ${step}\n${r.out}${r.err}`)
      assert.equal(r.out, '', label)
      assert.match(r.err, /no gateway: give --upstream new-api/); assert.match(r.err, /没有网关：请用 --upstream new-api 给出/)
      assert.match(lastLine(r.err), new RegExp(`^next: / 下一条命令: tapeapi init --step ${step} --upstream new-api --sidecar-url https://api\\.example\\.com --dir `))
      assert.deepEqual(fs.readdirSync(dir), [], `${label}: nothing written`)
    }
  }
  const dir = newDir()
  const viaAnswers = await init(['--dir', dir, '--step', '3', '--sidecar-url', 'https://127.0.0.1:9', '--answers', answers(dir, { upstream: 'new-api', formats: 'openai-chat' })])
  assert.notEqual(viaAnswers.code, 2, viaAnswers.err)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8')).answers.upstream, 'new-api')
  const fromState = await init(['--dir', dir, '--step', '3', '--sidecar-url', 'https://127.0.0.1:9', '--formats', 'openai-chat'])
  assert.notEqual(fromState.code, 2, fromState.err)
  // steps that do not write the sidecar's configuration do not ask / 不写旁路配置的步骤不要求它
  assert.notEqual((await init(['--dir', newDir(), '--step', '0'])).code, 2)
})

// ════ FORMATS ════════════════════════════════════════════════════════════════════════════════════════════════════════
test('FORMATS not chosen: exit 2 naming FORMATS, with no flag, an empty value, --yes or an empty list in --answers; nothing is written', async () => {
  for (const [label, extra] of [['no flag', []], ['empty', ['--formats', '']], ['spaces and commas', ['--formats', ' , ']], ['--yes', ['--yes']], ['answers []', null]]) {
    const dir = newDir()
    const args = extra ?? ['--answers', answers(dir, { formats: [] })]
    const r = await init(['--dir', dir, '--upstream', 'new-api', '--step', '3', '--sidecar-url', 'https://api.example.com', ...args])
    assert.equal(r.code, 2, `${label}\n${r.out}${r.err}`)
    assert.equal(r.out, '', label)
    assert.match(r.err, /FORMATS is not chosen/, label)
    assert.match(r.err, /没有选择 FORMATS/, label)
    assert.match(r.err, /no default and no fallback to all/)
    // the answers given on the command line come back in the next command (nothing was saved) / 命令行给出的答案出现在下一条命令里
    assert.match(lastLine(r.err), /^next: \/ 下一条命令: tapeapi init --step 3 --formats openai-chat --upstream new-api --sidecar-url https:\/\/api\.example\.com (--answers \S+ )?--dir /)
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f !== 'answers.json'), [], `${label}: nothing written`)
  }
  // every step from 3 on needs it, even with everything else given / 第 3 步起每一步都需要它
  for (const step of ['4', '5', '6', '7']) {
    const r = await init(['--dir', newDir(), '--upstream', 'new-api', '--step', step, '--name', NAME, '--sidecar-url', 'https://api.example.com', '--yes'])
    assert.equal(r.code, 2, `step ${step}`); assert.match(r.err, /FORMATS is not chosen/)
  }
  // an unknown name is a usage mistake naming FORMATS too / 不认识的名字也是用法错误并点名 FORMATS
  const bad = await init(['--dir', newDir(), '--upstream', 'new-api', '--step', '3', '--sidecar-url', 'https://api.example.com', '--formats', 'openai-chat,claude'])
  assert.equal(bad.code, 2); assert.match(bad.err, /FORMATS names "claude", which the sidecar does not know/)
  // steps 0 to 2 do not need it / 第 0 到 2 步不需要
  assert.equal((await init(['--dir', newDir(), '--step', '0'])).code, 0)
})

test('FORMATS all four: a second confirmation, and the output says all four go into the manifest on chain for good', async () => {
  for (const [label, args] of [['all', ['--formats', 'all']], ['the four names', ['--formats', 'openai-embeddings,anthropic-messages,openai-chat,openai-responses']], ['answers all', null]]) {
    const dir = newDir()
    const r = await init(['--dir', dir, '--upstream', 'new-api', '--step', '3', '--sidecar-url', 'https://api.example.com', ...(args ?? ['--answers', answers(dir, { formats: 'all' })])])
    assert.equal(r.code, 2, `${label}\n${r.err}`)
    assert.ok(r.err.includes(ALL_FORMATS_NOTE.en) && r.err.includes(ALL_FORMATS_NOTE.zh), label)
    assert.match(r.err, /written into the manifest you publish on chain.*its history on chain cannot be deleted/)
    assert.match(r.err, /链上历史删不掉/)
    assert.match(r.err, /Only if you tested all four, confirm it: add --confirm-all-formats/)
    assert.match(lastLine(r.err), /^next: \/ 下一条命令: tapeapi init --step 3 --formats openai-chat --upstream new-api --sidecar-url https:\/\/api\.example\.com (--answers \S+ )?--dir /, 'the narrow command, not the confirmation')
    assert.ok(!fs.existsSync(path.join(dir, '.env')), label)
  }
  // confirmed: step 3 runs, says it again, and .env says the four names / 确认后：第 3 步照常运行、再说一遍，.env 写四个名字
  const s = await sidecar({})
  const dir = newDir()
  const r = await init(['--dir', dir, '--upstream', 'new-api', '--step', '3', '--sidecar-url', s.url, '--formats', 'all', '--confirm-all-formats'])
  assert.notEqual(r.code, 2, r.err)
  assert.ok(r.out.includes(ALL_FORMATS_NOTE.en) && r.out.includes(ALL_FORMATS_NOTE.zh))
  assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /^FORMATS=openai-chat,openai-responses,anthropic-messages,openai-embeddings$/m)
  const j = await init(['--dir', newDir(), '--upstream', 'new-api', '--step', '3', '--sidecar-url', s.url, '--answers', answers(newDir(), { formats: 'all', confirmAllFormats: true }), '--json'])
  assert.ok(JSON.parse(j.out).notes.allFormats.en.includes('cannot be deleted'))
  // a later --formats without the confirmation asks again / 之后再给 --formats 而不确认：重新要求确认
  const again = await init(['--dir', dir, '--step', '3', '--formats', 'all'])
  assert.equal(again.code, 2)
})

test('FORMATS on a terminal: one question per format (default No), only what was answered y is kept; four need a second y', async () => {
  const s = await sidecar({})
  // the first question is the gateway (default new-api), then one per format / 先问网关（默认 new-api），再逐个问格式
  const run = async (replies) => {
    const asked = []
    const dir = newDir()
    replies = ['', ...replies]
    const r = await init(['--dir', dir, '--step', '3', '--sidecar-url', s.url], { ask: async (q) => { asked.push(q); return replies.shift() ?? '' } })
    asked.shift()
    return { r, asked, dir }
  }
  const none = await run(['', 'n', 'no', ''])
  assert.equal(none.r.code, 2); assert.match(none.r.err, /FORMATS is not chosen/)
  assert.equal(none.asked.length, 4)
  assert.match(none.asked[0], /Have you tested that your gateway really serves openai-chat \(POST \/v1\/chat\/completions\)\? .*\[y\/N\]/)
  assert.ok(none.asked.every((q) => !/key|token|password|secret|mnemonic|密钥|令牌|密码|助记词/i.test(q.replace(/\[y\/N\]/, ''))), 'no question is about a secret')
  const one = await run(['y', 'n', 'n', 'n'])
  assert.notEqual(one.r.code, 2, one.r.err)
  assert.match(fs.readFileSync(path.join(one.dir, '.env'), 'utf8'), /^FORMATS=openai-chat$/m)
  const fourNo = await run(['y', 'y', 'y', 'y', 'n'])
  assert.equal(fourNo.r.code, 2); assert.equal(fourNo.asked.length, 5); assert.match(fourNo.asked[4], /Write all four into the manifest\?/)
  const fourYes = await run(['y', 'yes', 'Y', 'y', 'y'])
  assert.notEqual(fourYes.r.code, 2)
  assert.match(fs.readFileSync(path.join(fourYes.dir, '.env'), 'utf8'), /^FORMATS=openai-chat,openai-responses,anthropic-messages,openai-embeddings$/m)
})

test('chooseFormats reads a value exactly as the sidecar\'s selectFormats does, minus the default (selectFormats is never given an empty value by init)', () => {
  for (const v of ['openai-chat', 'all', 'ALL', 'openai-embeddings openai-chat', 'openai-chat,openai-chat', ' openai-responses , anthropic-messages ']) {
    assert.deepEqual(chooseFormats(v).formats, selectFormats(v).map((f) => f.name), v)
  }
  for (const v of ['nope', 'openai-chat,x']) { assert.equal(typeof selectFormats(v), 'string'); assert.throws(() => chooseFormats(v), /does not know/) }
  for (const v of [undefined, null, '', ' ', [], ['']]) assert.throws(() => chooseFormats(v), /FORMATS is not chosen/)
})

// ════ .env and secrets ═══════════════════════════════════════════════════════════════════════════════════════════════
test('.env: written once with FORMATS= exactly the choice, every secret empty, mode 600; the sidecar reads it as setup mode missing only what the console gives', async () => {
  const s = await sidecar({})
  const dir = newDir()
  const r = await init(['--dir', dir, '--upstream', 'new-api', '--step', '3', '--sidecar-url', s.url, '--formats', 'openai-embeddings,openai-chat', '--name', NAME])
  assert.notEqual(r.code, 2, r.err)
  const file = path.join(dir, '.env')
  const text = fs.readFileSync(file, 'utf8')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.match(text, /^FORMATS=openai-chat,openai-embeddings$/m, 'the choice, in the SDK order')
  for (const k of ['SESSION_SECRET', 'SIGNER_KEY', 'DELEGATION_EXPIRES', 'DELEGATION_SIG', 'CIRCUITS', 'TOKEN_ID', 'CONTAINER']) assert.match(text, new RegExp(`^${k}=$`, 'm'), `${k} left empty`)
  assert.match(text, new RegExp(`^PUBLIC_URL=${s.url}$`, 'm')); assert.match(text, /^TAPE_NAME=42\.7\.tape$/m)
  // the names are env.example's / 变量名与 env.example 一致
  const names = (t) => [...t.matchAll(/^#?\s?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1])
  const known = new Set(names(fs.readFileSync(ENV_EXAMPLE, 'utf8')))
  for (const k of names(text)) assert.ok(known.has(k), `${k} is a variable of env.example`)
  // the sidecar's own reading: setup mode, missing exactly what step 4 (the console) gives / 旁路自己读：设置模式，缺的恰是操作台给的
  const env = Object.fromEntries(text.split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  const cfg = readConfig(env)
  assert.equal(cfg.ok, false); assert.equal(cfg.problem, null)
  assert.deepEqual([...cfg.missing].sort(), [...SETUP_LATER].sort())
  assert.deepEqual(envSkeleton({ sidecarUrl: 'https://a.example', formats: ['openai-chat'] }).match(/^FORMATS=.*$/m)[0], 'FORMATS=openai-chat')
})

// Review C-3: a .env written with a wrong PUBLIC_URL is written again for the corrected answer while it is still exactly
// the wizard's (stat as recorded); once anything was filled in it is never changed, and the wizard says what to correct.
// 审查 C-3：写错 PUBLIC_URL 的 .env，只要仍原封未动（stat 与记录一致）就按更正后的答案重写；一旦填过任何东西就不再改动，并提示自己改正。
test('.env: a corrected --sidecar-url rewrites the wizard\'s untouched .env (600, secrets empty); a .env changed since is left alone with a hint', async () => {
  const a = await sidecar({}), b = await sidecar({})
  const dir = newDir()
  const file = path.join(dir, '.env')
  const step3 = (url) => init(['--dir', dir, '--upstream', 'new-api', '--step', '3', '--sidecar-url', url, '--formats', 'openai-chat', '--name', NAME])
  await step3(a.url)
  assert.match(fs.readFileSync(file, 'utf8'), new RegExp(`^PUBLIC_URL=${a.url}$`, 'm'))
  const rec = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8')).env
  assert.deepEqual(Object.keys(rec), ['publicUrl', 'formats', 'name', 'size', 'mtimeMs', 'ctimeMs', 'ino'])
  assert.equal(rec.publicUrl, a.url)
  // the same answers again: nothing written / 同样的回答：不写
  const same = await step3(a.url)
  assert.match(same.out, /exists: the wizard did not read it and did not change it/)
  // corrected: written again / 更正：重写
  const fixed = await step3(b.url)
  assert.match(fixed.out, new RegExp(`written again: it was still exactly as the wizard wrote it .*PUBLIC_URL ${a.url} -> ${b.url}`))
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, new RegExp(`^PUBLIC_URL=${b.url}$`, 'm')); assert.doesNotMatch(text, new RegExp(a.url))
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  for (const k of ['SESSION_SECRET', 'SIGNER_KEY', 'DELEGATION_EXPIRES', 'DELEGATION_SIG', 'CIRCUITS', 'TOKEN_ID', 'CONTAINER']) assert.match(text, new RegExp(`^${k}=$`, 'm'), `${k} left empty`)
  // filled in since: never changed again, and a hint / 此后填过：不再改动，给出提示
  fs.appendFileSync(file, 'SIGNER_KEY_FILE=/run/secrets/signer\n')
  const mine = fs.readFileSync(file, 'utf8'), before = fs.statSync(file).mtimeMs
  const left = await step3(a.url)
  assert.equal(fs.readFileSync(file, 'utf8'), mine, '.env unchanged'); assert.equal(fs.statSync(file).mtimeMs, before)
  assert.match(left.out, new RegExp(`The wizard wrote PUBLIC_URL=${b.url} into .*the file has changed since, so it is not written again: if PUBLIC_URL should be ${a.url}, correct it there yourself`))
  // a chmod alone (ctime) also counts as touched / 仅 chmod（ctime 变化）也算改动过
  const d2 = newDir(), f2 = path.join(d2, '.env')
  await init(['--dir', d2, '--upstream', 'new-api', '--step', '3', '--sidecar-url', a.url, '--formats', 'openai-chat'])
  fs.chmodSync(f2, 0o600)
  const t2 = fs.readFileSync(f2, 'utf8')
  await init(['--dir', d2, '--upstream', 'new-api', '--step', '3', '--sidecar-url', b.url, '--formats', 'openai-chat'])
  assert.equal(fs.readFileSync(f2, 'utf8'), t2)
})

test('secrets: no value of SIGNER_KEY, a token or a delegation signature reaches stdout, stderr, --json or the state file; an existing .env is never read or changed', async () => {
  const w = world()
  const s = await sidecar({ FORMATS: 'openai-chat' })
  const dir = newDir()
  const envFile = path.join(dir, '.env')
  const mine = `SIGNER_KEY=${SENTINEL}\nAPI_KEY=${SENTINEL_TOKEN}\nDELEGATION_SIG=0x${'ab'.repeat(65)}\nFORMATS=openai-chat\n`
  fs.writeFileSync(envFile, mine, { mode: 0o600 })
  const before = fs.statSync(envFile).mtimeMs
  const env = { SIGNER_KEY: SENTINEL, API_KEY: SENTINEL_TOKEN, OPENAI_API_KEY: SENTINEL_TOKEN, DELEGATION_SIG: `0x${'cd'.repeat(65)}` }
  const outputs = []
  for (const extra of [[], ['--json'], ['--lang', 'en'], ['--lang', 'zh']]) {
    for (const step of ['0', '1', '2', '3']) {
      const r = await init(['--dir', dir, '--upstream', 'new-api', '--step', step, '--name', NAME, '--sidecar-url', s.url, '--formats', 'openai-chat', ...extra], { env, w })
      outputs.push(r.out, r.err)
    }
  }
  const state = fs.readFileSync(path.join(dir, STATE_FILE), 'utf8')
  for (const text of [...outputs, state]) {
    for (const v of [SENTINEL, SENTINEL.slice(2), SENTINEL_TOKEN, 'ab'.repeat(65), 'cd'.repeat(65)]) assert.ok(!text.includes(v), `a secret value leaked:\n${text.slice(0, 400)}`)
  }
  assert.equal(fs.readFileSync(envFile, 'utf8'), mine, '.env unchanged'); assert.equal(fs.statSync(envFile).mtimeMs, before)
  assert.match(outputs.join('\n'), /exists: the wizard did not read it and did not change it/)
  assert.match(outputs.join('\n'), /Make sure .*\.env says FORMATS=openai-chat/)
  // the state file: answers and results only / 状态文件：只有答案与结果
  const j = JSON.parse(state)
  assert.deepEqual(Object.keys(j.answers).sort(), ['formats', 'name', 'sidecarUrl', 'upstream'])
  assert.ok(!/SIGNER|DELEGATION|TOKEN|SECRET/.test(state))
  // an --answers file never takes a secret / --answers 从不接收机密
  for (const k of ['signerKey', 'SIGNER_KEY', 'apiToken', 'delegationSig', 'mnemonic']) {
    const r = await init(['--dir', newDir(), '--step', '3', '--answers', answers(newDir(), { [k]: SENTINEL })], { env })
    assert.equal(r.code, 2); assert.match(r.err, /the wizard never takes a key, token, signature, password or seed/); assert.ok(!r.err.includes(SENTINEL))
  }
})

// ════ steps 1 and 2: the chain, read only ════════════════════════════════════════════════════════════════════════════
test('steps 1 and 2: the circuit, then the container and the activation, read on the fake chain; not activated is TODO (exit 0) with the doctor\'s bind sentence; no transaction', async () => {
  const w = world()
  const dir = newDir()
  // no name yet: TODO, the next command asks for it / 还没有名字：TODO
  const none = await init(['--dir', dir, '--step', '1'])
  assert.equal(none.code, 0); assert.match(none.out, /TODO {2}\[1\/7\] waiting for you: no name yet/)
  assert.match(lastLine(none.out), /next: \/ 下一条命令: tapeapi init --step 1 --name '<#ID>\.<processor>\.tape' --dir /)
  // a name with no circuit / 没有电路的名字
  const nobody = await init(['--dir', dir, '--step', '1', '--name', '43.7.tape'], { w })
  assert.equal(nobody.code, 0, nobody.out); assert.match(nobody.out, /TODO {2}\[1\/7\] not yet/)
  const one = await init(['--dir', dir, '--step', '1', '--name', NAME], { w })
  assert.equal(one.code, 0, one.out); assert.match(one.out, /DONE {2}\[1\/7\] the name resolves/)
  assert.match(one.out, /\| {2}1 PASS {2}Name resolves to a processor/); assert.match(one.out, /\| {2}2 PASS {2}Circuit exists/)
  assert.match(lastLine(one.out), /tapeapi init --step 2 /)
  // not activated / 未激活
  w.chain.setUnactivated()
  const two = await init(['--dir', dir, '--step', '2'], { w })
  assert.equal(two.code, 0, two.out)
  assert.match(two.out, /\| {2}4 FAIL {2}Name is activated/)
  assert.match(two.out, /bind\("42\.7\.tape", 0x[0-9a-fA-F]{40}, months\)/)
  assert.match(two.out, /TODO {2}\[2\/7\] waiting for you: activate first, then check again\. The wizard does not pay, sign or send any transaction\./)
  assert.match(two.out, /由你自己付，我们不垫付/)
  assert.match(lastLine(two.out), /next: \/ 下一条命令: tapeapi init --step 2 /)
  // activated: DONE, and the state remembers the name / 激活后：DONE，状态文件记住名字
  w.chain.conform.defaultLive = true
  const done = await init(['--dir', dir, '--step', '2'], { w })
  assert.equal(done.code, 0, done.out); assert.match(done.out, /DONE {2}\[2\/7\] the container is opened and the name is activated/)
  // the default run picks the first step not done: 0 is SKIP-ed only when it ran / 默认运行第一个未完成的步骤
  assert.match((await init(['--dir', dir], { w })).out, /\[0\/7\] SKIP {2}Local trial.*<- this run/)
  assert.deepEqual(w.methods.filter((m) => /send|sign/i.test(m)), [], 'no transaction, no signing request')
  assert.ok(w.methods.length > 0)
  // the chain unreadable: exit 3 / 链读不到：退出码 3
  const down = world()
  down.apiOptions.fetch = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }
  const r3 = await init(['--dir', newDir(), '--step', '1', '--name', NAME], { w: down })
  assert.equal(r3.code, 3, r3.out); assert.match(r3.out, /ERR +\[1\/7\] the chain could not be read/)
})

// ════ step 3: the sidecar in setup mode, the price table ═════════════════════════════════════════════════════════════
test('step 3: setup mode missing only what the console gives is DONE once the price table exists and its report is confirmed read (--yes does not count)', async () => {
  const s = await sidecar({ FORMATS: 'openai-chat' })
  const dir = newDir()
  const base = ['--dir', dir, '--upstream', 'new-api', '--step', '3', '--sidecar-url', s.url, '--formats', 'openai-chat']
  // no price table yet: TODO, with the commands to make one / 还没有价目表：TODO
  const noTable = await init(base)
  assert.equal(noTable.code, 0, noTable.out)
  assert.match(noTable.out, /TODO {2}\[3\/7\] the sidecar is in setup mode as expected; the price table is still to do/)
  assert.match(noTable.out, /curl -s https:\/\/<your new-api>\/api\/pricing > pricing\.json/)
  assert.match(noTable.out, /tapeapi prices convert pricing\.json --status status\.json --usd-exchange-rate <usd_exchange_rate of your \/api\/status> --fetched-as anonymous --out /)
  assert.match(noTable.out, /\| {2}6 FAIL {2}Manifest format \(TAPI-20\)/)
  assert.match(noTable.out, /由你自己付，我们不垫付/)
  // the table converted: the report must be confirmed read, and --yes is not that / 价目表已转换：须确认读过报告，--yes 不算
  await convertInto(dir)
  for (const extra of [[], ['--yes']]) {
    const r = await init([...base, ...extra])
    assert.equal(r.code, 2, r.out + r.err)
    assert.match(r.err, /the price conversion report is not confirmed as read: say "priceReportRead": true in --answers, or answer y on a terminal; --yes does not count/)
    assert.match(lastLine(r.err), /next: \/ 下一条命令: tapeapi prices show --models /)
  }
  const ok = await init([...base, '--answers', answers(newDir(), { priceReportRead: true })])
  assert.equal(ok.code, 0, ok.out)
  assert.match(ok.out, /DONE {2}\[3\/7\] exit 1 is the expected result here: the only failure is "manifest-format" in SETUP MODE/)
  assert.match(ok.out, /fetched as \/ 取价身份 anonymous/)
  assert.match(lastLine(ok.out), /next: \/ 下一条命令: tapeapi init --step 4 /)
  // kept for that price content: the next run does not ask; changed prices ask again / 对这份价目内容有效；价目变了要重新确认
  assert.equal((await init(base)).code, 0)
  const st = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8'))
  assert.match(st.priceReportFor, /^[0-9a-f]{64}$/); assert.equal(st.answers.priceReportRead, undefined)
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'models.newapi-source.json'), 'utf8'))
  meta.source.content_sha256 = 'f'.repeat(64)
  fs.writeFileSync(path.join(dir, 'models.newapi-source.json'), JSON.stringify(meta))
  assert.equal((await init(base)).code, 2)
  // on a terminal: asked once / 终端里：问一次
  const asked = []
  const tty = await init(base, { ask: async (q) => { asked.push(q); return 'y' } })
  assert.equal(tty.code, 0, tty.out); assert.equal(asked.length, 1); assert.match(asked[0], /read every REFUSED, REVIEW and NOTE line/)
})

test('step 3: an address that is not a sidecar is FAIL (exit 1) with the doctor\'s fix; a sidecar whose configuration is wrong is FAIL naming the problem', async () => {
  const page = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body>Welcome to nginx!</body></html>') })
  await new Promise((ok) => page.listen(0, '127.0.0.1', ok))
  closers.push(() => new Promise((ok) => { page.closeAllConnections(); page.close(ok) }))
  const url = `http://127.0.0.1:${page.address().port}`
  const r = await init(['--dir', newDir(), '--upstream', 'new-api', '--step', '3', '--sidecar-url', url, '--formats', 'openai-chat'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /an HTML page/)
  assert.match(r.out, /FAIL {2}\[3\/7\] not done yet: .* does not reach a sidecar in setup mode/)
  assert.match(lastLine(r.out), /next: \/ 下一条命令: tapeapi init --step 3 /)
  const w = world()
  const s = await sidecar({ ...w.identity, FORMATS: 'openai-chat,claude' })
  const bad = await init(['--dir', newDir(), '--upstream', 'new-api', '--step', '3', '--sidecar-url', s.url, '--formats', 'openai-chat'])
  assert.equal(bad.code, 1, bad.out)
  assert.match(bad.out, /FAIL {2}\[3\/7\] the sidecar answers but its configuration is wrong: FORMATS names a format this sidecar does not know/)
})

// ════ steps 4 to 7: the whole path on the fake chain ═════════════════════════════════════════════════════════════════
test('steps 4 to 7: the delegation, the manifest published (both resolutions exit 0), connect, the daily check; FORMATS compared with what is declared', async () => {
  const w = world()
  const dir = newDir()
  await convertInto(dir)
  // The sidecar prices with a table of its own without price hints (the sample's has output prices below input ones,
  // which the doctor warns about, and --strict would count). / 旁路用一张没有价格提示的价目表（样例里有输出价低于输入价，doctor 会警告）。
  const table = path.join(newDir(), 'clean.models.json')
  fs.writeFileSync(table, JSON.stringify([{ id: 'vendor-a-chat-3.2', prices: [{ currency: 'USD', unit: '1M tokens', input: '0.5', output: '1.5' }] }]))
  const s = await sidecar({ ...w.identity, FORMATS: 'openai-chat', MODELS_FILE: table, UPSTREAM_BASE_URL: `${(await fakeNewApi()).url}/v1`, TAPE_NAME: NAME, RATE_IP: '0' })
  const common = ['--dir', dir, '--upstream', 'new-api', '--name', NAME, '--sidecar-url', s.url, '--formats', 'openai-chat']
  const four = await init([...common, '--step', '4'], { w })
  assert.equal(four.code, 0, four.out)
  assert.match(four.out, /Stop screen sharing before you open console step 3/)
  assert.match(four.out, /DONE {2}\[4\/7\] the sidecar signs with the delegated key, and its manifest declares exactly openai-chat/)
  // chosen otherwise: FAIL before anything is published / 选择不同：发布前即 FAIL
  const other = await init(['--dir', newDir(), '--upstream', 'new-api', '--name', NAME, '--sidecar-url', s.url, '--formats', 'openai-chat,anthropic-messages', '--step', '4'], { w })
  assert.equal(other.code, 1, other.out); assert.match(other.out, /declares openai-chat, but you chose openai-chat, anthropic-messages/)
  // not published yet: TODO / 尚未发布：TODO
  const unpublished = await init([...common, '--step', '5'], { w })
  assert.equal(unpublished.code, 0, unpublished.out)
  assert.match(unpublished.out, /TODO {2}\[5\/7\] waiting for you: the manifest is not on chain yet \(console step 5\)/)
  assert.match(unpublished.out, /the console's preview must list exactly these formats: openai-chat/)
  assert.match(unpublished.out, /its history cannot be deleted/); assert.match(unpublished.out, /由你自己付，我们不垫付/)
  await publish(w, s)
  const five = await init([...common, '--step', '5'], { w })
  assert.equal(five.code, 0, five.out)
  // each run with what the doctor said under it / 每次运行下面是 doctor 的原话
  assert.match(five.out, /check \/ 检查: {2}tapeapi doctor 42\.7\.tape\n {2}\| {2}1 PASS {2}Name resolves[^]*\| result: 14 passed, 0 warned, 0 failed, 0 skipped; exit 0 \/ [^\n]*\n\n {2}check \/ 检查: {2}tapeapi doctor 42\.7\.tape --no-conform\n {2}\| result: 14 passed, 0 warned, 0 failed, 0 skipped; exit 0/)
  assert.match(five.out, /DONE {2}\[5\/7\] both runs exit 0/)
  const mismatch = await init(['--dir', newDir(), '--name', NAME, '--formats', 'openai-chat,openai-embeddings', '--step', '5'], { w })
  assert.equal(mismatch.code, 1, mismatch.out); assert.match(mismatch.out, /the manifest on chain declares openai-chat, but you chose openai-chat, openai-embeddings/)
  const six = await init([...common, '--step', '6'], { w })
  assert.equal(six.code, 0, six.out)
  assert.match(six.out, /connect: ok; formats openai-chat/)
  assert.match(six.out, /tapeapi connect 42\.7\.tape --proxy/)
  assert.ok(six.out.includes(INOTES.receipt.en) && six.out.includes(INOTES.receipt.zh))
  const seven = await init([...common, '--step', '7'], { w })
  assert.equal(seven.code, 0, seven.out)
  assert.match(seven.out, /DONE {2}\[7\/7\] every check is clean today/)
  assert.match(seven.out, /tapeapi prices check pricing\.json --models models\.json --status status\.json --fetched-as anonymous/)
  assert.match(lastLine(seven.out), /next: \/ 下一条命令: tapeapi doctor 42\.7\.tape --strict$/)
  const renew = await init([...common, '--renew'], { w })
  assert.equal(renew.code, 0); assert.match(renew.out, /1\. Renew the delegation every 90 days/)
  // the overview: every step done (0 skipped) once each ran / 总览：各步都运行过
  for (const k of ['0', '1', '2', '3']) await init([...common, '--step', k, '--answers', answers(newDir(), { priceReportRead: true })], { w })
  // (the state file, not one more doctor run: the sidecar's free receipt method allows a few lookups per minute)
  // （读状态文件，而不是再跑一次 doctor：旁路的免费回执方法每分钟只允许几次查询）
  const st = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8'))
  assert.deepEqual(STEPS.map((x, i) => st.steps[i]?.status), ['SKIP', 'DONE', 'DONE', 'DONE', 'DONE', 'DONE', 'DONE', 'DONE'])
  assert.deepEqual(w.methods.filter((m) => /send|sign/i.test(m)), [], 'no transaction')
  // step 6 for an unpaid name: FAIL / 未付费：FAIL
  w.chain.setUnactivated()
  const unpaid = await init([...common, '--step', '6'], { w })
  assert.equal(unpaid.code, 1); assert.match(unpaid.out, /connect: unpaid/)
})

// connect shows an MCP tool service (an mcp field, no ai field; TAPI-20 §3.8) as usable, exit 0; this wizard sets up an
// AI service, so step 6 is FAIL there (2.3). The manifest is the one the signing proxy publishes for the demo tools.
// connect 把 MCP 工具服务（有 mcp、无 ai）显示为可用、退出 0；本向导搭建的是 AI 服务，所以第 6 步判 FAIL（2.3）。清单取签名代理为演示工具发布的那份。
test('step 6: a published manifest that is an MCP tool service (mcp, no ai) is FAIL (exit 1), although connect shows it as usable', async () => {
  const w = world()
  const core = createMcpServer({ info: { name: 'demo', version: '1' }, listTools: async () => DEMO_TOOLS, callTool: async () => ({ content: [] }) })
  const proxy = createMcpProxy({ upstream: { call: (m) => core.handle(m) }, signerKey: w.signerKey, log: () => {}, rateLimit: false,
    manifestBase: { name: 'Example tools', circuits: w.c.circuits, tokenId: '42', container: w.c.container, delegation: { expires: Number(w.identity.DELEGATION_EXPIRES), sig: w.identity.DELEGATION_SIG }, endpoints: { live: ['https://api.example.com/tapeapi/v1'], async: false } } })
  const manifest = await proxy.ready
  assert.equal(manifest.ai, undefined)
  assert.match(manifest.mcp.toolsSha256, /^[0-9a-f]{64}$/)
  w.chain.writeFile(w.c.container, '.well-known/tapeapi.json', JSON.stringify(manifest))
  const args = ['--dir', newDir(), '--name', NAME, '--formats', 'openai-chat', '--step', '6']
  const r = await init(args, { w })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /connect: ok/)
  assert.match(r.out, /FAIL {2}\[6\/7\] the published manifest is an MCP tool service \(an mcp field, no ai field\), not the AI service this wizard sets up\./)
  assert.ok(r.out.includes('发布的清单是 MCP 工具服务（有 mcp 字段、没有 ai 字段），不是本向导搭建的 AI 服务。'), r.out)
  assert.doesNotMatch(r.out, /DONE {2}\[6\/7\]/)
  const j = await init([...args, '--json'], { w })
  assert.equal(j.code, 1)
  const doc = JSON.parse(j.out)
  assert.equal(doc.ok, false); assert.equal(doc.exitCode, 1)
  assert.equal(doc.step.index, 6); assert.equal(doc.step.status, 'FAIL')
  assert.deepEqual(w.methods.filter((m) => /send|sign/i.test(m)), [], 'no transaction')
})

// ════ the interface ══════════════════════════════════════════════════════════════════════════════════════════════════
test('first screen: the boundary, "a receipt proves only what its signer says", and who pays, in every text run; --json carries them as notes', async () => {
  const r = await init(['--dir', newDir(), '--step', '0'])
  const head = r.out.split('\n').slice(0, 8).join('\n')
  for (const t of [INOTES.boundary, INOTES.receipt, INOTES.money]) { assert.ok(head.includes(t.en), t.en); assert.ok(head.includes(t.zh), t.zh) }
  assert.match(head, /A receipt proves only what its signer says\./); assert.match(head, /回执只证明签名方所说的内容/)
  assert.match(head, /由你自己付，我们不垫付/)
  const j = JSON.parse((await init(['--dir', newDir(), '--step', '0', '--json', '--lang', 'en'])).out)
  assert.equal(j.tool, 'tapeapi'); assert.equal(j.command, 'init'); assert.equal(j.experimental, true); assert.equal(j.exitCode, 0)
  assert.equal(j.step.id, 'trial'); assert.equal(j.step.status, 'SKIP'); assert.equal(j.notes.receipt, INOTES.receipt.en)
  assert.equal(j.next.startsWith('tapeapi init --step 1'), true)
  assert.equal(j.steps.length, STEPS.length)
})

test('--lang: en has no Chinese, zh no English sentences; usage mistakes are exit 2 with the next command; --help lists the steps', async () => {
  const en = await init(['--dir', newDir(), '--step', '0', '--lang', 'en'])
  assert.doesNotMatch(en.out, /[一-鿿]/)
  const zh = await init(['--dir', newDir(), '--step', '0', '--lang', 'zh'])
  assert.doesNotMatch(zh.out, /Who does it|A receipt proves/)
  for (const args of [['--step', '9'], ['--bogus'], ['--dir', path.join(TMP, 'nope')], ['--upstream', 'litellm'], ['--sidecar-url', 'http://example.com', '--step', '3'], ['--name', 'not-a-name'], ['extra']]) {
    const r = await init(args)
    assert.equal(r.code, 2, args.join(' ')); assert.equal(r.out, '')
  }
  const h = await init(['--help'])
  assert.equal(h.code, 0)
  for (const s of STEPS) assert.ok(h.out.includes(s.title.en))
  assert.match(h.out, /--formats <list> {5}REQUIRED from step 3 on, no default/)
})

test('tapeapi init through the dispatcher: no terminal, no --formats at step 3 is exit 2 on stderr, nothing on stdout', () => {
  const dir = newDir()
  const r = spawnSync(process.execPath, [BIN, 'init', '--dir', dir, '--upstream', 'new-api', '--step', '3', '--sidecar-url', 'https://api.example.com'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(r.status, 2, r.stderr)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /FORMATS is not chosen/)
  assert.match(lastLine(r.stderr), /^next: \/ 下一条命令: node \S*sdk\/bin\/tapeapi\.js init --step 3 --formats openai-chat --upstream new-api --sidecar-url https:\/\/api\.example\.com --dir /)
  const t = spawnSync(process.execPath, [BIN, 'init', '--dir', dir, '--step', '0'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(t.status, 0, t.stderr)
  assert.match(t.stdout, /Optional: run node \S*examples\/relay-trial\/trial\.mjs/)
})

test('wording: no line the wizard writes, and no line of its source, says certified, partner, recommended, audited, mainnet-ready, adopted, zero cost (or 通过)', () => {
  assert.ok(seen.length > 100)
  const bad = seen.filter((l) => FORBIDDEN.test(l))
  assert.deepEqual(bad, [])
  for (const f of ['../src/init-cli.js', '../src/prices-cli.js']) {
    const lines = fs.readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8').split('\n')
    assert.deepEqual(lines.filter((l) => FORBIDDEN.test(l)), [], f)
  }
})

// Review C-1: steps 3 and 4 read the doctor's structured `setup` field, not its English text; a doctor without the field
// (older wording) still works through the text. / 审查 C-1：第 3、4 步读 doctor 的结构化 setup 字段而不是英文文案；没有该字段的旧 doctor
// 仍按文案读取。
test('setupMissing: the structured setup field first, the old detail text as the fallback', () => {
  const rep = (c) => ({ checks: [{ id: 'manifest-format', status: 'fail', ...c }] })
  // the field wins even when the text says something else (wording is free to change) / 字段优先，即使文案已改
  assert.deepEqual(setupMissing(rep({ detail: 'reworded entirely', setup: { missing: ['SIGNER_KEY', 'CIRCUITS'], problem: null, signer: null } })), { missing: ['SIGNER_KEY', 'CIRCUITS'], problem: null })
  assert.deepEqual(setupMissing(rep({ detail: 'reworded', setup: { missing: ['X'], problem: 'FORMATS names an unknown format', signer: null } })), { missing: [], problem: 'FORMATS names an unknown format' })
  // fallback: the 2.2 doctor's text / 回退：2.2 doctor 的文案
  assert.deepEqual(setupMissing(rep({ detail: 'the sidecar is in SETUP MODE: missing SIGNER_KEY (secret), CIRCUITS; its signing address is 0x' + '1'.repeat(40) })), { missing: ['SIGNER_KEY (secret)', 'CIRCUITS'], problem: null })
  assert.deepEqual(setupMissing(rep({ detail: 'the sidecar is in SETUP MODE: PUBLIC_URL is not https' })), { missing: [], problem: 'PUBLIC_URL is not https' })
  // not setup mode / 不是设置模式
  assert.equal(setupMissing(rep({ detail: 'HTTP 404' })), null)
  assert.equal(setupMissing({ checks: [{ id: 'manifest-format', status: 'pass', detail: 'ok', setup: { missing: [], problem: null, signer: null } }] }), null)
  assert.equal(setupMissing({ checks: [] }), null)
})
