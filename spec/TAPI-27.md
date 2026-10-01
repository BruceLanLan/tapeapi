| TAPI | 27 |
|---|---|
| Title | Tape Group: Private Group Channels Between Containers |
| Author | Bruce (@BruceLanLan) |
| Status | Stable (v1) since 2026-09-29 (TapeAPI 1.0.0) |
| Revision | 2026-09-30: added §3.8, format 2 (up to 128 members), marked Experimental, with notes in §5 to §8. No format-1 text, wire format, signature domain or error code changed. |
| Implementation | Implemented (2026-09-27): `sdk/src/group.js` runs groups over any TAPI-26 transport, including the deployed ChannelBus (`0x486110c35d9b90a9d6D85c8063A065f9e7b6b707`) and the public relay `relay.tapeapi.fun`. There is no group service to host: the owner is a client. No third-party audit. |
| Type | Standards |
| Created | 2026-09-23 |
| Requires | TAPI-20, TAPI-21, TAPI-26 |
| License | CC0-1.0 |

# TAPI-27: Tape Group: Private Group Channels Between Containers

> English is authoritative. 中文译文见下半部分，章节编号一一对应。

> **Not a TAP.** "TAPI-27" is TapeAPI's own name for this document; until 2026-09-30 it was called "TAP-27". It is not a TAP: TAP numbers are assigned by the editors of [TapeOutProtocol/TAPs](https://github.com/TapeOutProtocol/TAPs) under TAP-01 §6.1. Part of it (format 1 only) has been submitted as a TAP draft under that process, under review and without a number yet: private groups ([PR #20](https://github.com/TapeOutProtocol/TAPs/pull/20)). A submission is not adoption, and the draft takes whatever number the editors give it. Frozen constants that contain an old name (for example the `TAP-26/…` labels) are historical constants and never change.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

## 1. Abstract

A Tape Group is an encrypted conversation among up to 32 TapeOut containers. One container, the **owner**, keeps the member list; every change of membership starts a new **epoch** with a fresh group key, delivered to each member sealed to its channel key (TAPI-26 §3.1). Messages are encrypted under a per-sender key derived from the epoch key and signed with the sender's Ed25519 channel key, so members can read each other and cannot impersonate each other. The member list itself travels encrypted, and the slots that carry the group key name nobody: a relay or a chain observer, even one who reads every channel record on chain, learns the group id, the number of members and the sizes and times of messages, not who the members are. Transport is TAPI-26's: any relay (TAPI-26 §3.5) or ChannelBus (TAPI-26 §3.7).

## 2. Motivation

TAPI-26 is a two-party channel, and its triple Diffie-Hellman handshake does not extend to N parties. Applications that gather several containers in one conversation otherwise either open N² pairwise channels or broadcast in the clear. This specification adds the smallest group construction that keeps TAPI-26's properties where they can be kept (end-to-end confidentiality, sender authentication, no trusted server, hidden membership) and states plainly where it cannot (§8). It defines a conversation and nothing else: no roles beyond the owner, no application state.

## 3. Specification

### 3.1 Identities

Every member, the owner included, has a TAPI-26 channel identity (TAPI-26 §3.1): an X25519 key `x25519` and an Ed25519 key `ed25519`, authorised by the circuit's current holder and published in the container's site. A client MUST verify every member's keys against that record before trusting a roster (§3.3); a roster is the owner's statement about who is in the group, not proof of anyone's keys.

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

`R_i` is member `i`'s X25519 key, and slots appear in member order. `count` is 1 to 32. `n` is at most 2^32 − 1. The whole message MUST fit one TAPI-26 wire message (16,448 bytes). The roster object is:

```json
{ "v": 1, "kind": "tape.group/roster", "gid": "<32 hex>", "epoch": n, "issued": <unix seconds>, "prev": "<64 hex>",
  "owner": { "container": "0x…", "chainId": 56 },
  "members": [ { "container": "0x…", "chainId": 56, "x25519": "0x…", "ed25519": "0x…" } ],
  "relays": [ { "url": "https://…/tapeapi/v1", "container": "0x…" } ], "bus": "0x…" }
```

`members[0]` MUST be the owner. Each member is exactly `{ container, chainId, x25519, ed25519 }`, with `container` in lowercase and both keys as lowercase `0x` hex; a receiver MUST refuse any other form, so that every receiver hashes the same bytes. `issued` is the time the owner built the message, in unix seconds. `prev` is `SHA-256` of the roster plaintext bytes of epoch `n − 1` as sent (the bytes a member decrypted, never a re-encoding), as 64 lowercase hex characters without `0x`, or 64 zeros for epoch 0. `relays` and `bus` follow TAPI-26 §3.2 step 1.

A member processes epoch messages one at a time, and the epoch it holds never moves backwards. It accepts an epoch message only if all of the following hold, in this order:

1. **Owner.** The header's `gid` is the group's, and the owner's Ed25519 signature verifies strictly (RFC 8032: small-order public keys are refused, no ZIP-215 leniency). The owner is fixed for the life of the group; its key comes from its own channel record, looked up by the owner the invite names (§3.5).
2. **Duplicates and equivocation.** If the member already accepted a message for epoch `n`, the same message is a duplicate and is ignored without error. A different owner-signed message for the same `n` is proof that the owner equivocated: the member MUST refuse it and MUST report it (reference: `GROUP_EQUIVOCATION`, with the SHA-256 of both messages minus their signatures). The reference remembers, in memory, the messages of epochs up to 64 below the newest it accepted; an `n` it no longer remembers fails step 3.
3. **Newer.** `n` is greater than the epoch the member holds, and not below the minimum epoch the member persisted (§3.7).
4. **Key.** The member derives its `kek` once (one X25519 with `E`) and tries every slot. Exactly one slot MUST open, and `SHA-256("TAP-27/commit/v1" ‖ K)` MUST equal `commit`. The commitment, covered by the owner's signature, is what stops an owner from giving different members different keys.
5. **Roster.** The roster decrypts and parses as strict JSON (TAPI-21 §3.3) with `v` 1 and `kind` `"tape.group/roster"`; its `gid` and `epoch` equal the header's; `issued` is an integer at most 3600 s ahead of the member's clock and not older than 30 days; `owner` is the owner; there are exactly `count` members, each in the form above, and no container, `x25519` or `ed25519` appears twice; `members[0]` is the owner with the owner's Ed25519 key; the member at the position of the slot that opened is this member with its own keys; `prev` equals the hash of the roster the member holds for `n − 1`, when it holds `n − 1`; `relays` and `bus` are valid.
6. **Channel records.** Every member's `x25519` and `ed25519` equal those in its TAPI-26 channel record, read under TAPI-20 §3.2. Records MAY be cached for at most a few minutes (the reference: 300 s), so that a sold circuit or a removed record takes effect. A record that is definitively invalid counts as a mismatch; an RPC failure aborts without deciding, and the message can be offered again. The same cache MAY serve TAPI-26 invite resolution (`invite.from`, `invite.owner`). Only definitive answers are cached (a valid record, or one that is definitively invalid or absent); an RPC failure MUST NOT be. When the owner starts any epoch after the first (§3.6) it SHOULD read each record afresh rather than from the cache, since a stale record would keep a sold member for a whole epoch; the first epoch MAY use records the owner has just resolved.

When a member installs a new epoch it keeps the epoch it held before for 10 minutes, for messages still in flight, and discards every older one. Under that previous epoch it MUST refuse messages from a sender absent from the new roster, and, once a sender has sent a message it accepted under the new epoch, that sender's messages under the previous one.

### 3.4 Messages (wire type `0x05`)

