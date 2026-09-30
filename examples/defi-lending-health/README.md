# defi-lending-health — Venus（BNB Chain Core Pool）仓位健康度

给定一批地址，在**同一个锚定区块**上返回每个地址的健康因子、可清算标志、分市场明细与每个市场的可清算金额上限；
另有一个 `latest` 快通道给机器人。所有读取经 Multicall3 批量、按 `blockHash`（EIP-1898）求值、签名返回。

给谁用：清算机器人的**监控通道**（不是竞速通道）、风控面板、借贷前端的可归属数据源。

## 它做不到什么（先说这个）

**本服务不能列出"全网所有可清算仓位"。** 纯 `eth_call` 无法枚举借款人：要枚举就得索引 `Borrow` / `Mint` /
`MarketEntered` 事件，而 BNB Chain 官方公共节点**明确禁用了 `eth_getLogs`**（docs.bnbchain.org 的 JSON-RPC
endpoint 页：“eth_getLogs is disabled on below Mainnet endpoints”，速率上限 10K/5min）。

Venus 官方文档自己也这么说（docs-v4.venus.io/guides/liquidation）：清算者应当 “rely on off-chain computations
and maintain an off-chain mapping”，并建议 “Consider using a subgraph to index these events”；同一份文档还说
“Iterating over all accounts and checking the CF and LT for every account is extremely inefficient”。

Venus 确有官方子图（Core Pool BNB Chain = `7h65Zf3pXXPmf8g8yZjjj2bqYiypVxems5d8riLK1DyR`），**但 Venus 在同一页写着**：
“Do not use subgraph output alone for transaction safety, balances, permissions, prices, pause state, or
liquidation decisions.” 这正好说明本示例为什么走"块锚定 `eth_call` + 外部 watchlist"而不是"子图"。
`api.venus.io`（OpenAPI 在 `https://api.venus.io/docs/swagger.json`）只有 markets / pools / governance，**没有
positions-at-risk 端点**。

→ 因此地址来源只能是**调用方传入的数组**，或启动时配置的 watchlist（`WATCHLIST` 环境变量 / `watchlist.json`）。
仓库里的 `watchlist.json` 装了两个 2026-09-20 从主网 `Borrow` / `RepayBorrow` 日志里取到的**真实借款人地址**，
只是为了让 `atRisk` 开箱即可 curl；生产环境请换成你自己的索引器输出。

## 三步跑起来

```sh
# 1) 在 tapeapi/ 根目录装一次依赖
npm install --no-audit --no-fund

# 2) 起服务（收费方法在本地调试时用 FREE_ALL=1 打开）
FREE_ALL=1 node examples/defi-lending-health/index.mjs      # :8792

# 3) 免费方法直接 curl
curl -s -X POST http://127.0.0.1:8792/tapeapi/v1/liquidationParams \
  -H 'content-type: application/json' -d '{"id":"lp-1","params":{}}' | jq '.result.markets[0]'
```

## 方法表

| 方法 | 计费 | quorum | 说明 |
|---|---|---|---|
| `accountHealth` | 0.0002 BEM | **`[quorum]`** | 单地址，锚定块 |
| `accountsHealth` | 0.001 BEM | **`[quorum]`** | 最多 50 个地址，同一个锚定块 |
| `atRisk` | 0.001 BEM | **`[quorum]`** | 按 `maxHealthFactor` 阈值筛 watchlist |
| `liquidationParams` | 免费 | **`[quorum]`** | 协议层参数：closeFactor、每个市场的 CF / LT / 清算激励 / 价格 |
| `accountHealthLatest` | 免费 | **`[no-quorum]`** | 在 `head − BLOCK_LAG` 上求值，给机器人用 |

`[quorum]` 方法都接受显式 `block`，并且**结果里一定有 `blockPinned: { blockNumber, blockHash, blockRef }`**
（TAPI-23 §3.4）。做法定人数时：先向任一家要一次，从 `blockPinned.blockNumber` 取块号，再把**同一个数字块号**
显式发给每一家。

**不要把 `accountHealthLatest` 放进 `callQuorum`，它必然 `QUORUM_FAILED`。** 两家提供者各自钉自己的
`head − BLOCK_LAG`，块号几乎不可能相同，块不同 → 结果天然不同 → 逐字节比较必定失败。这是设计如此，不是 bug。

## 健康因子的定义（Venus 链上没有，这是**本服务**的定义）

实测 `healthFactor(address)` 与 `getHealthFactor(address)` 在 Venus Core Comptroller 上都返回
`Diamond: Function does not exist`，Venus 全部文档页里也搜不到 “health factor” 一词。链上只给
`liquidity` / `shortfall`（USD，1e18 标度）。本服务发布的定义是：

