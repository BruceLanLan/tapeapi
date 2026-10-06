# 从 0.x 升级到 1.0

1.0 是一个承诺：按 1.0 文档写的代码，在所有 1.x 版本里都能继续工作。为了兑现这个承诺，我们在冻结之前把接口又审查了一遍，
把日后难以维持的名字、形状和错误码一次改完。本页列出所有可能让 0.x 代码出错的修改、改成什么写法，以及 1.0 承诺什么、不承诺什么。

## 1.0 承诺什么

`@tapeapi/sdk` 与 `@tapeapi/server` 的全部导出、命令行工具 `tapeapi-mcp` 与 `tapeapi-verify`，以及公共服务
（api.tapeapi.fun、relay.tapeapi.fun）的方法与返回形状，分属三个等级：

| 等级 | 含义 | 怎么看出来 |
|---|---|---|
| **Stable（稳定）** | 1.x 之内没有破坏性修改。新增内容（新的可选选项、新字段、新错误码）可以出现在任何次版本里。 | 没有另外标注的都是 |
| **Experimental（实验性）** | 可能在 1.x 的次版本里改名、改形状或删除，每次修改都写进更新日志。 | 类型声明里的 `@experimental` |
| **Internal（内部）** | 不属于公开接口，任何版本都可能改变。 | `@internal`，或者根本不导出 |

**1.0 中的实验性部分：** 所有与付费有关的接口。TAPI-22 付费通道与托管合约尚未部署、未经审计，ServiceDirectory 也未部署。
包括 `api.payer()`、`api.acceptPrice()` / `api.acceptedPrice()`、调用选项 `payer` 与 `maxPrice`、通道构造器
`api.tx.approve / fund / requestWithdraw / cancelWithdraw / withdraw / authorizeSession / settle / setContribution / register`、
`api.chain.escrow.*`、`api.chain.resolve()` 与 `api.chain.serviceOf()`（以及按目录标签解析；`labelToBytes32`，以及 `abi` 的 `LABEL_RE` / `bytes32ToLabel`）、选项 `directory` 与 `escrow`、
`contribution`、`MAX_CONTRIBUTION_BPS`、`RECOMMENDED_CONTRIBUTION_BPS`、`MAINNET.bem`（支付代币）、`sig` 里的凭证函数、WebMCP 的 `paid` 选项，以及服务端的凭证存储、结算辅助函数和 `createProvider` 的付费选项。
从清单读取价格（`priceBEM`、`parseUnits`、`formatUnits`）是稳定的；错误码 `PAYMENT_REQUIRED`、`BAD_VOUCHER`、`PRICE_CHANGED`
也是稳定的：免费服务的客户端同样可能遇到它们。

同样是实验性的：整个 `@tapeapi/sdk/bus-privacy` 子路径（根入口的 `busPrivacy`）：`busPrivacyReader`、它的模式、全部调优选项与默认值
（`cover`、`contract`、掩护池与预算常量）、`scanCoverPool`、`plausibleRoom`，以及 `stats().privacy` 的形状。这些默认值来自 2026 年 9 月
在主网上的测量，以后可能调整。

**内部：** `abi.FUNCTIONS` 与 `abi.SERVICE_TUPLE`（这张 ABI 表跟着合约走，包括实验性的合约）。`ai` 里参考旁路与网站使用的辅助函数
（`FORWARD_HEADERS`、`SESSION_HEADERS`、`MODEL_ID_MAX`、`forwardsHeader`、`isSessionHeader`、`isAnswerId`、`apiPath`、`completeOf`、
`createSseScanner`、`encodeReceipt`、`receiptComment`、`pricingOf`、`modelEntryOf`、`formatOfMethod`、`envelopeProblems`、
`priceProblems`）。`ai` 里稳定的有：`createVerifyingFetch`、`verifyUsageReceipt`、`validateAIField`、`decodeReceiptHeader`、
`readSseReceipt`、`scanSse`、`usageOf`、`formatFor`、`sha256Hex`、`FORMATS`、`MANIFEST_FIELD`、`RECEIPT_HEADER`、`RECEIPT_METHOD`、
`SIDECAR_ERROR_HEADER`、`VERIFY_ERROR_HEADER`。

## 破坏性修改

在你的代码里搜索第一列的名字。

