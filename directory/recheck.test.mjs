// The provider directory: the format of site/directory/providers.json, its order (never a ranking), the daily recheck's
// flags and its RPC budget. The recheck runs a stand-in for tapeapi-doctor here; the doctor has its own tests. No network.
// 服务方目录：providers.json 的格式、顺序（绝不是排名）、每日复核的标记与 RPC 预算。这里用替身代替 tapeapi-doctor；诊断自有测试。不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { validateDirectory, nextStatus, recheck, rpcMeter, newlyFailing, directoryApi, directoryDefaultApi, defaultModeStatus, SITE_STATUSES, STALE_AFTER, PROVIDERS_FILE, STATUS_FILE, RPC_BUDGET_PER_NAME, FLAGS } from './recheck.mjs'
import { createTapeAPI, sig, CHAINS, TapeAPIError, rpcUrlsFor } from '../sdk/src/index.js'
import { CONFORM_MODE } from '../sdk/src/conform-sibling.js'
import { createConformChain } from '../sdk/test/helpers/conform-chain.mjs'

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

test('2.0: the recheck client is the 1.x one (conform: false): one DEPRECATED warning per client, the same nodes and quorum, the metered fetch', async () => {
  const warnings = []
  const seen = []
  const api = directoryApi(async (u, init) => { seen.push(u); return new Response('{}') }, { onWarning: (w) => warnings.push(w) })
  assert.deepEqual(warnings.map((w) => [w.code, w.option]), [['DEPRECATED', 'conform']])
  assert.equal(api.chainId, 56)
  assert.equal(typeof api.resolve, 'function')
  directoryApi(async () => new Response('{}'), { onWarning: (w) => warnings.push(w) })
  assert.equal(warnings.length, 2, 'one per client, as the SDK says')
  // the metered fetch is what the client reads through / 客户端经计数的 fetch 读取
  const m = rpcMeter(3, async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x38' })))
  const metered = directoryApi(m.fetch, { onWarning: () => {} })
  await metered.rpc.call('eth_chainId', []).catch(() => {})
  assert.ok(m.used >= 1, 'the client sent its requests through the meter')
})

// ── 2.0 (E20): the default-mode conclusion beside the flag / 标记旁边的默认模式结论 ───────────────────────────────────
// Offline: every RPC goes to the conform chain (sdk/test/helpers/conform-chain.mjs), a fake TAP-10 chain. The doctor is a
// stand-in, as above; the default-mode step is the real api.siteStatus of a default (conformance-mode) client.
// 离线：所有 RPC 都发往 conform 假链。诊断仍是替身；默认模式一步是默认（一致模式）客户端真实的 api.siteStatus。
const T = 1_790_000_000
const RPC = ['http://rpc1', 'http://rpc2', 'http://rpc3']
const HOLDER = sig.privateKeyToAddress('0x' + '11'.repeat(32))
const NAME = '4246.7.tape'   // processor 7 #4246 on the conform chain / conform 链上的 7 号处理器 #4246
function conformWorld(set = () => {}) {
  const chain = createConformChain()
  chain.state.headTime = T
  const c = chain.circuit(4246, { holder: HOLDER })
  set(chain, c)
  return { chain, c }
}
const fakeDefaultApi = (fetch) => createTapeAPI({ rpcUrls: RPC, quorum: 2, fetch, clock: () => T, quiet: true, onWarning: () => {} })
async function withChain(chain, fn) {
  const orig = globalThis.fetch
  globalThis.fetch = chain.fetch
  try { return await fn() } finally { globalThis.fetch = orig }
}
const stand = (exitCode, failed = [], { rpc = 0 } = {}) => async (name, { api }) => {
  for (let i = 0; i < rpc; i++) { try { await api.fetch('http://rpc1', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'eth_blockNumber', params: [] }) }) } catch { /* spent */ } }
  return report(exitCode, failed)
}
const meteredApi = (fetch) => ({ fetch })   // what the stand-in doctor reads through / 替身诊断读取用的

