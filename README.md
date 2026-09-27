# TapeAPI

**Tape out a circuit, and its container is your API.** Every response is signed by it, anyone can verify it against the
chain, and containers can talk to each other over end-to-end encrypted channels.

TapeAPI is the service and communication layer of the [TapeOut](https://tapeout.net) ecosystem on BNB Chain. In that
ecosystem, DeWEB is websites, TapeSend is messaging, and **TapeAPI is services**.

[![CI](https://github.com/BruceLanLan/tapeapi/actions/workflows/ci.yml/badge.svg)](https://github.com/BruceLanLan/tapeapi/actions/workflows/ci.yml)
[![Code: MIT](https://img.shields.io/badge/code-MIT-blue.svg)](LICENSE)
[![Spec: CC0-1.0](https://img.shields.io/badge/spec-CC0--1.0-lightgrey.svg)](LICENSE-SPEC)
[![Docs](https://img.shields.io/badge/docs-tapeapi.fun-blue.svg)](https://tapeapi.fun/docs/)
[![Playground](https://img.shields.io/badge/try-playground-orange.svg)](https://tapeapi.fun/playground/)
[![Status](https://img.shields.io/badge/status-tapeapi.fun%2Fstatus-green.svg)](https://tapeapi.fun/status/)

[中文说明](README.zh-CN.md) · [Guides](docs/guides/) · [Specifications](spec/) · [Examples](examples/) · [Docs](https://tapeapi.fun/docs/) · [Website](https://tapeapi.fun) · [Changelog](CHANGELOG.md) · [Roadmap](docs/ROADMAP.md) · [Contributing](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md)

> **Status: pre-alpha (v0.2.0).** The free tier needs no contract of ours and runs on TapeOut's deployed contracts.
> Our own contracts (the paid-call escrow, the service directory, ChannelBus) are **not audited by a third party**;
> ChannelBus is deployed (address below). Interfaces may still change. The TAP
> numbers below are **proposed** to the TapeKit maintainers and not yet assigned.

## Try the live service in 30 seconds

A free public service runs at `https://api.tapeapi.fun` under the TapeOut name `11.1013.tape`. Ask it for the BNB price:

```bash
curl -s https://api.tapeapi.fun/tapeapi/v1/bnbUsd -H 'content-type: application/json' -d '{"id":"1","params":{}}'
```

curl shows you the signed envelope (`result`, `container`, `ts`, `block`, `sig`) but does not check it. The SDK does.
The packages are not on npm yet, so set up the repository once (Node.js 20 or later):

```bash
git clone https://github.com/BruceLanLan/tapeapi.git && cd tapeapi && npm install
```

Or install just the SDK into your own project from the GitHub release (not the npm registry):

```bash
npm install https://github.com/BruceLanLan/tapeapi/releases/download/v0.2.0/tapeapi-sdk-0.2.0.tgz
```

Save this as `try.mjs` **inside the `tapeapi` directory** (`@tapeapi/sdk` resolves through the repository's workspace;
a script saved anywhere else fails with `ERR_MODULE_NOT_FOUND`) and run `node try.mjs`:

```js
import { createTapeAPI } from '@tapeapi/sdk'

const api = createTapeAPI({
  rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-dataseed1.ninicoin.io'],
  quorum: 2,
})
const svc = await api.resolve('11.1013.tape')             // name -> container -> on-chain manifest -> holder's delegation
const { result, verified } = await api.call(svc, 'bnbUsd', {})
console.log(result, verified)                              // verified is true only after the signature checked out
```

No install at all: the [playground](https://tapeapi.fun/playground/) runs the same SDK in the browser. Every method of
the public service is listed in [Public API](docs/guides/public-api.md).

---

## Why TapeAPI

An API today is a URL plus an account plus trust. You sign up with the vendor, you trust whatever its server says,
and the vendor can change the answer, the price or the rules at any time.

TapeAPI makes the identity of a service an on-chain object and every answer a signed statement:

- **The service is a circuit.** Whoever holds the circuit NFT owns the service. Transfer the NFT and the service moves
  with it; nobody can take the name away.
- **Every answer is signed and bound to your request.** A client checks the signature against a key the circuit's
  holder authorised on chain. A tampered, replayed or unsigned answer is an error, never a result.
- **No sign-up, no API keys.** Free methods are just called. Paid methods are paid with off-chain vouchers that settle
  on chain in batches; the protocol takes **zero fees**.
- **Private channels between containers.** Two services, two agents or two apps can open an end-to-end encrypted
  channel, carried by a relay or by the chain itself, where the carrier only ever sees ciphertext.

## How it works

```mermaid
sequenceDiagram
    autonumber
    participant C as Client (SDK)
    participant B as BNB Chain
    participant S as Service
    C->>B: resolve: circuit -> container (DeWebHub), holder (ownerOf)
    C->>B: read the manifest from the container's site (SiteRegistry, SHA-256 checked)
    Note over C: check the holder's EIP-712 delegation of the service's signing key
    C->>S: POST /tapeapi/v1/{method} { id, params, voucher? }
    S-->>C: { result, container, ts, block, sig }
    Note over C: verify the signature over the request and the answer; only then return the result
```

1. **Identity (TAP-20).** A circuit's ERC-6551 container is the service identity. Its site holds
   `.well-known/tapeapi.json`, the manifest: endpoints, methods, prices and the service's signing key.
2. **Delegation.** The circuit's holder signs an EIP-712 delegation that names that signing key and an expiry. The
   domain is anchored on TapeOut's deployed DeWebHub, so a service works before any contract of ours exists.
3. **Signed envelope (TAP-21).** Every answer, success or error, is signed over a digest that binds the container,
   the request id, the method and parameters, the result and a timestamp.
4. **Payment (TAP-22).** Paid methods take cumulative vouchers, settled from a per-provider escrow channel.
5. **Channels (TAP-26, TAP-27).** Holder-authorised channel keys, an X3DH-style handshake and ChaCha20-Poly1305
   frames, over a relay or over ChannelBus, a stateless event-only contract.

## Quick start

Requirements: Node.js 20 or later. The packages are not on npm yet; use the repository.

```bash
git clone https://github.com/BruceLanLan/tapeapi.git
cd tapeapi
npm install
```

### Call a service

Run the minimal example service locally (it reads BNB Chain through public nodes):

```bash
node examples/reader-service/index.mjs        # listens on :8787 with a throwaway signing key
```

Call it from code. The SDK resolves the manifest, calls the method and verifies the signature before it returns:

```js
import { createTapeAPI } from '@tapeapi/sdk'

const api = createTapeAPI({ dev: true })                           // dev: allow a local http:// service
const svc = await api.resolve({ dev: 'http://127.0.0.1:8787' })
const { result, verified } = await api.call(svc, 'blockNumber', {})
console.log(result.blockNumber, verified)
```

On mainnet, resolve by TapeOut name, container address or circuit, with at least two RPC nodes that must agree:

```js
const api = createTapeAPI({
  rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-dataseed1.ninicoin.io'],
  quorum: 2,
})
const svc = await api.resolve('0x<container>')                     // or '11.1013.tape', or { circuits: '0x…', tokenId: '11' }
const { result } = await api.call(svc, 'blockNumber', {})
```

Or with curl, and verify by hand later ([how](docs/guides/consume.md#verify-without-the-sdk)):

```bash
curl -s -X POST http://127.0.0.1:8787/tapeapi/v1/blockNumber \
  -H 'content-type: application/json' -d '{"id":"1","params":{}}'
```

### Run a service

Wrap any function, or any existing REST API, as a signed method:

```js
import { createProvider } from '@tapeapi/server'

const provider = createProvider({
  manifest,                                  // your tapeapi.json
  signerKey: process.env.SIGNER_KEY,         // the key the circuit's holder delegates to
  rpcUrls: [/* >= 2 BNB Chain nodes */], quorum: 2,
  methods: {
    blockNumber: async (_params, ctx) => ({ blockNumber: ctx.block }),
    quote: async ({ symbol }) => fetch(`https://your.api/quote/${symbol}`).then((r) => r.json()),
  },
})
await provider.listen(8787)                  // Node; on Cloudflare Workers use provider.handleRequest(request)
```

Going live takes a circuit with an opened container, a delegation signed by its holder, and the manifest written to
the container's site. The [holder console](https://tapeapi.fun/console/) does all three from a phone wallet. See
[Run a service](docs/guides/provide.md).

## Features

| | |
|---|---|
| **Verifiable answers** | Signed envelopes bound to the exact request; signer checked against the on-chain holder; freshness window; an independent Python implementation checks the test vectors. |
| **Quorum reads** | Chain reads need agreement from every answering node, never a majority. `callQuorum` accepts a result only when independent providers return the same bytes. |
| **Pay per call** | Cumulative EIP-712 vouchers, session keys, an escrow with a withdrawal cooldown, zero protocol fee, optional voluntary contribution chosen by each provider. |
| **Private channels** | TAP-26: mutual authentication, forward secrecy, per-direction keys, replay and reorder protection; relay or on-chain transport. |
| **Private groups** | TAP-27: up to 32 containers, owner-managed epochs, encrypted roster, per-sender signatures. |
| **On-chain transport that does not lose messages** | The ChannelBus reader holds rather than skips: it works with public nodes' history limits, result caps and failures, and warns about anything it cannot read. Tested with thousands of randomised adversarial runs. |
| **AI agents** | `exposeTapeAPI` turns any service into WebMCP tools for in-browser agents; every answer is signature-checked, paid methods need an explicit budget. |
| **Runs anywhere** | Node, Cloudflare Workers (Fetch API), browsers and DeWEB sites; three small audited dependencies (`@noble/curves`, `@noble/hashes`, `@noble/ciphers`). |

## Packages and repository layout

| Path | What it is |
|---|---|
| [`sdk/`](sdk/) | `@tapeapi/sdk`: resolve, call, pay, verify, channels, groups, WebMCP bridge. |
| [`server/`](server/) | `@tapeapi/server`: the provider runtime (Node `listen` and Fetch `handleRequest`), metering, rate limits. |
| [`contracts/`](contracts/) | Solidity with Foundry tests: `TapeAPIEscrow`, `ServiceDirectory`, `ChannelBus`. |
| [`spec/`](spec/) | The TAPs, bilingual (English authoritative), with test vectors and an independent Python verifier. |
| [`examples/`](examples/) | Runnable services: minimal reader, Web2 adapter, DeFi reads, attested cross-chain reads, a relay, a Cloudflare Worker, a WebMCP demo. |
| [`conformance/`](conformance/) | A black-box suite any provider or relay implementation can run against a URL. |
| [`site/`](site/) | The website and the holder console (`site/console/`), plain static files. |
| [`docs/`](docs/) | Guides and design notes; start at [`docs/README.md`](docs/README.md). |

## Specifications

| TAP | Title | In one line |
|---|---|---|
| [TAP-1](spec/TAP-1.md) | TAP process | Types, statuses, numbering and required sections. |
| [TAP-20](spec/TAP-20.md) | Service identity and manifest | A service is a circuit; `.well-known/tapeapi.json`; the holder's EIP-712 delegation; the resolution algorithm. |
| [TAP-21](spec/TAP-21.md) | Signed response envelope | `POST {live}/{method}`; the `TAPI-1/resp/v2` digest; canonical JSON; error codes. |
| [TAP-22](spec/TAP-22.md) | Metered payment | Cumulative vouchers, per-provider escrow channels, zero protocol fee. |
| [TAP-23](spec/TAP-23.md) | Attested Read | Signed, block-pinned reads of other chains, agreed by independent providers. |
| [TAP-24](spec/TAP-24.md) | Intent RFQ | Signed quotes for bridge-free cross-chain swaps (frozen until staking exists). |
| [TAP-25](spec/TAP-25.md) | Circuit-Verified Methods | Methods bound to a circuit whose on-chain `eval()` settles disputes. |
| [TAP-26](spec/TAP-26.md) | Tape Channel | End-to-end encrypted channels between containers; relays and ChannelBus. |
| [TAP-27](spec/TAP-27.md) | Tape Group | Private groups of up to 32 containers. |

## On-chain addresses (BNB Chain, chainId 56)

| Contract | Address | Owner |
|---|---|---|
| DeWebHub | `0xe61A9C7213a6Aa616C246a2B569e555B417b25ee` | TapeOut (deployed) |
| SiteRegistry | `0xd006ffdd5Ae313B17729621A00999cD3C71CE5e6` | TapeOut (deployed) |
| Processor factory | `0x68224F668083c29e9800Be2a646d42d18cedF7e2` | TapeOut (deployed) |
| BEM token | `0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a` | TapeOut (deployed) |
| ChannelBus | [`0x486110c35d9b90a9d6D85c8063A065f9e7b6b707`](https://bscscan.com/address/0x486110c35d9b90a9d6D85c8063A065f9e7b6b707) | TapeAPI (no owner, no state, no upgrade path) |
| TapeAPIEscrow, ServiceDirectory | *not deployed* | TapeAPI |

## Quality

- **Tests:** about 710 JavaScript tests (`npm test`), 169 Foundry tests (`cd contracts && forge test`), and 102
  checks by an independent Python implementation of the signatures, hashes and encodings
  (`python3 spec/vectors/verify.py`).
- **Adversarial review:** twelve rounds of review with a written finding, a failing test and a fix for each; the
  on-chain reader is covered by a randomised test of faulty, lying and noisy nodes, reorgs and room changes.
- **Recorded reality:** what real BNB Chain nodes answer (history refusals, result caps, lagging backends) is recorded
  from mainnet and replayed in tests.
- **Not yet:** an external audit of the contracts. Do not hold funds you cannot afford to lose in the escrow.

## Security

Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md). Please do not open public issues for
security problems.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Specification changes go through the
TAP process in [TAP-1](spec/TAP-1.md). All three test suites must pass.

## License

Code is MIT ([LICENSE](LICENSE)): `contracts/`, `sdk/`, `server/`, `examples/`, `conformance/`, `scripts/`, `site/`.
The specifications in `spec/` are CC0-1.0 ([LICENSE-SPEC](LICENSE-SPEC)).

## Credits

The idea of a service layer for TapeOut, "DeWEB is websites, TapeSend is messaging, TapeAPI is services", came from
**[@Theairresearch](https://x.com/Theairresearch/status/2101640697426448632)**. A permanent 10% of any revenue
TapeAPI earns goes to them.

Built on [TapeOut](https://tapeout.net) and [TapeKit](https://github.com/TapeOutProtocol/TapeKit).
