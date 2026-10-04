# Roadmap / 路线图

> English is authoritative. 中文见下半部分，章节编号一一对应。

This page says what exists today, what we are working on next, and what comes later. It has no dates: we give a date
only when we can stand behind it. Order within a section is not a promise either. For what has actually shipped, see
the [changelog](../CHANGELOG.md).

## 1. Now (live)

The current release is **1.7.1** (2026-10-05): container agents, experimental, phase 0. What each release added is in
the [changelog](../CHANGELOG.md); in short:

- **Container agents** (1.7, experimental, phase 0): `@tapeapi/sdk/agent` (mandates, task threads, a read-only payment
  check, `forWallet`), `tapeapi-verify task` and [`examples/agent-service/`](../examples/agent-service/). The holder
  signs a mandate, the agent delivers, the principal accepts, and payment is a plain transfer anyone can verify; no new
  contract. Phase 0 has no on-chain enforcement and a mandate limits no spending; the subpath is outside the 1.x
  compatibility promise. See the [container agents guide](guides/container-agents.md).
- **Streamed usage you can check** (1.6, opt-in `requestUsage`) and **streamed AI receipts that fail when a stream is cut
  short or has content added** (1.5); see the [AI providers guide](guides/ai-providers.md#the-usage-of-a-streamed-chat-answer-three-ways).
- **The TAP-10 conformance mode** (1.4 to 1.5, experimental, off by default); see
  [Upgrading to 1.0](guides/upgrade-1.0.md#the-tap-10-conformance-mode-14-experimental).

- **Public service** at `https://api.tapeapi.fun`, TapeOut name `11.1013.tape`: eight free, signed
  methods, pinned to a block except `blockNumber` (block number, balances, token and NFT reads, pair price, BNB/USD, name lookup). See the
  [Public API guide](guides/public-api.md).
- **MCP server** at `https://api.tapeapi.fun/mcp`: the same eight methods as MCP tools for Claude, Cursor and any MCP
  client, added by URL with nothing to install. Every result is signed and carries a receipt anyone can verify against
  the chain. See the [MCP guide](guides/mcp.md).
- **Tape out your MCP server** (available, not a hosted service): a signing proxy you run in front of your own MCP
  server, with Node or as a Cloudflare Worker ([`examples/mcp-proxy/`](../examples/mcp-proxy/)), and holder console
  support for publishing its manifest. Your server gets an on-chain identity, tool definitions pinned by `toolsSha256`
  in the on-chain manifest, and a signature on every result. No third-party MCP server has been taped out yet. See
  [Tape out your own MCP server](guides/mcp.md#tape-out-your-own-mcp-server).
- **Public relay** at relay.tapeapi.fun (`12.1013.tape`) for end-to-end encrypted channels between containers (TAPI-26).
- **ChannelBus** on BNB Chain at `0x486110c35d9b90a9d6D85c8063A065f9e7b6b707`: a stateless, ownerless event bus that
  carries channel frames on-chain when no relay is wanted.
- **Playground** at [tapeapi.fun/playground](https://tapeapi.fun/playground/): resolve any service by name, see every
  check the SDK makes, call it, copy the code.
- **Status page** at [tapeapi.fun/status](https://tapeapi.fun/status/), with a monitor scheduled about every 30 minutes
  (GitHub may delay scheduled runs) that opens a GitHub issue when a service is down or a delegation has fewer than 14 days left.
- **Docs** at [tapeapi.fun/docs](https://tapeapi.fun/docs/), in English and Chinese, generated from
  [`docs/guides/`](guides/).
- **Holder console** at [tapeapi.fun/console](https://tapeapi.fun/console/): take a service live, publish its manifest
  and sign its delegation from a phone wallet.
- **Specifications** TAPI-20 to TAPI-27 (TapeAPI's own specs; not TAPs, which the editors of TapeOutProtocol/TAPs number; eight TAP drafts are submitted there, of which the service manifest (TAP-11) and signed responses (TAP-13) are merged as Drafts, and six are under review), the SDK and the provider runtime, used from this repository.
  Since 1.0.0, TAPI-20, TAPI-21, TAPI-23, TAPI-26 and TAPI-27 are Stable (v1) (TAPI-20 §3.5, the service directory, is
  Experimental); TAPI-22 and TAPI-25 are Experimental.

## 2. Next

- **Container agents, phase 1: enforcement on an escrow channel.** The limits in a mandate enforced by a contract. This
  needs a new contract and an independent audit; nothing is deployed before the audit.
- **TAP draft for container agents.** A draft for the mandate and task messages, which today follow the public
  discussions TapeOutProtocol/TAPs#40 and #41, is planned; it has not been submitted.
- **Escrow changes before it goes to audit.** The escrow gets another round of changes (custody assets among them, see
  section 3) before the audit; it stays undeployed until then.
- **Developer dashboard, full version.** A read-only *My services* page is live at https://tapeapi.fun/dashboard/ (add
  service names; see health, delegation expiry, links to try or renew). Next: list the circuits you hold automatically
  (needs an index), and renew and manage them from the same page.
- **Receipt-grounded reputation.** Reviews of a service that only a caller can write, and only with a signed receipt
  for its own request; the reviewer must itself be a container. A review then costs a real call and a real circuit.
- **npm packages** `@tapeapi/sdk` and `@tapeapi/server`. Today both install from each GitHub release (the SDK first,
  then the server), or are used from a clone of this repository.
- **TAP drafts in the official process.** We submitted eight TAP drafts to TapeOut's TAP process
  ([TapeOutProtocol/TAPs](https://github.com/TapeOutProtocol/TAPs), TAP-01) on 2026-09-30 and 2026-10-01, all written
  against TAP-10. The service identity and manifest was merged as [TAP-11](https://github.com/TapeOutProtocol/TAPs/blob/main/TAPs/TAP-11.md) (Draft, [#8](https://github.com/TapeOutProtocol/TAPs/pull/8), 2026-10-01); a merge
  into Draft is not adoption. Signed responses were merged as [TAP-13](https://github.com/TapeOutProtocol/TAPs/blob/main/TAPs/TAP-13.md) (Draft, [#10](https://github.com/TapeOutProtocol/TAPs/pull/10), 2026-10-04), likewise not adoption. Six more are under review and have no number yet: private
  channels [#12](https://github.com/TapeOutProtocol/TAPs/pull/12), MCP tool binding [#16](https://github.com/TapeOutProtocol/TAPs/pull/16), attested reads [#18](https://github.com/TapeOutProtocol/TAPs/pull/18), private groups [#20](https://github.com/TapeOutProtocol/TAPs/pull/20), AI usage receipts [#26](https://github.com/TapeOutProtocol/TAPs/pull/26)
  and proof-verified reads [#28](https://github.com/TapeOutProtocol/TAPs/pull/28); #16 and #18 have passed the format review, and the drafts they require (TAP-11, TAP-13) are now merged.
  The drafts list, under Backwards Compatibility, where TapeAPI's own 1.x behaviour differs from TAP-10; the SDK follows TAP-10 in an optional mode (`conform: 'tap10'`, experimental: the resolution path since 1.4, all-chain resolution, the messaging path and strict reads since 1.5), and its default behaviour does not change before 2.0. TAPI-20 to
  TAPI-27 remain the basis of the 1.x compatibility promise.

## 3. Later

- **Container agents, phase 2: a spending vault.** An agent spending a container's funds within limits. It too needs a
  contract and an audit first.
- **Escrow audit, then paid calls.** The paid-call escrow (TAPI-22, `contracts/src/TapeAPIEscrow.sol`) is written and
  tested but **not deployed**. It will be deployed only after an independent third-party audit; paid calls start
  after that. Until then every live method is free. The version that goes to audit has the default 1% contribution
  (a provider can set 0; the contract caps it at 20% since 1.7) and is planned to settle in USDT (Binance-Peg) first, with BEM and WBNB on demand. See [SECURITY.md](../SECURITY.md).
- **Service directory.** A place to find services by what they do. It is for discovery only: resolution always goes
  to the chain, and a listing never changes what a client trusts.

## 4. What we will not do

- Charge a mandatory protocol fee, or give the operator a fee switch or a pause in the escrow. The escrow's default 1%
  maintenance contribution comes out of the provider's share, and any provider can set it to 0 ([FEES.md](FEES.md)).
- Make a client depend on an endpoint we run in order to resolve or verify a service. Resolution and verification stay
  free and on-chain.
- Let a directory or a listing override what the chain says.

## 5. Having a say

Open an [issue](https://github.com/BruceLanLan/tapeapi/issues) for a feature or a service you need. A change to a
specification starts as a *spec proposal (TAPI)* issue; see [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## 1. 现在（已上线）

当前版本是 **1.7.1**（2026-10-05）：容器代理，实验性，阶段 0。每一版加了什么见[更新日志](../CHANGELOG.md)；简要如下：

- **容器代理**（1.7，实验性，阶段 0）：`@tapeapi/sdk/agent`（授权书、任务线程、只读的付款核验、`forWallet`）、`tapeapi-verify task`
  与 [`examples/agent-service/`](../examples/agent-service/)。持有人签授权书，代理交付，委托方验收，付款是一笔任何人都能核验的普通转账；
  不需要新合约。阶段 0 没有链上强制执行，授权书不限制花钱；该子路径不受 1.x 兼容承诺约束。见[容器代理指南](guides/zh-CN/container-agents.md)。
- **流式用量可核验**（1.6，可选的 `requestUsage`）与**被截断或被追加内容的流不再核验通过**（1.5）；见
  [AI 服务方指南](guides/zh-CN/ai-providers.md#流式-chat-的用量三条路)。
- **TAP-10 一致模式**（1.4 至 1.5，实验性，默认关闭）；见[升级到 1.0](guides/zh-CN/upgrade-1.0.md#tap-10-一致模式14实验性)。

- **公共服务** `https://api.tapeapi.fun`，TapeOut 名称 `11.1013.tape`：八个免费、签名的方法（除 `blockNumber` 外都锚定区块）
  （区块号、余额、代币与 NFT 读取、交易对价格、BNB/USD、名称查询）。见[公共 API 指南](guides/zh-CN/public-api.md)。
- **MCP 服务器** `https://api.tapeapi.fun/mcp`：同样的八个方法作为 Claude、Cursor 和任何 MCP 客户端的工具，按网址添加，
  无需安装。每个结果都有签名，并附带任何人都能对照链上核验的回执。见 [MCP 指南](guides/zh-CN/mcp.md)。
- **Tape out 你的 MCP 服务器**（可以使用，不是托管服务）：你自己运行、放在自己 MCP 服务器前面的签名代理，可用 Node
  运行或部署成 Cloudflare Worker（[`examples/mcp-proxy/`](../examples/mcp-proxy/)），持有人控制台支持发布它的清单。
  你的服务器由此获得链上身份、由链上清单里的 `toolsSha256` 钉住的工具定义，以及每个结果上的签名。目前还没有任何第三方
  MCP 服务器被 tape out。见 [Tape out 你自己的 MCP 服务器](guides/zh-CN/mcp.md#tape-out-你自己的-mcp-服务器)。
- **公共中继** relay.tapeapi.fun（`12.1013.tape`），用于容器之间的端到端加密通道（TAPI-26）。
- **ChannelBus** 已部署在 BNB Chain，地址 `0x486110c35d9b90a9d6D85c8063A065f9e7b6b707`：无状态、无所有者的事件总线，
  不想用中继时在链上承载通道帧。
- **调试台** [tapeapi.fun/playground](https://tapeapi.fun/playground/)：按名称解析任意服务，查看 SDK 做的每一项核对，
  调用并复制代码。
- **状态页** [tapeapi.fun/status](https://tapeapi.fun/status/)，配有定时监控，大约每 30 分钟运行一次（GitHub 可能推迟定时任务）：服务挂了或委托不足 14 天到期时
  自动开 GitHub issue。
- **手册** [tapeapi.fun/docs](https://tapeapi.fun/docs/)，中英双语，由 [`docs/guides/`](guides/) 生成。
- **持有人控制台** [tapeapi.fun/console](https://tapeapi.fun/console/)：用手机钱包让服务上线、发布清单、签署委托。
- **规范** TAPI-20 至 TAPI-27（TapeAPI 自己的规范；不是 TAP，TAP 由 TapeOutProtocol/TAPs 的编辑编号；我们已向那里提交 8 份 TAP 草稿，其中服务清单（TAP-11）与签名回答（TAP-13）已合并为 Draft，另 6 份在评审中），以及 SDK 与提供者运行时，目前从本仓库使用。自 1.0.0 起，TAPI-20、TAPI-21、
  TAPI-23、TAPI-26 与 TAPI-27 为 Stable (v1)（稳定；TAPI-20 §3.5 服务目录为实验性）；TAPI-22 与 TAPI-25 为实验性。

## 2. 接下来

- **容器代理阶段 1：托管通道上的强制执行。** 让授权书里的限额由合约执行。需要新合约和独立审计；审计之前不部署任何东西。
- **容器代理的 TAP 草稿。** 授权书与任务消息目前跟随公开讨论 TapeOutProtocol/TAPs#40 与 #41，计划为它们另写一份草稿；尚未提交。
- **托管合约送审前的改造。** 托管合约在送审前还要再改一版（包括托管资产，见第 3 节）；在那之前一直不部署。
- **开发者控制台（完整版）。** 只读版*我的服务*已在 https://tapeapi.fun/dashboard/ 上线（添加服务名，查看健康、
  委托到期、试用和续期链接）。接下来：自动列出你持有的电路（需要索引），并在同一页面完成续期与管理。
- **凭回执的信誉。** 只有调用方才能评价一个服务，而且必须持有该服务为它自己的请求签发的回执；评价者本身也必须是一个容器。
  这样每条评价都要付出一次真实调用和一个真实电路的代价。
- **npm 包** `@tapeapi/sdk` 与 `@tapeapi/server`。目前两者都从每个 GitHub Release 安装（先装 SDK，再装服务端包），或在本仓库的克隆目录里使用。
- **按官方流程提交 TAP 草稿。** 2026-09-30 至 10-01，我们向 TapeOut 的 TAP 流程
  （[TapeOutProtocol/TAPs](https://github.com/TapeOutProtocol/TAPs)，TAP-01）提交了 8 份草稿，一律按 TAP-10 写。
  服务身份与清单已合并为 [TAP-11](https://github.com/TapeOutProtocol/TAPs/blob/main/TAPs/TAP-11.md)（Draft，[#8](https://github.com/TapeOutProtocol/TAPs/pull/8)，2026-10-01）；合并为 Draft 不等于被采纳。签名响应已合并为 [TAP-13](https://github.com/TapeOutProtocol/TAPs/blob/main/TAPs/TAP-13.md)（Draft，[#10](https://github.com/TapeOutProtocol/TAPs/pull/10)，2026-10-04），同样不等于被采纳。另有 6 份在评审中、
  尚无编号：私密通道 [#12](https://github.com/TapeOutProtocol/TAPs/pull/12)、MCP 工具绑定 [#16](https://github.com/TapeOutProtocol/TAPs/pull/16)、多家交叉验证读取 [#18](https://github.com/TapeOutProtocol/TAPs/pull/18)、私密群聊 [#20](https://github.com/TapeOutProtocol/TAPs/pull/20)、
  AI 用量回执 [#26](https://github.com/TapeOutProtocol/TAPs/pull/26)、证明核验读取 [#28](https://github.com/TapeOutProtocol/TAPs/pull/28)；其中 #16、#18 已通过格式审查，它们要求的草稿（TAP-11、TAP-13）现已合并。
  草稿在 Backwards Compatibility 里列出 TapeAPI 自己的 1.x 行为与 TAP-10 的不同；SDK 以可选模式（`conform: 'tap10'`，实验性：解析路径自 1.4，全链解析、消息路径与 strict 读取自 1.5）跟上 TAP-10，2.0 之前默认行为不变。TAPI-20 至 TAPI-27 仍是 1.x 兼容性承诺的依据。

## 3. 更远

- **容器代理阶段 2：支出金库。** 让代理在限额内花容器的钱。同样要先有合约和审计。
- **托管合约审计，然后才有付费调用。** 付费调用的托管合约（TAPI-22，`contracts/src/TapeAPIEscrow.sol`）已写好并有
  测试，但**未部署**。只有通过独立第三方审计后才会部署，付费调用在那之后才开始。在此之前所有线上方法都免费。
  送审的版本带默认 1% 的维护贡献（提供者可设为 0；自 1.7 起合约上限为 20%），并计划首先支持 USDT（Binance-Peg）结算，BEM 与 WBNB 按需。
  见 [SECURITY.md](../SECURITY.md)。
- **服务目录。** 按功能查找服务的地方，只用于发现：解析永远以链上为准，登记与否不改变客户端信任什么。

## 4. 我们不会做的事

- 收强制协议费，或给托管合约加运营方费率开关或暂停开关。托管合约默认的 1% 维护贡献从提供者所得中划出，任何提供者都
  可以把它设为 0（[FEES.md](FEES.md)）。
- 让客户端必须经过我们运营的端点才能解析或验证服务。解析与验证始终免费、在链上完成。
- 让目录或登记凌驾于链上事实之上。

## 5. 参与决定

需要某个功能或服务，请开 [issue](https://github.com/BruceLanLan/tapeapi/issues)。规范改动从 *spec proposal (TAPI)*
issue 开始，见 [CONTRIBUTING.md](../CONTRIBUTING.md)。
