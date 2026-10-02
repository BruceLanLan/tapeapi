// TapeSend (TAP-10) payloads: seal, open, and the on-chain send call, byte-compatible with the reference module
// @tapekit/send (TapeOutProtocol/TapeKit, MIT; checked against its test/vectors.json at f1831a4).
// A Tape Channel invite (TAPI-26 §3.2) travels as a sealed TapeSend message. Sealing needs only the recipient's
// public key, so any app can send an invite; opening one needs the recipient's TapeSend secret.
// TapeSend（TAP-10）载荷：封装、打开与链上发送调用，与参考模块 @tapekit/send 字节兼容（以其测试向量校验）。
// Tape Channel 的邀请作为密封的 TapeSend 消息传递。封装只需要收件人的公钥，因此任何应用都能发邀请；打开需要收件人的 TapeSend 私钥。
import { x25519 } from '@noble/curves/ed25519'
import { xchacha20poly1305 } from '@noble/ciphers/chacha'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { keccak_256 } from '@noble/hashes/sha3'
import { randomBytes } from '@noble/hashes/utils'
import { TapeAPIError } from './errors.js'
import { selector, encodeParams, bytesToHex, hexToBytes, toHex, isAddress } from './abi.js'

export const MAGIC = Uint8Array.of(0x54, 0x53)          // "TS"
export const FORMAT_VERSION = 0x02
export const KIND_PUBLIC = 0x00
export const KIND_SEALED = 0x01
export const MAX_PAYLOAD = 16_000                        // the whole payload after sealing / 封装后的整个载荷
export const MAX_SLOTS = 16
const PREAMBLE = 93, SLOT = 56, TAG = 16
const P_FIELD = (2n ** 255n) - 19n
const ZERO_REF = new Uint8Array(32)
const te = new TextEncoder()
// DeWebHub.send(address circuits, uint256 tokenId, bytes32 to, bytes32 ref, bytes payload) = 0xa181b579
export const SEND_SELECTOR = selector('send(address,uint256,bytes32,bytes32,bytes)')
const ascii = (s) => te.encode(s)

// Errors carry the reference module's outcome in `reason`: bad-input, bad-key, too-large, unsupported, damaged,
// not-for-key. / 错误在 `reason` 里给出与参考模块一致的结论。
const fail = (reason, msg) => { throw new TapeAPIError('TAPESEND_INVALID', msg, { reason }) }
const concat = (...xs) => { const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of xs) { out.set(x, o); o += x.length } return out }
const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const bytes32 = (v, name) => { const b = typeof v === 'string' ? hexToBytes(v) : v; if (!(b instanceof Uint8Array) || b.length !== 32) fail('bad-input', `${name} must be 32 bytes`); return b }
const addr20 = (a, name) => { if (!isAddress(a)) fail('bad-input', `${name} must be an address`); return hexToBytes(a) }

// @experimental (1.5) `conform: 'tap10'` on any function below: TAP-10 §12.1 "clients MUST reject endpoint IDs whose chainId
// exceeds 2^53 − 1". Every chainId the call takes (chainId, toChainId, and the chain of a 32-byte endpoint) above it is then
// bad-input. Without it the bound stays 2^64 − 1 (the hub's own, §13.2), as in 1.4. / `conform: 'tap10'`：TAP-10 §12.1 要求
// 拒绝 chainId 大于 2^53 − 1 的端点号；此时调用涉及的每个 chainId（含 32 字节端点里的）超出即 bad-input。不传时仍为 2^64 − 1。
const MAX_TAP10_CHAIN_ID = (1n << 53n) - 1n
function conformOf(conform) {
  if (conform === undefined || conform === null || conform === false) return false
  if (conform !== 'tap10') fail('bad-input', "conform: pass 'tap10', or leave it out")
  return true
}
function tap10Chain(id, strict) {
  if (!strict) return
  let n
  try { n = BigInt(id) } catch { fail('bad-input', 'chainId must be a whole number') }
  if (n < 1n || n > MAX_TAP10_CHAIN_ID) fail('bad-input', `chainId ${n} is outside 1 to 2^53 - 1: not a supported chain (TAP-10 §12.1)`)
}

