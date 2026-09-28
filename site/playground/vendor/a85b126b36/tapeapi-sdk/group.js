// TAP-27 Tape Group: private group channels among up to 32 containers.
//
//   owner    keeps the member list; every change starts a new epoch with a fresh group key K, wrapped for each
//            member's channel X25519 key; the roster (who is in) travels encrypted under K, and slots carry no key
//            fingerprint, so a relay or chain observer learns a count and nothing else
//   members  encrypt under a per-sender key derived from K, with a random 24-byte nonce carried in the message,
//            and sign with their Ed25519 channel key
//
// Nothing here needs saved state to stay SAFE: nonces are random, sequence numbers start from the clock, and a
// member that restarts cannot be rolled back further than `minEpoch` (from snapshot()) or the 30-day freshness bound.
// Security rests on TAP-26 §3.1 channel records: a roster is the owner's statement of who is in, never proof of keys.
//
// TAP-27 Tape Group：至多 32 个容器之间的私密群聊。群主维护成员名单，每次变动开启新纪元并为每个成员包裹新的群密钥；
// 名单用群密钥加密、格子不带公钥指纹，中继只看到人数。成员用由群密钥派生的发送者密钥加密（随机数随消息携带），
// 并用 Ed25519 通道密钥签名。安全性不依赖保存状态：随机数是随机的、序号从时钟起算、重启后的成员最多被回滚到
// `minEpoch` 或 30 天新鲜度界限。名单只是群主的陈述，不是任何人密钥的证明。
import { x25519, ed25519 } from '@noble/curves/ed25519'
import { xchacha20poly1305 } from '@noble/ciphers/chacha'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { randomBytes } from '@noble/hashes/utils'
import { TapeAPIError } from './errors.js'
import { canonicalJSON, safeParseJSON } from './canon.js'
import { toHex, fromHex, assertUsablePublicKey, assertEd25519Public, checkRelays, checkBus, sealToInbox, openFromInbox } from './channel.js'

export const GROUP_INVITE_KIND = 'tape.group/invite'
export const ROSTER_KIND = 'tape.group/roster'
export const MAX_MEMBERS = 32
export const MAX_EPOCH = 2 ** 32 - 1                     // bounded, so a newer epoch can always be built / 有界，总能再建新纪元
export const MAX_EPOCH_AGE_S = 30 * 86400                // §3.3: an epoch message older than this is refused / 超龄纪元拒收
// How far ahead of our clock a roster's `issued` may be. The 30-day age bound is what stops replays; this only
// catches nonsense, so it is wide: an owner whose clock runs 6 minutes fast must not silently kill the group (arch B14).
// 名单 `issued` 可超前本方时钟多少。挡住重放的是 30 天的年龄界限；这里只拦明显的荒谬值，所以放宽：
// 群主时钟快 6 分钟不能悄无声息地让整个群失效。
export const FUTURE_SKEW_S = 3600
export const MAX_PLAINTEXT = 16_000
export const MAX_WIRE = 16 * 1024 + 64                   // = ChannelBus.MAX_WIRE
export const WIRE_EPOCH = 0x04
export const WIRE_MESSAGE = 0x05
export const KEEP_PREVIOUS_MS = 10 * 60 * 1000           // §3.3: previous epoch kept for messages in flight / 旧纪元保留时长
const HEADER_EPOCH = 1 + 16 + 8 + 32 + 24 + 32 + 1        // 114
const SLOT = 32 + 16                                      // wrapped K + tag; no fingerprint (§4) / 不带指纹
const HEADER_MSG = 1 + 16 + 8 + 4 + 8 + 24                // 61: type, gid, epoch, sender, seq, nonce
const SIG = 64
const SEQ_SEGMENT = 1n << 16n                             // seq = clock ms << 16 | counter (§3.4)

