#!/usr/bin/env node
// TAP-23 多链组合读取：某地址在 BSC / Ethereum / Base 上的原生币余额、ERC-20 余额与 LP 仓位，
// **每条链各自锚定一个区块**（默认 `finalized`，按 blockHash 以 EIP-1898 求值），签名返回。
// 钉块与按 blockHash 求值来自 `_lib/chain.mjs`（与 `chain-attested-read` 共用），
// 所有纯逻辑在 `portfolio.mjs`，单测从那里 import，因此不开 socket。
//
// TAP-23 multi-chain portfolio read: an address's native balance, ERC-20 balances and LP positions on
// BSC / Ethereum / Base, each chain pinned to its own block (default `finalized`, evaluated at the attested
// blockHash per EIP-1898), signed. Pinning and blockHash evaluation come from `_lib/chain.mjs` (shared with
// `chain-attested-read`); all pure logic lives in `portfolio.mjs`.
import { readFile } from 'node:fs/promises'
import { createProvider } from '@tapeapi/server'
import { sig, abi, TapeAPIError } from '@tapeapi/sdk'
import { createChainReaders, chainReaderOf } from '../_lib/chain.mjs'
import {
  MAX_TOKENS, MAX_CHAINS, MAX_POSITIONS, V3_MANAGER, DEFAULT_PAIR, SEL, bad,
  assertTokenList, assertChainList, assertPositionLimit,
  decodeUint, decodeAddress, decodeDecimals, decodeSymbol, decodeReserves, decodePositions,
  callBalanceOf, callTokenOfOwnerByIndex, callPositions,
  tokenEntry, failedTokenEntry, nativeEntry, positionEntry, isTokenDataFault,
  buildBalancesResult, buildLpV2Result, buildLpV3Result,
} from './portfolio.mjs'
import { exampleEnv, applyEnvToManifest, startProvider } from '../_lib/service.mjs'

const here = new URL('.', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('manifest.json', here), 'utf8'))
const chainsCfg = JSON.parse(await readFile(new URL(process.env.CHAINS_FILE || 'chains.json', here), 'utf8'))

// ---- env（provider 自身身份与结算仍在 BSC）/ env (identity & settlement stay on BSC) ----
const env = exampleEnv('portfolio', { port: 8795 })
const { RPC_URLS, QUORUM, CHAIN_ID, PROD, SIGNER_KEY, log, store } = env
// 后备滞后块数：省略时用 chains.json 的每链 `lag`，设了就覆盖所有链 / fallback head lag; per-chain `lag` from chains.json unless this is set
const BLOCK_LAG = process.env.BLOCK_LAG == null ? null : Number(process.env.BLOCK_LAG)
applyEnvToManifest(manifest, env)

// ---- 外链读取器：chainId → reader / one reader per foreign chain, keyed by chainId ----
// `RPC_<chainId>=url1,url2` 覆盖 chains.json 的 rpcUrls；`BLOCK_LAG` 按同一约定覆盖每条链的 lag。
// README 的"制造一次 QUORUM_FAILED"就靠它：两份实例给不同的 BLOCK_LAG，`block: 'latest'` 便落在不同块上。
// `RPC_<chainId>` overrides chains.json's rpcUrls and `BLOCK_LAG` overrides every chain's lag, by the same
// convention. The README's forced-QUORUM_FAILED demo uses it: two instances with different lags resolve
// `latest` to different blocks.
const chains = createChainReaders(chainsCfg, { lag: BLOCK_LAG, allowSingleNode: !PROD })
const { isAddress, checksumAddress } = abi
const chainOf = (chainId) => chainReaderOf(chains, chainId)

// ---- 领域读取 / domain reads ----

// token 元数据不可变，按 chainId+地址缓存 / token metadata is immutable; cached per chainId + address.
const metaCache = new Map()
async function tokenMeta(c, chainId, token, blk) {
  const key = `${chainId}:${token.toLowerCase()}`
  if (metaCache.has(key)) return metaCache.get(key)
  const decimals = decodeDecimals(await c.rpc.ethCall(token, SEL.decimals, blk)) // 失败即抛，调用方记 TOKEN_READ_FAILED
  let symbol = null
  try { symbol = decodeSymbol(await c.rpc.ethCall(token, SEL.symbol, blk)) }
  catch (e) {
    // 这里**不能**用裸 catch：传输故障被吞掉就会把 `symbol: null` 写进下面的缓存，而缓存既不带块号也不过期，
    // 于是这台机器**永远**把一个完全标准的代币报成非标准，另一家却报出正确的 symbol——两家永久分歧。
    // 只有「合约自己就读不出来」才留 null（那是锚定块上的确定事实，每家都一样）。
    // A bare catch would swallow a transport failure and cache `symbol: null` below — and that cache carries no
    // block and never expires, so this instance would report a perfectly standard token as non-standard
    // forever while an honest peer reports the real symbol. Only a fault in the contract's own data stays null.
    if (!isTokenDataFault(e)) throw e
  }
  const meta = { decimals, symbol }
  metaCache.set(key, meta)
  return meta
}

