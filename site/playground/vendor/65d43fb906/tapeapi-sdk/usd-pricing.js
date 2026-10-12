// @experimental Prices in US dollars, paid in BEM: the TAP draft "Payment Vouchers for Container Services"
// (TapeOutProtocol/TAPs#52, discussion #38). Experimental since 2.0: every name here may change with the TAP.
// A manifest without the top-level member `usdPricing` never reaches this module, so 1.8.1 behaviour is unchanged
// (server/test/payment-golden.test.mjs).
// @experimental 美元报价、BEM 结算：TAP 草稿 "Payment Vouchers for Container Services"（TAPs#52，讨论 #38）。2.0 起为实验性，
// 名字都可能随 TAP 改变。不带顶层成员 `usdPricing` 的清单不会走到这里，1.8.1 的行为不变。
//
//   §4.1 validateUsdPricing        manifest member `usdPricing`
//   §4.3 convertUsd                charge = min(ceil(U·10^18 / R), P), capped = converted > P, exact integers only
//   §4.4 validateQuote             { rate, asOf, validUntil }
//   §4.5 readReferenceRates        `observe([window, 0])` on the pools the manifest names, at one pinned block
//   §6   BAD_VOUCHER_REASONS       the nine values of error.data.reason
//   §7   chargeRecord / checkChargeRecord
import { TapeAPIError } from './errors.js'
import { isAddress, eqAddr, checksumAddress, hexToBytes, bytesToHex } from './abi.js'
import { parseUnits, BEM_DECIMALS } from './manifest.js'
import { FORBIDDEN_KEYS } from './canon.js'

const invalid = (m) => { throw new TapeAPIError('MANIFEST_INVALID', `usdPricing: ${m}`) }
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

/** @experimental BEM on BNB Smart Chain (chain 56), 8 decimals (draft §1). */
export const BEM_ADDRESS = '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a'
/** @experimental The settlement chain (draft §2.1): BEM exists only on BNB Smart Chain. */
export const SETTLEMENT_CHAIN_ID = 56
/** @experimental Tokens this client recognises as worth one US dollar for a `v3-twap` source's `usd` (draft §4.5).
 *  Binance-Peg BSC-USD only; a caller can pass its own list. / 本客户端认作一美元的代币；调用方可传自己的表。 */
export const DEFAULT_USD_TOKENS = Object.freeze(['0x55d398326f99059fF775485246999027B3197955'])
/** @experimental §6: error.data.reason of BAD_VOUCHER, in the order of the checks of §5.2. */
export const BAD_VOUCHER_REASONS = Object.freeze(['malformed', 'provider', 'expired', 'lifetime', 'signature', 'rate', 'stale', 'insufficient', 'funds'])
export const USD_PRICE_RE = /^[0-9]+(\.[0-9]{1,8})?$/
export const RATE_RE = /^[0-9]+(\.[0-9]{1,18})?$/
export const BASE_UNIT_RE = /^(0|[1-9][0-9]*)$/
export const AMOUNT_RE = /^[0-9]+\.[0-9]{8}$/
export const MAX_UINT256 = (1n << 256n) - 1n
export const TOLERANCE_BPS = Object.freeze({ min: 1, max: 2000 })
export const MAX_QUOTE_S = Object.freeze({ min: 1, max: 900 })
export const TWAP_WINDOW_S = Object.freeze({ min: 600, max: 86400 })

