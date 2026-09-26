// 示例共用的手写 ABI 编解码 / Hand-rolled ABI codecs shared by the DeFi examples.
//
// 为什么手写：`sdk/src/abi.js` 的 `encodeParams` / `decodeParams` 不支持有符号整数（`int24` / `int56` 抛
// `ABI_INVALID: unsupported type "int24"`），也不支持数组与结构体数组。本示例需要的
// `PancakeV3Pool.observe(uint32[])`、`slot0()` 的 `int24 tick`、`NonfungiblePositionManager.positions()` 的
// tick 区间、以及 `Multicall3.aggregate3((address,bool,bytes)[])` 因此全部在这里手写。
// SDK 补齐 ABI 数组与有符号整数支持后，本文件应当整体退役。
//
// Why by hand: the SDK's `encodeParams` / `decodeParams` support neither signed integers (`int24` / `int56`
// throw `ABI_INVALID: unsupported type "int24"`) nor array / struct-array types. `observe(uint32[])`,
// `slot0()`'s `int24 tick`, the tick range in `positions()` and `Multicall3.aggregate3((address,bool,bytes)[])`
// are therefore all encoded here. Retire this file once the SDK gains array + signed-integer support.
//
// 两条贯穿全文件的规则 / two rules that hold throughout:
//   1. 全程 BigInt，绝不用 Number 参与金额/价格/tick 运算（确定性，见 DEFI-EXAMPLES-SPEC §0.3.1）。
//      BigInt everywhere; `Number` never touches an amount, price or tick (determinism).
//   2. ABI 把 `int24` / `int56` 符号扩展到整个 32 字节字，所以二补码转换按 **256 位** 做，不是按 24/56 位。
//      The ABI sign-extends `int24` / `int56` across the whole 32-byte word, so the two's-complement
//      conversion is done at **256 bits**, never at 24 or 56.

// ---------- 字 / words ----------
export const strip0x = (h) => (typeof h === 'string' && (h.startsWith('0x') || h.startsWith('0X')) ? h.slice(2) : h)
/** 一个 32 字节字的十六进制（无 0x）/ one 32-byte word as hex, no 0x prefix. */
export const W = (n) => {
  const v = BigInt(n)
  if (v < 0n) throw new Error('W expects a non-negative integer')
  const s = v.toString(16)
  if (s.length > 64) throw new Error('W: value exceeds 32 bytes')
  return s.padStart(64, '0')
}
/** 地址左填充到 32 字节 / an address left-padded to a 32-byte word. */
export const padAddr = (a) => {
  const s = strip0x(String(a)).toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(s)) throw new Error(`padAddr: not an address: ${a}`)
  return s.padStart(64, '0')
}
/** 返回数据的第 i 个字（0 起）/ the i-th 32-byte word of a return value (0-based). */
export const wordAt = (hex, i) => {
  const h = strip0x(hex)
  const s = h.slice(i * 64, (i + 1) * 64)
  if (s.length !== 64) throw new Error(`wordAt: word ${i} is out of range (data has ${Math.floor(h.length / 64)} words)`)
  return BigInt('0x' + s)
}
export const wordCount = (hex) => Math.floor(strip0x(hex).length / 64)

export const MOD256 = 1n << 256n
/** 256 位二补码：`int24` / `int56` / `int128` 等一律走这里 / two's complement at 256 bits — used for every signed ABI word. */
export const toInt256 = (u) => (u >= MOD256 >> 1n ? u - MOD256 : u)
/** 有符号值回到 32 字节字（编码用）/ a signed value back into an unsigned 32-byte word. */
export const fromInt256 = (v) => (BigInt(v) < 0n ? BigInt(v) + MOD256 : BigInt(v))
/** 返回数据里第 i 个有符号字 / the i-th word of a return value, read as a signed integer. */
export const intWordAt = (hex, i) => toInt256(wordAt(hex, i))

