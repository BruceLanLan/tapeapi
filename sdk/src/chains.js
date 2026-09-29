// The TapeOut chains TapeAPI reads, and TapeOut names with area codes. The one place a chain's contract addresses live.
// TapeAPI 读取的 TapeOut 各链，以及带区号的 TapeOut 名字。各链合约地址只在这里。
//
// Source of truth: TapeKit kernel/src/config.js (BSC_MAINNET, XLAYER_MAINNET, BASE_MAINNET), send/contracts/script/
// L2Addresses.sol and send/module/src/chain.js (HUB_MAINNET, HUB_IMPLEMENTATIONS_BY_CHAIN), commit 1050950d
// (2026-09-28). Every address was read on chain 2026-09-28 (code present; ERC-1967 implementation slot equal to the
// value below; hub.accountOf equal to opener.accountOf): sdk/test/fixtures/chains-onchain.json records what the nodes
// answered, sdk/test/chains.test.mjs pins it, and `node scripts/probe-chains.mjs` checks it again live.
// 来源：TapeKit kernel/src/config.js、L2Addresses.sol 与 send/module/src/chain.js。每个地址都于 2026-09-28 在链上只读核对
// （有代码；ERC-1967 实现槽等于下面的值；hub.accountOf 等于 opener.accountOf）：节点的回答记在 fixtures/chains-onchain.json，
// chains.test.mjs 钉住它，`node scripts/probe-chains.mjs` 在线重查。
//
// What follows TapeOut to an L2 (docs/PLAN-2026Q4.md, 2026-09-28): identity, name resolution, manifests, delegations,
// receipts and MCP verification. What does not: payments (the escrow and BEM are on BNB Smart Chain only), ChannelBus and
// the public services. `payments` below says which.
// 跟随 TapeOut 到 L2 的：身份、名字解析、清单、委托、回执与 MCP 核验。不跟随的：支付（托管与 BEM 只在 BNB Smart Chain）、
// ChannelBus 与公共服务。下面的 `payments` 标明哪条链可以付费。
//
// Leaf module: no imports, so a browser page or a Worker can take it alone. / 叶子模块：不导入任何东西。

/** ERC-1967 implementation slot / ERC-1967 实现槽 */
export const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

// DeWebHub: one proxy address on every chain (CREATE2 boot implementation + a proxy that depends only on its owner,
// TapeKit send/contracts/script/Deploy.s.sol), upgraded on each chain to that chain's own implementation, whose
// constructor carries the chain's TapeOut addresses and chainId. It derives containers (accountOf, through the ERC-6551
// registry) and is the verifyingContract of TAP-20 delegations and TAP-26 channel records. Owner (not yet sealed):
// 0x571d447f4f24688ec35ccf07f1d6993655f6af15 on all three chains.
// DeWebHub：每条链同一个代理地址，各链升级到本链的正式实现（构造参数含本链 TapeOut 地址与链号）。它推导容器（accountOf），
// 也是 TAP-20 委托与 TAP-26 通道记录的 verifyingContract。
const HUB = '0xe61A9C7213a6Aa616C246a2B569e555B417b25ee'
const ERC6551_REGISTRY = '0x000000006551c19487814612e58FE06813775758'

