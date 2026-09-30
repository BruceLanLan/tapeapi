#!/usr/bin/env node
// DeFi 价格预言机示例：读 PancakeSwap V2 pair 的 getReserves()，多节点一致、区块锚定（默认 finalized，按 blockHash 读）、签名返回。
// DeFi price oracle example: PancakeSwap V2 getReserves() via quorum eth_call, pinned to one block (default `finalized`,
// evaluated by blockHash per EIP-1898), signed envelope.
import { readFile } from 'node:fs/promises'
import { createProvider } from '@tapeapi/server'
import { sig, abi, formatUnits, TapeAPIError } from '@tapeapi/sdk'
import { createChainReader, createTokenMeta, blockPinnedOf, bad } from '../_lib/chain.mjs'
import { exampleEnv, applyEnvToManifest, startProvider, rpcSummary } from '../_lib/service.mjs'

const here = new URL('.', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('manifest.json', here), 'utf8'))

// ---- env ----
const env = exampleEnv('oracle', { port: 8789 })
const { RPC_URLS, QUORUM, CHAIN_ID, LAG, PROD, SIGNER_KEY, log, store } = env
const DEFAULT_PAIR = process.env.PAIR || '0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE' // PancakeSwap V2 WBNB/USDT
const WBNB = process.env.WBNB || '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const USDT = process.env.USDT || '0x55d398326f99059fF775485246999027B3197955'
applyEnvToManifest(manifest, env)

// ---- 链读 / chain reads ----
// 钉块、按 blockHash 求值、token 元数据缓存都来自 `_lib/chain.mjs`，六个读链示例共用同一份实现。
// Pinning, blockHash evaluation and the token-metadata cache come from `_lib/chain.mjs`, shared by all six
// chain-reading examples.
const chain = createChainReader({ name: 'bsc', urls: RPC_URLS, quorum: QUORUM, lag: LAG, allowSingleNode: !PROD })
const rpc = chain.rpc
const { selector, decodeParams, isAddress, eqAddr, checksumAddress } = abi
const SEL = { token0: selector('token0()'), token1: selector('token1()'), getReserves: selector('getReserves()'), decimals: selector('decimals()'), symbol: selector('symbol()') }
const tokenMeta = createTokenMeta(rpc, SEL)

// 读一个 V2 pair 在锚定块的储备与价格 / Read a V2 pair's reserves & price at the pinned block.
async function readPair(pairAddr, block) {
  if (!isAddress(pairAddr)) bad('pair must be an address')
  const pinned = await chain.pinBlock(block)
  let token0Addr, token1Addr, reserves, blockRef
  try {
    const at = await chain.readAt(pinned, async (blk) => Promise.all([
      rpc.ethCall(pairAddr, SEL.token0, blk).then(d => decodeParams(['address'], d)[0]),
      rpc.ethCall(pairAddr, SEL.token1, blk).then(d => decodeParams(['address'], d)[0]),
      rpc.ethCall(pairAddr, SEL.getReserves, blk).then(d => decodeParams(['uint112', 'uint112', 'uint32'], d)),
    ]))
    ;[token0Addr, token1Addr, reserves] = at.value; blockRef = at.blockRef
  } catch (e) { if (e.code === 'RPC_ERROR' || e.code === 'ABI_INVALID') bad(`${pairAddr} does not look like a UniswapV2-style pair`); throw e }
  const blk = chain.blockArg(pinned, blockRef)
  const [token0, token1] = await Promise.all([tokenMeta(token0Addr, blk), tokenMeta(token1Addr, blk)])
  const [r0, r1, ts] = reserves
  if (r0 === 0n || r1 === 0n) bad('pair has no liquidity')
  const P = 8n // 价格保留 8 位小数 / 8 fixed decimals
  const token0InToken1 = (r1 * 10n ** BigInt(token0.decimals) * 10n ** P) / (r0 * 10n ** BigInt(token1.decimals))
  const token1InToken0 = (r0 * 10n ** BigInt(token1.decimals) * 10n ** P) / (r1 * 10n ** BigInt(token0.decimals))
  return {
    pair: checksumAddress(pairAddr), source: 'pancakeswap-v2', token0, token1,
    reserves: { reserve0: r0.toString(), reserve1: r1.toString(), blockTimestampLast: Number(ts) },
    price: { token0InToken1: formatUnits(token0InToken1, Number(P)), token1InToken0: formatUnits(token1InToken0, Number(P)) },
    // 总是返回，调用方做 callQuorum 时把同一个 blockNumber 显式传给每一家（TAPI-23 §3.4）。
    // Always present: a quorum caller passes this blockNumber explicitly to every provider.
    blockPinned: blockPinnedOf(pinned, blockRef),
  }
}

const provider = createProvider({
  manifest, signerKey: SIGNER_KEY, dev: !PROD, rpcUrls: RPC_URLS, quorum: QUORUM, chainId: CHAIN_ID, allowSingleNode: !PROD, log, store,
  methods: {
    // 收费：任意 V2 pair 的价格；block 可选（默认 finalized）/ paid: price of any V2 pair; optional block (default finalized)
    pairPrice: async ({ pair, block } = {}) => readPair(pair ?? DEFAULT_PAIR, block),
    // 免费：BNB/USD，从默认 pair 推导；运行时用 token0()/token1() 判断方向 / free: BNB in USD, orientation checked at runtime
    bnbUsd: async ({ block } = {}) => {
      const p = await readPair(DEFAULT_PAIR, block)
      const wbnbIs0 = eqAddr(p.token0.address, WBNB), wbnbIs1 = eqAddr(p.token1.address, WBNB)
      const usdtIs0 = eqAddr(p.token0.address, USDT), usdtIs1 = eqAddr(p.token1.address, USDT)
      if (!((wbnbIs0 && usdtIs1) || (wbnbIs1 && usdtIs0))) { log(`PAIR ${DEFAULT_PAIR} is not a WBNB/USDT pair`); throw new TapeAPIError('INTERNAL', 'misconfigured pair') }
      return { bnbUsd: wbnbIs0 ? p.price.token0InToken1 : p.price.token1InToken0, pair: p.pair, wbnb: WBNB, usdt: USDT, source: p.source, blockPinned: p.blockPinned }
    },
  },
})

await startProvider(provider, env, { lines: [
  `pair     ${DEFAULT_PAIR}`,
  rpcSummary(RPC_URLS, QUORUM, `, default block finalized, fallback lag ${LAG}`),
] })
