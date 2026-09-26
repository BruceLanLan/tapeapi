# defi-twap-oracle — PancakeSwap V3 `observe()` TWAP + 现价 + 偏离标志

在一个锚定区块上读 PancakeSwap V3 池的**算术平均 tick**（`observe(uint32[])`）与**现价 tick**（`slot0()`），
返回两者的价格、实际偏离基点数和一个 `deviates` 标志。按 `blockHash`（EIP-1898）求值、签名返回。

给谁用：需要抗操纵价格的协议 —— 抵押品估值、熔断锚、"主喂价偏离超过 X bps 就暂停"的独立参照。

## 三步跑起来

```sh
npm install --no-audit --no-fund                          # 在 tapeapi/ 根目录装一次
FREE_ALL=1 node examples/defi-twap-oracle/index.mjs       # :8793
curl -s -X POST http://127.0.0.1:8793/tapeapi/v1/bnbUsdTwap \
  -H 'content-type: application/json' -d '{"id":"tw-1","params":{"window":1800}}' | jq '.result'
```

## 方法表

| 方法 | 计费 | quorum | 说明 |
|---|---|---|---|
| `twap` | 0.0002 BEM | **`[quorum]`** | 任意 V3 池的 TWAP + 现价 + 偏离标志 |
| `bnbUsdTwap` | 免费 | **`[quorum]`** | 默认池的 BNB/USDT，1800 s 窗口；形状做小，便于容差比较 |
| `poolFor` | 免费 | **`[quorum]`** | `PancakeV3Factory.getPool` + `slot0` 摘要 |

三个方法都接受显式 `block`，并且**结果里一定有 `blockPinned: { blockNumber, blockHash, blockRef }`**
（TAP-23 §3.4）。本示例没有 `[no-quorum]` 方法。做法定人数时：先向任一家要一次，从
`blockPinned.blockNumber` 取块号，再把**同一个数字块号**显式发给每一家 —— 不这么做的话每家各自钉自己的
`finalized`，块不同 → 结果天然不同 → 必然 `QUORUM_FAILED`。

## 默认池与方向陷阱

**默认池 `0x172fcD41E0913e95784454622d1c3724f546f849`（WBNB/USDT，fee 100）** —— 流动性最深、
observation cardinality 4500 最大。

> **`token0 = USDT`、`token1 = WBNB`**，不是直觉顺序。本示例的方向**永远运行时用 `token0()` / `token1()` 判断**，
> 不硬编码；`base` / `quote` 不传时默认 `base = token1`、`quote = token0`。

四个费率档的 WBNB/USDT 池都存在（实测 `getPool` 取得）：

| fee | pool | tickSpacing |
|---|---|---|
| 100 | `0x172fcD41E0913e95784454622d1c3724f546f849` | 1 |
| 500 | `0x36696169C63e42cd08ce11f5deeBbCeBae652050` | 10 |
| 2500 | `0x1401ff943D08a7E098328C1d3a9d388923B115D2` | 50 |
| 10000 | `0x6805E0E5333c5c3acCF2930Be4734E2b98f4Ce06` | 200 |

费率档与 tickSpacing 是 `PancakeV3Factory` 构造函数里硬编码的 **100→1、500→10、2500→50、10000→200**，
**与 Uniswap V3 的 500/3000/10000 不同**。传 `fee: 3000` 会被拒。

### 禁止移植 Uniswap 的 CREATE2 地址推导

PancakeSwap 从**独立的 `PancakeV3PoolDeployer` `0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9`** 部署池，
init code hash 也不同（Pancake `0x6ce8eb47…f7e2`，Uniswap `0xe34f199b…b8b54`），而且
`PoolAddress.computeAddress` 的第一个参数是 **deployer 而不是 factory**。实测三种组合：

| 组合 | 结果 |
|---|---|
| `CREATE2(PoolDeployer, Pancake hash)` | `0x172fcD41…f849` ✅ 与 `getPool()` 一致 |
| `CREATE2(Factory, Pancake hash)` | `0xc993010016351c34301df2b20258db45474e297c` ❌ |
| `CREATE2(Factory, Uniswap hash)` | `0x24a713682845945c2558efdcee0f0dce6490d9dc` ❌ |

**错误推导会静默返回一个看起来很像地址的错地址**，然后你会在一个不存在的合约上读到空数据。
本服务一律调链上 `getPool()`（`poolFor` 方法），不做任何地址推导。

## TWAP 算法（照抄 Uniswap `OracleLibrary.consult`，一个字没改）

```solidity
int56 tickCumulativesDelta = tickCumulatives[1] - tickCumulatives[0];
arithmeticMeanTick = int24(tickCumulativesDelta / secondsAgo);
// Always round to negative infinity
if (tickCumulativesDelta < 0 && (tickCumulativesDelta % secondsAgo != 0)) arithmeticMeanTick--;
```

