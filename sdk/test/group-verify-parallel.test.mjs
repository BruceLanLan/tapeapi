// TAP-27 §3.3 step 6 in parallel (1.1.x, no change to the specification): every member still checks every member
// against its channel record, but up to `verifyConcurrency` checks (default 8) run at once. The outcome is the serial
// loop's: the same roster, the same error (the first failing member in roster order), the same dropped list in the same
// order, and a failure still leaves the group where it was.
// TAP-27 §3.3 第 6 步并行化（1.1.x，不改规范）：每个成员仍对照通道记录核验每个成员，但至多 `verifyConcurrency` 个（默认 8）
// 同时进行。结果与串行循环一致：同样的名单、同样的错误（按名单顺序第一个失败的成员）、同样顺序的移除名单；失败仍不改变群的状态。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTapeAPI, channel, sig, TapeAPIError, CHANNEL_KEYS_KEY, canonicalJSON } from '../src/index.js'
import * as G from '../src/group.js'
import { createFakeChain, ADDR } from './helpers/fake-chain.mjs'
import { virtualClock, withClock } from './helpers/clock.mjs'

const hex = (b) => '0x' + Buffer.from(b).toString('hex')
const C = (n) => '0x' + n.toString(16).padStart(40, '0')
const isGroupErr = (re) => (e) => e instanceof TapeAPIError && e.code === 'GROUP_INVALID' && (!re || re.test(e.message))
const invalid = (re) => (e) => e instanceof TapeAPIError && e.code === 'INVALID_ARGUMENT' && re.test(e.message)
const entry = (m) => ({ container: m.container, chainId: 56, x25519: hex(m.identity.x25519.publicKey), ed25519: hex(m.identity.ed25519.publicKey) })
const TRUST = { verifyMember: 'trust-roster' }

// n containers with identities; the owner is ms[0] / n 个带身份的容器，ms[0] 为群主
function people(n, base = 0xc000) {
  return Array.from({ length: n }, (_, i) => ({ container: C(base + i), chainId: 56, identity: channel.generateIdentity() }))
}
async function groupOf(ms, opts = {}) {
  const { group: owner, epochWire } = await G.createGroup({ self: ms[0], identity: ms[0].identity, members: ms.slice(1).map(entry), ...TRUST, ...opts })
  const joiner = (m, o = {}) => G.joinGroup({ self: m, identity: m.identity, invite: { gid: owner.gid, owner: { container: ms[0].container, chainId: 56 } }, ownerKeys: entry(ms[0]), ...o })
  return { owner, epochWire, joiner }
}
// A verifier that answers per container after a delay: 'ok' | 'bad' | 'rpc'. Records the order checks start in and
// the most that ran at once. / 按容器作答的核验器（带延迟）：记录开始顺序与最大并发。
function scripted(verdicts, delayOf = () => 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  let inFlight = 0
  const v = async (m) => {
    v.started.push(m.container)
    inFlight++; v.max = Math.max(v.max, inFlight)
    try {
      await sleep(delayOf(m.container))
      const what = verdicts[m.container] ?? 'ok'
      if (what === 'rpc') throw new TapeAPIError('RPC_UNAVAILABLE', `no node answered for ${m.container}`)
      return what === 'ok'
    } finally { inFlight-- }
  }
  v.started = []; v.max = 0
  return v
}
const outcome = async (p) => { try { return { ok: await p } } catch (e) { return { code: e.code, message: e.message } } }

