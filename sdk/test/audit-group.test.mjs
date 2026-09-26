// Adversarial audit of TAP-26 §3.1/§3.2 channel identity + inbox and TAP-27 Tape Group (commits 7fddc71, 86af31f).
// The findings (G-01 .. G-19) have since been fixed. Each `FIXED <id>` test replays the original attack and asserts
// that it is now refused (or that the right result happens); a `CONFIRMED <id>` test asserts behaviour that was
// attacked and held. A `REMAINS <id>` test pins a residual and asserts today's behaviour: either by design (G-02,
// G-08) or a gap the fix left in the source (G-05b); invert it once the source changes.
// 对 TAP-26 §3.1/§3.2 通道身份与收件、TAP-27 Tape Group 的对抗审计。发现项 G-01 .. G-19 均已修复：每个 `FIXED <id>`
// 测试重放原攻击并断言它现在被拒绝（或结果正确）；`CONFIRMED <id>` 断言经受住攻击的行为；`REMAINS <id>` 固定一个残余
// 并断言其当前行为：或为设计使然（G-02、G-08），或为修复在源码中留下的缺口（G-05b）；源码修改后应将其反转。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { x25519, ed25519 } from '@noble/curves/ed25519'
import { xchacha20poly1305 } from '@noble/ciphers/chacha'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { randomBytes } from '@noble/hashes/utils'
import { createTapeAPI, channel, group as G, sig, TapeAPIError, CHANNEL_KEYS_KEY, canonicalJSON } from '../src/index.js'
import { createFakeChain, ADDR } from './helpers/fake-chain.mjs'

const RPC = ['http://rpc1', 'http://rpc2']
const BUS = '0x' + 'cb'.repeat(20)
const te = new TextEncoder()
const hex = (b) => '0x' + Buffer.from(b).toString('hex')
const nowS = () => Math.floor(Date.now() / 1000)
const C = (n) => '0x' + n.toString(16).padStart(40, '0')
const cat = (...xs) => { const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of xs) { out.set(x, o); o += x.length } return out }
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, Number(n)); return b }
const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b }
const fpr = (pub) => sha256(pub).slice(0, 8)          // the OLD slot fingerprint (G-04) / 旧版格子指纹
const commitOf = (K) => sha256(cat(te.encode('TAP-27/commit/v1'), K))
const kekFor = (ss, E, R, gid, epoch) => hkdf(sha256, ss, te.encode('TAP-27/wrap/v1'), cat(E, R, gid, u64(epoch)), 32)
const isGroupErr = (re) => (e) => e instanceof TapeAPIError && e.code === 'GROUP_INVALID' && (!re || re.test(e.message))
const api = (chain) => createTapeAPI({ rpcUrls: RPC, quorum: 2, chainId: 56, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, fetch: chain.fetch })
const entry = (m) => ({ container: m.container, chainId: 56, x25519: hex(m.identity.x25519.publicKey), ed25519: hex(m.identity.ed25519.publicKey) })
const TRUST = { verifyMember: 'trust-roster' }
const HEADER_EPOCH = 114, SLOT = 48, HEADER_MSG = 61   // wire layout after the fixes / 修复后的线路布局
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Move Date.now (all SDK clocks read it) forward for the duration of fn / 在 fn 执行期间把 Date.now 往后拨
async function later(ms, fn) { const real = Date.now; Date.now = () => real() + ms; try { return await fn() } finally { Date.now = real } }

// A random source that records its draws, so a test can learn K the way an owner (or a member) knows it.
// createGroup draws gid(16), then per epoch K(32), e(32), N(24).
// 记录抽取结果的随机源，让测试像群主（或成员）那样得知 K。createGroup 先抽 gid(16)，每个纪元再抽 K(32)、e(32)、N(24)。
function recRandom() { const draws = []; const f = (n) => { const b = randomBytes(n); draws.push(b); return b }; f.draws = draws; return f }

async function trio({ random } = {}) {
  const ids = [1, 2, 3].map(() => channel.generateIdentity())
  const ms = ids.map((identity, i) => ({ container: C(0xb000 + i), chainId: 56, identity }))
  const { group: owner, epochWire } = await G.createGroup({ self: ms[0], identity: ids[0], members: [entry(ms[1]), entry(ms[2])], bus: BUS, ...TRUST, ...(random ? { random } : {}) })
  const fresh = (m, opts = {}) => G.joinGroup({ self: m, identity: m.identity, invite: { gid: owner.gid, owner: { container: ms[0].container, chainId: 56 } }, ownerKeys: entry(ms[0]), ...opts })
  const join = async (m, wire = epochWire, opts) => { const g = fresh(m, opts); await g.acceptEpoch(wire, TRUST); return g }
  return { ms, owner, epochWire, join, fresh, gid: Buffer.from(owner.gid, 'hex') }
}

// A container with a circuit, a holder and a published channel identity on the fake chain. The inbox is part of
// what the holder signs (G-13) and the hub derives the container from the circuit (G-14).
// 假链上一个带电路、持有人和已发布通道身份的容器。收件地址在持有人签名范围内（G-13），中枢由电路推导出容器（G-14）。
function member(chain, n, { keys: override, holderKey } = {}) {
  const container = C(0xa000 + n)
  const hk = holderKey ?? '0x' + (0x40 + n).toString(16).padStart(2, '0').repeat(32)
  chain.setContainerToken(container, { tokenId: n })
  chain.setAccount(n, container)
  chain.setOwner(n, sig.privateKeyToAddress(hk))
  const identity = channel.generateIdentity()
  const keys = { container, x25519: hex(identity.x25519.publicKey), ed25519: hex(identity.ed25519.publicKey), inbox: { bus: BUS }, issued: nowS() - 60, expires: nowS() + 86400, ...(override || {}) }
  const record = { tapechannel: '1', container, chainId: 56, ...keys, sig: sig.signDigest(sig.channelKeysDigest(56, ADDR.hub, keys), hk) }
  chain.writeFile(container, CHANNEL_KEYS_KEY, canonicalJSON(record))
  return { container, chainId: 56, identity, tokenId: n, holderKey: hk, record }
}

// buildEpoch without its sender-side checks: what a malicious or non-reference owner can put on the wire.
// Slots are 48 bytes (wrapped K + tag), no fingerprint.
// 去掉发送方检查的 buildEpoch：恶意或非参考实现的群主能放上线路的东西。格子 48 字节（包裹的 K + 标签），无指纹。
function craftEpoch({ gid, epoch, rosterBytes, slotKeys, K = randomBytes(32), wrapFor = () => K, commitTo = K, ownerEdSecret }) {
  const e = randomBytes(32), E = x25519.getPublicKey(e), N = randomBytes(24)
  const header = cat(Uint8Array.of(0x04), gid, u64(epoch), E, N, commitOf(commitTo), Uint8Array.of(slotKeys.length))
  const slots = cat(...slotKeys.map((R, i) => xchacha20poly1305(kekFor(x25519.getSharedSecret(e, R), E, R, gid, epoch), N, header).encrypt(wrapFor(i))))
  const ct = xchacha20poly1305(K, N, cat(header, slots)).encrypt(rosterBytes)
  const body = cat(header, slots, u32(ct.length), ct)
  return { wire: cat(body, ed25519.sign(cat(te.encode('TAP-27/epoch/v1'), body), ownerEdSecret)), K }
}
const rosterOf = ({ gid, epoch, issued = nowS(), prev = '00'.repeat(32), owner, members }) => ({ v: 1, kind: G.ROSTER_KIND, gid: Buffer.from(gid).toString('hex'), epoch, issued, prev, owner, members, relays: [], bus: BUS })

