# Reconcile your receipts (experimental)

You bought AI calls through a service that signs a usage receipt for every answer, and `tapeapi-verify --log` kept
those receipts on your machine. This guide sets them against what else you have: the provider's bill, the requests you
sent, a mandate you signed for an agent, and your own spending limits. Everything here is `tapeapi reconcile`,
experimental and outside the compatibility promise: it may change or go away in any minor release.

**What it does, and what it never does.** It reads local files only: no network, no key, nothing uploaded, no
telemetry. It lists facts, each with the receipt line it comes from (and the bill line or request file it uses). It
decides nothing: a difference is a question to put to the provider, with the lines to point at. **A receipt proves
only what its signer said**: who signed which request bytes and which answer (its bytes; for a stream, its event data), and what usage and price were claimed. It
does not prove which model ran, and none of these checks can tell which model ran.

```sh
# with the SDK installed; in a checkout, node sdk/bin/tapeapi.js reconcile … does the same
tapeapi reconcile --receipts ~/.tapeapi/receipts.jsonl --bill usage.csv               # against a bill
tapeapi reconcile --receipts ~/.tapeapi/receipts.jsonl --requests ~/.tapeapi/requests   # facts about each request
tapeapi reconcile --receipts ~/.tapeapi/receipts.jsonl --mandate mandate.json --token-decimals 18
tapeapi reconcile --receipts ~/.tapeapi/receipts.jsonl --policy my-limits.json
```

The options combine in one run. `--bill` is needed unless `--requests`, `--mandate` or `--policy` is given.
`--json` prints one object (`counts`, `items`, `checks`, `mandate`, `policy`, `notes`, `next`).

## Against a bill

The provider's bill or usage file (CSV with a header line, JSON, or JSON lines) is joined to the receipts row by row:
by an id column, else by time, model and tokens. Each receipt and each row ends up as a match, as missing on one side,
or as a mismatch (a field that differs from what the receipt claims), with both lines. Name the bill's columns with
`--map`:

```sh
tapeapi reconcile --receipts receipts.jsonl --bill bill.csv \
  --map id=request_id,model=model,prompt=input_tokens,completion=output_tokens,time=created_at,amount=cost \
  --amount-scale 1
```

