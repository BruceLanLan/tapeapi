# Run a service

This guide turns your code, or an API you already run, into a TapeAPI service anyone can verify. It covers the
concepts, a local run, going live (from a phone, or from a server), renewal and operations.

Already run an MCP server? A signing proxy lets you keep your server and your domain and add an on-chain identity, tool
definitions pinned on chain and a signature on every result: see
[Tape out your own MCP server](mcp.md#tape-out-your-own-mcp-server). The identity, delegation and publishing steps are
the ones below.

## The five things a live service needs

| Thing | What it is | Who makes it |
|---|---|---|
| **Circuit** | An NFT minted on a TapeOut processor. Whoever holds it owns the service. | You, on [tapeout.net](https://tapeout.net). |
| **Container** | The circuit's ERC-6551 account: the service's identity and address. It must be **opened** (0.012 BNB) before its site accepts files. | You, on the circuit's page. |
| **Signing key** | A hot key your server signs every answer with. It is not your wallet and holds no funds. | Generated for you (console) or by you. |
| **Delegation** | An EIP-712 signature by the circuit's holder: "this signing key speaks for my container until this date". No funds move. | The holder's wallet. |
| **Manifest** | `.well-known/tapeapi.json` in the container's site: endpoints, methods, prices, signing key and delegation. | Written on chain by the holder (one transaction). |

The container address is fixed by the circuit, so the manifest is the only thing you ever republish: to add methods,
change the endpoint, or renew the delegation.

## 1. Write the service and run it locally

`createProvider` does the protocol for you: request parsing, the signed envelope, errors, rate limits and, for paid
methods, voucher checks and metering. You write plain functions:

```js
import { readFile } from 'node:fs/promises'
import { createProvider } from '@tapeapi/server'

const provider = createProvider({
  manifest: JSON.parse(await readFile('manifest.json', 'utf8')),
  signerKey: process.env.SIGNER_KEY,
  dev: true,                                    // local run: http endpoint, no delegation yet; remove it to go live
  rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-mainnet.public.blastapi.io', 'https://rpc-bsc.48.club'],
  quorum: 2,
  methods: {
    blockNumber: async (_params, ctx) => ({ blockNumber: ctx.block }),
    quote: async ({ symbol }) => {
      if (!/^[A-Z]{2,10}$/.test(symbol)) throw Object.assign(new Error('bad symbol'), { code: 'BAD_REQUEST' })
      return fetch(`https://your.api/quote/${symbol}`).then((r) => r.json())
    },
  },
})
await provider.listen(8787)                     // Node
// On Cloudflare Workers: export default { fetch: (request) => provider.handleRequest(request) }
```

Start from a working example rather than a blank file:

- [`examples/reader-service/`](../../examples/reader-service/): the smallest complete service, with the delegation
  script.
- [`examples/web2-adapter/`](../../examples/web2-adapter/): one config file turns existing REST endpoints into methods;
  the upstream API key stays in an environment variable.
- [`examples/cloudflare-worker/`](../../examples/cloudflare-worker/): the same on Cloudflare Workers, deployable from a
  phone.

`dev: true` is what lets it run locally: an http endpoint, no delegation, priced methods without an escrow. A
manifest's own `dev` field switches nothing; remove the option when you go live. Clients connect to a dev service
with `createTapeAPI({ dev: true })`. Check it against the protocol with the black-box conformance suite:

```bash
node conformance/run.mjs --url http://127.0.0.1:8787
```

A dev service reports NOT CONFORMANT, and that is expected: it has no delegation (a MUST), and methods that need
parameters are skipped unless you pass them with `--params`. Run the suite again once the service is live with a
holder delegation; that is the result that counts.

## 2. Go live from a phone (Cloudflare + holder console)

This is the path with no server and no command line.

1. **Circuit and container.** On [tapeout.net](https://tapeout.net): create a processor, Tape Out a circuit, open its
   container (0.012 BNB). The container's `.tape` name works by itself; no name binding is needed.
2. **Deploy the service.** In the Cloudflare dashboard: Workers & Pages → Create → Workers → Import a repository → your
   fork of this repository. Build command `npm ci`, deploy command `npm run deploy:provider`. The Worker's name in the
   dashboard must match `name` in your fork's `examples/cloudflare-worker/wrangler.toml` (`my-tapeapi-service`; change
   both if you want another). The Worker starts in setup mode and answers only its health check.
3. **Give it your own hostname.** The endpoint is written into the on-chain manifest, so use a hostname you control,
   such as `api.yourdomain.com`: in the dashboard, Worker → Settings → Domains & Routes → Add → Custom domain. A Workers
   custom domain needs that hostname's zone (`yourdomain.com`) on the same Cloudflare account. If you have no domain on
   Cloudflare, use the Worker's own `https://<worker name>.<your account>.workers.dev` URL instead (still https). Then
   add the variable `PUBLIC_URL` = `https://<your host>` (Settings → Variables and Secrets). Setup mode lists
   `PUBLIC_URL` as missing until it is set.
