| TAPI | 28 |
|---|---|
| Title | Visitor Grants between Container Apps |
| Author | Bruce (@BruceLanLan) |
| Status | Experimental (TAPI-1 §4.1): not a TAP; may change in any minor release |
| Implementation | Prototype since 2026-10-21 (first an SDK subpath on the 2.5 development line, a package of its own on the 3.0 line): the experimental package `@tapeapi/interop` (`interop/src/interop-sig.js`, `interop/src/interop-verify.js`, `interop/src/interop-call.js`) and the experimental `ctx.request`, `ctx.onSigned` and `ctx.resend` of `@tapeapi/server`. Not in any released package. No service accepts grants. No third-party audit. Where this text and that code differ, the code is right and this text is wrong. |
| Type | Standards |
| Created | 2026-10-21 |
| Requires | TAPI-20, TAPI-21 |
| License | CC0-1.0 |

# TAPI-28: Visitor Grants between Container Apps

> English is authoritative. 中文译文见下半部分，章节编号一一对应。

> **Not a TAP; experimental; may change in any minor release.** "TAPI-28" is TapeAPI's own name for this document, not a TAP number. No TAP defines this format today, no service knows it, and it is outside the compatibility promise: any minor release may change it or remove it. It describes the prototype so that an independent implementer can check grants on the called side and get the same answers as the reference code.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

## 1. Abstract

A visitor grant lets a visitor's wallet allow one TapeOut app (the caller, A) to call a few named methods of another app's TapeAPI service (the audience, B) on the visitor's behalf, for a short time and a bounded number of calls, with no payment. The visitor signs one EIP-712 message, `VisitorGrant`, in a domain of its own. A sends it with every request as a top-level member `grant`, together with a call proof signed by a one-off key named in the grant. B checks it in a fixed order, counts it, takes revocations (`GrantRevocation`, through the free method `grant_revoke`) and writes a grant record into its signed answer (TAPI-21). This document defines the types, their hashing, the statement the visitor reads, the wire form, the call proof, B's checks and their refusals, and the test vectors.

## 2. Motivation

Two apps on TapeOut can already call each other's services (TAPI-20, TAPI-21), but a service that returns a visitor's own data has no way to know that the visitor wanted another app to read it. A login or an account would be a new credential. A grant is narrower: it names both apps, the methods, a count and a time window, it says in words that it includes no payment, and the called service enforces it and can be told to stop.

## 3. Specification

### 3.1 Terms

- **Visitor** (`user`): the wallet address that signs the grant and any revocation. An externally owned account, or a contract wallet that answers EIP-1271.
- **Caller** (A): the app that sends requests on the visitor's behalf. `caller` is its container, `callerName` its TapeOut name, `callerHolder` its holder.
- **Audience** (B): the service that receives the requests. `audience` is its container, `audienceName` its TapeOut name, `audienceHolder` its holder.
- **Caller key** (`callerKey`): a one-off secp256k1 key that A creates for the grant and keeps; it signs the call proof of every request.
- **Hub**: the DeWEB hub contract of the audience's chain, as TAPI-20 uses it.
- A **TapeOut name** is the canonical on-chain name of TAP-10 §3.1, written exactly in that form: `<#ID>.<processor>.tape`, or `<#ID>.<area>.<processor>.tape` on a chain with an area code (for example `4246.0.tape`). A name in any other spelling MUST be refused.

### 3.2 Domain

Both types are signed under one EIP-712 domain of their own:

```
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
name              = "TapeAPI Visitor Grant"
version           = "1"
chainId           = the chain id of the audience's chain
verifyingContract = the DeWEB hub of that chain
```

The domain MUST NOT be the TAP-11 domain (name `"TapeAPI"`), and no type of this document is ever signed under another domain. The same grant on another chain or under another hub has another hash (vector `otherChain`).

### 3.3 Types

The type strings are EIP-712 `encodeType` strings, with no spaces and no line breaks:

```
VisitorGrant(string statement,address user,address caller,string callerName,address callerHolder,address callerKey,address audience,string audienceName,address audienceHolder,string[] methods,uint32 maxCalls,uint64 notBefore,uint64 expires,bytes32 nonce)
GrantRevocation(address user,bytes32[] grantHashes,uint64 revokedBefore,uint64 issued)
```

| Type | Type hash |
|---|---|
| `VisitorGrant` | `0xbc95bd5b4977cb089511e2e459636a0c22d7d0d29280f72043963456ac3e8f0e` |
| `GrantRevocation` | `0x065cffa2962afb3c14827c4d10da27f7f6992c32837f9748a7046963335f03f5` |

`VisitorGrant` members:

| Member | Wire type | Rule |
|---|---|---|
| `statement` | string | At most 2,048 characters; exactly one of the renderings of §3.4. |
| `user` | address | The visitor. |
| `caller` | address | A's container, read from the chain by A (never taken from a request). |
| `callerName` | string | A's TapeOut name (§3.1). |
| `callerHolder` | address | A's holder when the grant was made, read from the chain. |
| `callerKey` | address | The address of the caller key. REQUIRED; MUST NOT equal `user`. |
| `audience` | address | B's container. |
| `audienceName` | string | B's TapeOut name (§3.1). |
| `audienceHolder` | address | B's holder when the grant was made, read from the chain. |
| `methods` | string[] | 1 to 8 method names, each matching `^[A-Za-z_][A-Za-z0-9_]{0,63}$`, no repeats. Order is significant. |
| `maxCalls` | uint32 | A JSON integer from 1 to 10,000. |
| `notBefore` | uint64 | Unix seconds, a JSON integer from 0 to 253,402,300,799 (9999-12-31 23:59:59 UTC). |
| `expires` | uint64 | Same range; `expires > notBefore` and `expires − notBefore ≤ 604,800` (7 days). |
| `nonce` | bytes32 | `0x` and 64 lower-case hex digits, not all zero; random. |

`GrantRevocation` members: `user` (address), `grantHashes` (an array of at most 24 grant hashes, §3.5, each `0x` and 64 lower-case hex digits, not zero), `revokedBefore` and `issued` (Unix seconds in the range above). A revocation MUST list at least one hash or set `revokedBefore` above 0.

Addresses on the wire are `0x` and 40 hex digits in any case, never the zero address; they are compared without regard to case. Hex digits of `bytes32` values MUST be lower case: an upper-case digit is malformed, never folded. A message received from someone else MUST have exactly the members listed (14 for a grant, 4 for a revocation): a member more or less is malformed.

### 3.4 The statement

The statement is generated from the other members; it is never free text. Version 1 has two templates, and a grant's `statement` MUST be, character for character, one of them applied to its own members:

```
en: Allow {callerName} to call these methods of {audienceName} on my behalf: {methods}. At most {maxCalls} call{s}, valid from {notBefore} to {expires} UTC. This grant includes no payment. Revocable at any time with {audienceName}.
zh: 允许 {callerName} 代表我调用 {audienceName} 的方法：{methods}。最多 {maxCalls} 次，{notBefore} 至 {expires} UTC 有效。本授权不含任何付款。可随时向 {audienceName} 撤销。
```

- `{methods}` is the method names in grant order, joined with `", "` (comma, space).
- `{maxCalls}` is the decimal integer with no separators. `{s}` is empty when `maxCalls` is 1 and `s` otherwise (English only).
- `{notBefore}` and `{expires}` are the times in UTC as `YYYY-MM-DD HH:MM:SS` (four-digit year, 24-hour clock, to the second).
- The Chinese template uses the full-width colon `：`, the ideographic full stop `。` and the full-width comma `，` exactly as shown.

The statement names no address and no key. A change of wording is a new format version (`v`), never an edit of version 1. Vectors: `grants[].statements`.

### 3.5 Hashing

`hashStruct` is that of EIP-712, with the members in the order of the type string: a `string` is `keccak256` of its UTF-8 bytes; `string[]` is `keccak256` of the concatenation of `keccak256(utf8(element))` for each element in order; `bytes32[]` is `keccak256` of the concatenation of the 32-byte values in order (an empty list hashes the empty string); an address is left-padded to 32 bytes; `uint32` and `uint64` are 32-byte big-endian.

```
grantHash = keccak256(0x19 ‖ 0x01 ‖ domainSeparator ‖ hashStruct(VisitorGrant))
```

The **grant hash** is the full typed digest, domain included. It is the 32 bytes the visitor's wallet signs (`eth_signTypedData_v4`, no further prefix) and the grant's identity everywhere below, written as `0x` and 64 lower-case hex digits. The revocation digest is formed in the same way from `hashStruct(GrantRevocation)`. Vectors: `methodsHash`, `structHash`, `digest`, `userSig`.

The wallet payload is `{ domain, types: { EIP712Domain, VisitorGrant }, primaryType: "VisitorGrant", message }`, with `statement` the first member, so that a wallet that shows members in order shows the sentence first. A page SHOULD rebuild the payload from the members and compare it before handing it to the wallet, and SHOULD refuse a message whose statement is not a rendering of its members.

### 3.6 Validity window

At B's clock `now` (Unix seconds), a grant is valid when `now + 300 ≥ notBefore` and `now < expires`. A builder SHOULD NOT make a grant whose `notBefore` lies more than 300 s ahead of its own clock. The informative default life is 3,600 s; the maximum is 604,800 s (§3.3).

### 3.7 Scope rules

- A grant names methods only. No wildcard can be written (`*` is not a method name) and no unlimited count can be written (`maxCalls` is at most 10,000).
- A method takes grants when its descriptor in B's manifest (TAPI-20) carries the member `grant` with the value `"required"` or `"optional"`; any other value is a manifest error. `"required"`: a request without a grant is refused (`required`). `"optional"`: such a request runs as it would without this document.
- Every method listed in a grant MUST be a method of B's manifest that takes grants, and the called method MUST be one of them.
- **No money.** A method that takes grants MUST be free (`priceBEM` `"0"`), no type of this document has an amount, a token or a fee, and a request that carries a grant MUST NOT carry a TAPI-22 `voucher` (`voucher-not-allowed`).
- A method SHOULD take grants only when it returns the visitor's own data. A program cannot check this; it is the operator's choice.

### 3.8 The request member `grant`

A grant travels as a top-level member of the TAPI-21 §3.1 request body, beside `id`, `method` and `params`:

```json
{ "id": "g-…", "method": "history", "params": { },
  "grant": { "v": 1, "chainId": 56,
             "message": { "statement": "…", "user": "0x…", "…": "the 14 members of §3.3" },
             "userSig": "0x…",
             "proof": { "ts": 1791000007, "sig": "0x…" } } }
```

- `grant` has exactly the members `v`, `chainId`, `message`, `userSig`, `proof`. `v` is the integer `1`. `chainId` is a JSON integer and MUST equal B's chain id.
- `userSig` is `0x` and 65 to 1,024 bytes as hex: the visitor's signature over the grant hash.
- `proof` has exactly `ts` (a non-negative JSON integer, Unix seconds) and `sig` (`0x` and 65 bytes as hex).
- The request `id` MUST be a string of 1 to 128 characters (TAPI-21 §3.1), well-formed Unicode (a lone UTF-16 surrogate has no UTF-8 form: a proof over such an id is `bad-proof`); a fresh random id per call is RECOMMENDED.
- A MUST send the member only to an endpoint listed in B's manifest (`endpoints.live`). The TAPI-21 response digest covers `{ method, params }` and not this member; the answer is bound to the grant by the grant record (§3.11).

### 3.9 The call proof

The caller key signs every request:

```
preimage = "TAPI-grant/call1"                                    // 16 ASCII bytes
         ‖ audience                                              // 20 bytes
         ‖ grantHash                                             // 32 bytes
         ‖ keccak256(utf8(id))                                   // 32 bytes
         ‖ keccak256(utf8(canonicalJSON({ method, params })))    // 32 bytes; params {} when absent
         ‖ uint64BE(ts)                                          // 8 bytes
                                                                 // 140 bytes in all
sig = secp256k1 EIP-191 personal_sign over keccak256(preimage), as TAPI-21 §3.3 signs its digest
```

`canonicalJSON` is that of TAPI-21 §3.3. `method` is the method being called and `params` the request's `params` as B parses them. The signature MUST be 65 bytes with `v` 27 or 28 (0 and 1 are refused) and low `s` (`s ≤ n/2`). The prefix and the length differ from those of TAPI-21's `"TAPI-1/resp/v2"` digest, so a call proof is never an answer signature nor the reverse. A retry of the same `id` carries a new proof with a new `ts`. Vectors: `proofs[]` (`preimage`, `digest`, `personalDigest`, `sig`).

### 3.10 B's checks

For a request with a `grant` member, B MUST apply these checks in this order; the first that fails stops, and B answers the refusal of §3.12 with the reason shown. Cheap checks come first; chain reads come last.