| 0.x | 1.0 | 原因 |
|---|---|---|
| 配置或参数错误报成 `RPC_UNAVAILABLE`、`MANIFEST_INVALID`、`BAD_VOUCHER`、`ABI_INVALID`、`BAD_KEY`、`CHANNEL_INVALID`、`BAD_REQUEST`、`QUORUM_FAILED`、`METHOD_NOT_FOUND` 或 `GROUP_DELIVERY`；`@tapeapi/server` 没配 `rpcUrls`（原为 `INTERNAL`）；WebMCP 在未暴露任何工具时 `refresh()`、释放后调用工具（原为 `BAD_REQUEST`） | `INVALID_ARGUMENT` | 用一个错误码表示"你自己的选项或参数有误"：在发出任何请求之前报出，重试毫无意义。遇 `RPC_UNAVAILABLE` 重试的循环，不会再因为没配 `rpcUrls` 而空转。见下表。 |
| `e.tooLarge`、`e.rpcCode`、`e.rpcRevert`、`e.rpcData`、`e.agreed`、`e.disagreed`、`e.failed`、`e.groups`、`e.quorum`、`e.reason` | `e.data.tooLarge`、`e.data.rpcCode`…… | `TapeAPIError` 的顶层字段固定为 `name`、`code`、`message`、`data`、`signed`、`httpStatus`、`cause`，签名的提供者错误另有 `ts`、`block`、`id`、`sig`、`error`。旧名字作为弃用别名仍可读取，2.0 删除。 |
| `channel.toHex`、`channel.fromHex`、`channel.toBase64`、`channel.fromBase64` | `abi.toHex`（带 `0x`）、`abi.bytesToHex`（不带）、`abi.hexToBytes`；base64 用平台自带的 | `channel.toHex` 不带 `0x`，`abi.toHex` 带：同一个名字两种含义。 |
| `channel._keySchedule`、`channel._busMerge`、`channel._busKindOf` | 删除 | 测试钩子，不是接口。 |
| `channel.relayTransport({ api, svc, ... })` | `channel.relayTransport({ api, service, ... })` | 已解析的服务在所有地方都叫 `service`。传 `svc` 会被拒绝，并指向本页。 |
| `deliverGroupUpdate({ relay, bus })`、`checkGroupInvites({ relay })` | `deliverGroupUpdate({ relayClients: [...], busClients: [...] })`、`checkGroupInvites({ relayClients: [...] })` | 一律是列表。它们是用来发送和读取的客户端：`relayClients` 的元素是 `{ api, service, payer? }`（TapeAPI 客户端与解析出的中继服务），`busClients` 的元素是 `{ address, sendTx }`。`relays` 是另一回事：`createGroup`、`resumeGroup` 与 `channel.createInvite` 写进名单或邀请里的中继引用列表 `{ url, container }`，这是协议字段（TAPI-26、TAPI-27），名字不变。在这两个投递函数里传 `relay`、`bus`、`relays` 或 `buses` 都会被拒绝，并指向本页。 |
| 中继客户端（`relayClients`）`{ api, svc, payer }` | `{ api, service, payer }` | 同上。 |
| `G.createGroup({ now })`、`G.joinGroup({ now })`（返回毫秒的函数） | `clock`：返回 Unix **秒**的函数（可带小数）；`resumeGroup` 也接受 | SDK 里所有的 `now` 都是 Unix 秒数字（通道握手、`validateManifest`、`verifyUsageReceipt`）；群句柄长期存在，它的时钟叫 `clock`，单位相同。群的 `now` 会被拒绝；返回毫秒（大于 1e11，比如 `Date.now`）的 `clock` 同样会被拒绝。 |
| WebMCP 的 `handle.svc` | `handle.service` | 同上。 |
| `sig.keccak256`、`sig.toHex`、`sig.bytesToHex`、`sig.hexToBytes` | `abi.keccak256`、`abi.toHex`…… | 字节工具只有一个出处。 |
| `@tapeapi/sdk/rpc` 的 `readJsonBounded`、`describeUrl`、`isNodeLimit` | 删除 | 内部辅助函数。`@tapeapi/sdk/rpc` 导出 `createRpc` 与 `RPC_BODY_LIMIT`。 |
| `ai.amountOf`、`ai.pricesOf`、`ai.sseDigestOfPayloads`、`ai.sentinelOf`、`ai.rootOf`、`ai.saltRequestBody`、`ai.SALT_LENGTH`、`ai.CURRENCIES`、`ai.PRICE_UNIT`、`ai.MODELS_MAX`、`ai.ENDPOINTS_MAX`、`ai.ALIASES_MAX`、`ai.PRICES_MAX`、`ai.AMOUNT_DECIMALS`、`ai.EVENT_PARSE_LIMIT`、`ai.FORWARD_PREFIXES`、`ai.SSE_RECEIPT_PREFIX` | 删除 | 只在 SDK 内部与测试中使用。价格运算与哈希由 `verifyUsageReceipt` 完成；各项上限见 TAPI-20 §3.9。 |
| `group.senderKey`、`group.buildEpoch` | 删除 | 群句柄背后的密钥派生与纪元构造；TAPI-27 的测试向量记录了它们。 |
| `@tapeapi/server` 的 `openai-proxy` 子路径、`createOpenAIProxy` | `@tapeapi/server/ai-proxy`、`createAIProxy` | 名不副实的别名：这个旁路也说 Anthropic 的格式。 |
| `createMcpEndpoint(...).handle(request)` | `.handleRequest(request)` | 与 `createProvider`、`createAIProxy`、`createMcpProxy` 一致。 |
| `createMcpEndpoint({ identity: { name } })`、`createMcpProxy({ identity: { name } })` | `{ name }` | SDK 其它地方的 `identity` 指密钥对。传 `identity` 会被拒绝。 |
| `ai-proxy` / `mcp-proxy` 的 `UPSTREAM_TIMEOUT_MS` | `AI_UPSTREAM_TIMEOUT_MS`（600 秒）/ `MCP_UPSTREAM_TIMEOUT_MS`（20 秒） | 同一个名字有两个值。 |
| `ai.createVerifyingFetch` 把计量请求发往另一个主机（`localhost` 对 `127.0.0.1`） | strict：发送前抛 `INVALID_ARGUMENT`，写明期望的端点；非 strict：`onReport` 带 `mismatch: true` | 以前原样放行，既不核验也不报告。 |
| `ai.createVerifyingFetch` 配官方 SDK 的流式回答 | 会核验；strict 下迭代器抛出 `RECEIPT_INVALID` | 官方 SDK 读到最终事件就停止读取，旧的流末尾核验从未执行。现在流在最终事件、`[DONE]` 或连接关闭时结束（先到者为准），strict 下要等结束之前到达的回执核验通过，结束的那一段才放出。 |
| `ai.createVerifyingFetch` 在 strict 下遇到核验不过的整体回答：从 `fetch` 抛出（`RECEIPT_INVALID`） | 返回 HTTP 502：按该 API 的错误格式，code 为 `RECEIPT_INVALID`，带 `x-should-retry: false` 与 `x-tapeapi-verify-error: RECEIPT_INVALID` 两个头；`onReport` 照旧 | 官方 SDK 把抛出的错误包装后默认再重试两次：一份坏回执就是三次请求，每次都可能付费。两个 SDK 都遵守 `x-should-retry`，只发一次就抛出 `APIError`。自己调用这个 fetch 的代码检查 `res.ok`。付费调用在其它 5xx 上是否重试由你决定。 |
| 按容器地址做键的 `channelRecordFloor` 存储 | 键为 `<chainId>:<小写容器地址>` | 其它链的客户端现在共用你传入的存储。0.x 的条目读一次并迁移，无需处理。 |
| `Group = Record<string, any>`（TypeScript） | `GroupHandle`、`OwnerGroup`、`GroupSnapshot`、`Roster` | 有类型的句柄。 |
| `createProvider` 在 `allowHttp: true` 或清单带 `dev: true` 时放宽付费检查 | 只有 `createProvider({ dev: true })` 放宽；`allowHttp` 只允许 http 端点；清单自己的 `dev` 字段不再起作用（`createMcpProxy` 同样） | 发布出去的清单是数据，不是配置；允许 http 也不等于可以不要托管合约。开发环境请传 `dev: true`。 |
| `createTapeAPI({ timeoutMs })`、`chains: { [id]: { timeoutMs } }`、`createProvider({ timeoutMs })` | `rpcTimeoutMs` | 它是单个 RPC 请求的超时；`api.call(..., { timeoutMs })` 是整次调用的超时，名字不变。旧名字会被拒绝。 |
| `api.chain.tokenOf()` 返回的 `tokenId` 是 `bigint` | 十进制字符串 | SDK 返回的所有 `tokenId` 与 `processor` 都是十进制字符串；输入仍接受数字、bigint 或字符串。 |
| 选项对象里拼错或未知的键（TypeScript） | 编译错误 | 选项接口（`CreateProviderOptions`、`ChannelSelf`、`ChannelPeer`、WebMCP 的 `paid`）不再带索引签名。数据形状（`Manifest`、`Invite`、通道记录）仍接受额外字段。 |

