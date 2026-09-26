## What this changes / 本次改动

<!-- One logical change. Say what it does, not what you did. 一个 PR 一件事，写改动做了什么。 -->

Closes #

<!-- A PR touching spec/ MUST link a spec proposal (TAP) issue. 改动 spec/ 的 PR 必须关联一个 spec proposal issue。 -->

## Why / 为什么

<!-- If this touches verification, isolation or agreement (CONTRIBUTING.md §5), argue here why the
     security property still holds. 若触及验证/隔离/一致，请在此论证该安全性质为何仍然成立。 -->

## Checklist / 清单

Tick only what is true. **An unchecked box with one sentence of explanation is much better than a checked box that is not.**
只勾属实的项。**不打勾并写一句原因，远好过打一个不属实的勾。**

- [ ] `npm test` passes on a clean checkout — count: ____
- [ ] `cd contracts && forge test` passes — count: ____
- [ ] Any test count or measured number I changed in the docs was **re-measured**, not copied from an older file. 文档里改动的测试数/实测数字是**重新跑出来的**，不是从旧文件抄的。
- [ ] **Both language halves updated** with matching section numbers (`spec/`, `README.md`, `examples/README.md`, per-example READMEs). English is authoritative. 两个语言半部均已更新且章节编号对应，英文为准。
- [ ] **New documents are linked** from `docs/README.md`, in both languages. 新文档已在 `docs/README.md` 中链接，中英两半齐全。
- [ ] **No secrets.** No private keys, `.env` contents, mnemonics, or RPC URLs carrying an API key — in the diff, the tests, or the PR description. 无私钥、`.env` 内容、助记词或带 API Key 的 RPC URL。
- [ ] This PR is **not** a security fix for an undisclosed vulnerability. (If it is, stop — see [SECURITY.md](SECURITY.md).) 本 PR **不是**未披露漏洞的修复。
- [ ] No version bumps unless a maintainer asked. 未擅自改版本号。
- [ ] Docs updated if behaviour changed (`DESIGN.md`, the relevant TAP, the example README). 行为变了就更新了文档。

## Areas needing extra scrutiny / 需额外审查的领域

- [ ] Verification — envelope digest, signatures, canonical JSON, delegation, voucher recovery / 验证
- [ ] Isolation — resolution, container derivation, `dev` / `allowSingleNode` / `allowHttp`, quorum / 隔离
- [ ] Agreement — escrow accounting, allowances, sessions, settle / 一致
- [ ] None of the above / 以上都不涉及

<!-- Any ticked box above means this ships only after an audit of the changed code (CONTRIBUTING.md §5).
     勾选上述任一项即表示：改动代码经审计后才能发布。 -->
