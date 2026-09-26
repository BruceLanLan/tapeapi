// defi-lending-health 的纯函数部分：健康因子换算、入参校验、Venus 返回数据解码。
// 不联网、不读环境变量、不看时钟 —— 因此可以被 `health.test.mjs` 直接单测，也因此两家提供者
// 在同一个锚定区块上必然产出逐字节相同的结果。
//
// The pure half of defi-lending-health: health-factor arithmetic, parameter validation and Venus return-data
// decoding. No network, no environment, no clock — which is what makes it unit-testable in `health.test.mjs`
// and what makes two providers produce byte-identical results at the same pinned block.
import { TapeAPIError, abi } from '@tapeapi/sdk'
const { checksumAddress } = abi
import { wordAt, wordCount, fixed, fixedDiv } from '../_lib/codec.mjs'

export const MAX_ACCOUNTS = 50
export const MANTISSA = 10n ** 18n
export const USD_DECIMALS = 18   // Venus 的 liquidity / shortfall 是 USD、1e18 标度 / Venus reports USD at 1e18
export const HF_DECIMALS = 18    // healthFactor 固定 18 位 / healthFactor is always 18 places

const bad = (msg) => { throw new TapeAPIError('BAD_REQUEST', msg) }
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/
export const isAddr = (a) => typeof a === 'string' && ADDR_RE.test(a)
export const lower = (a) => String(a).toLowerCase()

// 固定字符串常量：signed result 里不得出现时间戳或主机名（SPEC §0.3.3），所以 note 只能取这些值。
// Fixed string constants: a signed result may not carry timestamps or hostnames, so `note` is drawn only
// from this table.
export const NOTES = {
  SHORTFALL_WITHOUT_HF: 'on-chain shortfall is positive while the derived health factor is at or above 1; the two are computed from interest-accrual snapshots taken at different points of the same block',
  HF_WITHOUT_SHORTFALL: 'the derived health factor is below 1 while the on-chain shortfall is zero; the two are computed from interest-accrual snapshots taken at different points of the same block',
}

// ---------- 入参校验 / parameter validation ----------

export function requireAddress(value, what) {
  if (!isAddr(value)) bad(`${what} must be an address`)
  return lower(value)
}

export function requireAccounts(accounts) {
  if (!Array.isArray(accounts)) bad('accounts must be an array of addresses')
  if (accounts.length === 0) bad('accounts must not be empty')
  // 上限硬编码 50：一次请求里的所有读取都必须落在同一个锚定块上，批量越大越容易越过节点的状态保留窗口。
  // Hard cap of 50: every read in one request must land on the same pinned block, and the larger the batch
  // the likelier it outruns a node's state-retention window.
  if (accounts.length > MAX_ACCOUNTS) bad(`accounts must have at most ${MAX_ACCOUNTS} entries, got ${accounts.length}`)
  // 入参顺序即出参顺序，重复不去重（SPEC §0.3.5）/ output order is input order; duplicates are preserved
  return accounts.map((a, i) => requireAddress(a, `accounts[${i}]`))
}

/** 十进制字符串 → 1e18 标度 BigInt。负数、指数、空串一律 BAD_REQUEST。/ decimal string to a 1e18-scaled BigInt. */
export function parseFixed(str, decimals = 18, what = 'value') {
  const s = typeof str === 'number' ? String(str) : str
  if (typeof s !== 'string' || !/^\d+(\.\d+)?$/.test(s)) bad(`${what} must be a non-negative decimal string`)
  const [i, f = ''] = s.split('.')
  if (f.length > decimals) bad(`${what} has more than ${decimals} decimals`)
  return BigInt(i) * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0')
}

// ---------- Venus 返回数据解码 / Venus return-data decoding ----------
// VBep20 delegator 市场的 returndata 会多出两个尾部零字（实测：vUSDT 的 getAccountSnapshot 返回 6 个字，
// vBNB 返回 4 个）。下面一律按偏移正向读、不校验总长，所以多出的尾字无害。
// VBep20 delegator markets return two extra trailing zero words (measured: vUSDT's getAccountSnapshot
// returns 6 words, vBNB's 4). Everything below reads forward by offset without checking total length, so
// the extra words are harmless.

/** `getAssetsIn(address) -> address[]` —— SDK 不支持数组类型，手写解码。/ hand-decoded: the SDK has no array support. */
export function decodeAddressArray(hex) {
  const off = Number(wordAt(hex, 0)) / 32
  if (!Number.isInteger(off)) throw new Error('decodeAddressArray: misaligned offset')
  const n = Number(wordAt(hex, off))
  const out = []
  for (let i = 0; i < n; i++) out.push('0x' + wordAt(hex, off + 1 + i).toString(16).padStart(40, '0'))
  return out
}

