# Upgrading from 0.x to 1.0

1.0 is a promise: code written against the 1.0 documentation keeps working in every 1.x release. To make that
promise, the interfaces were reviewed once more, and the names, shapes and error codes that would have been hard to
live with were changed before the freeze. This page lists every change that can break 0.x code, what to write
instead, and what 1.0 does and does not promise.

## What 1.0 promises

Every export of `@tapeapi/sdk` and `@tapeapi/server`, the command-line tools `tapeapi-mcp` and `tapeapi-verify`, and
the methods and result shapes of the public services (api.tapeapi.fun, relay.tapeapi.fun) are in one of three levels:

| Level | Meaning | How to tell |
|---|---|---|
| **Stable** | No breaking change within 1.x. Additions (a new optional option, a new field, a new error code) may come in any minor release. | everything not marked otherwise |
| **Experimental** | May be renamed, reshaped or removed in a 1.x minor release; each change is in the changelog. | `@experimental` in the type declarations |
| **Internal** | Not part of the API; may change in any release. | `@internal`, or not exported at all |

**Experimental in 1.0:** everything that pays. TAPI-22 payment channels and the escrow contract are not deployed or
audited, and neither is the ServiceDirectory. That covers `api.payer()`, `api.acceptPrice()` / `api.acceptedPrice()`,
the `payer` and `maxPrice` call options, the channel builders `api.tx.approve / fund / requestWithdraw / cancelWithdraw /
withdraw / authorizeSession / settle / setContribution / register`, `api.chain.escrow.*`, `api.chain.resolve()` and
`api.chain.serviceOf()` (and resolving a directory label; `labelToBytes32`, and `LABEL_RE` / `bytes32ToLabel` of `abi`), the `directory` and `escrow` options, `contribution`,
`MAX_CONTRIBUTION_BPS`, `RECOMMENDED_CONTRIBUTION_BPS` and `MAINNET.bem` (the payment token), the voucher helpers of `sig`, WebMCP's `paid` option, and on the server the voucher store, the settlement helpers and the
payment options of `createProvider`. Reading prices from a manifest (`priceBEM`, `parseUnits`, `formatUnits`) is
Stable, and so are the codes `PAYMENT_REQUIRED`, `BAD_VOUCHER` and `PRICE_CHANGED`: a free service's client can meet
them too.

Also Experimental: the whole `@tapeapi/sdk/bus-privacy` subpath (the root `busPrivacy`): `busPrivacyReader`, its modes,
every tuning option and default (`cover`, `contract`, the pool and budget constants), `scanCoverPool`, `plausibleRoom`
and the shape of `stats().privacy`. The defaults come from measurements on mainnet in September 2026 and may change.

**Internal:** `abi.FUNCTIONS` and `abi.SERVICE_TUPLE` (the ABI table follows the contracts, including the experimental
ones). In `ai`, the helpers the reference sidecar and the website use (`FORWARD_HEADERS`, `SESSION_HEADERS`,
`MODEL_ID_MAX`, `forwardsHeader`, `isSessionHeader`, `isAnswerId`, `apiPath`, `completeOf`, `createSseScanner`,
`encodeReceipt`, `receiptComment`, `pricingOf`, `modelEntryOf`, `formatOfMethod`, `envelopeProblems`,
`priceProblems`). Stable in `ai`: `createVerifyingFetch`, `verifyUsageReceipt`, `validateAIField`,
`decodeReceiptHeader`, `readSseReceipt`, `scanSse`, `usageOf`, `formatFor`, `sha256Hex`, `FORMATS`, `MANIFEST_FIELD`,
`RECEIPT_HEADER`, `RECEIPT_METHOD`, `SIDECAR_ERROR_HEADER`, `VERIFY_ERROR_HEADER`.

## Breaking changes

Search your code for the name in the first column.

