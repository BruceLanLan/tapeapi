# Agent Passport (experimental)

An **Agent Passport** links an ERC-8004 agent identity to a TapeOut circuit whose container hosts the agent's service,
so that anyone can check, read-only, that the identity and the service belong to the same holder. TapeAPI 3.0 adds a
resolver for it: the separate package `@tapeapi/passport` and the commands `tapeapi passport`,
`tapeapi-doctor --passport`, `tapeapi connect --passport` and `tapeapi init --passport`.

> **Everything here is experimental** and follows an open draft: TapeOutProtocol/TAPs pull request
> [#83](https://github.com/TapeOutProtocol/TAPs/pull/83) at head `cae25e6`, **not merged** (submitted, in review). Its text and vectors can
> change; every result carries the head it was resolved under. The draft has been updated since (its head is now
> `cbf4e03`): this package implements the text at `cae25e6`, and a package that follows the new text is planned. **Nothing on mainnet is known to resolve to CONFIRMED
> yet**: the draft's two real reads (agent #1, circuit #4246@0) are BROKEN, and the draft author's own small mainnet run
> has not been done. TapeAPI interoperates by reading ERC-8004's deployed public registry on BNB Smart Chain; this is not
> an extension of ERC-8004 and is not endorsed by its authors or by anyone operating its registries. The package is
> **outside the compatibility promise**: it may change or go away in any release.

## What a passport says, and what it does not

A resolver reports **CONFIRMED** only when all of these hold at one pinned block, every read agreed by every configured
node of at least two operators (strict agreement):

- one wallet, the holder, owns both the identity and the circuit (P-1);
- the identity carries the metadata key `tap.passport` = `abi.encode(56, processor, #ID)` naming the circuit (P-2 to P-4);
- the circuit's container is opened (P-5);
- the container's site holds `/.well-known/agent-registration.json`, with a `tap` member that matches the chain, a
  `tape://<on-chain name>` service, and exactly this one identity listed (P-7, P-10);
- no site operator set by an earlier holder is still active (P-8);
- the registry's agent wallet equals the holder (P-9).

It reads the chain first and files last, so a file can only add a problem, never remove one. The answer is one state
word with one named reason and every warning:

| State | Meaning |
|---|---|
| CONFIRMED | all rules hold; the result also says what could not be checked |
| BROKEN | a binding fact is false; the reason says which (for example `registration-file-missing`, `holder-mismatch`) |
| AMBIGUOUS | the holder's file lists several identities of the registry; every one is shown, none is picked |
| wallet-unset | everything holds except the agent wallet, cleared when the identity changed hands; the holder can set it again |
| stale-agent-wallet | the agent wallet is another address; it is never shown as a payment address |
| UNAVAILABLE | the reads could not be agreed (a node, a timeout, a disagreement, an upgraded registry): nothing is known |

A passport says only that one wallet holds both tokens and that the holder published the link. It does not say which code
the agent runs, nor that it is honest or safe; it is not a credential and confers no right to any income or asset. A
receipt proves only what its signer says.

## Limits you should know

- **The registries are upgradeable.** Both ERC-8004 registries are UUPS proxies. Their owner, read on 2026-10-28, is a
  proxy that answers `getThreshold()` 3 and five `getOwners()`, shaped like a 3-of-5 Safe. The resolver pins the
  implementation the draft lists; after an upgrade every result is UNAVAILABLE (`registry-changed`) until a new version
  accepts the new implementation.
- **Gifted identities and circuits.** On the deployed registry anyone can register an identity with any URI and metadata
  and transfer it to any wallet without consent; a circuit can be transferred the same way. The agent-wallet, listing and
  one-circuit rules (P-9, P-10, P-11) keep such tokens from resolving as a passport, and TapeAPI never lists identities by
  owner. Tools that do will still show a stranger's text next to the victim's address.
- **Site operators and holder history need log nodes.** P-8 and the holder epoch (§7: "holder changed at block n:
  earlier reputation does not belong to the current holder") need `eth_getLogs` history, which public nodes refuse over
  long ranges. Without log-capable nodes both are reported as `operators-not-checked` and `transfer-history-unavailable`,
  and a CONFIRMED result says "site operators not checked; holder history not checked". A history that could not be
  obtained is never treated as an empty one.
- **Wallets that sign EIP-712 only.** Such a holder can set the agent wallet (`setAgentWallet` is EIP-712) but cannot
  derive a TapeSend sealed inbox, which needs `personal_sign`. That is not a failure of the passport.
- **Privacy.** A passport publicly and permanently links a wallet, an identity, a container, its site and any reviews.
- **The look-alike check is a fixed table.** Forbidden member names inside `tap` (money words such as `reward`,
  `points`) are found after NFKC and the draft's table of 31 Cyrillic and Greek letters (and their capitals). It does not
  catch every look-alike, and nothing here claims it does.

## Install

`@tapeapi/passport` is its own package (version 0.1.0), experimental and outside the compatibility promise. It is a
tarball on the same GitHub release as the SDK, and it needs the SDK of that release, installed first:

```bash
npm install https://github.com/BruceLanLan/tapeapi/releases/download/v3.0.0/tapeapi-sdk-3.0.0.tgz
npm install https://github.com/BruceLanLan/tapeapi/releases/download/v3.0.0/tapeapi-passport-0.1.0.tgz
```

See [passport/README.md](../../passport/README.md).

## Resolve

```bash
tapeapi passport 4246.0.tape                # a TapeOut name on BNB Smart Chain (an example)
tapeapi passport 1001                       # an ERC-8004 agentId
tapeapi passport 0x50a9...9dd9#4246 --json  # a processor contract and #ID
```

Exit status: 0 CONFIRMED; 1 not a passport, or not confirmed (the reason is shown); 2 a usage mistake or the package not
installed; 3 nothing could be read: run it again. To check site operators and the holder history, give log-capable
nodes of two operators and a block before the registries were deployed:

```bash
tapeapi passport 1001 --logs-rpc https://logs-a.example,https://logs-b.example --logs-from <block>
```

The scan goes from that block to the pinned block in chunks (5,000 blocks by default) within a request budget (64);
a refused chunk, a log node without the pinned block, or a scan over budget makes the history "not checked" again.

In code:

```js
import { createTapeAPI, rpcUrlsFor } from '@tapeapi/sdk'
import { resolvePassport } from '@tapeapi/passport'

const api = createTapeAPI({ rpcUrls: rpcUrlsFor(56) })
const r = await resolvePassport({ name: '4246.0.tape' }, { api })
// r.state, r.reasons, r.warnings, r.checked, r.display.en / r.display.zh, r.draft.head
```

With `api`, the resolver uses that client's nodes and its processor table (`api.chain.processorNumber`, an experimental
SDK method added for this); the number it gives is checked by one strict `cpuAt` read. `recordSnapshot: true` returns the
reads as a `tap-agent-passport-snapshot/1`, which `resolveFromSnapshot` replays offline.

## In the other commands

- `tapeapi-doctor <name> --passport`: one more check after "Manifest format", not one of the 14. CONFIRMED passes, or
  warns with what was not checked; "this service publishes no passport" is a skip, not a failure (a service needs none);
  any other state warns; UNAVAILABLE is "could not decide".
- `tapeapi connect <name> --passport`: one more section beside the card. It changes nothing about whether the service
  can be used.
- `tapeapi init --passport --agent-id <n> --name <name> [--gateway-domain <domain>]`: a step of its own. After read-only
  checks (the identity's owner is the circuit's holder; its `tap.passport` key names this circuit; the manifest's SHA-256
  from the site store) it writes `.well-known/agent-registration.json` in `--dir` and prints what you do next, in your own
  wallet: store the file with `putFile` in the holder console (you pay for it), and use the canonical `agentURI`
  `https://<label>.<gateway domain>/.well-known/agent-registration.json` (another form only gives the warning
  `agent-uri-not-canonical`). It registers nothing and sends nothing. Between your `register` transaction and that
  `putFile`, your own identity resolves as BROKEN: store the file right after registering.

**Delegation length.** The draft's W-1 says a tool that asks a holder to sign a TAP-11 delegation must not propose more
than 30 days by default, and should propose 7 days or less. Since 3.0 the holder console (the one `tapeapi init` points
to) proposes 30 days, and the holder can type any whole number of days from 1 to 366, 7 included; so TapeAPI's
onboarding keeps W-1's 30-day limit, but not its 7-day advice. `checkDelegationProposal` in the package applies W-1 for tools that want it. The
windows of the other drafts are in the table below.

## Windows side by side

Each draft limits a different signed object, and not every number is the same kind of limit: a hard cap is checked by
verifiers, a default limit only says what a tool may propose. TapeAPI decides nothing here for any draft.

| Signed object | Window | Kind of limit | Source |
|---|---|---|---|
| A mandate of a container agent, phase 0 (#47) | `expires − notBefore` at most 30 days (2,592,000 s); a longer one fails `mandate-too-long`, and TapeAPI checks it too | Hard cap | TAP-18 (#47) draft, §5.1 check 4 |
| A `PolicyBinding` (#84) | A tool must not propose by default more than 30 days and should propose at most 7; `policyBindingTypedData` proposes 7 and flags a longer window `longWindow` | Default for tools; a longer window is the binder's own choice | TAPs #84 draft; [Policy circuits](policy-circuit.md) |
| A TAP-11 delegation, as #83 W-1 asks tools to propose it | A tool must not propose by default more than 30 days and should propose 7 or less; the holder may choose more, up to TAP-11's limit | Default for tools | TAPs #83 draft, W-1 |
| A TAP-11 delegation, its limit | 366 days; TapeAPI clients refuse a longer one, and W-1 says no tool may propose it as its default | Hard limit | TAP-11 §4.3 |
| A TAP-11 delegation from `tapeapi init` and the holder console, today | 30 days by default (the doctor warns with fewer than 7 left); the holder may choose 1 to 366 | TapeAPI's own default: at W-1's 30-day default limit, above its 7-day advice | This repository |

A binding, a mandate or a delegation ends early only when its signer signs a revocation: a holder who cannot sign (a
frozen key, a holder that changed) cannot end it before it expires, which is one more reason to keep windows short.

## The A2A card and reviews

- `agentCardFromPassport` builds an A2A 1.0 agent card (the draft's Appendix B) for a CONFIRMED passport only. It is
  display only: it never raises a state and is never a source of signers. A manifest has no marker for A2A endpoints,
  so the caller names them. When the manifest carries `mcp`, the tool list stays the one `mcp.toolsSha256` pins.
- `@tapeapi/passport/feedback` implements §10, reviews written as ERC-8004 feedback and their summary. It is optional and
  depends on the review draft TAPs #54 at `703b2a9`, which is **not merged**; nobody has written such feedback yet.

## How it is tested

The draft's own vectors (147 cases, `vectors.json` at SHA-256 `7720772c…fca4`) are a test fixture pinned by hash and
replayed byte for byte; they are not in the package. The same 73 resolution cases run again through the live layer on a
fake chain with the SDK's strict-agreement client. TapeAPI's own extra cases, kept apart from the draft's, cover what
the vectors do not: capital look-alike letters, code points above U+FFFF in a member name, and decimal literals in a
registration file (`"chainId": 56.0` is invalid, `"agentId": 1001.0` is not a listing).
