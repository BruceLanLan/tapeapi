// The live layer against a fake chain (test/helpers/fake-chain.mjs, in process, no network): the draft's 73 resolution
// vectors replayed through liveReads and the SDK's strict-agreement rpc client give the snapshot replay's result; the
// optional log scan never turns a history it could not obtain into an empty one; the processor table hint is checked.
// 实时层对假链（进程内、不联网）：草案 73 个解析向量经 liveReads 与 SDK 严格共识客户端回放，结果与快照回放一致；可选的日志扫描
// 绝不把没拿到的历史当作空历史；处理器表的提示要经核对。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as P from '../src/passport-core.js'
import { liveReads, resolvePassport, logsClient, LOG_TOPICS } from '../src/passport-live.js'
import { resolveFromSnapshot } from '../src/passport-public.js'
import { fakeChain, keyOfCall } from './helpers/fake-chain.mjs'

const V = JSON.parse(readFileSync(new URL('./fixtures/vectors.json', import.meta.url), 'utf8'))
const LOGS = { fromBlock: 40_000_000, chunk: 10_000_000, maxRequests: 64 }
const pick = (r) => ({ state: r.state, reasons: r.reasons, warnings: r.warnings, display: r.display.en, agentId: r.agentId })
const snapResult = async (snap) => pick(await P.resolve(P.snapshotReads(snap), snap.input, snap.config))

test('T4: the 73 resolution vectors through liveReads (fake chain, strict agreement, log nodes given) match the snapshot replay', async () => {
  let n = 0
  for (const c of V.resolution) {
    const snap = c.snapshot; const w = fakeChain(snap)
    const rd = await liveReads(w.rpc(), { config: snap.config, logs: logsClient({ rpc: w.rpc(), ...LOGS }) })
    const live = pick(await P.resolve(rd, snap.input, snap.config))
    assert.deepEqual(live, await snapResult(snap), c.id)
    assert.equal(live.state, c.expected.state, c.id)
    n++
  }
  assert.equal(n, 73)
})

test('without log nodes (the default) P-8 and §7 are warnings, never a pass: every CONFIRMED says "site operators not checked" and "holder history not checked"', async () => {
  let confirmed = 0
  for (const c of V.resolution) {
    const snap = c.snapshot; const w = fakeChain(snap)
    const r = await P.resolve(await liveReads(w.rpc(), { config: snap.config }), snap.input, snap.config)
    assert.ok(!w.calls.some((x) => x.method === 'eth_getLogs'), 'no log request is sent without log nodes')
    if (r.state !== 'CONFIRMED') continue
    confirmed++
    assert.ok(r.warnings.includes('operators-not-checked'), c.id)
    assert.ok(r.warnings.includes('transfer-history-unavailable'), c.id)
    assert.equal(r.checked.siteOperators, false); assert.equal(r.checked.holderHistory, false); assert.equal(r.holderEpoch, null)
    assert.match(r.display.en, /; site operators not checked; holder history not checked$/)
    assert.match(r.display.zh, /站点操作员未检查；持有人历史未检查$/)
  }
  assert.ok(confirmed >= 15, `${confirmed} CONFIRMED`)
  // The stale-operator vector is BROKEN with the history and only a warning without it: what could not be checked is said.
  // stale-operator 向量有历史时为 BROKEN，没有历史时只是警告：没查的就说没查。
  const snap = V.resolution.find((c) => c.id === 'stale-operator').snapshot
  const r = await P.resolve(await liveReads(fakeChain(snap).rpc(), { config: snap.config }), snap.input, snap.config)
  assert.equal(r.state, 'CONFIRMED'); assert.ok(r.warnings.includes('operators-not-checked'))
})

