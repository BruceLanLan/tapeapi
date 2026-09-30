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

**Experimental in 1.0:** everything that pays. TAP-22 payment channels and the escrow contract are not deployed or
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
| `deliverGroupUpdate({ relay, bus })`, `checkGroupInvites({ relay })` | `deliverGroupUpdate({ relayClients: [...], busClients: [...] })`, `checkGroupInvites({ relayClients: [...] })` | Always lists. These are clients to send and read through: `relayClients` holds `{ api, service, payer? }` (a TapeAPI client and the resolved relay service), `busClients` holds `{ address, sendTx }`. `relays` is something else: the list of relay references `{ url, container }` that `createGroup`, `resumeGroup` and `channel.createInvite` put into a roster or an invite, a protocol field (TAP-26, TAP-27) that keeps its name. `relay`, `bus`, `relays` and `buses` are refused here with a pointer to this page. |
| a relay client (`relayClients`) `{ api, svc, payer }` | `{ api, service, payer }` | As above. |
| `G.createGroup({ now })`, `G.joinGroup({ now })` (a function returning milliseconds) | `clock`, a function returning Unix **seconds** (fractional allowed); `resumeGroup` takes it too | Every `now` in the SDK is a Unix-seconds number (channel handshakes, `validateManifest`, `verifyUsageReceipt`); a group's long-lived clock is `clock`, in the same unit. `now` on a group is refused, and so is a `clock` that returns milliseconds (above 1e11, e.g. `Date.now`). |
| WebMCP `handle.svc` | `handle.service` | As above. |
| `sig.keccak256`, `sig.toHex`, `sig.bytesToHex`, `sig.hexToBytes` | `abi.keccak256`, `abi.toHex`, ... | One home for byte helpers. |
| `readJsonBounded`, `describeUrl`, `isNodeLimit` from `@tapeapi/sdk/rpc` | removed | Internal helpers. `@tapeapi/sdk/rpc` exports `createRpc` and `RPC_BODY_LIMIT`. |
| `ai.amountOf`, `ai.pricesOf`, `ai.sseDigestOfPayloads`, `ai.sentinelOf`, `ai.rootOf`, `ai.saltRequestBody`, `ai.SALT_LENGTH`, `ai.CURRENCIES`, `ai.PRICE_UNIT`, `ai.MODELS_MAX`, `ai.ENDPOINTS_MAX`, `ai.ALIASES_MAX`, `ai.PRICES_MAX`, `ai.AMOUNT_DECIMALS`, `ai.EVENT_PARSE_LIMIT`, `ai.FORWARD_PREFIXES`, `ai.SSE_RECEIPT_PREFIX` | removed | Used only inside the SDK and its tests. `verifyUsageReceipt` does the price arithmetic and the hashing; the limits are in TAP-20 §3.9. |
| `group.senderKey`, `group.buildEpoch` | removed | The key derivation and epoch builder behind the group handles; the TAP-27 vectors document them. |
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
(`channel.*`, TAP-26) reports `CHANNEL_INVALID`, the group module (`group.*`, TAP-27) reports `GROUP_INVALID`, and the
checks `api.call()` makes on `params` and `id` before sending report `BAD_REQUEST`, the code a provider would answer
for the same request. None of them is worth retrying.

## Error codes

The full list. Provider codes travel in signed envelopes and never change meaning ([TAP-21](../../spec/TAP-21.md) §3.2);
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
| `NOT_FOUND` | client | No service there: an unregistered label, a processor number past the last, or no channel record (a missing manifest file is `MANIFEST_INVALID`) | no |
| `RPC_UNAVAILABLE` | client | Too few nodes answered | yes |
| `RPC_STALE` | client | Since 1.2, with the experimental `pin` option: the block the nodes confirm is older than `maxPinAgeS`, or ahead of this client's clock (`data.ageS`) | yes |
| `CONTRACT_UNKNOWN` | client | Since 1.2, with the experimental `sentinel: 'strict'`: a TapeOut identity contract runs an implementation this SDK does not know, which means it was upgraded (`data.role`, `data.implementation`) | no: update the SDK or check the upgrade |
| `PROOF_INVALID` | client | Since 1.3, with the experimental `proofs` (needs `pin`): a verified Merkle proof of `fileInfo`, `cpuAt`, `isCPU` or `ownerOf` proves a value other than the one the nodes answered (with `proofs: true` as well as `'strict'`); or, with `'strict'` only, every proof the nodes served failed to verify against the stateRoot of the block the nodes confirmed (`data.read`, `data.node`, `data.block`, `data.stateRoot`) | no |
| `PROOF_UNAVAILABLE` | client | Since 1.3, with the experimental `proofs: 'strict'`: no node served `eth_getProof` for the pinned block, nodes of `quorum` operators did not agree on a stateRoot, or the contract runs an implementation whose storage layout the SDK does not know (`data.read`, `data.reason`). With `proofs: true` the same is only a warning and the quorum's answer is kept (detection only) | yes, or add a node that serves proofs |
| `RPC_ERROR` | client | Every node returned the same JSON-RPC error (`data.rpcCode`, `data.rpcRevert`) | a revert: no |
| `CANON_INVALID` | client | JSON with no canonical form, duplicate or forbidden keys | no |
| `ABI_INVALID` | client | ABI data that does not decode | no |
| `BAD_KEY` | client | A key or key address that cannot be used | no |
| `CHANNEL_INVALID` | client | TAP-26 data invalid or not authorised by the current holder | no |
| `GROUP_INVALID`, `GROUP_EQUIVOCATION` | client | TAP-27 data invalid; the owner signed two epochs with one number | no |
| `GROUP_DELIVERY` | client | Some group post failed after every post was tried (`data` is the delivery result) | depends |
| `BAD_RESPONSE` | client | A relay or your wallet's `sendTx` answered something unusable | no |
| `BUS_PRIVACY`, `BUS_BUDGET` | client | Too few cover rooms; a contract-wide read over its budget | no |
| `TAPESEND_INVALID` | client | A TAP-10 payload is invalid | no |
| `COMPARE_PATH_INVALID` | client | One provider's result has no number at a `compare` path | no |
| `RECEIPT_INVALID` | client | An AI usage receipt is missing or fails a check | no |
| `BUDGET_EXCEEDED`, `USER_DECLINED` | client | WebMCP spending budget; the user said no | no |
| `INVALID_ARGUMENT` | client | Your own options or arguments are wrong | **never** |
| `METHOD_NOT_ALLOWED` | provider route, unsigned | HTTP 405: a request other than POST to `/tapeapi/v1/<method>`. The SDK always POSTs; a client that meets it treats it as a transport failure (`PROVIDER_UNAVAILABLE`) | no |
| `NAME_TAKEN` | WebMCP | In `handle.skipped[].code`: `registerTool` failed, usually because another script on the page already registered that tool name (`reason` says why). Not thrown | after the other tool is gone (`refresh()`) |

An MCP server in front of a service (`createMcpProxy`) reports its own refusals as JSON-RPC errors whose
`error.data.code` is `TOOLS_CHANGED`, `INVISIBLE_CHARACTERS` or `UPSTREAM_UNAVAILABLE`.

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
