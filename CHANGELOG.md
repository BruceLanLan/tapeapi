# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).
Before 1.0.0, a minor version may change interfaces.

## [Unreleased]

- ChannelBus mainnet address, once deployed.

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

[Unreleased]: https://github.com/BruceLanLan/tapeapi/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/BruceLanLan/tapeapi/releases/tag/v0.1.0
