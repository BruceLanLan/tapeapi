# Use TapeAPI from Claude, Cursor and other MCP clients

The public service's eight methods are available as [Model Context Protocol](https://modelcontextprotocol.io) (MCP)
tools. Add one URL to Claude, Cursor or any MCP client, and your assistant can read BNB Smart Chain with answers that
are signed and can be checked by anyone, later, against the chain.

There are two ways to connect:

- **The remote server** at `https://api.tapeapi.fun/mcp`. Nothing to install. The service signs every answer; you or
  anyone else can check it afterwards with the link that comes with it.
- **The local command** `tapeapi-mcp`. It runs on your machine, checks every answer against the chain before the
  model sees it, and refuses a service whose tools changed on chain until you accept the change.

Already run an MCP server of your own? See [Tape out your own MCP server](#tape-out-your-own-mcp-server).

## What you get

Eight read-only tools, free, with no sign-up and no key: `blockNumber`, `balance`, `tokenInfo`, `tokenBalance`,
`nftOwner`, `pairPrice`, `bnbUsd` and `tapeName`. Their parameters and results are the ones in
[Public API](public-api.md#methods).

Every tool result carries three things:

- **The data**, as text and as `structuredContent`.
- **A provenance line** the model can quote: which service signed, its container and signing key, the block, and a
  verification link `https://tapeapi.fun/verify/#r=...`.
- **A receipt** in `_meta["fun.tapeapi/receipt"]`: everything needed to check the signature again later, with no
  trust in whoever passes the receipt on.

**Why this matters.** In MCP, a tool result is whatever the server sent, and a tool definition is whatever the server
lists today. Neither says who stands behind it, and a server can change its tools after you approved them. A TapeAPI
service is a circuit on TapeOut. Its methods are listed in a manifest stored in its container's on-chain site, which
only the circuit's holder can rewrite. Every answer is signed by a key the holder delegated on chain, and the
signature is bound to your request: the method, the parameters and the result.

## Add the remote server

URL: `https://api.tapeapi.fun/mcp`. Transport: MCP Streamable HTTP, stateless, POST only. No sign-in and no key.

### Claude.ai and Claude Desktop

Open **Settings > Connectors > Add custom connector**. Name it `TapeAPI`, enter `https://api.tapeapi.fun/mcp` as the
URL, and leave the authentication fields empty. Custom connectors depend on your Claude plan.

### Claude Code

```bash
claude mcp add --transport http tapeapi https://api.tapeapi.fun/mcp
```

### Cursor

Add this to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "tapeapi": { "url": "https://api.tapeapi.fun/mcp" }
  }
}
```

### VS Code

Add this to `.vscode/mcp.json`:

```json
{
  "servers": {
    "tapeapi": { "type": "http", "url": "https://api.tapeapi.fun/mcp" }
  }
}
```

### Any other client

Point it at the URL as a Streamable HTTP server. The server answers each POST with `application/json`; it offers no
server-to-client stream, so a GET gets HTTP 405. You can talk to it with curl:

```bash
curl -s https://api.tapeapi.fun/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bnbUsd","arguments":{}}}'
```

### Try it

Ask your assistant: *"What is the BNB price in USDT right now? Use TapeAPI and give me the verification link."* A
result looks like this (the link shortened):

```text
{"bnbUsd":"776.200189730784569077","pair":"0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE","blockPinned":{"blockNumber":124374250,...}}

