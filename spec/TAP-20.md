| TAP | 20 |
|---|---|
| Title | TapeAPI: Service Identity and Manifest |
| Author | Bruce (@BruceLanLan) |
| Status | Draft |
| Implementation | Live without a directory (2026-09-27): on BNB Chain, `api.tapeapi.fun` (`11.1013.tape`, source `examples/public-api/`) and `relay.tapeapi.fun` (`12.1013.tape`) publish TAP-20 manifests with holder delegations, and the SDK resolves containers, `(circuits, tokenId)` pairs and names `<#ID>.<processor>.tape`. ServiceDirectory (§3.5) is not deployed, so labels do not resolve on mainnet. No third-party audit. |
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
- The **container** of a service is `DeWebHub.accountOf(circuits, tokenId)` (DeWebHub proxy `0xe61A9C7213a6Aa616C246a2B569e555B417b25ee` on chainId 56). Clients MUST derive the container and MUST NOT accept a self-reported container.
- The **holder** is `IERC721(circuits).ownerOf(tokenId)` at the time of verification.
- The service's on-chain name is the SPEC name `<#ID>.<processor>.tape`, where `#ID` is `tokenId` and `processor` is the number under which the TapeOut processor factory lists `circuits` (TapeKit SPEC §2.2, §3.2). This TAP defines no new name syntax.
- A **label** is a `bytes32` alias registered in a ServiceDirectory contract (§3.5). A label is a lookup convenience only; it carries no authority.

### 3.2 Manifest Location

- The manifest MUST be stored in the container's DeWEB site at URL path `/.well-known/tapeapi.json`, content type `application/json`, UTF-8.
- SiteRegistry keys carry **no leading slash** (TapeKit SPEC §6 step 3 strips it before lookup; on mainnet `4246.0.tape` stores `index.html`, and `fileInfo(container, "/index.html")` answers size 0). The registry key of the manifest is therefore `.well-known/tapeapi.json`. Clients MUST strip leading slashes before every `read` / `fileInfo` call.
- Clients MUST read it with `SiteRegistry.read(container, ".well-known/tapeapi.json")` (SiteRegistry proxy `0xd006ffdd5Ae313B17729621A00999cD3C71CE5e6`) and MUST verify the returned bytes against `SiteRegistry.fileInfo(container, path)`: byte length MUST equal `size` and `sha256(bytes)` MUST equal `sha256Hash`.
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

- Domain: `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)` with `name = "TapeAPI"`, `version = "1"`, `chainId = 56`, `verifyingContract = <DeWebHub address>`.
- Primary type: `Delegation(address container,address signer,uint64 expires)`.
- `DELEGATION_TYPEHASH = keccak256("Delegation(address container,address signer,uint64 expires)") = 0xc5081f9dc7e79dfbe7f3b3220ed9e7a29d0bc53239ee74dc184e4ac1f810948c`.
- `structHash = keccak256(abi.encode(DELEGATION_TYPEHASH, container, signer, expires))`.
- `digest = keccak256(0x1901 ‖ DOMAIN_SEPARATOR ‖ structHash)`.
- `sig` is 65 bytes `r ‖ s ‖ v`, `v ∈ {27, 28}` (a `v` of 0 or 1 is normalised to 27 or 28 first, as in TAP-21 §3.3), `s` in the lower half-order. The recovered address MUST equal the holder at verification time, unless the holder is a contract that accepts `sig` (below). `expires` MUST be strictly greater than the verifier's current Unix time. Verifiers SHOULD reject `expires` more than 366 days in the future. The same bound is a MUST for TAP-26 channel records, intentionally: a channel identity must lapse, while a service delegation is renewed with its manifest.
- **Contract holders.** A client MAY accept a delegation from a holder that is a contract under EIP-1271: `isValidSignature(digest, sig)` on the holder MUST return the full 32-byte word `0x1626ba7e` followed by zeros. The delegation `sig` may then be longer than 65 bytes. The reference SDK treats a 65-byte `sig` as ECDSA (it recovers it first and refuses a malformed one before trying EIP-1271) and passes a longer `sig`, up to 1024 bytes as for TAP-26 channel records, to EIP-1271 directly. The reference ServiceDirectory verifies ECDSA only, so a contract holder's delegation is accepted by clients alone until that contract adds EIP-1271.
- `ServiceDirectory.verifyDelegation(circuits, tokenId, signer, expires, sig)` MUST implement the MUST-level checks of this section (the 366-day bound is a client SHOULD and is not enforced on-chain) and MAY be used by clients instead of local recovery; either way the holder MUST be read on-chain, never from the manifest.

