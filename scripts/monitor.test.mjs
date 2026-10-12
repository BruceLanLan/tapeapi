// Offline tests for the monitor's evaluation logic. No network: results are built by hand.
// 监控评估逻辑的离线测试：不联网，结果手工构造。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { monitorClient, defaultModeLine, evaluate, report, daysUntil, effectiveExpiry, retry, SERVICES, PAGES, WARN_DAYS, ACTIVATION_FAIL_DAYS, checkActivation, activationFindings, ASYNC_WAIT_S, asyncWaitMs, testFrame, judgeAsync, isNetworkError, checkRelayAsync, randomRoom, chainFailure, slotFindings, checkSlots, checkChainAndCall, retryableResolve } from './monitor.mjs'
import { encodeCall } from '../sdk/src/abi.js'
import { TapeAPIError, sig, MANIFEST_KEY, MAINNET } from '../sdk/src/index.js'
import { CONFORM_MODE } from '../sdk/src/conform-sibling.js'
import { createConformChain } from '../sdk/test/helpers/conform-chain.mjs'
import { createRelayCore, relayMethods } from '../examples/relay-service/relay-core.mjs'

const NOW = 1_790_000_000
const DAY = 86400
const SIGNER = '0xaB70dEe8e1CEabb1D10eDFeBcbe0c313c53cf154'

function svc(name, { expires = NOW + 60 * DAY, health = {}, chain = {}, call = {}, activation = { live: true, isLive: true, isContainerLive: false, paidUntil: NOW + 25 * DAY } } = {}) {
  return {
    name, label: `${name}.1013.tape`,
    health: { status: 200, ok: true, signer: SIGNER, delegationExpires: expires, latencyMs: 120, ...health },
    chain: { signer: SIGNER.toLowerCase(), expires, ...chain },   // case differs on purpose: addresses compare case-insensitively
    call: { method: 'blockNumber', ok: true, ...call },
    ...(activation === null ? {} : { activation }),   // pass activation: null for a result from before the check existed
  }
}
const pages = () => PAGES.map((p) => ({ ...p, status: 200, latencyMs: 80 }))
const results = (...services) => ({ services, pages: pages() })

test('all healthy: no problems, healthy=true, and the report says so', () => {
  const r = results(svc('api'), svc('relay'))
  const ev = evaluate(r, NOW)
  assert.deepEqual(ev, { healthy: true, problems: [], warnings: [] })
  const md = report(r, ev, NOW)
  assert.match(md, /all healthy/)
  assert.match(md, /\| Service \| Health \|/)
  assert.match(md, /0xaB70…f154 match/)
})

test('service down: health unreachable, HTTP 5xx, ok=false', () => {
  for (const health of [{ status: null, error: 'fetch failed' }, { status: 502 }, { ok: false }]) {
    const ev = evaluate(results(svc('api', { health }), svc('relay')), NOW)
    assert.equal(ev.healthy, false)
    assert.equal(ev.problems.length, 1)
    assert.match(ev.problems[0], /^api: health/)
  }
})