// A §3.4 message built by hand, for anyone who knows K and chooses how to sign: header carries a 24-byte nonce.
// 手工构造的 §3.4 消息，供知道 K 并自选签名方式的人使用：头部携带 24 字节随机数。
function craftMsg({ gid, epoch, index, seq, K, pt, sign, nonce = randomBytes(24) }) {
  const header = cat(Uint8Array.of(0x05), gid, u64(epoch), u32(index), u64(seq), nonce)
  const ct = xchacha20poly1305(G.senderKey(K, gid, epoch, index), nonce, header).encrypt(pt)
  return cat(header, ct, sign(cat(te.encode('TAP-27/msg/v1'), header, ct)))
}

// ======================================================================================== HIGH ====

test('FIXED G-01: a member that restarts and re-accepts the same epoch uses a fresh nonce and a later seq: no keystream reuse, no false replay', async () => {
  const { ms, join } = await trio()
  const gc = await join(ms[2])
  const p1 = te.encode('attack at dawn, bring the keys')
  const p2 = te.encode('the vault code is 0451, repeat')
  const b1 = await join(ms[1])
  const w1 = b1.seal(p1)
  await sleep(3)   // B's process restarts (later, on the clock) and rejoins from the reposted epoch message (§3.5)
  //                 B 的进程重启（时钟上更晚），从重发的纪元消息重新加入
  const b2 = await join(ms[1])
  const w2 = b2.seal(p2)
  assert.notDeepEqual(w1.slice(37, HEADER_MSG), w2.slice(37, HEADER_MSG), 'each message carries its own random 24-byte nonce')
  const s1 = new DataView(w1.buffer, w1.byteOffset + 29, 8).getBigUint64(0), s2 = new DataView(w2.buffer, w2.byteOffset + 29, 8).getBigUint64(0)
  assert.ok(s2 > s1, 'seq starts from the clock at install, so the restarted sender continues above its old seq')
  const ct1 = w1.slice(HEADER_MSG, HEADER_MSG + p1.length), ct2 = w2.slice(HEADER_MSG, HEADER_MSG + p2.length)
  assert.notDeepEqual(ct1.map((b, i) => b ^ ct2[i]), p1.map((b, i) => b ^ p2[i]), 'ciphertext XOR no longer equals plaintext XOR')
  assert.equal(gc.open(w1, { text: true }).data, 'attack at dawn, bring the keys')
  const r2 = gc.open(w2, { text: true })
  assert.equal(r2.data, 'the vault code is 0451, repeat', 'the new message is delivered, not refused as a replay')
  assert.equal(r2.gap, null, 'a restart shows up as an unknown gap')
})

// ======================================================================================== MEDIUM ====

test('FIXED G-02: epoch rollback on rejoin: a restarted member passing minEpoch from snapshot() refuses the replayed old epoch', async () => {
  const { ms, owner, epochWire, join, fresh } = await trio()
  const [gb, gc] = [await join(ms[1]), await join(ms[2])]
  const { epochWire: e1 } = await owner.removeMembers([ms[2].container])
  await gb.acceptEpoch(e1, TRUST)
  assert.equal(gb.epoch, 1)
  const snap = gb.snapshot()
  assert.equal(snap.epoch, 1)
  assert.ok(!('roster' in snap), 'a member snapshot holds no roster and no secrets')
  // B restarts with its snapshot. The relay (or the removed C) feeds it epoch 0 and withholds epoch 1.
  // B 带着快照重启。中继（或被移除的 C）喂给它纪元 0，扣下纪元 1。
  const b2 = fresh(ms[1], { minEpoch: snap.epoch })
  await assert.rejects(b2.acceptEpoch(epochWire, TRUST), isGroupErr(/below 1.*rollback/))
  assert.equal(b2.epoch, null)
  assert.throws(() => b2.seal('sent after C was removed'), isGroupErr(/no epoch yet/), 'nothing is sent under the superseded key')
  await b2.acceptEpoch(e1, TRUST)
  assert.throws(() => gc.open(b2.seal('sent after C was removed')), isGroupErr(/no key for epoch 1/), 'the removed member cannot read it')
  // Without a snapshot, the roster's `issued` bounds the replay: an epoch older than 30 days is refused.
  // 没有快照时，名单的 `issued` 限制重放：超过 30 天的纪元被拒。
  const secret = ms[0].identity.ed25519.secretKey
  const stale = G.buildEpoch({ gid: Buffer.from(owner.gid, 'hex'), epoch: 0, issued: nowS() - G.MAX_EPOCH_AGE_S - 60, prev: '00'.repeat(32), owner: { container: ms[0].container, chainId: 56 }, members: owner.members, bus: BUS, ownerEdSecret: secret })
  await assert.rejects(fresh(ms[1]).acceptEpoch(stale.wire, TRUST), isGroupErr(/older than 30 days/))
  const future = G.buildEpoch({ gid: Buffer.from(owner.gid, 'hex'), epoch: 0, issued: nowS() + G.FUTURE_SKEW_S + 60, prev: '00'.repeat(32), owner: { container: ms[0].container, chainId: 56 }, members: owner.members, bus: BUS, ownerEdSecret: secret })
  await assert.rejects(fresh(ms[1]).acceptEpoch(future.wire, TRUST), isGroupErr(/in the future/))
  assert.throws(() => fresh(ms[1], { minEpoch: -1 }), isGroupErr(/minEpoch/))
})

test('REMAINS G-02 (residual, by design): a member that restarts WITHOUT minEpoch can still be rolled back to an epoch issued within 30 days', async () => {
  // Spec: state is optional; without snapshot() the only floor is roster.issued (MAX_EPOCH_AGE_S). Apps that care
  // MUST persist snapshot().epoch. / 规范：状态可选；不存快照时唯一的下限是 roster.issued。在意此点的应用必须保存 snapshot().epoch。
  const { ms, owner, epochWire, join } = await trio()
  const [gb, gc] = [await join(ms[1]), await join(ms[2])]
  const { epochWire: e1 } = await owner.removeMembers([ms[2].container])
  await gb.acceptEpoch(e1, TRUST)
  const b2 = await join(ms[1], epochWire)    // no minEpoch / 未传 minEpoch
  assert.equal(b2.epoch, 0, 'a superseded epoch younger than 30 days is accepted on a fresh join')
  assert.equal(gc.open(b2.seal('sent after C was removed'), { text: true }).data, 'sent after C was removed', 'and the removed member reads it')
})