```
weightedCollateralUsd = Σ_i  ( vTokenBalance_i · exchangeRateMantissa_i / 1e18 )
                             · getUnderlyingPrice(vToken_i) / 1e18
                             · liquidationThresholdMantissa_i / 1e18
borrowUsd             = Σ_i  borrowBalance_i · getUnderlyingPrice(vToken_i) / 1e18
healthFactor          = borrowUsd == 0 ? null : weightedCollateralUsd / borrowUsd
```

- `i` 取 `getAssetsIn(account)` 返回的市场，**按该数组原序**，不排序、不去重。
- 全程 BigInt，禁止浮点。`healthFactor` 输出 **18 位定点十进制字符串，向零截断，位数固定**
  （`0.333333333333333333`，不是 `…334`；`2.000000000000000000`，不是 `2`）。
  > 注意：这里**没有**用 SDK 的 `formatUnits`。`formatUnits` 会剥掉末尾的 0（`formatUnits(2e18, 18) === "2"`），
  > 而跨提供者逐字节比较要求位数固定。定宽实现在 `examples/_lib/codec.mjs` 的 `fixed()` / `fixedDiv()`。
- `borrowUsd == 0` → `healthFactor: null`、`liquidatable: false`。
- **`liquidatable` 不用 `healthFactor` 判**，用链上 `getAccountLiquidity(account)` 的 `shortfall > 0`。
  两者理论上同号；不同号时结果里会多一个 `note` 字段（固定字符串常量，不含时间戳），说明通常是利息 accrue 的时点差异。

标度推导：`getUnderlyingPrice` 按 Compound 惯例返回 `1e(36 − underlyingDecimals)`，余额是 `1e(underlyingDecimals)`，
乘积 `1e36`，除一次 `1e18` 就落在 `1e18` 标度的 USD 上 —— 与链上 `getAccountLiquidity` 的标度一致。
**实测对得上**：`0xeba4b3c4…411e` 在块 123017618 上 `weightedCollateralUsd − borrowUsd = 259350.441890946886717768 −
187966.859819575339168629 = 71383.582071371547549139`，而链上 `getAccountLiquidity` 返回
`71383.582071371547585804` —— 差别只来自逐市场截断的顺序。

## Venus Core 不是 Compound V2 原版：四个会咬人的差异（全部实测）

1. **`liquidationIncentiveMantissa()` 在 Comptroller 上已不存在。** 实测 `eth_call` 返回
   `execution reverted: Diamond: Function does not exist`（`ComptrollerStorage.sol` 里它已变成
   `uint256 private _oldLiquidationIncentiveMantissa; // (deprecated)`）。清算激励现在是**按市场**的，
   从 `markets(vToken)` 的第 5 个返回值取，也可用 `getLiquidationIncentive(address vToken)`（实测 vBNB = `1.1e18`）
   或 `getEffectiveLiquidationIncentive(address borrower, address vTokenCollateral)`。`ComptrollerLens` 的 seize
   计算用的是第三个，**按抵押市场取，不是按债务市场**。
2. **`markets(address)` 返回 7 个值，不是 Compound 的 3 个**：
   `(bool isListed, uint256 collateralFactorMantissa, bool isVenus, uint256 liquidationThresholdMantissa,
   uint256 liquidationIncentiveMantissa, uint96 poolId, bool isBorrowAllowed)`。
3. **`getAccountLiquidity` 与 `getBorrowingPower` 用的是不同的权重，不可互换。**
   `getAccountLiquidity` → `WeightFunction.USE_LIQUIDATION_THRESHOLD`（判"是否可清算"，`shortfall > 0` 即可清算）；
   `getBorrowingPower` → `WeightFunction.USE_COLLATERAL_FACTOR`（判"还能不能再借"）。
   而 **`getHypotheticalAccountLiquidity(account, vTokenModify, redeemTokens, borrowAmount)` 内部用的是
   `USE_COLLATERAL_FACTOR`** —— 它回答"再借/再赎回会不会被拒"，**不是**"会不会被清算"。拿它判清算是个经典的坑。
   实测差异：`0xeba4b3c4…411e` 的 `getAccountLiquidity` = 71245.14 USD，`getBorrowingPower` = 69862.76 USD。
4. **CF ≠ LT 在 Core Pool 里是真实存在的，而 Venus 自己的文档在这一点上是过时的。**
   docs-v4.venus.io/guides/liquidation 写着 “In the Core Pool this is the same as the collateral factor”，
   但实测至少这些市场不成立：

   | 市场 | collateralFactor | liquidationThreshold |
   |---|---|---|
   | vXVS | 0.4500 | 0.6000 |
   | vCAKE | 0.5000 | 0.5500 |
   | vDOGE | 0.0000 | 0.4300 |
   | vFDUSD | 0.6500 | 0.7500 |
   | vTSLAB | 0.6000 | 0.7000 |
   | vBNB / vUSDT / vBTC / vETH | 0.8000 | 0.8000 |

   按文档用 CF 写的机器人会**漏掉**这些市场里的可清算账户。本服务的健康因子一律用 LT。

另外四条实测补充：

