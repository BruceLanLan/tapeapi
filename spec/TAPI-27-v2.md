| TAPI | 27 (version 2) |
|---|---|
| Title | Tape Group v2: Private Group Channels Between Containers, `tape-group/` labels |
| Author | Bruce (@BruceLanLan) |
| Status | Draft |
| Target | Stable (v2) at TapeAPI 2.0.0, where it becomes the SDK's default; §3.8 of version 1 (format 2) stays Experimental in this version |
| Revision | 2026-10-08: implemented as an option from TapeAPI 1.8.1. §3.4 says how an implementation of both versions knows the version of a group; §4, §5 and §7 follow. |
| Implementation | Implemented as an option (2026-10-08, TapeAPI 1.8.1): `sdk/src/group.js` implements both versions; `labels: 'v2'` selects this one, and [TAPI-27](TAPI-27.md) version 1 stays the default in TapeAPI 1.x. From TapeAPI 2.0.0 this version is the default. Relays and ChannelBus need no change. |
| Type | Standards |
| Created | 2026-10-07 |
| Requires | TAPI-27 (version 1), TAPI-20, TAPI-21, TAPI-26 v2 |
| License | CC0-1.0 |

# TAPI-27 v2: Tape Group v2: Private Group Channels Between Containers, `tape-group/` labels

> English is authoritative. 中文译文见下半部分，章节编号一一对应。

> **Not a TAP.** "TAPI-27" is TapeAPI's own name for this document; it is not a TAP number (see [TAPI-27](TAPI-27.md) version 1). This is version 2 of TAPI-27 under the rule of TAPI-1 §4.1 ("Breaking changes and coexistence"): the TAPs editors asked, in the review of private channels ([PR #12](https://github.com/TapeOutProtocol/TAPs/pull/12)) and of private groups ([PR #20](https://github.com/TapeOutProtocol/TAPs/pull/20)), that no label look like a TAP number, and an incompatible change to a Stable (v1) document is made as v2 and never as an edit of v1. Version 1 is unchanged and stays Stable (v1). "Version 2" of this document is not "format 2": format 2 is the Experimental wire format of version 1 §3.8, and it exists in both versions.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

## 1. Abstract

TAPI-27 v2 is TAPI-27 version 1 with one change: every domain-separation label that begins with `TAP-27/`, in format 1 and in format 2, begins with `tape-group/` instead, and groups run over [TAPI-26 v2](TAPI-26-v2.md). Nothing else changes. A v1 implementation and a v2 implementation do not interoperate.

## 2. Motivation

The labels of version 1 begin with `TAP-27/`, the name this document had before 2026-09-30, and its invites travel in TAPI-26 inbox rooms, whose labels begin with `TAP-26/`. The TAPs editors asked that the drafts submitted from TAPI-26 and this document use labels that do not look like a TAP number. Labels are signature and key-derivation domains, which TAPI-1 §4.1 freezes in a Stable (v1) document, so the rename needs a version 2.

## 3. Specification

### 3.1 Base

Every requirement of [TAPI-27](TAPI-27.md) version 1, §3.1 to §3.8, applies to this version unchanged, except that each label of the table in §3.2 is replaced by its version-2 form, wherever version 1 uses it. Where version 1 refers to TAPI-26, this version refers to [TAPI-26 v2](TAPI-26-v2.md): in particular, the sealed invite of version 1 §3.5 is a TAPI-26 v2 sealed invite, posted to the TAPI-26 v2 inbox room.

### 3.2 Labels

| Version 1 | Version 2 | Used as (version 1 section) |
|---|---|---|
| `TAP-27/room/v1` | `tape-group/room/v1` | group room hash (§3.2) |
| `TAP-27/commit/v1` | `tape-group/commit/v1` | key commitment of an epoch message (§3.3) |
| `TAP-27/wrap/v1` | `tape-group/wrap/v1` | HKDF salt of a member's slot key (§3.3) |
| `TAP-27/epoch/v1` | `tape-group/epoch/v1` | Ed25519 prefix of the owner's signature on an epoch message (§3.3) |
| `TAP-27/sender/v1` | `tape-group/sender/v1` | HKDF info of a sender key (§3.4) |
| `TAP-27/msg/v1` | `tape-group/msg/v1` | Ed25519 prefix of a group message signature (§3.4) |
| `TAP-27/commit/v2` | `tape-group/commit/v2` | as `commit/v1`, format 2 (§3.8, Experimental) |
| `TAP-27/wrap/v2` | `tape-group/wrap/v2` | as `wrap/v1`, format 2 (§3.8, Experimental) |
| `TAP-27/epoch/v2` | `tape-group/epoch/v2` | as `epoch/v1`, format 2 (§3.8, Experimental) |
| `TAP-27/sender/v2` | `tape-group/sender/v2` | as `sender/v1`, format 2 (§3.8, Experimental) |
| `TAP-27/msg/v2` | `tape-group/msg/v2` | as `msg/v1`, format 2 (§3.8, Experimental) |

