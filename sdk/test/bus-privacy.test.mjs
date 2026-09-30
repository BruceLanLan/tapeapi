// Read privacy for ChannelBus (sdk/src/bus-privacy.js; the 2026 Q4 plan, privacy item 2): what each node is asked,
// and what reaches the application. A recording fetch keeps every eth_getLogs filter each node receives.
// ChannelBus 的读取隐私：每家节点被问了什么、什么交到了应用手里。记录用的 fetch 保存每家节点收到的每个 eth_getLogs 过滤条件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { channel, busPrivacy, TapeAPIError } from '../src/index.js'
import { createRpc } from '../src/rpc.js'
import { createFakeChain } from './helpers/fake-chain.mjs'
import { loadedMachine, virtualClock, withClock } from './helpers/clock.mjs'
import { forbiddenIn } from '../../scripts/privacy-words.mjs'

const { busPrivacyReader, scanCoverPool, plausibleRoom, DEFAULT_COVER_K } = busPrivacy
const { busTransport, createInvite, acceptInvite, completeInvite, encodeWire, decodeWire, CHANNELBUS_WIRE_TOPIC: WIRE } = channel
const BUS = '0x' + 'cb'.repeat(20)
const RPC = ['http://rpc1', 'http://rpc2']
const room = () => randomBytes(32).toString('hex')
const quiet = () => {}

// Every eth_getLogs a node receives: { url, topics, fromBlock, toBlock } / 每家节点收到的每个 eth_getLogs
function recorded(chain) {
  const asks = []
  const fetch = (url, init) => { const b = JSON.parse(init.body); if (b.method === 'eth_getLogs') asks.push({ url, ...b.params[0] }); return chain.fetch(url, init) }
  return { asks, fetch }
}
const roomsOf = (ask) => (ask.topics.length < 2 ? [] : (Array.isArray(ask.topics[1]) ? ask.topics[1] : [ask.topics[1]]).map((t) => t.slice(2)))
const roomAsks = (asks) => asks.filter((a) => a.topics.length === 2)
const poster = (chain, rpc) => (r) => busTransport({ rpc, bus: BUS, inbound: '00'.repeat(32), outbound: r, sendTx: async (tx) => chain.submit(tx) })

// A chain whose bus carried frames to `n` other rooms in the recent past (the cover pool) / 近期有 n 个别人房间收过帧的链
async function world(n, { rpcOpts = {} } = {}) {
  const chain = createFakeChain()
  const rec = recorded(chain)
  const rpc = createRpc({ urls: RPC, quorum: 2, fetch: rec.fetch, ...rpcOpts })
  const post = poster(chain, createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }))
  const others = Array.from({ length: n }, room)
  for (const r of others) { await post(r).send(Uint8Array.of(0x02, 0xcc)); chain.mine(3) }
  return { chain, rec, rpc, post, others, start: chain.state.block }
}

