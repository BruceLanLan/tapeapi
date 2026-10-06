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
// What follows TapeOut to an L2 (the 2026 Q4 plan, 2026-09-28): identity, name resolution, manifests, delegations,
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
// registry) and is the verifyingContract of TAPI-20 delegations and TAPI-26 channel records. Owner (not yet sealed):
// 0x571d447f4f24688ec35ccf07f1d6993655f6af15 on all three chains.
// DeWebHub：每条链同一个代理地址，各链升级到本链的正式实现（构造参数含本链 TapeOut 地址与链号）。它推导容器（accountOf），
// 也是 TAPI-20 委托与 TAPI-26 通道记录的 verifyingContract。
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
// accepts, about maxPinLagBlocks block times. `pin: 'latest'` stays the default: reads are unpinned unless the client asks.
// maxPinAgeS covers the tag's own lag, a node lagging now and then and the client's clock error. Measured 2026-09-30
// (FIXED RPC2-3): BSC finalized 0-2 s old (96 samples; 120 s leaves room for a clock off by a minute); X Layer safe
// moves every ~228 s and reached 248 s (70 samples; 300 left 52 s, so 600); Base safe 56-188 s (300 kept).
// 安全加固 1.1：只有客户端选择钉块时（createTapeAPI({ pin: true })）运行时才读取：`finality` 是钉块的起点标签，`maxPinAgeS`
// 是可接受的最旧区块（按区块时间戳对照客户端时钟），约为 maxPinLagBlocks 个出块时间。默认仍为 `pin: 'latest'`：客户端不要求就不钉块。
// maxPinAgeS 要覆盖标签本身的落后、节点偶尔的落后与客户端时钟误差。2026-09-30 实测（FIXED RPC2-3）：BSC finalized 0–2 秒
// （96 个样本；120 秒给偏差一分钟的时钟留余量）；X Layer safe 约每 228 秒跳一次、最大 248 秒（70 个样本；300 只剩 52 秒，改 600）；
// Base safe 56–188 秒（300 不变）。

