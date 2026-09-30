// The provider directory: the format of site/directory/providers.json, its order (never a ranking), the daily recheck's
// flags and its RPC budget. The recheck runs a stand-in for tapeapi-doctor here; the doctor has its own tests. No network.
// 服务方目录：providers.json 的格式、顺序（绝不是排名）、每日复核的标记与 RPC 预算。这里用替身代替 tapeapi-doctor；诊断自有测试。不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { validateDirectory, nextStatus, recheck, rpcMeter, newlyFailing, STALE_AFTER, PROVIDERS_FILE, STATUS_FILE, RPC_BUDGET_PER_NAME, FLAGS } from './recheck.mjs'

const entry = (name, extra = {}) => ({ name, added: '2026-10-01', ...extra })
const doc = (...providers) => ({ version: 1, providers })

test('the committed providers.json is valid, and status.json is keyed by its names only', () => {
  const d = JSON.parse(readFileSync(PROVIDERS_FILE, 'utf8'))
  assert.deepEqual(validateDirectory(d), [])
  assert.match(PROVIDERS_FILE, /site[\\/]directory[\\/]providers\.json$/, 'the website serves the very file a pull request edits')
  const st = JSON.parse(readFileSync(STATUS_FILE, 'utf8'))
  assert.equal(st.version, 1)
  // A removed entry may linger until the next recheck; the page shows only what providers.json lists.
  // 已移除的条目可能留到下次复核；页面只显示 providers.json 列出的名字。
  for (const [n, s] of Object.entries(st.providers)) assert.ok(FLAGS.includes(s.flag), `${n}: ${s.flag}`)
  assert.ok(!/rank|score|featured|sponsor/i.test(JSON.stringify(st)))
})

