# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).
From 1.0.0 on, a breaking change comes only in a new major version (2.0); before 1.0.0, a minor version could change
interfaces.

## [Unreleased]

## [1.8.1] — 2026-10-08

### Added

- **Private channels and groups: optional version-2 labels (`labels: 'v2'`).** At the request of the TAPs editors
  (TapeOutProtocol/TAPs PRs #12 and #20), the domain-separation labels of private channels and private groups have a
  version 2 that begins with `tape-channel/` and `tape-group/` instead of `TAP-26/` and `TAP-27/`, with the same
  suffixes. The SDK implements it as an option: pass `labels: 'v2'` to `channel.createInvite`, `acceptInvite`,
  `roomsFor`, `inboxRoom`, `sealInvite` / `sealToInbox` and `openInvite` / `openFromInbox`, and to `group.createGroup`,
  `joinGroup`, `openGroupInvite`, `groupRoom` and `checkGroupInvites`. **The default is unchanged:** without the
  option the SDK uses version 1 exactly as 1.8.0 did, and the version-1 vector files are unchanged. Version 2 is
  planned to become the default in 2.0.
  - Both sides must use the same version. Invites carry no version (they keep `v: 1`), and the two versions do not
    interoperate. A mismatch fails closed: the rooms differ, and an accept, ready, sealed invite or epoch message of
    the other version is refused with `CHANNEL_INVALID` / `GROUP_INVALID`, `data.labels` and `data.peerLabels`. The
    SDK never switches versions on its own; any other `labels` value is `INVALID_ARGUMENT`. For a sealed invite the
    error says only how the wire was sealed: anyone can post to an inbox room, so it is no evidence about the sender.
  - Pending handles, sessions and group handles report `labels`. SDKs before 1.8.1 ignore the `labels` option
    silently and use version 1; an application that passes `labels: 'v2'` should check `pending.labels` and
    `session.labels` (or `group.labels`), which those SDKs do not have.
  - The `snapshot()` of a version-2 group is `v: 3` with `labels: 'v2'` (SDKs up to 1.8.0 refuse it), and
    `resumeGroup` takes the version from the snapshot. A `v: 1` or `v: 2` snapshot that says `labels: 'v1'` is
    accepted, as 1.8.0 accepted it; one that says `labels: 'v2'` is refused.
  - Specifications: [`spec/TAPI-26-v2.md`](spec/TAPI-26-v2.md) and [`spec/TAPI-27-v2.md`](spec/TAPI-27-v2.md) (Draft).
    `spec/TAPI-26.md` and `spec/TAPI-27.md` stay Stable (v1), with a non-normative note. New vectors
    `spec/vectors/tapi-26-v2-channel.json`, `tapi-26-v2-identity.json`, `tapi-27-v2-group.json` and
    `tapi-27-v2-group-format2.json`, written by the SDK and checked by `spec/vectors/verify.py` with the version-1
    files.

## [1.8.0] — 2026-10-06

### Changed

- **`@tapeapi/sdk/agent` (experimental): checks follow more of the draft TAP (TAPs PR #47) and are stricter.** The
  subpath is outside the 1.x compatibility promise; messages, threads and evidence that 1.7.1 accepted may now be
  refused, and some problem names changed. No type hash, digest or existing vector changed.
  - **Input forms are refused, not read leniently** (draft §3.7, §7.2, §8). A message received from a counterparty
    must carry every `bytes32` in lower case, every `uint256` (`nonce`, `fee`, `feeCap`, a scope `cap`) as a decimal
    string (a JSON number or a bigint is now `mandate-malformed` / `message-malformed`), and a verdict's `reasonHash`
    (missing or `null` is now `message-malformed`; 1.7.1 read it as zero). An agent message whose `ts` or `result.exp`
    is negative, or whose receipt lacks the TAP-13 method, `params` object or 65-byte `sig`, or whose `id` is not 1 to
    128 code units (TAP-13 §3), is `message-malformed`. A hash-only evidence receipt whose `ok` is not a JSON boolean
    (1.7.1 read it as `false`), or whose `requestHash`, `bodyHash` or `ts` is not in its form, or whose `id` is not 1 to
    128 code units (the empty `id` of TAP-13 §8 binding rule 1 is allowed only when `ok` is `false`), is
    `receipt-not-hash-only`. The builders
    (`mandateTypedData`, `taskOfferTypedData`, the hash and `sign*` functions) still take a number or a bigint and still
    default a missing `reasonHash`; `bytes32` input must now be lower case there too. New pure functions:
    `agentMessageProblem`, `hashOnlyReceiptProblem`; `normalize*` take `{ wire: true }`.
  - **One pinned block per verification** (draft §4, §6.2; TAP-10 §5.3). Every read of `verifyMandate`,
    `verifyTaskThread` (both passes), `verifyEvidence`, `readRevocations` and `identityOf` is made at one TAP-10
    pinned block, by block hash: the principal's identity and holder, EIP-1271 calls, both implementation slots and
    the revocation file. 1.7.1 read each at `latest`. The kit checks `eth_chainId` under strict agreement once;
    `stale-block` and `wrong-chain` are thrown with `data.status`, never reported as problems.
  - **The principal is resolved as TAP-10 §4.3 says.** The container is derived by the chain's container opener
    (1.7.1 asked the hub), and the processor number is found on the chain (snapshot hit confirmed by `cpuAt`, else a
    bounded scan), so the on-chain name is always present (1.7.1 gave `null` outside the snapshot). Every identity
    failure is now `not-tapeout` or `no-such-token`: the problem names `not-a-container` and `wrong-chain` are gone
    (a `token()` naming another chain is `not-tapeout`).
  - **Resolving the agent or a provider.** A site status (`not-opened`, `unpaid`, `store-changed`) from the resolver, or
    a conformance-mode client's `unsupported` for an address that is no container of the chain, is now
    `agent-unresolvable` / `provider-unresolvable` (1.7.1 threw it); `stale-block`, `unavailable` and
    `wrong-chain` are thrown. The kit still resolves through the client's `resolve`; the guide shows how to pass a
    `conform: 'tap10'` client (TAP-11 §2) as the kit's `resolve`.
  - **The two passes share reads, the total goes up.** The two passes of `verifyTaskThread` share one read of the
    revocation file, the implementation slots and each identity (within one thread the kit's own revocation-file and
    slot reads (`pathCount`, `fileInfo`, `read` and the slots) are half of what 1.7.1 made); the slots are kept per
    pinned block for at most 60 s. The total number of reads still rises: resolving the principal adds the pin
    (`eth_blockNumber`, `eth_getBlockByNumber`), one `eth_chainId` per kit and, outside the snapshot, a `cpuAt` scan
    (at most 256 reads per processor looked up, per verification, resumed on the next one).
  - Vectors: `spec/vectors/container-agent.json` gains `inputForms`, 66 hand-written cases checked by the SDK and by
    `spec/vectors/verify.py`.

- **Payments (experimental, TAPI-22; no escrow is deployed or audited): escrow amounts use the escrow's own token, and
  `approve` / `fund` are built only for allowed escrows.** Outside the 1.x compatibility promise.
  - `api.tx.approve` and `api.tx.fund` now return a Promise. Both read the escrow's `token()` and the token's
    `decimals()` under strict agreement first, and are built only for an escrow on the new `AUDITED_ESCROWS` list
    (empty) or in the new `createTapeAPI({ allowEscrows })` option; any other escrow is refused (`INVALID_ARGUMENT`,
    `data.reason` `escrow-not-allowed`), the configured `escrow` included. `approve` approves the escrow's own token
    instead of defaulting to BEM; its `token`, and the new `fund(provider, amount, { token })`, name the token you
    expect. `fund` is stricter than `approve`: it is refused for any escrow that holds a token other than BEM
    (`UNSUPPORTED_PAYMENT_TOKEN`, `data.reason` `not-bem`), whatever token you name and even for an allowed escrow,
    because the escrow contract itself takes any admitted token but the manifest's pricing in more than one token is
    not yet specified, so this SDK does not build funding for a channel it cannot use yet.
  - New client error code `UNSUPPORTED_PAYMENT_TOKEN` (`data.reason`: `token-unreadable`, `decimals-unreadable`,
    `decimals-out-of-range`, `not-bem`, `token-mismatch`). Manifest prices are `priceBEM`, so `fund`, a priced
    `api.call` and an `approve` without a named token (or for a service) refuse an escrow that holds another
    token; the escrow contract itself takes any admitted token, and prices in other tokens are not yet specified. Free methods and dev services are not checked.
  - Inside the SDK and the server, every `parseUnits` / `formatUnits` call names its decimals. The functions' own
    default (8, BEM) is unchanged.

- **Escrow contract v3 (experimental, TAPI-22; the candidate for audit): never deployed and not audited, so no live
  channel, provider or fund is affected.** `contracts/src/TapeAPIEscrow.sol` is the first version that holds one ERC-20
  token per instance by design. This is outside the 1.x compatibility promise, and nothing here says the audit will
  keep this shape.
  - The first constructor argument is the immutable `token` (it was `bem`), and `token()` is the view. The contract
    never reads the token's decimals; the deploy script requires 8 to 18.
  - The solvency statement reads `token.balanceOf(escrow) >= sum of channels + treasuryAccrued` (it was `==`): tokens
    sent straight to the escrow stay in it and are never paid out. No code path changed for this; the statement and the
    invariant test did.
  - **The maintenance contribution is pulled, not pushed.** `settle` adds it to the new `treasuryAccrued` and makes one
    token call, to the provider; the new `claimTreasury()` (anyone may call it) pays the accrual to the current
    treasury and emits `TreasuryClaimed`. A treasury that cannot receive the token no longer blocks any settlement.
    `Settled` keeps its signature; its `contribution` now means the amount accrued.
  - **`setTreasury` pays the outgoing treasury first** (a failed payout is rolled back and ignored, so a frozen
    treasury never blocks the change; the unclaimed accrual then belongs to the new treasury), and it refuses the
    escrow itself and its token as treasury (new error `BadTreasury()`, also in the constructor).
  - **One judge for token calls:** every token call that does not answer success (a revert, a malformed or short
    return, a non-bool word) reverts `TransferFailed()`; the return data copied is bounded to 32 bytes.
  - `contracts/script/Deploy.s.sol` checks before it sends anything: the canonical USDT-pegged token with its code
    hash pinned, no proxy token (EIP-1967 and EIP-1822 slots zero), any other token only with `ALLOW_OTHER_TOKEN=true`,
    a treasury that is not zero, the token, the TapeOut hub or the container factory; the post-deploy checks read `token()` and
    `treasuryAccrued()`. New tests, among them a fork rehearsal of that script (needs `BSC_RPC_URL`, skipped without it).
  - Voucher type, typehash, EIP-712 domain and every channel, session, withdrawal and rate rule are unchanged.

- **TAPI-22 (Experimental) revised to specify the escrow that will go to audit.** No escrow has ever been deployed, so
  no channel, provider or fund is affected. The 1.7.1 text of `settle` and the treasury functions is replaced; an
  implementation of it would need to change them. Normative changes, in both the English text and its Chinese
  translation: `settle` accrues the contribution to `treasuryAccrued` and MUST NOT transfer it to the treasury (§3.3;
  the 1.7.1 text required the transfer); `claimTreasury()` (anyone may call) pays the accrual; `setTreasury` pays the outgoing
  treasury first and refuses the escrow and its token (§3.4); voucher amounts are in base units of the instance's
  token (§3.1); every token call that does not answer success reverts `TransferFailed()`. The constructor argument and
  view are named `token`, the solvency line reads `>=` (§3.3), and §3.5 and §7 record which planned items the
  repository contract now has. Counting every `MUST` (`MUST NOT` included), each half goes from 40 to 47; `MUST NOT`
  alone from 7 to 8. `upto` settlement by measured usage is stated as not implemented and not specified, and is not part
  of the audit scope.

### Added

- Experimental, for escrow v3 (not deployed): `api.chain.escrow.token`, `treasuryAccrued`, `paymentToken` (token and
  decimals read on chain, cached; the label from the new `PAYMENT_TOKENS`, never the token's `name()`) and
  `contributions` (one provider's contribution across escrow instances, with a warning when they differ);
  `api.tx.claimTreasury` and `api.tx.wrapNative({ wbnb, amount })` (WBNB `deposit()`, the wrapper address from the
  caller, no gas field); `formatPaymentAmount`; `abi.EVENTS` / `abi.eventTopic` (`Settled`, `TreasuryClaimed`) and
  ABI entries for `token()`, `treasuryAccrued()`, `claimTreasury()`.
- `tapeapi-doctor --escrows a,b` (and `diagnose({ escrows })`), experimental: notes when your contribution differs
  between escrow instances. No new check; the exit code is unchanged.
- `scripts/verify-bscscan.mjs` takes `--token` for the escrow's first constructor argument; `--bem` still works and
  prints a deprecation notice.

### Fixed

- **`@tapeapi/sdk/agent` (experimental): `viaContainer` had no way to attach the TapeOut fee, so its transactions revert on
  BNB Smart Chain mainnet.** A read-only test of mainnet at the time of writing found that a TapeOut container's
  `execute(address,uint256,bytes,uint8)` needs the fee in the chain's native coin on every call (0.0002 BNB, sent to the
  treasury, the excess refunded to the sender; a shorter payment reverts with `0xafd49700(paid, required)`), and
  `viaContainer` in 1.7.0 and 1.7.1 always built the outer transaction with value 0. `viaContainer({ from, tx, value })`
  now takes an optional outer `value` (a decimal string, a safe integer or a bigint, 0 or more; anything else is
  `INVALID_ARGUMENT`), and without one the value stays `0x0` and the summary carries a warning that the call may revert
  without the fee; with one, the summary says it is the TapeOut fee and goes to TapeOut, not to the recipient. The fee has
  no getter: the SDK neither reads nor hard-codes it (simulate the transaction and read the revert data). The inner
  value is still always 0 and a non-zero `tx.value` is still refused. Types and the container-agents guide are updated.

## [1.7.1] — 2026-10-05

### Changed

- **`@tapeapi/sdk/agent` (experimental): revocation in a task thread follows the draft TAP (TAPs PR #47, §7.5-§7.6).**
  The subpath is outside the 1.x compatibility promise; these change what 1.7.0 reports.
  - A revocation, whether a `revocation` message in the thread (wherever it sits) or the principal's site list found
    while checking the applied mandate, now only sets the thread's revocation time R, the smallest `issued` of the
    revocations that apply. It never changes the state when met. An agent message signed after R is refused
    (`message-after-revocation`); a verdict is allowed whatever its `issued`; only the final checks turn a thread still
    `Offered`, `Accepted` or `Active` into `Cancelled`, before `Expired`, and only once R is not after `at`. Because R
    depends on the applied mandate, which depends on the accept, the thread is read twice and the second reading's
    problems are reported.
  - In 1.7.0 a site list covering the mandate made the thread `Cancelled` at once with `mandate-revoked` and every
    later message `out-of-order`, even a delivery and verdict signed before the revocation; a revocation message
    cancelled `Offered`, `Accepted` or `Active` when met, and was accepted silently in `Cancelled`. Now a thread
    delivered and accepted before the revocation still reads `Settled`, by either path, and the same revocation gives
    the same result as a message or as a site list. `mandate-revoked` is no longer reported in a thread
    (`verifyMandate` on its own still reports it).
  - A revocation found while checking a mandate that the thread refuses (for example `nonce-reused`) no longer sets a
    revocation time.
  - `tapeapi-verify task` prints the new result for such threads, and its `revoked: yes, at N (via)` line is now
    `revocation: at N (via); agent messages signed after it are refused` (or `revocation: none`): the revocation time
    refuses later agent messages and does not by itself mean the thread was cancelled. The `revoked` member of a thread
    result keeps its shape and now means that revocation time.
- **`@tapeapi/sdk/agent` (experimental): the principal's revocation file is read as the draft's §6.2 says.** A missing
  file is `fileInfo.chunkCount` 0 (it was `size` 0; TAP-10 §7.1); the file is read from the first site store of the
  chain that has any path for the principal (TAP-11 §2.2 step 3), and only while the site store and the payment
  contract run implementations TAP-10 lists as accepted (TAP-10 §6.1; otherwise the list is invalid, so every mandate
  of that principal is `revocation-unavailable`, as for any unreadable list); a file that begins with a byte order mark
  is invalid (it was silently stripped). `createAgentKit` now refuses, when it is created, a chain the SDK does not know
  or a site store or payment contract with no implementation TAP-10 lists as accepted (`INVALID_ARGUMENT`, as the
  conformance mode does), instead of reporting `revocation-unavailable` on every check.
- **Test vectors:** `spec/vectors/container-agent.json` gains `threadRevocation`, fifteen abstract thread cases whose
  results are worked out from the draft, the boundaries included (an accept or a delivery signed exactly at the
  revocation time is allowed; a revocation time equal to `at` cancels, one second later does not); the SDK is checked
  against them on real signed threads and `verify.py` checks them with an independent model of §7.4-§7.6 (514 to 561
  checks).

## [1.7.0] — 2026-10-05

### Added

- **`@tapeapi/sdk/agent` (experimental): container agents, phase 0.** A new subpath, outside the 1.x compatibility
  promise (the formats follow the public Ideas TapeOutProtocol/TAPs#40 and #41 and may change with that discussion).
  Phase 0 has no enforcement: a mandate is a holder's signed statement, every check says `enforcement: 'none'`, a
  mandate naming any amount is refused, and a payment is a plain transfer verified read-only (TAP-10 §19). It adds four
  holder-signed EIP-712 types (`Mandate`, `TaskOffer`, `TaskVerdict`, `MandateRevocation`; domain "TapeAPI", hub as
  `verifyingContract`), `createAgentKit` (verify a mandate, a task thread and an evidence bundle; read revocations;
  `identityOf`), `createPaymentKit` (payment orders, `transferToContainer`, `viaContainer`, `recipientOf`,
  `describeTx`, and a 15-step payment check), `revocationFileBytes`, and `forWallet(td, { chainId, hub })`, which every
  typed-data result must pass through before it reaches a wallet (it strips `warnings` and `display`, and rejects a
  payload whose chain or hub is not the one the console expects). A task is the message sequence offer, accept, mandate,
  deliver, acceptance, revocation. Test vectors:
  `spec/vectors/container-agent.json` (the vector set goes from 480 to 514 checks; `verify.py` agrees with the SDK).
- **`validateAgentMember` and the manifest's optional `agent` member** (experimental).
- **`examples/agent-service/`: a runnable agent service and a hiring script** (offline demo world with a fixed clock).
- **`tapeapi-verify task <thread.json> [--payment <recipient> <index>] [--rpc <url>...]`: check a task thread** (and,
  with `--payment`, the payment) from the command line. The first argument `task` used to be an error and is now this
  subcommand; every other invocation behaves as in 1.6 (the output of ten argument shapes is pinned byte for byte).
- **`DEFAULT_CONTRIBUTION_BPS = 100`** is exported next to `MAX_CONTRIBUTION_BPS`.

### Changed

- **Maintenance contribution: the contract cap is 20% (was 50%), the default stays 1%.** `MAX_CONTRIBUTION_BPS` goes from
  5000 to 2000 in the SDK and in `contracts/src/TapeAPIEscrow.sol`; `setContribution` refuses more than 2000. The
  escrow now keeps "never set" apart from "set to 0" (a provider set to 0 contributes nothing; one never set pays the
  default 1%), and `Settled` carries the `bps` that was applied. TAPI-22 says the directory MUST NOT rank or badge
  services by contribution. The escrow is still not deployed and not audited, so no live channel is affected. Guides,
  FAQ and `BUSINESS.md` now say 20%.
- **Revenue share: the basis changes from 2026-10-05.** The permanent 10% for @Theairresearch is now 10% of each
  calendar quarter's revenue after the direct cash costs paid to third parties (rented services and infrastructure, audit fees, gas,
  related compliance and legal fees; never labour), settled quarterly with public accounts of income, deductions and
  payout. Payments received before 2026-10-05 are still shared under the earlier promise (10% of any revenue). See
  `BUSINESS.md`.

### Fixed

- `formatUnits` returned a wrong string for a token with 0 decimals (`10` showed as `.1`); the payment summary was the
  first caller to pass a decimals value read from a chain.

## [1.6.0] — 2026-10-04

### Added

- **`createVerifyingFetch({ requestUsage: true })` and `tapeapi-verify --request-usage`: the usage of a streamed OpenAI
  Chat answer can be checked** (opt-in; off by default, and only `true` turns it on). An OpenAI Chat stream carries usage
  only when the request sets `stream_options.include_usage`, and the official `openai` package does not set it (at the
  time of writing, 7.x). When a
  streamed request does not, the sidecar asks the upstream for the usage itself and takes the usage chunk out of the
  client's copy (`usageInjected`), so no client could compare the receipt's usage with anything (it was listed in
  `unchecked`, 1.5's "remaining by design"). With the option, the verifying fetch (or the proxy) sets
  `include_usage: true` in the request's bytes before sending: the sidecar then injects and strips nothing, sets no
  `usageInjected`, and the usage chunk is part of the signed stream the application receives, so the receipt's usage is
  compared with it as a whole answer's is. This changes no wire format, digest or vector. It does not prove the
  upstream's own count: it gives usage the standard a whole answer already has, that the receipt states what the
  application was handed, so an overstated usage is signed into an answer the application can see (attributable), and a
  receipt that disagrees with the stream fails (`RECEIPT_INVALID`; FIXED AI-ASK-1, AI-ASK-END). Details:
  - *What changes in the request.* Only for a request the sidecar would itself change (a stream OpenAI Chat request whose
    `stream_options.include_usage` is not `true`), one splice in the bytes, every other byte kept: no `stream_options` gets
    `,"stream_options":{"include_usage":true}` after the last member; an object without `include_usage` gets
    `,"include_usage":true` inside it; an existing `include_usage` (`false`, `null`, `0`, `"true"`, ...) has its value
    replaced by `true`; a `stream_options` that is not an object (`null`, an array, a string, `false`) is replaced by
    `{"include_usage":true}`. The result is checked before it is used: it must parse to exactly what the sidecar's own
    rule (`prepareUpstream`) gives, and the sidecar's rule must have nothing left to change. The order is body, splice,
    salt, `content-length` removed, send; `requestSha256` is the hash of the bytes finally sent.
  - *What is left alone, and what then happens.* A compressed body (`content-encoding`), a Content-Type that is not JSON
    (`content-type`), a body that is not UTF-8 (`not-utf8`) or starts with a byte order mark (`not-object`), a format with
    `prepareUpstream` but no `usageMember` (`no-member`), a key that appears twice at the top level or inside
    `stream_options` (`duplicate-member`; a duplicate deeper down is kept as it was), and a splice whose self-check fails
    (`self-check`; a body nested deeper than `JSON.stringify` can go is one). With `strict` the SDK throws
    `INVALID_ARGUMENT` before sending (`data: { reason, format }`) and `tapeapi-verify --strict` answers HTTP 400
    (`usage_request_skipped`, with `x-should-retry: false`) without forwarding; otherwise the request goes as it is, the
    report says `usageRequestSkipped: <reason>`, and the usage stays in `unchecked`. A request that asks for usage
    itself, is not a stream, or is not an OpenAI Chat request is not touched (no skip reason).
  - *Reports.* With the option on, every report on a receipt path carries a boolean `usageRequested` (`false`: this
    fetch did not set the member, because the application asked itself, it is not a Chat stream, or the splice was
    skipped), and possibly `usageRequestSkipped`; with it off neither field exists. `tapeapi-verify --log` writes the same
    fields, the verdict line says `usage=asked` or `usage-request-skipped=<reason>`, and the start-up line says
    `(usage requested)`. If the request asked for the usage and the stream carries none, there is a warning ("the request
    asked for the usage (requestUsage), but the stream carries none: the upstream did not send it, or something on the way
    took it out"). If the receipt states a usage the stream lacks, that is a failure as before; if it states none, it
    passes with usage `null`.
  - *What an application sees.* One more chunk before `[DONE]` with `choices: []` and the usage, as when it sets
    `include_usage` itself; nothing is taken out on the client, which is why the bytes it holds are the bytes the receipt
    hashes. Code that reads `chunk.choices[0]` without a guard throws a `TypeError` on that chunk; the `.stream()` helper of
    the `openai` package works, and `finalChatCompletion().usage` has the value. Claude Code (Anthropic Messages) and
    Codex (Responses) streams carry their usage already and are not touched; Embeddings do not stream.
  - *Limits and risks (the reasons it is off).* A JSON body sent with a non-JSON Content-Type is skipped by the client
    while the sidecar, which does not look at Content-Type, still injects: that call's usage is not checkable (strict
    refuses it locally). An upstream that ignores `include_usage` leaves a verified receipt with usage `null` and the
    warning above. A sidecar that does not inject (the reference has no switch for it; it takes a custom `formats` table
    whose Chat adapter has no `prepareUpstream`), because its upstream rejects `stream_options`, will see these calls
    fail with HTTP 400 once clients turn this on. A third-party sidecar that strips the usage chunk although the
    request asked for it fails under `strict`. The salt now also reaches the upstream for these requests (the sidecar's
    re-serialising used to drop it): it is whitespace after the JSON text, which JSON allows, and is not yet measured
    against the live APIs. Under `strict`, the
    official SDKs may wrap the `INVALID_ARGUMENT` as a connection error and retry it up to `maxRetries` times (not
    measured; no request is sent in any retry).
  - *Interfaces.* New: `requestUsage` (`createVerifyingFetch`), `usageRequested` and `usageRequestSkipped` on the
    `onReport` report, `usageMember` on `AIFormat` (`['stream_options', 'include_usage']` for `openai-chat`; a custom
    adapter without it is never rewritten), `UsageRequestSkip`, and `ai.requestUsageBody` (`@internal`, used by the
    sidecar and `tapeapi-verify`). With the option off nothing new runs and the default client path is byte for byte
    1.5.0's (GOLDEN AI-1.5, recorded on 1.5.0 before this change). The [guide](docs/guides/ai-providers.md) has the three
    ways to get a stream's usage checked.

### Fixed

- **The reference sidecar re-serialised the request it sent upstream (FIXED AI-RESER; every version with usage
  injection).** To ask the upstream for the usage of a streamed Chat request, it sent `JSON.stringify` of the parsed
  body, which changed more than that one member: `seed: 12345678901234567890` reached the upstream as
  `12345678901234567000`, `1e400` became `null`, a repeated key was merged, whitespace and escapes were rewritten and the
  client's salt was dropped, against TAPI-21 §3.5 ("MUST NOT change … in any other way"). It now sets `include_usage` in the
  client's bytes with the same function the client uses (above), so every other byte arrives as sent; receipts are
  unchanged. Where the splice refuses, the sidecar re-serialises as before: a key repeated at the top level or inside
  `stream_options` (the repeated keys are merged), a byte order mark, a Content-Type that is not JSON, a custom format
  without `usageMember`. This needs `@tapeapi/sdk` 1.6: `@tapeapi/server` takes the function from the SDK's root entry, and
  with an earlier SDK installed it falls back, silently, to re-serialising (the server's dependency range moves to
  `^1.6.0` with the release).
- **Three smaller fixes around `requestUsage` and the sidecar** (FIXED AI-ASK-CASE, AI-RESER-SDK). A key that differs from
  `stream_options` (at the top level) or from `include_usage` (inside `stream_options`) only in letter case, after the JSON
  escapes are decoded, now makes `requestUsage` skip the request (`duplicate-member`): a gateway whose JSON decoder ignores
  case and lets the later member win (new-api and one-api are Go programs) would otherwise read `include_usage` as false.
  The sidecar logs one line when `@tapeapi/server` 1.6 runs with an `@tapeapi/sdk` older than 1.6 (the request is then
  re-serialised the way 1.5 did, so the fix above does not apply; the server's dependency range is raised to `^1.6.0` with
  the release). And a streamed Chat request nested thousands of levels deep, which made the sidecar answer HTTP 500, now
  gets its HTTP 400 `request_too_deep` (with `x-should-retry: false`; setting `include_usage` yourself sends it on as it is).

### Security

- **Release integrity.** Every GitHub Action in the workflows is pinned to a commit SHA (with its tag in a comment), and a
  test keeps it so. From v1.6.0 on, every Release carries a `SHA256SUMS` file next to the two tarballs, made by
  `scripts/release-checksums.mjs` from the uploaded files, and the release notes repeat it. SECURITY.md gains §5,
  "Verifying a release": how to check, what a checksum on the release page proves and what it does not, and why there is
  no build attestation (releases are built by hand, not by CI).

### Documentation

- The [AI providers guide](docs/guides/ai-providers.md) gets "The usage of a streamed Chat answer: three ways", with what
  each way guarantees and what it does not. TAPI-21 §3.5 (usage injection) gets one explanatory paragraph in both
  languages: a client can ask for the usage itself, and the sidecar then changes and strips nothing and sets no
  `usageInjected`. It adds no MUST, SHOULD or MAY and changes no frozen constant or vector. The verification page's note
  on an unchecked usage now says the client can ask for it.

## [1.5.0] — 2026-10-03

### Added

- **TAP-10 conformance mode: the messaging path** (experimental). Under `createTapeAPI({ conform: 'tap10' })`,
  `api.chain.tapeSendKey` resolves the endpoint as TAP-10 §12.2 says and reads the key as §14.4 steps 1–3 say, and
  `api.chain.channelKeys` (so `groupVerifier` too) reads the channel record under the same rules: a fresh TAP-10 pinned
  block per lookup, strict agreement on every read (every configured node, all equal, at least max(2, min(3, operators))
  operators) and on `eth_chainId` (§5.4), the container from the opener. `tapeSendKey` also checks the hub at that block
  (§13.8): an implementation other than the current one TAP-10 lists is `hub-changed`, a circuit beacon off its
  implementation is `circuits-changed` (kept by the client), and the seal status is reported in `result.tap10.seal`; the
  key must belong to the resolved container and endpoint (`hub-mismatch`), be usable (`no-key`, `key-stale`) and pass the
  X25519 checks (`bad-key`). `channelKeys` needs both site-store implementations accepted (`store-changed`) and refuses a
  record with a byte order mark. Neither judges activation or opening (§12.2): the same unactivated container is `unpaid`
  to `resolve` and has its record and key read as usual. One node down or behind the pin now stops these reads in this mode
  on BNB Smart Chain's three default operators (strict; Base's four leave one spare, X Layer's two need no more than the
  quorum), not in the default mode, which is unchanged. Also new: `tapesend.endpoint`, `seal`, `open`, `messageId` and `sendTx` take
  `conform: 'tap10'`, which refuses a chainId above 2^53 − 1 (§12.1); `TAP10_SEALS` (the beacon, circuit implementation
  and current hub implementation of each chain, read back on chain 2026-10-02) and `TAP10_MAX_CHAIN_ID`. Input that may
  belong to another chain (an address that is no container here, a `token()` naming another chain, a processor contract
  that is no processor here) is `unsupported`, as in `resolve`, and never cached. A client with `conform: 'tap10'` now
  accepts only the hub, the processor factory and the container opener TAP-10 lists for its chain (`hub`, `factory`,
  `opener` set to anything else are `INVALID_ARGUMENT`, TAP-10 §2.2), a tightening of the experimental mode of 1.4 for
  `factory` and `opener`. The new option `sealStatusStore` (a `{ get, set }` store, like `channelRecordFloor`) keeps
  the sticky §13.8 statuses across restarts; without it they last as long as the client. The
  [guide](docs/guides/upgrade-1.0.md) has the statuses and codes.
- **TAP-10 conformance mode: the rest of the resolution path (experimental).** A container address or processor
  contract#ID now finds its processor number (TAP-10 §4.3), so it gets its on-chain name and a full activation check
  (`isLive` as well as `isContainerLive`): the SDK ships each chain's processor table (`sdk/src/processors-snapshot.js`,
  read-only through the default nodes before each release; on 2026-10-01 (UTC; the snapshot's times are UTC) BNB Smart
  Chain 1,174, X Layer 263, Base 101 processors, each recorded with its block, count and node operators), uses a hit only
  after one `cpuAt` at the pinned block gives back the same address, and otherwise scans `cpuAt` at the pinned block in
  pages of 8, at most 256 numbers per resolution, resuming at the next one (`unavailable` with `data.scan` until then);
  only the numbers after the snapshot are scanned once the chain agrees with it, so a cold client does not send a
  thousand requests to one node. The new option `createTapeAPI({ allChains: true })` resolves a container address or
  processor contract#ID string on every TapeOut chain, each at its own pinned block (TAP-10 §4.1): two chains resolving
  it is `INVALID_ARGUMENT` with `data.status` `ambiguous` and `data.candidates`; a chain that cannot be read, or whose
  site contracts are `store-changed`, is reported with its own status (and `data.chainId`) instead of a guess or
  `not-tapeout`; results and these errors carry `chains`, what each chain said (`siteStatus(...).chains`,
  `svc.conform.chains`, `data.chains`). It sends reads to the nodes of Base and X Layer, which is why it is off unless
  asked: only `true` turns it on, any other value is ignored. It applies to `resolve` under `conform: 'tap10'` and to
  `siteStatus` in any mode, never to the default `resolve`, and `forChain` passes it on. With it, all 23 TAP-10 Test
  Cases that `node scripts/tap10-gap.mjs` judges offline conform (18 in 1.4). The [guide](docs/guides/upgrade-1.0.md)
  has the rules; `resolve` and the `chain.*` reads of the default mode are unchanged (GOLDEN TAP10-0).
  `resolve` in this mode now reads what would authorise a signer under strict agreement (TAP-11 §2.2, TAP-10 §5.2):
  `ownerOf`, and for a holder that is a contract the EIP-1271 calls (`eth_getCode` and `isValidSignature`, for the
  delegation and for `contentSig`); its `eth_chainId` check is the strict one the messaging path makes, before any state
  is read. Strict needs every configured node to agree, from max(2, min(3, operators)) operators, and a node that does
  not answer or has not reached the pinned block yet (TAP-10 §1: "no such block" is no answer) counts against that. On
  the default nodes: BNB Smart Chain (3 operators) now stops with one node down or behind the pin where 1.4 resolved;
  Base (4 operators) still resolves with one node down, not with two; X Layer (2 operators) is unchanged. With
  `contentSig` present and `requireContentSig` off, a contentSig check that fails this way is the warning
  `CONTENT_SIG_UNCHECKED`, as before. Every other read of a resolution, and `siteStatus` (its chain check included), keep
  default agreement; a strict read's `RPC_UNAVAILABLE` now says how many operators it needed. With the messaging path
  above, this closes the resolve and messaging paths of the mode; the hub's `Upgraded` log scan (TAP-10 §13.8, a
  conditional SHOULD) is not done.

### Changed

- **TAPI-26 erratum: an invite sent by TapeSend is sealed to the recipient's usable TAP-10 key**, read from the hub,
  never to the recipient's channel key: TAP-10 §14.4 and §15.3 allow a sender no other key, and TAP-10 then governs the
  message completely. §3.2 said "sealed to B's static key". The durable fallback therefore reaches only a recipient that
  also holds its TAP-10 key (a TAP-10 client, or a channel with `keys: "tapesend/v1"`); a TAPI-26 client with channel
  keys alone (`keys: "tape-channel/v1"`) cannot receive it, and §3.1 already asks other implementations not to derive a
  TapeSend key. §5 records the correction: no implementation had sent or received such an invite, and no code changed
  (the SDK never built one). Six section references in §3.1 and §3.2 (both languages) now follow TAP-10 v1.1 (§14.2;
  §15 and §16; §16). Keyword counts and frozen constants such as the `TAP-26/…` labels are unchanged.
- **Input without chain information, and `siteStatus` in any mode.** Under `conform: 'tap10'` without `allChains`, a
  processor contract#ID string (`0x…#ID`) is now `INVALID_ARGUMENT` with `data.status` `unsupported` before any
  request, because TAP-10 §4.1 resolves it only when exactly one chain does (in 1.4 it was resolved on the client's own
  chain when that chain had the processor); `{ circuits, tokenId, chainId? }` resolves it on one named chain as before.
  A container address is still resolved on the client's chain when it is a container of that chain, and is
  `unsupported` otherwise; the error now names `allChains: true`. The 1.4 `unsupported` for a container or processor
  contract#ID whose processor number was unknown is gone, along with `activation.isLive: null`. `siteStatus`, in any
  mode (it is the TAP-10 path on a default client too), changes with it: a container address or processor contract#ID
  gets its `name` and `processor` (null in 1.4) and a cold client reads `cpuCount` and `cpuAt` to find them; an object
  form that names its chain (`{ circuits, tokenId }`, `{ chainId, container }`) gets that chain's `not-tapeout` where 1.4
  said `unsupported`; on a default client a processor contract#ID string is still resolved on the client's chain, as in
  1.4.

### Security

Streamed AI receipts: four related fixes to `ai.createVerifyingFetch` and `tapeapi-verify`, with matching changes to the
offline check (`verifyUsageReceipt({ responseBytes })`, `scanSse`, the verification page) and the sidecar. The receipt
hash (TAPI-21 §3.5) and its test vectors are unchanged; TAPI-21 §8 gains an informative note on streams that parsers read
differently, with no new requirement.

- **A stream cut short could verify (1.0.0–1.4.0).** Both clients check a stream where it first ends (its final event,
  `[DONE]` or the upstream closing, whichever comes first), but they took the receipt hash, and let the format adapter
  read the answer, only after processing the whole network chunk that carried the end. Events after the end that came
  in that same chunk were counted as part of the checked answer, although a client that stops at the end (the official
  OpenAI SDKs stop at `[DONE]`) never sees them. So a party on the path (a proxy, a CDN, or the service itself) that
  moved the receipt comment earlier and inserted a `[DONE]` could hand the client an OpenAI Chat or Responses stream
  cut off before its real end that was reported as verified, and that strict mode released, whenever the inserted
  `[DONE]` and the rest reached the client in one chunk. `tapeapi-verify` without `--strict` checked the receipt against
  the whole stream when the upstream closed, so it logged such a stream as verified however it was cut. Anthropic
  Messages streams, which have no sentinel, were not affected by this one. The scanner now keeps the hash, event count
  and offset where the stream first ended (`info.digestAtEnd`, `info.eventsAtEnd`, `info.endOffset`), the receipt is
  checked against them, and the adapter reads up to the end only.
- **Strict passes the stream on up to its end and closes it there.** Strict used to release the whole chunk that carried
  the end, so whatever followed the end in it (a comment, an event without data, half an event, a second `[DONE]`)
  reached the application, and an event after the end in a later chunk failed the stream. Now the chunk goes on up to
  the end only, the stream closes and the upstream is cancelled (`tapeapi-verify --strict` ends the answer there), so
  what the application receives does not depend on how the bytes were cut, save one byte: when the blank line that ends
  the stream is a CR at the end of a chunk, the stream ends at that CR and an LF that may follow is not waited for (every
  client dispatches the event without it, and an upstream that then sent nothing used to hang the stream). Not strict still passes every byte on and
  reports an event after the end once as a failure (`an event after the end of the stream is not covered by its
  receipt`), in the chunk that ended the stream or a later one; before, `strict: false` reported nothing for it.
- **Two stream shapes that clients parse differently from the receipt rule now fail closed (all versions with streamed
  receipts).** An event the stream closes on before its blank line is discarded by the rule, but the OpenAI SDK
  dispatches it when the body ends: content appended that way after a verified Chat stream with its `[DONE]` removed,
  or after a Responses `response.completed`, reached the application as verified. And a line that starts with U+FEFF
  (other than at the very start of the stream) is an unknown field to the rule, but both official SDKs, OpenAI and
  Anthropic alike, strip a byte order mark from every line and read it as a data line: content could be inserted
  anywhere in a signed stream of any of the three formats without changing its hash. Strict now ends such a stream with
  `RECEIPT_INVALID` (a line led by U+FEFF is not passed on), `tapeapi-verify --strict` with its error event, and not
  strict reports each once as a failure. The offline check reports both shapes as problems too (`scanSse` now returns
  `ambiguous` and `unfinished`; the verification page fails the response check and says why), so a stream that verified
  offline although clients were shown more than the hash covers no longer does. The reference sidecar no longer signs a
  stream with such a line before the point where it signs (one after it, past the end, is cut off by strict clients and
  reported by the others). A few rare honest shapes are refused as well, since clients would read them differently: a
  stream whose upstream broke off in the middle of an event, after which the sidecar added its receipt line; a stream
  that starts with two byte order marks; a line that is only a byte order mark; and a data line led by a byte order
  mark after a CR line end.
- **`tapeapi-verify` without `--strict` could log nothing.** It checked the receipt only when the upstream closed, so a
  client that hung up at the end (the openai SDKs stop at `[DONE]`) while the upstream kept the connection open left no
  verdict. The receipt is now checked and logged as soon as the stream ends, and when the client hangs up after the end.

`verifyUsageReceipt({ responseBytes })` over a whole stream hashes every event in it, as TAPI-21 §3.5 says, so for a
stream with events after its end its verdict can differ from the streaming check. Tests replay signed streams of each
format, honest and edited, under many cuttings (one event per chunk, whole, byte by byte, seeded random cuts, LF and
CRLF), strict and not, and assert that the verdict, and in strict mode the bytes handed on, do not depend on the cutting.

Two more, from an adversarial review of the 1.5.0 candidate:

- **A receipt could switch off its own usage check (every version with AI usage receipts).** `verifyUsageReceipt`,
  and so `ai.createVerifyingFetch`, skipped the usage comparison whenever the receipt said `usageInjected: true`, even
  when the client held a whole answer whose usage it could read. A receipt signed with the service's own key (which
  whoever runs the sidecar holds) could therefore claim any usage and matching prices and still verify against the
  answer it came with. The flag now counts only where the client's copy can lack the usage: a stream, of a format that
  injects (OpenAI Chat), for a request that did not itself ask for usage. A whole answer is always compared, and a
  stream whose request already asked, or of a format that never injects, that claims the flag is a problem. The honest
  sidecar's receipts all still verify, including the one for a stream request answered as JSON. The verification page
  compared only the hashes of pasted bytes; it now also reads the pasted answer with its format (a new `answer` check:
  id, model, usage, completeness), as TAPI-21 §3.5 check 4 asks. The wording of that check now says when the usage
  cannot be compared, with no new requirement. A verifier with no content type of its own (the page, and
  `verifyUsageReceipt` called without `stream`) took the receipt's own `stream` on trust, so a whole JSON answer under a
  receipt re-signed as a stream with the flag was read as a stream without usage and its usage skipped; such a pairing
  now fails (`ai.isWholeJson`; on the page, the response check says why). `createVerifyingFetch` was not affected: it
  passes `stream` from the response's content type.
  Remaining by design: the usage of an injected stream (a streamed OpenAI Chat request that did not set
  `stream_options.include_usage`) cannot be checked by anyone, since the client never receives the usage chunk; a client
  that asks for the usage itself avoids that. Having the verifying fetch ask for it is a candidate for 1.6.
- **Hidden text in MCP tool definitions (every version with the invisible-character check).** `mcp.invisibleProblems`, used by
  the signing proxy, `tapeapi-mcp` and the holder console, refused format characters (category Cf) and controls only.
  Variation selectors (U+FE00–FE0F, U+E0100–E01EF: 256 invisible code points, enough to spell any text) and code points
  that render blank although they are not Cf passed: every Default_Ignorable_Code_Point outside Cf, assigned or not
  (U+034F, the Hangul fillers, the Mongolian free variation selectors U+180B–180D and U+180F, U+2065, U+FFF0–FFF8,
  U+E0080–E00FF, U+E01F0–E0FFF, ...), the braille blank U+2800 and U+1D159. So a description or another pinned field could
  carry instructions a model reads and the holder approving the digest cannot see. They are now refused, except a single
  U+FE0E or U+FE0F directly after an emoji character ("⚠️" stays allowed); a battery of real descriptions in a dozen
  scripts, with emoji, keycaps, NBSP and combining accents, still passes. A tool set already pinned that uses any of them, an ideographic
  variation selector in Japanese text included, is now refused (`INVISIBLE_CHARACTERS`) until it is changed and
  republished.

### Fixed

- AI sidecar: an `x-tapeapi-sidecar-error` header from the upstream is no longer passed on (a client reads it as "the
  sidecar answered itself" and reports a transport failure for a signed answer).
- AI sidecar: a path with an encoded `/` or backslash (`%2F`, `%5C`, any case) is refused with HTTP 400 `bad_path`
  before anything is forwarded, since an upstream may decode it into a separator; `ai.loosePath` reads both as `/`, so
  the verifying fetch (and `tapeapi-verify`) reports the same URLs as a path mismatch (strict refuses them).
- An `id` with a lone UTF-16 surrogate has no canonical form: the provider binds it as no id (a signed `BAD_REQUEST`,
  where it could fail with HTTP 500), and `api.call()` refuses it with `BAD_REQUEST` before sending.
- JSON-RPC: a single (not batched) answer whose `id` is not the request's, or is missing or `null`, now counts as a node
  that did not answer, as a batch element with the wrong id already did: an `id: null` answer that is not a node limit
  (a result, or a revert) is no longer taken as an answer about the chain. A node-limit refusal with `id: null` stays a
  refusal.
- MCP: an upstream `isError` that is not a boolean is refused before signing by the signing proxy, and `tapeapi-mcp`
  refuses such a signed result as not an MCP tool result: what was signed and what was shown could disagree (a signed
  `"true"` was shown as a success). Text imitating the provenance line is now labelled in an embedded resource's `text`
  and a resource link's `name`, `title` and `description` too; the instructions name `structuredContent` as data.
- AI receipts: a usage count of `-0` from the upstream is read as 0; the sidecar answered HTTP 500 because canonical JSON
  has no `-0`.
- `canonicalJSON` refuses the holes of a sparse array (it wrote `[1,,2]`, which is not JSON); the holder console's copy
  does the same.
- With `clientIpHeader` set, the header's address is written one way per address (IPv6 compressed and lowercase, an
  IPv4-mapped IPv6 address as its IPv4, anything that is not an address `"unknown"`), so one client cannot take several
  rate-limit keys by spelling its address differently; the new-api and LiteLLM sidecar examples do the same. Without
  `clientIpHeader` nothing changes.

### Documentation

- *Calling services for people you do not trust* (consume guide): the SDK does not refuse private or internal endpoint
  URLs, which are valid in a manifest; a server or agent that resolves services for others should pass
  `createTapeAPI({ fetch })` a wrapper that refuses them (an example is given).
- Upgrade guide: on a chain with two operators (X Layer's default nodes) one operator can hold a pinned read back as far
  as `maxPinAgeS` (`pin: true`) or `tap10MaxPinLag` (TAP-10 mode) allows, and the client then reads the manifest as it
  stood then; `delegationFloor` does not cover it. A third operator's node closes the window.

## [1.4.0] — 2026-10-01

### Added

- **TAP-10 conformance mode: the resolution path.** `createTapeAPI({ conform: 'tap10' })` resolves on the TAP-10 v1.1 /
  TAP-11 §2.2 path (`false`, `null` or leaving it out means off, as before), with `pin: 'tap10'` (also usable alone) and the
  read-only `api.siteStatus(target)`. The default behaviour is unchanged. In this mode:
  - the whole resolution is pinned to one block by TAP-10 §5.3: each operator's lowest head, the Q-th highest minus 2,
    `stale-block` by block distance (BNB Smart Chain 400, Base 150, X Layer 300), no clock; the block hash is then
    confirmed by every answering node (the SDK keeps its stronger pin by hash);
  - the site store's and the payment contract's implementations are read at that block and fail closed (`store-changed`);
  - the container is derived through `opener.accountOf` and checked against the local ERC-6551 derivation, and
    `isOpened` and the activation of the name (`isLive`, `isContainerLive`; a revert counts as false, TAP-10 §6.3) are
    read: a name that is not opened or not activated fails with the new code `SITE_STATUS` (`data.status`: `not-opened`
    or `unpaid`). Every error in this mode carries `data.status`, TAP-10's lowercase name;
  - the input forms of TAP-10 §3.4 are accepted (`#4246@0`, `tape://4246.0/`, `0x…#ID`), an input with no processor
    number whose activation cannot be told is answered `unsupported` (the all-chain lookup is planned for 1.5);
  - `eth_chainId` is checked; only a result or a revert counts as an answer (TAP-10 §1); the holder and the site
    state are read again after 60 s.
  Activation is judged by `resolve` and `siteStatus` only: `channelKeys` and the TapeSend key of an unactivated
  container are still read (TAP-10 §12.2). Today both `11.1013.tape` and `12.1013.tape` answer `unpaid` in this mode:
  neither is activated. Also new: `rpc.tap10Block`, `{ answers: 'tap10', strict }` on `call` / `ethCall`,
  `parseTapeInput`, `MAX_TOKEN_ID`, `MAX_PROCESSOR`, `CONFORM_TTL_MS`, `tap10MaxPinLag` in `chains.js`. The
  [guide](docs/guides/upgrade-1.0.md) lists what stays for 1.5 and the limits (two-operator chains pin more weakly).

- **The monitor reports each service's activation** (TAP-10 §6.3): the paid-until date and days left, or the `monthlyFee()`
  read at that moment when the name is not activated. Not activated, and under 14 days left, are warnings; under 3 days
  or expired is a problem. The exit code is otherwise unchanged (today both of our services are not activated, and the
  run is still healthy). It adds 6 `eth_call` requests per run to each node.
- **`tapeapi-doctor` checks activation** (now 14 checks). It reads DomainBinding `isLive(name, container)` and
  `isContainerLive(container)` (a revert counts as false, TAP-10 §6.3). A name that is not activated is a warning, not a
  failure (a TAP-11 client answers `unpaid` and does not resolve the service; `--strict` makes it fail), with the `bind`
  hint and the fee `monthlyFee()` reads at that moment. The guide has a new step 2b. Run against `11.1013.tape` and
  `12.1013.tape` today it warns: neither is activated.
- `node scripts/tap10-gap.mjs`: a diagnostic that runs TAP-10's own Test Cases through the SDK's name resolution and prints
  where it conforms and where it does not (offline; of 23 cases that can be judged offline, 12 conform and 11 are known
  gaps, each with its TAP-10 section). `sdk/test/tap10-gap.test.mjs` pins the current results (`CONFORMS`, `KNOWN GAP`),
  so the opt-in TAP-10 mode that is planned can flip them. Not part of the public SDK interface.

### Changed

- **Name range (erratum, all modes).** Names are limited to #ID ≤ 10^18 and processor number ≤ 10^9 (TAP-10 §3.1); up to
  1.3, 78 digits were parsed. Such names cannot exist on chain, so a name that used to cost lookups is now refused with
  no request. The error text for a name that was already refused changed with it.

- The status of the TAP drafts is stated: the service manifest and delegation was merged as TAP-11 (Draft,
  TapeOutProtocol/TAPs#8) and seven more drafts are under review (#10, #12, #16, #18, #20, #26, #28). TAPI-20 to
  TAPI-27 remain TapeAPI's own names and the basis of the 1.x compatibility promise.
- **The specs are renamed TAPI-1 and TAPI-20 to TAPI-27** (they were TAP-1 and TAP-20 to TAP-27). TAP numbers belong
  to TapeOut's TAP process (TapeOutProtocol/TAPs, TAP-01 §6.1), where editors assign them and the multiples of ten are
  reserved for core standards; TapeAPI no longer uses any TAP number, and TAP-20 is left free. Parts of these specs are
  submitted there as TAP drafts: the service manifest (TapeOutProtocol/TAPs#8), signed responses (#10) and private
  channels (#12). Labels and constants that contain the old names (`TAP-26/…`, `TAP-27/…`) are frozen wire constants
  and do not change: no wire format or signature changes. Conformance check ids are now `tapi20.…` and so on. Earlier
  entries below use the new names.

### Fixed

- `tapesend`: an endpoint built from an address now sits on the recipient's chain. `seal`, `open`, `messageId` and
  `sendTx` take an optional `toChainId` (default: `chainId`, so existing calls are unchanged); before, the `to` endpoint
  of a cross-chain message used the sender's chain, which a TAP-10 client reads as a damaged payload (TAP-10 §15.3, §17).
  The official message-ID vector #2 (hub on Base, recipient on BNB Smart Chain) reproduces.

## [1.3.0] — 2026-09-30

### Added

- **Merkle proof mode (experimental, security roadmap 1.2; the light-client idea borrowed from Polkadot).**
  `createTapeAPI({ pin: true, proofs: true | 'strict' })` checks `cpuAt`, `isCPU`, `ownerOf` and `fileInfo` (size,
  `sha256Hash`) against EIP-1186 `eth_getProof` proofs of the pinned block's `stateRoot`, which nodes of `quorum`
  operators must agree on (`rpc.confirmedBlock(tag, { stateRoot: true })`); the manifest bytes are then checked against
  the proven hash. A proof may come from any node; every `eth_call` still goes through the quorum and is compared with
  the proven value. `true` warns and keeps the quorum reads; `'strict'` refuses with the new codes `PROOF_UNAVAILABLE`
  or `PROOF_INVALID`. It resists nodes that agree on false state, as long as the `stateRoot` comes from independent
  operators; it does not resist an upgrade of the contracts (that is real state) or all operators forging a header.
  RLP and Merkle-Patricia checks are the SDK's own (no new dependency), checked against ethereum/tests trie cases by
  both the SDK and `verify.py`; vectors `spec/vectors/tapi-20-proof.json`; TAPI-20 §3.2 note, §6.5; `svc.proofs`, the
  `proof` namespace. Default unchanged. Which default nodes serve proofs (2026-09-30): Alchemy on BNB Smart Chain,
  dRPC on Base, none on X Layer at the `safe` block (add your own node to use `'strict'` there).
  A proven value that contradicts the quorum's answer is refused in both modes (`PROOF_INVALID`); `proofs: true` falls
  back only when no verified proof can be had, and is then detection only. A proof that does not verify moves on to
  the next node; only a node that refuses the method or serves a bad proof is skipped for 10 minutes, never for a rate
  limit or a timeout. A confirming node that omits the `stateRoot` is not counted (nodes of `quorum` operators must
  still report the same one). RLP nesting is capped at 64 and `proof.*` throws only `PROOF_INVALID`. Not proven:
  `contentSig`, EIP-1271 `isValidSignature`, `accountOf` (the sentinel derives it locally) and `serviceOf`. An
  independent review (77,000 RLP and trie cases, attacks on the whole resolution) found no way to forge a proof.
- **Provider directory at https://tapeapi.fun/directory/.** An AI service lists itself by a pull request to
  `site/directory/providers.json` once `tapeapi-doctor` passes; `.github/workflows/directory-recheck.yml` runs
  `tapeapi-doctor` on every entry once a day (read-only, no key, at most 60 JSON-RPC requests per name) and commits
  `site/directory/status.json`; an entry that cannot be read that day is `undecided` and keeps its last verdict. CI
  checks the format only. A listing only means the automated checks passed: it is not a recommendation, an endorsement
  or an audit. No ranking, no fees, no automatic removal; TapeAPI lists nobody itself and pays for nothing.

### Fixed

- **Resolve on BNB Smart Chain, X Layer and Base, found by testing 1.2.0's security options on all three mainnets:**
  - A rate limit is the node not answering, never an answer, whatever its code or wording (Coinbase's `-32016` and
    dRPC's code 15 inside a batch, HTTP 429, "too many requests", "quota"): on Base it used to surface as
    `RPC_DISAGREE`. A revert that happens to use those words is still an answer.
  - A pinned read that publicnode or Coinbase answers with "block not found: canonical hash" counts as that node lacking
    the block (only "not canonical" is still an answer).
  - The pinned block may be older on X Layer (`maxPinAgeS` 300 -> 600 s; its `safe` tag moves about every 228 s,
    measured up to 248 s old) and must be newer on BNB Smart Chain (180 -> 120 s; `finalized` measured 0 to 2 s old).
  - A request whose connection broke (not a timeout, not an answer) is sent once more after `transportRetryMs`
    (default 250 ms): X Layer has two independent operators, so one reset used to fail the read.
  - `createTapeAPI({ quiet })` reaches the clients it makes, so a default X Layer client no longer warns.
- **`tapeapi-doctor` and the AI relay path, found by walking the docs as a new operator:**
  - The docs no longer say `tapeapi-doctor` runs only from a checkout (1.2.0 ships it), and its "next" commands match
    how it was run: a checkout path, the npx form with the release URL, or the installed command.
  - URL mode probes the address you gave, and warns when the manifest publishes another one (it used to probe the
    manifest's endpoints, so a pre-publish check could pass against the wrong server).
  - Diagnoses that fit: a page that is not the sidecar (a reverse proxy or wrong port), a self-signed certificate in
    plain words, and an opened container without a manifest (sidecar, key, delegation, then publish).
  - `--lang en|zh` prints one language (`--json` adds `detailZh`); usage errors are bilingual.
  - Step 0 says `npm ci` first, and `examples/relay-trial` prints that command instead of a module-not-found stack.
  - PowerShell forms next to every shell variable example; `tapeapi-verify` needs its own terminal.
- The public relay's place is stated in the Public API guide: it is for testing and small-scale use (Cloudflare's free
  tier, about 100,000 requests a day for all users); apps with always-online users or groups over about 64 members run
  their own relay at their own cost.
- Website: the status line reads "Stable 1.x"; every "up to 32" mentions the experimental format 2 (up to 128); the
  verify page no longer repeats its hash-only notice; docs links have no `.html`, and the sitemap lists the upgrade
  guide.

- **Groups, format 2 (experimental), found by testing 1.2.0 across versions and on the public relay:**
  - The owner no longer checks every member again at each epoch: it reuses its positive verdicts within `verifyReuseS`
    (a new option on `createGroup` / `resumeGroup`; 0 checks all) for entries that did not change, and a new member
    is checked once. Rotating or removing one member of a 128-member group went from 127 checks (about 2,300 RPC
    requests) to 0; the first epoch after a verdict expires still checks everyone, at most once a day.
  - A format-2 `snapshot()` is now `v: 2`, which 1.0.0 to 1.2.0 refuse (`GROUP_INVALID`) instead of resuming it as a
    format-1 group and splitting it; the `v: 1` format-2 snapshots 1.2.0 wrote still resume.
  - One identity on two devices is no longer silent: `open()` returns a message signed with our identity that this
    handle did not seal, with `otherDevice: true`; `group.otherDevice` reports it; an "already seen" error carries
    `data.mayBeOtherDevice`. One identity is still one device (TAPI-27 §8).
  - "no key for epoch N" carries `data.reason` (`not-yet`, `expired`, `snapshot`) and `data.retryAfterEpoch`; an owner
    resumed from a snapshot no longer reports "fails authentication" for an epoch whose key it does not hold.
  - The groups guide says to check `invite.format` before joining (a client before 1.2.0 joins a format-2 group
    without error and then fails on every frame), how to buffer a message that arrives before its epoch, and the
    owner's cost per epoch.

 — 2026-09-30

### Added

- **Larger groups (experimental): TAPI-27 §3.8 format 2, up to 128 members in one wire message.** Binary roster
  (104 bytes a member), a marker in the epoch field that every format-1 client refuses (`GROUP_INVALID`, tested
  against the released 1.1.0 code), lazy member checks (`open().verified`, `openVerified`, `verifyMembers`,
  `verifyReuseS`, at most 86,400 s, counted from the start of the check), `channelKeysVerifier` (use it, not
  `api.groupVerifier()`, for format 2), vectors `spec/vectors/tapi-27-group-v2.json`. Only positive verdicts are reused;
  a negative one lasts at most 60 s (`VERIFY_NEGATIVE_S`), is confirmed by a fresh read and never refuses an epoch.
  On-demand and background checks share the `verifyConcurrency` limit. Format 1 stays the default and its bytes are
  unchanged (`joinGroup` without `format` ignores `verifyMember`, as before); one group never mixes formats. TAPI-27 §8 states what format 2 weakens (a
  verdict reused for up to a day; senders checked on demand) and what it keeps.
- **A path for AI relays, from nothing to live, with a check at every step.**
  - `examples/relay-trial/`: a one-command local trial (`node examples/relay-trial/trial.mjs`): the signing sidecar,
    a fake upstream and a throwaway identity, then verified calls (OpenAI Chat, streaming, Anthropic), the
    `tapeapi-verify` proxy and a tamper demo. No key, no circuit, no cost.
  - `tapeapi-doctor` (experimental, new bin in `@tapeapi/sdk`): checks an AI service in order (name, circuit,
    container, manifest file and format, delegation and days left, `ai` field, prices, endpoints, TLS and sidecar
    readiness, CORS, a verifiable receipt, receipt lookup) and gives each failure a fix in English and Chinese. The
    receipt check sends a request with an invalid key, which the gateway refuses and the sidecar still signs, so it
    normally costs nothing (a gateway that accepts any key spends a few input tokens and 1 output token, 16 on
    OpenAI Responses); `--key-env` makes one real, billed call on the operator's own key, sent only to the checked host
    over https (`--allow-http` for a loopback sidecar) and shown as `***` in every output, echoes included. Exit status 0 / 1 / 2 / 3 (3: the chain or the network could not be
    reached, retry) for CI; `--json`, `--strict`, `--offline`, and an address mode to check before publishing.
  - The AI providers guide opens with "From zero to live": each step, who pays, the command that checks it and what it
    should print.
- **Security hardening, learned from Polkadot's shared-security ideas (experimental; every option off or warn-only by
  default, 1.0 behaviour unchanged).** On `createTapeAPI`:
  - `pin`: every read of one resolution is pinned (EIP-1898 `blockHash`) to one block that nodes of `quorum` operators
    confirm at the chain's finality tag (`finalized` on BNB Smart Chain, `safe` on an L2); a block older than
    `maxPinAgeS` is refused as the new client code `RPC_STALE`. `svc.pinned` records the block. `rpc.confirmedBlock()`.
  - `sentinel` (`'warn'` default, `'strict'`, `'off'`): on the chain's own TapeOut contracts, resolve reads the ERC-1967
    implementation slots of the DeWebHub and the SiteRegistry and compares them with the known implementations, and
    derives the container locally (ERC-6551 CREATE2) to cross-check `accountOf`. It notices an upgrade; it cannot
    prevent one. `'warn'` reports in `svc.warnings` and `onWarning` (default: `console.warn` once); `'strict'` refuses
    with the new code `CONTRACT_UNKNOWN` or `MANIFEST_INVALID`. A failed slot read only warns.
  - `requireContentSig`: refuse a manifest without a valid holder content signature (TAPI-20 §3.10). Without it, a
    content signature is only reported (`svc.contentSig`, warnings), and an error while checking it is the warning
    `CONTENT_SIG_UNCHECKED`: it never fails a resolve.
  - `delegationFloor`: remember the highest delegation `expires` seen per chain, container, holder and signer, and
    refuse an older one put back (a rollback of a re-published manifest); a new signer starts its own floor, and
    `api.clearDelegationFloor(error.data)` forgets one. A site writer can still put back an older holder-signed
    delegation with a higher `expires`.
  - `onWarning`, `clock`.
- **TAPI-20 §3.10: optional holder-signed manifest content** (`contentSig`,
  `ManifestContent(address container,bytes32 contentHash)` in the delegation domain), so that whoever can write the
  site cannot silently change `ai.baseUrl` or prices under a valid delegation when the client requires it.
  `sig.manifestContent*` helpers, vectors `spec/vectors/tapi-20-content.json` (checked by `verify.py`).
- **`security` namespace**: `erc6551Account`; ContradictionRecord v1 (`contradictionRecord`, `contradictionsOf`,
  `verifyContradiction`): evidence anyone can check when providers sign conflicting answers to the same request at the
  same block (`verifyContradiction` says `valid` only when `signerOf` confirms every signer as the provider's
  delegated signer, otherwise `signaturesConsistent: true`; the block-pinned form suits methods whose result is
  deterministic); `withSpotCheck`, a wrapper that re-asks an independent provider at a given rate (0, off, by default).

### Changed

- Groups: the TAPI-27 §3.3 step 6 member checks run in parallel (`verifyConcurrency`, default 8), with the same outcome
  and errors as before. A 32-member cold start at 280 ms per request: about 45 s before, about 6 s now.
- Every `42.1013.tape` example says it is an example name (it has no manifest, so a command run as written stops
  with "no file at /.well-known/tapeapi.json") and points to the local trial; `tapeapi-verify` adds a hint to
  `tapeapi-doctor` and the trial when it cannot use a name.
- `ATTEST_DISAGREE` errors carry the verified signed envelopes and the request in `error.data` (`envelopes`,
  `request`), so the disagreement can be kept as evidence.
- A cold resolve on the chain's own contracts sends the sentinel's two ERC-1967 slot reads to each node alone, in the
  same round as the batch (never batched, so the `eth_call` batches stay those of 1.1.0): still 4 rounds, 18 requests
  instead of 12 on BNB Smart Chain and X Layer (24 on Base, which has four default nodes), cached for 300 s. `pin` adds
  one round and 3 requests there (sometimes two rounds on BNB Smart Chain), and two rounds and 8 requests on Base
  (measured 2026-09-30).
- A read pinned to a block (an EIP-1898 object or a hex block number, for `eth_call`, `eth_getCode`,
  `eth_getStorageAt`) that a node answers with "header not found", "unknown block" or `-32001` counts as that node not
  answering, not as a disagreement: a node that lags behind the pinned block no longer makes the read fail with
  `RPC_DISAGREE`. The nodes that have the block must still agree, and `quorum` operators must still answer (otherwise
  `RPC_UNAVAILABLE`). This applies to `rpc.call` / `rpc.ethCall` with a hex block number too.


## [1.1.0] — 2026-09-30

### Added

- **One-command signing for LiteLLM Proxy (`examples/litellm-sidecar/`).** A docker-compose package puts the signing
  sidecar in front of LiteLLM Proxy (the official image `ghcr.io/berriai/litellm:v1.103.0`, pinned, with PostgreSQL for
  virtual keys); LiteLLM is unchanged, and users keep their virtual keys and SDKs, pointing only the base URL at the
  sidecar. The price table's `id`s are LiteLLM's `model_name`s, which LiteLLM reports back in `model`. The entry is the
  new-api package's with LiteLLM's profile (`examples/new-api-sidecar/server.mjs` gains an optional `profile`; its
  defaults are unchanged) and one stream adjustment through `createAIProxy`'s `formats` option: a Responses stream that
  ends at `data: [DONE]` (LiteLLM sends Responses events as `data:` lines only) gets its receipt before it. `smoke.mjs` and the tests run without Docker or LiteLLM; `e2e.mjs` checks a real LiteLLM with
  the official `openai` and `@anthropic-ai/sdk` packages in strict mode. A sidecar in front, not a LiteLLM callback: a
  callback sees parsed objects, not the bytes a receipt proves.

### Fixed

- **RPC batching recovers from a transient network error (`sdk/src/rpc.js`, FIXED P101-3).** One reset connection on a
  JSON-RPC batch made that node take `eth_call`s one by one for the client's lifetime. Now only what a node answered
  about a batch (an HTTP error, a single object, a 200 body that is not JSON) stops batching to it for good; a failure
  with no answer (the connection reset, the body cut off mid-read) pauses batching to that node until 5 minutes have
  passed or it has answered 20 calls alone. The calls of the failed batch are still asked again one by one, as before.
  Performance only: what counts as an answer and every quorum rule are unchanged.
- **A relay room whose storage write fails no longer keeps the frame (`examples/cloudflare-worker/relay-room.js`,
  `examples/relay-service/relay-core.mjs`, FIXED P101-4).** relaySend answered with the error but the frame stayed in
  memory, so the client's retry added it a second time. The frame is now pending until its own write lands: no read
  hands it out and no long-poll wakes for it; if the write fails, relaySend answers with the error and the frame is
  taken back out (its index, the frame a full ring had shifted out for it, the per-source 0x03 / 0x04 count), so the
  retry is the only copy, before and after an eviction. The relay core without storage (the Node relay) is unchanged.
- **The sidecar also strips LiteLLM's injected Chat usage chunk (`sdk/src/ai-openai-chat.js`, FIXED P101-b).** When the
  sidecar asked the upstream for usage on the client's behalf, it removed only a usage chunk with `choices: []`; LiteLLM
  sends it with `choices: [{ index: 0, delta: {} }]`, so the client received a chunk it had not asked for. A usage chunk
  whose choices carry nothing (an empty delta, no `finish_reason`, no `logprobs`, no other member) is now the injected
  one too; any content, `finish_reason` or other member keeps a chunk in the stream. `examples/litellm-sidecar` no
  longer needs its own Chat adjustment; its Responses adjustment (`data: [DONE]` as a final line) stays.
- **The monitor reports a signed answer without `result` instead of crashing (`scripts/monitor.mjs`, FIXED P101-2).**
  `judgeAsync` and `checkRelayAsync` threw a TypeError on it, and the run could end without a report; it is now a
  FAILED line that says so.

### Fixed (docs and website)

- Docs: every copyable `tapeapi-verify 42.1013.tape` / `tapeapi-mcp 42.1013.tape` command (both READMEs, the SDK README,
  the homepage, the AI providers and MCP guides, the new-api sidecar README) now says that 42.1013.tape is an example name
  to replace with your service's. The MCP guide's `createMcpEndpoint` example uses the public service's name,
  `11.1013.tape`. The SDK README and the holder console use `1.2.230.tape`, which exists on X Layer, instead of
  `1.2.344.tape`, which does not.
- Channels guide: `node conformance/relay.mjs --url` takes the relay's site root (`https://relay.tapeapi.fun`), not the
  `/tapeapi/v1` address used in an invite's `relays[].url`.
- Upgrading to 1.0: the error-code table now lists `METHOD_NOT_ALLOWED` (a provider's unsigned HTTP 405 for a non-POST
  request, a transport failure to clients) and `NAME_TAKEN` (WebMCP, in `handle.skipped[].code` when `registerTool`
  fails). The Experimental list now names `MAX_CONTRIBUTION_BPS`, `RECOMMENDED_CONTRIBUTION_BPS` and `MAINNET.bem`, as
  tagged in the type declarations.
- The Chinese "Call a service" guide links to the upgrade guide's error-code table, like the English one.
- The link from the MCP guide to "Go live from a phone" in the provider guide now works on GitHub as well as on the
  site: the heading reads "Cloudflare and holder console" (no `+`), so both produce the same anchor.
- Homepage and status page: `<html lang>` and the tab title follow the language switch (on first load and on toggle).
- The site now serves `/favicon.ico` (16/32/48 px, generated from `favicon.svg`) instead of a 404.

### Tests

- **Three timing-dependent tests no longer fail on a loaded machine (FIXED P101-1).** `bus-fuzz`, the fallback scenario
  of `bus-privacy` and R8-S1 in `review-arch` ran on the real clock (budgets of 200 ms and 20 s, a 60 ms back-off), so a
  busy machine or CI runner sometimes failed them. They now run on a virtual clock (`sdk/test/helpers/clock.mjs`):
  simulated node latency is the only time that passes, so each asserts what it always did, on the idle machine it was
  written for; tiny-budget fuzz seeds now replay too. Each also runs once more on a clock going 50 times fast, which
  failed before the change.

## [1.0.0] — 2026-09-29

TapeAPI 1.0.0, the first stable release. Nothing on the wire and nothing in the interfaces of `@tapeapi/sdk` and
`@tapeapi/server` changed since 1.0.0-rc.5: the specifications change status, not content.

### What 1.0 promises

- **Semantic versioning from 1.0.0 on.** Code written against the 1.0 documentation keeps working in every 1.x release;
  a breaking change comes only in 2.0. Additions (a new optional option, a new field, a new error code) may come in any
  minor release.
- **Stable:** every export of `@tapeapi/sdk` and `@tapeapi/server`, the command-line tools `tapeapi-mcp` and
  `tapeapi-verify`, and the methods and result shapes of the public services (api.tapeapi.fun, relay.tapeapi.fun),
  except what is marked otherwise.
- **Experimental** (`@experimental`; may change in a 1.x minor release, each change in this changelog): everything that
  pays (TAPI-22 payment channels, the escrow, vouchers, `api.payer()`, `maxPrice`, the channel builders of `api.tx`,
  `api.chain.escrow.*`), the ServiceDirectory (`api.chain.resolve()`, `api.chain.serviceOf()`, directory labels, the
  `directory` option, `labelToBytes32` and the label helpers of `abi`), and the whole `@tapeapi/sdk/bus-privacy`
  subpath. Reading prices from a manifest and the codes `PAYMENT_REQUIRED`, `BAD_VOUCHER` and `PRICE_CHANGED` are
  Stable: a free service's client can meet them too.
- **Internal:** marked `@internal`, or not exported.

The full lists, what changed from 0.x and the error-code table are in the upgrade guide:
[docs/guides/upgrade-1.0.md](docs/guides/upgrade-1.0.md) (https://tapeapi.fun/docs/en/upgrade-1.0).

### Specification statuses (TAPI-1 §4.1)

- **TAPI-20, TAPI-21, TAPI-23, TAPI-26 and TAPI-27 are Stable (v1)** since 2026-09-29; their `Target` rows are gone. Every
  field, encoding, signature domain and error code they define keeps its meaning; a revision may add only optional
  content and non-normative text; a breaking change is a v2 with its own wire markers, and v1 is not withdrawn earlier
  than 12 months after v2 becomes Stable.
- **TAPI-20 §3.5 (ServiceDirectory) is Experimental**, outside the freeze (TAPI-1 §4.1, freeze rule 3), and so are the
  places that use it: a label as input to §3.6 step 1, the `serviceOf` cross-check and `verifyDelegation` in §3.4.
  Resolution by name, container or `(circuits, tokenId)` needs no directory.
- **TAPI-21's error codes, `PAYMENT_REQUIRED` and `BAD_VOUCHER` among them, are frozen with TAPI-21**, although the
  payment flow that uses them is in TAPI-22, which is Experimental.
- Unchanged: TAPI-22 and TAPI-25 Experimental, TAPI-24 Withdrawn, TAPI-1 Draft. No normative text changed. The TAP numbers
  are still proposals to the TapeKit maintainers ([TapeKit#8](https://github.com/TapeOutProtocol/TapeKit/issues/8)).
- The Chinese halves of TAPI-26 and TAPI-27 gain the RFC 2119 keyword sentence their English halves already had
  (translation only; both halves now count the same keywords).

### Website and READMEs

- The homepage, both READMEs, both package READMEs and the introduction (English and Chinese) say 1.0.0 instead of
  pre-release; the homepage roadmap marks 1.0 done; the spec index and the READMEs' spec tables show the new statuses.
  The public-API, MCP and groups guides drop their stale "pre-alpha" label (the no-SLA and no-audit notes stay).

### Added

- **The monitor checks the relay's asynchronous delivery (RELAY-1 would now alert within one 30-minute run).**
  `scripts/monitor.mjs` posts one random 0x03 test frame (64 to 200 bytes) to a random room through `relaySend`, leaves
  the room idle for 60 s (`ASYNC_WAIT_S`, or `--async-wait-s=N`), then reads it back with a brand-new client
  (`relayRecv` from -1, epoch null). It passes only on exactly that one frame, the same bytes, under the epoch
  `relaySend` answered; the report says why otherwise ("0 frames, epoch null: the relay lost the room while idle").
  Network-layer failures are retried twice and reported as DOWN, apart from a relay that answered wrongly (FAILED).
  The send goes out first and the other checks run during the wait, so a run takes about 65 s; the workflow's timeout
  is now 15 minutes. `relaySend` is free on relay.tapeapi.fun and the frame expires with its room after 15 minutes;
  the monitor still sends no transactions and holds no keys.

### Fixed

- **The public copy keeps git's executable bit.** The script that stages the public copy wrote every file 0644, so
  the CLIs in `sdk/bin` reached the public repository without their executable bit once; they keep 100755 now, with a
  test.

### From 1.0.0-rc.1 to 1.0.0-rc.5

- **rc.1**, the interface freeze: `INVALID_ARGUMENT` for the caller's own mistakes; fixed `TapeAPIError` top-level
  fields (details in `e.data`, the old names deprecated until 2.0); `service`, `relayClients` / `busClients`,
  `rpcTimeoutMs`, `name` for MCP, `clock` in Unix seconds; `openai-proxy` removed; narrower public faces for `ai`,
  `channel`, `rpc` and `group`; `createVerifyingFetch` verifies streams the official SDKs read; provider dev mode only
  through `opts.dev`; TAPI-1 §4.1 statuses; the TAPI-20 §6.1 mainnet manifest and TAPI-23 §6 vectors (the Python
  verifier went from 159 to 249 checks).
- **rc.2**: `api.resolve()` in 4 round trips and 12 requests instead of 7 and 21; the server could serve one voucher
  twice (fixed); the homepage's fonts are files.
- **rc.3**: the website's vendored SDK lives in a content-hashed directory, so a release never mixes old and new
  modules.
- **rc.4**: the last error-code alignments (a server without `rpcUrls`, and WebMCP's caller-state errors, are
  `INVALID_ARGUMENT`); loosely written metered paths are refused instead of passed on unverified; review fixes with no
  interface change.
- **rc.5**: the Cloudflare relay keeps its rooms in Durable Object storage, so idle rooms no longer lose frames.

### Upgrading

- From 0.x: follow the [upgrade guide](docs/guides/upgrade-1.0.md).
- From 1.0.0-rc.4 or rc.5: nothing to change. From rc.1 to rc.3: code that matched `INTERNAL` for a server without
  `rpcUrls`, or `BAD_REQUEST` for WebMCP's `refresh()` and calls after dispose, now sees `INVALID_ARGUMENT`.

## [1.0.0-rc.5] — 2026-09-29

### Fixed

- **The Cloudflare relay (relay.tapeapi.fun) no longer loses a room when Cloudflare recycles an idle Durable Object.**
  Seen live on 2026-09-29: a frame posted to a room was read back at once, but every read from +30 s to +400 s found
  0 frames and `epoch: null`, with no redeploy in between. `RelayRoom` kept its room only in memory, and Cloudflare
  evicts an idle object within seconds, so a room designed to live 15 minutes lived about ten seconds and asynchronous
  delivery (group invites, TAPI-26 invites, messages to a peer that was not polling at that moment) mostly failed. The
  room is now written to the object's SQLite-backed Durable Object storage, one key per frame plus one meta key, and a
  recreated object restores it with the same epoch and indices, so clients' cursors keep working. `relaySend` answers
  only after its frame is stored; a frame a full ring drops is deleted from storage; the Durable Object alarm clears an
  expired room and its storage (15 minutes idle, 10 for a handshake-only room, as before), and only then does a new
  room get a new epoch. The relay's methods, parameters and answers are unchanged, and the Node relay
  (`examples/relay-service`) still keeps rooms in memory: `createRelayCore` gained an optional `onChange` hook and
  `restore()`, which it does not use. Privacy: frames (ciphertext), room names, indices and timestamps are now at rest
  in Cloudflare's Durable Object storage until the room expires; the source of a post (IP address or paying consumer)
  is still held in memory only and never written. The privacy page says so.

## [1.0.0-rc.4] — 2026-09-29

### Error codes (the last alignments before 1.0)

- `@tapeapi/server`: a provider built without `rpcUrls` now says `INVALID_ARGUMENT` on its first chain read, with the
  fix in the message (`rpcUrls: rpcUrlsFor(<chainId>)`); it was `INTERNAL`.
- WebMCP: `refresh()` with nothing exposed, `refresh()` after dispose, and a tool called after dispose are
  `INVALID_ARGUMENT` (a mistake in the page's own calls); they were `BAD_REQUEST`, which reads like the agent's input.
  A malformed tool input from the agent stays `BAD_REQUEST`.

Fixes from the release-candidate review (P2 items, observation period): no interface or return shape changes.

### Fixed

- **A metered path written loosely is refused, not passed on unverified.** `/v1//chat/completions`,
  `/v1/chat/%63ompletions`, `/v1//messages` and `/v1/%6Dessages` matched no format, so the reference sidecar forwarded
  them with no receipt, and `createVerifyingFetch` and `tapeapi-verify --strict` let the answer through unverified and
  unreported; api.openai.com and api.anthropic.com serve these spellings. A path that matches a format only once
  percent-encoded unreserved characters are decoded, repeated slashes collapsed and a trailing slash dropped is now:
  400 `bad_path` from the sidecar, before anything goes upstream; `INVALID_ARGUMENT` before sending from a strict
  `createVerifyingFetch` (the same `e.data` as an endpoint mismatch), or `onReport` with `mismatch: true` and
  `not verified: path mismatch`; 400 from `tapeapi-verify --strict`, a logged warning without it. Paths no format
  meters pass through however they are written. (1.0.0-rc.1's "`createVerifyingFetch` no longer lets anything through
  unverified" did not hold for these spellings.)
- **`createProvider({ dev: true })` alone allows a priced method on a zero-address escrow.** The manifest also had to
  say `dev: true` (1.0.0-rc.1 said its `dev` field switches nothing). What dev allows is exactly a zero-address
  `payment.escrow`, not a priced manifest with no `payment` field, which stays invalid; the rc.1 wording "priced
  methods without an escrow" is corrected in the guide and the declarations.
- `createAIProxy` no longer reads the manifest's `dev` field when checking its endpoints (dead code; the refusal was
  the same).
- The refusals of 0.x option names link https://tapeapi.fun/docs/en/upgrade-1.0 (they named a path the npm package
  does not contain, or nothing); "rpcUrls not configured" says how: `createTapeAPI({ rpcUrls: rpcUrlsFor(<chainId>) })`.
- The SDK's own code no longer reads `TapeAPIError`'s deprecated top-level aliases (`rpc.js`, `bus-privacy.js`);
  `channel.js` keeps its reads until 2.0. Unused imports and a helper removed from `tapeapi-verify` and the MCP proxy.
- `tapeapi-verify` reads a request path that starts with `//` as a path, not as a host.
- `examples/web2-adapter` takes dev mode from the environment (`dev: !PROD`), not from the manifest.

### Docs

- `labelToBytes32` and the `abi` label helpers are marked `@experimental` (ServiceDirectory only), as the upgrade
  guide's list already implied.
- groups: a rate-limited delivery carries `rateLimited` / `retryAfterS` on the failed entry of `e.data.deliveries`;
  consume, faq: a script runs wherever `@tapeapi/sdk` resolves (a clone, or a project with the release package);
  provide: `publishManifest` returns `{ txs, key, size, sha256Hash }`; sdk/README lists `/ai`, `/mcp`,
  `/bus-privacy` and `tapeapi-verify`; both package READMEs say pre-release, not pre-alpha; README test count.

### Tests

- The browser smoke test loads "My services", the playground, the receipt checker, the holder console and the status
  page and fails if one throws while loading (RC-1 could not show there); its TAPI-21 envelope checks sign EIP-191, as
  the vectors have since 0.5.0.

## [1.0.0-rc.3] — 2026-09-29

### Website

- **The vendored SDK lives in a content-hashed directory, so a release can never mix old and new modules.** The
  1.0.0-rc.2 fix (`Cache-Control: max-age=0` on `/playground/vendor/*`) did not hold in production: the zone's Browser
  Cache TTL rewrites `Cache-Control` on every `.js` to 4 hours, so a returning visitor could still get a new `index.js`
  with a cached old `ai.js` (a problem since 0.x). `npm run build:playground` now writes the whole tree to
  `site/playground/vendor/<hash>/`, named by the first 10 hex digits of a SHA-256 over every vendored file and path, and
  removes the old directory. The files themselves are unchanged, byte for byte what `sdk/src` and `@noble` hold, and
  still import each other by relative path, so a module has one URL. The same run regenerates the import maps of the
  playground, the receipt checker and "My services", the vendor paths in their scripts, and the checker's policy hash.
  A new test fails unless changing any SDK file changes the directory name. The `_headers` rule stays as a second line.

## [1.0.0-rc.2] — 2026-09-29

### SDK

- **`api.resolve()` takes 4 round trips instead of 7, and 12 HTTP requests instead of 21** (no
  interface or return shape changes). Against the default BSC nodes, `resolve('11.1013.tape')` went from a median
  2.77 s to 1.79 s on a new client, and from 2.00 s (6 rounds, 18 requests) to 0.68 s (2 rounds, 6 requests) when the
  same client resolves it again (10 interleaved runs each). How: the second, identical `accountOf` is gone; reads that
  do not depend on each other go out together (a name's `isCPU` and `ownerOf` with `accountOf`, and for any target
  steps 3-5 of TAPI-20 §3.6 in one round), each still checked in its old place with the same error codes; `fileInfo`
  still comes before `read`. `createRpc` sends concurrent `eth_call`s to one node as a JSON-RPC batch of at most 3 (all
  ten default nodes take one; dRPC's free plan refuses more than 3), each call still its own quorum round; a node that
  does not take a batch is asked call by call from then on, and a batch refused with an HTTP error is never read as
  answers. `resolve` keeps `cpuAt(n)` and `accountOf(circuits, tokenId)` answers (never errors) for at most 300 s, per
  chain; the holder, the manifest file and its hash are read on every resolve.
- **Server: one voucher could be served twice.** A priced call that committed while the next call with the same
  cumulative was reading the escrow was missed by both checks. The in-flight reservation is now read before the store,
  both after the escrow read.

### Website

- **The vendored SDK is revalidated on every load** (correction after release: this did not take effect; Cloudflare's browser-cache setting forces 4 hours on .js files. Fixed at the root in 1.0.0-rc.3). Its modules import each other without a content stamp (so one
  module is never loaded under two URLs), and Cloudflare cached them for 4 hours, so a returning visitor could run a new
  `index.js` against a cached `ai.js` right after a release. `/playground/vendor/*` is now served with
  `Cache-Control: public, max-age=0, must-revalidate` (an unchanged file costs one 304).

- **The homepage's fonts are files, not data URIs.** The four subsets (same bytes) moved out of `site/style.css` into
  `site/fonts/`, all with `font-display: swap`, and the homepage preloads Archivo. The render-blocking stylesheet drops
  from 93 KB to 27 KB (58 KB to 6 KB brotli): on a throttled Slow 4G load the first paint comes at about 550 ms instead
  of 690 ms, and every face is in by about 680 ms. Once the fonts are in, the page is pixel for pixel what it was.
  `scripts/version-assets.mjs` now stamps fonts too (`url(...woff2?v=<hash>)` in stylesheets and a preload's `href`),
  and the publishing step inlines the fonts back into the self-contained DeWEB copy, which still makes no
  external request.

## [1.0.0-rc.1] — 2026-09-29

### Breaking changes toward 1.0

The interface freeze review (1.0 plan G1). Every change below can break 0.x code; what to write instead, what 1.0
promises (Stable, Experimental, Internal) and the full error-code table are in
[docs/guides/upgrade-1.0.md](docs/guides/upgrade-1.0.md).

- **`INVALID_ARGUMENT`, a new client code for the caller's own mistakes.** A configuration or argument error (`createRpc`,
  `createTapeAPI` without `rpcUrls`, an unsupported `resolve` target, `payer` options, `tx` builder arguments,
  `callQuorum` options, group-delivery carriers, `createProvider` / `createAIProxy` / `createMcpProxy` options) is now
  `INVALID_ARGUMENT`, raised before anything is sent. It used to be `RPC_UNAVAILABLE`, `MANIFEST_INVALID`, `BAD_VOUCHER`,
  `ABI_INVALID`, `BAD_KEY`, `CHANNEL_INVALID`, `BAD_REQUEST`, `QUORUM_FAILED`, `METHOD_NOT_FOUND` or `GROUP_DELIVERY`,
  so a retry loop on `RPC_UNAVAILABLE` could spin on a missing `rpcUrls`. The codec layers (`abi`, `canon`) and the
  protocol refusals of `callQuorum` are unchanged. TAPI-21 §3.4 lists it, with `GROUP_DELIVERY`, `BAD_RESPONSE`,
  `BUS_PRIVACY`, `BUS_BUDGET` and the MCP `error.data.code` values.
- **`TapeAPIError` top-level fields are fixed**: `name`, `code`, `message`, `data`, `signed`, `httpStatus`, `cause`, and
  `ts`, `block`, `id`, `sig`, `error` on a signed provider error. Every other detail is in `data` (`e.data.tooLarge`,
  `e.data.rpcCode`, `e.data.rpcRevert`, `e.data.agreed`, `e.data.failed`, ...); the old top-level names still read, as
  deprecated aliases, until 2.0.
- **`channel` exports**: `toHex` (bare hex, unlike `abi.toHex`), `fromHex`, `toBase64`, `fromBase64` and the test hooks
  `_keySchedule`, `_busMerge`, `_busKindOf` are no longer public; `@tapeapi/sdk/channel` and the root `channel`
  namespace point at a public face (`sdk/src/channel-public.js`). `sig` no longer re-exports `keccak256`, `toHex`,
  `bytesToHex`, `hexToBytes` (use `abi`). `@tapeapi/sdk/rpc` exports `createRpc` and `RPC_BODY_LIMIT` only
  (`readJsonBounded`, `describeUrl`, `isNodeLimit` are internal). `abi.FUNCTIONS` and `abi.SERVICE_TUPLE` are `@internal`.
- **`service`, not `svc`**: `channel.relayTransport({ service })`, relay carriers `{ api, service, payer }`, the WebMCP
  handle's `service`. `svc` is refused with a pointer to the upgrade guide.
- **`relayClients` and `busClients`, always lists**: `deliverGroupUpdate({ relayClients: [...], busClients: [...] })`,
  `checkGroupInvites({ relayClients: [...] })`, clients `{ api, service, payer? }` and `{ address, sendTx }`. `relays`
  stays the roster's and the invite's list of relay references `{ url, container }` (`createGroup`, `resumeGroup`,
  `channel.createInvite`); `relay`, `bus`, `relays` and `buses` are refused by the delivery functions.
- **Every `now` is Unix seconds.** `createGroup`, `joinGroup` and `resumeGroup` take `clock`, a function returning Unix
  seconds; the 0.x `now` (a function of milliseconds) is refused, and so is a clock returning milliseconds (above 1e11,
  e.g. `Date.now`), on the owner's side and the member's: `clock must return Unix seconds`. The TAPI-27 vectors are
  unchanged.
- **`channelRecordFloor`** is keyed `<chainId>:<container>` and shared with the other chains' clients (`forChain`), so the
  anti-rollback floor persists on X Layer and Base too; a 0.x entry is migrated on first read.
- **The `openai-proxy` subpath of `@tapeapi/server` and `createOpenAIProxy` are removed**: use `@tapeapi/server/ai-proxy` and
  `createAIProxy`.
- **MCP endpoint and proxy**: `createMcpEndpoint()` returns `{ handleRequest, tools }` (was `handle`); `createMcpEndpoint`
  and `createMcpProxy` take `name` (was `identity: { name }`; `identity` is refused). `UPSTREAM_TIMEOUT_MS` is
  `AI_UPSTREAM_TIMEOUT_MS` in `ai-proxy` and `MCP_UPSTREAM_TIMEOUT_MS` in `mcp-proxy`.
- **`ai.createVerifyingFetch` no longer lets anything through unverified.** Streams read by the official SDKs are
  verified (they stop reading at `[DONE]` / `message_stop`, so the old end-of-stream check never ran). A stream ends at
  its final event, at `[DONE]` or when the upstream closes, whichever comes first; in strict mode the chunk in which it
  ends is released only once a receipt that came before the end verifies, else the iterator throws `RECEIPT_INVALID`
  (a `[DONE]` inserted before `response.completed` used to let an unverified Responses stream through). Nothing waits
  for the upstream to close the connection, and with `strict: false` nothing is held at all; an upstream that breaks off
  after the end does not fail the call. A custom format that streams must name its final event (`stream.final`):
  strict refuses one without it with `INVALID_ARGUMENT` when the fetch is made, otherwise `onReport` warns once.
  A metered request to a host other than the manifest's endpoint (`localhost` for `127.0.0.1`) is refused with
  `INVALID_ARGUMENT` in strict mode, reported with `mismatch: true` otherwise. `tapeapi-verify --strict` likewise ends the stream in an
  error event when no receipt before its end verifies, and passes on only whole events. In strict mode a whole answer whose receipt fails is no longer thrown: it
  becomes an HTTP 502 in the API's error shape (code `RECEIPT_INVALID`) with `x-should-retry: false` and
  `x-tapeapi-verify-error: RECEIPT_INVALID`, so the official SDKs throw an `APIError` and do not retry it (a thrown
  error was wrapped and retried twice by default: three requests, each possibly paid); a caller of the fetch itself
  checks `res.ok`. `onReport` fires as before. Regression tests drive the official `openai` and `@anthropic-ai/sdk` packages
  (root devDependencies only).
- **Provider `dev` is `opts.dev` only**: `createProvider` relaxes its payment checks (priced methods without an escrow,
  the in-memory meter warning) only for `dev: true`; `allowHttp` only allows http endpoints; a manifest's own `dev` field
  switches nothing, in `createProvider` and `createMcpProxy`.
- **`rpcTimeoutMs`**: `createTapeAPI`, its `chains[id]` and `createProvider` take `rpcTimeoutMs` for the timeout of one RPC
  request; `timeoutMs` there is refused (`api.call` keeps its per-call `timeoutMs`).
- **Decimal strings out**: `api.chain.tokenOf()` returns `tokenId` as a decimal string, like every `tokenId` and `processor`
  the SDK returns. The public service's `tapeName` is unchanged.
- **A narrower frozen surface**: the root `ai` namespace and `@tapeapi/sdk/ai` are a public face (`sdk/src/ai-public.js`):
  the helpers the reference sidecar and the website use stay, marked `@internal`; `amountOf`, `pricesOf`,
  `sseDigestOfPayloads`, `sentinelOf`, `rootOf`, `saltRequestBody` and the limit constants are no longer exported
  there. `group.senderKey` and `group.buildEpoch` leave the public `group` namespace. The whole `bus-privacy` subpath
  (options, defaults, `stats().privacy`) is `@experimental`.
- **Option interfaces have no index signature**: `CreateProviderOptions`, `ChannelSelf`, `ChannelPeer` and WebMCP's `paid`
  reject unknown keys at compile time.
- **Types**: `Group` is `GroupHandle | OwnerGroup` (with `GroupSnapshot`, `Roster`); `ManifestBase` is shared by the two
  proxies; payment declarations carry `@experimental`.

Also: `api.addresses.factory`; `PROVIDER_UNAVAILABLE` carries `data.timedOut` / `data.aborted` for the caller's own
timeout or abort; the CLI help lists `tapeapi-mcp --dev` and the exit status (0, 1, 2; no environment variables).

### Website and READMEs

- **Homepage rewritten for the current positioning** (`site/index.html`, `site/style.css`; 1.0 plan G9). It leads with
  the signed receipt layer for AI services (the sidecar, what a receipt proves and what it does not: which model ran),
  then MCP, private channels and groups, and multi-chain. New sections: a start-here path per reader (AI providers, MCP
  server authors, app developers, circuit holders), the receipt layer with a figure and a "what a receipt proves" table,
  chains (BNB Chain with payments only there; X Layer and Base read-only), and privacy (what is protected and what is
  not). "Live now" adds the AI sidecar and new-api package (available, self-hosted only: it handles API keys),
  `tapeapi-verify`, the console's AI price tables, one-call group delivery, the spot-check probe and the receipt
  checker. Paid channels and their gas and amortisation figures move to "Experimental: paid channels" (not deployed);
  the fee note uses the current wording, and says no call is charged today. Spec statuses follow TAPI-1 §4.1. The
  examples use `rpcUrlsFor(56)`; a new one plugs `createVerifyingFetch` into the official OpenAI SDK. Every example was
  run against the v0.8.0 release package (the AI one against the reference sidecar in `examples/ai-proxy`, since no
  outside provider has published a price table yet).
- **README.md and README.zh-CN.md rewritten** to the same standard: the value in the first lines, a table of first
  steps per reader, short examples that run (install from the release package, AI receipts, `tapeapi-verify`, MCP), a
  Mermaid diagram of the layers, what a receipt proves, status and commitments, privacy, fees and the specs with their
  statuses. Contract addresses and repository detail now live in the guides.

### Specification statuses toward 1.0 (TAPI-1 §4.1)

- **TAPI-1 §4.1 defines the interim statuses** this repository uses until TapeKit adopts a numbered-proposal process:
  Draft, **Stable (v1)**, Experimental and Withdrawn. Stable (v1) freezes every field, encoding, signature domain and
  error code; a revision may only add optional content or non-normative text; a breaking change is a new version (v2)
  with its own wire markers, v1 stays valid beside it and is not withdrawn earlier than 12 months after v2 becomes
  Stable. When TapeKit assigns numbers or statuses, TapeKit's prevails and the front matter records the mapping.
  A new optional front-matter row, `Target`, names the status a Draft intends to reach.
- **Status rows.** TAPI-20, TAPI-21, TAPI-23, TAPI-26 and TAPI-27 stay Draft with `Target | Stable (v1) at TapeAPI 1.0`;
  TAPI-22 (metered payment and escrow) and TAPI-25 (circuit-verified methods) are **Experimental**; TAPI-24 (intent RFQ,
  frozen since 2026-09-21) is **Withdrawn**. No normative text of TAPI-20 to TAPI-27 changed.

### Test vectors

- **TAPI-20 §6.1 mainnet manifest filled in**: the live manifest of `11.1013.tape`, read only through `resolve` on the
  SDK's default BSC nodes (quorum 2 by operator, all three operators identical), every `eth_call` pinned to block
  124552456 by EIP-1898 `{ blockHash }`: size 3414, SHA-256 `0xee57f304…3b52c37a`, signer, delegation expiry and holder.
  Recorder `scripts/record-mainnet-manifest.mjs`, fixture `sdk/test/fixtures/mainnet-11-1013-manifest.json`, offline
  replay `sdk/test/mainnet-manifest.test.mjs` (clock pinned to the block; the table in the spec must quote the
  fixture). The delegation is renewed before 2026-12-10, so the fixture pins a block's state, not the current manifest.
- **TAPI-23 §6 vectors**: `spec/vectors/tapi-23-attested.json` (from `scripts/gen-vectors.mjs`), two providers signing
  with public test keys, real Ethereum values for the example request (block 20000000, USDT `totalSupply()`), two
  agreeing cases and three `ATTEST_DISAGREE` counterexamples, replayed through `callQuorum` by
  `sdk/test/attested-vectors.test.mjs`. §6 now says plainly that no live service offers `attestedRead` yet
  (`11.1013.tape` does not) and what the smallest change would be.
- **`spec/vectors/verify.py`** checks both independently: it re-encodes the mainnet calldata, ABI-decodes the answers,
  hashes and parses the manifest and recovers the delegation to `ownerOf`; and it rebuilds each TAPI-23 envelope digest,
  recovers both signers and decides agreement from §3.4 alone. 159 checks before, 249 now.

## [0.8.0] — 2026-09-28

### ChannelBus read privacy: contract-wide reads by default, cover rooms as the fallback

- **`busPrivacy.busPrivacyReader`** (new module `sdk/src/bus-privacy.js`, subpath `@tapeapi/sdk/bus-privacy`): the
  options and the reader of `channel.busReader`, plus `mode`, `cover`, `contract`, `setMode()`, `covers` and
  `stats().privacy`. It wraps the rpc client busReader reads through, so busReader's own reading code (ranges, union,
  confirmations, overlap, hold never skip) runs unchanged; `sdk/src/channel.js` is not touched.
  - `mode: 'contract'` (the default): no room topic at all (`topics: [Wire]`); every frame on the bus is downloaded and
    filtered locally, so a node learns only that the IP reads ChannelBus. It needs no cover pool, so the first poll
    waits only for its own `lookback` read. Bounded per poll (`contract.maxBytes` 8 MiB, `maxLogs` 10,000, over every
    node's answer); over it, `contract.onExceed: 'cover'` (the default) falls back to cover rooms and warns, and
    `'error'` stops the reader with `BUS_BUDGET` (frames already read are handed over either way). Default because the
    mainnet ChannelBus carried one log in 500,000 blocks on 2026-09-28: no rooms to draw covers from, and a
    contract-wide read cost almost nothing.
  - **Coming back, with hysteresis.** After a fallback the reader returns to `'contract'` by itself once it has spent
    `contract.retryMs` in `'cover'` (30 min, doubled after each relapse soon after a return, at most 24 h) and a pool
    refresh made after the fallback shows a poll's traffic at or under half the budget; `retryMs: null` never returns.
    Covers are drawn once and kept, so the switching shows no new room sets; covers drawn at a fallback come first from
    rooms seen in quiet contract polls, not from the junk that caused it. `stats().privacy.fallback` reports it.
  - `mode: 'cover'`: each of your rooms goes out among `k` rooms (default 8), the others real rooms seen in the bus's
    last 40,000 blocks of logs (read with queries that name no room), in quiet contract polls, or in `cover.pool`, in a
    fresh random order on every request, catch-up reads of rooms added later included. Cover rooms' logs are dropped
    before the scanner parses them: never decoded, decrypted or kept. Covers are drawn once per room and kept for the
    reader's life, and across restarts with `cover.store`, because changing them lets a node intersect requests. Too
    few covers is never passed off as cover: the reader warns once per change (`effectiveK`, `short`), or throws
    `BUS_PRIVACY` before sending anything with `cover.onShort: 'error'`. Its pool scan costs one request per 5,000
    blocks (3-6 s each on 48 Club), about 25-50 s before a fresh process's first read; `cover.scanBlocks` lowers it.
  - `mode: 'plain'`: busReader as before.
  - `scanCoverPool` and `plausibleRoom` are exported too. Tests: `sdk/test/bus-privacy.test.mjs`.
- **No existing default changes.** Nothing in the SDK builds a `busReader` for you (`checkGroupInvites` reads relays), so
  no existing call changes behaviour; `busReader` and `busTransport` still name your rooms. The guides now point bus
  readers to `busPrivacyReader`; `mode: 'plain'` gives busReader's behaviour through it.
- Docs: "Read privacy" in `docs/guides/channels.md` and the Chinese guide (the default and why, the first read, falling
  back and coming back, what `k` means, what it helps against and what it does not). TAPI-26 §8 gains a non-normative
  note, "Node correlation", in both languages; no MUST/SHOULD/MAY changed.

### Holder console: AI price tables

- **The console publishes a manifest with an `ai` field** (TAPI-20 §3.9). `site/console/lib.js` gains `aiProblems` and
  `normalizeAI`, a line-for-line port of the SDK's `validateAIField` (the page loads no library): the same verdict, the
  same first message and the same normalised bytes, checked in `sdk/test/console-ai.test.mjs` on every valid and invalid
  sample of the SDK tests, the receipt vectors' table, the spec's example, `models.example.json` and 4,000 random
  mutations of them. `manifestProblems` and `expectedManifest` accept `ai` in its normalised form (what the sidecar
  serves); anything else new is still refused.
- **The price table before the wallet asks.** Step 5 shows every API format's address and every model's id, aliases and
  per-currency input, output, cache read, cache write, 1-hour cache write and reasoning prices per 1M tokens, with the
  spec's defaults marked (`aiPriceTable`). Hints, never refusals: a price of 0, a price above a per-currency threshold
  (`AI_HUGE`), output below input, a cache read above input, endpoints clients ignore, `USD` for display only, a table
  near the one-transaction limit. Bilingual, with the page's language switch.
- **Import.** Paste or upload a `models.json` (the new-api sidecar's bare array, converted by `modelsToAIField` on the
  step-4 service URL exactly as the sidecar builds its endpoints), an `ai` field, or a whole manifest (`aiFieldOf`). A
  previewed table must equal the served one (`aiDiff`) or nothing is published.
- **Read back after publishing.** Once the `putFile` transaction is mined, the page reads the manifest back from the
  chain (length and SHA-256 against the SiteRegistry) and compares it with the bytes sent, price table included
  (`readBackProblems`); a lagging node gets a few tries and a mismatch says to check again later.
- **Multi-chain.** On X Layer and Base the page states that payments are not open and the prices are for display only.
- Docs: "Publish the price table with the console" in `docs/guides/ai-providers.md` (and the Chinese guide); the
  "console cannot publish `ai`" notes there and in `examples/new-api-sidecar/README.md` are gone.

### Fixed

- **A page's own modules are content-stamped too.** Cloudflare caches `.js` for 4 hours; pages stamped the scripts
  they load (`console.js?v=…`) but not what those scripts import (`./lib.js`), so after a release a returning visitor
  could run the new `console.js` against a stale `lib.js` and the page would fail to load. `scripts/version-assets.mjs`
  now stamps every relative import in `site/` modules, leaves first, so any change below a page changes the page's
  own reference; vendored code is left alone so one module is never loaded under two URLs.

## [0.7.0] — 2026-09-28

### Privacy hardening

- **Guessable receipt ids.** The AI signing sidecar keeps the upstream's answer id (TAPI-21 §3.5), and some upstreams'
  ids can be guessed: Ollama's OpenAI-compatible API numbers chat ids `chatcmpl-0` to `chatcmpl-998`, so anyone could
  walk through the free `receipt` method and read every receipt kept. The sidecar now estimates the randomness of the
  ids it sees (`idEntropyBits`, threshold `ID_ENTROPY_MIN_BITS` = 64) and warns once in its log when they look
  guessable (a low estimate, or one id seen twice while kept); keeps receipts per (`id`, `requestSha256`), so answers
  that share an id no longer overwrite each other (an id-only lookup still serves the later one); gives the `receipt`
  method a budget of its own (`receiptRateLimit`, default 10 lookups per client IP per minute, refused with the unsigned
  429 of TAPI-21 §3.4); states the configurable lifetime (`receiptTtlMs`) in the method description (unchanged at the
  default); and, with `requireRequestHash` (off by default), answers only lookups that also name `requestSha256`.
  Worker variables `RECEIPT_TTL_S`, `RECEIPT_LOOKUPS_PER_MIN`, `RECEIPT_REQUIRE_HASH`; the new-api sidecar takes
  `RECEIPT_TTL_S` and `RECEIPT_REQUIRE_HASH`. **TAPI-21 §3.5** (both languages): the `receipt` method MAY take an optional
  `requestSha256` parameter that picks the receipt of that request among answers sharing an id, and a provider whose
  upstream's ids can be guessed MAY refuse a lookup without it; the manifest entry stays `params: { id: "string" }`.
  §8 describes the risk. The receipt shape and the frozen vectors are unchanged.
- **Request salt.** `createVerifyingFetch` (new option `salt`, default on) and `tapeapi-verify` (`--no-salt` to turn it
  off) append 64 random JSON whitespace characters (128 random bits) after the JSON text of each request body on a
  receipt path, so the receipt's `requestSha256` can no longer be confirmed by hashing guessed short prompts. The
  parsed request is unchanged: no field is added or changed (`user` and `metadata.user_id` stay as written, since
  gateways route caches by them), no token is added, and prompt caches keyed on the parsed prompt are unaffected.
  Compressed bodies (`Content-Encoding` other than identity) and non-JSON bodies are sent as they are; an explicit
  `Content-Length` is dropped when the body grows; the receipt is checked over the bytes actually sent; reports carry
  `salted`. New exports `ai.saltRequestBody` and `ai.SALT_LENGTH`. TAPI-21 §8 and the AI provider guide explain why the
  cache is unaffected. Acceptance by the live OpenAI and Anthropic APIs is not yet measured (the tests use the
  reference sidecar).
- **Hash-only MCP receipts and verify links.** `verifyLink` used to put the whole receipt, params and result in clear,
  into the link, so sharing a link shared the call. It now carries the hash-only form by default (`mcp.hashReceipt`,
  receipt `v: 2`: `params` and `result`/`error` replaced by `requestHash` = keccak256(canonicalJSON({ method, params }))
  and `bodyHash` = keccak256(canonicalJSON(result or error)), the two hashes the TAPI-21 digest is built from, so the
  signature still verifies). The whole receipt goes into the link only when asked: `verifyLink(r, base, { content: true
  })`, `toolResultOf({ linkContent: true })`, `linkContent` on `createMcpEndpoint` and `createMcpProxy` (`LINK_CONTENT=1`
  in the MCP proxy Worker), `tapeapi-mcp --link-content`. The provenance note says which form its link carries. The
  receipt in `_meta` stays whole. New `sig.responseRequestHash`, `sig.responseBodyHash`,
  `sig.responseDigestFromHashes`, `sig.recoverResponseSignerFromHashes` (the same digest, checked against every
  published TAPI-21 envelope vector). The verification page reads both forms, shows the hashes and says that
  low-entropy params (an address, a token id, a price pair) can still be guessed from their hash. The reputation design
  now attaches hash-only receipts. The TAPI-21 envelope and digest are
  unchanged.
- **Honest labels.** The verification page has a "What a receipt does not prove" list in both languages: a receipt
  does not prove which model or program actually ran; a link with content (MCP receipt v 1) contains the conversation;
  metadata (the service sees the request and IP, public BSC nodes see the reader's IP and which service is checked) is
  not hidden. A receipt with content is shown with a note saying so, and the footer says the page can be self-hosted.
  The help of `tapeapi-verify` and `tapeapi-mcp` and the SDK README say the same. A new test
  (`scripts/privacy-copy.test.mjs`) keeps this copy free of the words the plan rules out.
- **Log minimisation.** All seven `wrangler*.toml` (the two public services api.tapeapi.fun and relay.tapeapi.fun, the
  four templates and one more) turn Cloudflare's per-request invocation logs and traces off and redact query strings
  (`[observability.logs] invocation_logs = false`, `[observability.traces] enabled = false`,
  `redact_query_string = true`, keys checked against the pinned wrangler 4.141.0); the Workers' own console output
  stays (on api.tapeapi.fun one line per MCP message with an HMAC caller tag, never the IP). Takes effect on the next
  deploy. Whether Cloudflare's own request records include the client IP is to be verified.
- **Privacy page (draft).** `site/privacy/` (Chinese and English) says what the services we run record and what they
  do not, what Cloudflare, service providers, public RPC nodes and the chain see, and what is still to be verified
  (client IP in Workers logs, Pages access logs, our plan's retention). Not in the sitemap, not linked, `noindex`, and
  not added to any publishing list. `scripts/privacy-logs.test.mjs` checks the configuration and the page;
  `scripts/privacy-words.mjs` holds the ruled-out words both privacy tests use.
- **Session-header switch.** The AI signing sidecar takes `forwardSessionHeaders` (default `true`: unchanged
  behaviour); `false` (`FORWARD_SESSION_HEADERS=0` in the Worker and the new-api sidecar) leaves out the clients'
  session headers (`ai.SESSION_HEADERS`: `x-claude-code-session-id`, `session-id`, `thread-id`), which let the upstream
  tie a caller's requests into one session. `tapeapi-verify --strip-session-headers` does the same on the client side.
  TAPI-21 §8 (both languages, no new keywords) and the AI provider guide say so. New `ai.isSessionHeader`.

### Group delivery (TAPI-27)

- **One call delivers a group update.** A group uses two kinds of room: the epoch message goes to the group room, and
  each new member's invite to that member's own inbox room. An application that posted only `epochWire` set up a group
  nobody could join, and the relay rightly returned 0 frames to the members. New in `@tapeapi/sdk`:
  `deliverGroupUpdate({ group, update, relay, bus })` posts the invites to every new (or named) member's inbox room and
  then the epoch message to the group room, over relays (`relaySend`, optional `payer`) and / or ChannelBus (the
  caller's `sendTx`), and returns every post with its room and the relay's `{ i, epoch }` or its error; any failure
  throws `GROUP_DELIVERY` after all posts were tried (or returns `ok: false` with `throwOnError: false`), and a relay's
  per-source limit is marked `rateLimited` with `retryAfterS`. `checkGroupInvites({ self, identity, relay, cursors })`
  reads the member's inbox room with one cursor per relay and room that keeps the relay's room epoch (first read
  `after: -1, epoch: null`; a stored cursor without an epoch starts over), opens the group invites, and counts what it
  skips; `holder` and `checkSelf` refuse a wallet address or a wrong chainId given for the container.
- `createGroup`, `addMembers`, `removeMembers`, `rotate` and `resumeGroup` now also return `epoch` and `added` (the
  members that need an invite); the owner's handle has `epochWire`, the latest epoch message, for reposts. Nothing
  existing changed shape. The JSDoc and types of `createGroup`, `addMembers` and `inviteFor` say which room each part goes to.
- **TAPI-27 §3.5** (both languages): a non-normative note on the two rooms and on cursors. No requirement changed.
- New guide **Group chat** (`docs/guides/groups.md`, `docs/guides/zh-CN/groups.md`): prerequisites, the owner and member
  flows, relay or ChannelBus, saving state, a troubleshooting checklist and the limits. New example
  `examples/group-chat/`: two throwaway identities over the public relay, with an end-to-end test against a local
  verified relay.

## [0.6.0] — 2026-09-28

### Added

- **X Layer and Base, read-only.** TapeAPI follows TapeOut to X Layer (chainId 196, area code 2) and Base (chainId 8453,
  area code 3). `@tapeapi/sdk/chains` holds the chain registry (processor factory, DeWebHub, SiteRegistry, binding,
  ERC-6551 registry and account implementation per chain, each read on chain; the recorded answers are in
  `sdk/test/fixtures/chains-onchain.json`). Names follow TapeKit `kernel/src/name.js`: `<#ID>.<processor>.tape` on BNB
  Chain, `<#ID>.<area>.<processor>.tape` elsewhere (`1.2.230.tape` is #1 of processor 230 on X Layer); new exports
  `parseTapeName`, `formatTapeName`, `isNameShaped`, `CHAINS`, `chainById`, `chainByArea`, `chainByKey`.
- `resolve()` takes names on any supported chain, `{ chainId, circuits, tokenId }` and `{ chainId, container }`, and
  every resolved service carries its `chainId`. `createTapeAPI({ chains })` configures nodes per chain;
  `api.forChain(id)` and `api.chainOfContainer(address)` are new. Paid methods of an X Layer or Base service are refused
  with `PAYMENT_REQUIRED` ("payments are on BNB Smart Chain only"): payments stay on BNB Chain for now.
- Default nodes per chain, measured 2026-09-28 and counted by operator: X Layer = OKX (two domains) + dRPC, **only two
  independent operators, so 2-of-2 with no spare** (the client warns once); Base = Coinbase, Allnodes, dRPC, Tenderly.
- `tapeapi-mcp` and `tapeapi-verify` accept area-coded names (`--rpc-xlayer`, `--rpc-base`); the verification page,
  playground, "my services" and the console pick the chain from the name (the console has a chain selector and switches
  the wallet; ChannelBus stays on BNB Chain).
- **`examples/new-api-sidecar/`**: one `docker compose up` puts the AI signing sidecar in front of an unchanged new-api
  relay (smoke test and tests included). Guide for AI providers: `docs/guides/ai-providers.md` (and Chinese).
- **`examples/spot-check/`**: a versioned probe set anyone can run against an AI service; it verifies each receipt and
  writes raw data only (reported `prompt_tokens` next to local tokenizer counts), no scores and no rankings.

### Changed

- **TAPI-20 multi-chain text** (§3.1, §3.2, §3.4, §3.6 step 1 and step 3, §5, §6.2): a service lives on the chain of its
  circuit; the container, manifest, `isCPU` and delegation are all read on that chain; the delegation domain is
  (that chain's chainId, that chain's DeWebHub). The DeWebHub has one address on all three chains, so the chainId alone
  separates the domains and a delegation for one chain MUST NOT be accepted on another. Identity does not carry across
  chains. §6.2 adds the digests for chainId 196 and 8453, computed by the SDK and by `verify.py` independently.
- **Behaviour change:** a dotted all-digit string such as `1.2.3` is now an X Layer name, not a directory label. A name
  with a reserved or unassigned area code is refused. BNB Chain behaviour is otherwise unchanged; receipts are unchanged
  (the chain follows from the service name, and a wrong chain derives a different container, which fails the check).

## [0.5.0] — 2026-09-28

### Changed

- **Fee policy (before anything is charged):** no mandatory protocol fee. When paid calls settle through the next
  escrow version (not deployed; only after an independent audit), a default 1% maintenance contribution comes out of the
  provider's share (the consumer's price does not change); any provider can set it to 0, or up to 50%. The default is a
  contract constant: the operator has no fee switch and cannot pause. Planned settlement tokens: BEM (primary), BNB,
  USDT, USDC, ETH, USD1. The permanent 10% of any TapeAPI revenue to @Theairresearch includes this contribution.
  TAPI-22 §3.4, docs/FEES.md, README, the site and the guides say so; the escrow code in the repository still starts at 0
  and changes with the next escrow version.

### Security

- **RPC quorum counts operators, not URLs.** The default BNB Chain nodes were three dataseeds that all belong to one
  operator (NodeReal), so "2 of 3 agree" was one operator agreeing with itself. `createRpc` now counts distinct operators
  (`operatorOf`) and refuses a configuration with fewer operators than its quorum; the defaults (`RPC_DEFAULTS`,
  `rpcUrlsFor(56)`) are NodeReal, Alchemy and 48 Club, each checked to serve block-hash-pinned reads.

### Added

- **AI signing sidecar** `@tapeapi/server/ai-proxy` (`createAIProxy`): put it in front of any OpenAI- or
  Anthropic-compatible API and every call gets a signed usage receipt (service, model, tokens, price, request and
  response hashes), with the bytes passed through unchanged and no change for clients. Formats: OpenAI Chat
  Completions, OpenAI Responses, Anthropic Messages, OpenAI Embeddings; streams keep the receipt in an SSE comment the
  official SDKs ignore, placed before the final event. Example: `examples/ai-proxy/`.
- `@tapeapi/sdk/ai`: `verifyUsageReceipt`, `createVerifyingFetch` (plug into the official OpenAI or Anthropic SDK),
  receipt readers and the price arithmetic (exact, BigInt). The manifest's `ai` field lists the endpoints and the price
  table (BEM, BNB, USDT, USDC, ETH or USD).
- The verification page reads AI usage receipts.
- **Frozen specification** of the AI layer: TAPI-20 §3.9 (the `ai` manifest field: endpoints per format, models with
  aliases and a price per currency, usage and the amount formula) and TAPI-21 §3.5 (AI usage receipts: envelope, request
  and stream hashes, delivery, retrieval, client checks, security). Test vectors in
  `sdk/test/fixtures/ai-receipt-vectors.json`, checked three ways (the sidecar, the SDK and `spec/vectors/verify.py`).
- **`tapeapi-verify`**, a local verifying proxy in the SDK release tarball: point Claude Code (`ANTHROPIC_BASE_URL`)
  or Codex (`OPENAI_BASE_URL`) at it and every answer's receipt is checked against the service's on-chain manifest;
  `--strict` refuses an answer whose receipt fails. Tested end to end with the real Claude Code and Codex CLIs.
- The sidecar forwards the coding agents' session headers (so relays keep session affinity and caching), accepts
  requests up to 32 MiB, waits up to 600 s for a whole answer and ends a stream silent for 300 s; its own errors carry
  `x-tapeapi-sidecar-error: 1`.

### Fixed

- `spec/vectors/tapi-21-envelope.json` was signed over the raw digest instead of the EIP-191 message TAPI-21 §3.3 names;
  regenerated, and `spec/vectors/verify.py` now recovers every vector's signer.

## [0.4.0] — 2026-09-28

### Added

- **Tape out your MCP server.** `@tapeapi/server/mcp-proxy` (`createMcpProxy`) puts a signing proxy in front of an
  existing MCP server (Streamable HTTP, JSON or SSE): the server keeps its own host and domain, gains an on-chain identity
  (a TapeOut circuit's container), its tool definitions are pinned by digest in the on-chain manifest, and every tool
  result is a signed TAPI-21 envelope with a receipt. A runnable example for Node and Cloudflare Workers is in
  `examples/mcp-proxy/`.
- TAPI-20 §3.8, the optional `mcp` binding: `{ endpoint, toolsSha256 }`, where `toolsSha256` is the SHA-256 of the RFC 8785
  canonical JSON of the tools' model-facing fields (`sdk mcp.toolsDigest`). Clients compare it with the `tools/list`
  they receive and refuse a difference.
- TAPI-21: provider code `TOOLS_CHANGED` (HTTP 409): a service whose upstream tools no longer match its `toolsSha256`
  refuses every call, signed, until the holder republishes.
- `tapeapi-mcp` checks `mcp.toolsSha256` against the service's live `tools/list`, shows the upstream tools exactly as
  pinned, returns upstream content with a verified receipt, and pins the tool set (a republished set is a change the
  user must accept).
- The holder console publishes MCP-bound manifests: it reads `tools/list` itself, recomputes the digest in the browser,
  shows every pinned field of every tool before the wallet signs, and refuses invisible or format characters.
- The MCP guide covers taping out your own server.

### Security

- Adversarial review of the MCP code (MCP-R1 to R7), all fixed with tests: the remote `/mcp` caps chunked bodies and
  counts only messages it handles; caller tags in logs are keyed hashes (HMAC) rather than plain hashes of the IP;
  the proxy serves only the digest-covered fields of each tool; tool text that imitates a TapeAPI provenance line is
  labelled as the tool's own output and the genuine line comes first.

## [0.3.0] — 2026-09-28

### Added

- **Remote MCP endpoint** `https://api.tapeapi.fun/mcp` (MCP Streamable HTTP, stateless): the eight public methods as MCP
  tools for Claude, Cursor and any MCP client, added by URL with nothing to install. Every tool result is the service's
  signed TAPI-21 envelope and carries a receipt (`_meta["fun.tapeapi/receipt"]`) and a verification link.
- **Local MCP command** `tapeapi-mcp` in the SDK release tarball
  (`npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v0.3.0/tapeapi-sdk-0.3.0.tgz tapeapi-mcp 11.1013.tape`):
  resolves any TapeOut service on chain, verifies every answer before the model sees it (a tampered answer is discarded),
  and pins each service's tool definitions and signer, refusing calls after they change on chain until the user accepts
  (`--allow-changed`).
- **Receipt verification page** https://tapeapi.fun/verify/: open a receipt link or paste a receipt; the page resolves
  the service on chain in the browser, recovers the signer and says Valid, Invalid, Cannot confirm or Not checked, with
  every check listed.
- `@tapeapi/sdk/mcp`: a transport-free MCP server core (`createMcpServer`), receipts (`receiptOf`, `verifyLink`) and
  `toolResultOf`; `@tapeapi/server/mcp`: `createMcpEndpoint({ provider, manifest })` turns any provider into a remote MCP
  server under the provider's own rate limits.
- Docs: an MCP guide (English and Chinese); the homepage, README and roadmap list the MCP endpoint.

### Changed

- A signed refusal thrown by `api.call` now carries its `id`, `sig` and `error`, so it can be receipted like an answer.
- The relay template (`examples/cloudflare-worker/wrangler-relay.toml`) no longer names the project's own Worker or
  domain: a fork deploys it as `my-tapeapi-relay` with `npm run deploy:my-relay`. The project's own relay config moved
  to `examples/public-api/wrangler-relay.toml`; `npm run deploy:relay` still deploys it, unchanged.
- Web2 adapter: a `${NAME}` in the config expands only from the `env` passed to `buildMethods` (no `process.env`
  default; a name missing from it is refused when the service is created), and a hosted policy (`HOSTED_POLICY`) for
  running other people's configs: https on 443 only, no IP literals, local or platform hosts, at most 3 hosts, no
  redirects, a header allow-list, a fixed User-Agent, a streamed 256 KiB body cap and an optional resolver check
  against private addresses. Responses are capped at 1 MiB under the default policy too.
- Site: stylesheets and scripts carry a content hash (`npm run build:assets`), and the logo has a fixed size without
  its stylesheet.

## [0.2.0] — 2026-09-27

### Added

- ChannelBus deployed on BNB Chain at `0x486110c35d9b90a9d6D85c8063A065f9e7b6b707` (code byte-for-byte the tested build); `MAINNET.channelBus` in the SDK.
  A test message was read back through public nodes, and the deployment is recorded for a replay test.
- **Public service** https://api.tapeapi.fun (`11.1013.tape`): eight free, signed, block-pinned methods: `blockNumber`,
  `balance`, `tokenInfo`, `tokenBalance`, `nftOwner`, `pairPrice`, `bnbUsd`, `tapeName` (source `examples/public-api`).
- **Public relay** https://relay.tapeapi.fun (`12.1013.tape`) for TAPI-26 channels.
- **Playground** https://tapeapi.fun/playground/: resolve any service by name, see every check, call it, copy the code.
- **Status page** https://tapeapi.fun/status/ and a monitor (`npm run monitor`: a GitHub workflow scheduled about every
  30 minutes, which GitHub may delay, that opens an issue when a service is down or a delegation has fewer than 14 days
  left).
- **Docs site** https://tapeapi.fun/docs/ (English and Chinese), generated from `docs/guides` with `npm run build:docs`,
  including a Public API guide.
- SDK: `api.resolve('11.1013.tape')` resolves TapeOut names (`<#ID>.<processor>.tape`) through `factory.cpuAt`.
- Holder console: publishes a service's own free method list; bilingual; hardened (CSP, anti-phishing notice).
- CI runs the JavaScript, Python and Foundry suites on every push.
- **My services** https://tapeapi.fun/dashboard/: a read-only dashboard (add service names; health, delegation expiry,
  links to try or renew; never signs or sends).
- Homepage: live services, a 30-second quick start and a roadmap; `docs/ROADMAP.md`, `CODE_OF_CONDUCT.md`, a rewritten
  `CONTRIBUTING.md` and current issue templates; GitHub private vulnerability reporting enabled.
- Website: social preview (Open Graph / Twitter tags and `og.png`), a favicon, a 404 page, `robots.txt` and `sitemap.xml`.
- The dashboard's "Renew in console" link prefills the console's processor and circuit numbers and service URL; the
  console only fills those fields after checking them, and never reads, signs or sends by itself.

### Changed

- Website: new logo and favicon, one header across all pages, redesigned homepage and social preview.
- `callQuorum`: a signed revert (TAPI-23 §3.3) counts as disagreement and is never an accepted result; other signed
  errors stay neutral. TapeOut names must be in canonical form (TapeKit SPEC §2.2): lowercase, no leading zeros.
- The SDK is installable from each GitHub release: `npm install https://github.com/BruceLanLan/tapeapi/releases/download/v0.2.0/tapeapi-sdk-0.2.0.tgz`.
- Default RPC nodes are bnbchain, defibit and ninicoin dataseeds (publicnode timed out on every request on
  2026-09-27), with a 3 s per-node timeout on the Workers.
- The provider template (`examples/cloudflare-worker/wrangler.toml`) no longer names the project's own Worker or domain.
- The `examples/web2-adapter` config calls Coinbase's public price API (`spotPrice`, `cryptoRates`) instead of
  worldtimeapi.org, which no longer answered, and frankfurter at its current `api.frankfurter.dev` address.

## [0.1.0] — 2026-09-26

First public release. Pre-alpha: the free tier runs on TapeOut's deployed contracts; our own contracts have no
third-party audit.

### Protocol (proposed TAPs, bilingual, English authoritative)

- **TAPI-20** service identity: a service is a circuit, its container is the address, the manifest lives at
  `.well-known/tapeapi.json` in the container's site, and the holder authorises a signing key with an EIP-712
  delegation checked against the current holder.
- **TAPI-21** signed response envelope with the `TAPI-1/resp/v2` digest, bound to the container, the request id, the
  method and parameters, the outcome and the timestamp; canonical JSON; stable error codes.
- **TAPI-22** metered payment: cumulative vouchers, per-provider escrow channels, session keys, a withdrawal cooldown,
  zero protocol fee and an optional voluntary contribution.
- **TAPI-23** attested reads of other chains, **TAPI-24** intent RFQ (frozen), **TAPI-25** circuit-verified methods.
- **TAPI-26** private channels between containers (mutual authentication, forward secrecy, ChaCha20-Poly1305) over
  relays or ChannelBus; **TAPI-27** private groups of up to 32 containers.

### SDK (`@tapeapi/sdk`)

- Resolution from a container or a circuit, with manifest integrity, delegation and processor checks through a
  quorum of RPC nodes that must agree.
- `call` with envelope verification and price consent; `callQuorum` across independent providers pinned to one block.
- Vouchers signed by a wallet or a session key, with meter resynchronisation.
- Channels and groups; relay, ChannelBus and fan-in transports.
- A ChannelBus reader that holds rather than skips: it copes with public nodes' history limits, result caps, empty
  or lagging answers and failures, reads over-full blocks from receipts, and reports every block it cannot read.
- `exposeTapeAPI`: WebMCP tools for in-browser AI agents, with per-call and total budgets for paid methods.

### Provider runtime (`@tapeapi/server`)

- `createProvider` for Node (`listen`) and the Fetch API (`handleRequest`, Cloudflare Workers).
- Signed answers and errors, voucher checks, per-consumer metering (shared D1 meter on Workers), rate limits.

### Contracts

- `ChannelBus`: stateless, ownerless event bus for channel frames.
- `TapeAPIEscrow` and `ServiceDirectory` (not deployed).

### Tooling

- Examples: minimal reader, Web2 adapter, DeFi reads, attested cross-chain reads, relay service, Cloudflare Worker,
  WebMCP demo.
- A black-box conformance suite for providers and relays.
- The holder console at [tapeapi.fun/console](https://tapeapi.fun/console/): go live, publish the manifest and deploy
  ChannelBus from a phone wallet.
- Test vectors with an independent Python verifier; about 630 JavaScript tests and 169 Foundry tests.

[Unreleased]: https://github.com/BruceLanLan/tapeapi/compare/v1.8.1...HEAD
[1.8.1]: https://github.com/BruceLanLan/tapeapi/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/BruceLanLan/tapeapi/compare/v1.7.1...v1.8.0
[1.7.1]: https://github.com/BruceLanLan/tapeapi/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/BruceLanLan/tapeapi/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/BruceLanLan/tapeapi/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/BruceLanLan/tapeapi/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/BruceLanLan/tapeapi/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/BruceLanLan/tapeapi/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/BruceLanLan/tapeapi/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/BruceLanLan/tapeapi/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/BruceLanLan/tapeapi/compare/v1.0.0-rc.5...v1.0.0
[1.0.0-rc.5]: https://github.com/BruceLanLan/tapeapi/compare/v1.0.0-rc.4...v1.0.0-rc.5
[1.0.0-rc.4]: https://github.com/BruceLanLan/tapeapi/compare/v1.0.0-rc.3...v1.0.0-rc.4
[1.0.0-rc.3]: https://github.com/BruceLanLan/tapeapi/compare/v1.0.0-rc.2...v1.0.0-rc.3
[1.0.0-rc.2]: https://github.com/BruceLanLan/tapeapi/compare/v1.0.0-rc.1...v1.0.0-rc.2
[1.0.0-rc.1]: https://github.com/BruceLanLan/tapeapi/compare/v0.8.0...v1.0.0-rc.1
[0.8.0]: https://github.com/BruceLanLan/tapeapi/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/BruceLanLan/tapeapi/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/BruceLanLan/tapeapi/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/BruceLanLan/tapeapi/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/BruceLanLan/tapeapi/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/BruceLanLan/tapeapi/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/BruceLanLan/tapeapi/releases/tag/v0.2.0
[0.1.0]: https://github.com/BruceLanLan/tapeapi/releases/tag/v0.1.0
