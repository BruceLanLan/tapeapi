# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).
Before 1.0.0, a minor version may change interfaces.

## [Unreleased]

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

[Unreleased]: https://github.com/BruceLanLan/tapeapi/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/BruceLanLan/tapeapi/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/BruceLanLan/tapeapi/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/BruceLanLan/tapeapi/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/BruceLanLan/tapeapi/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/BruceLanLan/tapeapi/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/BruceLanLan/tapeapi/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/BruceLanLan/tapeapi/releases/tag/v0.2.0
[0.1.0]: https://github.com/BruceLanLan/tapeapi/releases/tag/v0.1.0