// Base and X Layer: the same TapeOut sources, deployed by the same deployer in the same order, so the same addresses on
// both (TapeKit config.js). Only the hub implementation differs (its constructor takes the chainId).
// Base 与 X Layer：同一份 TapeOut 源码、同一部署者、同样顺序，两链地址相同；只有中枢实现不同（构造参数含链号）。
const L2 = {
  factory: '0x1f09DAeFA827f02CBb40967cc91b259763760761',
  opener: '0x536adD8F30f03b69f6fbF29d425A816A0dC50106',
  siteRegistry: '0xd6EFb7adCc9c83dC4924Ad56f6a8E4e969b9ADB6',
  binding: '0x68809Fd2fb343aA57D0aeB7f33Defe477c9666f9',
  accountImplementation: '0xAC4F791353eE9F06e2C50Ae4C34680D28Ea52a57',
  expectedImpl: {
    '0x1f09daefa827f02cbb40967cc91b259763760761': ['0x74956236ab64ed143933040b4137e8a352e4d17b'],   // factory (factorySeal)
    '0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6': ['0xa85c4143d1d4a77f54b8e4ecc9e6d1418afea45f'],   // SiteRegistry
    '0x68809fd2fb343aa57d0aeb7f33defe477c9666f9': ['0x5ebf29b80789e548907c707530c3c7607c4347df'],   // DomainBinding
  },
  // Reads pin to "latest" as on BNB; "confirmed" is the safe block (an L2's latest block is the sequencer's word
  // alone until it is posted to Ethereum). TapeAPI reads identity at latest, like TapeKit.
  // 读取与 BNB 一样钉在 latest；"已确认"以 safe 区块为准（L2 的最新块在提交到以太坊之前只是排序器一家之言）。
  pin: 'latest', finality: 'safe', payments: false, nameSuffix: 'tape',
}
// Security 1.1, read at runtime only when a client opts in to pinning (createTapeAPI({ pin: true })): `finality` is the
// tag a pinned resolution starts from, and `maxPinAgeS` the oldest block (by its timestamp against the client's clock) it
// accepts, about maxPinLagBlocks block times. Measured 2026-09-30 on the default nodes: BSC finalized was 2 s old,
// X Layer safe 94 s, Base safe 84-188 s. `pin: 'latest'` stays the default: reads are unpinned unless the client asks.
// 安全加固 1.1：只有客户端选择钉块时（createTapeAPI({ pin: true })）运行时才读取：`finality` 是钉块的起点标签，`maxPinAgeS`
// 是可接受的最旧区块（按区块时间戳对照客户端时钟），约为 maxPinLagBlocks 个出块时间。2026-09-30 默认节点实测：BSC finalized
// 落后 2 秒，X Layer safe 94 秒，Base safe 84–188 秒。默认仍为 `pin: 'latest'`：客户端不要求就不钉块。

const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o) }

/** Supported chains by chainId. `area` null = names carry no area code (BNB Smart Chain). / 按链号列出的已支持链。 */
export const CHAINS = deepFreeze({
  56: {
    chainId: 56, key: 'bnb', name: 'BNB Smart Chain', currency: 'BNB', area: null, nameSuffix: 'tape',
    factory: '0x68224F668083c29e9800Be2a646d42d18cedF7e2',
    opener: '0x021745DE2f42A7839d96f2d3634d0294487D81F1',
    hub: HUB,
    siteRegistry: '0xd006ffdd5Ae313B17729621A00999cD3C71CE5e6',
    binding: '0x861EE183de2BBE4a6ecf9D15812C123b566a3DB7',
    erc6551Registry: ERC6551_REGISTRY,
    accountImplementation: '0xAf4E78a2257C9c5480c2F8310E3b00437260751d',
    expectedImpl: {
      '0x68224f668083c29e9800be2a646d42d18cedf7e2': ['0xa68ccf4931d98ad0a4be15ee40542edc0dec6422'],
      '0xd006ffdd5ae313b17729621a00999cd3c71ce5e6': ['0x1d279d138a4d803378a7d4557c056f1bed53c261'],
      // two audited implementations, the older kept so an owner rollback does not lock clients out (TapeKit)
      '0x861ee183de2bbe4a6ecf9d15812c123b566a3db7': ['0xaa226181a6588d3f9ac0035e5f3dbaf311039bce', '0x4e8684eaea48b524245b2191dee451eaa1c1ca94'],
      '0xe61a9c7213a6aa616c246a2b569e555b417b25ee': ['0x80afe7b77f2dfd08e9feab7675780bac34a7ee85'],
    },
    // The delegation domain: EIP712Domain("TapeAPI", "1", chainId, verifyingContract) (TAP-20 §3.4)
    delegation: { chainId: 56, verifyingContract: HUB },
    pin: 'latest', finality: 'finalized', maxPinLagBlocks: 400, maxPinAgeS: 180, payments: true,   // 0.45 s a block / 约 0.45 秒一块
  },
  196: {
    chainId: 196, key: 'xlayer', name: 'X Layer', currency: 'OKB', area: 2, ...L2, hub: HUB,
    erc6551Registry: ERC6551_REGISTRY,
    expectedImpl: { ...L2.expectedImpl, '0xe61a9c7213a6aa616c246a2b569e555b417b25ee': ['0xdcc57797089ebd9f26e686379a4323f353a3f9c6'] },
    delegation: { chainId: 196, verifyingContract: HUB },
    maxPinLagBlocks: 300, maxPinAgeS: 300,   // about one block a second: 5 minutes / 约 1 秒一块
  },
  8453: {
    chainId: 8453, key: 'base', name: 'Base', currency: 'ETH', area: 3, ...L2, hub: HUB,
    erc6551Registry: ERC6551_REGISTRY,
    expectedImpl: { ...L2.expectedImpl, '0xe61a9c7213a6aa616c246a2b569e555b417b25ee': ['0x38a2d320b8984bbac9b0a2691b6c0fd829a23867'] },
    delegation: { chainId: 8453, verifyingContract: HUB },
    maxPinLagBlocks: 150, maxPinAgeS: 300,   // two seconds a block / 2 秒一块
  },
})

