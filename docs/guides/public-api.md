# Public API

TapeAPI runs a free public service at `https://api.tapeapi.fun`: signed, block-pinned reads of BNB Smart Chain and of
TapeOut itself, with no sign-up and no key. Next to it runs a free public relay for private channels. Both are
ordinary TapeAPI services; this guide shows what they offer and how to call them.

| Service | Identity | Container | Endpoint |
|---|---|---|---|
| Public API | `11.1013.tape` | `0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8` | `https://api.tapeapi.fun/tapeapi/v1` |
| Public relay | `12.1013.tape` | `0x9cD838625251576c199B2DeF7A17e50266843185` | `https://relay.tapeapi.fun/tapeapi/v1` |

Both circuits are on processor 1013, contract `0xe02c26c7432A7121168AA9B610DE24eCf9a1a414`.

## What it is

- **Free, no key.** Every method costs 0 BEM. You just call it.
- **Signed.** Every answer, errors included, is an envelope signed by the key that the holder of `11.1013.tape`
  authorised on chain ([TAP-21](../../spec/TAP-21.md)). The SDK checks the signature, the delegation and the holder
  before it returns a result.
- **Block-pinned.** Every method except `blockNumber` reads the chain at one block, by default the latest `finalized`
  one, and says which in `blockPinned { blockNumber, blockHash, blockRef }`. The service reads through three BNB
  Chain node operators and needs two of them to agree.
- **Rate limit.** 600 free calls per minute per IP address, in a fixed one-minute window counted per server instance.
  Past it the service answers HTTP 429 with a `retry-after` header (unsigned, code `RATE_LIMITED`); the SDK throws
  `TapeAPIError('RATE_LIMITED')` with `e.data.retryAfterS`.

It is a public good, not a platform. The service is the example in
[`examples/public-api/`](../../examples/public-api/), and anyone can run an equivalent one under their own circuit
([Run a service](provide.md)). More independent providers of the same methods is exactly what makes cross-checking
possible (see below).

## Call it with the SDK

```js
import { createTapeAPI } from '@tapeapi/sdk'

const api = createTapeAPI({
  rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-mainnet.public.blastapi.io', 'https://rpc-bsc.48.club'],
  quorum: 2,
})

const svc = await api.resolve('11.1013.tape')   // <#ID>.<processor>.tape
const { result, block, verified } = await api.call(svc, 'bnbUsd', {})
console.log(result.bnbUsd, result.blockPinned.blockNumber, verified)
```

`api.resolve` does not trust the web server: it derives the container from the circuit, reads the manifest from the
container's on-chain site and checks it against the chain, then checks the holder's delegation of the signing key
([Call a service](consume.md) explains each step). The container address
`api.resolve('0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8')` or `api.resolve({ circuits: '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', tokenId: '11' })`
gives the same service.

## Call it with curl

A request is `POST {endpoint}/{method}` with a JSON body `{ "id", "params" }`. The `id` is any string of 1 to 128
characters and comes back in the answer; `params` is a JSON object.

```bash
curl -s -X POST https://api.tapeapi.fun/tapeapi/v1/bnbUsd \
  -H 'content-type: application/json' \
  -d '{"id":"doc1","params":{}}'
```

A real answer (hashes and the signature shortened):

```json
{
  "id": "doc1",
  "ok": true,
  "result": {
    "bnbUsd": "774.349742334346733873",
    "pair": "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE",
    "blockPinned": { "blockNumber": 124183697, "blockHash": "0xb49b…5d25", "blockRef": "hash" }
  },
  "container": "0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8",
  "ts": 1790444986,
  "block": 124183699,
  "sig": "0x9f96…bd1c"
}
```

Two block numbers appear. `result.blockPinned.blockNumber` is the block the read was evaluated at (the finalized
block by default); the envelope's `block` is the chain head the service saw when it signed. `blockRef: "hash"` means
the nodes evaluated the read at that exact `blockHash`; `"number"` would mean a node refused that and the read was
made by block number only, which [TAP-23](../../spec/TAP-23.md) treats as weaker evidence.

A failed call is signed too:

```json
{ "id": "doc4", "ok": false, "error": { "code": "BAD_REQUEST", "message": "address must be a 0x address of 40 hex digits" },
  "container": "0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8", "ts": 1790445009, "block": 124183752, "sig": "0xe154…1c" }
```

**curl alone verifies nothing.** Anyone between you and the service could change these bytes. To trust an answer,
use the SDK, or recover the signer yourself as described at the end of [Call a service](consume.md) and compare it
with the signer the holder delegated on chain. The copy of the manifest at
`https://api.tapeapi.fun/.well-known/tapeapi.json` is a convenience for reading; the SDK uses the one on chain.

## Use it from an AI assistant (MCP)

The same eight methods are MCP tools at `https://api.tapeapi.fun/mcp` (Streamable HTTP, no key). Add the URL to
Claude, Cursor or any MCP client. Each result carries a receipt and a verification link, and a local command can check
every answer against the chain before the model sees it. See [MCP](mcp.md).

## Methods

Every method is free. `block` is optional everywhere it appears: a block number, or `'finalized'` (the default),
`'safe'` or `'latest'`. Addresses in answers are checksummed; large numbers are decimal strings.

