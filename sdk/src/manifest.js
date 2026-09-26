import { TapeAPIError } from './errors.js'
import { isAddress, checksumAddress } from './abi.js'
import { FORBIDDEN_KEYS } from './canon.js'

const fail = (reason) => { throw new TapeAPIError('MANIFEST_INVALID', reason) }

// 方法名：路径安全，1..64 字符 / Method names: path-safe, 1..64 characters (TAP-20 §3.3, review M-08 / L-20).
export const METHOD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
export const MAX_NAME_LEN = 64
export const MAX_DELEGATION_S = 366 * 24 * 3600 // TAP-20 §3.4: delegation.expires ≤ now + 366 d

// 十进制字符串 → wei (BigInt)，精确解析 / Exact decimal-string to wei parsing.
// BEM has 8 decimals on chain, not 18. Verified 2026-09-21 against
// 0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a: decimals() = 8, totalSupply 20466844665222 = 204 668.447 BEM.
// Assuming 18 is a 10^10 error in every price, allowance and voucher.
// BEM 链上是 8 位小数而非 18。2026-09-21 核实：decimals() = 8，总量 204 668.447 枚。
// 按 18 计算会让所有价格、额度与凭证差 10^10 倍。
export const BEM_DECIMALS = 8

export function parseUnits(str, decimals = BEM_DECIMALS) {
  if (typeof str === 'number') str = String(str)
  if (typeof str !== 'string' || !/^\d+(\.\d+)?$/.test(str)) throw new TapeAPIError('MANIFEST_INVALID', `bad decimal amount ${str}`)
  const [i, f = ''] = str.split('.')
  if (f.length > decimals) throw new TapeAPIError('MANIFEST_INVALID', `too many decimals in ${str}`)
  return BigInt(i) * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0')
}
export function formatUnits(wei, decimals = BEM_DECIMALS) {
  const s = BigInt(wei).toString().padStart(decimals + 1, '0')
  const i = s.slice(0, -decimals), f = s.slice(-decimals).replace(/0+$/, '')
  return f ? `${i}.${f}` : i
}

// 端点 URL：https（除非 allowHttp / dev），无 query / fragment，无凭据 / Endpoint URL: https unless allowHttp (dev),
// no query, fragment or userinfo (review M-10 / L-19).
function checkEndpoint(u, allowHttp) {
  if (typeof u !== 'string') fail(`bad endpoint ${u}`)
  let url
  try { url = new URL(u) } catch { fail(`bad endpoint ${u}`) }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) fail(`endpoint must be https (${url.protocol.replace(':', '')} given; http is allowed only in dev / allowHttp)`)
  if (url.search || url.hash || url.username || url.password) fail('endpoint must not carry query, fragment or credentials')
  return url.href.replace(/\/+$/, '')
}

// 校验并规范化清单 / Validate and normalise a TAP-20 manifest (returns a copy).
//   requireDelegation: false 允许没有 holder 委托（dev / provider 自检）/ allow a manifest without a holder delegation
//   allowHttp: 允许 http:// 端点（仅 dev）/ accept http:// endpoints (dev only)
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const codePoints = (str) => [...str].length
// TAP-20 §3.3: "checksummed or lowercase". Mixed case that is not a valid EIP-55 checksum is a typo, not an address.
// "校验和形式或全小写"。不是合法 EIP-55 的大小写混合是笔误，不是地址。
const isSpecAddress = (a) => isAddress(a) && (a === a.toLowerCase() || a === checksumAddress(a))