const te = new TextEncoder()
const fail = (msg, extra) => { throw new TapeAPIError('GROUP_INVALID', msg, extra) }
const concat = (...xs) => { const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of xs) { out.set(x, o); o += x.length } return out }
const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, Number(n)); return b }
const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b }
const readU32 = (b, at) => new DataView(b.buffer, b.byteOffset + at, 4).getUint32(0)
const readU64 = (b, at) => new DataView(b.buffer, b.byteOffset + at, 8).getBigUint64(0)
const sameContainer = (a, b) => String(a.container).toLowerCase() === String(b.container).toLowerCase() && (a.chainId ?? 56) === (b.chainId ?? 56)
const nowS = (clock) => Math.floor(clock.now() / 1000)
// `clock` (review G1 M4): every `now` in the SDK is Unix seconds, so a long-lived group takes a clock function that returns
// Unix seconds too (fractional allowed); internally the group keeps milliseconds. The 0.x option `now` (a function of
// milliseconds) is refused rather than misread. / 全 SDK 的 now 都是 Unix 秒；长期存在的群句柄接受返回 Unix 秒的 clock 函数（可带小数），
// 内部仍用毫秒。0.x 的 `now`（返回毫秒的函数）直接拒绝，而不是被误读。
const clockMs = (opts) => {
  if (Object.prototype.hasOwnProperty.call(opts, 'now')) throw new TapeAPIError('INVALID_ARGUMENT', 'the group option `now` (milliseconds) was renamed in 1.0: pass `clock`, a function returning Unix seconds (docs/guides/upgrade-1.0.md)')
  const { clock } = opts
  if (clock === undefined) return undefined
  if (typeof clock !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', 'clock must be a function returning Unix seconds')
  // One sample when the group is made (review RC-10): above 1e11 (the year 5138 in seconds) it is milliseconds, e.g.
  // Date.now, the 0.x default, which would issue epochs every member refuses as "in the future".
  // 创建时取样一次：超过 1e11（按秒是 5138 年）就是毫秒，比如 0.x 默认的 Date.now，会签出所有成员都当作"来自未来"而拒绝的纪元。
  const v = clock()
  if (typeof v !== 'number' || !Number.isFinite(v) || v > 1e11) throw new TapeAPIError('INVALID_ARGUMENT', `clock must return Unix seconds: it returned ${typeof v === 'number' ? v : typeof v}${typeof v === 'number' && v > 1e11 ? ', which looks like milliseconds (pass () => Date.now() / 1000)' : ''}`)
  return () => Math.round(clock() * 1000)
}
const edVerify = (sig, msg, pub) => { try { return ed25519.verify(sig, msg, pub, { zip215: false }) } catch { return false } }

/** The one room a group uses: SHA-256("TAP-27/room/v1" ‖ gid) / 群所用的唯一房间 */
export function groupRoom(gid) {
  const g = typeof gid === 'string' ? fromHex(gid, 16, 'gid') : gid
  return toHex(sha256(concat(te.encode('TAP-27/room/v1'), g)))
}

function dh(secret, pub) {
  let ss
  try { ss = x25519.getSharedSecret(secret, pub) } catch { fail('X25519 failed (invalid or low-order key)') }
  if (ss.every((x) => x === 0)) fail('X25519 gave the all-zero secret (low-order key)')
  return ss
}
const kekFor = (ss, E, R, gid, epoch) => hkdf(sha256, ss, te.encode('TAP-27/wrap/v1'), concat(E, R, gid, u64(epoch)), 32)
const commitOf = (K) => sha256(concat(te.encode('TAP-27/commit/v1'), K))
/** §3.4: the key a sender encrypts under in an epoch / 发送者在某纪元的加密密钥 */
export const senderKey = (K, gid, epoch, index) => hkdf(sha256, K, concat(gid, u64(epoch)), concat(te.encode('TAP-27/sender/v1'), u32(index)), 32)

function checkIdentity(identity) {
  if (!identity?.x25519?.secretKey || !identity?.ed25519?.secretKey) fail('identity needs x25519 and ed25519 secret keys (channel.generateIdentity())')
  const edPub = ed25519.getPublicKey(identity.ed25519.secretKey)
  try { assertEd25519Public(edPub, 'own ed25519') } catch (e) { fail(e.message) }
  return { xSecret: identity.x25519.secretKey, xPub: x25519.getPublicKey(identity.x25519.secretKey), edSecret: identity.ed25519.secretKey, edPub }
}
// §3.3: a roster member is exactly { container, chainId, x25519, ed25519 } with lowercase 0x-hex keys, so that
// the roster a receiver hashes is the roster the owner sent. / 名单成员恰为这四个字段、密钥为小写 0x 十六进制。
const hex32 = (v, name) => {
  const s = typeof v === 'string' ? v.toLowerCase() : '0x' + toHex(v)
  const h = s.startsWith('0x') ? s : '0x' + s
  if (!/^0x[0-9a-f]{64}$/.test(h)) fail(`${name} must be 32 bytes of hex`)
  return h
}
function normMember(m) {
  if (!m || typeof m.container !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(m.container)) fail('member.container must be an address')
  const chainId = m.chainId ?? 56
  if (!Number.isInteger(chainId) || chainId < 1) fail('member.chainId must be a positive integer')
  const x = hex32(m.x25519, 'member x25519'), ed = hex32(m.ed25519, 'member ed25519')
  try { assertUsablePublicKey(fromHex(x, 32, 'x25519'), 'member x25519') } catch (e) { fail(e.message) }
  try { assertEd25519Public(ed, 'member ed25519') } catch (e) { fail(e.message) }
  return { container: m.container.toLowerCase(), chainId, x25519: x, ed25519: ed }
}
function checkUnique(members) {
  const seen = new Set()
  for (const m of members) {
    for (const k of [`c:${m.chainId}:${m.container.toLowerCase()}`, `x:${m.x25519}`, `e:${m.ed25519}`]) {
      if (seen.has(k)) fail(`the roster lists ${m.container} twice, or two members share a key`)
      seen.add(k)
    }
  }
}
/**
 * Check each member; returns the ones whose records definitively no longer match. `fresh` is passed on as
 * verifyMember(m, { fresh }): api.groupVerifier() then reads past its cache (arch B7).
 * 返回记录已确定不符的成员。`fresh` 以 verifyMember(m, { fresh }) 传入：api.groupVerifier() 随即绕过缓存读取。
 */
async function verifyAll(members, verifyMember, { drop = false, fresh = false } = {}) {
  if (verifyMember === 'trust-roster') return []        // tests and vectors only / 仅用于测试与向量
  if (typeof verifyMember !== 'function') fail('verifyMember is required: check every member against its TAP-26 channel record (api.groupVerifier())')
  const bad = []
  for (const m of members) {
    let ok
    try { ok = await verifyMember(m, { fresh }) } catch (e) { fail(`member ${m.container}: ${e.message}`) }   // a transient failure never drops anyone / 暂时性故障绝不移除任何人
    if (ok !== true) { if (drop) bad.push(m); else fail(`member ${m.container}: keys do not match its channel record`) }
  }
  return bad
}

/**
 * §3.3: build an epoch message. Random draws, in order: K, e, N (the vectors depend on this order).
 * 构造纪元消息。随机数按 K、e、N 的顺序抽取（向量依赖此顺序）。
 */
export function buildEpoch({ gid, epoch, issued, prev, owner, members, relays = [], bus, ownerEdSecret, random = randomBytes }) {
  if (!Array.isArray(members) || members.length < 1 || members.length > MAX_MEMBERS) fail(`a group has 1..${MAX_MEMBERS} members`)
  if (!Number.isInteger(epoch) || epoch < 0 || epoch > MAX_EPOCH) fail(`epoch must be an integer in 0..${MAX_EPOCH}`)
  const list = members.map(normMember)
  if (!sameContainer(list[0], owner)) fail('members[0] must be the owner')
  checkUnique(list)
  checkRelays(relays); checkBus(bus)
  const roster = {
    v: 1, kind: ROSTER_KIND, gid: toHex(gid), epoch, issued, prev,
    owner: { container: owner.container.toLowerCase(), chainId: owner.chainId ?? 56 },
    members: list,
    relays: relays.map((r) => ({ url: r.url, container: r.container })), ...(bus ? { bus } : {}),
  }
  const rosterBytes = te.encode(canonicalJSON(roster))
  const K = random(32)
  const e = random(32)
  const E = x25519.getPublicKey(e)
  const N = random(24)
  const header = concat(Uint8Array.of(WIRE_EPOCH), gid, u64(epoch), E, N, commitOf(K), Uint8Array.of(list.length))
  const slots = concat(...list.map((m) => {
    const R = fromHex(m.x25519, 32, 'x25519')
    const ss = dh(e, R)
    const kek = kekFor(ss, E, R, gid, epoch)
    ss.fill(0)
    return xchacha20poly1305(kek, N, header).encrypt(K)
  }))
  e.fill(0)
  const ct = xchacha20poly1305(K, N, concat(header, slots)).encrypt(rosterBytes)
  const body = concat(header, slots, u32(ct.length), ct)
  const wire = concat(body, ed25519.sign(concat(te.encode('TAP-27/epoch/v1'), body), ownerEdSecret))
  if (wire.length > MAX_WIRE) fail(`epoch message of ${wire.length} bytes is too large for one wire message`)
  return { wire, K, roster, rosterBytes }
}

function parseEpoch(wire) {
  if (!(wire instanceof Uint8Array) || wire.length < HEADER_EPOCH + SLOT + 4 + 16 + SIG || wire[0] !== WIRE_EPOCH) fail('not an epoch message')
  if (wire.length > MAX_WIRE) fail('epoch message too large')
  const count = wire[HEADER_EPOCH - 1]
  if (count < 1 || count > MAX_MEMBERS) fail('bad member count')
  const slotsEnd = HEADER_EPOCH + SLOT * count
  if (wire.length < slotsEnd + 4 + 16 + SIG) fail('epoch message truncated')
  const ctLen = readU32(wire, slotsEnd)
  if (wire.length !== slotsEnd + 4 + ctLen + SIG) fail('epoch message length does not match its roster')
  const epoch = readU64(wire, 17)
  if (epoch > BigInt(MAX_EPOCH)) fail('epoch out of range')
  return {
    gid: wire.slice(1, 17), epoch: Number(epoch), E: wire.slice(25, 57), N: wire.slice(57, 81), commit: wire.slice(81, 113), count,
    header: wire.slice(0, HEADER_EPOCH), slots: wire.slice(HEADER_EPOCH, slotsEnd), ct: wire.slice(slotsEnd + 4, slotsEnd + 4 + ctLen),
    body: wire.slice(0, wire.length - SIG), sig: wire.slice(wire.length - SIG),
  }
}

function makeGroup({ gid, self, id, ownerRef, ownerEd, isOwner, minEpoch = null, lastSeq = null, random = randomBytes, now = () => Date.now() }) {
  const epochs = new Map()          // epoch -> { roster, rosterBytes, K, index, members, high, keys, expiresAt, removed, movedOn }
  const accepted = new Map()        // epoch -> sha256 of the accepted epoch message body (equivocation evidence) / 已接受纪元消息的摘要
  let current = null
  let floor = minEpoch               // never accept an epoch below this (from snapshot()) / 永不接受低于此的纪元
  // the next seq to use. After a restart, one past the last seq used (from snapshot()), so a clock that stepped
  // back cannot make our new messages look like replays to receivers still holding our old high (arch B14)
  // 下一个要用的序号。重启后从快照中最后用过的序号加一起算：时钟回拨也不会让新消息在仍记着旧最大值的接收方看来像重放
  let mySeq = lastSeq === null ? 0n : lastSeq + 1n
  let queue = Promise.resolve()      // one acceptEpoch at a time (audit G-03) / 同一时刻只处理一条纪元消息
  let sealed = lastSeq !== null      // whether mySeq - 1 is a seq actually used (or restored) / mySeq - 1 是否真的用过（或恢复而来）
  const room = groupRoom(gid)
  const clock = { now }

  function install(epoch, roster, rosterBytes, K) {
    if (current !== null && epoch <= current) fail(`epoch ${epoch} is not newer than ${current}`)   // never backwards / 绝不后退
    const index = roster.members.findIndex((m) => sameContainer(m, self))
    const prevEpoch = current
    epochs.set(epoch, { roster, rosterBytes, K, index, members: roster.members, high: new Map(), keys: new Map(), expiresAt: Infinity, removed: new Set(), movedOn: new Set() })
    if (prevEpoch !== null && epochs.has(prevEpoch)) {
      const prev = epochs.get(prevEpoch)
      prev.expiresAt = clock.now() + KEEP_PREVIOUS_MS
      // senders no longer in the roster may not use the previous epoch at all (audit G-06)
      // 已不在名单里的发送者完全不能再使用上一纪元
      prev.members.forEach((m, i) => { if (!roster.members.some((x) => sameContainer(x, m))) prev.removed.add(i) })
    }
    for (const [n, st] of epochs) if (n < epoch && n !== prevEpoch) { st.K.fill(0); epochs.delete(n) }
    current = epoch
    floor = epoch
    // seq starts from the clock, so a restarted sender never repeats one, with or without saved state (audit G-01),
    // and never at or below the last seq it used (restored from snapshot().lastSeq), whatever the clock says (arch B14)
    // 序号从时钟起算，重启的发送者无论有没有保存状态都不会重复；且无论时钟如何，都大于之前用过的最后一个序号（取自快照）
    const fromClock = BigInt(clock.now()) * SEQ_SEGMENT
    mySeq = fromClock > mySeq ? fromClock : mySeq + 1n
  }
  const live = (epoch) => {
    const st = epochs.get(epoch)
    if (!st) return null
    if (st.expiresAt <= clock.now()) { st.K.fill(0); epochs.delete(epoch); return null }
    return st
  }
  const keyOf = (st, epoch, index) => {
    if (!st.keys.has(index)) st.keys.set(index, senderKey(st.K, gid, epoch, index))
    return st.keys.get(index)
  }

  async function acceptOne(wire, verifyMember) {
    const p = parseEpoch(wire)
    if (!equal(p.gid, gid)) fail('epoch message for another group')
    if (!edVerify(p.sig, concat(te.encode('TAP-27/epoch/v1'), p.body), ownerEd)) fail('epoch message is not signed by the owner')
    const bodyHash = toHex(sha256(p.body))
    // an owner that signs two different messages for one epoch has equivocated; keep the evidence (audit G-11)
    // 群主为同一纪元签了两条不同消息即为两面行为，保留证据
    if (accepted.has(p.epoch)) {
      if (accepted.get(p.epoch) === bodyHash) return { epoch: p.epoch, roster: epochs.get(p.epoch)?.roster ?? null, duplicate: true }
      throw new TapeAPIError('GROUP_EQUIVOCATION', `the owner signed two different messages for epoch ${p.epoch}`, { data: { epoch: p.epoch, hashes: [accepted.get(p.epoch), bodyHash] } })
    }
    if (current !== null && p.epoch <= current) fail(`epoch ${p.epoch} is not newer than ${current}`)
    if (floor !== null && p.epoch < floor) fail(`epoch ${p.epoch} is below ${floor}, the lowest this member may accept (a rollback)`)
    // try every slot: no fingerprints, so nobody outside learns which slot is whose (audit G-04)
    // 逐格尝试：没有指纹，外人无从得知哪格属于谁
    const ss = dh(id.xSecret, p.E)
    const kek = kekFor(ss, p.E, id.xPub, gid, p.epoch)
    ss.fill(0)
    let K = null, myIndex = -1
    for (let i = 0; i < p.count; i++) {
      let k
      try { k = xchacha20poly1305(kek, p.N, p.header).decrypt(p.slots.slice(i * SLOT, (i + 1) * SLOT)) } catch { continue }
      if (K) fail('two slots open with our key: the roster lists our key twice')
      K = k; myIndex = i
    }
    if (!K) fail('no slot in this epoch opens with our key: we are not a member of it')
    if (!equal(commitOf(K), p.commit)) fail('the group key does not match the commitment the owner signed')
    let roster, rosterBytes
    try {
      rosterBytes = xchacha20poly1305(K, p.N, concat(p.header, p.slots)).decrypt(p.ct)
      roster = safeParseJSON(new TextDecoder('utf-8', { fatal: true }).decode(rosterBytes), { code: 'GROUP_INVALID' })
    } catch (e) { fail(`roster does not decrypt or parse: ${e.message}`) }
    if (!roster || roster.v !== 1 || roster.kind !== ROSTER_KIND) fail('not a roster')
    if (roster.gid !== toHex(gid) || roster.epoch !== p.epoch) fail('roster gid/epoch do not match the header')
    if (!Number.isInteger(roster.issued)) fail('roster.issued must be unix seconds')
    const t = nowS(clock)
    if (roster.issued > t + FUTURE_SKEW_S) fail('roster issued in the future')
    if (roster.issued < t - MAX_EPOCH_AGE_S) fail('roster older than 30 days: the owner must start a new epoch (a stale or replayed message)')
    if (!roster.owner || !sameContainer(roster.owner, ownerRef)) fail('roster names another owner')
    if (!Array.isArray(roster.members) || roster.members.length !== p.count) fail('roster member count does not match the slots')
    const members = roster.members.map((m, i) => {
      const keys = Object.keys(m || {}).sort().join(',')
      if (keys !== 'chainId,container,ed25519,x25519') fail(`member ${i} must have exactly container, chainId, x25519, ed25519`)
      const n = normMember(m)
      if (n.container !== m.container || n.x25519 !== m.x25519 || n.ed25519 !== m.ed25519) fail(`member ${i} is not in canonical form (lowercase 0x hex)`)
      return n
    })
    checkUnique(members)
    if (!sameContainer(members[0], ownerRef)) fail('members[0] must be the owner')
    if (!equal(fromHex(members[0].ed25519, 32), ownerEd)) fail('the owner entry carries another Ed25519 key')
    const me = members[myIndex]
    if (!sameContainer(me, self) || !equal(fromHex(me.x25519, 32), id.xPub) || !equal(fromHex(me.ed25519, 32), id.edPub)) fail('our slot names another container or other keys')
    const held = current === null ? null : epochs.get(current)
    // prev is the hash of the roster bytes AS SENT (audit G-12) / prev 是按原样发送的名单字节的哈希
    if (held && current === p.epoch - 1 && roster.prev !== toHex(sha256(held.rosterBytes))) fail('roster.prev does not chain to the roster we hold')
    checkRelays(roster.relays ?? []); checkBus(roster.bus)
    await verifyAll(members, verifyMember)
    install(p.epoch, { ...roster, members }, rosterBytes, K)
    accepted.set(p.epoch, bodyHash)
    for (const n of accepted.keys()) if (n < p.epoch - 64) accepted.delete(n)   // enough to recognise a fork of a recent epoch / 足以识别近期纪元的分叉
    return { epoch: p.epoch, roster: epochs.get(p.epoch).roster }
  }

  const group = {
    gid: toHex(gid), room, isOwner,
    get epoch() { return current },
    get roster() { return current === null ? null : epochs.get(current).roster },
    get members() { return current === null ? [] : epochs.get(current).members.map((m) => ({ ...m })) },
    _clock: clock,
    _install: install,

    /**
     * What to keep across a restart. No secrets: for a member, the epoch to refuse rollbacks below; for the owner,
     * also the roster, so resumeGroup() can start the next epoch. `lastSeq` (decimal string, present once a message
     * was sealed) is at least the last seq this sender used: pass it back (joinGroup / resumeGroup) and a clock that stepped
     * back cannot make new messages look like replays (arch B14). Take the snapshot after sealing.
     * 跨重启要保存的内容，不含任何私钥：成员只需纪元号（拒绝回滚到它之下）；群主另存名单，以便 resumeGroup() 开启下一纪元。
     * `lastSeq`（十进制字符串，封装过消息后才有）不小于本发送者最后用过的序号：重启时传回，时钟回拨也不会让新消息像重放。
     * 在 seal 之后取快照。
     */
    snapshot() {
      const st = current === null ? null : epochs.get(current)
      return {
        v: 1, gid: toHex(gid), owner: { container: String(ownerRef.container).toLowerCase(), chainId: ownerRef.chainId ?? 56 },
        epoch: current ?? floor, role: isOwner ? 'owner' : 'member',
        ...(sealed ? { lastSeq: (mySeq - 1n).toString() } : {}),
        ...(isOwner && st ? { roster: new TextDecoder().decode(st.rosterBytes) } : {}),
      }
    },

    /**
     * §3.3: check an epoch message and move to its epoch. `verifyMember(member)` must resolve true for every member
     * (api.groupVerifier() checks each against its TAP-26 channel record). Calls are serialised.
     * 核对纪元消息并切换到该纪元。`verifyMember(member)` 必须对每个成员返回 true。调用按顺序执行。
     */
    acceptEpoch(wire, { verifyMember } = {}) {
      const run = queue.then(() => acceptOne(wire, verifyMember))
      queue = run.catch(() => {})
      return run
    },

    /** §3.4: encrypt and sign a message for the current epoch / 为当前纪元加密并签名一条消息 */
    seal(data, { random: r = random } = {}) {
      if (current === null) fail('no epoch yet')
      const st = epochs.get(current)
      const pt = typeof data === 'string' ? te.encode(data) : data
      if (!(pt instanceof Uint8Array)) fail('seal takes a string or Uint8Array')
      if (pt.length > MAX_PLAINTEXT) fail(`plaintext of ${pt.length} bytes exceeds ${MAX_PLAINTEXT}`)
      const seq = mySeq++
      sealed = true
      const nonce = r(24)
      const header = concat(Uint8Array.of(WIRE_MESSAGE), gid, u64(current), u32(st.index), u64(seq), nonce)
      const ct = xchacha20poly1305(keyOf(st, current, st.index), nonce, header).encrypt(pt)
      return concat(header, ct, ed25519.sign(concat(te.encode('TAP-27/msg/v1'), header, ct), id.edSecret))
    },

    /**
     * §3.4: verify and decrypt. Returns { from, index, epoch, seq, gap, data } (`data` is text with { text: true }),
     * or { own: true } for our own message coming back. `gap` is null when the sender restarted in between.
     * 验证并解密。自己发出的消息返回 { own: true }。发送者中途重启时 `gap` 为 null。
     */
    open(wire, { text = false } = {}) {
      if (!(wire instanceof Uint8Array) || wire.length < HEADER_MSG + 16 + SIG || wire[0] !== WIRE_MESSAGE) fail('not a group message')
      if (wire.length > MAX_WIRE) fail('group message too large')
      if (!equal(wire.slice(1, 17), gid)) fail('message for another group')
      const epochBig = readU64(wire, 17)
      if (epochBig > BigInt(MAX_EPOCH)) fail('epoch out of range')
      const epoch = Number(epochBig)
      const index = readU32(wire, 25)
      const seq = readU64(wire, 29)
      const st = live(epoch)
      if (!st) fail(`no key for epoch ${epoch} (not joined yet, or the epoch expired)`)
      if (index >= st.members.length) fail('sender index outside the roster')
      const header = wire.slice(0, HEADER_MSG), ct = wire.slice(HEADER_MSG, wire.length - SIG), sig = wire.slice(wire.length - SIG)
      // verify first, even our own: a relay must not make us swallow a message by relabelling it (audit G-17)
      // 先验签，哪怕是自己的：中继不能靠改署名让我们吞掉一条消息
      if (!edVerify(sig, concat(te.encode('TAP-27/msg/v1'), header, ct), fromHex(st.members[index].ed25519, 32))) fail(`message is not signed by member ${index}`)
      if (index === st.index) return { own: true, epoch, seq }
      if (epoch !== current) {
        if (st.removed.has(index)) fail(`member ${index} was removed after epoch ${epoch}: its messages under it are refused`)
        if (st.movedOn.has(index)) fail(`member ${index} already speaks in epoch ${current}: its epoch-${epoch} messages are refused`)
      }
      const high = st.high.get(index)
      if (high !== undefined && seq <= high) fail(`seq ${seq} from member ${index} already seen (replayed or reordered)`)
      let pt
      try { pt = xchacha20poly1305(keyOf(st, epoch, index), wire.slice(37, 61), header).decrypt(ct) } catch { fail('message fails authentication') }
      let decoded
      if (text) { try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(pt) } catch { fail('message is authentic but not UTF-8') } }
      const gap = high === undefined ? null : (seq - high - 1n < SEQ_SEGMENT ? Number(seq - high - 1n) : null)
      st.high.set(index, seq)
      if (epoch === current) {
        // this sender has moved on: drop its previous-epoch key (§3.3) / 该发送者已进入新纪元：丢弃其旧纪元密钥
        const prev = [...epochs.keys()].find((n) => n < current)
        if (prev !== undefined) {
          const ps = epochs.get(prev)
          const pi = ps.members.findIndex((m) => sameContainer(m, st.members[index]))
          if (pi >= 0) ps.movedOn.add(pi)
        }
      }
      return { from: st.members[index].container, index, epoch, seq, gap, data: text ? decoded : pt }
    },
  }
  return { group, install }
}

