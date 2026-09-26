// The public TapeAPI service's methods (api.tapeapi.fun): free, block-pinned reads of BNB Smart Chain and of TapeOut
// itself. Pure: every method takes a chain reader (examples/_lib/chain.mjs), so the tests run on a fake chain and the
// Worker, Node or anything else supplies the real one.
// 公共 TapeAPI 服务（api.tapeapi.fun）的方法：免费、锚定区块地读取 BNB 链和 TapeOut 本身。纯函数：每个方法接收一个链读取器，
// 测试用假链，Worker 或 Node 提供真链。
//
// Every answer carries blockPinned { blockNumber, blockHash, blockRef }: a caller who wants a second opinion passes the
// same blockNumber to another provider (callQuorum) and compares bytes (TAP-23 §3.4).
// 每个回答都带 blockPinned：要第二意见的调用方把同一个 blockNumber 交给另一家提供者（callQuorum）逐字节比较。
import { abi, formatUnits, MAINNET, registryKey } from '@tapeapi/sdk'
import { blockPinnedOf, bad } from '../_lib/chain.mjs'

const { selector, decodeParams, encodeParams, isAddress, checksumAddress, eqAddr, encodeCall, decodeReturn, hexToBytes, toHex } = abi
const SEL = {
  decimals: selector('decimals()'), symbol: selector('symbol()'), name: selector('name()'), totalSupply: selector('totalSupply()'),
  balanceOf: selector('balanceOf(address)'), ownerOf: selector('ownerOf(uint256)'),
  token0: selector('token0()'), token1: selector('token1()'), getReserves: selector('getReserves()'),
  cpuAt: selector('cpuAt(uint256)'),
}
export const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
export const USDT = '0x55d398326f99059fF775485246999027B3197955'
export const WBNB_USDT_V2 = '0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE'   // PancakeSwap V2
const BLOCK = "number|'finalized'|'safe'|'latest'? (default finalized)"
const PINNED = { blockPinned: 'object' }
// encodeParams returns bytes; calldata is a hex string. / encodeParams 返回字节，calldata 是十六进制串。
const hexArgs = (types, values) => toHex(encodeParams(types, values)).slice(2)
const word = (n) => hexArgs(['uint256'], [BigInt(n)])
const addrParam = (a, what) => { if (!isAddress(a)) bad(`${what} must be a 0x address of 40 hex digits`); return a }
const uintString = (v, what) => { const s = String(v ?? '').trim(); if (!/^\d{1,78}$/.test(s)) bad(`${what} must be a non-negative integer (a decimal string)`); return BigInt(s) }

// Some tokens return string, some bytes32 (e.g. MKR), some nothing; a display field never fails the read.
// 有的代币返回 string，有的 bytes32，有的什么都不返回；展示字段读不出来不让整次读取失败。
function textOf(raw) {
  try { return decodeParams(['string'], raw)[0] } catch { /* try bytes32 */ }
  try { if (raw && raw.length === 66) return new TextDecoder('utf-8', { fatal: true }).decode(hexToBytes(raw)).replace(/\0+$/, '') || null } catch { /* none */ }
  return null
}

/** The manifest entries, in the order clients show them. / 清单里的方法声明，按展示顺序。 */
export const MANIFEST_METHODS = [
  { name: 'blockNumber', priceBEM: '0', params: {}, returns: { blockNumber: 'number' },
    description: 'The latest BNB Smart Chain block the service agrees on (several nodes must agree).' },
  { name: 'balance', priceBEM: '0', params: { address: 'address', block: BLOCK }, returns: { address: 'address', wei: 'string', bnb: 'string', ...PINNED },
    description: '[quorum] Native BNB balance of an address, pinned to one block.' },
  { name: 'tokenInfo', priceBEM: '0', params: { token: 'address', block: BLOCK }, returns: { token: 'address', name: 'string|null', symbol: 'string|null', decimals: 'number', totalSupply: 'string', ...PINNED },
    description: '[quorum] BEP-20 token metadata and total supply, pinned to one block.' },
  { name: 'tokenBalance', priceBEM: '0', params: { token: 'address', address: 'address', block: BLOCK }, returns: { token: 'address', address: 'address', raw: 'string', amount: 'string', symbol: 'string|null', decimals: 'number', ...PINNED },
    description: '[quorum] BEP-20 balance of an address (raw and in token units), pinned to one block.' },
  { name: 'nftOwner', priceBEM: '0', params: { contract: 'address', tokenId: 'string', block: BLOCK }, returns: { contract: 'address', tokenId: 'string', owner: 'address', ...PINNED },
    description: '[quorum] Owner of an ERC-721 token, pinned to one block.' },
  { name: 'pairPrice', priceBEM: '0', params: { pair: 'address', block: BLOCK }, returns: { pair: 'address', token0: 'object', token1: 'object', reserves: 'object', price: 'object', ...PINNED },
    description: '[quorum] Spot price from a PancakeSwap V2 pair\'s reserves, pinned to one block. A spot price can be moved within a block: do not use it alone for liquidations.' },
  { name: 'bnbUsd', priceBEM: '0', params: { block: BLOCK }, returns: { bnbUsd: 'string', pair: 'address', ...PINNED },
    description: '[quorum] BNB in USDT from the PancakeSwap V2 WBNB/USDT pair, pinned to one block. Spot price: see pairPrice.' },
  { name: 'tapeName', priceBEM: '0', params: { name: "string? ('<#ID>.<processor>.tape')", processor: 'number?', tokenId: 'string?', block: BLOCK },
    returns: { name: 'string', processor: 'number', tokenId: 'string', circuits: 'address', container: 'address', holder: 'address', opened: 'boolean', tapeapi: 'object|null', channelKeys: 'object|null', ...PINNED },
    description: '[quorum] Resolve a TapeOut name such as 11.1013.tape: processor contract, container, current holder, whether the container is opened, and whether it publishes a TapeAPI manifest or channel keys.' },
]