test('FIXED GRP-1: §3.3 step 6 checks run in parallel with the outcome of the serial loop (roster, first error in roster order, dropped order)', () => withClock(virtualClock(), async (clock) => {
  const ms = people(32)
  const { owner, epochWire, joiner } = await groupOf(ms)
  const c = (i) => ms[i].container
  // Later members answer first (delay falls with the index), so completion order is the reverse of roster order.
  // 后面的成员先答（延迟随序号递减），完成顺序与名单顺序相反。
  const delayOf = (container) => 64 - ms.findIndex((m) => m.container === container) * 2
  const cases = [
    { name: 'all match', verdicts: {} },
    { name: 'two mismatches', verdicts: { [c(5)]: 'bad', [c(12)]: 'bad' } },
    { name: 'an RPC failure before a mismatch', verdicts: { [c(9)]: 'rpc', [c(20)]: 'bad' } },
    { name: 'a mismatch before an RPC failure', verdicts: { [c(4)]: 'bad', [c(30)]: 'rpc' } },
    { name: 'the owner entry fails', verdicts: { [c(0)]: 'rpc', [c(31)]: 'bad' } },
  ]
  for (const k of cases) {
    const results = []
    for (const verifyConcurrency of [1, 8, 32]) {
      const g = joiner(ms[1], { verifyConcurrency })
      const r = await outcome(g.acceptEpoch(epochWire, { verifyMember: scripted(k.verdicts, delayOf, clock.sleep) }))
      results.push({ r: r.ok ? { epoch: r.ok.epoch, members: r.ok.roster.members.map((m) => m.container) } : r, epoch: g.epoch })
    }
    assert.deepEqual(results[1], results[0], `${k.name}: concurrency 8 = serial`)
    assert.deepEqual(results[2], results[0], `${k.name}: concurrency 32 = serial`)
  }
  // the error names the first failing member in roster order, whatever finished first / 错误指向名单中第一个失败者
  const g = joiner(ms[1])
  await assert.rejects(g.acceptEpoch(epochWire, { verifyMember: scripted({ [c(9)]: 'rpc', [c(20)]: 'bad' }, delayOf, clock.sleep) }), isGroupErr(new RegExp(`member ${c(9)}: no node answered`)))
  await assert.rejects(g.acceptEpoch(epochWire, { verifyMember: scripted({ [c(5)]: 'bad', [c(12)]: 'bad' }, delayOf, clock.sleep) }), isGroupErr(new RegExp(`member ${c(5)}: keys do not match`)))

  // Owner re-verification (drop mode): definitive mismatches are dropped in roster order; an RPC failure aborts.
  // 群主重新核验（移除模式）：确定不符者按名单顺序移除；RPC 故障则中止。
  const drops = []
  for (const verifyConcurrency of [1, 8]) {
    const { owner: o } = await groupOf(ms, { verifyConcurrency })
    const up = await o.rotate({ verifyMember: scripted({ [c(3)]: 'bad', [c(7)]: 'bad', [c(28)]: 'bad' }, delayOf, clock.sleep) })
    drops.push(up.dropped)
    const before = o.epoch
    await assert.rejects(o.rotate({ verifyMember: scripted({ [c(10)]: 'rpc', [c(11)]: 'bad' }, delayOf, clock.sleep) }), isGroupErr(new RegExp(`member ${c(10)}: no node answered`)))
    assert.equal(o.epoch, before, 'an aborted epoch changes nothing')
  }
  assert.deepEqual(drops[0], [c(3), c(7), c(28)])
  assert.deepEqual(drops[1], drops[0])
  assert.equal(owner.epoch, 0)
}))

