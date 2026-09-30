# @tapeapi/sdk

JavaScript SDK for [TapeAPI](https://tapeapi.fun): find a service on BNB Smart Chain by name, call it, and get an
answer whose signature is checked against the key the service's holder delegated on chain. Paid methods use
EIP-712 vouchers against an escrow; nothing is signed or sent without you.

> **1.3.0.** Semantic versioning from 1.0 on: breaking changes come only in 2.0. See the [changelog](https://github.com/BruceLanLan/tapeapi/blob/main/CHANGELOG.md).

## Install

```bash
npm install https://github.com/BruceLanLan/tapeapi/releases/download/v1.3.0/tapeapi-sdk-1.3.0.tgz
```

Not on the npm registry yet: each GitHub release carries the package file. Built from https://github.com/BruceLanLan/tapeapi
(folder `sdk/`). ES modules only; Node 20+, browsers,
Cloudflare Workers and Deno. TypeScript declarations are included.

## Example

```js
import { createTapeAPI } from '@tapeapi/sdk'

const api = createTapeAPI({
  rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-mainnet.public.blastapi.io', 'https://rpc-bsc.48.club'],
  quorum: 2,                                        // every chain read must be agreed by 2 node operators
})
const svc = await api.resolve('11.1013.tape')       // the public service: <#ID>.<processor>.tape
const { result, verified } = await api.call(svc, 'bnbUsd', {})
console.log(result.bnbUsd, verified)                // price of BNB in USDT, signature verified
```

`api.callQuorum([svcA, svcB], method, params)` asks independent providers and accepts only an answer they agree on.

**X Layer and Base.** TapeOut names on other chains carry an area code: `1.2.230.tape` is circuit 1 of processor 230
on X Layer (chainId 196, area 2), `1.3.5.tape` is on Base (chainId 8453, area 3). `api.resolve()` reads such a name on its
own chain (identity, manifest and a delegation signed for that chain's EIP-712 domain), through `chains: { 196: { rpcUrls } }`
or else that chain's defaults (`rpcUrlsFor(196)`: OKX and dRPC, two operators, so no spare). `{ chainId, circuits, tokenId }`
works too, and every resolved service carries its `chainId`. Payments stay on BNB Smart Chain: a priced method of an L2
service is refused. `CHAINS`, `parseTapeName` and `formatTapeName` (also `@tapeapi/sdk/chains`) hold the addresses and the
naming rules.

## Subpaths

| Import | What |
| --- | --- |
| `@tapeapi/sdk` | `createTapeAPI`, `createRpc`, `TapeAPIError`, `MAINNET`, `BUS_RPC_URLS`, `RPC_DEFAULTS` / `rpcUrlsFor` / `operatorOf` (default nodes per chain and who runs them; quorums count operators, not URLs), `deliverGroupUpdate` / `checkGroupInvites`, and the `abi`, `sig`, `channel`, `busPrivacy`, `group`, `tapesend`, `webmcp`, `mcp`, `ai` namespaces |
| `@tapeapi/sdk/webmcp` | `exposeTapeAPI`, `manifestToTools`: a service's methods as WebMCP tools for in-browser agents |
| `@tapeapi/sdk/channel` | TAP-26 private channels (invites, relay and ChannelBus transports) |
| `@tapeapi/sdk/bus-privacy` | `busPrivacyReader`: ChannelBus reads that hide your rooms among cover rooms (`@experimental`) |
| `@tapeapi/sdk/ai` | AI usage receipts: `createVerifyingFetch` (a `fetch` for the official OpenAI and Anthropic SDKs that checks every answer's receipt), `verifyUsageReceipt`, the format adapters |
| `@tapeapi/sdk/mcp` | the MCP server core behind `tapeapi-mcp` and `@tapeapi/server/mcp`: tools with signed results and receipts |
| `@tapeapi/sdk/chains` | `CHAINS` (BNB Smart Chain, X Layer, Base: factory, opener, DeWebHub, SiteRegistry, area code), `parseTapeName`, `formatTapeName` |
| `@tapeapi/sdk/rpc`, `/abi`, `/sig`, `/canon`, `/manifest` | the building blocks |

**Stability (1.0).** Every export is Stable (no breaking change within 1.x) unless its type declaration says
`@experimental` (payments, the ServiceDirectory and the `bus-privacy` reader: `api.payer`, `api.acceptPrice`, the payment `api.tx` builders,
`api.chain.escrow`, ...) or `@internal`. Upgrading from 0.x: [docs/guides/upgrade-1.0.md](https://github.com/BruceLanLan/tapeapi/blob/main/docs/guides/upgrade-1.0.md).

## Local MCP server: `tapeapi-mcp`

The package ships a command that exposes any TapeAPI service's free methods as MCP tools over stdio (Claude Desktop,
Cursor, any MCP client), and verifies every answer in your own process before the model sees it:

```bash
npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.3.0/tapeapi-sdk-1.3.0.tgz tapeapi-mcp 11.1013.tape
```

```json
{ "mcpServers": { "tapeapi": { "command": "npx", "args": ["-y", "--package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.3.0/tapeapi-sdk-1.3.0.tgz", "tapeapi-mcp", "11.1013.tape"] } } }
```

- **Identity from the chain.** Each service (a TapeOut name like `11.1013.tape` or a container address) is resolved
  on BNB Chain, with the holder's delegation checked; every chain read needs 2 nodes to agree (`--rpc url,url,...`).
- **Every answer verified.** A result is returned only if its signature recovers the delegated signer. Otherwise it is
  discarded and the tool result says so. Each verified result carries a receipt (`_meta["fun.tapeapi/receipt"]`)
  and a link that anyone can use to check it again at https://tapeapi.fun/verify/. The link carries hashes only;
  with `--link-content` it carries the call's params and result in clear, which is the conversation itself: share
  such a link only where you would share what was asked and answered.
- **What a receipt does not prove.** It proves which service's key signed which request and answer, and when. It
  does not prove which program or model produced the answer.
- **Pinned tool definitions.** On first use, the service's signer, name and methods are pinned in
  `~/.tapeapi/mcp-pins.json` (`--pin <file>`, `--no-pin`). If they later change on chain, calls to that service are
  refused, and the refusal lists the methods that were added, removed or changed, plus any change of signing key.
  Restart with `--allow-changed` to accept the change once and re-pin. Delegation renewals and endpoint moves are
  not treated as changes.
- One service gives tools named after its methods. With several services, each tool name gets a prefix
  (`t11_1013_bnbUsd`). Priced methods are not exposed. Logs go to stderr; stdout carries only JSON-RPC.

`--dev <url>` exists for this package's tests only. It skips every on-chain identity check and prints a warning.

## Local verifying proxy: `tapeapi-verify`

For AI clients that cannot read usage receipts themselves (Claude Code, Codex, any tool with a base-URL setting): it
forwards every request to a TapeAPI AI service resolved on chain and checks the signed receipt of every answer.

It keeps running in the foreground; start the client in a second terminal.

```bash
# Terminal 1. 42.1013.tape is an example name: put your AI provider's TapeOut name here
npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.3.0/tapeapi-sdk-1.3.0.tgz tapeapi-verify 42.1013.tape
```

```bash
# Terminal 2, macOS or Linux
ANTHROPIC_BASE_URL=http://127.0.0.1:8790 claude
OPENAI_BASE_URL=http://127.0.0.1:8790/v1 codex             # Codex (or base_url in config.toml)
```

```powershell
# Terminal 2, Windows PowerShell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8790"; claude
$env:OPENAI_BASE_URL="http://127.0.0.1:8790/v1"; codex
```

Run as written, `tapeapi-verify 42.1013.tape` stops with "no file at /.well-known/tapeapi.json": the name is an example.
No service of your own yet? The repository's local trial runs a sidecar, a fake upstream and this proxy on your machine
with no key and no cost: in a checkout, run `npm ci` once at the root, then `node examples/relay-trial/trial.mjs`.

## Provider check: `tapeapi-doctor` (experimental)

Providers check their own AI service, step by step, from the name to a receipt that verifies:

```bash
npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.3.0/tapeapi-sdk-1.3.0.tgz tapeapi-doctor <your TapeOut name or your sidecar's https URL>
```

Every failed check says what is missing, where to fix it and the next command, in English and Chinese. Exit status 0
passed, 1 failed, 2 a usage mistake, 3 undecided (run it again); `--help` lists every option. Experimental: its checks
and output may change in a 1.x release.

With `--strict` a receipt that does not verify becomes an error to the client. `tapeapi-verify --help` lists every
option. In your own code, `createVerifyingFetch` from `@tapeapi/sdk/ai` does the same without a proxy
([AI providers](https://tapeapi.fun/docs/en/ai-providers)).

## Docs

- [Call a service](https://tapeapi.fun/docs/en/consume)
- [Public API](https://tapeapi.fun/docs/en/public-api) (`11.1013.tape`, free)
- [Agents and WebMCP](https://tapeapi.fun/docs/en/agents)
- [Private channels](https://tapeapi.fun/docs/en/channels)
- [All docs](https://tapeapi.fun/docs/) · [Playground](https://tapeapi.fun/playground/) · [Specifications](https://github.com/BruceLanLan/tapeapi/tree/main/spec)

## License

MIT
