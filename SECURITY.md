# Security Policy / 安全策略

> English is authoritative. 中文见下半部分，章节编号一一对应。

## 0. Read this first

**The TapeAPI contracts are not deployed and have had no external audit.** `contracts/src/ServiceDirectory.sol` and `contracts/src/TapeAPIEscrow.sol` exist, compile and pass 107 Foundry tests, and have been through internal read-only review passes — an internal review by the same team is not an audit. The SDK and the provider runtime are likewise unaudited and pre-alpha.

Do not put funds you cannot lose into any deployment of this code. If you deploy it yourself, you are deploying unaudited code and the risk is yours.

## 1. Reporting a vulnerability

**Report privately. Do not open a public issue, PR, or discussion.** A public report on a live escrow is an announcement to whoever is fastest.

Use **GitHub private vulnerability reporting**: the repository's *Security* tab → *Report a vulnerability*. That creates a private advisory visible only to the maintainers. If you cannot use it, contact the maintainer **@BruceLanLan** through a private channel on GitHub and ask for a secure channel before sending any detail.

Please include, as far as you have it:

- which component and which file/line or contract function,
- the exact version — a commit SHA, or a deployed address and chain id,
- what an attacker gains (funds, free service, forged attribution, denial of service) and what they need to start,
- a minimal reproduction: a failing test, a script, or a transaction trace. A Foundry test is ideal.

**What to expect.** Acknowledgement within 72 hours. An assessment with a severity and a plan within 7 days. We will tell you when a fix lands and will credit you in the advisory unless you prefer otherwise. We will not take legal action against good-faith research that follows this policy. Please give us a reasonable window before publishing — and if the issue affects funds in a live deployment, please wait until a fix is deployed.

Please do **not** test against other people's live services, provider endpoints or containers. Run your own.

## 2. In scope

Anything in this repository:

