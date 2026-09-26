#!/usr/bin/env node
// Venus（BNB Chain Core Pool）仓位健康度示例：给定一批地址，在**同一个锚定区块**上返回每个地址的健康因子、
// 可清算标志、分市场明细与可清算金额上限；全部读取经 Multicall3 批量、按 blockHash（EIP-1898）求值、签名返回。
//
// Venus (BNB Chain Core Pool) position health: for a caller-supplied set of addresses, the health factor,
// the liquidatable flag, per-market detail and the per-market repay cap — all at one pinned block, batched
// through Multicall3, evaluated at the attested blockHash (EIP-1898), returned in a signed envelope.
//
// 它**不能**列出全网可清算仓位：纯 eth_call 无法枚举借款人，而 BNB Chain 官方公共节点禁用了 eth_getLogs。
// 地址来源只能是调用方传入的数组或启动时配置的 watchlist。详见 README。
// It cannot enumerate every liquidatable position: plain eth_call cannot enumerate borrowers and the official
// BNB Chain public endpoints disable eth_getLogs. Addresses come from the caller or a configured watchlist.
import { readFile } from 'node:fs/promises'
import { createProvider } from '@tapeapi/server'
import { sig, abi, TapeAPIError } from '@tapeapi/sdk'
import { W, padAddr, wordAt, fixed, encodeAggregate3, decodeAggregate3 } from '../_lib/codec.mjs'
import { createChainReader, blockPinnedOf, bad } from '../_lib/chain.mjs'
import {
  MAX_ACCOUNTS, MANTISSA, computeHealth, decodeAddressArray, decodeAccountSnapshot, decodeMarket,
  decodeAccountLiquidity, requireAddress, requireAccounts, parseFixed, atOrBelow, lower, isAddr,
} from './health.mjs'
import { exampleEnv, applyEnvToManifest, startProvider, rpcSummary } from '../_lib/service.mjs'

const here = new URL('.', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('manifest.json', here), 'utf8'))

// ---- env ----
const env = exampleEnv('venus', { port: 8792 })
const { RPC_URLS, QUORUM, CHAIN_ID, LAG, PROD, SIGNER_KEY, log, store } = env
const COMPTROLLER = process.env.COMPTROLLER || '0xfD36E2c2a6789Db23113685031d7F16329158384' // Unitroller (Core Pool, EIP-2535 Diamond)
const MULTICALL3 = process.env.MULTICALL3 || '0xcA11bde05977b3631167028862bE2a173976CA11'
const VBNB = process.env.VBNB || '0xA07c5b74C9B40447a954e1466938b865b6BBea36'              // 没有 underlying() / has no underlying()
const BATCH = Number(process.env.MULTICALL_BATCH || 120)
applyEnvToManifest(manifest, env)

// watchlist：`atRisk` 在调用方不传 accounts 时扫描的地址集合。纯 eth_call 枚举不了借款人，所以这份名单
// 只能来自外部（这里是一个文件，生产里通常是子图或事件索引器的输出）。/ the set `atRisk` scans when the
// caller supplies none; it can only come from outside, because eth_call cannot enumerate borrowers.
let WATCHLIST = (process.env.WATCHLIST || '').split(',').map(s => s.trim()).filter(Boolean)
if (!WATCHLIST.length) {
  try { WATCHLIST = (JSON.parse(await readFile(new URL('watchlist.json', here), 'utf8')).accounts || []) } catch { WATCHLIST = [] }
}
WATCHLIST = WATCHLIST.filter(isAddr).map(lower)

const DEFAULT_VTOKENS = (process.env.VTOKENS || [
  '0xA07c5b74C9B40447a954e1466938b865b6BBea36', // vBNB
  '0xfD5840Cd36d94D7229439859C0112a4185BC0255', // vUSDT
  '0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8', // vUSDC
  '0x882C173bC7Ff3b7786CA16dfeD3DFFfb9Ee7847B', // vBTC
  '0xf508fCD89b8bd15579dc79A6827cB4686A3592c8', // vETH
  '0x86aC3974e2BD0d60825230fa6F355fF11409df5c', // vCAKE
  '0x6bCa74586218dB34cdB402295796b79663d816e9', // vWBNB
].join(',')).split(',').map(s => s.trim()).filter(Boolean)

