// `examples/_lib/codec.mjs` 的单元测试。纯函数、不联网。
// 固化的十六进制向量全部来自 2026-09-20 BNB Chain 主网 `finalized` 块 123015808
// （hash 0xebfe539070d6380734330cf8f8097ec8b8448974691d440e8be4046208a44f01）上的真实 `eth_call` 返回数据。
//
// Unit tests for `examples/_lib/codec.mjs`. Pure functions, no network.
// Every frozen hex vector below is real return data captured from BNB Chain mainnet on 2026-09-20 at the
// `finalized` block 123015808 (hash 0xebfe53…4f01).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalJSON } from '@tapeapi/sdk'
import {
  W, padAddr, wordAt, wordCount, toInt256, fromInt256, intWordAt, fixed, fixedDiv,
  encodeObserve, decodeObserve, decodeSlot0, decodeObservation,
  encodeCall3, encodeAggregate3, decodeAggregate3,
  meanTickFromCumulatives, getSqrtRatioAtTick, getQuoteAtTick, deviationBps,
  MIN_TICK, MAX_TICK, MIN_SQRT_RATIO, MAX_SQRT_RATIO,
} from './codec.mjs'

const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const USDT = '0x55d398326f99059fF775485246999027B3197955'

// ---------- 字与二补码 / words and two's complement ----------

test('toInt256 sign-extends at 256 bits, not at 24 or 56', () => {
  // ABI 把 int24/int56 符号扩展到整个 32 字节字；按 24/56 位转换会得到天文数字。
  // The ABI sign-extends across the whole word; converting at 24 or 56 bits yields astronomical numbers.
  const minusOne = (1n << 256n) - 1n
  assert.equal(toInt256(minusOne), -1n)
  assert.equal(toInt256(0n), 0n)
  assert.equal(toInt256(12345n), 12345n)
  // 实测的 spot tick：按 256 位是 -66259，按 24 位会解成一个 76 位十进制数。
  const tickWord = BigInt('0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffefd2d')
  assert.equal(toInt256(tickWord), -66259n)
  const naive24 = tickWord >> 0n // 不做 256 位转换就是这个巨大的值 / without the 256-bit conversion
  assert.ok(naive24 > 10n ** 70n, 'the un-converted word really is astronomically large')
  assert.equal(fromInt256(-66259n), tickWord)
  assert.equal(fromInt256(7n), 7n)
})

test('W / padAddr / wordAt round-trip and reject bad input', () => {
  assert.equal(W(0x20).length, 64)
  assert.equal(W(32), '0000000000000000000000000000000000000000000000000000000000000020')
  assert.equal(padAddr(WBNB), '000000000000000000000000bb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c')
  assert.throws(() => W(-1n), /non-negative/)
  assert.throws(() => padAddr('0xnope'), /not an address/)
  const data = '0x' + W(1) + W(2) + W(3)
  assert.equal(wordCount(data), 3)
  assert.equal(wordAt(data, 2), 3n)
  assert.throws(() => wordAt(data, 3), /out of range/)
})

// ---------- 定宽十进制 / fixed-width decimals ----------

test('fixed() pads to a fixed width — unlike the SDK formatUnits, which strips trailing zeros', () => {
  // 跨提供者逐字节比较要求位数固定：formatUnits(2e18, 18) === "2" 会让两家在同一个数上分叉。
  // Byte-for-byte quorum comparison needs a fixed width; formatUnits(2e18, 18) === "2" would let two
  // providers disagree on the same number.
  assert.equal(fixed(2n * 10n ** 18n, 18), '2.000000000000000000')
  assert.equal(fixed(10n ** 18n, 18), '1.000000000000000000')
  assert.equal(fixed(0n, 18), '0.000000000000000000')
  assert.equal(fixed(1n, 18), '0.000000000000000001')
  assert.equal(fixed(-1n, 18), '-0.000000000000000001')
  assert.equal(fixed(1234n, 0), '1234')
  assert.equal(fixed(5n * 10n ** 17n, 18), '0.500000000000000000')
  assert.throws(() => fixed(1n, -1), /decimals/)
})

