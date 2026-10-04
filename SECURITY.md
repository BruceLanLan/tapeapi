# Security Policy / 安全策略

> English is authoritative. 中文见下半部分，章节编号一一对应。

## 0. Read this first

**None of the TapeAPI contracts has had an external audit.** One is deployed: `ChannelBus` (`contracts/src/ChannelBus.sol`), the stateless event-only transport for on-chain channels, at `0x486110c35d9b90a9d6D85c8063A065f9e7b6b707` on BNB Smart Chain (chainId 56). The paid-call escrow (`contracts/src/TapeAPIEscrow.sol`) and the service directory (`contracts/src/ServiceDirectory.sol`) are **not deployed**. All three compile and pass 169 Foundry tests, and have been through internal read-only review passes — an internal review by the same team is not an audit. The SDK, the provider runtime and the hosted services listed in §2 are likewise unaudited: TapeAPI 1.0.0 (2026-09-29) was released without a third-party audit.

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

Anything in this repository, and the services the project runs from it:

- **Contracts** — `contracts/src/ChannelBus.sol` (deployed, address in §0), `contracts/src/TapeAPIEscrow.sol`, `contracts/src/ServiceDirectory.sol`, `contracts/src/interfaces.sol`. For ChannelBus especially: anything that makes it refuse a valid frame, emit a frame other than the one it was sent, or hold state or funds. Especially: voucher accounting and replay, allowance and commitment accounting, session authorisation, withdraw delay and settle paths, delegation verification, the label activation gate, and owner powers (the owner must have no ability to pause, upgrade, take user funds, or change anyone's contribution rate).
- **SDK** — `@tapeapi/sdk` (`sdk/src/*`). Signature verification and malleability, canonical JSON, the resolution algorithm, container derivation, quorum behaviour, the `dev` / `allowSingleNode` / `allowHttp` / `maxSkewS` switches, RPC handling.
- **Provider runtime** — `@tapeapi/server` (`server/src/*`). Envelope construction and signing, metering and billing, key handling, request parsing, anything that bills for work not delivered or delivers work unbilled.
- **Specifications** — `spec/TAPI-*.md`. A design-level flaw in the standard is in scope and is the most valuable kind of report: if the spec mandates something unsafe, every conforming implementation inherits it.
- **Examples and scripts** — including anything that would let an internal document reach the public website, which Cloudflare Pages deploys from the `site/` directory.
- **Hosted services run by the project** — the holder console `https://tapeapi.fun/console/` (source `site/console/`), the public service `https://api.tapeapi.fun` (`11.1013.tape`, source `examples/public-api/`) and the public relay `https://relay.tapeapi.fun` (`12.1013.tape`, source `examples/cloudflare-worker/relay-worker.js`). Especially: anything that makes the console leak a signing key or get a holder to sign or publish something other than what it shows, and anything that makes either service sign an answer that is not what it read. Test these without disrupting them: no load, flood or denial-of-service testing against the live hosts; run your own copy for that.

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

- Contracts are unaudited. ChannelBus is deployed (§0); the escrow and the directory are not, so there is no canonical escrow or directory address.
- The escrow owner can change the treasury address (emitting `TreasuryChanged`) and nominate a successor owner. The owner cannot pause, upgrade, seize funds, or set anyone's contribution rate.
- A single provider's signed response is a single-source feed. Consumers must add their own bounds, freshness checks and kill switch; see the "when not to use this" sections in `examples/*/README.md`.
- `dev`, `allowSingleNode`, `allowHttp` and `FREE_ALL` deliberately relax safety checks. They are opt-in, and using them in production is a configuration mistake, not a vulnerability — unless you find a way to enable one without the operator opting in.

## 5. Verifying a release

TapeAPI is not on npm. `@tapeapi/sdk` and `@tapeapi/server` are installed from the `.tgz` files attached to a GitHub Release, so a checksum is the integrity evidence you can check yourself.

- **What a Release carries.** From v1.6.0 on, every Release has a `SHA256SUMS` file next to the two tarballs (`tapeapi-sdk-<version>.tgz`, `tapeapi-server-<version>.tgz`), and the release notes repeat the same lines. Earlier releases (v1.0.0 to v1.5.0) have none. The file is made by `scripts/release-checksums.mjs` from the exact tarballs that are uploaded.
- **How to check.** Download `SHA256SUMS` and both tarballs into one folder, then:

  ```bash
  shasum -a 256 -c SHA256SUMS      # Linux: sha256sum -c SHA256SUMS
  npm install ./tapeapi-sdk-<version>.tgz ./tapeapi-server-<version>.tgz
  ```

  Every line must end in `OK`. If one says `FAILED`, do not install it: download it again, and if it still fails, report it as in §1. Install the local files you just checked, not the URL, so that what you installed is what you verified.
- **What this proves, and what it does not.** `SHA256SUMS` sits on the same Release page as the tarballs. It catches a corrupted or truncated download, a proxy or mirror that changed a file, and files taken from two different releases. It does not protect against someone who can edit the Release itself: they could replace the tarballs and the checksum file together. A check that does not depend on the Release page is to compare the contents with the source: check out the release tag, run `tar xzf` on the tarball, and `diff -r package/src sdk/src` (likewise `types` and `bin`; `server/` for the server package). Compare extracted files rather than the hash of a tarball you rebuilt: the same source packed with the same Node and npm gives the same bytes (a rebuild of v1.5.0 with Node 22 and npm 10 matched the published tarballs exactly), but with a different Node version the tar inside is identical while the gzip layer around it is not, so two honest builds can have different `.tgz` hashes. GitHub also records a SHA-256 digest for every uploaded asset (`gh api repos/BruceLanLan/tapeapi/releases/tags/<tag> --jq '.assets[] | [.name, .digest]'`); it is computed by GitHub on upload and is a second place to read the same value, with the same limit as above.
- **Build provenance (`gh attestation`): not provided.** GitHub's build attestations (signed provenance, checked with `gh attestation verify`) are created by a GitHub Actions workflow that builds the file, using the workflow's own identity. Our releases are built and uploaded by hand from the maintainer's machine (`npm pack`, then `gh release create`); no CI job builds them, so there is no workflow identity to attest, and an attestation for a file built on a laptop would state nothing GitHub observed. If releases are later built and uploaded by a CI workflow, an attestation step can be added then. Until then `SHA256SUMS` is the only integrity evidence we provide, and this section is the full extent of it.

---

## 0. 先读这一条（中文）

**TapeAPI 的合约都未经任何外部审计。** 已部署的只有一个：`ChannelBus`（`contracts/src/ChannelBus.sol`），链上通道所用的无状态、只发事件的传输合约，地址 `0x486110c35d9b90a9d6D85c8063A065f9e7b6b707`，位于 BNB Smart Chain（chainId 56）。付费调用托管合约（`contracts/src/TapeAPIEscrow.sol`）与服务目录（`contracts/src/ServiceDirectory.sol`）**尚未部署**。三者均可编译、通过 169 个 Foundry 测试，并经过内部只读评审——**同一团队的内部评审不是审计**。SDK、提供者运行时以及 §2 所列的托管服务同样未经审计：TapeAPI 1.0.0（2026-09-29）发布时没有经过第三方审计。

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

本仓库中的一切，以及本项目用它运行的服务：

- **合约**——`contracts/src/ChannelBus.sol`（已部署，地址见 §0）、`contracts/src/TapeAPIEscrow.sol`、`contracts/src/ServiceDirectory.sol`、`contracts/src/interfaces.sol`。对 ChannelBus 尤其关注：任何让它拒收合法帧、发出与所收内容不同的帧，或让合约持有状态或资金的情形。尤其是：凭证记账与重放、额度与承诺记账、会话授权、提现延迟与结算路径、委托校验、标签激活门槛，以及 owner 权力（owner 必须无法暂停、升级、取走用户资金或更改任何人的贡献比例）。
- **SDK**——`@tapeapi/sdk`（`sdk/src/*`）。签名校验与可延展性、规范 JSON、解析算法、容器推导、法定人数行为、`dev` / `allowSingleNode` / `allowHttp` / `maxSkewS` 开关、RPC 处理。
- **提供者运行时**——`@tapeapi/server`（`server/src/*`）。信封构造与签名、计量与计费、密钥处理、请求解析，以及任何"没交付却计费"或"交付了却不计费"的情形。
- **规范**——`spec/TAPI-*.md`。标准层面的设计缺陷在范围内，**而且是最有价值的一类报告**：规范若要求了不安全的做法，所有合规实现都会继承它。
- **示例与脚本**——包括任何可能让内部文档流到公开网站的问题；网站由 Cloudflare Pages 从 `site/` 目录部署。
- **本项目运行的托管服务**——持有人控制台 `https://tapeapi.fun/console/`（源码 `site/console/`）、公共服务 `https://api.tapeapi.fun`（`11.1013.tape`，源码 `examples/public-api/`）与公共中继 `https://relay.tapeapi.fun`（`12.1013.tape`，源码 `examples/cloudflare-worker/relay-worker.js`）。尤其是：任何让控制台泄露签名密钥、或让持有人签署或发布与页面所示不同内容的方法，以及任何让这两个服务对并非其所读的内容签名的方法。测试时不要干扰它们：不要对线上主机做压测、洪水或拒绝服务测试；这类测试请用你自己的副本。

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

- 合约未经审计。ChannelBus 已部署（见 §0）；托管合约与目录尚未部署，因此**不存在规范的托管或目录地址**。
- 托管合约的 owner 可以更换金库地址（会发出 `TreasuryChanged`）并提名继任 owner。owner 无法暂停、升级、没收资金，也无法设定任何人的贡献比例。
- 单个提供者的签名响应是单一来源数据。消费者必须自行加上界限、新鲜度检查与 kill switch；见 `examples/*/README.md` 中各自的「什么时候不要用这个」一节。
- `dev`、`allowSingleNode`、`allowHttp` 与 `FREE_ALL` 是有意放宽安全检查的开关。它们需要显式启用，在生产中使用属于配置错误而非漏洞——除非你找到**无需运营者主动开启即可启用其中之一**的方法。

## 5. 校验发布产物

TapeAPI 不在 npm 上。`@tapeapi/sdk` 与 `@tapeapi/server` 从 GitHub Release 附带的 `.tgz` 文件安装，所以校验值是你可以自己核对的完整性依据。

- **每个 Release 附带什么。** 自 v1.6.0 起，每个 Release 在两个 tarball（`tapeapi-sdk-<version>.tgz`、`tapeapi-server-<version>.tgz`）旁附一个 `SHA256SUMS` 文件，发布说明里重复同样的几行。更早的发布（v1.0.0 至 v1.5.0）没有。该文件由 `scripts/release-checksums.mjs` 对实际上传的那两个 tarball 生成。
- **如何校验。** 把 `SHA256SUMS` 与两个 tarball 下载到同一个文件夹，然后：

  ```bash
  shasum -a 256 -c SHA256SUMS      # Linux 用 sha256sum -c SHA256SUMS
  npm install ./tapeapi-sdk-<version>.tgz ./tapeapi-server-<version>.tgz
  ```

  每一行都必须以 `OK` 结尾。若出现 `FAILED`，不要安装：重新下载；仍然失败就按 §1 报告。请安装刚校验过的本地文件，而不是直接用 URL，这样装进去的就是校验过的。
- **这能证明什么，不能证明什么。** `SHA256SUMS` 与 tarball 在同一个 Release 页面上。它能发现下载损坏或被截断、代理或镜像改了文件、以及混用了两个不同发布的文件。它防不了能编辑 Release 本身的人：他们可以把 tarball 和校验文件一起换掉。不依赖 Release 页面的核对方法，是拿内容和源码比：检出该发布的标签，对 tarball 运行 `tar xzf`，再 `diff -r package/src sdk/src`（`types`、`bin` 同理；服务端包对应 `server/`）。请比对解开后的文件，而不是你自己重新构建的 tarball 的哈希：同一份源码用同一版本的 Node 与 npm 打包，字节相同（用 Node 22 与 npm 10 重新构建 v1.5.0，与已发布的 tarball 完全一致）；但换了 Node 版本，里面的 tar 仍相同，外面那层 gzip 却不同，所以两次诚实的构建也可能得到不同的 `.tgz` 哈希。GitHub 还会为每个上传的附件记录一个 SHA-256 摘要（`gh api repos/BruceLanLan/tapeapi/releases/tags/<tag> --jq '.assets[] | [.name, .digest]'`）：它由 GitHub 在上传时计算，是读取同一个值的第二个地方，局限与上面相同。
- **构建来源证明（`gh attestation`）：目前不提供。** GitHub 的构建证明（带签名的来源证明，用 `gh attestation verify` 检查）由构建该文件的 GitHub Actions 工作流用它自己的身份生成。我们的发布由维护者在自己的机器上手工构建并上传（`npm pack`，再 `gh release create`），没有任何 CI 任务构建它们，所以没有可证明的工作流身份；为笔记本上构建的文件出具证明，写进去的不会是 GitHub 观察到的任何事。以后若改为由 CI 工作流构建并上传发布，那时可以加上证明步骤。在此之前，`SHA256SUMS` 是我们提供的唯一完整性依据，本节就是它的全部范围。
