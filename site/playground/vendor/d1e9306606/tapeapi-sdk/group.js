// TAPI-27 Tape Group: private group channels among up to 32 containers.
//
//   owner    keeps the member list; every change starts a new epoch with a fresh group key K, wrapped for each
//            member's channel X25519 key; the roster (who is in) travels encrypted under K, and slots carry no key
//            fingerprint, so a relay or chain observer learns a count and nothing else
//   members  encrypt under a per-sender key derived from K, with a random 24-byte nonce carried in the message,
//            and sign with their Ed25519 channel key
//
// Nothing here needs saved state to stay SAFE: nonces are random, sequence numbers start from the clock, and a
// member that restarts cannot be rolled back further than `minEpoch` (from snapshot()) or the 30-day freshness bound.
// Security rests on TAPI-26 §3.1 channel records: a roster is the owner's statement of who is in, never proof of keys.
//
// TAPI-27 Tape Group：至多 32 个容器之间的私密群聊。群主维护成员名单，每次变动开启新纪元并为每个成员包裹新的群密钥；
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
const OWN_SEALS_KEPT = 1024                               // nonces of our latest seals kept per epoch (GRP2-3) / 每纪元保留的最近封装 nonce 数

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
  if (Object.prototype.hasOwnProperty.call(opts, 'now')) throw new TapeAPIError('INVALID_ARGUMENT', 'the group option `now` (milliseconds) was renamed in 1.0: pass `clock`, a function returning Unix seconds (https://tapeapi.fun/docs/en/upgrade-1.0)')
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
// A verifier may reject with anything, including undefined (Promise.reject()): never let a falsy reason read as "no error"
// (review GRPR-1). / 核验器可能以任何值拒绝，包括 undefined：假值原因绝不能被当成"没有错误"。
const verifyErr = (e) => e ?? new TapeAPIError('ERROR', 'verifyMember failed without giving a reason')
const errText = (e) => String(verifyErr(e)?.message ?? e)

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

// ---------------------------------------------------------------- format 2 (TAPI-27 §3.8, Experimental) ----
// Format 2 keeps wire types 0x04 / 0x05 and marks itself in the high 32 bits of the uint64 epoch field, which format 1
// requires to be zero (n ≤ 2^32 − 1): every format-1 receiver refuses a format-2 epoch message AND a format-2 group
// message, and a format-2 receiver tells the two apart from the first 25 bytes of either. Every label is its own
// ("TAP-27/…/v2"), so no format-1 message can be taken for a format-2 one or back (TAPI-1 §4.1).
// The roster is binary: container(20) ‖ uint32be(chainId) ‖ ed25519(32) per member, 56 bytes, plus the 48-byte slot:
// 104 bytes a member, against about 277 in format 1. Other members' X25519 keys are left out: only the owner uses them
// (to wrap slots), and a member's own slot opening is the check of its own.
// 格式 2 仍用线路类型 0x04 / 0x05，标记放在 uint64 纪元字段的高 32 位；格式 1 要求这 32 位为零（n ≤ 2^32 − 1），所以
// 任何格式 1 接收方都会拒收格式 2 的纪元消息与群消息，格式 2 接收方看前 25 字节就能分辨两者。所有标签都换成 "TAP-27/…/v2"。
// 名单为二进制：每人 container(20) ‖ uint32be(chainId) ‖ ed25519(32) 共 56 字节，加 48 字节格子，每人 104 字节（格式 1 约 277）。
// 名单不含其他成员的 X25519：只有群主用它（包裹格子），成员自己那格能打开就是对自己密钥的核对。
export const FORMAT_V2_MARK = 0x54470200                 // "TG" 0x02 0x00 in the high half of the epoch field / 纪元字段高半部分
// 128: the largest power of two whose epoch message fits one wire message (16,448 bytes) in the worst case the roster
// allows (4 relays with 512-character URLs and a bus: 2,383 bytes of JSON, which leaves room for 132). With one short
// relay a frame holds 154 (measured 150–160 by two independent designs); 128 keeps the margin 32 kept below 57.
// 128：在名单允许的最坏情况（4 个 512 字符 URL 的中继加 bus，JSON 共 2,383 字节，此时最多 132 人）下，纪元消息仍放得进一条线路消息
// 的最大 2 的幂。只有一个短中继时一帧可放 154 人（两份独立设计实测 150–160）；128 保留了 32 相对 57 的那种余量。
export const MAX_MEMBERS_V2 = 128
// A POSITIVE verdict on a roster entry (its ed25519 equals its channel record) is reused for at most this long, across
// epochs, counted from the start of the check; groups may choose less (verifyReuseS). §3.8 / §8: weakening 1 of format 2.
// 对名单条目的**肯定**核验结论（ed25519 与通道记录一致）最多复用这么久，可跨纪元，从核验开始时起算；群可设得更短。这是格式 2 的削弱之一。
export const VERIFY_REUSE_S = 86_400
// A NEGATIVE verdict (definitively does not match) is kept far shorter: 60 s. Long enough that a sender whose entry is
// wrong costs at most one chain read a minute however many messages it sends (open() refuses it without RPC meanwhile);
// short enough that a record published late, or read from a node that lagged, is seen again within a minute, instead of
// silencing a member for a day (review GRPR-6). A negative verdict is only ever taken from a read past the client's
// identity cache ({ fresh: true }), whose own negative entries live 300 s. An RPC failure is no verdict at all.
// 否定结论（确定不符）只保留 60 秒：足够让条目有误的发送者无论发多少消息、每分钟至多触发一次链上读取（期间 open() 不发请求直接拒收）；
// 又足够短，晚发布的记录、或从落后节点读到的结果一分钟内就会重新核验，不至于让一个成员沉默一整天。否定结论只取自绕过客户端身份缓存
// （{ fresh: true }，其自身的否定缓存为 300 秒）的读取。RPC 故障根本不算结论。
export const VERIFY_NEGATIVE_S = 60
const HEADER_EPOCH_V2 = 1 + 16 + 8 + 32 + 24 + 32 + 2     // 115: count is uint16be / count 为 uint16be
const ENTRY_V2 = 20 + 4 + 32
const ROSTER_MAGIC_V2 = te.encode('TGR2')
const ROSTER_FIXED_V2 = 4 + 8 + 32 + 2 + 2                // magic, issued, prev, count, tail length / 固定部分
const LABELS = {
  1: { epoch: te.encode('TAP-27/epoch/v1'), msg: te.encode('TAP-27/msg/v1'), sender: te.encode('TAP-27/sender/v1') },
  2: { epoch: te.encode('TAP-27/epoch/v2'), msg: te.encode('TAP-27/msg/v2'), sender: te.encode('TAP-27/sender/v2'), wrap: te.encode('TAP-27/wrap/v2'), commit: te.encode('TAP-27/commit/v2') },
}
const ef2 = (n) => concat(u32(FORMAT_V2_MARK), u32(n))
const epochField = (format, n) => (format === 2 ? ef2(n) : u64(n))
// The format an epoch field says: 1 (high half zero), 2 (the mark) or null (anything else) / 纪元字段表明的格式
function readEpochField(b, at) {
  const high = readU32(b, at)
  return { format: high === 0 ? 1 : high === FORMAT_V2_MARK ? 2 : null, epoch: readU32(b, at + 4) }
}
const formatName = (f) => (f === 2 ? 'format 2 (TAPI-27 §3.8, v2)' : 'format 1 (TAPI-27 v1)')
// A frame of the other format (§3.8: one group, one format). GROUP_INVALID, the code every format-1 client already gives
// a format-2 frame, with data.format so an application can say "update" rather than "attack".
// 另一格式的帧（一个群只用一种格式）。错误码 GROUP_INVALID——现有格式 1 客户端遇到格式 2 帧给出的就是它——并附 data.format，
// 让应用能提示"请升级"而不是"遭到攻击"。
const wrongFormat = (what, got, mine) => fail(`${what} is ${got ? formatName(got) : 'of an unknown format (epoch field high half neither 0 nor the format-2 mark)'}; this group is ${formatName(mine)}${got === 2 ? ': the group needs a client that supports format 2' : ''}`, { data: { format: got, groupFormat: mine } })
const kekV2 = (ss, E, R, gid, epoch) => hkdf(sha256, ss, LABELS[2].wrap, concat(E, R, gid, ef2(epoch)), 32)
const commitV2 = (K) => sha256(concat(LABELS[2].commit, K))
/** §3.8: the key a sender encrypts under in a format-2 epoch / 格式 2 纪元里发送者的加密密钥 */
export const senderKeyV2 = (K, gid, epoch, index) => hkdf(sha256, K, concat(gid, ef2(epoch)), concat(LABELS[2].sender, u32(index)), 32)
const senderKeyOf = (format) => (format === 2 ? senderKeyV2 : senderKey)

