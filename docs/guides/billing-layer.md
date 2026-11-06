# A billing layer in front of the sidecar

For operators who already run their own accounts, balances and API keys, and put the TapeAPI signing sidecar behind
them. The sidecar signs; your billing layer charges. This page says how the two fit together, what to hold before
forwarding a call, what to log, and what to tell your users. It is about TapeAPI's tools only: TapeAPI does not run,
host, list or vouch for any such service, and no part of this page takes or makes a payment.

Everything new here is **experimental** (2.5, outside the 2.x compatibility promise): the SDK helpers `ai.amountOf`,
`ai.pricesOf`, `ai.maxAmountOf`, `ai.maxPricesOf` and `ai.completionLimitOf`, the sidecar option
`upstreamResponseHeaders` (`UPSTREAM_RESPONSE_HEADERS`) and the new-api sidecar's `RECEIPT_LOOKUPS_PER_MIN`. All are off
or unused unless you call or set them; nothing changes for a sidecar that does not.

Read [For AI API providers](ai-providers.md) first: it sets up the sidecar, the delegation and the price table.

## The topology

```
user ──► your billing layer ──► TapeAPI sidecar ──► upstream (new-api, LiteLLM, a vendor API)
         keys, balance,         signs every answer
         hold, settle           of the enabled FORMATS
```

- The billing layer authenticates the user, holds funds, forwards the request **byte for byte** to the sidecar, and
  settles from the receipt that comes back. It never changes the request body it forwards (the receipt binds
  `requestSha256`, the hash of the bytes the sidecar received) or the answer it passes back (the receipt binds
  `responseSha256`).
- It passes the receipt on unchanged: the `x-tapeapi-receipt` header of a whole answer, and the `: tapeapi-receipt …`
  comment inside an event stream. If it filters response headers, it keeps `x-tapeapi-receipt` and lists it in
  `access-control-expose-headers`, or a browser client cannot read it.
- The sidecar does no authentication of its own. Keep it reachable only from the billing layer (a private network or
  loopback), not from the internet.
- Your users can check each receipt themselves (`tapeapi-verify`, or `ai.createVerifyingFetch`). A flag in your own
  database is your record, not a verification: do not show "signature verified" unless the signature was checked with
  `ai.verifyUsageReceipt` against the on-chain manifest.

## FORMATS must match what you meter

Set the sidecar's `FORMATS` to exactly the API formats your billing layer meters and your upstream serves, and limit
each model's `formats` in the price table to those. Three places must agree:

| Where | What |
|---|---|
| Your billing layer | the paths it meters and charges (`/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1/embeddings`) |
| The sidecar's `FORMATS` | `openai-chat`, `openai-responses`, `anthropic-messages`, `openai-embeddings` |
| The price table (`models.json`, published on chain) | each model's `formats` |

A path you meter that `FORMATS` leaves out gets no receipt: the sidecar answers it HTTP 400 `bad_path` (since 2.1), so
you would have nothing to settle from. A format the sidecar publishes but your billing layer does not route is a public
claim on chain that your service does not keep. `tapeapi init` (2.3) asks for `FORMATS` explicitly and compares it with
the manifest.

## Charging from the receipt

Charge the amount the receipt carries (`result.prices`, 8 decimals, rounded up), in the currency you bill in. To
recompute it from the usage and your price table, use the SDK's own rule rather than a copy of it:

```js
import { amountOf, pricesOf } from '@tapeapi/sdk/ai'

const entry = models.find((m) => m.id === receipt.result.model)  // or ai.modelEntryOf, which also matches aliases
const usdt = entry.prices.find((p) => p.currency === 'USDT')
const charge = amountOf(usdt, receipt.result.usage)              // '0.00357500', exactly what the sidecar signed
```

Before you charge, check at least that the receipt's `requestSha256` is the SHA-256 of the bytes you forwarded, and for
a whole answer that `responseSha256` is the SHA-256 of the bytes you received (`ai.sha256Hex`). When there is no
receipt (the upstream failed, the stream broke before its end, the price table has no entry for the reported model),
decide in advance what you charge and say so in your terms.

## Sizing the hold

