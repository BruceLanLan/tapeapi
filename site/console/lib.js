// The holder console's logic, with no dependency: chain reads through any eth_call function, the delegation the holder
// signs (EIP-712, TAP-20), the manifest check and the SiteRegistry.putFile call that publishes it. sdk/test/console.test.mjs
// checks every byte of it against the SDK, so the page cannot build something the SDK would not.
// 持有人操作台的逻辑，不依赖任何库：经任意 eth_call 函数读链、持有人签的委托（EIP-712，TAP-20）、清单核对，以及发布清单的
// SiteRegistry.putFile 调用。sdk/test/console.test.mjs 逐字节对照 SDK 检查，页面构造不出 SDK 不会构造的东西。

export const CHAIN_ID = 56
export const FACTORY = '0x68224F668083c29e9800Be2a646d42d18cedF7e2'        // TapeOut processor factory / 处理器工厂
export const HUB = '0xe61A9C7213a6Aa616C246a2B569e555B417b25ee'            // DeWebHub
export const SITE_REGISTRY = '0xd006ffdd5Ae313B17729621A00999cD3C71CE5e6'
export const MANIFEST_KEY = '.well-known/tapeapi.json'                       // no leading slash (TapeKit SPEC §6) / 不带前导斜杠
export const MANIFEST_LIMIT = 24_000                                         // one putFile / 一笔 putFile
export const SEL = { cpuAt: '0x4bc7cbbd', isCPU: '0x5f5a364f', accountOf: '0x0c1905e5', ownerOf: '0x6352211e', putFile: '0xfab2ed82' }
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n   // secp256k1 order / 阶

const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)
const word = (n) => BigInt(n).toString(16).padStart(64, '0')
const addrWord = (a) => { if (!isAddr(a)) throw new Error(`not an address: ${a}`); return a.slice(2).toLowerCase().padStart(64, '0') }
const addrOf = (ret) => { const h = String(ret).replace(/^0x/, ''); if (h.length < 64) throw new Error('not an address answer (no code there?)'); return '0x' + h.slice(24, 64) }
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
const pad32 = (h) => h + '0'.repeat((64 - (h.length % 64)) % 64)
const dyn = (bytes) => word(bytes.length) + pad32(hex(bytes))

/** Read a TapeOut circuit: processor contract, container, current holder. `call(to, data)` returns the hex result.
 *  读一个 TapeOut 电路：处理器合约、容器、当前持有人。 */
export async function readCircuit(call, { processor, tokenId }) {
  processor = String(processor).trim(); tokenId = String(tokenId).trim()
  if (!/^\d{1,15}$/.test(processor)) throw new Error('processor number must be a whole number')
  if (!/^\d{1,15}$/.test(tokenId) || BigInt(tokenId) < 1n) throw new Error('circuit number (#ID) must be 1 or more')
  tokenId = String(BigInt(tokenId))   // "01" -> "1": the manifest's tokenId has no leading zeros (TAP-20) / 去掉前导零
  const circuits = addrOf(await call(FACTORY, SEL.cpuAt + word(processor)))
  if (BigInt(await call(FACTORY, SEL.isCPU + addrWord(circuits))) !== 1n) throw new Error(`${circuits} is not a TapeOut processor`)
  const container = addrOf(await call(HUB, SEL.accountOf + addrWord(circuits) + word(tokenId)))
  const holder = addrOf(await call(circuits, SEL.ownerOf + word(tokenId)))
  return { circuits, tokenId, container, holder }
}

/** A new service signing key from a CSPRNG, as 0x-hex. / 用安全随机数生成新的服务签名密钥。 */
export function newSignerKey(getRandomValues = (b) => globalThis.crypto.getRandomValues(b)) {
  for (;;) {
    const k = BigInt('0x' + hex(getRandomValues(new Uint8Array(32))))
    if (k > 0n && k < N) return '0x' + word(k)
  }
}

/** The EIP-712 delegation the holder signs (eth_signTypedData_v4), exactly as sdk sig.delegationTypedData builds it.
 *  持有人签的 EIP-712 委托，与 SDK 构造的完全一致。 */
export function delegationTypedData({ container, signer, expires }) {
  if (!isAddr(container) || !isAddr(signer)) throw new Error('container and signer must be addresses')
  return {
    domain: { name: 'TapeAPI', version: '1', chainId: CHAIN_ID, verifyingContract: HUB },
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
    message: { container, signer, expires: Number(expires) },
  }
}