`model`, `prompt` and `completion` are needed, and `id` or `time`. `amount` is compared only with `--amount-scale`
(how many bill units make one unit of the receipt's currency). `--preset new-api` names the fields of the JSON new-api's
`GET /api/log/self` returns; see [For AI API providers](ai-providers.md) for what that preset is and is not. There is
no preset for any other provider: name the columns. A time with no offset (`2026-10-22 10:00:00`) is read as UTC, in the
bill and in `--since` / `--until` alike.

## With new-api

If the provider runs [new-api](https://github.com/QuantumNous/new-api) (with or without the
[signing sidecar](../../examples/new-api-sidecar/README.md) in front of it), the usage log its API returns is a bill
`--preset new-api` reads as it is. Export it to a file with your own credential, then reconcile:

```sh
# your rows, with the dashboard's credential (the token the dashboard uses, or on recent versions a `nap_` access
# token with the usage:read scope); a relay key (sk-…) is refused on this route
curl -sS -H "Authorization: Bearer <your dashboard token>" "https://<provider>/api/log/self" -o newapi-log.json
# or, with the relay key only: the most recent rows of that key, the same fields
curl -sS -H "Authorization: Bearer sk-…" "https://<provider>/api/log/token" -o newapi-log.json
# quota_per_unit is in GET /api/status (data.quota_per_unit; new-api's default is 500000, a site may change it)
tapeapi reconcile --receipts receipts.jsonl --bill newapi-log.json --preset new-api --amount-scale 500000
```

`quota` is a raw integer; `--amount-scale <quota_per_unit>` turns the receipts' currency into it, and the default
tolerance is under one quota. The log is paged: narrow it with the date parameters the Logs page of that dashboard sends
(copy its request from your browser's developer tools; they differ between versions) so that the rows you want fit one
answer, or run `reconcile` once per saved page. `--since` and `--until` bound both files.

What this rests on, and does not: the field names (`upstream_request_id`, `model_name`, `prompt_tokens`,
`completion_tokens`, `quota`, `created_at` in `data.items`, or a bare `data` array) were read in new-api's source code
and are **not checked against a real instance**; whether `upstream_request_id` holds the answer id a receipt carries is
not known, and a row it does not join is joined by time, model and tokens within `--window` (default 120 s). **The
dashboard's CSV export ("Export" on the Logs page) is another file**: localized display headers, a formatted `Cost`
that is not a comparable amount, `request_id` rather than `upstream_request_id`, so the preset does not match it
(exit 2, the header shown); name its columns with `--map`, as for any other bill. The repository's fake new-api
(`examples/new-api-sidecar/fake-new-api.mjs`) serves this log shape, and `reconcile-new-api.test.mjs` runs the whole
path on 127.0.0.1 (the sidecar, `tapeapi-verify --log`, the export, `reconcile`: every row matched by id, a row without
the id, a differing row, a row missing on each side); it is a mock, and says nothing about what a real instance answers.

## Facts about each request

A receipt carries the hash of the exact request bytes (`requestSha256`), not the request. When you also have those
bytes, `--requests <dir>` joins them to the receipts: every file in the directory whose SHA-256 equals a receipt's
`requestSha256` gives that receipt its request facts (size in bytes, the model asked for, the output limit, and a
*request class*). File names do not matter, and a file that matches no receipt is only counted.

| Listed | From | What it shows | What it cannot show |
|---|---|---|---|
| `prompt-tokens-spread`, same model | requests in one class (same JSON apart from `model`, `stream`, `stream_options`, the output limits, `temperature`, `top_p`, `seed`, `user`, `metadata`) | one model's receipts claim different `prompt_tokens` for the same prompt (beyond `--tolerance-tokens`, default 0) | why: a prompt added upstream, a cache, a template change |
| `prompt-tokens-spread`, across models | the same class, several models | the counts side by side when they differ by more than `--prompt-spread` (default 16) | anything by itself: tokenizers and chat templates differ between models |
| `prompt-tokens-above-request-bytes` | the request's size | a receipt claims more input tokens than the request has bytes (a tokenizer seldom makes more than one token per byte of text; a chat template adds a few per message) | what the extra tokens were; an image or file given by URL is counted as many tokens for few bytes, so such a request is listed as a matter of course |
| `completion-above-request-limit` | the limit `ai.completionLimitOf` reads, the rule a billing layer sizes its hold with: the larger of `max_completion_tokens` and `max_tokens`, times `n` (Chat), `max_output_tokens` (Responses), `max_tokens` (Anthropic) | `completion_tokens` above the limit the request set, with `reasoning_tokens` next to it | whether the provider counts reasoning inside the limit; that is its documentation's to say |
| `model-names-vary` | the model the request asked for | the names the receipts carry for one requested model, split by stream and non-stream | which name, if any, is the model that ran |
| `model-name-differs-from-bill` | a joined bill row and the manifest snapshot | a receipt and its bill row name the model differently, and the snapshot makes the two names aliases (so the join counts them as one model) | the same |

**The request bytes must be the bytes that were sent.** `tapeapi-verify` salts every request by default (it appends
whitespace, so the hash cannot be guessed from a short prompt), and the bytes your client kept are then not the bytes
the receipt hashes: no file will match. They match when the bytes were saved after the salt, or when `tapeapi-verify`
ran with `--no-salt` (the hash of a short prompt can then be guessed by anyone you pass the receipt to). The `--log`
file itself never holds prompts.

`tapeapi-verify --save-requests <dir>` (experimental, 2.5; **off by default**) saves those bytes for you: every metered
request it sends, salt included, as one `<sha256>.request` file in `<dir>`, which you then give to `--requests <dir>`.

> **Privacy.** The saved files are your conversation in clear: prompts, attached files, tool output, whatever the
> client sent. Neither a receipt nor the `--log` file holds them. `tapeapi-verify` creates the directory with mode 700,
> refuses an existing one that group or others can open (exit 1), and writes each file with mode 600; a backup, a
> synced folder or a shared machine can still copy them. Turn it on only for the calls you mean to check, and delete the
> files when you are done. On Windows the modes are not applied.

Without request bytes, a bill can give the same facts with three optional `--map` keys: `request` (rows with the same
value are one request class), `request_bytes` and `max_tokens`; the bill's `model` column is then taken as the model
asked for. With neither, the receipts of a `--no-salt` log that repeat one `requestSha256` are one class (only
byte-identical requests do), and model names are grouped by the price-table entry of the manifest snapshot next to the
receipts.

Findings do not change the exit status unless you ask with `--fail-on` (below); `--json` carries `checks.counts` and,
under `checks.checked`, how many receipts had what each check needs.

## Against a mandate

If an agent spent on your behalf under a mandate (see [Container agents](container-agents.md)), `--mandate <file>`
sets what the receipts claim against it. The file is a mandate as JSON, bare or as `{ "mandate": { … } }`; its
signature is not read. For each scope item, the receipts whose container is the item's `provider` and whose signed
time is in `[notBefore, expires)` are summed in the item's currency and set against the cap:

- the cap is in base units of the item's token: give `--token-decimals <n>` to compare (without it, the spend is
  listed and not compared). The currency is `BEM` or `USDT` for those listed tokens, else `--mandate-currency <c>`;
- the result is `below-cap`, `near-cap` (from `--near`, default 0.8), `at-cap` or `above-cap`, with the share and the
  receipt lines;
- receipts of containers outside the scope, and receipts outside the period, are listed apart;
- a phase-0 mandate names no funds (every cap 0): the spend is listed, never compared.

This is visibility after the fact. Nothing was enforced when the calls were made, and a receipt's price is what its
signer claimed.

## Your own limits

`--policy <file>` reads limits you write for yourself. It is not a platform rule, and `reconcile` enforces nothing: it
lists the windows whose receipts claim more than it says. (The same file can also refuse calls before they are sent, in
your own process: see below.)

```json
{
  "tapeapiPolicy": 1,
  "note": "my own limits",
  "rules": [
    { "name": "one answer", "model": "*", "period": "call", "maxCompletionTokens": 4096 },
    { "name": "per day", "service": "0x…container…", "period": "day", "maxAmount": "2.5", "currency": "USD" },
    { "name": "this month", "period": "month", "maxCalls": 5000, "maxPromptTokens": 20000000 }
  ]
}
```

`service` is a container address or `"*"`, `model` a name as the receipts carry it or `"*"`, `period` one of `call`,
`day`, `month` (UTC) or `total`. Each rule sets at least one of `maxAmount` (a decimal string of at most 8 places,
with `currency`), `maxCalls`, `maxPromptTokens`, `maxCompletionTokens`. An unknown key is an error (exit 2), so a
misspelt limit does not pass silently.

### The same file before each call (client-side budget, experimental, 3.0)

`createVerifyingFetch({ policy })` reads the same policy value and refuses a call **before it is sent** when its worst
case would take a rule that covers it over its limit. A rule covers a call by service (the container) and model (the
requested name, its price-table entry's id or an alias, or `"*"`).

```js
import { readFileSync, appendFileSync, chmodSync } from 'node:fs'
import { ai } from '@tapeapi/sdk'

const policy = JSON.parse(readFileSync('my-limits.json', 'utf8'))
const fetch = ai.createVerifyingFetch({ api, service, policy,
  budgetStore: ai.budgetFileStore('spend.jsonl', { readFileSync, appendFileSync, chmodSync }) })
```

- **The worst case** of a call is `ai.maxAmountOf` per currency of the model's entry, with the request's size in bytes
  as the prompt bound and its declared output limit (`ai.completionLimitOf`) as the completion bound. Against it: what
  the verified receipts in the rule's window already claim, plus the worst case of every call written down as sent
  that has no verified receipt (an upstream failure, a receipt that did not verify, a crash in between).
- **Refusals**, whatever `strict` says: `BUDGET_EXCEEDED` with `data: { reason: 'budget-cap', rule, period, window,
  limit, currency, cap, spent, worstCase }`. A covering rule that cannot be bounded fails closed with
  `INVALID_ARGUMENT` and `data.reason`: `budget-no-limit` (the request sets no `max_tokens` /
  `max_completion_tokens` / `max_output_tokens`), `budget-no-price` (no price-table entry for the model),
  `budget-no-currency` (no price in the rule's currency), `budget-unreadable-request` (the body is not a JSON object),
  `budget-store-unwritable` (nothing could be written down, so nothing is sent).
- **The store** (`budgetFileStore`) is one append-only JSON-lines file, mode 600: the verified receipt envelopes,
  which `tapeapi receipts` and `tapeapi reconcile --receipts` read as they are, one `{"tapeapiSent": 1, …}` line
  per call, written before it leaves, and a `{"tapeapiReleased": 1, …}` line when a call ends in a definite failure
  that claims nothing (an HTTP 4xx or 5xx with no receipt), which drops its worst case (the receipt readers skip both
  kinds). A timeout, a broken connection or a receipt that does not verify is not definite: the call keeps counting. A restart reads the file again, so the count
  survives it. Without `budgetStore` the store is memory: a restart forgets.

**What it is not.** It is a convenience in your own process, not an enforcement anyone else can rely on: you can turn
it off, edit the file, or put two budgets on one file (two processes, or two `policy` fetches in one process: each
reads the other's new lines before every call, under a lock file `<store>.lock` when `budgetFileStore` is given
`writeFileSync` and `unlinkSync` (`tapeapi-verify --budget-store` does), so they decide one after the other; share one
`ai.createBudget()` with `budget:` in one process), and a service
is not bound by it. It bounds the prices the receipts **claim**, not what anyone pays. The worst case is only as good
as its counts: a hidden system prompt, images, tool definitions, a model that ignores `max_tokens` or an answer priced
on another reported model can make a receipt claim more than the worst case; the next call then sees it and is
refused. Only calls to an endpoint of the manifest are counted (strict, the default, refuses the others anyway).

The local proxy takes the same file: `tapeapi-verify <service> --policy my-limits.json --budget-store spend.jsonl`. A
refused call gets HTTP 400 (code `budget_exceeded`, or `budget_no_limit`, ... when it cannot be bounded) with
`x-should-retry: false`, as the proxy's other refusals before forwarding, and is not forwarded.

## A spend statement (experimental, 3.0)

`tapeapi receipts statement` sums what the receipts claim per service, model and UTC day for a period, with your
policy's caps and a mandate's caps alongside:

```sh
tapeapi receipts statement --receipts spend.jsonl --from 2026-10-01 --to 2026-11-01 --policy my-limits.json \
  --mandate mandate.json --token-decimals 18 [--json] [--lang en|zh]
```

It counts as `reconcile` counts (one receipt once, the same `--since` / `--until`, which `--from` / `--to` are), so on
the same files its totals are reconcile's: the mandate's `spent` and each policy window's sum. Calls a budget wrote down
as sent with no verified receipt are listed beside the totals at their worst case, not in them.

**Nothing signs it.** It is your own summary of the receipts on your machine; whoever you show it to has your word for
the sums. Each receipt in it was signed by its service and proves only what that service claimed. It is not the agent
kit's `spendStatement` / `spendEvidence` (phase 1), which state an escrow channel's `claimedOf` inside a signed deliver
result: those need an escrow, this reads receipts only.

## For operators: give your users rows they can reconcile

If you run a service and keep your own ledger, export it with columns that `--map` can name; the names of
`tapeapi receipts export` are a good fit:

| `--map` key | Column to export | Note |
|---|---|---|
| `id` | the answer's id, as the receipt carries it | joins a row to its receipt exactly |
| `time` | when the call was made (unix seconds or ISO 8601) | the join without an id |
| `model` | the model the user asked for | the name the request carried |
| `prompt`, `completion` | the tokens you billed | all input and all output tokens, as in the receipt |
| `amount` | what you charged, in one currency | with `--amount-scale` |
| `request`, `request_bytes`, `max_tokens` | optional | lets your users run the request checks without keeping request bytes |

The user then runs, for example,
`tapeapi reconcile --receipts receipts.jsonl --bill ledger.csv --map id=id,model=model,prompt=prompt_tokens,completion=completion_tokens,time=ts,amount=amount --amount-scale 1`.
Your signed receipts themselves, one JSON envelope per line, are read by `--receipts` as they are. No per-provider
preset is planned: the column names are yours to choose and the user's to name.

## Exit status

`0` every receipt and every bill row match (without `--bill`: the report was made); `1` something is missing or
differs; `2` a usage mistake (a column named that the bill does not have, a mandate or policy file that cannot be read
or is not valid); `3` nothing to compare. Findings, mandate and policy facts do not change it, unless you ask:

`--fail-on <kinds>` (experimental, 2.5) names, comma-separated, `findings` (any finding), `mandate-above-cap` (a scope
item above its cap) and `policy` (a window over one of your rules). When the exit status would otherwise be `0` and a
named kind is listed, it is `4`; `1`, `2` and `3` stay as they are. `--json` then carries
`failOn: { kinds, counts, listed }`, and the text output ends with one line of the counts. A kind that could never be
listed is a usage mistake (`2`): `policy` without `--policy`, `mandate-above-cap` without `--mandate` and
`--token-decimals` (without the decimals no cap is compared). It is for a script or a CI step that should stop on such
a fact; exit `4` still says "listed", not "wrong".

```sh
tapeapi reconcile --receipts receipts.jsonl --requests requests/ --policy my-limits.json --fail-on findings,policy
```
