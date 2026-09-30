# Contributing to TapeAPI / 参与 TapeAPI

> English is authoritative. 中文见下半部分，章节编号一一对应。
> Modelled on TapeKit's contribution process, so that a TapeOut maintainer reviewing a TAP here sees the rules they already know.

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md). What we plan to build next is in
the [roadmap](docs/ROADMAP.md).

## 1. Before you open a pull request

**A specification change needs an issue first.** Open a *spec proposal (TAPI)* issue describing the problem, who is affected, and what breaks if we do nothing. Do not send a PR that edits `spec/` without a linked issue — it will be closed and asked to start as an issue. This is not bureaucracy: a TAP is a contract with implementers, and the discussion has to be findable later.

Code fixes (`sdk/`, `server/`, `contracts/`, `examples/`, `conformance/`, `scripts/`, `site/`) and documentation fixes do **not** need an issue first. A small, tested PR is welcome directly. A bug report issue helps if you want to discuss the fix before writing it.

Questions: read the [docs](https://tapeapi.fun/docs/) and the [FAQ](https://tapeapi.fun/docs/en/faq) first; if they do not answer it, open an issue.

Security problems do not go in issues at all. Report them privately through [GitHub's private vulnerability reporting](https://github.com/BruceLanLan/tapeapi/security/advisories/new); see [SECURITY.md](SECURITY.md).

## 2. Licensing of contributions

Contributions are accepted under the same licences the repository is published under (inbound = outbound). There is no CLA. By contributing you agree that:

- **Code is MIT** — `contracts/`, `sdk/`, `server/`, `examples/`, `conformance/`, `scripts/`, `site/` and everything else outside `spec/`. See [LICENSE](LICENSE).
- **Specification text is CC0-1.0** — everything under `spec/`. You place your contribution to the spec text in the public domain. See [LICENSE-SPEC](LICENSE-SPEC). Each TAP repeats `License | CC0-1.0` in its own header table.

By submitting a contribution you also certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/): in short, you wrote it or otherwise have the right to submit it under these licences, and you understand it is public and kept for ever. Adding a `Signed-off-by:` line (`git commit -s`) is welcome but not required; CI does not check it.

Do not paste text from a copyrighted specification, vendor documentation or another project's source into a TAP or into the code. Cite it by URL instead.

## 3. Both language halves, always

Every TAP is one file containing an English half and a Chinese half, in that order, with **section numbering that corresponds one-to-one**. `§3.4` in English and `§3.4` in Chinese must be the same section about the same thing.

**Every change to a TAP MUST update both halves in the same commit.** A PR that edits only one half is incomplete and will not be merged — not even for a typo, because a typo fix in one language silently desynchronises the two. If you cannot write the other half, say so in the PR and a maintainer will pair with you; do not guess.

**The normative keywords must match.** The Chinese half keeps the RFC 2119 keywords in English (`MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, `MAY`), so each half must contain the same number of each. Each TAP has two top-level `# TAPI-` headings, one per half; this counts the keywords on each side of the split (`MUST` includes `MUST NOT`, and so on):

```sh
f=spec/TAPI-22.md
for k in 'MUST NOT' 'MUST' 'SHOULD NOT' 'SHOULD' 'MAY'; do
  awk -v k="$k" '/^# TAPI-/{h++} {c[h]+=gsub(k,"&")} END{printf "%-10s en %d  zh %d\n", k, c[1], c[2]}' "$f"
done
```

The two columns must be equal. A mismatch is a bug in the PR.

**English is authoritative.** Where the two halves disagree, English wins and the Chinese half is the bug. Say so in the issue when you find a mismatch.

The same "change both together" rule applies to the other bilingual documents:

| English | Chinese | Layout |
|---|---|---|
| `README.md` | `README.zh-CN.md` | Two files; update both. |
| `docs/guides/*.md` | `docs/guides/zh-CN/*.md` | Two files per guide; update both, then rebuild the docs site (§6). |
| `examples/README.md` and the per-example READMEs | same file | One file, Chinese then English. |
| `CONTRIBUTING.md`, `SECURITY.md`, `docs/ROADMAP.md`, `CODE_OF_CONDUCT.md` | same file | One file, English then Chinese. |

`CHANGELOG.md` is English only. The rule does not apply to code comments (bilingual where helpful, not required).

## 4. Setting up and running the tests

Prerequisites: **Node.js 20 or later**, **Python 3** (standard library only) and [Foundry](https://getfoundry.sh). Clone with the submodule (forge-std):

```sh
git clone --recurse-submodules https://github.com/BruceLanLan/tapeapi.git
cd tapeapi
npm install --no-audit --no-fund
```

If you already cloned without it: `git submodule update --init --recursive`.

There are three suites, and **all three must pass before you open a PR**:

```sh
npm test                          # SDK, provider runtime, examples, conformance, build scripts (runs offline)
python3 spec/vectors/verify.py    # an independent Python implementation checks the test vectors
cd contracts && forge test        # Solidity
```

[CI](.github/workflows/ci.yml) runs the same three on every push to `main` and on every pull request (Node 22, Python 3.12, Foundry). A PR is reviewed only once CI is green.

If you change a signature, a hash or an encoding, change `sdk/`, `spec/vectors/verify.py` and the Solidity tests together (`node scripts/gen-vectors.mjs` regenerates the vectors): the three implementations must agree before anything lands.

If you change a count-bearing claim in the docs (tests, gas, a node's log window), re-run and use the real number — do not copy a number from an older document.

Some examples reach public BSC RPC nodes when you run them; the unit tests do not.

## 5. Changes that get extra scrutiny

Three areas carry the security properties the whole standard rests on. A PR touching any of them gets a slower, harder review, needs a written argument in the PR body for why the property still holds, and **ships only after an audit of the changed code**:

1. **Verification** — the response envelope digest and signature path (TAPI-21; `sdk/src/sig.js`, `sdk/src/canon.js`, envelope construction in `server/src/index.js`), the delegation check (TAPI-20 §3.4), and voucher signature recovery (TAPI-22). Includes canonical JSON: a change to canonicalisation is a change to every signature ever produced.
2. **Isolation** — anything that decides what a client trusts and from whom: the resolution algorithm (TAPI-20 §3.6) including name resolution (`<#ID>.<processor>.tape`), the rule that a container is derived on-chain and never self-reported, the `dev` / `allowSingleNode` / `allowHttp` switches, and quorum behaviour (TAPI-23). Weakening a default here is a breaking change even if no signature moves.
3. **Agreement** — the escrow's accounting: cumulative vouchers, allowance and commitment accounting, session authorisation, withdraw delays and the settle path (TAPI-22; `contracts/src/TapeAPIEscrow.sol`). Anything here can lose someone's money.

A change in these areas that only adds a test is of course fine and welcome.

## 6. Generated files

GitHub Pages runs no build, so some files under `site/` are generated and **committed**. `npm test` rebuilds them and fails if the committed copy differs, so regenerate and commit them in the same PR:

| You changed | Run | Commit |
|---|---|---|
| `docs/guides/*.md`, `docs/guides/zh-CN/*.md` or `CHANGELOG.md` | `npm run build:docs` | `site/docs/` |
| anything the SDK imports (`sdk/src/`) | `npm run build:playground`, then `npm run build:assets` | `site/playground/vendor/<hash>/` (the old directory is removed: `git rm -r` it), the import maps and vendor paths in `site/playground/`, `site/verify/` and `site/dashboard/`, and the restamped pages |
| `contracts/src/ChannelBus.sol` (rare; the deployed bytecode is fixed) | `cd contracts && forge build && cd .. && node scripts/build-console.mjs` | `site/console/channelbus.json` |

Edit the markdown sources, never the generated HTML. `site/` uses relative paths only.

## 7. Versioning

We follow semver, applied to the standard and to the packages separately.

- **Specs.** A TAP in `Draft` may change freely; record what changed and why in its own change log section. A TAP in `Stable (v1)` (TAPI-1 §4.1) is frozen: every field, encoding, signature domain and error code keeps its meaning, a revision may add only optional content and non-normative text, and a change that can make a conforming v1 implementation non-conforming is a new version (v2) with its own wire markers. `Experimental` sections and TAPs may change in any release.
- **Packages.** `@tapeapi/sdk` and `@tapeapi/server` follow semantic versioning from 1.0.0: code written against the 1.0 documentation keeps working in every 1.x release, and a breaking change to a Stable interface is a major bump (2.0). Anything marked `@experimental` may change in a minor release, with a changelog entry. The packages ship as release assets on GitHub, not on npm.
- Do not bump versions in a PR unless a maintainer asks. Releases are cut separately. Add a line under `[Unreleased]` in `CHANGELOG.md` for a user-visible change.

## 8. Repository layout

| Path | What it is |
|---|---|
| `spec/` | TAPI-1 and TAPI-20…27, plus test vectors and `verify.py` in `spec/vectors/`. Bilingual, English authoritative, CC0. |
| `contracts/` | `src/ServiceDirectory.sol`, `src/TapeAPIEscrow.sol`, `src/ChannelBus.sol`, Foundry tests in `test/`; forge-std is a submodule in `lib/`. |
| `sdk/` | `@tapeapi/sdk` — ESM, Node 20+ and browser, depends only on `@noble/*`. |
| `server/` | `@tapeapi/server` — the provider runtime (Node and the Fetch API). |
| `examples/` | Runnable examples, including the public service and the relay; index in `examples/README.md`. |
| `conformance/` | A black-box conformance suite for providers and relays. |
| `site/` | The static site at tapeapi.fun: home, docs (generated), playground, status, holder console. |
| `docs/` | The guides (`docs/guides/`), explainers and the operator guide — see `docs/README.md`. |
| `scripts/` | Build scripts (`build-docs`, `build-playground`, `build-console`), `gen-vectors`, `monitor` (the status check CI runs every 30 minutes), `channel-keys`, `probe-mainnet` (read-only). |
| `DESIGN.md` | The design contract every module must obey. |

## 9. Documents

If you add a document, link it from `docs/README.md` and write both language halves, English first. A document that states a number (a test count, a gas cost, a node's log window) says how and when it was measured.

## 10. Commits and PRs

- One logical change per PR. A spec change and a code change that implements it may share a PR if they must land together; say so.
- Write the commit subject as `area: what the change does`, not what you did: `escrow: settle clamps to the cap instead of voiding the voucher`, `Public service: drop a node that times out`.
- Fill in the [pull request template](.github/PULL_REQUEST_TEMPLATE.md) honestly. An unchecked box with a sentence explaining why is much better than a checked box that is not true.
- No secrets, ever: no private keys, no `.env`, no mnemonics, no RPC URLs carrying an API key. `.gitignore` covers the obvious cases but it is not a safety net.

---

## 1. 提 PR 之前（中文）

所有参与者都应遵守[行为准则](CODE_OF_CONDUCT.md)。接下来要做什么见[路线图](docs/ROADMAP.md)。

**规范改动必须先开 issue。** 用 *spec proposal (TAPI)* 模板说明问题、受影响的人、以及不改会怎样。**不要直接提修改 `spec/` 的 PR**——没有关联 issue 的会被关闭并请你从 issue 重新开始。这不是流程主义：TAP 是与实现者之间的契约，讨论过程必须日后可查。

代码修复（`sdk/`、`server/`、`contracts/`、`examples/`、`conformance/`、`scripts/`、`site/`）与文档修正**不需要**先开 issue，带测试的小 PR 直接提即可。想先讨论方案的话，开一个 bug report issue。

有问题先看[手册](https://tapeapi.fun/docs/)与[常见问题](https://tapeapi.fun/docs/zh/faq)，没有答案再开 issue。

安全问题一律不走 issue，请通过 [GitHub 私密漏洞报告](https://github.com/BruceLanLan/tapeapi/security/advisories/new)提交，见 [SECURITY.md](SECURITY.md)。

## 2. 贡献的授权

贡献按仓库发布时使用的同一许可接收（inbound = outbound），不需要签 CLA。提交贡献即表示你同意：

- **代码 MIT**——`contracts/`、`sdk/`、`server/`、`examples/`、`conformance/`、`scripts/`、`site/` 以及 `spec/` 以外的一切，见 [LICENSE](LICENSE)。
- **规范文本 CC0-1.0**——`spec/` 下的全部内容，你将你对规范文本的贡献置于公有领域，见 [LICENSE-SPEC](LICENSE-SPEC)。每个 TAP 在自己的头部表格里重复标注 `License | CC0-1.0`。

提交贡献同时表示你认可 [Developer Certificate of Origin 1.1](https://developercertificate.org/)：简言之，内容是你写的或你有权按上述许可提交，并且你知道它是公开的、会被永久保存。欢迎加 `Signed-off-by:` 行（`git commit -s`），但不强制，CI 不检查。

不要把受版权保护的规范、厂商文档或其它项目的源码粘贴进 TAP 或代码，请改为引用 URL。

## 3. 两个语言半部，永远同时改

每个 TAP 是一个文件，先英文半部后中文半部，**章节编号一一对应**：英文的 `§3.4` 与中文的 `§3.4` 必须是讲同一件事的同一节。

**对 TAP 的任何改动 MUST 在同一个提交里更新两个半部。** 只改一半的 PR 属于未完成，不会被合并——**即使只是改错别字**，因为只改一种语言会让两半悄悄失同步。写不出另一半就在 PR 里说明，维护者会与你结对；不要猜着写。

**规范性关键词数量必须一致。** 中文半部保留英文的 RFC 2119 关键词（`MUST`、`MUST NOT`、`SHOULD`、`SHOULD NOT`、`MAY`），所以两半中每个关键词的出现次数必须相同。每个 TAP 有两个一级标题 `# TAPI-`，各属一个半部；推送前运行上面英文部分给出的 `awk` 命令，分别统计两半的数量。两列必须相等，不一致就是 PR 的 bug。

**英文为准。** 两半冲突时以英文为准，中文半部即为 bug。发现不一致时请在 issue 里写明。

"两边一起改"的规则同样适用于其它双语文档：

| 英文 | 中文 | 形式 |
|---|---|---|
| `README.md` | `README.zh-CN.md` | 两个文件，都要改。 |
| `docs/guides/*.md` | `docs/guides/zh-CN/*.md` | 每篇指南两个文件，都要改，然后重建文档站（§6）。 |
| `examples/README.md` 与各示例 README | 同一文件 | 一个文件，中文在前、英文在后。 |
| `CONTRIBUTING.md`、`SECURITY.md`、`docs/ROADMAP.md`、`CODE_OF_CONDUCT.md` | 同一文件 | 一个文件，英文在前、中文在后。 |

`CHANGELOG.md` 只有英文。代码注释不受此规则约束（有帮助时双语，不强制）。

## 4. 环境与测试

前置条件：**Node.js 20 或更高**、**Python 3**（只用标准库）与 [Foundry](https://getfoundry.sh)。克隆时带上子模块（forge-std）：

```sh
git clone --recurse-submodules https://github.com/BruceLanLan/tapeapi.git
cd tapeapi
npm install --no-audit --no-fund
```

如果已经不带子模块克隆了：`git submodule update --init --recursive`。

共三套测试，**提 PR 前三套都必须通过**：

```sh
npm test                          # SDK、提供者运行时、示例、一致性测试、构建脚本（可离线运行）
python3 spec/vectors/verify.py    # 独立的 Python 实现校验测试向量
cd contracts && forge test        # Solidity
```

[CI](.github/workflows/ci.yml) 在每次推送到 `main` 和每个拉取请求上跑同样的三套（Node 22、Python 3.12、Foundry）。CI 通过后才会评审 PR。

改了签名、哈希或编码，就要同时改 `sdk/`、`spec/vectors/verify.py` 与 Solidity 测试（`node scripts/gen-vectors.mjs` 重新生成向量）：三方实现一致才能合入。

若你改动了文档里带数字的论断（测试数、gas、节点的日志窗口），请重新跑一遍用真实数字，**不要从旧文档里抄数字**。

部分示例在运行时会访问公开的 BSC RPC 节点；单元测试不会。

## 5. 需要额外审查的改动

以下三个领域承载着整个标准所依赖的安全性质。触及其中任何一项的 PR 会得到更慢更严的评审，需要在 PR 正文中用文字论证该性质为何仍然成立，且**必须在改动代码经过审计之后才能发布**：

1. **验证（verification）**——响应信封摘要与签名路径（TAPI-21；`sdk/src/sig.js`、`sdk/src/canon.js`、`server/src/index.js` 中的信封构造）、委托校验（TAPI-20 §3.4）、凭证签名恢复（TAPI-22）。包含规范 JSON：改规范化就是改所有已经产生过的签名。
2. **隔离（isolation）**——一切决定"客户端信任什么、信任谁"的东西：解析算法（TAPI-20 §3.6，包括名称解析 `<#ID>.<processor>.tape`）、容器必须链上推导且永不接受自报这一条、`dev` / `allowSingleNode` / `allowHttp` 开关，以及法定人数行为（TAPI-23）。在这里放宽默认值属于破坏性变更，即使没有任何签名发生变化。
3. **一致（agreement）**——托管合约的记账：累计凭证、额度与承诺记账、会话授权、提现延迟与结算路径（TAPI-22；`contracts/src/TapeAPIEscrow.sol`）。这里的任何问题都可能让人损失资金。

在这些领域**只增加测试**的改动当然没问题，非常欢迎。

## 6. 生成的文件

GitHub Pages 不执行构建，所以 `site/` 下有些文件是生成后**提交进仓库**的。`npm test` 会重新构建并在已提交内容不一致时失败，因此请在同一个 PR 里重新生成并提交：

| 你改了 | 运行 | 提交 |
|---|---|---|
| `docs/guides/*.md`、`docs/guides/zh-CN/*.md` 或 `CHANGELOG.md` | `npm run build:docs` | `site/docs/` |
| SDK 导入到的任何文件（`sdk/src/`） | `npm run build:playground`，然后 `npm run build:assets` | `site/playground/vendor/<hash>/`（旧目录已删除，用 `git rm -r` 提交删除）、`site/playground/`、`site/verify/`、`site/dashboard/` 里的 import map 与 vendor 路径，以及重新加戳的页面 |
| `contracts/src/ChannelBus.sol`（很少见；已部署的字节码是固定的） | `cd contracts && forge build && cd .. && node scripts/build-console.mjs` | `site/console/channelbus.json` |

改 markdown 源文件，不要改生成的 HTML。`site/` 只用相对路径。

## 7. 版本

遵循 semver，标准与软件包分别适用。

- **规范。** 处于 `Draft` 的 TAP 可自由修改，在其自身的变更记录小节写清改了什么、为什么。处于 `Stable (v1)`（TAPI-1 §4.1）的 TAP 已冻结：已定义的字段、编码、签名域与错误码保持含义，修订只能追加可选内容与非规范性文字；可能让合规的 v1 实现变得不合规的改动，要开新版本（v2），并使用自己的线上标记。标为 `Experimental` 的章节与 TAP 可以在任何版本里修改。
- **软件包。** `@tapeapi/sdk` 与 `@tapeapi/server` 自 1.0.0 起遵循语义化版本：按 1.0 文档写的代码在所有 1.x 版本里都能继续使用，Stable 接口的破坏性修改只能升 major（2.0）。标为 `@experimental` 的接口可以在 minor 版本里修改，并写进更新日志。两个包以 GitHub Release 附件的形式发布，不在 npm 上。
- 除非维护者要求，PR 里不要改版本号，发版单独进行。用户可见的改动请在 `CHANGELOG.md` 的 `[Unreleased]` 下加一行。

## 8. 仓库布局

| 路径 | 是什么 |
|---|---|
| `spec/` | TAPI-1 与 TAPI-20…27，测试向量与 `verify.py` 在 `spec/vectors/`。双语，英文为准，CC0。 |
| `contracts/` | `src/ServiceDirectory.sol`、`src/TapeAPIEscrow.sol`、`src/ChannelBus.sol`，Foundry 测试在 `test/`；forge-std 是 `lib/` 下的子模块。 |
| `sdk/` | `@tapeapi/sdk`——ESM，Node 20+ 与浏览器，仅依赖 `@noble/*`。 |
| `server/` | `@tapeapi/server`——提供者运行时（Node 与 Fetch API）。 |
| `examples/` | 可运行示例，包括公共服务与中继；索引见 `examples/README.md`。 |
| `conformance/` | 面向提供者与中继的黑盒一致性测试。 |
| `site/` | tapeapi.fun 静态站点：首页、手册（生成）、调试台、状态页、持有人控制台。 |
| `docs/` | 指南（`docs/guides/`）、说明文档与运营手册——见 `docs/README.md`。 |
| `scripts/` | 构建脚本（`build-docs`、`build-playground`、`build-console`）、`gen-vectors`、`monitor`（CI 每 30 分钟跑一次的状态检查）、`channel-keys`、`probe-mainnet`（只读）。 |
| `DESIGN.md` | 所有模块必须遵守的设计契约。 |

## 9. 文档

新增文档请在 `docs/README.md` 里链接，并写中英两半，英文在前。文档里写到的数字（测试数、gas 成本、节点的日志窗口）要写明怎么测、何时测的。

## 10. 提交与 PR

- 一个 PR 一件事。规范改动与实现它的代码改动若必须一起落地，可以同一个 PR，请在正文说明。
- 提交标题写成 `领域: 这次改动做了什么`，而不是你做了什么：`escrow: settle clamps to the cap instead of voiding the voucher`、`Public service: drop a node that times out`。
- 如实填写 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md)。**不打勾并写一句原因，远好过打了一个不属实的勾。**
- 永远不要提交机密：私钥、`.env`、助记词、带 API Key 的 RPC URL 都不行。`.gitignore` 覆盖了常见情况，但它不是安全网。
