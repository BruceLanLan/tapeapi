## What this changes / 本次改动

<!-- One logical change. Say what it does, not what you did. 一个 PR 一件事，写改动做了什么。 -->

Closes #

<!-- A PR touching spec/ MUST link a spec proposal (TAPI) issue. 改动 spec/ 的 PR 必须关联一个 spec proposal issue。 -->

## Why / 为什么

<!-- If this touches verification, isolation or agreement (CONTRIBUTING.md §5), argue here why the
     security property still holds. 若触及验证/隔离/一致，请在此论证该安全性质为何仍然成立。 -->

## Checklist / 清单

Tick only what is true. **An unchecked box with one sentence of explanation is much better than a checked box that is not.**
只勾属实的项。**不打勾并写一句原因，远好过打一个不属实的勾。**

- [ ] `npm test` passes on a clean checkout — count: ____
- [ ] `python3 spec/vectors/verify.py` passes — count: ____
- [ ] `cd contracts && forge test` passes — count: ____
- [ ] If I changed a signature, hash or encoding: the SDK, `spec/vectors/verify.py` and the Solidity tests all agree. 改了签名/哈希/编码时，SDK、Python 校验器与 Solidity 测试三方一致。
- [ ] **Generated files rebuilt and committed** (`npm run build:docs` for guides or the changelog, `npm run build:playground` for `sdk/src`). 生成文件已重建并提交。
- [ ] Any test count or measured number I changed in the docs was **re-measured**, not copied from an older file. 文档里改动的测试数/实测数字是**重新跑出来的**，不是从旧文件抄的。
- [ ] **Both language halves updated** (`spec/` with matching section numbers and MUST / SHOULD / MAY counts, `README.md` + `README.zh-CN.md`, `docs/guides/` + `docs/guides/zh-CN/`, `examples/` READMEs). English is authoritative. 两个语言版本均已更新，英文为准。
- [ ] **New documents are linked** from `docs/README.md`, in both languages. 新文档已在 `docs/README.md` 中链接，中英两半齐全。
- [ ] User-visible change noted under `[Unreleased]` in `CHANGELOG.md`. 用户可见的改动已写进 `CHANGELOG.md`。
- [ ] **No secrets.** No private keys, `.env` contents, mnemonics, or RPC URLs carrying an API key — in the diff, the tests, or the PR description. 无私钥、`.env` 内容、助记词或带 API Key 的 RPC URL。
- [ ] This PR is **not** a security fix for an undisclosed vulnerability. (If it is, stop — report it privately: https://github.com/BruceLanLan/tapeapi/security/advisories/new) 本 PR **不是**未披露漏洞的修复（若是，请停下并私密报告）。
- [ ] No version bumps unless a maintainer asked. 未擅自改版本号。
- [ ] Docs updated if behaviour changed (`DESIGN.md`, the relevant TAP, the guide, the example README). 行为变了就更新了文档。
- [ ] I have the right to submit this under MIT (code) / CC0-1.0 (`spec/`), per the Developer Certificate of Origin (CONTRIBUTING.md §2). 我有权按 MIT / CC0-1.0 提交本改动（见 CONTRIBUTING.md §2）。

## Areas needing extra scrutiny / 需额外审查的领域

- [ ] Verification — envelope digest, signatures, canonical JSON, delegation, voucher recovery / 验证
- [ ] Isolation — resolution (including names), container derivation, `dev` / `allowSingleNode` / `allowHttp`, quorum / 隔离
- [ ] Agreement — escrow accounting, allowances, sessions, settle / 一致
- [ ] None of the above / 以上都不涉及

<!-- Any ticked box above means this ships only after an audit of the changed code (CONTRIBUTING.md §5).
     勾选上述任一项即表示：改动代码经审计后才能发布。 -->
