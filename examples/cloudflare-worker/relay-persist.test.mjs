// FIXED RELAY-1: the public relay lost every frame when Cloudflare evicted an idle RelayRoom (live, 2026-09-29: a
// 0x03 frame read back at once, then 0 frames and epoch null at +30 s ... +400 s, no redeploy). The room now lives in
// Durable Object storage. "Eviction" below is what Cloudflare does: a new RelayRoom on the same storage, nothing else
// shared. The storage stand-in is a Map with the KV-style API a SQLite-backed Durable Object offers.
// FIXED RELAY-1：Cloudflare 回收空闲的 RelayRoom 时公共中继丢掉全部帧。现在房间放在 Durable Object 存储里。下面的"回收"
// 就是 Cloudflare 做的事：同一份存储上新建一个 RelayRoom，别的什么都不共享。存储替身是一个 Map，提供 SQLite 后端 DO 的 KV 接口。
import test from 'node:test'
import assert from 'node:assert/strict'
import { RelayRoom, TOUCH_WRITE_MS } from './relay-room.js'
import { buildRelay } from './relay-worker.js'
import { privateKeyToAddress, signDigest, delegationDigest } from '../../sdk/src/sig.js'
import { ADDR } from '../../sdk/test/helpers/fake-chain.mjs'

const room = (n) => n.toString(16).padStart(64, '0')
const wire = (type, k = 0, len = 40) => Buffer.from(Uint8Array.of(type, ...new Array(len).fill(k & 0xff))).toString('base64')
const handshake = (t) => Buffer.concat([Buffer.of(0x01), Buffer.from(JSON.stringify({ t }))]).toString('base64')

// Durable Object storage (KV API) and state, in memory. Values are copied in and out, as the real storage does.
// Durable Object 存储（KV 接口）与 state 的内存实现。值在写入与读出时复制，与真实存储一致。
function fakeStorage({ delayMs = 0 } = {}) {
  const data = new Map()
  const later = (fn) => (delayMs ? new Promise((r) => setTimeout(() => r(fn()), delayMs)) : Promise.resolve(fn()))
  return {
    data, alarm: null, sets: 0, writes: 0,
    get(k) { return later(() => structuredClone(data.get(k))) },
    put(k, v) {
      const entries = typeof k === 'string' ? [[k, v]] : Object.entries(k)
      return later(() => { for (const [key, val] of entries) { data.set(key, structuredClone(val)); this.writes++ } })
    },
    delete(k) { return later(() => { this.writes++; return data.delete(k) }) },
    list({ prefix = '' } = {}) { return later(() => new Map([...data.keys()].filter((k) => k.startsWith(prefix)).sort().map((k) => [k, structuredClone(data.get(k))]))) },
    deleteAll() { return later(() => { this.writes += data.size; data.clear() }) },
    async setAlarm(t) { this.alarm = t; this.sets++ },
    async getAlarm() { return this.alarm },
  }
}
const stateOf = (storage) => ({ storage, blockConcurrencyWhile: async (fn) => fn() })
const op = async (o, path, body) => (await o.fetch(new Request(`https://room${path}`, { method: 'POST', body: JSON.stringify(body) }))).json()
const frameKeys = (s) => [...s.data.keys()].filter((k) => k.startsWith('f:')).map((k) => Number(k.slice(2))).sort((a, b) => a - b)
const at = async (ms, fn) => { const real = Date.now; Date.now = () => real() + ms; try { return await fn() } finally { Date.now = real } }