test('FIXED G-03: concurrent acceptEpoch calls are serialised: an older epoch arriving second is refused and current stays at the newer one', async () => {
  const { ms, owner, join } = await trio()
  const [gb, gc] = [await join(ms[1]), await join(ms[2])]
  const { epochWire: e1 } = await owner.rotate()
  await gc.acceptEpoch(e1, TRUST)
  const { epochWire: e2 } = await owner.removeMembers([ms[2].container])     // C removed in epoch 2 / C 在纪元 2 被移除
  // B's app hands both messages from one poll to acceptEpoch without awaiting each (a normal event-handler pattern)
  // B 的应用把一次轮询得到的两条消息都交给 acceptEpoch，且不逐个等待（常见的事件处理写法）
  const [r2, r1] = await Promise.allSettled([gb.acceptEpoch(e2, TRUST), gb.acceptEpoch(e1, TRUST)])
  assert.equal(r2.status, 'fulfilled')
  assert.equal(r1.status, 'rejected')
  assert.ok(isGroupErr(/not newer/)(r1.reason), String(r1.reason))
  assert.equal(gb.epoch, 2, 'current did not regress')
  assert.throws(() => gc.open(gb.seal('C was removed in epoch 2')), isGroupErr(/no key for epoch 2/), 'the removed member cannot read B\'s new messages')
  assert.throws(() => gb._install(1, gb.roster, new Uint8Array(0), new Uint8Array(32)), isGroupErr(/not newer/), 'install itself refuses to go backwards')
  gb._clock.now = () => Date.now() + G.KEEP_PREVIOUS_MS + 1
  assert.equal(gb.open(owner.seal('epoch 2 message'), { text: true }).data, 'epoch 2 message', 'the current epoch never expires as "previous"')
})

test('FIXED G-04: the roster is hidden: slots carry no key fingerprint, and an observer holding every channel record learns only the count', async () => {
  const chain = createFakeChain()
  const client = api(chain)
  const people = [1, 2, 3, 4, 5, 6].map((n) => member(chain, n))
  const [A, B, Cm] = people
  const verifyMember = client.groupVerifier()
  const others = await Promise.all([B, Cm].map((m) => client.chain.channelKeys(m.container)))
  const { epochWire } = await G.createGroup({ self: A, identity: A.identity, members: others, bus: BUS, verifyMember })
  const count = epochWire[HEADER_EPOCH - 1]
  assert.equal(count, 3, 'the count is public')
  const ctLen = new DataView(epochWire.buffer, epochWire.byteOffset + HEADER_EPOCH + SLOT * count, 4).getUint32(0)
  assert.equal(epochWire.length, HEADER_EPOCH + SLOT * count + 4 + ctLen + 64, 'slots are 48 bytes: wrapped K + tag, nothing else')
  // Observer: reads every container's public channel record and searches the wire for anything derived from them
  // 观察者：读取每个容器的公开通道记录，在线路里搜寻由其派生的任何东西
  const wireHex = Buffer.from(epochWire).toString('hex')
  for (const p of people) {
    const k = await client.chain.channelKeys(p.container)
    const x = channel.fromHex(k.x25519, 32)
    assert.ok(!wireHex.includes(Buffer.from(fpr(x)).toString('hex')), `no SHA-256 fingerprint of ${p.container}'s key`)
    assert.ok(!wireHex.includes(k.x25519.slice(2)) && !wireHex.includes(k.ed25519.slice(2)), 'no public key either')
  }
  // Members find their slot by trial decryption / 成员靠逐格试解找到自己的格子
  const gb = G.joinGroup({ self: B, identity: B.identity, invite: { gid: Buffer.from(epochWire.slice(1, 17)).toString('hex'), owner: { container: A.container, chainId: 56 } }, ownerKeys: entry(A) })
  const r = await gb.acceptEpoch(epochWire, { verifyMember })
  assert.equal(r.roster.members[1].container, B.container.toLowerCase())
})

test('FIXED G-05: api.groupVerifier() caches a record for minutes, not until it expires: a sold circuit loses its identity inside groups', async () => {
  const chain = createFakeChain()
  const client = api(chain)
  const B = member(chain, 2)
  const verify = client.groupVerifier()
  assert.equal(await verify(entry(B)), true)
  chain.setOwner(B.tokenId, '0x' + '99'.repeat(20))                                   // circuit sold / 电路被卖
  assert.equal(await verify(entry(B)), true, 'within the ~300 s cache window the old answer still stands')
  assert.equal(await later(301_000, () => verify(entry(B))), false, 'after the cache window the same verifier answers false')
  // channelKeys shares the verifier's cache since arch B7; a fresh read is what TAP-26 §3.1 says now: the identity is gone
  // arch B7 起 channelKeys 与核验器共用缓存；fresh 读取给出 TAP-26 §3.1 此刻的结论：身份已失效
  await assert.rejects(client.chain.channelKeys(B.container, { fresh: true }), /current holder/)
  assert.equal(await client.groupVerifier()(entry(B)), false, 'a CHANNEL_INVALID record is a definitive "no", not an error')
  assert.equal(await client.groupVerifier()({ ...entry(B), container: C(0xa0ff) }), false, 'no container / NOT_FOUND is a "no" too')
})

test('FIXED G-05b: an RPC outage is an error, not a verdict: the owner keeps every member and can retry', async () => {
  // tokenOf() maps only a revert or an empty return to NOT_FOUND; RPC_UNAVAILABLE propagates, groupVerifier throws,
  // and rotate() aborts without dropping anyone.
  // tokenOf() 只把回滚或空返回当作 NOT_FOUND；RPC_UNAVAILABLE 原样传出，groupVerifier 抛错，rotate() 中止且不移除任何人。
  const chain = createFakeChain()
  const client = api(chain)
  const [A, B, Cm] = [1, 2, 3].map((n) => member(chain, n))
  const others = await Promise.all([B, Cm].map((m) => client.chain.channelKeys(m.container)))
  const { group: owner } = await G.createGroup({ self: A, identity: A.identity, members: others, bus: BUS, verifyMember: client.groupVerifier() })
  for (const u of RPC) chain.setFault(u, 'http500')             // every node down / 所有节点宕机
  await assert.rejects(client.groupVerifier()(entry(B), { fresh: true }), (e) => e.code !== 'NOT_FOUND' && e.code !== 'CHANNEL_INVALID', 'an outage throws instead of answering false')
  // Since arch B7 a member still inside the identity cache window answers from it; the owner's rotate reads fresh and aborts.
  // arch B7 起，仍在身份缓存窗口内的成员由缓存作答；群主的 rotate 读取最新状态，因而中止。
  assert.equal(await client.groupVerifier()(entry(B)), true, 'a cached record answers during the outage: still no verdict against anyone')
  await assert.rejects(owner.rotate({ verifyMember: client.groupVerifier() }))
  assert.equal(owner.members.length, 3, 'nobody was dropped')
  for (const u of RPC) chain.setFault(u, null)                   // nodes back / 节点恢复
  const r = await owner.rotate({ verifyMember: client.groupVerifier() })
  assert.deepEqual(r.dropped ?? [], [])
  assert.equal(owner.members.length, 3)
})

