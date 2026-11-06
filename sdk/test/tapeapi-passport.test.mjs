// The passport on the command line (3.0, experimental): `tapeapi passport`, `tapeapi-doctor --passport`, `tapeapi connect
// --passport`, `tapeapi init --passport`, with the separate package @tapeapi/passport passed in as the bin passes it, on
// the draft's synthetic chain (passport/test/helpers/fake-chain.mjs: in process, no network). The SDK's src/ never
// imports the package; without it every command says how to get it and exits 2 (doctor: a skip).
// 命令行上的护照（3.0，实验性）。@tapeapi/passport 按 bin 的方式传入；用草案的合成链（进程内、不联网）。src/ 从不导入该包。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, relative, isAbsolute } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as passport from '@tapeapi/passport'
import { runPassport, passportInput } from '../src/passport-cli.js'
import { passportCheck, passportExit, PASSPORT_MISSING } from '../src/passport-view.js'
import { diagnose, formatReport, DOCTOR_CHECKS } from '../src/doctor.js'
import { runConnect } from '../src/connect-cli.js'
import { renderConnect } from '../src/connect.js'
import { runInit } from '../src/init-cli.js'
import { fakeChain } from '../../passport/test/helpers/fake-chain.mjs'

const V = JSON.parse(readFileSync(new URL('../../passport/test/fixtures/vectors.json', import.meta.url), 'utf8'))
const snapOf = (id) => V.resolution.find((c) => c.id === id).snapshot
// What no output may say: the init wizard's list, D-7's words and the Chinese words this repository never uses here.
// 任何输出都不得出现的词：向导的禁用表、D-7 的词，以及本仓库在这里不用的中文词。
const FORBIDDEN = /认证|合作伙伴|推荐|已审计|主网可用|成为标准|通过|采用|批准|certified|partner|recommend|audited|mainnet-ready|adopted|verified agent|official|trusted|✓|✔|✅/i
const seen = []
const capture = () => { const o = { out: '', err: '' }; o.stdout = (s) => { o.out += s; seen.push(s) }; o.stderr = (s) => { o.err += s; seen.push(s) }; return o }
const pp = async (snap, argv, extra = {}) => {
  const w = fakeChain(snap); const c = capture()
  const r = await runPassport([...argv, '--rpc', w.urls.join(',')], { cmd: 'tapeapi', version: '0.0.0-test', passport, stdout: c.stdout, stderr: c.stderr, env: {}, apiOptions: { fetch: w.fetch }, ...extra })
  return { ...c, code: r.exitCode, w }
}