1. **Shape** (`malformed`): §3.8 and §3.3, `v` = 1, `chainId` = B's chain, the message exactly 14 members within their rules, `userSig` of the right shape, `proof` with exactly `ts` (a non-negative integer) and `sig` (a string; its length and form are checked at step 6, where a bad one is `bad-proof`).
2. **Audience** (`wrong-audience`): `audience` equals B's own container and `audienceName` equals B's own TapeOut name, compared as they are (no chain read).
3. **Methods** (`method-out-of-scope`): the called method is in `methods` and takes grants in B's manifest, and every method in `methods` takes grants in B's manifest.
4. **Window** (`expired`): §3.6.
5. **Statement** (`statement-mismatch`): `statement` is one of the renderings of §3.4. B then computes the grant hash (§3.5).
6. **Call proof** (`bad-proof`): `|proof.ts − now| ≤ 300`, and the signer recovered from `proof.sig` over the preimage of §3.9, built from B's container, the grant hash and the request's `id`, method and `params`, equals `callerKey`.
7. **Replay** (`replayed`): an answer for this grant hash and this `id` was already delivered, or a call with them is still in progress. B MAY instead send again, byte for byte, the envelope it signed for that same delivered request (the same method and `params`) when it still holds it and the grant is not revoked (step 9): not signed again, not counted again.
8. **Visitor's signature** (`bad-user-signature`): a 65-byte `userSig` that recovers (low `s`; `v` 27 or 28, or 0 or 1 read as 27 or 28) to `user` holds. A 65-byte value that cannot be parsed or recovered is refused without asking further. Otherwise (it recovers to another address, or it is longer than 65 bytes) B asks `user` under EIP-1271 (`isValidSignature(grantHash, userSig)` returning `0x1626ba7e`); an address without code does not hold.
9. **Revocation** (`revoked`): B holds a revocation of this grant hash for this `user`, or a `revokedBefore` of this `user` greater than the grant's `notBefore` (§3.13). It comes after the visitor's signature, so that a grant forged for someone else's address does not tell whether that visitor revoked anything at B.
10. **B's holder and site** (`audience-holder-changed`, `audience-not-opened`, `audience-unpaid`): B's current holder, read from the chain, equals `audienceHolder`; then B's TAP-10 §6.2 site status is `ok` (the two refusals carry the status).
11. **Caller** (`caller-name-mismatch`, `caller-holder-changed`, `caller-not-opened`, `caller-unpaid`): `callerName` resolves on B's chain to a container equal to `caller` (a name of another chain, or one that does not resolve, is a mismatch); its holder equals `callerHolder`; then its site status is `ok`. When the holder differs, B MUST also revoke this grant hash for good at this service before refusing: the caller coming back to the old holder does not restore it.
12. **No voucher** (`voucher-not-allowed`): the request carries no `voucher` member.
13. **Count** (`rate-limited`, `exhausted`): B MAY first apply its own rate limit per proven pair (`caller`, `user`), across all their grants (`rate-limited`, nothing counted). B then reserves one call: the calls already delivered plus those in progress must be below `maxCalls` (`exhausted`), and a call with the same grant hash and `id` still in progress is refused `replayed`. The reservation is committed when the answer is accepted for signing, and released when the handler fails or runs out of time.

Chain reads (steps 8 to 11) read names, holders and site statuses as the 2.0 default resolution does (TAP-10, at one pinned block), and MAY be cached for at most 60 s; the reference makes the EIP-1271 call of step 8 at the latest block, not at the pinned one. A failed chain read is not a refusal: B answers an error other than a `grant:` refusal (the reference answers `INTERNAL`), reserves and records nothing, and the same `id` may be retried. A request without a `grant` member to a method whose descriptor says `"required"` is refused `required`.

### 3.11 The grant record

When the checks hold, B runs the method; its result MUST be a JSON object without a member `grant`. B adds:

```json
"grant": { "hash": "<grant hash>", "caller": "0x…", "user": "0x…", "used": 3, "maxCalls": 100 }
```

to the result before signing it under TAPI-21: `used` is this call's place in the count (1 to `maxCalls`). A result that is not an object, or that has its own `grant` member, is an error of B (the reference answers `INTERNAL`) and uses no call.

A MUST check, in the verified answer, that `result.grant.hash` is the grant hash, that `caller` and `user` are those of the grant, that `maxCalls` is the grant's and that `used` is an integer from 1 to `maxCalls`. An answer without such a record means B did not apply the grant and MUST NOT be treated as a success (the reference client raises `GRANT_NOT_HONOURED`).

### 3.12 Refusals

A refusal is a TAPI-21 signed error with the code `BAD_REQUEST` and **no `error.data`**. Its message begins `grant: <reason>`, optionally followed by a space and a detail in parentheses (at most 200 characters). A client reads the reason with `^grant: ([a-z-]+)` and MUST NOT rely on the detail. The reasons, in the order B checks them:

`required`, `malformed`, `wrong-audience`, `method-out-of-scope`, `expired`, `statement-mismatch`, `bad-proof`, `replayed`, `bad-user-signature`, `revoked`, `audience-holder-changed`, `audience-not-opened`, `audience-unpaid`, `caller-name-mismatch`, `caller-holder-changed`, `caller-not-opened`, `caller-unpaid`, `voucher-not-allowed`, `rate-limited`, `exhausted`.

New error codes (for example `GRANT_REQUIRED`, `BAD_GRANT`) are left to a later TAP; until then the reason lives in the message only.

### 3.13 Revocation

A revocation applies to the grants of its `user` at the service that receives it: every grant whose hash it lists, and every grant whose `notBefore` is below `revokedBefore` (`0`: none by date). A later `revokedBefore` replaces an earlier one only when it is greater.

A service that takes grants SHOULD list the free method `grant_revoke` (`priceBEM` `"0"`, no `grant` member), with `params: { revocation, sig }`: `revocation` a `GrantRevocation` message (§3.3) and `sig` the visitor's signature over its digest (§3.5), checked as in step 8. Anyone may deliver it. B refuses, with the refusals of §3.12, a revocation of the wrong shape or with `issued` more than 300 s ahead of its clock (`malformed`) and one the visitor did not sign (`bad-user-signature`). Otherwise B records it and answers:

```json
{ "revoked": { "user": "0x…", "grantHashes": [ "0x…" ], "revokedBefore": 0, "issued": 1791000060, "hash": "<hashStruct(GrantRevocation)>" } }
```

That signed answer is the visitor's receipt. A revocation binds only the service that records it; but it names no service, so whoever holds a signed revocation can hand it to every service of the chain, and each of them records it. B MUST keep a revocation at least until every grant it can refuse has expired, and MUST NOT drop a revocation to make room: when it cannot record one, it answers an error (the reference answers `INTERNAL`). The reference keeps revocations of grant hashes it has never seen (whose expiry it cannot know) within a budget of their own, half of its store by default, so that a flood of them signed with throwaway keys cannot fill it. Vectors: `revocations[]`.

