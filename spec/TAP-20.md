| TAP | 20 |
|---|---|
| Title | TapeAPI: Service Identity and Manifest |
| Author | Bruce (@BruceLanLan) |
| Status | Stable (v1) since 2026-09-29 (TapeAPI 1.0.0); §3.5 (ServiceDirectory) is Experimental |
| Implementation | Live without a directory (2026-09-27): on BNB Chain, `api.tapeapi.fun` (`11.1013.tape`, source `examples/public-api/`) and `relay.tapeapi.fun` (`12.1013.tape`) publish TAP-20 manifests with holder delegations, and the SDK resolves containers, `(circuits, tokenId)` pairs and names `<#ID>.<processor>.tape`; read-only resolution on X Layer and Base (area-coded names) since 2026-09-28. ServiceDirectory (§3.5) is not deployed, so labels do not resolve on mainnet. No third-party audit. |
| Type | Standards |
| Created | 2026-09-20 |
| Requires | TAP-1 |
| License | CC0-1.0 |

# TAP-20: TapeAPI: Service Identity and Manifest

> English is authoritative. 中文译文见下半部分，章节编号一一对应。

> **Placeholder number.** TAP-20 is a placeholder number proposed in [TapeKit issue #8](https://github.com/TapeOutProtocol/TapeKit/issues/8). TapeKit has no numbered-proposal process yet (changes to TapeOut itself follow TapeKit `SPEC.md` §15), so the maintainers may assign another number or move this document to another process; see [TAP-1](TAP-1.md).

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

## 1. Abstract

TapeAPI lets a circuit holder publish a machine-callable service under the circuit's container identity. This TAP defines the identity model (service = circuit, container = `DeWebHub.accountOf`), the location and schema of the service manifest (`/.well-known/tapeapi.json`, read through SiteRegistry), an EIP-712 delegation by which the holder authorises an off-chain signing key, and the resolution algorithm clients MUST follow. Response signing and payment are defined in TAP-21 and TAP-22.

## 2. Motivation

DeWEB gives a circuit a website; TapeSend (TAP-10) gives it a mailbox. Neither gives it a way to answer a structured request with a verifiable, attributable result. Today an off-chain API has no on-chain identity, a DeWEB site cannot advertise one, and a client has no way to check that a response really came from the party a name points to.

TapeAPI closes this gap without changing the protocol: identity is the existing container, discovery is an existing on-chain file, verification reuses the SPEC §15.1 kernel (derived container address, length + SHA-256, multi-node agreement). Human labels such as `reader` live only in a directory contract, never in the name grammar.

## 3. Specification

### 3.1 Identity

- A **service** is a circuit: the pair `(circuits, tokenId)` where `circuits` is an ERC-721 processor contract.
- A service lives on exactly one chain: the chain its circuit is on. TapeAPI follows TapeOut to these chains (addresses read on chain 2026-09-28; source TapeKit `kernel/src/config.js`):

| Chain | chainId | Area code | Processor factory | DeWebHub (proxy) | SiteRegistry (proxy) |
|---|---|---|---|---|---|
| BNB Smart Chain | 56 | none | `0x68224F668083c29e9800Be2a646d42d18cedF7e2` | `0xe61A9C7213a6Aa616C246a2B569e555B417b25ee` | `0xd006ffdd5Ae313B17729621A00999cD3C71CE5e6` |
| X Layer | 196 | 2 | `0x1f09DAeFA827f02CBb40967cc91b259763760761` | `0xe61A9C7213a6Aa616C246a2B569e555B417b25ee` | `0xd6EFb7adCc9c83dC4924Ad56f6a8E4e969b9ADB6` |
| Base | 8453 | 3 | `0x1f09DAeFA827f02CBb40967cc91b259763760761` | `0xe61A9C7213a6Aa616C246a2B569e555B417b25ee` | `0xd6EFb7adCc9c83dC4924Ad56f6a8E4e969b9ADB6` |

- The **container** of a service is `DeWebHub.accountOf(circuits, tokenId)` on the service's chain. Clients MUST derive the container on that chain and MUST NOT accept a self-reported container.
- The **holder** is `IERC721(circuits).ownerOf(tokenId)` at the time of verification.
- The service's on-chain name is the SPEC name `<#ID>.<processor>.tape` on BNB Smart Chain and `<#ID>.<area>.<processor>.tape` on any other chain, where `#ID` is `tokenId`, `processor` is the number under which that chain's TapeOut processor factory lists `circuits` (TapeKit SPEC §2.2, §3.2), and `area` is the chain's area code in the table above (TapeKit `kernel/src/name.js`; `1.2.344.tape` is #1 of processor 344 on X Layer). Area codes are assigned once and never reused; `0` and `1` are reserved. This TAP defines no new name syntax.
- Identity does not carry across chains. The same `(circuits, tokenId)` on two chains names two services with two containers (processor 0 is one contract address on both X Layer and Base). A client MUST NOT treat a service on one chain as the same service on another chain.
- A **label** is a `bytes32` alias registered in a ServiceDirectory contract (§3.5). A label is a lookup convenience only; it carries no authority.

### 3.2 Manifest Location

- The manifest MUST be stored in the container's DeWEB site at URL path `/.well-known/tapeapi.json`, content type `application/json`, UTF-8.
- SiteRegistry keys carry **no leading slash** (TapeKit SPEC §6 step 3 strips it before lookup; on mainnet `4246.0.tape` stores `index.html`, and `fileInfo(container, "/index.html")` answers size 0). The registry key of the manifest is therefore `.well-known/tapeapi.json`. Clients MUST strip leading slashes before every `read` / `fileInfo` call.
- Clients MUST read it with `SiteRegistry.read(container, ".well-known/tapeapi.json")` on the SiteRegistry of the service's chain (§3.1) and MUST verify the returned bytes against `SiteRegistry.fileInfo(container, path)` of the same registry: byte length MUST equal `size` and `sha256(bytes)` MUST equal `sha256Hash`.
- All `eth_call`s in this TAP MUST be issued to at least `quorum` independently configured RPC nodes (RECOMMENDED `quorum ≥ 2`) and accepted only if all results are byte-identical. Disagreement MUST be treated as failure (`RPC_DISAGREE`), never resolved by majority. A node that fails in transport (timeout, HTTP error, oversize body) has not answered and is not a disagreement, but at least `quorum` nodes MUST answer. A revert on one node and a value on another is a disagreement. A JSON-RPC error in which the node describes ITSELF -- rate limiting (`-32005`), a method it does not implement (`-32601`), or a refusal to scan the range asked for -- is a node failure, exactly like a timeout: the node has not answered. Concretely, `-32005` and `-32601` are node failures, and a `-32000` whose message describes a range, result or size limit, a timeout or an unsupported method is a node failure unless the message mentions a revert, gas or an allowance (those are answers about the chain). Any other JSON-RPC error, a revert in particular, is an answer about the chain: it is a result, compared across nodes by its `code` and by whether it reports a revert (code `3`, or a message that mentions a revert; message texts otherwise differ between node implementations and are not compared), so that a revert and a `-32000` "header not found" never count as the same answer, and an error agreed by every answering node surfaces as `RPC_ERROR`. A client MAY re-ask all nodes once to absorb a race across a block boundary on `latest`; the re-ask MUST itself be unanimous. `eth_blockNumber` is not an `eth_call`: honest nodes differ by a block or two, so clients use the lowest head among at least `quorum` answers and SHOULD refuse (`RPC_DISAGREE`) a spread wider than a configured bound (reference: 64 blocks). Clients MUST NOT fetch node lists from a server at runtime.
- The manifest MUST NOT exceed 65 536 bytes.
- A development mode that accepts a manifest object or URL directly MAY exist in SDKs; it MUST be opt-in (`dev: true`) and MUST NOT be reachable from a default configuration.

### 3.3 Manifest Schema

```json
{
  "tapeapi": "0.1",
  "name": "TapeOut Reader",
  "circuits": "0x...", "tokenId": "4246",
  "container": "0x...",
  "signer": "0x...",
  "delegation": { "expires": 1790000000, "sig": "0x..." },
  "endpoints": { "live": ["https://host/tapeapi/v1"], "async": false },
  "methods": [
    { "name": "blockNumber", "priceBEM": "0", "params": {}, "returns": { "blockNumber": "number" } },
    { "name": "circuitHolder", "priceBEM": "0.0001",
      "params": { "circuits": "address", "tokenId": "string" }, "returns": { "holder": "address" } }
  ],
  "payment": { "escrow": "0x...", "unit": "BEM", "decimals": 8 }
}
```

| Field | Type | Req. | Constraint |
|---|---|---|---|
| `tapeapi` | string | MUST | `"MAJOR.MINOR"`; `"0.1"` for this version. A client MUST accept `"0.N"` for any integer N ≥ 1 without leading zeros and MUST refuse any other major. A minor release only adds optional fields: a client MUST ignore fields it does not know, MUST NOT refuse a manifest because of them, and still applies every rule of the minor it implements. |
| `name` | string | MAY | ≤ 64 UTF-8 code points. Display only. |
| `circuits` | address | MUST | Checksummed or lowercase hex, 20 bytes. |
| `tokenId` | string | MUST | Decimal, no leading zeros, fits `uint256`. |
| `container` | address | MUST | MUST equal `DeWebHub.accountOf(circuits, tokenId)`. |
| `signer` | address | MUST | secp256k1 address that signs TAP-21 responses. |
| `delegation` | object | MUST | `{ "expires": uint64, "sig": hex65 }` (a contract holder's `sig` MAY be longer, §3.4). Required even when `signer` equals the holder, so that every manifest carries a fresh, expiring proof of holder consent. |
| `endpoints` | object | MUST | `{ "live": string[], "async": boolean }`. |
| `endpoints.live` | string[] | MUST | Zero or more absolute `https://` URLs without query or fragment. Providers SHOULD list at most 4. |
| `endpoints.async` | boolean | MUST | `true` means the service accepts requests via its TAP-10 (TapeSend) inbox addressed to `container`. At least one of `live` non-empty or `async == true` MUST hold. |
| `methods` | array | MUST | Non-empty. Method names MUST be unique. |
| `mcp` | object | MAY | The service's tools as an MCP server, pinned by digest; see §3.8. |
| `ai` | object | MAY | The service's AI API endpoints and its published price table, whose answers carry signed usage receipts (TAP-21 §3.5); see §3.9. |
| `payment` | object | MUST* | `{ "escrow": address, "unit": "BEM", "decimals": 8 }`. *REQUIRED if any `priceBEM != "0"`, and then `escrow` is a non-zero address (a zero escrow can settle nothing). `unit` and `decimals` carry no information, since both are fixed: either may be omitted and is then read as `"BEM"` and `8`; any other value is invalid. |

Method descriptor:

| Field | Type | Req. | Constraint |
|---|---|---|---|
| `name` | string | MUST | `^[A-Za-z_][A-Za-z0-9_]{0,63}$`, and not `__proto__`, `constructor` or `prototype`: TAP-21 §3.1 forbids those keys everywhere, so no handler table can hold them safely. |
| `priceBEM` | string | MUST | Decimal string, ≥ 0, at most 8 fractional digits, no exponent. Interpreted in BEM (`0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a`, **8 decimals** — verified on chain 2026-09-21; assuming 18 is a 10^10 error). `"0"` means free. |
| `params` | object | MUST | Map of parameter name → type name. Type names are informative; the wire format is JSON. MAY be `{}`. |
| `returns` | object | MUST | Map of field name → type name. Informative. |
| `description` | string | MAY | ≤ 256 code points. |

Clients MUST ignore unknown fields. A manifest violating any MUST above is `MANIFEST_INVALID`.

### 3.4 Delegation

The holder authorises `signer` with an EIP-712 signature.

- Domain: `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)` with `name = "TapeAPI"`, `version = "1"`, `chainId` = the chainId of the service's chain, `verifyingContract` = the DeWebHub proxy of that chain (§3.1).
- The DeWebHub proxy has one address on every chain, so the chainId alone separates the domains: a delegation signed for one chain is a different digest on every other chain, and a verifier MUST NOT accept it there. A chain added to §3.1 without a DeWebHub needs its own verifyingContract, which the TAP adding that chain names.
- Primary type: `Delegation(address container,address signer,uint64 expires)`.
- `DELEGATION_TYPEHASH = keccak256("Delegation(address container,address signer,uint64 expires)") = 0xc5081f9dc7e79dfbe7f3b3220ed9e7a29d0bc53239ee74dc184e4ac1f810948c`.
- `structHash = keccak256(abi.encode(DELEGATION_TYPEHASH, container, signer, expires))`.
- `digest = keccak256(0x1901 ‖ DOMAIN_SEPARATOR ‖ structHash)`.
- `sig` is 65 bytes `r ‖ s ‖ v`, `v ∈ {27, 28}` (a `v` of 0 or 1 is normalised to 27 or 28 first, as in TAP-21 §3.3), `s` in the lower half-order. The recovered address MUST equal the holder at verification time, unless the holder is a contract that accepts `sig` (below). `expires` MUST be strictly greater than the verifier's current Unix time. Verifiers SHOULD reject `expires` more than 366 days in the future. The same bound is a MUST for TAP-26 channel records, intentionally: a channel identity must lapse, while a service delegation is renewed with its manifest.
- **Contract holders.** A client MAY accept a delegation from a holder that is a contract under EIP-1271: `isValidSignature(digest, sig)` on the holder MUST return the full 32-byte word `0x1626ba7e` followed by zeros. The delegation `sig` may then be longer than 65 bytes. The reference SDK treats a 65-byte `sig` as ECDSA (it recovers it first and refuses a malformed one before trying EIP-1271) and passes a longer `sig`, up to 1024 bytes as for TAP-26 channel records, to EIP-1271 directly. The reference ServiceDirectory verifies ECDSA only, so a contract holder's delegation is accepted by clients alone until that contract adds EIP-1271.
- `ServiceDirectory.verifyDelegation(circuits, tokenId, signer, expires, sig)` MUST implement the MUST-level checks of this section (the 366-day bound is a client SHOULD and is not enforced on-chain) and MAY be used by clients instead of local recovery; either way the holder MUST be read on-chain, never from the manifest.

### 3.5 ServiceDirectory

> **Experimental.** This section is Experimental under [TAP-1](TAP-1.md) §4.1 (freeze rule 3): the ServiceDirectory contract is not deployed or audited, and this section can change incompatibly, or be withdrawn, without a new version of this document. It is outside the Stable (v1) freeze, and so are the places that use it: a label as input to §3.6 step 1, the optional `serviceOf` cross-check at the end of this section, and `ServiceDirectory.verifyDelegation` in §3.4. The rest of this document does not depend on it: resolution by name, container or `(circuits, tokenId)` (§3.6) needs no directory.

A non-upgradeable contract per chain that maps labels to containers and records manifest paths. It is constructed with `(hub, factory, domainBinding)`; `factory` is the TapeOut processor factory and `domainBinding` MAY be the zero address to disable the activation gate.

- `register` MUST reject any `circuits` for which `factory.isCPU(circuits)` is false, so that a counterfeit ERC-721 cannot claim labels.
- `register` MUST derive the container via `DeWebHub.accountOf` and MUST refuse a label already held by a different container.
- `register` and `update` MUST be called by the current holder. An `ownerOf` that reverts or returns no address (a burned circuit) MUST be treated as "no holder", so the call is refused (the reference contract reverts with `NotHolder()`), never treated as authorised and never allowed to bubble up the circuit contract's own revert.
- When `domainBinding` is configured, claiming a non-zero label MUST require `isContainerLive(container)`. A liveness call that reverts, returns fewer than 32 bytes, or returns any value other than `1` MUST be treated as not live.
- `release` is normally restricted to the holder; when the circuit has been burned and has no holder, anyone MAY release the label so it does not stay locked forever.
- A `labelFee` MAY be charged for non-zero labels. Clients MUST read `labelFee()` and attach exactly that,
  or nothing: the directory keeps any attached value in every branch, so anything above the fee is
  forfeited silently and permanently. The reference deployment's fee and whether it configures an
  activation gate are published with its address.
- `manifestPath` is informative only. Clients MUST NOT use it for resolution (§3.6 always reads `.well-known/tapeapi.json`), and anything that does pass it to the SiteRegistry MUST strip leading slashes first (§3.2). The reference SDK registers the registry form `.well-known/tapeapi.json`.

The full interface is in `contracts/src/ServiceDirectory.sol`. The directory is a hint: nothing a client trusts comes from it except the `label → container` mapping, and even that is followed only by the algorithm in §3.6. A client with a directory configured MAY also compare the directory's record for the resolved container (`serviceOf`) with the manifest's `(circuits, tokenId)` and refuse a mismatch as `MANIFEST_INVALID` (the reference SDK does); since the directory derives the container on the hub, a mismatch means a broken directory. A container with no record, or a directory whose `serviceOf` reverts, does not block resolution.

### 3.6 Resolution Algorithm

Input: a label, a TapeOut name `<#ID>.<processor>.tape` or `<#ID>.<area>.<processor>.tape`, a container address, or a `(circuits, tokenId)` pair. Output: `{ manifest, container, verified: { delegation, holder } }` or an error.

1. **Locate.** If input is a label, `container = ServiceDirectory.resolve(label)`; zero address → `NOT_FOUND`. If input is `(circuits, tokenId)`, `container = DeWebHub.accountOf(circuits, tokenId)`. If input is a TapeOut name `<#ID>.<processor>.tape` (canonical form per TapeKit SPEC §2.2: both parts decimal without leading zeros except `0` itself, all lowercase, `#ID ≥ 1`; a client MAY also accept the suffix-less `<#ID>.<processor>`, which TapeKit SPEC §2.4 lets an address bar accept for the same name), it is resolved exactly as TapeKit SPEC §3.2 resolves it: `circuits = factory.cpuAt(processor)` on the TapeOut processor factory (step 3), then `container = DeWebHub.accountOf(circuits, #ID)`; a processor number past the last one (`cpuAt` reverts) → `NOT_FOUND`. A string of this form is a name, never a label, and is not looked up in any directory. A string that looks like a name but is not in that form (leading zeros, an upper-case `.TAPE`, `#ID` 0) MUST be refused rather than guessed at, and is not looked up as a label either, so that no label can squat a spelling of a name. TapeKit's other address-bar forms (`#4246@0`, `tape://4246.0.tape/`) are not inputs to this algorithm: a shell converts them to the canonical name first, and the reference SDK refuses them like a non-canonical spelling. If input is a container, use it as given.

   **Chain.** A `(circuits, tokenId)` pair or a container names no chain by itself; a client resolves it on the chain given with it, or else on its own configured chain. A TapeOut name selects its chain by its area code: no area code is BNB Smart Chain. A name whose area code is reserved or not in §3.1 MUST be refused like any other non-canonical spelling and is not looked up as a label. Every later step (manifest, `accountOf`, `isCPU` on that chain's factory, `ownerOf`, delegation) runs on the selected chain, and `eth_call`s go to nodes of that chain. A client SHOULD tell its user which chain a service is on.

   The name form adds no trust beyond the `(circuits, tokenId)` path: it only computes that pair from on-chain reads made under §3.2, and steps 2–5 run unchanged, so step 3 still re-derives the container from the manifest's own `(circuits, tokenId)` and checks `isCPU`.
2. **Read manifest.** `fileInfo(container, path)` then `read(container, path)`, both with quorum agreement (§3.2). Verify length and SHA-256. Parse JSON; validate against §3.3. Failure → `MANIFEST_INVALID`.
3. **Derive.** `derived = DeWebHub.accountOf(manifest.circuits, manifest.tokenId)`. Clients MUST reject unless `derived == manifest.container == container`, and MUST reject unless the TapeOut processor factory of the service's chain (§3.1; `0x68224F668083c29e9800Be2a646d42d18cedF7e2` on chainId 56) answers `isCPU(manifest.circuits) == true`: `accountOf` derives an address for any ERC-721, so without this check anyone could deploy a counterfeit token contract and present its account as a TapeOut container (TapeKit SPEC §3.3 step 2). Failure → `MANIFEST_INVALID`.
4. **Holder.** `holder = IERC721(manifest.circuits).ownerOf(manifest.tokenId)`. Reverts → `MANIFEST_INVALID`.
5. **Delegation.** `manifest.delegation` MUST be present (§3.3). Verify per §3.4 with `signer = manifest.signer`; the recovered address MUST equal `holder` (or `holder` accepts the signature under EIP-1271, §3.4) and `expires` MUST be in the future. Failure → `DELEGATION_INVALID`.
6. **Return** with `verified.delegation = true` and `verified.holder = holder`.

Clients MAY cache the result, and a cached service MUST remain re-readable: a client that cannot return to the source it resolved from cannot implement the rest of this paragraph.

Re-reading MUST start at **step 2** (read the manifest file again through the SiteRegistry) and continue through step 5. Re-running only steps 4–5 is a no-op for every failure a stale manifest causes: those steps read the cached manifest's own `signer` and `delegation`, so they still pass while the cached `methods`, prices and endpoints stay stale. Earlier drafts of this paragraph prescribed exactly that, and the reference SDK inherited a permanent deadlock from it: after a provider raised a price, a consumer holding the older manifest re-signed the same insufficient voucher for ever.

Clients MUST re-read when a TAP-21 response fails signature verification, when a provider rejects a voucher with a `price` that differs from the cached one (TAP-22 §3.2), and when a method that is free in the cached copy is answered `PAYMENT_REQUIRED` (it is now priced). Clients SHOULD re-read a manifest older than one hour before spending against it. A price the provider quotes (`data.price`) is a hint that triggers the re-read and is never authoritative: the price a client pays MUST be the one it read from the chain.

**Price consent.** A client MUST NOT pay a per-call price higher than the one its caller accepted for that method. On learning a higher price (from a re-read) it MUST fail with the client-side code `PRICE_CHANGED` (`data: { method, accepted, price }`) unless the caller supplied a `maxPrice` at or above the new price or explicitly accepted it. A lower price MAY be adopted silently.

Clients MUST NOT skip step 3 for any input form, including a label from the directory.

### 3.7 Shell Capability (`tape.api`)

A shell (preview or gateway) MAY expose a `tape.api` object to a site running under a real origin, implementing §3.6 and TAP-21 on the site's behalf. The following apply:

- A call through `tape.api` reaches an `endpoints.live` URL and is therefore an off-chain request under SPEC §7. The shell MUST apply the §7.5 per-site grant before the first call and MUST block it by default.
- A site that uses `tape.api` contains an off-chain reference and MUST NOT display the SPEC §8 "100% on-chain" badge.
- A future Core TAP MAY define a "verified service" badge tier for sites whose only off-chain traffic is TAP-20/21 traffic with verified signatures. Such a tier is explicitly out of scope for this TAP and MUST NOT be inferred from it.
- Per-origin isolation (§7) is unchanged: `tape.api` MUST NOT allow one site to observe another site's calls, grants, or vouchers.

### 3.8 MCP Binding (`mcp`)

A service whose methods are the tools of a Model Context Protocol (MCP) server MAY say so with an optional `mcp` object:

```json
"mcp": { "endpoint": "https://mcp.example.com/mcp", "toolsSha256": "<64 lowercase hex digits>" }
```

- `endpoint` MUST be an absolute `https://` URL without query or fragment, where the service answers MCP over Streamable HTTP.
- `toolsSha256` MUST be the SHA-256, as 64 lowercase hex digits, of the RFC 8785 canonical JSON of the tool list: each tool reduced to the members `name`, `title`, `description`, `inputSchema`, `outputSchema` and `annotations` that it has, the list sorted by `name` in UTF-16 code-unit order, names unique.
- A client that uses the MCP endpoint MUST compute that digest over the `tools/list` result it receives and MUST refuse the service's tools when the digest differs from `toolsSha256`. A client SHOULD pin the value and treat a later change as a change of the service that needs the user's consent.
- A manifest method named after a tool MUST call that tool: `POST <live>/<name>` with the tool's arguments as `params`, and the TAP-21 `result` is the tool's MCP result without `_meta`. A tool error (`isError: true`) is still `ok: true`: the signature attests what the tool answered.
- A provider whose upstream tool definitions no longer match `toolsSha256` MUST refuse every call with a signed error until the holder publishes a new manifest.
- `toolsSha256` binds the definitions, not the behaviour: a server can still answer differently under the same definitions. Signed results make that attributable, not impossible.

### 3.9 AI Service Binding (`ai`)

A service that runs an AI API (a gateway, an aggregator, a team serving its own models) MAY publish the API's endpoints and its price table with an optional `ai` object. Callers keep the official SDK of the API's format and only point its base URL at the service; every answer carries a usage receipt signed by the manifest `signer` (TAP-21 §3.5), which a client checks against this field.

```json
"ai": {
  "endpoints": [
    { "format": "openai-chat", "baseUrl": "https://ai.example/v1" },
    { "format": "anthropic-messages", "baseUrl": "https://ai.example" }
  ],
  "models": [
    { "id": "gpt-x", "aliases": ["gpt-x-2026-09-01"], "formats": ["openai-chat"], "prices": [
      { "currency": "USDT", "unit": "1M tokens", "input": "1.25", "output": "10", "cacheRead": "0.125", "reasoning": "12" },
      { "currency": "BEM", "unit": "1M tokens", "input": "12.5", "output": "100", "cacheRead": "1.25" } ] },
    { "id": "claude-x", "formats": ["anthropic-messages"], "prices": [
      { "currency": "BEM", "unit": "1M tokens", "input": "3", "output": "15", "cacheRead": "0.3", "cacheWrite": "3.75", "cacheWrite1h": "6" } ] }
  ]
}
```

**Endpoints.**

| Field | Type | Req. | Constraint |
|---|---|---|---|
| `endpoints` | array | MUST | 1 to 16 entries, at most one per `format`. |
| `endpoints[].format` | string | MUST | `^[a-z][a-z0-9-]{0,63}$`. The formats of this version are listed below. A client MUST ignore an endpoint whose format it does not know, so that a later format (Gemini, for instance) can be added without breaking older clients. |
| `endpoints[].baseUrl` | string | MUST | An absolute `https://` URL (`http://` only in the development mode of §3.2) without query, fragment or user information. Trailing slashes carry no meaning and are removed before use. |

A `baseUrl` is what a caller configures in the official SDK of its format: the **service root** followed by the format's suffix. A request of a format goes to the service root followed by the format's path, and that path is the `path` its receipt names (TAP-21 §3.5). For the formats below, a client MUST ignore an endpoint whose `baseUrl` does not end with the format's suffix.

| Format | API | Requests with a receipt | `baseUrl` | Request model |
|---|---|---|---|---|
| `openai-chat` | OpenAI Chat Completions | `POST /v1/chat/completions` | root + `/v1` | the request body's `model` |
| `openai-responses` | OpenAI Responses | `POST /v1/responses`, `POST /v1/responses/compact` | root + `/v1` | the request body's `model` |
| `anthropic-messages` | Anthropic Messages | `POST /v1/messages` | the root itself (the Anthropic SDKs add `/v1`) | the request body's `model` |
| `openai-embeddings` | OpenAI Embeddings | `POST /v1/embeddings` | root + `/v1` | the request body's `model` |

Other paths under the root (`/v1/models`, `/v1/messages/count_tokens`, …) MAY be served; they carry no receipt and no price.

**Models.**

| Field | Type | Req. | Constraint |
|---|---|---|---|
| `models` | array | MUST | 1 to 256 entries. |
| `models[].id` | string | MUST | The model name as the API reports it: 1 to 256 UTF-16 code units, none of them a control character (U+0000–U+001F, U+007F–U+009F). |
| `models[].aliases` | string[] | MAY | 1 to 16 further names of the same entry, each under the rules of `id`. |
| `models[].formats` | string[] | MAY | A non-empty list of distinct formats, each the `format` of an entry of `endpoints`. When present, the entry prices answers of these formats only; when absent, of every format. |
| `models[].prices` | array | MUST | 1 to 7 price entries, one per currency. The singular `price` of earlier drafts is not a field: a model entry that carries it is invalid. |

Every `id` and every alias MUST appear at most once in the whole table, ids and aliases counted together, so that a model name selects at most one entry.

Price entry:

| Field | Type | Req. | Constraint |
|---|---|---|---|
| `currency` | string | MUST | One of `BEM`, `BNB`, `USDT`, `USDC`, `ETH`, `USD1`, `USD`; unique among the price entries of one model. |
| `unit` | string | MUST | `"1M tokens"`: every price of the entry is per 1 000 000 tokens. |
| `input` | decimal | MUST | Input tokens that are neither cache reads nor cache writes. |
| `output` | decimal | MUST | Output tokens; reasoning tokens too, unless `reasoning` is given. |
| `cacheRead` | decimal | MAY | Input tokens read from a prompt cache. Default: `input`. |
| `cacheWrite` | decimal | MAY | Input tokens written to a prompt cache. Default: `input`. |
| `cacheWrite1h` | decimal | MAY | The cache writes kept for one hour (Anthropic's 1-hour cache). Default: `cacheWrite`, else `input`. |
| `reasoning` | decimal | MAY | Output tokens spent on reasoning. When absent, reasoning tokens are priced as `output`. |

A **decimal** is a JSON string matching `^(0|[1-9][0-9]{0,17})(\.[0-9]{1,8})?$`: at most 18 integer digits without leading zeros, at most 8 decimals, no sign, no exponent, no whitespace. Trailing zeros after the point carry no meaning (`"0.30"` is `"0.3"`).

**Currencies.** `BEM` is the token of §3.3 (8 decimals). `BNB` is the native coin of BNB Chain, and `USDT`, `USDC`, `ETH` and `USD1` name those tokens on BNB Chain. `USD` is a display currency with no token behind it. The order of a model's price entries is kept in its receipts and has no other meaning.

**Prices are published, not settled.** The table states what the provider claims to charge and lets anyone recompute the amount a receipt claims; nothing in this TAP moves funds, and an amount in a receipt is a checkable claim, not a payment. Settlement per token belongs to the next escrow version of TAP-22; until then a provider bills as it already does (its own keys, its own accounts). The `priceBEM` of `methods` is unrelated: `ai` prices apply only to the requests in the format table.

**Validation.** A client that uses the field MUST validate the whole field and MUST refuse to use it (`MANIFEST_INVALID`) when it violates any MUST of this section. The rest of the manifest is unaffected, and a client that does not use the field ignores it (§3.3).

**Model matching.** An entry is *allowed* for a format when it has no `formats` or its `formats` lists that format. The entry that prices an answer is the allowed entry whose `id`, or one of whose `aliases`, equals the model the upstream API **reported** in the answer (TAP-21 §3.5 says where each format reports it): equal as strings, code unit for code unit, with no case folding, no Unicode normalisation and no prefix or pattern matching. Only when the answer reports no model (none, or not a string of 1 to 256 code units) is the request model of the format table matched in the same way; the receipt then names that requested model and says `modelMatchedBy: "request"`. When no entry matches, the answer is not priced. Providers and clients MUST apply exactly this rule: any other matching would let one side price a receipt that the other leaves unpriced or prices differently.

**Usage.** A receipt reports token counts in one object, the same for every format (TAP-21 §3.5 maps each format's own counts onto it):

| Member | Req. | Meaning |
|---|---|---|
| `prompt_tokens` | MUST | All input tokens, cache reads and cache writes included. |
| `completion_tokens` | MUST | All output tokens, reasoning included; `0` for a format without output tokens (embeddings). |
| `total_tokens` | MUST | As the API reported it, else `prompt_tokens + completion_tokens`. |
| `cache_read_tokens` | MAY | Input tokens read from a cache: a subset of `prompt_tokens`. |
| `cache_write_tokens` | MAY | Input tokens written to a cache: a subset of `prompt_tokens`. |
| `cache_write_1h_tokens` | MAY | Cache writes kept for one hour: a subset of `cache_write_tokens`. |
| `reasoning_tokens` | MAY | Output tokens spent on reasoning: a subset of `completion_tokens`. |
| `other` | MAY | `{ name: count }`: counts billed per use rather than per token, e.g. `web_search_requests`. Names match `^[a-z][a-z0-9_]{0,63}$`, counts are above 0, members are sorted by name, and the object is left out when it would be empty. |

- An optional count is present exactly when the API reported it; a reported `0` is present.
- Every count is an integer from 0 to 2^53 − 1, and the members MUST appear in the order of the table.
- `cache_read_tokens + cache_write_tokens ≤ prompt_tokens`, `cache_write_1h_tokens ≤ cache_write_tokens` and `reasoning_tokens ≤ completion_tokens`. Reported counts that break any of these, or an answer that does not report its input tokens, give no usage (`null`), and therefore no price.

**Amount.** For each price entry `p` of the matched model and a usage `u`, reading every absent count as 0:

```
cr = u.cache_read_tokens    cw = u.cache_write_tokens    cw1h = u.cache_write_1h_tokens
rs = u.reasoning_tokens if p.reasoning is given, else 0

sum =  p.input        × (u.prompt_tokens − cr − cw)
     + p.cacheRead    × cr                              default p.input
     + p.cacheWrite   × (cw − cw1h)                     default p.input
     + p.cacheWrite1h × cw1h                            default p.cacheWrite, else p.input
     + p.output       × (u.completion_tokens − rs)
     + p.reasoning    × rs

amount = sum / 1 000 000, rounded up to 8 decimals
```

- The buckets are disjoint: every token is priced exactly once.
- The arithmetic MUST be exact: each price is read as an integer number of 10^-8 units, every product and the sum are integers, and the sum is divided by 1 000 000 and rounded **up** to a whole number of 10^-8 units **once**, on the sum, never per bucket. Floating point MUST NOT be used.
- The amount is written as a decimal string with at least one integer digit and exactly 8 decimals (`"0.00357500"`, `"12.00000000"`).
- Per-use counts (`other`) have no token price: they add 0 and are named in the receipt's `unpriced`.
- A matched entry gives one amount per price entry, in the entry's order. No matched entry, or no usage, gives no amount. An answer that did not complete is priced from the usage it reported.

## 4. Rationale

- **Circuit as identity.** A circuit is transferable, already has a container, a DeWEB site and a TapeSend inbox, and is the unit users already recognise. Every service therefore consumes a circuit, which aligns provider incentives with the protocol rather than with a parallel registry. Alternatives (bare EOA, ENS-like names) would create a second identity system and a second name grammar.
- **Manifest in the container's site, not in the directory contract.** The manifest is large, changes often, and needs versioning; storing it as a site file makes it cheap to update and lets it inherit the kernel's verification (derived address, length + SHA-256, multi-node agreement) for free. A contract-stored manifest would need its own verification story and would bloat the directory.
- **Delegation instead of holder signing every response.** Holders are cold keys or multisigs; response signing is hot and high-frequency. A time-bounded EIP-712 delegation lets the hot key be rotated by re-publishing the manifest and keeps the holder key off the server. Binding `container` (not `tokenId`) in the struct means the delegation is valid for exactly one derived identity.
- **Directory is a hint, not an authority.** The only trustworthy binding is `(circuits, tokenId) → accountOf → container`. Making step 3 mandatory means a compromised or squatted directory can misdirect but never impersonate.
- **`priceBEM` as a decimal string.** Avoids floating point and keeps the JSON readable; the escrow uses wei.

## 5. Backwards Compatibility

This TAP adds nothing to `SPEC.md`. It does not alter the name grammar `<#ID>.<processor>.tape` or TapeKit's area-coded names for other chains, the container derivation, the file verification rules, or the multi-node agreement rule. Sites that do not use `tape.api` are unaffected. Manifests whose `tapeapi` is not `"0.N"` (N ≥ 1) are rejected by this version.

## 6. Test Vectors

### 6.1 Mainnet manifest

The live manifest of `11.1013.tape`, read only, at one block: the reference SDK's `resolve` ran against its default BSC nodes (`rpcUrlsFor(56)`: NodeReal, Alchemy, 48 Club) with quorum 2 counted by operator, every `eth_call` pinned to the block below with the EIP-1898 `{ blockHash }` parameter, and all three operators returned the same bytes for every call. Raw answers: `sdk/test/fixtures/mainnet-11-1013-manifest.json` (recorder: `scripts/record-mainnet-manifest.mjs`), replayed offline through `resolve` by `sdk/test/mainnet-manifest.test.mjs` and checked independently by `spec/vectors/verify.py`. The delegation is renewed before 2026-12-10 and the manifest changes with it: these values are the state at this block, not the current manifest.

| Item | Value |
|---|---|
| chainId | 56 |
| service | `11.1013.tape` (`https://api.tapeapi.fun`), recorded 2026-09-28 |
| block number | 124552456 |
| block hash | `0xb1699395b13b3f031a277928b862b96c976ec47cddebfe7ccda4fe54bc488a8b` |
| block timestamp | 1790610971 (2026-09-28 15:56:11 UTC) |
| circuits (`cpuAt(1013)`) | `0xe02c26c7432A7121168AA9B610DE24eCf9a1a414` |
| tokenId | `11` |
| container (`accountOf`) | `0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8` |
| `isCPU(circuits)` | `true` |
| holder (`ownerOf`) | `0x086bFB1908B1DF8C0c4412f28E4DD22Bdd52d715` |
| ServiceDirectory | Not deployed (experimental, outside TapeAPI 1.0) |
| manifest path (URL) | `/.well-known/tapeapi.json` |
| manifest registry key | `.well-known/tapeapi.json` |
| `fileInfo.size` | 3414 bytes, `application/json` |
| `fileInfo.sha256Hash` | `0xee57f304f8316802978695e8e9f14e89ce1f9e5c79123b5a583fdcfd3b52c37a` |
| SHA-256 of the manifest bytes (`read`) | `0xee57f304f8316802978695e8e9f14e89ce1f9e5c79123b5a583fdcfd3b52c37a`, equal to `fileInfo.sha256Hash` as §3.6 step 2 requires |
| `fileInfo.updatedAt` | 1790442494 (2026-09-26 17:08:14 UTC) |
| `signer` | `0xaB70dEe8e1CEabb1D10eDFeBcbe0c313c53cf154` |
| `delegation.expires` | 1798190813 (2026-12-25 09:26:53 UTC) |
| delegation check | the §3.4 digest (chainId 56, BNB Chain DeWebHub) recovers to the holder above |
| live read vector (chainId 56, recorded 2026-09-21) | `accountOf(0x50a994e71615474b55559ff4f500928fbc339dd9, 4246)` = `0x86DDaEF00401E3F10418398D67D7189fc458eA95`; `fileInfo(container, "index.html")` = 756 bytes, `text/html; charset=utf-8`, SHA-256 `0xec444c899bd9229f9173082fff362da66dd297179482a58b30b6f53ce9f7a0b6`; `fileInfo(container, "/index.html")` = size 0; `read(container, "/index.html")` reverts `0x2a9df442`. Raw responses: `sdk/test/fixtures/mainnet-4246-index.json` |
| nested-key vector (chainId 56, scanned 2026-09-21) | all 4,400 circuits on processor #0 scanned: 7 sites hold files; every nested key is stored bare, e.g. container `0x19366c3c69ffeb3b286d9fa6cc5e616375baafd3` (circuit 3114, 162 files) lists `assets/basic-BVO4OuW-.js`; 0 of 39 nested keys begin with `/` |

### 6.2 Delegation digest (worked example)

Inputs: `chainId = 56`, `verifyingContract = 0xe61A9C7213a6Aa616C246a2B569e555B417b25ee` (the BNB Chain DeWebHub), `container = 0x0000000000000000000000000000000000000002`, `signer = 0x0000000000000000000000000000000000000003`, `expires = 1790000000`.

| Step | Value |
|---|---|
| `EIP712DOMAIN_TYPEHASH` | `0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f` |
| `keccak256("TapeAPI")` | `0x6f09e044b872e2827cf4fdc5d623450caee9449f1fc4151b8f9e3582593a8802` |
| `keccak256("1")` | `0xc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc6` |
| `DOMAIN_SEPARATOR` | `0xa73ee348b5672f12dbc174f66a7d162c69e0d64befdba88475d9d7e3c0fd3ac7` |
| `DELEGATION_TYPEHASH` | `0xc5081f9dc7e79dfbe7f3b3220ed9e7a29d0bc53239ee74dc184e4ac1f810948c` |
| `structHash` | `0x525ae7f6670fd36175882a96c6f8491af6c83c3ebb4ab51437a9733ecc7dd6da` |
| `digest` | `0xf0ef7315ef455303fb4a7d8a301ca84f25e9fbd0641e931cdb01e7f7e8bcaa9a` |

The same inputs on the other chains (only `chainId` differs; the DeWebHub address is the same on all three):

| chainId | `DOMAIN_SEPARATOR` | `digest` |
|---|---|---|
| 56 | `0xa73ee348b5672f12dbc174f66a7d162c69e0d64befdba88475d9d7e3c0fd3ac7` | `0xf0ef7315ef455303fb4a7d8a301ca84f25e9fbd0641e931cdb01e7f7e8bcaa9a` |
| 196 | `0xf9c5be6dcd7d4cfdf9c57717c7d6a7e04bccd499d2a7f3fcfdc603cc7f1f3ad6` | `0xf4f57ad38c3efd363cbd271e3fc9fa7a54a1302db7f6adcc202a53f8a7cd529a` |
| 8453 | `0xab3b0c6f3cecceb9d441893c56616889d71cf893f74296dc2229a6f241238516` | `0x741c7e6412012f5134d127404641a4eb294c77e30a7b19104aece30efe1be9b9` |

### 6.3 AI price table and amounts (§3.9)

`sdk/test/fixtures/ai-receipt-vectors.json` holds a complete `ai` field (four endpoints, three models with aliases, `formats` and prices in four currencies) and seven receipts made from it, one per case, with the exact request and response bytes, the expected usage and amounts and the signed envelope (TAP-21 §6). `sdk/test/ai-receipt-vectors.test.mjs` regenerates the file with the reference sidecar and requires it to be identical.

Worked amount (case `openai-chat-json`, model `gpt-x`): usage `prompt_tokens` 1200, `cache_read_tokens` 1000, `completion_tokens` 300, `reasoning_tokens` 100.

| Currency | Prices | Sum | Amount |
|---|---|---|---|
| `USDT` | `input` 1.25, `cacheRead` 0.125, `output` 10, `reasoning` 12 | 1.25 × 200 + 0.125 × 1000 + 10 × 200 + 12 × 100 = 3575 | `"0.00357500"` |
| `BEM` | `input` 12.5, `cacheRead` 1.25, `output` 100, no `reasoning` | 12.5 × 200 + 1.25 × 1000 + 100 × 300 = 33750 | `"0.03375000"` |

Without a `reasoning` price, the BEM entry prices all 300 output tokens as `output`.

## 7. Reference Implementation

- SDK: `sdk/` in this repository (`sdk/src/index.js` `resolve` for every input form including names, and `verifyDelegation` for the §3.4 checks against the holder; `sdk/src/manifest.js` schema validation; `sdk/src/sig.js` delegation digest and signature recovery; `sdk/src/rpc.js` quorum reads).
- AI binding (§3.9): `sdk/src/ai.js` (`validateAIField`, `modelEntryOf`, `pricingOf`, `amountOf`), one format adapter per `sdk/src/ai-*.js`, and the signing sidecar `server/src/ai-proxy.js` (example: `examples/ai-proxy/`).
- Contract: `contracts/src/ServiceDirectory.sol`, tests in `contracts/test/`.
- Live (2026-09-27): `https://api.tapeapi.fun` (`11.1013.tape`, source `examples/public-api/`, on `server/`) and `https://relay.tapeapi.fun` (`12.1013.tape`, source `examples/cloudflare-worker/relay-worker.js`) publish TAP-20 manifests with holder delegations; each resolves by name, container or pair.
- ServiceDirectory is not deployed, and nothing here has a third-party audit. Resolution needs no directory: every input form except a label reads only TapeOut's own deployed contracts.

## 8. Security Considerations

- **Holder transfer.** Transferring the circuit does not revoke a published delegation, but it changes `ownerOf`. Because clients recover the delegation signer and compare it to the current holder (§3.6 step 5), a delegation signed by a previous holder becomes invalid at the next resolution. Clients MUST re-check on signature failure and SHOULD re-check periodically.
- **Cross-chain replay.** `chainId` and `verifyingContract` in the domain bind a delegation to one chain. Because the anchor is the DeWebHub rather than a directory, every directory on that chain shares the domain: a delegation names a container and a signer, never a directory, so two directories resolving the same container MUST agree. This is also what allows a service to be used before any directory exists. A forged delegation is still rejected by the on-chain `ownerOf` check.
- **Endpoint transport.** `endpoints.live` MUST be `https://`. TLS protects confidentiality of params and vouchers; it does not authenticate the result, which is why TAP-21 signs it.
- **Signer key compromise.** The holder publishes a new manifest with a new `signer` and a fresh delegation; clients pick it up on the next resolution. Short `expires` limits the window. Providers SHOULD keep `signer` in an isolated process.
- **Label squatting.** Mitigated by `labelFee` and by the fact that truth is keyed by container, not label. A squatted label can point to the squatter's own service but cannot present someone else's container, because step 3 rejects any manifest whose derived container differs.
- **Directory trust.** Clients MUST NOT trust the directory alone. `serviceOf`, `manifestPath`, and events are hints; the manifest, holder, and delegation are always re-derived on-chain.
- **RPC trust.** A single malicious RPC node cannot forge a manifest because of quorum agreement and SHA-256; it can only cause a denial of service. Clients SHOULD use nodes from independent operators.
- **Manifest size and JSON parsing.** The 64 KiB cap and strict schema validation bound parser exposure. Clients SHOULD reject duplicate keys.

## 9. Copyright

Copyright and related rights waived via CC0-1.0.

---

# TAP-20：TapeAPI：服务身份与清单（中文译文）

> 英文为权威文本，本译文与英文章节一一对应。

> **占位编号。** TAP-20 是在 [TapeKit issue #8](https://github.com/TapeOutProtocol/TapeKit/issues/8) 中提议的占位编号。TapeKit 目前还没有编号提案流程（对 TapeOut 本身的修改遵循 TapeKit `SPEC.md` §15），因此维护者可能另行分配编号，或把本文档移入其它流程；见 [TAP-1](TAP-1.md)。

> **实现状态（2026-09-27）：** 无目录运行中：在 BNB Chain 上，`api.tapeapi.fun`（`11.1013.tape`，源码 `examples/public-api/`）与 `relay.tapeapi.fun`（`12.1013.tape`）发布了带持有者委托的 TAP-20 清单，SDK 可按容器、`(circuits, tokenId)` 二元组与名称 `<#ID>.<processor>.tape` 解析。ServiceDirectory（§3.5）未部署，因此标签在主网上无法解析。未经第三方审计。

> **状态：** Stable (v1)（稳定，第 1 版，见 [TAP-1](TAP-1.md) §4.1），自 2026-09-29（TapeAPI 1.0.0）起生效。§3.5（ServiceDirectory）整节为 Experimental（实验性），不在冻结范围内（TAP-1 §4.1 冻结规则第 3 项）。

本文档中的关键词 "MUST"（必须）、"MUST NOT"（禁止）、"REQUIRED"（必需）、"SHALL"、"SHOULD"（应当）、"SHOULD NOT"（不应）、"RECOMMENDED"（推荐）、"MAY"（可以）、"OPTIONAL"（可选）按 RFC 2119 解释。

## 1. 摘要

TapeAPI 允许电路持有者以电路的容器身份发布可被机器调用的服务。本 TAP 定义身份模型（服务 = 电路，容器 = `DeWebHub.accountOf`）、服务清单的位置与结构（`/.well-known/tapeapi.json`，经 SiteRegistry 读取）、持有者授权链下签名密钥的 EIP-712 委托，以及客户端 MUST 遵循的解析算法。响应签名与支付分别由 TAP-21 与 TAP-22 定义。

## 2. 动机

DeWEB 给电路一个网站；TapeSend（TAP-10）给它一个信箱。二者都没有给它一种以可验证、可归属的结果回应结构化请求的方式。今天，链下 API 没有链上身份，DeWEB 站点无法宣告一个 API，客户端也无法检查某个响应是否真的来自名称所指向的一方。

TapeAPI 在不修改协议的前提下填补这一空白：身份是既有容器，发现依赖既有链上文件，验证复用 SPEC §15.1 内核（推导的容器地址、长度 + SHA-256、多节点一致）。诸如 `reader` 之类的人类标签只存在于目录合约中，永不进入名称语法。

## 3. 规范

### 3.1 身份

- **服务**是一个电路：二元组 `(circuits, tokenId)`，其中 `circuits` 为 ERC-721 处理器合约。
- 一个服务只在一条链上：它的电路所在的链。TapeAPI 跟随 TapeOut 到下列各链（地址于 2026-09-28 在链上核对；来源 TapeKit `kernel/src/config.js`）：

| 链 | chainId | 区号 | 处理器工厂 | DeWebHub（代理） | SiteRegistry（代理） |
|---|---|---|---|---|---|
| BNB Smart Chain | 56 | 无 | `0x68224F668083c29e9800Be2a646d42d18cedF7e2` | `0xe61A9C7213a6Aa616C246a2B569e555B417b25ee` | `0xd006ffdd5Ae313B17729621A00999cD3C71CE5e6` |
| X Layer | 196 | 2 | `0x1f09DAeFA827f02CBb40967cc91b259763760761` | `0xe61A9C7213a6Aa616C246a2B569e555B417b25ee` | `0xd6EFb7adCc9c83dC4924Ad56f6a8E4e969b9ADB6` |
| Base | 8453 | 3 | `0x1f09DAeFA827f02CBb40967cc91b259763760761` | `0xe61A9C7213a6Aa616C246a2B569e555B417b25ee` | `0xd6EFb7adCc9c83dC4924Ad56f6a8E4e969b9ADB6` |

- 服务的**容器**为服务所在链上的 `DeWebHub.accountOf(circuits, tokenId)`。客户端 MUST 在该链上自行推导容器，MUST NOT 接受自报的容器。
- **持有者**为验证时刻的 `IERC721(circuits).ownerOf(tokenId)`。
- 服务的链上名称：BNB Smart Chain 上即 SPEC 名称 `<#ID>.<processor>.tape`，其它链上为 `<#ID>.<area>.<processor>.tape`。其中 `#ID` 即 `tokenId`，`processor` 是该链的 TapeOut 处理器工厂列出 `circuits` 所用的编号（TapeKit SPEC §2.2、§3.2），`area` 是该链在上表中的区号（TapeKit `kernel/src/name.js`；`1.2.344.tape` 是 X Layer 上 344 号处理器的 #1）。区号一经分配永不更改、不复用；`0` 与 `1` 保留。本 TAP 不定义新的名称语法。
- 身份不跨链互认。同一个 `(circuits, tokenId)` 在两条链上是两个服务、两个容器（0 号处理器在 X Layer 与 Base 上是同一个合约地址）。客户端 MUST NOT 把一条链上的服务当作另一条链上的同一个服务。
- **标签**是在 ServiceDirectory 合约（§3.5）中注册的 `bytes32` 别名。标签仅为查找便利，不承载任何权威。

### 3.2 清单位置

- 清单 MUST 存于容器 DeWEB 站点的 URL 路径 `/.well-known/tapeapi.json`，内容类型 `application/json`，UTF-8 编码。
- SiteRegistry 的键**不带前导斜杠**（TapeKit SPEC §6 第 3 步在查找前去掉它；主网 `4246.0.tape` 存的是 `index.html`，`fileInfo(container, "/index.html")` 返回 size 0）。因此清单的注册表键是 `.well-known/tapeapi.json`。客户端 MUST 在每次 `read` / `fileInfo` 前去掉前导斜杠。
- 客户端 MUST 通过服务所在链（§3.1）的 SiteRegistry 调用 `SiteRegistry.read(container, ".well-known/tapeapi.json")` 读取，并 MUST 依据同一注册表的 `SiteRegistry.fileInfo(container, path)` 校验返回字节：字节长度 MUST 等于 `size`，`sha256(bytes)` MUST 等于 `sha256Hash`。
- 本 TAP 中所有 `eth_call` MUST 发往至少 `quorum` 个独立配置的 RPC 节点（RECOMMENDED `quorum ≥ 2`），且仅当所有结果逐字节一致时才接受。不一致 MUST 视为失败（`RPC_DISAGREE`），永不以多数决解决。传输失败的节点（超时、HTTP 错误、响应体超限）视为未作答，不算不一致，但 MUST 至少有 `quorum` 个节点作答。一个节点回滚而另一个节点返回值，属于不一致。节点在描述**它自己**的 JSON-RPC 错误——限流（`-32005`）、不支持该方法（`-32601`）、拒绝扫描所要求的区间——属于节点故障，与超时完全一样：该节点没有作答。具体而言，`-32005` 与 `-32601` 是节点故障；`-32000` 的消息若描述区间、结果或大小限制、超时或不支持的方法，也是节点故障，除非消息提到 revert、gas 或 allowance（这些是关于链的回答）。其它 JSON-RPC 错误（尤其是回滚）说的是链，属于结果，节点之间按其 `code` 以及它是否报告回滚（code `3`，或消息提到 revert；除此之外不同节点实现的消息文本各不相同，不参与比较）来比较，使回滚与 `-32000` "header not found" 绝不被当作同一个回答，所有作答节点一致的错误以 `RPC_ERROR` 呈现。为吸收 `latest` 跨区块边界的竞态，客户端 MAY 向全部节点重问一次；重问本身 MUST 全体一致。`eth_blockNumber` 不是 `eth_call`：诚实节点之间会相差一两个区块，因此客户端取至少 `quorum` 个答案中最低的链头，且 SHOULD 拒绝（`RPC_DISAGREE`）超过配置上限的分散（参考实现：64 个区块）。客户端 MUST NOT 在运行时从服务器获取节点列表。
- 清单 MUST NOT 超过 65 536 字节。
- SDK MAY 提供直接接受清单对象或 URL 的开发模式；该模式 MUST 为显式开启（`dev: true`），且 MUST NOT 能从默认配置到达。

### 3.3 清单结构

```json
{
  "tapeapi": "0.1",
  "name": "TapeOut Reader",
  "circuits": "0x...", "tokenId": "4246",
  "container": "0x...",
  "signer": "0x...",
  "delegation": { "expires": 1790000000, "sig": "0x..." },
  "endpoints": { "live": ["https://host/tapeapi/v1"], "async": false },
  "methods": [
    { "name": "blockNumber", "priceBEM": "0", "params": {}, "returns": { "blockNumber": "number" } },
    { "name": "circuitHolder", "priceBEM": "0.0001",
      "params": { "circuits": "address", "tokenId": "string" }, "returns": { "holder": "address" } }
  ],
  "payment": { "escrow": "0x...", "unit": "BEM", "decimals": 8 }
}
```

| 字段 | 类型 | 要求 | 约束 |
|---|---|---|---|
| `tapeapi` | string | MUST | `"MAJOR.MINOR"`，本版本为 `"0.1"`。客户端 MUST 接受任意 N ≥ 1（无前导零）的 `"0.N"`，MUST 拒绝其它主版本。次版本只新增可选字段：客户端 MUST 忽略不认识的字段，MUST NOT 因此拒绝清单，并仍执行其所实现次版本的全部规则。 |
| `name` | string | MAY | ≤ 64 个 UTF-8 码点。仅用于展示。 |
| `circuits` | address | MUST | 校验和或小写十六进制，20 字节。 |
| `tokenId` | string | MUST | 十进制，无前导零，可容纳于 `uint256`。 |
| `container` | address | MUST | MUST 等于 `DeWebHub.accountOf(circuits, tokenId)`。 |
| `signer` | address | MUST | 签署 TAP-21 响应的 secp256k1 地址。 |
| `delegation` | object | MUST | `{ "expires": uint64, "sig": hex65 }`（合约持有者的 `sig` MAY 更长，§3.4）。即使 `signer` 等于持有者也必须提供，使每份清单都携带一份新鲜、会过期的持有者授权证明。 |
| `endpoints` | object | MUST | `{ "live": string[], "async": boolean }`。 |
| `endpoints.live` | string[] | MUST | 零个或多个不含 query 与 fragment 的绝对 `https://` URL。提供者 SHOULD 最多列出 4 个。 |
| `endpoints.async` | boolean | MUST | `true` 表示服务接受经其 TAP-10（TapeSend）收件箱、以 `container` 为收件人的请求。`live` 非空或 `async == true` 至少 MUST 满足其一。 |
| `methods` | array | MUST | 非空。方法名 MUST 唯一。 |
| `mcp` | object | MAY | 服务作为 MCP 服务器提供的工具，以摘要钉住；见 §3.8。 |
| `ai` | object | MAY | 服务的 AI 接口端点与公示价目表，其回答带签名的用量回执（TAP-21 §3.5）；见 §3.9。 |
| `payment` | object | MUST* | `{ "escrow": address, "unit": "BEM", "decimals": 8 }`。*任一 `priceBEM != "0"` 时 REQUIRED，此时 `escrow` 为非零地址（零地址托管结算不了任何东西）。`unit` 与 `decimals` 都是固定值，不携带信息：二者均可省略，省略时按 `"BEM"` 与 `8` 读取；任何其它值无效。 |

方法描述符：

| 字段 | 类型 | 要求 | 约束 |
|---|---|---|---|
| `name` | string | MUST | `^[A-Za-z_][A-Za-z0-9_]{0,63}$`，且不得为 `__proto__`、`constructor` 或 `prototype`：TAP-21 §3.1 在任何位置都禁止这些键，任何处理器表都无法安全地容纳它们。 |
| `priceBEM` | string | MUST | 十进制字符串，≥ 0，最多 8 位小数，无指数。以 BEM（`0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a`，**8 位小数**——2026-09-21 链上核实；按 18 计算会差 10^10 倍）计。`"0"` 表示免费。 |
| `params` | object | MUST | 参数名 → 类型名的映射。类型名仅供参考；线上格式为 JSON。MAY 为 `{}`。 |
| `returns` | object | MUST | 字段名 → 类型名的映射。仅供参考。 |
| `description` | string | MAY | ≤ 256 码点。 |

客户端 MUST 忽略未知字段。违反上述任一 MUST 的清单为 `MANIFEST_INVALID`。

### 3.4 委托

持有者以 EIP-712 签名授权 `signer`。

- 域：`EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)`，其中 `name = "TapeAPI"`、`version = "1"`、`chainId` 为服务所在链的 chainId、`verifyingContract` 为该链的 DeWebHub 代理（§3.1）。
- DeWebHub 代理在每条链上地址相同，因此只靠 chainId 区分各链的域：为一条链签的委托在其它每条链上都是另一个摘要，验证方在那里 MUST NOT 接受它。将来加入 §3.1 而没有 DeWebHub 的链需要自己的 verifyingContract，由加入该链的 TAP 指定。
- 主类型：`Delegation(address container,address signer,uint64 expires)`。
- `DELEGATION_TYPEHASH = keccak256("Delegation(address container,address signer,uint64 expires)") = 0xc5081f9dc7e79dfbe7f3b3220ed9e7a29d0bc53239ee74dc184e4ac1f810948c`。
- `structHash = keccak256(abi.encode(DELEGATION_TYPEHASH, container, signer, expires))`。
- `digest = keccak256(0x1901 ‖ DOMAIN_SEPARATOR ‖ structHash)`。
- `sig` 为 65 字节 `r ‖ s ‖ v`，`v ∈ {27, 28}`（值为 0 或 1 的 `v` 先规范化为 27 或 28，与 TAP-21 §3.3 相同），`s` 位于低半阶。恢复出的地址 MUST 等于验证时刻的持有者，除非持有者是认可该 `sig` 的合约（见下）。`expires` MUST 严格大于验证方当前 Unix 时间。验证方 SHOULD 拒绝超过未来 366 天的 `expires`。同一上限对 TAP-26 通道记录是 MUST，这是有意为之：通道身份必须会失效，而服务委托随清单一起续期。
- **合约持有者。** 客户端 MAY 按 EIP-1271 接受由合约持有者签发的委托：对持有者调用 `isValidSignature(digest, sig)` MUST 返回完整的 32 字节字 `0x1626ba7e` 后接零。此时委托的 `sig` 可以长于 65 字节。参考 SDK 把 65 字节的 `sig` 当作 ECDSA（先恢复签名，格式错误的签名在尝试 EIP-1271 之前就被拒绝），更长的 `sig`（与 TAP-26 通道记录相同，至多 1024 字节）直接交给 EIP-1271。参考 ServiceDirectory 只验证 ECDSA，因此在该合约加入 EIP-1271 之前，合约持有者的委托只被客户端接受。
- `ServiceDirectory.verifyDelegation(circuits, tokenId, signer, expires, sig)` MUST 实现本节中 MUST 级别的检查（366 天上限是客户端的 SHOULD，链上不强制），客户端 MAY 用它代替本地恢复；无论哪种方式，持有者 MUST 从链上读取，永不取自清单。

### 3.5 ServiceDirectory

> **实验性。** 本节按 [TAP-1](TAP-1.md) §4.1（冻结规则第 3 项）标为 Experimental（实验性）：ServiceDirectory 合约尚未部署、未经审计，本节可能不兼容地修改或撤回，且不需要新版本。本节不在 Stable (v1) 的冻结范围内，用到它的地方也一样：§3.6 第 1 步以标签作输入、本节末尾可选的 `serviceOf` 比对，以及 §3.4 中的 `ServiceDirectory.verifyDelegation`。本文其余部分不依赖本节：按名称、容器或 `(circuits, tokenId)` 解析（§3.6）不需要目录。

每条链上一个不可升级的合约，将标签映射到容器并记录清单路径。构造参数为 `(hub, factory, domainBinding)`；`factory` 为 TapeOut 处理器工厂，`domainBinding` MAY 为零地址以关闭激活门槛。

- `register` MUST 拒绝 `factory.isCPU(circuits)` 为假的任何 `circuits`，使伪造的 ERC-721 无法占用标签。
- `register` MUST 经 `DeWebHub.accountOf` 推导容器，且 MUST 拒绝已被不同容器持有的标签。
- `register` 与 `update` MUST 由当前持有者调用。`ownerOf` 回滚或未返回地址（电路已销毁）MUST 视为"没有持有者"，调用因此被拒绝（参考合约以 `NotHolder()` 回滚），绝不视为已授权，也绝不把电路合约自己的回滚原样抛出。
- 配置了 `domainBinding` 时，占用非零标签 MUST 要求 `isContainerLive(container)`。存活查询回滚、返回少于 32 字节、或返回非 `1` 的任何值，MUST 一律视为未激活。
- `release` 通常仅限持有者；当电路已销毁而无持有者时，任何人 MAY 释放该标签，以免其永久锁死。
- 非零标签 MAY 收取 `labelFee`。客户端 MUST 先读取 `labelFee()` 并精确附带该金额，或不附带：
  目录在所有分支下都会保留随交易附带的金额，超出部分会被静默且永久地没收。参考部署的费率
  以及是否配置激活门槛，随其地址一并公布。
- `manifestPath` 仅供参考。客户端 MUST NOT 用它做解析（§3.6 始终读取 `.well-known/tapeapi.json`），任何确实把它交给 SiteRegistry 的代码 MUST 先去掉前导斜杠（§3.2）。参考 SDK 注册的是注册表键形式 `.well-known/tapeapi.json`。

完整接口见 `contracts/src/ServiceDirectory.sol`。目录只是提示：除 `label → container` 映射外，客户端不信任来自目录的任何内容，且即便该映射也仅按 §3.6 算法使用。配置了目录的客户端 MAY 另外把目录中该容器的记录（`serviceOf`）与清单的 `(circuits, tokenId)` 比较，并以 `MANIFEST_INVALID` 拒绝不一致（参考 SDK 这样做）；目录是在中枢上推导容器的，不一致意味着目录本身有问题。没有记录的容器，或 `serviceOf` 回滚的目录，不会阻塞解析。

### 3.6 解析算法

输入：标签、TapeOut 名称 `<#ID>.<processor>.tape` 或 `<#ID>.<area>.<processor>.tape`、容器地址或 `(circuits, tokenId)` 二元组。输出：`{ manifest, container, verified: { delegation, holder } }` 或错误。

1. **定位。** 若输入为标签，`container = ServiceDirectory.resolve(label)`；零地址 → `NOT_FOUND`。若输入为 `(circuits, tokenId)`，`container = DeWebHub.accountOf(circuits, tokenId)`。若输入为 TapeOut 名称 `<#ID>.<processor>.tape`（规范形式见 TapeKit SPEC §2.2：两部分均为十进制、除 `0` 本身外无前导零、全小写、`#ID ≥ 1`；客户端 MAY 另外接受不带后缀的 `<#ID>.<processor>`，TapeKit SPEC §2.4 允许地址栏把它当作同一名称接受），则完全按 TapeKit SPEC §3.2 的方式解析：先在 TapeOut 处理器工厂（见步骤 3）上取 `circuits = factory.cpuAt(processor)`，再取 `container = DeWebHub.accountOf(circuits, #ID)`；处理器编号超出最后一个（`cpuAt` 回滚）→ `NOT_FOUND`。这种形式的字符串是名称，永远不是标签，也不在任何目录中查找。看起来像名称但不符合该形式的字符串（前导零、大写的 `.TAPE`、`#ID` 为 0）MUST 被拒绝而不是猜测，也不作为标签查找，使任何标签都无法抢注某个名称的写法。TapeKit 的其它地址栏形式（`#4246@0`、`tape://4246.0.tape/`）不是本算法的输入：外壳先把它们转换成规范名称，参考 SDK 则像对待非规范写法一样拒绝它们。若输入为容器，按原样使用。

   **链。** `(circuits, tokenId)` 二元组或容器本身不指明链；客户端在随它给出的链上解析，否则在客户端自己配置的链上解析。TapeOut 名称由区号选择链：不带区号的是 BNB Smart Chain。区号为保留值或不在 §3.1 中的名称 MUST 像其它非规范写法一样被拒绝，也不作为标签查找。之后每一步（清单、`accountOf`、该链工厂上的 `isCPU`、`ownerOf`、委托）都在选定的链上进行，`eth_call` 发往该链的节点。客户端 SHOULD 告诉用户服务在哪条链上。

   名称形式在 `(circuits, tokenId)` 路径之外不增加任何信任：它只是用按 §3.2 进行的链上读取算出这一二元组，步骤 2–5 照常执行，因此步骤 3 仍会用清单自己的 `(circuits, tokenId)` 重新推导容器并检查 `isCPU`。
2. **读取清单。** 先 `fileInfo(container, path)` 再 `read(container, path)`，二者均需法定人数一致（§3.2）。校验长度与 SHA-256。解析 JSON；按 §3.3 校验。失败 → `MANIFEST_INVALID`。
3. **推导。** `derived = DeWebHub.accountOf(manifest.circuits, manifest.tokenId)`。除非 `derived == manifest.container == container`，客户端 MUST 拒绝；且除非 服务所在链的 TapeOut 处理器工厂（§3.1；chainId 56 上为 `0x68224F668083c29e9800Be2a646d42d18cedF7e2`）对 `isCPU(manifest.circuits)` 回答 `true`，客户端 MUST 拒绝：`accountOf` 对任何 ERC-721 都能推导出地址，没有这一检查，任何人都能部署一个仿冒的代币合约，把它的账户当作 TapeOut 容器出示（TapeKit SPEC §3.3 第 2 步）。失败 → `MANIFEST_INVALID`。
4. **持有者。** `holder = IERC721(manifest.circuits).ownerOf(manifest.tokenId)`。回滚 → `MANIFEST_INVALID`。
5. **委托。** `manifest.delegation` MUST 存在（§3.3）。以 `signer = manifest.signer` 按 §3.4 验证；恢复出的地址 MUST 等于 `holder`（或 `holder` 按 EIP-1271 认可该签名，§3.4），且 `expires` MUST 尚未过期。失败 → `DELEGATION_INVALID`。
6. **返回**，`verified.delegation = true`，`verified.holder = holder`。

客户端 MAY 缓存结果，且被缓存的服务 MUST 保持可重读：无法回到解析来源的客户端，实现不了本段其余要求。

重读 MUST 从**步骤 2** 开始（经 SiteRegistry 重新读取清单文件），一直做到步骤 5。只重跑步骤 4–5 对清单过期引发的任何故障都是空操作：那两步读的是缓存清单自己的 `signer` 与 `delegation`，因此照样通过，而缓存中的 `methods`、价格和端点仍然是旧的。本段的早期草案正是这么写的，参考 SDK 也因此继承了一个永久死锁：提供者涨价之后，持旧清单的消费者会永远重签同一张不足额的凭证。

当 TAP-21 响应签名验证失败时，当提供者以一个与缓存不同的 `price` 拒绝凭证时（TAP-22 §3.2），以及当缓存中免费的方法被回以 `PAYMENT_REQUIRED` 时（它现在收费了），客户端 MUST 重读。对超过一小时的清单，客户端 SHOULD 在按它付款前重读。提供者报出的价格（`data.price`）只是触发重读的提示，永不具有权威性：客户端支付的价格 MUST 是它自己从链上读到的那个。

**价格同意。** 客户端 MUST NOT 为某方法支付高于其调用方已同意价格的每次调用价格。得知（经重读）更高的价格时，除非调用方给出了不低于新价格的 `maxPrice` 或显式接受了新价格，否则 MUST 以客户端错误码 `PRICE_CHANGED`（`data: { method, accepted, price }`）失败。更低的价格 MAY 静默采用。

对任何输入形式（包括来自目录的标签），客户端 MUST NOT 跳过步骤 3。

### 3.7 外壳能力（`tape.api`）

外壳（preview 或 gateway）MAY 向运行于真实源下的站点暴露 `tape.api` 对象，代站点实现 §3.6 与 TAP-21。适用以下规则：

- 经 `tape.api` 的调用会到达某个 `endpoints.live` URL，因此是 SPEC §7 意义下的链下请求。外壳 MUST 在首次调用前施加 §7.5 的按站点授权，且 MUST 默认阻止。
- 使用 `tape.api` 的站点含有链下引用，MUST NOT 展示 SPEC §8 的"100% 链上"徽章。
- 未来的 Core TAP MAY 为"唯一链下流量是签名已验证的 TAP-20/21 流量"的站点定义"已验证服务"徽章等级。该等级明确不在本 TAP 范围内，且 MUST NOT 由本 TAP 推断得出。
- 按源隔离（§7）不变：`tape.api` MUST NOT 允许一个站点观察另一站点的调用、授权或凭证。

### 3.8 MCP 绑定（`mcp`）

方法即某个 Model Context Protocol（MCP）服务器工具的服务，MAY 用可选的 `mcp` 对象声明这一点：

```json
"mcp": { "endpoint": "https://mcp.example.com/mcp", "toolsSha256": "<64 位小写十六进制>" }
```

- `endpoint` MUST 是不含 query 与 fragment 的绝对 `https://` URL，服务在此以 Streamable HTTP 应答 MCP。
- `toolsSha256` MUST 是工具列表 RFC 8785 规范 JSON 的 SHA-256（64 位小写十六进制）：每个工具只保留它具有的 `name`、`title`、`description`、`inputSchema`、`outputSchema` 与 `annotations` 成员，列表按 `name` 的 UTF-16 码元顺序排序，名称唯一。
- 使用 MCP 端点的客户端 MUST 对收到的 `tools/list` 结果计算该摘要，并在它与 `toolsSha256` 不同时 MUST 拒绝该服务的工具。客户端 SHOULD 钉住该值，把之后的变化视为需要用户同意的服务变更。
- 以工具命名的清单方法 MUST 调用该工具：`POST <live>/<name>`，以工具参数作为 `params`，TAP-21 的 `result` 是该工具去掉 `_meta` 的 MCP 结果。工具错误（`isError: true`）仍是 `ok: true`：签名证明的是工具如何作答。
- 上游工具定义不再与 `toolsSha256` 相符的提供者 MUST 以签名错误拒绝每次调用，直到持有者发布新的清单。
- `toolsSha256` 约束的是定义而不是行为：同一套定义下服务器仍可能给出不同回答。签名结果让这种情况可以追责，而不是不可能发生。

### 3.9 AI 服务绑定（`ai`）

运营 AI 接口的服务（网关、聚合商、自建模型的团队）MAY 用可选的 `ai` 对象发布接口端点与价目表。调用方照旧使用该接口格式的官方 SDK，只把 base URL 指向服务；每个回答都带一份由清单 `signer` 签名的用量回执（TAP-21 §3.5），客户端对照本字段核验。

```json
"ai": {
  "endpoints": [
    { "format": "openai-chat", "baseUrl": "https://ai.example/v1" },
    { "format": "anthropic-messages", "baseUrl": "https://ai.example" }
  ],
  "models": [
    { "id": "gpt-x", "aliases": ["gpt-x-2026-09-01"], "formats": ["openai-chat"], "prices": [
      { "currency": "USDT", "unit": "1M tokens", "input": "1.25", "output": "10", "cacheRead": "0.125", "reasoning": "12" },
      { "currency": "BEM", "unit": "1M tokens", "input": "12.5", "output": "100", "cacheRead": "1.25" } ] },
    { "id": "claude-x", "formats": ["anthropic-messages"], "prices": [
      { "currency": "BEM", "unit": "1M tokens", "input": "3", "output": "15", "cacheRead": "0.3", "cacheWrite": "3.75", "cacheWrite1h": "6" } ] }
  ]
}
```

**端点。**

| 字段 | 类型 | 要求 | 约束 |
|---|---|---|---|
| `endpoints` | array | MUST | 1 到 16 项，每种 `format` 至多一项。 |
| `endpoints[].format` | string | MUST | `^[a-z][a-z0-9-]{0,63}$`。本版本的格式见下表。客户端 MUST 忽略它不认识的格式的端点，使以后的格式（例如 Gemini）加入时不影响旧客户端。 |
| `endpoints[].baseUrl` | string | MUST | 绝对 `https://` URL（仅在 §3.2 的开发模式下可为 `http://`），不含 query、fragment 与用户信息。末尾斜杠没有含义，使用前去掉。 |

`baseUrl` 就是调用方在该格式官方 SDK 里配置的地址：**服务根**加上该格式的后缀。某格式的请求发往服务根加该格式的路径，该路径也就是其回执所写的 `path`（TAP-21 §3.5）。对下表中的格式，客户端 MUST 忽略 `baseUrl` 不以该格式后缀结尾的端点。

| 格式 | 接口 | 带回执的请求 | `baseUrl` | 请求模型 |
|---|---|---|---|---|
| `openai-chat` | OpenAI Chat Completions | `POST /v1/chat/completions` | 根 + `/v1` | 请求体的 `model` |
| `openai-responses` | OpenAI Responses | `POST /v1/responses`、`POST /v1/responses/compact` | 根 + `/v1` | 请求体的 `model` |
| `anthropic-messages` | Anthropic Messages | `POST /v1/messages` | 根本身（Anthropic 的 SDK 自己加 `/v1`） | 请求体的 `model` |
| `openai-embeddings` | OpenAI Embeddings | `POST /v1/embeddings` | 根 + `/v1` | 请求体的 `model` |

根之下的其它路径（`/v1/models`、`/v1/messages/count_tokens` 等）MAY 提供服务；它们没有回执，也没有价格。

**模型。**

| 字段 | 类型 | 要求 | 约束 |
|---|---|---|---|
| `models` | array | MUST | 1 到 256 项。 |
| `models[].id` | string | MUST | 接口报告的模型名：1 到 256 个 UTF-16 码元，不含控制字符（U+0000–U+001F、U+007F–U+009F）。 |
| `models[].aliases` | string[] | MAY | 同一条目的 1 到 16 个其它名称，每个都按 `id` 的规则。 |
| `models[].formats` | string[] | MAY | 非空、互不重复的格式列表，每项都是 `endpoints` 中某项的 `format`。给出时，该条目只为这些格式的回答定价；省略时为所有格式定价。 |
| `models[].prices` | array | MUST | 1 到 7 个价格条目，每个币种一个。早期草案中单数的 `price` 不是字段：带有它的模型条目无效。 |

每个 `id` 与每个别名在整张表中（id 与别名合并计算）MUST 至多出现一次，使一个模型名至多选中一个条目。

价格条目：

| 字段 | 类型 | 要求 | 约束 |
|---|---|---|---|
| `currency` | string | MUST | `BEM`、`BNB`、`USDT`、`USDC`、`ETH`、`USD1`、`USD` 之一；在同一模型的价格条目中唯一。 |
| `unit` | string | MUST | `"1M tokens"`：条目中每个价格都按每 1 000 000 个 token 计。 |
| `input` | decimal | MUST | 既非缓存读也非缓存写的输入 token。 |
| `output` | decimal | MUST | 输出 token；未给出 `reasoning` 时也包括推理 token。 |
| `cacheRead` | decimal | MAY | 从提示缓存读取的输入 token。缺省：`input`。 |
| `cacheWrite` | decimal | MAY | 写入提示缓存的输入 token。缺省：`input`。 |
| `cacheWrite1h` | decimal | MAY | 保留一小时的缓存写入（Anthropic 的 1 小时缓存）。缺省：`cacheWrite`，再缺省为 `input`。 |
| `reasoning` | decimal | MAY | 用于推理的输出 token。省略时推理 token 按 `output` 计价。 |

**decimal** 是匹配 `^(0|[1-9][0-9]{0,17})(\.[0-9]{1,8})?$` 的 JSON 字符串：至多 18 位整数且无前导零，至多 8 位小数，无符号、无指数、无空白。小数点后的末尾零没有含义（`"0.30"` 即 `"0.3"`）。

**币种。** `BEM` 是 §3.3 所述代币（8 位小数）。`BNB` 是 BNB Chain 的原生币，`USDT`、`USDC`、`ETH` 与 `USD1` 指 BNB Chain 上的这些代币。`USD` 是仅供展示的币种，背后没有代币。一个模型各价格条目的顺序会保留在其回执中，除此之外没有含义。

**价格只是公示，不结算。** 价目表陈述提供者声称的收费，任何人都能据此重算回执所声称的金额；本 TAP 中没有任何东西转移资金，回执里的金额是可以核对的声明，不是付款。按 token 结算属于 TAP-22 的下一个托管版本；在那之前，提供者照旧按自己的方式计费（自己的密钥、自己的账户）。`methods` 的 `priceBEM` 与此无关：`ai` 的价格只适用于格式表中的请求。

**校验。** 使用本字段的客户端 MUST 校验整个字段，并在它违反本节任一 MUST 时 MUST 拒绝使用它（`MANIFEST_INVALID`）。清单的其余部分不受影响，不使用本字段的客户端忽略它（§3.3）。

**模型匹配。** 一个条目没有 `formats`，或其 `formats` 列出了某格式时，称它对该格式*可用*。为某个回答定价的条目，是其 `id` 或某个 `aliases` 等于上游接口在回答中**报告**的模型（各格式在哪里报告见 TAP-21 §3.5）的可用条目：按字符串逐个码元相等，不做大小写折叠、不做 Unicode 规范化、不做前缀或模式匹配。只有回答没有报告模型时（没有，或不是 1 到 256 个码元的字符串），才以同样方式匹配格式表中的请求模型；此时回执写的是这个请求的模型，并注明 `modelMatchedBy: "request"`。没有条目匹配时，该回答不定价。提供者与客户端 MUST 恰好按这条规则匹配：任何别的匹配方式都会让一方为某份回执定了价，另一方却不定价或定出不同的价。

**用量。** 回执用一个对象报告 token 数，所有格式相同（TAP-21 §3.5 把各格式自己的计数映射到它上面）：

| 成员 | 要求 | 含义 |
|---|---|---|
| `prompt_tokens` | MUST | 全部输入 token，含缓存读与缓存写。 |
| `completion_tokens` | MUST | 全部输出 token，含推理；没有输出 token 的格式（embeddings）为 `0`。 |
| `total_tokens` | MUST | 接口报告的值，否则为 `prompt_tokens + completion_tokens`。 |
| `cache_read_tokens` | MAY | 从缓存读取的输入 token：`prompt_tokens` 的子集。 |
| `cache_write_tokens` | MAY | 写入缓存的输入 token：`prompt_tokens` 的子集。 |
| `cache_write_1h_tokens` | MAY | 保留一小时的缓存写入：`cache_write_tokens` 的子集。 |
| `reasoning_tokens` | MAY | 用于推理的输出 token：`completion_tokens` 的子集。 |
| `other` | MAY | `{ 名称: 次数 }`：按次而不是按 token 计费的计数，例如 `web_search_requests`。名称匹配 `^[a-z][a-z0-9_]{0,63}$`，次数大于 0，成员按名称排序，为空时整个对象省略。 |

- 可选计数恰在接口报告了它时出现；报告的 `0` 也出现。
- 每个计数都是 0 到 2^53 − 1 的整数，成员 MUST 按上表的顺序出现。
- `cache_read_tokens + cache_write_tokens ≤ prompt_tokens`、`cache_write_1h_tokens ≤ cache_write_tokens`、`reasoning_tokens ≤ completion_tokens`。违反其中任何一条的计数，或没有报告输入 token 的回答，没有用量（`null`），因此也没有价格。

**金额。** 对匹配模型的每个价格条目 `p` 与用量 `u`，缺失的计数一律按 0：

```
cr = u.cache_read_tokens    cw = u.cache_write_tokens    cw1h = u.cache_write_1h_tokens
rs = 给出了 p.reasoning 时为 u.reasoning_tokens，否则为 0

sum =  p.input        × (u.prompt_tokens − cr − cw)
     + p.cacheRead    × cr                              缺省 p.input
     + p.cacheWrite   × (cw − cw1h)                     缺省 p.input
     + p.cacheWrite1h × cw1h                            缺省 p.cacheWrite，再缺省 p.input
     + p.output       × (u.completion_tokens − rs)
     + p.reasoning    × rs

amount = sum / 1 000 000，向上取整到 8 位小数
```

- 各分桶互不重叠：每个 token 恰好计价一次。
- 运算 MUST 精确：每个价格读作 10^-8 单位的整数，每个乘积与总和都是整数，总和除以 1 000 000 后**向上**取整到 10^-8 单位的整数，只取整**一次**、对总和取整，绝不按分桶取整。MUST NOT 使用浮点数。
- 金额写成十进制字符串，至少一位整数、恰好 8 位小数（`"0.00357500"`、`"12.00000000"`）。
- 按次计费的计数（`other`）没有 token 价：计 0，并在回执的 `unpriced` 中列出名称。
- 匹配到的条目为每个价格条目给出一个金额，顺序与条目相同。没有匹配条目或没有用量，就没有金额。没有完成的回答按它报告的用量定价。

## 4. 原理

- **以电路为身份。** 电路可转让，已经拥有容器、DeWEB 站点与 TapeSend 收件箱，且是用户已经认识的单位。因此每个服务都消耗一个电路，这使提供者的激励与协议对齐，而非与一个平行注册表对齐。替代方案（裸 EOA、类 ENS 名称）会产生第二套身份系统与第二套名称语法。
- **清单存于容器站点而非目录合约。** 清单体积大、变更频繁、需要版本化；作为站点文件存储使更新廉价，并免费继承内核的验证（推导地址、长度 + SHA-256、多节点一致）。存于合约的清单需要自己的验证机制，并会使目录膨胀。
- **委托而非持有者签署每个响应。** 持有者是冷钥或多签；响应签名是热的、高频的。带时限的 EIP-712 委托允许通过重新发布清单来轮换热钥，并使持有者密钥远离服务器。在结构体中绑定 `container`（而非 `tokenId`）意味着委托恰好对一个推导身份有效。
- **目录是提示而非权威。** 唯一可信的绑定是 `(circuits, tokenId) → accountOf → container`。强制步骤 3 意味着被攻破或被抢注的目录只能误导，永远不能冒充。
- **`priceBEM` 为十进制字符串。** 避免浮点数并保持 JSON 可读；托管合约使用 wei。

## 5. 向后兼容

本 TAP 不向 `SPEC.md` 添加任何内容。不改变名称语法 `<#ID>.<processor>.tape` 与 TapeKit 为其它链定义的带区号名称、容器推导、文件校验规则或多节点一致规则。不使用 `tape.api` 的站点不受影响。`tapeapi` 不是 `"0.N"`（N ≥ 1）的清单会被本版本拒绝。

## 6. 测试向量

### 6.1 主网清单

`11.1013.tape` 的线上清单，只读，钉在一个区块上：参考 SDK 的 `resolve` 使用其默认 BSC 节点（`rpcUrlsFor(56)`：NodeReal、Alchemy、48 Club），按运营方计法定数 2；每个 `eth_call` 都用 EIP-1898 的 `{ blockHash }` 参数钉在下表的区块上，三家运营方对每个调用返回的字节完全相同。原始回答：`sdk/test/fixtures/mainnet-11-1013-manifest.json`（录制脚本 `scripts/record-mainnet-manifest.mjs`），由 `sdk/test/mainnet-manifest.test.mjs` 离线回放经 `resolve`，并由 `spec/vectors/verify.py` 独立核对。委托在 2026-12-10 之前续期，清单随之改变：以下数值是该区块上的状态，不是当前的清单。

| 项目 | 值 |
|---|---|
| chainId | 56 |
| 服务 | `11.1013.tape`（`https://api.tapeapi.fun`），2026-09-28 录制 |
| 区块号 | 124552456 |
| 区块哈希 | `0xb1699395b13b3f031a277928b862b96c976ec47cddebfe7ccda4fe54bc488a8b` |
| 区块时间戳 | 1790610971（2026-09-28 15:56:11 UTC） |
| circuits（`cpuAt(1013)`） | `0xe02c26c7432A7121168AA9B610DE24eCf9a1a414` |
| tokenId | `11` |
| container（`accountOf`） | `0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8` |
| `isCPU(circuits)` | `true` |
| 持有者（`ownerOf`） | `0x086bFB1908B1DF8C0c4412f28E4DD22Bdd52d715` |
| ServiceDirectory | 未部署（实验性，不在 TapeAPI 1.0 范围内） |
| 清单路径（URL） | `/.well-known/tapeapi.json` |
| 清单注册表键 | `.well-known/tapeapi.json` |
| `fileInfo.size` | 3414 字节，`application/json` |
| `fileInfo.sha256Hash` | `0xee57f304f8316802978695e8e9f14e89ce1f9e5c79123b5a583fdcfd3b52c37a` |
| 清单字节（`read`）的 SHA-256 | `0xee57f304f8316802978695e8e9f14e89ce1f9e5c79123b5a583fdcfd3b52c37a`，与 `fileInfo.sha256Hash` 相同，符合 §3.6 步骤 2 的要求 |
| `fileInfo.updatedAt` | 1790442494（2026-09-26 17:08:14 UTC） |
| `signer` | `0xaB70dEe8e1CEabb1D10eDFeBcbe0c313c53cf154` |
| `delegation.expires` | 1798190813（2026-12-25 09:26:53 UTC） |
| 委托核对 | §3.4 摘要（chainId 56，BNB Chain 的 DeWebHub）恢复出上表的持有者 |
| 主网读取向量（chainId 56，2026-09-21 记录） | `accountOf(0x50a994e71615474b55559ff4f500928fbc339dd9, 4246)` = `0x86DDaEF00401E3F10418398D67D7189fc458eA95`；`fileInfo(container, "index.html")` = 756 字节、`text/html; charset=utf-8`、SHA-256 `0xec444c899bd9229f9173082fff362da66dd297179482a58b30b6f53ce9f7a0b6`；`fileInfo(container, "/index.html")` = size 0；`read(container, "/index.html")` 回滚 `0x2a9df442`。原始响应见 `sdk/test/fixtures/mainnet-4246-index.json` |
| 嵌套键向量（chainId 56，2026-09-21 扫描） | 扫描处理器 #0 全部 4,400 枚电路：7 个站点有文件；所有嵌套键均为裸键，例如容器 `0x19366c3c69ffeb3b286d9fa6cc5e616375baafd3`（电路 3114，162 个文件）列出 `assets/basic-BVO4OuW-.js`；39 个嵌套键中 0 个以 `/` 开头 |

### 6.2 委托摘要（完整算例）

输入：`chainId = 56`、`verifyingContract = 0xe61A9C7213a6Aa616C246a2B569e555B417b25ee`（BNB Chain 上的 DeWebHub）、`container = 0x0000000000000000000000000000000000000002`、`signer = 0x0000000000000000000000000000000000000003`、`expires = 1790000000`。

| 步骤 | 值 |
|---|---|
| `EIP712DOMAIN_TYPEHASH` | `0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f` |
| `keccak256("TapeAPI")` | `0x6f09e044b872e2827cf4fdc5d623450caee9449f1fc4151b8f9e3582593a8802` |
| `keccak256("1")` | `0xc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc6` |
| `DOMAIN_SEPARATOR` | `0xa73ee348b5672f12dbc174f66a7d162c69e0d64befdba88475d9d7e3c0fd3ac7` |
| `DELEGATION_TYPEHASH` | `0xc5081f9dc7e79dfbe7f3b3220ed9e7a29d0bc53239ee74dc184e4ac1f810948c` |
| `structHash` | `0x525ae7f6670fd36175882a96c6f8491af6c83c3ebb4ab51437a9733ecc7dd6da` |
| `digest` | `0xf0ef7315ef455303fb4a7d8a301ca84f25e9fbd0641e931cdb01e7f7e8bcaa9a` |

同一输入在其它链上（只有 `chainId` 与 `verifyingContract` 所在链不同；三条链的 DeWebHub 地址相同）：

| chainId | `DOMAIN_SEPARATOR` | `digest` |
|---|---|---|
| 56 | `0xa73ee348b5672f12dbc174f66a7d162c69e0d64befdba88475d9d7e3c0fd3ac7` | `0xf0ef7315ef455303fb4a7d8a301ca84f25e9fbd0641e931cdb01e7f7e8bcaa9a` |
| 196 | `0xf9c5be6dcd7d4cfdf9c57717c7d6a7e04bccd499d2a7f3fcfdc603cc7f1f3ad6` | `0xf4f57ad38c3efd363cbd271e3fc9fa7a54a1302db7f6adcc202a53f8a7cd529a` |
| 8453 | `0xab3b0c6f3cecceb9d441893c56616889d71cf893f74296dc2229a6f241238516` | `0x741c7e6412012f5134d127404641a4eb294c77e30a7b19104aece30efe1be9b9` |

### 6.3 AI 价目表与金额（§3.9）

`sdk/test/fixtures/ai-receipt-vectors.json` 含一个完整的 `ai` 字段（四个端点，三个模型，带别名、`formats` 与四个币种的价格），以及据此生成的七份回执，每个用例一份，附确切的请求与回应字节、期望的用量与金额以及签名信封（TAP-21 §6）。`sdk/test/ai-receipt-vectors.test.mjs` 用参考旁路重新生成该文件，并要求与之完全一致。

金额算例（用例 `openai-chat-json`，模型 `gpt-x`）：用量 `prompt_tokens` 1200、`cache_read_tokens` 1000、`completion_tokens` 300、`reasoning_tokens` 100。

| 币种 | 价格 | 总和 | 金额 |
|---|---|---|---|
| `USDT` | `input` 1.25、`cacheRead` 0.125、`output` 10、`reasoning` 12 | 1.25 × 200 + 0.125 × 1000 + 10 × 200 + 12 × 100 = 3575 | `"0.00357500"` |
| `BEM` | `input` 12.5、`cacheRead` 1.25、`output` 100、无 `reasoning` | 12.5 × 200 + 1.25 × 1000 + 100 × 300 = 33750 | `"0.03375000"` |

没有 `reasoning` 价格，BEM 条目把全部 300 个输出 token 都按 `output` 计价。

## 7. 参考实现

- SDK：本仓库 `sdk/`（`sdk/src/index.js` 中的 `resolve` 处理包括名称在内的每种输入形式，`verifyDelegation` 对照持有者执行 §3.4 的检查；`sdk/src/manifest.js` 结构校验；`sdk/src/sig.js` 委托摘要与签名恢复；`sdk/src/rpc.js` 法定人数读取）。
- AI 绑定（§3.9）：`sdk/src/ai.js`（`validateAIField`、`modelEntryOf`、`pricingOf`、`amountOf`），每种格式一个适配器 `sdk/src/ai-*.js`，以及签名旁路 `server/src/ai-proxy.js`（示例：`examples/ai-proxy/`）。
- 合约：`contracts/src/ServiceDirectory.sol`，测试位于 `contracts/test/`。
- 运行中（2026-09-27）：`https://api.tapeapi.fun`（`11.1013.tape`，源码 `examples/public-api/`，基于 `server/`）与 `https://relay.tapeapi.fun`（`12.1013.tape`，源码 `examples/cloudflare-worker/relay-worker.js`）发布了带持有者委托的 TAP-20 清单；二者均可按名称、容器或二元组解析。
- ServiceDirectory 未部署，以上均未经第三方审计。解析不需要目录：除标签外的每种输入形式都只读取 TapeOut 自己已部署的合约。

## 8. 安全考量

- **持有者转让。** 转让电路不会撤销已发布的委托，但会改变 `ownerOf`。由于客户端恢复委托签名者并与当前持有者比较（§3.6 步骤 5），前任持有者签署的委托在下次解析时即失效。客户端 MUST 在签名失败时重新检查，SHOULD 周期性重新检查。
- **跨链重放。** 域中的 `chainId` 与 `verifyingContract` 将委托绑定到一条链。由于锚点是 DeWebHub 而非目录，该链上所有目录共用同一个域：委托只指明容器与签名者、从不提及目录，因此解析同一容器的两个目录 MUST 给出一致结论。这也正是未部署任何目录时服务即可使用的前提。伪造的委托仍会被链上 `ownerOf` 校验拒绝。
- **端点传输。** `endpoints.live` MUST 为 `https://`。TLS 保护参数与凭证的机密性，但不认证结果，这正是 TAP-21 对结果签名的原因。
- **签名密钥泄露。** 持有者发布带新 `signer` 与新委托的清单；客户端在下次解析时获取。较短的 `expires` 限制暴露窗口。提供者 SHOULD 将 `signer` 保存在隔离进程中。
- **标签抢注。** 由 `labelFee` 以及"真相以容器而非标签为键"缓解。被抢注的标签可以指向抢注者自己的服务，但无法呈现他人的容器，因为步骤 3 拒绝任何推导容器不一致的清单。
- **目录信任。** 客户端 MUST NOT 仅信任目录。`serviceOf`、`manifestPath` 与事件都是提示；清单、持有者与委托始终在链上重新推导。
- **RPC 信任。** 由于法定人数一致与 SHA-256，单个恶意 RPC 节点无法伪造清单，只能造成拒绝服务。客户端 SHOULD 使用来自独立运营者的节点。
- **清单大小与 JSON 解析。** 64 KiB 上限与严格的结构校验限制了解析器的暴露面。客户端 SHOULD 拒绝重复键。

## 9. 版权

Copyright and related rights waived via CC0-1.0.