### 哪些错误现在是 `INVALID_ARGUMENT`

| 位置 | 0.x 的错误码 |
|---|---|
| `createRpc`：没有 URL、`quorum` 不合法、节点或运营方不足、没有 `fetch`；`rpc.single(url)` 传入不属于它的 URL | `RPC_UNAVAILABLE` |
| 没配 `rpcUrls` 的客户端读链 | `RPC_UNAVAILABLE` |
| `resolve()` 不支持的目标、不合法的 `chainId`、没配 `directory` 却传目录标签；没开 `dev: true` 却解析 `{ dev }`；`forChain()` 未知链；`chainOfContainer('nope')`；`refresh()` 不是来自 `resolve()` 的服务；`registryKey(42)` | `MANIFEST_INVALID` |
| `chain.channelKeys` / `chain.tapeSendKey` 传入的不是容器 | `CHANNEL_INVALID` |
| `payer()` 的选项、不为正数的价格 | `BAD_VOUCHER` |
| `tx.*` 的参数（地址、金额、`bps`）；把免费服务传给付费构造器；没配 `escrow` / `directory`；`publishManifest` / `publishChannelKeys` 的容器不合法 | `ABI_INVALID`、`MANIFEST_INVALID`、`CHANNEL_INVALID` |
| `callQuorum` 没有服务、`quorum` 或 `onDissent` 不合法、服务不是来自 `resolve()`、`compare` 格式不对 | `QUORUM_FAILED`、`BAD_REQUEST` |
| `deliverGroupUpdate` / `checkGroupInvites` 的载体、`invite`、`self`、`cursors`、别的群的更新 | `GROUP_DELIVERY` |
| `createProvider`：没有 `signerKey`、`methods` 不是对象或缺少处理器、`escrow`、`rateLimit`、`minVoucherLifeS` 不合法 | `BAD_KEY`、`METHOD_NOT_FOUND`、`MANIFEST_INVALID` |
| `createAIProxy` / `createMcpProxy` 的选项 | `BAD_REQUEST`、`BAD_KEY`、`MANIFEST_INVALID` |
| 没有服务的 `createVerifyingFetch`；`exposeTapeAPI` / `manifestToTools` 的 `paid` 选项；没有 `info` 的 `createMcpServer` | `MANIFEST_INVALID`、`BAD_REQUEST` |

公共服务的返回形状不变：api.tapeapi.fun 的 `tapeName` 仍以数字返回 `processor`（改动它声明的 `returns` 会改变链上清单，
并让所有钉住它的 `tapeapi-mcp` 拒绝这个服务）。

编解码层不变：无论字节来自你还是来自网络，`abi` 报 `ABI_INVALID`，`canon` 报 `CANON_INVALID`。`callQuorum` 的协议性拒绝
（少于两个提供者、两个服务共用持有人或来源、见证读取没有区块号）仍是 `QUORUM_FAILED`。

有三个模块在整个 1.x 里保留自己的"调用方错误"错误码，处理错误时请一并匹配：通道模块（`channel.*`，TAPI-26）报
`CHANNEL_INVALID`，群聊模块（`group.*`，TAPI-27）报 `GROUP_INVALID`，`api.call()` 在发送前对 `params` 与 `id` 的检查报
`BAD_REQUEST`（与提供者对同一请求的回答相同）。这些错误都不值得重试。

## 错误码

完整列表。提供者错误码在签名信封里传递，含义永不改变（[TAPI-21](../../../spec/TAPI-21.md) §3.2）；客户端错误码由 SDK 报出（§3.4）。

