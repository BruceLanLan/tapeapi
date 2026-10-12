// The gap between this SDK and the official TAP-10 v1.1, pinned. The cases are the ones TAP-10 itself carries under
// 'Test Cases / Access layer' (fixtures/tap10-test-cases.json); sdk/test/helpers/tap10-gap.mjs runs them through the SDK's
// entry points offline, and `node scripts/tap10-gap.mjs` prints the same results as a table.
// A test named CONFORMS asserts that the SDK equals TAP-10. A test named KNOWN GAP asserts that the SDK's CURRENT result is
// the one recorded below, which differs from TAP-10: it passes today and is the line to flip (to the value in `wants`)
// when a conformance mode lands. Nothing here changes SDK behaviour, and a failing KNOWN GAP means the SDK moved: look at
// whether it moved towards TAP-10 and update the entry.
// 本仓库 SDK 与官方 TAP-10 v1.1 的差距，钉住。用例就是 TAP-10 自己在"Test Cases / 访问层"里写的那些。CONFORMS 的测试断言 SDK 与
// TAP-10 一致；KNOWN GAP 的测试断言 SDK 当前的结果等于下面记录的结果（与 TAP-10 不同）：今天通过，将来做一致模式时翻转它
// （改成 `wants` 里的值）。这里不改变 SDK 的任何行为；KNOWN GAP 失败说明 SDK 变了：看它是否朝 TAP-10 靠拢，并更新记录。
// 2.0: the conformance mode is the default. The KNOWN GAP rows are now the 1.x resolution (conform: false, deprecated); the
// conformance mode with allChains is pinned below as before, and the 2.0 default (no conform, no allChains) has its own
// section at the end. / 2.0：一致模式成为默认。KNOWN GAP 各行现在是 1.x 的解析（conform: false）；一致模式（开 allChains）照旧
// 钉在下面；2.0 默认（不传 conform、不开 allChains）在文末单独一节。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runAll, runAllConform, runAllDefault20, readsOfAFullResolution, loadFixture } from './helpers/tap10-gap.mjs'

const fetchBefore = globalThis.fetch
const { rows, summary } = await runAll()
// run before any test is registered: a test may start while the module still awaits, and the runs swap the global fetch
// 在注册任何测试之前运行：模块仍在 await 时测试可能已经开始，而这些运行会替换全局 fetch
const conform = await runAllConform()
const default20 = await runAllDefault20()
const byN = new Map(rows.map((r) => [r.n, r]))

// What the SDK does today, per case. A RegExp is matched, anything else must be deeply equal. `src` is the TAP-10 place of
// the requirement; `wants` is what TAP-10 expects (what a flipped assertion would say).
// 每例 SDK 当前所做。RegExp 用匹配，其余须深度相等。src 是 TAP-10 的出处；wants 是 TAP-10 的期望（翻转后的断言）。
const CANON = /is not a TapeOut name in canonical form/
const NAME = (chainId, processor, tokenId, name) => ({ parse: 'name', chainId, processor, tokenId, name })
const REFUSED = (rec = {}) => ({ parse: 'error', code: 'MANIFEST_INVALID', message: CANON, rpcTotal: 0, ...rec })
const LABEL = { parse: 'not-name-shaped', code: 'INVALID_ARGUMENT', message: /^directory address not configured$/, rpcTotal: 0 }

