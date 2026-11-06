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

### Protocol versions

The remote server, the signing proxy's `/mcp` and the local command speak four MCP revisions. Three use the
`initialize` handshake: 2025-11-25, 2025-06-18 and 2025-03-26. The fourth, 2026-07-28, has no handshake: every request
carries its revision and the client's capabilities in `params._meta`. Support for 2026-07-28 is **experimental** (2.5):
outside the compatibility promise, it may change in any minor release. No session is kept between calls in either
case, and no `Mcp-Session-Id` is issued.

A request is treated as 2026-07-28 when its `params._meta` has the key `io.modelcontextprotocol/protocolVersion` with
a value that is not one of the three older revisions, and the method is not `initialize`. No client of the older
revisions sends that key, so such a client gets exactly the answer it got from 2.4: the test suite replays 290 answers
recorded from release 2.4.0 (the server core the local command runs on, the remote server, the signing proxy, and the
public service's `/mcp` and `/mcp/pinned`) and requires them byte for byte, except the five answers (one per HTTP
entry point) to a request sent with the header `MCP-Protocol-Version: 2026-07-28` but without the 2026-07-28 `_meta`:
no client of an older revision sends that, and it is now refused (see below).

What a 2026-07-28 request gets:

| Request | Answer | HTTP status |
| --- | --- | --- |
| `tools/list`, `tools/call` and the other methods, without `initialize` | the result, with `resultType: "complete"` and `_meta["io.modelcontextprotocol/serverInfo"]` (name and version of this server). A list result also has `ttlMs: 0` and `cacheScope: "public"`. In a tool result the receipt stays where it was in `_meta`; serverInfo is placed beside it. | 200 |
| `server/discover` | `supportedVersions` (`2026-07-28`, then the three older ones), `capabilities` (`tools`), `instructions`, `ttlMs: 0`, `cacheScope: "public"`, serverInfo in `_meta` | 200 |
| a revision this server does not have (for example `2027-01-01`) | error `-32022` "Unsupported protocol version", `data: { supported, requested }` | 400 |
| a revision value that is not a string, or no `io.modelcontextprotocol/clientCapabilities` object | error `-32602` | 400 |
| the `MCP-Protocol-Version`, `Mcp-Method` or (for `tools/call`, `prompts/get`, `resources/read`) `Mcp-Name` header missing or not equal to the body. `Mcp-Name` may use the `=?base64?...?=` form and is decoded first. | error `-32020` "Header mismatch" | 400 |
| a method this server does not have | error `-32601` | 404 |

The status codes and the header checks apply on HTTP (the remote server and the signing proxy). The local command
(stdio) has no headers; it gives the same JSON-RPC answers. A client that speaks both generations finds this server
modern either way: over stdio its `server/discover` probe gets a result, and over HTTP its first request succeeds or
gets one of the errors above.

Nothing signed changes. The added fields sit beside the result: receipts, signed envelopes, verify links and
`toolsSha256` are the same for both generations.

Some choices are deliberate:

- `ping` is still answered for a 2026-07-28 request, although that revision removed the method.
- A JSON array of messages (a batch) of the older revisions is answered message by message with HTTP 200, as before.
  A batch that holds a 2026-07-28 message, or that is sent with `MCP-Protocol-Version: 2026-07-28`, is refused with
  HTTP 400 and `-32600`: revision 2026-07-28 expects one message per request, and a batch would carry a message past
  the header checks above.
- A single request sent with `MCP-Protocol-Version: 2026-07-28` but without 2026-07-28 metadata in its body is a
  malformed 2026-07-28 request: HTTP 400, with `-32020` when its `Mcp-Method` or `Mcp-Name` header (or a version in
  `_meta`) contradicts the body, else `-32602`. A gateway that trusts those headers is never misled. (2.4.0 answered
  such a request without contradicting headers as an older-revision one; no client of an older revision sends that
  header value. `initialize` keeps the older handshake whatever the header says.)
