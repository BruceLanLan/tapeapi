| TAP | 27 |
|---|---|
| Title | Tape Group: Private Group Channels Between Containers |
| Author | Bruce (@BruceLanLan) |
| Status | Draft |
| Target | Stable (v1) at TapeAPI 1.0 |
| Implementation | Implemented (2026-09-27): `sdk/src/group.js` runs groups over any TAP-26 transport, including the deployed ChannelBus (`0x486110c35d9b90a9d6D85c8063A065f9e7b6b707`) and the public relay `relay.tapeapi.fun`. There is no group service to host: the owner is a client. No third-party audit. |
| Type | Standards |
| Created | 2026-09-23 |
| Requires | TAP-20, TAP-21, TAP-26 |
| License | CC0-1.0 |

# TAP-27: Tape Group: Private Group Channels Between Containers

> English is authoritative. 中文译文见下半部分，章节编号一一对应。

> **Placeholder number.** TAP-27 is a placeholder number proposed in [TapeKit issue #8](https://github.com/TapeOutProtocol/TapeKit/issues/8). TapeKit has no numbered-proposal process yet (changes to TapeOut itself follow TapeKit `SPEC.md` §15), so the maintainers may assign another number or move this document to another process; see [TAP-1](TAP-1.md).

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

## 1. Abstract

A Tape Group is an encrypted conversation among up to 32 TapeOut containers. One container, the **owner**, keeps the member list; every change of membership starts a new **epoch** with a fresh group key, delivered to each member sealed to its channel key (TAP-26 §3.1). Messages are encrypted under a per-sender key derived from the epoch key and signed with the sender's Ed25519 channel key, so members can read each other and cannot impersonate each other. The member list itself travels encrypted, and the slots that carry the group key name nobody: a relay or a chain observer, even one who reads every channel record on chain, learns the group id, the number of members and the sizes and times of messages, not who the members are. Transport is TAP-26's: any relay (TAP-26 §3.5) or ChannelBus (TAP-26 §3.7).

## 2. Motivation

TAP-26 is a two-party channel, and its triple Diffie-Hellman handshake does not extend to N parties. Applications that gather several containers in one conversation otherwise either open N² pairwise channels or broadcast in the clear. This TAP adds the smallest group construction that keeps TAP-26's properties where they can be kept (end-to-end confidentiality, sender authentication, no trusted server, hidden membership) and states plainly where it cannot (§8). It defines a conversation and nothing else: no roles beyond the owner, no application state.

## 3. Specification

### 3.1 Identities

Every member, the owner included, has a TAP-26 channel identity (TAP-26 §3.1): an X25519 key `x25519` and an Ed25519 key `ed25519`, authorised by the circuit's current holder and published in the container's site. A client MUST verify every member's keys against that record before trusting a roster (§3.3); a roster is the owner's statement about who is in the group, not proof of anyone's keys.

### 3.2 Group id and room

The owner draws a random 16-byte group id `gid`. All group traffic goes to one room, `SHA-256("TAP-27/room/v1" ‖ gid)`, on the relays or ChannelBus the roster names. Every member posts there and reads from there; each sender pays for its own posts on a priced relay.

### 3.3 Epoch message (wire type `0x04`)

The owner starts epoch `n` (0 for the first) by drawing a 32-byte epoch key `K`, a fresh X25519 key `(e, E)` and a 24-byte nonce `N`, and posting:

```
header = 0x04 ‖ gid(16) ‖ uint64be(n) ‖ E(32) ‖ N(24) ‖ commit(32) ‖ count(1)
commit = SHA-256("TAP-27/commit/v1" ‖ K)
kek_i  = HKDF-SHA256(X25519(e, R_i), salt = "TAP-27/wrap/v1", info = E ‖ R_i ‖ gid ‖ uint64be(n), L = 32)
slot_i = XChaCha20-Poly1305(kek_i, N, aad = header).encrypt(K)                                   -- 48 bytes, no fingerprint
roster = XChaCha20-Poly1305(K, N, aad = header ‖ slots).encrypt(UTF-8(canonicalJSON(rosterObject)))
sig    = Ed25519(owner, "TAP-27/epoch/v1" ‖ header ‖ slots ‖ uint32be(|roster|) ‖ roster)
wire   = header ‖ slots ‖ uint32be(|roster|) ‖ roster ‖ sig(64)
```

`R_i` is member `i`'s X25519 key, and slots appear in member order. `count` is 1 to 32. `n` is at most 2^32 − 1. The whole message MUST fit one TAP-26 wire message (16,448 bytes). The roster object is:

```json
{ "v": 1, "kind": "tape.group/roster", "gid": "<32 hex>", "epoch": n, "issued": <unix seconds>, "prev": "<64 hex>",
  "owner": { "container": "0x…", "chainId": 56 },
  "members": [ { "container": "0x…", "chainId": 56, "x25519": "0x…", "ed25519": "0x…" } ],
  "relays": [ { "url": "https://…/tapeapi/v1", "container": "0x…" } ], "bus": "0x…" }
```

`members[0]` MUST be the owner. Each member is exactly `{ container, chainId, x25519, ed25519 }`, with `container` in lowercase and both keys as lowercase `0x` hex; a receiver MUST refuse any other form, so that every receiver hashes the same bytes. `issued` is the time the owner built the message, in unix seconds. `prev` is `SHA-256` of the roster plaintext bytes of epoch `n − 1` as sent (the bytes a member decrypted, never a re-encoding), as 64 lowercase hex characters without `0x`, or 64 zeros for epoch 0. `relays` and `bus` follow TAP-26 §3.2 step 1.

A member processes epoch messages one at a time, and the epoch it holds never moves backwards. It accepts an epoch message only if all of the following hold, in this order:

1. **Owner.** The header's `gid` is the group's, and the owner's Ed25519 signature verifies strictly (RFC 8032: small-order public keys are refused, no ZIP-215 leniency). The owner is fixed for the life of the group; its key comes from its own channel record, looked up by the owner the invite names (§3.5).
2. **Duplicates and equivocation.** If the member already accepted a message for epoch `n`, the same message is a duplicate and is ignored without error. A different owner-signed message for the same `n` is proof that the owner equivocated: the member MUST refuse it and MUST report it (reference: `GROUP_EQUIVOCATION`, with the SHA-256 of both messages minus their signatures). The reference remembers, in memory, the messages of epochs up to 64 below the newest it accepted; an `n` it no longer remembers fails step 3.
3. **Newer.** `n` is greater than the epoch the member holds, and not below the minimum epoch the member persisted (§3.7).
4. **Key.** The member derives its `kek` once (one X25519 with `E`) and tries every slot. Exactly one slot MUST open, and `SHA-256("TAP-27/commit/v1" ‖ K)` MUST equal `commit`. The commitment, covered by the owner's signature, is what stops an owner from giving different members different keys.
5. **Roster.** The roster decrypts and parses as strict JSON (TAP-21 §3.3) with `v` 1 and `kind` `"tape.group/roster"`; its `gid` and `epoch` equal the header's; `issued` is an integer at most 3600 s ahead of the member's clock and not older than 30 days; `owner` is the owner; there are exactly `count` members, each in the form above, and no container, `x25519` or `ed25519` appears twice; `members[0]` is the owner with the owner's Ed25519 key; the member at the position of the slot that opened is this member with its own keys; `prev` equals the hash of the roster the member holds for `n − 1`, when it holds `n − 1`; `relays` and `bus` are valid.
6. **Channel records.** Every member's `x25519` and `ed25519` equal those in its TAP-26 channel record, read under TAP-20 §3.2. Records MAY be cached for at most a few minutes (the reference: 300 s), so that a sold circuit or a removed record takes effect. A record that is definitively invalid counts as a mismatch; an RPC failure aborts without deciding, and the message can be offered again. The same cache MAY serve TAP-26 invite resolution (`invite.from`, `invite.owner`). Only definitive answers are cached (a valid record, or one that is definitively invalid or absent); an RPC failure MUST NOT be. When the owner starts any epoch after the first (§3.6) it SHOULD read each record afresh rather than from the cache, since a stale record would keep a sold member for a whole epoch; the first epoch MAY use records the owner has just resolved.

When a member installs a new epoch it keeps the epoch it held before for 10 minutes, for messages still in flight, and discards every older one. Under that previous epoch it MUST refuse messages from a sender absent from the new roster, and, once a sender has sent a message it accepted under the new epoch, that sender's messages under the previous one.

### 3.4 Messages (wire type `0x05`)

```
header = 0x05 ‖ gid(16) ‖ uint64be(epoch) ‖ uint32be(sender) ‖ uint64be(seq) ‖ nonce(24)
key    = HKDF-SHA256(K, salt = gid ‖ uint64be(epoch), info = "TAP-27/sender/v1" ‖ uint32be(sender), L = 32)
ct     = XChaCha20-Poly1305(key, nonce, aad = header).encrypt(plaintext)
sig    = Ed25519(members[sender], "TAP-27/msg/v1" ‖ header ‖ ct)
wire   = header ‖ ct ‖ sig(64)
```

`sender` is the sender's position in the roster. `nonce` is 24 random bytes drawn for each message, so a sender that loses its state never reuses one. `seq` is strictly increasing per sender per epoch: a sender starts it from its clock (unix milliseconds × 2^16) whenever it installs an epoch or restarts, and counts up by one per message, so no saved state is needed. A receiver MUST verify the signature with the Ed25519 key of `members[sender]` in that epoch's roster before anything else, its own messages included, and then ignores its own. It MUST refuse a `seq` not greater than the highest it accepted from that sender in that epoch, MUST accept a gap and SHOULD report it (TAP-26 §3.4): as `seq − high − 1` when that is below 2^16, otherwise as unknown (the sender restarted). Plaintext MUST NOT exceed 16,000 bytes.

### 3.5 Joining

The owner invites a container by posting a sealed invite (TAP-26 §3.2, wire type `0x03`) to its inbox room, whose content is:

```json
{ "v": 1, "kind": "tape.group/invite", "gid": "<32 hex>", "owner": { "container": "0x…", "chainId": 56 },
  "relays": [ … ], "bus": "0x…" }
```

and then posts an epoch message that includes the new member. The invite is not trusted for anything but where to look: the member looks up the owner's channel record itself and accepts only epoch messages the owner signed, so a forged invite cannot make anyone join. Once it has accepted an epoch, a member uses the roster's `relays` and `bus`, which the owner signed, not the invite's. The owner SHOULD repost the current epoch message when it invites someone and at least as often as its transports forget data (RECOMMENDED: every 30 minutes on a ChannelBus read through public nodes, which serve logs for between about 5,000 and 10,000 blocks, roughly 40 to 75 minutes on BSC; every 10 minutes on a relay whose rooms live 15 minutes), so that a member returning from a long absence can catch up; a new epoch message is the only checkpoint this TAP has. (The 30-minute figure assumes the shortest windows measured in TAP-26 §3.7; nodes that keep far more history, such as those measured there on 2026-09-27, tolerate longer intervals.) On a ChannelBus each repost is one transaction of up to 16,448 bytes of calldata (about 420,000 gas).

Note (non-normative): the invite and the epoch message travel to different rooms. The invite goes to the new member's inbox room (TAP-26 §3.2), which is derived from the member's container address and chainId, not from the wallet that holds its circuit; the epoch message goes to the group room (§3.2). An owner that posts only the epoch message leaves a new member with nothing to read, since the member learns the group room from the invite. A reader that reuses another room's cursor, or drops the relay's room epoch (TAP-26 §3.5), can skip an invite at index 0. The reference SDK posts both in one call (`deliverGroupUpdate`) and reads an inbox with one cursor per room that keeps the room epoch (`checkGroupInvites`).

### 3.6 Membership changes

The owner MUST start a new epoch when a member is removed and at least every 30 days (older epoch messages are refused, §3.3), and SHOULD start one when a member is added and periodically (RECOMMENDED: at least daily in an active group). Whenever it starts an epoch the owner re-verifies every member against its channel record (§3.3 step 6): a member whose record is definitively invalid (a circuit sold, a record removed) is dropped from the new roster and reported; an RPC failure aborts the new epoch. A removed member keeps every key it already had and can read everything up to the epoch that removed it; it cannot read anything after. A new member cannot read anything before the epoch that added it. There is no owner transfer in this version: a group that needs a new owner is a new group.

### 3.7 State and restarts

Nothing in this TAP needs saved state to stay safe: nonces are random and `seq` starts from the clock. Two things are still worth keeping:

- A member SHOULD persist the highest epoch it accepted and pass it as the minimum epoch after a restart (§3.3 step 3). Otherwise a relay can replay an older epoch message, within the 30-day bound on `issued`, that still lists a since-removed member, and the restarted member would send under a key that member holds.
- The owner persists the roster (it holds no secret) and, after a restart, starts the next epoch at once, since the previous epoch key is gone.

Reference: `group.snapshot()` returns what to keep, `resumeGroup` restarts an owner from it, and `joinGroup({ minEpoch })` restarts a member.

## 4. Rationale

- **An owner, not consensus.** Agreement among N parties on membership is the hard part of group protocols (MLS spends most of its length on it). One owner who signs every roster is simple, verifiable, and enough for a group someone creates and runs. Its cost is stated in §8.
- **Hidden roster, slots without fingerprints.** TAP-26 hides who talks to whom from relays. Publishing the member list in clear would undo that for groups, so the roster is encrypted under the epoch key. Slots carry no key fingerprint: channel records are public, so anyone could hash every published key and read membership off the fingerprints. A member instead tries every slot, at the cost of one X25519 and at most 32 AEAD openings.
- **A key commitment in the signed header.** XChaCha20-Poly1305 is not key-committing: a malicious owner could craft one roster ciphertext that opens under two keys. Committing to `K` in the signed header makes every member hold the same key or detect otherwise.
- **Per-sender keys and random nonces.** Every member encrypts under keys derived from one epoch key; separate keys per sender keep the senders apart, and a 24-byte random nonce makes a collision negligible without any counter to save. A nonce built from `seq` would need state that survives restarts: a member that restarted and re-accepted the same epoch would reuse (key, nonce) and reveal the XOR of two plaintexts.
- **Signatures, not MACs.** With a shared key any member could forge another's messages. Ed25519 signatures with each member's published key make the sender verifiable by every member. §8 states what that costs.

## 5. Backwards Compatibility

Adds wire types `0x04` and `0x05` to the TAP-26 relay and ChannelBus profiles, which already carry any wire message; relays need no change. TAP-26 channels are unaffected.

## 6. Test Vectors

`spec/vectors/tap-27-group.json` fixes every secret and random draw (the epoch key, the ephemeral key, the epoch nonce, each message's random nonce) and the roster's `issued`, and gives an epoch message for three members, the decrypted roster, each member's derived sender key and two signed messages. `spec/vectors/verify.py` recomputes them with X25519, HKDF-SHA256, XChaCha20-Poly1305 and Ed25519 implemented independently from RFC 7748, RFC 5869, the XChaCha draft and RFC 8032.

## 7. Reference Implementation

`sdk/src/group.js` (`createGroup`, `joinGroup` with `minEpoch`, `resumeGroup`, `openGroupInvite`, `group.snapshot()`, `acceptEpoch`, `addMembers`/`removeMembers`/`rotate`/`inviteFor`, `seal`/`open`), with `api.groupVerifier()` as the member verifier (it checks each member against `api.chain.channelKeys` and caches records for 300 s). Tests: `sdk/test/group.test.mjs` (a group over a ChannelBus alone; a removed member cannot read the next epoch and a new member cannot read the one before; forged, tampered and inconsistent epoch messages and an owner handing out different keys are refused; replayed, reattributed and cross-group messages are refused and gaps reported; previous-epoch messages are refused after ten minutes; size limits) and `sdk/test/audit-group.test.mjs` (adversarial: restarts, rollback, concurrent acceptance, fingerprints linking members, equivocation, small-order keys, stale caches, removed members sending under the old epoch, forged invites).

## 8. Security Considerations

- **Forward secrecy per epoch only.** A leaked epoch key exposes that epoch's messages. Rotate epochs (§3.6).
- **The owner is trusted for membership.** The owner decides who is in the group and can add a member at any time; members see every roster and should show membership changes to their users. The owner cannot impersonate members (messages are signed) and cannot give members different keys (the commitment), but it can split the group into different epochs for different members by withholding epoch messages. There is no owner transfer.
- **Equivocation is detectable.** An owner that signs two different messages for one epoch is caught by any member that sees both (§3.3 step 2), and the two signed messages prove it to anyone who knows the owner's key.
- **Non-repudiation inside a group.** Unlike a TAP-26 channel, a group message is signed with the sender's published long-term key, so any member can prove to a third party what another member said. Applications that must not create such evidence use TAP-26 channels.
- **Metadata.** Relays and chain observers see the group id, the room, the number of members (slot count), the sender's index, and the size and time of every message. They do not see containers, keys or content, even if they read every channel record on chain: slots carry no fingerprint (§4).
- **Restarts and the 30-day bound.** A member that does not persist its highest epoch can, after a restart, be rolled back to any epoch message it is shown that is less than 30 days old, including one that still lists a since-removed member (§3.7). The bound relies on members' clocks, and an owner that stops starting epochs stops its group after 30 days.
- **Clocks.** A member MUST refuse a roster whose `issued` is more than 3600 s ahead of its clock or more than 30 days old. The age bound is what stops replays; the future bound only rejects nonsense and MUST NOT be tighter than 3600 s. A sender's `seq` starts at max(clock_ms × 2^16, lastSeq + 1), where `lastSeq` is the persisted value (at least the last `seq` it used). An implementation that persists state SHOULD persist `lastSeq` after sending, so that a clock stepped back across a restart does not make new messages look like replays. Without saved state, a sender whose clock stepped back may have messages refused until the clock passes its previous high. One identity is one device in this version.
- **Invites.** A forged invite cannot make anyone join, since it brings no owner-signed epoch, but, as with any invite, it can make a container contact a relay an attacker chose and so expose its IP address to that relay.
- **Stale readers.** A member offline longer than its transports keep data cannot catch up until the owner reposts an epoch message; messages sent in between are lost to it, and the gap is visible.

## 9. Copyright

Copyright and related rights waived via [CC0](https://creativecommons.org/publicdomain/zero/1.0/).

---

# TAP-27：Tape Group：容器之间的私密群聊（中文译文）

> 以英文版为准。章节编号一一对应。

> **占位编号。** TAP-27 是在 [TapeKit issue #8](https://github.com/TapeOutProtocol/TapeKit/issues/8) 中提议的占位编号。TapeKit 目前还没有编号提案流程（对 TapeOut 本身的修改遵循 TapeKit `SPEC.md` §15），因此维护者可能另行分配编号，或把本文档移入其它流程；见 [TAP-1](TAP-1.md)。

> **实现状态（2026-09-27）：** 已实现：`sdk/src/group.js` 可经任一 TAP-26 传输运行群聊，包括已部署的 ChannelBus（`0x486110c35d9b90a9d6D85c8063A065f9e7b6b707`）与公共中继 `relay.tapeapi.fun`。群聊无需托管服务：群主本身是客户端。未经第三方审计。

> **目标状态：** Target: Stable (v1) at TapeAPI 1.0。在 TapeAPI 1.0 发布时由 Draft 进入 Stable (v1)（见 [TAP-1](TAP-1.md) §4.1）；在此之前仍是 Draft。

## 1. 摘要

Tape Group 是至多 32 个 TapeOut 容器之间的加密会话。其中一个容器是**群主**，负责维护成员名单；每次成员变动都开启一个新的**纪元**，生成新的群密钥，分别密封给每个成员的通道密钥（TAP-26 §3.1）。消息用由纪元密钥派生的发送者专属密钥加密，并用发送者的 Ed25519 通道密钥签名，因此成员之间能互相读取、却无法互相冒充。成员名单本身也加密传输，承载群密钥的格子也不指向任何人：中继或链上观察者，哪怕读遍链上所有通道记录，也只能得知群号、成员人数以及消息的大小和时间，而不知道成员是谁。传输沿用 TAP-26：任何中继（TAP-26 §3.5）或 ChannelBus（TAP-26 §3.7）。

## 2. 动机

TAP-26 是两方通道，其三重 DH 握手无法推广到 N 方。需要把多个容器聚在同一会话里的应用，否则只能开 N² 条两两通道，或以明文广播。本 TAP 给出最小的群组构造：在能保持的地方保持 TAP-26 的性质（端到端机密、发送者认证、无可信服务器、成员不公开），在保持不了的地方如实写明（§8）。它只定义会话本身：除群主外没有其它角色，也没有应用状态。

## 3. 规范

### 3.1 身份

每个成员（包括群主）都有 TAP-26 通道身份（TAP-26 §3.1）：X25519 密钥 `x25519` 与 Ed25519 密钥 `ed25519`，由电路当前持有人授权并发布在容器站点中。客户端在信任名单（§3.3）之前 MUST 对照每个成员的通道记录核验其密钥；名单只是群主对"谁在群里"的陈述，不是任何人密钥的证明。

### 3.2 群号与房间

群主随机生成 16 字节群号 `gid`。所有群消息都发往同一个房间 `SHA-256("TAP-27/room/v1" ‖ gid)`，位于名单所列的中继或 ChannelBus 上。每个成员都在此发送和读取；在收费中继上，每个发送者为自己的消息付费。

### 3.3 纪元消息（线路类型 `0x04`）

群主开启纪元 `n`（首个为 0）：生成 32 字节纪元密钥 `K`、新的 X25519 密钥 `(e, E)` 与 24 字节随机数 `N`，并发送英文部分所列格式的消息。每个成员一格（slot），按成员顺序排列，格内是用由该成员 X25519 公钥派生的 `kek_i` 包裹的 `K`，共 48 字节，不带任何公钥指纹；名单用 `K` 加密；消息头里带 `K` 的承诺；整条消息由群主的 Ed25519 密钥签名。`count` 为 1 到 32。`n` 至多为 2^32 − 1。整条消息 MUST 放得进一条 TAP-26 线路消息（16,448 字节）。名单对象的格式见英文部分，其中含 `issued`（Unix 秒）。

`members[0]` MUST 是群主。每个成员恰为 `{ container, chainId, x25519, ed25519 }`，`container` 为小写，两把密钥为小写 `0x` 十六进制；接收方 MUST 拒绝任何其它形式，使每个接收方哈希的是同样的字节。`issued` 是群主构造该消息的时间（Unix 秒）。`prev` 是纪元 `n − 1` 名单明文字节按发送原样（即成员解密所得的字节，绝不是重新编码的结果）的 `SHA-256`，写作 64 个小写十六进制字符、不带 `0x`；纪元 0 为 64 个零。`relays` 与 `bus` 遵循 TAP-26 §3.2 第 1 步。

成员逐条处理纪元消息，其持有的纪元绝不后退。只有在以下各项按顺序全部成立时才接受纪元消息：

1. **群主。** 消息头中的 `gid` 是本群的，且群主的 Ed25519 签名严格验证通过（RFC 8032：拒绝小阶公钥，不采用 ZIP-215 的宽松规则）。群主在群的整个生命周期内固定；其公钥取自它自己的通道记录，按邀请所指明的群主查询（§3.5）。
2. **重复与两面行为。** 若成员已接受过纪元 `n` 的消息，则同一条消息是重复，直接忽略、不报错。群主签名的、同一 `n` 的另一条不同消息，是群主两面行为的证据：成员 MUST 拒绝它并 MUST 报告（参考实现：`GROUP_EQUIVOCATION`，附两条消息去掉签名后的 SHA-256）。参考实现在内存中记住其接受的最新纪元及其下 64 个以内纪元的消息；已不记得的 `n` 在第 3 步被拒。
3. **更新。** `n` 大于成员当前持有的纪元，且不低于成员持久化的最低纪元（§3.7）。
4. **密钥。** 成员只派生一次自己的 `kek`（与 `E` 做一次 X25519），逐格尝试。MUST 恰有一格能打开，且 `SHA-256("TAP-27/commit/v1" ‖ K)` MUST 等于 `commit`。该承诺受群主签名覆盖，正是它阻止群主给不同成员发不同的密钥。
5. **名单。** 名单能解密，能按严格 JSON（TAP-21 §3.3）解析，`v` 为 1、`kind` 为 `"tape.group/roster"`；其 `gid` 与 `epoch` 与消息头一致；`issued` 为整数，至多超前成员时钟 3600 秒，且不早于 30 天前；`owner` 是群主；成员数恰为 `count`，每个成员都是上述形式，且没有任何容器、`x25519` 或 `ed25519` 出现两次；`members[0]` 是带着群主 Ed25519 公钥的群主；被打开那一格所在位置上的成员就是本成员，且带着自己的密钥；成员持有 `n − 1` 纪元名单时，`prev` 等于该名单的哈希；`relays` 与 `bus` 合法。
6. **通道记录。** 每个成员的 `x25519` 与 `ed25519` 与其 TAP-26 通道记录一致（按 TAP-20 §3.2 读取）。记录 MAY 缓存，但至多几分钟（参考实现：300 秒），使电路转手或记录被删除能够生效。确定无效的记录算作不一致；RPC 故障则中止、不作判定，该消息可以再次提交。同一缓存 MAY 用于 TAP-26 的邀请解析（`invite.from`、`invite.owner`）。只缓存确定的回答（有效记录，或确定无效、不存在的记录）；RPC 故障 MUST NOT 被缓存。群主开启第一个之后的任何纪元时（§3.6）SHOULD 重新读取每条记录而不是用缓存，因为过期的记录会让已出售的成员再留一整个纪元；第一个纪元 MAY 使用群主刚刚解析过的记录。

成员安装新纪元时，为仍在途中的消息把此前持有的纪元保留 10 分钟，更早的纪元一律丢弃。在这一上一纪元下，成员 MUST 拒绝两类消息：来自不在新名单中的发送者的消息，以及已有一条新纪元消息被接受的发送者的消息。

### 3.4 消息（线路类型 `0x05`）

格式见英文部分：消息头为 `0x05 ‖ gid ‖ uint64be(epoch) ‖ uint32be(sender) ‖ uint64be(seq) ‖ nonce(24)`，密文用发送者密钥、以 `nonce` 和消息头为附加数据加密，签名覆盖 `"TAP-27/msg/v1" ‖ 消息头 ‖ 密文`。`sender` 是发送者在名单中的位置。`nonce` 是每条消息新抽取的 24 个随机字节，因此丢失状态的发送者也绝不会重复使用。`seq` 在每个纪元内对每个发送者严格递增：发送者每次安装纪元或重启时，从自己的时钟（Unix 毫秒 × 2^16）起算，每条消息加一，因此无需保存任何状态。接收方 MUST 在做任何其它事之前，用该纪元名单中 `members[sender]` 的 Ed25519 公钥验证签名，自己发出的消息也不例外，然后忽略自己的消息。接收方 MUST 拒绝不大于已从该发送者在该纪元接受的最大 `seq` 的消息，MUST 接受空洞并 SHOULD 报告（TAP-26 §3.4）：`seq − high − 1` 小于 2^16 时报告该值，否则报告为未知（发送者重启过）。明文 MUST NOT 超过 16,000 字节。

### 3.5 入群

群主向被邀请容器的收件房间投递一份密封邀请（TAP-26 §3.2，线路类型 `0x03`，内容格式见英文部分），然后发出一条包含新成员的纪元消息。邀请只被用来得知"去哪里看"：成员自行查询群主的通道记录，并只接受群主签名的纪元消息，因此伪造的邀请不能让任何人入群。接受某个纪元之后，成员改用名单里（群主签过的）`relays` 与 `bus`，而不是邀请里的。群主 SHOULD 在邀请新成员时、并至少以传输层遗忘数据的频率重发当前纪元消息（RECOMMENDED：经公共节点读取的 ChannelBus 上每 30 分钟一次，公共节点视后端约保留 5,000 到 10,000 个区块的日志，在 BSC 上约 40 到 75 分钟；房间寿命 15 分钟的中继上每 10 分钟一次），使长时间离开后返回的成员能够追上；新的纪元消息是本 TAP 唯一的检查点。（30 分钟这一数字按 TAP-26 §3.7 中实测的最短窗口计算；保留历史长得多的节点，例如该节 2026-09-27 实测的那些，可以容忍更长的间隔。）在 ChannelBus 上每次重发是一笔至多 16,448 字节调用数据的交易（约 420,000 gas）。

注（非规范性）：邀请与纪元消息投往不同的房间。邀请投往新成员的收件房间（TAP-26 §3.2），它由成员的容器地址与 chainId 推导，而不是由持有其电路的钱包推导；纪元消息投往群房间（§3.2）。群主若只投纪元消息，新成员就无从读起，因为成员是从邀请得知群房间的。读取方若沿用别的房间的游标，或丢掉中继的房间纪元（TAP-26 §3.5），可能跳过序号 0 的邀请。参考 SDK 用一次调用投递两者（`deliverGroupUpdate`），并以按房间保存、带房间纪元的游标读取收件房间（`checkGroupInvites`）。

### 3.6 成员变动

移除成员时，以及至少每 30 天（更早的纪元消息会被拒绝，§3.3），群主 MUST 开启新纪元；新增成员时以及定期（RECOMMENDED：活跃的群至少每天一次）SHOULD 开启。群主每次开启纪元都重新对照通道记录核验全部成员（§3.3 第 6 步）：记录确定无效的成员（电路已转手、记录已删除）从新名单中移除并予以报告；RPC 故障则中止这次新纪元。被移除的成员保留它已有的全部密钥，能读到移除它的那个纪元之前的所有内容，读不到之后的任何内容。新成员读不到加入它的那个纪元之前的任何内容。本版本不支持转让群主：需要新群主的群就是一个新群。

### 3.7 状态与重启

本 TAP 的安全性不依赖任何保存的状态：随机数是随机的，`seq` 从时钟起算。但仍有两样东西值得保存：

- 成员 SHOULD 持久化它接受过的最高纪元，并在重启后把它作为最低纪元传入（§3.3 第 3 步）。否则中继可以在 `issued` 的 30 天界限内，重放一条仍列有已被移除成员的旧纪元消息，重启后的成员就会用那个成员也持有的密钥发送消息。
- 群主持久化名单（其中不含任何秘密），重启后立即开启下一纪元，因为上一纪元的密钥已经不在了。

参考实现：`group.snapshot()` 返回要保存的内容，`resumeGroup` 据此让群主重启，`joinGroup({ minEpoch })` 让成员重启。

## 4. 原理

- **群主，而非共识。** N 方就成员名单达成一致是群组协议最难的部分（MLS 的大部分篇幅都在讲这个）。由一个群主签署每份名单，简单、可验证，对"有人创建并运营"的群足够。其代价见 §8。
- **名单不公开，格子不带指纹。** TAP-26 对中继隐藏谁在和谁通信。明文公布成员名单会让群聊失去这一性质，因此名单用纪元密钥加密。格子不带公钥指纹：通道记录是公开的，任何人都能哈希每一把已发布的公钥，再按指纹读出成员名单。成员改为逐格尝试，代价是一次 X25519 与至多 32 次 AEAD 解密。
- **签名的消息头里放密钥承诺。** XChaCha20-Poly1305 不具备密钥承诺性：恶意群主可以构造一份在两把密钥下都能打开的名单密文。在签名的消息头里承诺 `K`，使每个成员要么持有同一把密钥，要么能察觉不同。
- **发送者专属密钥与随机 nonce。** 所有成员都用由同一纪元密钥派生的密钥加密；每个发送者一把独立密钥，把发送者彼此隔开，24 字节的随机 nonce 使碰撞概率可以忽略，而且无需保存任何计数器。由 `seq` 构造的 nonce 需要能跨重启保存的状态：重启后再次接受同一纪元的成员会重用（密钥，nonce），泄露两段明文的异或。
- **签名，而非 MAC。** 共享密钥下任何成员都能伪造他人的消息。用每个成员公开的 Ed25519 密钥签名，使每个成员都能验证发送者。其代价见 §8。

## 5. 向后兼容

为 TAP-26 的中继与 ChannelBus 配置新增线路类型 `0x04` 与 `0x05`，二者本就能承载任意线路消息，中继无需改动。TAP-26 通道不受影响。

## 6. 测试向量

`spec/vectors/tap-27-group.json` 固定所有私钥与随机抽取（纪元密钥、临时密钥、纪元随机数、每条消息的随机 nonce）以及名单的 `issued`，给出三名成员的纪元消息、解密后的名单、每个成员派生的发送者密钥以及两条已签名消息。`spec/vectors/verify.py` 用按 RFC 7748、RFC 5869、XChaCha 草案与 RFC 8032 独立实现的 X25519、HKDF-SHA256、XChaCha20-Poly1305 与 Ed25519 重新计算全部数值。

## 7. 参考实现

`sdk/src/group.js`（`createGroup`、带 `minEpoch` 的 `joinGroup`、`resumeGroup`、`openGroupInvite`、`group.snapshot()`、`acceptEpoch`、`addMembers`/`removeMembers`/`rotate`/`inviteFor`、`seal`/`open`），以 `api.groupVerifier()` 作为成员核验器（它对照 `api.chain.channelKeys` 核验每个成员，记录缓存 300 秒）。测试：`sdk/test/group.test.mjs`（只经 ChannelBus 的群聊；被移除的成员读不到下一纪元，新成员读不到加入前的纪元；伪造、篡改、自相矛盾的纪元消息以及给成员发不同密钥的群主一律被拒；被重放、被改署名或被挪到别的群的消息被拒，空洞被报告；上一纪元的消息十分钟后被拒；大小上限）与 `sdk/test/audit-group.test.mjs`（对抗性测试：重启、回滚、并发接受、指纹暴露成员、两面行为、小阶公钥、过期缓存、被移除成员在旧纪元下发消息、伪造邀请）。

## 8. 安全考量

- **前向保密只到纪元粒度。** 泄露的纪元密钥会暴露该纪元的消息。应轮换纪元（§3.6）。
- **成员资格信任群主。** 群主决定谁在群里，并可随时加人；成员能看到每份名单，应把成员变动展示给用户。群主无法冒充成员（消息有签名），也无法给成员发不同的密钥（承诺），但可以通过扣留纪元消息让不同成员停留在不同纪元。不支持转让群主。
- **两面行为可被察觉。** 群主为同一纪元签了两条不同消息，看到这两条消息的任何成员都能发现（§3.3 第 2 步），而这两条签名消息可以向任何知道群主公钥的人证明这一点。
- **群内不可否认。** 与 TAP-26 通道不同，群消息用发送者公开的长期密钥签名，因此任何成员都能向第三方证明另一成员说过什么。不能产生这种证据的应用应使用 TAP-26 通道。
- **元数据。** 中继与链上观察者能看到群号、房间、成员人数（格数）、发送者序号以及每条消息的大小与时间；即使读遍链上所有通道记录，也看不到容器、密钥或内容：格子不带指纹（§4）。
- **重启与 30 天界限。** 不持久化最高纪元的成员，重启后可能被回滚到别人给它看的、不满 30 天的任何纪元消息，包括仍列有已被移除成员的那一条（§3.7）。该界限依赖成员的时钟；不再开启新纪元的群主，其群在 30 天后停止工作。
- **时钟。** 成员 MUST 拒绝 `issued` 超前本方时钟 3600 秒以上、或早于 30 天前的名单。挡住重放的是年龄界限；超前界限只拦荒谬值，MUST NOT 严于 3600 秒。发送者的 `seq` 从 max(时钟毫秒 × 2^16, lastSeq + 1) 起算，`lastSeq` 为保存的值（不小于最后用过的 `seq`）。保存状态的实现 SHOULD 在发送后保存 `lastSeq`，这样重启前后时钟回拨也不会让新消息看起来像重放。不保存状态时，时钟回拨的发送者的消息可能被拒，直到时钟越过它之前的最大值。本版本中一个身份对应一台设备。
- **邀请。** 伪造的邀请不能让任何人入群，因为它带不来群主签名的纪元；但和任何邀请一样，它能让容器去连接攻击者选定的中继，从而把自己的 IP 地址暴露给该中继。
- **滞后的读者。** 离线时间超过传输层数据保留期的成员，在群主重发纪元消息之前无法追上；其间发出的消息对它丢失，空洞可见。

## 9. 版权

著作权及相关权利依 [CC0](https://creativecommons.org/publicdomain/zero/1.0/) 放弃。