### 3.5 ServiceDirectory

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

Input: a label, a TapeOut name `<#ID>.<processor>.tape`, a container address, or a `(circuits, tokenId)` pair. Output: `{ manifest, container, verified: { delegation, holder } }` or an error.

1. **Locate.** If input is a label, `container = ServiceDirectory.resolve(label)`; zero address → `NOT_FOUND`. If input is `(circuits, tokenId)`, `container = DeWebHub.accountOf(circuits, tokenId)`. If input is a TapeOut name `<#ID>.<processor>.tape` (canonical form per TapeKit SPEC §2.2: both parts decimal without leading zeros except `0` itself, all lowercase, `#ID ≥ 1`; a client MAY also accept the suffix-less `<#ID>.<processor>`, which TapeKit SPEC §2.4 lets an address bar accept for the same name), it is resolved exactly as TapeKit SPEC §3.2 resolves it: `circuits = factory.cpuAt(processor)` on the TapeOut processor factory (step 3), then `container = DeWebHub.accountOf(circuits, #ID)`; a processor number past the last one (`cpuAt` reverts) → `NOT_FOUND`. A string of this form is a name, never a label, and is not looked up in any directory. A string that looks like a name but is not in that form (leading zeros, an upper-case `.TAPE`, `#ID` 0) MUST be refused rather than guessed at, and is not looked up as a label either, so that no label can squat a spelling of a name. TapeKit's other address-bar forms (`#4246@0`, `tape://4246.0.tape/`) are not inputs to this algorithm: a shell converts them to the canonical name first, and the reference SDK refuses them like a non-canonical spelling. If input is a container, use it as given.

   The name form adds no trust beyond the `(circuits, tokenId)` path: it only computes that pair from on-chain reads made under §3.2, and steps 2–5 run unchanged, so step 3 still re-derives the container from the manifest's own `(circuits, tokenId)` and checks `isCPU`.
2. **Read manifest.** `fileInfo(container, path)` then `read(container, path)`, both with quorum agreement (§3.2). Verify length and SHA-256. Parse JSON; validate against §3.3. Failure → `MANIFEST_INVALID`.
3. **Derive.** `derived = DeWebHub.accountOf(manifest.circuits, manifest.tokenId)`. Clients MUST reject unless `derived == manifest.container == container`, and MUST reject unless the TapeOut processor factory (`0x68224F668083c29e9800Be2a646d42d18cedF7e2` on chainId 56) answers `isCPU(manifest.circuits) == true`: `accountOf` derives an address for any ERC-721, so without this check anyone could deploy a counterfeit token contract and present its account as a TapeOut container (TapeKit SPEC §3.3 step 2). Failure → `MANIFEST_INVALID`.
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

## 4. Rationale

- **Circuit as identity.** A circuit is transferable, already has a container, a DeWEB site and a TapeSend inbox, and is the unit users already recognise. Every service therefore consumes a circuit, which aligns provider incentives with the protocol rather than with a parallel registry. Alternatives (bare EOA, ENS-like names) would create a second identity system and a second name grammar.
- **Manifest in the container's site, not in the directory contract.** The manifest is large, changes often, and needs versioning; storing it as a site file makes it cheap to update and lets it inherit the kernel's verification (derived address, length + SHA-256, multi-node agreement) for free. A contract-stored manifest would need its own verification story and would bloat the directory.
- **Delegation instead of holder signing every response.** Holders are cold keys or multisigs; response signing is hot and high-frequency. A time-bounded EIP-712 delegation lets the hot key be rotated by re-publishing the manifest and keeps the holder key off the server. Binding `container` (not `tokenId`) in the struct means the delegation is valid for exactly one derived identity.
- **Directory is a hint, not an authority.** The only trustworthy binding is `(circuits, tokenId) → accountOf → container`. Making step 3 mandatory means a compromised or squatted directory can misdirect but never impersonate.
- **`priceBEM` as a decimal string.** Avoids floating point and keeps the JSON readable; the escrow uses wei.