A hold that is a fixed small amount lets one call cost far more than the hold, and many concurrent calls take a balance
far below zero. Size the hold per request instead:

```js
import { completionLimitOf, maxPricesOf, modelEntryOf } from '@tapeapi/sdk/ai'

const body = JSON.parse(requestText)
const entry = modelEntryOf(models, body.model, 'openai-chat')
if (!entry) return refuse(400, 'unknown model')
const completion = completionLimitOf(body, 'openai-chat') ?? MODEL_MAX_OUTPUT[entry.id]   // none declared: the model's own ceiling
if (completion > HARD_CAP_COMPLETION) return refuse(400, 'max_tokens above this service\'s cap')
const prompt = promptTokenBound(body)        // your tokenizer's count, or a conservative estimate (below), plus overhead
const hold = maxPricesOf(entry, { promptTokens: prompt, completionTokens: completion })
// hold: [{ currency: 'USDT', amount: '0.50900000' }, ...]: reserve it atomically, forward, then settle on the receipt
```

`maxAmountOf` prices every prompt token at the dearest of `input`, `cacheRead`, `cacheWrite` and `cacheWrite1h` (a cache
write can cost more than input) and every completion token at the dearer of `output` and `reasoning`, rounded up once:
for any usage within the counts it is never below what the receipt will say. `completionLimitOf` reads the limit the
request declares: Chat Completions the larger of `max_completion_tokens` and `max_tokens`, times `n`; Responses
`max_output_tokens`; Messages `max_tokens` (it includes the thinking budget); Embeddings 0; `null` when the request
declares none.

**What the price table alone cannot bound.** The hold is only as good as the counts you give it:

- **Models that ignore `max_tokens`.** Some upstream models answer past the limit the request set. No arithmetic on the
  price table can bound that call. Enforce a hard cap of your own (a maximum completion limit you accept, and refuse or
  rewrite requests above it), settle on the receipt's `completion_tokens`, and decide in advance what happens when the
  receipt's amount exceeds the hold (charge the difference and allow a bounded negative balance, or absorb it).
- **Prompt tokens you did not count.** An upstream may add a hidden system prompt (billed as input), a chat template,
  tool definitions, images, audio or files. The UTF-8 length of the text in the request is a rough upper bound for the
  text itself under byte-level tokenizers, not for any of these. Add a margin per call, count images and files by the
  upstream's own rules, or cap their size.
- **The reported model.** The receipt is priced on the model the upstream reports, which may differ from the one
  requested (an alias, or another model). If your table has dearer entries the upstream might report, hold on the
  dearest one, or refuse answers whose reported model is not the requested one.
- **Concurrency.** Holds must be taken atomically, and the sum of open holds must stay within the balance. Limit
  concurrent calls per user, not per key: a user can create many keys.

## Receipt lookups

The answer carries its receipt; that copy is the primary one. The sidecar also keeps each receipt in memory for an hour
(`RECEIPT_TTL_S`; lost on restart) and serves it by the free `receipt` method, limited per client IP: 10 lookups per
minute by default. A billing layer that looks receipts up from one address shares one bucket for the whole site; set
`RECEIPT_LOOKUPS_PER_MIN` (new-api and LiteLLM sidecars from 2.5; the Cloudflare Worker already reads it) to what you need,
for example 600. `0` refuses every lookup, as in the Worker; `off` gives the method no budget of its own (only `RATE_IP` then limits it). Anything else is setup mode, naming the variable. Prefer reading the receipt from the answer; use lookups
only to recover from a dropped connection.

## Upstream headers

Upstream response headers can name your channels, your providers or your costs. Set `UPSTREAM_RESPONSE_HEADERS` (or
`upstreamResponseHeaders` in `createAIProxy`) to the upstream headers your users may see, for example
`x-request-id`: every other upstream header is dropped. Two are always kept: `content-type`, as its media type with
`charset` and `boundary` only (any other parameter could carry what the list hides), and `retry-after`, so clients can
back off on a 429 or 503. The sidecar's own headers (the receipt, CORS) are added as before. Headers are not part of a
receipt, so receipts and answer bytes are the same with or without it. Unset or empty, there is no allowlist and every
header passes as before; to pass none beyond those two, set it to `content-type`. This filters headers only: the answer body (its `id`
format, the reported `model`, any usage fields) passes through unchanged, because the receipt signs those bytes.