test('FIXED G-06: a removed member can no longer inject under the old epoch once the receiver has installed the removal', async () => {
  const { ms, owner, join } = await trio()
  const [gb, gc] = [await join(ms[1]), await join(ms[2])]
  const { epochWire: e1 } = await owner.removeMembers([ms[2].container])
  // B is offline for a day. Meanwhile the removed C (still on epoch 0) posts to the room.
  // B 离线一天。与此同时，被移除的 C（仍在纪元 0）往房间里发消息。
  const posts = ['one', 'two', 'three'].map((t) => gc.seal(`after my removal: ${t}`))
  const ownerLate = owner.seal('owner, epoch 1')
  await gb.acceptEpoch(e1, TRUST)            // B comes back and processes the removal first... / B 回来先处理移除
  for (const w of posts) assert.throws(() => gb.open(w), isGroupErr(/removed after epoch 0/), '...and refuses every post C made')
  assert.equal(gb.open(ownerLate, { text: true }).data, 'owner, epoch 1', 'members still in the roster are unaffected')
})

// ======================================================================================== LOW ====

test('FIXED G-07: §3.3 "discard once every old-epoch sender has spoken in the new epoch": a sender that moved on cannot use the old epoch', async () => {
  const { ms, owner, join } = await trio()
  const gb = await join(ms[1])
  const gc = await join(ms[2])
  gb.open(owner.seal('epoch 0'))
  const late = owner.seal('epoch 0, delivered late')
  const lateC = gc.seal('C in epoch 0, delivered late')
  const { epochWire: e1 } = await owner.rotate()
  await gb.acceptEpoch(e1, TRUST); await gc.acceptEpoch(e1, TRUST)
  gb.open(owner.seal('owner in epoch 1')); gb.open(gc.seal('C in epoch 1'))   // every old-epoch sender has now spoken in epoch 1
  assert.throws(() => gb.open(late), isGroupErr(/already speaks in epoch 1/), 'owner\'s epoch-0 message discarded')
  assert.throws(() => gb.open(lateC), isGroupErr(/already speaks in epoch 1/), 'C\'s too')
})

test('FIXED G-08: a record claiming another container\'s public keys cannot share a group with the victim: duplicate keys are refused', async () => {
  const chain = createFakeChain()
  const client = api(chain)
  const [O, V] = [member(chain, 1), member(chain, 2)]
  // Attacker's own circuit/container X publishes a record, signed by its own holder, carrying V's public keys
  // 攻击者自己的电路/容器 X 发布一条记录（由其自己的持有人签名），里面是 V 的公钥
  const X = member(chain, 9, { keys: { x25519: hex(V.identity.x25519.publicKey), ed25519: hex(V.identity.ed25519.publicKey) } })
  const kx = await client.chain.channelKeys(X.container)
  const kv = await client.chain.channelKeys(V.container)
  const verifyMember = client.groupVerifier()
  await assert.rejects(G.createGroup({ self: O, identity: O.identity, members: [kx, kv], bus: BUS, verifyMember }), isGroupErr(/share a key/), 'the owner refuses the copy')
  const { group: owner, epochWire } = await G.createGroup({ self: O, identity: O.identity, members: [kv], bus: BUS, verifyMember })
  await assert.rejects(owner.addMembers([kx]), isGroupErr(/share a key/), 'and cannot add it later')
  const gv = G.joinGroup({ self: V, identity: V.identity, invite: { gid: owner.gid, owner: { container: O.container, chainId: 56 } }, ownerKeys: entry(O) })
  await gv.acceptEpoch(epochWire, { verifyMember })
  assert.equal(gv.epoch, 0, 'V joins')
  // A (non-reference) owner that lists X before V anyway is refused by V: two slots open with its key
  // 非参考实现的群主若仍把 X 排在 V 前面，V 会拒绝：两格都能用它的密钥打开
  const gid = Buffer.from(owner.gid, 'hex')
  const members = [entry(O), { ...entry(V), container: X.container.toLowerCase() }, { ...entry(V), container: V.container.toLowerCase() }]
  const { wire } = craftEpoch({ gid, epoch: 1, rosterBytes: te.encode(canonicalJSON(rosterOf({ gid, epoch: 1, owner: { container: O.container.toLowerCase(), chainId: 56 }, members }))), slotKeys: members.map((m) => channel.fromHex(m.x25519, 32)), ownerEdSecret: O.identity.ed25519.secretKey })
  await assert.rejects(gv.acceptEpoch(wire, TRUST), isGroupErr(/two slots open with our key/))
})

test('REMAINS G-08 (residual): channelKeys still vouches for public keys the container never proved it holds (no proof of possession)', async () => {
  // The fix makes key-squatting a refusal instead of a lockout-by-order; X cannot read or sign as V, but a group
  // that already holds X cannot also hold V. / 修复把"抢注密钥"从按顺序锁死变为拒绝；X 无法以 V 的身份读写，但已含 X 的群不能再加入 V。
  const chain = createFakeChain()
  const V = member(chain, 2)
  const X = member(chain, 9, { keys: { x25519: hex(V.identity.x25519.publicKey), ed25519: hex(V.identity.ed25519.publicKey) } })
  const kx = await api(chain).chain.channelKeys(X.container)
  assert.equal(kx.x25519, hex(V.identity.x25519.publicKey))
})

test('FIXED G-09: acceptEpoch enforces buildEpoch\'s uniqueness rules: a roster listing one member twice is refused by every member', async () => {
  const { ms, gid, fresh } = await trio()
  const owner = { container: ms[0].container, chainId: 56 }
  const members = [entry(ms[0]), entry(ms[1]), entry(ms[2]), entry(ms[1])]
  const rosterBytes = te.encode(canonicalJSON(rosterOf({ gid, epoch: 0, owner, members })))
  const { wire } = craftEpoch({ gid, epoch: 0, rosterBytes, slotKeys: members.map((m) => channel.fromHex(m.x25519, 32)), ownerEdSecret: ms[0].identity.ed25519.secretKey })
  assert.throws(() => G.buildEpoch({ gid, epoch: 0, issued: nowS(), prev: '00'.repeat(32), owner, members, bus: BUS, ownerEdSecret: ms[0].identity.ed25519.secretKey }), isGroupErr(/twice/))
  await assert.rejects(fresh(ms[1]).acceptEpoch(wire, TRUST), isGroupErr(/two slots open with our key/), 'the duplicated member')
  await assert.rejects(fresh(ms[2]).acceptEpoch(wire, TRUST), isGroupErr(/twice/), 'everyone else')
  // same container twice under different keys / 同一容器用不同密钥出现两次
  const other = channel.generateIdentity()
  const m2 = [entry(ms[0]), entry(ms[1]), entry(ms[2]), { ...entry(ms[1]), x25519: hex(other.x25519.publicKey), ed25519: hex(other.ed25519.publicKey) }]
  const w2 = craftEpoch({ gid, epoch: 0, rosterBytes: te.encode(canonicalJSON(rosterOf({ gid, epoch: 0, owner, members: m2 }))), slotKeys: m2.map((m) => channel.fromHex(m.x25519, 32)), ownerEdSecret: ms[0].identity.ed25519.secretKey })
  await assert.rejects(fresh(ms[2]).acceptEpoch(w2.wire, TRUST), isGroupErr(/twice/))
})