Signed by TapeAPI service 11.1013.tape (container 0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8, signer
0xaB70dEe8e1CEabb1D10eDFeBcbe0c313c53cf154) at BNB Chain block 124374251. Anyone can verify this signature against
the chain with the link. Verify: https://tapeapi.fun/verify/#r=eyJ2IjoyLCJzZXJ2aWNl... (The link carries hashes only,
not the params or result.)
```

## The local verifying command

`tapeapi-mcp` is a local MCP server (stdio) in the SDK's release package. It needs Node.js 20 or later. `npx` fetches
it from the GitHub release, not from the npm registry:

```bash
npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.4.0/tapeapi-sdk-1.4.0.tgz tapeapi-mcp 11.1013.tape
```

What it does differently from the remote server:

- **It checks every answer itself.** It resolves the service from the chain the way the SDK does
  ([Call a service](consume.md) explains each step), then checks each answer's signature against the key the holder
  delegated, before the result reaches the model.
- **It pins the service's tool definitions.** On first use it records each service's methods (names, descriptions,
  parameters, prices) and its signing key in `~/.tapeapi/mcp-pins.json`. If the holder later publishes a manifest
  where these differ, the command refuses every call to that service, sends nothing, and says what changed. A change
  can be a legitimate update or a rug pull; the command does not guess. To accept it, restart the command once with
  `--allow-changed`, which re-pins the new definitions. A renewed delegation or a new endpoint is not a change.
- **It takes any service.** Replace `11.1013.tape` with the TapeOut name or container address of another TapeAPI
  service, or list several. Only free methods become tools.

`tapeapi-mcp --help` lists the other options: `--rpc` for your own BNB Chain nodes, `--pin` for another pin file,
`--no-pin` to pin for one session only.

### Claude Desktop

Open **Settings > Developer > Edit Config** and add the server to `claude_desktop_config.json`, then restart Claude
Desktop:

```json
{
  "mcpServers": {
    "tapeapi": {
      "command": "npx",
      "args": [
        "-y",
        "--package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.4.0/tapeapi-sdk-1.4.0.tgz",
        "tapeapi-mcp",
        "11.1013.tape"
      ]
    }
  }
}
```

### Cursor

The same entry goes under `mcpServers` in `~/.cursor/mcp.json` or `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "tapeapi": {
      "command": "npx",
      "args": [
        "-y",
        "--package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.4.0/tapeapi-sdk-1.4.0.tgz",
        "tapeapi-mcp",
        "11.1013.tape"
      ]
    }
  }
}
```

### Claude Code

```bash
claude mcp add tapeapi -- npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.4.0/tapeapi-sdk-1.4.0.tgz tapeapi-mcp 11.1013.tape
```

### Remote or local

| | Remote server | Local command |
|---|---|---|
| Install | Nothing | Node.js 20 or later |
| Who checks the signature | Anyone, afterwards, with the link | The command, before the model sees the result |
| Tool list | As the server lists it | Read from the on-chain manifest and pinned; a change is refused until you accept it |
| Services | `11.1013.tape` | Any TapeAPI service, by name or container address |
| Rate limit | Per IP address, shared by everyone behind it | Your own IP address |

## Read and verify a receipt

A receipt is a small JSON object:

| Field | Meaning |
|---|---|
| `service` | `circuits` and `tokenId` (the circuit), `container` (its address) and `name` (the TapeOut name) |
| `method`, `params` | The request the signature is bound to |
| `id`, `ts` | The request id and the time the service signed, in Unix seconds |
| `ok` and `result` or `error` | The answer; a refusal is signed too |
| `block` | The chain head the service saw when it signed |
| `sig` | The service's signature over all of the above ([TAPI-21](../../spec/TAPI-21.md)) |

### In the browser

Open the verification link. The receipt travels in the part of the URL after `#`, which browsers never send to a
server. The page at `https://tapeapi.fun/verify/` resolves the service from the chain in your browser, recovers the
signer from the signature, checks it against the holder's delegation, and shows the result.

### Two forms of the link

- **Hashes only (the default).** The link carries the receipt with `params` and `result` (or `error`) replaced by the
  two hashes the signature is computed over: `requestHash` = keccak256 of the canonical `{ method, params }`,
  `bodyHash` = keccak256 of the canonical result. The page rebuilds the TAPI-21 digest from them, so it checks who
  signed, for which service, and when, but whoever gets the link does not see what was asked or answered. `method` is
  shown as the receipt states it: it is bound only through `requestHash`, together with the params.
- **With content** (`verifyLink(receipt, base, { content: true })`, `linkContent: true` on the server,
  `tapeapi-mcp --link-content`). The whole receipt is in the link: the page shows the params and the result, and so
  does everyone the link is passed to.
- **Hashes hide only what cannot be guessed.** Params drawn from a small set (an address, a token id, a price pair) and
  short results can be confirmed by hashing the candidates. Treat a hash-only link to such a call as revealing it.
- The receipt in `_meta["fun.tapeapi/receipt"]` is always the whole one: it goes to the MCP client that made the call.
- The verification page is static files (`site/verify/`); `verifyLink(receipt, base)` takes your own copy's address as
  `base`, so you can check receipts on a page you host yourself.

### Offline, with the SDK

Save the receipt (the `_meta["fun.tapeapi/receipt"]` object) as `receipt.json`. Install the SDK from the GitHub
release, or work inside a clone of the repository as in [Call a service](consume.md):

```bash
npm install https://github.com/BruceLanLan/tapeapi/releases/download/v1.4.0/tapeapi-sdk-1.4.0.tgz
```

