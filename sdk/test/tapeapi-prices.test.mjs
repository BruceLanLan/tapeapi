// tapeapi prices (sdk/src/prices-cli.js, experimental): convert and check are an entry for the converter that stays in
// examples/new-api-sidecar/pricing-convert.mjs (its arguments passed as given, its output and exit status as they are);
// show reads a price table and its source record, files only. The price list comes from the fake new-api, saved the way
// an operator saves his own.
// tapeapi prices（实验性）：convert 与 check 是留在 examples 的转换器的入口（参数原样传入，输出与退出码不变）；show 只读价目表与来源记录。
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { NOTES } from '../src/connect.js'
import { runPrices, sourceRecordOf, CONVERTER_TOOL, PNOTES } from '../src/prices-cli.js'
import { startFakeNewApi } from '../../examples/new-api-sidecar/fake-new-api.mjs'
import * as converter from '../../examples/new-api-sidecar/pricing-convert.mjs'

const BIN = fileURLToPath(new URL('../bin/tapeapi.js', import.meta.url))
const CONVERT = fileURLToPath(new URL('../../examples/new-api-sidecar/pricing-convert.mjs', import.meta.url))
const host = { ...fs, ...path }
const TMP = fs.mkdtempSync(path.join(tmpdir(), 'tapeapi-prices-test-'))
let api = null
test.before(async () => { api = await startFakeNewApi({ port: 0 }) })
test.after(async () => { await api?.close(); fs.rmSync(TMP, { recursive: true, force: true }) })
let n = 0
async function saved() {
  const dir = path.join(TMP, `d${++n}`); fs.mkdirSync(dir)
  for (const p of ['pricing', 'status']) fs.writeFileSync(path.join(dir, `${p}.json`), Buffer.from(await (await fetch(`${api.url}/api/${p}`)).arrayBuffer()))
  return dir
}
async function prices(args, io = {}) {
  let out = '', err = ''
  const r = await runPrices(args, { cmd: 'tapeapi', version: '0.0.0-test', host, converter, env: {}, stdout: (s) => { out += s }, stderr: (s) => { err += s }, ...io })
  return { code: r.exitCode, out, err }
}
/** The converter run as a program, the way its README runs it. / 按 README 的方式把转换器当作程序运行。 */
const direct = (args, cwd) => spawnSync(process.execPath, [CONVERT, ...args], { encoding: 'utf8', cwd })
const lastLine = (s) => s.trimEnd().split('\n').pop()
const FORBIDDEN = /认证|合作伙伴|推荐|已审计|主网可用|成为标准|通过|采用|免费接入|零成本|certified|partner|recommend|audited|adopted|zero cost/i

test('prices convert: the converter\'s stdout byte for byte and its stderr unchanged inside, the same files, exit 0; the entry adds the fetched-as and unverified notes', async () => {
  const dir = await saved()
  const args = ['pricing.json', '--status', 'status.json', '--usd-exchange-rate', '7', '--fetched-as', 'anonymous']
  const mine = await prices(['convert', ...args.map((a) => (a.endsWith('.json') ? path.join(dir, a) : a))])
  const theirs = direct(args, dir)
  assert.equal(mine.code, 0, mine.err); assert.equal(theirs.status, 0)
  assert.equal(mine.out, theirs.stdout, 'stdout: the price table, byte for byte')
  const shownPaths = (s) => s.split(dir + path.sep).join('')
  assert.ok(shownPaths(mine.err).includes(theirs.stderr), 'the converter\'s report is inside, unchanged')
  assert.match(mine.err, /^tapeapi prices convert 0\.0\.0-test \(experimental \/ 实验性\): An entry for examples\/new-api-sidecar\/pricing-convert\.mjs/)
  assert.match(mine.err, /fetched as: anonymous \(stated\)/); assert.match(mine.err, /取价身份：匿名（已说明）/)
  assert.ok(mine.err.includes(PNOTES.unverified.en) && mine.err.includes(PNOTES.unverified.zh))
  assert.match(mine.err, /未核实/)
  // --out: the same two files the converter writes / --out：与转换器写出的同样两个文件
  const out = path.join(dir, 'models.json')
  assert.equal((await prices(['convert', ...args.map((a) => (a.endsWith('.json') ? path.join(dir, a) : a)), '--out', out])).code, 0)
  assert.ok(fs.existsSync(out) && fs.existsSync(sourceRecordOf(out)))
  assert.equal(JSON.parse(fs.readFileSync(sourceRecordOf(out), 'utf8')).tool, converter.TOOL)
  assert.equal(CONVERTER_TOOL, converter.TOOL)
  assert.equal(sourceRecordOf('a/models.json'), 'a/models.newapi-source.json'); assert.equal(sourceRecordOf('table'), 'table.newapi-source.json')
})