// ---------------------------------------------------------------- the service key's address ----
// The page derives the address of the key it generated, so step 6 signs a delegation only for THAT key, never for
// whatever address the service happens to report (a mistyped service URL, a second key pasted by mistake). Keccak-256
// and secp256k1 are written out here because the page loads nothing; sdk/test/console.test.mjs checks both against the
// SDK (noble). The key is used once, in the holder's own browser, so constant time is not a goal.
// 页面自己推导它生成的密钥的地址，第 6 步只为**这个**密钥签委托，而不是服务报出的任意地址（服务网址填错、误贴了第二把密钥）。
// 页面不加载任何库，所以 Keccak-256 和 secp256k1 在这里写出；console.test.mjs 对照 SDK（noble）检查。密钥只在持有人自己的浏览器里用一次，不追求常数时间。
const M64 = (1n << 64n) - 1n
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14].map(BigInt)   // lane x + 5y
const RC = []
for (let i = 0, R = 1; i < 24; i++) {
  let rc = 0n
  for (let j = 0; j < 7; j++) { R = ((R << 1) ^ ((R >> 7) * 0x71)) & 0xff; if (R & 2) rc |= 1n << ((1n << BigInt(j)) - 1n) }
  RC.push(rc)
}
const rotl = (v, n) => (n ? ((v << n) | (v >> (64n - n))) & M64 : v)
function keccakF(A) {
  for (let r = 0; r < 24; r++) {
    const C = [0, 1, 2, 3, 4].map((x) => A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20])
    for (let x = 0; x < 5; x++) { const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n); for (let y = 0; y < 25; y += 5) A[x + y] ^= D }
    const B = new Array(25)
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y])
    for (let x = 0; x < 5; x++) for (let y = 0; y < 25; y += 5) A[x + y] = B[x + y] ^ (~B[(x + 1) % 5 + y] & M64 & B[(x + 2) % 5 + y])
    A[0] ^= RC[r]
  }
}
/** Keccak-256 (Ethereum's, 0x01 padding) of bytes, as bytes. / 以太坊的 Keccak-256。 */
export function keccak256(bytes) {
  const rate = 136, padded = new Uint8Array((Math.floor(bytes.length / rate) + 1) * rate)
  padded.set(bytes); padded[bytes.length] ^= 0x01; padded[padded.length - 1] ^= 0x80
  const A = new Array(25).fill(0n)
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) { let v = 0n; for (let b = 7; b >= 0; b--) v = (v << 8n) | BigInt(padded[off + 8 * i + b]); A[i] ^= v }
    keccakF(A)
  }
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = Number((A[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn)
  return out
}
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn
const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n]
const mod = (a) => ((a % P) + P) % P
const inv = (a) => { let [r0, r1, s0, s1] = [mod(a), P, 1n, 0n]; while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1] } return mod(s0) }
function add(p, q) {
  if (!p) return q
  if (!q) return p
  if (p[0] === q[0] && mod(p[1] + q[1]) === 0n) return null
  const l = p[0] === q[0] ? mod(3n * p[0] * p[0] * inv(2n * p[1])) : mod((q[1] - p[1]) * inv(q[0] - p[0]))
  const x = mod(l * l - p[0] - q[0])
  return [x, mod(l * (p[0] - x) - p[1])]
}
const mul = (k, pt) => { let acc = null; for (; k; k >>= 1n) { if (k & 1n) acc = add(acc, pt); pt = add(pt, pt) } return acc }
const bytesOfPoint = (pt) => { const b = new Uint8Array(64); for (let i = 0; i < 32; i++) { b[i] = Number((pt[0] >> BigInt(8 * (31 - i))) & 0xffn); b[32 + i] = Number((pt[1] >> BigInt(8 * (31 - i))) & 0xffn) } return b }
const pow = (b, e) => { let r = 1n; b = mod(b); for (; e; e >>= 1n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P } return r }
const bytes = (h) => Uint8Array.from(h.replace(/^0x/, '').match(/../g) || [], (x) => parseInt(x, 16))
const kec = (...parts) => keccak256(bytes(parts.map((p) => (typeof p === 'string' ? p.replace(/^0x/, '') : hex(p))).join('')))
const utf8 = (t) => new TextEncoder().encode(t)