test('cover mode: each room of yours goes out among k rooms, the covers are real rooms from the pool, and only your frames come back', async () => {
  const { chain, rec, rpc, post, others, start } = await world(40)
  const [r1, r2] = [room(), room()]
  const warns = []
  const reader = busPrivacyReader({ mode: 'cover', rpc, bus: BUS, rooms: [r1, r2], fromBlock: start - 200, confirmations: 0, warn: (m) => warns.push(m) })
  assert.equal(reader.mode, 'cover')
  const mine1 = Uint8Array.of(0x02, 1), mine2 = Uint8Array.of(0x02, 2)
  await post(r1).send(mine1); await post(r2).send(mine2)
  for (const r of others.slice(0, 10)) await post(r).send(Uint8Array.of(0x02, 0xee))   // traffic in cover rooms / 掩护房间里的流量
  chain.mine(1)
  const got = await reader.poll()
  assert.deepEqual(got, [{ room: r1, wire: mine1 }, { room: r2, wire: mine2 }], 'only the frames of your rooms reach the application')
  assert.deepEqual(warns, [], 'a pool of 40 rooms gives two rooms 7 covers each: nothing to warn about')

  // The pool scan names no room; every room-bearing request carries k rooms per room of yours / 池扫描不含房间；带房间的请求每个你的房间配 k 个
  const scans = rec.asks.filter((a) => a.topics.length === 1)
  assert.ok(scans.length >= 1 && scans.every((a) => a.topics[0] === WIRE), 'the pool is read with address-only queries')
  const asks = roomAsks(rec.asks)
  assert.ok(asks.length >= 2)
  const covers = reader.covers
  const pool = new Set(others)
  for (const r of [r1, r2]) {
    assert.equal(covers[r].length, DEFAULT_COVER_K - 1, 'k − 1 covers per room')
    for (const c of covers[r]) assert.ok(pool.has(c), 'a cover is a room that really appeared on the bus')
  }
  assert.equal(new Set([...covers[r1], ...covers[r2]]).size, 2 * (DEFAULT_COVER_K - 1), 'no cover serves two rooms of yours')
  for (const a of asks) {
    const rs = roomsOf(a)
    assert.equal(rs.length, 2 * DEFAULT_COVER_K, 'two rooms of yours, each among k')
    assert.deepEqual(new Set(rs), new Set([r1, r2, ...covers[r1], ...covers[r2]]))
  }
  const s = reader.stats().privacy
  assert.equal(s.effectiveK, DEFAULT_COVER_K); assert.equal(s.short, false)
  assert.equal(s.pool, 42, 'the 40 others and your two rooms, which posted before the scan: yours are in the pool too, never drawn as covers')
  assert.ok(s.dropped >= 2 * 10, 'the cover rooms\' frames were dropped before the scanner saw them')

  // Covers stay put across polls: rotating them would let a node intersect requests / 掩护跨轮询不变：轮换会让节点取交集
  const before = JSON.stringify(reader.covers)
  for (let i = 0; i < 5; i++) { chain.mine(1); await reader.poll() }
  assert.equal(JSON.stringify(reader.covers), before)
  const sets = new Set(roomAsks(rec.asks).map((a) => JSON.stringify(roomsOf(a).slice().sort())))
  assert.equal(sets.size, 1, 'every request of the session asks for the same set of rooms')
  const orders = new Set(roomAsks(rec.asks).map((a) => JSON.stringify(roomsOf(a))))
  assert.ok(orders.size > 1, 'but in a fresh random order')
})

test('cover mode: the position of your room in a request is uniformly random', async () => {
  const { chain, rec, rpc } = await world(12)
  const mine = room()
  const reader = busPrivacyReader({ mode: 'cover', rpc, bus: BUS, rooms: [mine], confirmations: 0, warn: quiet })
  const seen = new Array(DEFAULT_COVER_K).fill(0)
  for (let i = 0; i < 100; i++) { chain.mine(1); await reader.poll() }
  for (const a of roomAsks(rec.asks)) { const rs = roomsOf(a); assert.equal(rs.length, DEFAULT_COVER_K); seen[rs.indexOf(mine)]++ }
  const total = seen.reduce((x, y) => x + y, 0)
  assert.ok(total >= 200)
  // 200 draws over 8 places: each place expected 25; below 5 or above 60 happens with p < 1e-6 / 每个位置期望 25 次
  for (const [i, n] of seen.entries()) assert.ok(n >= 5 && n <= 60, `position ${i} seen ${n} times of ${total}`)
})