/** uint32(0) ‖ uint64(chainId) ‖ container; a 32-byte hex endpoint passes through / 端点号；32 字节端点原样使用 */
// `opts` may be left out, undefined, null or false (all: not in the conformance mode), as 1.4 ignored a third argument.
// `opts` 可以省略，或为 undefined、null、false（都表示不开一致模式），因为 1.4 忽略第三个参数。
export function endpoint(target, chainId = 56, opts) {
  const strict = conformOf(opts && typeof opts === 'object' ? opts.conform : undefined)
  if (typeof target === 'string' && /^0x[0-9a-fA-F]{64}$/.test(target)) {
    const b = hexToBytes(target)
    if (b[0] | b[1] | b[2] | b[3]) fail('bad-input', 'endpoint reserved bits must be zero')
    if (b.slice(4, 12).every((x) => x === 0) || b.slice(12).every((x) => x === 0)) fail('bad-input', 'endpoint chain id and container must be non-zero')
    if (strict) { let id = 0n; for (let i = 4; i < 12; i++) id = (id << 8n) | BigInt(b[i]); tap10Chain(id, true) }
    return b
  }
  const id = BigInt(chainId)
  if (!(id >= 1n && id < 1n << 64n)) fail('bad-input', 'chainId must fit in 64 bits')
  tap10Chain(id, strict)
  const out = new Uint8Array(32)
  for (let i = 0; i < 8; i++) out[4 + i] = Number((id >> BigInt(8 * (7 - i))) & 0xffn)
  out.set(addr20(target, 'container'), 12)
  return out
}

/** First 8 bytes of SHA-256(publicKey) / 公钥指纹 */
export const fingerprint = (publicKey) => sha256(publicKey).slice(0, 8)

function sharedSecret(secretKey, publicKey) {
  let ss
  try { ss = x25519.getSharedSecret(secretKey, publicKey) } catch { fail('bad-key', 'X25519 key agreement failed (invalid or low-order key)') }
  if (ss.every((b) => b === 0)) fail('bad-key', 'all-zero X25519 shared secret')
  return ss
}

/** TAP-10 §4.4: canonical, top bit clear, not low order / 规范编码、最高位为 0、非低阶点 */
export function assertValidPublicKey(publicKey) {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) fail('bad-key', 'public key must be 32 bytes')
  if (publicKey[31] & 0x80) fail('bad-key', 'public key top bit set')
  let u = 0n
  for (let i = 31; i >= 0; i--) u = (u << 8n) | BigInt(publicKey[i])
  if (u >= P_FIELD) fail('bad-key', 'public key not canonical')
  sharedSecret(Uint8Array.of(...new Uint8Array(31).fill(0x11), 0x41), publicKey)
}

// T = "TAP-10/X/v2" ‖ to ‖ from ‖ ref ‖ hub
// TAP-10 §15.3: `to` is on the recipient's chain (`toChainId`), `from` on the sending chain (`chainId`). Without `toChainId`
// both use `chainId`, which is right for a same-chain send. A 32-byte endpoint carries its own chain and ignores both.
// TAP-10 §15.3：`to` 在收件方所在链（toChainId），`from` 在发送链（chainId）。不给 toChainId 时两者都用 chainId（同链发送）；32 字节端点自带链，不受两者影响。
function context({ to, from, hub, ref, chainId = 56, toChainId, conform }) {
  const r = ref === undefined || ref === null ? ZERO_REF : bytes32(ref, 'ref')
  return concat(ascii('TAP-10/X/v2'), endpoint(to, toChainId ?? chainId, { conform }), endpoint(from, chainId, { conform }), r, addr20(hub, 'hub'))
}
const commitment = (K) => sha256(concat(ascii('TAP-10/commit/v2'), K))
const kek = (ss, E, R, T) => hkdf(sha256, ss, ascii('TAP-10/wrap/v2'), concat(E, R, T), 32)

/** §5.2 public (unencrypted) payload / 公开载荷 */
export function encodePublic(content) {
  const payload = concat(MAGIC, Uint8Array.of(FORMAT_VERSION, KIND_PUBLIC), content)
  if (payload.length > MAX_PAYLOAD) fail('too-large', `payload ${payload.length} > ${MAX_PAYLOAD}`)
  return payload
}