（github.com/Uniswap/v3-periphery `contracts/libraries/OracleLibrary.sol`）BigInt 等价实现在
`examples/_lib/codec.mjs` 的 `meanTickFromCumulatives`：BigInt 除法与 Solidity 一样向零截断，所以那条 `--`
必须保留，否则负 tick 会差一（`delta = -100, window = 3` → `-34` 而不是 `-33`）。

`secondsAgos = [window, 0]`，**顺序不能反**。

tick → 价格走 `TickMath.getSqrtRatioAtTick` 的 BigInt 逐位移植 + `OracleLibrary.getQuoteAtTick`。
BigInt 下没有 256 位溢出，`FullMath.mulDiv(a,b,d)` 直接写成 `(a*b)/d`，但**分支判断与
`baseToken < quoteToken` 的地址比较必须保留**，否则两家实现会在边界上分叉。两条分支与两种地址序在
`examples/_lib/codec.test.mjs` 里各有覆盖，并且有一条**链上交叉校验**：在锚定块上
`getSqrtRatioAtTick(slot0().tick) ≤ 链上 sqrtPriceX96 < getSqrtRatioAtTick(tick+1)`。
固定向量（`tick 0 → 2^96`、`MIN_TICK → 4295128739`、`MAX_TICK → 1461446703…342`）只能证明常量抄对了，
链上校验才能证明移植是对的。

**`meanTick`（整数）才是签名 result 的权威字段**，`tickCumulatives` 原值也一并返回；
`twapPrice` / `spotPrice` 是**派生的展示值**，固定 18 位、向零截断（用 `_lib/codec.mjs` 的 `fixed()`，
**不是** SDK 的 `formatUnits` —— 后者会剥掉末尾的 0，位数不固定就没法逐字节比较）。

## 为什么 TWAP 比现价强（量化部分）

现价 = 单区块末态。一笔闪电贷可以在**一个交易内**把它推到任意值再还回来，攻击成本 ≈ 手续费 + 滑点。
`window` 秒的算术平均 tick 要求攻击者**把价格维持 `window` 秒**，代价从"一次滑点"变成"持续 `window` 秒的持仓
＋ 每个区块被套利者反向吃掉的损失"。

BNB Chain 出块 **0.45 s**（Fermi 硬分叉，主网 2026-01-14 02:30 UTC，BEP-619；历程 3s → 1.5s Lorentz →
0.75s Maxwell → 0.45s Fermi）。代码里是可配置常量 `BLOCK_TIME_S = 0.45`，**请按 bnbchain.org 当期公告核对**。

| window | ≈ 区块数（0.45 s） | 攻击者需要维持 |
|---|---|---|
| 60 s | ~133 | 一分钟 |
| 600 s | ~1,333 | 十分钟 |
| **1800 s（默认）** | **~4,000** | 半小时 |
| 3600 s | ~8,000 | 一小时 |

两条一手量化来源：

- **Uniswap Labs《Uniswap v3 TWAP Oracles in Proof of Stake》**（2022-10-27，blog.uniswap.org/uniswap-v3-oracles）：
  USDC/WETH 5bps 池，两区块操纵成本 **$710 billion**，三区块 **$978 million** ——
  *“While $978 million is still prohibitively expensive, it is not entirely unfeasible like $710 billion.”*
  同文指出 PoS 下 *“multiple block manipulations are now more feasible with the transition to PoS”*
  （出块者提前一个 epoch、32 区块 / 6m24s 已知）。行业基准也出自同文：*“most protocols use a 30 minute
  running TWAP.”*
- **Euler / Michael Bentley**（github.com/euler-xyz/uni-v3-twap-manipulation）：DAI-USDC、n = 144 区块
  （≈30 min @ 13s）模型下，单区块操纵需换入约 **121,060,185,709,756 USDC**
  （*“quite a lot more USDC than there currently is in existence”*），10 区块则总成本 **C ≈ 3,396,454 USDC**。
  结论原话：*“multi-block attacks are unlike any attack we have see yet in decentralised finance, because they
  do not offer risk-free profit opportunities.”*

**BNB Chain 的方向性未被任何一手来源确定，本文不编结论。** 0.45 s 出块让同一时长窗口的区块数变成以太坊模型的
约 28 倍（单区块权重被大幅稀释，利好防守），但维持同一 **wall-clock** 时长也需要控制 28 倍多的连续区块，
而 BSC 只有 21 个验证者（比以太坊集中得多；Uniswap Labs 已把 40% 份额标为 30 区块操纵的门槛）。

**反例，必须一起读：** Inverse Finance 2022-04-02 被攻破的正是一条 SushiSwap TWAP（约 $15.6M）；
Venus 自己 2026-03 也被 THE 代币的 TWAP 操纵打出约 $2.15M 坏账。**窗口长度只提高成本，不能把"低流动性池"
变成"高流动性池"。选池的第一准则是 `liquidity()` 与 observation 深度，不是 window。** 本服务的 `twap`
与 `poolFor` 都把 `liquidity` 和 `observationCardinality` 一起返回，就是为了让这一条可检查。