## 5. Backwards Compatibility

This TAP adds nothing to `SPEC.md`. It does not alter the name grammar `<#ID>.<processor>.tape`, the container derivation, the file verification rules, or the multi-node agreement rule. Sites that do not use `tape.api` are unaffected. Manifests whose `tapeapi` is not `"0.N"` (N ≥ 1) are rejected by this version.

## 6. Test Vectors

### 6.1 Mainnet manifest (TODO before Final)

| Item | Value |
|---|---|
| chainId | 56 |
| service | `11.1013.tape` (`https://api.tapeapi.fun`), resolved 2026-09-27 |
| circuits (`cpuAt(1013)`) | `0xe02c26c7432A7121168AA9B610DE24eCf9a1a414` |
| tokenId | `11` |
| container (`accountOf`) | `0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8` |
| ServiceDirectory | TODO (not deployed) |
| manifest path (URL) | `/.well-known/tapeapi.json` |
| manifest registry key | `.well-known/tapeapi.json` |
| live read vector (chainId 56, recorded 2026-09-21) | `accountOf(0x50a994e71615474b55559ff4f500928fbc339dd9, 4246)` = `0x86DDaEF00401E3F10418398D67D7189fc458eA95`; `fileInfo(container, "index.html")` = 756 bytes, `text/html; charset=utf-8`, SHA-256 `0xec444c899bd9229f9173082fff362da66dd297179482a58b30b6f53ce9f7a0b6`; `fileInfo(container, "/index.html")` = size 0; `read(container, "/index.html")` reverts `0x2a9df442`. Raw responses: `sdk/test/fixtures/mainnet-4246-index.json` |
| nested-key vector (chainId 56, scanned 2026-09-21) | all 4,400 circuits on processor #0 scanned: 7 sites hold files; every nested key is stored bare, e.g. container `0x19366c3c69ffeb3b286d9fa6cc5e616375baafd3` (circuit 3114, 162 files) lists `assets/basic-BVO4OuW-.js`; 0 of 39 nested keys begin with `/` |
| `fileInfo.size` | TODO (the manifest changes when its delegation is renewed; record size, hash and block together) |
| `fileInfo.sha256Hash` | TODO |
| block number | TODO |

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

## 7. Reference Implementation

- SDK: `sdk/` in this repository (`sdk/src/index.js` `resolve` for every input form including names, and `verifyDelegation` for the §3.4 checks against the holder; `sdk/src/manifest.js` schema validation; `sdk/src/sig.js` delegation digest and signature recovery; `sdk/src/rpc.js` quorum reads).
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

本文档中的关键词 "MUST"（必须）、"MUST NOT"（禁止）、"REQUIRED"（必需）、"SHALL"、"SHOULD"（应当）、"SHOULD NOT"（不应）、"RECOMMENDED"（推荐）、"MAY"（可以）、"OPTIONAL"（可选）按 RFC 2119 解释。

## 1. 摘要

TapeAPI 允许电路持有者以电路的容器身份发布可被机器调用的服务。本 TAP 定义身份模型（服务 = 电路，容器 = `DeWebHub.accountOf`）、服务清单的位置与结构（`/.well-known/tapeapi.json`，经 SiteRegistry 读取）、持有者授权链下签名密钥的 EIP-712 委托，以及客户端 MUST 遵循的解析算法。响应签名与支付分别由 TAP-21 与 TAP-22 定义。

## 2. 动机

