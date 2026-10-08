// TAPI-26: Tape Channel -- a real-time private channel between two TapeOut containers.
// TAPI-26：Tape Channel —— 两个 TapeOut 容器之间的实时私密通道。
//
// Identity (§3.1): channel keys the application generates and the circuit's holder authorises with an EIP-712
// signature, published as .well-known/tape-channel.json in the container's site. The TapeSend key on the DeWebHub
// (TAP-10 §4) is a fallback: deriving it asks the holder to sign text meant only for the TapeSend site.
// 身份（§3.1）：由应用生成、电路持有人以 EIP-712 签名授权、发布在容器站点 .well-known/tape-channel.json 的通道密钥。
// DeWebHub 上的 TapeSend 密钥只是备用：派生它要求持有人签署只应在 TapeSend 网站签署的文字。
//
// Handshake, 1.5 round trips, the X3DH core without prekeys:
//   invite  A -> B   sealed to B's channel key and posted to B's inbox room (default), or sent as a TapeSend message
//   accept  B -> A   over a transport: a relay (default), a direct connection, or a ChannelBus on chain (§3.7)
//   ready   A -> B   the same transport: A's key-confirmation MAC
// Keys come from three Diffie-Hellmans -- DH(eA,sB), DH(sA,eB), DH(eA,eB) -- which give mutual authentication
// (each static key takes part), forward secrecy (the ephemerals are discarded) and resistance to key-compromise
// impersonation (leaking A's static key does not let anyone pose as B to A).
// 握手 1.5 个往返，即不带预密钥的 X3DH 核心。三次 DH 同时给出：双向认证（每把长期密钥都参与）、前向保密
// （临时密钥用完即弃）、抗密钥泄露冒充（A 的长期密钥泄露，也没人能对 A 冒充 B）。
//
// Frames are ChaCha20-Poly1305 with a per-direction key and a 64-bit counter nonce, the WireGuard / Noise
// construction. The channel's security never depends on the transport: a relay, a WebRTC data channel or
// anything else only ever carries ciphertext, and may reorder, drop or replay it without being believed.
// 帧用 ChaCha20-Poly1305，每个方向一把密钥、64 位计数器作 nonce（WireGuard / Noise 的做法）。通道安全从不依赖传输层：
// 中继、WebRTC 数据通道或别的什么都只搬运密文，它可以重排、丢弃、重放，但都不会被采信。
import { x25519, ed25519 } from '@noble/curves/ed25519'
import { chacha20poly1305, xchacha20poly1305 } from '@noble/ciphers/chacha'
import { hkdf } from '@noble/hashes/hkdf'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { randomBytes } from '@noble/hashes/utils'
import { TapeAPIError } from './errors.js'
import { canonicalJSON, safeParseJSON } from './canon.js'
import { encodeCall, decodeParams, hexToBytes, isAddress } from './abi.js'
import { RPC_BODY_LIMIT } from './rpc.js'

export const INVITE_KIND = 'tape.channel/invite'
// Which static keys the two parties authenticate with (§3.1). The invite names it and the transcript binds it.
// 双方用哪种长期密钥认证（§3.1）。邀请写明，握手记录绑定。
export const KEYS_CHANNEL = 'tape-channel/v1'        // holder-authorised channel keys, .well-known/tape-channel.json (default)
export const KEYS_TAPESEND = 'tapesend/v1'           // the container's TapeSend key from the DeWebHub (fallback)
const KEY_KINDS = new Set([KEYS_CHANNEL, KEYS_TAPESEND])
export const MAX_FRAME_BYTES = 16 * 1024            // plaintext per frame / 每帧明文上限
export const MAX_INVITE_TTL_S = 3600
export const DEFAULT_INVITE_TTL_S = 600
export const MAX_SEQ = 2n ** 32n                    // re-handshake long before a nonce could repeat / 远在 nonce 可能重复之前就必须重新握手

const te = new TextEncoder()
const td = new TextDecoder('utf-8', { fatal: true })
const P_FIELD = 2n ** 255n - 19n
const fail = (msg, extra) => { throw new TapeAPIError('CHANNEL_INVALID', msg, extra) }

// ---------------------------------------------------------------- labels: TAPI-26 v1 and v2 ----
// Every domain-separation label exists in two versions. v1 (`TAP-26/…`) is TAPI-26 version 1, Stable (v1) and frozen
// (TAPI-1 §4.1): it is the default and its bytes never change. v2 (`tape-channel/…`) is spec/TAPI-26-v2.md (Draft), the
// labels the TAPs editors asked for; from 1.8.1 a caller opts in with `labels: 'v2'`, and from 2.0 it is the default.
// Only the prefix differs. The labels ARE the version marker: the invite, accept and ready objects are the same in both
// versions (the invite keeps `v: 1`), so both sides must be told the same version. A channel is of one version from its
// invite to its last frame; the SDK never retries, opens or confirms anything under the other version's labels, and
// where it can tell that a message was made under them it says so (data.labels / data.peerLabels) instead of failing
// with a generic error.
// 每个域分隔标签都有两个版本。v1（`TAP-26/…`）即 TAPI-26 第 1 版，Stable (v1) 且冻结：它是默认值，字节永不改变。v2
// （`tape-channel/…`）即 spec/TAPI-26-v2.md（Draft），是 TAPs 编辑要求的标签；1.8.1 起调用方以 `labels: 'v2'` 选用，2.0 起成为
// 默认。两者只有前缀不同。**标签本身就是版本标记**：邀请、accept、ready 对象在两个版本里完全相同（邀请仍是 `v: 1`），所以必须让双方
// 知道同一个版本。一条通道从邀请到最后一帧只属于一个版本；SDK 从不改用另一版本的标签重试、打开或确认任何东西；能看出消息是用另一
// 版本的标签做出的时候，错误会明说（data.labels / data.peerLabels），而不是给一个笼统的失败。
const CHANNEL_LABELS = {
  v1: {
    inbox: 'TAP-26/inbox/v1', transcript: 'TAP-26/transcript/v1', keys: 'TAP-26/keys/v1',
    initiator: 'TAP-26/confirm/initiator', responder: 'TAP-26/confirm/responder', frame: 'TAP-26/frame/v1', room: 'TAP-26/room/v1',
  },
  v2: {
    inbox: 'tape-channel/inbox/v1', transcript: 'tape-channel/transcript/v1', keys: 'tape-channel/keys/v1',
    initiator: 'tape-channel/confirm/initiator', responder: 'tape-channel/confirm/responder', frame: 'tape-channel/frame/v1', room: 'tape-channel/room/v1',
  },
}
const LB = Object.fromEntries(Object.entries(CHANNEL_LABELS).map(([v, t]) => [v, Object.fromEntries(Object.entries(t).map(([k, s]) => [k, te.encode(s)]))]))
/** The other label version / 另一个标签版本 */
export const otherLabels = (v) => (v === 'v2' ? 'v1' : 'v2')
/**
 * `labels`: undefined (= 'v1', the default), 'v1' or 'v2'. Anything else is a configuration mistake, never read as v1.
 * `labels`：undefined（即默认的 'v1'）、'v1' 或 'v2'。其他值都是配置错误，绝不当作 v1。
 */
export function checkLabels(labels, name = 'labels') {
  if (labels === undefined) return 'v1'
  if (labels !== 'v1' && labels !== 'v2') throw new TapeAPIError('INVALID_ARGUMENT', `${name} must be 'v1' (TAPI-26/27 version 1, labels TAP-26/ and TAP-27/, the default) or 'v2' (TAPI-26/27 version 2, labels tape-channel/ and tape-group/)`)
  return labels
}
// The message a version mismatch gets, wherever one is detected / 版本不一致时的统一说明
export const labelsMismatch = (what, mine, theirs) => `${what} was made under ${theirs === 'v2' ? 'TAPI-26/27 v2 labels (tape-channel/, tape-group/)' : 'TAPI-26/27 v1 labels (TAP-26/, TAP-27/)'}, and this side uses ${mine === 'v2' ? 'v2' : 'v1'}: both sides must pass the same \`labels\` ('${theirs}' here would match). The SDK never switches versions on its own.`

// ---------------------------------------------------------------- bytes ----
const concat = (...parts) => {
  const n = parts.reduce((a, p) => a + p.length, 0)
  const out = new Uint8Array(n); let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
export const fromHex = (h, len, name = 'value') => {
  if (typeof h !== 'string') fail(`${name} must be a hex string`)
  const s = h.startsWith('0x') ? h.slice(2) : h
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2) fail(`${name} is not hex`)
  if (len !== undefined && s.length !== len * 2) fail(`${name} must be ${len} bytes`)
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}
const u64be = (n) => { const b = new Uint8Array(8); let v = BigInt(n); for (let i = 7; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n } return b }
const readU64be = (b) => { let v = 0n; for (const x of b) v = (v << 8n) | BigInt(x); return v }
// Constant time over equal-length inputs: a confirmation MAC compared with early exit leaks how many bytes matched.
// 等长输入上的常数时间比较：提前退出的比较会泄露匹配了几个字节。
const equalCT = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0 }

// The TapeSend endpoint id, byte for byte as TAP-10 builds it: uint32(0) || uint64(chainId) || container.
// Binding the transcript to it means a channel cannot be replayed to the same container on another chain.
// TapeSend 端点号，与 TAP-10 逐字节一致。把它绑进握手记录，通道就不能被搬到另一条链上的同一个容器。
export function endpointBytes(container, chainId = 56) {
  if (typeof container !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(container)) fail('container must be an address')
  const c = BigInt(chainId)
  if (c < 1n || c >= 2n ** 64n) fail('chainId must fit in 64 bits')
  return concat(new Uint8Array(4), u64be(c), fromHex(container, 20, 'container'))
}

// TAP-10 §4.4, applied to every key we are handed: canonical encoding, top bit clear, not a low-order point.
// A low-order key forces every Diffie-Hellman to a known value, which would make the "secret" public.
// 对收到的每一把公钥做 TAP-10 §4.4 的检查：规范编码、最高位为 0、不是低阶点。低阶点会把 DH 结果钉成已知值，
// 等于把"秘密"公开。
export function assertPublicKey(pk, name = 'public key') {
  if (!(pk instanceof Uint8Array) || pk.length !== 32) fail(`${name} must be 32 bytes`)
  if (pk[31] & 0x80) fail(`${name} has its top bit set`)
  let u = 0n; for (let i = 31; i >= 0; i--) u = (u << 8n) | BigInt(pk[i])
  if (u >= P_FIELD) fail(`${name} is not canonical`)
  return pk
}
/** assertPublicKey plus the low-order check: a key no honest party could have published / 再加低阶点检查 */
export function assertUsablePublicKey(pk, name = 'public key') {
  assertPublicKey(pk, name)
  dh(Uint8Array.of(...new Uint8Array(31).fill(0x11), 0x41), pk, name).fill(0)
  return pk
}
function dh(secret, pub, name) {
  let ss
  try { ss = x25519.getSharedSecret(secret, pub) } catch { fail(`X25519 with ${name} failed (invalid or low-order key)`) }
  if (ss.every((x) => x === 0)) fail(`X25519 with ${name} gave the all-zero secret (low-order key)`)
  return ss
}

export function generateKeyPair(random = randomBytes) {
  const secretKey = random(32)
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) }
}
export const publicKeyOf = (secretKey) => x25519.getPublicKey(secretKey)

// Channel rooms, one per direction, derived from the channel id. The channel id only ever travels inside a sealed
// invite, so a channel room name is an unguessable capability and says nothing about who is talking. (Inbox rooms
// are different: anyone can derive one from a container.)
// 通道房间，每个方向一个，由通道号派生。通道号只出现在密封邀请里，所以通道房间名是猜不到的凭据，也不透露谁在和谁通信。
// （收件房间不同：任何人都能由容器推导出来。）
// `labels` (TAPI-26 v2, opt-in from 1.8.1): the rooms of a v2 channel are other rooms; pass the channel's version.
// `labels`（TAPI-26 v2，1.8.1 起可选）：v2 通道的房间是另外的房间；传入通道的版本。
export function roomsFor(cid, { labels } = {}) {
  const L = LB[checkLabels(labels)]
  const c = typeof cid === 'string' ? fromHex(cid, 16, 'cid') : cid
  const room = (dir) => toHex(sha256(concat(L.room, c, Uint8Array.of(dir))))
  return { toInitiator: room(0), toResponder: room(1) }
}

// ---------------------------------------------------------------- key schedule ----
// Everything both sides must agree on goes into the transcript hash: the channel id, both endpoints, both static
// keys, both ephemeral keys and the invite expiry. Leaving any one out is how unknown-key-share and misbinding
// attacks are built -- the keys would match while the parties disagree about who they are talking to.
// 双方必须一致的东西全部进握手记录哈希。漏掉任何一项，就给了"未知密钥共享"与"身份错绑"攻击机会：密钥对得上，
// 双方却对"我在和谁说话"有不同认识。
// The whole invite is hashed in as well, so its relays and SDP are authenticated by the key schedule itself and
// not only by the path it happened to travel: a tampered invite now yields a handshake that fails, however it
// was delivered (TAPI-26 audit, L-2).
// 整份邀请的哈希也放进去，于是其中的中继列表与 SDP 由密钥调度本身认证，而不只是靠它碰巧走过的送达路径：
// 被篡改的邀请无论经由哪条路送达，都只会得到一次失败的握手。
export const inviteHash = (invite) => sha256(te.encode(canonicalJSON(invite)))
function transcript({ cid, epA, epB, SA, SB, EA, EB, exp, ih }, L) {
  return sha256(concat(L.transcript, cid, epA, epB, SA, SB, EA, EB, u64be(exp), ih))
}
function deriveKeys(ikm, th, L) {
  const okm = hkdf(sha256, ikm, th, L.keys, 128)
  const k = { kAB: okm.slice(0, 32), kBA: okm.slice(32, 64), cA: okm.slice(64, 96), cB: okm.slice(96, 128) }
  okm.fill(0)
  return k
}
const confirmTag = (key, role, th, L) => hmac(sha256, key, concat(L[role], th))

// Exposed only so the spec vectors can pin every intermediate value; applications never need it.
// 仅为规范向量能钉住每个中间值而导出，应用不需要它。
export function _keySchedule({ cid, epA, epB, SA, SB, EA, EB, exp, ih, dh1, dh2, dh3, labels }) {
  const L = LB[checkLabels(labels)]
  const th = transcript({ cid, epA, epB, SA, SB, EA, EB, exp, ih }, L)
  const ikm = concat(dh1, dh2, dh3)
  const k = deriveKeys(ikm, th, L)
  ikm.fill(0)
  const out = { th, kAB: k.kAB, kBA: k.kBA, confirmA: confirmTag(k.cA, 'initiator', th, L), confirmB: confirmTag(k.cB, 'responder', th, L) }
  k.cA.fill(0); k.cB.fill(0)
  return out
}
// The confirmation tags the same handshake would carry under the OTHER label version, used only to name a version
// mismatch in an error (never to accept anything). Keys derived on the way are wiped.
// 同一次握手在**另一**标签版本下会带的确认标签，只用于在错误里点明版本不一致（绝不用来接受任何东西）；途中派生的密钥随即清零。
function otherConfirms(args, labels) {
  const ks = _keySchedule({ ...args, labels: otherLabels(labels) })
  ks.kAB.fill(0); ks.kBA.fill(0)
  return { confirmA: ks.confirmA, confirmB: ks.confirmB }
}

// ---------------------------------------------------------------- handshake ----
function party(p, who, needSecret) {
  if (!p || typeof p !== 'object') fail(`${who} is required`)
  const chainId = p.chainId ?? 56
  const ep = endpointBytes(p.container, chainId)
  if (needSecret) {
    if (!(p.staticSecret instanceof Uint8Array) || p.staticSecret.length !== 32) fail(`${who}.staticSecret must be 32 bytes`)
    return { ep, chainId, container: p.container, secret: p.staticSecret, pub: x25519.getPublicKey(p.staticSecret) }
  }
  const pub = typeof p.staticPublic === 'string' ? fromHex(p.staticPublic, 32, `${who}.staticPublic`) : p.staticPublic
  return { ep, chainId, container: p.container, pub: assertPublicKey(pub, `${who}.staticPublic`) }
}
const nowS = () => Math.floor(Date.now() / 1000)
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

// Relays are identified by their TAPI-20 container; `url` is only a hint. Checked on BOTH sides: the responder is
// the one who will connect to them, and a malicious initiator could otherwise point it at internal addresses.
// 中继以其 TAPI-20 容器标识，`url` 只是提示。两侧都校验：真正去连接中继的是响应方，否则恶意发起方可以让它连向内网地址。
export function checkRelays(relays) {
  if (!Array.isArray(relays) || relays.length > 4) fail('relays must be an array of at most 4')
  for (const r of relays) {
    if (!r || typeof r.url !== 'string' || r.url.length > 512) fail('each relay needs a url of at most 512 characters')
    // A relay is a TAPI-20 service, so it is https (TAPI-21 §8). Plain http is accepted only for a loopback host,
    // which is what local development and tests use. / 中继是 TAPI-20 服务，须 https；仅回环地址允许 http（本地开发与测试）。
    let u; try { u = new URL(r.url) } catch { fail(`relay url ${r.url.slice(0, 80)} is not a URL`) }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) fail('relay url must be https (http only for a loopback host)')
    // The container is what a client resolves (TAPI-20 §3.6) to learn the relay's signer and prices; a url alone
    // cannot be used outside dev mode, so an invite that omits it is undeliverable. / 没有容器的中继在 dev 之外无法使用。
    if (!/^0x[0-9a-fA-F]{40}$/.test(r.container || '')) fail('each relay needs its container address')
  }
}

// The invite as TapeSend content (TAPI-26 §3.2): UTF-8 canonical JSON. `v` is 1 and `kind` is not "message", so a
// TapeSend client that does not implement TAPI-26 shows it as unsupported (TAP-10 §6). Decoding uses the strict
// parser; acceptInvite() does the semantic checks. / 邀请作为 TapeSend 内容：UTF-8 规范 JSON；解码用严格解析器。
export const encodeInviteContent = (invite) => te.encode(canonicalJSON(invite))
export function decodeInviteContent(bytes) {
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { fail('invite content is not UTF-8') }
  let obj
  try { obj = safeParseJSON(text, { code: 'CHANNEL_INVALID' }) } catch { fail('invite content is not strict JSON (no duplicate or prototype keys)') }
  if (!obj || obj.v !== 1 || obj.kind !== INVITE_KIND) fail('not a TAPI-26 invite')
  return obj
}

