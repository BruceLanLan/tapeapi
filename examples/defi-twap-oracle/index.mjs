#!/usr/bin/env node
// PancakeSwap V3 TWAP 示例：在锚定区块上读 `observe(uint32[])` 的算术平均 tick、现价 tick，返回两者的价格与
// 偏离标志。按 blockHash（EIP-1898）求值、签名返回。
//
// PancakeSwap V3 TWAP: the arithmetic-mean tick from `observe(uint32[])`, the spot tick, both prices and a
// deviation flag — all at one pinned block, evaluated at the attested blockHash (EIP-1898), signed.
//
// 现价 = 单区块末态，一笔闪电贷就能在一个交易内把它推到任意值再还回来。`window` 秒的算术平均 tick 要求攻击者
// **把价格维持 window 秒**，代价从"一次滑点"变成"持续持仓 + 每个区块被套利者反向吃掉"。详见 README。
// Spot is a single block's end state; one flash loan can move it anywhere and back inside one transaction. A
// `window`-second mean tick requires the attacker to hold the price for `window` seconds instead.
import { readFile } from 'node:fs/promises'
import { createProvider } from '@tapeapi/server'
import { sig, abi, TapeAPIError } from '@tapeapi/sdk'
import { W, padAddr, wordAt, encodeObserve, decodeObserve, decodeSlot0, decodeObservation } from '../_lib/codec.mjs'
import { createChainReader, createTokenMeta, blockPinnedOf, bad } from '../_lib/chain.mjs'
import {
  requireWindow, requireFee, requireDeviationBps, checkObservationWindow, buildTwap,
  TICK_SPACING, DEFAULT_WINDOW,
} from './twap.mjs'
import { exampleEnv, applyEnvToManifest, startProvider, rpcSummary } from '../_lib/service.mjs'

const here = new URL('.', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('manifest.json', here), 'utf8'))

// ---- env ----
const env = exampleEnv('twap', { port: 8793 })
const { RPC_URLS, QUORUM, CHAIN_ID, LAG, PROD, SIGNER_KEY, log, store } = env
// 默认池：WBNB/USDT fee 100。流动性最深、observation cardinality 4500 最大。
// **注意 token0 = USDT、token1 = WBNB**（不是直觉顺序）—— 方向永远运行时判断，不硬编码。
const DEFAULT_POOL = process.env.POOL || '0x172fcD41E0913e95784454622d1c3724f546f849'
const FACTORY = process.env.FACTORY || '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'  // PancakeV3Factory
const WBNB = process.env.WBNB || '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const USDT = process.env.USDT || '0x55d398326f99059fF775485246999027B3197955'
applyEnvToManifest(manifest, env)

// ---- 链读 / chain reads ----
// 钉块与按 blockHash 求值来自 `_lib/chain.mjs`；`pinBlock` 返回的 timestamp 正是 §2.5 的 maxWindow 所需，
// 而它本来就在钉块那次 eth_getBlockByNumber 的返回体里，不用另发请求。
// Pinning and blockHash evaluation come from `_lib/chain.mjs`. The `timestamp` it returns is what the §2.5
// maxWindow check needs, and it is already in the eth_getBlockByNumber response pinning has to make anyway.
const chain = createChainReader({ name: 'bsc', urls: RPC_URLS, quorum: QUORUM, lag: LAG, allowSingleNode: !PROD })
const rpc = chain.rpc
const { selector, decodeParams, isAddress, eqAddr, checksumAddress } = abi
const SEL = {
  slot0: selector('slot0()'),
  observe: selector('observe(uint32[])'),
  observations: selector('observations(uint256)'),
  liquidity: selector('liquidity()'),
  token0: selector('token0()'),
  token1: selector('token1()'),
  fee: selector('fee()'),
  decimals: selector('decimals()'),
  symbol: selector('symbol()'),
  getPool: selector('getPool(address,address,uint24)'),
}
const tokenMeta = createTokenMeta(rpc, SEL)

const addrFromWord = (data) => '0x' + wordAt(data, 0).toString(16).padStart(40, '0')

/** 池的静态面：token0 / token1 / fee。不可变，按池缓存。/ the pool's immutable face, cached per pool. */
const poolCache = new Map()
async function poolFace(pool, blk) {
  const key = pool.toLowerCase()
  if (poolCache.has(key)) return poolCache.get(key)
  const [t0, t1, fee] = await Promise.all([
    rpc.ethCall(pool, SEL.token0, blk).then(addrFromWord),
    rpc.ethCall(pool, SEL.token1, blk).then(addrFromWord),
    rpc.ethCall(pool, SEL.fee, blk).then(d => Number(wordAt(d, 0))),
  ])
  const [token0, token1] = await Promise.all([tokenMeta(t0, blk), tokenMeta(t1, blk)])
  const face = { token0, token1, fee }
  poolCache.set(key, face)
  return face
}

