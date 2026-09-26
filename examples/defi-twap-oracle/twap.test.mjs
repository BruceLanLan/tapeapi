// defi-twap-oracle 的单测：窗口校验、降级闸门、tick → 价格的重缩放、偏离标志、端到端固化向量、确定性。
// 纯函数、不联网。TickMath 与 getQuoteAtTick 的分支覆盖在 `../_lib/codec.test.mjs`。
// Unit tests: window validation, the degradation gate, tick-to-price rescaling, the deviation flag, a frozen
// end-to-end vector and determinism. Pure functions, no network. TickMath and getQuoteAtTick branch coverage
// lives in `../_lib/codec.test.mjs`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalJSON } from '@tapeapi/sdk'
import { decodeObserve, meanTickFromCumulatives, getSqrtRatioAtTick, MIN_TICK, MAX_TICK } from '../_lib/codec.mjs'
import {
  requireWindow, requireFee, requireDeviationBps, checkObservationWindow, priceAtTick, buildTwap,
  blocksForWindow, TICK_SPACING, MIN_WINDOW, MAX_WINDOW, DEFAULT_WINDOW, DEFAULT_DEVIATION_BPS, BLOCK_TIME_S,
} from './twap.mjs'

const USDT = { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18 }
const WBNB = { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', symbol: 'WBNB', decimals: 18 }
// 主网固化：fee-100 WBNB/USDT 池 observe([1800,0]) 在块 123015808 的真实返回数据。
// Frozen mainnet: observe([1800, 0]) on the fee-100 WBNB/USDT pool at block 123015808.
const OBSERVE_HEX = '0x' +
  '0000000000000000000000000000000000000000000000000000000000000040' +
  '00000000000000000000000000000000000000000000000000000000000000a0' +
  '0000000000000000000000000000000000000000000000000000000000000002' +
  'fffffffffffffffffffffffffffffffffffffffffffffffffffff9c88a01817a' +
  'fffffffffffffffffffffffffffffffffffffffffffffffffffff9c882e50bf9' +
  '0000000000000000000000000000000000000000000000000000000000000002' +
  '000000000000000000000000000000000000000000000b4638d219c88ed9f465' +
  '000000000000000000000000000000000000000000000b463adff446d058c3dc'
const PINNED = { blockNumber: 123015808, blockHash: '0xebfe539070d6380734330cf8f8097ec8b8448974691d440e8be4046208a44f01', blockRef: 'hash' }

// ---------- 入参 / parameters ----------

test('window must be an integer in 60..86400 and defaults to 1800', () => {
  assert.equal(requireWindow(undefined), DEFAULT_WINDOW)
  assert.equal(requireWindow(null), 1800)
  assert.equal(requireWindow(60), MIN_WINDOW)
  assert.equal(requireWindow(86400), MAX_WINDOW)
  for (const badValue of [59, 86401, 0, -1, 1800.5, '1800', NaN]) {
    assert.throws(() => requireWindow(badValue), (e) => e.code === 'BAD_REQUEST', `window ${badValue} must be rejected`)
  }
})

test('the fee tiers are PancakeSwap\'s, not Uniswap\'s', () => {
  // PancakeV3Factory 构造函数硬编码 100/500/2500/10000；Uniswap V3 是 500/3000/10000。
  assert.deepEqual(TICK_SPACING, { 100: 1, 500: 10, 2500: 50, 10000: 200 })
  for (const f of [100, 500, 2500, 10000]) assert.equal(requireFee(f), f)
  assert.throws(() => requireFee(3000), (e) => e.code === 'BAD_REQUEST' && /not Uniswap/.test(e.message))
  assert.throws(() => requireFee(undefined), (e) => e.code === 'BAD_REQUEST')
})

test('deviationBps defaults to 100 (Venus BoundValidator uses +/-1% for BNB)', () => {
  assert.equal(requireDeviationBps(undefined), DEFAULT_DEVIATION_BPS)
  assert.equal(requireDeviationBps(100), 100)
  assert.equal(requireDeviationBps(0), 0)
  for (const badValue of [-1, 10001, 1.5]) assert.throws(() => requireDeviationBps(badValue), (e) => e.code === 'BAD_REQUEST')
})

// ---------- 降级闸门 / the degradation gate ----------

test('cardinality < 2 is a BAD_REQUEST that names the write this service cannot make', () => {
  assert.throws(
    () => checkObservationWindow({ pool: '0xpool', window: 1800, observationCardinality: 1, maxWindow: 0 }),
    (e) => e.code === 'BAD_REQUEST' && /increaseObservationCardinalityNext/.test(e.message) && e.data.observationCardinality === 1,
  )
})

test('a window longer than the pool\'s observation history is BAD_REQUEST, not INTERNAL', () => {
  // TAP-23 §3.3 把合约 revert 归为 INTERNAL，但 `OLD` 是**我们的参数**越界，调用方应当缩短窗口重试。
  // TAP-23 §3.3 maps contract reverts to INTERNAL, but `OLD` means *our parameter* was out of range and the
  // caller should shorten the window and retry — so BAD_REQUEST is the accurate code.
  assert.throws(
    () => checkObservationWindow({ pool: '0xpool', window: 86400, observationCardinality: 4500, maxWindow: 24146 }),
    (e) => e.code === 'BAD_REQUEST' && /24146s available/.test(e.message) && e.data.maxWindow === 24146 && e.data.observationCardinality === 4500,
  )
  // 结构化字段必须在 `data` 下 —— server 的信封序列化只读 `e.data`，摊平的字段到不了调用方。
  // The structured fields must live under `data`: the server's envelope serializer only copies `e.data`,
  // so anything flattened onto the error never reaches the caller.
  try { checkObservationWindow({ pool: '0xpool', window: 86400, observationCardinality: 4500, maxWindow: 24146 }) }
  catch (e) {
    assert.deepEqual(e.data, { observationCardinality: 4500, maxWindow: 24146 })
    assert.equal(e.maxWindow, undefined, 'must not be flattened onto the error, where the server would drop it')
  }
  // 刚好等于可用窗口时放行 / exactly at the boundary is allowed
  assert.deepEqual(
    checkObservationWindow({ pool: '0xpool', window: 24146, observationCardinality: 4500, maxWindow: 24146 }),
    { observationCardinality: 4500, maxWindow: 24146 },
  )
})

// ---------- tick → 价格 / tick to price ----------

test('priceAtTick rescales from the quote token\'s decimals to a fixed 18 places', () => {
  // 18 位 quote：getQuoteAtTick 的原始输出就已经是 1e18 标度。
  assert.equal(priceAtTick(-66281n, WBNB, USDT), 755793822249538243933n)
  // 6 位 quote：tick 0 时 1e18 个 base 最小单位换到 1e18 个 quote 最小单位 = 1e12 个完整 quote。
  // A 6-decimal quote: at tick 0, 1e18 base minimal units buy 1e18 quote minimal units = 1e12 whole quote.
  const usdc6 = { address: '0x0000000000000000000000000000000000000001', symbol: 'USDC', decimals: 6 }
  assert.equal(priceAtTick(0n, WBNB, usdc6), 10n ** 30n) // 1e12 * 1e18
  // 方向对调必须给出互为倒数的答案（tick 0 下都是 1:1）/ swapping direction is the reciprocal (1:1 at tick 0)
  assert.equal(priceAtTick(0n, WBNB, USDT), 10n ** 18n)
  assert.equal(priceAtTick(0n, USDT, WBNB), 10n ** 18n)
})

test('TickMath boundaries come from the shared codec, not a second implementation', () => {
  assert.equal(getSqrtRatioAtTick(0n), 1n << 96n)
  assert.equal(getSqrtRatioAtTick(MIN_TICK), 4295128739n)
  assert.equal(getSqrtRatioAtTick(MAX_TICK), 1461446703485210103287273052203988822378723970342n)
})

// ---------- 端到端 / end to end ----------

const frozen = () => {
  const { tickCumulatives } = decodeObserve(OBSERVE_HEX)
  return buildTwap({
    pool: '0x172fcD41E0913e95784454622d1c3724f546f849',
    fee: 100, token0: USDT, token1: WBNB, base: WBNB, quote: USDT,
    window: 1800, tickCumulatives,
    spotTick: -66290n,                       // 同一块的 slot0().tick / slot0().tick at the same block
    liquidity: 4020850662607964289532553n,
    observationCardinality: 4500, maxWindow: 24146,
    deviationBpsLimit: 100, blockPinned: PINNED,
  })
}

test('frozen mainnet tickCumulatives produce the exact published strings', () => {
  const t = frozen()
  assert.equal(t.meanTick, '-66281')
  assert.equal(t.spotTick, '-66290')
  assert.deepEqual(t.tickCumulatives, ['-6835272580742', '-6835391886343'])
  assert.equal(t.twapPrice, '755.793822249538243933')
  assert.equal(t.spotPrice, '756.474308838835043210')
  assert.equal(t.deviationBpsActual, '9')
  assert.equal(t.deviates, false)
  assert.equal(t.deviationBpsLimit, 100)
  // 18 位定点，位数固定，向零截断 / fixed 18 places, truncated toward zero
  assert.equal(t.twapPrice.split('.')[1].length, 18)
  assert.equal(t.spotPrice.split('.')[1].length, 18)
})

test('meanTick is the authoritative field and rounds toward negative infinity', () => {
  // 价格字符串是派生的展示值；meanTick 是签名 result 里的权威整数。
  // The price strings are derived display values; meanTick is the authoritative integer in the signed result.
  assert.equal(meanTickFromCumulatives(-6835272580742n, -6835391886343n, 1800), -66281n)
  assert.equal(meanTickFromCumulatives(0n, -100n, 3), -34n) // 不是 -33 / not -33
  assert.equal(meanTickFromCumulatives(0n, -99n, 3), -33n)
  assert.equal(meanTickFromCumulatives(0n, 100n, 3), 33n)
})

test('deviates flips exactly when the actual deviation exceeds the limit', () => {
  const build = (spotTick, limit) => buildTwap({
    ...{ pool: '0xp', fee: 100, token0: USDT, token1: WBNB, base: WBNB, quote: USDT, window: 1800, liquidity: 0n, observationCardinality: 4500, maxWindow: 24146, blockPinned: PINNED },
    tickCumulatives: decodeObserve(OBSERVE_HEX).tickCumulatives, spotTick, deviationBpsLimit: limit,
  })
  assert.equal(build(-66290n, 100).deviates, false) // 9 bps < 100
  assert.equal(build(-66290n, 9).deviates, false)   // 9 bps is not > 9
  assert.equal(build(-66290n, 8).deviates, true)    // 9 bps > 8
  // 现价被推远时必须翻 true（这正是它存在的理由）/ a pushed spot must flip it (that is the whole point)
  assert.equal(build(-60000n, 100).deviates, true)
})

test('the window-to-blocks table in the README is generated from one constant', () => {
  assert.equal(BLOCK_TIME_S, 0.45)
  assert.equal(blocksForWindow(60), 133)
  assert.equal(blocksForWindow(600), 1333)
  assert.equal(blocksForWindow(1800), 4000)
  assert.equal(blocksForWindow(3600), 8000)
})

// ---------- 确定性 / determinism ----------

test('the same inputs canonicalise to the same bytes twice, with no clock or hostname', () => {
  assert.equal(canonicalJSON(frozen()), canonicalJSON(frozen()))
  const json = canonicalJSON(frozen())
  for (const forbidden of ['http', 'dataseed', 'localhost', 'Date']) {
    assert.ok(!json.includes(forbidden), `signed result must not carry ${forbidden}`)
  }
  // blockPinned 一定在 / blockPinned is always present (TAP-23 §3.4)
  assert.deepEqual(frozen().blockPinned, PINNED)
})