function ownerApi({ group, install, gid, owner, id, verifyMember, random, transports, startList }) {
  let list = startList
  let lastWire = null                // the latest epoch message this owner built, for reposts (§3.5) / 最近一条纪元消息，供重发
  // `added`: the members this epoch brings in, who still need an invite in their OWN inbox room (§3.5). The epoch
  // message alone reaches nobody new: it goes to the group room, which a new member does not know yet.
  // `added`：本纪元新加入、仍需在各自收件房间收到邀请的成员。纪元消息只发到群房间，新成员还不知道这个房间。
  const next = async (newList, { verify = verifyMember, added = [] } = {}) => {
    // Re-check EVERY member, not only additions: a circuit that changed hands drops out here, instead of freezing
    // the group for everyone else (audit G-15). A transient failure aborts; a definitive mismatch drops.
    // 重新核验**全部**成员，而不只是新加入者：转手的电路在此退出，而不是让整个群卡住。暂时故障则中止，确定不符则移除。
    // Read past the identity cache (arch B7): a record cached a minute before the sale would keep the sold member for
    // a whole epoch, not a few minutes. The owner decides when this runs; no outsider can make it read.
    // 绕过身份缓存：出售前一分钟缓存的记录会让已出售的成员再留一整个纪元，而不是几分钟。何时执行由群主决定，外人无法触发读取。
    const dropped = await verifyAll(newList.slice(1), verify, { drop: true, fresh: group.epoch !== null })
    const keep = newList.filter((m, i) => i === 0 || !dropped.includes(m))
    const epoch = group.epoch === null ? 0 : group.epoch + 1
    if (epoch > MAX_EPOCH) fail('epoch counter exhausted: create a new group')
    const snap = group.snapshot()
    const prev = group.epoch === null ? '00'.repeat(32) : toHex(sha256(te.encode(snap.roster)))
    const issued = Math.floor(group._clock.now() / 1000)
    const built = buildEpoch({ gid, epoch, issued, prev, owner, members: keep, relays: transports.relays, bus: transports.bus, ownerEdSecret: id.edSecret, random })
    install(epoch, { ...built.roster }, built.rosterBytes, built.K)
    list = built.roster.members
    lastWire = built.wire
    const inRoster = added.filter((m) => list.some((x) => sameContainer(x, m))).map((m) => list.find((x) => sameContainer(x, m)))
    return { epochWire: built.wire, epoch, dropped: dropped.map((m) => m.container), added: inRoster.map((m) => ({ ...m })) }
  }
  // Read-only: the epoch message to repost (§3.5 SHOULD: on each invite, and as often as the transport forgets).
  // 只读：要重发的纪元消息（§3.5：每次邀请时，以及按传输层遗忘数据的频率）。
  Object.defineProperty(group, 'epochWire', { get: () => lastWire, enumerable: false })
  Object.assign(group, {
    /**
     * Add members (checked with verifyMember) and start a new epoch. Returns { epochWire, epoch, dropped, added }.
     * TWO ROOMS: `epochWire` goes to the GROUP room (group.room); each member in `added` also needs an invite,
     * inviteFor(member), in ITS OWN inbox room (channel.inboxRoom(container, chainId)). Posting only the epoch message
     * leaves the new members waiting for ever. deliverGroupUpdate({ group, update }) does both and reports every post.
     * 加人并开启新纪元。**两个房间**：`epochWire` 发到**群房间**；`added` 中每个成员还需要一份邀请（inviteFor）发到
     * **它自己的收件房间**。只发纪元消息，新成员会一直等下去。推荐直接用 deliverGroupUpdate({ group, update })。
     */
    async addMembers(entries, opts = {}) {
      const add = entries.map(normMember)
      for (const m of add) if (list.some((x) => sameContainer(x, m))) fail(`${m.container} is already a member`)
      if (list.length + add.length > MAX_MEMBERS) fail(`a group has at most ${MAX_MEMBERS} members`)
      await verifyAll(add, opts.verifyMember ?? verifyMember)
      return next([...list, ...add], { verify: opts.verifyMember ?? verifyMember, added: add })
    },
    /** Remove members and start a new epoch they cannot read (§3.6) / 移除成员并开启他们读不到的新纪元 */
    async removeMembers(targets, opts = {}) {
      const drop = targets.map((t) => ({ container: t.container ?? t, chainId: t.chainId ?? 56 }))
      if (drop.some((d) => sameContainer(d, owner))) fail('the owner cannot be removed; a group that needs a new owner is a new group')
      const keep = list.filter((m) => !drop.some((d) => sameContainer(d, m)))
      if (keep.length === list.length) fail('none of these is a member')
      return next(keep, { verify: opts.verifyMember ?? verifyMember })
    },
    /** A fresh key for the same members (§3.6: at least every 30 days) / 同样的成员换一把新密钥（至少每 30 天一次） */
    rotate(opts = {}) { return next(list, { verify: opts.verifyMember ?? verifyMember }) },
    /**
     * The sealed invite (wire type 0x03) for a member's INBOX room (§3.5): post it to
     * channel.inboxRoom(member.container, member.chainId) -- the CONTAINER address, never the holder's wallet, and the
     * member's own chainId -- not to the group room, where the epoch message goes. deliverGroupUpdate() posts both.
     * 发往成员**收件房间**的密封入群邀请（线路类型 0x03）：投到 channel.inboxRoom(成员容器地址, chainId)——必须是容器
     * 地址而不是持有人钱包，chainId 用成员自己的——而不是纪元消息所去的群房间。deliverGroupUpdate() 两者都投。
     */
    inviteFor(member, { random: r = random } = {}) {
      const m = normMember(member)
      return sealToInbox({ v: 1, kind: GROUP_INVITE_KIND, gid: toHex(gid), owner, relays: transports.relays.map((x) => ({ url: x.url, container: x.container })), ...(transports.bus ? { bus: transports.bus } : {}) },
        { to: { container: m.container, chainId: m.chainId, staticPublic: m.x25519 }, random: r })
    },
  })
  return next
}

