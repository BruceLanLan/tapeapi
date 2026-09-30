# ai-proxy — AI 服务的签名旁路 / a signing sidecar for AI APIs

[中文](#中文) · [English](#english)

规范 / Specification: 清单字段 `ai` 见 [TAPI-20 §3.9](../../spec/TAPI-20.md)，用量回执见 [TAPI-21 §3.5](../../spec/TAPI-21.md)（英文为准）。
The manifest field `ai` is [TAPI-20 §3.9](../../spec/TAPI-20.md); usage receipts are [TAPI-21 §3.5](../../spec/TAPI-21.md).
Test vectors: `sdk/test/fixtures/ai-receipt-vectors.json`.

## 中文

**给谁**：已经在运营 AI 接口的服务方（new-api 这类网关、聚合商、自建开源模型的团队）。
**做什么**：你的接口、密钥体系和计费都不动，在它前面放一个签名旁路（`@tapeapi/server/ai-proxy` 的 `createAIProxy`）。服务方得到：

1. **链上身份**：一枚 TapeOut 电路的容器。谁在回答，查链就知道；换域名、换服务器，用户按链上记录自动跟随。
2. **钉在链上的端点与价目表**：清单字段 `ai: { endpoints, models }`（TAPI-20 §3.9）。每种 API 格式一个端点；每个模型一个 `id`、
   可选的 `aliases`（上游报告的其它名称，如带日期的版本）与 `formats`，以及一个 `prices` 列表，每个币种一项（BEM、BNB、USDT、USDC、ETH、
   USD1，或仅作展示的 USD），每项按每百万 token 给出 `input`、`output`，可选 `cacheRead`、`cacheWrite`、`cacheWrite1h`、`reasoning`。
   **价格只是公示，现在不结算**（按 token 结算属于 TAPI-22 的下一个托管版本）。
3. **每次调用一份签名的用量回执**：模型、各类 token 数、各币种金额、回答是否完整、请求字节的哈希、回应字节的哈希，由链上委托的密钥签成
   TAPI-21 信封（TAPI-21 §3.5）。
4. **调用方不用改代码**：照旧用官方 SDK（OpenAI、Anthropic），只把 base URL 换成清单里对应格式的端点。`/v1/*` 逐字节透传，流式照常逐块到达。

### 支持的格式

| 格式 | 路径 | 客户端的 base URL | 回执方法 | 流的最终事件（回执放在它之前） |
|---|---|---|---|---|
| `openai-chat` | `POST /v1/chat/completions` | `<根>/v1` | `openai_chat` | `data: [DONE]` |
| `openai-responses` | `POST /v1/responses`、`POST /v1/responses/compact` | `<根>/v1` | `openai_responses` | `event: response.completed`（或 `.incomplete`、`.failed`） |
| `anthropic-messages` | `POST /v1/messages` | `<根>`（Anthropic SDK 自己加 `/v1`） | `anthropic_messages` | `event: message_stop` |
| `openai-embeddings` | `POST /v1/embeddings` | `<根>/v1` | `openai_embeddings` | 不流式 |

其它路径（`/v1/models`、`/v1/messages/count_tokens`、`/v1/completions` 等）原样透传，不出回执。每种格式是 SDK 里的一个小适配器
（`sdk/src/ai-*.js`），旁路与核验方用的是同一批；Gemini 以后作为新的适配器加入。

### 本地运行

```sh
npm install --no-audit --no-fund           # 在 tapeapi/ 根目录，一次
node examples/ai-proxy/index.mjs           # :8798，临时 signer；自动在空闲端口启动模拟上游并包裹它
node examples/ai-proxy/client.mjs          # 另一个终端：调用它，并核验每一份回执
```

`fake-upstream.mjs` 是一个**模拟**上游，三种格式都会说（普通与流式），另有 embeddings、count_tokens、models；不调用真实模型、
不需要真实密钥（只认 `sk-demo`），token 数按单词计。它代表**你的**上游，里面没有任何 TapeAPI 的东西。
包裹你自己的上游：`UPSTREAM_BASE_URL=https://your-gateway.example/v1 node examples/ai-proxy/index.mjs`（上游的 `/v1` 基址，
各格式的 `/v1/...` 路径都接在它后面），价目表放在 `models.json`（或用 `MODELS_FILE` 指定）：

```json
[
  { "id": "demo-claude", "aliases": ["demo-claude-20260901"], "formats": ["anthropic-messages"], "prices": [
    { "currency": "BEM", "unit": "1M tokens", "input": "3", "output": "15", "cacheRead": "0.30", "cacheWrite": "3.75", "cacheWrite1h": "6" }
  ] }
]
```

每个 `id` 与别名在整张表里只能出现一次；早期草案的单数 `price` 已经不是字段，写了会被拒绝。

```sh
curl -si http://127.0.0.1:8798/v1/chat/completions -H 'authorization: Bearer sk-demo' -H 'content-type: application/json' \
  -d '{"model":"demo-chat","messages":[{"role":"user","content":"hello"}]}'                        # 回执在 x-tapeapi-receipt 响应头
curl -sN http://127.0.0.1:8798/v1/messages -H 'x-api-key: sk-demo' -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' \
  -d '{"model":"demo-claude","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"hi"}]}'  # 回执在 message_stop 之前的注释块
curl -s -X POST http://127.0.0.1:8798/tapeapi/v1/receipt -H 'content-type: application/json' -d '{"id":"q1","params":{"id":"<响应 id>"}}'
```

### 回执

一个标准 TAPI-21 信封，额外带上签名所覆盖的 `method` 与 `params`，这样只拿到回执也能核验签名（完整规则见 TAPI-21 §3.5）：

```json
{ "id": "msg_…", "ok": true, "container": "0x…", "ts": 1790000000, "method": "anthropic_messages",
  "params": { "path": "/v1/messages", "requestSha256": "<客户端发来的原始请求体字节的 sha256>" },
  "result": { "model": "demo-claude",
              "usage": { "prompt_tokens": 3100, "completion_tokens": 50, "total_tokens": 3150,
                         "cache_read_tokens": 2000, "cache_write_tokens": 1000, "cache_write_1h_tokens": 400 },
              "responseSha256": "…", "stream": true, "complete": true, "status": 200,
              "prices": [ { "currency": "BEM", "amount": "0.00630000" } ], "modelMatchedBy": "response" },
  "sig": "0x…" }
```

- **送达**：整体回答在 `x-tapeapi-receipt` 响应头（信封 JSON 的 base64url）。事件流里，旁路扣住格式的最终事件，签名，先发一个注释块
  `: tapeapi-receipt <base64url>`（SSE 规范规定客户端忽略注释），再放出最终事件；这样读到 `[DONE]` 或 `response.completed` 就停的客户端
  也已经收到回执。流里没有最终事件时，注释追加在末尾。从不使用自定义 `event:` 类型（OpenAI 的 SDK 会把未知事件交给用户代码）。
- **哈希**：非流式是客户端收到的响应体字节的 sha256；流式是按 SSE 规则解析出每个事件的 data，按顺序各加一个 `\n` 拼接
  （不含 `[DONE]`），取 sha256，最终事件也在内，注释（包括回执注释）不在内。`requestSha256` 永远是客户端发来的原始字节。
- **用量**（各格式同一约定）：`prompt_tokens` 是全部输入（含缓存读、缓存写），`completion_tokens` 是全部输出（含推理）；
  `cache_read_tokens`、`cache_write_tokens`、`reasoning_tokens` 是其中的子集，`cache_write_1h_tokens` 是缓存写中保留一小时的部分；
  `other` 是按次计费的计数（如 `web_search_requests`）。
- **金额**（每个币种一项，列在 `prices` 里，顺序与价目表相同）= input ×（prompt − 缓存读 − 缓存写）+ cacheRead × 缓存读
  + cacheWrite ×（缓存写 − 1 小时缓存写）+ cacheWrite1h × 1 小时缓存写 + output ×（completion − 推理）+ reasoning × 推理，
  除以一百万，对总和向上取整一次到 8 位小数，全程整数运算。上例：3 × 100 + 0.30 × 2000 + 3.75 × 600 + 6 × 400 + 15 × 50 = 6300，
  即 `0.00630000`。没写缓存价时按 input 计（`cacheWrite1h` 先按 `cacheWrite`）；没写 reasoning 价时推理 token 按 output 计；
  按次计费的项没有 token 价，计 0，并列在 `result.unpriced` 里。
- **模型匹配**：按上游**报告的** model 在价目表里**精确**匹配 `id` 或某个别名（区分大小写，不做前缀匹配；模型写了 `formats` 时还须包含
  本格式），此时 `modelMatchedBy: "response"`。上游没报 model 时（例如 embeddings）才按请求里的 model 匹配，`modelMatchedBy: "request"`。
  匹配不到就是 `prices: null`，也没有 `modelMatchedBy`（旁路记一次日志）。
- **完整性**：`complete` 表示回答是否完整：整体回答为 2xx 且未被格式标记为未完成；流到达了格式的最终成功事件（Chat 有 `finish_reason`
  且没有 error 块，Responses 为 `response.completed`，Anthropic 为 `message_stop` 且没有 error 事件）。没完成的回答仍按它报告的用量定价。
- **Chat 流的用量**：OpenAI Chat 只有请求设了 `stream_options.include_usage` 才在流里报用量。客户端没设时，旁路替它向上游要，
  再从客户端收到的内容里去掉上游因此多发的那一块，回执里记 `usageInjected: true`；客户端收到的字节（也就是哈希覆盖的）和它要的一样。
- **失败的调用**（401、429、500……）也签名，`usage` 与 `prices` 为 `null`、`complete` 为 `false`：可追责，但不声称用量。
  旁路自己的错误（限流、请求过大、上游不通或超时）不签名、没有回执。

### 调用方怎么核验

```js
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { createTapeAPI, ai } from '@tapeapi/sdk'

const api = createTapeAPI({ rpcUrls: [/* 至少 2 家运营方的 BSC 节点 */] })
const svc = await api.resolve('<#ID>.<processor>.tape')          // 从链上解析：清单字节、委托、signer
const fetch = ai.createVerifyingFetch({ api, service: svc, onReport: (r) => console.log(r.ok, r.receipt?.result.prices) })
const base = (format) => svc.manifest[ai.MANIFEST_FIELD].endpoints.find((e) => e.format === format).baseUrl
const openai = new OpenAI({ baseURL: base('openai-chat'), apiKey: '<服务方给你的密钥>', fetch })
const claude = new Anthropic({ baseURL: base('anthropic-messages'), apiKey: '<服务方给你的密钥>', fetch })
```

包装后的 fetch 保留自己发出的请求字节和收到的回应字节，重算两个哈希，核对签名是不是链上清单指定的 signer、`complete` 是否属实、
金额是不是按价目表算的。任何一项不符都报错（默认：整体回答变成 HTTP 502、code 为 `RECEIPT_INVALID`、带 `x-should-retry: false`，
官方 SDK 抛出 `APIError` 且不重试；流式在流结束时让迭代器抛出 `RECEIPT_INVALID`），不静默吞掉；流的每一块照常到达，
不被延迟。命令行工具（Claude Code 设 `ANTHROPIC_BASE_URL`，Codex 在 `config.toml` 里设 `base_url`）不需要任何改动就能用；它们自己不核验回执：
可以把它们指向本地核验代理 `tapeapi-verify`，或者事后按 id 取回回执再核验。
手里只有一份回执时，可以贴到核验页 `https://tapeapi.fun/verify/`：它核对签名、身份和金额；两个哈希绑定的是确切的请求和回应字节，
页面没有这些字节，除非你一起贴进去。

### 局限（请如实对外说明）

- **签名证明的是谁回答的、声称了什么，而不是实际运行的是哪个模型。** 服务方可以把便宜模型的回答标成贵模型。签名让这种替换
  **可追责**：回执不可抵赖，配合抽检（任何人定期发测试题、公开结果，A9），掺水就留下证据。
- 回执只在签发它的进程（或 Worker 隔离实例）里保留 1 小时、至多 5 万份；随回答送达的那一份才是主要的。
- 不带 `event:` 行的 Responses 流无法在首行认出最终事件，回执改为追加在末尾（读到 `response.completed` 就停的客户端看不到它，可事后取回）。
- 除了替客户端要 usage（只在 Chat 流里加 `include_usage`），旁路不改动发往上游的请求；那时每个 data 事件都要等到完整才转发
  （SSE 客户端本来也要等空行才处理事件）。
- 旁路自己不做鉴权：调用方的密钥原样转给上游，所以旁路只能由服务方自己运营，不交给第三方托管。只转发格式需要的请求头：
  `content-type`、`content-encoding`、`accept`，各格式的鉴权、版本与 beta 头（`authorization`、`x-api-key`、`anthropic-version`、
  `anthropic-beta`、`openai-beta`、`openai-organization`、`openai-project`），以及官方客户端的身份与会话头（`user-agent`、`x-app`、
  `x-claude-code-session-id`、`session-id`、`thread-id`、`originator`、`x-client-request-id`、`x-codex-*`、`x-stainless-*` 等）；
  Cookie、`forwarded`、`x-forwarded-*`、`x-real-ip`、`cf-*` 与逐跳头一律不转发；不跟随重定向；上游地址只由配置决定。
- 上限：请求体 32 MiB，非流式回答 16 MiB；非流式回答须在 600 秒内完成、流须在 600 秒内开始，流静默 300 秒即结束（回执追加在末尾，
  `complete` 为 false）。流不设大小上限，哈希是增量计算的；单个被扣住的事件至多 4 MiB，超过就照常转发、回执追加在末尾；
  单个事件超过 16 MiB 时照样计入哈希，但不再解析，其中的用量读不到。
- 现在不做：WebSocket（Responses 的 WebSocket 模式）、Realtime、Batch、Gemini。上游只能是一个 `/v1` 基址（各格式在同一个上游下）。

### 上线（Cloudflare Worker）

用 `wrangler.toml` 模板（Worker 名 `my-tapeapi-ai-proxy`，不设路由）部署 `worker.js`：
`npx --yes wrangler@4.141.0 deploy -c examples/ai-proxy/wrangler.toml`。把 `UPSTREAM_BASE_URL` 改成你的接口，`MODELS_JSON` 改成你的价目表
（格式同 `models.json`），给 Worker 加你自己的子域名并设为 `PUBLIC_URL`。身份（`CIRCUITS`、`TOKEN_ID`、`CONTAINER`、`DELEGATION_EXPIRES`、
`DELEGATION_SIG`，密钥 `SIGNER_KEY`）按持有人操作台 `https://tapeapi.fun/console/` 设置，与普通 TapeAPI 服务相同；变量设齐之前只回答健康检查。

### 合规说明

本旁路面向**在上游服务条款范围内合规经营**的服务方。身份、价目与信誉在链上，不被任何单一平台绑架；
但本协议**不**提供、也**不**帮助规避上游服务商的封禁或地区限制。

## English

**For** providers already running an AI API (gateways such as new-api, aggregators, teams serving open models).
**What it does**: your API, your key system and your billing stay as they are; a signing sidecar (`createAIProxy` from
`@tapeapi/server/ai-proxy`) goes in front. The provider gets:

1. **An on-chain identity**: a TapeOut circuit's container. Who answered is a chain lookup; move domains or servers and
   users follow the on-chain record.
2. **Endpoints and a price table pinned on chain**: the manifest field `ai: { endpoints, models }` (TAPI-20 §3.9), one
   endpoint per API format. Each model has an `id`, optional `aliases` (other names the upstream reports, such as dated
   versions) and `formats`, and a `prices` list with one entry per currency (BEM, BNB, USDT, USDC, ETH, USD1, or USD for
   display), each giving `input` and `output` per 1M tokens and optionally `cacheRead`, `cacheWrite`, `cacheWrite1h` and
   `reasoning`. **Prices are published, not settled** (per-token settlement belongs to TAPI-22's next escrow version).
3. **A signed usage receipt for every call**: model, token counts by kind, an amount per currency, whether the answer
   completed, and the hashes of the request bytes and of the response bytes, signed as a TAPI-21 envelope by the on-chain
   delegated key (TAPI-21 §3.5).
4. **No code change for callers**: they keep the official SDKs (OpenAI, Anthropic) and only change the base URL to the
   manifest's endpoint for their format. `/v1/*` passes through byte for byte; streams arrive chunk by chunk as before.

### Formats

The table above lists them: `openai-chat` (`/v1/chat/completions`, final event `data: [DONE]`), `openai-responses`
(`/v1/responses` and `/v1/responses/compact`, final event `response.completed|incomplete|failed`), `anthropic-messages`
(`/v1/messages`, base URL without `/v1`, final event `message_stop`) and `openai-embeddings` (never streamed). Other paths
(`/v1/models`, `/v1/messages/count_tokens`, `/v1/completions`, …) pass through without a receipt. Each format is a small
adapter in the SDK (`sdk/src/ai-*.js`), shared by the sidecar and the verifiers; Gemini will come as a further adapter.

### Run it locally

```sh
npm install --no-audit --no-fund           # once, in tapeapi/
node examples/ai-proxy/index.mjs           # :8798, ephemeral signer; starts the fake upstream on a free port and wraps it
node examples/ai-proxy/client.mjs          # in another terminal: calls it and verifies every receipt
```

`fake-upstream.mjs` is a **fake** upstream that speaks all three formats (plain and streamed) plus embeddings,
count_tokens and models: no real model, no real key (it accepts `sk-demo` only), tokens counted as words. It stands
for **your** upstream and knows nothing about TapeAPI. Wrap your own with `UPSTREAM_BASE_URL=https://your-gateway.example/v1`
(the upstream's `/v1` base; every format's `/v1/...` path goes under it); the price table is `models.json` (or
`MODELS_FILE`), shaped as in the example above. Every id and alias appears once in the whole table; the singular `price`
of earlier drafts is no longer a field and is refused. The curl lines above work as they are.

### The receipt

A standard TAPI-21 envelope that also carries the `method` and `params` its signature covers (see the JSON above; the
full rules are TAPI-21 §3.5).

- **Delivery**: whole answers in the `x-tapeapi-receipt` header (base64url of the envelope JSON). In an event stream the
  sidecar holds back the format's final event, signs, sends one comment block `: tapeapi-receipt <base64url>` (SSE
  clients ignore comments), then releases the final event, so a client that stops at `[DONE]` or `response.completed`
  already has the receipt. With no final event the comment is appended at the end. Custom `event:` types are never used
  (OpenAI's SDKs hand unknown events to user code).
- **Hashes**: non-stream, the sha256 of the response body bytes as the client receives them; stream, the sha256 of every
  event's data, parsed by the SSE rules, in order, each followed by `\n`, `[DONE]` left out, the final event included,
  comments (the receipt's too) not included. `requestSha256` is always of the bytes the client sent.
- **Usage** (one convention for every format): `prompt_tokens` is all input (cache reads and writes included),
  `completion_tokens` all output (reasoning included); `cache_read_tokens`, `cache_write_tokens` and `reasoning_tokens`
  are subsets, and `cache_write_1h_tokens` is the part of the cache writes kept for one hour; `other` holds per-use
  counts (e.g. `web_search_requests`).
- **Amount** (one per currency, listed in `prices` in the table's order) = input × (prompt − cache reads − cache writes)
  + cacheRead × cache reads + cacheWrite × (cache writes − 1-hour writes) + cacheWrite1h × 1-hour writes
  + output × (completion − reasoning) + reasoning × reasoning tokens, divided by 1,000,000 and rounded up once to 8
  decimals, in integer arithmetic. The example above: 3 × 100 + 0.30 × 2000 + 3.75 × 600 + 6 × 400 + 15 × 50 = 6300,
  so `0.00630000`. A cache price not given falls back to input (`cacheWrite1h` to `cacheWrite` first); without a
  reasoning price reasoning tokens are output; per-use items have no token price, add 0 and are listed in
  `result.unpriced`.
- **Model matching**: the model the upstream **reported** is matched **exactly** against each entry's `id` and aliases
  (case-sensitive, no prefixes; an entry with `formats` must list this format), giving `modelMatchedBy: "response"`.
  Only when the upstream reported no model (embeddings, for instance) is the request's model matched, giving
  `modelMatchedBy: "request"`. No match gives `prices: null` and no `modelMatchedBy` (logged once).
- **Completeness**: `complete` says whether the answer finished: a 2xx whole answer its format does not mark unfinished,
  or a stream that reached its format's final success event (Chat: a `finish_reason` and no error chunk; Responses:
  `response.completed`; Anthropic: `message_stop` and no error event). An unfinished answer is still priced from the
  usage it reported.
- **Chat stream usage**: OpenAI Chat reports usage in a stream only when the request set `stream_options.include_usage`.
  When the client did not, the sidecar asks the upstream for it, strips the one chunk that adds from what the client
  receives, and records `usageInjected: true`; the client gets, and the hash covers, exactly what it asked for.
- **Failed calls** (401, 429, 500, …) are signed too, with `usage` and `prices` null and `complete` false: attributable,
  no usage claimed. The sidecar's own errors (rate limit, request too large, upstream unreachable or too slow) are
  unsigned and carry no receipt.

### How callers verify

Wrap fetch with `ai.createVerifyingFetch` (snippet above) and give it to the SDK. It keeps the request bytes it sent and
the response bytes it received, recomputes both hashes, and checks that the signer is the one in the on-chain manifest,
that `complete` is true to the answer, and that the amounts follow the price table. Any mismatch is an error (thrown as
`RECEIPT_INVALID` by default; for a stream, the iterator throws when the stream ends), never swallowed; stream chunks
are not delayed. Command-line agents (Claude Code with `ANTHROPIC_BASE_URL`, Codex with `base_url` in `config.toml`)
work unchanged but do not check receipts themselves: point them at the local verifying proxy `tapeapi-verify`, or fetch
receipts by id and check them later. A single receipt can be pasted into `https://tapeapi.fun/verify/`, which checks the
signature, the identity and the amounts; the two hashes bind the exact request and response bytes, which the page does
not have unless you paste them too.

### Limits (say them plainly)

- **A signature proves who answered and what was claimed, not which model actually ran.** A provider could label a
  cheaper model's answer as a dearer one. The signature makes such a substitution **attributable**: receipts cannot be
  disowned, and with spot checks (anyone sending test prompts on a schedule and publishing the results, A9) watering
  down leaves evidence.
- Receipts are kept for 1 hour (`receiptTtlMs`, `RECEIPT_TTL_S` in the Worker), at most 50,000, per (id,
  requestSha256), in the process (or Worker isolate) that signed them; the one delivered with the answer is the primary
  copy. The free `receipt` method has a budget of its own (`receiptRateLimit`, default 10 lookups per client IP per
  minute, `RECEIPT_LOOKUPS_PER_MIN`), answered past it with the unsigned 429 of TAPI-21 §3.4.
- **Guessable answer ids.** The sidecar keeps the upstream's answer id (TAPI-21 §3.5), and some upstreams' ids can be
  guessed: Ollama's OpenAI-compatible API numbers chat ids `chatcmpl-0` to `chatcmpl-998`. Anyone could then walk
  through the ids with the free `receipt` method and read the receipts (model, usage, time and the two hashes). The
  sidecar estimates the ids' randomness and says in its log when they look guessable. Then turn on
  `requireRequestHash` (`RECEIPT_REQUIRE_HASH=1`): a lookup must also name `requestSha256`, the SHA-256 of the request
  body the caller sent, which a stranger who guessed an id does not have. Answers that share an id keep a receipt each;
  a lookup with `requestSha256` picks the right one.
- A Responses stream without `event:` lines cannot be recognised at its first line: its receipt is appended at the end
  (a client that stops at `response.completed` does not see it; it can be fetched by id).
- The only change the sidecar makes to what goes upstream is `include_usage` in a Chat stream request that did not ask
  for usage; then every data event is forwarded once complete (SSE clients wait for the blank line anyway).
- The sidecar authenticates no one: callers' keys go upstream as they are, which is why only the provider itself runs
  its sidecar, never a third-party host. Only the headers the formats need are forwarded: `content-type`,
  `content-encoding`, `accept`; each format's auth, version and beta headers (`authorization`, `x-api-key`,
  `anthropic-version`, `anthropic-beta`, `openai-beta`, `openai-organization`, `openai-project`); and the official
  clients' identity and session headers (`user-agent`, `x-app`, `x-claude-code-session-id`, `session-id`, `thread-id`,
  `originator`, `x-client-request-id`, `x-codex-*`, `x-stainless-*`, …). Never cookies, `forwarded`, `x-forwarded-*`,
  `x-real-ip`, `cf-*` or hop-by-hop headers. Redirects are not followed; the upstream URL comes from configuration only.
- Caps: request body 32 MiB, non-stream answer 16 MiB; a non-stream answer must complete, and a stream must start,
  within 600 s, and a stream silent for 300 s is ended there (receipt appended, `complete` false). Streams have no size
  cap (hashing is incremental); one held event is at most 4 MiB, past which it streams and the receipt is appended; an
  event over 16 MiB is still hashed but not parsed, so a usage inside it is not read.
- Not yet: WebSocket (the Responses WebSocket mode), Realtime, Batch, Gemini. One upstream `/v1` base for all formats.

### Go live (Cloudflare Worker)

Deploy `worker.js` with the `wrangler.toml` template (Worker `my-tapeapi-ai-proxy`, no routes):
`npx --yes wrangler@4.141.0 deploy -c examples/ai-proxy/wrangler.toml`. Set `UPSTREAM_BASE_URL` to your API and
`MODELS_JSON` to your price table (shaped like `models.json`), add a hostname of yours and set it as `PUBLIC_URL`. The
identity (`CIRCUITS`, `TOKEN_ID`, `CONTAINER`, `DELEGATION_EXPIRES`, `DELEGATION_SIG`, secret `SIGNER_KEY`) is set as the
holder console at `https://tapeapi.fun/console/` shows, as for any TapeAPI service; until it is complete only the health
check answers.

### Compliance

This sidecar is for providers operating **within their upstream providers' terms**. Identity, prices and reputation
live on chain, where no single platform can hold them hostage; the protocol does **not** offer, and does not help with,
evading an upstream provider's bans or regional restrictions.