/** The EIP-712 digest of a Delegation, exactly as the SDK's sig.delegationDigest(56, HUB, …). / 委托的 EIP-712 摘要。 */
export function delegationDigest({ container, signer, expires }) {
  const domain = kec(kec(utf8('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')), kec(utf8('TapeAPI')), kec(utf8('1')), word(CHAIN_ID), addrWord(HUB))
  const struct = kec(kec(utf8('Delegation(address container,address signer,uint64 expires)')), addrWord(container), addrWord(signer), word(expires))
  return kec('1901', domain, struct)
}

/** The address that made a 65-byte signature over a 32-byte digest (v may be 27/28 or 0/1), or null.
 *  对 32 字节摘要做出 65 字节签名的地址（v 可为 27/28 或 0/1），无法恢复时为 null。 */
export function recoverAddress(digest, signature) {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return null
  const r = BigInt('0x' + signature.slice(2, 66)), s = BigInt('0x' + signature.slice(66, 130)), v = parseInt(signature.slice(130), 16)
  const parity = v >= 27 ? v - 27 : v
  // s above n/2 is refused as the SDK and the contracts refuse it (a malleable twin): publishing one would put a delegation
  // on chain that every client rejects (review R7-3). / s 大于 n/2 与 SDK、合约一样拒绝：发布它会上链一份所有客户端都拒绝的委托。
  if (parity !== 0 && parity !== 1 || r <= 0n || r >= N || s <= 0n || s > N >> 1n) return null
  const y2 = mod(r * r * r + 7n)
  let y = pow(y2, (P + 1n) / 4n)
  if ((y * y) % P !== y2) return null
  if (Number(y & 1n) !== parity) y = P - y
  const nmod = (a) => ((a % N) + N) % N
  const rInv = (() => { let [r0, r1, s0, s1] = [r, N, 1n, 0n]; while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1] } return nmod(s0) })()
  const e = nmod(BigInt('0x' + hex(digest)))
  const Q = add(mul(nmod(-e * rInv), G), mul(nmod(s * rInv), [r, y]))
  return Q ? checksum('0x' + hex(keccak256(bytesOfPoint(Q)).subarray(12))) : null
}

/** EIP-55 checksummed form of an address. / EIP-55 校验和格式的地址。 */
export function checksum(address) {
  if (!isAddr(address)) throw new Error(`not an address: ${address}`)
  const a = address.slice(2).toLowerCase(), h = hex(keccak256(new TextEncoder().encode(a)))
  return '0x' + Array.from(a, (c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('')
}
/** The address of a 0x-hex private key (what the service will report as its signer). / 私钥对应的地址。 */
export function addressOfKey(key) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('a key is 32 bytes of hex')
  let k = BigInt(key)
  if (k <= 0n || k >= N) throw new Error('key outside the curve order')
  return checksum('0x' + hex(keccak256(bytesOfPoint(mul(k, G))).subarray(12)))
}

// ---------------------------------------------------------------- the manifest ----
/** A service base URL: https://host[:port], or http on a loopback address for local testing (as the Worker allows).
 *  服务基础网址：https://主机[:端口]；本地测试时允许回环地址用 http（与 Worker 一致）。 */
export const isServiceBase = (u) => /^https:\/\/[^/?#@\s]+$/.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(u)
const METHODS = [{ name: 'blockNumber', priceBEM: '0', params: {}, returns: { blockNumber: 'number' } }]
const NAME_OK = (n) => typeof n === 'string' && n.length >= 1 && n.length <= 64 && !/[\u0000-\u001f\u007f]/.test(n)

/** The manifest the page publishes, built from what the holder read and signed, never taken from the service: the same
 *  fields in the same order as examples/cloudflare-worker/worker.js build() (a test keeps the two equal). Only the display
 *  name may come from the service, and the holder sees it before signing the transaction.
 *  页面发布的清单：由持有人读到和签过的内容构造，不取自服务；字段和顺序与 worker.js build() 相同（有测试保证一致）。
 *  只有显示名称可以来自服务，并且持有人在签交易之前能看到它。 */
export function expectedManifest({ circuits, tokenId, container, signer, expires, sig, endpoint, name = 'TapeAPI Reader' }) {
  if (!NAME_OK(name)) throw new Error('name must be 1 to 64 printable characters')
  if (!isServiceBase(String(endpoint).replace(/\/tapeapi\/v1$/, '')) || !String(endpoint).endsWith('/tapeapi/v1')) throw new Error(`endpoint must be https://<host>/tapeapi/v1, not ${endpoint}`)
  return {
    tapeapi: '0.1', name, circuits, tokenId: String(tokenId), container, signer,
    delegation: { expires: Number(expires), sig },
    endpoints: { live: [endpoint], async: false },
    methods: METHODS,
  }
}

// A hostile service must not get to write sentences on the page: what it sent is quoted, and cut short.
// 恶意服务不能借机在页面上写句子：它发来的内容加引号并截短。
const clip = (v) => { const t = JSON.stringify(v) ?? String(v); return t.length > 48 ? t.slice(0, 45) + '…' : t }

// Key order and hex case do not matter when comparing; every other difference does. / 比较时不计键序与十六进制大小写，其余差异都算。
const norm = (v) => Array.isArray(v) ? v.map(norm)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]))
  : typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v) ? v.toLowerCase() : v

