// defi-twap-oracle 的纯函数部分：窗口校验、tick → 价格、偏离标志、结果装配。
// 不联网、不读环境变量、不看时钟。TWAP 的算术本身（meanTick、TickMath、getQuoteAtTick）在
// `../_lib/codec.mjs` 里，因为 `defi-portfolio-read` 之外的示例也可能用到，而且定点实现绝不能有第二份。
//
// The pure half of defi-twap-oracle: window validation, tick-to-price, the deviation flag and result assembly.
// No network, no environment, no clock. The TWAP arithmetic itself (meanTick, TickMath, getQuoteAtTick) lives
// in `../_lib/codec.mjs` — there must never be a second fixed-point implementation to drift against.
import { TapeAPIError } from '@tapeapi/sdk'
import { fixed, getQuoteAtTick, deviationBps, meanTickFromCumulatives } from '../_lib/codec.mjs'

// 错误的结构化字段**必须**放在 `data` 下：`TapeAPIError` 用 `Object.assign` 把 extra 摊平到错误对象上，
// 但 `server/src/index.js` 只把 `e.data`（且必须是纯对象）写进信封。直接摊平的字段到不了调用方。
// Structured error fields MUST go under `data`: `TapeAPIError` flattens extras onto the error object, but
// `server/src/index.js` only copies `e.data` (and only when it is a plain object) into the envelope —
// anything flattened elsewhere never reaches the caller.
const bad = (msg, data) => { throw new TapeAPIError('BAD_REQUEST', msg, data ? { data } : undefined) }

export const PRICE_DECIMALS = 18          // 价格字符串固定 18 位 / price strings are always 18 places
export const MIN_WINDOW = 60
export const MAX_WINDOW = 86400
export const DEFAULT_WINDOW = 1800        // 行业基准：Uniswap Labs «most protocols use a 30 minute running TWAP»
export const DEFAULT_DEVIATION_BPS = 100  // Venus BoundValidator 对 BNB 用的是 ±1% / Venus's BoundValidator uses ±1% for BNB
export const BLOCK_TIME_S = 0.45          // BNB Chain，Fermi 硬分叉（BEP-619，主网 2026-01-14）；按当期公告核对

// PancakeV3Factory 构造函数里硬编码的费率档 → tickSpacing。**与 Uniswap V3 的 500/3000/10000 不同。**
// Fee tiers hard-coded in PancakeV3Factory's constructor. Note these differ from Uniswap V3's 500/3000/10000.
export const TICK_SPACING = { 100: 1, 500: 10, 2500: 50, 10000: 200 }

export function requireWindow(window) {
  const w = window == null ? DEFAULT_WINDOW : window
  if (!Number.isInteger(w) || w < MIN_WINDOW || w > MAX_WINDOW) {
    bad(`window must be an integer number of seconds in ${MIN_WINDOW}..${MAX_WINDOW}`)
  }
  return w
}

export function requireFee(fee) {
  if (!Number.isInteger(fee) || !(fee in TICK_SPACING)) {
    bad(`fee must be one of ${Object.keys(TICK_SPACING).join(' | ')} (PancakeSwap V3 tiers, not Uniswap's)`)
  }
  return fee
}

export function requireDeviationBps(v) {
  const n = v == null ? DEFAULT_DEVIATION_BPS : v
  if (!Number.isInteger(n) || n < 0 || n > 10000) bad('deviationBps must be an integer in 0..10000')
  return n
}

/**
 * §2.5 的降级闸门。这两条检查**在发 `observe` 之前**做，因为 `observe` 的 `OLD` revert 按 TAP-23 §3.3
 * 属于合约 revert（`INTERNAL`），而这里其实是**本服务自己的参数校验失败**，归 `BAD_REQUEST` 更准确 ——
 * 调用方能据此把窗口调短再试，而 `INTERNAL` 会让它以为是我们坏了。
 *
 * The degradation gate. Both checks run **before** sending `observe`, because an `OLD` revert would be a
 * contract revert (`INTERNAL` per TAP-23 §3.3) when what actually happened is that this service's own
 * parameter validation failed — `BAD_REQUEST` is the accurate code, and it tells the caller to shorten the
 * window and retry instead of suggesting we are broken. The trade-off is noted in the README.
 */
export function checkObservationWindow({ pool, window, observationCardinality, maxWindow }) {
  if (observationCardinality < 2) {
    bad(`pool ${pool} has observationCardinality ${observationCardinality}; TWAP unavailable (needs increaseObservationCardinalityNext, a write this service cannot make)`,
      { observationCardinality, maxWindow })
  }
  if (window > maxWindow) {
    bad(`window ${window}s exceeds this pool's observation history (${maxWindow}s available, cardinality ${observationCardinality})`,
      { observationCardinality, maxWindow })
  }
  return { observationCardinality, maxWindow }
}

/**
 * tick → "1 个 base 单位值多少个 quote"，输出 18 位定点字符串。
 * `getQuoteAtTick` 返回的是 quote 的最小单位，所以要按 quote 的小数位重新缩放到 18 位。
 * A tick to “how much quote is one whole base worth”, as an 18-place fixed-width string. `getQuoteAtTick`
 * returns quote minimal units, so the result is rescaled from the quote's own decimals to 18 places.
 */
export function priceAtTick(tick, base, quote) {
  const raw = getQuoteAtTick(tick, 10n ** BigInt(base.decimals), base.address, quote.address)
  return (raw * 10n ** BigInt(PRICE_DECIMALS)) / 10n ** BigInt(quote.decimals)
}

/**
 * 装配 `twap` 的 result。**`meanTick`（整数）才是签名 result 的权威字段**，价格字符串是派生的展示值 ——
 * 两家实现若在定点渲染上有任何差别，比较 `meanTick` 仍然能看出它们其实同意。
 * Assembles the `twap` result. **`meanTick` (an integer) is the authoritative signed field**; the price
 * strings are derived display values — if two implementations ever differ in fixed-point rendering, comparing
 * `meanTick` still shows that they agree on the underlying fact.
 */
export function buildTwap({ pool, fee, token0, token1, base, quote, window, tickCumulatives, spotTick, liquidity, observationCardinality, maxWindow, deviationBpsLimit, blockPinned }) {
  const meanTick = meanTickFromCumulatives(tickCumulatives[0], tickCumulatives[1], window)
  const twapScaled = priceAtTick(meanTick, base, quote)
  const spotScaled = priceAtTick(spotTick, base, quote)
  const actual = twapScaled === 0n ? 0n : deviationBps(twapScaled, spotScaled)
  return {
    pool,
    fee,
    token0,
    token1,
    window,
    meanTick: meanTick.toString(),
    spotTick: spotTick.toString(),
    tickCumulatives: tickCumulatives.map(String),
    observationCardinality,
    maxWindow,
    liquidity: liquidity.toString(),
    base: base.address,
    quote: quote.address,
    twapPrice: fixed(twapScaled, PRICE_DECIMALS),
    spotPrice: fixed(spotScaled, PRICE_DECIMALS),
    deviationBpsActual: actual.toString(),
    deviationBpsLimit,
    deviates: actual > BigInt(deviationBpsLimit),
    blockPinned,
  }
}

/** 给 README 的"窗口 → 区块数"表用；也让 `BLOCK_TIME_S` 是一个可核对的常量而不是散在文里的数字。 */
export const blocksForWindow = (seconds) => Math.round(seconds / BLOCK_TIME_S)