- **`minLiquidatableCollateral()` 在 Core Comptroller 上也不存在。** 规范 §1.3 说 `liquidationParams` 应当一并
  返回它，但实测 `eth_call` 返回 `execution reverted: Diamond: Function does not exist` —— 它是
  **Isolated Pools** 的 Comptroller 函数，不在 Core 上。本服务因此不返回该字段（不是遗漏）。
- **`deployments` 文件里有的地址不一定 listed。** `vLUNA = 0xb91A659E…D2c8` 的 `markets().isListed == false`；
  `vBUSD = 0x95c78222…Ab9D` 是 `isListed == true` 但 `collateralFactor == 0` 且 `isBorrowAllowed == false`。
  本服务对入参 vToken 一律先查 `markets().isListed`，不信地址表。
- **VBep20 delegator 市场的 returndata 会多出两个尾部零字**（实测 vUSDT 的 `getAccountSnapshot` 返回 6 个字、
  vBNB 返回 4 个）。本示例按偏移正向读、不校验总长，所以不受影响；`health.test.mjs` 里有一条回归用例。
  任何严格解码器会在这里抛错。
- **vBNB 没有 `underlying()`**（原生 BNB），实测返回空 returndata。因为 `allowFailure` 一律传 `false`，
  它**不会**被放进 Multicall3 批里，而是特判成 `underlying: null`。

## 为什么必须用 Multicall3（这是个时序问题，不是性能问题）

50 个地址 × 平均 4 个市场 × 4 次调用 ≈ **800 次 `eth_call`**；公共 dataseed 限额 10K/5min ≈ 33 req/s，
800 次 ≈ **24 秒**。

真正的约束是**墙钟**，不是区块数。**实测（2026-09-20，`bsc-dataseed`）：同一个块在约 1 分钟时还能读到状态，
到约 3 分钟就返回 `missing trie node`。** 公共 dataseed 的状态保留窗口是**分钟级**，不是"geth 默认 128 个区块"
那句流传甚广的说法（128 个区块在 0.45 s 出块下只有 58 秒，两个数都远小于人们的直觉）。
所以：只要调用方按 TAPI-23 §3.4 第 2 步传一个稍早的显式 `block`（法定人数轮 **MUST** 这么做），一次 24 秒的
串行扫描就有相当一部分落在窗口边缘 —— **同一次请求里的不同市场会来自不同的状态，签名的结果不再对应它声称的
区块**。批量把这压到 2–3 次调用、墙钟百毫秒级，时序问题消失。
同样的理由：法定人数轮把显式块号扇出给各家时要**尽快**，晚到的那家会直接失败，而不是给出不同的答案。

`allowFailure` 一律传 **`false`**：部分失败会让结果依赖"哪几个成功了"，破坏确定性。
SDK 的 `decodeParams` 不支持结构体动态数组，所以 `Call3[]` 的编解码手写在 `examples/_lib/codec.mjs`
（`encodeAggregate3` / `decodeAggregate3`），SDK 补齐数组支持后应换回 SDK。

**历史块需要归档 RPC。** 节点在该块上没有状态时（典型表现 `missing trie node` / `header not found`），本服务返回
`INTERNAL`，message `state unavailable at block <n> …`。公共 dataseed 不保证任何保留窗口。

## 延迟与适用性

锚定块默认 `finalized`。**对竞速清算太慢** —— 那条赛道是毫秒级的（arXiv:2606.03434：39% 的成功清算是抢跑预言机
更新的投机型交易）。本服务的定位是**监控 / 风控 / 前端**。要抢跑就用 `accountHealthLatest`，代价是它不可 quorum。

## curl