/** What differs between the manifest the service serves and the one the page will publish ([] when they agree).
 *  Any field the page did not build (payment, dev, a second endpoint, other prices) is a difference.
 *  服务提供的清单与页面将发布的清单有何不同（一致则为空）。页面没构造的任何字段（payment、dev、第二个端点、别的价格）都算不同。 */
export function manifestProblems(text, s) {
  let m
  try { m = JSON.parse(text) } catch { return ['not JSON'] }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['not a JSON object']
  let want
  try { want = expectedManifest({ ...s, name: NAME_OK(m.name) ? m.name : undefined }) } catch (e) { return [e.message] }
  const out = []
  if (!NAME_OK(m.name)) out.push('name must be 1 to 64 printable characters')
  for (const k of new Set([...Object.keys(want), ...Object.keys(m)])) {
    if (!(k in want)) out.push(`unexpected field ${clip(k)}`)
    else if (!(k in m)) out.push(`missing field "${k}"`)
    else if (JSON.stringify(norm(m[k])) !== JSON.stringify(norm(want[k]))) out.push(`${k} is ${clip(m[k])}, expected ${clip(want[k])}`)
  }
  return out
}

/** The exact text the page publishes. / 页面发布的确切文本。 */
export const manifestText = (s) => JSON.stringify(expectedManifest(s))

// ---------------------------------------------------------------- a first frame on mainnet ----
/** The probe room: "tapeapi deploy probe" in ASCII, as DEPLOY-CHANNELBUS.md uses. / 测试房间：与部署手册相同的 ASCII 房间号。 */
export const PROBE_ROOM = '74617065617069206465706c6f792070726f6265000000000000000000000000'
/** ChannelBus.send(PROBE_ROOM, wire) as a transaction: a first real frame, read back by scripts/night.mjs bus-read.
 *  `wire` is 0x02 followed by the UTF-8 of `text` (at most MAX_WIRE bytes). / 发一条真实的测试帧，之后用只读脚本读回。 */
export function probeTx({ bus, text }) {
  if (!isAddr(bus)) throw new Error('bus must be an address')
  const wire = new Uint8Array([0x02, ...new TextEncoder().encode(text)])
  if (wire.length > 16_448) throw new Error('wire too long')
  const data = '0x4fdf7085' + PROBE_ROOM + word(64) + dyn(wire)
  return { to: bus, data: data.toLowerCase(), value: '0x0' }
}

/** SiteRegistry.putFile(container, ".well-known/tapeapi.json", "application/json", sha256, bytes) as a transaction.
 *  `sha256Hex` is the SHA-256 of `text`'s UTF-8 bytes (the page computes it with SubtleCrypto).
 *  发布清单的 putFile 交易。 */
export function putFileTx({ container, text, sha256Hex, contentType = 'application/json' }) {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length > MANIFEST_LIMIT) throw new Error(`manifest is ${bytes.length} bytes; one putFile carries ${MANIFEST_LIMIT}`)
  if (!/^0x[0-9a-f]{64}$/i.test(sha256Hex)) throw new Error('sha256 must be 32 bytes of hex')
  const key = new TextEncoder().encode(MANIFEST_KEY), type = new TextEncoder().encode(contentType)
  const k = dyn(key), t = dyn(type)
  const head = 5 * 32
  const data = SEL.putFile + addrWord(container) + word(head) + word(head + k.length / 2) + sha256Hex.slice(2).toLowerCase() + word(head + k.length / 2 + t.length / 2) + k + t + dyn(bytes)
  return { to: SITE_REGISTRY, data: data.toLowerCase(), value: '0x0' }
}
