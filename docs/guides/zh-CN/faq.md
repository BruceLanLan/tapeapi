[English](../faq.md) | 中文

# 常见问题与排障

## 一般问题

**运行免费服务需要部署合约吗？**
不需要。身份、清单和委托都使用 TapeOut 已部署的合约（DeWebHub、SiteRegistry、处理器工厂）。只有付费服务需要托管合约，
链上通道需要 ChannelBus。

**TapeAPI 收费吗？**
不收。没有协议费，也没有运营方的费用开关。每个提供者可以自行选择向维护金库作一笔自愿贡献（默认为 0）；无论是否贡献，
调用的效果都一样。见 [`docs/FEES.md`](../../FEES.md)。

**如果我出售或转让电路会怎样？**
服务随之转移：容器、其站点以及签署委托的权利。旧持有者的委托不再被接受，因为客户端会对照当前持有者检查委托。

**用哪条链？**
BNB Smart Chain（chainId 56），也就是 TapeOut 所在的链。

## 调用服务

**`ERR_MODULE_NOT_FOUND: Cannot find package '@tapeapi/sdk'`**：这些包尚未发布到 npm，要通过仓库的 workspace 解析。
克隆仓库，在其中运行 `npm install`，并把你的脚本保存在 `tapeapi` 目录之内（[调用服务](consume.md)）。

**`MANIFEST_INVALID: ... does not match`**：容器站点中的文件与其链上哈希不一致，或者没有清单。该服务没有被正确发布。

**`DELEGATION_INVALID`**：委托已过期，或者电路在委托签署之后易主。提供者必须签署一份新的委托，并重新发布清单。

**`RPC_UNAVAILABLE: only 1/2 nodes answered`**：至少使用三个 RPC URL 并设置 `quorum: 2`，这样一个节点宕机时仍能凑够
法定人数。`allowSingleNode: true` 仅用于本地开发。

**`RPC_DISAGREE`**：节点对同一次读取返回了不同的字节。SDK 会重试一次；若持续出现，说明某个节点落后或行为异常。

**回答的 `ts` 被拒绝**：你的时钟或服务的时钟偏差超过 300 秒。请校准时钟；这个时间窗口（`maxSkewS`）用于防御被重放的回答。

## 运行服务

**控制台提示服务报告的密钥与此处生成的不同。**
服务的 `SIGNER_KEY` 不是在该页面上生成的密钥（粘贴了两次、用了旧密钥，或服务 URL 填错）。重新粘贴第 5 步中的密钥，
并等待重新部署完成。

**控制台拒绝发布："unexpected field" / "expected ..."。**
服务所提供的清单与你读取并签署的内容不同。通常是某个变量尚未生效；等一分钟再重试。

**`putFile` 以 `NotOwner` 回滚。**
容器尚未开通，或者该钱包不是电路的持有者。在电路页面上开通容器（0.012 BNB）。

**我的钱包把 BNB 换成了 WBNB。**
gas 只能用原生 BNB 支付。请在持有者的钱包里保留少量原生 BNB。

## 链上通道

**读取器报错 `no node serves logs`。**
它的起点早于节点所保留的历史（publicnode：约 10,000 个区块）。这一范围内的帧无法从这些节点读取；请从更新的区块开始，
或添加一个归档节点。BNB Chain dataseed 节点（示例默认）完全不提供 `eth_getLogs`，所以读 ChannelBus 至少需要一个提供它的
节点：请用 SDK 的 `BUS_RPC_URLS`（48 Club 与 1RPC 保留至少 500,000 个区块的日志）。中继传输不依赖这一点。

**读取器停住了很长时间。**
某个节点在游标所在的区块上持续出错。停住是有意为之：只要某个节点可能仍保有某一帧，该帧就绝不会被跳过。在
`SERVED_DECAY`（20）次轮询都没有回答之后，该节点不再被等待，并且你会收到通知。

**我在 ChannelBus 上的消息是私密的吗？**
内容是端到端加密的。每条消息的房间、大小和时间则永久公开。

## 获取帮助

bug 和问题请在 GitHub 上提 issue。安全问题请按照 [SECURITY.md](../../../SECURITY.md) 处理，不要提公开 issue。
