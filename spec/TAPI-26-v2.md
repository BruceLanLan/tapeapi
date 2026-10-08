| TAPI | 26 (version 2) |
|---|---|
| Title | Tape Channel v2: Real-Time Private Channels Between Containers, `tape-channel/` labels |
| Author | Bruce (@BruceLanLan) |
| Status | Draft |
| Target | Stable (v2) at TapeAPI 2.0.0, where it becomes the SDK's default |
| Revision | 2026-10-08: implemented as an option from TapeAPI 1.8.1. §3.4 says how an implementation of both versions knows the version of a channel; §4, §5 and §7 follow. |
| Implementation | Implemented as an option (2026-10-08, TapeAPI 1.8.1): `sdk/src/channel.js` implements both versions; `labels: 'v2'` selects this one, and [TAPI-26](TAPI-26.md) version 1 stays the default in TapeAPI 1.x. From TapeAPI 2.0.0 this version is the default. Relays, ChannelBus and channel records need no change. |
| Type | Standards |
| Created | 2026-10-07 |
| Requires | TAPI-26 (version 1), TAP-10 (TapeSend), TAPI-20, TAPI-21 |
| License | CC0-1.0 |

# TAPI-26 v2: Tape Channel v2: Real-Time Private Channels Between Containers, `tape-channel/` labels

> English is authoritative. 中文译文见下半部分，章节编号一一对应。

> **Not a TAP.** "TAPI-26" is TapeAPI's own name for this document; it is not a TAP number (see [TAPI-26](TAPI-26.md) version 1). This is version 2 of TAPI-26 under the rule of TAPI-1 §4.1 ("Breaking changes and coexistence"): the TAPs editors asked, in the review of private channels ([PR #12](https://github.com/TapeOutProtocol/TAPs/pull/12)), that no label look like a TAP number, and an incompatible change to a Stable (v1) document is made as v2 and never as an edit of v1. Version 1 is unchanged and stays Stable (v1).

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

## 1. Abstract

TAPI-26 v2 is TAPI-26 version 1 with one change: every domain-separation label that begins with `TAP-26/` begins with `tape-channel/` instead. Nothing else changes. Because every room, key, tag and sealed invite depends on a label, a v1 implementation and a v2 implementation do not interoperate.

## 2. Motivation