test('FIXED GRP-2: at most verifyConcurrency checks run at once (default VERIFY_CONCURRENCY = 8); bad values are INVALID_ARGUMENT', () => withClock(virtualClock(), async (clock) => {
  const ms = people(32, 0xc100)
  const { epochWire, joiner } = await groupOf(ms)
  assert.equal(G.VERIFY_CONCURRENCY, 8)
  const pub = await import('../src/index.js')
  assert.equal(pub.group.VERIFY_CONCURRENCY, 8, 'exported on the public group namespace')
  for (const [opt, want] of [[undefined, 8], [1, 1], [3, 3], [8, 8], [64, 32]]) {
    const v = scripted({}, () => 5, clock.sleep)
    const g = joiner(ms[2], opt === undefined ? {} : { verifyConcurrency: opt })
    await g.acceptEpoch(epochWire, { verifyMember: v })
    assert.equal(v.max, want, `verifyConcurrency ${opt}: at most ${want} at once`)
    assert.equal(v.started.length, 32, 'every member checked, the owner and ourselves included')
    assert.deepEqual(v.started, ms.map((m) => m.container), 'checks START in roster order')
  }
  // the owner's side too: createGroup, addMembers and rotate / 群主一侧同样受限
  const v = scripted({}, () => 5, clock.sleep)
  const { group: owner } = await G.createGroup({ self: ms[0], identity: ms[0].identity, members: ms.slice(1, 20).map(entry), verifyMember: v, verifyConcurrency: 4 })
  assert.equal(v.max, 4)
  const v2 = scripted({}, () => 5, clock.sleep)
  await owner.addMembers(ms.slice(20).map(entry), { verifyMember: v2 })
  assert.equal(v2.max, 4)
  const v3 = scripted({}, () => 5, clock.sleep)
  await owner.rotate({ verifyMember: v3 })
  assert.equal(v3.max, 4)
  assert.equal(v3.started.length, 31, 'the owner re-checks everyone but itself')
  for (const bad of [0, -1, 1.5, 65, '8', null]) {
    assert.throws(() => joiner(ms[1], { verifyConcurrency: bad }), invalid(/verifyConcurrency must be an integer in 1\.\.64/))
    await assert.rejects(G.createGroup({ self: ms[0], identity: ms[0].identity, ...TRUST, verifyConcurrency: bad }), invalid(/verifyConcurrency/))
  }
}))

test('CONFIRMED GRP-3: a failed check still aborts without deciding: no member after it starts, the group stays where it was, the same message is accepted later', async () => {
  const ms = people(24, 0xc200)
  const { owner, epochWire, joiner } = await groupOf(ms)
  const g = joiner(ms[3])
  // member 6 fails at once while the others take a while: nothing after the first 8 in flight is started
  // 6 号立刻失败、其余较慢：除了已在途的前 8 个，之后不再开始新的核验
  const v = scripted({ [ms[6].container]: 'rpc' }, (c) => (c === ms[6].container ? 0 : 20))
  await assert.rejects(g.acceptEpoch(epochWire, { verifyMember: v }), isGroupErr(new RegExp(`member ${ms[6].container}: no node answered`)))
  assert.deepEqual(v.started, ms.slice(0, 8).map((m) => m.container), 'only the first wave started')
  assert.equal(g.epoch, null, 'nothing installed')
  assert.deepEqual(g.members, [])
  // a definitive mismatch is refused the same way / 确定不符同样被拒
  await assert.rejects(g.acceptEpoch(epochWire, { verifyMember: scripted({ [ms[17].container]: 'bad' }) }), isGroupErr(/keys do not match its channel record/))
  assert.equal(g.epoch, null)
  // the node answers now: the same message is accepted / 节点恢复：同一条消息被接受
  const r = await g.acceptEpoch(epochWire, { verifyMember: scripted({}) })
  assert.equal(r.epoch, 0)
  assert.equal(g.members.length, 24)
  // calls stay serialised: two acceptances at once do not interleave their checks / 调用仍按顺序执行
  const w1 = (await owner.rotate(TRUST)).epochWire
  const w2 = (await owner.rotate(TRUST)).epochWire
  const h = joiner(ms[4])
  const log = []
  const slow = async (m) => { log.push('1:' + m.container); await new Promise((r) => setTimeout(r, 2)); return true }
  const fast = async (m) => { log.push('2:' + m.container); return true }
  await Promise.all([h.acceptEpoch(w1, { verifyMember: slow }), h.acceptEpoch(w2, { verifyMember: fast })])
  assert.ok(log.slice(0, 24).every((x) => x.startsWith('1:')) && log.slice(24).every((x) => x.startsWith('2:')), 'the second acceptance began after the first ended')
  assert.equal(h.epoch, 2)
})

