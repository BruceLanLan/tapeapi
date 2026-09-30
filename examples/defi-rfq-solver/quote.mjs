// TAPI-24 Solver 的纯函数核心：定价、EIP-712 结构哈希/摘要、参数校验、报价簿。
// 这里**没有** HTTP、没有时钟、没有随机数：`now` 与 `quoteId` 都由调用方注入，
// 所以 `quote.test.mjs` 能对固定输入断言固定的 digest 与 signature，且永远不开套接字。
// 与 `examples/web2-adapter/adapter.mjs` 同一个分层方式。
//
// The pure core of the TAPI-24 Solver: pricing, the EIP-712 struct hash / digest, parameter validation and the
// quote book. There is **no** HTTP, no clock and no randomness in this file: `now` and `quoteId` are injected by
// the caller, so `quote.test.mjs` can assert a fixed digest and a fixed signature for fixed inputs and never opens
// a socket. Same layering as `examples/web2-adapter/adapter.mjs`.
import { TapeAPIError, abi, sig } from '@tapeapi/sdk'

const { isAddress, eqAddr, checksumAddress, encodeParams, toHex } = abi

const bad = (msg) => { throw new TapeAPIError('BAD_REQUEST', msg) }
const noRoute = (msg) => { throw new TapeAPIError('METHOD_NOT_FOUND', msg) }

// ---------- TAPI-24 §3.3 的常量 / the constants of TAPI-24 §3.3 ----------
// 主类型字符串一字不差地抄自 spec/TAPI-24.md §3.3；typehash 是该文件 §6 测试向量里的常量，
// 不是这里算出来再写死的——`selfCheck()` 在启动时把两者对上，不等就拒绝启动。
// The primary-type string is copied verbatim from spec/TAPI-24.md §3.3; the typehash is the constant from that
// file's §6 test-vector table, not something computed here and pasted. `selfCheck()` recomputes it at start-up
// and refuses to run on a mismatch.
export const QUOTE_TYPE_STRING =
  'Quote(bytes32 quoteId,uint64 fromChain,address fromToken,uint256 amountIn,uint64 toChain,address toToken,uint256 amountOut,address recipient,uint64 expires,address solver)'
export const QUOTE_TYPEHASH = '0xe7c18a58c429974068166f7c27b8ba2a9a13177c83aeb69cdcac7a4bc7592d59'
export const ESCROW_NAME = 'IntentEscrow'
export const ESCROW_NAME_HASH = '0x2043479336d59fcf0f30222e9c9f674b6a85c2fa5b5033d0c47e20469de7f0ba'
export const DOMAIN_VERSION = '1'

// abi.encode(TYPEHASH, …) 的类型表，顺序与主类型一字不差 / the abi.encode type list, in primary-type order
export const QUOTE_ENCODE_TYPES = [
  'bytes32', // QUOTE_TYPEHASH
  'bytes32', // quoteId
  'uint64',  // fromChain
  'address', // fromToken
  'uint256', // amountIn
  'uint64',  // toChain
  'address', // toToken
  'uint256', // amountOut
  'address', // recipient
  'uint64',  // expires
  'address', // solver
]
// `result.quote` 的字段名与顺序必须与主类型一致（规范 §3.4 的硬性要求）
// The field names and order of `result.quote` must match the primary type (spec §3.4).
export const QUOTE_FIELDS = ['quoteId', 'fromChain', 'fromToken', 'amountIn', 'toChain', 'toToken', 'amountOut', 'recipient', 'expires', 'solver']

// TAPI-24 §3.3：Solver SHOULD 用 30–120 秒 / TAPI-24 §3.3: Solvers SHOULD use 30–120 s
export const TTL_MIN = 30
export const TTL_MAX = 120
export const TTL_DEFAULT = 60
export const QUOTE_BOOK_MAX = 10000
// `status().note` 恒为这个字符串 / `status().note` is always exactly this string
export const STATUS_NOTE = 'IntentEscrow is not deployed; this is local bookkeeping only'

const HEX32_RE = /^0x[0-9a-fA-F]{64}$/
const UINT_DEC_RE = /^[1-9][0-9]*$/