test('FIXED RELAY-1: a RelayRoom recreated on the same storage has the same frames, both rings, epoch and next; cursors keep working', async () => {
  const storage = fakeStorage(), r = room(1)
  const a = new RelayRoom(stateOf(storage), {})
  const sent = []
  sent.push(await op(a, '/send', { room: r, frame: wire(0x03, 1), source: 'ip:1.1.1.1' }))       // a sealed invite / 密封邀请
  for (let k = 0; k < 5; k++) sent.push(await op(a, '/send', { room: r, frame: wire(0x02, k) }))
  sent.push(await op(a, '/send', { room: r, frame: wire(0x04, 2), source: 'ip:1.1.1.1' }))       // an epoch message / 纪元消息
  const epoch = sent[0].epoch
  assert.deepEqual(sent.map((s) => s.i), [0, 1, 2, 3, 4, 5, 6]); assert.ok(sent.every((s) => s.epoch === epoch))
  const first = await op(a, '/recv', { room: r, after: -1, waitMs: 0, epoch: null })
  const cursor = first.frames[3].i                                                                // the reader got as far as 3 / 读到 3
  // Eviction: the old instance is gone, a new one starts on the same storage. / 回收：旧实例消失，新实例在同一份存储上启动。
  const b = new RelayRoom(stateOf(storage), {})
  const again = await op(b, '/recv', { room: r, after: -1, waitMs: 0, epoch })
  assert.equal(again.epoch, epoch, 'the epoch survives, so a client cursor stays valid')
  assert.deepEqual(again.frames, first.frames, 'every frame, in posting order, both rings')
  const rest = await op(b, '/recv', { room: r, after: cursor, waitMs: 0, epoch })
  assert.deepEqual(rest.frames.map((f) => f.i), [4, 5, 6], 'a cursor from before the eviction continues where it stopped')
  const next = await op(b, '/send', { room: r, frame: wire(0x02, 9) })
  assert.deepEqual(next, { i: 7, epoch }, 'indices continue from next')
  // The kept ring came back as the kept ring: a flood of frames through the new instance cannot push out the invite.
  // 受保护环按受保护环恢复：经由新实例的帧洪水挤不掉邀请。
  for (let k = 0; k < 300; k++) await op(b, '/send', { room: r, frame: wire(0x02, k) })
  const c = new RelayRoom(stateOf(storage), {})
  const after = await op(c, '/recv', { room: r, after: -1, waitMs: 0, epoch })
  assert.deepEqual(after.frames.filter((f) => f.frame === wire(0x03, 1) || f.frame === wire(0x04, 2)).map((f) => f.i), [0, 6], 'the invite and the epoch message are still there')
  assert.equal(after.epoch, epoch)
  // A handshake-only room comes back handshake-only (its 10-minute lifetime), a restored room keeps an alarm.
  // 仅握手房间恢复后仍是仅握手房间（寿命 10 分钟）；恢复的房间一定有 alarm。
  const hs = fakeStorage(), h = room(2)
  await op(new RelayRoom(stateOf(hs), {}), '/handshake', { room: h, frame: handshake('accept') })
  assert.equal(hs.data.get('m').handshakeOnly, true)
  hs.alarm = null
  const h2 = new RelayRoom(stateOf(hs), {})
  await h2.ready
  assert.ok(hs.alarm > Date.now(), 'a restored room without an alarm gets one, so it still expires')
  await at(11 * 60 * 1000, () => h2.alarm())
  assert.equal(hs.data.size, 0, 'handshake room: cleared after 10 minutes')
})