/**
 * Owner: create a group. `members` are OTHER members as api.chain.channelKeys returns them (or { container, chainId,
 * x25519, ed25519 }); each is checked with `verifyMember`. Returns { group, epochWire, epoch, added }.
 * TWO ROOMS: `epochWire` goes to the GROUP room (group.room); every member in `added` also needs
 * group.inviteFor(member) posted to ITS OWN inbox room (channel.inboxRoom(container, chainId)), or it never learns
 * the group exists. deliverGroupUpdate({ group, update }) posts both and reports each post.
 * 群主：建群。`members` 为其他成员（形如 api.chain.channelKeys 的返回值），每个都经 `verifyMember` 核验。
 * **两个房间**：`epochWire` 发到**群房间**；`added` 中每个成员还需要 group.inviteFor(member) 发到**它自己的收件房间**，
 * 否则它永远不知道这个群。推荐直接用 deliverGroupUpdate({ group, update })，两者都投并逐条报告结果。
 */
// `clock` (Unix seconds) exists for vectors and tests / `clock`（Unix 秒）用于向量与测试
export async function createGroup(opts = {}) {
  const { self, identity, members = [], relays = [], bus, verifyMember, random = randomBytes } = opts
  const now = clockMs(opts)
  const id = checkIdentity(identity)
  const owner = { container: self.container.toLowerCase(), chainId: self.chainId ?? 56 }
  const ownerEntry = normMember({ ...owner, x25519: id.xPub, ed25519: id.edPub })
  const others = members.map(normMember)
  checkUnique([ownerEntry, ...others])
  await verifyAll(others, verifyMember)
  const gid = random(16)
  const { group, install } = makeGroup({ gid, self: owner, id, ownerRef: owner, ownerEd: id.edPub, isOwner: true, random, ...(now ? { now } : {}) })
  const next = ownerApi({ group, install, gid, owner, id, verifyMember, random, transports: { relays, bus }, startList: [ownerEntry, ...others] })
  const first = await next([ownerEntry, ...others], { verify: 'trust-roster', added: others })   // just verified above / 刚刚核验过
  return { group, epochWire: first.epochWire, epoch: first.epoch, added: first.added }
}

