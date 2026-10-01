# For AI API providers

You already run an AI API: a relay on new-api, a gateway, an aggregator, or your own open models. TapeAPI adds a signing
sidecar in front of it. Your API, your keys and your billing stay exactly as they are; your users keep their official
SDKs and change only the base URL.

This guide is for providers that operate within their upstream providers' terms (see [Compliance](#compliance)).

## From zero to live

Start from nothing (no circuit, no container) and check every step before the next one. Every step is yours to pay for
and to run: TapeAPI hosts no one's sidecar and pays for no circuit, container or gas. `42.1013.tape` in this guide is an
example name; no service is published under it. In the commands, put your own TapeOut name and your sidecar's address.

Step 0 needs a checkout of this repository with its dependencies installed, once, at its root (Node.js 20 or later):

```sh
git clone https://github.com/BruceLanLan/tapeapi.git && cd tapeapi
npm ci --no-audit --no-fund
```

The checks of steps 1 to 7 are `tapeapi-doctor` (experimental), which ships in the SDK's release package since 1.2.0.
Every `tapeapi-doctor` in the table stands for this, run from any directory, with nothing to clone:

```sh
npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.4.0/tapeapi-sdk-1.4.0.tgz tapeapi-doctor <your name>
```

In a checkout, `node sdk/bin/tapeapi-doctor.js <your name>` at its root does the same. Either way the report writes
the next command the way you ran it.