## `OLD` revert 与 observation 深度

`observe()` 在请求的时间点早于最老的 observation 时 revert（Uniswap `Oracle.sol`
`getSurroundingObservations` 第 226 行，Pancake 同行同文：`require(lte(time, beforeOrAt.blockTimestamp,
target), 'OLD')`）。新建池的 `observationCardinality` 是 **1**，必须有人先付 gas 调
`increaseObservationCardinalityNext(uint16)` —— **这是写操作，本服务做不了**。

因此本服务在**发 `observe` 之前**先在**同一个 blockHash** 上算出**实际可用窗口**
（`OracleLibrary.getOldestObservationSecondsAgo()` 的等价逻辑，比只看 cardinality 准确得多）：

```
a. slot0()  → observationIndex, observationCardinality
b. observations((observationIndex + 1) % observationCardinality)
c. 若该条 initialized == false → 改读 observations(0)
d. maxWindow = <锚定块的 timestamp> − obs.blockTimestamp
```

锚定块的 timestamp **不另发请求**：它已经在 `pinBlock()` 那次 `eth_getBlockByNumber` 的返回体里。
`observations(uint256)` 的第 2 个返回值是 `int56`（SDK 不支持），但这一步只需要第 0 个字和第 3 个字，
那一格直接跳过、不解码。

结果里带一个 `maxWindow` 字段，调用方可以据此自己降级。

- `observationCardinality < 2` → `BAD_REQUEST`：
  `pool <addr> has observationCardinality <n>; TWAP unavailable (needs increaseObservationCardinalityNext, a write this service cannot make)`
- `window > maxWindow` → **不发 `observe`**，直接 `BAD_REQUEST`：
  `window <n>s exceeds this pool's observation history (<m>s available, cardinality <c>)`，附 `observationCardinality` / `maxWindow`
- `observe()` 仍 revert 且原因含 `OLD` → 同样 `BAD_REQUEST`
- 其余 revert → `INTERNAL`

> **这个取舍要说明**：TAP-23 §3.3 把合约 revert 归为 `INTERNAL`。这里归 `BAD_REQUEST`，因为失败的其实是
> **本服务自己的参数校验** —— 调用方应当缩短窗口重试，而 `INTERNAL` 会让它以为是我们坏了。

**实测的可用窗口（2026-09-20/21）**：fee-100 池 24,146–24,302 s（≈6.7 h），fee-500 池 30,516–31,159 s（≈8.5 h）。
**但这是当前活跃度下的数字，不是最坏情况。** 环形缓冲每个区块最多写一条：BNB Chain 出块 0.45 s，
cardinality 4500 在"每个区块都被触碰"时只覆盖 `4500 × 0.45 = 2025 s ≈ 33.75 分钟`；fee-500 池的 900 条只覆盖
`405 s ≈ 6.75 分钟`。而"每个区块都被触碰"正是波动与攻击期间的状态。
**默认 1800 s 窗口在 fee-100 池上只比这个最坏下界低 225 s。** 上面那套动态降级就是为此存在的。

## `deviates == true` 时消费者应该做什么

`deviationBpsActual = |spotPrice − twapPrice| · 10000 / twapPrice`（BigInt，在 18 位定点上算，向零截断）。
`deviates = deviationBpsActual > deviationBpsLimit`（默认 100 bps）。

`deviates == true` 意味着现价与半小时均价分叉了 —— 可能是真实行情快速移动，也可能是有人正在推价。
消费者应当**拒绝报价 / 切熔断 / 降杠杆**，而不是二选一地挑个数字用。

默认 100 bps 不是拍脑袋：**Venus 的 `BoundValidator` `0x6E332fF0bB52475304494E4AE5063c1051c7d735` 对 BNB 用的
上界是 1.01、下界 0.99（±1%）** —— 真实借贷协议对"多源一致"的实际定义就是这个量级，而不是逐字节相等。

## 跨两家提供者的 `callQuorum`，以及什么时候该用数值容差

```js
import { createTapeAPI, TapeAPIError } from '../../sdk/src/index.js'

const api = createTapeAPI({ dev: true })   // 主网 / mainnet: { rpcUrls:[≥2], quorum:2, directory, escrow }
const [a, b] = await Promise.all([
  api.resolve({ dev: 'http://127.0.0.1:8793' }),
  api.resolve({ dev: 'http://127.0.0.1:8803' }),   // 第二家一律取主端口 + 10
])

// 第 1 步：先向任一家要一次，只为拿块号
const first = await api.call(a, 'bnbUsdTwap', {})
const block = first.result.blockPinned.blockNumber

// 第 2 步：同一个显式块号发给两家。两家用的是**不同的池**（fee 100 / fee 500），
// 数值必然不同，所以这里开 ±1% 的容差 —— 与 Venus BoundValidator 对 BNB 的界同量级。
const q = await api.callQuorum([a, b], 'bnbUsdTwap', { block }, {
  quorum: 2,
  compare: { relTolBps: 100, paths: ['bnbUsd', 'bnbUsdSpot', 'meanTick'] },
})
console.log(q.result.bnbUsd, 'agreed by', q.agreed)
```

