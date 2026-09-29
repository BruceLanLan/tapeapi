// Randomised adversarial runs of the ChannelBus log reader (TAP-26 §3.7, "hold, never skip"). Each run draws a node set
// (history windows, publicnode's recorded result cap and range hints -- right, single-block, garbage, inner, over,
// under --, bodyLimit, nodes that serve no logs, missing receipts, transient failures, latency, a node that lies: a logs
// node or a dataseed whose receipts omit logs, a noisy node adding other addresses' / rooms' / blocks' logs), a chain
// history (frames, stuffed blocks, reorgs, deep reorgs during holds) and a busReader with rooms removed and added
// mid-poll, sometimes with a budget of a few milliseconds, then checks after every poll:
//   - a frame the cursor has left behind for good was delivered, or lies in a reported gap, or in a block the reader
//     warned it passed on other nodes' word alone (the accepted trade-off of R8-C1; a lying DATASEED is held to this too);
//   - a reported gap is real; no frame of a room not asked for, nor one never posted, is delivered;
// and, once the faults stop, that the cursor reaches the head whenever some honest node can read every block.
// A failure prints its seed: FUZZ_SEED=<n> FUZZ_RUNS=1 [FUZZ_DEBUG=1] node --test sdk/test/bus-fuzz.test.mjs replays it.
// Seeds are hashed first (review R9-H1: consecutive raw seeds drew the same early choices, so no run drew a liar).
// ChannelBus 日志读取的随机对抗测试（第九轮审查扩展：撒谎的 dataseed、吵闹节点、各种区间提示、深重组、极小预算）。
// 每次轮询后检查"停住，绝不跳过"，故障停止后检查游标能追到链头。失败时打印种子，可单独重放。种子先哈希。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { channel } from '../src/index.js'
import { createRpc } from '../src/rpc.js'
import { encodeParams } from '../src/abi.js'
import { createFakeChain } from './helpers/fake-chain.mjs'
import { loadedMachine, virtualClock, withClock } from './helpers/clock.mjs'

const EXT = true, STRICT = true, ONLY_ENV = process.env.FUZZ_ONLY || ''
const DEBUG = process.env.FUZZ_DEBUG === '1'
const BUS = '0x' + 'cb'.repeat(20)
const URLS = ['http://rpc1', 'http://rpc2', 'http://rpc3']
const RUNS = Number(process.env.FUZZ_RUNS || 60)
const SEED0 = Number(process.env.FUZZ_SEED || 0x7a9e)
const J = (res) => new Response(JSON.stringify(res.body), { status: res.status ?? 200, headers: { 'content-type': 'application/json' } })
const err = (b, code, message, status = 200) => J({ status, body: { jsonrpc: '2.0', id: b.id, error: { code, message } } })
const ARCHIVE = 'Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode'
const ROOM = ['a1'.repeat(32), 'b2'.repeat(32)]
const ROOM3 = 'c3'.repeat(32)
const JUNK = 0xffff

// MIX (default on): hash the seed first. The repo harness feeds the seed straight into xorshift32, whose first outputs
// are nearly a linear function of a small seed: consecutive seeds draw the same early choices (liar or not, ...).
const mix = (x) => { x = (x + 0x9e3779b9) >>> 0; x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0; x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0; return (x ^ (x >>> 16)) >>> 0 }
function rng(seed) {
  let s = mix(seed) || 1
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
  return { f: next, int: (n) => Math.floor(next() * n), pick: (xs) => xs[Math.floor(next() * xs.length)], p: (x) => next() < x }
}

function drawNode(r, { liar, liarKind, ONLY }) {
  const hints = EXT ? ['exact', 'single', 'garbage', 'inner', 'over', 'under'] : ['exact', 'single', 'garbage']
  const n = {
    liar,
    noLogs: !liar && r.p(0.2),
    window: r.p(0.4) ? 40 + r.int(120) : Infinity,
    cap: r.p(0.4) ? 20 + r.int(60) : Infinity,
    hint: r.pick(hints),
    receipts: r.p(0.75),
    flaky: r.p(0.4) ? 0.05 + r.f() * 0.25 : 0,
    omit: liar ? 0.3 + r.f() * 0.7 : 0,
    noisy: false, slow: 0,
  }
  if (liar && liarKind === 'dataseed') { n.noLogs = true; n.receipts = true }
  if (EXT) { n.slow = r.p(0.3) ? 1 + r.int(3) : 0 }
  if (ONLY === 'hint') n.hint = r.pick(['inner', 'over', 'under']); if (ONLY === 'hint' && n.cap === Infinity) n.cap = 20 + r.int(40)
  return n
}