```sh
# 1) 协议参数（免费）
curl -s -X POST http://127.0.0.1:8792/tapeapi/v1/liquidationParams \
  -H 'content-type: application/json' \
  -d '{"id":"lp-1","params":{"vTokens":["0xfD5840Cd36d94D7229439859C0112a4185BC0255","0xA07c5b74C9B40447a954e1466938b865b6BBea36"]}}' | jq .

# 实测返回（数值随块变化，形状固定）：
# {"id":"lp-1","ok":true,"result":{
#   "comptroller":"0xfD36E2c2a6789Db23113685031d7F16329158384",
#   "oracle":"0x6592b5DE802159F3E74B2486b091D11a8256ab8A",
#   "closeFactorMantissa":"500000000000000000",
#   "markets":[{"vToken":"0xfD5840Cd36d94D7229439859C0112a4185BC0255","symbol":"vUSDT",
#               "underlying":"0x55d398326f99059fF775485246999027B3197955","underlyingDecimals":18,
#               "isListed":true,"isBorrowAllowed":true,
#               "collateralFactorMantissa":"800000000000000000",
#               "liquidationThresholdMantissa":"800000000000000000",
#               "liquidationIncentiveMantissa":"1100000000000000000",
#               "priceMantissa":"999640000000000000","priceUsd":"0.999640000000000000"}, …],
#   "blockPinned":{"blockNumber":123017580,"blockHash":"0x259b1e02…5f49","blockRef":"hash"}},
#  "container":"0x…","ts":…,"block":…,"sig":"0x…"}

# 2) 单地址健康度（收费方法；本地用 FREE_ALL=1 启动）
curl -s -X POST http://127.0.0.1:8792/tapeapi/v1/accountHealth \
  -H 'content-type: application/json' \
  -d '{"id":"ah-1","params":{"account":"0xeba4b3c462b9c16f7ccaf4be6f4d3c17c377411e"}}' \
  | jq '.result | {healthFactor, liquidatable, borrowUsd, weightedCollateralUsd, blockPinned}'
# {"healthFactor":"1.379766849006739020","liquidatable":false,
#  "borrowUsd":"187966.859819575339168629","weightedCollateralUsd":"259350.441890946886717768",
#  "blockPinned":{"blockNumber":123017618,"blockHash":"0x079606f7…81ad","blockRef":"hash"}}

# 3) watchlist 扫描
curl -s -X POST http://127.0.0.1:8792/tapeapi/v1/atRisk \
  -H 'content-type: application/json' \
  -d '{"id":"ar-1","params":{"maxHealthFactor":"1.05"}}' | jq '{n: (.result.atRisk|length), scanned: .result.scanned}'
```

## 跨两家提供者的 `callQuorum`（TAPI-23 §3.4）

```js
import { createTapeAPI, TapeAPIError } from '../../sdk/src/index.js'

const api = createTapeAPI({ dev: true })   // 主网 / mainnet: { rpcUrls:[≥2], quorum:2, directory, escrow }
const [a, b] = await Promise.all([
  api.resolve({ dev: 'http://127.0.0.1:8792' }),
  api.resolve({ dev: 'http://127.0.0.1:8802' }),   // 第二家一律取主端口 + 10 / the second instance is always +10
])

// 第 1 步（TAPI-23 §3.5）：持有人不同 **且** 端点 origin 不同，才算两个独立来源。SDK 不替你做这个检查。
const origin = (s) => new URL(s.manifest.endpoints.live[0]).origin
if (a.verified.holder === b.verified.holder || origin(a) === origin(b)) throw new Error('providers are not independent')

const account = '0xeba4b3c462b9c16f7ccaf4be6f4d3c17c377411e'
// 第 2 步：先向任一家要一次，只为拿块号（这一次的结果不用来渲染）
const first = await api.call(a, 'accountHealth', { account })
const block = first.result.blockPinned.blockNumber

// 第 3–5 步：同一个显式块号发给两家，各自验签，逐字节一致才采用；**任何分歧即拒绝，不做多数表决**
try {
  const q = await api.callQuorum([a, b], 'accountHealth', { account, block }, { quorum: 2 })
  console.log(q.result.healthFactor, q.result.liquidatable, 'agreed by', q.agreed)
} catch (e) {
  if (e instanceof TapeAPIError && e.code === 'QUORUM_FAILED') {
    console.warn('disagreed:', e.data?.disagreed, 'groups:', e.data?.groups, 'failed:', e.data?.failed)
  } else throw e
}
```

**这里不要用 `opts.compare` 的数值容差。** 容差是给**跨源派生数值**（不同池的 TWAP 价格）准备的；
`accountHealth` 是同一区块上同一次 `eth_call` 的确定性结果，两家**必须**逐字节相同，容差只会掩盖真正的分歧。
容差的正确用法见 `examples/defi-twap-oracle/README.md` 与 `examples/consumer-snippets.md` §4。

## 从 dev 到主网

| | dev（默认） | 主网 |
|---|---|---|
| `manifest.dev` | `true` | `false`（设了 `DELEGATION_SIG` + `DELEGATION_EXPIRES` 自动切换） |
| `delegation` | `null` | 持有人签的委托；此时**必须**同时设 `SIGNER_KEY`，否则拒绝启动 |
| `container` / `circuits` / `tokenId` | 占位零地址 | `CONTAINER` / `CIRCUITS` / `TOKEN_ID` |
| `payment.escrow` | 占位零地址 | `ESCROW`（真实 TapeAPIEscrow） |
| 端点 | `http://127.0.0.1:8792` | `PUBLIC_URL`（**https**，清单校验会拒绝非 dev 的 http） |
| 计费 | `FREE_ALL=1` 全免费 | 去掉 `FREE_ALL`，按 `priceBEM` 收 voucher |
| RPC | 三个公共 dataseed，`QUORUM=2` | 自己的节点或付费 RPC；要服务历史块必须是**归档**节点 |

## 什么时候不要用这个 / When not to use this

**不要把它当借贷协议的主价格喂价或主清算判据。** 理由不是"一个签名不够"，而是更硬的四条：