// A decimal string of the draft's forms to an integer number of 10^-d units, or null. / 十进制字符串 → 10^-d 单位的整数。
function units(s, re, d) {
  if (typeof s !== 'string' || !re.test(s)) return null
  const [i, f = ''] = s.split('.')
  return BigInt(i) * 10n ** BigInt(d) + BigInt((f + '0'.repeat(d)).slice(0, d) || '0')
}
/** @experimental A USD price ("0.01") as an integer of 10^-8 USD; MANIFEST_INVALID unless it matches §4.1 and is non-zero. */
export function parseUsdPrice(s) {
  const u = units(s, USD_PRICE_RE, 8)
  if (u === null || u === 0n) throw new TapeAPIError('MANIFEST_INVALID', `a USD price is a non-zero decimal string with at most 8 fraction digits, got ${JSON.stringify(s)?.slice(0, 40)}`)
  return u
}
/** @experimental A rate (USD per 1 BEM) as an integer of 10^-18 USD; BAD_QUOTE unless it matches §4.4 and is non-zero. */
export function parseRate(s) {
  const r = units(s, RATE_RE, 18)
  if (r === null || r === 0n) throw new TapeAPIError('BAD_QUOTE', `a rate is a non-zero decimal string with at most 18 fraction digits, got ${JSON.stringify(s)?.slice(0, 60)}`)
  return r
}
/** @experimental 8 fraction digits, as the amount object of §1 writes them. / 按 §1 的金额对象写成 8 位小数。 */
export function formatAmount8(n) {
  const v = BigInt(n)
  if (v < 0n) throw new TapeAPIError('INVALID_ARGUMENT', 'an amount is not negative')
  const s = v.toString().padStart(9, '0')
  return `${s.slice(0, -8)}.${s.slice(-8)}`
}
/** @experimental { currency, amount } with exactly these two members in this order (§1). */
export function amountObject(n, currency = 'BEM') { return { currency, amount: formatAmount8(n) } }
/** @experimental The integer an amount object stands for (10^-8 of its currency), or null when it is not one. */
export function amountValue(o, currency) {
  if (!isPlain(o) || Object.keys(o).length !== 2 || o.currency !== currency || typeof o.amount !== 'string' || !AMOUNT_RE.test(o.amount)) return null
  return units(o.amount, /^[0-9]+\.[0-9]{8}$/, 8)
}

/**
 * @experimental §4.3. Exact integer arithmetic, no floating point and no upper bound.
 *   U = priceUSD in 10^-8 USD, R = rate in 10^-18 USD per BEM, P = cap (priceBEM) in base units
 *   converted = ceil(U × 10^18 / R); charge = min(converted, P); capped = converted > P
 * Throws MANIFEST_INVALID for a price or a cap that is not one (a cap of zero in value included) and BAD_QUOTE for a rate.
 */
export function convertUsd({ priceUSD, rate, priceBEM }) {
  const U = parseUsdPrice(priceUSD)
  const R = parseRate(rate)
  const P = units(priceBEM, USD_PRICE_RE, BEM_DECIMALS)
  if (P === null || P === 0n) throw new TapeAPIError('MANIFEST_INVALID', `the cap (priceBEM) of a USD-priced method is a non-zero decimal string with at most 8 fraction digits, got ${JSON.stringify(priceBEM)?.slice(0, 40)}`)
  const converted = (U * 10n ** 18n + R - 1n) / R
  const charge = converted < P ? converted : P
  return { U, R, P, converted, charge, capped: converted > P }
}

const priced = (m) => { try { return parseUnits(m.priceBEM ?? '0', BEM_DECIMALS) > 0n } catch { return false } }

/**
 * @experimental §4.1 and §4.5. Validates the top-level member `usdPricing` of a manifest (the published object or the
 * copy validateManifest returns) and returns a normalised copy, or null when the manifest has no such member. Throws
 * MANIFEST_INVALID when the member breaks a rule: then no USD-priced method of the service may be paid, while its free
 * and BEM-priced methods stay usable (validateManifest never calls this).
 *   usdTokens: the dollar tokens this client recognises (default DEFAULT_USD_TOKENS); a source whose `usd` is not one
 *   of them is treated as a source of an unknown type. `null` skips that filter (a provider checking its own manifest).
 * @experimental §4.1 与 §4.5。校验清单顶层成员 `usdPricing`，返回规范化副本；没有该成员返回 null。违反规则抛 MANIFEST_INVALID：
 * 此时该服务的 USD 计价方法都不能付费，免费与 BEM 计价方法照常可用（validateManifest 从不调用它）。
 */