const CONFORMS = {
  1: { obs: NAME(56, '0', '4246', '4246.0.tape'), src: '§3.1 name half of row 1 (container, opened, ok, paid not judged)' },
  2: { obs: NAME(56, '0', '4246', '4246.0.tape'), src: '§3.1, §3.4 short name' },
  11: { obs: NAME(8453, '1', '1', '1.3.1.tape'), src: '§3.1 name half of row 7 (container, opened, unpaid not judged)' },
  14: { obs: NAME(8453, '5', '1', '1.3.5.tape'), src: '§3.1 name half of row 8 (container, not-opened not judged)' },
  17: { obs: { code: 'NOT_FOUND', message: /^processor 344 does not exist$/, chainsRead: [196] }, src: '§4.2 steps 1-2: no-such-cpu on X Layer (NOT_FOUND plus its message; the SDK has no TAP-10 status code)' },
  18: { obs: { code: 'NOT_FOUND', message: /^processor 999999 does not exist$/, chainsRead: [56] }, src: '§4.2 steps 1-2: no-such-cpu' },
  21: { obs: { shaped: true, code: 'MANIFEST_INVALID', message: CANON, rpcTotal: 0 }, src: '§3.1 no leading zeros: input error' },
  22: { obs: { shaped: true, code: 'MANIFEST_INVALID', message: CANON, rpcTotal: 0 }, src: '§3.1 1 <= #ID: input error' },
  24: { obs: { shaped: true, code: 'MANIFEST_INVALID', message: /area codes 0 and 1 are reserved/, rpcTotal: 0 }, src: '§2.1 area code 0 reserved: input error' },
  25: { obs: { shaped: true, code: 'MANIFEST_INVALID', message: /area codes 0 and 1 are reserved/, rpcTotal: 0 }, src: '§2.1 area code 1 reserved: input error' },
  26: { obs: { shaped: true, code: 'MANIFEST_INVALID', message: /area code 4 is not assigned/, rpcTotal: 0 }, src: '§3.1 unassigned area code: input error' },
  27: { obs: { problems: [] }, src: 'Deployments / §6.1: site store and payment contract proxies and accepted implementations (data only)' },
}

const GAPS = {
  3: { tag: '§3.4 SHOULD, shell and messaging layer', wants: 'BNB Smart Chain, processor 0, #4246 (4246.0.tape)', obs: REFUSED() },
  4: { tag: '§3.4 SHOULD, shell layer', wants: 'BNB Smart Chain, processor 0, #4246 (4246.0.tape)', obs: REFUSED() },
  5: { tag: '§3.4 SHOULD', wants: 'reverse-resolved to BNB Smart Chain, processor 0, #4246', obs: LABEL },
  6: { tag: '§4.3 step 3 MUST', wants: 'reverse-resolves to 4246.0.tape', obs: { chainId: 56, tokenOfKeys: ['circuits', 'tokenId'], tokenId: '4246', hasProcessorNumber: false } },
  12: { tag: '§3.4 SHOULD, shell and messaging layer', wants: 'Base, processor 1, #1 (1.3.1.tape)', obs: REFUSED() },
  13: { tag: '§4.3 step 3 MUST', wants: 'Base, processor 1, #1', obs: { chainId: 8453, tokenOfKeys: ['circuits', 'tokenId'], tokenId: '1', hasProcessorNumber: false } },
  15: { tag: '§3.4 SHOULD, shell and messaging layer', wants: 'X Layer, processor 1, #1', obs: REFUSED() },
  16: { tag: '§4.1 MUST', wants: 'ambiguous (the processor exists on Base and X Layer)', obs: { code: 'INVALID_ARGUMENT', message: /^directory address not configured$/, rpcTotal: 0 } },
  19: { tag: '§4.2 step 4, §4.4 MUST', wants: 'no-such-token',
    obs: { code: 'MANIFEST_INVALID', message: /^no file at \/\.well-known\/tapeapi\.json for 0x/, controlCode: 'MANIFEST_INVALID', indistinguishable: true } },
  20: { tag: '§4.3 step 1 MUST', wants: 'not-tapeout from resolve()',
    obs: { resolve: { code: 'MANIFEST_INVALID', message: /^no file at \/\.well-known\/tapeapi\.json for 0x0+dEaD/ }, tokenOf: { ok: false, code: 'NOT_FOUND', message: /not a TapeOut container/ }, controlCode: 'MANIFEST_INVALID' } },
  23: { tag: '§3.4 MUST (never guess)', wants: 'input error',
    obs: { shaped: false, noDirectory: { code: 'INVALID_ARGUMENT', message: /^directory address not configured$/, rpcTotal: 0 }, withDirectory: { code: 'NOT_FOUND', message: /^label "4246" not registered$/, rpcTotal: 2 } } },
}

const pin = (actual, recorded, path = 'obs') => {
  for (const [k, want] of Object.entries(recorded)) {
    const got = actual?.[k]
    if (want instanceof RegExp) assert.match(String(got), want, `${path}.${k}`)
    else if (want && typeof want === 'object' && !Array.isArray(want)) pin(got, want, `${path}.${k}`)
    else assert.deepEqual(got, want, `${path}.${k}`)
  }
}