/**
 * §2.5 步骤 a–d：在**同一个 blockHash** 上算出实际可用窗口。比只看 cardinality 准确得多。
 * 等价于 `OracleLibrary.getOldestObservationSecondsAgo()`。
 * Steps a–d of the degradation gate: the actually-available window at the same blockHash. Far more accurate
 * than reading cardinality alone. Equivalent to `OracleLibrary.getOldestObservationSecondsAgo()`.
 */
async function oldestObservation(pool, slot0, pinned, blk) {
  if (slot0.observationCardinality < 1) return 0
  const idx = (slot0.observationIndex + 1) % slot0.observationCardinality
  let obs = decodeObservation(await rpc.ethCall(pool, SEL.observations + W(idx), blk))
  if (!obs.initialized) obs = decodeObservation(await rpc.ethCall(pool, SEL.observations + W(0), blk))
  return Math.max(0, pinned.timestamp - obs.blockTimestamp)
}

/** 方向：base/quote 必须是池里的两个 token 之一，且互不相同。默认 base = token1、quote = token0。 */
function resolveDirection(face, base, quote) {
  const pick = (a, dflt) => {
    if (a == null) return dflt
    if (!isAddress(a)) bad('base and quote must be addresses')
    if (eqAddr(a, face.token0.address)) return face.token0
    if (eqAddr(a, face.token1.address)) return face.token1
    bad(`${a} is not a token of this pool (${face.token0.address} / ${face.token1.address})`)
  }
  const b = pick(base, face.token1)
  const q = pick(quote, face.token0)
  if (eqAddr(b.address, q.address)) bad('base and quote must differ')
  return { base: b, quote: q }
}

async function readTwap({ pool, window, base, quote, deviationBps, block }) {
  if (!isAddress(pool)) bad('pool must be an address')
  const w = requireWindow(window)
  const limit = requireDeviationBps(deviationBps)
  const pinned = await chain.pinBlock(block)

  let face, slot0Raw, liquidityRaw, blockRef
  try {
    const at = await chain.readAt(pinned, async (blk) => {
      const f = await poolFace(pool, blk)
      const [s0, liq] = await Promise.all([rpc.ethCall(pool, SEL.slot0, blk), rpc.ethCall(pool, SEL.liquidity, blk)])
      return [f, s0, liq]
    })
    ;[face, slot0Raw, liquidityRaw] = at.value; blockRef = at.blockRef
  } catch (e) {
    if (e instanceof TapeAPIError && (e.code === 'RPC_ERROR' || e.code === 'ABI_INVALID')) bad(`${pool} does not look like a PancakeSwap V3 pool`)
    throw e
  }
  const slot0 = decodeSlot0(slot0Raw)
  const blk = chain.blockArg(pinned, blockRef)
  const maxWindow = await oldestObservation(pool, slot0, pinned, blk)
  // 先校验再发 observe：`OLD` revert 其实是我们的参数问题，不是链的问题。
  checkObservationWindow({ pool, window: w, observationCardinality: slot0.observationCardinality, maxWindow })

  let observed
  try { observed = decodeObserve(await rpc.ethCall(pool, encodeObserve(SEL.observe, w), blk)) }
  catch (e) {
    // 动态降级已经拦住了绝大多数情况；万一 observe 仍然 OLD，仍然归 BAD_REQUEST（同一个理由）。
    if (e instanceof TapeAPIError && /\bOLD\b/.test(e.message)) {
      // 结构化字段放在 `data` 下，否则 server 的信封序列化会丢掉它们（只读 `e.data`）。
      // Structured fields go under `data`, or the server's envelope serializer drops them (it reads `e.data`).
      throw new TapeAPIError('BAD_REQUEST', `window ${w}s exceeds this pool's observation history (observe reverted with OLD; cardinality ${slot0.observationCardinality})`, { data: { observationCardinality: slot0.observationCardinality, maxWindow } })
    }
    throw e
  }
  const dir = resolveDirection(face, base, quote)
  return buildTwap({
    pool: checksumAddress(pool),
    fee: face.fee,
    token0: face.token0,
    token1: face.token1,
    base: dir.base,
    quote: dir.quote,
    window: w,
    tickCumulatives: observed.tickCumulatives,
    spotTick: slot0.tick,
    liquidity: wordAt(liquidityRaw, 0),
    observationCardinality: slot0.observationCardinality,
    maxWindow,
    deviationBpsLimit: limit,
    blockPinned: blockPinnedOf(pinned, blockRef),
  })
}