```
header = 0x05 ‖ gid(16) ‖ uint64be(epoch) ‖ uint32be(sender) ‖ uint64be(seq) ‖ nonce(24)
key    = HKDF-SHA256(K, salt = gid ‖ uint64be(epoch), info = "TAP-27/sender/v1" ‖ uint32be(sender), L = 32)
ct     = XChaCha20-Poly1305(key, nonce, aad = header).encrypt(plaintext)
sig    = Ed25519(members[sender], "TAP-27/msg/v1" ‖ header ‖ ct)
wire   = header ‖ ct ‖ sig(64)
```

`sender` is the sender's position in the roster. `nonce` is 24 random bytes drawn for each message, so a sender that loses its state never reuses one. `seq` is strictly increasing per sender per epoch: a sender starts it from its clock (unix milliseconds × 2^16) whenever it installs an epoch or restarts, and counts up by one per message, so no saved state is needed. A receiver MUST verify the signature with the Ed25519 key of `members[sender]` in that epoch's roster before anything else, its own messages included, and then ignores its own. It MUST refuse a `seq` not greater than the highest it accepted from that sender in that epoch, MUST accept a gap and SHOULD report it (TAPI-26 §3.4): as `seq − high − 1` when that is below 2^16, otherwise as unknown (the sender restarted). Plaintext MUST NOT exceed 16,000 bytes.

### 3.5 Joining

The owner invites a container by posting a sealed invite (TAPI-26 §3.2, wire type `0x03`) to its inbox room, whose content is:

```json
{ "v": 1, "kind": "tape.group/invite", "gid": "<32 hex>", "owner": { "container": "0x…", "chainId": 56 },
  "relays": [ … ], "bus": "0x…" }
```

and then posts an epoch message that includes the new member. The invite is not trusted for anything but where to look: the member looks up the owner's channel record itself and accepts only epoch messages the owner signed, so a forged invite cannot make anyone join. Once it has accepted an epoch, a member uses the roster's `relays` and `bus`, which the owner signed, not the invite's. The owner SHOULD repost the current epoch message when it invites someone and at least as often as its transports forget data (RECOMMENDED: every 30 minutes on a ChannelBus read through public nodes, which serve logs for between about 5,000 and 10,000 blocks, roughly 40 to 75 minutes on BSC; every 10 minutes on a relay whose rooms live 15 minutes), so that a member returning from a long absence can catch up; a new epoch message is the only checkpoint this specification has. (The 30-minute figure assumes the shortest windows measured in TAPI-26 §3.7; nodes that keep far more history, such as those measured there on 2026-09-27, tolerate longer intervals.) On a ChannelBus each repost is one transaction of up to 16,448 bytes of calldata (about 420,000 gas).

Note (non-normative): the invite and the epoch message travel to different rooms. The invite goes to the new member's inbox room (TAPI-26 §3.2), which is derived from the member's container address and chainId, not from the wallet that holds its circuit; the epoch message goes to the group room (§3.2). An owner that posts only the epoch message leaves a new member with nothing to read, since the member learns the group room from the invite. A reader that reuses another room's cursor, or drops the relay's room epoch (TAPI-26 §3.5), can skip an invite at index 0. The reference SDK posts both in one call (`deliverGroupUpdate`) and reads an inbox with one cursor per room that keeps the room epoch (`checkGroupInvites`).

### 3.6 Membership changes

The owner MUST start a new epoch when a member is removed and at least every 30 days (older epoch messages are refused, §3.3), and SHOULD start one when a member is added and periodically (RECOMMENDED: at least daily in an active group). Whenever it starts an epoch the owner re-verifies every member against its channel record (§3.3 step 6): a member whose record is definitively invalid (a circuit sold, a record removed) is dropped from the new roster and reported; an RPC failure aborts the new epoch. A removed member keeps every key it already had and can read everything up to the epoch that removed it; it cannot read anything after. A new member cannot read anything before the epoch that added it. There is no owner transfer in this version: a group that needs a new owner is a new group.

### 3.7 State and restarts

Nothing in this specification needs saved state to stay safe: nonces are random and `seq` starts from the clock. Two things are still worth keeping:

- A member SHOULD persist the highest epoch it accepted and pass it as the minimum epoch after a restart (§3.3 step 3). Otherwise a relay can replay an older epoch message, within the 30-day bound on `issued`, that still lists a since-removed member, and the restarted member would send under a key that member holds.
- The owner persists the roster (it holds no secret) and, after a restart, starts the next epoch at once, since the previous epoch key is gone.

Reference: `group.snapshot()` returns what to keep, `resumeGroup` restarts an owner from it, and `joinGroup({ minEpoch })` restarts a member.

### 3.8 Format 2: up to 128 members (Experimental)

> **Experimental** (TAPI-1 §4.1, the freeze, item 3). This section is outside the Stable (v1) freeze: it can change incompatibly or be withdrawn, and nothing else in this document depends on it. §3.1 to §3.7 define format 1, which it leaves unchanged. It is a section rather than a document of its own while it is Experimental, because it shares §3.1 to §3.7 and §4 with format 1 and two copies in two languages would drift; once it is to become stable it moves to a document of its own (TAPI-1 §4.1, "Breaking changes and coexistence").

Format 2 carries up to 128 members in one wire message and makes §3.3 step 6 lazy. Whatever this section does not change is as in format 1: identities (§3.1), the group room (§3.2), steps 1 to 4 of §3.3 and the rules for the previous epoch at its end, messages (§3.4), joining (§3.5), membership changes (§3.6) and state (§3.7).

**Format mark.** Format 2 keeps wire types `0x04` and `0x05` and writes the 8-byte epoch field of both as `ef = uint32be(0x54470200) ‖ uint32be(n)`. Format 1 requires that field to be at most 2^32 − 1 (§3.3), so every format-1 receiver refuses every format-2 epoch message and group message; a receiver that implements both formats reads the high half of the field: 0 is format 1, `0x54470200` is format 2, and anything else is refused. A group has one format for its whole life: a receiver MUST refuse a frame whose format is not the group's, without changing any state. A format-1 implementation refuses a format-2 frame by §3.3 and §3.4 alone; the reference (TapeAPI 1.1.0 and later) reports it as `GROUP_INVALID`, and a reference handle that knows format 2 reports any frame of the other format as `GROUP_INVALID` with `data.format` naming the format of the frame.

**Epoch message.**

```
header = 0x04 ‖ gid(16) ‖ ef(8) ‖ E(32) ‖ N(24) ‖ commit(32) ‖ uint16be(count)
commit = SHA-256("TAP-27/commit/v2" ‖ K)
kek_i  = HKDF-SHA256(X25519(e, R_i), salt = "TAP-27/wrap/v2", info = E ‖ R_i ‖ gid ‖ ef, L = 32)
slot_i = XChaCha20-Poly1305(kek_i, N, aad = header).encrypt(K)                                   -- 48 bytes, no fingerprint
roster = XChaCha20-Poly1305(K, N, aad = header ‖ slots).encrypt(rosterBytes)
sig    = Ed25519(owner, "TAP-27/epoch/v2" ‖ header ‖ slots ‖ uint32be(|roster|) ‖ roster)
wire   = header ‖ slots ‖ uint32be(|roster|) ‖ roster ‖ sig(64)

rosterBytes = "TGR2" ‖ uint64be(issued) ‖ prev(32) ‖ uint16be(count)
            ‖ count × ( container(20) ‖ uint32be(chainId) ‖ ed25519(32) )
            ‖ uint16be(L) ‖ tail(L)                       -- tail = UTF-8(canonicalJSON({ relays, bus? }))
```

