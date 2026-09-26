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

Defines the HTTP request and response format for a TapeAPI live endpoint and the signature a provider attaches to every response so that a client can attribute the result to the service container resolved under TAP-20.

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

- `id` MUST echo the request `id`. A request the provider could not parse (malformed JSON, not an object, over its body limit, missing or invalid `id`) has no `id` or `params` it can trust: it is refused with a `BAD_REQUEST` (HTTP 400, or 413 for size) signed over `id` `""` and `params` `{}`, and a request whose `params` have no canonical form is refused signed over its own `id` and `params` `{}` (§3.3). A client that receives a `BAD_REQUEST` which verifies under either binding MUST report its own request as malformed (`BAD_REQUEST`), not `BAD_SIGNATURE`.
- `ok` MUST be a JSON boolean and is covered by the signature (§3.3).
- `container` MUST equal the service container. Clients MUST reject a response whose `container` differs from the resolved container, and MUST compute the digest with the container they resolved, not with the value in the envelope.
- `ts`: provider Unix time in seconds. Clients MUST reject `|now − ts| > maxSkew`; `maxSkew` defaults to 300 s and MAY be configured.
- `block`: OPTIONAL, the chain height the provider used, informative and unsigned.
- `error.code` MUST be one of `PAYMENT_REQUIRED`, `BAD_VOUCHER`, `METHOD_NOT_FOUND`, `BAD_REQUEST`, `INTERNAL`. Codes are only added, never removed or renamed. Clients MUST treat unknown codes as errors.
- `error.data`: OPTIONAL JSON object, covered by the signature. A `BAD_VOUCHER` caused by a stale `cumulative` MUST carry `data.lastCumulative` (decimal string): the highest cumulative the provider has accepted for this consumer, including calls still in flight: `max(stored, in-flight, claimedOf)`. Whenever that figure exceeds `onChainClaimed`, `data.voucher` MUST be the consumer's own voucher for exactly that figure, so the client can verify it; a client MUST NOT adopt an unproven figure above `onChainClaimed`. A client MAY adopt `max(local, lastCumulative)` and retry once.
- `INTERNAL` messages MUST NOT reveal upstream details (RPC URLs, keys, internal hostnames); the provider logs the detail and returns a generic message. The single exception: an `INTERNAL` MAY carry `error.data.revert`, the `0x`-hex revert bytes of a call the provider made (chain state anyone can reproduce, covered by the signature), with `message` `"execution reverted"`. Nothing else may be attached to an `INTERNAL`.
- A signed envelope MAY be carried with HTTP status `200`, or with the status matching its error code (`402` for `PAYMENT_REQUIRED` and `BAD_VOUCHER`, `404` for `METHOD_NOT_FOUND`, `400`/`413` for malformed requests, `500` for `INTERNAL`). Clients MUST parse the body as an envelope whenever it is valid JSON with a `sig` field, regardless of status, and MUST verify the signature before trusting it. Only such a body is an envelope: JSON without `sig` (a proxy or CDN error page, an unsigned route error) or a body that is not JSON is a transport failure (`PROVIDER_UNAVAILABLE`), never `BAD_SIGNATURE`.
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