// ---- 链读 / chain reads ----
// 钉块与按 blockHash 求值来自 `_lib/chain.mjs`，与其它读链示例同一份实现。
// Pinning and blockHash evaluation come from `_lib/chain.mjs`, shared with the other chain-reading examples.
const chain = createChainReader({ name: 'bsc', urls: RPC_URLS, quorum: QUORUM, lag: LAG, allowSingleNode: !PROD })
const rpc = chain.rpc
const { selector, decodeParams, checksumAddress } = abi
const SEL = {
  getAssetsIn: selector('getAssetsIn(address)'),
  getAccountLiquidity: selector('getAccountLiquidity(address)'),
  closeFactorMantissa: selector('closeFactorMantissa()'),
  oracle: selector('oracle()'),
  markets: selector('markets(address)'),
  getUnderlyingPrice: selector('getUnderlyingPrice(address)'),
  getAccountSnapshot: selector('getAccountSnapshot(address)'),
  symbol: selector('symbol()'),
  decimals: selector('decimals()'),
  underlying: selector('underlying()'),
  aggregate3: selector('aggregate3((address,bool,bytes)[])'),
}
// 非归档节点在历史块上没有状态时的典型表现 / how a non-archive node reports that it has no state at a block
const isStateUnavailable = (e) => /missing trie node|header not found|state (is )?not available|no state|pruned/i.test(String(e?.message || ''))

/**
 * Multicall3.aggregate3 批量读。`allowFailure` 一律 false：部分失败会让结果依赖"哪几个成功了"，破坏确定性。
 * 批量的理由是时序而非速度：50 个地址逐个 eth_call 约 800 次，公共 dataseed 限速下要二十多秒 ≈ 50 多个区块，
 * 而 geth 全节点默认只保留约 128 个区块的状态 —— 后半段调用会拿不到锚定块的状态，签出来的结果就不再
 * 对应它声称的区块。
 * Batched reads via Multicall3.aggregate3, always with allowFailure = false: partial failure would make the
 * result depend on which calls happened to succeed. The reason to batch is timing, not speed: 50 accounts is
 * ~800 individual eth_calls, which takes ~24 s under the public rate limit ≈ 50+ blocks, while a default geth
 * node keeps only ~128 blocks of state. The tail of such a run would miss the pinned block's state and the
 * signed result would no longer correspond to the block it claims.
 */
async function multicall(pinned, calls) {
  const out = []
  let blockRef = 'hash'
  for (let i = 0; i < calls.length; i += BATCH) {
    const chunk = calls.slice(i, i + BATCH)
    const data = encodeAggregate3(SEL.aggregate3, chunk.map(c => ({ target: c.target, allowFailure: false, callData: c.callData })))
    let at
    try { at = await chain.readAt(pinned, (blk) => rpc.ethCall(MULTICALL3, data, blk)) }
    catch (e) {
      if (isStateUnavailable(e)) throw new TapeAPIError('INTERNAL', `state unavailable at block ${pinned.blockNumber} on ${chain.quorum} nodes; serving blocks outside a node's state-retention window needs an archive RPC`)
      throw e
    }
    if (at.blockRef === 'number') blockRef = 'number'
    const results = decodeAggregate3(at.value)
    if (results.length !== chunk.length) throw new TapeAPIError('INTERNAL', `multicall returned ${results.length} results for ${chunk.length} calls`)
    results.forEach((r, k) => out.push({ ...r, label: chunk[k].label }))
  }
  return { results: out, blockRef }
}

// 不可变元数据（symbol / decimals / underlying）跨块缓存；markets() 按 (vToken, blockNumber) 缓存；
// priceMantissa 禁止跨块缓存。/ immutable metadata cached forever; markets() cached per block; prices never cached.
const metaCache = new Map()
const marketCache = new Map()

