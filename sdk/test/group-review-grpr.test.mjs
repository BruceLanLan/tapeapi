// Review of a5f5638 (parallel member checks, TAP-27 §3.8 format 2): every finding is a test here, FIXED GRPR-<n>.
// a5f5638（并行成员核验、TAP-27 §3.8 格式 2）的审查：每一项都写成测试，FIXED GRPR-<n>。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { x25519, ed25519 } from '@noble/curves/ed25519'
import { xchacha20poly1305 } from '@noble/ciphers/chacha'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { channel, TapeAPIError } from '../src/index.js'
import * as G from '../src/group.js'

const te = new TextEncoder()
const hex = (b) => '0x' + Buffer.from(b).toString('hex')
const unhex = (s) => Uint8Array.from(Buffer.from(s.replace(/^0x/, ''), 'hex'))
const C = (n) => '0x' + n.toString(16).padStart(40, '0')
const cat = (...xs) => { const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of xs) { out.set(x, o); o += x.length } return out }
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, Number(n)); return b }
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
const isGroupErr = (re) => (e) => e instanceof TapeAPIError && e.code === 'GROUP_INVALID' && (!re || re.test(e.message))
const entry = (m) => ({ container: m.container, chainId: 56, x25519: hex(m.identity.x25519.publicKey), ed25519: hex(m.identity.ed25519.publicKey) })
const TRUST = { verifyMember: 'trust-roster' }
const people = (n, base) => Array.from({ length: n }, (_, i) => ({ container: C(base + i), chainId: 56, identity: channel.generateIdentity() }))
// A settable clock in Unix seconds, shared by owner and members / 群主与成员共用的可调时钟（Unix 秒）
const manualClock = () => { let t = 1_800_000_000; const f = () => t; f.advance = (s) => { t += s }; return f }
async function v2Group(ms, opts = {}) {
  const created = await G.createGroup({ format: 2, self: ms[0], identity: ms[0].identity, members: ms.slice(1).map(entry), ...TRUST, ...opts })
  const invite = { gid: created.group.gid, owner: { container: ms[0].container, chainId: 56 }, format: 2 }
  const joiner = (m, o = {}) => G.joinGroup({ self: m, identity: m.identity, invite, ownerKeys: entry(ms[0]), ...(opts.clock ? { clock: opts.clock } : {}), ...o })
  return { ...created, owner: created.group, invite, joiner }
}
// A speaker per member, each having accepted the epoch on trust / 每个成员一个发言者（以信任方式接受纪元）
async function speakersOf(joiner, wire, ms) { const out = []; for (const m of ms) { const h = joiner(m); await h.acceptEpoch(wire, TRUST); out.push(h) } return out }

test('FIXED GRPR-1: a verifier rejecting with a falsy reason (Promise.reject(), throw undefined / null) aborts like any failure and never drops anyone', async () => {
  const falsy = [() => Promise.reject(), async () => { throw undefined }, async () => { throw null }, () => { throw undefined }]
  for (const format of [1, 2]) {
    const ms = people(4, 0x5100 + format * 16)
    const { group } = await G.createGroup({ ...(format === 2 ? { format } : {}), self: ms[0], identity: ms[0].identity, members: ms.slice(1).map(entry), ...TRUST })
    for (const vm of falsy) {
      // drop mode (rotate): 1.1.0 dropped nobody on a failure; neither does this / drop 模式：暂时故障不移除任何人
      await assert.rejects(group.rotate({ verifyMember: vm }), isGroupErr(/member 0x[0-9a-f]{40}: /), `format ${format}`)
      assert.equal(group.members.length, 4, 'nobody dropped')
      assert.equal(group.epoch, 0, 'no new epoch')
      await assert.rejects(G.createGroup({ ...(format === 2 ? { format } : {}), self: ms[0], identity: ms[0].identity, members: ms.slice(1).map(entry), verifyMember: vm }), isGroupErr(/verifyMember failed without giving a reason/))
    }
  }
  // format 2's lazy paths: no verdict, a reason that says so / 格式 2 惰性路径：不留结论，并说明原因
  const ms = people(3, 0x5180)
  const { epochWire, joiner } = await v2Group(ms)
  const [s] = await speakersOf(joiner, epochWire, [ms[2]])
  await assert.rejects(joiner(ms[1]).acceptEpoch(epochWire, { verifyMember: () => Promise.reject() }), isGroupErr(/without giving a reason/))
  const g = joiner(ms[1])
  let mode = 'reject'
  await g.acceptEpoch(epochWire, { verifyMember: async (m) => { if (m.container === ms[2].container && mode === 'reject') throw undefined; return true } })
  const r = await g.openVerified(s.seal('x'))
  assert.equal(r.verified, false); assert.equal(r.verifyError.code, 'ERROR'); assert.match(r.verifyError.message, /without giving a reason/)
  const scan = await g.verifyMembers()
  assert.deepEqual(scan.failed.map((f) => f.container), [ms[2].container]); assert.deepEqual(scan.mismatch, [])
  mode = 'ok'
  assert.equal((await g.openVerified(s.seal('y'))).verified, true)
})