**容差的三条边界，必须搞清楚：**

1. **`paths` 之外的一切仍然逐字节比较。** `withinTolerance` 先要求两份结果的"骨架"（把 `paths` 指到的数值
   置空之后的 canonicalJSON）完全相同。所以 `deviates`、`window` 和**整个 `blockPinned`（块号与块 hash）**
   仍然必须一模一样 —— 容差**放开的是价格，不是区块**。这正是它安全的原因。
   推论：**`meanTick` 也必须写进 `paths`**，否则两个池的 tick 不同 → 骨架不同 → 容差永远不会生效。
2. **两家用同一个池时容差是个空操作**：同一区块同一次 `eth_call` 的结果本来就逐字节相同。容差只在
   **跨源派生数值**（不同池、不同费率档、不同窗口）之间才有意义。上面的片段特意让两家跑不同费率档。
3. **`paths` 指到一个不是有限数字的字段（`null`、布尔、缺失）会从 `callQuorum` 抛 `BAD_REQUEST`** ——
   那是调用方的错，不是提供者分歧。实测：`paths: ['deviates']` → `BAD_REQUEST: compare.paths: deviates is
   not a finite number in the result`。

**实测（两个本地实例，fee-100 与 fee-500，同一个显式块 123018935）：**

```
exact                      -> QUORUM_FAILED: 2 distinct verified answers; TAP-23 rejects on any disagreement
  group A  bnbUsd 757.003999741106332524  meanTick -66297
  group B  bnbUsd 756.852621648250465948  meanTick -66295
relTolBps 100 (±1%)        -> AGREED by 2 providers
relTolBps 1   (±0.01%)     -> QUORUM_FAILED（两家差约 2 bps）
paths: ['deviates']        -> BAD_REQUEST（布尔不是数字）
```

**不要把容差用在 TAP-23 的 Attested Read 或 `defi-lending-health` 的 `accountHealth` 上。** 那些是同一区块上
同一次 `eth_call` 的确定性结果，两家**必须**逐字节相同；容差只会掩盖真正的分歧。

`callQuorum` 的默认行为是 `onDissent: 'reject'`：**只要出现两个不同的桶就失败，不做多数表决**。
失败时错误对象上直接挂着 `groups` / `disagreed` / `failed` 字段（`TapeAPIError` 用 `Object.assign` 把
extra 摊平到错误本身，**不是** `e.data.groups`）。

## curl

```sh
curl -s -X POST http://127.0.0.1:8793/tapeapi/v1/bnbUsdTwap \
  -H 'content-type: application/json' -d '{"id":"tw-1","params":{"window":1800}}' | jq .
# 实测：
# {"id":"tw-1","ok":true,"result":{
#   "bnbUsd":"756.852621648250465948","bnbUsdSpot":"758.367765774706899702",
#   "meanTick":"-66295","deviates":false,"window":1800,
#   "blockPinned":{"blockNumber":123018677,"blockHash":"0x438e2547…ada2","blockRef":"hash"}},
#  "container":"0x…","ts":…,"block":…,"sig":"0x…"}

curl -s -X POST http://127.0.0.1:8793/tapeapi/v1/twap \
  -H 'content-type: application/json' -d '{"id":"tw-2","params":{}}' | jq '.result'
# 实测（节选）：fee 100, token0 USDT / token1 WBNB, meanTick -66295, spotTick -66315,
#   twapPrice 756.852621648250465948, spotPrice 758.367765774706899702,
#   deviationBpsActual "20", deviates false, observationCardinality 4500, maxWindow 24302,
#   liquidity 3882288899589015945879279

curl -s -X POST http://127.0.0.1:8793/tapeapi/v1/poolFor \
  -H 'content-type: application/json' \
  -d '{"id":"pf-1","params":{"tokenA":"0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c","tokenB":"0x55d398326f99059fF775485246999027B3197955","fee":100}}' | jq '.result'
# {"pool":"0x172fcD41E0913e95784454622d1c3724f546f849","fee":100,"tickSpacing":1,
#  "observationCardinality":4500,"maxWindow":24302,"liquidity":"3882288899589015945879279", …}
```

## 从 dev 到主网

| | dev（默认） | 主网 |
|---|---|---|
| `manifest.dev` | `true` | `false`（设了 `DELEGATION_SIG` + `DELEGATION_EXPIRES` 自动切换） |
| `delegation` | `null` | 持有人签的委托；此时**必须**同时设 `SIGNER_KEY`，否则拒绝启动 |
| `container` / `circuits` / `tokenId` | 占位零地址 | `CONTAINER` / `CIRCUITS` / `TOKEN_ID` |
| `payment.escrow` | 占位零地址 | `ESCROW`（真实 TapeAPIEscrow） |
| 端点 | `http://127.0.0.1:8793` | `PUBLIC_URL`（**https**） |
| 计费 | `FREE_ALL=1` 全免费 | 去掉 `FREE_ALL`，按 `priceBEM` 收 voucher |
| RPC | 三个公共 dataseed，`QUORUM=2` | 自己的节点或付费 RPC；历史块需要归档节点（实测公共 dataseed 的状态保留窗口是**分钟级**：同一个块约 1 分钟时可读，约 3 分钟时返回 `missing trie node`） |
| 池 | 默认 fee-100 WBNB/USDT | `POOL` 指到你自己选的池；**先看 `liquidity()` 与 `observationCardinality`** |