test('the fixture is the TAP-10 Test Cases table: 16 rows, 27 cases, ids in order, each with a TAP-10 source', () => {
  const f = loadFixture()
  assert.equal(f.tap, 'TAP-10'); assert.equal(f.version, '1.1')
  assert.deepEqual(f.cases.map((c) => c.id), Array.from({ length: 27 }, (_, i) => `TAP10-${i + 1}`))
  assert.equal(new Set(f.cases.map((c) => c.row)).size, 16)
  for (const c of f.cases) { assert.match(c.source, /^TAP-10 Test Cases \(Access layer\)/, c.id); assert.ok(c.expectedText, c.id); assert.equal(typeof c.needsChain, 'boolean', c.id) }
  // every case is exactly one of: conforms, known gap, not judged / 每例恰好属于三类之一
  const judged = new Set([...Object.keys(CONFORMS), ...Object.keys(GAPS)].map(Number))
  const unjudged = f.cases.filter((c) => !judged.has(c.n)).map((c) => c.n)
  assert.deepEqual(unjudged, [7, 8, 9, 10])
  assert.deepEqual(summary, { rows: 16, cases: 27, judged: 23, conforms: 12, gaps: 11, notJudged: 4 })
})

for (const [n, rec] of Object.entries(CONFORMS)) {
  const row = byN.get(Number(n))
  test(`CONFORMS TAP10-${n}: ${row.input} (${rec.src})`, () => {
    assert.equal(row.verdict, 'CONFORMS', row.ours)
    pin(row.obs, rec.obs)
  })
}

for (const [n, rec] of Object.entries(GAPS)) {
  const row = byN.get(Number(n))
  test(`KNOWN GAP TAP10-${n}: ${row.input} (${rec.tag}; TAP-10 wants ${rec.wants}; ${row.source.replace('TAP-10 Test Cases (Access layer) ', '')})`, () => {
    // today's result, not TAP-10's / 当前结果，不是 TAP-10 的
    assert.equal(row.verdict, 'GAP', row.ours)
    pin(row.obs, rec.obs)
  })
}

for (const n of [7, 8, 9, 10]) {
  const row = byN.get(n)
  test(`NOT JUDGED TAP10-${n}: ${row.input} needs mainnet state, kept in the fixture and not guessed`, () => {
    assert.equal(row.verdict, 'NOT-JUDGED')
    assert.equal(row.needsChain, true)
    assert.ok(row.needsChainReason.length > 20)
  })
}

test('KNOWN GAP TAP10-S1 (§4.2 steps 1 and 5, §6.2, §6.3 MUST): a full resolution never reads cpuCount, isOpened, isLive or isContainerLive', async () => {
  // This qualifies the on-chain half of rows 1, 7, 8, 9 (ok, unpaid, not-opened): the SDK has no read that could produce them.
  // TAP-10 wants those four reads (and the statuses `not-opened`, `unpaid`, `ok`) in a resolution.
  // 这限定了第 1、7、8、9 行链上那一半（ok、unpaid、not-opened）：SDK 没有能产生它们的读取。
  const s = await readsOfAFullResolution()
  assert.equal(s.resolved, true, 'the fake service resolves')
  assert.deepEqual(s.neverIssued, { cpuCount: true, isOpened: true, isLive: true, isContainerLive: true })
  for (const name of ['accountOf', 'cpuAt', 'isCPU', 'ownerOf', 'fileInfo', 'read']) assert.ok(s.calls.includes(name), name)
})

test('the run is offline: global fetch is back in place and no case reached the network', () => {
  // runAll replaces globalThis.fetch with a thrower while it runs and throws if it is ever called / runAll 运行期间把 fetch 换成抛错函数
  assert.equal(globalThis.fetch, fetchBefore)
  assert.ok(rows.every((r) => r.verdict !== undefined))
})