test('FIXED GRPR-2: a verifier that throws SYNCHRONOUSLY leaves no rejected check cached: the next message is checked again', async () => {
  const ms = people(3, 0x5200)
  const { epochWire, joiner } = await v2Group(ms)
  const [s] = await speakersOf(joiner, epochWire, [ms[2]])
  let calls = 0, broken = true
  const vm = (m) => { calls++; if (m.container === ms[2].container && broken) throw new Error('sync boom'); return true }   // not async / 非 async
  const g = joiner(ms[1], { verifyMember: vm })
  await g.acceptEpoch(epochWire)
  const first = await g.openVerified(s.seal('1'))
  assert.equal(first.verified, false); assert.equal(first.verifyError.message, 'sync boom')
  const before = calls
  broken = false
  const second = await g.openVerified(s.seal('2'))
  assert.equal(second.verified, true, 'the healthy verifier is consulted again')
  assert.equal(calls, before + 1)
})

test('FIXED GRPR-3: openVerified, verifyMembers and the owner check share ONE verifyConcurrency limit per handle', async () => {
  const ms = people(40, 0x5300)
  const { epochWire, joiner } = await v2Group(ms)
  const speakers = await speakersOf(joiner, epochWire, ms.slice(2))
  let inflight = 0, peak = 0
  const vm = async () => { inflight++; peak = Math.max(peak, inflight); await sleep(3); inflight--; return true }
  const g = joiner(ms[1], { verifyMember: vm, verifyConcurrency: 4 })
  await g.acceptEpoch(epochWire)
  peak = 0
  // 38 senders speak at once and a background scan with 8 workers runs meanwhile / 38 个发送者同时发言，同时进行 8 个 worker 的后台扫描
  const opened = Promise.all(speakers.map((h, i) => g.openVerified(h.seal('m' + i))))
  const scan = g.verifyMembers({ concurrency: 8 })
  const [rs] = await Promise.all([opened, scan])
  assert.ok(rs.every((r) => r.verified))
  assert.ok(peak <= 4, `peak ${peak} concurrent checks, limit 4`)
  assert.ok(peak >= 2, 'still parallel')
  // default limit: VERIFY_CONCURRENCY / 默认上限
  const g8 = joiner(ms[1], { verifyMember: vm }); await g8.acceptEpoch(epochWire)
  peak = 0
  await Promise.all(speakers.map((h, i) => g8.openVerified(h.seal('n' + i))))
  assert.ok(peak <= G.VERIFY_CONCURRENCY, `peak ${peak}`)
})

test('FIXED GRPR-4: the owner\'s own handle (createGroup, resumeGroup) keeps its verifier: after the verdicts age out, openVerified still checks, with both keys', async () => {
  const clock = manualClock()
  const ms = people(3, 0x5400)
  const asked = []
  const vm = async (m) => { asked.push(m); return true }
  const { owner, epochWire, joiner } = await v2Group(ms, { verifyMember: vm, clock })
  const [s] = await speakersOf(joiner, epochWire, [ms[1]])
  clock.advance(25 * 3600)
  assert.deepEqual(owner.members.map((m) => m.verified), [false, false, false], 'the verdicts of the epoch aged out')
  asked.length = 0
  const r = await owner.openVerified(s.seal('after 25 h'), { text: true })
  assert.equal(r.verified, true)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].x25519, entry(ms[1]).x25519, 'the owner knows x25519 and passes it: api.groupVerifier() works here')
  // resumeGroup too / resumeGroup 同样
  const snap = JSON.parse(JSON.stringify(owner.snapshot()))
  const resumed = await G.resumeGroup({ self: ms[0], identity: ms[0].identity, snapshot: snap, verifyMember: vm, clock })
  await s.acceptEpoch(resumed.epochWire, TRUST)
  clock.advance(25 * 3600)
  asked.length = 0
  assert.equal((await resumed.group.openVerified(s.seal('after the restart'))).verified, true)
  assert.equal(asked.length, 1)
})