// §3.7: an invite MAY name a ChannelBus on which the initiator also listens.
// §3.7：邀请 MAY 指定一个 ChannelBus，发起方也在其上监听。
export function checkBus(bus) {
  if (bus === undefined) return
  if (typeof bus !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(bus)) fail('bus must be a contract address')
}

// Initiator secrets live here, never on the object handed back. A copy of `pending` -- structuredClone, a
// round trip through IndexedDB, JSON -- therefore carries no key and cannot complete a second time with the
// same ephemeral, which would reuse a nonce (audit M-3). A handshake whose state is lost is simply restarted.
// 发起方的秘密放在这里，从不放在返回的对象上。因此 `pending` 的任何拷贝都不带密钥，无法用同一个临时密钥
// 再完成一次（那会重用 nonce）。状态丢了就重新握手。
const PENDING = new WeakMap()

/**
 * Initiator step 1. Returns the invite -- a TapeSend content object, sent sealed to the peer -- and an opaque
 * handle for step 2. Relays are TapeAPI services this side will listen on ({ container, url }).
 * 发起方第 1 步。返回邀请（一个 TapeSend 内容对象，密封发给对方）和第 2 步要用的不透明句柄。
 */
// `random` exists only so spec vectors can be reproduced; production MUST use the default secure source.
// `random` 仅为复现规范向量而存在；生产环境 MUST 使用默认的安全随机源。
// `labels`: 'v1' (default, TAPI-26 v1) or 'v2' (TAPI-26 v2, tape-channel/ labels, opt-in from 1.8.1). The invite object
// is the same in both versions and does not say which one it is: the responder must be told (pass the same `labels` to
// acceptInvite). The handle and the session report it as `labels`; the rooms to listen on are roomsFor(cid, { labels }).
// `labels`：'v1'（默认，TAPI-26 第 1 版）或 'v2'（TAPI-26 第 2 版，tape-channel/ 标签，1.8.1 起可选）。邀请对象在两个版本里
// 完全相同，也不说明自己属于哪个版本：必须告诉响应方（给 acceptInvite 传同样的 `labels`）。句柄与会话以 `labels` 报告版本；
// 要监听的房间是 roomsFor(cid, { labels })。
export function createInvite({ self, peer, relays = [], bus, keys = KEYS_CHANNEL, ttlS = DEFAULT_INVITE_TTL_S, webrtc, now = nowS(), random = randomBytes, labels }) {
  const lv = checkLabels(labels)
  const a = party(self, 'self', true), b = party(peer, 'peer', false)
  if (!Number.isInteger(ttlS) || ttlS < 30 || ttlS > MAX_INVITE_TTL_S) fail(`ttlS must be an integer in [30, ${MAX_INVITE_TTL_S}]`)
  checkRelays(relays)
  checkBus(bus)
  if (!KEY_KINDS.has(keys)) fail(`keys must be one of ${[...KEY_KINDS].join(', ')}`)
  dh(a.secret, b.pub, 'the peer static key').fill(0)   // refuse a low-order peer key now, not at step 2 / 立刻拒绝低阶的对方密钥
  const cid = random(16)
  const e = generateKeyPair(random)
  const exp = now + ttlS
  const invite = {
    v: 1, kind: INVITE_KIND,
    cid: toHex(cid), e: toHex(e.publicKey), exp,
    // Who is inviting, and with which keys. The responder looks the initiator's key up from these; the handshake
    // then proves them, since only the real holder of that key can complete it.
    // 谁在邀请、用哪种密钥。响应方据此查出发起方的公钥；握手随后证明它们——只有真正持有该密钥的一方才能完成握手。
    from: { container: a.container, chainId: a.chainId }, keys,
    relays: relays.map((r) => ({ url: r.url, ...(r.container ? { container: r.container } : {}) })),
    ...(bus !== undefined ? { bus } : {}),
    ...(webrtc ? { webrtc } : {}),
  }
  const ih = inviteHash(invite)                          // also refuses a webrtc value with no canonical form / 同时拒绝没有规范形式的 webrtc
  const pending = Object.freeze({ role: 'initiator', cid: invite.cid, exp, labels: lv })
  PENDING.set(pending, { a, b, cid, e, exp, ih, lv, done: false })
  return { invite, pending }
}

/**
 * Responder. `peer` is the initiator: its container comes from the TapeSend `from` field and its static key
 * from its channel record (or, with keys: 'tapesend/v1', the DeWebHub) -- never from the invite itself.
 * Pass a Set as `seen` to refuse a channel id accepted before (TAPI-26 §3.2 SHOULD); keep it until the ids expire.
 * 响应方。`peer` 是发起方：容器取自 TapeSend 的 `from`，长期公钥取自 DeWebHub —— 绝不取自邀请本身。
 * 传入一个 Set 作为 `seen` 即可拒绝已接受过的通道号；保留到这些号过期为止。
 */
// `labels` must be the version the initiator used (see createInvite): an invite does not carry it, and the SDK never
// guesses it. A TapeSend-delivered invite in particular says nothing about it; with the wrong version the handshake
// fails (the initiator reads other rooms and refuses the accept), it never falls back.
// `labels` 必须与发起方所用版本一致（见 createInvite）：邀请里没有它，SDK 也从不猜测。尤其是经 TapeSend 送达的邀请对此只字不提；
// 版本不对时握手失败（发起方读的是别的房间，也会拒绝这个 accept），绝不退回另一个版本。
export function acceptInvite({ self, peer, invite, now = nowS(), random = randomBytes, seen, labels }) {
  const lv = checkLabels(labels)
  const b = party(self, 'self', true), a = party(peer, 'peer', false)
  if (!invite || invite.v !== 1 || invite.kind !== INVITE_KIND) fail('not a TAPI-26 invite')
  const cid = fromHex(invite.cid, 16, 'invite.cid')
  const EA = assertPublicKey(fromHex(invite.e, 32, 'invite.e'), 'invite.e')
  if (!Number.isInteger(invite.exp)) fail('invite.exp must be an integer')
  if (invite.exp <= now) fail(`invite expired at ${invite.exp}`)
  if (invite.exp > now + MAX_INVITE_TTL_S) fail('invite.exp is further ahead than any honest initiator would set')
  checkRelays(invite.relays ?? [])
  checkBus(invite.bus)
  if (!KEY_KINDS.has(invite.keys)) fail('invite.keys names no key kind this client knows')
  // The caller looked the initiator's static key up from invite.from; they must be the same party.
  // 调用方按 invite.from 查出发起方公钥；两者必须是同一方。
  if (!invite.from || typeof invite.from.container !== 'string' || invite.from.container.toLowerCase() !== String(a.container).toLowerCase() || invite.from.chainId !== a.chainId) {
    fail('invite.from does not name the peer whose key was supplied')
  }
  if (seen !== undefined && !(seen instanceof Set)) fail('seen must be a Set of accepted channel ids')
  const cidHex = toHex(cid)
  if (seen?.has(cidHex)) fail(`channel ${cidHex} was already accepted: refusing a replayed invite`)
  const ih = inviteHash(invite)
  const e = generateKeyPair(random)
  let dh1, dh2, dh3
  try {
    dh1 = dh(b.secret, EA, 'the initiator ephemeral')          // DH(sB, eA) = DH(eA, sB)
    dh2 = dh(e.secretKey, a.pub, 'the initiator static key')    // DH(eB, sA) = DH(sA, eB)
    dh3 = dh(e.secretKey, EA, 'the initiator ephemeral')        // DH(eB, eA)
  } finally { e.secretKey.fill(0) }                              // forward secrecy, on every path / 前向保密，任何路径上都销毁
  const ksArgs = { cid, epA: a.ep, epB: b.ep, SA: a.pub, SB: b.pub, EA, EB: e.publicKey, exp: invite.exp, ih, dh1, dh2, dh3 }
  const ks = _keySchedule({ ...ksArgs, labels: lv })
  const other = otherConfirms(ksArgs, lv)                     // only to name a mismatch in confirm() / 只用于在 confirm() 中点明版本不一致
  dh1.fill(0); dh2.fill(0); dh3.fill(0)
  seen?.add(cidHex)
  const accept = { t: 'accept', cid: cidHex, e: toHex(e.publicKey), confirm: toHex(ks.confirmB) }
  const session = makeSession({ role: 'responder', cid, sendKey: ks.kBA, recvKey: ks.kAB, th: ks.th, peerConfirm: ks.confirmA, otherConfirm: other.confirmA, peer: a, exp: invite.exp, labels: lv })
  return { accept, session }
}

/**
 * Initiator step 2: check the responder's confirmation and produce `ready`. An accept that does not verify is
 * refused WITHOUT consuming the handle, so a forged accept posted to the relay room cannot kill the handshake;
 * the initiator keeps waiting for a genuine one until the invite expires.
 * 发起方第 2 步：核对响应方确认并产出 `ready`。验不过的 accept 被拒绝，但**不消耗**句柄，所以往中继房间里塞一个
 * 伪造 accept 杀不掉这次握手；发起方会继续等待真正的 accept，直到邀请过期。
 */
export function completeInvite(pending, accept, { now = nowS() } = {}) {
  const st = pending ? PENDING.get(pending) : undefined
  if (!st) fail('pending state is not an original handle from createInvite (a copy carries no secret): restart the handshake')
  if (st.done) fail('pending state already used')
  if (!accept || accept.t !== 'accept') fail('not an accept message')
  if (!sameBytes(fromHex(accept.cid, 16, 'accept.cid'), st.cid)) fail('accept is for a different channel')
  if (st.exp <= now) fail('the invite expired before it was accepted')
  const EB = assertPublicKey(fromHex(accept.e, 32, 'accept.e'), 'accept.e')
  const { a, b, cid, e, exp, ih, lv } = st
  const dh1 = dh(e.secretKey, b.pub, 'the responder static key')  // DH(eA, sB)
  const dh2 = dh(a.secret, EB, 'the responder ephemeral')         // DH(sA, eB)
  const dh3 = dh(e.secretKey, EB, 'the responder ephemeral')      // DH(eA, eB)
  const ksArgs = { cid, epA: a.ep, epB: b.ep, SA: a.pub, SB: b.pub, EA: e.publicKey, EB, exp, ih, dh1, dh2, dh3 }
  const ks = _keySchedule({ ...ksArgs, labels: lv })
  // Only someone holding B's static secret can produce this tag. Checking it before sending anything is what
  // stops a man in the middle who swapped in his own ephemeral key.
  // 只有持有 B 长期私钥的人才算得出这个标签。在发送任何东西之前核对它，才能挡住换上自己临时密钥的中间人。
  let refused = null
  try {
    const got = fromHex(accept.confirm, 32, 'accept.confirm')
    if (!equalCT(got, ks.confirmB)) {
      ks.kAB.fill(0); ks.kBA.fill(0)
      // Refused either way, and the handle is kept. If the tag is the one the other label version gives, say so.
      // 无论如何都拒绝，句柄保留。若该标签正是另一标签版本给出的值，就明说。
      refused = equalCT(got, otherConfirms(ksArgs, lv).confirmB) ? 'labels' : 'key'
    }
  } finally { dh1.fill(0); dh2.fill(0); dh3.fill(0) }
  if (refused === 'labels') fail(labelsMismatch('this accept', lv, otherLabels(lv)), { data: { labels: lv, peerLabels: otherLabels(lv) } })
  if (refused) fail('accept.confirm does not verify: the peer does not hold the static key published for its container')
  st.done = true
  e.secretKey.fill(0)
  PENDING.delete(pending)
  const session = makeSession({ role: 'initiator', cid, sendKey: ks.kAB, recvKey: ks.kBA, th: ks.th, confirmed: true, peer: b, exp, labels: lv })
  return { ready: { t: 'ready', cid: toHex(cid), confirm: toHex(ks.confirmA) }, session }
}

// ---------------------------------------------------------------- session ----
function makeSession({ role, cid, sendKey, recvKey, th, peerConfirm, otherConfirm = null, confirmed = false, peer, exp, labels }) {
  const L = LB[labels]
  let sendSeq = 0n
  let recvHigh = -1n
  let isConfirmed = confirmed
  let closed = false
  const dirOut = role === 'initiator' ? 0 : 1
  const dirIn = 1 - dirOut
  const aad = (dir, seq) => concat(L.frame, cid, Uint8Array.of(dir), u64be(seq))
  const nonce = (seq) => concat(new Uint8Array(4), u64be(seq))
  const rooms = roomsFor(cid, { labels })
  return {
    role, cid: toHex(cid), transcript: toHex(th), peer: { container: peer.container, chainId: peer.chainId },
    /** 'v1' or 'v2': the TAPI-26 label version of this channel / 本通道的 TAPI-26 标签版本 */
    labels,
    // The room this side reads from, and the room it writes to. / 本方读取的房间，与写入的房间。
    rooms: role === 'initiator'
      ? { inbound: rooms.toInitiator, outbound: rooms.toResponder }
      : { inbound: rooms.toResponder, outbound: rooms.toInitiator },
    get confirmed() { return isConfirmed },
    /**
     * Responder only: check the initiator's `ready`. Inbound frames are refused until it verifies, and a `ready`
     * arriving after the invite expired is refused: the handshake has a deadline on both sides.
     * 仅响应方：核对发起方的 `ready`。核对通过前拒绝入站帧；邀请过期后才到的 `ready` 也拒绝：握手两侧都有截止时间。
     */
    confirm(ready, { now = nowS() } = {}) {
      if (role !== 'responder') fail('only the responder confirms')
      if (isConfirmed) return
      if (!ready || ready.t !== 'ready') fail('not a ready message')
      if (!sameBytes(fromHex(ready.cid, 16, 'ready.cid'), cid)) fail('ready is for a different channel')
      if (exp <= now) fail(`ready arrived after the invite expired at ${exp}`)   // same bound as accept / 与 accept 相同的边界
      // Proves the initiator holds its static secret; until then B has only an invite anyone could have replayed.
      // 证明发起方持有其长期私钥；在此之前 B 手里只有一份任何人都可能重放的邀请。
      const got = fromHex(ready.confirm, 32, 'ready.confirm')
      if (!equalCT(got, peerConfirm)) {
        if (otherConfirm && equalCT(got, otherConfirm)) fail(labelsMismatch('this ready', labels, otherLabels(labels)), { data: { labels, peerLabels: otherLabels(labels) } })
        fail('ready.confirm does not verify: the initiator does not hold the static key published for its container')
      }
      isConfirmed = true
      peerConfirm.fill(0)
      otherConfirm?.fill(0)
    },
    /** Encrypt one message. Returns frame bytes: uint64 seq || ciphertext || tag. / 加密一条消息。 */
    seal(data) {
      if (closed) fail('channel is closed')
      const pt = typeof data === 'string' ? te.encode(data) : data
      if (!(pt instanceof Uint8Array)) fail('seal takes a string or Uint8Array')
      if (pt.length > MAX_FRAME_BYTES) fail(`frame of ${pt.length} bytes exceeds ${MAX_FRAME_BYTES}`)
      if (sendSeq >= MAX_SEQ) fail('frame limit reached: open a new channel')
      const seq = sendSeq++
      return concat(u64be(seq), chacha20poly1305(sendKey, nonce(seq), aad(dirOut, seq)).encrypt(pt))
    },
    /**
     * Decrypt one frame. Sequence numbers must strictly increase: a replayed, duplicated or reordered frame is
     * refused. Gaps are allowed -- a transport may lose frames -- and reported as `skipped`, so the application
     * decides whether a loss is tolerable. Nothing is consumed unless the call succeeds.
     * 解密一帧。序号必须严格递增：重放、重复、乱序的帧一律拒绝。允许空洞（传输层可能丢帧），以 `skipped` 报告，
     * 由应用决定能否容忍丢失。调用不成功就不消耗任何东西。
     */
    open(frame, { text = false } = {}) {
      if (closed) fail('channel is closed')
      if (role === 'responder' && !isConfirmed) fail('initiator has not confirmed yet: refusing inbound frames')
      if (!(frame instanceof Uint8Array) || frame.length < 8 + 16) fail('frame too short')
      if (frame.length > 8 + MAX_FRAME_BYTES + 16) fail('frame too long')
      const seq = readU64be(frame.subarray(0, 8))
      if (seq <= recvHigh) fail(`frame ${seq} is not after ${recvHigh}: replayed, duplicated or reordered`)
      if (seq >= MAX_SEQ) fail('frame sequence out of range')
      let pt
      try { pt = chacha20poly1305(recvKey, nonce(seq), aad(dirIn, seq)).decrypt(frame.subarray(8)) }
      catch { fail('frame failed authentication: tampered, misdirected or not for this channel') }
      let data = pt
      // Decode BEFORE advancing: an authentic frame that is not UTF-8 must stay openable as bytes (audit L-5).
      // 先解码再推进：不是 UTF-8 的真实帧必须仍能以字节形式打开。
      if (text) { try { data = td.decode(pt) } catch { fail('frame is authentic but not UTF-8: open it without { text: true } to get the bytes') } }
      const skipped = Number(seq - recvHigh - 1n)
      recvHigh = seq
      return { seq: Number(seq), data, skipped }
    },
    close() { closed = true; sendKey.fill(0); recvKey.fill(0) },
  }
}