## 什么时候不要用这个 / When not to use this

**不要把它当借贷协议的主价格喂价。** 一条 AMM TWAP 在 Venus 自己的管道里只是 pivot / 后备的角色
（Venus periphery 部署了 `PancakeSwapOracle 0x44B72078…D32E` 与 `UniswapOracle 0x8FD05458…F23f`，
但 main 源多数是 Chainlink，并由 `BoundValidator` 做 ±1% 的交叉校验）。更具体的四条（来自我们对 DeFi 需求的
研究）：

1. **TAP-23 的法定人数规则是客户端规则，清算逻辑在链上。** “≥2 家独立提供者逐字节一致，任何分歧即拒绝”
   是写给调用方的，链上合约里没有 `callQuorum`。
2. **没有质押、没有罚没。** TAP-23 §3.6 把经济安全明确留给未来的 TAP，并要求
   *“clients MUST NOT assume any provider is staked”*。
3. **连 Chainlink 都不承担这个责任。** docs.chain.link/data-feeds/selecting-data-feeds 原话：
   *“Users of single-source feeds MUST implement additional safeguards such as value bounds, caps, circuit
   breakers, freshness checks, fallback behavior, monitoring against independent references where available,
   and manual pause or kill-switch controls.”* —— **一个 TapeAPI 提供者就是一个 single-source feed。**
   两家一致把它变成 two-source，仍然不是一个有质押的预言机网络。
4. **延迟天花板。** 默认钉 `finalized`。借贷主喂价要求 ≤ heartbeat 量级（BNB/USD 的 Chainlink heartbeat 是
   **27 s**、偏离阈值 **0.1%**），竞速清算与永续是毫秒级。这两条本服务结构上进不去，不是"优化一下就能进"。

另外三条具体的：

- **窗口长不等于安全。** 见上面的 Inverse Finance 与 Venus/THE 反例。低流动性池上的 TWAP 只是更贵的靶子。
- **不要在低 `observationCardinality` 的池上用长窗口。** 本服务会直接拒绝，但更重要的是：即使没被拒，
  一个 cardinality 150 的池在活跃期只覆盖几十秒。
- **不要"取多数"或"取平均"。** 容差比较把落在界内的答案归成一组，**不是**把它们平均掉；组外的答案是分歧，
  分歧就该拒绝。失败模式必须是拒绝服务，永远不是错误答案。

**可以**用它做：抵押品估值的**次级源**、主喂价的**熔断锚**（`deviates` 就是为这个设计的）、
DEX / 借贷前端的可归属价格展示，以及 OEV 与清算的**事后审计材料**（签名 + 块锚定 = 可归属的原始记录）。

---

# defi-twap-oracle — PancakeSwap V3 `observe()` TWAP, spot, and a deviation flag

At one pinned block, reads a PancakeSwap V3 pool's **arithmetic mean tick** (`observe(uint32[])`) and its
**spot tick** (`slot0()`), and returns both prices, the actual deviation in basis points and a `deviates` flag.
Evaluated at the attested `blockHash` (EIP-1898), returned signed.

Who it is for: protocols that need a manipulation-resistant price — collateral valuation, circuit-breaker
anchors, and the “pause if the primary feed deviates by more than X bps” independent reference.

## Three steps

```sh
npm install --no-audit --no-fund
FREE_ALL=1 node examples/defi-twap-oracle/index.mjs       # :8793
curl -s -X POST http://127.0.0.1:8793/tapeapi/v1/bnbUsdTwap \
  -H 'content-type: application/json' -d '{"id":"tw-1","params":{"window":1800}}' | jq '.result'
```

## Methods

| method | price | quorum | what |
|---|---|---|---|
| `twap` | 0.0002 BEM | **`[quorum]`** | any V3 pool's TWAP, spot and deviation flag |
| `bnbUsdTwap` | free | **`[quorum]`** | BNB in USDT from the default pool, 1800 s; a deliberately small shape for tolerant comparison |
| `poolFor` | free | **`[quorum]`** | `PancakeV3Factory.getPool` plus a `slot0` summary |

All three accept an explicit `block` and **always return `blockPinned: { blockNumber, blockHash, blockRef }`**
(TAP-23 §3.4). This example has no `[no-quorum]` methods. For a quorum: ask one provider first, take
`blockPinned.blockNumber`, then send that **explicit number** to everyone — otherwise each pins its own
`finalized`, the blocks differ, the results differ, and `QUORUM_FAILED` is unavoidable.