/**
 * The implementations. `chain` is a reader from createChainReader(); its rpc must answer eth_call with a block object
 * or tag. / 实现。`chain` 是 createChainReader() 的读取器。
 */
export function publicMethods(chain) {
  const rpc = chain.rpc
  // Pin once, read everything at that block, and say which block reference the nodes accepted.
  // 钉一次块，所有读取都在这个块上，并如实说明节点接受的是哪种块参数。
  async function at(block, fn) {
    const pinned = await chain.pinBlock(block)
    const { value, blockRef } = await chain.readAt(pinned, fn)
    return { value, blockPinned: blockPinnedOf(pinned, blockRef) }
  }
  const call = (to, data, blk) => rpc.ethCall(to, data, blk)

  async function readPair(pair, block) {
    addrParam(pair, 'pair')
    let r
    try {
      r = await at(block, async (blk) => {
        const [t0, t1, res] = await Promise.all([
          call(pair, SEL.token0, blk).then((d) => decodeParams(['address'], d)[0]),
          call(pair, SEL.token1, blk).then((d) => decodeParams(['address'], d)[0]),
          call(pair, SEL.getReserves, blk).then((d) => decodeParams(['uint112', 'uint112', 'uint32'], d)),
        ])
        const meta = async (a) => ({
          address: checksumAddress(a),
          symbol: textOf(await call(a, SEL.symbol, blk).catch(() => null)),
          decimals: Number(decodeParams(['uint8'], await call(a, SEL.decimals, blk))[0]),
        })
        return { t0: await meta(t0), t1: await meta(t1), res }
      })
    } catch (e) { if (e.code === 'RPC_ERROR' || e.code === 'ABI_INVALID') bad(`${pair} does not look like a PancakeSwap V2 pair`); throw e }
    const { t0, t1, res: [r0, r1, ts] } = r.value
    if (r0 === 0n || r1 === 0n) bad('the pair has no liquidity')
    const P = 18n
    const p01 = (r1 * 10n ** BigInt(t0.decimals) * 10n ** P) / (r0 * 10n ** BigInt(t1.decimals))
    const p10 = (r0 * 10n ** BigInt(t1.decimals) * 10n ** P) / (r1 * 10n ** BigInt(t0.decimals))
    return {
      pair: checksumAddress(pair), token0: t0, token1: t1,
      reserves: { reserve0: r0.toString(), reserve1: r1.toString(), blockTimestampLast: Number(ts) },
      price: { token0InToken1: formatUnits(p01, Number(P)), token1InToken0: formatUnits(p10, Number(P)) },
      blockPinned: r.blockPinned,
    }
  }

  return {
    blockNumber: async (_params, ctx) => ({ blockNumber: ctx.block }),

    balance: async ({ address, block } = {}) => {
      addrParam(address, 'address')
      const r = await at(block, (blk) => rpc.call('eth_getBalance', [address, blk]))
      const wei = BigInt(r.value)
      return { address: checksumAddress(address), wei: wei.toString(), bnb: formatUnits(wei, 18), blockPinned: r.blockPinned }
    },

    tokenInfo: async ({ token, block } = {}) => {
      addrParam(token, 'token')
      let r
      try {
        r = await at(block, async (blk) => {
          const [decimals, totalSupply, name, symbol] = await Promise.all([
            call(token, SEL.decimals, blk).then((d) => Number(decodeParams(['uint8'], d)[0])),
            call(token, SEL.totalSupply, blk).then((d) => decodeParams(['uint256'], d)[0]),
            call(token, SEL.name, blk).then(textOf, () => null),
            call(token, SEL.symbol, blk).then(textOf, () => null),
          ])
          return { decimals, totalSupply, name, symbol }
        })
      } catch (e) { if (e.code === 'RPC_ERROR' || e.code === 'ABI_INVALID') bad(`${token} does not look like a BEP-20 token`); throw e }
      const v = r.value
      return { token: checksumAddress(token), name: v.name, symbol: v.symbol, decimals: v.decimals, totalSupply: v.totalSupply.toString(), blockPinned: r.blockPinned }
    },

    tokenBalance: async ({ token, address, block } = {}) => {
      addrParam(token, 'token'); addrParam(address, 'address')
      let r
      try {
        r = await at(block, async (blk) => Promise.all([
          call(token, SEL.balanceOf + hexArgs(['address'], [address]), blk).then((d) => decodeParams(['uint256'], d)[0]),
          call(token, SEL.decimals, blk).then((d) => Number(decodeParams(['uint8'], d)[0])),
          call(token, SEL.symbol, blk).then(textOf, () => null),
        ]))
      } catch (e) { if (e.code === 'RPC_ERROR' || e.code === 'ABI_INVALID') bad(`${token} does not look like a BEP-20 token`); throw e }
      const [raw, decimals, symbol] = r.value
      return { token: checksumAddress(token), address: checksumAddress(address), raw: raw.toString(), amount: formatUnits(raw, decimals), symbol, decimals, blockPinned: r.blockPinned }
    },

    nftOwner: async ({ contract, tokenId, block } = {}) => {
      addrParam(contract, 'contract')
      const id = uintString(tokenId, 'tokenId')
      let r
      try { r = await at(block, (blk) => call(contract, SEL.ownerOf + word(id), blk).then((d) => decodeParams(['address'], d)[0])) }
      catch (e) { if (e.code === 'RPC_ERROR' || e.code === 'ABI_INVALID') bad(`token ${id} does not exist on ${contract}, or it is not ERC-721`); throw e }
      return { contract: checksumAddress(contract), tokenId: id.toString(), owner: checksumAddress(r.value), blockPinned: r.blockPinned }
    },

    pairPrice: async ({ pair, block } = {}) => readPair(pair, block),

    bnbUsd: async ({ block } = {}) => {
      const p = await readPair(WBNB_USDT_V2, block)
      const wbnbFirst = eqAddr(p.token0.address, WBNB) && eqAddr(p.token1.address, USDT)
      if (!wbnbFirst && !(eqAddr(p.token1.address, WBNB) && eqAddr(p.token0.address, USDT))) throw Object.assign(new Error('the configured pair is not WBNB/USDT'), { code: 'INTERNAL' })
      return { bnbUsd: wbnbFirst ? p.price.token0InToken1 : p.price.token1InToken0, pair: p.pair, blockPinned: p.blockPinned }
    },

    tapeName: async ({ name, processor, tokenId, block } = {}) => {
      if (name != null) {
        const m = /^(\d{1,15})\.(\d{1,15})\.tape$/i.exec(String(name).trim())
        if (!m) bad("name must look like '<#ID>.<processor>.tape', for example 11.1013.tape")
        tokenId = m[1]; processor = m[2]
      }
      const proc = uintString(processor, 'processor'), id = uintString(tokenId, 'tokenId')
      if (id < 1n) bad('tokenId starts at 1')
      const r = await at(block, async (blk) => {
        let circuits
        try { circuits = decodeParams(['address'], await call(MAINNET.factory, SEL.cpuAt + word(proc), blk))[0] }
        catch (e) { if (e.code === 'RPC_ERROR') bad(`processor ${proc} does not exist`); throw e }
        if (decodeReturn('isCPU', await call(MAINNET.factory, encodeCall('isCPU', [circuits]), blk)) !== true) bad(`${circuits} is not a TapeOut processor`)
        let holder
        try { holder = decodeParams(['address'], await call(circuits, SEL.ownerOf + word(id), blk))[0] }
        catch (e) { if (e.code === 'RPC_ERROR') bad(`circuit #${id} does not exist on processor ${proc}`); throw e }
        const container = decodeReturn('accountOf', await call(MAINNET.hub, encodeCall('accountOf', [circuits, id]), blk))
        const code = await rpc.call('eth_getCode', [container, blk])
        const file = async (path) => {
          const f = decodeReturn('fileInfo', await call(MAINNET.siteRegistry, encodeCall('fileInfo', [container, registryKey(path)]), blk))
          return BigInt(f.size ?? 0) > 0n ? { path: registryKey(path), size: Number(f.size), sha256: f.sha256Hash } : null
        }
        const [tapeapi, channelKeys] = await Promise.all([file('/.well-known/tapeapi.json'), file('/.well-known/tape-channel.json')])
        return { circuits, holder, container, opened: typeof code === 'string' && code !== '0x', tapeapi, channelKeys }
      })
      const v = r.value
      return {
        name: `${id}.${proc}.tape`, processor: Number(proc), tokenId: id.toString(),
        circuits: checksumAddress(v.circuits), container: checksumAddress(v.container), holder: checksumAddress(v.holder),
        opened: v.opened, tapeapi: v.tapeapi, channelKeys: v.channelKeys, blockPinned: r.blockPinned,
      }
    },
  }
}
