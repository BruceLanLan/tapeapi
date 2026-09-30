import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils'
import { TapeAPIError } from './errors.js'
import { canonicalJSON } from './canon.js'
import { hexToBytes, toHex, checksumAddress, encodeParams, isAddress } from './abi.js'


// ---------- 私钥 / keys ----------
function normPriv(pk) {
  const b = typeof pk === 'string' ? hexToBytes(pk) : pk
  if (b.length !== 32) throw new TapeAPIError('BAD_KEY', 'private key must be 32 bytes')
  return b
}
export function privateKeyToAddress(pk) {
  const pub = secp256k1.getPublicKey(normPriv(pk), false)
  return checksumAddress(toHex(keccak_256(pub.subarray(1)).subarray(12)))
}
export function randomPrivateKey() { return toHex(secp256k1.utils.randomPrivateKey()) }

// ---------- EIP-191 ----------
// personal_sign over 32-byte digest / 对 32 字节摘要做 EIP-191 前缀哈希。
export function personalDigest(digest) {
  const d = typeof digest === 'string' ? hexToBytes(digest) : digest
  return keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${d.length}`), d))
}

// ---------- 签名 / 恢复 sign / recover ----------
export function signDigest(digest, pk) {
  const d = typeof digest === 'string' ? hexToBytes(digest) : digest
  if (d.length !== 32) throw new TapeAPIError('BAD_SIGNATURE', 'digest must be 32 bytes')
  const s = secp256k1.sign(d, normPriv(pk), { lowS: true })
  const out = new Uint8Array(65); out.set(s.toCompactRawBytes()); out[64] = 27 + s.recovery
  return toHex(out)
}
export function parseSignature(sig) {
  const b = typeof sig === 'string' ? hexToBytes(sig) : sig
  if (b.length !== 65) throw new TapeAPIError('BAD_SIGNATURE', 'signature must be 65 bytes')
  let v = b[64]; if (v === 0 || v === 1) v += 27
  if (v !== 27 && v !== 28) throw new TapeAPIError('BAD_SIGNATURE', 'bad v')
  return { r: b.subarray(0, 32), s: b.subarray(32, 64), v }
}
const CURVE_N = secp256k1.CURVE.n
const HALF_N = CURVE_N >> 1n
const bytesToBigInt = (b) => BigInt('0x' + bytesToHex(b))
// 与合约 ECDSA.recover 一致：拒绝高 s（s > n/2）与 v ∉ {27,28}（0/1 先归一化）。高 s 的凭证链上无法结算（C-02）。
// Mirrors the contract's ECDSA.recover: rejects high-s (s > n/2) and v outside {27,28} after normalising 0/1.
// A high-s voucher can never settle on-chain, so it must not be accepted off-chain either (review C-02).
export function recoverAddress(digest, sig) {
  const d = typeof digest === 'string' ? hexToBytes(digest) : digest
  const { r, s, v } = parseSignature(sig)
  const S = bytesToBigInt(s), R = bytesToBigInt(r)
  if (S === 0n || S >= CURVE_N || R === 0n || R >= CURVE_N) throw new TapeAPIError('BAD_SIGNATURE', 'r/s out of range')
  if (S > HALF_N) throw new TapeAPIError('BAD_SIGNATURE', 'high-s signature (malleable); s must be <= n/2')
  try {
    const sigObj = secp256k1.Signature.fromCompact(concatBytes(r, s)).addRecoveryBit(v - 27)
    const pub = sigObj.recoverPublicKey(d).toRawBytes(false)
    return checksumAddress(toHex(keccak_256(pub.subarray(1)).subarray(12)))
  } catch (e) {
    throw new TapeAPIError('BAD_SIGNATURE', `recover failed: ${e.message}`)
  }
}

// ---------- EIP-712 ----------
const DOMAIN_TYPEHASH = keccak_256(utf8ToBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'))
export const DELEGATION_TYPE = 'Delegation(address container,address signer,uint64 expires)'
export const VOUCHER_TYPE = 'Voucher(address consumer,address provider,uint256 cumulative,uint64 expires)'
export const DELEGATION_TYPEHASH = keccak_256(utf8ToBytes(DELEGATION_TYPE))
export const VOUCHER_TYPEHASH = keccak_256(utf8ToBytes(VOUCHER_TYPE))
// TAP-26 §3.1: the holder authorises a container's channel identity (an X25519 key for handshakes, an Ed25519 key for
// group messages). A distinct type name, so a TAP-20 Delegation can never be replayed as a channel authorisation.
// 持有人授权容器的通道身份（握手用 X25519、群消息用 Ed25519）。类型名不同，TAP-20 委托绝不能被当作通道授权重放。
// `issued` orders records: a client refuses one older than a record it has already seen for that container, so whoever
// can write the site cannot bring back a record the holder replaced (arch B4).
// `issued` 给记录定序：客户端拒绝比已见过的更旧的记录，能写站点的人因此无法恢复持有人已替换的记录。
export const CHANNEL_KEYS_TYPE = 'ChannelKeys(address container,bytes32 x25519,bytes32 ed25519,bytes32 inbox,uint64 issued,uint64 expires)'
// The inbox (where invites to this container go) is signed too: otherwise anyone able to write the site could send
// the container's invites to their own relay. inbox = keccak256(utf8(canonicalJSON({ relays, bus? }))).
// 收件地址（邀请发往何处）也在签名范围内，否则任何能写站点的人都能把邀请引到自己的中继。
export function channelInboxHash(inbox = {}) {
  const norm = { relays: (inbox.relays ?? []).map((r) => ({ url: r.url, container: r.container })), ...(inbox.bus ? { bus: inbox.bus } : {}) }
  return keccak_256(utf8ToBytes(canonicalJSON(norm)))
}
export const CHANNEL_KEYS_TYPEHASH = keccak_256(utf8ToBytes(CHANNEL_KEYS_TYPE))

export function domainSeparator({ name, version, chainId, verifyingContract }) {
  if (!isAddress(verifyingContract)) throw new TapeAPIError('ABI_INVALID', 'verifyingContract must be address')
  return keccak_256(encodeParams(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
    [DOMAIN_TYPEHASH, keccak_256(utf8ToBytes(name)), keccak_256(utf8ToBytes(version)), BigInt(chainId), verifyingContract]))
}
export function hashDelegation({ container, signer, expires }) {
  return keccak_256(encodeParams(['bytes32', 'address', 'address', 'uint64'], [DELEGATION_TYPEHASH, container, signer, BigInt(expires)]))
}
export function hashVoucher({ consumer, provider, cumulative, expires }) {
  return keccak_256(encodeParams(['bytes32', 'address', 'address', 'uint256', 'uint64'], [VOUCHER_TYPEHASH, consumer, provider, BigInt(cumulative), BigInt(expires)]))
}
export function hashChannelKeys({ container, x25519, ed25519, inbox, issued, expires }) {
  const ih = inbox instanceof Uint8Array ? inbox : channelInboxHash(inbox)
  return keccak_256(encodeParams(['bytes32', 'address', 'bytes32', 'bytes32', 'bytes32', 'uint64', 'uint64'], [CHANNEL_KEYS_TYPEHASH, container, x25519, ed25519, ih, BigInt(issued), BigInt(expires)]))
}
// "\x19\x01" ‖ domainSeparator ‖ hashStruct
export function typedDigest(domain, structHash) {
  return keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), domainSeparator(domain), structHash))
}
// 委托的域锚定在 DeWebHub，而不是服务目录：委托只是"持有人授权了这个签名者"，没有目录也成立。
// 绑定到目录会让一个可选合约变成必需品（零部署就无法使用服务）。中枢已部署、按链区分、且容器由它推导。
// The delegation domain is anchored on the DeWebHub, not the directory: a delegation is just holder consent
// and is meaningful without a directory. Anchoring it on the directory would make an optional contract
// mandatory. The hub is already deployed, is per-chain, and is what derives the container.
export function delegationDomain(chainId, hub) { return { name: 'TapeAPI', version: '1', chainId, verifyingContract: hub } }
export function voucherDomain(chainId, escrow) { return { name: 'TapeAPIEscrow', version: '1', chainId, verifyingContract: escrow } }
export function delegationDigest(chainId, hub, d) { return typedDigest(delegationDomain(chainId, hub), hashDelegation(d)) }
export function voucherDigest(chainId, escrow, v) { return typedDigest(voucherDomain(chainId, escrow), hashVoucher(v)) }
// Same domain as the TAP-20 delegation (anchored on the hub), different struct / 与 TAP-20 委托同域、不同结构
export function channelKeysDigest(chainId, hub, k) { return typedDigest(delegationDomain(chainId, hub), hashChannelKeys(k)) }
export function channelKeysTypedData(chainId, hub, k) {
  return {
    domain: delegationDomain(chainId, hub),
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
      ],
      ChannelKeys: [
        { name: 'container', type: 'address' }, { name: 'x25519', type: 'bytes32' },
        { name: 'ed25519', type: 'bytes32' }, { name: 'inbox', type: 'bytes32' }, { name: 'issued', type: 'uint64' },
        { name: 'expires', type: 'uint64' },
      ],
    },
    primaryType: 'ChannelKeys',
    message: { container: k.container, x25519: k.x25519, ed25519: k.ed25519, inbox: toHex(channelInboxHash(k.inbox)), issued: Number(k.issued), expires: Number(k.expires) },
  }
}

// 钱包 signTypedData 用的完整 payload / Full typed-data payload for wallet signTypedData_v4.
// The holder signs the delegation with the wallet that holds the circuit; no private key ever leaves it.
// 持有人用持有电路的那个钱包签署委托，私钥不必离开钱包。
export function delegationTypedData(chainId, hub, d) {
  return {
    domain: delegationDomain(chainId, hub),
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
      ],
      Delegation: [
        { name: 'container', type: 'address' }, { name: 'signer', type: 'address' }, { name: 'expires', type: 'uint64' },
      ],
    },
    primaryType: 'Delegation',
    message: { container: d.container, signer: d.signer, expires: Number(d.expires) },
  }
}
export function voucherTypedData(chainId, escrow, v) {
  return {
    domain: voucherDomain(chainId, escrow),
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
      ],
      Voucher: [
        { name: 'consumer', type: 'address' }, { name: 'provider', type: 'address' },
        { name: 'cumulative', type: 'uint256' }, { name: 'expires', type: 'uint64' },
      ],
    },
    primaryType: 'Voucher',
    message: { consumer: v.consumer, provider: v.provider, cumulative: BigInt(v.cumulative).toString(), expires: Number(v.expires) },
  }
}

// ---------- TAP-20 §3.10 manifest content signature (security 1.1, OPTIONAL) / 清单内容签名（可选） ----------
// A delegation covers (container, signer, expires) only: whoever can write the site can change endpoints, `ai.baseUrl`
// or prices under a valid delegation, and a caller's API key goes to `ai.baseUrl` before any receipt is checked. The
// holder MAY sign the manifest's content too, in the delegation's domain under a new type name (so neither signature can
// be replayed as the other). contentHash = keccak256(UTF-8(canonicalJSON(manifest without its top-level `contentSig`))),
// over the manifest object exactly as published (not a client's normalised copy).
// 委托只覆盖 (container, signer, expires)：能写站点的人可以在有效委托下改端点、`ai.baseUrl` 或价格，而调用方的 API 密钥在核验
// 回执之前就已发往 `ai.baseUrl`。持有人 MAY 同时签署清单内容：与委托同域、类型名不同（两种签名不能互相重放）。
// contentHash = keccak256(UTF-8(canonicalJSON(去掉顶层 `contentSig` 的清单)))，按发布的原样对象计算（不是客户端规范化后的副本）。
/** @experimental security 1.1 */
export const MANIFEST_CONTENT_FIELD = 'contentSig'
/** @experimental security 1.1 */
export const MANIFEST_CONTENT_TYPE = 'ManifestContent(address container,bytes32 contentHash)'
/** @experimental security 1.1 */
export const MANIFEST_CONTENT_TYPEHASH = keccak_256(utf8ToBytes(MANIFEST_CONTENT_TYPE))
/** @experimental security 1.1: keccak256 of the canonical manifest without `contentSig`, 32 bytes. */
export function manifestContentHash(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new TapeAPIError('MANIFEST_INVALID', 'manifest must be a JSON object')
  const rest = {}
  for (const [k, v] of Object.entries(manifest)) if (k !== MANIFEST_CONTENT_FIELD) rest[k] = v
  return keccak_256(utf8ToBytes(canonicalJSON(rest)))
}
const hash32 = (h) => (h instanceof Uint8Array ? h : hexToBytes(h))
/** @experimental security 1.1 */
export function hashManifestContent({ container, contentHash }) {
  return keccak_256(encodeParams(['bytes32', 'address', 'bytes32'], [MANIFEST_CONTENT_TYPEHASH, container, hash32(contentHash)]))
}
/** @experimental security 1.1: the digest the holder signs (TAP-20 delegation domain). */
export function manifestContentDigest(chainId, hub, { container, contentHash }) {
  return typedDigest(delegationDomain(chainId, hub), hashManifestContent({ container, contentHash }))
}
/** @experimental security 1.1: the eth_signTypedData_v4 payload; `manifest` is the object to publish (without contentSig). */
export function manifestContentTypedData(chainId, hub, { container, manifest }) {
  return {
    domain: delegationDomain(chainId, hub),
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
      ],
      ManifestContent: [{ name: 'container', type: 'address' }, { name: 'contentHash', type: 'bytes32' }],
    },
    primaryType: 'ManifestContent',
    message: { container, contentHash: toHex(manifestContentHash(manifest)) },
  }
}

// ---------- 响应信封摘要 TAP-21 / response envelope digest ----------
function uint64BE(n) {
  const b = new Uint8Array(8); let x = BigInt(n)
  if (x < 0n || x >= (1n << 64n)) throw new TapeAPIError('ABI_INVALID', 'ts out of uint64')
  for (let i = 7; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n }
  return b
}
export const RESPONSE_DIGEST_PREFIX = 'TAPI-1/resp/v2'
// v2 摘要把请求（method, params）与 ok 标志一起签进去：签名的错误信封不能被改标成成功，答案也不能被换到别的问题上（M-07）。
// The v2 digest covers the request ({method, params}) and the ok flag: a signed error cannot be relabelled as a
// result, and an answer cannot be presented as the answer to a different question (review M-07).
//   digest = keccak256("TAPI-1/resp/v2" ‖ container(20) ‖ keccak256(id) ‖ keccak256(canonicalJSON({method, params}))
//                      ‖ uint8(ok ? 1 : 0) ‖ keccak256(canonicalJSON(ok ? result : error)) ‖ uint64BE(ts))
export function responseDigest({ container, id, method, params, ok, body, ts }) {
  if (!isAddress(container)) throw new TapeAPIError('ABI_INVALID', 'container must be address')
  if (typeof id !== 'string') throw new TapeAPIError('ABI_INVALID', 'id must be string')
  if (typeof method !== 'string') throw new TapeAPIError('ABI_INVALID', 'method must be string')
  if (typeof ok !== 'boolean') throw new TapeAPIError('ABI_INVALID', 'ok must be boolean')
  if (params == null) params = {}
  return keccak_256(concatBytes(
    utf8ToBytes(RESPONSE_DIGEST_PREFIX),
    hexToBytes(container),
    keccak_256(utf8ToBytes(id)),
    keccak_256(utf8ToBytes(canonicalJSON({ method, params }))),
    new Uint8Array([ok ? 1 : 0]),
    keccak_256(utf8ToBytes(canonicalJSON(body))),
    uint64BE(ts),
  ))
}
// 信封签名 = EIP-191(digest) / Envelope signature is personal_sign over the digest.
export function signResponse(env, pk) { return signDigest(personalDigest(responseDigest(env)), pk) }
export function recoverResponseSigner(env, sig) { return recoverAddress(personalDigest(responseDigest(env)), sig) }

// The two inner hashes of the digest, as 0x-prefixed hex: what a hash-only receipt carries in place of the request's
// params and the result (sdk mcp.hashReceipt). The digest is rebuilt from them byte for byte, so the signature still
// verifies without the content. / 摘要里的两个内层哈希（0x 十六进制）：只带哈希的回执用它们代替请求参数与结果。
// 摘要可以逐字节由它们重建，签名因此不需要原文也能核验。
const HASH32_RE = /^0x[0-9a-f]{64}$/
export function responseRequestHash({ method, params }) {
  if (typeof method !== 'string') throw new TapeAPIError('ABI_INVALID', 'method must be string')
  return toHex(keccak_256(utf8ToBytes(canonicalJSON({ method, params: params == null ? {} : params }))))
}
export function responseBodyHash(body) { return toHex(keccak_256(utf8ToBytes(canonicalJSON(body)))) }
/** responseDigest from { container, id, requestHash, ok, bodyHash, ts }; the same 32 bytes. / 由两个哈希重建的同一摘要。 */
export function responseDigestFromHashes({ container, id, requestHash, ok, bodyHash, ts }) {
  if (!isAddress(container)) throw new TapeAPIError('ABI_INVALID', 'container must be address')
  if (typeof id !== 'string') throw new TapeAPIError('ABI_INVALID', 'id must be string')
  if (typeof ok !== 'boolean') throw new TapeAPIError('ABI_INVALID', 'ok must be boolean')
  if (typeof requestHash !== 'string' || !HASH32_RE.test(requestHash)) throw new TapeAPIError('ABI_INVALID', 'requestHash must be 0x and 64 lowercase hex digits')
  if (typeof bodyHash !== 'string' || !HASH32_RE.test(bodyHash)) throw new TapeAPIError('ABI_INVALID', 'bodyHash must be 0x and 64 lowercase hex digits')
  return keccak_256(concatBytes(
    utf8ToBytes(RESPONSE_DIGEST_PREFIX),
    hexToBytes(container),
    keccak_256(utf8ToBytes(id)),
    hexToBytes(requestHash),
    new Uint8Array([ok ? 1 : 0]),
    hexToBytes(bodyHash),
    uint64BE(ts),
  ))
}
export function recoverResponseSignerFromHashes(env, sig) { return recoverAddress(personalDigest(responseDigestFromHashes(env)), sig) }

