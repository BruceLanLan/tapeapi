# Use TapeAPI from Claude, Cursor and other MCP clients

The public service's eight methods are available as [Model Context Protocol](https://modelcontextprotocol.io) (MCP)
tools. Add one URL to Claude, Cursor or any MCP client, and your assistant can read BNB Smart Chain with answers that
are signed and can be checked by anyone, later, against the chain.

There are two ways to connect:

- **The remote server** at `https://api.tapeapi.fun/mcp`. Nothing to install. The service signs every answer; you or
  anyone else can check it afterwards with the link that comes with it.
- **The local command** `tapeapi-mcp`. It runs on your machine, checks every answer against the chain before the
  model sees it, and refuses a service whose tools changed on chain until you accept the change.

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
the chain with the link. Verify: https://tapeapi.fun/verify/#r=eyJ2IjoxLCJzZXJ2aWNl...
```

## The local verifying command

`tapeapi-mcp` is a local MCP server (stdio) in the SDK's release package. It needs Node.js 20 or later. `npx` fetches
it from the GitHub release, not from the npm registry:

```bash
npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v0.3.0/tapeapi-sdk-0.3.0.tgz tapeapi-mcp 11.1013.tape
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
        "--package=https://github.com/BruceLanLan/tapeapi/releases/download/v0.3.0/tapeapi-sdk-0.3.0.tgz",
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
        "--package=https://github.com/BruceLanLan/tapeapi/releases/download/v0.3.0/tapeapi-sdk-0.3.0.tgz",
        "tapeapi-mcp",
        "11.1013.tape"
      ]
    }
  }
}
```

### Claude Code

```bash
claude mcp add tapeapi -- npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v0.3.0/tapeapi-sdk-0.3.0.tgz tapeapi-mcp 11.1013.tape
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
| `sig` | The service's signature over all of the above ([TAP-21](../../spec/TAP-21.md)) |

### In the browser

Open the verification link. The receipt travels in the part of the URL after `#`, which browsers never send to a
server. The page at `https://tapeapi.fun/verify/` resolves the service from the chain in your browser, recovers the
signer from the signature, checks it against the holder's delegation, and shows the result.

### Offline, with the SDK

Save the receipt (the `_meta["fun.tapeapi/receipt"]` object) as `receipt.json`. Install the SDK from the GitHub
release, or work inside a clone of the repository as in [Call a service](consume.md):

```bash
npm install https://github.com/BruceLanLan/tapeapi/releases/download/v0.3.0/tapeapi-sdk-0.3.0.tgz
```

```js
import { readFile } from 'node:fs/promises'
import { createTapeAPI, sig } from '@tapeapi/sdk'

const r = JSON.parse(await readFile('receipt.json', 'utf8'))
const api = createTapeAPI({
  rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-dataseed1.ninicoin.io'],
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
- Pre-alpha. The public service is best effort, with no SLA.

## Run your own TapeAPI service as an MCP server

`createMcpEndpoint` from `@tapeapi/server/mcp` turns any provider into a remote MCP server. The packages are not on
npm and the server package has no release file yet, so work inside a clone of the repository, as in
[Run a service](provide.md). This is how the public service does it
([`examples/public-api/worker.js`](../../examples/public-api/worker.js)):

```js
import { createProvider } from '@tapeapi/server'
import { createMcpEndpoint, MCP_PATH } from '@tapeapi/server/mcp'

const provider = createProvider({ manifest, signerKey, rpcUrls, quorum: 2, methods })
const mcp = createMcpEndpoint({ provider, manifest: provider.manifest, identity: { name: '42.1013.tape' } })

export default {
  fetch(request) {
    const clientIp = request.headers.get('cf-connecting-ip') || undefined
    if (new URL(request.url).pathname === MCP_PATH) return mcp.handle(request, { clientIp })
    return provider.handleRequest(request, { clientIp })
  },
}
```

- Each free method in the manifest becomes a tool. Priced methods are not exposed.
- Every tool call goes through `provider.handleRequest` like any other call, so the result is the same signed
  envelope, under the same rate limits, with a receipt and a verification link.
- `/mcp` is a route on your server, not part of the manifest, so adding it changes nothing on chain and needs no
  republish.
- `identity.name` is the TapeOut name shown in results and receipts.
