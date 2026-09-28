// Read privacy for ChannelBus (TAP-26 §3.7, §8): a thin wrapper around channel.busReader that makes each eth_getLogs
// say less about who is reading which rooms.
// ChannelBus 的读取隐私（TAP-26 §3.7、§8）：包在 channel.busReader 外面的一层薄封装，让每次 eth_getLogs 少透露"谁在读哪些房间"。
//
// The problem. busReader puts every room of a reader into one eth_getLogs (`topics: [Wire, [room1, room2, …]]`) and
// sends it to every node of the multi-node client (2 to 4 operators). Each node therefore sees "this IP reads these
// rooms", and an inbox room is derived from a container address (channel.inboxRoom), so the node can put an identity
// on the IP. channel.js is frozen; this module changes only what leaves the machine.
// 问题：busReader 把一个读者的所有房间放进同一次 eth_getLogs，并发给多节点客户端里的每一家节点（2 到 4 家运营方）。每家
// 节点都看到"这个 IP 在读这些房间"；收件房间由容器地址推导，节点因此能把身份对到 IP 上。channel.js 冻结；本模块只改变
// 发出去的内容。
//
// How. The reader hands busReader a wrapped rpc client. Every eth_getLogs the scanner sends goes through the wrapper,
// which rewrites the filter and filters the answer before the scanner sees it:
//   'contract' (default) the room topic is left out altogether (`topics: [Wire]`): every frame on the bus is downloaded
//              and filtered here. A node learns only "this IP reads ChannelBus". The download is bounded per poll
//              (`contract.maxBytes`, `contract.maxLogs`); over it, the reader falls back to 'cover' (or, with
//              `contract.onExceed: 'error'`, stops with BUS_BUDGET), and always says so. It needs no cover pool, so the
//              first poll waits for no pool scan. Default since 2026-09-28: the bus then carried one log in 500,000
//              blocks, so cover rooms had no pool to come from while a contract-wide read cost almost nothing.
//   'cover'    each of your rooms is sent together with k−1 cover rooms: real rooms other people used on this
//              bus (read from its recent logs), shuffled into a fresh random order on every request. A node sees k
//              candidates per room of yours and cannot tell which is yours from the request alone. Logs of cover
//              rooms are dropped inside the answer's projection, before the scanner parses them: never decoded, never
//              decrypted, never remembered.
//   'plain'    busReader exactly as before (the old behaviour, for comparison or debugging).
// Everything else (range splitting, the union across nodes, confirmations, overlap, reorg dedup, hold never skip) is
// busReader's own code, unchanged: covers are added to and removed from each request on the wire, so a catch-up read
// for a room added late carries that room's covers too.
// 做法：读者交给 busReader 的是一个包装过的 rpc 客户端。扫描器发出的每个 eth_getLogs 都经过包装层：改写过滤条件，并在
// 扫描器看到回答之前过滤回答。
//   'contract'（默认）完全不带房间 topic，下载总线上的全部帧、在本地过滤。节点只知道"这个 IP 在读 ChannelBus"。每次轮询的
//                    下载量有上限；超过时降级到 'cover'（或设 `contract.onExceed: 'error'` 时报 BUS_BUDGET 停下），并且一定会
//                    告知。它不需要掩护池，第一次轮询不必等池扫描。2026-09-28 起为默认：当时总线 500,000 个区块只有一条日志，
//                    掩护房间无从取材，而按合约读取几乎没有代价。
//   'cover'          你的每个房间都与 k−1 个掩护房间一起发出：掩护是别人在这条总线上真实用过的房间（取自近期日志），每次
//                    请求都重新随机排序。节点对你的每个房间看到 k 个候选，单凭请求分不出哪个是你的。掩护房间的日志在回答
//                    的投影阶段、扫描器解析之前就被丢弃：从不解码、从不解密、从不记住。
//   'plain'          与原来的 busReader 完全一样（旧行为，用于对照或调试）。
// 其余一切（区间拆分、跨节点并集、确认数、重叠、重组去重、宁停不跳）都是 busReader 自己的代码，不变：掩护是在线路上逐次
// 加上、去掉的，所以后加入房间的补读请求也带着它的掩护。
//
// Falling back and coming back (contract.retryMs). A reader that fell back to 'cover' because of the budget returns to
// 'contract' by itself, with hysteresis: it leaves above the budget and comes back only when (1) it has stayed in
// 'cover' for retryMs (default 30 min), doubled each time it had to fall back again within that time after returning
// (at most 24 h), and (2) the latest pool refresh after the fallback (address-only reads of the new blocks, which
// 'cover' mode does anyway) finished within its byte budget and shows the traffic of a poll's window at or under HALF
// the budget. Why come back at all: 'contract' names no room, 'cover' names k per room of yours, so staying in 'cover'
// after the junk has passed gives away more for nothing. Why the switching itself costs little: the covers are drawn
// once and kept, so every stretch in 'cover' shows the same k-sets and a flip back and forth reveals nothing new about
// your rooms; what it shows is that the reader follows the bus's load, which every default reader does at the same
// moments. The doubling bounds what a spammer who keeps the bus near the budget can make a reader re-download (one
// budget per try). Covers drawn at the fallback come first from rooms seen in quiet 'contract' polls, not from the
// junk that caused it: a spammer's own rooms are the covers it would recognise. retryMs: null never comes back.
// 降级与恢复（contract.retryMs）。因预算降级到 'cover' 的读者会自动回到 'contract'，并带滞后：超过预算即离开，回来则须同时
// 满足：(1) 在 'cover' 里待满 retryMs（默认 30 分钟），若回来后不到这段时间又被迫降级，下次加倍（至多 24 小时）；(2) 降级后
// 最近一次池刷新（对新区块的只带地址读取，'cover' 模式本来就做）在字节预算内完成，且按一次轮询的窗口估算的流量不超过预算的
// 一半。为什么要回来：'contract' 不写明任何房间，'cover' 为你的每个房间写明 k 个，垃圾过去后还留在 'cover' 是白白多暴露。
// 为什么来回切换本身代价小：掩护只抽一次、保持不变，每段 'cover' 显示的都是同样的 k 组，来回切换不会多透露你的房间；它显示的
// 只是读者跟随总线负载，而所有默认读者都在同一时刻这样做。加倍限制了把总线维持在预算附近的灌垃圾者能迫使读者重复下载的量
// （每次尝试一份预算）。降级时抽取的掩护优先来自安静的 'contract' 轮询里见过的房间，而不是引起降级的垃圾：灌垃圾者自己的房间
// 正是它认得出的掩护。retryMs: null 表示不再回来。
//
// Why k = 8 by default (DEFAULT_COVER_K). Measured 2026-09-28 on the BUS_RPC_URLS nodes: an OR over 256 room topics was
// accepted by 48 Club and 1RPC, 1,024 was refused ("exceed max topics"), so topics are capped at 128 per request
// (MAX_COVER_TOPICS), which leaves room for 16 rooms of yours at k = 8. The cost grows linearly: you download the
// frames of k−1 other rooms per room of yours, and the pool must hold (k−1) rooms per room of yours. The gain flattens:
// 1/8 is the best guess a node gets from one request, against 1 today, and the attacks cover rooms cannot stop (an
// invite followed by a new room, a node that links sessions; see below) do not get better with a larger k. 4 leaves a
// 25 % guess; 16 doubles the traffic and the pool needed for a guess of 6 %.
// 为什么默认 k = 8：2026-09-28 实测，BUS_RPC_URLS 的 48 Club 与 1RPC 接受 256 个房间 topic 的"或"，1,024 个被拒（"exceed max
// topics"），因此每次请求的 topic 上限定为 128，k = 8 时可容纳你的 16 个房间。成本线性增长：你的每个房间要多下载 k−1 个别人
// 房间的帧，掩护池也要为你的每个房间准备 k−1 个房间。收益递减：单次请求里节点的最好猜测是 1/8（现在是 1）；掩护房间挡不住
// 的攻击（邀请之后新增房间、节点把会话连起来，见下）也不会因为 k 更大而变好。k = 4 猜中率 25%；k = 16 流量和池子翻倍，只换来 6%。
//
// Where covers come from, and why they stay put. The pool is the set of room topics seen in the bus's logs over the
// last `cover.scanBlocks` blocks (default 40,000, about 5 hours at 0.45 s a block), read with address-only queries
// (`topics: [Wire]`, which name no room), newest first, within a byte budget, plus any rooms the caller supplies in
// `cover.pool` (for example channel.inboxRoom() of containers you know: an inbox room can be derived by anyone, so it is
// as plausible a room to read as yours). Topics that cannot be a sha256 output (five or more zero bytes, such as the
// ASCII deploy probe on mainnet) are left out. The pool is cached per rpc client and bus, shared by every reader on
// them, refreshed incrementally (only new blocks) every `cover.refreshMs`, and kept in `cover.store` when given.
// Cost, measured 2026-09-28: one request per 5,000 blocks (48 Club's cap), 3 to 6 s each, so a fresh process's first
// poll waits about 25 to 50 s for the default window; 1RPC takes 50 blocks per request, so without 48 Club the scan
// fails over to `cover.pool` alone, with a warning.
// 代价（2026-09-28 实测）：每 5,000 个区块一次请求（48 Club 上限），每次 3 到 6 秒，新进程第一次轮询按默认窗口要等约 25 到
// 50 秒；1RPC 每次只收 50 个区块，没有 48 Club 时扫描失败，只剩 `cover.pool`，并给出警告。
// Covers are drawn at random from the pool the first time a room of yours is read and then KEPT: for the whole life of
// the reader, and across restarts when `cover.store` is given. Rotating them would hurt: any two requests a node can
// link -- by IP, or simply because they share your rooms -- reveal their intersection, and if the covers change while
// your rooms do not, the intersection is exactly your rooms. So a cover is never replaced; a quiet cover is fine (most
// inbox rooms are quiet). "Rotation" happens only between sessions, and only when no store is kept. Covers are paired
// with the room they were drawn for and travel with it: a catch-up read of one room carries that room's covers (a
// subset of the main request, never a set that singles your other rooms out), removing a room removes its covers, and
// re-adding it brings the same covers back. A cover is never reused for another room of yours. When the pool was too
// small at first, covers are topped up later; those protect less (a node that saw the earlier requests knows they came
// later), but never weaken the ones already there.
// 掩护从哪里来、为什么不换：掩护池是最近 `cover.scanBlocks` 个区块（默认 40,000，按 0.45 秒一块约 5 小时）里这条总线日志
// 出现过的房间 topic，用只带合约地址与 Wire topic、不含任何房间的查询读取，从新到旧、有字节预算；再加上调用方在 `cover.pool`
// 里给的房间（例如已知容器的 channel.inboxRoom()：收件房间谁都能推导，读它和读你的房间一样说得通）。不可能是 sha256 输出的
// topic（五个及以上零字节，例如主网上的 ASCII 部署探针）被排除。池子按 rpc 客户端与总线缓存、由其上所有读者共享，每
// `cover.refreshMs` 增量刷新（只读新区块），给了 `cover.store` 时还会保存下来。
// 掩护在你的某个房间第一次被读取时从池里随机抽取，然后保持不变：在读者整个生命周期内不变，给了 `cover.store` 时重启后也
// 不变。轮换反而有害：节点能关联起来的任何两次请求（同一 IP，或者只因为都含有你的房间）会暴露它们的交集；掩护变了而你的
// 房间没变，交集恰好就是你的房间。所以掩护从不替换；安静的掩护没关系（大多数收件房间本来就安静）。"轮换"只发生在两次会话
// 之间，而且只在不保存状态时发生。掩护与为之抽取的房间配对、同进同出：某个房间的补读带着它自己的掩护（是主请求的子集，
// 不会把你的其它房间单独挑出来）；移除房间时掩护一起移除，再加回来时还是同一组掩护。掩护不会被你的另一个房间再用。
// 池子起初太小时，之后会补足掩护；后补的保护较弱（看过早先请求的节点知道它们是后来的），但不会削弱已有的掩护。
//
// What this does not stop (docs/guides/channels.md, "Read privacy"):
//   - An invite arrives in a room, and soon after the reader adds a new room: a node sees which of your rooms got a
//     frame just before the new group appeared, and links the two. Pre-registering spare rooms or adding rooms after
//     a random delay makes this harder, never impossible.
//   - The pool's source leaks too. The rule is public, so a room you read that is not in the recent-activity pool
//     stands out; a node that lies during the pool scan can plant rooms it knows are fake; anyone can fill the pool
//     with rooms of their own for about 50,000 gas each, and every cover drawn from those is known to them.
//   - A node that sees requests with and without a given room (sessions of the same rooms, days apart, with new covers)
//     intersects them: keep `cover.store`.
//   - 'contract' mode downloads every frame on the bus: anyone who posts junk frames makes every such reader download
//     them (100 USD of gas is about 100 MB); hence the budget.
//   - Timing, IP address and request volume are not hidden; the pool scan and 'contract' mode say "this IP reads
//     ChannelBus"; a node you run yourself sees nothing new at all.
// 挡不住的：邀请到达后新增的房间会暴露关联；掩护池的来源本身会泄露信息（规则公开，不在近期活跃池里的房间显眼；扫描时撒谎
// 的节点可以塞进它知道是假的房间；任何人都能以每个约 50,000 gas 的代价往池里灌自己的房间）；节点把带与不带某房间的请求
// 取交集（请保存 `cover.store`）；'contract' 模式会被垃圾帧逼着下载大量数据（因此有预算）；时间、IP 与请求量不隐藏。
import { randomBytes } from '@noble/hashes/utils'
import { TapeAPIError } from './errors.js'
import { isAddress } from './abi.js'
import { busReader, CHANNELBUS_WIRE_TOPIC } from './channel.js'