/**
 * Owner after a restart: continue a group from its snapshot(). The previous epoch key is gone, so this starts the next
 * epoch at once (re-checking every member) and returns its message to post.
 * 群主重启后：从 snapshot() 继续一个群。旧纪元密钥已不在，因此立即开启下一纪元（并重新核验全部成员），返回其消息。
 */
export async function resumeGroup(opts = {}) {
  const { self, identity, snapshot, relays, bus, verifyMember, random = randomBytes } = opts
  const now = clockMs(opts)
  const id = checkIdentity(identity)
  if (!snapshot || snapshot.v !== 1 || snapshot.role !== 'owner' || typeof snapshot.roster !== 'string') fail('resumeGroup needs an owner snapshot()')
  const owner = { container: self.container.toLowerCase(), chainId: self.chainId ?? 56 }
  if (!sameContainer(snapshot.owner, owner)) fail('this snapshot belongs to another owner')
  let roster
  try { roster = safeParseJSON(snapshot.roster, { code: 'GROUP_INVALID' }) } catch (e) { fail(`snapshot roster: ${e.message}`) }
  if (roster.gid !== snapshot.gid || roster.epoch !== snapshot.epoch) fail('snapshot roster does not match the snapshot')
  const gid = fromHex(snapshot.gid, 16, 'gid')
  const { group, install } = makeGroup({ gid, self: owner, id, ownerRef: owner, ownerEd: id.edPub, isOwner: true, lastSeq: parseLastSeq(snapshot.lastSeq), random, ...(now ? { now } : {}) })
  // stand the old roster up without a key, only so the next epoch chains to it / 立起旧名单（无密钥），只为让下一纪元接上
  install(roster.epoch, roster, te.encode(snapshot.roster), new Uint8Array(32))
  const next = ownerApi({ group, install, gid, owner, id, verifyMember, random, transports: { relays: relays ?? roster.relays ?? [], bus: bus ?? roster.bus }, startList: roster.members.map(normMember) })
  const r = await next(roster.members.map(normMember))
  return { group, epochWire: r.epochWire, epoch: r.epoch, dropped: r.dropped, added: r.added }
}