// A container on the fake chain with a published channel identity / 假链上有已发布通道身份的容器
function onChain(chain, n, T) {
  const container = C(0xd000 + n)
  const holderKey = '0x' + (0x1000 + n).toString(16).padStart(4, '0').repeat(16)
  chain.setContainerToken(container, { tokenId: n })
  chain.setAccount(n, container)
  chain.setOwner(n, sig.privateKeyToAddress(holderKey))
  const identity = channel.generateIdentity()
  const keys = { container, x25519: hex(identity.x25519.publicKey), ed25519: hex(identity.ed25519.publicKey), inbox: { bus: '0x' + 'cb'.repeat(20) }, issued: T - 60, expires: T + 86400 }
  const record = { tapechannel: '1', container, chainId: 56, ...keys, sig: sig.signDigest(sig.channelKeysDigest(56, ADDR.hub, keys), holderKey) }
  chain.writeFile(container, CHANNEL_KEYS_KEY, canonicalJSON(record))
  return { container, chainId: 56, identity }
}

// FIXED GRP-4: a member's cold start on a 32-member group, through the real verifier (api.groupVerifier(): quorum 2 of
// 3 nodes, every read a JSON-RPC round trip) with every HTTP request taking LATENCY_MS of simulated time. Measured on
// the virtual clock, so the numbers are the same on every machine: serial 32 × (one check) against 4 waves of 8.
// 成员冷启动接受 32 人纪元：经真实核验器（3 个节点法定数 2，每次读取一次 JSON-RPC 往返），每个 HTTP 请求耗时 LATENCY_MS 模拟时间。
// 在虚拟时钟上测量，任何机器上数字都一样：串行 32 次核验，对比并发 8 分 4 批。
const LATENCY_MS = 280       // one quorum round on BSC public nodes, measured 2026-09-29 (~340 ms for 3 nodes) / 实测一轮约 280–340 ms
test('FIXED GRP-4: cold start of a 32-member epoch with simulated RPC latency: serial vs verifyConcurrency 8', () => withClock(virtualClock({ start: 1_790_000_000_000 }), async (clock) => {
  const T = Math.floor(clock.now() / 1000)
  const chain = createFakeChain()
  const ms = Array.from({ length: 32 }, (_, i) => onChain(chain, i + 1, T))
  let requests = 0
  const fetch = async (url, init) => { requests++; await clock.sleep(LATENCY_MS); return chain.fetch(url, init) }
  const { epochWire, joiner } = await groupOf(ms)
  const coldStart = async (verifyConcurrency) => {
    requests = 0
    const api = createTapeAPI({ rpcUrls: ['http://rpc1', 'http://rpc2', 'http://rpc3'], quorum: 2, chainId: 56, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, fetch })
    const g = joiner(ms[1], { verifyConcurrency })
    const t0 = clock.now()
    await g.acceptEpoch(epochWire, { verifyMember: api.groupVerifier() })
    return { ms: clock.now() - t0, requests }
  }
  const serial = await coldStart(1)
  const parallel = await coldStart(8)
  const perMember = serial.ms / 32
  console.log(`# GRP-4 cold start, 32 members, ${LATENCY_MS} ms per request: serial ${(serial.ms / 1000).toFixed(1)} s (${serial.requests} requests, ${(perMember / 1000).toFixed(2)} s per member) -> verifyConcurrency 8: ${(parallel.ms / 1000).toFixed(1)} s (${parallel.requests} requests)`)
  assert.ok(serial.ms >= 32 * 4 * LATENCY_MS, 'serial: every member costs several sequential round trips')
  assert.ok(parallel.ms <= serial.ms / 6, `8 at a time is at least 6x faster (${parallel.ms} vs ${serial.ms} ms)`)
  assert.ok(parallel.requests <= serial.requests, 'no extra requests: the same reads, only overlapped (batched where they meet)')
}))