// 一条链上的余额，锚定在 pinned 块 / balances on one chain at the pinned block.
async function balancesAt(c, chainId, address, tokens, pinned) {
  const { value, blockRef } = await c.readAt(pinned, async (blk) => {
    const wei = BigInt(await c.rpc.call('eth_getBalance', [address, blk]))
    // 逐个 token 各自 try/catch：**保持入参顺序**，一个 token 读失败不影响其它项，也不让整个请求失败。
    // One try/catch per token: caller order is preserved and a single bad token never fails the request.
    const entries = await Promise.all(tokens.map(async (t) => {
      try {
        const [meta, balHex] = await Promise.all([tokenMeta(c, chainId, t, blk), c.rpc.ethCall(t, callBalanceOf(address), blk)])
        return tokenEntry(t, { balance: decodeUint(balHex), decimals: meta.decimals, symbol: meta.symbol })
      } catch (e) {
        // 只有「这个合约本身读不出来」才降级；传输故障抛上去让整个请求失败，否则两家提供者会因为一次
        // 网络抖动而逐字节不同（见 portfolio.mjs 的 isTokenDataFault）。
        // Only a fault in the contract's own data degrades to an entry; a transport failure is rethrown, or two
        // providers would differ byte-for-byte over a network blip (see isTokenDataFault in portfolio.mjs).
        if (!isTokenDataFault(e)) throw e
        return failedTokenEntry(t) // 固定字符串：上游消息可能带主机名 / fixed string: messages can carry hostnames
      }
    }))
    return { wei, entries }
  })
  return { native: nativeEntry(c.symbol, value.wei), tokens: value.entries, blockRef }
}