- `Mcp-Param-*` headers are not checked, on any entry point. No TapeAPI tool declares `x-mcp-header`. For a proxied
  upstream tool that declares it, the proxy's `/mcp` neither requires the header nor compares it with the argument,
  which 2026-07-28 asks a server to do ("Server Behavior for Custom Headers"): do not let a gateway in front of the
  proxy make decisions on `Mcp-Param-*` headers, and if your upstream relies on them, check them in the upstream.
- An `initialize` request is always answered with one of the three older revisions, even when it carries 2026-07-28
  metadata. The client then speaks that revision.
- `cacheScope` is always `"public"`: none of the entry points answers `tools/list` differently for different callers.
  Code built on `createMcpServer` that filtered its list by caller would need `"private"`, which this version does not
  offer.
- Before 2.5, a value of the version key that is not any revision (`"latest"`, `"2026-7-28"`, a later date, a number)
  was answered as an older-revision request. It is now refused, as 2026-07-28 asks.
- Since 3.0 the signing proxy first asks its upstream `server/discover` (`upstreamNegotiation: 'auto'`, experimental,
  now the default) and speaks 2026-07-28 to an upstream that offers it, so an upstream that speaks only 2026-07-28 can
  be proxied; an error answer, an HTTP 4xx or no answer in time makes it fall back to `initialize`. A network failure
  of that first request is a failure, not a fallback, and an upstream that answers `server/discover` with a result
  naming no revision is refused at start-up. `upstreamNegotiation: 'legacy'` opens with `initialize`, as 2.x did. The
  local command makes the same choice by default when it reads a taped-out MCP server's tools from its `mcp.endpoint`
  (`tapeapi-mcp --upstream-negotiation legacy` for the 2.x way). Only that reading changes: the tools must still hash
  to the manifest's `mcp.toolsSha256`, the same digest is pinned, and every call still goes through the signed TapeAPI
  path. Its log line says which way the tools were read.

The three older revisions stay supported. No date for removing them is set. The MCP project's deprecation policy gives a
deprecated feature at least twelve months.

We have not tried every client. The official TypeScript client v2 (`@modelcontextprotocol/client` 2.3.1) was run
locally against the remote server, the signing proxy, the public service's `/mcp` and `/mcp/pinned`, and the local
command: in its default mode (2025-11-25) and pinned to 2025-06-18 and 2025-03-26 it connects with `initialize`, and in
its `auto` and `2026-07-28` modes it connects without, through `server/discover`; it listed the tools and called one
in every case. The tests themselves send the requests the specification describes.