test('FIXED G-10: small-order Ed25519 keys are refused everywhere, and verification is strict (zip215: false)', async () => {
  const identityPoint = new Uint8Array(32); identityPoint[0] = 1
  assert.throws(() => channel.assertEd25519Public(identityPoint), /small-order/)
  const universal = new Uint8Array(64); universal[0] = 1                    // R = identity, s = 0
  assert.equal(ed25519.verify(universal, te.encode('x'), identityPoint, { zip215: false }), false, 'strict verification refuses the universal signature')
  // In a group: member M publishes the identity point as its ed25519 key / 群内：成员 M 把单位元发布为其 ed25519 公钥
  const ids = [1, 2, 3].map(() => channel.generateIdentity())
  const ms = ids.map((identity, i) => ({ container: C(0xe000 + i), chainId: 56, identity }))
  const mEntry = { ...entry(ms[2]), ed25519: hex(identityPoint) }
  await assert.rejects(G.createGroup({ self: ms[0], identity: ids[0], members: [entry(ms[1]), mEntry], bus: BUS, ...TRUST }), isGroupErr(/small-order/), 'the owner refuses it')
  // A non-reference owner puts it on the wire anyway: members refuse the epoch / 非参考实现的群主仍放上线路：成员拒绝该纪元
  const gid = randomBytes(16)
  const owner = { container: ms[0].container, chainId: 56 }
  const members = [entry(ms[0]), entry(ms[1]), mEntry]
  const { wire } = craftEpoch({ gid, epoch: 0, rosterBytes: te.encode(canonicalJSON(rosterOf({ gid, epoch: 0, owner, members }))), slotKeys: members.map((m) => channel.fromHex(m.x25519, 32)), ownerEdSecret: ids[0].ed25519.secretKey })
  const gb = G.joinGroup({ self: ms[1], identity: ids[1], invite: { gid: Buffer.from(gid).toString('hex'), owner }, ownerKeys: entry(ms[0]) })
  await assert.rejects(gb.acceptEpoch(wire, TRUST), isGroupErr(/small-order/))
  assert.equal(gb.epoch, null)
})

test('FIXED G-11: an owner that forks an epoch (two signed epoch-n messages, different K) is caught: GROUP_EQUIVOCATION with both hashes', async () => {
  const { ms, owner, join, gid } = await trio()
  const [gb, gc] = [await join(ms[1]), await join(ms[2])]
  const prev = Buffer.from(sha256(te.encode(owner.snapshot().roster))).toString('hex')   // the roster bytes as sent / 按原样发送的名单字节
  const args = { gid, epoch: 1, issued: nowS(), prev, owner: { container: ms[0].container, chainId: 56 }, members: owner.members, bus: BUS, ownerEdSecret: ms[0].identity.ed25519.secretKey }
  const x = G.buildEpoch(args), y = G.buildEpoch(args)
  await gb.acceptEpoch(x.wire, TRUST); await gc.acceptEpoch(y.wire, TRUST)
  assert.throws(() => gc.open(gb.seal('split')), isGroupErr(/authentication/), 'B and C hold different epoch-1 keys until they compare')
  const again = await gb.acceptEpoch(x.wire, TRUST)
  assert.equal(again.duplicate, true, 'the same message again is a harmless duplicate')
  let caught = null
  await gb.acceptEpoch(y.wire, TRUST).catch((e) => { caught = e })
  assert.ok(caught instanceof TapeAPIError && caught.code === 'GROUP_EQUIVOCATION', String(caught))
  assert.equal(caught.data.epoch, 1)
  assert.equal(caught.data.hashes.length, 2)
  assert.notEqual(caught.data.hashes[0], caught.data.hashes[1], 'two different owner-signed bodies: evidence to show the group')
  assert.equal(gb.epoch, 1)
})

test('FIXED G-12: prev chains to the roster bytes as sent, and a roster not in canonical form is refused', async () => {
  const { ms, gid, fresh } = await trio()
  const owner = { container: ms[0].container, chainId: 56 }
  const up = (m) => ({ ...entry(m), x25519: '0x' + entry(m).x25519.slice(2).toUpperCase() })   // valid hex, other case / 合法十六进制，大小写不同
  const members = [entry(ms[0]), up(ms[1]), entry(ms[2])]
  const secret = ms[0].identity.ed25519.secretKey
  const e0 = G.buildEpoch({ gid, epoch: 0, issued: nowS(), prev: '00'.repeat(32), owner, members, bus: BUS, ownerEdSecret: secret })
  const prevBySpec = Buffer.from(sha256(e0.rosterBytes)).toString('hex')   // SHA-256(roster n-1 as sent) / 按原样发送的上一名单
  const e1 = G.buildEpoch({ gid, epoch: 1, issued: nowS(), prev: prevBySpec, owner, members, bus: BUS, ownerEdSecret: secret })
  const gc = fresh(ms[2])
  await gc.acceptEpoch(e0.wire, TRUST)
  await gc.acceptEpoch(e1.wire, TRUST)
  assert.equal(gc.epoch, 1, 'a spec-conforming owner is accepted')
  // A hand-made roster with upper-case hex, or an extra member field, is refused / 大写十六进制或多余字段的手工名单被拒
  const slotKeys = members.map((m) => channel.fromHex(m.x25519, 32))
  const nonCanon = craftEpoch({ gid, epoch: 0, rosterBytes: te.encode(canonicalJSON(rosterOf({ gid, epoch: 0, owner: { container: owner.container.toLowerCase(), chainId: 56 }, members }))), slotKeys, ownerEdSecret: secret })
  await assert.rejects(fresh(ms[2]).acceptEpoch(nonCanon.wire, TRUST), isGroupErr(/canonical form/))
  const extra = [entry(ms[0]), { ...entry(ms[1]), note: 'hi' }, entry(ms[2])]
  const withExtra = craftEpoch({ gid, epoch: 0, rosterBytes: te.encode(canonicalJSON(rosterOf({ gid, epoch: 0, owner: { container: owner.container.toLowerCase(), chainId: 56 }, members: extra }))), slotKeys, ownerEdSecret: secret })
  await assert.rejects(fresh(ms[2]).acceptEpoch(withExtra.wire, TRUST), isGroupErr(/exactly container, chainId, x25519, ed25519/))
})

test('FIXED G-13: the holder\'s signature covers record.inbox: a site writer who redirects the inbox invalidates the record', async () => {
  const chain = createFakeChain()
  const B = member(chain, 2)
  const k = await api(chain).chain.channelKeys(B.container)
  assert.equal(k.inbox.bus, BUS, 'the signed inbox is served')
  const evilBus = '0x' + 'ee'.repeat(20)
  chain.writeFile(B.container, CHANNEL_KEYS_KEY, canonicalJSON({ ...B.record, inbox: { bus: evilBus, relays: [{ url: 'https://evil.example/tapeapi/v1', container: '0x' + 'e1'.repeat(20) }] } }))
  await assert.rejects(api(chain).chain.channelKeys(B.container), (e) => e.code === 'CHANNEL_INVALID' && /not authorised by the current holder/.test(e.message))
  assert.ok(sig.CHANNEL_KEYS_TYPE.includes('bytes32 inbox'), 'the EIP-712 type carries the inbox hash')
})