const provider = createProvider({
  manifest, signerKey: SIGNER_KEY, dev: !PROD, rpcUrls: RPC_URLS, quorum: QUORUM, chainId: CHAIN_ID, allowSingleNode: !PROD, log, store,
  methods: {
    // [quorum] 一条链上的原生币 + ERC-20 余额 / native + ERC-20 balances on one chain
    balances: async ({ chainId, address, tokens, block } = {}) => {
      const c = chainOf(chainId)
      if (!isAddress(address)) bad('address must be an address')
      const list = assertTokenList(tokens)
      const pinned = await c.pinBlock(block)
      const { native, tokens: entries, blockRef } = await balancesAt(c, chainId, address, list, pinned)
      return buildBalancesResult({ chainId, pinned, blockRef, address, native, tokens: entries })
    },

    // [no-quorum]：顶层没有单一区块，每条链各自锚定；要 quorum 就对每条链分别调 `balances`。
    // [no-quorum]: there is no single block at the top level — each chain is pinned on its own. For a quorum
    // round, call `balances` per chain with that chain's explicit block number (TAP-23 §3.4).
    portfolio: async ({ address, chains: req } = {}) => {
      if (!isAddress(address)) bad('address must be an address')
      const list = assertChainList(req)
      const out = await Promise.all(list.map(async ({ chainId, tokens, block }) => {
        const c = chainOf(chainId)
        const pinned = await c.pinBlock(block)
        const { native, tokens: entries, blockRef } = await balancesAt(c, chainId, address, tokens, pinned)
        // 每个 chains[i] 各自带 TAP-23 §3.3 的四个扁平字段 / each entry carries the same four flat fields
        return buildBalancesResult({ chainId, pinned, blockRef, address, native, tokens: entries })
      }))
      // 顺序 == 入参顺序（SPEC §0.3.5），不按完成顺序 / caller order, never Promise completion order
      return { address: checksumAddress(address), chains: out }
    },

    // [quorum] UniswapV2 / PancakeV2 LP 仓位：占储备的份额 / LP position: share of the reserves
    lpV2: async ({ chainId, address, pair, block } = {}) => {
      const c = chainOf(chainId)
      if (!isAddress(address)) bad('address must be an address')
      const p = pair ?? DEFAULT_PAIR
      if (!isAddress(p)) bad('pair must be an address')
      const pinned = await c.pinBlock(block)
      let v, blockRef
      try {
        const at = await c.readAt(pinned, async (blk) => Promise.all([
          c.rpc.ethCall(p, SEL.token0, blk).then(decodeAddress),
          c.rpc.ethCall(p, SEL.token1, blk).then(decodeAddress),
          c.rpc.ethCall(p, SEL.getReserves, blk).then(decodeReserves),
          c.rpc.ethCall(p, SEL.totalSupply, blk).then(decodeUint),
          c.rpc.ethCall(p, callBalanceOf(address), blk).then(decodeUint),
        ]))
        v = at.value; blockRef = at.blockRef
      } catch (e) { if (e.code === 'RPC_ERROR' || e.code === 'ABI_INVALID') bad(`${p} does not look like a UniswapV2-style pair`); throw e }
      const [t0, t1, reserves, totalSupply, lpBalance] = v
      // 同样的规则：合约读不出来 → null；传输故障 → 抛上去。`lpV2` 是 [quorum] 方法，而 token0/token1 上
      // **没有** `error` 字段可以标记"不确定"，所以一次网络抖动会让两家提供者静默地不一致。
      // The same rule: a data fault yields null, a transport failure is rethrown. `lpV2` is a [quorum] method and
      // token0/token1 carry no `error` field to mark "unknown", so a blip would silently desync two providers.
      const metaOrNull = (t) => tokenMeta(c, chainId, t, pinned.tag)
        .catch((e) => { if (!isTokenDataFault(e)) throw e; return { decimals: null, symbol: null } })
      const [m0, m1] = await Promise.all([metaOrNull(t0), metaOrNull(t1)])
      return buildLpV2Result({
        chainId, pinned, blockRef, address, pair: p,
        token0: { address: checksumAddress(t0), symbol: m0.symbol, decimals: m0.decimals, reserve: reserves.reserve0.toString() },
        token1: { address: checksumAddress(t1), symbol: m1.symbol, decimals: m1.decimals, reserve: reserves.reserve1.toString() },
        lpBalance, totalSupply, reserve0: reserves.reserve0, reserve1: reserves.reserve1,
      })
    },

    // [quorum] PancakeSwap V3 的 NFT 仓位（仅 chainId 56）；返回**原始仓位参数**，不换算成 token 数量。
    // [quorum] PancakeSwap V3 NFT positions (chainId 56 only); raw position parameters only, never amounts.
    lpV3: async ({ chainId, address, limit, block } = {}) => {
      const c = chainOf(chainId)
      // TAP-23 §3.1：请求 `attestedRead.chains` 之外的链回 METHOD_NOT_FOUND（此方法的档案里只有 56）。
      // TAP-23 §3.1: a chain outside this method's `attestedRead.chains` is a METHOD_NOT_FOUND.
      if (chainId !== 56) throw new TapeAPIError('METHOD_NOT_FOUND', `lpV3 serves chainId 56 only (attestedRead.chains = [56]), got ${chainId}`)
      if (!isAddress(address)) bad('address must be an address')
      const cap = assertPositionLimit(limit)
      const pinned = await c.pinBlock(block)
      const { value, blockRef } = await c.readAt(pinned, async (blk) => {
        const count = decodeUint(await c.rpc.ethCall(V3_MANAGER, callBalanceOf(address), blk))
        const take = count < BigInt(cap) ? Number(count) : cap
        // 下标 0..take-1，顺序确定；Promise.all 保序，不依赖完成顺序 / deterministic index order, not completion order
        const ids = await Promise.all(Array.from({ length: take }, (_, i) =>
          c.rpc.ethCall(V3_MANAGER, callTokenOfOwnerByIndex(address, i), blk).then(decodeUint)))
        const positions = await Promise.all(ids.map(async (id) =>
          positionEntry(id, decodePositions(await c.rpc.ethCall(V3_MANAGER, callPositions(id), blk)))))
        return { count, positions }
      })
      return buildLpV3Result({ chainId, pinned, blockRef, address, manager: V3_MANAGER, count: value.count, positions: value.positions })
    },
  },
})

await startProvider(provider, env, { lines: [
  ...[...chains].map(([id, c]) =>
    `chain ${String(id).padEnd(6)} ${c.name.padEnd(9)} ${c.symbol.padEnd(4)} quorum ${c.quorum} lag ${c.lag}  ${c.urls.map(u => new URL(u).hostname).join(', ')}  (default block: finalized, reads by blockHash)`),
  `limits   tokens<=${MAX_TOKENS}  chains<=${MAX_CHAINS}  lpV3 limit<=${MAX_POSITIONS}   lpV3 manager ${V3_MANAGER} (chainId 56 only)`,
] })