// snapshot().lastSeq: a decimal string (a seq is clock ms << 16, beyond 2^53), a bigint, or absent
// snapshot().lastSeq：十进制字符串（序号是时钟毫秒 << 16，超出 2^53）、bigint，或不存在
const parseLastSeq = (v) => {
  if (v === undefined || v === null) return null
  if (typeof v === 'bigint' && v >= 0n && v < 2n ** 64n - 1n) return v
  if (typeof v === 'string' && /^(0|[1-9]\d{0,19})$/.test(v) && BigInt(v) < 2n ** 64n - 1n) return BigInt(v)
  fail('lastSeq must be the decimal string snapshot() gave')
}

/** Open a group invite from this container's inbox (§3.5) / 从收件房间打开入群邀请 */
export function openGroupInvite(wire, { self }) {
  const inv = openFromInbox(wire, { self })
  if (inv.kind !== GROUP_INVITE_KIND) fail('not a group invite')
  if (typeof inv.gid !== 'string' || !/^[0-9a-f]{32}$/.test(inv.gid)) fail('invite.gid must be 16 bytes of lowercase hex')
  if (!inv.owner || typeof inv.owner.container !== 'string') fail('invite.owner is required')
  checkRelays(inv.relays ?? []); checkBus(inv.bus)
  return inv
}

