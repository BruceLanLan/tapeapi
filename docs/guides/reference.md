# Reference

The datasheet appendix: the reference sections that used to fill the home page, moved here unchanged in substance.
What 2.0 changed, the experimental features, what each release added, the receipt layer for AI, the other layers,
chains, privacy, the agreement truth table, the absolute maximum ratings, the cost of operation, paid channels, the
roadmap, the specification index and the security note. The experimental features and paid channels rely on an escrow
that is not audited and not deployed: they do not work on mainnet, are checked on local chains and in tests only, and
nothing is charged today.

## New in 2.0

**DEFAULT SINCE 2.0** · TAP-10 v1.1 §3–§7 · TAP-11 §2 (Draft) · `conform: false` deprecated, kept in 2.x

2.0 has one theme: what we submitted to TapeOut's official TAP process, and what TapeOut itself specifies, is what the SDK does when you pass nothing. Since 1.4 these rules were the opt-in `conform: 'tap10'`; 2.0 makes them the default. **No wire format changes:** a 2.0 client verifies every 1.x manifest, delegation, signed response and receipt. TAP-10 and TAP-11 are Drafts, so the default follows their text by one rule: a loosening or a new status name in a 2.x minor release, a tightening first as an optional profile and the default in 3.0. **One known exception:** without `allChains`, a processor contract#ID such as `0x…#4246` is refused (`data.status: 'unsupported'`, a name of TapeAPI's own), where TAP-11 §2.1 says a client must accept it; pass `allChains: true` to resolve it on every chain as TAP-10 §4.1 says (this also queries the nodes of Base and X Layer).

