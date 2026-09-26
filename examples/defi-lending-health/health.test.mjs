// defi-lending-health 的单测：健康因子换算、权重用的是清算阈值而不是抵押系数、向零截断、确定性。
// 纯函数、不联网。/ Unit tests: health-factor arithmetic, weighting by the liquidation threshold rather
// than the collateral factor, truncation toward zero, determinism. Pure functions, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalJSON, TapeAPIError } from '@tapeapi/sdk'
import { W } from '../_lib/codec.mjs'
import {
  computeHealth, decodeMarket, decodeAccountSnapshot, decodeAccountLiquidity, decodeAddressArray,
  requireAccounts, requireAddress, parseFixed, atOrBelow, incentivePct, NOTES, MAX_ACCOUNTS,
} from './health.mjs'

const M = 10n ** 18n
const vUSDT = '0xfd5840cd36d94d7229439859c0112a4185bc0255'
const vCAKE = '0x86ac3974e2bd0d60825230fa6f355ff11409df5c'

// 一个 18 位小数、$1 的抵押品市场。价格标度是 Compound 惯例的 1e(36 − underlyingDecimals) = 1e18。
// vToken 恒为 8 位小数，所以 exchangeRateMantissa 的标度是 1e(18 + 18 − 8) = 1e28。
// One 18-decimal, $1 collateral market. Prices use the Compound convention 1e(36 − underlyingDecimals),
// vTokens always have 8 decimals, hence an exchange rate scaled at 1e(18 + 18 − 8) = 1e28.
const EXCHANGE_RATE = 10n ** 28n
const vTokensFor = (underlyingUnits) => (underlyingUnits * M) / EXCHANGE_RATE

function fixture({ supplyUnits = 0n, borrowUnits = 0n, lt = 8n * 10n ** 17n, cf = 8n * 10n ** 17n, shortfall = 0n, liquidity = 0n, vToken = vUSDT, symbol = 'vUSDT' } = {}) {
  return {
    account: '0x0000000000000000000000000000000000000001',
    assetsIn: [vToken],
    snapshots: { [vToken]: { err: 0n, vTokenBalance: vTokensFor(supplyUnits), borrowBalance: borrowUnits, exchangeRateMantissa: EXCHANGE_RATE } },
    markets: { [vToken]: { isListed: true, collateralFactorMantissa: cf, isVenus: true, liquidationThresholdMantissa: lt, liquidationIncentiveMantissa: 11n * 10n ** 17n, poolId: 0n, isBorrowAllowed: true } },
    prices: { [vToken]: M },
    meta: { [vToken]: { symbol, underlying: '0x55d398326f99059ff775485246999027b3197955', underlyingDecimals: 18 } },
    liquidity: { err: 0n, liquidity, shortfall },
    closeFactorMantissa: 5n * 10n ** 17n,
  }
}

test('1000 USDT collateral at LT 0.8, 400 USDT borrowed -> healthFactor 2, fixed width', () => {
  const r = computeHealth(fixture({ supplyUnits: 1000n * M, borrowUnits: 400n * M, liquidity: 400n * M }))
  assert.equal(r.healthFactor, '2.000000000000000000')
  assert.equal(r.weightedCollateralUsd, '800.000000000000000000')
  assert.equal(r.borrowUsd, '400.000000000000000000')
  assert.equal(r.liquidatable, false)
  assert.equal(r.note, null)
})

test('the same position borrowing 800 -> exactly 1, borrowing 801 -> below 1', () => {
  assert.equal(computeHealth(fixture({ supplyUnits: 1000n * M, borrowUnits: 800n * M })).healthFactor, '1.000000000000000000')
  const at801 = computeHealth(fixture({ supplyUnits: 1000n * M, borrowUnits: 801n * M })).healthFactor
  assert.equal(at801, '0.998751560549313358')
  assert.ok(at801 < '1', 'string compares below 1 too')
})

test('no borrow -> healthFactor null and liquidatable false', () => {
  const r = computeHealth(fixture({ supplyUnits: 1000n * M }))
  assert.equal(r.healthFactor, null)
  assert.equal(r.liquidatable, false)
  assert.equal(r.borrowUsd, '0.000000000000000000')
  assert.equal(r.note, null)
})

test('healthFactor truncates toward zero, never rounds', () => {
  // weighted = 1e18 + 1, borrow = 3e18 -> 0.333333333333333333, not …334
  const f = fixture({ lt: M })
  f.snapshots[vUSDT].vTokenBalance = vTokensFor(M + 1n)
  f.snapshots[vUSDT].borrowBalance = 3n * M
  assert.equal(computeHealth(f).healthFactor, '0.333333333333333333')
})