test('FIXED GRPR-5: joinGroup of a format-1 group ignores verifyMember and verifyReuseS, as 1.1.0 did; format 2 still checks them', async () => {
  const ms = people(2, 0x5500)
  const v1 = await G.createGroup({ self: ms[0], identity: ms[0].identity, members: [entry(ms[1])], ...TRUST })
  const invite = { gid: v1.group.gid, owner: { container: ms[0].container, chainId: 56 } }
  for (const extra of [{ verifyMember: async () => true }, { verifyReuseS: 'whatever' }, { verifyMember: 'trust-roster', verifyReuseS: -1 }]) {
    const h = G.joinGroup({ self: ms[1], identity: ms[1].identity, invite, ownerKeys: entry(ms[0]), ...extra })
    assert.equal(h.format, 1)
    await assert.rejects(h.acceptEpoch(v1.epochWire), isGroupErr(/verifyMember is required/), 'format 1 still asks acceptEpoch for its verifier')
    await h.acceptEpoch(v1.epochWire, TRUST)
  }
  assert.throws(() => G.joinGroup({ self: ms[1], identity: ms[1].identity, invite: { ...invite, format: 2 }, ownerKeys: entry(ms[0]), verifyReuseS: -1 }), (e) => e.code === 'INVALID_ARGUMENT')
})

test('FIXED GRPR-6: only a positive verdict lives 24 h; a negative one at most VERIFY_NEGATIVE_S (60 s), taken from a fresh read, and never reused to refuse an epoch', async () => {
  assert.equal(G.VERIFY_NEGATIVE_S, 60)
  const clock = manualClock()
  const ms = people(4, 0x5600)
  const { epochWire, joiner } = await v2Group(ms, { clock })
  const [s] = await speakersOf(joiner, epochWire, [ms[2]])
  // (a) acceptEpoch: a "no" about the owner is asked again at once / 关于群主的"否"会立即重新询问
  let ownerOk = false
  const fresh = []
  const vm = async (m, o) => { fresh.push([m.container, !!o?.fresh]); return m.container === ms[0].container ? ownerOk : m.container !== ms[2].container || senderOk }
  let senderOk = false
  const g = joiner(ms[1], { verifyMember: vm })
  await assert.rejects(g.acceptEpoch(epochWire), isGroupErr(/keys do not match/))
  assert.deepEqual(fresh, [[ms[0].container, false], [ms[0].container, true]], 'a "no" is confirmed past the identity cache before it counts')
  ownerOk = true
  await g.acceptEpoch(epochWire)
  // (b) a sender found not to match: refused without RPC for up to 60 s, then checked again / 发送者不符：60 秒内不发请求直接拒收，之后重新核验
  await assert.rejects(g.openVerified(s.seal('1')), isGroupErr(/its messages are refused/))
  senderOk = true                                   // the record is fixed (published late, or the node caught up) / 记录已修正
  const n = fresh.length
  clock.advance(59)
  assert.throws(() => g.open(s.seal('2')), isGroupErr(/its messages are refused/))
  assert.equal(fresh.length, n, 'no chain read inside the window')
  clock.advance(2)
  assert.equal(g.open(s.seal('3')).verified, false, 'after 60 s: unverified again, no longer refused')
  assert.equal((await g.openVerified(s.seal('4'))).verified, true)
  // (c) channelKeysVerifier: a NOT_FOUND the identity cache still holds is not a verdict when a fresh read finds the record
  // channelKeysVerifier：身份缓存里残留的 NOT_FOUND，在新鲜读取找到记录时不算结论
  const recs = Object.fromEntries([ms[0], ms[3]].map((m) => [m.container, { x25519: entry(m).x25519, ed25519: entry(m).ed25519 }]))
  const reads = []
  const api = {
    chainId: 56,
    chain: {
      channelKeys: async (c, { fresh: f = false } = {}) => {
        if (c !== ms[3].container) return recs[c]
        reads.push(f)
        if (!f) throw new TapeAPIError('NOT_FOUND', 'cached: no record')   // what the identity cache still holds / 身份缓存里残留的
        return recs[c]
      },
    },
  }
  const [s3] = await speakersOf(joiner, epochWire, [ms[3]])
  const h = joiner(ms[1], { verifyMember: G.channelKeysVerifier(api) })
  await h.acceptEpoch(epochWire)
  assert.equal((await h.openVerified(s3.seal('late record'))).verified, true)
  assert.deepEqual(reads, [false, true])
  // (d) a positive verdict still lives 24 h / 肯定结论仍保留 24 小时
  clock.advance(86_399)
  assert.equal(h.open(s3.seal('still')).verified, true)
  clock.advance(1)
  assert.equal(h.open(s3.seal('aged')).verified, false)
})