`count` is 1 to 128, and entries appear in member order, the owner first. A member's `chainId` is at most 2^32 − 1, since the entry holds it in 4 bytes. `prev` is the SHA-256 of the roster bytes of epoch `n − 1` as sent, or 32 zero bytes for epoch 0. `relays` and `bus` are as in format 1, and each relay is exactly `{ url, container }`. The roster carries no member's X25519 key: only the owner uses those, to wrap slots, and a member's own slot opening is the check of its own. A member costs 104 bytes on the wire (a 48-byte slot and a 56-byte entry), against about 277 in format 1.

A member accepts a format-2 epoch message under steps 1 to 5 of §3.3, with the labels above in place of format 1's, and with step 5 read as follows: the roster decrypts and MUST parse exactly (its length; `count` equal to the header's; a tail that is canonical JSON with exactly `relays` and, optionally, `bus`; every `ed25519` a point of Ed25519 that is not of small order; no container and no `ed25519` twice); `issued` is within the bounds of step 5; the first entry is the owner with the owner's Ed25519 key; the entry at the position of the slot that opened is this member with its own Ed25519 key; and `prev` chains as in step 5. The reference reports every refusal of a format-2 roster, its relays and bus included, as `GROUP_INVALID`.

**Size.** The whole message MUST fit one TAPI-26 wire message (16,448 bytes). 128 is the largest power of two that fits in the worst case a roster allows: four relays with 512-character URLs and a bus make a `tail` of 2,383 bytes, and leave room for 132 members. With one relay of usual length, a message holds 154.

**Step 6, lazily.** Format 2 replaces §3.3 step 6 with the following.

- Before it accepts the message, the member checks the owner's entry against the owner's channel record, unless it holds a reusable verdict that the entry matches. A definitive mismatch refuses the message; an RPC failure aborts without deciding, as in format 1.
- Every other entry is checked lazily. A member MUST NOT present a message as authenticated from entry `i` until it has found entry `i`'s `ed25519` equal to that member's channel record; until then it MAY show the message, marked as coming from an unverified sender. It SHOULD check a sender when its messages arrive, and MAY check the other entries in the background.
- An entry whose record definitively does not match is outside the roster: the member MUST refuse its messages and SHOULD report the mismatch. An RPC failure decides nothing and is checked again later.
- A verdict is about one entry, `(chainId, container, ed25519)`. A verdict that the entry matches MAY be reused, across epochs, for at most 24 hours after the check that reached it began (the reference: `verifyReuseS`, 86,400 s by default and at most; an application MAY choose less). A verdict that it does not match MUST NOT be reused for more than 60 seconds or to refuse an epoch message, and SHOULD rest on a read that no cache answered: a record can look absent only because a node lagged or a cache is stale, and a longer negative verdict would silence the member (the reference: `VERIFY_NEGATIVE_S`, 60 s, and a "no" is read again past the client's identity cache before it counts). An RPC failure is no verdict. An entry that changed is a new entry, and no earlier verdict covers it.
- The owner's side: whenever it starts an epoch it checks every member, both keys, against a freshly read channel record (§3.6), except that it MAY rely on a positive verdict of its own on an entry that has not changed (for the owner an entry includes the X25519 key, since it checks both), within the same 24 hours from the start of the check that reached it. Relying on a verdict does not renew it. A new entry, a changed one and one whose verdict aged out are read afresh, and a member being added is checked once. (The reference: the owner's `verifyReuseS`, 86,400 s by default; 0 checks every member on every epoch. With it, an owner of 128 members reads nobody when it removes one or rotates, reads one record when it adds one, and reads all 127 at the first epoch after its verdicts age out: about 2,300 HTTP requests and half a minute at the default concurrency, once a day at most, where 1.2.0 did that on every epoch.)

**Messages.** As in §3.4, with the epoch field `ef`, the key `HKDF-SHA256(K, salt = gid ‖ ef, info = "TAP-27/sender/v2" ‖ uint32be(sender), L = 32)` and the signature `Ed25519(members[sender], "TAP-27/msg/v2" ‖ header ‖ ct)`.

**Invite.** The invite of §3.5 with one more member, `"format": 2`, under the same `kind`. A format-1 client that ignores the member joins, then refuses every epoch message of the group, and so can tell its user to update, where an invite of another kind would have been skipped without a word. A client that implements format 2 MUST take the group's format from the invite.

Note (non-normative): an application should check an invite's `format` before it joins: a client without format 2 that joins in silence then refuses every frame of the group, and only an application that looks can tell its user to update first. For the same reason the reference writes a format-2 `snapshot()` with `v: 2` (TapeAPI 1.2.0 wrote `v: 1`, and still reads such snapshots): `resumeGroup` in TapeAPI 1.0.0 to 1.2.0 accepts only `v: 1`, and 1.0.0 and 1.1.0 would otherwise resume a format-2 owner as a format-1 group, whose epoch messages every member refuses.

Note (non-normative): the mark is in the epoch field, not in a `count` of 0 (the other candidate), because one rule then covers both wire types: a format-1 receiver refuses a format-2 group message at the same check as an epoch message, before it looks for a key, and a format-2 receiver tells the format of any frame from its first 25 bytes. A `count` of 0 would mark epoch messages only and would put the real count in another field. Keeping `0x04` keeps epoch messages in the protected ring of relays that know nothing of format 2 (TAPI-26 §3.5).

## 4. Rationale

- **An owner, not consensus.** Agreement among N parties on membership is the hard part of group protocols (MLS spends most of its length on it). One owner who signs every roster is simple, verifiable, and enough for a group someone creates and runs. Its cost is stated in §8.
- **Hidden roster, slots without fingerprints.** TAPI-26 hides who talks to whom from relays. Publishing the member list in clear would undo that for groups, so the roster is encrypted under the epoch key. Slots carry no key fingerprint: channel records are public, so anyone could hash every published key and read membership off the fingerprints. A member instead tries every slot, at the cost of one X25519 and at most 32 AEAD openings.
- **A key commitment in the signed header.** XChaCha20-Poly1305 is not key-committing: a malicious owner could craft one roster ciphertext that opens under two keys. Committing to `K` in the signed header makes every member hold the same key or detect otherwise.
- **Per-sender keys and random nonces.** Every member encrypts under keys derived from one epoch key; separate keys per sender keep the senders apart, and a 24-byte random nonce makes a collision negligible without any counter to save. A nonce built from `seq` would need state that survives restarts: a member that restarted and re-accepted the same epoch would reuse (key, nonce) and reveal the XOR of two plaintexts.
- **Signatures, not MACs.** With a shared key any member could forge another's messages. Ed25519 signatures with each member's published key make the sender verifiable by every member. §8 states what that costs.

## 5. Backwards Compatibility

Adds wire types `0x04` and `0x05` to the TAPI-26 relay and ChannelBus profiles, which already carry any wire message; relays need no change. TAPI-26 channels are unaffected.

Format 2 (§3.8) adds no wire type and changes nothing for format 1: every format-1 receiver refuses its frames, relays need no change (its epoch messages start with `0x04` and stay in the protected ring), and one wire message still carries a whole epoch. An application opts in per group; format 1 stays the default of the reference SDK.

## 6. Test Vectors

