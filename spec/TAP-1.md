| TAP | 1 |
|---|---|
| Title | TAP Purpose and Guidelines |
| Author | Bruce (@BruceLanLan) |
| Status | Draft |
| Implementation | Not adopted (2026-09-27). A suggested process, offered to the TapeKit maintainers in TapeKit issue #8; TapeKit has no numbered-proposal process yet. |
| Type | Informational (Process) |
| Created | 2026-09-20 |
| Requires | — |
| License | CC0-1.0 |

# TAP-1: TAP Purpose and Guidelines

> English is authoritative. 中文译文见下半部分，章节编号一一对应。

> **A suggested process, with a placeholder number.** This document is a suggested process for numbered TapeOut proposals, offered to the TapeKit maintainers in [TapeKit issue #8](https://github.com/TapeOutProtocol/TapeKit/issues/8). TapeKit has no numbered-proposal process yet: its `SPEC.md` (`tape://` v0.2) states its own change rules in §15, and TAP-10 (TapeSend) is the maintainers' own number, currently being rewritten by them. The numbers TAP-1 and TAP-20 to TAP-27 are placeholders the maintainers may reassign. If the maintainers adopt another process, these documents move to it.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

## 1. Abstract

A TapeOut Proposal (TAP) is a design document that proposes a change to, or a standard built on, the TapeOut protocol. This document defines what a TAP is, the types of TAPs, their lifecycle, numbering, required contents, the criteria for reaching Final, and the roles of editors and maintainers; it also defines the interim statuses, Stable (v1) among them, that the documents of this repository use until TapeKit adopts a process. It is deliberately short; when this document is silent, editors SHOULD follow the spirit of EIP-1. It is offered to the TapeKit maintainers as a suggestion, not as a process they have adopted.

## 2. Motivation

TapeOut is specified by `SPEC.md` in the TapeKit repository. `SPEC.md` §15 states how the specification may change, and §15.1 lists promises that never change. A messaging layer, TapeSend, carries the maintainers' own number TAP-10 and is being rewritten by them, but there is no process by which a third party can propose an interface, a contract, or a specification change and know how it will be evaluated.

The goal of TAP-1 is to give ecosystem contributors a defined entrance. The process MUST make it easy to build on the protocol without touching the §15.1 promises, and MUST make any attempt to touch them explicit and visible.

## 3. TAP Types

- **Core**: changes to `SPEC.md` or to the reference shells (the preview and gateway implementations maintained in TapeKit). A Core TAP that would alter a §15.1 invariant MUST say so in its Abstract and is expected to be rejected.
- **Standards**: interfaces, contracts, manifests, message formats, or client behaviours that build on the protocol without changing it. TAP-20 (TapeAPI) is a Standards TAP, and in this scheme so would be TAP-10 (TapeSend). A Standards TAP MUST NOT require a change to `SPEC.md`; if it does, it MUST be split and the `SPEC.md` part filed as Core.
- **Informational**: guidelines, process documents, and design notes that do not propose a new feature. Informational TAPs are not binding. This document is Informational.

## 4. Workflow and Statuses

1. **Idea**: an issue in `TapeOutProtocol/TapeKit` describing the proposal. An issue is REQUIRED before a Core TAP pull request is opened (CONTRIBUTING rule); it is RECOMMENDED for other types.
2. **Draft**: a pull request adding `spec/TAP-N.md`. Editors merge a Draft once it is complete in form (§6). Content is expected to change.
3. **Review**: the author declares the Draft ready. Editors and maintainers review; anyone MAY comment on the tracking issue.
4. **Last Call**: a final 14-day review window. Editors set `Last-Call-Deadline`. Any normative change during Last Call returns the TAP to Review.
5. **Final**: the TAP meets §7 and Last Call passed without unresolved normative objections. A Final TAP MUST NOT change except for errata that do not alter behaviour.
6. **Stagnant**: a Draft or Review TAP with no activity for 6 months. The author or anyone MAY resurrect it to Draft.
7. **Withdrawn**: the author has withdrawn the TAP. The number is not reused.
8. **Living**: a TAP that is designed to be continually updated and never reaches Final. This document is Living once merged.

Status transitions are recorded by editors in the front matter.

### 4.1 Interim Statuses: Stable (v1)

TapeKit has no numbered-proposal process yet (§5), so no document can reach Final under §4. Until it has one, the documents this repository publishes (TAP-20 to TAP-27) carry one of the four statuses below in their `Status` row. They are this repository's own labels for its own documents: they are not TapeKit statuses and claim no endorsement by the maintainers.

- **Draft**: as in §4 item 2. Normative text can still change, including incompatibly.
- **Stable (v1)**: version 1 of the document is frozen under the rules below. A document reaches it once its test vectors are complete and checked by independent implementations (§6 item 6).
- **Experimental**: published for review and implementation experience, outside the stability promise. It can change incompatibly or be withdrawn at any time, without a new version.
- **Withdrawn**: as in §4 item 7. The text is kept for the record; implementations SHOULD NOT implement it, and its number is not reused.

A document that intends to become Stable (v1) MAY say so while still in Draft with the optional `Target` row (§6), for example `Target | Stable (v1) at TapeAPI 1.0`. The row is a plan, not a status: the document stays Draft, with everything that implies, until its `Status` row changes.

**The freeze.** Once a document is Stable (v1):

1. Every field, encoding, signature domain (digest prefixes and layouts, EIP-712 domains and type strings, key-derivation labels) and error code it defines MUST keep its meaning. None is removed, renamed, re-typed or given a new meaning.
2. A revision MAY add only (a) OPTIONAL content, i.e. a new field, method, error code or behaviour that a v1 implementation ignoring it stays conformant without, and (b) non-normative text: clarifications, examples, test vectors and implementation status. A new requirement that would make a conformant v1 implementation non-conformant is not an addition and MUST NOT be made in v1.
3. A section of a Stable (v1) document MAY be marked Experimental (for example a contract that is not deployed). That section is outside the freeze, and the rest of the document MUST NOT depend on it.
4. Every revision is recorded, with its date, in the `Revision` row.

**Breaking changes and coexistence.** A change the freeze does not allow MUST be made as a new version, v2, and never as an edit of v1:

1. v2 is a new document (or a new number) with its own status, and wherever v1 carries a version marker on the wire (a digest prefix, the manifest's `tapeapi` version, an EIP-712 `version`, a key-derivation label), v2 carries its own, so that a v1 message and a v2 message can never be taken for each other.
2. Publishing v2 does not change v1: v1 stays Stable (v1), and conformant v1 implementations stay conformant.
3. A verifier MUST NOT accept a message under a version it does not implement, and MUST NOT interpret a message of one version under the rules of the other. An implementation MAY implement both versions side by side, and a provider MAY offer both at once.
4. v1 MUST NOT be moved to Withdrawn earlier than 12 months after v2 becomes Stable, and the planned date MUST be written into the v1 document at least 3 months in advance.

**Relationship to TapeKit.** These statuses exist only because TapeKit has no process yet. When the TapeKit maintainers assign a number or a status to one of these documents, or adopt a process of their own, TapeKit's assignment prevails: the document takes the number and status TapeKit gives it, and its front matter records how the status used here maps onto it (for example "Stable (v1), now TapeKit Final"). If TapeKit asks for an incompatible change to a Stable (v1) document, the change is made as v2 under the rules above, so the mapping never breaks a v1 implementation.

## 5. Numbering

- `TAP-1` is reserved for this document.
- `10–19`: messaging. `TAP-10` is TapeSend, the maintainers' own number.
- `20–29`: services. `TAP-20` is TapeAPI; `TAP-21` to `TAP-27` are its companion documents.
- Other ranges are unallocated; maintainers MAY allocate a range when a family of proposals appears.
- Maintainers assign numbers. Authors MUST NOT self-assign. A number, once assigned, is never reused.
- The numbers TAP-1 and TAP-20 to TAP-27 used by this repository are **proposed** to the maintainers of `TapeOutProtocol/TapeKit` in [TapeKit issue #8](https://github.com/TapeOutProtocol/TapeKit/issues/8); none has been assigned yet, and each will be renumbered if the maintainers so decide.

## 6. What Belongs in a TAP

A TAP is a single Markdown file `spec/TAP-N.md`, English first, followed by a Chinese translation aligned section by section with identical numbering. The English text is authoritative. Front matter is a table with: TAP, Title, Author, Status, Type, Created, Requires, License (and `Last-Call-Deadline` when applicable). Three further rows are optional: `Revision`, which summarises a revision that replaced earlier normative text; `Implementation`, which states, with a date, what is implemented and deployed (addresses and URLs) and what is not; and `Target`, which names the status a Draft intends to reach and when (§4.1).

Required sections, in order:

1. **Abstract**: two to four sentences describing the technical issue and the proposal.
2. **Motivation**: why the existing protocol or existing TAPs are inadequate.
3. **Specification**: normative text using RFC 2119 keywords. It MUST be sufficient to build an interoperable implementation without reading the reference implementation.
4. **Rationale**: why this design and not the alternatives.
5. **Backwards Compatibility**: what existing behaviour changes. If nothing changes, say so. A Standards TAP MUST state that it does not alter the name grammar or any §15.1 invariant.
6. **Test Vectors**: concrete inputs and outputs (hashes, digests, mainnet addresses and block numbers where relevant). Placeholders are acceptable in Draft and MUST be filled before Final.
7. **Reference Implementation**: a link to code. OPTIONAL for Informational.
8. **Security Considerations**: REQUIRED for Core and Standards. A TAP without this section MUST NOT enter Review.
9. **Copyright**: `Copyright and related rights waived via CC0-1.0.`

## 7. Requirements for Final

A TAP MUST NOT move to Final unless all of the following hold:

1. **Implementation**: either (a) two independent implementations that interoperate, or (b) one reference implementation with automated tests **and** at least one test vector produced on BNB Smart Chain mainnet (chainId 56).
2. **§15.1**: the TAP does not violate any invariant listed in `SPEC.md` §15.1. Editors MUST check this explicitly and record the check in the pull request.
3. **Core only**: the audit rule in CONTRIBUTING applies. Changes to contracts or to the verification path of the reference shells MUST have an audit or an equivalent independent review before Final.
4. **Bilingual**: the Chinese translation is complete and aligned.

## 8. Editors and Decision

- **Editors** are the maintainers of `TapeOutProtocol/TapeKit`, or persons they delegate. Editors check form: completeness, formatting, numbering, the §15.1 check, and the bilingual requirement. Editors do not judge merit.
- **Core TAPs**: merit is decided by the maintainers. A Core TAP MAY be rejected on merit at any status before Final.
- **Standards TAPs**: there is no merit gate. A Standards TAP reaches Final by meeting §7. Maintainers MAY attach a non-binding note recommending or discouraging adoption.
- **Informational TAPs**: merged at editor discretion.

## 9. Relationship to SPEC.md

`SPEC.md` remains the single normative document for the `tape://` protocol. A TAP never replaces it.

- A Core TAP that is accepted is merged as a revision of `SPEC.md` under its semver rules; the changelog entry MUST cite the TAP number. The TAP is then marked Final and points to the SPEC version that adopted it.
- A Standards TAP is normative for the interface it defines and for nothing else. Where a Standards TAP and `SPEC.md` disagree, `SPEC.md` wins and the TAP is defective.
- Standards TAPs MUST reuse `SPEC.md` primitives (container derivation, SHA-256 file verification, multi-node agreement, per-origin isolation) rather than redefine them.

## 10. Copyright

Copyright and related rights waived via CC0-1.0. Code samples in TAPs are MIT unless stated otherwise.

---

# TAP-1：TAP 的目的与指南（中文译文）

> 英文为权威文本，本译文与英文章节一一对应。

> **建议的流程，占位的编号。** 本文档是为 TapeOut 编号提案建议的一套流程，已在 [TapeKit issue #8](https://github.com/TapeOutProtocol/TapeKit/issues/8) 中提交给 TapeKit 维护者参考。TapeKit 目前还没有编号提案流程：其 `SPEC.md`（`tape://` v0.2）在 §15 规定了自身的修改规则，TAP-10（TapeSend）是维护者自己的编号，目前正由他们重写。TAP-1 与 TAP-20 至 TAP-27 这些编号都是占位编号，维护者可以重新分配。若维护者采用其它流程，这些文档随之迁移过去。

> **实现状态（2026-09-27）：** 未被采纳。这是一套建议的流程，已在 TapeKit issue #8 中提交给 TapeKit 维护者；TapeKit 目前还没有编号提案流程。

本文档中的关键词 "MUST"（必须）、"MUST NOT"（禁止）、"REQUIRED"（必需）、"SHALL"、"SHOULD"（应当）、"SHOULD NOT"（不应）、"RECOMMENDED"（推荐）、"MAY"（可以）、"OPTIONAL"（可选）按 RFC 2119 解释。

## 1. 摘要

TapeOut 提案（TAP）是一份设计文档，用于提出对 TapeOut 协议的修改，或基于该协议的标准。本文档定义 TAP 是什么、TAP 的类型、生命周期、编号规则、必需内容、进入 Final 的条件，以及编辑与维护者的角色；并定义本仓库文档在 TapeKit 采纳流程之前使用的过渡状态，其中包括 Stable (v1)。本文档刻意简短；本文档未涉及之处，编辑 SHOULD 遵循 EIP-1 的精神。本文档作为建议提交给 TapeKit 维护者，并非他们已采纳的流程。

## 2. 动机

TapeOut 由 TapeKit 仓库中的 `SPEC.md` 规定。`SPEC.md` §15 说明了规范如何修改，§15.1 列出了永不改变的承诺。消息层 TapeSend 使用维护者自己的编号 TAP-10，目前正由他们重写，但目前没有任何流程可以让第三方提出接口、合约或规范修改，并预知其将如何被评估。

TAP-1 的目标是为生态贡献者提供一个明确的入口。该流程 MUST 使"在不触碰 §15.1 承诺的前提下构建于协议之上"变得容易，并 MUST 使任何触碰这些承诺的尝试显式且可见。

## 3. TAP 类型

- **Core（核心）**：对 `SPEC.md` 或参考外壳（TapeKit 维护的 preview 与 gateway 实现）的修改。会改变 §15.1 不变量的 Core TAP MUST 在摘要中声明，且预期会被拒绝。
- **Standards（标准）**：在不修改协议的前提下构建于其上的接口、合约、清单、消息格式或客户端行为。TAP-20（TapeAPI）属于 Standards TAP，按本方案 TAP-10（TapeSend）亦然。Standards TAP MUST NOT 要求修改 `SPEC.md`；若确有需要，MUST 拆分，并将 `SPEC.md` 部分作为 Core 提交。
- **Informational（信息）**：指南、流程文档与设计说明，不提出新功能。Informational TAP 不具约束力。本文档属于 Informational。

## 4. 工作流与状态

1. **Idea（想法）**：在 `TapeOutProtocol/TapeKit` 提交描述提案的 issue。Core TAP 在开 PR 前 REQUIRED 先有 issue（CONTRIBUTING 规则）；其他类型 RECOMMENDED 先有 issue。
2. **Draft（草案）**：新增 `spec/TAP-N.md` 的 PR。形式完整（§6）后，编辑即合并 Draft。内容预期仍会变化。
3. **Review（评审）**：作者宣布 Draft 已就绪。编辑与维护者评审；任何人 MAY 在跟踪 issue 中评论。
4. **Last Call（最终征求）**：为期 14 天的最后评审窗口。编辑设置 `Last-Call-Deadline`。Last Call 期间任何规范性修改都会使 TAP 退回 Review。
5. **Final（定稿）**：TAP 满足 §7，且 Last Call 结束时无未解决的规范性异议。Final TAP MUST NOT 修改，仅允许不改变行为的勘误。
6. **Stagnant（停滞）**：6 个月无活动的 Draft 或 Review TAP。作者或任何人 MAY 将其恢复为 Draft。
7. **Withdrawn（撤回）**：作者已撤回该 TAP。编号不复用。
8. **Living（持续）**：设计上需持续更新、永不进入 Final 的 TAP。本文档合并后即为 Living。

状态变更由编辑记录在头部表格中。

### 4.1 过渡状态：Stable (v1)

TapeKit 目前还没有编号提案流程（§5），因此任何文档都无法按 §4 进入 Final。在它有流程之前，本仓库发布的文档（TAP-20 至 TAP-27）在 `Status` 行使用下面四种状态之一。这些是本仓库给自己文档的标签：不是 TapeKit 的状态，也不代表维护者的认可。

- **Draft（草案）**：同 §4 第 2 项。规范性文本仍会变化，包括不兼容的变化。
- **Stable (v1)（稳定，第 1 版）**：文档的第 1 版按下列规则冻结。文档的测试向量齐全、并经独立实现核对之后（§6 第 6 项），即进入此状态。
- **Experimental（实验性）**：为评审与积累实现经验而发布，不在稳定承诺之内。随时可能不兼容地修改或撤回，且不需要新版本。
- **Withdrawn（撤回）**：同 §4 第 7 项。文本保留备查；实现方 SHOULD NOT 实现它，编号不复用。

打算进入 Stable (v1) 的文档，在 Draft 阶段 MAY 用可选的 `Target` 行（§6）声明这一点，例如 `Target | Stable (v1) at TapeAPI 1.0`。该行是计划而非状态：在 `Status` 行改变之前，文档仍是 Draft，Draft 的一切含义照旧适用。

**冻结。** 文档一旦进入 Stable (v1)：

1. 其定义的每个字段、编码、签名域（摘要前缀与布局、EIP-712 域与类型字符串、密钥派生标签）与错误码 MUST 保持原有含义。任何一项都不删除、不改名、不改类型、不赋予新含义。
2. 修订 MAY 只增加：(a) OPTIONAL 内容，即忽略它的 v1 实现仍然合规的新字段、方法、错误码或行为；(b) 非规范性文本：澄清、示例、测试向量与实现状态。会使合规的 v1 实现变得不合规的新要求不算增加，MUST NOT 在 v1 中做出。
3. Stable (v1) 文档中的某一节 MAY 标为 Experimental（例如尚未部署的合约）。该节不在冻结范围内，文档其余部分 MUST NOT 依赖它。
4. 每次修订连同日期记录在 `Revision` 行。

**破坏性修改与版本并存。** 冻结规则不允许的修改 MUST 作为新版本 v2 做出，绝不以修改 v1 的方式做出：

1. v2 是新文档（或新编号），有自己的状态；凡是 v1 在线上带有版本标记之处（摘要前缀、清单的 `tapeapi` 版本、EIP-712 的 `version`、密钥派生标签），v2 都带自己的标记，使 v1 消息与 v2 消息永远不会被相互误认。
2. 发布 v2 不改变 v1：v1 仍为 Stable (v1)，合规的 v1 实现仍然合规。
3. 验证方 MUST NOT 按自己未实现的版本接受消息，也 MUST NOT 按另一版本的规则解释某一版本的消息。实现 MAY 并行实现两个版本，提供者 MAY 同时提供两个版本。
4. v2 进入 Stable 之后未满 12 个月，v1 MUST NOT 被改为 Withdrawn；计划日期 MUST 至少提前 3 个月写入 v1 文档。

**与 TapeKit 的关系。** 这些状态只因 TapeKit 尚无流程而存在。TapeKit 维护者一旦为其中某份文档分配编号或状态，或采纳自己的流程，即以 TapeKit 为准：文档采用 TapeKit 给出的编号与状态，并在头部记录此处所用状态与之的对应关系（例如"Stable (v1)，现为 TapeKit Final"）。若 TapeKit 要求对某份 Stable (v1) 文档做不兼容的修改，按上述规则作为 v2 进行，因此这种映射永远不会破坏 v1 的实现。

## 5. 编号

- `TAP-1` 保留给本文档。
- `10–19`：消息。`TAP-10` 为 TapeSend，是维护者自己的编号。
- `20–29`：服务。`TAP-20` 为 TapeAPI；`TAP-21` 至 `TAP-27` 为其配套文档。
- 其他区间未分配；当出现一族提案时，维护者 MAY 分配新区间。
- 编号由维护者分配。作者 MUST NOT 自行编号。编号一经分配永不复用。
- 本仓库使用的编号 TAP-1、TAP-20 至 TAP-27 是在 [TapeKit issue #8](https://github.com/TapeOutProtocol/TapeKit/issues/8) 中向 `TapeOutProtocol/TapeKit` 维护者**提议**的编号，尚未分配；维护者若另作决定，将相应改号。

## 6. TAP 应包含的内容

一个 TAP 是单个 Markdown 文件 `spec/TAP-N.md`，英文在前，其后为章节编号完全一致、逐节对应的中文译文。英文为权威文本。头部为表格，包含：TAP、Title、Author、Status、Type、Created、Requires、License（适用时还有 `Last-Call-Deadline`）。另有三行可选：`Revision`，概述一次替换了先前规范性文本的修订；`Implementation`，注明日期并说明哪些已实现、已部署（地址与 URL），哪些没有；`Target`，说明 Draft 打算进入的状态及时间（§4.1）。

必需章节，按顺序：

1. **Abstract（摘要）**：两到四句话描述技术问题与提案。
2. **Motivation（动机）**：为何现有协议或现有 TAP 不足。
3. **Specification（规范）**：使用 RFC 2119 关键词的规范性文本。MUST 足以在不阅读参考实现的情况下构建可互操作的实现。
4. **Rationale（原理）**：为何采用此设计而非其他方案。
5. **Backwards Compatibility（向后兼容）**：哪些既有行为发生变化。若无变化，需明确说明。Standards TAP MUST 声明其不改变名称语法及任何 §15.1 不变量。
6. **Test Vectors（测试向量）**：具体的输入与输出（相关时包括哈希、摘要、主网地址与区块号）。Draft 阶段可用占位符，Final 前 MUST 填齐。
7. **Reference Implementation（参考实现）**：代码链接。Informational 类型 OPTIONAL。
8. **Security Considerations（安全考量）**：Core 与 Standards 类型 REQUIRED。缺少本节的 TAP MUST NOT 进入 Review。
9. **Copyright（版权）**：`Copyright and related rights waived via CC0-1.0.`

## 7. 进入 Final 的条件

除非以下条件全部满足，TAP MUST NOT 进入 Final：

1. **实现**：(a) 两个可互操作的独立实现；或 (b) 一个带自动化测试的参考实现，**并且**至少一个在 BNB Smart Chain 主网（chainId 56）上产生的测试向量。
2. **§15.1**：TAP 不违反 `SPEC.md` §15.1 列出的任何不变量。编辑 MUST 显式检查并在 PR 中记录。
3. **仅 Core**：适用 CONTRIBUTING 中的审计规则。对合约或参考外壳验证路径的修改，在 Final 前 MUST 经过审计或等效的独立评审。
4. **双语**：中文译文完整且对齐。

## 8. 编辑与决策

- **编辑**为 `TapeOutProtocol/TapeKit` 的维护者或其委托人。编辑检查形式：完整性、格式、编号、§15.1 检查、双语要求。编辑不评判优劣。
- **Core TAP**：优劣由维护者决定。Core TAP 在 Final 之前的任何状态 MAY 因优劣被拒绝。
- **Standards TAP**：没有优劣门槛。Standards TAP 满足 §7 即进入 Final。维护者 MAY 附加不具约束力的采用建议或劝阻说明。
- **Informational TAP**：由编辑酌情合并。

## 9. 与 SPEC.md 的关系

`SPEC.md` 仍是 `tape://` 协议唯一的规范性文档。TAP 永不取代它。

- 被接受的 Core TAP 按 semver 规则作为 `SPEC.md` 的一次修订合并；changelog 条目 MUST 引用 TAP 编号。该 TAP 随后标记为 Final，并指向采纳它的 SPEC 版本。
- Standards TAP 仅对其定义的接口具有规范性，不及其他。Standards TAP 与 `SPEC.md` 冲突时，以 `SPEC.md` 为准，该 TAP 视为有缺陷。
- Standards TAP MUST 复用 `SPEC.md` 的原语（容器推导、SHA-256 文件校验、多节点一致、按源隔离），而非重新定义。

## 10. 版权

Copyright and related rights waived via CC0-1.0. TAP 中的代码示例除另有说明外采用 MIT 许可。
