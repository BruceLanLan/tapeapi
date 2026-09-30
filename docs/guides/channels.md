# Private channels

A Tape Channel ([TAPI-26](../../spec/TAPI-26.md)) is an end-to-end encrypted, mutually authenticated channel between two
TapeOut containers. Whatever carries it (a relay service, a WebRTC connection or the chain itself) only ever sees
ciphertext and cannot forge, reorder or replay frames without being caught. Groups of up to 32 containers (up to 128
in the experimental format 2) are [TAPI-27](../../spec/TAPI-27.md); to add them to an application, see [Group chat](groups.md).

## How it works

| Step | What happens |
|---|---|
| **Identity** | Each container publishes channel keys (X25519 for key agreement, Ed25519 for signatures) in its site at `.well-known/tape-channel.json`, authorised by the circuit's holder with an EIP-712 signature. A peer checks them against the **current** holder, so a sold circuit's old keys stop working. |
| **Invite** (A → B) | A sends B an invite sealed to B's key, to B's inbox room on a relay or ChannelBus (or as a TapeSend message). It names the relays and bus A will listen on. |
| **Accept** (B → A) | B answers over one of those transports. B may already send data with it. |
| **Ready** (A → B) | A confirms. Three Diffie-Hellmans give mutual authentication, forward secrecy and resistance to key-compromise impersonation (the X3DH core, without prekeys). |
| **Frames** | ChaCha20-Poly1305 with a key per direction and a counter nonce, as in WireGuard and Noise. |

## 1. Publish the container's channel keys

The holder's wallet signs; the secret keys stay in a file you keep:

```bash
node scripts/channel-keys.mjs new --container 0x<container> --identity ./identity.json --days 180 \
  --relay https://relay.example/tapeapi/v1@0x<relay container>
# sign the printed typed data with the holder's wallet (eth_signTypedData_v4), then
node scripts/channel-keys.mjs record --identity ./identity.json --sig 0x<signature>
# prints the record and the putFile transaction that publishes it
```

`identity.json` holds the secrets (file mode 600). Nothing in the published record or the transaction does.

## 2. The handshake in code

The cryptographic core is transport-independent:

```js
import { channel } from '@tapeapi/sdk'

// A (initiator): an invite for B, and a pending handle
const { invite, pending } = channel.createInvite({
  self: { container: A, chainId: 56, staticSecret: aKeys.secretKey },
  peer: { container: B, chainId: 56, staticPublic: bKeys.publicKey },
  relays: [{ url: 'https://relay.example/tapeapi/v1', container: '0x<relay container>' }],
})

// B (responder): accept, and a session B can already send on
const { accept, session: bob } = channel.acceptInvite({
  self: { container: B, chainId: 56, staticSecret: bKeys.secretKey },
  peer: { container: A, chainId: 56, staticPublic: aKeys.publicKey },
  invite,
})

// A: complete, and a ready message for B
const { ready, session: alice } = channel.completeInvite(pending, accept)
bob.confirm(ready)

const frame = alice.seal('hello')                     // bytes to carry
bob.open(frame, { text: true }).data                 // 'hello'
```

In a real application the peer's public key comes from its published record (`api.chain.channelKeys(container)`),
and the invite, accept and ready travel over a transport.

## 3. Choose a transport

| Transport | When | API |
|---|---|---|
| **Relay** (default) | Low latency, no gas. A relay is an ordinary TapeAPI service that stores ciphertext per room. | `channel.relayTransport({ api, service, inbound, outbound })` |
| **ChannelBus** | No server to trust or keep running; every message is a transaction (about 50,000 gas). | `channel.busTransport({ rpc, bus: MAINNET.channelBus, inbound, outbound, sendTx })` |
| **Several at once** | The responder may answer on any transport the invite names, so listen on all of them. | `channel.fanIn([t1, t2])` |

A free public relay runs at `https://relay.tapeapi.fun` (TapeOut name `12.1013.tape`); how to name it in an invite and
carry a channel over it is in [Public API](public-api.md), under "The public relay". To run your own relay:
[`examples/relay-service/`](../../examples/relay-service/) (Node) or
[`examples/cloudflare-worker/`](../../examples/cloudflare-worker/) (one Durable Object per room). Check any relay with
`node conformance/relay.mjs --url https://relay.tapeapi.fun`: give the relay's site root, not the
`/tapeapi/v1` address that goes into an invite's `relays[].url`.

## 4. Reading the chain reliably

ChannelBus messages are events, and public BNB Chain nodes keep only part of the history, cap how many results one
answer holds, and sometimes fail. The reader (`busTransport`, or `busReader` for many rooms) is built on one rule:
**hold, never skip**. When no node can vouch for a block, the cursor waits there; it moves past only when every node
excuses the block, and then it tells you.