test('FIXED GRPR-6 (window): a verdict counts from the START of its check, not its end', async () => {
  const clock = manualClock()
  const ms = people(3, 0x5680)
  const { epochWire, joiner } = await v2Group(ms, { clock })
  const [s] = await speakersOf(joiner, epochWire, [ms[2]])
  const slow = async (m) => { if (m.container === ms[2].container) clock.advance(200); return true }   // a 200 s check / 耗时 200 秒的核验
  const g = joiner(ms[1], { verifyMember: slow, verifyReuseS: 300 })
  await g.acceptEpoch(epochWire)
  assert.equal((await g.openVerified(s.seal('a'))).verified, true)
  clock.advance(99)                                   // 299 s after the check started / 核验开始后 299 秒
  assert.equal(g.open(s.seal('b')).verified, true)
  clock.advance(1)                                    // 300 s after it started, 100 s after it ended / 开始后 300 秒
  assert.equal(g.open(s.seal('c')).verified, false)
})

test('FIXED GRPR-7: every refusal of a format-2 roster is GROUP_INVALID, relays and bus included', async () => {
  const ms = people(3, 0x5700)
  const { owner, joiner } = await v2Group(ms)
  const K = new Uint8Array(32).fill(7), e = new Uint8Array(32).fill(9), N = new Uint8Array(24).fill(3)
  const gid = unhex(owner.gid)
  const craft = (rosterBytes) => {
    const E = x25519.getPublicKey(e)
    const ef = cat(u32(G.FORMAT_V2_MARK), u32(5))
    const header = cat(Uint8Array.of(4), gid, ef, E, N, sha256(cat(te.encode('TAP-27/commit/v2'), K)), Uint8Array.of(0, 3))
    const slots = cat(...ms.map((m) => { const R = m.identity.x25519.publicKey; return xchacha20poly1305(hkdf(sha256, x25519.getSharedSecret(e, R), te.encode('TAP-27/wrap/v2'), cat(E, R, gid, ef), 32), N, header).encrypt(K) }))
    const ct = xchacha20poly1305(K, N, cat(header, slots)).encrypt(rosterBytes)
    const body = cat(header, slots, u32(ct.length), ct)
    return cat(body, ed25519.sign(cat(te.encode('TAP-27/epoch/v2'), body), ms[0].identity.ed25519.secretKey))
  }
  const rosterOf = (tail) => {
    const t = te.encode(tail)
    const ents = ms.map((m) => cat(unhex(m.container), u32(56), m.identity.ed25519.publicKey))
    return cat(te.encode('TGR2'), new Uint8Array(4), u32(Math.floor(Date.now() / 1000)), new Uint8Array(32), Uint8Array.of(0, 3), ...ents, Uint8Array.of(t.length >> 8, t.length & 255), t)
  }
  await joiner(ms[1]).acceptEpoch(craft(rosterOf('{"relays":[]}')), TRUST)          // well-formed / 合规
  for (const tail of ['{"relays":null}', '{"relays":["x"]}', '{"relays":{"length":0}}', '{"bus":"nope","relays":[]}', '{"relays":[{"container":"0x1111111111111111111111111111111111111111","url":"http://relay.example/"}]}']) {
    await assert.rejects(joiner(ms[1]).acceptEpoch(craft(rosterOf(tail)), TRUST), isGroupErr(/format-2 roster relays\/bus: /), tail)
  }
})

test('FIXED GRPR-8: verifyMembers reports each list in roster order, whatever order the checks end in', async () => {
  const ms = people(10, 0x5800)
  const { epochWire, joiner } = await v2Group(ms)
  const idx = (c) => ms.findIndex((m) => m.container === c)
  // later members answer first; odd ones do not match, every third fails / 靠后的先回答；奇数号不符，每第三个失败
  const vm = async (m) => { const i = idx(m.container); await sleep(2 * (10 - i)); if (i > 0 && i % 3 === 0) throw new TapeAPIError('RPC_UNAVAILABLE', 'down'); return i === 0 || i % 2 === 0 }
  const g = joiner(ms[1], { verifyMember: vm })
  await g.acceptEpoch(epochWire)
  const r = await g.verifyMembers({ concurrency: 9 })
  const sorted = (xs) => [...xs].sort((a, b) => idx(a) - idx(b))
  assert.deepEqual(r.verified, sorted(r.verified)); assert.deepEqual(r.mismatch, sorted(r.mismatch))
  assert.deepEqual(r.failed.map((f) => f.container), sorted(r.failed.map((f) => f.container)))
  assert.deepEqual(r.failed.map((f) => idx(f.container)), [3, 6, 9])
  assert.deepEqual(r.mismatch.map(idx), [1, 5, 7])
})