/**
 * Member: prepare to join the group an invite names. `ownerKeys` are the owner's channel keys, looked up from the
 * chain by invite.owner (api.chain.channelKeys) -- never taken from the invite. The invite's relays and bus are only
 * where to look: once an epoch is accepted, use the roster's (the owner signed those). Pass `minEpoch` from a saved
 * snapshot() after a restart, so an old epoch replayed by a relay is refused, and `lastSeq` from it, so our seq never
 * goes backwards when the clock did (arch B14).
 * 成员：准备加入邀请所指的群。`ownerKeys` 为按 invite.owner 从链上查到的群主通道密钥——绝不取自邀请。邀请里的中继与总线
 * 只用于"去哪里找"；接受纪元后应改用名单里的（群主签过的）。重启后传入快照中的 `minEpoch`，拒绝中继重放的旧纪元；
 * 并传入其中的 `lastSeq`，时钟回拨时序号也不后退。
 */
export function joinGroup(opts = {}) {
  const { self, identity, invite, ownerKeys, minEpoch, lastSeq } = opts
  const now = clockMs(opts)
  const id = checkIdentity(identity)
  if (!ownerKeys || !sameContainer(ownerKeys, invite.owner)) fail('ownerKeys must be the channel keys of invite.owner')
  let ownerEd
  try { ownerEd = assertEd25519Public(ownerKeys.ed25519, 'owner ed25519') } catch (e) { fail(e.message) }
  if (minEpoch !== undefined && (!Number.isInteger(minEpoch) || minEpoch < 0 || minEpoch > MAX_EPOCH)) fail('minEpoch must be an epoch number')
  const gid = fromHex(invite.gid, 16, 'gid')
  const { group } = makeGroup({ gid, self: { container: self.container.toLowerCase(), chainId: self.chainId ?? 56 }, id, ownerRef: invite.owner, ownerEd, isOwner: false, minEpoch: minEpoch ?? null, lastSeq: parseLastSeq(lastSeq), ...(now ? { now } : {}) })
  return group
}