| 错误码 | 类别 | 含义 | 可重试 |
|---|---|---|---|
| `PAYMENT_REQUIRED` | 提供者 | 方法收费但没带凭证，或该链不支持支付 | 否 |
| `BAD_VOUCHER` | 提供者 | 凭证被拒（`data.lastCumulative`、`data.voucher`） | SDK 自动重新同步一次 |
| `METHOD_NOT_FOUND` | 提供者 | 没有这个方法 | 否 |
| `BAD_REQUEST` | 提供者 | 请求本身（`id`、`params`）格式有误；由提供者给出时带签名 | 否 |
| `INTERNAL` | 提供者 | 提供者内部故障；可带 `data.revert` | 是 |
| `TOOLS_CHANGED` | 提供者 | MCP 绑定服务的上游工具与 `toolsSha256` 不再相符 | 否 |
| `RPC_DISAGREE` | 客户端 | 节点给出不同答案 | 是 |
| `BAD_SIGNATURE` | 客户端 | 信封绑定核验失败 | SDK 先重读清单 |
| `MANIFEST_INVALID` | 客户端 | 从链上或端点读到的清单不合格 | 否 |
| `DELEGATION_INVALID` | 客户端 | 委托缺失、过期或不是持有人签的 | 否 |
| `PROVIDER_UNAVAILABLE` | 客户端 | 传输失败；你自己的超时或中止带 `data.timedOut` / `data.aborted` | 是 |
| `RATE_LIMITED` | 客户端 | HTTP 429（`data.retryAfterS`） | 等待之后 |
| `PRICE_CHANGED` | 客户端 | 价格涨到你已同意的价格之上 | 征得同意之后 |
| `QUORUM_FAILED` | 客户端 | 提供者不一致，或作答过少（`data.agreed`、`data.failed`……） | 视情况 |
| `ATTEST_DISAGREE` | 客户端 | 见证读取不一致 | 否 |
| `NOT_FOUND` | 客户端 | 那里没有服务：标签未注册、处理器编号超出范围，或没有通道记录（清单文件缺失为 `MANIFEST_INVALID`）。在 `conform: 'tap10'` 下：`data.status` 为 `no-such-cpu`、`no-such-token` 或 `not-tapeout` | 否 |
| `RPC_UNAVAILABLE` | 客户端 | 作答节点过少 | 是 |
| `RPC_STALE` | 客户端 | 1.2 起，开启实验性的 `pin` 选项时：节点共同确认的区块旧于 `maxPinAgeS`，或比本机时钟超前（`data.ageS`）。1.4 起，`pin: 'tap10'` 或 `conform: 'tap10'` 下：钉块落后最高头块的块数超过 TAP-10 的允许值（`data.status` 为 `stale-block`，`data.lag`、`data.maxLag`） | 是 |
| `CONTRACT_UNKNOWN` | 客户端 | 1.2 起，开启实验性的 `sentinel: 'strict'` 时：TapeOut 身份合约运行着本 SDK 不认识的实现，即合约已被升级（`data.role`、`data.implementation`）。1.4 起，在 `conform: 'tap10'` 下，SiteRegistry 与 DomainBinding 一律如此（`data.status` 为 `store-changed`） | 否：升级 SDK 或核实这次升级 |
| `SITE_STATUS` | 客户端 | 1.4 起，只在实验性的 `conform: 'tap10'` 下：名字存在，但 TAP-10 规定不得使用其站点：`data.status` 为 `unpaid`（未激活）或 `not-opened`（容器从未开通） | 否：只有持有人能改变 |
| `PROOF_INVALID` | 客户端 | 1.3 起，开启实验性的 `proofs`（须同时开 `pin`）时：`fileInfo`、`cpuAt`、`isCPU` 或 `ownerOf` 的默克尔证明已核验通过，但证明出的值与节点的回答不同（`proofs: true` 与 `'strict'` 都拒绝）；或者只在 `'strict'` 下：节点提供的证明对照节点共同确认的区块 stateRoot 全都核验不过（`data.read`、`data.node`、`data.block`、`data.stateRoot`） | 否 |
| `PROOF_UNAVAILABLE` | 客户端 | 1.3 起，开启实验性的 `proofs: 'strict'` 时：没有节点为所钉区块提供 `eth_getProof`，`quorum` 家运营方的节点没有就 stateRoot 达成一致，或合约运行着 SDK 不知道存储布局的实现（`data.read`、`data.reason`）。`proofs: true` 下同样的情况只是警告，并沿用法定数的回答（只是检测） | 是，或加一个提供证明的节点 |
| `RPC_ERROR` | 客户端 | 所有节点返回同一个 JSON-RPC 错误（`data.rpcCode`、`data.rpcRevert`） | 回滚：否 |
| `CANON_INVALID` | 客户端 | JSON 没有规范形式、有重复键或禁用键 | 否 |
| `ABI_INVALID` | 客户端 | ABI 数据无法解码 | 否 |
| `BAD_KEY` | 客户端 | 无法使用的密钥或密钥地址 | 否 |
| `CHANNEL_INVALID` | 客户端 | TAPI-26 数据不合格，或未经当前持有人授权 | 否 |
| `GROUP_INVALID`、`GROUP_EQUIVOCATION` | 客户端 | TAPI-27 数据不合格；群主对同一纪元号签了两个纪元 | 否 |
| `GROUP_DELIVERY` | 客户端 | 全部尝试之后仍有群投递失败（`data` 是投递结果） | 视情况 |
| `BAD_RESPONSE` | 客户端 | 中继或你钱包的 `sendTx` 回答了无法使用的内容 | 否 |
| `BUS_PRIVACY`、`BUS_BUDGET` | 客户端 | 掩护房间不足；按合约读取超出预算 | 否 |
| `TAPESEND_INVALID` | 客户端 | TAP-10 载荷不合格 | 否 |
| `COMPARE_PATH_INVALID` | 客户端 | 某个提供者的结果在 `compare` 路径上不是数字 | 否 |
| `RECEIPT_INVALID` | 客户端 | AI 用量回执缺失或未通过核验 | 否 |
| `BUDGET_EXCEEDED`、`USER_DECLINED` | 客户端 | WebMCP 花费预算；用户拒绝 | 否 |
| `UNSUPPORTED_PAYMENT_TOKEN` | 客户端 | 仅限实验性的付费功能：托管合约的代币不能用于这笔付款。`data.reason`：`token-unreadable`（托管没有 `token()`）、`decimals-unreadable` 或 `decimals-out-of-range`（没有有效的 `decimals()`，或不在 8 到 18 之间）、`not-bem`（清单价格以 BEM 计，而这个托管持有别的代币）、`token-mismatch`（不是你指定的代币）；另有 `data.escrow`、`data.token` | 否 |
| `INVALID_ARGUMENT` | 客户端 | 你自己的选项或参数有误 | **绝不** |
| `METHOD_NOT_ALLOWED` | 提供者路由，不签名 | HTTP 405：对 `/tapeapi/v1/<方法>` 发了 POST 以外的请求。SDK 总是用 POST；客户端遇到它按传输失败处理（`PROVIDER_UNAVAILABLE`） | 否 |
| `NAME_TAKEN` | WebMCP | 出现在 `handle.skipped[].code`：`registerTool` 失败，通常是页面上别的脚本已经注册了同名工具（原因见 `reason`）。不抛出 | 那个工具移除后（`refresh()`） |

位于服务之前的 MCP 服务器（`createMcpProxy`）以 JSON-RPC 错误报告它自己的拒绝，其 `error.data.code` 为
`TOOLS_CHANGED`、`INVISIBLE_CHARACTERS` 或 `UPSTREAM_UNAVAILABLE`。

## TAP-10 一致模式（1.4，实验性）

`createTapeAPI({ conform: 'tap10' })` 按官方 TAP-10 v1.1（§3–§7）与 TAP-11 §2.2 的描述解析服务。默认关闭：不开时 `resolve` 与 `chain.*` 读取的行为与以前完全相同
（有一个测试逐个钉住默认模式的每个请求与结果）。`api.siteStatus()` 在任何模式下都走 TAP-10 路径，所以在默认客户端上 1.5 也改变了它
（见下文 *siteStatus 的变化*）。它覆盖解析路径（1.4，1.5 补全），1.5 起也覆盖消息路径（见本节末尾）。它标为
`@experimental`，在 TAP-10 仍是草案期间随 TAP-10 跟进：结果里记有 `version: '1.1'`。

