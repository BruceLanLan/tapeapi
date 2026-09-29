# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).
From 1.0.0 on, a breaking change comes only in a new major version (2.0); before 1.0.0, a minor version could change
interfaces.

## [Unreleased]

## [1.2.0] — 2026-09-30

### Added

- **Larger groups (experimental): TAP-27 §3.8 format 2, up to 128 members in one wire message.** Binary roster
  (104 bytes a member), a marker in the epoch field that every format-1 client refuses (`GROUP_INVALID`, tested
  against the released 1.1.0 code), lazy member checks (`open().verified`, `openVerified`, `verifyMembers`,
  `verifyReuseS`, at most 86,400 s, counted from the start of the check), `channelKeysVerifier` (use it, not
  `api.groupVerifier()`, for format 2), vectors `spec/vectors/tap-27-group-v2.json`. Only positive verdicts are reused;
  a negative one lasts at most 60 s (`VERIFY_NEGATIVE_S`), is confirmed by a fresh read and never refuses an epoch.
  On-demand and background checks share the `verifyConcurrency` limit. Format 1 stays the default and its bytes are
  unchanged (`joinGroup` without `format` ignores `verifyMember`, as before); one group never mixes formats. TAP-27 §8 states what format 2 weakens (a
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
  - `requireContentSig`: refuse a manifest without a valid holder content signature (TAP-20 §3.10). Without it, a
    content signature is only reported (`svc.contentSig`, warnings), and an error while checking it is the warning
    `CONTENT_SIG_UNCHECKED`: it never fails a resolve.
  - `delegationFloor`: remember the highest delegation `expires` seen per chain, container, holder and signer, and
    refuse an older one put back (a rollback of a re-published manifest); a new signer starts its own floor, and
    `api.clearDelegationFloor(error.data)` forgets one. A site writer can still put back an older holder-signed
    delegation with a higher `expires`.
  - `onWarning`, `clock`.
- **TAP-20 §3.10: optional holder-signed manifest content** (`contentSig`,
  `ManifestContent(address container,bytes32 contentHash)` in the delegation domain), so that whoever can write the
  site cannot silently change `ai.baseUrl` or prices under a valid delegation when the client requires it.
  `sig.manifestContent*` helpers, vectors `spec/vectors/tap-20-content.json` (checked by `verify.py`).
- **`security` namespace**: `erc6551Account`; ContradictionRecord v1 (`contradictionRecord`, `contradictionsOf`,
  `verifyContradiction`): evidence anyone can check when providers sign conflicting answers to the same request at the
  same block (`verifyContradiction` says `valid` only when `signerOf` confirms every signer as the provider's
  delegated signer, otherwise `signaturesConsistent: true`; the block-pinned form suits methods whose result is
  deterministic); `withSpotCheck`, a wrapper that re-asks an independent provider at a given rate (0, off, by default).

### Changed

- Groups: the TAP-27 §3.3 step 6 member checks run in parallel (`verifyConcurrency`, default 8), with the same outcome
  and errors as before. A 32-member cold start at 280 ms per request: about 45 s before, about 6 s now.
- Every `42.1013.tape` example says it is an example name (it has no manifest, so a command run as written stops
  with "no file at /.well-known/tapeapi.json") and points to the local trial; `tapeapi-verify` adds a hint to
  `tapeapi-doctor` and the trial when it cannot use a name.
- `ATTEST_DISAGREE` errors carry the verified signed envelopes and the request in `error.data` (`envelopes`,
  `request`), so the disagreement can be kept as evidence.
- A cold resolve on the chain's own contracts sends the sentinel's two ERC-1967 slot reads to each node alone, in the
  same round as the batch (never batched, so the `eth_call` batches stay those of 1.1.0): still 4 rounds, 18 requests
  instead of 12, cached for 300 s. `pin` adds one round.
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
  pays (TAP-22 payment channels, the escrow, vouchers, `api.payer()`, `maxPrice`, the channel builders of `api.tx`,
  `api.chain.escrow.*`), the ServiceDirectory (`api.chain.resolve()`, `api.chain.serviceOf()`, directory labels, the
  `directory` option, `labelToBytes32` and the label helpers of `abi`), and the whole `@tapeapi/sdk/bus-privacy`
  subpath. Reading prices from a manifest and the codes `PAYMENT_REQUIRED`, `BAD_VOUCHER` and `PRICE_CHANGED` are
  Stable: a free service's client can meet them too.
- **Internal:** marked `@internal`, or not exported.

The full lists, what changed from 0.x and the error-code table are in the upgrade guide:
[docs/guides/upgrade-1.0.md](docs/guides/upgrade-1.0.md) (https://tapeapi.fun/docs/en/upgrade-1.0).

### Specification statuses (TAP-1 §4.1)

- **TAP-20, TAP-21, TAP-23, TAP-26 and TAP-27 are Stable (v1)** since 2026-09-29; their `Target` rows are gone. Every
  field, encoding, signature domain and error code they define keeps its meaning; a revision may add only optional
  content and non-normative text; a breaking change is a v2 with its own wire markers, and v1 is not withdrawn earlier
  than 12 months after v2 becomes Stable.
- **TAP-20 §3.5 (ServiceDirectory) is Experimental**, outside the freeze (TAP-1 §4.1, freeze rule 3), and so are the
  places that use it: a label as input to §3.6 step 1, the `serviceOf` cross-check and `verifyDelegation` in §3.4.
  Resolution by name, container or `(circuits, tokenId)` needs no directory.
- **TAP-21's error codes, `PAYMENT_REQUIRED` and `BAD_VOUCHER` among them, are frozen with TAP-21**, although the
  payment flow that uses them is in TAP-22, which is Experimental.
- Unchanged: TAP-22 and TAP-25 Experimental, TAP-24 Withdrawn, TAP-1 Draft. No normative text changed. The TAP numbers
  are still proposals to the TapeKit maintainers ([TapeKit#8](https://github.com/TapeOutProtocol/TapeKit/issues/8)).
- The Chinese halves of TAP-26 and TAP-27 gain the RFC 2119 keyword sentence their English halves already had
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

- **The public copy keeps git's executable bit.** `scripts/stage-public.mjs` wrote every file 0644, so the CLIs in
  `sdk/bin` reached the public repository without their executable bit once; they keep 100755 now, with a test.

### From 1.0.0-rc.1 to 1.0.0-rc.5

- **rc.1**, the interface freeze: `INVALID_ARGUMENT` for the caller's own mistakes; fixed `TapeAPIError` top-level
  fields (details in `e.data`, the old names deprecated until 2.0); `service`, `relayClients` / `busClients`,
  `rpcTimeoutMs`, `name` for MCP, `clock` in Unix seconds; `openai-proxy` removed; narrower public faces for `ai`,
  `channel`, `rpc` and `group`; `createVerifyingFetch` verifies streams the official SDKs read; provider dev mode only
  through `opts.dev`; TAP-1 §4.1 statuses; the TAP-20 §6.1 mainnet manifest and TAP-23 §6 vectors (the Python
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
  delivery (group invites, TAP-26 invites, messages to a peer that was not polling at that moment) mostly failed. The
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
  page and fails if one throws while loading (RC-1 could not show there); its TAP-21 envelope checks sign EIP-191, as
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
  steps 3-5 of TAP-20 §3.6 in one round), each still checked in its old place with the same error codes; `fileInfo`
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
  and `scripts/publish-site.mjs` inlines the fonts back into the self-contained DeWEB copy, which still makes no
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
  protocol refusals of `callQuorum` are unchanged. TAP-21 §3.4 lists it, with `GROUP_DELIVERY`, `BAD_RESPONSE`,
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
  e.g. `Date.now`), on the owner's side and the member's: `clock must return Unix seconds`. The TAP-27 vectors are
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
  the fee note uses the current wording, and says no call is charged today. Spec statuses follow TAP-1 §4.1. The
  examples use `rpcUrlsFor(56)`; a new one plugs `createVerifyingFetch` into the official OpenAI SDK. Every example was
  run against the v0.8.0 release package (the AI one against the reference sidecar in `examples/ai-proxy`, since no
  outside provider has published a price table yet).
- **README.md and README.zh-CN.md rewritten** to the same standard: the value in the first lines, a table of first
  steps per reader, short examples that run (install from the release package, AI receipts, `tapeapi-verify`, MCP), a
  Mermaid diagram of the layers, what a receipt proves, status and commitments, privacy, fees and the specs with their
  statuses. Contract addresses and repository detail now live in the guides.

### Specification statuses toward 1.0 (TAP-1 §4.1)

- **TAP-1 §4.1 defines the interim statuses** this repository uses until TapeKit adopts a numbered-proposal process:
  Draft, **Stable (v1)**, Experimental and Withdrawn. Stable (v1) freezes every field, encoding, signature domain and
  error code; a revision may only add optional content or non-normative text; a breaking change is a new version (v2)
  with its own wire markers, v1 stays valid beside it and is not withdrawn earlier than 12 months after v2 becomes
  Stable. When TapeKit assigns numbers or statuses, TapeKit's prevails and the front matter records the mapping.
  A new optional front-matter row, `Target`, names the status a Draft intends to reach.
- **Status rows.** TAP-20, TAP-21, TAP-23, TAP-26 and TAP-27 stay Draft with `Target | Stable (v1) at TapeAPI 1.0`;
  TAP-22 (metered payment and escrow) and TAP-25 (circuit-verified methods) are **Experimental**; TAP-24 (intent RFQ,
  frozen since 2026-09-21) is **Withdrawn**. No normative text of TAP-20 to TAP-27 changed.

### Test vectors

- **TAP-20 §6.1 mainnet manifest filled in**: the live manifest of `11.1013.tape`, read only through `resolve` on the
  SDK's default BSC nodes (quorum 2 by operator, all three operators identical), every `eth_call` pinned to block
  124552456 by EIP-1898 `{ blockHash }`: size 3414, SHA-256 `0xee57f304…3b52c37a`, signer, delegation expiry and holder.
  Recorder `scripts/record-mainnet-manifest.mjs`, fixture `sdk/test/fixtures/mainnet-11-1013-manifest.json`, offline
  replay `sdk/test/mainnet-manifest.test.mjs` (clock pinned to the block; the table in the spec must quote the
  fixture). The delegation is renewed before 2026-12-10, so the fixture pins a block's state, not the current manifest.
- **TAP-23 §6 vectors**: `spec/vectors/tap-23-attested.json` (from `scripts/gen-vectors.mjs`), two providers signing
  with public test keys, real Ethereum values for the example request (block 20000000, USDT `totalSupply()`), two
  agreeing cases and three `ATTEST_DISAGREE` counterexamples, replayed through `callQuorum` by
  `sdk/test/attested-vectors.test.mjs`. §6 now says plainly that no live service offers `attestedRead` yet
  (`11.1013.tape` does not) and what the smallest change would be.
- **`spec/vectors/verify.py`** checks both independently: it re-encodes the mainnet calldata, ABI-decodes the answers,
  hashes and parses the manifest and recovers the delegation to `ownerOf`; and it rebuilds each TAP-23 envelope digest,
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
  back and coming back, what `k` means, what it helps against and what it does not). TAP-26 §8 gains a non-normative
  note, "Node correlation", in both languages; no MUST/SHOULD/MAY changed.

### Holder console: AI price tables

- **The console publishes a manifest with an `ai` field** (TAP-20 §3.9). `site/console/lib.js` gains `aiProblems` and
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

- **Guessable receipt ids.** The AI signing sidecar keeps the upstream's answer id (TAP-21 §3.5), and some upstreams'
  ids can be guessed: Ollama's OpenAI-compatible API numbers chat ids `chatcmpl-0` to `chatcmpl-998`, so anyone could
  walk through the free `receipt` method and read every receipt kept. The sidecar now estimates the randomness of the
  ids it sees (`idEntropyBits`, threshold `ID_ENTROPY_MIN_BITS` = 64) and warns once in its log when they look
  guessable (a low estimate, or one id seen twice while kept); keeps receipts per (`id`, `requestSha256`), so answers
  that share an id no longer overwrite each other (an id-only lookup still serves the later one); gives the `receipt`
  method a budget of its own (`receiptRateLimit`, default 10 lookups per client IP per minute, refused with the unsigned
  429 of TAP-21 §3.4); states the configurable lifetime (`receiptTtlMs`) in the method description (unchanged at the
  default); and, with `requireRequestHash` (off by default), answers only lookups that also name `requestSha256`.
  Worker variables `RECEIPT_TTL_S`, `RECEIPT_LOOKUPS_PER_MIN`, `RECEIPT_REQUIRE_HASH`; the new-api sidecar takes
  `RECEIPT_TTL_S` and `RECEIPT_REQUIRE_HASH`. **TAP-21 §3.5** (both languages): the `receipt` method MAY take an optional
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
  `salted`. New exports `ai.saltRequestBody` and `ai.SALT_LENGTH`. TAP-21 §8 and the AI provider guide explain why the
  cache is unaffected. Acceptance by the live OpenAI and Anthropic APIs is not yet measured (the tests use the
  reference sidecar).
- **Hash-only MCP receipts and verify links.** `verifyLink` used to put the whole receipt, params and result in clear,
  into the link, so sharing a link shared the call. It now carries the hash-only form by default (`mcp.hashReceipt`,
  receipt `v: 2`: `params` and `result`/`error` replaced by `requestHash` = keccak256(canonicalJSON({ method, params }))
  and `bodyHash` = keccak256(canonicalJSON(result or error)), the two hashes the TAP-21 digest is built from, so the
  signature still verifies). The whole receipt goes into the link only when asked: `verifyLink(r, base, { content: true
  })`, `toolResultOf({ linkContent: true })`, `linkContent` on `createMcpEndpoint` and `createMcpProxy` (`LINK_CONTENT=1`
  in the MCP proxy Worker), `tapeapi-mcp --link-content`. The provenance note says which form its link carries. The
  receipt in `_meta` stays whole. New `sig.responseRequestHash`, `sig.responseBodyHash`,
  `sig.responseDigestFromHashes`, `sig.recoverResponseSignerFromHashes` (the same digest, checked against every
  published TAP-21 envelope vector). The verification page reads both forms, shows the hashes and says that
  low-entropy params (an address, a token id, a price pair) can still be guessed from their hash. The reputation design
  now attaches hash-only receipts. The TAP-21 envelope and digest are
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
  TAP-21 §8 (both languages, no new keywords) and the AI provider guide say so. New `ai.isSessionHeader`.

### Group delivery (TAP-27)

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
- **TAP-27 §3.5** (both languages): a non-normative note on the two rooms and on cursors. No requirement changed.
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

- **TAP-20 multi-chain text** (§3.1, §3.2, §3.4, §3.6 step 1 and step 3, §5, §6.2): a service lives on the chain of its
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
  TAP-22 §3.4, docs/FEES.md, README, the site and the guides say so; the escrow code in the repository still starts at 0
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
- **Frozen specification** of the AI layer: TAP-20 §3.9 (the `ai` manifest field: endpoints per format, models with
  aliases and a price per currency, usage and the amount formula) and TAP-21 §3.5 (AI usage receipts: envelope, request
  and stream hashes, delivery, retrieval, client checks, security). Test vectors in
  `sdk/test/fixtures/ai-receipt-vectors.json`, checked three ways (the sidecar, the SDK and `spec/vectors/verify.py`).
- **`tapeapi-verify`**, a local verifying proxy in the SDK release tarball: point Claude Code (`ANTHROPIC_BASE_URL`)
  or Codex (`OPENAI_BASE_URL`) at it and every answer's receipt is checked against the service's on-chain manifest;
  `--strict` refuses an answer whose receipt fails. Tested end to end with the real Claude Code and Codex CLIs.
- The sidecar forwards the coding agents' session headers (so relays keep session affinity and caching), accepts
  requests up to 32 MiB, waits up to 600 s for a whole answer and ends a stream silent for 300 s; its own errors carry
  `x-tapeapi-sidecar-error: 1`.

### Fixed

- `spec/vectors/tap-21-envelope.json` was signed over the raw digest instead of the EIP-191 message TAP-21 §3.3 names;
  regenerated, and `spec/vectors/verify.py` now recovers every vector's signer.

## [0.4.0] — 2026-09-28

### Added

- **Tape out your MCP server.** `@tapeapi/server/mcp-proxy` (`createMcpProxy`) puts a signing proxy in front of an
  existing MCP server (Streamable HTTP, JSON or SSE): the server keeps its own host and domain, gains an on-chain identity
  (a TapeOut circuit's container), its tool definitions are pinned by digest in the on-chain manifest, and every tool
  result is a signed TAP-21 envelope with a receipt. A runnable example for Node and Cloudflare Workers is in
  `examples/mcp-proxy/`.
- TAP-20 §3.8, the optional `mcp` binding: `{ endpoint, toolsSha256 }`, where `toolsSha256` is the SHA-256 of the RFC 8785
  canonical JSON of the tools' model-facing fields (`sdk mcp.toolsDigest`). Clients compare it with the `tools/list`
  they receive and refuse a difference.
- TAP-21: provider code `TOOLS_CHANGED` (HTTP 409): a service whose upstream tools no longer match its `toolsSha256`
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
  signed TAP-21 envelope and carries a receipt (`_meta["fun.tapeapi/receipt"]`) and a verification link.
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
- **Public relay** https://relay.tapeapi.fun (`12.1013.tape`) for TAP-26 channels.
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
- `callQuorum`: a signed revert (TAP-23 §3.3) counts as disagreement and is never an accepted result; other signed
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

- **TAP-20** service identity: a service is a circuit, its container is the address, the manifest lives at
  `.well-known/tapeapi.json` in the container's site, and the holder authorises a signing key with an EIP-712
  delegation checked against the current holder.
- **TAP-21** signed response envelope with the `TAPI-1/resp/v2` digest, bound to the container, the request id, the
  method and parameters, the outcome and the timestamp; canonical JSON; stable error codes.
- **TAP-22** metered payment: cumulative vouchers, per-provider escrow channels, session keys, a withdrawal cooldown,
  zero protocol fee and an optional voluntary contribution.
- **TAP-23** attested reads of other chains, **TAP-24** intent RFQ (frozen), **TAP-25** circuit-verified methods.
- **TAP-26** private channels between containers (mutual authentication, forward secrecy, ChaCha20-Poly1305) over
  relays or ChannelBus; **TAP-27** private groups of up to 32 containers.

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

[Unreleased]: https://github.com/BruceLanLan/tapeapi/compare/v1.2.0...HEAD
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