/** `getAccountSnapshot(address) -> (uint err, uint vTokenBalance, uint borrowBalance, uint exchangeRateMantissa)` */
export function decodeAccountSnapshot(hex) {
  return {
    err: wordAt(hex, 0),
    vTokenBalance: wordAt(hex, 1),
    borrowBalance: wordAt(hex, 2),
    exchangeRateMantissa: wordAt(hex, 3),
  }
}

/**
 * `markets(address) -> (bool, uint, bool, uint, uint, uint96, bool)` —— **七个返回值，不是 Compound V2 的三个**。
 * 字段序来自 `ComptrollerStorage.sol` 的 `struct Market`（mapping 字段被 getter 跳过）。
 * Seven return values, not Compound V2's three. Field order follows `struct Market` in `ComptrollerStorage.sol`
 * (the mapping members are skipped by the generated getter).
 */
export function decodeMarket(hex) {
  if (wordCount(hex) < 7) throw new Error(`decodeMarket: expected 7 words, got ${wordCount(hex)}`)
  return {
    isListed: wordAt(hex, 0) !== 0n,
    collateralFactorMantissa: wordAt(hex, 1),
    isVenus: wordAt(hex, 2) !== 0n,
    liquidationThresholdMantissa: wordAt(hex, 3),
    liquidationIncentiveMantissa: wordAt(hex, 4),
    poolId: wordAt(hex, 5),
    isBorrowAllowed: wordAt(hex, 6) !== 0n,
  }
}

/** `getAccountLiquidity(address) -> (uint err, uint liquidity, uint shortfall)` */
export function decodeAccountLiquidity(hex) {
  return { err: wordAt(hex, 0), liquidity: wordAt(hex, 1), shortfall: wordAt(hex, 2) }
}

// ---------- 健康因子 / health factor ----------
//
// Venus 链上**没有** health factor 函数（实测 `healthFactor(address)` 与 `getHealthFactor(address)` 都返回
// `Diamond: Function does not exist`）。下面是本服务发布的定义，README 里逐字写着同一份公式：
//
//   weightedCollateralUsd = Σ_i (vTokenBalance_i · exchangeRateMantissa_i / 1e18) · price_i / 1e18
//                                · liquidationThresholdMantissa_i / 1e18
//   borrowUsd             = Σ_i borrowBalance_i · price_i / 1e18
//   healthFactor          = borrowUsd == 0 ? null : weightedCollateralUsd / borrowUsd
//
// 标度推导：`getUnderlyingPrice` 按 Compound 惯例返回 1e(36 − underlyingDecimals)，余额是 1e(underlyingDecimals)，
// 两者相乘得 1e36，再除 1e18 得 1e18 标度的 USD —— 与链上 `getAccountLiquidity` 的标度一致。
//
// Venus has no on-chain health factor (measured: both `healthFactor(address)` and `getHealthFactor(address)`
// revert with `Diamond: Function does not exist`). The definition above is this service's own and is printed
// verbatim in the README. Scale: `getUnderlyingPrice` returns 1e(36 − underlyingDecimals) by the Compound
// convention, balances are 1e(underlyingDecimals), so the product is 1e36 and one division by 1e18 lands on
// the same 1e18 USD scale the chain's own `getAccountLiquidity` uses.
//
// **权重用的是清算阈值（liquidationThreshold），不是抵押系数（collateralFactor）。** Venus Core 两条线是分开的，
// 而且实测确实不相等（vCAKE 0.50/0.55、vTSLAB 0.60/0.70、vXVS 0.45/0.60、vDOGE 0.00/0.43）。
// The weight is the liquidation threshold, not the collateral factor. Venus Core keeps the two apart and they
// really do differ on mainnet.

/**
 * @param {object} input
 * @param {string}   input.account
 * @param {string[]} input.assetsIn  getAssetsIn 的原序，不排序、不去重 / in `getAssetsIn` order, unsorted, not deduped
 * @param {object}   input.snapshots lowercased vToken -> { err, vTokenBalance, borrowBalance, exchangeRateMantissa }
 * @param {object}   input.markets   lowercased vToken -> decodeMarket(...)
 * @param {object}   input.prices    lowercased vToken -> BigInt (1e(36 − underlyingDecimals))
 * @param {object}   input.meta      lowercased vToken -> { symbol, underlying|null, underlyingDecimals }
 * @param {object}   input.liquidity { err, liquidity, shortfall }
 * @param {bigint}   input.closeFactorMantissa
 */
