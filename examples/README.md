# 示例索引 / Examples

所有示例都在 `tapeapi/` 根目录下运行（先 `npm install --no-audit --no-fund` 一次），只依赖 Node 20+、`@tapeapi/server`、`@tapeapi/sdk`，不装新的 npm 包。
每个示例都是 `manifest.json`（`dev: true`、`delegation: null`）+ `index.mjs` + 中英 README，不设 `SIGNER_KEY` 时用临时 signer（私钥不打印；设置了 `DELEGATION_SIG` 而没有 `SIGNER_KEY` 会拒绝启动）。
免费方法直接 curl 即可；收费方法在 dev 模式下会返回签名的错误信封（清单里的 escrow 是占位符），本地调试加 `FREE_ALL=1`。
消费者端：`createTapeAPI({ dev: true })` 才能 `resolve({ dev: url })` 与 http 端点；主网至少给 2 个 `rpcUrls`（少于 quorum 会抛错，除非 `allowSingleNode: true`）。
读链的示例省略 `block` 时钉 `finalized`、按 blockHash（EIP-1898）读取，并总是把块写进结果；多提供者 `callQuorum` 时把第一次拿到的块号显式传给每一家。
**块锚定的方法可以进 `callQuorum`，`[no-quorum]` 的方法不行**：每个清单方法的 `description` 都以 `[quorum]` 或 `[no-quorum]` 开头，后者（`latest` 模式、带随机 `quoteId` 的报价、带 `expires` 的签名承诺）放进 `callQuorum` 必然 `QUORUM_FAILED`，各示例 README 有方法表。
跨源的派生数值（不同池的 TWAP 价格）可以用 `callQuorum` 的 `compare: { relTolBps, paths }` 做有界比较；**TAP-23 的 Attested Read 与仓位健康度必须逐字节相等，不要用容差**。
单个提供者的签名响应是一个 single-source feed：按 Chainlink 自己的要求，消费它的协议必须外加界限、熔断、新鲜度检查与 kill switch。四个 DeFi 示例的 README 各有一节「什么时候不要用这个」。
共用代码在 [`_lib/`](./_lib/)：`chain.mjs`（锚定区块、按 blockHash 求值、多链读取器）、`service.mjs`（环境变量、清单占位符、启动与关闭）、`codec.mjs`（手写 ABI 编解码）；三者都有单测。`reader-service` 刻意不用 `service.mjs`，那层外壳要摊开给新人看。
消费者端的复制粘贴片段见 [consumer-snippets.md](./consumer-snippets.md)。
示例里的委托签名，其 EIP-712 域锚定在 **DeWebHub**（`verifyingContract = DeWebHub`），不是锚定在 ServiceDirectory 上；见 [TAP-20 §3.4](../spec/TAP-20.md)。这也是为什么在任何目录部署之前，服务就已经可以被解析和验签。
其它文档从哪里找：[`../docs/README.md`](../docs/README.md)（文档地图）· [`../CONTRIBUTING.md`](../CONTRIBUTING.md)（参与方式）· [`../SECURITY.md`](../SECURITY.md)（漏洞报告）。