const confirmed = V.resolution.find((c) => c.id === 'confirmed-by-agent').snapshot
test('logs: a log node without the pinned block, a refused chunk, or a scan over budget is "not obtained", never an empty history', async () => {
  // 1. the log nodes do not hold the pinned block (behind it): no eth_getLogs, warnings / 日志节点没有钉块
  let w = fakeChain(confirmed); let lw = fakeChain(confirmed, { override: (op, m) => (m === 'eth_getBlockByNumber' ? { error: { code: -32000, message: 'header not found' } } : undefined) })
  let r = await P.resolve(await liveReads(w.rpc(), { config: confirmed.config, logs: logsClient({ rpc: lw.rpc(), ...LOGS }) }), confirmed.input, confirmed.config)
  assert.equal(r.state, 'CONFIRMED'); assert.deepEqual(r.warnings, ['operators-not-checked', 'transfer-history-unavailable'])
  assert.ok(!lw.calls.some((x) => x.method === 'eth_getLogs'))
  // 2. one chunk answered [] by both, the next refused: the whole history is not obtained / 一块为空、下一块被拒：整段没拿到
  let k = 0
  lw = fakeChain(confirmed, { override: (op, m, p) => { if (m !== 'eth_getLogs' || p[0].topics[0] !== LOG_TOPICS.OperatorSet) return undefined; return Number(BigInt(p[0].fromBlock)) < 50_000_000 ? { result: [] } : { error: { code: -32005, message: 'limit exceeded' } } } })
  r = await P.resolve(await liveReads(w.rpc(), { config: confirmed.config, logs: logsClient({ rpc: lw.rpc(), ...LOGS }) }), confirmed.input, confirmed.config)
  assert.ok(r.warnings.includes('operators-not-checked')); assert.equal(r.checked.siteOperators, false); k++
  // 3. over budget: nothing is asked / 超预算：一个请求都不发
  lw = fakeChain(confirmed)
  r = await P.resolve(await liveReads(w.rpc(), { config: confirmed.config, logs: logsClient({ rpc: lw.rpc(), fromBlock: 0, chunk: 5000, maxRequests: 64 }) }), confirmed.input, confirmed.config)
  assert.deepEqual(r.warnings, ['operators-not-checked', 'transfer-history-unavailable'])
  assert.ok(!lw.calls.some((x) => x.method === 'eth_getLogs')); k++
  // 4. log nodes that disagree: UNAVAILABLE, as any read / 日志节点分歧：与任何读取一样为 UNAVAILABLE
  lw = fakeChain(confirmed, { override: (op, m, p) => (m === 'eth_getLogs' && op === 'publicnode' && p[0].topics[0] === LOG_TOPICS.OperatorSet ? { result: [{ address: confirmed.config.siteRegistry, topics: [LOG_TOPICS.OperatorSet, p[0].topics[1]], data: '0x' + '00'.repeat(96), blockNumber: '0x2faf07f', logIndex: '0x0' }] } : undefined) })
  r = await P.resolve(await liveReads(w.rpc(), { config: confirmed.config, logs: logsClient({ rpc: lw.rpc(), ...LOGS }) }), confirmed.input, confirmed.config)
  assert.deepEqual([r.state, r.reasons], ['UNAVAILABLE', ['node-disagreement']]); k++
  // 5. with the history: checked, epoch known, display names the registration block / 有历史：已检查，纪元已知
  lw = fakeChain(confirmed)
  r = await P.resolve(await liveReads(w.rpc(), { config: confirmed.config, logs: logsClient({ rpc: lw.rpc(), ...LOGS }) }), confirmed.input, confirmed.config)
  assert.deepEqual(r.warnings, []); assert.equal(r.checked.siteOperators, true); assert.equal(r.checked.holderHistory, true)
  assert.equal(r.display.en, 'TapeOut passport 7.2.tape (container 0x2737ba45df033da7be7d329e13e0898ebeb1c97c) for agent 1001, confirmed at block 50000000; identity registered at block 49000000')
  assert.equal(k, 3)
  assert.throws(() => logsClient({ urls: ['https://a.example/'] }), /2 distinct operators/)
})