// ── the conformance mode (createTapeAPI({ conform: 'tap10' }), 1.4) ───────────────────────────────────────────────────
// The KNOWN GAP assertions above stay: they are the default mode, which 1.4 and 1.5 do not change. Here the same cases run
// in the conformance mode with allChains (1.5); FLIPPED marks a case that is a KNOWN GAP above and conforms here. Since 1.5
// (the processor-number lookup and the every-chain search) none of the 23 cases judged offline differs.
// 一致模式。上面的 KNOWN GAP 断言保留：那是默认模式，1.4 与 1.5 都不改变它。这里同样的用例在一致模式（开 allChains，1.5）下运行；
// FLIPPED 标出上面是 KNOWN GAP、这里一致的用例。1.5（处理器号反查与所有链搜索）之后，23 个可离线判定的用例全部一致。
const cByN = new Map(conform.rows.map((r) => [r.n, r]))
const ID = (chainId, processor, tokenId, name, container) => ({ chainId, processor, tokenId, name, ...(container ? { container } : {}) })
const BSC_4246 = ID(56, '0', '4246', '4246.0.tape', '0x86DDaEF00401E3F10418398D67D7189fc458eA95')
const BASE_1 = ID(8453, '1', '1', '1.3.1.tape', '0x4591b393399452eA24ECB10424CdBA194F1c4E64')
const INPUT_ERROR = { code: 'INVALID_ARGUMENT', status: 'input-error', rpcTotal: 0 }
const CONFORM_MODE = {
  1: { obs: BSC_4246 }, 2: { obs: BSC_4246 }, 3: { obs: BSC_4246, flipped: true }, 4: { obs: BSC_4246, flipped: true },
  // 1.5: the processor number from the snapshot (checked by cpuAt), and the input searched on every chain
  // 1.5：处理器号来自快照（经 cpuAt 核实），输入在所有链上搜索
  5: { obs: BSC_4246, flipped: true },
  6: { obs: { chainId: 56, status: 'ok', name: '4246.0.tape', processor: '0' }, flipped: true },
  11: { obs: BASE_1 }, 12: { obs: BASE_1, flipped: true },
  13: { obs: { chainId: 8453, status: 'ok', name: '1.3.1.tape', processor: '1' }, flipped: true },
  14: { obs: ID(8453, '5', '1', '1.3.5.tape') },
  15: { obs: ID(196, '1', '1', '1.2.1.tape', '0x374fa57399f356030847Eb0c56851bE9a1194E5D'), flipped: true },
  17: { obs: { code: 'NOT_FOUND', status: 'no-such-cpu', chainsRead: [196] } }, 18: { obs: { code: 'NOT_FOUND', status: 'no-such-cpu', chainsRead: [56] } },
  16: { obs: { code: 'INVALID_ARGUMENT', status: 'ambiguous' }, flipped: true },
  19: { obs: { code: 'NOT_FOUND', status: 'no-such-token', controlCode: 'MANIFEST_INVALID', controlStatus: 'no-manifest' }, flipped: true },
  20: { obs: { code: 'NOT_FOUND', status: 'not-tapeout' }, flipped: true },
  21: { obs: INPUT_ERROR }, 22: { obs: INPUT_ERROR }, 23: { obs: INPUT_ERROR, flipped: true }, 24: { obs: INPUT_ERROR }, 25: { obs: INPUT_ERROR }, 26: { obs: INPUT_ERROR },
  27: { obs: { problems: [] } },
}
const CONFORM_GAPS = {}

test('conformance mode (allChains): 23 judged, all 23 conform; 11 cases flipped (5, 6, 13, 16, 20 by 1.5)', () => {
  assert.deepEqual(conform.summary, { rows: 16, cases: 27, judged: 23, conforms: 23, gaps: 0, notJudged: 4 })
  const flipped = Object.entries(CONFORM_MODE).filter(([, r]) => r.flipped).map(([n]) => Number(n))
  assert.deepEqual(flipped, [3, 4, 5, 6, 12, 13, 15, 16, 19, 20, 23])
  for (const n of flipped) assert.ok(GAPS[n], `${n} is a KNOWN GAP in the default mode`)
  assert.deepEqual(Object.keys(CONFORM_GAPS).map(Number).sort((a, b) => a - b), Object.keys(GAPS).map(Number).filter((n) => !flipped.includes(n)))
})