// ---------------------------------------------------------------- wire ----
// What a transport carries: one type byte, then either a handshake message (UTF-8 JSON) or a frame.
// Transports never look inside; this exists so one relay room can carry both.
// 传输层搬运的单位：一个类型字节，后面是握手消息（UTF-8 JSON）或一帧。传输层从不查看内容。
const WIRE_HANDSHAKE = 0x01, WIRE_FRAME = 0x02, WIRE_INVITE = 0x03
export function encodeWire(x) {
  if (x instanceof Uint8Array) return concat(Uint8Array.of(WIRE_FRAME), x)
  if (x && (x.t === 'accept' || x.t === 'ready')) return concat(Uint8Array.of(WIRE_HANDSHAKE), te.encode(JSON.stringify(x)))
  fail('encodeWire takes a frame or an accept/ready message')
}
export function decodeWire(b) {
  if (!(b instanceof Uint8Array) || b.length < 1) fail('empty wire message')
  if (b[0] === WIRE_FRAME) return { frame: b.subarray(1) }
  if (b[0] === WIRE_INVITE) return { sealedInvite: b }       // open with openInvite() / 用 openInvite() 打开
  // TAPI-27 group traffic rides the same rooms and buses: hand it back typed, for group.acceptEpoch() / group.open()
  // TAPI-27 群消息走同样的房间与总线：标明类型交回，交给 group.acceptEpoch() / group.open()
  if (b[0] === 0x04) return { groupEpoch: b }
  if (b[0] === 0x05) return { groupMessage: b }
  if (b[0] === WIRE_HANDSHAKE) {
    // Same parser rules as every other TapeAPI message: strict UTF-8, no duplicate or prototype keys (TAPI-21 §3.3)
    // 与其它 TapeAPI 消息同样的解析规则：严格 UTF-8，不允许重复键与原型键
    let msg; try { msg = safeParseJSON(new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(1)), { code: 'CHANNEL_INVALID' }) } catch { fail('handshake message is not UTF-8 JSON (strict parse: no duplicate or prototype keys)') }
    if (!msg || (msg.t !== 'accept' && msg.t !== 'ready')) fail('unknown handshake message')
    return { handshake: msg }
  }
  fail(`unknown wire type ${b[0]}`)
}
export const toBase64 = (b) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s) }
export const fromBase64 = (s) => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4) fail('not base64')
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

// ---------------------------------------------------------------- relay transport ----
// A client for a relay.tape-style TapeAPI service: `relaySend` posts a wire message to the peer's room,
// `relayRecv` long-polls this side's room. Every poll result arrives as a TAPI-21 envelope, so the relay's answers
// are signed; the frames inside are TAPI-26 ciphertext, so the relay's answers are also never trusted for content.
// A relay that replays, reorders or drops frames is caught by the channel's sequence check, not here.
// 中继服务的客户端：`relaySend` 把消息发到对端房间，`relayRecv` 长轮询本方房间。每次轮询结果都是 TAPI-21 签名信封；
// 里面的帧是 TAPI-26 密文，所以中继的回答在内容上也从不被信任。中继重放、重排、丢帧由通道的序号检查拦下，而不是这里。
const sleep = (ms, signal) => new Promise((r) => {
  const t = setTimeout(r, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true })
})
export function relayTransport({ api, svc, payer, inbound, outbound, waitMs = 20_000, retryMs = 1_000 }) {
  if (!api || typeof api.call !== 'function') fail('relayTransport needs a TapeAPI client (createTapeAPI)')
  for (const [n, r] of [['inbound', inbound], ['outbound', outbound]]) if (typeof r !== 'string' || !/^[0-9a-f]{64}$/.test(r)) fail(`${n} must be a room id`)
  let cursor = -1
  let epoch = null
  let generation = 0
  let controller = null
  // A priced relay still carries the handshake for free through `relayHandshake` (TAPI-26 §3.5): the responder
  // must send `accept` before it has any reason to have funded a channel toward the relay.
  // 收费中继仍通过 `relayHandshake` 免费承载握手：响应方必须先发 `accept`，那时它还没理由已经向中继充值。
  const hasFreeHandshake = () => (svc.manifest?.methods || []).some((m) => m.name === 'relayHandshake' && (m.priceBEM ?? '0') === '0')
  const send = async (wire) => {
    const handshake = wire instanceof Uint8Array && wire[0] === WIRE_HANDSHAKE
    const method = handshake && hasFreeHandshake() ? 'relayHandshake' : 'relaySend'
    const opts = method === 'relaySend' && payer ? { payer } : {}
    return (await api.call(svc, method, { room: outbound, frame: toBase64(wire) }, opts)).result
  }
  // One poll. Frames are handed over one by one: a malformed frame is skipped, never allowed to take the good
  // frames around it down with it (audit L-8). When the room was re-created the relay reports a new epoch and
  // we start that room from the beginning instead of silently skipping its first frames (audit H-1).
  // 一次轮询。帧逐个交出：格式错误的帧被跳过，绝不连累前后的好帧。房间被重建时中继会报告新的纪元，
  // 我们从头读这个房间，而不是悄悄跳过它最开始的那些帧。
  const poll = async (wait = waitMs, { signal } = {}) => {
    // `epoch` is always sent, `null` until the relay has named one (TAPI-26 §3.5 MUST; spec review SD-9). Behaviour is
    // unchanged: the cursor is -1 whenever epoch is still null. / `epoch` 总是发送，中继报出之前为 `null`；行为不变：
    // epoch 仍为 null 时游标必为 -1。
    const params = { room: inbound, after: cursor, waitMs: wait, epoch }
    const r = await api.call(svc, 'relayRecv', params, { timeoutMs: wait + 10_000, signal })
    const res = r.result || {}
    if (typeof res.epoch === 'string' && res.epoch !== epoch) { epoch = res.epoch; cursor = -1 }
    const out = []
    for (const f of Array.isArray(res.frames) ? res.frames : []) {
      if (!Number.isInteger(f?.i) || f.i <= cursor) continue
      cursor = f.i
      try { out.push(fromBase64(f.frame)) } catch { /* garbage from the relay: skip it, keep the rest / 跳过垃圾帧，保留其余 */ }
    }
    return out
  }
  return {
    send, poll,
    /**
     * Poll until stop(); hands every wire message to onWire in order. An error from onWire is reported and the
     * batch continues; an error from onError itself is swallowed, so a bad handler cannot kill the loop. stop()
     * aborts the poll in flight, and a later start() never leaves two loops running (audit L-1, L-8b, L-9).
     * 持续轮询直到 stop()，按顺序把每条消息交给 onWire。onWire 抛错会被报告、批次继续；onError 自身抛错会被吞掉，
     * 坏的处理器杀不死循环。stop() 会中止进行中的轮询，之后再 start() 也不会出现两个循环。
     */
    start(onWire, { onError } = {}) {
      const mine = ++generation
      controller?.abort()
      controller = new AbortController()
      const { signal } = controller
      const report = (e) => { try { onError?.(e) } catch { /* never let a handler kill the loop / 处理器不能杀死循环 */ } }
      ;(async () => {
        while (generation === mine) {
          const t0 = Date.now()
          let wires = []
          try { wires = await poll(waitMs, { signal }) }
          catch (e) { if (generation !== mine) break; report(e); await sleep(retryMs, signal); continue }
          for (const w of wires) {
            if (generation !== mine) break
            try { await onWire(w) } catch (e) { report(e) }
          }
          // A relay that answers empty at once (full, or not holding polls) must not turn this into a busy loop.
          // 立即返回空结果的中继（满了或不支持挂起）不能让这里变成忙循环。
          if (!wires.length && Date.now() - t0 < Math.min(waitMs, 1000)) await sleep(retryMs, signal)
        }
      })().catch(report)
    },
    stop() { generation++; controller?.abort(); controller = null },
    get cursor() { return cursor },
    get epoch() { return epoch },
  }
}

// ---------------------------------------------------------------- chain transport (TAPI-26 §3.7) ----
// The chain as the relay. Every wire message is a `ChannelBus.send(room, wire)` transaction (or several in one
// `sendMany`); every reader queries the room's `Wire` log. No operator, nothing to take down; latency is the block
// time and every post costs gas.
// 把链当作中继。每条线路消息是一笔 `ChannelBus.send(room, wire)` 交易（或用 `sendMany` 一笔发多条），
// 读取方查询房间的 `Wire` 日志。没有运营者、没有可下线的东西；延迟是出块时间，每次发送都付 gas。
//
// What becomes public FOREVER: the room id, the posting address, the time and the size of every frame. Content stays
// TAPI-26 ciphertext. Post from a fresh key per channel; how that key was funded is public too.
// 永久公开的：房间号、发送地址、每帧的时间与大小。内容仍是 TAPI-26 密文。每个通道用新的发送密钥；它的资金来源也公开。
export const CHANNELBUS_WIRE_TOPIC = '0x46fffab6f2033c7dc33390d2a1329b6809abdcb8baf711dc44a9144ccf4b1431' // keccak256("Wire(bytes32,bytes)")
export const CHANNELBUS_MAX_WIRE = MAX_FRAME_BYTES + 64   // = ChannelBus.MAX_WIRE: one frame plus framing and the AEAD tag / 一帧加封装与认证标签
export const CHANNELBUS_MAX_BATCH = 16                    // = ChannelBus.MAX_BATCH
const hexN = (n) => '0x' + n.toString(16)
// hostname only, never a keyed URL (M-13) / 只显示主机名，绝不显示带 key 的完整 URL
const describeNode = (url, i) => { try { return `node#${i}(${new URL(url).hostname})` } catch { return `node#${i}` } }
// Only facts about the chain are compared across nodes (TAPI-20 §3.2); decoration such as blockTimestamp is dropped.
// 跨节点只比较关于链的事实；blockTimestamp 之类的附加字段丢弃。
const logFacts = (logs) => {
  if (!Array.isArray(logs)) throw new Error('eth_getLogs did not return an array')
  // blockHash and transactionHash are facts too, and name a log exactly for the reorg dedup (arch B13); null when a
  // node leaves them out. / blockHash 与 transactionHash 也是事实，用于重组去重时精确指认一条日志；节点不给则为 null。
  const h = (x) => (typeof x === 'string' ? x.toLowerCase() : null)
  // `room` (topic 1, without 0x) is what busReader demultiplexes on (arch B8); null when a node leaves topics out.
  // `room`（第 2 个 topic，去掉 0x）是 busReader 分流的依据；节点不给 topics 时为 null。
  const room = (l) => (Array.isArray(l.topics) && typeof l.topics[1] === 'string' && /^0x[0-9a-fA-F]{64}$/.test(l.topics[1]) ? l.topics[1].slice(2).toLowerCase() : null)
  return logs.map((l) => ({ blockNumber: Number(BigInt(l.blockNumber)), logIndex: Number(BigInt(l.logIndex)), data: String(l.data).toLowerCase(), removed: l.removed === true, blockHash: h(l.blockHash), transactionHash: h(l.transactionHash), room: room(l) }))
}
const checkWire = (wire) => {
  if (!(wire instanceof Uint8Array) || wire.length === 0) fail('wire message must be non-empty bytes')
  if (wire.length > CHANNELBUS_MAX_WIRE) fail(`wire message of ${wire.length} bytes exceeds ${CHANNELBUS_MAX_WIRE}`)
}

/**
 * busTransport({ rpc, bus, inbound, outbound, sendTx, fromBlock, lookback, confirmations, overlap, pollMs, chunk, minChunk, budgetMs,
 *               verdictMs, startGraceMs, blockBodyLimit, warn })
 *   rpc      a multi-node client from createRpc (api.rpc): the head is read under TAPI-20 §3.2; logs are read per node
 *   bus      a ChannelBus contract address
 *   sendTx   async (tx) => txHash, supplied by the caller: the SDK holds no wallet. tx = { to, data, value, gas }
 *   fromBlock  first block to read (default: `lookback` blocks before the head); a later poll -- and a restart from a
 *              persisted `cursor` -- also re-reads the `overlap` blocks before it
 *   confirmations  blocks to stay behind the head (default 2); overlap: blocks re-read below the cursor (default 16)
 *   budgetMs  wall time each node may spend per poll (default 20 s): what a slow node has not read by then counts as
 *             unread -- the cursor holds there unless another node read it -- and paces no other node (review R4-4)
 *   verdictMs  how long a "serves no logs" answer must last before it is believed (default 5 min, review R5-1)
 *   startGraceMs  while the reader starts (the first 3 polls, at most this long; default 15 s), a node that has not
 *             served yet and failed only transiently is waited for (review R9-PE1, R10-2)
 *   blockBodyLimit  the answer size allowed for a whole block's logs or receipts (default 64 MiB; lower only in tests)
 * Reads always use explicit numeric ranges ending at the lowest head among the nodes, never a tag, so honest nodes
 * give identical answers. A range read twice (a reorg, a restart from an older block) is harmless: §3.4's strict
 * sequence check refuses anything already accepted -- the reason the channel is transport-agnostic.
 * 读取总是用显式的数字区间、以各节点中最低的链头为终点，从不用标签，因此诚实节点的回答一致。同一区间读两次（重组、
 * 从更早的区块重启）无害：§3.4 的严格序号检查会拒绝已接受的帧——这正是通道与传输无关的原因。
 *
 * Reorgs (arch B13). A peer's transaction dropped by a shallow reorg and re-included in a block this side already
 * read used to be skipped for ever (the cursor had moved past it). Now reads stay `confirmations` blocks behind the
 * head, and every poll re-reads the last `overlap` blocks below the cursor; a log already handed over -- the same
 * (blockHash or block number, logIndex, transaction, data) -- is not handed over again, and that memory only covers
 * the overlap window. Cost: no gas (reads are free) and no extra request (the overlap widens the range already being
 * read); latency grows by `confirmations` blocks, about 1 s on BSC at ~0.45 s a block. A reorg deeper than the
 * overlap can still lose a frame: the channel reports it as a gap.
 * 重组。对端交易被浅重组撤下、又被打包进本方已读过的区块时，以前会被永远跳过（游标已越过它）。现在读取落后链头
 * `confirmations` 个区块，每次轮询还会重读游标之下最近 `overlap` 个区块；已交出过的日志（同一 blockHash 或区块号、
 * logIndex、交易与数据）不再重复交出，这份记忆只覆盖重叠窗口。代价：不耗 gas（读取免费），也不多发请求（重叠只是把
 * 本来就要读的区间放宽）；延迟增加 `confirmations` 个区块，BSC 约 0.45 秒一块，约 1 秒。比重叠更深的重组仍可能丢帧：
 * 通道会把它报告为空洞。
 *
 * History (arch A4). Public nodes keep logs for a window only (publicnode: about 5,000 to 10,000 blocks depending on
 * the backend, ~40-75 min, measured 2026-09-24/25; 48 Club and 1RPC, the BUS_RPC_URLS set, at least 500,000). The first time
 * a node refuses a block as too old, a probe finds the oldest block it serves (`oldestServed`, `stats()`); blocks that
 * every node excuses and none served are skipped and `warn` (default console.warn) is told once per stretch -- before,
 * a cursor older than the window failed every poll for ever. No request is added while nothing is refused.
 * Hold, never skip (TAPI-26 §3.7; reviews R2-1, R3-1, R4). Each node is read on its own, and the cursor moves past a
 * block only when some node served it, or every node excuses it with a verdict known before this poll and said again
 * in it: "serves no logs" (a bsc-dataseed) or "older than my window". So the poll that learns a verdict holds the cursor
 * once, and a node that times out, rate limits or says anything unfamiliar holds it until it recovers. What nodes
 * served during a hold is kept for the next poll (a window sliding meanwhile cannot take it away), and `warn` is told
 * after 10 holds in a row. Several rooms on one bus: busReader (arch B8), the same reading code with one eth_getLogs
 * per node for all of them.
 * 历史窗口。公共节点只保留一段时间的日志（publicnode 视后端约 5,000 到 10,000 个区块、约 40 到 75 分钟，2026-09-24/25 实测；
 * BUS_RPC_URLS 里的 48 Club 与 1RPC 至少 500,000 个区块）。节点第一次以"太旧"拒绝某区块时，
 * 探测它提供的最早区块（`oldestServed`、`stats()`）；每个节点都豁免、没有节点提供的区块被跳过，并对每一段调用一次
 * `warn`（默认 console.warn）——以前，早于窗口的游标会让每次轮询永远失败。没有拒绝时不增加任何请求。
 * 宁可停住，绝不跳过。每个节点各自读取；只有当某节点提供了该区块，或每个节点都以本次轮询之前已知、且本次又说了一遍的结论
 * 豁免它（"不提供日志"，如 bsc-dataseed；或"早于我的窗口"）时，游标才越过该区块。因此得出结论的那次轮询让游标停一次；
 * 超时、限流或说了不认识的话的节点让游标一直停到它恢复。停住期间节点已提供的日志留给下一次轮询（期间滑动的窗口拿不走），
 * 连续停住 10 次后告知 `warn`。一条总线上多个房间：busReader，同一份读取代码，所有房间每节点只发一次 eth_getLogs。
 */
export function busTransport({ rpc, bus, inbound, outbound, sendTx, fromBlock, lookback = 600, confirmations = 2, overlap = 16, pollMs = 1500, chunk = 1000, minChunk = 40, budgetMs = 20_000, verdictMs = VERDICT_MS, startGraceMs = START_GRACE_MS, blockBodyLimit = BLOCK_BODY_LIMIT, warn }) {
  checkBusRpc(rpc, bus)
  for (const [n, r] of [['inbound', inbound], ['outbound', outbound]]) if (typeof r !== 'string' || !/^[0-9a-f]{64}$/.test(r)) fail(`${n} must be a room id`)
  const scanner = busScanner({ rpc, bus, fromBlock, lookback, confirmations, overlap, chunk, minChunk, budgetMs, verdictMs, startGraceMs, blockBodyLimit, warn })

  // Gas: a fixed cost per transaction and per event, then 16 per calldata byte and 8 per logged byte; no estimate
  // round trip. / gas：每笔交易、每个事件的固定开销，加每字节 calldata 16、每字节日志 8；不需要估算往返。
  const tx = (wire) => {
    checkWire(wire)
    return { to: bus, data: encodeCall('send', ['0x' + outbound, wire]), value: '0x0', gas: hexN(50_000 + 40 * wire.length) }
  }
  // Several wire messages to the outbound room in ONE transaction (for example ready + the first frame): the
  // per-transaction base cost is paid once. / 一笔交易发多条（例如 ready 与第一帧），基础费用只付一次。
  const txMany = (wires) => {
    if (!Array.isArray(wires) || wires.length === 0 || wires.length > CHANNELBUS_MAX_BATCH) fail(`sendMany takes 1..${CHANNELBUS_MAX_BATCH} wire messages`)
    const parts = []
    let total = 0
    for (const w of wires) { checkWire(w); parts.push(Uint8Array.of(w.length >> 8, w.length & 0xff), w); total += 2 + w.length }
    const packed = new Uint8Array(total)
    let at = 0
    for (const p of parts) { packed.set(p, at); at += p.length }
    return { to: bus, data: encodeCall('sendMany', ['0x' + outbound, packed]), value: '0x0', gas: hexN(40_000 + wires.length * 12_000 + 48 * total) }
  }
  const needWallet = () => { if (typeof sendTx !== 'function') fail('busTransport.send needs sendTx: the SDK holds no wallet') }
  const send = async (wire) => { needWallet(); return sendTx(tx(wire)) }
  const sendMany = async (wires) => { needWallet(); return sendTx(txMany(wires)) }
  const poll = async () => (await scanner.scan([inbound])).map((x) => x.wire)
  const loop = pollLoop(poll, pollMs)
  return {
    send, sendMany, poll, tx, txMany,
    start(onWire, { onError } = {}) { loop.start(onWire, onError) },
    stop: loop.stop,
    get cursor() { return scanner.cursor },
    /** Lowest block a node was found to serve logs from, once one refused an older block (arch A4); else null / 节点可提供日志的最早区块 */
    get oldestServed() { return scanner.oldestServed },
    stats: scanner.stats,
  }
}

