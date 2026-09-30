// TAPI-27 groups, second field review of 1.2.0 (GRP2): every finding is a test here, FIXED GRP2-<n>.
// TAPI-27 群聊 1.2.0 第二轮实测（GRP2）：每一项发现都写成测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { channel, TapeAPIError } from '../src/index.js'
import * as G from '../src/group.js'

const hex = (b) => '0x' + Buffer.from(b).toString('hex')
const C = (n) => '0x' + n.toString(16).padStart(40, '0')
const isGroupErr = (re) => (e) => e instanceof TapeAPIError && e.code === 'GROUP_INVALID' && (!re || re.test(e.message))
const entry = (m) => ({ container: m.container, chainId: 56, x25519: hex(m.identity.x25519.publicKey), ed25519: hex(m.identity.ed25519.publicKey) })
const TRUST = { verifyMember: 'trust-roster' }
const people = (n, base) => Array.from({ length: n }, (_, i) => ({ container: C(base + i), chainId: 56, identity: channel.generateIdentity() }))
// A settable clock in Unix seconds / 可调时钟（Unix 秒）
const manualClock = () => { let t = 1_800_000_000; const f = () => t; f.advance = (s) => { t += s }; return f }
// A verifier that records every call and whether it read past the cache / 记录每次调用及是否绕过缓存的核验器
function counting(answer = () => true) {
  const v = async (m, o = {}) => { v.calls.push({ container: m.container, fresh: o.fresh === true }); return answer(m) }
  v.calls = []
  return v
}
async function groupOf(ms, opts = {}) {
  const created = await G.createGroup({ self: ms[0], identity: ms[0].identity, members: ms.slice(1).map(entry), ...TRUST, ...opts })
  const invite = { gid: created.group.gid, owner: { container: ms[0].container, chainId: 56 }, ...(opts.format === 2 ? { format: 2 } : {}) }
  const join = async (m, o = {}) => {
    const g = G.joinGroup({ self: m, identity: m.identity, invite, ownerKeys: entry(ms[0]), ...(opts.clock ? { clock: opts.clock } : {}), ...o })
    await g.acceptEpoch(created.epochWire, TRUST)
    return g
  }
  return { ...created, owner: created.group, invite, join }
}
// sdk/src/group.js as a released version had it, loaded from git beside today's modules (as in group-v2.test.mjs)
// 某个已发布版本的 sdk/src/group.js，从 git 取出，与今天的其它模块放在一起加载
function released(rev) {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  let src
  try { src = execFileSync('git', ['show', `${rev}:sdk/src/group.js`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return null }
  src = src.replace(/from '\.\/([a-z-]+\.js)'/g, (_, f) => `from '${pathToFileURL(join(root, 'sdk/src', f)).href}'`)
    .replace(/from '(@noble\/[^']+)'/g, (_, f) => `from '${import.meta.resolve(f)}'`)
  const dir = mkdtempSync(join(tmpdir(), `tapi27-${rev}-`))
  writeFileSync(join(dir, 'group.mjs'), src)
  return pathToFileURL(join(dir, 'group.mjs')).href
}

test('FIXED GRP2-1: a format-2 owner reuses its positive verdicts: 128 members, removing one checks nobody; a new member is checked once, freshly', async () => {
  const clock = manualClock()
  const ms = people(129, 0x9000)
  const vm = counting()
  const { owner } = await groupOf(ms.slice(0, 128), { format: 2, verifyMember: vm, clock })
  assert.equal(vm.calls.length, 127, 'createGroup checks every other member once')
  vm.calls.length = 0
  const rm = await owner.removeMembers([ms[127].container])
  assert.equal(vm.calls.length, 0, 'removing one member: every other verdict is reused (1.2.0: 126 fresh checks)')
  assert.equal(rm.epoch, 1); assert.equal(owner.members.length, 127)
  await owner.rotate()
  assert.equal(vm.calls.length, 0, 'a rotation: the same')
  const add = await owner.addMembers([entry(ms[128])])
  assert.deepEqual(vm.calls, [{ container: ms[128].container, fresh: true }], 'the new member, once, past the cache (1.2.0: 128 checks, the new member twice)')
  assert.deepEqual(add.dropped, [])
  // reuse never extends a verdict: a rotation at 23 h reuses, the first one past 24 h reads everyone again, freshly
  // 复用不会续期结论：23 小时时的轮换复用，超过 24 小时后的第一次轮换重新读取每个人
  vm.calls.length = 0
  clock.advance(23 * 3600); await owner.rotate()
  assert.equal(vm.calls.length, 0)
  clock.advance(2 * 3600); await owner.rotate()
  assert.equal(vm.calls.length, 127, 'the verdicts of creation aged out: every member, once')
  assert.ok(vm.calls.every((c) => c.fresh), 'past the cache, as §3.6 reads')
  vm.calls.length = 0
  await owner.rotate()
  assert.equal(vm.calls.length, 0, 'and reused again from then')
})

test('FIXED GRP2-1: only a changed entry is checked; a sold circuit found on the daily re-check is dropped; verifyReuseS 0 restores checking everyone', async () => {
  const clock = manualClock()
  const ms = people(6, 0x9200)
  let sold = null
  const vm = counting((m) => m.container !== sold)
  const { owner } = await groupOf(ms, { format: 2, verifyMember: vm, clock })
  vm.calls.length = 0
  // same container, new keys: remove, then add the new entry: only it is read / 同一容器、新密钥：只读取它
  const rekeyed = { ...ms[3], identity: channel.generateIdentity() }
  await owner.removeMembers([ms[3].container])
  await owner.addMembers([entry(rekeyed)])
  assert.deepEqual(vm.calls.map((c) => c.container), [ms[3].container])
  // the owner's verdicts cover x25519 too: its handle knows both keys / 群主的结论也覆盖 x25519：它的句柄知道两把公钥
  const onlyX = { ...entry(ms[4]), x25519: hex(channel.generateIdentity().x25519.publicKey) }
  await owner.removeMembers([ms[4].container])
  vm.calls.length = 0
  await owner.addMembers([onlyX])
  assert.deepEqual(vm.calls.map((c) => c.container), [ms[4].container], 'a changed x25519 alone is a new entry for the owner')
  // a circuit sold meanwhile: the re-check once the verdicts age out drops it / 期间出售的电路：结论过期后的重新核验将其移除
  sold = ms[5].container
  vm.calls.length = 0
  await owner.rotate()
  assert.equal(vm.calls.length, 0, 'within the window the owner still relies on its verdict (the weakening §8 states)')
  clock.advance(24 * 3600 + 1)
  const r = await owner.rotate()
  assert.deepEqual(r.dropped, [ms[5].container])
  assert.equal(owner.members.some((m) => m.container === ms[5].container), false)
  // verifyReuseS 0: every member on every epoch, as 1.2.0 did / 每个纪元都核验全部成员，与 1.2.0 相同
  const v0 = counting()
  const g0 = await groupOf(ms.slice(0, 4), { format: 2, verifyMember: v0, verifyReuseS: 0, clock })
  v0.calls.length = 0
  await g0.owner.rotate()
  assert.equal(v0.calls.length, 3)
  await assert.rejects(G.createGroup({ format: 2, verifyReuseS: 86_401, self: ms[0], identity: ms[0].identity, members: [], ...TRUST }), (e) => e.code === 'INVALID_ARGUMENT')
})

test('FIXED GRP2-1: format 1 is unchanged: the owner checks every member on every epoch, and an added one twice', async () => {
  const ms = people(6, 0x9300)
  const vm = counting()
  const { owner } = await groupOf(ms.slice(0, 5), { verifyMember: vm })
  vm.calls.length = 0
  await owner.rotate()
  assert.equal(vm.calls.length, 4)
  vm.calls.length = 0
  await owner.addMembers([entry(ms[5])])
  assert.equal(vm.calls.length, 6, 'the new member first, then all five')
  assert.equal(vm.calls.filter((c) => c.container === ms[5].container).length, 2)
})

test('FIXED GRP2-2: a format-2 snapshot is v: 2, which TapeAPI 1.0.0 and 1.1.0 refuse instead of resuming it as format 1; 1.2.0\'s v: 1 format-2 snapshots still resume', async (t) => {
  const ms = people(3, 0x9400)
  const v2 = await groupOf(ms, { format: 2 })
  v2.owner.seal('x')
  const snap2 = JSON.parse(JSON.stringify(v2.owner.snapshot()))
  assert.equal(snap2.v, 2); assert.equal(snap2.format, 2)
  const v1 = await groupOf(ms)
  v1.owner.seal('x')
  const snap1 = JSON.parse(JSON.stringify(v1.owner.snapshot()))
  assert.equal(snap1.v, 1, 'format 1 is unchanged'); assert.equal('format' in snap1, false)
  // today's code resumes both, and a 1.2.0 format-2 snapshot (v: 1) / 今天的代码两者都能恢复，1.2.0 的格式 2 快照（v: 1）也能
  for (const s of [snap2, { ...snap2, v: 1 }]) {
    const r = await G.resumeGroup({ self: ms[0], identity: ms[0].identity, snapshot: s, ...TRUST })
    assert.equal(r.group.format, 2); assert.equal(r.epoch, 1)
  }
  assert.equal((await G.resumeGroup({ self: ms[0], identity: ms[0].identity, snapshot: snap1, ...TRUST })).group.format, 1)
  await assert.rejects(G.resumeGroup({ self: ms[0], identity: ms[0].identity, snapshot: { ...snap1, v: 2 }, ...TRUST }), isGroupErr(/v: 2 snapshot is a format-2 snapshot/))
  const member = await v2.join(ms[1])
  assert.equal(member.snapshot().v, 2, 'a member\'s too (joinGroup takes minEpoch and lastSeq from it, not the object)')
  // the released code: 1.1.0 (2b76f45) and 1.0.0 (6622364) / 已发布的代码
  for (const [name, rev] of [['1.1.0', '2b76f45'], ['1.0.0', '6622364']]) {
    const url = released(rev)
    if (!url) { t.diagnostic(`git history unavailable: the ${name} check is skipped`); continue }
    const Old = await import(url)
    await assert.rejects(Old.resumeGroup({ self: ms[0], identity: ms[0].identity, snapshot: snap2, ...TRUST }), isGroupErr(/resumeGroup needs an owner snapshot\(\)/), `${name} refuses a v: 2 snapshot`)
    // what 1.2.0's v: 1 made it do: resume the format-2 group as format 1, splitting it / 1.2.0 的 v: 1 曾让它把格式 2 群当作格式 1 恢复，使群分裂
    const split = await Old.resumeGroup({ self: ms[0], identity: ms[0].identity, snapshot: { ...snap2, v: 1 }, ...TRUST })
    await assert.rejects(member.acceptEpoch(split.epochWire, TRUST), isGroupErr(/format 1/), `${name}: the split the v: 2 now prevents`)
    assert.equal((await Old.resumeGroup({ self: ms[0], identity: ms[0].identity, snapshot: snap1, ...TRUST })).epoch, 1, `${name} still resumes a format-1 snapshot`)
  }
})

test('FIXED GRP2-3: the same identity on two devices is no longer silent: open() returns the other device\'s message with otherDevice, the handle reports it, and receivers say why they refuse', async () => {
  for (const format of [1, 2]) {
    const ms = people(3, 0x9500 + format * 16)
    const { owner, join } = await groupOf(ms, format === 2 ? { format } : {})
    const a = await join(ms[1])
    await new Promise((r) => setTimeout(r, 5))
    const b = await join(ms[1])                     // the same identity, installed later: higher seqs / 同一身份，晚装：序号更高
    const carol = await join(ms[2])
    const a1 = a.seal('from A'), b1 = b.seal('from B')
    assert.equal(a.open(a1).own, true, `format ${format}: our own echo is still { own: true }`)
    assert.equal(a.otherDevice, null)
    const got = a.open(b1, { text: true })
    assert.equal(got.otherDevice, true); assert.equal(got.own, undefined, 'not dropped as our own')
    assert.equal(got.data, 'from B'); assert.equal(got.from, ms[1].container); assert.equal(got.index, 1)
    if (format === 2) assert.equal(got.verified, true, 'our own entry: our slot names our keys')
    assert.deepEqual(a.otherDevice, { count: 1, epoch: 0, seq: got.seq.toString() })
    assert.throws(() => a.open(b1), isGroupErr(/already seen/), 'the other device\'s messages are replay-checked like anyone\'s')
    assert.equal(b.open(a1, { text: true }).otherDevice, true, 'and the other way round')
    assert.equal(b.otherDevice.count, 1)
    // a receiver hears B first; A's lower seqs are refused, and data says it may be two devices
    // 接收方先收到 B；A 的较低序号被拒，data 说明可能是两台设备
    assert.equal(carol.open(b1, { text: true }).data, 'from B')
    assert.throws(() => carol.open(a1), (e) => isGroupErr(/already seen/)(e) && e.data.mayBeOtherDevice === true && e.data.index === 1 && e.data.epoch === 0 &&
      typeof e.data.seq === 'string' && BigInt(e.data.high) > BigInt(e.data.seq) && /two devices/.test(e.data.hint))
    assert.equal(owner.open(a1, { text: true }).data, 'from A', 'a receiver that heard A first reads it')
  }
})

test('FIXED GRP2-3: a restarted handle given lastSeq takes its earlier messages for its own, not for another device\'s', async () => {
  for (const format of [1, 2]) {
    const ms = people(2, 0x9600 + format * 16)
    const { invite, epochWire } = await groupOf(ms, format === 2 ? { format } : {})
    const first = G.joinGroup({ self: ms[1], identity: ms[1].identity, invite, ownerKeys: entry(ms[0]) })
    await first.acceptEpoch(epochWire, TRUST)
    const before = first.seal('before the restart')
    const snap = first.snapshot()
    const again = G.joinGroup({ self: ms[1], identity: ms[1].identity, invite, ownerKeys: entry(ms[0]), lastSeq: snap.lastSeq })
    await again.acceptEpoch(epochWire, TRUST)
    assert.equal(again.open(before).own, true, `format ${format}`)
    assert.equal(again.otherDevice, null)
    // without lastSeq the same message looks like another device's (the guide says: pass lastSeq)
    // 不传 lastSeq 时，同一条消息看起来像另一台设备发的（指南写明：传入 lastSeq）
    const bare = G.joinGroup({ self: ms[1], identity: ms[1].identity, invite, ownerKeys: entry(ms[0]) })
    await bare.acceptEpoch(epochWire, TRUST)
    assert.equal(bare.open(before).otherDevice, true)
  }
})

test('FIXED GRP2-3: our own echoes are told apart by nonce, beyond the nonces kept', async () => {
  const ms = people(2, 0x9700)
  const { owner } = await groupOf(ms, { format: 2 })
  const wires = Array.from({ length: 1100 }, (_, i) => owner.seal('m' + i))
  assert.ok(wires.every((w) => owner.open(w).own === true), 'every echo, the oldest (whose nonces were dropped) included')
  assert.equal(owner.otherDevice, null)
})

test('FIXED GRP2-4: after resumeGroup, a message of the epoch before says "no key for epoch N (not in this handle\'s snapshot ...)", not "fails authentication"', async () => {
  for (const format of [1, 2]) {
    const ms = people(3, 0x9800 + format * 16)
    const { owner, join } = await groupOf(ms, format === 2 ? { format } : {})
    const bob = await join(ms[1])
    const m = bob.seal('while the owner was away')
    const mine = owner.seal('the owner, before its restart')
    const snap = JSON.parse(JSON.stringify(owner.snapshot()))
    const r = await G.resumeGroup({ self: ms[0], identity: ms[0].identity, snapshot: snap, ...TRUST })
    assert.equal(r.group.open(mine).own, true, 'its own earlier message is still its own (as in 1.2.0)')
    assert.throws(() => r.group.open(m), (e) => isGroupErr(/^no key for epoch 0 \(not in this handle's snapshot/)(e) && e.data.reason === 'snapshot' && e.data.epoch === 0 && e.data.current === 1, `format ${format}`)
    // a tampered message of that epoch is still refused as such: the signature is checked first / 篡改的消息仍按篡改拒收：先验签
    const bad = m.slice(); bad[bad.length - 70] ^= 1
    assert.throws(() => r.group.open(bad), isGroupErr(/not signed by member 1/))
    // the new epoch reads normally / 新纪元正常读取
    await bob.acceptEpoch(r.epochWire, TRUST)
    assert.equal(r.group.open(bob.seal('back'), { text: true }).data, 'back')
  }
})

test('FIXED GRP2-5: a message ahead of its epoch message says it can be retried (data.retryAfterEpoch); one of an epoch gone says expired', async () => {
  for (const format of [1, 2]) {
    const clock = manualClock()
    const ms = people(3, 0x9900 + format * 16)
    const { owner, join } = await groupOf(ms, { clock, ...(format === 2 ? { format } : {}) })
    const bob = await join(ms[1]), carol = await join(ms[2])
    const up = await owner.rotate()
    await bob.acceptEpoch(up.epochWire, TRUST)
    const early = bob.seal('epoch 1, before carol has it')
    assert.throws(() => carol.open(early), (e) => isGroupErr(/^no key for epoch 1 /)(e) && e.data.reason === 'not-yet' && e.data.retryAfterEpoch === 1 && e.data.current === 0, `format ${format}`)
    await carol.acceptEpoch(up.epochWire, TRUST)
    assert.equal(carol.open(early, { text: true }).data, 'epoch 1, before carol has it', 'the retry after the epoch message works')
    // before any epoch: not-yet too / 尚无任何纪元：同样是 not-yet
    const fresh = G.joinGroup({ self: ms[2], identity: ms[2].identity, invite: { gid: owner.gid, owner: { container: ms[0].container, chainId: 56 }, ...(format === 2 ? { format } : {}) }, ownerKeys: entry(ms[0]), clock })
    assert.throws(() => fresh.open(early), (e) => e.data.reason === 'not-yet' && e.data.retryAfterEpoch === 1 && e.data.current === null)
    // an epoch gone: expired, no retry / 已丢弃的纪元：expired，不可重试
    const old = bob.seal('x')
    const up2 = await owner.rotate(); await carol.acceptEpoch(up2.epochWire, TRUST)
    const up3 = await owner.rotate(); await carol.acceptEpoch(up3.epochWire, TRUST)
    assert.throws(() => carol.open(old), (e) => isGroupErr(/^no key for epoch 1 \(the epoch expired/)(e) && e.data.reason === 'expired' && !('retryAfterEpoch' in e.data))
  }
})