export const BUS_PRIVACY_MODES = Object.freeze(['cover', 'contract', 'plain'])
export const DEFAULT_COVER_K = 8
export const MAX_COVER_TOPICS = 128              // per request; nodes accept 256, refuse 1,024 (measured 2026-09-28) / 每次请求的上限
export const DEFAULT_POOL_BLOCKS = 40_000        // about 5 hours of BSC / 约 5 小时
export const DEFAULT_POOL_SPAN = 5_000           // 48 Club's cap per eth_getLogs ("exceed maximum block range: 5000") / 48 Club 的单次上限
export const DEFAULT_POOL_BYTES = 8 * 1024 * 1024
export const DEFAULT_POOL_REFRESH_MS = 10 * 60_000
export const POOL_MAX_ROOMS = 4096
export const DEFAULT_CONTRACT_BUDGET = Object.freeze({ maxBytes: 8 * 1024 * 1024, maxLogs: 10_000 })
export const DEFAULT_CONTRACT_RETRY_MS = 30 * 60_000
export const MAX_CONTRACT_RETRY_MS = 24 * 3600_000
const MIN_POOL_SPAN = 500                        // below this a pool scan is not worth it on that node / 低于此跨度就换节点
const STORE_ROOMS_MAX = 256                      // rooms whose covers a store keeps / 存储保留掩护的房间数
const STORE_VERSION = 1