/**
 * busReader({ rpc, bus, rooms, fromBlock, lookback, confirmations, overlap, pollMs, chunk, minChunk, budgetMs, verdictMs,
 *            startGraceMs, blockBodyLimit, warn })  (arch B8; the options as for busTransport)
 * One poll loop for many rooms on one bus: each poll is one head read and, per `chunk` blocks, ONE eth_getLogs per
 * node whose second topic is an OR over every room (`topics: [WIRE, [room1, room2, …]]`); logs are handed to the
 * handler of their room. Range halving, the union across nodes, `confirmations`, `overlap`, reorg dedup and the
 * history probe are busTransport's, the same code. `rooms` is an array of room ids or an object { room: handler }.
 *   add(room, handler?, { fromBlock })  a room added once the first poll has started has its past read once, on the next poll,
 *                                       from `fromBlock` (default: `lookback` blocks before the head) to the cursor. An
 *                                       explicit `fromBlock` is honoured for a room already there too. A room removed and
 *                                       added again -- even while a poll is in flight -- is a new room: its past is read
 *                                       again, so frames may come twice (§3.4's sequence check refuses them; a past never
 *                                       read would be lost) (review R4-7)
 *   remove(room)                        its frames are dropped from the next poll on
 *   poll() -> [{ room, wire }]          one poll, no dispatch
 *   start(onWire, { onError })          dispatch to each room's handler, or to onWire(wire, { room }) when it has none
 * Reading only: to post, use busTransport(…).send / .tx for the room (sending needs no poll loop).
 * 一条总线上多个房间共用一个轮询循环：每次轮询读一次链头，并对每 `chunk` 个区块每个节点只发一次 eth_getLogs，第二个 topic
 * 是全部房间的"或"；日志按房间交给各自的处理器。区间拆分、跨节点并集、确认数、重叠、重组去重与历史探测都与 busTransport
 * 相同（同一份代码）。首次轮询之后才加入的房间，在下一次轮询时补读一次过去的区块。只负责读取；发送用 busTransport 的 send / tx。
 */
export function busReader({ rpc, bus, rooms = [], fromBlock, lookback = 600, confirmations = 2, overlap = 16, pollMs = 1500, chunk = 1000, minChunk = 40, budgetMs = 20_000, verdictMs = VERDICT_MS, startGraceMs = START_GRACE_MS, blockBodyLimit = BLOCK_BODY_LIMIT, warn } = {}) {
  checkBusRpc(rpc, bus)
  const scanner = busScanner({ rpc, bus, fromBlock, lookback, confirmations, overlap, chunk, minChunk, budgetMs, verdictMs, startGraceMs, blockBodyLimit, warn })
  const handlers = new Map()   // room -> handler | null
  // room -> { from }: the first block to catch up from (null: lookback). A new object per request, so a poll in flight
  // updates only the request it started with (compare-and-set, review R4-7). / 待补读的房间 -> { from }：每次请求一个新对象，
  // 在途的轮询只更新它开始时的那个请求（比较后设置）。
  const behind = new Map()
  let polled = false           // rooms added before the first poll starts are read from where it starts / 首次轮询开始前加入的房间从其起点读
  const checkRoom = (r) => { if (typeof r !== 'string' || !/^[0-9a-f]{64}$/.test(r)) fail('room must be a room id (64 lowercase hex)') }
  const add = (room, handler = null, { fromBlock: from } = {}) => {
    checkRoom(room)
    if (handler !== null && typeof handler !== 'function') fail('a room handler must be a function')
    if (from !== undefined && !(Number.isInteger(from) && from >= 0)) fail('fromBlock must be a block number')
    const known = handlers.has(room)
    handlers.set(room, handler)
    // An explicit fromBlock always counts; otherwise a new room (or one removed and added again, in flight or not)
    // catches up. A duplicate hand-over is harmless under §3.4; a past never read is lost (review R4-7).
    // 显式 fromBlock 总是生效；否则新房间（或移除后又加入的房间，不论是否在途）补读。重复交出在 §3.4 下无害；没读过的过去就丢了。
    if (from !== undefined) behind.set(room, { from })
    else if (!known && polled) behind.set(room, { from: null })
  }
  const remove = (room) => { handlers.delete(room); behind.delete(room) }
  for (const [r, h] of Array.isArray(rooms) ? rooms.map((r) => [r, null]) : Object.entries(rooms)) add(r, h)
  const poll = async () => {
    const list = [...handlers.keys()]
    if (!list.length) return []
    // Set before the first await: a room added while this poll is in flight is not in `list`, so it must catch up
    // on the next one (review R2-4). / 在第一个 await 之前置位：本次轮询在途时加入的房间不在 `list` 里，须在下次补读。
    polled = true
    const catchUp = new Map([...behind].filter(([r]) => handlers.has(r)))
    // `resume`: the catch-up stopped short (the head moved back below where the main read starts, review R2-4; or it
    // held); go on from there next poll. Only the request this poll started with is touched: an add() or remove() made
    // meanwhile stands (review R4-7). / 补读没读完（链头回退，或停住了）；下次从 resume 继续。只动本次轮询开始时的那个请求：
    // 期间的 add() 或 remove() 保持不变。
    const caughtUp = (rs, resume) => {
      for (const r of rs) {
        if (behind.get(r) !== catchUp.get(r)) continue
        if (resume === null) behind.delete(r); else behind.set(r, { from: resume })
      }
    }
    const got = await scanner.scan(list, { behind: [...catchUp].map(([r, t]) => [r, t.from]), caughtUp })
    // A room removed while this poll was in flight: its items are not handed over, and not remembered as handed over,
    // so adding the room again reads them again (review R6-2). / 本次轮询在途时被移除的房间：其项不交出、也不记为已交出，
    // 于是再次加入该房间时会重新读到。
    const out = []
    for (const { room, wire, key } of got) { if (handlers.has(room)) out.push({ room, wire }); else scanner.forget(key) }
    return out
  }
  const loop = pollLoop(poll, pollMs)
  return {
    add, remove, poll,
    start(onWire, { onError } = {}) {
      loop.start(async ({ room, wire }) => {
        const h = handlers.get(room) ?? onWire
        if (typeof h === 'function') await h(wire, { room })
      }, onError)
    },
    stop: loop.stop,
    get rooms() { return [...handlers.keys()] },
    // Rooms still catching up (added late, or held on the way), each with the block its catch-up goes on from (null: not
    // started yet, it begins `lookback` blocks back). Frames of such a room from there up are still to come.
    // 仍在补读的房间（后加入，或补读途中停住），以及补读继续的区块（null：尚未开始，从 lookback 处起）。这些房间从那里往上的帧还会来。
    get catchingUp() { return Object.fromEntries([...behind].filter(([r]) => handlers.has(r)).map(([r, t]) => [r, t.from])) },
    get cursor() { return scanner.cursor },
    get oldestServed() { return scanner.oldestServed },
    stats: scanner.stats,
  }
}

function checkBusRpc(rpc, bus) {
  if (!rpc || typeof rpc.call !== 'function' || typeof rpc.blockNumber !== 'function') fail('busTransport needs a multi-node rpc client (createRpc / api.rpc)')
  if (!isAddress(bus)) fail('bus must be a ChannelBus contract address')
}

// Poll until stop(); hands every item to onItem in order. An error from onItem is reported and the batch continues;
// an error from onError itself is swallowed, so a bad handler cannot kill the loop.
// 持续轮询直到 stop()，按顺序交出每一项。onItem 抛错会被报告、批次继续；onError 自身抛错会被吞掉。
function pollLoop(poll, pollMs) {
  let generation = 0
  let controller = null
  return {
    start(onItem, onError) {
      const mine = ++generation
      controller?.abort()
      controller = new AbortController()
      const { signal } = controller
      const report = (e) => { try { onError?.(e) } catch { /* never let a handler kill the loop / 处理器不能杀死循环 */ } }
      ;(async () => {
        while (generation === mine) {
          let items = []
          try { items = await poll() } catch (e) { if (generation !== mine) break; report(e) }
          for (const x of items) {
            if (generation !== mine) break
            try { await onItem(x) } catch (e) { report(e) }
          }
          await sleep(pollMs, signal)
        }
      })().catch(report)
    },
    stop() { generation++; controller?.abort(); controller = null },
  }
}

// ------------------------------------------------------------ the bus scanner (review R4) ----
// Shape (review R4): each node is walked on its own (`walk`: what it covered, what it served, why it stopped), and one
// pure predicate (`_busMerge`) decides how far the cursor may move. Nothing a node says in one poll can release a hold in
// that poll: verdicts count only once known before the poll and said again in it (TAPI-26 §3.7 "Hold, never skip").
// 结构：每个节点各自读取（`walk`：覆盖了什么、给了什么、为何停下），再由一个纯函数（`_busMerge`）决定游标能走多远。
// 节点在某次轮询里说的任何话都不能在同一次轮询里解除停住：结论须在本次轮询之前已知、且本次又说了一遍才算数。

// Every test below reads ONLY what the node said (`refusalOf`), never the whole error message: that one names the node's
// host, and a host called "archive…" must not turn a timeout into "too old" (review R4-3). A node that could not be
// reached (timeout, HTTP error, bad body) said nothing: it is never too old, too wide, or out of logs.
// 下面的判断只看节点的原话（`refusalOf`），绝不看整条错误消息：那里有节点的主机名，名叫 "archive…" 的主机不能把超时变成
// "太旧"。连不上的节点（超时、HTTP 错误、坏响应体）什么也没说：绝不算太旧、太宽或不提供日志。
// Older than the history the node keeps: publicnode answers -32602 "Archive requests require a personal token" (as HTTP 403,
// recorded 2026-09-25), and -32701 "History has been pruned for this block"; geth with history expiry says "pruned history
// unavailable". / 早于节点保留的历史：publicnode 答 -32602（HTTP 403）或 -32701；geth 历史过期时答 "pruned history unavailable"。
const isHistoryLimit = (m) => /archive|history|pruned|too old|earliest available|oldest available/i.test(m)
// A rate limit is "not now", never "too wide": halving the span for it would stay for good. / 限流是"现在不行"，不是"太宽"。
const isRateLimit = (m) => /rate.?limit|quota|too many requests|throttl|per second|credits/i.test(m)
// A backend behind the head is "not now" too: publicnode answers -32602 "block range extends beyond current head block:
// requested N, head M" (recorded 2026-09-26), which says "range" and used to halve the span for good.
// 后端落后于链头也是"现在不行"：publicnode 的原话里有 "range"，过去会让跨度被永久减半。
const isBehindHead = (m) => /beyond (the )?current head|header not found|unknown block/i.test(m)
const isRangeLimit = (m) => !isRateLimit(m) && !isBehindHead(m) && /range|limit|exceed|too many|too large|more than/i.test(m)
// A cap on how many logs one answer holds, not on how many blocks it spans: geth/Infura "query returned more than 10000
// results", Alchemy "Log response size exceeded", Erigon "too many logs". Anyone can fill a block with frames, so this
// is answered by splitting that stretch, never by narrowing the node for good (review R6-3).
// 限制的是一个回答里的日志条数，而不是区间跨多少区块。任何人都能用帧塞满一个区块，所以对它只拆分那一段，绝不永久收窄节点。
// publicnode (a node often configured, though not in BUS_RPC_URLS) says -32602 "query exceeds max results 20000, retry with the range A-B" (HTTP 200,
// recorded 2026-09-25 in fixtures/bsc-getlogs-answers.json, review R7-1): the wording that matters most.
// publicnode（常被配置的节点，但不在 BUS_RPC_URLS 里）的原话，已录制：最要紧的一种措辞。
const isResultCap = (m) => /exceeds? max(imum)? results|max results \d+|retry with the range|more than \d+ (results|logs)|too many (results|logs)|response size|log response/i.test(m)
// What a node said when it refused an eth_getLogs, or null when it could not be reached. rpc.js puts node-limit answers
// (and JSON-RPC errors sent with an HTTP error status, review R4-1) on RPC_UNAVAILABLE as `refusals`; any other JSON-RPC
// error is RPC_ERROR, whose message is the node's after the method name.
// 节点拒绝 eth_getLogs 时说了什么；连不上时为 null。rpc.js 把节点限制类回答（以及随 HTTP 错误状态码发来的 JSON-RPC 错误）
// 放在 RPC_UNAVAILABLE 的 `refusals` 里；其它 JSON-RPC 错误是 RPC_ERROR，方法名之后就是节点的原话。
const refusalOf = (e) => (e?.code === 'RPC_ERROR' ? { code: Number(e.rpcCode), message: String(e.message ?? '').replace(/^eth_getLogs: /, '') } : (e?.refusals?.[0] ?? null))
// "This node serves no logs at all" is an ALLOWLIST (review R3-1): -32601 (no such method), exactly "limit exceeded"
// (bsc-dataseed.bnbchain.org and bsc-dataseed1.defibit.io answer every eth_getLogs, even one block, with -32005 "limit
// exceeded": recorded 2026-09-25), or a message saying the method is not supported or disabled. Anything else -- "header
// not found", "unknown block", rate limits, wordings not seen yet -- says nothing about the node.
// "该节点根本不提供日志"是白名单：-32601、原话 "limit exceeded"（两个 dataseed 节点对任何 eth_getLogs 都这样答），或说该方法
// 不支持 / 已禁用。其它一切回答都不说明节点本身。
const neverServes = (r) => r.code === -32601 || /^\s*limit exceeded\s*$/i.test(r.message) || /not supported|unsupported|disabled|does not support/i.test(r.message)
// `big`: the answer holds too many logs -- more than this client accepts (rpc.js sets `tooLarge`) or than the node returns
// at once (a result cap) -- whatever the span (review R6-3). / `big`：回答里日志太多——超过本客户端接受的大小，或节点单次返回的条数。
const kindOf = (e) => {
  const r = refusalOf(e), big = e?.tooLarge === true
  return r ? { refusal: r, history: isHistoryLimit(r.message), range: isRangeLimit(r.message), noLogs: neverServes(r), big: big || isResultCap(r.message) } : { refusal: null, history: false, range: false, noLogs: false, big }
}
export { kindOf as _busKindOf }   // for tests: how the scanner reads a failed eth_getLogs / 供测试：扫描器如何理解失败的 eth_getLogs
// Holds in a row after which `warn` is told the cursor is stuck (review R3-7) / 连续停住多少次后通过 `warn` 告知游标卡住
const HOLD_WARN = 10
// A whole block's receipts: BSC's 70 M gas at 8 gas a log byte is under 9 MB of log data, twice that as hex, plus the
// rest of each receipt. / 整个区块的回执：7000 万 gas、每字节日志 8 gas，日志数据不到 9 MB，十六进制翻倍，另加回执其余部分。
const BLOCK_BODY_LIMIT = 64 * 1024 * 1024
const SPLIT_READS = 48
// Log data (hex characters) above which a block is remembered as full and read alone from then on / 超过此日志数据量的区块记为塞满
const HEAVY_BLOCK = 1 << 20
const SWEEP_PER_NODE = 4
const SWEEP_MAX = 32   // blocks a node without logs reads through receipts per walk (R9-F2) / 不提供日志的节点每次读取至多补读的区块数
// How long after the first poll (and for how many polls) a node that has not served yet still holds blocks it failed on
// transiently (R9-PE1, R10-2): a dead node holds a start this long. / 第一次轮询后多久之内，还没提供过的节点临时失败的区块仍要等它：死节点会让启动停这么久。
const START_GRACE_MS = 15_000
const START_GRACE_POLLS = 3
// Polls without a served read before a node's "serves no logs" answer is believed (review R4-6): a node that served
// lately and now says "limit exceeded" is rate limiting, not a dataseed. / 最近提供过读取的节点答 "limit exceeded" 是限流，
// 不是 dataseed：没有提供读取满这么多次轮询，才相信它"不提供日志"。
const SERVED_DECAY = 20
// How long a node must keep saying "no logs at all" before that releases a hold (review R5-1). A dataseed says it for
// ever, so waiting costs it nothing; an archive node rate limited with the same generic -32005 wording at start-up
// usually recovers inside this, and is then never taken for a dataseed. / 节点须持续说"根本不提供日志"这么久，才能解除停住。
// dataseed 永远这么说，等待对它没有代价；启动时被限流、用同样 -32005 措辞回答的归档节点通常在这段时间内恢复，就不会被当成 dataseed。
export const VERDICT_MS = 5 * 60 * 1000
// Logs kept per node and read across holds (review R4-2) / 停住期间每节点每个读取保留的日志上限
const STASH_MAX = 20_000
const OUT_OF_TIME = new Error('out of time for this poll')

// Intervals of block numbers [a, b] / 区块区间 [a, b]
const unite = (xs) => {
  const out = []
  for (const [a, b] of xs.filter(([a, b]) => a <= b).sort((p, q) => p[0] - q[0])) { const t = out.at(-1); if (t && a <= t[1] + 1) t[1] = Math.max(t[1], b); else out.push([a, b]) }
  return out
}
const inside = (cov, n) => cov.some(([a, b]) => a <= n && n <= b)
const clip = (cov, lo, hi) => cov.map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)]).filter(([a, b]) => a <= b)
const intersect = (x, y) => unite(x.flatMap(([a, b]) => clip(y, a, b)))