```js
const api = createTapeAPI({ rpcUrls: rpcUrlsFor(56), conform: 'tap10' })
const svc = await api.resolve('#11@1013')          // 任一 TAP-10 输入形式
const site = await api.siteStatus('11.1013.tape')   // 任何模式：只看身份与站点状态

// 1.5：容器地址或处理器合约#ID，在每条链上查找（也会读 Base 与 X Layer）
const everywhere = createTapeAPI({ rpcUrls: rpcUrlsFor(56), conform: 'tap10', allChains: true })
await everywhere.siteStatus('0x4591b393399452eA24ECB10424CdBA194F1c4E64')   // Base，1.3.1.tape
```

它隐含 `pin: 'tap10'`；同时传别的 `pin` 是 `INVALID_ARGUMENT`。Base 与 X Layer 上的名字、`api.forChain()` 都以同样的模式运行。
`pin: 'tap10'` 也可以单独使用，只要 TAP-10 的钉块、不要其余部分。

**有哪些不同**

- **一次解析一个钉块**（TAP-10 §5.3）：每家运营方只计一次、取其最低头块；钉块为其中第二高者减 2，按区块哈希读取。钉块落后最高头块
  超过 400（BNB Smart Chain）、150（Base）或 300（X Layer）块即拒绝为 `stale-block`。只比较块号，从不看你的时钟。
- **链检查**（TAP-10 §5.4）：每个客户端一次，在读取任何状态之前向每个节点要 `eth_chainId`。`resolve` 用严格共识做这项检查（见下一条），
  与消息路径做的是同一个检查，所以每个客户端一次就同时满足两者；`siteStatus` 用通常的共识（`quorum` 家运营方的节点、所有回答一致）。
  两者都是：有节点在别的链上即为分歧（拒绝），节点全在别的链上即 `wrong-chain`。只有结果与回滚算节点的回答，其它 JSON-RPC 错误算节点故障。
- **授权签名者的读取用严格共识**（TAP-11 §2.2）：`ownerOf`，以及持有人是合约时的 EIP-1271 读取（`eth_getCode` 与 `isValidSignature`，
  委托与 `contentSig` 两处），只有每个配置的节点回答都相同、且回答来自至少 max(2, min(3, 运营方数)) 家运营方时才采用（TAP-10 §5.2），
  `resolve` 的链检查也是如此。不作答的节点，以及尚未到达钉块的节点（TAP-10 §1："没有该区块"不是回答），都不计入这个数目。用默认节点时：
  - BNB Smart Chain，3 家运营方（NodeReal、Alchemy、48 Club）：严格共识需要全部 3 家，所以一个节点宕机或落后于钉块，`resolve` 就报
    `unavailable`（`RPC_UNAVAILABLE`），而默认模式照常；
  - Base，4 家运营方（Coinbase、Allnodes、dRPC、Tenderly）：严格共识需要 3 家，所以一个节点宕机仍能解析，两个就不行；
  - X Layer，2 家运营方（OKX、dRPC）：严格共识需要 2 家，与法定数相同：没有变化。

  解析的其它读取仍用通常的共识，`api.siteStatus()` 也是（它不授权任何东西）。节点答得不同，两种模式都一如既往地拒绝（绝不按多数）。
  错误信息会说明这是严格读取、需要几家运营方。
- **输入**：链上名字（`4246.0.tape`）、短名字（`4246.0`）、显示标签（`#4246@0`、`#1@3.1`）、`tape://` 或 `web+tape://` URL、容器地址、
  处理器合约#ID（`0x50A9…9DD9#4246`）。其它任何东西（包括目录标签）都是输入错误。最后两种不带链信息：见下文*无链信息的输入*。
- **身份**：`cpuCount` 与 `cpuAt`、由容器开通器推导容器（并由 `sentinel` 与本地 ERC-6551 推导互验）、`ownerOf`、`isOpened`。对容器地址
  （`token()`、`isCPU`，然后开通器必须推导出这个地址本身）与处理器合约#ID，也会找出处理器号（1.5 起），因此它们也有链上名字、能完整检查
  激活（见下文*查找处理器号*）。
- **站点状态**，按 TAP-10 §6.2 的顺序：`store-changed`（SiteRegistry 或 DomainBinding 运行着本 SDK 未列出的实现：不论 `sentinel`
  怎么设都拒绝），然后 `no-such-cpu` / `no-such-token` / `not-tapeout`，然后 `not-opened`，然后 `unpaid`（`isLive(链上名字, 容器)` 与
  `isContainerLive(容器)` 都不为真；上一版 DomainBinding 没有 `isContainerLive`，按 TAP-10 §6.3，它的回滚按假处理。`isLive` 的回滚也按假
  处理，这一点 TAP-10 没有规定：接受列表里的实现对它不会回滚，只有未知实现才可能，而未知实现已先被拒为 `store-changed`）。
- **清单**：`chunkCount` 为 0 即 `no-manifest`；文件须为合法 UTF-8 且不带字节序标记；其中的 `circuits`、`tokenId`、`container` 只与解析
  结果比对，绝不采用。
- **缓存**：两次解析之间只保留处理器表。`api.call()` 之前，超过 60 秒的服务会重新解析；若结果是 `unpaid`（或其它结论），调用停止，
  不再使用保留的清单。

**结果长什么样。** 解析成功的服务带 `svc.conform` 与 TAP-10 的 `svc.pinned`：

```js
svc.conform  // { version: '1.1', status: 'resolved', site: 'ok', chainId: 56, name: '11.1013.tape', processor: '1013',
             //   tokenId: '11', circuits, container, holder, opened: true,
             //   activation: { live: true, isLive: false, isContainerLive: true },
             //   implementations: [{ role: 'siteRegistry', ..., accepted: true }, { role: 'binding', ..., accepted: true }],
             //   pinned: { number, hash, lag, maxLag } }
svc.pinned   // { number, hash, timestamp, tag: 'tap10', by: 'hash', mode: 'tap10', lag: 2, maxLag: 400 }
```

`api.siteStatus(target)` 返回同样的对象，`status` 为 `ok`、`unpaid`、`not-opened`、`store-changed`、`no-such-cpu`、`no-such-token` 或
`not-tapeout`；它不读清单，任何模式下都能用，站点状态绝不抛错（只有输入错误、`unsupported`、`ambiguous`、`wrong-chain` 与读不到时才抛）。
在所有链上搜索的输入会多出 `chains`（`svc.conform` 里也有）：各条链的结果，本客户端的链在前，例如
`[{ chainId: 56, status: 'not-tapeout' }, { chainId: 196, status: 'not-tapeout' }, { chainId: 8453, status: 'ok' }]`。