export function validateUsdPricing(manifest, { usdTokens = DEFAULT_USD_TOKENS } = {}) {
  if (!isPlain(manifest) || !hasOwn(manifest, 'usdPricing')) return null
  const up = manifest.usdPricing
  if (!isPlain(up)) invalid('must be an object')
  if (!isPlain(up.methods) || Object.keys(up.methods).length === 0) invalid('methods must be a non-empty object')
  const list = Array.isArray(manifest.methods) ? manifest.methods : []
  const methods = {}
  for (const [name, price] of Object.entries(up.methods)) {
    if (FORBIDDEN_KEYS.has(name)) invalid(`method name ${name} is not allowed`)
    const def = list.find((m) => m && m.name === name)
    if (!def) invalid(`${name} is not a method of the manifest`)
    if (!priced(def)) invalid(`${name} is not a priced method (its priceBEM, the cap, must not be zero in value)`)
    if (typeof price !== 'string' || !USD_PRICE_RE.test(price) || units(price, USD_PRICE_RE, 8) === 0n) invalid(`${name}: a USD price matches ^[0-9]+(\\.[0-9]{1,8})?$ and is not zero in value`)
    methods[name] = price
  }
  const int = (k, { min, max }) => { const v = up[k]; if (!Number.isInteger(v) || v < min || v > max) invalid(`${k} must be an integer from ${min} to ${max}`); return v }
  const toleranceBps = int('toleranceBps', TOLERANCE_BPS)
  const maxQuoteS = int('maxQuoteS', MAX_QUOTE_S)
  if (!Array.isArray(up.rateSources) || up.rateSources.length === 0) invalid('rateSources must be a non-empty array')
  const known = usdTokens === null ? null : usdTokens.map((a) => String(a).toLowerCase())
  const rateSources = []
  up.rateSources.forEach((s, i) => {
    if (!isPlain(s)) invalid(`rateSources[${i}] must be an object`)
    if (s.type !== 'v3-twap') return   // §4.5: ignored, a type this client does not know / 不认识的类型：忽略
    if (!isAddress(s.pool)) invalid(`rateSources[${i}].pool must be 0x and 40 hex digits`)
    if (!isAddress(s.usd)) invalid(`rateSources[${i}].usd must be 0x and 40 hex digits`)
    if (!Number.isInteger(s.window) || s.window < TWAP_WINDOW_S.min || s.window > TWAP_WINDOW_S.max) invalid(`rateSources[${i}].window must be an integer from ${TWAP_WINDOW_S.min} to ${TWAP_WINDOW_S.max}`)
    if (eqAddr(s.usd, BEM_ADDRESS)) invalid(`rateSources[${i}].usd is BEM itself`)
    if (known && !known.includes(s.usd.toLowerCase())) return   // §4.5: an unrecognised dollar token is an unknown source / 不认识的美元代币当未知来源
    rateSources.push({ type: 'v3-twap', pool: checksumAddress(s.pool), usd: checksumAddress(s.usd), window: s.window })
  })
  if (!rateSources.length) invalid('no rate source of a known type with a recognised dollar token remains (§4.5)')
  return { methods, toleranceBps, maxQuoteS, rateSources }
}
/** @experimental { usdPricing } normalised, { error } when the member is invalid, or null when there is none. Never throws. */
export function usdPricingOf(manifest, opts) {
  try { const v = validateUsdPricing(manifest, opts); return v ? { usdPricing: v } : null }
  catch (e) { if (e instanceof TapeAPIError) return { error: e }; throw e }
}

/**
 * @experimental §4.4. A quote as received: an object with exactly `rate`, `asOf` and `validUntil`, rate per §4.4,
 * asOf ≤ ts (the envelope that carried it) and asOf < validUntil ≤ asOf + maxQuoteS. Returns a copy; BAD_QUOTE otherwise.
 */
export function validateQuote(q, { maxQuoteS, ts } = {}) {
  const bad = (m) => { throw new TapeAPIError('BAD_QUOTE', `quote: ${m}`) }
  if (!isPlain(q)) bad('must be an object')
  const keys = Object.keys(q).sort()
  if (keys.length !== 3 || keys[0] !== 'asOf' || keys[1] !== 'rate' || keys[2] !== 'validUntil') bad('has exactly the members rate, asOf and validUntil')
  parseRate(q.rate)
  if (!Number.isSafeInteger(q.asOf) || q.asOf < 0) bad('asOf must be Unix seconds')
  if (!Number.isSafeInteger(q.validUntil)) bad('validUntil must be Unix seconds')
  if (ts !== undefined && q.asOf > ts) bad(`asOf ${q.asOf} is later than the envelope's ts ${ts}`)
  if (!(q.asOf < q.validUntil)) bad('asOf must be before validUntil')
  if (maxQuoteS !== undefined && q.validUntil > q.asOf + maxQuoteS) bad(`validUntil is more than maxQuoteS (${maxQuoteS} s) after asOf`)
  return { rate: q.rate, asOf: q.asOf, validUntil: q.validUntil }
}