test('prices convert: options pass through as they are (--quota-per-unit, --fetched-as user, --exclude); a usage mistake is the converter\'s exit 2, then a next line', async () => {
  const dir = await saved()
  const p = path.join(dir, 'pricing.json')
  const q = await prices(['convert', p, '--usd-exchange-rate', '7', '--quota-per-unit', '1000000', '--fetched-as', 'user', '--exclude', 'vendor-a-flash-4'])
  assert.equal(q.code, 0, q.err)
  assert.match(q.err, /quota_per_unit 1000000 \(from --quota-per-unit\), fetched as user/)
  assert.match(q.err, /REFUSED vendor-a-flash-4: excluded with --exclude/)
  assert.match(q.err, /取价身份：登录用户（已说明）/)
  for (const args of [[p], [p, '--usd-exchange-rate', '7', '--fetched-as', 'admin'], [p, '--bogus']]) {
    const r = await prices(['convert', ...args])
    const d = direct(args)
    assert.equal(r.code, 2); assert.equal(d.status, 2)
    assert.ok(r.err.includes(d.stderr), 'the converter\'s own message')
    assert.equal(lastLine(r.err), 'next: / 下一条命令: tapeapi prices convert --help')
    assert.equal(r.out, '')
  }
  assert.equal((await prices(['convert', p, '--check'])).code, 2)
  // --help: the converter's own usage / --help：转换器自己的用法
  const h = await prices(['convert', '--help'])
  assert.equal(h.code, 0); assert.equal(h.out, direct(['--help']).stdout)
})

test('prices check: the converter\'s --check, exit 0 with no drift, exit 1 on drift with the DRIFT lines and the same command as next', async () => {
  const dir = await saved()
  const j = (f) => path.join(dir, f)
  assert.equal((await prices(['convert', j('pricing.json'), '--status', j('status.json'), '--usd-exchange-rate', '7', '--fetched-as', 'anonymous', '--out', j('models.json')])).code, 0)
  const args = [j('pricing.json'), '--models', j('models.json'), '--status', j('status.json'), '--fetched-as', 'anonymous']
  const clean = await prices(['check', ...args])
  assert.equal(clean.code, 0, clean.err); assert.match(clean.err, /no drift/)
  assert.ok(clean.err.includes(direct(['--check', ...args]).stderr))
  const changed = JSON.parse(fs.readFileSync(j('pricing.json'), 'utf8'))
  changed.data[0].model_ratio = Number(changed.data[0].model_ratio) * 2
  fs.writeFileSync(j('pricing.json'), JSON.stringify(changed))
  const drift = await prices(['check', ...args])
  assert.equal(drift.code, 1)
  assert.match(drift.err, /^DRIFT price-changed: /m)
  assert.equal(lastLine(drift.err), `next: / 下一条命令: tapeapi prices check ${args.join(' ')}`)
  // --fetched-as passes through: another identity is drift / --fetched-as 原样传入：换了取价身份即漂移
  const who = await prices(['check', j('pricing.json'), '--models', j('models.json'), '--fetched-as', 'user'])
  assert.equal(who.code, 1); assert.match(who.err, /DRIFT fetched-as/)
})

test('prices convert|check outside a checkout: exit 2 with the clone command, nothing run, nothing on stdout', async () => {
  for (const sub of ['convert', 'check']) {
    const r = await prices([sub, 'pricing.json', '--usd-exchange-rate', '7'], { converter: null })
    assert.equal(r.code, 2); assert.equal(r.out, '')
    assert.match(r.err, /the converter examples\/new-api-sidecar\/pricing-convert\.mjs is not here: it is part of a checkout of the repository, not of the package/)
    assert.match(lastLine(r.err), /^next: \/ 下一条命令: git clone https:\/\/github\.com\/BruceLanLan\/tapeapi\.git && cd tapeapi && npm ci --no-audit --no-fund$/)
  }
})