| 示例 | 给谁 | 演示什么 | 运行 |
|---|---|---|---|
| [reader-service](./reader-service/) | 所有人（最小 provider） | `blockNumber` / `circuitHolder` / `bemBalance`，签名信封，委托签名脚本 | `node examples/reader-service/index.mjs` (:8787) |
| [web2-adapter](./web2-adapter/) | Web2 企业（SaaS、数据商、AI 商） | 一份 `adapter.config.json` 把现有 REST 端点变成 TapeAPI 方法；上游 API Key 走环境变量；`consumer.mjs` 走完免费 + 付费（voucher）流程 | `node examples/web2-adapter/index.mjs` (:8788)，`node examples/web2-adapter/consumer.mjs` |
| [defi-price-oracle](./defi-price-oracle/) | DeFi 协议 / 前端 | 读 PancakeSwap V2 `getReserves()`，quorum 2 节点一致，默认钉 `finalized`、按 blockHash 读，`blockPinned` 区块锚定；前端用 `callQuorum` 跨两个提供者取无委员会价格 | `node examples/defi-price-oracle/index.mjs` (:8789) |
| [gaming-leaderboard](./gaming-leaderboard/) | 游戏 | 玩家钱包签分数/存档（`TAPI-game/score/v1`），nonce 防重放，内存 + JSON 落盘；容器即存档槽的路线 | `node examples/gaming-leaderboard/index.mjs` (:8790)，`node examples/gaming-leaderboard/player.mjs` |
| [chain-attested-read](./chain-attested-read/) | 公链 / L2 | TAP-23：对 Ethereum / Base 做 quorum `eth_call`（默认 `finalized`，EIP-1898 按 blockHash 求值），返回 `{chainId, blockNumber, blockHash, blockRef, result}`；BSC 应用按 ETH NFT 持有资格放行 | `node examples/chain-attested-read/index.mjs` (:8791) |
| [defi-lending-health](./defi-lending-health/) | 清算机器人（监控通道）/ 风控面板 / 借贷前端 | Venus Core Pool 仓位健康度：`getAssetsIn` + `getAccountSnapshot` + `markets` + 预言机价格经 Multicall3 批量、同一锚定块求值；权重用**清算阈值**而非抵押系数；`liquidatable` 取链上 `shortfall`；`[no-quorum]` 的 `latest` 快通道 | `node examples/defi-lending-health/index.mjs` (:8792) |
| [defi-twap-oracle](./defi-twap-oracle/) | 需要抗操纵价格的协议 | PancakeSwap V3 `observe(uint32[])` 算术平均 tick + 现价 + 偏离标志；`observe`/`slot0` 的 `int24`/`int56` 手写编解码；发 `observe` 前先算实际可用窗口做降级；`callQuorum` 的 ±1% 有界比较演示 | `node examples/defi-twap-oracle/index.mjs` (:8793) |
| [defi-rfq-solver](./defi-rfq-solver/) | TAP-24 Solver 实现者 | EIP-712 签名报价骨架（**无真实库存、无做市、无风控**）：typehash 自检、digest、签名恢复、过期语义；`quote` 是 `[no-quorum]`，`solver` 与清单 `signer` 是两把不同的钥匙 | `node examples/defi-rfq-solver/index.mjs` (:8794) |
| [defi-portfolio-read](./defi-portfolio-read/) | 多链组合 / TAP-23 消费者 | 一个地址在 BSC / Ethereum / Base 上的原生币与 ERC-20 余额、V2 LP 份额、V3 NFT 仓位；**每条链各自锚定一个区块**，字段按 TAP-23 §3.3 扁平化；清单带 `attestedRead` 方法档案 | `node examples/defi-portfolio-read/index.mjs` (:8795) |
| [mcp-proxy](./mcp-proxy/) | 已有 MCP 服务器（Streamable HTTP）的作者 | 放在你的 MCP 服务器前面的签名代理（`createMcpProxy`）：链上身份、清单里 `mcp.toolsSha256` 钉住工具定义、每个结果签名；`/mcp` 与 `/tapeapi/v1/<工具名>` 两种入口；工具定义漂移时一律签名拒绝（`TOOLS_CHANGED`）；`demo-server.mjs` 是被包裹的演示服务器，`worker.js` + `wrangler.toml` 是 Cloudflare Worker 版 | `node examples/mcp-proxy/index.mjs` (:8796)，包裹你自己的服务器加 `UPSTREAM_URL=...` |
| [ai-proxy](./ai-proxy/) | 运营 AI 接口的服务方（网关、聚合商、自建模型） | 放在你的 AI 接口前面的签名旁路（`createAIProxy`）：OpenAI Chat、OpenAI Responses、Anthropic Messages、Embeddings 原样透传，每次调用附一份签名的用量回执（模型、token、价格、请求与回应的哈希）；清单 `ai` 字段钉住端点与价目表；`fake-upstream.mjs` 是模拟上游（无真实模型与密钥），`client.mjs` 演示客户端核验，`worker.js` + `wrangler.toml` 是 Cloudflare Worker 版 | `node examples/ai-proxy/index.mjs` (:8798)，再 `node examples/ai-proxy/client.mjs`；包裹你自己的上游加 `UPSTREAM_BASE_URL=...` |
| [relay-trial](./relay-trial/) | 还没花钱、想先看效果的中转站 | 本地试跑：一条命令在本机起签名旁路、模拟上游与本地清单，跑 `tapeapi-doctor`、带核验的调用、`tapeapi-verify` 与篡改演示；不需要密钥、电路，也不花钱 | `node examples/relay-trial/trial.mjs` |
| [new-api-sidecar](./new-api-sidecar/) | 用 new-api 开中转站的服务方 | 一条 `docker compose up -d` 把签名旁路放在 new-api 前面：new-api 照常运行，用户照常调用，每次调用附一份签名的用量回执；旁路由你自己运行（它会经手用户的密钥） | 填好 `env.example` 与 `models.example.json` 后 `docker compose up -d`；不装 Docker 可以先跑 `node examples/new-api-sidecar/smoke.mjs` |
| [litellm-sidecar](./litellm-sidecar/) | 用 LiteLLM Proxy 运营 AI 接口的团队 | 一条 `docker compose up -d` 把签名旁路放在 LiteLLM 前面（LiteLLM 官方镜像钉住 v1.103.0，带 PostgreSQL）：LiteLLM 的模型、虚拟密钥与预算照旧，用户照常调用，每次调用附一份签名的用量回执；价目表的 `id` 就是 LiteLLM 的 `model_name`；`e2e.mjs` 对真实 LiteLLM 用官方 SDK 核验 | 填好 `env.example`、`config.example.yaml`、`models.example.json` 后 `docker compose up -d`；不装 Docker 可以先跑 `node examples/litellm-sidecar/smoke.mjs` |
| [group-chat](./group-chat/) | 要加群聊的应用（TAP-27） | 公共中继上的最小群聊：两个临时身份，群主用 `deliverGroupUpdate` 一次投递纪元消息（群房间）与邀请（成员的收件房间），成员用 `checkGroupInvites` 收到邀请、入群、双方互发消息；演示用 `trust-roster`，正式应用必须用 `api.groupVerifier()` | `node examples/group-chat/index.mjs` |
| [demo-site](./demo-site/) | 前端 | 浏览器里（DeWEB 相对路径）解析清单、调用、校验签名 | 用任意静态服务器托管 `tapeapi/`，打开 `examples/demo-site/index.html` |