/**
 * _busMerge(nodes, lo, hi) -> { advanceTo, gaps, hold, pending, stuck }   (pure; review R4)
 *   nodes[i] = { cov: [[a, b], …] blocks node i answered, noLogs, floor, mustCover }: `noLogs` true and `floor` (the oldest
 *   block it serves) set ONLY for verdicts known before this poll and said again in it. `mustCover`: the node served logs
 *   lately, so a block it did not answer (out of time, a transient failure) may hold something only it has (review R5-3).
 * A block is done when some node answered it (one honest node is enough: the union has its logs) AND every mustCover
 * node answered or excuses it -- a fast node answering [] cannot outrun a slow honest one -- or when every node excuses
 * it (serves no logs, or it lies below the node's floor): then it is a gap. When every node serves no logs there is no
 * reader, and it holds (review R5-8). The cursor moves to the first block that is not done (`advanceTo`); `pending` are
 * the nodes that keep it from being done, `stuck` the run of blocks held from it.
 * 纯函数。某区块在有节点回答过它时完成（一个诚实节点就够，并集里有它的日志），或在每个节点都豁免它时完成（不提供日志，或在
 * 该节点下限之下）：此时它是空洞。游标移到第一个未完成的区块（`advanceTo`）；`pending` 是不豁免它的节点，`stuck` 是从它起停住的一段。
 */
export function _busMerge(nodes, lo, hi) {
  if (hi < lo) return { advanceTo: lo, gaps: [], hold: false, pending: [], stuck: null }
  // Every node known to serve no logs: there is no reader at all. That is a configuration to fix, not a stretch to
  // skip, so the pure rule says so itself (review R5-8). / 每个节点都已知不提供日志：根本没有可读的节点。这是要改的配置，
  // 不是可以跳过的一段，由纯函数自己给出结论。
  if (nodes.length && nodes.every((v) => v.noLogs === true)) return { advanceTo: lo, gaps: [], hold: true, pending: nodes.map((_, i) => i), stuck: [lo, hi], none: true }
  // Coverage and verdicts change only at these blocks: evaluate one block per segment. / 覆盖与结论只在这些区块处变化：每段取一个区块判断。
  const cuts = new Set([lo, hi + 1])
  const cut = (n) => { if (n > lo && n <= hi) cuts.add(n) }
  for (const v of nodes) { for (const [a, b] of [...v.cov, ...(v.cannot || [])]) { cut(a); cut(b + 1) } if (v.floor != null) cut(v.floor); if (v.softFloor != null) cut(v.softFloor) }
  const pts = [...cuts].sort((a, b) => a - b)
  const answered = (n) => nodes.some((v) => inside(v.cov, n))
  const excused = (v, n) => v.noLogs === true || (v.floor != null && n < v.floor)
  // Who keeps block n from being done: when some node answered it, the lately-serving nodes that neither answered nor
  // excuse it; otherwise every node that does not excuse it. / 谁使区块 n 未完成：有节点答过时，是既没答也不豁免的"最近提供过"
  // 的节点；否则是所有不豁免它的节点。
  // A block a mustCover node refused as too old THIS poll (`softFloor`), or said it cannot give at all (`cannot`: its
  // receipts refused, R8-1), is not one only it has: it said it has not got it.
  // 本次被 mustCover 节点以"太旧"拒绝的区块（`softFloor` 之下），或它说根本给不了的区块（`cannot`），不可能只有它有：它自己说了没有。
  const blockers = (n) => (answered(n)
    ? nodes.flatMap((v, i) => (v.mustCover && !inside(v.cov, n) && !excused(v, n) && !(v.softFloor != null && n < v.softFloor) && !inside(v.cannot || [], n) ? [i] : []))
    : nodes.flatMap((v, i) => (excused(v, n) ? [] : [i])))
  const gaps = []
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k], b = pts[k + 1] - 1
    const pending = blockers(a)
    if (answered(a) && !pending.length) continue
    if (pending.length || !nodes.length) {
      let to = b
      for (let j = k + 1; j + 1 < pts.length && (blockers(pts[j]).length || !nodes.length); j++) to = pts[j + 1] - 1
      return { advanceTo: a, gaps, hold: true, pending, stuck: [a, to] }
    }
    const g = gaps.at(-1)
    if (g && g[1] === a - 1) g[1] = b; else gaps.push([a, b])
  }
  return { advanceTo: hi + 1, gaps, hold: false, pending: [], stuck: null }
}

