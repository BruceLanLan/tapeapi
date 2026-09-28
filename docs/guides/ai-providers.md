# For AI API providers

You already run an AI API: a relay on new-api, a gateway, an aggregator, or your own open models. TapeAPI adds a signing
sidecar in front of it. Your API, your keys and your billing stay exactly as they are; your users keep their official
SDKs and change only the base URL.

This guide is for providers that operate within their upstream providers' terms (see [Compliance](#compliance)).

## What you get

- **An on-chain identity.** The service is a TapeOut circuit's container. Who answered is a chain lookup; move to
  another domain or server and users follow the on-chain record.
- **A price list pinned on chain.** The manifest's `ai` field ([TAP-20 §3.9](../../spec/TAP-20.md)) lists one endpoint
  per API format and your price table: per model, one price per currency, per 1M tokens, with cache and reasoning
  prices where you charge them. Anyone can recompute what a call should cost.
- **A signed usage receipt for every call** ([TAP-21 §3.5](../../spec/TAP-21.md)): the model, the token counts, the
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
| LiteLLM Proxy | A LiteLLM callback plugin is planned; until then, put the Node or Worker sidecar in front of LiteLLM | not available yet |

The sidecar sits **in front of** your gateway, never inside it: new-api has no hook on text relaying, and in front the
receipt covers the price and usage you charge your own users.

### The new-api package in brief

```sh
git clone https://github.com/BruceLanLan/tapeapi.git && cd tapeapi/examples/new-api-sidecar
cp env.example .env && cp models.example.json models.json     # fill in both
docker compose up -d
```

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
   (TAP-20 §3.9) and shows it as tables: every API format with its address, then every model with its aliases and, per
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
Base payments are not open, and the page says so: the table is for display only there. Under TAP-20 §3.9 the currencies
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
| Codex (`base_url` in `config.toml`, `wire_api = "responses"`) | `https://api.example.com/v1` |

**Checking receipts.** Developers wrap the official SDK's fetch; every answer is then checked against the manifest on
chain (signer, price table, exact bytes), and a receipt that fails is an error, never swallowed:

```js
import OpenAI from 'openai'
import { createTapeAPI, rpcUrlsFor, ai } from '@tapeapi/sdk'

const api = createTapeAPI({ rpcUrls: rpcUrlsFor(56) })            // BNB Chain nodes of distinct operators, 2 must agree
const svc = await api.resolve('42.1013.tape')                    // your service's TapeOut name
const fetch = ai.createVerifyingFetch({ api, service: svc })
const baseURL = svc.manifest.ai.endpoints.find((e) => e.format === 'openai-chat').baseUrl
const client = new OpenAI({ baseURL, apiKey: process.env.RELAY_KEY, fetch })
```

Use the `baseUrl` from the manifest exactly. A request to a metered path on any other host (`localhost` for
`127.0.0.1`, another port) is refused with `INVALID_ARGUMENT` before it is sent, naming the endpoint it expected; with
`strict: false` it goes through and `onReport` says `not verified: endpoint mismatch`. Streams are verified too. A
stream ends at its final event, at `[DONE]` or when the connection closes, whichever comes first; with the default
`strict: true` the part in which it ends is passed on only once a receipt that came before it verifies, so a stream
that fails makes the SDK's iterator throw `RECEIPT_INVALID`. With `strict: false` nothing is held back, and the
verdict goes to `onReport`. A whole (not streamed) answer whose receipt fails comes back, in strict mode, as an HTTP
502 in the API's error shape with code `RECEIPT_INVALID` and the headers `x-should-retry: false` and
`x-tapeapi-verify-error: RECEIPT_INVALID`: the official SDKs throw an `APIError` and do not retry it; code that calls
the fetch itself checks `res.ok`. Whether a paid call is retried after other 5xx errors is up to you (the SDKs'
`maxRetries`).

**Claude Code and Codex users** cannot read receipts themselves. They run the local verifying proxy `tapeapi-verify`
and point the client at it:

```sh
npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.0.0-rc.1/tapeapi-sdk-1.0.0-rc.1.tgz tapeapi-verify 42.1013.tape
ANTHROPIC_BASE_URL=http://127.0.0.1:8790 claude          # Codex: OPENAI_BASE_URL=http://127.0.0.1:8790/v1 codex
```

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