// §3.8: a format-2 roster entry { container, chainId, ed25519 } (the owner's own list keeps x25519 too)
// 格式 2 名单条目（群主自己的列表另外保留 x25519）
const checkChainIdV2 = (m, name = 'member') => {
  const chainId = m.chainId ?? 56
  if (!Number.isInteger(chainId) || chainId < 1 || chainId > 0xffffffff) fail(`${name}.chainId must be an integer in 1..2^32-1 in format 2`)
  return chainId
}
function normEntryV2(m, name = 'member') {
  if (!m || typeof m.container !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(m.container)) fail(`${name}.container must be an address`)
  const chainId = checkChainIdV2(m, name)
  const ed = hex32(m.ed25519, `${name} ed25519`)
  try { assertEd25519Public(ed, `${name} ed25519`) } catch (e) { fail(e.message) }
  return { container: m.container.toLowerCase(), chainId, ed25519: ed }
}
const tailOf = (relays, bus) => te.encode(canonicalJSON({ relays: relays.map((r) => ({ url: r.url, container: r.container })), ...(bus ? { bus } : {}) }))
function encodeRosterV2({ issued, prev, members, tail }) {
  if (!Number.isSafeInteger(issued) || issued < 0) fail('roster.issued must be unix seconds')
  if (tail.length > 0xffff) fail('relays and bus do not fit a format-2 roster')
  const out = new Uint8Array(ROSTER_FIXED_V2 + ENTRY_V2 * members.length + tail.length)
  const dv = new DataView(out.buffer)
  out.set(ROSTER_MAGIC_V2, 0); dv.setBigUint64(4, BigInt(issued)); out.set(prev, 12); dv.setUint16(44, members.length)
  let o = 46
  for (const m of members) { out.set(fromHex(m.container, 20, 'container'), o); dv.setUint32(o + 20, m.chainId); out.set(fromHex(m.ed25519, 32, 'ed25519'), o + 24); o += ENTRY_V2 }
  dv.setUint16(o, tail.length); out.set(tail, o + 2)
  return out
}
// Strict: exact length, canonical tail, every key a usable Ed25519 point. / 严格解析：长度精确、尾部为规范 JSON、每把密钥都可用。
function decodeRosterV2(b, count) {
  if (b.length < ROSTER_FIXED_V2 + ENTRY_V2 || !equal(b.subarray(0, 4), ROSTER_MAGIC_V2)) fail('not a format-2 roster')
  const dv = new DataView(b.buffer, b.byteOffset, b.length)
  const issuedBig = dv.getBigUint64(4)
  if (issuedBig > BigInt(Number.MAX_SAFE_INTEGER)) fail('roster.issued out of range')
  const n = dv.getUint16(44)
  if (n !== count) fail('roster member count does not match the slots')
  const tailAt = 46 + ENTRY_V2 * n
  if (b.length < tailAt + 2) fail('format-2 roster truncated')
  const L = dv.getUint16(tailAt)
  if (b.length !== tailAt + 2 + L) fail('format-2 roster length does not match its contents')
  const members = []
  for (let i = 0, o = 46; i < n; i++, o += ENTRY_V2) {
    members.push(normEntryV2({ container: '0x' + toHex(b.subarray(o, o + 20)), chainId: dv.getUint32(o + 20), ed25519: '0x' + toHex(b.subarray(o + 24, o + 56)) }, `member ${i}`))
  }
  let tail
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(tailAt + 2))
    tail = safeParseJSON(text, { code: 'GROUP_INVALID' })
    if (!tail || typeof tail !== 'object' || Array.isArray(tail) || canonicalJSON(tail) !== text) throw new Error('not canonical JSON')
  } catch (e) { fail(`format-2 roster relays/bus: ${e.message}`) }
  const keys = Object.keys(tail).sort().join(',')
  if (keys !== 'relays' && keys !== 'bus,relays') fail('format-2 roster tail must be exactly { relays, bus? }')
  // §3.8: every refusal of a format-2 roster is GROUP_INVALID, the relays and bus included (review GRPR-7; format 1 keeps
  // its own codes for these) / 格式 2 名单的每一种拒收都是 GROUP_INVALID，中继与总线也不例外（格式 1 保持原有错误码）
  try { checkRelays(tail.relays); checkBus(tail.bus) } catch (e) { fail(`format-2 roster relays/bus: ${e.message}`) }
  if (tail.relays.some((r) => Object.keys(r).sort().join(',') !== 'container,url')) fail('each relay is exactly { url, container }')
  return { issued: Number(issuedBig), prev: toHex(b.subarray(12, 44)), members, relays: tail.relays, ...(tail.bus !== undefined ? { bus: tail.bus } : {}) }
}

/**
 * §3.8: build a format-2 epoch message. `members` are full entries (the owner's list: x25519 wraps each slot; only
 * container, chainId and ed25519 enter the roster). Random draws, in order: K, e, N (as in format 1).
 * 构造格式 2 纪元消息。`members` 为完整条目（群主的列表：用 x25519 包裹各格；进入名单的只有 container、chainId、ed25519）。
 * 随机数按 K、e、N 的顺序抽取（与格式 1 相同）。
 */
export function buildEpochV2({ gid, epoch, issued, prev, owner, members, relays = [], bus, ownerEdSecret, random = randomBytes }) {
  if (!Array.isArray(members) || members.length < 1 || members.length > MAX_MEMBERS_V2) fail(`a format-2 group has 1..${MAX_MEMBERS_V2} members`)
  if (!Number.isInteger(epoch) || epoch < 0 || epoch > MAX_EPOCH) fail(`epoch must be an integer in 0..${MAX_EPOCH}`)
  const list = members.map(normMember)             // checks both keys already / 已核对两把公钥
  for (const m of list) checkChainIdV2(m)
  if (!sameContainer(list[0], owner)) fail('members[0] must be the owner')
  checkUnique(list)
  checkRelays(relays); checkBus(bus)
  const prevBytes = typeof prev === 'string' ? fromHex(prev, 32, 'prev') : prev
  const tail = tailOf(relays, bus)
  const rosterBytes = encodeRosterV2({ issued, prev: prevBytes, members: list, tail })
  const K = random(32)
  const e = random(32)
  const E = x25519.getPublicKey(e)
  const N = random(24)
  const header = concat(Uint8Array.of(WIRE_EPOCH), gid, ef2(epoch), E, N, commitV2(K), Uint8Array.of(list.length >> 8, list.length & 0xff))
  const slots = concat(...list.map((m) => {
    const R = fromHex(m.x25519, 32, 'x25519')
    const ss = dh(e, R)
    const kek = kekV2(ss, E, R, gid, epoch)
    ss.fill(0)
    return xchacha20poly1305(kek, N, header).encrypt(K)
  }))
  e.fill(0)
  const ct = xchacha20poly1305(K, N, concat(header, slots)).encrypt(rosterBytes)
  const body = concat(header, slots, u32(ct.length), ct)
  const wire = concat(body, ed25519.sign(concat(LABELS[2].epoch, body), ownerEdSecret))
  if (wire.length > MAX_WIRE) fail(`epoch message of ${wire.length} bytes is too large for one wire message`)
  const roster = {
    format: 2, gid: toHex(gid), epoch, issued, prev: toHex(prevBytes),
    owner: { container: owner.container.toLowerCase(), chainId: owner.chainId ?? 56 },
    members: list, relays: relays.map((r) => ({ url: r.url, container: r.container })), ...(bus ? { bus } : {}),
  }
  return { wire, K, roster, rosterBytes }
}