test('E20: every site status the default client can give is recorded as defaultMode, and the flag stays the doctor\'s', async () => {
  const cases = [
    ['ok', () => {}],
    ['not-opened', (chain, c) => chain.setOpened(c.circuits, 4246, false)],
    ['unpaid', (chain) => chain.setUnactivated()],
    ['store-changed', (chain) => chain.setImplementation(CHAINS[56].binding, '0x' + 'ab'.repeat(20))],
  ]
  for (const [want, set] of cases) {
    const { chain } = conformWorld(set)
    const out = await withChain(chain, () => recheck({ doc: doc(entry(NAME)), diagnoseFn: stand(0), apiFor: meteredApi, defaultApiFor: fakeDefaultApi, now: () => 't' }))
    const s = out.providers[NAME]
    assert.equal(s.flag, 'ok', `${want}: the doctor exited 0, so the flag is ok whatever the default mode says`)
    assert.equal(s.verdict, 'ok'); assert.equal(s.consecutiveFailures, 0); assert.equal(s.rpcRequests, 0, 'rpcRequests stays the doctor\'s count')
    assert.equal(s.defaultMode.status, want, want)
    assert.ok(s.defaultMode.rpcRequests > 0 && s.defaultMode.rpcRequests <= RPC_BUDGET_PER_NAME, `${want}: ${s.defaultMode.rpcRequests}`)
    assert.ok(SITE_STATUSES.includes(s.defaultMode.status))
    if (want === 'store-changed') {
      const bad = s.defaultMode.implementations.filter((i) => !i.accepted)
      assert.deepEqual(bad.map((i) => [i.role, i.implementation.toLowerCase()]), [['binding', '0x' + 'ab'.repeat(20)]])
    } else assert.equal(s.defaultMode.implementations, undefined, 'implementations only for store-changed')
    assert.equal(s.defaultMode.reason, undefined)
    assert.deepEqual(newlyFailing(null, out), [])
    assert.doesNotThrow(() => JSON.stringify(out), 'no bigint in status.json')
  }
})

test('E20: nodes that cannot be read give defaultMode unavailable (no verdict); a doctor that fails still fails on its own', async () => {
  const { chain } = conformWorld((ch) => { for (const u of RPC) ch.setFault(u, 'http500') })
  const out = await withChain(chain, () => recheck({ doc: doc(entry(NAME)), diagnoseFn: stand(1, ['cors']), apiFor: meteredApi, defaultApiFor: fakeDefaultApi, now: () => 't' }))
  const s = out.providers[NAME]
  assert.equal(s.flag, 'failing'); assert.deepEqual(s.failed, ['cors'])
  assert.equal(s.defaultMode.status, 'unavailable')
  assert.equal(s.defaultMode.reason, undefined, 'the nodes, not the budget')
  assert.equal(typeof s.defaultMode.detail, 'string')
  // a client that throws a TAP name keeps it; a plain error is unavailable / 带 TAP 名字的错误保留名字；普通错误记为 unavailable
  const m = rpcMeter(5)
  assert.equal((await defaultModeStatus(NAME, { siteStatus: async () => { throw new TapeAPIError('INVALID_ARGUMENT', 'x', { data: { status: 'unsupported' } }) } }, m)).status, 'unsupported')
  assert.equal((await defaultModeStatus(NAME, { siteStatus: async () => { throw new Error('fetch failed') } }, m)).status, 'unavailable')
  assert.equal((await defaultModeStatus(NAME, undefined, m)).status, 'unavailable')
  // a default-mode client that throws when it is made: the flag is the doctor's, the recheck goes on / 建客户端时抛错：标记仍是诊断的，复核继续
  const boom = await recheck({ doc: doc(entry(NAME)), diagnoseFn: stand(0), apiFor: meteredApi, defaultApiFor: () => { throw new Error('boom') }, now: () => 't' })
  assert.equal(boom.providers[NAME].flag, 'ok')
  assert.deepEqual([boom.providers[NAME].defaultMode.status, boom.providers[NAME].defaultMode.detail], ['unavailable', 'boom'])
  assert.equal((await defaultModeStatus(NAME, { siteStatus: async () => ({ status: 'something-new' }) }, m)).status, 'unavailable', 'an unknown answer is no conclusion')
})