- **Contracts** — `contracts/src/TapeAPIEscrow.sol`, `contracts/src/ServiceDirectory.sol`, `contracts/src/interfaces.sol`. Especially: voucher accounting and replay, allowance and commitment accounting, session authorisation, withdraw delay and settle paths, delegation verification, the label activation gate, and owner powers (the owner must have no ability to pause, upgrade, take user funds, or change anyone's contribution rate).
- **SDK** — `@tapeapi/sdk` (`sdk/src/*`). Signature verification and malleability, canonical JSON, the resolution algorithm, container derivation, quorum behaviour, the `dev` / `allowSingleNode` / `allowHttp` / `maxSkewS` switches, RPC handling.
- **Provider runtime** — `@tapeapi/server` (`server/src/*`). Envelope construction and signing, metering and billing, key handling, request parsing, anything that bills for work not delivered or delivers work unbilled.
- **Specifications** — `spec/TAP-*.md`. A design-level flaw in the standard is in scope and is the most valuable kind of report: if the spec mandates something unsafe, every conforming implementation inherits it.
- **Examples and scripts** — including a leak in `scripts/publish-site.mjs` that would let an internal document reach the public site.

## 3. Out of scope

These are real and may matter to you, but they are not ours to fix. Please report them to the party that owns them.

- **TapeOut / HashPort deployed contracts.** We depend on them; we do not control them and cannot patch them. Report to the TapeOut / Blonskr maintainers, not here. On BNB Smart Chain (chainId 56): DeWebHub `0xe61A9C7213a6Aa616C246a2B569e555B417b25ee`, SiteRegistry `0xd006ffdd5Ae313B17729621A00999cD3C71CE5e6`, BEM `0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a`, circuits factory `0x68224F668083c29e9800Be2a646d42d18cedF7e2`. The DomainBinding and container-opener contracts are theirs as well. (If one of their contracts behaves in a way our code fails to defend against — for example a `staticcall` returning malformed data — **that defence is ours and is in scope**; report it here.)
- **Third-party RPC nodes.** A public dataseed lying, censoring, rate-limiting or going down is not a TapeAPI vulnerability. A way to make the SDK accept a lie from a single node despite quorum being configured **is** in scope.
- **Services published by third parties.** A provider signing wrong results, going offline, or overcharging is between that provider and its consumers; a TapeAPI service is not vetted or endorsed by us. A flaw that lets a provider forge attribution to a container it does not hold, or lets anyone spend a consumer's voucher beyond what was authorised, is in scope.
- Missing source verification on third-party contracts on BscScan, and any wallet's warning about them.
- Reports produced only by an automated scanner, with no exploit path and no argument for impact.
- Social engineering, physical access, or anything requiring a compromised maintainer machine.

## 4. Known and accepted

These are documented properties, not undisclosed findings — a report saying only this is not a vulnerability report:

- Contracts are unaudited and undeployed; there is no canonical escrow or directory address.
- The escrow owner can change the treasury address (emitting `TreasuryChanged`) and nominate a successor owner. The owner cannot pause, upgrade, seize funds, or set anyone's contribution rate.
- A single provider's signed response is a single-source feed. Consumers must add their own bounds, freshness checks and kill switch; see the "when not to use this" sections in `examples/*/README.md`.
- `dev`, `allowSingleNode`, `allowHttp` and `FREE_ALL` deliberately relax safety checks. They are opt-in, and using them in production is a configuration mistake, not a vulnerability — unless you find a way to enable one without the operator opting in.

---

## 0. 先读这一条（中文）

**TapeAPI 的合约尚未部署，也未经任何外部审计。** `contracts/src/ServiceDirectory.sol` 与 `contracts/src/TapeAPIEscrow.sol` 已写好、可编译、通过 107 个 Foundry 测试，并经过内部只读评审——**同一团队的内部评审不是审计**。SDK 与提供者运行时同样未经审计，处于 pre-alpha。

不要把输不起的资金放进本代码的任何部署。你自行部署即是在部署未经审计的代码，风险由你承担。

## 1. 如何报告漏洞

**请私下报告。不要开公开 issue、PR 或讨论。** 对一个已上线的托管合约做公开披露，等于向手最快的人发通告。

请使用 **GitHub 私密漏洞报告**：仓库 *Security* 标签页 → *Report a vulnerability*，这会创建仅维护者可见的私密公告。若无法使用，请通过 GitHub 的私密渠道联系维护者 **@BruceLanLan**，在发送任何细节之前先索要一个安全渠道。

请尽量包含：

- 哪个组件、哪个文件行号或合约函数；
- 确切版本——commit SHA，或部署地址与 chain id；
- 攻击者获得什么（资金、白嫖服务、伪造归属、拒绝服务），以及发起攻击需要什么前提；
- 最小复现：一个失败的测试、一个脚本或一份交易 trace。**Foundry 测试最佳。**

**你可以期待什么。** 72 小时内确认收到；7 天内给出严重度判定与处理计划。修复落地时我们会告知你，并在公告中致谢（你不希望则不致谢）。对遵循本策略的善意研究，我们不会采取法律行动。请在公开披露前给我们合理的时间窗口；**若问题影响已上线部署中的资金，请等到修复部署之后**。

请**不要**对他人的线上服务、提供者端点或容器做测试，请自己跑一个。

## 2. 在范围内

本仓库中的一切：

- **合约**——`contracts/src/TapeAPIEscrow.sol`、`contracts/src/ServiceDirectory.sol`、`contracts/src/interfaces.sol`。尤其是：凭证记账与重放、额度与承诺记账、会话授权、提现延迟与结算路径、委托校验、标签激活门槛，以及 owner 权力（owner 必须无法暂停、升级、取走用户资金或更改任何人的贡献比例）。
- **SDK**——`@tapeapi/sdk`（`sdk/src/*`）。签名校验与可延展性、规范 JSON、解析算法、容器推导、法定人数行为、`dev` / `allowSingleNode` / `allowHttp` / `maxSkewS` 开关、RPC 处理。
- **提供者运行时**——`@tapeapi/server`（`server/src/*`）。信封构造与签名、计量与计费、密钥处理、请求解析，以及任何"没交付却计费"或"交付了却不计费"的情形。
- **规范**——`spec/TAP-*.md`。标准层面的设计缺陷在范围内，**而且是最有价值的一类报告**：规范若要求了不安全的做法，所有合规实现都会继承它。
- **示例与脚本**——包括 `scripts/publish-site.mjs` 中可能让内部文档流到公网的泄漏。

## 3. 不在范围内

以下问题真实存在、也可能对你重要，但不是我们能修的。请报告给对应的归属方。

- **TapeOut / HashPort 已部署的合约。** 我们依赖它们，但不控制、也无法修补。请报告给 TapeOut / Blonskr 的维护者，而不是这里。BNB Smart Chain（chainId 56）：DeWebHub `0xe61A9C7213a6Aa616C246a2B569e555B417b25ee`、SiteRegistry `0xd006ffdd5Ae313B17729621A00999cD3C71CE5e6`、BEM `0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a`、电路工厂 `0x68224F668083c29e9800Be2a646d42d18cedF7e2`。DomainBinding 与容器开通器同样属于他们。（**若他们的合约以某种方式行事而我们的代码未能防御——例如 `staticcall` 返回畸形数据——那份防御是我们的，在范围内**，请报告到这里。）
- **第三方 RPC 节点。** 公开 dataseed 说谎、审查、限流或宕机，不是 TapeAPI 的漏洞。但**能让配置了法定人数的 SDK 仍然接受单个节点的谎言**，在范围内。
- **第三方发布的服务。** 提供者签错结果、掉线或多收费，是该提供者与其消费者之间的事；TapeAPI 服务不经我们审核或背书。但**让提供者伪造出自己并不持有的容器的归属**，或**让任何人超出授权额度花掉消费者的凭证**，在范围内。
- 第三方合约在 BscScan 上未验证源码，以及钱包对此发出的警告。
- 仅由自动扫描器产出、没有利用路径也没有影响论证的报告。
- 社会工程、物理接触，或任何需要先攻破维护者机器的前提。

## 4. 已知且接受的

以下是已记录在案的性质，不是未披露的发现——只说这些的报告不构成漏洞报告：

- 合约未经审计且未部署；**不存在规范的托管或目录地址**。
- 托管合约的 owner 可以更换金库地址（会发出 `TreasuryChanged`）并提名继任 owner。owner 无法暂停、升级、没收资金，也无法设定任何人的贡献比例。
- 单个提供者的签名响应是单一来源数据。消费者必须自行加上界限、新鲜度检查与 kill switch；见 `examples/*/README.md` 中各自的「什么时候不要用这个」一节。
- `dev`、`allowSingleNode`、`allowHttp` 与 `FREE_ALL` 是有意放宽安全检查的开关。它们需要显式启用，在生产中使用属于配置错误而非漏洞——除非你找到**无需运营者主动开启即可启用其中之一**的方法。
