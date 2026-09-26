// 示例共用的「锚定区块 + 按 blockHash 求值」读链层 / The pinned-block chain reader shared by the examples.
//
// 六个读链示例此前各自抄了一份 pinBlock / readAt / perNode（其中两份的注释还写着"与 defi-price-oracle
// 逐字相同"）。它们确实逐字相同，只在「quorum / lag / 链名从哪里来」上不同，所以这里收成一个工厂：
// 单链示例建一个 reader，跨链示例建一个 `Map<chainId, reader>`，两条路径走同一份代码。
//
// The six chain-reading examples each carried their own copy of pinBlock / readAt / perNode — two of them
// with a comment saying "identical to defi-price-oracle's". They were identical; they differed only in where
// the quorum, the lag and the chain name came from. One factory serves both shapes: single-chain examples
// build one reader, cross-chain examples build a `Map<chainId, reader>`.
//
// 为什么要锚定区块 / why pin a block at all:
//   两家提供者要给出逐字节相同的答案，就必须在**同一个区块**上求值。`latest` 每秒都在动，所以默认钉
//   `finalized`，再要求 quorum 个节点对那个块的 hash 一致，之后每次 eth_call 都按 blockHash（EIP-1898）
//   求值 —— 这样即使期间发生重组，读到的也仍是被认证的那条链。
//   Two providers can only produce byte-identical answers if they evaluate at the same block. `latest` moves
//   every second, so the default is `finalized`; `quorum` nodes must then agree on that block's hash and every
//   later eth_call is evaluated at that hash (EIP-1898), so a reorg cannot silently change what was read.
import { createRpc, abi, TapeAPIError } from '@tapeapi/sdk'

/** 调用方的输入错误 / the caller's input is wrong (TAP-21 BAD_REQUEST). */
export const bad = (msg) => { throw new TapeAPIError('BAD_REQUEST', msg) }

/** 块号 → `eth_*` 的十六进制块参数 / a block number as the hex block parameter the `eth_*` methods take. */
export const blockTag = (n) => '0x' + BigInt(n).toString(16)

// 节点是否拒绝了 EIP-1898 块对象（而不是合约 revert）？revert 必须原样抛出，否则会被误当成"节点不支持"
// 而在另一个块参数下重试一次。/ Did the node reject the EIP-1898 block object, rather than the contract
// reverting? A revert must propagate: mistaking it for an unsupported block parameter would retry it.
export const rejectsBlockObject = (e) =>
  e instanceof TapeAPIError && e.code === 'RPC_ERROR' && e.rpcCode !== 3 && !/revert/i.test(e.message)

/** BSC 本链示例的区块字段（TAP-23 §3.4）/ the block fields the BSC-local examples return. */
export const blockPinnedOf = (pinned, blockRef) => ({ blockNumber: pinned.blockNumber, blockHash: pinned.blockHash, blockRef })

/**
 * 一条链的读取器。
 *   name            错误消息里的链名 / the chain name used in error messages
 *   urls, quorum    RPC 端点与法定节点数 / RPC endpoints and how many must agree
 *   lag             节点不支持 `finalized` 标签、以及 `block: 'latest'` 时的滞后块数 / head lag used when a
 *                   node lacks the `finalized` tag and for `block: 'latest'`
 *   allowSingleNode 开发用：URL 少于 quorum 时把 quorum 下调到 URL 数 / dev only: clamp quorum to the url count
 *   rpc, singles    直接注入（测试用）；给了就不再自己建 / injected (tests); when given, nothing is constructed
 *
 * A chain reader. `quorum` below always means `rpc.quorum`, i.e. the value `createRpc` actually settled on
 * after `allowSingleNode`, so a one-node dev setup behaves the same on every chain.
 */
