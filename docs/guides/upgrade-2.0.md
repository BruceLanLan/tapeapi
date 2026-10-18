# Upgrading from 1.x to 2.0

TapeAPI 2.0.0 was released on 2026-10-12. This page lists its breaking changes and what to write instead; anything not
listed here works in 2.0 as it does in 1.x. 1.x receives security fixes for 6 months after 2.0.0.

## What 2.0 keeps

The three levels of the 1.0 promise stay: **Stable** (no breaking change within 2.x; additions in any minor release),
**Experimental** (`@experimental`, may change in a minor release, each change in the changelog) and **Internal**. A
breaking change comes only in a new major version. The wire formats and frozen constants of TAPI-20 to TAPI-27 do not
change: a 2.0 client verifies every 1.x manifest, delegation, signed response and receipt, and their vectors, and it
can still speak version 1 of private channels and groups when asked to (below).

One thing is different in kind: the 2.0 default resolves by TAP-10 and TAP-11, which were merged as Drafts (a merge is
not an adoption) and can still change. How the default follows a change in those texts, and why `data.status`,
`SiteStatus` and `svc.conform` stay experimental in 2.0, is under "How the default follows changes in the official TAPs"
below.

## Breaking changes

Search your code for the name in the first column.

| 1.x | 2.0 | Why |
|---|---|---|
| Private channels and groups use the labels `TAP-26/…` and `TAP-27/…` (TAPI-26 and TAPI-27 version 1) unless you pass `labels: 'v2'` | They use the labels `tape-channel/…` and `tape-group/…` ([TAPI-26 v2](../../spec/TAPI-26-v2.md), [TAPI-27 v2](../../spec/TAPI-27-v2.md)) unless you pass `labels: 'v1'` | The editors of TapeOutProtocol/TAPs asked that no label look like a TAP number before the drafts of private channels and groups are merged. Labels are frozen in a Stable (v1) spec, so the rename is a version 2 of each spec. 1.8.1 added it as an option; 2.0 makes it the default. See "Channels and groups" below. |
| `e.tooLarge`, `e.rpcCode`, `e.rpcRevert`, `e.rpcData`, `e.agreed`, `e.disagreed`, `e.failed`, `e.groups`, `e.quorum`, `e.reason`, `e.refusals`, `e.effectiveK`, ... | `e.data.tooLarge`, `e.data.rpcCode`, ... | `TapeAPIError`'s top-level fields have been fixed since 1.0 (`name`, `code`, `message`, `data`, `signed`, `httpStatus`, `cause`, and `ts`, `block`, `id`, `sig`, `error` on a signed provider error); every other detail is in `data`. 1.x also kept the old names as deprecated read-only aliases. 2.0 removes them: reading one gives `undefined`. |
| A mistake in your own options or arguments to the channel module (`channel.*`, TAPI-26) reported as `CHANNEL_INVALID` | `INVALID_ARGUMENT` | The rule every other module has followed since 1.0: one code for "your own options or arguments are wrong", raised before anything is sent and never worth retrying. TAPI-26 data that fails stays `CHANNEL_INVALID`. See the table below. |
| `createTapeAPI()` without `conform` resolves in TapeAPI's own way; `conform: 'tap10'` (experimental) resolves as TAP-10 and TAP-11 say | Without `conform` it resolves as TAP-10 / TAP-11 §2 say; `conform: false` is the 1.x behaviour (deprecated, kept in all of 2.x) | The official TAPs define how a name is resolved; 2.0 follows them unless you opt out. See "Conformance becomes the default" below. |

### Conformance becomes the default

In 1.x, `createTapeAPI()` resolves names its own way and resolves them as TAP-10 / TAP-11 say only when you pass
`conform: 'tap10'` (experimental since 1.4; see [the conformance mode](upgrade-1.0.md)). In 2.0 the second is the
default:

```js
// 1.x: the TapeAPI way
const api = createTapeAPI({ rpcUrls })
// 2.0: this is TAP-10 / TAP-11 §2 resolution, exactly what conform: 'tap10' did in 1.x
const api = createTapeAPI({ rpcUrls })
// 2.0: the 1.x behaviour, unchanged request for request (deprecated; kept for all of 2.x)
const api = createTapeAPI({ rpcUrls, conform: false })
```

