# FAQ and troubleshooting

## General

**Do I need to deploy a contract to run a free service?**
No. Identity, the manifest and the delegation all use TapeOut's deployed contracts (DeWebHub, SiteRegistry, the
processor factory). Only paid services need the escrow, and on-chain channels need ChannelBus.

**Does TapeAPI take a fee?**
Not today: every live method is free, and the paid-call escrow is not deployed yet (it will be only after an
independent audit). There is no mandatory protocol fee and no operator fee switch. When paid calls settle through the
TapeAPI escrow, a default 1% maintenance contribution comes out of the provider's share; the consumer's price does not
change. Any provider can set it to 0 (or up to 50%) for its own service, and calls work the same either way. See
[`docs/FEES.md`](../FEES.md).

**What happens if I sell or transfer the circuit?**
The service goes with it: the container, its site and the right to sign delegations. The old holder's delegation
stops being accepted, because clients check it against the current holder.

**Which chain?**
BNB Smart Chain (chainId 56), where TapeOut lives.

## Calling services

**`ERR_MODULE_NOT_FOUND: Cannot find package '@tapeapi/sdk'`** — the packages are not on npm yet and resolve through the
repository's workspace. Clone the repository, run `npm install` in it, and save your script inside the `tapeapi`
directory ([Call a service](consume.md)).

**`MANIFEST_INVALID: ... does not match`** — the file in the container's site differs from its on-chain hash, or
there is no manifest. The service is not correctly published.

**`DELEGATION_INVALID`** — the delegation expired, or the circuit changed hands since it was signed. The provider has
to sign a new one and publish the manifest again ([Renew](provide.md#4-renew)).

**`RPC_UNAVAILABLE: only 1/2 nodes answered`** — use at least three RPC URLs with `quorum: 2`, so one node down still
leaves a quorum. `allowSingleNode: true` exists for local development only.

**`RPC_DISAGREE`** — nodes returned different bytes for the same read. The SDK retries once; if it persists, one node
is behind or misbehaving.

**The answer's `ts` is rejected** — your clock, or the service's, is more than 300 s off. Fix the clock; the window
(`maxSkewS`) protects against replayed answers.

## Running services

**The console says the service reports a different key than the one generated here.**
The service's `SIGNER_KEY` is not the key generated on that page (pasted twice, an old key, or the wrong service URL).
Paste the key generated in step 3 again (or generate a new one there) and wait for the redeploy.

**The console refuses to publish: "unexpected field" / "expected ...".**
The manifest the service serves differs from what you read and signed. Usually a variable has not taken effect yet;
wait a minute and retry.

**`putFile` reverts with `NotOwner`.**
The container is not opened, or the wallet is not the circuit's holder. Open the container on the circuit's page
(0.012 BNB).

**My wallet swaps BNB into WBNB.**
Gas is paid only in native BNB. Keep a little native BNB in the holder's wallet.

## On-chain channels

**The reader fails with `no node serves logs`.**
It started further back than the nodes keep history (publicnode: about 10,000 blocks). Frames in that range cannot be
read from those nodes; start from a newer block or add an archive node. The BNB Chain dataseed nodes (the example
default) do not serve `eth_getLogs` at all: read ChannelBus with the SDK's `BUS_RPC_URLS` (48 Club and 1RPC keep at
least 500,000 blocks of logs). The relay transport does not depend on this.

**The reader holds for a long time.**
A node is failing on the blocks the cursor is at. Holding is deliberate: a frame is never skipped while some node may
still have it. After `SERVED_DECAY` (20) polls without an answer, the node is no longer waited for and you are told.

**Are my messages private on ChannelBus?**
The content is end-to-end encrypted. The room, the size and the time of each message are public for ever.

## Getting help

Open an issue on GitHub for bugs and questions. For security problems, follow [SECURITY.md](../../SECURITY.md) and do
not open a public issue.
