# TapeAPI 跨链、流动性与可验证计算 v0.2

一句话：**TapeAPI 不搬资产，只搬三种数据：签名的读取结果、签名的报价承诺、可在链上重算的证明。**
资产留在各自的链上，由持有流动性的服务方自己调度。这样它有桥的用处，没有桥的资金池风险。

## 0. 为什么 TapeOut 生态天然适合做这件事
- TAP-10 的端点编码是 `uint32(0) ‖ uint64(chainId) ‖ container`，消息层从第一天就是多链的。TapeAPI 直接沿用：服务端点、支付 Escrow 都按 chainId 寻址。
- 电路 NFT 只在 BSC 上铸造，但容器身份可以在任何 EVM 链上被承认（ERC-6551 地址可确定性推导）。一个服务一个身份，多链通用。
- 电路可以在链上 `eval()`，约 2468 gas 每门，单次上限 1200 万 gas，约 4800 门。这是其它任何生态都没有的"链上可重算的小型逻辑"。

## 1. TAP-23 Attested Read：无桥跨链读取
**问题**：BSC 上的 DeWEB 应用想知道 Ethereum、Base、Solana 上某个状态（余额、价格、NFT 归属、某笔交易是否确认）。传统答案是预言机委员会或轻客户端桥，都重。
**TapeAPI 的答案**：任何持有电路的人都可以发布一个 Attested Read 服务，方法形如 `read(chainId, call)`，响应是 TAP-21 信封加两条额外字段：`{ chainId, blockNumber, blockHash, stateRoot? , result }`。
**信任模型**：单个服务只是一个签名者。SDK 提供 `quorum` 模式：同一别名类别下选 N 个独立提供者，要求 ≥2 个结果一致才采用，不一致就拒绝。这与 TapeKit 内核"至少两家独立节点一致、永远没有多数投票"是同一条规则，评审者一看就懂。
**经济安全**：提供者可在 Escrow 上质押（TAP-22 扩展 `stake()`），签了错误结果被另一个提供者用同一区块的 `blockHash` 加 Merkle 证明举证后罚没。第一版不做罚没，只做多提供者一致。
**用途**：跨链余额门槛（持有 ETH 主网 NFT 才能进 BSC 游戏）、跨链价格、跨链身份、跨链事件触发。

## 2. TAP-24 Intent RFQ：不做桥的跨链兑换
**问题**：用户在链 A 有资产，想在链 B 得到资产。
**流程**（全部是数据，没有资金池）：
1. 用户通过 SDK 向多个"Solver"服务发出询价 `quote({ fromChain, fromToken, amount, toChain, toToken, recipient })`。Solver 是普通 TapeAPI 服务，任何做市商、跨链桥、CEX 都可以注册一个电路来当 Solver。
2. Solver 返回**签名报价**：`{ quoteId, amountOut, expires, settlementContract, solverAddressOnA, solverAddressOnB }`。签名即承诺，有效期通常 30 到 120 秒。
3. 用户在链 A 把资产锁进一个通用的 `IntentEscrow`（每链一份，地址统一），附上 `quoteId` 和 Solver 签名。
4. Solver 在链 B 直接把 `amountOut` 打给 `recipient`。
5. 任何一个 TAP-23 Attested Read 服务（或多个的仲裁）出具"链 B 上该转账已确认"的签名读取结果，提交到链 A 的 `IntentEscrow`，释放锁定资产给 Solver。超时未履约，用户取回。
**TapeAPI 在里面做了什么**：发现 Solver、传递报价、签名承诺、提供履约证明。**没有做什么**：没有托管跨链资金池、没有铸造包装资产、没有中继验证者集合。
**流动性从哪来**：Solver 自带。UniswapX、Across、CoW 已经证明 intent + solver 模式能承载真实流量；TapeAPI 提供的是一个不属于任何单一协议的、身份和支付都在链上的 RFQ 网络。BEM 是 Solver 支付 TapeAPI 调用费、质押和贡献的单位。
**对 TapeOut 的价值**：每个 Solver、每个 Attested Read 提供者都要持有电路。流动性方越多，电路需求越多。

## 3. TAP-25 Circuit-Verified Methods：链上可重算的服务
**这是 TapeAPI 与所有其它 API 标准的分水岭。**
服务清单里的方法可以声明一个验证电路：
```json
{ "name": "settleRound", "priceBEM": "0.001", "params": { "round": "object" }, "returns": { "result": "object" },
  "verifier": { "circuits": "0x…", "tokenId": "1337", "encoding": "tapi-bits-v1", "maxGas": 6000000 } }
```
含义：该方法的输入输出关系由这个已流片的电路定义。提供者在链下算得快，但任何人可以把 `(input, output)` 编码成比特向量，调用电路合约的 `eval()` 在链上重算。不一致即为作恶证据。
**适合的方法**：游戏回合结算规则、抽奖与随机数合成、哈希与校验、小型状态机、二值神经网络推理（Blonskr 路线图里的 BNN 正好落在这里）。不适合的：大模型推理、需要外部数据的方法。
**争议流程**：消费者拿到签名响应后可以向 Escrow 发起 `dispute(responseEnvelope, input, output)`；合约调用电路 `eval()`；若电路输出与提供者签名的输出不同，罚没提供者质押的一部分给举证人。这让"可验证 API"第一次不需要 zk 证明系统也能在链上裁决。
**门槛**：4800 门以内。这正是 TapeOut 社区每天在做的 PoD 任务规模（加法器、乘法器、S-box）。TapeAPI 给这些电路一个直接的商业用途：**每个 PoD 任务的产物都可以变成一个可验证的 API 方法**。

## 4. 多链支付：BEM 作为服务经济的结算单位
- 每条支持的链部署一份 Escrow，用 CREATE2 保证地址统一（照搬 TAP-10 的"hub 地址统一"做法）。
- BEM 本身只在 BSC。其它链上先用该链的稳定币或原生币计价结算，清单里 `payment.units` 列出每条链接受的币种。BEM 的角色：BSC 上的默认结算币、质押币、贡献币、Solver 的 TapeAPI 调用费。
- 当 TAP-24 跑起来，Solver 会持续需要把其它链的收入换成 BEM 来质押和付费，这就是"流动性经由 TapeAPI 流向 TapeOut"的具体机制，不需要发行跨链 BEM。

## 5. 分期
| 期 | 内容 | 依赖 |
|---|---|---|
| v0.2 | SDK `quorum` 多提供者一致；Attested Read 示例服务（读 Ethereum/Base）；TAP-23 草案 | 无 |
| v0.3 | TAP-25 清单字段 + SDK 本地重算（用 netlist 模拟器）+ 示例（一个 PoD 加法器当校验方法）| 拿到 `eval()` 的精确接口与编码 |
| v0.4 | Escrow 质押与 `dispute()`；TAP-24 IntentEscrow 与 Solver 参考实现 | 审计 |
| v1.0 | 多链 Escrow 部署；目录站按链筛选 | 各链部署预算 |

## 6. 一句话给不同的人
- 给 Web2 企业：把你现有的 API 变成任何人不用开户就能按次付费调用的服务，收入直接到你的链上身份。
- 给 DeFi：一个不需要委员会的可验证数据源，以及一个不锁资金池的跨链询价网络。
- 给游戏：存档和排行榜跟着玩家走，回合结算规则上链可查，作弊可举证。
- 给公链：发布一个 Attested Read 服务，TapeOut 生态的所有应用就能无桥读你的链。
- 给 Blonskr：每个服务、每个 Solver、每个可验证方法都消耗一个电路；PoD 任务的产物第一次有了商业出口。