## 4. Rationale

- **Its own domain.** A visitor flow never builds a TAP-11 type, and a signature over one type is never a signature over another. The hub, not B's container, is the verifying contract, so one domain serves a chain; the other choice would be a new domain version.
- **A generated statement.** The visitor reads a sentence, and the service rebuilds it from the members it enforces, so the sentence cannot say more or less than the grant.
- **A required caller key.** There is no "whoever holds it may use it" path: a copy of a grant, seen in a log or on the wire, cannot make a call without the caller key.
- **Refusals as `BAD_REQUEST`.** TAPI-21's error table has no code for this, and a new code needs a TAP; a fixed message prefix is enough for a client to tell the reasons apart.
- **Chain reads last.** A grant that fails a cheap check costs B no read. A forged visitor signature can cost one EIP-1271 read (`eth_getCode`, which the reference caches per address for 60 s).

## 5. Backwards Compatibility

New. A service that does not know this document ignores the member or refuses the request; in either case its answer carries no grant record, and A treats it as not applied (§3.11). Requests without a `grant` member are unchanged.

## 6. Test Vectors

`spec/vectors/interop-visitor-grant.json`, SHA-256 `c4ec082b2e2c048aec41002f009d626746679db30719f956a3ab343b6964be3c` (2026-10-21). Fake keys (repeated bytes). It holds the two type strings and type hashes, the domain and its separator on chain 56, the same grant on chain 8453 (`otherChain`), two grants (English, one method; Chinese, three methods, 7 days) with both statements, `methodsHash`, `structHash`, digest and the visitor's signature, two call proofs (empty `params`; `params` bound) with preimage, digest, EIP-191 digest and signature, and two revocations (by hash; by date) with struct hash, digest and signature.

They are checked three ways: `spec/vectors/verify.py`, an independent Python implementation written from the text above, runs 46 checks on this file (its labels begin `grant/`); `interop/test/interop.test.mjs` (JavaScript); and `contracts/test/VisitorGrantTypehash.t.sol` (Solidity, the type hashes). The vectors do not cover the order of the checks of §3.10; the tests in `examples/app-interop/` do. A second file, `spec/vectors/interop-visitor-grant-negative.json` (2026-10-22), holds requests that steps 1 to 8 refuse, each with its reason, and control cases that pass them; `verify.py` recomputes every reason from this text (labels `grant-neg/`), and `interop/test/interop-negative-vectors.test.mjs` rebuilds the file.

## 7. Reference Implementation

