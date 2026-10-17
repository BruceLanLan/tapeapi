[English](../reference.md) | 中文

# 参考

数据手册附录：原先铺满首页的参考章节，搬到这里，事实不变。包括 2.0 改了什么、实验性功能、每一版加了什么、AI 回执层、
同一套身份的其它部分、多链、隐私、一致性真值表、极限参数、费用、付费通道、路线图、规范索引与安全说明。实验性功能与付费通道
依赖的托管合约未审计、未部署：主网不可用，只在本地链与测试中验证，今天不收费。

## 2.0 新增

**DEFAULT SINCE 2.0** · TAP-10 v1.1 §3–§7 · TAP-11 §2（Draft）· `conform: false` 弃用，2.x 内保留

2.0 只有一个主题：我们向 TapeOut 官方 TAP 流程提交的规则，以及 TapeOut 自己规定的规则，就是你什么都不传时 SDK 的行为。1.4 起这些规则以可选的 `conform: 'tap10'` 提供；2.0 把它变成默认。**线上格式一个字节都不变：**2.0 的客户端照样核验所有 1.x 的清单、委托、签名回答和回执。TAP-10 与 TAP-11 还是 Draft，默认按一条规则跟随它们的文本：放宽与新增状态名在 2.x 次版本里生效，收紧先作为可选 profile、默认到 3.0 才切。**一个已知例外：**不开 `allChains` 时，形如 `0x…#4246` 的"处理器合约#ID"会被拒绝（`data.status: 'unsupported'`，这是 TapeAPI 自己的名字），而 TAP-11 §2.1 要求接受它；传 `allChains: true` 即按 TAP-10 §4.1 读遍所有链解析（会同时访问 Base 与 X Layer 的节点）。

TAP-11（服务清单与持有人委托）和 TAP-13（签名响应）是我们起草、提交的草稿，编辑已把两份合并进官方仓库，状态是 Draft；合并为 Draft 不等于被采纳。另有 12 份草稿是尚未合并的拉取请求，其中 #54、#59、#60 目前转为 draft PR，暂不占用编辑的评审队列。要 1.x 的行为，传 `conform: false`（已弃用，整个 2.x 保留）。

```js
const api = createTapeAPI({ rpcUrls: rpcUrlsFor(56) })                  // 2.0：TAP-10 / TAP-11 §2
const old = createTapeAPI({ rpcUrls: rpcUrlsFor(56), conform: false }) // 1.x 方式，已弃用
const dev = createTapeAPI({ dev: true })                           // = conform: false，无提示
```

### 什么变了（不传 `conform` 时）

| 情形 | 1.x 默认 | 2.0 默认 |
|---|---|---|
| 读取用哪个区块 | 最新块，不钉定 | 一个 TAP-10 钉块，按块号和哈希确认 |
| 链 ID、持有人、合约持有人的签名 | 多数运营方一致 | 所有运营方都作答且一致（严格） |
| 从未开通的名字 | 清单有效就解析成功 | `SITE_STATUS` · `not-opened` |
| 未激活或付费到期 | 解析成功 | `SITE_STATUS` · `unpaid` |
| 站点存储或付费合约换了未列出的实现 | 解析成功，只告警 | `CONTRACT_UNKNOWN` · `store-changed` |
| 自定义地址、本地链、显式 `pin` | 允许 | 建客户端时 `INVALID_ARGUMENT`，提示传 `conform: false` |
| 清单缓存 | 3 600 s | 60 s |
| 冷解析一个服务的 RPC 调用（BSC 主网实测） | ≈ 24 | ≈ 45 |
| 同一客户端再解析一次 | ≈ 9 | ≈ 36 |

**按 `e.data.status` 分支，不要按错误信息。**状态名就是 TAP 里的小写名（`unsupported`、`hub-changed`、`container-mismatch` 是 TapeAPI 自己的名字）。状态名只增不改；`data.status` 在 2.0 里仍是实验性的（它跟随的是 Draft），待 TAP-11 评审期满且无未解决的异议后再考虑升为 Stable。`not-opened`、`unpaid` 要服务方自己处理（不要重试），`store-changed` 要升级 SDK（临时办法 `conform: false`），`unavailable` 是节点问题（重试，或给 `rpcUrls` 加一个自己的运营方）。

