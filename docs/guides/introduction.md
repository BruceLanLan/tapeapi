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
| Have one container do a task for another, with a signed mandate (experimental) | [Container agents](container-agents.md) |
| Fix an error | [FAQ](faq.md) |

## Status

Released, version 1.8.1. From 1.0 on, TapeAPI follows semantic versioning: code written against the 1.0 docs keeps
working in every 1.x release, and breaking changes come only in 2.0 ([what 1.0 promises](upgrade-1.0.md)). The free
tier runs on TapeOut's deployed contracts. Our own contracts have no third-party audit; the paid-call escrow is not
deployed yet. TAPI-20 to TAPI-27 are TapeAPI's own specs, not TAPs: TAPs are numbered by the editors of [TapeOutProtocol/TAPs](https://github.com/TapeOutProtocol/TAPs), where the service manifest (TAP-11) and signed responses (TAP-13) were merged as Drafts (a merge is not adoption) and six more drafts for parts of these specs are under review, without a number.

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

The protocol is written down as TapeAPI's own specs (TAPI), in English and Chinese (English authoritative), under CC0.
They are not TAPs. We submitted ten TAP drafts for parts of them to TapeOutProtocol/TAPs (eight on 2026-09-30 and 2026-10-01, two on the container-agent formats on 2026-10-04 and 2026-10-05): the service identity and manifest was merged as [TAP-11](https://github.com/TapeOutProtocol/TAPs/blob/main/TAPs/TAP-11.md) (Draft, [#8](https://github.com/TapeOutProtocol/TAPs/pull/8); a merge into Draft is not adoption), and signed responses were merged as [TAP-13](https://github.com/TapeOutProtocol/TAPs/blob/main/TAPs/TAP-13.md) (Draft, [#10](https://github.com/TapeOutProtocol/TAPs/pull/10)); eight are under review without a number: [#12](https://github.com/TapeOutProtocol/TAPs/pull/12), [#16](https://github.com/TapeOutProtocol/TAPs/pull/16), [#18](https://github.com/TapeOutProtocol/TAPs/pull/18), [#20](https://github.com/TapeOutProtocol/TAPs/pull/20), [#26](https://github.com/TapeOutProtocol/TAPs/pull/26), [#28](https://github.com/TapeOutProtocol/TAPs/pull/28), [#47](https://github.com/TapeOutProtocol/TAPs/pull/47) and [#49](https://github.com/TapeOutProtocol/TAPs/pull/49). TAPI-20 to TAPI-27 remain the basis of the 1.x compatibility promise.

| Spec | Title |
|---|---|
| [TAPI-20](../../spec/TAPI-20.md) | Service identity and manifest |
| [TAPI-21](../../spec/TAPI-21.md) | Signed response envelope |
| [TAPI-22](../../spec/TAPI-22.md) | Metered payment |
| [TAPI-23](../../spec/TAPI-23.md) | Attested cross-chain read |
| [TAPI-24](../../spec/TAPI-24.md) | Intent RFQ (withdrawn) |
| [TAPI-25](../../spec/TAPI-25.md) | Circuit-verified methods |
| [TAPI-26](../../spec/TAPI-26.md) | Private channels |
| [TAPI-27](../../spec/TAPI-27.md) | Private groups |

Source code, examples and the conformance suite are on [GitHub](https://github.com/BruceLanLan/tapeapi).

## Credits

The idea of a service layer for TapeOut came from [@Theairresearch](https://x.com/Theairresearch/status/2101640697426448632).
From 2026-10-05, 10% of TapeAPI's revenue each quarter, after the direct cash costs paid to third parties, goes to them permanently (definition in BUSINESS.md).