test('fixedDiv truncates toward zero, never rounds', () => {
  assert.equal(fixedDiv(10n ** 18n + 1n, 3n * 10n ** 18n, 18), '0.333333333333333333') // not …334
  assert.equal(fixedDiv(2n * 10n ** 18n, 10n ** 18n, 18), '2.000000000000000000')
  assert.equal(fixedDiv(2n, 3n, 4), '0.6666')
  assert.throws(() => fixedDiv(1n, 0n, 18), /division by zero/)
})

// ---------- observe(uint32[]) ----------

test('encodeObserve lays out selector ‖ 0x20 ‖ 2 ‖ window ‖ 0', () => {
  const data = encodeObserve('0x883bdbfd', 1800)
  assert.equal(data, '0x883bdbfd' + W(0x20) + W(2) + W(1800) + W(0))
  assert.equal((data.length - 10) / 64, 4, 'four words of arguments')
  assert.throws(() => encodeObserve('0x883bdbfd', -1), /uint32/)
  assert.throws(() => encodeObserve('0x883bdbfd', 2 ** 33), /uint32/)
})

// 主网固化：PancakeV3 WBNB/USDT fee-100 池 0x172fcD41E0913e95784454622d1c3724f546f849，
// observe([1800, 0]) 在块 123015808 的真实返回数据。
// Frozen mainnet return data: observe([1800, 0]) on the fee-100 WBNB/USDT pool at block 123015808.
const OBSERVE_HEX = '0x' +
  '0000000000000000000000000000000000000000000000000000000000000040' +
  '00000000000000000000000000000000000000000000000000000000000000a0' +
  '0000000000000000000000000000000000000000000000000000000000000002' +
  'fffffffffffffffffffffffffffffffffffffffffffffffffffff9c88a01817a' +
  'fffffffffffffffffffffffffffffffffffffffffffffffffffff9c882e50bf9' +
  '0000000000000000000000000000000000000000000000000000000000000002' +
  '000000000000000000000000000000000000000000000b4638d219c88ed9f465' +
  '000000000000000000000000000000000000000000000b463adff446d058c3dc'

test('decodeObserve reads both int56 tickCumulatives out of frozen mainnet data', () => {
  const o = decodeObserve(OBSERVE_HEX)
  assert.deepEqual(o.tickCumulatives, [-6835272580742n, -6835391886343n])
  assert.equal(o.tickCumulatives.length, 2)
  assert.equal(o.secondsPerLiquidityCumulativeX128s.length, 2)
  // 头部偏移是 0x40，不是 0x20：两个动态数组各有一个头字。/ the head offset is 0x40, not 0x20: two arrays, two heads.
  assert.equal(wordAt(OBSERVE_HEX, 0), 0x40n)
})

test('decodeObserve rejects a length other than 2', () => {
  const bad = '0x' + W(0x40) + W(0xa0) + W(3) + W(0) + W(0) + W(0) + W(0) + W(0)
  assert.throws(() => decodeObserve(bad), /expected 2 observations/)
})

// ---------- slot0 / observations ----------

test('decodeSlot0 reads the frozen fee-100 slot0, tick as a signed value', () => {
  const hex = '0x' +
    '0000000000000000000000000000000000000000094eda2d1c854549dae62aa9' + // sqrtPriceX96
    'fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffefd0e' + // int24 tick = -66290
    '000000000000000000000000000000000000000000000000000000000000028f' + // observationIndex 655
    '0000000000000000000000000000000000000000000000000000000000001194' + // observationCardinality 4500
    '0000000000000000000000000000000000000000000000000000000000001194' + // cardinalityNext 4500
    '000000000000000000000000000000000000000000000000000000000ce40ce4' + // uint32 feeProtocol (uint8 on Uniswap)
    '0000000000000000000000000000000000000000000000000000000000000001'   // unlocked
  const s = decodeSlot0(hex)
  assert.equal(s.sqrtPriceX96, 2880691610373920582208465577n)
  assert.equal(s.tick, -66290n)
  assert.equal(s.observationIndex, 655)
  assert.equal(s.observationCardinality, 4500)
  assert.equal(s.observationCardinalityNext, 4500)
  assert.equal(s.unlocked, true)
})