**无链信息的输入（1.5，`allChains`）。** 以字符串给出的容器地址或处理器合约#ID 不指明链。TAP-10 §4.1 要在每条活跃链上各自钉块解析它，
这意味着要向 Base 与 X Layer 的节点发请求（`chains[id].rpcUrls` 里你自己的节点，或 SDK 对该链的默认节点）。只配了你自己 BNB Smart Chain
节点的客户端不应该自作主张去访问别的链的公共节点，所以这是一个单独的开关 `allChains: true`，`api.forChain()` 会把它传下去：

| 各链的结果 | 结论 |
|---|---|
| 两条及以上的链命中（Base 与 X Layer 的工厂地址相同，那里的 1 号处理器是同一个合约） | `INVALID_ARGUMENT`，`data.status` 为 `ambiguous`，`data.candidates` 每条链一项（带链上名字），不论第三条链如何：请传链上名字 |
| 一条链命中 | 用那条链；但处理器合约#ID 在另一条链读不到（`unavailable`、`stale-block`、`wrong-chain`）或为 `store-changed` 时，报那条链的状态，带 `data.chainId` 与 `data.candidates`。容器地址只可能是一条链的容器，所以命中的容器就是那条链的 |
| 没有链命中 | 报读不到的那条链的状态，绝不报 `not-tapeout`；否则为 `no-such-token`（某条链有该处理器却没有该 #ID）或 `not-tapeout` |

不开 `allChains` 时不会向别的链发任何请求：容器地址是本链容器时在本链解析（其 ERC-6551 地址只属于一条链，所以这是完整的答案），否则为
`unsupported`。在 `conform: 'tap10'` 下，处理器合约#ID 字符串在发出任何请求之前即为 `unsupported`，因为 TAP-10 只在恰好一条链命中时才
解析它；默认客户端的 `siteStatus` 与 1.4 一样在本客户端的链上解析它。只有 `true` 才开启 `allChains`，其它值一律忽略（1.4 就忽略这个选项）。
`{ circuits, tokenId, chainId? }` 指明链（不给 `chainId` 即本客户端的链），`{ chainId, container }` 自带链：都不搜索。不带 `chainId` 的
`{ container }` 与以前一样是输入错误。`allChains` 只作用于 TAP-10 路径（`conform: 'tap10'` 下的 `resolve`，以及任何模式下的 `siteStatus`）；
默认的 `resolve` 从不读它。

所有链搜索与 `sentinel`（TapeAPI 自己的检查，不是 TAP-10 的）的关系：默认的 `'warn'` 下，没被选中的链在身份阶段产生的警告不报告；结果为
`ambiguous` 时，它们在 `data.candidates[i].warnings` 里。`sentinel: 'strict'` 下，容器开通器推导出的地址与 ERC-6551 不同的链 fail-closed：
它在 `chains[].status` 里显示为 `container-mismatch`（TapeAPI 自己的名字，不是 TAP-10 §4.1 的状态），并按"无法判定"的链处理。

**siteStatus 的变化（1.5，任何模式）。** 它会找出容器地址或处理器合约#ID 的处理器号（结果里的 `name` 与 `processor` 不再是 null，并会查询
`isLive`；冷启动的客户端为此读 `cpuCount` 与 `cpuAt`，见下文）；对在该链上没有代码的地址，`{ chainId, container }` 为 `not-tapeout`
（1.4 为 `unsupported`）；开启 `allChains` 时在所有链上搜索。

**查找处理器号（1.5）。** 工厂没有反查表，TAP-10 §4.3 逐个扫 `cpuAt(i)`；冷启动在 BNB Smart Chain 上每个节点要上千次请求，公共节点会限流。
SDK 随版本带上每条链的处理器表快照（`sdk/src/processors-snapshot.js`，发版前经默认节点只读生成；2026-10-01（UTC）：
BNB Smart Chain 1,174 个、X Layer 263 个、Base 101 个，各记有读取时的区块、数量与节点运营方；快照时间用 UTC，在 UTC+8 已是 2026-10-02）。命中只需在钉块上读一次 `cpuAt`，读回的地址必须相同
才会使用。快照之后新建的处理器，在链与快照一致时（`cpuCount` 不小于快照数量，且快照最后一项读回不变）只扫描较新的编号；否则，或工厂不是
该链自己的，就扫描全部编号。扫描每页 8 个，每次解析至多 256 个，下次从停下处继续；找到之前结果为 `unavailable`（`data.scan`）。读到的
一切在客户端的整个生命周期内保留（编号只增不减），名字解析读到的编号也一样。快照约 75 KB 源码，在任何模式下都随 SDK 一起加载
（SDK 是不用动态导入的浏览器普通模块），即使只解析名字也一样。

**错误。** 一致模式的每个错误都在 `error.data.status` 里带 TAP-10 / TAP-11 的名字，请按它分支。错误码沿用现有的，只新增一个：

| `data.status` | `code` |
|---|---|
| `input-error`、`unsupported`（见下文）、`ambiguous`（1.5）、`wrong-chain` | `INVALID_ARGUMENT` |
| `no-such-cpu`、`no-such-token`、`not-tapeout` | `NOT_FOUND` |
| `unavailable`、`stale-block` | `RPC_UNAVAILABLE` / `RPC_DISAGREE`、`RPC_STALE` |
| `store-changed`，以及 `hub-changed`\* | `CONTRACT_UNKNOWN` |
| `not-opened`、`unpaid` | **`SITE_STATUS`**（新增） |
| `no-manifest`、`incomplete`、`no-hash`、`manifest-invalid`，以及 `container-mismatch`\* | `MANIFEST_INVALID` |
| `delegation-invalid` | `DELEGATION_INVALID` |

\* 只在 `sentinel: 'strict'` 下、只由 `resolve` 抛出，绝不出现在 `siteStatus` 里：它们是 TapeAPI 自己加的检查，TAP-10 解析站点时不做。
`hub-changed` 与 TAP-10 §13.8 的同名条件相同（hub 运行着未列出的实现）；`container-mismatch` 表示容器开通器推导出的地址与本地按 ERC-6551
算出的不同。

`SITE_STATUS` 表示名字存在、清单也可能完全合格，但 TAP-10 规定不得使用该站点。重试没用；只有电路的持有人能改变它（用
`DomainBinding.bind` 激活，或开通容器）。