test('E20: the default-mode step shares the name\'s RPC cap; running it out never changes the flag, the verdict or newlyFailing', async () => {
  // The doctor uses 50 of 60 and passes; the default-mode step needs more than the 10 left. / 诊断用了 60 中的 50 并通过；默认模式一步剩 10 次不够。
  const { chain } = conformWorld()
  const yesterday = { providers: { [NAME]: nextStatus(null, report(0), 'y') } }
  const out = await withChain(chain, () => recheck({ doc: doc(entry(NAME)), previous: yesterday, diagnoseFn: stand(0, [], { rpc: 50 }), apiFor: meteredApi, defaultApiFor: fakeDefaultApi, now: () => 't' }))
  const s = out.providers[NAME]
  assert.equal(s.flag, 'ok', 'the doctor finished within the cap: its verdict stands')
  assert.deepEqual(s.undecided, []); assert.equal(s.rpcRequests, 50)
  assert.deepEqual([s.defaultMode.status, s.defaultMode.reason], ['unavailable', 'rpc-budget'])
  assert.equal(s.rpcRequests + s.defaultMode.rpcRequests, RPC_BUDGET_PER_NAME, 'both together stay within the cap')
  assert.deepEqual(newlyFailing(yesterday, out), [])
  // The same doctor failing: newly failing exactly as without the step. / 同一个诊断失败：与没有这一步时一样是新近失败。
  const failing = await withChain(chain, () => recheck({ doc: doc(entry(NAME)), previous: yesterday, diagnoseFn: stand(1, ['cors'], { rpc: 50 }), apiFor: meteredApi, defaultApiFor: fakeDefaultApi, now: () => 't' }))
  assert.equal(failing.providers[NAME].flag, 'failing')
  assert.deepEqual(newlyFailing(yesterday, failing), [NAME])
  // A doctor that spent the whole budget: undecided as before, and the step is refused at once. / 诊断用完全部预算：照旧无法判定，这一步立即被拒。
  const spent = await withChain(chain, () => recheck({ doc: doc(entry(NAME)), previous: yesterday, diagnoseFn: stand(1, ['cors'], { rpc: 70 }), apiFor: meteredApi, defaultApiFor: fakeDefaultApi, now: () => 't' }))
  const sp = spent.providers[NAME]
  assert.equal(sp.flag, 'undecided'); assert.deepEqual(sp.undecided, ['rpc-budget']); assert.equal(sp.verdict, 'ok')
  assert.deepEqual([sp.defaultMode.status, sp.defaultMode.reason, sp.defaultMode.rpcRequests], ['unavailable', 'rpc-budget', 0])
  assert.deepEqual(newlyFailing(yesterday, spent), [], 'undecided is not a failure, with or without the step')
})

test('E20: old and new fields side by side: every 1.x field is what it was without the step; a default-mode problem alone is never newly failing', async () => {
  const { chain } = conformWorld((ch) => ch.setUnactivated())
  // yesterday's file is the old format (no defaultMode) / 昨天的文件是旧格式（没有 defaultMode）
  const yesterday = { providers: { [NAME]: { checkedAt: 'y', exitCode: 0, failed: [], warned: [], undecided: [], flag: 'ok', consecutiveFailures: 0, since: 'y', verdict: 'ok', verdictAt: 'y', rpcRequests: 36 } } }
  for (const [exitCode, failed, flag, newly] of [[0, [], 'ok', []], [1, ['activation'], 'failing', [NAME]], [3, [], 'undecided', []]]) {
    const run = (defaultApiFor) => withChain(chain, () => recheck({ doc: doc(entry(NAME)), previous: yesterday, diagnoseFn: stand(exitCode, failed), apiFor: meteredApi, defaultApiFor, now: () => 't' }))
    const [without, withStep] = [await run(null), await run(fakeDefaultApi)]
    assert.equal(without.providers[NAME].defaultMode, undefined, 'no step, no field')
    const { defaultMode, ...rest } = withStep.providers[NAME]
    assert.deepEqual(rest, without.providers[NAME], `exit ${exitCode}: the 1.x fields are unchanged`)
    assert.equal(defaultMode.status, 'unpaid')
    assert.equal(rest.flag, flag)
    assert.deepEqual(newlyFailing(yesterday, withStep), newly)
    assert.deepEqual(newlyFailing(yesterday, withStep), newlyFailing(yesterday, without))
    // tomorrow reads today's file (new format) the same way / 明天按同样方式读今天的新格式文件
    const tomorrow = nextStatus(withStep.providers[NAME], report(0), 'z')
    assert.equal(tomorrow.flag, 'ok'); assert.equal(tomorrow.defaultMode, undefined, 'nextStatus does not carry it over: each recheck reads it afresh')
  }
  assert.ok(!/rank|score|featured|sponsor/i.test(JSON.stringify(yesterday)))
})