test('--validate reads the format only: no network, exit 0 on the committed file', () => {
  const script = fileURLToPath(new URL('./recheck.mjs', import.meta.url))
  // A fetch that throws proves no request is made. / 一旦发请求就抛错，证明不联网。
  const r = spawnSync(process.execPath, ['--import', 'data:text/javascript,globalThis.fetch=()=>{throw new Error("network")}', script, '--validate'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /format ok/)
})

test('format: a name, a date and an optional https contact; nothing else', () => {
  assert.deepEqual(validateDirectory(doc(entry('42.1013.tape', { contact: 'https://github.com/example' }), entry('7.2.344.tape'))), [])
  const bad = validateDirectory(doc(
    entry('42.1013.tape', { description: 'Fastest relay!', price: '0.1' }),
    entry('042.1013.tape'),
    { name: 'relay.tape', added: 'yesterday' },
    entry('43.1013.tape', { contact: 'http://example.com' }),
  ))
  assert.ok(bad.some((p) => /description, price are not accepted/.test(p)), bad.join('\n'))
  assert.ok(bad.some((p) => /providers\[1\]\.name must be a TapeOut name/.test(p)), bad.join('\n'))
  assert.ok(bad.some((p) => /providers\[2\]\.added must be a date/.test(p)))
  assert.ok(bad.some((p) => /contact, when given, must be an https URL/.test(p)))
  assert.ok(validateDirectory(doc(entry('42.1013.tape'), entry('42.1013.tape'))).some((p) => /listed twice/.test(p)))
  assert.ok(validateDirectory({ version: 1, providers: [], featured: ['42.1013.tape'] }).some((p) => /unknown top-level field/.test(p)))
})

test('order: the names\' own (chain, processor, #ID, numeric); any other order is refused', () => {
  assert.deepEqual(validateDirectory(doc(entry('9.1013.tape'), entry('42.1013.tape'), entry('3.2.1.tape'))), [])
  const p = validateDirectory(doc(entry('42.1013.tape'), entry('9.1013.tape')))
  assert.ok(p.some((x) => /never a ranking/.test(x)), p.join('\n'))
})

const report = (exitCode, fails = []) => ({ exitCode, checks: [{ id: 'name', status: exitCode === 3 ? 'error' : 'pass' }, ...fails.map((id) => ({ id, status: 'fail' }))] })

test('flags: ok -> failing -> stale after STALE_AFTER days; a pass resets; undecided keeps the last verdict', () => {
  let s = nextStatus(null, report(0), 'd0')
  assert.equal(s.flag, 'ok'); assert.equal(s.since, 'd0')
  s = nextStatus(s, report(1, ['receipt']), 'd1')
  assert.equal(s.flag, 'failing'); assert.deepEqual(s.failed, ['receipt']); assert.equal(s.since, 'd1')
  for (let d = 2; d <= STALE_AFTER; d++) s = nextStatus(s, report(1, ['receipt']), `d${d}`)
  assert.equal(s.flag, 'stale'); assert.equal(s.consecutiveFailures, STALE_AFTER); assert.equal(s.since, 'd1')
  const u = nextStatus(s, report(3), 'dx')
  assert.equal(u.flag, 'stale', 'an unreadable chain does not clear or change a verdict'); assert.equal(u.consecutiveFailures, STALE_AFTER)
  s = nextStatus(s, report(0), 'dy')
  assert.equal(s.flag, 'ok'); assert.equal(s.consecutiveFailures, 0); assert.equal(s.since, 'dy')
  const z = nextStatus(s, report(3), 'dz')
  assert.equal(z.flag, 'undecided')
  // Yesterday's conclusion stands: the verdict and its date are kept. / 保留前一天的结论与日期。
  assert.equal(z.verdict, 'ok'); assert.equal(z.verdictAt, 'dy'); assert.equal(z.since, 'dy')
  const z2 = nextStatus(z, report(3), 'dz2')
  assert.equal(z2.verdict, 'ok'); assert.equal(z2.verdictAt, 'dy')
  // Back from undecided: the verdict is today's; a pass after a pass keeps `since`. / 恢复后结论是今天的。
  const back = nextStatus(z2, report(0), 'e')
  assert.equal(back.flag, 'ok'); assert.equal(back.verdictAt, 'e'); assert.equal(back.since, 'dy')
  assert.equal(u.verdict, 'stale')
})

test('flags: a first recheck that cannot read the chain is undecided with no verdict at all', () => {
  const s = nextStatus(null, report(3), 'd0')
  assert.equal(s.flag, 'undecided'); assert.equal(s.verdict, null); assert.equal(s.verdictAt, null)
  const t = nextStatus(s, report(1, ['receipt']), 'd1')
  assert.equal(t.flag, 'failing'); assert.equal(t.since, 'd1'); assert.equal(t.verdict, 'failing')
})

test('newlyFailing: only an entry whose last verdict was ok, including across an undecided day', () => {
  const ok = nextStatus(null, report(0), 'a')
  const und = nextStatus(ok, report(3), 'b')
  const fail = nextStatus(und, report(1, ['cors']), 'c')
  assert.deepEqual(newlyFailing({ providers: { x: und } }, { providers: { x: fail } }), ['x'])
  assert.deepEqual(newlyFailing({ providers: { x: fail } }, { providers: { x: nextStatus(fail, report(1), 'd') } }), [], 'failing yesterday: not new')
  assert.deepEqual(newlyFailing({ providers: { x: ok } }, { providers: { x: und } }), [], 'undecided is not a failure')
  assert.deepEqual(newlyFailing(null, { providers: { x: fail } }), [])
})

test('recheck: every entry through the doctor, no key, statuses keyed by name, nothing that ranks', async () => {
  const seen = []
  const diagnoseFn = async (name, o) => { seen.push([name, o.key]); return name === '42.1013.tape' ? report(1, ['circuit']) : report(0) }
  const out = await recheck({ doc: doc(entry('11.1013.tape'), entry('42.1013.tape')), diagnoseFn, now: () => 't' })
  assert.deepEqual(seen, [['11.1013.tape', undefined], ['42.1013.tape', undefined]])
  assert.equal(out.providers['11.1013.tape'].flag, 'ok')
  assert.equal(out.providers['42.1013.tape'].flag, 'failing')
  assert.deepEqual(out.providers['42.1013.tape'].failed, ['circuit'])
  assert.ok(!/rank|score|featured|sponsor/i.test(JSON.stringify(out)))
  // A doctor that throws is undecided, not failing. / 诊断抛错是无法判定，不是失败。
  const out2 = await recheck({ doc: doc(entry('11.1013.tape')), diagnoseFn: async () => { throw new Error('boom') }, now: () => 't' })
  assert.equal(out2.providers['11.1013.tape'].flag, 'undecided')
  await assert.rejects(recheck({ doc: doc(entry('042.1013.tape')), diagnoseFn }), /not valid/)
})

test('rpc budget: counted per name, refused past the cap, and a spent budget is undecided, never failing', async () => {
  assert.ok(RPC_BUDGET_PER_NAME >= 36 && RPC_BUDGET_PER_NAME <= 100, 'measured 36 per name; the cap leaves headroom and stays bounded')
  const calls = []
  const m = rpcMeter(2, async (u) => { calls.push(u); return new Response('{}') })
  await m.fetch('https://a'); await m.fetch('https://b')
  await assert.rejects(m.fetch('https://c'), (e) => e.code === 'RPC_UNAVAILABLE')
  assert.deepEqual(calls, ['https://a', 'https://b']); assert.equal(m.used, 2); assert.equal(m.exceeded, true)

  // Each name gets its own meter; a doctor that burns through it and then reports a failure is still undecided.
  // 每个名字各有一个计数器；诊断用完预算之后报告失败，仍记为无法判定。
  const meters = []
  const apiFor = (fetch) => { meters.push(fetch); return { fetch } }
  const diagnoseFn = async (name, { api }) => {
    const n = name === '42.1013.tape' ? 10 : 3
    for (let i = 0; i < n; i++) { try { await api.fetch('https://node', {}) } catch { /* the node "failed" */ } }
    return report(1, ['circuit'])
  }
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('{}')
  try {
    const out = await recheck({ doc: doc(entry('11.1013.tape'), entry('42.1013.tape')), diagnoseFn, apiFor, rpcBudget: 5, now: () => 't' })
    assert.equal(meters.length, 2, 'one metered client per name')
    assert.equal(out.rpcBudgetPerName, 5)
    assert.equal(out.providers['11.1013.tape'].flag, 'failing'); assert.equal(out.providers['11.1013.tape'].rpcRequests, 3)
    assert.equal(out.providers['42.1013.tape'].flag, 'undecided'); assert.equal(out.providers['42.1013.tape'].rpcRequests, 5)
    assert.deepEqual(out.providers['42.1013.tape'].failed, [])
    assert.deepEqual(out.providers['42.1013.tape'].undecided, ['rpc-budget'])
  } finally { globalThis.fetch = origFetch }
})
