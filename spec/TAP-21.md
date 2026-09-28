| TAP | 21 |
|---|---|
| Title | TapeAPI: Signed Response Envelope |
| Author | Bruce (@BruceLanLan) |
| Status | Draft |
| Implementation | Live (2026-09-27): every answer of `api.tapeapi.fun` (`11.1013.tape`) and `relay.tapeapi.fun` (`12.1013.tape`), errors included, is a v2 envelope signed by `server/src/`; the SDK verifies it. No third-party audit. |
| Type | Standards |
| Created | 2026-09-20 |
| Requires | TAP-20 |
| License | CC0-1.0 |

# TAP-21: TapeAPI: Signed Response Envelope

> English is authoritative. 中文译文见下半部分，章节编号一一对应。

> **Placeholder number.** TAP-21 is a placeholder number proposed in [TapeKit issue #8](https://github.com/TapeOutProtocol/TapeKit/issues/8). TapeKit has no numbered-proposal process yet (changes to TapeOut itself follow TapeKit `SPEC.md` §15), so the maintainers may assign another number or move this document to another process; see [TAP-1](TAP-1.md).

RFC 2119 keywords apply.

## 1. Abstract

Defines the HTTP request and response format for a TapeAPI live endpoint and the signature a provider attaches to every response so that a client can attribute the result to the service container resolved under TAP-20. It also defines AI usage receipts (§3.5): the same signature over the exact bytes of an AI API request and answer and the usage and price the service claims for it.

## 2. Motivation

TLS authenticates a host, not a service identity. Without a signature bound to the container, a client cannot prove where a result came from, cannot dispute it, and cannot cache it safely. The envelope makes every response a self-contained, verifiable statement by the manifest `signer`.

## 3. Specification

### 3.1 Request

`POST {live}/{method}` where `{live}` is an entry of `manifest.endpoints.live` and `{method}` is a `methods[].name`. Body is JSON, `Content-Type: application/json`:

```json
{ "id": "<client uuid>", "method": "circuitHolder", "params": { }, "voucher": { } }
```

- `id`: string of 1–128 UTF-16 code units (JavaScript `String.length`), chosen by the client, unique per client. REQUIRED.
- `method`: OPTIONAL, since the path segment already names the method and is what the digest covers. When present it MUST equal the path segment, and a provider MUST refuse a mismatch with `BAD_REQUEST` rather than prefer either value. The path segment MUST match `^[A-Za-z_][A-Za-z0-9_]{0,63}$`.
- `params`: OPTIONAL, default `{}`; when present it MUST be a JSON object. A missing `params` is treated as `{}` for the digest in §3.3.
- `voucher`: TAP-22 voucher object. REQUIRED when `priceBEM != "0"`; otherwise ignored.
- Request bodies MUST be parsed with a JSON parser that rejects the keys `__proto__`, `constructor` and `prototype` at any depth (a `400` `BAD_REQUEST`); the same rule applies to the canonical form in §3.3.

### 3.2 Response

Success:

```json
{ "id": "...", "ok": true, "result": { }, "container": "0x..", "ts": 1758300000, "block": 62000000, "sig": "0x..." }
```

Error:

```json
{ "id": "...", "ok": false, "error": { "code": "PAYMENT_REQUIRED", "message": "...", "data": { } }, "container": "0x..", "ts": 1758300000, "sig": "0x..." }
```

- `id` MUST echo the request `id`. A request the provider could not parse (malformed JSON, not an object, over its body limit, missing or invalid `id`) has no `id` or `params` it can trust: it is refused with a `BAD_REQUEST` (HTTP 400, or 413 for size) signed over `id` `""` and `params` `{}`, and a request whose `params` have no canonical form is refused signed over its own `id` and `params` `{}` (§3.3). An invalid `id` is anything other than a string of 1–128 UTF-16 code units (§3.1), an over-long one included; the `params` sent beside it are not used for the binding either. Every other answer to a request, including an `INTERNAL` for a failure inside the provider, is signed over that request's own `id` and `params`. A client that receives a `BAD_REQUEST` which verifies under either binding MUST report its own request as malformed (`BAD_REQUEST`), not `BAD_SIGNATURE`.
- `ok` MUST be a JSON boolean and is covered by the signature (§3.3).
- `container` MUST equal the service container. Clients MUST reject a response whose `container` differs from the resolved container, and MUST compute the digest with the container they resolved, not with the value in the envelope.
- `ts`: provider Unix time in seconds. Clients MUST reject `|now − ts| > maxSkew`; `maxSkew` defaults to 300 s and MAY be configured.
- `block`: OPTIONAL, the chain height the provider used, informative and unsigned.
- `error.code` MUST be one of `PAYMENT_REQUIRED`, `BAD_VOUCHER`, `METHOD_NOT_FOUND`, `BAD_REQUEST`, `INTERNAL`, `TOOLS_CHANGED` (an MCP-bound service whose upstream tools no longer match its `toolsSha256`, TAP-20 §3.8). Codes are only added, never removed or renamed. Clients MUST treat unknown codes as errors.
- `error.data`: OPTIONAL JSON object, covered by the signature. A `BAD_VOUCHER` caused by a stale `cumulative` MUST carry `data.lastCumulative` (decimal string): the highest cumulative the provider has accepted for this consumer, including calls still in flight: `max(stored, in-flight, claimedOf)`. Whenever that figure exceeds `onChainClaimed`, `data.voucher` MUST be the consumer's own voucher for exactly that figure, so the client can verify it; a client MUST NOT adopt an unproven figure above `onChainClaimed`. A client MAY adopt `max(local, lastCumulative)` and retry once.
- `INTERNAL` messages MUST NOT reveal upstream details (RPC URLs, keys, internal hostnames); the provider logs the detail and returns a generic message. The single exception: an `INTERNAL` MAY carry `error.data.revert`, the `0x`-hex revert bytes of a call the provider made (chain state anyone can reproduce, covered by the signature), with `message` `"execution reverted"`. Nothing else may be attached to an `INTERNAL`.
- A signed envelope MAY be carried with HTTP status `200`, or with the status matching its error code (`402` for `PAYMENT_REQUIRED` and `BAD_VOUCHER`, `404` for `METHOD_NOT_FOUND`, `400`/`413` for malformed requests, `500` for `INTERNAL`, `409` for `TOOLS_CHANGED`). Clients MUST parse the body as an envelope whenever it is valid JSON with a `sig` field, regardless of status, and MUST verify the signature before trusting it. Only such a body is an envelope: JSON without `sig` (a proxy or CDN error page, an unsigned route error) or a body that is not JSON is a transport failure (`PROVIDER_UNAVAILABLE`), never `BAD_SIGNATURE`.
- Providers SHOULD respond within 30 s and MUST cap the response body at 1 MiB, measured in bytes of the UTF-8 encoded body. A provider whose result would exceed the cap answers a signed `INTERNAL` and MUST NOT bill for it; likewise for a handler that exceeds the provider's time bound.

### 3.3 Digest and Signature (v2)

```
digest = keccak256(
    "TAPI-1/resp/v2"                                     // 14 ASCII bytes, no length prefix
  ‖ container                                            // 20 bytes: the resolved service container
  ‖ keccak256(utf8(id))                                  // 32 bytes
  ‖ keccak256(utf8(canonicalJSON({ method, params })))   // 32 bytes: the request being answered
  ‖ uint8(ok ? 1 : 0)                                    // 1 byte
  ‖ keccak256(utf8(canonicalJSON(body)))                 // 32 bytes; body = result if ok else error
  ‖ uint64BE(ts)                                         // 8 bytes
)
sig = secp256k1 EIP-191 personal_sign over the 32-byte digest, i.e.
      ecrecover(keccak256("\x19Ethereum Signed Message:\n32" ‖ digest), sig) MUST == manifest.signer
```

- `{ method, params }` is an object with exactly those two keys; `method` is the request method name and `params` the request `params` object (`{}` when absent). Clients MUST compute this hash from the request **they sent**, never from values echoed by the provider.
- `ok` is the envelope's boolean. Because it is covered, a signed error cannot be presented as a result or vice versa.
- `sig` is 65 bytes `r ‖ s ‖ v`, `v ∈ {27, 28}`, and MUST be low-`s` (`s ≤ n/2`). Verifiers MUST reject high-`s` signatures and `v` values outside `{27, 28}` (after normalising `0/1` to `27/28`), exactly as the on-chain `ECDSA.recover` used by TAP-22 does.
- `block` is not covered by the signature.

**canonicalJSON** is JSON Canonicalization Scheme (JCS, RFC 8785) with five TAPI restrictions. The JCS part: object keys sorted recursively by UTF-16 code unit order, no whitespace, numbers serialised by the ECMAScript `Number::toString` shortest round-trip form, strings escaped as in `JSON.stringify`.

The restrictions exist because a value with two defensible canonical forms is a value two verifiers can disagree about, and a disagreement between verifiers is a signature bypass:

1. **No duplicate keys.** RFC 8785 §3 forbids them; a parser that keeps the last silently changes the meaning of the bytes it was handed. Signers MUST refuse and verifiers MUST reject any JSON text in which one object repeats a key, rather than choosing a survivor.
2. **No `NaN`, `Infinity` or `-0`.** `-0` serialises as `0`, so the two are indistinguishable afterwards.
3. **No integer outside ±(2^53 − 1).** Such a value has already lost precision by the time it is an IEEE-754 double, so signer and verifier can differ on a number neither mistyped. Carry it as a string, as TAP-20 already does for amounts and token ids (RFC 7493 §2.2).
4. **No `__proto__`, `constructor` or `prototype`** as an own key anywhere in the tree, and no value whose canonical form depends on a host-language hook such as JavaScript's `toJSON()`: no other language reproduces it.
5. **No lone (unpaired) UTF-16 surrogates** in any string or key. Such a string is not well-formed Unicode (RFC 7493 §2.1) and has no single UTF-8 encoding. Signers MUST refuse and verifiers MUST reject it, as for the restrictions above.

A provider that receives a request whose `params` has no canonical form under these rules refuses it with `BAD_REQUEST`, signed over the request hash of `{ method, params: {} }`.

Clients MUST recompute the canonical form from the parsed `result`/`error` object rather than hashing the raw bytes, and MUST cap the response body they parse at 1 MiB.

### 3.4 Client-side Codes

Clients MUST expose, in addition to the provider codes: `RPC_DISAGREE`, `BAD_SIGNATURE`, `MANIFEST_INVALID`, `DELEGATION_INVALID`, `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `PRICE_CHANGED` (a price rose above what the caller accepted, TAP-20 §3.6), `QUORUM_FAILED` (generic multi-provider disagreement, or too few verifiable answers) and `ATTEST_DISAGREE` (TAP-23 §3.4). The reference SDK additionally uses these informative client codes, which implementations MAY extend: `NOT_FOUND` (no service or file at the target, TAP-20 §3.6), `RPC_UNAVAILABLE` (too few nodes answered; distinct from `RPC_DISAGREE`), `RPC_ERROR` (every answering node returned the same JSON-RPC error), `CANON_INVALID`, `ABI_INVALID`, `BAD_KEY`, `CHANNEL_INVALID` (TAP-26), `GROUP_INVALID` and `GROUP_EQUIVOCATION` (TAP-27), `TAPESEND_INVALID` (TAP-10 payloads), `COMPARE_PATH_INVALID`, `RECEIPT_INVALID` (an AI usage receipt that is missing or fails a check of §3.5), and `BUDGET_EXCEEDED` and `USER_DECLINED` (the WebMCP adapter's spending budget and user confirmation). A provider's own route errors (`NOT_FOUND` for an unknown path, `METHOD_NOT_ALLOWED`) are unsigned and are transport failures to the client. So is the reference provider's unsigned HTTP 503 `DELEGATION_INVALID`, sent while its own delegation has lapsed or before it has one; being unsigned it is only a hint, and the reference SDK reports it as `DELEGATION_INVALID` only when its own copy of the manifest shows the delegation expired, and as `PROVIDER_UNAVAILABLE` otherwise. These are client-side codes: none of them is ever a valid `error.code` in a signed envelope (`RATE_LIMITED` travels only in the unsigned 429 body described below). `BAD_SIGNATURE` covers every envelope-binding failure (signature, `id`, `container`, request hash, `ok`, `ts` window). On `BAD_SIGNATURE` the client MUST re-read the manifest per TAP-20 §3.6 from step 2 before retrying. If the re-read manifest names exactly the key that signed the envelope, the client MAY accept that same envelope, once it verifies in full against the re-read manifest, rather than sending the request again, so that a result the provider already billed is not paid twice. Re-reads triggered by signature failures SHOULD be rate limited per service. A response that cannot be parsed as an envelope (malformed JSON, no `sig`, forbidden keys, over 1 MiB) is `PROVIDER_UNAVAILABLE`.

**Rate limiting.** A provider MAY refuse a request before doing any work. Such a refusal MUST use HTTP 429 with a `Retry-After` header and a body of `{ ok: false, error: { code: "RATE_LIMITED", data: { retryAfterS } } }`, and it MUST NOT be signed: it asserts nothing about any result, and signing refusals would make a flood cost the provider a signature each. Clients MUST treat HTTP 429 as `RATE_LIMITED` and MUST NOT attempt envelope verification on it. Budgets are per provider process and are not shared between instances; a service behind several hosts enforces a budget per host. A provider that keeps a per-consumer budget for paid calls MUST key it on the consumer the voucher signature proves (TAP-22 §3.2), never on the `consumer` field as sent: an unverified field lets anyone exhaust a victim's budget by writing the victim's address into vouchers that do not verify. Unverified traffic, including a free method called with a voucher attached, belongs to the caller's free budget. When a provider sits behind a proxy, the caller identity used for rate limiting MUST come from the host (e.g. the edge's connecting IP) or from the **last** hop of a configured forwarding header, never from a value the client can supply, such as the first `X-Forwarded-For` entry.

Clients that meter payments (TAP-22) MUST NOT advance their local cumulative until a verified envelope has been received; a transport failure releases the reservation, and the next voucher is corrected through `error.data.lastCumulative` if the provider had in fact consumed it.

### 3.5 AI Usage Receipts

A service whose manifest carries an `ai` field (TAP-20 §3.9) answers AI API requests in the API's own format, not in the envelope of §3.1–§3.2. Its answers pass through a **signing sidecar**: a proxy in front of the upstream API, part of the provider's service and operated by the provider, which passes requests and answers through unchanged except as this section says, and signs a **usage receipt** for every request listed in the format table of TAP-20 §3.9. Other requests pass through without one.

**Envelope.** A receipt is an envelope signed exactly as in §3.3, by the manifest's `signer`, with `ok` = `true` and `body` = `result`:

```json
{ "id": "chatcmpl-v1", "ok": true, "container": "0x…", "ts": 1790000000,
  "method": "openai_chat", "params": { "path": "/v1/chat/completions", "requestSha256": "<64 hex>" },
  "result": { "model": "gpt-x",
              "usage": { "prompt_tokens": 1200, "completion_tokens": 300, "total_tokens": 1500, "cache_read_tokens": 1000, "reasoning_tokens": 100 },
              "responseSha256": "<64 hex>", "stream": false, "complete": true, "status": 200,
              "prices": [ { "currency": "USDT", "amount": "0.00357500" }, { "currency": "BEM", "amount": "0.03375000" } ],
              "modelMatchedBy": "response" },
  "sig": "0x…" }
```

It differs from a §3.2 envelope in three ways. `method` and `params` travel in the envelope, because the client never sent them; the request hash of the digest is over `{ method, params }` as they appear there, and the client checks them against its own request (below). `id` names the answer, not a client request, so the rule of §3.2 that `id` echoes the request does not apply. And `ok` is always `true`: a receipt states what the upstream answered, a failed answer included (`status`), and is never an error of the sidecar. There is no `block`.

- `method`: the receipt method of the format: `openai_chat`, `openai_responses`, `anthropic_messages` or `openai_embeddings`.
- `id`: the answer's own id (table below) when it is a string of 1 to 128 characters in U+0021–U+007E; otherwise an id the sidecar generates, which SHOULD NOT be guessable (the reference: `tapeapi-` and 24 random lowercase hex digits).
- `params.path`: the path of the request from the service root (TAP-20 §3.9), without the query, e.g. `/v1/chat/completions`.
- `params.requestSha256`: SHA-256, as 64 lowercase hex digits, of the request body bytes exactly as the client sent them (with any content coding the client itself applied).

| `result` member | Type | Meaning |
|---|---|---|
| `model` | string or null | The model the upstream reported; the requested model when `modelMatchedBy` is `"request"`; `null` when there is neither. |
| `usage` | object or null | The usage object of TAP-20 §3.9; `null` when the answer reported none that holds, and always when `status` is outside 2xx. |
| `responseSha256` | string | The response hash (below), 64 lowercase hex digits. |
| `stream` | boolean | Whether the answer is an event stream: the format streams, the upstream's `Content-Type` contains `text/event-stream` (ASCII case-insensitive), and the status is one that carries a body (not 101, 204, 205 or 304). An `openai-embeddings` answer is never a stream. |
| `complete` | boolean | `true` for a 2xx whole answer that its format does not mark unfinished, and for a 2xx stream that reached its format's final success event (table below); `false` otherwise. An incomplete answer is still priced from the usage it reported. |
| `status` | integer | The upstream's HTTP status. |
| `prices` | array or null | `[ { currency, amount } ]`, one per price entry of the matched model, in the table's order, each amount computed by TAP-20 §3.9; `null` when no entry matched or `usage` is `null`. |
| `modelMatchedBy` | string | `"response"` or `"request"` (TAP-20 §3.9); present exactly when a price entry matched `model`, even when `prices` is `null`. |
| `unpriced` | string[] | The names in `usage.other`; present only when `prices` is not `null` and `usage.other` exists. |
| `usageInjected` | `true` | Present only when the sidecar changed the upstream request to obtain the usage (below). |

The first seven members are always present. `modelMatchedBy`, `unpriced` and `usageInjected` MUST be left out when they do not apply, never set to `null`, `false` or an empty list.

**Formats.** A sidecar MUST read the answer's id, model, usage and completion as this table says (all names are members of the API's JSON; "stream" means the events' data):

| Format | Answer id and model | Usage (TAP-20 §3.9 member ← API member) | `complete` |
|---|---|---|---|
| `openai-chat` | `id`, `model`; stream: the first `id` and the last `model` of the chunks | `prompt_tokens`, `completion_tokens`, `total_tokens` ← the same; `cache_read_tokens` ← `prompt_tokens_details.cached_tokens`, else `prompt_cache_hit_tokens`; `reasoning_tokens` ← `completion_tokens_details.reasoning_tokens`; stream: the last chunk with a `usage` object | whole: 2xx; stream: some chunk has a choice with a non-null `finish_reason`, and no chunk has a non-null `error` |
| `openai-responses` | `id`, `model`; stream: those of the `response` object the events carry (the first id, the last model) | `prompt_tokens` ← `input_tokens`; `completion_tokens` ← `output_tokens`; `total_tokens` ← the same; `cache_read_tokens` ← `input_tokens_details.cached_tokens`; `reasoning_tokens` ← `output_tokens_details.reasoning_tokens`; stream: the last `response.usage` | whole: `status` is `"completed"` or absent; stream: a `response.completed` event and no `response.failed`, `response.incomplete` or `error` event (an event's type is its data's `type`, else its event name) |
| `anthropic-messages` | `id`, `model`; stream: those of `message_start.message` | `prompt_tokens` ← `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`; `completion_tokens` ← `output_tokens`; `total_tokens` ← their sum; `cache_read_tokens` ← `cache_read_input_tokens`; `cache_write_tokens` ← `cache_creation_input_tokens`; `cache_write_1h_tokens` ← `cache_creation.ephemeral_1h_input_tokens`; `other.web_search_requests` ← `server_tool_use.web_search_requests`; stream: `message_start.message.usage`, each member then replaced by the latest non-null value in a `message_delta` | whole: the body's `type` is not `"error"`; stream: a `message_stop` event and no `error` event |
| `openai-embeddings` | `id` (usually absent), `model` | `prompt_tokens`, `total_tokens` ← the same; `completion_tokens` 0 | 2xx |

| Format | Sentinel (left out of the hash) | Final event, by its first line |
|---|---|---|
| `openai-chat` | `[DONE]` | `data: [DONE]` |
| `openai-responses` | `[DONE]` (optional) | `event: response.completed`, `event: response.incomplete`, `event: response.failed` |
| `anthropic-messages` | none | `event: message_stop` |

A first line matches with or without the space after the colon.

**Response hash.** `responseSha256` is SHA-256, as 64 lowercase hex digits, of:

- a whole answer (`stream` false): the response body bytes exactly as the client receives them, after any HTTP content coding has been removed;
- a stream (`stream` true): the event data the client receives, found by parsing the bytes as server-sent events under these rules (WHATWG HTML §9.2), which verifiers and sidecars MUST apply exactly:
  1. Lines end at CRLF, LF or CR. One U+FEFF at the very start of the stream is skipped.
  2. A line that starts with `:` is a comment and is ignored; the receipt comment below is one.
  3. A line `field: value` splits at its first `:`, and one U+0020 directly after that colon is dropped. A line without a colon is a field of that name with an empty value.
  4. The values of all `data` fields of one event are joined with `"\n"` (U+000A).
  5. An event is dispatched only at a blank line, and only if it had at least one `data` field. An event not ended by a blank line when the stream ends is discarded.

  Take each dispatched event's data, in order, as UTF-8 bytes; leave out every event whose data is exactly the format's sentinel; hash the concatenation of each remaining data followed by one `"\n"` byte. Event names, `id` and `retry` fields and comments are not hashed. The final event is hashed like any other, although the receipt comment precedes it on the wire.

**Usage injection.** An OpenAI Chat stream reports usage only when the request sets `stream_options.include_usage` to `true`. When a streamed `openai-chat` request does not, the sidecar MAY send the upstream a copy of the request body with that member set. It then MUST remove from the client's copy every data event the change caused (an event whose data is a JSON object with a `usage` object and an empty `choices` array), MUST take the usage from it, and MUST set `usageInjected`. `requestSha256` stays the hash of the bytes the client sent, and the response hash covers what the client received, which is exactly what it asked for. A sidecar MUST NOT change the request body it sends upstream in any other way.

**Delivery.**

- A whole answer carries the receipt in the response header `x-tapeapi-receipt`: the base64url (RFC 4648 §5, without padding) of the envelope's JSON text. The sidecar MUST drop any `x-tapeapi-receipt` header of the upstream, and SHOULD list the header in `Access-Control-Expose-Headers` so that browsers can read it.
- A stream carries it as one SSE comment block, `: tapeapi-receipt <base64url>` followed by a blank line, placed immediately before the format's final event: the sidecar holds the final event back until it is complete, adds it to the hash, signs, sends the comment block and then the event. Since clients ignore comments, what they parse is unchanged, and a client that stops reading at the final event already has the receipt. Custom event types MUST NOT be used for the receipt (the OpenAI SDKs hand unknown events to the application).
- A stream without a final event (or with one the sidecar could not hold back; the reference holds at most 4 MiB, and cannot recognise the final event of a Responses stream sent without `event:` lines) carries the line `: tapeapi-receipt <base64url>` and a line end at its end, preceded by a line end when the stream stopped in the middle of a line, and followed by no blank line, so that an unfinished event stays unfinished. A final event that began but never ended has the comment block placed before it.
- A stream that passed through several sidecars carries several receipt comments; the outermost sidecar's is the last. A client checks the last one first.
- **Retrieval.** The manifest of such a service MUST list the free method `receipt` (`priceBEM` `"0"`, `params: { id: "string" }`), which answers, as its §3.2 `result`, the stored receipt envelope with that `id`; when two answers share an id, the later one's; an id with no stored receipt is answered with a signed `BAD_REQUEST`, since §3.2 has no provider code for "not found". The method MAY also take a second, optional parameter `requestSha256` (64 lowercase hex digits, a receipt's `params.requestSha256`); the manifest entry stays as above. When it is given, only a receipt whose `id` and `params.requestSha256` both equal the parameters is answered, so answers that share an id are told apart, and a sidecar that accepts it therefore keeps receipts per (`id`, `requestSha256`) rather than per `id`. A provider whose upstream's ids can be guessed MAY refuse a lookup that does not name `requestSha256`, with a signed `BAD_REQUEST`. A provider SHOULD keep every receipt retrievable for at least one hour after the answer. The copy delivered with the answer is the primary one; the reference keeps receipts for one hour (configurable), at most 50 000, in the memory of the process that signed them, per (`id`, `requestSha256`), and gives the `receipt` method a budget of its own (10 lookups per client IP per minute, refused with the unsigned 429 of §3.4).

**Sidecar errors.** A failure of the sidecar itself (its rate limit, a request over its size limit, an upstream that cannot be reached or does not answer in time, an upstream redirect, which is never followed) is answered in the OpenAI error shape (`{ "error": { "message", "type", "param", "code" } }`) with no receipt and no signature: there is no upstream answer to bind. A client cannot tell such an answer from one whose receipt was stripped, and MUST NOT treat it as a verified answer. The sidecar MAY mark such an answer with the header `x-tapeapi-sidecar-error: 1`; the mark is informative, since anyone on the path can set or strip it, and a client reports it as `PROVIDER_UNAVAILABLE` (`RATE_LIMITED` for HTTP 429), never as verified.

**Client checks.** A client that relies on a receipt MUST check:

1. **Shape**: the envelope and `result` are as above: 64-hex hashes, `usage` members in the order of TAP-20 §3.9, amounts with exactly 8 decimals, unique currencies, and `usage` and `prices` `null` when `status` is outside 2xx.
2. **Signature**: the §3.3 digest over the receipt's `container`, `id`, `{ method, params }`, `ok` and `result` recovers to the `signer` of a manifest resolved and verified under TAP-20 §3.6, and `container` is the resolved container. A receipt signed by another key triggers the re-read of §3.4 before it is refused (the service may have rotated its key).
3. **Method and path**: `method` is the receipt method of a known format that serves `params.path`, and `params.path`, `status` and `stream` are those of the request it sent and the answer it received.
4. **Bytes**, when it holds them: `requestSha256` is the hash of the body it sent; `responseSha256` is the hash of what it received, by the rule above; `complete` is what its own reading of the answer gives; and when the answer carries an id the sidecar would use (1 to 128 characters in U+0021–U+007E), `id` equals it. It SHOULD also compare `model` and `usage` with the answer's own (by the format table; the usage cannot be compared when `usageInjected` is set). A check it could not make MUST be reported as not made, never as passed.
5. **Amounts**: recomputed from the manifest's `ai` field by TAP-20 §3.9, for the receipt's `model`, `usage` and format: `modelMatchedBy` is present exactly when an entry matches, `prices` equals the recomputed list (currencies, order and amounts) or is `null` when the recomputation gives none, and `unpriced` equals the names in `usage.other`. When `modelMatchedBy` is `"request"` and it holds the request, `model` is the request model.
6. **Freshness**: a client checking a receipt as the answer arrives applies the `ts` window of §3.2. A receipt checked later (retrieved by id, or audited) cannot be, and its check says so.

A client whose check fails MUST NOT present the receipt as verified, and SHOULD report the failure to its caller rather than drop it (the reference raises `RECEIPT_INVALID`, for a stream when the stream ends).

## 4. Rationale

- A fixed ASCII prefix domain-separates the digest from EIP-712 and from TapeSend payloads.
- Hashing `id`, the request and the body separately keeps the digest fixed-size and lets a verifier check the binding without re-serialising the whole envelope.
- Covering `{method, params}` and `ok` (v2) makes an envelope a statement "this is the answer to that question" rather than "this is some payload I signed": a MITM on a proxy or CDN cannot relabel a signed error as a success, and a TAP-25 dispute can prove which question was answered.
- EIP-191 over a 32-byte digest is supported by every wallet and HSM; EIP-712 typed data was rejected because `result` has no fixed type.
- Errors are signed so that a provider cannot deny having refused a paid request.

## 5. Backwards Compatibility

Adds nothing to `SPEC.md`; no change to name grammar or §15.1 invariants. v2 replaces v1 (`TAPI-1/resp/v1`, which covered neither the request nor `ok`); a v2 client MUST reject v1 envelopes, which simply fail signature verification. The version in the prefix allows a future envelope version without ambiguity.

## 6. Test Vectors

| Item | Value |
|---|---|
| `keccak256("TAPI-1/resp/v2")` (informative, prefix is used raw) | `0xbd61d43697493b5514339aa5ca816a32e8911486b4b1e5395614878bd164011d` |
| `keccak256("TAPI-1/resp/v1")` (superseded) | `0x9949be85c994f5fc85a89cbc352135b57020456364cd860d35deeb305aefb5c9` |
| Full envelope digest + signature (EIP-191 over the digest, §3.3) | `spec/vectors/tap-21-envelope.json`, checked independently by `spec/vectors/verify.py`, digest and recovered signer |
| AI usage receipts (§3.5): seven cases (Chat whole and streamed with usage injection, Responses stream with a model alias, Anthropic stream with thinking and both cache kinds, embeddings priced by the requested model, an Anthropic stream ending in an error, an HTTP 429), each with the request bytes, the upstream answer, the bytes the client receives, the manifest `ai` field, a published test signer key and the expected hashes, result, envelope and header or comment value | `sdk/test/fixtures/ai-receipt-vectors.json`, regenerated by the reference sidecar and checked by `sdk/test/ai-receipt-vectors.test.mjs`, which recomputes every stream hash with an independent whole-text SSE parser, and checked independently by `spec/vectors/verify.py` (request and stream hashes, amounts, envelope digest and signer) |

## 7. Reference Implementation

`sdk/src/canon.js` (canonical JSON), `sdk/src/sig.js` (digest and recovery), `server/src/index.js` (signing). Live: `https://api.tapeapi.fun` (source `examples/public-api/`) and `https://relay.tapeapi.fun` (source `examples/cloudflare-worker/relay-worker.js`) sign every answer with this envelope.

AI usage receipts (§3.5): `sdk/src/ai.js` (the stream scanner, hashing, receipt codec and `verifyUsageReceipt`; `createVerifyingFetch` wraps the official SDKs' fetch), the format adapters `sdk/src/ai-*.js`, the signing sidecar `server/src/ai-proxy.js` (example: `examples/ai-proxy/`), and `sdk/bin/tapeapi-verify.js`, a local verifying proxy for clients that cannot wrap fetch. None is deployed as a public service: each provider runs its own sidecar.

## 8. Security Considerations

- Replay: `id`, `ts` and the request hash are covered; clients MUST match `id` to an outstanding request, enforce the `ts` window and recompute the request hash from their own `{method, params}`. A signed answer for one question cannot be served for another even under a reused `id`.
- Relabelling: `ok` is covered, so a signed `error` cannot be presented as a `result`, and a `result` shaped like `{code, message}` cannot be turned into a `BAD_VOUCHER` that would roll back a client's meter.
- Substitution: `container` is covered, so a signature from service A cannot be presented as service B.
- Malleability: high-`s` signatures are rejected everywhere (envelope, delegation, voucher) so that off-chain acceptance and on-chain `settle()` agree.
- Prototype pollution: JSON with `__proto__`/`constructor`/`prototype` keys is rejected at parse time on both sides, so a verified `result` can be merged into application state safely.
- Transport: `endpoints.live` MUST be `https://`; `http://` is accepted only by clients explicitly configured for development. Everything above assumes an attacker who can read and modify traffic; https is the first line of defence, not the only one.
- Canonicalisation mismatch is the main interoperability risk; implementations MUST use the definition in §3.3 and SHOULD test against the vectors in §6.
- The signer key is hot; see TAP-20 §8 for rotation.
- AI receipts, what they prove (§3.5): who answered (the key the holder delegated on chain), to exactly which request bytes, with exactly which response bytes, which usage and price the service claimed, and whether the answer completed. They do not prove which model ran: `model` is what the upstream reported, and a provider can label a cheaper model's answer with a dearer model's name or overstate the usage. A client MUST NOT present a receipt as proof of the model. Receipts make such a substitution attributable, not impossible: a signed receipt cannot be disowned, and spot checks (anyone sending test prompts on a schedule and publishing the answers with their receipts) turn a substitution into evidence.
- AI receipts, request privacy: a receipt carries SHA-256 hashes of the request and the answer, never their content, so it can be shown to a third party (a verification page, a dispute) without them. The usage, model and time it carries are visible, and a short or guessable prompt can still be confirmed from its hash by guessing; a client SHOULD share a receipt only where it would share those. A client can close the guessing route by appending random whitespace after the JSON text of the request body before sending it: JSON allows whitespace there, so the request the upstream parses, its tokens and any prompt cache keyed on them are unchanged, while the hash becomes unguessable. The reference clients (`createVerifyingFetch`, `tapeapi-verify`) append 64 random whitespace characters by default, leave compressed and non-JSON bodies alone, and check the receipt over the bytes they sent. The `receipt` method answers anyone who presents an id, so answer ids are the only thing standing between a receipt and a stranger. Some upstreams' ids can be guessed: Ollama's OpenAI-compatible API, at the time of writing, numbers chat ids from a set of 999, and the sidecar keeps the upstream's id (above). The reference sidecar estimates the randomness of the ids it sees and warns when they look guessable, limits the `receipt` method per client IP, lets the operator shorten how long receipts are kept, and can be set to answer only lookups that also name `requestSha256`, which a stranger who guessed an id does not have.
- AI receipts, credentials and headers: the sidecar is part of the provider's service and is operated by the provider. It sees each caller's API key and forwards it to the provider's upstream, so a caller's credentials go to that provider only, as they would without TapeAPI; no third party is meant to run sidecars for providers, since whoever runs one holds every caller's key. A sidecar forwards only the caller headers the formats need (`Content-Type`, `Content-Encoding` and `Accept`, the format's authentication, version and beta headers, and the official clients' identity and session headers), and MUST NOT forward cookies, `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `CF-*` or hop-by-hop headers. The session headers (`x-claude-code-session-id`, `session-id`, `thread-id`) let the upstream tie a caller's requests into one session; the reference sidecar passes them by default, as the clients expect, and can be set to leave them out, as can `tapeapi-verify` on the client side. It MUST NOT follow an upstream redirect, and the upstream's address comes from its configuration only, never from a request.
- AI receipts, compliance: the binding is meant for providers operating within their upstream providers' terms. Identity, prices and receipts on chain keep a provider's identity independent of any single platform; the protocol does not offer, and is not designed to help with, evading an upstream provider's bans or regional restrictions.

## 9. Copyright

Copyright and related rights waived via CC0-1.0.

---

# TAP-21：TapeAPI：签名响应信封（中文译文）

> 英文为权威文本，本译文与英文章节一一对应。

> **占位编号。** TAP-21 是在 [TapeKit issue #8](https://github.com/TapeOutProtocol/TapeKit/issues/8) 中提议的占位编号。TapeKit 目前还没有编号提案流程（对 TapeOut 本身的修改遵循 TapeKit `SPEC.md` §15），因此维护者可能另行分配编号，或把本文档移入其它流程；见 [TAP-1](TAP-1.md)。

> **实现状态（2026-09-27）：** 运行中：`api.tapeapi.fun`（`11.1013.tape`）与 `relay.tapeapi.fun`（`12.1013.tape`）的每个回答（包括错误）都是由 `server/src/` 签名的 v2 信封；SDK 负责验证。未经第三方审计。

RFC 2119 关键词适用。

## 1. 摘要

定义 TapeAPI 实时端点的 HTTP 请求与响应格式，以及提供者附加于每个响应的签名，使客户端能将结果归属于按 TAP-20 解析出的服务容器。本 TAP 还定义 AI 用量回执（§3.5）：用同样的签名覆盖一次 AI 接口请求与回答的确切字节，以及服务为它声称的用量与价格。

## 2. 动机

TLS 认证主机，而非服务身份。没有绑定到容器的签名，客户端无法证明结果来源、无法争议、也无法安全缓存。信封使每个响应成为由清单 `signer` 出具的自包含、可验证的声明。

## 3. 规范

### 3.1 请求

`POST {live}/{method}`，其中 `{live}` 为 `manifest.endpoints.live` 中的一项，`{method}` 为某个 `methods[].name`。请求体为 JSON，`Content-Type: application/json`：

```json
{ "id": "<client uuid>", "method": "circuitHolder", "params": { }, "voucher": { } }
```

- `id`：1–128 个 UTF-16 码元（即 JavaScript 的 `String.length`）的字符串，由客户端选择，每客户端唯一。REQUIRED。
- `method`：OPTIONAL，因为路径段已经指明方法，且摘要覆盖的正是路径段。若提供，MUST 等于路径段；不一致时提供者 MUST 以 `BAD_REQUEST` 拒绝，而不是择一采用。路径段 MUST 匹配 `^[A-Za-z_][A-Za-z0-9_]{0,63}$`。
- `params`：OPTIONAL，缺省为 `{}`；若提供，MUST 为 JSON 对象。缺省的 `params` 在 §3.3 摘要中按 `{}` 处理。
- `voucher`：TAP-22 凭证对象。`priceBEM != "0"` 时 REQUIRED；否则忽略。
- 请求体 MUST 用会拒绝任意深度 `__proto__`、`constructor`、`prototype` 键的 JSON 解析器解析（返回 `400` `BAD_REQUEST`）；§3.3 的规范形式适用同一规则。

### 3.2 响应

成功：

```json
{ "id": "...", "ok": true, "result": { }, "container": "0x..", "ts": 1758300000, "block": 62000000, "sig": "0x..." }
```

错误：

```json
{ "id": "...", "ok": false, "error": { "code": "PAYMENT_REQUIRED", "message": "...", "data": { } }, "container": "0x..", "ts": 1758300000, "sig": "0x..." }
```

- `id` MUST 回显请求的 `id`。提供者无法解析的请求（畸形 JSON、不是对象、超过请求体上限、`id` 缺失或无效）没有可信的 `id` 或 `params`：以绑定 `id` `""` 与 `params` `{}` 的签名 `BAD_REQUEST` 拒绝（HTTP 400，超限为 413）；`params` 没有规范形式的请求以绑定其自身 `id` 与 `params` `{}` 的签名拒绝（§3.3）。无效 `id` 指除 1–128 个 UTF-16 码元的字符串以外的任何值（§3.1），过长的 `id` 也算；与它一同发送的 `params` 同样不用于绑定。对请求的其它一切回答，包括提供者内部故障导致的 `INTERNAL`，都绑定该请求自己的 `id` 与 `params` 签名。收到在任一绑定下验证通过的 `BAD_REQUEST` 的客户端 MUST 报告自己的请求有误（`BAD_REQUEST`），而不是 `BAD_SIGNATURE`。
- `ok` MUST 为 JSON 布尔值，且在签名范围内（§3.3）。
- `container` MUST 等于服务容器。客户端 MUST 拒绝 `container` 与解析所得容器不一致的响应，且 MUST 用自己解析出的容器（而非信封中的值）计算摘要。
- `ts`：提供者的 Unix 秒级时间。客户端 MUST 拒绝 `|now − ts| > maxSkew`；`maxSkew` 默认 300 秒，MAY 配置。
- `block`：OPTIONAL，提供者使用的链高度，仅供参考，不在签名范围内。
- `error.code` MUST 为 `PAYMENT_REQUIRED`、`BAD_VOUCHER`、`METHOD_NOT_FOUND`、`BAD_REQUEST`、`INTERNAL`、`TOOLS_CHANGED`（上游工具与其 `toolsSha256` 不再相符的 MCP 绑定服务，TAP-20 §3.8）之一。错误码只增不减、不重命名。客户端 MUST 将未知码视为错误。
- `error.data`：OPTIONAL JSON 对象，在签名范围内。由累计值过期引起的 `BAD_VOUCHER` MUST 携带 `data.lastCumulative`（十进制字符串）：提供者对该消费者已接受的最高累计值，包含仍在进行中的调用：`max(本地记录, 在途, claimedOf)`。只要该数字高于 `onChainClaimed`，`data.voucher` MUST 是消费者本人对恰好该数字签发的凭证，以便客户端核验；客户端 MUST NOT 采用高于 `onChainClaimed` 且未经证明的数字。客户端 MAY 采用 `max(本地, lastCumulative)` 并重试一次。
- `INTERNAL` 的消息 MUST NOT 泄露上游细节（RPC URL、密钥、内部主机名）；提供者把细节写入日志，对外返回泛化消息。唯一例外：`INTERNAL` MAY 携带 `error.data.revert`，即提供者所做调用的 `0x` 十六进制 revert 字节（人人可复现的链上状态，在签名范围内），此时 `message` 为 `"execution reverted"`。`INTERNAL` 不得附带其他任何内容。
- 签名信封 MAY 以 HTTP `200` 返回，或以与其错误码对应的状态返回（`PAYMENT_REQUIRED` 与 `BAD_VOUCHER` 为 `402`，`METHOD_NOT_FOUND` 为 `404`，格式错误为 `400`/`413`，`INTERNAL` 为 `500`，`TOOLS_CHANGED` 为 `409`）。只要响应体是含 `sig` 字段的合法 JSON，客户端 MUST 无视状态码将其解析为信封，并 MUST 先验签再信任。只有这样的响应体才是信封：不含 `sig` 的 JSON（代理或 CDN 的错误页、未签名的路由错误）或非 JSON 的响应体是传输失败（`PROVIDER_UNAVAILABLE`），绝不是 `BAD_SIGNATURE`。
- 提供者 SHOULD 在 30 秒内响应，且 MUST 将响应体限制在 1 MiB 以内，按 UTF-8 编码后响应体的字节数计。结果会超出上限的提供者回以签名的 `INTERNAL`，且 MUST NOT 为其计费；处理器超出提供者时间上限时同样如此。

### 3.3 摘要与签名（v2）

```
digest = keccak256(
    "TAPI-1/resp/v2"                                     // 14 个 ASCII 字节，无长度前缀
  ‖ container                                            // 20 字节：解析所得的服务容器
  ‖ keccak256(utf8(id))                                  // 32 字节
  ‖ keccak256(utf8(canonicalJSON({ method, params })))   // 32 字节：被回答的请求
  ‖ uint8(ok ? 1 : 0)                                    // 1 字节
  ‖ keccak256(utf8(canonicalJSON(body)))                 // 32 字节；ok 时 body = result，否则 = error
  ‖ uint64BE(ts)                                         // 8 字节
)
sig = 对 32 字节 digest 的 secp256k1 EIP-191 personal_sign，即
      ecrecover(keccak256("\x19Ethereum Signed Message:\n32" ‖ digest), sig) MUST == manifest.signer
```

- `{ method, params }` 是恰好含这两个键的对象；`method` 为请求的方法名，`params` 为请求的 `params` 对象（缺省为 `{}`）。客户端 MUST 用**自己发出的**请求计算此哈希，绝不使用提供者回显的值。
- `ok` 为信封的布尔值。因其被覆盖，签名的错误不能被当作结果呈现，反之亦然。
- `sig` 为 65 字节 `r ‖ s ‖ v`，`v ∈ {27, 28}`，且 MUST 为低 `s`（`s ≤ n/2`）。验证方 MUST 拒绝高 `s` 签名以及（把 `0/1` 归一化为 `27/28` 后）`v ∉ {27, 28}` 的签名，与 TAP-22 所用的链上 `ECDSA.recover` 完全一致。
- `block` 不在签名覆盖范围内。

**canonicalJSON** 即 JSON 规范化方案（JCS，RFC 8785）加五条 TAPI 收紧。JCS 部分：对象键按 UTF-16 码元顺序递归排序，无空白，数字按 ECMAScript `Number::toString` 的最短往返形式序列化，字符串按 `JSON.stringify` 转义。

之所以要收紧：一个存在两种都说得通的规范形式的值，就是两个验证方可能产生分歧的值，而验证方之间的分歧就是一次签名绕过。

1. **不得有重复键。** RFC 8785 §3 明令禁止；保留最后一个的解析器会悄悄改变它收到的那串字节的含义。签名方 MUST 拒绝、验证方 MUST 拒绝任何某个对象重复出现同一个键的 JSON 文本，而不是从中挑一个赢家。
2. **不得有 `NaN`、`Infinity` 或 `-0`。** `-0` 会被序列化成 `0`，事后两者无法区分。
3. **不得有绝对值超过 2^53 − 1 的整数。** 这种值在成为 IEEE-754 双精度数时就已丢失精度，签名方与验证方会对一个谁都没打错的数产生分歧。请用字符串携带，正如 TAP-20 对金额与 tokenId 的做法（RFC 7493 §2.2）。
4. **树中任何位置都不得有 `__proto__`、`constructor`、`prototype` 自有键**，也不得有规范形式依赖宿主语言钩子（例如 JavaScript 的 `toJSON()`）的值：没有别的语言会复现它。
5. **任何字符串或键中都不得有孤立（未配对）的 UTF-16 代理项。** 这样的字符串不是良构的 Unicode（RFC 7493 §2.1），也没有唯一的 UTF-8 编码。与上述各条相同，签名方 MUST 拒绝、验证方 MUST 拒绝。

提供者收到 `params` 按上述规则没有规范形式的请求时，以 `BAD_REQUEST` 拒绝，签名所用的请求哈希按 `{ method, params: {} }` 计算。

客户端 MUST 从解析后的 `result`/`error` 对象重新计算规范形式，而非对原始字节哈希，且 MUST 将解析的响应体限制在 1 MiB 以内。

### 3.4 客户端错误码

除提供者错误码外，客户端 MUST 暴露：`RPC_DISAGREE`、`BAD_SIGNATURE`、`MANIFEST_INVALID`、`DELEGATION_INVALID`、`PROVIDER_UNAVAILABLE`、`RATE_LIMITED`、`PRICE_CHANGED`（价格涨到调用方已同意的价格之上，TAP-20 §3.6）、`QUORUM_FAILED`（一般的多提供者不一致，或可验证的答案过少）以及 `ATTEST_DISAGREE`（TAP-23 §3.4）。参考 SDK 另外使用以下信息性的客户端错误码，实现 MAY 扩展：`NOT_FOUND`（目标处没有服务或文件，TAP-20 §3.6）、`RPC_UNAVAILABLE`（作答节点过少；不同于 `RPC_DISAGREE`）、`RPC_ERROR`（所有作答节点返回同一个 JSON-RPC 错误）、`CANON_INVALID`、`ABI_INVALID`、`BAD_KEY`、`CHANNEL_INVALID`（TAP-26）、`GROUP_INVALID` 与 `GROUP_EQUIVOCATION`（TAP-27）、`TAPESEND_INVALID`（TAP-10 载荷）、`COMPARE_PATH_INVALID`、`RECEIPT_INVALID`（AI 用量回执缺失或未通过 §3.5 的某项核验），以及 `BUDGET_EXCEEDED` 与 `USER_DECLINED`（WebMCP 适配器的花费预算与用户确认）。提供者自身的路由错误（未知路径的 `NOT_FOUND`、`METHOD_NOT_ALLOWED`）不签名，对客户端而言是传输失败。参考提供者在自己的委托已过期或尚无委托时发出的未签名 HTTP 503 `DELEGATION_INVALID` 同样如此；它未签名，只是提示，参考 SDK 仅在本地清单副本也显示委托已过期时报告为 `DELEGATION_INVALID`，否则报告为 `PROVIDER_UNAVAILABLE`。这些是客户端错误码：它们都绝不是签名信封中合法的 `error.code`（`RATE_LIMITED` 只出现在下文未签名的 429 响应体中）。`BAD_SIGNATURE` 涵盖所有信封绑定失败（签名、`id`、`container`、请求哈希、`ok`、`ts` 窗口）。遇 `BAD_SIGNATURE` 时，客户端 MUST 在重试前按 TAP-20 §3.6 从步骤 2 起重读清单。若重读所得清单指明的恰是签署该信封的密钥，客户端 MAY 在该信封按重读清单完整验证通过后接受这同一个信封，而不是再次发送请求，以免为提供者已计费的结果付两次钱。由签名失败触发的重读 SHOULD 按服务限频。无法解析为信封的响应（畸形 JSON、无 `sig`、禁用键、超过 1 MiB）为 `PROVIDER_UNAVAILABLE`。

**限流。** 提供者 MAY 在做任何工作之前拒绝请求。此类拒绝 MUST 使用 HTTP 429，带 `Retry-After` 头，body 为 `{ ok: false, error: { code: "RATE_LIMITED", data: { retryAfterS } } }`，且 MUST NOT 签名：它不对任何结果作出断言，而给拒绝签名会让每一次洪水都要提供者付出一次签名。客户端 MUST 把 HTTP 429 视为 `RATE_LIMITED`，且 MUST NOT 对它做信封校验。预算按提供者进程计，不跨实例共享；多台主机承载的服务，每台各有一份预算。为付费调用维护按消费者预算的提供者，MUST 以凭证签名所证明的消费者（TAP-22 §3.2）为键，绝不以请求中原样的 `consumer` 字段为键：未经验证的字段让任何人都能把受害者地址写进验不过的凭证，耗光受害者的预算。未经验证的流量，包括附带凭证调用的免费方法，计入调用方的免费预算。提供者位于代理之后时，限流所用的调用方身份 MUST 来自宿主（例如边缘节点给出的连接 IP）或所配置转发头的**最后**一跳，绝不来自客户端能自己提供的值，例如 `X-Forwarded-For` 的第一项。

进行计费（TAP-22）的客户端 MUST NOT 在收到已验证信封之前推进本地累计值；传输失败释放预留，若提供者实际已消费，下一张凭证通过 `error.data.lastCumulative` 纠正。

### 3.5 AI 用量回执

清单带 `ai` 字段（TAP-20 §3.9）的服务以接口自己的格式回答 AI 接口请求，而不是用 §3.1–§3.2 的信封。它的回答经过一个**签名旁路**：放在上游接口前面的代理，是提供者服务的一部分、由提供者运营；除本节所述之外，它原样转交请求与回答，并为 TAP-20 §3.9 格式表中列出的每个请求签一份**用量回执**。其它请求原样通过，没有回执。

**信封。** 回执是完全按 §3.3、由清单的 `signer` 签名的信封，其中 `ok` = `true`，`body` = `result`：

```json
{ "id": "chatcmpl-v1", "ok": true, "container": "0x…", "ts": 1790000000,
  "method": "openai_chat", "params": { "path": "/v1/chat/completions", "requestSha256": "<64 位十六进制>" },
  "result": { "model": "gpt-x",
              "usage": { "prompt_tokens": 1200, "completion_tokens": 300, "total_tokens": 1500, "cache_read_tokens": 1000, "reasoning_tokens": 100 },
              "responseSha256": "<64 位十六进制>", "stream": false, "complete": true, "status": 200,
              "prices": [ { "currency": "USDT", "amount": "0.00357500" }, { "currency": "BEM", "amount": "0.03375000" } ],
              "modelMatchedBy": "response" },
  "sig": "0x…" }
```

它与 §3.2 的信封有三处不同。`method` 与 `params` 随信封传送，因为客户端从未发送它们；摘要中的请求哈希按信封里的 `{ method, params }` 计算，客户端再把它们与自己的请求对照（见下）。`id` 指的是回答而不是客户端请求，因此 §3.2 中 `id` 回显请求的规则不适用。`ok` 总是 `true`：回执陈述的是上游如何作答，包括失败的回答（`status`），永远不是旁路自己的错误。没有 `block`。

- `method`：该格式的回执方法：`openai_chat`、`openai_responses`、`anthropic_messages` 或 `openai_embeddings`。
- `id`：回答自己的 id（见下表），当它是 1 到 128 个 U+0021–U+007E 字符组成的字符串时；否则为旁路生成的 id，该 id SHOULD NOT 可被猜到（参考实现：`tapeapi-` 加 24 位随机小写十六进制数字）。
- `params.path`：请求相对服务根（TAP-20 §3.9）的路径，不含 query，例如 `/v1/chat/completions`。
- `params.requestSha256`：客户端发出的请求体字节（含客户端自己施加的内容编码）原样取 SHA-256，写成 64 位小写十六进制。

| `result` 成员 | 类型 | 含义 |
|---|---|---|
| `model` | string 或 null | 上游报告的模型；`modelMatchedBy` 为 `"request"` 时为请求的模型；两者都没有时为 `null`。 |
| `usage` | object 或 null | TAP-20 §3.9 的用量对象；回答没有报告可成立的用量时为 `null`，`status` 不在 2xx 时总是 `null`。 |
| `responseSha256` | string | 回应哈希（见下），64 位小写十六进制。 |
| `stream` | boolean | 回答是否为事件流：格式会流式、上游的 `Content-Type` 含 `text/event-stream`（ASCII 不区分大小写），且状态码是带正文的（不是 101、204、205 或 304）。`openai-embeddings` 的回答永远不是流。 |
| `complete` | boolean | 2xx 的整体回答、且其格式没有标记为未完成时为 `true`；2xx 的流到达了格式的最终成功事件（见下表）时为 `true`；其它情况为 `false`。未完成的回答仍按它报告的用量定价。 |
| `status` | integer | 上游的 HTTP 状态码。 |
| `prices` | array 或 null | `[ { currency, amount } ]`，匹配模型的每个价格条目一个，顺序与价目表相同，每个金额按 TAP-20 §3.9 计算；没有条目匹配或 `usage` 为 `null` 时为 `null`。 |
| `modelMatchedBy` | string | `"response"` 或 `"request"`（TAP-20 §3.9）；恰在某个价格条目匹配了 `model` 时出现，即使 `prices` 为 `null`。 |
| `unpriced` | string[] | `usage.other` 中的名称；只在 `prices` 不为 `null` 且 `usage.other` 存在时出现。 |
| `usageInjected` | `true` | 只在旁路为了拿到用量而改动了发往上游的请求时出现（见下）。 |

前七个成员总是出现。`modelMatchedBy`、`unpriced` 与 `usageInjected` 不适用时 MUST 省略，绝不写成 `null`、`false` 或空列表。

**格式。** 旁路 MUST 按下表读取回答的 id、模型、用量与完成情况（所有名称都是接口 JSON 的成员；"流"指各事件的 data）：

| 格式 | 回答的 id 与模型 | 用量（TAP-20 §3.9 成员 ← 接口成员） | `complete` |
|---|---|---|---|
| `openai-chat` | `id`、`model`；流：各块中第一个 `id` 与最后一个 `model` | `prompt_tokens`、`completion_tokens`、`total_tokens` ← 同名成员；`cache_read_tokens` ← `prompt_tokens_details.cached_tokens`，否则 `prompt_cache_hit_tokens`；`reasoning_tokens` ← `completion_tokens_details.reasoning_tokens`；流：最后一个带 `usage` 对象的块 | 整体：2xx；流：某块有 `finish_reason` 非 null 的 choice，且没有块带非 null 的 `error` |
| `openai-responses` | `id`、`model`；流：事件所带 `response` 对象的这两项（第一个 id、最后一个模型） | `prompt_tokens` ← `input_tokens`；`completion_tokens` ← `output_tokens`；`total_tokens` ← 同名成员；`cache_read_tokens` ← `input_tokens_details.cached_tokens`；`reasoning_tokens` ← `output_tokens_details.reasoning_tokens`；流：最后一个 `response.usage` | 整体：`status` 为 `"completed"` 或不存在；流：有 `response.completed` 事件，且没有 `response.failed`、`response.incomplete` 或 `error` 事件（事件类型取其 data 的 `type`，否则取事件名） |
| `anthropic-messages` | `id`、`model`；流：`message_start.message` 的这两项 | `prompt_tokens` ← `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`；`completion_tokens` ← `output_tokens`；`total_tokens` ← 二者之和；`cache_read_tokens` ← `cache_read_input_tokens`；`cache_write_tokens` ← `cache_creation_input_tokens`；`cache_write_1h_tokens` ← `cache_creation.ephemeral_1h_input_tokens`；`other.web_search_requests` ← `server_tool_use.web_search_requests`；流：`message_start.message.usage`，其后每个成员取 `message_delta` 中最新的非 null 值 | 整体：正文的 `type` 不是 `"error"`；流：有 `message_stop` 事件且没有 `error` 事件 |
| `openai-embeddings` | `id`（通常没有）、`model` | `prompt_tokens`、`total_tokens` ← 同名成员；`completion_tokens` 为 0 | 2xx |

| 格式 | 结束标记（不计入哈希） | 最终事件（按其首行） |
|---|---|---|
| `openai-chat` | `[DONE]` | `data: [DONE]` |
| `openai-responses` | `[DONE]`（可有可无） | `event: response.completed`、`event: response.incomplete`、`event: response.failed` |
| `anthropic-messages` | 无 | `event: message_stop` |

首行冒号后有没有空格都算匹配。

**回应哈希。** `responseSha256` 是以下内容的 SHA-256，写成 64 位小写十六进制：

- 整体回答（`stream` 为 false）：客户端收到的响应体字节，去掉任何 HTTP 内容编码之后，原样取哈希；
- 流（`stream` 为 true）：客户端收到的事件数据，按以下规则（WHATWG HTML §9.2）把字节解析为 server-sent events 得出，核验方与旁路 MUST 严格按这些规则解析：
  1. 行以 CRLF、LF 或 CR 结束。流最开头的一个 U+FEFF 跳过。
  2. 以 `:` 开头的行是注释，忽略；下文的回执注释就是注释。
  3. 行 `field: value` 在第一个 `:` 处拆开，紧跟该冒号的一个 U+0020 去掉。没有冒号的行是以整行为名、值为空的字段。
  4. 一个事件所有 `data` 字段的值以 `"\n"`（U+000A）连接。
  5. 事件只在空行处分派，且只在它至少有一个 `data` 字段时分派。流结束时没有以空行结束的事件丢弃。

  按顺序取每个已分派事件的 data，作为 UTF-8 字节；去掉 data 恰为该格式结束标记的事件；把其余每个 data 各接一个 `"\n"` 字节后拼接，取哈希。事件名、`id` 与 `retry` 字段以及注释都不计入哈希。最终事件与其它事件一样计入哈希，尽管线路上回执注释在它之前。

**用量注入。** OpenAI Chat 的流只有在请求把 `stream_options.include_usage` 设为 `true` 时才报告用量。流式的 `openai-chat` 请求没有这样设时，旁路 MAY 向上游发送把该成员设好的请求体副本。此时它 MUST 从客户端的副本中去掉这一改动引起的每个 data 事件（data 是带 `usage` 对象且 `choices` 为空数组的 JSON 对象的事件），MUST 从中取得用量，并 MUST 设置 `usageInjected`。`requestSha256` 仍是客户端发出的字节的哈希，回应哈希覆盖的是客户端收到的内容，恰好是它所要的。旁路 MUST NOT 以任何其它方式改动发往上游的请求体。

**送达。**

- 整体回答把回执放在响应头 `x-tapeapi-receipt` 里：信封 JSON 文本的 base64url（RFC 4648 §5，无填充）。旁路 MUST 丢弃上游的任何 `x-tapeapi-receipt` 响应头，并 SHOULD 把该响应头列入 `Access-Control-Expose-Headers`，使浏览器能读到它。
- 流把回执作为一个 SSE 注释块发送：`: tapeapi-receipt <base64url>` 后接一个空行，紧放在格式的最终事件之前：旁路扣住最终事件直到它完整，把它计入哈希，签名，先发注释块，再发该事件。客户端忽略注释，所以它们解析出的内容不变，读到最终事件就停止的客户端也已经收到了回执。回执 MUST NOT 使用自定义事件类型（OpenAI 的 SDK 会把不认识的事件交给应用）。
- 没有最终事件的流（或旁路无法扣住最终事件的流：参考实现至多扣住 4 MiB，也认不出不带 `event:` 行的 Responses 流的最终事件）在末尾带一行 `: tapeapi-receipt <base64url>` 及行尾；流停在行中间时先补一个行尾；其后不加空行，使未结束的事件保持未结束。已经开始但始终没有结束的最终事件，注释块放在它之前。
- 经过多个旁路的流带有多个回执注释；最外层旁路的在最后。客户端先核验最后一个。
- **取回。** 这类服务的清单 MUST 列出免费方法 `receipt`（`priceBEM` 为 `"0"`，`params: { id: "string" }`），它以 §3.2 的 `result` 返回 `id` 相同的已存回执信封；两个回答同一 id 时，返回后一个的；没有存着回执的 id 以签名的 `BAD_REQUEST` 作答，因为 §3.2 没有表示"找不到"的提供者错误码。该方法 MAY 另外接受第二个、可选的参数 `requestSha256`（64 位小写十六进制，即某份回执的 `params.requestSha256`）；清单条目仍如上所写。给出它时，只返回 `id` 与 `params.requestSha256` 都等于参数的那份回执，共用一个 id 的回答因此得以区分；接受该参数的旁路因此按 (`id`, `requestSha256`) 而不是按 `id` 保存回执。上游 id 可以被猜到的提供者 MAY 拒绝没有给出 `requestSha256` 的取回，以签名的 `BAD_REQUEST` 作答。提供者 SHOULD 使每份回执在回答之后至少一小时内可以取回。随回答送达的那份才是主要的；参考实现把回执在签发它的进程内存里按 (`id`, `requestSha256`) 保留一小时（可配置），至多 50 000 份，并给 `receipt` 方法单独的预算（每个客户端 IP 每分钟 10 次，超出时以 §3.4 的未签名 429 拒绝）。

**旁路错误。** 旁路自身的故障（它的限流、超过其大小上限的请求、无法连通或未按时作答的上游、上游的重定向，重定向从不跟随）按 OpenAI 的错误格式（`{ "error": { "message", "type", "param", "code" } }`）作答，不带回执、不签名：没有可绑定的上游回答。客户端无法把这样的回答与回执被剥掉的回答区分开，MUST NOT 把它当作已核验的回答。旁路 MAY 用响应头 `x-tapeapi-sidecar-error: 1` 标记这样的回答；该标记仅供参考，因为路径上任何一方都能添加或去掉它，客户端把它报告为 `PROVIDER_UNAVAILABLE`（HTTP 429 为 `RATE_LIMITED`），绝不当作已核验。

**客户端核验。** 依赖回执的客户端 MUST 核验：

1. **结构**：信封与 `result` 符合上文：哈希为 64 位十六进制，`usage` 成员按 TAP-20 §3.9 的顺序，金额恰好 8 位小数，币种唯一，`status` 不在 2xx 时 `usage` 与 `prices` 为 `null`。
2. **签名**：对回执的 `container`、`id`、`{ method, params }`、`ok` 与 `result` 计算的 §3.3 摘要，恢复出的是按 TAP-20 §3.6 解析并核验过的清单的 `signer`，且 `container` 是解析所得的容器。由别的密钥签名的回执，在拒绝之前先触发 §3.4 的重读（服务可能换了钥）。
3. **方法与路径**：`method` 是某个已知格式的回执方法，该格式提供 `params.path`；`params.path`、`status` 与 `stream` 就是它发出的请求与收到的回答的对应值。
4. **字节**（手里有时）：`requestSha256` 是它发出的请求体的哈希；`responseSha256` 是它收到的内容按上述规则的哈希；`complete` 与它自己读回答得出的一致；回答带有旁路会采用的 id（1 到 128 个 U+0021–U+007E 字符）时，`id` 与之相等。它 SHOULD 另外把 `model` 与 `usage` 与回答自己的（按格式表）比较（`usageInjected` 为真时用量无法比较）。做不了的核验 MUST 报告为未核验，绝不能报告为通过。
5. **金额**：按 TAP-20 §3.9，用清单的 `ai` 字段，对回执的 `model`、`usage` 与格式重新计算：`modelMatchedBy` 恰在有条目匹配时出现，`prices` 等于重算出的列表（币种、顺序与金额），重算没有结果时为 `null`，`unpriced` 等于 `usage.other` 中的名称。`modelMatchedBy` 为 `"request"` 且手里有请求时，`model` 是请求的模型。
6. **时效**：在回答到达时核验回执的客户端执行 §3.2 的 `ts` 窗口。事后核验的回执（按 id 取回或审计）做不到这一点，核验结果要如实注明。

核验失败的客户端 MUST NOT 把该回执当作已核验呈现，并 SHOULD 把失败报告给它的调用方，而不是丢弃（参考实现抛出 `RECEIPT_INVALID`，流在结束时抛出）。

## 4. 原理

- 固定 ASCII 前缀将摘要与 EIP-712 及 TapeSend 载荷进行域分离。
- 分别哈希 `id`、请求与响应体使摘要定长，并允许验证方在不重新序列化整个信封的情况下检查绑定。
- 覆盖 `{method, params}` 与 `ok`（v2）使信封成为"这是对那个问题的回答"而非"这是我签过的某个载荷"：代理或 CDN 上的中间人无法把签名的错误改标成成功，TAP-25 的争议也能证明回答的是哪个问题。
- 对 32 字节摘要的 EIP-191 签名被所有钱包与 HSM 支持；EIP-712 类型化数据被否决，因为 `result` 没有固定类型。
- 错误也签名，使提供者无法否认曾拒绝一个已付费请求。

## 5. 向后兼容

不向 `SPEC.md` 添加任何内容；不改变名称语法或 §15.1 不变量。v2 取代 v1（`TAPI-1/resp/v1`，既不覆盖请求也不覆盖 `ok`）；v2 客户端 MUST 拒绝 v1 信封，它们会直接验签失败。前缀中的版本号允许未来无歧义地引入新版信封。

## 6. 测试向量

| 项目 | 值 |
|---|---|
| `keccak256("TAPI-1/resp/v2")`（仅供参考，前缀按原始字节使用） | `0xbd61d43697493b5514339aa5ca816a32e8911486b4b1e5395614878bd164011d` |
| `keccak256("TAPI-1/resp/v1")`（已废弃） | `0x9949be85c994f5fc85a89cbc352135b57020456364cd860d35deeb305aefb5c9` |
| 完整信封摘要 + 签名（对摘要的 EIP-191 签名，§3.3） | `spec/vectors/tap-21-envelope.json`，由 `spec/vectors/verify.py` 独立校验摘要并恢复签名者 |
| AI 用量回执（§3.5）：七个用例（Chat 整体回答与带用量注入的流、带模型别名的 Responses 流、带思考块与两种缓存的 Anthropic 流、按请求模型定价的 embeddings、以 error 事件结束的 Anthropic 流、HTTP 429），每个都给出请求字节、上游回答、客户端收到的字节、清单 `ai` 字段、公开的测试签名密钥，以及期望的哈希、result、信封与响应头或注释的值 | `sdk/test/fixtures/ai-receipt-vectors.json`，由参考旁路重新生成，由 `sdk/test/ai-receipt-vectors.test.mjs` 核对，该测试用独立的整段 SSE 解析器重算每个流哈希；并由 `spec/vectors/verify.py` 独立核验（请求与流哈希、金额、信封摘要与签名者） |

## 7. 参考实现

`sdk/src/canon.js`（规范 JSON）、`sdk/src/sig.js`（摘要与恢复）、`server/src/index.js`（签名）。运行中：`https://api.tapeapi.fun`（源码 `examples/public-api/`）与 `https://relay.tapeapi.fun`（源码 `examples/cloudflare-worker/relay-worker.js`）以此信封签署每个回答。

AI 用量回执（§3.5）：`sdk/src/ai.js`（流扫描器、哈希、回执编解码与 `verifyUsageReceipt`；`createVerifyingFetch` 包装官方 SDK 的 fetch）、格式适配器 `sdk/src/ai-*.js`、签名旁路 `server/src/ai-proxy.js`（示例：`examples/ai-proxy/`），以及 `sdk/bin/tapeapi-verify.js`：给无法包装 fetch 的客户端用的本地核验代理。它们都不作为公共服务部署：每个提供者运行自己的旁路。

## 8. 安全考量

- 重放：`id`、`ts` 与请求哈希被覆盖；客户端 MUST 将 `id` 与未完成请求匹配、执行 `ts` 窗口，并用自己的 `{method, params}` 重算请求哈希。即使 `id` 被复用，对一个问题的签名回答也不能被用作另一个问题的回答。
- 改标：`ok` 被覆盖，因此签名的 `error` 不能被当作 `result` 呈现，形如 `{code, message}` 的 `result` 也不能被改成会让客户端回退计费的 `BAD_VOUCHER`。
- 替换：`container` 被覆盖，因此服务 A 的签名不能被当作服务 B 呈现。
- 可延展性：所有地方（信封、委托、凭证）都拒绝高 `s` 签名，使链下接受与链上 `settle()` 一致。
- 原型污染：双方在解析时即拒绝含 `__proto__`/`constructor`/`prototype` 键的 JSON，已验证的 `result` 可以安全地合并进应用状态。
- 传输：`endpoints.live` MUST 为 `https://`；仅显式配置为开发模式的客户端接受 `http://`。以上所有内容都假设攻击者能读取并修改流量；https 是第一道防线，而非唯一防线。
- 规范化不一致是主要的互操作风险；实现 MUST 使用 §3.3 的定义，并 SHOULD 对照 §6 的向量测试。
- 签名密钥是热钥；轮换见 TAP-20 §8。
- AI 回执证明什么（§3.5）：谁回答的（持有者在链上委托的密钥）、针对哪些确切的请求字节、给出了哪些确切的回应字节、服务声称了多少用量与价格，以及回答是否完成。它们不证明实际运行的是哪个模型：`model` 是上游报告的，提供者可以把便宜模型的回答标成贵模型的名字，或多报用量。客户端 MUST NOT 把回执当作模型的证明呈现。回执让这种替换可以追责，而不是不可能：签名的回执无法抵赖，抽检（任何人定期发送测试题，连同回执公开回答）把替换变成证据。
- AI 回执与请求隐私：回执带的是请求与回答的 SHA-256 哈希，从不带其内容，因此可以不附内容就出示给第三方（核验页、争议）。回执里的用量、模型与时间是可见的，短小或可猜的提示词仍可能通过猜测由哈希确认；客户端 SHOULD 只在愿意分享这些信息的场合分享回执。客户端可以在发送前于请求正文的 JSON 文本之后追加随机空白，堵住这条猜测的路：JSON 允许那里出现空白，所以上游解析出的请求、它的 token 以及按 token 取键的提示词缓存都不变，而哈希变得无法猜测。参考客户端（`createVerifyingFetch`、`tapeapi-verify`）默认追加 64 个随机空白字符，压缩过的与非 JSON 的正文不处理，并按实际发出的字节核验回执。`receipt` 方法回应任何出示 id 的人，所以回答 id 是回执与陌生人之间唯一的屏障。有些上游的 id 可以被猜到：截至本文撰写时，Ollama 的 OpenAI 兼容接口从 999 个取值里给对话编号，而旁路沿用上游的 id（见上）。参考旁路会估计它看到的 id 的随机性，id 像是可猜时发出警告；按客户端 IP 限制 `receipt` 方法；允许运营者缩短回执的保留时间；还可以设置为只回应同时给出 `requestSha256` 的取回，猜中 id 的陌生人没有这个哈希。
- AI 回执、凭据与请求头：旁路是提供者服务的一部分，由提供者运营。它看得到每个调用方的 API 密钥并转发给提供者的上游，所以调用方的凭据只到达该提供者，与不用 TapeAPI 时一样；不应由第三方替提供者运行旁路，因为运行旁路的人握有每个调用方的密钥。旁路只转发格式需要的调用方请求头（`Content-Type`、`Content-Encoding` 与 `Accept`，格式的鉴权、版本与 beta 头，以及官方客户端的身份与会话头），且 MUST NOT 转发 Cookie、`Forwarded`、`X-Forwarded-*`、`X-Real-IP`、`CF-*` 或逐跳头。会话头（`x-claude-code-session-id`、`session-id`、`thread-id`）让上游能把同一调用方的请求串成一段会话；参考旁路默认转发它们（客户端期望如此），也可以设置为不转发，客户端一侧的 `tapeapi-verify` 同样可以。它 MUST NOT 跟随上游的重定向，上游地址只来自其配置，绝不来自请求。
- AI 回执与合规：本绑定面向在上游服务条款范围内经营的提供者。身份、价格与回执在链上，使提供者的身份不受任何单一平台左右；本协议不提供、也不是为了帮助规避上游服务商的封禁或地区限制而设计的。

## 9. 版权

Copyright and related rights waived via CC0-1.0.