| # | Step | Where (who pays) | Check | What you should see |
|---|---|---|---|---|
| 0 | See the whole path work on your machine: no key, no circuit, no cost | a checkout of this repository, after `npm ci` at its root (above) | `node examples/relay-trial/trial.mjs` | it prints "The trial passed." |
| 1 | Get a TapeOut circuit | [tapeout.net](https://tapeout.net) (you buy it) | `tapeapi-doctor <your name>` | `name` and `circuit` pass |
| 2 | Open its container | tapeout.net (one transaction, your gas) | `tapeapi-doctor <your name>` | `container` passes; `activation` warns until step 2b; `manifest-file` fails, as it should until step 5 |
| 2b | Activate the name ([TAP-10 §6.3](https://github.com/TapeOutProtocol/TAPs)): without it a TAP-11 client gets `unpaid` and does not resolve your service | the holder's wallet calls `bind("<your name>", <your container>, <months>)` on DomainBinding of your chain, with `msg.value` = months × `monthlyFee()` (you pay the fee, in BNB, OKB or ETH, and the gas); the doctor prints the exact call and the fee it reads from the chain now, which can change at any time | `tapeapi-doctor <your name>` | `activation` passes and shows the date it is paid until |
| 3 | Run the sidecar in front of your gateway, on your server, behind your HTTPS reverse proxy | [below](#choose-how-to-run-the-sidecar) (your server) | `tapeapi-doctor --offline https://api.example.com` | the report names the setup-mode variables still missing |
| 4 | Service key and delegation; put the values in `.env` and restart the sidecar | [holder console](https://tapeapi.fun/console/) steps 3 and 4 (no fee, no gas) | `tapeapi-doctor https://api.example.com` | `delegation`, `reach` and `receipt` pass; `manifest-file` warns "not published on chain yet" |
| 5 | Publish the manifest, price table included | console step 5 (one transaction, your gas) | `tapeapi-doctor <your name>` | every check passes: exit status 0 |
| 6 | Tell your users | [What your users do](#what-your-users-do) | `tapeapi-verify <your name>` on a user's machine | one `OK` line per call |
| 7 | Renew the delegation every 90 days, and keep the activation paid | console step 4, "Renew"; pay again as in step 2b | `tapeapi-doctor <your name>`, daily in your CI | `delegation` warns from 30 days before expiry; `activation` warns once the name is no longer paid |

`tapeapi-doctor` checks, in order: the name resolves, the circuit exists, the container is opened, the name is activated
(TAP-10 §6.3; a warning only: the site files stay readable, but a TAP-11 client answers `unpaid` and does not resolve the
service), the manifest file is on chain, its format, the delegation (and the days left), the `ai` field, the price table, the endpoints, that they are
reachable (TLS, sidecar out of setup mode, the key it signs with), CORS, that a real request gets a receipt that
verifies, and the receipt lookup. That request costs nothing: it carries a key that cannot be valid, your gateway
refuses it, and the sidecar signs a receipt for the refusal too. If your gateway accepts any key, it answers instead,
and each run costs you a few input tokens and 1 output token per endpoint (16 on `openai-responses`, whose minimum is
16); the `receipt` check then warns you to fix the gateway's authentication. `--key-env VAR` adds one real call per
endpoint with your own key, of the same size, at whatever your gateway charges. That key goes only to the host you are
checking (the URL you give, or, for a name, the hosts of its signed `endpoints.live`), never to another host a manifest
names, and only over https (plain http only to a loopback sidecar with `--allow-http`); every text in the report,
`--json` included, shows it as `***`, even when a gateway echoes it back. Every check that fails says what is missing,
where to fix it and the next command, in English and Chinese. Exit status: 0 passed (warnings allowed; `--strict` counts
them), 1 a check failed, 2 a usage mistake, 3 the chain or the network could not be read (a timeout, a refused
connection, DNS: run it again); `--json` prints the report for CI; `--lang en` or `--lang zh` prints one language only. It
reads only: it signs nothing and sends no transaction. Given a sidecar's URL, it probes that address, not the one the
served manifest publishes, and warns when the two differ. It is experimental: its checks and its output may still change
in a 1.x release.

Once every check passes, you may list your service in the [provider directory](https://tapeapi.fun/directory/) with a
pull request of your own that adds its name to `site/directory/providers.json` (the steps are in
[`directory/`](https://github.com/BruceLanLan/tapeapi/tree/main/directory)). The directory reruns the doctor on every
entry once a day and shows the result. A listing only means the automated checks passed, not a recommendation, a
guarantee or an audit; your service works the same without one.

## What you get

- **An on-chain identity.** The service is a TapeOut circuit's container. Who answered is a chain lookup; move to
  another domain or server and users follow the on-chain record.
- **A price list pinned on chain.** The manifest's `ai` field ([TAPI-20 §3.9](../../spec/TAPI-20.md)) lists one endpoint
  per API format and your price table: per model, one price per currency, per 1M tokens, with cache and reasoning
  prices where you charge them. Anyone can recompute what a call should cost.
- **A signed usage receipt for every call** ([TAPI-21 §3.5](../../spec/TAPI-21.md)): the model, the token counts, the
  amount per currency, whether the answer completed, and the hashes of the exact request and response bytes, signed by
  the key your circuit's holder delegated. Receipts ride along with the answer (a response header, or an SSE comment the
  official SDKs ignore), so nothing breaks for clients that do not read them.
- **No custody.** TapeAPI holds no keys, no funds and no traffic of yours. The sidecar runs on your own machine; the
  identity and the price list live on chain, readable without any server of ours.
- **No change for your users.** OpenAI Chat Completions, OpenAI Responses, Anthropic Messages and OpenAI Embeddings pass
  through byte for byte, streams included. Claude Code, Codex and the official SDKs work as before.

## What a receipt proves, and what it does not

A receipt proves **who answered** (the on-chain signer), **to exactly which request bytes**, **with exactly which
response bytes**, and **what usage and price were claimed**. It does **not** prove which model actually ran: a provider
could label a cheaper model's answer as a dearer one. What the signature adds is that such a substitution is
**attributable**: a receipt cannot be disowned, so spot checks (anyone sending test prompts and publishing the
results) leave evidence. Say this plainly to your users.

## Choose how to run the sidecar

The same sidecar (`createAIProxy` from `@tapeapi/server/ai-proxy`) comes in several packages. Whichever you pick, you run
it: it sees your users' API keys, so TapeAPI never hosts it for you.

| You run | Use | Where |
|---|---|---|
| **new-api** | A docker-compose package: new-api plus the sidecar in front of it, both on loopback behind your HTTPS reverse proxy | [`examples/new-api-sidecar/`](../../examples/new-api-sidecar/) |
| Any OpenAI- or Anthropic-compatible API, on a server | Node: the example entry, or `createAIProxy` inside your own server (it is a fetch-style handler) | [`examples/ai-proxy/index.mjs`](../../examples/ai-proxy/index.mjs) |
| Any such API, without a server of your own | A Cloudflare Worker on a hostname of yours, in front of your API | [`examples/ai-proxy/worker.js`](../../examples/ai-proxy/worker.js) |
| **LiteLLM Proxy** | A docker-compose package: LiteLLM (with its PostgreSQL) plus the sidecar in front of it, all on loopback behind your HTTPS reverse proxy; the price table's `id`s are LiteLLM's `model_name`s | [`examples/litellm-sidecar/`](../../examples/litellm-sidecar/) |

The sidecar sits **in front of** your gateway, never inside it: new-api has no hook on text relaying, a LiteLLM callback
sees parsed Python objects rather than the bytes a receipt proves, and in front the receipt covers the price and usage
you charge your own users.

### The new-api package in brief

```sh
git clone https://github.com/BruceLanLan/tapeapi.git && cd tapeapi/examples/new-api-sidecar
cp env.example .env && cp models.example.json models.json     # fill in both
docker compose up -d
```

From this directory the checkout's doctor is `node ../../sdk/bin/tapeapi-doctor.js`; the `npx` form of the table works
from anywhere.

Your reverse proxy sends `https://api.example.com` to the sidecar (`127.0.0.1:8080`) and new-api's web console to
`127.0.0.1:3000` on a hostname of its own. Until the identity is complete the sidecar runs in setup mode and says what
is missing. The package's [README](../../examples/new-api-sidecar/README.md) has the full steps, the reverse-proxy
settings, how to add the sidecar to an existing new-api deployment, and how to try it all locally without Docker.

## The price table

The table is a JSON array; the sidecar publishes it in the manifest and prices every receipt from it:

```json
[
  { "id": "claude-sonnet-4-5", "aliases": ["claude-sonnet-4-5-20250929"], "prices": [
    { "currency": "USDT", "unit": "1M tokens", "input": "3", "output": "15", "cacheRead": "0.3", "cacheWrite": "3.75", "cacheWrite1h": "6" }
  ] },
  { "id": "text-embedding-3-small", "formats": ["openai-embeddings"], "prices": [
    { "currency": "USDT", "unit": "1M tokens", "input": "0.02", "output": "0" }
  ] }
]
```

- Currencies: `BEM`, `BNB`, `USDT`, `USDC`, `ETH`, `USD1`, or `USD` for display only; one entry per currency.
- Prices are decimal strings per 1M tokens: `input` and `output`, and optionally `cacheRead`, `cacheWrite`,
  `cacheWrite1h` and `reasoning`.
- A receipt is priced by the model the upstream **reported**, matched exactly against each `id` and alias. If your
  gateway renames models, list the reported names as `aliases`, or those receipts carry no price.
- **Prices are published, not settled.** Your users pay you as they do today; the amount in a receipt is a checkable
  claim, not a payment.

## Identity and publishing the manifest

The identity steps are those of any TapeAPI service (see [Run a service](provide.md)), done in the holder console at
[tapeapi.fun/console](https://tapeapi.fun/console/): connect the wallet that holds the circuit, generate the service key
(it becomes the sidecar's `SIGNER_KEY`), sign the delegation (the console reads the sidecar's signing address from its
setup-mode health check; the delegation lasts 90 days), then publish the manifest on chain.

### Publish the price table with the console

Step 5 of the console publishes the sidecar's manifest, `ai` field included:

1. **Preview (optional, no wallet needed).** In step 5, paste or upload your `models.json` (the sidecar's price table,
   a bare array of models), the `ai` field itself, or a whole manifest. A `models.json` has no addresses, so the page adds
   one endpoint per format on the service URL of step 4, exactly as the sidecar does (`/v1` for the OpenAI formats, the
   root itself for Anthropic Messages). The page checks the field with the same rules as the SDK's `validateAIField`
   (TAPI-20 §3.9) and shows it as tables: every API format with its address, then every model with its aliases and, per
   currency, the input, output, cache read, cache write, 1-hour cache write and reasoning prices, per 1M tokens. A price
   the manifest does not state is shown in grey italics with the value the spec gives it (cache prices default to
   `input`, 1-hour cache writes to `cacheWrite`, reasoning to `output`).
2. **Hints, not refusals.** Cells and a list below the table point out what is probably a mistake: a price of 0, a price
   far above what any model costs (per currency; for example above 1,000 USDT per 1M tokens: a missing decimal point?),
   an output price below the input price, a cache read dearer than input, an endpoint clients would ignore, `USD` (display
   only), and a table too large for one transaction. They never stop publishing: you decide.
3. **Check and publish.** The page reads the manifest the sidecar serves, checks every field as before and the `ai`
   field as the SDK does, and requires a previewed table to be exactly the served one. It shows the price table again,
   then asks your wallet to confirm the one `SiteRegistry.putFile` transaction. The delegation of step 4 covers only the
   signing key; this transaction is what puts the prices on chain.
4. **Read back.** Once the transaction is mined, the page reads the manifest back from the chain as every client does
   (length and SHA-256 against the SiteRegistry) and confirms the bytes, price table included, are the ones it sent.

Prices are published, not settled, on every chain. The console publishes on BNB Chain, X Layer and Base; on X Layer and
Base payments are not open, and the page says so: the table is for display only there. Under TAPI-20 §3.9 the currencies
`BNB`, `USDT`, `USDC`, `ETH` and `USD1` name the tokens on BNB Chain.

**Renewal.** Renew the delegation in its last 30 days: console step 4, "Renew" (same service key), set the new
`DELEGATION_EXPIRES` and `DELEGATION_SIG`, restart the sidecar, and publish again. An expired delegation stops the
service until it is renewed.

## What your users do

They keep their keys and their SDKs and change the base URL to the endpoint of their format in your manifest:

| Client | Base URL |
|---|---|
| OpenAI SDKs and OpenAI-compatible tools | `https://api.example.com/v1` |
| Anthropic SDKs, Claude Code (`ANTHROPIC_BASE_URL`) | `https://api.example.com` (the SDK adds `/v1`) |
| Codex (`OPENAI_BASE_URL`, or `base_url` in `config.toml` with `wire_api = "responses"`) | `https://api.example.com/v1` |

**Checking receipts.** Developers wrap the official SDK's fetch; every answer is then checked against the manifest on
chain (signer, price table, exact bytes), and a receipt that fails is an error, never swallowed:

```js
import OpenAI from 'openai'
import { createTapeAPI, rpcUrlsFor, ai } from '@tapeapi/sdk'

const api = createTapeAPI({ rpcUrls: rpcUrlsFor(56) })            // BNB Chain nodes of distinct operators, 2 must agree
const svc = await api.resolve('42.1013.tape')                    // your service's TapeOut name (this one is an example)
const fetch = ai.createVerifyingFetch({ api, service: svc })
const baseURL = svc.manifest.ai.endpoints.find((e) => e.format === 'openai-chat').baseUrl
const client = new OpenAI({ baseURL, apiKey: process.env.API_KEY, fetch })  // the user's key with your service, as before
```

Use the `baseUrl` from the manifest exactly. A request to a metered path on any other host (`localhost` for
`127.0.0.1`, another port) is refused with `INVALID_ARGUMENT` before it is sent, naming the endpoint it expected; with
`strict: false` it goes through and `onReport` says `not verified: endpoint mismatch`. So is a metered path written
loosely (`/v1//chat/completions`, `/v1/chat/%63ompletions`, a trailing `/`), which OpenAI and Anthropic still answer:
`not verified: path mismatch`. Streams are verified too. A
stream ends at its final event, at `[DONE]` or when the connection closes, whichever comes first; with the default
`strict: true` the part in which it ends is passed on only once a receipt that came before it verifies, so a stream
that fails makes the SDK's iterator throw `RECEIPT_INVALID`. With `strict: false` nothing is held back, and the
verdict goes to `onReport`. A whole (not streamed) answer whose receipt fails comes back, in strict mode, as an HTTP
502 in the API's error shape with code `RECEIPT_INVALID` and the headers `x-should-retry: false` and
`x-tapeapi-verify-error: RECEIPT_INVALID`: the official SDKs throw an `APIError` and do not retry it; code that calls
the fetch itself checks `res.ok`. Whether a paid call is retried after other 5xx errors is up to you (the SDKs'
`maxRetries`).

**Claude Code and Codex users** cannot read receipts themselves. They run the local verifying proxy `tapeapi-verify`
and point the client at it. `tapeapi-verify` keeps running in the foreground, so the client starts in a second terminal:

```sh
# Terminal 1. 42.1013.tape is an example name: put your service's TapeOut name here
npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.4.0/tapeapi-sdk-1.4.0.tgz tapeapi-verify 42.1013.tape
```

```sh
# Terminal 2, macOS or Linux
ANTHROPIC_BASE_URL=http://127.0.0.1:8790 claude
OPENAI_BASE_URL=http://127.0.0.1:8790/v1 codex             # Codex (or base_url in config.toml)
```

```powershell
# Terminal 2, Windows PowerShell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8790"; claude
$env:OPENAI_BASE_URL="http://127.0.0.1:8790/v1"; codex
```

With the example name as written it stops with "no file at /.well-known/tapeapi.json": nothing is published under
`42.1013.tape`. No service of your own yet? Run the local trial first ([From zero to live](#from-zero-to-live), step 0):
it runs this proxy against a local sidecar.

It resolves your service on chain, passes the answers through unchanged, prints one verdict per call, and with
`--strict` turns a failed receipt into an error the client sees. A single receipt can also be pasted into the
[verification page](https://tapeapi.fun/verify/). All of these need your manifest on chain (console step 5, above).

**Request salt (on by default in both).** A receipt carries `requestSha256`, the SHA-256 of the exact request bytes,
and the official SDKs serialise a request the same way every time. A short prompt ("yes", one word to embed, a question
from a known list) could then be confirmed from a shared receipt by hashing guesses. So `createVerifyingFetch` and
`tapeapi-verify` append 64 random whitespace characters (space, tab, line feed, carriage return: 128 random bits) after
the JSON text of each request body on a receipt path, and the receipt is checked over the bytes actually sent.

- **Why prompt caching is unaffected:** JSON allows whitespace after the value (RFC 8259 §2), so the upstream parses
  exactly the same request. The whitespace is outside every string, so it is in no message and becomes no token; the
  caches (OpenAI's automatic prefix cache, Anthropic's `cache_control` breakpoints) are keyed on the parsed prompt's
  tokens, which are identical.
- **No field is added or changed.** In particular `user` (OpenAI) and `metadata.user_id` (Anthropic, which Claude Code
  already sets) stay as the client wrote them: gateways use them to route a conversation to the same account, which is
  what makes its cache hit.
- **Left alone:** compressed bodies (`Content-Encoding` other than `identity`: appending would corrupt them), non-JSON
  bodies, and every path without a receipt. `salt: false` / `--no-salt` sends the bytes exactly as written.
- A proxy that re-serialises the request between the client and the sidecar changes the bytes either way; the receipt
  check then fails on `requestSha256`, which is how such a proxy shows itself.
- **Not yet measured:** the JSON grammar says every upstream must accept the trailing whitespace, and the tests check it
  against the reference sidecar; a check against the live OpenAI Chat, OpenAI Responses and Anthropic Messages APIs is
  still to be done.

## Fees

There is no mandatory protocol fee, and today nothing is charged by the protocol: prices in the `ai` field are
published, not settled, and the paid-call escrow is not deployed (it will be only after an independent audit). When paid
calls do settle through the TapeAPI escrow, a default 1% maintenance contribution comes out of the provider's share
(the user's price does not change); any provider can set it to 0 for its own service, and the operator has no fee switch.
See [`docs/FEES.md`](../FEES.md).

## Limits

- A receipt proves who answered and what was claimed, not which model ran (above).
- Formats with receipts: OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, OpenAI Embeddings. Other paths
  under `/v1` pass through without a receipt. Not yet: Gemini's native API, WebSocket modes (Realtime, Responses
  WebSocket), Batch.
- Receipts are kept in the sidecar's memory for one hour (configurable); the copy delivered with the answer is the
  primary one. The free `receipt` method has its own per-IP budget. If your upstream's answer ids are guessable
  (Ollama's are `chatcmpl-` and a number below 999; the sidecar's log says so), turn on `requireRequestHash`
  (`RECEIPT_REQUIRE_HASH=1`) so that a lookup must name the request hash as well.
- The sidecar authenticates no one itself: your users' keys go to your gateway as they are, and your gateway decides.
- The sidecar passes the clients' session headers (`x-claude-code-session-id`, `session-id`, `thread-id`) to your
  gateway, as the clients expect; they let whoever receives them tie a user's requests into one session. Set
  `FORWARD_SESSION_HEADERS=0` (`forwardSessionHeaders: false`) to leave them out; a user can do the same on their side
  with `tapeapi-verify --strip-session-headers`.

## Compliance

TapeAPI is for providers operating **within their upstream providers' terms**. Identity, prices and reputation live on
chain, where no single platform can hold them hostage; the protocol does **not** offer, and does not help with,
evading an upstream provider's bans or regional restrictions.

## Security

- The sidecar sees your users' API keys. Run it yourself, on your own machine or account; never let a third party host
  it.
- The service key (`SIGNER_KEY`) signs every receipt. Keep it out of git, chat and screenshots; if it leaks, generate a
  new one in the console and redo the delegation rather than renewing.
- The sidecar stores no prompts and no answers: it keeps signed receipts (hashes, model, token counts, amounts) for an
  hour, and nothing else.

The idea of a service layer for TapeOut came from [@Theairresearch](https://x.com/Theairresearch/status/2101640697426448632).