1. **TAPI-23 的法定人数规则是客户端规则，而清算逻辑在链上。** “≥2 家独立提供者逐字节一致，任何分歧即拒绝”
   是写给 JS / 后端调用方的。`Comptroller.liquidateBorrowAllowed` 里没有 `callQuorum`。
2. **没有经济担保。** TAPI-23 §3.6 把 stake / slash 明确留给未来的 TAP，并要求 *“clients MUST NOT assume any
   provider is staked”*。一个签了错数的提供者今天损失的上限是声誉，对面站着的是一次几百万美元的清算激励。
3. **连 Chainlink 都不承担这个责任。** docs.chain.link/data-feeds/selecting-data-feeds 原话：
   *“Ultimately you are responsible for identifying and assessing the accuracy, availability, and quality of
   data that you choose to consume via the Chainlink Network.”* 以及 *“Users of single-source feeds MUST
   implement additional safeguards such as value bounds, caps, circuit breakers, freshness checks, fallback
   behavior, monitoring against independent references where available, and manual pause or kill-switch
   controls.”* —— **一个 TapeAPI 提供者就是一个 single-source feed。** 两家一致把它变成 two-source，
   但仍然不是一个有质押的预言机网络。
4. **责任在链上没有承受者。** 风险供应商合同是年费 + 法律实体 + 治理问责；TapeAPI 的提供者是一个电路持有人和一把密钥。

具体地，**不要**用它做：竞速清算或任何毫秒级路径（本服务默认钉 `finalized`）；枚举全网可清算仓位（做不到，见上）；
Isolated Pools（本示例只实现 Core Pool；Isolated Pools 的 CF/LT 语义不同，Venus 原话：
“Relying on `getBorrowingPower` is not sufficient for identifying accounts in need of liquidation on Isolated Pools”）；
任何"取多数"或"取平均"的聚合（分歧就该拒绝，失败模式必须是拒绝服务，永远不是错误答案）。

**可以**用它做：清算 / 风控机器人的**监控通道**，借贷前端的**可归属数据源**（用户能看到这个健康因子属于哪个区块、
由哪两家独立提供者签过名），以及一个**独立参照 / 熔断锚** —— 这正是 Chainlink 自己要求 single-source 使用者做的
*“monitoring against independent references”*。

## 主网地址（全部实测核实）

| 名称 | 地址 |
|---|---|
| Unitroller（Core Pool Comptroller，EIP-2535 Diamond） | `0xfD36E2c2a6789Db23113685031d7F16329158384` |
| ResilientOracle（`Unitroller.oracle()` 实测返回同一地址） | `0x6592b5DE802159F3E74B2486b091D11a8256ab8A` |
| BoundValidator | `0x6E332fF0bB52475304494E4AE5063c1051c7d735` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| vBNB（原生 BNB，无 `underlying()`） | `0xA07c5b74C9B40447a954e1466938b865b6BBea36` |
| vWBNB | `0x6bCa74586218dB34cdB402295796b79663d816e9` |
| vUSDT | `0xfD5840Cd36d94D7229439859C0112a4185BC0255` |
| vUSDC | `0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8` |
| vBTC | `0x882C173bC7Ff3b7786CA16dfeD3DFFfb9Ee7847B` |
| vETH | `0xf508fCD89b8bd15579dc79A6827cB4686A3592c8` |
| vCAKE | `0x86aC3974e2BD0d60825230fa6F355fF11409df5c` |

来源：docs-v4.venus.io/deployed-contracts/markets.md 与 oracles.md、
github.com/VenusProtocol/venus-protocol `deployments/bscmainnet_addresses.json`、github.com/mds1/multicall。
本服务不硬编码预言机地址 —— 它在每个锚定块上读 `Unitroller.oracle()`。

---

# defi-lending-health — Venus (BNB Chain Core Pool) position health

For a caller-supplied set of addresses, the health factor, the liquidatable flag, per-market detail and the
per-market repay cap — all at **one pinned block**. Plus a `latest` fast path for bots. Every read goes through
Multicall3, is evaluated at the attested `blockHash` (EIP-1898), and comes back in a signed envelope.

Who it is for: the **monitoring** channel of a liquidation bot (not the racing channel), risk dashboards, and
lending front-ends that want an attributable data source.

## What it cannot do (first things first)

**This service cannot list every liquidatable position on the network.** Plain `eth_call` cannot enumerate
borrowers — that needs indexing `Borrow` / `Mint` / `MarketEntered` events, and the official BNB Chain public
endpoints **explicitly disable `eth_getLogs`** (docs.bnbchain.org, JSON-RPC endpoint page: “eth_getLogs is
disabled on below Mainnet endpoints”, rate limit 10K/5min).

Venus's own documentation says the same (docs-v4.venus.io/guides/liquidation): liquidators should “rely on
off-chain computations and maintain an off-chain mapping”, and “Consider using a subgraph to index these
events”; the same page notes that “Iterating over all accounts and checking the CF and LT for every account is
extremely inefficient”.