test('cover mode: a room added later is caught up WITH its covers (the catch-up read is never a room alone); removing it removes them; re-adding brings the same ones', async () => {
  const { chain, rec, rpc, post, start } = await world(30)
  const [r1, r2] = [room(), room()]
  const reader = busPrivacyReader({ mode: 'cover', rpc, bus: BUS, rooms: [r1], fromBlock: start - 100, confirmations: 0, warn: quiet })
  await reader.poll()
  const early = Uint8Array.of(0x02, 0x77)
  await post(r2).send(early); chain.mine(3)
  const n0 = rec.asks.length
  reader.add(r2)
  assert.deepEqual(await reader.poll(), [{ room: r2, wire: early }], 'r2\'s past, read on the next poll')
  const asks = roomAsks(rec.asks.slice(n0))
  const catchUp = asks.filter((a) => !roomsOf(a).includes(r1))
  assert.ok(catchUp.length >= 1, 'a separate catch-up read for r2 (busReader\'s own behaviour)')
  for (const a of catchUp) assert.deepEqual(new Set(roomsOf(a)), new Set([r2, ...reader.covers[r2]]), 'r2 is caught up among its own k rooms')
  for (const a of asks) assert.ok(roomsOf(a).length >= DEFAULT_COVER_K, 'no request with fewer than k rooms')
  const c2 = reader.covers[r2]
  reader.remove(r2)
  chain.mine(1); const n1 = rec.asks.length; await reader.poll()
  for (const a of roomAsks(rec.asks.slice(n1))) {
    assert.ok(!roomsOf(a).includes(r2)); for (const c of c2) assert.ok(!roomsOf(a).includes(c), 'r2\'s covers left with it')
  }
  const r3 = room()
  reader.add(r3); chain.mine(1); await reader.poll()
  for (const c of reader.covers[r3]) assert.ok(!c2.includes(c), 'a cover is never reused for another room of yours')
  reader.add(r2); chain.mine(1); await reader.poll()
  assert.deepEqual(reader.covers[r2], c2, 'r2 comes back with the same covers')
  // A room of yours that is already one of r1's covers draws no new covers, yet its catch-up read goes out among r1's group
  // 已经是 r1 掩护的你的房间不再抽新掩护，但它的补读仍混在 r1 的组里发出
  const inner = reader.covers[r1][0]
  const n2 = rec.asks.length
  reader.add(inner); chain.mine(1); await reader.poll()
  const later = roomAsks(rec.asks.slice(n2))
  assert.ok(later.some((a) => !roomsOf(a).includes(r2)), 'a separate catch-up read for it')
  for (const a of later) assert.ok(roomsOf(a).length >= DEFAULT_COVER_K, 'never with fewer than k rooms')
  assert.deepEqual(new Set([inner, ...reader.covers[inner]]), new Set([r1, ...reader.covers[r1]]), 'its group is r1\'s')
  assert.equal(reader.stats().privacy.effectiveK, DEFAULT_COVER_K)
})

test('cover mode: a pool too small is said out loud (warn, stats), never passed off as cover; onShort "error" sends nothing', async () => {
  // 3 rooms in the pool, k = 8 / 池里只有 3 个房间
  const small = await world(3)
  const warns = []
  const mine = room()
  const reader = busPrivacyReader({ mode: 'cover', rpc: small.rpc, bus: BUS, rooms: [mine], confirmations: 0, warn: (m, d) => warns.push({ m, d }) })
  await reader.poll(); small.chain.mine(1); await reader.poll()
  assert.equal(warns.length, 1, 'said once, not every poll')
  assert.match(warns[0].m, /only 3 cover rooms/); assert.match(warns[0].m, /1 in 4, not 1 in 8/)
  assert.deepEqual({ k: warns[0].d.k, effectiveK: warns[0].d.effectiveK }, { k: 8, effectiveK: 4 })
  const s = reader.stats().privacy
  assert.equal(s.short, true); assert.equal(s.effectiveK, 4)
  for (const a of roomAsks(small.rec.asks)) assert.equal(roomsOf(a).length, 4, 'what goes out is what stats say')

  // An empty pool: the node sees exactly your rooms, and the warning says so / 空池：节点看到的正是你的房间，警告如实说明
  const none = await world(0)
  const w2 = []
  const r2 = busPrivacyReader({ mode: 'cover', rpc: none.rpc, bus: BUS, rooms: [room()], confirmations: 0, warn: (m) => w2.push(m) })
  await r2.poll()
  assert.match(w2[0], /no cover rooms available/); assert.match(w2[0], /see exactly which rooms/)
  assert.equal(r2.stats().privacy.effectiveK, 1)

  // onShort: 'error' throws BUS_PRIVACY before any room-bearing request / 在任何带房间的请求之前抛错
  const strict = await world(2)
  const r3 = busPrivacyReader({ mode: 'cover', rpc: strict.rpc, bus: BUS, rooms: [room()], confirmations: 0, cover: { onShort: 'error' }, warn: quiet })
  await assert.rejects(r3.poll(), (e) => e instanceof TapeAPIError && e.code === 'BUS_PRIVACY' && e.effectiveK === 3)
  assert.deepEqual(roomAsks(strict.rec.asks), [], 'no request naming a room was sent')
  // A smaller k the pool can meet reads normally / 池子满足得了的更小 k 正常读取
  const r4 = busPrivacyReader({ mode: 'cover', rpc: strict.rpc, bus: BUS, rooms: [room()], confirmations: 0, cover: { k: 3, onShort: 'error' }, warn: quiet })
  await r4.poll()
  assert.equal(r4.stats().privacy.effectiveK, 3)
})