Each label is the ASCII bytes shown, with no terminator, exactly as in version 1. Format 2 uses the room of format 1.

### 3.3 What does not change

The wire types `0x04` and `0x05` and their layouts, the format-2 mark in the epoch field, the roster object of format 1 and the binary roster of format 2 (including its magic `TGR2`), the invite object (`tape.group/invite`), the limits of 32 and 128 members, the state, restart and membership rules and the error codes are those of version 1. Members' channel records are TAPI-26 records, which carry no label and are the same in both versions.

### 3.4 Versions side by side

An implementation MAY implement both versions (TAPI-1 §4.1). It MUST then keep them apart: a group is of one version for its whole life, and an implementation MUST NOT accept an epoch message or open a group message under the labels of the other version. The group invite does not name its version: it is the version of the inbox room it was read from, so such an implementation MUST read each inbox room under that room's version and join the group under the same version. It MUST NOT move a group to the other version after a failure. It MAY check an epoch message it refuses against the labels of the other version, only to report a version mismatch; the message is refused either way.

## 4. Rationale

- **Only the prefix changes**, as in TAPI-26 v2 §4: each version-2 label maps one to one onto a version-1 label, and the `/v1` and `/v2` suffixes keep naming formats 1 and 2, not versions of this document.
- **The labels are the version marker** (TAPI-1 §4.1): the group room, every commitment, slot key, sender key and signature differ between the versions, so no epoch message or group message of one version verifies under the other. The invite object's `v` member stays 1, as in TAPI-26 v2 §4; a version-1 invite cannot even reach a version-2 member, because it is sealed for the version-1 inbox room. An owner's saved state belongs to one version too: the reference implementation writes the snapshot of a version-2 group with its own snapshot version, which implementations of version 1 only refuse, so that a restart cannot continue the group under the other labels.

## 5. Backwards Compatibility

Version 1 and version 2 do not interoperate: a member on version 1 (TapeAPI 1.0.0 to 1.8.0, and later 1.x by default) and a member on version 2 (TapeAPI 1.8.1 and later with `labels: 'v2'`, and 2.0 by default) cannot be in the same group, and an owner on one version cannot invite a member on the other. A group created under version 1 cannot be continued under version 2; its owner creates a new group. Relays and ChannelBus need no change. Version 1 is not changed by this document and stays Stable (v1). Under TAPI-1 §4.1 it cannot be moved to Withdrawn earlier than 12 months after this version becomes Stable, and the planned date has to be written into version 1 at least 3 months in advance; no such date is planned.

## 6. Test Vectors

`spec/vectors/tapi-27-v2-group.json` (format 1) and `spec/vectors/tapi-27-v2-group-format2.json` (format 2, Experimental) give the values of version 1's `tapi-27-group.json` and `tapi-27-group-v2.json` (same secrets, same random draws) under the labels of §3.2. `scripts/gen-vectors.mjs` writes the files of both versions from the SDK. `spec/vectors/verify.py` checks both versions, each against its own files; the version-1 files are kept byte for byte.

## 7. Reference Implementation

`sdk/src/group.js` and `sdk/src/group-delivery.js` of TapeAPI 1.8.1 and later, with `labels: 'v2'` passed to `createGroup`, `joinGroup`, `openGroupInvite`, `groupRoom` and `checkGroupInvites` (a group handle keeps its version, and `resumeGroup` takes it from the snapshot; the default is `'v1'` in 1.x and `'v2'` from 2.0). Tests: those of version 1 §7, and `sdk/test/channel-labels.test.mjs` (the SDK reproduces the vectors of version 1 by default and those of this version, both formats, with `labels: 'v2'`; an epoch message or invite across the versions fails with a version-mismatch error; a version-2 group delivers to and reads the version-2 inbox rooms).

## 8. Security Considerations

Those of version 1 apply. Every label of one version differs from every label of the other from its first byte (`T` against `t`), so no signed message, hash input or key-derivation input of one version equals one of the other: an owner's or member's Ed25519 signature made under one version never verifies under the other.

## 9. Copyright