`spec/vectors/tapi-27-group.json` fixes every secret and random draw (the epoch key, the ephemeral key, the epoch nonce, each message's random nonce) and the roster's `issued`, and gives an epoch message for three members, the decrypted roster, each member's derived sender key and two signed messages. `spec/vectors/verify.py` recomputes them with X25519, HKDF-SHA256, XChaCha20-Poly1305 and Ed25519 implemented independently from RFC 7748, RFC 5869, the XChaCha draft and RFC 8032.

Format 2 (§3.8): `spec/vectors/tapi-27-group-v2.json`, a separate file so that the format-1 file stays byte for byte as it was, gives the same three members two epochs (the second chained to the first by `prev`), the roster bytes of each, the sender keys and two signed messages. `verify.py` rebuilds them from §3.8 and checks that a format-1 reader refuses every one of them and that a format-2 reader refuses the format-1 epoch message and messages.

## 7. Reference Implementation

`sdk/src/group.js` (`createGroup`, `joinGroup` with `minEpoch`, `resumeGroup`, `openGroupInvite`, `group.snapshot()`, `acceptEpoch`, `addMembers`/`removeMembers`/`rotate`/`inviteFor`, `seal`/`open`), with `api.groupVerifier()` as the member verifier (it checks each member against `api.chain.channelKeys` and caches records for 300 s). Tests: `sdk/test/group.test.mjs` (a group over a ChannelBus alone; a removed member cannot read the next epoch and a new member cannot read the one before; forged, tampered and inconsistent epoch messages and an owner handing out different keys are refused; replayed, reattributed and cross-group messages are refused and gaps reported; previous-epoch messages are refused after ten minutes; size limits) and `sdk/test/audit-group.test.mjs` (adversarial: restarts, rollback, concurrent acceptance, fingerprints linking members, equivocation, small-order keys, stale caches, removed members sending under the old epoch, forged invites).

Format 2 (§3.8, Experimental): `createGroup({ format: 2 })`, `joinGroup` (the format comes from the invite; `verifyMember` and `verifyReuseS` for the lazy checks), `group.format`, `open()` with `verified`, `openVerified`, `verifyMembers`, and `group.channelKeysVerifier(api)`, a verifier for entries without an X25519 key. Tests: `sdk/test/group-v2.test.mjs` (128 members in one message; the released format-1 code and today's format-1 handles refusing format-2 frames with `GROUP_INVALID`; one format per group; lazy checks and verdict reuse; the strict binary roster; the vectors; owner restarts; delivery) and `sdk/test/group-review-grp2.test.mjs` (the owner's verdict reuse; snapshots that released clients refuse; one identity on two devices; why a message has no key).

## 8. Security Considerations

- **Forward secrecy per epoch only.** A leaked epoch key exposes that epoch's messages. Rotate epochs (§3.6).
- **The owner is trusted for membership.** The owner decides who is in the group and can add a member at any time; members see every roster and should show membership changes to their users. The owner cannot impersonate members (messages are signed) and cannot give members different keys (the commitment), but it can split the group into different epochs for different members by withholding epoch messages. There is no owner transfer.
- **Equivocation is detectable.** An owner that signs two different messages for one epoch is caught by any member that sees both (§3.3 step 2), and the two signed messages prove it to anyone who knows the owner's key.
- **Non-repudiation inside a group.** Unlike a TAPI-26 channel, a group message is signed with the sender's published long-term key, so any member can prove to a third party what another member said. Applications that must not create such evidence use TAPI-26 channels.
- **Metadata.** Relays and chain observers see the group id, the room, the number of members (slot count), the sender's index, and the size and time of every message. They do not see containers, keys or content, even if they read every channel record on chain: slots carry no fingerprint (§4).
- **Restarts and the 30-day bound.** A member that does not persist its highest epoch can, after a restart, be rolled back to any epoch message it is shown that is less than 30 days old, including one that still lists a since-removed member (§3.7). The bound relies on members' clocks, and an owner that stops starting epochs stops its group after 30 days.
- **Clocks.** A member MUST refuse a roster whose `issued` is more than 3600 s ahead of its clock or more than 30 days old. The age bound is what stops replays; the future bound only rejects nonsense and MUST NOT be tighter than 3600 s. A sender's `seq` starts at max(clock_ms × 2^16, lastSeq + 1), where `lastSeq` is the persisted value (at least the last `seq` it used). An implementation that persists state SHOULD persist `lastSeq` after sending, so that a clock stepped back across a restart does not make new messages look like replays. Without saved state, a sender whose clock stepped back may have messages refused until the clock passes its previous high. One identity is one device in this version: two devices holding one identity each start `seq` from their own clock, so receivers refuse the messages of whichever device has the lower `seq` as replays or reordering. (The reference does not drop a message signed with its own key that its handle did not seal as its own: `open()` returns it with `otherDevice: true` and the handle records it in `otherDevice`; a refusal for a `seq` already seen says in its data that the cause may be one identity on two devices.)
- **Invites.** A forged invite cannot make anyone join, since it brings no owner-signed epoch, but, as with any invite, it can make a container contact a relay an attacker chose and so expose its IP address to that relay.
- **Stale readers.** A member offline longer than its transports keep data cannot catch up until the owner reposts an epoch message; messages sent in between are lost to it, and the gap is visible.
- **Format 2 (§3.8, Experimental): what it weakens.** (1) *Verdict reuse.* A member may rely on a positive verdict up to 24 hours old (counted from the start of the check that reached it), where format 1 re-reads a record every few minutes. A circuit that is sold, or a record that is removed, can therefore keep its old keys trusted by members for up to 24 hours longer, unless the owner starts an epoch without it first. The owner, too, may rely on its own positive verdict for up to 24 hours when it starts an epoch (§3.8), so such a member can stay in new rosters for as long; an owner that must not allow this checks every member on every epoch (the reference: `verifyReuseS: 0`) or removes the member. A negative verdict lives at most 60 seconds, so a record that looked absent only because a node lagged costs a member at most a minute of refused messages, and a sender whose entry is wrong costs at most one chain read a minute however much it sends. (2) *Lazy checks.* A member accepts an epoch, and sends under its key, before it has checked most entries. An entry that the owner listed with keys that are not in that container's channel record is found only when it is checked, and until then its messages carry an unverified sender. Sender authentication therefore holds for the messages an application shows as verified, and the application MUST show the difference.
- **Format 2: what it keeps.** End-to-end confidentiality (the epoch key is wrapped for each member's key as in format 1), a roster hidden from relays and chain observers (slots without fingerprints, an encrypted roster), sender authentication for verified senders, the key commitment and the detection of an owner that equivocates, a removed member locked out of later epochs, replay and rollback protection (`seq`, the 30-day bound, the persisted minimum epoch) and forward secrecy per epoch. Leaving other members' X25519 keys out of the roster loses nothing: members never used them. Lazy checks also mean that a member asks RPC nodes about the senders it hears from, not about the whole roster, so the nodes learn less of the membership (TAPI-26 §8).

## 9. Copyright

Copyright and related rights waived via [CC0](https://creativecommons.org/publicdomain/zero/1.0/).

---

# TAPI-27：Tape Group：容器之间的私密群聊（中文译文）

> 以英文版为准。章节编号一一对应。

> **不是 TAP。** “TAPI-27”是 TapeAPI 给本文档起的名字，2026-09-30 之前叫“TAP-27”。它不是 TAP：TAP 编号由 [TapeOutProtocol/TAPs](https://github.com/TapeOutProtocol/TAPs) 的编辑按 TAP-01 §6.1 分配。其中部分内容（仅格式 1）已按该流程作为 TAP 草稿提交，在评审中、尚无编号：私密群聊（[PR #20](https://github.com/TapeOutProtocol/TAPs/pull/20)）。提交不等于被采纳，草稿的编号以编辑分配为准。含有旧名字的冻结常量（例如 `TAP-26/…` 标签）是历史常量，永不改变。

> **实现状态（2026-09-27）：** 已实现：`sdk/src/group.js` 可经任一 TAPI-26 传输运行群聊，包括已部署的 ChannelBus（`0x486110c35d9b90a9d6D85c8063A065f9e7b6b707`）与公共中继 `relay.tapeapi.fun`。群聊无需托管服务：群主本身是客户端。未经第三方审计。

> **状态：** Stable (v1)（稳定，第 1 版，见 [TAPI-1](TAPI-1.md) §4.1），自 2026-09-29（TapeAPI 1.0.0）起生效。

> **修订：** 2026-09-30：新增 §3.8 格式 2（至多 128 人），标为 Experimental（实验性），并在 §5 至 §8 加注。格式 1 的文字、线路格式、签名域与错误码均未改动。

本文档中的关键词 "MUST"（必须）、"MUST NOT"（禁止）、"REQUIRED"（必需）、"SHALL"、"SHOULD"（应当）、"SHOULD NOT"（不应）、"RECOMMENDED"（推荐）、"MAY"（可以）、"OPTIONAL"（可选）按 RFC 2119 解释。

## 1. 摘要

Tape Group 是至多 32 个 TapeOut 容器之间的加密会话。其中一个容器是**群主**，负责维护成员名单；每次成员变动都开启一个新的**纪元**，生成新的群密钥，分别密封给每个成员的通道密钥（TAPI-26 §3.1）。消息用由纪元密钥派生的发送者专属密钥加密，并用发送者的 Ed25519 通道密钥签名，因此成员之间能互相读取、却无法互相冒充。成员名单本身也加密传输，承载群密钥的格子也不指向任何人：中继或链上观察者，哪怕读遍链上所有通道记录，也只能得知群号、成员人数以及消息的大小和时间，而不知道成员是谁。传输沿用 TAPI-26：任何中继（TAPI-26 §3.5）或 ChannelBus（TAPI-26 §3.7）。

## 2. 动机

TAPI-26 是两方通道，其三重 DH 握手无法推广到 N 方。需要把多个容器聚在同一会话里的应用，否则只能开 N² 条两两通道，或以明文广播。本规范 给出最小的群组构造：在能保持的地方保持 TAPI-26 的性质（端到端机密、发送者认证、无可信服务器、成员不公开），在保持不了的地方如实写明（§8）。它只定义会话本身：除群主外没有其它角色，也没有应用状态。

## 3. 规范

### 3.1 身份

每个成员（包括群主）都有 TAPI-26 通道身份（TAPI-26 §3.1）：X25519 密钥 `x25519` 与 Ed25519 密钥 `ed25519`，由电路当前持有人授权并发布在容器站点中。客户端在信任名单（§3.3）之前 MUST 对照每个成员的通道记录核验其密钥；名单只是群主对"谁在群里"的陈述，不是任何人密钥的证明。

### 3.2 群号与房间

群主随机生成 16 字节群号 `gid`。所有群消息都发往同一个房间 `SHA-256("TAP-27/room/v1" ‖ gid)`，位于名单所列的中继或 ChannelBus 上。每个成员都在此发送和读取；在收费中继上，每个发送者为自己的消息付费。

### 3.3 纪元消息（线路类型 `0x04`）

群主开启纪元 `n`（首个为 0）：生成 32 字节纪元密钥 `K`、新的 X25519 密钥 `(e, E)` 与 24 字节随机数 `N`，并发送英文部分所列格式的消息。每个成员一格（slot），按成员顺序排列，格内是用由该成员 X25519 公钥派生的 `kek_i` 包裹的 `K`，共 48 字节，不带任何公钥指纹；名单用 `K` 加密；消息头里带 `K` 的承诺；整条消息由群主的 Ed25519 密钥签名。`count` 为 1 到 32。`n` 至多为 2^32 − 1。整条消息 MUST 放得进一条 TAPI-26 线路消息（16,448 字节）。名单对象的格式见英文部分，其中含 `issued`（Unix 秒）。

`members[0]` MUST 是群主。每个成员恰为 `{ container, chainId, x25519, ed25519 }`，`container` 为小写，两把密钥为小写 `0x` 十六进制；接收方 MUST 拒绝任何其它形式，使每个接收方哈希的是同样的字节。`issued` 是群主构造该消息的时间（Unix 秒）。`prev` 是纪元 `n − 1` 名单明文字节按发送原样（即成员解密所得的字节，绝不是重新编码的结果）的 `SHA-256`，写作 64 个小写十六进制字符、不带 `0x`；纪元 0 为 64 个零。`relays` 与 `bus` 遵循 TAPI-26 §3.2 第 1 步。

成员逐条处理纪元消息，其持有的纪元绝不后退。只有在以下各项按顺序全部成立时才接受纪元消息：

1. **群主。** 消息头中的 `gid` 是本群的，且群主的 Ed25519 签名严格验证通过（RFC 8032：拒绝小阶公钥，不采用 ZIP-215 的宽松规则）。群主在群的整个生命周期内固定；其公钥取自它自己的通道记录，按邀请所指明的群主查询（§3.5）。
2. **重复与两面行为。** 若成员已接受过纪元 `n` 的消息，则同一条消息是重复，直接忽略、不报错。群主签名的、同一 `n` 的另一条不同消息，是群主两面行为的证据：成员 MUST 拒绝它并 MUST 报告（参考实现：`GROUP_EQUIVOCATION`，附两条消息去掉签名后的 SHA-256）。参考实现在内存中记住其接受的最新纪元及其下 64 个以内纪元的消息；已不记得的 `n` 在第 3 步被拒。
3. **更新。** `n` 大于成员当前持有的纪元，且不低于成员持久化的最低纪元（§3.7）。
4. **密钥。** 成员只派生一次自己的 `kek`（与 `E` 做一次 X25519），逐格尝试。MUST 恰有一格能打开，且 `SHA-256("TAP-27/commit/v1" ‖ K)` MUST 等于 `commit`。该承诺受群主签名覆盖，正是它阻止群主给不同成员发不同的密钥。
5. **名单。** 名单能解密，能按严格 JSON（TAPI-21 §3.3）解析，`v` 为 1、`kind` 为 `"tape.group/roster"`；其 `gid` 与 `epoch` 与消息头一致；`issued` 为整数，至多超前成员时钟 3600 秒，且不早于 30 天前；`owner` 是群主；成员数恰为 `count`，每个成员都是上述形式，且没有任何容器、`x25519` 或 `ed25519` 出现两次；`members[0]` 是带着群主 Ed25519 公钥的群主；被打开那一格所在位置上的成员就是本成员，且带着自己的密钥；成员持有 `n − 1` 纪元名单时，`prev` 等于该名单的哈希；`relays` 与 `bus` 合法。
6. **通道记录。** 每个成员的 `x25519` 与 `ed25519` 与其 TAPI-26 通道记录一致（按 TAPI-20 §3.2 读取）。记录 MAY 缓存，但至多几分钟（参考实现：300 秒），使电路转手或记录被删除能够生效。确定无效的记录算作不一致；RPC 故障则中止、不作判定，该消息可以再次提交。同一缓存 MAY 用于 TAPI-26 的邀请解析（`invite.from`、`invite.owner`）。只缓存确定的回答（有效记录，或确定无效、不存在的记录）；RPC 故障 MUST NOT 被缓存。群主开启第一个之后的任何纪元时（§3.6）SHOULD 重新读取每条记录而不是用缓存，因为过期的记录会让已出售的成员再留一整个纪元；第一个纪元 MAY 使用群主刚刚解析过的记录。

成员安装新纪元时，为仍在途中的消息把此前持有的纪元保留 10 分钟，更早的纪元一律丢弃。在这一上一纪元下，成员 MUST 拒绝两类消息：来自不在新名单中的发送者的消息，以及已有一条新纪元消息被接受的发送者的消息。

### 3.4 消息（线路类型 `0x05`）

格式见英文部分：消息头为 `0x05 ‖ gid ‖ uint64be(epoch) ‖ uint32be(sender) ‖ uint64be(seq) ‖ nonce(24)`，密文用发送者密钥、以 `nonce` 和消息头为附加数据加密，签名覆盖 `"TAP-27/msg/v1" ‖ 消息头 ‖ 密文`。`sender` 是发送者在名单中的位置。`nonce` 是每条消息新抽取的 24 个随机字节，因此丢失状态的发送者也绝不会重复使用。`seq` 在每个纪元内对每个发送者严格递增：发送者每次安装纪元或重启时，从自己的时钟（Unix 毫秒 × 2^16）起算，每条消息加一，因此无需保存任何状态。接收方 MUST 在做任何其它事之前，用该纪元名单中 `members[sender]` 的 Ed25519 公钥验证签名，自己发出的消息也不例外，然后忽略自己的消息。接收方 MUST 拒绝不大于已从该发送者在该纪元接受的最大 `seq` 的消息，MUST 接受空洞并 SHOULD 报告（TAPI-26 §3.4）：`seq − high − 1` 小于 2^16 时报告该值，否则报告为未知（发送者重启过）。明文 MUST NOT 超过 16,000 字节。

### 3.5 入群

群主向被邀请容器的收件房间投递一份密封邀请（TAPI-26 §3.2，线路类型 `0x03`，内容格式见英文部分），然后发出一条包含新成员的纪元消息。邀请只被用来得知"去哪里看"：成员自行查询群主的通道记录，并只接受群主签名的纪元消息，因此伪造的邀请不能让任何人入群。接受某个纪元之后，成员改用名单里（群主签过的）`relays` 与 `bus`，而不是邀请里的。群主 SHOULD 在邀请新成员时、并至少以传输层遗忘数据的频率重发当前纪元消息（RECOMMENDED：经公共节点读取的 ChannelBus 上每 30 分钟一次，公共节点视后端约保留 5,000 到 10,000 个区块的日志，在 BSC 上约 40 到 75 分钟；房间寿命 15 分钟的中继上每 10 分钟一次），使长时间离开后返回的成员能够追上；新的纪元消息是本规范 唯一的检查点。（30 分钟这一数字按 TAPI-26 §3.7 中实测的最短窗口计算；保留历史长得多的节点，例如该节 2026-09-27 实测的那些，可以容忍更长的间隔。）在 ChannelBus 上每次重发是一笔至多 16,448 字节调用数据的交易（约 420,000 gas）。

注（非规范性）：邀请与纪元消息投往不同的房间。邀请投往新成员的收件房间（TAPI-26 §3.2），它由成员的容器地址与 chainId 推导，而不是由持有其电路的钱包推导；纪元消息投往群房间（§3.2）。群主若只投纪元消息，新成员就无从读起，因为成员是从邀请得知群房间的。读取方若沿用别的房间的游标，或丢掉中继的房间纪元（TAPI-26 §3.5），可能跳过序号 0 的邀请。参考 SDK 用一次调用投递两者（`deliverGroupUpdate`），并以按房间保存、带房间纪元的游标读取收件房间（`checkGroupInvites`）。

### 3.6 成员变动

移除成员时，以及至少每 30 天（更早的纪元消息会被拒绝，§3.3），群主 MUST 开启新纪元；新增成员时以及定期（RECOMMENDED：活跃的群至少每天一次）SHOULD 开启。群主每次开启纪元都重新对照通道记录核验全部成员（§3.3 第 6 步）：记录确定无效的成员（电路已转手、记录已删除）从新名单中移除并予以报告；RPC 故障则中止这次新纪元。被移除的成员保留它已有的全部密钥，能读到移除它的那个纪元之前的所有内容，读不到之后的任何内容。新成员读不到加入它的那个纪元之前的任何内容。本版本不支持转让群主：需要新群主的群就是一个新群。

### 3.7 状态与重启

本规范 的安全性不依赖任何保存的状态：随机数是随机的，`seq` 从时钟起算。但仍有两样东西值得保存：

- 成员 SHOULD 持久化它接受过的最高纪元，并在重启后把它作为最低纪元传入（§3.3 第 3 步）。否则中继可以在 `issued` 的 30 天界限内，重放一条仍列有已被移除成员的旧纪元消息，重启后的成员就会用那个成员也持有的密钥发送消息。
- 群主持久化名单（其中不含任何秘密），重启后立即开启下一纪元，因为上一纪元的密钥已经不在了。

参考实现：`group.snapshot()` 返回要保存的内容，`resumeGroup` 据此让群主重启，`joinGroup({ minEpoch })` 让成员重启。

### 3.8 格式 2：至多 128 人（Experimental，实验性）

> **Experimental（实验性）**（TAPI-1 §4.1"冻结"第 3 项）。本节不在 Stable (v1) 的冻结范围内：可能发生不兼容的变化或被撤回，本文档其余部分都不依赖它。§3.1 至 §3.7 定义格式 1，本节不改动它们。实验阶段以一节而不是独立文档的形式出现，是因为它与格式 1 共用 §3.1 至 §3.7 和 §4，两份副本、两种语言迟早会走样；准备进入稳定状态时，它将移入独立文档（TAPI-1 §4.1"不兼容变更与并存"）。

格式 2 让一条线路消息承载至多 128 名成员，并把 §3.3 第 6 步改为惰性核验。本节未改动的一切与格式 1 相同：身份（§3.1）、群房间（§3.2）、§3.3 第 1 至 4 步及其末尾关于上一纪元的规则、消息（§3.4）、入群（§3.5）、成员变动（§3.6）与状态（§3.7）。

**格式标记。** 格式 2 沿用线路类型 `0x04` 与 `0x05`，两者的 8 字节纪元字段都写作 `ef = uint32be(0x54470200) ‖ uint32be(n)`。格式 1 要求该字段不超过 2^32 − 1（§3.3），因此任何格式 1 接收方都会拒收任何格式 2 的纪元消息与群消息；同时实现两种格式的接收方读取该字段的高半部分：0 为格式 1，`0x54470200` 为格式 2，其它值一律拒收。一个群终生只用一种格式：接收方 MUST 拒收格式与本群不同的帧，且不改变任何状态。格式 1 实现仅凭 §3.3 与 §3.4 即会拒收格式 2 的帧；参考实现（TapeAPI 1.1.0 及以后）报告为 `GROUP_INVALID`，认识格式 2 的参考实现句柄遇到另一格式的帧时同样报告 `GROUP_INVALID`，并在 `data.format` 中写明该帧的格式。

**纪元消息。** 格式见英文部分：消息头为 `0x04 ‖ gid ‖ ef ‖ E ‖ N ‖ commit ‖ uint16be(count)`，承诺、包裹与签名分别使用标签 `"TAP-27/commit/v2"`、`"TAP-27/wrap/v2"`（`info` 中用 `ef` 代替格式 1 的 `uint64be(n)`）与 `"TAP-27/epoch/v2"`；名单为二进制 `rosterBytes`：`"TGR2" ‖ uint64be(issued) ‖ prev(32) ‖ uint16be(count)`，接着每个成员 `container(20) ‖ uint32be(chainId) ‖ ed25519(32)`，最后是 `uint16be(L) ‖ tail(L)`，其中 `tail = UTF-8(canonicalJSON({ relays, bus? }))`。

`count` 为 1 到 128，条目按成员顺序排列，群主在前。成员的 `chainId` 至多为 2^32 − 1，因为条目只用 4 字节存放它。`prev` 是纪元 `n − 1` 名单字节按发送原样的 SHA-256，纪元 0 为 32 个零字节。`relays` 与 `bus` 与格式 1 相同，每个中继恰为 `{ url, container }`。名单不含任何成员的 X25519 公钥：只有群主要用它们来包裹格子，而成员自己那一格能打开，就是对自己公钥的核对。每名成员在线路上占 104 字节（48 字节格子加 56 字节条目），格式 1 约为 277 字节。

成员按 §3.3 第 1 至 5 步接受格式 2 纪元消息，其中以上述标签代替格式 1 的标签，第 5 步改读为：名单能解密，且 MUST 严格解析（长度精确；`count` 与消息头一致；尾部是恰含 `relays`、可选含 `bus` 的规范 JSON；每个 `ed25519` 都是 Ed25519 曲线上的点且不是小阶点；没有任何容器或 `ed25519` 出现两次）；`issued` 在第 5 步的界限之内；第一个条目是带着群主 Ed25519 公钥的群主；被打开那一格所在位置上的条目是本成员且带着自己的 Ed25519 公钥；`prev` 按第 5 步接续。参考实现对格式 2 名单的每一种拒收（中继与总线也不例外）都报告为 `GROUP_INVALID`。

**大小。** 整条消息 MUST 放得进一条 TAPI-26 线路消息（16,448 字节）。128 是在名单允许的最坏情况下仍放得下的最大的 2 的幂：4 个 URL 各长 512 字符的中继加上 bus，使 `tail` 达到 2,383 字节，此时还能容纳 132 人。只有一个常见长度的中继时，一条消息可容纳 154 人。

**惰性的第 6 步。** 格式 2 用以下规则代替 §3.3 第 6 步。

- 接受消息之前，成员对照群主的通道记录核验群主条目，除非它持有该条目一致的可复用结论。确定不符则拒收该消息；RPC 故障则中止、不作判定，与格式 1 相同。
- 其余条目惰性核验。在确认条目 `i` 的 `ed25519` 与该成员的通道记录一致之前，成员 MUST NOT 把消息作为经过认证的、来自条目 `i` 的消息展示；在此之前它 MAY 展示该消息，但须标明发送者未经核验。它 SHOULD 在发送者的消息到达时核验该发送者，并 MAY 在后台核验其余条目。
- 记录确定不符的条目视同不在名单中：成员 MUST 拒收其消息，并 SHOULD 报告这一不符。RPC 故障不作任何判定，稍后重新核验。
- 结论针对的是一个条目 `(chainId, container, ed25519)`。条目一致的结论 MAY 跨纪元复用，但自得出该结论的核验开始起至多 24 小时（参考实现：`verifyReuseS`，默认与上限均为 86,400 秒；应用 MAY 设得更短）。条目不符的结论 MUST NOT 复用超过 60 秒，也不得用来拒收纪元消息，并且 SHOULD 基于未经任何缓存作答的读取：记录可能只因节点落后或缓存过时而看似不存在，更长的否定结论会让该成员噤声（参考实现：`VERIFY_NEGATIVE_S`，60 秒；"否"在算数之前会绕过客户端身份缓存再读一次）。RPC 故障不是结论。发生变化的条目就是新条目，之前的任何结论都不覆盖它。
- 群主一侧：每次开启纪元，它都对照重新读取的通道记录核验每个成员的两把公钥（§3.6），但对未变化的条目（对群主而言条目包含 X25519 公钥，因为它核验两把公钥），它 MAY 依赖自己得出的肯定结论，期限同为自得出该结论的核验开始起 24 小时。依赖结论不会让它续期。新条目、变化了的条目以及结论已过期的条目都重新读取，正在加入的成员只核验一次。（参考实现：群主的 `verifyReuseS`，默认 86,400 秒；设为 0 则每个纪元都核验全部成员。据此，128 人群的群主移除一人或轮换时不读取任何记录，加一人时读取一条，结论过期后的第一个纪元读取全部 127 条：按默认并发约 2,300 个 HTTP 请求、约半分钟，至多每天一次；1.2.0 在每个纪元都要这样做。）

**消息。** 与 §3.4 相同，只是纪元字段为 `ef`，密钥为 `HKDF-SHA256(K, salt = gid ‖ ef, info = "TAP-27/sender/v2" ‖ uint32be(sender), L = 32)`，签名为 `Ed25519(members[sender], "TAP-27/msg/v2" ‖ 消息头 ‖ 密文)`。

**邀请。** 即 §3.5 的邀请，在同一 `kind` 下多一个成员 `"format": 2`。忽略该成员的格式 1 客户端会入群，随后拒收该群的每一条纪元消息，因而能提示用户升级；换成另一种 `kind` 的邀请，则会被它一声不响地跳过。实现了格式 2 的客户端 MUST 从邀请中取得群的格式。

注（非规范性）：应用应在入群前检查邀请的 `format`：不支持格式 2 的客户端会一声不响地入群，随后拒收该群的每一帧，只有做了检查的应用才能先提示用户升级。出于同样的原因，参考实现把格式 2 的 `snapshot()` 写为 `v: 2`（TapeAPI 1.2.0 写的是 `v: 1`，这样的快照仍可读取）：TapeAPI 1.0.0 至 1.2.0 的 `resumeGroup` 只接受 `v: 1`，否则 1.0.0 与 1.1.0 会把格式 2 的群主恢复成格式 1 的群，其纪元消息所有成员都会拒收。

注（非规范性）：标记放在纪元字段里，而不是令 `count` 为 0（另一候选方案），因为这样一条规则就覆盖两种线路类型：格式 1 接收方在查找密钥之前，就在与纪元消息相同的检查处拒收格式 2 的群消息；格式 2 接收方凭前 25 个字节即可判断任何一帧的格式。`count` 为 0 只能标记纪元消息，还得把真实人数放进另一个字段。沿用 `0x04`，纪元消息在不认识格式 2 的中继上也仍进入受保护环（TAPI-26 §3.5）。

## 4. 原理

- **群主，而非共识。** N 方就成员名单达成一致是群组协议最难的部分（MLS 的大部分篇幅都在讲这个）。由一个群主签署每份名单，简单、可验证，对"有人创建并运营"的群足够。其代价见 §8。
- **名单不公开，格子不带指纹。** TAPI-26 对中继隐藏谁在和谁通信。明文公布成员名单会让群聊失去这一性质，因此名单用纪元密钥加密。格子不带公钥指纹：通道记录是公开的，任何人都能哈希每一把已发布的公钥，再按指纹读出成员名单。成员改为逐格尝试，代价是一次 X25519 与至多 32 次 AEAD 解密。
- **签名的消息头里放密钥承诺。** XChaCha20-Poly1305 不具备密钥承诺性：恶意群主可以构造一份在两把密钥下都能打开的名单密文。在签名的消息头里承诺 `K`，使每个成员要么持有同一把密钥，要么能察觉不同。
- **发送者专属密钥与随机 nonce。** 所有成员都用由同一纪元密钥派生的密钥加密；每个发送者一把独立密钥，把发送者彼此隔开，24 字节的随机 nonce 使碰撞概率可以忽略，而且无需保存任何计数器。由 `seq` 构造的 nonce 需要能跨重启保存的状态：重启后再次接受同一纪元的成员会重用（密钥，nonce），泄露两段明文的异或。
- **签名，而非 MAC。** 共享密钥下任何成员都能伪造他人的消息。用每个成员公开的 Ed25519 密钥签名，使每个成员都能验证发送者。其代价见 §8。

## 5. 向后兼容

为 TAPI-26 的中继与 ChannelBus 配置新增线路类型 `0x04` 与 `0x05`，二者本就能承载任意线路消息，中继无需改动。TAPI-26 通道不受影响。

格式 2（§3.8）不新增线路类型，对格式 1 也毫无改动：任何格式 1 接收方都会拒收它的帧；中继无需改动（其纪元消息以 `0x04` 开头，仍进入受保护环）；一条线路消息仍承载一整个纪元。应用按群选择启用；参考 SDK 的默认仍是格式 1。

## 6. 测试向量

`spec/vectors/tapi-27-group.json` 固定所有私钥与随机抽取（纪元密钥、临时密钥、纪元随机数、每条消息的随机 nonce）以及名单的 `issued`，给出三名成员的纪元消息、解密后的名单、每个成员派生的发送者密钥以及两条已签名消息。`spec/vectors/verify.py` 用按 RFC 7748、RFC 5869、XChaCha 草案与 RFC 8032 独立实现的 X25519、HKDF-SHA256、XChaCha20-Poly1305 与 Ed25519 重新计算全部数值。

格式 2（§3.8）：`spec/vectors/tapi-27-group-v2.json`（单独成文件，使格式 1 的文件逐字节保持原样）为同样三名成员给出两个纪元（第二个经 `prev` 接续第一个）、各自的名单字节、发送者密钥与两条已签名消息。`verify.py` 按 §3.8 重建它们，并核对格式 1 读者会拒收其中每一条、格式 2 读者会拒收格式 1 的纪元消息与消息。

## 7. 参考实现

`sdk/src/group.js`（`createGroup`、带 `minEpoch` 的 `joinGroup`、`resumeGroup`、`openGroupInvite`、`group.snapshot()`、`acceptEpoch`、`addMembers`/`removeMembers`/`rotate`/`inviteFor`、`seal`/`open`），以 `api.groupVerifier()` 作为成员核验器（它对照 `api.chain.channelKeys` 核验每个成员，记录缓存 300 秒）。测试：`sdk/test/group.test.mjs`（只经 ChannelBus 的群聊；被移除的成员读不到下一纪元，新成员读不到加入前的纪元；伪造、篡改、自相矛盾的纪元消息以及给成员发不同密钥的群主一律被拒；被重放、被改署名或被挪到别的群的消息被拒，空洞被报告；上一纪元的消息十分钟后被拒；大小上限）与 `sdk/test/audit-group.test.mjs`（对抗性测试：重启、回滚、并发接受、指纹暴露成员、两面行为、小阶公钥、过期缓存、被移除成员在旧纪元下发消息、伪造邀请）。

格式 2（§3.8，实验性）：`createGroup({ format: 2 })`、`joinGroup`（格式取自邀请；惰性核验用 `verifyMember` 与 `verifyReuseS`）、`group.format`、带 `verified` 的 `open()`、`openVerified`、`verifyMembers`，以及 `group.channelKeysVerifier(api)`（适用于不带 X25519 公钥的条目的核验器）。测试：`sdk/test/group-v2.test.mjs`（一条消息容纳 128 人；已发布的格式 1 代码与今天的格式 1 句柄以 `GROUP_INVALID` 拒收格式 2 的帧；一个群只用一种格式；惰性核验与结论复用；严格的二进制名单；测试向量；群主重启；投递）与 `sdk/test/group-review-grp2.test.mjs`（群主复用结论；已发布客户端会拒收的快照；同一身份两台设备；消息为何没有密钥）。

## 8. 安全考量

- **前向保密只到纪元粒度。** 泄露的纪元密钥会暴露该纪元的消息。应轮换纪元（§3.6）。
- **成员资格信任群主。** 群主决定谁在群里，并可随时加人；成员能看到每份名单，应把成员变动展示给用户。群主无法冒充成员（消息有签名），也无法给成员发不同的密钥（承诺），但可以通过扣留纪元消息让不同成员停留在不同纪元。不支持转让群主。
- **两面行为可被察觉。** 群主为同一纪元签了两条不同消息，看到这两条消息的任何成员都能发现（§3.3 第 2 步），而这两条签名消息可以向任何知道群主公钥的人证明这一点。
- **群内不可否认。** 与 TAPI-26 通道不同，群消息用发送者公开的长期密钥签名，因此任何成员都能向第三方证明另一成员说过什么。不能产生这种证据的应用应使用 TAPI-26 通道。
- **元数据。** 中继与链上观察者能看到群号、房间、成员人数（格数）、发送者序号以及每条消息的大小与时间；即使读遍链上所有通道记录，也看不到容器、密钥或内容：格子不带指纹（§4）。
- **重启与 30 天界限。** 不持久化最高纪元的成员，重启后可能被回滚到别人给它看的、不满 30 天的任何纪元消息，包括仍列有已被移除成员的那一条（§3.7）。该界限依赖成员的时钟；不再开启新纪元的群主，其群在 30 天后停止工作。
- **时钟。** 成员 MUST 拒绝 `issued` 超前本方时钟 3600 秒以上、或早于 30 天前的名单。挡住重放的是年龄界限；超前界限只拦荒谬值，MUST NOT 严于 3600 秒。发送者的 `seq` 从 max(时钟毫秒 × 2^16, lastSeq + 1) 起算，`lastSeq` 为保存的值（不小于最后用过的 `seq`）。保存状态的实现 SHOULD 在发送后保存 `lastSeq`，这样重启前后时钟回拨也不会让新消息看起来像重放。不保存状态时，时钟回拨的发送者的消息可能被拒，直到时钟越过它之前的最大值。本版本中一个身份对应一台设备：持有同一身份的两台设备各自从自己的时钟起算 `seq`，接收方会把 `seq` 较低的那台设备的消息当作重放或乱序而拒收。（参考实现不会把用本身份签名、却不是本句柄封装的消息当作自己的消息丢弃：`open()` 返回它并带 `otherDevice: true`，句柄在 `otherDevice` 中记录；因 `seq` 已见过而拒收时，错误的 data 会说明原因可能是同一身份在两台设备上。）
- **邀请。** 伪造的邀请不能让任何人入群，因为它带不来群主签名的纪元；但和任何邀请一样，它能让容器去连接攻击者选定的中继，从而把自己的 IP 地址暴露给该中继。
- **滞后的读者。** 离线时间超过传输层数据保留期的成员，在群主重发纪元消息之前无法追上；其间发出的消息对它丢失，空洞可见。
- **格式 2（§3.8，实验性）削弱了什么。** （1）*结论复用。* 成员可以依赖至多 24 小时前（自得出结论的核验开始时起算）的肯定结论，而格式 1 每隔几分钟就重新读取记录。因此，已出售的电路或已删除的记录，其旧公钥被成员信任的时间最多可再长 24 小时，除非群主先开启一个不含它的纪元。群主开启纪元时同样可以依赖自己至多 24 小时前的肯定结论（§3.8），因此这样的成员在新名单里也可能停留同样长的时间；不能接受这一点的群主应在每个纪元都核验全部成员（参考实现：`verifyReuseS: 0`），或直接移除该成员。否定结论至多保留 60 秒：记录只因节点落后而看似不存在时，成员至多有一分钟拒收该成员的消息；条目有误的发送者无论发多少消息，每分钟至多引起一次链上读取。（2）*惰性核验。* 成员在核验大多数条目之前就接受纪元，并用其密钥发送消息。群主所列公钥不在该容器通道记录中的条目，只有在被核验时才会被发现，在此之前其消息的发送者都是"未核验"。因此发送者认证只对应用标为已核验的消息成立，应用 MUST 把两者区分展示。
- **格式 2 保持了什么。** 端到端机密性（纪元密钥与格式 1 一样逐一包裹给每个成员的公钥）、对中继与链上观察者隐藏的名单（不带指纹的格子、加密的名单）、对已核验发送者的发送者认证、密钥承诺及对群主两面行为的察觉、被移除成员读不到之后的纪元、防重放与防回滚（`seq`、30 天界限、持久化的最低纪元），以及纪元粒度的前向保密。名单里去掉其他成员的 X25519 公钥不损失任何性质：成员从来不用它们。惰性核验还意味着成员只向 RPC 节点查询它听到的发送者，而不是整份名单，节点因此对成员构成知道得更少（TAPI-26 §8）。

## 9. 版权

著作权及相关权利依 [CC0](https://creativecommons.org/publicdomain/zero/1.0/) 放弃。