/**
 * 启动自检：把主类型字符串重新 keccak 一遍，与 spec/TAPI-24.md §6 的两个常量比对。
 * 不等就抛——宁可拒绝启动，也不要签出一份 escrow 永远验不过的报价。
 * Start-up self-check: re-hash the primary-type string and compare against the two constants in
 * spec/TAPI-24.md §6. A mismatch throws: better to refuse to start than to sign quotes an escrow can never verify.
 */
export function selfCheck() {
  const typehash = toHex(abi.keccak256(QUOTE_TYPE_STRING))
  if (typehash !== QUOTE_TYPEHASH) {
    throw new Error(`QUOTE_TYPEHASH self-check failed: keccak256(typeString) = ${typehash}, spec/TAPI-24.md §6 says ${QUOTE_TYPEHASH}`)
  }
  const nameHash = toHex(abi.keccak256(ESCROW_NAME))
  if (nameHash !== ESCROW_NAME_HASH) {
    throw new Error(`keccak256("${ESCROW_NAME}") self-check failed: got ${nameHash}, spec/TAPI-24.md §6 says ${ESCROW_NAME_HASH}`)
  }
  return { typehash, nameHash }
}

// ---------- EIP-712（不是 personal_sign）/ EIP-712, not personal_sign ----------
/** TAPI-24 §3.3 的域：`chainId` 是 `fromChain`，`verifyingContract` 是该链上的 IntentEscrow。 */
export function quoteDomain(fromChain, escrow) {
  if (!isAddress(escrow)) throw new TapeAPIError('INTERNAL', `escrow for chain ${fromChain} is not an address`)
  return { name: ESCROW_NAME, version: DOMAIN_VERSION, chainId: Number(fromChain), verifyingContract: checksumAddress(escrow) }
}
/** `keccak256(abi.encode(QUOTE_TYPEHASH, quoteId, …, solver))` —— 返回 32 字节 / returns 32 bytes. */
export function quoteStructHash(q) {
  return abi.keccak256(encodeParams(QUOTE_ENCODE_TYPES, [
    QUOTE_TYPEHASH, q.quoteId, q.fromChain, q.fromToken, q.amountIn,
    q.toChain, q.toToken, q.amountOut, q.recipient, q.expires, q.solver,
  ]))
}
/**
 * `digest = keccak256(0x1901 ‖ DOMAIN_SEPARATOR ‖ structHash)`。
 * 用 SDK 的 `sig.typedDigest`，它就是这个式子；**不要**加 `\x19Ethereum Signed Message` 前缀，
 * 那是 TAPI-21 信封用的 EIP-191，与本报价无关。
 * Uses the SDK's `sig.typedDigest`, which is exactly that formula. Do **not** add the
 * `\x19Ethereum Signed Message` prefix — that is the EIP-191 used by the TAPI-21 envelope, not by this quote.
 */
export function quoteDigest(domain, q) {
  return sig.typedDigest(domain, quoteStructHash(q))
}
/**
 * 签一份报价。`sig.signDigest` 已经强制低 s 并把 `v` 归一到 {27,28}（DESIGN.md「全线拒绝高 s」）。
 * Signs a quote. `sig.signDigest` already forces low-s and normalises `v` into {27,28}.
 */
export function signQuote(q, domain, key) {
  const digest = quoteDigest(domain, q)
  return { digest: toHex(digest), signature: sig.signDigest(digest, key) }
}
/** 验一份报价：重算 digest、恢复地址、与 `quote.solver` 比对。README 的走查就是这三行。 */
export function verifyQuote(q, domain, signature) {
  const digest = quoteDigest(domain, q)
  const recovered = sig.recoverAddress(digest, signature)
  return { digest: toHex(digest), recovered, ok: eqAddr(recovered, q.solver) }
}

// ---------- 定价 / pricing ----------
/**
 * `amountOut = amountIn · num / den · 10^toDecimals / 10^fromDecimals · (10000 − spreadBps) / 10000`
 * 全程 BigInt，**从左到右**逐步求值，每一步都向零截断（BigInt 整除）。
 * 分组方式会改变截断结果，所以顺序是规范的一部分，不是实现细节：另一家 Solver 想给出逐字节相同的
 * `amountOut`，必须按同样的顺序算。
 * All BigInt, evaluated strictly **left to right**, truncating toward zero at every division. Regrouping the
 * expression changes the truncation, so the order is part of the specification, not an implementation detail.
 */