const ROOM = /^[0-9a-f]{64}$/
const TOPIC = /^0x[0-9a-fA-F]{64}$/
const fail = (msg, extra) => { throw new TapeAPIError('BUS_PRIVACY', msg, extra) }
const hexN = (n) => '0x' + n.toString(16)
const say = (warn, msg, data) => { try { (warn || console.warn)(msg, data) } catch { /* a warning never breaks a read / 警告不影响读取 */ } }
const sleep = (ms, signal) => new Promise((r) => {   // as channel.js / 与 channel.js 相同
  const t = setTimeout(r, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true })
})

/** A room id that can be a sha256 output: at most four zero bytes (random 32 bytes have five or more with p ≈ 2e-7). */
export function plausibleRoom(room) {
  if (typeof room !== 'string' || !ROOM.test(room)) return false
  let zeros = 0
  for (let i = 0; i < 64; i += 2) if (room[i] === '0' && room[i + 1] === '0') zeros++
  return zeros <= 4
}
// Roughly what a log costs on the wire as JSON: its data in hex plus the fixed fields. / 一条日志在线路上大致的 JSON 字节数
const logBytes = (l) => String(l?.data ?? '').length + 66 * (Array.isArray(l?.topics) ? l.topics.length : 0) + 360

// A uniform index below n from `random` (rejection sampling) / 用 random 取 [0, n) 上的均匀整数（拒绝采样）
function uniform(random, n) {
  if (n <= 1) return 0
  const limit = Math.floor(0x1_0000_0000 / n) * n
  for (;;) {
    const b = random(4)
    const x = ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3]
    if (x < limit) return x % n
  }
}
function shuffle(xs, random) {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) { const j = uniform(random, i + 1); [a[i], a[j]] = [a[j], a[i]] }
  return a
}

function checkRpc(rpc, bus) {
  if (!rpc || typeof rpc.call !== 'function' || typeof rpc.blockNumber !== 'function') fail('bus privacy needs a multi-node rpc client (createRpc / api.rpc)')
  if (!isAddress(bus)) fail('bus must be a ChannelBus contract address')
}
const nodesOf = (rpc) => (typeof rpc.single === 'function' && Array.isArray(rpc.urls) ? rpc.urls.map((u) => rpc.single(u)) : [rpc])
const tooWide = (e) => e?.data?.tooLarge === true || /range|limit|exceed|too many|too large|more than|max results/i.test([e?.message, ...(e?.refusals || []).map((r) => r?.message)].join(' '))

/**
 * scanCoverPool({ rpc, bus, blocks, span, maxBytes, since, head }) -> { from, to, rooms: [[room, lastBlock]], logs, bytes, complete }
 * The rooms seen in the bus's Wire logs over the last `blocks` blocks (or after `since`), newest first, read with
 * address-only queries (no room in them) from the first node that serves them. `span` is halved on a range refusal
 * down to 500 blocks, then the next node is tried. Stops early, `complete: false`, once `maxBytes` were downloaded
 * (anyone can fill the bus with junk). Rooms that cannot be a sha256 output are left out.
 * 最近 `blocks` 个区块（或 `since` 之后）总线 Wire 日志里出现过的房间，从新到旧，用不含房间的查询从第一个能提供的节点读取。
 * 区间被拒时跨度减半，低于 500 块就换下一个节点。下载满 `maxBytes` 即提前停止（`complete: false`）：任何人都能往总线灌垃圾。
 */
export async function scanCoverPool({ rpc, bus, blocks = DEFAULT_POOL_BLOCKS, span = DEFAULT_POOL_SPAN, maxBytes = DEFAULT_POOL_BYTES, since = null, head } = {}) {
  checkRpc(rpc, bus)
  if (!(Number.isInteger(blocks) && blocks >= 0)) fail('cover.scanBlocks must be a non-negative integer')
  if (!(Number.isInteger(span) && span >= 1)) fail('cover.scanSpan must be a positive integer')
  if (!(Number.isInteger(maxBytes) && maxBytes > 0)) fail('cover.scanBytes must be a positive number of bytes')
  const top = head ?? await rpc.blockNumber()
  const lo = Math.max(0, top - blocks + 1, since === null || since === undefined ? 0 : since + 1)
  const empty = { from: lo, to: top, rooms: [], logs: 0, bytes: 0, complete: true }
  if (blocks === 0 || lo > top) return empty
  const project = (logs) => {
    if (!Array.isArray(logs)) throw new Error('eth_getLogs did not return an array')
    return logs.map((l) => ({
      room: Array.isArray(l?.topics) && TOPIC.test(String(l.topics[1])) && String(l.topics[0]).toLowerCase() === CHANNELBUS_WIRE_TOPIC && String(l.address ?? bus).toLowerCase() === bus.toLowerCase() ? l.topics[1].slice(2).toLowerCase() : null,
      block: Number(BigInt(l.blockNumber)), bytes: logBytes(l),
    }))
  }
  let lastError = null
  for (const node of nodesOf(rpc)) {
    const rooms = new Map()
    let s = Math.min(span, top - lo + 1), hi = top, logs = 0, bytes = 0, ok = true
    while (hi >= lo) {
      const x = Math.max(lo, hi - s + 1)
      let got
      try { got = await node.call('eth_getLogs', [{ address: bus, topics: [CHANNELBUS_WIRE_TOPIC], fromBlock: hexN(x), toBlock: hexN(hi) }], { project }) } catch (e) {
        if (tooWide(e) && s > MIN_POOL_SPAN) { s = Math.max(MIN_POOL_SPAN, Math.ceil(s / 2)); continue }
        lastError = e; ok = false; break
      }
      for (const l of got) {
        logs++; bytes += l.bytes
        if (l.block < x || l.block > hi || !plausibleRoom(l.room)) continue
        rooms.set(l.room, Math.max(rooms.get(l.room) ?? 0, l.block))
      }
      hi = x - 1
      if (bytes > maxBytes) return { from: x, to: top, rooms: [...rooms], logs, bytes, complete: false }
    }
    if (ok) return { from: lo, to: top, rooms: [...rooms], logs, bytes, complete: true }
  }
  throw new TapeAPIError('BUS_PRIVACY', `no node served the cover pool scan (address-only eth_getLogs): ${lastError?.message ?? lastError}`, { cause: lastError })
}