/**
 * §5.3 seal `content` to 1..16 recipient keys. `to`/`from` are containers (or 32-byte endpoints), `hub` the DeWebHub
 * the message is sent through, `ref` the message replied to (32 bytes) or nothing. `random` is for test vectors only.
 * `chainId` is the sending chain (the `from` endpoint; the hub is on it). For a recipient on another chain pass
 * `toChainId` (the `to` endpoint's chain, default `chainId`), or pass `to` as a ready 32-byte endpoint (TAP-10 §15.3).
 * `chainId` 是发送链（`from` 端点所在链，中枢也在这条链上）。收件方在另一条链时传 `toChainId`（`to` 端点所在链，默认等于 `chainId`），或直接把 `to` 传成现成的 32 字节端点（TAP-10 §15.3）。
 * The official client seals to the recipient AND the sender's own key, so the sender can read its outbox; pass both.
 * `conform: 'tap10'` (@experimental, 1.5): every chainId at most 2^53 − 1 (TAP-10 §12.1).
 * 把 content 封装给 1..16 把收件人公钥。官方客户端同时封装给收件人与发件人自己的密钥，以便发件人查看发件箱。
 */
export function seal({ content, recipients, to, from, hub, ref, chainId = 56, toChainId, conform, random = randomBytes }) {
  if (!(content instanceof Uint8Array)) fail('bad-input', 'content must be bytes')
  if (!Array.isArray(recipients) || recipients.length < 1 || recipients.length > MAX_SLOTS) fail('bad-input', `1..${MAX_SLOTS} recipient keys required`)
  recipients.forEach((R, i) => {
    assertValidPublicKey(R)
    for (let j = 0; j < i; j++) if (equal(R, recipients[j])) fail('bad-input', 'duplicate recipient key')
  })
  const T = context({ to, from, hub, ref, chainId, toChainId, conform })
  const e = random(32)
  const E = x25519.getPublicKey(e)
  const N = random(24)
  const K = random(32)
  const P = concat(MAGIC, Uint8Array.of(FORMAT_VERSION, KIND_SEALED), E, N, commitment(K), Uint8Array.of(recipients.length))
  const S = concat(...recipients.map((R) => {
    const kk = kek(sharedSecret(e, R), E, R, T)
    if (equal(kk, K)) fail('bad-input', 'content key collides with a key-encryption key')
    return concat(fingerprint(R), xchacha20poly1305(kk, N, concat(P, T)).encrypt(K))
  }))
  const C = xchacha20poly1305(K, N, concat(P, S, T)).encrypt(content)
  e.fill(0); K.fill(0)
  const payload = concat(P, S, C)
  if (payload.length > MAX_PAYLOAD) fail('too-large', `payload ${payload.length} > ${MAX_PAYLOAD}`)
  return payload
}

function parse(payload) {
  if (!(payload instanceof Uint8Array) || payload.length < 4) fail('unsupported', 'payload too short')
  if (payload.length > MAX_PAYLOAD) fail('unsupported', 'payload too large')
  if (payload[0] !== MAGIC[0] || payload[1] !== MAGIC[1] || payload[2] !== FORMAT_VERSION) fail('unsupported', 'unknown magic or version')
  if (payload[3] === KIND_PUBLIC) return { kind: 'public', content: payload.slice(4) }
  if (payload[3] !== KIND_SEALED) fail('unsupported', 'unknown kind')
  if (payload.length < PREAMBLE) fail('damaged', 'sealed payload too short')
  const n = payload[92]
  if (n < 1 || n > MAX_SLOTS || payload.length < PREAMBLE + SLOT * n + TAG) fail('damaged', 'bad slot count or length')
  const slots = []
  for (let i = 0; i < n; i++) { const at = PREAMBLE + SLOT * i; slots.push({ fp: payload.slice(at, at + 8), wrapped: payload.slice(at + 8, at + SLOT) }) }
  return { kind: 'sealed', E: payload.slice(4, 36), N: payload.slice(36, 60), commit: payload.slice(60, 92), slots, P: payload.slice(0, PREAMBLE), S: payload.slice(PREAMBLE, PREAMBLE + SLOT * n), C: payload.slice(PREAMBLE + SLOT * n) }
}