test('FIXED G-14: channelKeys checks hub.accountOf(circuits, tokenId) == container: a contract answering token() as it likes is refused', async () => {
  const chain = createFakeChain()
  const fakeContainer = C(0xdead), fakeCircuits = '0x' + 'ab'.repeat(20)
  const hk = '0x' + '77'.repeat(32)
  chain.setContainerToken(fakeContainer, { circuits: fakeCircuits, tokenId: 777 })   // a contract answering token() however it likes
  chain.setOwner(777, sig.privateKeyToAddress(hk))
  const id = channel.generateIdentity()
  const keys = { container: fakeContainer, x25519: hex(id.x25519.publicKey), ed25519: hex(id.ed25519.publicKey), inbox: {}, issued: nowS() - 60, expires: nowS() + 3600 }
  chain.writeFile(fakeContainer, CHANNEL_KEYS_KEY, canonicalJSON({ tapechannel: '1', container: fakeContainer, chainId: 56, ...keys, sig: sig.signDigest(sig.channelKeysDigest(56, ADDR.hub, keys), hk) }))
  await assert.rejects(api(chain).chain.channelKeys(fakeContainer), (e) => e.code === 'CHANNEL_INVALID' && /hub\.accountOf/.test(e.message), 'a non-TapeOut "circuit" is refused')
  assert.ok(chain.state.calls.some((c) => c.name === 'accountOf'), 'the ERC-6551 account is re-derived, as on the manifest path')
  // A container that claims another container's circuit is refused too / 声称属于别的容器之电路的容器同样被拒
  const real = member(chain, 5)
  chain.setContainerToken(fakeContainer, { tokenId: real.tokenId })
  await assert.rejects(api(chain).chain.channelKeys(fakeContainer), (e) => e.code === 'CHANNEL_INVALID' && /hub\.accountOf/.test(e.message))
})

test('FIXED G-15: the owner re-verifies every member on its next epoch: a sold circuit is dropped instead of freezing the group', async () => {
  const chain = createFakeChain()
  const client = api(chain)
  const [A, B, Cm] = [1, 2, 3].map((n) => member(chain, n))
  const others = await Promise.all([B, Cm].map((m) => client.chain.channelKeys(m.container)))
  const { group: owner, epochWire } = await G.createGroup({ self: A, identity: A.identity, members: others, bus: BUS, verifyMember: client.groupVerifier() })
  const gb = G.joinGroup({ self: B, identity: B.identity, invite: { gid: owner.gid, owner: { container: A.container, chainId: 56 } }, ownerKeys: entry(A) })
  await gb.acceptEpoch(epochWire, { verifyMember: client.groupVerifier() })
  chain.setOwner(Cm.tokenId, '0x' + '99'.repeat(20))            // C's circuit changes hands / C 的电路易主
  // A throwing verifier (RPC outage) aborts the epoch; nobody is dropped / 核验器抛出（RPC 故障）则中止，不移除任何人
  await assert.rejects(owner.rotate({ verifyMember: async () => { throw new Error('rpc down') } }), isGroupErr(/rpc down/))
  assert.equal(owner.epoch, 0)
  const r = await owner.rotate({ verifyMember: client.groupVerifier() })
  assert.deepEqual(r.dropped, [Cm.container.toLowerCase()], 'the owner reports whom it dropped')
  assert.equal(owner.members.length, 2)
  await gb.acceptEpoch(r.epochWire, { verifyMember: client.groupVerifier() })
  assert.equal(gb.epoch, 1, 'B moves on to the new key')
})

test('FIXED G-16: scripts/channel-keys.mjs new refuses an existing identity file and writes new ones with mode 600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-ck-'))
  const file = join(dir, 'identity.json')
  const old = '{"x25519Secret":"0xOLD-SECRET-OF-THE-PUBLISHED-IDENTITY"}'
  writeFileSync(file, old, { mode: 0o644 })
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'channel-keys.mjs')
  const r = spawnSync(process.execPath, [script, 'new', '--container', C(0xa001), '--identity', file], { encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /already exists/)
  assert.equal(readFileSync(file, 'utf8'), old, 'the previous (possibly published) identity is kept')
  const file2 = join(dir, 'identity2.json')
  const r2 = spawnSync(process.execPath, [script, 'new', '--container', C(0xa001), '--identity', file2], { encoding: 'utf8' })
  assert.equal(r2.status, 0, r2.stderr)
  assert.equal(statSync(file2).mode & 0o777, 0o600, 'secrets written owner-only')
})

// ======================================================================================== INFO ====

test('FIXED G-17: open() verifies the signature before reporting { own: true }: a relabelled or junk message is refused', async () => {
  const { ms, owner, join } = await trio()
  const gb = await join(ms[1])
  const w = Uint8Array.from(owner.seal('from the owner')); w.set(u32(1), 25)   // relabel as sender 1 = B / 改署名为 B
  assert.throws(() => gb.open(w), isGroupErr(/not signed by member 1/))
  const junk = cat(w.slice(0, HEADER_MSG), randomBytes(80))
  assert.throws(() => gb.open(junk), isGroupErr(/not signed by member 1/), 'unauthenticated junk is not reported as our own echo')
  const mine = gb.seal('really mine')
  assert.equal(gb.open(mine).own, true, 'our genuine echo still is')
})

test('FIXED G-18: epoch numbers are bounded to 2^32-1: a jump to 2^53-1 is refused by the builder and on the wire', async () => {
  const { ms, owner, gid, fresh } = await trio()
  const args = { gid, issued: nowS(), prev: '00'.repeat(32), owner: { container: ms[0].container, chainId: 56 }, members: owner.members, bus: BUS, ownerEdSecret: ms[0].identity.ed25519.secretKey }
  assert.equal(G.MAX_EPOCH, 2 ** 32 - 1)
  assert.throws(() => G.buildEpoch({ ...args, epoch: Number.MAX_SAFE_INTEGER }), isGroupErr(/epoch must be an integer in 0\.\.4294967295/))
  assert.throws(() => G.buildEpoch({ ...args, epoch: G.MAX_EPOCH + 1 }), isGroupErr(/epoch must be/))
  const rosterBytes = te.encode(canonicalJSON(rosterOf({ gid, epoch: Number.MAX_SAFE_INTEGER, owner: args.owner, members: owner.members })))
  const { wire } = craftEpoch({ gid, epoch: Number.MAX_SAFE_INTEGER, rosterBytes, slotKeys: owner.members.map((m) => channel.fromHex(m.x25519, 32)), ownerEdSecret: args.ownerEdSecret })
  await assert.rejects(fresh(ms[1]).acceptEpoch(wire, TRUST), isGroupErr(/out of range/))
  const top = G.buildEpoch({ ...args, epoch: G.MAX_EPOCH })
  const gb = fresh(ms[1]); await gb.acceptEpoch(top.wire, TRUST)
  assert.equal(gb.epoch, G.MAX_EPOCH, 'the bound itself is exact')
})