// Pools shared by the readers of one rpc client and bus: rpc -> bus -> { from, to, rooms: Map(room -> last), at, loading }
// 同一 rpc 客户端与总线上的读者共享的池
const POOLS = new WeakMap()
const poolOf = (rpc, bus) => {
  let m = POOLS.get(rpc)
  if (!m) { m = new Map(); POOLS.set(rpc, m) }
  const k = bus.toLowerCase()
  // quiet: rooms seen in 'contract' polls that stayed within budget; last: the latest refresh scan's size (for coming back)
  // quiet：预算内的 'contract' 轮询里见过的房间；last：最近一次刷新扫描的规模（用于判断能否回到 'contract'）
  if (!m.has(k)) m.set(k, { from: null, to: null, rooms: new Map(), quiet: new Set(), at: 0, loading: null, complete: true, last: null })
  return m.get(k)
}

function checkOptions({ mode, cover, contract }) {
  if (!BUS_PRIVACY_MODES.includes(mode)) fail(`mode must be one of ${BUS_PRIVACY_MODES.join(', ')}`)
  if (cover === null || typeof cover !== 'object') fail('cover must be an object')
  if (contract === null || typeof contract !== 'object') fail('contract must be an object')
  const c = {
    k: cover.k ?? DEFAULT_COVER_K, pool: cover.pool, scanBlocks: cover.scanBlocks ?? DEFAULT_POOL_BLOCKS, scanSpan: cover.scanSpan ?? DEFAULT_POOL_SPAN,
    scanBytes: cover.scanBytes ?? DEFAULT_POOL_BYTES, refreshMs: cover.refreshMs ?? DEFAULT_POOL_REFRESH_MS, maxTopics: cover.maxTopics ?? MAX_COVER_TOPICS,
    onShort: cover.onShort ?? 'warn', store: cover.store, random: cover.random ?? randomBytes,
  }
  if (!(Number.isInteger(c.k) && c.k >= 1 && c.k <= 64)) fail('cover.k must be an integer from 1 to 64')
  if (!(c.pool === undefined || Array.isArray(c.pool) || typeof c.pool === 'function')) fail('cover.pool must be an array of room ids or a function returning one')
  if (!(Number.isInteger(c.scanBlocks) && c.scanBlocks >= 0)) fail('cover.scanBlocks must be a non-negative integer')
  if (!(Number.isInteger(c.scanSpan) && c.scanSpan >= 1)) fail('cover.scanSpan must be a positive integer')
  if (!(Number.isInteger(c.scanBytes) && c.scanBytes > 0)) fail('cover.scanBytes must be a positive number of bytes')
  if (!(typeof c.refreshMs === 'number' && c.refreshMs >= 0)) fail('cover.refreshMs must be a non-negative number of milliseconds')
  if (!(Number.isInteger(c.maxTopics) && c.maxTopics >= 1 && c.maxTopics <= 1000)) fail('cover.maxTopics must be an integer from 1 to 1000 (nodes refuse more)')
  if (!['warn', 'error'].includes(c.onShort)) fail("cover.onShort must be 'warn' or 'error'")
  if (c.store !== undefined && !(c.store && typeof c.store.get === 'function' && typeof c.store.set === 'function')) fail('cover.store must have get(key) and set(key, value)')
  if (typeof c.random !== 'function') fail('cover.random must be a function returning random bytes')
  const b = {
    maxBytes: contract.maxBytes ?? DEFAULT_CONTRACT_BUDGET.maxBytes, maxLogs: contract.maxLogs ?? DEFAULT_CONTRACT_BUDGET.maxLogs,
    onExceed: contract.onExceed ?? 'cover', retryMs: contract.retryMs === undefined ? DEFAULT_CONTRACT_RETRY_MS : contract.retryMs,
  }
  if (!(Number.isInteger(b.maxBytes) && b.maxBytes > 0)) fail('contract.maxBytes must be a positive number of bytes')
  if (!(Number.isInteger(b.maxLogs) && b.maxLogs > 0)) fail('contract.maxLogs must be a positive integer')
  if (!['error', 'cover'].includes(b.onExceed)) fail("contract.onExceed must be 'error' or 'cover'")
  if (!(b.retryMs === null || (typeof b.retryMs === 'number' && b.retryMs >= 0))) fail('contract.retryMs must be a non-negative number of milliseconds, or null (never come back)')
  return { c, b }
}

