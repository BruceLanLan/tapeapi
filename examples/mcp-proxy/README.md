# mcp-proxy — Tape out 你的 MCP 服务器

**给谁**：已经有一个 MCP 服务器（Streamable HTTP）的作者。
**做什么**：保留你自己的服务器和域名，在它前面放一个签名代理。代理给它三样东西：

1. **链上身份**：一枚 TapeOut 电路的容器。谁在回答，查链就知道。
2. **钉在链上的工具定义**：清单里的 `mcp.toolsSha256` 是全部工具定义（name、title、description、inputSchema、outputSchema、annotations）
   规范 JSON 的 sha256。工具被偷偷改掉（MCP 的 "rug pull"），客户端一比对就发现，代理自己也会拒绝服务。
3. **每个结果都签名**：每次 tools/call 的结果都是 TAP-21 信封，由链上委托的密钥签名，附带任何人事后都能核验的回执。

代理由 `@tapeapi/server/mcp-proxy` 的 `createMcpProxy` 实现。每个上游工具变成一个免费的清单方法，方法的处理函数把 tools/call
转发给上游，所以签名信封、限流、健康检查和 `/.well-known/tapeapi.json` 都来自 `createProvider`。对外有三条路由：

| 路由 | 是什么 |
|---|---|
| `GET /.well-known/tapeapi.json` | 清单：身份字段 + 由工具生成的 `methods` + `mcp: { endpoint, toolsSha256 }` |
| `POST /tapeapi/v1/<工具名>` | 签名调用：`{ id, params }` → TAP-21 信封，`result` 是上游的 CallToolResult 去掉 `_meta` |
| `POST /mcp` | 远程 MCP（Streamable HTTP，无状态）：`tools/list` 原样返回上游工具；`tools/call` 返回上游内容，加一行来源说明，`_meta` 里放回执 |

## 本地运行

```sh
npm install --no-audit --no-fund          # 在 tapeapi/ 根目录，一次
node examples/mcp-proxy/index.mjs         # :8796，临时 signer；自动在空闲端口启动演示服务器 demo-server.mjs 并包裹它
```

`demo-server.mjs` 代表**你的**服务器：两个工具（`add`、`shout`），用 SDK 的 MCP 核心写成，里面没有任何 TapeAPI 的东西。
包裹你自己的服务器：`UPSTREAM_URL=https://your-server.example/mcp node examples/mcp-proxy/index.mjs`；
服务器要求鉴权时再设 `UPSTREAM_AUTHORIZATION="Bearer ..."`（由运营者设置的固定头，调用方的请求头永远不会转发给上游）。

```sh
curl -s http://127.0.0.1:8796/.well-known/tapeapi.json
curl -s -X POST http://127.0.0.1:8796/tapeapi/v1/add -H 'content-type: application/json' -d '{"id":"1","params":{"a":2,"b":40}}'
curl -s -X POST http://127.0.0.1:8796/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"shout","arguments":{"text":"hi","times":2}}}'
```

## 上线：加身份，用持有人操作台发布

1. **部署代理。** 用 `wrangler.toml` 模板（Worker 名 `my-tapeapi-mcp-proxy`，不设路由）部署 `worker.js`：
   `npx --yes wrangler@4.141.0 deploy -c examples/mcp-proxy/wrangler.toml`。把 `UPSTREAM_URL` 改成你的服务器，
   在后台给 Worker 加你自己的子域名，并把 `PUBLIC_URL` 设为它。设置模式与 `examples/cloudflare-worker` 相同：
   身份变量设齐之前只回答 `/tapeapi/v1/health`，其中给出由 `SIGNER_KEY` 推导的签名地址。
2. **加身份。** 铸一枚电路并开通容器，然后在持有人操作台（`https://tapeapi.fun/console/`）里填你的代理网址，
   签委托，把 `CIRCUITS`、`TOKEN_ID`、`CONTAINER`、`DELEGATION_EXPIRES`、`DELEGATION_SIG` 设进 Worker 变量，`SIGNER_KEY` 设为密钥。
   这一部分与普通 TapeAPI 服务完全一样。