## Model names

The receipt's `model` is what the signer says the upstream reported. If anything between the sidecar and the upstream
rewrites model names (a proxy that maps upstream names to your price table ids), the receipt then carries the rewritten
name. That is allowed by the format, but it must not be invisible:

- **Disclose it** on your pricing page or in your terms: "the model in a receipt is our price-table id, not the name
  the upstream returned".
- **Log both names** for every call in your own records: the model requested and the model the upstream reported
  before any rewriting, so that an audit or a dispute can see both.
- **Never claim that a receipt proves which model ran upstream.** A receipt proves who signed, over exactly which
  request and response bytes, and what usage and price were claimed. It does not prove the upstream model or channel.

## What to tell your users

Suggested wording for your site footer or terms (replace `<operator>` with your name):

> Receipts in TapeAPI format, signed by `<operator>`. TapeAPI does not operate or endorse this service.

Do not use TapeAPI's name or logo as if it ran, checked or recommended your service; do not describe receipts as proof
of the upstream model; and say that "verified" in your interface means the user's own client checked the signature,
when that is so.

## Upgrading a sidecar from 2.0 to 2.4

For a sidecar deployed from 2.0.0 (the new-api package, the LiteLLM package or the Cloudflare Worker). Pin the version
you deploy (a release tarball with its SHA-256, or a tag's commit), read the changelog, then run `tapeapi doctor
<name>` after the upgrade.

| Version | What changes for a sidecar operator | What to do |
|---|---|---|
| 2.1.0 | `FORMATS`: set, only those formats are published and signed, and a metered path of a format left out is HTTP 400 `bad_path`; unset, all four as in 2.0.0, with a `WARNING` in the log and in `/tapeapi/v1/health`; an unknown name, or a model whose `formats` lists a format not enabled, is setup mode. `pricing-convert.mjs` turns new-api's `/api/pricing` into `models.json`. `tapeapi connect` | Set `FORMATS` to what your upstream really serves and your billing layer meters; republish the manifest if it changes the formats. Use the converter instead of your own conversion script. |
| 2.2.0 | `tapeapi receipts` and `tapeapi reconcile` (with `--preset new-api`); the doctor's `paidUntil` and `monthlyFeeWei` fields | Reconcile receipts against your own ledger or your upstream's bill. |
| 2.3.0 | `tapeapi init` (asks for `FORMATS`, compares it with the manifest) and `tapeapi prices convert|check|show`; the doctor reports a sidecar in setup mode with its `missing` and `problem` | Use `prices check` in your daily check for price drift. |
| 2.4.0 | Nothing for the AI sidecar (MCP tool methods only) | None. |
| 2.5.0 | The experimental helpers and options on this page (`ai.amountOf`, `ai.pricesOf`, `ai.maxAmountOf`, `ai.maxPricesOf`, `ai.completionLimitOf`, `RECEIPT_LOOKUPS_PER_MIN`, `UPSTREAM_RESPONSE_HEADERS`); `tapeapi reconcile` checks each request against its receipt, reading the output limit with the same `ai.completionLimitOf`; MCP revision 2026-07-28 on the MCP entry points only (nothing for the AI sidecar); defaults unchanged | Optional: `RECEIPT_LOOKUPS_PER_MIN`, `UPSTREAM_RESPONSE_HEADERS`, and the SDK helpers in your billing layer. From 2.5 the new-api and LiteLLM sidecars read these two variables, which 2.4 ignored: a malformed value left over in your compose file now puts the sidecar into setup mode (every `/v1/*` answer is 503 and `/tapeapi/v1/health` names the variable), so check both before you upgrade. Use the SDK helpers instead of your own copy of the price rule. Export your ledger with columns your users can name in `--map`: [Reconcile your receipts, for operators](reconcile.md#for-operators-give-your-users-rows-they-can-reconcile). |

The receipt format (TAPI-21), the manifest's `ai` field (TAPI-20) and their test vectors did not change between 2.0 and
2.4: receipts signed by a 2.0 sidecar verify with a 2.4 client and the other way round.