// ---------- §4.5 reference rate ----------
const SEL = { token0: '0x0dfe1681', token1: '0xd21220a7', decimals: '0x313ce567', observe: '0x883bdbfd' }
const word = (n) => BigInt(n).toString(16).padStart(64, '0')
/** @experimental calldata of observe([window, 0]) / observe([window, 0]) 的调用数据 */
export function encodeObserve(window) {
  if (!Number.isInteger(window) || window < 0 || window >= 2 ** 32) throw new TapeAPIError('INVALID_ARGUMENT', 'window must fit uint32')
  return SEL.observe + word(32) + word(2) + word(window) + word(0)
}
const int256 = (w) => { const v = BigInt('0x' + w); return v >= 1n << 255n ? v - (1n << 256n) : v }
/** @experimental Decodes (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s); returns the two tick
 *  cumulatives as BigInt. Strict: exactly two of each, each int56 in range. / 严格解码 observe 的返回值。 */
export function decodeObserve(hex) {
  const bad = (m) => { throw new TapeAPIError('ABI_INVALID', `observe: ${m}`) }
  if (typeof hex !== 'string' || !/^0x([0-9a-fA-F]{64})*$/.test(hex)) bad('return data is not whole words')
  const b = hex.slice(2), w = (i) => { const s = b.slice(i * 64, i * 64 + 64); if (s.length !== 64) bad('return data too short'); return s }
  const off = (i) => { const v = BigInt('0x' + w(i)); if (v % 32n || v > BigInt(b.length / 2)) bad('bad offset'); return Number(v / 32n) }
  const a = off(0), c = off(1)
  if (BigInt('0x' + w(a)) !== 2n || BigInt('0x' + w(c)) !== 2n) bad('expected two observations')
  const tc = [int256(w(a + 1)), int256(w(a + 2))]
  for (const t of tc) if (t < -(1n << 55n) || t >= 1n << 55n) bad('a tick cumulative is outside int56')
  return tc
}
const floorDiv = (a, b) => { const q = a / b; return a % b !== 0n && (a < 0n) !== (b < 0n) ? q - 1n : q }
/** @experimental §4.5 step 3: floor((c1 − c0) / window), rounding toward negative infinity. */
export function meanTick([c0, c1], window) { return floorDiv(BigInt(c1) - BigInt(c0), BigInt(window)) }
/** @experimental §4.5 steps 4–5, in floating point (allowed: the reference is only compared). USD per 1 BEM. */
export function rateFromTick(tick, { bemIsToken0, usdDecimals, bemDecimals = BEM_DECIMALS }) {
  const p = Math.pow(1.0001, Number(tick))
  return bemIsToken0 ? p * 10 ** (bemDecimals - usdDecimals) : 1 / (p * 10 ** (usdDecimals - bemDecimals))
}
/** @experimental The median; for an even count, the mean of the two middle values. null for none. */
export function median(xs) {
  const v = xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b)
  if (!v.length) return null
  const m = v.length >> 1
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}
/** @experimental The client's check of §4.5: a quote fails when rate × 10000 < reference × (10000 − toleranceBps). */
export function quotePasses(rate, reference, toleranceBps) {
  parseRate(rate)
  if (!(Number.isFinite(reference) && reference > 0)) return false
  return Number(rate) * 10000 >= reference * (10000 - toleranceBps)
}
/** @experimental A float rate written as a rate string of §4.4: the shortest decimal that reads back as the same number,
 *  cut (not rounded) to 18 fraction digits; never zero. / 浮点汇率写成 §4.4 的字符串：最短往返十进制，截到 18 位小数，不为零。 */
export function formatRate(x) {
  if (!(Number.isFinite(x) && x > 0) || x >= 1e21) throw new TapeAPIError('INVALID_ARGUMENT', 'a rate is a positive finite number')
  let s = String(x)
  if (/e/i.test(s)) s = x.toFixed(20)
  const [i, f = ''] = s.split('.')
  s = (f ? `${i}.${f.slice(0, 18)}` : i).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  if (units(s, RATE_RE, 18) === 0n) throw new TapeAPIError('INVALID_ARGUMENT', 'the rate rounds to zero at 18 fraction digits')
  return s
}