function parseEpochV2(wire) {
  if (!(wire instanceof Uint8Array) || wire.length < HEADER_EPOCH_V2 + SLOT + 4 + 16 + SIG || wire[0] !== WIRE_EPOCH) fail('not an epoch message')
  if (wire.length > MAX_WIRE) fail('epoch message too large')
  const f = readEpochField(wire, 17)
  if (f.format !== 2) wrongFormat('this epoch message', f.format, 2)
  const count = (wire[HEADER_EPOCH_V2 - 2] << 8) | wire[HEADER_EPOCH_V2 - 1]
  if (count < 1 || count > MAX_MEMBERS_V2) fail('bad member count')
  const slotsEnd = HEADER_EPOCH_V2 + SLOT * count
  if (wire.length < slotsEnd + 4 + 16 + SIG) fail('epoch message truncated')
  const ctLen = readU32(wire, slotsEnd)
  if (wire.length !== slotsEnd + 4 + ctLen + SIG) fail('epoch message length does not match its roster')
  return {
    gid: wire.slice(1, 17), epoch: f.epoch, E: wire.slice(25, 57), N: wire.slice(57, 81), commit: wire.slice(81, 113), count,
    header: wire.slice(0, HEADER_EPOCH_V2), slots: wire.slice(HEADER_EPOCH_V2, slotsEnd), ct: wire.slice(slotsEnd + 4, slotsEnd + 4 + ctLen),
    body: wire.slice(0, wire.length - SIG), sig: wire.slice(wire.length - SIG),
  }
}

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
// §3.3 step 6 checks run this many at a time (1.1.x). Each check is about six quorum rounds (token, accountOf, isCPU,
// fileInfo + read, ownerOf) over three nodes, some 18 HTTP requests and ~1.7 s on BSC, one round after the other; the
// reference ran the members one after the other too, so a 32-member epoch took about a minute to accept. 8 at a time
// takes 32 members in 4 waves (~7 s) while a client sends at most 8 × 3 = 24 requests at once, 8 per node: within
// a browser's 6-per-host HTTP/1.1 pool plus the rpc layer's batching, and far below the public nodes' 10,000
// requests per 5 minutes per IP. More buys little (the waves are already few) and bursts harder against those limits.
// §3.3 第 6 步的核验同时进行几个。每次核验约 6 轮法定数读取、3 个节点，约 18 个 HTTP 请求、BSC 上约 1.7 秒，逐轮进行；
// 参考实现原先还逐个成员串行，32 人的纪元要约一分钟才能接受。并发 8：32 人分 4 批（约 7 秒），客户端同时至多 8 × 3 = 24 个请求、
// 每节点 8 个，配合 rpc 层的批量请求在浏览器每主机连接池之内，也远低于公共节点每 IP 每 5 分钟 1 万次的限额。再高收益很小、突发更猛。
export const VERIFY_CONCURRENCY = 8
const MAX_VERIFY_CONCURRENCY = 64
const checkConcurrency = (n, name = 'verifyConcurrency') => {
  if (n === undefined) return undefined
  if (!Number.isInteger(n) || n < 1 || n > MAX_VERIFY_CONCURRENCY) throw new TapeAPIError('INVALID_ARGUMENT', `${name} must be an integer in 1..${MAX_VERIFY_CONCURRENCY}`)
  return n
}

// `format` (§3.8, Experimental): 1 (default, TAPI-27 v1) or 2. / 群格式：1（默认）或 2（实验性）。
const checkFormat = (f, name = 'format') => {
  if (f === undefined) return undefined
  if (f !== 1 && f !== 2) throw new TapeAPIError('INVALID_ARGUMENT', `${name} must be 1 or 2 (TAPI-27 §3.8)`)
  return f
}
const checkReuse = (s) => {
  if (s === undefined) return VERIFY_REUSE_S
  if (!Number.isInteger(s) || s < 0 || s > VERIFY_REUSE_S) throw new TapeAPIError('INVALID_ARGUMENT', `verifyReuseS must be an integer in 0..${VERIFY_REUSE_S} (TAPI-27 §3.8: at most 24 hours)`)
  return s
}

/**
 * Check each member; returns the ones whose records definitively no longer match. `fresh` is passed on as
 * verifyMember(m, { fresh }): api.groupVerifier() then reads past its cache (arch B7).
 * Up to `concurrency` checks run at once, with the outcome of the serial loop it replaced: the error thrown is the one
 * of the FIRST member in roster order that fails (an RPC failure, or a mismatch unless `drop`), no member after it
 * starts a check once that failure is known, and the dropped list is in roster order.
 * 返回记录已确定不符的成员。`fresh` 以 verifyMember(m, { fresh }) 传入：api.groupVerifier() 随即绕过缓存读取。
 * 至多 `concurrency` 个核验同时进行，结果与原先的串行循环一致：抛出的错误是按名单顺序**第一个**失败成员的（RPC 故障，或非 drop 时的
 * 不符）；一旦得知该失败，排在它之后的成员不再开始核验；移除名单按名单顺序。
 */