test('FIXED RELAY-1: one key per frame plus one meta key; a full ring deletes the key of the frame it shifts out; sources are never stored', async () => {
  const storage = fakeStorage(), r = room(3)
  const o = new RelayRoom(stateOf(storage), {})
  for (let k = 0; k < 260; k++) await op(o, '/send', { room: r, frame: wire(0x02, k), source: 'ip:6.6.6.6' })
  assert.deepEqual(frameKeys(storage), Array.from({ length: 256 }, (_, k) => k + 4), 'f:0 .. f:3 left with the frames the ring dropped')
  assert.deepEqual([...storage.data.keys()].filter((k) => !k.startsWith('f:')), ['m'], 'one meta key besides the frames')
  assert.deepEqual(Object.keys(storage.data.get('m')).sort(), ['epoch', 'handshakeOnly', 'next', 'room', 'touched'])
  assert.equal(storage.data.get('f:4'), wire(0x02, 4), 'a frame key holds the base64 frame, nothing else')
  // Kept ring: 64 invites from 9 sources (8 each), 65 posted, the oldest invite's key is deleted.
  // 受保护环：9 个来源各 8 条中投了 65 条邀请，最旧那条的键被删掉。
  const invites = []
  for (let k = 0; k < 65; k++) invites.push((await op(o, '/send', { room: r, frame: wire(0x03, k), source: `ip:10.0.0.${k >> 3}` })).i)
  const keys = new Set(frameKeys(storage))
  assert.equal(keys.has(invites[0]), false, 'the invite the kept ring shifted out is gone from storage')
  assert.ok(invites.slice(1).every((i) => keys.has(i)), 'the other 64 invites are stored')
  assert.equal(keys.size, 256 + 64)
  // Restored after eviction, the room holds exactly what storage holds. / 回收后恢复的房间与存储里的完全一致。
  const all = await op(new RelayRoom(stateOf(storage), {}), '/recv', { room: r, after: -1, waitMs: 0 })
  assert.ok(all.frames.every((f) => keys.has(f.i)))
  assert.ok(![...storage.data.values()].some((v) => JSON.stringify(v).includes('ip:')), 'no source (IP or consumer) is written to storage')
})

test('FIXED RELAY-1: relaySend answers only after its frame is in storage', async () => {
  const storage = fakeStorage({ delayMs: 30 }), r = room(4)
  const o = new RelayRoom(stateOf(storage), {})
  const out = await op(o, '/send', { room: r, frame: wire(0x03, 7), source: 'ip:1.1.1.1' })
  assert.equal(storage.data.get(`f:${out.i}`), wire(0x03, 7), 'the frame was written before {i, epoch} came back')
  assert.equal(storage.data.get('m').next, out.i + 1)
  assert.equal(storage.data.get('m').epoch, out.epoch)
})

test('FIXED RELAY-1: the alarm clears an expired room from storage even after an eviction; the next post gets a new epoch', async () => {
  const storage = fakeStorage(), r = room(5)
  const sent = await op(new RelayRoom(stateOf(storage), {}), '/send', { room: r, frame: wire(0x02, 1) })
  assert.ok(storage.alarm, 'the post armed an alarm (kept in storage, so it outlives the instance)')
  // 14 minutes: the alarm wakes a recreated object; the room is not expired and stays. / 14 分钟：未过期，保留。
  await at(14 * 60 * 1000, async () => { const o = new RelayRoom(stateOf(storage), {}); await o.alarm() })
  assert.deepEqual(frameKeys(storage), [0]); assert.ok(storage.data.has('m'))
  // 16 minutes idle: the alarm on yet another recreated object clears everything. / 闲置 16 分钟：清空全部存储。
  let o
  await at(16 * 60 * 1000, async () => { o = new RelayRoom(stateOf(storage), {}); await o.alarm() })
  assert.equal(storage.data.size, 0, 'storage is empty')
  assert.deepEqual(await op(o, '/recv', { room: r, after: -1, waitMs: 0 }), { frames: [], next: -1, epoch: null })
  const fresh = await op(new RelayRoom(stateOf(storage), {}), '/send', { room: r, frame: wire(0x02, 2) })
  assert.equal(fresh.i, 0); assert.notEqual(fresh.epoch, sent.epoch, 'only a room that really expired comes back with a new epoch')
  // A room found expired on restore (its alarm had not run yet) is cleared, not served. / 恢复时发现已过期：清除，不再提供。
  const s2 = fakeStorage()
  await op(new RelayRoom(stateOf(s2), {}), '/send', { room: r, frame: wire(0x02, 3) })
  const late = await at(16 * 60 * 1000, async () => op(new RelayRoom(stateOf(s2), {}), '/recv', { room: r, after: -1, waitMs: 0 }))
  assert.equal(late.epoch, null); assert.equal(s2.data.size, 0)
})