/**
 * @experimental §4.5. Reads the reference rate of every source at ONE block, read under TAP-10 node agreement: the block
 * comes from `rpc.confirmedBlock('latest')` (or `opts.block`, { number, hash, timestamp }), every read is an eth_call
 * pinned to its hash (EIP-1898) with strict agreement, and the block may be at most `maxAgeS` old by `now`. A source
 * whose tokens are not BEM and its `usd`, whose decimals cannot be read, or whose observe fails, has no rate (it is
 * reported with `reason`, never guessed). Returns { block, sources: [{ pool, usd, window, meanTick?, rate?, reason? }],
 * reference } with reference the median of the rates, or null when no source gave one.
 * @experimental §4.5。在**一个**按 TAP-10 节点共识确认的区块上读取每个来源：区块取自 `rpc.confirmedBlock('latest')`（或 `opts.block`），
 * 每次读取都是钉在其哈希上的严格 eth_call，区块按 `now` 至多 `maxAgeS` 秒旧。代币不是 BEM 与其 `usd`、读不出 decimals 或 observe
 * 失败的来源没有汇率（附 `reason`，从不猜）。reference 为各汇率的中位数，没有任何汇率时为 null。
 */
export async function readReferenceRates(rpc, sources, { block, maxAgeS, now = Math.floor(Date.now() / 1000), bem = BEM_ADDRESS, strict = true } = {}) {
  if (!rpc || typeof rpc.ethCall !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', 'readReferenceRates needs an rpc client (createRpc)')
  const B = block ?? await rpc.confirmedBlock('latest')
  if (!B || typeof B.hash !== 'string' || !Number.isSafeInteger(B.timestamp)) throw new TapeAPIError('INVALID_ARGUMENT', 'block must be { number, hash, timestamp }')
  if (maxAgeS !== undefined && now - B.timestamp > maxAgeS) throw new TapeAPIError('RPC_STALE', `the pinned block ${B.number} is ${now - B.timestamp} s old, more than ${maxAgeS} s`, { data: { status: 'stale-block', block: B.number } })
  const at = { blockHash: B.hash, requireCanonical: true }
  const read = (to, data) => rpc.ethCall(to, data, at, strict ? { strict: true } : undefined)
  const addrOf = (hex) => { if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hex) || !/^0x0{24}/.test(hex)) throw new TapeAPIError('ABI_INVALID', 'not an address'); return '0x' + hex.slice(26) }
  const out = await Promise.all(sources.map(async (s) => {
    const r = { pool: s.pool, usd: s.usd, window: s.window }
    try {
      const [t0, t1] = (await Promise.all([read(s.pool, SEL.token0), read(s.pool, SEL.token1)])).map(addrOf)
      const bemIsToken0 = eqAddr(t0, bem) && eqAddr(t1, s.usd)
      if (!bemIsToken0 && !(eqAddr(t1, bem) && eqAddr(t0, s.usd))) return { ...r, reason: 'tokens' }
      const d = await read(s.usd, SEL.decimals)
      if (typeof d !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(d) || BigInt(d) > 77n) return { ...r, reason: 'decimals' }
      let tc
      try { tc = decodeObserve(await read(s.pool, encodeObserve(s.window))) } catch (e) { return { ...r, reason: 'observe', detail: String(e?.message ?? e).slice(0, 200) } }
      const t = meanTick(tc, s.window)
      const rate = rateFromTick(t, { bemIsToken0, usdDecimals: Number(BigInt(d)) })
      if (!(Number.isFinite(rate) && rate > 0)) return { ...r, meanTick: t.toString(), reason: 'range' }
      return { ...r, bemIsToken0, usdDecimals: Number(BigInt(d)), meanTick: t.toString(), rate }
    } catch (e) {
      // a node disagreement is not "no rate": it is reported as such / 节点不一致不是"没有汇率"，照实报告
      if (e instanceof TapeAPIError && (e.code === 'RPC_DISAGREE' || e.code === 'INVALID_ARGUMENT')) throw e
      return { ...r, reason: 'read', detail: String(e?.message ?? e).slice(0, 200) }
    }
  }))
  return { block: { number: B.number, hash: B.hash, timestamp: B.timestamp }, sources: out, reference: median(out.map((x) => x.rate).filter((x) => x !== undefined)) }
}

// ---------- §7 charge record ----------
/** @experimental §7. The member `charge` of a priced result. `quote` and `usd` only for a USD-priced method:
 *  usd = { priceUSD, rate, rateAsOf, capped }. */