| Message (to `warn`, or the error of a held poll) | Meaning | What to do |
|---|---|---|
| `the cursor has held for N polls at blocks X..Y` | No node has answered those blocks yet, and some node may still keep them. | Usually resolves itself. If a node is gone for good, remove it; if it is slow, raise `budgetMs`. |
| `RPC_UNAVAILABLE: eth_getLogs: no node serves logs` | Every node refused the blocks as too old. | The reader started further back than the nodes' history (publicnode keeps about 10,000 blocks). Start from a newer `fromBlock`, or add a node that keeps more history. |
| `block N is too old for <node>, so it was read from <others> alone` | One node no longer keeps that block; the others answered for it. | Nothing; frames are delivered. |
| `block N holds more logs than <node> returns ...` / `was read only from the receipts of ...` | A block too full for one node was read from the other nodes, or from their block receipts. | Someone filled a block with junk frames; your frames are still delivered, but rest on fewer nodes. |
| `<node> has not served for N polls, so blocks from X on are passed without it` | A node that stopped answering is no longer waited for, so a dead node cannot stop the channel. | Replace or remove that node. |

Reading ChannelBus needs nodes that serve `eth_getLogs`, which the BNB Chain dataseed nodes refuse. Use the SDK's
`BUS_RPC_URLS` (48 Club and 1RPC, which serve logs with at least 500,000 blocks of history, plus a dataseed for
receipts) in a client of its own: `createRpc({ urls: BUS_RPC_URLS, quorum: 2, timeoutMs: 15000 })`. With these nodes
the reader read a real frame 73,700 blocks back (2026-09-27). The reader's tests include recorded answers from
publicnode and the dataseed nodes. The relay transport does not depend on any of this.

## 5. Read privacy

Experimental in 1.0: the options, defaults and `stats().privacy` below may change in a 1.x minor release.

`busTransport` and `busReader` ask every node for your rooms by name: one `eth_getLogs` whose room topic lists them,
sent to each of the 2 to 4 operators of the client. Each node therefore sees "this IP reads these rooms", and an inbox
room is derived from a container address (`channel.inboxRoom`), so the node can put a container on the IP.
`busPrivacy.busPrivacyReader` takes the same options and returns the same reader as `busReader`, and changes only what
the nodes are asked. It lowers how easily a node links your IP to your rooms; it does not hide that you read ChannelBus,
when, or how much.

```js
import { busPrivacy, channel, createRpc, BUS_RPC_URLS, MAINNET } from '@tapeapi/sdk'

const rpc = createRpc({ urls: BUS_RPC_URLS, quorum: 2, timeoutMs: 15000 })
const reader = busPrivacy.busPrivacyReader({
  rpc, bus: MAINNET.channelBus,
  rooms: [channel.inboxRoom(myContainer)],
  cover: { store: myStore },      // any { get, set }: keeps the same covers across restarts, should it fall back
})
reader.start((wire, { room }) => { /* only your rooms' frames arrive here */ })
console.log(reader.stats().privacy)   // { mode, k, effectiveK, short, pool, fallback, ... }
```

| `mode` | What each node sees | Cost |
|---|---|---|
| `'contract'` (default) | No room at all: every frame on the bus is downloaded and filtered on your machine. The node learns only "this IP reads ChannelBus". | All the bus's traffic, bounded per poll by `contract.maxBytes` / `maxLogs` (8 MiB, 10,000 logs, counted over every node's answer). Over it, the reader falls back to `'cover'` and says so (`contract.onExceed: 'error'` stops it with `BUS_BUDGET` instead). |
| `'cover'` | Each of your rooms among `k` rooms (default 8): yours plus `k − 1` rooms other people really used on the bus, in a fresh random order on every request. | You download the frames of the cover rooms too (dropped at once, never decrypted or kept). |
| `'plain'` | Your rooms by name: `busReader` as before. | None. |

**Why `'contract'` is the default.** On 2026-09-28 the mainnet ChannelBus had carried one log in 500,000 blocks (the
deploy probe), so there were no rooms to draw covers from, while reading the whole contract cost almost nothing. Pass
`mode: 'cover'` or `'plain'` to choose otherwise; both behave as before.

