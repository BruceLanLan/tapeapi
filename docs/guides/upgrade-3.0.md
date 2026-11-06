# Upgrading from 2.x to 3.0

TapeAPI 3.0.0 was released on 2026-11-06. This page lists its five breaking changes, what each one
breaks, and the option that keeps the 2.x behaviour; anything not listed here works in 3.0 as it does in 2.x. 2.x
receives security fixes for 6 months after 3.0.0 (see "Support windows" below). Coming from 1.x, read
[Upgrading to 2.0](upgrade-2.0.md) first.

## Who needs to do anything

Most code needs no change. You have something to do only if one of these is true:

- You install or run the packages on **Node.js 20**.
- You call **`createAIProxy`** with a `formats` list that leaves out a built-in format, and rely on requests of that
  format reaching your upstream without a receipt.
- You call a **`createMcpProxy`** proxy (or `examples/mcp-proxy`) **from a web page**, including the holder console
  at `https://tapeapi.fun/console/` while you publish your tool list.
- You run **`tapeapi-verify`** (or `tapeapi connect --proxy`) and want a receipt that does not verify to be logged and
  passed on rather than turned into an error.
- You run **`createMcpProxy`** or **`tapeapi-mcp`** in front of an upstream MCP server that answers `server/discover`
  wrongly, or you count the requests your upstream receives.

Clients that only call services with `createTapeAPI()`, read receipts, use channels or groups, or call the public
service `api.tapeapi.fun` (including its MCP endpoint) change nothing once they run on Node.js 22 or later.

## What 3.0 keeps

The three levels of the promise stay: **Stable** (no breaking change within 3.x; additions in any minor release),
**Experimental** (`@experimental`, may change in a minor release, each change in the changelog) and **Internal**. Code
written to the 3.0 docs keeps working in every 3.x release, as code written to the 2.0 docs does in every 2.x release.
A breaking change comes only in a new major version.

## Breaking changes

Search your code for the name in the first column. Each row has a way back to the 2.x behaviour except the first.

| Where | 2.x | 3.0 | To keep the 2.x behaviour |
|---|---|---|---|
| `engines` of every package, CI | Node.js 20 or later; CI tests 20 and 22 | Node.js 22 or later; CI tests 22 and 24 | None: stay on 2.x |
| `createAIProxy({ formats })` | A metered path of a built-in format that `formats` leaves out is passed to your upstream without a receipt | It is answered HTTP 400 `bad_path` and never forwarded | `refuseOtherFormats: false` |
| `createMcpProxy` | Any browser `Origin` is accepted, answers carry CORS `*` | A request whose `Origin` is not in `allowedOrigins` is answered HTTP 403 | `allowedOrigins: '*'` (`ALLOWED_ORIGINS=*` in `examples/mcp-proxy`) |
| `tapeapi-verify` | A receipt that does not verify is logged and the answer passed on (unless `--strict`) | It is an error to your client (HTTP 502, or an error event at the end of a stream) | `--no-strict` |
| `createMcpProxy`, `tapeapi-mcp` | The upstream is opened with `initialize` | The upstream is first asked `server/discover`; MCP 2026-07-28 is spoken when offered, `initialize` otherwise | `upstreamNegotiation: 'legacy'`, `tapeapi-mcp --upstream-negotiation legacy` |

### 1. Node.js 22 or later

