# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).
Before 1.0.0, a minor version may change interfaces.

## [Unreleased]

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

[Unreleased]: https://github.com/BruceLanLan/tapeapi/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/BruceLanLan/tapeapi/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/BruceLanLan/tapeapi/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/BruceLanLan/tapeapi/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/BruceLanLan/tapeapi/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/BruceLanLan/tapeapi/releases/tag/v0.2.0
[0.1.0]: https://github.com/BruceLanLan/tapeapi/releases/tag/v0.1.0