**The first read.** `'contract'` needs no cover pool: the first poll reads the `lookback` window (600 blocks by default,
or from your `fromBlock`; lower `lookback` to wait less) with one request per node on 48 Club, a few seconds (each node
is read on its own, and one that answers is enough; 1RPC's 50-block limit splits its share further). `'cover'` must first
read its pool: one
request per 5,000 blocks (48 Club's limit), 3 to 6 s each on 2026-09-28, so with the default 40,000 blocks
(`cover.scanBlocks`) a fresh process waits about 25 to 50 s before its first frame. Lower `cover.scanBlocks` (5,000 is
one request) or keep `cover.store`, and a restart reads only the blocks since the last save. 1RPC takes at most 50
blocks per request, so without 48 Club the pool scan fails and covers come from `cover.pool` alone (with a warning).

**Falling back, and coming back.** Anyone can post junk frames (about 100 MB for 100 USD of gas), and every
contract-wide reader has to download them: the budget turns that into a fallback to `'cover'`, announced to `warn`
(`... Switched to 'cover' mode ...`). The covers drawn then come first from rooms seen in quiet `'contract'` polls, never
from the junk that caused the fallback (a spammer's own rooms are the covers it would recognise), so a fallback waits
for no full scan. The reader returns to `'contract'` by itself (`... back to 'contract' mode ...`), with hysteresis:
it leaves above the budget, and comes back only after `contract.retryMs` in `'cover'` (30 min, doubled after each relapse
soon after a return, at most 24 h) **and** once a pool refresh made after the fallback shows a poll's traffic at or
under **half** the budget. Coming back is worth it because `'contract'` names no room; the switching itself reveals
little, because the covers are drawn once and kept, so every stretch in `'cover'` shows the same sets, and every default
reader switches at the same moments. `contract.retryMs: null` stays in `'cover'`. `stats().privacy.fallback` says when
it fell back and when it may return.

**What `k` means.** From one request in `'cover'` mode, a node's best guess of which room is yours is 1 in `k`. `k = 8`
is the default because the cost grows linearly (the frames of `k − 1` other rooms per room of yours, and a pool that
large) while the attacks listed below do not get weaker with a larger `k`. Requests carry at most 128 room topics
(`cover.maxTopics`; the BUS_RPC_URLS nodes accepted 256 and refused 1,024 on 2026-09-28), which fits 16 rooms of yours
at `k = 8`.

**Where covers come from, and why they stay.** The pool is the rooms seen in the bus's logs over the last 40,000 blocks
(about 5 hours), read with queries that name no room, plus the rooms quiet `'contract'` polls saw, plus any rooms you
pass in `cover.pool`, for example `channel.inboxRoom()` of containers you know. Covers are drawn at random when a room
is first read in `'cover'` mode and then kept: for the life of the reader, and across restarts with `cover.store`.
Changing them would give them away: two requests a node can link (same IP, or simply the same rooms of yours) reveal
what they have in common, and if the covers changed while your rooms did not, that is exactly your rooms. A room added
later is caught up among its own covers; removing a room removes its covers; re-adding it brings the same ones back.

**When the pool is too small** the reader never pretends. It reads with the covers it has, reports `effectiveK` and
`short` in `stats().privacy`, and tells `warn` once per change: `only N cover rooms ... 1 in E, not 1 in 8`, or
`no cover rooms available ... the nodes see exactly which rooms this reader reads`. With `cover.onShort: 'error'` it
throws `BUS_PRIVACY` instead, before any request naming a room is sent. Today that is what a fallback to `'cover'`
meets unless you pass `cover.pool`.

What it helps against, and what it does not:

- `'contract'` names no room; `'cover'` leaves a node that reads your requests one at a time unable to tell your room
  from the covers.
- **Junk forces the fallback.** Whoever fills the bus past the budget makes default readers name their rooms among
  covers for a while; the doubling wait bounds how often that can be repeated, not whether.
- **An invite, then a new room.** When an invite lands in one of your rooms and the reader adds a channel room soon
  after, a node can link the two in `'cover'` mode. Adding rooms after a random delay, or registering spare rooms ahead,
  makes this harder, not impossible.
- **The pool's source.** The pool rule is public, so a room you read that is not in the recent-activity pool stands out;
  a node that lies during the pool scan can plant rooms it knows are fake; anyone can post to rooms of their own for
  about 50,000 gas each and fill the pool with covers they recognise.
- **Sessions without a store.** A new reader without `cover.store` draws new covers, and a node that sees both sessions
  finds your rooms in their intersection.
- Timing, IP address and volume are not hidden from the nodes you query. Reading through a node you run yourself shows
  these requests to no third party.

## 6. Limits

- A frame carries up to 16 KiB of plaintext; an invite lives at most one hour.
- Relays see room names, sizes and timing, never content or identities. ChannelBus makes that metadata public for
  ever.
- Re-handshake long before 2^32 frames in one direction (the SDK refuses to go further).