test('decodeObservation reads word 0 and word 3 and skips the int56 slot entirely', () => {
  // 主网固化：fee-100 池 observations(656) 在块 123015808 的返回数据。
  // Frozen mainnet: observations(656) on the fee-100 pool at block 123015808.
  const hex = '0x' +
    '000000000000000000000000000000000000000000000000000000006aafa1c3' +
    'fffffffffffffffffffffffffffffffffffffffffffffffffffff9c8e237e5df' + // int56, never decoded
    '000000000000000000000000000000000000000000000b4623fa0e5da1144643' +
    '0000000000000000000000000000000000000000000000000000000000000001'
  const o = decodeObservation(hex)
  assert.equal(o.blockTimestamp, 1789895107)
  assert.equal(o.initialized, true)
  // maxWindow = 锚定块 timestamp − observation timestamp / pinned block timestamp minus the observation's
  assert.equal(1789919253 - o.blockTimestamp, 24146)
})

// ---------- Multicall3 ----------

test('encodeCall3 right-pads calldata to a whole number of words', () => {
  const s = encodeCall3('0xcA11bde05977b3631167028862bE2a173976CA11', false, '0x42cbb15c')
  assert.equal(s.slice(0, 64), padAddr('0xcA11bde05977b3631167028862bE2a173976CA11'))
  assert.equal(s.slice(64, 128), W(0))       // allowFailure false
  assert.equal(s.slice(128, 192), W(0x60))   // offset to the bytes member
  assert.equal(s.slice(192, 256), W(4))      // length 4
  assert.equal(s.slice(256), '42cbb15c'.padEnd(64, '0'))
  assert.equal(encodeCall3('0xcA11bde05977b3631167028862bE2a173976CA11', true, '0x42cbb15c').slice(64, 128), W(1))
})

test('encodeAggregate3 head offsets are relative to the start of the array body', () => {
  const sel = '0x82ad56cb'
  const data = encodeAggregate3(sel, [
    { target: '0xcA11bde05977b3631167028862bE2a173976CA11', callData: '0x42cbb15c' },
    { target: '0xcA11bde05977b3631167028862bE2a173976CA11', callData: '0x42cbb15c' },
  ])
  const body = data.slice(10)
  assert.equal(body.slice(0, 64), W(0x20))   // offset to the array
  assert.equal(body.slice(64, 128), W(2))    // length
  assert.equal(body.slice(128, 192), W(0x40))  // first struct starts after the two head words
  assert.equal(body.slice(192, 256), W(0xe0))  // second: 0x40 + one 5-word struct (0xa0)
  assert.throws(() => encodeAggregate3(sel, []), /non-empty/)
})

// 主网固化：aggregate3 的真实返回数据，三个调用 —— Multicall3.getBlockNumber()、
// Comptroller.markets(vUSDT)、ResilientOracle.getUnderlyingPrice(vBNB)，块 123015808。
// Frozen mainnet aggregate3 return data: getBlockNumber(), markets(vUSDT), getUnderlyingPrice(vBNB).
const AGG3_HEX = '0x' + [
  W(0x20), W(3), W(0x60), W(0xe0), W(0x220),
  W(1), W(0x40), W(0x20), W(123015808),
  W(1), W(0x40), W(0xe0), W(1), W('800000000000000000'), W(1), W('800000000000000000'), W('1100000000000000000'), W(0), W(1),
  W(1), W(0x40), W(0x20), W('756248900551278900000'),
].join('')

test('decodeAggregate3 unpacks Result[] from frozen mainnet data', () => {
  const r = decodeAggregate3(AGG3_HEX)
  assert.equal(r.length, 3)
  assert.ok(r.every((x) => x.success))
  assert.equal(Number(wordAt(r[0].returnData, 0)), 123015808)
  // markets() 返回 7 个值，不是 Compound V2 的 3 个 / markets() returns 7 values, not Compound V2's 3
  assert.equal(wordCount(r[1].returnData), 7)
  const [isListed, cf, isVenus, lt, li, poolId, borrowAllowed] = [0, 1, 2, 3, 4, 5, 6].map((i) => wordAt(r[1].returnData, i))
  assert.equal(isListed, 1n)
  assert.equal(fixed(cf, 18), '0.800000000000000000')
  assert.equal(isVenus, 1n)
  assert.equal(fixed(lt, 18), '0.800000000000000000')
  assert.equal(fixed(li, 18), '1.100000000000000000')
  assert.equal(poolId, 0n)
  assert.equal(borrowAllowed, 1n)
  assert.equal(fixed(wordAt(r[2].returnData, 0), 18), '756.248900551278900000')
})