DeWEB 给电路一个网站；TapeSend（TAP-10）给它一个信箱。二者都没有给它一种以可验证、可归属的结果回应结构化请求的方式。今天，链下 API 没有链上身份，DeWEB 站点无法宣告一个 API，客户端也无法检查某个响应是否真的来自名称所指向的一方。

TapeAPI 在不修改协议的前提下填补这一空白：身份是既有容器，发现依赖既有链上文件，验证复用 SPEC §15.1 内核（推导的容器地址、长度 + SHA-256、多节点一致）。诸如 `reader` 之类的人类标签只存在于目录合约中，永不进入名称语法。

## 3. 规范

### 3.1 身份

- **服务**是一个电路：二元组 `(circuits, tokenId)`，其中 `circuits` 为 ERC-721 处理器合约。
- 服务的**容器**为 `DeWebHub.accountOf(circuits, tokenId)`（chainId 56 上 DeWebHub 代理 `0xe61A9C7213a6Aa616C246a2B569e555B417b25ee`）。客户端 MUST 自行推导容器，MUST NOT 接受自报的容器。
- **持有者**为验证时刻的 `IERC721(circuits).ownerOf(tokenId)`。
- 服务的链上名称即 SPEC 名称 `<#ID>.<processor>.tape`，其中 `#ID` 即 `tokenId`，`processor` 是 TapeOut 处理器工厂列出 `circuits` 所用的编号（TapeKit SPEC §2.2、§3.2）。本 TAP 不定义新的名称语法。
- **标签**是在 ServiceDirectory 合约（§3.5）中注册的 `bytes32` 别名。标签仅为查找便利，不承载任何权威。

### 3.2 清单位置

- 清单 MUST 存于容器 DeWEB 站点的 URL 路径 `/.well-known/tapeapi.json`，内容类型 `application/json`，UTF-8 编码。
- SiteRegistry 的键**不带前导斜杠**（TapeKit SPEC §6 第 3 步在查找前去掉它；主网 `4246.0.tape` 存的是 `index.html`，`fileInfo(container, "/index.html")` 返回 size 0）。因此清单的注册表键是 `.well-known/tapeapi.json`。客户端 MUST 在每次 `read` / `fileInfo` 前去掉前导斜杠。
- 客户端 MUST 通过 `SiteRegistry.read(container, ".well-known/tapeapi.json")`（SiteRegistry 代理 `0xd006ffdd5Ae313B17729621A00999cD3C71CE5e6`）读取，并 MUST 依据 `SiteRegistry.fileInfo(container, path)` 校验返回字节：字节长度 MUST 等于 `size`，`sha256(bytes)` MUST 等于 `sha256Hash`。
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

- 域：`EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)`，其中 `name = "TapeAPI"`、`version = "1"`、`chainId = 56`、`verifyingContract = <DeWebHub 地址>`。
- 主类型：`Delegation(address container,address signer,uint64 expires)`。
- `DELEGATION_TYPEHASH = keccak256("Delegation(address container,address signer,uint64 expires)") = 0xc5081f9dc7e79dfbe7f3b3220ed9e7a29d0bc53239ee74dc184e4ac1f810948c`。
- `structHash = keccak256(abi.encode(DELEGATION_TYPEHASH, container, signer, expires))`。
- `digest = keccak256(0x1901 ‖ DOMAIN_SEPARATOR ‖ structHash)`。
- `sig` 为 65 字节 `r ‖ s ‖ v`，`v ∈ {27, 28}`（值为 0 或 1 的 `v` 先规范化为 27 或 28，与 TAP-21 §3.3 相同），`s` 位于低半阶。恢复出的地址 MUST 等于验证时刻的持有者，除非持有者是认可该 `sig` 的合约（见下）。`expires` MUST 严格大于验证方当前 Unix 时间。验证方 SHOULD 拒绝超过未来 366 天的 `expires`。同一上限对 TAP-26 通道记录是 MUST，这是有意为之：通道身份必须会失效，而服务委托随清单一起续期。
- **合约持有者。** 客户端 MAY 按 EIP-1271 接受由合约持有者签发的委托：对持有者调用 `isValidSignature(digest, sig)` MUST 返回完整的 32 字节字 `0x1626ba7e` 后接零。此时委托的 `sig` 可以长于 65 字节。参考 SDK 把 65 字节的 `sig` 当作 ECDSA（先恢复签名，格式错误的签名在尝试 EIP-1271 之前就被拒绝），更长的 `sig`（与 TAP-26 通道记录相同，至多 1024 字节）直接交给 EIP-1271。参考 ServiceDirectory 只验证 ECDSA，因此在该合约加入 EIP-1271 之前，合约持有者的委托只被客户端接受。
- `ServiceDirectory.verifyDelegation(circuits, tokenId, signer, expires, sig)` MUST 实现本节中 MUST 级别的检查（366 天上限是客户端的 SHOULD，链上不强制），客户端 MAY 用它代替本地恢复；无论哪种方式，持有者 MUST 从链上读取，永不取自清单。

