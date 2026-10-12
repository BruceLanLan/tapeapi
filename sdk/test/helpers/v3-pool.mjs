// A Uniswap / PancakeSwap v3 pool and a dollar token on the fake chain, for the reference rate of the USD-pricing draft
// (§4.5): token0(), token1(), observe([window, 0]) and the dollar token's decimals(). The mean tick is what the test sets;
// tick cumulatives are built so that floor((c1 − c0) / window) gives it.
// 假链上的 v3 池子与美元代币，供美元计价草稿的参考汇率使用。测试设定平均 tick，tick 累计值按 floor((c1 − c0) / window) 反推。
import { BEM } from './fake-chain.mjs'

const word = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0')
const addrWord = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0')

/** The tick of a rate (USD per 1 BEM) for a pool, rounded down: what the pool would report at that price. */
export function tickForRate(rate, { bemIsToken0, usdDecimals }) {
  // rate = p·10^(8−d) (BEM token0) or 1/(p·10^(d−8)) (BEM token1), p = 1.0001^tick
  const p = bemIsToken0 ? rate / 10 ** (8 - usdDecimals) : 1 / (rate * 10 ** (usdDecimals - 8))
  return Math.floor(Math.log(p) / Math.log(1.0001))
}

export function installPool(chain, { pool, usd, usdDecimals = 18, bemIsToken0 = false, meanTick, rate, base = 1_000_000_000_000n, remainder = 0n }) {
  const state = { meanTick: meanTick ?? tickForRate(rate, { bemIsToken0, usdDecimals }), fail: null, observed: [] }
  const [t0, t1] = bemIsToken0 ? [BEM, usd] : [usd, BEM]
  chain.setRawCall(pool, (data) => {
    const sel = data.slice(0, 10)
    if (sel === '0x0dfe1681') return '0x' + addrWord(t0)
    if (sel === '0xd21220a7') return '0x' + addrWord(t1)
    if (sel === '0x883bdbfd') {
      if (state.fail) throw Object.assign(new Error(`execution reverted: ${state.fail}`), { code: 3 })
      const window = BigInt('0x' + data.slice(10 + 64 * 2, 10 + 64 * 3))
      state.observed.push(Number(window))
      const c0 = base, c1 = base + BigInt(state.meanTick) * window + remainder
      return '0x' + word(64) + word(64 + 32 * 3) + word(2) + word(c0) + word(c1) + word(2) + word(0) + word(0)
    }
    throw Object.assign(new Error('execution reverted'), { code: 3 })
  })
  chain.setRawCall(usd, (data) => {
    if (data.slice(0, 10) === '0x313ce567') return '0x' + word(usdDecimals)
    throw Object.assign(new Error('execution reverted'), { code: 3 })
  })
  return {
    state,
    setRate(r) { state.meanTick = tickForRate(r, { bemIsToken0, usdDecimals }) },
    setMeanTick(t) { state.meanTick = t },
    fail(why = 'OLD') { state.fail = why },
    heal() { state.fail = null },
  }
}
