// @tapeapi/sdk 入口 / SDK entry: resolve manifests, call providers, sign vouchers, build txs.
import { sha256 } from '@noble/hashes/sha256'
import { TapeAPIError } from './errors.js'
import { createRpc, readJsonBounded } from './rpc.js'
import {
  encodeCall, decodeReturn, labelToBytes32, isAddress, eqAddr, checksumAddress, ZERO_ADDRESS, hexToBytes, toHex,
  selector, encodeParams, bytesToHex,
} from './abi.js'
import {
  delegationDigest, voucherDigest, voucherTypedData, recoverAddress, signDigest, privateKeyToAddress, channelKeysDigest,
  recoverResponseSigner, randomPrivateKey,
} from './sig.js'
import { validateManifest, findMethod, methodPrice, parseUnits, formatUnits, METHOD_NAME_RE, BEM_DECIMALS, MAX_DELEGATION_S } from './manifest.js'
import { canonicalJSON, safeParseJSON } from './canon.js'
import { validateAIField, MANIFEST_FIELD as AI_FIELD } from './ai.js'
import { CHAIN_IDS, chainById, parseTapeName } from './chains.js'
import { rpcUrlsFor } from './rpc-defaults.js'

// Default nodes per chain and who operates them (quorums count operators, not URLs) / 各链默认节点及其运营方
export { RPC_DEFAULTS, rpcUrlsFor, operatorOf } from './rpc-defaults.js'
// The TapeOut chains (BNB Smart Chain, X Layer, Base) and names with area codes / TapeOut 各链与带区号的名字
export { CHAINS, CHAIN_IDS, HOME_CHAIN_ID, IMPL_SLOT, chainById, chainByArea, chainByKey, parseTapeName, formatTapeName, isNameShaped } from './chains.js'
export { TapeAPIError, createRpc, canonicalJSON, safeParseJSON, validateManifest, parseUnits, formatUnits, labelToBytes32, METHOD_NAME_RE, BEM_DECIMALS }
export * as abi from './abi.js'
export * as sig from './sig.js'
export * as channel from './channel.js'   // TAP-26 real-time private channel / 实时私密通道
import * as channelLib from './channel.js'
export * as group from './group.js'        // TAP-27 private group channels / 私密群聊
// TAP-27 delivery in one call: epoch message to the group room AND invites to each member's inbox room / 一步投递
export { deliverGroupUpdate, checkGroupInvites } from './group-delivery.js'
export * as tapesend from './tapesend.js' // TAP-10 sealed messages, byte-compatible with @tapekit/send / TapeSend 密封消息
export * as webmcp from './webmcp.js'      // expose a service's methods as WebMCP agent tools / 把服务的方法注册为 WebMCP 代理工具
export * as mcp from './mcp.js'            // MCP server core: tools with signed results and receipts / MCP 服务器核心：带签名结果与回执的工具
export * as ai from './ai.js'              // AI usage receipts: format adapters, hashing, prices, verification / AI 用量回执：格式适配器、哈希、价格、核验

// TAP-22 §3.4 贡献比例常量 / contribution constants (basis points).
export const MAX_CONTRIBUTION_BPS = 5000          // contract hard cap / 合约硬上限
export const RECOMMENDED_CONTRIBUTION_BPS = 100   // spec recommendation, not enforced anywhere / 规范建议值，不强制

// 主网默认地址 / Mainnet defaults (DESIGN.md).
export const MAINNET = {
  chainId: 56,
  hub: '0xe61A9C7213a6Aa616C246a2B569e555B417b25ee',
  siteRegistry: '0xd006ffdd5Ae313B17729621A00999cD3C71CE5e6',
  factory: '0x68224F668083c29e9800Be2a646d42d18cedF7e2',   // TapeOut processor factory: isCPU(circuits) / 处理器工厂
  bem: '0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a',
  channelBus: '0x486110c35d9b90a9d6D85c8063A065f9e7b6b707',   // TAP-26 §3.7, deployed 2026-09-26, code checked against the tested build / 已部署，代码与测试构建逐字节一致
}
// Operators (operatorOf): 48 Club, 1RPC (a relay whose upstream is not published), NodeReal (the dataseed). Three by
// name; since 1RPC's upstream is unknown, count on two independent ones. Frames authenticate themselves, so the bus
// reader takes the union of what each node serves; only eth_blockNumber goes through the operator quorum.
// 运营方：48 Club、1RPC（上游未公开的转发）、NodeReal（dataseed）。名义上三家；1RPC 上游不明，按两家独立计。帧自带认证，
// 总线读取取各节点的并集；只有 eth_blockNumber 走按运营方的法定数。
// Nodes for reading ChannelBus (TAP-26 §3.7), which needs eth_getLogs: the dataseed nodes refuse it. Measured
// 2026-09-27: 48 Club and 1RPC serve logs with long history (≥ 500k blocks), the dataseed serves receipts; with these
// three the reader read a real frame 73,700 blocks back. Use a dedicated client: createRpc({ urls: BUS_RPC_URLS,
// quorum: 2, timeoutMs: 15000 }) (1RPC can take several seconds). Keep eth_call reads on your usual node set.
// 读 ChannelBus 用的节点（需要 eth_getLogs，dataseed 拒绝）：48 Club 与 1RPC 提供日志且历史长，dataseed 提供回执；
// 实测用这三个读回了 73,700 个区块前的真实帧。请单独建客户端，timeoutMs 15000。
export const BUS_RPC_URLS = Object.freeze(['https://rpc-bsc.48.club', 'https://1rpc.io/bnb', 'https://bsc-dataseed.bnbchain.org'])
export const MANIFEST_PATH = '/.well-known/tapeapi.json'   // fixed by TAP-20 §3.2; never taken from a directory record
// SiteRegistry keys carry NO leading slash (TapeKit SPEC §6 step 3 strips it; mainnet 4246.0.tape stores `index.html`,
// and `/index.html` answers size 0). Every registry call goes through registryKey(), so the URL form above and the
// bare key are interchangeable for callers. Found 2026-09-21 by the first live mainnet probe (scripts/probe-mainnet.mjs).
// SiteRegistry 的键不带前导斜杠（TapeKit SPEC §6 第 3 步会去掉它；主网 4246.0.tape 存的是 `index.html`，查 `/index.html`
// 得 size 0）。所有注册表调用都经过 registryKey()，因此调用方写 URL 形式或裸键都可以。2026-09-21 首次主网实测发现。
export const MANIFEST_KEY = '.well-known/tapeapi.json'
// TAP-26 §3.1: a container's channel identity, published in its DeWEB site beside the manifest.
// TAP-26 §3.1：容器的通道身份，与清单一起发布在它的 DeWEB 站点里。
export const CHANNEL_KEYS_KEY = '.well-known/tape-channel.json'
export const CHANNEL_KEYS_LIMIT = 4 * 1024
export const CHANNEL_ISSUED_SKEW_S = 300   // a record's `issued` may be this far ahead of our clock / 记录的 issued 至多超前本地时钟这么多
const GROUP_VERIFY_CACHE_S = 300
// Identity cache shared by TAP-26 and TAP-27 (arch B7): at most GROUP_VERIFY_CACHE_S (TAP-27 §3.3 step 6), bounded size.
// TAP-26 与 TAP-27 共用的身份缓存：至多 GROUP_VERIFY_CACHE_S 秒（TAP-27 §3.3 第 6 步），条目数有上限。
export const IDENTITY_CACHE_S = GROUP_VERIFY_CACHE_S
export const IDENTITY_CACHE_SIZE = 1024
export function registryKey(path) {
  if (typeof path !== 'string') throw new TapeAPIError('MANIFEST_INVALID', 'registry path must be a string')
  return path.replace(/^\/+/, '')
}
// TapeOut names (TapeKit SPEC §2.2 / §2.4 and kernel/src/name.js, TAP-20 §3.6 step 1; spec review SD-12). The canonical
// form is `<#ID>.<processor>.tape` on BNB Smart Chain and `<#ID>.<area>.<processor>.tape` on another chain (X Layer area
// 2, Base area 3): decimal, no leading zeros (except a processor `0`), all lowercase, #ID >= 1; the suffix-less form is
// the same name (chains.js). Anything else that looks like a name (leading zeros, `.TAPE`, #ID 0, `#4246@0`, `tape://...`,
// a reserved or unassigned area code) is refused rather than guessed at, and never looked up as a directory label, so a
// label cannot squat a spelling of someone's name. Returns { tokenId, processor, area, chainId, name } or null (not
// name-shaped). / TapeOut 名字。BNB 上为 `<#ID>.<processor>.tape`，其它链为 `<#ID>.<区号>.<processor>.tape`（X Layer 2，
// Base 3）；十进制、无前导零、全小写、#ID >= 1；不带后缀是同一名字。其它看起来像名字的写法（含保留或未分配的区号）一律拒绝
// 而不猜，也绝不当作目录标签查找。不像名字时返回 null。
function tapeName(str) {
  const p = parseTapeName(str)
  if (p === null) return null
  if (p.error) throw new TapeAPIError('MANIFEST_INVALID', p.error)
  return p
}
const ZERO_HASH = '0x' + '00'.repeat(32)                    // TapeKit "no-hash" state: file exists but was never hashed
export const MANIFEST_LIMIT = 64 * 1024        // TAP-20: manifest ≤ 64 KiB
export const ENVELOPE_LIMIT = 1024 * 1024      // TAP-21 §3.2: response body ≤ 1 MiB
// TAP-20 §3.6: clients SHOULD re-read a cached manifest about once an hour. / 客户端 SHOULD 每小时左右重读清单。
export const MANIFEST_TTL_MS = 3600_000
export const DEFAULT_MAX_SKEW_S = 300          // TAP-21 §3.2: reject |now − ts| > 300 s
const now = () => Math.floor(Date.now() / 1000)
// An execution revert: the chain's answer. rpc.js reports every JSON-RPC error all nodes agree on as RPC_ERROR, a
// revert (geth code 3, or "execution reverted" under -32000) and "header not found" alike (review R2-2); it marks
// `rpcRevert` only when EVERY answering node reported a revert, since the message is just the first node's (review R3-4).
// 执行回滚：链的回答。rpc.js 把所有节点一致的 JSON-RPC 错误都报为 RPC_ERROR，回滚与 "header not found" 不分；只有每个作答节点
// 都报回滚时才标 `rpcRevert`，因为消息只是第一个节点的。
const isRevert = (e) => e instanceof TapeAPIError && e.code === 'RPC_ERROR' && (Number(e.rpcCode) === 3 || e.rpcRevert === true)
const uuid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : toHex(crypto.getRandomValues(new Uint8Array(16))).slice(2))