---

All examples run from the `tapeapi/` root (`npm install --no-audit --no-fund` once) and depend only on Node 20+, `@tapeapi/server` and `@tapeapi/sdk` — no new npm packages.
Each is a `manifest.json` (`dev: true`, `delegation: null`) + `index.mjs` + a Chinese/English README, and uses an ephemeral signer unless `SIGNER_KEY` is set (the key is never printed; with `DELEGATION_SIG` set and no `SIGNER_KEY` the example refuses to start).
Free methods work with a plain curl; paid methods return a signed error envelope in dev mode (the manifest's escrow is a placeholder) — set `FREE_ALL=1` to debug locally.
Consumer side: `createTapeAPI({ dev: true })` is required to `resolve({ dev: url })` and to accept http endpoints; on mainnet pass at least 2 `rpcUrls` (fewer than `quorum` throws unless `allowSingleNode: true`).
The chain-reading examples pin `finalized` when `block` is omitted, evaluate by blockHash (EIP-1898) and always return the block; for multi-provider `callQuorum` pass the block number from the first answer explicitly to every provider.
**Block-pinned methods can go through `callQuorum`; `[no-quorum]` methods cannot.** Every manifest method's `description` starts with `[quorum]` or `[no-quorum]`; the latter (`latest` mode, quotes with a random `quoteId`, signed commitments carrying an `expires`) will always `QUORUM_FAILED` in a quorum — each README has a method table.
Derived cross-source numbers (TWAP prices from different pools) can use `callQuorum`'s `compare: { relTolBps, paths }` for a bounded comparison; **TAP-23 Attested Reads and position health must match byte for byte — do not use a tolerance there**.
One provider's signed response is a single-source feed: by Chainlink's own standard, a protocol consuming it must still add value bounds, circuit breakers, freshness checks and a kill switch. Each of the four DeFi examples has a “when not to use this” section.
Shared code lives in [`_lib/`](./_lib/): `chain.mjs` (block pinning, blockHash evaluation, multi-chain readers), `service.mjs` (environment, manifest placeholders, start-up and shutdown) and `codec.mjs` (hand-rolled ABI codecs); all three have unit tests. `reader-service` deliberately does not use `service.mjs` — a newcomer should see that shell spelled out.
Copy-paste consumer code is in [consumer-snippets.md](./consumer-snippets.md).
The delegation signature used by these examples has its EIP-712 domain anchored on the **DeWebHub** (`verifyingContract = DeWebHub`), not on a ServiceDirectory — see [TAP-20 §3.4](../spec/TAP-20.md). That is what lets a service resolve and verify before any directory is deployed.
Where the other documents are: [`../docs/README.md`](../docs/README.md) (document map) · [`../CONTRIBUTING.md`](../CONTRIBUTING.md) (how to contribute) · [`../SECURITY.md`](../SECURITY.md) (reporting vulnerabilities).

| example | who it is for | what it demonstrates | run |
|---|---|---|---|
| [reader-service](./reader-service/) | everyone (minimal provider) | `blockNumber` / `circuitHolder` / `bemBalance`, signed envelopes, the delegation-signing script | `node examples/reader-service/index.mjs` (:8787) |
| [web2-adapter](./web2-adapter/) | Web2 companies (SaaS, data, AI vendors) | one `adapter.config.json` turns existing REST endpoints into TapeAPI methods; upstream API key from env; path params are encoded and origin/prefix-checked (`adapter.test.mjs`); `consumer.mjs` walks the free + paid (voucher) path | `node examples/web2-adapter/index.mjs` (:8788), `node examples/web2-adapter/consumer.mjs` |
| [defi-price-oracle](./defi-price-oracle/) | DeFi protocols / front-ends | PancakeSwap V2 `getReserves()` with quorum 2, pinned to `finalized` by default and read by blockHash, `blockPinned` anchoring; front-end uses `callQuorum` across two providers for a committee-free price | `node examples/defi-price-oracle/index.mjs` (:8789) |
| [gaming-leaderboard](./gaming-leaderboard/) | games | wallet-signed scores/saves (`TAPI-game/score/v1`), nonce replay protection, in-memory + JSON persistence; the container-as-save-slot roadmap | `node examples/gaming-leaderboard/index.mjs` (:8790), `node examples/gaming-leaderboard/player.mjs` |
| [chain-attested-read](./chain-attested-read/) | public chains / L2s | TAP-23: quorum `eth_call` on Ethereum / Base (default `finalized`, EIP-1898 evaluation by blockHash) returning `{chainId, blockNumber, blockHash, blockRef, result}`; a BSC app gated on Ethereum NFT ownership | `node examples/chain-attested-read/index.mjs` (:8791) |
| [defi-lending-health](./defi-lending-health/) | liquidation bots (the monitoring channel), risk dashboards, lending front-ends | Venus Core Pool account health: `getAssetsIn` + `getAccountSnapshot` + `markets` + oracle prices batched through Multicall3 at one pinned block; weights by the **liquidation threshold**, not the collateral factor; `liquidatable` comes from the chain's `shortfall`; plus a `[no-quorum]` `latest` fast path | `node examples/defi-lending-health/index.mjs` (:8792) |
| [defi-twap-oracle](./defi-twap-oracle/) | protocols that need a manipulation-resistant price | PancakeSwap V3 `observe(uint32[])` arithmetic-mean tick + spot + deviation flag; hand-rolled `int24`/`int56` codecs for `observe`/`slot0`; computes the actually-available window before sending `observe` and degrades on it; demonstrates `callQuorum`'s ±1% bounded comparison | `node examples/defi-twap-oracle/index.mjs` (:8793) |
| [defi-rfq-solver](./defi-rfq-solver/) | TAP-24 Solver implementers | an EIP-712 signed-quote skeleton (**no real inventory, no market making, no risk management**): typehash self-check, digest, signature recovery, expiry semantics; `quote` is `[no-quorum]`, and the `solver` key is not the manifest `signer` key | `node examples/defi-rfq-solver/index.mjs` (:8794) |
| [defi-portfolio-read](./defi-portfolio-read/) | multi-chain portfolios, TAP-23 consumers | one address's native and ERC-20 balances, V2 LP share and V3 NFT positions across BSC / Ethereum / Base, **each chain pinned to its own block**, with the TAP-23 §3.3 flat block fields and an `attestedRead` method profile in the manifest | `node examples/defi-portfolio-read/index.mjs` (:8795) |
| [mcp-proxy](./mcp-proxy/) | authors of an existing MCP server (Streamable HTTP) | a signing proxy in front of your MCP server (`createMcpProxy`): on-chain identity, tool definitions pinned by `mcp.toolsSha256` in the manifest, every result signed; both `/mcp` and `/tapeapi/v1/<tool>`; every call refused, signed, when the tool definitions drift (`TOOLS_CHANGED`); `demo-server.mjs` is the demo server it wraps, `worker.js` + `wrangler.toml` the Cloudflare Worker version | `node examples/mcp-proxy/index.mjs` (:8796); add `UPSTREAM_URL=...` to wrap your own server |
| [ai-proxy](./ai-proxy/) | providers running an AI API (gateways, aggregators, self-hosted models) | a signing sidecar in front of your AI API (`createAIProxy`): OpenAI Chat, OpenAI Responses, Anthropic Messages and Embeddings passed through byte for byte, each call with a signed usage receipt (model, tokens, price, hashes of the request and response); the manifest's `ai` field pins the endpoints and the price table; `fake-upstream.mjs` is a fake upstream (no real model or key), `client.mjs` shows client-side verification, `worker.js` + `wrangler.toml` the Cloudflare Worker version | `node examples/ai-proxy/index.mjs` (:8798), then `node examples/ai-proxy/client.mjs`; add `UPSTREAM_BASE_URL=...` to wrap your own upstream |
| [relay-trial](./relay-trial/) | relays that want to see it work before paying for anything | the local trial: one command starts the signing sidecar, a fake upstream and a local manifest on your machine, then runs `tapeapi-doctor`, verified calls, `tapeapi-verify` and a tampering demo; no key, no circuit, no cost | `node examples/relay-trial/trial.mjs` |
| [new-api-sidecar](./new-api-sidecar/) | relays running new-api | one `docker compose up -d` puts the signing sidecar in front of new-api: new-api runs as before, users call as before, and every call gets a signed usage receipt; you run the sidecar yourself (it sees your users' keys) | fill in `env.example` and `models.example.json`, then `docker compose up -d`; without Docker, try `node examples/new-api-sidecar/smoke.mjs` |
| [litellm-sidecar](./litellm-sidecar/) | teams serving an AI API through LiteLLM Proxy | one `docker compose up -d` puts the signing sidecar in front of LiteLLM (the official image pinned at v1.103.0, with PostgreSQL): LiteLLM's models, virtual keys and budgets stay as they are, users call as before, and every call gets a signed usage receipt; the price table's `id`s are LiteLLM's `model_name`s; `e2e.mjs` checks a real LiteLLM with the official SDKs | fill in `env.example`, `config.example.yaml` and `models.example.json`, then `docker compose up -d`; without Docker, try `node examples/litellm-sidecar/smoke.mjs` |
| [group-chat](./group-chat/) | apps adding group chat (TAP-27) | a minimal group chat over the public relay: two throwaway identities; the owner delivers the epoch message (group room) and the invite (the member's inbox room) in one `deliverGroupUpdate` call, the member finds it with `checkGroupInvites`, joins, and each sends a message; the demo uses `trust-roster`, a real app must use `api.groupVerifier()` | `node examples/group-chat/index.mjs` |
| [demo-site](./demo-site/) | front-ends | resolve, call and verify a signature in the browser with DeWEB-style relative paths | serve `tapeapi/` statically, open `examples/demo-site/index.html` |

## 收费服务：计量与结算 / A paid service: the meter and the settler

收费方法签出的凭证是钱。两个环境变量决定它们会不会变成链上的钱：

- `METER_FILE=./meter.json` —— 计量存到文件，重启不丢。不设置就只在内存里，进程一停，未结算的凭证就没了。
- `SETTLER_KEY=0x...`（加 `SETTLE_RPC_URL`，可选 `SETTLE_INTERVAL_MS`，默认 60 秒）—— 结算循环用这把密钥付 gas，
  在消费者的提现请求可执行之前、在凭证或会话密钥过期之前把该收的收上链（TAP-22 §3.3.1）。这把密钥只需要一点 BNB。

两者都需显式开启：示例不会因为有人跑了一下就写磁盘或发交易。收费服务在非 dev 模式下没开结算时，启动横幅会明确提示。

Vouchers signed by a paid method are money. Two environment variables decide whether they become money on chain:

- `METER_FILE=./meter.json` keeps the meter across a restart. Without it the meter is in memory only, and every
  unsettled voucher dies with the process.
- `SETTLER_KEY=0x...` (with `SETTLE_RPC_URL`, optionally `SETTLE_INTERVAL_MS`, default 60 s) runs the settler loop:
  it pays gas to settle what is due before a consumer's withdraw request becomes executable and before a voucher or
  its session key expires (TAP-22 §3.3.1). That key needs a little BNB and nothing else.

Both are opt-in, so an example never writes to disk or sends a transaction just because someone ran it. A priced
service outside dev mode says so in its start-up banner when the settler is off.
