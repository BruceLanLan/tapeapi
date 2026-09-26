#!/usr/bin/env node
// TAP-23 Attested Read 示例：对外链（Ethereum、Base）做 quorum eth_call，默认钉 `finalized`，按 blockHash（EIP-1898）读取，签名返回。
// TAP-23 Attested Read example: quorum eth_call on foreign chains (Ethereum, Base), pinned to `finalized` by default,
// evaluated at the attested blockHash (EIP-1898), signed.
import { readFile } from 'node:fs/promises'
import { createProvider } from '@tapeapi/server'
import { sig, abi, formatUnits, TapeAPIError } from '@tapeapi/sdk'
import { createChainReaders, chainReaderOf, bad } from '../_lib/chain.mjs'
import { exampleEnv, applyEnvToManifest, startProvider } from '../_lib/service.mjs'

const here = new URL('.', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('manifest.json', here), 'utf8'))
const chainsCfg = JSON.parse(await readFile(new URL(process.env.CHAINS_FILE || 'chains.json', here), 'utf8'))

// ---- env（provider 自身身份与结算仍在 BSC）/ env (identity & settlement stay on BSC) ----
const env = exampleEnv('attest', { port: 8791 })
const { RPC_URLS, QUORUM, CHAIN_ID, PROD, SIGNER_KEY, log, store } = env
applyEnvToManifest(manifest, env)

// ---- 外链读取器：chainId → reader / one reader per foreign chain, keyed by chainId ----
// 钉块（默认 `finalized`）、按认证的 blockHash 求值、按链命名的错误消息都在 `_lib/chain.mjs` 里，
// `defi-portfolio-read` 用的是同一份。`RPC_<chainId>=url1,url2` 覆盖 chains.json。
// Pinning (default `finalized`), evaluation at the attested blockHash and the per-chain error messages all
// live in `_lib/chain.mjs`, shared with `defi-portfolio-read`. `RPC_<chainId>` overrides chains.json.
const chains = createChainReaders(chainsCfg, { allowSingleNode: !PROD })
// TAP-23 §3.1: the attestedRead descriptor lists exactly the chains this instance serves (chains.json + env).
// TAP-23 §3.1：attestedRead 描述符列出本实例实际服务的链。
manifest.methods.find((m) => m.name === 'read').attestedRead.chains = [...chains.keys()]
const { isAddress, checksumAddress, encodeCall, decodeReturn } = abi
const chainOf = (chainId) => chainReaderOf(chains, chainId)
// TAP-23 §3.3：链与区块的四个字段是顶层扁平字段 / the chain and block fields are flat and top-level.
const attest = (chainId, pinned, blockRef, extra) => ({ chainId, blockNumber: pinned.blockNumber, blockHash: pinned.blockHash, blockRef, ...extra })

const provider = createProvider({
  manifest, signerKey: SIGNER_KEY, rpcUrls: RPC_URLS, quorum: QUORUM, chainId: CHAIN_ID, allowSingleNode: !PROD, log, store,
  methods: {
    // 收费：TAP-23 见证读取 / paid: the TAP-23 Attested Read, params exactly { chainId, call: { to, data }, block? }
    read: async ({ chainId, call, block }) => {
      // §3.1: a chain not listed is METHOD_NOT_FOUND, not BAD_REQUEST / 未列出的链是 METHOD_NOT_FOUND
      if (!Number.isInteger(chainId)) bad('chainId must be an integer')
      if (!chains.has(chainId)) throw new TapeAPIError('METHOD_NOT_FOUND', `chainId ${chainId} is not in attestedRead.chains [${[...chains.keys()].join(', ')}]`)
      const c = chainOf(chainId)
      if (!call || typeof call !== 'object' || Array.isArray(call)) bad('call must be an object { to, data } (TAP-23 §3.2)')
      const { to, data } = call
      if (!isAddress(to)) bad('call.to must be an address')
      if (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data)) bad('call.data must be 0x-prefixed, even-length hex')
      try {
        const { pinned, result, blockRef } = await c.attestedCall(to, data, block)
        // §3.3: exactly these fields; blockRef only when evaluated by number / 恰好这些字段；仅按块号求值时带 blockRef
        return { chainId, blockNumber: pinned.blockNumber, blockHash: pinned.blockHash, ...(blockRef === 'number' ? { blockRef } : {}), result }
      } catch (e) {
        // §3.3: a reverting call is INTERNAL with the revert bytes, which every node agreed on / 回滚：INTERNAL + revert 字节
        if (e?.code === 'RPC_ERROR' && typeof e.rpcData === 'string') throw new TapeAPIError('INTERNAL', 'execution reverted', { data: { revert: e.rpcData } })
        throw e
      }
    },
    // 免费：原生币余额 / free: native balance
    balance: async ({ chainId, address, block }) => {
      const c = chainOf(chainId)
      if (!isAddress(address)) bad('address must be an address')
      const pinned = await c.pinBlock(block)
      const { value, blockRef } = await c.readAt(pinned, (blk) => c.rpc.call('eth_getBalance', [address, blk]))
      const wei = BigInt(value)
      return attest(chainId, pinned, blockRef, { address: checksumAddress(address), wei: wei.toString(), ether: formatUnits(wei, 18) })
    },
    // 免费：ERC-721 ownerOf / free: ERC-721 ownerOf (the "hold an Ethereum NFT to enter a BSC game" gate)
    nftOwner: async ({ chainId, contract, tokenId, block }) => {
      const c = chainOf(chainId)
      if (!isAddress(contract)) bad('contract must be an address')
      if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(String(tokenId))) bad('tokenId must be a decimal or hex string')
      const { pinned, result, blockRef } = await c.attestedCall(contract, encodeCall('ownerOf', [BigInt(tokenId)]), block)
      let owner; try { owner = decodeReturn('ownerOf', result) } catch { bad(`${contract} did not return an address for ownerOf(${tokenId})`) }
      return attest(chainId, pinned, blockRef, { contract: checksumAddress(contract), tokenId: BigInt(tokenId).toString(), owner })
    },
  },
})

await startProvider(provider, env, {
  lines: [...chains].map(([id, c]) =>
    `chain ${String(id).padEnd(6)} ${c.name.padEnd(9)} quorum ${c.quorum} lag ${c.lag}  ${c.urls.map(u => new URL(u).hostname).join(', ')}  (default block: finalized, reads by blockHash)`),
})