Clients MUST expose, in addition to the provider codes: `RPC_DISAGREE`, `BAD_SIGNATURE`, `MANIFEST_INVALID`, `DELEGATION_INVALID`, `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `PRICE_CHANGED` (a price rose above what the caller accepted, TAP-20 §3.6), `QUORUM_FAILED` (generic multi-provider disagreement, or too few verifiable answers) and `ATTEST_DISAGREE` (TAP-23 §3.4). The reference SDK additionally uses these informative client codes, which implementations MAY extend: `NOT_FOUND` (no service or file at the target, TAP-20 §3.6), `RPC_UNAVAILABLE` (too few nodes answered; distinct from `RPC_DISAGREE`), `RPC_ERROR` (every answering node returned the same JSON-RPC error), `CANON_INVALID`, `ABI_INVALID`, `BAD_KEY`, `CHANNEL_INVALID` (TAP-26), `GROUP_INVALID` and `GROUP_EQUIVOCATION` (TAP-27), `TAPESEND_INVALID` (TAP-10 payloads), `COMPARE_PATH_INVALID`, and `BUDGET_EXCEEDED` and `USER_DECLINED` (the WebMCP adapter's spending budget and user confirmation). A provider's own route errors (`NOT_FOUND` for an unknown path, `METHOD_NOT_ALLOWED`) are unsigned and are transport failures to the client. So is the reference provider's unsigned HTTP 503 `DELEGATION_INVALID`, sent while its own delegation has lapsed or before it has one; being unsigned it is only a hint, and the reference SDK reports it as `DELEGATION_INVALID` only when its own copy of the manifest shows the delegation expired, and as `PROVIDER_UNAVAILABLE` otherwise. These are client-side codes: none of them is ever a valid `error.code` in a signed envelope (`RATE_LIMITED` travels only in the unsigned 429 body described below). `BAD_SIGNATURE` covers every envelope-binding failure (signature, `id`, `container`, request hash, `ok`, `ts` window). On `BAD_SIGNATURE` the client MUST re-read the manifest per TAP-20 §3.6 from step 2 before retrying. If the re-read manifest names exactly the key that signed the envelope, the client MAY accept that same envelope, once it verifies in full against the re-read manifest, rather than sending the request again, so that a result the provider already billed is not paid twice. Re-reads triggered by signature failures SHOULD be rate limited per service. A response that cannot be parsed as an envelope (malformed JSON, no `sig`, forbidden keys, over 1 MiB) is `PROVIDER_UNAVAILABLE`.

**Rate limiting.** A provider MAY refuse a request before doing any work. Such a refusal MUST use HTTP 429 with a `Retry-After` header and a body of `{ ok: false, error: { code: "RATE_LIMITED", data: { retryAfterS } } }`, and it MUST NOT be signed: it asserts nothing about any result, and signing refusals would make a flood cost the provider a signature each. Clients MUST treat HTTP 429 as `RATE_LIMITED` and MUST NOT attempt envelope verification on it. Budgets are per provider process and are not shared between instances; a service behind several hosts enforces a budget per host. A provider that keeps a per-consumer budget for paid calls MUST key it on the consumer the voucher signature proves (TAP-22 §3.2), never on the `consumer` field as sent: an unverified field lets anyone exhaust a victim's budget by writing the victim's address into vouchers that do not verify. Unverified traffic, including a free method called with a voucher attached, belongs to the caller's free budget. When a provider sits behind a proxy, the caller identity used for rate limiting MUST come from the host (e.g. the edge's connecting IP) or from the **last** hop of a configured forwarding header, never from a value the client can supply, such as the first `X-Forwarded-For` entry.

Clients that meter payments (TAP-22) MUST NOT advance their local cumulative until a verified envelope has been received; a transport failure releases the reservation, and the next voucher is corrected through `error.data.lastCumulative` if the provider had in fact consumed it.

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
| Full envelope digest + signature | `spec/vectors/tap-21-envelope.json`, checked independently by `spec/vectors/verify.py` |

## 7. Reference Implementation

`sdk/src/canon.js` (canonical JSON), `sdk/src/sig.js` (digest and recovery), `server/src/index.js` (signing). Live: `https://api.tapeapi.fun` (source `examples/public-api/`) and `https://relay.tapeapi.fun` (source `examples/cloudflare-worker/relay-worker.js`) sign every answer with this envelope.

## 8. Security Considerations