test('trailing zero words from VBep20 delegators still decode (spec §1.3.7 regression)', () => {
  // 实测：vUSDT 的 getAccountSnapshot 返回 6 个字（4 个值 + 2 个尾部零字），vBNB 返回 4 个。
  // Measured: vUSDT's getAccountSnapshot returns 6 words (4 values + 2 trailing zeros); vBNB returns 4.
  const six = '0x' + W(0) + W(1234n) + W(5678n) + W('213000000000000000000000') + W(0) + W(0)
  const four = '0x' + W(0) + W(1234n) + W(5678n) + W('213000000000000000000000')
  for (const hex of [six, four]) {
    assert.equal(wordAt(hex, 0), 0n)
    assert.equal(wordAt(hex, 1), 1234n)
    assert.equal(wordAt(hex, 2), 5678n)
    assert.equal(wordAt(hex, 3), 213000000000000000000000n)
  }
  assert.equal(wordCount(six), 6)
  assert.equal(wordCount(four), 4)
})

// ---------- TWAP ----------

test('meanTickFromCumulatives rounds toward negative infinity (OracleLibrary.consult)', () => {
  assert.equal(meanTickFromCumulatives(0n, -100n, 3), -34n) // 不是 -33 / not -33
  assert.equal(meanTickFromCumulatives(0n, 100n, 3), 33n)
  assert.equal(meanTickFromCumulatives(0n, -99n, 3), -33n)  // 整除时不减一 / exact division does not decrement
  assert.equal(meanTickFromCumulatives(0n, 99n, 3), 33n)
  assert.equal(meanTickFromCumulatives(-6835272580742n, -6835391886343n, 1800), -66281n)
  assert.throws(() => meanTickFromCumulatives(0n, 1n, 0), /positive/)
})

test('getSqrtRatioAtTick matches TickMath.sol at its fixed points', () => {
  assert.equal(getSqrtRatioAtTick(0n), 79228162514264337593543950336n) // 2^96
  assert.equal(getSqrtRatioAtTick(0n), 1n << 96n)
  assert.equal(getSqrtRatioAtTick(MIN_TICK), MIN_SQRT_RATIO)
  assert.equal(getSqrtRatioAtTick(MIN_TICK), 4295128739n)
  assert.equal(getSqrtRatioAtTick(MAX_TICK), MAX_SQRT_RATIO)
  assert.equal(getSqrtRatioAtTick(MAX_TICK), 1461446703485210103287273052203988822378723970342n)
  assert.equal(getSqrtRatioAtTick(1n), 79232123823359799118286999568n)
  assert.equal(getSqrtRatioAtTick(-1n), 79224201403219477170569942574n)
  assert.ok(getSqrtRatioAtTick(1n) > getSqrtRatioAtTick(0n))
  assert.ok(getSqrtRatioAtTick(-1n) < getSqrtRatioAtTick(0n))
  assert.throws(() => getSqrtRatioAtTick(MAX_TICK + 1n), /out of range/)
  assert.throws(() => getSqrtRatioAtTick(MIN_TICK - 1n), /out of range/)
})

test('getSqrtRatioAtTick brackets the on-chain sqrtPriceX96 at the frozen block', () => {
  // 主网交叉校验：fee-100 池在块 123015808 的 slot0().tick = -66290、sqrtPriceX96 = 2880691610373920582208465577。
  // 价格必须落在 [ratio(tick), ratio(tick+1)) 内 —— 这是移植正确性的链上证据，固定向量只能证明常量抄对了。
  // Mainnet cross-check: the pool's real sqrtPriceX96 must fall in [ratio(tick), ratio(tick+1)). The fixed
  // vectors above only prove the constants were copied correctly; this proves the port agrees with the chain.
  const tick = -66290n
  const onChain = 2880691610373920582208465577n
  assert.ok(getSqrtRatioAtTick(tick) <= onChain, 'lower bound')
  assert.ok(onChain < getSqrtRatioAtTick(tick + 1n), 'upper bound')
})