## The default pool and the orientation trap

**Default pool `0x172fcD41E0913e95784454622d1c3724f546f849` (WBNB/USDT, fee 100)** — the deepest liquidity and
the largest observation cardinality (4500).

> **`token0 = USDT` and `token1 = WBNB`**, which is not the intuitive order. Orientation is **always resolved
> at runtime** via `token0()` / `token1()`, never hard-coded; `base` defaults to `token1` and `quote` to
> `token0`.

All four fee tiers exist for WBNB/USDT (measured via `getPool`): 100 → `0x172fcD41…f849`,
500 → `0x36696169…2050`, 2500 → `0x1401ff94…15D2`, 10000 → `0x6805E0E5…Ce06`. Fee tiers and tick spacings are
hard-coded in `PancakeV3Factory`'s constructor as **100→1, 500→10, 2500→50, 10000→200** — **different from
Uniswap V3's 500/3000/10000**. Passing `fee: 3000` is rejected.

### Never port Uniswap's CREATE2 address derivation

PancakeSwap deploys pools from a **separate `PancakeV3PoolDeployer` `0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9`**,
its init code hash differs (Pancake `0x6ce8eb47…f7e2`, Uniswap `0xe34f199b…b8b54`), and the first argument of
`PoolAddress.computeAddress` is the **deployer, not the factory**. Measured: `CREATE2(PoolDeployer, Pancake
hash)` matches `getPool()`; `CREATE2(Factory, Pancake hash)` and `CREATE2(Factory, Uniswap hash)` both produce
**wrong addresses that still look exactly like addresses**, and you then read empty data from a contract that
is not there. This service always calls `getPool()` on-chain (the `poolFor` method) and derives nothing.

## The TWAP algorithm (`OracleLibrary.consult`, copied verbatim)

See the Solidity in the Chinese section. The BigInt equivalent is `meanTickFromCumulatives` in
`examples/_lib/codec.mjs`: BigInt division truncates toward zero exactly as Solidity does, so the `--` must be
kept or negative ticks come out one too high (`delta = -100, window = 3` → `-34`, never `-33`).
`secondsAgos = [window, 0]` — **the order cannot be reversed**.

Tick to price goes through a bit-for-bit BigInt port of `TickMath.getSqrtRatioAtTick` plus
`OracleLibrary.getQuoteAtTick`. BigInt has no 256-bit overflow so `FullMath.mulDiv(a,b,d)` is `(a*b)/d`, but
**the branch and the `baseToken < quoteToken` address comparison are kept exactly as in the source** — drop
either and two implementations diverge at the boundary. Both branches and both address orders are covered in
`examples/_lib/codec.test.mjs`, together with an **on-chain cross-check**: at the pinned block,
`getSqrtRatioAtTick(slot0().tick) ≤ on-chain sqrtPriceX96 < getSqrtRatioAtTick(tick+1)`. The fixed vectors
(`tick 0 → 2^96`, `MIN_TICK → 4295128739`, `MAX_TICK → 1461446703…342`) only prove the constants were copied
correctly; the chain check proves the port is right.

**`meanTick` (an integer) is the authoritative signed field**, and the raw `tickCumulatives` come back too.
`twapPrice` / `spotPrice` are **derived display values**, fixed at 18 places and truncated toward zero
(via `fixed()` in `_lib/codec.mjs`, **not** the SDK's `formatUnits`, which strips trailing zeros and so cannot
be compared byte for byte).

## Why TWAP beats spot (quantified)

Spot is a single block's end state: one flash loan moves it anywhere and back **inside one transaction**, for
the cost of fees plus slippage. A `window`-second mean tick requires the attacker to **hold the price for
`window` seconds** — the cost turns from one slippage event into a sustained position plus whatever arbitrage
eats back every block.

BNB Chain produces a block every **0.45 s** (Fermi hard fork, mainnet 2026-01-14 02:30 UTC, BEP-619; the path
was 3s → 1.5s Lorentz → 0.75s Maxwell → 0.45s Fermi). The code holds this as the configurable constant
`BLOCK_TIME_S = 0.45`; **check it against the current bnbchain.org announcement.**

| window | ≈ blocks at 0.45 s | the attacker must hold for |
|---|---|---|
| 60 s | ~133 | a minute |
| 600 s | ~1,333 | ten minutes |
| **1800 s (default)** | **~4,000** | half an hour |
| 3600 s | ~8,000 | an hour |

Two first-hand sources: **Uniswap Labs, “Uniswap v3 TWAP Oracles in Proof of Stake”** (2022-10-27) — for the
USDC/WETH 5bps pool, two-block manipulation costs **$710 billion** and three-block **$978 million**: *“While
$978 million is still prohibitively expensive, it is not entirely unfeasible like $710 billion.”* The same post
notes *“multiple block manipulations are now more feasible with the transition to PoS”* and gives the industry
benchmark *“most protocols use a 30 minute running TWAP.”* And **Euler / Michael Bentley**
(github.com/euler-xyz/uni-v3-twap-manipulation): on DAI-USDC with n = 144 blocks, single-block manipulation
needs ~**121,060,185,709,756 USDC** (*“quite a lot more USDC than there currently is in existence”*), while
spreading it over 10 blocks costs **C ≈ 3,396,454 USDC** in total; *“multi-block attacks are unlike any attack
we have see yet in decentralised finance, because they do not offer risk-free profit opportunities.”*