export function computeHealth({ account, assetsIn, snapshots, markets, prices, meta, liquidity, closeFactorMantissa }) {
  if (liquidity.err !== 0n) throw new TapeAPIError('INTERNAL', `comptroller error ${liquidity.err}`)

  let weightedCollateral = 0n
  let totalBorrow = 0n
  const rows = []

  for (const vTokenRaw of assetsIn) {
    const vToken = lower(vTokenRaw)
    const snap = snapshots[vToken]
    const market = markets[vToken]
    const price = prices[vToken]
    const m = meta[vToken]
    if (!snap || !market || price == null || !m) throw new Error(`computeHealth: missing data for ${vToken}`)
    if (snap.err !== 0n) throw new TapeAPIError('INTERNAL', `vToken error ${snap.err} for ${vToken}`)

    const underlyingAmount = (snap.vTokenBalance * snap.exchangeRateMantissa) / MANTISSA
    const supplyUsd = (underlyingAmount * price) / MANTISSA
    const borrowUsd = (snap.borrowBalance * price) / MANTISSA
    weightedCollateral += (supplyUsd * market.liquidationThresholdMantissa) / MANTISSA
    totalBorrow += borrowUsd

    // maxRepay：一次清算最多能替借款人还多少（closeFactor 是全局的 50%）/ how much one liquidation may repay
    const byCloseFactor = (snap.borrowBalance * closeFactorMantissa) / MANTISSA
    const maxRepay = byCloseFactor < snap.borrowBalance ? byCloseFactor : snap.borrowBalance

    rows.push({
      // EIP-55 校验和形式，与 `liquidationParams` 一致：两个方法的 vToken 字符串可以直接对着 join。
      // EIP-55 checksummed, matching `liquidationParams`, so a consumer can join the two methods by string.
      vToken: checksumAddress(vToken),
      underlying: m.underlying ? checksumAddress(m.underlying) : null,
      symbol: m.symbol,
      underlyingDecimals: m.underlyingDecimals,
      vTokenBalance: snap.vTokenBalance.toString(),
      borrowBalance: snap.borrowBalance.toString(),
      exchangeRateMantissa: snap.exchangeRateMantissa.toString(),
      priceMantissa: price.toString(),
      collateralFactorMantissa: market.collateralFactorMantissa.toString(),
      liquidationThresholdMantissa: market.liquidationThresholdMantissa.toString(),
      liquidationIncentiveMantissa: market.liquidationIncentiveMantissa.toString(),
      supplyUsd: fixed(supplyUsd, USD_DECIMALS),
      borrowUsd: fixed(borrowUsd, USD_DECIMALS),
      maxRepay: maxRepay.toString(),
    })
  }

  // liquidatable 用链上 `getAccountLiquidity` 的 shortfall 判，**不用** healthFactor —— 那是我们自己的派生量。
  // 注意 `getAccountLiquidity` 按清算阈值加权，而 `getBorrowingPower` 按抵押系数加权，两者不可互换。
  // `liquidatable` comes from the chain's own shortfall, never from our derived health factor.
  // `getAccountLiquidity` weights by the liquidation threshold; `getBorrowingPower` weights by the collateral
  // factor. They are not interchangeable.
  const liquidatable = liquidity.shortfall > 0n
  const healthFactorScaled = totalBorrow === 0n ? null : (weightedCollateral * 10n ** BigInt(HF_DECIMALS)) / totalBorrow
  const healthFactor = healthFactorScaled === null ? null : fixed(healthFactorScaled, HF_DECIMALS)

  let note = null
  if (healthFactorScaled !== null) {
    const belowOne = healthFactorScaled < 10n ** BigInt(HF_DECIMALS)
    if (liquidatable && !belowOne) note = NOTES.SHORTFALL_WITHOUT_HF
    else if (!liquidatable && belowOne) note = NOTES.HF_WITHOUT_SHORTFALL
  }

  return {
    account: checksumAddress(account),
    healthFactor,
    liquidatable,
    liquidityUsd: fixed(liquidity.liquidity, USD_DECIMALS),
    shortfallUsd: fixed(liquidity.shortfall, USD_DECIMALS),
    weightedCollateralUsd: fixed(weightedCollateral, USD_DECIMALS),
    borrowUsd: fixed(totalBorrow, USD_DECIMALS),
    closeFactorMantissa: closeFactorMantissa.toString(),
    markets: rows,
    note,
  }
}

/** healthFactor 字符串（或 null）与阈值比较；null 视为"无借款"，永远不入选。/ compares against a threshold; null never matches. */
export function atOrBelow(healthFactor, thresholdScaled) {
  if (healthFactor === null) return false
  return parseFixed(healthFactor, HF_DECIMALS, 'healthFactor') <= thresholdScaled
}

/** 把每个市场的清算激励渲染成给人看的百分比字符串 / renders a market's liquidation incentive for humans. */
export const incentivePct = (mantissa) => fixedDiv(BigInt(mantissa) * 100n, MANTISSA, 2)