Venus does publish subgraphs, **but the same page also says**: “Do not use subgraph output alone for
transaction safety, balances, permissions, prices, pause state, or liquidation decisions.” That is precisely
why this example takes the block-pinned `eth_call` + external watchlist route rather than the subgraph route.
`api.venus.io` has markets / pools / governance endpoints and **no positions-at-risk endpoint**.

→ So addresses come only from the caller, or from a watchlist configured at start-up (`WATCHLIST` env var or
`watchlist.json`). The `watchlist.json` in this directory holds two **real** Venus Core Pool borrowers
harvested from mainnet `Borrow` / `RepayBorrow` logs on 2026-09-20, purely so that `atRisk` is curl-able out of
the box. Replace it with your own indexer's output in production.

## Three steps

```sh
npm install --no-audit --no-fund                            # once, from the tapeapi/ root
FREE_ALL=1 node examples/defi-lending-health/index.mjs      # :8792
curl -s -X POST http://127.0.0.1:8792/tapeapi/v1/liquidationParams \
  -H 'content-type: application/json' -d '{"id":"lp-1","params":{}}' | jq '.result.markets[0]'
```

## Methods

| method | price | quorum | what |
|---|---|---|---|
| `accountHealth` | 0.0002 BEM | **`[quorum]`** | one account at a pinned block |
| `accountsHealth` | 0.001 BEM | **`[quorum]`** | up to 50 accounts, one pinned block |
| `atRisk` | 0.001 BEM | **`[quorum]`** | filter a watchlist by `maxHealthFactor` |
| `liquidationParams` | free | **`[quorum]`** | protocol parameters: closeFactor, per-market CF / LT / incentive / price |
| `accountHealthLatest` | free | **`[no-quorum]`** | evaluated at `head − BLOCK_LAG`, for bots |

Every `[quorum]` method accepts an explicit `block` and **always returns `blockPinned: { blockNumber,
blockHash, blockRef }`** (TAPI-23 §3.4). To run a quorum: ask one provider first, take
`blockPinned.blockNumber`, then send that **explicit number** to every provider.

**Do not put `accountHealthLatest` in `callQuorum`; it will always `QUORUM_FAILED`.** Two providers each pin
their own `head − BLOCK_LAG`, the block numbers will essentially never match, different blocks mean different
results, and byte-for-byte comparison then has to fail. That is by design, not a bug.

## The health-factor definition (Venus has none on-chain; this is **ours**)

Measured: both `healthFactor(address)` and `getHealthFactor(address)` revert with `Diamond: Function does not
exist` on the Venus Core Comptroller, and the phrase “health factor” appears nowhere in Venus's docs. The chain
gives only `liquidity` / `shortfall` (USD at 1e18). This service publishes:

```
weightedCollateralUsd = Σ_i  ( vTokenBalance_i · exchangeRateMantissa_i / 1e18 )
                             · getUnderlyingPrice(vToken_i) / 1e18
                             · liquidationThresholdMantissa_i / 1e18
borrowUsd             = Σ_i  borrowBalance_i · getUnderlyingPrice(vToken_i) / 1e18
healthFactor          = borrowUsd == 0 ? null : weightedCollateralUsd / borrowUsd
```

- `i` ranges over `getAssetsIn(account)` **in that array's order** — never sorted, never deduplicated.
- BigInt throughout, no floating point. `healthFactor` is an **18-place fixed-width decimal string, truncated
  toward zero** (`0.333333333333333333`, never `…334`; `2.000000000000000000`, never `2`).
  > Note this does **not** use the SDK's `formatUnits`, which strips trailing zeros
  > (`formatUnits(2e18, 18) === "2"`) — byte-for-byte quorum comparison needs a fixed width. The fixed-width
  > helpers are `fixed()` / `fixedDiv()` in `examples/_lib/codec.mjs`.
- `borrowUsd == 0` → `healthFactor: null`, `liquidatable: false`.
- **`liquidatable` is not derived from `healthFactor`**; it is the chain's own `getAccountLiquidity(account)`
  with `shortfall > 0`. The two should agree in sign; when they do not, the result carries a `note` (a fixed
  string constant, never a timestamp) explaining that interest-accrual snapshots differ within a block.

Scale: `getUnderlyingPrice` returns `1e(36 − underlyingDecimals)` by the Compound convention and balances are
`1e(underlyingDecimals)`, so the product is `1e36` and one division by `1e18` lands on the same `1e18` USD scale
the chain itself uses. **Verified against the chain**: at block 123017618, `0xeba4b3c4…411e` gives
`259350.441890946886717768 − 187966.859819575339168629 = 71383.582071371547549139` while the chain's
`getAccountLiquidity` returns `71383.582071371547585804` — the difference is only per-market truncation order.

## Venus Core is not stock Compound V2: four differences that bite (all measured)