test('FIXED G-19: a multi-owner Safe (EIP-1271 signature longer than 65 bytes) can authorise a channel record; over 1024 bytes is refused', async () => {
  const chain = createFakeChain()
  const B = member(chain, 2)
  const safe = '0x' + '5a'.repeat(20)
  chain.setOwner(B.tokenId, safe)
  const { sig: _s, ...rest } = B.record
  chain.setContractHolder(safe, sig.channelKeysDigest(56, ADDR.hub, rest))
  chain.writeFile(B.container, CHANNEL_KEYS_KEY, canonicalJSON({ ...B.record, sig: '0x' + 'ab'.repeat(130) }))   // two owner signatures / 两个所有者签名
  const k = await api(chain).chain.channelKeys(B.container)
  assert.equal(k.holder.toLowerCase(), safe, 'accepted under EIP-1271')
  chain.writeFile(B.container, CHANNEL_KEYS_KEY, canonicalJSON({ ...B.record, sig: '0x' + 'ab'.repeat(1025) }))
  await assert.rejects(api(chain).chain.channelKeys(B.container), /65 to 1024 bytes/)
})

test('CONFIRMED G-20: group invites are unauthenticated by design, but a forged invite cannot make a member join or accept anything', async () => {
  // An invite only says where to look; members accept only epochs signed by the owner key they read from chain.
  // 邀请只说明去哪里找；成员只接受由其从链上读到的群主密钥签名的纪元。
  const victim = { container: C(0xf001), chainId: 56, identity: channel.generateIdentity() }
  const realOwner = { container: C(0x4246), chainId: 56, identity: channel.generateIdentity() }
  const attacker = channel.generateIdentity()
  const gidHex = 'ab'.repeat(16)
  const wire = channel.sealToInbox({ v: 1, kind: G.GROUP_INVITE_KIND, gid: gidHex, owner: { container: realOwner.container, chainId: 56 }, relays: [{ url: 'https://tracker.example/tapeapi/v1', container: '0x' + 'e1'.repeat(20) }] },
    { to: { container: victim.container, staticPublic: victim.identity.x25519.publicKey } })
  const inv = G.openGroupInvite(wire, { self: { container: victim.container, chainId: 56, staticSecret: victim.identity.x25519.secretKey } })
  assert.equal(inv.owner.container, realOwner.container, 'anyone can write an invite in any owner\'s name (it only says where to look)')
  // The attacker's own keys as "ownerKeys" are refused unless they are the named owner's / 攻击者自己的密钥冒充 ownerKeys 被拒
  assert.throws(() => G.joinGroup({ self: victim, identity: victim.identity, invite: inv, ownerKeys: { container: C(0xbad), chainId: 56, x25519: hex(attacker.x25519.publicKey), ed25519: hex(attacker.ed25519.publicKey) } }), isGroupErr(/ownerKeys/))
  // With the owner's keys from chain, an epoch the attacker signs in the owner's name is refused
  // 用链上读到的群主密钥，攻击者以群主名义签的纪元被拒
  const gv = G.joinGroup({ self: victim, identity: victim.identity, invite: inv, ownerKeys: entry(realOwner) })
  const gid = Buffer.from(gidHex, 'hex')
  const forged = G.buildEpoch({ gid, epoch: 0, issued: nowS(), prev: '00'.repeat(32), owner: { container: realOwner.container, chainId: 56 },
    members: [{ ...entry(realOwner), x25519: hex(attacker.x25519.publicKey), ed25519: hex(attacker.ed25519.publicKey) }, entry(victim)], bus: BUS, ownerEdSecret: attacker.ed25519.secretKey })
  await assert.rejects(gv.acceptEpoch(forged.wire, TRUST), isGroupErr(/not signed by the owner/))
  assert.equal(gv.epoch, null, 'nothing accepted')
})

// ======================================================================================== CONFIRMED ====

test('CONFIRMED C-01: key commitment: an owner-signed epoch whose slot for B wraps K\' is refused by B (commit K) or by C (commit K\')', async () => {
  const { ms, gid, fresh } = await trio()
  const owner = { container: ms[0].container.toLowerCase(), chainId: 56 }
  const members = [entry(ms[0]), entry(ms[1]), entry(ms[2])].map((m) => ({ ...m, container: m.container.toLowerCase() }))
  const rosterBytes = te.encode(canonicalJSON(rosterOf({ gid, epoch: 0, owner, members })))
  const slotKeys = members.map((m) => channel.fromHex(m.x25519, 32))
  const K = randomBytes(32), K2 = randomBytes(32)
  const secret = ms[0].identity.ed25519.secretKey
  const toK = craftEpoch({ gid, epoch: 0, rosterBytes, slotKeys, K, wrapFor: (i) => (i === 1 ? K2 : K), commitTo: K, ownerEdSecret: secret })
  await assert.rejects(fresh(ms[1]).acceptEpoch(toK.wire, TRUST), isGroupErr(/commitment/))
  await fresh(ms[2]).acceptEpoch(toK.wire, TRUST)
  const toK2 = craftEpoch({ gid, epoch: 0, rosterBytes, slotKeys, K, wrapFor: (i) => (i === 1 ? K2 : K), commitTo: K2, ownerEdSecret: secret })
  await assert.rejects(fresh(ms[2]).acceptEpoch(toK2.wire, TRUST), isGroupErr(/commitment/))
  await assert.rejects(fresh(ms[1]).acceptEpoch(toK2.wire, TRUST), isGroupErr(/roster does not decrypt/))
})

test('CONFIRMED C-02: message integrity: reattribution, truncation, sig/ct/header/nonce edits and epoch-signature reuse are all refused', async () => {
  const { ms, owner, epochWire, join } = await trio()
  const [gb, gc] = [await join(ms[1]), await join(ms[2])]
  const w = gb.seal('intact message')
  const variants = [
    w.slice(0, w.length - 1), w.slice(0, w.length - 65), cat(w, Uint8Array.of(0)),
    (() => { const t = Uint8Array.from(w); t.set(u32(0), 25); return t })(),                 // claim the owner sent it / 冒称群主所发
    (() => { const t = Uint8Array.from(w); t[w.length - 1] ^= 1; return t })(),
    (() => { const t = Uint8Array.from(w); t[36] ^= 1; return t })(),                          // seq / 序号
    (() => { const t = Uint8Array.from(w); t[50] ^= 1; return t })(),                          // nonce / 随机数
    cat(w.slice(0, HEADER_MSG), w.slice(HEADER_MSG, w.length - 64), epochWire.slice(epochWire.length - 64)),   // owner's epoch signature
  ]
  for (const v of variants) assert.throws(() => gc.open(v), isGroupErr())
  assert.equal(gc.open(w, { text: true }).data, 'intact message', 'state untouched by the refusals')
  assert.equal(owner.open(w, { text: true }).from, ms[1].container.toLowerCase())
})