Copyright and related rights waived via [CC0](https://creativecommons.org/publicdomain/zero/1.0/).

---

# TAPI-27 v2：Tape Group v2：容器之间的私密群聊，`tape-group/` 标签（中文译文）

> 以英文版为准。章节编号一一对应。

> **不是 TAP。** “TAPI-27”是 TapeAPI 给本文档起的名字，不是 TAP 编号（见 [TAPI-27](TAPI-27.md) 第 1 版）。本文是 TAPI-27 按 TAPI-1 §4.1（"破坏性变更与并存"）出的第 2 版：TAPs 编辑在私密通道（[PR #12](https://github.com/TapeOutProtocol/TAPs/pull/12)）与私密群聊（[PR #20](https://github.com/TapeOutProtocol/TAPs/pull/20)）的评审中要求标签不要看起来像 TAP 编号，而对 Stable (v1) 文档的不兼容修改只能作为 v2 发布，绝不能改 v1。第 1 版不变，仍是 Stable (v1)。本文档的"第 2 版"不是"格式 2"：格式 2 是第 1 版 §3.8 的实验性线路格式，两个版本里都有。

> **状态：** Draft（草稿），目标：TapeAPI 2.0.0 时进入 Stable (v2)，届时成为 SDK 的默认版本；第 1 版 §3.8（格式 2）在本版本中仍是 Experimental（实验性）。

> **修订：** 2026-10-08：自 TapeAPI 1.8.1 起作为选项实现。§3.4 说明同时实现两个版本的实现如何得知一个群的版本；§4、§5、§7 随之更新。

> **实现状态（2026-10-08，TapeAPI 1.8.1）：** 作为选项实现：`sdk/src/group.js` 实现两个版本；`labels: 'v2'` 选用本版本，TapeAPI 1.x 中 [TAPI-27](TAPI-27.md) 第 1 版仍是默认。自 TapeAPI 2.0.0 起本版本成为默认。中继与 ChannelBus 不需要改动。

本文档中的关键词 "MUST"（必须）、"MUST NOT"（禁止）、"REQUIRED"（必需）、"SHALL"、"SHOULD"（应当）、"SHOULD NOT"（不应）、"RECOMMENDED"（推荐）、"MAY"（可以）、"OPTIONAL"（可选）按 RFC 2119 解释。

## 1. 摘要

TAPI-27 v2 就是 TAPI-27 第 1 版，只改一处：格式 1 与格式 2 中每个以 `TAP-27/` 开头的域分隔标签改为以 `tape-group/` 开头，群聊运行在 [TAPI-26 v2](TAPI-26-v2.md) 之上。别的都不变。第 1 版实现与第 2 版实现不互通。

## 2. 动机

第 1 版的标签以 `TAP-27/` 开头，这是本文档 2026-09-30 之前的名字；其邀请经 TAPI-26 的收件房间传送，而那些标签以 `TAP-26/` 开头。TAPs 编辑要求由 TAPI-26 与本文档提交的草稿使用不像 TAP 编号的标签。标签是签名与密钥派生的域，TAPI-1 §4.1 在 Stable (v1) 文档里冻结它们，所以改名需要第 2 版。

## 3. 规范

### 3.1 基础

[TAPI-27](TAPI-27.md) 第 1 版 §3.1 至 §3.8 的每一条要求都原样适用于本版本，只是 §3.2 表中的每个标签，在第 1 版用到它的每一处，都换成其第 2 版形式。第 1 版引用 TAPI-26 之处，本版本引用 [TAPI-26 v2](TAPI-26-v2.md)：特别是第 1 版 §3.5 的密封邀请是 TAPI-26 v2 的密封邀请，投进 TAPI-26 v2 的收件房间。

### 3.2 标签

| 第 1 版 | 第 2 版 | 用途（第 1 版章节） |
|---|---|---|
| `TAP-27/room/v1` | `tape-group/room/v1` | 群房间哈希（§3.2） |
| `TAP-27/commit/v1` | `tape-group/commit/v1` | 纪元消息的密钥承诺（§3.3） |
| `TAP-27/wrap/v1` | `tape-group/wrap/v1` | 成员包裹密钥的 HKDF salt（§3.3） |
| `TAP-27/epoch/v1` | `tape-group/epoch/v1` | 群主对纪元消息签名的 Ed25519 前缀（§3.3） |
| `TAP-27/sender/v1` | `tape-group/sender/v1` | 发送者密钥的 HKDF info（§3.4） |
| `TAP-27/msg/v1` | `tape-group/msg/v1` | 群消息签名的 Ed25519 前缀（§3.4） |
| `TAP-27/commit/v2` | `tape-group/commit/v2` | 同 `commit/v1`，格式 2（§3.8，实验性） |
| `TAP-27/wrap/v2` | `tape-group/wrap/v2` | 同 `wrap/v1`，格式 2（§3.8，实验性） |
| `TAP-27/epoch/v2` | `tape-group/epoch/v2` | 同 `epoch/v1`，格式 2（§3.8，实验性） |
| `TAP-27/sender/v2` | `tape-group/sender/v2` | 同 `sender/v1`，格式 2（§3.8，实验性） |
| `TAP-27/msg/v2` | `tape-group/msg/v2` | 同 `msg/v1`，格式 2（§3.8，实验性） |

每个标签就是表中所示的 ASCII 字节，不带结束符，与第 1 版相同。格式 2 使用格式 1 的房间。

### 3.3 不变的部分

线路类型 `0x04`、`0x05` 及其布局，纪元字段里的格式 2 标记，格式 1 的名单对象与格式 2 的二进制名单（包括魔数 `TGR2`），邀请对象（`tape.group/invite`），32 人与 128 人的上限，状态、重启与成员变动规则，以及错误码，都与第 1 版相同。成员的通道记录是 TAPI-26 记录，不含标签，在两个版本中相同。

### 3.4 两个版本并存

实现 MAY 同时实现两个版本（TAPI-1 §4.1）。此时它 MUST 把两者分开：一个群在整个生命期内都属于同一个版本，实现 MUST NOT 用另一个版本的标签去接受纪元消息或打开群消息。入群邀请不写明自己的版本：它就是读到它的收件房间的版本，所以这样的实现 MUST 按每个收件房间自己的版本去读它，并以同一版本入群。它 MUST NOT 在失败之后把群改到另一个版本。它 MAY 用另一个版本的标签检查一条被它拒绝的纪元消息，但只为报告版本不一致；该消息无论如何都被拒绝。

## 4. 原理

- **只改前缀**，与 TAPI-26 v2 §4 相同：第 2 版的每个标签一一对应第 1 版的一个标签；`/v1`、`/v2` 后缀仍然指格式 1 与格式 2，不是本文档的版本。
- **标签就是版本标记**（TAPI-1 §4.1）：群房间、每个承诺、包裹密钥、发送者密钥与签名在两个版本之间都不同，所以一个版本的纪元消息或群消息在另一个版本下都核验不过。邀请对象的 `v` 成员仍为 1，与 TAPI-26 v2 §4 相同；第 1 版的邀请根本到不了第 2 版成员手里，因为它是为第 1 版的收件房间密封的。群主保存的状态也只属于一个版本：参考实现给第 2 版群的快照用自己的快照版本号，第 1 版的实现只会拒收它，这样重启之后群不可能在另一套标签下继续。

## 5. 向后兼容

第 1 版与第 2 版不互通：使用第 1 版的成员（TapeAPI 1.0.0 至 1.8.0，以及之后 1.x 的默认）与使用第 2 版的成员（TapeAPI 1.8.1 及以后传 `labels: 'v2'`，以及 2.0 的默认）不能在同一个群里，一个版本的群主也邀请不了另一个版本的成员。按第 1 版建立的群不能在第 2 版下延续，群主要新建一个群。中继与 ChannelBus 不需要改动。本文档不改变第 1 版，第 1 版仍是 Stable (v1)。按 TAPI-1 §4.1，第 1 版最早在本版本进入 Stable 满 12 个月后才能改为 Withdrawn，且计划日期至少提前 3 个月写进第 1 版；目前没有这样的计划。

## 6. 测试向量

`spec/vectors/tapi-27-v2-group.json`（格式 1）与 `spec/vectors/tapi-27-v2-group-format2.json`（格式 2，实验性）给出第 1 版 `tapi-27-group.json`、`tapi-27-group-v2.json` 的各个值（同样的秘密值、同样的随机抽取）在 §3.2 标签下的结果。两个版本的文件都由 `scripts/gen-vectors.mjs` 从 SDK 生成。`spec/vectors/verify.py` 两个版本都核对，各对各的文件；第 1 版的文件逐字节保持原样。

## 7. 参考实现

TapeAPI 1.8.1 及以后的 `sdk/src/group.js` 与 `sdk/src/group-delivery.js`，给 `createGroup`、`joinGroup`、`openGroupInvite`、`groupRoom`、`checkGroupInvites` 传 `labels: 'v2'`（群句柄保持其版本，`resumeGroup` 从快照取得版本；默认值在 1.x 中为 `'v1'`，自 2.0 起为 `'v2'`）。测试：第 1 版 §7 所列测试，加上 `sdk/test/channel-labels.test.mjs`（SDK 默认重现第 1 版向量，传 `labels: 'v2'` 时重现本版本两种格式的向量；跨版本的纪元消息或邀请以版本不一致的错误失败；第 2 版的群投递到并读取第 2 版的收件房间）。

## 8. 安全考量

第 1 版的安全考量都适用。一个版本的每个标签与另一个版本的每个标签从第一个字节起就不同（`T` 与 `t`），所以一个版本的签名消息、哈希输入或密钥派生输入都不会等于另一个版本的：群主或成员在一个版本下做的 Ed25519 签名，在另一个版本下永远核验不过。

## 9. 版权

依 [CC0](https://creativecommons.org/publicdomain/zero/1.0/) 放弃版权及相关权利。
