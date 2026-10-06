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
  recoverResponseSigner, randomPrivateKey, manifestContentDigest, manifestContentHash, MANIFEST_CONTENT_FIELD,
} from './sig.js'
import { validateManifest, findMethod, methodPrice, parseUnits, formatUnits, METHOD_NAME_RE, BEM_DECIMALS, MAX_DELEGATION_S } from './manifest.js'
import { canonicalJSON, safeParseJSON } from './canon.js'
import { validateAIField, MANIFEST_FIELD as AI_FIELD } from './ai.js'
import { CHAIN_IDS, chainById, parseTapeName, parseTapeInput, formatTapeName, IMPL_SLOT, MAX_TOKEN_ID } from './chains.js'
import { TAP10_SEALS, PAYMENT_TOKENS, AUDITED_ESCROWS } from './chains.js'
import { rpcUrlsFor } from './rpc-defaults.js'
// TAP-10 §4.3 processor tables (about 75 KB), read only by the conformance mode and siteStatus. A static import: the SDK
// runs in the browser as plain modules, without dynamic imports (scripts/build-playground.mjs).
// TAP-10 §4.3 处理器表（约 75 KB），只有一致模式与 siteStatus 读取。静态导入：SDK 在浏览器里以普通模块运行，不用动态导入。
import { PROCESSORS_SNAPSHOT } from './processors-snapshot.js'
import { erc6551Account } from './security.js'
import { verifyAccountProof, STORAGE, LAYOUT_IMPLEMENTATIONS, addressOfWord } from './proof.js'

// Default nodes per chain and who operates them (quorums count operators, not URLs) / 各链默认节点及其运营方
export { RPC_DEFAULTS, rpcUrlsFor, operatorOf } from './rpc-defaults.js'
// The TapeOut chains (BNB Smart Chain, X Layer, Base) and names with area codes / TapeOut 各链与带区号的名字
export { CHAINS, CHAIN_IDS, HOME_CHAIN_ID, IMPL_SLOT, chainById, chainByArea, chainByKey, parseTapeName, formatTapeName, isNameShaped, parseTapeInput, MAX_TOKEN_ID, MAX_PROCESSOR } from './chains.js'
// @experimental (1.5) TAP-10 §13.8 messaging constants and the §12.1 endpoint chainId bound / TAP-10 消息层常量
export { TAP10_SEALS, TAP10_MAX_CHAIN_ID } from './chains.js'
// @experimental (TAPI-22 §3.5) escrow token labels and the audited escrow deployments (empty) / 托管代币标签与已审计托管名单（空）
export { PAYMENT_TOKENS, AUDITED_ESCROWS } from './chains.js'
export { TapeAPIError, createRpc, canonicalJSON, safeParseJSON, validateManifest, parseUnits, formatUnits, labelToBytes32, METHOD_NAME_RE, BEM_DECIMALS }
export * as abi from './abi.js'
export * as sig from './sig.js'
export * as channel from './channel-public.js'   // TAPI-26 real-time private channel / 实时私密通道
export * as busPrivacy from './bus-privacy.js'   // ChannelBus reads that hide your rooms among cover rooms / 以掩护房间降低通道读取的关联性
import * as channelLib from './channel.js'
export * as group from './group-public.js' // TAPI-27 private group channels / 私密群聊
// TAPI-27 delivery in one call: epoch message to the group room AND invites to each member's inbox room / 一步投递
export { deliverGroupUpdate, checkGroupInvites } from './group-delivery.js'
export * as tapesend from './tapesend.js' // TAP-10 sealed messages, byte-compatible with @tapekit/send / TapeSend 密封消息
export * as webmcp from './webmcp.js'      // expose a service's methods as WebMCP agent tools / 把服务的方法注册为 WebMCP 代理工具
export * as mcp from './mcp.js'            // MCP server core: tools with signed results and receipts / MCP 服务器核心：带签名结果与回执的工具
export * as ai from './ai-public.js'       // AI usage receipts: format adapters, hashing, prices, verification / AI 用量回执：格式适配器、哈希、价格、核验
// @experimental security 1.1: local container derivation, ContradictionRecord v1, random second opinions
// @experimental 安全加固 1.1：本地推导容器、矛盾记录 v1、随机抽查
export * as security from './security.js'
// @experimental security 1.2: RLP and Merkle-Patricia proof checks (EIP-1186), the storage slots resolve can prove
// @experimental 安全加固 1.2：RLP 与默克尔-帕特里夏证明核验（EIP-1186），以及 resolve 能证明的存储槽
export * as proof from './proof.js'

// TAPI-22 §3.4 贡献比例常量 / contribution constants (basis points).
export const MAX_CONTRIBUTION_BPS = 2000          // contract hard cap, 20% (5000 before 2026-10-05) / 合约硬上限 20%（2026-10-05 前为 5000）
export const DEFAULT_CONTRIBUTION_BPS = 100       // contract constant: applies until the holder sets a value / 合约常量：持有人设定前适用
// @experimental (TAPI-22 §3.5) An escrow amount in whole tokens plus the token's label and address; `token` from
// api.chain.escrow.paymentToken() (decimals are never assumed). / 托管金额按整币显示，小数位绝不假设。
export function formatPaymentAmount(amount, token) {
  if (!token || typeof token !== 'object' || !Number.isInteger(token.decimals) || typeof token.display !== 'string') throw new TapeAPIError('INVALID_ARGUMENT', 'formatPaymentAmount needs the token api.chain.escrow.paymentToken() returns: decimals are read from the token, never assumed')
  return `${formatUnits(amount, token.decimals)} ${token.display}`
}
export const RECOMMENDED_CONTRIBUTION_BPS = 100  // older name for the same 100; since 2026-09-28 it is the contract default / 旧名，同一个 100，现为合约默认值

// 主网默认地址 / Mainnet defaults (DESIGN.md).
export const MAINNET = {
  chainId: 56,
  hub: '0xe61A9C7213a6Aa616C246a2B569e555B417b25ee',
  siteRegistry: '0xd006ffdd5Ae313B17729621A00999cD3C71CE5e6',
  factory: '0x68224F668083c29e9800Be2a646d42d18cedF7e2',   // TapeOut processor factory: isCPU(circuits) / 处理器工厂
  bem: '0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a',
  channelBus: '0x486110c35d9b90a9d6D85c8063A065f9e7b6b707',   // TAPI-26 §3.7, deployed 2026-09-26, code checked against the tested build / 已部署，代码与测试构建逐字节一致
}
// Operators (operatorOf): 48 Club, 1RPC (a relay whose upstream is not published), NodeReal (the dataseed). Three by
// name; since 1RPC's upstream is unknown, count on two independent ones. Frames authenticate themselves, so the bus
// reader takes the union of what each node serves; only eth_blockNumber goes through the operator quorum.
// 运营方：48 Club、1RPC（上游未公开的转发）、NodeReal（dataseed）。名义上三家；1RPC 上游不明，按两家独立计。帧自带认证，
// 总线读取取各节点的并集；只有 eth_blockNumber 走按运营方的法定数。
// Nodes for reading ChannelBus (TAPI-26 §3.7), which needs eth_getLogs: the dataseed nodes refuse it. Measured
// 2026-09-27: 48 Club and 1RPC serve logs with long history (≥ 500k blocks), the dataseed serves receipts; with these
// three the reader read a real frame 73,700 blocks back. Use a dedicated client: createRpc({ urls: BUS_RPC_URLS,
// quorum: 2, timeoutMs: 15000 }) (1RPC can take several seconds). Keep eth_call reads on your usual node set.
// 读 ChannelBus 用的节点（需要 eth_getLogs，dataseed 拒绝）：48 Club 与 1RPC 提供日志且历史长，dataseed 提供回执；
// 实测用这三个读回了 73,700 个区块前的真实帧。请单独建客户端，timeoutMs 15000。
export const BUS_RPC_URLS = Object.freeze(['https://rpc-bsc.48.club', 'https://1rpc.io/bnb', 'https://bsc-dataseed.bnbchain.org'])
export const MANIFEST_PATH = '/.well-known/tapeapi.json'   // fixed by TAPI-20 §3.2; never taken from a directory record
// SiteRegistry keys carry NO leading slash (TapeKit SPEC §6 step 3 strips it; mainnet 4246.0.tape stores `index.html`,
// and `/index.html` answers size 0). Every registry call goes through registryKey(), so the URL form above and the
// bare key are interchangeable for callers. Found 2026-09-21 by the first live mainnet probe (scripts/probe-mainnet.mjs).
// SiteRegistry 的键不带前导斜杠（TapeKit SPEC §6 第 3 步会去掉它；主网 4246.0.tape 存的是 `index.html`，查 `/index.html`
// 得 size 0）。所有注册表调用都经过 registryKey()，因此调用方写 URL 形式或裸键都可以。2026-09-21 首次主网实测发现。
export const MANIFEST_KEY = '.well-known/tapeapi.json'
// TAPI-26 §3.1: a container's channel identity, published in its DeWEB site beside the manifest.
// TAPI-26 §3.1：容器的通道身份，与清单一起发布在它的 DeWEB 站点里。
export const CHANNEL_KEYS_KEY = '.well-known/tape-channel.json'
export const CHANNEL_KEYS_LIMIT = 4 * 1024
export const CHANNEL_ISSUED_SKEW_S = 300   // a record's `issued` may be this far ahead of our clock / 记录的 issued 至多超前本地时钟这么多
const GROUP_VERIFY_CACHE_S = 300
// Identity cache shared by TAPI-26 and TAPI-27 (arch B7): at most GROUP_VERIFY_CACHE_S (TAPI-27 §3.3 step 6), bounded size.
// TAPI-26 与 TAPI-27 共用的身份缓存：至多 GROUP_VERIFY_CACHE_S 秒（TAPI-27 §3.3 第 6 步），条目数有上限。
export const IDENTITY_CACHE_S = GROUP_VERIFY_CACHE_S
export const IDENTITY_CACHE_SIZE = 1024
export function registryKey(path) {
  if (typeof path !== 'string') throw new TapeAPIError('INVALID_ARGUMENT', 'registry path must be a string')
  return path.replace(/^\/+/, '')
}
// TapeOut names (TapeKit SPEC §2.2 / §2.4 and kernel/src/name.js, TAPI-20 §3.6 step 1; spec review SD-12). The canonical
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
export const MANIFEST_LIMIT = 64 * 1024        // TAPI-20: manifest ≤ 64 KiB
export const ENVELOPE_LIMIT = 1024 * 1024      // TAPI-21 §3.2: response body ≤ 1 MiB
// TAPI-20 §3.6: clients SHOULD re-read a cached manifest about once an hour. / 客户端 SHOULD 每小时左右重读清单。
export const MANIFEST_TTL_MS = 3600_000
// TAP-11 §7.1 / TAP-10 §11 (conformance mode): the holder and site status are not relied on for more than 60 seconds
// without a reread. / 一致模式：持有人与站点状态不超过 60 秒不重读。
export const CONFORM_TTL_MS = 60_000
// The conformance mode's statuses that mean "could not read", not a verdict / 表示"读不到"而非结论的状态
const TRANSIENT_STATUS = new Set(['unavailable', 'stale-block'])
export const DEFAULT_MAX_SKEW_S = 300          // TAPI-21 §3.2: reject |now − ts| > 300 s
const now = () => Math.floor(Date.now() / 1000)
// `clock` (security 1.1, as for groups, review G1 M4): a function returning Unix seconds. Every `now` of a client reads it;
// without it, Date.now. A value that looks like milliseconds is refused rather than misread.
// `clock`：返回 Unix 秒的函数（与群相同）。客户端的每个 `now` 都读它；没给就读 Date.now。看起来是毫秒的值直接拒绝。
function clockOf(clock) {
  if (clock === undefined) return now
  if (typeof clock !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', 'clock must be a function returning Unix seconds')
  return () => {
    const v = clock()
    if (typeof v !== 'number' || !Number.isFinite(v) || v > 1e11) throw new TapeAPIError('INVALID_ARGUMENT', `clock must return Unix seconds: it returned ${typeof v === 'number' ? v : typeof v}`)
    return Math.floor(v)
  }
}
// Warnings shown once per process when the caller gave no onWarning (security 1.1) / 调用方没给 onWarning 时，每个进程只显示一次
const shownWarnings = new Set()
const consoleWarning = (w) => {
  const key = `${w.code}:${w.message}`
  if (shownWarnings.has(key) || shownWarnings.size > 256) return
  shownWarnings.add(key)
  console.warn(`[tapeapi] ${w.code}: ${w.message}`)
}
// The pinning option (security 1.1) against the chain's own settings; null = unpinned (the default: chains.js `pin` is
// 'latest'). / 钉块选项；null 表示不钉块（默认：chains.js 的 `pin` 为 'latest'）。
function pinOptionsOf(pin, known) {
  const bad = (m) => { throw new TapeAPIError('INVALID_ARGUMENT', `pin: ${m}`) }
  // @experimental (1.4) TAP-10 §5.3: the Q-th highest operator head minus 2, fresh by block lag (chains.js tap10MaxPinLag),
  // reads pinned to its hash. / TAP-10 §5.3：第 Q 高的运营方头块减 2，按块差判新鲜度，读取钉在它的哈希上。
  if (pin === 'tap10') {
    if (!Number.isSafeInteger(known?.tap10MaxPinLag)) bad("'tap10' needs a TapeOut chain listed in chains.js (its TAP-10 §2.1 max pin lag)")
    return { mode: 'tap10', tag: 'tap10', by: 'hash', cacheS: 0, maxLag: known.tap10MaxPinLag }
  }
  if (pin === undefined) pin = (known?.pin ?? 'latest') === 'latest' ? false : true
  if (pin === false || pin === 'latest') return null
  if (pin === true) pin = {}
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) bad("pass true, false, 'latest' or { tag, maxAgeS, by, cacheS }")
  const tag = pin.tag ?? known?.finality ?? 'finalized'
  if (!['finalized', 'safe', 'latest'].includes(tag)) bad("tag must be 'finalized', 'safe' or 'latest'")
  const maxAgeS = pin.maxAgeS ?? known?.maxPinAgeS ?? 300
  if (!Number.isSafeInteger(maxAgeS) || maxAgeS < 1) bad('maxAgeS must be a positive whole number of seconds')
  const by = pin.by ?? 'hash'
  if (by !== 'hash' && by !== 'number') bad("by must be 'hash' (EIP-1898 blockHash) or 'number'")
  const cacheS = pin.cacheS ?? 0
  if (!Number.isSafeInteger(cacheS) || cacheS < 0) bad('cacheS must be a whole number of seconds')
  return { tag, maxAgeS, by, cacheS }
}
// The proofs option (security 1.2): null = off (the default), 'warn' (proofs: true) or 'strict'. Only with pin: a proof is
// checked against the stateRoot of the block the nodes confirmed, and an unpinned resolution has no such block.
// 证明选项（安全加固 1.2）：null 为关闭（默认），'warn'（proofs: true）或 'strict'。只能与 pin 一起用：证明要对照节点确认的区块的
// stateRoot 核验，不钉块的解析没有这样的区块。
function proofOptionOf(proofs, pinConf) {
  if (proofs === undefined || proofs === false) return null
  if (proofs !== true && proofs !== 'strict') throw new TapeAPIError('INVALID_ARGUMENT', "proofs: pass true (check proofs, warn and fall back to the quorum reads when none can be had), 'strict' (refuse) or false")
  if (!pinConf) throw new TapeAPIError('INVALID_ARGUMENT', "proofs needs pin: a proof is checked against the stateRoot of the block that nodes of `quorum` operators confirm, and only a pinned resolution has one; pass createTapeAPI({ pin: true, proofs })")
  return proofs === true ? 'warn' : 'strict'
}
// A node that refused eth_getProof outright (the method is not there, or it will not prove that state) or served a proof
// that does not verify is not asked for one again for this long. A rate limit, a timeout or a broken connection is no
// such statement: that node is asked again next time (FIXED PROOFR-1: one 429 from the only node that serves proofs on
// BNB Smart Chain stopped 'strict' for ten minutes).
// 明确拒绝 eth_getProof 的节点（没有该方法，或不肯证明该状态）或给出核验不过的证明的节点，在这段时间内不再被索取证明。限流、
// 超时、连接断开不是这种表态：下次照常再问（FIXED PROOFR-1：BSC 上唯一提供证明的节点一次 429，就让 'strict' 停摆十分钟）。
const PROVER_SKIP_MS = 10 * 60_000
const RATE_WORDS = /rate|too many requests|throttl|quota|capacity|exceeded|limit reached|per second/i
// How a prover failed: 'refused' (skip it for PROVER_SKIP_MS) or 'transient' (ask it again next time). What single().call
// throws: RPC_UNAVAILABLE with data.refusals when the node answered with a node-limit error (-32601, -32005, 429, ...),
// RPC_ERROR when it answered another JSON-RPC error ("missing trie node", a proof window), RPC_UNAVAILABLE without
// refusals for a timeout, an HTTP error or a broken connection. -32005 counts as a refusal unless its words say rate limit.
// 证明节点失败的方式：'refused'（跳过 PROVER_SKIP_MS）或 'transient'（下次再问）。single().call 抛出的：节点以节点限制错误作答
// 时为带 data.refusals 的 RPC_UNAVAILABLE；以其它 JSON-RPC 错误作答时为 RPC_ERROR；超时、HTTP 错误、断连为不带 refusals 的
// RPC_UNAVAILABLE。-32005 算拒绝，除非措辞说的是限流。
function proverFailure(e) {
  const r = e?.data?.refusals?.[0]
  if (r) {
    const code = Number(r.code), msg = String(r.message ?? '')
    if (code === -32601 || (/method.*(?:not found|does not exist)|does not exist|not (?:available|supported)|unsupported/i.test(msg) && !RATE_WORDS.test(msg))) return 'refused'
    if (code === -32005) return RATE_WORDS.test(msg) ? 'transient' : 'refused'
    return 'transient'
  }
  if (e instanceof TapeAPIError && e.code === 'RPC_ERROR') {
    // a node lagging behind the pinned block says so; it will have it soon / 落后于所钉区块的节点会这么说，它很快就会有
    return /header.*not found|block.*not found|unknown block|not found.*block/i.test(String(e.message)) ? 'transient' : 'refused'
  }
  return 'transient'
}
const isFloorStore = (x) => !!x && typeof x.get === 'function' && typeof x.set === 'function'
// An execution revert: the chain's answer. rpc.js reports every JSON-RPC error all nodes agree on as RPC_ERROR, a
// revert (geth code 3, or "execution reverted" under -32000) and "header not found" alike (review R2-2); it marks
// `rpcRevert` only when EVERY answering node reported a revert, since the message is just the first node's (review R3-4).
// 执行回滚：链的回答。rpc.js 把所有节点一致的 JSON-RPC 错误都报为 RPC_ERROR，回滚与 "header not found" 不分；只有每个作答节点
// 都报回滚时才标 `rpcRevert`，因为消息只是第一个节点的。
const isRevert = (e) => e instanceof TapeAPIError && e.code === 'RPC_ERROR' && (Number(e.data?.rpcCode) === 3 || e.data?.rpcRevert === true)
// Start a read now and use its outcome later, exactly where the sequential code would have read it: a failure is held
// (never an unhandled rejection) and thrown by the `await` at that point, so checks and error codes keep their order.
// 现在就发出读取，在原本顺序读取的位置才使用结果：失败先被保留（不会成为未处理的拒绝），在那个位置的 `await` 抛出，
// 检查与错误码的先后不变。
const early = (read) => {
  let p
  try { p = Promise.resolve(read()) } catch (e) { p = Promise.reject(e) }
  p.catch(() => {})
  return p
}
// Each client's own TAP-10 identity steps, for the client of another chain that resolves input without chain information
// on every chain (allChains, TAP-10 §4.1). Not exported. / 每个客户端自己的 TAP-10 身份步骤，供另一条链的客户端在所有链上解析
// 无链信息的输入时调用（allChains）。不导出。
const TAP10_LOCAL = new WeakMap()
const uuid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : toHex(crypto.getRandomValues(new Uint8Array(16))).slice(2))