// ---------- 定宽十进制 / fixed-width decimals ----------
// SDK 的 `formatUnits` 会剥掉末尾的 0（`formatUnits(2e18, 18) === "2"`），这与 SPEC §0.3.2「位数固定」
// 以及 §1.10 期望的 `"2.000000000000000000"` 冲突。跨提供者逐字节比较要求位数固定，所以这里用定宽版本：
// 永远补齐到 `decimals` 位，向零截断，不剥零。
// The SDK's `formatUnits` strips trailing zeros (`formatUnits(2e18, 18) === "2"`), which contradicts the
// fixed-width requirement that byte-for-byte quorum comparison needs. `fixed()` always pads to `decimals`
// places, truncates toward zero and never strips.
export function fixed(scaled, decimals) {
  const d = Number(decimals)
  if (!Number.isInteger(d) || d < 0 || d > 100) throw new Error('fixed: decimals must be an integer in 0..100')
  let v = BigInt(scaled)
  const neg = v < 0n
  if (neg) v = -v
  const s = v.toString().padStart(d + 1, '0')
  const out = d === 0 ? s : `${s.slice(0, -d)}.${s.slice(-d)}`
  return neg ? `-${out}` : out
}
/** 带缩放的定宽除法，向零截断 / scaled division with truncation toward zero, rendered fixed-width. */
export function fixedDiv(numerator, denominator, decimals) {
  const d = BigInt(decimals)
  const den = BigInt(denominator)
  if (den === 0n) throw new Error('fixedDiv: division by zero')
  return fixed((BigInt(numerator) * 10n ** d) / den, Number(d))
}

// ---------- PancakeV3Pool.observe(uint32[]) ----------
// calldata: selector ‖ word(0x20) ‖ word(2) ‖ word(secondsAgo) ‖ word(0)
// 顺序不能反：`secondsAgos = [window, 0]`，`tickCumulatives[1] - tickCumulatives[0]` 才是正向的时间差。
// The order matters: `secondsAgos = [window, 0]`, so `tickCumulatives[1] - tickCumulatives[0]` runs forward in time.
export function encodeObserve(selector, secondsAgo) {
  const w = Number(secondsAgo)
  if (!Number.isInteger(w) || w < 0 || w > 0xffffffff) throw new Error('encodeObserve: secondsAgo must be a uint32')
  return selector + W(0x20) + W(2) + W(w) + W(0)
}
/**
 * 返回 `(int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)`：两个动态数组，
 * 头部是两个偏移量。`int56` 由 SDK 不支持，这里按 256 位二补码解。
 * Decodes `(int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)`: two dynamic arrays
 * behind two head offsets. The `int56` words are read as 256-bit two's complement.
 */
export function decodeObserve(ret) {
  const off0 = Number(wordAt(ret, 0)) / 32
  if (!Number.isInteger(off0)) throw new Error('decodeObserve: misaligned array offset')
  const len = Number(wordAt(ret, off0))
  if (len !== 2) throw new Error(`decodeObserve: expected 2 observations, got ${len}`)
  const off1 = Number(wordAt(ret, 1)) / 32
  const secondsPerLiquidity = []
  if (Number.isInteger(off1) && wordCount(ret) > off1 + 2) {
    for (let i = 1; i <= 2; i++) secondsPerLiquidity.push(wordAt(ret, off1 + i))
  }
  return {
    tickCumulatives: [intWordAt(ret, off0 + 1), intWordAt(ret, off0 + 2)],
    secondsPerLiquidityCumulativeX128s: secondsPerLiquidity,
  }
}

// ---------- PancakeV3Pool.slot0() ----------
// (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality,
//  uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)
// 注意 PancakeSwap 的 feeProtocol 是 uint32，Uniswap V3 是 uint8；两者都独占一个字，解码不受影响。
// Note PancakeSwap's `feeProtocol` is uint32 where Uniswap V3's is uint8; each occupies its own word either way.
export function decodeSlot0(ret) {
  return {
    sqrtPriceX96: wordAt(ret, 0),
    tick: intWordAt(ret, 1),                       // int24, sign-extended across the full word
    observationIndex: Number(wordAt(ret, 2)),
    observationCardinality: Number(wordAt(ret, 3)),
    observationCardinalityNext: Number(wordAt(ret, 4)),
    feeProtocol: wordAt(ret, 5),
    unlocked: wordAt(ret, 6) !== 0n,
  }
}

// ---------- PancakeV3Pool.observations(uint256) ----------
// (uint32 blockTimestamp, int56 tickCumulative, uint160 secondsPerLiquidityCumulativeX128, bool initialized)
// 只需要第 0 个字和第 3 个字；`int56` 那一格直接跳过，不解码。
// Only words 0 and 3 are needed; the `int56` slot is skipped rather than decoded.
export function decodeObservation(ret) {
  return { blockTimestamp: Number(wordAt(ret, 0)), initialized: wordAt(ret, 3) !== 0n }
}

