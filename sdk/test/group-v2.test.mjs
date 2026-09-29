// TAP-27 §3.8 format 2 (Experimental): up to 128 members in one wire message, a binary roster, and lazy §3.3 step 6.
// Every finding of the review of the large-group design is a test here: FIXED GRP-<n> (it now holds) or CONFIRMED GRP-<n>
// (a property that was attacked and held).
// TAP-27 §3.8 格式 2（实验性）：单条线路消息至多 128 人、二进制名单、惰性第 6 步。大群设计审查的每一项都写成测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { x25519, ed25519 } from '@noble/curves/ed25519'
import { xchacha20poly1305 } from '@noble/ciphers/chacha'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { createTapeAPI, channel, sig, TapeAPIError, CHANNEL_KEYS_KEY, canonicalJSON, deliverGroupUpdate, checkGroupInvites } from '../src/index.js'
import * as G from '../src/group.js'
import { createFakeChain, ADDR } from './helpers/fake-chain.mjs'
import { virtualClock, withClock } from './helpers/clock.mjs'
import { createRelayCore, relayMethods } from '../../examples/relay-service/relay-core.mjs'

const te = new TextEncoder()
const hex = (b) => '0x' + Buffer.from(b).toString('hex')
const unhex = (s) => Uint8Array.from(Buffer.from(s.replace(/^0x/, ''), 'hex'))
const C = (n) => '0x' + n.toString(16).padStart(40, '0')
const cat = (...xs) => { const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of xs) { out.set(x, o); o += x.length } return out }
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, Number(n)); return b }
const isGroupErr = (re) => (e) => e instanceof TapeAPIError && e.code === 'GROUP_INVALID' && (!re || re.test(e.message))
const invalid = (re) => (e) => e instanceof TapeAPIError && e.code === 'INVALID_ARGUMENT' && re.test(e.message)
const entry = (m) => ({ container: m.container, chainId: 56, x25519: hex(m.identity.x25519.publicKey), ed25519: hex(m.identity.ed25519.publicKey) })
const TRUST = { verifyMember: 'trust-roster' }
const MARK = [0x54, 0x47, 0x02, 0x00]
const WORST_RELAYS = Array.from({ length: 4 }, (_, i) => ({ url: `https://relay${i}.example/` + 'r'.repeat(512 - 23), container: C(0xe00 + i) }))

function people(n, base = 0x7000) {
  return Array.from({ length: n }, (_, i) => ({ container: C(base + i), chainId: 56, identity: channel.generateIdentity() }))
}
async function v2Group(ms, opts = {}) {
  const created = await G.createGroup({ format: 2, self: ms[0], identity: ms[0].identity, members: ms.slice(1).map(entry), relays: [{ url: 'https://relay.example/tapeapi/v1', container: C(0xe00) }], ...TRUST, ...opts })
  const invite = { gid: created.group.gid, owner: { container: ms[0].container, chainId: 56 }, format: 2 }
  const joiner = (m, o = {}) => G.joinGroup({ self: m, identity: m.identity, invite, ownerKeys: entry(ms[0]), ...o })
  return { ...created, owner: created.group, invite, joiner }
}
// A verifier that records what it was asked and answers per container / 记录调用并按容器作答的核验器
function counting(verdicts = {}) {
  const v = async (m) => {
    v.calls.push(m.container)
    const what = verdicts[m.container] ?? 'ok'
    if (what === 'rpc') throw new TapeAPIError('RPC_UNAVAILABLE', 'no node answered')
    return what === 'ok'
  }
  v.calls = []
  return v
}