Leave `conform` out and the client resolves as TAP-10 v1.1 §3 to §7 and TAP-11 §2 say, at one TAP-10 pinned block.
Pass `conform: false` (or `null`) and you get the 1.x default back. A test pins that `conform: false` makes the same
requests in the same order with the same results as the 1.8 default, except for the v2 inbox room that `chain.channelKeys`
reports (the labels default; see "Channels and groups") and the deprecation warning. `conform: false` is deprecated: every client
made with it reports one warning through `onWarning` when it is created (it never throws and changes nothing; clients the
SDK makes inside itself, such as the ones `forChain` returns, do not repeat it), and 2.x keeps it. Whether 3.0
removes it is not decided.

Not changed: `allChains` stays off (turning it on sends queries to the public nodes of other chains), `sentinel` stays
`'warn'`, `siteStatus` was the same in both modes, and the agent toolkit already resolves as TAP-11 §2 says.

| | 1.x default | 2.0 default | 2.0 `conform: false` |
|---|---|---|---|
| Which resolution | TapeAPI's own (TAPI-20) | TAP-10 §3 to §7 and TAP-11 §2 | The 1.x one, unchanged |
| Block the reads use | Latest, unpinned (`pin` is opt-in) | One TAP-10 pinned block, confirmed by number and hash | Latest, unpinned |
| Agreement of the nodes | Quorum: the majority of the operators | Strict on `eth_chainId`, `ownerOf` and a contract holder's EIP-1271 calls: every operator must answer and agree; quorum on the rest | Quorum |
| A name that was never opened | Resolves if the manifest is valid | `SITE_STATUS`, `data.status: 'not-opened'` | Resolves |
| A name that is not activated, or whose payment has run out | Resolves | `SITE_STATUS`, `data.status: 'unpaid'` | Resolves |
| TapeOut upgrades the site store or the payment contract | Resolves (`sentinel: 'warn'` only warns) | `CONTRACT_UNKNOWN`, `data.status: 'store-changed'`, until the SDK lists the new implementation | Resolves with a warning |
| Input without chain information (a container address, a processor contract#ID) | Searched on this client's chain | A container address string that is a container on this client's chain resolves as before (you do not need `allChains` for it). A processor contract#ID string is always `INVALID_ARGUMENT`, `data.status: 'unsupported'`, unless `allChains: true`; so is a container address that is no container here (it may be one on another chain: 1.x said `MANIFEST_INVALID`, a conformant client with `allChains` says `not-tapeout` only after reading every chain). See "Known exception" below | As 1.x |
| Directory labels | Resolved with `directory` | Refused (TAP-10 §3.4) | Resolved |
| Custom `hub`, `factory`, `siteRegistry`, local or fork chain, explicit `pin` | Allowed | `INVALID_ARGUMENT` when the client is created, naming `conform: false` | Allowed |
| Error detail | `code` | `code` and `data.status` (the TAP name, lowercase) | `code` |
| How long a manifest is kept | 3,600 seconds | 60 seconds | 3,600 seconds |
| Requests for one cold resolution | About 24 (BNB Smart Chain) | About 45 | About 24 |

The last row, and what it means, is under "How many more requests" below.

#### New failures

Each of these resolved in 1.x. Branch on `e.data.status`, not on the message: the status names are the lowercase names the
TAPs use (`unsupported`, `hub-changed` and `container-mismatch` are TapeAPI's own). Status names only grow: a name is
never renamed or removed, a new name appears in a minor release, and a tightening of the condition behind an existing
name is first offered as an optional profile. See "How the default follows changes in the official TAPs" below.

| `e.data.status` | `e.code` | What happened | What to do |
|---|---|---|---|
| `not-opened` | `SITE_STATUS` | The name exists, but its container was never opened (TAP-10 §6.2) | Only the holder can change it: open the container. Do not retry. |
| `unpaid` | `SITE_STATUS` | The name is not activated, or its payment has run out (TAP-10 §6.3) | Only the holder can change it: activate it with `DomainBinding.bind` and pay. Do not retry. |
| `store-changed` | `CONTRACT_UNKNOWN` | The SiteRegistry or the DomainBinding runs an implementation this SDK does not list. Fails closed. | Update `@tapeapi/sdk`. Until the patch release exists, `conform: false` is the stop-gap. |
| `unavailable` | `RPC_UNAVAILABLE` (1.x's `RPC_DISAGREE` is this too) | A strict read was not answered by every operator, or two answered differently. On BNB Smart Chain the default nodes are three operators, and all three must answer. Before it says so, the SDK asks every node again, up to twice, when the nodes that failed did so only by the network (a broken or refused connection, a DNS failure, an HTTP 5xx other than a gateway timeout 504, 522 or 524; not a timeout) in a round that took less than 2 s, with the same rule each time; that adds less than 5.2 s (experimental, `rpcRetries: 0` turns it off). | Retry; add an operator of your own (`rpcUrls`) if it recurs. |
| `manifest-invalid` | `MANIFEST_INVALID` | The manifest on chain begins with a UTF-8 byte order mark, or is not valid UTF-8 (TAP-11 §3.1, TAP-10 §16). 1.x resolved such a manifest. | Ask the holder to publish the manifest again as valid UTF-8 without a byte order mark. Until then, `conform: false` is the stop-gap. |
| `unsupported` | `INVALID_ARGUMENT` | `allChains` is off and the input names no chain: a processor contract#ID string (always), or a container address string that is not a container on this client's chain (it may be one on another chain, so it is `unsupported` instead of `not-tapeout`). A container address of this client's chain resolves as it always did; it costs about 75 requests where 1.x used about 21. | Give the chain (`{ chainId, container }`, a name with an area code), or set `allChains: true` knowing that it sends reads to the public nodes of the other chains. This is a known exception to TAP-11 §2.1: see below. |

`store-changed` is the one to plan for. If TapeOut upgrades the site store or the payment contract, every 2.x client
fails closed on that chain the same day, until a patch release adds the new implementation to the accepted list
(`chains.js`, nothing else changes). That is the price of not trusting a contract nobody has reviewed; `conform: false`
is how you keep working until the patch is out.

Other statuses you may already know from 1.x's `conform: 'tap10'` are unchanged: `no-such-cpu`, `no-such-token`,
`not-tapeout`, `stale-block`, `wrong-chain`, `ambiguous`, `no-manifest`, `manifest-invalid`, `delegation-invalid`. The
messaging reads follow too. `chain.channelKeys` reports `store-changed` and refuses a byte order mark; `chain.tapeSendKey`
reports `hub-changed`, `circuits-changed`, `hub-mismatch`, `no-key` and `key-stale`. Neither checks activation
(TAP-10 §12.2: payment must not stop messaging).

```js
try {
  svc = await api.resolve('11.1013.tape')
} catch (e) {
  switch (e.data?.status) {
    case 'not-opened': case 'unpaid': /* the provider's to fix: show it, do not retry */ break
    case 'store-changed':             /* update the SDK, or conform: false until you can */ break
    case 'unavailable':               /* a node problem: retry */ break
    default: throw e
  }
}
```

#### Known exception: a processor contract#ID without `allChains` (TAP-11 §2.1)

TAP-11 §2.1 says a client MUST accept an on-chain name, a container address, and a processor contract with an #ID
(the TAP-10 §3.4 text form or two values). The 2.0 default does not meet that MUST for one input form, because
`allChains` stays off:

| Input | 2.0 default (`allChains` off) | With `allChains: true` |
|---|---|---|
| A processor contract#ID string, such as `0x50A994E71615474b55559fF4F500928fbc339DD9#4246` | Refused before any request: `INVALID_ARGUMENT`, `data.status: 'unsupported'` | Resolved as TAP-10 §4.1 says: read on every TapeOut chain, each at its own pinned block; `ambiguous` when more than one chain resolves it; a chain that could not be read is reported with its own status, never guessed |
| A container address string that is no container on this client's chain | `INVALID_ARGUMENT`, `data.status: 'unsupported'` (a container of this client's chain resolves as usual) | Read on every chain; `not-tapeout` only after every chain was read |
| `{ circuits, tokenId }` without `chainId` (the two-value form) | Accepted, and resolved on this client's chain only | The same: an object without `chainId` names this client's chain and is never searched |

How it differs from TAP-11:

- TAP-11 §2.1 makes accepting the processor contract#ID form a MUST; the default refuses its string form. TAP-10 §4.1
  resolves input without chain information only after reading every active chain, which means asking the public nodes
  of Base and X Layer. 2.0 keeps that off unless you ask, so that a client given only its own BNB Smart Chain node never
  sends requests to other chains' nodes.
- `unsupported` is TapeAPI's own name. It is not an outcome of TAP-11 §2.3 or TAP-10 §6.4, and it is not a verdict
  about the input: it says this client did not read the other chains. A TAP-conformant client would answer with a
  resolution, `ambiguous`, the status of a chain it could not read, or `not-tapeout`.
- For the two-value form TAP-10 §4.1 also asks for every chain; the SDK takes a missing `chainId` as this client's
  chain, with `allChains` on or off.

To resolve these inputs as TAP-11 §2.1 says, create the client with `allChains: true` (it then also reads Base and
X Layer, through `chains[id].rpcUrls` or the SDK's default nodes for those chains) and pass the string form. Or name
the chain yourself: a name with an area code, `{ chainId, container }`, or `{ circuits, tokenId, chainId }`.

2.0 leaves `allChains` off; it does not remove this exception, it records it here.

#### Error codes that change

Some failures were failures in 1.x as well, but with another `e.code`. Code that branches on `e.code` sees the change;
`e.data.status` (default mode only) is what stays put. This is every case where both sides fail and the code itself
differs, found by running the same cases through `conform: false` and through the default (a differential run over 637 cases):

| 1.x (`conform: false`) | 2.0 default | When |
|---|---|---|
| `MANIFEST_INVALID` | `NOT_FOUND`, `data.status: 'no-such-token'` | The token has no owner (`ownerOf` reverts), for example a #ID nobody minted |
| `MANIFEST_INVALID` | `NOT_FOUND`, `data.status: 'not-tapeout'` | A container address that is not a TapeOut container (read on every chain it can be on) |
| `MANIFEST_INVALID` | `INVALID_ARGUMENT`, `data.status: 'input-error'` | An input TAP-10 §3.4 does not accept, for example `04246.7` (a leading zero) |
| `MANIFEST_INVALID` | `INVALID_ARGUMENT`, `data.status: 'unsupported'` | A container address of another chain handed to a client of this chain: `api.forChain(8453).resolve(container)` with a BNB Smart Chain container |
| `RPC_DISAGREE` | `RPC_UNAVAILABLE`, `data.status: 'unavailable'` | A strict read where the operators answered differently |
| `chain.channelKeys`: `RPC_ERROR` | `NOT_FOUND`, `data.status: 'no-such-token'` | The container's token has no owner |
| A directory label given to `resolve`: `MANIFEST_INVALID` | `INVALID_ARGUMENT`, `data.status: 'input-error'` | The label is no longer an input (TAP-10 §3.4); refused before anything is read |
| A directory label: `DELEGATION_INVALID` | `INVALID_ARGUMENT`, `data.status: 'input-error'` | Same rule; this is the code 1.x reported for some labels |
| A directory label: `NOT_FOUND` | `INVALID_ARGUMENT`, `data.status: 'input-error'` | Same rule; this is the code 1.x reported for a label it did not find |

A failure that only gained `data.status`, or whose message changed, keeps its code and is not in this table. The
failures that 1.x did not have at all are in the table above.

#### Your configuration may now fail when the client is created

A client that is not on a TapeOut chain TAP-10 lists cannot resolve as TAP-10 says, so these are
`INVALID_ARGUMENT`, with the message "pass `conform: false`":

- your own `hub`, `factory`, `siteRegistry`, `opener` or `binding` addresses, or a `chainId` that
  is not a TapeOut chain TAP-10 lists (a local chain, an anvil fork, a test deployment). For the client's own chain this is
  when `createTapeAPI()` runs. For another chain's addresses in `chains[id]` it is later: the sub-client of a chain is made
  the first time it is needed, so the error comes from the first `api.forChain(id)` (or the first name on that chain that
  needs it), not from `createTapeAPI()`. It is still an error and never a fallback; `tapeapi-mcp` therefore reports a bad
  `--rpc-xlayer` / `--rpc-base` setup only when it resolves a name on that chain;
- an explicit `pin` (`'latest'`, `true`, `{ tag }`, ...) without `conform`: the default already pins as TAP-10 says, and the two cannot be combined.

`dev: true` counts as `conform: false`: development mode never checks the chain identity, so it keeps working. Nothing
falls back silently: a client that resolves the same name by one rule or another depending on its configuration is what
the conformance mode is there to rule out. Where you meant 1.x, write `conform: false` in the same options. `api.forChain()` passes
the mode on, so a sub-client of a default client is a conformant one.

#### Command line

`tapeapi-mcp`, `tapeapi-verify` and `tapeapi-doctor` follow the new default and say which mode they used in their output
(`tapeapi-doctor` in its report, `tapeapi-verify` with a `resolution:` line). Each takes `--no-conform` (the same as
`conform: false`) for the 1.x behaviour. `tapeapi-doctor` already checked that a name is opened and activated; what
changed is the verdict. In the default mode a name that is not activated is a **failure** of the doctor's activation check
(a default client does not resolve it, so the doctor cannot call it fine); with `--no-conform` it is still only a warning.

#### If you provide a service

Under 2.0 a client that cannot see your name as opened and paid sees `not-opened` or `unpaid`, and does not resolve it,
even if your service answers fine. Check before you upgrade your clients:

1. The name is `bind`-ed and activated, and the payment is not about to run out. `tapeapi-doctor <your name>` checks
   both and prints the days left (and fails on a name that is not activated, in the default mode).
2. The container is opened (TAP-10 §6.2).
3. Your manifest and delegation are valid as before. Nothing about them changed.

Run `tapeapi-doctor <your name>` from a 2.0 install. If its first seven checks pass (`name` to `delegation`), a 2.0
client resolves you. The checks after them are for AI services: a service that is not one fails at `ai-field` and the
rest are skipped, as in 1.x.

Old receipts follow the same rule. Once your payment has run out, a 2.0 client cannot resolve your name (`unpaid`), so it
cannot check a **historical** receipt your service signed while it was paid, either: [the receipt checker](https://tapeapi.fun/verify/)
says it could not check, not that the receipt is valid. What the page answers moves from "was this receipt valid when it was
signed?" to "is the service that signed it paid up now?". Keep a service paid for as long as people may want to verify what
it signed, or verify old receipts with a `conform: false` client (the 1.x resolution, which does not look at payment).

#### How many more requests

A conformant resolution reads more: the pinned block (checked by number and hash), `eth_chainId`, the opener, the
DomainBinding, the implementation slots of the site store and the payment contract, and `ownerOf` under strict
agreement. Measured on BNB Smart Chain with the default nodes (a cold client resolving one valid service, counting the
JSON-RPC calls it sends): about 24 calls for `conform: false` and about 45 for the default, so roughly 2 times as many
for a cold resolution; a repeated resolution on the same client is about 9 and about 36, roughly 4 times. An earlier
rough measurement on a test chain put it at about 3 to 6 times as many requests for a cold resolution; plan for 2 to 6
times. The manifest is also kept for 60 seconds instead of 3,600, so a long-lived client reads it about 60 times as often. If a public node starts to rate-limit you, give
`rpcUrls` your own operator before reaching for `conform: false`.

#### Which texts it follows: `CONFORM_PROFILE`

2.0 adds `CONFORM_PROFILE`, exported from `@tapeapi/sdk`, and `svc.conform.profile` on every service the conformance
mode resolves. Both name the texts the mode resolves by. In 2.0 the value is `'tap10@1.1+tap11@draft'`: TAP-10 at its
`version: 1.1` (the `version` every TAP-10 result already carries) and TAP-11, which has no version yet and is a Draft.

```js
import { createTapeAPI, CONFORM_PROFILE } from '@tapeapi/sdk'
const svc = await createTapeAPI({ rpcUrls }).resolve('11.1013.tape')
svc.conform.profile === CONFORM_PROFILE   // 'tap10@1.1+tap11@draft'
```

It is only added: no existing field, status name, request or error changes. With `conform: false` there is no
`svc.conform`, so no profile; `api.siteStatus()` (which keeps its `version`) and the errors' `data` do not carry it. A
value never changes meaning: an SDK that follows a changed TAP text says so with another value, so keep it next to
any result you store. Like the rest of `svc.conform`, it is `@experimental`.

#### How the default follows changes in the official TAPs

TAP-10 and TAP-11 were merged as Drafts (a merge is not an adoption), so their text can still change after 2.0. The
default resolves by the text `CONFORM_PROFILE` names. When that text changes, the default follows it by this rule:

| What the text change does | When the default follows | What you see |
|---|---|---|
| **Loosens** a rule: input in a form that was refused is now accepted, or a case that failed now resolves | In a minor release of 2.x, as the default | Another `CONFORM_PROFILE` value, and a changelog entry |
| **Adds** a status name | In a minor release of 2.x, as the default | The new name appears; no existing name changes |
| **Tightens** a rule: input that resolved now fails, or the condition behind an existing status name changes | Not in the 2.x default. It is offered first as an optional new profile; the default switches in 3.0 | A changelog entry that says how to choose the new profile; the default behaves as before |

What this means for your code:

- Status names only grow (TAP-11 §2.3): a name is never renamed or removed. Keep a `default:` case when you branch on
  `e.data.status`, as the example above does; a name you do not know is a new outcome, not a crash.
- A loosening can turn a failure you handle into a success. Code that relied on the failure sees another result.
- Until the first tightening exists, there is one profile, the value of `CONFORM_PROFILE`, and no option selects another.
  The release that adds a profile says in its changelog how to choose it.
- `conform: false` is the 1.x resolution and does not follow the TAPs at all.

`data.status`, `SiteStatus` and `svc.conform` stay `@experimental` in 2.0, because they follow texts that are still
Drafts. The rule above is what TapeAPI does; the label says it is not yet the Stable promise of "no breaking change in
2.x". Raising them to Stable is considered after TAP-11's review period ends with no unresolved objection, and not
before.

### Channels and groups

TapeAPI 1.x uses TAPI-26 and TAPI-27 version 1 by default; 1.8.1 and later 1.x use version 2 when you pass
`labels: 'v2'`. TapeAPI 2.0 uses version 2 by default and version 1 when you pass `labels: 'v1'`. The two versions do
not interoperate: the inbox room, the channel rooms, the group room, every key and every signature depend on the
labels. Nothing fails open: an invite or a message of the other version is never seen or is refused (with
`e.data.labels` and `e.data.peerLabels` where the SDK can tell), so a mismatched pair gets a timeout or a named
mismatch, never a wrong answer.

What to do, by who you talk to:

- **Both sides on 2.0, or on 1.8.1+ with `labels: 'v2'`**: nothing to change. Remove `labels: 'v2'` if you like; it is
  the default now.
- **A peer or group still on 1.x without `labels: 'v2'`**: pass `labels: 'v1'` on your side, to `createInvite`,
  `acceptInvite`, `roomsFor`, `inboxRoom`, `sealInvite` / `openInvite`, `sealToInbox` / `openFromInbox`, `createGroup`,
  `joinGroup`, `checkGroupInvites`, `openGroupInvite` and `groupRoom`, until that side upgrades or opts in to v2.
  `labels: 'v1'` is deprecated in 2.x and is not removed in 2.x.
- **Check what you got**: `pending.labels`, `session.labels` and `group.labels` say which version a handle uses.

What carries over and what does not:

- A channel session keeps the version of its handshake to its last frame. A new handshake after the upgrade uses the
  new default; pass `labels: 'v1'` to keep talking version 1.
- A group keeps its version for life. A 1.x owner's snapshot (`v: 1` or `v: 2`) is a version-1 group and resumes as
  one in 2.0: upgrading the owner does not move it, and its members keep passing `labels: 'v1'` to `joinGroup` and
  `checkGroupInvites`. To move a group to version 2, the owner creates a new group (a version-2 snapshot says `v: 3`).
- `api.chain.channelKeys(...).inbox.room` is the inbox room of the default version: the version-2 room in 2.0 (it was
  the version-1 room in 1.x). The version-1 room is `channel.inboxRoom(container, chainId, { labels: 'v1' })`.
- Channel records (`.well-known/tape-channel.json`, `ChannelKeys`) carry no label and stay valid. Holders sign nothing
  again.
- Relays (`relay.tapeapi.fun`) and ChannelBus carry bytes and need no change; they serve both versions at once.
- TAPI-26 and TAPI-27 version 1 stay Stable (v1) and are not withdrawn earlier than 12 months after version 2 becomes
  Stable (TAPI-1 §4.1). TapeAPI 1.x keeps version 1 as its default and receives security fixes for it for 6 months
  after 2.0.0.

### Which channel mistakes are now `INVALID_ARGUMENT`

| Where | 1.x code |
|---|---|
| `createInvite`: no `self` or `peer`, a `self` or `peer` container that is not an address, a `self.staticSecret` that is not 32 bytes, `ttlS`, `keys`, your own `relays` or `bus` | `CHANNEL_INVALID` |
| `acceptInvite`: no `self` or `peer`, their containers, `self.staticSecret`, a `seen` that is not a `Set` | `CHANNEL_INVALID` |
| `completeInvite` with a copy of the pending handle or one already used; `confirm` on the initiator's session; `seal` after `close()`, with something that is not a string or bytes, or with more than 16,384 bytes; `open` after `close()`; `encodeWire` of anything but a frame, `accept` or `ready` | `CHANNEL_INVALID` |
| `relayTransport` without `api` or `service`, or with an `inbound` / `outbound` that is not a room id | `CHANNEL_INVALID` |
| `busTransport` / `busReader`: the `rpc` client, `bus`, the rooms, `fromBlock`, `confirmations`, `lookback`, `overlap`, `chunk`, `minChunk`, `budgetMs`, `verdictMs`, `startGraceMs`, `blockBodyLimit`, `warn`, a handler that is not a function, `sendMany` with 0 or too many wires, a wire over the bus limit, `send` without `sendTx` | `CHANNEL_INVALID` |
| `fanIn`: no transports, a transport without `send` / `poll` / `start` / `stop`, `window`, `send` to a transport index that does not exist | `CHANNEL_INVALID` |
| `sealToInbox`: a `to.container` that is not an address, content too large to seal; `openFromInbox`: `self.staticSecret`, `self.container` (under either `labels` version) | `CHANNEL_INVALID` |

A `labels` value other than `'v1'` or `'v2'` was already `INVALID_ARGUMENT` in 1.8.1 and still is.

Still `CHANNEL_INVALID`: everything about TAPI-26 data, whether it came from the network or from you: an invite, an
`accept` or `ready` message, a frame, a sealed invite (including one sealed under the other label version), a wire
message, a peer's or recipient's static key that is not a usable X25519 key, a relay list or bus read from an invite,
an expired or replayed invite, and the shared validators `checkRelays`, `checkBus`, `assertPublicKey`,
`assertEd25519Public`, `endpointBytes` and `inboxRoom` called directly. When every transport of a `fanIn` fails, the
error is still `CHANNEL_INVALID`.

Unchanged in 2.0: the group module (`group.*`, TAPI-27) still reports a caller's mistake as `GROUP_INVALID`, and the
checks `api.call()` makes on `params` and `id` before sending still report `BAD_REQUEST`.

### Code that does not change

`channel.relayTransport({ api, service })` has taken `service` since 1.0 and still refuses `svc`. In 2.0 the channel
implementation takes the same name itself, so the package no longer translates it; code that uses the public
`@tapeapi/sdk/channel` sees no difference.

## Not in 2.0 yet

The other changes planned for 2.0 (a higher Node.js floor, and possibly required decimals in `parseUnits` /
`formatUnits` and a default freshness window in `verifyUsageReceipt`) are not made yet. Until they are, the 1.x
behaviour described in [Upgrading from 0.x to 1.0](upgrade-1.0.md) applies.