test('cover pool: rooms the caller supplies (inbox rooms of known containers), no chain scan; implausible topics are never covers', async () => {
  const chain = createFakeChain()
  const rec = recorded(chain)
  const rpc = createRpc({ urls: RPC, quorum: 2, fetch: rec.fetch })
  const containers = Array.from({ length: 10 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '7'))
  const inboxes = containers.map((c) => channel.inboxRoom(c))
  const probe = Buffer.from('tapeapi deploy probe').toString('hex').padEnd(64, '0')   // the mainnet deploy probe's room / 主网部署探针的房间
  assert.equal(plausibleRoom(probe), false); assert.equal(plausibleRoom(inboxes[0]), true)
  const mine = room()
  let asked = 0
  const reader = busPrivacyReader({ mode: 'cover', rpc, bus: BUS, rooms: [mine], confirmations: 0, cover: { pool: async () => { asked++; return [...inboxes, probe] }, scanBlocks: 0 }, warn: quiet })
  await reader.poll(); chain.mine(1); await reader.poll()
  assert.equal(asked, 1, 'the caller\'s pool is asked again only after refreshMs (it may be a network lookup)')
  assert.ok(rec.asks.every((a) => a.topics.length === 2), 'scanBlocks: 0 reads no pool from the chain')
  assert.equal(reader.covers[mine].length, 7)
  for (const c of reader.covers[mine]) assert.ok(inboxes.includes(c))
  // The chain scan skips the probe too / 链上扫描同样跳过探针
  const post = poster(chain, createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }))
  await post(probe).send(Uint8Array.of(0x02, 0)); await post(inboxes[0]).send(Uint8Array.of(0x02, 0)); chain.mine(1)
  const scanned = await scanCoverPool({ rpc, bus: BUS, blocks: 100 })
  assert.deepEqual(scanned.rooms.map(([r]) => r), [inboxes[0]])
  assert.equal(scanned.complete, true)
})

test('cover pool scan: halves the span on a range refusal, falls back to the next node, stops at its byte budget', async () => {
  const chain = createFakeChain()
  const post = poster(chain, createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }))
  const rs = Array.from({ length: 6 }, room)
  for (const r of rs) { await post(r).send(new Uint8Array(1000).fill(2)); chain.mine(2000) }
  const spans = []
  const fetch = (url, init) => {
    const b = JSON.parse(init.body)
    if (b.method === 'eth_getLogs') {
      const w = Number(BigInt(b.params[0].toBlock)) - Number(BigInt(b.params[0].fromBlock)) + 1
      spans.push({ url, w })
      if (url === 'http://rpc1') return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, error: { code: -32000, message: 'node says no' } }), { headers: { 'content-type': 'application/json' } })
      if (w > 2500) return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, error: { code: -32000, message: 'exceed maximum block range: 2500' } }), { headers: { 'content-type': 'application/json' } })
    }
    return chain.fetch(url, init)
  }
  const rpc = createRpc({ urls: RPC, quorum: 2, fetch })
  const got = await scanCoverPool({ rpc, bus: BUS, blocks: 13_000 })
  assert.equal(new Set(got.rooms.map(([r]) => r)).size, 6, 'every room found through the second node')
  assert.ok(spans.some((s) => s.url === 'http://rpc2' && s.w === 2500), 'the span was halved to what the node accepts')
  const cut = await scanCoverPool({ rpc, bus: BUS, blocks: 13_000, maxBytes: 3000 })
  assert.equal(cut.complete, false, 'a byte budget stops the scan early, and says so')
  assert.ok(cut.rooms.length < 6)
})