解析失败时，`e.data.status` 用 TAP 自己的名字说明原因。本地服务用 `{ dev: true }`；本地链、分叉或你自己部署的合约不是 TAP-10 列出的 TapeOut 链，要传 `conform: false`，否则建客户端时就报 `INVALID_ARGUMENT`：

```js
try { await api.resolve('11.1013.tape') } catch (e) {
  if (e.data?.status === 'not-opened' || e.data?.status === 'unpaid') { /* 要服务方处理：不要重试 */ }
  else if (e.data?.status === 'unavailable') { /* 节点没作答或不一致：重试 */ }
  else throw e
}
const dev = createTapeAPI({ dev: true })                       // 本地 http:// 服务，不需要链上清单
const local = createTapeAPI({ rpcUrls: ['http://127.0.0.1:8545'], allowSingleNode: true, allowHttp: true,
  chainId: 31337, hub: HUB, factory: FACTORY, siteRegistry: SITE_REGISTRY, conform: false })
```

### 2.0 的其它变化

- **私密通道与群聊用新标签**：默认使用 TAPI-26 v2 与 TAPI-27 v2：标签以 `tape-channel/`、`tape-group/` 开头，这是 TAPs 编辑在合并草稿 #12、#20 之前提出的要求。`labels: 'v1'` 选用第 1 版（2.x 内弃用、不删除）。两版不互通，不一致时超时或报出明确的版本不一致，绝不失败放行。
- **命令行跟着变**：`tapeapi-verify`、`tapeapi-mcp`、`tapeapi-doctor` 写明用了哪种解析，加 `--no-conform` 回到 1.x；默认下 doctor 对未激活的名字判为失败。
- **代理工具包按 TAP-11 §2 解析**：不给 `resolve` 时，`createAgentKit`（实验性）按 TAP-11 §2 解析代理与服务方。
- **清理 1.0 的遗留**：`TapeAPIError` 去掉弃用的顶层别名（读 `e.data.*`）；通道模块把调用方自己的参数错误报为 `INVALID_ARGUMENT`。

### 我们怎么核对的

- **退路逐字相同 · 637 / 637**：差分测试的 637 个用例里，`conform: false` 与 1.8.1 的默认发出相同的请求、顺序相同、结果相同；只允许弃用提示与第 2 版收件房间两处差异。
- **我们自己的服务**：`11.1013.tape` 与 `12.1013.tape` 按 TAP-10 的方式在主网上解析正常，两者都已激活，付费到 2036-08-09。
- **服务方自查**：用 2.0 的安装跑 `tapeapi-doctor <你的名字>`，前 7 项检查（name 至 delegation）全部成功，2.0 客户端就能解析你；之后各项针对 AI 服务。