1. **`liquidationIncentiveMantissa()` no longer exists on the Comptroller.** `eth_call` returns
   `execution reverted: Diamond: Function does not exist` (in `ComptrollerStorage.sol` it is now
   `uint256 private _oldLiquidationIncentiveMantissa; // (deprecated)`). The incentive is **per market** now:
   read it from `markets(vToken)`'s fifth return value, or via `getLiquidationIncentive(address vToken)`
   (measured 1.1e18 for vBNB) or `getEffectiveLiquidationIncentive(address borrower, address vTokenCollateral)`.
   `ComptrollerLens`'s seize calculation uses the third, keyed on the **collateral** market, not the debt market.
2. **`markets(address)` returns seven values, not Compound's three**: `(bool isListed, uint256
   collateralFactorMantissa, bool isVenus, uint256 liquidationThresholdMantissa, uint256
   liquidationIncentiveMantissa, uint96 poolId, bool isBorrowAllowed)`.
3. **`getAccountLiquidity` and `getBorrowingPower` use different weights and are not interchangeable.**
   `getAccountLiquidity` → `WeightFunction.USE_LIQUIDATION_THRESHOLD` (answers “is this liquidatable?”,
   `shortfall > 0`); `getBorrowingPower` → `WeightFunction.USE_COLLATERAL_FACTOR` (answers “can this borrow
   more?”). And **`getHypotheticalAccountLiquidity(account, vTokenModify, redeemTokens, borrowAmount)` uses
   `USE_COLLATERAL_FACTOR` internally** — it answers “would another borrow or redeem be rejected?”, **not**
   “would this be liquidated?”. Using it for liquidation decisions is a classic trap. Measured on
   `0xeba4b3c4…411e`: `getAccountLiquidity` = 71245.14 USD, `getBorrowingPower` = 69862.76 USD.
4. **CF ≠ LT really happens in the Core Pool, and Venus's own documentation is out of date here.**
   docs-v4.venus.io/guides/liquidation says “In the Core Pool this is the same as the collateral factor”, but
   measured, at least these markets disagree:

   | market | collateralFactor | liquidationThreshold |
   |---|---|---|
   | vXVS | 0.4500 | 0.6000 |
   | vCAKE | 0.5000 | 0.5500 |
   | vDOGE | 0.0000 | 0.4300 |
   | vFDUSD | 0.6500 | 0.7500 |
   | vTSLAB | 0.6000 | 0.7000 |
   | vBNB / vUSDT / vBTC / vETH | 0.8000 | 0.8000 |

   A bot written from the docs with CF **misses** liquidatable accounts in those markets. This service always
   uses LT.

Four more measured notes:

- **`minLiquidatableCollateral()` does not exist on the Core Comptroller either.** The spec says
  `liquidationParams` should return it, but `eth_call` gives `execution reverted: Diamond: Function does not
  exist` — it is an **Isolated Pools** Comptroller function, not a Core one. This service therefore omits the
  field deliberately, not by oversight.
- **An address being in `deployments` does not mean it is listed.** `vLUNA = 0xb91A659E…D2c8` has
  `markets().isListed == false`; `vBUSD = 0x95c78222…Ab9D` is listed but has `collateralFactor == 0` and
  `isBorrowAllowed == false`. Every vToken argument is checked against `markets().isListed` first.
- **VBep20 delegator markets return two extra trailing zero words** (measured: vUSDT's `getAccountSnapshot`
  returns 6 words, vBNB's 4). This example reads forward by offset without checking total length, so it is
  unaffected; `health.test.mjs` has a regression case. A strict decoder would throw here.
- **vBNB has no `underlying()`** (its underlying is native BNB) and returns empty data. Since `allowFailure` is
  always `false`, that call is never put in a Multicall3 batch; it is special-cased to `underlying: null`.

## Why Multicall3 is mandatory (a timing problem, not a performance one)

50 accounts × ~4 markets × 4 calls ≈ **800 `eth_call`s**. The public dataseed limit of 10K/5min ≈ 33 req/s makes
that ≈ **24 seconds**.

The binding constraint is **wall-clock, not block count**. **Measured (2026-09-20, `bsc-dataseed`): a block's
state still read fine at ~1 minute old and returned `missing trie node` at ~3 minutes old.** The public
dataseeds' retention window is a matter of **minutes** — not the widely repeated “geth keeps ~128 blocks”
(which at 0.45 s blocks would be 58 seconds anyway; both numbers are far smaller than intuition suggests).
So as soon as the caller passes a slightly older explicit `block` — which TAPI-23 §3.4 step 2 says a quorum
round **MUST** do — a good part of a 24-second serial scan lands on the edge of that window, and **different
markets in one request would come from different states while the signed result claims a single block**.
Batching collapses this to 2–3 calls and a few hundred milliseconds, and the problem disappears.
The same reasoning applies to fanning an explicit block number out to several providers: do it **promptly**,
or a late provider fails outright rather than disagreeing.

`allowFailure` is always **`false`**: partial failure would make the result depend on which calls happened to
succeed. The SDK's `decodeParams` has no struct-array support, so the `Call3[]` codec is hand-written in
`examples/_lib/codec.mjs` (`encodeAggregate3` / `decodeAggregate3`); swap back to the SDK once it gains array
support.

**Historical blocks need an archive RPC.** When a node has no state at the pinned block (typically
`missing trie node` / `header not found`), this service returns `INTERNAL` with
`state unavailable at block <n> …`. The public dataseeds guarantee no retention window.

## Latency and fit

The pinned block defaults to `finalized`. That is **far too slow for racing liquidations** — that lane is
measured in milliseconds (arXiv:2606.03434: 39% of successful liquidations are speculative front-runs of oracle
updates). This service is positioned for **monitoring / risk / front-ends**. To race, use
`accountHealthLatest` — and accept that it cannot be run through a quorum.

## curl

See the Chinese section above; the same three commands, with real captured output.

## Two-provider `callQuorum` (TAPI-23 §3.4)

See the JavaScript snippet in the Chinese section. The important parts: (1) check independence yourself —
different `verified.holder` **and** different endpoint origin — because the SDK's `callQuorum` does not;
(2) pin the block once and pass the explicit number to everyone; (3) reject on any disagreement, never take a
majority vote.

**Do not use `opts.compare`'s numeric tolerance here.** Tolerance exists for **derived cross-source numbers**
(TWAP prices from different pools); `accountHealth` is the deterministic result of the same `eth_call` at the
same block, so two providers **must** match byte for byte and a tolerance would only mask a real disagreement.
The correct use of tolerance is in `examples/defi-twap-oracle/README.md` and `examples/consumer-snippets.md` §4.

## dev → mainnet

| | dev (default) | mainnet |
|---|---|---|
| `manifest.dev` | `true` | `false` (flips automatically when `DELEGATION_SIG` + `DELEGATION_EXPIRES` are set) |
| `delegation` | `null` | holder-signed delegation; `SIGNER_KEY` then becomes **mandatory** or the example refuses to start |
| `container` / `circuits` / `tokenId` | placeholder zeros | `CONTAINER` / `CIRCUITS` / `TOKEN_ID` |
| `payment.escrow` | placeholder zero | `ESCROW` (the real TapeAPIEscrow) |
| endpoint | `http://127.0.0.1:8792` | `PUBLIC_URL` (**https**; manifest validation rejects http outside dev) |
| pricing | `FREE_ALL=1` makes everything free | drop `FREE_ALL`; vouchers are charged per `priceBEM` |
| RPC | three public dataseeds, `QUORUM=2` | your own or a paid RPC; serving historical blocks needs an **archive** node |