/** 一次请求要读的全部东西，装配成两批 multicall。/ everything one request needs, assembled into two multicalls. */
async function loadAccounts(accounts, pinned) {
  // 批 1：全局参数 + 每个账户的 assetsIn / liquidity
  const b1 = [
    { target: COMPTROLLER, callData: SEL.closeFactorMantissa, label: 'closeFactor' },
    { target: COMPTROLLER, callData: SEL.oracle, label: 'oracle' },
  ]
  for (const a of accounts) {
    b1.push({ target: COMPTROLLER, callData: SEL.getAssetsIn + padAddr(a), label: `assetsIn:${a}` })
    b1.push({ target: COMPTROLLER, callData: SEL.getAccountLiquidity + padAddr(a), label: `liquidity:${a}` })
  }
  const r1 = await multicall(pinned, b1)
  const byLabel = new Map(r1.results.map(r => [r.label, r.returnData]))
  const closeFactorMantissa = wordAt(byLabel.get('closeFactor'), 0)
  const oracle = '0x' + wordAt(byLabel.get('oracle'), 0).toString(16).padStart(40, '0')

  const assetsIn = {}
  const liquidity = {}
  const need = new Set()
  for (const a of accounts) {
    assetsIn[a] = decodeAddressArray(byLabel.get(`assetsIn:${a}`)).map(lower)
    liquidity[a] = decodeAccountLiquidity(byLabel.get(`liquidity:${a}`))
    for (const v of assetsIn[a]) need.add(v)
  }

  // 批 2：每个市场的 markets/price/metadata + 每个 (账户, 市场) 的 snapshot
  const b2 = []
  for (const v of need) {
    if (!marketCache.has(`${v}@${pinned.blockNumber}`)) b2.push({ target: COMPTROLLER, callData: SEL.markets + padAddr(v), label: `market:${v}` })
    b2.push({ target: oracle, callData: SEL.getUnderlyingPrice + padAddr(v), label: `price:${v}` }) // 永不缓存 / never cached
    if (!metaCache.has(v)) {
      b2.push({ target: v, callData: SEL.symbol, label: `symbol:${v}` })
      // vBNB 的 underlying 是原生 BNB，合约上没有 underlying()（实测返回空 returndata）。
      // allowFailure 是 false，所以不把它放进批里，直接特判成 null。
      // vBNB's underlying is native BNB and the contract has no underlying() (it returns empty data).
      // allowFailure is false, so it is never put in the batch; it is special-cased to null instead.
      if (lower(v) !== lower(VBNB)) b2.push({ target: v, callData: SEL.underlying, label: `underlying:${v}` })
    }
  }
  for (const a of accounts) for (const v of assetsIn[a]) b2.push({ target: v, callData: SEL.getAccountSnapshot + padAddr(a), label: `snap:${a}:${v}` })
  const r2 = b2.length ? await multicall(pinned, b2) : { results: [], blockRef: r1.blockRef }
  const by2 = new Map(r2.results.map(r => [r.label, r.returnData]))

  const markets = {}, prices = {}, meta = {}
  // 半成品**绝不能**进缓存：如果第三批（underlying 的 decimals）因限流或超时失败，一个
  // `underlyingDecimals: null` 的条目会永久留在缓存里，下一次请求跳过 decimals 批次、回落到 18，
  // 于是非 18 位小数的市场会在之后每一份**已签名**的响应里带着错的 USD 金额。
  // Never cache a half-built entry: if the third batch (the underlyings' decimals) fails on a rate limit or a
  // timeout, an entry with `underlyingDecimals: null` would stay cached forever, the next request would skip
  // the decimals batch and fall back to 18, and every later **signed** response for a market that is not
  // 18-decimal would carry wrong USD amounts. Entries are only committed once they are complete.
  const pending = new Map()
  const underlyingNeeds = []
  for (const v of need) {
    const mkKey = `${v}@${pinned.blockNumber}`
    if (by2.has(`market:${v}`)) marketCache.set(mkKey, decodeMarket(by2.get(`market:${v}`)))
    markets[v] = marketCache.get(mkKey)
    prices[v] = wordAt(by2.get(`price:${v}`), 0)
    if (!metaCache.has(v)) {
      let symbol = null
      try { symbol = decodeParams(['string'], by2.get(`symbol:${v}`))[0] } catch { /* bytes32 symbols etc. */ }
      const uRaw = by2.get(`underlying:${v}`)
      const underlying = uRaw && uRaw !== '0x' ? '0x' + wordAt(uRaw, 0).toString(16).padStart(40, '0') : null
      // vBNB 的 underlying 是原生 BNB，固定 18 位，不需要第三批 / vBNB's underlying is native BNB: 18, no lookup
      pending.set(v, { symbol, underlying, underlyingDecimals: underlying ? null : 18 })
      if (underlying) underlyingNeeds.push({ v, underlying })
    }
  }
  // 第三批只在有新市场时才发：underlying 的 decimals / a third batch only for newly seen markets
  if (underlyingNeeds.length) {
    const r3 = await multicall(pinned, underlyingNeeds.map(({ v, underlying }) => ({ target: underlying, callData: SEL.decimals, label: `dec:${v}` })))
    const by3 = new Map(r3.results.map(r => [r.label, r.returnData]))
    for (const { v } of underlyingNeeds) pending.get(v).underlyingDecimals = Number(wordAt(by3.get(`dec:${v}`), 0))
  }
  // 到这里每个 pending 条目都完整了，才落缓存 / only now is every pending entry complete
  for (const [v, m] of pending) metaCache.set(v, m)
  for (const v of need) meta[v] = metaCache.get(v)

  const snapshots = {}
  for (const a of accounts) {
    snapshots[a] = {}
    for (const v of assetsIn[a]) snapshots[a][v] = decodeAccountSnapshot(by2.get(`snap:${a}:${v}`))
  }
  const blockRef = r1.blockRef === 'number' || r2.blockRef === 'number' ? 'number' : 'hash'
  return { closeFactorMantissa, oracle, assetsIn, liquidity, markets, prices, meta, snapshots, blockRef }
}