3. **发布清单。** 操作台读取代理的 `/.well-known/tapeapi.json`。清单里有 `mcp` 时，操作台自己去 `mcp.endpoint` 取 tools/list、
   算摘要，必须与代理报出的 `toolsSha256` 一致；签名前向你展示每个工具的名字和描述，发布的清单里带上这个字段。
4. **钉住摘要。** 把发布的 `mcp.toolsSha256` 设为 Worker 变量 `TOOLS_SHA256`。Worker 的隔离实例随时会被回收重建；
   不设这个变量，新实例会把启动时读到的工具当作"已发布"，设了它，被改过的工具在新实例上也会被拒绝。

**改工具 = 重新发布。** 上游工具定义一变（描述改一个字也算），代理在距上次读取超过 60 秒后的第一个请求时（tools/list 则是每次，同一秒内的合并为一次读取）重读工具、发现摘要不一致，
从此每次调用都得到**签名的** `TOOLS_CHANGED` 拒绝，`/mcp` 的 tools/list 返回 JSON-RPC 错误，健康检查 `ok: false`，日志大声报警。
恢复办法（顺序要对）：先把 `TOOLS_SHA256` 改成新摘要（拒绝信息里的 `current`，也显示在 `/tapeapi/v1/health`）或删掉它，重启或重新部署代理；再用操作台重新发布；最后把 `TOOLS_SHA256` 设为刚发布的值。`TOOLS_SHA256` 还是旧值时，代理不会提供工具列表，操作台也就无法发布。

## 客户端核对什么

- **工具定义**：从链上解析服务，读到清单里的 `mcp.toolsSha256`；从 `mcp.endpoint` 取 tools/list，用 `mcp.toolsDigest` 算摘要，不一致就拒绝。
- **每个结果**：调用走 `/tapeapi/v1/<工具名>`，由 SDK 核验信封签名（签名者必须是清单委托的 signer，绑定本次请求的 id 与参数）。
  上游工具自己报错（`isError: true`）时信封仍是 `ok: true`：签名证明的是"上游这样回答了"。只有代理自己拒绝时才是 `ok: false`。
- **回执**：`/mcp` 的结果在 `_meta["fun.tapeapi/receipt"]` 里带回执，来源说明里有核验链接，任何人都能在 `https://tapeapi.fun/verify/` 对照链上重新核验。

## 错误码

| 情况 | 信封 |
|---|---|
| 工具定义漂移 | `ok: false`，`TOOLS_CHANGED`，`data: { published, current }`，HTTP 200 |
| 上游不可达、超时、回答超过 1 MiB、回答格式不对 | `ok: false`，`INTERNAL`，`"internal error"`（细节只进日志） |
| 上游说参数不对（JSON-RPC -32602）、缺少必填参数 | `ok: false`，`BAD_REQUEST` |
| 上游工具返回 `isError: true` | `ok: true`，`result.isError: true` |

## 限制

- 只代理**工具**，全部免费（`priceBEM "0"`）。resources、prompts 不代理；不提供服务器推送流（GET `/mcp` 回 405），
  sampling、elicitation、进度通知都不转发；上游的 `instructions` 不转发（它不在摘要里，不能让它悄悄影响模型）。
- 上游必须说 Streamable HTTP（或在 Node 里以进程内 `{ call }` 接入）；stdio 服务器需要先桥接成 HTTP。
- 工具名必须符合 `[A-Za-z_][A-Za-z0-9_]{0,63}`。不符合的工具仍出现在 tools/list 里（摘要覆盖全部上游工具），但不能经代理调用，启动日志和 `stats().skipped` 会列出。
- 清单里方法的 `description` 合成一行并截到 256 个码点（TAP-20 的上限），完整文本由 `toolsSha256` 钉住；`params` 只是说明，
  名字不是普通字段（`[A-Za-z_][A-Za-z0-9_]{0,63}`）的属性和第 32 个之后的属性不写进去（启动日志会列出），以 MCP 的 inputSchema 为准。
  整个清单不超过 64 KiB；持有人操作台一笔交易最多发布 24 000 字节、64 个方法，超出时启动日志会提醒。