Checked against the specification on 2026-10-21, when 2026-07-28 was its latest revision:
[versions and older servers](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning),
[messages, error codes and `_meta`](https://modelcontextprotocol.io/specification/2026-07-28/basic/index),
[`server/discover`](https://modelcontextprotocol.io/specification/2026-07-28/server/discover),
[caching](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching),
[Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http),
[stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio),
[changes since 2025-11-25](https://modelcontextprotocol.io/specification/2026-07-28/changelog).

## The local verifying command

`tapeapi-mcp` is a local MCP server (stdio) in the SDK's release package. It needs Node.js 22 or later. `npx` fetches
it from the GitHub release, not from the npm registry:

```bash
npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v3.0.0/tapeapi-sdk-3.0.0.tgz tapeapi-mcp 11.1013.tape
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
        "--package=https://github.com/BruceLanLan/tapeapi/releases/download/v3.0.0/tapeapi-sdk-3.0.0.tgz",
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
        "--package=https://github.com/BruceLanLan/tapeapi/releases/download/v3.0.0/tapeapi-sdk-3.0.0.tgz",
        "tapeapi-mcp",
        "11.1013.tape"
      ]
    }
  }
}
```

### Claude Code

```bash
claude mcp add tapeapi -- npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v3.0.0/tapeapi-sdk-3.0.0.tgz tapeapi-mcp 11.1013.tape
```

### Remote or local

| | Remote server | Local command |
|---|---|---|
| Install | Nothing | Node.js 22 or later |
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
npm install https://github.com/BruceLanLan/tapeapi/releases/download/v3.0.0/tapeapi-sdk-3.0.0.tgz
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
- `/mcp` is a route on your server. Adding it needs no manifest change and changes nothing on chain.
- **The public service does not declare this route in its manifest** (no `mcp` field), and that is a decision, not a
  delay. The manifest's `mcp` field ([TAPI-20 §3.8](../../spec/TAPI-20.md), and the MCP tools draft, merged as Draft TAP-15, #16) is
  written for the other direction: a signing proxy in front and a real MCP server behind it
  ([Tape out your own MCP server](#tape-out-your-own-mcp-server) below), where each method is an MCP tool and its
  signed result is that tool's MCP result (`{ content, ... }`). `createMcpEndpoint` goes the opposite way: the tools
  are generated from the methods, and each method answers with its own JSON. Declared, `11.1013.tape` would be shown by
  `tapeapi connect` as an MCP tool service with `tapeapi-mcp` settings, and `tapeapi-mcp` would verify every answer
  and then refuse to show it as a tool result. So `/mcp` stays undeclared.
- **From 2.4 the public Worker's code has tool methods that follow §3.8** (experimental). Eight more free methods,
  `tool_block_number`, `tool_balance`, `tool_token_info`, `tool_token_balance`, `tool_nft_owner`, `tool_pair_price`,
  `tool_bnb_usd` and `tool_tape_name`, make the same reads and answer, signed, exactly an MCP tool result
  (`{ content: [{ type: "text", text }], structuredContent }`). They are the only tools of a second endpoint,
  `/mcp/pinned`, which is what the manifest would declare: `mcp: { endpoint: ".../mcp/pinned", toolsSha256 }`. Only
  they are held to that digest; the REST methods and `/mcp` answer as they do without it. `tapeapi-mcp` then shows these
  eight tools and their answers. Both appear only while the Worker's `MCP_TOOLS_SHA256` variable is set, with
  `createMcpEndpoint({ ..., mcpResults: true, pinnedToolsSha256 })` serving `/mcp/pinned`: since 2.5 its `tools/list` is
  refused, as the signing proxy refuses it (`-32603`, `data.code: "TOOLS_CHANGED"`), while the tools hash to anything
  but that variable (see
  [`examples/public-api/worker.js`](../../examples/public-api/worker.js)). **The code is live, the tools are off**:
  `api.tapeapi.fun` is redeployed from this repository's `main`, so it runs this code from 2.4 on, but the variable is
  not set there, so it serves neither the tool methods nor `/mcp/pinned` (and answers as 2.3 did, apart from the version)
  until it is set by hand. Until the holder then publishes that manifest, `11.1013.tape` declares nothing:
  `tapeapi connect 11.1013.tape` says `not-ai`, and the settings at the top of this guide are the way to use it.
- `@tapeapi/server/mcp` has experimental helpers for this endpoint's digest: `await mcp.toolsSha256()` (what clients
  compute over its `tools/list`), `listedMcpTools(manifest)`, `mcpToolsSha256(manifest)`, and
  `holdToToolsSha256(methods, { manifest, published })`, which refuses the tool methods with a signed `TOOLS_CHANGED`
  once the tools no longer match the published digest. A declaration made with them follows §3.8 only if your methods
  themselves answer with MCP tool results. If you run a real MCP server, use the signing proxy below instead:
  `createMcpProxy` computes the `toolsSha256` you publish and holds its calls to it by itself.
- `name` is the TapeOut name shown in results and receipts.
- Verification links carry hashes only; `linkContent: true` puts the params and results in them, in clear.
- `mcpResults: true` (experimental, 2.4) is for methods whose signed results are already MCP tool results
  (`{ content, structuredContent?, isError? }`): each is passed on as that tool result after the provenance line, with
  any imitation of that line labelled as the tool's own output, instead of as JSON text. Default false: every result
  is data, shown as JSON text.

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

**Browsers and `Origin` (2.5, experimental; default changed in 3.0).** A proxy on your own machine (or a private
network) in front of tools with side effects, such as files, a shell or a database, would let any web page you open
call those tools through `http://127.0.0.1:.../mcp`. So since 3.0 `createMcpProxy` refuses every request that carries
an `Origin` header (every browser request) with HTTP 403 before anything runs, as Streamable HTTP asks, unless you
list that origin: `allowedOrigins: ['https://app.example']` (in `examples/mcp-proxy/index.mjs`, the variable
`ALLOWED_ORIGINS`, comma-separated). A listed origin is echoed instead of `*`; a request without `Origin` (a desktop
client, `curl`) is answered as usual. `allowedOrigins: '*'` (`ALLOWED_ORIGINS=*`) answers any origin with CORS `*`, as
2.x did. The Worker template `examples/mcp-proxy/worker.js` keeps any origin unless its `ALLOWED_ORIGINS` lists some:
on a public hostname an origin check protects nothing, and the holder console needs it (below). `createMcpEndpoint`
takes the same option but its default is still any origin, and the public Worker (`api.tapeapi.fun/mcp`) takes the
variable `MCP_ALLOWED_ORIGINS`, unset there.

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
  npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v3.0.0/tapeapi-sdk-3.0.0.tgz tapeapi-mcp 42.1013.tape
  ```

### See a service with `tapeapi connect`

`tapeapi connect <name>` (experimental, since 2.3 for MCP tool services, outside the compatibility promise) shows a taped-out MCP
server as the chain has it. When the manifest has an `mcp` field and no `ai` field, the card says "MCP tool service"
and shows the endpoint, the manifest's free methods (`tapeapi-mcp` offers no priced method; which of them are tools is
for the endpoint's `tools/list` to say) and the first 8 hex digits of `toolsSha256`, then Claude
Code and Claude Desktop settings: through `tapeapi-mcp` (every answer checked on your machine) and, marked as not
checked, the declared endpoint direct (a direct answer is not a signed envelope: do not treat it as signed or verified).
It reads the chain and the manifest only: it does not contact the endpoint, and
no setting carries a key. `--proxy` runs `tapeapi-mcp` for the service (its JSON-RPC on stdout, the card on stderr).

```bash
# from a checkout (npm ci once at the root); 42.1013.tape is an example name
node sdk/bin/tapeapi.js connect 42.1013.tape
```

A manifest without `mcp` is shown as unavailable (`not-ai`). The public service `11.1013.tape` is one until its holder
publishes a manifest that declares `/mcp/pinned` (see "Run your own TapeAPI service as an MCP server" above), so use
the settings at the top of this guide for it. Since this command does not contact the endpoint, its row lists the
manifest's free methods as methods, not tools (for that manifest all 16: the tool methods are free too), and does not
say how many are tools: the tools are the methods that `tools/list` at the endpoint names (eight there), and
`tapeapi-mcp`, which reads that list, offers only those (2.4; in 2.3 the row was labelled "tools").

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
  must allow cross-origin requests from `https://tapeapi.fun`. The Worker template's `/mcp` does unless you set
  `ALLOWED_ORIGINS`; with `examples/mcp-proxy/index.mjs` or your own `createMcpProxy`, list it
  (`ALLOWED_ORIGINS=https://tapeapi.fun`, `allowedOrigins: ['https://tapeapi.fun']`), because since 3.0 the proxy refuses
  browser origins it was not given. Do not put anything in front of it that blocks `OPTIONS` requests or strips the
  CORS headers.
- **Sizes.** One answer from your server may be at most 1 MiB and take at most 20 seconds. In the manifest, each
  method's description is cut to 256 characters (Unicode code points); the full text is pinned by `toolsSha256`. The console publishes at
  most 24 000 bytes and 64 methods in one transaction.
- **Rate limits** are per process (per isolate on Workers): 600 free calls per minute per IP address by default.