/** §5.3 open with the recipient's secret key; the same outcomes as the reference module. `chainId` / `toChainId` as in `seal`. / 用收件人私钥打开；`chainId` / `toChainId` 含义同 `seal` */
export function open({ payload, secretKey, to, from, hub, ref, chainId = 56, toChainId, conform }) {
  conformOf(conform)
  const p = parse(payload)
  if (p.kind === 'public') return { kind: 'public', content: p.content }
  try { assertValidPublicKey(p.E) } catch { fail('damaged', 'ephemeral key is invalid') }
  if (!secretKey) fail('not-for-key', 'a secret key is required to open a sealed message')
  const T = context({ to, from, hub, ref, chainId, toChainId, conform })
  const R = x25519.getPublicKey(secretKey)
  const fp = fingerprint(R)
  let K = null, ss = null, matched = false
  for (const s of p.slots) {
    if (!equal(s.fp, fp)) continue
    matched = true
    ss ??= sharedSecret(secretKey, p.E)
    let c
    try { c = xchacha20poly1305(kek(ss, p.E, R, T), p.N, concat(p.P, T)).decrypt(s.wrapped) } catch { continue }
    if (!equal(commitment(c), p.commit)) continue
    K = c
    break
  }
  if (!K) fail(matched ? 'damaged' : 'not-for-key', matched ? 'a key slot for this key did not open' : 'no key slot opens with this key')
  try { return { kind: 'sealed', content: xchacha20poly1305(K, p.N, concat(p.P, p.S, T)).decrypt(p.C) } } catch { fail('damaged', 'content failed authentication') }
}

/**
 * keccak256("TAP-10/msg/v2" ‖ uint256 chainId ‖ hub ‖ to ‖ uint256 inboxIndex) / 消息 ID（回复时作为 ref）。
 * TAP-10 §17: `chainId` is the chain whose hub holds the entry (the hub's chain); the `to` endpoint is on the recipient's chain,
 * so for a recipient elsewhere pass `toChainId` (default `chainId`) or a 32-byte endpoint.
 * §17：`chainId` 是存放该条目的链（中枢所在链）；`to` 端点在收件方所在链，收件方在别的链时传 `toChainId`（默认等于 `chainId`）或 32 字节端点。
 */
export function messageId({ chainId = 56, toChainId, hub, to, inboxIndex, conform }) {
  const u256 = (v) => { const b = new Uint8Array(32); let x = BigInt(v); for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n } return b }
  // the hub's chain is a chain too / 中枢所在链也是一条链
  tap10Chain(chainId, conformOf(conform))
  return toHex(keccak_256(concat(ascii('TAP-10/msg/v2'), u256(chainId), addr20(hub, 'hub'), endpoint(to, toChainId ?? chainId, { conform }), u256(inboxIndex))))
}

/**
 * The DeWebHub `send(circuits, tokenId, to, ref, payload)` transaction. Only the circuit's holder can send: the hub
 * derives the sender container itself, so `from` cannot be forged. Non-payable; no protocol fee. `chainId` is the hub's
 * chain; a recipient on another chain: pass `toChainId` (default `chainId`) or a 32-byte endpoint as `to`.
 * 无法伪造。`chainId` 是中枢所在链；收件方在另一条链时传 `toChainId`（默认等于 `chainId`）或把 `to` 传成 32 字节端点。
 * DeWebHub 的 send 交易。只有电路持有人能发送：中枢自己推导发件容器，`from` 无法伪造。不可附带 BNB，无协议费。
 */
export function sendTx({ hub, circuits, tokenId, to, ref, payload, chainId = 56, toChainId, conform }) {
  if (!(payload instanceof Uint8Array) || payload.length === 0 || payload.length > MAX_PAYLOAD) fail('bad-input', `payload must be 1..${MAX_PAYLOAD} bytes`)
  tap10Chain(chainId, conformOf(conform))
  const args = [circuits, BigInt(tokenId), toHex(endpoint(to, toChainId ?? chainId, { conform })), ref ? toHex(bytes32(ref, 'ref')) : toHex(ZERO_REF), payload]
  return { to: hub, data: SEND_SELECTOR + bytesToHex(encodeParams(['address', 'uint256', 'bytes32', 'bytes32', 'bytes'], args)), value: '0x0' }
}