async function accountsHealth(accounts, block) {
  const pinned = await chain.pinBlock(block)
  const d = await loadAccounts(accounts, pinned)
  const rows = accounts.map(a => computeHealth({
    account: a, assetsIn: d.assetsIn[a], snapshots: d.snapshots[a], markets: d.markets,
    prices: d.prices, meta: d.meta, liquidity: d.liquidity[a], closeFactorMantissa: d.closeFactorMantissa,
  }))
  return { rows, blockPinned: blockPinnedOf(pinned, d.blockRef) }
}

const provider = createProvider({
  manifest, signerKey: SIGNER_KEY, rpcUrls: RPC_URLS, quorum: QUORUM, chainId: CHAIN_ID, allowSingleNode: !PROD, log, store,
  methods: {
    // [quorum] 单地址健康度 / one account's health at a pinned block
    accountHealth: async ({ account, block } = {}) => {
      const a = requireAddress(account, 'account')
      const { rows, blockPinned } = await accountsHealth([a], block)
      return { ...rows[0], blockPinned }
    },
    // [quorum] 最多 50 个地址，同一个锚定块 / up to 50 accounts, one pinned block
    accountsHealth: async ({ accounts, block } = {}) => {
      const list = requireAccounts(accounts)
      const { rows, blockPinned } = await accountsHealth(list, block)
      return { accounts: rows, blockPinned }
    },
    // [quorum] 按健康因子阈值筛 watchlist / filter a watchlist by health-factor threshold
    atRisk: async ({ accounts, maxHealthFactor, block } = {}) => {
      const list = accounts == null ? WATCHLIST : requireAccounts(accounts)
      if (!list.length) bad('no accounts given and no watchlist configured (set WATCHLIST or examples/defi-lending-health/watchlist.json)')
      if (list.length > MAX_ACCOUNTS) bad(`watchlist has ${list.length} accounts, more than the ${MAX_ACCOUNTS} cap`)
      const threshold = maxHealthFactor == null ? '1.05' : String(maxHealthFactor)
      const scaled = parseFixed(threshold, 18, 'maxHealthFactor')
      const { rows, blockPinned } = await accountsHealth(list, block)
      return {
        atRisk: rows.filter(r => r.liquidatable || atOrBelow(r.healthFactor, scaled)),
        scanned: rows.length, threshold, blockPinned,
      }
    },
    // [quorum] 免费：协议层参数 / free: protocol-level parameters
    liquidationParams: async ({ vTokens, block } = {}) => {
      let list = vTokens == null ? DEFAULT_VTOKENS : vTokens
      if (!Array.isArray(list)) bad('vTokens must be an array of addresses')
      if (list.length === 0 || list.length > MAX_ACCOUNTS) bad(`vTokens must have 1..${MAX_ACCOUNTS} entries`)
      list = list.map((v, i) => requireAddress(v, `vTokens[${i}]`))
      const pinned = await chain.pinBlock(block)
      const calls = [
        { target: COMPTROLLER, callData: SEL.closeFactorMantissa, label: 'closeFactor' },
        { target: COMPTROLLER, callData: SEL.oracle, label: 'oracle' },
      ]
      for (const v of list) calls.push({ target: COMPTROLLER, callData: SEL.markets + padAddr(v), label: `market:${v}` })
      const first = await multicall(pinned, calls)
      const by = new Map(first.results.map(r => [r.label, r.returnData]))
      const oracle = '0x' + wordAt(by.get('oracle'), 0).toString(16).padStart(40, '0')
      const mk = {}
      for (const v of list) {
        mk[v] = decodeMarket(by.get(`market:${v}`))
        // 地址表不可信：deployments 里有的市场在 Comptroller 里并不 listed（实测 vLUNA.isListed === false）。
        // Never trust an address list: markets present in `deployments` can be unlisted on the Comptroller.
        if (!mk[v].isListed) bad(`${v} is not a listed core-pool market`)
      }
      const second = await multicall(pinned, [
        ...list.map(v => ({ target: oracle, callData: SEL.getUnderlyingPrice + padAddr(v), label: `price:${v}` })),
        ...list.filter(v => !metaCache.has(v)).flatMap(v => [
          { target: v, callData: SEL.symbol, label: `symbol:${v}` },
          ...(lower(v) === lower(VBNB) ? [] : [{ target: v, callData: SEL.underlying, label: `underlying:${v}` }]),
        ]),
      ])
      const by2 = new Map(second.results.map(r => [r.label, r.returnData]))
      // 与 loadAccounts 同理：条目完整之前不落缓存 / as in loadAccounts: nothing is cached until it is complete
      const pending = new Map()
      const pendingDecimals = []
      for (const v of list) {
        if (metaCache.has(v)) continue
        let symbol = null
        try { symbol = decodeParams(['string'], by2.get(`symbol:${v}`))[0] } catch { /* bytes32 symbols etc. */ }
        const uRaw = by2.get(`underlying:${v}`)
        const underlying = uRaw && uRaw !== '0x' ? '0x' + wordAt(uRaw, 0).toString(16).padStart(40, '0') : null
        pending.set(v, { symbol, underlying, underlyingDecimals: underlying ? null : 18 })
        if (underlying) pendingDecimals.push({ v, underlying })
      }
      if (pendingDecimals.length) {
        const third = await multicall(pinned, pendingDecimals.map(({ v, underlying }) => ({ target: underlying, callData: SEL.decimals, label: `dec:${v}` })))
        const by3 = new Map(third.results.map(r => [r.label, r.returnData]))
        for (const { v } of pendingDecimals) pending.get(v).underlyingDecimals = Number(wordAt(by3.get(`dec:${v}`), 0))
      }
      for (const [v, m] of pending) metaCache.set(v, m)
      const blockRef = [first, second].some(r => r.blockRef === 'number') ? 'number' : 'hash'
      return {
        comptroller: checksumAddress(COMPTROLLER),
        oracle: checksumAddress(oracle),
        closeFactorMantissa: wordAt(by.get('closeFactor'), 0).toString(),
        // 注意：Core Comptroller 上**没有** liquidationIncentiveMantissa()（实测 revert
        // "Diamond: Function does not exist"），也**没有** minLiquidatableCollateral()。清算激励是按市场的，
        // 从 markets() 的第 5 个返回值取。/ the Core Comptroller has neither of those globals; the liquidation
        // incentive is per-market and comes from markets()' fifth return value.
        markets: list.map(v => ({
          vToken: checksumAddress(v),
          underlying: metaCache.get(v).underlying ? checksumAddress(metaCache.get(v).underlying) : null,
          symbol: metaCache.get(v).symbol,
          underlyingDecimals: metaCache.get(v).underlyingDecimals,
          isListed: mk[v].isListed,
          isBorrowAllowed: mk[v].isBorrowAllowed,
          collateralFactorMantissa: mk[v].collateralFactorMantissa.toString(),
          liquidationThresholdMantissa: mk[v].liquidationThresholdMantissa.toString(),
          liquidationIncentiveMantissa: mk[v].liquidationIncentiveMantissa.toString(),
          priceMantissa: wordAt(by2.get(`price:${v}`), 0).toString(),
          priceUsd: fixed((wordAt(by2.get(`price:${v}`), 0) * 10n ** BigInt(metaCache.get(v).underlyingDecimals)) / MANTISSA, 18),
        })),
        blockPinned: blockPinnedOf(pinned, blockRef),
      }
    },
    // [no-quorum] 机器人快通道：在 head − BLOCK_LAG 上求值。两家提供者几乎不可能钉到同一个块，
    // 放进 callQuorum 必然 QUORUM_FAILED —— 这是设计如此。
    // [no-quorum] the bot fast path, evaluated at head − BLOCK_LAG. Two providers will essentially never pin
    // the same block, so callQuorum always fails on this method. That is by design.
    accountHealthLatest: async ({ account } = {}) => {
      const a = requireAddress(account, 'account')
      const { rows, blockPinned } = await accountsHealth([a], 'latest')
      return { ...rows[0], blockPinned }
    },
  },
})

await startProvider(provider, env, { lines: [
  `venus    comptroller ${COMPTROLLER}   multicall3 ${MULTICALL3}   watchlist ${WATCHLIST.length} accounts`,
  rpcSummary(RPC_URLS, QUORUM, `, default block finalized, fallback lag ${LAG}, multicall batch ${BATCH}`),
] })