### 3.5 ServiceDirectory

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

输入：标签、TapeOut 名称 `<#ID>.<processor>.tape`、容器地址或 `(circuits, tokenId)` 二元组。输出：`{ manifest, container, verified: { delegation, holder } }` 或错误。

1. **定位。** 若输入为标签，`container = ServiceDirectory.resolve(label)`；零地址 → `NOT_FOUND`。若输入为 `(circuits, tokenId)`，`container = DeWebHub.accountOf(circuits, tokenId)`。若输入为 TapeOut 名称 `<#ID>.<processor>.tape`（规范形式见 TapeKit SPEC §2.2：两部分均为十进制、除 `0` 本身外无前导零、全小写、`#ID ≥ 1`；客户端 MAY 另外接受不带后缀的 `<#ID>.<processor>`，TapeKit SPEC §2.4 允许地址栏把它当作同一名称接受），则完全按 TapeKit SPEC §3.2 的方式解析：先在 TapeOut 处理器工厂（见步骤 3）上取 `circuits = factory.cpuAt(processor)`，再取 `container = DeWebHub.accountOf(circuits, #ID)`；处理器编号超出最后一个（`cpuAt` 回滚）→ `NOT_FOUND`。这种形式的字符串是名称，永远不是标签，也不在任何目录中查找。看起来像名称但不符合该形式的字符串（前导零、大写的 `.TAPE`、`#ID` 为 0）MUST 被拒绝而不是猜测，也不作为标签查找，使任何标签都无法抢注某个名称的写法。TapeKit 的其它地址栏形式（`#4246@0`、`tape://4246.0.tape/`）不是本算法的输入：外壳先把它们转换成规范名称，参考 SDK 则像对待非规范写法一样拒绝它们。若输入为容器，按原样使用。

   名称形式在 `(circuits, tokenId)` 路径之外不增加任何信任：它只是用按 §3.2 进行的链上读取算出这一二元组，步骤 2–5 照常执行，因此步骤 3 仍会用清单自己的 `(circuits, tokenId)` 重新推导容器并检查 `isCPU`。
2. **读取清单。** 先 `fileInfo(container, path)` 再 `read(container, path)`，二者均需法定人数一致（§3.2）。校验长度与 SHA-256。解析 JSON；按 §3.3 校验。失败 → `MANIFEST_INVALID`。
3. **推导。** `derived = DeWebHub.accountOf(manifest.circuits, manifest.tokenId)`。除非 `derived == manifest.container == container`，客户端 MUST 拒绝；且除非 TapeOut 处理器工厂（chainId 56 上的 `0x68224F668083c29e9800Be2a646d42d18cedF7e2`）对 `isCPU(manifest.circuits)` 回答 `true`，客户端 MUST 拒绝：`accountOf` 对任何 ERC-721 都能推导出地址，没有这一检查，任何人都能部署一个仿冒的代币合约，把它的账户当作 TapeOut 容器出示（TapeKit SPEC §3.3 第 2 步）。失败 → `MANIFEST_INVALID`。
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

