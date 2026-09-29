// Offline tests for the monitor's evaluation logic. No network: results are built by hand.
// 监控评估逻辑的离线测试：不联网，结果手工构造。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, report, daysUntil, effectiveExpiry, retry, SERVICES, PAGES, WARN_DAYS, ASYNC_WAIT_S, asyncWaitMs, testFrame, judgeAsync, isNetworkError, checkRelayAsync, randomRoom } from './monitor.mjs'
import { createRelayCore, relayMethods } from '../examples/relay-service/relay-core.mjs'

const NOW = 1_790_000_000
const DAY = 86400
const SIGNER = '0xaB70dEe8e1CEabb1D10eDFeBcbe0c313c53cf154'

function svc(name, { expires = NOW + 60 * DAY, health = {}, chain = {}, call = {} } = {}) {
  return {
    name, label: `${name}.1013.tape`,
    health: { status: 200, ok: true, signer: SIGNER, delegationExpires: expires, latencyMs: 120, ...health },
    chain: { signer: SIGNER.toLowerCase(), expires, ...chain },   // case differs on purpose: addresses compare case-insensitively
    call: { method: 'blockNumber', ok: true, ...call },
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
