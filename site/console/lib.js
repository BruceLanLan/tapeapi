// The holder console's logic, with no dependency: chain reads through any eth_call function, the delegation the holder
// signs (EIP-712, TAP-20), the manifest check and the SiteRegistry.putFile call that publishes it. sdk/test/console.test.mjs
// checks every byte of it against the SDK, so the page cannot build something the SDK would not.
// 持有人操作台的逻辑，不依赖任何库：经任意 eth_call 函数读链、持有人签的委托（EIP-712，TAP-20）、清单核对，以及发布清单的
// SiteRegistry.putFile 调用。sdk/test/console.test.mjs 逐字节对照 SDK 检查，页面构造不出 SDK 不会构造的东西。

export const CHAIN_ID = 56
export const FACTORY = '0x68224F668083c29e9800Be2a646d42d18cedF7e2'        // TapeOut processor factory / 处理器工厂
export const HUB = '0xe61A9C7213a6Aa616C246a2B569e555B417b25ee'            // DeWebHub
export const SITE_REGISTRY = '0xd006ffdd5Ae313B17729621A00999cD3C71CE5e6'
// The chains this page publishes on (a copy of sdk/src/chains.js, which console.test.mjs checks it against). X Layer and
// Base carry the same TapeOut contracts at the same addresses; the DeWebHub proxy address is the same on all three, and
// a delegation names its chain in the EIP-712 domain (chainId), so a signature for one chain is not valid on another.
// 本页可以发布的链（sdk/src/chains.js 的副本，console.test.mjs 逐项对照）。X Layer 与 Base 上 TapeOut 合约地址相同；
// DeWebHub 代理地址三条链都相同，委托在 EIP-712 域里写明链号，一条链的签名在另一条链上无效。
const L2 = { factory: '0x1f09DAeFA827f02CBb40967cc91b259763760761', hub: HUB, siteRegistry: '0xd6EFb7adCc9c83dC4924Ad56f6a8E4e969b9ADB6' }
export const CHAINS = Object.freeze({
  56: Object.freeze({ chainId: 56, hex: '0x38', key: 'bnb', name: 'BNB Chain', currency: 'BNB', factory: FACTORY, hub: HUB, siteRegistry: SITE_REGISTRY, explorer: 'https://bscscan.com', explorerName: 'BscScan' }),
  196: Object.freeze({ chainId: 196, hex: '0xc4', key: 'xlayer', name: 'X Layer', currency: 'OKB', ...L2, explorer: 'https://www.oklink.com/xlayer', explorerName: 'OKLink' }),
  8453: Object.freeze({ chainId: 8453, hex: '0x2105', key: 'base', name: 'Base', currency: 'ETH', ...L2, explorer: 'https://basescan.org', explorerName: 'BaseScan' }),
})
/** The chain with this id (a number or its decimal string); anything else is an error. / 该链号的链；其它一律报错。 */
export function chainOf(chainId = CHAIN_ID) {
  const c = Object.prototype.hasOwnProperty.call(CHAINS, String(chainId)) ? CHAINS[String(chainId)] : null
  if (!c) throw new Error(`chain ${chainId} is not one this page publishes on (56, 196, 8453)`)
  return c
}
// The page's chain, set once by the page before any read (console.js: C.useChain). Every function below defaults to it
// and takes `chainId` to override; nothing sets it but the page, so it is BNB Chain (56) everywhere else.
// 页面所在的链，由页面在任何读取之前设置一次（console.js：C.useChain）。下面的函数默认用它，也可传 chainId 覆盖。
let pageChain = CHAIN_ID
/** Set the page's chain; returns it. / 设置页面所在的链。 */
export function useChain(chainId) { pageChain = chainOf(chainId).chainId; return chainOf(pageChain) }
export const MANIFEST_KEY = '.well-known/tapeapi.json'                       // no leading slash (TapeKit SPEC §6) / 不带前导斜杠
export const MANIFEST_LIMIT = 24_000                                         // one putFile / 一笔 putFile
export const READ_LIMIT = 64 * 1024                                         // TAP-20: a manifest read is at most 64 KiB / 读取上限
export const SEL = { cpuAt: '0x4bc7cbbd', isCPU: '0x5f5a364f', accountOf: '0x0c1905e5', ownerOf: '0x6352211e', putFile: '0xfab2ed82', fileInfo: '0x6c609107', read: '0xccaa7afb' }
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
export async function readCircuit(call, { processor, tokenId, chainId = pageChain }) {
  const { factory, hub } = chainOf(chainId)
  processor = String(processor).trim(); tokenId = String(tokenId).trim()
  if (/^0x[0-9a-fA-F]{40}$/.test(processor)) throw new Error('这里填处理器编号（一个数字，例如 11.1013.tape 里的 1013），不是合约地址 / enter the processor number, not a contract address')
  if (!/^\d{1,15}$/.test(processor)) throw new Error('处理器编号必须是整数 / processor number must be a whole number')
  if (!/^\d{1,15}$/.test(tokenId) || BigInt(tokenId) < 1n) throw new Error('circuit number (#ID) must be 1 or more')
  tokenId = String(BigInt(tokenId))   // "01" -> "1": the manifest's tokenId has no leading zeros (TAP-20) / 去掉前导零
  const circuits = addrOf(await call(factory, SEL.cpuAt + word(processor)))
  if (BigInt(await call(factory, SEL.isCPU + addrWord(circuits))) !== 1n) throw new Error(`${circuits} is not a TapeOut processor`)
  const container = addrOf(await call(hub, SEL.accountOf + addrWord(circuits) + word(tokenId)))
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
export function delegationTypedData({ container, signer, expires, chainId = pageChain }) {
  if (!isAddr(container) || !isAddr(signer)) throw new Error('container and signer must be addresses')
  const c = chainOf(chainId)
  return {
    domain: { name: 'TapeAPI', version: '1', chainId: c.chainId, verifyingContract: c.hub },
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
// The page derives the address of the key it generated, so step 4 signs a delegation only for THAT key, never for
// whatever address the service happens to report (a mistyped service URL, a second key pasted by mistake). Keccak-256
// and secp256k1 are written out here because the page loads nothing; sdk/test/console.test.mjs checks both against the
// SDK (noble). The key is used once, in the holder's own browser, so constant time is not a goal.
// 页面自己推导它生成的密钥的地址，第 4 步只为**这个**密钥签委托，而不是服务报出的任意地址（服务网址填错、误贴了第二把密钥）。
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

/** The EIP-712 digest of a Delegation, exactly as the SDK's sig.delegationDigest(chainId, HUB, …) (chainId 56 unless
 *  given). / 委托的 EIP-712 摘要（未给 chainId 时为 56）。 */
export function delegationDigest({ container, signer, expires, chainId = pageChain }) {
  const c = chainOf(chainId)
  const domain = kec(kec(utf8('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')), kec(utf8('TapeAPI')), kec(utf8('1')), word(c.chainId), addrWord(c.hub))
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
/** Prefill from a link such as the dashboard's "Renew in console": ?processor=<digits>&circuit=<digits>&url=<service base>.
 *  Returns only the values that pass the page's own checks (whole numbers; a service base as isServiceBase accepts it).
 *  The page only fills the step 2 and step 4 inputs with them; it never reads, signs or sends by itself.
 *  从链接预填（例如面板的“去操作台续期”）：只返回通过本页检查的值（整数；isServiceBase 接受的服务网址）。
 *  页面只把它们填进第 2 步和第 4 步的输入框，从不自行读取、签名或发送。 */
export function prefillFromQuery(search) {
  const q = new URLSearchParams(typeof search === 'string' ? search : '')
  const num = (v) => (typeof v === 'string' && /^\d{1,78}$/.test(v) ? v : null)
  const out = {}
  // ?chain=196 or 8453 (a name with an area code, from the dashboard); anything else is ignored / 只认本页支持的链
  const chain = q.get('chain')
  if (typeof chain === 'string' && /^(56|196|8453)$/.test(chain)) out.chainId = Number(chain)
  const processor = num(q.get('processor')), circuit = num(q.get('circuit'))
  if (processor) out.processor = processor
  if (circuit) out.circuit = circuit
  const url = q.get('url')
  if (typeof url === 'string' && url.length <= 300) {
    const base = url.trim().replace(/\/+$/, '')
    if (isServiceBase(base)) out.url = base
  }
  return out
}
const METHODS = [{ name: 'blockNumber', priceBEM: '0', params: {}, returns: { blockNumber: 'number' } }]
const NAME_OK = (n) => typeof n === 'string' && n.length >= 1 && n.length <= 64 && !/[\u0000-\u001f\u007f]/.test(n)

// The method list is the one part a service may choose (examples/public-api has many), under rules stricter than TAP-20:
// every method free (this page never writes a payment section, so a price could never be settled), only the TAP-20
// method fields, plain-string notations, bounded sizes. The holder sees every method name before signing.
// 方法列表是服务唯一可以自选的部分（如 examples/public-api），规则比 TAP-20 更严：每个方法都免费（本页从不写 payment，
// 价格根本无法结算）、只有 TAP-20 的方法字段、记法是普通字符串、大小有界。持有人签名前能看到每个方法名。
const METHOD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const METHOD_KEYS = new Set(['name', 'priceBEM', 'params', 'returns', 'description'])
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])
const CONTROL = /[\u0000-\u001f\u007f]/
const isPlain = (o) => !!o && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype
/** Why a served method list cannot be published ([] when it can). / 服务给的方法列表为何不能发布（可以则为空）。 */
export function methodsProblems(methods) {
  if (!Array.isArray(methods) || methods.length < 1 || methods.length > 64) return ['methods must be a list of 1 to 64 methods']
  const out = [], seen = new Set()
  for (const x of methods) {
    const n = isPlain(x) && typeof x.name === 'string' ? x.name : null
    const who = n && METHOD_NAME.test(n) ? n : clip(n ?? x)
    if (!isPlain(x)) { out.push(`method ${who} is not an object`); continue }
    if (!n || !METHOD_NAME.test(n) || FORBIDDEN.has(n)) out.push(`method name ${who} is not allowed`)
    else if (seen.has(n)) out.push(`method ${who} appears twice`)
    seen.add(n)
    for (const k of Object.keys(x)) if (!METHOD_KEYS.has(k)) out.push(`method ${who} has an unexpected field ${clip(k)}`)
    if (x.priceBEM !== '0') out.push(`method ${who} is priced (${clip(x.priceBEM)}); this page publishes free services only`)
    for (const k of ['params', 'returns']) {
      const o = x[k]
      if (!isPlain(o) || Object.keys(o).length > 32) { out.push(`method ${who}: ${k} must be an object of at most 32 fields`); continue }
      for (const [pk, pv] of Object.entries(o)) if (!METHOD_NAME.test(pk) || FORBIDDEN.has(pk) || typeof pv !== 'string' || pv.length > 200 || CONTROL.test(pv)) { out.push(`method ${who}: ${k}.${clip(pk)} is not a plain field`); break }
    }
    if (x.description !== undefined && (typeof x.description !== 'string' || [...x.description].length > 256 || CONTROL.test(x.description))) out.push(`method ${who}: description must be at most 256 printable characters`)
  }
  return out
}

/** The manifest the page publishes, built from what the holder read and signed, never taken from the service: the same
 *  fields in the same order as examples/cloudflare-worker/worker.js build() (a test keeps the two equal). Only the display
 *  name and the free method list (methodsProblems) may come from the service, and the holder sees both before signing;
 *  so may an `mcp` field of exactly its shape (mcpProblems), whose tools the page reads and hashes itself (step 5).
 *  页面发布的清单：由持有人读到和签过的内容构造，不取自服务；字段和顺序与 worker.js build() 相同（有测试保证一致）。
 *  只有显示名称和免费方法列表（methodsProblems）可以来自服务，持有人签名前能看到两者；形状完全符合的 `mcp` 字段也可以
 *  （mcpProblems），它的工具由页面自己读取并计算摘要（第 5 步）。 */
export function expectedManifest({ circuits, tokenId, container, signer, expires, sig, endpoint, name = 'TapeAPI Reader', methods = METHODS, mcp }) {
  if (!NAME_OK(name)) throw new Error('name must be 1 to 64 printable characters')
  const bad = methodsProblems(methods)
  if (bad.length) throw new Error(bad.join('; '))
  if (!isServiceBase(String(endpoint).replace(/\/tapeapi\/v1$/, '')) || !String(endpoint).endsWith('/tapeapi/v1')) throw new Error(`endpoint must be https://<host>/tapeapi/v1, not ${endpoint}`)
  if (mcp !== undefined) {
    const badMcp = mcpProblems(mcp, { local: String(endpoint).startsWith('http:') })
    if (badMcp.length) throw new Error(badMcp.join('; '))
  }
  return {
    tapeapi: '0.1', name, circuits, tokenId: String(tokenId), container, signer,
    delegation: { expires: Number(expires), sig },
    endpoints: { live: [endpoint], async: false },
    methods,
    ...(mcp !== undefined ? { mcp: { endpoint: mcp.endpoint, toolsSha256: mcp.toolsSha256 } } : {}),
  }
}

// ---------------------------------------------------------------- a taped-out MCP server ----
// A service may be the signing proxy of an MCP server. Its manifest then carries one more field, `mcp: { endpoint,
// toolsSha256 }` (docs: PLAN-MCP, "阶段 2 接口约定"): toolsSha256 pins the upstream tool definitions on chain, and every
// client refuses tools that do not hash to it. The page does not take the service's word for it: it reads tools/list
// from mcp.endpoint itself, hashes it exactly as the SDK's mcp.toolsDigest does (RFC 8785 canonical JSON, SHA-256; the
// page loads no library, so both are written out here and sdk/test/console.test.mjs checks them against the SDK), and
// shows the holder every tool before the wallet is asked. / 服务可以是某个 MCP 服务器的签名代理，清单里就多一个字段
// `mcp: { endpoint, toolsSha256 }`：toolsSha256 把上游工具定义钉在链上，客户端拒绝哈希不符的工具。页面不听服务一面之词：
// 自己从 mcp.endpoint 读 tools/list，按 SDK 的 mcp.toolsDigest 同样的方法算摘要（RFC 8785 规范 JSON + SHA-256；页面不加载库，
// 所以在这里写出，console.test.mjs 对照 SDK 检查），并在钱包请求之前把每个工具展示给持有人。
const MCP_KEYS = ['endpoint', 'toolsSha256']
/** Why a manifest's `mcp` field cannot be published ([] when it can): exactly { endpoint, toolsSha256 }, an https URL
 *  (http on a loopback address only when `local`, as for the service itself) and the lowercase hex the page computes.
 *  清单的 mcp 字段为何不能发布（可以则为空）：恰好是 { endpoint, toolsSha256 }，https 网址，页面算出的小写十六进制。 */
export function mcpProblems(mcp, { local = false } = {}) {
  if (!isPlain(mcp)) return [`mcp must be an object { endpoint, toolsSha256 }, not ${clip(mcp)}`]
  const out = []
  for (const k of Object.keys(mcp)) if (!MCP_KEYS.includes(k)) out.push(`mcp has an unexpected field ${clip(k)}`)
  if (typeof mcp.toolsSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(mcp.toolsSha256)) out.push(`mcp.toolsSha256 must be 64 lowercase hex characters, not ${clip(mcp.toolsSha256)}`)
  const e = mcp.endpoint
  const ok = typeof e === 'string' && e.length <= 200 && !CONTROL.test(e) &&
    (/^https:\/\/[^/?#@\s]+(\/[^?#\s]*)?$/.test(e) || (local && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[^?#\s]*)?$/.test(e)))
  if (!ok) out.push(`mcp.endpoint must be https://<host>/<path> with no query, fragment or credentials, not ${clip(e)}`)
  return out
}

// RFC 8785 canonical JSON, exactly as the SDK's canon.js canonicalJSON: keys sorted by UTF-16 code units, leaves written
// by JSON.stringify, and the same refusals (non-finite numbers, integers past 2^53, -0, lone surrogates in strings or
// keys, prototype keys, undefined, toJSON, bigint/function/symbol). Whatever the SDK refuses, the page refuses.
// RFC 8785 规范 JSON，与 SDK 的 canonicalJSON 完全一致：键按 UTF-16 码元排序，叶子交给 JSON.stringify，拒绝的东西也相同。
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const canonStr = (s, path) => { if (LONE_SURROGATE.test(s)) throw new Error(`lone UTF-16 surrogate at ${path || '$'}`); return JSON.stringify(s) }
export function canonicalJSON(v, path = '') {
  if (v === null) return 'null'
  const t = typeof v
  if (t === 'boolean') return v ? 'true' : 'false'
  if (t === 'string') return canonStr(v, path)
  if (t === 'number') {
    if (!Number.isFinite(v)) throw new Error(`non-finite number at ${path || '$'}`)
    if (Number.isInteger(v) && !Number.isSafeInteger(v)) throw new Error(`integer ${v} at ${path || '$'} is outside the exactly representable range`)
    if (Object.is(v, -0)) throw new Error(`negative zero at ${path || '$'}`)
    return JSON.stringify(v)
  }
  if (t !== 'object') throw new Error(`unsupported ${t} at ${path || '$'}`)
  if (Array.isArray(v)) return '[' + v.map((x, i) => canonicalJSON(x, `${path}[${i}]`)).join(',') + ']'
  if (typeof v.toJSON === 'function') throw new Error(`value at ${path || '$'} has a toJSON() method`)
  const parts = []
  for (const k of Object.keys(v).sort()) {
    if (FORBIDDEN.has(k)) throw new Error(`forbidden key "${k}" at ${path || '$'}`)
    if (v[k] === undefined) throw new Error(`undefined at ${path}.${k}`)
    parts.push(canonStr(k, `${path}.<key>`) + ':' + canonicalJSON(v[k], `${path}.${k}`))
  }
  return '{' + parts.join(',') + '}'
}

/** The tool fields that are hashed, as the SDK's TOOL_DIGEST_FIELDS. / 参与哈希的工具字段，同 SDK。 */
export const TOOL_DIGEST_FIELDS = Object.freeze(['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations'])
const isObjLoose = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
/** The tools as they are hashed, as the SDK's mcp.normalizeTools: those fields only, sorted by name, no repeated name.
 *  参与哈希的工具形式，同 SDK 的 normalizeTools。 */
export function normalizeTools(tools) {
  if (!Array.isArray(tools)) throw new Error('tools must be an array')
  const seen = new Set()
  const out = tools.map((t) => {
    if (!isObjLoose(t) || typeof t.name !== 'string' || !t.name) throw new Error('every tool needs a name')
    if (seen.has(t.name)) throw new Error(`tool ${clip(t.name)} appears twice`)
    seen.add(t.name)
    return Object.fromEntries(TOOL_DIGEST_FIELDS.filter((k) => t[k] !== undefined).map((k) => [k, t[k]]))
  })
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
const webSha256 = async (b) => hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', b)))
/** sha256 hex of canonicalJSON(normalizeTools(tools)): the SDK's mcp.toolsDigest, computed with WebCrypto.
 *  与 SDK 的 mcp.toolsDigest 相同，用 WebCrypto 计算。 */
export async function toolsDigest(tools, sha256 = webSha256) {
  return String(await sha256(utf8(canonicalJSON(normalizeTools(tools))))).replace(/^0x/, '').toLowerCase()
}

/** Text a model reads but a person does not see, in any string of the pinned tool fields (keys included, any depth):
 *  Unicode format characters (category Cf: tag characters, zero-width, bidi controls, soft hyphen) and C0/C1 controls,
 *  except a line feed or a tab inside a `description`. One "tool X: field path: U+XXXX" line per offending string.
 *  The SDK's mcp.invisibleProblems, character for character (the page loads no library; sdk/test/mcp-review.test.mjs
 *  keeps the two equal). / 模型能读、人看不见的文本：Unicode 格式字符（Cf）和 C0/C1 控制符（description 里的换行、制表符除外）。
 *  与 SDK 的 mcp.invisibleProblems 逐字相同（页面不加载库；由测试保证一致）。 */
export function invisibleProblems(tools) {
  const FIELDS = ['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations']
  const obj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
  const u = (c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
  const bad = (c, text) => /\p{Cf}/u.test(c) || (/\p{Cc}/u.test(c) && !(text && (c === '\n' || c === '\t')))
  const first = (s, text) => { for (const c of s) if (bad(c, text)) return c; return null }
  const show = (s) => Array.from(s).slice(0, 64).map((c) => (bad(c, false) ? `<${u(c)}>` : c)).join('')
  const out = []
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!obj(t)) continue
    const who = `tool ${JSON.stringify(show(typeof t.name === 'string' ? t.name : String(t.name)))}`
    const walk = (v, path, key) => {
      if (typeof v === 'string') { const c = first(v, key === 'description'); if (c) out.push(`${who}: ${path}: ${u(c)}`); return }
      if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`, key)); return }
      if (!obj(v)) return
      for (const k of Object.keys(v)) {
        const c = first(k, false)
        if (c) out.push(`${who}: ${path} key ${JSON.stringify(show(k))}: ${u(c)}`)
        walk(v[k], /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(show(k))}]`, k)
      }
    }
    for (const f of FIELDS) if (t[f] !== undefined) walk(t[f], f, f)
  }
  return out
}

/** Why the tools read from mcp.endpoint cannot be published with this manifest ([] when they can): their digest must be
 *  the toolsSha256 the service reports, every method must be one of the tools (the proxy makes one method per tool), and
 *  no pinned text may be invisible to the holder who approves it (review MCP-R7).
 *  从 mcp.endpoint 读到的工具为何不能随这份清单发布：摘要必须等于服务报出的 toolsSha256，每个方法都必须是其中一个工具，
 *  钉住的文本不能有批准它的持有人看不见的部分（审查 MCP-R7）。 */
export async function mcpToolsProblems({ mcp, methods, tools }) {
  let digest
  try { digest = await toolsDigest(tools) } catch (e) { return [`the tool list cannot be hashed as clients hash it: ${e.message}`] }
  const out = []
  if (digest !== mcp?.toolsSha256) out.push(`the tools served by ${clip(mcp?.endpoint)} hash to ${digest}, but the service reports toolsSha256 ${clip(mcp?.toolsSha256)}`)
  const names = new Set(tools.map((t) => t.name))
  for (const x of Array.isArray(methods) ? methods : []) if (!names.has(x?.name)) out.push(`method ${clip(x?.name)} is not one of the MCP tools`)
  for (const p of invisibleProblems(tools)) out.push(`${p}: an invisible or format character (text a model reads but you cannot see)`)
  return out
}

// JSON as the SDK's safeParseJSON reads it: a prototype key or a repeated key anywhere is refused (two parsers may
// disagree about which duplicate survives, and so about the digest). / 与 SDK 的 safeParseJSON 一样：拒绝原型键和重复键。
function findDuplicateKey(text) {
  const n = text.length, stack = []
  let i = 0, expectKey = false
  const readString = () => {
    let s = ''
    i++
    while (i < n) {
      const c = text[i]
      if (c === '\\') {
        const e = text[i + 1]
        if (e === 'u') { s += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)); i += 6 } else { s += ({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[e] ?? e; i += 2 }
        continue
      }
      if (c === '"') { i++; return s }
      s += c; i++
    }
    return s
  }
  const inObject = () => stack.length > 0 && stack[stack.length - 1] !== null
  while (i < n) {
    const c = text[i]
    if (c === '"') {
      const key = readString()
      if (expectKey && inObject()) { const seen = stack[stack.length - 1]; if (seen.has(key)) return key; seen.add(key); expectKey = false }
      continue
    }
    if (c === '{') { stack.push(new Set()); expectKey = true } else if (c === '[') { stack.push(null); expectKey = false } else if (c === '}' || c === ']') { stack.pop(); expectKey = false } else if (c === ',') expectKey = inObject()
    i++
  }
  return null
}
export function strictParseJSON(text) {
  const v = JSON.parse(text, (k, x) => { if (FORBIDDEN.has(k)) throw new Error(`forbidden key "${k}" in JSON`); return x })
  const dup = findDuplicateKey(text)
  if (dup !== null) throw new Error(`duplicate key ${clip(dup)} in JSON`)
  return v
}

const MCP_BODY_LIMIT = 4 * 1024 * 1024
const MCP_MAX_PAGES = 20
const sseMessages = (text) => text.replace(/\r\n?/g, '\n').split('\n\n').slice(0, -1).flatMap((ev) => {
  const data = ev.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n')
  if (!data) return []
  try { return [].concat(strictParseJSON(data)) } catch { return [] }
})
/** tools/list of an MCP server over Streamable HTTP, as the SDK's tapeapi-mcp reads it: initialize,
 *  notifications/initialized, then tools/list page by page (nextCursor); JSON or SSE answers; the mcp-session-id carried.
 *  From a browser the endpoint must allow this origin (CORS, including the mcp-session-id header both ways).
 *  经 Streamable HTTP 读 MCP 服务器的 tools/list，与 SDK 的 tapeapi-mcp 相同。浏览器里端点必须允许本页来源跨域。 */
export async function fetchMcpTools(endpoint, { fetch: f = (...a) => globalThis.fetch(...a), timeoutMs = 15_000 } = {}) {
  let session = null, protocol = null, seq = 0
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const read = async (res, done) => {
    const reader = res.body?.getReader?.()
    if (!reader) return await res.text()
    const dec = new TextDecoder()
    let text = '', size = 0
    for (;;) {
      const { value, done: end } = await reader.read()
      if (end) return text + dec.decode()
      size += value.byteLength
      if (size > MCP_BODY_LIMIT) { reader.cancel().catch(() => {}); throw new Error(`answer larger than ${MCP_BODY_LIMIT} bytes`) }
      text += dec.decode(value, { stream: true })
      if (done && done(text)) { reader.cancel().catch(() => {}); return text }   // an SSE stream may stay open / SSE 流可能不关
    }
  }
  const post = async (msg) => {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    if (session) headers['mcp-session-id'] = session
    if (protocol) headers['mcp-protocol-version'] = protocol
    const res = await f(endpoint, { method: 'POST', headers, body: JSON.stringify(msg), signal: ac.signal, cache: 'no-store', credentials: 'omit' })
    const sid = res.headers.get('mcp-session-id')
    if (sid && !session) { if (!/^[\x21-\x7e]{1,256}$/.test(sid)) throw new Error('invalid mcp-session-id'); session = sid }
    if (msg.id === undefined) { res.body?.cancel?.().catch(() => {}); if (!res.ok) throw new Error(`HTTP ${res.status} for ${msg.method}`); return null }
    if (!res.ok) { res.body?.cancel?.().catch(() => {}); throw new Error(`HTTP ${res.status} for ${msg.method}`) }
    const sse = /^text\/event-stream\b/i.test(res.headers.get('content-type') || '')
    const mine = (m) => isObjLoose(m) && m.id === msg.id && ('result' in m || 'error' in m)
    const text = await read(res, sse ? (t) => sseMessages(t).some(mine) : null)
    const reply = (sse ? sseMessages(text) : [].concat(strictParseJSON(text))).find(mine)
    if (!reply) throw new Error(`no answer to ${msg.method}`)
    if (reply.error) throw new Error(`${msg.method} failed: ${clip(reply.error?.message)}`)
    return reply.result
  }
  try {
    const init = await post({ jsonrpc: '2.0', id: ++seq, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'tapeapi-console', version: '1' } } })
    if (!isObjLoose(init)) throw new Error('initialize returned no result')
    protocol = typeof init.protocolVersion === 'string' && /^[\x21-\x7e]{1,32}$/.test(init.protocolVersion) ? init.protocolVersion : null
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const tools = []
    let cursor
    for (let page = 0; ; page++) {
      if (page >= MCP_MAX_PAGES) throw new Error(`tools/list has more than ${MCP_MAX_PAGES} pages`)
      const r = await post({ jsonrpc: '2.0', id: ++seq, method: 'tools/list', ...(cursor ? { params: { cursor } } : {}) })
      if (!isObjLoose(r) || !Array.isArray(r.tools)) throw new Error('tools/list returned no tools array')
      tools.push(...r.tools)
      cursor = r.nextCursor
      if (typeof cursor !== 'string' || !cursor) return tools
    }
  } catch (e) {
    throw new Error(ac.signal.aborted ? `no answer within ${timeoutMs / 1000} s` : e?.message || String(e))
  } finally {
    clearTimeout(timer)
    if (session) Promise.resolve().then(() => f(endpoint, { method: 'DELETE', headers: { 'mcp-session-id': session }, credentials: 'omit' })).then((r) => r?.body?.cancel?.().catch(() => {}), () => {})
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
 *  Any field the page did not build (payment, dev, a second endpoint, other prices) is a difference. The shape of an
 *  `mcp` field is checked here; its tools are checked by mcpToolsProblems once the page has read them.
 *  服务提供的清单与页面将发布的清单有何不同（一致则为空）。页面没构造的任何字段（payment、dev、第二个端点、别的价格）都算不同。
 *  `mcp` 字段的形状在这里检查；它的工具在页面读到之后由 mcpToolsProblems 检查。 */
export function manifestProblems(text, s) {
  let m
  try { m = JSON.parse(text) } catch { return ['not JSON'] }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['not a JSON object']
  const bad = methodsProblems(m.methods)
  if (bad.length) return bad
  let want
  // `mcp` is the one optional field, and only with exactly its shape (mcpProblems). / mcp 是唯一的可选字段，形状必须完全符合。
  try { want = expectedManifest({ ...s, name: NAME_OK(m.name) ? m.name : undefined, methods: m.methods, mcp: Object.hasOwn(m, 'mcp') ? m.mcp : undefined }) } catch (e) { return [e.message] }
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

// ---------------------------------------------------------------- renewal: the key already on chain ----
// A delegation lasts 90 days. To renew it the holder signs a new one for the SAME service key, which the page may not
// have generated (another service was set up since, or the browser was cleared). The manifest already in the container
// names that key, and its delegation, recovered here, proves the current holder authorised it: re-signing for it grants
// nothing new. The chain is read as every client reads it (fileInfo, then read; exact length and SHA-256, as the SDK's
// readVerifiedFile), never through the service. / 委托有效 90 天。续期就是持有人为**同一把**服务密钥再签一次，而这把
// 密钥可能不是本页生成的（之后又设置过别的服务，或浏览器被清空）。容器里已有的清单写着这把密钥，这里恢复出的委托签名证明
// 当前持有人授权过它：为它重签不会授予任何新东西。读链方式与每个客户端相同（先 fileInfo 再 read，长度和 SHA-256 严格一致，
// 同 SDK 的 readVerifiedFile），从不经过服务。
const ZERO32 = '0'.repeat(64)
// A file on chain that cannot be verified is UNVERIFIABLE: nothing to renew, but it must not block a fresh setup, which
// is how a holder replaces it. A failing call (the node) is not tagged and stays an error to retry.
// 无法核对的链上文件标为 UNVERIFIABLE：不能续期，但不能挡住新密钥设置（持有人正是靠它替换坏文件）。调用失败（节点问题）不标记，照常报错重试。
const unverifiable = (m) => Object.assign(new Error(m), { code: 'UNVERIFIABLE' })
const abiWords = (ret) => { const h = String(ret ?? '').replace(/^0x/, ''); if (!/^(?:[0-9a-fA-F]{64})*$/.test(h)) throw unverifiable('not an ABI answer'); return h }
const wordAt = (h, i) => { if (h.length < (i + 1) * 64) throw unverifiable('short ABI answer'); return h.slice(i * 64, (i + 1) * 64) }
const small = (w) => { const n = BigInt('0x' + w); if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw unverifiable('ABI number too large'); return Number(n) }

/** The manifest on chain for `container`, as text, verified against the SiteRegistry's own length and SHA-256;
 *  null when there is none (fileInfo.size = 0). A file that fails the checks throws with code UNVERIFIABLE; a failing
 *  call throws as it is. `sha256(bytes)` returns hex.
 *  容器链上的清单文本，按 SiteRegistry 自己记录的长度和 SHA-256 核对；没有清单时为 null；核对不过抛 UNVERIFIABLE，调用失败原样抛出。 */
export async function readManifestFile(call, container, sha256, { limit = READ_LIMIT, chainId = pageChain } = {}) {
  const registry = chainOf(chainId).siteRegistry
  const args = addrWord(container) + word(64) + dyn(utf8(MANIFEST_KEY))
  const info = abiWords(await call(registry, SEL.fileInfo + args))
  const size = small(wordAt(info, 0)), declared = wordAt(info, 2).toLowerCase()
  if (size === 0) return null
  if (size > limit) throw unverifiable(`the on-chain manifest declares ${size} bytes; the limit is ${limit}`)
  if (declared === ZERO32) throw unverifiable('the on-chain manifest has no SHA-256 (fileInfo.sha256Hash is zero): it cannot be verified')
  const r = abiWords(await call(registry, SEL.read + args))
  const off = small(wordAt(r, 0))
  if (off % 32) throw unverifiable('not an ABI answer')
  const len = small(wordAt(r, off / 32)), body = r.slice(off * 2 + 64, off * 2 + 64 + len * 2)
  if (body.length !== len * 2) throw unverifiable('short ABI answer')
  if (len !== size) throw unverifiable(`read ${len} bytes, fileInfo.size declares ${size}`)
  const raw = bytes(body), digest = String(await sha256(raw)).replace(/^0x/, '').toLowerCase()
  if (digest !== declared) throw unverifiable(`the SHA-256 of the bytes read is ${digest}, fileInfo declares ${declared}`)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(raw) } catch { throw unverifiable('the on-chain manifest is not UTF-8') }
}

const eqAddr = (a, b) => isAddr(a) && isAddr(b) && a.toLowerCase() === b.toLowerCase()

/** What the manifest on chain authorises, checked against the circuit read in step 2 and its CURRENT holder:
 *  { ok: true, signer, endpoints, expires }, or { ok: false, code, detail? } with code NO_MANIFEST, INVALID,
 *  WRONG_CIRCUIT, BAD_SIGNATURE or NOT_HOLDER. An expired delegation still counts: renewing it is the point.
 *  链上清单授权了什么，对照第 2 步读到的电路及其**当前**持有人。已过期的委托照样算：续期正是为此。 */
export function onChainAuthorisation(text, { circuits, tokenId, container, holder, chainId = pageChain }) {
  if (text == null) return { ok: false, code: 'NO_MANIFEST' }
  const bad = (detail) => ({ ok: false, code: 'INVALID', detail })
  let m
  try { m = JSON.parse(text) } catch { return bad('not JSON') }
  if (!isPlain(m)) return bad('not a JSON object')
  if (typeof m.tapeapi !== 'string' || !/^0\.[1-9]\d*$/.test(m.tapeapi)) return bad(`tapeapi is ${clip(m.tapeapi)}`)
  for (const k of ['circuits', 'container', 'signer']) if (!isAddr(m[k])) return bad(`${k} is ${clip(m[k])}, not an address`)
  if (typeof m.tokenId !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(m.tokenId)) return bad(`tokenId is ${clip(m.tokenId)}`)
  // The signature covers (container, signer, expires) only, so the circuit is compared here. / 签名只覆盖容器、签名地址和到期，电路在这里比较。
  if (!eqAddr(m.container, container) || !eqAddr(m.circuits, circuits) || m.tokenId !== String(tokenId)) return { ok: false, code: 'WRONG_CIRCUIT', detail: `circuit ${m.tokenId} of ${m.circuits}, container ${m.container}` }
  const d = m.delegation
  if (!isPlain(d) || !Number.isSafeInteger(d.expires) || d.expires <= 0 || typeof d.sig !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(d.sig)) return bad('delegation must be { expires, sig }')
  const live = isPlain(m.endpoints) ? m.endpoints.live : null
  if (!Array.isArray(live) || live.length < 1 || live.length > 8 || !live.every((e) => typeof e === 'string' && e.length <= 200 && !CONTROL.test(e))) return bad('endpoints.live must list 1 to 8 URLs')
  // under the domain of the circuit's own chain / 按电路所在链的域
  const by = recoverAddress(delegationDigest({ container: m.container, signer: m.signer, expires: d.expires, chainId }), d.sig)
  if (!by) return { ok: false, code: 'BAD_SIGNATURE' }
  if (!eqAddr(by, holder)) return { ok: false, code: 'NOT_HOLDER', detail: by }
  return { ok: true, signer: checksum(m.signer), endpoints: live.slice(), expires: d.expires }
}

/** Does an on-chain endpoint name this service base? The path is fixed, so the whole string compares case-insensitively.
 *  链上端点是否就是这个服务基础网址。 */
export const sameEndpoint = (endpoint, base) => String(endpoint).replace(/\/+$/, '').toLowerCase() === `${base}/tapeapi/v1`.toLowerCase()

/** Which signing address step 4 may authorise, or why none. `text` is the verified on-chain manifest (null: none),
 *  `circuit` the step-2 read with its holder, `base` the typed service URL, `health` the service's health answer,
 *  `keyAddress` the key generated in step 3, `renew` the holder's choice, `moved` the "the service moved" box.
 *  - fresh: only the key generated on this page, and only if the service reports exactly it (review F1);
 *  - renew: only the signer of an on-chain delegation that recovers to the current holder, and only if the service
 *    reports exactly it; never after "moved";
 *  - either way, when such a delegation exists, the typed URL must be its endpoint unless "moved" is ticked.
 *  Returns { ok: true, mode, signer, onChain } or { ok: false, code, … }.
 *  第 4 步可以为哪个签名地址签委托，或为什么不行。新密钥：只签本页生成的、且服务报出的正是它；续期：只签链上委托里、恢复出
 *  当前持有人的那个签名地址，且服务报出的正是它，勾了“服务已搬家”就不行；两种情况下，只要链上有这样的委托，填的网址必须是
 *  它的端点，除非勾了“服务已搬家”。 */
export function decideSigner({ text, circuit, base, health, keyAddress, renew = false, moved = false }) {
  if (!isServiceBase(base)) return { ok: false, code: 'BAD_URL' }
  const reported = isPlain(health) ? health.signer : null
  if (!isAddr(reported)) return { ok: false, code: 'NO_SIGNER' }
  const onChain = onChainAuthorisation(text, circuit)
  if (onChain.ok && !moved && !onChain.endpoints.some((e) => sameEndpoint(e, base))) return { ok: false, code: 'ENDPOINT_MISMATCH', endpoints: onChain.endpoints, onChain }
  if (renew) {
    if (moved) return { ok: false, code: 'MOVED', onChain }
    if (!onChain.ok) return { ...onChain, onChain }
    if (!eqAddr(reported, onChain.signer)) return { ok: false, code: 'SIGNER_MISMATCH', reported: checksum(reported), signer: onChain.signer, onChain }
    return { ok: true, mode: 'renew', signer: onChain.signer, onChain }
  }
  if (!isAddr(keyAddress)) return { ok: false, code: 'NO_KEY', onChain }
  if (!eqAddr(reported, keyAddress)) return { ok: false, code: 'KEY_MISMATCH', reported: checksum(reported), signer: checksum(keyAddress), onChain }
  return { ok: true, mode: 'fresh', signer: checksum(keyAddress), onChain }
}

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
export function putFileTx({ container, text, sha256Hex, contentType = 'application/json', chainId = pageChain }) {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length > MANIFEST_LIMIT) throw new Error(`manifest is ${bytes.length} bytes; one putFile carries ${MANIFEST_LIMIT}`)
  if (!/^0x[0-9a-f]{64}$/i.test(sha256Hex)) throw new Error('sha256 must be 32 bytes of hex')
  const key = new TextEncoder().encode(MANIFEST_KEY), type = new TextEncoder().encode(contentType)
  const k = dyn(key), t = dyn(type)
  const head = 5 * 32
  const data = SEL.putFile + addrWord(container) + word(head) + word(head + k.length / 2) + sha256Hex.slice(2).toLowerCase() + word(head + k.length / 2 + t.length / 2) + k + t + dyn(bytes)
  return { to: chainOf(chainId).siteRegistry, data: data.toLowerCase(), value: '0x0' }
}