test('FIXED RELAY-1: reads keep a room alive across evictions, as in memory; touched is written at most once a minute', async () => {
  const storage = fakeStorage(), r = room(6)
  const { epoch } = await op(new RelayRoom(stateOf(storage), {}), '/send', { room: r, frame: wire(0x02, 1) })
  const w0 = storage.writes
  const o = new RelayRoom(stateOf(storage), {})
  for (let k = 0; k < 5; k++) await op(o, '/recv', { room: r, after: -1, waitMs: 0, epoch })
  assert.equal(storage.writes, w0, 'polls within a minute of the last write write nothing')
  // Polled every 5 minutes by a client whose object is evicted in between: alive at 20 minutes after the post.
  // 每 5 分钟被轮询一次、其间对象被回收：投递 20 分钟后仍在。
  for (const min of [5, 10, 15, 20]) {
    const got = await at(min * 60 * 1000, async () => {
      const x = new RelayRoom(stateOf(storage), {})
      await x.alarm()
      return op(x, '/recv', { room: r, after: -1, waitMs: 0, epoch })
    })
    assert.equal(got.epoch, epoch, `still the same room at ${min} min`); assert.equal(got.frames.length, 1)
  }
  assert.ok(storage.writes - w0 <= 4 + 4, 'one meta write per poll a minute or more apart (plus alarms)')
  assert.ok(TOUCH_WRITE_MS <= 60_000)
})

// The live report, replayed through the Worker: a 0x03 frame posted, read back at once, then read by another process
// at +30 s ... +400 s. Every get() of the namespace below is a fresh object on the room's storage, i.e. an eviction
// between every request. / 线上现象经由 Worker 重放：每次 get() 都是该房间存储上的新对象，即每两个请求之间都发生回收。
test('FIXED RELAY-1 (Worker): the live scenario -- an invite read back at +30 s ... +400 s after evictions, same epoch', async () => {
  const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32)
  const signer = privateKeyToAddress(SIGNER_KEY)
  const EXPIRES = Math.floor(Date.now() / 1000) + 30 * 86400
  const stores = new Map()
  const ROOMS = {
    idFromName: (name) => `id:${name}`,
    get: (id) => {
      if (!stores.has(id)) stores.set(id, fakeStorage())
      const o = new RelayRoom(stateOf(stores.get(id)), {})
      return { fetch: (url, init) => o.fetch(new Request(url, init)) }
    },
  }
  const env = {
    ROOMS, SIGNER_KEY, SIGNER_ADDRESS: signer, CIRCUITS: ADDR.circuits, TOKEN_ID: '4246', CONTAINER: ADDR.container,
    DELEGATION_EXPIRES: String(EXPIRES),
    DELEGATION_SIG: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires: EXPIRES }), HOLDER_KEY),
    PUBLIC_URL: 'https://relay.example', RPC_URLS: 'http://127.0.0.1:9,http://localhost:10',
  }
  const call = async (iso, method, params) => (await (await iso.handleRequest(new Request(`https://relay.example/tapeapi/v1/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: `r${Math.random()}`, params }) }), { clientIp: '1.2.3.4' })).json()).result
  const r = room(7), frame = wire(0x03, 3)
  const sent = await call(buildRelay(env), 'relaySend', { room: r, frame })
  const now = await call(buildRelay(env), 'relayRecv', { room: r, after: -1, waitMs: 0, epoch: null })
  assert.deepEqual(now.frames, [{ i: 0, frame }]); assert.equal(now.epoch, sent.epoch)
  const other = buildRelay(env)                                                             // another process / 另一个进程
  for (const s of [30, 60, 90, 150, 240, 400]) {
    const got = await at(s * 1000, () => call(other, 'relayRecv', { room: r, after: -1, waitMs: 0, epoch: null }))
    assert.deepEqual([got.frames, got.epoch], [[{ i: 0, frame }], sent.epoch], `+${s} s: 1 frame, same epoch`)
  }
})