test('FIXED GRP-5: format 2 carries 128 members in ONE wire message (104 bytes a member), even with the largest relays a roster allows; 129 is refused', async () => {
  const ms = people(128)
  for (const relays of [[{ url: 'https://relay.tapeapi.fun/tapeapi/v1', container: C(0xe00) }], WORST_RELAYS]) {
    const { owner, epochWire, joiner } = await v2Group(ms, { relays, bus: C(0xb05) })
    assert.ok(epochWire.length <= G.MAX_WIRE, `${epochWire.length} bytes fit one wire message`)
    assert.equal(owner.format, 2)
    assert.deepEqual([...epochWire.subarray(17, 21)], MARK, 'the format-2 mark in the high half of the epoch field')
    const last = joiner(ms[127])
    const r = await last.acceptEpoch(epochWire, TRUST)
    assert.equal(r.roster.members.length, 128)
    assert.deepEqual(r.roster.relays, relays)
    assert.equal('x25519' in r.roster.members[1], false, 'other members\' X25519 keys are not in a format-2 roster')
    assert.equal(last.open(owner.seal('hi from the owner'), { text: true }).data, 'hi from the owner')
    assert.equal(owner.open(last.seal('hi from 127'), { text: true }).from, ms[127].container)
    if (relays.length === 1) {
      // per member: 48 (slot) + 20 + 4 + 32 (entry) = 104 / 每人 104 字节
      const small = (await v2Group(people(2, 0x7400), { relays, bus: C(0xb05) })).epochWire.length
      assert.equal((epochWire.length - small) / 126, 104)
    } else assert.ok(epochWire.length > 15_900, 'the worst case is close to the limit: 128 keeps a margin (132 would be the edge)')
  }
  await assert.rejects(G.createGroup({ format: 2, self: ms[0], identity: ms[0].identity, members: [...ms.slice(1), ...people(1, 0x7900)].map(entry), ...TRUST }), isGroupErr(/at most 128 members/))
  const { owner } = await v2Group(ms.slice(0, 127))
  await assert.rejects(owner.addMembers(people(2, 0x7a00).map(entry), TRUST), isGroupErr(/format-2 group has at most 128 members/))
  await owner.addMembers(people(1, 0x7b00).map(entry), TRUST)
  assert.equal(owner.members.length, 128)
  assert.equal(G.MAX_MEMBERS_V2, 128)
  assert.equal(G.MAX_MEMBERS, 32, 'format 1 is unchanged')
})