[从 1.x 升级到 2.0](upgrade-2.0.md) · [TAP-11（Draft）](https://github.com/TapeOutProtocol/TAPs/blob/main/TAPs/TAP-11.md)

## 实验性功能

**EXPERIMENTAL · NOT DEPLOYED。**2.0 首次公开三项实验性功能：有界代理、美元报价、容器间评价。**边界：**它们依赖的托管合约（TAPI-22）未经审计、未部署，主网不可用，今天只在本地链与测试中可以验证，也不收任何费用。它们不受 2.x 兼容承诺约束。

### 有界代理

`@tapeapi/sdk/agent` · 托管合约未审计、未部署 · 主网不可用 · 只在本地链与测试中验证 · 今天不收费 · 不受 2.x 兼容承诺约束

1.7 的阶段 0 只记录谁可以替哪个容器做哪件任务，什么都不强制执行。有界代理是阶段 1：代理可以替容器花钱，而容器最多会亏多少，由托管合约算死、可在链上核对。电路持有人为代理可以付费的每个服务各充值一条托管通道，把一把只为这份授权书生成的钥匙授权为这些通道上的会话钥匙，有效期到授权书到期。**钥匙泄露或代理作恶，损失最多是放进这些通道的钱，而且只能付给授权书点名的服务。**

- **核验**：`{ enforcement: 'escrow-channel' }`：在同一个钉块上读每条有上限的通道，全部满足才报告“已强制执行”；链上限住的始终是通道余额。
- **持有人的计划**：`holderPlan` 从链上读事实，给出未签名的 `approve`、`fund`、`authorizeSession`；`afterPlan` 读回核对，`closeOut` 取回剩余；会话历史防止重复充值。
- **累计限额器**：`createSpendLimiter` 绝不签出累计超过“开始时已结算额加上限”的凭证；默认拒绝单次超过上限 10% 的调用。
- **重启后接着处理订单**：会话钥匙与订单记录用口令保险箱加密保存（scrypt 与 XChaCha20-Poly1305）；`resume` 只恢复仍有效的订单，已停止、撤销或过期的绝不恢复。
- **交付里的钱**：交付可以附代理签名的花费声明，与链上读数和回执逐项对账。

今天能验证的只有本地：在已安装依赖的仓库检出根目录，第一条在 SDK 的假链上跑一单完整的花费流程（含泄露钥匙、涨价、换托管等对抗用例），第二条在本地的托管合约副本上跑同样的交易。不联网、不碰真实钱包、不花钱。

```bash
node --test examples/agent-service/agent-service-spend.test.mjs
cd contracts && forge test --match-path 'test/Phase1*'
```

**如实说明。**它依赖的托管合约（TAPI-22）未经审计、未在任何链上部署，SDK 内置的可信托管合约列表是空的，所以在主网上不可用，今天也不收费。阶段 1 的 TAP 草稿已提交为 TapeOutProtocol/TAPs#60（目前转为 draft PR，暂不占评审队列），规定托管接口的 Standards 草稿已提交为 #59（目前转为 draft PR，暂不占评审队列）。

### 美元报价、BEM 结算

TAPI-22 §3.6 · 实验性：托管合约未审计、未部署，主网不可用，只在本地链与测试中可以验证；今天不收费。

TAP 草稿 #52（尚未合并的拉取请求）的参考实现。清单可以用美元定价；服务方在签名报价里给出 BEM 汇率，客户端签凭证前对照链上参考池核对，每个收费回答都附签名的收费记录；`priceBEM` 仍是单次最多花多少。没有 `usdPricing` 的清单逐字节照旧。托管合约未部署，所以不收费。

### 容器之间的评价

`@tapeapi/sdk/review` · 实验性，边界同上：托管合约未审计、未部署，主网不可用，只在本地链与测试中可以验证；今天不收费；不受 2.x 兼容承诺约束。

TAP 草稿 #54（尚未合并的拉取请求）的参考实现。评价由评价方的持有人或其委托的密钥签名，有证据才计入：评价方收到过的签名回答，或两个容器之间的任务线程。汇总只数不同的评价方与持有人，从不按金额加权；`tapeapi-verify review <名字>` 打印出来。

## 每一版加了什么

- **签名回答与回执 · 1.0**：每个回答都有签名并绑定请求，AI 调用另有一张按链上价目表（公开声明，用户照旧向服务方付款）计价的用量回执。[调用服务](consume.md)
- **MCP 工具 · 1.0**：结果带签名和回执，工具定义的哈希钉在链上。[MCP 指南](mcp.md)
- **对 TapeOut 官方 TAP-10 的一致模式 · 1.4–1.5**：以可选的 `conform: 'tap10'` 提供，2.0 起成为默认。
- **流式 AI 回执与可核验的用量 · 1.5–1.6**：被截断或被追加内容的流不再被判为已核验；可选的 `requestUsage` 让流式 Chat 的用量也进入签名。[流式用量](ai-providers.md#流式-chat-的用量三条路)
- **容器代理，阶段 0 · 1.7–1.8**：授权书、任务线程、只读的付款核验；1.8 按草稿 #47 收紧核验，钉块读取。[容器代理指南](container-agents.md)
- **标准即默认 · 2.0**：按 TAP-10 与 TAP-11 §2 解析成为默认；通道与群聊默认用新标签（1.8.1 起可选）；有界代理首次公开（实验性：托管合约未审计、未部署，主网不可用，只在本地链与测试中可用，今天不收费）。

完整记录见[更新日志](../../../CHANGELOG.md)。

## AI 回执层

请求和回答原样穿过旁路，旁路为每个回答签一张用量回执：模型、token 数、按价目表算出的金额、请求与回答的哈希。签名密钥由电路持有人在链上委托，价目表写在链上清单里；客户端读链核验，不用信任旁路。

- **客户端不改代码**：官方 SDK 与命令行编码助手照旧，只换 base URL。
- **四种格式，含流式**：OpenAI Chat、Responses、Anthropic Messages、Embeddings。
- **流式用量也能核验**：可选的 `requestUsage`（1.6）把流式 Chat 的用量放进签名的流里，与回执逐一核对。
- **回执不打扰旧客户端**：放在响应头，或官方 SDK 会忽略的 SSE 注释里。
- **价目表钉在链上**：每个模型、每种币一个价，改价要持有人重新发布。

你照旧经营：接口、密钥、渠道和计费都不变。旁路放在你的网关**前面**，所以回执覆盖的正是你向用户收取的用量与价格。

价目表里的价格**只是公开的声明，不经过结算**：用户照旧向你付款，回执里的金额是一笔可以核对的声明。

TapeAPI 只面向在上游服务商条款范围内合规经营的服务方。身份、价目表在链上，换域名、换服务器，用户跟着链上记录走；协议不提供、也不帮助绕开上游的封禁或地区限制。

**回执不证明实际跑的是哪个模型。**服务方可以把便宜模型的回答标成贵的。签名带来的是可追责：回执无法抵赖，任何人用抽检探针发测试请求、公开结果，都会留下证据。详见 [AI 服务方指南](ai-providers.md)。

## 同一套身份，还有四块

### 签名的 MCP 工具

MCP 的工具结果是服务器随口给的，工具定义也可以在你批准之后被偷偷改掉。TapeAPI 让每个结果带签名和回执，把工具定义的哈希钉在链上。公共端点直接用；自己的服务器加签名代理；本地命令 `tapeapi-mcp` 在模型看到结果之前先核验。

### 私密通道与群聊

TAPI-26 v2 · TAPI-27 v2。两个容器之间的端到端加密通道：双方互相验证身份、前向保密、防重放和乱序。群聊最多 32 个容器（实验性的格式 2 最多 128 个），群主管理成员，每条消息单独签名。载体可以是公共中继、你自己的中继或链上的 ChannelBus，都只看到密文。2.0 起默认使用规范第 2 版的 `tape-channel/`、`tape-group/` 标签；与未升级的 1.x 对端通信时传 `labels: 'v1'`。

### 多链：BNB Chain、X Layer、Base

跟随 TapeOut 上了 X Layer 和 Base。名字带区号，比如 `1.2.230.tape` 是 X Layer 上处理器 230 的 1 号。身份、解析、回执和 MCP 核验都能用；支付只会在 BNB Chain。

### 容器代理与有界代理

实验性。阶段 0（1.7）：持有人签授权书，代理接任务、交付，委托方验收，付款是一笔任何人都能核验的普通转账，不强制执行。有界代理（2.0）：写了金额的授权书由托管通道限住，代理最多能花多少可在链上核对；托管合约未审计、未部署，主网不可用，只在本地链与测试中可用，今天不收费。`@tapeapi/sdk/agent` 不受 2.x 兼容承诺约束。[有界代理](#有界代理)

## 多链

| 链 | chainId | 名字 | 范围 | 默认节点 |
|---|---|---|---|---|
| BNB Smart Chain | 56 | `11.1013.tape` | 全部；ChannelBus；支付只在这里（未部署） | 3 家运营方：多数读取 2 家一致，严格读取 3 家都要作答且一致 |
| X Layer | 196 | `1.2.230.tape` | 只读：身份、解析、回执、MCP 核验 | 只有 2 家运营方，2 家都要作答且一致，没有备份 |
| Base | 8453 | 区号 3 | 只读：同上 | 4 家运营方 |

身份不跨链：同一个 DeWebHub 地址在三条链上都一样，委托签名按链 ID 区分，给一条链的委托在另一条链上无效。

## 隐私：能保护什么，不能保护什么

### 受保护的

- **通道与群聊的内容**：端到端加密，中继和链上只有密文。
- **AI 回执只带哈希**：不含提示词和回答；经 SDK 或 `tapeapi-verify` 发出的请求默认追加 128 位随机空白，短提示词没法靠猜哈希对上。
- **MCP 核验链接只带哈希**：不带参数和结果；参数很短时（一个地址、一个编号）仍可能被猜出。
- **链上通道读取**：SDK 的 `busPrivacyReader`（实验性）默认读整个 ChannelBus、在本地筛选，节点看不出你的房间。
- **日志最小化**：我们的公共服务在配置里关闭了逐请求调用日志；Cloudflare 自己的请求记录是否含 IP 仍待核实。

### 公开或可见的

- **服务方看得到一切它处理的东西**：请求内容、你的 IP、你的 API 密钥。加密挡不住处理请求的那一方。
- **公共 RPC 节点**：看得到你的 IP 和你在核验哪个服务。
- **通道的元数据**：中继或链看得到房间、时间和大小。
- **链上的一切**：身份、清单、价目表（公开声明，用户照旧向服务方付款）、委托；将来的付款金额和双方地址。

## 一致性真值表

两份已验证信封的比较结果，读链时节点之间也是同一条规则。

| 提供者 A 应答 | 提供者 B 应答 | 签名有效 | 结果一致 | 输出 |
|---|---|---|---|---|
| 1 | 1 | 1 | 1 | 采信 |
| 1 | 1 | 1 | 0 | 拒绝 |
| 1 | 1 | 0 | × | 拒绝 |
| 1 | 0 | 1 | × | 拒绝 |

**没有多数决。**三家里两家一致、一家不同，默认结果是拒绝。多数决在三取二时可被两家合谋伪造，而拒绝只会让调用失败。调用方可以显式降级，但那是它自己的选择。

```js
// 钉同一个区块，要求两家独立提供者给出逐字节相同的答案
const a = await api.resolve('11.1013.tape')
const b = await api.resolve('0x…')                  // 第二家独立提供者
const first = await api.call(a, 'bnbUsd', {})
const block = first.result.blockPinned.blockNumber
const r = await api.callQuorum([a, b], 'bnbUsd', { block }, { quorum: 2 })
console.log(r.result.bnbUsd, r.agreed)
```

今天 api.tapeapi.fun 是这些方法唯一的公共提供者，第二家要由你或别人运行（[`examples/public-api/`](../../../examples/public-api/)）。

## 极限参数

超出这些值，规范或 SDK 直接拒绝。

| 符号 | 参数 | 值 | 依据 |
|---|---|---|---|
| `MANIFEST_LIMIT` | 服务清单，含 AI 价目表（公开声明，用户照旧向服务方付款） | 64 KiB | TAPI-20 |
| `CHUNK` | 一次上链写入（操作台一笔交易） | 24 000 B | SPEC B.5 |
| `ENVELOPE_LIMIT` | 签名响应信封 | 1 MiB | TAPI-21 |
| `DEFAULT_MAX_SKEW_S` | 签名时间与本地时钟之差 | ≤ 300 s | TAPI-21 |
| `MAX_MEMBERS` | 群成员（实验性的格式 2 最多 128） | 32 | TAPI-27 |
| `CHANNEL_KEYS_LIMIT` | 通道密钥记录 | 4 KiB | TAPI-26 |

## 费用

今天所有调用都不收费：付费托管合约尚未部署。

| 项目 | 收费方 | 金额 |
|---|---|---|
| 解析身份、读清单、验签、核验回执 | 无 | 0 |
| TapeAPI 强制协议费 | 无 | 0 |
| AI 调用 | 服务方，照旧在链下收费 | 服务方自定 |
| 维护贡献（仅付费通道，未部署） | 服务方自设 | 默认 1%，可关闭 |
| 开通一个容器 | TapeOut | 0.012 BNB |

**无强制协议费；默认 1% 维护贡献，任何服务方都可以关闭；运营方没有费率开关。**这 1% 只在付费通道结算时从服务方所得中扣，用户的价格不变；付费托管合约尚未部署，所以今天所有调用都不收费。TapeAPI 不发币。

## 实验性：付费通道

**EXPERIMENTAL · NOT DEPLOYED** · TAPI-22 · 未审计 · 不在 2.x 的稳定承诺内 · 部署前须经独立审计 · 主网不可用，只在本地链与测试中可以验证 · 今天不收费

付费调用的设计：调用方离线签发累计凭证，钱进一条只属于这个服务的托管通道，服务方攒够了再上链结算一次，调用本身不花 gas。合约代码和测试在仓库里，但**没有部署**；下面的数字是本地实测，只说明这个设计的成本。送审的托管合约计划首先托管 BEM（USDT 锚定币与 WBNB 按需）；2.0 另有实验性的美元报价、BEM 结算（TAPI-22 §3.6，草稿 #52），同样不收任何费用。

gas 为本地实测；法币按 BNB 753 美元、BSC 0.05 gwei 换算。

| 符号 | 参数 | 典型值 | 条件 |
|---|---|---|---|
| `t_WD` | 提现冷静期 / 执行窗口 | 48 h / 7 d | 窗口外须重新申请 |
| `t_SES` | 会话密钥最长有效期 | 30 d | 按通道授权，无撤销，泄露损失以一个通道为上限 |
| `G_SET` | 一次链上结算 | 88 998 gas ≈ $0.0034 | 覆盖此前任意多次调用 |
| `G_CALL` | 单次调用 gas | 0 | 凭证在链下签发 |
| `MAX_CONTRIBUTION` | 维护贡献比例上限 | 2000 bps | 默认 100 bps，服务方可设 0 |

**关于摊销。**一次结算 0.0034 美元。若每 1000 次调用结算一次，单价 0.001 BEM 时 gas 占收入 3.35%，0.01 BEM 时占 0.34%。gas 不是定价的约束，服务方的边际成本才是。

[2.0 承诺什么（稳定、实验性、内部），以及从 1.x 升级](upgrade-2.0.md)

## 路线图

标 DONE 的已经发布；其余都还没有上线，也不承诺日期。完整路线图见 [`docs/ROADMAP.md`](../../ROADMAP.md)。

| 阶段 | 事项 | 内容 |
|---|---|---|
| DONE | 1.0：接口稳定 | SDK 与规范的接口冻结：TAPI-20、21、23、26、27 为 Stable (v1)，测试数据由独立的 Python 验证器核对。1.0 起遵循语义化版本，破坏性修改只在大版本。 |
| DONE | 1.4–1.6：对齐官方 TAP，核验收紧 | 可选的 TAP-10 一致模式；规范改名 TAPI，向官方 TAP 流程提交草稿；修了 1.0 至 1.4 里流式 AI 回执核验可被截断绕过的缺陷（AI 辅助的对抗式审查，不是第三方审计）；流式用量可核验。 |
| DONE | 1.7–1.8：容器代理，阶段 0 | 实验性的 `@tapeapi/sdk/agent`、`tapeapi-verify task` 与 `examples/agent-service`，不强制执行、不需要新合约；1.8 按草稿 #47 收紧核验；1.8.1 把通道与群聊的新标签作为选项提供。 |
| DONE | 2.0：标准即默认 | 不传选项就按 TAP-10 与 TAP-11 §2 解析；通道与群聊默认用 `tape-channel/`、`tape-group/` 标签；`conform: false` 与 `labels: 'v1'` 整个 2.x 保留。同一版首次公开有界代理、美元报价与评价（都是实验性的：托管合约未审计、未部署，主网不可用，只在本地链与测试中可用，今天不收费）。 |
| NEXT | 官方 TAP 评审 | 12 份草稿是尚未合并的拉取请求（#12、#16、#18、#20、#26、#28、#47、#49、#52、#54、#59、#60），另有后续修改在等待编辑处理（TAP-11：#51、#53、#55；TAP-13：#56）。编辑给出编号后我们改引用；合并为 Draft 不等于被采纳。 |
| NEXT | 托管接口的 Standards TAP 与有界代理草稿 | 两份都已提交：规定托管接口的 Standards 草稿为 TapeOutProtocol/TAPs#59，有界代理（阶段 1）的草稿为 #60，两份目前都转为 draft PR，暂不占评审队列。 |
| NEXT | npm 包 | `@tapeapi/sdk` 与 `@tapeapi/server`。今天 SDK 与服务端包都从 GitHub Release 安装。 |
| AFTER AUDIT | 有界代理与付费调用上主网 | 两者都依赖托管合约（TAPI-22）。托管合约要先完成独立审计才会部署，首个实例计划托管 BEM。在此之前所有调用都免费，有界代理只在本地链与测试中可用。 |
| LATER | 容器代理阶段 2：支出金库 | 让代理在限额内调用白名单上的合约，并能立即撤销。需要新合约和独立审计。 |

## 规范索引

| 规范 | 内容 | 状态 |
|---|---|---|
| [TAPI-1](../../../spec/TAPI-1.md) | TapeAPI 的文档流程与状态，含 Stable (vN) | Draft |
| [TAPI-20](../../../spec/TAPI-20.md) | 服务身份与清单，含 AI 价目表（`ai` 字段；公开声明，用户照旧向服务方付款）与多链 | Stable (v1) · §3.5 Experimental |
| [TAPI-21](../../../spec/TAPI-21.md) | 签名响应信封，含 AI 用量回执 | Stable (v1) |
| [TAPI-22](../../../spec/TAPI-22.md) | 计量支付凭证与托管；托管资产 BEM 优先（§3.5），美元报价、BEM 结算（§3.6） | Experimental |
| [TAPI-23](../../../spec/TAPI-23.md) | 多家交叉验证的读取 | Stable (v1) |
| [TAPI-24](../../../spec/TAPI-24.md) | 跨链意图询价 | Withdrawn |
| [TAPI-25](../../../spec/TAPI-25.md) | 可由电路验证的方法 | Experimental |
| [TAPI-26 v2](../../../spec/TAPI-26-v2.md) | 容器间的私密通道，`tape-channel/` 标签；2.0 起为默认 | Stable (v2) |
| [TAPI-27 v2](../../../spec/TAPI-27-v2.md) | 容器间的私密群聊，`tape-group/` 标签；2.0 起为默认 | Stable (v2) |
| [TAPI-26](../../../spec/TAPI-26.md) | 私密通道第 1 版，冻结的 `TAP-26/` 标签；2.x 中用 `labels: 'v1'` | Stable (v1) |
| [TAPI-27](../../../spec/TAPI-27.md) | 私密群聊第 1 版，冻结的 `TAP-27/` 标签；2.x 中用 `labels: 'v1'` | Stable (v1) |

**这些是 TapeAPI 自己的规范，不是 TAP。**TAPI-1 与 TAPI-20 至 TAPI-27 是 TapeAPI 自己的文档名；TAP 由 [TapeOutProtocol/TAPs](https://github.com/TapeOutProtocol/TAPs) 的编辑按 TAP-01 编号。我们就其中部分内容提交了 14 份 TAP 草稿。服务身份与清单已合并为 [TAP-11](https://github.com/TapeOutProtocol/TAPs/blob/main/TAPs/TAP-11.md)（Draft，[#8](https://github.com/TapeOutProtocol/TAPs/pull/8)），签名响应已合并为 [TAP-13](https://github.com/TapeOutProtocol/TAPs/blob/main/TAPs/TAP-13.md)（Draft，[#10](https://github.com/TapeOutProtocol/TAPs/pull/10)）；合并为 Draft 不等于被采纳。其余 12 份是尚未合并的拉取请求，尚无编号（其中 #54、#59、#60 目前转为 draft PR，暂不占用编辑的评审队列）：私密通道 [#12](https://github.com/TapeOutProtocol/TAPs/pull/12)、MCP 工具绑定 [#16](https://github.com/TapeOutProtocol/TAPs/pull/16)、多家交叉验证读取 [#18](https://github.com/TapeOutProtocol/TAPs/pull/18)、私密群聊 [#20](https://github.com/TapeOutProtocol/TAPs/pull/20)、AI 用量回执 [#26](https://github.com/TapeOutProtocol/TAPs/pull/26)、证明核验读取 [#28](https://github.com/TapeOutProtocol/TAPs/pull/28)、容器代理阶段 0 [#47](https://github.com/TapeOutProtocol/TAPs/pull/47)、清单里的代理成员 [#49](https://github.com/TapeOutProtocol/TAPs/pull/49)、付费凭证 [#52](https://github.com/TapeOutProtocol/TAPs/pull/52)、容器间评价 [#54](https://github.com/TapeOutProtocol/TAPs/pull/54)、托管通道 [#59](https://github.com/TapeOutProtocol/TAPs/pull/59)、容器代理阶段 1 [#60](https://github.com/TapeOutProtocol/TAPs/pull/60)。另有 1 份 Information 草稿 [#61](https://github.com/TapeOutProtocol/TAPs/pull/61)（隐私地图），已提交，目前转为 draft PR。后续修改在等待编辑处理：对 TAP-11 的 [#51](https://github.com/TapeOutProtocol/TAPs/pull/51)（删去对 `TAP-26/` 标签的提及）、[#53](https://github.com/TapeOutProtocol/TAPs/pull/53)（两句澄清）、[#55](https://github.com/TapeOutProtocol/TAPs/pull/55)（参考实现更新，加一条以 `resolved` 结束的主网向量），对 TAP-13 的 [#56](https://github.com/TapeOutProtocol/TAPs/pull/56)（参考实现一节里一句过时的话）。编辑审的是格式而不是方案本身。TAPI-20 至 TAPI-27（含 TAPI-26、TAPI-27 的第 2 版）仍是 2.x 兼容性承诺的依据。规范中英双语，以英文为准。

## 状态

2.x 稳定版，遵循语义化版本：按 2.0 文档写的代码在所有 2.x 版本里都能继续工作（标注为实验性的接口除外，包括跟随 Draft 的 `data.status`、`SiteStatus` 与 `svc.conform`）；2.0.0 发布后 1.x 继续获得 6 个月的安全修复。公共服务、MCP 端点与公共中继已上线，ChannelBus 已部署；付费托管合约是实验性的，未审计、尚未部署，有界代理因此主网不可用、只在本地链与测试中可用，今天也不收费；没有经过第三方审计。

## 安全说明

没有经过第三方审计。测试：JS 测试（`npm test`）、合约测试（`forge test`）与独立的 Python 验证器，每次推送都由 CI 运行。

1.0.0 至 1.4.0 的流式 AI 回执核验，在特定分块下可能把被截断或被注入内容的流显示为“已核验”；1.5.0 已修复（[更新说明](https://github.com/BruceLanLan/tapeapi/releases/tag/v1.5.0)）。如何报告漏洞、哪些版本获得安全修复，见 [`SECURITY.md`](../../../SECURITY.md)。