async function verifyAll(members, verifyMember, { drop = false, fresh = false, concurrency = VERIFY_CONCURRENCY } = {}) {
  if (verifyMember === 'trust-roster') return []        // tests and vectors only / 仅用于测试与向量
  if (typeof verifyMember !== 'function') fail('verifyMember is required: check every member against its TAPI-26 channel record (api.groupVerifier())')
  const outcome = new Array(members.length)            // { ok } | { error } per member, filled as checks end / 每个成员的结果
  let stopAt = members.length                          // lowest index known to fail: nothing at or after it starts / 已知最早失败的位置
  let nextIndex = 0
  async function worker() {
    while (nextIndex < stopAt) {
      const i = nextIndex++
      const m = members[i]
      try {
        const ok = await verifyMember(m, { fresh })
        outcome[i] = { ok: ok === true }
        if (ok !== true && !drop && i < stopAt) stopAt = i
      } catch (e) {
        outcome[i] = { error: verifyErr(e) }             // a transient failure never drops anyone / 暂时性故障绝不移除任何人
        if (i < stopAt) stopAt = i
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, members.length) }, worker))
  const bad = []
  for (let i = 0; i < members.length; i++) {
    const o = outcome[i], m = members[i]
    if (o === undefined) break                           // never started: an earlier member failed / 未开始：前面已有失败
    if ('error' in o) fail(`member ${m.container}: ${errText(o.error)}`)   // 'error' in o: a falsy reason is an error too (GRPR-1)
    if (!o.ok) { if (drop) bad.push(m); else fail(`member ${m.container}: keys do not match its channel record`) }
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
  if (readU32(wire, 17) === FORMAT_V2_MARK) wrongFormat('this epoch message', 2, 1)   // §3.8: the other format, named / 另一格式，点名说明
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

function makeGroup({ gid, self, id, ownerRef, ownerEd, isOwner, minEpoch = null, lastSeq = null, random = randomBytes, now = () => Date.now(), concurrency = VERIFY_CONCURRENCY, format = 1, reuseS = VERIFY_REUSE_S, verifier = null }) {
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
  // GRP2-3: messages signed with our own key that this handle did not seal come from another device holding the same
  // identity (§8: one identity is one device). A restarted handle that was given lastSeq takes its own index's seqs up to
  // it for its own earlier messages. / 用本身份签名、却不是本句柄封装的消息来自持有同一身份的另一台设备；带 lastSeq 重启的句柄
  // 把自己序号不超过它的消息视为重启前自己发的。
  const restoredSeq = lastSeq
  let otherDevice = null             // { count, epoch, seq } once seen / 一旦发现即记录
  const room = groupRoom(gid)
  const clock = { now }

  // `keyless`: an epoch stood up from snapshot() by resumeGroup, only so the next one chains to it; it has no key, and
  // open() says so instead of failing authentication (GRP2-4). / 由 resumeGroup 从快照立起、只为接续的纪元：没有密钥，open() 如实说明
  function install(epoch, roster, rosterBytes, K, { keyless = false } = {}) {
    if (current !== null && epoch <= current) fail(`epoch ${epoch} is not newer than ${current}`)   // never backwards / 绝不后退
    const index = roster.members.findIndex((m) => sameContainer(m, self))
    const prevEpoch = current
    epochs.set(epoch, { roster, rosterBytes, K, index, members: roster.members, high: new Map(), keys: new Map(), expiresAt: Infinity, removed: new Set(), movedOn: new Set(), keyless, own: null })
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
    if (!st.keys.has(index)) st.keys.set(index, senderKeyOf(format)(st.K, gid, epoch, index))
    return st.keys.get(index)
  }

  // ---- format 2: lazy §3.3 step 6 (§3.8) / 格式 2：惰性核验 ----
  // A verdict per roster entry (chainId, container, ed25519): { ok, at }, reused across epochs, so only an entry that
  // changed (or whose verdict aged out) is checked again. A positive verdict lives `reuseS` (at most 24 h), a negative
  // one at most VERIFY_NEGATIVE_S (60 s; GRPR-6). `at` is when the check STARTED, so a verdict never outlives the read it
  // rests on by more than the window (review: the window ran from the end of a check that could take long).
  // 每个名单条目一个结论，跨纪元复用。肯定结论保留 reuseS（至多 24 小时），否定结论至多 60 秒。`at` 取核验**开始**的时刻，
  // 结论存活时间从所依据的那次读取起算，而不是从一次可能很慢的核验结束时起算。
  const verdicts = new Map()
  const checking = new Map()          // entry key -> the check under way, shared / 进行中的核验，共享
  // The owner's handle knows each entry's x25519 and checks both keys, so its verdicts cover both (a member that changed
  // only its x25519 is a new entry there, GRP2-1); a member's handle sees no x25519 and keys by ed25519 alone.
  // 群主句柄知道每个条目的 x25519 且核验两把公钥，所以其结论覆盖两者（只换了 x25519 的成员在那里是新条目）；成员句柄看不到 x25519，只按 ed25519。
  const entryKey = (m) => `${m.chainId}:${m.container}:${m.ed25519}${m.x25519 !== undefined ? ':' + m.x25519 : ''}`
  const verdictOf = (m) => {
    const v = verdicts.get(entryKey(m))
    if (!v) return null
    const ttlS = v.ok ? reuseS : Math.min(reuseS, VERIFY_NEGATIVE_S)
    if (clock.now() >= v.at + ttlS * 1000) { verdicts.delete(entryKey(m)); return null }
    return v
  }
  // an older check that ends late never overwrites a newer verdict / 晚结束的旧核验不覆盖更新的结论
  const setVerdict = (k, ok, at) => { const old = verdicts.get(k); if (!old || old.at <= at) verdicts.set(k, { ok, at }) }
  const trustAll = (members, at = clock.now()) => { for (const m of members) setVerdict(entryKey(m), true, at) }
  const pickVerifier = (v) => {
    const f = v ?? verifier
    if (f !== 'trust-roster' && typeof f !== 'function') fail('verifyMember is required: check every member against its TAPI-26 channel record (group.channelKeysVerifier(api) or api.groupVerifier())')
    return f
  }
  // One limit for every lazy check of this handle (review GRPR-3): openVerified on many arriving messages, verifyMembers
  // and acceptEpoch's owner check all go through this gate, at most `concurrency` (verifyConcurrency) at once.
  // 本句柄所有惰性核验共用一个上限：大量到达消息上的 openVerified、verifyMembers 与 acceptEpoch 的群主核验都经过它，至多 concurrency 个同时进行。
  let active = 0
  const waiting = []
  const gate = async (fn) => {
    if (active >= concurrency) await new Promise((ok) => waiting.push(ok))   // a slot is handed over, not re-counted / 名额直接移交
    else active++
    try { return await fn() } finally { const next = waiting.shift(); if (next) next(); else active-- }
  }
  // One check of one entry: true, false (definitive mismatch) or a throw (no answer; no verdict kept). A "no" is asked
  // again past the client's identity cache ({ fresh: true }) before it becomes a verdict: that cache keeps a NOT_FOUND
  // for 300 s, and a node that lagged must not silence a member (GRPR-6). The entry carries x25519 when this handle
  // knows it (the owner's own list), so a verifier comparing both keys works on the owner's handle.
  // 核验一个条目：true、false（确定不符）或抛出（无回答，不留结论）。"否"在成为结论之前会绕过客户端身份缓存再问一次：那份缓存会把
  // NOT_FOUND 保留 300 秒，落后的节点不能让一个成员噤声。句柄知道 x25519 时（群主自己的列表）一并传入，比较两把密钥的核验器在群主句柄上也能用。
  function checkEntry(m, verifyMember) {
    const k = entryKey(m)
    if (verifyMember === 'trust-roster') { setVerdict(k, true, clock.now()); return Promise.resolve(true) }
    const pending = checking.get(k)
    if (pending) return pending
    const ask = () => ({ container: m.container, chainId: m.chainId, ed25519: m.ed25519, ...(m.x25519 !== undefined ? { x25519: m.x25519 } : {}) })
    // Registered before the verifier runs, and removed only by itself: a verifier that throws synchronously can no
    // longer leave a rejected check cached for ever (review GRPR-2).
    // 先登记、后调用核验器，且只由它自己移除：同步抛错的核验器再也不会让一个被拒绝的核验永久留在缓存里。
    const p = Promise.resolve().then(() => gate(async () => {
      const at = clock.now()
      let ok = (await verifyMember(ask(), { fresh: false })) === true
      if (!ok) ok = (await verifyMember(ask(), { fresh: true })) === true
      setVerdict(k, ok, at)
      return ok
    })).finally(() => { if (checking.get(k) === p) checking.delete(k) })
    checking.set(k, p)
    return p
  }
  const mismatch = (i, m) => fail(`member ${i} (${m.container}): its keys do not match its channel record; its messages are refused`, { data: { mismatch: true, container: m.container, chainId: m.chainId } })

  async function acceptOneV2(wire, verifyMember) {
    const p = parseEpochV2(wire)
    if (!equal(p.gid, gid)) fail('epoch message for another group')
    if (!edVerify(p.sig, concat(LABELS[2].epoch, p.body), ownerEd)) fail('epoch message is not signed by the owner')
    const bodyHash = toHex(sha256(p.body))
    if (accepted.has(p.epoch)) {
      if (accepted.get(p.epoch) === bodyHash) return { epoch: p.epoch, roster: epochs.get(p.epoch)?.roster ?? null, duplicate: true }
      throw new TapeAPIError('GROUP_EQUIVOCATION', `the owner signed two different messages for epoch ${p.epoch}`, { data: { epoch: p.epoch, hashes: [accepted.get(p.epoch), bodyHash] } })
    }
    if (current !== null && p.epoch <= current) fail(`epoch ${p.epoch} is not newer than ${current}`)
    if (floor !== null && p.epoch < floor) fail(`epoch ${p.epoch} is below ${floor}, the lowest this member may accept (a rollback)`)
    const vm = pickVerifier(verifyMember)
    // a verifier given here (the format-1 habit) also serves the lazy checks later / 此处给的核验器（格式 1 的习惯）也用于之后的惰性核验
    if (typeof vm === 'function' && verifier === null) verifier = vm
    const ss = dh(id.xSecret, p.E)
    const kek = kekV2(ss, p.E, id.xPub, gid, p.epoch)
    ss.fill(0)
    let K = null, myIndex = -1
    for (let i = 0; i < p.count; i++) {
      let k
      try { k = xchacha20poly1305(kek, p.N, p.header).decrypt(p.slots.slice(i * SLOT, (i + 1) * SLOT)) } catch { continue }
      if (K) fail('two slots open with our key: the roster lists our key twice')
      K = k; myIndex = i
    }
    if (!K) fail('no slot in this epoch opens with our key: we are not a member of it')
    if (!equal(commitV2(K), p.commit)) fail('the group key does not match the commitment the owner signed')
    let rosterBytes
    try { rosterBytes = xchacha20poly1305(K, p.N, concat(p.header, p.slots)).decrypt(p.ct) } catch { fail('roster does not decrypt') }
    const r = decodeRosterV2(rosterBytes, p.count)
    const t = nowS(clock)
    if (r.issued > t + FUTURE_SKEW_S) fail('roster issued in the future')
    if (r.issued < t - MAX_EPOCH_AGE_S) fail('roster older than 30 days: the owner must start a new epoch (a stale or replayed message)')
    const members = r.members
    const seen = new Set()
    for (const m of members) for (const k of [`c:${m.chainId}:${m.container}`, `e:${m.ed25519}`]) { if (seen.has(k)) fail(`the roster lists ${m.container} twice, or two members share a key`); seen.add(k) }
    if (!sameContainer(members[0], ownerRef)) fail('members[0] must be the owner')
    if (!equal(fromHex(members[0].ed25519, 32), ownerEd)) fail('the owner entry carries another Ed25519 key')
    const me = members[myIndex]
    if (!sameContainer(me, self) || !equal(fromHex(me.ed25519, 32), id.edPub)) fail('our slot names another container or other keys')
    const held = current === null ? null : epochs.get(current)
    if (held && current === p.epoch - 1 && r.prev !== toHex(sha256(held.rosterBytes))) fail('roster.prev does not chain to the roster we hold')
    // step 6, lazily: the owner's entry now (unless a verdict is reusable); every other entry before its first message
    // is shown as authentic (open() -> verified: false until then; openVerified / verifyMembers check it)
    // 惰性第 6 步：群主条目现在核验（除非有可复用的结论）；其余条目在其消息被当作真实展示之前核验
    if (vm === 'trust-roster') trustAll(members)
    else {
      // only a POSITIVE verdict is reused here; a "no" is asked again, as format 1 asks every time (GRPR-6)
      // 这里只复用**肯定**结论；"否"会重新询问，与格式 1 每次都问一致
      if (verdictOf(members[0])?.ok !== true) {
        let ok
        try { ok = await checkEntry(members[0], vm) } catch (e) { fail(`member ${members[0].container}: ${errText(e)}`) }
        if (!ok) fail(`member ${members[0].container}: keys do not match its channel record`)
      }
    }
    const roster = { format: 2, gid: toHex(gid), epoch: p.epoch, issued: r.issued, prev: r.prev, owner: { container: members[0].container, chainId: members[0].chainId }, members, relays: r.relays, ...(r.bus !== undefined ? { bus: r.bus } : {}) }
    install(p.epoch, roster, rosterBytes, K)
    accepted.set(p.epoch, bodyHash)
    for (const n of accepted.keys()) if (n < p.epoch - 64) accepted.delete(n)
    return { epoch: p.epoch, roster, unverified: members.filter((m) => !verdictOf(m)?.ok).length }
  }

  async function acceptOne(wire, verifyMember) {
    if (format === 2) return acceptOneV2(wire, verifyMember)
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
    await verifyAll(members, verifyMember, { concurrency })
    install(p.epoch, { ...roster, members }, rosterBytes, K)
    accepted.set(p.epoch, bodyHash)
    for (const n of accepted.keys()) if (n < p.epoch - 64) accepted.delete(n)   // enough to recognise a fork of a recent epoch / 足以识别近期纪元的分叉
    return { epoch: p.epoch, roster: epochs.get(p.epoch).roster }
  }

  // GRP2-3: what this handle sealed in an epoch: its seqs there are consecutive, so a range, plus the nonce of each of the
  // last OWN_SEALS_KEPT, which tells our echo from another device's message with the same seq; older seqs in the range
  // count as ours. / 本句柄在某纪元封装过的消息：序号连续，记一个区间，并记下最近若干条的 nonce，用以区分回声与另一设备的同号消息。
  function rememberSealed(st, seq, nonce) {
    const o = st.own ??= { lo: seq, hi: seq, nonces: new Map(), forgotUpTo: null }
    o.hi = seq
    o.nonces.set(seq, toHex(nonce))
    if (o.nonces.size > OWN_SEALS_KEPT) { const oldest = o.nonces.keys().next().value; o.nonces.delete(oldest); o.forgotUpTo = oldest }
  }
  function isOwnEcho(st, seq, nonce) {
    if (restoredSeq !== null && seq <= restoredSeq) return true      // sealed before our restart / 重启之前封装的
    const o = st.own
    if (!o || seq < o.lo || seq > o.hi) return false
    const n = o.nonces.get(seq)
    if (n !== undefined) return n === toHex(nonce)
    return o.forgotUpTo !== null && seq <= o.forgotUpTo
  }
  // GRP2-5: why there is no key, in data.reason: 'not-yet' (a later epoch than ours: accept its epoch message, then open
  // again; data.retryAfterEpoch), or 'expired' (an earlier one, gone or from before we joined).
  // 没有密钥的原因：'not-yet'（比本方新的纪元：接受其纪元消息后再打开；data.retryAfterEpoch）或 'expired'（更早的纪元，已丢弃或在加入之前）
  function noKey(epoch) {
    if (current === null || epoch > current) {
      fail(`no key for epoch ${epoch} (not joined yet, or its epoch message has not been accepted yet: accept it, then open this message again; if that epoch message is refused, this member is not in it)`,
        { data: { epoch, current, reason: 'not-yet', retryAfterEpoch: epoch } })
    }
    fail(`no key for epoch ${epoch} (the epoch expired, or is from before this member joined)`, { data: { epoch, current, reason: 'expired' } })
  }

  // format 2: each member with its verification state (§3.8): verified, or mismatch: true once definitively refused
  // 格式 2：每个成员附核验状态
  const withState = (m) => {
    if (format !== 2) return { ...m }
    const v = verdictOf(m)
    return { ...m, verified: v?.ok === true, ...(v && !v.ok ? { mismatch: true } : {}) }
  }
  const group = {
    gid: toHex(gid), room, isOwner,
    /** 1 or 2 (§3.8, Experimental). / 群格式：1 或 2（实验性）。 */
    format,
    get epoch() { return current },
    get roster() { return current === null ? null : epochs.get(current).roster },
    get members() { return current === null ? [] : epochs.get(current).members.map(withState) },
    _clock: clock,
    _install: install,
    _concurrency: concurrency,
    _trustAll: trustAll,
    // GRP2-1: the owner reuses a positive verdict that is still within reuseS / 群主复用仍在 reuseS 之内的肯定结论
    _reusable: (m) => verdictOf(m)?.ok === true,
    _held: () => (current === null ? null : epochs.get(current)),

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
      if (format === 2) {
        // the owner keeps its full list (x25519 included: it wraps the next epoch's slots) and the roster bytes as sent,
        // which the next epoch's prev hashes / 群主保存完整列表（含 x25519，下一纪元包裹格子要用）与原样的名单字节（下一纪元 prev 的哈希对象）
        // v: 2 (GRP2-2): TapeAPI 1.0.0 to 1.2.0 accept only v: 1 in resumeGroup, and 1.0.0 / 1.1.0 would read a format-2
        // snapshot as format 1 and split the group; with v: 2 every one of them refuses it. v: 1 with format: 2 (from
        // 1.2.0) is still read. / 1.0.0 至 1.2.0 的 resumeGroup 只接受 v: 1，而 1.0.0 / 1.1.0 会把格式 2 快照当作格式 1、使群分裂；
        // 改为 v: 2 后它们都会拒收。1.2.0 发出的 v: 1 + format: 2 仍可读取。
        return {
          v: 2, format: 2, gid: toHex(gid), owner: { container: String(ownerRef.container).toLowerCase(), chainId: ownerRef.chainId ?? 56 },
          epoch: current ?? floor, role: isOwner ? 'owner' : 'member',
          ...(sealed ? { lastSeq: (mySeq - 1n).toString() } : {}),
          ...(isOwner && st ? { roster: canonicalJSON({ gid: toHex(gid), epoch: current, members: st.members.map((m) => ({ ...m })), relays: st.roster.relays, ...(st.roster.bus ? { bus: st.roster.bus } : {}) }), rosterBin: toHex(st.rosterBytes) } : {}),
        }
      }
      return {
        v: 1, gid: toHex(gid), owner: { container: String(ownerRef.container).toLowerCase(), chainId: ownerRef.chainId ?? 56 },
        epoch: current ?? floor, role: isOwner ? 'owner' : 'member',
        ...(sealed ? { lastSeq: (mySeq - 1n).toString() } : {}),
        ...(isOwner && st ? { roster: new TextDecoder().decode(st.rosterBytes) } : {}),
      }
    },

    /**
     * §3.3: check an epoch message and move to its epoch. `verifyMember(member)` must resolve true for every member
     * (api.groupVerifier() checks each against its TAPI-26 channel record). Calls are serialised.
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
      rememberSealed(st, seq, nonce)
      const header = concat(Uint8Array.of(WIRE_MESSAGE), gid, epochField(format, current), u32(st.index), u64(seq), nonce)
      const ct = xchacha20poly1305(keyOf(st, current, st.index), nonce, header).encrypt(pt)
      return concat(header, ct, ed25519.sign(concat(LABELS[format].msg, header, ct), id.edSecret))
    },

    /**
     * @experimental (GRP2-3) null, or { count, epoch, seq } once open() has seen a message signed with this identity that
     * this handle did not seal: the same identity is in use on another device (§8: one identity is one device), and
     * receivers refuse the messages of whichever device has the lower seq. / 发现本身份在别处发言后为 { count, epoch, seq }。
     */
    get otherDevice() { return otherDevice === null ? null : { ...otherDevice } },

    /**
     * §3.4: verify and decrypt. Returns { from, index, epoch, seq, gap, data } (`data` is text with { text: true }),
     * or { own: true } for our own message coming back. `gap` is null when the sender restarted in between.
     * A message signed with our own key that this handle did not seal is returned in full with `otherDevice: true`
     * (@experimental, GRP2-3). / 验证并解密。自己发出的消息返回 { own: true }。发送者中途重启时 `gap` 为 null。
     * 用本身份签名、但不是本句柄封装的消息完整返回，并带 `otherDevice: true`。
     */
    open(wire, { text = false } = {}) {
      if (!(wire instanceof Uint8Array) || wire.length < HEADER_MSG + 16 + SIG || wire[0] !== WIRE_MESSAGE) fail('not a group message')
      if (wire.length > MAX_WIRE) fail('group message too large')
      if (!equal(wire.slice(1, 17), gid)) fail('message for another group')
      const ef = readEpochField(wire, 17)
      if (ef.format !== format) {
        // format 1 keeps its own words for a field above 2^32 - 1; a format-2 message is named as such (§3.8)
        // 格式 1 对超过 2^32 - 1 的字段保留原措辞；格式 2 消息则点名说明
        if (format === 1 && ef.format === 2) fail('epoch out of range: a format-2 group message (TAPI-27 §3.8), and this group is format 1', { data: { format: 2, groupFormat: 1 } })
        if (format === 1) fail('epoch out of range')
        wrongFormat('this group message', ef.format, format)
      }
      const epoch = ef.epoch
      const index = readU32(wire, 25)
      const seq = readU64(wire, 29)
      const st = live(epoch)
      if (!st) noKey(epoch)
      if (index >= st.members.length) fail('sender index outside the roster')
      const header = wire.slice(0, HEADER_MSG), ct = wire.slice(HEADER_MSG, wire.length - SIG), sig = wire.slice(wire.length - SIG)
      // verify first, even our own: a relay must not make us swallow a message by relabelling it (audit G-17)
      // 先验签，哪怕是自己的：中继不能靠改署名让我们吞掉一条消息
      if (!edVerify(sig, concat(LABELS[format].msg, header, ct), fromHex(st.members[index].ed25519, 32))) fail(`message is not signed by member ${index}`)
      const nonce = wire.slice(37, 61)
      const fromOtherDevice = index === st.index && !isOwnEcho(st, seq, nonce)
      if (index === st.index && !fromOtherDevice) return { own: true, epoch, seq }
      // GRP2-4: authentic, under an epoch this handle only knows from snapshot(): no key, and not a forgery
      // 真实的消息，但所在纪元本句柄只从快照得知：没有密钥，而不是伪造
      if (st.keyless) fail(`no key for epoch ${epoch} (not in this handle's snapshot: the owner restarted with resumeGroup(), and snapshot() keeps no keys)`, { data: { epoch, current, reason: 'snapshot' } })
      // format 2: a sender whose entry definitively does not match its channel record is outside the roster (§3.8)
      // 格式 2：条目与通道记录确定不符的发送者视同不在名单中
      const v = format === 2 && !fromOtherDevice ? verdictOf(st.members[index]) : null
      if (v && !v.ok) mismatch(index, st.members[index])
      if (epoch !== current) {
        if (st.removed.has(index)) fail(`member ${index} was removed after epoch ${epoch}: its messages under it are refused`)
        if (st.movedOn.has(index)) fail(`member ${index} already speaks in epoch ${current}: its epoch-${epoch} messages are refused`)
      }
      const high = st.high.get(index)
      // data (GRP2-3): besides a replay or a reordering, two devices sending with one identity look exactly like this
      // data：除了重放或乱序，同一身份在两台设备上发送看起来也正是这样
      if (high !== undefined && seq <= high) fail(`seq ${seq} from member ${index} already seen (replayed or reordered)`, { data: { index, epoch, seq: seq.toString(), high: high.toString(), mayBeOtherDevice: true, hint: 'a replay, a reordering, or the same identity sending from two devices (TAPI-27 §8: one identity is one device)' } })
      let pt
      try { pt = xchacha20poly1305(keyOf(st, epoch, index), nonce, header).decrypt(ct) } catch { fail('message fails authentication') }
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
      const out = { from: st.members[index].container, index, epoch, seq, gap, data: text ? decoded : pt }
      // format 2: `verified` says whether `from` has been checked against its channel record (§3.8); until it is, an
      // application MUST show the sender as unverified (openVerified checks first). Our own entry was checked when we
      // accepted the epoch (our slot names our keys). / 格式 2：`verified` 表示 `from` 是否已对照通道记录核验；自己的条目在接受纪元时已核对
      if (format === 2) out.verified = fromOtherDevice || v?.ok === true
      if (fromOtherDevice) {
        out.otherDevice = true
        otherDevice = { count: (otherDevice?.count ?? 0) + 1, epoch, seq: seq.toString() }
      }
      return out
    },
  }
  if (format === 2) {
    Object.assign(group, {
      /**
       * @experimental §3.8: open(), then check the sender against its channel record if no reusable verdict covers
       * it. Resolves { ...open(), verified: true }; refuses (GROUP_INVALID, data.mismatch) a sender whose record
       * definitively does not match; on an RPC failure resolves verified: false with verifyError, to show as unverified
       * and check again later. / open() 之后若无可复用的结论就核验发送者。确定不符则拒绝；RPC 故障时返回 verified: false 与 verifyError。
       */
      async openVerified(wire, { text = false, verifyMember } = {}) {
        const r = group.open(wire, { text })
        if (r.own || r.verified) return r
        const st = live(r.epoch)
        const m = st.members[r.index]
        const vm = pickVerifier(verifyMember)
        let ok
        try { ok = await checkEntry(m, vm) } catch (e0) {
          const e = verifyErr(e0)
          return { ...r, verified: false, verifyError: { code: e?.code ?? 'ERROR', message: errText(e) } }
        }
        if (!ok) mismatch(r.index, m)
        return { ...r, verified: true }
      },
      /**
       * @experimental §3.8: check the current roster's entries that have no reusable verdict (a background scan with
       * `concurrency` workers; every check of the handle, openVerified's included, shares its verifyConcurrency limit).
       * -> { verified, mismatch, failed: [{ container, error }] } (containers, each list in roster order).
       * 核验当前名单中没有可复用结论的条目（后台扫描，`concurrency` 个 worker；句柄的所有核验，含 openVerified，共用 verifyConcurrency 上限）。
       * 各列表按名单顺序。
       */
      async verifyMembers({ verifyMember, concurrency: c = concurrency } = {}) {
        checkConcurrency(c, 'concurrency')
        if (current === null) fail('no epoch yet')
        const vm = pickVerifier(verifyMember)
        const todo = epochs.get(current).members.filter((m) => !verdictOf(m))
        const results = new Array(todo.length)
        let next = 0
        const worker = async () => {
          while (next < todo.length) {
            const i = next++
            try { results[i] = { ok: await checkEntry(todo[i], vm) } } catch (e) { results[i] = { error: verifyErr(e) } }
          }
        }
        // `c` workers for this scan; every check still passes the handle's one gate (GRPR-3) / 本次扫描 c 个 worker，仍经过句柄唯一的闸门
        await Promise.all(Array.from({ length: Math.min(c, todo.length) }, worker))
        // in roster order, whatever order the checks ended in / 按名单顺序，不论核验结束先后
        const out = { verified: [], mismatch: [], failed: [] }
        todo.forEach((m, i) => {
          const x = results[i]
          if ('error' in x) out.failed.push({ container: m.container, error: { code: x.error?.code ?? 'ERROR', message: errText(x.error) } })
          else (x.ok ? out.verified : out.mismatch).push(m.container)
        })
        return out
      },
    })
  }
  return { group, install }
}