| 0.x | 1.0 | Why |
|---|---|---|
| A configuration or argument mistake reported as `RPC_UNAVAILABLE`, `MANIFEST_INVALID`, `BAD_VOUCHER`, `ABI_INVALID`, `BAD_KEY`, `CHANNEL_INVALID`, `BAD_REQUEST`, `QUORUM_FAILED`, `METHOD_NOT_FOUND` or `GROUP_DELIVERY`; on `@tapeapi/server`, a provider without `rpcUrls` (was `INTERNAL`); in WebMCP, `refresh()` with nothing exposed and a tool called after dispose (was `BAD_REQUEST`) | `INVALID_ARGUMENT` | One code for "your own options or arguments are wrong", raised before anything is sent and never worth retrying. A retry loop on `RPC_UNAVAILABLE` no longer spins on a missing `rpcUrls`. See the table below. |
| `e.tooLarge`, `e.rpcCode`, `e.rpcRevert`, `e.rpcData`, `e.agreed`, `e.disagreed`, `e.failed`, `e.groups`, `e.quorum`, `e.reason` | `e.data.tooLarge`, `e.data.rpcCode`, ... | `TapeAPIError` keeps a fixed set of top-level fields (`name`, `code`, `message`, `data`, `signed`, `httpStatus`, `cause`, and `ts`, `block`, `id`, `sig`, `error` on a signed provider error). The old names still read, as deprecated aliases, until 2.0. |
| `channel.toHex`, `channel.fromHex`, `channel.toBase64`, `channel.fromBase64` | `abi.toHex` (with `0x`), `abi.bytesToHex` (without), `abi.hexToBytes`; base64 from your platform | `channel.toHex` returned hex without `0x` while `abi.toHex` returns it with: the same name with two meanings. |
| `channel._keySchedule`, `channel._busMerge`, `channel._busKindOf` | removed | Test hooks, not API. |
| `channel.relayTransport({ api, svc, ... })` | `channel.relayTransport({ api, service, ... })` | One name for a resolved service everywhere. `svc` is refused with a pointer here. |
| `deliverGroupUpdate({ relay, bus })`, `checkGroupInvites({ relay })` | `deliverGroupUpdate({ relayClients: [...], busClients: [...] })`, `checkGroupInvites({ relayClients: [...] })` | Always lists. These are clients to send and read through: `relayClients` holds `{ api, service, payer? }` (a TapeAPI client and the resolved relay service), `busClients` holds `{ address, sendTx }`. `relays` is something else: the list of relay references `{ url, container }` that `createGroup`, `resumeGroup` and `channel.createInvite` put into a roster or an invite, a protocol field (TAPI-26, TAPI-27) that keeps its name. `relay`, `bus`, `relays` and `buses` are refused here with a pointer to this page. |
| a relay client (`relayClients`) `{ api, svc, payer }` | `{ api, service, payer }` | As above. |
| `G.createGroup({ now })`, `G.joinGroup({ now })` (a function returning milliseconds) | `clock`, a function returning Unix **seconds** (fractional allowed); `resumeGroup` takes it too | Every `now` in the SDK is a Unix-seconds number (channel handshakes, `validateManifest`, `verifyUsageReceipt`); a group's long-lived clock is `clock`, in the same unit. `now` on a group is refused, and so is a `clock` that returns milliseconds (above 1e11, e.g. `Date.now`). |
| WebMCP `handle.svc` | `handle.service` | As above. |
| `sig.keccak256`, `sig.toHex`, `sig.bytesToHex`, `sig.hexToBytes` | `abi.keccak256`, `abi.toHex`, ... | One home for byte helpers. |
| `readJsonBounded`, `describeUrl`, `isNodeLimit` from `@tapeapi/sdk/rpc` | removed | Internal helpers. `@tapeapi/sdk/rpc` exports `createRpc` and `RPC_BODY_LIMIT`. |
| `ai.amountOf`, `ai.pricesOf`, `ai.sseDigestOfPayloads`, `ai.sentinelOf`, `ai.rootOf`, `ai.saltRequestBody`, `ai.SALT_LENGTH`, `ai.CURRENCIES`, `ai.PRICE_UNIT`, `ai.MODELS_MAX`, `ai.ENDPOINTS_MAX`, `ai.ALIASES_MAX`, `ai.PRICES_MAX`, `ai.AMOUNT_DECIMALS`, `ai.EVENT_PARSE_LIMIT`, `ai.FORWARD_PREFIXES`, `ai.SSE_RECEIPT_PREFIX` | removed | Used only inside the SDK and its tests. `verifyUsageReceipt` does the price arithmetic and the hashing; the limits are in TAPI-20 §3.9. |
| `group.senderKey`, `group.buildEpoch` | removed | The key derivation and epoch builder behind the group handles; the TAPI-27 vectors document them. |
| the `openai-proxy` subpath of `@tapeapi/server`, `createOpenAIProxy` | `@tapeapi/server/ai-proxy`, `createAIProxy` | An alias whose name was wrong: the sidecar speaks Anthropic too. |
| `createMcpEndpoint(...).handle(request)` | `.handleRequest(request)` | Like `createProvider`, `createAIProxy` and `createMcpProxy`. |
| `createMcpEndpoint({ identity: { name } })`, `createMcpProxy({ identity: { name } })` | `{ name }` | `identity` means a key pair elsewhere in the SDK. `identity` is refused. |
| `UPSTREAM_TIMEOUT_MS` from `ai-proxy` / `mcp-proxy` | `AI_UPSTREAM_TIMEOUT_MS` (600 s) / `MCP_UPSTREAM_TIMEOUT_MS` (20 s) | One name had two values. |
| `ai.createVerifyingFetch` passing a metered request to another host (`localhost` for `127.0.0.1`) | strict: `INVALID_ARGUMENT` before sending, naming the expected endpoint; not strict: `onReport` with `mismatch: true` | It used to go through unverified and unreported. |
| `ai.createVerifyingFetch` with an official SDK's stream | verified; strict makes the iterator throw `RECEIPT_INVALID` | The official SDKs stop reading at the final event, so the old end-of-stream check never ran. A stream now ends at its final event, at `[DONE]` or when the connection closes, whichever comes first, and in strict mode the end is released only once a receipt that came before it verifies. |
| `ai.createVerifyingFetch`, strict, a whole answer whose receipt fails: thrown from `fetch` (`RECEIPT_INVALID`) | an HTTP 502 in the API's error shape, code `RECEIPT_INVALID`, headers `x-should-retry: false` and `x-tapeapi-verify-error: RECEIPT_INVALID`; `onReport` as before | The official SDKs wrapped the thrown error and retried it twice by default: one bad receipt meant three requests, each possibly paid. They obey `x-should-retry` and throw an `APIError` after one. Code that calls the fetch itself checks `res.ok`. Retrying a paid call after other 5xx errors is your choice. |
| the `channelRecordFloor` store keyed by container | keyed `<chainId>:<container, lowercase>` | Other chains' clients now share the store you pass. A 0.x entry is read once and moved; nothing to do. |
| `Group = Record<string, any>` (TypeScript) | `GroupHandle`, `OwnerGroup`, `GroupSnapshot`, `Roster` | Typed handles. |
| `createProvider` relaxed its payment checks for `allowHttp: true` or a manifest with `dev: true` | only `createProvider({ dev: true })` relaxes them; `allowHttp` only allows http endpoints; the manifest's own `dev` field switches nothing (also in `createMcpProxy`) | A published manifest is data, not configuration, and allowing http is not permission to skip the escrow. A dev setup passes `dev: true`. |
| `createTapeAPI({ timeoutMs })`, `chains: { [id]: { timeoutMs } }`, `createProvider({ timeoutMs })` | `rpcTimeoutMs` | It is the timeout of one RPC request; `api.call(..., { timeoutMs })` is the whole call and keeps its name. The old name is refused. |
| `api.chain.tokenOf()` returning `tokenId` as a `bigint` | a decimal string | Every `tokenId` and `processor` the SDK returns is a decimal string; inputs still take any number, bigint or string. |
| an option object with a misspelt or unknown key (TypeScript) | a compile error | Option interfaces (`CreateProviderOptions`, `ChannelSelf`, `ChannelPeer`, WebMCP's `paid`) no longer carry an index signature. Data shapes (`Manifest`, `Invite`, channel records) still accept extra fields. |

### Which mistakes are now `INVALID_ARGUMENT`

| Where | 0.x code |
|---|---|
| `createRpc`: no URLs, a bad `quorum`, too few nodes or operators, no `fetch`; `rpc.single(url)` with a foreign URL | `RPC_UNAVAILABLE` |
| a chain read on a client without `rpcUrls` | `RPC_UNAVAILABLE` |
| `resolve()` of an unsupported target, a bad `chainId`, a directory label without `directory`; `{ dev }` without `dev: true`; `forChain()` of an unknown chain; `chainOfContainer('nope')`; `refresh()` of a service not from `resolve()`; `registryKey(42)` | `MANIFEST_INVALID` |
| `chain.channelKeys` / `chain.tapeSendKey` given something that is not a container | `CHANNEL_INVALID` |
| `payer()` options, a price that is not positive | `BAD_VOUCHER` |
| `tx.*` arguments (an address, an amount, `bps`); a free service passed to a payment builder; no `escrow` / `directory` configured; `publishManifest` / `publishChannelKeys` with a bad container | `ABI_INVALID`, `MANIFEST_INVALID`, `CHANNEL_INVALID` |
| `callQuorum` with no services, a bad `quorum` or `onDissent`, a service not from `resolve()`, a malformed `compare` | `QUORUM_FAILED`, `BAD_REQUEST` |
| `deliverGroupUpdate` / `checkGroupInvites` carriers, `invite`, `self`, `cursors`, a foreign update | `GROUP_DELIVERY` |
| `createProvider`: no `signerKey`, `methods` not an object or missing a handler, a bad `escrow`, `rateLimit`, `minVoucherLifeS` | `BAD_KEY`, `METHOD_NOT_FOUND`, `MANIFEST_INVALID` |
| `createAIProxy` / `createMcpProxy` options | `BAD_REQUEST`, `BAD_KEY`, `MANIFEST_INVALID` |
| `createVerifyingFetch` without a service; `exposeTapeAPI` / `manifestToTools` `paid` options; `createMcpServer` without `info` | `MANIFEST_INVALID`, `BAD_REQUEST` |

The public service keeps its shapes: `tapeName` on api.tapeapi.fun still answers `processor` as a number (changing its
declared `returns` would change the on-chain manifest and make every `tapeapi-mcp` pin of it refuse the service).

The codec layers are unchanged: `abi` reports `ABI_INVALID` and `canon` reports `CANON_INVALID` whether the bytes came
from you or from the network. Protocol refusals of `callQuorum` (fewer than two providers, two services that share a
holder or an origin, an attested read without a block) stay `QUORUM_FAILED`.

Three modules keep their own code for a caller's mistake throughout 1.x, so match these as well: the channel module
(`channel.*`, TAPI-26) reports `CHANNEL_INVALID`, the group module (`group.*`, TAPI-27) reports `GROUP_INVALID`, and the
checks `api.call()` makes on `params` and `id` before sending report `BAD_REQUEST`, the code a provider would answer
for the same request. None of them is worth retrying.

## Error codes

The full list. Provider codes travel in signed envelopes and never change meaning ([TAPI-21](../../spec/TAPI-21.md) §3.2);
client codes are raised by the SDK (§3.4).

| Code | Kind | Meaning | Retry? |
|---|---|---|---|
| `PAYMENT_REQUIRED` | provider | The method is priced and no voucher came, or payments do not run on that chain | no |
| `BAD_VOUCHER` | provider | The voucher was refused (`data.lastCumulative`, `data.voucher`) | the SDK resyncs once |
| `METHOD_NOT_FOUND` | provider | No such method | no |
| `BAD_REQUEST` | provider | The request itself (`id`, `params`) is malformed; signed when the provider says so | no |
| `INTERNAL` | provider | The provider failed; may carry `data.revert` | yes |
| `TOOLS_CHANGED` | provider | An MCP-bound service's upstream tools no longer match `toolsSha256` | no |
| `RPC_DISAGREE` | client | Nodes gave different answers | yes |
| `BAD_SIGNATURE` | client | An envelope-binding check failed | the SDK re-reads the manifest |
| `MANIFEST_INVALID` | client | The manifest read from the chain or the endpoint is not valid | no |
| `DELEGATION_INVALID` | client | The delegation is missing, expired or not the holder's | no |
| `PROVIDER_UNAVAILABLE` | client | Transport failure; `data.timedOut` / `data.aborted` for your own timeout or abort | yes |
| `RATE_LIMITED` | client | HTTP 429 (`data.retryAfterS`) | after the wait |
| `PRICE_CHANGED` | client | The price rose above what you accepted | after consent |
| `QUORUM_FAILED` | client | Providers disagree, or too few answered (`data.agreed`, `data.failed`, ...) | depends |
| `ATTEST_DISAGREE` | client | An attested read disagrees | no |
| `NOT_FOUND` | client | No service there: an unregistered label, a processor number past the last, or no channel record (a missing manifest file is `MANIFEST_INVALID`). Under `conform: 'tap10'`: `no-such-cpu`, `no-such-token` or `not-tapeout` in `data.status` | no |
| `RPC_UNAVAILABLE` | client | Too few nodes answered | yes |
| `RPC_STALE` | client | Since 1.2, with the experimental `pin` option: the block the nodes confirm is older than `maxPinAgeS`, or ahead of this client's clock (`data.ageS`). Since 1.4, with `pin: 'tap10'` or `conform: 'tap10'`: the pinned block is more blocks behind the highest head than TAP-10 allows (`data.status` `stale-block`, `data.lag`, `data.maxLag`) | yes |
| `CONTRACT_UNKNOWN` | client | Since 1.2, with the experimental `sentinel: 'strict'`: a TapeOut identity contract runs an implementation this SDK does not know, which means it was upgraded (`data.role`, `data.implementation`). Since 1.4, under `conform: 'tap10'`, always for the SiteRegistry and the DomainBinding (`data.status` `store-changed`) | no: update the SDK or check the upgrade |
| `SITE_STATUS` | client | Since 1.4, only under the experimental `conform: 'tap10'`: the name exists but TAP-10 says not to use its site: `data.status` is `unpaid` (not activated) or `not-opened` (the container was never opened) | no: only the holder can change it |
| `PROOF_INVALID` | client | Since 1.3, with the experimental `proofs` (needs `pin`): a verified Merkle proof of `fileInfo`, `cpuAt`, `isCPU` or `ownerOf` proves a value other than the one the nodes answered (with `proofs: true` as well as `'strict'`); or, with `'strict'` only, every proof the nodes served failed to verify against the stateRoot of the block the nodes confirmed (`data.read`, `data.node`, `data.block`, `data.stateRoot`) | no |
| `PROOF_UNAVAILABLE` | client | Since 1.3, with the experimental `proofs: 'strict'`: no node served `eth_getProof` for the pinned block, nodes of `quorum` operators did not agree on a stateRoot, or the contract runs an implementation whose storage layout the SDK does not know (`data.read`, `data.reason`). With `proofs: true` the same is only a warning and the quorum's answer is kept (detection only) | yes, or add a node that serves proofs |
| `RPC_ERROR` | client | Every node returned the same JSON-RPC error (`data.rpcCode`, `data.rpcRevert`) | a revert: no |
| `CANON_INVALID` | client | JSON with no canonical form, duplicate or forbidden keys | no |
| `ABI_INVALID` | client | ABI data that does not decode | no |
| `BAD_KEY` | client | A key or key address that cannot be used | no |
| `CHANNEL_INVALID` | client | TAPI-26 data invalid or not authorised by the current holder | no |
| `GROUP_INVALID`, `GROUP_EQUIVOCATION` | client | TAPI-27 data invalid; the owner signed two epochs with one number | no |
| `GROUP_DELIVERY` | client | Some group post failed after every post was tried (`data` is the delivery result) | depends |
| `BAD_RESPONSE` | client | A relay or your wallet's `sendTx` answered something unusable | no |
| `BUS_PRIVACY`, `BUS_BUDGET` | client | Too few cover rooms; a contract-wide read over its budget | no |
| `TAPESEND_INVALID` | client | A TAP-10 payload is invalid | no |
| `COMPARE_PATH_INVALID` | client | One provider's result has no number at a `compare` path | no |
| `RECEIPT_INVALID` | client | An AI usage receipt is missing or fails a check | no |
| `BUDGET_EXCEEDED`, `USER_DECLINED` | client | WebMCP spending budget; the user said no | no |
| `UNSUPPORTED_PAYMENT_TOKEN` | client | Experimental payments only: the escrow's token cannot be used for this payment. `data.reason`: `token-unreadable` (the escrow answers no `token()`), `decimals-unreadable` or `decimals-out-of-range` (no valid `decimals()`, or outside 8 to 18), `not-bem` (manifest prices are in BEM, and this escrow holds another token), `token-mismatch` (not the token you named); `data.escrow`, `data.token` | no |
| `INVALID_ARGUMENT` | client | Your own options or arguments are wrong | **never** |
| `METHOD_NOT_ALLOWED` | provider route, unsigned | HTTP 405: a request other than POST to `/tapeapi/v1/<method>`. The SDK always POSTs; a client that meets it treats it as a transport failure (`PROVIDER_UNAVAILABLE`) | no |
| `NAME_TAKEN` | WebMCP | In `handle.skipped[].code`: `registerTool` failed, usually because another script on the page already registered that tool name (`reason` says why). Not thrown | after the other tool is gone (`refresh()`) |

An MCP server in front of a service (`createMcpProxy`) reports its own refusals as JSON-RPC errors whose
`error.data.code` is `TOOLS_CHANGED`, `INVISIBLE_CHARACTERS` or `UPSTREAM_UNAVAILABLE`.

## The TAP-10 conformance mode (1.4, experimental)

`createTapeAPI({ conform: 'tap10' })` resolves services the way the official TAP-10 v1.1 (§3–§7) and TAP-11 §2.2 describe.
It is off by default: without it, `resolve` and the `chain.*` reads behave exactly as before (a test pins every request
and result of the default mode). `api.siteStatus()` is the TAP-10 path in any mode, so it changed in 1.5 on a default
client too (see *What changed in siteStatus* below). It covers the resolution path (1.4, completed in 1.5) and, since 1.5, the messaging path (see
the end of this section). It is `@experimental` and follows TAP-10 while TAP-10 is a draft: results record
`version: '1.1'`.

```js
const api = createTapeAPI({ rpcUrls: rpcUrlsFor(56), conform: 'tap10' })
const svc = await api.resolve('#11@1013')          // any TAP-10 input form
const site = await api.siteStatus('11.1013.tape')   // any mode: identity and site status only

// 1.5: a container address or processor contract#ID, looked up on every chain (reads Base and X Layer too)
const everywhere = createTapeAPI({ rpcUrls: rpcUrlsFor(56), conform: 'tap10', allChains: true })
await everywhere.siteStatus('0x4591b393399452eA24ECB10424CdBA194F1c4E64')   // Base, 1.3.1.tape
```

It implies `pin: 'tap10'`; passing another `pin` with it is `INVALID_ARGUMENT`. Names on Base and X Layer, and
`api.forChain()`, run in the same mode. `pin: 'tap10'` can also be used alone, for the TAP-10 pinned block without the
rest.

**What it does differently**

- **One pinned block per resolution** (TAP-10 §5.3): each operator counts once at its lowest head; the block is the
  second highest of those minus 2, read by its hash. It is refused as `stale-block` when it is more than 400 (BNB Smart
  Chain), 150 (Base) or 300 (X Layer) blocks behind the highest head. Only block numbers are compared, never your clock.
- **Chain check** (TAP-10 §5.4): once per client, every node is asked `eth_chainId` before any state is read. `resolve`
  makes it under strict agreement (next item), the same check the messaging path makes, so one check per client serves
  both; `siteStatus` makes it under the usual agreement (nodes of `quorum` operators, every answer equal). In both, a
  node on another chain is a disagreement (refused) and nodes all on another chain are `wrong-chain`. Only a result or a
  revert counts as a node's answer; any other JSON-RPC error is a node failure.
- **Strict agreement for what authorises a signer** (TAP-11 §2.2): `ownerOf`, and for a holder that is a contract the
  EIP-1271 reads (`eth_getCode` and `isValidSignature`, for the delegation and for `contentSig`), are adopted only when
  every configured node answers the same and the answers come from at least max(2, min(3, operators)) operators (TAP-10
  §5.2), as is `resolve`'s chain check. A node that does not answer, or has not reached the pinned block yet (TAP-10 §1:
  "no such block" is no answer), counts against that number. With the default nodes:
  - BNB Smart Chain, 3 operators (NodeReal, Alchemy, 48 Club): strict needs all 3, so one node down or behind the
    pinned block makes `resolve` `unavailable` (`RPC_UNAVAILABLE`) where the default mode goes on;
  - Base, 4 operators (Coinbase, Allnodes, dRPC, Tenderly): strict needs 3, so one node down still resolves, two do not;
  - X Layer, 2 operators (OKX, dRPC): strict needs 2, the same as the quorum: nothing changes.

  Every other read of a resolution keeps the usual agreement, and so does `api.siteStatus()`, which authorises nothing.
  A node that answers differently is refused in both modes, as always (never a majority). The error says when a read
  was strict and how many operators it needed.
