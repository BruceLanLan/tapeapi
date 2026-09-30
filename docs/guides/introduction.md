# Introduction

**Tape out a circuit, and its container is your API.** TapeAPI is the service and communication layer of the
[TapeOut](https://tapeout.net) ecosystem on BNB Chain: DeWEB is websites, TapeSend is messaging, and TapeAPI is
services.

An API today is a URL plus an account plus trust. TapeAPI replaces the account with an on-chain identity and the
trust with a signature anyone can check:

- **The service is a circuit.** Whoever holds the circuit NFT owns the service. Transfer the NFT and the service moves
  with it.
- **Every answer is signed and bound to your request.** A client checks the signature against a key the circuit's
  holder authorised on chain. A tampered, replayed or unsigned answer is an error, never a result.
- **No sign-up, no API keys.** Free methods are just called. Paid methods take off-chain vouchers that settle on chain
  in batches. There is no mandatory protocol fee: a default 1% maintenance contribution comes out of the provider's
  share, and any provider can set it to 0. No call is charged today; the escrow is not deployed yet.
- **Containers can talk privately.** End-to-end encrypted channels and groups between containers, carried by relays or
  by the chain itself.

## How it works

1. **Identity.** A provider tapes out a circuit on TapeOut. The circuit's container (an ERC-6551 account) is the
   service's address.
2. **Manifest.** The provider writes `.well-known/tapeapi.json` into the container's site: endpoints, methods, prices,
   the signing key, and the holder's EIP-712 delegation of that key.
3. **Resolve.** A client reads the manifest from the chain through several RPC nodes that must agree, checks its hash,
   and checks the delegation against the circuit's current holder.
4. **Call.** The client sends a request; the service answers with an envelope signed by the delegated key and bound to
   that request. The SDK returns the result only after checking it.

## Choose your path

| I want to | Read |
|---|---|
| Read BNB Chain data now, free and signed, or use a public relay | [Public API](public-api.md) |
| Give Claude, Cursor or another MCP client signed tools | [MCP](mcp.md) |
| Call a TapeAPI service from an app | [Call a service](consume.md) |
| Offer my code or an existing API as a service | [Run a service](provide.md) |
| Send encrypted messages between containers | [Private channels](channels.md) |
| Let an AI agent use services safely | [AI agents](agents.md) |
| Fix an error | [FAQ](faq.md) |

## Status

Released, version 1.3.0. From 1.0 on, TapeAPI follows semantic versioning: code written against the 1.0 docs keeps
working in every 1.x release, and breaking changes come only in 2.0 ([what 1.0 promises](upgrade-1.0.md)). The free
tier runs on TapeOut's deployed contracts. Our own contracts have no third-party audit; the paid-call escrow is not
deployed yet. The TAP numbers are proposed to the TapeKit maintainers, not yet assigned.

## On-chain addresses

BNB Smart Chain, chainId 56.

| Contract | Address | Owner |
|---|---|---|
| DeWebHub | `0xe61A9C7213a6Aa616C246a2B569e555B417b25ee` | TapeOut |
| SiteRegistry | `0xd006ffdd5Ae313B17729621A00999cD3C71CE5e6` | TapeOut |
| Processor factory | `0x68224F668083c29e9800Be2a646d42d18cedF7e2` | TapeOut |
| BEM token | `0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a` | TapeOut |
| ChannelBus | `0x486110c35d9b90a9d6D85c8063A065f9e7b6b707` | TapeAPI: no owner, no state, no upgrade path |
| TapeAPIEscrow, ServiceDirectory | not deployed | TapeAPI |

## Public services

Free TapeAPI services run by the project, each under its own circuit on processor 1013
(`0xe02c26c7432A7121168AA9B610DE24eCf9a1a414`). They are services, not contracts; see [Public API](public-api.md).

| Service | Identity | Container | URL |
|---|---|---|---|
| Public API (8 read methods) | `11.1013.tape` | `0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8` | `https://api.tapeapi.fun` |
| Public relay (`relaySend`, `relayHandshake`, `relayRecv`) | `12.1013.tape` | `0x9cD838625251576c199B2DeF7A17e50266843185` | `https://relay.tapeapi.fun` |

The public API's methods are also MCP tools at `https://api.tapeapi.fun/mcp`, for Claude, Cursor and any MCP client.
Every result is signed and carries a receipt anyone can verify; see [MCP](mcp.md).

## Specifications

The protocol is written down as TAPs, in English and Chinese (English authoritative), under CC0.

| TAP | Title |
|---|---|
| [TAP-20](../../spec/TAP-20.md) | Service identity and manifest |
| [TAP-21](../../spec/TAP-21.md) | Signed response envelope |
| [TAP-22](../../spec/TAP-22.md) | Metered payment |
| [TAP-23](../../spec/TAP-23.md) | Attested cross-chain read |
| [TAP-24](../../spec/TAP-24.md) | Intent RFQ (withdrawn) |
| [TAP-25](../../spec/TAP-25.md) | Circuit-verified methods |
| [TAP-26](../../spec/TAP-26.md) | Private channels |
| [TAP-27](../../spec/TAP-27.md) | Private groups |

Source code, examples and the conformance suite are on [GitHub](https://github.com/BruceLanLan/tapeapi).

## Credits

The idea of a service layer for TapeOut came from [@Theairresearch](https://x.com/Theairresearch/status/2101640697426448632).
A permanent 10% of any revenue TapeAPI earns goes to them.