export function priceAmountOut({ amountIn, rateNumerator, rateDenominator, fromDecimals, toDecimals, solverSpreadBps }) {
  const den = BigInt(rateDenominator)
  if (den <= 0n) throw new TapeAPIError('INTERNAL', 'rateDenominator must be positive')
  const spread = BigInt(solverSpreadBps)
  if (spread < 0n || spread >= 10000n) throw new TapeAPIError('INTERNAL', 'solverSpreadBps must be in 0..9999')
  let v = BigInt(amountIn) * BigInt(rateNumerator) / den
  v = v * 10n ** BigInt(toDecimals) / 10n ** BigInt(fromDecimals)
  v = v * (10000n - spread) / 10000n
  return v
}

// ---------- 配置 / config ----------
/** 启动时校验一遍定价表，坏配置立刻暴露，而不是等到第一次报价。 */
export function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('quote config must be an object')
  const spread = config.solverSpreadBps
  if (!Number.isInteger(spread) || spread < 0 || spread >= 10000) throw new Error('solverSpreadBps must be an integer in 0..9999')
  if (!Array.isArray(config.routes) || config.routes.length === 0) throw new Error('config.routes must be a non-empty array')
  for (const r of config.routes) {
    if (!Number.isInteger(r.fromChain) || !Number.isInteger(r.toChain)) throw new Error('route fromChain/toChain must be integers')
    const escrow = config.escrow?.[String(r.fromChain)]
    if (!isAddress(escrow)) throw new Error(`config.escrow["${r.fromChain}"] must be an address (the IntentEscrow on that chain)`)
    if (!Array.isArray(r.pairs) || r.pairs.length === 0) throw new Error(`route ${r.fromChain}->${r.toChain} has no pairs`)
    for (const p of r.pairs) {
      if (!isAddress(p.fromToken) || !isAddress(p.toToken)) throw new Error('pair fromToken/toToken must be addresses')
      if (!UINT_DEC_RE.test(String(p.rateNumerator)) || !UINT_DEC_RE.test(String(p.rateDenominator))) throw new Error('pair rate must be positive integer strings')
      if (!Number.isInteger(p.fromDecimals) || !Number.isInteger(p.toDecimals)) throw new Error('pair decimals must be integers')
      if (!UINT_DEC_RE.test(String(p.maxAmountIn))) throw new Error('pair maxAmountIn must be a positive integer string')
    }
  }
  return config
}

/**
 * 找路线。TAPI-24 §3.2：不服务该路线的 Solver MUST 回 `METHOD_NOT_FOUND`——
 * 注意是 `METHOD_NOT_FOUND` 而不是 `BAD_REQUEST`，因为「这条路线我不做」等于「我没有这个方法」。
 * TAPI-24 §3.2: a Solver that does not serve the route MUST answer `METHOD_NOT_FOUND`.
 */
export function findPair(config, { fromChain, toChain, fromToken, toToken }) {
  const route = config.routes.find((r) => r.fromChain === fromChain && r.toChain === toChain)
  if (!route) noRoute(`this solver does not serve ${fromChain} -> ${toChain}`)
  const pair = route.pairs.find((p) => eqAddr(p.fromToken, fromToken) && eqAddr(p.toToken, toToken))
  if (!pair) noRoute(`this solver does not serve ${fromToken} -> ${toToken} on ${fromChain} -> ${toChain}`)
  return { route, pair }
}

/** 校验并归一化 `quote` 的入参。返回的都是已经过校验的值。 */
export function validateQuoteParams(params, config) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) bad('params must be an object')
  const { fromChain, toChain, fromToken, toToken, recipient, amountIn } = params
  if (!Number.isInteger(fromChain) || fromChain <= 0) bad('fromChain must be a positive integer')
  if (!Number.isInteger(toChain) || toChain <= 0) bad('toChain must be a positive integer')
  if (!isAddress(fromToken)) bad('fromToken must be an address')
  if (!isAddress(toToken)) bad('toToken must be an address')
  if (!isAddress(recipient)) bad('recipient must be an address')
  if (typeof amountIn !== 'string' || !UINT_DEC_RE.test(amountIn)) bad('amountIn must be a positive integer decimal string in the smallest unit of fromToken')

  const { route, pair } = findPair(config, { fromChain, toChain, fromToken, toToken })

  if (BigInt(amountIn) > BigInt(pair.maxAmountIn)) bad(`amountIn exceeds maxAmountIn ${pair.maxAmountIn} for this pair`)

  const ttl = params.ttl === undefined || params.ttl === null ? TTL_DEFAULT : params.ttl
  if (!Number.isInteger(ttl) || ttl < TTL_MIN || ttl > TTL_MAX) bad(`ttl must be an integer in ${TTL_MIN}..${TTL_MAX} seconds (TAPI-24 §3.3)`)

  return { fromChain, toChain, fromToken, toToken, recipient, amountIn, ttl, route, pair }
}