- **Input**: an on-chain name (`4246.0.tape`), a short name (`4246.0`), a display label (`#4246@0`, `#1@3.1`), a
  `tape://` or `web+tape://` URL, a container address, or a processor contract#ID (`0x50A9…9DD9#4246`). Anything else,
  including a directory label, is an input error. The last two carry no chain: see *Input without chain information*
  below.
- **Identity**: `cpuCount` and `cpuAt`, the container from the container opener (and checked against a local ERC-6551
  derivation by the `sentinel`), `ownerOf`, `isOpened`. For a container address (`token()`, `isCPU`, then the opener must
  derive that very address) and a processor contract#ID, the processor number is found too (since 1.5), so they get
  their on-chain name and a full activation check (see *Finding the processor number* below).
- **Site status**, in TAP-10 §6.2's order: `store-changed` (the SiteRegistry or the DomainBinding runs an implementation
  this SDK does not list: refused whatever `sentinel` says), then `no-such-cpu` / `no-such-token` / `not-tapeout`, then
  `not-opened`, then `unpaid` (neither `isLive(on-chain name, container)` nor `isContainerLive(container)` is true; on the
  previous DomainBinding, which lacks `isContainerLive`, its revert counts as false, as TAP-10 §6.3 says. A revert of
  `isLive` is counted as false too, which TAP-10 does not say: no accepted implementation reverts on it, so only an
  unknown implementation could, and that one is already refused as `store-changed`).