**No first-hand source establishes the direction of this for BNB Chain, and this README does not invent one.**
0.45 s blocks make any given wall-clock window ~28× more blocks than the Ethereum models assume (each block's
weight is heavily diluted, which favours the defender), but holding the same wall-clock duration also means
controlling ~28× more consecutive blocks — and BSC has only 21 validators, far more concentrated than Ethereum
(Uniswap Labs put a 40% validator share as the threshold for a 30-block manipulation).

**The counterexamples belong in the same breath:** Inverse Finance was broken on 2022-04-02 through a
SushiSwap TWAP (~$15.6M), and Venus itself took ~$2.15M of bad debt in 2026-03 from a manipulated TWAP on the
THE token. **A longer window only raises the cost; it cannot turn a thin pool into a deep one. The first
criterion when choosing a pool is `liquidity()` and observation depth, not `window`.** Both `twap` and
`poolFor` return `liquidity` and `observationCardinality` precisely so that this stays checkable.

## `OLD` reverts and observation depth

`observe()` reverts when the requested point in time predates the oldest observation (Uniswap `Oracle.sol`,
`getSurroundingObservations` line 226, identical in Pancake: `require(lte(time, beforeOrAt.blockTimestamp,
target), 'OLD')`). A fresh pool has `observationCardinality` **1** and somebody has to pay gas for
`increaseObservationCardinalityNext(uint16)` first — **a write this service cannot make**.

So **before sending `observe`**, this service computes the actually-available window at the **same blockHash**
(the equivalent of `OracleLibrary.getOldestObservationSecondsAgo()`, far more accurate than cardinality alone):
read `slot0()`, read `observations((observationIndex + 1) % observationCardinality)`, fall back to
`observations(0)` when that one is not `initialized`, and take `maxWindow = pinned block timestamp −
obs.blockTimestamp`. The pinned block's timestamp costs **no extra request** — it is already in the
`eth_getBlockByNumber` response `pinBlock()` has to make. `observations(uint256)`'s second return value is an
`int56` the SDK cannot decode, but only words 0 and 3 are needed, so that slot is skipped entirely.

`maxWindow` is returned in the result so callers can degrade on their own.

- `observationCardinality < 2` → `BAD_REQUEST` naming the write this service cannot make.
- `window > maxWindow` → **no `observe` is sent**; `BAD_REQUEST` with `observationCardinality` and `maxWindow`.
- An `observe()` that still reverts with `OLD` → also `BAD_REQUEST`.
- Any other revert → `INTERNAL`.

> **The trade-off, stated:** TAP-23 §3.3 maps contract reverts to `INTERNAL`. These are `BAD_REQUEST` because
> what actually failed is **this service's own parameter validation** — the caller should shorten the window
> and retry, and `INTERNAL` would suggest we are broken instead.

**Measured available windows (2026-09-20/21):** fee-100 pool 24,146–24,302 s (≈6.7 h), fee-500 pool
30,516–31,159 s (≈8.5 h). **But those are today's activity levels, not the worst case.** The ring buffer takes
at most one entry per block: at 0.45 s blocks, cardinality 4500 covers only `4500 × 0.45 = 2025 s ≈ 33.75
minutes` when every block is touched, and the fee-500 pool's 900 entries cover `405 s ≈ 6.75 minutes`. “Every
block touched” is exactly the state during volatility and during an attack. **The default 1800 s window sits
only 225 s below that worst-case floor on the fee-100 pool.** The dynamic degradation above exists for this.

## What a consumer should do when `deviates == true`

`deviationBpsActual = |spotPrice − twapPrice| * 10000 / twapPrice` (BigInt, on the 18-place fixed-point scale,
truncated toward zero). `deviates = deviationBpsActual > deviationBpsLimit` (default 100 bps).

`deviates == true` means spot and the half-hour mean have diverged — possibly a genuine fast move, possibly
somebody pushing the price. The consumer should **refuse to quote, trip a circuit breaker, or reduce leverage**,
not pick whichever of the two numbers it prefers.

The 100 bps default is not arbitrary: **Venus's `BoundValidator` `0x6E332fF0bB52475304494E4AE5063c1051c7d735`
uses an upper bound of 1.01 and a lower bound of 0.99 (±1%) for BNB** — that is what a real lending protocol
means by “multiple sources agree”, and it is not byte-for-byte equality.

## `callQuorum` across two providers, and when numeric tolerance applies