TAP-11 (service manifest and holder delegation) and TAP-13 (signed responses) are drafts we wrote and submitted; the editors merged both into the official repository as Drafts, and a merge into Draft is not adoption. Twelve more drafts are open pull requests; three of them (#54, #59, #60) are draft PRs for now, so they don't take the editors' queue. For the 1.x behaviour, pass `conform: false` (deprecated, kept in all of 2.x).

```js
const api = createTapeAPI({ rpcUrls: rpcUrlsFor(56) })                  // 2.0: TAP-10 / TAP-11 §2
const old = createTapeAPI({ rpcUrls: rpcUrlsFor(56), conform: false }) // 1.x, deprecated
const dev = createTapeAPI({ dev: true })                           // = conform: false, no warning
```

### What changes (without `conform`)

| Case | 1.x default | 2.0 default |
|---|---|---|
| Block the reads use | Latest, unpinned | One TAP-10 pinned block, by number and hash |
| Chain ID, owner, a contract holder's signature | The majority of the operators | Every operator answers and agrees (strict) |
| A name never opened | Resolves if the manifest is valid | `SITE_STATUS` · `not-opened` |
| Not activated, or payment run out | Resolves | `SITE_STATUS` · `unpaid` |
| Site store or payment contract on an unlisted implementation | Resolves with a warning | `CONTRACT_UNKNOWN` · `store-changed` |
| Own addresses, a local chain, an explicit `pin` | Allowed | `INVALID_ARGUMENT` when the client is made, naming `conform: false` |
| Manifest cache | 3 600 s | 60 s |
| RPC calls, one cold resolution (BSC mainnet, measured) | ≈ 24 | ≈ 45 |
| The same resolution again, same client | ≈ 9 | ≈ 36 |

**Branch on `e.data.status`, not on messages.** The names are the lowercase names the TAPs use (`unsupported`, `hub-changed` and `container-mismatch` are TapeAPI's own). The status names only grow, and `data.status` is experimental in 2.0 (it follows a Draft); it is considered for Stable after TAP-11's review period ends with no unresolved objection. `not-opened` and `unpaid` are the provider's to fix (do not retry), `store-changed` means update the SDK (`conform: false` is the stop-gap), `unavailable` is a node problem (retry, or add an operator of your own to `rpcUrls`).

When a resolution fails, `e.data.status` says why in the TAPs' own words. A local service takes `{ dev: true }`; a local chain, a fork or your own deployment is not a TapeOut chain TAP-10 lists, so it takes `conform: false`, or the client stops with `INVALID_ARGUMENT` when it is made:

```js
try { await api.resolve('11.1013.tape') } catch (e) {
  if (e.data?.status === 'not-opened' || e.data?.status === 'unpaid') { /* the provider's to fix: do not retry */ }
  else if (e.data?.status === 'unavailable') { /* a node did not answer or disagreed: retry */ }
  else throw e
}
const dev = createTapeAPI({ dev: true })                       // a local http:// service, no on-chain manifest
const local = createTapeAPI({ rpcUrls: ['http://127.0.0.1:8545'], allowSingleNode: true, allowHttp: true,
  chainId: 31337, hub: HUB, factory: FACTORY, siteRegistry: SITE_REGISTRY, conform: false })
```

### Also in 2.0

- **New labels for channels and groups**: TAPI-26 v2 and TAPI-27 v2 by default: labels that begin with `tape-channel/` and `tape-group/`, as the TAPs editors asked before merging the drafts #12 and #20. `labels: 'v1'` selects version 1 (deprecated in 2.x, not removed). The two do not interoperate; a mismatch times out or is named, never fails open.
- **The command lines follow**: `tapeapi-verify`, `tapeapi-mcp` and `tapeapi-doctor` say which resolution they used and take `--no-conform`; in the default, doctor fails a name that is not activated.
- **The agent toolkit resolves as TAP-11 §2 says**: Without a `resolve` option, `createAgentKit` (experimental) resolves the agent and the providers as TAP-11 §2 says.
- **1.0 leftovers removed**: `TapeAPIError` loses its deprecated top-level aliases (read `e.data.*`); the channel module reports your own argument mistakes as `INVALID_ARGUMENT`.

### How we checked

- **The fallback is identical · 637 / 637**: In all 637 cases of a differential run, `conform: false` made the same requests in the same order with the same results as 1.8.1's default; the only differences allowed are the deprecation warning and the version-2 inbox room.
- **Our own services**: `11.1013.tape` and `12.1013.tape` resolve on mainnet with the TAP-10 resolution; both are activated, paid until 2036-08-09.
- **Providers, check yourself**: Run `tapeapi-doctor <your name>` from a 2.0 install; if its first seven checks pass (name to delegation), a 2.0 client resolves you; the checks after them are for AI services.

[Upgrading from 1.x to 2.0](upgrade-2.0.md) · [TAP-11 (Draft)](https://github.com/TapeOutProtocol/TAPs/blob/main/TAPs/TAP-11.md)

## Experimental features

**EXPERIMENTAL · NOT DEPLOYED.** 2.0 first makes public three experimental features: bounded agents, US-dollar prices and reviews between containers. **The limits:** the escrow contract they rely on (TAPI-22) is not audited and not deployed, so they do not work on mainnet; today they are checked on local chains and in tests only, and nothing is charged. They are outside the 2.x compatibility promise.

### Bounded agents

`@tapeapi/sdk/agent` · escrow not audited, not deployed · not on mainnet · local chains and tests only · nothing charged today · outside the 2.x compatibility promise

Phase 0 (1.7) records who may act for a container and on which task, and enforces nothing. Bounded agents are phase 1: an agent may spend for a container, and the most the container can lose is fixed by an escrow contract and checkable on chain. The circuit's holder funds one escrow channel per service the agent may pay, and authorises a key made for that one mandate as a session key on those channels until the mandate expires. **A leaked or misbehaving agent key can cost at most what was put in those channels, and only toward the services the mandate names.**

- **The check**: `{ enforcement: 'escrow-channel' }`: every capped channel is read at one pinned block, and the mandate is reported enforced only when all pass; what the chain bounds is always the channel's balance.
- **The holder's plan**: `holderPlan` reads its facts from the chain and returns the unsigned `approve`, `fund` and `authorizeSession`; `afterPlan` reads them back, `closeOut` withdraws the rest; a session history stops a key being funded twice.
- **A cumulative limiter**: `createSpendLimiter` never signs a voucher past what was settled at the start plus the cap; by default it refuses one call above 10% of the cap.
- **Orders resume after a restart**: Session keys and order records are kept sealed by a passphrase vault (scrypt and XChaCha20-Poly1305); `resume` continues only live orders, never a stopped, revoked or expired one.
- **Money in a delivery**: A delivery may carry the agent's signed spend statement, reconciled against the chain and the receipts.

What can be checked today is local only. At the root of a checkout with its dependencies installed, the first runs one spend order end to end on the SDK's fake chain (with a leaked key, a price rise and an escrow change among the adversarial cases); the second runs the same kind of transactions against a local copy of the escrow contract. No network, no real wallet, no cost.

```bash
node --test examples/agent-service/agent-service-spend.test.mjs
cd contracts && forge test --match-path 'test/Phase1*'
```

**Plainly.** The escrow contract it relies on (TAPI-22) is not audited and not deployed on any chain, and the SDK's built-in list of trusted escrows is empty, so it does not work on mainnet, and nothing is charged today. The phase-1 TAP draft is submitted as TapeOutProtocol/TAPs#60 (open as a draft PR for now), and the Standards draft for the escrow interface as #59 (open as a draft PR for now).

### Prices in US dollars, paid in BEM

TAPI-22 §3.6 · experimental: the escrow is not audited and not deployed, not on mainnet, checked on local chains and in tests only; nothing is charged today.

The reference implementation of the TAP draft #52 (an open pull request). A manifest may price in US dollars; the provider states a BEM rate in a signed quote, the client checks it against on-chain reference pools before it signs a voucher, and every priced answer carries a signed charge record; `priceBEM` stays the most one call can cost. A manifest without `usdPricing` is unchanged byte for byte. No escrow is deployed, so nothing is charged.

### Reviews between containers

`@tapeapi/sdk/review` · experimental, with the limits above: the escrow is not audited and not deployed, not on mainnet, checked on local chains and in tests only; nothing is charged today; outside the 2.x compatibility promise.

The reference implementation of the TAP draft #54 (an open pull request). A review is signed by the reviewer's holder or delegate and counts only with evidence: a signed answer the reviewer received, or a task thread between the two containers. Summaries count distinct reviewers and holders, never amounts; `tapeapi-verify review <name>` prints them.

## What each release added

- **Signed answers and receipts · 1.0**: Every answer is signed and bound to its request; an AI call also gets a usage receipt priced from the on-chain table (a public statement; users pay the provider as before). [Call a service](consume.md)
- **MCP tools · 1.0**: Signed results with a receipt; tool definitions pinned on chain by hash. [MCP guide](mcp.md)
- **Conformance with TapeOut's official TAP-10 · 1.4–1.5**: The opt-in `conform: 'tap10'`, the default since 2.0.
- **Streamed AI receipts and checkable usage · 1.5–1.6**: A stream cut short or with content added no longer verifies; the opt-in `requestUsage` puts a streamed Chat answer's usage inside the signature. [Streamed usage](ai-providers.md#the-usage-of-a-streamed-chat-answer-three-ways)
- **Container agents, phase 0 · 1.7–1.8**: Mandates, task threads, a read-only payment check; 1.8 checks them more strictly, as the draft #47 says, at one pinned block. [Container agents guide](container-agents.md)
- **Standards by default · 2.0**: TAP-10 and TAP-11 §2 resolution by default; the new channel and group labels by default (an option since 1.8.1); bounded agents first public (experimental: escrow not audited, not deployed, not on mainnet, local chains and tests only, nothing charged today).

The full list is in the [changelog](../../CHANGELOG.md).

## The receipt layer for AI

Requests and answers pass through the sidecar unchanged; it signs a usage receipt for each answer: the model, the token counts, the amount from the price table, and the hashes of the request and the answer. The signing key is delegated on chain by the circuit's holder and the price table is in the on-chain manifest, so a client checks against the chain, not against the sidecar.

- **No client code changes**: Official SDKs and command-line coding assistants work as before; only the base URL changes.
- **Four formats, streams included**: OpenAI Chat, Responses, Anthropic Messages, Embeddings.
- **Streamed usage you can check**: The opt-in `requestUsage` (1.6) puts a streamed Chat answer's usage inside the signed stream, checked against the receipt.
- **Receipts break no client**: In a response header, or an SSE comment the official SDKs ignore.
- **Prices pinned on chain**: One price per model and currency; a change needs the holder to republish.

Your business runs as before: your API, keys, channels and billing stay the same. The sidecar sits **in front of** your gateway, so a receipt covers exactly the usage and price you charge your users.

Prices in the table are **published, not settled**: your users pay you as they do today, and the amount in a receipt is a claim anyone can check.

TapeAPI is for providers operating within their upstream providers' terms. Identity and prices live on chain, so users follow the on-chain record when you change domain or server; the protocol does not offer, or help with, getting around an upstream's bans or regional limits.

**A receipt does not prove which model actually ran.** A provider could label a cheaper model's answer as a dearer one. What the signature adds is accountability: a receipt cannot be disowned, so anyone running spot checks and publishing the results leaves evidence. See the [guide for AI providers](ai-providers.md).

## One identity, four more layers

### Signed MCP tools

In MCP a tool result is whatever the server sent, and a tool definition can change after you approved it. TapeAPI signs every result, attaches a receipt and pins the hash of the tool definitions on chain. Use the public endpoint, put the signing proxy in front of your own server, or run `tapeapi-mcp` locally to check every answer before the model sees it.

### Private channels and groups

TAPI-26 v2 · TAPI-27 v2. End-to-end encrypted channels between two containers: mutual authentication, forward secrecy, replay and reorder protection. Groups of up to 32 containers (up to 128 in the experimental format 2), with an owner who manages members and a signature on every message. Carried by the public relay, your own relay or ChannelBus on chain, each of which sees ciphertext only. Since 2.0 the default is version 2 of the specs, with `tape-channel/` and `tape-group/` labels; pass `labels: 'v1'` to talk to a 1.x peer that has not opted in.

### Multi-chain: BNB Chain, X Layer, Base

TapeAPI follows TapeOut to X Layer and Base. Names carry an area code: `1.2.230.tape` is circuit 1 of processor 230 on X Layer. Identity, resolution, receipts and MCP checks all work there; payments will be on BNB Chain only.

### Container agents and bounded agents

Experimental. Phase 0 (1.7): the holder signs a mandate, the agent takes the task and delivers, the principal accepts, and payment is a plain transfer anyone can verify, with nothing enforced. Bounded agents (2.0): a mandate that names funds is bounded by escrow channels, and the most the agent can spend is checkable on chain; the escrow is not audited and not deployed, so it does not work on mainnet and runs on local chains and in tests only, and nothing is charged today. `@tapeapi/sdk/agent` is outside the 2.x compatibility promise. [Bounded agents](#bounded-agents)

## Chains

| Chain | chainId | Name | Scope | Default nodes |
|---|---|---|---|---|
| BNB Smart Chain | 56 | `11.1013.tape` | Everything; ChannelBus; payments only here (not deployed) | 3 operators: 2 must agree on most reads, all 3 must answer and agree on strict reads |
| X Layer | 196 | `1.2.230.tape` | Read-only: identity, resolution, receipts, MCP checks | Only 2 operators, both must answer and agree, no spare |
| Base | 8453 | area code 3 | Read-only: as above | 4 operators |

Identity does not carry across chains: the DeWebHub has one address on all three, and the delegation is bound to the chain ID, so a delegation for one chain is refused on another.

## Privacy: what is protected and what is not

### Protected

- **Channel and group content**: End-to-end encrypted; relays and the chain hold ciphertext only.
- **AI receipts carry hashes only**: No prompt, no answer; requests sent through the SDK or `tapeapi-verify` get 128 random bits of whitespace by default, so a short prompt cannot be confirmed by hashing guesses.
- **MCP links carry hashes only**: Not the params or the result; very short params (an address, a token ID) can still be guessed.
- **Reading channels on chain**: The SDK's `busPrivacyReader` (experimental) reads all of ChannelBus by default and filters locally, so nodes cannot see your rooms.
- **Minimal logs**: Our public services' configuration turns per-request invocation logs off; whether Cloudflare's own records include the IP is still to be verified.

### Public or visible

- **A service sees what it processes**: Your request, your IP, your API key. Encryption cannot hide them from whoever processes the request.
- **Public RPC nodes**: See your IP and which service you are checking.
- **Channel metadata**: Relays and the chain see rooms, timing and sizes.
- **Everything on chain**: Identities, manifests, price tables (a public statement; users pay the provider as before), delegations; future payments, their amounts and both parties.

## Agreement truth table

Comparing two verified envelopes; chain reads apply the same rule between nodes.

| A answered | B answered | Signatures valid | Results identical | Output |
|---|---|---|---|---|
| 1 | 1 | 1 | 1 | ACCEPT |
| 1 | 1 | 1 | 0 | REJECT |
| 1 | 1 | 0 | × | REJECT |
| 1 | 0 | 1 | × | REJECT |

**There is no majority vote.** Two of three agreeing with one dissenting is a rejection by default. A majority rule can be forged by two colluding providers out of three; a rejection only denies. A caller may opt into the weaker mode explicitly, but that is its own decision.

```js
// Pin one block and require two independent providers to return the same bytes
const a = await api.resolve('11.1013.tape')
const b = await api.resolve('0x…')                  // a second, independent provider
const first = await api.call(a, 'bnbUsd', {})
const block = first.result.blockPinned.blockNumber
const r = await api.callQuorum([a, b], 'bnbUsd', { block }, { quorum: 2 })
console.log(r.result.bnbUsd, r.agreed)
```

Today api.tapeapi.fun is the only public provider of these methods, so the second one is yours or someone else's to run ([`examples/public-api/`](../../examples/public-api/)).

## Absolute maximum ratings

Beyond these values the spec or the SDK refuses outright.

| Symbol | Parameter | Value | Source |
|---|---|---|---|
| `MANIFEST_LIMIT` | Service manifest, AI price table included (a public statement; users pay the provider as before) | 64 KiB | TAPI-20 |
| `CHUNK` | One on-chain write (one console transaction) | 24 000 B | SPEC B.5 |
| `ENVELOPE_LIMIT` | Signed response envelope | 1 MiB | TAPI-21 |
| `DEFAULT_MAX_SKEW_S` | Signature time against the local clock | ≤ 300 s | TAPI-21 |
| `MAX_MEMBERS` | Group members (up to 128 in the experimental format 2) | 32 | TAPI-27 |
| `CHANNEL_KEYS_LIMIT` | Channel key record | 4 KiB | TAPI-26 |

## Cost of operation

No call is charged today: the paid-call escrow is not deployed.

| Item | Charged by | Amount |
|---|---|---|
| Resolve, read the manifest, verify, check receipts | Nobody | 0 |
| Mandatory TapeAPI protocol fee | Nobody | 0 |
| AI calls | The provider, off chain as today | Provider's choice |
| Maintenance contribution (paid channels only, not deployed) | Provider sets it | Default 1%, can be 0 |
| Opening a container | TapeOut | 0.012 BNB |

**No mandatory protocol fee; a default 1% maintenance contribution that any provider can turn off; the operator has no fee switch.** The 1% comes out of the provider's share only when a paid channel settles, and the user's price does not change. The paid-call escrow is not deployed, so no call is charged today. TapeAPI has no token.

## Experimental: paid channels

**EXPERIMENTAL · NOT DEPLOYED** · TAPI-22 · not audited · outside the 2.x stability promise · an independent audit comes before any deployment · not on mainnet; checked on local chains and in tests only · nothing charged today

The design for paid calls: the caller signs cumulative vouchers off chain into an escrow channel that belongs to that service alone, and the provider settles once on chain when it is worth doing, so a call itself costs no gas. The contracts and their tests are in the repository but **not deployed**; the figures below are local measurements that only show what the design costs. The escrow that goes to audit is planned to hold BEM first (the USDT peg and WBNB on demand); 2.0 also has experimental prices in US dollars paid in BEM (TAPI-22 §3.6, the draft #52), which charge nothing either.

Gas measured locally; fiat at BNB $753 and BSC 0.05 gwei.

| Symbol | Parameter | Typical | Condition |
|---|---|---|---|
| `t_WD` | Withdraw cooldown / window | 48 h / 7 d | Re-request outside the window |
| `t_SES` | Session key maximum lifetime | 30 d | Per channel, no revoke; a leak is bounded by one channel |
| `G_SET` | One on-chain settlement | 88 998 gas ≈ $0.0034 | Covers any number of prior calls |
| `G_CALL` | Gas per call | 0 | Vouchers are signed off chain |
| `MAX_CONTRIBUTION` | Maintenance contribution cap | 2000 bps | Default 100 bps; a provider can set 0 |

**On amortisation.** One settlement costs $0.0034. Settling every 1000 calls, gas is 3.35% of revenue at 0.001 BEM per call and 0.34% at 0.01 BEM. Gas does not constrain the price; the provider's marginal cost does.

[What 2.0 promises (Stable, Experimental, Internal), and upgrading from 1.x](upgrade-2.0.md)

## Roadmap

Items marked DONE have shipped; none of the rest is live yet, and no dates are promised. The full roadmap is in [`docs/ROADMAP.md`](../ROADMAP.md).

| Stage | Item | What it is |
|---|---|---|
| DONE | 1.0: stable interfaces | The SDK and spec interfaces froze: TAPI-20, 21, 23, 26 and 27 are Stable (v1), with test vectors checked by the independent Python verifier. From 1.0 on, TapeAPI follows semantic versioning, with breaking changes only in a major version. |
| DONE | 1.4–1.6: aligned with the official TAPs, tighter verification | The opt-in TAP-10 conformance mode; the specs renamed TAPI and drafts submitted to the official TAP process; a bypass of streamed AI receipt verification in 1.0 to 1.4 fixed (AI-assisted adversarial review, not a third-party audit); streamed usage you can check. |
| DONE | 1.7–1.8: container agents, phase 0 | The experimental `@tapeapi/sdk/agent`, `tapeapi-verify task` and `examples/agent-service`, with nothing enforced and no new contract; 1.8 checks them as the draft #47 says; 1.8.1 offers the new channel and group labels as an option. |
| DONE | 2.0: standards by default | TAP-10 and TAP-11 §2 resolution with no options; `tape-channel/` and `tape-group/` labels by default; `conform: false` and `labels: 'v1'` kept through 2.x. The same release first makes public bounded agents, US-dollar prices and reviews (all experimental: the escrow is not audited and not deployed, so not on mainnet; local chains and tests only; nothing charged today). |
| NEXT | Official TAP review | Twelve drafts are open pull requests (#12, #16, #18, #20, #26, #28, #47, #49, #52, #54, #59, #60), and follow-up edits are waiting for the editors (TAP-11: #51, #53, #55; TAP-13: #56). We rename our references when the editors assign numbers; a merge into Draft is not adoption. |
| NEXT | A Standards TAP for the escrow, and the bounded-agents draft | Both are submitted: the escrow interface as a Standards draft, TapeOutProtocol/TAPs#59, and the bounded-agents draft (phase 1) as #60; both are open as draft PRs for now. |
| NEXT | npm packages | `@tapeapi/sdk` and `@tapeapi/server`. Today the SDK and the server package install from each GitHub release. |
| AFTER AUDIT | Bounded agents and paid calls on mainnet | Both rely on the escrow contract (TAPI-22), which is deployed only after an independent audit; the first instance is planned to hold BEM. Until then every call is free, and bounded agents run on local chains and in tests only. |
| LATER | Container agents phase 2: a spending vault | An agent calling whitelisted contracts within limits, with immediate revocation. It needs a new contract and an independent audit. |

## Specification index

| Spec | What it is | Status |
|---|---|---|
| [TAPI-1](../../spec/TAPI-1.md) | TapeAPI's document process and statuses, with Stable (vN) | Draft |
| [TAPI-20](../../spec/TAPI-20.md) | Service identity and manifest, with the AI price table (the `ai` field; a public statement, users pay the provider as before) and multi-chain | Stable (v1) · §3.5 Experimental |
| [TAPI-21](../../spec/TAPI-21.md) | Signed response envelope, with AI usage receipts | Stable (v1) |
| [TAPI-22](../../spec/TAPI-22.md) | Metered vouchers and escrow; custody BEM first (§3.5), US-dollar prices paid in BEM (§3.6) | Experimental |
| [TAPI-23](../../spec/TAPI-23.md) | Attested read, cross-checked by independent providers | Stable (v1) |
| [TAPI-24](../../spec/TAPI-24.md) | Intent RFQ | Withdrawn |
| [TAPI-25](../../spec/TAPI-25.md) | Circuit-verified methods | Experimental |
| [TAPI-26 v2](../../spec/TAPI-26-v2.md) | Private channels between containers, `tape-channel/` labels; the default since 2.0 | Stable (v2) |
| [TAPI-27 v2](../../spec/TAPI-27-v2.md) | Private groups between containers, `tape-group/` labels; the default since 2.0 | Stable (v2) |
| [TAPI-26](../../spec/TAPI-26.md) | Private channels, version 1, frozen `TAP-26/` labels; `labels: 'v1'` in 2.x | Stable (v1) |
| [TAPI-27](../../spec/TAPI-27.md) | Private groups, version 1, frozen `TAP-27/` labels; `labels: 'v1'` in 2.x | Stable (v1) |

**These are TapeAPI's own specs, not TAPs.** TAPI-1 and TAPI-20 to TAPI-27 are TapeAPI's own document names; TAPs are numbered by the editors of [TapeOutProtocol/TAPs](https://github.com/TapeOutProtocol/TAPs) under TAP-01. We submitted fourteen TAP drafts for parts of them. The service identity and manifest was merged as [TAP-11](https://github.com/TapeOutProtocol/TAPs/blob/main/TAPs/TAP-11.md) (Draft, [#8](https://github.com/TapeOutProtocol/TAPs/pull/8)) and signed responses as [TAP-13](https://github.com/TapeOutProtocol/TAPs/blob/main/TAPs/TAP-13.md) (Draft, [#10](https://github.com/TapeOutProtocol/TAPs/pull/10)); a merge into Draft is not adoption. The other twelve are open pull requests with no number yet (three of them, #54, #59 and #60, are draft PRs for now, so they don't take the editors' queue): private channels [#12](https://github.com/TapeOutProtocol/TAPs/pull/12), MCP tool binding [#16](https://github.com/TapeOutProtocol/TAPs/pull/16), attested reads [#18](https://github.com/TapeOutProtocol/TAPs/pull/18), private groups [#20](https://github.com/TapeOutProtocol/TAPs/pull/20), AI usage receipts [#26](https://github.com/TapeOutProtocol/TAPs/pull/26), proof-verified reads [#28](https://github.com/TapeOutProtocol/TAPs/pull/28), container agents phase 0 [#47](https://github.com/TapeOutProtocol/TAPs/pull/47), the agent member of the manifest [#49](https://github.com/TapeOutProtocol/TAPs/pull/49), payment vouchers [#52](https://github.com/TapeOutProtocol/TAPs/pull/52), reviews between containers [#54](https://github.com/TapeOutProtocol/TAPs/pull/54), escrow channels [#59](https://github.com/TapeOutProtocol/TAPs/pull/59) and container agents phase 1 [#60](https://github.com/TapeOutProtocol/TAPs/pull/60). One more draft, an Information draft, [#61](https://github.com/TapeOutProtocol/TAPs/pull/61) (a privacy map), is submitted and open as a draft PR for now. Follow-up edits are waiting for the editors: to TAP-11, [#51](https://github.com/TapeOutProtocol/TAPs/pull/51) (drops the `TAP-26/` label mention), [#53](https://github.com/TapeOutProtocol/TAPs/pull/53) (two clarifying sentences) and [#55](https://github.com/TapeOutProtocol/TAPs/pull/55) (the reference implementation brought up to date, with a mainnet vector that ends in `resolved`); to TAP-13, [#56](https://github.com/TapeOutProtocol/TAPs/pull/56) (an outdated sentence in its reference implementation section). The editors review the format, not the merits. TAPI-20 to TAPI-27 (with version 2 of TAPI-26 and TAPI-27) remain the basis of the 2.x compatibility promise. The specs are bilingual; English is authoritative.

## Status

Stable 2.x, with semantic versioning: code written to the 2.0 docs keeps working in every 2.x release (except interfaces marked experimental, among them `data.status`, `SiteStatus` and `svc.conform`, which follow Drafts), and 1.x receives security fixes for 6 months after 2.0.0. The public service, the MCP endpoint and the public relay are live and ChannelBus is deployed; the paid-call escrow is experimental, not audited and not deployed, so bounded agents do not work on mainnet and run on local chains and in tests only, and no call is charged today; there is no third-party audit.

## Security note

There is no third-party audit. Tests: the JS suite (`npm test`), the contract tests (`forge test`) and the independent Python verifier, all run by CI on every push.

On 1.0.0 to 1.4.0, streamed AI receipt verification could, under particular chunking, report a truncated or content-injected stream as verified; it was fixed in 1.5.0 ([release notes](https://github.com/BruceLanLan/tapeapi/releases/tag/v1.5.0)). How to report a vulnerability, and which versions get security fixes, is in [`SECURITY.md`](../../SECURITY.md).