- Replay: `id`, `ts` and the request hash are covered; clients MUST match `id` to an outstanding request, enforce the `ts` window and recompute the request hash from their own `{method, params}`. A signed answer for one question cannot be served for another even under a reused `id`.
- Relabelling: `ok` is covered, so a signed `error` cannot be presented as a `result`, and a `result` shaped like `{code, message}` cannot be turned into a `BAD_VOUCHER` that would roll back a client's meter.
- Substitution: `container` is covered, so a signature from service A cannot be presented as service B.
- Malleability: high-`s` signatures are rejected everywhere (envelope, delegation, voucher) so that off-chain acceptance and on-chain `settle()` agree.
- Prototype pollution: JSON with `__proto__`/`constructor`/`prototype` keys is rejected at parse time on both sides, so a verified `result` can be merged into application state safely.
- Transport: `endpoints.live` MUST be `https://`; `http://` is accepted only by clients explicitly configured for development. Everything above assumes an attacker who can read and modify traffic; https is the first line of defence, not the only one.
- Canonicalisation mismatch is the main interoperability risk; implementations MUST use the definition in §3.3 and SHOULD test against the vectors in §6.
- The signer key is hot; see TAP-20 §8 for rotation.

## 9. Copyright

Copyright and related rights waived via CC0-1.0.

---

# TAP-21：TapeAPI：签名响应信封（中文译文）

> 英文为权威文本，本译文与英文章节一一对应。

