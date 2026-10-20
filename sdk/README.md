# @tapeapi/sdk

JavaScript SDK for [TapeAPI](https://tapeapi.fun): find a service on BNB Smart Chain by name, call it, and get an
answer whose signature is checked against the key the service's holder delegated on chain. Paid methods use
EIP-712 vouchers against an escrow; nothing is signed or sent without you.

> **2.4.0.** Semantic versioning: breaking changes come only in a new major version. By default the SDK now resolves as TapeOut's official TAPs say (TAP-10, TAP-11 §2); `conform: false` keeps the 1.x resolution (deprecated). See the [changelog](https://github.com/BruceLanLan/tapeapi/blob/main/CHANGELOG.md) and [Upgrading to 2.0](https://github.com/BruceLanLan/tapeapi/blob/main/docs/guides/upgrade-2.0.md).

## Install

```bash
npm install https://github.com/BruceLanLan/tapeapi/releases/download/v2.4.0/tapeapi-sdk-2.4.0.tgz
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
| `@tapeapi/sdk/channel` | TAPI-26 private channels (invites, relay and ChannelBus transports) |
| `@tapeapi/sdk/bus-privacy` | `busPrivacyReader`: ChannelBus reads that hide your rooms among cover rooms (`@experimental`) |
| `@tapeapi/sdk/ai` | AI usage receipts: `createVerifyingFetch` (a `fetch` for the official OpenAI and Anthropic SDKs that checks every answer's receipt), `verifyUsageReceipt`, the format adapters |
| `@tapeapi/sdk/mcp` | the MCP server core behind `tapeapi-mcp` and `@tapeapi/server/mcp`: tools with signed results and receipts |
| `@tapeapi/sdk/agent` (`@experimental`, 1.7) | container agents, phase 0: holder-signed mandates and task messages (`createAgentKit`, `createPaymentKit`, `forWallet`, `revocationFileBytes`); since 2.0 also bounded agents (phase 1), checked on local chains only, as the escrow is not audited or deployed; outside the 2.x compatibility promise ([guide](https://github.com/BruceLanLan/tapeapi/blob/main/docs/guides/container-agents.md)) |
| `@tapeapi/sdk/review` (`@experimental`, 2.0) | evidence-backed reviews between containers, the reference implementation of a TAP draft that is an open pull request (#54): `makeReview`, `signReview`, `createReviewKit`, `summarizeReviews`; outside the 2.x compatibility promise |
| `@tapeapi/sdk/connect` (`@experimental`, 2.1) | what `tapeapi connect` prints, as data and text, for a command line or a web page: `snippetsFor` (client settings for the formats a manifest declares only), `mcpSnippetsFor` (an MCP tool service's settings, since 2.3), `connectReport`, `renderConnect`; outside the 2.x compatibility promise |
| `@tapeapi/sdk/chains` | `CHAINS` (BNB Smart Chain, X Layer, Base: factory, opener, DeWebHub, SiteRegistry, area code), `parseTapeName`, `formatTapeName` |
| `@tapeapi/sdk/rpc`, `/abi`, `/sig`, `/canon`, `/manifest` | the building blocks |

**Stability (2.0).** Every export is Stable (no breaking change within 2.x) unless its type declaration says
`@experimental` (the whole `agent` subpath, payments, the ServiceDirectory and the `bus-privacy` reader: `api.payer`, `api.acceptPrice`, the payment `api.tx` builders,
`api.chain.escrow`, the conformance results that follow Draft TAPs: `data.status`, `SiteStatus`, `svc.conform`, ...) or `@internal`. Upgrading from 1.x: [docs/guides/upgrade-2.0.md](https://github.com/BruceLanLan/tapeapi/blob/main/docs/guides/upgrade-2.0.md); from 0.x: [docs/guides/upgrade-1.0.md](https://github.com/BruceLanLan/tapeapi/blob/main/docs/guides/upgrade-1.0.md).

## Local MCP server: `tapeapi-mcp`

The package ships a command that exposes any TapeAPI service's free methods as MCP tools over stdio (Claude Desktop,
Cursor, any MCP client), and verifies every answer in your own process before the model sees it:

```bash
npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v2.4.0/tapeapi-sdk-2.4.0.tgz tapeapi-mcp 11.1013.tape
```

```json
{ "mcpServers": { "tapeapi": { "command": "npx", "args": ["-y", "--package=https://github.com/BruceLanLan/tapeapi/releases/download/v2.4.0/tapeapi-sdk-2.4.0.tgz", "tapeapi-mcp", "11.1013.tape"] } } }
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

Since 1.7 it also has a one-shot subcommand, `tapeapi-verify task <thread.json> [--payment <recipient> <index>] [--rpc <url,url,...>]`, that checks a container-agent task thread (and its payment) and exits; see the [container agents guide](https://github.com/BruceLanLan/tapeapi/blob/main/docs/guides/container-agents.md).

```bash
# Terminal 1. 42.1013.tape is an example name: put your AI provider's TapeOut name here
npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v2.4.0/tapeapi-sdk-2.4.0.tgz tapeapi-verify 42.1013.tape
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
npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v2.4.0/tapeapi-sdk-2.4.0.tgz tapeapi-doctor <your TapeOut name or your sidecar's https URL>
```

It runs 14 checks in order, among them that the name is activated on DomainBinding (TAP-10 §6.3; in the 2.0 default a failure,
because a default client cannot resolve an unpaid name; a warning with `--no-conform`). Every failed check says what is missing, where to fix it and the next command, in English and Chinese. Exit status 0
passed, 1 failed, 2 a usage mistake, 3 undecided (run it again); `--help` lists every option. Experimental: its checks
and output may change in a 2.x release. Since 2.2, in `--json`, the `activation` check carries `paidUntil` (ISO 8601),
`paidUntilSeconds` (`containerPaidUntil`) and `monthlyFeeWei` (`monthlyFee()`), `null` with a reason in `unread` when
not read, so a daily check needs no text parsing ([AI providers](https://tapeapi.fun/docs/en/ai-providers)). `null`
does not mean expired: check the check's `status` first and exclude `null` before comparing a date
(`new Date(null) < now` is true).

With `--strict` a receipt that does not verify becomes an error to the client. `tapeapi-verify --help` lists every
option. In your own code, `createVerifyingFetch` from `@tapeapi/sdk/ai` does the same without a proxy
([AI providers](https://tapeapi.fun/docs/en/ai-providers)).

## Describe a service and set up a client: `tapeapi connect` (experimental)

New in 2.1, outside the 2.x compatibility promise (its output, options and exit status may change in any 2.x release).
The `tapeapi` command runs `tapeapi doctor|verify|mcp …` as the three commands above, byte for byte, and adds
`connect`: it resolves an AI service by its TapeOut name (the 2.0 default, TAP-10 / TAP-11), shows it (container,
holder, signer, delegation, activation, formats, the price table; USD for display only) and prints client settings
only for the API formats its manifest declares: nothing for Claude Code without `anthropic-messages`, nothing for
Codex without `openai-responses`. An MCP tool service (no `ai` field, an `mcp` field: TAPI-20 §3.8; since 2.3,
experimental) gets Claude Code and Claude Desktop settings through `tapeapi-mcp` and for its declared endpoint, from
that field only, and `--proxy` runs `tapeapi-mcp`; a manifest with neither field is unavailable (`not-ai`).

```bash
# any directory, no clone needed; 42.1013.tape is an example name: put your provider's TapeOut name here
npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v2.4.0/tapeapi-sdk-2.4.0.tgz tapeapi connect 42.1013.tape
# with the SDK installed, the command is tapeapi connect …
tapeapi connect 42.1013.tape --tool codex    # one tool; exit 2 if the manifest lacks openai-responses
tapeapi connect 42.1013.tape --proxy         # then runs tapeapi-verify for it, as it is
```

In a checkout (`npm ci` once at the root), `node sdk/bin/tapeapi.js connect …` does the same.

It reads the chain and the manifest only: it sends no transaction, asks for no key or password (the settings read
your token from `API_KEY` in your own environment), uploads nothing and pays nothing. A service that is `unpaid`,
`not-opened` or `store-changed` is shown as unavailable with the reason and `--proxy` starts nothing. Exit status 0
usable, 1 unavailable, 2 a usage mistake (also `--tool` / `--format` naming a format the manifest does not declare),
3 could not be read (run it again); `tapeapi connect --help` lists every option. A receipt still does not prove which
model ran.

## Your receipts and a bill: `tapeapi receipts`, `tapeapi reconcile` (experimental)

Since 2.2, outside the 2.x compatibility promise. Both read files on your machine only: no network, no key.
`tapeapi receipts` reads what `tapeapi-verify --log` wrote; `reconcile` sets those receipts against a bill or usage
file from the provider.

```bash
# any directory, no clone needed
npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v2.4.0/tapeapi-sdk-2.4.0.tgz tapeapi receipts tail --receipts ~/.tapeapi/receipts.jsonl
# with the SDK installed, the commands are tapeapi receipts … and tapeapi reconcile …
tapeapi receipts tail   --receipts ~/.tapeapi/receipts.jsonl --model deepseek-v3 --since 2026-10-01
tapeapi receipts show   <id> --receipts ~/.tapeapi/receipts.jsonl   # replays its checks offline
tapeapi receipts export --receipts ~/.tapeapi/ --format csv > receipts.csv
tapeapi reconcile --receipts ~/.tapeapi/receipts.jsonl --bill usage.csv --amount-scale 500000
```

In a checkout (`npm ci` once at the root), `node sdk/bin/tapeapi.js receipts …` and `node sdk/bin/tapeapi.js reconcile …`
do the same.

`show` checks the signature, the container, the method and path and the price table against a manifest snapshot: the
manifest the service publishes, saved next to the receipts as `manifest.json` (or given with `--manifest`); with the
exact request and response bytes (`--request`, `--response`; request bytes exist only from a `tapeapi-verify
--no-salt` run, since it salts requests by default) it checks the two hashes too. Without a snapshot it
decides nothing (exit 3) and fetches nothing. `reconcile` lists three kinds of fact, each with its receipt line and
bill line: match, missing (on one side only), and mismatch (a field that differs from what the receipt claims); it
decides nothing. `--preset new-api` is the field names of the JSON new-api's `GET /api/log/self` returns (`data.items`;
read in new-api's source code, not yet checked against a real instance); new-api's web CSV export has other headers
(localized; `Cost` formatted, not a comparable amount; `request_id`), so it and other bills use `--map`. Exit status 0 all checks pass / all rows match, 1 a check fails / something is
missing or differs, 2 a usage mistake, 3 nothing could be decided.

## For operators: `tapeapi init`, `tapeapi prices` (experimental)

Since 2.3, outside the 2.x compatibility promise. `tapeapi init` walks an operator through the steps from nothing to
live, one step per run: what you do, where, who pays (you), and a read-only check of it (the doctor, `connect`, the
price table files), ending with the next command. It asks for no key, never reads `.env`, pays nothing and sends no
transaction. From step 3 on `--formats` is required, with no default (all four need `--confirm-all-formats`); steps 3
and 4 also need `--upstream new-api` without a terminal (the only gateway this version writes a configuration for; it
is not assumed).
`tapeapi prices convert|check` runs the new-api package's converter (in a checkout) with its arguments, output and exit
status unchanged (say who fetched the price list with its `--fetched-as`); `prices show` prints a price table with its
source record (who fetched the price list, what is not verified).

```bash
node sdk/bin/tapeapi.js init --dir relay --step 3 --upstream new-api --sidecar-url https://api.example.com --formats openai-chat
node sdk/bin/tapeapi.js prices convert pricing.json --status status.json --usd-exchange-rate 7 --out relay/models.json
node sdk/bin/tapeapi.js prices show --models relay/models.json
```

Exit status of `init`: 0 the step is done or waits for you, 1 its check failed, 2 a usage mistake or a missing answer
(`FORMATS` or `--upstream` not given among them), 3 could not be read.

## Docs

- [Call a service](https://tapeapi.fun/docs/en/consume)
- [Public API](https://tapeapi.fun/docs/en/public-api) (`11.1013.tape`, free)
- [Agents and WebMCP](https://tapeapi.fun/docs/en/agents)
- [Private channels](https://tapeapi.fun/docs/en/channels)
- [All docs](https://tapeapi.fun/docs/) · [Playground](https://tapeapi.fun/playground/) · [Specifications](https://github.com/BruceLanLan/tapeapi/tree/main/spec)

## License

MIT