test('verified call failing is a problem; a call skipped because resolve failed reports only the resolve', () => {
  let ev = evaluate(results(svc('relay', { call: { method: 'relayRecv', ok: false, error: 'BAD_SIGNATURE: x' } })), NOW)
  assert.equal(ev.healthy, false)
  assert.match(ev.problems[0], /relay: verified relayRecv failed \(BAD_SIGNATURE/)
  ev = evaluate(results(svc('api', { chain: { signer: undefined, expires: undefined, error: 'RPC_UNAVAILABLE: quorum' }, call: { ok: undefined, skipped: true } })), NOW)
  assert.equal(ev.healthy, false)
  assert.deepEqual(ev.problems, ['api: on-chain resolve failed (RPC_UNAVAILABLE: quorum)'])
})

test('signer mismatch between the chain and the service is a problem', () => {
  const ev = evaluate(results(svc('api', { chain: { signer: '0x3cF7fb12C72653ba8415515387dBa9eF0353a0DD' } })), NOW)
  assert.equal(ev.healthy, false)
  assert.match(ev.problems[0], /api: signer mismatch/)
  assert.match(report(results(svc('api', { chain: { signer: '0x3cF7fb12C72653ba8415515387dBa9eF0353a0DD' } })), ev, NOW), /MISMATCH/)
})

test('expiry in 20 days is fine, in 10 days is a problem', () => {
  assert.equal(evaluate(results(svc('api', { expires: NOW + 20 * DAY })), NOW).healthy, true)
  const ev = evaluate(results(svc('api', { expires: NOW + 10 * DAY })), NOW)
  assert.equal(ev.healthy, false)
  assert.match(ev.problems[0], /api: delegation expires in 10 days/)
})

test('boundary: exactly 14 days is fine, 13 days and 23 hours is not', () => {
  assert.equal(WARN_DAYS, 14)
  assert.equal(evaluate(results(svc('api', { expires: NOW + 14 * DAY })), NOW).healthy, true)
  assert.equal(evaluate(results(svc('api', { expires: NOW + 14 * DAY - 3600 })), NOW).healthy, false)
})

test('expired delegation is a problem', () => {
  for (const expires of [NOW, NOW - 3 * DAY]) {
    const ev = evaluate(results(svc('relay', { expires })), NOW)
    assert.equal(ev.healthy, false)
    assert.match(ev.problems[0], /relay: delegation EXPIRED/)
  }
})

test('the earlier of the two expiries counts, and a disagreement is noted', () => {
  const s = svc('api', { expires: NOW + 60 * DAY, health: { delegationExpires: NOW + 5 * DAY } })
  assert.equal(effectiveExpiry(s), NOW + 5 * DAY)
  const ev = evaluate(results(s), NOW)
  assert.equal(ev.healthy, false)
  assert.match(ev.problems[0], /expires in 5 days/)
  assert.equal(ev.warnings.length, 1)
})

test('a website or docs page that is not 200 is a problem', () => {
  const r = results(svc('api'))
  r.pages[1] = { ...r.pages[1], status: 404 }
  const ev = evaluate(r, NOW)
  assert.deepEqual(ev.problems, ['docs: https://tapeapi.fun/docs/ HTTP 404'])
})

test('daysUntil rounds down and goes negative after expiry', () => {
  assert.equal(daysUntil(NOW + DAY - 1, NOW), 0)
  assert.equal(daysUntil(NOW + 20 * DAY, NOW), 20)
  assert.equal(daysUntil(NOW - 1, NOW), -1)
})

test('retry tries twice, then gives up with the last error', async () => {
  let n = 0
  assert.equal(await retry(async () => { if (n++ === 0) throw new Error('flaky'); return 'ok' }, { pauseMs: 0 }), 'ok')
  n = 0
  await assert.rejects(retry(async () => { n++; throw new Error(`fail ${n}`) }, { pauseMs: 0 }), /fail 2/)
  assert.equal(n, 2)
})

test('the service list is well-formed and the relay probe uses a fresh 32-byte room', () => {
  assert.deepEqual(SERVICES.map((s) => s.label), ['11.1013.tape', '12.1013.tape'])
  for (const s of SERVICES) assert.match(s.base, /^https:\/\//)
  const relay = SERVICES.find((s) => s.name === 'relay')
  const a = relay.probe.params(); const b = relay.probe.params()
  assert.match(a.room, /^[0-9a-f]{64}$/)
  assert.notEqual(a.room, b.room)
  assert.deepEqual({ after: a.after, waitMs: a.waitMs }, { after: -1, waitMs: 0 })
  assert.equal(relay.probe.check({ frames: [], next: 0, epoch: null }), true)
  assert.equal(SERVICES[0].probe.check({ blockNumber: 0 }), false)
})

// ---------------------------------------------------------------- relay async delivery (RELAY-1) / 中继异步投递
// A stand-in for relay.tapeapi.fun: the in-memory relay core behind api.call-shaped answers ({ verified, result }), with
// switches for what can go wrong between the post and the read. `evictWhileIdle` is RELAY-1 exactly: the Durable Object
// was recycled while idle and came back with an empty core.
// relay.tapeapi.fun 的替身：内存 relay core，回答形如 api.call 的 { verified, result }，外加若干开关模拟发送与读取之间可能出的错。
// `evictWhileIdle` 就是 RELAY-1：Durable Object 闲置时被回收，回来时是个空的 core。
function fakeRelay({ evictWhileIdle = false, reEpoch = false, tamper = false, sendNetFail = 0, recvNetFail = 0, recvAnswers = null } = {}) {
  let core = createRelayCore()
  const f = {
    sends: 0, recvs: 0, posted: [], waits: [],
    wait: async (ms) => { f.waits.push(ms) },
    async send(p) {
      f.sends++
      const result = await relayMethods(core).relaySend(p, { clientIp: '203.0.113.9' })
      f.posted.push(p)
      // The post landed but its answer was lost on the way back. / 投递已到达，回答在回程中丢了。
      if (f.sends <= sendNetFail) throw new TypeError('fetch failed')
      return { verified: true, result }
    },
    async recv(p) {
      f.recvs++
      if (f.recvs <= recvNetFail) throw Object.assign(new Error('provider request failed on all 1 endpoint(s): no answer within 20000 ms'), { code: 'PROVIDER_UNAVAILABLE' })
      if (recvAnswers) return recvAnswers(p)
      if (evictWhileIdle || reEpoch) {
        const last = f.posted.at(-1)
        core = createRelayCore()
        if (reEpoch) core.send(last.room, last.frame)          // same bytes, new room epoch / 字节相同，纪元不同
      }
      const result = await relayMethods(core).relayRecv(p)
      if (tamper && result.frames[0]) {
        const b = Buffer.from(result.frames[0].frame, 'base64'); b[b.length - 1] ^= 0x01
        result.frames[0] = { ...result.frames[0], frame: b.toString('base64') }
      }
      return { verified: true, result }
    },
  }
  return f
}
const WAIT = 1234
const runAsync = (relay, opts = {}) => checkRelayAsync({ send: relay.send, recv: relay.recv, wait: relay.wait, waitMs: WAIT, pauseMs: 7, ...opts })
const withAsync = (relayAsync) => ({ ...results(svc('api'), svc('relay')), relayAsync: { name: 'relay', label: '12.1013.tape', ...relayAsync } })

test('relay async delivery: a relay that keeps the room passes, after the idle wait, read with epoch null from -1', async () => {
  const relay = fakeRelay()
  let asked
  const recv = relay.recv
  relay.recv = async (p) => { asked = p; return recv(p) }
  const r = await runAsync(relay)
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(relay.waits, [WAIT])
  assert.deepEqual(r.attempts, { send: 1, recv: 1 })
  assert.deepEqual(asked, { room: relay.posted[0].room, after: -1, epoch: null, waitMs: 0 })
  const ev = evaluate(withAsync(r), NOW)
  assert.deepEqual(ev.problems, [])
  assert.match(report(withAsync(r), ev, NOW), /\| relay async delivery `12\.1013\.tape` \| ok, 1 frame \(\d+ bytes, type 0x03\) read back by a fresh client, epoch unchanged \| 1\.2 s \|/)
})

test('CONFIRMED RELAY-1: the room lost while idle fails, and the report says why', async () => {
  const r = await runAsync(fakeRelay({ evictWhileIdle: true }))
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'wrong')
  assert.equal(r.error, '0 frames, epoch null: the relay lost the room while idle')
  const ev = evaluate(withAsync(r), NOW)
  assert.deepEqual(ev.problems, ['relay: async delivery failed after 1.2 s idle (0 frames, epoch null: the relay lost the room while idle)'])
  const md = report(withAsync(r), ev, NOW)
  assert.match(md, /1 problem\(s\)/)
  assert.match(md, /\| relay async delivery `12\.1013\.tape` \| FAILED \(0 frames, epoch null: the relay lost the room while idle\) \| 1\.2 s \|/)
})

test('relay async delivery: frame bytes that differ from what was posted fail', async () => {
  const r = await runAsync(fakeRelay({ tamper: true }))
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'wrong')
  assert.match(r.error, /^frame bytes differ from what was sent/)
})

test('relay async delivery: an epoch that changed while idle fails, even with the same bytes', async () => {
  const r = await runAsync(fakeRelay({ reEpoch: true }))
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'wrong')
  assert.match(r.error, /^epoch changed from [0-9a-f]+ to [0-9a-f]+: the room was re-created while idle$/)
  // Re-created and empty says so too. / 重建且为空也写明。
  assert.match(judgeAsync({ bytes: new Uint8Array(64), epoch: 'aa' }, { frames: [], next: -1, epoch: 'bb' }), /^0 frames, epoch bb instead of aa/)
  assert.match(judgeAsync({ bytes: new Uint8Array(64), epoch: 'aa' }, { frames: [{ i: 0, frame: 'AA==' }, { i: 1, frame: 'AA==' }], next: 1, epoch: 'aa' }), /^2 frames, expected exactly 1$/)
})

test('relay async delivery: network errors are retried (send and recv) and the check then passes', async () => {
  // The first post landed but its answer was lost: the retry goes to a NEW room, so the read still finds exactly one frame.
  // 第一次投递已到达但回答丢了：重试发往新房间，读取时仍恰好一帧。
  const relay = fakeRelay({ sendNetFail: 1, recvNetFail: 2 })
  const r = await runAsync(relay)
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(r.attempts, { send: 2, recv: 3 })
  assert.notEqual(relay.posted[0].room, relay.posted[1].room)
  assert.equal(r.room, relay.posted[1].room)
  assert.deepEqual(relay.waits, [7, WAIT, 7, 7])           // pause, idle, pause, pause / 间隔、闲置、间隔、间隔
})