- 上游单次回答上限 1 MiB、20 秒；签名信封上限 1 MiB。限流按进程（Worker 按隔离实例）计。
- 签名证明的是"这个服务的委托密钥收到了上游的这个回答"，不证明回答内容正确；你代理的是谁，你就为谁担保。

---

# mcp-proxy — tape out your MCP server

**For**: authors who already run an MCP server (Streamable HTTP).
**What**: keep your server and your domain, and put a signing proxy in front of it. The proxy adds three things:

1. **An on-chain identity**: a TapeOut circuit's container. Who is answering is a chain lookup.
2. **Tool definitions pinned on chain**: the manifest's `mcp.toolsSha256` is the sha256 of the canonical JSON of every
   tool definition (name, title, description, inputSchema, outputSchema, annotations). A tool changed behind the users'
   backs (an MCP "rug pull") shows up as a mismatch for every client, and the proxy itself stops serving.
3. **Every result signed**: each tools/call result is a TAP-21 envelope signed by the on-chain delegated key, with a
   receipt anyone can verify later.

The proxy is `createMcpProxy` from `@tapeapi/server/mcp-proxy`. Each upstream tool becomes a free manifest method whose
handler forwards tools/call upstream, so signed envelopes, rate limits, health and `/.well-known/tapeapi.json` are
`createProvider`'s own. Three routes face the world:

| route | what it is |
|---|---|
| `GET /.well-known/tapeapi.json` | the manifest: identity fields + `methods` generated from the tools + `mcp: { endpoint, toolsSha256 }` |
| `POST /tapeapi/v1/<tool>` | signed call: `{ id, params }` → TAP-21 envelope whose `result` is the upstream CallToolResult minus `_meta` |
| `POST /mcp` | remote MCP (Streamable HTTP, stateless): `tools/list` returns the upstream tools verbatim; `tools/call` returns the upstream content plus a provenance line, with the receipt in `_meta` |

## Run it locally

```sh
npm install --no-audit --no-fund          # once, in the tapeapi/ root
node examples/mcp-proxy/index.mjs         # :8796, ephemeral signer; starts demo-server.mjs on a free port and wraps it
```

`demo-server.mjs` stands for YOUR server: two tools (`add`, `shout`) written on the SDK's MCP core, with nothing about
TapeAPI in it. To wrap your own server: `UPSTREAM_URL=https://your-server.example/mcp node examples/mcp-proxy/index.mjs`;
if it needs authentication, also set `UPSTREAM_AUTHORIZATION="Bearer ..."` (a fixed header the operator sets; a caller's
request headers are never forwarded upstream). The curl lines above work unchanged.

## Going live: add identity, publish with the holder console

1. **Deploy the proxy.** Deploy `worker.js` with the `wrangler.toml` template (Worker `my-tapeapi-mcp-proxy`, no
   routes): `npx --yes wrangler@4.141.0 deploy -c examples/mcp-proxy/wrangler.toml`. Point `UPSTREAM_URL` at your
   server, add a subdomain of yours to the Worker in the dashboard and set `PUBLIC_URL` to it. Setup mode is the one in
   `examples/cloudflare-worker`: until the identity variables are set it answers only `/tapeapi/v1/health`, which names
   the signer address derived from `SIGNER_KEY`.
2. **Add identity.** Mint a circuit and open its container, then enter the proxy's URL in the holder console
   (`https://tapeapi.fun/console/`), sign the delegation, and set `CIRCUITS`, `TOKEN_ID`, `CONTAINER`,
   `DELEGATION_EXPIRES`, `DELEGATION_SIG` as Worker variables and `SIGNER_KEY` as a secret. This part is exactly as for
   any TapeAPI service.
