# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).
Before 1.0.0, a minor version may change interfaces.

## [Unreleased]

### Changed

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

[Unreleased]: https://github.com/BruceLanLan/tapeapi/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/BruceLanLan/tapeapi/releases/tag/v0.2.0
[0.1.0]: https://github.com/BruceLanLan/tapeapi/releases/tag/v0.1.0