const provider = createProvider({
  manifest, signerKey: SIGNER_KEY, dev: !PROD, rpcUrls: RPC_URLS, quorum: QUORUM, chainId: CHAIN_ID, allowSingleNode: !PROD, log, store,
  methods: {
    // [quorum] 任意 PancakeSwap V3 池的 TWAP + 现价 + 偏离标志 / any V3 pool's TWAP, spot and deviation flag
    twap: async ({ pool, window, base, quote, deviationBps, block } = {}) =>
      readTwap({ pool: pool ?? DEFAULT_POOL, window, base, quote, deviationBps, block }),

    // [quorum] 免费：BNB 兑 USDT，默认池、1800 s 窗口。方向运行时用 token0()/token1() 判断，不硬编码。
    // free: BNB in USDT from the default pool; orientation resolved at runtime, never hard-coded.
    bnbUsdTwap: async ({ window, block } = {}) => {
      const t = await readTwap({ pool: DEFAULT_POOL, window, base: WBNB, quote: USDT, deviationBps: null, block })
      const ok = (eqAddr(t.token0.address, WBNB) && eqAddr(t.token1.address, USDT)) ||
                 (eqAddr(t.token1.address, WBNB) && eqAddr(t.token0.address, USDT))
      if (!ok) { log(`POOL ${DEFAULT_POOL} is not a WBNB/USDT pool`); throw new TapeAPIError('INTERNAL', 'misconfigured pool') }
      // 这个形状是故意做小的：它是 `callQuorum` 的 `compare.relTolBps` 容差比较的目标。容差只放开 `paths`
      // 里点名的数值，其余字段（含 `deviates` 与整个 `blockPinned`）仍然逐字节比较。
      // This shape is deliberately small: it is the target of callQuorum's `compare.relTolBps`. Tolerance
      // only loosens the numbers named in `paths`; everything else — `deviates` and all of `blockPinned` —
      // still has to match byte for byte.
      return {
        bnbUsd: t.twapPrice,
        bnbUsdSpot: t.spotPrice,
        meanTick: t.meanTick,
        deviates: t.deviates,
        window: t.window,
        blockPinned: t.blockPinned,
      }
    },

    // [quorum] 免费：工厂查池 + slot0 摘要。**禁止用 CREATE2 推导 PancakeSwap 的池地址**，见 README。
    // free: factory lookup plus a slot0 summary. Never derive a PancakeSwap pool address with CREATE2.
    poolFor: async ({ tokenA, tokenB, fee, block } = {}) => {
      if (!isAddress(tokenA) || !isAddress(tokenB)) bad('tokenA and tokenB must be addresses')
      if (eqAddr(tokenA, tokenB)) bad('tokenA and tokenB must differ')
      const f = requireFee(fee)
      const pinned = await chain.pinBlock(block)
      const at = await chain.readAt(pinned, (blk) => rpc.ethCall(FACTORY, SEL.getPool + padAddr(tokenA) + padAddr(tokenB) + W(f), blk))
      const pool = addrFromWord(at.value)
      const blockPinned = blockPinnedOf(pinned, at.blockRef)
      if (/^0x0{40}$/.test(pool)) {
        return { pool: null, fee: f, tickSpacing: TICK_SPACING[f], observationCardinality: 0, maxWindow: 0, liquidity: '0', blockPinned }
      }
      const blk = chain.blockArg(pinned, at.blockRef)
      const [s0raw, liqRaw] = await Promise.all([rpc.ethCall(pool, SEL.slot0, blk), rpc.ethCall(pool, SEL.liquidity, blk)])
      const slot0 = decodeSlot0(s0raw)
      return {
        pool: checksumAddress(pool),
        fee: f,
        tickSpacing: TICK_SPACING[f],
        observationCardinality: slot0.observationCardinality,
        maxWindow: await oldestObservation(pool, slot0, pinned, blk),
        liquidity: wordAt(liqRaw, 0).toString(),
        blockPinned,
      }
    },
  },
})

await startProvider(provider, env, { lines: [
  `pool     ${DEFAULT_POOL}   factory ${FACTORY}   default window ${DEFAULT_WINDOW}s`,
  rpcSummary(RPC_URLS, QUORUM, `, default block finalized, fallback lag ${LAG}`),
] })
