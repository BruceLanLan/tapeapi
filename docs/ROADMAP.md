# Roadmap / 路线图

> English is authoritative. 中文见下半部分，章节编号一一对应。

This page says what exists today, what we are working on next, and what comes later. It has no dates: we give a date
only when we can stand behind it. Order within a section is not a promise either. For what has actually shipped, see
the [changelog](../CHANGELOG.md).

## 1. Now (live)

The current release is **2.1.0** (2026-10-17), which adds the experimental `tapeapi connect`; 2.0.0 (2026-10-12) made standards the default. What each release added is in the
[changelog](../CHANGELOG.md); in short:

- **Standards by default** (2.0). With no options, `createTapeAPI()` resolves a service the way TapeOut's official TAPs
  say (TAP-10 v1.1 §3 to §7 and TAP-11 §2): one pinned block per resolution, strict agreement of the nodes on the chain
  and the owner, and a status from the TAPs (`e.data.status`; names only grow; experimental in 2.0) for a name that was
  never opened (`not-opened`), is not activated or paid up (`unpaid`), or whose site store or payment contract changed
  (`store-changed`). `conform: false` keeps the 1.x resolution (deprecated, kept in all of 2.x); `tapeapi-verify`,
  `tapeapi-mcp` and `tapeapi-doctor` take `--no-conform`. TAP-10 and TAP-11 are Drafts, so the default follows their
  text by one rule: a loosening or a new status name in a 2.x minor release, a tightening first as an optional profile
  and the default in 3.0. One known exception: without `allChains`, a processor contract#ID such as `0x…#4246` is
  refused (`data.status: 'unsupported'`, a name of TapeAPI's own), where TAP-11 §2.1 says a client must accept it; pass
  `allChains: true` to resolve it on every chain as TAP-10 §4.1 says (this also queries the nodes of Base and X Layer). Private channels and groups use version 2 of their specs by default (`tape-channel/` and `tape-group/`
  labels; `labels: 'v1'` for a 1.x peer). See [Upgrading to 2.0](guides/upgrade-2.0.md).
- **Bounded agents** (2.0, experimental, **not usable on mainnet**). An agent may spend for a container, and the most it
  can lose is fixed by escrow channels and checkable on chain: the phase-1 checks
  (`{ enforcement: 'escrow-channel' }`), the holder's plan and close-out, the agent's spend limiter, and orders that
  resume after a restart with the keys and order records sealed. The escrow contract is not audited and not deployed,
  so this is checked on local chains and in tests only.
- **Prices in US dollars, paid in BEM, and reviews between containers** (2.0, experimental): the reference
  implementations of the TAP drafts #52 (TAPI-22 §3.6) and #54 (`@tapeapi/sdk/review`). No escrow is deployed, so
  nothing is charged.
- **Container agents, phase 0** (1.7 to 1.8, experimental): `@tapeapi/sdk/agent` (mandates, task threads, a read-only
  payment check, `forWallet`), `tapeapi-verify task` and [`examples/agent-service/`](../examples/agent-service/). See
  the [container agents guide](guides/container-agents.md).
- **Streamed usage you can check** (1.6, opt-in `requestUsage`) and **streamed AI receipts that fail when a stream is cut
  short or has content added** (1.5); see the [AI providers guide](guides/ai-providers.md#the-usage-of-a-streamed-chat-answer-three-ways).

- **Public service** at `https://api.tapeapi.fun`, TapeOut name `11.1013.tape`: eight free, signed
  methods, pinned to a block except `blockNumber` (block number, balances, token and NFT reads, pair price, BNB/USD, name lookup). See the
  [Public API guide](guides/public-api.md).
- **MCP server** at `https://api.tapeapi.fun/mcp`: the same eight methods as MCP tools for Claude, Cursor and any MCP
  client, added by URL with nothing to install. Every result is signed and carries a receipt anyone can verify against
  the chain. See the [MCP guide](guides/mcp.md).
- **Tape out your MCP server** (available, not a hosted service): a signing proxy you run in front of your own MCP
  server, with Node or as a Cloudflare Worker ([`examples/mcp-proxy/`](../examples/mcp-proxy/)), and holder console
  support for publishing its manifest. No third-party MCP server has been taped out yet. See
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
- **Specifications** TAPI-20 to TAPI-27 (TapeAPI's own specs; not TAPs). TAPI-20, TAPI-21 and TAPI-23 are Stable (v1);
  TAPI-26 v2 and TAPI-27 v2 are Stable (v2) and the SDK's default since 2.0, and their version 1 stays Stable (v1)
  (`labels: 'v1'`); TAPI-20 §3.5 (the service directory), TAPI-22 and TAPI-25 are Experimental. TAPI-20 to TAPI-27
  remain the basis of the 2.x compatibility promise.

## 2. Next

- **The official TAP review.** We submitted fourteen TAP drafts to TapeOut's TAP process
  ([TapeOutProtocol/TAPs](https://github.com/TapeOutProtocol/TAPs), TAP-01), all written against TAP-10: eight on
  2026-09-30 and 2026-10-01, two on the container-agent formats on 2026-10-04 and 2026-10-05, two on 2026-10-08, and two
  on 2026-10-13.
  The service identity and manifest was merged as [TAP-11](https://github.com/TapeOutProtocol/TAPs/blob/main/TAPs/TAP-11.md)
  (Draft, [#8](https://github.com/TapeOutProtocol/TAPs/pull/8), 2026-10-01) and signed responses as
  [TAP-13](https://github.com/TapeOutProtocol/TAPs/blob/main/TAPs/TAP-13.md) (Draft, [#10](https://github.com/TapeOutProtocol/TAPs/pull/10), 2026-10-04);
  a merge into Draft is not adoption. Twelve are open pull requests with no number yet (three of them, #54, #59 and #60, are draft PRs for now, so they don't take the editors' queue): private channels
  [#12](https://github.com/TapeOutProtocol/TAPs/pull/12), MCP tool binding [#16](https://github.com/TapeOutProtocol/TAPs/pull/16),
  attested reads [#18](https://github.com/TapeOutProtocol/TAPs/pull/18), private groups [#20](https://github.com/TapeOutProtocol/TAPs/pull/20),
  AI usage receipts [#26](https://github.com/TapeOutProtocol/TAPs/pull/26), proof-verified reads [#28](https://github.com/TapeOutProtocol/TAPs/pull/28),
  container agent mandates and task messages, phase 0 [#47](https://github.com/TapeOutProtocol/TAPs/pull/47), the agent
  member of the service manifest [#49](https://github.com/TapeOutProtocol/TAPs/pull/49), payment vouchers (prices in
  US dollars, settled in BEM) [#52](https://github.com/TapeOutProtocol/TAPs/pull/52), evidence-backed reviews between
  containers [#54](https://github.com/TapeOutProtocol/TAPs/pull/54), escrow channels for paying container services
  (Standards) [#59](https://github.com/TapeOutProtocol/TAPs/pull/59) and container agent mandates enforced by escrow channels, phase 1 [#60](https://github.com/TapeOutProtocol/TAPs/pull/60). One more draft, an Information draft on a privacy map for container sites, messages and services, [#61](https://github.com/TapeOutProtocol/TAPs/pull/61), is submitted and open as a draft PR for now. Follow-up edits are waiting for the editors:
  to TAP-11, [#51](https://github.com/TapeOutProtocol/TAPs/pull/51) (drops the `TAP-26/` label mention),
  [#53](https://github.com/TapeOutProtocol/TAPs/pull/53) (`priceBEM` as a per-call upper bound for a later TAP; where the
  escrow's chain is named) and [#55](https://github.com/TapeOutProtocol/TAPs/pull/55) (the reference implementation
  brought up to date, with a mainnet vector that ends in `resolved`); to TAP-13,
  [#56](https://github.com/TapeOutProtocol/TAPs/pull/56) (an outdated sentence in its reference implementation section).
  When the editors assign numbers, we rename our references.
- **Stable status names, after the review.** Once TAP-11 is in Review and its review period ends with no unresolved
  objection, we will consider raising `data.status`, `SiteStatus` and `svc.conform` to Stable. This is a
  consideration, not a promise, and it has no date.
- **A Standards TAP for the escrow interface, and the bounded-agents draft.** Both are submitted: the escrow interface
  as a Standards draft, [#59](https://github.com/TapeOutProtocol/TAPs/pull/59), and the draft for bounded agents (phase 1), [#60](https://github.com/TapeOutProtocol/TAPs/pull/60); both are open as draft PRs for now.
- **Escrow: audit, then deployment.** The audit candidate (v3) is in the repository; the first instance is planned to
  hold BEM (TAPI-22 §3.5). It stays undeployed until an independent audit is done, so no channel exists, no call is
  charged, and bounded agents run on local chains and in tests only.
- **Developer dashboard, full version.** A read-only *My services* page is live at https://tapeapi.fun/dashboard/ (add
  service names; see health, delegation expiry, links to try or renew). Next: list the circuits you hold automatically
  (needs an index), and renew and manage them from the same page.
- **npm packages** `@tapeapi/sdk` and `@tapeapi/server`. Today both install from each GitHub release (the SDK first,
  then the server), or are used from a clone of this repository.

## 3. Later

- **Bounded agents and paid calls on mainnet.** Both rely on the escrow (TAPI-22, `contracts/src/TapeAPIEscrow.sol`),
  which is written and tested but **not deployed**. It will be deployed only after an independent third-party audit;
  paid calls and bounded agents on mainnet start after that. Until then every live method is free. The version that
  goes to audit has the default 1% contribution (a provider can set 0; the contract caps it at 20%) and is planned to
  hold BEM first, with the USDT peg (Binance-Peg) and WBNB on demand. See [SECURITY.md](../SECURITY.md).
- **Container agents, phase 2: a spending vault.** An agent calling whitelisted contracts within per-call and total
  caps, with immediate revocation. It needs a new contract and an audit first.
- **Service directory.** A place to find services by what they do. It is for discovery only: resolution always goes
  to the chain, and a listing never changes what a client trusts.

## 4. What we will not do

- Charge a mandatory protocol fee, or give the operator a fee switch or a pause in the escrow. The escrow's default 1%
  maintenance contribution comes out of the provider's share, and any provider can set it to 0 ([FEES.md](FEES.md)).
- Make a client depend on an endpoint we run in order to resolve or verify a service. Resolution and verification stay
  free and on-chain.
- Let a directory or a listing override what the chain says.
- Fall back silently. A configuration the default resolution cannot follow (your own addresses, a local chain) is an
  error that names `conform: false`, never a quiet switch to another rule.
- Make input that resolves fail within 2.x just to keep up with a Draft. A tightening in the TAP texts is offered first
  as an optional profile, and becomes the default only in 3.0.

## 5. Having a say

Open an [issue](https://github.com/BruceLanLan/tapeapi/issues) for a feature or a service you need. A change to a
specification starts as a *spec proposal (TAPI)* issue; see [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## 1. 现在（已上线）

当前版本是 **2.1.0**（2026-10-17），新增实验性的 `tapeapi connect`；2.0.0（2026-10-12）起标准即默认。每一版加了什么见[更新日志](../CHANGELOG.md)；简要如下：

- **标准即默认**（2.0）。不传任何选项，`createTapeAPI()` 就按 TapeOut 官方 TAP（TAP-10 v1.1 §3 至 §7 与 TAP-11 §2）解析服务：
  每次解析钉一个区块，链 ID 与持有人要所有节点一致；名字从未开通（`not-opened`）、未激活或付费到期（`unpaid`）、站点存储或付费
  合约换了实现（`store-changed`），都给出 TAP 里的状态（`e.data.status`；状态名只增不改；2.0 里仍是实验性的）。`conform: false`
  保留 1.x 的解析方式（已弃用，整个 2.x 保留）；`tapeapi-verify`、`tapeapi-mcp`、`tapeapi-doctor` 都接受 `--no-conform`。
  TAP-10 与 TAP-11 还是 Draft，默认按一条规则跟随它们的文本：放宽与新增状态名在 2.x 次版本里生效，收紧先作为可选 profile、
  默认到 3.0 才切。一个已知例外：不开 `allChains` 时，形如 `0x…#4246` 的"处理器合约#ID"会被拒绝（`data.status: 'unsupported'`，
  这是 TapeAPI 自己的名字），而 TAP-11 §2.1 要求接受它；传 `allChains: true` 即按 TAP-10 §4.1 读遍所有链解析（会同时访问
  Base 与 X Layer 的节点）。私密通道与群聊默认使用规范第 2 版
  （`tape-channel/`、`tape-group/` 标签；与 1.x 对端通信用 `labels: 'v1'`）。见[升级到 2.0](guides/zh-CN/upgrade-2.0.md)。
- **有界代理**（2.0，实验性，**主网不可用**）。代理可以替容器花钱，最多会亏多少由托管通道定死、可在链上核对：阶段 1 的核验
  （`{ enforcement: 'escrow-channel' }`）、持有人的计划与收尾、代理的累计限额器，以及重启后接着处理订单（钥匙与订单记录加密
  保存）。托管合约未经审计、未部署，所以只在本地链与测试中验证。
- **美元报价、BEM 结算，以及容器之间的评价**（2.0，实验性）：TAP 草稿 #52（TAPI-22 §3.6）与 #54（`@tapeapi/sdk/review`）的
  参考实现。托管合约没有部署，所以不收任何费用。
- **容器代理，阶段 0**（1.7 至 1.8，实验性）：`@tapeapi/sdk/agent`（授权书、任务线程、只读的付款核验、`forWallet`）、
  `tapeapi-verify task` 与 [`examples/agent-service/`](../examples/agent-service/)。见[容器代理指南](guides/zh-CN/container-agents.md)。
- **流式用量可核验**（1.6，可选的 `requestUsage`）与**被截断或被追加内容的流不再核验通过**（1.5）；见
  [AI 服务方指南](guides/zh-CN/ai-providers.md#流式-chat-的用量三条路)。

- **公共服务** `https://api.tapeapi.fun`，TapeOut 名称 `11.1013.tape`：八个免费、签名的方法（除 `blockNumber` 外都锚定区块）
  （区块号、余额、代币与 NFT 读取、交易对价格、BNB/USD、名称查询）。见[公共 API 指南](guides/zh-CN/public-api.md)。
- **MCP 服务器** `https://api.tapeapi.fun/mcp`：同样的八个方法作为 Claude、Cursor 和任何 MCP 客户端的工具，按网址添加，
  无需安装。每个结果都有签名，并附带任何人都能对照链上核验的回执。见 [MCP 指南](guides/zh-CN/mcp.md)。
- **Tape out 你的 MCP 服务器**（可以使用，不是托管服务）：你自己运行、放在自己 MCP 服务器前面的签名代理，可用 Node
  运行或部署成 Cloudflare Worker（[`examples/mcp-proxy/`](../examples/mcp-proxy/)），持有人控制台支持发布它的清单。目前还没有
  任何第三方 MCP 服务器被 tape out。见 [Tape out 你自己的 MCP 服务器](guides/zh-CN/mcp.md#tape-out-你自己的-mcp-服务器)。
- **公共中继** relay.tapeapi.fun（`12.1013.tape`），用于容器之间的端到端加密通道（TAPI-26）。
- **ChannelBus** 已部署在 BNB Chain，地址 `0x486110c35d9b90a9d6D85c8063A065f9e7b6b707`：无状态、无所有者的事件总线，
  不想用中继时在链上承载通道帧。
- **调试台** [tapeapi.fun/playground](https://tapeapi.fun/playground/)：按名称解析任意服务，查看 SDK 做的每一项核对，
  调用并复制代码。
- **状态页** [tapeapi.fun/status](https://tapeapi.fun/status/)，配有定时监控，大约每 30 分钟运行一次（GitHub 可能推迟定时任务）：服务挂了或委托不足 14 天到期时
  自动开 GitHub issue。
- **手册** [tapeapi.fun/docs](https://tapeapi.fun/docs/)，中英双语，由 [`docs/guides/`](guides/) 生成。
- **持有人控制台** [tapeapi.fun/console](https://tapeapi.fun/console/)：用手机钱包让服务上线、发布清单、签署委托。
- **规范** TAPI-20 至 TAPI-27（TapeAPI 自己的规范，不是 TAP）。TAPI-20、TAPI-21、TAPI-23 为 Stable (v1)；TAPI-26 v2 与
  TAPI-27 v2 为 Stable (v2)，2.0 起是 SDK 的默认，它们的第 1 版仍为 Stable (v1)（`labels: 'v1'`）；TAPI-20 §3.5（服务目录）、
  TAPI-22 与 TAPI-25 为实验性。TAPI-20 至 TAPI-27 仍是 2.x 兼容性承诺的依据。

## 2. 接下来

- **官方 TAP 评审。** 我们向 TapeOut 的 TAP 流程（[TapeOutProtocol/TAPs](https://github.com/TapeOutProtocol/TAPs)，TAP-01）
  提交了 14 份草稿，一律按 TAP-10 写：8 份在 2026-09-30 至 10-01，2 份关于容器代理格式在 2026-10-04 与 10-05，2 份在 2026-10-08，
  2 份在 2026-10-13。
  服务身份与清单已合并为 [TAP-11](https://github.com/TapeOutProtocol/TAPs/blob/main/TAPs/TAP-11.md)（Draft，[#8](https://github.com/TapeOutProtocol/TAPs/pull/8)，2026-10-01），
  签名响应已合并为 [TAP-13](https://github.com/TapeOutProtocol/TAPs/blob/main/TAPs/TAP-13.md)（Draft，[#10](https://github.com/TapeOutProtocol/TAPs/pull/10)，2026-10-04）；
  合并为 Draft 不等于被采纳。另有 12 份是尚未合并的拉取请求，尚无编号（其中 #54、#59、#60 目前转为 draft PR，暂不占用编辑的评审队列）：私密通道 [#12](https://github.com/TapeOutProtocol/TAPs/pull/12)、
  MCP 工具绑定 [#16](https://github.com/TapeOutProtocol/TAPs/pull/16)、多家交叉验证读取 [#18](https://github.com/TapeOutProtocol/TAPs/pull/18)、
  私密群聊 [#20](https://github.com/TapeOutProtocol/TAPs/pull/20)、AI 用量回执 [#26](https://github.com/TapeOutProtocol/TAPs/pull/26)、
  证明核验读取 [#28](https://github.com/TapeOutProtocol/TAPs/pull/28)、容器代理授权书与任务消息（阶段 0）[#47](https://github.com/TapeOutProtocol/TAPs/pull/47)、
  清单里的代理成员 [#49](https://github.com/TapeOutProtocol/TAPs/pull/49)、付费凭证（美元报价、BEM 结算）[#52](https://github.com/TapeOutProtocol/TAPs/pull/52)、
  有证据的容器间评价 [#54](https://github.com/TapeOutProtocol/TAPs/pull/54)、支付容器服务的托管通道（Standards）[#59](https://github.com/TapeOutProtocol/TAPs/pull/59)、
  由托管通道强制执行的容器代理授权书（阶段 1）[#60](https://github.com/TapeOutProtocol/TAPs/pull/60)。另有 1 份 Information 草稿 [#61](https://github.com/TapeOutProtocol/TAPs/pull/61)（容器网站、消息与服务的隐私地图），已提交，目前转为 draft PR。后续修改在等待编辑处理：对 TAP-11 的
  [#51](https://github.com/TapeOutProtocol/TAPs/pull/51)（删去对 `TAP-26/` 标签的提及）、[#53](https://github.com/TapeOutProtocol/TAPs/pull/53)
  （允许后续 TAP 把 `priceBEM` 读作单次调用的上限；托管合约所在的链由谁规定）与 [#55](https://github.com/TapeOutProtocol/TAPs/pull/55)
  （参考实现更新到当前版本，并加一条以 `resolved` 结束的主网向量）；对 TAP-13 的 [#56](https://github.com/TapeOutProtocol/TAPs/pull/56)
  （参考实现一节里一句过时的话）。编辑分配编号后，我们改引用。
- **评审之后再考虑稳定的状态名。** TAP-11 进入 Review、评审期满且没有未解决的异议之后，我们再考虑把 `data.status`、`SiteStatus`
  与 `svc.conform` 升为 Stable。这是"考虑"，不是承诺，也没有日期。
- **托管接口的 Standards TAP 与有界代理草稿。** 两份都已提交：规定托管接口的 Standards 草稿 [#59](https://github.com/TapeOutProtocol/TAPs/pull/59)，有界代理（阶段 1）的草稿
  [#60](https://github.com/TapeOutProtocol/TAPs/pull/60)；两份目前都转为 draft PR，暂不占评审队列。
- **托管合约：先审计，再部署。** 送审候选版（v3）已在仓库，首个实例计划托管 BEM（TAPI-22 §3.5）。独立审计完成之前一直不部署，
  所以不存在任何通道、不收任何费用，有界代理只在本地链与测试中可用。
- **开发者控制台（完整版）。** 只读版*我的服务*已在 https://tapeapi.fun/dashboard/ 上线（添加服务名，查看健康、
  委托到期、试用和续期链接）。接下来：自动列出你持有的电路（需要索引），并在同一页面完成续期与管理。
- **npm 包** `@tapeapi/sdk` 与 `@tapeapi/server`。目前两者都从每个 GitHub Release 安装（先装 SDK，再装服务端包），或在本仓库的克隆目录里使用。

## 3. 更远

- **有界代理与付费调用上主网。** 两者都依赖托管合约（TAPI-22，`contracts/src/TapeAPIEscrow.sol`），它已写好并有测试，但
  **未部署**。只有通过独立第三方审计后才会部署，主网上的付费调用与有界代理在那之后才开始。在此之前所有线上方法都免费。
  送审的版本带默认 1% 的维护贡献（提供者可设为 0；合约上限 20%），计划首先托管 BEM，USDT 锚定币（Binance-Peg）与 WBNB 按需。
  见 [SECURITY.md](../SECURITY.md)。
- **容器代理阶段 2：支出金库。** 让代理在单次与总额上限内调用白名单上的合约，并能立即撤销。需要新合约，也要先审计。
- **服务目录。** 按功能查找服务的地方，只用于发现：解析永远以链上为准，登记与否不改变客户端信任什么。

## 4. 我们不会做的事

- 收强制协议费，或给托管合约加运营方费率开关或暂停开关。托管合约默认的 1% 维护贡献从提供者所得中划出，任何提供者都
  可以把它设为 0（[FEES.md](FEES.md)）。
- 让客户端必须经过我们运营的端点才能解析或验证服务。解析与验证始终免费、在链上完成。
- 让目录或登记凌驾于链上事实之上。
- 悄悄降级。默认解析方式跟不上的配置（自定义地址、本地链）一律报错并写明 `conform: false`，绝不悄悄换一套规则。
- 为追赶一份 Draft 而在 2.x 里让原本能解析的输入失败。TAP 文本的收紧只先作为可选 profile 提供，默认到 3.0 才切换。

## 5. 参与决定

需要某个功能或服务，请开 [issue](https://github.com/BruceLanLan/tapeapi/issues)。规范改动从 *spec proposal (TAPI)*
issue 开始，见 [CONTRIBUTING.md](../CONTRIBUTING.md)。