test('the weight is the liquidation threshold, NOT the collateral factor', () => {
  // vCAKE 主网实测：collateralFactor 0.50，liquidationThreshold 0.55。按 CF 算会得到 1.0，按 LT 算得到 1.1。
  // Measured on mainnet for vCAKE: CF 0.50, LT 0.55. Weighting by CF gives 1.0; by LT it gives 1.1.
  const r = computeHealth(fixture({
    supplyUnits: 1000n * M, borrowUnits: 500n * M,
    cf: 5n * 10n ** 17n, lt: 55n * 10n ** 16n, vToken: vCAKE, symbol: 'vCAKE',
  }))
  assert.equal(r.healthFactor, '1.100000000000000000')
  assert.notEqual(r.healthFactor, '1.000000000000000000')
  assert.equal(r.markets[0].collateralFactorMantissa, '500000000000000000')
  assert.equal(r.markets[0].liquidationThresholdMantissa, '550000000000000000')
  assert.equal(r.account, '0x0000000000000000000000000000000000000001')
})

test('liquidatable comes from the on-chain shortfall, not from our health factor', () => {
  // 健康因子 2.0 但链上 shortfall > 0：以链上为准，并挂一个固定字符串常量的 note（不含时间戳）。
  // Health factor 2.0 but a positive on-chain shortfall: the chain wins, and a fixed-constant note is attached.
  const r = computeHealth(fixture({ supplyUnits: 1000n * M, borrowUnits: 400n * M, shortfall: 1n }))
  assert.equal(r.healthFactor, '2.000000000000000000')
  assert.equal(r.liquidatable, true)
  assert.equal(r.note, NOTES.SHORTFALL_WITHOUT_HF)
  assert.ok(!/\d{10}/.test(r.note), 'the note carries no timestamp')

  const r2 = computeHealth(fixture({ supplyUnits: 1000n * M, borrowUnits: 801n * M, shortfall: 0n }))
  assert.equal(r2.liquidatable, false)
  assert.equal(r2.note, NOTES.HF_WITHOUT_SHORTFALL)
})

test('maxRepay is min(borrowBalance * closeFactor, borrowBalance)', () => {
  const r = computeHealth(fixture({ supplyUnits: 1000n * M, borrowUnits: 800n * M }))
  assert.equal(r.markets[0].maxRepay, (400n * M).toString()) // closeFactor 50%
  assert.equal(r.closeFactorMantissa, '500000000000000000')
})

test('markets come back in getAssetsIn order, not sorted', () => {
  const f = fixture({ supplyUnits: 1000n * M, borrowUnits: 100n * M })
  f.assetsIn = [vUSDT, vCAKE]
  f.snapshots[vCAKE] = { err: 0n, vTokenBalance: 0n, borrowBalance: 0n, exchangeRateMantissa: EXCHANGE_RATE }
  f.markets[vCAKE] = { ...f.markets[vUSDT], collateralFactorMantissa: 5n * 10n ** 17n, liquidationThresholdMantissa: 55n * 10n ** 16n }
  f.prices[vCAKE] = M
  f.meta[vCAKE] = { symbol: 'vCAKE', underlying: '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82', underlyingDecimals: 18 }
  const r = computeHealth(f)
  // 输出是 EIP-55 校验和形式（与 liquidationParams 一致），顺序仍是 getAssetsIn 的原序。
  // Output is EIP-55 checksummed (matching liquidationParams); the order is still getAssetsIn's.
  assert.deepEqual(r.markets.map(m => m.vToken.toLowerCase()), [vUSDT, vCAKE])
  assert.notEqual(r.markets[0].vToken, vUSDT, 'checksummed, not the lowercase input')
  // vCAKE 的小写字典序在 vUSDT 之前，所以任何"顺手排个序"的实现都会把这两项换位。
  // vCAKE sorts before vUSDT, so any implementation that quietly sorts would swap these two.
  assert.ok(vCAKE < vUSDT)
})

test('a non-zero comptroller error becomes INTERNAL, not a silent zero', () => {
  const f = fixture({ supplyUnits: 1000n * M })
  f.liquidity = { err: 9n, liquidity: 0n, shortfall: 0n }
  assert.throws(() => computeHealth(f), (e) => e instanceof TapeAPIError && e.code === 'INTERNAL' && /comptroller error 9/.test(e.message))
})

// ---------- 解码 / decoding ----------