test('the processor table hint (api.chain.processorNumber) is used only when cpuAt(hint) names the processor', async () => {
  const w = fakeChain(confirmed)
  const api = (n) => ({ chainId: 56, rpc: w.rpc(), addresses: { factory: confirmed.config.factory }, chain: { processorNumber: async () => n } })
  let r = await resolvePassport(confirmed.input, { api: api('2'), config: confirmed.config })
  assert.equal(r.state, 'CONFIRMED'); assert.equal(r.name, '7.2.tape')
  const keys = w.calls.filter((x) => x.method === 'eth_call').map((x) => keyOfCall(x.params[0].to, x.params[0].data))
  assert.ok(keys.includes(`${confirmed.config.factory}.cpuAt(2)`) && !keys.includes(`${confirmed.config.factory}.cpuAt(0)`), 'only cpuAt(hint) is read')
  for (const bad of ['1', null]) {
    r = await resolvePassport(confirmed.input, { api: api(bad), config: confirmed.config })
    assert.deepEqual([r.state, r.reasons], ['UNAVAILABLE', ['unavailable']], String(bad))
  }
  // Without a table, at most maxProcessorScan cpuAt reads, then UNAVAILABLE (never not-tapeout). / 没有表时最多扫这么多，然后 UNAVAILABLE。
  r = await resolvePassport(confirmed.input, { rpc: fakeChain(confirmed).rpc(), config: confirmed.config, maxProcessorScan: 2 })
  assert.deepEqual([r.state, r.reasons], ['UNAVAILABLE', ['unavailable']])
  r = await resolvePassport(confirmed.input, { rpc: fakeChain(confirmed).rpc(), config: confirmed.config })
  assert.equal(r.state, 'CONFIRMED'); assert.equal(r.checked.logs, false)
})

test('recordSnapshot: a live resolution exports a snapshot that resolveFromSnapshot replays to the same result', async () => {
  for (const id of ['confirmed-by-agent', 'confirmed-by-circuit', 'gift-circuit-input', 'registration-file-missing', 'stale-agent-wallet']) {
    const snap = V.resolution.find((c) => c.id === id).snapshot
    const w = fakeChain(snap)
    const api = { chainId: 56, rpc: w.rpc(), addresses: { factory: snap.config.factory }, chain: { processorNumber: async (p) => { for (let i = 0; i < 8; i++) { const a = snap.answers[`${snap.config.factory}.cpuAt(${i})`]; if (typeof a === 'string' && a.endsWith(p.slice(2))) return String(i) } return null } } }
    const r = await resolvePassport(snap.input, { api, config: snap.config, recordSnapshot: true })
    assert.equal(r.snapshot.format, 'tap-agent-passport-snapshot/1')
    const again = await resolveFromSnapshot(r.snapshot)
    assert.deepEqual(pick(again), pick(r), id)
    assert.ok(r.reads > 4)
  }
})

test('a pin that cannot be made is UNAVAILABLE (stale-block / unavailable), with the result shape and the draft head', async () => {
  const snap = V.resolution.find((c) => c.id === 'stale-block').snapshot
  let r = await resolvePassport(snap.input, { rpc: fakeChain(snap).rpc(), config: snap.config })
  assert.deepEqual([r.state, r.reasons], ['UNAVAILABLE', ['stale-block']])
  assert.equal(r.draft.head, P.DRAFT.head); assert.match(r.display.en, /^could not verify: stale-block$/); assert.match(r.display.zh, /没有任何内容得到核对/)
  const down = { tap10Block: async () => { throw Object.assign(new Error('down'), { code: 'RPC_UNAVAILABLE' }) } }
  r = await resolvePassport({ agentId: '1' }, { rpc: down })
  assert.deepEqual([r.state, r.reasons, r.pinnedBlock], ['UNAVAILABLE', ['unavailable'], null])
  await assert.rejects(resolvePassport({ agentId: 'x' }, { rpc: down }), (e) => e.code === 'INVALID_ARGUMENT')
})

test('PASSPORT_CONFIG: the TapeOut addresses are the SDK\'s chain 56 ones, and every vector uses this config', async () => {
  const { CHAINS } = await import('@tapeapi/sdk/chains')
  const c = CHAINS[56]
  assert.equal(P.PASSPORT_CONFIG.factory, c.factory.toLowerCase())
  assert.equal(P.PASSPORT_CONFIG.opener, c.opener.toLowerCase())
  assert.equal(P.PASSPORT_CONFIG.siteRegistry, c.siteRegistry.toLowerCase())
  assert.deepEqual([...P.PASSPORT_CONFIG.siteRegistryImplementations], c.expectedImpl[c.siteRegistry.toLowerCase()])
  for (const v of [...V.resolution, ...V.feedback]) {
    for (const [k, val] of Object.entries(P.PASSPORT_CONFIG)) assert.deepEqual(v.snapshot.config[k], Array.isArray(val) ? [...val] : val, `${v.id} ${k}`)
  }
})