/**
 * busPrivacyReader({ rpc, bus, rooms, mode, cover, contract, warn, ...busReader options })
 *   The options and the result are busReader's (fromBlock, lookback, confirmations, overlap, pollMs, chunk, minChunk,
 *   budgetMs, verdictMs, startGraceMs, blockBodyLimit; add, remove, poll, start, stop, rooms, catchingUp, cursor,
 *   oldestServed, stats), plus:
 *   mode      'contract' (default) | 'cover' | 'plain'
 *   cover     { k = 8, pool, scanBlocks = 40000, scanSpan = 5000, scanBytes = 8 MiB, refreshMs = 10 min, maxTopics = 128,
 *               onShort = 'warn' | 'error', store, random }
 *             pool: extra room ids (an array, or a function returning one, sync or async) merged with the chain scan
 *             (scanBlocks: 0 turns the scan off). onShort: what happens when the pool cannot give every room of yours
 *             k−1 covers: 'warn' reads with what there is and says so (to `warn`, once per change, and in
 *             stats().privacy); 'error' throws BUS_PRIVACY before anything is sent. store: any { get(key), set(key,
 *             value) }, sync or async, that keeps the pool and the covers across restarts (strongly advised).
 *   contract  { maxBytes = 8 MiB, maxLogs = 10000, onExceed = 'cover' | 'error', retryMs = 30 min | null }: the download
 *             allowed per poll in 'contract' mode. Over it, 'cover' (default) switches to 'cover' mode and warns, and
 *             comes back to 'contract' by itself as described above (retryMs: null never does); 'error' stops the
 *             reader (every poll throws BUS_BUDGET, without touching the network, until setMode() is called). Frames
 *             read before the limit are handed over either way. Never silent.
 *   setMode(mode)  switch mode at run time (also clears a BUS_BUDGET stop and a pending automatic return)
 *   covers         { ownRoom: [coverRoom, …] } in use (for inspection; the node sees them anyway)
 *   stats().privacy  { mode, k, effectiveK, short, rooms, covers, pool, poolFrom, poolTo, requests, dropped, lastPoll, downloaded,
 *                      stopped, fallback: null | { since, strikes, retryAt } }
 * 参数与返回值同 busReader，另加 mode、cover、contract、setMode、covers 与 stats().privacy。
 */