test('tapeapi passport: CONFIRMED exits 0 and says what was not checked; BROKEN 1; UNAVAILABLE 3; both languages; the draft head', async () => {
  let r = await pp(snapOf('confirmed-by-agent'), ['1001'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /state \/ 状态: CONFIRMED/)
  assert.match(r.out, /TapeOut passport 7\.2\.tape \(container 0x2737ba45df033da7be7d329e13e0898ebeb1c97c\) for agent 1001, confirmed at block 50000000; site operators not checked; holder history not checked/)
  assert.match(r.out, /TapeOut 护照成立：7\.2\.tape/)
  assert.match(r.out, /not checked \/ 未检查: site operators \/ 站点操作员, holder history \/ 持有人历史/)
  assert.match(r.out, /TAPs #83 @ cae25e6/)
  assert.match(r.out, /A receipt proves only what its signer says/)
  r = await pp(snapOf('confirmed-by-agent'), ['7.2.tape', '--lang', 'en'])
  assert.equal(r.code, 0); assert.doesNotMatch(r.out, /护照/)
  r = await pp(snapOf('confirmed-by-circuit'), ['0xf8c2c2e6fac0cb46b5771ecad7d5d52aa84c6af9#7', '--json'])
  const j = JSON.parse(r.out)
  assert.equal(j.state, 'CONFIRMED'); assert.equal(j.exitCode, 0); assert.equal(j.experimental, true); assert.equal(j.draft.head, passport.DRAFT.head)
  assert.equal(j.checked.logs, false)
  r = await pp(snapOf('stale-agent-wallet'), ['1001']); assert.equal(r.code, 1); assert.match(r.out, /not confirmed: the agent wallet differs from the holder/)
  r = await pp(snapOf('registration-file-missing'), ['1001', '--lang', 'zh']); assert.equal(r.code, 1); assert.match(r.out, /不是护照：容器站点里没有登记文件/)
  r = await pp(snapOf('double-registration-both-listed'), ['1001']); assert.equal(r.code, 1); assert.match(r.out, /identities listed \/ 列出的身份: /)
  r = await pp(snapOf('stale-block'), ['1001']); assert.equal(r.code, 3); assert.match(r.out, /could not verify: stale-block/)
})

test('tapeapi passport: with --logs-rpc the history is read (and checked); usage mistakes and a missing package exit 2', async () => {
  const snap = snapOf('confirmed-by-agent'); const w = fakeChain(snap); const lw = fakeChain(snap); const c = capture()
  // The log nodes are the same fake chain behind another set of URLs. / 日志节点是同一假链的另一组地址。
  const urls = lw.urls.map((u) => u.replace('passport-fake', 'logs-fake'))
  const fetch = (u, init) => (String(u).includes('logs-fake') ? lw.fetch(String(u).replace('logs-fake', 'passport-fake'), init) : w.fetch(u, init))
  const r = await runPassport(['1001', '--rpc', w.urls.join(','), '--logs-rpc', urls.join(','), '--logs-from', '40000000', '--logs-chunk', '10000000', '--json'], { passport, stdout: c.stdout, stderr: c.stderr, env: {}, apiOptions: { fetch } })
  assert.equal(r.exitCode, 0, c.err)
  const j = JSON.parse(c.out)
  assert.deepEqual([j.warnings, j.checked.siteOperators, j.checked.holderHistory, j.checked.logs], [[], true, true, true])
  for (const argv of [[], ['x'], ['1', '2'], ['1', '--logs-from', '5'], ['1', '--rpc', 'https://only.example/'], ['1', '--logs-rpc', 'https://a.example/,https://b.example/', '--logs-chunk', '0'], ['1', '--nope']]) {
    const k = capture()
    assert.equal((await runPassport(argv, { passport, stdout: k.stdout, stderr: k.stderr, env: {} })).exitCode, 2, JSON.stringify(argv))
  }
  const k = capture()
  assert.equal((await runPassport(['1001'], { passport: null, stdout: k.stdout, stderr: k.stderr, env: {} })).exitCode, 2)
  assert.match(k.err, /separate, experimental package, @tapeapi\/passport/)
  assert.deepEqual(passportInput('4246.0'), { name: '4246.0.tape' })
  assert.deepEqual(passportInput('0x50a994e71615474b55559ff4f500928fbc339dd9#4246'), { circuit: { processor: '0x50a994e71615474b55559ff4f500928fbc339dd9', tokenId: '4246' } })
})

// From 3.0 the package ships as a tgz on the same GitHub release as the SDK, so the message names that address (the tag is
// the SDK's version, the file name passport's own, as every release address is written) and no repository path:
// it is printed by the installed SDK, where there is no checkout. / 3.0 起护照包是同一发布上的 tgz：说明里写这个地址
// （标签 = SDK 的版本，文件名 = 护照包自己的版本），不写仓库路径（打印它的是已安装的 SDK，那里没有检出）。
test('without @tapeapi/passport, every command names the passport tgz of the SDK\'s own release, never a checkout', () => {
  const sdkV = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  const ppV = JSON.parse(readFileSync(new URL('../../passport/package.json', import.meta.url), 'utf8')).version
  const url = `https://github.com/BruceLanLan/tapeapi/releases/download/v${sdkV}/tapeapi-passport-${ppV}.tgz`
  for (const t of [PASSPORT_MISSING.en, PASSPORT_MISSING.zh]) {
    assert.ok(t.includes(`npm install ${url}`), t)
    assert.equal(t.match(/releases\/download\//g).length, 1, 'one address')
    assert.doesNotMatch(t, /not in a release|npm ci|checkout|还没有进入|检出|工作区/)
  }
  assert.match(PASSPORT_MISSING.en, /experimental.*outside the compatibility promise.*after the SDK/)
  assert.match(PASSPORT_MISSING.zh, /实验性.*不在兼容承诺之内.*先装 SDK/)
})

// The doctor in URL mode, offline, on a manifest served by a fake fetch: enough for manifest-format to pass and for the
// passport check to be placed after it. / URL 离线模式：足以让清单格式检查成功，并把护照检查放在其后。
const MANIFEST = { tapeapi: '0.1', name: 'Doctor passport test', circuits: '0xf8c2c2e6fac0cb46b5771ecad7d5d52aa84c6af9', tokenId: '7', container: '0x2737ba45df033da7be7d329e13e0898ebeb1c97c', signer: '0x' + '22'.repeat(20), endpoints: { live: ['http://127.0.0.1:9/tapeapi/v1'], async: false }, methods: [{ name: 'ping', priceBEM: '0', params: {}, returns: {} }] }
const doctorFetch = async (u) => (String(u).endsWith('/.well-known/tapeapi.json') ? new Response(JSON.stringify(MANIFEST), { headers: { 'content-type': 'application/json' } }) : new Response('no', { status: 404 }))
const doctor = (p) => diagnose('http://127.0.0.1:9', { offline: true, fetch: doctorFetch, timeoutMs: 2000, passport: p })

test('tapeapi-doctor --passport: one more check right after manifest-format (not one of the 14); each state maps; counts and exit follow', async () => {
  assert.equal(DOCTOR_CHECKS.length, 14); assert.ok(!DOCTOR_CHECKS.includes('passport'))
  const without = await diagnose('http://127.0.0.1:9', { offline: true, fetch: doctorFetch, timeoutMs: 2000 })
  assert.ok(!without.checks.some((c) => c.id === 'passport'))
  const results = {}
  for (const id of ['confirmed-by-circuit', 'registration-file-missing', 'stale-agent-wallet', 'stale-block', 'circuit-none-listed']) {
    const snap = snapOf(id)
    results[id] = await passport.resolvePassport({ circuit: { processor: MANIFEST.circuits, tokenId: '7' } }, { rpc: fakeChain(snap).rpc(), config: snap.config })
  }
  const want = { 'confirmed-by-circuit': 'warn', 'registration-file-missing': 'skip', 'stale-agent-wallet': 'warn', 'stale-block': 'error', 'circuit-none-listed': 'skip' }
  for (const [id, status] of Object.entries(want)) {
    let asked = null
    const r = await doctor({ resolve: async (input) => { asked = input; return results[id] } })
    const ids = r.checks.map((c) => c.id)
    assert.equal(ids.indexOf('passport'), ids.indexOf('manifest-format') + 1, id)
    const c = r.checks.find((x) => x.id === 'passport')
    assert.equal(c.status, status, id); assert.deepEqual(asked, { circuit: { processor: MANIFEST.circuits, tokenId: '7' } })
    assert.equal(r.counts[status], without.counts[status] + 1, id)
    if (status === 'error') assert.equal(r.exitCode, without.counts.fail ? 1 : 3, 'a failure outranks an undecided check')
    // Only the passport check's own lines: the rest of the report is the doctor's existing text. / 只取护照这一项的文字。
    const text = formatReport(r, { lang: 'both' }); seen.push(JSON.stringify([c.title, c.detail, c.detailZh, c.fix]))
    assert.match(text, /Agent passport \(experimental, TAPs #83 draft\) \/ Agent 护照（实验性，TAPs #83 草案）/)
  }
  assert.equal(passportCheck({ ...results['confirmed-by-circuit'], warnings: [] }).status, 'pass')
  const missing = await doctor(null)
  assert.equal(missing.checks.find((x) => x.id === 'passport').status, 'skip')
  assert.match(missing.checks.find((x) => x.id === 'passport').detail, /@tapeapi\/passport/)
  assert.equal(passportExit({ state: 'wallet-unset' }), 1)
  // The bin: --passport reads the chain, so not with --offline. / bin：--passport 要读链，不能与 --offline 同用。
  const bin = fileURLToPath(new URL('../bin/tapeapi-doctor.js', import.meta.url))
  const sp = spawnSync(process.execPath, [bin, '--passport', '--offline', 'http://127.0.0.1:9'], { encoding: 'utf8', timeout: 300_000, killSignal: 'SIGKILL' })
  assert.equal(sp.status, 2); assert.match(sp.stderr, /--passport reads the chain/)
  assert.match(spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8', timeout: 300_000, killSignal: 'SIGKILL' }).stdout, /--passport {11}experimental \(3\.0\)/)
})

test('tapeapi connect --passport: a passport section beside the card, the exit code unchanged; nothing without the flag', async () => {
  const devManifest = { ...MANIFEST, dev: true, ai: undefined }
  const fetch = async (u) => (String(u).endsWith('/.well-known/tapeapi.json') ? new Response(JSON.stringify(devManifest), { headers: { 'content-type': 'application/json' } }) : new Response('no', { status: 404 }))
  const run = async (argv, mod) => { const c = capture(); const r = await runConnect(argv, { passport: mod, stdout: c.stdout, stderr: c.stderr, env: {}, isTTY: false, apiOptions: { fetch } }); return { ...c, code: r.exitCode } }
  const plain = await run(['--dev', 'http://127.0.0.1:9', '--no-color'], passport)
  const withIt = await run(['--dev', 'http://127.0.0.1:9', '--no-color', '--passport'], passport)
  assert.equal(withIt.code, plain.code)
  assert.doesNotMatch(plain.out, /passport \(experimental\)/)
  assert.match(withIt.out, /passport \(experimental\) \/ 护照（实验性）\n {2}not checked: a passport is read for a TapeOut name on BNB Smart Chain \(not --dev\)/)
  const missing = await run(['--dev', 'http://127.0.0.1:9', '--passport', '--json'], null)
  assert.match(JSON.parse(missing.out).passport.why.en, /@tapeapi\/passport/)
  // The section for a resolved passport, as the card renders it. / 已解析护照在卡片里的样子。
  const snap = snapOf('confirmed-by-agent')
  const result = await passport.resolvePassport(snap.input, { rpc: fakeChain(snap).rpc(), config: snap.config })
  const text = renderConnect({ target: '7.2.tape', dev: false, ok: false, exitCode: 1, status: 'not-ai', reason: { en: 'x', zh: 'x' }, service: null, formats: [], snippets: [], passport: { result } }, { lang: 'both' })
  seen.push(text)
  assert.match(text, /state \/ 状态: CONFIRMED\n {2}TapeOut passport 7\.2\.tape/)
})

const fsHost = { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, join, dirname, relative, isAbsolute }
test('tapeapi init --passport: read-only checks, the file written locally under .well-known/, the holder\'s own next steps; DONE / TODO / FAIL / ERR', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tapeapi-init-passport-'))
  try {
    const init = async (id, argv, mod = passport) => {
      const w = fakeChain(snapOf(id)); const c = capture()
      const r = await runInit(['--passport', '--dir', dir, '--rpc', w.urls.join(','), ...argv], { cmd: 'tapeapi', version: '0.0.0-test', host: fsHost, cwd: dir, passport: mod, stdout: c.stdout, stderr: c.stderr, env: {}, isTTY: false, apiOptions: { fetch: w.fetch } })
      return { ...c, code: r.exitCode, w }
    }
    const file = join(dir, '.well-known', 'agent-registration.json')
    let r = await init('confirmed-by-agent', ['--agent-id', '1001', '--name', '7.2.tape', '--gateway-domain', 'gateway.example'])
    assert.equal(r.code, 0, r.err); assert.match(r.out, /DONE {2}passport confirmed for agent 1001/)
    assert.match(r.out, /written \/ 已写出: \.well-known\/agent-registration\.json/)
    assert.match(r.out, /https:\/\/7-2\.gateway\.example\/\.well-known\/agent-registration\.json/)
    assert.match(r.out, /putFile/)
    assert.deepEqual(passport.checkRegistrationFile(new Uint8Array(readFileSync(file)), { agentId: 1001n, name: '7.2.tape' }), { ok: true })
    assert.ok(r.w.calls.every((x) => ['eth_blockNumber', 'eth_getBlockByNumber', 'eth_chainId', 'eth_getStorageAt', 'eth_call'].includes(x.method)), 'reads only')
    assert.equal(existsSync(join(dir, 'tapeapi-init.json')), false, 'the wizard state is not touched'); assert.equal(existsSync(join(dir, '.env')), false)
    rmSync(file)
    r = await init('registration-file-missing', ['--agent-id', '1001', '--name', '7.2.tape', '--json'])
    let j = JSON.parse(r.out)
    assert.deepEqual([r.code, j.status, j.passport.reasons], [0, 'TODO', ['registration-file-missing']])
    assert.equal(j.agentUri, 'https://7-2.<gateway domain>/.well-known/agent-registration.json')
    assert.ok(existsSync(file)); assert.ok(j.you.length >= 3)
    rmSync(file)
    r = await init('identity-changed-hands', ['--agent-id', '1001', '--name', '7.2.tape', '--lang', 'en'])
    assert.equal(r.code, 1); assert.match(r.out, /FAIL {2}not ready: holder-mismatch/); assert.equal(existsSync(file), false)
    r = await init('registry-changed', ['--agent-id', '1001', '--name', '7.2.tape'])
    assert.equal(r.code, 3); assert.equal(existsSync(file), false)
    for (const argv of [['--name', '7.2.tape'], ['--agent-id', 'x', '--name', '7.2.tape'], ['--agent-id', '1', '--name', '1.2.344.tape'], ['--agent-id', '1', '--name', '7.2.tape', '--step', '3'], ['--agent-id', '1', '--name', '7.2.tape', '--gateway-domain', 'no']]) {
      assert.equal((await init('confirmed-by-agent', argv)).code, 2, JSON.stringify(argv))
    }
    r = await init('confirmed-by-agent', ['--agent-id', '1', '--name', '7.2.tape'], null)
    assert.equal(r.code, 2); assert.match(r.err, /@tapeapi\/passport/)
    const c = capture()
    assert.equal((await runInit(['--agent-id', '1', '--dir', dir], { host: fsHost, cwd: dir, stdout: c.stdout, stderr: c.stderr, env: {} })).exitCode, 2, '--agent-id without --passport')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('wording: no passport output of these commands says certified, partner, recommended, audited, adopted, verified agent, trusted, a check mark, or the Chinese words', () => {
  assert.ok(seen.length > 20)
  for (const text of seen) assert.doesNotMatch(text, FORBIDDEN, text.match(FORBIDDEN)?.[0])
  for (const f of ['../src/passport-cli.js', '../src/passport-view.js']) assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), 'utf8'), FORBIDDEN, f)
})