export function createChainReader({ name = 'chain', urls = [], quorum = 2, lag = 1, allowSingleNode = false, rpc, singles, timeoutMs } = {}) {
  // timeoutMs bounds each node's answer: every read waits for all nodes (never a majority), so a hung node costs the
  // whole timeout on every round. / 每个节点的应答时限：每次读取都要等所有节点，挂住的节点每一轮都要耗满时限。
  const multi = rpc || createRpc({ urls, quorum, allowSingleNode, timeoutMs })
  // 每个节点再单独建一个 quorum 1 的 client：钉块要知道**每个节点各自**报了什么，不能只要一个共识答案。
  // One quorum-1 client per node: pinning needs each node's own answer, not a single agreed one.
  const nodes = singles || urls.map((u) => createRpc({ urls: [u], quorum: 1, timeoutMs }))
  const need = multi.quorum
  const lagBlocks = Number(lag)

  const perNode = async (fn) => (await Promise.allSettled(nodes.map(fn))).filter((s) => s.status === 'fulfilled').map((s) => s.value)
  const laggedHead = async () => {
    const heads = await perNode((r) => r.blockNumber())
    if (heads.length < need) throw new TapeAPIError('INTERNAL', `${name}: only ${heads.length}/${need} nodes answered eth_blockNumber`)
    return Math.min(...heads) - lagBlocks
  }

  /**
   * 解析并认证一个区块。`block` 省略 → `finalized`（各节点该标签高度的最小值；节点不支持该标签时退到
   * min(head) − lag）；`'safe'` / `'finalized'` 同理但不降级；`'latest'` → min(head) − lag；数字或 hex → 原样。
   * 然后要求至少 quorum 个节点作答、且全部作答节点对该块的 hash 一致。
   * Resolve and attest a block: omitted -> `finalized` (the min across nodes, degrading to min(head) − lag only
   * when a node lacks the tag); `'safe'`/`'finalized'` likewise but without the fallback; `'latest'` ->
   * min(head) − lag; a number or hex string as-is. Then at least `quorum` nodes must answer and all of them
   * must report the same hash for that block.
   */
  async function pinBlock(block) {
    let blockNumber
    if (block == null || block === 'safe' || block === 'finalized') {
      const tag = block ?? 'finalized'
      const nums = (await perNode((r) => r.call('eth_getBlockByNumber', [tag, false]))).filter((b) => b?.number).map((b) => Number(BigInt(b.number)))
      if (nums.length >= need) blockNumber = Math.min(...nums)
      else if (block == null) blockNumber = await laggedHead() // 仅默认情况降级 / the default degrades, an explicit tag does not
      else throw new TapeAPIError('INTERNAL', `${name}: only ${nums.length}/${need} nodes answered for tag ${tag}`)
    } else if (block === 'latest') blockNumber = await laggedHead()
    else if (Number.isInteger(block) && block >= 0) blockNumber = block
    else if (typeof block === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(block)) blockNumber = Number(BigInt(block))
    else bad("block must be a block number, hex string, 'latest', 'safe' or 'finalized'")

    const tag = blockTag(blockNumber)
    const blocks = (await perNode((r) => r.call('eth_getBlockByNumber', [tag, false]))).filter((b) => b?.hash)
    // Every node that answered must report the same hash (TAP-20 §3.2 / TAP-23 §3.4: never a majority). At a pinned
    // height a split means a reorg in flight or a lying node; either way nothing should be attested.
    // 所有作答节点的 hash 必须一致（绝不少数服从多数）。钉定高度上出现分歧意味着正在重组或有节点撒谎，都不该出证明。
    const hashes = new Set(blocks.map((b) => b.hash))
    if (blocks.length < need) throw new TapeAPIError('INTERNAL', `${name}: only ${blocks.length}/${need} nodes answered for block ${blockNumber}`)
    if (hashes.size > 1) throw new TapeAPIError('INTERNAL', `${name}: nodes disagree on the hash of block ${blockNumber} (${hashes.size} different hashes)`)
    const [blockHash] = hashes
    // timestamp 已经在上面那次 eth_getBlockByNumber 的返回体里，白拿；TWAP 的可用窗口检查需要它。
    // The timestamp is already in the response above; the TWAP window check needs it and no extra call is made.
    const hit = blocks.find((b) => b.hash === blockHash)
    return { blockNumber, blockHash, tag, timestamp: Number(BigInt(hit.timestamp ?? 0)) }
  }

  /**
   * 按认证过的 blockHash 求值；节点拒绝 EIP-1898 块对象时才退回块号，并用 `blockRef` 如实标明用了哪个。
   * Evaluate at the attested blockHash; fall back to the block number only when the node rejects the block
   * object, and say which was used via `blockRef`.
   */
  async function readAt(pinned, fn) {
    try { return { value: await fn({ blockHash: pinned.blockHash, requireCanonical: true }), blockRef: 'hash' } }
    catch (e) { if (!rejectsBlockObject(e)) throw e }
    return { value: await fn(pinned.tag), blockRef: 'number' }
  }

  /** `readAt` 之后再补读时用的块参数，与首次读取落在同一个块上 / the block parameter for follow-up reads. */
  const blockArg = (pinned, blockRef) => (blockRef === 'hash' ? { blockHash: pinned.blockHash, requireCanonical: true } : pinned.tag)

  /** 钉块 + 一次 quorum eth_call / pin a block, then one quorum eth_call evaluated at it. */
  async function attestedCall(to, data, block) {
    const pinned = await pinBlock(block)
    const { value, blockRef } = await readAt(pinned, (blk) => multi.ethCall(to, data, blk))
    return { pinned, result: value, blockRef }
  }

  return { name, urls, quorum: need, lag: lagBlocks, rpc: multi, nodes, perNode, pinBlock, readAt, blockArg, attestedCall }
}