export function chargeRecord({ consumer, cumulative, amount, usd, quote }) {
  const rec = { consumer: checksumAddress(consumer), cumulative: BigInt(cumulative).toString(), amount: amountObject(amount, 'BEM') }
  if (usd) {
    rec.price = amountObject(parseUsdPrice(usd.priceUSD), 'USD')
    rec.rate = usd.rate
    rec.rateAsOf = usd.rateAsOf
    if (usd.capped) rec.capped = true
    rec.quote = quote
  }
  return rec
}

/**
 * @experimental §8.3, the client's check of a charge record on an accepted result. Returns { ok: true } or
 * { ok: false, kind: 'unbound' | 'fault', why }: 'unbound' (item 1) when the record is missing or names another consumer
 * or cumulative than the voucher sent (the path or the provider erred, the client cannot tell which); 'fault' (item 2)
 * when the provider signed a wrong amount, price, rate or `capped`.
 *   voucher: what was sent; last: the client's `last` when it signed; usd: { priceUSD, priceBEM } of a USD-priced method.
 */
export function checkChargeRecord(charge, { voucher, last, usd }) {
  if (!isPlain(charge)) return { ok: false, kind: 'unbound', why: 'the result carries no charge record' }
  if (typeof charge.consumer !== 'string' || !eqAddr(charge.consumer, voucher.consumer)) return { ok: false, kind: 'unbound', why: 'the charge record names another consumer' }
  if (typeof charge.cumulative !== 'string' || !BASE_UNIT_RE.test(charge.cumulative) || BigInt(charge.cumulative) !== BigInt(voucher.cumulative)) return { ok: false, kind: 'unbound', why: 'the charge record names another cumulative' }
  const amount = amountValue(charge.amount, 'BEM')
  if (amount === null || amount !== BigInt(voucher.cumulative) - BigInt(last)) return { ok: false, kind: 'fault', why: `the charge record's amount is not cumulative − last (${BigInt(voucher.cumulative) - BigInt(last)} base units)` }
  if (usd) {
    const price = amountValue(charge.price, 'USD')
    if (price === null || price !== parseUsdPrice(usd.priceUSD)) return { ok: false, kind: 'fault', why: "the charge record's price is not the manifest's" }
    // `rate` is not under the voucher's signature, so the path can change it: like a missing record, the client cannot
    // tell the path from the provider (review S1) / `rate` 不在凭证签名之内，路径可以改它：与缺记录一样分不清路径与提供者
    if (charge.rate !== voucher.rate) return { ok: false, kind: 'unbound', why: "the charge record's rate is not the voucher's (the rate is not signed: the path or the provider changed it)" }
    if (!Number.isSafeInteger(charge.rateAsOf)) return { ok: false, kind: 'fault', why: 'the charge record has no rateAsOf' }
    const { capped } = convertUsd({ priceUSD: usd.priceUSD, rate: voucher.rate, priceBEM: usd.priceBEM })
    if (capped ? charge.capped !== true : charge.capped !== undefined) return { ok: false, kind: 'fault', why: `the charge record's capped does not match the conversion (${capped})` }
  }
  return { ok: true }
}

/** @experimental The wire form of §3.2 as a provider checks it (item 1, `malformed`); rate is checked separately. */
export function voucherWireProblem(v) {
  if (!isPlain(v)) return 'voucher is not an object'
  if (!isAddress(v.consumer) || !isAddress(v.provider)) return 'consumer and provider must be 0x and 40 hex digits'
  if (typeof v.cumulative !== 'string' || !BASE_UNIT_RE.test(v.cumulative) || BigInt(v.cumulative) > MAX_UINT256) return 'cumulative must be a base-unit string (no sign, fraction or leading zeros) of at most 2^256 − 1'
  if (!Number.isSafeInteger(v.expires) || v.expires < 0) return 'expires must be an integer from 0 to 2^53 − 1'
  if (typeof v.sig !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(v.sig)) return 'sig must be 0x and 130 hex digits'
  if (v.signer !== undefined && !isAddress(v.signer)) return 'signer, when present, must be 0x and 40 hex digits'
  if (v.rate !== undefined && typeof v.rate !== 'string') return 'rate, when present, must be a string'
  return null
}
/** @experimental A 65-byte signature with v of 0 or 1 rewritten as 27 or 28 (a signer MUST send 27 or 28, §3.1). */
export function normaliseV(sigHex) {
  const b = hexToBytes(sigHex)
  if (b.length === 65 && (b[64] === 0 || b[64] === 1)) { b[64] += 27; return '0x' + bytesToHex(b) }
  return sigHex
}