The labels of version 1 begin with `TAP-26/`, the name this document had before 2026-09-30. TAP numbers are assigned by the editors of [TapeOutProtocol/TAPs](https://github.com/TapeOutProtocol/TAPs), and the editors asked that the draft submitted from this document use labels that do not look like a TAP number. Labels are signature and key-derivation domains, which TAPI-1 §4.1 freezes in a Stable (v1) document, so the rename needs a version 2.

## 3. Specification

### 3.1 Base

Every requirement of [TAPI-26](TAPI-26.md) version 1, §3.1 to §3.7, applies to this version unchanged, except that each label of the table in §3.2 is replaced by its version-2 form, wherever version 1 uses it. Where version 1 refers to TAPI-27, this version refers to [TAPI-27 v2](TAPI-27-v2.md).

### 3.2 Labels

| Version 1 | Version 2 | Used as (version 1 section) |
|---|---|---|
| `TAP-26/inbox/v1` | `tape-channel/inbox/v1` | inbox room hash, HKDF salt and AEAD associated data of a sealed invite (§3.2) |
| `TAP-26/transcript/v1` | `tape-channel/transcript/v1` | transcript hash prefix (§3.3) |
| `TAP-26/keys/v1` | `tape-channel/keys/v1` | HKDF info of the key schedule (§3.3) |
| `TAP-26/confirm/initiator` | `tape-channel/confirm/initiator` | HMAC input prefix of the initiator's confirmation (§3.3) |
| `TAP-26/confirm/responder` | `tape-channel/confirm/responder` | HMAC input prefix of the responder's confirmation (§3.3) |
| `TAP-26/frame/v1` | `tape-channel/frame/v1` | AEAD associated data of a frame (§3.4) |
| `TAP-26/room/v1` | `tape-channel/room/v1` | channel room hash, on relays and on ChannelBus (§3.5, §3.7) |

Each label is the ASCII bytes shown, with no terminator, exactly as in version 1.

### 3.3 What does not change

The wire types `0x01`, `0x02` and `0x03`, the invite, `accept` and `ready` objects (including `v` 1 and the `kind` values `tape.channel/invite`), the key kinds `tape-channel/v1` and `tapesend/v1`, the channel record and its path `.well-known/tape-channel.json`, the `ChannelKeys` EIP-712 typed data (domain, type string and version), the relay methods and their limits, ChannelBus, the size limits and the error codes are those of version 1. `ChannelKeys` carries no label, so a record published under version 1 authorises the same keys under this version.

### 3.4 Versions side by side

An implementation MAY implement both versions (TAPI-1 §4.1). It MUST then keep them apart: a channel is of one version from its invite to its last frame, and an implementation MUST NOT accept, confirm or use a message of a channel under the labels of the other version. No invite, `accept` or `ready` names its version (§4), so such an implementation MUST know the version of a channel before it opens or answers one: from its configuration, or, for a sealed invite, from the inbox room it read the invite from. It MUST NOT move a channel to the other version after a failure. It MAY check a message it refuses against the labels of the other version, only to report a version mismatch; the message is refused either way, and nothing recovered from it is used.

## 4. Rationale

- **Only the prefix changes.** The suffixes (`/v1`, `/confirm/initiator`, …) are kept, so each version-2 label maps one to one onto a version-1 label, and the version-1 analysis of every derivation carries over unchanged. The `/v1` suffixes version a single derivation, not this document.
- **The labels are the version marker.** TAPI-1 §4.1 asks that v2 carry its own marker wherever v1 carries one on the wire, so that a message of one version is never taken for one of the other. Every value of version 1 that a label enters (rooms, transcript, keys, confirmation tags, frames, sealed invites) is different under this version. The invite's own `v` member is the format version of a JSON object that TAPI-27 shares, not a version of this document; it stays 1, as in the draft submitted to the TAPs editors. An invite read under the wrong version cannot complete a handshake: the transcript, and so every key and tag, differs.
- **Invites delivered by TapeSend.** An invite sent by TapeSend (version 1 §3.2) does not say which version it belongs to, whereas a sealed invite does by the inbox room it is posted to. An implementation of both versions therefore takes the version of a TapeSend invite from its configuration (§3.4): the two parties agree on it beforehand. Adding a member to the invite was not chosen: the invite object is the one of the draft submitted to the TAPs editors, and its hash enters the transcript, so a new member would change every value of the handshake. With the wrong version nothing is accepted: the responder answers in rooms the initiator does not read, and an `accept` that reaches the initiator anyway fails its confirmation.

## 5. Backwards Compatibility

Version 1 and version 2 do not interoperate: a party on version 1 (TapeAPI 1.0.0 to 1.8.0, and later 1.x by default) and a party on version 2 (TapeAPI 1.8.1 and later with `labels: 'v2'`, and 2.0 by default) cannot open a channel with each other, and neither reads the other's sealed invites. Relays and ChannelBus carry bytes and need no change; channel records stay valid. Version 1 is not changed by this document and stays Stable (v1). Under TAPI-1 §4.1 it cannot be moved to Withdrawn earlier than 12 months after this version becomes Stable, and the planned date has to be written into version 1 at least 3 months in advance; no such date is planned.

## 6. Test Vectors

`spec/vectors/tapi-26-v2-channel.json` and `spec/vectors/tapi-26-v2-identity.json` give the values of version 1's `tapi-26-channel.json` and `tapi-26-identity.json` (same secrets, same random draws) under the labels of §3.2. The `ChannelKeys` digest and signature are the same in both versions. `scripts/gen-vectors.mjs` writes the files of both versions from the SDK. `spec/vectors/verify.py` checks both versions, each against its own files; the version-1 files are kept byte for byte.

## 7. Reference Implementation

`sdk/src/channel.js` of TapeAPI 1.8.1 and later, with `labels: 'v2'` passed to `createInvite`, `acceptInvite`, `roomsFor`, `inboxRoom`, `sealInvite`, `sealToInbox`, `openInvite` and `openFromInbox` (the default is `'v1'` in 1.x and `'v2'` from 2.0). Tests: those of version 1 §7, and `sdk/test/channel-labels.test.mjs` (the SDK reproduces the vectors of version 1 by default and those of this version with `labels: 'v2'`; the version-1 vector files are unchanged; a handshake or sealed invite across the versions fails with a version-mismatch error).

## 8. Security Considerations

Those of version 1 apply. A party may hold one channel identity under both versions, since the static keys and the record are the same. No value can be shared between the versions: every label of one differs from every label of the other from its first byte (`T` against `t`), so no hash input, key-derivation input, MAC input or associated data of one version equals one of the other.

## 9. Copyright

Copyright and related rights waived via [CC0](https://creativecommons.org/publicdomain/zero/1.0/).

---

# TAPI-26 v2：Tape Channel v2：容器之间的实时私密通道，`tape-channel/` 标签（中文译文）

> 以英文为准。章节编号与上半部分一一对应。

> **不是 TAP。** “TAPI-26”是 TapeAPI 给本文档起的名字，不是 TAP 编号（见 [TAPI-26](TAPI-26.md) 第 1 版）。本文是 TAPI-26 按 TAPI-1 §4.1（"破坏性变更与并存"）出的第 2 版：TAPs 编辑在私密通道的评审中（[PR #12](https://github.com/TapeOutProtocol/TAPs/pull/12)）要求标签不要看起来像 TAP 编号，而对 Stable (v1) 文档的不兼容修改只能作为 v2 发布，绝不能改 v1。第 1 版不变，仍是 Stable (v1)。

> **状态：** Draft（草稿），目标：TapeAPI 2.0.0 时进入 Stable (v2)，届时成为 SDK 的默认版本。

> **修订：** 2026-10-08：自 TapeAPI 1.8.1 起作为选项实现。§3.4 说明同时实现两个版本的实现如何得知一条通道的版本；§4、§5、§7 随之更新。

> **实现状态（2026-10-08，TapeAPI 1.8.1）：** 作为选项实现：`sdk/src/channel.js` 实现两个版本；`labels: 'v2'` 选用本版本，TapeAPI 1.x 中 [TAPI-26](TAPI-26.md) 第 1 版仍是默认。自 TapeAPI 2.0.0 起本版本成为默认。中继、ChannelBus 与通道记录都不需要改动。

本文档中的关键词 "MUST"（必须）、"MUST NOT"（禁止）、"REQUIRED"（必需）、"SHALL"、"SHOULD"（应当）、"SHOULD NOT"（不应）、"RECOMMENDED"（推荐）、"MAY"（可以）、"OPTIONAL"（可选）按 RFC 2119 解释。

## 1. 摘要

TAPI-26 v2 就是 TAPI-26 第 1 版，只改一处：每个以 `TAP-26/` 开头的域分隔标签改为以 `tape-channel/` 开头。别的都不变。由于每个房间、密钥、标签值与密封邀请都依赖标签，第 1 版实现与第 2 版实现不互通。

## 2. 动机

第 1 版的标签以 `TAP-26/` 开头，这是本文档 2026-09-30 之前的名字。TAP 编号由 [TapeOutProtocol/TAPs](https://github.com/TapeOutProtocol/TAPs) 的编辑分配，编辑要求由本文档提交的草稿使用不像 TAP 编号的标签。标签是签名与密钥派生的域，TAPI-1 §4.1 在 Stable (v1) 文档里冻结它们，所以改名需要第 2 版。

## 3. 规范

### 3.1 基础

[TAPI-26](TAPI-26.md) 第 1 版 §3.1 至 §3.7 的每一条要求都原样适用于本版本，只是 §3.2 表中的每个标签，在第 1 版用到它的每一处，都换成其第 2 版形式。第 1 版引用 TAPI-27 之处，本版本引用 [TAPI-27 v2](TAPI-27-v2.md)。

### 3.2 标签

| 第 1 版 | 第 2 版 | 用途（第 1 版章节） |
|---|---|---|
| `TAP-26/inbox/v1` | `tape-channel/inbox/v1` | 收件房间哈希、密封邀请的 HKDF salt 与 AEAD 附加数据（§3.2） |
| `TAP-26/transcript/v1` | `tape-channel/transcript/v1` | 握手记录哈希的前缀（§3.3） |
| `TAP-26/keys/v1` | `tape-channel/keys/v1` | 密钥调度的 HKDF info（§3.3） |
| `TAP-26/confirm/initiator` | `tape-channel/confirm/initiator` | 发起方确认标签的 HMAC 输入前缀（§3.3） |
| `TAP-26/confirm/responder` | `tape-channel/confirm/responder` | 响应方确认标签的 HMAC 输入前缀（§3.3） |
| `TAP-26/frame/v1` | `tape-channel/frame/v1` | 帧的 AEAD 附加数据（§3.4） |
| `TAP-26/room/v1` | `tape-channel/room/v1` | 通道房间哈希，中继与 ChannelBus 上都用（§3.5、§3.7） |

每个标签就是表中所示的 ASCII 字节，不带结束符，与第 1 版相同。

### 3.3 不变的部分

线路类型 `0x01`、`0x02`、`0x03`，邀请、`accept` 与 `ready` 对象（包括 `v` 为 1 与 `kind` 值 `tape.channel/invite`），密钥类别 `tape-channel/v1` 与 `tapesend/v1`，通道记录及其路径 `.well-known/tape-channel.json`，`ChannelKeys` 的 EIP-712 类型数据（域、类型字符串与版本），中继方法及其限制，ChannelBus，大小限制与错误码，都与第 1 版相同。`ChannelKeys` 不含标签，所以按第 1 版发布的记录在本版本下授权同样的密钥。

### 3.4 两个版本并存

实现 MAY 同时实现两个版本（TAPI-1 §4.1）。此时它 MUST 把两者分开：一条通道从邀请到最后一帧都属于同一个版本，实现 MUST NOT 用另一个版本的标签去接受、确认或使用某条通道的消息。邀请、`accept`、`ready` 都不写明自己的版本（§4），所以这样的实现在打开或应答一条通道之前 MUST 已经知道它的版本：来自其配置；对密封邀请，来自读到该邀请的收件房间。它 MUST NOT 在失败之后把通道改到另一个版本。它 MAY 用另一个版本的标签检查一条被它拒绝的消息，但只为报告版本不一致；该消息无论如何都被拒绝，从中得到的任何东西都不被使用。

## 4. 原理

- **只改前缀。** 后缀（`/v1`、`/confirm/initiator` 等）保留，所以第 2 版的每个标签一一对应第 1 版的一个标签，第 1 版对每一步派生的分析原样成立。`/v1` 后缀给的是单个派生步骤的版本，不是本文档的版本。
- **标签就是版本标记。** TAPI-1 §4.1 要求 v1 在线路上带版本标记的每一处，v2 都带自己的标记，使一个版本的消息永远不会被当成另一个版本的消息。第 1 版里标签参与的每个值（房间、握手记录、密钥、确认标签、帧、密封邀请）在本版本下都不同。邀请自身的 `v` 成员是一个 JSON 对象的格式版本（TAPI-27 也用这个对象），不是本文档的版本；它仍为 1，与提交给 TAPs 编辑的草稿一致。按错误版本读的邀请不可能完成握手：握手记录不同，因而每个密钥与标签都不同。
- **经 TapeSend 送达的邀请。** 经 TapeSend 发送的邀请（第 1 版 §3.2）不说明自己属于哪个版本，而密封邀请可以由所投递的收件房间看出版本。因此同时实现两个版本的实现从其配置中取得 TapeSend 邀请的版本（§3.4）：双方事先约定。没有选择给邀请加一个成员：邀请对象就是提交给 TAPs 编辑的草稿中的那个，其哈希进入握手记录，新增成员会改变握手的每一个值。版本不对时什么都不会被接受：响应方在发起方不读的房间里应答，即使 `accept` 到了发起方手里，其确认也核对不过。

## 5. 向后兼容

第 1 版与第 2 版不互通：使用第 1 版的一方（TapeAPI 1.0.0 至 1.8.0，以及之后 1.x 的默认）与使用第 2 版的一方（TapeAPI 1.8.1 及以后传 `labels: 'v2'`，以及 2.0 的默认）之间不能建立通道，也读不了对方的密封邀请。中继与 ChannelBus 只搬运字节，不需要改动；通道记录仍然有效。本文档不改变第 1 版，第 1 版仍是 Stable (v1)。按 TAPI-1 §4.1，第 1 版最早在本版本进入 Stable 满 12 个月后才能改为 Withdrawn，且计划日期至少提前 3 个月写进第 1 版；目前没有这样的计划。

## 6. 测试向量

`spec/vectors/tapi-26-v2-channel.json` 与 `spec/vectors/tapi-26-v2-identity.json` 给出第 1 版 `tapi-26-channel.json`、`tapi-26-identity.json` 的各个值（同样的秘密值、同样的随机抽取）在 §3.2 标签下的结果。`ChannelKeys` 的摘要与签名在两个版本中相同。两个版本的文件都由 `scripts/gen-vectors.mjs` 从 SDK 生成。`spec/vectors/verify.py` 两个版本都核对，各对各的文件；第 1 版的文件逐字节保持原样。

## 7. 参考实现

TapeAPI 1.8.1 及以后的 `sdk/src/channel.js`，给 `createInvite`、`acceptInvite`、`roomsFor`、`inboxRoom`、`sealInvite`、`sealToInbox`、`openInvite`、`openFromInbox` 传 `labels: 'v2'`（默认值在 1.x 中为 `'v1'`，自 2.0 起为 `'v2'`）。测试：第 1 版 §7 所列测试，加上 `sdk/test/channel-labels.test.mjs`（SDK 默认重现第 1 版向量，传 `labels: 'v2'` 时重现本版本向量；第 1 版向量文件未变；跨版本的握手或密封邀请以版本不一致的错误失败）。

## 8. 安全考量

第 1 版的安全考量都适用。同一方可以在两个版本下使用同一个通道身份，因为长期密钥与记录相同。两个版本之间不会共用任何值：一个版本的每个标签与另一个版本的每个标签从第一个字节起就不同（`T` 与 `t`），所以一个版本的哈希输入、密钥派生输入、MAC 输入或附加数据都不会等于另一个版本的。

## 9. 版权

依 [CC0](https://creativecommons.org/publicdomain/zero/1.0/) 放弃版权及相关权利。
