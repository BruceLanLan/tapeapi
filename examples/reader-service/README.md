# TapeOut Reader — example TapeAPI provider

A minimal provider built on `@tapeapi/server`. It exposes three methods:

| method          | price        | what it does                                              |
|-----------------|--------------|-----------------------------------------------------------|
| `blockNumber`   | free         | current BSC block (quorum of the configured RPC nodes)    |
| `circuitHolder` | 0.0001 BEM   | `IERC721(circuits).ownerOf(tokenId)` read via RPC         |
| `bemBalance`    | free         | BEM (ERC-20) balance of an address                        |

Every response (and every error) is a TAP-21 envelope signed by the provider's signer key, so
clients can verify it offline against `manifest.signer`.

## Run

From the `tapeapi/` monorepo root (so the workspace `node_modules` resolves):

```sh
npm install --no-audit --no-fund          # once
node examples/reader-service/index.mjs    # dev mode on :8787 with an ephemeral signer key
```

Environment variables:

| var                 | default                                       | meaning                                                   |
|---------------------|-----------------------------------------------|-----------------------------------------------------------|
| `SIGNER_KEY`        | a random key for this run (never printed; only its `signer` address is) | 32-byte hex private key that signs response envelopes; required once `DELEGATION_SIG` is set |
| `RPC_URLS`          | `bsc-dataseed.bnbchain.org`, `bsc-mainnet.public.blastapi.io`, `rpc-bsc.48.club` (the SDK's `rpcUrlsFor(56)`) | comma-separated JSON-RPC urls (three operators, 2-of-3; URLs of one operator count once) |
| `QUORUM`            | `min(2, RPC_URLS.length)`                     | how many node operators must agree on every `eth_call`    |
| `PORT` / `HOST`     | `8787` / `127.0.0.1`                          | listen address; loopback only by default, set `HOST=0.0.0.0` to accept connections from your network |
| `PUBLIC_URL`        | `http://127.0.0.1:$PORT`                      | base url advertised in `manifest.endpoints.live`; must be `https://` once `DELEGATION_SIG` is set, or the service refuses to start |
| `CONTAINER`         | placeholder `0x000…`                          | ERC-6551 container = `DeWebHub.accountOf(circuits, tokenId)` |
| `CIRCUITS` / `TOKEN_ID` | placeholders                              | the circuit that owns this service                        |
| `ESCROW`            | placeholder                                   | `TapeAPIEscrow` address (payment.escrow)                  |
| `DELEGATION_SIG` / `DELEGATION_EXPIRES` | unset → dev mode         | holder's EIP-712 delegation for `SIGNER_KEY`'s address    |
| `CHAIN_ID` / `BEM`  | `56` / mainnet BEM                            |                                                           |
| `FREE_ALL`          | unset                                         | `1` makes every method free (dev manifests only), so the paid path runs without a chain |

Check it is alive:

```sh
curl -s http://127.0.0.1:8787/.well-known/tapeapi.json | jq .
curl -s http://127.0.0.1:8787/tapeapi/v1/health
curl -s -X POST http://127.0.0.1:8787/tapeapi/v1/blockNumber -H 'content-type: application/json' -d '{"id":"1","params":{}}'
curl -s -X POST http://127.0.0.1:8787/tapeapi/v1/bemBalance   -H 'content-type: application/json' \
  -d '{"id":"2","params":{"address":"0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a"}}'
```

`bemBalance` returns both `raw` (the integer the contract holds) and `balance` (the same number with
BEM's **8** on-chain decimals applied — not 18, which is the usual ERC-20 assumption and would be off
by a factor of 10^10).

`manifest.json` ships with `"dev": true` and zero-address placeholders for `container`, `escrow`
and `circuits`. In dev mode the SDK (`api.resolve({ dev: 'http://127.0.0.1:8787' })`) skips the
on-chain holder check; paid methods still need a valid voucher and a reachable escrow, so with the
placeholder escrow only the free methods work.

## Going live: produce the delegation signature

The manifest must carry a `delegation` proving that the circuit holder authorised the signer key.
It is an EIP-712 signature (domain `TapeAPI` v1, chainId 56, **verifyingContract = DeWebHub**)
over `Delegation{container, signer, expires}`, signed by `IERC721(circuits).ownerOf(tokenId)`.
The domain is anchored on the hub, not on a ServiceDirectory: a delegation is just holder consent and
is meaningful before any directory exists (TAP-20 §3.4). Signing against the wrong `verifyingContract`
produces a signature that will never verify.

1. Start the provider once with a fixed `SIGNER_KEY` and note the printed `signer` address (the key itself is
   never printed).
2. On a machine holding the circuit holder's key run:

   ```sh
   HOLDER_KEY=0x<holder private key> node examples/reader-service/sign-delegation.mjs \
     --container 0x<container> --signer 0x<signer address> \
     --expires $(( $(date +%s) + 30*86400 )) \
     --hub 0x<DeWebHub>                            # defaults to the mainnet hub if omitted
   ```

   It prints the signature and a ready-to-paste `DELEGATION_EXPIRES=… DELEGATION_SIG=…` line.
   The script never sends the key anywhere; it only signs locally.

3. Restart the provider with `CONTAINER`, `CIRCUITS`, `TOKEN_ID`, `ESCROW`, `PUBLIC_URL`,
   `DELEGATION_SIG`, `DELEGATION_EXPIRES` set. The served manifest now has `"dev": false`.
4. Publish the served manifest to the container's DeWEB site: `api.tx.publishManifest({ container, manifest })`
   returns the transactions for the holder to sign. The registry key is `.well-known/tapeapi.json`, with **no
   leading slash**. Clients can then resolve the service by container, by `{ circuits, tokenId }` or by its TapeOut
   name `<#ID>.<processor>.tape`; no registration is needed (the ServiceDirectory, where
   `api.tx.register(...)` would add a label, is not deployed).

## Settlement

Vouchers accumulate in the provider's store (in-memory by default; pass `store` to persist).
`provider.pendingSettlements()` lists the latest voucher per consumer and `provider.settleTx(v)`
builds the `TapeAPIEscrow.settle` calldata; anyone can submit it.