// ---------- Multicall3.aggregate3((address,bool,bytes)[]) ----------
// 每个 Call3 是含 bytes 的动态结构体：target ‖ allowFailure ‖ 0x60 ‖ len ‖ 右填充的 calldata。
// 外层：selector ‖ 0x20 ‖ N ‖ [N 个相对数组体起点的偏移] ‖ [N 个结构体]。
// Each Call3 is a dynamic struct (it contains `bytes`): target ‖ allowFailure ‖ 0x60 ‖ len ‖ right-padded data.
// Outer layout: selector ‖ 0x20 ‖ N ‖ [N offsets relative to the start of the array body] ‖ [N structs].
export function encodeCall3(target, allowFailure, data) {
  const b = strip0x(data)
  if (b.length % 2) throw new Error('encodeCall3: calldata must be whole bytes')
  const len = b.length / 2
  return padAddr(target) + W(allowFailure ? 1 : 0) + W(0x60) + W(len) + b.padEnd(Math.ceil(len / 32) * 64, '0')
}
export function encodeAggregate3(selector, calls) {
  if (!Array.isArray(calls) || calls.length === 0) throw new Error('encodeAggregate3: calls must be a non-empty array')
  // allowFailure 默认 false：部分失败会让结果依赖"哪几个成功了"，破坏跨提供者的确定性。
  // allowFailure defaults to false: partial failure would make the result depend on which calls happened to
  // succeed, which destroys cross-provider determinism.
  const structs = calls.map((c) => encodeCall3(c.target, c.allowFailure ?? false, c.callData))
  let off = structs.length * 32
  let heads = ''
  let tails = ''
  for (const s of structs) { heads += W(off); tails += s; off += s.length / 2 }
  return selector + W(0x20) + W(structs.length) + heads + tails
}
/** 解码 `Result[] { bool success; bytes returnData; }` / decodes `Result[] { bool success; bytes returnData; }`. */
export function decodeAggregate3(ret) {
  const h = strip0x(ret)
  const at = (byteOff) => {
    const s = h.slice(byteOff * 2, byteOff * 2 + 64)
    if (s.length !== 64) throw new Error('decodeAggregate3: data truncated')
    return BigInt('0x' + s)
  }
  const arrayOff = Number(at(0))
  const n = Number(at(arrayOff))
  const body = arrayOff + 32
  const out = []
  for (let i = 0; i < n; i++) {
    const structOff = body + Number(at(body + i * 32))
    const success = at(structOff) !== 0n
    const dataOff = structOff + Number(at(structOff + 32))
    const len = Number(at(dataOff))
    const start = (dataOff + 32) * 2
    const slice = h.slice(start, start + len * 2)
    if (slice.length !== len * 2) throw new Error('decodeAggregate3: returnData truncated')
    out.push({ success, returnData: '0x' + slice })
  }
  return out
}

// ---------- TWAP：算术平均 tick / arithmetic mean tick ----------
// 照抄 Uniswap v3-periphery `OracleLibrary.consult`，一个字都没改：
//   int56 tickCumulativesDelta = tickCumulatives[1] - tickCumulatives[0];
//   arithmeticMeanTick = int24(tickCumulativesDelta / secondsAgo);
//   // Always round to negative infinity
//   if (tickCumulativesDelta < 0 && (tickCumulativesDelta % secondsAgo != 0)) arithmeticMeanTick--;
// BigInt 除法与 Solidity 一样向零截断，所以那条 `--` 必须保留，否则负 tick 会差一。
// BigInt division truncates toward zero exactly as Solidity does, so the `--` must be kept or negative
// ticks come out one too high.
export function meanTickFromCumulatives(tc0, tc1, secondsAgo) {
  const window = BigInt(secondsAgo)
  if (window <= 0n) throw new Error('meanTickFromCumulatives: window must be positive')
  const delta = BigInt(tc1) - BigInt(tc0)
  let mean = delta / window
  if (delta < 0n && delta % window !== 0n) mean -= 1n
  return mean
}

