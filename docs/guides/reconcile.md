# Reconcile your receipts (experimental)

You bought AI calls through a service that signs a usage receipt for every answer, and `tapeapi-verify --log` kept
those receipts on your machine. This guide sets them against what else you have: the provider's bill, the requests you
sent, a mandate you signed for an agent, and your own spending limits. Everything here is `tapeapi reconcile`,
experimental and outside the 2.x compatibility promise: it may change or go away in any 2.x release.

**What it does, and what it never does.** It reads local files only: no network, no key, nothing uploaded, no
telemetry. It lists facts, each with the receipt line it comes from (and the bill line or request file it uses). It
decides nothing: a difference is a question to put to the provider, with the lines to point at. **A receipt proves
only what its signer said**: who signed which request and response bytes, and what usage and price were claimed. It
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
no preset for any other provider: name the columns.

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

`--policy <file>` reads limits you write for yourself. It is not a platform rule and was not enforced when the calls
were made; `reconcile` lists the windows whose receipts claim more than it says.

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