test('prices show: the table, who fetched the list (取价身份), the unverified note, refusals and flags from the source record; files only; --json', async () => {
  const dir = await saved()
  const j = (f) => path.join(dir, f)
  await prices(['convert', j('pricing.json'), '--status', j('status.json'), '--usd-exchange-rate', '7', '--fetched-as', 'anonymous', '--out', j('models.json')])
  let fetched = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = (...a) => { fetched++; return realFetch(...a) }
  try {
    const r = await prices(['show', '--models', j('models.json')], { converter: null })
    assert.equal(r.code, 0, r.err); assert.equal(r.err, '')
    for (const want of [NOTES.prices.en, NOTES.prices.zh, PNOTES.unverified.en, PNOTES.unverified.zh, 'fetched as / 取价身份', 'anonymous (stated) / 匿名（已说明）', 'usd_exchange_rate', 'quota_per_unit', '500000', 'vendor-a-chat-3.2', '(=input)', 'refused (not in the table) / 拒绝（不在价目表里）', 'flagged for you to confirm / 待你确认', 'output-below-input', 'USD prices are for display only']) {
      assert.ok(r.out.includes(want), `missing ${want}\n${r.out}`)
    }
    assert.match(r.out, /price content \/ 价目内容 +[0-9a-f]{12}\.\.\./)
    assert.doesNotMatch(r.out, /\*\*\*/, 'nothing taken for a key')
    const o = JSON.parse((await prices(['show', '--models', j('models.json'), '--json', '--lang', 'en'], { converter: null })).out)
    assert.equal(o.command, 'prices show'); assert.equal(o.exitCode, 0); assert.equal(o.source.fetchedAs, 'anonymous'); assert.equal(o.source.fetchedAsStated, true)
    assert.equal(o.notes.unverified, PNOTES.unverified.en)
    assert.ok(o.items.length > 0 && o.items.every((m) => m.currency === 'USD'))
    // not stated: a WARN line / 未说明：WARN 一行
    await prices(['convert', j('pricing.json'), '--status', j('status.json'), '--usd-exchange-rate', '7', '--out', j('anon.json')])
    const ns = await prices(['show', '--models', j('anon.json'), '--lang', 'zh'], { converter: null })
    assert.match(ns.out, /WARN {2}未说明：请加 --fetched-as anonymous\|user 重新转换/)
    // a hand-written table: shown, with the reason there is no record / 手写的价目表：照常显示，并说明没有来源记录
    fs.writeFileSync(j('hand.json'), JSON.stringify([{ id: 'm', prices: [{ currency: 'USD', unit: '1M tokens', input: '1', output: '2' }] }]))
    const hand = await prices(['show', '--models', j('hand.json'), '--lang', 'en'], { converter: null })
    assert.equal(hand.code, 0); assert.match(hand.out, /no source record \(.*hand\.newapi-source\.json\): a table written by hand, or converted without --out/)
    // usage mistakes / 用法错误
    for (const args of [['show', '--models', j('none.json')], ['show', 'extra'], ['show', '--lang', 'fr'], ['bogus'], []]) {
      const u = await prices(args, { converter: null })
      assert.equal(u.code, 2, args.join(' ')); assert.equal(u.out, ''); assert.match(lastLine(u.err), /^next: \/ 下一条命令: tapeapi prices --help$/)
    }
    assert.equal(fetched, 0, 'show reads files only')
    for (const t of [r.out, ns.out, hand.out]) assert.deepEqual(t.split('\n').filter((l) => FORBIDDEN.test(l)), [])
  } finally { globalThis.fetch = realFetch }
})

test('tapeapi prices through the dispatcher: the converter is loaded from the checkout', async () => {
  const dir = await saved()
  const r = spawnSync(process.execPath, [BIN, 'prices', 'convert', path.join(dir, 'pricing.json'), '--status', path.join(dir, 'status.json'), '--usd-exchange-rate', '7', '--fetched-as', 'anonymous'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, direct(['pricing.json', '--status', 'status.json', '--usd-exchange-rate', '7', '--fetched-as', 'anonymous'], dir).stdout)
  const h = spawnSync(process.execPath, [BIN, 'prices', '--help'], { encoding: 'utf8' })
  assert.equal(h.status, 0); assert.match(h.stdout, /prices convert <pricing\.json> --usd-exchange-rate <n>/)
})

// Review C-2: the byte order mark is stripped through an escape, not a literal invisible character in the source; a table
// saved with a BOM still reads. / 审查 C-2：去 BOM 用转义写法，源码里不留不可见字符；带 BOM 保存的价目表照常读取。
test('prices show: a table saved with a byte order mark reads; sdk/src holds no literal U+FEFF', async () => {
  const dir = path.join(TMP, 'bom'); fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'models.json'), '\uFEFF' + JSON.stringify([{ id: 'm', prices: [{ currency: 'USD', unit: '1M tokens', input: '1', output: '2' }] }]))
  const r = await prices(['show', '--models', path.join(dir, 'models.json'), '--lang', 'en'], { converter: null })
  assert.equal(r.code, 0, r.err); assert.match(r.out, /\bm\b/)
  const src = fileURLToPath(new URL('../src/', import.meta.url))
  for (const f of fs.readdirSync(src).filter((x) => x.endsWith('.js'))) assert.ok(!fs.readFileSync(path.join(src, f), 'utf8').includes('\uFEFF'), `${f} holds a literal U+FEFF: write it as \\uFEFF`)
})