> **占位编号。** TAP-21 是在 [TapeKit issue #8](https://github.com/TapeOutProtocol/TapeKit/issues/8) 中提议的占位编号。TapeKit 目前还没有编号提案流程（对 TapeOut 本身的修改遵循 TapeKit `SPEC.md` §15），因此维护者可能另行分配编号，或把本文档移入其它流程；见 [TAP-1](TAP-1.md)。

> **实现状态（2026-09-27）：** 运行中：`api.tapeapi.fun`（`11.1013.tape`）与 `relay.tapeapi.fun`（`12.1013.tape`）的每个回答（包括错误）都是由 `server/src/` 签名的 v2 信封；SDK 负责验证。未经第三方审计。

RFC 2119 关键词适用。

## 1. 摘要

定义 TapeAPI 实时端点的 HTTP 请求与响应格式，以及提供者附加于每个响应的签名，使客户端能将结果归属于按 TAP-20 解析出的服务容器。

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

- `id` MUST 回显请求的 `id`。提供者无法解析的请求（畸形 JSON、不是对象、超过请求体上限、`id` 缺失或无效）没有可信的 `id` 或 `params`：以绑定 `id` `""` 与 `params` `{}` 的签名 `BAD_REQUEST` 拒绝（HTTP 400，超限为 413）；`params` 没有规范形式的请求以绑定其自身 `id` 与 `params` `{}` 的签名拒绝（§3.3）。收到在任一绑定下验证通过的 `BAD_REQUEST` 的客户端 MUST 报告自己的请求有误（`BAD_REQUEST`），而不是 `BAD_SIGNATURE`。
- `ok` MUST 为 JSON 布尔值，且在签名范围内（§3.3）。
- `container` MUST 等于服务容器。客户端 MUST 拒绝 `container` 与解析所得容器不一致的响应，且 MUST 用自己解析出的容器（而非信封中的值）计算摘要。
- `ts`：提供者的 Unix 秒级时间。客户端 MUST 拒绝 `|now − ts| > maxSkew`；`maxSkew` 默认 300 秒，MAY 配置。
- `block`：OPTIONAL，提供者使用的链高度，仅供参考，不在签名范围内。
- `error.code` MUST 为 `PAYMENT_REQUIRED`、`BAD_VOUCHER`、`METHOD_NOT_FOUND`、`BAD_REQUEST`、`INTERNAL` 之一。错误码只增不减、不重命名。客户端 MUST 将未知码视为错误。
- `error.data`：OPTIONAL JSON 对象，在签名范围内。由累计值过期引起的 `BAD_VOUCHER` MUST 携带 `data.lastCumulative`（十进制字符串）：提供者对该消费者已接受的最高累计值，包含仍在进行中的调用：`max(本地记录, 在途, claimedOf)`。只要该数字高于 `onChainClaimed`，`data.voucher` MUST 是消费者本人对恰好该数字签发的凭证，以便客户端核验；客户端 MUST NOT 采用高于 `onChainClaimed` 且未经证明的数字。客户端 MAY 采用 `max(本地, lastCumulative)` 并重试一次。
- `INTERNAL` 的消息 MUST NOT 泄露上游细节（RPC URL、密钥、内部主机名）；提供者把细节写入日志，对外返回泛化消息。唯一例外：`INTERNAL` MAY 携带 `error.data.revert`，即提供者所做调用的 `0x` 十六进制 revert 字节（人人可复现的链上状态，在签名范围内），此时 `message` 为 `"execution reverted"`。`INTERNAL` 不得附带其他任何内容。
- 签名信封 MAY 以 HTTP `200` 返回，或以与其错误码对应的状态返回（`PAYMENT_REQUIRED` 与 `BAD_VOUCHER` 为 `402`，`METHOD_NOT_FOUND` 为 `404`，格式错误为 `400`/`413`，`INTERNAL` 为 `500`）。只要响应体是含 `sig` 字段的合法 JSON，客户端 MUST 无视状态码将其解析为信封，并 MUST 先验签再信任。只有这样的响应体才是信封：不含 `sig` 的 JSON（代理或 CDN 的错误页、未签名的路由错误）或非 JSON 的响应体是传输失败（`PROVIDER_UNAVAILABLE`），绝不是 `BAD_SIGNATURE`。
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

除提供者错误码外，客户端 MUST 暴露：`RPC_DISAGREE`、`BAD_SIGNATURE`、`MANIFEST_INVALID`、`DELEGATION_INVALID`、`PROVIDER_UNAVAILABLE`、`RATE_LIMITED`、`PRICE_CHANGED`（价格涨到调用方已同意的价格之上，TAP-20 §3.6）、`QUORUM_FAILED`（一般的多提供者不一致，或可验证的答案过少）以及 `ATTEST_DISAGREE`（TAP-23 §3.4）。参考 SDK 另外使用以下信息性的客户端错误码，实现 MAY 扩展：`NOT_FOUND`（目标处没有服务或文件，TAP-20 §3.6）、`RPC_UNAVAILABLE`（作答节点过少；不同于 `RPC_DISAGREE`）、`RPC_ERROR`（所有作答节点返回同一个 JSON-RPC 错误）、`CANON_INVALID`、`ABI_INVALID`、`BAD_KEY`、`CHANNEL_INVALID`（TAP-26）、`GROUP_INVALID` 与 `GROUP_EQUIVOCATION`（TAP-27）、`TAPESEND_INVALID`（TAP-10 载荷）、`COMPARE_PATH_INVALID`，以及 `BUDGET_EXCEEDED` 与 `USER_DECLINED`（WebMCP 适配器的花费预算与用户确认）。提供者自身的路由错误（未知路径的 `NOT_FOUND`、`METHOD_NOT_ALLOWED`）不签名，对客户端而言是传输失败。参考提供者在自己的委托已过期或尚无委托时发出的未签名 HTTP 503 `DELEGATION_INVALID` 同样如此；它未签名，只是提示，参考 SDK 仅在本地清单副本也显示委托已过期时报告为 `DELEGATION_INVALID`，否则报告为 `PROVIDER_UNAVAILABLE`。这些是客户端错误码：它们都绝不是签名信封中合法的 `error.code`（`RATE_LIMITED` 只出现在下文未签名的 429 响应体中）。`BAD_SIGNATURE` 涵盖所有信封绑定失败（签名、`id`、`container`、请求哈希、`ok`、`ts` 窗口）。遇 `BAD_SIGNATURE` 时，客户端 MUST 在重试前按 TAP-20 §3.6 从步骤 2 起重读清单。若重读所得清单指明的恰是签署该信封的密钥，客户端 MAY 在该信封按重读清单完整验证通过后接受这同一个信封，而不是再次发送请求，以免为提供者已计费的结果付两次钱。由签名失败触发的重读 SHOULD 按服务限频。无法解析为信封的响应（畸形 JSON、无 `sig`、禁用键、超过 1 MiB）为 `PROVIDER_UNAVAILABLE`。

**限流。** 提供者 MAY 在做任何工作之前拒绝请求。此类拒绝 MUST 使用 HTTP 429，带 `Retry-After` 头，body 为 `{ ok: false, error: { code: "RATE_LIMITED", data: { retryAfterS } } }`，且 MUST NOT 签名：它不对任何结果作出断言，而给拒绝签名会让每一次洪水都要提供者付出一次签名。客户端 MUST 把 HTTP 429 视为 `RATE_LIMITED`，且 MUST NOT 对它做信封校验。预算按提供者进程计，不跨实例共享；多台主机承载的服务，每台各有一份预算。为付费调用维护按消费者预算的提供者，MUST 以凭证签名所证明的消费者（TAP-22 §3.2）为键，绝不以请求中原样的 `consumer` 字段为键：未经验证的字段让任何人都能把受害者地址写进验不过的凭证，耗光受害者的预算。未经验证的流量，包括附带凭证调用的免费方法，计入调用方的免费预算。提供者位于代理之后时，限流所用的调用方身份 MUST 来自宿主（例如边缘节点给出的连接 IP）或所配置转发头的**最后**一跳，绝不来自客户端能自己提供的值，例如 `X-Forwarded-For` 的第一项。

进行计费（TAP-22）的客户端 MUST NOT 在收到已验证信封之前推进本地累计值；传输失败释放预留，若提供者实际已消费，下一张凭证通过 `error.data.lastCumulative` 纠正。

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
| 完整信封摘要 + 签名 | `spec/vectors/tap-21-envelope.json`，由 `spec/vectors/verify.py` 独立校验 |

## 7. 参考实现

`sdk/src/canon.js`（规范 JSON）、`sdk/src/sig.js`（摘要与恢复）、`server/src/index.js`（签名）。运行中：`https://api.tapeapi.fun`（源码 `examples/public-api/`）与 `https://relay.tapeapi.fun`（源码 `examples/cloudflare-worker/relay-worker.js`）以此信封签署每个回答。

## 8. 安全考量

- 重放：`id`、`ts` 与请求哈希被覆盖；客户端 MUST 将 `id` 与未完成请求匹配、执行 `ts` 窗口，并用自己的 `{method, params}` 重算请求哈希。即使 `id` 被复用，对一个问题的签名回答也不能被用作另一个问题的回答。
- 改标：`ok` 被覆盖，因此签名的 `error` 不能被当作 `result` 呈现，形如 `{code, message}` 的 `result` 也不能被改成会让客户端回退计费的 `BAD_VOUCHER`。
- 替换：`container` 被覆盖，因此服务 A 的签名不能被当作服务 B 呈现。
- 可延展性：所有地方（信封、委托、凭证）都拒绝高 `s` 签名，使链下接受与链上 `settle()` 一致。
- 原型污染：双方在解析时即拒绝含 `__proto__`/`constructor`/`prototype` 键的 JSON，已验证的 `result` 可以安全地合并进应用状态。
- 传输：`endpoints.live` MUST 为 `https://`；仅显式配置为开发模式的客户端接受 `http://`。以上所有内容都假设攻击者能读取并修改流量；https 是第一道防线，而非唯一防线。
- 规范化不一致是主要的互操作风险；实现 MUST 使用 §3.3 的定义，并 SHOULD 对照 §6 的向量测试。
- 签名密钥是热钥；轮换见 TAP-20 §8。

## 9. 版权

Copyright and related rights waived via CC0-1.0.