// The reading half of busTransport and busReader: one cursor, one reorg memory, per-node state, for any set of rooms.
// busTransport 与 busReader 的读取部分：一个游标、一份重组记忆、每节点的状态，适用于任意一组房间。
function busScanner({ rpc, bus, fromBlock, lookback, confirmations, overlap, chunk, minChunk, budgetMs, verdictMs = VERDICT_MS, startGraceMs = START_GRACE_MS, blockBodyLimit = BLOCK_BODY_LIMIT, warn }) {
  if (fromBlock !== undefined && !(Number.isInteger(fromBlock) && fromBlock >= 0)) fail('fromBlock must be a block number')
  if (!(Number.isInteger(confirmations) && confirmations >= 0)) fail('confirmations must be a non-negative integer')
  if (!(Number.isInteger(lookback) && lookback >= 0)) fail('lookback must be a non-negative integer')
  if (!(Number.isInteger(overlap) && overlap >= 0)) fail('overlap must be a non-negative integer')
  if (!(Number.isInteger(minChunk) && minChunk >= 1 && Number.isInteger(chunk) && chunk >= minChunk)) fail('chunk and minChunk must be integers with chunk >= minChunk >= 1')
  if (!(typeof budgetMs === 'number' && budgetMs > 0)) fail('budgetMs must be a positive number of milliseconds')
  if (!(typeof verdictMs === 'number' && verdictMs >= 0)) fail('verdictMs must be a non-negative number of milliseconds')
  if (!(typeof startGraceMs === 'number' && startGraceMs >= 0)) fail('startGraceMs must be a non-negative number of milliseconds')
  if (!(Number.isInteger(blockBodyLimit) && blockBodyLimit > 0)) fail('blockBodyLimit must be a positive number of bytes')
  if (warn !== undefined && typeof warn !== 'function') fail('warn must be a function')
  let next = fromBlock ?? null          // the next block to read / 下一个要读的区块
  let started = false                   // the cursor has moved once: gaps below it were reported / 游标动过：其下的空洞已报告过
  let oldestServed = null
  let poll = 0                          // polls started; verdicts carry the poll that learnt them / 已开始的轮询数；结论带着得出它的轮询号
  // Logs handed over whose block is still inside the overlap window: key -> block number (arch B13)
  // 已交出、且所在区块仍在重叠窗口内的日志：键 -> 区块号
  const delivered = new Map()
  // The room is part of a log's identity (arch B8): a node that returns an honest log under another room's topic adds a
  // second log, delivered to that room as junk, instead of replacing the honest one. / 房间是日志身份的一部分：节点把诚实日志
  // 挂到别的房间下，只会多出一条（作为垃圾交给那个房间），而不会顶替诚实的那条。
  const logKey = (l) => `${l.blockHash ?? l.blockNumber}:${l.logIndex}:${l.room ?? ''}:${l.transactionHash ?? ''}:${toHex(sha256(te.encode(String(l.data).toLowerCase())))}`
  // Frames authenticate themselves (§3.4), so one honest node is enough: ask every node, each on its own, and take the
  // UNION. A node that lies can only add junk (refused) or omit frames (a gap, which another node fills).
  // 帧自带认证，一个诚实节点就够：每个节点各自读取，取并集。撒谎的节点只能塞垃圾（被拒）或漏掉帧（由其它节点补上）。
  // `whole`: the same node with room for a whole block's receipts, for a block too full for eth_getLogs (review R6-3)
  // `whole`：同一节点、可容纳整个区块的回执，用于 eth_getLogs 读不下的区块
  const nodes = typeof rpc.single === 'function'
    ? rpc.urls.map((u, i) => ({ c: rpc.single(u), whole: rpc.single(u, { bodyLimit: blockBodyLimit }), name: describeNode(u, i) }))
    : [{ c: rpc, whole: rpc, name: 'node#0' }]
  // Per node, kept across polls / 每节点、跨轮询保存：
  //   span    the widest range it accepts, halved when it refuses one as too wide (1rpc.io: 50) (review M-1) / 它接受的最宽区间
  //   floor   { at, poll }: the oldest block it serves logs for, and the poll that learnt it (arch A4) / 可提供日志的最早区块及得知它的轮询
  //   noLogs  the poll that learnt it serves no logs at all (a bsc-dataseed), or null (review R2-1) / 得知它根本不提供日志的轮询
  //   served  the last poll it served a read in, or null (review R4-6) / 它最近一次提供读取的轮询
  //   full    blocks it could not answer with eth_getLogs (too many logs), read through their receipts from then on (R7-4)
  //           它无法用 eth_getLogs 回答的区块（日志太多），此后直接读回执
  const st = nodes.map(() => ({ span: chunk, floor: null, noLogs: null, noLogsAt: 0, served: null, outPoll: 0, outOfTime: 0, gallop: null, full: new Set(), heavy: new Set(), cant: new Set(), noReceipts: null, abandoned: false }))
  // Per read (the main read, a late room's catch-up) and node: what it answered for blocks the cursor has not passed
  // (review R4-2). A hold keeps them, so a window that slides before the next poll cannot take them away.
  // 每个读取（主读取、后加入房间的补读）、每个节点：它对游标尚未越过的区块的回答。停住时保留，下次轮询前窗口滑走也拿不走。
  // Kept PER ROOM (review R5-2): a room added or removed during a hold leaves what the other rooms were served in place.
  // 按房间保存：停住期间增删房间，不影响其它房间已得到的部分。
  const stash = new Map()               // room -> [{ cov, logs }] by node / 按节点
  const holds = { n: 0 }
  let startedAt = null                  // when the first poll began (R9-PE1) / 第一次轮询开始的时间
  const passedOn = new Set()            // blocks already said to be passed on other nodes' word (R8-C1) / 已提醒过的区块                // polls in a row that held (review R3-7) / 连续停住的轮询次数
  const filterOf = (topics, x, y) => ({ address: bus, topics, fromBlock: hexN(x), toBlock: hexN(y) })
  const get = async (i, topics, x, y) => {
    const logs = await nodes[i].c.call('eth_getLogs', [filterOf(topics, x, y)], { project: logFacts })
    st[i].served = poll; st[i].noLogs = null; st[i].noLogsAt = 0
    // A log outside the range asked for is a lie, dropped before any bookkeeping (review R4-5) / 所问区间之外的日志是谎言，记账前丢弃
    return logs.filter((l) => !l.removed && l.blockNumber >= x && l.blockNumber <= y)
  }
  // One block whose logs no eth_getLogs answer can hold (a node's result cap, or over RPC_BODY_LIMIT): its receipts, whose
  // logs are filtered here exactly as the node would have (address, topic 0, the rooms) (review R6-3). One request.
  // eth_getLogs 装不下日志的单个区块：读它的回执，在这里按节点本会用的条件（地址、topic 0、房间）过滤。一个请求。
  // A read with room for a whole block. No real BSC block comes near BLOCK_BODY_LIMIT, so an answer over it is a broken
  // or hostile node: its `whole` client is not used again this poll, which bounds what it can make a reader download
  // (review R9-F1). / 给足整个区块空间的读取。真实的 BSC 区块远到不了上限，超过它的回答来自出故障或恶意的节点：本轮不再用它的
  // `whole` 客户端，从而限制它能让读取方下载的量。
  // Only a single block over the limit is a lie: a range of several stuffed blocks can pass 64 MiB honestly, and marking
  // the node bad for it left every stuffed block unreadable until it slid out of the window (review R10-1).
  // 只有单个区块超限才是说谎：几个塞满的区块合起来可以诚实地超过 64 MiB，为此停用节点会让每个塞满区块都读不了，直到滑出窗口。
  const wholeCall = async (i, method, params, o, single = true) => {
    if (st[i].wholeBad === poll) throw new TapeAPIError('RPC_UNAVAILABLE', `${nodes[i].name} answered over ${blockBodyLimit} bytes this poll`, { tooLarge: true })
    try { return await nodes[i].whole.call(method, params, o) } catch (e) { if (e?.tooLarge && single) st[i].wholeBad = poll; throw e }
  }
  // Log data (hex characters) above which a block is remembered as full: half the reader's bodyLimit, at most HEAVY_BLOCK
  // 超过此日志数据量的区块记为塞满：读取方 bodyLimit 的一半，至多 HEAVY_BLOCK
  const heavy = Math.min(HEAVY_BLOCK, Math.floor((nodes[0]?.c?.bodyLimit ?? RPC_BODY_LIMIT) / 2))
  const getBlock = async (i, topics, b) => {
    // First the block's logs alone, with room for a whole block: an answer over OUR bodyLimit is not the node's limit, and
    // a node without receipts can still give it (found by the randomised test, bus-fuzz: a block over bodyLimit beside
    // nodes without receipts held for ever). Only a node's own cap on results sends the read to the receipts.
    // 先单独读该区块的日志、并给足整个区块的大小：超过的是我们自己的 bodyLimit 而不是节点的限制，没有回执的节点也能给。
    // 只有节点自己的结果条数上限才转去读回执。（随机测试发现：超过 bodyLimit 的区块旁边都是没有回执的节点时会永远停住。）
    try {
      const logs = (await wholeCall(i, 'eth_getLogs', [filterOf(topics, b, b)], { project: logFacts })).filter((l) => !l.removed && l.blockNumber === b)
      st[i].served = poll; st[i].noLogs = null; st[i].noLogsAt = 0
      return { logs, heavy: logs.reduce((t, l) => t + l.data.length, 0) > heavy }
    } catch (e) { if (!kindOf(e).big) throw e }
    const logs = await receiptsOf(i, topics, b)
    st[i].served = poll; st[i].noLogs = null; st[i].noLogsAt = 0
    return { logs, heavy: true }   // its logs would not fit one eth_getLogs answer / 一个 eth_getLogs 回答装不下
  }
  // The rooms' logs of block b from node i's receipts, filtered here as eth_getLogs would (address, topic 0, the rooms).
  // 从节点 i 的回执里取区块 b 中这些房间的日志，按 eth_getLogs 的条件（地址、topic 0、房间）在这里过滤。
  const receiptsOf = async (i, topics, b) => {
    const receipts = await wholeCall(i, 'eth_getBlockReceipts', [hexN(b)])
    if (!Array.isArray(receipts)) throw new Error('eth_getBlockReceipts did not return an array')
    const want = new Set((Array.isArray(topics[1]) ? topics[1] : [topics[1]]).map((t) => String(t).toLowerCase()))
    const mine = receipts.flatMap((r) => (Array.isArray(r?.logs) ? r.logs : [])).filter((l) => String(l?.address).toLowerCase() === bus.toLowerCase()
      && Array.isArray(l.topics) && String(l.topics[0]).toLowerCase() === topics[0].toLowerCase() && want.has(String(l.topics[1]).toLowerCase()))
    return logFacts(mine).filter((l) => !l.removed && l.blockNumber === b)
  }

  // walk(i, topics, lo, hi, deadline) -> { cov, logs, floor, noLogs, end }: read [lo, hi] from node i alone, independent of
  // the other nodes, until done, until it fails, or until `deadline` (review R4-4: a slow node paces nobody; what it did not
  // cover in time is simply not covered, and the cursor holds there if no one else has it).
  //   floor   its floor, when known before this poll AND re-confirmed now (a read below it refused as too old again)
  //   noLogs  true when it was known before this poll to serve no logs AND says so again now
  // A history refusal is answered by ONE probe per walk (single-block bisection between the refused block and `hi`) and one
  // chase (range reads galloping forward, then bisecting what they skipped): O(log chunk) requests whatever a node's window
  // does (review R2-3, R3-2). Everything read on the way is kept, probe reads included (review R4-2). A floor is recorded
  // only when the node served a block above what it refused; it releases holds from the NEXT poll on (review R4-6).
  // 单独从节点 i 读 [lo, hi]，与其它节点无关，直到读完、失败或到 `deadline`（慢节点拖不住任何人；到时没覆盖的就是没覆盖，
  // 没有别的节点覆盖时游标停在那里）。`floor`：本次轮询之前已知、且本次再次确认（其下的读取又被以"太旧"拒绝）的下限；
  // `noLogs`：本次轮询之前已知不提供日志、且本次又这么说。每次读取至多一次探测（在被拒区块与 `hi` 之间对单个区块二分）和
  // 一次追赶：无论节点的窗口怎么变，只花 O(log chunk) 个请求。途中读到的一切都保留，探测读到的也不例外。只有节点在所拒区块
  // 之上确实提供过区块，才记下下限；它从下一次轮询起才能解除停住。
  async function walk(i, topics, lo, hi, deadline, skip = [], fresh = lo) {
    const s = st[i]
    const cov = [], logs = [], cannot = [], swept = []
    const known = s.floor && s.floor.poll < poll ? s.floor.at : null   // the floor known before this poll / 本次轮询之前已知的下限
    let confirmed = false        // `known` said again: a read below it refused as too old / 其下的读取再次被以"太旧"拒绝
    let cand = -Infinity         // the highest block refused as too old in this walk / 本次以"太旧"拒绝的最高区块
    let end = null               // the failure that stopped the walk short / 使本次读取提前结束的失败
    const read = async (x, y) => {
      if (Date.now() >= deadline) { s.outPoll = poll; throw OUT_OF_TIME }
      const got = await get(i, topics, x, y)
      // served below its floor: the floor was wrong (a misrouted backend), so it goes / 在下限之下也提供了：下限有误，丢弃
      if (s.floor && x < s.floor.at) s.floor = null
      cov.push([x, y]); logs.push(...got)
    }
    const tooOld = (x) => { if (x > cand) cand = x }
    // A stretch still too wide at minChunk, or whose answer is over the body limit: split here only, down to one block,
    // and read a block that is still too much through its receipts. The node's span is left alone, so one full block
    // cannot slow every later read (review R6-3). / minChunk 时仍太宽、或回答超过大小上限的一段：只在这里拆分到单个区块，仍然
    // 太多的区块读回执。不改节点的 span，一个塞满的区块拖慢不了之后的读取。
    // A node that refuses the receipts outright (no such method, a history refusal; not a timeout or a rate limit) cannot
    // give this block at all: `cannot`, so a block another node answered is not held for it; alone, it still holds, since
    // nobody answered (review R8-1). The walk goes on above it, and the next poll tries eth_getLogs again first.
    // 节点明确拒绝回执（没有该方法、历史拒绝；不是超时或限流）就根本给不了这个区块：记为 `cannot`，别的节点答过的区块不再为它
    // 停住；只剩它时照样停住（没人答过）。读取在其上继续，下次轮询先再试 eth_getLogs。
    const readBlock = async (b) => {
      if (Date.now() >= deadline) { s.outPoll = poll; throw OUT_OF_TIME }
      let got
      try { got = await getBlock(i, topics, b) } catch (e) {
        const r = refusalOf(e)
        // Only a definitive answer -- -32601 (no such method) or a history refusal: a transient one ("header not found",
        // "block … does not exist", "temporarily disabled") must never excuse a node, or a liar answering [] could outrun
        // an honest node's blip (R3-1, R5-3, R8-C2). Remembered in `cant`, so later polls do not split it again (R8-C3).
        // 只认确定的回答——-32601 或历史拒绝：临时错误绝不能豁免节点。记在 `cant` 里，之后的轮询不再重新拆分它。
        // Too old for it now: that is the node's floor, learnt as on the ordinary path (found by the randomised test: a
        // remembered block that slid out of the window held for ever instead of becoming a reported gap).
        // 对它已太旧：这是节点的下限，与常规路径一样记下。（随机测试发现：记住的区块滑出窗口后会永远停住，而不是成为报告的空洞。）
        // It stays in `cant` so that nodes with receipts read it for this one (R8-C1); each re-read teaches the floor again.
        // 仍记在 `cant` 里，让有回执的节点替它读；每次重读都会再次记下下限。
        if (r && isHistoryLimit(r.message)) { tooOld(b); s.full.delete(b); s.heavy.delete(b); s.cant.add(b); cannot.push([b, b, 'history']); return false }
        if (r && r.code === -32601) { cannot.push([b, b, 'receipts']); s.full.delete(b); s.heavy.delete(b); s.cant.add(b); return false }
        throw e
      }
      logs.push(...got.logs); cov.push([b, b]); s.cant.delete(b)
      // Remembered as read alone (`full`): nodes stream large answers without content-length, so each read covering it
      // would pull bodyLimit bytes before being cut off, poll after poll while the overlap covers it (review R7-4), and a
      // node that forces block-by-block reads would otherwise use the whole split budget on the overlap every poll. Only
      // a block that really is heavy is shared with nodes without logs (`heavy`): a node must not be able to make them
      // read every block's receipts cheaply (review R9-F2).
      // 记为"单独读"（`full`）：R7-4 的带宽原因；否则逼着逐块读的节点每轮都会把拆分预算耗在重叠区上。只有真的很重的区块才共享给
      // 不提供日志的节点（`heavy`）：不能让某个节点廉价地逼它们读每个区块的回执。
      s.full.add(b)
      if (got.heavy) s.heavy.add(b); else s.heavy.delete(b)
    }
    // At most SPLIT_READS requests a walk: one full block costs about 2·log2(span); a node refusing everything this way
    // is failing, and holds. / 每次读取至多 SPLIT_READS 个请求：一个满块约 2·log2(span) 个；这样拒绝一切的节点是出故障，停住。
    const isBig = (e) => e !== OUT_OF_TIME && kindOf(e).big
    let splits = SPLIT_READS
    // [x, y] was refused as too many logs (e0). Nodes stream large answers without content-length, so every truncated
    // read costs a full bodyLimit: over OUR limit, the same range once more with room enough is one download instead of
    // a bisection of truncated ones, and the blocks that made it large are remembered as full. publicnode's own cap names
    // a range it can answer ("retry with the range A-B", recorded): taken when it is a proper prefix of [x, y]. Anything
    // else bisects. / [x, y] 因日志太多被拒。节点的大回答不带 content-length，每次截断的读取都要花满 bodyLimit：超过的是我们自己的
    // 上限时，同一区间给足空间再读一次，一次下载代替多次截断的二分，并记住让它变大的区块。publicnode 的上限会给出它能回答的区间
    // （已录制）：是 [x, y] 的真前缀时采用。其余情况二分。
    let rangeBad = false   // a range read with room enough was over the limit too: bisect with the ordinary client / 给足空间的区间读取也超限：改用普通客户端二分
    const part = async (a, b, e0) => {
      if (--splits < 0) throw e0
      try { await read(a, b) } catch (e) { if (!isBig(e)) throw e; await split(a, b, e) }
    }
    const split = async (x, y, e0) => {
      if (--splits < 0) throw e0
      if (x === y) return readBlock(x)
      if (e0?.tooLarge === true && !rangeBad) {
        try { return await readWhole(x, y) } catch (e) { if (!isBig(e)) throw e; if (e?.tooLarge) rangeBad = true; e0 = e }
      }
      const h = /retry with the range (\d+)-(\d+)/.exec(refusalOf(e0)?.message ?? '')
      // B is the last block before the count ran over, so B + 1 is the one that did: read it alone
      // B 是条数超限之前的最后一块，所以让它超限的是 B + 1：单独读它
      if (h && Number(h[1]) === x && Number(h[2]) >= x - 1 && Number(h[2]) < y) {
        const b = Number(h[2])
        if (b >= x) await part(x, b, e0)
        if (--splits < 0) throw e0
        await readBlock(b + 1)
        if (b + 2 <= y) await part(b + 2, y, e0)
        return
      }
      const m = x + Math.floor((y - x) / 2)
      await part(x, m, e0); await part(m + 1, y, e0)
    }
    const readWhole = async (x, y) => {
      if (Date.now() >= deadline) { s.outPoll = poll; throw OUT_OF_TIME }
      const got = (await wholeCall(i, 'eth_getLogs', [filterOf(topics, x, y)], { project: logFacts }, x === y)).filter((l) => !l.removed && l.blockNumber >= x && l.blockNumber <= y)
      st[i].served = poll; st[i].noLogs = null; st[i].noLogsAt = 0
      const size = new Map()
      for (const l of got) size.set(l.blockNumber, (size.get(l.blockNumber) || 0) + l.data.length)
      for (const [b, n] of size) if (n > heavy) { s.full.add(b); s.heavy.add(b) }
      cov.push([x, y]); logs.push(...got)
    }
    // The first block the node serves above x (refused): x itself when a single block is served after all (the refusal
    // was about the range), null when it refuses even `hi` (a lagging or misrouted backend: not a window, it holds).
    // x（被拒）之上节点提供的第一个区块：单个区块其实可读时为 x（拒绝的是区间）；连 `hi` 都拒绝时为 null（落后或路由错的后端，不是窗口）。
    // A fresh search bisects between the refused block and `hi`. A search cut short by the deadline goes on from where it
    // was (`s.gallop`: the highest refused block, the lowest served one) in the next poll, and when the window has slid
    // past that served block since, it gallops up from it (steps 1, 2, 4, …: a slide is short) before bisecting again.
    // With few requests a poll, restarting from the cursor every time moved the floor one block a poll while the window
    // slid ~50 (review R5-4). Nothing is excused by it: a floor still needs a served block above what was refused.
    // 新的搜索在被拒区块与 `hi` 之间二分。被截止时间打断的搜索下次轮询从原处（`s.gallop`：最高的已拒区块、最低的已提供区块）继续；
    // 若窗口此后已滑过那个已提供的区块，就从它向上倍增（滑动很短）再二分。每轮请求很少时，每次从游标重来只让下限每轮挪一格，
    // 而窗口每轮滑约 50 格。它不豁免任何区块：下限仍须在所拒区块之上确实提供过区块。
    const probe = async (x) => {
      // A single block too full for eth_getLogs is served all the same: read through its receipts (review R7-2)
      // 单个区块塞满到 eth_getLogs 读不下，仍算可读：读它的回执
      const ok = async (m) => {
        try { await read(m, m); return true } catch (e) {
          if (e !== OUT_OF_TIME && kindOf(e).history) { tooOld(m); return false }
          if (isBig(e)) { await readBlock(m); return true }
          throw e
        }
      }
      // Resume the search a deadline cut short: `a` refused, `b` served (null while galloping), `step` the next gallop step.
      // 继续被截止时间打断的搜索：`a` 已拒，`b` 已提供（倍增阶段为 null），`step` 下一步长。
      let a = x, b = null, step = 1
      const g = s.gallop
      if (g && g.a < hi) {
        // x was refused just now and g.a before: both are too old, so resume from the higher with the step reached so far
        // (a window only slides forward). / x 刚被拒、g.a 之前被拒：都太旧；从较高的那个、以已达到的步长继续（窗口只会往前滑）。
        a = Math.max(g.a, x); step = g.step; tooOld(a)
        // the window may have slid past b since: then b is refused, and the gallop goes on above it / 窗口可能已滑过 b
        // (a slide is short: the gallop starts again from step 1 above it / 滑动很短：从 1 的步长重新向上倍增)
        if (g.b != null && g.b > a && g.b <= hi) { if (await ok(g.b)) b = g.b; else { a = g.b; step = 1; s.gallop = { a, b: null, step } } }
      } else {
        // A fresh search bisects [x, hi] straight away: the fewest requests when the window is far (arch A4)
        // 新的搜索直接在 [x, hi] 上二分：窗口很远时请求最少
        if (await ok(x)) return x
        if (!(await ok(hi))) { s.gallop = null; return null }   // refuses even `hi`: not a window (it holds) / 连 hi 都拒绝
        b = hi
      }
      while (b === null) {
        const m = Math.min(hi, a + step)
        if (await ok(m)) { b = m; break }
        if (m >= hi) { s.gallop = null; return null }   // refuses even `hi`: not a window (it holds) / 连 hi 都拒绝：不是窗口
        a = m; step *= 2; s.gallop = { a, b: null, step }
      }
      s.gallop = { a, b, step }
      while (b - a > 1) {
        const m = a + Math.floor((b - a) / 2)
        if (await ok(m)) b = m; else a = m
        s.gallop = { a, b, step }
      }
      s.gallop = null
      return b
    }
    // The window slid past x after the probe: gallop forward with range reads (steps 1, 2, 4, …) to one that is served,
    // then bisect the stretch it skipped, still with range reads. Every block left unread was refused (≤ cand); every
    // block above was read. Returns where the walk goes on. A refusal worded both ways is a range limit: halved, and at
    // minChunk the walk stops (hold, never skip). / 探测之后窗口滑过了 x：用区间读取以 1、2、4… 的步长向前找到可读的，再对跳过
    // 的那段二分。留下没读的区块都被拒过（≤ cand），其上的都读了。返回继续读取的位置。两种措辞兼有的拒绝是区间限制。
    const chase = async (lo0) => {
      let a = lo0, top = hi + 1, after = hi + 1   // blocks top..after−1 are read / top..after−1 已读
      const old = (e) => {                         // true: refused as too old; false: retry halved / true：太旧；false：减半重试
        const k = kindOf(e)
        if (e === OUT_OF_TIME || !k.history) throw e
        if (!k.range) return true
        if (s.span <= minChunk) throw e
        s.span = Math.max(minChunk, s.span >> 1)
        return false
      }
      // A stretch too full for one answer is split, as in the main walk (review R7-2) / 一个回答装不下的一段照主读取拆分
      for (let step = 1; a + step <= hi;) {
        const x = a + step, y = Math.min(hi, x + s.span - 1)
        try { await read(x, y); top = x; after = y + 1; break }
        catch (e) { if (isBig(e)) { await split(x, y, e); top = x; after = y + 1; break } if (old(e)) { tooOld(x); a = x; step *= 2 } }
      }
      while (top - 1 > a) {
        const b = top - 1
        const m = Math.max(b - s.span + 1, a + 1 + Math.floor((b - a - 1) / 2))
        try { await read(m, b); top = m }
        catch (e) { if (isBig(e)) { await split(m, b, e); top = m; continue } if (old(e)) { tooOld(m); a = m } }
      }
      return after
    }
    let probed = false, chased = false, notHistory = false
    for (let x = lo; x <= hi;) {
      // Blocks this node already answered in a held poll, at least `overlap` deep, are in the stash: not asked again
      // (review R5-6), so a slow node goes on from where it stopped instead of reading its first chunk again every poll.
      // Shallower ones are asked again, as the overlap would ask them: a reorg may have moved a log in (review R6-1).
      // 本节点在停住的轮询里已答过、且当时已至少 `overlap` 深的区块在暂存里：不再问。更浅的照样重问，与重叠区一样：重组可能挪进了日志。
      const sk = skip.find(([a, b]) => a <= x && x <= b)
      if (sk) { x = sk[1] + 1; continue }
      // A block found too full, or one this node cannot give (R8-C3), is read alone the way that found it: its logs with
      // room for a whole block, then its receipts; a block it still cannot give stays `cannot`, with no splitting again.
      // 发现塞满的区块、或本节点给不了的区块：按发现时的方式单独读（先给足空间读日志，再读回执）；仍给不了就仍是 `cannot`，不再重新拆分。
      if (s.full.has(x) || s.cant.has(x)) {
        try { await readBlock(x); x += 1; continue } catch (e) { end = { at: x, e }; break }
      }
      const nextSkip = skip.reduce((m, [a]) => (a > x && a < m ? a : m), Infinity)
      const nextFull = [...s.full, ...s.cant].reduce((m, b) => (b > x && b < m ? b : m), Infinity)
      const y = Math.min(hi, x + s.span - 1, nextSkip - 1, nextFull - 1)
      try { await read(x, y); x = y + 1; continue }
      catch (e) {
        if (e === OUT_OF_TIME) { end = { at: x, e }; break }
        const k = kindOf(e)
        try {
          if (k.history && !notHistory) {
            tooOld(x)
            const f = s.floor?.at
            // below the floor it gave before: the same answer again / 在它之前给出的下限之下：同样的回答
            if (f != null && x < f) { if (known !== null && x < known) confirmed = true; x = f; continue }
            if (!probed) {
              probed = true
              const o = await probe(x)
              if (o === null) { end = { at: x, e }; break }
              if (o > x) { x = o; continue }
              // x itself is served: a range limit worded with "history" / x 本身可读：措辞带 "history" 的区间限制
              notHistory = true
              if (k.range && s.span > minChunk) s.span = Math.max(minChunk, s.span >> 1)
              x += 1; continue
            }
            if (!chased) { chased = true; x = await chase(x); continue }
          } else if (k.big) { await split(x, y, e); x = y + 1; continue }
          else if (k.range && s.span > minChunk) { s.span = Math.max(minChunk, s.span >> 1); continue }
        } catch (e2) { end = { at: x, e: e2 }; break }
        end = { at: x, e }; break
      }
    }
    // A floor needs a served block above what was refused: a node refusing everything is failing, not history-limited.
    // 下限要求在所拒区块之上确实提供过区块：什么都拒绝的节点是出故障，不是历史受限。
    if (cand > -Infinity && cov.some(([, b]) => b > cand) && !(s.floor && s.floor.at > cand)) s.floor = { at: cand + 1, poll }
    let noLogs = false
    if (end && !cov.length && end.e !== OUT_OF_TIME && kindOf(end.e).noLogs) {
      // known before this poll, said again now, and for at least verdictMs (review R5-1) / 之前已知、本次再说、且持续满 verdictMs
      if (s.noLogs !== null && s.noLogs < poll && Date.now() - s.noLogsAt >= verdictMs) noLogs = true
      else if (s.noLogs === null && (s.served === null || poll - s.served >= SERVED_DECAY)) {
        // Does it serve any logs? One single-block read at `hi`, refused with an allowlisted answer too, says no; it counts
        // from the next poll on, and only while the node keeps saying so (review R2-1, R3-1, R4-6).
        // 它到底提供不提供？在 `hi` 读一个区块，同样以白名单回答被拒才算"不提供"；从下一次轮询起、且只在它一直这么说时生效。
        try { await read(hi, hi) } catch (e) { if (e !== OUT_OF_TIME && kindOf(e).noLogs) { s.noLogs = poll; s.noLogsAt = Date.now() } }
      }
    }
    // A node that serves no logs (a bsc-dataseed) may still serve receipts (recorded 2026-09-26: both dataseeds do, 20,000
    // blocks back). It reads the blocks another node found too full or could not give, so such a block rests on every
    // node that has its receipts, not on the one that read it (review R8-C1). Its own verdicts above are left as they
    // were: this is not serving logs, and it never makes the node one the cursor waits for.
    // 不提供日志的节点（dataseed）也可能提供回执（已录制：两个 dataseed 都提供，2 万块前也有）。它来读其它节点发现塞满或给不了的
    // 区块，这样的区块就由所有有回执的节点作证，而不只是读到它的那一个。上面对它的判定不变：这不算提供日志，也绝不会让游标等它。
    if (s.noLogs !== null && !(s.noReceipts != null && poll - s.noReceipts < SERVED_DECAY)) {
      // Shared out per node that asked: at most SWEEP_PER_NODE of each one's blocks a walk, the ones it cannot give first,
      // so one configured node cannot make every node without logs read a block's receipts per overlap block (R10-3).
      // 按提出请求的节点分摊：每个节点每次至多 SWEEP_PER_NODE 块，先补它给不了的；一个节点无法逼所有 dataseed 为重叠区每一块读回执。
      const want = (b) => b >= lo && b <= hi && !inside(skip, b) && !inside(cov, b)
      // Blocks this read has not passed yet come first: during a hold the overlap below the cursor was passed before, and
      // sweeping it every poll left the block the cursor holds at unread for ever (review R11-C1).
      // 本次读取还没越过的区块排前面：停住时游标下的重叠区早已越过，每轮都补读它会让游标所停的区块永远读不到。
      const order = (p, q) => ((p < fresh) - (q < fresh)) || p - q
      const others = new Set(st.flatMap((o, j) => (j === i ? [] : [...[...o.cant].filter(want).sort(order), ...[...o.heavy].filter(want).sort(order)].filter((b, k, xs) => xs.indexOf(b) === k).slice(0, SWEEP_PER_NODE))))
      for (const b of [...others].sort((p, q) => p - q).slice(0, SWEEP_MAX)) {
        // the second half of the budget is left for the immediate read below (review R12-F1) / 预算的后一半留给下面的当场补读
        if (Date.now() >= deadline - budgetMs / 2) { s.sweepCut = poll; break }
        try { logs.push(...(await receiptsOf(i, topics, b))); cov.push([b, b]); swept.push(b) }
        catch (e) { if (refusalOf(e)?.code === -32601) { s.noReceipts = poll; break } if (e?.tooLarge) break }
      }
    }
    return { cov, logs, floor: confirmed ? known : null, noLogs, end, cannot, swept }
  }

  // What node i's stash keeps for one room: its old parts outside [lo, hi], and inside it what the node has answered from
  // `from` (the new cursor) on (review R4-2, R5-2), bounded. `firm`: the part answered when the block was already
  // `overlap` deep below the read's top, the only part a later poll may skip (review R6-1).
  // 节点 i 为一个房间保留的：[lo, hi] 之外的旧部分，以及其内从 `from`（新游标）起节点答过的部分，有上限。`firm`：回答时该区块
  // 已在读取顶端之下至少 `overlap` 深的部分，之后的轮询只能跳过这一部分。
  const keepRoom = (old, fresh, freshLogs, lo, hi, from, full = new Set()) => {
    const outside = [...clip(old.cov, -Infinity, lo - 1), ...clip(old.cov, hi + 1, Infinity)]
    let cov = clip(unite([...fresh, ...clip(old.cov, lo, hi)]), from, hi)
    let logs = [...freshLogs, ...old.logs.filter((l) => l.blockNumber >= lo && l.blockNumber <= hi && !inside(fresh, l.blockNumber))]
      .filter((l) => l.blockNumber >= from && l.blockNumber <= hi).sort((x, y) => x.blockNumber - y.blockNumber)
    // Over STASH_MAX, the blocks found too full go first: they are read alone again anyway, and cutting at them used to
    // drop everything read above them too, which a sliding window could then turn into a gap (review R8-S1).
    // 超过 STASH_MAX 时先丢已知塞满的区块：它们反正会被单独重读；过去在它们处截断会连带丢掉其上已读到的，窗口一滑就成了空洞。
    if (logs.length > STASH_MAX && full.size) {
      const drop = [...full].filter((b) => b >= from && b <= hi)
      logs = logs.filter((l) => !full.has(l.blockNumber))
      cov = unite(cov.flatMap(([a, b]) => { const out = []; let x = a; for (const d of drop.filter((d) => d >= a && d <= b).sort((p, q) => p - q)) { if (d > x) out.push([x, d - 1]); x = d + 1 } if (x <= b) out.push([x, b]); return out }))
    }
    if (logs.length > STASH_MAX) { const cut = logs[STASH_MAX].blockNumber; logs = logs.filter((l) => l.blockNumber < cut); cov = clip(cov, from, cut - 1) }
    const all = unite([...outside, ...cov])
    const firm = intersect(unite([...(old.firm || []), ...clip(fresh, -Infinity, hi - overlap)]), all)
    return { cov: all, firm, logs: [...old.logs.filter((l) => l.blockNumber < lo || l.blockNumber > hi), ...logs] }
  }
  const EMPTY = { cov: [], firm: [], logs: [] }
  // One read of [lo, hi] for `rooms`: every node walks in parallel, the stash fills in what a node answered before for
  // every one of these rooms, and _busMerge says how far it may go. Returns the union of the logs below `advanceTo`, sorted.
  // 对 `rooms` 读一次 [lo, hi]：各节点并行读取，暂存补上节点以前对这些房间都答过的部分，由 _busMerge 决定能走多远。
  // `fresh`: the first block this read passes for the first time (below it, the overlap was passed before) / 本次首次越过的起点
  async function readRange(topics, rooms, lo, hi, deadline, fresh = lo) {
    const roomOf = (l) => l.room ?? (rooms.length === 1 ? rooms[0] : null)
    // A block counts as answered before only if it was, for every room of this read / 只有对本次每个房间都答过的区块才算答过
    const old = nodes.map((_, i) => {
      const per = rooms.map((r) => stash.get(r)?.[i] ?? EMPTY)
      const every = (f) => clip(per.reduce((acc, p, k) => (k ? intersect(acc, f(p)) : unite(f(p))), []), lo, hi)
      // a stashed log stands when its block is firm in its own room's stash / 暂存的日志在其所属房间的暂存里已足够深时才算数
      return { cov: every((p) => p.cov), firm: every((p) => p.firm || []), logs: per.flatMap((p) => p.logs.filter((l) => l.blockNumber >= lo && l.blockNumber <= hi && inside(p.firm || [], l.blockNumber))) }
    })
    const walks = await Promise.all(nodes.map((_, i) => walk(i, topics, lo, hi, deadline, old[i].firm, fresh).catch((e) => ({ cov: [], logs: [], floor: null, noLogs: false, end: { at: lo, e } }))))
    const views = walks.map((w, i) => {
      const fresh = unite(w.cov)
      // Where the node answered this poll its answer wins (a reorg); the stash fills the rest / 本次答了的以本次为准，其余由暂存补上
      // Served lately: what it did not answer may be only its own (review R5-3) / 最近提供过：它没答的部分可能只有它有
      // …and while the reader starts, a node that has not served yet and failed only transiently counts too: otherwise, on
      // the first poll after a start or restart, a node answering [] outran an honest node's single blip (review R9-PE1).
      // A node that said it serves no logs, or refused as history, is not waited for.
      // ……读取方刚启动时，还没提供过、且只是临时失败的节点也算：否则启动或重启后的第一次轮询，答 [] 的节点就能赶在诚实节点的一次
      // 抖动之前。说自己不提供日志、或以历史拒绝的节点不等。
      const k = w.end && w.end.e !== OUT_OF_TIME ? kindOf(w.end.e) : null
      // Only the first polls, and at most startGraceMs: a node down at start delays every start by this much (review R10-2)
      // 只在最初几次轮询、且至多 startGraceMs：启动时宕机的节点会让每次启动都晚这么久
      const starting = st[i].served === null && st[i].noLogs === null && w.end && !(k && (k.noLogs || k.history)) && poll <= START_GRACE_POLLS && Date.now() - startedAt < startGraceMs
      const mustCover = (st[i].served !== null && poll - st[i].served < SERVED_DECAY) || starting
      const softFloor = st[i].floor && st[i].floor.poll === poll ? st[i].floor.at : null
      // Only the firm part of the stash stands in for a read: a shallower stashed block was read before a reorg could
      // have changed it, so if the node did not read it again this poll it has not answered it (found by the randomised
      // test: a deep reorg during a hold moved a frame into such a block, the node ran out of time, its stale empty answer
      // let a liar's omission pass). A window never slides that close to the head, so R4-2 keeps what it protects.
      // 只有暂存里已足够深（firm）的部分能顶替读取：更浅的区块是在重组可能改变它之前读的，本轮没重读就不算答过。（随机测试发现：
      // 停住期间的深重组把帧挪进这样的区块，节点超时，它过期的空回答让撒谎者的遗漏越过。）窗口不会滑到离链头这么近，R4-2 仍成立。
      return { ...w, mustCover, softFloor, cov: unite([...fresh, ...old[i].firm]), logs: [...w.logs, ...old[i].logs.filter((l) => !inside(fresh, l.blockNumber))] }
    })
    let m = _busMerge(views, lo, hi)
    // A hold at a block only nodes without logs can answer (some node cannot give it, and nobody answered it): they read it
    // now, block by block while the hold stays at such a block, SWEEP_MAX at most. The per-node share of the sweep bounds
    // what one configured node can make them read; this read costs only a hold (review R11-C1).
    // 停在只有不提供日志的节点能答的区块上（某节点给不了、也没人答过）：它们现在就读这一块，只要仍停在这样的区块上就逐块读，至多
    // SWEEP_MAX 次。补读的按节点分摊限制了一个节点能逼它们读多少；这里的读取只在停住时才发生。
    for (let n = 0; m.hold && !m.none && n < SWEEP_MAX && Date.now() < deadline; n++) {
      const a = m.advanceTo
      if (!st.some((o) => o.cant.has(a)) || views.some((v) => inside(v.cov, a))) break
      let any = false
      // all at once, and a node whose sweep ran out of time is skipped only when another can answer (review R12-F1)
      // 并发读取；补读超时的节点只在还有别的节点能答时才跳过
      const can = nodes.map((_, i) => i).filter((i) => st[i].noLogs !== null && !(st[i].noReceipts != null && poll - st[i].noReceipts < SERVED_DECAY))
      const fast = can.filter((i) => st[i].sweepCut !== poll), ask = fast.length ? fast : can
      const res = await Promise.allSettled(ask.map((i) => receiptsOf(i, topics, a)))
      res.forEach((r, k) => {
        const i = ask[k]
        if (r.status !== 'fulfilled') { if (refusalOf(r.reason)?.code === -32601) st[i].noReceipts = poll; return }
        views[i].cov = unite([...views[i].cov, [a, a]]); views[i].logs.push(...r.value); walks[i].cov.push([a, a]); walks[i].logs.push(...r.value); any = true
      })
      if (!any) break
      m = _busMerge(views, lo, hi)
    }
    // A block passed although a node that serves logs could not read it (too full for its eth_getLogs, receipts refused):
    // only the other nodes vouched for it, and a frame they left out shows only as a gap in the session (§3.7, R8-C1).
    // Said once per block. / 越过了某个提供日志的节点读不了的区块：只有其它节点为它作证，它们漏掉的帧只会在会话里表现为空洞。每块说一次。
    const say = (b, text, d) => {
      if (passedOn.has(b)) return
      passedOn.add(b)
      try { (warn || console.warn)(`[tapeapi] bus ${bus}: block ${b} ${text}; a frame left out there shows only as a gap in the session.`, { cannot: b, ...d }) } catch { /* a warning never breaks a read / 警告不影响读取 */ }
    }
    const byOthers = (b, i) => views.flatMap((u, j) => (j !== i && inside(u.cov, b) ? [nodes[j].name] : [])).join(', ')
    views.forEach((v, i) => {
      for (const [b, , why] of v.cannot || []) {
        if (b < Math.max(lo, fresh) || b >= m.advanceTo) continue
        say(b, why === 'history'
          ? `is too old for ${nodes[i].name}, so it was read from ${byOthers(b, i)} alone`
          : `holds more logs than ${nodes[i].name} returns and ${nodes[i].name} cannot read its receipts, so it was read from ${byOthers(b, i)} alone`, { node: i, why })
      }
      // Read only from the receipts of nodes that serve no logs: no logs node vouched for it (review R9-F3, TAPI-26 §3.7)
      // 只从不提供日志的节点的回执读到：没有任何日志节点为它作证
      // (this poll's sweep or an earlier one kept in the stash) / （本轮补读的，或暂存里以前补读的）
      if (st[i].noLogs === null) return
      for (const [a, z] of clip(v.cov, Math.max(lo, fresh), m.advanceTo - 1)) for (let b = a; b <= z; b++) {
        if (views.some((u, j) => st[j].noLogs === null && inside(u.cov, b))) continue
        say(b, `was read only from the receipts of ${byOthers(b, -1)}, nodes that serve no logs`, { node: i, why: 'receipts only' })
      }
    })
    // A node that served before but not for SERVED_DECAY polls is no longer waited for (R4-6: a dead node must not hold
    // for ever). When the cursor passes a block it failed on, say so once per streak: a frame only it had is lost there
    // (review R10, seed 1001479: this happened without a word). / 以前提供过、但已 SERVED_DECAY 次轮询没提供的节点不再被等待。
    // 游标越过它没答上的区块时，每个连续期说一次：只有它有的帧在那里丢了。
    views.forEach((v, i) => {
      const s = st[i]
      if (s.served === poll) { s.abandoned = false; return }
      if (s.noLogs !== null || v.mustCover || !v.end || v.end.at >= m.advanceTo) return
      // a node that never served says nothing only when it said it serves no logs, or refused as history
      // 从没提供过的节点，只有在它说自己不提供日志、或以历史拒绝时才不必说
      const k = v.end.e !== OUT_OF_TIME ? kindOf(v.end.e) : null
      if (s.served === null && k && (k.noLogs || k.history)) return
      // from where it stopped, the overlap below the cursor included: a reorg may have moved a frame there that only it
      // would have re-read / 从它停下的地方起，包括游标下方的重叠区：重组可能把只有它会重读的帧挪到了那里
      const at = Math.max(v.end.at, lo)
      if (at >= m.advanceTo || (v.floor != null && at < v.floor) || (v.softFloor != null && at < v.softFloor)) return
      // once per streak, and again when a later read (a room catching up) passes lower blocks without it (review R11-C2)
      // 每个连续期说一次；之后的读取（补读的房间）越过更低的区块时再说一次
      if (s.abandoned !== false && at >= s.abandoned) return
      s.abandoned = at
      try { (warn || console.warn)(`[tapeapi] bus ${bus}: ${nodes[i].name} has not served ${s.served === null ? 'since the reader started' : `for ${poll - s.served} polls`}, so blocks from ${at} on are passed without it (${v.end.e === OUT_OF_TIME ? 'out of time' : String(v.end.e?.message || v.end.e).slice(0, 120)}); ${s.served === null ? 'if it serves logs, a frame only it has is lost there' : 'a frame only it has is lost there'}. If it is slow, raise budgetMs; if it is gone, remove it.`, { abandoned: i, from: at }) } catch { /* a warning never breaks a read / 警告不影响读取 */ }
    })
    if (passedOn.size > 4096) passedOn.clear()
    for (const r of rooms) {
      const prev = stash.get(r)
      stash.set(r, walks.map((w, i) => keepRoom(prev?.[i] ?? EMPTY, unite(w.cov), w.logs.filter((l) => roomOf(l) === r), lo, hi, m.advanceTo, st[i].full)))
    }
    const seen = new Map()
    for (const v of views) for (const l of v.logs) if (l.blockNumber >= lo && l.blockNumber < m.advanceTo) seen.set(`${l.blockNumber}:${l.logIndex}:${l.room ?? ''}:${l.data}`, l)
    return { ...m, lo, hi, views, logs: [...seen.values()].sort((x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex) }
  }
  // Why node i did not let the cursor past a held block / 节点 i 为何不让游标越过停住的区块
  const why = (r, i) => {
    const v = r.views[i], s = st[i], at = r.stuck[0]
    const fresh = (s.floor && s.floor.poll === poll && at < s.floor.at) || (s.noLogs !== null && (s.noLogs === poll || Date.now() - s.noLogsAt < verdictMs))
    if (inside(v.cannot || [], at)) return 'cannot read them: more logs than it returns, and its receipts refused (another node must answer them)'
    if (v.end) return `${v.end.e === OUT_OF_TIME ? 'out of time for this poll' : (v.end.e?.message || String(v.end.e))}${fresh ? ' (learnt this poll: believed from the next one)' : ''}`
    return fresh ? 'refused them as too old (learnt this poll: believed from the next one)' : 'did not answer them'
  }
  const holdError = (r) => {
    const names = r.pending.map((i) => nodes[i].name).join(', ')
    const lead = r.none ? `eth_getLogs: no node serves logs (${names})` : `eth_getLogs: blocks ${r.stuck[0]}..${r.stuck[1]} were served by no node, and ${names} may keep them`
    return new TapeAPIError('RPC_UNAVAILABLE', `${lead} (${r.pending.map((i) => `${nodes[i].name}: ${why(r, i)}`).join('; ')}); the cursor holds and the next poll tries them again`)
  }
  // Holding is safe but may never end: a node gone for good (an expired key, a dead host) beside a cursor older than every
  // other node's window. Said once per streak of HOLD_WARN holds, whatever made them, naming nodes by index only (R3-7).
  // 停住是安全的，但可能永远停下去。每连续 HOLD_WARN 次说一次，不论原因，只按序号称呼节点。
  const held = (r) => {
    if (++holds.n !== HOLD_WARN) return
    const [lo, hi] = r.stuck
    const names = r.pending.map((i) => `node#${i}`).join(', ')
    const msg = `[tapeapi] bus ${bus}: the cursor has held for ${holds.n} polls at blocks ${lo}..${hi}: no answering node serves them, and ${names} keeps failing or is too slow to finish within budgetMs (${budgetMs} ms) while its history window slides (it may keep them, so they are not skipped). If ${names} is gone for good, remove it from the rpc urls; if it is slow, raise budgetMs or add a node that keeps more history; or restart from a newer fromBlock (frames in ${lo}..${hi} are then not read).`
    try { (warn || console.warn)(msg, { from: lo, to: hi, nodes: r.pending, holds: holds.n }) } catch { /* a warning never breaks a read / 警告不影响读取 */ }
  }
  // Blocks every node excuses and none served: frames there cannot be read from these nodes. Said once per read, for
  // blocks from `from` on (below it they were reported or read before). / 每个节点都豁免、没有节点提供的区块：其中的帧无法从
  // 这些节点读到。每次读取说一次，只说 `from` 及以上的（其下的以前已报告或已读过）。
  const report = (gaps, from) => {
    const g = gaps.map(([a, b]) => [Math.max(a, from), b]).filter(([a, b]) => a <= b)
    if (!g.length) return
    const lo = g[0][0], hi = g.at(-1)[1], n = g.reduce((t, [a, b]) => t + b - a + 1, 0)
    oldestServed = hi + 1
    const msg = `[tapeapi] bus ${bus}: no node serves logs for blocks ${lo}..${hi} (${n} blocks, about ${Math.max(1, Math.round(n * 0.45 / 60))} min at 0.45 s a block); frames posted there cannot be read. Oldest block served: ${hi + 1}. Use a smaller lookback, a newer cursor, or a node that keeps more history.`
    try { (warn || console.warn)(msg, { from: lo, to: hi, oldestServed: hi + 1 }) } catch { /* a warning never breaks a read / 警告不影响读取 */ }
  }
  // One poll over `rooms`. `behind`: [[room, fromBlock | null]] to read once from further back (rooms a reader added
  // late); `caughtUp(rooms, resume)` is told where each group stands (null: done). A read that holds keeps what it
  // delivered and where it stopped; the poll throws only when it holds with nothing to hand over.
  // 对 `rooms` 轮询一次。`behind`：需要从更早处补读一次的房间；`caughtUp(rooms, resume)` 告知每组读到哪里（null：读完）。
  // 停住的读取保留已交出的与停下的位置；只有停住且没有任何东西可交出时才抛错。
  async function scan(rooms, { behind = [], caughtUp } = {}) {
    const head = (await rpc.blockNumber()) - confirmations
    poll++
    startedAt ??= Date.now()
    const deadline = Date.now() + budgetMs
    // Start `lookback` blocks back, not at the head: the peer posts its side while this side is still starting up
    // (the responder cannot poll until its own accept transaction is in), and a frame below the first head read
    // would be skipped for ever. 600 blocks is about 5 minutes of BSC. Persist `cursor` to resume exactly.
    // 从 lookback 个区块之前开始，而不是从链头：对端会在本方还在启动时发出消息，落在首次读取链头之下的帧会被永远跳过。
    let from
    if (next === null) { next = Math.max(0, head - lookback); from = next }
    // A later poll, or a first one from a given fromBlock (a persisted cursor), re-reads the overlap: a reorg may have
    // moved a log into it. / 之后的轮询、或从给定 fromBlock 开始的首次轮询，都重读重叠区：重组可能把日志挪进来。
    else from = Math.max(0, next - overlap)
    const out = []
    const deliver = (logs, rs) => {
      for (const l of logs) {
        const room = l.room ?? (rs.length === 1 ? rs[0] : null)
        if (!room || !rs.includes(room)) continue      // not asked for: a node's junk / 没问过的房间：节点的垃圾
        const key = logKey(l)
        if (delivered.has(key)) continue               // read again in the overlap: already handed over / 重叠区里再次读到：已交出过
        // Anyone who has seen the room id can post junk to it; junk fails to decode here or fails AEAD in the session.
        // Only what decodes is remembered, so junk never fills the memory (review R4-5).
        // 看到房间号的人都能往里发垃圾；垃圾在此解码失败或在会话中认证失败。只记住能解码的，垃圾填不满记忆。
        let w
        try { const [data] = decodeParams(['bytes'], hexToBytes(l.data)); w = hexToBytes(data) } catch { continue }
        delivered.set(key, l.blockNumber)
        if (w.length) out.push({ room, wire: w, key })
      }
    }
    const topicsOf = (rs) => [CHANNELBUS_WIRE_TOPIC, rs.length === 1 ? '0x' + rs[0] : rs.map((r) => '0x' + r)]
    let hold = null
    // Rooms that joined late, grouped by where they start: one read per group, below where the main read begins.
    // 后加入的房间按起点分组：每组读一次，范围在主读取起点之下。
    const groups = new Map()
    for (const [r, f] of behind) { const s = f ?? Math.max(0, head - lookback); groups.set(s, [...(groups.get(s) || []), r]) }
    for (const [s, rs] of [...groups].sort((x, y) => x[0] - y[0])) {
      // A late room is read up to the main cursor, not only to where the main read starts: the overlap was read before
      // for the other rooms but never for this one, so a gap there must be reported for it here (found by the randomised
      // test: a window sliding past the overlap took a re-added room's frame without a word).
      // 后加入的房间一直补读到主游标，而不只是主读取的起点：重叠区以前替其它房间读过，却从没替它读过，那里的空洞必须在这里为它报告。
      // （随机测试发现：窗口滑过重叠区时，重新加入的房间的帧会不声不响地丢掉。）
      if (s >= next) { caughtUp?.(rs, null); continue }
      // The head may be below next − 1 (rpc.blockNumber is the lowest answering head, and moves back when a lagging
      // node answers): read what exists and keep the rest for the next poll (review R2-4).
      // 链头可能低于 next − 1：读已有的，其余留给下次轮询。
      const hi = Math.min(next - 1, head)
      if (s > hi) { caughtUp?.(rs, s); continue }
      const r = await readRange(topicsOf(rs), rs, s, hi, deadline)
      deliver(r.logs, rs)
      report(r.gaps, s)
      if (r.hold) hold ??= r
      caughtUp?.(rs, r.hold ? r.advanceTo : hi < next - 1 ? hi + 1 : null)
    }
    if (from <= head) {
      const r = await readRange(topicsOf(rooms), rooms, from, head, deadline, started ? next : from)
      deliver(r.logs, rooms)
      report(r.gaps, started ? next : from)
      if (r.advanceTo > next) { next = r.advanceTo; started = true }
      if (r.hold) hold = r
    }
    // A node that used its whole budget this poll, poll after poll, makes every poll take budgetMs: say so once per streak,
    // by index (review R5-5). / 连续每次轮询都用完整个预算的节点让每次轮询都花满 budgetMs：每轮连续说一次，只按序号称呼。
    for (let i = 0; i < nodes.length; i++) {
      const s = st[i]
      if (s.outPoll !== poll) { s.outOfTime = 0; continue }
      if (++s.outOfTime !== HOLD_WARN) continue
      const msg = `[tapeapi] bus ${bus}: node#${i} has used its whole per-poll budget (${budgetMs} ms) for ${s.outOfTime} polls in a row, so every poll takes that long, and blocks it cannot answer in time are passed on the other nodes' word alone once it has not served for ${SERVED_DECAY} polls. If it is slow or misbehaving, remove it from the rpc urls; if it is honest but slow, raise budgetMs.`
      try { (warn || console.warn)(msg, { node: i, polls: s.outOfTime, budgetMs }) } catch { /* a warning never breaks a read / 警告不影响读取 */ }
    }
    // A room no longer read is forgotten; a room with no catch-up pending keeps only what the next poll can still use.
    // 不再读取的房间忘掉；没有待补读的房间只保留下次轮询还用得上的部分。
    const catching = new Set(behind.map(([r]) => r))
    for (const [r, per] of stash) {
      if (!rooms.includes(r) && !catching.has(r)) { stash.delete(r); continue }
      if (catching.has(r)) continue
      const floor = next - overlap
      stash.set(r, per.map((p) => ({ cov: clip(p.cov, floor, Infinity), firm: clip(p.firm || [], floor, Infinity), logs: p.logs.filter((l) => l.blockNumber >= floor) })))
    }
    // Forget what the next poll can no longer re-read: memory stays bounded by the overlap window.
    // 忘掉下次轮询不会再读到的：记忆大小受重叠窗口约束。
    for (const [k, n] of delivered) if (n < next - overlap) delivered.delete(k)
    // Kept down to the lowest block still being read: a room catching up reads below the main overlap, and a block it
    // needs others to sweep must stay known (found by the randomised test: a catch-up held for ever at a stuffed block
    // whose memory the main read had pruned). / 保留到仍在读的最低区块：补读中的房间读在主重叠区之下，需要别人补读的区块必须仍被记得。
    const keepFrom = Math.min(next - overlap, ...behind.map(([, f]) => f ?? head - lookback))
    for (const s of st) for (const set of [s.full, s.heavy, s.cant]) for (const b of set) if (b < keepFrom) set.delete(b)
    if (!hold) { holds.n = 0; return out }
    held(hold)
    if (!out.length) throw holdError(hold)
    return out
  }
  return {
    scan,
    // A reader that did not hand an item over (its room was removed meanwhile) takes it back: a later read of that
    // block hands it over then (review R6-2). / 读者没交出的项（期间房间被移除）收回记忆：之后再读到该区块时再交出。
    forget: (key) => { delivered.delete(key) },
    get cursor() { return next },
    get oldestServed() { return oldestServed },
    stats: () => ({
      cursor: next, oldestServed, remembered: delivered.size,
      nodes: nodes.map((n, i) => ({ node: n.name, oldestServed: st[i].floor?.at ?? null, span: st[i].span, servesLogs: st[i].noLogs === null, outOfTime: st[i].outOfTime })),
    }),
  }
}

// ---------------------------------------------------------------- fan-in (arch B1) ----
/**
 * fanIn(transports, { all, window }): several transports (relayTransport / busTransport, or anything with send, poll,
 * start and stop) as one. The responder may post `accept` to ANY relay or bus the invite names (§3.5, §3.7), so the
 * initiator must listen on all of them: recv merges every transport, each polled concurrently with its own cursor;
 * the same wire bytes arriving on several transports (a responder that posted everywhere) are handed over once, within
 * the last `window` messages. send posts to the first transport that takes it, in order, or to all with { all: true }
 * (as an option or per call). onWire gets (wire, { index }) and from(wire) says which transport delivered it, so a
 * reply can go back the same way. Only a building block: no timeouts, no invite handling, no demux.
 * 多个传输合为一个。响应方可以把 `accept` 发到邀请所列的任一中继或总线，因此发起方必须全部监听：接收合并所有传输，
 * 各自带游标并发轮询；同一段线路字节从多个传输到达（响应方处处都发了）只交出一次，窗口为最近 `window` 条。发送按顺序
 * 交给第一个成功的传输，或用 { all: true } 发给全部。onWire 收到 (wire, { index })，from(wire) 给出送达的传输，便于原路回复。
 * 这只是积木：不含超时、邀请处理与分流。
 */
export function fanIn(transports, { all = false, window = 1024 } = {}) {
  if (!Array.isArray(transports) || transports.length === 0) fail('fanIn takes a non-empty array of transports')
  for (const t of transports) if (!t || typeof t.send !== 'function' || typeof t.poll !== 'function' || typeof t.start !== 'function' || typeof t.stop !== 'function') fail('each transport needs send, poll, start and stop')
  if (!(Number.isInteger(window) && window >= 1)) fail('window must be a positive integer')
  const seen = new Set()               // digests of the last `window` wire messages, oldest first / 最近 window 条的摘要，旧的在前
  const origin = new WeakMap()         // wire -> index of the transport that delivered it / 线路消息 -> 送达它的传输
  const fresh = (w, index) => {
    const k = toHex(sha256(w))
    if (seen.has(k)) return false
    seen.add(k)
    if (seen.size > window) seen.delete(seen.values().next().value)
    origin.set(w, index)
    return true
  }
  const errorOf = (errs) => new TapeAPIError('CHANNEL_INVALID', `every transport failed: ${errs.map((e, i) => `#${i}: ${e?.message || e}`).join('; ')}`)
  const send = async (wire, { all: every = all, index } = {}) => {
    if (index !== undefined) {
      if (!transports[index]) fail(`no transport #${index}`)
      return transports[index].send(wire)
    }
    if (every) {
      const r = await Promise.allSettled(transports.map((t) => t.send(wire)))
      if (r.every((x) => x.status === 'rejected')) throw errorOf(r.map((x) => x.reason))
      return r.map((x) => (x.status === 'fulfilled' ? x.value : undefined))
    }
    const errs = []
    for (const t of transports) { try { return await t.send(wire) } catch (e) { errs.push(e) } }
    throw errorOf(errs)
  }
  // One poll of every transport at once; arguments pass through (relayTransport takes a wait). Fails only when all do.
  // 同时轮询每个传输一次；参数原样传入（relayTransport 接受等待时长）。全部失败才算失败。
  const poll = async (...args) => {
    const r = await Promise.allSettled(transports.map((t) => t.poll(...args)))
    if (r.every((x) => x.status === 'rejected')) throw errorOf(r.map((x) => x.reason))
    const out = []
    r.forEach((x, i) => { if (x.status === 'fulfilled') for (const w of x.value) if (fresh(w, i)) out.push(w) })
    return out
  }
  return {
    send, poll, transports,
    from: (wire) => origin.get(wire),
    /** Start every transport's own loop; each wire is handed to onWire once / 启动每个传输自己的循环；每条消息只交出一次 */
    start(onWire, { onError } = {}) {
      transports.forEach((t, index) => t.start((w) => (fresh(w, index) ? onWire(w, { index }) : undefined), { onError: onError && ((e) => onError(e, { index })) }))
    },
    stop() { for (const t of transports) t.stop() },
  }
}

// ---------------------------------------------------------------- identity and inbox (§3.1, §3.2) ----
/**
 * A container's channel identity: an X25519 key for handshakes and an Ed25519 key for signed group messages
 * (TAPI-27). Generated here, kept by the application, published with the holder's authorisation (api.tx.publishChannelKeys).
 * No wallet signature is ever turned into a key, so nothing asks the holder to sign text meant for another site.
 * 容器的通道身份：握手用 X25519，群消息签名用 Ed25519。在此生成，由应用保存，经持有人授权后发布。
 * 从不把钱包签名变成密钥，因此不会要求持有人签署写着"只在别的网站签"的文字。
 */
export function generateIdentity(random = randomBytes) {
  const x = generateKeyPair(random)
  const edSecret = random(32)
  return { x25519: x, ed25519: { secretKey: edSecret, publicKey: ed25519.getPublicKey(edSecret) } }
}

/**
 * A container's inbox room on any relay or ChannelBus: where invites to it are posted. A container has one inbox room
 * per label version: { labels: 'v2' } gives the TAPI-26 v2 room, where v2 invites (and TAPI-27 v2 group invites) go.
 * 容器的收件房间。每个标签版本各有一个：{ labels: 'v2' } 给出 TAPI-26 第 2 版的收件房间，v2 邀请（及 TAPI-27 v2 入群邀请）投到那里。
 */
export function inboxRoom(container, chainId = 56, { labels } = {}) {
  return toHex(sha256(concat(LB[checkLabels(labels)].inbox, endpointBytes(container, chainId))))
}

/**
 * Seal an invite to the recipient's channel X25519 key for its inbox room: 0x03 ‖ E ‖ N ‖ ciphertext. Anyone can
 * post it; nothing in it authenticates the sender, and nothing needs to: the handshake does (§3.3, inviteHash).
 * Only the room (derived from the recipient) and the size are visible.
 * 把邀请密封给收件方的通道 X25519 公钥，投进它的收件房间：0x03 ‖ E ‖ N ‖ 密文。任何人都能投递；其中没有任何东西认证
 * 发送方，也不需要——握手会认证（§3.3，inviteHash）。外界只看得到房间（由收件方推导）与大小。
 */
export function sealInvite(invite, opts) { return sealToInbox(invite, opts) }
/**
 * Seal any strict-JSON object (a TAPI-26 invite, a TAPI-27 group invite) for a container's inbox. With { labels: 'v2' }
 * it is sealed for the v2 inbox room (post it to inboxRoom(container, chainId, { labels: 'v2' })).
 * 密封任意严格 JSON 对象投进收件房间。{ labels: 'v2' } 时按第 2 版收件房间密封（投到 inboxRoom(容器, chainId, { labels: 'v2' })）。
 */
export function sealToInbox(content, { to, random = randomBytes, labels }) {
  const L = LB[checkLabels(labels)]
  const R = assertPublicKey(typeof to?.staticPublic === 'string' ? fromHex(to.staticPublic, 32, 'to.staticPublic') : to?.staticPublic, 'to.staticPublic')
  const room = fromHex(inboxRoom(to.container, to.chainId ?? 56, { labels }), 32, 'room')
  const e = random(32)
  const E = x25519.getPublicKey(e)
  const N = random(24)
  const ss = dh(e, R, 'the recipient key')
  e.fill(0)
  const K = hkdf(sha256, ss, L.inbox, concat(E, R, room), 32)
  ss.fill(0)
  const C = xchacha20poly1305(K, N, concat(L.inbox, E, room)).encrypt(te.encode(canonicalJSON(content)))
  K.fill(0)
  const wire = concat(Uint8Array.of(WIRE_INVITE), E, N, C)
  if (wire.length > MAX_FRAME_BYTES + 64) fail('sealed invite too large')
  return wire
}

/** Open a sealed invite from this container's inbox; returns the invite object / 打开收件房间里的密封邀请 */
export function openInvite(wire, opts) { return decodeInviteContent(te.encode(canonicalJSON(openFromInbox(wire, opts)))) }
/**
 * Open anything sealed to this container's inbox; returns the strict-parsed object. `labels` is the version of the
 * inbox room the wire was read from. A wire sealed under the other version is refused, with data.peerLabels.
 * 打开密封给本容器收件房间的任意内容。`labels` 为读到这条线路消息的收件房间的版本。按另一版本密封的消息被拒绝，并附 data.peerLabels。
 */
export function openFromInbox(wire, { self, labels }) {
  const lv = checkLabels(labels)
  if (!(wire instanceof Uint8Array) || wire.length < 1 + 32 + 24 + 16 || wire[0] !== WIRE_INVITE) fail('not a sealed invite')
  if (!(self?.staticSecret instanceof Uint8Array) || self.staticSecret.length !== 32) fail('self.staticSecret must be 32 bytes')
  const E = assertPublicKey(wire.slice(1, 33), 'sealed invite key')
  const N = wire.slice(33, 57)
  const roomOf = (v) => fromHex(inboxRoom(self.container, self.chainId ?? 56, { labels: v }), 32, 'room')
  const rooms = { [lv]: roomOf(lv) }
  const R = x25519.getPublicKey(self.staticSecret)
  const ss = dh(self.staticSecret, E, 'the sealed invite key')
  const tryOpen = (v) => {
    const room = rooms[v] ?? roomOf(v)
    const K = hkdf(sha256, ss, LB[v].inbox, concat(E, R, room), 32)
    try { return xchacha20poly1305(K, N, concat(LB[v].inbox, E, room)).decrypt(wire.slice(57)) } catch { return null } finally { K.fill(0) }
  }
  let content, other = null
  try {
    content = tryOpen(lv)
    // Only to name the failure: a wire that opens under the other version is refused all the same, and its content is
    // dropped unread. / 只为说明失败原因：能按另一版本打开的消息同样被拒绝，其内容不读即弃。
    if (content === null) { other = tryOpen(otherLabels(lv)); other?.fill(0) }
  } finally { ss.fill(0) }
  // Anyone can seal to an inbox, so this only says how the wire was sealed, not that its sender is genuine: no wording
  // here suggests the other version would be the right one. / 任何人都能往收件房间密封投递，所以这里只说明消息是怎样密封的，
  // 不说明发送者可信：措辞不暗示另一版本才是对的。
  if (content === null && other !== null) {
    fail(`this sealed invite does not open under the ${lv} labels this side reads with; it opens under the other label version (${otherLabels(lv)}). Anyone can post to an inbox room, so this is no evidence that the sender is genuine. The SDK never switches versions on its own.`, { data: { labels: lv, peerLabels: otherLabels(lv) } })
  }
  if (content === null) fail('sealed invite does not open with this key (not for this container, or tampered)')
  let text, obj
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(content) } catch { fail('inbox content is not UTF-8') }
  try { obj = safeParseJSON(text, { code: 'CHANNEL_INVALID' }) } catch { fail('inbox content is not strict JSON (no duplicate or prototype keys)') }
  if (!obj || typeof obj !== 'object' || obj.v !== 1 || typeof obj.kind !== 'string') fail('inbox content has no v/kind')
  return obj
}

/** An Ed25519 public key: 32 bytes that decode to a curve point / Ed25519 公钥：32 字节且能解码为曲线点 */
export function assertEd25519Public(pub, name = 'ed25519 key') {
  const b = typeof pub === 'string' ? fromHex(pub, 32, name) : pub
  if (!(b instanceof Uint8Array) || b.length !== 32) fail(`${name} must be 32 bytes`)
  let P
  try { P = ed25519.ExtendedPoint.fromHex(b) } catch { fail(`${name} is not a point on Ed25519`) }
  // A small-order key (the identity point among them) lets one signature verify for every message: refuse it,
  // as low-order X25519 keys are refused. / 小阶公钥（含单位元）能让一个签名对任何消息都验证通过：拒绝，与低阶 X25519 同理。
  if (P.isSmallOrder()) fail(`${name} is a small-order point`)
  return b
}
