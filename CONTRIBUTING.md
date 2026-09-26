# Contributing to TapeAPI / 参与 TapeAPI

> English is authoritative. 中文见下半部分，章节编号一一对应。
> Modelled on TapeKit's contribution process, so that a TapeOut maintainer reviewing a TAP here sees the rules they already know.

## 1. Before you open a pull request

**A specification change needs an issue first.** Open a *spec proposal (TAP)* issue describing the problem, who is affected, and what breaks if we do nothing. Do not send a PR that edits `spec/` without a linked issue — it will be closed and asked to start as an issue. This is not bureaucracy: a TAP is a contract with implementers, and the discussion has to be findable later.

Code fixes (`sdk/`, `server/`, `contracts/`, `examples/`, `scripts/`, `site/`) do **not** need an issue first. A small, tested PR is welcome directly. A bug report issue helps if you want to discuss the fix before writing it.

Security problems do not go in issues at all. See [SECURITY.md](SECURITY.md).

## 2. Licensing of contributions

By contributing you agree that:

- **Code is MIT** — `contracts/`, `sdk/`, `server/`, `examples/`, `scripts/`, `site/`. See [LICENSE](LICENSE).
- **Specification text is CC0-1.0** — everything under `spec/`. You place your contribution to the spec text in the public domain. See [LICENSE-SPEC](LICENSE-SPEC). Each TAP repeats `License | CC0-1.0` in its own header table.

Do not paste text from a copyrighted specification, vendor documentation or another project's source into a TAP or into the code. Cite it by URL instead.

## 3. Both language halves, always

Every TAP is one file containing an English half and a Chinese half, in that order, with **section numbering that corresponds one-to-one**. `§3.4` in English and `§3.4` in Chinese must be the same section about the same thing.

**Every change to a TAP MUST update both halves in the same commit.** A PR that edits only one half is incomplete and will not be merged — not even for a typo, because a typo fix in one language silently desynchronises the two. If you cannot write the other half, say so in the PR and a maintainer will pair with you; do not guess.

**English is authoritative.** Where the two halves disagree, English wins and the Chinese half is the bug. Say so in the issue when you find a mismatch.

The same bilingual rule applies to `README.md`, `examples/README.md` and the per-example READMEs, which are all Chinese-then-English. It does not apply to code comments (bilingual where helpful, not required) or to internal `docs/` notes.

## 4. Versioning

We follow semver, applied to the standard and to the packages separately.

- **Specs.** A TAP in `Draft` may change freely; record what changed and why in its own change log section. Once a TAP is `Final`, a change that can make a previously-conforming implementation non-conforming needs a **new TAP that supersedes it**, not an edit. Adding an optional field is a minor change; changing a digest preimage, a typehash, an error code's meaning or a MUST is a breaking change. Precedent: TAP-21's envelope digest went `TAPI-1/resp/v1` → `TAPI-1/resp/v2` rather than being edited in place, and v2 clients reject v1.
- **Packages.** `@tapeapi/sdk` and `@tapeapi/server` are pre-1.0; minor bumps may break. After 1.0, a breaking wire-format or API change is a major bump.
- Do not bump versions in a PR unless a maintainer asks. Releases are cut separately.

## 5. Changes that get extra scrutiny

Three areas carry the security properties the whole standard rests on. A PR touching any of them gets a slower, harder review, needs a written argument in the PR body for why the property still holds, and **ships only after an audit of the changed code**:

1. **Verification** — the response envelope digest and signature path (TAP-21; `sdk/src/sig.js`, `sdk/src/canon.js`, envelope construction in `server/src/index.js`), the delegation check (TAP-20 §3.4, `ServiceDirectory.verifyDelegation`), and voucher signature recovery (TAP-22). Includes canonical JSON: a change to canonicalisation is a change to every signature ever produced.
2. **Isolation** — anything that decides what a client trusts and from whom: the resolution algorithm (TAP-20 §3.6), the rule that a container is derived on-chain and never self-reported, the `dev` / `allowSingleNode` / `allowHttp` switches, and quorum behaviour (TAP-23). Weakening a default here is a breaking change even if no signature moves.
3. **Agreement** — the escrow's accounting: cumulative vouchers, allowance and commitment accounting, session authorisation, withdraw delays and the settle path (TAP-22; `contracts/src/TapeAPIEscrow.sol`). Anything here can lose someone's money.

A change in these areas that only adds a test is of course fine and welcome.

## 6. Running the tests