export function validateManifest(m, { requireDelegation = true, allowHttp = false, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) fail('manifest must be object')
  // MAJOR.MINOR, and a minor release only adds fields (arch B10): "0.N" for any N >= 1 is accepted, so publishing
  // "0.2" is not a flag day for every deployed client. Unknown fields were never refused (they are copied through),
  // so a 0.2 manifest's additions are ignored by a 0.1 client and 0.1 checks stay exactly as strict. Another major
  // may change meaning: refused.
  // 版本为 MAJOR.MINOR，次版本只增字段：接受任意 N >= 1 的 "0.N"，发布 "0.2" 不会让已部署的客户端集体失效。
  // 未知字段本来就不拒绝（原样保留），所以 0.2 新增的字段被 0.1 客户端忽略，0.1 的校验严格程度不变。其它主版本可能改变语义：拒绝。
  if (typeof m.tapeapi !== 'string' || !/^0\.[1-9]\d*$/.test(m.tapeapi)) fail(`tapeapi version must be "0.N" (N >= 1; this client implements 0.1 and ignores fields a later minor adds), got ${JSON.stringify(m.tapeapi)?.slice(0, 20)}`)
  // TAP-20 §3.3, field by field. Two clients must agree on whether a manifest is valid, so nothing is defaulted
  // that the table calls MUST (traceability D12). / 逐字段按 TAP-20 §3.3；两个客户端必须对清单是否有效达成一致。
  if (m.name !== undefined && (typeof m.name !== 'string' || codePoints(m.name) > MAX_NAME_LEN)) fail(`name, when present, must be a string of at most ${MAX_NAME_LEN} code points`)
  for (const k of ['circuits', 'container', 'signer']) if (!isSpecAddress(m[k])) fail(`${k} must be a 20-byte address, all lowercase or EIP-55 checksummed`)
  const tokenId = m.tokenId
  if (typeof tokenId !== 'string' || !/^(0|[1-9]\d*)$/.test(tokenId) || BigInt(tokenId) >= 2n ** 256n) fail('tokenId must be a decimal string with no leading zeros that fits uint256')
  let delegation = null
  if (m.delegation != null) {
    const d = m.delegation
    if (typeof d !== 'object') fail('delegation must be object')
    if (!Number.isInteger(d.expires) || d.expires <= 0) fail('delegation.expires must be positive integer')
    // the 366-day bound is a client SHOULD checked at resolution (DELEGATION_INVALID), not a schema rule
    // 366 天上限是客户端在解析时检查的 SHOULD（DELEGATION_INVALID），不是模式规则
    if (typeof d.sig !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(d.sig)) fail('delegation.sig must be 65-byte hex')
    delegation = { expires: d.expires, sig: d.sig }
  } else if (requireDelegation) fail('delegation required')
  const ep = m.endpoints
  if (!ep || typeof ep !== 'object' || !Array.isArray(ep.live)) fail('endpoints.live must be an array')
  if (typeof ep.async !== 'boolean') fail('endpoints.async must be a boolean')
  if (ep.live.length === 0 && !ep.async) fail('endpoints: live must be non-empty unless async is true')
  const live = ep.live.map(u => checkEndpoint(u, allowHttp))
  if (!Array.isArray(m.methods) || m.methods.length === 0) fail('methods must be a non-empty array')
  const seen = new Set()
  const methods = m.methods.map((x) => {
    if (!x || typeof x.name !== 'string' || !METHOD_NAME_RE.test(x.name) || FORBIDDEN_KEYS.has(x.name)) fail('method.name invalid (1..64 chars, [A-Za-z_][A-Za-z0-9_]*, not a prototype key)')
    if (seen.has(x.name)) fail(`duplicate method ${x.name}`); seen.add(x.name)
    // A missing price would be "free" to a lenient client and invalid to a strict one: never guess about money.
    // 缺失的价格对宽松客户端是"免费"、对严格客户端是无效：涉及钱的事绝不猜。
    if (typeof x.priceBEM !== 'string') fail(`method ${x.name}: priceBEM must be a decimal string ("0" for free)`)
    parseUnits(x.priceBEM, BEM_DECIMALS)
    for (const k of ['params', 'returns']) if (!x[k] || typeof x[k] !== 'object' || Array.isArray(x[k])) fail(`method ${x.name}: ${k} must be an object (MAY be {})`)
    if (x.description !== undefined && (typeof x.description !== 'string' || codePoints(x.description) > 256)) fail(`method ${x.name}: description must be a string of at most 256 code points`)
    return { ...x }
  })
  const pay = m.payment || {}
  // 全免费的服务不需要托管合约，因此可以不填 escrow —— 这让"零部署"的免费服务成立。
  // A service whose methods are all free needs no escrow, so it may omit it; this is what makes a
  // zero-deployment free service possible.
  const anyPriced = methods.some((x) => x.priceBEM && x.priceBEM !== '0')
  if (pay.escrow == null && !anyPriced) { /* free service: escrow omitted / 免费服务可省略 */ }
  else if (!isSpecAddress(pay.escrow)) fail(anyPriced ? 'payment.escrow must be an address when any method is priced' : 'payment.escrow must be address')
  // A priced method pointing at the zero address cannot settle anything: every paid call fails at request
  // time with an opaque decode error. Refuse at validation instead, where the message can name the cause.
  // 收费方法指向零地址结算不了任何东西：每次付费调用都在请求时以一个看不懂的解码错误失败。
  // 在校验期拒绝，错误信息才能说清原因。（冷启动测试 2026-09-21 发现）
  // A `dev: true` manifest is exempt: it is what every example boots with before an escrow exists, consumers
  // already treat dev manifests as not-for-money, and the provider refuses its paid calls with INTERNAL and logs why.
  // `dev: true` 的清单豁免：示例在托管部署前都以它启动；消费者本就把 dev 清单当作不收钱；提供者会以清楚的 INTERNAL 拒绝付费调用。
  else if (anyPriced && m.dev !== true && pay.escrow.toLowerCase() === ZERO_ADDRESS) {
    fail('payment.escrow is the zero address but some methods are priced; set a real escrow or price every method at 0')
  }
  if (pay.unit != null && pay.unit !== 'BEM') fail('payment.unit must be BEM')
  const decimals = pay.decimals == null ? BEM_DECIMALS : pay.decimals
  if (decimals !== BEM_DECIMALS) fail(`payment.decimals must be ${BEM_DECIMALS} (BEM's on-chain value)`)
  return {
    ...m, tokenId, delegation, methods,
    endpoints: { live, async: ep.async },
    payment: { escrow: pay.escrow ?? null, unit: 'BEM', decimals: BEM_DECIMALS },
  }
}
export function findMethod(manifest, name) { return manifest.methods.find(x => x.name === name) || null }
export function methodPrice(method) { return parseUnits(method.priceBEM || '0', BEM_DECIMALS) }