```js
import { readFile } from 'node:fs/promises'
import { createTapeAPI, sig } from '@tapeapi/sdk'

const r = JSON.parse(await readFile('receipt.json', 'utf8'))
const api = createTapeAPI({
  rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-mainnet.public.blastapi.io', 'https://rpc-bsc.48.club'],
  quorum: 2,
})
// The service as the chain has it now: container, on-chain manifest, the holder's delegation of the signing key.
const svc = await api.resolve({ circuits: r.service.circuits, tokenId: r.service.tokenId })
const signer = sig.recoverResponseSigner({
  container: svc.container, id: r.id, method: r.method, params: r.params,
  ok: r.ok, body: r.ok ? r.result : r.error, ts: r.ts,
}, r.sig)
const same = (a, b) => a.toLowerCase() === b.toLowerCase()
console.log(same(signer, svc.manifest.signer) && same(r.service.container, svc.container) ? 'valid' : 'NOT valid')
```

Change one character of the result and the recovered signer changes, so the check fails. This compares the receipt
with the service's **current** delegation: if the holder has since delegated a different signing key, an older receipt
no longer matches it. To check without the SDK, see [Verify without the SDK](consume.md#verify-without-the-sdk).

## Limits

- **The remote server attests its own answers.** It signs them; it does not check them for you. The link lets anyone
  check. The local command checks every answer itself before the model sees it.
- **An answer without a receipt is not signed.** When the service is rate-limited or its delegation has lapsed, the
  tool returns an error with no receipt and no link. There is nothing to verify.
- **Rate limits are the public service's:** 600 free calls per minute per IP address. A hosted client such as Claude.ai
  calls from its own servers, so many users can share one address and its limit.
- **The public tools are reads of BNB Smart Chain** and of TapeOut. They are free, send no transactions and move no
  funds.
- **"Signed" proves who answered, not that the data is right.** For values that matter, ask a second, independent
  provider for the same block ([Prices and cross-checking](public-api.md#prices-and-cross-checking)).
- **Spot prices can be moved.** `pairPrice` and `bnbUsd` come from one pool's reserves at one block, and a large
  trade can move them. Do not use them alone for anything an attacker profits from moving.
- **Results are data, not instructions.** Token names and symbols are chosen by whoever deployed the token, and a
  signature does not make them safe to follow.
- The public service is best effort, with no SLA.

## Run your own TapeAPI service as an MCP server

`createMcpEndpoint` from `@tapeapi/server/mcp` turns any provider into a remote MCP server. The packages are not on
npm: install both from the GitHub release, the SDK first (see the [server README](../../server/README.md#install)), or
work inside a clone of the repository, as in [Run a service](provide.md). This is how the public service does it
([`examples/public-api/worker.js`](../../examples/public-api/worker.js)):

```js
import { createProvider } from '@tapeapi/server'
import { createMcpEndpoint, MCP_PATH } from '@tapeapi/server/mcp'

const provider = createProvider({ manifest, signerKey, rpcUrls, quorum: 2, methods })
const mcp = createMcpEndpoint({ provider, manifest: provider.manifest, name: '11.1013.tape' })

export default {
  fetch(request) {
    const clientIp = request.headers.get('cf-connecting-ip') || undefined
    if (new URL(request.url).pathname === MCP_PATH) return mcp.handleRequest(request, { clientIp })
    return provider.handleRequest(request, { clientIp })
  },
}
```

- Each free method in the manifest becomes a tool. Priced methods are not exposed.
- Every tool call goes through `provider.handleRequest` like any other call, so the result is the same signed
  envelope, under the same rate limits, with a receipt and a verification link.
- `/mcp` is a route on your server, not part of the manifest, so adding it changes nothing on chain and needs no
  republish.
- `name` is the TapeOut name shown in results and receipts.
- Verification links carry hashes only; `linkContent: true` puts the params and results in them, in clear.

## Tape out your own MCP server

This is for you if you already run an MCP server. You keep your server and your domain. A signing proxy in front of
it adds what MCP lacks:

- **An on-chain identity.** The proxy answers for a TapeOut circuit's container, so who is answering is a chain lookup,
  not a claim.
- **Tool definitions pinned on chain.** The manifest in your container's on-chain site carries `mcp.toolsSha256`, a
  SHA-256 over every tool's name, title, description, input and output schemas and annotations
  ([TAPI-20 §3.8](../../spec/TAPI-20.md)). If the tools change after users approved them (an MCP "rug pull"), clients
  that check the digest refuse them, and the proxy itself stops serving.
- **Every result signed.** Each tool call is answered with a signed TAPI-21 envelope, and on `/mcp` with a receipt and a
  verification link, as for the public service above.

The proxy and the console support for it are available now. No third-party MCP server has been taped out yet. The
packages are not on npm, so work inside a clone of the repository, as in [Run a service](provide.md).

### 1. Run the proxy in front of your server

The proxy is `createMcpProxy` from `@tapeapi/server/mcp-proxy`.
[`examples/mcp-proxy/`](../../examples/mcp-proxy/) runs it with Node or as a Cloudflare Worker. Try it locally first:
with no `UPSTREAM_URL` set, it starts a small demo MCP server with two tools, `add` and `shout`, and wraps that.

```bash
npm install --no-audit --no-fund       # once, in the repository root
node examples/mcp-proxy/index.mjs      # http://127.0.0.1:8796, with a throwaway signing key
```

```bash
curl -s http://127.0.0.1:8796/.well-known/tapeapi.json
curl -s -X POST http://127.0.0.1:8796/tapeapi/v1/add -H 'content-type: application/json' -d '{"id":"1","params":{"a":2,"b":40}}'
curl -s -X POST http://127.0.0.1:8796/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"shout","arguments":{"text":"hi","times":2}}}'
```

The proxy has three routes:

| Route | What it is |
|---|---|
| `GET /.well-known/tapeapi.json` | The manifest: your identity fields, one free method per tool, and `mcp: { endpoint, toolsSha256 }` |
| `POST /tapeapi/v1/<tool>` | A signed call: `{ id, params }` in, a TAPI-21 envelope out, whose `result` is your server's tool result without `_meta` |
| `POST /mcp` | Remote MCP (Streamable HTTP, stateless): `tools/list` returns your tools as your server lists them; `tools/call` returns your server's content plus a provenance line, with the receipt in `_meta` |

To wrap your own server, point `UPSTREAM_URL` at its Streamable HTTP endpoint. If it needs a key, set
`UPSTREAM_AUTHORIZATION`: a fixed header you choose. A caller's headers are never forwarded to your server.

```bash
UPSTREAM_URL=https://your-server.example/mcp UPSTREAM_AUTHORIZATION="Bearer ..." node examples/mcp-proxy/index.mjs
```

To go live, the proxy needs an https hostname of yours, because its URL is written into the on-chain manifest:

- **Cloudflare Worker.** Set `UPSTREAM_URL` in `examples/mcp-proxy/wrangler.toml` (the Worker is named
  `my-tapeapi-mcp-proxy`) and deploy with `npx --yes wrangler@4.141.0 deploy -c examples/mcp-proxy/wrangler.toml`. Add
  a custom domain to the Worker in the Cloudflare dashboard and set the variable `PUBLIC_URL` to it. Until its identity
  is set, the Worker answers only `/tapeapi/v1/health`, which names the signing address derived from the secret
  `SIGNER_KEY`: the same setup mode as in
  [Go live from a phone](provide.md#2-go-live-from-a-phone-cloudflare-and-holder-console).
- **Node.** Run `examples/mcp-proxy/index.mjs` behind your own https reverse proxy, with `PUBLIC_URL`, `SIGNER_KEY`
  and the identity variables below in its environment (`HOST` and `PORT` say where it listens, `NAME` sets the service
  name).

The identity is added exactly as for any TapeAPI service: mint a circuit and open its container, enter the proxy's URL
in the [holder console](https://tapeapi.fun/console/), sign the delegation, and set `CIRCUITS`, `TOKEN_ID`,
`CONTAINER`, `DELEGATION_EXPIRES` and `DELEGATION_SIG` as variables and `SIGNER_KEY` as a secret.
[Run a service](provide.md#2-go-live-from-a-phone-cloudflare-and-holder-console) walks through each step.

### 2. Publish the manifest with the holder console

The console's publishing step reads the proxy's `/.well-known/tapeapi.json`. When the manifest has an `mcp` field, the
console does not take the proxy's word for the digest. It fetches `tools/list` from `mcp.endpoint` itself, in your
browser, and computes the digest the way clients do. Nothing is published unless that digest equals the proxy's
`toolsSha256` and every method is one of the tools. Before your wallet is asked to sign, the console shows every
tool's name and description. Read them: this is the tool set you are putting your circuit's name to. The published
manifest carries the `mcp` field.

Then set `TOOLS_SHA256` (a Worker variable, or the environment for Node) to the `mcp.toolsSha256` you published.
Without it, a proxy that restarts takes whatever tools it reads at start-up as the published ones, and a Worker
isolate can be restarted at any time. With it, changed tools are refused after a restart too.

### 3. Let people connect

- **By URL.** Users add `https://<your host>/mcp` to Claude, Cursor or any MCP client, as for the public service at the
  top of this guide. Every result carries a receipt and a verification link.
- **With the local command.** `tapeapi-mcp` takes your TapeOut name (or container address), resolves your service on
  chain, and shows your tools as your server defines them, after checking them against the digest on chain (v0.5.0
  or later):

  ```bash
  # 42.1013.tape is an example name: put your service's TapeOut name here
  npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.4.0/tapeapi-sdk-1.4.0.tgz tapeapi-mcp 42.1013.tape
  ```

### What clients check

- **`tapeapi-mcp`** resolves the service and the holder's delegation on chain. It fetches `tools/list` from
  `mcp.endpoint`, computes the digest, and refuses every tool of the service, sending nothing, if it differs from the
  `mcp.toolsSha256` on chain. It pins that digest in `~/.tapeapi/mcp-pins.json` together with the methods and the
  signing key. Each call goes to `/tapeapi/v1/<tool>`, and the envelope's signature is checked against the delegated
  key, bound to this request, before the model sees the result.
- **A client connected to `/mcp` by URL checks nothing itself.** It relies on the proxy, which refuses to serve tools
  that no longer match the published digest, and on the receipts, which anyone can check afterwards at
  `https://tapeapi.fun/verify/`.
- **A tool error is still signed as an answer.** When your server returns `isError: true`, the envelope is `ok: true`:
  the signature says what your server answered. Only the proxy's own refusals are `ok: false`.

### When you change your tools

Any change to a tool definition changes the digest, even one word of a description. The proxy re-reads your tools on
every `tools/list` and on the first call more than 60 seconds after its last read. From the moment they differ from
the published digest:

- every call is refused with a signed `TOOLS_CHANGED` error (HTTP 409, with `data: { published, current }`);
- `tools/list` on `/mcp` answers a JSON-RPC error, and `/tapeapi/v1/health` reports `ok: false`.

This lasts until you publish the new tool set:

1. Make sure the change is yours.
2. Set `TOOLS_SHA256` to the new digest (the `current` value in the refusal, also shown as `upstreamToolsSha256` on
   `/tapeapi/v1/health`), or remove it, and restart or redeploy the proxy. While `TOOLS_SHA256` still names the old
   digest, the proxy refuses `tools/list`, so the console cannot read your tools.
3. Publish the manifest again with the holder console, as in step 2 above.

Between the restart and the publish, clients connected to `/mcp` by URL already see the new tools; `tapeapi-mcp`
refuses them, because they do not match the chain yet. After the publish, `tapeapi-mcp` sees a new digest on chain,
which differs from the one it pinned, and refuses your service until its user accepts the change by restarting it
once with `--allow-changed`. A new tool set reaches those users only with their consent.

### What this does not do

- **A signature proves who answered and that the tool definitions are the published ones. It does not prove the
  answers are right.** The digest binds the definitions, not the behaviour: a server can answer differently under the
  same definitions. Signing makes that attributable, not impossible. You vouch for the server you put behind your
  circuit.
- **Streamable HTTP servers only.** Your server must speak MCP over Streamable HTTP; a stdio server needs an HTTP
  bridge first. Only tools are proxied: resources and prompts are not, there is no server-to-client stream (a GET on
  `/mcp` gets HTTP 405), and sampling, elicitation and progress notifications are not relayed. Your server's
  `instructions` are not relayed either, because they are not covered by the digest.
- **Tool names must be TAPI-20 method names** (`[A-Za-z_][A-Za-z0-9_]{0,63}`). A tool with another name is still listed
  in `tools/list`, because the digest covers every tool, but it cannot be called through the proxy. The proxy's
  start-up log names such tools.
- **Free tools only, for now.** Every tool becomes a free method. Paid calls wait for the escrow audit
  ([Roadmap](../ROADMAP.md)).
- **The console step needs CORS.** The console reads `tools/list` from `mcp.endpoint` in your browser, so that endpoint
  must allow cross-origin requests from `https://tapeapi.fun`. The proxy's `/mcp` already does. Do not put anything in
  front of it that blocks `OPTIONS` requests or strips the CORS headers.
- **Sizes.** One answer from your server may be at most 1 MiB and take at most 20 seconds. In the manifest, each
  method's description is cut to 256 characters (Unicode code points); the full text is pinned by `toolsSha256`. The console publishes at
  most 24 000 bytes and 64 methods in one transaction.
- **Rate limits** are per process (per isolate on Workers): 600 free calls per minute per IP address by default.