test('cover.store keeps the same covers across restarts (a fresh draw per session would let a node intersect sessions)', async () => {
  const { chain, rpc } = await world(40)
  const mine = room()
  const store = new Map()
  const r1 = busPrivacyReader({ mode: 'cover', rpc, bus: BUS, rooms: [mine], confirmations: 0, cover: { store }, warn: quiet })
  await r1.poll()
  const first = r1.covers[mine]
  assert.equal(store.size, 1)
  // A restart: a new rpc client (no shared in-memory pool) and a new reader / 重启：新的 rpc 客户端与新读者
  const rpc2 = createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch })
  const r2 = busPrivacyReader({ mode: 'cover', rpc: rpc2, bus: BUS, rooms: [mine], confirmations: 0, cover: { store }, warn: quiet })
  await r2.poll()
  assert.deepEqual(r2.covers[mine], first, 'the same covers after a restart')
  // Without a store, a new session draws afresh (that is the "rotation", and why the store is advised)
  // 没有存储时新会话重新抽取（这就是"轮换"，也是建议保存状态的原因）
  const r3 = busPrivacyReader({ mode: 'cover', rpc: createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch }), bus: BUS, rooms: [mine], confirmations: 0, warn: quiet })
  await r3.poll()
  assert.notDeepEqual(new Set(r3.covers[mine]), new Set(first))
  void rpc
})

test('contract mode: requests name no room at all, your frames are filtered here, everything else is dropped', async () => {
  const { chain, rec, rpc, post, others, start } = await world(5)
  const mine = room()
  const reader = busPrivacyReader({ rpc, bus: BUS, rooms: [mine], mode: 'contract', fromBlock: start - 100, confirmations: 0, warn: quiet })
  const w = Uint8Array.of(0x02, 9)
  await post(mine).send(w); await post(others[0]).send(Uint8Array.of(0x02, 8)); chain.mine(1)
  assert.deepEqual(await reader.poll(), [{ room: mine, wire: w }])
  assert.ok(rec.asks.length >= 2)
  for (const a of rec.asks) assert.deepEqual(a.topics, [WIRE], 'address and the Wire topic only')
  const s = reader.stats().privacy
  assert.equal(s.mode, 'contract'); assert.equal(s.effectiveK, null)
  assert.ok(s.dropped >= 5 && s.downloaded.logs >= 6)
})

test('contract mode: over its download budget it stops with BUS_BUDGET, loudly, without losing the frames already read or hammering the nodes', async () => {
  const { chain, rec, rpc, post, start } = await world(0)
  const mine = room()
  const w = Uint8Array.of(0x02, 7)
  await post(mine).send(w); chain.mine(1)
  const junk = post(room())
  for (let i = 0; i < 30; i++) await junk.send(new Uint8Array(200).fill(i))   // someone fills the bus / 有人往总线灌垃圾
  chain.mine(1)
  const reader = busPrivacyReader({ rpc, bus: BUS, rooms: [mine], mode: 'contract', contract: { maxLogs: 20, onExceed: 'error' }, fromBlock: start, confirmations: 0, warn: quiet })
  assert.deepEqual(await reader.poll(), [{ room: mine, wire: w }], 'the frames of the poll that went over are handed over')
  const n = rec.asks.length
  await assert.rejects(reader.poll(), (e) => e instanceof TapeAPIError && e.code === 'BUS_BUDGET' && e.logs > 20 && /stopped/.test(e.message))
  await assert.rejects(reader.poll(), (e) => e.code === 'BUS_BUDGET')
  assert.equal(rec.asks.length, n, 'a stopped reader downloads nothing more')
  assert.equal(reader.stats().privacy.stopped, true)
  // The application chooses: here, cover mode (the pool scan meets the same junk room, the only one around)
  // 由应用决定：这里改用 cover 模式
  reader.setMode('cover')
  const later = Uint8Array.of(0x02, 6)
  await post(mine).send(later); chain.mine(1)
  assert.deepEqual(await reader.poll(), [{ room: mine, wire: later }])

  // A reader that went over with nothing to hand over throws at once / 超出预算且无可交出的读者立即抛错
  const r2 = busPrivacyReader({ rpc, bus: BUS, rooms: [room()], mode: 'contract', contract: { maxLogs: 20, onExceed: 'error' }, fromBlock: start, confirmations: 0, warn: quiet })
  await assert.rejects(r2.poll(), (e) => e.code === 'BUS_BUDGET')
})