/** Supported chainIds, BNB Smart Chain first. / 已支持的链号，BNB 在前。 */
export const CHAIN_IDS = Object.freeze([56, 196, 8453])
export const HOME_CHAIN_ID = 56

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
/** The chain with this chainId, or null. / 该链号的链，没有则为 null。 */
export function chainById(chainId) {
  const n = Number(chainId)
  return Number.isInteger(n) && own(CHAINS, n) ? CHAINS[n] : null
}
/** The chain with this area code; null (or undefined) is BNB Smart Chain. An unassigned code is null. / 区号对应的链。 */
export function chainByArea(area) {
  if (area === null || area === undefined) return CHAINS[56]
  const n = Number(area)
  return CHAIN_IDS.map((id) => CHAINS[id]).find((c) => c.area !== null && c.area === n) ?? null
}
/** The chain with this short key ('bnb', 'xlayer', 'base'), or null. / 按短键找链。 */
export function chainByKey(key) {
  const k = String(key ?? '').toLowerCase()
  return CHAIN_IDS.map((id) => CHAINS[id]).find((c) => c.key === k) ?? null
}

// ── TapeOut names / TapeOut 名字 ─────────────────────────────────────────────────────────────────────────────────
// TapeKit kernel/src/name.js and config.js (TapeKit's SPEC.md v0.2 predates area codes and names BNB only):
//   BNB Smart Chain   <#ID>.<processor>.tape            4246.0.tape       (no area code)
//   other chains      <#ID>.<area>.<processor>.tape     1.2.344.tape      (X Layer area 2, Base area 3)
// Area codes are assigned once and never change or get reused; 0 and 1 are reserved (a BNB name carries none, so one
// site has one name). Canonical form: decimal, no leading zeros (except a processor number `0`), lowercase, #ID >= 1.
// The suffix-less form (`4246.0`, `1.2.344`) is the same name. TapeKit's other address-bar spellings (`#1@2.344`,
// `tape://1.2.344.tape/`, upper case, a trailing dot) are refused rather than guessed at, as are unassigned area codes.
// TapeKit kernel/src/name.js 与 config.js（TapeKit SPEC.md v0.2 早于区号，只写了 BNB）：BNB 不带区号，其它链带区号
// （X Layer 2，Base 3）。区号一经分配永不更改、不复用；0 与 1 保留。规范形式：十进制、无前导零（处理器编号 `0` 除外）、全小写、
// #ID >= 1；不带后缀的写法是同一个名字。TapeKit 地址栏的其它写法、大写、末尾的点以及未分配的区号一律拒绝而不猜。