// ---------- TickMath（Uniswap v3-core `TickMath.sol` 的 BigInt 移植）/ BigInt port of TickMath.sol ----------
export const MIN_TICK = -887272n
export const MAX_TICK = 887272n
export const MIN_SQRT_RATIO = 4295128739n
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n
const Q128 = 1n << 128n
const UINT256_MAX = MOD256 - 1n

/**
 * `sqrt(1.0001^tick) * 2^96`，与 `TickMath.getSqrtRatioAtTick` 逐位一致。
 * Bit-for-bit port of `TickMath.getSqrtRatioAtTick`: `sqrt(1.0001^tick) * 2^96`.
 */
export function getSqrtRatioAtTick(tick) {
  const t = BigInt(tick)
  const absTick = t < 0n ? -t : t
  if (absTick > MAX_TICK) throw new Error(`getSqrtRatioAtTick: tick ${t} out of range`)
  let ratio = (absTick & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : Q128
  const mul = (bit, k) => { if ((absTick & bit) !== 0n) ratio = (ratio * k) >> 128n }
  mul(0x2n, 0xfff97272373d413259a46990580e213an)
  mul(0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn)
  mul(0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n)
  mul(0x10n, 0xffcb9843d60f6159c9db58835c926644n)
  mul(0x20n, 0xff973b41fa98c081472e6896dfb254c0n)
  mul(0x40n, 0xff2ea16466c96a3843ec78b326b52861n)
  mul(0x80n, 0xfe5dee046a99a2a811c461f1969c3053n)
  mul(0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n)
  mul(0x200n, 0xf987a7253ac413176f2b074cf7815e54n)
  mul(0x400n, 0xf3392b0822b70005940c7a398e4b70f3n)
  mul(0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n)
  mul(0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n)
  mul(0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n)
  mul(0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n)
  mul(0x8000n, 0x31be135f97d08fd981231505542fcfa6n)
  mul(0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n)
  mul(0x20000n, 0x5d6af8dedb81196699c329225ee604n)
  mul(0x40000n, 0x2216e584f5fa1ea926041bedfe98n)
  mul(0x80000n, 0x48a170391f7dc42444e8fa2n)
  if (t > 0n) ratio = UINT256_MAX / ratio
  // 向上取整到 Q96 / round up when shifting down to Q96
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n)
}

/**
 * `OracleLibrary.getQuoteAtTick`。BigInt 下没有 256 位溢出，`FullMath.mulDiv(a,b,d)` 就是 `(a*b)/d`，
 * 但分支判断与 `baseToken < quoteToken` 的地址比较必须原样保留，否则两家实现会在边界上分叉。
 * `OracleLibrary.getQuoteAtTick`. BigInt has no 256-bit overflow so `FullMath.mulDiv(a,b,d)` is `(a*b)/d`,
 * but the branch and the `baseToken < quoteToken` address comparison are kept exactly as in the source —
 * drop either and two implementations diverge at the boundary.
 */
export function getQuoteAtTick(tick, baseAmount, baseToken, quoteToken) {
  const sqrtRatioX96 = getSqrtRatioAtTick(tick)
  const amount = BigInt(baseAmount)
  const base = BigInt('0x' + padAddr(baseToken))
  const quote = BigInt('0x' + padAddr(quoteToken))
  if (base === quote) throw new Error('getQuoteAtTick: baseToken and quoteToken are the same')
  if (sqrtRatioX96 <= (1n << 128n) - 1n) {
    const ratioX192 = sqrtRatioX96 * sqrtRatioX96
    return base < quote ? (ratioX192 * amount) / (1n << 192n) : ((1n << 192n) * amount) / ratioX192
  }
  const ratioX128 = (sqrtRatioX96 * sqrtRatioX96) / (1n << 64n)
  return base < quote ? (ratioX128 * amount) / Q128 : (Q128 * amount) / ratioX128
}

// ---------- 偏离 / deviation ----------
/**
 * `|spot − twap| · 10000 / twap`，在定点标度上用 BigInt 算，向零截断。
 * `|spot − twap| * 10000 / twap`, computed on the fixed-point scale in BigInt, truncated toward zero.
 */
export function deviationBps(twapScaled, spotScaled) {
  const t = BigInt(twapScaled)
  if (t === 0n) throw new Error('deviationBps: twap is zero')
  const d = BigInt(spotScaled) - t
  return ((d < 0n ? -d : d) * 10000n) / t
}
