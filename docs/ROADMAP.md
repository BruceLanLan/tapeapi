# Roadmap / 路线图

> English is authoritative. 中文见下半部分，章节编号一一对应。

This page says what exists today, what we are working on next, and what comes later. It has no dates: we give a date
only when we can stand behind it. Order within a section is not a promise either. For what has actually shipped, see
the [changelog](../CHANGELOG.md).

## 1. Now (live)

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
- **Public relay** at relay.tapeapi.fun (`12.1013.tape`) for end-to-end encrypted channels between containers (TAP-26).
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
- **Specifications** TAP-20 to TAP-27 (proposed), the SDK and the provider runtime, used from this repository.

## 2. Next

- **Developer dashboard, full version.** A read-only *My services* page is live at https://tapeapi.fun/dashboard/ (add
  service names; see health, delegation expiry, links to try or renew). Next: list the circuits you hold automatically
  (needs an index), and renew and manage them from the same page.
- **Receipt-grounded reputation.** Reviews of a service that only a caller can write, and only with a signed receipt
  for its own request; the reviewer must itself be a container. A review then costs a real call and a real circuit.
- **npm packages** `@tapeapi/sdk` and `@tapeapi/server`. Today the SDK installs from each GitHub release, and the
  server package is used from a clone of this repository.
- **TAP review with the TapeOut maintainers.** The TAP numbers are proposals until the maintainers assign them; the
  discussion is in [TapeKit#8](https://github.com/TapeOutProtocol/TapeKit/issues/8).

## 3. Later

- **Escrow audit, then paid calls.** The paid-call escrow (TAP-22, `contracts/src/TapeAPIEscrow.sol`) is written and
  tested but **not deployed**. It will be deployed only after an independent third-party audit; paid calls start
  after that. Until then every live method is free. The version that goes to audit is the next one: it adds the
  default 1% contribution (provider can set 0) and is planned to settle in BEM, BNB (as WBNB), USDT, USDC, ETH and
  USD1. See [SECURITY.md](../SECURITY.md).
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
specification starts as a *spec proposal (TAP)* issue; see [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## 1. 现在（已上线）

- **公共服务** `https://api.tapeapi.fun`，TapeOut 名称 `11.1013.tape`：八个免费、签名的方法（除 `blockNumber` 外都锚定区块）
  （区块号、余额、代币与 NFT 读取、交易对价格、BNB/USD、名称查询）。见[公共 API 指南](guides/zh-CN/public-api.md)。
- **MCP 服务器** `https://api.tapeapi.fun/mcp`：同样的八个方法作为 Claude、Cursor 和任何 MCP 客户端的工具，按网址添加，
  无需安装。每个结果都有签名，并附带任何人都能对照链上核验的回执。见 [MCP 指南](guides/zh-CN/mcp.md)。
- **Tape out 你的 MCP 服务器**（可以使用，不是托管服务）：你自己运行、放在自己 MCP 服务器前面的签名代理，可用 Node
  运行或部署成 Cloudflare Worker（[`examples/mcp-proxy/`](../examples/mcp-proxy/)），持有人控制台支持发布它的清单。
  你的服务器由此获得链上身份、由链上清单里的 `toolsSha256` 钉住的工具定义，以及每个结果上的签名。目前还没有任何第三方
  MCP 服务器被 tape out。见 [Tape out 你自己的 MCP 服务器](guides/zh-CN/mcp.md#tape-out-你自己的-mcp-服务器)。
- **公共中继** relay.tapeapi.fun（`12.1013.tape`），用于容器之间的端到端加密通道（TAP-26）。
- **ChannelBus** 已部署在 BNB Chain，地址 `0x486110c35d9b90a9d6D85c8063A065f9e7b6b707`：无状态、无所有者的事件总线，
  不想用中继时在链上承载通道帧。
- **调试台** [tapeapi.fun/playground](https://tapeapi.fun/playground/)：按名称解析任意服务，查看 SDK 做的每一项核对，
  调用并复制代码。
- **状态页** [tapeapi.fun/status](https://tapeapi.fun/status/)，配有定时监控，大约每 30 分钟运行一次（GitHub 可能推迟定时任务）：服务挂了或委托不足 14 天到期时
  自动开 GitHub issue。
- **手册** [tapeapi.fun/docs](https://tapeapi.fun/docs/)，中英双语，由 [`docs/guides/`](guides/) 生成。
- **持有人控制台** [tapeapi.fun/console](https://tapeapi.fun/console/)：用手机钱包让服务上线、发布清单、签署委托。
- **规范** TAP-20 至 TAP-27（提议中），以及 SDK 与提供者运行时，目前从本仓库使用。

## 2. 接下来

- **开发者控制台（完整版）。** 只读版*我的服务*已在 https://tapeapi.fun/dashboard/ 上线（添加服务名，查看健康、
  委托到期、试用和续期链接）。接下来：自动列出你持有的电路（需要索引），并在同一页面完成续期与管理。
- **凭回执的信誉。** 只有调用方才能评价一个服务，而且必须持有该服务为它自己的请求签发的回执；评价者本身也必须是一个容器。
  这样每条评价都要付出一次真实调用和一个真实电路的代价。
- **npm 包** `@tapeapi/sdk` 与 `@tapeapi/server`。目前 SDK 从每个 GitHub Release 安装，服务端包在本仓库的克隆目录里使用。
- **与 TapeOut 维护者评审 TAP。** 在维护者分配编号之前，TAP 编号都只是提议；讨论在
  [TapeKit#8](https://github.com/TapeOutProtocol/TapeKit/issues/8)。

## 3. 更远

- **托管合约审计，然后才有付费调用。** 付费调用的托管合约（TAP-22，`contracts/src/TapeAPIEscrow.sol`）已写好并有
  测试，但**未部署**。只有通过独立第三方审计后才会部署，付费调用在那之后才开始。在此之前所有线上方法都免费。
  送审的是下一版：它加入默认 1% 的维护贡献（提供者可设为 0），并计划支持 BEM、BNB（包装为 WBNB）、USDT、USDC、ETH、USD1 结算。
  见 [SECURITY.md](../SECURITY.md)。
- **服务目录。** 按功能查找服务的地方，只用于发现：解析永远以链上为准，登记与否不改变客户端信任什么。

## 4. 我们不会做的事

- 收强制协议费，或给托管合约加运营方费率开关或暂停开关。托管合约默认的 1% 维护贡献从提供者所得中划出，任何提供者都
  可以把它设为 0（[FEES.md](FEES.md)）。
- 让客户端必须经过我们运营的端点才能解析或验证服务。解析与验证始终免费、在链上完成。
- 让目录或登记凌驾于链上事实之上。

## 5. 参与决定

需要某个功能或服务，请开 [issue](https://github.com/BruceLanLan/tapeapi/issues)。规范改动从 *spec proposal (TAP)*
issue 开始，见 [CONTRIBUTING.md](../CONTRIBUTING.md)。
