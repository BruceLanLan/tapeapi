# Roadmap / 路线图

> English is authoritative. 中文见下半部分，章节编号一一对应。

This page says what exists today, what we are working on next, and what comes later. It has no dates: we give a date
only when we can stand behind it. Order within a section is not a promise either. For what has actually shipped, see
the [changelog](../CHANGELOG.md).

## 1. Now (live)

- **Public service** at `https://api.tapeapi.fun`, TapeOut name `11.1013.tape`: eight free, signed
  methods, pinned to a block except `blockNumber` (block number, balances, token and NFT reads, pair price, BNB/USD, name lookup). See the
  [Public API guide](guides/public-api.md).
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
- **Hosted services.** Start a service from a template (for example a chain reader or a Web2 adapter) without running a
  server. The platform holds the signing key under a delegation you sign, and each service has quotas. The trade-off is
  stated plainly: you trust the platform to sign for you while the delegation is valid; you can end it by letting it
  expire or by publishing a manifest that delegates to another key, and callers still verify every answer against
  the chain.
- **npm packages** `@tapeapi/sdk` and `@tapeapi/server`, so a script no longer has to live inside a clone of this
  repository.
- **TAP review with the TapeOut maintainers.** The TAP numbers are proposals until the maintainers assign them; the
  discussion is in [TapeKit#8](https://github.com/TapeOutProtocol/TapeKit/issues/8).

## 3. Later

- **Escrow audit, then paid calls.** The paid-call escrow (TAP-22, `contracts/src/TapeAPIEscrow.sol`) is written and
  tested but **not deployed**. It will be deployed only after an independent third-party audit; paid calls start
  after that. Until then every live method is free. See [SECURITY.md](../SECURITY.md).
- **Service directory.** A place to find services by what they do. It is for discovery only: resolution always goes
  to the chain, and a listing never changes what a client trusts.

## 4. What we will not do

- Charge a protocol fee, or add an operator fee switch to the escrow ([FEES.md](FEES.md)).
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
- **托管服务。** 从模板（例如链上读取器或 Web2 适配器）启动服务，不用自己跑服务器。签名密钥由平台在你签署的委托下
  持有，每个服务有配额。取舍如实说明：委托有效期内，你信任平台代你签名；让委托到期、或发布一份委托给另一把密钥的新清单即可终止，
  而调用方仍会对照链上核验每一个响应。
- **npm 包** `@tapeapi/sdk` 与 `@tapeapi/server`，脚本不再必须放在本仓库的克隆目录里。
- **与 TapeOut 维护者评审 TAP。** 在维护者分配编号之前，TAP 编号都只是提议；讨论在
  [TapeKit#8](https://github.com/TapeOutProtocol/TapeKit/issues/8)。

## 3. 更远

- **托管合约审计，然后才有付费调用。** 付费调用的托管合约（TAP-22，`contracts/src/TapeAPIEscrow.sol`）已写好并有
  测试，但**未部署**。只有通过独立第三方审计后才会部署，付费调用在那之后才开始。在此之前所有线上方法都免费。
  见 [SECURITY.md](../SECURITY.md)。
- **服务目录。** 按功能查找服务的地方，只用于发现：解析永远以链上为准，登记与否不改变客户端信任什么。

## 4. 我们不会做的事

- 收协议费，或给托管合约加运营方费率开关（[FEES.md](FEES.md)）。
- 让客户端必须经过我们运营的端点才能解析或验证服务。解析与验证始终免费、在链上完成。
- 让目录或登记凌驾于链上事实之上。

## 5. 参与决定

需要某个功能或服务，请开 [issue](https://github.com/BruceLanLan/tapeapi/issues)。规范改动从 *spec proposal (TAP)*
issue 开始，见 [CONTRIBUTING.md](../CONTRIBUTING.md)。