| Method | Params | Returns | Example params |
|---|---|---|---|
| `blockNumber` | none | `blockNumber`: the latest block the nodes agree on. Not block-pinned, not for quorum. | `{}` |
| `balance` | `address`, `block?` | `address`, `wei`, `bnb` (native BNB), `blockPinned` | `{ "address": "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE" }` |
| `tokenInfo` | `token`, `block?` | `token`, `name`, `symbol` (each `string` or `null`), `decimals`, `totalSupply`, `blockPinned` | `{ "token": "0x55d398326f99059fF775485246999027B3197955" }` |
| `tokenBalance` | `token`, `address`, `block?` | `token`, `address`, `raw`, `amount` (in token units), `symbol`, `decimals`, `blockPinned` | `{ "token": "0x55d398326f99059fF775485246999027B3197955", "address": "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE" }` |
| `nftOwner` | `contract`, `tokenId` (decimal string), `block?` | `contract`, `tokenId`, `owner`, `blockPinned` | `{ "contract": "0xe02c26c7432A7121168AA9B610DE24eCf9a1a414", "tokenId": "11" }` |
| `pairPrice` | `pair` (a PancakeSwap V2 pair), `block?` | `pair`, `token0` and `token1` (`address`, `symbol`, `decimals`), `reserves` (`reserve0`, `reserve1`, `blockTimestampLast`), `price` (`token0InToken1`, `token1InToken0`), `blockPinned` | `{ "pair": "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE" }` |
| `bnbUsd` | `block?` | `bnbUsd` (BNB in USDT from the PancakeSwap V2 WBNB/USDT pair), `pair`, `blockPinned` | `{}` |
| `tapeName` | `name` (`'<#ID>.<processor>.tape'`), or `processor` and `tokenId`; `block?` | `name`, `processor`, `tokenId`, `circuits`, `container`, `holder`, `opened`, `tapeapi` and `channelKeys` (`{ path, size, sha256 }` of the published file, or `null`), `blockPinned` | `{ "name": "11.1013.tape" }` |

A bad parameter (not an address, a token that is not BEP-20, a circuit that does not exist) comes back as a signed
`BAD_REQUEST` with a message saying which. The live list, with the exact types, is the manifest's `methods`
(`svc.manifest.methods` after `api.resolve`).

## Prices and cross-checking

`pairPrice` and `bnbUsd` are **spot prices** computed from a pool's reserves at one block. A large trade can move
them within a block, so do not use them alone for liquidations or anything else an attacker profits from moving. A
protocol that relies on a price should add bounds, freshness checks, a time-weighted average and a circuit breaker.

A signed answer proves who said it, not that it is true. For values that matter, ask a second, independent provider
for the same block and accept only identical bytes. Every method whose description starts with `[quorum]` (all but
`blockNumber`) takes a numeric `block` for exactly this:

```js
const other = await api.resolve('0x<container of another provider>')
const first = await api.call(svc, 'bnbUsd', {})
const block = first.result.blockPinned.blockNumber
const q = await api.callQuorum([svc, other], 'bnbUsd', { block }, { quorum: 2 })
console.log(q.result.bnbUsd, 'agreed by', q.agreed)   // else TapeAPIError('QUORUM_FAILED')
```

`callQuorum` refuses services that share a container, a holder or an endpoint origin, since they are one source,
not two. Today `api.tapeapi.fun` is the only public provider of these methods, so the second one has to be run by
you or someone else, from [`examples/public-api/`](../../examples/public-api/) or your own code.

## The public relay

A relay carries [TAP-26](../../spec/TAP-26.md) private channels: two containers exchange end-to-end encrypted frames
through rooms on the relay, which stores ciphertext and never sees content or identities (it does see room names,
sizes and timing). The public relay at `https://relay.tapeapi.fun`, identity `12.1013.tape`, container
`0x9cD838625251576c199B2DeF7A17e50266843185`, offers `relaySend`, `relayHandshake` and `relayRecv`, all at zero
cost per message.

Name it in an invite, then carry the channel over it with `channel.relayTransport`:

```js
import { channel } from '@tapeapi/sdk'

const relay = await api.resolve('12.1013.tape')   // container 0x9cD838625251576c199B2DeF7A17e50266843185

const { invite, pending } = channel.createInvite({
  self: { container: A, chainId: 56, staticSecret: aKeys.secretKey },
  peer: { container: B, chainId: 56, staticPublic: bKeys.publicKey },
  relays: [{ url: 'https://relay.tapeapi.fun/tapeapi/v1', container: relay.container }],
})

// (the invite travels sealed to B; B accepts and posts the accept to the relay)
const rooms = channel.roomsFor(invite.cid)            // A's rooms, before the handshake completes
const link = channel.relayTransport({ api, service: relay, inbound: rooms.toInitiator, outbound: rooms.toResponder })
const [w] = await link.poll()
const { ready, session } = channel.completeInvite(pending, channel.decodeWire(w).handshake)
await link.send(channel.encodeWire(ready))
await link.send(channel.encodeWire(session.seal('hello')))
```

The responder opens its own transport on its session's rooms (`session.rooms.inbound`, `session.rooms.outbound`);
`link.start(onWire)` keeps polling in the background. To advertise the relay
in your container's channel keys, pass `--relay https://relay.tapeapi.fun/tapeapi/v1@0x9cD838625251576c199B2DeF7A17e50266843185`
to `scripts/channel-keys.mjs`. The full handshake, the other transports and running your own relay are in
[Private channels](channels.md).

## Limits and status

- Both services are free and run on a best-effort basis, with no SLA and no guarantee of uptime. Methods
  may be added; a change to the list is published on chain as a new manifest.
- A relay can drop frames or go offline; TAP-26 detects gaps but cannot refill them. Name more than one transport in
  an invite if the channel matters.
- For anything you depend on, run your own provider or relay as well, and cross-check.