export function busPrivacyReader({ rpc, bus, rooms = [], mode = 'contract', cover = {}, contract = {}, warn, pollMs = 1500, ...readerOpts } = {}) {
  checkRpc(rpc, bus)
  if (warn !== undefined && typeof warn !== 'function') fail('warn must be a function')
  const { c, b } = checkOptions({ mode, cover, contract })
  const random = c.random
  const pool = poolOf(rpc, bus)
  const storeKey = `tapeapi:bus-privacy:v${STORE_VERSION}:${bus.toLowerCase()}`

  // State / 状态
  const handlers = new Map()          // own room -> handler | null / 自己的房间 -> 处理器
  const assigned = new Map()          // own room -> [cover rooms], this reader / 本读者：自己的房间 -> 掩护
  const embedded = new Set()          // own rooms that are covers of another own room / 本身是你另一房间掩护的房间
  let kept = new Map()                // own room -> [cover rooms], remembered (store), incl. rooms removed for now / 记住的配对
  let storeLoaded = false, dirty = false
  let prepared = null                 // the prepare() in flight / 进行中的 prepare()
  let lastShortK = null
  const counters = { requests: 0, dropped: 0, bytes: 0, logs: 0 }
  let pollUse = { bytes: 0, logs: 0 }
  let over = null                     // this poll went over the contract budget / 本次轮询超出预算
  let stopped = null                  // BUS_BUDGET error that stops the reader (onExceed 'error') / 使读者停下的错误
  let fallback = null                 // { since, strikes, retryAt }: fell back to 'cover' over the budget / 因预算降级
  let returnedAt = null, returnedBackoff = 0   // the last automatic return, and the wait before it / 上次自动恢复及其前的等待
  let pollRooms = new Map(), pollRange = null  // rooms seen in this 'contract' poll, and the blocks it read / 本次 'contract' 轮询见到的房间与区块
  const ownSet = () => new Set(handlers.keys())
  const activeCovers = () => { const s = new Set(); for (const cs of assigned.values()) for (const x of cs) s.add(x); return s }
  const reserved = () => { const s = activeCovers(); for (const cs of kept.values()) for (const x of cs) s.add(x); return s }

  // ---- the pool / 掩护池
  // The caller's pool, asked again at most every refreshMs (it may be a network lookup) / 调用方的池，至多每 refreshMs 问一次
  let callerCache = null, callerAt = 0
  async function callerPool() {
    if (c.pool === undefined) return []
    if (callerCache && Date.now() - callerAt < c.refreshMs) return callerCache
    let got
    try { got = typeof c.pool === 'function' ? await c.pool() : c.pool } catch (e) { say(warn, `[tapeapi] bus privacy: cover.pool failed (${e?.message ?? e}); using the chain scan alone.`, { error: e }); got = [] }
    if (!Array.isArray(got)) { say(warn, '[tapeapi] bus privacy: cover.pool gave no array of room ids; using the chain scan alone.'); got = [] }
    callerCache = got.map((r) => String(r).replace(/^0x/, '').toLowerCase()).filter(plausibleRoom); callerAt = Date.now()
    return callerCache
  }
  async function refreshPool() {
    if (c.scanBlocks === 0) return
    if (pool.loading) return pool.loading
    if (pool.to !== null && Date.now() - pool.at < c.refreshMs) return
    pool.loading = (async () => {
      try {
        const head = await rpc.blockNumber()
        const since = pool.to !== null && pool.to >= head - c.scanBlocks ? pool.to : null
        const got = await scanCoverPool({ rpc, bus, blocks: c.scanBlocks, span: c.scanSpan, maxBytes: c.scanBytes, since, head })
        if (since === null) pool.rooms = new Map()
        for (const [r, last] of got.rooms) pool.rooms.set(r, Math.max(pool.rooms.get(r) ?? 0, last))
        const floor = head - c.scanBlocks + 1
        for (const [r, last] of pool.rooms) if (last < floor) pool.rooms.delete(r)
        if (pool.rooms.size > POOL_MAX_ROOMS) pool.rooms = new Map([...pool.rooms].sort((x, y) => y[1] - x[1]).slice(0, POOL_MAX_ROOMS))
        for (const r of pool.quiet) if (!pool.rooms.has(r)) pool.quiet.delete(r)
        if (got.to >= got.from) pool.last = { at: Date.now(), blocks: got.to - got.from + 1, bytes: got.bytes, logs: got.logs, complete: got.complete }
        pool.from = since === null ? got.from : Math.max(pool.from ?? got.from, floor)
        pool.to = head; pool.at = Date.now(); pool.complete = got.complete
        if (!got.complete) say(warn, `[tapeapi] bus privacy: the cover pool scan of ${bus} stopped after ${got.bytes} bytes (cover.scanBytes); it covers blocks ${got.from}..${head} only. Someone may be filling the bus with junk frames.`, { from: got.from, to: head, bytes: got.bytes })
        dirty = true
      } catch (e) {
        pool.at = Date.now()   // do not rescan every poll after a failure / 失败后不每次轮询都重扫
        say(warn, `[tapeapi] bus privacy: could not read the cover pool (${e?.message ?? e}); covers come from cover.pool only until the next refresh.`, { error: e })
      } finally { pool.loading = null }
    })()
    return pool.loading
  }

  // ---- the store (optional): the pool and the covers across restarts / 存储（可选）：跨重启保存池与掩护
  async function loadStore() {
    if (storeLoaded || !c.store) { storeLoaded = true; return }
    storeLoaded = true
    let v
    try { v = await c.store.get(storeKey) } catch (e) { say(warn, `[tapeapi] bus privacy: cover.store.get failed (${e?.message ?? e}); covers are drawn afresh.`, { error: e }); return }
    if (!v || typeof v !== 'object' || v.v !== STORE_VERSION) return
    if (v.covers && typeof v.covers === 'object') {
      for (const [r, cs] of Object.entries(v.covers)) {
        if (!ROOM.test(r) || !Array.isArray(cs)) continue
        const ok = cs.filter((x) => typeof x === 'string' && ROOM.test(x) && x !== r)
        if (!kept.has(r)) kept.set(r, ok)
      }
    }
    const p = v.pool
    if (p && Number.isInteger(p.to) && Number.isInteger(p.from) && Array.isArray(p.rooms) && (pool.to === null || p.to > pool.to)) {
      pool.rooms = new Map(p.rooms.filter((x) => Array.isArray(x) && plausibleRoom(x[0]) && Number.isInteger(x[1])).map(([r, n]) => [r, n]))
      pool.from = p.from; pool.to = p.to; pool.at = Number.isFinite(p.at) ? Math.min(p.at, Date.now()) : 0; pool.complete = p.complete !== false
      pool.quiet = new Set(Array.isArray(p.quiet) ? p.quiet.filter((r) => pool.rooms.has(r)) : [])
    }
  }
  async function saveStore() {
    if (!c.store || !dirty) return
    dirty = false
    // Rooms read now first, then the most recent others / 先存正在读的房间，再存其余的
    const order = [...new Set([...handlers.keys(), ...kept.keys()])].filter((r) => kept.has(r)).slice(0, STORE_ROOMS_MAX)
    const value = {
      v: STORE_VERSION,
      covers: Object.fromEntries(order.map((r) => [r, kept.get(r)])),
      pool: pool.to === null ? null : { from: pool.from, to: pool.to, at: pool.at, complete: pool.complete, rooms: [...pool.rooms], quiet: [...pool.quiet] },
    }
    try { await c.store.set(storeKey, value) } catch (e) { say(warn, `[tapeapi] bus privacy: cover.store.set failed (${e?.message ?? e}); covers may change after a restart, which lets a node intersect sessions.`, { error: e }) }
  }

  // ---- covers / 掩护
  // Covers for `room`: the ones it had (this reader or the store), topped up from the pool while short, never taking a
  // room of yours, a cover in use or one kept for another room. A room that is itself a cover of another room of
  // yours (its host) draws no new covers: its group is the host's, the host and the host's other covers, rooms the
  // nodes already see together, so even its catch-up read alone goes out among them.
  // 为 `room` 取掩护：沿用它原有的（本读者或存储里的），不足时从池里补足；绝不取你自己的房间、正在用的掩护或为别的房间保留的
  // 掩护。本身就是你另一个房间（宿主）掩护的房间不抽新掩护：它的组就是宿主的组（宿主与宿主的其它掩护，节点本来就看到它们
  // 在一起），所以它单独补读时也混在其中发出。
  function coverFor(room, fresh) {
    const own = ownSet()
    const inUse = new Set(); for (const [r, cs] of assigned) if (r !== room && !embedded.has(r)) for (const x of cs) inUse.add(x)
    if (inUse.has(room)) {
      const [host, hcs] = [...assigned].find(([r, cs]) => r !== room && !embedded.has(r) && cs.includes(room))
      assigned.set(room, [host, ...hcs.filter((x) => x !== room)])
      embedded.add(room)
      return
    }
    embedded.delete(room)
    let cs = (assigned.get(room) ?? kept.get(room) ?? []).filter((x) => !own.has(x) && !inUse.has(x))
    const want = c.k - 1
    if (cs.length < want) {
      const taken = reserved()
      // Topic slots left under maxTopics: every room of yours, the other rooms' covers, and this room's own / 余下的 topic 名额
      const slots = c.maxTopics - handlers.size - inUse.size - cs.length
      const n = Math.max(0, Math.min(want - cs.length, slots))
      const candidates = fresh.filter((x) => !own.has(x) && !taken.has(x) && !cs.includes(x) && x !== room)
      // Rooms seen in quiet 'contract' polls first: after a fallback, the junk that caused it is not where covers come from
      // 先取安静的 'contract' 轮询里见过的房间：降级之后，掩护不从引起降级的垃圾里来
      const quiet = candidates.filter((x) => pool.quiet.has(x)), rest = candidates.filter((x) => !pool.quiet.has(x))
      cs = [...cs, ...[...shuffle(quiet, random), ...shuffle(rest, random)].slice(0, n)]
    }
    assigned.set(room, cs)
    const k0 = kept.get(room)
    if (!k0 || k0.length !== cs.length || k0.some((x, i) => x !== cs[i])) { kept.set(room, cs); dirty = true }
  }
  const effectiveK = () => (handlers.size ? Math.min(...[...handlers.keys()].map((r) => 1 + (assigned.get(r)?.length ?? 0))) : c.k)

  // Before any request goes out: the pool loaded, covers assigned for every room of yours, the shortfall reported.
  // 任何请求发出之前：池已加载、你的每个房间都已分到掩护、不足已报告。
  async function prepare() {
    if (mode !== 'cover') return
    await loadStore()
    await refreshPool()
    const fresh = [...new Set([...[...pool.rooms].sort((x, y) => y[1] - x[1]).map(([r]) => r), ...await callerPool()])]
    for (const r of handlers.keys()) {
      const have = assigned.get(r)
      if (!have || have.length < c.k - 1) coverFor(r, fresh)
    }
    await saveStore()
    const e = effectiveK()
    if (handlers.size && e < c.k) {
      const msg = e === 1
        ? `[tapeapi] bus privacy: no cover rooms available (pool: ${pool.rooms.size} rooms from blocks ${pool.from ?? '-'}..${pool.to ?? '-'}), so the nodes see exactly which rooms this reader reads. Pass cover.pool (for example channel.inboxRoom() of containers you know), use mode 'contract', or accept it.`
        : `[tapeapi] bus privacy: only ${e - 1} cover rooms for some of your rooms (target k = ${c.k}): a node's best guess is 1 in ${e}, not 1 in ${c.k}. Pool: ${pool.rooms.size} rooms. Pass cover.pool, lower cover.k, or use mode 'contract'.`
      if (c.onShort === 'error') throw new TapeAPIError('BUS_PRIVACY', msg, { effectiveK: e, k: c.k, pool: pool.rooms.size })
      if (lastShortK !== e) { lastShortK = e; say(warn, msg, { effectiveK: e, k: c.k, pool: pool.rooms.size }) }
    } else lastShortK = null
  }
  const ready = () => (prepared ??= prepare().finally(() => { prepared = null }))

  // ---- the wire: what each node is asked, and what the scanner is shown / 线路：问节点什么、给扫描器看什么
  // Only logs of the rooms asked for, with a well-formed room topic, reach the scanner's own projection (logFacts): a
  // log without topics cannot be told from a cover's and is dropped (the scanner would otherwise give it to a lone room).
  // 只有所问房间、且房间 topic 格式正确的日志才进入扫描器自己的投影；没有 topics 的日志分不清是不是掩护的，丢弃。
  const keepOwn = (logs, own, project) => {
    if (!Array.isArray(logs)) return project ? project(logs) : logs
    const out = logs.filter((l) => Array.isArray(l?.topics) && TOPIC.test(String(l.topics[1])) && own.has(l.topics[1].slice(2).toLowerCase()))
    counters.dropped += logs.length - out.length
    return project ? project(out) : out
  }
  const account = (logs) => {
    let n = 0, bytes = 0
    for (const l of logs) { n++; bytes += logBytes(l) }
    counters.logs += n; counters.bytes += bytes; pollUse.logs += n; pollUse.bytes += bytes
    if (mode === 'contract' && !over && (pollUse.bytes > b.maxBytes || pollUse.logs > b.maxLogs)) over = { ...pollUse }
  }
  // Rooms a 'contract' read saw anyway: they feed the cover pool at no cost, once the poll stayed within budget.
  // 'contract' 读取顺便看到的房间：本次轮询没超预算时，零成本地补进掩护池。
  const seen = (logs, x, y) => {
    for (const l of logs) {
      const r = Array.isArray(l?.topics) && TOPIC.test(String(l.topics[1])) ? l.topics[1].slice(2).toLowerCase() : null
      let n; try { n = Number(BigInt(l.blockNumber)) } catch { continue }
      if (r && plausibleRoom(r) && n >= x && n <= y) pollRooms.set(r, Math.max(pollRooms.get(r) ?? 0, n))
    }
  }
  const budgetError = (u) => new TapeAPIError('BUS_BUDGET', `[tapeapi] bus privacy: 'contract' mode downloaded ${u.bytes} bytes / ${u.logs} logs in one poll, over contract.maxBytes ${b.maxBytes} / maxLogs ${b.maxLogs}. Someone may be filling ChannelBus with junk frames. The reader has stopped: call setMode('cover') (or 'contract' with a larger budget) to go on.`, { bytes: u.bytes, logs: u.logs, maxBytes: b.maxBytes, maxLogs: b.maxLogs })
  async function getLogs(node, params, o) {
    const f = params?.[0]
    const t = f?.topics
    if (mode === 'plain' || !f || !Array.isArray(t) || t.length !== 2 || String(t[0]).toLowerCase() !== CHANNELBUS_WIRE_TOPIC) return node.call('eth_getLogs', params, o)
    const asked = (Array.isArray(t[1]) ? t[1] : [t[1]]).map((x) => String(x).replace(/^0x/, '').toLowerCase())
    const own = new Set(asked)
    counters.requests++
    if (mode === 'contract') {
      if (stopped) throw stopped
      if (over) throw budgetError(over)          // nothing more this poll / 本次轮询不再下载
      const x = Number(BigInt(f.fromBlock)), y = Number(BigInt(f.toBlock))
      pollRange = pollRange ? [Math.min(pollRange[0], x), Math.max(pollRange[1], y)] : [x, y]
      return node.call('eth_getLogs', [{ ...f, topics: [t[0]] }], { ...o, project: (logs) => { if (Array.isArray(logs)) { account(logs); seen(logs, x, y) } return keepOwn(logs, own, o?.project) } })
    }
    // Covers were assigned before the poll began (poll() awaits prepare); a room removed while this poll is in flight
    // keeps its covers through `kept`, so it never goes out alone. / 掩护在轮询开始前已分配；轮询途中被移除的房间仍通过
    // `kept` 带着掩护，绝不单独发出。
    if (asked.some((r) => !assigned.has(r) && !kept.has(r))) await ready()
    const covers = new Set()
    for (const r of asked) for (const x of assigned.get(r) ?? kept.get(r) ?? []) if (!own.has(x)) covers.add(x)
    const all = shuffle([...own, ...covers], random).map((r) => '0x' + r)
    return node.call('eth_getLogs', [{ ...f, topics: [t[0], all.length === 1 ? all[0] : all] }], { ...o, project: (logs) => { if (Array.isArray(logs)) account(logs); return keepOwn(logs, own, o?.project) } })
  }
  // A block's receipts carry every log in it, whatever the mode: counted, and bounded in 'contract' mode like the rest.
  // 区块回执含该区块的全部日志，不论模式：计入下载量；'contract' 模式下同样受预算约束。
  async function getReceipts(node, params, o) {
    if (mode === 'contract') { if (stopped) throw stopped; if (over) throw budgetError(over) }
    return node.call('eth_getBlockReceipts', params, { ...o, project: (rs) => { if (Array.isArray(rs)) account(rs.flatMap((r) => (Array.isArray(r?.logs) ? r.logs : []))); return o?.project ? o.project(rs) : rs } })
  }
  const wrap = (node) => ({
    urls: node.urls, quorum: node.quorum, operators: node.operators, degraded: node.degraded,
    get bodyLimit() { return node.bodyLimit },
    blockNumber: (...a) => node.blockNumber(...a),
    chainId: typeof node.chainId === 'function' ? (...a) => node.chainId(...a) : undefined,
    ethCall: typeof node.ethCall === 'function' ? (...a) => node.ethCall(...a) : undefined,
    call: (method, params = [], o = {}) => (method === 'eth_getLogs' ? getLogs(node, params, o) : method === 'eth_getBlockReceipts' ? getReceipts(node, params, o) : node.call(method, params, o)),
  })
  const wired = wrap(rpc)
  if (typeof rpc.single === 'function') wired.single = (u, o) => wrap(rpc.single(u, o))

  const inner = busReader({ ...readerOpts, rpc: wired, bus, pollMs, warn })
  const add = (room, handler = null, opts = {}) => {
    if (handler !== null && typeof handler !== 'function') fail('a room handler must be a function')
    inner.add(room, null, opts)          // validates the room and fromBlock / 校验房间与 fromBlock
    handlers.set(room, handler)
  }
  const remove = (room) => { inner.remove(room); handlers.delete(room); assigned.delete(room); embedded.delete(room) }   // `kept` remembers its covers / 记住它的掩护
  for (const [r, h] of Array.isArray(rooms) ? rooms.map((r) => [r, null]) : Object.entries(rooms)) add(r, h)

  // Traffic of one poll's window (the new blocks plus the overlap re-read), estimated from the latest pool refresh
  // 按最近一次池刷新估算一次轮询窗口（新区块加重叠重读）的流量
  // and every node is read in full, so the budget counts each node's answer / 且每个节点都要完整读一遍，预算按每个节点的回答累计
  const windowBlocks = (readerOpts.overlap ?? 16) + Math.max(1, Math.ceil(pollMs / 450))
  const nodeCount = typeof rpc.single === 'function' && Array.isArray(rpc.urls) ? rpc.urls.length : 1
  const quietNow = () => {
    if (c.scanBlocks === 0) return true      // nothing to measure with: the dwell alone decides / 无从测量：只看停留时间
    const l = pool.last
    // A measurement taken after the fallback, complete, and over at least one poll's window / 降级之后、完整、且至少覆盖一个轮询窗口的测量
    if (!l || l.at <= fallback.since || !l.complete || l.blocks < windowBlocks) return false
    const per = windowBlocks * nodeCount / l.blocks
    return l.bytes * per <= b.maxBytes / 2 && l.logs * per <= b.maxLogs / 2
  }
  const maybeReturn = () => {
    if (!fallback || mode !== 'cover' || b.retryMs === null || Date.now() < fallback.retryAt || !quietNow()) return
    returnedAt = Date.now(); returnedBackoff = fallback.retryAt - fallback.since
    say(warn, `[tapeapi] bus privacy: ChannelBus traffic is back under half the 'contract' budget (after ${Math.round(returnedBackoff / 60_000)} min in 'cover' mode); back to 'contract' mode, which names no room.`, { strikes: fallback.strikes })
    mode = 'contract'; fallback = { ...fallback, returned: true }
  }
  const fallBack = (u) => {
    const now = Date.now()
    const strikes = fallback?.returned && returnedAt !== null && now - returnedAt < Math.max(b.retryMs ?? 0, returnedBackoff) ? fallback.strikes + 1 : 1
    const wait = b.retryMs === null ? null : Math.min(MAX_CONTRACT_RETRY_MS, b.retryMs * 2 ** (strikes - 1))
    fallback = { since: now, strikes, retryAt: wait === null ? Infinity : now + wait }
    mode = 'cover'
    const back = wait === null ? 'It stays in cover mode (contract.retryMs: null).' : `It tries 'contract' again in ${Math.round(wait / 60_000)} min at the earliest, once the traffic is under half the budget.`
    say(warn, `${budgetError(u).message.replace(/ The reader has stopped:.*$/, '')} Switched to 'cover' mode (contract.onExceed); the blocks held are read again with cover rooms. ${back}`, { bytes: u.bytes, logs: u.logs, strikes, retryAt: fallback.retryAt })
  }
  const poll = async () => {
    if (stopped) throw stopped
    maybeReturn()
    if (handlers.size) await ready()
    pollUse = { bytes: 0, logs: 0 }; over = null; pollRooms = new Map(); pollRange = null
    let items = [], error = null
    try { items = await inner.poll() } catch (e) { error = e }
    if (mode === 'contract' && !over && !error && pollRange) {
      // A quiet poll: what it saw joins the cover pool (marked quiet), and the pool's range grows with it
      // 安静的一次轮询：它见到的房间进入掩护池（标为安静），池的区间随之延伸
      for (const [r, n] of pollRooms) { pool.rooms.set(r, Math.max(pool.rooms.get(r) ?? 0, n)); pool.quiet.add(r) }
      if (pool.to === null || pollRange[1] > pool.to) { pool.from = pool.from === null ? pollRange[0] : Math.min(pool.from, pollRange[0]); pool.to = pollRange[1]; pool.at = Date.now() }
    }
    if (over && mode === 'contract') {
      if (b.onExceed === 'cover') {
        fallBack(over)
        error = null      // the hold came from the budget; the next poll reads the range again / 停住源于预算，下次轮询重读
      } else {
        const e = budgetError(over)
        stopped = e
        if (!items.length) throw e
      }
    }
    if (error) throw error
    return items.filter((x) => handlers.has(x.room))
  }

  // The poll loop, as channel.js pollLoop (not exported there), except that a BUS_BUDGET stop is reported once.
  // 轮询循环，同 channel.js 的 pollLoop（那里未导出），只是 BUS_BUDGET 停止只报告一次。
  let generation = 0, controller = null
  const start = (onWire, { onError } = {}) => {
    const mine = ++generation
    controller?.abort()
    controller = new AbortController()
    const { signal } = controller
    const report = (e) => { try { onError?.(e) } catch { /* never let a handler kill the loop / 处理器不能杀死循环 */ } }
    let reported = null
    ;(async () => {
      while (generation === mine) {
        let items = []
        try { items = await poll() } catch (e) {
          if (generation !== mine) break
          if (e !== reported) { reported = e === stopped ? e : null; report(e) }
        }
        for (const x of items) {
          if (generation !== mine) break
          const h = handlers.get(x.room) ?? onWire
          try { if (typeof h === 'function') await h(x.wire, { room: x.room }) } catch (e) { report(e) }
        }
        await sleep(pollMs, signal)
      }
    })().catch(report)
  }
  const stop = () => { generation++; controller?.abort(); controller = null }

  return {
    add, remove, poll, start, stop,
    setMode(m) {
      if (!BUS_PRIVACY_MODES.includes(m)) fail(`mode must be one of ${BUS_PRIVACY_MODES.join(', ')}`)
      mode = m; stopped = null; over = null; fallback = null
    },
    get mode() { return mode },
    get rooms() { return inner.rooms },
    get catchingUp() { return inner.catchingUp },
    get cursor() { return inner.cursor },
    get oldestServed() { return inner.oldestServed },
    get covers() { return Object.fromEntries([...handlers.keys()].map((r) => [r, [...(assigned.get(r) ?? [])]])) },
    stats: () => ({
      ...inner.stats(),
      privacy: {
        mode, k: c.k, effectiveK: mode === 'cover' ? effectiveK() : mode === 'contract' ? null : 1,
        short: mode === 'cover' && handlers.size > 0 && effectiveK() < c.k,
        rooms: handlers.size, covers: [...activeCovers()].filter((x) => !handlers.has(x)).length, pool: pool.rooms.size, poolFrom: pool.from, poolTo: pool.to, poolComplete: pool.complete,
        requests: counters.requests, dropped: counters.dropped, lastPoll: { ...pollUse }, downloaded: { bytes: counters.bytes, logs: counters.logs },
        stopped: stopped !== null,
        fallback: fallback && mode === 'cover' ? { since: fallback.since, strikes: fallback.strikes, retryAt: Number.isFinite(fallback.retryAt) ? fallback.retryAt : null } : null,
      },
    }),
  }
}