for (const [n, rec] of Object.entries(CONFORM_MODE)) {
  const row = cByN.get(Number(n))
  test(`CONFORMS (conform: 'tap10')${rec.flipped ? ' FLIPPED' : ''} TAP10-${n}: ${row.input}`, () => {
    assert.equal(row.verdict, 'CONFORMS', row.ours)
    pin(row.obs, rec.obs)
  })
}
for (const [n, rec] of Object.entries(CONFORM_GAPS)) {
  const row = cByN.get(Number(n))
  test(`KNOWN GAP (conform: 'tap10', 1.5) TAP10-${n}: ${row.input} (TAP-10 wants ${rec.wants})`, () => {
    assert.equal(row.verdict, 'GAP', row.ours)
    pin(row.obs, rec.obs)
  })
}

test("CONFORMS (conform: 'tap10') FLIPPED TAP10-S1: a full resolution reads cpuCount, isOpened, isLive and isContainerLive", () => {
  assert.equal(conform.structural.resolved, true)
  assert.equal(conform.structural.site, 'ok')
  assert.deepEqual(conform.structural.neverIssued, { cpuCount: false, isOpened: false, isLive: false, isContainerLive: false })
})

// ── the 2.0 default: createTapeAPI() with no conform and no allChains (the 2.0 upgrade guide, docs/guides/upgrade-2.0.md) ───────────────────
// The conformance mode without allChains (design risk 3: allChains stays off by default in 2.0, so a client given its own
// BNB Smart Chain nodes never reads another chain's public nodes unless asked). 19 of the 23 judged cases conform; the 4
// that do not are exactly the input without chain information that TAP-10 §4.1 resolves on every chain: a processor
// contract#ID (5, 16), a container of another chain (13) and an address on no chain (20) are `unsupported`, before any
// request to another chain; each conforms with allChains: true (the section above). The plan's estimate was 22 of 23
// (counting only row 1, the processor contract#ID); measured, it is 19.
// 2.0 默认：不传 conform、不开 allChains。23 个可判定用例中 19 个一致；不一致的 4 个正是 TAP-10 §4.1 要在所有链上解析的无链信息
// 输入：处理器合约#ID（5、16）、别链容器（13）、哪条链都不是的地址（20）都是 unsupported，且不向别的链发请求；开 allChains 即一致。
// 计划估计 22/23（只算了第 1 行），实测 19/23。
const dByN = new Map(default20.rows.map((r) => [r.n, r]))
const UNSUPPORTED = { code: 'INVALID_ARGUMENT', status: 'unsupported' }
const DEFAULT20_GAPS = { 5: UNSUPPORTED, 13: UNSUPPORTED, 16: UNSUPPORTED, 20: UNSUPPORTED }

test('2.0 default (no conform, no allChains): 23 judged, 19 conform; the 4 gaps are input without chain information, unsupported, each conforming with allChains', () => {
  assert.deepEqual(default20.summary, { rows: 16, cases: 27, judged: 23, conforms: 19, gaps: 4, notJudged: 4 })
  assert.deepEqual(default20.rows.filter((r) => r.verdict === 'GAP').map((r) => r.n), [5, 13, 16, 20])
  for (const n of Object.keys(DEFAULT20_GAPS).map(Number)) assert.equal(cByN.get(n).verdict, 'CONFORMS', `${n} conforms with allChains`)
  // every case that conforms in the conformance mode with allChains and needs no other chain conforms the same way here
  // 开 allChains 时一致、且不需要别的链的用例，这里同样一致
  for (const r of default20.rows) if (r.verdict === 'CONFORMS') assert.deepEqual(r.obs, cByN.get(r.n).obs, `TAP10-${r.n}`)
  assert.equal(default20.structural.resolved, true)
  assert.deepEqual(default20.structural.neverIssued, { cpuCount: false, isOpened: false, isLive: false, isContainerLive: false })
})
for (const [n, obs] of Object.entries(DEFAULT20_GAPS)) {
  const row = dByN.get(Number(n))
  test(`KNOWN GAP (2.0 default, allChains off) TAP10-${n}: ${row.input} is unsupported`, () => {
    assert.equal(row.verdict, 'GAP', row.ours)
    pin(row.obs, obs)
  })
}