// 选项 / options:
//   rpcUrls, quorum (默认 2)：urls 或其不同运营方（operatorOf）少于 quorum 直接抛 RPC_UNAVAILABLE；只有 allowSingleNode: true
//                        才允许下调（开发用，M-11）。quorum counts operators: URLs of one operator count once.
//   dev: true            允许 resolve({ dev }) 与 http:// 端点；不改变链上来源清单的 holder 校验（M-06）
//   allowHttp: true      非 dev 下也接受 http:// 端点（仅测试）/ accept http endpoints outside dev (tests only)
//   maxSkewS (默认 300)  信封 ts 与本地时钟的最大偏差（TAP-21 §3.2）/ envelope ts freshness window
//   identityCacheS (默认 300，上限 300；0 = 不缓存), identityCacheSize (默认 1024)：通道身份缓存（arch B7）
//                        channel-identity cache for chain.channelKeys and groupVerifier (0 disables; never above 300 s)
//   chains              其它链的节点：{ [chainId]: { rpcUrls, quorum (默认 2), timeoutMs, allowSingleNode } }。解析别的链上的
//                        名字或 { chainId, ... } 时，本客户端为那条链建一个子客户端（api.forChain(chainId)），节点取这里的
//                        rpcUrls，没给就取 SDK 的默认节点 rpcUrlsFor(chainId)（chains.js 与 rpc-defaults.js）。
//                        nodes for the other TapeOut chains. Resolving a name on another chain (1.2.344.tape is X Layer) or a
//                        { chainId, ... } target goes through a client for that chain (api.forChain(chainId)) whose nodes
//                        are chains[chainId].rpcUrls or else the SDK's defaults for it (rpcUrlsFor). Payments stay on BNB
//                        Smart Chain: a priced method of a service on another chain is refused (PAYMENT_REQUIRED).
//   chainId (默认 56), hub, siteRegistry, factory：合约地址，默认为该链在 chains.js 里的地址（56 即 MAINNET）。directory 与 escrow 没有默认值：
//                        不传就没有（主网尚无部署的目录与托管）；付费服务用它自己清单里的 escrow（TAP-22 §3.4）。
//                        contract addresses, mainnet (MAINNET) by default. `directory` and `escrow` have NO default (MAINNET
//                        names neither): without them there is no directory cross-check and no configured escrow; a priced
//                        service is paid through the escrow its own manifest names (TAP-22 §3.4). On any other chain pass `factory` (the TapeOut
//                        processor factory, isCPU) with hub and siteRegistry: the mainnet factory has no code there, and
//                        every identity and manifest read fails with BAD_KEY (review R2-6).
//                        在其它链上须与 hub、siteRegistry 一起传 `factory`（TapeOut 处理器工厂）：主网工厂在那里没有代码，
//                        每次身份与清单读取都会以 BAD_KEY 失败。
export function createTapeAPI(opts = {}) {
  const chainId = opts.chainId ?? MAINNET.chainId
  // A chain chains.js knows brings its own addresses; any other chain falls back to MAINNET's (and then needs opts.factory,
  // review R2-6). / chains.js 认识的链用它自己的地址；其它链退回 MAINNET 的地址（此时须传 opts.factory）。
  const known = chainById(chainId)
  const hub = opts.hub ?? known?.hub ?? MAINNET.hub
  const factory = opts.factory ?? known?.factory ?? MAINNET.factory
  const siteRegistry = opts.siteRegistry ?? known?.siteRegistry ?? MAINNET.siteRegistry
  const { directory, escrow } = opts
  const fetchImpl = opts.fetch || globalThis.fetch?.bind(globalThis)
  const devMode = opts.dev === true
  const allowHttp = devMode || opts.allowHttp === true
  const maxSkewS = Number.isFinite(opts.maxSkewS) ? Number(opts.maxSkewS) : DEFAULT_MAX_SKEW_S
  const rpc = (opts.rpcUrls && opts.rpcUrls.length)
    ? createRpc({ urls: opts.rpcUrls, quorum: opts.quorum ?? 2, timeoutMs: opts.timeoutMs, fetch: fetchImpl, allowSingleNode: opts.allowSingleNode === true })
    : null
  // Highest `issued` seen per container's channel record (arch B4). Pass a persistent Map-like { get, set } to keep it
  // across restarts. / 每个容器通道记录见过的最高 `issued`；传入持久化的 { get, set } 可跨重启保留。
  const recordFloor = opts.channelRecordFloor ?? new Map()
  const identityTtlS = Math.min(IDENTITY_CACHE_S, Math.max(0, Number.isFinite(opts.identityCacheS) ? Math.floor(opts.identityCacheS) : IDENTITY_CACHE_S))
  const identityMax = Number.isInteger(opts.identityCacheSize) && opts.identityCacheSize > 0 ? opts.identityCacheSize : IDENTITY_CACHE_SIZE
  const needRpc = () => { if (!rpc) throw new TapeAPIError('RPC_UNAVAILABLE', 'rpcUrls not configured'); return rpc }
  const needDirectory = () => { if (!isAddress(directory)) throw new TapeAPIError('MANIFEST_INVALID', 'directory address not configured'); return directory }
  const needFetch = () => { if (typeof fetchImpl !== 'function') throw new TapeAPIError('PROVIDER_UNAVAILABLE', 'no fetch implementation'); return fetchImpl }

  // ---- 链读 / chain reads ----
  async function view(to, name, args) { return decodeReturn(name, await needRpc().ethCall(to, encodeCall(name, args))) }
  const readTarget = (p) => {
    if (!(p && typeof p === 'object' && p.manifest)) return { to: escrow, provider: p }
    const to = p.manifest.payment?.escrow
    if (!isAddress(to) || /^0x0{40}$/i.test(to)) throw new TapeAPIError('MANIFEST_INVALID', `${p.container} names no escrow: it takes no payment`)
    return { to, provider: p.container }
  }
  const chain = {
    accountOf: (circuits, tokenId) => view(hub, 'accountOf', [circuits, BigInt(tokenId)]),
    /** Processor contract number `processor` (the number in <#ID>.<processor>.tape); NOT_FOUND past the last one.
     *  处理器编号对应的合约；超出范围为 NOT_FOUND。 */
    cpuAt: async (processor) => {
      try { return await view(factory, 'cpuAt', [BigInt(processor)]) }
      catch (e) { if (e.code === 'RPC_ERROR' && /revert/i.test(e.message)) throw new TapeAPIError('NOT_FOUND', `processor ${processor} does not exist`); throw e }
    },
    /** TapeKit SPEC §3.3 step 2: only a factory-deployed processor is TapeOut. true is cached for good (the processor
     *  list is append-only); false is not. / 只有工厂部署的处理器才是 TapeOut。true 永久缓存（列表只增不删），false 不缓存。 */
    isCPU: async (circuits) => {
      const k = String(circuits).toLowerCase()
      if (knownCPUs.has(k)) return true
      // '0x' is what a node answers for an address with no code: a factory missing on this chain (the mainnet
      // default on chain ≠ 56) is a configuration error, never a verdict about the circuit (review R2-6).
      // 对没有代码的地址节点答 '0x'：本链上没有该工厂（例如在非 56 链上用了主网默认值）是配置错误，而不是对电路的判定。
      const raw = await needRpc().ethCall(factory, encodeCall('isCPU', [circuits]))
      if (typeof raw === 'string' && /^0x$/i.test(raw)) throw new TapeAPIError('BAD_KEY', `factory ${factory} has no code on chain ${chainId}; pass opts.factory (the TapeOut processor factory of this chain)`)
      const yes = decodeReturn('isCPU', raw) === true
      if (yes && knownCPUs.size < 4096) knownCPUs.add(k)
      return yes
    },
    /**
     * TAP-26 §3.1: a container's channel identity (X25519 for handshakes, Ed25519 for TAP-27 group messages), read
     * from `.well-known/tape-channel.json` with the same on-chain byte check as a manifest and accepted only while the
     * CURRENT holder of the circuit authorised it (ECDSA, or EIP-1271 for a contract holder). A circuit that changes
     * hands therefore drops its old channel identity by itself.
     * 容器的通道身份，从 `.well-known/tape-channel.json` 读取（与清单同样做链上字节校验），且仅当电路的**当前**持有人
     * 授权过它时才接受（ECDSA，合约持有人用 EIP-1271）。电路转手后旧的通道身份自动失效。
     *
     * Cached for at most 300 s, shared with groupVerifier (arch B7): a sealed invite is free to post, so a forged one
     * naming the same `from` again costs no chain reads, and concurrent lookups share one read. A definitive "no"
     * (CHANNEL_INVALID, NOT_FOUND) is cached too; an RPC failure never is. `{ fresh: true }` reads the chain now and
     * refreshes the cache. "Drops by itself" therefore takes effect within the cache window.
     * 最多缓存 300 秒，与 groupVerifier 共用：密封邀请发送免费，反复用同一 `from` 伪造的邀请不再触发链上读取，并发查询
     * 共享一次读取。确定的"否"（CHANNEL_INVALID、NOT_FOUND）也缓存；RPC 故障绝不缓存。`{ fresh: true }` 立即读链并刷新缓存。
     * 因此"自动失效"在缓存窗口内生效。
     */
    channelKeys: (container, { fresh = false } = {}) => {
      if (!isAddress(container)) return Promise.reject(new TapeAPIError('CHANNEL_INVALID', 'channelKeys takes a container address'))
      return identities.lookup(container, { fresh })
    },
    // TAP-26 §3.1 fallback: a container's TapeSend (TAP-10) X25519 key. The hub withholds it unless the holder who
    // published it still holds the circuit; we still re-derive the container and check the endpoint, suite and flag.
    // TAP-26 §3.1 备用：容器的 TapeSend 密钥。只要发布者已不再持有电路，hub 就不返回它；我们仍核对端点、套件与可用标志。
    tapeSendKey: async (target) => {
      let circuits, tokenId, expect = null
      if (typeof target === 'string') {
        if (!isAddress(target)) throw new TapeAPIError('CHANNEL_INVALID', 'tapeSendKey takes a container address or { circuits, tokenId }')
        expect = target
        // tokenOf: an outage is an error, not NOT_FOUND (review R2-2) / 故障是错误，不是 NOT_FOUND
        ;({ circuits, tokenId } = await tokenOf(target))
      } else if (target && isAddress(target.circuits) && target.tokenId != null) {
        circuits = target.circuits; tokenId = BigInt(target.tokenId)
      } else throw new TapeAPIError('CHANNEL_INVALID', 'tapeSendKey takes a container address or { circuits, tokenId }')
      await requireCPU(circuits, 'CHANNEL_INVALID')
      const [container, endpoint, opened, current, suite, keyIndex, key, usable, version, chains] = await view(hub, 'keyFor', [circuits, tokenId])
      if (expect && !eqAddr(container, expect)) throw new TapeAPIError('CHANNEL_INVALID', `hub derives ${container} for (${circuits}, ${tokenId}), not ${expect}`)
      const want = '0x' + '00'.repeat(4) + BigInt(chainId).toString(16).padStart(16, '0') + container.slice(2).toLowerCase()
      if (String(endpoint).toLowerCase() !== want) throw new TapeAPIError('CHANNEL_INVALID', `hub returned endpoint ${endpoint}, expected ${want}`)
      if (!usable) throw new TapeAPIError('NOT_FOUND', `${container} has no usable TapeSend key (never published, revoked, or the circuit changed hands since)`)
      if (Number(suite) !== 1) throw new TapeAPIError('CHANNEL_INVALID', `unsupported key suite ${suite}; TAP-26 needs suite 1 (X25519)`)
      return {
        container: checksumAddress(container), chainId, circuits: checksumAddress(circuits), tokenId: tokenId.toString(),
        staticPublic: String(key).toLowerCase(), keyIndex: Number(keyIndex), version: Number(version),
        holder: checksumAddress(current), opened: !!opened, chainsBitmap: BigInt(chains).toString(2),
      }
    },
    ownerOf: (circuits, tokenId) => view(circuits, 'ownerOf', [BigInt(tokenId)]),
    /** ERC-6551 token() of a container on this chain: { circuits, tokenId }. NOT_FOUND when it is no container here,
     *  CHANNEL_INVALID when it names another chain. / 容器在本链上的 token()；不是本链容器时为 NOT_FOUND 或 CHANNEL_INVALID。 */
    tokenOf: (container) => tokenOf(container),
    resolve: (label) => view(needDirectory(), 'resolve', [labelToBytes32(label)]),
    serviceOf: (container) => view(needDirectory(), 'serviceOf', [container]),
    readFile: (container, path) => view(siteRegistry, 'read', [container, registryKey(path)]),
    fileInfo: (container, path) => view(siteRegistry, 'fileInfo', [container, registryKey(path)]),
    // v2 escrow reads are per (consumer, provider) channel; `channelOf` is the pre-flight figure (it is the cap).
    // v2 托管的读取按 (消费者, 提供者) 通道进行；预检看 `channelOf`（它就是上限）。
    escrow: {
      // `p` may be a provider address (configured escrow) or a resolved service (its own escrow, TAP-22 §3.4)
      // `p` 可以是提供者地址（用配置的托管）或已解析的服务（用它自己的托管）
      channelOf: (c, p) => { const t = readTarget(p); return view(t.to, 'channelOf', [c, t.provider]) },
      claimedOf: (c, p) => { const t = readTarget(p); return view(t.to, 'claimedOf', [c, t.provider]) },
      sessionExpiry: (c, p, k) => { const t = readTarget(p); return view(t.to, 'sessionExpiry', [c, t.provider, k]) },
      pendingWithdraw: (c, p) => { const t = readTarget(p); return view(t.to, 'pendingWithdraw', [c, t.provider]) },
      // 服务可自选 escrow，故允许覆盖地址 / a service picks its own escrow, so the address may be overridden
      contributionOf: (p, esc = escrow) => view(esc, 'contributionOf', [p]),
      treasury: (esc = escrow) => view(esc, 'treasury', []),
    },
  }

  // TAP-26 §3.1 channel record, read from the chain every time: no cache here (the cache is `identities`, below).
  // 从链上读取通道记录，每次都读：这里不缓存（缓存在下面的 `identities`）。
  async function readChannelKeys(container) {
    const { circuits, tokenId } = await tokenOf(container)
    // The container's own token() is only a claim: the hub must derive this very address from that circuit, as
    // the manifest path checks (TAP-20 §3.6). / 容器自己的 token() 只是声称；中枢必须由该电路推导出同一地址。
    const derived = await chain.accountOf(circuits, tokenId)
    if (!eqAddr(derived, container)) throw new TapeAPIError('CHANNEL_INVALID', `hub.accountOf(${circuits}, ${tokenId}) is ${derived}, not ${container}`)
    await requireCPU(circuits, 'CHANNEL_INVALID')
    const file = await readVerifiedFile(container, CHANNEL_KEYS_KEY, { limit: CHANNEL_KEYS_LIMIT, code: 'CHANNEL_INVALID' })
    let r
    try { r = safeParseJSON(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes), { code: 'CHANNEL_INVALID' }) }
    catch (e) { throw new TapeAPIError('CHANNEL_INVALID', `${CHANNEL_KEYS_KEY}: ${e.message}`) }
    const bad = (m) => { throw new TapeAPIError('CHANNEL_INVALID', `${CHANNEL_KEYS_KEY} of ${container}: ${m}`) }
    if (!r || typeof r !== 'object' || r.tapechannel !== '1') bad('tapechannel must be "1"')
    if (!eqAddr(r.container, container)) bad(`names container ${r.container}`)
    if (r.chainId !== chainId) bad(`is for chain ${r.chainId}, not ${chainId}`)
    // "0x<64 hex>" (TAP-26 §3.1): fromHex also takes bare hex, and a bare key would be accepted here yet never equal
    // a roster entry, so the member would be dropped as a mismatch (review R2 N2).
    // fromHex 也接受不带 0x 的十六进制；这样的密钥在此会被接受，却永远不等于名单条目，成员会被当作不符而移除。
    for (const k of ['x25519', 'ed25519']) if (typeof r[k] !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(r[k])) bad(`${k} must be "0x" and 64 hex digits`)
    try { channelLib.assertUsablePublicKey(channelLib.fromHex(r.x25519, 32, 'x25519'), 'x25519') } catch (e) { bad(e.message) }
    try { channelLib.assertEd25519Public(r.ed25519, 'ed25519') } catch (e) { bad(e.message) }
    if (!Number.isInteger(r.issued) || r.issued < 0) bad('issued must be unix seconds')
    if (r.issued > now() + CHANNEL_ISSUED_SKEW_S) bad('issued is in the future')
    if (!Number.isInteger(r.expires) || r.expires <= now()) bad('expired')
    if (r.expires <= r.issued) bad('expires before it was issued')
    if (r.expires > now() + MAX_DELEGATION_S) bad('expires more than 366 days ahead')
    // 65 bytes for an ECDSA holder; a contract holder's EIP-1271 signature may be longer (a multi-owner Safe)
    // ECDSA 持有人为 65 字节；合约持有人的 EIP-1271 签名可以更长（多签 Safe）
    if (typeof r.sig !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){65,1024}$/.test(r.sig)) bad('sig must be a signature of 65 to 1024 bytes')
    const inbox = r.inbox ?? {}
    try { channelLib.checkRelays(inbox.relays ?? []); channelLib.checkBus(inbox.bus) } catch (e) { bad(`inbox: ${e.message}`) }
    const digest = channelKeysDigest(chainId, hub, { container, x25519: r.x25519, ed25519: r.ed25519, inbox, issued: r.issued, expires: r.expires })
    let recovered = null
    if (r.sig.length === 132) { try { recovered = recoverAddress(digest, r.sig) } catch { /* a contract holder signs no ECDSA / 合约持有人没有 ECDSA 签名 */ } }
    const holder = await chain.ownerOf(circuits, tokenId)
    if (!(recovered && eqAddr(recovered, holder)) && !(await holderApproves(holder, digest, r.sig))) {
      throw new TapeAPIError('CHANNEL_INVALID', `${container}: channel keys were not authorised by the current holder ${holder}`)
    }
    // Only an authorised record moves the floor, and never down. / 只有已授权的记录能抬高下限，且绝不降低。
    const floorKey = container.toLowerCase()
    const floor = (await recordFloor.get(floorKey)) ?? 0
    if (r.issued < floor) bad(`issued ${r.issued} is older than a record already seen (${floor}): a replaced record was put back`)
    if (r.issued > floor) await recordFloor.set(floorKey, r.issued)
    return {
      container: checksumAddress(container), chainId, circuits: checksumAddress(circuits), tokenId: tokenId.toString(),
      staticPublic: r.x25519.toLowerCase(), x25519: r.x25519.toLowerCase(), ed25519: r.ed25519.toLowerCase(), issued: r.issued, expires: r.expires,
      holder: checksumAddress(holder), keys: channelLib.KEYS_CHANNEL,
      inbox: { room: channelLib.inboxRoom(container, chainId), relays: inbox.relays ?? [], ...(inbox.bus ? { bus: inbox.bus } : {}) },
    }
  }

  // Identity resolver shared by TAP-26 (invite.from, invite.owner) and TAP-27 (groupVerifier) (arch B7). Keyed by the
  // lowercase container; entries live at most identityTtlS and the oldest go first once identityMax is reached.
  // Positive entries hold the record; negative ones only a definitive CHANNEL_INVALID / NOT_FOUND. RPC_UNAVAILABLE,
  // RPC_DISAGREE, RPC_ERROR and the rest propagate and change nothing (fixed-test G-05b). A lookup already in flight
  // is shared, also by a `fresh` caller: it is a chain read under way, not a cached answer. A cached record below the container's
  // `issued` floor (another client sharing channelRecordFloor saw a newer one) is a miss, so the cache never lets an
  // older record back in (arch B4); the floor itself only moves in readChannelKeys.
  // TAP-26 与 TAP-27 共用的身份解析。按小写容器地址为键；条目最多存活 identityTtlS 秒，满 identityMax 条先淘汰最旧的。
  // 正缓存存记录；负缓存只存确定的 CHANNEL_INVALID / NOT_FOUND。RPC 类错误原样抛出、不改缓存。进行中的查询被共享，
  // `fresh` 调用也共享（那是正在进行的链上读取，不是缓存的回答）。低于该容器 `issued` 下限的缓存记录（共用下限的另一客户端见过更新的）
  // 视为未命中，缓存绝不让旧记录回来；下限只在 readChannelKeys 里移动。
  const identities = (() => {
    const cache = new Map()      // key -> { at, rec } | { at, err: { code, message } }, oldest first / 旧的在前
    const inflight = new Map()   // key -> Promise
    const copy = (rec) => ({ ...rec, inbox: { ...rec.inbox, relays: rec.inbox.relays.map((r) => ({ ...r })) } })
    const put = (key, entry) => {
      if (identityTtlS === 0) return
      cache.delete(key); cache.set(key, entry)
      while (cache.size > identityMax) cache.delete(cache.keys().next().value)
    }
    async function hit(key) {
      const e = cache.get(key)
      if (!e) return null
      if (e.at + identityTtlS <= now()) { cache.delete(key); return null }
      if (e.rec && e.rec.issued < ((await recordFloor.get(key)) ?? 0)) { cache.delete(key); return null }
      return e
    }
    function read(container, key) {
      let p = inflight.get(key)
      if (p) return p
      p = (async () => {
        try {
          const rec = await readChannelKeys(container)
          put(key, { at: now(), rec })
          return rec
        } catch (e) {
          if (e instanceof TapeAPIError && (e.code === 'CHANNEL_INVALID' || e.code === 'NOT_FOUND')) put(key, { at: now(), err: { code: e.code, message: e.message } })
          throw e
        } finally { inflight.delete(key) }
      })()
      inflight.set(key, p)
      return p
    }
    return {
      async lookup(container, { fresh = false } = {}) {
        const key = container.toLowerCase()
        const e = fresh ? null : await hit(key)
        if (e?.err) throw new TapeAPIError(e.err.code, e.err.message)
        return copy(e ? e.rec : await read(container, key))
      },
      get size() { return cache.size },
    }
  })()

  // accountOf derives an account for ANY ERC-721, so a counterfeit token contract would otherwise pass as a TapeOut
  // circuit, for free and by the thousand (TAP-20 §3.6 step 3, TAP-26 §3.1; found 2026-09-24).
  // accountOf 对任何 ERC-721 都能推导账户，否则仿冒的代币合约就能免费、成批地冒充 TapeOut 电路。
  const knownCPUs = new Set()
  async function requireCPU(circuits, code) {
    if (!(await chain.isCPU(circuits))) throw new TapeAPIError(code, `${circuits} is not a TapeOut processor (factory.isCPU is false)`)
  }

  // An ERC-6551 container knows which circuit it belongs to / ERC-6551 容器知道自己属于哪个电路
  async function tokenOf(container) {
    let tok
    try { tok = await view(container, 'token', []) }
    catch (e) {
      // Only an answer means "not a container": a revert or an empty/garbled return, as from an EOA (ABI_INVALID).
      // An unreachable node is not an answer: rethrow it, or a group owner would drop every member during an RPC
      // outage (fixed-test G-05b). Nor is any other JSON-RPC error every node returns ("header not found"): RPC_ERROR
      // covers both, so only an execution revert counts (review R2-2); NOT_FOUND is cached for minutes.
      // 只有"回答"才意味着不是容器：回滚，或 EOA 那样的空/乱码返回。节点不可达不是回答：原样抛出，否则 RPC 故障期间
      // 群主会把所有成员移除。所有节点都返回的其它 JSON-RPC 错误（"header not found"）也不是：RPC_ERROR 两者都含，
      // 只有执行回滚才算；NOT_FOUND 会被缓存数分钟。
      if (isRevert(e) || (e instanceof TapeAPIError && e.code === 'ABI_INVALID')) throw new TapeAPIError('NOT_FOUND', `${container} does not answer ERC-6551 token(): not a TapeOut container`)
      throw e
    }
    const [cid, circuits, tid] = tok
    if (BigInt(cid) !== BigInt(chainId)) throw new TapeAPIError('CHANNEL_INVALID', `container ${container} belongs to chain ${cid}, not ${chainId}`)
    return { circuits, tokenId: BigInt(tid) }
  }

  // 读取提供者自设贡献比例（万分比）。escrow 无此函数（v0.1 部署或替代实现）→ 0；其它 RPC 故障照常抛出。
  // Provider-set contribution in bps. 0 when the escrow lacks contributionOf (v0.1 / alternative deployments,
  // the call reverts or returns nothing); genuine RPC failures still propagate.
  async function readContribution(m) {
    if (!isAddress(m.payment?.escrow)) return 0   // 免费服务无托管合约 / free service, no escrow
    try { return Number(await chain.escrow.contributionOf(m.container, m.payment.escrow)) }
    // only a revert or an empty return: "header not found" on every node is not "no contributionOf" (review R3-3)
    // 只有回滚或空返回才算：每个节点都答 "header not found" 不等于"没有 contributionOf"
    catch (e) { if (isRevert(e) || (e instanceof TapeAPIError && e.code === 'ABI_INVALID')) return 0; throw e }
  }

  // TAP-20 §3.2 / §3.6 step 2: fileInfo → read (each under RPC quorum), then the bytes MUST match the declared
  // length and SHA-256. Quorum only proves the nodes agree; this proves the SiteRegistry's chunk assembly agrees
  // with its own index — a truncated or mis-assembled file is returned identically by every honest node.
  // 先 fileInfo 再 read（各自过 quorum），字节必须与声明的长度和 SHA-256 一致。quorum 只证明节点一致，这一步证明
  // SiteRegistry 拼出来的文件与它自己的索引一致——拼装错误或截断的文件会被每个诚实节点原样返回。
  async function readVerifiedFile(container, path, { limit = MANIFEST_LIMIT, code = 'MANIFEST_INVALID' } = {}) {
    const info = await chain.fileInfo(container, path)
    const size = Number(info.size)
    if (size === 0) throw new TapeAPIError(code, `no file at ${path} for ${container} (fileInfo.size = 0)`)
    if (size > limit) throw new TapeAPIError(code, `${path} declares ${size} bytes, limit is ${limit}`)
    if (typeof info.sha256Hash !== 'string' || info.sha256Hash.toLowerCase() === ZERO_HASH) {
      throw new TapeAPIError(code, `${path} has no on-chain SHA-256 (fileInfo.sha256Hash is zero): file is unverified`)
    }
    // Mainnet SiteRegistry (verified 2026-09-21): fileInfo on a missing file returns zeros, read() on one REVERTS
    // (custom error 0x2a9df442). A revert here means "no such file", i.e. no manifest: MANIFEST_INVALID, not RPC_ERROR.
    // 主网 SiteRegistry（2026-09-21 实测）：缺失文件 fileInfo 返回全零，read() 则回滚（自定义错误 0x2a9df442）。
    // 这里的回滚意味着"没有这个文件"，即没有清单：报 MANIFEST_INVALID 而不是 RPC_ERROR。
    let raw
    try { raw = hexToBytes(await chain.readFile(container, path)) }
    // Only a revert: any other JSON-RPC error ("header not found" on every node) would be cached as a CHANNEL_INVALID
    // verdict and drop a group member (review R3-3). / 只认回滚：其它 JSON-RPC 错误若变成 CHANNEL_INVALID 会被缓存并让成员被移出群。
    catch (e) { if (isRevert(e)) throw new TapeAPIError(code, `read(${path}) reverted for ${container}: ${e.message}`); throw e }
    if (raw.length !== size) throw new TapeAPIError(code, `${path}: read ${raw.length} bytes, fileInfo.size declares ${size}`)
    const digest = toHex(sha256(raw))
    if (digest !== info.sha256Hash.toLowerCase()) throw new TapeAPIError(code, `${path}: sha256 of bytes is ${digest}, fileInfo.sha256Hash declares ${info.sha256Hash}`)
    return { bytes: raw, size, sha256Hash: digest, contentType: info.contentType, updatedAt: info.updatedAt }
  }

  // Manifest straight from the SiteRegistry at the TAP-20 fixed path. No directory is involved: a free service
  // is resolvable with zero TapeAPI contracts deployed. When a directory IS configured, its record is used only as
  // an optional cross-check (a hint, TAP-20 §3.5); an unregistered container, or a directory whose serviceOf
  // reverts, never blocks resolution.
  // 清单直接从 SiteRegistry 的固定路径读取，不经过目录：免费服务在零个 TapeAPI 合约部署时即可解析。配置了目录时，
  // 其记录只作可选交叉校验（TAP-20 §3.5 的"提示"）；未注册的容器或 serviceOf 回滚的目录都不会阻塞解析。
  async function manifestFromContainer(container) {
    const file = await readVerifiedFile(container, MANIFEST_PATH)
    const m = safeParseJSON(new TextDecoder().decode(file.bytes), { code: 'MANIFEST_INVALID' })
    let service = null
    if (isAddress(directory)) {
      try {
        const rec = await chain.serviceOf(container)
        if (!eqAddr(rec.container, ZERO_ADDRESS)) service = rec
      } catch (e) {
        // A directory that reverts or returns garbage is a broken hint, not a broken service / 目录坏了只是提示坏了
        // A failing node is not a broken directory: skipping the cross-check then would be failing open (review R3-3).
        // 节点故障不等于目录坏了：此时跳过交叉校验等于放行。
        if (!(isRevert(e) || (e instanceof TapeAPIError && e.code === 'ABI_INVALID'))) throw e
      }
    }
    return { manifest: m, container: checksumAddress(container), service, file: { size: file.size, sha256Hash: file.sha256Hash, updatedAt: file.updatedAt } }
  }
  // 只有 createTapeAPI({ dev: true }) 才能走到这里（M-06）/ reachable only with createTapeAPI({ dev: true }) (review M-06)
  async function manifestFromDev(dev) {
    if (!devMode) throw new TapeAPIError('MANIFEST_INVALID', 'dev resolve disabled: createTapeAPI({ dev: true }) is required to resolve { dev } targets')
    if (dev && typeof dev === 'object') return { manifest: dev, container: null, dev: true }
    if (typeof dev !== 'string') throw new TapeAPIError('MANIFEST_INVALID', 'dev must be manifest object or url')
    let url = dev.replace(/\/+$/, '')
    if (!/\.json$/i.test(url)) url += MANIFEST_PATH
    let host; try { host = new URL(url).hostname } catch { throw new TapeAPIError('MANIFEST_INVALID', 'dev url is not a valid URL') }
    // A wrong port or a dead host must surface as a TapeAPIError like every other failure; a raw
    // `TypeError: fetch failed` escapes the `instanceof TapeAPIError` handling the docs teach.
    // 端口写错或主机没起，必须和其它失败一样是 TapeAPIError；原生 `TypeError: fetch failed` 会穿过
    // 文档教的 `instanceof TapeAPIError` 处理。（冷启动测试 2026-09-21 发现）
    let res
    try { res = await needFetch()(url, { headers: { accept: 'application/json' } }) }
    catch (e) { throw new TapeAPIError('PROVIDER_UNAVAILABLE', `cannot reach the dev manifest at ${url}: ${e.message}`) }
    if (!res.ok) throw new TapeAPIError('MANIFEST_INVALID', `fetch dev manifest from ${host}: http ${res.status}`)
    return { manifest: await readJsonBounded(res, MANIFEST_LIMIT, { code: 'MANIFEST_INVALID' }), container: null, dev: true }
  }

  // 校验委托：恢复签名者并对比链上 holder / Verify delegation: recover signer, compare with on-chain holder.
  // dev 只在没有配置 RPC 时才跳过 holder 比对；配置了 rpcUrls 的 dev 客户端照样读 ownerOf（M-06b）。
  // Dev mode skips the holder comparison only when no RPC is configured; a dev client with rpcUrls still reads ownerOf.
  async function verifyDelegation(m, { dev }) {
    if (!m.delegation) {
      if (dev) return { delegation: false, holder: null, dev: true }
      throw new TapeAPIError('DELEGATION_INVALID', 'delegation missing')
    }
    // TAP-20 §3.6 step 4 BEFORE step 5 (spec review SD-3): a burned circuit is MANIFEST_INVALID whatever its
    // delegation looks like, so every client reports the same code. ownerOf reverting (no such token) is
    // MANIFEST_INVALID; an RPC outage stays what it is.
    // 先做第 4 步再做第 5 步：已销毁的电路无论委托如何都是 MANIFEST_INVALID，各客户端报同一个错误码。
    // ownerOf 回滚（没有这个 token）是 MANIFEST_INVALID；RPC 故障保持原样。
    const checkHolder = !(dev && !rpc)
    let holder
    if (checkHolder) {
      try { holder = await chain.ownerOf(m.circuits, m.tokenId) } catch (e) {
        if (isRevert(e)) throw new TapeAPIError('MANIFEST_INVALID', `ownerOf(${m.circuits}, ${m.tokenId}) reverted: the manifest names a circuit that does not exist`)
        throw e
      }
    }
    if (m.delegation.expires <= now()) throw new TapeAPIError('DELEGATION_INVALID', 'delegation expired')
    // TAP-20 §3.4 (client SHOULD): a delegation more than 366 days out is refused / 超过 366 天的委托拒绝
    if (m.delegation.expires > now() + MAX_DELEGATION_S) throw new TapeAPIError('DELEGATION_INVALID', 'delegation.expires is more than 366 days ahead')
    const dir = hub   // 委托锚定在中枢，无需部署目录 / delegation is anchored on the hub; no directory needed
    const digest = delegationDigest(chainId, dir, { container: m.container, signer: m.signer, expires: m.delegation.expires })
    // A 65-byte sig is ECDSA and must recover (a malformed one is refused before EIP-1271, as before). A longer one
    // can only be a contract holder's EIP-1271 signature (TAP-20 §3.3/§3.4, spec review SD-4): no ECDSA recovery.
    // 65 字节的签名是 ECDSA，必须能恢复（格式错误的在尝试 EIP-1271 前就拒绝，与以前相同）。更长的只能是合约持有人的
    // EIP-1271 签名：不做 ECDSA 恢复。
    const ecdsa = m.delegation.sig.length === 132
    let recovered = null
    if (ecdsa) {
      try { recovered = recoverAddress(digest, m.delegation.sig) } catch (e) { throw new TapeAPIError('DELEGATION_INVALID', `bad delegation signature: ${e.message}`) }
    }
    if (!checkHolder) {
      if (!ecdsa) throw new TapeAPIError('DELEGATION_INVALID', 'a delegation signed under EIP-1271 can only be checked on chain: configure rpcUrls')
      return { delegation: true, holder: recovered, dev: true, checked: false }
    }
    if (!(recovered && eqAddr(holder, recovered)) && !(await holderApproves(holder, digest, m.delegation.sig))) {
      throw new TapeAPIError('DELEGATION_INVALID', recovered ? `delegation signed by ${recovered}, holder is ${holder}` : `holder ${holder} does not accept this delegation signature under EIP-1271`)
    }
    return dev ? { delegation: true, holder: checksumAddress(holder), dev: true, checked: true } : { delegation: true, holder: checksumAddress(holder) }
  }

  // A holder that is a contract (a Safe or any smart account) cannot produce an ECDSA signature: ask it whether it
  // accepts this one (EIP-1271). An account with no code, or one that says no, falls through to the ECDSA result.
  // 持有人是合约（Safe 或任何智能账户）时无法产生 ECDSA 签名：按 EIP-1271 询问它是否认可该签名。
  // Only a revert or a garbled return from isValidSignature is "does not approve". An RPC failure (RPC_UNAVAILABLE,
  // RPC_DISAGREE, a non-revert RPC_ERROR), here or from eth_getCode, propagates: as CHANNEL_INVALID it would be cached
  // and would get a Safe-held member dropped from a group during an outage (review R2-2).
  // 只有 isValidSignature 回滚或返回乱码才算"不认可"。RPC 故障（此处或 eth_getCode 的）原样抛出：若变成 CHANNEL_INVALID，
  // 会被缓存，且会让 Safe 持有的成员在故障期间被移出群。
  const EIP1271_MAGIC = '0x1626ba7e'
  async function holderApproves(holder, digest, sig) {
    if (!rpc) return false
    if ((await rpc.call('eth_getCode', [holder, 'latest'])) === '0x') return false
    const data = selector('isValidSignature(bytes32,bytes)') + bytesToHex(encodeParams(['bytes32', 'bytes'], [toHex(digest), sig]))
    let out
    try { out = String(await rpc.ethCall(holder, data)).toLowerCase() }
    catch (e) { if (isRevert(e) || (e instanceof TapeAPIError && e.code === 'ABI_INVALID')) return false; throw e }
    // the whole first word, as OpenZeppelin's SignatureChecker reads it: a contract that echoes its calldata
    // starts with the magic too (review M-2) / 核对完整的第一个字：回显调用数据的合约开头同样是魔数
    return out.length >= 66 && out.slice(0, 66) === EIP1271_MAGIC + '0'.repeat(56)
  }

  // ---- other chains / 其它链 ----
  // One client per TapeOut chain, made on first use. A sub-client routes every other chain back through the client that
  // made it (`_router`), so one createTapeAPI() instance has at most one client per chain. Each keeps its own caches
  // (processor list, identities, accepted prices): the same processor address exists on X Layer and on Base
  // (0x839bdD6f… is processor 0 on both), so nothing keyed by an address may be shared across chains.
  // 每条 TapeOut 链一个客户端，首次用到时创建；子客户端把其它链交回创建它的客户端，所以一个实例每条链至多一个客户端。
  // 各自保留缓存（处理器列表、身份、已同意的价格）：同一个处理器地址在 X Layer 与 Base 上都存在，按地址的缓存绝不能跨链共用。
  const subClients = new Map()
  function forChain(id) {
    const n = Number(id)
    if (n === Number(chainId)) return api
    if (typeof opts._router === 'function') return opts._router(n)
    if (!chainById(n)) throw new TapeAPIError('MANIFEST_INVALID', `chain ${id} is not a TapeOut chain this SDK supports (${CHAIN_IDS.join(', ')})`)
    let sub = subClients.get(n)
    if (!sub) {
      const conf = opts.chains?.[n] ?? {}
      sub = createTapeAPI({
        chainId: n, rpcUrls: conf.rpcUrls ?? rpcUrlsFor(n), quorum: conf.quorum ?? 2, timeoutMs: conf.timeoutMs ?? opts.timeoutMs,
        allowSingleNode: conf.allowSingleNode === true, hub: conf.hub, factory: conf.factory, siteRegistry: conf.siteRegistry,
        fetch: opts.fetch, dev: opts.dev, allowHttp: opts.allowHttp, maxSkewS: opts.maxSkewS,
        identityCacheS: opts.identityCacheS, identityCacheSize: opts.identityCacheSize, _router: forChain,
      })
      subClients.set(n, sub)
    }
    return sub
  }
  // The chain a resolve target names, or null for "this client's chain". A name carries its chain in its area code;
  // an object may carry `chainId`. / 解析目标所指的链：名字由区号决定，对象可带 chainId；null 表示本客户端的链。
  function chainOfTarget(target) {
    if (typeof target === 'string') return tapeName(target)?.chainId ?? null
    if (target && typeof target === 'object' && !('dev' in target) && target.chainId !== undefined) {
      const n = Number(target.chainId)
      if (!Number.isSafeInteger(n) || n < 1) throw new TapeAPIError('MANIFEST_INVALID', 'target.chainId must be a chain id')
      return n
    }
    return null
  }
  // The client that owns a resolved service: its own chain's. / 已解析服务所属的客户端：它那条链的。
  const ownerOf = (svc) => (svc && typeof svc === 'object' && svc.chainId !== undefined && Number(svc.chainId) !== Number(chainId)) ? forChain(svc.chainId) : null

  /**
   * Which supported chain a container address lives on: the chain on which it answers ERC-6551 token() with that very
   * chainId (an ERC-6551 address commits to its chainId, so at most one does). null when none does. An RPC failure on a
   * chain where no answer was found propagates: "could not read" is not "not a container".
   * 容器地址在哪条链上：在该链上 token() 回答的正是该链号的那条（ERC-6551 地址包含链号，至多一条）。都不是则为 null。
   * 没找到且某条链读取失败时抛出该错误："读不到"不等于"不是容器"。
   */
  async function chainOfContainer(container) {
    if (!isAddress(container)) throw new TapeAPIError('MANIFEST_INVALID', 'chainOfContainer takes a container address')
    const ids = [Number(chainId), ...CHAIN_IDS.filter((id) => id !== Number(chainId))]
    const settled = await Promise.allSettled(ids.map(async (id) => {
      try { await forChain(id).chain.tokenOf(container); return id } catch (e) {
        if (e instanceof TapeAPIError && (e.code === 'NOT_FOUND' || e.code === 'CHANNEL_INVALID')) return null
        throw e
      }
    }))
    const found = settled.filter((r) => r.status === 'fulfilled' && r.value !== null).map((r) => r.value)
    if (found.length) return found[0]
    const failed = settled.find((r) => r.status === 'rejected')
    if (failed) throw failed.reason
    return null
  }

  // ---- resolve ----
  // The prices the caller has consented to, per resolved service. resolve() records what the caller saw; an
  // AUTOMATIC re-read (TTL, or a provider's price hint) updates the manifest but never raises these. Paying more
  // than the caller accepted needs `maxPrice` on the call or an explicit api.acceptPrice(). Without this, one
  // republish of the manifest at a higher price was paid on the very next call (runtime audit F-08, High).
  // 调用方同意过的价格，按服务记录。resolve() 记下调用方看到的价格；自动重读（TTL 或提供者的价格提示）会更新清单，
  // 但绝不抬高这里的价格。要付得比已同意的多，需在调用时给 `maxPrice`，或显式调用 api.acceptPrice()。
  // 否则持有人重新发布一次高价清单，下一次调用就会照付。
  const ACCEPTED = new WeakMap()
  const pricesOf = (manifest) => Object.fromEntries(manifest.methods.map((d) => [d.name, methodPrice(d)]))
  const REFRESHING = new WeakMap()      // svc -> in-flight refresh promise (runtime audit F-10) / 进行中的刷新
  const REFRESH_FAILED = new WeakMap()  // svc -> time of the last failed automatic refresh (F-11) / 上次自动刷新失败的时间
  const HINT_REFRESHED = new WeakMap()  // svc -> time of the last re-read triggered by a price hint (F-09) / 上次因价格提示重读的时间
  const SIGNER_REREAD = new WeakMap()    // separate throttle: a wrong-signer endpoint must not block price re-reads / 独立限频
  const REFRESH_BACKOFF_S = 60
  const HINT_MIN_INTERVAL_S = 30

  async function resolve(target) {
    // A name or { chainId, ... } on another chain is resolved by that chain's client (TAP-20 §3.1: identity, manifest and
    // delegation all live on the chain the circuit is on). / 别的链上的名字或 { chainId, ... } 交给那条链的客户端解析。
    const where = chainOfTarget(target)
    if (where !== null && where !== Number(chainId)) return forChain(where).resolve(target)
    let src
    if (typeof target === 'string') {
      const name = tapeName(target)
      if (isAddress(target)) src = await manifestFromContainer(target)
      // A TapeOut name, <#ID>.<processor>.tape: the processor number gives the circuits contract, which with #ID gives
      // the container (TapeKit SPEC §3.2), so the name adds no trust beyond the { circuits, tokenId } path.
      // TapeOut 名字：处理器编号 → 电路合约，再与 #ID 得到容器；与 { circuits, tokenId } 路径信任相同。
      else if (name) src = await manifestFromContainer(await chain.accountOf(await chain.cpuAt(name.processor), name.tokenId))
      else {
        const container = await chain.resolve(target)
        if (eqAddr(container, ZERO_ADDRESS)) throw new TapeAPIError('NOT_FOUND', `label "${target}" not registered`)
        src = await manifestFromContainer(container)
      }
    } else if (target && typeof target === 'object') {
      if ('dev' in target) src = await manifestFromDev(target.dev)
      else if (target.circuits && target.tokenId != null) src = await manifestFromContainer(await chain.accountOf(target.circuits, target.tokenId))
      else if (target.chainId !== undefined && isAddress(target.container)) src = await manifestFromContainer(target.container)
      else throw new TapeAPIError('MANIFEST_INVALID', 'unsupported resolve target')
    } else throw new TapeAPIError('MANIFEST_INVALID', 'unsupported resolve target')

    // 只有 dev 来源的清单才放宽校验；dev: true 不影响链上来源清单（M-06）/ only dev-sourced manifests are relaxed
    const dev = !!src.dev
    let manifest = validateManifest(src.manifest, { requireDelegation: !dev, allowHttp })
    // TAP-20 §3.9: an `ai` field that breaks any MUST is refused as a field (MANIFEST_INVALID) and dropped here; the rest
    // of the manifest is unaffected. A valid one is kept in its normalised form. / 违反 §3.9 任一 MUST 的 ai 字段按字段拒绝并在此
    // 丢弃，清单其余部分不受影响；合规的保留其规范化形式。
    let aiProblems
    if (manifest[AI_FIELD] !== undefined) {
      manifest = { ...manifest }
      try { manifest[AI_FIELD] = validateAIField(manifest[AI_FIELD], { allowHttp: allowHttp || dev }) } catch (e) { aiProblems = [e.message]; delete manifest[AI_FIELD] }
    }
    if (src.container && !eqAddr(src.container, manifest.container)) throw new TapeAPIError('MANIFEST_INVALID', 'manifest.container does not match resolved container')
    // TAP-20 §3.6 step 3, for EVERY on-chain input form (label, container, pair): the container is re-derived from
    // the manifest's own (circuits, tokenId) on the hub and must equal both manifest.container and the located
    // container. This is what makes identity non-self-asserted, and it needs no directory.
    // §3.6 第 3 步，对所有链上输入形式生效：用清单自己的 (circuits, tokenId) 在 hub 上重新推导容器，必须同时等于
    // manifest.container 与定位到的容器。身份不可自述靠的就是这一步，且不需要目录。
    if (!dev) {
      const derived = await chain.accountOf(manifest.circuits, manifest.tokenId)
      if (!eqAddr(derived, manifest.container)) throw new TapeAPIError('MANIFEST_INVALID', `hub.accountOf(${manifest.circuits}, ${manifest.tokenId}) is ${derived}, manifest.container is ${manifest.container}`)
      await requireCPU(manifest.circuits, 'MANIFEST_INVALID')
    }
    if (src.service) {
      if (!eqAddr(src.service.circuits, manifest.circuits) || BigInt(src.service.tokenId) !== BigInt(manifest.tokenId)) throw new TapeAPIError('MANIFEST_INVALID', 'manifest circuits/tokenId do not match directory record')
    }
    const verified = await verifyDelegation(manifest, { dev })
    const contribution = dev ? 0 : await readContribution(manifest)
    // `target` and `fetchedAt` make the manifest re-readable. TAP-20 §3.6 says clients SHOULD re-check
    // periodically; without a way back to the source that sentence cannot be implemented, and a provider that
    // changes its price deadlocks every consumer holding the old manifest for ever.
    // 记住来源与取回时间，清单才能重读。TAP-20 §3.6 要求客户端定期复查；没有回到来源的路径这句话就无法实现，
    // 而提供者一旦改价，所有持旧清单的消费者会被永久卡死。
    // `chainId`: the chain this service lives on; call, refresh and price consent go through that chain's client.
    // `chainId`：服务所在的链；call、refresh 与价格同意都经由那条链的客户端。
    const svc = { manifest, container: checksumAddress(manifest.container), chainId, verified, contribution, file: src.file ?? null, target, fetchedAt: now() }
    if (aiProblems) svc.aiProblems = aiProblems
    ACCEPTED.set(svc, pricesOf(manifest))
    return svc
  }

  // Re-read a resolved service from its original source and update it in place, so the caller's handle and every
  // payer counter keyed on it stay valid. The container MUST NOT change: a different container is a different
  // service, not a refresh. Everything goes through the full resolve path, so the refreshed manifest is verified
  // exactly as the first one was -- a provider can never talk the client into a price it did not publish on chain.
  // 从原始来源重读并就地更新，调用方持有的句柄与按它记账的 payer 计数器都保持有效。容器 MUST NOT 变化：
  // 换了容器就是换了服务，不是刷新。走完整 resolve 路径，刷新后的清单与第一次一样经过验证 ——
  // 提供者永远无法让客户端接受一个它没有发布到链上的价格。
  async function refresh(svc) {
    const owner = ownerOf(svc)
    if (owner) return owner.refresh(svc)
    if (svc?.target === undefined) throw new TapeAPIError('MANIFEST_INVALID', 'svc has no target to refresh from; it did not come from api.resolve()')
    // N concurrent calls on one stale service share one re-read instead of running N (runtime audit F-10).
    // 同一服务上的 N 个并发调用共用一次重读，而不是各跑一次。
    const inflight = REFRESHING.get(svc)
    if (inflight) return inflight
    const p = refreshNow(svc).finally(() => REFRESHING.delete(svc))
    REFRESHING.set(svc, p)
    return p
  }
  async function refreshNow(svc) {
    const fresh = await resolve(svc.target)
    if (!eqAddr(fresh.container, svc.container)) {
      throw new TapeAPIError('MANIFEST_INVALID', `refresh resolved to ${fresh.container}, not ${svc.container}: that is a different service`)
    }
    svc.manifest = fresh.manifest; svc.verified = fresh.verified; svc.contribution = fresh.contribution
    if (fresh.aiProblems) svc.aiProblems = fresh.aiProblems; else delete svc.aiProblems
    svc.file = fresh.file; svc.fetchedAt = fresh.fetchedAt
    return svc
  }

  // Price consent. A lower price is accepted silently; a higher one needs `maxPrice` (base units) covering it, or a
  // prior api.acceptPrice(). The error names both prices so an application can ask its user.
  // 价格同意。降价静默接受；涨价需要调用时的 `maxPrice`（最小单位）覆盖它，或事先调用 api.acceptPrice()。
  // 错误里同时给出新旧价格，便于应用去问用户。
  function gatePrice(svc, method, price, maxPrice) {
    const acc = ACCEPTED.get(svc)
    const was = acc?.[method]
    if (was === undefined || price <= was) { if (acc) acc[method] = price; return price }
    if (maxPrice != null && price <= BigInt(maxPrice)) { acc[method] = price; return price }
    throw new TapeAPIError('PRICE_CHANGED', `${method} now costs ${formatUnits(price)} BEM, up from the ${formatUnits(was)} BEM you accepted; pass { maxPrice } or call api.acceptPrice()`, { data: { method, accepted: was.toString(), price: price.toString() } })
  }

  // ---- call ----
  // 一次调用 = 一次尝试；BAD_VOUCHER 且错误负载带 lastCumulative 时 payer 重新同步后再试一次（H-05）。
  // One call = one attempt; on BAD_VOUCHER carrying lastCumulative the payer resyncs and retries once (review H-05).
  async function call(svc, method, params = {}, options = {}) {
    const owner = ownerOf(svc)
    if (owner) return owner.call(svc, method, params, options)
    const { payer, id, signal, timeoutMs = 30000, manifestTtlMs = MANIFEST_TTL_MS, maxPrice } = options ?? {}
    let m = svc?.manifest; if (!m) throw new TapeAPIError('MANIFEST_INVALID', 'svc.manifest missing')
    // 信封只对 manifest.signer 验签，而 signer 的可信度完全来自 resolve() 做过的委托校验。
    // 自己拼一个 { manifest, container } 直接 call，等于没有任何来源认证，所以必须拒绝（M-16）。
    // Envelopes are verified against manifest.signer, and that signer is only trustworthy because resolve() checked
    // the holder's delegation. A hand-assembled { manifest, container } has no provenance at all, so it is refused.
    if (!svc.verified || (svc.verified.delegation !== true && svc.verified.dev !== true)) {
      throw new TapeAPIError('DELEGATION_INVALID', 'svc must come from api.resolve(): manifest.signer is only trustworthy once the delegation has been verified')
    }
    if (typeof method !== 'string' || !METHOD_NAME_RE.test(method)) throw new TapeAPIError('METHOD_NOT_FOUND', 'method name invalid')
    let def = findMethod(m, method)
    if (!def) throw new TapeAPIError('METHOD_NOT_FOUND', `method ${method} not in manifest`)
    if (params == null) params = {}
    if (typeof params !== 'object' || Array.isArray(params)) throw new TapeAPIError('BAD_REQUEST', 'params must be a JSON object')
    // The envelope binds canonicalJSON({method, params}); params with no canonical form can never be verified, so
    // refuse them here instead of paying for a call whose answer cannot be checked (TAP-21 §3.3).
    // 信封绑定 canonicalJSON({method, params})；没有规范形式的参数永远无法验证，在此拒绝，而不是为无法核对的回答付费。
    try { canonicalJSON({ method, params }) } catch (e) { throw new TapeAPIError('BAD_REQUEST', `params have no canonical form: ${e.message}`) }
    // TAP-20 §3.6: re-read a manifest older than the TTL before spending against it. Best effort -- a transient
    // RPC failure must not block a call that the cached manifest can still serve. 0 disables.
    // 超过 TTL 的清单在按它付款前先重读。尽力而为：一次 RPC 抖动不该挡住缓存清单仍能完成的调用。0 表示关闭。
    // After a failed re-read, back off instead of making every call wait out a dead RPC first (F-11).
    // 重读失败后退避一段时间，而不是让每次调用都先等一个挂掉的 RPC 超时。
    const failedAt = REFRESH_FAILED.get(svc)
    if (manifestTtlMs > 0 && svc.target !== undefined && now() - (svc.fetchedAt ?? 0) >= Math.floor(manifestTtlMs / 1000)
        && !(failedAt && now() - failedAt < REFRESH_BACKOFF_S)) {
      try {
        await refresh(svc); REFRESH_FAILED.delete(svc); m = svc.manifest
        def = findMethod(m, method)
        // A method the holder removed is gone; do not keep paying for the stale definition (I-06).
        // 持有人已删除的方法就是没了，不再按旧定义付费。
        if (!def) throw new TapeAPIError('METHOD_NOT_FOUND', `method ${method} was removed from the manifest`)
      } catch (e) {
        if (e instanceof TapeAPIError && e.code === 'METHOD_NOT_FOUND') throw e
        REFRESH_FAILED.set(svc, now())      // keep serving from cache / 继续用缓存
      }
    }
    // TAP-20 §3.3 allows an async-only service (no live endpoints). This client speaks TAP-21 over HTTP only, so
    // say that plainly instead of failing somewhere inside the request loop. / 本客户端只走 HTTP，明说而不是在请求循环里出错。
    if (!m.endpoints.live.length) throw new TapeAPIError('PROVIDER_UNAVAILABLE', `${svc.container} publishes no live endpoint (async: true only); this client cannot reach it`)
    let price = gatePrice(svc, method, methodPrice(def), maxPrice)
    // Payments run on BNB Smart Chain only (docs/PLAN-2026Q4.md, 2026-09-28): no escrow, no BEM on the L2s.
    // 支付只在 BNB Smart Chain：L2 上没有托管合约，也没有 BEM。
    if (price > 0n && known && known.payments === false) throw new TapeAPIError('PAYMENT_REQUIRED', `${method} costs ${def.priceBEM} BEM, but ${svc.container} is on ${known.name}: TapeAPI payments run on BNB Smart Chain only`, { data: { method, chainId } })
    if (price > 0n && !payer) throw new TapeAPIError('PAYMENT_REQUIRED', `${method} costs ${def.priceBEM} BEM; pass { payer }`)
    // 提供者只接受 1..128 字符的 id；本地先挡住，否则拿回来的是一个 id='' 的错误信封，永远验不过签。
    // Providers only accept ids of 1..128 chars: reject locally, or the answer is an id='' error envelope that can
    // never match the request and surfaces as BAD_SIGNATURE instead of the caller's own mistake.
    if (id != null && (typeof id !== 'string' || !id || id.length > 128)) throw new TapeAPIError('BAD_REQUEST', 'id must be a string of 1..128 characters')
    // One id for the whole call, retry included: it is the idempotency key the provider may dedup on, and it
    // is covered by the TAP-21 v2 digest, so a retry must not change it.
    // 整次调用（含重试）共用一个 id：它是提供者可用于去重的幂等键，且被 TAP-21 v2 摘要覆盖，重试不得更换。
    const reqId = id || uuid()
    const first = await attempt(svc, def, method, params, price, { payer, reqId, signal, timeoutMs, retried: false })
    if (!first.retry) return first.value
    if (first.refreshPrice) {
      // The provider says it charges something else. Its number is a hint, never authority: re-read the manifest
      // from the chain, and pay what the holder published only if the caller has consented to it. A provider that
      // keeps quoting a price the chain does not show gets one re-read per HINT_MIN_INTERVAL_S, not one per call (F-09).
      // 提供者说它的价格不是这个。它给的数字只是提示，不是权威：重读链上清单，只有调用方同意过才按持有人发布的价格付。
      // 反复报出链上并不存在的价格的提供者，每 HINT_MIN_INTERVAL_S 秒最多换来一次重读，而不是每次调用一次。
      const last = HINT_REFRESHED.get(svc)
      if (last && now() - last < HINT_MIN_INTERVAL_S) {
        throw new TapeAPIError('BAD_VOUCHER', `provider quotes a price for ${method} that the chain does not show (manifest re-read ${now() - last}s ago)`, { data: { quoted: first.quoted, chain: price.toString() } })
      }
      HINT_REFRESHED.set(svc, now())
      await refresh(svc)
      m = svc.manifest
      def = findMethod(m, method)
      if (!def) throw new TapeAPIError('METHOD_NOT_FOUND', `method ${method} was removed from the manifest`)
      price = gatePrice(svc, method, methodPrice(def), maxPrice)
      if (price > 0n && !payer) throw new TapeAPIError('PAYMENT_REQUIRED', `${method} now costs ${def.priceBEM} BEM; pass { payer }`)
    }
    const second = await attempt(svc, def, method, params, price, { payer, reqId, signal, timeoutMs, retried: true })
    return second.value
  }

  // TAP-21 §3.4 / TAP-20 §3.6: an envelope signed by someone other than manifest.signer may mean the holder rotated
  // the key. Re-read the manifest (from step 2); if the chain now names exactly the key that signed, this envelope
  // is valid and is kept -- no second request, so a result the provider already billed is not paid for twice.
  // Throttled like price hints, so a hostile endpoint cannot turn every call into a chain read.
  // 信封签名者不是 manifest.signer，可能是持有人换了密钥。重读清单（从第 2 步起）；若链上现在指定的正是签名的那把钥匙，
  // 这个信封就有效并被采用——不再发第二次请求，提供者已计费的结果不会被付两次。与价格提示同样限频。
  async function signerRotated(svc, signer, retried) {
    if (retried) return false
    return (await rereadAfterBadSignature(svc)) && eqAddr(signer, svc.manifest.signer)
  }
  // TAP-20 §3.6 / TAP-21 §3.4: EVERY envelope-binding failure triggers a re-read from step 2, not only a foreign key
  // (spec review SD-2). `refresh` updates `svc` in place, so the next call already uses the re-read endpoints and
  // signer even though this one still fails. Best effort, and one re-read per service per HINT_MIN_INTERVAL_S, shared
  // with signerRotated: a hostile endpoint cannot turn every call into chain reads. true when the re-read succeeded.
  // 每一种信封绑定失败都触发从第 2 步起的重读，而不只是签名密钥不同。`refresh` 就地更新 `svc`，这次调用仍失败，
  // 下一次调用已用上重读后的端点与签名者。尽力而为；每个服务每 HINT_MIN_INTERVAL_S 秒至多一次（与 signerRotated 共用），
  // 恶意端点无法把每次调用都变成链上读取。重读成功返回 true。
  async function rereadAfterBadSignature(svc) {
    if (svc.target === undefined) return false
    const last = SIGNER_REREAD.get(svc)
    if (last && now() - last < HINT_MIN_INTERVAL_S) return false
    SIGNER_REREAD.set(svc, now())
    try { await refresh(svc); return true } catch { return false }
  }

  async function attempt(svc, def, method, params, price, { payer, reqId, signal, timeoutMs, retried }) {
    const m = svc.manifest
    const body = { id: reqId, method, params }
    let lease = null
    if (price > 0n) { lease = await payer.reserve(svc, price); body.voucher = lease.voucher }
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs)
    const onAbort = () => ac.abort()
    if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', onAbort, { once: true }) }
    let res, env
    // A manifest may publish up to 4 endpoints (TAP-20 §3.3). Try them in order on a TRANSPORT failure only:
    // every endpoint belongs to the same service and the envelope is verified against the same signer, so this
    // changes availability, not trust. Any signed answer -- a signed error included -- ends the loop; we never
    // shop around for a nicer reply. Each try carries the identical voucher, so at most one host can bill it.
    // 清单最多可发布 4 个端点。仅在传输失败时按顺序尝试：所有端点属于同一服务、信封验的是同一个 signer，
    // 因此这只改变可用性，不改变信任。任何已签名的回答（含已签名的错误）都终止循环，绝不换一家问同一个问题。
    // 每次尝试用的是同一张凭证，因此最多只有一家能对它计费。
    const urls = m.endpoints.live
    let lastErr = null
    for (let i = 0; i < urls.length; i++) {
      try {
        res = await needFetch()(`${urls[i]}/${method}`, {
          method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal: ac.signal,
        })
        // HTTP 429 IS the answer, whatever its body (TAP-21 §3.4): a CDN's HTML 429 must not send the same voucher on
        // to the next endpoint (spec review SD-5). The body is read only for a retryAfterS hint.
        // HTTP 429 本身就是答复，不论响应体是什么：CDN 的 HTML 429 不能让同一张凭证被送往下一个端点。只为 retryAfterS 提示读响应体。
        if (res.status === 429) {
          try { env = await readJsonBounded(res, ENVELOPE_LIMIT, { code: 'PROVIDER_UNAVAILABLE' }) } catch { env = null }
          lastErr = null
          break
        }
        env = await readJsonBounded(res, ENVELOPE_LIMIT, { code: 'PROVIDER_UNAVAILABLE' })
        lastErr = null
        break
      } catch (e) {
        lastErr = e
        if (ac.signal.aborted) break   // the caller's timeout/abort covers the whole call / 超时与中止作用于整次调用
      }
    }
    clearTimeout(t); if (signal) signal.removeEventListener('abort', onAbort)
    // A rate-limited request is refused before the provider does any work, so there is no envelope to verify and
    // nothing is signed: the status IS the answer. Surfacing it as BAD_SIGNATURE would blame the wrong party.
    // 被限流的请求在提供者做任何工作之前就被拒绝，既没有信封也没有签名：状态码本身就是答复。
    // 把它报成 BAD_SIGNATURE 会怪错人。
    if (res && res.status === 429) {
      lease?.release()
      const hdr = Number(res.headers?.get?.('retry-after'))
      const retryAfterS = Number.isFinite(hdr) && hdr > 0 ? hdr : (Number(env?.error?.data?.retryAfterS) || null)
      throw new TapeAPIError('RATE_LIMITED', `provider is rate limiting this client${retryAfterS ? `; retry in ${retryAfterS}s` : ''}`, { data: { retryAfterS } })
    }
    if (lastErr) {
      lease?.release() // 传输失败：不知道提供者是否消费，释放预留 / released; the resync path fixes any drift
      if (lastErr instanceof TapeAPIError && lastErr.code === 'PROVIDER_UNAVAILABLE') throw lastErr
      throw new TapeAPIError('PROVIDER_UNAVAILABLE', `provider request failed on all ${urls.length} endpoint(s): ${lastErr.message}`)
    }
    // 信封校验：用自己发出的 method/params 与解析出的 container 重算摘要（TAP-21 v2）/ recompute with our own request
    // BAD_SIGNATURE re-reads the manifest first (SD-2); awaited at every call site, so it still ends the attempt.
    // BAD_SIGNATURE 先重读清单；每个调用点都 await 它，因此仍然终止本次尝试。
    const reject = async (msg, extra) => { lease?.release(); await rereadAfterBadSignature(svc); throw new TapeAPIError('BAD_SIGNATURE', msg, extra) }
    // TAP-21 §3.2: only JSON carrying a `sig` is an envelope. Anything else -- a CDN or proxy error page, the
    // provider's own unsigned 404 -- is a transport failure, not a bad signature, and must not trigger a re-resolve.
    // 只有带 `sig` 的 JSON 才是信封。其它（CDN/代理错误页、提供者自己未签名的 404）是传输失败，不是坏签名。
    if (!env || typeof env !== 'object' || Array.isArray(env) || typeof env.sig !== 'string') {
      lease?.release()
      // A provider whose delegation lapsed answers an unsigned DELEGATION_INVALID (TAP-21). Unsigned, so only a hint:
      // report it as such only when our own copy of the manifest agrees it has expired (arch A3).
      // 委托过期的提供者回未签名的 DELEGATION_INVALID。未签名只能当提示：只有本地清单也确认已过期时才这样报告。
      const own = m?.delegation?.expires
      if (env?.error?.code === 'DELEGATION_INVALID' && Number.isInteger(own) && own <= now()) {
        throw new TapeAPIError('DELEGATION_INVALID', `${svc.container}: its delegation expired at ${own}; the holder must re-sign it`, { httpStatus: res.status, data: { delegationExpires: own } })
      }
      const claim = typeof env?.error?.code === 'string' ? ` (unsigned claim: ${env.error.code.slice(0, 64)})` : ''
      throw new TapeAPIError('PROVIDER_UNAVAILABLE', `provider answered HTTP ${res.status} without a signed envelope${claim}`, { httpStatus: res.status })
    }
    // TAP-21 §3.2: a request the provider could not parse is refused with a BAD_REQUEST signed over id "" and
    // params {} (it has no id or params it could trust). Verify that binding and report the caller's own mistake,
    // rather than blaming the provider's signature. / 提供者无法解析的请求，以绑定 id "" 与 params {} 的已签名
    // BAD_REQUEST 拒绝。按该绑定验签，报告调用方自己的错误，而不是怪提供者的签名。
    const malformed = (id) => {
      if (env.ok !== false || env.error?.code !== 'BAD_REQUEST' || !Number.isInteger(env.ts)) return false
      try { return eqAddr(recoverResponseSigner({ container: svc.container, id, method, params: {}, ok: false, body: env.error, ts: env.ts }, env.sig), m.signer) } catch { return false }
    }
    const refuseMalformed = () => { lease?.release(); throw new TapeAPIError('BAD_REQUEST', env.error.message || 'malformed request', { signed: true, ts: env.ts, httpStatus: res.status }) }
    if (env.id !== reqId) { if (env.id === '' && malformed('')) refuseMalformed(); await reject('response id mismatch') }
    if (typeof env.ok !== 'boolean') await reject('response ok flag missing')
    if (!eqAddr(env.container, svc.container)) await reject('response container mismatch')
    if (!Number.isInteger(env.ts)) await reject('response ts missing')
    if (Math.abs(now() - env.ts) > maxSkewS) await reject(`response ts ${env.ts} outside the ±${maxSkewS}s freshness window`)
    const payload = env.ok ? env.result : env.error
    if (payload === undefined) await reject(env.ok ? 'result missing' : 'error missing')
    let signer
    try { signer = recoverResponseSigner({ container: svc.container, id: reqId, method, params, ok: env.ok, body: payload, ts: env.ts }, env.sig) } catch (e) { await reject(`envelope: ${e.message}`) }
    // params the provider found non-canonical are refused bound to params {} (TAP-21 §3.3) / 非规范参数的拒绝绑定 params {}
    if (!eqAddr(signer, m.signer) && malformed(reqId)) refuseMalformed()
    if (!eqAddr(signer, m.signer) && !(await signerRotated(svc, signer, retried))) await reject(`envelope signed by ${signer}, expected ${m.signer}`)
    if (!env.ok) {
      const code = typeof env.error?.code === 'string' ? env.error.code : 'INTERNAL'
      const data = env.error?.data && typeof env.error.data === 'object' ? env.error.data : undefined
      // A priced method called without a voucher: the method was free in our copy of the manifest and is priced
      // now (TAP-20 §3.6). Re-read the manifest; the consent gate decides whether we may pay (runtime D5).
      // 没带凭证却被要求付费：我们手里的清单说它免费，现在收费了。重读清单，由价格同意闸门决定能否付。
      if (!lease && code === 'PAYMENT_REQUIRED' && !retried) return { retry: true, refreshPrice: true, quoted: typeof data?.price === 'string' ? data.price : null }
      if (lease) {
        // 任何已签名的错误都释放预留：提供者的 reserve/commit 只为"交付了的结果"计费，失败的调用不入账。
        // 万一某个提供者仍然入了账，下一张凭证会太低 → BAD_VOUCHER + lastCumulative → resync 一次即可自愈；
        // 反过来（本地 commit 而对方没入账）则是永久多付，无法自愈（H-04）。
        // Release on ANY signed error: the provider's reserve/commit only bills a delivered result, so a failed call
        // is not on its meter. If some provider did bill anyway, the next voucher is too low and the signed
        // BAD_VOUCHER + lastCumulative path heals it in one retry; committing locally against a provider that did
        // not bill is a permanent overpayment that nothing can heal (review H-04).
        lease.release()
        const last = data?.lastCumulative
        const quoted = data?.price
        // Order matters: a stale PRICE must be handled before a stale COUNTER. `resync` no-ops whenever the
        // provider's lastCumulative is not ahead of ours, which is exactly the case after a price rise -- so
        // checking the counter first would retry at the same stale price and deadlock the consumer for ever.
        // 顺序要紧：价格过期必须先于计数器过期处理。提供者的 lastCumulative 不高于本地时 `resync` 直接空转，
        // 而涨价后正是这种情况 —— 先查计数器就会按同一个旧价重试，把消费者永久卡死。
        // TAP-22 §3.2 says an insufficient voucher is BAD_VOUCHER and PAYMENT_REQUIRED only means "no voucher"; a provider
        // that answers PAYMENT_REQUIRED to a voucher anyway still carries data.price, so heal it the same way.
        // TAP-22 §3.2 规定额度不足是 BAD_VOUCHER，PAYMENT_REQUIRED 只表示"没带凭证"；对带了凭证的请求仍回 PAYMENT_REQUIRED 的提供者
        // 同样带 data.price，照样自愈。
        if ((code === 'BAD_VOUCHER' || code === 'PAYMENT_REQUIRED') && !retried && typeof quoted === 'string' && /^\d+$/.test(quoted) && BigInt(quoted) !== price) {
          return { retry: true, refreshPrice: true, quoted }
        }
        if (code === 'BAD_VOUCHER' && !retried && typeof last === 'string' && /^\d+$/.test(last)) {
          await payer.resync(svc, last, data)
          return { retry: true }
        }
      }
      throw new TapeAPIError(code, env.error?.message || code, { signed: true, ts: env.ts, block: env.block, id: env.id, sig: env.sig, error: env.error, httpStatus: res.status, data })
    }
    lease?.commit()
    return { value: { result: env.result, verified: true, ts: env.ts, block: env.block ?? null, id: reqId, sig: env.sig } }
  }

  // ---- quorum：多提供者一致 / multi-provider agreement (TAP-23 §1 client rule) ----
  // Same rule as the TapeKit kernel: accept only when at least `quorum` independent providers return byte-identical
  // (canonicalJSON) results. There is NO majority vote: if two different results each reach `quorum` the call fails
  // as ambiguous, and any verified result that differs from the agreed one is reported in `disagreed`, never outvoted.
  // 与 TapeKit 内核同一条规则：至少 quorum 个独立提供者返回逐字节相同（canonicalJSON）的结果才采用。永远没有多数投票：
  // 若两个不同结果各自都达到 quorum，视为歧义直接失败；任何与一致集不同的已验签结果都在 disagreed 中报告，而不是被投掉。
  // 数值容差比较：把 result 里 `paths` 指定的数字按相对误差归为一组，其余字段仍须逐字节相同。
  // 跨源价格永远不会字节相同（Venus 的 BoundValidator 用 ±1%），而证明式读取必须字节相同——所以这是可选项。
  // Tolerant comparison: numbers at `paths` are grouped within a relative tolerance, every other field must
  // still match byte-for-byte. Cross-source prices are never byte-identical (Venus's BoundValidator allows
  // +/-1%), while attested reads must be; hence this is opt-in, never the default.
  // 只接受严格十进制字面量：`0x64`、`1e5`、` 100 `、`Infinity` 都不是数字，不能被 Number() 悄悄强转（H-02）。
  // Strict decimal literals only: `0x64`, `1e5`, ` 100 ` and `Infinity` must not be silently coerced by Number().
  const COMPARE_NUM_RE = /^-?\d+(\.\d+)?$/
  // compare 的形状只与调用方有关，必须在发出任何（可能收费的）请求之前校验一次（H-03）。
  // The compare options are the caller's, so they are validated once before any (possibly paid) request goes out.
  function validateCompare(compare) {
    const { relTolBps, paths } = compare
    if (!Number.isInteger(relTolBps) || relTolBps < 0 || relTolBps > 10_000) {
      throw new TapeAPIError('BAD_REQUEST', 'compare.relTolBps must be an integer in 0..10000')
    }
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new TapeAPIError('BAD_REQUEST', 'compare.paths must be a non-empty array of dotted paths')
    }
    for (const p of paths) {
      if (typeof p !== 'string' || !p || p.split('.').some((k) => !k)) {
        throw new TapeAPIError('BAD_REQUEST', `compare.paths: ${JSON.stringify(p)} is not a dotted path`)
      }
    }
  }
  // 抽取一个结果的容差键。失败是**这个提供者**的问题（缺字段、非数字），计入 failed，不能拖垮整次调用（H-03）。
  // Extracting one provider's tolerance key. A failure here is THAT provider's fault (missing field, not a number):
  // it becomes a `failed` entry and must not abort the whole quorum call.
  function tolerantKey(result, compare) {
    const { paths } = compare
    const bad = (msg) => { throw new TapeAPIError('COMPARE_PATH_INVALID', msg) }
    const at = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
    const types = []
    const nums = paths.map((p) => {
      const v = at(result, p)
      let n
      if (typeof v === 'number') n = v
      else if (typeof v === 'string' && COMPARE_NUM_RE.test(v)) n = Number(v)
      else bad(`compare.paths: ${p} is not a number or a decimal string in this result`)
      if (!Number.isFinite(n)) bad(`compare.paths: ${p} is not a finite number in this result`)
      types.push(typeof v)
      return n
    })
    // 其余字段的骨架仍逐字节比较；被比较的位置写入**带类型的**占位符，这样字符串 "100" 与数字 100
    // 不会落进同一个桶（否则调用方拿到的类型由最先回答的提供者决定，H-02）。
    // The rest of the shape is still compared byte-for-byte; each compared position gets a TYPE-TAGGED
    // placeholder so the string "100" and the number 100 cannot share a bucket (otherwise the type the caller
    // receives would be decided by whichever provider answered first).
    const skeleton = JSON.parse(canonicalJSON(result))
    paths.forEach((p, i) => {
      const keys = p.split('.'); const last = keys.pop()
      const parent = keys.reduce((o, k) => (o == null ? undefined : o[k]), skeleton)
      if (!parent || typeof parent !== 'object') bad(`compare.paths: ${p} has no object parent in this result`)
      parent[last] = `\u0000tapeapi/compare/${i}/${types[i]}`
    })
    return { skeleton: canonicalJSON(skeleton), nums }
  }
  function withinTolerance(a, b, relTolBps) {
    if (a.skeleton !== b.skeleton) return false
    return a.nums.every((x, i) => {
      const y = b.nums[i]
      const scale = Math.max(Math.abs(x), Math.abs(y))
      if (scale === 0) return true
      return (Math.abs(x - y) / scale) * 10_000 <= relTolBps
    })
  }

  // onDissent：默认 'reject'，与 TAP-23 §3.4 一致——任意两个已验证信封不一致即拒绝。
  // 'quorum' 是明确的降级：允许唯一达到法定人数的一组获胜。它把失败模式从"拒绝"换成"可被 quorum 个
  // 合谋提供者伪造"，只有当调用方自己挑选并信任这批提供者时才可用。
  // onDissent defaults to 'reject', matching TAP-23 §3.4: any two disagreeing verified envelopes reject.
  // 'quorum' is an explicit weakening: the single bucket reaching quorum wins. It trades "deny" for
  // "forgeable by quorum colluding providers", and is only safe when the caller picked the set itself.
  async function callQuorum(services, method, params = {}, { quorum = 2, payer, compare, onDissent = 'reject', allowSingleProvider = false, ...callOpts } = {}) {
    const fail = (msg, extra) => { throw new TapeAPIError('QUORUM_FAILED', `${method}: ${msg}`, extra) }
    if (!Array.isArray(services) || services.length === 0) fail('services must be a non-empty array of resolved services')
    if (!Number.isInteger(quorum) || quorum < 1) fail('quorum must be a positive integer')
    // TAP-23 §3.4(1): N ≥ 2. One provider is one opinion; the opt-out exists for tests and must be spelled out.
    // TAP-23 §3.4(1)：N ≥ 2。一个提供者只是一个意见；退出开关仅供测试，且必须显式写出。
    if (quorum < 2 && allowSingleProvider !== true) fail('quorum must be at least 2 (TAP-23 §3.4); pass allowSingleProvider: true to accept one provider')
    // TAP-23 §3.5: two services that share a container, a holder or an origin are one source, not two.
    // TAP-23 §3.5：共用容器、持有人或来源（scheme+host+port）的两个服务只算一个来源。
    const seen = new Set(); const holders = new Map(); const origins = new Map()
    for (const s of services) {
      const c = s?.container && isAddress(s.container) ? s.container.toLowerCase() : null
      if (!c) fail('each service needs a container (pass results of api.resolve)')
      if (seen.has(c)) fail(`duplicate provider ${s.container}; quorum requires independent providers`)
      seen.add(c)
      const h = typeof s.verified?.holder === 'string' ? s.verified.holder.toLowerCase() : null
      if (h && holders.has(h)) fail(`${holders.get(h)} and ${s.container} share holder ${s.verified.holder}; TAP-23 §3.5 counts them as one source`)
      if (h) holders.set(h, s.container)
      for (const u of s.manifest?.endpoints?.live || []) {
        let o; try { o = new URL(u).origin } catch { continue }
        if (origins.has(o) && origins.get(o) !== s.container) fail(`${origins.get(o)} and ${s.container} share origin ${o}; TAP-23 §3.5 counts them as one source`)
        origins.set(o, s.container)
      }
    }
    if (services.length < quorum) fail(`quorum ${quorum} needs at least ${quorum} providers, got ${services.length}`)
    // 调用方自己的参数先校验，再花钱 / the caller's own options are validated before any paid request goes out
    if (onDissent !== 'reject' && onDissent !== 'quorum') fail("onDissent must be 'reject' or 'quorum'")
    if (compare) validateCompare(compare)
    // Attested Read (TAP-23): a method whose descriptor carries `attestedRead` on any selected service.
    // 见证读取（TAP-23）：任一所选服务的方法描述符带有 `attestedRead`。
    const descriptors = services.map((s) => (s.manifest?.methods || []).find((m) => m.name === method))
    const attested = descriptors.some((d) => d?.attestedRead)
    const disagreeCode = attested ? 'ATTEST_DISAGREE' : 'QUORUM_FAILED'
    const disagree = (msg, extra) => { throw new TapeAPIError(disagreeCode, `${method}: ${msg}`, extra) }
    if (attested) {
      if (compare) fail('a tolerance MUST NOT be applied to an attested read (TAP-23 §8)')
      const b = params?.block
      if (!((Number.isInteger(b) && b >= 0) || (typeof b === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(b)))) {
        fail('an attested read needs an explicit numeric params.block for the quorum round (TAP-23 §3.4(2)); ask one provider first and reuse its blockNumber')
      }
      descriptors.forEach((d, i) => {
        if (!d?.attestedRead) fail(`${services[i].container} does not offer ${method} as an attested read`)
        if (!Array.isArray(d.attestedRead.chains) || !d.attestedRead.chains.includes(params.chainId)) fail(`${services[i].container} does not list chainId ${params.chainId}`)
      })
    }

    // 每个提供者独立调用并各自验签 / every provider is called and envelope-verified independently
    const settled = await Promise.allSettled(services.map((s) => call(s, method, params, { ...callOpts, payer })))
    const buckets = new Map() // canonicalJSON(result) -> { result, containers, responses }
    const failed = []         // no verifiable answer: transport error, signed error, bad envelope / 无可验证答案
    settled.forEach((r, i) => {
      const container = services[i].container
      if (r.status === 'rejected') {
        const e = r.reason
        failed.push({ container, code: e?.code || 'INTERNAL', message: e?.message || String(e) })
        // A SIGNED revert (TAP-23 §3.3: error.data.revert) is a statement about chain state, so it is compared like an
        // answer: a revert beside a result is disagreement (strict mode rejects), and a revert group can never be the
        // accepted result. Other signed errors are refusals (no such block, bad request) and stay neutral (review SD-10).
        // 签名的回滚是对链上状态的陈述，与回答一样参与比较：回滚与结果并存即不一致（严格模式拒绝），回滚组永远不能成为被接受的结果。
        // 其他签名错误是拒答（没有该区块、请求有误），保持中立。
        const rev = e?.signed === true && typeof e?.data?.revert === 'string' && /^0x[0-9a-fA-F]*$/.test(e.data.revert) ? e.data.revert.toLowerCase() : null
        if (rev !== null) {
          const k = '\u0001revert:' + rev
          const b = buckets.get(k) || { result: { reverted: true, revert: rev }, containers: [], responses: [], revert: true }
          b.containers.push(container); buckets.set(k, b)
        }
        return
      }
      let key, tol
      try {
        // TAP-23 §3.4(4): attested envelopes agree on chainId, blockNumber, blockHash and result; stateRoot is
        // checked after bucketing, only between envelopes that both carry it.
        // 见证读取按 chainId/blockNumber/blockHash/result 比较；stateRoot 分桶后仅在双方都有时比较。
        const x = r.value.result
        key = attested ? canonicalJSON({ chainId: x?.chainId, blockNumber: x?.blockNumber, blockHash: x?.blockHash, result: x?.result }) : canonicalJSON(x)
      } catch (e) {
        failed.push({ container, code: 'CANON_INVALID', message: e.message }); return
      }
      if (compare) {
        try { tol = tolerantKey(r.value.result, compare) }
        catch (e) { failed.push({ container, code: e.code || 'COMPARE_PATH_INVALID', message: e.message }); return }
        // 一个桶必须是容差关系下的**团**：新答案要与桶里每一个成员都在容差内，而不只是与代表值。
        // 只比代表值时，一个居中的恶意答案能把两个本来不一致的诚实提供者粘成一桶（并且代表值是恶意值本身），
        // 严格模式也会因此变成"只有一个桶"而放行（H-01）。
        // A bucket must be a CLIQUE under the tolerance relation: a new answer has to be within tolerance of every
        // member, not just of the representative. Comparing against the representative alone lets a middling
        // malicious answer glue together two honest providers that do not agree — and the bucket's representative
        // is then the malicious value, while strict mode sees a single bucket and accepts (review H-01).
        let joined = false
        for (const b of buckets.values()) {
          if (b.tols && b.tols.every((t) => withinTolerance(t, tol, compare.relTolBps))) {
            b.containers.push(container); b.responses.push(r.value); b.tols.push(tol); joined = true; break
          }
        }
        if (joined) return
        // 字节相同的结果总能加入既有桶（同 nums、同 skeleton），这里只是防御性地避免覆盖 / defensive: never clobber a bucket
        let k = key; while (buckets.has(k)) k += '\u0000'
        buckets.set(k, { result: r.value.result, tol, tols: [tol], containers: [container], responses: [r.value] })
        return
      }
      const b = buckets.get(key) || { result: r.value.result, containers: [], responses: [] }
      b.containers.push(container); b.responses.push(r.value); buckets.set(key, b)
    })
    const groups = [...buckets.values()].map((b) => ({ result: b.result, containers: b.containers }))
    const answered = settled.length - failed.length
    if (attested) {
      for (const b of buckets.values()) {
        const roots = new Set(b.responses.map((x) => x.result?.stateRoot).filter((v) => v != null).map(String))
        if (roots.size > 1) disagree(`envelopes agree on the block and result but report ${roots.size} different stateRoots`, { quorum, agreed: [], disagreed: b.containers, failed, groups })
      }
    }
    // 严格模式（默认）：所有已验证信封必须同属一组 / strict (default): every verified envelope in one bucket
    if (onDissent === 'reject' && buckets.size > 1) {
      disagree(`${buckets.size} distinct verified answers; TAP-23 rejects on any disagreement (pass onDissent:'quorum' to accept a dominant group instead)`,
        { quorum, agreed: [], disagreed: groups.flatMap((g) => g.containers), failed, groups })
    }
    const reaching = [...buckets.values()].filter((b) => b.containers.length >= quorum)
    if (reaching.length === 1) {
      const win = reaching[0]
      if (win.revert) fail(`${win.containers.length} providers agree the call reverts (${win.result.revert}); a revert is never an accepted result`, { quorum, agreed: [], disagreed: groups.flatMap((g) => g.containers), failed, groups })
      const disagreed = [...buckets.values()].filter((b) => b !== win).flatMap((b) => b.containers)
      return { result: win.result, agreed: win.containers, disagreed, failed, verified: true, quorum, responses: win.responses, groups }
    }
    if (reaching.length > 1) disagree(`ambiguous: ${reaching.length} distinct results each reached quorum ${quorum} (no majority vote)`, { quorum, agreed: [], disagreed: groups.flatMap((g) => g.containers), failed, groups })
    const why = reaching.length > 1
      ? `ambiguous: ${reaching.length} distinct results each reached quorum ${quorum} (no majority vote)`
      : answered < quorum ? `only ${answered}/${quorum} providers gave a verifiable answer` : `${answered} verified answers, no ${quorum}-way agreement`
    fail(why, { quorum, agreed: [], disagreed: groups.flatMap((g) => g.containers), failed, groups })
  }

  // ---- payer：本地累计 + EIP-712 voucher / local cumulative + EIP-712 vouchers ----
  // H-05 设计：签发与确认分离。reserve() 按提供者串行签出 cumulative = max(已确认, 在途最高) + price；
  // 响应到达后 commit()（ok 或非支付类签名错误）才推进已确认计数，传输失败 release()。
  // BAD_VOUCHER 携带 lastCumulative 时 resync() 采用 max(本地, lastCumulative)，api.call 会重试一次。
  // store（可选，{ get(key), set(key, value) }，值为十进制字符串，可异步）用于跨刷新持久化；默认内存。
  // Issuance and confirmation are separate. reserve() is serialised per provider and signs
  // cumulative = max(committed, highest in-flight) + price; commit() advances the committed counter only once the
  // provider answered (ok or a non-payment signed error); release() drops the reservation on transport failure.
  // resync(last) adopts max(local, lastCumulative) from a signed BAD_VOUCHER and api.call retries once.
  // `store` ({ get(key), set(key, value) }, decimal strings, may be async) persists across reloads; default memory.
  // sessionExpiry（可选，unix 秒）：仅用于在会话**已经失效**时拒绝签发，不截断 voucher.expires。
  // 合约（TapeAPIEscrow.settle）与 provider 都只要求会话在**结算时**有效；v2 没有撤销，会话只会自然过期
  // （最长 30 天，且只对一条 (consumer, provider) 通道有效）。把 expires 截到 sessionExpiry 会让每张凭证
  // 都在会话到期时作废，无谓地缩短提供者的结算余地。voucher.expires 只受 ttl 约束。
  // sessionExpiry (optional, unix seconds) is used ONLY to refuse issuing once the session has already
  // lapsed; it does not clamp voucher.expires. The escrow and the provider both require the session to
  // be live AT SETTLEMENT; v2 has no revoke, a session simply lapses (<= 30 days, and it is scoped to one
  // (consumer, provider) channel). Clamping expires to sessionExpiry would void every voucher at session
  // expiry and needlessly shorten the provider's settlement room. voucher.expires is bounded by ttl alone.
  function payer({ consumer, sessionKey, signTypedData, ttl = 3600, sessionExpiry, store } = {}) {
    if (!isAddress(consumer)) throw new TapeAPIError('BAD_VOUCHER', 'payer.consumer must be address')
    if (!sessionKey && typeof signTypedData !== 'function') throw new TapeAPIError('BAD_VOUCHER', 'payer needs sessionKey or signTypedData')
    if (store && (typeof store.get !== 'function' || typeof store.set !== 'function')) throw new TapeAPIError('BAD_VOUCHER', 'payer.store needs get(key) and set(key, value)')
    const signerAddr = sessionKey ? privateKeyToAddress(sessionKey) : checksumAddress(consumer)
    const consumerAddr = checksumAddress(consumer)
    const sessionEnd = sessionKey && sessionExpiry != null ? Number(sessionExpiry) : null
    if (sessionEnd !== null && !Number.isSafeInteger(sessionEnd)) throw new TapeAPIError('BAD_VOUCHER', 'payer.sessionExpiry must be unix seconds')
    const mem = new Map()
    const st = store || { get: (k) => mem.get(k) ?? null, set: (k, v) => { mem.set(k, v) } }
    const accounts = new Map() // chainId:escrow:provider -> { committed, loaded, inflight: Set<bigint>, chain }
    // 累计额是 (consumer, provider) 在**某一个托管合约**上的状态：换了 escrow，链上的 claimedOf 就是 0。
    // 计数器必须按 escrow（和 chainId）分开，否则服务改一次 payment.escrow 就能让老消费者把历史累计额
    // 重新签一遍，在新托管上被完整结算一次（H-07）。签名与计数必须用同一个地址，所以两者共用这个函数。
    // A cumulative is the state of (consumer, provider) ON ONE escrow: point the service at another escrow and its
    // claimedOf is 0 there. The counter is therefore keyed per escrow (and chainId) — otherwise flipping
    // payment.escrow makes a returning consumer re-sign the whole historical cumulative and settle it again on the
    // new escrow. Signing and counting must use the same address, hence one shared resolver.
    const escrowOf = (svc, required) => {
      const e = svc?.manifest?.payment?.escrow || escrow
      if (isAddress(e)) return checksumAddress(e)
      if (required) throw new TapeAPIError('BAD_VOUCHER', 'escrow address unknown')
      return null
    }
    const key = (svc) => {
      if (!svc?.container || !isAddress(svc.container)) throw new TapeAPIError('BAD_VOUCHER', 'svc.container missing')
      return `${chainId}:${(escrowOf(svc, false) || 'no-escrow').toLowerCase()}:${svc.container.toLowerCase()}`
    }
    const storeKey = (k) => `${consumerAddr.toLowerCase()}:${k}`
    const acct = (svc) => { const k = key(svc); let a = accounts.get(k); if (!a) { a = { k, committed: 0n, loaded: false, inflight: new Set(), chain: Promise.resolve() }; accounts.set(k, a) } return a }
    const serial = (a, fn) => { const p = a.chain.then(fn, fn); a.chain = p.catch(() => {}); return p }
    async function load(a) {
      if (a.loaded) return
      const v = await st.get(storeKey(a.k))
      if (v != null && v !== '') { const b = BigInt(v); if (b > a.committed) a.committed = b }
      a.loaded = true
    }
    const persist = (a) => Promise.resolve(st.set(storeKey(a.k), a.committed.toString()))
    const floor = (a) => { let f = a.committed; for (const n of a.inflight) if (n > f) f = n; return f }
    async function sign(svc, next) {
      const esc = escrowOf(svc, true)   // 与 key(svc) 同一个地址 / the same address the counter is keyed on
      const t = now()
      const expires = t + ttl
      // An already-lapsed session can sign nothing that will ever settle, so refuse locally rather than
      // spend a request finding out. A session that is live now but expires before the voucher does is
      // fine: settle() only requires the session to be live when it runs.
      // 已经失效的会话签什么都结算不掉，因此在本地直接拒绝，而不是发一次请求才发现。会话"现在有效、
      // 但早于凭证到期"是正常的：settle() 只要求会话在它执行的那一刻有效。
      if (sessionEnd !== null && sessionEnd < t) {
        throw new TapeAPIError('BAD_VOUCHER', `session key expired at ${sessionEnd}`)
      }
      const v = { consumer: consumerAddr, provider: svc.container, cumulative: next, expires }
      let sig
      if (sessionKey) sig = signDigest(voucherDigest(chainId, esc, v), sessionKey)
      else {
        sig = await signTypedData(voucherTypedData(chainId, esc, v))
        if (typeof sig !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new TapeAPIError('BAD_VOUCHER', 'signTypedData must return 65-byte hex signature')
      }
      return { consumer: v.consumer, provider: v.provider, cumulative: next.toString(), expires: v.expires, sig, signer: signerAddr }
    }
    const self = {
      consumer: consumerAddr, signer: signerAddr,
      // 已确认累计（未加载 store 前为 0）/ committed cumulative (0 until the store has been read)
      cumulativeOf: (svc) => acct(svc).committed,
      // 在途预留数 / number of in-flight reservations
      inflightOf: (svc) => acct(svc).inflight.size,
      // 从持久化/链上 claimed 恢复起点 / Resume from a persisted or on-chain cumulative.
      setCumulative: (svc, v) => { const a = acct(svc); a.committed = BigInt(v); a.loaded = true; return persist(a) },
      // 采用提供者报告的 lastCumulative——但只在它能被证明时。
      // 一个数字本身不构成证据。若无条件采纳，一个恶意提供者回报天文数字就能让本地签出
      // 一张榨干额度的凭证，而合约会按额度截断并足额支付。所以只接受两种来源：
      //   (a) 链上 claimedOf —— 任何人可独立核对；
      //   (b) 消费者自己签过的那张凭证 —— 用本地可重算的摘要验证签名。
      // 两者都给不出时拒绝同步，让调用以 BAD_VOUCHER 失败，由人来处理。
      // Adopt the provider's lastCumulative, but only when it can be proved. A bare number is not
      // evidence: adopting it unconditionally lets a hostile provider report an enormous figure,
      // have the client sign a voucher for it, and settle it clamped to the allowance -- draining
      // the consumer in one call. Only two sources are accepted: the on-chain claimed figure, which
      // anyone can verify independently, and a voucher the consumer itself signed, verified against
      // a locally recomputed digest. With neither, refuse and let the call fail loudly.
      resync: (svc, last, evidence) => serial(acct(svc), async () => {
        const a = acct(svc); await load(a)
        const b = BigInt(last)
        if (b <= a.committed) return a.committed

        // A2-01: the provider's `onChainClaimed` is a claim, not evidence -- it is the same party that named
        // `lastCumulative`. Read claimedOf from the service's own escrow ourselves; without an RPC the only
        // acceptable proof is our own signature below.
        // A2-01：提供者给的 `onChainClaimed` 只是它的说法，不是证据——它和报 `lastCumulative` 的是同一方。
        // 自己从该服务的托管读 claimedOf；没有 RPC 时，唯一可接受的证据是下面我们自己的签名。
        let onChain = null
        if (rpc) {
          try { onChain = BigInt(await view(escrowOf(svc, true), 'claimedOf', [consumerAddr, svc.container])) } catch { onChain = null }
        }
        let proved = onChain != null && onChain >= b

        const v = evidence?.voucher
        if (!proved && v && typeof v.sig === 'string' && String(v.cumulative) === String(last)) {
          try {
            // Rebuild exactly what sign() builds, or the recovery is meaningless.
            // 必须与 sign() 构造的内容逐字段一致，否则恢复出的地址没有意义。
            const esc = escrowOf(svc, true)
            const digest = voucherDigest(chainId, esc, {
              consumer: consumerAddr, provider: svc.container, cumulative: b, expires: Number(v.expires),
            })
            // Either of our own keys is acceptable evidence: the consumer signing directly (a wallet
            // flow) or the session key it authorised. The digest already binds `consumer`, so a
            // signature that recovers to one of them can only have come from us.
            // 两种自己的签名都算证据：消费者本人直签（钱包流程），或它授权的会话密钥。
            // 摘要本身已绑定 `consumer`，因此能恢复到这两者之一的签名只可能出自我方。
            const rec = recoverAddress(digest, v.sig)
            proved = eqAddr(rec, signerAddr) || eqAddr(rec, consumerAddr)
          } catch { proved = false }
        }
        if (!proved) {
          throw new TapeAPIError('BAD_VOUCHER',
            `provider reported lastCumulative ${last} without proof; refusing to advance the local counter`)
        }
        a.committed = b; await persist(a)
        return a.committed
      }),
      // 预留并签发一张凭证；返回 lease { voucher, next, commit(), release() } / reserve + sign; returns a lease
      reserve: (svc, price) => serial(acct(svc), async () => {
        const a = acct(svc); await load(a)
        const amount = BigInt(price)
        if (amount <= 0n) throw new TapeAPIError('BAD_VOUCHER', 'price must be positive')
        const next = floor(a) + amount
        const voucher = await sign(svc, next)
        a.inflight.add(next)
        let done = false
        return {
          voucher, next, amount,
          commit() { if (done) return Promise.resolve(); done = true; a.inflight.delete(next); if (next > a.committed) { a.committed = next; return persist(a).catch(() => {}) } return Promise.resolve() },
          release() { if (done) return; done = true; a.inflight.delete(next) },
        }
      }),
      // 手工构造请求用：签发并立即视为已消费 / manual use: sign and treat as consumed immediately
      async voucherFor(svc, price) { const lease = await self.reserve(svc, price); await lease.commit(); return lease.voucher },
    }
    return self
  }

  // ---- tx 构造 / calldata builders ----
  const hex = (n) => '0x' + BigInt(n).toString(16)
  const needEscrow = () => { if (!isAddress(escrow)) throw new TapeAPIError('MANIFEST_INVALID', 'escrow address not configured'); return escrow }
  // TAP-22 §3.4: a service names its escrow in its manifest, and clients MUST use that address. Every channel
  // builder therefore takes either a provider address (configured escrow) or a resolved service, whose own
  // payment.escrow wins -- otherwise a consumer could fund escrow A for a service that settles on escrow B (D15).
  // TAP-22 §3.4：服务在清单里指定托管合约，客户端 MUST 使用该地址。每个通道构造器接受提供者地址（用配置的托管）
  // 或已解析的服务（以其 payment.escrow 为准），否则消费者可能往 A 充值，而服务在 B 结算。
  const channelOf = (target) => {
    if (target && typeof target === 'object' && target.manifest) {
      const esc = target.manifest.payment?.escrow
      if (!isAddress(esc) || /^0x0{40}$/i.test(esc)) throw new TapeAPIError('MANIFEST_INVALID', `${target.container} names no escrow: it takes no payment`)
      return { to: esc, provider: target.container }
    }
    if (!isAddress(target)) throw new TapeAPIError('ABI_INVALID', 'provider must be an address or a resolved service')
    return { to: needEscrow(), provider: target }
  }
  const onChannel = (target, fn, args) => { const c = channelOf(target); return { to: c.to, data: encodeCall(fn, [c.provider, ...args]), value: '0x0' } }
  const tx = {
    // v2 escrow (TAP-22 §3.3): fund a channel toward ONE provider; the channel balance is that provider's cap.
    // v2 托管：向**一个**提供者的通道充值；通道余额即该提供者的上限。
    // The escrow moves BEM with transferFrom, so the FIRST transaction of any paid setup is this approval;
    // without it `fund` reverts inside the token with no useful message (traceability of the funding path).
    // 托管合约用 transferFrom 划转 BEM，因此任何付费流程的第一笔交易都是这个授权；缺了它 `fund` 会在代币里回滚且没有有用信息。
    // `amount` is REQUIRED: the spender may be an escrow the provider chose in its manifest (TAP-22 §3.4), so an
    // unlimited approval would hand a hostile provider the consumer's whole balance (review H-1). Approve what you fund.
    // `amount` 必填：被授权方可能是服务方在清单里选定的托管合约，无限授权等于把消费者全部余额交给恶意服务方。授权多少就充值多少。
    approve: ({ amount, token = MAINNET.bem, spender } = {}) => {
      if (!isAddress(token)) throw new TapeAPIError('ABI_INVALID', 'token must be an address')
      if (amount === undefined || amount === null) throw new TapeAPIError('ABI_INVALID', 'approve needs an amount: approve exactly what you will fund, never an unlimited allowance')
      const a = BigInt(amount)
      if (a <= 0n || a >= 2n ** 255n) throw new TapeAPIError('ABI_INVALID', 'approve amount must be positive and bounded')
      return { to: token, data: encodeCall('approve', [spender ? channelOf(spender).to : needEscrow(), a]), value: '0x0' }
    },
    fund: (provider, amount) => onChannel(provider, 'fund', [BigInt(amount)]),
    // requestWithdraw -> 48h cooldown -> withdraw inside a 7d window. `WithdrawRequested` is public: the provider
    // settles inside the cooldown, and while a request is alive the reference provider serves at most
    // channelOf − pendingWithdraw.amount (TAP-22 §3.2(4)).
    // 提现：请求 -> 48h 冷静期 -> 7 天窗口内执行。事件公开，提供者在冷静期内结算；请求存续期间参考提供者最多服务 通道余额 − 待提现额。
    requestWithdraw: (provider, amount) => onChannel(provider, 'requestWithdraw', [BigInt(amount)]),
    cancelWithdraw: (provider) => onChannel(provider, 'cancelWithdraw', []),
    withdraw: (provider) => onChannel(provider, 'withdraw', []),
    // per channel, extend-only, expires <= now + 30d; there is no revoke / 按通道授权，只可延长，最长 30 天，无撤销
    authorizeSession: (provider, key, expires) => onChannel(provider, 'authorizeSession', [key, BigInt(expires)]),
    settle: (v, svc) => ({ to: svc ? channelOf(svc).to : needEscrow(), data: encodeCall('settle', [v.consumer, v.provider, BigInt(v.cumulative), BigInt(v.expires), v.sig]), value: '0x0' }),
    // 持有人为自己的服务设置贡献比例（万分比，0..5000）/ holder opts a service in to a contribution (bps, 0..5000)
    setContribution: ({ circuits, tokenId, bps, escrow: esc }) => {
      const n = Number(bps)
      if (!Number.isInteger(n) || n < 0 || n > MAX_CONTRIBUTION_BPS) throw new TapeAPIError('ABI_INVALID', `bps must be an integer 0..${MAX_CONTRIBUTION_BPS}`)
      return { to: isAddress(esc) ? esc : needEscrow(), data: encodeCall('setContribution', [circuits, BigInt(tokenId), n]), value: '0x0' }
    },
    // `value` defaults to 0 on purpose. The directory keeps whatever is attached in every branch, and
    // the reference deployment sets labelFee to 0, so any BNB sent here is forfeited silently and
    // permanently. Read `labelFee()` first and pass exactly that, or nothing.
    // `value` 刻意默认为 0。目录在所有分支下都会保留随交易附带的 BNB，而参考部署的 labelFee 为 0，
    // 因此附带的任何金额都会被静默且永久地没收。请先读 `labelFee()` 并精确传入，或不传。
    // Write the manifest into the container's DeWEB site (TapeKit SPEC Appendix B.5): one `putFile` for the first
    // ≤ 24,000 bytes, then `appendChunk` per further chunk. Returns the transactions in the order they MUST be sent,
    // signed by the circuit holder (or a SiteRegistry operator). The key is the bare `.well-known/tapeapi.json`.
    // 把清单写进容器的 DeWEB 站点：第一块 ≤ 24,000 字节走 putFile，其余逐块 appendChunk。返回必须按顺序发送的交易，
    // 由电路持有者（或 SiteRegistry 操作员）签名。键是裸的 `.well-known/tapeapi.json`。
    publishManifest: ({ container, manifest, contentType = 'application/json' }) => {
      if (typeof container !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(container)) throw new TapeAPIError('MANIFEST_INVALID', 'publishManifest: container must be an address')
      const text = typeof manifest === 'string' ? manifest : JSON.stringify(manifest)
      let parsed
      try { parsed = JSON.parse(text) } catch (e) { throw new TapeAPIError('MANIFEST_INVALID', `publishManifest: manifest is not JSON: ${e.message}`) }
      validateManifest(parsed)
      if (typeof parsed.container === 'string' && parsed.container.toLowerCase() !== container.toLowerCase()) {
        throw new TapeAPIError('MANIFEST_INVALID', `publishManifest: manifest.container ${parsed.container} is not the target container ${container}`)
      }
      const bytes = new TextEncoder().encode(text)
      if (bytes.length > MANIFEST_LIMIT) throw new TapeAPIError('MANIFEST_INVALID', `publishManifest: ${bytes.length} bytes exceeds the TAP-20 limit of ${MANIFEST_LIMIT}`)
      const sha256Hash = toHex(sha256(bytes))
      const CHUNK = 24_000
      const txs = []
      for (let i = 0, idx = 0; i < bytes.length; i += CHUNK, idx++) {
        const part = toHex(bytes.subarray(i, i + CHUNK))
        txs.push(idx === 0
          ? { to: siteRegistry, data: encodeCall('putFile', [container, MANIFEST_KEY, contentType, sha256Hash, part]), value: '0x0' }
          : { to: siteRegistry, data: encodeCall('appendChunk', [container, MANIFEST_KEY, BigInt(idx), part]), value: '0x0' })
      }
      return { txs, key: MANIFEST_KEY, size: bytes.length, sha256Hash }
    },
    removeManifest: (container) => ({ to: siteRegistry, data: encodeCall('removeFile', [container, MANIFEST_KEY]), value: '0x0' }),
    /**
     * Publish a channel identity record (TAP-26 §3.1) in the container's site: the same putFile path as a manifest.
     * `record` is what scripts/channel-keys.mjs prints once the holder's wallet has signed. Removing the file is how
     * a holder withdraws the identity before it expires.
     * 在容器站点发布通道身份记录，与清单走同一条 putFile 路径。删除该文件即可在到期前撤回身份。
     */
    publishChannelKeys: ({ container, record }) => {
      if (!isAddress(container)) throw new TapeAPIError('CHANNEL_INVALID', 'publishChannelKeys: container must be an address')
      if (!record || record.tapechannel !== '1' || !eqAddr(record.container, container)) throw new TapeAPIError('CHANNEL_INVALID', 'publishChannelKeys: record must be a tapechannel "1" record for this container')
      const bytes = new TextEncoder().encode(canonicalJSON(record))
      if (bytes.length > CHANNEL_KEYS_LIMIT) throw new TapeAPIError('CHANNEL_INVALID', `publishChannelKeys: ${bytes.length} bytes exceeds ${CHANNEL_KEYS_LIMIT}`)
      return { txs: [{ to: siteRegistry, data: encodeCall('putFile', [container, CHANNEL_KEYS_KEY, 'application/json', toHex(sha256(bytes)), toHex(bytes)]), value: '0x0' }], key: CHANNEL_KEYS_KEY, size: bytes.length, sha256Hash: toHex(sha256(bytes)) }
    },
    removeChannelKeys: (container) => ({ to: siteRegistry, data: encodeCall('removeFile', [container, CHANNEL_KEYS_KEY]), value: '0x0' }),
    register: ({ circuits, tokenId, label, manifestPath = MANIFEST_KEY, value = 0n }) => ({   // registry form, no leading slash (TAP-20 §3.2) / 注册表形式，无前导斜杠
      to: needDirectory(),
      data: encodeCall('register', [circuits, BigInt(tokenId), label ? labelToBytes32(label) : '0x' + '00'.repeat(32), manifestPath]),
      value: hex(value),
    }),
  }

  // Consent to the service's CURRENT prices (all methods, or one). / 同意该服务当前的价格（全部方法或其中一个）。
  function acceptPrice(svc, method) {
    const owner = ownerOf(svc)
    if (owner) return owner.acceptPrice(svc, method)
    const cur = pricesOf(svc.manifest)
    const acc = ACCEPTED.get(svc) || {}
    if (method === undefined) ACCEPTED.set(svc, cur)
    else { if (!(method in cur)) throw new TapeAPIError('METHOD_NOT_FOUND', `method ${method} not in manifest`); ACCEPTED.set(svc, { ...acc, [method]: cur[method] }) }
    return ACCEPTED.get(svc)
  }
  const acceptedPrice = (svc, method) => { const owner = ownerOf(svc); return owner ? owner.acceptedPrice(svc, method) : ACCEPTED.get(svc)?.[method] }

  /**
   * TAP-27 §3.3 step 6: a verifier for group rosters. Each member's keys must equal the channel record its circuit's
   * holder published; records are cached for GROUP_VERIFY_CACHE_S (300 s) in the client's identity cache (arch B7).
   * 群名单核验器：每个成员的密钥必须等于其电路持有人发布的通道记录；记录只缓存 300 秒（客户端身份缓存）。
   */
  function groupVerifier() {
    // Cached for minutes, not until the record expires: a circuit that changes hands must drop out of every group
    // it was in (TAP-26 §3.1). A record that is definitively invalid answers false; an RPC failure throws, so a
    // flaky node never gets a member dropped. The cache is the client's identity cache (arch B7), shared with
    // chain.channelKeys; the owner's re-verification at a new epoch passes { fresh: true } (group.js).
    // 只缓存几分钟：电路转手后必须退出所在的每个群。记录确定无效返回 false；RPC 故障则抛出，节点抖动绝不会导致成员被移除。
    // 缓存即客户端的身份缓存（与 chain.channelKeys 共用）；群主开新纪元时的重新核验传 { fresh: true }（group.js）。
    return async (m, { fresh = false } = {}) => {
      if ((m.chainId ?? chainId) !== chainId) throw new TapeAPIError('GROUP_INVALID', `${m.container} is on chain ${m.chainId}; this client reads chain ${chainId}`)
      let rec
      try { rec = await chain.channelKeys(m.container, { fresh }) }
      catch (e) { if (e instanceof TapeAPIError && ['CHANNEL_INVALID', 'NOT_FOUND'].includes(e.code)) return false; throw e }
      return rec.x25519 === String(m.x25519).toLowerCase() && rec.ed25519 === String(m.ed25519).toLowerCase()
    }
  }

  // `forChain(id)`: the client for another TapeOut chain (this one for its own); `chainOfContainer(address)`: which chain a
  // container lives on. / `forChain(id)`：另一条 TapeOut 链的客户端；`chainOfContainer(address)`：容器在哪条链上。
  const api = { resolve, refresh, acceptPrice, acceptedPrice, call, callQuorum, payer, tx, rpc, chain, chainId, groupVerifier, addresses: { hub, siteRegistry, directory, escrow }, randomPrivateKey, forChain, chainOfContainer }
  return api
}