## When not to use this

**Do not use this as a lending protocol's primary price feed or primary liquidation criterion.** The reason is
not “one signature isn't enough”; it is four harder things:

1. **TAPI-23's quorum rule is a client-side rule while liquidation logic lives on-chain.** “≥2 independent
   providers, byte-identical, reject on any disagreement” is a rule for JS and backend callers.
   `Comptroller.liquidateBorrowAllowed` contains no `callQuorum`.
2. **There is no economic guarantee.** TAPI-23 §3.6 defers stake and slashing to a future TAP and requires that
   *“clients MUST NOT assume any provider is staked”*. A provider that signs a wrong number risks its
   reputation; across the table sits a liquidation incentive worth millions.
3. **Even Chainlink does not accept this responsibility.** docs.chain.link/data-feeds/selecting-data-feeds:
   *“Ultimately you are responsible for identifying and assessing the accuracy, availability, and quality of
   data that you choose to consume via the Chainlink Network.”* and *“Users of single-source feeds MUST
   implement additional safeguards such as value bounds, caps, circuit breakers, freshness checks, fallback
   behavior, monitoring against independent references where available, and manual pause or kill-switch
   controls.”* — **a single TapeAPI provider is a single-source feed.** Two agreeing providers make it
   two-source; it is still not a staked oracle network.
4. **Nobody on-chain carries the liability.** Risk-vendor contracts are annual fees plus a legal entity plus
   governance accountability; a TapeAPI provider is a circuit holder and a key.

Concretely, **do not** use it for: racing liquidations or any millisecond path (this service pins `finalized`
by default); enumerating every liquidatable position (it cannot — see above); Isolated Pools (only the Core
Pool is implemented; Isolated Pools weight differently, and Venus states “Relying on `getBorrowingPower` is not
sufficient for identifying accounts in need of liquidation on Isolated Pools”); or any aggregation that takes a
majority or an average (disagreement must be a refusal — the failure mode has to be denial of service, never a
wrong answer).

**Do** use it for: the **monitoring** channel of a liquidation or risk bot; an **attributable data source** for
a lending front-end (the user can see which block a health factor belongs to and which two independent
providers signed it); and an **independent reference / circuit-breaker anchor** — which is exactly the
*“monitoring against independent references”* Chainlink itself asks single-source consumers to implement.