test('CONFIRMED C-03: TAP-26 and TAP-27 sealed inbox contents cannot be confused for one another', () => {
  const me = { container: C(0xf100), chainId: 56, identity: channel.generateIdentity() }
  const self = { container: me.container, chainId: 56, staticSecret: me.identity.x25519.secretKey }
  const to = { container: me.container, staticPublic: me.identity.x25519.publicKey }
  const groupInv = channel.sealToInbox({ v: 1, kind: G.GROUP_INVITE_KIND, gid: 'ab'.repeat(16), owner: { container: C(1), chainId: 56 }, relays: [] }, { to })
  assert.throws(() => channel.openInvite(groupInv, { self }), /not a TAP-26 invite/)
  const peer = channel.generateKeyPair()
  const { invite } = channel.createInvite({ self: { container: C(2), chainId: 56, staticSecret: peer.secretKey }, peer: { container: me.container, staticPublic: me.identity.x25519.publicKey } })
  assert.throws(() => G.openGroupInvite(channel.sealInvite(invite, { to }), { self }), isGroupErr(/not a group invite/))
  // sealed to someone else's inbox room: does not open even with the right key / 封给别人的收件房间：即使密钥对也打不开
  const elsewhere = channel.sealToInbox({ v: 1, kind: 'x' }, { to: { container: C(0xf101), staticPublic: me.identity.x25519.publicKey } })
  assert.throws(() => channel.openFromInbox(elsewhere, { self }), /does not open/)
})

test('CONFIRMED C-04: a sealed TAP-26 invite with a spoofed `from` cannot complete, and the responder accepts no frame meanwhile', () => {
  const victim = channel.generateKeyPair(), attacker = channel.generateKeyPair(), bob = channel.generateKeyPair()
  const V = C(0xf200), B = C(0xf201)
  const { invite, pending } = channel.createInvite({ self: { container: V, chainId: 56, staticSecret: attacker.secretKey }, peer: { container: B, staticPublic: bob.publicKey } })
  assert.equal(invite.from.container, V)
  const got = channel.openInvite(channel.sealInvite(invite, { to: { container: B, staticPublic: bob.publicKey } }), { self: { container: B, chainId: 56, staticSecret: bob.secretKey } })
  const { accept, session } = channel.acceptInvite({ self: { container: B, chainId: 56, staticSecret: bob.secretKey }, peer: { container: V, chainId: 56, staticPublic: victim.publicKey }, invite: got })
  assert.throws(() => channel.completeInvite(pending, accept), /does not verify/)
  assert.throws(() => session.open(new Uint8Array(40)), /not confirmed/)
})

test('CONFIRMED C-05: junk 0x04/0x05 in the group room is refused as GROUP_INVALID, and a replayed epoch is a no-op duplicate, without touching state', async () => {
  const { ms, owner, epochWire, join, gid } = await trio()
  const gb = await join(ms[1])
  const { epochWire: e1 } = await owner.rotate()
  await gb.acceptEpoch(e1, TRUST)
  for (const bad of [null, 'str', new Uint8Array(0), randomBytes(300), cat(Uint8Array.of(4), randomBytes(2000))]) {
    await assert.rejects(gb.acceptEpoch(bad, TRUST), isGroupErr())
  }
  // a replayed epoch message is recognised by its hash and changes nothing / 重放的纪元消息按摘要识别，不改变任何状态
  assert.equal((await gb.acceptEpoch(e1, TRUST)).duplicate, true)
  assert.equal((await gb.acceptEpoch(epochWire, TRUST)).duplicate, true)
  assert.equal(gb.epoch, 1)
  assert.equal(gb.open(owner.seal('first'), { text: true }).data, 'first')
  const t0 = performance.now()
  for (let s = 0; s < 200; s++) assert.throws(() => gb.open(cat(Uint8Array.of(5), gid, u64(1), u32(0), u64(2n ** 63n + BigInt(s)), randomBytes(24 + 100))), isGroupErr(/not signed/))
  const perJunk = (performance.now() - t0) / 200
  for (const bad of [null, new Uint8Array(10), cat(Uint8Array.of(5), gid, u64(1), u32(0xffffffff), u64(0), randomBytes(24 + 90)), cat(Uint8Array.of(5), gid, u64(2n ** 64n - 1n), u32(0), u64(0), randomBytes(24 + 90))]) {
    assert.throws(() => gb.open(bad), isGroupErr())
  }
  assert.equal(gb.epoch, 1)
  const r = gb.open(owner.seal('still fine'), { text: true })
  assert.equal(r.gap, 0, 'no high-water mark was moved by junk')
  assert.ok(perJunk < 50, `one Ed25519 verify per junk message (${perJunk.toFixed(2)} ms): bounded, not amplified`)
})

test('CONFIRMED C-06: sizes: a 32-member epoch with 4 maximal relays fits ChannelBus (16,448 B) and the relay (22,000 base64); so does a max message', async () => {
  const self = { container: C(0xc000), chainId: 56, identity: channel.generateIdentity() }
  const many = Array.from({ length: 31 }, (_, i) => entry({ container: C(0xc001 + i), identity: channel.generateIdentity() }))
  const url = 'https://' + 'r'.repeat(512 - 'https://'.length - '.example/x'.length) + '.example/x'
  const relays = [0, 1, 2, 3].map((i) => ({ url, container: C(0xd000 + i) }))
  const { group, epochWire } = await G.createGroup({ self, identity: self.identity, members: many, relays, bus: BUS, ...TRUST })
  assert.ok(epochWire.length <= channel.CHANNELBUS_MAX_WIRE, `${epochWire.length}`)
  assert.ok(Buffer.from(epochWire).toString('base64').length <= 22_000)
  const m = group.seal(new Uint8Array(G.MAX_PLAINTEXT))
  assert.ok(m.length <= channel.CHANNELBUS_MAX_WIRE && Buffer.from(m).toString('base64').length <= 22_000)
})

test('CONFIRMED C-07: seq is a BigInt end to end: 2^64-1 is accepted once, then everything from that sender is a replay', async () => {
  const random = recRandom()
  const { ms, owner, epochWire, join } = await trio({ random })
  const gc = await join(ms[2])
  const K = random.draws[1], gid = random.draws[0]
  const signAsB = (b) => ed25519.sign(b, ms[1].identity.ed25519.secretKey)
  const top = craftMsg({ gid, epoch: 0, index: 1, seq: 2n ** 64n - 1n, K, pt: te.encode('max'), sign: signAsB })
  const r = gc.open(top, { text: true })
  assert.equal(r.seq, 2n ** 64n - 1n)
  assert.throws(() => gc.open(craftMsg({ gid, epoch: 0, index: 1, seq: 5n, K, pt: te.encode('x'), sign: signAsB })), isGroupErr(/already seen/))
  assert.ok(owner && epochWire)
})

test('CONFIRMED C-08: a non-member who reads the room (gid, epoch messages) cannot join, read or inject', async () => {
  const { ms, owner, epochWire } = await trio()
  const eve = { container: C(0xee01), chainId: 56, identity: channel.generateIdentity() }
  const ge = G.joinGroup({ self: eve, identity: eve.identity, invite: { gid: owner.gid, owner: { container: ms[0].container, chainId: 56 } }, ownerKeys: entry(ms[0]) })
  await assert.rejects(ge.acceptEpoch(epochWire, TRUST), isGroupErr(/not a member/))
  assert.throws(() => ge.open(owner.seal('hi')), isGroupErr(/no key/))
  // an Ed25519 key that is not canonical (y >= p) is refused / 非规范的 Ed25519 公钥（y >= p）被拒
  const nc = new Uint8Array(32).fill(0xff); nc[0] = 0xee; nc[31] = 0x7f
  assert.throws(() => channel.assertEd25519Public(nc), /not a point/)
})