// 选项 / options:
//   rpcUrls, quorum (默认 2)：urls 或其不同运营方（operatorOf）少于 quorum 直接抛 RPC_UNAVAILABLE；只有 allowSingleNode: true
//                        才允许下调（开发用，M-11）。quorum counts operators: URLs of one operator count once.
//   quiet: true          silence the rpc "no spare" notice, here and on other chains unless chains[id].quiet / 不显示"没有余量"提示
//   dev: true            允许 resolve({ dev }) 与 http:// 端点；不改变链上来源清单的 holder 校验（M-06）
//   allowHttp: true      非 dev 下也接受 http:// 端点（仅测试）/ accept http endpoints outside dev (tests only)
//   maxSkewS (默认 300)  信封 ts 与本地时钟的最大偏差（TAPI-21 §3.2）/ envelope ts freshness window
//   identityCacheS (默认 300，上限 300；0 = 不缓存), identityCacheSize (默认 1024)：通道身份缓存（arch B7）
//                        channel-identity cache for chain.channelKeys and groupVerifier (0 disables; never above 300 s)
//   chains              其它链的节点：{ [chainId]: { rpcUrls, quorum (默认 2), rpcTimeoutMs, allowSingleNode, quiet } }。解析别的链上的
//                        名字或 { chainId, ... } 时，本客户端为那条链建一个子客户端（api.forChain(chainId)），节点取这里的
//                        rpcUrls，没给就取 SDK 的默认节点 rpcUrlsFor(chainId)（chains.js 与 rpc-defaults.js）。
//                        nodes for the other TapeOut chains. Resolving a name on another chain (1.2.344.tape is X Layer) or a
//                        { chainId, ... } target goes through a client for that chain (api.forChain(chainId)) whose nodes
//                        are chains[chainId].rpcUrls or else the SDK's defaults for it (rpcUrlsFor). Payments stay on BNB
//                        Smart Chain: a priced method of a service on another chain is refused (PAYMENT_REQUIRED).
//   chainId (默认 56), hub, siteRegistry, factory：合约地址，默认为该链在 chains.js 里的地址（56 即 MAINNET）。directory 与 escrow 没有默认值：
//                        不传就没有（主网尚无部署的目录与托管）；付费服务用它自己清单里的 escrow（TAPI-22 §3.4）。
//                        contract addresses, mainnet (MAINNET) by default. `directory` and `escrow` have NO default (MAINNET
//                        names neither): without them there is no directory cross-check and no configured escrow; a priced
//                        service is paid through the escrow its own manifest names (TAPI-22 §3.4). On any other chain pass `factory` (the TapeOut
//                        processor factory, isCPU) with hub and siteRegistry: the mainnet factory has no code there, and
//                        every identity and manifest read fails with BAD_KEY (review R2-6).
//                        在其它链上须与 hub、siteRegistry 一起传 `factory`（TapeOut 处理器工厂）：主网工厂在那里没有代码，
//                        每次身份与清单读取都会以 BAD_KEY 失败。
export function createTapeAPI(opts = {}) {
  // 1.0 (review G1 S4): the RPC timeout is `rpcTimeoutMs`; `timeoutMs` is the per-call option of api.call only.
  // 1.0：RPC 超时改名 rpcTimeoutMs；timeoutMs 只是 api.call 的每次调用选项。
  const renamed = 'the option `timeoutMs` of createTapeAPI was renamed `rpcTimeoutMs` in 1.0 (it is the timeout of one RPC request; api.call keeps its own timeoutMs): see https://tapeapi.fun/docs/en/upgrade-1.0'
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'timeoutMs')) throw new TapeAPIError('INVALID_ARGUMENT', renamed)
  for (const [id, c] of Object.entries(opts?.chains ?? {})) if (c && Object.prototype.hasOwnProperty.call(c, 'timeoutMs')) throw new TapeAPIError('INVALID_ARGUMENT', `chains[${id}]: ${renamed}`)
  const chainId = opts.chainId ?? MAINNET.chainId
  // A chain chains.js knows brings its own addresses; any other chain falls back to MAINNET's (and then needs opts.factory,
  // review R2-6). / chains.js 认识的链用它自己的地址；其它链退回 MAINNET 的地址（此时须传 opts.factory）。
  const known = chainById(chainId)
  const hub = opts.hub ?? known?.hub ?? MAINNET.hub
  const factory = opts.factory ?? known?.factory ?? MAINNET.factory
  const siteRegistry = opts.siteRegistry ?? known?.siteRegistry ?? MAINNET.siteRegistry
  const { directory, escrow } = opts
  // TAP-10 §2.2 container opener and payment contract (DomainBinding): read by the conformance mode and siteStatus only
  // TAP-10 §2.2 的容器开通器与付费合约：只有一致模式与 siteStatus 读取
  const opener = opts.opener ?? known?.opener ?? null
  const binding = opts.binding ?? known?.binding ?? null
  const fetchImpl = opts.fetch || globalThis.fetch?.bind(globalThis)
  const devMode = opts.dev === true
  const allowHttp = devMode || opts.allowHttp === true
  const maxSkewS = Number.isFinite(opts.maxSkewS) ? Number(opts.maxSkewS) : DEFAULT_MAX_SKEW_S
  // ---- security 1.1 options (all @experimental, see the security 1.1 hardening design) / 安全加固 1.1 的选项 ----
  //   clock               a function returning Unix seconds (default Date.now) / 返回 Unix 秒的时钟
  //   pin                 pin every read of one resolution to one block confirmed by nodes of `quorum` operators and no
  //                       older than maxAgeS: true | { tag, maxAgeS, by: 'hash' | 'number', cacheS }. Default: unpinned.
  //                       把一次解析的全部读取钉在 quorum 家运营方确认、且不旧于 maxAgeS 的同一个区块上。默认不钉块。
  //   sentinel            'warn' (default) | 'strict' | 'off': check the ERC-1967 implementations of the DeWebHub and the
  //                       SiteRegistry against chains.js expectedImpl, and re-derive the container locally (ERC-6551).
  //                       核对 DeWebHub 与 SiteRegistry 的实现是否为已知版本，并在本地重新推导容器。默认只警告。
  //   requireContentSig   refuse a manifest without a valid holder content signature (TAPI-20 §3.10). Default false.
  //                       要求清单带有效的持有人内容签名。默认不要求。
  //   delegationFloor     true | { get, set, delete? }: refuse a delegation whose signed `expires` is below the highest
  //                       seen for that container, holder and signer (api.clearDelegationFloor forgets one). Default off.
  //                       拒绝 expires 低于同一容器、持有人与签名者已见最大值的委托。默认关闭。
  //   onWarning           (warning) => void; default: console.warn once per distinct warning. / 警告回调。
  //   proofs              (security 1.2) true | 'strict': with pin, check ownerOf, fileInfo, cpuAt and isCPU against Merkle
  //                       proofs (eth_getProof, from any node) of the pinned block's stateRoot. A verified proof that
  //                       contradicts the quorum's answer is refused in both modes (PROOF_INVALID). When no proof can be
  //                       had (no node serves one, none verifies, the layout is unknown) true warns and keeps the quorum
  //                       reads (detection only); 'strict' refuses (PROOF_UNAVAILABLE, PROOF_INVALID).
  //                       钉块时，用区块 stateRoot 的默克尔证明核对 ownerOf、fileInfo、cpuAt 与 isCPU。已核验的证明与法定数的
  //                       回答矛盾时，两种模式都拒绝（PROOF_INVALID）。拿不到可用证明时（没有节点提供、都核验不过、布局未知），
  //                       true 警告并沿用法定数读取（只是检测）；'strict' 拒绝。
  //   conform             @experimental (1.4) 'tap10': resolve as TAP-10 v1.1 and TAP-11 §2.2 say (the resolution path; see
  //                       docs/guides/upgrade-1.0.md "TAP-10 conformance mode"). Implies pin: 'tap10'. Since 1.5 also the
  //                       messaging path: chain.tapeSendKey and chain.channelKeys read as TAP-10 §12.2 / §14.4 say. Since
  //                       1.5.0 resolve checks eth_chainId and reads ownerOf and a contract holder's EIP-1271 calls under
  //                       strict agreement.
  //                       按 TAP-10 v1.1 与 TAP-11 §2.2 解析（解析路径）。隐含 pin: 'tap10'。1.5 起也包括消息路径。1.5.0 起
  //                       resolve 用严格共识检查 eth_chainId、读取 ownerOf 与合约持有人的 EIP-1271 调用。
  //   allChains           @experimental (1.5) true: input without chain information (a container address or a processor
  //                       contract#ID string, TAP-10 §4.1) is resolved on EVERY TapeOut chain, each at its own pinned block:
  //                       `ambiguous` when more than one resolves it, and the status of a chain that could not be read instead
  //                       of `not-tapeout`. This sends reads to the nodes of Base and X Layer as well (chains[id].rpcUrls, or
  //                       the SDK's defaults for that chain), which is why it is a separate switch: a client given only its
  //                       own BNB Smart Chain node never talks to other chains' public nodes unless asked. It applies to the
  //                       TAP-10 path only: resolve under conform: 'tap10', and siteStatus in any mode; the default resolve
  //                       never reads it. Only `true` turns it on; any other value is ignored, as 1.4 ignored the option.
  //                       Off: a container address is resolved on this client's chain when it is a container of this chain
  //                       (an ERC-6551 address commits to one chain, TAP-10 §4.1), and is `unsupported` otherwise; under
  //                       conform: 'tap10' a processor contract#ID string is `unsupported` before any request, because
  //                       TAP-10 resolves it only when exactly one chain does (siteStatus on a default client resolves it on
  //                       this client's chain, as in 1.4). { circuits, tokenId, chainId? } names its chain (this client's
  //                       when chainId is left out) and { chainId, container } names its own: neither is searched;
  //                       { container } without chainId is an input error (as in 1.4).
  //                       true：无链信息的输入（容器地址或"处理器合约#ID"字符串，TAP-10 §4.1）在**每条** TapeOut 链上各自钉块解析：
  //                       多条链命中即 ambiguous，某条链读不到时报该链的状态而不报 not-tapeout。这会向 Base 与 X Layer 的节点发请求
  //                       （chains[id].rpcUrls 或 SDK 对该链的默认节点），所以是单独的开关：只配了自己 BSC 节点的客户端，不明确要求
  //                       就绝不访问别的链的公共节点。只作用于 TAP-10 路径：一致模式下的 resolve，以及任何模式下的 siteStatus；默认的
  //                       resolve 从不读它。只有 true 才开启，其它值一律忽略（1.4 就忽略这个选项）。关闭时：容器地址是本链容器即在本链
  //                       解析（ERC-6551 地址只属于一条链），否则 unsupported；一致模式下"处理器合约#ID"字符串在发出任何请求之前即为
  //                       unsupported，因为 TAP-10 只在恰好一条链命中时才解析它（默认客户端的 siteStatus 与 1.4 一样在本链解析）。
  //                       { circuits, tokenId, chainId? } 指明链（不给 chainId 即本客户端的链），{ chainId, container } 自带链：都不搜索；
  //                       不带 chainId 的 { container } 是输入错误（与 1.4 相同）。
  const now = clockOf(opts.clock)
  // undefined, null and false all mean off: 1.3 ignored the option, so a value it ignored must not start failing in 1.4
  // undefined、null、false 都表示关闭：1.3 会忽略这个选项，它忽略过的值在 1.4 不能开始报错
  if (opts.conform !== undefined && opts.conform !== null && opts.conform !== false && opts.conform !== 'tap10') throw new TapeAPIError('INVALID_ARGUMENT', "conform: pass 'tap10' (TAP-10 v1.1), or leave it out (undefined, null or false)")
  const conformMode = opts.conform === 'tap10'
  // Only true turns allChains on; any other value is ignored, never refused: 1.4 ignored the option, so a value it ignored
  // must not start failing (the same rule as conform above). / 只有 true 开启；其它值忽略而不报错：1.4 忽略这个选项。
  const allChains = opts.allChains === true
  //   allowEscrows        @experimental (TAPI-22 §3.5) escrows, besides AUDITED_ESCROWS (empty), that tx.approve / tx.fund
  //                       may build for. Default none; `escrow` is not added. / 允许 approve / fund 的托管，默认没有。
  if (opts.allowEscrows != null && (!Array.isArray(opts.allowEscrows) || !opts.allowEscrows.every(isAddress))) throw new TapeAPIError('INVALID_ARGUMENT', 'allowEscrows must be an array of escrow addresses')
  const allowedEscrows = new Set([...(AUDITED_ESCROWS[Number(chainId)] ?? []), ...(opts.allowEscrows ?? [])].map((a) => a.toLowerCase()))
  if (conformMode && opts.pin !== undefined && opts.pin !== 'tap10') throw new TapeAPIError('INVALID_ARGUMENT', "conform: 'tap10' pins every resolution as TAP-10 §5.3 does (pin: 'tap10'); it cannot be combined with another pin option (false, 'latest', true or { tag })")
  const pinConf = pinOptionsOf(conformMode ? 'tap10' : opts.pin, chainById(chainId))
  const proofMode = proofOptionOf(opts.proofs, pinConf)
  const sentinelMode = opts.sentinel ?? 'warn'
  if (!['warn', 'strict', 'off'].includes(sentinelMode)) throw new TapeAPIError('INVALID_ARGUMENT', "sentinel must be 'warn', 'strict' or 'off'")
  // The conformance mode is fail-closed on the site store and payment contract implementations (TAP-10 §6.1): a proxy with
  // no accepted list could only ever be store-changed, so it is a configuration mistake, said now.
  // 一致模式对站点存储与付费合约的实现 fail-closed：没有接受列表的代理只会永远是 store-changed，所以是配置错误，现在就说。
  if (conformMode) {
    for (const [role, a] of [['opener', opener], ['binding', binding], ['siteRegistry', siteRegistry], ['factory', factory]]) if (!isAddress(a)) throw new TapeAPIError('INVALID_ARGUMENT', `conform: 'tap10' needs the ${role} address of chain ${chainId}`)
    for (const [role, a] of [['siteRegistry', siteRegistry], ['binding', binding]]) {
      if (!known?.expectedImpl?.[String(a).toLowerCase()]) throw new TapeAPIError('INVALID_ARGUMENT', `conform: 'tap10' accepts only the ${role} proxies TAP-10 lists with their accepted implementations (chains.js expectedImpl); ${a} on chain ${chainId} has none`)
    }
    // 1.5, the messaging path: only the hub TAP-10 lists, whose current implementation is known (chains.js TAP10_SEALS);
    // another would be hub-changed for ever / 1.5 消息路径：只接受 TAP-10 列出的中枢，否则永远是 hub-changed
    if (!eqAddr(hub, known?.hub) || !TAP10_SEALS[Number(chainId)]) throw new TapeAPIError('INVALID_ARGUMENT', `conform: 'tap10' accepts only the DeWEB hub TAP-10 lists for chain ${chainId} (${known?.hub}), whose current implementation is in chains.js TAP10_SEALS; got ${hub}`)
    // TAP-10 §2.2: only the addresses listed for that chain, never learned elsewhere: the factory and the opener too
    // TAP-10 §2.2：只用该链列出的地址；工厂与开通器同样如此
    for (const [role, a] of [['factory', factory], ['opener', opener]]) {
      if (!eqAddr(a, known?.[role])) throw new TapeAPIError('INVALID_ARGUMENT', `conform: 'tap10' uses only the ${role} TAP-10 lists for chain ${chainId} (${known?.[role]}; TAP-10 §2.2); got ${a}`)
    }
  }
  if (opts.requireContentSig !== undefined && typeof opts.requireContentSig !== 'boolean') throw new TapeAPIError('INVALID_ARGUMENT', 'requireContentSig must be a boolean')
  const requireContentSig = opts.requireContentSig === true
  if (opts.delegationFloor !== undefined && typeof opts.delegationFloor !== 'boolean' && !isFloorStore(opts.delegationFloor)) throw new TapeAPIError('INVALID_ARGUMENT', 'delegationFloor must be true, false or a { get, set } store')
  const delegationFloor = opts.delegationFloor === true ? new Map() : (isFloorStore(opts.delegationFloor) ? opts.delegationFloor : null)
  if (opts.onWarning !== undefined && typeof opts.onWarning !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', 'onWarning must be a function')
  const onWarning = opts.onWarning ?? consoleWarning
  const rpc = (opts.rpcUrls && opts.rpcUrls.length)
    ? createRpc({ urls: opts.rpcUrls, quorum: opts.quorum ?? 2, timeoutMs: opts.rpcTimeoutMs, fetch: fetchImpl, allowSingleNode: opts.allowSingleNode === true, quiet: opts.quiet === true })
    : null
  // Highest `issued` seen per container's channel record (arch B4). Pass a persistent Map-like { get, set } to keep it
  // across restarts. / 每个容器通道记录见过的最高 `issued`；传入持久化的 { get, set } 可跨重启保留。
  const recordFloor = opts.channelRecordFloor ?? new Map()
  // @experimental (1.5) The conformance mode's sticky TAP-10 §13.8 statuses (circuits-changed, a factory seal seen and then
  // lost), kept per `${chainId}:${hub, lowercase}`. Default: this client instance only. Pass a persistent Map-like
  // { get, set } (as for channelRecordFloor) to keep them across restarts; every chain's client shares it (forChain).
  // Value: { circuitsChangedAt: number | null, factorySealSeenAt: number | null, factorySealLost: boolean } (block numbers).
  // 一致模式的 §13.8 粘性状态，按 `${chainId}:${小写 hub}` 保存。默认只在本客户端实例内；传入持久化的 { get, set } 可跨重启保留。
  if (opts.sealStatusStore !== undefined && !isFloorStore(opts.sealStatusStore)) throw new TapeAPIError('INVALID_ARGUMENT', 'sealStatusStore must be a { get, set } store')
  const sealStatusStore = opts.sealStatusStore ?? new Map()
  // The key is `${chainId}:${container, lowercase}` and the value an integer (Unix seconds), frozen for 1.x (review G1 M7).
  // A 0.x store keyed by the container alone is read once and moved under the new key: an ERC-6551 address commits to
  // one chainId, so an old entry can only belong to that chain. Every chain's client shares the one store (forChain).
  // 键为 `${chainId}:${小写容器地址}`，值为整数（Unix 秒），1.x 内冻结。0.x 只按容器地址存的条目读一次并迁到新键。
  const floorKey = (container) => `${chainId}:${String(container).toLowerCase()}`
  async function readFloor(container) {
    const k = floorKey(container)
    const v = await recordFloor.get(k)
    if (v != null) return v
    const old = await recordFloor.get(String(container).toLowerCase())
    if (old == null) return 0
    await recordFloor.set(k, old)
    return old
  }
  const identityTtlS = Math.min(IDENTITY_CACHE_S, Math.max(0, Number.isFinite(opts.identityCacheS) ? Math.floor(opts.identityCacheS) : IDENTITY_CACHE_S))
  const identityMax = Number.isInteger(opts.identityCacheSize) && opts.identityCacheSize > 0 ? opts.identityCacheSize : IDENTITY_CACHE_SIZE
  const needRpc = () => { if (!rpc) throw new TapeAPIError('INVALID_ARGUMENT', `rpcUrls not configured: pass createTapeAPI({ rpcUrls: rpcUrlsFor(${chainId}) }) for the SDK's default nodes of this chain, or your own`); return rpc }
  const needDirectory = () => { if (!isAddress(directory)) throw new TapeAPIError('INVALID_ARGUMENT', 'directory address not configured'); return directory }
  const needFetch = () => { if (typeof fetchImpl !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', 'no fetch implementation'); return fetchImpl }

  // ---- 链读 / chain reads ----
  // `at`: the block every read of one resolution is pinned to (security 1.1): 'latest' unless the client pins.
  // `at`：一次解析的全部读取所钉的区块；客户端不钉块时为 'latest'。
  async function view(to, name, args, at = 'latest') { return decodeReturn(name, await needRpc().ethCall(to, encodeCall(name, args), at)) }
  const readTarget = (p) => {
    if (!(p && typeof p === 'object' && p.manifest)) return { to: escrow, provider: p }
    const to = p.manifest.payment?.escrow
    if (!isAddress(to) || /^0x0{40}$/i.test(to)) throw new TapeAPIError('INVALID_ARGUMENT', `${p.container} names no escrow: it takes no payment`)
    return { to, provider: p.container }
  }
  // resolve's cache of facts that do not change once they exist, read under the same quorum as any read (through chain.*,
  // so every check on the answer is the same) and kept for at most FACT_TTL_MS:
  // hub.accountOf(circuits, tokenId) is a CREATE2 derivation (a function of its inputs and the hub), and
  // factory.cpuAt(n) of an existing processor never changes (the processor list is append-only; isCPU true is kept for
  // good below on the same ground). Only an answer is kept, never an error: a processor past the end may exist later,
  // and an RPC failure is not a fact. Concurrent reads of one fact share one read, which is what removes resolve's
  // second, identical accountOf. The cap (300 s, as the identity cache) bounds what a replaced hub or factory could
  // leave behind, and the cache lives in this client: every chain has its own client (forChain), and the key names
  // the chain and the contract, so no fact of one chain is ever used on another.
  // resolve 用的缓存：存在之后就不再改变的事实，与其它读取同样过法定数（经 chain.*，对回答的检查相同），最多保留 FACT_TTL_MS：hub.accountOf 是 CREATE2 推导（只取决于输入与 hub），
  // 已存在的处理器的 factory.cpuAt(n) 不会改变（处理器列表只增不删；下面 isCPU 为 true 永久保留也是这个理由）。只保留回答，
  // 绝不保留错误：超出范围的处理器以后可能出现，RPC 故障也不是事实。同一事实的并发读取共用一次读取，resolve 里第二次、
  // 完全相同的 accountOf 就是这样省掉的。上限 300 秒（与身份缓存相同）约束 hub 或工厂被替换时可能留下的旧值；缓存属于本客户端：
  // 每条链有自己的客户端（forChain），键里还写明链与合约，一条链的事实绝不会用到另一条链上。
  const FACT_TTL_MS = IDENTITY_CACHE_S * 1000
  const facts = new Map()   // key -> { at, p }, oldest first / 旧的在前
  function fact(key, read) {
    const e = facts.get(key)
    if (e && Date.now() - e.at < FACT_TTL_MS) return e.p
    const p = read()
    facts.delete(key); facts.set(key, { at: Date.now(), p })
    while (facts.size > 4096) facts.delete(facts.keys().next().value)
    p.catch(() => { if (facts.get(key)?.p === p) facts.delete(key) })
    return p
  }
  // Only resolve reads through these; api.chain.accountOf / cpuAt still read the chain every time, as documented.
  // 只有 resolve 经由它们读取；api.chain.accountOf / cpuAt 仍然每次读链，与文档一致。
  const factAccountOf = (circuits, tokenId, at = 'latest') => { const t = BigInt(tokenId); return fact(`${chainId}:${String(hub).toLowerCase()}:accountOf:${String(circuits).toLowerCase()}:${t}`, () => view(hub, 'accountOf', [circuits, t], at)) }
  const factCpuAt = (processor, at = 'latest') => { const n = BigInt(processor); return fact(`${chainId}:${String(factory).toLowerCase()}:cpuAt:${n}`, () => cpuAtAt(n, at)) }
  // The reads resolve makes, at a block (`at`); api.chain.* below are the same reads at 'latest'.
  // resolve 所做的读取，带区块参数；下面的 api.chain.* 是同样的读取、在 'latest'。
  async function cpuAtAt(processor, at) {
    try { return await view(factory, 'cpuAt', [BigInt(processor)], at) }
    catch (e) { if (e.code === 'RPC_ERROR' && /revert/i.test(e.message)) throw new TapeAPIError('NOT_FOUND', `processor ${processor} does not exist`); throw e }
  }
  async function isCPUAt(circuits, at) {
      const k = String(circuits).toLowerCase()
      if (knownCPUs.has(k)) return true
      // '0x' is what a node answers for an address with no code: a factory missing on this chain (the mainnet
      // default on chain ≠ 56) is a configuration error, never a verdict about the circuit (review R2-6).
      // 对没有代码的地址节点答 '0x'：本链上没有该工厂（例如在非 56 链上用了主网默认值）是配置错误，而不是对电路的判定。
      const raw = await needRpc().ethCall(factory, encodeCall('isCPU', [circuits]), at)
      if (typeof raw === 'string' && /^0x$/i.test(raw)) throw new TapeAPIError('BAD_KEY', `factory ${factory} has no code on chain ${chainId}; pass opts.factory (the TapeOut processor factory of this chain)`)
      const yes = decodeReturn('isCPU', raw) === true
      if (yes && knownCPUs.size < 4096) knownCPUs.add(k)
      return yes
  }
  const chain = {
    accountOf: (circuits, tokenId) => view(hub, 'accountOf', [circuits, BigInt(tokenId)]),
    /** Processor contract number `processor` (the number in <#ID>.<processor>.tape); NOT_FOUND past the last one.
     *  处理器编号对应的合约；超出范围为 NOT_FOUND。 */
    cpuAt: (processor) => cpuAtAt(processor, 'latest'),
    /** TapeKit SPEC §3.3 step 2: only a factory-deployed processor is TapeOut. true is cached for good (the processor
     *  list is append-only); false is not. / 只有工厂部署的处理器才是 TapeOut。true 永久缓存（列表只增不删），false 不缓存。 */
    isCPU: (circuits) => isCPUAt(circuits, 'latest'),
    /**
     * TAPI-26 §3.1: a container's channel identity (X25519 for handshakes, Ed25519 for TAPI-27 group messages), read
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
     *
     * @experimental (1.5) With conform: 'tap10' the record is read as the private-channels draft §3.3 says (readChannelKeysTap10):
     * a fresh TAP-10 pinned block, strict agreement, the container from the opener, both site-store implementations
     * accepted; never activation or opening (TAP-10 §12.2). The result then carries `tap10`, errors `data.status`. A record
     * served from the cache keeps the `tap10.pinned` of the read that filled it; `{ fresh: true }` pins anew.
     * 一致模式下按私密通道草稿 §3.3 读取：新鲜钉块、严格共识、开通器、两个站点合约实现都被接受；绝不判激活或开通。
     */
    channelKeys: (container, { fresh = false } = {}) => {
      if (!isAddress(container)) return Promise.reject(conformMode ? withStatus(new TapeAPIError('INVALID_ARGUMENT', 'channelKeys takes a container address')) : new TapeAPIError('INVALID_ARGUMENT', 'channelKeys takes a container address'))
      // the conformance mode: every error carries data.status / 一致模式：每个错误都带 data.status
      return conformMode ? identities.lookup(container, { fresh }).catch((e) => { throw withStatus(e) }) : identities.lookup(container, { fresh })
    },
    // TAPI-26 §3.1 fallback: a container's TapeSend (TAP-10) X25519 key. The hub withholds it unless the holder who
    // published it still holds the circuit; we still re-derive the container and check the endpoint, suite and flag.
    // TAPI-26 §3.1 备用：容器的 TapeSend 密钥。只要发布者已不再持有电路，hub 就不返回它；我们仍核对端点、套件与可用标志。
    // @experimental (1.5) With conform: 'tap10': TAP-10 §12.2, §13.8 and §14.4 steps 1-3 (tapeSendKeyTap10); the result
    // carries `tap10`, errors `data.status`. / 一致模式下按 TAP-10 §12.2、§13.8、§14.4 第 1–3 步读取。
    tapeSendKey: async (target) => {
      // 1.5: the conformance mode resolves and reads the TAP-10 way (tapeSendKeyTap10) / 1.5：一致模式按 TAP-10 读取
      if (conformMode) { try { return await tapeSendKeyTap10(target) } catch (e) { throw withStatus(e) } }
      let circuits, tokenId, expect = null
      if (typeof target === 'string') {
        if (!isAddress(target)) throw new TapeAPIError('INVALID_ARGUMENT', 'tapeSendKey takes a container address or { circuits, tokenId }')
        expect = target
        // tokenOf: an outage is an error, not NOT_FOUND (review R2-2) / 故障是错误，不是 NOT_FOUND
        ;({ circuits, tokenId } = await tokenOf(target))
      } else if (target && isAddress(target.circuits) && target.tokenId != null) {
        circuits = target.circuits; tokenId = BigInt(target.tokenId)
      } else throw new TapeAPIError('INVALID_ARGUMENT', 'tapeSendKey takes a container address or { circuits, tokenId }')
      await requireCPU(circuits, 'CHANNEL_INVALID')
      const [container, endpoint, opened, current, suite, keyIndex, key, usable, version, chains] = await view(hub, 'keyFor', [circuits, tokenId])
      if (expect && !eqAddr(container, expect)) throw new TapeAPIError('CHANNEL_INVALID', `hub derives ${container} for (${circuits}, ${tokenId}), not ${expect}`)
      const want = '0x' + '00'.repeat(4) + BigInt(chainId).toString(16).padStart(16, '0') + container.slice(2).toLowerCase()
      if (String(endpoint).toLowerCase() !== want) throw new TapeAPIError('CHANNEL_INVALID', `hub returned endpoint ${endpoint}, expected ${want}`)
      if (!usable) throw new TapeAPIError('NOT_FOUND', `${container} has no usable TapeSend key (never published, revoked, or the circuit changed hands since)`)
      if (Number(suite) !== 1) throw new TapeAPIError('CHANNEL_INVALID', `unsupported key suite ${suite}; TAPI-26 needs suite 1 (X25519)`)
      return {
        container: checksumAddress(container), chainId, circuits: checksumAddress(circuits), tokenId: tokenId.toString(),
        staticPublic: String(key).toLowerCase(), keyIndex: Number(keyIndex), version: Number(version),
        holder: checksumAddress(current), opened: !!opened, chainsBitmap: BigInt(chains).toString(2),
      }
    },
    ownerOf: (circuits, tokenId) => view(circuits, 'ownerOf', [BigInt(tokenId)]),
    /** ERC-6551 token() of a container on this chain: { circuits, tokenId }, tokenId a decimal string like every tokenId
     *  the SDK returns (review G1 S6; inputs still take any BigNumberish). NOT_FOUND when it is no container here,
     *  CHANNEL_INVALID when it names another chain. / 容器在本链上的 token()；tokenId 为十进制字符串。 */
    tokenOf: async (container) => { const t = await tokenOf(container); return { circuits: checksumAddress(t.circuits), tokenId: t.tokenId.toString() } },
    resolve: (label) => view(needDirectory(), 'resolve', [labelToBytes32(label)]),
    serviceOf: (container) => view(needDirectory(), 'serviceOf', [container]),
    readFile: (container, path) => view(siteRegistry, 'read', [container, registryKey(path)]),
    fileInfo: (container, path) => view(siteRegistry, 'fileInfo', [container, registryKey(path)]),
    // v2 escrow reads are per (consumer, provider) channel; `channelOf` is the pre-flight figure (it is the cap).
    // v2 托管的读取按 (消费者, 提供者) 通道进行；预检看 `channelOf`（它就是上限）。
    escrow: {
      // `p` may be a provider address (configured escrow) or a resolved service (its own escrow, TAPI-22 §3.4)
      // `p` 可以是提供者地址（用配置的托管）或已解析的服务（用它自己的托管）
      channelOf: (c, p) => { const t = readTarget(p); return view(t.to, 'channelOf', [c, t.provider]) },
      claimedOf: (c, p) => { const t = readTarget(p); return view(t.to, 'claimedOf', [c, t.provider]) },
      sessionExpiry: (c, p, k) => { const t = readTarget(p); return view(t.to, 'sessionExpiry', [c, t.provider, k]) },
      pendingWithdraw: (c, p) => { const t = readTarget(p); return view(t.to, 'pendingWithdraw', [c, t.provider]) },
      // 服务可自选 escrow，故允许覆盖地址 / a service picks its own escrow, so the address may be overridden
      contributionOf: (p, esc = escrow) => view(esc, 'contributionOf', [p]),
      treasury: (esc = escrow) => view(esc, 'treasury', []),
      // Escrow v3: the immutable token; contributions accrued, unclaimed / 托管 v3：不可变代币；金库应收未领
      token: (esc = escrow) => view(escrowAddressOf(esc), 'escrowToken', []),
      treasuryAccrued: (esc = escrow) => view(escrowAddressOf(esc), 'treasuryAccrued', []),
      // token() then decimals(), strict, cached (readPaymentToken) / 严格共识读取代币与小数位
      paymentToken: (esc = escrow) => paymentTokenOf(escrowAddressOf(esc)),
      // Read-only: one provider's bps on several instances, warning when they differ / 只读：多实例贡献比例比对
      contributions: (p, escrows) => contributionsAcross(p, escrows),
    },
  }

  // TAPI-26 §3.1 channel record, read from the chain every time: no cache here (the cache is `identities`, below).
  // 从链上读取通道记录，每次都读：这里不缓存（缓存在下面的 `identities`）。
  async function readChannelKeys(container) {
    // 1.5: the conformance mode reads the record the TAP-10 way (below) / 1.5：一致模式按 TAP-10 读取记录（见下）
    if (conformMode) return readChannelKeysTap10(container)
    const { circuits, tokenId } = await tokenOf(container)
    // The container's own token() is only a claim: the hub must derive this very address from that circuit, as
    // the manifest path checks (TAPI-20 §3.6). / 容器自己的 token() 只是声称；中枢必须由该电路推导出同一地址。
    const derived = await chain.accountOf(circuits, tokenId)
    if (!eqAddr(derived, container)) throw new TapeAPIError('CHANNEL_INVALID', `hub.accountOf(${circuits}, ${tokenId}) is ${derived}, not ${container}`)
    await requireCPU(circuits, 'CHANNEL_INVALID')
    const file = await readVerifiedFile(container, CHANNEL_KEYS_KEY, { limit: CHANNEL_KEYS_LIMIT, code: 'CHANNEL_INVALID' })
    const { r, inbox, digest } = channelRecordOf(() => new TextDecoder('utf-8', { fatal: true }).decode(file.bytes), container)
    let recovered = null
    if (r.sig.length === 132) { try { recovered = recoverAddress(digest, r.sig) } catch { /* a contract holder signs no ECDSA / 合约持有人没有 ECDSA 签名 */ } }
    const holder = await chain.ownerOf(circuits, tokenId)
    if (!(recovered && eqAddr(recovered, holder)) && !(await holderApproves(holder, digest, r.sig))) {
      throw new TapeAPIError('CHANNEL_INVALID', `${container}: channel keys were not authorised by the current holder ${holder}`)
    }
    await raiseRecordFloor(container, r)
    return channelRecordResult(container, circuits, tokenId, holder, r, inbox)
  }
  // The record's own checks, the same in both modes (TAPI-26 §3.1): no request. `decode` gives the text.
  // 记录本身的检查，两种模式相同：不发请求。`decode` 给出文本。
  function channelRecordOf(decode, container) {
    let r
    try { r = safeParseJSON(decode(), { code: 'CHANNEL_INVALID' }) }
    catch (e) { throw new TapeAPIError('CHANNEL_INVALID', `${CHANNEL_KEYS_KEY}: ${e.message}`) }
    const bad = (m) => { throw new TapeAPIError('CHANNEL_INVALID', `${CHANNEL_KEYS_KEY} of ${container}: ${m}`) }
    if (!r || typeof r !== 'object' || r.tapechannel !== '1') bad('tapechannel must be "1"')
    if (!eqAddr(r.container, container)) bad(`names container ${r.container}`)
    if (r.chainId !== chainId) bad(`is for chain ${r.chainId}, not ${chainId}`)
    // "0x<64 hex>" (TAPI-26 §3.1): fromHex also takes bare hex, and a bare key would be accepted here yet never equal
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
    return { r, inbox, digest }
  }
  // Only an authorised record moves the floor, and never down. / 只有已授权的记录能抬高下限，且绝不降低。
  async function raiseRecordFloor(container, r) {
    const floor = await readFloor(container)
    if (r.issued < floor) throw new TapeAPIError('CHANNEL_INVALID', `${CHANNEL_KEYS_KEY} of ${container}: issued ${r.issued} is older than a record already seen (${floor}): a replaced record was put back`)
    if (r.issued > floor) await recordFloor.set(floorKey(container), r.issued)
  }
  const channelRecordResult = (container, circuits, tokenId, holder, r, inbox) => ({
    container: checksumAddress(container), chainId, circuits: checksumAddress(circuits), tokenId: tokenId.toString(),
    staticPublic: r.x25519.toLowerCase(), x25519: r.x25519.toLowerCase(), ed25519: r.ed25519.toLowerCase(), issued: r.issued, expires: r.expires,
    holder: checksumAddress(holder), keys: channelLib.KEYS_CHANNEL,
    inbox: { room: channelLib.inboxRoom(container, chainId), relays: inbox.relays ?? [], ...(inbox.bus ? { bus: inbox.bus } : {}) },
  })

  // ════ TAP-10 conformance mode, the messaging path (@experimental, 1.5) / TAP-10 一致模式：消息路径 ══════════════════
  // With conform: 'tap10', api.chain.tapeSendKey resolves the endpoint as TAP-10 §12.2 says and reads the key as §14.4
  // steps 1-3 say, and api.chain.channelKeys reads the channel record as the private-channels draft §3.3 says (TAPI-26
  // §3.1 under TAP-10's read rules). Both: a fresh TAP-10 pinned block (§5.3), every read under STRICT agreement (§5.2:
  // every configured node, all equal, from max(2, min(3, operators)) operators), after an eth_chainId check that is itself
  // strict (§5.4, a MUST for messaging; resolve's default-agreement check does not count), the container from the opener
  // (§4.2, §4.3), only results and reverts as answers (§1). NEVER activation or opening: §12.2 says an unpaid name, a
  // changed site-store implementation or a blocklist entry MUST NOT prevent messaging, so tapeSendKey reads neither the
  // site store nor the payment contract. The channel record is a site file, so its read needs both site-store
  // implementations accepted (store-changed, TAP-10 §6.1) but still not activation or opening. tapeSendKey also reads the
  // hub's seal status at the same block (§13.8): a hub implementation other than the current one TAP-10 lists is
  // hub-changed, a circuit beacon not on circuitImplementation is circuits-changed, kept for good by this client.
  // Every error carries data.status; the codes are the default mode's for the same situation.
  // 一致模式下，api.chain.tapeSendKey 按 TAP-10 §12.2 解析端点、按 §14.4 第 1–3 步读密钥；api.chain.channelKeys 按私密通道草稿 §3.3
  // 读通道记录。两者：新鲜的 TAP-10 钉块、每个读取都用严格共识、先做严格共识的 eth_chainId 检查（§5.4 对消息是 MUST；resolve 的默认共识
  // 检查不算）、容器取自开通器、只有结果与回滚算回答。**绝不**判激活或开通：§12.2 规定未付费、站点存储实现变更或阻止名单都不得阻止消息，
  // 所以 tapeSendKey 既不读站点存储也不读付费合约。通道记录是站点文件，所以读它要求两个站点合约的实现都被接受（store-changed），但仍不判
  // 激活或开通。tapeSendKey 还在同一块上读中枢的封存状态（§13.8）：中枢实现不是 TAP-10 列为当前的那个即 hub-changed，电路信标不在
  // circuitImplementation 即 circuits-changed，本客户端永久保留。每个错误都带 data.status；错误码与默认模式同一情形相同。
  const TAP10_STRICT = { answers: 'tap10', strict: true }
  const sealsOf = TAP10_SEALS[Number(chainId)] ?? null
  async function viewStrict(to, name, args, at) { return decodeReturn(name, await needRpc().ethCall(to, encodeCall(name, args), at, TAP10_STRICT)) }
  const readsWrong = (e) => isRevert(e) || (e instanceof TapeAPIError && e.code === 'ABI_INVALID')
  // One 32-byte word of a no-argument call, or null when it reverts or is not one word (§13.8 "any revert ... counts as not
  // in effect") / 无参调用的一个 32 字节字；回滚或不是一个字时为 null
  async function wordStrict(to, sig, at) {
    let raw
    try { raw = String(await needRpc().ethCall(to, selector(sig), at, TAP10_STRICT)) } catch (e) { if (isRevert(e)) return null; throw e }
    return /^0x[0-9a-fA-F]{64}$/.test(raw) ? raw.toLowerCase() : null
  }
  // A canonical address word (upper 96 bits zero), else null / 规范的地址字（高 96 位为零），否则为 null
  const addressOfWordStrict = (w) => (w && /^0x0{24}[0-9a-f]{40}$/.test(w) ? '0x' + w.slice(26) : null)
  async function implSlotStrict(proxy, at) {
    const word = String(await needRpc().call('eth_getStorageAt', [proxy, IMPL_SLOT, at], TAP10_STRICT))
    if (!/^0x[0-9a-fA-F]{64}$/.test(word)) throw tapErr('RPC_ERROR', 'unavailable', `eth_getStorageAt(${proxy}) answered ${word.slice(0, 80)}`)
    return addressOfWordStrict(word.toLowerCase())
  }
  // §5.4 under strict agreement, once per client; only a success is kept / 严格共识的 §5.4，每个客户端一次；只保留成功
  let chainCheckedStrict = null
  function checkChainStrict() {
    if (chainCheckedStrict) return chainCheckedStrict
    const p = (async () => {
      const got = Number(BigInt(await needRpc().call('eth_chainId', [], TAP10_STRICT)))
      if (got !== Number(chainId)) throw tapErr('INVALID_ARGUMENT', 'wrong-chain', `wrong-chain: the nodes of this client answer eth_chainId ${got}, not ${chainId} (TAP-10 §5.4)`, { expected: Number(chainId), answered: got })
      return true
    })()
    chainCheckedStrict = p
    p.catch(() => { if (chainCheckedStrict === p) chainCheckedStrict = null })
    return p
  }
  // A fresh pinned block for one key lookup or one record read (§5.3, §14.4 step 1). The pin's eth_blockNumber and
  // eth_getBlockByNumber go out concurrently with the strict eth_chainId; no state read is sent until both succeeded.
  // 一次查询一个新鲜钉块。钉块的 eth_blockNumber、eth_getBlockByNumber 与严格的 eth_chainId 并发；两者都成功之后才发出任何状态读取。
  async function messagingPin() { const [pinned] = await Promise.all([tap10Pin(), checkChainStrict()]); return pinned }
  const pinnedView = (b) => ({ number: b.number, hash: b.hash, lag: b.lag, maxLag: b.maxLag })

  // §12.2 identity: §4.3 for a container address (token(), isCPU, opener.accountOf equal to it), §4.2 steps 3-5 for a
  // processor contract and #ID, at one pinned block under strict agreement. The processor number (§4.3 step 3) is not
  // needed to message and is not looked up. `also` reads go out in the same turn as accountOf. No site status.
  // §12.2 的身份：容器地址按 §4.3，处理器合约与 #ID 按 §4.2 第 3–5 步，在一个钉块上严格共识读取。消息不需要处理器号，不查。无站点状态。
  async function endpointAt(target, at, { opened: wantOpened = true } = {}) {
    let circuits, tokenId, given = null
    if (typeof target === 'string') {
      given = target
      let tok
      // As resolve does in this mode: an address that is no container HERE, or whose token() names another chain, may be
      // one elsewhere, and TAP-10 §4.1 forbids not-tapeout until every active chain was read: unsupported (never cached).
      // 与本模式的 resolve 相同：在本链不是容器、或 token() 声称别的链的地址，可能是别处的容器，TAP-10 §4.1 规定读遍所有活跃链之前
      // 不得报 not-tapeout：报 unsupported（绝不缓存）。
      try { tok = await viewStrict(target, 'token', [], at) }
      catch (e) { if (readsWrong(e)) throw otherChain(target, 'does not answer ERC-6551 token() here'); throw e }
      if (BigInt(tok[0]) !== BigInt(chainId)) throw otherChain(target, `answers token() for chain ${BigInt(tok[0])}`)
      if (BigInt(tok[2]) < 1n || BigInt(tok[2]) > MAX_TOKEN_ID) throw tapErr('CHANNEL_INVALID', 'not-tapeout', `not-tapeout: ${target} names #${BigInt(tok[2])}, outside TAP-10 §3.1`)
      circuits = tok[1]; tokenId = BigInt(tok[2])
    } else ({ circuits, tokenId } = target)
    const cpuP = early(() => viewStrict(factory, 'isCPU', [circuits], at))
    const accountP = early(() => viewStrict(opener, 'accountOf', [circuits, tokenId], at))
    const holderP = early(() => viewStrict(circuits, 'ownerOf', [tokenId], at))
    const openedP = wantOpened ? early(() => viewStrict(opener, 'isOpened', [circuits, tokenId], at)) : null
    let cpu
    try { cpu = (await cpuP) === true } catch (e) { if (!readsWrong(e)) throw e; cpu = false }
    // A processor contract#ID whose contract is no processor here may be one on another chain (resolve: the same); a
    // container of this chain naming a counterfeit is not-tapeout / 处理器合约#ID 同 resolve；本链容器指向仿冒处理器为 not-tapeout
    if (!cpu && !given) throw otherChain(checksumAddress(circuits), 'is not a TapeOut processor here')
    if (!cpu) throw tapErr('CHANNEL_INVALID', 'not-tapeout', `not-tapeout: ${circuits} is not a TapeOut processor (factory.isCPU is false)`)
    if (knownCPUs.size < 4096) knownCPUs.add(String(circuits).toLowerCase())
    const container = checksumAddress(await accountP)
    if (given && !eqAddr(container, given)) throw tapErr('CHANNEL_INVALID', 'not-tapeout', `not-tapeout: opener.accountOf(${circuits}, ${tokenId}) is ${container}, not ${given} (TAP-10 §4.3 step 4)`)
    let holder
    try { holder = checksumAddress(await holderP) } catch (e) { if (readsWrong(e)) throw tapErr('NOT_FOUND', 'no-such-token', `no-such-token: ${circuits} has no circuit #${tokenId} (ownerOf reverts)`); throw e }
    return { circuits: checksumAddress(circuits), tokenId, container, holder, ...(openedP ? { opened: (await openedP) === true } : {}) }
  }

  // §13.8 at the pinned block: is the hub accepted, have the circuits changed, are the seals in effect. A client that once
  // saw circuits-changed keeps it; a client that once saw the factory seal in effect and later does not (at a block not
  // earlier) keeps treating it as lost. Per client, so per chain and hub (forChain: one client per chain).
  // §13.8：中枢是否被接受、电路是否变更、封存是否生效。见过 circuits-changed 就一直保留；见过工厂封存生效、之后（不早于那一块）又不生效，
  // 就一直当作已失去。按客户端保存，即按链与中枢。
  const sealKey = `${chainId}:${String(hub).toLowerCase()}`
  const minBlock = (a, b) => (a === null ? b : b === null ? a : Math.min(a, b))
  async function hubTrustAt(at, pinned) {
    // The sticky part, from sealStatusStore (this client's Map unless one was given) / 粘性部分，取自 sealStatusStore
    const saved = (await sealStatusStore.get(sealKey)) ?? {}
    const num = (v) => (Number.isSafeInteger(v) ? v : null)
    let circuitsChangedAt = num(saved.circuitsChangedAt), factorySealSeenAt = num(saved.factorySealSeenAt), factorySealLost = saved.factorySealLost === true
    const before = JSON.stringify([circuitsChangedAt, factorySealSeenAt, factorySealLost])
    const [hubImpl, beaconImpl, beaconOwner, factorySealed, factoryImpl, hubSealed, hubOwner] = await Promise.all([
      implSlotStrict(hub, at),
      wordStrict(sealsOf.circuitBeacon, 'implementation()', at), wordStrict(sealsOf.circuitBeacon, 'owner()', at),
      wordStrict(factory, 'isSealed()', at), implSlotStrict(factory, at),
      wordStrict(hub, 'isSealed()', at), wordStrict(hub, 'owner()', at),
    ])
    const accepted = eqAddr(hubImpl, sealsOf.hub)
    const circuitsOk = eqAddr(addressOfWordStrict(beaconImpl), sealsOf.circuitImplementation)
    if (!circuitsOk) circuitsChangedAt = minBlock(circuitsChangedAt, pinned.number)
    const one = '0x' + '0'.repeat(63) + '1'
    const factorySeal = factorySealed === one && eqAddr(factoryImpl, sealsOf.factory) && eqAddr(addressOfWordStrict(beaconOwner), factory) && circuitsOk
    if (factorySeal) factorySealSeenAt = minBlock(factorySealSeenAt, pinned.number)
    if (!factorySeal && factorySealSeenAt !== null && pinned.number >= factorySealSeenAt) factorySealLost = true
    const hubSeal = accepted && hubSealed === one && addressOfWordStrict(hubOwner) === ZERO_ADDRESS
    if (JSON.stringify([circuitsChangedAt, factorySealSeenAt, factorySealLost]) !== before) await sealStatusStore.set(sealKey, { circuitsChangedAt, factorySealSeenAt, factorySealLost })
    return {
      circuitsChangedAt,
      hub: { implementation: hubImpl, accepted }, circuits: circuitsChangedAt === null ? 'ok' : 'circuits-changed',
      seal: { factory: factorySeal && !factorySealLost, hub: hubSeal, ...(factorySealLost ? { factoryLost: true } : {}) },
    }
  }

  // api.chain.tapeSendKey under conform: 'tap10' (TAP-10 §12.2, §13.8, §14.4 steps 1-3). Step 4 (the recipient reads the
  // sending chain) is the caller's: the result carries the raw bitmap. / 一致模式下的 tapeSendKey。第 4 步（收件方是否读发送链）
  // 由调用方判断：结果带原始位图。
  async function tapeSendKeyTap10(target) {
    let input
    if (typeof target === 'string') {
      if (!isAddress(target)) throw tapErr('INVALID_ARGUMENT', 'input-error', 'tapeSendKey takes a container address or { circuits, tokenId }')
      input = target
    } else if (target && isAddress(target.circuits) && target.tokenId != null) {
      let t
      try { t = BigInt(target.tokenId) } catch { throw tapErr('INVALID_ARGUMENT', 'input-error', 'tokenId must be a whole number') }
      if (t < 1n || t > MAX_TOKEN_ID) throw tapErr('INVALID_ARGUMENT', 'input-error', 'tokenId is out of range: 1 <= #ID <= 10^18 (TAP-10 §3.1)')
      input = { circuits: target.circuits, tokenId: t }
    } else throw tapErr('INVALID_ARGUMENT', 'input-error', 'tapeSendKey takes a container address or { circuits, tokenId }')
    const pinned = await messagingPin()
    const at = tapAt(pinned)
    // The hub's state goes out with the identity reads; it is judged after the identity outcome.
    // 中枢状态与身份读取同一轮发出；在身份结果之后才判断。
    const trustP = early(() => hubTrustAt(at, pinned))
    const keyP = typeof input === 'string' ? null : early(() => viewStrict(hub, 'keyFor', [input.circuits, input.tokenId], at))
    const id = await endpointAt(input, at)
    const trust = await trustP
    const where = { chainId: Number(chainId), container: id.container, circuits: id.circuits, tokenId: id.tokenId.toString(), pinned: pinnedView(pinned) }
    if (!trust.hub.accepted) throw tapErr('CONTRACT_UNKNOWN', 'hub-changed', `hub-changed: the hub ${checksumAddress(hub)} runs implementation ${trust.hub.implementation ?? '(not an address)'}, not the one TAP-10 lists as current on chain ${chainId} (${sealsOf.hub}); do not seal to keys it serves (TAP-10 §13.8)`, { ...where, implementation: trust.hub.implementation })
    if (trust.circuits !== 'ok') throw tapErr('CONTRACT_UNKNOWN', 'circuits-changed', `circuits-changed: the circuit beacon ${sealsOf.circuitBeacon} no longer runs ${sealsOf.circuitImplementation} (seen at block ${trust.circuitsChangedAt}); messaging through this hub has stopped (TAP-10 §13.8)`, where)
    const [container, endpoint, , , suite, keyIndex, key, usable, version, chains] = await (keyP ?? viewStrict(hub, 'keyFor', [id.circuits, id.tokenId], at))
    // §12.2: the hub's container and endpoint must be the resolved ones / 中枢的容器与端点须等于解析结果
    const want = '0x' + '00'.repeat(4) + BigInt(chainId).toString(16).padStart(16, '0') + id.container.slice(2).toLowerCase()
    if (!eqAddr(container, id.container) || String(endpoint).toLowerCase() !== want) throw tapErr('CHANNEL_INVALID', 'hub-mismatch', `hub-mismatch: hub.keyFor gives container ${container}, endpoint ${endpoint}; resolved ${id.container}, endpoint ${want} (TAP-10 §12.2)`, where)
    // §14.4 step 2 / 第 2 步
    if (!usable) throw tapErr('NOT_FOUND', Number(version) === 0 ? 'no-key' : 'key-stale', `${Number(version) === 0 ? 'no-key' : 'key-stale'}: ${id.container} has no usable TapeSend key (${Number(version) === 0 ? 'never published' : 'revoked, or the circuit changed hands since'})`, { ...where, version: Number(version) })
    if (Number(suite) !== 1) throw tapErr('CHANNEL_INVALID', 'bad-key', `bad-key: unsupported key suite ${suite}; TAP-10 suite 1 is X25519 (TAP-10 §14.4 step 2)`, where)
    // §14.4 step 3 / 第 3 步
    try { channelLib.assertUsablePublicKey(channelLib.fromHex(key, 32, 'key'), 'the TapeSend key') } catch (e) { throw tapErr('CHANNEL_INVALID', 'bad-key', `bad-key: ${e.message} (TAP-10 §14.4 step 3)`, where) }
    return {
      container: id.container, chainId, circuits: id.circuits, tokenId: id.tokenId.toString(),
      staticPublic: String(key).toLowerCase(), keyIndex: Number(keyIndex), version: Number(version),
      holder: id.holder, opened: id.opened, chainsBitmap: BigInt(chains).toString(2),
      tap10: { version: TAP10_VERSION, status: 'ok', endpoint: want, pinned: pinnedView(pinned), hub: trust.hub, circuits: trust.circuits, seal: trust.seal },
    }
  }

  // The channel record under conform: 'tap10' (the private-channels draft §3.3: TAPI-26 §3.1 under TAP-10's read rules).
  // TapeAPI's names for a record that cannot be used: not-found (chunkCount 0, TAP-10 §7.1), no-hash, incomplete, and
  // record-invalid for everything about its content (including a byte order mark).
  // 一致模式下的通道记录。记录不可用时 TapeAPI 的结果名：not-found、no-hash、incomplete，内容问题（含字节序标记）为 record-invalid。
  async function readChannelKeysTap10(container) {
    const pinned = await messagingPin()
    const at = tapAt(pinned)
    const implsP = early(() => Promise.all([['siteRegistry', siteRegistry], ['binding', binding]].map(async ([role, proxy]) => {
      const implementation = await implSlotStrict(proxy, at)
      return { role, proxy: checksumAddress(proxy), implementation, accepted: (known?.expectedImpl?.[String(proxy).toLowerCase()] ?? []).includes(implementation) }
    })))
    const settle = async (p) => { try { return { v: await p } } catch (e) { return { e } } }
    const [impls, idr] = await Promise.all([settle(implsP), settle(endpointAt(container, at, { opened: false }))])
    // TAP-10 §6.2: store-changed before any identity outcome / store-changed 先于任何身份结果
    if (impls.e) throw impls.e
    const x = impls.v.find((i) => !i.accepted)
    if (x) throw tapErr('CONTRACT_UNKNOWN', 'store-changed', `store-changed: ${x.role} ${x.proxy} runs implementation ${x.implementation}, which TAP-10 and this SDK do not accept (chains.js expectedImpl); the channel record, a site file, is not read (TAP-10 §6.1)`, { implementations: impls.v })
    if (idr.e) throw idr.e
    const id = idr.v
    const rec = (status, m) => tapErr('CHANNEL_INVALID', status, `${status}: ${CHANNEL_KEYS_KEY} of ${container}: ${m}`)
    // Only now the site store is read: §6.1 "MUST NOT read the site" when store-changed / 到这里才读站点存储（§6.1）
    const info = await viewStrict(siteRegistry, 'fileInfo', [container, CHANNEL_KEYS_KEY], at)
    const size = Number(info.size)
    if (BigInt(info.chunkCount) === 0n) throw rec('not-found', 'no such file (fileInfo.chunkCount = 0, TAP-10 §7.1)')
    if (size < 1 || size > CHANNEL_KEYS_LIMIT) throw rec('record-invalid', `declares ${size} bytes; a record has 1 to ${CHANNEL_KEYS_LIMIT}`)
    if (typeof info.sha256Hash !== 'string' || info.sha256Hash.toLowerCase() === ZERO_HASH) throw rec('no-hash', 'no on-chain SHA-256 (fileInfo.sha256Hash is zero)')
    let raw
    try { raw = hexToBytes(await viewStrict(siteRegistry, 'read', [container, CHANNEL_KEYS_KEY], at)) } catch (e) { if (isRevert(e)) throw rec('incomplete', `read() reverted: ${e.message}`); throw e }
    if (raw.length !== size) throw rec('incomplete', `read ${raw.length} bytes, fileInfo.size declares ${size}`)
    if (toHex(sha256(raw)) !== info.sha256Hash.toLowerCase()) throw rec('incomplete', `the bytes hash to ${toHex(sha256(raw))}, fileInfo.sha256Hash declares ${info.sha256Hash}`)
    // The draft §2 and TAP-10 §16: a byte order mark is refused, not stripped / 字节序标记直接拒绝，不去掉
    if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) throw rec('record-invalid', 'begins with a byte order mark')
    let checked
    try { checked = channelRecordOf(() => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw), container) }
    catch (e) { if (e instanceof TapeAPIError && e.code === 'CHANNEL_INVALID') throw tapErr('CHANNEL_INVALID', 'record-invalid', `record-invalid: ${e.message}`); throw e }
    const { r, inbox, digest } = checked
    // The holder read at the pinned block (step 1), EIP-1271 at the same block, strict (step 7) / 钉块上的持有人；EIP-1271 同块严格读取
    let recovered = null
    if (r.sig.length === 132) { try { recovered = recoverAddress(digest, r.sig) } catch { /* a contract holder signs no ECDSA / 合约持有人没有 ECDSA 签名 */ } }
    if (!(recovered && eqAddr(recovered, id.holder)) && !(await holderApproves(id.holder, digest, r.sig, at, TAP10_STRICT))) {
      throw tapErr('CHANNEL_INVALID', 'record-invalid', `record-invalid: ${container}: channel keys were not authorised by the current holder ${id.holder}`)
    }
    try { await raiseRecordFloor(container, r) } catch (e) { if (e instanceof TapeAPIError && e.code === 'CHANNEL_INVALID') throw tapErr('CHANNEL_INVALID', 'record-invalid', `record-invalid: ${e.message}`); throw e }
    return { ...channelRecordResult(container, id.circuits, id.tokenId, id.holder, r, inbox), tap10: { version: TAP10_VERSION, status: 'ok', pinned: pinnedView(pinned), implementations: impls.v } }
  }

  // Identity resolver shared by TAPI-26 (invite.from, invite.owner) and TAPI-27 (groupVerifier) (arch B7). Keyed by the
  // lowercase container; entries live at most identityTtlS and the oldest go first once identityMax is reached.
  // Positive entries hold the record; negative ones only a definitive CHANNEL_INVALID / NOT_FOUND. RPC_UNAVAILABLE,
  // RPC_DISAGREE, RPC_ERROR and the rest propagate and change nothing (fixed-test G-05b). A lookup already in flight
  // is shared, also by a `fresh` caller: it is a chain read under way, not a cached answer. A cached record below the container's
  // `issued` floor (another client sharing channelRecordFloor saw a newer one) is a miss, so the cache never lets an
  // older record back in (arch B4); the floor itself only moves in readChannelKeys.
  // TAPI-26 与 TAPI-27 共用的身份解析。按小写容器地址为键；条目最多存活 identityTtlS 秒，满 identityMax 条先淘汰最旧的。
  // 正缓存存记录；负缓存只存确定的 CHANNEL_INVALID / NOT_FOUND。RPC 类错误原样抛出、不改缓存。进行中的查询被共享，
  // `fresh` 调用也共享（那是正在进行的链上读取，不是缓存的回答）。低于该容器 `issued` 下限的缓存记录（共用下限的另一客户端见过更新的）
  // 视为未命中，缓存绝不让旧记录回来；下限只在 readChannelKeys 里移动。
  const identities = (() => {
    const cache = new Map()      // key -> { at, rec } | { at, err: { code, message } }, oldest first / 旧的在前
    const inflight = new Map()   // key -> Promise
    const copy = (rec) => ({ ...rec, inbox: { ...rec.inbox, relays: rec.inbox.relays.map((r) => ({ ...r })) }, ...(rec.tap10 ? { tap10: structuredClone(rec.tap10) } : {}) })
    const put = (key, entry) => {
      if (identityTtlS === 0) return
      cache.delete(key); cache.set(key, entry)
      while (cache.size > identityMax) cache.delete(cache.keys().next().value)
    }
    async function hit(key) {
      const e = cache.get(key)
      if (!e) return null
      if (e.at + identityTtlS <= now()) { cache.delete(key); return null }
      if (e.rec && e.rec.issued < (await readFloor(key))) { cache.delete(key); return null }
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
          // the conformance mode keeps data (data.status) with the verdict / 一致模式连同 data（data.status）一起保留
          if (e instanceof TapeAPIError && (e.code === 'CHANNEL_INVALID' || e.code === 'NOT_FOUND')) put(key, { at: now(), err: { code: e.code, message: e.message, ...(conformMode && e.data !== undefined ? { data: structuredClone(e.data) } : {}) } })
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
        if (e?.err) throw (e.err.data !== undefined ? new TapeAPIError(e.err.code, e.err.message, { data: structuredClone(e.err.data) }) : new TapeAPIError(e.err.code, e.err.message))
        return copy(e ? e.rec : await read(container, key))
      },
      get size() { return cache.size },
    }
  })()

  // accountOf derives an account for ANY ERC-721, so a counterfeit token contract would otherwise pass as a TapeOut
  // circuit, for free and by the thousand (TAPI-20 §3.6 step 3, TAPI-26 §3.1; found 2026-09-24).
  // accountOf 对任何 ERC-721 都能推导账户，否则仿冒的代币合约就能免费、成批地冒充 TapeOut 电路。
  const knownCPUs = new Set()
  // `answer`: an isCPU(circuits) read already under way (resolve starts it early) / 已经发出的 isCPU 读取
  async function requireCPU(circuits, code, answer = null, at = 'latest') {
    if (!(await (answer ?? isCPUAt(circuits, at)))) throw new TapeAPIError(code, `${circuits} is not a TapeOut processor (factory.isCPU is false)`)
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
  async function readContribution(m, at = 'latest') {
    if (!isAddress(m.payment?.escrow)) return 0   // 免费服务无托管合约 / free service, no escrow
    try { return Number(await view(m.payment.escrow, 'contributionOf', [m.container], at)) }
    // only a revert or an empty return: "header not found" on every node is not "no contributionOf" (review R3-3)
    // 只有回滚或空返回才算：每个节点都答 "header not found" 不等于"没有 contributionOf"
    catch (e) { if (isRevert(e) || (e instanceof TapeAPIError && e.code === 'ABI_INVALID')) return 0; throw e }
  }

  // TAPI-20 §3.2 / §3.6 step 2: fileInfo → read (each under RPC quorum), then the bytes MUST match the declared
  // length and SHA-256. Quorum only proves the nodes agree; this proves the SiteRegistry's chunk assembly agrees
  // with its own index — a truncated or mis-assembled file is returned identically by every honest node.
  // 先 fileInfo 再 read（各自过 quorum），字节必须与声明的长度和 SHA-256 一致。quorum 只证明节点一致，这一步证明
  // SiteRegistry 拼出来的文件与它自己的索引一致——拼装错误或截断的文件会被每个诚实节点原样返回。
  // read() waits for fileInfo on purpose (TAPI-20 §3.6 step 2 "fileInfo then read"): a file that is missing, over the
  // limit or has no hash is refused without downloading it. / read() 有意等 fileInfo：缺失、超限或没有哈希的文件不下载就拒绝。
  // `beforeRead` (security 1.1): called just before read() goes out, so reads started there go out in the same turn.
  // `beforeRead`：在 read() 发出之前调用，在其中发出的读取与它在同一轮发出。
  // `proofs` (security 1.2): a proof session; the fileInfo slots (size, sha256Hash) are proven alongside fileInfo, and the
  // file is accepted only once they equal what the nodes answered, so the bytes also hash to the PROVEN sha256Hash.
  // `proofs`（安全加固 1.2）：证明会话；fileInfo 的槽（size、sha256Hash）与 fileInfo 一起证明，证明值与节点回答一致才接受文件，
  // 因此字节的哈希也等于**已证明**的 sha256Hash。
  async function readVerifiedFile(container, path, { limit = MANIFEST_LIMIT, code = 'MANIFEST_INVALID', at = 'latest', beforeRead = null, proofs = null } = {}) {
    const slots = proofs ? STORAGE.fileInfo(container, registryKey(path)) : null
    const proofP = proofs ? proofs.request(siteRegistry, [IMPL, slots.size, slots.sha256Hash]) : null
    const info = await view(siteRegistry, 'fileInfo', [container, registryKey(path)], at)
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
    const bytesP = early(() => view(siteRegistry, 'read', [container, registryKey(path)], at))
    if (beforeRead) beforeRead()
    try { raw = hexToBytes(await bytesP) }
    // Only a revert: any other JSON-RPC error ("header not found" on every node) would be cached as a CHANNEL_INVALID
    // verdict and drop a group member (review R3-3). / 只认回滚：其它 JSON-RPC 错误若变成 CHANNEL_INVALID 会被缓存并让成员被移出群。
    catch (e) { if (isRevert(e)) throw new TapeAPIError(code, `read(${path}) reverted for ${container}: ${e.message}`); throw e }
    if (raw.length !== size) throw new TapeAPIError(code, `${path}: read ${raw.length} bytes, fileInfo.size declares ${size}`)
    const digest = toHex(sha256(raw))
    if (digest !== info.sha256Hash.toLowerCase()) throw new TapeAPIError(code, `${path}: sha256 of bytes is ${digest}, fileInfo.sha256Hash declares ${info.sha256Hash}`)
    if (proofP) {
      await proofs.settle('fileInfo', siteRegistry, proofP, { impl: LAYOUT_IMPLEMENTATIONS.siteRegistry, detail: { container: checksumAddress(container), path: registryKey(path) }, check: (v) => {
        const provenSize = v.get(slots.size) & 0xffffffffn, provenHash = '0x' + v.get(slots.sha256Hash).toString(16).padStart(64, '0')
        if (provenSize !== BigInt(size)) return `fileInfo.size is ${size}, the proven size is ${provenSize}`
        return provenHash === digest ? null : `the bytes hash to ${digest}, the proven sha256Hash is ${provenHash}`
      } })
    }
    return { bytes: raw, size, sha256Hash: digest, contentType: info.contentType, updatedAt: info.updatedAt }
  }

  // Manifest straight from the SiteRegistry at the TAPI-20 fixed path. No directory is involved: a free service
  // is resolvable with zero TapeAPI contracts deployed. When a directory IS configured, its record is used only as
  // an optional cross-check (a hint, TAPI-20 §3.5); an unregistered container, or a directory whose serviceOf
  // reverts, never blocks resolution.
  // 清单直接从 SiteRegistry 的固定路径读取，不经过目录：免费服务在零个 TapeAPI 合约部署时即可解析。配置了目录时，
  // 其记录只作可选交叉校验（TAPI-20 §3.5 的"提示"）；未注册的容器或 serviceOf 回滚的目录都不会阻塞解析。
  async function manifestFromContainer(container, ctx = {}) {
    // The directory's record goes out with the file reads; it is still looked at only after the file checks passed.
    // 目录记录与文件读取一起发出；仍然只在文件检查通过之后才看它。
    const serviceP = isAddress(directory) ? early(() => view(directory, 'serviceOf', [container], ctx.at)) : null
    const file = await readVerifiedFile(container, MANIFEST_PATH, { at: ctx.at, beforeRead: ctx.beforeRead, proofs: ctx.proofs })
    const m = safeParseJSON(new TextDecoder().decode(file.bytes), { code: 'MANIFEST_INVALID' })
    let service = null
    if (serviceP) {
      try {
        const rec = await serviceP
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
    if (!devMode) throw new TapeAPIError('INVALID_ARGUMENT', 'dev resolve disabled: createTapeAPI({ dev: true }) is required to resolve { dev } targets')
    if (dev && typeof dev === 'object') return { manifest: dev, container: null, dev: true }
    if (typeof dev !== 'string') throw new TapeAPIError('INVALID_ARGUMENT', 'dev must be manifest object or url')
    let url = dev.replace(/\/+$/, '')
    if (!/\.json$/i.test(url)) url += MANIFEST_PATH
    let host; try { host = new URL(url).hostname } catch { throw new TapeAPIError('INVALID_ARGUMENT', 'dev url is not a valid URL') }
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
  // `holder`: an ownerOf(m.circuits, m.tokenId) read already under way (resolve starts it early) / 已经发出的 ownerOf 读取
  // `read`: the conformance mode's strict read for the EIP-1271 calls (TAP-11 §2.2); none in the default mode.
  // `read`：一致模式下 EIP-1271 调用用的严格读取（TAP-11 §2.2）；默认模式不传。
  async function verifyDelegation(m, { dev, holder: holderP = null, at = 'latest', read }) {
    if (!m.delegation) {
      if (dev) return { delegation: false, holder: null, dev: true }
      throw new TapeAPIError('DELEGATION_INVALID', 'delegation missing')
    }
    // TAPI-20 §3.6 step 4 BEFORE step 5 (spec review SD-3): a burned circuit is MANIFEST_INVALID whatever its
    // delegation looks like, so every client reports the same code. ownerOf reverting (no such token) is
    // MANIFEST_INVALID; an RPC outage stays what it is.
    // 先做第 4 步再做第 5 步：已销毁的电路无论委托如何都是 MANIFEST_INVALID，各客户端报同一个错误码。
    // ownerOf 回滚（没有这个 token）是 MANIFEST_INVALID；RPC 故障保持原样。
    const checkHolder = !(dev && !rpc)
    let holder
    if (checkHolder) {
      // with `read` and no read under way, the fallback ownerOf is read the same way (FIXED Fable 5a) / 有 read 时兜底 ownerOf 同样读取
      const ownerRead = () => (read ? needRpc().ethCall(m.circuits, encodeCall('ownerOf', [BigInt(m.tokenId)]), at, read).then((raw) => decodeReturn('ownerOf', raw)) : view(m.circuits, 'ownerOf', [BigInt(m.tokenId)], at))
      try { holder = await (holderP ?? ownerRead()) } catch (e) {
        if (isRevert(e)) throw new TapeAPIError('MANIFEST_INVALID', `ownerOf(${m.circuits}, ${m.tokenId}) reverted: the manifest names a circuit that does not exist`)
        throw e
      }
    }
    if (m.delegation.expires <= now()) throw new TapeAPIError('DELEGATION_INVALID', 'delegation expired')
    // TAPI-20 §3.4 (client SHOULD): a delegation more than 366 days out is refused / 超过 366 天的委托拒绝
    if (m.delegation.expires > now() + MAX_DELEGATION_S) throw new TapeAPIError('DELEGATION_INVALID', 'delegation.expires is more than 366 days ahead')
    const dir = hub   // 委托锚定在中枢，无需部署目录 / delegation is anchored on the hub; no directory needed
    const digest = delegationDigest(chainId, dir, { container: m.container, signer: m.signer, expires: m.delegation.expires })
    // A 65-byte sig is ECDSA and must recover (a malformed one is refused before EIP-1271, as before). A longer one
    // can only be a contract holder's EIP-1271 signature (TAPI-20 §3.3/§3.4, spec review SD-4): no ECDSA recovery.
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
    if (!(recovered && eqAddr(holder, recovered)) && !(await holderApproves(holder, digest, m.delegation.sig, at, read))) {
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
  // `opts`: the conformance mode's strict read ({ answers: 'tap10', strict: true }); none in the default mode.
  // `opts`：一致模式的严格读取；默认模式不传。
  async function holderApproves(holder, digest, sig, at = 'latest', opts) {
    if (!rpc) return false
    if ((await (opts ? rpc.call('eth_getCode', [holder, at], opts) : rpc.call('eth_getCode', [holder, at]))) === '0x') return false
    const data = selector('isValidSignature(bytes32,bytes)') + bytesToHex(encodeParams(['bytes32', 'bytes'], [toHex(digest), sig]))
    let out
    try { out = String(await (opts ? rpc.ethCall(holder, data, at, opts) : rpc.ethCall(holder, data, at))).toLowerCase() }
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
    if (!chainById(n)) throw new TapeAPIError('INVALID_ARGUMENT', `chain ${id} is not a TapeOut chain this SDK supports (${CHAIN_IDS.join(', ')})`)
    let sub = subClients.get(n)
    if (!sub) {
      const conf = opts.chains?.[n] ?? {}
      sub = createTapeAPI({
        chainId: n, rpcUrls: conf.rpcUrls ?? rpcUrlsFor(n), quorum: conf.quorum ?? 2, rpcTimeoutMs: conf.rpcTimeoutMs ?? opts.rpcTimeoutMs,
        allowSingleNode: conf.allowSingleNode === true, quiet: (conf.quiet ?? opts.quiet) === true, hub: conf.hub, factory: conf.factory, siteRegistry: conf.siteRegistry,
        fetch: opts.fetch, dev: opts.dev, allowHttp: opts.allowHttp, maxSkewS: opts.maxSkewS,
        identityCacheS: opts.identityCacheS, identityCacheSize: opts.identityCacheSize, channelRecordFloor: recordFloor, sealStatusStore, _router: forChain,
        // security 1.1: the same choices on every chain, but each chain's own finality tag and age limit unless
        // chains[n].pin says otherwise / 各链沿用同样的选择，但标签与时限取各链自己的，除非 chains[n].pin 另有规定
        clock: opts.clock, sentinel: opts.sentinel, requireContentSig: opts.requireContentSig, onWarning: opts.onWarning,
        delegationFloor: delegationFloor ?? undefined,
        pin: conf.pin ?? (pinConf ? (pinConf.mode === 'tap10' ? 'tap10' : { by: pinConf.by, cacheS: pinConf.cacheS }) : false),
        proofs: opts.proofs,
        // 1.4: the conformance mode on every chain, with each chain's own opener and payment contract (TAP-10 §2.2)
        // 1.4：每条链都跑一致模式，开通器与付费合约取各链自己的
        conform: conformMode ? 'tap10' : undefined, opener: conf.opener, binding: conf.binding,
        // 1.5: the same consent to read every chain, so api.forChain(id) searches as this client does (TAP-10 §4.1)
        // 1.5：同样的"读取所有链"许可，使 api.forChain(id) 与本客户端一样搜索
        allChains: allChains || undefined,
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
      if (!Number.isSafeInteger(n) || n < 1) throw new TapeAPIError('INVALID_ARGUMENT', 'target.chainId must be a chain id')
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
    if (!isAddress(container)) throw new TapeAPIError('INVALID_ARGUMENT', 'chainOfContainer takes a container address')
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

  // ---- security 1.1: delegation floor key / 委托下限的键 ----
  // `${chainId}:${container}:${holder}:${signer}`, lowercase. / 全部小写。
  const delegationFloorKey = ({ chainId: c = chainId, container, holder, signer }) => `${Number(c)}:${String(container).toLowerCase()}:${String(holder).toLowerCase()}:${String(signer).toLowerCase()}`
  /** @experimental (security 1.1) Forget the delegation floor of one container, holder and signer (on any chain; the
   *  store is shared by every chain's client), e.g. after a holder shortened `expires` on purpose. Takes the `data` of the
   *  DELEGATION_INVALID floor error as it is. Resolves to true when there was a floor, false when there was none or the
   *  client has no delegationFloor. / 忘掉某容器、持有人与签名者的委托下限，例如持有人有意缩短 expires 之后。可直接传入下限错误的 data。 */
  async function clearDelegationFloor(who) {
    if (!who || typeof who !== 'object') throw new TapeAPIError('INVALID_ARGUMENT', 'clearDelegationFloor takes { chainId?, container, holder, signer }')
    for (const k of ['container', 'holder', 'signer']) if (!isAddress(who[k])) throw new TapeAPIError('INVALID_ARGUMENT', `clearDelegationFloor: ${k} must be an address`)
    if (who.chainId !== undefined && !Number.isSafeInteger(Number(who.chainId))) throw new TapeAPIError('INVALID_ARGUMENT', 'clearDelegationFloor: chainId must be a chain id')
    if (!delegationFloor) return false
    const key = delegationFloorKey(who)
    const had = Number((await delegationFloor.get(key)) ?? 0) > 0
    if (typeof delegationFloor.delete === 'function') await delegationFloor.delete(key)
    else await delegationFloor.set(key, 0)
    return had
  }

  // ---- security 1.1: pinned block, identity-root sentinel / 钉块与身份根哨兵 ----
  // The pinned block of a resolution: confirmed by nodes of `quorum` operators (rpc.confirmedBlock), then checked against
  // this client's clock on every use, cached block or not. Concurrent resolutions share one pin read; a pin is reused
  // for at most pin.cacheS seconds (default 0: every resolution pins anew). Failures are never cached, and neither is a
  // block found stale: the next resolution pins anew instead of failing on the same block until cacheS runs out (FIXED
  // SECR-7).
  // 一次解析所钉的区块：由 quorum 家运营方确认，每次使用（无论是否缓存）都对照本客户端时钟检查新鲜度。并发解析共享一次读取；
  // 同一区块最多复用 pin.cacheS 秒（默认 0：每次解析重新钉块）。失败绝不缓存，判为过期的区块也不缓存：下一次解析重新钉块，
  // 而不是在 cacheS 到期之前一直因同一个区块失败（FIXED SECR-7）。
  let pinShared = null
  async function pinnedBlock() {
    let e = pinShared
    if (!e || (e.done && now() - e.at >= pinConf.cacheS)) {
      // pin: 'tap10' (1.4): TAP-10 §5.3, fresh by block lag inside rpc.tap10Block; no clock check below
      // pin: 'tap10'：TAP-10 §5.3，新鲜度在 rpc.tap10Block 里按块差判定；下面不对照时钟
      const p = pinConf.mode === 'tap10' ? needRpc().tap10Block({ maxLag: pinConf.maxLag, stateRoot: !!proofMode })
        : proofMode ? needRpc().confirmedBlock(pinConf.tag, { stateRoot: true }) : needRpc().confirmedBlock(pinConf.tag)
      const entry = { p, at: now(), done: false }
      e = pinShared = entry
      p.then(() => { entry.done = true }, () => { if (pinShared === entry) pinShared = null })
    }
    const b = await e.p
    if (pinConf.mode === 'tap10') return b
    const age = now() - b.timestamp
    if (age > pinConf.maxAgeS || -age > maxSkewS) { if (pinShared === e) pinShared = null }
    if (age > pinConf.maxAgeS) throw new TapeAPIError('RPC_STALE', `the ${pinConf.tag} block the nodes confirm (${b.number}) is ${age}s old, more than ${pinConf.maxAgeS}s: the nodes are behind, or this client's clock is wrong`, { data: { block: b.number, timestamp: b.timestamp, ageS: age, maxAgeS: pinConf.maxAgeS } })
    if (-age > maxSkewS) throw new TapeAPIError('RPC_STALE', `the ${pinConf.tag} block the nodes confirm (${b.number}) is ${-age}s ahead of this client's clock (more than ${maxSkewS}s)`, { data: { block: b.number, timestamp: b.timestamp, ageS: age, maxAgeS: pinConf.maxAgeS } })
    return b
  }
  const blockParamOf = (b) => (pinConf.by === 'hash' ? { blockHash: b.hash, requireCanonical: true } : '0x' + b.number.toString(16))

  // Identity-root sentinel. The DeWebHub and the SiteRegistry are upgradeable proxies whose owners are single keys
  // (measured 2026-09-29): an upgrade changes real chain state that every honest node and every proof agree on. The
  // sentinel can only NOTICE it: it reads each proxy's ERC-1967 implementation slot and compares it with chains.js
  // `expectedImpl`, and re-derives the container locally (ERC-6551 CREATE2, salt 0) to compare with hub.accountOf.
  // Only the chain's own contracts are checked (a client pointed at other addresses has no expected implementation).
  // The slot reads go out alone, in the same turn as the manifest's read() (no extra round; never inside an eth_call
  // batch, FIXED SECR-5) and are kept like the other facts, at most IDENTITY_CACHE_S; an error is never kept. 'warn'
  // reports, 'strict' refuses (CONTRACT_UNKNOWN, MANIFEST_INVALID), 'off' skips.
  // Time-based reuse (a design choice, not a pin): the facts cache (accountOf, cpuAt), knownCPUs and these slots are
  // reused across resolutions for up to IDENTITY_CACHE_S whatever block a later resolution pins to, so a pinned
  // resolution may use a fact read at an earlier block. accountOf and cpuAt of an existing processor never change; an
  // implementation upgrade is noticed at most IDENTITY_CACHE_S late.
  // 按时间复用（设计取舍，不是钉块）：事实缓存（accountOf、cpuAt）、knownCPUs 与这些实现槽在 IDENTITY_CACHE_S 内跨解析复用，
  // 不论之后的解析钉在哪个区块，因此钉块解析可能用到较早区块读到的事实。accountOf 与已存在处理器的 cpuAt 永不改变；实现升级最多晚
  // IDENTITY_CACHE_S 才被发现。
  // 身份根哨兵。DeWebHub 与 SiteRegistry 是可升级代理，owner 是单个密钥：升级改的是真实链上状态，所有诚实节点与证明都会为它背书。
  // 哨兵只能**发现**：读各代理的 ERC-1967 实现槽与 chains.js 的 expectedImpl 比对，并在本地重新推导容器与 hub.accountOf 比对。
  // 只核对本链自己的合约。实现槽读取与清单的 read() 在同一轮单独发出（不多一轮；绝不进 eth_call 批量，FIXED SECR-5），与其它事实一样最多保留 IDENTITY_CACHE_S 秒；
  // 错误绝不保留。'warn' 报告，'strict' 拒绝，'off' 跳过。
  const sentinelProxies = (() => {
    if (sentinelMode === 'off' || !known) return []
    // In the conformance mode the SiteRegistry belongs to the TAP-10 check (fail-closed, with the DomainBinding); the
    // sentinel keeps the hub. / 一致模式下 SiteRegistry 归 TAP-10 检查（fail-closed，与 DomainBinding 一起），哨兵只管 hub。
    return [['hub', hub], ...(conformMode ? [] : [['siteRegistry', siteRegistry]])].flatMap(([role, proxy]) => {
      const allowed = known.expectedImpl?.[String(proxy).toLowerCase()]
      return allowed ? [{ role, proxy: checksumAddress(proxy), allowed }] : []
    })
  })()
  const localDerivation = sentinelMode !== 'off' && !!known && (conformMode ? eqAddr(opener, known.opener) : eqAddr(hub, known.hub)) && isAddress(known.erc6551Registry) && isAddress(known.accountImplementation)
  let implShared = null
  function readImplementations(at) {
    if (!sentinelProxies.length) return null
    if (implShared && now() - implShared.at < IDENTITY_CACHE_S) return implShared.p
    const p = Promise.all(sentinelProxies.map(async (t) => {
      const word = String(await needRpc().call('eth_getStorageAt', [t.proxy, IMPL_SLOT, at]))
      if (!/^0x[0-9a-fA-F]{64}$/.test(word)) throw new TapeAPIError('RPC_ERROR', `eth_getStorageAt(${t.proxy}) answered ${word.slice(0, 80)}`)
      return { role: t.role, proxy: t.proxy, implementation: '0x' + word.slice(-40).toLowerCase(), expected: t.allowed.includes('0x' + word.slice(-40).toLowerCase()) }
    }))
    const entry = { p, at: now() }
    implShared = entry
    p.catch(() => { if (implShared === entry) implShared = null })
    return p
  }

  // ---- security 1.2: Merkle proofs (@experimental) / 默克尔证明 ----
  // With `proofs`, the reads resolve bases trust on (cpuAt, isCPU, ownerOf, fileInfo) are also proven: one eth_getProof per
  // contract at the pinned block, from ANY node (a proof needs no quorum, a wrong one fails the check), checked here
  // against the stateRoot that the confirming nodes agreed on (rpc.confirmedBlock), and the proven values compared with
  // the quorum's eth_call answers. Every eth_call still goes through the quorum as before (TAPI-20 §3.2): a proof adds a
  // check, it never replaces one. Each proof goes out in the same turn as the eth_call it checks (no extra round) and is
  // awaited only where that answer is accepted. Provers are asked one at a time, the last one whose proof verified first; a
  // proof that does not verify sends the request on to the next node, and only when no node gave one that verifies is the
  // read unavailable or invalid (FIXED PROOFR-1). A node that refused the method, or served a proof that did not verify,
  // is skipped for PROVER_SKIP_MS; a rate limit or a timeout is not (BSC's default nodes: only Alchemy serves proofs).
  // 开启 `proofs` 后，resolve 据以信任的读取（cpuAt、isCPU、ownerOf、fileInfo）同时被证明：每个合约在钉住的区块上一个 eth_getProof，
  // 来自**任一**节点（证明不需要法定数，错的证明核验不过），在本地对照确认节点一致给出的 stateRoot 核验，并与法定数的 eth_call 回答
  // 比对。每个 eth_call 仍照旧过法定数（TAPI-20 §3.2）：证明只增加检查，从不替代检查。证明与它所核对的 eth_call 在同一轮发出（不多一轮），
  // 只在接受该回答的地方等待。证明节点逐个询问，上次证明核验通过的优先；核验不过就转问下一个节点，所有节点都拿不出核验通过的证明，
  // 该读取才记为不可用或无效（FIXED PROOFR-1）。拒绝该方法或给出核验不过的证明的节点跳过 PROVER_SKIP_MS；限流与超时不跳过
  // （BSC 默认节点里只有 Alchemy 提供证明）。
  const proverSkip = new Map()   // url -> skip until (ms) / 跳过到何时
  const provers = new Map()      // url -> single-node client / 单节点客户端
  let proverLast = null
  const hostOf = (u) => { try { return new URL(u).hostname } catch { return 'node' } }
  // `verify(answer)`: the checked proof, or a throw. Returns { proven, node } from the first node whose proof verifies;
  // else { invalid: [{ node, reason }], tried } when some node served a proof and none verified, else { tried }.
  // `verify(answer)`：核验后的证明，或抛错。返回第一个核验通过的节点的 { proven, node }；有节点给了证明但都核验不过时返回
  // { invalid, tried }；否则返回 { tried }。
  async function fetchProof(address, slots, blockNumber, verify) {
    const r = needRpc()
    const order = [...r.urls].sort((a, b) => (b === proverLast) - (a === proverLast))
    const tried = [], invalid = []
    for (const url of order) {
      if ((proverSkip.get(url) ?? 0) > Date.now()) { tried.push(`${hostOf(url)}: skipped, refused or failed a proof in the last ${PROVER_SKIP_MS / 60_000} min`); continue }
      let one = provers.get(url)
      if (!one) { one = r.single(url); provers.set(url, one) }
      let answer
      try {
        answer = await one.call('eth_getProof', [address, slots.map((x) => '0x' + x.toString(16).padStart(64, '0')), '0x' + blockNumber.toString(16)])
      } catch (e) {
        if (proverFailure(e) === 'refused') proverSkip.set(url, Date.now() + PROVER_SKIP_MS)
        tried.push(`${hostOf(url)}: ${String(e?.message ?? e).slice(0, 120)}`)
        continue
      }
      let proven
      try { proven = verify(answer) } catch (e) {
        proverSkip.set(url, Date.now() + PROVER_SKIP_MS)
        invalid.push({ node: hostOf(url), reason: String(e?.message ?? e) })
        tried.push(`${hostOf(url)}: a proof that does not verify`)
        continue
      }
      proverLast = url
      return { proven, node: hostOf(url) }
    }
    return invalid.length ? { invalid, tried } : { tried }
  }
  // One resolution's proofs. request() starts one eth_getProof (shared by identical requests); settle() records one read
  // as verified, unavailable or invalid, and in 'strict' throws for the last two. `check(values)` is null when the proven
  // values equal the quorum's answer, else why not: a verified proof that contradicts the quorum is refused in EVERY mode
  // (FIXED PROOFR-2: with proofs: true it was a warning, and the forged answer was accepted). `impl`: the implementations
  // whose storage layout is known; the proxy's ERC-1967 slot is proven in the same request and must name one of them.
  // 一次解析的证明。request() 发出一个 eth_getProof（相同请求共用）；settle() 把一项读取记为已证明、不可用或无效，'strict' 下后两者抛错。
  // `check(values)` 在证明值与法定数回答一致时为 null，否则给出原因：已核验的证明与法定数矛盾时，**任何**模式都拒绝（FIXED PROOFR-2：
  // proofs: true 下原先只警告，伪造的回答照样被接受）。`impl`：已知存储布局的实现；代理的 ERC-1967 槽在同一请求里证明，须为其一。
  function proofSession(pinned) {
    const s = { mode: proofMode, block: pinned.number, stateRoot: pinned.stateRoot ?? null, verified: [], unavailable: [], invalid: [] }
    const shared = new Map()
    s.request = (address, slots) => {
      const key = `${String(address).toLowerCase()}:${slots.join(',')}`
      if (!shared.has(key)) shared.set(key, early(() => prove(address, slots)))
      return shared.get(key)
    }
    async function prove(address, slots) {
      if (!s.stateRoot) return { unavailable: `nodes of ${needRpc().quorum} operators did not agree on a stateRoot for block ${s.block}` }
      const got = await fetchProof(address, slots, s.block, (answer) => verifyAccountProof(s.stateRoot, address, slots, answer))
      if (got.proven) return { ...got.proven, node: got.node }
      if (got.invalid) return { invalid: got.invalid.map((x) => `the proof from ${x.node} does not verify against stateRoot ${s.stateRoot} of block ${s.block}: ${x.reason}`).join('; '), node: got.invalid.map((x) => x.node).join(', '), tried: got.tried }
      return { unavailable: `no node served eth_getProof for block ${s.block} (${got.tried.join('; ')})` }
    }
    s.settle = async (read, address, p, { impl = null, check, detail = {} }) => {
      const r = await p
      const fail = (list, code, reason, always = false) => {
        const entry = { read, address: checksumAddress(address), ...detail, reason, ...(r.node ? { node: r.node } : {}) }
        list.push(entry)
        if (proofMode === 'strict' || always) throw new TapeAPIError(code, `${read}: ${reason}`, { data: { ...entry, block: s.block, stateRoot: s.stateRoot } })
      }
      if (r.unavailable) return fail(s.unavailable, 'PROOF_UNAVAILABLE', r.unavailable)
      if (r.invalid) return fail(s.invalid, 'PROOF_INVALID', r.invalid)
      if (impl) {
        const word = r.values.get(BigInt(IMPL_SLOT)), got = addressOfWord(word)
        if (got === null) return fail(s.unavailable, 'PROOF_UNAVAILABLE', `the proxy's ERC-1967 implementation slot holds 0x${word.toString(16)}, which is not an address: its storage layout is unknown`)
        if (!impl.includes(got)) return fail(s.unavailable, 'PROOF_UNAVAILABLE', `the proxy runs implementation ${got}, whose storage layout this SDK does not know`)
      }
      // A verified proof that contradicts the quorum: refused whatever the mode (FIXED PROOFR-2) / 已核验的证明与法定数矛盾：任何模式都拒绝
      const why = check(r.values)
      if (why) return fail(s.invalid, 'PROOF_INVALID', `the proven state at block ${s.block} differs from what the nodes answered: ${why}`, true)
      s.verified.push({ read, address: checksumAddress(address), ...detail, node: r.node })
    }
    return s
  }
  const IMPL = BigInt(IMPL_SLOT)
  // The factory proof: cpuAt(n) when a name gave n, and isCPU(circuits) / 工厂证明：名字给出 n 时含 cpuAt(n)，以及 isCPU(circuits)
  function factoryProof(proofs, circuits, n = null) {
    const slots = [IMPL, ...(n === null ? [] : [STORAGE.cpuAt(n).length, STORAGE.cpuAt(n).element]), STORAGE.isCPU(circuits)]
    return { circuits, n, p: proofs.request(factory, slots) }
  }
  // Called once isCPU(fp.circuits) was answered true by the nodes / 在节点答 isCPU(fp.circuits) 为 true 之后调用
  async function settleFactory(proofs, fp) {
    const layout = { impl: LAYOUT_IMPLEMENTATIONS.factory }
    if (fp.n !== null) {
      const { length, element } = STORAGE.cpuAt(fp.n)
      await proofs.settle('cpuAt', factory, fp.p, { ...layout, detail: { processor: String(fp.n) }, check: (v) => {
        if (v.get(length) <= BigInt(fp.n)) return `the factory has ${v.get(length)} processors, the nodes answered cpuAt(${fp.n})`
        return eqAddr(addressOfWord(v.get(element)), fp.circuits) ? null : `cpuAt(${fp.n}) holds 0x${v.get(element).toString(16)}, the nodes answered ${fp.circuits}`
      } })
    }
    await proofs.settle('isCPU', factory, fp.p, { ...layout, detail: { circuits: checksumAddress(fp.circuits) }, check: (v) => {
      const w = v.get(STORAGE.isCPU(fp.circuits))
      return w === 1n ? null : `isCPU(${fp.circuits}) holds ${w}, the nodes answered true`
    } })
  }

  async function resolve(target) {
    // 1.4: the TAP-10 conformance mode has its own input forms and order of checks (below); a { dev } target is the same
    // in both modes. / 一致模式有自己的输入形式与检查顺序（见下）；{ dev } 目标两种模式相同。
    if (conformMode && !(target && typeof target === 'object' && 'dev' in target)) return resolveConform(target)
    // A name or { chainId, ... } on another chain is resolved by that chain's client (TAPI-20 §3.1: identity, manifest and
    // delegation all live on the chain the circuit is on). / 别的链上的名字或 { chainId, ... } 交给那条链的客户端解析。
    const where = chainOfTarget(target)
    if (where !== null && where !== Number(chainId)) return forChain(where).resolve(target)
    // Round trips (review O-1 / P2-1): reads that do not depend on each other go out together, and the rpc client sends
    // those to one node as one batch. A target that names its (circuits, tokenId) -- a name, or the pair -- lets the
    // reads of steps 3 and 4 (isCPU, ownerOf) start with accountOf, before the manifest is read. They are used only if
    // the manifest names that same pair, which step 3 requires anyway (the container must re-derive from the manifest's
    // own pair); otherwise they are read again for the manifest's pair. Every check runs on the same answers, in the same
    // order, with the same codes as when each read waited for the one before it.
    // 往返次数：互不依赖的读取一起发出，rpc 客户端把发往同一节点的读取合并成一个批量请求。目标本身给出 (circuits, tokenId)
    // 时（名字或二元组），第 3、4 步的读取（isCPU、ownerOf）与 accountOf 一起提前发出，在读清单之前。只有清单写的正是这一对时
    // 才使用它们——第 3 步本来就要求如此（容器必须能由清单自己的二元组重新推导出来）；否则按清单的二元组重新读取。
    // 每项检查都作用于同样的回答，先后与错误码与逐个等待时完全相同。
    // Security 1.1: a pinning client first agrees on one block (one more round) and every read below is made at it; the
    // sentinel's slot reads go out in the same turn as the manifest's read(). / 钉块的客户端先确定一个区块（多一轮），下面每个读取
    // 都在它上面；哨兵的实现槽读取与清单的 read() 在同一轮发出。
    const devTarget = !!(target && typeof target === 'object' && 'dev' in target)
    const pinned = pinConf && !devTarget ? await pinnedBlock() : null
    const at = pinned ? blockParamOf(pinned) : 'latest'
    // Security 1.2: this resolution's proofs (only with pin) / 本次解析的证明（只在钉块时）
    const proofs = proofMode && pinned ? proofSession(pinned) : null
    let implsP = null
    const ctx = { at, beforeRead: () => { implsP = implsP ?? early(() => readImplementations(at)) }, proofs }
    let src
    let located = null
    // `n`: the processor number when a name gave the circuits (its cpuAt is proven too) / 名字给出电路时的处理器编号（其 cpuAt 也证明）
    const ahead = (circuits, tokenId, n = null) => ({
      circuits, tokenId, isCPU: early(() => isCPUAt(circuits, at)), holder: early(() => view(circuits, 'ownerOf', [BigInt(tokenId)], at)),
      ...(proofs ? { factoryProof: factoryProof(proofs, circuits, n), ownerProof: proofs.request(circuits, [STORAGE.ownerOf(tokenId)]) } : {}),
    })
    if (typeof target === 'string') {
      const name = tapeName(target)
      if (isAddress(target)) src = await manifestFromContainer(target, ctx)
      // A TapeOut name, <#ID>.<processor>.tape: the processor number gives the circuits contract, which with #ID gives
      // the container (TapeKit SPEC §3.2), so the name adds no trust beyond the { circuits, tokenId } path.
      // TapeOut 名字：处理器编号 → 电路合约，再与 #ID 得到容器；与 { circuits, tokenId } 路径信任相同。
      else if (name) {
        const circuits = await factCpuAt(name.processor, at)
        const container = factAccountOf(circuits, name.tokenId, at)
        located = ahead(circuits, name.tokenId, BigInt(name.processor))
        src = await manifestFromContainer(await container, ctx)
      } else {
        const container = await view(needDirectory(), 'resolve', [labelToBytes32(target)], at)
        if (eqAddr(container, ZERO_ADDRESS)) throw new TapeAPIError('NOT_FOUND', `label "${target}" not registered`)
        src = await manifestFromContainer(container, ctx)
      }
    } else if (target && typeof target === 'object') {
      if ('dev' in target) src = await manifestFromDev(target.dev)
      else if (target.circuits && target.tokenId != null) {
        const container = factAccountOf(target.circuits, target.tokenId, at)
        located = ahead(target.circuits, target.tokenId)
        src = await manifestFromContainer(await container, ctx)
      }
      else if (target.chainId !== undefined && isAddress(target.container)) src = await manifestFromContainer(target.container, ctx)
      else throw new TapeAPIError('INVALID_ARGUMENT', 'unsupported resolve target')
    } else throw new TapeAPIError('INVALID_ARGUMENT', 'unsupported resolve target')

    // 只有 dev 来源的清单才放宽校验；dev: true 不影响链上来源清单（M-06）/ only dev-sourced manifests are relaxed
    const dev = !!src.dev
    let manifest = validateManifest(src.manifest, { requireDelegation: !dev, allowHttp, now: now() })
    // TAPI-20 §3.9: an `ai` field that breaks any MUST is refused as a field (MANIFEST_INVALID) and dropped here; the rest
    // of the manifest is unaffected. A valid one is kept in its normalised form. / 违反 §3.9 任一 MUST 的 ai 字段按字段拒绝并在此
    // 丢弃，清单其余部分不受影响；合规的保留其规范化形式。
    let aiProblems
    if (manifest[AI_FIELD] !== undefined) {
      manifest = { ...manifest }
      try { manifest[AI_FIELD] = validateAIField(manifest[AI_FIELD], { allowHttp: allowHttp || dev }) } catch (e) { aiProblems = [e.message]; delete manifest[AI_FIELD] }
    }
    if (src.container && !eqAddr(src.container, manifest.container)) throw new TapeAPIError('MANIFEST_INVALID', 'manifest.container does not match resolved container')
    // TAPI-20 §3.6 step 3, for EVERY on-chain input form (label, container, pair): the container is re-derived from
    // the manifest's own (circuits, tokenId) on the hub and must equal both manifest.container and the located
    // container. This is what makes identity non-self-asserted, and it needs no directory.
    // §3.6 第 3 步，对所有链上输入形式生效：用清单自己的 (circuits, tokenId) 在 hub 上重新推导容器，必须同时等于
    // manifest.container 与定位到的容器。身份不可自述靠的就是这一步，且不需要目录。
    // Steps 3-5 and the contribution read go out together; each is still checked in its place below. accountOf of the pair
    // the target named is the cached fact from above: no second read.
    // 第 3-5 步与贡献比例的读取一起发出；每一项仍在下面原来的位置检查。目标所给二元组的 accountOf 是上面缓存的事实：不再读第二次。
    let holder = null, contributionP = null, ownerProof = null, cpuProof = null
    const warnings = []
    const issue = (code, message, extra = {}) => { const w = { code, message, ...extra }; warnings.push(w); try { onWarning(w) } catch { /* a reporter never breaks resolve / 报告函数绝不影响解析 */ } }
    let sentinel = null
    if (!dev) {
      const same = located !== null && eqAddr(located.circuits, manifest.circuits) && BigInt(located.tokenId) === BigInt(manifest.tokenId)
      const derivedP = factAccountOf(manifest.circuits, manifest.tokenId, at)
      const cpu = same ? located.isCPU : early(() => isCPUAt(manifest.circuits, at))
      holder = same ? located.holder : early(() => view(manifest.circuits, 'ownerOf', [BigInt(manifest.tokenId)], at))
      if (proofs) {
        ownerProof = same ? located.ownerProof : proofs.request(manifest.circuits, [STORAGE.ownerOf(manifest.tokenId)])
        // The target's own factory proof when it named these circuits (with cpuAt for a name); otherwise isCPU alone. A
        // manifest naming other circuits than the target is refused below (its container cannot derive), so only these count.
        // 目标所指正是这些电路时用它的工厂证明（名字还含 cpuAt），否则只证 isCPU。清单所写电路与目标不同的，下面会因容器推导不出而被拒。
        cpuProof = located && eqAddr(located.circuits, manifest.circuits) ? located.factoryProof : factoryProof(proofs, manifest.circuits)
      }
      contributionP = early(() => readContribution(manifest, at))
      const derived = await derivedP
      if (!eqAddr(derived, manifest.container)) throw new TapeAPIError('MANIFEST_INVALID', `hub.accountOf(${manifest.circuits}, ${manifest.tokenId}) is ${derived}, manifest.container is ${manifest.container}`)
      await requireCPU(manifest.circuits, 'MANIFEST_INVALID', cpu)
      // Security 1.2: cpuAt and isCPU against the factory's proven storage / 对照工厂已证明的存储核对 cpuAt 与 isCPU
      if (proofs) await settleFactory(proofs, cpuProof)
      if (sentinelProxies.length || localDerivation) sentinel = { mode: sentinelMode, implementations: null, container: 'unchecked' }
      // Sentinel, second half: the hub's derivation against ERC-6551 computed here, with no read.
      // 哨兵的后一半：hub 的推导与本地按 ERC-6551 算出的地址比对，不读链。
      if (localDerivation) {
        const local = erc6551Account({ registry: known.erc6551Registry, implementation: known.accountImplementation, chainId, tokenContract: manifest.circuits, tokenId: manifest.tokenId })
        sentinel.container = eqAddr(local, derived) ? 'match' : 'mismatch'
        if (sentinel.container === 'mismatch') {
          const msg = `hub.accountOf(${manifest.circuits}, ${manifest.tokenId}) is ${derived}, but ERC-6551 (registry ${known.erc6551Registry}, implementation ${known.accountImplementation}, salt 0) derives ${local}: the hub was upgraded or the nodes are wrong`
          if (sentinelMode === 'strict') throw new TapeAPIError('MANIFEST_INVALID', msg, { data: { derived, local } })
          issue('CONTAINER_MISMATCH', msg, { derived, local })
        }
      }
    }
    if (src.service) {
      if (!eqAddr(src.service.circuits, manifest.circuits) || BigInt(src.service.tokenId) !== BigInt(manifest.tokenId)) throw new TapeAPIError('MANIFEST_INVALID', 'manifest circuits/tokenId do not match directory record')
    }
    const verified = await verifyDelegation(manifest, { dev, holder, at })
    // Security 1.2: the holder against the circuit's proven ownerOf slot (a proxy whose code has no cheap proof, so the
    // layout is checked by agreement with eth_call) / 持有人对照电路合约已证明的 ownerOf 槽
    if (proofs && ownerProof) {
      const slot = STORAGE.ownerOf(manifest.tokenId)
      await proofs.settle('ownerOf', manifest.circuits, ownerProof, { detail: { tokenId: String(manifest.tokenId) }, check: (v) => {
        const w = v.get(slot)
        return eqAddr(addressOfWord(w), verified.holder) ? null : `ownerOf(${manifest.tokenId}) is ${verified.holder}, the proven slot holds 0x${w.toString(16)}`
      } })
    }
    const contribution = dev ? 0 : await contributionP
    // TAPI-20 §3.10 (OPTIONAL, security 1.1): the holder's signature over the manifest content. Checked whenever present
    // (a bad one is a warning) and required only by requireContentSig. Without requireContentSig nothing in this check
    // can fail a resolution that 1.1.0 accepted: an error while checking (eth_getCode or isValidSignature for a
    // non-matching signature, an RPC failure) is the warning CONTENT_SIG_UNCHECKED and `contentSig: { valid: false,
    // checked: false }` (FIXED SECR-1). With it, the error is thrown as it came.
    // 持有人对清单内容的签名：出现就核对（无效只警告），只有 requireContentSig 才要求必须有。不开 requireContentSig 时，这项检查
    // 绝不会让 1.1.0 能通过的解析失败：核对中的错误（签名不匹配时的 eth_getCode 或 isValidSignature、RPC 故障）记为警告
    // CONTENT_SIG_UNCHECKED，`contentSig: { valid: false, checked: false }`（FIXED SECR-1）。开启时原样抛出。
    let contentSig = null
    if (!dev && (requireContentSig || src.manifest?.[MANIFEST_CONTENT_FIELD] !== undefined)) {
      let why
      try { why = await contentSigProblem(src.manifest, manifest.container, verified.holder, at) } catch (e) {
        if (requireContentSig) throw e
        why = undefined
        contentSig = { valid: false, checked: false }
        issue('CONTENT_SIG_UNCHECKED', `contentSig could not be checked: ${e?.message ?? e}`, e instanceof TapeAPIError ? { cause: e.code } : {})
      }
      if (why !== undefined) {
        if (why && requireContentSig) throw new TapeAPIError('MANIFEST_INVALID', `requireContentSig: ${why}`)
        contentSig = { valid: !why }
        if (why) issue('CONTENT_SIG_INVALID', why)
      }
    }
    // Sentinel, first half: the implementation slots read with the manifest (or cached). / 哨兵的前一半：实现槽。
    if (sentinel && sentinelProxies.length) {
      try {
        sentinel.implementations = await (implsP ?? readImplementations(at))
        for (const x of sentinel.implementations.filter((i) => !i.expected)) {
          const msg = `${x.role} ${x.proxy} now runs implementation ${x.implementation}, which this SDK does not know (chains.js expectedImpl): TapeOut upgraded it`
          if (sentinelMode === 'strict') throw new TapeAPIError('CONTRACT_UNKNOWN', msg, { data: { role: x.role, proxy: x.proxy, implementation: x.implementation } })
          issue('IMPL_UNKNOWN', msg, { role: x.role, proxy: x.proxy, implementation: x.implementation })
        }
      } catch (e) {
        if (sentinelMode === 'strict' || (e instanceof TapeAPIError && e.code === 'CONTRACT_UNKNOWN')) throw e
        issue('IMPL_UNREAD', `could not read the implementation slots of ${sentinelProxies.map((x) => x.role).join(', ')}: ${e.message}`)
      }
    }
    // Delegation floor (security 1.1, opt-in): per container, holder AND signer, the highest signed `expires` seen. A lower
    // one for the same signer is an older manifest put back. A delegation to another signer starts its own floor, so a
    // holder who replaces the signer with a shorter delegation is not refused (FIXED SECR-4). Limits: a site writer can
    // still put back an older holder-signed delegation to an EARLIER signer (its expires is not below that signer's
    // floor); a holder who shortens `expires` for the same signer is refused until api.clearDelegationFloor. Moved only
    // once everything else passed.
    // 委托下限：按容器、持有人**与签名者**记住见过的最大 expires，同一签名者更低的就是被放回的旧清单。委托给另一个签名者的从自己
    // 的下限开始，持有人以更短的委托更换签名者不会被拒（FIXED SECR-4）。局限：站点写入者仍可把持有人签给**以前**签名者的旧委托放回去
    // （其 expires 不低于该签名者的下限）；持有人为同一签名者缩短 expires 会被拒，直到 api.clearDelegationFloor。只在其它检查全部
    // 通过后才抬高。
    if (delegationFloor && !dev && verified.holder) {
      const who = { chainId, container: checksumAddress(manifest.container), holder: checksumAddress(verified.holder), signer: checksumAddress(manifest.signer) }
      const key = delegationFloorKey(who)
      const seen = Number((await delegationFloor.get(key)) ?? 0)
      if (manifest.delegation.expires < seen) throw new TapeAPIError('DELEGATION_INVALID', `delegation.expires ${manifest.delegation.expires} is below ${seen}, already seen for ${manifest.container} under holder ${verified.holder} and signer ${who.signer}: an older manifest was put back (api.clearDelegationFloor(error.data) accepts it again)`, { data: { expires: manifest.delegation.expires, floor: seen, ...who } })
      if (manifest.delegation.expires > seen) await delegationFloor.set(key, manifest.delegation.expires)
    }
    // `target` and `fetchedAt` make the manifest re-readable. TAPI-20 §3.6 says clients SHOULD re-check
    // periodically; without a way back to the source that sentence cannot be implemented, and a provider that
    // changes its price deadlocks every consumer holding the old manifest for ever.
    // 记住来源与取回时间，清单才能重读。TAPI-20 §3.6 要求客户端定期复查；没有回到来源的路径这句话就无法实现，
    // 而提供者一旦改价，所有持旧清单的消费者会被永久卡死。
    // `chainId`: the chain this service lives on; call, refresh and price consent go through that chain's client.
    // `chainId`：服务所在的链；call、refresh 与价格同意都经由那条链的客户端。
    const svc = { manifest, container: checksumAddress(manifest.container), chainId, verified, contribution, file: src.file ?? null, target, fetchedAt: now() }
    if (aiProblems) svc.aiProblems = aiProblems
    // Security 1.1 fields, present only when they say something / 安全加固 1.1 的字段，只在有内容时出现
    if (pinned) svc.pinned = { number: pinned.number, hash: pinned.hash, timestamp: pinned.timestamp, tag: pinned.tag, by: pinConf.by, ...(pinConf.mode === 'tap10' ? { mode: 'tap10', lag: pinned.lag, maxLag: pinned.maxLag } : {}) }
    if (sentinel) svc.sentinel = sentinel
    if (contentSig) svc.contentSig = contentSig
    // Security 1.2: what was proven, and (proofs: true) a warning for each read that could not be proven (a contradiction
    // was thrown above). / 证明了什么；无法证明的每项各一条警告（矛盾已在上面抛出）
    if (proofs) {
      for (const x of proofs.unavailable) issue('PROOF_UNAVAILABLE', `${x.read} ${x.address} not proven: ${x.reason}`, { read: x.read })
      for (const x of proofs.invalid) issue('PROOF_INVALID', `${x.read} ${x.address}: ${x.reason}`, { read: x.read })
      svc.proofs = { mode: proofs.mode, block: proofs.block, stateRoot: proofs.stateRoot, verified: proofs.verified, unavailable: proofs.unavailable, invalid: proofs.invalid }
    }
    if (warnings.length) svc.warnings = warnings
    ACCEPTED.set(svc, pricesOf(manifest))
    return svc
  }

  // The holder's content signature (TAPI-20 §3.10): null when valid, else why not. `read`: as for verifyDelegation.
  // 持有人的内容签名：有效返回 null，否则返回原因。`read`：同 verifyDelegation。
  async function contentSigProblem(raw, container, holder, at, read) {
    const sig = raw?.[MANIFEST_CONTENT_FIELD]
    if (sig === undefined) return 'the manifest carries no contentSig'
    if (typeof sig !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){65,1024}$/.test(sig)) return 'contentSig must be a signature of 65 to 1024 bytes'
    if (!holder) return 'no holder to check contentSig against'
    let digest
    try { digest = manifestContentDigest(chainId, hub, { container, contentHash: manifestContentHash(raw) }) } catch (e) { return `the manifest has no canonical form: ${e.message}` }
    let recovered = null
    if (sig.length === 132) { try { recovered = recoverAddress(digest, sig) } catch { /* not ECDSA / 不是 ECDSA */ } }
    if (recovered && eqAddr(recovered, holder)) return null
    if (await holderApproves(holder, digest, sig, at, read)) return null
    return recovered ? `contentSig is signed by ${recovered}, the holder is ${holder}` : `holder ${holder} does not accept contentSig under EIP-1271`
  }

  // ════ TAP-10 conformance mode (@experimental, 1.4: the resolution path) / TAP-10 一致模式（1.4：解析路径） ════════════
  // createTapeAPI({ conform: 'tap10' }) resolves as TAP-10 v1.1 §3–§7 and TAP-11 §2.2 say, at one TAP-10 pinned block
  // (§5.3): identity (§4.2, §4.3 with the processor number found from the shipped snapshot or a paged cpuAt scan), the site
  // status in the order of §6.2 (store-changed, identity outcome, not-opened, unpaid), then the manifest (TAP-11 §2.2 steps
  // 3–8). The eth_chainId check, ownerOf and a contract holder's EIP-1271 calls are read under strict agreement (TAP-11
  // §2.2), everything else under default agreement. Every error carries the TAP name in data.status. api.siteStatus(target) gives the first two parts in any mode,
  // without throwing on a site status. With allChains (1.5), input without chain information is resolved on every chain
  // (§4.1, everyChain below). The messaging reads (channelKeys, tapeSendKey) have their own TAP-10 path, after
  // readChannelKeys above; activation is never checked there, in any mode (TAP-10 §12.2 says it MUST NOT stop messaging).
  // createTapeAPI({ conform: 'tap10' }) 按 TAP-10 v1.1 §3–§7 与 TAP-11 §2.2 解析，全部读取钉在一个 TAP-10 钉块上（§5.3）：身份
  // （§4.2；§4.3 的处理器号来自随版本发布的快照或分页扫描 cpuAt）、按 §6.2 顺序的站点状态（store-changed、身份结果、not-opened、
  // unpaid），然后是清单（TAP-11 §2.2 第 3–8 步）。eth_chainId 检查、ownerOf 与合约持有人的 EIP-1271 调用用严格共识（TAP-11 §2.2），其余用默认共识。
  // 每个错误的 data.status 带 TAP 的名字。api.siteStatus(target) 在任何模式下给出
  // 前两部分，站点状态不抛错。开启 allChains（1.5）时，无链信息的输入在所有链上解析（§4.1，见下面的 everyChain）。消息读取
  // （channelKeys、tapeSendKey）有自己的 TAP-10 路径，在上面 readChannelKeys 之后；那里任何模式下都不查激活（TAP-10 §12.2 规定激活
  // 不得阻止消息）。
  const TAP10_VERSION = '1.1'
  const TAP10_READ = { answers: 'tap10' }
  // A TapeAPIError carrying the TAP-10 / TAP-11 outcome name / 带 TAP-10 / TAP-11 结果名的错误
  const tapErr = (code, status, message, data = {}) => new TapeAPIError(code, message, { data: { ...data, status } })
  // Any error leaving the conformance mode carries data.status; one without a TAP name gets the closest. / 离开一致模式的错误都带 data.status
  const STATUS_OF_CODE = { INVALID_ARGUMENT: 'input-error', MANIFEST_INVALID: 'manifest-invalid', DELEGATION_INVALID: 'delegation-invalid', CONTRACT_UNKNOWN: 'hub-changed', NOT_FOUND: 'not-tapeout' }
  function withStatus(e) {
    if (!(e instanceof TapeAPIError) || e.data?.status) return e
    const status = STATUS_OF_CODE[e.code] ?? 'unavailable'
    e.data = { ...(e.data && typeof e.data === 'object' ? e.data : {}), status }
    return e
  }
  // Reads at the pinned block, under TAP-10's rule of what counts as an answer / 在钉块上读取，按 TAP-10 什么算回答的规则
  async function viewTap(to, name, args, at) { return decodeReturn(name, await needRpc().ethCall(to, encodeCall(name, args), at, TAP10_READ)) }
  const reverted = (e) => isRevert(e) || (e instanceof TapeAPIError && e.code === 'ABI_INVALID')
  // factory.isCPU under the same read rule as every other read of the mode. A true answer is kept for good in knownCPUs,
  // shared with the default mode: isCPU never goes back to false (the processor list is append-only).
  // 与本模式其它读取同样的规则读 factory.isCPU。为真的回答永久记在 knownCPUs，与默认模式共用：isCPU 不会由真变假（处理器列表只增不减）。
  async function isCPUTap(circuits, at) {
    const k = String(circuits).toLowerCase()
    if (knownCPUs.has(k)) return true
    const yes = (await viewTap(factory, 'isCPU', [circuits], at)) === true
    if (yes && knownCPUs.size < 4096) knownCPUs.add(k)
    return yes
  }

  // §5.4 for siteStatus (any mode): one eth_chainId per client before its first adopted read; only a success is kept.
  // Default agreement (quorum operators, every answer equal), not strict: siteStatus authorises nothing, TAP-10 §5.4 makes
  // strict a MUST for messaging clients only, and strict would let one node down stop siteStatus where the default mode
  // goes on. The conformance mode's resolve uses checkChainStrict instead (shared with the messaging path): it reads ownerOf
  // and a contract holder's EIP-1271 calls (eth_getCode, isValidSignature, for the delegation and for contentSig) under
  // strict agreement anyway (TAP-11 §2.2), so a node that cannot answer stops it before any state is read. Every other read
  // of a resolution stays under default agreement (TAP-11 §2.2's MUST). A node on another chain disagrees in both checks,
  // and all of them is wrong-chain.
  // siteStatus（任何模式）的 §5.4：每个客户端在第一次采用读取之前做一次 eth_chainId；只保留成功的结果。用默认共识，不用严格共识：
  // siteStatus 不授权任何东西，TAP-10 §5.4 只对消息客户端规定严格共识为 MUST，严格共识会让一个节点宕机就停掉 siteStatus 而默认模式照常。
  // 一致模式的 resolve 改用 checkChainStrict（与消息路径共用）：它反正要用严格共识读 ownerOf 与合约持有人的 EIP-1271 调用（TAP-11
  // §2.2），所以作答不了的节点让它在读任何状态之前就停下。解析的其它读取仍用默认共识（TAP-11 §2.2 的 MUST）。别的链上的节点在两种检查里
  // 都造成分歧，全都在别的链上即 wrong-chain。
  let chainChecked = null
  function checkChain() {
    if (chainChecked) return chainChecked
    const p = (async () => {
      const got = Number(BigInt(await needRpc().call('eth_chainId', [], TAP10_READ)))
      if (got !== Number(chainId)) throw tapErr('INVALID_ARGUMENT', 'wrong-chain', `wrong-chain: the nodes of this client answer eth_chainId ${got}, not ${chainId} (TAP-10 §5.4)`, { expected: Number(chainId), answered: got })
      return true
    })()
    chainChecked = p
    p.catch(() => { if (chainChecked === p) chainChecked = null })
    return p
  }
  // The TAP-10 pinned block for siteStatus (any mode) and for the conformance mode's resolve. / siteStatus 与一致模式 resolve 的钉块
  async function tap10Pin() {
    if (pinConf?.mode === 'tap10') return pinnedBlock()
    if (!Number.isSafeInteger(known?.tap10MaxPinLag)) throw tapErr('INVALID_ARGUMENT', 'input-error', `chain ${chainId} is not a TapeOut chain listed in chains.js: no TAP-10 max pin lag`)
    return needRpc().tap10Block({ maxLag: known.tap10MaxPinLag })
  }
  // §4.3: the processor table may be kept for good (numbers are append-only); only an answer is kept.
  // §4.3：处理器表可以永久保留（编号只增不减）；只保留回答。
  // Every entry was read at a pinned block (a name's cpuAt, a checked snapshot hit, a scan), never taken unread.
  // 每一项都是在钉块上读到的（名字的 cpuAt、核实过的快照命中、扫描），绝不未读即用。
  const processorTable = new Map()   // processor number (string) -> processor contract / 处理器号 -> 处理器合约
  const processorNumbers = new Map() // processor contract (lowercase) -> processor number / 处理器合约 -> 处理器号
  // `_processorTableMax` is for tests only (a full table) / 仅供测试（表满的情形）
  const PROCESSOR_TABLE_MAX = Number.isSafeInteger(opts._processorTableMax) ? opts._processorTableMax : 65_536
  // Returns false when the table is full and the entry was not kept / 表满、没有保留时返回 false
  const keepProcessor = (n, circuits) => {
    if (processorTable.has(String(n))) return true
    if (processorTable.size >= PROCESSOR_TABLE_MAX) return false
    processorTable.set(String(n), circuits); processorNumbers.set(String(circuits).toLowerCase(), String(n))
    return true
  }
  const numberOf = (circuits) => processorNumbers.get(String(circuits).toLowerCase()) ?? null

  // §4.3 step 3, the processor number of a processor contract (isCPU already true). The factory has no reverse table, so
  // TAP-10 scans cpuAt(i); cold, that is over a thousand reads per node on BNB Smart Chain, which public nodes rate-limit
  // (design risk 2). So, in order:
  //   1. the kept table;
  //   2. the snapshot shipped with this version (processors-snapshot.js, scripts/gen-processors-snapshot.mjs), used only for
  //      this chain's own factory: a hit is checked with ONE cpuAt(i) at the pinned block before it is used or kept;
  //   3. a scan of cpuAt at the pinned block, in pages of SCAN_PAGE reads (the rpc client batches each page per node), at
  //      most SCAN_MAX numbers per resolution, resuming on the next one where it stopped (`unavailable` until then). It
  //      covers only the numbers after the snapshot when the chain agrees with the snapshot (cpuCount >= its count and the
  //      snapshot's last entry read back unchanged), all numbers otherwise. Numbers are append-only and never reused
  //      (TAP-10 §1), which is what makes both the snapshot and the resumed scan sound.
  // Returns the number as a string, or null when the processor is not in the factory's list (not-tapeout).
  // §4.3 第 3 步：处理器合约的处理器号（isCPU 已为真）。工厂没有反查表，TAP-10 逐个扫 cpuAt(i)；冷启动在 BNB 上每个节点要上千次读取，
  // 会被公共节点限流（设计风险 2）。所以依次：1. 已保留的表；2. 随版本发布的快照，只用于本链自己的工厂，命中后先在钉块上读一次 cpuAt(i)
  // 核实才用、才保留；3. 在钉块上分页扫描 cpuAt，每页 SCAN_PAGE 个（rpc 客户端按节点合并为批量），每次解析至多 SCAN_MAX 个，下次从停下处
  // 继续（之前报 unavailable）。链与快照一致时（cpuCount 不小于快照数量、快照最后一项读回不变）只扫快照之后的编号，否则全部扫描。
  // 编号只增不减、永不复用（TAP-10 §1），快照与续扫因此成立。返回字符串编号；不在工厂列表里返回 null（not-tapeout）。
  const SCAN_PAGE = 8
  const SCAN_MAX = 256
  const snapshot = (() => { const t = PROCESSORS_SNAPSHOT[Number(chainId)]; return t && eqAddr(t.factory, factory) ? t : null })()
  let snapshotIndex = null           // processor contract (lowercase) -> snapshot number, built on first use / 首次用到时建立
  let snapshotAgrees = null          // null: not checked yet; true / false: what the chain said / 尚未核对；链的回答
  let scan = null                    // { from, next }: the numbers scanned so far, from `from` / 已扫描的编号
  async function processorNumberOf(circuits, at) {
    const kept = numberOf(circuits)
    if (kept !== null) return kept
    if (snapshot && snapshotAgrees !== false) {
      snapshotIndex ??= new Map(snapshot.list.map((a, i) => [a, i]))
      const i = snapshotIndex.get(String(circuits).toLowerCase())
      if (i !== undefined) {
        let got = null
        try { got = await viewTap(factory, 'cpuAt', [BigInt(i)], at) } catch (e) { if (!reverted(e)) throw e }
        if (got !== null && eqAddr(got, circuits)) { keepProcessor(i, checksumAddress(got)); return String(i) }
        snapshotAgrees = false   // the chain says otherwise: no longer trusted, scan everything / 链给出不同答案：不再信任，全部扫描
      }
    }
    return scanProcessors(circuits, at)
  }
  // One scan at a time per client: two resolutions scanning together would otherwise share `scan.next` and skip numbers.
  // 每个客户端同一时间只有一次扫描：否则两次解析同时扫描会共用 scan.next 而漏掉编号。
  let scanQueue = Promise.resolve()
  function scanProcessors(circuits, at) {
    const run = scanQueue.then(() => scanNow(circuits, at))
    scanQueue = run.catch(() => {})
    return run
  }
  async function scanNow(circuits, at) {
    const kept = numberOf(circuits)   // found by the scan this one waited for / 前一次扫描已找到
    if (kept !== null) return kept
    const checkLast = snapshot && snapshotAgrees === null && snapshot.count > 0
    const countP = early(() => viewTap(factory, 'cpuCount', [], at))
    const lastP = checkLast ? early(() => viewTap(factory, 'cpuAt', [BigInt(snapshot.count - 1)], at).catch((e) => { if (reverted(e)) return null; throw e })) : null
    const count = Number(await countP)
    if (checkLast) {
      const last = await lastP
      snapshotAgrees = count >= snapshot.count && last !== null && eqAddr(last, snapshot.list[snapshot.count - 1])
    }
    const from = snapshot && snapshotAgrees ? snapshot.count : 0
    if (!scan || scan.from !== from) scan = { from, next: from }
    for (let budget = SCAN_MAX; scan.next < count && budget > 0;) {
      const idx = Array.from({ length: Math.min(SCAN_PAGE, count - scan.next, budget) }, (_, k) => scan.next + k)
      const page = await Promise.all(idx.map((i) => processorTable.get(String(i)) ?? viewTap(factory, 'cpuAt', [BigInt(i)], at)))
      const hit = page.findIndex((a) => eqAddr(a, circuits))
      // A full table keeps nothing more: the scan must not move past numbers it could not keep, or a later lookup of one of
      // them would find nothing and say not-tapeout. / 表满后不再保留：扫描不得越过没能保留的编号，否则之后查它们会误报 not-tapeout。
      const kept = idx.map((i, k) => keepProcessor(i, checksumAddress(page[k])))
      if (hit >= 0) { if (kept.every(Boolean)) scan.next += idx.length; return String(idx[hit]) }
      if (!kept.every(Boolean)) {
        throw tapErr('RPC_UNAVAILABLE', 'unavailable', `unavailable: the processor table this client keeps is full (${PROCESSOR_TABLE_MAX} entries), so the scan for ${circuits} stops at number ${scan.next} of ${count} (TAP-10 §4.3 step 3); use a new client`, { scan: { from, next: scan.next, count, full: true } })
      }
      scan.next += idx.length; budget -= idx.length
    }
    if (scan.next >= count) return null
    throw tapErr('RPC_UNAVAILABLE', 'unavailable', `unavailable: ${circuits} is a TapeOut processor (isCPU), but its processor number is not among the ${scan.next - from} read so far (numbers ${from} to ${scan.next - 1} of ${count}); the scan reads at most ${SCAN_MAX} per resolution and goes on from there next time (TAP-10 §4.3 step 3)`, { scan: { from, next: scan.next, count } })
  }

  // The site store and payment contract implementations at the pinned block (§6.1), read fresh every time.
  // 钉块上站点存储与付费合约的实现（§6.1），每次重读。
  async function siteImplementations(at) {
    return Promise.all([['siteRegistry', siteRegistry], ['binding', binding]].map(async ([role, proxy]) => {
      const word = String(await needRpc().call('eth_getStorageAt', [proxy, IMPL_SLOT, at], TAP10_READ))
      if (!/^0x[0-9a-fA-F]{64}$/.test(word)) throw tapErr('RPC_ERROR', 'unavailable', `eth_getStorageAt(${proxy}) answered ${word.slice(0, 80)}`)
      const implementation = '0x' + word.slice(-40).toLowerCase()
      const accepted = (known?.expectedImpl?.[String(proxy).toLowerCase()] ?? []).includes(implementation)
      return { role, proxy: checksumAddress(proxy), implementation, accepted }
    }))
  }

  // Parse a target into what TAP-10 §3.4 accepts (input errors thrown) and the chain it names (null: this client's).
  // `chainless`: a container address or processor contract#ID STRING, TAP-10's input without chain information (§4.1);
  // the object forms name their chain (default: this client's).
  // 把目标解析为 TAP-10 §3.4 接受的形式（输入错误直接抛出）以及它所指的链（null 为本客户端的链）。chainless：容器地址或
  // "处理器合约#ID"**字符串**，即 TAP-10 的无链信息输入（§4.1）；对象形式自带链（默认本客户端的链）。
  function conformInput(target) {
    if (typeof target === 'string') {
      const p = parseTapeInput(target)
      if (p.error) throw tapErr('INVALID_ARGUMENT', 'input-error', p.error)
      return { input: p, where: p.kind === 'name' ? p.chainId : null, chainless: p.kind !== 'name' }
    }
    if (target && typeof target === 'object' && !('dev' in target)) {
      let where = null
      if (target.chainId !== undefined) {
        where = Number(target.chainId)
        if (!Number.isSafeInteger(where) || where < 1) throw tapErr('INVALID_ARGUMENT', 'input-error', 'target.chainId must be a chain id')
      }
      if (isAddress(target.circuits) && target.tokenId != null) {
        let t
        try { t = BigInt(target.tokenId) } catch { throw tapErr('INVALID_ARGUMENT', 'input-error', 'target.tokenId must be a whole number') }
        if (t < 1n || t > MAX_TOKEN_ID) throw tapErr('INVALID_ARGUMENT', 'input-error', 'target.tokenId is out of range: 1 <= #ID <= 10^18 (TAP-10 §3.1)')
        return { input: { kind: 'pair', circuits: target.circuits, tokenId: t.toString() }, where, chainless: false }
      }
      if (isAddress(target.container) && where !== null) return { input: { kind: 'container', container: target.container }, where, chainless: false }
    }
    throw tapErr('INVALID_ARGUMENT', 'input-error', 'unsupported resolve target: give a TAP-10 input form (TAP-10 §3.4), { circuits, tokenId } or { chainId, container }')
  }

  // §4 identity and §6.2 site status at one pinned block. Returns the TAP-10 view: `status` is 'ok' or the first site
  // status that applies (§6.2); reads that cannot be adopted throw. `proofs` / `issue`: the resolve's, when it has them.
  // 在一个钉块上做 §4 身份与 §6.2 站点状态。返回 TAP-10 视图：status 为 'ok' 或第一个适用的站点状态；无法采用的读取直接抛出。
  // TAP-10 reads pin to the block's hash (EIP-1898), whatever the client's own pin option / TAP-10 的读取钉在区块哈希上
  const tapAt = (b) => ({ blockHash: b.hash, requireCanonical: true })
  // `unsure`: a container address string read on this chain only (no allChains), which may be a container of another chain
  // that is not being read: what is no container HERE is `unsupported`, not not-tapeout (TAP-10 §4.1). Otherwise (every
  // chain is being read, or an object form names this chain) it is this chain's not-tapeout.
  // unsure：只在本链读取（未开 allChains）的容器地址字符串，可能是没有读取的别的链上的容器：在本链不是容器即报 unsupported，
  // 不报 not-tapeout（TAP-10 §4.1）。否则（所有链都在读取，或对象形式指明了本链）即为本链的 not-tapeout。
  // `strictHolder`: read ownerOf under strict agreement (TAP-11 §2.2: a forged holder would authorise a signer). Set by the
  // conformance mode's resolve only; siteStatus, in either mode, keeps default agreement (it authorises nothing).
  // strictHolder：ownerOf 用严格共识读取（TAP-11 §2.2：伪造的持有人会授权签名者）。只有一致模式的 resolve 设置；siteStatus 在两种
  // 模式下都保持默认共识（它不授权任何东西）。
  async function identifyAt(input, pinned, { proofs = null, issue = null, unsure = false, strictHolder = false } = {}) {
    const at = tapAt(pinned)
    const out = {
      version: TAP10_VERSION, status: null, chainId: Number(chainId), name: null, processor: null, tokenId: null, circuits: null,
      container: null, holder: null, opened: null, activation: null, implementations: null,
      pinned: { number: pinned.number, hash: pinned.hash, lag: pinned.lag, maxLag: pinned.maxLag },
    }
    const stop = (status) => { out.status = status; return out }
    const implsP = early(() => siteImplementations(at))
    let identity
    if (input.kind === 'name') {
      out.name = input.name; out.processor = input.processor; out.tokenId = input.tokenId
      const cached = processorTable.get(input.processor)
      // §4.2 steps 1-2 (a cached table entry already says the number exists) / 第 1、2 步（缓存的表项已说明编号存在）
      const countP = cached ? null : early(() => viewTap(factory, 'cpuCount', [], at))
      const cpuP = cached ? null : early(() => viewTap(factory, 'cpuAt', [BigInt(input.processor)], at))
      identity = (async () => {
        let circuits = cached
        if (!circuits) {
          if (BigInt(await countP) <= BigInt(input.processor)) return 'no-such-cpu'
          try { circuits = await cpuP } catch (e) { if (reverted(e)) return 'no-such-cpu'; throw e }
          keepProcessor(input.processor, circuits)
        }
        out.circuits = checksumAddress(circuits)
        return null
      })()
    } else if (input.kind === 'container') {
      // §4.3 step 1: token(); its chainId must be this chain. An address that is no container HERE may be one on another
      // chain, and TAP-10 §4.1 forbids not-tapeout until every active chain was read: without allChains this client reads
      // this chain only, so it says `unsupported` instead. A token() naming this chain is a claim no container of another
      // chain can make (ERC-6551 addresses commit to their chainId), so a later failed check is not-tapeout.
      // 第 1 步：token()，其链号须为本链。在本链上不是容器的地址可能是别的链上的容器，而 TAP-10 §4.1 规定读遍所有活跃链之前不得报
      // not-tapeout：不开 allChains 时只读本链，所以改报 unsupported。token() 声称本链时，别的链上的容器不可能如此声称（ERC-6551
      // 地址包含链号），之后的检查失败即为 not-tapeout。
      const elsewhere = (why) => { if (!unsure) return 'not-tapeout'; throw otherChain(input.container, why) }
      identity = (async () => {
        let tok
        try { tok = await viewTap(input.container, 'token', [], at) } catch (e) { if (reverted(e)) return elsewhere('does not answer ERC-6551 token() here'); throw e }
        if (BigInt(tok[0]) !== BigInt(chainId)) return elsewhere(`answers token() for chain ${BigInt(tok[0])}`)
        // A #ID outside TAP-10 §3.1 (0, or above 10^18) names no circuit: a contract claiming it is not a container
        // 超出 TAP-10 §3.1 的 #ID（0 或大于 10^18）不是任何电路：这样声称的合约不是容器
        if (BigInt(tok[2]) < 1n || BigInt(tok[2]) > MAX_TOKEN_ID) return 'not-tapeout'
        out.circuits = checksumAddress(tok[1]); out.tokenId = BigInt(tok[2]).toString()
        out.container = checksumAddress(input.container)
        return null
      })()
    } else {
      out.circuits = checksumAddress(input.circuits); out.tokenId = input.tokenId
      identity = Promise.resolve(null)
    }
    // §6.2 step 1 before every identity outcome: store-changed / 第 1 步先于任何身份结果
    const settle = async (p) => { try { return { v: await p } } catch (e) { return { e } } }
    const [impls, id] = await Promise.all([settle(implsP), settle(identity)])
    if (impls.e) throw impls.e
    out.implementations = impls.v
    if (impls.v.some((x) => !x.accepted)) return stop('store-changed')
    if (id.e) throw id.e
    if (id.v) return stop(id.v)
    // §4.3 steps 2-3 (container address, processor contract#ID): a TapeOut processor, then its processor number (snapshot,
    // then scan: processorNumberOf), read with the steps of §4.2 below in one turn.
    // 第 2、3 步：是 TapeOut 处理器，再找它的处理器号（快照，然后扫描），与下面 §4.2 的读取同一轮发出。
    // A container whose token() names this chain is this chain's or nothing: not-tapeout below is a verdict. A processor
    // contract#ID string gets here unsure only from siteStatus on a default client (under conform it is refused first).
    // token() 指明本链的容器只能是本链的：下面的 not-tapeout 是结论。不确定的"处理器合约#ID"字符串只会来自默认客户端的 siteStatus。
    let numberP = null
    if (input.kind !== 'name') {
      // siteStatus on a default client reads a processor contract#ID string on this chain only (unsure): one that is no
      // processor here may be one on another chain (1.4's unsupported) / 默认客户端的 siteStatus 只在本链读"处理器合约#ID"字符串
      const notCpu = () => { if (unsure && input.kind === 'pair') throw otherChain(out.circuits, 'is not a TapeOut processor here'); return stop('not-tapeout') }
      let cpu
      try { cpu = await isCPUTap(out.circuits, at) } catch (e) { if (reverted(e)) return notCpu(); throw e }
      if (!cpu) return notCpu()
      numberP = early(() => processorNumberOf(out.circuits, at))
    }
    // §4.2 steps 3-5: the container from the OPENER, the holder, opened; one turn / 第 3-5 步：开通器推导容器、持有人、是否开通；同一轮
    const accountP = early(() => viewTap(opener, 'accountOf', [out.circuits, BigInt(out.tokenId)], at))
    const holderP = early(() => (strictHolder ? viewStrict : viewTap)(out.circuits, 'ownerOf', [BigInt(out.tokenId)], at))
    const openedP = early(() => viewTap(opener, 'isOpened', [out.circuits, BigInt(out.tokenId)], at))
    if (numberP) {
      // §4.3 step 3: not in the factory's list -> not-tapeout / 不在工厂列表里即 not-tapeout
      const n = await numberP
      if (n === null) return stop('not-tapeout')
      out.processor = n
    }
    out.name = formatTapeName({ tokenId: out.tokenId, processor: out.processor, chainId })
    const derived = checksumAddress(await accountP)
    // §4.3 step 4: the opener must derive the very address given / 第 4 步：开通器必须推导出给定的那个地址
    if (input.kind === 'container' && !eqAddr(derived, input.container)) return stop('not-tapeout')
    out.container = derived
    // Row 4 of the design: the opener's derivation against ERC-6551 computed here (TapeAPI's own check, under `sentinel`)
    // 设计稿第 4 行：开通器的推导与本地 ERC-6551 推导互验（TapeAPI 自己加的检查，归 sentinel 管）
    if (localDerivation && issue) {
      const local = erc6551Account({ registry: known.erc6551Registry, implementation: known.accountImplementation, chainId, tokenContract: out.circuits, tokenId: out.tokenId })
      out.derivation = eqAddr(local, derived) ? 'match' : 'mismatch'
      if (out.derivation === 'mismatch') {
        const msg = `opener.accountOf(${out.circuits}, ${out.tokenId}) is ${derived}, but ERC-6551 (registry ${known.erc6551Registry}, implementation ${known.accountImplementation}, salt 0) derives ${checksumAddress(local)}: the opener was replaced or the nodes are wrong`
        if (sentinelMode === 'strict') throw tapErr('MANIFEST_INVALID', 'container-mismatch', msg, { derived, local: checksumAddress(local) })
        issue('CONTAINER_MISMATCH', msg, { derived, local: checksumAddress(local) })
      }
    }
    try { out.holder = checksumAddress(await holderP) } catch (e) { if (reverted(e)) return stop('no-such-token'); throw e }
    out.opened = (await openedP) === true
    // the processor number is known for every input since 1.5 (a name, or found above) / 1.5 起每种输入都已知处理器号
    if (proofs) out.proof = { factory: factoryProof(proofs, out.circuits, out.processor !== null ? BigInt(out.processor) : null), owner: proofs.request(out.circuits, [STORAGE.ownerOf(out.tokenId)]) }
    if (!out.opened) return stop('not-opened')
    // §6.3: isLive(on-chain name, derived container) or isContainerLive(derived container); a revert is false. The name is
    // known for every input by now (1.5: the processor number of a container or processor contract#ID is found above).
    // §6.3：isLive(链上名字, 推导出的容器) 或 isContainerLive(推导出的容器)；回滚即为假。此时每种输入都已有名字（1.5：容器与处理器合约#ID
    // 的处理器号已在上面找到）。
    const liveP = early(() => viewTap(binding, 'isLive', [out.name, out.container], at))
    const containerLiveP = early(() => viewTap(binding, 'isContainerLive', [out.container], at))
    const a = { live: false, isLive: null, isContainerLive: false }
    // TAP-10 §6.3 says a revert counts as false for isContainerLive only. isLive is counted the same way here: no accepted
    // implementation reverts on isLive, so this branch can only meet an unknown implementation, which the implementation
    // check above has already refused (store-changed). / TAP-10 §6.3 只对 isContainerLive 规定回滚算假。这里 isLive 同样处理：
    // 接受列表里的实现对 isLive 不会回滚，这个分支只可能遇到未知实现，而未知实现已被上面的实现钉住拒绝（store-changed）。
    try { a.isLive = (await liveP) === true } catch (e) { if (!reverted(e)) throw e; a.isLive = false; a.isLiveReverted = true }
    try { a.isContainerLive = (await containerLiveP) === true } catch (e) { if (!reverted(e)) throw e; a.isContainerLive = false; a.isContainerLiveReverted = true }
    a.live = a.isLive === true || a.isContainerLive
    out.activation = a
    return stop(a.live ? 'ok' : 'unpaid')
  }

  // Input this client cannot decide without allChains because it may belong to another chain (TAP-10 §4.1)
  // 不开 allChains 时无法判定、可能属于别的链的输入
  const otherChain = (what, why) => tapErr('INVALID_ARGUMENT', 'unsupported', `unsupported: ${what} ${why} on chain ${chainId}; it may be one on another chain, and TAP-10 §4.1 forbids not-tapeout until every active chain was read: pass allChains: true to createTapeAPI (it then also reads Base and X Layer), { chainId, container } for one chain, or the on-chain name`, { chainId: Number(chainId), input: what })
  // A processor contract#ID string without allChains: TAP-10 §4.1 resolves it only when exactly one chain does, which one
  // chain's reads cannot tell. Refused before any request. / 不开 allChains 的"处理器合约#ID"字符串：TAP-10 只在恰好一条链命中时解析，
  // 只读一条链无从得知。发请求之前就拒绝。
  const pairNeedsAllChains = (input) => tapErr('INVALID_ARGUMENT', 'unsupported', `unsupported: ${input.circuits}#${input.tokenId} is a processor contract#ID, which TAP-10 §4.1 resolves only when exactly one active chain resolves it (the Base and X Layer factories share an address, so one processor contract can exist on both); this client reads other chains for such input only with allChains: true (it then also asks the nodes of Base and X Layer). Or pass the on-chain name, or { circuits, tokenId, chainId } for one chain`, { chainId: Number(chainId), input: `${input.circuits}#${input.tokenId}` })

  // The site status as an error, for resolve. `chains`: what every chain said, when the input was searched on every chain.
  // 把站点状态变成 resolve 的错误。chains：输入在所有链上搜索时，各链的结果。
  function siteError(v, given, chains = null) {
    const what = v.name ?? (v.circuits ? `${v.circuits}#${v.tokenId}` : given)
    const data = { chainId: v.chainId, name: v.name, processor: v.processor, tokenId: v.tokenId, circuits: v.circuits, container: v.container, holder: v.holder, opened: v.opened, activation: v.activation, implementations: v.implementations, pinned: v.pinned, ...(chains ? { chains } : {}) }
    switch (v.status) {
      case 'store-changed': {
        const x = v.implementations.find((i) => !i.accepted)
        return tapErr('CONTRACT_UNKNOWN', 'store-changed', `store-changed: ${x.role} ${x.proxy} runs implementation ${x.implementation}, which TAP-10 and this SDK do not accept (chains.js expectedImpl); refusing to read until the SDK is updated (TAP-10 §6.1)`, data)
      }
      case 'no-such-cpu': return tapErr('NOT_FOUND', 'no-such-cpu', `no-such-cpu: processor ${v.processor} does not exist on chain ${v.chainId}`, data)
      case 'no-such-token': return tapErr('NOT_FOUND', 'no-such-token', `no-such-token: ${what} has no circuit (ownerOf reverts)`, data)
      case 'not-tapeout': return tapErr('NOT_FOUND', 'not-tapeout', `not-tapeout: ${given} is not a TapeOut circuit container or processor on ${chains ? `any TapeOut chain (read: ${chains.map((c) => c.chainId).join(', ')})` : `chain ${v.chainId}`} (TAP-10 §4.3)`, data)
      case 'not-opened': return tapErr('SITE_STATUS', 'not-opened', `not-opened: the container ${v.container} of ${what} has not been opened (TAP-10 §6.2)`, data)
      case 'unpaid': return tapErr('SITE_STATUS', 'unpaid', `unpaid: ${what} is not activated: isLive and isContainerLive are both false; its holder activates it with DomainBinding.bind (TAP-10 §6.3)`, data)
      default: return tapErr('INTERNAL', v.status, `unexpected site status ${v.status}`, data)
    }
  }

  /**
   * @experimental (1.4) TAP-10 site status of a target, in any mode: identity (§4) and site status (§6.2) at one TAP-10 pinned
   * block (§5.3), with no manifest read. Resolves to { version, status, chainId, name, processor, tokenId, circuits, container,
   * holder, opened, activation, implementations, pinned }; `status` is 'ok', 'unpaid', 'not-opened', 'store-changed',
   * 'no-such-cpu', 'no-such-token' or 'not-tapeout' and is never thrown. Throws only for an input error, `ambiguous`,
   * `unsupported`, wrong-chain and reads that cannot be adopted (stale-block, unavailable). With allChains (1.5) a container
   * address or processor contract#ID string is looked up on every chain, and the result carries `chains`, what each chain
   * said. Activation is a site rule (TAP-10 §6.3): messaging is never gated by it (§12.2).
   * @experimental（1.4）目标的 TAP-10 站点状态，任何模式可用：在一个 TAP-10 钉块上做身份（§4）与站点状态（§6.2），不读清单。status
   * 绝不抛出；只有输入错误、ambiguous、unsupported、wrong-chain 与无法采用的读取才抛错。开启 allChains（1.5）时，容器地址或
   * "处理器合约#ID"字符串在每条链上查找，结果带 chains（各链的结果）。激活是站点规则（§6.3），绝不限制消息（§12.2）。
   */
  async function siteStatus(target) {
    try {
      const { input, where, chainless } = conformInput(target)
      if (where !== null && where !== Number(chainId)) return forChain(where).siteStatus(target)
      if (chainless && allChains) {
        const { winner, chains, candidates } = await everyChain(input, givenOf(target), (local) => local.site(input))
        return { ...winner.v, chains, ...(candidates ? { candidates } : {}) }
      }
      // Under conform: 'tap10' a processor contract#ID string needs every chain (TAP-10 §4.1). siteStatus on a default
      // client keeps 1.4's answer: resolved on this client's chain, `unsupported` when it is no processor here.
      // 一致模式下"处理器合约#ID"字符串需要所有链。默认客户端的 siteStatus 保持 1.4 的回答：在本链解析，在本链不是处理器即 unsupported。
      if (chainless && input.kind === 'pair' && conformMode) throw pairNeedsAllChains(input)
      return (await siteHere(input, { unsure: chainless })).v
    } catch (e) { throw withStatus(e) }
  }
  // This chain's site status at a fresh TAP-10 pinned block / 本链在新的 TAP-10 钉块上的站点状态
  async function siteHere(input, { unsure = false } = {}) {
    const [pinned] = await Promise.all([tap10Pin(), checkChain()])
    const v = await identifyAt(input, pinned, { unsure })
    delete v.proof
    return { v }
  }
  const givenOf = (target) => (typeof target === 'string' ? target.trim().slice(0, 80) : (target.container ?? `${target.circuits}#${target.tokenId}`))

  // TAP-10 §4.1 with allChains: input without chain information on every TapeOut chain, each through that chain's client at
  // its own pinned block (`run` gets the client's TAP10_LOCAL steps). What a chain says is one of:
  //   resolved   identity reached a circuit with a holder: ok, unpaid or not-opened;
  //   problem    the chain could not be read (unavailable, stale-block, wrong-chain, ...), or its site store or payment
  //              contract runs an implementation that is not accepted (store-changed): its identity is unknown;
  //   miss       not-tapeout or no-such-token.
  // Then: two or more resolved -> ambiguous (INVALID_ARGUMENT, data.candidates), whatever the rest say. One resolved -> that
  // chain, except a processor contract#ID while another chain is a problem -> that problem (§4.1 "report the other chain's
  // status rather than guess"); a container address can be a container of one chain only (its ERC-6551 address commits to
  // the chainId), so a container that resolves is that chain's whatever the others say. None resolved -> the first
  // problem, never not-tapeout; with no problem, no-such-token where a chain has the processor but not the #ID, else
  // not-tapeout. Chains go in a fixed order (this client's first, then CHAIN_IDS), and `chains` lists what each said.
  // TAP-10 §4.1（allChains）：无链信息的输入在每条 TapeOut 链上解析，各由该链的客户端在自己的钉块上进行。每条链的结果为：
  //   resolved（身份解析到有持有人的电路：ok、unpaid、not-opened）；problem（读不到：unavailable、stale-block、wrong-chain 等，或站点
  //   存储、付费合约的实现不被接受：store-changed；这条链上的身份未知）；miss（not-tapeout、no-such-token）。
  // 判定：两条及以上 resolved 即 ambiguous（无论其余如何）。一条 resolved 即用那条链；但"处理器合约#ID"在另有 problem 链时报那条链的
  // 状态（§4.1"报告另一条链的状态而不是猜"）；容器地址只可能是一条链的容器（ERC-6551 地址包含链号），命中即用，不论其余。都没有
  // resolved：报第一个 problem，绝不报 not-tapeout；没有 problem 时，某链有该处理器却没有该 #ID 即 no-such-token，否则 not-tapeout。
  // 链的顺序固定（本客户端的链在前，然后按 CHAIN_IDS），chains 列出每条链的结果。
  const RESOLVED = new Set(['ok', 'unpaid', 'not-opened'])
  async function everyChain(input, given, run) {
    const own = Number(chainId)
    const ids = [...(CHAIN_IDS.includes(own) ? [own] : []), ...CHAIN_IDS.filter((id) => id !== own)]
    // Every chain's client first, outside the per-chain verdicts: a configuration mistake (chains[id] with too few
    // operators, ...) is thrown as it is, never reported as a chain that "could not be decided".
    // 先取齐各链的客户端，不放进各链的结论里：配置错误（chains[id] 运营方不足等）原样抛出，绝不报成"无法判定"的链。
    const locals = ids.map((id) => [id, TAP10_LOCAL.get(id === own ? api : forChain(id))])
    const settled = await Promise.all(locals.map(async ([id, local]) => {
      try { return { id, ...(await run(local)) } } catch (e) {
        if (!(e instanceof TapeAPIError)) throw e
        return { id, error: withStatus(e) }
      }
    }))
    const statusOf = (r) => (r.error ? r.error.data.status : r.v.status)
    const chains = settled.map((r) => ({ chainId: r.id, status: statusOf(r) }))
    const resolved = settled.filter((r) => !r.error && RESOLVED.has(r.v.status))
    const problems = settled.filter((r) => r.error || r.v.status === 'store-changed')
    // `warnings`: what identity on that chain would have reported (held, e.g. CONTAINER_MISMATCH) / 该链身份阶段留住的警告
    const candidates = resolved.map((r) => ({ chainId: r.id, name: r.v.name, processor: r.v.processor, tokenId: r.v.tokenId, circuits: r.v.circuits, container: r.v.container, status: r.v.status, ...(r.held?.length ? { warnings: [...r.held] } : {}) }))
    const nameOf = (r) => `${chainById(r.id).name}${r.v?.name ? ` (${r.v.name})` : ''}`
    if (resolved.length > 1) {
      throw tapErr('INVALID_ARGUMENT', 'ambiguous', `ambiguous: ${given} resolves on ${resolved.map(nameOf).join(' and ')}; give the on-chain name, which carries its chain (TAP-10 §4.1)`, { input: given, candidates, chains })
    }
    if (resolved.length === 1 && (input.kind === 'container' || problems.length === 0)) return { winner: resolved[0], chains }
    if (problems.length) {
      const p = problems[0]
      const why = resolved.length
        ? `${given} resolves on ${nameOf(resolved[0])}, but TAP-10 §4.1 adopts a processor contract#ID only when no other chain resolves it, and ${chainById(p.id).name} could not be decided`
        : `${given} resolves on no chain that could be read, and TAP-10 §4.1 forbids not-tapeout while ${chainById(p.id).name} could not be decided`
      if (p.error) throw tapErr(p.error.code, statusOf(p), `${p.error.message} [${why}]`, { ...p.error.data, chainId: p.id, input: given, chains, ...(resolved.length ? { candidates } : {}) })
      return { winner: p, chains, candidates: resolved.length ? candidates : null }
    }
    return { winner: settled.find((r) => r.v.status === 'no-such-token') ?? settled[0], chains }
  }

  // TAP-11 §2.2 step 3 under TAP-10 §7.1: the exact key, chunkCount 0 is no-manifest, at most 65,536 bytes, length and
  // SHA-256 (incomplete), an all-zero hash (no-hash); then strict UTF-8 without a byte order mark (TAP-11 §3.1).
  // TAP-11 §2.2 第 3 步：只读这个键；chunkCount 为 0 即 no-manifest；至多 65,536 字节；长度与 SHA-256（incomplete）；全零哈希（no-hash）；
  // 再按 TAP-11 §3.1 严格解码 UTF-8，拒绝字节序标记。
  async function conformManifest(container, at, { proofs = null, beforeRead = null } = {}) {
    const slots = proofs ? STORAGE.fileInfo(container, MANIFEST_KEY) : null
    const proofP = proofs ? proofs.request(siteRegistry, [IMPL, slots.size, slots.sha256Hash]) : null
    const info = await viewTap(siteRegistry, 'fileInfo', [container, MANIFEST_KEY], at)
    const size = Number(info.size)
    if (BigInt(info.chunkCount) === 0n) throw tapErr('MANIFEST_INVALID', 'no-manifest', `no-manifest: no file at ${MANIFEST_PATH} for ${container} (fileInfo.chunkCount = 0)`)
    if (size > MANIFEST_LIMIT) throw tapErr('MANIFEST_INVALID', 'manifest-invalid', `${MANIFEST_PATH} declares ${size} bytes, limit is ${MANIFEST_LIMIT}`)
    if (typeof info.sha256Hash !== 'string' || info.sha256Hash.toLowerCase() === ZERO_HASH) throw tapErr('MANIFEST_INVALID', 'no-hash', `no-hash: ${MANIFEST_PATH} has no on-chain SHA-256 (fileInfo.sha256Hash is zero)`)
    const bytesP = early(() => viewTap(siteRegistry, 'read', [container, MANIFEST_KEY], at))
    if (beforeRead) beforeRead()
    let raw
    try { raw = hexToBytes(await bytesP) } catch (e) { if (isRevert(e)) throw tapErr('MANIFEST_INVALID', 'incomplete', `incomplete: read(${MANIFEST_KEY}) reverted for ${container}: ${e.message}`); throw e }
    if (raw.length !== size) throw tapErr('MANIFEST_INVALID', 'incomplete', `incomplete: ${MANIFEST_PATH}: read ${raw.length} bytes, fileInfo.size declares ${size}`)
    const digest = toHex(sha256(raw))
    if (digest !== info.sha256Hash.toLowerCase()) throw tapErr('MANIFEST_INVALID', 'incomplete', `incomplete: ${MANIFEST_PATH}: sha256 of bytes is ${digest}, fileInfo.sha256Hash declares ${info.sha256Hash}`)
    if (proofP) {
      await proofs.settle('fileInfo', siteRegistry, proofP, { impl: LAYOUT_IMPLEMENTATIONS.siteRegistry, detail: { container: checksumAddress(container), path: MANIFEST_KEY }, check: (v) => {
        const provenSize = v.get(slots.size) & 0xffffffffn, provenHash = '0x' + v.get(slots.sha256Hash).toString(16).padStart(64, '0')
        if (provenSize !== BigInt(size)) return `fileInfo.size is ${size}, the proven size is ${provenSize}`
        return provenHash === digest ? null : `the bytes hash to ${digest}, the proven sha256Hash is ${provenHash}`
      } })
    }
    if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) throw tapErr('MANIFEST_INVALID', 'manifest-invalid', `${MANIFEST_PATH} begins with a byte order mark (TAP-11 §3.1)`)
    let text
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw) } catch { throw tapErr('MANIFEST_INVALID', 'manifest-invalid', `${MANIFEST_PATH} is not valid UTF-8 (TAP-11 §3.1)`) }
    return { manifest: safeParseJSON(text, { code: 'MANIFEST_INVALID' }), file: { size, sha256Hash: digest, updatedAt: info.updatedAt } }
  }

  async function resolveConform(target) {
    try { return await resolveConformNow(target) } catch (e) { throw withStatus(e) }
  }
  async function resolveConformNow(target) {
    const { input, where, chainless } = conformInput(target)
    if (where !== null && where !== Number(chainId)) return forChain(where).resolve(target)
    const given = givenOf(target)
    if (chainless && allChains) {
      // TAP-10 §4.1: identity on every chain; the manifest steps run on the one chain chosen, at that chain's pinned block
      // (the winner's continuation), never as a second resolution / 身份在所有链上解析；清单步骤只在选中的那条链上、在它的钉块上继续
      const { winner, chains, candidates } = await everyChain(input, given, (local) => local.prepare(input))
      if (winner.v.status !== 'ok') {
        const e = siteError(winner.v, given, chains)
        if (candidates) e.data.candidates = candidates
        throw e
      }
      return winner.finish(target, chains)
    }
    if (chainless && input.kind === 'pair') throw pairNeedsAllChains(input)
    const p = await prepareConform(input, { unsure: chainless })
    if (p.v.status !== 'ok') throw siteError(p.v, given)
    return p.finish(target)
  }
  // TAP-11 §2.2 steps 1-2 at this chain's pinned block; `finish(target)` makes steps 3-8 at the same block. `hold` keeps
  // the warnings of identity until finish (a chain of the every-chain search that is not chosen reports none).
  // TAP-11 §2.2 第 1、2 步在本链钉块上；finish(target) 在同一块上做第 3–8 步。hold：身份阶段的警告留到 finish 才报告（所有链搜索中
  // 没被选中的链不报告任何警告）。
  async function prepareConform(input, { unsure = false, hold = false } = {}) {
    const warnings = []
    const held = []
    const report = (w) => { try { onWarning(w) } catch { /* a reporter never breaks resolve / 报告函数绝不影响解析 */ } }
    const issue = (code, message, extra = {}) => { const w = { code, message, ...extra }; warnings.push(w); if (hold) held.push(w); else report(w) }
    // §5.4 under strict agreement, as the messaging path checks it (shared, once per client): a node down or on another
    // chain stops the resolution before any state is read / 严格共识的 §5.4，与消息路径共用、每个客户端一次：节点宕机或在别的链上，
    // 解析在读任何状态之前就停下
    const [pinned] = await Promise.all([pinnedBlock(), checkChainStrict()])
    const proofs = proofMode ? proofSession(pinned) : null
    // TAP-11 §2.2 steps 1-2 / 第 1、2 步
    const v = await identifyAt(input, pinned, { proofs, issue, unsure, strictHolder: true })
    const finish = (target, chains = null) => {
      hold = false
      for (const w of held.splice(0)) report(w)
      return finishConform({ v, pinned, proofs, issue, warnings, target, chains })
    }
    return { v, finish, held }
  }
  async function finishConform({ v, pinned, proofs, issue, warnings, target, chains }) {
    const at = tapAt(pinned)
    // Steps 3-4: the manifest; the hub's implementation (TapeAPI's sentinel) goes out with read() / 第 3、4 步；hub 实现槽与 read() 同轮发出
    let hubP = null
    const sentinelOn = sentinelProxies.length > 0
    const src = await conformManifest(v.container, at, { proofs, beforeRead: () => { if (sentinelOn) hubP = early(() => Promise.all(sentinelProxies.map(async (t) => {
      const word = String(await needRpc().call('eth_getStorageAt', [t.proxy, IMPL_SLOT, at], TAP10_READ))
      if (!/^0x[0-9a-fA-F]{64}$/.test(word)) throw new TapeAPIError('RPC_ERROR', `eth_getStorageAt(${t.proxy}) answered ${word.slice(0, 80)}`)
      return { role: t.role, proxy: t.proxy, implementation: '0x' + word.slice(-40).toLowerCase(), expected: t.allowed.includes('0x' + word.slice(-40).toLowerCase()) }
    }))) } })
    let manifest
    try { manifest = validateManifest(src.manifest, { requireDelegation: true, allowHttp, now: now() }) } catch (e) { if (e instanceof TapeAPIError) throw tapErr(e.code, STATUS_OF_CODE[e.code] ?? 'manifest-invalid', e.message, e.data ?? {}); throw e }
    let aiProblems
    if (manifest[AI_FIELD] !== undefined) {
      manifest = { ...manifest }
      try { manifest[AI_FIELD] = validateAIField(manifest[AI_FIELD], { allowHttp }) } catch (e) { aiProblems = [e.message]; delete manifest[AI_FIELD] }
    }
    // Step 5: the manifest's identity values are compared, never used / 第 5 步：清单的身份值只用于比对，绝不采用
    if (!eqAddr(manifest.circuits, v.circuits) || BigInt(manifest.tokenId) !== BigInt(v.tokenId) || !eqAddr(manifest.container, v.container)) {
      throw tapErr('MANIFEST_INVALID', 'manifest-invalid', `the manifest states ${manifest.circuits} #${manifest.tokenId}, container ${manifest.container}; resolved ${v.circuits} #${v.tokenId}, container ${v.container} (TAP-11 §2.2 step 5)`)
    }
    const contributionP = early(() => readContribution(manifest, at))
    if (proofs) await settleFactory(proofs, v.proof.factory)
    // Step 6: the delegation against the holder read in step 1 (strict, the only ownerOf of the resolution: none is read
    // again here); a contract holder's eth_getCode and isValidSignature strict as well (TAP-11 §2.2, §4.4)
    // 第 6 步：委托对照第 1 步读到的持有人（严格共识，本次解析唯一的 ownerOf，这里不再读）；合约持有人的 eth_getCode 与
    // isValidSignature 同样严格读取
    const verified = await verifyDelegation(manifest, { dev: false, holder: Promise.resolve(v.holder), at, read: TAP10_STRICT })
    if (proofs) {
      const slot = STORAGE.ownerOf(manifest.tokenId)
      await proofs.settle('ownerOf', manifest.circuits, v.proof.owner, { detail: { tokenId: String(manifest.tokenId) }, check: (w) => {
        const x = w.get(slot)
        return eqAddr(addressOfWord(x), verified.holder) ? null : `ownerOf(${manifest.tokenId}) is ${verified.holder}, the proven slot holds 0x${x.toString(16)}`
      } })
    }
    const contribution = await contributionP
    // Step 7: the content signature as in the default mode, a contract holder's EIP-1271 reads strict (TAP-11 §5)
    // 第 7 步：内容签名与默认模式相同，合约持有人的 EIP-1271 读取用严格共识
    let contentSig = null
    if (requireContentSig || src.manifest?.[MANIFEST_CONTENT_FIELD] !== undefined) {
      let why
      try { why = await contentSigProblem(src.manifest, manifest.container, verified.holder, at, TAP10_STRICT) } catch (e) {
        if (requireContentSig) throw e
        why = undefined
        contentSig = { valid: false, checked: false }
        issue('CONTENT_SIG_UNCHECKED', `contentSig could not be checked: ${e?.message ?? e}`, e instanceof TapeAPIError ? { cause: e.code } : {})
      }
      if (why !== undefined) {
        if (why && requireContentSig) throw new TapeAPIError('MANIFEST_INVALID', `requireContentSig: ${why}`)
        contentSig = { valid: !why }
        if (why) issue('CONTENT_SIG_INVALID', why)
      }
    }
    // TapeAPI's own sentinel on the hub (TAP-10 does not read the hub to resolve) / TapeAPI 自己对 hub 的哨兵
    let sentinel = null
    if (sentinelOn || localDerivation) sentinel = { mode: sentinelMode, implementations: null, container: v.derivation ?? 'unchecked' }
    if (sentinelOn) {
      try {
        sentinel.implementations = await (hubP ?? Promise.reject(new TapeAPIError('RPC_ERROR', 'the hub slot was not read')))
        for (const x of sentinel.implementations.filter((i) => !i.expected)) {
          const msg = `${x.role} ${x.proxy} now runs implementation ${x.implementation}, which this SDK does not know (chains.js expectedImpl): TapeOut upgraded it`
          if (sentinelMode === 'strict') throw tapErr('CONTRACT_UNKNOWN', 'hub-changed', msg, { role: x.role, proxy: x.proxy, implementation: x.implementation })
          issue('IMPL_UNKNOWN', msg, { role: x.role, proxy: x.proxy, implementation: x.implementation })
        }
      } catch (e) {
        if (sentinelMode === 'strict' || (e instanceof TapeAPIError && e.code === 'CONTRACT_UNKNOWN')) throw e
        issue('IMPL_UNREAD', `could not read the implementation slot of the hub: ${e.message}`)
      }
    }
    if (delegationFloor && verified.holder) {
      const who = { chainId, container: checksumAddress(manifest.container), holder: checksumAddress(verified.holder), signer: checksumAddress(manifest.signer) }
      const key = delegationFloorKey(who)
      const seen = Number((await delegationFloor.get(key)) ?? 0)
      if (manifest.delegation.expires < seen) throw tapErr('DELEGATION_INVALID', 'delegation-invalid', `delegation.expires ${manifest.delegation.expires} is below ${seen}, already seen for ${manifest.container} under holder ${verified.holder} and signer ${who.signer}: an older manifest was put back (api.clearDelegationFloor(error.data) accepts it again)`, { expires: manifest.delegation.expires, floor: seen, ...who })
      if (manifest.delegation.expires > seen) await delegationFloor.set(key, manifest.delegation.expires)
    }
    // Step 8 / 第 8 步
    const { proof: _proof, status: _status, ...site } = v
    const svc = { manifest, container: checksumAddress(manifest.container), chainId, verified, contribution, file: src.file, target, fetchedAt: now() }
    if (aiProblems) svc.aiProblems = aiProblems
    svc.pinned = { number: pinned.number, hash: pinned.hash, timestamp: pinned.timestamp, tag: 'tap10', by: 'hash', mode: 'tap10', lag: pinned.lag, maxLag: pinned.maxLag }
    svc.conform = { ...site, status: 'resolved', site: 'ok', ...(chains ? { chains } : {}) }
    if (sentinel) svc.sentinel = sentinel
    if (contentSig) svc.contentSig = contentSig
    if (proofs) {
      for (const x of proofs.unavailable) issue('PROOF_UNAVAILABLE', `${x.read} ${x.address} not proven: ${x.reason}`, { read: x.read })
      for (const x of proofs.invalid) issue('PROOF_INVALID', `${x.read} ${x.address}: ${x.reason}`, { read: x.read })
      svc.proofs = { mode: proofs.mode, block: proofs.block, stateRoot: proofs.stateRoot, verified: proofs.verified, unavailable: proofs.unavailable, invalid: proofs.invalid }
    }
    if (warnings.length) svc.warnings = warnings
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
    if (svc?.target === undefined) throw new TapeAPIError('INVALID_ARGUMENT', 'svc has no target to refresh from; it did not come from api.resolve()')
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
    for (const k of ['pinned', 'sentinel', 'contentSig', 'proofs', 'warnings', 'conform']) { if (fresh[k] !== undefined) svc[k] = fresh[k]; else delete svc[k] }
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
    throw new TapeAPIError('PRICE_CHANGED', `${method} now costs ${formatUnits(price, BEM_DECIMALS)} BEM, up from the ${formatUnits(was, BEM_DECIMALS)} BEM you accepted; pass { maxPrice } or call api.acceptPrice()`, { data: { method, accepted: was.toString(), price: price.toString() } })
  }

  // A price is priceBEM: on an escrow of another token the same number is another amount, so a priced call needs the
  // escrow's token() to be BEM (dev services are not checked). / 收费调用要求托管代币是 BEM。
  async function requireBemEscrow(svc) {
    if (svc.verified?.dev === true) return
    const info = await paymentTokenOf(escrowAddressOf(svc))
    if (!eqAddr(info.token, MAINNET.bem)) {
      throw new TapeAPIError('UNSUPPORTED_PAYMENT_TOKEN', `${svc.container} prices its methods in BEM (priceBEM), but its escrow ${info.escrow} holds ${info.display}: a voucher for the price would be an amount of another token. The escrow contract takes any admitted token; manifest prices in other tokens are not yet specified (TAPI-22 §3.5)`, { data: { reason: 'not-bem', escrow: info.escrow, token: info.token } })
    }
  }

  // ---- call ----
  // 一次调用 = 一次尝试；BAD_VOUCHER 且错误负载带 lastCumulative 时 payer 重新同步后再试一次（H-05）。
  // One call = one attempt; on BAD_VOUCHER carrying lastCumulative the payer resyncs and retries once (review H-05).
  async function call(svc, method, params = {}, options = {}) {
    const owner = ownerOf(svc)
    if (owner) return owner.call(svc, method, params, options)
    const { payer, id, signal, timeoutMs = 30000, manifestTtlMs = conformMode ? CONFORM_TTL_MS : MANIFEST_TTL_MS, maxPrice } = options ?? {}
    let m = svc?.manifest; if (!m) throw new TapeAPIError('INVALID_ARGUMENT', 'svc.manifest missing')
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
    // refuse them here instead of paying for a call whose answer cannot be checked (TAPI-21 §3.3).
    // 信封绑定 canonicalJSON({method, params})；没有规范形式的参数永远无法验证，在此拒绝，而不是为无法核对的回答付费。
    try { canonicalJSON({ method, params }) } catch (e) { throw new TapeAPIError('BAD_REQUEST', `params have no canonical form: ${e.message}`) }
    // TAPI-20 §3.6: re-read a manifest older than the TTL before spending against it. Best effort -- a transient
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
        // Conformance mode: a reread that came back with a verdict (unpaid, store-changed, delegation-invalid, ...) ends the
        // service; only "could not read" (unavailable, stale-block) keeps serving from cache.
        // 一致模式：重读得到明确结论（unpaid、store-changed、delegation-invalid……）即停止该服务；只有"读不到"才继续用缓存。
        if (conformMode && e instanceof TapeAPIError && e.data?.status && !TRANSIENT_STATUS.has(e.data.status)) throw e
        REFRESH_FAILED.set(svc, now())      // keep serving from cache / 继续用缓存
      }
    }
    // TAPI-20 §3.3 allows an async-only service (no live endpoints). This client speaks TAPI-21 over HTTP only, so
    // say that plainly instead of failing somewhere inside the request loop. / 本客户端只走 HTTP，明说而不是在请求循环里出错。
    if (!m.endpoints.live.length) throw new TapeAPIError('PROVIDER_UNAVAILABLE', `${svc.container} publishes no live endpoint (async: true only); this client cannot reach it`)
    let price = gatePrice(svc, method, methodPrice(def), maxPrice)
    // Payments run on BNB Smart Chain only (the 2026 Q4 plan, 2026-09-28): no escrow, no BEM on the L2s.
    // 支付只在 BNB Smart Chain：L2 上没有托管合约，也没有 BEM。
    if (price > 0n && known && known.payments === false) throw new TapeAPIError('PAYMENT_REQUIRED', `${method} costs ${def.priceBEM} BEM, but ${svc.container} is on ${known.name}: TapeAPI payments run on BNB Smart Chain only`, { data: { method, chainId } })
    if (price > 0n && !payer) throw new TapeAPIError('PAYMENT_REQUIRED', `${method} costs ${def.priceBEM} BEM; pass { payer }`)
    if (price > 0n) await requireBemEscrow(svc)
    // 提供者只接受 1..128 字符的 id；本地先挡住，否则拿回来的是一个 id='' 的错误信封，永远验不过签。
    // Providers only accept ids of 1..128 chars: reject locally, or the answer is an id='' error envelope that can
    // never match the request and surfaces as BAD_SIGNATURE instead of the caller's own mistake.
    // A lone UTF-16 surrogate has no canonical form (canon.js), so no envelope could bind it (FIXED ID-LS).
    // 孤立代理项没有规范形式，任何信封都无法绑定它。
    if (id != null && (typeof id !== 'string' || !id || id.length > 128)) throw new TapeAPIError('BAD_REQUEST', 'id must be a string of 1..128 characters')
    if (id != null) { try { canonicalJSON(id) } catch { throw new TapeAPIError('BAD_REQUEST', 'id must be well-formed Unicode (no lone UTF-16 surrogate)') } }
    // One id for the whole call, retry included: it is the idempotency key the provider may dedup on, and it
    // is covered by the TAPI-21 v2 digest, so a retry must not change it.
    // 整次调用（含重试）共用一个 id：它是提供者可用于去重的幂等键，且被 TAPI-21 v2 摘要覆盖，重试不得更换。
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
    if (price > 0n) await requireBemEscrow(svc)
    const second = await attempt(svc, def, method, params, price, { payer, reqId, signal, timeoutMs, retried: true })
    return second.value
  }

  // TAPI-21 §3.4 / TAPI-20 §3.6: an envelope signed by someone other than manifest.signer may mean the holder rotated
  // the key. Re-read the manifest (from step 2); if the chain now names exactly the key that signed, this envelope
  // is valid and is kept -- no second request, so a result the provider already billed is not paid for twice.
  // Throttled like price hints, so a hostile endpoint cannot turn every call into a chain read.
  // 信封签名者不是 manifest.signer，可能是持有人换了密钥。重读清单（从第 2 步起）；若链上现在指定的正是签名的那把钥匙，
  // 这个信封就有效并被采用——不再发第二次请求，提供者已计费的结果不会被付两次。与价格提示同样限频。
  async function signerRotated(svc, signer, retried) {
    if (retried) return false
    return (await rereadAfterBadSignature(svc)) && eqAddr(signer, svc.manifest.signer)
  }
  // TAPI-20 §3.6 / TAPI-21 §3.4: EVERY envelope-binding failure triggers a re-read from step 2, not only a foreign key
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
    let timedOut = false
    const ac = new AbortController(); const t = setTimeout(() => { timedOut = true; ac.abort() }, timeoutMs)
    const onAbort = () => ac.abort()
    if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', onAbort, { once: true }) }
    let res, env
    // A manifest may publish up to 4 endpoints (TAPI-20 §3.3). Try them in order on a TRANSPORT failure only:
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
        // HTTP 429 IS the answer, whatever its body (TAPI-21 §3.4): a CDN's HTML 429 must not send the same voucher on
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
      // The caller's own abort or timeout is told apart from an unreachable provider (review G1 S5). / 区分调用方的中止或超时。
      const why = ac.signal.aborted ? (timedOut ? { timedOut: true } : { aborted: true }) : undefined
      throw new TapeAPIError('PROVIDER_UNAVAILABLE', `provider request failed on all ${urls.length} endpoint(s): ${why?.timedOut ? `no answer within ${timeoutMs} ms` : why?.aborted ? 'aborted by the caller' : lastErr.message}`, why ? { data: why } : undefined)
    }
    // 信封校验：用自己发出的 method/params 与解析出的 container 重算摘要（TAPI-21 v2）/ recompute with our own request
    // BAD_SIGNATURE re-reads the manifest first (SD-2); awaited at every call site, so it still ends the attempt.
    // BAD_SIGNATURE 先重读清单；每个调用点都 await 它，因此仍然终止本次尝试。
    const reject = async (msg, extra) => { lease?.release(); await rereadAfterBadSignature(svc); throw new TapeAPIError('BAD_SIGNATURE', msg, extra) }
    // TAPI-21 §3.2: only JSON carrying a `sig` is an envelope. Anything else -- a CDN or proxy error page, the
    // provider's own unsigned 404 -- is a transport failure, not a bad signature, and must not trigger a re-resolve.
    // 只有带 `sig` 的 JSON 才是信封。其它（CDN/代理错误页、提供者自己未签名的 404）是传输失败，不是坏签名。
    if (!env || typeof env !== 'object' || Array.isArray(env) || typeof env.sig !== 'string') {
      lease?.release()
      // A provider whose delegation lapsed answers an unsigned DELEGATION_INVALID (TAPI-21). Unsigned, so only a hint:
      // report it as such only when our own copy of the manifest agrees it has expired (arch A3).
      // 委托过期的提供者回未签名的 DELEGATION_INVALID。未签名只能当提示：只有本地清单也确认已过期时才这样报告。
      const own = m?.delegation?.expires
      if (env?.error?.code === 'DELEGATION_INVALID' && Number.isInteger(own) && own <= now()) {
        throw new TapeAPIError('DELEGATION_INVALID', `${svc.container}: its delegation expired at ${own}; the holder must re-sign it`, { httpStatus: res.status, data: { delegationExpires: own } })
      }
      const claim = typeof env?.error?.code === 'string' ? ` (unsigned claim: ${env.error.code.slice(0, 64)})` : ''
      throw new TapeAPIError('PROVIDER_UNAVAILABLE', `provider answered HTTP ${res.status} without a signed envelope${claim}`, { httpStatus: res.status })
    }
    // TAPI-21 §3.2: a request the provider could not parse is refused with a BAD_REQUEST signed over id "" and
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
    // params the provider found non-canonical are refused bound to params {} (TAPI-21 §3.3) / 非规范参数的拒绝绑定 params {}
    if (!eqAddr(signer, m.signer) && malformed(reqId)) refuseMalformed()
    if (!eqAddr(signer, m.signer) && !(await signerRotated(svc, signer, retried))) await reject(`envelope signed by ${signer}, expected ${m.signer}`)
    if (!env.ok) {
      const code = typeof env.error?.code === 'string' ? env.error.code : 'INTERNAL'
      const data = env.error?.data && typeof env.error.data === 'object' ? env.error.data : undefined
      // A priced method called without a voucher: the method was free in our copy of the manifest and is priced
      // now (TAPI-20 §3.6). Re-read the manifest; the consent gate decides whether we may pay (runtime D5).
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
        // TAPI-22 §3.2 says an insufficient voucher is BAD_VOUCHER and PAYMENT_REQUIRED only means "no voucher"; a provider
        // that answers PAYMENT_REQUIRED to a voucher anyway still carries data.price, so heal it the same way.
        // TAPI-22 §3.2 规定额度不足是 BAD_VOUCHER，PAYMENT_REQUIRED 只表示"没带凭证"；对带了凭证的请求仍回 PAYMENT_REQUIRED 的提供者
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

  // ---- quorum：多提供者一致 / multi-provider agreement (TAPI-23 §1 client rule) ----
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
      throw new TapeAPIError('INVALID_ARGUMENT', 'compare.relTolBps must be an integer in 0..10000')
    }
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new TapeAPIError('INVALID_ARGUMENT', 'compare.paths must be a non-empty array of dotted paths')
    }
    for (const p of paths) {
      if (typeof p !== 'string' || !p || p.split('.').some((k) => !k)) {
        throw new TapeAPIError('INVALID_ARGUMENT', `compare.paths: ${JSON.stringify(p)} is not a dotted path`)
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

  // onDissent：默认 'reject'，与 TAPI-23 §3.4 一致——任意两个已验证信封不一致即拒绝。
  // 'quorum' 是明确的降级：允许唯一达到法定人数的一组获胜。它把失败模式从"拒绝"换成"可被 quorum 个
  // 合谋提供者伪造"，只有当调用方自己挑选并信任这批提供者时才可用。
  // onDissent defaults to 'reject', matching TAPI-23 §3.4: any two disagreeing verified envelopes reject.
  // 'quorum' is an explicit weakening: the single bucket reaching quorum wins. It trades "deny" for
  // "forgeable by quorum colluding providers", and is only safe when the caller picked the set itself.
  async function callQuorum(services, method, params = {}, { quorum = 2, payer, compare, onDissent = 'reject', allowSingleProvider = false, ...callOpts } = {}) {
    const fail = (msg, extra) => { throw new TapeAPIError('QUORUM_FAILED', `${method}: ${msg}`, extra) }
    const invalid = (msg) => { throw new TapeAPIError('INVALID_ARGUMENT', `${method}: ${msg}`) }   // the caller's own options / 调用方自己的选项
    if (!Array.isArray(services) || services.length === 0) invalid('services must be a non-empty array of resolved services')
    if (!Number.isInteger(quorum) || quorum < 1) invalid('quorum must be a positive integer')
    // TAPI-23 §3.4(1): N ≥ 2. One provider is one opinion; the opt-out exists for tests and must be spelled out.
    // TAPI-23 §3.4(1)：N ≥ 2。一个提供者只是一个意见；退出开关仅供测试，且必须显式写出。
    if (quorum < 2 && allowSingleProvider !== true) fail('quorum must be at least 2 (TAPI-23 §3.4); pass allowSingleProvider: true to accept one provider')
    // TAPI-23 §3.5: two services that share a container, a holder or an origin are one source, not two.
    // TAPI-23 §3.5：共用容器、持有人或来源（scheme+host+port）的两个服务只算一个来源。
    const seen = new Set(); const holders = new Map(); const origins = new Map()
    for (const s of services) {
      const c = s?.container && isAddress(s.container) ? s.container.toLowerCase() : null
      if (!c) invalid('each service needs a container (pass results of api.resolve)')
      if (seen.has(c)) fail(`duplicate provider ${s.container}; quorum requires independent providers`)
      seen.add(c)
      const h = typeof s.verified?.holder === 'string' ? s.verified.holder.toLowerCase() : null
      if (h && holders.has(h)) fail(`${holders.get(h)} and ${s.container} share holder ${s.verified.holder}; TAPI-23 §3.5 counts them as one source`)
      if (h) holders.set(h, s.container)
      for (const u of s.manifest?.endpoints?.live || []) {
        let o; try { o = new URL(u).origin } catch { continue }
        if (origins.has(o) && origins.get(o) !== s.container) fail(`${origins.get(o)} and ${s.container} share origin ${o}; TAPI-23 §3.5 counts them as one source`)
        origins.set(o, s.container)
      }
    }
    if (services.length < quorum) fail(`quorum ${quorum} needs at least ${quorum} providers, got ${services.length}`)
    // 调用方自己的参数先校验，再花钱 / the caller's own options are validated before any paid request goes out
    if (onDissent !== 'reject' && onDissent !== 'quorum') invalid("onDissent must be 'reject' or 'quorum'")
    if (compare) validateCompare(compare)
    // Attested Read (TAPI-23): a method whose descriptor carries `attestedRead` on any selected service.
    // 见证读取（TAPI-23）：任一所选服务的方法描述符带有 `attestedRead`。
    const descriptors = services.map((s) => (s.manifest?.methods || []).find((m) => m.name === method))
    const attested = descriptors.some((d) => d?.attestedRead)
    const disagreeCode = attested ? 'ATTEST_DISAGREE' : 'QUORUM_FAILED'
    // Security 1.1: a disagreement carries every verified envelope (each with its group) and the request in
    // error.data.envelopes / error.data.request, so that anyone can check who signed what (security.contradictionsOf
    // turns them into ContradictionRecords). / 分歧时 error.data 带上全部已验证信封（各带组号）与请求，任何人都能核对谁签了什么。
    const envelopesOf = () => [...buckets.values()].flatMap((b, group) => (b.envs ?? []).map((e) => ({ ...e, group })))
    const disagree = (msg, extra) => { throw new TapeAPIError(disagreeCode, `${method}: ${msg}`, { ...extra, data: { request: { method, params }, envelopes: envelopesOf() } }) }
    if (attested) {
      if (compare) fail('a tolerance MUST NOT be applied to an attested read (TAPI-23 §8)')
      const b = params?.block
      if (!((Number.isInteger(b) && b >= 0) || (typeof b === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(b)))) {
        fail('an attested read needs an explicit numeric params.block for the quorum round (TAPI-23 §3.4(2)); ask one provider first and reuse its blockNumber')
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
        // A SIGNED revert (TAPI-23 §3.3: error.data.revert) is a statement about chain state, so it is compared like an
        // answer: a revert beside a result is disagreement (strict mode rejects), and a revert group can never be the
        // accepted result. Other signed errors are refusals (no such block, bad request) and stay neutral (review SD-10).
        // 签名的回滚是对链上状态的陈述，与回答一样参与比较：回滚与结果并存即不一致（严格模式拒绝），回滚组永远不能成为被接受的结果。
        // 其他签名错误是拒答（没有该区块、请求有误），保持中立。
        const rev = e?.signed === true && typeof e?.data?.revert === 'string' && /^0x[0-9a-fA-F]*$/.test(e.data.revert) ? e.data.revert.toLowerCase() : null
        if (rev !== null) {
          const k = '\u0001revert:' + rev
          const b = buckets.get(k) || { result: { reverted: true, revert: rev }, containers: [], responses: [], revert: true, envs: [] }
          b.containers.push(container); buckets.set(k, b)
          b.envs.push({ container, signer: services[i].manifest?.signer ?? null, id: e.id, ts: e.ts, ok: false, error: e.error, sig: e.sig })
        }
        return
      }
      let key, tol
      const env = { container, signer: services[i].manifest?.signer ?? null, id: r.value.id, ts: r.value.ts, ok: true, result: r.value.result, sig: r.value.sig }
      try {
        // TAPI-23 §3.4(4): attested envelopes agree on chainId, blockNumber, blockHash and result; stateRoot is
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
            b.containers.push(container); b.responses.push(r.value); b.tols.push(tol); b.envs.push(env); joined = true; break
          }
        }
        if (joined) return
        // 字节相同的结果总能加入既有桶（同 nums、同 skeleton），这里只是防御性地避免覆盖 / defensive: never clobber a bucket
        let k = key; while (buckets.has(k)) k += '\u0000'
        buckets.set(k, { result: r.value.result, tol, tols: [tol], containers: [container], responses: [r.value], envs: [env] })
        return
      }
      const b = buckets.get(key) || { result: r.value.result, containers: [], responses: [], envs: [] }
      b.containers.push(container); b.responses.push(r.value); b.envs.push(env); buckets.set(key, b)
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
      disagree(`${buckets.size} distinct verified answers; TAPI-23 rejects on any disagreement (pass onDissent:'quorum' to accept a dominant group instead)`,
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
    if (!isAddress(consumer)) throw new TapeAPIError('INVALID_ARGUMENT', 'payer.consumer must be address')
    if (!sessionKey && typeof signTypedData !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', 'payer needs sessionKey or signTypedData')
    if (store && (typeof store.get !== 'function' || typeof store.set !== 'function')) throw new TapeAPIError('INVALID_ARGUMENT', 'payer.store needs get(key) and set(key, value)')
    const signerAddr = sessionKey ? privateKeyToAddress(sessionKey) : checksumAddress(consumer)
    const consumerAddr = checksumAddress(consumer)
    const sessionEnd = sessionKey && sessionExpiry != null ? Number(sessionExpiry) : null
    if (sessionEnd !== null && !Number.isSafeInteger(sessionEnd)) throw new TapeAPIError('INVALID_ARGUMENT', 'payer.sessionExpiry must be unix seconds')
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
      if (required) throw new TapeAPIError('INVALID_ARGUMENT', 'escrow address unknown')
      return null
    }
    const key = (svc) => {
      if (!svc?.container || !isAddress(svc.container)) throw new TapeAPIError('INVALID_ARGUMENT', 'svc.container missing')
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
        if (amount <= 0n) throw new TapeAPIError('INVALID_ARGUMENT', 'price must be positive')
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

  // ---- escrow tokens (TAPI-22 §3.5, experimental) / 托管代币 ----
  // An escrow from an address or a resolved service (its own payment.escrow); undefined: the configured one.
  function escrowAddressOf(esc) {
    if (esc && typeof esc === 'object' && esc.manifest) {
      const to = esc.manifest.payment?.escrow
      if (!isAddress(to) || /^0x0{40}$/i.test(to)) throw new TapeAPIError('INVALID_ARGUMENT', `${esc.container} names no escrow: it takes no payment`)
      return to
    }
    if (esc === undefined || esc === null) return needEscrow()
    if (!isAddress(esc)) throw new TapeAPIError('INVALID_ARGUMENT', 'escrow must be an address or a resolved service')
    return esc
  }
  // token() then decimals(), strict agreement, answers (never errors) cached per escrow: the token is immutable and an
  // admitted token's decimals fixed. No token(), no valid decimals(), or decimals outside 8..18: UNSUPPORTED_PAYMENT_TOKEN,
  // never a guess of 8; node failures stay as they are. / 绝不猜 8 位；只缓存回答。
  const paymentTokens = new Map()
  function paymentTokenOf(esc) {
    const k = esc.toLowerCase()
    let p = paymentTokens.get(k)
    if (!p) {
      p = readPaymentToken(esc)
      paymentTokens.set(k, p)
      p.catch(() => { if (paymentTokens.get(k) === p) paymentTokens.delete(k) })
    }
    return p
  }
  async function readPaymentToken(esc) {
    const at = checksumAddress(esc)
    const unsupported = (reason, message, extra) => new TapeAPIError('UNSUPPORTED_PAYMENT_TOKEN', message, { data: { reason, escrow: at, ...extra } })
    const word = addressOfWordStrict(await wordStrict(esc, 'token()', 'latest'))
    if (!word || /^0x0{40}$/.test(word)) throw unsupported('token-unreadable', `escrow ${at} answers no token(): it is not an escrow this SDK knows (one immutable token per instance, TAPI-22 §3.3), so the unit of its amounts is unknown`)
    const token = checksumAddress(word)
    const w = await wordStrict(token, 'decimals()', 'latest')
    const d = w === null ? null : BigInt(w)
    if (d === null || d > 255n) throw unsupported('decimals-unreadable', `the token ${token} of escrow ${at} answers no valid decimals(): its amounts cannot be read, and this SDK never assumes 8`, { token })
    if (d < 8n || d > 18n) throw unsupported('decimals-out-of-range', `the token ${token} of escrow ${at} has ${d} decimals; an escrow token has 8 to 18 (TAPI-22 §3.5 item 4)`, { token, decimals: Number(d) })
    const label = PAYMENT_TOKENS[Number(chainId)]?.[token.toLowerCase()]?.label ?? null
    return Object.freeze({ escrow: at, token, decimals: Number(d), label, display: label ? `${label} ${token}` : token })
  }

  async function contributionsAcross(provider, escrows = [...allowedEscrows]) {
    if (!isAddress(provider)) throw new TapeAPIError('INVALID_ARGUMENT', 'contributions: provider must be an address')
    if (!Array.isArray(escrows) || !escrows.every(isAddress)) throw new TapeAPIError('INVALID_ARGUMENT', 'contributions: escrows must be an array of escrow addresses')
    const list = [...new Map(escrows.map((e) => [e.toLowerCase(), checksumAddress(e)])).values()]
    // one failed read does not hide the others; it is reported with its code / 一个读取失败不掩盖其它，带错误码报告
    const readings = await Promise.all(list.map(async (esc) => {
      try { return { escrow: esc, bps: Number(await view(esc, 'contributionOf', [provider])) } }
      catch (e) { if (e instanceof TapeAPIError && e.code === 'INVALID_ARGUMENT') throw e; return { escrow: esc, bps: null, error: e?.code ?? 'ERROR' } }
    }))
    const seen = [...new Set(readings.filter((r) => r.bps !== null).map((r) => r.bps))]
    const consistent = seen.length <= 1
    const warning = consistent ? null
      : `the contribution of ${checksumAddress(provider)} differs across escrow instances: ${readings.filter((r) => r.bps !== null).map((r) => `${r.escrow} ${r.bps} bps`).join(', ')}. Each instance keeps its own setting, and one never set applies the default ${DEFAULT_CONTRIBUTION_BPS} bps; set it on each with tx.setContribution({ escrow }) if that is not what you meant`
    return { provider: checksumAddress(provider), readings, consistent, warning }
  }

  // ---- tx 构造 / calldata builders ----
  const WRAP_DEPOSIT_SELECTOR = selector('deposit()')   // WETH9 / WBNB deposit(), 0xd0e30db0
  const hex = (n) => '0x' + BigInt(n).toString(16)
  const needEscrow = () => { if (!isAddress(escrow)) throw new TapeAPIError('INVALID_ARGUMENT', 'escrow address not configured'); return escrow }
  // TAPI-22 §3.4: a service names its escrow in its manifest, and clients MUST use that address. Every channel
  // builder therefore takes either a provider address (configured escrow) or a resolved service, whose own
  // payment.escrow wins -- otherwise a consumer could fund escrow A for a service that settles on escrow B (D15).
  // TAPI-22 §3.4：服务在清单里指定托管合约，客户端 MUST 使用该地址。每个通道构造器接受提供者地址（用配置的托管）
  // 或已解析的服务（以其 payment.escrow 为准），否则消费者可能往 A 充值，而服务在 B 结算。
  const channelOf = (target) => {
    if (target && typeof target === 'object' && target.manifest) {
      const esc = target.manifest.payment?.escrow
      if (!isAddress(esc) || /^0x0{40}$/i.test(esc)) throw new TapeAPIError('INVALID_ARGUMENT', `${target.container} names no escrow: it takes no payment`)
      return { to: esc, provider: target.container }
    }
    if (!isAddress(target)) throw new TapeAPIError('INVALID_ARGUMENT', 'provider must be an address or a resolved service')
    return { to: needEscrow(), provider: target }
  }
  // TAPI-22 §3.5, before approve / fund: the escrow must be on AUDITED_ESCROWS or allowEscrows (approve lets it pull
  // tokens; a hostile manifest can name a contract that reports a real token and keeps the funds), then its token() must
  // be the token named, and BEM when none is named or the funds are for a manifest's priceBEM (other-token prices are
  // not yet specified). `bemOnly` (fund): a channel funded in another token is one this SDK cannot use yet, so an escrow
  // holding anything but BEM is refused whatever token the caller names. / 先查名单，再核对代币；fund 只接受持有 BEM 的托管。
  async function checkedEscrow(c, target, token, { bemOnly = false } = {}) {
    if (!allowedEscrows.has(String(c.to).toLowerCase())) {
      throw new TapeAPIError('INVALID_ARGUMENT', `escrow ${c.to} is not an audited escrow deployment this SDK knows (none is audited yet); to build approve or fund for it anyway, add it with createTapeAPI({ allowEscrows: [...] }), only if you trust it: approve lets an escrow pull your tokens, and a hostile manifest can name a contract that reports a real token but keeps what it is given (TAPI-22 §3.5)`, { data: { reason: 'escrow-not-allowed', escrow: c.to } })
    }
    const info = await paymentTokenOf(c.to)
    const data = { escrow: info.escrow, token: info.token }
    if (bemOnly && !eqAddr(info.token, MAINNET.bem)) {
      throw new TapeAPIError('UNSUPPORTED_PAYMENT_TOKEN', `escrow ${info.escrow} holds ${info.display}, and this SDK builds fund only for an escrow that holds BEM, whatever token is named. The escrow contract itself takes any admitted token; the manifest's pricing in more than one token is not yet specified (TAPI-22 §3.5), so this SDK does not build it yet`, { data: { reason: 'not-bem', ...data } })
    }
    if (token !== undefined && !eqAddr(info.token, token)) {
      throw new TapeAPIError('UNSUPPORTED_PAYMENT_TOKEN', `escrow ${info.escrow} holds ${info.display}, not ${checksumAddress(token)} as you named`, { data: { reason: 'token-mismatch', ...data, expected: checksumAddress(token) } })
    }
    const forManifest = !!(target && typeof target === 'object' && target.manifest)
    if ((forManifest || token === undefined) && !eqAddr(info.token, MAINNET.bem)) {
      throw new TapeAPIError('UNSUPPORTED_PAYMENT_TOKEN', `escrow ${info.escrow} holds ${info.display}, but ${forManifest ? `${target.container}'s manifest prices its methods in BEM (priceBEM)` : 'no token was named, and the default is BEM'}. The escrow contract takes any admitted token; manifest prices in other tokens are not yet specified (TAPI-22 §3.5), so this SDK does not fund it${forManifest ? '' : ' unless you name its token'}`, { data: { reason: 'not-bem', ...data } })
    }
    return { ...c, token: info }
  }
  const onChannel = (target, fn, args) => { const c = channelOf(target); return { to: c.to, data: encodeCall(fn, [c.provider, ...args]), value: '0x0' } }
  const tx = {
    // v2 escrow (TAPI-22 §3.3): fund a channel toward ONE provider; the channel balance is that provider's cap.
    // v2 托管：向**一个**提供者的通道充值；通道余额即该提供者的上限。
    // The escrow moves its token with transferFrom, so the FIRST transaction of any paid setup is this approval;
    // without it `fund` reverts inside the token with no useful message (traceability of the funding path).
    // 托管合约用 transferFrom 划转代币，因此任何付费流程的第一笔交易都是这个授权；缺了它 `fund` 会在代币里回滚且没有有用信息。
    // `amount` is REQUIRED: the spender may be an escrow the provider chose in its manifest (TAPI-22 §3.4), so an
    // unlimited approval would hand a hostile provider the consumer's whole balance (review H-1). Approve what you fund.
    // `amount` 必填：被授权方可能是服务方在清单里选定的托管合约，无限授权等于把消费者全部余额交给恶意服务方。授权多少就充值多少。
    // Experimental, async: checkedEscrow first; the token approved is the escrow's own token() / 实验性、异步
    // `fund` (below) is stricter: it is refused for an escrow that holds anything but BEM / `fund` 更严：托管持有 BEM 以外的代币一律拒绝
    approve: async ({ amount, token, spender } = {}) => {
      if (token !== undefined && !isAddress(token)) throw new TapeAPIError('INVALID_ARGUMENT', 'token must be an address')
      if (amount === undefined || amount === null) throw new TapeAPIError('INVALID_ARGUMENT', 'approve needs an amount: approve exactly what you will fund, never an unlimited allowance')
      const a = BigInt(amount)
      if (a <= 0n || a >= 2n ** 255n) throw new TapeAPIError('INVALID_ARGUMENT', 'approve amount must be positive and bounded')
      const c = await checkedEscrow(spender ? channelOf(spender) : { to: needEscrow(), provider: null }, spender, token)
      return { to: c.token.token, data: encodeCall('approve', [c.to, a]), value: '0x0' }
    },
    fund: async (provider, amount, { token } = {}) => {
      if (token !== undefined && !isAddress(token)) throw new TapeAPIError('INVALID_ARGUMENT', 'token must be an address')
      const c = channelOf(provider)
      const n = BigInt(amount)
      await checkedEscrow(c, provider, token, { bemOnly: true })
      return { to: c.to, data: encodeCall('fund', [c.provider, n]), value: '0x0' }
    },
    // requestWithdraw -> 48h cooldown -> withdraw inside a 7d window. `WithdrawRequested` is public: the provider
    // settles inside the cooldown, and while a request is alive the reference provider serves at most
    // channelOf − pendingWithdraw.amount (TAPI-22 §3.2(4)).
    // 提现：请求 -> 48h 冷静期 -> 7 天窗口内执行。事件公开，提供者在冷静期内结算；请求存续期间参考提供者最多服务 通道余额 − 待提现额。
    requestWithdraw: (provider, amount) => onChannel(provider, 'requestWithdraw', [BigInt(amount)]),
    cancelWithdraw: (provider) => onChannel(provider, 'cancelWithdraw', []),
    withdraw: (provider) => onChannel(provider, 'withdraw', []),
    // per channel, extend-only, expires <= now + 30d; there is no revoke / 按通道授权，只可延长，最长 30 天，无撤销
    authorizeSession: (provider, key, expires) => onChannel(provider, 'authorizeSession', [key, BigInt(expires)]),
    settle: (v, svc) => ({ to: svc ? channelOf(svc).to : needEscrow(), data: encodeCall('settle', [v.consumer, v.provider, BigInt(v.cumulative), BigInt(v.expires), v.sig]), value: '0x0' }),
    // WBNB.deposit() with `value`. `wbnb` is required (the SDK ships no wrapper address); no gas field: the wallet
    // estimates it (21,000 is too little for a contract call). / 包装原生币；必须传 WBNB 地址；不写死 gas。
    wrapNative: ({ wbnb, amount } = {}) => {
      if (!isAddress(wbnb) || eqAddr(wbnb, ZERO_ADDRESS)) throw new TapeAPIError('INVALID_ARGUMENT', 'wrapNative needs `wbnb`, the wrapper contract you have checked: the SDK ships no wrapper address')
      if (amount === undefined || amount === null) throw new TapeAPIError('INVALID_ARGUMENT', 'wrapNative needs an amount (smallest unit of the native coin)')
      const n = BigInt(amount)
      if (n <= 0n || n >= 2n ** 256n) throw new TapeAPIError('INVALID_ARGUMENT', 'wrapNative amount must be positive and fit uint256')
      return { to: checksumAddress(wbnb), data: WRAP_DEPOSIT_SELECTOR, value: hex(n) }
    },
    // Escrow v3: pay the accrued contributions to the current treasury; anyone may send it / 任何人可发送
    claimTreasury: (esc) => ({ to: checksumAddress(escrowAddressOf(esc)), data: encodeCall('claimTreasury', []), value: '0x0' }),
    // 持有人为自己的服务设置贡献比例（万分比，0..MAX_CONTRIBUTION_BPS）/ holder sets a service's contribution (bps, 0..MAX_CONTRIBUTION_BPS)
    setContribution: ({ circuits, tokenId, bps, escrow: esc }) => {
      const n = Number(bps)
      if (!Number.isInteger(n) || n < 0 || n > MAX_CONTRIBUTION_BPS) throw new TapeAPIError('INVALID_ARGUMENT', `bps must be an integer 0..${MAX_CONTRIBUTION_BPS}`)
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
      if (typeof container !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(container)) throw new TapeAPIError('INVALID_ARGUMENT', 'publishManifest: container must be an address')
      const text = typeof manifest === 'string' ? manifest : JSON.stringify(manifest)
      let parsed
      try { parsed = JSON.parse(text) } catch (e) { throw new TapeAPIError('MANIFEST_INVALID', `publishManifest: manifest is not JSON: ${e.message}`) }
      validateManifest(parsed)
      if (typeof parsed.container === 'string' && parsed.container.toLowerCase() !== container.toLowerCase()) {
        throw new TapeAPIError('MANIFEST_INVALID', `publishManifest: manifest.container ${parsed.container} is not the target container ${container}`)
      }
      const bytes = new TextEncoder().encode(text)
      if (bytes.length > MANIFEST_LIMIT) throw new TapeAPIError('MANIFEST_INVALID', `publishManifest: ${bytes.length} bytes exceeds the TAPI-20 limit of ${MANIFEST_LIMIT}`)
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
     * Publish a channel identity record (TAPI-26 §3.1) in the container's site: the same putFile path as a manifest.
     * `record` is what scripts/channel-keys.mjs prints once the holder's wallet has signed. Removing the file is how
     * a holder withdraws the identity before it expires.
     * 在容器站点发布通道身份记录，与清单走同一条 putFile 路径。删除该文件即可在到期前撤回身份。
     */
    publishChannelKeys: ({ container, record }) => {
      if (!isAddress(container)) throw new TapeAPIError('INVALID_ARGUMENT', 'publishChannelKeys: container must be an address')
      if (!record || record.tapechannel !== '1' || !eqAddr(record.container, container)) throw new TapeAPIError('INVALID_ARGUMENT', 'publishChannelKeys: record must be a tapechannel "1" record for this container')
      const bytes = new TextEncoder().encode(canonicalJSON(record))
      if (bytes.length > CHANNEL_KEYS_LIMIT) throw new TapeAPIError('CHANNEL_INVALID', `publishChannelKeys: ${bytes.length} bytes exceeds ${CHANNEL_KEYS_LIMIT}`)
      return { txs: [{ to: siteRegistry, data: encodeCall('putFile', [container, CHANNEL_KEYS_KEY, 'application/json', toHex(sha256(bytes)), toHex(bytes)]), value: '0x0' }], key: CHANNEL_KEYS_KEY, size: bytes.length, sha256Hash: toHex(sha256(bytes)) }
    },
    removeChannelKeys: (container) => ({ to: siteRegistry, data: encodeCall('removeFile', [container, CHANNEL_KEYS_KEY]), value: '0x0' }),
    register: ({ circuits, tokenId, label, manifestPath = MANIFEST_KEY, value = 0n }) => ({   // registry form, no leading slash (TAPI-20 §3.2) / 注册表形式，无前导斜杠
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
   * TAPI-27 §3.3 step 6: a verifier for group rosters. Each member's keys must equal the channel record its circuit's
   * holder published; records are cached for GROUP_VERIFY_CACHE_S (300 s) in the client's identity cache (arch B7).
   * 群名单核验器：每个成员的密钥必须等于其电路持有人发布的通道记录；记录只缓存 300 秒（客户端身份缓存）。
   */
  function groupVerifier() {
    // Cached for minutes, not until the record expires: a circuit that changes hands must drop out of every group
    // it was in (TAPI-26 §3.1). A record that is definitively invalid answers false; an RPC failure throws, so a
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
  const api = { resolve, refresh, acceptPrice, acceptedPrice, call, callQuorum, payer, tx, rpc, chain, chainId, groupVerifier, addresses: { hub, siteRegistry, factory, directory, escrow }, randomPrivateKey, forChain, chainOfContainer, clearDelegationFloor, siteStatus }
  // This chain's part of the every-chain search (everyChain): siteStatus and, in the conformance mode, resolve.
  // 本链在所有链搜索（everyChain）中的那一份：siteStatus，以及一致模式下的 resolve。
  TAP10_LOCAL.set(api, {
    site: (input) => siteHere(input),
    prepare: (input) => {
      if (!conformMode) throw new TapeAPIError('INTERNAL', `the client of chain ${chainId} is not in the conformance mode`)
      return prepareConform(input, { hold: true })
    },
  })
  return api
}