// TAP-10 §2.1 "Max pin lag (blocks)": the most a TAP-10 pinned block (§5.3, pin: 'tap10' and conform: 'tap10') may fall
// behind the highest head any operator reports, about five minutes of blocks on each chain. Checked by block numbers only,
// never against a clock. maxPinLagBlocks and maxPinAgeS above belong to the security-1.1 pin (pin: true) and are unchanged.
// TAP-10 §2.1 的"最大钉块滞后（块数）"：TAP-10 钉块（§5.3，pin: 'tap10' 与 conform: 'tap10'）最多落后于任一运营方报告的最高头块多少块，
// 各链约五分钟的块数。只按块号检查，绝不对照时钟。上面的 maxPinLagBlocks 与 maxPinAgeS 属于安全加固 1.1 的钉块（pin: true），不变。

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
    // The delegation domain: EIP712Domain("TapeAPI", "1", chainId, verifyingContract) (TAPI-20 §3.4)
    delegation: { chainId: 56, verifyingContract: HUB },
    pin: 'latest', finality: 'finalized', maxPinLagBlocks: 266, maxPinAgeS: 120, payments: true,   // 0.45 s a block / 约 0.45 秒一块
    tap10MaxPinLag: 400,
  },
  196: {
    chainId: 196, key: 'xlayer', name: 'X Layer', currency: 'OKB', area: 2, ...L2, hub: HUB,
    erc6551Registry: ERC6551_REGISTRY,
    expectedImpl: { ...L2.expectedImpl, '0xe61a9c7213a6aa616c246a2b569e555b417b25ee': ['0xdcc57797089ebd9f26e686379a4323f353a3f9c6'] },
    delegation: { chainId: 196, verifyingContract: HUB },
    maxPinLagBlocks: 600, maxPinAgeS: 600,   // about one block a second: 10 minutes / 约 1 秒一块
    tap10MaxPinLag: 300,
  },
  8453: {
    chainId: 8453, key: 'base', name: 'Base', currency: 'ETH', area: 3, ...L2, hub: HUB,
    erc6551Registry: ERC6551_REGISTRY,
    expectedImpl: { ...L2.expectedImpl, '0xe61a9c7213a6aa616c246a2b569e555b417b25ee': ['0x38a2d320b8984bbac9b0a2691b6c0fd829a23867'] },
    delegation: { chainId: 8453, verifyingContract: HUB },
    maxPinLagBlocks: 150, maxPinAgeS: 300,   // two seconds a block / 2 秒一块
    tap10MaxPinLag: 150,
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
// TAP-10 §3.1 (1.4, an erratum that applies to every mode): 1 <= #ID <= 10^18 and 0 <= processor number <= 10^9. A name
// outside these ranges cannot exist on chain (no processor numbers a circuit that high, no factory holds that many
// processors), so refusing it changes no answer about a real circuit; until 1.3 the parser took up to 78 digits.
// TAP-10 §3.1（1.4，按勘误，所有模式都适用）：1 <= #ID <= 10^18，0 <= 处理器号 <= 10^9。超出范围的名字在链上不可能存在，拒绝它
// 不会改变对任何真实电路的回答；1.3 之前解析器接受最多 78 位数字。
export const MAX_TOKEN_ID = 10n ** 18n
export const MAX_PROCESSOR = 10n ** 9n

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
  if (!m) {
    return { error: `"${t.slice(0, 80)}" is not a TapeOut name in canonical form: write <#ID>.<processor>.tape on BNB Smart Chain or <#ID>.<area>.<processor>.tape on another chain, decimal without leading zeros, lowercase, #ID >= 1 (TapeKit SPEC §2.2, kernel/src/name.js)` }
  }
  if (BigInt(m[1]) > MAX_TOKEN_ID || BigInt(m[3]) > MAX_PROCESSOR) {
    return { error: `"${t.slice(0, 80)}" is out of range: a TapeOut name has 1 <= #ID <= 10^18 and 0 <= processor number <= 10^9 (TAP-10 §3.1)` }
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

// TAP-10 §3.4 input forms, for the conformance mode (conform: 'tap10') only. The default mode keeps parseTapeName above,
// which takes the canonical name and the short name and refuses every other spelling.
//   on-chain name / short name   4246.0.tape, 4246.0, 1.3.1.tape, 1.3.1     (`.tape` in any case)
//   URL                          tape://4246.0.tape/docs/, tape://4246.0/, web+tape://1.3.1.tape/   (scheme in any case; the
//                                path is ignored: a service is the circuit, not a page)
//   display label                #4246@0, 4246@0, #1@3.1
//   container address            0x + 40 hex digits
//   processor contract#ID        0x50A9...9DD9#4246
// Anything else is an input error (§3.4: "a client MUST NOT guess"), and so is a name out of the §3.1 ranges. Returns
// { kind: 'name', tokenId, processor, area, chainId, name } | { kind: 'container', container } |
// { kind: 'pair', circuits, tokenId } | { error }.
// TAP-10 §3.4 的输入形式，只供一致模式使用。默认模式仍用上面的 parseTapeName：只收规范名字与短名字，其它写法一律拒绝。
// 其它任何东西都是输入错误（§3.4："客户端不得猜测"），超出 §3.1 范围的名字也是。
const LABEL_FORM = /^#?([1-9]\d{0,77})@(?:(0|[1-9]\d{0,6})\.)?(0|[1-9]\d{0,77})$/
const URL_FORM = /^(?:web\+)?tape:\/\/([^/?#]+)(?:[/?#].*)?$/i
const PAIR_FORM = /^(0x[0-9a-fA-F]{40})#([1-9]\d{0,77})$/
export function parseTapeInput(input) {
  if (typeof input !== 'string') return { error: 'input must be a string' }
  const t = input.trim()
  const shown = `"${t.slice(0, 80)}"`
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) return { kind: 'container', container: t }
  let m = PAIR_FORM.exec(t)
  if (m) {
    if (BigInt(m[2]) > MAX_TOKEN_ID) return { error: `${shown} is out of range: #ID must be at most 10^18 (TAP-10 §3.1)` }
    return { kind: 'pair', circuits: m[1], tokenId: m[2] }
  }
  let nameText = t
  m = URL_FORM.exec(t)
  if (m) nameText = m[1]
  else {
    m = LABEL_FORM.exec(t)
    if (m) nameText = m[2] === undefined ? `${m[1]}.${m[3]}` : `${m[1]}.${m[2]}.${m[3]}`
  }
  // `.tape` in any case; the digits themselves have no case / `.tape` 不分大小写
  nameText = nameText.replace(/\.tape$/i, '.tape')
  if (!/^\d+(?:\.\d+){1,2}(?:\.tape)?$/.test(nameText)) return { error: `${shown} is not a TAP-10 input form: give an on-chain name (4246.0.tape), a short name (4246.0), a tape:// URL, a display label (#4246@0), a container address or a processor contract#ID (TAP-10 §3.4)` }
  const p = parseTapeName(nameText)
  if (!p || p.error) return { error: p?.error ?? `${shown} is not a TapeOut name` }
  return { kind: 'name', ...p }
}

/**
 * The canonical name (with `.tape`) of #tokenId on processor `processor` of chain `chainId` (default 56).
 * `{ suffix: false }` leaves the suffix off (`1.2.344`, as an address bar shows it). Throws RangeError on bad input.
 * 某链上某处理器 #ID 的规范名字（带 `.tape`）。`{ suffix: false }` 不带后缀。输入不对抛 RangeError。
 */
export function formatTapeName({ tokenId, processor, chainId = 56 }, { suffix = true } = {}) {
  const chain = chainById(chainId)
  if (!chain) throw new RangeError(`chain ${chainId} is not a TapeOut chain this client supports`)
  const dec = (v, what, min, max) => {
    let n
    try { n = BigInt(v) } catch { throw new RangeError(`${what} must be a whole number`) }
    if (typeof v === 'string' && !/^(0|[1-9]\d*)$/.test(v)) throw new RangeError(`${what} must be decimal digits without leading zeros`)
    if (n < min || n > max) throw new RangeError(`${what} out of range (TAP-10 §3.1: ${min} to ${max})`)
    return n.toString()
  }
  const short = `${dec(tokenId, '#ID', 1n, MAX_TOKEN_ID)}.${chain.area === null ? '' : `${chain.area}.`}${dec(processor, 'processor', 0n, MAX_PROCESSOR)}`
  return suffix ? `${short}.${chain.nameSuffix}` : short
}

// ── TAP-10 messaging: what a client accepts behind the DeWEB hub (§13.2, §13.8, Deployments) ─────────────────────────
// For the conformance mode's messaging reads (conform: 'tap10': api.chain.tapeSendKey). `hub` is the ONE implementation
// TAP-10 lists as current on that chain (§13.8 accepts no other; chains.js expectedImpl is the sentinel's list, which may
// hold rollback entries). `factory` is the factory implementation of the factory seal (§13.8 ①). `circuitBeacon`,
// `circuitImplementation` and `circuitCodehash` are the hub's constructor arguments: beacon.implementation() other than
// circuitImplementation is `circuits-changed`. Read back on chain 2026-10-02, read-only, at one TAP-10 pinned block per
// chain (BNB Smart Chain 125144083, Base 52043989, X Layer 72108297) through the SDK's default nodes: hub.circuitBeacon(),
// hub.circuitImplementation(), hub.circuitCodehash(), beacon.implementation(), beacon.owner() (= the factory), the hub and
// factory ERC-1967 slots and the code hash of processor 0, all equal to TAP-10's Deployments table
// (sdk/test/fixtures/tap10-seal-onchain.json; sdk/test/conform-messaging.test.mjs pins it). Nothing was sealed.
// TAP-10 消息层：客户端在 DeWEB 中枢背后接受什么。`hub` 是 TAP-10 列为该链"当前"的唯一实现（§13.8 不接受其它；expectedImpl
// 是哨兵的列表，可能含回滚项）。`factory` 是工厂封存所需的工厂实现。`circuitBeacon`、`circuitImplementation`、`circuitCodehash`
// 是中枢的构造参数：beacon.implementation() 不等于 circuitImplementation 即 `circuits-changed`。2026-10-02 在链上只读核对，
// 与 TAP-10 的 Deployments 表一致（录制见 fixtures/tap10-seal-onchain.json）。当时都没有封存。
const L2_SEALS = {
  factory: '0x74956236Ab64eD143933040B4137E8A352e4d17b',
  circuitBeacon: '0xf70d1ed4f62CF3780157B0b421b7E2F45bD0991C',
  circuitImplementation: '0x977f217887E085D298Cb3819cDAD5A0ee35F29B2',
  circuitCodehash: '0x57aa306fd0be97087da3534e03398f5ff4efd533b5be4e45a405ce86fa6717d5',
}
export const TAP10_SEALS = deepFreeze({
  56: {
    hub: '0x80aFE7B77F2dFD08e9feab7675780baC34a7EE85',   // v3, current since block 122623031 (v1, v2 are not accepted)
    factory: '0xa68cCF4931d98ad0A4BE15eE40542eDc0DEc6422',
    circuitBeacon: '0xf8D6d8EB894d6971c8976Ad8b4971cbEFE028156',
    circuitImplementation: '0x8E1D125Def6d3826C278299273a0760D47626068',
    circuitCodehash: '0xd8c4b0216e0aadd615fbd134465b6af060a11769edc7c844d8f14d1b8a783992',
  },
  196: { hub: '0xdCC57797089eBD9f26e686379A4323f353a3F9C6', ...L2_SEALS },
  8453: { hub: '0x38A2d320b8984Bbac9b0a2691B6c0FD829A23867', ...L2_SEALS },
})
// ── Escrow tokens and audited escrow deployments (TAPI-22 §3.5, experimental) ──────────────────────────────────────
// An escrow token's label, fixed per address: never the token's own name() (the Binance-Peg USDT's reads "Tether USD",
// and anyone can deploy such a name). Unlisted tokens show as their address; decimals are always read from the token.
// 托管代币的显示名按地址固定，绝不用 name()；不在表里只显示地址；小数位一律从代币读取。
export const PAYMENT_TOKENS = deepFreeze({
  56: {
    '0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a': { label: 'BEM', address: '0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a' },
    '0x55d398326f99059ff775485246999027b3197955': { label: 'USDT (Binance-Peg)', address: '0x55d398326f99059fF775485246999027B3197955' },
  },
  196: {},
  8453: {},
})
// Escrows tx.approve / tx.fund build for without allowEscrows: audited deployments only (TAPI-22 §3.5). None yet.
// 无需 allowEscrows 即可构造 approve / fund 的已审计托管；目前没有。
export const AUDITED_ESCROWS = deepFreeze({ 56: [], 196: [], 8453: [] })

// TAP-10 §12.1: an endpoint's chainId above 2^53 − 1 is not a supported chain (the conformance mode refuses it).
// TAP-10 §12.1：端点 chainId 大于 2^53 − 1 的链不受支持（一致模式拒绝）。
export const TAP10_MAX_CHAIN_ID = 2n ** 53n - 1n