Node 20+ and [Foundry](https://getfoundry.sh) are the only prerequisites.

```sh
npm install --no-audit --no-fund
npm test                      # SDK, provider runtime and example unit tests
git submodule update --init && cd contracts && forge test    # Solidity (forge-std is a submodule)
```

At the time of writing these pass 176 and 107 tests respectively. **Both must pass before you open a PR**, and the PR checklist asks you to confirm it. If you change a count-bearing claim in the docs, re-run and use the real number — do not copy a number from an older document.

Some examples reach public BSC RPC nodes at runtime; the unit tests do not, and run offline.

## 7. Repository layout

| Path | What it is |
|---|---|
| `spec/` | TAP-1 and TAP-20…25. Bilingual, English authoritative, CC0. |
| `contracts/` | `src/ServiceDirectory.sol`, `src/TapeAPIEscrow.sol`, `src/ChannelBus.sol`, Foundry tests in `test/`. |
| `sdk/` | `@tapeapi/sdk` — ESM, Node 20+ and browser, depends only on `@noble/*`. |
| `server/` | `@tapeapi/server` — the provider runtime. |
| `examples/` | Ten runnable examples; index and per-example method tables in `examples/README.md`. |
| `site/` | The static public site. Relative paths only (DeWEB rule). |
| `docs/` | Design notes and the operator guide — see `docs/README.md`. |
| `scripts/` | `compile.mjs`, `gen-vectors.mjs` (test vectors), `channel-keys.mjs` (a container's channel identity), `probe-mainnet.mjs` (read-only). |
| `DESIGN.md` | The design contract every module must obey. |

## 8. Documents

If you add a document, link it from `docs/README.md` and write both language halves, English first. A document that states a number (a test count, a gas cost, a node's log window) says how and when it was measured.

## 9. Commits and PRs

- One logical change per PR. A spec change and a code change that implements it may share a PR if they must land together; say so.
- Write the commit subject as what the change does, not what you did: `escrow: settle clamps to the cap instead of voiding the voucher`.
- Fill in `PULL_REQUEST_TEMPLATE.md` honestly. An unchecked box with a sentence explaining why is much better than a checked box that is not true.
- No secrets, ever: no private keys, no `.env`, no RPC URLs carrying an API key. `.gitignore` covers the obvious cases but it is not a safety net.

---

## 1. 提 PR 之前（中文）

**规范改动必须先开 issue。** 用 *spec proposal (TAP)* 模板说明问题、受影响的人、以及不改会怎样。**不要直接提修改 `spec/` 的 PR**——没有关联 issue 的会被关闭并请你从 issue 重新开始。这不是流程主义：TAP 是与实现者之间的契约，讨论过程必须日后可查。

代码修复（`sdk/`、`server/`、`contracts/`、`examples/`、`scripts/`、`site/`）**不需要**先开 issue，带测试的小 PR 直接提即可。想先讨论方案的话，开一个 bug report issue。

安全问题一律不走 issue，见 [SECURITY.md](SECURITY.md)。

## 2. 贡献的授权

提交贡献即表示你同意：

- **代码 MIT**——`contracts/`、`sdk/`、`server/`、`examples/`、`scripts/`、`site/`，见 [LICENSE](LICENSE)。
- **规范文本 CC0-1.0**——`spec/` 下的全部内容，你将你对规范文本的贡献置于公有领域，见 [LICENSE-SPEC](LICENSE-SPEC)。每个 TAP 在自己的头部表格里重复标注 `License | CC0-1.0`。

不要把受版权保护的规范、厂商文档或其它项目的源码粘贴进 TAP 或代码，请改为引用 URL。

## 3. 两个语言半部，永远同时改

每个 TAP 是一个文件，先英文半部后中文半部，**章节编号一一对应**：英文的 `§3.4` 与中文的 `§3.4` 必须是讲同一件事的同一节。

**对 TAP 的任何改动 MUST 在同一个提交里更新两个半部。** 只改一半的 PR 属于未完成，不会被合并——**即使只是改错别字**，因为只改一种语言会让两半悄悄失同步。写不出另一半就在 PR 里说明，维护者会与你结对；不要猜着写。

**英文为准。** 两半冲突时以英文为准，中文半部即为 bug。发现不一致时请在 issue 里写明。

同样的双语规则适用于 `README.md`、`examples/README.md` 和各示例的 README（均为中文在前、英文在后）。不适用于代码注释（有帮助时双语，不强制）与 `docs/` 下的内部笔记。

## 4. 版本

遵循 semver，标准与软件包分别适用。

- **规范。** 处于 `Draft` 的 TAP 可自由修改，在其自身的变更记录小节写清改了什么、为什么。一旦 `Final`，任何可能让原本合规的实现变成不合规的改动，需要**一个取代它的新 TAP**，而不是就地编辑。新增可选字段属于 minor；改摘要前像、改 typehash、改错误码含义、改任何 MUST，都属于破坏性变更。先例：TAP-21 的信封摘要从 `TAPI-1/resp/v1` 升到 `TAPI-1/resp/v2` 是新版本而非就地修改，且 v2 客户端拒绝 v1。
- **软件包。** `@tapeapi/sdk` 与 `@tapeapi/server` 尚未 1.0，minor 版本也可能破坏兼容。1.0 之后，破坏线格式或 API 的改动升 major。
- 除非维护者要求，PR 里不要改版本号，发版单独进行。

## 5. 需要额外审查的改动

以下三个领域承载着整个标准所依赖的安全性质。触及其中任何一项的 PR 会得到更慢更严的评审，需要在 PR 正文中用文字论证该性质为何仍然成立，且**必须在改动代码经过审计之后才能发布**：

1. **验证（verification）**——响应信封摘要与签名路径（TAP-21；`sdk/src/sig.js`、`sdk/src/canon.js`、`server/src/index.js` 中的信封构造）、委托校验（TAP-20 §3.4，`ServiceDirectory.verifyDelegation`）、凭证签名恢复（TAP-22）。包含规范 JSON：改规范化就是改所有已经产生过的签名。
2. **隔离（isolation）**——一切决定"客户端信任什么、信任谁"的东西：解析算法（TAP-20 §3.6）、容器必须链上推导且永不接受自报这一条、`dev` / `allowSingleNode` / `allowHttp` 开关，以及法定人数行为（TAP-23）。在这里放宽默认值属于破坏性变更，即使没有任何签名发生变化。
3. **一致（agreement）**——托管合约的记账：累计凭证、额度与承诺记账、会话授权、提现延迟与结算路径（TAP-22；`contracts/src/TapeAPIEscrow.sol`）。这里的任何问题都可能让人损失资金。

在这些领域**只增加测试**的改动当然没问题，非常欢迎。

## 6. 跑测试

前置条件只有 Node 20+ 与 [Foundry](https://getfoundry.sh)。

```sh
npm install --no-audit --no-fund
npm test                      # SDK、提供者运行时与示例单元测试
git submodule update --init && cd contracts && forge test    # Solidity（forge-std 是子模块）
```

撰写本文时两者分别通过 176 与 107 个测试。**提 PR 前两者都必须通过**，PR 清单里会让你确认这一点。若你改动了文档里带数字的论断，请重新跑一遍用真实数字，**不要从旧文档里抄数字**。

部分示例在运行时会访问公开的 BSC RPC 节点；单元测试不会，可离线运行。

## 7. 仓库布局

| 路径 | 是什么 |
|---|---|
| `spec/` | TAP-1 与 TAP-20…25。双语，英文为准，CC0。 |
| `contracts/` | `src/ServiceDirectory.sol`、`src/TapeAPIEscrow.sol`、`src/ChannelBus.sol`，Foundry 测试在 `test/`。 |
| `sdk/` | `@tapeapi/sdk`——ESM，Node 20+ 与浏览器，仅依赖 `@noble/*`。 |
| `server/` | `@tapeapi/server`——提供者运行时。 |
| `examples/` | 十个可运行示例；索引与各示例方法表见 `examples/README.md`。 |
| `site/` | 公开静态站点。仅用相对路径（DeWEB 规则）。 |
| `docs/` | 设计说明与运营手册——见 `docs/README.md`。 |
| `scripts/` | `compile.mjs`、`gen-vectors.mjs`（测试向量）、`channel-keys.mjs`（容器的通道身份）、`probe-mainnet.mjs`（只读）。 |
| `DESIGN.md` | 所有模块必须遵守的设计契约。 |

## 8. 文档

新增文档请在 `docs/README.md` 里链接，并写中英两半，英文在前。文档里写到的数字（测试数、gas 成本、节点的日志窗口）要写明怎么测、何时测的。

## 9. 提交与 PR

- 一个 PR 一件事。规范改动与实现它的代码改动若必须一起落地，可以同一个 PR，请在正文说明。
- 提交标题写这次改动做了什么，而不是你做了什么：`escrow: settle clamps to the cap instead of voiding the voucher`。
- 如实填写 `PULL_REQUEST_TEMPLATE.md`。**不打勾并写一句原因，远好过打了一个不属实的勾。**
- 永远不要提交机密：私钥、`.env`、带 API Key 的 RPC URL 都不行。`.gitignore` 覆盖了常见情况，但它不是安全网。
