# new-api-sidecar — 给 new-api 中转站的一键签名包 / one-command signing for new-api relays

[中文](#中文) · [English](#english)

规范 / Specification: 清单字段 `ai` 见 [TAPI-20 §3.9](../../spec/TAPI-20.md)，用量回执见 [TAPI-21 §3.5](../../spec/TAPI-21.md)（英文为准）。
旁路本身的说明（格式、回执、哈希、金额算法）见 [examples/ai-proxy](../ai-proxy/README.md)。

## 中文

**给谁**：已经用 [new-api](https://github.com/QuantumNous/new-api) 运营 AI 接口的中转站，并且在上游服务商的条款范围内合规经营。

**做什么**：在 new-api **前面**加一个签名旁路（`@tapeapi/server/ai-proxy`），new-api 本身一个字节都不改：

```
用户（官方 SDK、Claude Code、Codex……）
   │ https://api.example.com   ← 你的反向代理终结 TLS
   ▼
tapeapi-sidecar:8080    /v1/* 逐字节透传，为每个回答签一份用量回执
   │ http://new-api:3000/v1
   ▼
new-api:3000            渠道、令牌、额度、倍率、计费全部照旧
```

你得到：链上身份（一枚 TapeOut 电路的容器）、钉在链上的接口地址与价目表、每次调用一份签名的用量回执（模型、token 数、金额、
请求与回应的哈希）。**你的用户不用改代码**：照旧用 new-api 发给他们的令牌和官方 SDK，只是 base URL 指向旁路。

旁路放在 new-api **前面**而不是里面：new-api 的插件接口只管异步任务，文本转发没有钩子；而且这样签的是**你对终端用户**的价格与用量。
**TapeAPI 永远不替你托管旁路**：它经手你用户的 API 密钥，只能由你自己运行。

### 5 分钟上线

还没准备好花钱？先在本机跑一遍本地试跑（不需要密钥、电路，也不花钱）：先在仓库根目录运行 `npm ci --no-audit --no-fund`，再运行
`node examples/relay-trial/trial.mjs`。下面每一步做完都可以用 `tapeapi-doctor`（实验性）检查，它会说清缺什么、去哪做、下一条命令。
它随 SDK 发布包提供，在任何目录都能运行：`npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.8.0/tapeapi-sdk-1.8.0.tgz tapeapi-doctor <你的名字或旁路地址>`；
在本目录（`examples/new-api-sidecar`）里也可以用检出自带的 `node ../../sdk/bin/tapeapi-doctor.js`。逐步清单见 [AI 服务方指南 · 从零到上线](../../docs/guides/zh-CN/ai-providers.md#从零到上线)。

前提：一台装了 Docker 与 Docker Compose 2.17 或更高版本的服务器；一个域名和你已有的 HTTPS 反向代理（Nginx、Caddy、1Panel、宝塔都行）；
一枚已开通容器的 TapeOut 电路（在 tapeout.net 购买）；本仓库的检出（镜像由它构建）：

```sh
git clone https://github.com/BruceLanLan/tapeapi.git && cd tapeapi/examples/new-api-sidecar
```

**1. 填 `.env` 和价目表**

```sh
cp env.example .env && chmod 600 .env        # SESSION_SECRET 刻意留空，用 openssl rand -hex 32 生成；PUBLIC_URL 填旁路的 https 地址（只到域名，不带路径）
cp models.example.json models.json           # 改成你自己的模型与价格
```

`models.json` 是发布到链上的价目表（TAPI-20 §3.9 冻结的 `prices[]` 格式）：每个模型一个 `id`，可选 `aliases`（上游报告的其它名称，
如带日期的版本）和 `formats`（限定 API 格式），`prices` 按币种各一项（BEM、BNB、USDT、USDC、ETH、USD1，或仅作展示的 USD），
价格按每百万 token 给出 `input`、`output`，可选 `cacheRead`、`cacheWrite`、`cacheWrite1h`、`reasoning`。示例里的价格只是示例，
不是任何厂商的真实价格。回执按**上游报告的** model 精确匹配 `id` 或别名：如果你在 new-api 里设了“模型重定向”，上游报告的可能是
重定向后的名字，把它也写进 `aliases`，否则那些回答的回执里 `prices` 为 `null`（旁路日志会提示一次）。
表写错时旁路不会崩溃，而是进入设置模式，日志和 `/tapeapi/v1/health` 用一句话说明哪个文件的哪条规则不对。

**2. 启动**

```sh
docker compose up -d
docker compose logs -f tapeapi-sidecar      # 第一次会显示 SETUP MODE 和缺少的变量，这是正常的
```

两个服务都只监听宿主机回环地址：旁路 `127.0.0.1:8080`，new-api `127.0.0.1:3000`。在你的反向代理里配置两个主机名：

- `PUBLIC_URL`（如 `api.example.com`）→ `127.0.0.1:8080`：所有 API 流量都走这里；
- new-api 的网页控制台（如 `console.example.com`）→ `127.0.0.1:3000`：用户在这里充值、创建令牌。建议在这个主机名上拦掉 `/v1/`，
  让每一次 OpenAI、Anthropic 格式的调用都经过旁路、都带回执。

Nginx 要点：`proxy_buffering off;`（流式逐块到达）、`proxy_read_timeout 600s;`、`client_max_body_size 32m;`、
`proxy_set_header X-Real-IP $remote_addr;`，并在 `.env` 里设 `CLIENT_IP_HEADER=x-real-ip`。Caddy 的等价写法：

```
api.example.com {
    reverse_proxy 127.0.0.1:8080 {
        flush_interval -1
        header_up X-Real-IP {remote_host}
    }
}
```

已经在跑 new-api（官方 compose，带 PostgreSQL、Redis）？不必用这里的 `new-api` 服务：把 `tapeapi-sidecar` 这一段加进你现有的
compose 文件，放在同一个网络里，`UPSTREAM_BASE_URL` 指向你的 new-api 服务（如 `http://new-api:3000/v1`），再把反向代理的 API 主机名
改指旁路即可。只用这里的 compose 从零开始时，new-api 用 SQLite，数据在 `./data`；要用 MySQL 或 PostgreSQL 就设 `SQL_DSN`。

**3. 身份与发布清单：持有人操作台 https://tapeapi.fun/console/**

1. 连接持有电路的钱包，选中电路（第 1、2 步）。
2. 第 3 步“生成服务密钥”：把密钥填进 `.env` 的 `SIGNER_KEY`，页面给出的 `CIRCUITS`、`TOKEN_ID`、`CONTAINER` 也填进去；
   `docker compose up -d`（改了 `.env` 会重建旁路）。
3. 第 4 步输入 `PUBLIC_URL`，页面从 `PUBLIC_URL/tapeapi/v1/health` 读出签名地址（设置模式就是为这一步准备的），你用钱包签委托
   （EIP-712，不涉及资金，90 天到期）。把 `DELEGATION_EXPIRES`、`DELEGATION_SIG` 填进 `.env`，再 `docker compose up -d`。
   日志里出现 `signer …, container …, delegation until …` 和四个端点，旁路就开始签回执了。
4. 第 5 步把清单写上链。

> 第 5 步会按 SDK 的规则核对清单里的 `ai` 字段，在钱包请求之前把接口地址和价目表列成表（异常价格只提示、不拦截），发布后从链上
> 回读核对。可以先在第 5 步粘贴或上传你的 `models.json` 预览；详见
> [AI 服务方指南](../../docs/guides/zh-CN/ai-providers.md)的“用控制台发布价目表”。

**4. 告诉你的用户**

令牌不变（仍是 new-api 发的），只换 base URL：

| 客户端 | 设置 |
|---|---|
| OpenAI SDK、各类 OpenAI 兼容工具 | `base_url = https://api.example.com/v1` |
| Anthropic SDK、Claude Code | `ANTHROPIC_BASE_URL=https://api.example.com`（不带 `/v1`），`ANTHROPIC_AUTH_TOKEN=<new-api 令牌>` |
| Codex | `OPENAI_BASE_URL=https://api.example.com/v1`，或 `config.toml` 里 `base_url = "https://api.example.com/v1"` 加 `wire_api = "responses"` |

想自己核验每次调用的 Claude Code 或 Codex 用户，在本机运行核验代理 `tapeapi-verify`（需要清单已上链，见上面的现状说明），
把客户端指向它。`tapeapi-verify` 会一直在前台运行，客户端要在第二个终端里启动：

```sh
# 终端 1。42.1013.tape 是示例名：换成你的 TapeOut 名字（即 .env 里的 TAPE_NAME）
npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.8.0/tapeapi-sdk-1.8.0.tgz tapeapi-verify 42.1013.tape
```

```sh
# 终端 2，macOS 或 Linux
ANTHROPIC_BASE_URL=http://127.0.0.1:8790 claude
OPENAI_BASE_URL=http://127.0.0.1:8790/v1 codex             # Codex（或 config.toml 里的 base_url）
```

```powershell
# 终端 2，Windows PowerShell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8790"; claude
$env:OPENAI_BASE_URL="http://127.0.0.1:8790/v1"; codex
```

照原样用示例名运行会停在 “no file at /.well-known/tapeapi.json”：链上没有以 `42.1013.tape` 发布的服务。你的清单发布之后，
先自己跑一遍 `tapeapi-doctor <你的名字>`（上面的 npx 写法），全部通过（退出码 0）再告诉用户。

在 `.env` 里设 `TAPE_NAME=<你的 TapeOut 名字>`，旁路启动时会打印这条提示。用 SDK 的开发者可以用 `ai.createVerifyingFetch` 包裹官方 SDK 的 fetch。

### 用户看到什么

什么都不变：同样的回答、同样的流、同样的错误。额外多出的只有：整体回答多一个响应头 `x-tapeapi-receipt`；事件流在最终事件之前多一行
SSE 注释 `: tapeapi-receipt …`（官方 SDK、Claude Code、Codex 都忽略注释）。旁路自己的错误（限流、请求过大、new-api 不通或超时、
设置模式）是 OpenAI 格式的错误，带 `x-tapeapi-sidecar-error: 1`，不带回执。new-api 返回的失败（401、429、额度不足……）也签名，
但不声称用量、不计价格。

### 续期

操作台签的委托 90 天到期。旁路在剩下不到 30 天时每次启动都会在日志里打 `RENEW`；建议在最后 30 天内续期：

1. 操作台第 4 步选“续期”（为链上已授权的签名地址重签；服务密钥不变）；
2. 把新的 `DELEGATION_EXPIRES`、`DELEGATION_SIG` 填进 `.env`，`docker compose up -d`；
3. 第 5 步勾选“已发布过，仍要再发布”，重新发布清单。

委托一旦过期，旁路回到设置模式，所有 API 调用返回 503，直到续期。怀疑 `SIGNER_KEY` 泄露时不要续期：在第 3 步生成新密钥，重走第 3 到 5 步。

### 局限

- **回执证明的是谁回答的、针对哪些字节、声称了多少用量与价格，不证明实际运行的是哪个模型。** 签名让掺水**可追责**（回执不可抵赖），
  但本身不能发现掺水。
- **价格只是公示，现在不结算**：用户照旧按 new-api 的额度付费；按 token 的链上结算属于尚未部署的下一版托管合约。
- 旁路只转发 `/v1/*` 的 HTTP 请求，只为 `POST /v1/chat/completions`、`/v1/responses`、`/v1/responses/compact`、`/v1/messages`、
  `/v1/embeddings` 签回执；`/v1/models` 等其它 `/v1` 路径原样透传、不出回执。new-api 的 Gemini 原生路径（`/v1beta/...`）、Midjourney
  （`/mj/...`）、以及 WebSocket（`/v1/realtime`、Responses 的 WebSocket 模式 `GET /v1/responses`）都**不经过**旁路。
- new-api 看到的所有请求都来自旁路的地址（旁路不转发 `X-Forwarded-For` 之类的头），按 IP 的日志与限流会看到同一个地址；按令牌的
  额度与限流不受影响。旁路自己按客户端 IP 限流（`RATE_IP`，默认每分钟 600 次；设 `0` 则交给 new-api），反向代理后面要设
  `CLIENT_IP_HEADER`，否则所有用户共用一个限流桶。
- 回执在旁路内存里按 (id, requestSha256) 保留 1 小时（`RECEIPT_TTL_S` 可改，重启即丢），随回答送达的那一份才是主要的。免费的
  `receipt` 取回方法单独限流（每个客户端 IP 每分钟 10 次）。有些渠道的回答 id 可以猜（Ollama 的是 `chatcmpl-` 加一个小于 999 的数），
  旁路看到这种 id 会在日志里提示；这时设 `RECEIPT_REQUIRE_HASH=1`，取回执必须同时给出请求哈希 `requestSha256`，只猜中 id 的人拿不到。
- 上限：请求体 32 MiB，非流式回答 16 MiB，非流式回答须在 600 秒内完成，流静默 300 秒即结束。

### 合规

本包面向**在上游服务商条款范围内合规经营**的中转站。身份、价目与信誉在链上，不被任何单一平台绑架；但本协议**不**提供、也**不**
帮助规避上游服务商的封禁或地区限制。

### 安全

- **旁路经手用户的 API 密钥**（new-api 令牌原样转给 new-api）。所以旁路只能由你自己运行，不交给任何第三方托管，TapeAPI 也不托管。
- **`SIGNER_KEY` 是机密**：只放在 `.env`（已被 `.gitignore` 忽略，`chmod 600`），不进 git、聊天、截图或工单。
  `docker compose config` 会把它打印出来，不要外传那段输出。也可以用 `SIGNER_KEY_FILE` 指向一个文件（例如 Docker secret）。
  `.dockerignore` 保证 `.env` 和 new-api 的 `data/` 不会进入镜像构建。
- **旁路不保存提示词或回答**：内存里只有签过名的回执（里面是哈希、模型、token 数与金额，不是内容），日志里也没有提示词。
- 旁路容器以非 root 用户、只读文件系统、去掉全部 capability 运行。

### 不用 Docker 试一遍

```sh
npm ci --no-audit --no-fund                             # 在 tapeapi/ 根目录，一次
node examples/new-api-sidecar/smoke.mjs                 # 旁路入口 + 模拟上游（代替 new-api），Chat、Responses、Anthropic、Embeddings 全部核验回执
node --test examples/new-api-sidecar/new-api-sidecar.test.mjs
```

`smoke.mjs` 用仓库里的**模拟**上游（`examples/ai-proxy/fake-upstream.mjs`：没有真实模型、没有真实密钥）代替 new-api，
用一次性身份（随机持有人签的真实 EIP-712 委托，但不在链上），并用 SDK 的 `ai.verifyUsageReceipt` 按确切的收发字节核验每一份回执。

### 文件

| 文件 | 作用 |
|---|---|
| `docker-compose.yml` | new-api（官方镜像 `calciumion/new-api:v1.0.0-rc.40`）+ 旁路；两者都只发布在回环地址 |
| `Dockerfile`、`.dockerignore` | 旁路镜像：`node:22-alpine`，`@tapeapi/sdk` 与 `@tapeapi/server` 取自本次检出（compose 的命名构建上下文），按仓库的 npm 工作区布局安装 |
| `server.mjs` | 旁路入口：读环境变量、设置模式、价目表检查、Node HTTP 与旁路之间的流式桥接 |
| `models.example.json` | 示例价目表 |
| `env.example` | `.env` 模板，只有占位符（文件名不带前导点，是为了能随示例公开） |
| `smoke.mjs`、`new-api-sidecar.test.mjs` | 不需要 Docker 的演练与测试 |

镜像为什么从本仓库构建，而不是从发布包安装：GitHub 发布里只有 SDK 的安装包，没有 `@tapeapi/server` 的；从检出构建也保证镜像里
运行的就是你读过的代码。npm 只下载 SDK 固定版本的三个 `@noble` 依赖。

### 核实过的 new-api 事实（2026-09-28）

- 镜像 `calciumion/new-api`，最新发布 `v1.0.0-rc.40`（2026-09-21，GitHub 标记为 latest，非预发布；amd64、arm64）。
- 默认端口 3000（`common/init.go` 的 `--port` 默认值，Dockerfile `EXPOSE 3000`）；工作目录 `/data`，未设 `SQL_DSN` 时用 SQLite；
  `SESSION_SECRET` 设为 `random_string` 会拒绝启动；健康检查 `GET /api/status`（官方 compose）。
- 路由（`router/relay-router.go`，rc.40）：`POST /v1/chat/completions`、`/v1/messages`、`/v1/responses/compact`、`/v1/embeddings`、
  `GET /v1/models`；`POST /v1/responses` 由任务插件协议路由注册（`router/task_plugin_protocol_router_test.go`，README 的示例也调用它）；
  `/v1/messages/count_tokens` 在 rc.40 被暂时停用。Anthropic 格式的 `x-api-key` 会被当作 `Authorization: Bearer` 令牌（`middleware/auth.go`）。

## English

**For** relays that already run an AI API on [new-api](https://github.com/QuantumNous/new-api) and operate within their
upstream providers' terms.

**What it does**: a signing sidecar (`@tapeapi/server/ai-proxy`) goes **in front of** new-api; new-api itself does not
change by one byte. Users → your HTTPS reverse proxy → `tapeapi-sidecar:8080` (passes `/v1/*` through byte for byte and
signs a usage receipt for every answer) → `new-api:3000/v1` (channels, tokens, quotas, ratios and billing as before).

You get an on-chain identity (a TapeOut circuit's container), the endpoints and price table pinned on chain, and a signed
usage receipt for every call (model, token counts, amount, hashes of the request and the response). **Your users change
no code**: they keep the tokens new-api issued them and their official SDKs; only the base URL points at the sidecar.

In front, never inside: new-api's plugin API covers asynchronous tasks only and has no hook on text relaying, and in
front the receipt covers **your** price and usage towards your users. **TapeAPI never hosts the sidecar for you**: it sees
your users' API keys, so only you run it.

### Live in 5 minutes

Not ready to pay for anything yet? Run the local trial on your machine first (no key, no circuit, no cost):
`npm ci --no-audit --no-fund` at the repository root, then `node examples/relay-trial/trial.mjs`. After each step below,
`tapeapi-doctor` (experimental) checks it and says what is missing, where to fix it and the next command. It ships in
the SDK's release package and runs from any directory:
`npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.8.0/tapeapi-sdk-1.8.0.tgz tapeapi-doctor <your name or sidecar URL>`; in this directory (`examples/new-api-sidecar`)
the checkout's own is `node ../../sdk/bin/tapeapi-doctor.js`. The step-by-step checklist is [AI providers · From zero to live](../../docs/guides/ai-providers.md#from-zero-to-live).

You need a server with Docker and Docker Compose 2.17 or later; a domain and your existing HTTPS reverse proxy (Nginx,
Caddy, 1Panel, ...); a TapeOut circuit with its container opened (bought on tapeout.net); and a checkout of this
repository (the image is built from it): `git clone https://github.com/BruceLanLan/tapeapi.git && cd tapeapi/examples/new-api-sidecar`.

1. **Fill in `.env` and the price table.** `cp env.example .env && chmod 600 .env` (generate `SESSION_SECRET`, left empty on purpose, with
   `openssl rand -hex 32`; set `PUBLIC_URL` to the sidecar's https origin, no path) and `cp models.example.json models.json`,
   then edit it. `models.json` is the price table published on chain, in the frozen `prices[]` shape of TAPI-20 §3.9: per
   model an `id`, optional `aliases` and `formats`, and one `prices` entry per currency (BEM, BNB, USDT, USDC, ETH, USD1,
   or USD for display) with `input` and `output` per 1M tokens and optional `cacheRead`, `cacheWrite`, `cacheWrite1h`,
   `reasoning`. The example prices are examples, not any vendor's real prices. Receipts match the model the upstream
   **reported**, exactly, against ids and aliases: with a model redirect in new-api the reported name may be the
   redirected one, so list it under `aliases` (otherwise those receipts carry `prices: null`, logged once). A wrong table
   does not crash the sidecar: it stays in setup mode and the log and `/tapeapi/v1/health` say, in one sentence, which
   rule of which file is broken.
2. **Start.** `docker compose up -d`, then `docker compose logs -f tapeapi-sidecar` (the first start shows SETUP MODE
   and what is missing; that is expected). Both services listen on the host's loopback only: the sidecar on
   `127.0.0.1:8080`, new-api on `127.0.0.1:3000`. In your reverse proxy, point `PUBLIC_URL` (e.g. `api.example.com`) at
   `127.0.0.1:8080` for all API traffic, and new-api's web console (users top up and create tokens there) at
   `127.0.0.1:3000` on a hostname of its own; block `/v1/` on the console hostname so every OpenAI- or Anthropic-format
   call goes through the sidecar and carries a receipt. For Nginx: `proxy_buffering off;`, `proxy_read_timeout 600s;`,
   `client_max_body_size 32m;`, `proxy_set_header X-Real-IP $remote_addr;` and `CLIENT_IP_HEADER=x-real-ip` in `.env`
   (the Caddy block is above). Already running new-api with its official compose (PostgreSQL, Redis)? Skip this file's
   `new-api` service: add the `tapeapi-sidecar` service to your compose on the same network with `UPSTREAM_BASE_URL` set
   to your new-api service, and point the API hostname at the sidecar. From scratch, new-api uses SQLite in `./data`;
   set `SQL_DSN` for MySQL or PostgreSQL.
3. **Identity and the manifest, in the holder console at https://tapeapi.fun/console/.** Connect the wallet that holds
   the circuit and pick the circuit (steps 1 and 2). Step 3, "Generate a service key": put the key in `.env` as
   `SIGNER_KEY`, with the `CIRCUITS`, `TOKEN_ID` and `CONTAINER` the page shows, and `docker compose up -d` (a changed
   `.env` recreates the sidecar). Step 4: enter `PUBLIC_URL`; the page reads the signing address from
   `PUBLIC_URL/tapeapi/v1/health` (setup mode exists for this step) and you sign the delegation with your wallet
   (EIP-712, no funds move, expires in 90 days). Put `DELEGATION_EXPIRES` and `DELEGATION_SIG` in `.env` and
   `docker compose up -d` again; once the log shows `signer …, container …, delegation until …` and the four endpoints,
   the sidecar signs receipts. Step 5 publishes the manifest on chain.

   > Step 5 checks the manifest's `ai` field by the SDK's rules, shows the endpoints and the price table before the
   > wallet asks (unusual prices are hinted at, never refused), and reads the manifest back from the chain once it is
   > published. You can paste or upload your `models.json` in step 5 first to preview it; see "Publish the price table
   > with the console" in the [AI provider guide](../../docs/guides/ai-providers.md).
4. **Tell your users.** Same tokens (issued by new-api), new base URL: OpenAI SDKs and OpenAI-compatible tools use
   `https://api.example.com/v1`; the Anthropic SDK and Claude Code use `ANTHROPIC_BASE_URL=https://api.example.com`
   (no `/v1`) with `ANTHROPIC_AUTH_TOKEN=<new-api token>`; Codex uses `OPENAI_BASE_URL=https://api.example.com/v1`, or
   `base_url = "https://api.example.com/v1"` with `wire_api = "responses"` in `config.toml`. Claude Code and Codex users who want every call checked run the local
   verifying proxy `tapeapi-verify <your TapeOut name>` (it needs the manifest on chain, see the note above) and point
   their client at it from a second terminal, since `tapeapi-verify` keeps running in the foreground
   (`ANTHROPIC_BASE_URL=http://127.0.0.1:8790 claude`, or `OPENAI_BASE_URL=http://127.0.0.1:8790/v1 codex`; in Windows
   PowerShell `$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8790"; claude` and `$env:OPENAI_BASE_URL="http://127.0.0.1:8790/v1"; codex`); set
   `TAPE_NAME` in `.env` and the sidecar prints that hint at start. SDK users can wrap the official SDK's fetch with
   `ai.createVerifyingFetch`. Before telling anyone, run `tapeapi-doctor <your TapeOut name>` (the npx form above) yourself
   and wait for exit status 0 (the documentation's `42.1013.tape` is an example name: nothing is published under it).

### What users see

Nothing changes: the same answers, the same streams, the same errors. The only additions: a whole answer carries an
`x-tapeapi-receipt` header, and an event stream carries one SSE comment `: tapeapi-receipt …` before its final event
(the official SDKs, Claude Code and Codex ignore comments). The sidecar's own errors (rate limit, request too large,
new-api unreachable or too slow, setup mode) are OpenAI-shaped, marked `x-tapeapi-sidecar-error: 1`, and carry no
receipt. Failures new-api returns (401, 429, quota exhausted, ...) are signed too, with no usage and no price claimed.

### Renewing the delegation

The console signs delegations for 90 days. With fewer than 30 days left the sidecar logs `RENEW` at every start; renew
within those last 30 days: step 4 of the console, "Renew" (re-signs for the signing address already on chain; same
service key); put the new `DELEGATION_EXPIRES` and `DELEGATION_SIG` in `.env` and `docker compose up -d`; step 5 with
"Already published; publish again" ticked. An expired delegation puts the sidecar back in setup mode and every API call
answers 503 until it is renewed. If you think `SIGNER_KEY` leaked, do not renew: generate a new key in step 3 and redo
steps 3 to 5.

### Limits

- **A receipt proves who answered, to which bytes, and what usage and price were claimed; it does not prove which model
  actually ran.** The signature makes watering down **attributable** (a receipt cannot be disowned); it does not detect it.
- **Prices are published, not settled**: users pay through new-api's quota as today; per-token settlement on chain
  belongs to the next escrow version, which is not deployed.
- The sidecar forwards HTTP requests under `/v1/*` only and signs receipts for `POST /v1/chat/completions`,
  `/v1/responses`, `/v1/responses/compact`, `/v1/messages` and `/v1/embeddings`; other `/v1` paths such as `/v1/models`
  pass through without a receipt. new-api's native Gemini paths (`/v1beta/...`), Midjourney (`/mj/...`) and WebSockets
  (`/v1/realtime`, the Responses WebSocket mode `GET /v1/responses`) do **not** go through the sidecar.
- new-api sees every request coming from the sidecar's address (the sidecar does not forward `X-Forwarded-For` and the
  like): per-IP logs and limits in new-api see one address; per-token quotas and limits are unaffected. The sidecar
  limits per client IP itself (`RATE_IP`, default 600 per minute; `0` leaves it to new-api); behind a reverse proxy set
  `CLIENT_IP_HEADER`, or every user shares one bucket.
- Receipts are kept in the sidecar's memory per (id, requestSha256) for 1 hour (`RECEIPT_TTL_S` changes it; a restart
  loses them); the copy delivered with the answer is the primary one. The free `receipt` lookup method has a budget of
  its own (10 per client IP per minute). Some channels' answer ids can be guessed (Ollama's are `chatcmpl-` and a
  number below 999); the sidecar's log says so when it sees such ids. Then set `RECEIPT_REQUIRE_HASH=1`: a lookup must
  also name the request hash `requestSha256`, which someone who only guessed an id does not have.
- Caps: request body 32 MiB, non-stream answer 16 MiB, a non-stream answer must complete within 600 s, a stream silent
  for 300 s is ended.

### Compliance

This package is for relays operating **within their upstream providers' terms**. Identity, prices and reputation live
on chain, where no single platform can hold them hostage; the protocol does **not** offer, and does not help with,
evading an upstream provider's bans or regional restrictions.

### Security

- **The sidecar sees your users' API keys** (new-api tokens go through to new-api as they are). Run it yourself; never
  let a third party host it. TapeAPI does not host it either.
- **`SIGNER_KEY` is a secret**: keep it only in `.env` (ignored by `.gitignore`, `chmod 600`), never in git, chat,
  screenshots or tickets. `docker compose config` prints it: do not share that output. `SIGNER_KEY_FILE` can point at a
  file instead (a Docker secret, for instance). `.dockerignore` keeps `.env` and new-api's `data/` out of the image build.
- **The sidecar stores no prompts and no answers**: its memory holds signed receipts only (hashes, model, token counts
  and amounts, not content), and its log carries no prompts.
- The sidecar container runs as a non-root user, on a read-only file system, with every capability dropped.

### Try it without Docker

```sh
npm ci --no-audit --no-fund                             # once, in tapeapi/
node examples/new-api-sidecar/smoke.mjs                 # the sidecar entry + a fake upstream standing in for new-api
node --test examples/new-api-sidecar/new-api-sidecar.test.mjs
```

`smoke.mjs` puts the sidecar's own entry in front of the repository's **fake** upstream
(`examples/ai-proxy/fake-upstream.mjs`: no real model, no real key) with a throwaway identity (a random holder signs a
real EIP-712 delegation, but nothing is on chain), makes Chat, Responses, Anthropic Messages and Embeddings calls, and
checks every receipt with the SDK's `ai.verifyUsageReceipt` over the exact bytes sent and received.

### Files

`docker-compose.yml` (new-api from the official image `calciumion/new-api:v1.0.0-rc.40`, and the sidecar; both published
on loopback only), `Dockerfile` and `.dockerignore` (the sidecar image: `node:22-alpine`, `@tapeapi/sdk` and
`@tapeapi/server` from this checkout through compose's named build contexts, installed as the repository's own npm
workspace), `server.mjs` (the sidecar entry: environment, setup mode, price-table checks, the streaming bridge between
Node's HTTP server and the sidecar), `models.example.json`, `env.example` (placeholders only; named without the leading
dot so that it is published with the example), `smoke.mjs` and `new-api-sidecar.test.mjs`.

Why the image is built from this repository rather than installed from a release: the GitHub release carries the SDK's
package only, not `@tapeapi/server`'s; and building from the checkout means the image runs exactly the code you have
read. npm fetches only the SDK's three pinned `@noble` dependencies.

### new-api facts checked on 2026-09-28

- Image `calciumion/new-api`; latest release `v1.0.0-rc.40` (2026-09-21, marked latest on GitHub, not a pre-release;
  amd64 and arm64).
- Port 3000 by default (`common/init.go`'s `--port` default, `EXPOSE 3000` in its Dockerfile); working directory
  `/data`, SQLite when `SQL_DSN` is unset; it refuses to start with `SESSION_SECRET=random_string`; health check
  `GET /api/status` (official compose file).
- Routes (`router/relay-router.go` at rc.40): `POST /v1/chat/completions`, `/v1/messages`, `/v1/responses/compact`,
  `/v1/embeddings`, `GET /v1/models`; `POST /v1/responses` is registered by the task-plugin protocol router
  (`router/task_plugin_protocol_router_test.go`; its README's example calls it); `/v1/messages/count_tokens` is disabled
  for now at rc.40. An Anthropic-style `x-api-key` is taken as the `Authorization: Bearer` token (`middleware/auth.go`).