4. **Open the holder console** at [tapeapi.fun/console](https://tapeapi.fun/console/) in your wallet's in-app browser,
   and follow its five steps:
   - **1** connects the wallet that holds the circuit;
   - **2** reads your circuit, checks you are the holder and that the container is opened;
   - **3** generates the signing key on your phone and shows the variables to add in Cloudflare (`SIGNER_KEY` as a
     secret; the rest are public);
   - **4** checks the service reports that same key, asks your wallet for the delegation signature, and checks the
     signature really comes from the holder. In its service URL field, replace the default `https://api.tapeapi.fun`
     with `https://<your host>`. Add the two values it shows, `DELEGATION_EXPIRES` and `DELEGATION_SIG`, as variables;
   - **5** builds the manifest from what you read and signed, requires the service's copy to match it field for field,
     shows it to you, and writes it on chain with one transaction.

Do all five console steps in the same wallet app; the page keeps its progress in that browser. **Never screenshot or
send the signing key to anyone.**

`npm run deploy:public` deploys the project's own public service (`api.tapeapi.fun`, from
[`examples/public-api/`](../../examples/public-api/)). It is not for forks: use `npm run deploy:provider`.

## 3. Go live from a server

1. Generate a signing key and keep it in your secret store.
2. Have the holder sign the delegation. The key never needs to leave the wallet:
   ```bash
   node examples/reader-service/sign-delegation.mjs --container 0x<container> --signer 0x<signing key address> --expires <unix time>
   # sign the printed typed data with the holder's wallet (eth_signTypedData_v4; a Safe signs via EIP-1271), then
   node examples/reader-service/sign-delegation.mjs --container 0x<container> --signer 0x<address> --expires <unix time> --sig 0x<signature>
   ```
3. Run the service over HTTPS with `SIGNER_KEY`, `CIRCUITS`, `TOKEN_ID`, `CONTAINER`, `DELEGATION_EXPIRES`,
   `DELEGATION_SIG` and `PUBLIC_URL`. A live manifest must advertise an `https://` endpoint.
4. Publish the manifest: `api.tx.publishManifest({ container, manifest })` returns the `SiteRegistry.putFile`
   transaction for the holder's wallet. The key is `.well-known/tapeapi.json`, with no leading slash.

Check it the way any client would:

```js
const svc = await createTapeAPI({ rpcUrls: [/* ... */], quorum: 2 }).resolve('0x<container>')
```

## 4. Renew

A delegation lasts 90 days by default. Clients read it from the on-chain manifest, so renewing means a new signature
**and** publishing the manifest again. The signing key stays the same. In the [holder console](https://tapeapi.fun/console/):

1. **Step 2:** read your circuit. The console also reads the manifest already on chain and the signing address it
   authorises.
2. **Step 4:** tap **Renew**. It signs a new delegation for the key already published; no new key is generated, and
   step 3 is skipped. The service URL must be the one on chain.
3. In Cloudflare, replace `DELEGATION_EXPIRES` and `DELEGATION_SIG` with the two new values and wait for the redeploy.
4. **Step 5:** publish the manifest again.

There is no revocation: an old delegation stays valid until its own expiry, so if the signing key leaks, do not renew:
generate a new key in step 3, sign for it in step 4 and publish in step 5 at once.

## 5. Paid methods

> **Experimental.** Payments (TAP-22 payment channels and the escrow contract) are not deployed or audited and are not covered by the 1.0 stability promise: the names below may change in a 1.x minor release. See [Upgrading to 1.0](upgrade-1.0.md#what-10-promises).

Set `priceBEM` on a method and name an escrow in `payment`. The runtime verifies each voucher, meters per consumer and
refuses anything below the price. Every endpoint of one paid service must share one atomic meter store (D1 on
Cloudflare, see [`examples/cloudflare-worker/`](../../examples/cloudflare-worker/)), or the same voucher could be served
twice. A settler submits vouchers to the escrow in batches.

At settlement, a maintenance contribution comes out of your share, never out of the consumer's price. It defaults to
1% (100 bps, a constant in the escrow). You can set it to 0 to turn it off, or to anything up to 50%, for your own
service with `api.tx.setContribution({ circuits, tokenId, bps })`, sent from the circuit holder's wallet. A service at 0
gets exactly the same treatment. See [`docs/FEES.md`](../FEES.md).

> The escrow is not deployed on mainnet yet. Paid methods run against the examples today, and nothing is charged. The
> reference escrow in the repository still starts at 0; the default of 1% comes with the version that goes to audit.

## 6. Operate

[`docs/OPERATING.md`](../OPERATING.md) covers keys, monitoring, RPC choice, rate limits (600 free calls per minute per
IP by default) and relay capacity. Two rules worth repeating:

- Use at least three RPC nodes with `quorum: 2`: one node down or refusing a method still leaves a quorum.
- Keep the signing key only where the service runs. Anyone who can change the service's code can read it.