- **Manifest**: `chunkCount` 0 is `no-manifest`; the file must be valid UTF-8 without a byte order mark; its `circuits`,
  `tokenId` and `container` are compared with what was resolved, never used.
- **Caching**: only the processor table is kept between resolutions. Before `api.call()`, a service older than 60 seconds
  is resolved again; if that says `unpaid` (or any other verdict), the call stops instead of using the kept manifest.

**What the result looks like.** A resolved service carries `svc.conform` and a TAP-10 `svc.pinned`:

```js
svc.conform  // { version: '1.1', status: 'resolved', site: 'ok', chainId: 56, name: '11.1013.tape', processor: '1013',
             //   tokenId: '11', circuits, container, holder, opened: true,
             //   activation: { live: true, isLive: false, isContainerLive: true },
             //   implementations: [{ role: 'siteRegistry', ..., accepted: true }, { role: 'binding', ..., accepted: true }],
             //   pinned: { number, hash, lag, maxLag } }
svc.pinned   // { number, hash, timestamp, tag: 'tap10', by: 'hash', mode: 'tap10', lag: 2, maxLag: 400 }
```

`api.siteStatus(target)` returns the same object with `status` set to `ok`, `unpaid`, `not-opened`, `store-changed`,
`no-such-cpu`, `no-such-token` or `not-tapeout`; it reads no manifest, works in any mode, and never throws for a site
status (only for an input error, `unsupported`, `ambiguous`, `wrong-chain` and reads that cannot be made). Input
searched on every chain adds `chains` (to `svc.conform` too): what each chain said, this client's chain first, for
example `[{ chainId: 56, status: 'not-tapeout' }, { chainId: 196, status: 'not-tapeout' }, { chainId: 8453, status: 'ok' }]`.