/** `chains.json` + `RPC_<chainId>` 环境变量 → `Map<chainId, reader>` / build one reader per configured chain. */
export function createChainReaders(chainsCfg, { env = process.env, lag, allowSingleNode = false } = {}) {
  const chains = new Map()
  for (const [id, c] of Object.entries(chainsCfg)) {
    const override = env[`RPC_${id}`]
    const urls = override ? override.split(',').map((s) => s.trim()).filter(Boolean) : c.rpcUrls
    const reader = createChainReader({
      name: c.name || id, urls, quorum: Number(c.quorum ?? 2), lag: Number(lag ?? c.lag ?? 1), allowSingleNode,
    })
    chains.set(Number(id), Object.assign(reader, { symbol: c.symbol || 'ETH' }))
  }
  return chains
}

/** 按 chainId 取读取器，未配置的链报 BAD_REQUEST / look up a reader; an unserved chain is a BAD_REQUEST. */
export function chainReaderOf(chains, chainId) {
  if (!Number.isInteger(chainId)) bad('chainId must be an integer')
  const c = chains.get(chainId)
  if (!c) bad(`chainId ${chainId} not served; configured: ${[...chains.keys()].join(', ')}`)
  return c
}

/**
 * ERC-20 的 `decimals()` / `symbol()`。两者都不可变，按地址缓存一次即可。
 * `symbol()` 解不出来（老代币返回 bytes32 等）时留 null —— 那是这个合约在**任何**块上的固定事实。
 *
 * NOTE: a transport failure inside `symbol()` also yields null here, and the entry is then cached forever.
 * `defi-portfolio-read` has its own copy that rethrows transport faults (`isTokenDataFault`) precisely to
 * avoid that; the examples using this helper report `symbol` for display only, never inside a quorum
 * comparison, so the weaker rule is adequate for them and the two must not be merged blindly.
 * 注意：这里的 `symbol()` 把传输故障也记成 null 并永久缓存。`defi-portfolio-read` 另有一份会把传输故障抛出去
 * （`isTokenDataFault`），因为它的 symbol 会进入逐字节比较；用本助手的示例只把 symbol 当展示字段。
 */
export function createTokenMeta(rpc, { decimals: decimalsSel, symbol: symbolSel }) {
  const cache = new Map()
  return async function tokenMeta(address, blk) {
    const key = address.toLowerCase()
    if (cache.has(key)) return cache.get(key)
    const decimals = Number(abi.decodeParams(['uint8'], await rpc.ethCall(address, decimalsSel, blk))[0])
    let symbol = null
    try { symbol = abi.decodeParams(['string'], await rpc.ethCall(address, symbolSel, blk))[0] } catch { /* bytes32 symbols and friends */ }
    const meta = { address: abi.checksumAddress(address), symbol, decimals }
    cache.set(key, meta)
    return meta
  }
}
