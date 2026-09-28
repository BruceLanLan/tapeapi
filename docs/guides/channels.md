# Private channels

A Tape Channel ([TAP-26](../../spec/TAP-26.md)) is an end-to-end encrypted, mutually authenticated channel between two
TapeOut containers. Whatever carries it (a relay service, a WebRTC connection or the chain itself) only ever sees
ciphertext and cannot forge, reorder or replay frames without being caught. Groups of up to 32 containers are
[TAP-27](../../spec/TAP-27.md); to add them to an application, see [Group chat](groups.md).

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
| **Relay** (default) | Low latency, no gas. A relay is an ordinary TapeAPI service that stores ciphertext per room. | `channel.relayTransport({ api, svc, inbound, outbound })` |
| **ChannelBus** | No server to trust or keep running; every message is a transaction (about 50,000 gas). | `channel.busTransport({ rpc, bus: MAINNET.channelBus, inbound, outbound, sendTx })` |
| **Several at once** | The responder may answer on any transport the invite names, so listen on all of them. | `channel.fanIn([t1, t2])` |

A free public relay runs at `https://relay.tapeapi.fun` (TapeOut name `12.1013.tape`); how to name it in an invite and
carry a channel over it is in [Public API](public-api.md), under "The public relay". To run your own relay:
[`examples/relay-service/`](../../examples/relay-service/) (Node) or
[`examples/cloudflare-worker/`](../../examples/cloudflare-worker/) (one Durable Object per room). Check any relay with
`node conformance/relay.mjs --url <relay>`.

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

## 5. Limits

- A frame carries up to 16 KiB of plaintext; an invite lives at most one hour.
- Relays see room names, sizes and timing, never content or identities. ChannelBus makes that metadata public for
  ever.
- Re-handshake long before 2^32 frames in one direction (the SDK refuses to go further).