Every package (`@tapeapi/sdk`, `@tapeapi/server`, `@tapeapi/interop`, `@tapeapi/passport`, `@tapeapi/policy-circuit`)
now declares `"engines": { "node": ">=22" }`, and CI tests Node.js 22 and 24 instead of 20 and 22. Node.js 20 is no
longer tested. Nothing in the code checks the version at run time, so an install on Node.js 20 only warns (unless you
turned on npm's `engine-strict`), but a failure there is not a bug we will fix. Browsers, Deno, Bun and Cloudflare
Workers are not affected: none of them reads `engines`. If you run `npm test` inside one of the packages, it now runs
`node --test "test/*.test.mjs"`; the old `node --test test` stopped working on Node.js 22.

There is no option for this one. To stay on Node.js 20, stay on 2.x.

### 2. `createAIProxy` refuses formats it does not serve

When `formats` leaves out one of the built-in formats (OpenAI Chat Completions, OpenAI Responses, Anthropic Messages,
OpenAI Embeddings), a request to a metered path of that format (for example `POST /v1/messages` on a sidecar that
serves only `openai-chat`) is now answered HTTP 400 `bad_path` with the `x-tapeapi-sidecar-error` header and is never
forwarded. In 2.x it reached your upstream and came back without a receipt, so a client could not tell a signed answer
from an unsigned one.

- If your upstream does serve the format, add it to `formats`: it then gets receipts.
- If you rely on the pass-through, pass `refuseOtherFormats: false`.

```js
// 3.0: POST /v1/messages is answered 400 bad_path
createAIProxy({ ...opts, formats: ['openai-chat'] })
// the 2.x pass-through, without a receipt
createAIProxy({ ...opts, formats: ['openai-chat'], refuseOtherFormats: false })
```

Unmetered paths (`/v1/models`, `/v1/messages/count_tokens`, …) still pass through as before, and a sidecar built with
the default `formats` (all four) refuses nothing. The sidecar templates in `examples/` already refused such paths
(they set the option with a hint naming `FORMATS`); they behave as before. The option itself is still
`@experimental`; only its default changed.

### 3. `createMcpProxy` refuses browser origins you did not list

MCP Streamable HTTP asks servers to validate the `Origin` header. A proxy running on your own machine in front of tools
with side effects (files, a shell, a database) was, under CORS `*`, callable from any web page you opened. In 3.0 a
request to `/mcp` that carries an `Origin` header not listed in `allowedOrigins` is answered HTTP 403 (a JSON-RPC
error without id) before anything runs, preflight (`OPTIONS`) included.

- Desktop MCP clients (Claude Desktop, Claude Code, Cursor, …) and `curl` send no `Origin` and are answered as before.
  Their answers no longer carry `access-control-allow-origin: *` (and carry `vary: origin`), which only browsers read.
- To allow a page, list its exact origin: `allowedOrigins: ['https://app.example']`.
- The holder console at `https://tapeapi.fun/console/` reads `tools/list` from your browser, so while you publish with
  it, list `https://tapeapi.fun`.
- To restore the 2.x behaviour (any origin, CORS `*`), pass `allowedOrigins: '*'`. `['*']` (an array) is still
  refused as a mistake.

```js
createMcpProxy({ ...opts, allowedOrigins: ['https://tapeapi.fun'] })   // the console may read tools/list
createMcpProxy({ ...opts, allowedOrigins: '*' })                         // 2.x: any origin
```

In `examples/mcp-proxy/index.mjs` the variable is `ALLOWED_ORIGINS`: comma-separated origins, or
`ALLOWED_ORIGINS=*` for any. The Cloudflare Worker
template `examples/mcp-proxy/worker.js` keeps any origin unless its `ALLOWED_ORIGINS` lists some. `createMcpEndpoint`
is unchanged: its default is still any origin, and it now also accepts `'*'` (see "What does not change" below).

### 4. `tapeapi-verify` is strict by default

A receipt that does not verify is now an error your client sees: HTTP 502 (`receipt_invalid`, `x-should-retry: false`)
for a JSON answer, or a format-shaped error event in place of a stream's final event, as `createVerifyingFetch` from
`@tapeapi/sdk/ai` already did. The refusals that used to need `--strict` are on by default too:

- a metered path written loosely (`/v1//messages`) and a call to a format the manifest does not declare are answered
  HTTP 400 without being forwarded;
- with `--request-usage`, a body that cannot be changed is refused (`usage_request_skipped`);
- an HTTP error the service answers without a receipt (other than an error the sidecar marks as its own with
  `x-tapeapi-sidecar-error`) is turned into HTTP 502.

To get the 2.x behaviour, where a failure is only logged and the answer is passed on, add `--no-strict`. With
`tapeapi connect --proxy`, the same flag is passed on to `tapeapi-verify`. `--strict` is still accepted and changes
nothing, so saved Claude Code or Codex settings that name it keep working; `tapeapi connect` refuses both together as a usage error.

```bash
tapeapi-verify 42.1013.tape --no-strict              # 42.1013.tape: an example name
tapeapi connect 42.1013.tape --proxy --no-strict
```

Before you add `--no-strict`, check why receipts fail: the usual causes are a clock more than 300 seconds off
(`--max-skew`) or a sidecar whose price table or signer does not match its manifest on chain.

### 5. The MCP signing proxy negotiates its upstream's revision

`createMcpProxy` (and `examples/mcp-proxy`) now first sends its upstream `server/discover` and speaks MCP 2026-07-28 to
an upstream that offers it; an error answer, an HTTP 4xx or no answer in time makes it fall back to `initialize`, as
before. An upstream that speaks only 2026-07-28 now works with no option. `tapeapi-mcp` does the same when it reads a
taped-out MCP server's tools from its `mcp.endpoint`.

What you may notice:

- one more request to each upstream at start-up;
- a network failure of that first request is reported as a failure rather than a fallback;
- an upstream that answers `server/discover` with a result that lists no revision is refused at start-up.

Calls are not affected: they always go through the signed TapeAPI path, and the tools must hash to the same
`mcp.toolsSha256` either way. To keep the 2.x handshake:

```js
createMcpProxy({ ...opts, upstreamNegotiation: 'legacy' })
```

```bash
tapeapi-mcp --upstream-negotiation legacy
```

## What does not change

These stay as they were in 2.x. Each was considered for 3.0 and kept on purpose.

- **`conform: false`** (the 1.x resolution) stays through all of 3.x; it is removed no earlier than 4.0. It is still
  deprecated and reports one warning per client;
  it is the way to use your own addresses, a local chain or a fork.
- **`labels: 'v1'`** (version 1 of private channels and groups) stays. 1.x, whose default is version 1, receives
  security fixes until 2027-04-12, so 3.0 does not cut off 1.x peers: it is kept at least until then.
- **`allChains` stays off.** Turning it on sends your queries to the public nodes of the other chains. The known
  exception to TAP-11 §2.1 therefore remains: without `allChains`, a processor contract#ID string is refused
  (`unsupported`); see [Upgrading to 2.0](upgrade-2.0.md#known-exception-a-processor-contractid-without-allchains-tap-11-21).
- **The public MCP endpoint still accepts any `Origin`.** `createMcpEndpoint`, which serves `api.tapeapi.fun/mcp`
  and `/mcp/pinned`, keeps its default of any origin with CORS `*`. This does not meet MCP Streamable HTTP's "servers
  MUST validate the Origin header", and we say so as we do for the TAP-11 §2.1 exception. The reason: those tools are
  read-only and free and take no credentials, so a web page that calls them gets nothing it could not get without a
  browser, and checking the origin would only break the pages that use them. A server that runs tools with side effects should use `createMcpProxy`
  (which refuses unlisted origins from 3.0) or pass its own `allowedOrigins`.
- **`sentinel` stays `'warn'`.** A hub implementation the SDK does not list is reported, not refused. The site store and
  the payment contract already fail closed in the default mode (`store-changed`).
- **No TAP tightening became the default.** 2.x promised that a tightening of TAP-10 or TAP-11 would first be offered as
  an optional profile and become the default in 3.0. None happened before 3.0.0: `CONFORM_PROFILE` is still
  `'tap10@1.1+tap11@draft'`, and resolution resolves exactly as in 2.x. The same rule applies in 3.x: a loosening or a
  new status name in a minor release, a tightening first as an optional profile and the default only in 4.0.
- **Wire formats and frozen constants.** The wire formats and frozen constants of TAPI-20 to TAPI-27 do not change by
  one byte: a 3.0 client verifies every 1.x and 2.x manifest, delegation, signed response and receipt, and their
  vectors.
- **Also not changed:** `parseUnits` / `formatUnits` keep their default of 8 decimals (BEM), and `createAIProxy` still
  forwards client session headers by default (`forwardSessionHeaders`).

## New experimental packages

3.0 ships three packages next to the SDK, each at **version 0.1.0** with a version of its own (the release tag is the
version of `@tapeapi/sdk` and `@tapeapi/server`). All three are **outside the compatibility promise**: they may change
or go away in any release, and the Stable promise above does not cover them. Install each from the same release as the
SDK.

- **`@tapeapi/interop`**: visitor grants between apps, a prototype (no payment, not a TAP). [Interop](interop.md)
- **`@tapeapi/passport`**: a read-only resolver for Agent Passports, following a draft that has not been merged (TAPs pull request #83, submitted (in review);
  the package implements its text at head `cae25e6`, and the draft has moved since). [Agent Passport](passport.md)
- **`@tapeapi/policy-circuit`**: re-runs a spending rule written as a `tapnet/1` circuit, following a draft that has not been merged
  (TAPs pull request #84, submitted, now a draft PR); an off-chain check that binds only the parties that check it.
  [Policy circuits](policy-circuit.md)

## The escrow token check (experimental)

Paid calls and the escrow are experimental, and **the escrow contract is not audited and not deployed**, so no live
service takes payment and nobody is affected today. The change is listed here because it changes what a paid call
does.

In 2.x only `listen()` read the escrow's `token()` at start-up, and a Worker had to await `checkEscrowToken()` itself.
In 3.0, `handleRequest()` and `invoke()` run the check before the first paid call, on every path. An escrow of another
token, an escrow without `token()`, and nodes that cannot read it all refuse paid calls with an unsigned HTTP 503
`UNSUPPORTED_PAYMENT_TOKEN` (`data.reason` `escrow-token-mismatch`, `escrow-no-token` or `escrow-token-unreadable`):
nothing is signed or billed, and free methods answer as before. A refused call counts against the caller's free
budget. A definite answer (`ok`, `mismatch`, `skipped`) is kept for the instance, and calling
`provider.checkEscrowToken()` yourself returns it, so a mismatch stays for the life of the instance (do not retry). An
escrow without `token()` and a failed read (`escrow-no-token`, `escrow-token-unreadable`) are read again at the next
paid call, and neither is ever taken for a match.

The check is skipped, and paid calls go on without it, when there is no priced method; when there is no escrow; when
`settlementFacts` is configured (the settlement contract is not read) or `enforcement` is (the enforcement backend
checks its own channels and token); when there are no `rpcUrls`; and on a chain other than BNB Smart Chain without
`createProvider({ escrowToken })`. `dev: true` skips it too. See [Run a service](provide.md).

## Support windows

| Version | Security fixes |
|---|---|
| 3.x | Yes: the current major version. |
| 0.x packages (interop, passport, policy-circuit) | No support period: experimental; fixes ship only in a new 0.x release, earlier ones are not patched. |
| 2.x | Security fixes only, for 6 months after the 3.0.0 release date (2026-11-06), that is until 2027-05-06. |
| 1.x | Security fixes only, until 2027-04-12 (6 months after 2.0.0). Not shortened by 3.0. |

The full policy is in [SECURITY.md](../../SECURITY.md).