// Each run is on a virtual clock (FIXED P101-1): a node's latency is simulated time, the reader's work takes none, so
// budgetMs is spent on the latency the seed draws and nothing else. A run no longer depends on how busy the machine is,
// and a tiny-budget seed replays the same run too.
// 每次运行都在虚拟时钟上（FIXED P101-1）：节点延迟是模拟时间，读取方的计算不耗时间，budgetMs 只花在种子抽到的延迟上。
// 运行结果不再取决于机器多忙，极小预算的种子也能重放同一个场景。
const run = (seed, ONLY = ONLY_ENV) => withClock(virtualClock(), (clock) => runOn(clock, seed, ONLY))
async function runOn(clock, seed, ONLY) {
  const r = rng(seed)
  const chain = createFakeChain()
  const st = chain.state
  const head0 = st.block
  const nodeRng = URLS.map((_, k) => rng(seed * 7 + k + 1))
  const liarAt = (r.p(0.35) || ONLY === 'dataseed' || ONLY === 'outage') ? r.int(3) : -1
  const liarKind = liarAt < 0 ? null : ONLY === 'outage' ? 'logs' : (EXT && (ONLY === 'dataseed' || r.p(0.5)) ? 'dataseed' : 'logs')
  const nodes = URLS.map((_, i) => drawNode(r, { liar: i === liarAt, liarKind, ONLY }))
  if (nodes.every((n) => n.noLogs)) nodes[liarAt === 0 ? 1 : 0].noLogs = false
  // outage: an honest logs node down for polls 5..27, then back (review R11) / 一个诚实日志节点在第 5 到 27 轮宕机，之后恢复
  const outAt = ONLY === 'outage' ? (liarAt + 1 + r.int(2)) % 3 : -1
  if (outAt >= 0) { nodes[outAt].noLogs = false; nodes[outAt].flaky = 0.3; nodes[outAt].window = Infinity }
  // cant: a logs node with a result cap and no receipts beside a dataseed that has them (review R11-C1) / 有上限无回执的日志节点加有回执的 dataseed
  if (ONLY === 'cant') {
    const k = (liarAt + 1) % 3, d = (liarAt + 2) % 3
    Object.assign(nodes[k], { noLogs: false, cap: 20 + r.int(30), receipts: false })
    if (d !== liarAt) Object.assign(nodes[d], { noLogs: true, receipts: true, window: Infinity })
  }
  if (EXT && (r.p(0.25) || ONLY === 'noisy')) { const k = nodes.findIndex((n, i) => i !== liarAt); nodes[k].noisy = true }
  const tiny = EXT && ONLY !== 'outage' && (r.p(0.2) || ONLY === 'tiny')
  const deepReorg = EXT && (r.p(0.4) || ONLY === 'reorg')
  const faults = { on: true }
  const posted = new Map()
  let nextId = 1
  const WIRE_TOPIC = '0x46fffab6f2033c7dc33390d2a1329b6809abdcb8baf711dc44a9144ccf4b1431'
  const hex = (b) => '0x' + Buffer.from(b).toString('hex')
  const wireOf = (id, size) => { const w = new Uint8Array(Math.max(3, size)); w[0] = 0x02; w[1] = id & 0xff; w[2] = id >> 8; return w }
  const idOf = (w) => w[1] | (w[2] << 8)
  const emit = (room, id, block, size = 3) => {
    const logIndex = st.logs.filter((l) => l.blockNumber === block).length
    st.logs.push({ address: BUS.toLowerCase(), topics: [WIRE_TOPIC, '0x' + room], data: hex(encodeParams(['bytes'], [wireOf(id, size)])), blockNumber: block, logIndex, id })
  }
  const post = (room, block) => { const id = nextId++; trace.push(`post #${id} ${room.slice(0, 2)}@${block - head0} (head ${st.block - head0})`); posted.set(id, { room, block, alive: true }); emit(room, id, block) }
  const stuffed = new Map()
  const stuff = (block, n, size) => { for (let k = 0; k < n; k++) emit(ROOM[r.int(2)], JUNK, block, size); stuffed.set(block, (stuffed.get(block) || 0) + n) }
  const reorg = (depth) => {
    const recent = st.logs.filter((l) => l.id !== JUNK && l.blockNumber > st.block - depth)
    if (!recent.length) return
    const l = r.pick(recent)
    st.logs.splice(st.logs.indexOf(l), 1)
    if (r.p(0.3)) { posted.get(l.id).alive = false; return }
    const to = st.block - r.int(depth)
    trace.push(`reorg #${l.id} ${l.blockNumber - head0} -> ${to - head0} (head ${st.block - head0})`)
    posted.get(l.id).block = to; posted.get(l.id).passedAt = null   // passed again only once the overlap leaves it / 重叠区离开它时才算再次越过
    if (to < reader.cursor) posted.get(l.id).movedBelow = true
    emit(posted.get(l.id).room, l.id, to)
    posted.get(l.id).moved = true
  }
  // noise added by a `noisy` node / 吵闹节点加的噪声
  const noise = (b, asReceiptOf, r) => {
    const mk = (over) => ({ address: BUS.toLowerCase(), topics: [WIRE_TOPIC, '0x' + ROOM[0]], data: hex(encodeParams(['bytes'], [wireOf(JUNK, 3)])), blockNumber: '0x' + b.toString(16), logIndex: '0x' + (90000 + r.int(1000)).toString(16), removed: false, ...over })
    const out = [
      mk({ address: '0x' + '0f'.repeat(20) }),
      mk({ topics: ['0x' + '11'.repeat(32), '0x' + ROOM[0]] }),
      mk({ topics: [WIRE_TOPIC, '0x' + ROOM3] }),
      mk({ blockNumber: '0x' + (b + 1 + r.int(5)).toString(16) }),
      mk({ blockNumber: '0x' + Math.max(0, b - 1 - r.int(5)).toString(16) }),
    ]
    return asReceiptOf ? out : out
  }

  let toggle = null
  let pollNo = 0   // polls started / 已开始的轮询次数
  const counts = { whole: 0, sweep: 0 }
  const fetch = async (url, init) => {
    const b = JSON.parse(init.body)
    const n = nodes[URLS.indexOf(url)]
    const r = nodeRng[URLS.indexOf(url)]   // each node its own stream: replays do not depend on request order / 每个节点各自的随机数流
    if (n.slow) await clock.sleep(r.int(n.slow + 1))
    if (toggle && r.p(0.3)) { const t = toggle; toggle = null; t() }
    if (URLS.indexOf(url) === outAt && pollNo >= 5 && pollNo <= 27 && (b.method === 'eth_getLogs' || b.method === 'eth_getBlockReceipts')) throw new TypeError('fetch failed')
    if (faults.on && n.flaky && r.p(n.flaky) && (b.method === 'eth_getLogs' || b.method === 'eth_getBlockReceipts')) {
      const k = r.int(4)
      if (k === 0) return err(b, -32000, 'header not found')
      if (k === 1) return new Response('<html>502</html>', { status: 502, headers: { 'content-type': 'text/html' } })
      if (k === 2) return err(b, -32005, 'rate limit exceeded')
      throw new TypeError('fetch failed')
    }
    const edge = st.block - n.window
    if (b.method === 'eth_getLogs') {
      if (n.noLogs) return err(b, -32005, 'limit exceeded')
      const lo = Number(BigInt(b.params[0].fromBlock)), hi = Number(BigInt(b.params[0].toBlock))
      if (lo < edge) return err(b, -32602, ARCHIVE, 403)
      const res = await chain.fetch(url, init)
      const j = await res.json()
      if (Array.isArray(j.result) && j.result.length > n.cap) {
        let B
        let A = lo
        if (n.hint === 'garbage') B = lo - 1 - r.int(5)
        else {
          let k = 0; B = lo - 1; for (let x = lo; x <= hi; x++) { k += j.result.filter((l) => Number(BigInt(l.blockNumber)) === x).length; if (k > n.cap) break; B = x }
          if (n.hint === 'single' && B < lo) B = lo
          if (n.hint === 'inner') A = lo + 1 + r.int(Math.max(1, hi - lo))
          if (n.hint === 'over') B = B + 1 + r.int(3)
          if (n.hint === 'under') B = Math.max(lo - 1, B - 1 - r.int(3))
        }
        return err(b, -32602, `query exceeds max results ${n.cap}, retry with the range ${A}-${B}`)
      }
      if (n.liar && Array.isArray(j.result)) j.result = j.result.filter(() => !r.p(n.omit))
      if (n.noisy && Array.isArray(j.result)) for (let x = lo; x <= hi; x++) if (r.p(0.3)) j.result.push(...noise(x, false, r))
      // an answer counts only if the reader accepts it (not over its bodyLimit) / 只有读取方收得下的回答才算
      if (Array.isArray(j.result) && JSON.stringify(j).length <= bodyLimit) { n.lastOK = pollNo; (n.ok ||= new Set()).add(pollNo) }
      return J({ body: j })
    }
    if (b.method === 'eth_getBlockReceipts') {
      if (!n.receipts) return err(b, -32601, 'the method eth_getBlockReceipts does not exist/is not available')
      const bn = Number(BigInt(b.params[0]))
      if (bn < edge) return err(b, -32602, ARCHIVE, 403)
      if (n.noLogs) counts.sweep++
      const res = await chain.fetch(url, init)
      const j = await res.json()
      if (n.liar && Array.isArray(j.result)) j.result = j.result.map((rc) => ({ ...rc, logs: rc.logs.filter(() => !r.p(n.omit)) }))
      if (n.noisy && Array.isArray(j.result)) j.result.push({ blockNumber: b.params[0], status: '0x1', logs: noise(bn, false, r) })
      if (!n.noLogs && Array.isArray(j.result) && JSON.stringify(j).length <= bodyLimit) { n.lastOK = pollNo; (n.ok ||= new Set()).add(pollNo) }
      return J({ body: j })
    }
    return chain.fetch(url, init)
  }

  const confirmations = r.int(3), overlap = 16, lookback = 400, fromBlock = head0 - r.int(300)
  const bodyLimit = r.pick([8 * 1024, 64 * 1024, 4 * 1024 * 1024])
  const warns = []
  const trace = []   // what happened, kept in memory and shown only on failure (printing changes the timing) / 失败时才显示
  const early = []   // nodes given up on too early / 过早放弃的节点
  const budgetMs = tiny ? r.pick([1, 2, 3, 5, 10]) : r.pick([200, 2000])
  const reader = channel.busReader({
    rpc: createRpc({ urls: URLS, quorum: 2, fetch, timeoutMs: 2000, bodyLimit }),
    bus: BUS, rooms: ROOM, fromBlock, lookback, confirmations, overlap,
    chunk: r.pick([50, 200, 1000]), minChunk: r.pick([5, 20, 40]), budgetMs, verdictMs: 0, ...(r.p(0.3) && liarAt < 0 ? { startGraceMs: 0 } : {}),   // without the grace a liar may outrun a first-poll blip (R9-PE1) / 没有宽限时撒谎节点可能在首轮抢跑
    warn: (m, d) => {
      trace.push(`p${pollNo} warn ${m.slice(40, 150)}`)
      warns.push({ m, d: d || {} })
      // Giving up on a node is announced, and must not come early: only after about SERVED_DECAY (20) polls in which it
      // answered nothing. / 放弃等待某节点会宣布，而且不能过早：它约 20 次轮询都没答上之后才行。
      // (recorded here and asserted in check(): the reader swallows whatever a warn callback throws)
      // （在这里记录、在 check() 里断言：读取方会吞掉告警回调抛出的任何错误）
      if (d?.abandoned != null && !(pollNo - (nodes[d.abandoned].lastOK ?? -1e9) >= 19)) early.push(`node#${d.abandoned} given up on after ${pollNo - nodes[d.abandoned].lastOK} polls without an answer`)
    },
  })
  const got = new Map()
  const reAdded = new Set()
  const junkOK = liarAt >= 0
  let held = false
  const pollOnce = async () => {
    pollNo++
    let out = []
    held = false
    try { out = await reader.poll() } catch (e) { if (e.code !== 'RPC_UNAVAILABLE') throw e; held = true; if (DEBUG) console.log('  hold:', e.message.slice(0, 300)) }
    // first passed FOR ITS ROOM: the room is read, and not catching up from below the frame / 为它所属的房间首次越过
    for (const p of posted.values()) {
      // a frame a reorg moved below the cursor is re-read in the overlap until the cursor leaves it behind
      // 被重组挪到游标之下的帧会在重叠区里被重读，直到游标把它甩在后面
      if (p.passedAt != null || p.block >= reader.cursor - (p.movedBelow ? overlap : 0) || !reader.rooms.includes(p.room)) continue
      const cu = reader.catchingUp[p.room]
      if (cu === null || (cu !== undefined && p.block >= cu)) continue
      p.passedAt = pollNo; p.headAtPass = st.block
    }
    for (const w of warns) if (w.d.abandoned != null && w.poll == null) w.poll = pollNo
    trace.push(`p${pollNo} head ${st.block - head0} cursor ${reader.cursor - head0}${held ? ' HOLD' : ''} got ${out.filter((x) => idOf(x.wire) !== JUNK).map((x) => idOf(x.wire)).join(',')}`)
    if (DEBUG) console.log(`poll: sweep ${counts.sweep} head ${st.block - head0} cursor ${reader.cursor - head0} rooms ${reader.rooms.map((x) => x.slice(0, 2))} cu ${JSON.stringify(Object.entries(reader.catchingUp).map(([k, v]) => [k.slice(0, 2), v == null ? null : v - head0]))} got ${out.map((x) => `${x.room.slice(0, 2)}:${idOf(x.wire)}`).join(' ')}`)
    for (const { room, wire } of out) {
      const id = idOf(wire)
      if (id === JUNK) continue
      assert.notEqual(room, ROOM3, `seed ${seed}: a third room's frame was delivered`)
      const p = posted.get(id)
      assert.ok(p, `seed ${seed}: delivered frame ${id} was never posted`)
      assert.equal(room, p.room, `seed ${seed}: frame ${id} delivered for the wrong room`)
      got.set(id, (got.get(id) || 0) + 1)
    }
  }
  const excused = (b) => warns.some(({ d }) => (d.oldestServed != null && d.from <= b && b <= d.to) || (junkOK && d.cannot === b))
  const check = (final) => {
    assert.equal(early.length, 0, `seed ${seed}: the reader gave up on a node too early: ${early.join("; ")}; nodes ${JSON.stringify(nodes)}`)
    // A poll that holds but hands something over does not throw, so "held" is not known for sure: the overlap below the
    // cursor may still be being read. / 停住但交出了东西的轮询不抛错，所以无法确知是否停住：游标下的重叠区可能仍在读。
    const passed = reader.cursor - overlap
    for (const [id, p] of posted) {
      if (!p.alive || p.block >= passed || p.block < fromBlock) continue
      if (!reader.rooms.includes(p.room)) continue
      const cu = reader.catchingUp[p.room]
      if (cu === null || (cu !== undefined && p.block >= cu - overlap)) continue
      if (p.removedFrom && p.block >= p.removedFrom[0] && p.block <= p.removedFrom[1]) continue
      if (!got.has(id) && !excused(p.block)) {
        // A node not waited for any more (R4-6: a dead node must not hold for ever) is announced with the block from which
        // blocks are passed without it; frames from there on are reported. / 不再等待的节点会连同起始区块一起宣布；其后的帧算已报告。
        // Only a logs node given up on excuses, only from the block it names, and only frames first passed after the
        // warning and before that node answered again (review R11: the excuse had no end and covered dataseeds too).
        // 只有被放弃的日志节点能豁免，只从它指明的区块起，且只豁免告警之后、该节点再次回答之前首次越过的帧。
        // ...and only when every other honest logs node had a reason too (given up on as well, out of its window, or unable
        // to read the block at all): otherwise the reader should have waited for that one (review R12-H1).
        // ……而且只有其它每个诚实日志节点也都有理由（同样被放弃、超出窗口、或根本读不了该区块）时才豁免：否则读取方本该等那个节点。
        const gaveUp = (j) => warns.some(({ d, poll }) => d.abandoned === j && d.from <= p.block && p.passedAt != null && poll <= p.passedAt && ![...(nodes[j].ok || [])].some((q) => q > poll && q <= p.passedAt))
        const attributable = (k) => nodes.every((n, j) => j === k || n.liar || n.noLogs || gaveUp(j) || p.block < p.headAtPass - n.window || ((stuffed.get(p.block) || 0) + 1 > n.cap && !n.receipts))
        if (warns.some(({ d }) => d.abandoned != null && d.abandoned !== liarAt && !nodes[d.abandoned].noLogs && gaveUp(d.abandoned) && attributable(d.abandoned))) continue
        // A reorg deeper than confirmations that moves a frame below the cursor is read again only by the overlap; if the
        // window then slides past it before an honest node re-reads it, it is lost (documented limit, TAP-26 §3.7).
        // 比确认数更深、把帧挪到游标之下的重组只靠重叠区重读；窗口先滑过则丢失（已记录的限制）。
        if (p.movedBelow && nodes.every((n) => n.liar || n.noLogs || p.block < st.block - n.window)) continue
        const onlyLiar = junkOK && nodes.every((n, i) => i === liarAt || n.noLogs || p.block < st.block - n.window)
        if (onlyLiar && !(STRICT && liarKind === 'dataseed')) continue
        assert.fail(`seed ${seed}: ${onlyLiar ? '[STRICT dataseed-only] ' : ''}frame ${id} (room ${p.room.slice(0, 4)}, block ${p.block - head0}) is behind the cursor (${reader.cursor - head0}) and was neither delivered nor reported; trace ${trace.filter((t) => !t.startsWith('post') || t.startsWith(`post #${id} `)).join(' | ')}; liarKind ${liarKind}@${liarAt}; nodes ${JSON.stringify(nodes)}; stuffed ${JSON.stringify([...stuffed].map(([b, n]) => [b - head0, n]))}; head ${st.block - head0}; warns ${JSON.stringify(warns.map((w) => w.m.slice(0, 120)))}`)
      }
      if (!p.moved && !reAdded.has(p.room)) assert.ok((got.get(id) || 0) <= 1, `seed ${seed}: frame ${id} delivered ${got.get(id)} times`)
    }
    for (const { d } of warns) if (d.oldestServed != null) {
      const g = d.to
      const serving = nodes.filter((n) => !n.noLogs && !n.liar)
      if (serving.length && liarAt < 0) assert.ok(serving.every((n) => g < st.block - n.window + 3 * overlap), `seed ${seed}: a gap to ${g - head0} was reported although a node serves it (edges ${serving.map((n) => n.window)})`)
    }
  }

  for (let k = 0; k < 6; k++) post(ROOM[r.int(2)], head0 - r.int(250))
  const steps = ONLY === 'outage' ? 50 : 25 + r.int(15)
  const removed = new Map()
  for (let step = 0; step < steps; step++) {
    const mined = 1 + r.int(4)
    st.block += mined
    for (let k = r.int(3); k > 0; k--) post(ROOM[r.int(2)], st.block - r.int(mined))
    if (r.p(ONLY === 'cant' ? 0.4 : 0.15)) stuff(st.block - r.int(mined), 30 + r.int(90), r.pick([8, 200, 2000]))
    if (r.p(0.15)) reorg(6)
    if (deepReorg && held && r.p(0.5)) reorg(overlap - 1)
    if (r.p(0.08) && !toggle) {
      const room = ROOM[1]
      if (reader.rooms.includes(room)) toggle = () => { trace.push(`p${pollNo} REMOVE ${room.slice(0, 2)}`); reader.remove(room); removed.set(room, st.block) }
      else toggle = () => { trace.push(`p${pollNo} ADD ${room.slice(0, 2)}`); reader.add(room); reAdded.add(room); const from = removed.get(room); for (const p of posted.values()) if (p.room === room && p.block >= from && p.block < st.block - lookback) p.removedFrom = [from, st.block] }
    }
    await pollOnce()
    check(false)
  }
  faults.on = false
  if (toggle) { toggle(); toggle = null }
  if (!reader.rooms.includes(ROOM[1])) { reader.add(ROOM[1]); reAdded.add(ROOM[1]) }
  for (let k = 0; k < 30 && (k < 3 || reader.cursor <= st.block - confirmations); k++) { st.block += 1; await pollOnce() }
  const readable = (b) => {
    const count = st.logs.filter((l) => l.blockNumber === b).length
    const inWin = (n) => b >= st.block - n.window
    const logsOK = nodes.some((n) => !n.liar && !n.noLogs && inWin(n) && count <= n.cap)
    const found = nodes.some((n) => !n.noLogs && inWin(n) && count > n.cap)
    const receipts = nodes.some((n) => !n.liar && n.receipts && inWin(n))
    return logsOK || (found && receipts)
  }
  const kept = (b) => nodes.some((n) => !n.liar && !n.noLogs && b >= st.block - n.window)
  let canAll = true
  for (let b = reader.cursor - overlap; b <= st.block - confirmations; b++) if (kept(b) && !readable(b)) canAll = false
  // A budget of a few milliseconds cannot promise progress, so liveness is not checked there / 几毫秒的预算不能保证前进，不查活性
  const liveCheck = canAll && (liarAt < 0 || liarKind === 'dataseed') && !tiny
  if (liveCheck) assert.ok(reader.cursor > st.block - confirmations - 4, `seed ${seed}: [LIVENESS${tiny ? ' tiny' : ''}] after recovery the cursor is at ${reader.cursor - st.block} from the head; liarKind ${liarKind}@${liarAt} tiny ${tiny}/${budgetMs}; nodes ${JSON.stringify(nodes)}; last warns ${JSON.stringify(warns.slice(-3).map((w) => w.m.slice(0, 200)))}`)
  check(true)
  return { liarKind, tiny, noisy: nodes.some((n) => n.noisy), sweep: counts.sweep, live: liveCheck }
}

test(`bus reader, randomised: ${RUNS} runs of faulty, lying and noisy nodes, stuffed blocks, reorgs and room changes never skip a frame silently`, async () => {
  for (let i = 0; i < RUNS; i++) await run(SEED0 + i)
})

// Seeds that once found a defect, replayed every time (seed, focus) / 曾经发现缺陷的种子，每次都重放（种子、方向）
const REGRESSIONS = [[21200346, 'cant'], [11000712, ''], [14000061, 'outage'], [31416, ''], [31458, ''], [31479, ''], [31600, ''], [31734, ''], [31819, ''], [40000295, ''], [44000268, 'reorg']]
// (Tiny-budget seeds used to be left out because they depended on how fast the machine was; on the virtual clock they
// replay the same run.) / （极小预算的种子以前不放进来，因为取决于机器快慢；在虚拟时钟上它们重放的是同一个场景。）
test('bus reader, randomised: the seeds that found defects before still pass', async () => {
  for (const [seed, only] of REGRESSIONS) await run(seed, only)
})

// FIXED P101-1: seed 31392 (budgetMs 200) failed its liveness check once on a loaded machine: the nodes ran out of their
// per-poll budget of wall time, so the cursor held. The same seeds on a clock running 50x fast must pass.
// FIXED P101-1：种子 31392（budgetMs 200）在高负载机器上活性检查失败过一次：节点用完了每次轮询的墙钟预算，游标停住。
// 同样的种子在快 50 倍的时钟上必须通过。
test('FIXED P101-1: the randomised bus runs do not depend on how busy the machine is', () => withClock(loadedMachine(50), async () => {
  for (const seed of [31392, SEED0, SEED0 + 1, SEED0 + 2]) await run(seed, '')
}))