test('contract mode with onExceed "cover": falls back to cover rooms and warns; the held blocks are read again, nothing is lost', async () => {
  const { chain, rpc, post, others, start } = await world(20)
  const mine = room()
  const junk = post(others[0])
  for (let i = 0; i < 40; i++) await junk.send(new Uint8Array(100).fill(i))
  chain.mine(1)
  const w = Uint8Array.of(0x02, 5)
  await post(mine).send(w); chain.mine(1)
  const warns = []
  const reader = busPrivacyReader({ rpc, bus: BUS, rooms: [mine], mode: 'contract', contract: { maxBytes: 4096, onExceed: 'cover' }, fromBlock: start, confirmations: 0, chunk: 40, minChunk: 1, warn: (m) => warns.push(m) })
  const got = []
  for (let i = 0; i < 4 && !got.length; i++) { try { got.push(...await reader.poll()) } catch { /* a hold while switching / 切换时的停住 */ } }
  assert.equal(reader.mode, 'cover')
  assert.ok(warns.some((m) => /Switched to 'cover' mode/.test(m)), 'the fallback is announced')
  assert.deepEqual(got, [{ room: mine, wire: w }])
})

const DEFAULT_TITLE = 'default: contract mode, no pool scan; over budget it falls back to cover rooms drawn from quiet traffic (never the junk), warns, and comes back with hysteresis and doubling waits'
// On a virtual clock (FIXED P101-1): retryMs is 60 ms, so real time between two polls was part of the outcome.
// 在虚拟时钟上运行（FIXED P101-1）：retryMs 只有 60 ms，两次轮询之间的真实耗时曾影响结果。
const defaultScenario = () => withClock(virtualClock(), async (clock) => {
  const { chain, rec, rpc, post, others, start } = await world(20)
  const mine = room()
  const warns = []
  const reader = busPrivacyReader({ rpc, bus: BUS, rooms: [mine], fromBlock: start - 100, confirmations: 0, contract: { maxLogs: 50, retryMs: 60 }, cover: { refreshMs: 0 }, warn: (m) => warns.push(m) })
  assert.equal(reader.mode, 'contract')
  await reader.poll()                                    // quiet: the 20 others' frames feed the pool / 安静：别人的帧补进池
  assert.ok(rec.asks.length >= 2 && rec.asks.every((a) => a.topics.length === 1 && Number(BigInt(a.fromBlock)) >= start - 100 - 16), 'no pool scan and no room named: the first poll waits for nothing but its own read')
  assert.equal(reader.stats().privacy.pool, 20)
  chain.mine(1)
  const junkRoom = room(), junk = post(junkRoom)
  for (let i = 0; i < 40; i++) await junk.send(Uint8Array.of(0x02, i))   // someone fills the bus / 有人灌垃圾
  const w = Uint8Array.of(0x02, 0x55)
  await post(mine).send(w); chain.mine(1)
  const got = await reader.poll()
  assert.equal(reader.mode, 'cover')
  assert.match(warns.at(-1), /over contract\.maxBytes .* Switched to 'cover' mode .* tries 'contract' again in/)
  got.push(...await reader.poll())
  assert.deepEqual(got, [{ room: mine, wire: w }], 'the frame in the held range is read again, with covers, and not lost')
  assert.equal(reader.covers[mine].length, 7)
  for (const c of reader.covers[mine]) assert.ok(others.includes(c), 'covers come from the quiet traffic, not from the junk room')
  const fb = reader.stats().privacy.fallback
  assert.equal(fb.strikes, 1); assert.equal(fb.retryAt - fb.since, 60)
  // Under the budget but over half of it (1 log a block: 20 blocks a poll window, from 2 nodes, 40 against 50): no return yet
  // 低于预算但高于一半（每块 1 条：一个轮询窗口 20 块、2 个节点，共 40 条，预算 50）：还不回来
  const busy = post(others[1])
  for (let i = 0; i < 50; i++) { await busy.send(Uint8Array.of(0x02, i)); chain.mine(1) }
  clock.advance(70)                                      // past retryAt / 越过 retryAt
  await reader.poll(); await reader.poll()
  assert.equal(reader.mode, 'cover', 'hysteresis: it comes back only under half the budget')
  chain.mine(200); await reader.poll()                   // a quiet stretch is measured / 测到一段安静
  await reader.poll()
  assert.equal(reader.mode, 'contract')
  assert.match(warns.at(-1), /back to 'contract' mode/)
  const n = rec.asks.length
  chain.mine(1); await reader.poll()
  assert.deepEqual(roomAsks(rec.asks.slice(n)), [], 'back to naming no room')
  // Junk again right after coming back: it falls back again and waits twice as long / 刚回来又遇垃圾：再次降级，等待加倍
  for (let i = 0; i < 40; i++) await junk.send(Uint8Array.of(0x02, 100 + i))
  chain.mine(1)
  await reader.poll()
  const fb2 = reader.stats().privacy.fallback
  assert.equal(reader.mode, 'cover'); assert.equal(fb2.strikes, 2); assert.equal(fb2.retryAt - fb2.since, 120)
  // retryMs: null stays; setMode clears the fallback / retryMs: null 不回来；setMode 清除降级状态
  reader.setMode('contract')
  assert.equal(reader.stats().privacy.fallback, null)
  const stay = busPrivacyReader({ rpc, bus: BUS, rooms: [room()], fromBlock: start - 100, confirmations: 0, contract: { maxLogs: 50, retryMs: null }, warn: (m) => warns.push(m) })
  await stay.poll()
  assert.equal(stay.mode, 'cover'); assert.match(warns.at(-1), /stays in cover mode/)
  assert.equal(stay.stats().privacy.fallback.retryAt, null)
})
test(DEFAULT_TITLE, defaultScenario)
// FIXED P101-1: the scenario above failed now and then on a loaded machine (strikes 1 instead of 2: more than retryMs
// passed between coming back and falling back again). The same scenario on a clock running 50x fast must pass.
// FIXED P101-1：上面的场景在高负载机器上偶发失败（strikes 为 1 而不是 2：回来与再次降级之间过了超过 retryMs）。
// 同一场景在快 50 倍的时钟上必须通过。
test('FIXED P101-1: the fallback scenario does not depend on how busy the machine is', () => withClock(loadedMachine(50), defaultScenario))