3. **Publish the manifest.** The console reads the proxy's `/.well-known/tapeapi.json`. When it has an `mcp` field, the
   console fetches tools/list from `mcp.endpoint` itself and computes the digest, which must equal the `toolsSha256`
   the proxy reports; it shows you every tool's name and description before you sign, and the published manifest
   carries the field.
4. **Pin the digest.** Set the Worker variable `TOOLS_SHA256` to the `mcp.toolsSha256` you published. Worker isolates
   are recycled at any time; without the variable a new isolate takes the tools it reads at start-up as "published",
   with it a changed tool is refused on a new isolate too.

**Changing a tool means republishing.** Once the upstream tool definitions change (one word of a description is
enough), the proxy notices on the first request more than 60 s after its last read (on every tools/list, with the
lists of one second sharing one read); re-reads are request-driven, not timed. From then on every call gets a **signed**
`TOOLS_CHANGED` refusal, tools/list on `/mcp` is a JSON-RPC error, health says `ok: false`, and the log shouts. To
recover, in this order: set `TOOLS_SHA256` to the new digest (the `current` value in the refusal, also on
`/tapeapi/v1/health`) or remove it, and restart or redeploy the proxy; republish with the console; then set
`TOOLS_SHA256` to the digest you published. While `TOOLS_SHA256` still names the old digest the proxy serves no tool
list, so the console cannot publish.

## What clients check

- **Tool definitions**: resolve the service on chain and read `mcp.toolsSha256` from its manifest; fetch tools/list
  from `mcp.endpoint`, compute `mcp.toolsDigest`, refuse a mismatch.
- **Every result**: calls go to `/tapeapi/v1/<tool>`, and the SDK verifies the envelope (signed by the manifest's
  delegated signer, bound to this request's id and params). An upstream tool error (`isError: true`) is still
  `ok: true`: the signature says "the upstream answered this". Only the proxy's own refusals are `ok: false`.
- **Receipts**: `/mcp` results carry a receipt in `_meta["fun.tapeapi/receipt"]` and a verification link in the
  provenance line; anyone can re-check it against the chain at `https://tapeapi.fun/verify/`.

## Error codes

| case | envelope |
|---|---|
| tool definitions drifted | `ok: false`, `TOOLS_CHANGED`, `data: { published, current }`, HTTP 200 |
| upstream unreachable, too slow, answer over 1 MiB or malformed | `ok: false`, `INTERNAL`, `"internal error"` (details go to the log only) |
| upstream rejects the arguments (JSON-RPC -32602), a required argument is missing | `ok: false`, `BAD_REQUEST` |
| the upstream tool returns `isError: true` | `ok: true`, `result.isError: true` |

## Limits

- **Tools** only, all free (`priceBEM "0"`). Resources and prompts are not proxied; there is no server-to-client stream
  (GET `/mcp` is 405), and sampling, elicitation and progress notifications are not relayed. The upstream's
  `instructions` are not relayed either: they are not in the digest, so they must not steer the model unseen.
- The upstream must speak Streamable HTTP (or, in Node, be wired in-process as `{ call }`); a stdio server needs an HTTP
  bridge first.
- Tool names must match `[A-Za-z_][A-Za-z0-9_]{0,63}`. Other tools still appear in tools/list (the digest covers every
  upstream tool) but cannot be called through the proxy; the start-up log and `stats().skipped` name them.
- A method's `description` in the manifest is made one line and clipped to 256 code points (TAP-20's limit); the full
  text is pinned by `toolsSha256`. `params` are informative: a property whose name is not a plain field
  (`[A-Za-z_][A-Za-z0-9_]{0,63}`), and any past the 32nd, is left out (the start-up log names them); the MCP inputSchema
  is authoritative. The whole manifest stays under 64 KiB; the holder console publishes at most 24 000 bytes and 64
  methods in one transaction, and the start-up log warns past either.
- One upstream answer: at most 1 MiB and 20 s; a signed envelope: at most 1 MiB. Rate limits are per process (per
  isolate on Workers).
- The signature proves "this service's delegated key received this answer from the upstream", not that the answer is
  right: you vouch for the server you proxy.