test('relay async delivery: a relay that stays unreachable is DOWN after 3 tries, not FAILED', async () => {
  const r = await runAsync(fakeRelay({ recvNetFail: 99 }))
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'unreachable')
  assert.equal(r.attempts.recv, 3)
  assert.match(r.error, /^relayRecv: PROVIDER_UNAVAILABLE: /)
  const ev = evaluate(withAsync(r), NOW)
  assert.match(ev.problems[0], /^relay: async delivery unreachable after 1\.2 s idle \(relayRecv: PROVIDER_UNAVAILABLE/)
  assert.match(report(withAsync(r), ev, NOW), /\| relay async delivery `12\.1013\.tape` \| DOWN \(relayRecv: PROVIDER_UNAVAILABLE/)
  const s = await runAsync(fakeRelay({ sendNetFail: 99 }))
  assert.deepEqual([s.kind, s.attempts.send, s.attempts.recv], ['unreachable', 3, 0])
})

test('relay async delivery: an answer the relay signed is not retried, and an unverified one fails', async () => {
  const bad = Object.assign(new Error('room must be 32 bytes of lowercase hex'), { code: 'BAD_REQUEST' })
  let r = await runAsync(fakeRelay({ recvAnswers: () => { throw bad } }))
  assert.deepEqual([r.ok, r.kind, r.attempts.recv], [false, 'wrong', 1])
  assert.equal(r.error, 'relayRecv: BAD_REQUEST: room must be 32 bytes of lowercase hex')
  r = await runAsync(fakeRelay({ recvAnswers: () => ({ verified: false, result: { frames: [], next: -1, epoch: null } }) }))
  assert.deepEqual([r.ok, r.error], [false, 'relayRecv: envelope not verified'])
  assert.equal(isNetworkError(new TypeError('fetch failed')), true)
  assert.equal(isNetworkError(Object.assign(new Error('x'), { code: 'RPC_UNAVAILABLE' })), true)
  assert.equal(isNetworkError(bad), false)
})

test('relay async delivery: the wait is configurable (argument over env, default 60 s) and really waits', async () => {
  assert.equal(ASYNC_WAIT_S, 60)
  assert.equal(asyncWaitMs({ argv: [], env: {} }), 60_000)
  assert.equal(asyncWaitMs({ argv: [], env: { ASYNC_WAIT_S: '5' } }), 5_000)
  assert.equal(asyncWaitMs({ argv: ['--async-wait-s=0'], env: { ASYNC_WAIT_S: '5' } }), 0)
  assert.equal(asyncWaitMs({ argv: ['--async-wait-s=0.25'], env: {} }), 250)
  for (const v of ['abc', '-1', '601', '1e3']) assert.throws(() => asyncWaitMs({ argv: [], env: { ASYNC_WAIT_S: v } }), /0\.\.600 seconds/)
  // The default timer, a short wait: the read happens after it. / 默认计时器、短等待：读取在其之后。
  const relay = fakeRelay()
  const t0 = performance.now(); let readAt
  const recv = relay.recv
  const r = await checkRelayAsync({ send: relay.send, recv: async (p) => { readAt = performance.now() - t0; return recv(p) }, waitMs: 40 })
  assert.equal(r.ok, true, r.error)
  assert.ok(readAt >= 35, `read after ${readAt} ms`)
  assert.equal(r.waitS, 0)
})

test('relay async delivery: the test frame is 0x03, 64-200 bytes, accepted by the relay core; the room is fresh 32-byte hex', () => {
  const core = createRelayCore()
  const lens = new Set()
  for (let k = 0; k < 200; k++) {
    const f = testFrame()
    assert.equal(f.bytes[0], 0x03)
    assert.ok(f.bytes.length >= 64 && f.bytes.length <= 200, `length ${f.bytes.length}`)
    assert.deepEqual(new Uint8Array(Buffer.from(f.b64, 'base64')), f.bytes)
    const room = randomRoom()
    assert.match(room, /^[0-9a-f]{64}$/)
    assert.equal(core.send(room, f.b64, { source: 'ip:203.0.113.9' }).i, 0)
    lens.add(f.bytes.length)
  }
  assert.ok(lens.size > 20, 'lengths vary')
  // A skipped check (the relay did not resolve; its own row says so) is not a second problem. / 跳过不算第二个问题。
  const ev = evaluate(withAsync({ skipped: true, error: 'resolve failed: RPC_UNAVAILABLE: quorum' }), NOW)
  assert.deepEqual(ev.problems, [])
})

test('FIXED P101-2: a signed answer with no result is a clear failure, not a TypeError that ends the monitor without a report', async () => {
  const sent = { bytes: new Uint8Array(64), epoch: 'aa' }
  // judgeAsync used to throw here (JSON.stringify(undefined).slice) / judgeAsync 以前在这里抛 TypeError
  assert.equal(judgeAsync(sent, undefined), 'relayRecv answered with no result (undefined), not { frames, next, epoch }')
  assert.equal(judgeAsync(sent, null), 'unexpected result null', 'as before')
  const cyclic = {}; cyclic.self = cyclic
  assert.equal(judgeAsync(sent, cyclic), 'unexpected result [object Object]', 'an answer JSON cannot show is still judged')
  assert.equal(judgeAsync(sent, 5n), 'unexpected result 5')
  // checkRelayAsync: the send's or the read's signed envelope without `result` / 发送或读取的签名信封没有 `result`
  let r = await runAsync(fakeRelay(), { send: async () => ({ verified: true }) })
  assert.deepEqual([r.ok, r.kind, r.error], [false, 'wrong', 'relaySend answered with no result (undefined), not { i, epoch }'])
  assert.deepEqual(r.attempts, { send: 1, recv: 0 }, 'a signed answer is not retried')
  r = await runAsync(fakeRelay({ recvAnswers: () => ({ verified: true }) }))
  assert.deepEqual([r.ok, r.kind, r.error], [false, 'wrong', 'relayRecv answered with no result (undefined), not { frames, next, epoch }'])
  const ev = evaluate(withAsync(r), NOW)
  assert.deepEqual(ev.problems, ['relay: async delivery failed after 1.2 s idle (relayRecv answered with no result (undefined), not { frames, next, epoch })'])
})

// ---------------------------------------------------------------- activation (TAP-10 §6.3, TAP-11) / 激活
// There is no fetch mock in this file: results are built by hand and fed to evaluate/report, as above. checkActivation is fed a
// stand-in chain (api.rpc.ethCall answering by selector), which runs the doctor's real activationStatus on it.
// 本文件没有 fetch mock：结果手工构造再喂给 evaluate/report；checkActivation 喂一个替身链（api.rpc.ethCall 按选择子回答），跑的是 doctor 真正的 activationStatus。
const UNACTIVATED = { live: false, isLive: false, isContainerLive: false, paidUntil: null, feeText: '0.01 BNB', feeWei: '10000000000000000' }
const activated = (days) => ({ live: true, isLive: true, isContainerLive: false, paidUntil: NOW + days * DAY })
const CONTAINER = '0x1111111111111111111111111111111111111111'
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0')
function fakeChain(answers, { name = '11.1013.tape' } = {}) {
  const sel = (fn, args) => encodeCall(fn, args).slice(0, 10)
  const table = { [sel('isLive', [name, CONTAINER])]: 'isLive', [sel('isContainerLive', [CONTAINER])]: 'isContainerLive', [sel('containerPaidUntil', [CONTAINER])]: 'containerPaidUntil', [sel('monthlyFee', [])]: 'monthlyFee' }
  const f = { calls: [], chainId: 56, rpc: { ethCall: async (to, data) => {
    const fn = table[data.slice(0, 10)]
    f.calls.push(fn)
    const a = answers[fn]
    if (a instanceof Error) throw a
    return typeof a === 'function' ? a() : a
  } } }
  return f
}
const reverted = () => new TapeAPIError('RPC_ERROR', 'execution reverted')
const down = () => new TapeAPIError('RPC_UNAVAILABLE', 'quorum not reached: 3 nodes, 0 answers')

test('MON-ACT-1: activated with plenty of days: no finding, the report shows the paid-until date and the days left', () => {
  const r = results(svc('api', { activation: activated(25) }), svc('relay', { activation: { ...activated(40), isLive: false, isContainerLive: true } }))
  const ev = evaluate(r, NOW)
  assert.deepEqual(ev, { healthy: true, problems: [], warnings: [] })
  const md = report(r, ev, NOW)
  assert.match(md, /\| Service \| Health \| Latency \| Signer \(chain = service\) \| Delegation expires \| Activation \| Verified call \|/)
  assert.match(md, new RegExp(`active until ${new Date((NOW + 25 * DAY) * 1000).toISOString().slice(0, 10)} \\(25 d\\)`))
  assert.match(md, /\(40 d\)/)
})

test('MON-ACT-2: activated, fewer than 14 days left: a warning, not a problem; 14 days exactly is quiet', () => {
  assert.equal(WARN_DAYS, 14)
  const ev = evaluate(results(svc('api', { activation: activated(10) }), svc('relay')), NOW)
  assert.equal(ev.healthy, true)
  assert.deepEqual(ev.problems, [])
  assert.equal(ev.warnings.length, 1)
  assert.match(ev.warnings[0], /^api: activation expires in 10 days \(\d{4}-\d\d-\d\d\)/)
  assert.deepEqual(evaluate(results(svc('api', { activation: activated(14) })), NOW).warnings, [])
  assert.equal(evaluate(results(svc('api', { activation: { ...activated(14), paidUntil: NOW + 14 * DAY - 3600 } })), NOW).warnings.length, 1)
})

test('MON-ACT-3: activated, fewer than 3 days left (or past): a problem, and the exit code is 1', () => {
  assert.equal(ACTIVATION_FAIL_DAYS, 3)
  assert.equal(evaluate(results(svc('api', { activation: activated(3) })), NOW).healthy, true, '3 days exactly is a warning')
  for (const paidUntil of [NOW + 3 * DAY - 3600, NOW + 2 * DAY, NOW + 60]) {
    const ev = evaluate(results(svc('api', { activation: { ...activated(0), paidUntil } }), svc('relay')), NOW)
    assert.equal(ev.healthy, false, String(paidUntil - NOW))
    assert.equal(ev.problems.length, 1)
    assert.match(ev.problems[0], /^api: activation expires in 2 days|^api: activation expires in 0 days/)
  }
  const gone = evaluate(results(svc('relay', { activation: { ...activated(0), paidUntil: NOW - 2 * DAY } })), NOW)
  assert.equal(gone.healthy, false)
  assert.match(gone.problems[0], /^relay: activation EXPIRED \d{4}-\d\d-\d\d/)
})

test('MON-ACT-4: not activated: a warning that says TAP-11 and "unpaid" and names monthlyFee(), never a problem', () => {
  const r = results(svc('api', { activation: UNACTIVATED }), svc('relay', { activation: UNACTIVATED }))
  const ev = evaluate(r, NOW)
  assert.equal(ev.healthy, true)
  assert.deepEqual(ev.problems, [])
  assert.equal(ev.warnings.length, 2)
  for (const w of ev.warnings) {
    assert.match(w, /is not activated/)
    assert.match(w, /TAP-11/)
    assert.match(w, /"unpaid"/)
    assert.match(w, /monthlyFee\(\) now: 0\.01 BNB per 30 days/)
    assert.match(w, /site files stay readable/)
  }
  const md = report(r, ev, NOW)
  assert.match(md, /all healthy/)
  assert.match(md, /\| NOT ACTIVATED \(TAP-11: unpaid\), monthlyFee 0\.01 BNB \/ 30 d \|/)
  // The fee could not be read: the warning still stands, without a number. / 费用读不到：警告照旧，只是没有数字。
  assert.doesNotMatch(activationFindings(svc('api', { activation: { ...UNACTIVATED, feeText: null } }), NOW).warnings[0], /monthlyFee/)
})

test('MON-ACT-5: an unreadable chain is a warning that names the error; skipped or missing says nothing, and nothing else changes', () => {
  const ev = evaluate(results(svc('api', { activation: { error: 'RPC_UNAVAILABLE: quorum not reached' } }), svc('relay')), NOW)
  assert.equal(ev.healthy, true)
  assert.deepEqual(ev.problems, [])
  assert.match(ev.warnings[0], /^api: activation could not be read \(RPC_UNAVAILABLE: quorum not reached\)/)
  assert.match(report(results(svc('api', { activation: { error: 'RPC_UNAVAILABLE: x' } })), ev, NOW), /unreadable \(RPC_UNAVAILABLE: x\)/)
  // A resolve that failed skips the activation: only the resolve problem, no second line / 解析失败则跳过激活：只有解析那一个问题
  const skipped = svc('api', { chain: { signer: undefined, expires: undefined, error: 'RPC_UNAVAILABLE: quorum' }, call: { ok: undefined, skipped: true }, activation: { skipped: true } })
  assert.deepEqual(evaluate(results(skipped), NOW), { healthy: false, problems: ['api: on-chain resolve failed (RPC_UNAVAILABLE: quorum)'], warnings: [] })
  assert.deepEqual(evaluate(results(svc('api', { activation: null })), NOW), { healthy: true, problems: [], warnings: [] })
  assert.match(report(results(svc('api', { activation: null })), { healthy: true, problems: [], warnings: [] }, NOW), /\| - \|/)
  // activated, paid-until unknown: no day count to judge / 已激活但到期时间读不到
  assert.deepEqual(evaluate(results(svc('api', { activation: { live: true, paidUntil: null } })), NOW), { healthy: true, problems: [], warnings: [] })
})

test('MON-ACT-6: neither service activated does not change the exit code: same healthy flag and same problems as without the check', () => {
  const boards = {
    'all healthy': () => [svc('api', { activation: null }), svc('relay', { activation: null })],
    'one service down': () => [svc('api', { activation: null, health: { status: 502 } }), svc('relay', { activation: null })],
    'delegation 5 days': () => [svc('api', { activation: null, expires: NOW + 5 * DAY }), svc('relay', { activation: null })],
  }
  for (const [what, make] of Object.entries(boards)) {
    const before = evaluate(results(...make()), NOW)
    const after = evaluate(results(...make().map((s) => ({ ...s, activation: UNACTIVATED }))), NOW)
    assert.equal(after.healthy, before.healthy, what)
    assert.deepEqual(after.problems, before.problems, what)
    assert.equal(after.warnings.length, before.warnings.length + 2, `${what}: only the two warnings are new`)
  }
  // The exit code main() derives: healthy ? 0 : 1 / main() 的退出码：healthy ? 0 : 1
  assert.equal(evaluate(results(svc('api', { activation: UNACTIVATED }), svc('relay', { activation: UNACTIVATED })), NOW).healthy ? 0 : 1, 0)
  // The report is the GitHub issue body only when something is wrong; a warning-only run prints Notes, not Problems.
  const md = report(results(svc('api', { activation: UNACTIVATED })), evaluate(results(svc('api', { activation: UNACTIVATED })), NOW), NOW)
  assert.match(md, /all healthy/)
  assert.match(md, /Notes/)
  assert.doesNotMatch(md, /\*\*Problems\*\*/)
})

test('MON-ACT-7: checkActivation on a stand-in chain: unactivated reads isLive, isContainerLive, monthlyFee (3 eth_calls) and gives a JSON-safe result', async () => {
  const chain = fakeChain({ isLive: word(0), isContainerLive: word(0), monthlyFee: word(10n ** 16n) })
  const a = await checkActivation(chain, { name: '11.1013.tape', container: CONTAINER }, { pauseMs: 0 })
  assert.deepEqual(chain.calls, ['isLive', 'isContainerLive', 'monthlyFee'])
  assert.equal(a.live, false)
  assert.equal(a.feeText, '0.01 BNB')
  assert.equal(a.feeWei, '10000000000000000')
  assert.doesNotThrow(() => JSON.stringify(a), 'no bigint in the result: --json must print it')
  assert.equal(evaluate(results(svc('api', { activation: a })), NOW).warnings.length, 1)
})

test('MON-ACT-8: checkActivation: activated reads containerPaidUntil (3 eth_calls); isContainerLive reverting counts as false; a read failure never throws', async () => {
  let chain = fakeChain({ isLive: word(1), isContainerLive: word(1), containerPaidUntil: word(NOW + 9 * DAY) })
  let a = await checkActivation(chain, { name: '11.1013.tape', container: CONTAINER }, { pauseMs: 0 })
  assert.deepEqual(chain.calls, ['isLive', 'isContainerLive', 'containerPaidUntil'])
  assert.deepEqual([a.live, a.paidUntil, a.feeText], [true, NOW + 9 * DAY, null])
  assert.match(evaluate(results(svc('api', { activation: a })), NOW).warnings[0], /activation expires in 9 days/)
  chain = fakeChain({ isLive: word(1), isContainerLive: reverted(), containerPaidUntil: word(NOW + 40 * DAY) })
  a = await checkActivation(chain, { name: '11.1013.tape', container: CONTAINER }, { pauseMs: 0 })
  assert.deepEqual([a.live, a.isLive, a.isContainerLive], [true, true, false])
  // Nodes down: retried once (the whole check), then { error }: no exception, a warning, exit code unchanged
  chain = fakeChain({ isLive: down() })
  a = await checkActivation(chain, { name: '11.1013.tape', container: CONTAINER }, { pauseMs: 0 })
  assert.deepEqual(chain.calls, ['isLive', 'isLive'])
  assert.match(a.error, /^RPC_UNAVAILABLE: quorum not reached/)
  const ev = evaluate(results(svc('api', { activation: a }), svc('relay')), NOW)
  assert.deepEqual([ev.healthy, ev.problems.length, ev.warnings.length], [true, 0, 1])
  // A flaky first read that then answers is fine / 第一次不稳、重试后有回答也行
  let n = 0
  chain = fakeChain({ isLive: () => { if (n++ === 0) throw down(); return word(0) }, isContainerLive: word(0), monthlyFee: word(10n ** 16n) })
  assert.equal((await checkActivation(chain, { name: '11.1013.tape', container: CONTAINER }, { pauseMs: 0 })).live, false)
  // A chain with no known DomainBinding is an error result too, not a crash / 没有已知 DomainBinding 的链也只是错误结果
  assert.match((await checkActivation({ ...fakeChain({}), chainId: 31337 }, { name: '11.1013.tape', container: CONTAINER }, { pauseMs: 0 })).error, /no DomainBinding is known on chain 31337/)
})

test('MON-ACT-9: the --json output of a run with activation results prints (no bigint anywhere)', async () => {
  const a = await checkActivation(fakeChain({ isLive: word(0), isContainerLive: word(0), monthlyFee: word(10n ** 16n) }), { name: '11.1013.tape', container: CONTAINER }, { pauseMs: 0 })
  const text = JSON.stringify({ ...results(svc('api', { activation: a })), ...evaluate(results(svc('api', { activation: a })), NOW) }, null, 2)
  assert.match(text, /"feeText": "0\.01 BNB"/)
})

// ---------------------------------------------------------------- 2.0: the resolve is sorted by e.data.status / 2.0：解析按 e.data.status 分类
// The monitor uses the SDK default (the TAP-10 conformance mode), whose errors name the outcome in e.data.status. The old
// assertions above are untouched: a result with no chain.status keeps its one plain line.
// 监控用 SDK 默认（TAP-10 一致模式），其错误在 e.data.status 里说明结果。上面的旧断言一字未动：没有 chain.status 的结果仍是原来那一行。
const IMPL_OK = [
  { role: 'siteRegistry', proxy: '0xd006ffdd5Ae313B17729621A00999cD3C71CE5e6', implementation: '0x1d279d138a4d803378a7d4557c056f1bed53c261', accepted: true },
  { role: 'binding', proxy: '0x861EE183de2BBE4a6ecf9D15812C123b566a3DB7', implementation: '0xaa226181a6588d3f9ac0035e5f3dbaf311039bce', accepted: true },
]
const IMPL_NEW = [IMPL_OK[0], { ...IMPL_OK[1], implementation: '0x000000000000000000000000000000000000dEaD', accepted: false }]
const failed = (status, extra = {}, error = `SITE_STATUS: ${status}: x`) => svc('api', { chain: { signer: undefined, expires: undefined, error, status, ...extra }, call: { ok: undefined, skipped: true }, activation: { skipped: true } })

test('MON-2.0-1: unpaid is an ALERT and a problem (exit 1) of its own, not "on-chain resolve failed"', () => {
  const r = results(failed('unpaid'), svc('relay'))
  const ev = evaluate(r, NOW)
  assert.equal(ev.healthy, false)
  assert.equal(ev.problems.length, 1)
  assert.match(ev.problems[0], /^api: UNPAID: api\.1013\.tape/)
  assert.match(ev.problems[0], /no TAP-11 client resolves this service/)
  assert.doesNotMatch(ev.problems[0], /on-chain resolve failed/)
  assert.deepEqual(ev.alerts, ev.problems)
  assert.deepEqual(ev.counts, { unpaid: 1 })
  const md = report(r, ev, NOW)
  assert.match(md, /1 problem\(s\), 1 ALERT\(s\)/)
  assert.ok(md.indexOf('**ALERT**') > 0 && md.indexOf('**ALERT**') < md.indexOf('| Service |'), 'the alert heads the report, above the table')
  assert.match(md, /Chain read failures by status: unpaid 1\./)
  assert.doesNotMatch(md, /\*\*Problems\*\*/, 'an alert is not listed a second time under Problems')
})

test('MON-2.0-2: store-changed is an ALERT that names the implementation the store or payment contract now runs', () => {
  const ev = evaluate(results(failed('store-changed', { implementations: IMPL_NEW }), svc('relay')), NOW)
  assert.equal(ev.healthy, false)
  assert.equal(ev.alerts.length, 1)
  assert.match(ev.alerts[0], /^api: STORE-CHANGED:/)
  assert.match(ev.alerts[0], /binding 0x861EE183de2BBE4a6ecf9D15812C123b566a3DB7 runs 0x000000000000000000000000000000000000dEaD/)
  assert.match(ev.alerts[0], /SDK does not list/)
  assert.doesNotMatch(ev.alerts[0], /siteRegistry/, 'only the unaccepted one is named')
  assert.deepEqual(ev.counts, { storeChanged: 1 })
})

test('MON-2.0-3: not-opened, unsupported and other statuses are problems that say what they are, never alerts', () => {
  const no = evaluate(results(failed('not-opened')), NOW)
  assert.equal(no.healthy, false)
  assert.match(no.problems[0], /^api: NOT OPENED:/)
  assert.deepEqual([no.alerts, no.counts], [undefined, { notOpened: 1 }])
  const un = evaluate(results(failed('unsupported')), NOW)
  assert.match(un.problems[0], /not a form this client resolves \(unsupported\)/)
  assert.deepEqual(un.counts, { unsupported: 1 })
  const ot = evaluate(results(failed('manifest-invalid', {}, 'MANIFEST_INVALID: bad')), NOW)
  assert.deepEqual(ot.problems, ['api: on-chain resolve failed [manifest-invalid] (MANIFEST_INVALID: bad)'])
  assert.deepEqual(ot.counts, { other: 1 })
})

test('MON-2.0-4: unavailable is counted on its own, is a problem after the retry, and is not an alert', () => {
  const ev = evaluate(results(failed('unavailable', {}, 'RPC_UNAVAILABLE: unavailable: quorum not reached'), svc('relay')), NOW)
  assert.equal(ev.healthy, false)
  assert.equal(ev.problems.length, 1)
  assert.match(ev.problems[0], /^api: chain nodes unavailable:/)
  assert.match(ev.problems[0], /the nodes, not the service/)
  assert.equal(ev.alerts, undefined)
  assert.deepEqual(ev.counts, { unavailable: 1 })
  // two services with different statuses are counted apart / 两个服务状态不同，分别计数
  const two = evaluate(results(failed('unavailable'), { ...failed('unpaid'), name: 'relay', label: '12.1013.tape' }), NOW)
  assert.deepEqual(two.counts, { unavailable: 1, unpaid: 1 })
  assert.equal(two.alerts.length, 1)
  assert.equal(two.problems.length, 2)
})

test('MON-2.0-5: a healthy board and one with a plain chain.error keep exactly the 1.x evaluation shape (no alerts, no counts keys)', () => {
  assert.deepEqual(evaluate(results(svc('api'), svc('relay')), NOW), { healthy: true, problems: [], warnings: [] })
  const plain = svc('api', { chain: { signer: undefined, expires: undefined, error: 'RPC_UNAVAILABLE: quorum' }, call: { ok: undefined, skipped: true } })
  assert.deepEqual(evaluate(results(plain), NOW), { healthy: false, problems: ['api: on-chain resolve failed (RPC_UNAVAILABLE: quorum)'], warnings: [] })
  assert.deepEqual(chainFailure(svc('api')), { problems: [], alerts: [], unavailable: false, kind: null })
})

test('MON-2.0-6: the implementation-slot check: an unaccepted implementation is an ALERT even when the resolve worked; accepted ones are quiet', () => {
  const ok = svc('api'); ok.slots = { status: 'ok', implementations: IMPL_OK }
  assert.deepEqual(evaluate(results(ok, svc('relay')), NOW), { healthy: true, problems: [], warnings: [] })
  assert.match(report(results(ok), { healthy: true, problems: [], warnings: [] }, NOW), /\| ok \(2 accepted\) \|/)
  const bad = svc('api'); bad.slots = { status: 'ok', implementations: IMPL_NEW }
  const ev = evaluate(results(bad, svc('relay')), NOW)
  assert.equal(ev.healthy, false)
  assert.match(ev.alerts[0], /^api: STORE-CHANGED: binding 0x861EE183de2BBE4a6ecf9D15812C123b566a3DB7 runs implementation 0x0000/)
  assert.deepEqual(ev.counts, { storeChanged: 1 })
  assert.match(report(results(bad), ev, NOW), /CHANGED binding 0x0000…dEaD/)
  // the resolve already said store-changed: said once, not twice / 解析已说过 store-changed：只说一次
  const both = failed('store-changed', { implementations: IMPL_NEW }); both.slots = { status: 'store-changed', implementations: IMPL_NEW }
  const evb = evaluate(results(both), NOW)
  assert.equal(evb.alerts.length, 1)
  assert.deepEqual(evb.counts, { storeChanged: 1 })
})

test('MON-2.0-7: a slot check that could not read is a warning (the exit code stays), counted as unavailable once per service', () => {
  const s = svc('api'); s.slots = { error: 'RPC_UNAVAILABLE: quorum not reached', status: 'unavailable' }
  const ev = evaluate(results(s, svc('relay')), NOW)
  assert.equal(ev.healthy, true)
  assert.deepEqual(ev.problems, [])
  assert.match(ev.warnings[0], /^api: implementation slots of the site store and payment contract could not be read \(RPC_UNAVAILABLE/)
  assert.deepEqual(ev.counts, { unavailable: 1 })
  assert.match(report(results(s), ev, NOW), /unreadable \(RPC_UNAVAILABLE: quorum not reached\)/)
  // the resolve was unavailable too: still one count for the service / 解析也 unavailable：该服务仍只计一次
  const t = failed('unavailable'); t.slots = { error: 'x', status: 'unavailable' }
  assert.deepEqual(evaluate(results(t), NOW).counts, { unavailable: 1 })
  assert.deepEqual(slotFindings(svc('api')), { problems: [], alerts: [], warnings: [], unavailable: false })
})

test('MON-2.0-8: checkSlots reads api.siteStatus, is retried only for a read that could not be adopted, and never throws', async () => {
  let calls = 0
  const api = { siteStatus: async (t) => { calls++; assert.deepEqual(t, { circuits: '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', tokenId: 11 }); return { status: 'unpaid', implementations: IMPL_OK, container: '0x1' } } }
  const a = await checkSlots(api, { circuits: '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', tokenId: 11 }, { pauseMs: 0 })
  assert.deepEqual(a, { status: 'unpaid', implementations: IMPL_OK })
  assert.equal(calls, 1)
  assert.doesNotThrow(() => JSON.stringify(a))
  let n = 0
  const flaky = { siteStatus: async () => { if (n++ === 0) throw new TapeAPIError('RPC_UNAVAILABLE', 'quorum', { data: { status: 'unavailable' } }); return { status: 'ok', implementations: IMPL_OK } } }
  assert.equal((await checkSlots(flaky, {}, { pauseMs: 0 })).status, 'ok')
  assert.equal(n, 2)
  n = 0
  const input = { siteStatus: async () => { n++; throw new TapeAPIError('INVALID_ARGUMENT', 'bad', { data: { status: 'input-error' } }) } }
  assert.deepEqual(await checkSlots(input, {}, { pauseMs: 0 }), { error: 'INVALID_ARGUMENT: bad', status: 'input-error' })
  assert.equal(n, 1, 'a definite answer is not asked twice')
  const dead = { siteStatus: async () => { throw new Error('fetch failed') } }
  assert.deepEqual(await checkSlots(dead, {}, { pauseMs: 0 }), { error: 'fetch failed', status: 'unavailable' })
})

test('MON-2.0-9: checkChainAndCall keeps e.data.status, does not retry a definite status, retries unavailable, and keeps the slot check either way', async () => {
  const target = { circuits: '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', tokenId: 11 }
  const base = { name: 'api', label: '11.1013.tape', ...target, probe: SERVICES[0].probe }
  const stop = (status, data = {}) => new TapeAPIError('SITE_STATUS', `${status}: x`, { data: { ...data, status } })
  // unpaid: asked once, call and activation skipped, slots still read
  let resolves = 0
  let r = await checkChainAndCall({ chainId: 56, resolve: async () => { resolves++; throw stop('unpaid', { container: '0x1111111111111111111111111111111111111111' }) }, siteStatus: async () => ({ status: 'unpaid', implementations: IMPL_OK }) }, base, { pauseMs: 0 })
  assert.equal(resolves, 1)
  assert.equal(r.chain.status, 'unpaid')
  assert.equal(r.chain.container, '0x1111111111111111111111111111111111111111')
  assert.deepEqual([r.call.skipped, r.activation.skipped, r.slots.status], [true, true, 'unpaid'])
  assert.equal(evaluate(results({ name: 'api', label: base.label, health: svc('api').health, ...r }), NOW).alerts.length, 1)
  // store-changed carries the implementations from the error
  r = await checkChainAndCall({ chainId: 56, resolve: async () => { throw stop('store-changed', { implementations: IMPL_NEW }) }, siteStatus: async () => ({ status: 'store-changed', implementations: IMPL_NEW }) }, base, { pauseMs: 0 })
  assert.deepEqual(r.chain.implementations, IMPL_NEW)
  // unavailable: tried twice
  resolves = 0
  r = await checkChainAndCall({ chainId: 56, resolve: async () => { resolves++; throw stop('unavailable') }, siteStatus: async () => { throw stop('unavailable') } }, base, { pauseMs: 0 })
  assert.equal(resolves, 2)
  assert.equal(r.chain.status, 'unavailable')
  assert.equal(r.slots.status, 'unavailable')
  // a plain Error (no status) is retried and leaves no status, so the 1.x line stays
  resolves = 0
  r = await checkChainAndCall({ chainId: 56, resolve: async () => { resolves++; throw new Error('boom') }, siteStatus: async () => ({ status: 'ok', implementations: IMPL_OK }) }, base, { pauseMs: 0 })
  assert.equal(resolves, 2)
  assert.equal(r.chain.status, undefined)
  assert.deepEqual(evaluate(results({ name: 'api', label: base.label, health: svc('api').health, ...r }), NOW).problems.filter((p) => /resolve failed/.test(p)), ['api: on-chain resolve failed (boom)'])
  assert.deepEqual([retryableResolve(stop('unpaid')), retryableResolve(stop('unavailable')), retryableResolve(stop('stale-block')), retryableResolve(new Error('x'))], [false, true, true, true])
})

test('MON-2.0-10: a resolved service with accepted slots goes through checkChainAndCall to a healthy evaluation, and --json prints', async () => {
  const target = { circuits: '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', tokenId: 11 }
  const base = { name: 'api', label: '11.1013.tape', ...target, probe: SERVICES[0].probe }
  const resolved = { container: CONTAINER, manifest: { signer: SIGNER, delegation: { expires: NOW + 60 * DAY }, endpoints: { live: ['https://api.tapeapi.fun'] } } }
  const chain = fakeChain({ isLive: word(1), isContainerLive: word(1), containerPaidUntil: word(NOW + 25 * DAY) })
  const api = { ...chain, resolve: async () => resolved, call: async () => ({ verified: true, result: { blockNumber: 7 } }), siteStatus: async () => ({ status: 'ok', implementations: IMPL_OK }) }
  const r = await checkChainAndCall(api, base, { pauseMs: 0 })
  assert.equal(r.chain.status, undefined)
  assert.deepEqual(r.slots, { status: 'ok', implementations: IMPL_OK })
  assert.equal(r.call.ok, true)
  const res = results({ name: 'api', label: base.label, health: svc('api').health, ...r })
  const ev = evaluate(res, NOW)
  assert.deepEqual(ev, { healthy: true, problems: [], warnings: [] })
  assert.doesNotThrow(() => JSON.stringify({ ...res, ...ev }))
})

// ---------------------------------------------------------------- 2.0 (C5): the default mode, resolved, and WARN_DAYS / 2.0（C5）：默认模式、resolved 与 WARN_DAYS
test('MON-2.0-11: the monitor\'s client is the SDK default (the TAP-10 conformance mode), never conform: false, with no DEPRECATED warning', async () => {
  const warned = []
  const orig = console.warn
  console.warn = (...a) => warned.push(a.join(' '))
  let api
  try { api = await monitorClient({ fetch: async () => new Response('{}') }) } finally { console.warn = orig }
  assert.equal(CONFORM_MODE.get(api), true, 'conformance mode')
  assert.deepEqual(warned, [], 'no deprecation warning')
  assert.equal(api.chainId, 56)
  assert.equal(CONFORM_MODE.get(await monitorClient()), true, 'the default nodes too (no request is made here)')
})

// A live-looking pair of services on the conform fake chain, resolved by the monitor's own client: the real 2.0 default
// resolve, offline. `days`: days left on the delegation. / conform 假链上的两个服务，由监控自己的客户端解析：真实的 2.0 默认解析，离线。
async function onConformChain({ days = 60, set = () => {} } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const chain = createConformChain()
  chain.state.headTime = now
  const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32)
  const holder = sig.privateKeyToAddress(HOLDER_KEY), signer = sig.privateKeyToAddress(SIGNER_KEY)
  const expires = now + days * DAY
  const out = []
  for (const tokenId of [11, 12]) {
    const c = chain.circuit(tokenId, { holder })
    chain.writeFile(c.container, MANIFEST_KEY, JSON.stringify({
      tapeapi: '0.1', name: `svc${tokenId}`, circuits: c.circuits, tokenId: c.tokenId, container: c.container, signer,
      delegation: { expires, sig: sig.signDigest(sig.delegationDigest(56, MAINNET.hub, { container: c.container, signer, expires }), HOLDER_KEY) },
      endpoints: { live: ['https://svc.example/tapeapi/v1'], async: false },
      methods: [{ name: 'blockNumber', priceBEM: '0', params: {}, returns: {} }],
    }))
    out.push({ tokenId, circuits: c.circuits, container: c.container })
  }
  set(chain, out)
  // RPC to the fake chain; the service itself is not reachable here (the verified call fails, which this test does not judge)
  // RPC 发往假链；服务本身在这里连不上（验签调用失败，本测试不评判它）
  const fetch = async (url, init) => { if (String(url).startsWith('http://rpc')) return chain.fetch(url, init); throw new TypeError('offline test: no service here') }
  const api = await monitorClient({ rpcUrls: ['http://rpc1', 'http://rpc2', 'http://rpc3'], fetch })
  const rows = []
  for (const [i, name] of ['api', 'relay'].entries()) {
    const svcDef = { name, label: `${out[i].tokenId}.7.tape`, circuits: out[i].circuits, tokenId: out[i].tokenId, probe: SERVICES[0].probe }
    const r = await checkChainAndCall(api, svcDef, { pauseMs: 0 })
    rows.push({ name, label: svcDef.label, health: { status: 200, ok: true, signer, delegationExpires: expires, latencyMs: 1 }, ...r })
  }
  return { now, signer, expires, results: { services: rows, pages: pages() } }
}
const notCall = (problems) => problems.filter((p) => !/verified blockNumber failed/.test(p))

test('MON-2.0-12: both services resolve in the default mode on a TAP-10 chain: chain.conform is "resolved" and the report says so', async () => {
  const { now, signer, results: res } = await onConformChain()
  for (const s of res.services) {
    assert.equal(s.chain.error, undefined, s.chain.error)
    assert.equal(s.chain.conform, 'resolved')
    assert.equal(s.chain.signer, signer)
    assert.equal(s.slots.status, 'ok'); assert.ok(s.slots.implementations.every((i) => i.accepted))
    assert.equal(s.activation.live, true)
  }
  const ev = evaluate(res, now)
  assert.ok(res.services.every((s) => /offline test: no service here/.test(s.call.error)), 'the call went through the test fetch, never the network')
  assert.deepEqual(notCall(ev.problems), [], 'nothing but the unreachable test service')
  assert.equal(defaultModeLine(res), 'Default-mode resolution (TAP-10): api resolved, relay resolved.')
  assert.match(report(res, ev, now), /\nDefault-mode resolution \(TAP-10\): api resolved, relay resolved\.\n/)
  assert.doesNotThrow(() => JSON.stringify({ ...res, ...ev }))
})

test('MON-2.0-13: WARN_DAYS still holds in the default mode: 10 days left on a resolved service is a problem (exit 1); 20 days is not', async () => {
  const short = await onConformChain({ days: 10 })
  assert.equal(short.results.services[0].chain.conform, 'resolved')
  const ev = evaluate(short.results, short.now)
  assert.equal(ev.healthy, false)
  const lines = notCall(ev.problems)
  assert.equal(lines.length, 2)
  for (const [i, n] of ['api', 'relay'].entries()) assert.match(lines[i], new RegExp(`^${n}: delegation expires in (9|10) days \\(\\d{4}-\\d{2}-\\d{2}\\); re-sign it now$`))
  const fine = await onConformChain({ days: 20 })
  assert.deepEqual(notCall(evaluate(fine.results, fine.now).problems), [])
  assert.ok(WARN_DAYS === 14)
})

test('MON-2.0-14: a resolve the default mode refuses (unpaid, store-changed, not-opened) does not hide the delegation: WARN_DAYS falls back to the service\'s own expiry', async () => {
  // real: one service unactivated on the conform chain / 真实：conform 链上一个服务未激活
  const { now, results: res } = await onConformChain({ days: 10, set: (chain, out) => chain.setContainerLive(out[0].container, false) })
  assert.equal(res.services[0].chain.status, 'unpaid')
  assert.equal(res.services[0].chain.expires, undefined, 'no manifest was read')
  assert.equal(res.services[1].chain.conform, 'resolved')
  const ev = evaluate(res, now)
  assert.ok(ev.alerts.some((a) => /^api: UNPAID/.test(a)))
  assert.ok(ev.problems.some((p) => /^api: delegation expires in (9|10) days/.test(p)), 'the health check\'s delegationExpires still counts')
  assert.ok(ev.problems.some((p) => /^relay: delegation expires in (9|10) days/.test(p)))
  assert.equal(defaultModeLine(res), 'Default-mode resolution (TAP-10): api unpaid, relay resolved.')
  // by hand: every refusal, and an expired delegation / 手工：每种拒绝，以及已过期的委托
  for (const st of ['unpaid', 'store-changed', 'not-opened', 'unavailable']) {
    const s = failed(st); s.health = { ...s.health, delegationExpires: NOW + 5 * DAY }
    const e = evaluate(results(s, svc('relay')), NOW)
    assert.ok(e.problems.includes(`api: delegation expires in 5 days (${new Date((NOW + 5 * DAY) * 1000).toISOString().slice(0, 10)}); re-sign it now`), st)
    const x = failed(st); x.health = { ...x.health, delegationExpires: NOW - DAY }
    assert.ok(evaluate(results(x, svc('relay')), NOW).problems.some((p) => /^api: delegation EXPIRED /.test(p)), st)
    const ok = failed(st)   // 60 days left: the refusal alone, no delegation line / 还剩 60 天：只有拒绝，没有委托那一行
    assert.ok(!evaluate(results(ok, svc('relay')), NOW).problems.some((p) => /delegation/.test(p)), st)
  }
  assert.equal(defaultModeLine(results(svc('api'), svc('relay'))), null, 'a result from before 2.0 adds no line')
  assert.ok(!/Default-mode resolution/.test(report(results(svc('api'), svc('relay')), { healthy: true, problems: [], warnings: [] }, NOW)))
})