test('plain mode is busReader exactly: one room, the single-room filter', async () => {
  const { chain, rec, rpc, post, start } = await world(5)
  const mine = room()
  const reader = busPrivacyReader({ rpc, bus: BUS, rooms: { [mine]: null }, mode: 'plain', fromBlock: start, confirmations: 0 })
  await post(mine).send(Uint8Array.of(0x02, 1)); chain.mine(1)
  assert.equal((await reader.poll()).length, 1)
  assert.ok(rec.asks.every((a) => a.topics.length === 2 && a.topics[1] === '0x' + mine), 'the room alone, as before')
  assert.equal(reader.stats().privacy.effectiveK, 1)
  assert.throws(() => busPrivacyReader({ rpc, bus: BUS, mode: 'stealth' }), (e) => e.code === 'BUS_PRIVACY')
  assert.throws(() => busPrivacyReader({ mode: 'cover', rpc, bus: BUS, cover: { k: 0 } }), /cover.k/)
  assert.throws(() => busPrivacyReader({ mode: 'cover', rpc, bus: BUS, contract: { onExceed: 'ignore' } }), /onExceed/)
  assert.throws(() => busPrivacyReader({ mode: 'cover', rpc, bus: BUS, cover: { maxTopics: 1024 } }), /maxTopics/)
  assert.throws(() => busPrivacyReader({ mode: 'cover', rpc: {}, bus: BUS }), /rpc client/)
})

test('maxTopics bounds each request: rooms beyond it get fewer covers, and the shortfall is reported', async () => {
  const { chain, rec, rpc } = await world(40)
  const mine = Array.from({ length: 5 }, room)
  const warns = []
  const reader = busPrivacyReader({ mode: 'cover', rpc, bus: BUS, rooms: mine, confirmations: 0, cover: { maxTopics: 24 }, warn: (m) => warns.push(m) })
  await reader.poll(); chain.mine(1); await reader.poll()
  for (const a of roomAsks(rec.asks)) assert.ok(roomsOf(a).length <= 24)
  assert.equal(reader.stats().privacy.short, true)
  assert.equal(warns.length, 1)
})