See the JavaScript in the Chinese section. Note on historical blocks: the public dataseeds' state-retention window is measured in **minutes** — the same
block read fine at ~1 minute old and returned `missing trie node` at ~3 minutes old (2026-09-20). Fan an
explicit block number out to your providers promptly, or a late one fails rather than disagreeing.

**The three boundaries of tolerance:**

1. **Everything outside `paths` is still compared byte for byte.** `withinTolerance` first requires the two
   results' skeletons (the canonical JSON with the `paths` values nulled out) to be identical. So `deviates`,
   `window` and **all of `blockPinned` (number and hash)** must still match exactly — tolerance loosens the
   **price, never the block**. That is what makes it safe. Corollary: **`meanTick` must also be in `paths`**,
   or two pools' differing ticks make the skeletons differ and tolerance never fires.
2. **Tolerance is a no-op when both providers use the same pool** — the same `eth_call` at the same block is
   already byte-identical. It only means something for **derived cross-source numbers** (different pools, fee
   tiers or windows). The snippet deliberately runs the two instances on different fee tiers.
3. **A path pointing at anything that is not a finite number (`null`, a boolean, a missing field) throws
   `BAD_REQUEST` out of `callQuorum`** — that is the caller's mistake, not a provider disagreement. Measured:
   `paths: ['deviates']` → `BAD_REQUEST: compare.paths: deviates is not a finite number in the result`.

**Measured** (two local instances, fee-100 and fee-500, same explicit block 123018935): exact comparison →
`QUORUM_FAILED` with two groups (`757.003999741106332524` / tick `-66297` and `756.852621648250465948` /
tick `-66295`); `relTolBps: 100` → agreed by both; `relTolBps: 1` → failed (they are ~2 bps apart);
`paths: ['deviates']` → `BAD_REQUEST`.

**Do not use tolerance for TAP-23 Attested Reads or for `defi-lending-health`'s `accountHealth`.** Those are
the deterministic results of one `eth_call` at one block; two providers **must** match byte for byte and a
tolerance would only mask a real disagreement.

`callQuorum` defaults to `onDissent: 'reject'`: **two distinct buckets is a failure, with no majority vote**.
On failure the error object carries `groups` / `disagreed` / `failed` **directly** (`TapeAPIError` uses
`Object.assign` to flatten extras onto the error — it is **not** `e.data.groups`).

## dev → mainnet

Same table as the Chinese section: `DELEGATION_SIG` + `DELEGATION_EXPIRES` flip `dev` to `false` and make
`SIGNER_KEY` mandatory; `CONTAINER` / `CIRCUITS` / `TOKEN_ID` / `ESCROW` / `PUBLIC_URL` (https) replace the
placeholders; drop `FREE_ALL` to charge vouchers; bring your own RPC set; and point `POOL` at a pool you chose
by **`liquidity()` and `observationCardinality`** first.

## When not to use this

**Do not use this as a lending protocol's primary price feed.** An AMM TWAP is a pivot / fallback role even
inside Venus's own pipeline (Venus periphery deploys `PancakeSwapOracle 0x44B72078…D32E` and `UniswapOracle
0x8FD05458…F23f`, but most assets' main source is Chainlink, cross-checked by `BoundValidator` at ±1%).
Four reasons (from our research into DeFi needs):

1. **TAP-23's quorum rule is a client-side rule while liquidation logic lives on-chain.** No contract contains
   `callQuorum`.
2. **No stake, no slashing.** TAP-23 §3.6 defers economic security to a future TAP and requires that
   *“clients MUST NOT assume any provider is staked”*.
3. **Even Chainlink does not accept this responsibility**: *“Users of single-source feeds MUST implement
   additional safeguards such as value bounds, caps, circuit breakers, freshness checks, fallback behavior,
   monitoring against independent references where available, and manual pause or kill-switch controls.”* —
   **a single TapeAPI provider is a single-source feed.** Two agreeing providers make it two-source; it is
   still not a staked oracle network.
4. **The latency ceiling.** The default pin is `finalized`. A lending protocol's primary feed needs heartbeat-
   scale latency (Chainlink's BNB/USD heartbeat is **27 s** with a **0.1%** deviation threshold); racing
   liquidations and perps are sub-second. This service is structurally excluded from those lanes — that is not
   something tuning fixes.

Three more specifics: **a long window is not safety** (see Inverse Finance and Venus/THE above — a TWAP on a
thin pool is just a more expensive target); **do not use long windows on pools with low
`observationCardinality`** (this service refuses outright, but more importantly a cardinality-150 pool covers
only tens of seconds when active); and **never take a majority or an average** — tolerant comparison groups
answers that fall inside the bound, it does **not** average them, and anything outside is a disagreement that
must be refused. The failure mode has to be denial of service, never a wrong answer.

**Do** use it as: a **secondary source** for collateral valuation, a **circuit-breaker anchor** for a primary
feed (`deviates` exists for exactly this), an attributable price display for a DEX or lending front-end, and
**after-the-fact audit material** for OEV and liquidations (signature + block anchor = an attributable record).
