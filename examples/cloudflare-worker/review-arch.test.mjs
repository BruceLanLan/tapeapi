// Architecture review, Cloudflare relay items (A1, A2, and B2 through the Worker). Each `FIXED <id>` test replays the
// original scenario with the same in-process Durable Object stand-in as relay-worker.test.mjs. The same four
// scenarios (flood, priced without D1, alarm sweep, new-room budget) were also run on workerd with smoke-local.mjs
// (wrangler dev --local, 2026-09-24); still NOT run on Cloudflare itself or against a remote D1.
// 架构审查的 Cloudflare 中继部分。与 relay-worker.test.mjs 用同样的进程内 Durable Object 替身重放原场景。
// 同样四个场景也已用 smoke-local.mjs 在 workerd 上跑过（wrangler dev --local）；仍未在 Cloudflare 本身或远程 D1 上运行。
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRelay, RelayRoom } from './relay-worker.js'
import { SWEEP_MS } from './relay-room.js'
import { privateKeyToAddress, signDigest, delegationDigest } from '../../sdk/src/sig.js'
import { ADDR } from '../../sdk/test/helpers/fake-chain.mjs'

const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32)
const signer = privateKeyToAddress(SIGNER_KEY)
const EXPIRES = Math.floor(Date.now() / 1000) + 30 * 86400
const room = (n) => n.toString(16).padStart(64, '0')