for (const mode of [undefined, 'cover']) test(`integration (${mode ?? 'default: contract'}): a whole TAP-26 channel where one side reads its inbox and channel room through busPrivacyReader and posts with busTransport`, async () => {
  const { chain, rec, rpc, start } = await world(30)
  const plain = createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch })
  const A = { container: '0x86DDaEF00401E3F10418398D67D7189fc458eA95', chainId: 56 }
  const B = { container: '0x19366c3c69ffeb3b286d9fa6cc5e616375baafd3', chainId: 56 }
  const a = channel.generateIdentity(), b = channel.generateIdentity()
  const inbox = channel.inboxRoom(B.container)
  const got = []
  // B: one cover reader for its inbox and, once invited, the channel room / B：一个掩护读者读收件房间，受邀后再加通道房间
  const readerB = busPrivacyReader({ ...(mode ? { mode } : {}), rpc, bus: BUS, rooms: [inbox], fromBlock: start, confirmations: 0, pollMs: 5, warn: quiet })
  // A: plain busTransport (A's own reading is not under test here) / A 用普通 busTransport
  const { invite, pending } = createInvite({ self: { ...A, staticSecret: a.x25519.secretKey }, peer: { ...B, staticPublic: b.x25519.publicKey }, bus: BUS })
  const rooms = channel.roomsFor(invite.cid)
  const busA = busTransport({ rpc: plain, bus: BUS, inbound: rooms.toInitiator, outbound: rooms.toResponder, sendTx: async (tx) => chain.submit(tx), fromBlock: start, confirmations: 0 })
  const toInbox = busTransport({ rpc: plain, bus: BUS, inbound: '00'.repeat(32), outbound: inbox, sendTx: async (tx) => chain.submit(tx) })
  const sendB = busTransport({ rpc: plain, bus: BUS, inbound: '00'.repeat(32), outbound: rooms.toInitiator, sendTx: async (tx) => chain.submit(tx) })
  await toInbox.send(channel.sealInvite(invite, { to: { ...B, staticPublic: b.x25519.publicKey } }))
  chain.mine(1)
  const [sealed] = await readerB.poll()
  assert.equal(sealed.room, inbox)
  const opened = channel.openInvite(sealed.wire, { self: { ...B, staticSecret: b.x25519.secretKey } })
  const { accept, session: bob } = acceptInvite({ self: { ...B, staticSecret: b.x25519.secretKey }, peer: { ...A, staticPublic: a.x25519.publicKey }, invite: opened })
  readerB.add(rooms.toResponder, (wire) => got.push(wire))
  await sendB.send(encodeWire(accept)); chain.mine(1)
  const { ready, session: alice } = completeInvite(pending, decodeWire((await busA.poll())[0]).handshake)
  await busA.sendMany([encodeWire(ready), encodeWire(alice.seal('hello over covers'))]); chain.mine(1)
  const errors = []
  readerB.start(undefined, { onError: (e) => errors.push(e) })
  for (let i = 0; i < 200 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 5))
  readerB.stop()
  assert.deepEqual(errors, [])
  assert.equal(got.length, 2)
  bob.confirm(decodeWire(got[0]).handshake)
  assert.equal(bob.open(decodeWire(got[1]).frame, { text: true }).data, 'hello over covers')
  // What the nodes saw from B: never the inbox or the channel room with fewer than k − 1 others
  // 节点从 B 那里看到的：收件房间与通道房间从不少于 k − 1 个同伴
  const mineRooms = new Set([inbox, rooms.toResponder])
  assert.equal(readerB.mode, mode ?? 'contract')
  if (!mode) assert.deepEqual(roomAsks(rec.asks), [], 'contract mode: no request names any room')
  for (const ask of roomAsks(rec.asks)) {
    const rs = roomsOf(ask), n = rs.filter((r) => mineRooms.has(r)).length
    assert.ok(n >= 1 && rs.length >= n * DEFAULT_COVER_K, `a request with ${n} of B's rooms among ${rs.length}`)
  }
})

test('the module and the guide sections use none of the ruled-out words ("anonymous", "untraceable", ...)', () => {
  const text = [
    readFileSync(new URL('../src/bus-privacy.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../types/bus-privacy.d.ts', import.meta.url), 'utf8'),
    section(readFileSync(new URL('../../docs/guides/channels.md', import.meta.url), 'utf8'), '## 5. Read privacy'),
    section(readFileSync(new URL('../../docs/guides/zh-CN/channels.md', import.meta.url), 'utf8'), '## 5. 读取隐私'),
  ]
  for (const t of text) { assert.ok(t.length > 500); assert.deepEqual(forbiddenIn(t), []) }
})
function section(md, heading) {
  const at = md.indexOf(heading)
  assert.ok(at >= 0, heading)
  const next = md.indexOf('\n## ', at + heading.length)
  return md.slice(at, next < 0 ? undefined : next)
}