test('E20: the default-mode client is the SDK default (conformance mode, no DEPRECATED warning) on the same nodes, quorum and metered fetch', async () => {
  const warned = []
  const orig = console.warn
  console.warn = (...a) => warned.push(a.join(' '))
  let api
  try { api = directoryDefaultApi(async () => new Response('{}')) } finally { console.warn = orig }
  assert.deepEqual(warned, [], 'no deprecation warning: it is the default')
  assert.equal(CONFORM_MODE.get(api), true, 'the TAP-10 conformance mode')
  assert.equal(CONFORM_MODE.get(directoryApi(async () => new Response('{}'), { onWarning: () => {} })), false, 'the doctor\'s client stays 1.x')
  assert.equal(api.chainId, 56)
  const m = rpcMeter(3, async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x38' })))
  await directoryDefaultApi(m.fetch).rpc.call('eth_chainId', []).catch(() => {})
  assert.ok(m.used >= 1, 'the client sent its requests through the meter')
})

// 2.3: the SDK retries a whole read after network failures by default (rpcRetries 2). Both recheck clients turn it off, so
// RPC_BUDGET_PER_NAME keeps its measured meaning: a node failing with HTTP 503 costs one request per node, not three.
// 2.3：SDK 默认在网络故障后整轮重试（rpcRetries 2）。两个复核客户端都关掉它，所以 RPC_BUDGET_PER_NAME 仍是实测的含义：节点以 HTTP
// 503 失败时每个节点只花一次请求，而不是三次。
test('RPC-RETRY: the recheck clients do not retry a read after network failures (rpcRetries: 0), so the budget of 60 means what was measured', async () => {
  for (const make of [(f) => directoryApi(f, { onWarning: () => {} }), (f) => directoryDefaultApi(f)]) {
    const m = rpcMeter(RPC_BUDGET_PER_NAME, async () => new Response('down', { status: 503 }))
    const api = make(m.fetch)
    await assert.rejects(api.rpc.call('eth_chainId', [], { strict: true }), (e) => e.code === 'RPC_UNAVAILABLE')
    // One round, so no retry and no wait before one: counted in requests, not timed on a busy machine (review T-1).
    // 一轮，所以没有重试、也没有重试前的等待：按请求数而不是在繁忙机器上计时（审查 T-1）。
    assert.equal(m.used, api.rpc.urls.length, 'one round: one request per node')
  }
  // the SDK default, for contrast: three rounds / 对照：SDK 默认三轮
  const m = rpcMeter(RPC_BUDGET_PER_NAME, async () => new Response('down', { status: 503 }))
  const plain = createTapeAPI({ rpcUrls: rpcUrlsFor(56), quorum: 2, fetch: m.fetch, rpcRetryMaxMs: 10 })
  await assert.rejects(plain.rpc.call('eth_chainId', [], { strict: true }), (e) => e.code === 'RPC_UNAVAILABLE')
  assert.equal(m.used, 2 * plain.rpc.urls.length, 'rpcRetryMaxMs 10 leaves room for one extra round')
})