**我们自己的服务。** `11.1013.tape`（api.tapeapi.fun）与 `12.1013.tape`（relay.tapeapi.fun）在持有人于 2026-10-01 激活之前，
在 `conform: 'tap10'` 下都是 `unpaid`（`DomainBinding.bind`，120 个月，付到 2036-08-09）；现在两者都能解析（`status: 'resolved'`）。
没有激活、或付款已到期的名字，在这个模式下是 `SITE_STATUS`、`data.status` 为 `unpaid`；默认模式照常解析。

**激活只约束合规客户端。** TAP-10 §6.3 说得很明白：费用靠合规客户端只显示已激活的站点来落实，不是任何技术上的封锁。数据仍是公开、
可读的；默认模式不检查激活，消息读取（`chain.channelKeys`、`chain.tapeSendKey`）在任何模式下也不检查：TAP-10 §12.2 规定激活不得阻止消息。

**需要知道的局限。**

- *不开 `allChains` 时的容器地址与处理器合约#ID*（`unsupported`）。在本链不是容器、或 `token()` 声称别的链的地址，可能是别的链上的容器；
  处理器合约#ID 字符串可能在不止一条链上命中：不开 `allChains` 时两者都是 `INVALID_ARGUMENT`、`data.status` 为 `unsupported`，绝不是
  `not-tapeout`（TAP-10 §4.1 只允许在读遍所有活跃链之后下这个结论）。请传 `allChains: true`、带 `chainId` 的对象形式，或链上名字。（1.4 中，
  不知道处理器号的容器或处理器合约#ID 除非 `isContainerLive` 为真，也是 `unsupported`；1.5 能找到处理器号，这种情况已不存在；处理器合约#ID
  字符串在一致模式下不开 `allChains` 时现在一律拒绝，即使 1.4 曾在本客户端的链上解析过它。）代价是实在的：TAP-10 自己的第一个测试用例
  `0x50A994E71615474b55559fF4F500928fbc339DD9#4246` 在一致模式下要开 `allChains: true` 才能解析，否则是 `unsupported`；开启后，BNB 链上的
  处理器合约#ID 也取决于 Base 与 X Layer 能否读取：X Layer 的默认节点只有两家运营方，一家宕机就会让这类输入变成 `unavailable`。名字
  （`4246.0.tape`）没有这两种代价。
- *公共节点上的新处理器。* 快照之后新建的处理器要扫描此后新建的编号（每个发版周期只是少量请求）；对快照未覆盖的工厂，头几次查找可能要
  好几次解析，在扫到之前每次都是 `unavailable`。每个版本都带新的快照，及时升级 SDK 就能让扫描保持很短。
- *只有两家运营方的链。* 钉块为第二高的运营方头块减 2。某条链的节点只来自两家运营方时（X Layer 的默认节点：OKX 与 dRPC），一家报出较低的
  头块，就能把钉块往回拖，最多拖到该链的最大钉块滞后（X Layer 为 300 块，约五分钟），读取就在那里进行：诚实节点会照实提供那份较旧的状态，
  而且会被接受；默认模式的 `latest` 读取在这种情况下只会出现分歧。有三家及以上运营方时（BNB Smart Chain、Base），一家的低头块不会移动钉块。
  但它对严格读取仍然有影响：BNB Smart Chain 默认只有三家运营方，头块低于钉块的节点答不了钉块上的 `ownerOf`，`resolve` 在它追上之前都是
  `unavailable`（Base 的四家留有一家余量）。如果你在意 X Layer 上的钉块，请在 `chains[196].rpcUrls` 里加一个第三家运营方的节点。

  这个窗口对清单意味着什么：节点只来自两家运营方的链上（使用默认节点的 X Layer），一家运营方宕机或作恶，就能把钉块拖回到限度
  允许的最旧处：`pin: true` 下是不超过 `maxPinAgeS` 的区块（X Layer 为 600 秒，约 600 块），`pin: 'tap10'` 或
  `conform: 'tap10'` 下是落后头块不超过 `tap10MaxPinLag` 块（X Layer 为 300 块）。在这个窗口里，客户端读到的是当时的清单，即换签名者、
  涨价或缩短委托之前的那一份。`delegationFloor` 只拒绝 `expires` 比已见过的更低的委托，所以挡不住那份更早、期限更长的委托。这是
  钉块有意容忍的滞后（TAP-10 钉块的容忍写在 TAP-10 §5.3 里），不是绕过某项检查；加一家第三运营方的节点才能消除它。

### 消息路径（1.5）

在 `conform: 'tap10'` 下，`api.chain.tapeSendKey(target)` 与 `api.chain.channelKeys(container)`（因而 `groupVerifier` 也是）同样按 TAP-10
读取。默认模式不变。

- **读取。** 每次查询钉一个新鲜的块（TAP-10 §5.3），每个读取都用**严格共识**（§5.2）：问遍所有配置的节点，回答必须全部相同，且来自至少
  max(2, min(3, 运营方数)) 家运营方。因此在 BNB Smart Chain 的三家默认运营方上，一个节点宕机或落后于钉块就会停下消息路径（`RPC_UNAVAILABLE`、
  `unavailable`），而默认模式与 `siteStatus` 照常（本模式的 `resolve` 也会停下）；Base 的四家留有一家余量，X Layer 的两家上严格共识所需
  不超过法定数。TAP-10 对消息就是这样要求的，否则少数串通的节点就能把加密引向别处。第一次查询之前，客户端同样用严格共识检查 `eth_chainId`
  （§5.4）；`resolve` 的检查就是这个严格检查、可以共用，`siteStatus` 的不算。（钉块所需的区块请求与这一检查同时发出；两者都成功之前不读任何状态。）容器取自容器开通器（§4.3：`token()`、
  `isCPU`、`opener.accountOf` 等于给出的地址），持有人取自同一块上的 `ownerOf`。与 `resolve` 相同，可能属于别的链的输入（在本链不是容器的
  地址、`token()` 声称别的链、在本链不是处理器的处理器合约）为 `INVALID_ARGUMENT`、`data.status` 为 `unsupported`，绝不是 `not-tapeout`
  （TAP-10 §4.1），也不缓存：请用 `api.forChain(chainId)`。