`@tapeapi/interop` (first an SDK subpath on the 2.5 development line; now a package of its own): `interop/src/interop-sig.js` (types, hashes, statement, wallet payload, call proof), `interop/src/interop-verify.js` (§3.10 to §3.13: `verifyVisitorGrant`, `grantMethods`, `grantRevokeHandler`, `memoryGrantStore`, `chainReadsFromApi`), `interop/src/interop-call.js` (the caller's side: `withGrant`, `checkGrantRecord`). The demo is `examples/app-interop/`. The code is the source of truth for this document.

## 8. Security Considerations

- **The visitor's one check.** Until shells check it, the visitor must compare the caller named in the statement with the site the wallet says the request comes from. A page that asks for a grant naming another app is a phishing attempt that only that comparison catches. How wallets show the grant has not been checked yet.
- **Enforcement is B's.** The count, the window, the scope and revocation are enforced by the called service only. A malicious service ignores all of them; until a contract layer exists, a grant binds only whoever reads it. A grant gives B nothing it could not do without one; it only lets B know the visitor's wish.
- **Off-chain.** Every cross-app call is an off-chain request, so a site that makes one is no longer "100% on-chain".
- **What a signature shows.** The grant record shows what B's signer said it applied; a receipt proves what the signer said, not that the data is right.
- **Replay.** A call proof is bound to B, the grant, the `id`, the method, the `params` and a time within ±300 s; (grant hash, `id`) is delivered at most once (§3.10 step 7). A man in the middle who changes the `params` breaks the proof. Whoever holds a copy of a request (a log, a proxy) can send it again within its proof's 300 s; when B still keeps the answer (step 7), that copy is answered with it.
- **Holders change.** B re-reads both holders (cached at most 60 s) and refuses a grant whose holder changed; a changed caller holder revokes the grant for good at that service. These are point reads: a change undone between two calls (the circuit passes to another holder and back), or one inside the cache window, is not seen, so "for good" holds only for a change that a read observes.
- **State.** Counts, delivered ids and revocations are B's state. The reference store keeps them in memory, exact in one process only and lost on restart, including the "for good" revocation of step 11; a deployed service MUST persist revocations. A store with eventual consistency can let a few calls past `maxCalls`.
- **Counting edge.** The reference commits the count just before signing: a result the provider then refuses to send (over its size limit, or its delegation lapsing mid-call) uses one call.
- **Privacy.** A grant shows B and anyone on the path the visitor's address and links it to A and to every call made with the grant. The statement names no address.
- **Keys.** The caller key SHOULD stay in A's origin and be discarded when the grant expires. A key leak lets its holder call within the grant until it expires or is revoked.
- **Denial of service.** The order of §3.10 puts every check that needs no chain read before the first read, and B MAY limit per proven (caller, visitor) pair; a limit per IP address stays the provider's own. A forged grant naming a new `user` each time still costs one `eth_getCode` read per request.

## 9. Copyright

Copyright and related rights waived via [CC0](https://creativecommons.org/publicdomain/zero/1.0/).

---

# TAPI-28：容器应用之间的访客授权（中文译文）

> 以英文版为准。章节编号与英文版一一对应。

> **不是 TAP；实验性；任何次版本都可能改动。** "TAPI-28" 是 TapeAPI 给本文档起的名字，不是 TAP 编号。今天没有任何 TAP 定义这个格式，没有任何服务认识它，它也不在兼容承诺之内：任何次版本都可能修改或移除它。本文描述原型，让独立实现者能在被调用方一侧核验授权，并得到与参考代码相同的结果。

本文中的 "MUST"、"MUST NOT"、"REQUIRED"、"SHALL"、"SHOULD"、"SHOULD NOT"、"RECOMMENDED"、"MAY" 和 "OPTIONAL" 按 RFC 2119 解释。

## 1. 摘要

访客授权让访客的钱包允许一个 TapeOut 应用（调用方 A）代表访客，在短时间内、有限次数地调用另一个应用的 TapeAPI 服务（受众 B）的几个指名方法，不含任何付款。访客在一个独立的域里签一条 EIP-712 消息 `VisitorGrant`。A 在每个请求里以顶层成员 `grant` 携带它，同时带上用授权里指名的一次性钥匙签的调用证明。B 按固定顺序核验、计次、接收撤销（`GrantRevocation`，经免费方法 `grant_revoke`），并把授权记录写进它签名的回答（TAPI-21）。本文定义类型、哈希方式、访客读到的那句话、线上格式、调用证明、B 的核验与拒绝，以及测试向量。

## 2. 动机

TapeOut 上的两个应用已经可以互相调用服务（TAPI-20、TAPI-21），但返回访客自己数据的服务，无从知道访客是否愿意让另一个应用读取。登录或账号会是一种新的凭据。授权要窄得多：它写明两个应用、方法、次数与时间窗，用文字说明不含任何付款，由被调用的服务执行，并且可以随时叫停。

## 3. 规范

### 3.1 术语

- **访客**（`user`）：签授权与撤销的钱包地址。外部账户，或能回答 EIP-1271 的合约钱包。
- **调用方**（A）：代表访客发请求的应用。`caller` 是它的容器，`callerName` 是它的 TapeOut 名字，`callerHolder` 是它的持有人。
- **受众**（B）：接收请求的服务。`audience` 是它的容器，`audienceName` 是它的 TapeOut 名字，`audienceHolder` 是它的持有人。
- **调用方钥匙**（`callerKey`）：A 为这份授权生成并自己保管的一次性 secp256k1 钥匙；每个请求的调用证明都由它签。
- **hub**：受众所在链的 DeWEB hub 合约，与 TAPI-20 中的用法相同。
- **TapeOut 名字**是 TAP-10 §3.1 的规范链上名字，必须完全按该形式书写：`<#ID>.<processor>.tape`，在有区号的链上为 `<#ID>.<area>.<processor>.tape`（例如 `4246.0.tape`）。其他写法一律 MUST 拒绝。

### 3.2 域

两种类型都在同一个独立的 EIP-712 域下签名：

```
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
name              = "TapeAPI Visitor Grant"
version           = "1"
chainId           = 受众所在链的 chain id
verifyingContract = 该链的 DeWEB hub
```

该域 MUST NOT 是 TAP-11 的域（name 为 `"TapeAPI"`），本文的任何类型都不在别的域下签名。同一份授权换一条链或换一个 hub，哈希就不同（向量 `otherChain`）。

### 3.3 类型

类型串是 EIP-712 的 `encodeType` 串，没有空格，也没有换行：

```
VisitorGrant(string statement,address user,address caller,string callerName,address callerHolder,address callerKey,address audience,string audienceName,address audienceHolder,string[] methods,uint32 maxCalls,uint64 notBefore,uint64 expires,bytes32 nonce)
GrantRevocation(address user,bytes32[] grantHashes,uint64 revokedBefore,uint64 issued)
```

| 类型 | 类型哈希 |
|---|---|
| `VisitorGrant` | `0xbc95bd5b4977cb089511e2e459636a0c22d7d0d29280f72043963456ac3e8f0e` |
| `GrantRevocation` | `0x065cffa2962afb3c14827c4d10da27f7f6992c32837f9748a7046963335f03f5` |

`VisitorGrant` 的成员：

| 成员 | 线上类型 | 规则 |
|---|---|---|
| `statement` | string | 至多 2,048 个字符；恰好是 §3.4 的某一种渲染。 |
| `user` | address | 访客。 |
| `caller` | address | A 的容器，由 A 读链得到（绝不取自请求）。 |
| `callerName` | string | A 的 TapeOut 名字（§3.1）。 |
| `callerHolder` | address | 授权生成时 A 的持有人，读链得到。 |
| `callerKey` | address | 调用方钥匙的地址。必填；MUST NOT 等于 `user`。 |
| `audience` | address | B 的容器。 |
| `audienceName` | string | B 的 TapeOut 名字（§3.1）。 |
| `audienceHolder` | address | 授权生成时 B 的持有人，读链得到。 |
| `methods` | string[] | 1 至 8 个方法名，每个都匹配 `^[A-Za-z_][A-Za-z0-9_]{0,63}$`，不得重复。顺序有意义。 |
| `maxCalls` | uint32 | JSON 整数，1 至 10,000。 |
| `notBefore` | uint64 | Unix 秒，JSON 整数，0 至 253,402,300,799（9999-12-31 23:59:59 UTC）。 |
| `expires` | uint64 | 范围同上；`expires > notBefore`，且 `expires − notBefore ≤ 604,800`（7 天）。 |
| `nonce` | bytes32 | `0x` 加 64 位小写十六进制，不全为零；随机生成。 |

`GrantRevocation` 的成员：`user`（address）、`grantHashes`（至多 24 个授权哈希（§3.5）的数组，每个都是 `0x` 加 64 位小写十六进制，不为零）、`revokedBefore` 与 `issued`（Unix 秒，范围同上）。一份撤销 MUST 至少列出一个哈希，或把 `revokedBefore` 设为大于 0。

线上的地址是 `0x` 加 40 位十六进制，大小写不限，不得为零地址；比较时不区分大小写。`bytes32` 值的十六进制位 MUST 小写：出现大写即格式错误，不做折叠。从别人那里收到的消息 MUST 恰好有所列成员（授权 14 个，撤销 4 个）：多一个或少一个都是格式错误。

### 3.4 statement（那句话）

statement 由其余成员生成，绝不是自由文本。第 1 版有两个模板，授权的 `statement` MUST 逐字等于其中之一套用到它自己的成员上的结果：

```
en: Allow {callerName} to call these methods of {audienceName} on my behalf: {methods}. At most {maxCalls} call{s}, valid from {notBefore} to {expires} UTC. This grant includes no payment. Revocable at any time with {audienceName}.
zh: 允许 {callerName} 代表我调用 {audienceName} 的方法：{methods}。最多 {maxCalls} 次，{notBefore} 至 {expires} UTC 有效。本授权不含任何付款。可随时向 {audienceName} 撤销。
```

- `{methods}` 是按授权顺序排列的方法名，以 `", "`（逗号加空格）连接。
- `{maxCalls}` 是不带分隔符的十进制整数。`maxCalls` 为 1 时 `{s}` 为空，否则为 `s`（仅英文）。
- `{notBefore}` 与 `{expires}` 是 UTC 时间，写成 `YYYY-MM-DD HH:MM:SS`（四位年份、24 小时制、精确到秒）。
- 中文模板中的全角冒号 `：`、句号 `。` 与全角逗号 `，` 必须与上面完全一致。

statement 不含任何地址或钥匙。改措辞即新的格式版本（`v`），绝不修改第 1 版。向量：`grants[].statements`。

### 3.5 哈希

`hashStruct` 即 EIP-712 的定义，成员按类型串的顺序：`string` 是其 UTF-8 字节的 `keccak256`；`string[]` 是把每个元素的 `keccak256(utf8(元素))` 按顺序拼接后再取 `keccak256`；`bytes32[]` 是把各 32 字节值按顺序拼接后取 `keccak256`（空列表即空串的哈希）；地址左补零到 32 字节；`uint32` 与 `uint64` 为 32 字节大端。

```
grantHash = keccak256(0x19 ‖ 0x01 ‖ domainSeparator ‖ hashStruct(VisitorGrant))
```

**授权哈希**是包含域在内的完整类型化摘要。它就是访客钱包签名的那 32 字节（`eth_signTypedData_v4`，不再加前缀），也是下文各处授权的身份，写成 `0x` 加 64 位小写十六进制。撤销摘要以同样方式由 `hashStruct(GrantRevocation)` 得出。向量：`methodsHash`、`structHash`、`digest`、`userSig`。

钱包载荷是 `{ domain, types: { EIP712Domain, VisitorGrant }, primaryType: "VisitorGrant", message }`，`statement` 是第一个成员，这样按顺序显示成员的钱包会先显示那句话。页面 SHOULD 在交给钱包之前由成员重建载荷并比对，SHOULD 拒绝 statement 不是其成员渲染结果的消息。

### 3.6 有效期

按 B 的时钟 `now`（Unix 秒），当 `now + 300 ≥ notBefore` 且 `now < expires` 时授权有效。构造方 SHOULD NOT 生成 `notBefore` 比自己时钟超前 300 秒以上的授权。参考默认有效期为 3,600 秒；上限为 604,800 秒（§3.3）。

### 3.7 范围规则

- 授权只写方法名。无法写出通配（`*` 不是方法名），也无法写出不限次（`maxCalls` 至多 10,000）。
- 当 B 清单（TAPI-20）里某方法的描述带有成员 `grant` 且值为 `"required"` 或 `"optional"` 时，该方法接受授权；其他值是清单错误。`"required"`：不带授权的请求被拒绝（`required`）。`"optional"`：这样的请求照常执行，与本文不存在时一样。
- 授权中列出的每个方法都 MUST 是 B 清单中接受授权的方法，被调用的方法 MUST 是其中之一。
- **不涉及钱。** 接受授权的方法 MUST 免费（`priceBEM` 为 `"0"`）；本文的任何类型都没有金额、代币或费用；带授权的请求 MUST NOT 同时带 TAPI-22 的 `voucher`（`voucher-not-allowed`）。
- 方法 SHOULD 只在返回访客自己的数据时接受授权。程序无法检查这一点，由运营者决定。

### 3.8 请求成员 `grant`

授权作为 TAPI-21 §3.1 请求体的顶层成员携带，与 `id`、`method`、`params` 并列：

```json
{ "id": "g-…", "method": "history", "params": { },
  "grant": { "v": 1, "chainId": 56,
             "message": { "statement": "…", "user": "0x…", "…": "§3.3 的 14 个成员" },
             "userSig": "0x…",
             "proof": { "ts": 1791000007, "sig": "0x…" } } }
```

- `grant` 恰好有成员 `v`、`chainId`、`message`、`userSig`、`proof`。`v` 是整数 `1`。`chainId` 是 JSON 整数，MUST 等于 B 所在链的 chain id。
- `userSig` 是 `0x` 加 65 至 1,024 字节的十六进制：访客对授权哈希的签名。
- `proof` 恰好有 `ts`（非负 JSON 整数，Unix 秒）与 `sig`（`0x` 加 65 字节的十六进制）。
- 请求的 `id` MUST 是 1 至 128 个字符的字符串（TAPI-21 §3.1），且是合法的 Unicode（孤立的 UTF-16 代理项没有 UTF-8 形式：对这样的 id 的证明为 `bad-proof`）；RECOMMENDED 每次调用用新的随机 id。
- A MUST 只把该成员发往 B 清单中列出的端点（`endpoints.live`）。TAPI-21 的响应摘要覆盖 `{ method, params }`，不覆盖这个成员；回答与授权的绑定靠授权记录（§3.11）。

### 3.9 调用证明

调用方钥匙对每个请求签名：

```
preimage = "TAPI-grant/call1"                                    // 16 个 ASCII 字节
         ‖ audience                                              // 20 字节
         ‖ grantHash                                             // 32 字节
         ‖ keccak256(utf8(id))                                   // 32 字节
         ‖ keccak256(utf8(canonicalJSON({ method, params })))    // 32 字节；缺省时 params 为 {}
         ‖ uint64BE(ts)                                          // 8 字节
                                                                 // 共 140 字节
sig = 对 keccak256(preimage) 做 secp256k1 EIP-191 personal_sign，与 TAPI-21 §3.3 对摘要签名的方式相同
```

`canonicalJSON` 即 TAPI-21 §3.3 的定义。`method` 是被调用的方法，`params` 是 B 解析出的请求 `params`。签名 MUST 为 65 字节，`v` 为 27 或 28（0 与 1 被拒绝），`s` 为低值（`s ≤ n/2`）。前缀与长度都不同于 TAPI-21 的 `"TAPI-1/resp/v2"` 摘要，因此调用证明绝不会被当成回答签名，反之亦然。同一 `id` 的重试带新的证明与新的 `ts`。向量：`proofs[]`（`preimage`、`digest`、`personalDigest`、`sig`）。

### 3.10 B 的核验

对带 `grant` 成员的请求，B MUST 按以下顺序核验；第一个失败即停止，B 以 §3.12 的拒绝作答，原因如所示。廉价检查在前，读链在后。

1. **形状**（`malformed`）：§3.8 与 §3.3；`v` = 1，`chainId` = B 所在链，消息恰好 14 个成员且各自合规，`userSig` 形状正确，`proof` 恰好有 `ts`（非负整数）与 `sig`（字符串；其长度与格式在第 6 步检查，不合格即 `bad-proof`）。
2. **受众**（`wrong-audience`）：`audience` 等于 B 自己的容器，`audienceName` 等于 B 自己的 TapeOut 名字，原样比较（不读链）。
3. **方法**（`method-out-of-scope`）：被调用的方法在 `methods` 中且在 B 清单里接受授权，并且 `methods` 中的每个方法在 B 清单里都接受授权。
4. **时间窗**（`expired`）：§3.6。
5. **statement**（`statement-mismatch`）：`statement` 是 §3.4 的某一种渲染。随后 B 计算授权哈希（§3.5）。
6. **调用证明**（`bad-proof`）：`|proof.ts − now| ≤ 300`，且由 B 的容器、授权哈希和请求的 `id`、方法、`params` 按 §3.9 构造前像，从 `proof.sig` 恢复出的签名者等于 `callerKey`。
7. **重放**（`replayed`）：这个授权哈希与这个 `id` 的回答已经交付过，或者它们的调用仍在进行中。若 B 仍保留着它为那个已交付的同一请求（相同方法与 `params`）签过的信封、且授权未被撤销（第 9 步），B MAY 改为把那份信封原样再发一次：不重新签名，也不再计次。
8. **访客签名**（`bad-user-signature`）：65 字节的 `userSig` 恢复出 `user`（低 `s`；`v` 为 27 或 28，0 或 1 按 27 或 28 读）即成立。无法解析或无法恢复的 65 字节值直接拒绝，不再另行询问。其余情形（恢复出别的地址，或长于 65 字节）由 B 按 EIP-1271 询问 `user`（`isValidSignature(grantHash, userSig)` 返回 `0x1626ba7e`）；没有代码的地址不成立。
9. **撤销**（`revoked`）：B 持有该 `user` 对这个授权哈希的撤销，或该 `user` 的 `revokedBefore` 大于授权的 `notBefore`（§3.13）。它排在访客签名之后，这样替别人的地址伪造的授权无法探出该访客是否在 B 撤销过什么。
10. **B 的持有人与站点**（`audience-holder-changed`、`audience-not-opened`、`audience-unpaid`）：读链得到的 B 当前持有人等于 `audienceHolder`；然后 B 的 TAP-10 §6.2 站点状态为 `ok`（两种拒绝写出对应状态）。
11. **调用方**（`caller-name-mismatch`、`caller-holder-changed`、`caller-not-opened`、`caller-unpaid`）：`callerName` 在 B 所在链上解析到的容器等于 `caller`（别的链上的名字或解析不到的名字都算不一致）；其持有人等于 `callerHolder`；然后其站点状态为 `ok`。持有人不同时，B MUST 在拒绝之前把这个授权哈希在本服务永久撤销：调用方日后回到原持有人，也不会恢复。
12. **不带凭证**（`voucher-not-allowed`）：请求不含 `voucher` 成员。
13. **计次**（`rate-limited`、`exhausted`）：B MAY 先按已证明的（`caller`, `user`）这一对、跨它们的全部授权做自己的限流（`rate-limited`，不计次）。然后 B 预留一次调用：已交付的次数加进行中的次数必须小于 `maxCalls`（`exhausted`）；同一授权哈希与 `id` 的调用仍在进行中时，以 `replayed` 拒绝。回答被接受去签名时提交预留；处理器失败或超时则释放。

读链（第 8 至 11 步）按 2.0 默认解析的方式读取名字、持有人与站点状态（TAP-10，在同一个钉住的区块上），MAY 缓存，但不超过 60 秒；参考实现第 8 步的 EIP-1271 调用在最新区块而不是钉住的区块上进行。读链失败不是拒绝：B 回一个不同于 `grant:` 拒绝的错误（参考实现回 `INTERNAL`），不预留、不记录，同一个 `id` 可以重试。对描述为 `"required"` 的方法、不带 `grant` 成员的请求以 `required` 拒绝。

### 3.11 授权记录

核验成立后，B 执行该方法；其结果 MUST 是一个不含成员 `grant` 的 JSON 对象。B 在按 TAPI-21 签名之前，把

```json
"grant": { "hash": "<授权哈希>", "caller": "0x…", "user": "0x…", "used": 3, "maxCalls": 100 }
```

加入结果：`used` 是这次调用在计数中的位置（1 至 `maxCalls`）。结果不是对象、或自带 `grant` 成员，是 B 自己的错误（参考实现回 `INTERNAL`），不计次。

A MUST 在已验的回答中核对：`result.grant.hash` 是授权哈希，`caller` 与 `user` 是授权里的，`maxCalls` 是授权里的，`used` 是 1 至 `maxCalls` 之间的整数。没有这样记录的回答说明 B 没有执行这份授权，MUST NOT 当作成功（参考客户端抛出 `GRANT_NOT_HONOURED`）。

### 3.12 拒绝

拒绝是 TAPI-21 的签名错误，错误码为 `BAD_REQUEST`，**不带 `error.data`**。其 message 以 `grant: <原因>` 开头，后面可以跟一个空格和括号里的细节（至多 200 个字符）。客户端用 `^grant: ([a-z-]+)` 读出原因，MUST NOT 依赖细节。全部原因，按 B 的核验顺序：

`required`、`malformed`、`wrong-audience`、`method-out-of-scope`、`expired`、`statement-mismatch`、`bad-proof`、`replayed`、`bad-user-signature`、`revoked`、`audience-holder-changed`、`audience-not-opened`、`audience-unpaid`、`caller-name-mismatch`、`caller-holder-changed`、`caller-not-opened`、`caller-unpaid`、`voucher-not-allowed`、`rate-limited`、`exhausted`。

新的错误码（例如 `GRANT_REQUIRED`、`BAD_GRANT`）留给以后的 TAP；在那之前，原因只写在 message 里。

### 3.13 撤销

撤销作用于其 `user` 在接收它的那个服务上的授权：它列出哈希的每一份授权，以及 `notBefore` 早于 `revokedBefore` 的每一份授权（`0` 表示不按时间撤销）。较晚的 `revokedBefore` 只有在更大时才取代较早的。

接受授权的服务 SHOULD 列出免费方法 `grant_revoke`（`priceBEM` 为 `"0"`，不带 `grant` 成员），`params: { revocation, sig }`：`revocation` 是一条 `GrantRevocation` 消息（§3.3），`sig` 是访客对其摘要（§3.5）的签名，按第 8 步核对。任何人都可以投递。B 以 §3.12 的拒绝回应：形状不对、或 `issued` 比 B 的时钟超前 300 秒以上的撤销（`malformed`），以及不是访客签的撤销（`bad-user-signature`）。否则 B 记录它并回答：

```json
{ "revoked": { "user": "0x…", "grantHashes": [ "0x…" ], "revokedBefore": 0, "issued": 1791000060, "hash": "<hashStruct(GrantRevocation)>" } }
```

这份签名回答就是访客的回执。撤销只约束记录它的那个服务；但撤销不指名服务，任何持有一份已签撤销的人都能把它递给同一条链上的每个服务，它们都会记录。B MUST 至少保留一份撤销，直到它能拒绝的授权全部过期；MUST NOT 为腾出空间而丢弃撤销：记录不下时回一个错误（参考实现回 `INTERNAL`）。参考实现把本服务从未见过的授权哈希（不知道其到期时间）的撤销放在单独的预算里，默认占存储的一半，这样用一次性钥匙签出的大量此类撤销塞不满整张表。向量：`revocations[]`。

## 4. 原理

- **独立的域。** 访客流程从不构造 TAP-11 的类型，对一种类型的签名绝不是对另一种类型的签名。验证合约用 hub 而不是 B 的容器，一条链一个域；另选即新的域版本。
- **生成的那句话。** 访客读的是一句话，服务由它实际执行的成员重建这句话，因此这句话不会比授权多说或少说。
- **必填的调用方钥匙。** 没有"谁拿到谁就能用"的路径：在日志或线路上看到的授权副本，没有调用方钥匙就发不出调用。
- **拒绝用 `BAD_REQUEST`。** TAPI-21 的错误表没有对应的码，新码需要 TAP；固定的 message 前缀足以让客户端区分原因。
- **读链在最后。** 在廉价检查上失败的授权不会让 B 读一次链。伪造的访客签名可能让 B 做一次 EIP-1271 读取（`eth_getCode`，参考实现按地址缓存 60 秒）。

## 5. 向后兼容

新增内容。不认识本文的服务会忽略该成员或拒绝该请求；两种情况下回答都不带授权记录，A 视为未执行（§3.11）。不带 `grant` 成员的请求不受影响。

## 6. 测试向量

`spec/vectors/interop-visitor-grant.json`，SHA-256 `c4ec082b2e2c048aec41002f009d626746679db30719f956a3ab343b6964be3c`（2026-10-21）。使用假钥匙（重复字节）。其中有两个类型串与类型哈希、链 56 上的域及其分隔符、同一授权在链 8453 上的结果（`otherChain`）、两份授权（英文、一个方法；中文、三个方法、7 天）及其两种 statement、`methodsHash`、`structHash`、摘要与访客签名，两个调用证明（空 `params`；绑定 `params`）及其前像、摘要、EIP-191 摘要与签名，以及两份撤销（按哈希；按时间）及其结构哈希、摘要与签名。

三种方式核对：`spec/vectors/verify.py` 是按上文独立写成的 Python 实现，对该文件运行 46 项检查（标签以 `grant/` 开头）；`interop/test/interop.test.mjs`（JavaScript）；`contracts/test/VisitorGrantTypehash.t.sol`（Solidity，类型哈希）。向量不覆盖 §3.10 的核验顺序；`examples/app-interop/` 中的测试覆盖。第二个文件 `spec/vectors/interop-visitor-grant-negative.json`（2026-10-22）收录第 1 至 8 步必须拒绝的请求及各自的原因，外加能过这些步骤的对照；`verify.py` 按本文逐条复算原因（标签 `grant-neg/`），`interop/test/interop-negative-vectors.test.mjs` 重建该文件。

## 7. 参考实现

`@tapeapi/interop`（最初是 2.5 开发线上 SDK 的子路径；现在是独立的包）：`interop/src/interop-sig.js`（类型、哈希、statement、钱包载荷、调用证明）、`interop/src/interop-verify.js`（§3.10 至 §3.13：`verifyVisitorGrant`、`grantMethods`、`grantRevokeHandler`、`memoryGrantStore`、`chainReadsFromApi`）、`interop/src/interop-call.js`（调用方一侧：`withGrant`、`checkGrantRecord`）。演示在 `examples/app-interop/`。本文以这些代码为准。

## 8. 安全考量

- **访客要做的那一件事。** 在外壳把关之前，访客必须比对 statement 里的调用方名字与钱包显示的"请求来自"站点。一个页面请求的授权写着别的应用的名字，就是钓鱼，只有这一比对能发现。钱包如何显示授权，目前还没有核实。
- **执行在 B。** 次数、时间窗、范围与撤销都只由被调用的服务执行。恶意服务会全部无视；在合约层出现之前，授权只约束读到它的一方。授权没有给 B 任何它本来做不到的能力，只是让 B 知道访客的意愿。
- **链下。** 每次跨应用调用都是链下请求，发出这种请求的站点因此不再是"100% 链上"。
- **签名说明了什么。** 授权记录说明的是 B 的签名者声称自己执行了什么；回执证明的是签名者说了什么，不证明数据正确。
- **重放。** 调用证明绑定 B、授权、`id`、方法、`params` 与 ±300 秒内的时间；（授权哈希, `id`）至多交付一次（§3.10 第 7 步）。中间人改动 `params` 会使证明失效。持有请求副本的人（日志、代理）可以在证明的 300 秒内把它再发一次；B 仍保留着回答时（第 7 步），这份副本得到的就是那份回答。
- **持有人会变。** B 重新读取双方持有人（缓存不超过 60 秒），持有人变了就拒绝；调用方持有人变化会让该授权在这个服务上永久撤销。这些都是点读：两次调用之间发生又被撤回的变化（电路转给别人又转回），或缓存窗口之内的变化，都看不到，因此“永久”只对读到了的变化成立。
- **状态。** 计数、已交付的 id 与撤销都是 B 的状态。参考存储放在内存里，只在单个进程内精确，重启即丢失，包括第 11 步的"永久"撤销；实际部署的服务 MUST 持久化撤销。最终一致的存储可能让少数调用超出 `maxCalls`。
- **计次的边界。** 参考实现在签名之前提交计次：服务端随后拒发的结果（超过大小上限，或调用途中委托过期）会用掉一次。
- **隐私。** 授权让 B 和线路上的任何人看到访客的地址，并把它与 A、与用这份授权发出的每次调用关联起来。statement 不含地址。
- **钥匙。** 调用方钥匙 SHOULD 留在 A 的源（origin）里，授权到期后丢弃。钥匙泄露后，拿到它的人可以在授权范围内调用，直到授权过期或被撤销。
- **拒绝服务。** §3.10 的顺序把所有不需读链的检查放在第一次读链之前，B MAY 按已证明的（调用方, 访客）对限流；按 IP 地址的限流仍是服务端自己的事。每次换一个新 `user` 的伪造授权，每个请求仍要一次 `eth_getCode` 读取。

## 9. 版权

依 [CC0](https://creativecommons.org/publicdomain/zero/1.0/) 放弃版权及相关权利。
