// Offline tests for the monitor's evaluation logic. No network: results are built by hand.
// 监控评估逻辑的离线测试：不联网，结果手工构造。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, report, daysUntil, effectiveExpiry, retry, SERVICES, PAGES, WARN_DAYS } from './monitor.mjs'

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