- **绝不判激活或开通。** TAP-10 §12.2：未付费的名字、站点存储实现变更或阻止名单条目都不得阻止消息。`resolve` 与 `siteStatus` 判为 `unpaid` 或
  `not-opened` 的容器，其 TapeSend 密钥与通道记录照常可读（结果里报告 `opened`）。`tapeSendKey` 既不读 SiteRegistry 也不读 DomainBinding。
  通道记录是容器站点里的文件，所以 `channelKeys` 要求两者的实现都被接受（`store-changed`），与私密通道草稿 §3.3 一致。
- **中枢**（`tapeSendKey`，TAP-10 §13.8）：在同一块上，中枢的实现必须是 TAP-10 列为该链当前的那个（否则 `hub-changed`，不论 `sentinel`
  怎么设），电路信标必须仍运行中枢构造时的电路实现（否则 `circuits-changed`；一旦见到，本客户端一直保留）。封存状态会读取并报告在
  `result.tap10.seal`（`{ factory, hub }`，目前都是 `false`：还没有任何封存），但不作要求。以 `conform: 'tap10'` 创建的客户端只接受 TAP-10
  为该链列出的中枢、处理器工厂与容器开通器（TAP-10 §2.2；其它一律 `INVALID_ARGUMENT`）。粘性状态与客户端同生命周期（含 `forChain` 的子客户端）；
  要跨重启保留，请传 `sealStatusStore`：与 `channelRecordFloor` 一样的 `{ get, set }` 存储，键为 `<chainId>:<小写 hub>`，值为
  `{ circuitsChangedAt, factorySealSeenAt, factorySealLost }`。
- **密钥**（§12.2、§14.4 第 1–3 步）：`hub.keyFor` 必须指向解析出的容器与其端点（`hub-mismatch`），必须可用（从未发布为 `no-key`，其它为
  `key-stale`），套件为 1，并通过 X25519 密钥检查（`bad-key`；默认模式要到握手时才查）。第 4 步，即收件方是否读你发送所在的链，由你判断：
  结果带 `chainsBitmap`，即二进制的位图，第 0 位（最右一位）是 BNB Smart Chain，第 1 位 Base，第 2 位 X Layer（TAP-10 §2.1）。发送
  （TAP-10 §20）同样由你负责：解析你自己的端点并确认已开通、持有人是所连钱包（第 2 步），把收件方的密钥、`keyIndex` 与持有人和你记录的比对
  （第 3 步，`key-changed`），签名前再读一次密钥（第 6 步）。
- **记录**：按 TAP-10 §7.1 读文件（`chunkCount` 为 0 即 `not-found`、`no-hash`、`incomplete`），按严格 UTF-8 解码且不得带字节序标记（默认模式
  会去掉它），再做 TAPI-26 §3.1 的检查（`record-invalid`），持有人的 EIP-1271 认可在同一块上读取。站点存储一旦 `store-changed` 就完全不读。
  记录与结论照旧缓存（至多 300 秒），结论连同其 `data.status`；节点故障与 `unsupported` 绝不缓存。从缓存给出的记录，其 `tap10.pinned` 是放进
  缓存那次读取的块；要新的请传 `{ fresh: true }`。
- **端点**：`tapesend.endpoint`、`seal`、`open`、`messageId` 与 `sendTx` 接受 `conform: 'tap10'`，此时拒绝任何大于 2^53 − 1 的 chainId
  （TAP-10 §12.1），包括 32 字节端点里的链号。不传时上限仍为 2^64 − 1。

结果带 `tap10`：`tapeSendKey` 给出 `{ version: '1.1', status: 'ok', pinned, endpoint, hub, circuits, seal }`，`channelKeys` 给出
`{ version: '1.1', status: 'ok', pinned, implementations }`。错误：

| `data.status` | `code` |
|---|---|
| `wrong-chain`、`input-error`、`unsupported` | `INVALID_ARGUMENT` |
| `unavailable`、`stale-block` | `RPC_UNAVAILABLE` / `RPC_DISAGREE`、`RPC_STALE` |
| `hub-changed`、`circuits-changed`、`store-changed` | `CONTRACT_UNKNOWN` |
| `no-such-token`、`no-key`、`key-stale` | `NOT_FOUND` |
| `not-tapeout`（本链容器，其电路未通过检查）、`hub-mismatch`、`bad-key`、`not-found`、`no-hash`、`incomplete`、`record-invalid` | `CHANNEL_INVALID` |

`not-found` 与 `record-invalid` 是 TapeAPI 起的名字（TAP-10 没有为记录定义结果名）；其余都是 TAP-10 的。中枢的 `Upgraded` 日志（§13.8 的
SHOULD，需要 `eth_getLogs`）不读。

**尚未覆盖。** 1.5.0 起，一致模式覆盖 resolve 路径（含 `ownerOf` 与 EIP-1271 的严格共识）与上面的消息路径、无链信息的输入在所有链上
解析（`ambiguous`），以及容器或处理器合约的处理器号。在这些路径之内，仍有一项没做：TAP-10 §13.8 对中枢 `Upgraded` 日志的扫描，这是
有条件的 SHOULD（有提供 `eth_getLogs` 的节点时，读取中枢的每条 `Upgraded` 日志，只有其中每个实现都是初始实现或 TAP-10 列出的实现才接受
中枢）。`tapeSendKey` 只查中枢当前的实现槽，看不到在一笔交易内改写存储、又恢复为被接受实现的升级。

## 现已冻结的格式

这些内容由 SDK 或工具写进你的存储，所以 1.x 能读 1.0 写下的内容：

- `channelRecordFloor`：键 `<chainId>:<小写容器地址>`，值为整数（Unix 秒）。
- `checkGroupInvites` 的游标：键 `relay:<中继容器>:<房间>`，值 `{ after, epoch }`。
- 群的 `snapshot()`：`{ v: 1, gid, owner, epoch, role, lastSeq?, roster? }`。
- `tapeapi-mcp` 的钉住文件（`~/.tapeapi/mcp-pins.json`，`v: 1`）。

## 命令行工具

`tapeapi-mcp` 与 `tapeapi-verify` 的选项不变。两者的退出码都是 0（正常退出）、1（运行时失败）或 2（用法错误），且不读取任何
环境变量。`tapeapi-verify --strict` 在流结束（最终事件或 `[DONE]`）之前没有核验通过的回执时，现在以错误事件结束流，并且只转交完整
的事件：回执被剥掉时，流会以失败结束，而不是在流结束之后才报失败。