// Anything made of digits joined by dots or @ (optionally with #, a scheme, the suffix, a trailing dot or a path) is
// name-shaped: it is a name or an error, never a directory label, so no label can squat a spelling of a name.
// 由点或 @ 连接的数字串（可带 #、协议头、后缀、末尾的点或路径）都算"像名字"：要么是名字要么报错，永远不当目录标签。
const NAME_SHAPED = /^(?:(?:web\+)?tape:\/\/)?#?\d+(?:[.@]\d+)+(?:\.tape)?\.?(?:\/.*)?$/i
const CANONICAL = /^([1-9]\d{0,77})(?:\.(0|[1-9]\d{0,6}))?\.(0|[1-9]\d{0,77})(\.tape)?$/
const MAX_UINT = 2n ** 256n

/** Is `str` name-shaped (a TapeOut name, or a spelling of one)? / 是否像 TapeOut 名字。 */
export const isNameShaped = (str) => typeof str === 'string' && NAME_SHAPED.test(str.trim())

/**
 * Parse a TapeOut name. Returns null when `str` is not name-shaped; `{ error }` when it is name-shaped but not a
 * canonical name of a supported chain; otherwise `{ tokenId, processor, area, chainId, name }` with decimal strings and
 * `name` the canonical form with the suffix.
 * 解析 TapeOut 名字。不像名字返回 null；像名字但不是已支持链的规范名字返回 { error }；否则返回各部分与带后缀的规范名字。
 */
export function parseTapeName(str) {
  if (!isNameShaped(str)) return null
  const t = str.trim()
  const m = CANONICAL.exec(t)
  if (!m || BigInt(m[1]) >= MAX_UINT || BigInt(m[3]) >= MAX_UINT) {
    return { error: `"${t.slice(0, 80)}" is not a TapeOut name in canonical form: write <#ID>.<processor>.tape on BNB Smart Chain or <#ID>.<area>.<processor>.tape on another chain, decimal without leading zeros, lowercase, #ID >= 1 (TapeKit SPEC §2.2, kernel/src/name.js)` }
  }
  let chain = CHAINS[56]
  if (m[2] !== undefined) {
    const area = Number(m[2])
    if (area === 0 || area === 1) return { error: `"${t.slice(0, 80)}": area codes 0 and 1 are reserved; a BNB Smart Chain name carries no area code (<#ID>.<processor>.tape)` }
    chain = chainByArea(area)
    if (!chain) return { error: `"${t.slice(0, 80)}": area code ${area} is not assigned to a chain this client supports (${CHAIN_IDS.filter((id) => CHAINS[id].area !== null).map((id) => `${CHAINS[id].area} = ${CHAINS[id].name}`).join(', ')})` }
  }
  return { tokenId: m[1], processor: m[3], area: chain.area, chainId: chain.chainId, name: formatTapeName({ tokenId: m[1], processor: m[3], chainId: chain.chainId }) }
}

/**
 * The canonical name (with `.tape`) of #tokenId on processor `processor` of chain `chainId` (default 56).
 * `{ suffix: false }` leaves the suffix off (`1.2.344`, as an address bar shows it). Throws RangeError on bad input.
 * 某链上某处理器 #ID 的规范名字（带 `.tape`）。`{ suffix: false }` 不带后缀。输入不对抛 RangeError。
 */
export function formatTapeName({ tokenId, processor, chainId = 56 }, { suffix = true } = {}) {
  const chain = chainById(chainId)
  if (!chain) throw new RangeError(`chain ${chainId} is not a TapeOut chain this client supports`)
  const dec = (v, what, min) => {
    let n
    try { n = BigInt(v) } catch { throw new RangeError(`${what} must be a whole number`) }
    if (typeof v === 'string' && !/^(0|[1-9]\d*)$/.test(v)) throw new RangeError(`${what} must be decimal digits without leading zeros`)
    if (n < min || n >= MAX_UINT) throw new RangeError(`${what} out of range`)
    return n.toString()
  }
  const short = `${dec(tokenId, '#ID', 1n)}.${chain.area === null ? '' : `${chain.area}.`}${dec(processor, 'processor', 0n)}`
  return suffix ? `${short}.${chain.nameSuffix}` : short
}