test('getQuoteAtTick covers both FullMath branches and both address orders', () => {
  // tick 0 → 比价恰为 1:1，两种地址序都必须给出同样的答案。/ at tick 0 the ratio is exactly 1:1 either way.
  assert.equal(getQuoteAtTick(0n, 10n ** 18n, USDT, WBNB), 10n ** 18n)
  assert.equal(getQuoteAtTick(0n, 10n ** 18n, WBNB, USDT), 10n ** 18n)
  // 分支 1：sqrtRatioX96 <= type(uint128).max / branch 1
  assert.ok(getSqrtRatioAtTick(-66281n) <= (1n << 128n) - 1n)
  assert.equal(getQuoteAtTick(-66281n, 10n ** 18n, WBNB, USDT), 755793822249538243933n)
  // 分支 2：sqrtRatioX96 > type(uint128).max（高 tick）/ branch 2 (high ticks)
  assert.ok(getSqrtRatioAtTick(500000n) > (1n << 128n) - 1n)
  assert.equal(getQuoteAtTick(500000n, 10n ** 18n, USDT, WBNB), 5171760815372400971558161893748917540546n)
  assert.equal(getQuoteAtTick(500000n, 10n ** 18n, WBNB, USDT), 0n) // 反方向在此 tick 下向零截断为 0 / truncates to 0
  assert.throws(() => getQuoteAtTick(0n, 1n, WBNB, WBNB), /same/)
})

test('frozen tickCumulatives produce the exact twap price string end to end', () => {
  const { tickCumulatives } = decodeObserve(OBSERVE_HEX)
  const meanTick = meanTickFromCumulatives(tickCumulatives[0], tickCumulatives[1], 1800)
  assert.equal(meanTick, -66281n)
  const q = getQuoteAtTick(meanTick, 10n ** 18n, WBNB, USDT)
  assert.equal(fixed(q, 18), '755.793822249538243933')
})

test('deviationBps is BigInt, truncated toward zero', () => {
  assert.equal(deviationBps(755793822249538243933n, 756474308838835043210n), 9n)
  assert.equal(deviationBps(10n ** 18n, 10n ** 18n), 0n)
  assert.equal(deviationBps(10n ** 18n, 11n * 10n ** 17n), 1000n) // +10% = 1000 bps
  assert.equal(deviationBps(10n ** 18n, 9n * 10n ** 17n), 1000n)  // 对称 / symmetric
  assert.throws(() => deviationBps(0n, 1n), /zero/)
})

// ---------- int24 in positions() ----------

test('positions() tick range decodes as 256-bit two\'s complement', () => {
  // NonfungiblePositionManager.positions() 的第 5、6 个字是 int24 tickLower / tickUpper。
  const hex = '0x' + W(0) + W(0) + W(0) + W(0) + W(0) +
    fromInt256(-887220n).toString(16).padStart(64, '0') + W(887220)
  assert.equal(intWordAt(hex, 5), -887220n)
  assert.equal(intWordAt(hex, 6), 887220n)
})

// ---------- 确定性 / determinism ----------

test('the same inputs canonicalise to the same bytes twice', () => {
  const build = () => {
    const { tickCumulatives } = decodeObserve(OBSERVE_HEX)
    const meanTick = meanTickFromCumulatives(tickCumulatives[0], tickCumulatives[1], 1800)
    return {
      meanTick: meanTick.toString(),
      tickCumulatives: tickCumulatives.map(String),
      twapPrice: fixed(getQuoteAtTick(meanTick, 10n ** 18n, WBNB, USDT), 18),
      results: decodeAggregate3(AGG3_HEX).map((r) => ({ success: r.success, returnData: r.returnData })),
    }
  }
  assert.equal(canonicalJSON(build()), canonicalJSON(build()))
  // 全部字段都是 BigInt 推导出来的字符串：没有本地时钟、随机数、主机名参与。
  // Every field is derived from BigInt arithmetic: no local clock, randomness or hostname takes part.
  assert.equal(typeof build().twapPrice, 'string')
})