/**
 * 造一份报价。`now`（Unix 秒）与 `quoteId`（32 字节 hex）由调用方注入：
 * 这两样是 `quote` 不可能进 quorum 的直接原因（规范 §3.2），也是本文件可单测的原因。
 * `now` (Unix seconds) and `quoteId` (32-byte hex) are injected by the caller. Those two are exactly why `quote`
 * can never enter a quorum round (spec §3.2) — and why this file is unit-testable.
 */
export function buildQuote({ config, solver, params, now, quoteId }) {
  if (!isAddress(solver)) throw new TapeAPIError('INTERNAL', 'solver must be an address')
  if (!HEX32_RE.test(quoteId)) throw new TapeAPIError('INTERNAL', 'quoteId must be 32 bytes of hex')
  if (!Number.isInteger(now) || now <= 0) throw new TapeAPIError('INTERNAL', 'now must be a positive integer (unix seconds)')
  const v = validateQuoteParams(params, config)
  const amountOut = priceAmountOut({
    amountIn: v.amountIn,
    rateNumerator: v.pair.rateNumerator, rateDenominator: v.pair.rateDenominator,
    fromDecimals: v.pair.fromDecimals, toDecimals: v.pair.toDecimals,
    solverSpreadBps: config.solverSpreadBps,
  })
  if (amountOut <= 0n) bad('amountIn is too small: amountOut truncates to zero')
  // 字段顺序 = 主类型顺序 / field order == primary-type order
  const quote = {
    quoteId,
    fromChain: v.fromChain,
    fromToken: checksumAddress(v.fromToken),
    amountIn: v.amountIn,
    toChain: v.toChain,
    toToken: checksumAddress(v.toToken),
    amountOut: amountOut.toString(),
    recipient: checksumAddress(v.recipient),
    expires: now + v.ttl,
    solver: checksumAddress(solver),
  }
  const escrow = checksumAddress(config.escrow[String(v.fromChain)])
  return { quote, escrow, domain: quoteDomain(v.fromChain, escrow), ttl: v.ttl }
}

// ---------- 报价簿 / quote book ----------
/**
 * LRU，上限 `QUOTE_BOOK_MAX` 条（规范 §3.4）。**这是本进程的内存，不是链上事实**：
 * 进程一重启就全没了，`IntentEscrow` 也根本没有部署。
 * An LRU capped at `QUOTE_BOOK_MAX` entries. **This is process memory, not an on-chain fact**: it dies with the
 * process, and `IntentEscrow` is not deployed at all.
 */
export function createQuoteBook(max = QUOTE_BOOK_MAX) {
  const m = new Map()
  return {
    get size() { return m.size },
    put(quote) {
      m.delete(quote.quoteId)
      m.set(quote.quoteId, quote)
      while (m.size > max) m.delete(m.keys().next().value) // 最旧的先走 / evict the oldest
      return quote
    },
    get(quoteId) {
      if (!m.has(quoteId)) return null
      const q = m.get(quoteId)
      m.delete(quoteId); m.set(quoteId, q) // 读也算一次使用 / a read counts as a use
      return q
    },
  }
}

/** `status()` 的纯函数部分。`onChain` 恒为 `null`，`note` 恒为 `STATUS_NOTE`。 */
export function quoteStatus(book, quoteId, now) {
  if (typeof quoteId !== 'string' || !HEX32_RE.test(quoteId)) bad('quoteId must be a 32-byte hex string')
  const q = book.get(quoteId)
  const state = !q ? 'unknown' : now <= q.expires ? 'quoted' : 'expired'
  return {
    quoteId,
    state,
    expires: q ? q.expires : 0,
    quote: q ?? null,
    onChain: null, // 链上从来没被问过；IntentEscrow 不存在 / nothing on-chain was ever consulted
    note: STATUS_NOTE,
  }
}
