# Call a service

This guide shows how an application finds a TapeAPI service, calls it and knows the answer is genuine. It uses
`@tapeapi/sdk`, which works in Node 20+, browsers, DeWEB sites and Cloudflare Workers.

## 1. Try it

### Set up once

The packages are not on npm yet, so you work inside a clone of the repository (Node.js 20 or later):

```bash
git clone https://github.com/BruceLanLan/tapeapi.git && cd tapeapi && npm install
```

Or install just the SDK into your own project from the GitHub release (not the npm registry):

```bash
npm install https://github.com/BruceLanLan/tapeapi/releases/download/v1.8.0/tapeapi-sdk-1.8.0.tgz
```

Save the scripts below as `.mjs` files where `@tapeapi/sdk` resolves, and run them with `node <file>.mjs`: in a clone,
**inside the `tapeapi` directory** (the package resolves through the repository's workspace); after installing the
release package, in that project. Anywhere else a script fails with `ERR_MODULE_NOT_FOUND`.

### Call the live public service

A free public service runs at `https://api.tapeapi.fun` under the TapeOut name `11.1013.tape`. With curl:

```bash
curl -s https://api.tapeapi.fun/tapeapi/v1/bnbUsd -H 'content-type: application/json' -d '{"id":"1","params":{}}'
```

curl shows you the signed envelope (`result`, `container`, `ts`, `block`, `sig`) but does not verify it. The SDK
resolves the service from the chain and verifies the answer before it returns:

```js
import { createTapeAPI } from '@tapeapi/sdk'

const api = createTapeAPI({
  rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-mainnet.public.blastapi.io', 'https://rpc-bsc.48.club'],
  quorum: 2,
})
const svc = await api.resolve('11.1013.tape')
const { result, verified } = await api.call(svc, 'bnbUsd', {})
console.log(result, verified)
```

The [playground](https://tapeapi.fun/playground/) runs the same SDK in a browser with nothing to install, and
[Public API](public-api.md) lists every method of the public service.

### Run a service locally

Start the minimal example service. It reads BNB Chain through public nodes and signs with a throwaway key:

```bash
node examples/reader-service/index.mjs          # :8787
```

```js
import { createTapeAPI } from '@tapeapi/sdk'

const api = createTapeAPI({ dev: true })          // dev: accept a local http:// service without an on-chain manifest
const svc = await api.resolve({ dev: 'http://127.0.0.1:8787' })
const { result, block, verified } = await api.call(svc, 'blockNumber', {})
console.log(result.blockNumber, block, verified)
```

`api.call` returns only after the signed envelope has been checked. If the answer was altered in transit, signed by
another key or is older than five minutes, you get a `TapeAPIError`, never a result.

## 2. Resolve a real service on BNB Chain

On mainnet the SDK reads everything it trusts from the chain, through several RPC nodes that must agree:

```js
const api = createTapeAPI({
  rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-mainnet.public.blastapi.io', 'https://rpc-bsc.48.club'],
  quorum: 2,
})

const byName = await api.resolve('11.1013.tape')                   // <#ID>.<processor>.tape
const byContainer = await api.resolve('0x<container address>')
const byCircuit = await api.resolve({ circuits: '0x<processor contract>', tokenId: '11' })
```

A TapeOut name `<#ID>.<processor>.tape` is read from the chain too: the processor number gives the processor contract
(`factory.cpuAt`), and that contract with `#ID` gives the container (`DeWebHub.accountOf`). It adds no trust beyond the
`{ circuits, tokenId }` form; the three forms above reach the same checks.

Resolution ([TAPI-20 §3.6](../../spec/TAPI-20.md)) does, in order:

1. derives the container from the circuit (`DeWebHub.accountOf`) and checks the processor is a real TapeOut one
   (`factory.isCPU`), so a counterfeit NFT cannot pose as a service;
2. reads `.well-known/tapeapi.json` from the container's site and checks its length and SHA-256 against the chain;
3. validates the manifest;
4. checks the circuit holder's EIP-712 delegation of the service's signing key, against the **current** holder.

A resolved service is cached; the SDK re-reads it about once an hour, and at once when a signature or a price stops
matching. `api.refresh(svc)` forces it.

## 3. Handle errors

Every failure is a `TapeAPIError` with a stable `code`:

```js
import { TapeAPIError } from '@tapeapi/sdk'

try {
  await api.call(svc, 'quote', { symbol: 'BNB' })
} catch (e) {
  if (!(e instanceof TapeAPIError)) throw e
  console.error(e.code, e.message, e.signed ? '(signed by the service)' : '')
}
```

| Code | Meaning | What to do |
|---|---|---|
| `INVALID_ARGUMENT` | Your own options or arguments are wrong (a missing `rpcUrls`, an unsupported target, a bad option). Nothing was sent. | Fix the call; never retry it. |
| `RPC_UNAVAILABLE` | Fewer RPC nodes answered than the quorum. | Retry; add a node. |
| `RPC_DISAGREE` | Nodes returned different bytes. | Retry; if it persists, one node is lagging or lying. |
| `MANIFEST_INVALID` | No manifest, a bad one, or its bytes do not match the chain. | The service is not (correctly) published. |
| `DELEGATION_INVALID` | The signing key is not authorised by the current holder, or the delegation expired. | The provider must renew. |
| `BAD_SIGNATURE` | The answer is not signed by the delegated key. | Do not use it. The SDK re-reads the manifest once in case the key was rotated. |
| `METHOD_NOT_FOUND` | The manifest has no such method. | Check `svc.manifest.methods`. |
| `PRICE_CHANGED` | The price rose above what you accepted. | Ask your user, then `api.acceptPrice(svc, method)` or pass `{ maxPrice }`. |
| `QUORUM_FAILED` | Providers in `callQuorum` did not agree. | Treat as no answer. |

The full list is in [Upgrading to 1.0](upgrade-1.0.md#error-codes) and [TAPI-21](../../spec/TAPI-21.md). Errors sent by the service are signed too (`e.signed`).

## 4. Require agreement between providers

One service's signed answer proves who said it, not that it is true. For values that matter, ask independent
providers for the same block and accept only identical bytes:

```js
const [a, b] = await Promise.all([api.resolve('0x<container A>'), api.resolve('0x<container B>')])
const first = await api.call(a, 'bnbUsd', {})
const block = first.result.blockPinned.blockNumber            // pin every provider to the same block
const q = await api.callQuorum([a, b], 'bnbUsd', { block }, { quorum: 2 })
console.log(q.result, 'agreed by', q.agreed)                  // else TapeAPIError('QUORUM_FAILED')
```

Only methods whose description starts with `[quorum]` can be compared this way; `[no-quorum]` methods (quotes with a
random id, `latest` reads) differ by design. A protocol that consumes a single-source value should still apply bounds,
freshness checks and a circuit breaker.

## 5. Pay for calls

> **Experimental.** Payments (TAPI-22 payment channels and the escrow contract) are not deployed or audited and are not covered by the 1.0 stability promise: the names below may change in a 1.x minor release. See [Upgrading to 1.0](upgrade-1.0.md#what-10-promises).

Free methods need nothing. Paid methods take a voucher signed by the consumer ([TAPI-22](../../spec/TAPI-22.md)):

```js
const consumer = '0x<your address>'                             // the wallet account that signs the vouchers
const payer = api.payer({
  consumer,
  signTypedData: (typed) => wallet.request({ method: 'eth_signTypedData_v4', params: [consumer, JSON.stringify(typed)] }),
})
const r = await api.call(svc, 'pairPrice', { pair: '0x…' }, { payer })
```

To avoid a wallet prompt per call, authorise a session key once (`api.tx.authorizeSession(svc, sessionAddress,
expires)`) and pass `{ consumer, sessionKey, sessionExpiry }` instead. Funding the channel takes two transactions the
SDK builds for your wallet: `await api.tx.approve({ amount, spender: svc })` then `await api.tx.fund(svc, amount)`. Both
read the escrow's token on chain first, and both are built only for an escrow on the SDK's list of audited deployments
(empty: none is audited yet) or one you add yourself with `createTapeAPI({ allowEscrows: [...] })`, because an approval
lets that contract pull your tokens. `amount` is in the token's own base units: read the token with
`api.chain.escrow.paymentToken(svc)` (its decimals come from the token, never assumed) and show amounts with
`formatPaymentAmount(amount, token)`. Manifest prices are `priceBEM`, so the SDK refuses to fund or pay a service whose
escrow holds another token (`UNSUPPORTED_PAYMENT_TOKEN`, `reason` `not-bem`): the escrow contract itself takes any
admitted token, but the manifest's pricing in more than one token is not yet specified, so `fund` is never built for an
escrow that holds anything but BEM, whatever token you name, and even if you allowed that escrow.

You pay the provider's listed price and nothing more: TapeAPI adds no fee on the consumer side. The maintenance
contribution, if the provider keeps it, comes out of the provider's share ([`docs/FEES.md`](../FEES.md)). A paid
call settles in the token of the escrow instance it uses: the next escrow version plans USDT (Binance-Peg) on BNB Smart Chain first, with BEM and WBNB (wrapped BNB) on demand, from the same bytecode ([`docs/FEES.md`](../FEES.md)). Prices in a manifest are still written in BEM (`priceBEM`) until a form for other tokens is specified, so this SDK builds paid calls only for an escrow that holds BEM.

> The escrow contract is not deployed yet, so paid services are not live on mainnet. Everything above works against
> the examples (`FREE_ALL=1` to skip payment locally).

The SDK advances its local meter only after a verified answer and resynchronises automatically if the provider's
count differs. Pass `store: { get, set }` to keep the meter across restarts.

## 6. Use it in a browser or a DeWEB site

The SDK is plain ES modules. On a DeWEB site, import it by relative path and map `@noble/*` with an import map; a
complete page is in [`examples/demo-site/`](../../examples/demo-site/) and more snippets are in
[`examples/consumer-snippets.md`](../../examples/consumer-snippets.md).

## 7. Resolve and call services for people you do not trust

A verify site, an agent, or any server that resolves and calls whatever service a user names makes requests to URLs a
stranger wrote: the endpoints in a manifest are whatever the holder published. The SDK checks that they are `https`
URLs (or `http` in dev); it does **not** refuse private or internal addresses. `https://127.0.0.1/`, `https://[::1]/`
and `https://169.254.169.254/` are valid `endpoints.live` entries, and a name can resolve to a private address too. On
your own machine that is what you want; on a server it lets a user aim your server at its own network.

Such a deployment should pass `createTapeAPI({ fetch })` a wrapper that refuses private targets. The same `fetch` carries
the RPC requests, so allow your own nodes explicitly:

```js
import { createTapeAPI } from '@tapeapi/sdk'

// Hosts of your own that may be private (your RPC node, say); everything else is refused when it is.
const ALLOWED = new Set(['rpc.internal.example:8545'])
const isPrivate = (host) => {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (h === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h)) return true
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return /^(0|10|127|169\.254|172\.(1[6-9]|2\d|3[01])|192\.168|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\./.test(h)
  return h.includes(':') && (h === '::' || h === '::1' || /^(f[cd]|fe[89ab])/.test(h) || h.startsWith('::ffff:'))
}
const guardedFetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (!ALLOWED.has(url.host) && isPrivate(url.hostname)) return Promise.reject(new TypeError(`refused: ${url.origin} is a private address`))
  return fetch(input, { ...init, redirect: 'error' })   // and no redirect from a public host to a private one
}
const api = createTapeAPI({ rpcUrls: [/* ... */], fetch: guardedFetch })
```

This checks the URL as written. A public name that resolves to a private address gets past it: on a server, enforce the
rule where the connection is made as well (a resolver hook in your HTTP agent, or an egress proxy or firewall that
refuses private ranges). A browser applies its own rules to pages, so this matters for servers and agents.

## Verify without the SDK

Any language can check an answer. For a request `{ id, params }` sent to method `m` of container `c`, the service
signs, with EIP-191 `personal_sign`:

```
digest = keccak256( "TAPI-1/resp/v2" ‖ c ‖ keccak256(id) ‖ keccak256(canonicalJSON({method: m, params}))
                    ‖ uint8(ok) ‖ keccak256(canonicalJSON(result or error)) ‖ uint64BE(ts) )
```

Recover the signer (low-s only), compare it with `manifest.signer`, check that the holder's delegation names that
signer, and that `|now - ts| <= 300`. Canonical JSON is defined in [TAPI-21](../../spec/TAPI-21.md); test vectors and an
independent Python implementation are in [`spec/vectors/`](../../spec/vectors/).