// Durable Object storage as far as alarms go: one pending alarm per object, setAlarm replaces it.
// 就 alarm 而言的 DO 存储：每个对象至多一个待定 alarm，setAlarm 会替换它。
const fakeStorage = () => ({ alarm: null, sets: 0, async setAlarm(t) { this.alarm = t; this.sets++ }, async getAlarm() { return this.alarm } })
function durableNamespace(Cls) {
  const objects = new Map()
  return {
    idFromName: (name) => `id:${name}`,
    get: (id) => {
      if (!objects.has(id)) objects.set(id, new Cls({ storage: fakeStorage() }, {}))
      const o = objects.get(id)
      return { fetch: (url, init) => o.fetch(new Request(url, init)) }
    },
    get count() { return objects.size },
  }
}
const envFor = (extra = {}) => ({
  ROOMS: durableNamespace(RelayRoom), SIGNER_KEY, SIGNER_ADDRESS: signer, CIRCUITS: ADDR.circuits, TOKEN_ID: '4246', CONTAINER: ADDR.container,
  DELEGATION_EXPIRES: String(EXPIRES),
  DELEGATION_SIG: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires: EXPIRES }), HOLDER_KEY),
  PUBLIC_URL: 'https://relay.example', RPC_URLS: 'http://127.0.0.1:9,http://127.0.0.1:10', ...extra,
})
const call = async (iso, method, params, ip = '1.2.3.4') => (await iso.handleRequest(new Request(`https://relay.example/tapeapi/v1/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: `r${Math.random()}`, params }) }), { clientIp: ip })).json()

// ------------------------------------------------------------------------------------------------ A1 ----
test('FIXED A1: the priced Worker relay meters in D1, and refuses to start without it instead of metering per isolate', async () => {
  const priced = { RELAY_PRICE_BEM: '0.00001', ESCROW: ADDR.escrow }
  assert.throws(() => buildRelay(envFor(priced)), /priced relay needs the D1 binding DB/)
  const sql = []
  const DB = { prepare: (q) => ({ bind: (...args) => ({ first: async () => { sql.push([q, args]); return null }, run: async () => ({ meta: { changes: 1 } }), all: async () => ({ results: [] }) }) }) }
  const p = buildRelay(envFor({ ...priced, DB }))
  assert.equal(typeof p.store.advance, 'function', 'an atomic advance(): the D1 conditional UPDATE')
  assert.equal(p.stats().singleInstance, false)
  await p.store.get('0x' + 'aa'.repeat(20), ADDR.container)
  assert.match(sql[0][0], /FROM meter/, 'the meter is the D1 table, shared by every isolate')
  assert.ok(buildRelay(envFor()), 'a free relay still needs no D1')
})

// ------------------------------------------------------------------------------------------------ A2 ----
test('FIXED A2: a RelayRoom arms a Durable Object alarm when a frame is posted, sweeps on it, and goes idle once the room has expired', async () => {
  const storage = fakeStorage()
  const o = new RelayRoom({ storage }, {})
  const post = (path, body) => o.fetch(new Request(`https://room${path}`, { method: 'POST', body: JSON.stringify(body) }))
  await post('/recv', { room: room(1), after: -1, waitMs: 0 })
  assert.equal(storage.sets, 0, 'a poll on an empty room arms nothing')
  const t0 = Date.now()
  await post('/send', { room: room(1), frame: 'AAAA' })
  assert.equal(storage.sets, 1); assert.ok(storage.alarm >= t0 + SWEEP_MS && storage.alarm <= Date.now() + SWEEP_MS)
  await post('/send', { room: room(1), frame: 'AAAA' })
  assert.equal(storage.sets, 1, 'one pending alarm, not one per post')
  await o.alarm()                                                              // fires while the room is live / 房间仍活跃时触发
  assert.equal(o.core.size, 1, 'a live room is kept'); assert.equal(storage.sets, 2, 're-armed while it holds frames')
  // 16 minutes later nobody has touched it: the sweep drops it and no alarm is set again.
  // 16 分钟无人触碰：清理删掉它，且不再设 alarm。
  const realNow = Date.now
  Date.now = () => realNow() + 16 * 60 * 1000
  try { await o.alarm() } finally { Date.now = realNow }
  assert.equal(o.core.size, 0, 'the expired room and its frames are gone')
  assert.equal(storage.sets, 2, 'idle: no alarm')
  assert.deepEqual((await (await post('/recv', { room: room(1), after: -1, waitMs: 0 })).json()).frames, [])
  // An object without storage (the older test stand-in) still serves / 没有 storage 的对象（旧替身）照常服务
  const bare = new RelayRoom({}, {})
  assert.equal((await (await bare.fetch(new Request('https://room/send', { method: 'POST', body: JSON.stringify({ room: room(2), frame: 'AAAA' }) }))).json()).i, 0)
})

test('A2 smoke hooks: RELAY_SWEEP_MS / RELAY_ROOM_TTL_MS shorten the alarm and the room lifetime; unset or junk keeps the defaults', async () => {
  const post = (o, path, body) => o.fetch(new Request(`https://room${path}`, { method: 'POST', body: JSON.stringify(body) }))
  for (const env of [{}, { RELAY_SWEEP_MS: 'x', RELAY_ROOM_TTL_MS: '-5' }, { RELAY_SWEEP_MS: '1e300', RELAY_ROOM_TTL_MS: '1e300' }]) {   // 1e300: capped at a day / 超过一天回落默认
    const storage = fakeStorage(), o = new RelayRoom({ storage }, env)
    const t0 = Date.now()
    await post(o, '/send', { room: room(3), frame: 'AAAA' })
    assert.ok(storage.alarm >= t0 + SWEEP_MS, 'the production 5-minute alarm')
    const realNow = Date.now
    Date.now = () => realNow() + 14 * 60 * 1000
    try { await o.alarm() } finally { Date.now = realNow }
    assert.equal(o.core.size, 1, '900 s TTL: kept at 14 minutes')
  }
  const storage = fakeStorage(), o = new RelayRoom({ storage }, { RELAY_SWEEP_MS: '1000', RELAY_ROOM_TTL_MS: '1500' })
  const t0 = Date.now()
  await post(o, '/send', { room: room(3), frame: 'AAAA' })
  assert.ok(storage.alarm >= t0 + 1000 && storage.alarm < t0 + SWEEP_MS)
  const realNow = Date.now
  Date.now = () => realNow() + 2000
  try { await o.alarm() } finally { Date.now = realNow }
  assert.equal(o.core.size, 0, 'swept after 1.5 s')
})

test('FIXED A2: one IP gets a per-isolate budget of NEW rooms before idFromName; posts to rooms it has used, and other IPs, are unaffected', async () => {
  const env = envFor({ RATE_NEW_ROOMS: '3' })
  const iso = buildRelay(env)
  for (let k = 0; k < 3; k++) assert.equal((await call(iso, 'relaySend', { room: room(100 + k), frame: 'AAAA' }, '6.6.6.6')).ok, true)
  assert.equal(env.ROOMS.count, 3)
  const refused = await call(iso, 'relaySend', { room: room(200), frame: 'AAAA' }, '6.6.6.6')
  assert.equal(refused.ok, false); assert.equal(refused.error.code, 'BAD_REQUEST'); assert.match(refused.error.message, /too many new rooms/)
  assert.equal(env.ROOMS.count, 3, 'refused before a Durable Object was created')
  assert.equal((await call(iso, 'relaySend', { room: room(100), frame: 'AAAA' }, '6.6.6.6')).result.i, 1, 'its existing rooms still work')
  assert.equal((await call(iso, 'relaySend', { room: room(200), frame: 'AAAA' }, '7.7.7.7')).ok, true, 'another address is unaffected')
  assert.equal((await call(iso, 'relaySend', { room: room(200), frame: 'AAAA' }, '6.6.6.6')).ok, true, 'a room this isolate has seen is not new')
})

// ------------------------------------------------------------------------------------------------ B2 ----
test('FIXED B2 (Worker): the client IP reaches the Durable Object as the 0x03 source, and invites survive a frame flood', async () => {
  const env = envFor()
  const iso = buildRelay(env)
  const r = room(300)
  const invite = (k) => Buffer.from(Uint8Array.of(0x03, ...new Array(60).fill(k))).toString('base64')
  for (let k = 0; k < 8; k++) assert.equal((await call(iso, 'relaySend', { room: r, frame: invite(k) }, '8.8.8.8')).ok, true)
  const refused = await call(iso, 'relaySend', { room: r, frame: invite(9) }, '8.8.8.8')
  assert.equal(refused.ok, false); assert.match(refused.error.message, /too many invites/)
  assert.equal((await call(iso, 'relaySend', { room: r, frame: invite(9) }, '9.9.9.9')).ok, true)
  for (let k = 0; k < 300; k++) await call(iso, 'relaySend', { room: r, frame: 'AgAA' }, '5.5.5.5')   // 0x02 flood / 0x02 洪水
  const got = await call(iso, 'relayRecv', { room: r, after: -1, waitMs: 0 })
  assert.equal(got.result.frames.filter((f) => Buffer.from(f.frame, 'base64')[0] === 0x03).length, 9, 'all nine invites are still there')
})