test('markets() decodes SEVEN values, not Compound V2 three', () => {
  // 主网固化：markets(vUSDT) / frozen mainnet return data for markets(vUSDT)
  const hex = '0x' + W(1) + W('800000000000000000') + W(1) + W('800000000000000000') + W('1100000000000000000') + W(0) + W(1)
  const m = decodeMarket(hex)
  assert.equal(m.isListed, true)
  assert.equal(m.collateralFactorMantissa, 800000000000000000n)
  assert.equal(m.isVenus, true)
  assert.equal(m.liquidationThresholdMantissa, 800000000000000000n)
  assert.equal(m.liquidationIncentiveMantissa, 1100000000000000000n) // 按市场，不是全局 / per-market, not global
  assert.equal(m.poolId, 0n)
  assert.equal(m.isBorrowAllowed, true)
  assert.throws(() => decodeMarket('0x' + W(1) + W(0) + W(1)), /expected 7 words/)
})

test('VBep20 delegator trailing zero words still decode (spec §1.3.7 regression)', () => {
  // 实测：vUSDT 的 getAccountSnapshot 返回 6 个字（4 个值 + 2 个尾部零字），vBNB 返回 4 个。
  // Measured: vUSDT returns 6 words (4 values + 2 trailing zeros), vBNB returns 4.
  const values = W(0) + W(1234n) + W(5678n) + W('213000000000000000000000')
  const six = decodeAccountSnapshot('0x' + values + W(0) + W(0))
  const four = decodeAccountSnapshot('0x' + values)
  assert.deepEqual(six, four)
  assert.equal(six.vTokenBalance, 1234n)
  assert.equal(six.exchangeRateMantissa, 213000000000000000000000n)
})

test('getAssetsIn and getAccountLiquidity decode by hand (the SDK has no array support)', () => {
  const hex = '0x' + W(0x20) + W(2) + W(BigInt(vUSDT)) + W(BigInt(vCAKE))
  assert.deepEqual(decodeAddressArray(hex), [vUSDT, vCAKE])
  assert.deepEqual(decodeAddressArray('0x' + W(0x20) + W(0)), [])
  const liq = decodeAccountLiquidity('0x' + W(0) + W('71383582071371547585804') + W(0))
  assert.deepEqual(liq, { err: 0n, liquidity: 71383582071371547585804n, shortfall: 0n })
})

// ---------- 入参 / parameters ----------

test('account and accounts validation', () => {
  assert.equal(requireAddress('0xFD5840Cd36d94D7229439859C0112a4185BC0255', 'account'), '0xfd5840cd36d94d7229439859c0112a4185bc0255')
  assert.throws(() => requireAddress('nope', 'account'), (e) => e.code === 'BAD_REQUEST')
  assert.throws(() => requireAccounts('x'), (e) => e.code === 'BAD_REQUEST')
  assert.throws(() => requireAccounts([]), (e) => e.code === 'BAD_REQUEST')
  assert.throws(() => requireAccounts(new Array(MAX_ACCOUNTS + 1).fill(vUSDT)), (e) => e.code === 'BAD_REQUEST' && /at most 50/.test(e.message))
  // 重复入参不去重、不重排 / duplicates are preserved and never reordered
  assert.deepEqual(requireAccounts([vCAKE, vUSDT, vCAKE]), [vCAKE, vUSDT, vCAKE])
})

test('parseFixed and the atRisk threshold comparison', () => {
  assert.equal(parseFixed('1.05', 18, 'maxHealthFactor'), 1050000000000000000n)
  assert.equal(parseFixed('1', 18, 'x'), M)
  assert.throws(() => parseFixed('-1', 18, 'x'), (e) => e.code === 'BAD_REQUEST')
  assert.throws(() => parseFixed('1e3', 18, 'x'), (e) => e.code === 'BAD_REQUEST')
  const t = parseFixed('1.05', 18, 'x')
  assert.equal(atOrBelow('1.000000000000000000', t), true)
  assert.equal(atOrBelow('1.050000000000000000', t), true)
  assert.equal(atOrBelow('1.050000000000000001', t), false)
  assert.equal(atOrBelow(null, t), false) // 无借款永远不入选 / a position with no borrow never matches
})

test('incentivePct renders the per-market liquidation incentive', () => {
  assert.equal(incentivePct(1100000000000000000n), '110.00')
})

// ---------- 确定性 / determinism ----------

test('the same input canonicalises to the same bytes twice', () => {
  const run = () => computeHealth(fixture({ supplyUnits: 1000n * M, borrowUnits: 723n * M, liquidity: 77n * M }))
  assert.equal(canonicalJSON(run()), canonicalJSON(run()))
  const json = canonicalJSON(run())
  for (const forbidden of ['http', 'dataseed', 'localhost', 'Date']) {
    assert.ok(!json.includes(forbidden), `signed result must not carry ${forbidden}`)
  }
})