## 4. 原理

- **以电路为身份。** 电路可转让，已经拥有容器、DeWEB 站点与 TapeSend 收件箱，且是用户已经认识的单位。因此每个服务都消耗一个电路，这使提供者的激励与协议对齐，而非与一个平行注册表对齐。替代方案（裸 EOA、类 ENS 名称）会产生第二套身份系统与第二套名称语法。
- **清单存于容器站点而非目录合约。** 清单体积大、变更频繁、需要版本化；作为站点文件存储使更新廉价，并免费继承内核的验证（推导地址、长度 + SHA-256、多节点一致）。存于合约的清单需要自己的验证机制，并会使目录膨胀。
- **委托而非持有者签署每个响应。** 持有者是冷钥或多签；响应签名是热的、高频的。带时限的 EIP-712 委托允许通过重新发布清单来轮换热钥，并使持有者密钥远离服务器。在结构体中绑定 `container`（而非 `tokenId`）意味着委托恰好对一个推导身份有效。
- **目录是提示而非权威。** 唯一可信的绑定是 `(circuits, tokenId) → accountOf → container`。强制步骤 3 意味着被攻破或被抢注的目录只能误导，永远不能冒充。
- **`priceBEM` 为十进制字符串。** 避免浮点数并保持 JSON 可读；托管合约使用 wei。

## 5. 向后兼容

本 TAP 不向 `SPEC.md` 添加任何内容。不改变名称语法 `<#ID>.<processor>.tape`、容器推导、文件校验规则或多节点一致规则。不使用 `tape.api` 的站点不受影响。`tapeapi` 不是 `"0.N"`（N ≥ 1）的清单会被本版本拒绝。

## 6. 测试向量

### 6.1 主网清单（Final 前 TODO）

| 项目 | 值 |
|---|---|
| chainId | 56 |
| 服务 | `11.1013.tape`（`https://api.tapeapi.fun`），2026-09-27 解析 |
| circuits（`cpuAt(1013)`） | `0xe02c26c7432A7121168AA9B610DE24eCf9a1a414` |
| tokenId | `11` |
| container（`accountOf`） | `0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8` |
| ServiceDirectory | TODO（未部署） |
| 清单路径（URL） | `/.well-known/tapeapi.json` |
| 清单注册表键 | `.well-known/tapeapi.json` |
| 主网读取向量（chainId 56，2026-09-21 记录） | `accountOf(0x50a994e71615474b55559ff4f500928fbc339dd9, 4246)` = `0x86DDaEF00401E3F10418398D67D7189fc458eA95`；`fileInfo(container, "index.html")` = 756 字节、`text/html; charset=utf-8`、SHA-256 `0xec444c899bd9229f9173082fff362da66dd297179482a58b30b6f53ce9f7a0b6`；`fileInfo(container, "/index.html")` = size 0；`read(container, "/index.html")` 回滚 `0x2a9df442`。原始响应见 `sdk/test/fixtures/mainnet-4246-index.json` |
| 嵌套键向量（chainId 56，2026-09-21 扫描） | 扫描处理器 #0 全部 4,400 枚电路：7 个站点有文件；所有嵌套键均为裸键，例如容器 `0x19366c3c69ffeb3b286d9fa6cc5e616375baafd3`（电路 3114，162 个文件）列出 `assets/basic-BVO4OuW-.js`；39 个嵌套键中 0 个以 `/` 开头 |
| `fileInfo.size` | TODO（委托续期时清单会变化；大小、哈希与区块号需一并记录） |
| `fileInfo.sha256Hash` | TODO |
| 区块号 | TODO |

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

## 7. 参考实现

- SDK：本仓库 `sdk/`（`sdk/src/index.js` 中的 `resolve` 处理包括名称在内的每种输入形式，`verifyDelegation` 对照持有者执行 §3.4 的检查；`sdk/src/manifest.js` 结构校验；`sdk/src/sig.js` 委托摘要与签名恢复；`sdk/src/rpc.js` 法定人数读取）。
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
