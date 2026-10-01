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
| `INVALID_ARGUMENT` | 客户端 | 你自己的选项或参数有误 | **绝不** |
| `METHOD_NOT_ALLOWED` | 提供者路由，不签名 | HTTP 405：对 `/tapeapi/v1/<方法>` 发了 POST 以外的请求。SDK 总是用 POST；客户端遇到它按传输失败处理（`PROVIDER_UNAVAILABLE`） | 否 |
| `NAME_TAKEN` | WebMCP | 出现在 `handle.skipped[].code`：`registerTool` 失败，通常是页面上别的脚本已经注册了同名工具（原因见 `reason`）。不抛出 | 那个工具移除后（`refresh()`） |

位于服务之前的 MCP 服务器（`createMcpProxy`）以 JSON-RPC 错误报告它自己的拒绝，其 `error.data.code` 为
`TOOLS_CHANGED`、`INVISIBLE_CHARACTERS` 或 `UPSTREAM_UNAVAILABLE`。

## TAP-10 一致模式（1.4，实验性）

`createTapeAPI({ conform: 'tap10' })` 按官方 TAP-10 v1.1（§3–§7）与 TAP-11 §2.2 的描述解析服务。默认关闭：不开时 1.x 的行为与以前完全相同
（有一个测试逐个钉住默认模式的每个请求与结果）。它只覆盖**解析路径**；TAP-10 的其余部分在后续版本跟上（见本节末尾）。它标为
`@experimental`，在 TAP-10 仍是草案期间随 TAP-10 跟进：结果里记有 `version: '1.1'`。

```js
const api = createTapeAPI({ rpcUrls: rpcUrlsFor(56), conform: 'tap10' })
const svc = await api.resolve('#11@1013')          // 任一 TAP-10 输入形式
const site = await api.siteStatus('11.1013.tape')   // 任何模式：只看身份与站点状态
```

它隐含 `pin: 'tap10'`；同时传别的 `pin` 是 `INVALID_ARGUMENT`。Base 与 X Layer 上的名字、`api.forChain()` 都以同样的模式运行。
`pin: 'tap10'` 也可以单独使用，只要 TAP-10 的钉块、不要其余部分。

**有哪些不同**

- **一次解析一个钉块**（TAP-10 §5.3）：每家运营方只计一次、取其最低头块；钉块为其中第二高者减 2，按区块哈希读取。钉块落后最高头块
  超过 400（BNB Smart Chain）、150（Base）或 300（X Layer）块即拒绝为 `stale-block`。只比较块号，从不看你的时钟。
- **链检查**：每个客户端一次，向每个节点要 `eth_chainId`，按通常的共识采用（`quorum` 家运营方的节点、所有回答一致）：一个节点宕机不会
  停掉一致模式，有节点在别的链上即为分歧（拒绝），节点全在别的链上即 `wrong-chain`。（TAP-10 §5.4 对消息客户端要求的严格共识随消息路径
  一起做。）只有结果与回滚算节点的回答，其它 JSON-RPC 错误算节点故障。
- **输入**：链上名字（`4246.0.tape`）、短名字（`4246.0`）、显示标签（`#4246@0`、`#1@3.1`）、`tape://` 或 `web+tape://` URL、容器地址、
  处理器合约#ID（`0x50A9…9DD9#4246`）。其它任何东西（包括目录标签）都是输入错误。
- **身份**：`cpuCount` 与 `cpuAt`、由容器开通器推导容器（并由 `sentinel` 与本地 ERC-6551 推导互验）、`ownerOf`、`isOpened`。
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
`not-tapeout`；它不读清单，任何模式下都能用，站点状态绝不抛错（只有输入错误、`unsupported`、`wrong-chain` 与读不到时才抛）。

**错误。** 一致模式的每个错误都在 `error.data.status` 里带 TAP-10 / TAP-11 的名字，请按它分支。错误码沿用现有的，只新增一个：

| `data.status` | `code` |
|---|---|
| `input-error`、`unsupported`（见下文）、`wrong-chain` | `INVALID_ARGUMENT` |
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

**为什么我们自己的服务是 `unpaid`。** `11.1013.tape`（api.tapeapi.fun）与 `12.1013.tape`（relay.tapeapi.fun）尚未激活：2026-09-30
两者的 `isLive` 与 `isContainerLive` 都为假，2026-10-01 再读 `11.1013.tape` 仍是如此。在 `conform: 'tap10'` 下，它们在持有人付费之前都解析为
`SITE_STATUS`、`data.status` 为 `unpaid`；默认模式照常解析。

**激活只约束合规客户端。** TAP-10 §6.3 说得很明白：费用靠合规客户端只显示已激活的站点来落实，不是任何技术上的封锁。数据仍是公开、
可读的；默认模式不检查激活，消息读取（`chain.channelKeys`、`chain.tapeSendKey`）在任何模式下也不检查：TAP-10 §12.2 规定激活不得阻止消息。

**需要知道的局限。**

- *容器地址与处理器合约#ID*（`unsupported`）。这类输入不带处理器号，1.4 也找不回来，所以没有链上名字，无法查询 `isLive`。`isContainerLive`
  为真时站点为 `ok`；为假或回滚时，一致模式不报 `unpaid`（该容器可能只按名字付过费），而是抛出 `INVALID_ARGUMENT`、`data.status` 为
  `unsupported`：请传链上名字（例如 `4246.0.tape`）。客户端解析过该处理器的某个名字之后就知道其编号，这类输入便能完整判定。可能属于别的链的
  输入（在本链不是容器的地址、`token()` 声称别的链、在本链不是处理器的处理器合约）同样是 `unsupported`，绝不是 `not-tapeout`：TAP-10 §4.1
  只允许在读遍所有活跃链之后下这个结论。请用 `api.forChain(chainId)` 或名字。
- *只有两家运营方的链。* 钉块为第二高的运营方头块减 2。某条链的节点只来自两家运营方时（X Layer 的默认节点：OKX 与 dRPC），一家报出较低的
  头块，就能把钉块往回拖，最多拖到该链的最大钉块滞后（X Layer 为 300 块，约五分钟），读取就在那里进行：诚实节点会照实提供那份较旧的状态，
  而且会被接受；默认模式的 `latest` 读取在这种情况下只会出现分歧。有三家及以上运营方时（BNB Smart Chain、Base），一家的低头块会被忽略。
  如果你在意这一点，请在 `chains[196].rpcUrls` 里加一个第三家运营方的节点。

**尚未覆盖。** 这并不意味着"TapeAPI 已符合 TAP-10"。仍待完成（计划在 1.5）：无链信息的输入在所有活跃链上解析并给出 `ambiguous`；由容器或
处理器合约找回处理器号（这会消除上面第一条局限）；消息路径（严格的 `eth_chainId` 与 `keyFor`、通道记录、端点上限）；`ownerOf` 与 EIP-1271
的严格共识。

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