**Input without chain information (1.5, `allChains`).** A container address or a processor contract#ID typed as a
string names no chain. TAP-10 §4.1 resolves it on every active chain, each at its own pinned block, and that means
requests to the nodes of Base and X Layer (yours from `chains[id].rpcUrls`, or the SDK's defaults for that chain). A
client given only your own BNB Smart Chain node should not start talking to other chains' public nodes on its own, so
this is a separate switch, `allChains: true`, passed on by `api.forChain()`:

| What the chains say | Result |
|---|---|
| Two or more chains resolve it (the Base and X Layer factories share an address, so processor 1 there is the same contract) | `INVALID_ARGUMENT`, `data.status` `ambiguous`, `data.candidates` (one per chain, with its on-chain name), whatever the third chain says: pass the on-chain name |
| One chain resolves it | that chain; except a processor contract#ID while another chain could not be read (`unavailable`, `stale-block`, `wrong-chain`) or is `store-changed`: that chain's status, with `data.chainId` and `data.candidates`. A container address can be a container of one chain only, so a container that resolves is that chain's |
| No chain resolves it | the status of a chain that could not be read, never `not-tapeout`; otherwise `no-such-token` (a chain has the processor but not the #ID) or `not-tapeout` |

Without `allChains` nothing is sent to another chain: a container address is resolved on this client's chain when it
is a container of this chain (its ERC-6551 address commits to one chain, so that is a full answer) and is
`unsupported` otherwise. Under `conform: 'tap10'` a processor contract#ID string is `unsupported` before any request,
because TAP-10 resolves it only when exactly one chain does; `siteStatus` on a default client resolves it on this
client's chain, as 1.4 did. Only `true` turns `allChains` on; any other value is ignored (1.4 ignored the option).
`{ circuits, tokenId, chainId? }` names its chain (this client's when `chainId` is left out) and `{ chainId, container }`
names its own: neither is searched. `{ container }` without `chainId` is an input error, as before. `allChains` applies
to the TAP-10 path only (`resolve` under `conform: 'tap10'`, and `siteStatus` in any mode); the default `resolve` never
reads it.

With the `sentinel` (TapeAPI's own check, not TAP-10's), the every-chain search behaves as follows. In the default
`'warn'` mode, the warnings identity would give on a chain that is not chosen are not reported; on `ambiguous` they are
in `data.candidates[i].warnings`. Under `sentinel: 'strict'` a chain whose container opener derives another address than
ERC-6551 fails closed: it shows as `container-mismatch` in `chains[].status`, TapeAPI's own name, not one of TAP-10
§4.1's, and counts as a chain that could not be decided.

**What changed in siteStatus (1.5, any mode).** It finds the processor number of a container address or processor
contract#ID (the result's `name` and `processor` are no longer null, and `isLive` is asked; a cold client reads
`cpuCount` and `cpuAt` for it, see below); `{ chainId, container }` for an address with no code there is `not-tapeout`
(1.4: `unsupported`); with `allChains` it searches every chain.

**Finding the processor number (1.5).** The factory has no reverse table, so TAP-10 §4.3 scans `cpuAt(i)`; cold, that
is over a thousand requests per node on BNB Smart Chain, which public nodes rate-limit. The SDK ships a snapshot of every
chain's processor table (`sdk/src/processors-snapshot.js`, read-only through the default nodes before a release; on
2026-10-01 (UTC): 1,174 processors on BNB Smart Chain, 263 on X Layer, 101 on Base, each with the block, count and node
operators it was read with; the snapshot's time is UTC, which was already 2026-10-02 in UTC+8). A hit costs one `cpuAt` at the pinned block, which must give back the same address before it is used. A
processor created after the snapshot is found by a scan of the newer numbers only, once the chain agrees with the
snapshot (`cpuCount` is not lower and its last entry reads back the same); otherwise, or for a factory other than the
chain's own, every number is scanned. A scan reads pages of 8, at most 256 numbers per resolution, and goes on where it
stopped at the next one; until it finds the number the answer is `unavailable` (`data.scan`). Everything read is kept
for the life of the client (numbers are append-only), as is every number a name resolved. The snapshot is about 75 KB
of source, loaded with the SDK in every mode (the SDK is plain browser modules, without dynamic imports), even where only
names are resolved.

**Errors.** Every error of the mode carries the TAP-10 / TAP-11 name in `error.data.status`; branch on it. The codes are
the existing ones, plus one:

| `data.status` | `code` |
|---|---|
| `input-error`, `unsupported` (see below), `ambiguous` (1.5), `wrong-chain` | `INVALID_ARGUMENT` |
| `no-such-cpu`, `no-such-token`, `not-tapeout` | `NOT_FOUND` |
| `unavailable`, `stale-block` | `RPC_UNAVAILABLE` / `RPC_DISAGREE`, `RPC_STALE` |
| `store-changed`, and `hub-changed`\* | `CONTRACT_UNKNOWN` |
| `not-opened`, `unpaid` | **`SITE_STATUS`** (new) |
| `no-manifest`, `incomplete`, `no-hash`, `manifest-invalid`, and `container-mismatch`\* | `MANIFEST_INVALID` |
| `delegation-invalid` | `DELEGATION_INVALID` |

\* Only with `sentinel: 'strict'`, only from `resolve`, never from `siteStatus`: they are TapeAPI's own checks, which
TAP-10 does not make when resolving a site. `hub-changed` is the condition of the same name in TAP-10 §13.8 (the hub runs
an implementation not listed); `container-mismatch` means the container opener derived another address than ERC-6551
computed here.

`SITE_STATUS` means the name exists and its manifest may well be valid, but TAP-10 says not to use the site. Retrying
does not help; only the circuit's holder can change it (activate with `DomainBinding.bind`, or open the container).

**Our own services.** `11.1013.tape` (api.tapeapi.fun) and `12.1013.tape` (relay.tapeapi.fun) were `unpaid` under
`conform: 'tap10'` until their holder activated them on 2026-10-01 (`DomainBinding.bind`, 120 months, paid until
2036-08-09); both now resolve (`status: 'resolved'`). A name that is not activated, or whose payment has run out, is
`SITE_STATUS` with `data.status` `unpaid` in this mode; the default mode resolves it as before.

**Activation binds compliant clients only.** TAP-10 §6.3 says it plainly: the fee is enforced by compliant clients
showing only activated sites, not by any technical block. The data stays public and readable; the default mode does not
check activation, and neither do the messaging reads in any mode (`chain.channelKeys`, `chain.tapeSendKey`): TAP-10
§12.2 says activation must not stop messaging.

**Limits you should know about.**

- *Container addresses and processor contract#IDs without `allChains`* (`unsupported`). An address that is no
  container here, or whose `token()` names another chain, may be a container of another chain, and a processor
  contract#ID string may resolve on more than one chain: without `allChains` both are `INVALID_ARGUMENT` with
  `data.status` `unsupported`, never `not-tapeout` (TAP-10 §4.1 allows that verdict only after every active chain was
  read). Pass `allChains: true`, an object form with its `chainId`, or the on-chain name. (In 1.4, a container or
  processor contract#ID without a known processor number was `unsupported` too, unless `isContainerLive` was true; 1.5
  finds the number, so that case is gone, and under `conform: 'tap10'` a processor contract#ID string is now refused
  without `allChains` even where 1.4 resolved it on this client's chain.) The cost is real: TAP-10's own first Test Case,
  `0x50A994E71615474b55559fF4F500928fbc339DD9#4246`, is `unsupported` in the conformance mode until you pass
  `allChains: true`, and with it a BNB Smart Chain processor contract#ID depends on Base and X Layer being readable: X
  Layer's defaults have two operators, so one of them down makes such input `unavailable`. A name (`4246.0.tape`) has
  neither cost.
- *A new processor on a public node.* A processor created after the snapshot costs a scan of the numbers created since
  (a handful of requests per release cycle); against a factory the snapshot does not cover, the first lookups can take
  several resolutions, each `unavailable` until the scan reaches it. Each release ships a fresh snapshot, so keeping the
  SDK current keeps the scan short.
- *Chains with two operators.* The pinned block is the second highest operator head minus 2. Where a chain's nodes come
  from two operators only (X Layer's defaults, OKX and dRPC), one operator reporting a low head drags the pin back by up
  to the chain's max pin lag (300 blocks on X Layer, about five minutes) and the reads are made there: honest nodes serve
  that older state, and it is accepted, where the default mode's `latest` reads would only disagree. With three or more
  operators (BNB Smart Chain, Base) one low head does not move the pin. It still counts for the strict reads: with
  BNB Smart Chain's three default operators, a node whose head is below the pinned block cannot answer `ownerOf` there,
  so `resolve` is `unavailable` until that node catches up (Base's four operators leave one spare). Add a third
  operator's node to `chains[196].rpcUrls` if the pin on X Layer matters to you.

  What that window means for a manifest: on a chain whose nodes come from two operators (X Layer, with its default
  nodes), one operator that is down or dishonest can hold the pinned block back as far as the limits allow: a block up
  to `maxPinAgeS` old under `pin: true` (600 s on X Layer, about 600 blocks), and up to `tap10MaxPinLag` blocks behind
  the head under `pin: 'tap10'` or `conform: 'tap10'` (300 on X Layer). Inside that window the client reads the manifest
  as it stood then, before a signer change, a price rise or a shortened delegation. `delegationFloor` refuses only a
  delegation whose `expires` is lower than one already seen, so it does not refuse the older, longer one. This is lag
  the pin tolerates by design (for the TAP-10 pin, as TAP-10 §5.3 states), not a way around a check; a third operator's
  node is what closes it.

### The messaging path (1.5)

Under `conform: 'tap10'`, `api.chain.tapeSendKey(target)` and `api.chain.channelKeys(container)` (and so `groupVerifier`)
read the TAP-10 way too. The default mode is unchanged.

- **Reads.** Each lookup pins a fresh block (TAP-10 §5.3) and makes every read under **strict agreement** (§5.2): every
  configured node is asked and every answer must be equal, from at least max(2, min(3, operators)) operators. On BNB
  Smart Chain's three default operators, one node down or behind the pinned block therefore stops the messaging path
  (`RPC_UNAVAILABLE`, `unavailable`) where the default mode and `siteStatus` go on (`resolve` in this mode stops too);
  Base's four leave one spare, and on X Layer's two strict needs no more than the quorum. That is what TAP-10 asks of
  messaging, where a few colluding nodes could otherwise misdirect encryption. Before the first lookup the client checks
  `eth_chainId` under strict agreement too (§5.4); `resolve`'s check is the same strict one and counts for it,
  `siteStatus`'s does not. (The pin's block requests go out alongside that check; no state is read until both
  succeeded.) The container comes from the container opener (§4.3: `token()`, `isCPU`, `opener.accountOf` equal to the
  address given), the holder from `ownerOf` at the same block. As in `resolve`, input that may belong to another chain
  (an address that is no container here, a `token()` naming another chain, a processor contract that is no processor
  here) is `INVALID_ARGUMENT` with `data.status` `unsupported`, never `not-tapeout` (TAP-10 §4.1), and is not cached:
  use `api.forChain(chainId)`.
- **Never activation or opening.** TAP-10 §12.2: an unpaid name, a changed site-store implementation or a blocklist
  entry must not stop messaging. A container that `resolve` and `siteStatus` call `unpaid` or `not-opened` still has
  its TapeSend key and channel record read as usual (`opened` is reported). `tapeSendKey` reads neither the SiteRegistry
  nor the DomainBinding. The channel record is a file of the container's site, so `channelKeys` needs both of their
  implementations accepted (`store-changed`), as the private-channels draft §3.3 says.
- **The hub** (`tapeSendKey`, TAP-10 §13.8): at the same block the hub's implementation must be the one TAP-10 lists
  as current for that chain (`hub-changed` otherwise, whatever `sentinel` says), and the circuit beacon must still run
  the circuit implementation the hub was built with (`circuits-changed` otherwise; once seen, this client keeps it).
  The seal status is read and reported in `result.tap10.seal` (`{ factory, hub }`, both `false` today: nothing is
  sealed yet), never required. A client created with `conform: 'tap10'` accepts only the hub, processor factory and
  container opener TAP-10 lists for its chain (TAP-10 §2.2; anything else is `INVALID_ARGUMENT`). The sticky statuses
  last as long as the client (sub-clients from `forChain` included); to keep them across restarts pass
  `sealStatusStore`, a `{ get, set }` store like `channelRecordFloor`, keyed `<chainId>:<hub, lowercase>`, value
  `{ circuitsChangedAt, factorySealSeenAt, factorySealLost }`.
- **The key** (§12.2, §14.4 steps 1-3): `hub.keyFor` must name the resolved container and its endpoint
  (`hub-mismatch`), be usable (`no-key` when never published, `key-stale` otherwise), suite 1, and pass the X25519 key
  checks (`bad-key`), which the default mode leaves to the handshake. Step 4, whether the recipient reads the chain you
  send from, is yours: the result carries `chainsBitmap`, the bitmap in binary, where bit 0 (the rightmost digit) is BNB
  Smart Chain, bit 1 Base and bit 2 X Layer (TAP-10 §2.1). Sending (TAP-10 §20) stays yours too: resolving your own
  endpoint and checking it is opened and held by the connected wallet (step 2), comparing the recipient's key, `keyIndex`
  and holder with what you recorded (step 3, `key-changed`), and reading the key again right before signing (step 6).
- **The record**: read as TAP-10 §7.1 reads a file (`not-found` when `chunkCount` is 0, `no-hash`, `incomplete`), as
  strict UTF-8 without a byte order mark (the default mode strips one), then the TAPI-26 §3.1 checks (`record-invalid`),
  with the holder's EIP-1271 approval read at the same block. The site store is not read at all once it is
  `store-changed`. Records and verdicts are cached as before (at most 300 s), verdicts with their `data.status`; node
  failures and `unsupported` never are. A record served from the cache carries the `tap10.pinned` block of the read
  that put it there; pass `{ fresh: true }` for a new one.
- **Endpoints**: `tapesend.endpoint`, `seal`, `open`, `messageId` and `sendTx` take `conform: 'tap10'`, which refuses any
  chainId above 2^53 − 1 (TAP-10 §12.1), including the chain inside a 32-byte endpoint. Without it the bound stays
  2^64 − 1.

The results carry `tap10`: `{ version: '1.1', status: 'ok', pinned, endpoint, hub, circuits, seal }` from `tapeSendKey`,
`{ version: '1.1', status: 'ok', pinned, implementations }` from `channelKeys`. The errors:

| `data.status` | `code` |
|---|---|
| `wrong-chain`, `input-error`, `unsupported` | `INVALID_ARGUMENT` |
| `unavailable`, `stale-block` | `RPC_UNAVAILABLE` / `RPC_DISAGREE`, `RPC_STALE` |
| `hub-changed`, `circuits-changed`, `store-changed` | `CONTRACT_UNKNOWN` |
| `no-such-token`, `no-key`, `key-stale` | `NOT_FOUND` |
| `not-tapeout` (a container of this chain whose circuit fails a check), `hub-mismatch`, `bad-key`, `not-found`, `no-hash`, `incomplete`, `record-invalid` | `CHANNEL_INVALID` |

`not-found` and `record-invalid` are TapeAPI's names (TAP-10 names no outcome for a record); the others are TAP-10's.
The hub's `Upgraded` logs (§13.8, a SHOULD that needs `eth_getLogs`) are not read.

**Not covered yet.** With 1.5.0 the conformance mode covers the resolve path (strict agreement for `ownerOf` and
EIP-1271 included) and the messaging path above, input without chain information on every chain with `ambiguous`, and
the processor number of a container or processor contract. Within those paths one thing is still not done: the hub's
`Upgraded` log scan of TAP-10 §13.8, a conditional SHOULD (when nodes that serve `eth_getLogs` are available, read every
`Upgraded` log of the hub and accept it only if each implementation named is the boot implementation or one TAP-10
lists). `tapeSendKey` checks the hub's current implementation slot only, which cannot see an upgrade that rewrote
storage and restored an accepted implementation within one transaction.

## Formats that are now frozen

These are written to your storage by the SDK or the tools, so 1.x reads what 1.0 wrote:

- `channelRecordFloor`: key `<chainId>:<container, lowercase>`, value an integer (Unix seconds).
- `checkGroupInvites` cursors: key `relay:<relay container>:<room>`, value `{ after, epoch }`.
- A group `snapshot()`: `{ v: 1, gid, owner, epoch, role, lastSeq?, roster? }`.
- The `tapeapi-mcp` pin file (`~/.tapeapi/mcp-pins.json`, `v: 1`).

## Command-line tools

`tapeapi-mcp` and `tapeapi-verify` keep their options. Both exit with 0 (normal exit), 1 (a runtime failure) or 2 (a
usage mistake), and read no environment variable. `tapeapi-verify --strict` now ends a stream in an error event when no
receipt that came before its end (its final event or `[DONE]`) verifies, and passes on only whole events, so a stripped
receipt fails the stream instead of arriving after it ended.