// The code a released format-1 client runs: sdk/src/group.js as of TapeAPI 1.1.0, loaded from git beside today's modules.
// 已发布的格式 1 客户端所运行的代码：TapeAPI 1.1.0 时的 sdk/src/group.js，从 git 取出，与今天的其它模块放在一起加载。
function released(file = 'sdk/src/group.js', rev = '2b76f45') {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  let src
  try { src = execFileSync('git', ['show', `${rev}:${file}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return null }
  src = src.replace(/from '\.\/([a-z-]+\.js)'/g, (_, f) => `from '${pathToFileURL(join(root, 'sdk/src', f)).href}'`)
    .replace(/from '(@noble\/[^']+)'/g, (_, f) => `from '${import.meta.resolve(f)}'`)
  const dir = mkdtempSync(join(tmpdir(), 'tap27-1.1.0-'))
  writeFileSync(join(dir, 'group.mjs'), src)
  return pathToFileURL(join(dir, 'group.mjs')).href
}

test('FIXED GRP-6: a format-1 client meets a format-2 group: it opens the invite, then gets GROUP_INVALID for every epoch message and group message, and nothing changes', async (t) => {
  const ms = people(4, 0x7c00)
  const { owner, epochWire, invite } = await v2Group(ms)
  const wire = owner.inviteFor(entry(ms[1]))
  const inv = G.openGroupInvite(wire, { self: { container: ms[1].container, chainId: 56, staticSecret: ms[1].identity.x25519.secretKey } })
  assert.equal(inv.kind, 'tape.group/invite', 'the same invite kind: a format-1 client does not skip it in silence')
  assert.equal(inv.format, 2)
  const msg = owner.seal('can you read this?')

  // 1) The released 1.1.0 module, as a format-1 client runs it / 已发布的 1.1.0 模块
  const url = released()
  if (!url) t.diagnostic('git history unavailable: the released-module check is skipped')
  else {
    const Old = await import(url)
    assert.equal(Old.MAX_MEMBERS, 32)
    const oldInv = Old.openGroupInvite(wire, { self: { container: ms[1].container, chainId: 56, staticSecret: ms[1].identity.x25519.secretKey } })
    assert.equal(oldInv.format, 2, 'the released code opens the invite (the extra field is carried, not refused)')
    const g = Old.joinGroup({ self: ms[1], identity: ms[1].identity, invite: oldInv, ownerKeys: entry(ms[0]) })
    await assert.rejects(g.acceptEpoch(epochWire, TRUST), (e) => e.code === 'GROUP_INVALID' && /bad member count/.test(e.message))
    assert.equal(g.epoch, null)
    assert.throws(() => g.open(msg), (e) => e.code === 'GROUP_INVALID' && /epoch out of range/.test(e.message))
  }

  // 2) Today's module holding a format-1 handle (an application that dropped the invite's `format`) names the format
  // 今天的模块持有格式 1 句柄（应用丢掉了邀请里的 format）：点名格式
  const g1 = G.joinGroup({ self: ms[2], identity: ms[2].identity, invite: { gid: invite.gid, owner: invite.owner }, ownerKeys: entry(ms[0]) })
  assert.equal(g1.format, 1)
  await assert.rejects(g1.acceptEpoch(epochWire, TRUST), (e) => isGroupErr(/format 2 .*this group is format 1.*needs a client that supports format 2/)(e) && e.data.format === 2 && e.data.groupFormat === 1)
  assert.throws(() => g1.open(msg), (e) => isGroupErr(/epoch out of range: a format-2 group message/)(e) && e.data.format === 2)
  assert.equal(g1.epoch, null)
  // an invite of a format this client does not know is refused when opened / 不认识的格式在打开邀请时就拒绝
  assert.throws(() => G.joinGroup({ self: ms[3], identity: ms[3].identity, invite: { ...invite, format: 3 }, ownerKeys: entry(ms[0]) }), invalid(/invite\.format must be 1 or 2/))
  assert.throws(() => G.joinGroup({ self: ms[3], identity: ms[3].identity, invite, format: 1, ownerKeys: entry(ms[0]) }), isGroupErr(/format-2 group, not format 1/))
})

test('FIXED GRP-7: one group, one format: a format-2 handle refuses format-1 frames and unknown marks with GROUP_INVALID and changes nothing', async () => {
  const ms = people(3, 0x7d00)
  const { owner, epochWire, joiner } = await v2Group(ms)
  const g = joiner(ms[1])
  await g.acceptEpoch(epochWire, TRUST)
  // the same people, a format-1 group with the same gid is not possible, so forge format-1 frames with this gid
  // 同一 gid 的格式 1 群不存在，于是用本群 gid 伪造格式 1 帧
  const v1 = await G.createGroup({ self: ms[0], identity: ms[0].identity, members: ms.slice(1).map(entry), ...TRUST, random: ((gid) => { let first = true; return (n) => { if (first && n === 16) { first = false; return gid.slice() } return crypto.getRandomValues(new Uint8Array(n)) } })(unhex(owner.gid)) })
  assert.equal(v1.group.gid, owner.gid)
  await assert.rejects(g.acceptEpoch(v1.epochWire, TRUST), (e) => isGroupErr(/format 1 \(TAP-27 v1\); this group is format 2/)(e) && e.data.format === 1)
  assert.throws(() => g.open(v1.group.seal('v1 words')), (e) => isGroupErr(/this group message is format 1/)(e) && e.data.format === 1)
  const odd = owner.seal('odd mark'); odd[20] = 0x01
  assert.throws(() => g.open(odd), isGroupErr(/unknown format/))
  const oddEpoch = epochWire.slice(); oddEpoch[18] ^= 1
  await assert.rejects(g.acceptEpoch(oddEpoch, TRUST), isGroupErr(/unknown format/))
  assert.equal(g.epoch, 0)
  assert.equal(g.open(owner.seal('still here'), { text: true }).data, 'still here')
})

test('FIXED GRP-8: lazy §3.3 step 6: accepting checks only the owner entry; a sender is checked before its message is shown as verified; a mismatch is refused', async () => {
  const ms = people(40, 0x7e00)
  const { owner, epochWire, joiner } = await v2Group(ms)
  const bad = ms[7].container, flaky = ms[9].container
  const vm = counting({ [bad]: 'bad', [flaky]: 'rpc' })
  const g = joiner(ms[1], { verifyMember: vm })
  const r = await g.acceptEpoch(epochWire)
  assert.deepEqual(vm.calls, [ms[0].container], 'one check at acceptance (the owner entry), not 40')
  assert.equal(r.unverified, 39)
  assert.deepEqual(g.members.filter((m) => m.verified).map((m) => m.container), [ms[0].container])

  const speakers = [3, 7, 9].map((i) => { const h = joiner(ms[i]); return h })
  for (const h of speakers) await h.acceptEpoch(epochWire, TRUST)
  // open(): synchronous, no RPC; the sender is marked unverified / 同步、不发请求；发送者标为未核验
  const m3 = g.open(speakers[0].seal('hello from 3'), { text: true })
  assert.equal(m3.verified, false)
  assert.equal(m3.from, ms[3].container, 'who the roster says, for an interface to show as unverified')
  // openVerified(): checks the sender once, then its messages are verified without another check
  // openVerified()：核验一次发送者，此后其消息无需再查即为已核验
  const v3 = await g.openVerified(speakers[0].seal('again'), { text: true })
  assert.deepEqual([v3.verified, v3.data], [true, 'again'])
  assert.equal(vm.calls.filter((c) => c === ms[3].container).length, 1)
  assert.equal(g.open(speakers[0].seal('third'), { text: true }).verified, true)
  assert.equal(vm.calls.filter((c) => c === ms[3].container).length, 1, 'the verdict is reused')
  // a definitive mismatch refuses the message, and every later one from that entry / 确定不符：拒收这条及其后所有消息
  await assert.rejects(g.openVerified(speakers[1].seal('I am 7')), (e) => isGroupErr(/member 7 .*do not match its channel record; its messages are refused/)(e) && e.data.mismatch === true)
  assert.throws(() => g.open(speakers[1].seal('still 7')), isGroupErr(/its messages are refused/))
  assert.equal(g.members[7].mismatch, true)
  assert.equal(g.members[7].verified, false)
  // an RPC failure decides nothing: verified false with the reason, checked again next time / RPC 故障不作判定
  const f = await g.openVerified(speakers[2].seal('from 9'), { text: true })
  assert.equal(f.verified, false); assert.equal(f.data, 'from 9'); assert.equal(f.verifyError.code, 'RPC_UNAVAILABLE')
  await g.openVerified(speakers[2].seal('from 9 again'))
  assert.equal(vm.calls.filter((c) => c === flaky).length, 2, 'no verdict was kept for the failure')
  // background scan of the rest, bounded / 其余成员的后台扫描，有并发上限
  const scan = await g.verifyMembers({ concurrency: 4 })
  assert.equal(scan.verified.length, 36)
  assert.deepEqual(scan.mismatch, [])
  assert.deepEqual(scan.failed.map((x) => x.container), [flaky])
  assert.equal(g.members.filter((m) => m.verified).length, 38)
  // format 1 is unchanged: open() carries no `verified`, and a verifyMember option is ignored, as in 1.1.0 (GRPR-5) / 格式 1 不变
  const v1 = await G.createGroup({ self: ms[0], identity: ms[0].identity, members: [entry(ms[1])], ...TRUST })
  const h1 = G.joinGroup({ self: ms[1], identity: ms[1].identity, invite: { gid: v1.group.gid, owner: { container: ms[0].container, chainId: 56 } }, ownerKeys: entry(ms[0]) })
  await h1.acceptEpoch(v1.epochWire, TRUST)
  assert.equal('verified' in h1.open(v1.group.seal('x')), false)
  assert.equal(typeof h1.openVerified, 'undefined')
  assert.equal(G.joinGroup({ self: ms[1], identity: ms[1].identity, invite: { gid: v1.group.gid, owner: { container: ms[0].container, chainId: 56 } }, ownerKeys: entry(ms[0]), verifyMember: vm }).format, 1)
  // no verifier anywhere is a mistake, as in format 1 / 没有核验器是错误
  const nov = joiner(ms[2])
  await assert.rejects(nov.acceptEpoch(epochWire), isGroupErr(/verifyMember is required/))
  // the format-1 habit, a verifier given to acceptEpoch, serves the lazy checks too / 格式 1 的习惯同样可用
  const habit = counting()
  await nov.acceptEpoch(epochWire, { verifyMember: habit })
  assert.equal((await nov.openVerified(speakers[0].seal('habit'))).verified, true)
  assert.deepEqual(habit.calls, [ms[0].container, ms[3].container])
  void owner
})

test('FIXED GRP-9: a verdict is reused across epochs only within verifyReuseS (default and maximum 86,400 s); a changed entry is checked again', () => withClock(virtualClock(), async (clock) => {
  const ms = people(6, 0x7f00)
  const { owner, epochWire, joiner } = await v2Group(ms)
  const vm = counting()
  const g = joiner(ms[1], { verifyMember: vm })
  await g.acceptEpoch(epochWire)
  const s = joiner(ms[2]); await s.acceptEpoch(epochWire, TRUST)
  await g.openVerified(s.seal('a'))
  assert.equal(vm.calls.length, 2)                                    // owner + ms[2]
  // next epoch, same entries: nothing checked again / 下一纪元、条目未变：不再核验
  const up = await owner.rotate(TRUST)
  await g.acceptEpoch(up.epochWire); await s.acceptEpoch(up.epochWire, TRUST)
  assert.equal(g.open(s.seal('b')).verified, true)
  assert.equal(vm.calls.length, 2)
  // after 24 h the verdicts have aged out: the owner entry is checked at the next epoch, the sender when it speaks
  // 24 小时后结论过期：下一纪元时核验群主条目，发言时核验发送者
  clock.advance(86_400_000)
  const up2 = await owner.rotate(TRUST)
  await g.acceptEpoch(up2.epochWire); await s.acceptEpoch(up2.epochWire, TRUST)
  assert.equal(vm.calls.length, 3)
  assert.equal(g.open(s.seal('c')).verified, false)
  await g.openVerified(s.seal('d'))
  assert.equal(vm.calls.length, 4)
  // a changed entry (the member re-keyed: another ed25519) is a new entry, never covered by the old verdict
  // 条目变了（成员换了 ed25519）就是新条目，旧结论不覆盖它
  const rekeyed = { ...ms[2], identity: channel.generateIdentity() }
  await owner.removeMembers([ms[2].container], TRUST)                         // epoch 3
  const up4 = await owner.addMembers([entry(rekeyed)], TRUST)                 // epoch 4: same container, new keys / 同一容器、新密钥
  await g.acceptEpoch(up4.epochWire)
  const s2 = joiner(rekeyed); await s2.acceptEpoch(up4.epochWire, TRUST)
  assert.equal(g.epoch, 4)
  assert.equal(vm.calls.length, 4, 'the owner entry is unchanged and its verdict fresh')
  assert.equal(g.open(s2.seal('new keys')).verified, false)
  // a shorter window; 0 means every display checks (the client's identity cache still bounds the reads)
  // 更短的窗口；0 表示每次展示都核验
  const g0 = joiner(ms[3], { verifyMember: counting(), verifyReuseS: 0 })
  await g0.acceptEpoch(owner.epochWire)
  const s4 = joiner(ms[4]); await s4.acceptEpoch(owner.epochWire, TRUST)
  assert.equal((await g0.openVerified(s4.seal('x'))).verified, true)
  assert.equal(g0.open(s4.seal('y')).verified, false)
  for (const bad of [-1, 86_401, 1.5, '60']) assert.throws(() => joiner(ms[3], { verifyReuseS: bad }), invalid(/verifyReuseS must be an integer in 0\.\.86400/))
  assert.equal(G.VERIFY_REUSE_S, 86_400)
}))

test('CONFIRMED GRP-10: what format 2 keeps: owner signature, commitment, rollback floor, equivocation evidence, removed members locked out, strict roster', async () => {
  const ms = people(5, 0x8000)
  const { owner, epochWire, joiner, group } = await v2Group(ms)
  void group
  const g = joiner(ms[1])
  // signature over "TAP-27/epoch/v2": a format-1 signature over the same bytes, or any change, fails
  const forged = epochWire.slice(); forged[forged.length - 70] ^= 1
  await assert.rejects(g.acceptEpoch(forged, TRUST), isGroupErr(/not signed by the owner/))
  const resigned = cat(epochWire.subarray(0, epochWire.length - 64), ed25519.sign(cat(te.encode('TAP-27/epoch/v1'), epochWire.subarray(0, epochWire.length - 64)), ms[0].identity.ed25519.secretKey))
  await assert.rejects(g.acceptEpoch(resigned, TRUST), isGroupErr(/not signed by the owner/), 'the format-1 signature domain does not verify')
  await g.acceptEpoch(epochWire, TRUST)
  // equivocation: a second owner-signed message for epoch 0 / 两面行为
  const rebuilt = G.buildEpochV2({ gid: unhex(owner.gid), epoch: 0, issued: Math.floor(Date.now() / 1000), prev: '00'.repeat(32), owner: { container: ms[0].container, chainId: 56 }, members: ms.map(entry), ownerEdSecret: ms[0].identity.ed25519.secretKey })
  await assert.rejects(g.acceptEpoch(rebuilt.wire, TRUST), (e) => e.code === 'GROUP_EQUIVOCATION')
  // removal: the removed member cannot read the next epoch / 被移除者读不到下一纪元
  const out = joiner(ms[4]); await out.acceptEpoch(epochWire, TRUST)
  const up = await owner.removeMembers([ms[4].container], TRUST)
  await assert.rejects(out.acceptEpoch(up.epochWire, TRUST), isGroupErr(/no slot in this epoch opens with our key/))
  await g.acceptEpoch(up.epochWire, TRUST)
  assert.throws(() => out.open(g.seal('after removal')), isGroupErr(/no key for epoch 1/))
  // a removed member's messages under the old epoch are refused / 被移除者在旧纪元下的消息被拒
  assert.throws(() => g.open(out.seal('old epoch')), isGroupErr(/was removed after epoch 0/))
  // rollback floor / 回滚下限
  const again = joiner(ms[1], { minEpoch: 1 })
  await assert.rejects(again.acceptEpoch(epochWire, TRUST), isGroupErr(/below 1/))
  // strict roster: re-encrypt a roster the owner did not write and sign it with a non-owner key: refused at step 1;
  // signed by the owner but inconsistent (duplicate entry, non-canonical tail, other owner key): refused at step 5
  // 严格名单：内容不一致的（重复条目、非规范尾部、群主密钥不符）即使由群主签名也拒绝
  const K = new Uint8Array(32).fill(7), e = new Uint8Array(32).fill(9), N = new Uint8Array(24).fill(3)
  const gid = unhex(owner.gid)
  const craft = (rosterBytes, count = 3, list = ms.slice(0, 3)) => {
    const E = x25519.getPublicKey(e)
    const ef = cat(Uint8Array.from(MARK), u32(5))
    const header = cat(Uint8Array.of(4), gid, ef, E, N, sha256(cat(te.encode('TAP-27/commit/v2'), K)), Uint8Array.of(0, count))
    const slots = cat(...list.map((m) => { const R = m.identity.x25519.publicKey; return xchacha20poly1305(hkdf(sha256, x25519.getSharedSecret(e, R), te.encode('TAP-27/wrap/v2'), cat(E, R, gid, ef), 32), N, header).encrypt(K) }))
    const ct = xchacha20poly1305(K, N, cat(header, slots)).encrypt(rosterBytes)
    const body = cat(header, slots, u32(ct.length), ct)
    return cat(body, ed25519.sign(cat(te.encode('TAP-27/epoch/v2'), body), ms[0].identity.ed25519.secretKey))
  }
  const ent = (m, ed = m.identity.ed25519.publicKey) => cat(unhex(m.container), u32(56), ed)
  const rosterOf = (entries, tail = '{"relays":[]}', count = entries.length) => {
    const t = te.encode(tail)
    const out = cat(te.encode('TGR2'), new Uint8Array(4), u32(Math.floor(Date.now() / 1000)), new Uint8Array(32), Uint8Array.of(count >> 8, count & 255), ...entries, Uint8Array.of(t.length >> 8, t.length & 255), t)
    return out
  }
  const fresh = () => joiner(ms[1])
  await fresh().acceptEpoch(craft(rosterOf([ent(ms[0]), ent(ms[1]), ent(ms[2])])), TRUST)        // well-formed: accepted / 合规则接受
  await assert.rejects(fresh().acceptEpoch(craft(rosterOf([ent(ms[0]), ent(ms[1]), ent(ms[1])])), TRUST), isGroupErr(/twice/))
  await assert.rejects(fresh().acceptEpoch(craft(rosterOf([ent(ms[0]), ent(ms[1]), ent(ms[2])], '{ "relays":[]}')), TRUST), isGroupErr(/not canonical/))
  await assert.rejects(fresh().acceptEpoch(craft(rosterOf([ent(ms[0]), ent(ms[1]), ent(ms[2])], '{"extra":1,"relays":[]}')), TRUST), isGroupErr(/exactly \{ relays, bus\? \}/))
  await assert.rejects(fresh().acceptEpoch(craft(rosterOf([ent(ms[0], ms[3].identity.ed25519.publicKey), ent(ms[1]), ent(ms[2])])), TRUST), isGroupErr(/owner entry carries another Ed25519 key/))
  await assert.rejects(fresh().acceptEpoch(craft(rosterOf([ent(ms[0]), ent(ms[2]), ent(ms[1])])), TRUST), isGroupErr(/our slot names another container/))
  await assert.rejects(fresh().acceptEpoch(craft(rosterOf([ent(ms[0]), ent(ms[1]), ent(ms[2])], '{"relays":[]}', 2)), TRUST), isGroupErr(/count does not match/))
  const identity = ed25519.ExtendedPoint.ZERO.toRawBytes()
  await assert.rejects(fresh().acceptEpoch(craft(rosterOf([ent(ms[0]), ent(ms[1]), ent(ms[2], identity)])), TRUST), isGroupErr(/small-order|not a point/))
  const trailing = cat(rosterOf([ent(ms[0]), ent(ms[1]), ent(ms[2])]), Uint8Array.of(0))
  await assert.rejects(fresh().acceptEpoch(craft(trailing), TRUST), isGroupErr(/length does not match/))
  // the slot count is not a v1 byte: 0x0100 members is refused as too many / count 是 uint16，超过 128 被拒
  const big = epochWire.slice(); big[113] = 1
  await assert.rejects(fresh().acceptEpoch(big, TRUST), isGroupErr(/bad member count/))
})

// A container on the fake chain with a published channel identity / 假链上有已发布通道身份的容器
function onChain(chain, n) {
  const T = Math.floor(Date.now() / 1000)
  const container = C(0x9000 + n)
  const holderKey = '0x' + (0x2000 + n).toString(16).padStart(4, '0').repeat(16)
  chain.setContainerToken(container, { tokenId: n })
  chain.setAccount(n, container)
  chain.setOwner(n, sig.privateKeyToAddress(holderKey))
  const identity = channel.generateIdentity()
  const keys = { container, x25519: hex(identity.x25519.publicKey), ed25519: hex(identity.ed25519.publicKey), inbox: { bus: '0x' + 'cb'.repeat(20) }, issued: T - 60, expires: T + 86400 }
  const record = { tapechannel: '1', container, chainId: 56, ...keys, sig: sig.signDigest(sig.channelKeysDigest(56, ADDR.hub, keys), holderKey) }
  chain.writeFile(container, CHANNEL_KEYS_KEY, canonicalJSON(record))
  return { container, chainId: 56, identity }
}

test('FIXED GRP-11: channelKeysVerifier checks a format-2 entry (no x25519) against the chain; api.groupVerifier() cannot, since it compares both keys', async () => {
  const chain = createFakeChain()
  const api = createTapeAPI({ rpcUrls: ['http://rpc1', 'http://rpc2'], quorum: 2, chainId: 56, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, fetch: chain.fetch })
  const ms = [1, 2, 3].map((n) => onChain(chain, n))
  const verify = G.channelKeysVerifier(api)
  const { owner, epochWire, joiner } = await v2Group(ms, { verifyMember: verify })
  const g = joiner(ms[1], { verifyMember: verify })
  await g.acceptEpoch(epochWire)
  const s = joiner(ms[2]); await s.acceptEpoch(epochWire, TRUST)
  assert.equal((await g.openVerified(s.seal('on chain'), { text: true })).verified, true)
  const edOnly = { container: ms[2].container, chainId: 56, ed25519: hex(ms[2].identity.ed25519.publicKey) }
  assert.equal(await verify(edOnly), true)
  assert.equal(await verify({ ...edOnly, ed25519: hex(channel.generateIdentity().ed25519.publicKey) }), false, 'another key is a mismatch')
  assert.equal(await verify({ ...entry(ms[2]) }), true, 'a full entry: both keys compared')
  assert.equal(await verify({ ...entry(ms[2]), x25519: hex(channel.generateIdentity().x25519.publicKey) }), false)
  assert.equal(await verify({ container: C(0x9999), chainId: 56, ed25519: edOnly.ed25519 }), false, 'no container there: definitive')
  assert.equal(await api.groupVerifier()(edOnly), false, 'why the helper exists: the format-1 verifier needs x25519')
  await assert.rejects(verify({ ...edOnly, chainId: 97 }), isGroupErr(/on chain 97/))
  assert.throws(() => G.channelKeysVerifier({}), invalid(/TapeAPI client/))
  void owner
})

test('FIXED GRP-12: the SDK reproduces spec/vectors/tap-27-group-v2.json, and a member opens it with the fixed clock', async () => {
  const v = JSON.parse(readFileSync(new URL('../../spec/vectors/tap-27-group-v2.json', import.meta.url), 'utf8'))
  const ids = v.members.map((m) => ({ container: m.container, chainId: 56, identity: { x25519: { secretKey: unhex(m.x25519Secret), publicKey: unhex(m.x25519) }, ed25519: { secretKey: unhex(m.ed25519Secret), publicKey: unhex(m.ed25519) } } }))
  let prev = '00'.repeat(32)
  for (const ep of v.epochs) {
    const draws = [unhex(ep.K), unhex(ep.ephemeralSecret), unhex(ep.nonce)]
    const built = G.buildEpochV2({ gid: unhex(v.gid), epoch: ep.epoch, issued: v.issued, prev, owner: { container: ids[0].container, chainId: 56 }, members: ids.map(entry), relays: v.relays, bus: v.bus, ownerEdSecret: ids[0].identity.ed25519.secretKey, random: () => draws.shift() })
    assert.equal(hex(built.wire), ep.epochWire, `epoch ${ep.epoch} rebuilt byte for byte`)
    assert.equal(hex(built.rosterBytes), ep.roster)
    assert.equal(ep.prev, prev)
    prev = Buffer.from(sha256(built.rosterBytes)).toString('hex')
  }
  const m2 = G.joinGroup({ self: ids[2], identity: ids[2].identity, invite: { gid: v.gid.slice(2), owner: { container: ids[0].container, chainId: 56 }, format: 2 }, ownerKeys: entry(ids[0]), clock: () => v.issued })
  for (const ep of v.epochs) await m2.acceptEpoch(unhex(ep.epochWire), TRUST)
  for (const m of v.messages) {
    const r = m2.open(unhex(m.wire), { text: true })
    assert.deepEqual([r.index, r.epoch, r.seq.toString(), r.data], [m.sender, m.epoch, m.seq, m.plaintext])
  }
  v.senderKeys.forEach((k, i) => assert.equal(hex(G.senderKeyV2(unhex(v.epochs[1].K), unhex(v.gid), 1, i)), k))
  // the format-1 file is untouched by format 2: its epoch message still opens with format 1 / 格式 1 向量不受影响
  const v1 = JSON.parse(readFileSync(new URL('../../spec/vectors/tap-27-group.json', import.meta.url), 'utf8'))
  assert.deepEqual([...unhex(v1.epochWire).subarray(17, 21)], [0, 0, 0, 0])
})

test('FIXED GRP-13: a format-2 owner restarts from snapshot() and the chain of rosters continues; the snapshot holds no secret', async () => {
  const ms = people(4, 0x8100)
  const { owner, epochWire, joiner } = await v2Group(ms)
  const g = joiner(ms[2]); await g.acceptEpoch(epochWire, TRUST)
  owner.seal('before the restart')
  const snap = JSON.parse(JSON.stringify(owner.snapshot()))
  assert.equal(snap.format, 2)
  assert.match(snap.rosterBin, /^[0-9a-f]+$/)
  for (const m of ms) assert.ok(!JSON.stringify(snap).includes(Buffer.from(m.identity.x25519.secretKey).toString('hex')), 'no secret key')
  const r = await G.resumeGroup({ self: ms[0], identity: ms[0].identity, snapshot: snap, ...TRUST })
  assert.equal(r.group.format, 2)
  assert.equal(r.epoch, 1)
  await g.acceptEpoch(r.epochWire, TRUST)                                  // prev chains to the roster bytes as sent / prev 接上
  assert.equal(g.open(r.group.seal('after the restart'), { text: true }).data, 'after the restart')
  await assert.rejects(G.resumeGroup({ self: ms[0], identity: ms[0].identity, snapshot: { ...snap, rosterBin: undefined }, ...TRUST }), isGroupErr(/needs rosterBin/))
  const member = g.snapshot()
  assert.equal(member.format, 2); assert.equal(member.roster, undefined)
})

test('FIXED GRP-14: deliverGroupUpdate and checkGroupInvites carry a format-2 group unchanged: the invite says format 2 and joinGroup follows it', async () => {
  const core = createRelayCore()
  const m = relayMethods(core)
  const api = { call: async (_svc, method, params) => ({ result: await m[method](params, { clientIp: '10.0.0.9' }) }) }
  const relay = { api, service: { container: C(0x9c) } }
  const ms = people(3, 0x8200)
  const created = await G.createGroup({ format: 2, self: ms[0], identity: ms[0].identity, members: ms.slice(1).map(entry), relays: [{ url: 'https://relay.example/tapeapi/v1', container: C(0x9c) }], ...TRUST })
  const sent = await deliverGroupUpdate({ group: created.group, update: created, relayClients: [relay] })
  assert.equal(sent.ok, true)
  const found = await checkGroupInvites({ self: { container: ms[1].container, chainId: 56 }, identity: ms[1].identity, relayClients: [relay] })
  assert.equal(found.invites.length, 1)
  assert.equal(found.invites[0].invite.format, 2)
  const g = G.joinGroup({ self: ms[1], identity: ms[1].identity, invite: found.invites[0].invite, ownerKeys: entry(ms[0]), ...TRUST })
  assert.equal(g.format, 2)
  const link = channel.relayTransport({ api, service: relay.service, inbound: g.room, outbound: g.room, waitMs: 0 })
  for (const w of await link.poll()) if (w[0] === 0x04) await g.acceptEpoch(w)
  assert.equal(g.epoch, 0)
})

test('FIXED GRP-15: format 1 stays the default: createGroup without `format` builds a TAP-27 v1 epoch message and invite, byte layout unchanged', async () => {
  const ms = people(3, 0x8300)
  const { group, epochWire } = await G.createGroup({ self: ms[0], identity: ms[0].identity, members: ms.slice(1).map(entry), ...TRUST })
  assert.equal(group.format, 1)
  assert.deepEqual([...epochWire.subarray(17, 21)], [0, 0, 0, 0])
  assert.equal(epochWire[113], 3, 'the one-byte count of format 1')
  const inv = G.openGroupInvite(group.inviteFor(entry(ms[1])), { self: { container: ms[1].container, chainId: 56, staticSecret: ms[1].identity.x25519.secretKey } })
  assert.equal('format' in inv, false)
  assert.equal(group.roster.v, 1); assert.equal(group.roster.kind, 'tape.group/roster')
  assert.equal('format' in group.snapshot(), false)
  await assert.rejects(G.createGroup({ format: 3, self: ms[0], identity: ms[0].identity, ...TRUST }), invalid(/format must be 1 or 2/))
})