function ownerApi({ group, install, gid, owner, id, verifyMember, random, transports, startList }) {
  let list = startList
  let lastWire = null                // the latest epoch message this owner built, for reposts (§3.5) / 最近一条纪元消息，供重发
  // `added`: the members this epoch brings in, who still need an invite in their OWN inbox room (§3.5). The epoch
  // message alone reaches nobody new: it goes to the group room, which a new member does not know yet.
  // `added`：本纪元新加入、仍需在各自收件房间收到邀请的成员。纪元消息只发到群房间，新成员还不知道这个房间。
  const next = async (newList, { verify = verifyMember, added = [], checked = [], trustedAt } = {}) => {
    // Re-check EVERY member, not only additions: a circuit that changed hands drops out here, instead of freezing
    // the group for everyone else (audit G-15). A transient failure aborts; a definitive mismatch drops.
    // 重新核验**全部**成员，而不只是新加入者：转手的电路在此退出，而不是让整个群卡住。暂时故障则中止，确定不符则移除。
    // Read past the identity cache (arch B7): a record cached a minute before the sale would keep the sold member for
    // a whole epoch, not a few minutes. The owner decides when this runs; no outsider can make it read.
    // 绕过身份缓存：出售前一分钟缓存的记录会让已出售的成员再留一整个纪元，而不是几分钟。何时执行由群主决定，外人无法触发读取。
    // Format 2 (§3.8, GRP2-1): an entry with a positive verdict still within verifyReuseS, or one checked a moment ago by
    // addMembers, is not read again; every other entry (new, changed, aged out, or with no verdict) is, freshly. Format 1
    // checks every member, as always. / 格式 2：仍在 verifyReuseS 之内有肯定结论的条目、或 addMembers 刚核验过的条目不再读取；
    // 其余条目（新的、变化的、过期的、没有结论的）都重新读取。格式 1 照旧核验全部成员。
    const v2 = group.format === 2 && typeof verify === 'function'
    const todo = v2 ? newList.slice(1).filter((m) => !checked.includes(m) && !group._reusable(m)) : newList.slice(1)
    const checkedAt = group._clock.now()
    const dropped = await verifyAll(todo, verify, { drop: true, fresh: group.epoch !== null, concurrency: group._concurrency })
    const keep = newList.filter((m, i) => i === 0 || !dropped.includes(m))
    const epoch = group.epoch === null ? 0 : group.epoch + 1
    if (epoch > MAX_EPOCH) fail('epoch counter exhausted: create a new group')
    const issued = Math.floor(group._clock.now() / 1000)
    let built
    if (group.format === 2) {
      const prev = group.epoch === null ? '00'.repeat(32) : toHex(sha256(group._held().rosterBytes))
      built = buildEpochV2({ gid, epoch, issued, prev, owner, members: keep, relays: transports.relays, bus: transports.bus, ownerEdSecret: id.edSecret, random })
    } else {
      const snap = group.snapshot()
      const prev = group.epoch === null ? '00'.repeat(32) : toHex(sha256(te.encode(snap.roster)))
      built = buildEpoch({ gid, epoch, issued, prev, owner, members: keep, relays: transports.relays, bus: transports.bus, ownerEdSecret: id.edSecret, random })
    }
    install(epoch, { ...built.roster }, built.rosterBytes, built.K)
    // format 2: a verdict for what was checked now, dated from the start of the check; a reused verdict keeps its date, so
    // reuse never outlives verifyReuseS / 格式 2：为本次核验的条目记结论（自核验开始时起算）；复用的结论保留原日期，复用不会超过 verifyReuseS
    if (group.format === 2) {
      if (v2) {
        group._trustAll([built.roster.members[0]])                                     // ourselves / 我们自己
        group._trustAll(todo.filter((m) => !dropped.includes(m)), checkedAt)
      } else group._trustAll(built.roster.members, trustedAt)                         // 'trust-roster', or createGroup's check / 或 createGroup 的核验
    }
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
      const max = group.format === 2 ? MAX_MEMBERS_V2 : MAX_MEMBERS
      if (list.length + add.length > max) fail(`a ${group.format === 2 ? 'format-2 ' : ''}group has at most ${max} members`)
      const vm = opts.verifyMember ?? verifyMember
      if (group.format === 2) {
        // GRP2-1: each new member is checked ONCE, freshly (the epoch below reuses this check) / 新成员只核验一次（下面的纪元复用这次核验）
        const at = group._clock.now()
        await verifyAll(add, vm, { concurrency: group._concurrency, fresh: true })
        if (typeof vm === 'function') group._trustAll(add, at)
        return next([...list, ...add], { verify: vm, added: add, checked: add })
      }
      await verifyAll(add, vm, { concurrency: group._concurrency })
      return next([...list, ...add], { verify: vm, added: add })
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
      // format 2 adds `format: 2` to the same invite kind (§3.8), so a format-1 client joins and then refuses the epoch
      // message with GROUP_INVALID, instead of skipping an invite of an unknown kind in silence
      // 格式 2 在同一种邀请里加 `format: 2`：格式 1 客户端会入群、随后以 GROUP_INVALID 拒收纪元消息，而不是悄悄跳过一种不认识的邀请
      return sealToInbox({ v: 1, kind: GROUP_INVITE_KIND, gid: toHex(gid), owner, relays: transports.relays.map((x) => ({ url: x.url, container: x.container })), ...(transports.bus ? { bus: transports.bus } : {}), ...(group.format === 2 ? { format: 2 } : {}) },
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
const ownerVerifier = (v) => (typeof v === 'function' || v === 'trust-roster' ? v : null)
export async function createGroup(opts = {}) {
  const { self, identity, members = [], relays = [], bus, verifyMember, random = randomBytes } = opts
  const now = clockMs(opts)
  const concurrency = checkConcurrency(opts.verifyConcurrency) ?? VERIFY_CONCURRENCY
  const format = checkFormat(opts.format) ?? 1
  const id = checkIdentity(identity)
  const owner = { container: self.container.toLowerCase(), chainId: self.chainId ?? 56 }
  const ownerEntry = normMember({ ...owner, x25519: id.xPub, ed25519: id.edPub })
  const others = members.map(normMember)
  checkUnique([ownerEntry, ...others])
  if (format === 2) { for (const m of [ownerEntry, ...others]) checkChainIdV2(m); if (others.length + 1 > MAX_MEMBERS_V2) fail(`a format-2 group has at most ${MAX_MEMBERS_V2} members`) }
  // format 2: how long the owner reuses a positive verdict (§3.8, GRP2-1); 0 checks every member on every epoch
  // 格式 2：群主复用肯定结论的时长；0 表示每个纪元都核验全部成员
  const reuseS = format === 2 ? checkReuse(opts.verifyReuseS) : VERIFY_REUSE_S
  const checkedAt = (now ?? (() => Date.now()))()
  await verifyAll(others, verifyMember, { concurrency })
  const gid = random(16)
  // format 2: the owner's verifier also serves its own lazy checks once the verdicts of the last epoch age out (GRPR-4)
  // 格式 2：群主的核验器也用于它自己的惰性核验（上一纪元的结论过期之后）
  const { group, install } = makeGroup({ gid, self: owner, id, ownerRef: owner, ownerEd: id.edPub, isOwner: true, random, concurrency, format, reuseS, verifier: ownerVerifier(verifyMember), ...(now ? { now } : {}) })
  const next = ownerApi({ group, install, gid, owner, id, verifyMember, random, transports: { relays, bus }, startList: [ownerEntry, ...others] })
  const first = await next([ownerEntry, ...others], { verify: 'trust-roster', added: others, trustedAt: checkedAt })   // just verified above / 刚刚核验过
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
  const concurrency = checkConcurrency(opts.verifyConcurrency) ?? VERIFY_CONCURRENCY
  const id = checkIdentity(identity)
  // v: 1 (format 1, and format 2 as 1.2.0 wrote it) or v: 2 (format 2 since GRP2-2) / v: 1（格式 1，及 1.2.0 写出的格式 2）或 v: 2（格式 2）
  if (snapshot?.v === 2 && snapshot.format !== 2) fail('a v: 2 snapshot is a format-2 snapshot, and this one does not say format: 2')
  if (!snapshot || (snapshot.v !== 1 && snapshot.v !== 2) || snapshot.role !== 'owner' || typeof snapshot.roster !== 'string') fail('resumeGroup needs an owner snapshot()')
  const owner = { container: self.container.toLowerCase(), chainId: self.chainId ?? 56 }
  if (!sameContainer(snapshot.owner, owner)) fail('this snapshot belongs to another owner')
  let roster
  try { roster = safeParseJSON(snapshot.roster, { code: 'GROUP_INVALID' }) } catch (e) { fail(`snapshot roster: ${e.message}`) }
  if (roster.gid !== snapshot.gid || roster.epoch !== snapshot.epoch) fail('snapshot roster does not match the snapshot')
  const format = checkFormat(snapshot.format) ?? 1
  const reuseS = format === 2 ? checkReuse(opts.verifyReuseS) : VERIFY_REUSE_S
  const gid = fromHex(snapshot.gid, 16, 'gid')
  const { group, install } = makeGroup({ gid, self: owner, id, ownerRef: owner, ownerEd: id.edPub, isOwner: true, lastSeq: parseLastSeq(snapshot.lastSeq), random, concurrency, format, reuseS, verifier: ownerVerifier(verifyMember), ...(now ? { now } : {}) })
  // stand the old roster up without a key, only so the next epoch chains to it / 立起旧名单（无密钥），只为让下一纪元接上
  if (format === 2) {
    // the roster bytes as sent (prev hashes them), and the full list the owner kept / 原样的名单字节（prev 的哈希对象）与群主保存的完整列表
    if (typeof snapshot.rosterBin !== 'string' || !/^[0-9a-f]+$/.test(snapshot.rosterBin) || snapshot.rosterBin.length % 2) fail('a format-2 owner snapshot needs rosterBin')
    if (!Array.isArray(roster.members) || !roster.members.length) fail('snapshot roster has no members')
    install(roster.epoch, { ...roster, format: 2, members: roster.members.map(normMember) }, fromHex(snapshot.rosterBin, snapshot.rosterBin.length / 2, 'rosterBin'), new Uint8Array(32), { keyless: true })
  } else install(roster.epoch, roster, te.encode(snapshot.roster), new Uint8Array(32), { keyless: true })
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

/**
 * @experimental §3.8: a member verifier that works for both formats. It reads the member's TAPI-26 channel record with
 * api.chain.channelKeys (the client's identity cache: at most 300 s, `fresh` reads past it) and compares ed25519, and
 * x25519 when the entry carries one. A format-2 member's roster entries carry no x25519, so api.groupVerifier(), which
 * compares both keys, would call every one of them a mismatch: pass this instead. A definitively invalid or absent
 * record answers false; an RPC failure throws (and is never a verdict).
 * 两种格式通用的成员核验器：用 api.chain.channelKeys 读通道记录（客户端身份缓存，至多 300 秒；`fresh` 绕过缓存），比较 ed25519，
 * 条目带 x25519 时也比较。格式 2 成员看到的名单条目没有 x25519，api.groupVerifier() 会比较两把密钥、把每个人都判为不符：请改用本函数。
 * 记录确定无效或不存在返回 false；RPC 故障抛出（绝不算结论）。
 */
export function channelKeysVerifier(api) {
  if (typeof api?.chain?.channelKeys !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', 'channelKeysVerifier needs a TapeAPI client (createTapeAPI) with chain.channelKeys')
  return async (m, { fresh = false } = {}) => {
    const chainId = api.chainId ?? 56
    if ((m.chainId ?? chainId) !== chainId) throw new TapeAPIError('GROUP_INVALID', `${m.container} is on chain ${m.chainId}; this client reads chain ${chainId}`)
    let rec
    try { rec = await api.chain.channelKeys(m.container, { fresh }) }
    catch (e) { if (e instanceof TapeAPIError && ['CHANNEL_INVALID', 'NOT_FOUND'].includes(e.code)) return false; throw e }
    const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
    return same(rec.ed25519, m.ed25519) && (m.x25519 === undefined || same(rec.x25519, m.x25519))
  }
}

/** Open a group invite from this container's inbox (§3.5) / 从收件房间打开入群邀请 */
export function openGroupInvite(wire, { self }) {
  const inv = openFromInbox(wire, { self })
  if (inv.kind !== GROUP_INVITE_KIND) fail('not a group invite')
  if (typeof inv.gid !== 'string' || !/^[0-9a-f]{32}$/.test(inv.gid)) fail('invite.gid must be 16 bytes of lowercase hex')
  if (!inv.owner || typeof inv.owner.container !== 'string') fail('invite.owner is required')
  checkRelays(inv.relays ?? []); checkBus(inv.bus)
  if (inv.format !== undefined && inv.format !== 1 && inv.format !== 2) fail(`this invite is for a group of format ${JSON.stringify(inv.format)}, which this client does not support`, { data: { format: inv.format } })
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
  const concurrency = checkConcurrency(opts.verifyConcurrency) ?? VERIFY_CONCURRENCY
  // The group's format comes from the invite (§3.8); `format` may state it too, and must agree.
  // 群格式取自邀请；`format` 也可以给出，但必须一致。
  const fromInvite = invite?.format === undefined ? undefined : checkFormat(invite.format, 'invite.format')
  const asked = checkFormat(opts.format)
  if (fromInvite !== undefined && asked !== undefined && fromInvite !== asked) fail(`the invite is for a format-${fromInvite} group, not format ${asked}`)
  const format = fromInvite ?? asked ?? 1
  // verifyMember and verifyReuseS are format-2 options. A format-1 group ignores them, as 1.1.0 ignored every option it did
  // not know (review GRPR-5: 1.x only adds), so code written for both formats can pass them to any invite.
  // verifyMember 与 verifyReuseS 是格式 2 的选项。格式 1 群忽略它们，与 1.1.0 忽略一切未知选项一致（1.x 只增不破），
  // 同时支持两种格式的代码可以对任何邀请都传入它们。
  const reuseS = format === 2 ? checkReuse(opts.verifyReuseS) : VERIFY_REUSE_S
  const id = checkIdentity(identity)
  if (!ownerKeys || !sameContainer(ownerKeys, invite.owner)) fail('ownerKeys must be the channel keys of invite.owner')
  let ownerEd
  try { ownerEd = assertEd25519Public(ownerKeys.ed25519, 'owner ed25519') } catch (e) { fail(e.message) }
  if (minEpoch !== undefined && (!Number.isInteger(minEpoch) || minEpoch < 0 || minEpoch > MAX_EPOCH)) fail('minEpoch must be an epoch number')
  const gid = fromHex(invite.gid, 16, 'gid')
  const { group } = makeGroup({ gid, self: { container: self.container.toLowerCase(), chainId: self.chainId ?? 56 }, id, ownerRef: invite.owner, ownerEd, isOwner: false, minEpoch: minEpoch ?? null, lastSeq: parseLastSeq(lastSeq), concurrency, format, reuseS, verifier: format === 2 ? (opts.verifyMember ?? null) : null, ...(now ? { now } : {}) })
  return group
}
