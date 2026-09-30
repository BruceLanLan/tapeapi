# litellm-sidecar — 给 LiteLLM Proxy 的一键签名包 / one-command signing for LiteLLM Proxy

[中文](#中文) · [English](#english)

规范 / Specification: 清单字段 `ai` 见 [TAPI-20 §3.9](../../spec/TAPI-20.md)，用量回执见 [TAPI-21 §3.5](../../spec/TAPI-21.md)（英文为准）。
旁路本身的说明（格式、回执、哈希、金额算法）见 [examples/ai-proxy](../ai-proxy/README.md)；本包的入口复用
[new-api 一键包](../new-api-sidecar/README.md)的入口，环境变量、设置模式、续期与安全说明两者相同。

## 中文

**给谁**：已经用 [LiteLLM Proxy](https://github.com/BerriAI/litellm)（AI 网关）给团队或客户提供 AI 接口的服务方，并且在上游服务商的
条款范围内合规经营。

**做什么**：在 LiteLLM **前面**加一个签名旁路（`@tapeapi/server/ai-proxy`），LiteLLM 本身一个字节都不改：

```
用户（官方 SDK、Claude Code、Codex……）
   │ https://api.example.com   ← 你的反向代理终结 TLS
   ▼
tapeapi-sidecar:8080    /v1/* 逐字节透传，为每个回答签一份用量回执
   │ http://litellm:4000/v1
   ▼
litellm:4000            模型列表、虚拟密钥、预算、限流、花费统计全部照旧
   │
   ▼
你的服务商（OpenAI、Anthropic、DeepSeek、自建模型……）
```

你得到：链上身份（一枚 TapeOut 电路的容器）、钉在链上的接口地址与价目表、每次调用一份签名的用量回执（模型、token 数、金额、
请求与回应的哈希）。**你的用户不用改代码**：照旧用 LiteLLM 发给他们的虚拟密钥（`sk-...`）和官方 SDK，只是 base URL 指向旁路。

为什么放在前面而不是写成 LiteLLM 的 Python 回调插件：回调看到的是 LiteLLM 解析后的 Python 对象，看不到客户端实际收发的字节，
而回执证明的恰恰是那些字节；插件还要在 Python 里再实现一遍回执签名。详见文末“依据”。
**TapeAPI 永远不替你托管旁路**：它经手你用户的 API 密钥，只能由你自己运行。

### 三步接入

前提：一台装了 Docker 与 Docker Compose 2.17 或更高版本的服务器；一个域名和你已有的 HTTPS 反向代理（Nginx、Caddy……）；
一枚已开通容器的 TapeOut 电路（在 tapeout.net 购买）；本仓库的检出（旁路镜像由它构建）：

```sh
git clone https://github.com/BruceLanLan/tapeapi.git && cd tapeapi/examples/litellm-sidecar
```

**1. 填 `.env`、LiteLLM 配置和价目表**

```sh
cp env.example .env && chmod 600 .env        # LITELLM_MASTER_KEY、LITELLM_SALT_KEY、POSTGRES_PASSWORD 刻意留空，按注释生成
cp config.example.yaml config.yaml           # LiteLLM 的模型列表：改成你自己的
cp models.example.json models.json           # 发布到链上的价目表：改成你自己的模型与价格
```

规则只有一条：**`models.json` 里的每个 `id` 必须是 `config.yaml` 里的一个 `model_name`**。LiteLLM 1.103.0 会把回答里的 `model`
改写成客户端请求的公开名字（`model_name`），旁路按这个名字精确匹配价目表。发生回退（fallback）时 LiteLLM 报告实际作答的模型组，
所以回退目标也要按它自己的价格写进 `models.json`。没匹配上的回答照样有签名回执，只是 `prices` 为 `null`（旁路日志提示一次）。
`models.json` 的格式（TAPI-20 §3.9 冻结的 `prices[]`）与 new-api 包相同：每个模型一个 `id`，可选 `aliases`、`formats`，`prices` 按币种
各一项，价格按每百万 token。示例里的价格只是示例。表写错时旁路不会崩溃，而是进入设置模式，用一句话说明哪条规则不对。

已经在跑 LiteLLM？不必用这里的 `config.yaml`：保留你自己的配置，照它的 `model_name` 写 `models.json` 即可。

**2. 启动**

```sh
docker compose up -d
docker compose logs -f tapeapi-sidecar      # 第一次会显示 SETUP MODE 和缺少的变量，这是正常的
```

三个服务：`litellm`（官方镜像 `ghcr.io/berriai/litellm:v1.103.0`）、它的 `db`（PostgreSQL，虚拟密钥、预算与花费存在这里）、
`tapeapi-sidecar`。都只在宿主机回环地址上：旁路 `127.0.0.1:8080`，LiteLLM `127.0.0.1:4000`，数据库不发布端口。反向代理里只把
`PUBLIC_URL`（如 `api.example.com`）指向 `127.0.0.1:8080`。**LiteLLM 自己的端口不要对公网开放**：它的管理界面（`/ui`）和密钥管理
走 SSH 隧道或内网；否则用户可以绕过旁路直接调用，那些调用就没有回执。

用管理员密钥给用户发虚拟密钥（经隧道访问 LiteLLM，或在服务器上执行）：

```sh
curl -s http://127.0.0.1:4000/key/generate -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H 'content-type: application/json' -d '{"models": ["gpt-5-mini", "claude-sonnet-4-5"], "max_budget": 10}'
```

Nginx 要点：`proxy_buffering off;`（流式逐块到达）、`proxy_read_timeout 600s;`、`client_max_body_size 32m;`、
`proxy_set_header X-Real-IP $remote_addr;`，并在 `.env` 里设 `CLIENT_IP_HEADER=x-real-ip`。Caddy：
`reverse_proxy 127.0.0.1:8080 { flush_interval -1; header_up X-Real-IP {remote_host} }`。

已经用 LiteLLM 官方 compose 在跑？把 `tapeapi-sidecar` 这一段（连同它的 `build`）加进你的 compose 文件，放在同一个网络里，
`UPSTREAM_BASE_URL` 指向你的 LiteLLM 服务（如 `http://litellm:4000/v1`），再把反向代理的 API 主机名改指旁路即可。

**3. 身份与发布清单：持有人操作台 https://tapeapi.fun/console/**

与 new-api 包完全相同：第 3 步生成服务密钥，把 `SIGNER_KEY`、`CIRCUITS`、`TOKEN_ID`、`CONTAINER` 填进 `.env`，
`docker compose up -d`；第 4 步输入 `PUBLIC_URL`，操作台从 `PUBLIC_URL/tapeapi/v1/health` 读出签名地址，你用钱包签委托（EIP-712，
不涉及资金，90 天到期），把 `DELEGATION_EXPIRES`、`DELEGATION_SIG` 填进 `.env` 再 `docker compose up -d`；日志出现
`signer …, container …, delegation until …` 和四个端点后，第 5 步把清单写上链。第 5 步可以先粘贴 `models.json` 预览。

**然后告诉你的用户**：密钥不变（仍是 LiteLLM 的虚拟密钥），只换 base URL，而且**必须带 `/v1`**：

| 客户端 | 设置 |
|---|---|
| OpenAI SDK、各类 OpenAI 兼容工具 | `base_url = https://api.example.com/v1` |
| Anthropic SDK、Claude Code | `ANTHROPIC_BASE_URL=https://api.example.com`（不带 `/v1`，SDK 自己加），`ANTHROPIC_AUTH_TOKEN=<LiteLLM 虚拟密钥>` |
| Codex | `config.toml` 里 `base_url = "https://api.example.com/v1"`，`wire_api = "responses"` |

想自己核验每次调用的用户，在本机运行 `tapeapi-verify <你的 TapeOut 名字>` 并把客户端指向它；用 SDK 的开发者用
`ai.createVerifyingFetch` 包裹官方 SDK 的 fetch（用法见 new-api 包的 README）。

### 用户看到什么

什么都不变：同样的回答、同样的流、同样的错误，LiteLLM 自己的响应头（`x-litellm-*`、`llm_provider-*`）也原样到达。额外多出的只有：
整体回答多一个响应头 `x-tapeapi-receipt`；事件流在结束之前多一行 SSE 注释 `: tapeapi-receipt …`（客户端都忽略注释）。
旁路自己的错误（限流、请求过大、LiteLLM 不通或超时、设置模式）是 OpenAI 格式的错误，带 `x-tapeapi-sidecar-error: 1`，不带回执。
LiteLLM 返回的失败（401 密钥无效、429 超出预算或限流……）也签名，但不声称用量、不计价格。

### 续期

与 new-api 包相同（见[那里的“续期”](../new-api-sidecar/README.md#续期)）：委托 90 天到期，最后 30 天旁路每次启动都在日志里打
`RENEW`；过期后旁路回到设置模式，所有 API 调用返回 503，直到续期。

### 局限

- **回执证明的是谁回答的、针对哪些字节、声称了多少用量与价格，不证明实际运行的是哪个模型。**签名让掺水可追责，但本身不能发现掺水。
- **价格只是公示，现在不结算**：用户照旧按 LiteLLM 的预算与花费计费；按 token 的链上结算属于尚未部署的下一版托管合约。
- 旁路只转发 `/v1/*`，只为 `POST /v1/chat/completions`、`/v1/responses`、`/v1/responses/compact`、`/v1/messages`、`/v1/embeddings`
  签回执；`/v1/models`、`/v1/messages/count_tokens`、`/v1/completions`、图片、音频等其它 `/v1` 路径原样透传、不出回执。LiteLLM 另外
  提供的不带 `/v1` 的路径（`/chat/completions`、`/responses`、`/openai/v1/responses`、`/openai/deployments/...`）、各家的透传路由
  （`/anthropic/...`、`/gemini/...` 等）以及 WebSocket（`/v1/realtime`、`/v1/responses`）都**不经过**旁路。
- 用户的密钥只能用 `Authorization: Bearer` 或 `x-api-key` 传（官方 SDK 都是这样）。LiteLLM 还接受的 `x-litellm-api-key`、`API-Key`、
  `x-goog-api-key`、`Ocp-Apim-Subscription-Key` 以及 `general_settings.litellm_key_header_name` 自定义头，旁路都**不转发**；
  `x-litellm-tags`、`x-litellm-timeout` 这类请求头也不转发（在密钥或模型上配置它们）。
- LiteLLM 看到的所有请求都来自旁路的地址：`allowed_ips`、`use_x_forwarded_for` 和按 IP 的日志只会看到一个地址；按密钥的预算与限流
  不受影响。旁路自己按客户端 IP 限流（`RATE_IP`，默认每分钟 600 次；设 `0` 则交给 LiteLLM）。
- LiteLLM 的 Responses 回答 id 很长（把部署信息编码在里面，超过 TAPI-21 的 128 个字符），这类回答的回执用旁路生成的 `tapeapi-…` id；
  按 id 取回执时用回执里的 id，不是 LiteLLM 的 id。
- 上限：请求体 32 MiB，非流式回答 16 MiB，非流式回答须在 600 秒内完成，流静默 300 秒即结束。

### 常见问题

**为什么不写成 LiteLLM 的回调插件？** 见“依据”。简单说：插件拿不到确切的字节，还要维护第二份签名实现。

**我用 LiteLLM 的管理界面（`STORE_MODEL_IN_DB`）加模型，不用 `config.yaml` 行不行？** 行。规则不变：每个对外的模型名都要写进
`models.json`，改了价目表要在操作台第 5 步重新发布清单。

**客户端原来的 base URL 没带 `/v1`（LiteLLM 两种都接受），能不能照旧？** 不能：旁路只签 `/v1/*`。不带 `/v1` 的请求到达旁路会得到 404，
不会绕过它，也就不会出现“没有回执的成功调用”。

**打开了 LiteLLM 的 SSE 保活（`sse_keepalive_ping_interval_seconds`、`anthropic_sse_ping_interval_seconds`）有影响吗？** 回执照常核验：
保活行是 SSE 注释或 Anthropic 的 `ping` 事件，原样透传并计入哈希。但保活一旦提前发出了 200，之后的上游失败只能以流里的错误事件
出现，这时回执的 `complete` 为 `false`。

**为什么 Chat 流里客户端没要 usage，回执里却有 token 数？** 旁路替客户端向 LiteLLM 要了 usage（`stream_options.include_usage`），
再把那一块从客户端收到的内容里去掉，回执里记 `usageInjected: true`。LiteLLM 的 usage 块形状与 OpenAI 略有不同（带一个空的 choice），
本包的 `litellmFormats` 专门认它。

**升级 LiteLLM 前要做什么？** 先用新版本跑一遍 `e2e.mjs`（见下），全部通过再改 `docker-compose.yml` 里的版本号。LiteLLM 发布很频繁，
流的格式偶有变化；这正是旁路只看字节、并且有端到端检查的原因。即使以后的 LiteLLM 给 Responses 事件加上 `event:` 行（无论是否仍以
`data: [DONE]` 结束），回执也只出现一次、在结束之前（测试里覆盖了这两种情况）。

**需要 PostgreSQL 吗？** 要发虚拟密钥、设预算就要（LiteLLM 把它们存在数据库里）。只有一把管理员密钥时，LiteLLM 可以不用数据库，
但那样所有用户共用一把密钥，没有按人的预算。

### 合规与安全

- 本包面向**在上游服务商条款范围内合规经营**的服务方；本协议**不**提供、也**不**帮助规避上游服务商的封禁或地区限制。
- **旁路经手用户的 API 密钥**（LiteLLM 虚拟密钥原样转给 LiteLLM），只能由你自己运行。
- **`SIGNER_KEY`、`LITELLM_MASTER_KEY`、`LITELLM_SALT_KEY` 和服务商密钥都是机密**：只放在 `.env`（`chmod 600`；仓库的 `.gitignore` 已忽略 `.env`、`config.yaml`、`models.json` 与 `pgdata/`）。
  `docker compose config` 会把它们打印出来，不要外传那段输出。`.dockerignore` 保证 `.env`、`config.yaml`、`models.json` 不会进入镜像构建。
- 旁路不保存提示词或回答，内存里只有签过名的回执；容器以非 root 用户、只读文件系统、去掉全部 capability 运行。

### 不用 Docker 试一遍

```sh
npm install --no-audit --no-fund                        # 在 tapeapi/ 根目录，一次
node examples/litellm-sidecar/smoke.mjs                 # 旁路入口 + 按 LiteLLM 格式改写的模拟上游，六种调用全部核验回执
node --test examples/litellm-sidecar/litellm-sidecar.test.mjs
```

`smoke.mjs` 不需要 LiteLLM：它把仓库的**模拟**上游（`examples/ai-proxy/fake-upstream.mjs`，没有真实模型与密钥）改写成 LiteLLM 1.103.0
的样子（Responses 事件只有 `data:` 行并以 `data: [DONE]` 结束；Chat 的 usage 块带一个空的 choice；带 `x-litellm-*` 头）。

### 对真实的 LiteLLM 端到端

```sh
python3 -m venv .venv && .venv/bin/pip install 'litellm[proxy]==1.103.0'
LITELLM_BIN=$PWD/.venv/bin/litellm node examples/litellm-sidecar/e2e.mjs
# 或者对着已经在运行的 LiteLLM（它的 model_name 与 models.example.json 一致、模型指向模拟上游）：
LITELLM_URL=http://127.0.0.1:4000 LITELLM_KEY=sk-... node examples/litellm-sidecar/e2e.mjs
```

`e2e.mjs` 启动模拟上游，生成一份指向它的 LiteLLM 配置并启动 LiteLLM，然后：六种原始调用按字节核验；官方 `openai` 与
`@anthropic-ai/sdk` 经 strict 模式的 `ai.createVerifyingFetch` 调用（Chat、Responses、Embeddings、Messages，流式与非流式，核验不过
就抛出）；最后是对照组：不带 `litellmFormats` 的旁路，严格客户端必须拒绝 LiteLLM 的 Responses 流。

### 文件

| 文件 | 作用 |
|---|---|
| `docker-compose.yml` | LiteLLM（官方镜像 `ghcr.io/berriai/litellm:v1.103.0`）+ PostgreSQL 16 + 旁路；都只在回环地址上 |
| `Dockerfile`、`.dockerignore` | 旁路镜像：`node:22-alpine`，`@tapeapi/sdk`、`@tapeapi/server` 与 new-api 包的 `server.mjs` 取自本次检出（compose 的命名构建上下文） |
| `server.mjs` | 本包的入口：new-api 包的入口换上 LiteLLM 的配置（默认上游、日志标签、`litellmFormats`） |
| `config.example.yaml` | 最小的 LiteLLM 配置：四个模型，密钥全部来自环境变量 |
| `models.example.json` | 示例价目表，`id` 与 `config.example.yaml` 的 `model_name` 一一对应 |
| `env.example` | `.env` 模板，只有占位符 |
| `smoke.mjs`、`litellm-sidecar.test.mjs` | 不需要 Docker 与 LiteLLM 的演练与测试（测试在 `npm test` 里） |
| `e2e.mjs` | 对真实 LiteLLM 的端到端检查（不在 `npm test` 里） |

### 依据

**方案：前置旁路，而不是 LiteLLM 回调插件。**

- 回执证明的是**客户端收发的确切字节**（`requestSha256`、`responseSha256`）。LiteLLM 的回调
  （[`CustomLogger`](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/integrations/custom_logger.py)：`async_post_call_success_hook`、
  `async_post_call_streaming_iterator_hook`、`async_post_call_response_headers_hook`）拿到的是解析、改写之后的 Python 对象：请求的 `model`
  已被路由改写，回答在钩子之后才被序列化，流式块在钩子之后才加上 `data: ` 分帧；响应头钩子运行时回答正文还不存在。插件只能重新序列化
  再猜字节，LiteLLM 的每次升级都可能让哈希对不上。SSE 注释形式的流内回执也无法经由返回对象的钩子写出。
- 插件要在 Python 里重新实现 TAPI-21 的信封签名、usage 归一化与金额算法，多出一份必须与 `spec/vectors` 对齐的实现；旁路用的就是已冻结的
  `createAIProxy`，与 new-api 包、Cloudflare Worker 版是同一份代码。
- 插件运行在 LiteLLM 进程里，签名密钥要交给 LiteLLM 的环境；旁路是独立的进程与容器。
- 旁路的代价是两处：只签 `/v1/*`，以及 LiteLLM 看到的客户端地址变成旁路的地址（见“局限”）。都可以接受。
- 需要的一处适配（Responses 流以 `data: [DONE]` 结尾时，回执放在它之前）只改变“回执放在哪里”，写成 `createAIProxy` 公开的 `formats` 选项（`server.mjs` 的 `litellmFormats`），
  签名、哈希与所有核验方都未改动。

**核实过的 LiteLLM 事实（2026-09-29，源码取 tag `v1.103.0`，提交 `c991f4b`）：**

- 版本：最新稳定发布 [v1.103.0](https://github.com/BerriAI/litellm/releases/tag/v1.103.0)（GitHub 发布于 2026-09-28，非预发布；PyPI
  `litellm` 1.103.0，要求 Python ≥ 3.10）；之后只有 `v1.104.0-rc.1` 预发布。镜像 `ghcr.io/berriai/litellm:v1.103.0`（amd64、arm64，
  cosign 签名，索引摘要 `sha256:bd089afd…5fd7`）；官方 compose 用的是浮动标签 `docker.litellm.ai/berriai/litellm:main-stable`，本包刻意钉住版本号。
  镜像入口 `docker/prod_entrypoint.sh` → `litellm "$@"`，默认 `--port 4000`；健康检查 `GET /health/liveliness`
  （[官方 docker-compose.yml](https://github.com/BerriAI/litellm/blob/v1.103.0/docker-compose.yml)）。
- 路由：[`proxy_server.py`](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/proxy_server.py) 注册
  `/v1/chat/completions`、`/chat/completions`、`/openai/deployments/{model}/chat/completions`，`/v1/embeddings` 同理，WebSocket
  `/v1/realtime`；[`response_api_endpoints/endpoints.py`](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/response_api_endpoints/endpoints.py)
  注册 `/v1/responses`、`/responses`、`/openai/v1/responses`、`/v1/responses/compact` 与 WebSocket `/v1/responses`；
  [`anthropic_endpoints/endpoints.py`](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/anthropic_endpoints/endpoints.py)
  注册 `/v1/messages`、`/v1/messages/count_tokens`。
- 密钥：[`_types.py` 的 `SpecialHeaders`](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/_types.py)——`Authorization`、
  `API-Key`、`x-api-key`、`x-goog-api-key`、`Ocp-Apim-Subscription-Key`、`x-litellm-api-key`，外加 `litellm_key_header_name`；密钥应以
  `sk-` 开头（[`user_api_key_auth.py`](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/auth/user_api_key_auth.py)）。
  文档：[虚拟密钥](https://docs.litellm.ai/docs/proxy/virtual_keys)、[Docker 快速开始](https://docs.litellm.ai/docs/proxy/docker_quick_start)、
  [回调钩子](https://docs.litellm.ai/docs/proxy/call_hooks)。
- 回答的 `model`：[`common_request_processing.py` 的 `_override_openai_response_model`](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/common_request_processing.py)
  把它改写成客户端请求的名字；例外是发生回退（保留实际作答的模型组）等。Anthropic 流由 `anthropic_endpoints/streaming_model_restamp.py` 同样改写。
- 流：Chat 是 `data: {json}\n\n` 块、以 `data: [DONE]\n\n` 结束，`include_usage` 的 usage 块带 `choices: [{"index":0,"delta":{}}]`；
  Responses 事件**只有 `data:` 行**（没有 `event:` 行）并以 `data: [DONE]` 结束；Messages 是 Anthropic 原生的 `event:`/`data:` 事件。
  SSE 保活默认关闭：`sse_keepalive_ping_interval_seconds` 发 `: ping` 注释，`anthropic_sse_ping_interval_seconds` 发 `event: ping`
  （`litellm/constants.py`、`proxy/common_utils/sse_keepalive.py`）。
- 响应头：每个回答带 `x-litellm-call-id`、`x-litellm-model-id`、`x-litellm-version`、`x-litellm-response-cost` 等，以及上游头的
  `llm_provider-*` 副本（`common_request_processing.py` 的 `get_custom_headers`）。

**实测（2026-09-29，本机 macOS，无 Docker）：** `pip install 'litellm[proxy]==1.103.0'`（Python 3.12）在本地起 proxy，模型指向模拟上游，
`e2e.mjs` 18 项全部通过（原始调用 6 项；`openai` 7.23.0 与 `@anthropic-ai/sdk` 0.128.0 经 strict 核验 11 项，Chat、Responses、Messages
各含流式与非流式，Messages 另有 Claude Code 的 `Authorization: Bearer` 传法；对照组 1 项）。上面“流”一条的格式就是在这次运行里看到的。**`docker-compose.yml` 与 `Dockerfile` 没有在本机实测**
（本机没有 Docker）：镜像标签、入口与健康检查按上面的源码核对，旁路镜像的构建方式与 new-api 包相同（多一个命名构建上下文）。

## English

**For** teams that already serve an AI API through [LiteLLM Proxy](https://github.com/BerriAI/litellm) (the AI gateway)
and operate within their upstream providers' terms.

**What it does**: a signing sidecar (`@tapeapi/server/ai-proxy`) goes **in front of** LiteLLM; LiteLLM itself does not
change by one byte. Users → your HTTPS reverse proxy → `tapeapi-sidecar:8080` (passes `/v1/*` through byte for byte and
signs a usage receipt for every answer) → `litellm:4000/v1` (model list, virtual keys, budgets, rate limits and spend
tracking as before) → your providers.

You get an on-chain identity (a TapeOut circuit's container), the endpoints and price table pinned on chain, and a signed
usage receipt for every call. **Your users change no code**: they keep the virtual keys (`sk-...`) LiteLLM issued them
and their official SDKs; only the base URL points at the sidecar. In front rather than a LiteLLM Python callback: a
callback sees LiteLLM's parsed Python objects, not the bytes the client sends and receives, which are what a receipt
proves, and it would need a second implementation of receipt signing in Python (see Sources). **TapeAPI never hosts the
sidecar for you**: it sees your users' API keys, so only you run it.

### Three steps

You need a server with Docker and Docker Compose 2.17 or later, a domain and your HTTPS reverse proxy, a TapeOut
circuit with its container opened, and a checkout of this repository:
`git clone https://github.com/BruceLanLan/tapeapi.git && cd tapeapi/examples/litellm-sidecar`.

1. **Fill in `.env`, LiteLLM's config and the price table.** `cp env.example .env && chmod 600 .env` (generate
   `LITELLM_MASTER_KEY`, `LITELLM_SALT_KEY` and `POSTGRES_PASSWORD`, left empty on purpose, as the comments say),
   `cp config.example.yaml config.yaml` (LiteLLM's model list) and `cp models.example.json models.json` (the price
   table published on chain), then edit them. One rule: **every `id` in `models.json` must be a `model_name` in
   `config.yaml`**. LiteLLM 1.103.0 restamps the answer's `model` to the public name the client asked for, and the
   sidecar prices by that name, exactly. After a fallback LiteLLM reports the model group that actually answered, so
   list fallback targets in `models.json` too, each with its own prices. An unmatched answer still gets a signed
   receipt, with `prices: null` (logged once). The table's shape (the frozen `prices[]` of TAPI-20 §3.9) is the new-api
   package's. Already running LiteLLM? Keep your own config and write `models.json` after its `model_name`s.
2. **Start.** `docker compose up -d`, then `docker compose logs -f tapeapi-sidecar` (SETUP MODE at first is expected).
   Three services: `litellm` (the official image `ghcr.io/berriai/litellm:v1.103.0`), its `db` (PostgreSQL: virtual
   keys, budgets and spend) and `tapeapi-sidecar`, all on the host's loopback: the sidecar on `127.0.0.1:8080`, LiteLLM
   on `127.0.0.1:4000`, the database not published. Point only `PUBLIC_URL` at `127.0.0.1:8080` in your reverse proxy.
   **Never publish LiteLLM's own port**: reach its admin UI (`/ui`) and key management over an SSH tunnel or your VPN,
   or users can call around the sidecar and those calls carry no receipt. Issue virtual keys with the master key
   (`POST /key/generate`, example above). Nginx: `proxy_buffering off;`, `proxy_read_timeout 600s;`,
   `client_max_body_size 32m;`, `proxy_set_header X-Real-IP $remote_addr;` and `CLIENT_IP_HEADER=x-real-ip` in `.env`.
   Already on LiteLLM's official compose? Add the `tapeapi-sidecar` service (with its `build`) on the same network,
   set `UPSTREAM_BASE_URL` to your LiteLLM service, and point the API hostname at the sidecar.
3. **Identity and the manifest, in the holder console at https://tapeapi.fun/console/**, exactly as in the new-api
   package: step 3 generates the service key (`SIGNER_KEY`, with `CIRCUITS`, `TOKEN_ID`, `CONTAINER`); step 4 reads the
   signer from `PUBLIC_URL/tapeapi/v1/health` and you sign the delegation (EIP-712, no funds move, 90 days); put
   `DELEGATION_EXPIRES` and `DELEGATION_SIG` in `.env`, `docker compose up -d`; step 5 publishes the manifest.

**Then tell your users**: same keys (LiteLLM virtual keys), new base URL, **with `/v1`**: OpenAI SDKs and compatible
tools use `https://api.example.com/v1`; the Anthropic SDK and Claude Code use `ANTHROPIC_BASE_URL=https://api.example.com`
(no `/v1`; the SDK adds it) with `ANTHROPIC_AUTH_TOKEN=<virtual key>`; Codex uses `base_url = "https://api.example.com/v1"`
with `wire_api = "responses"`. Users who want every call checked run `tapeapi-verify <your TapeOut name>` locally;
SDK users wrap the official SDK's fetch with `ai.createVerifyingFetch`.

### What users see

Nothing changes: the same answers, streams and errors, and LiteLLM's own headers (`x-litellm-*`, `llm_provider-*`)
arrive as they are. The only additions: a whole answer carries an `x-tapeapi-receipt` header, and an event stream
carries one SSE comment `: tapeapi-receipt …` before its end (clients ignore comments). The sidecar's own errors are
OpenAI-shaped, marked `x-tapeapi-sidecar-error: 1`, with no receipt. Failures LiteLLM returns (401 invalid key, 429
budget or rate limit, ...) are signed too, with no usage and no price claimed.

### Renewing the delegation

As in the new-api package ([its "Renewing the delegation"](../new-api-sidecar/README.md#renewing-the-delegation)): 90
days; `RENEW` in the log at every start in the last 30; an expired delegation puts the sidecar in setup mode (503).

### Limits

- **A receipt proves who answered, to which bytes, and what usage and price were claimed; it does not prove which model
  actually ran.**
- **Prices are published, not settled**: users pay through LiteLLM's budgets and spend as today.
- The sidecar forwards `/v1/*` only and signs `POST /v1/chat/completions`, `/v1/responses`, `/v1/responses/compact`,
  `/v1/messages` and `/v1/embeddings`; other `/v1` paths (`/v1/models`, `/v1/messages/count_tokens`, `/v1/completions`,
  images, audio, ...) pass through without a receipt. LiteLLM's paths without `/v1` (`/chat/completions`, `/responses`,
  `/openai/v1/responses`, `/openai/deployments/...`), its provider pass-through routes (`/anthropic/...`, `/gemini/...`)
  and WebSockets (`/v1/realtime`, `/v1/responses`) do **not** go through the sidecar.
- Keys travel as `Authorization: Bearer` or `x-api-key` only (as the official SDKs send them). `x-litellm-api-key`,
  `API-Key`, `x-goog-api-key`, `Ocp-Apim-Subscription-Key` and a custom `litellm_key_header_name`, which LiteLLM also
  accepts, are **not** forwarded; nor are request headers such as `x-litellm-tags` or `x-litellm-timeout` (set those on
  the key or the model).
- LiteLLM sees every request coming from the sidecar: `allowed_ips`, `use_x_forwarded_for` and per-IP logs see one
  address; per-key budgets and limits are unaffected. The sidecar limits per client IP itself (`RATE_IP`, default 600
  per minute; `0` leaves it to LiteLLM).
- LiteLLM's Responses ids are long (deployment details encoded in them, over TAPI-21's 128 characters), so those
  receipts carry a `tapeapi-…` id of the sidecar's; look receipts up by the receipt's id, not LiteLLM's.
- Caps: request body 32 MiB, non-stream answer 16 MiB and 600 s, a stream silent for 300 s is ended.

### FAQ

**Why not a LiteLLM callback?** See Sources: a callback does not get the exact bytes, and it means a second signing
implementation to keep in line with the test vectors.

**I add models in LiteLLM's UI (`STORE_MODEL_IN_DB`), not in `config.yaml`.** Fine; the rule is the same: every public
model name goes into `models.json`, and a changed price table is published again in step 5.

**My clients used a base URL without `/v1` (LiteLLM takes both).** Add `/v1`: the sidecar signs `/v1/*` only. A request
without `/v1` gets a 404 from the sidecar; it never goes around it, so there is no successful call without a receipt.

**Does LiteLLM's SSE keepalive (`sse_keepalive_ping_interval_seconds`, `anthropic_sse_ping_interval_seconds`) matter?**
Receipts verify as usual: the keepalive lines are SSE comments or Anthropic `ping` events, passed through and hashed.
But once a keepalive has committed a 200, a later upstream failure can only show as an error event in the stream, and
the receipt then says `complete: false`.

**Why does a Chat stream that did not ask for usage get a receipt with token counts?** The sidecar asks LiteLLM for
usage on the client's behalf (`stream_options.include_usage`), takes that chunk out of what the client receives and
marks the receipt `usageInjected: true`. LiteLLM's usage chunk differs from OpenAI's (it carries one empty choice);
`litellmFormats` recognises it.

**Before upgrading LiteLLM?** Run `e2e.mjs` against the new version first, and change the version in
`docker-compose.yml` only when it passes. LiteLLM releases often, and stream framing does change now and then. Should a later LiteLLM add `event:` lines to
Responses events (still ending with `data: [DONE]` or not), the receipt still comes once, before the end (the tests
cover both).

**Do I need PostgreSQL?** For virtual keys and budgets, yes (LiteLLM keeps them in its database). With the master key
alone LiteLLM runs without one, but then every user shares one key and there are no per-user budgets.

### Compliance and security

This package is for services operating **within their upstream providers' terms**; the protocol does **not** help with
evading an upstream provider's bans or regional restrictions. The sidecar sees your users' keys: run it yourself.
`SIGNER_KEY`, `LITELLM_MASTER_KEY`, `LITELLM_SALT_KEY` and the provider keys are secrets: keep them in `.env` only
(`chmod 600`; the repository's `.gitignore` ignores `.env`, `config.yaml`, `models.json` and `pgdata/`); `docker compose config` prints them. `.dockerignore` keeps `.env`, `config.yaml` and
`models.json` out of the image build. The sidecar stores no prompts and no answers, and runs as a non-root user on a
read-only file system with every capability dropped.

### Try it without Docker, and against a real LiteLLM

```sh
npm install --no-audit --no-fund                        # once, in tapeapi/
node examples/litellm-sidecar/smoke.mjs                 # the sidecar + a fake upstream reshaped as LiteLLM frames answers
node --test examples/litellm-sidecar/litellm-sidecar.test.mjs
python3 -m venv .venv && .venv/bin/pip install 'litellm[proxy]==1.103.0'
LITELLM_BIN=$PWD/.venv/bin/litellm node examples/litellm-sidecar/e2e.mjs
```

`smoke.mjs` needs no LiteLLM: it reshapes the repository's **fake** upstream (no real model, no real key) the way
LiteLLM 1.103.0 frames answers. `e2e.mjs` starts the fake upstream and a real LiteLLM in front of it (or uses
`LITELLM_URL` and `LITELLM_KEY`), checks six raw calls byte for byte, runs the official `openai` and `@anthropic-ai/sdk`
packages through a strict `ai.createVerifyingFetch` (Chat, Responses, Embeddings, Messages, streamed and not), and
checks the control: without `litellmFormats`, a strict client must refuse LiteLLM's Responses stream.

### Files

`docker-compose.yml` (LiteLLM from `ghcr.io/berriai/litellm:v1.103.0`, PostgreSQL 16 and the sidecar, all on loopback),
`Dockerfile` and `.dockerignore` (the sidecar image: `node:22-alpine`, `@tapeapi/sdk`, `@tapeapi/server` and the
new-api package's `server.mjs` from this checkout through compose's named build contexts), `server.mjs` (the new-api
package's entry with LiteLLM's profile: default upstream, log label, `litellmFormats`), `config.example.yaml`,
`models.example.json` (its ids are the config's `model_name`s), `env.example` (placeholders only), `smoke.mjs` and
`litellm-sidecar.test.mjs` (in `npm test`), `e2e.mjs` (needs LiteLLM; not in `npm test`).

### Sources

**Design: a sidecar in front, not a LiteLLM callback.** A receipt proves the **exact bytes** the client sent and
received. LiteLLM's callbacks ([`CustomLogger`](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/integrations/custom_logger.py):
`async_post_call_success_hook`, `async_post_call_streaming_iterator_hook`, `async_post_call_response_headers_hook`) get
parsed and rewritten Python objects: the request's `model` already routed, the answer serialized after the hook, stream
chunks framed with `data: ` after the hook, and the header hook runs before the body exists. A plugin could only
re-serialize and guess the bytes, and any LiteLLM upgrade could break the hashes; an in-stream receipt comment cannot be
written through hooks that yield objects. A plugin would also re-implement TAPI-21 envelope signing, usage normalisation
and the amount rules in Python, a second implementation to keep in line with `spec/vectors`; the sidecar is the frozen
`createAIProxy`, the same code as the new-api package and the Cloudflare Worker. And a plugin runs inside LiteLLM's
process, with the signing key in LiteLLM's environment. The sidecar's costs are two (only `/v1/*` is signed; LiteLLM
sees the sidecar's address), both acceptable. The one adjustment it needs (a Responses stream that ends at `data: [DONE]`
gets its receipt before it) changes only where the receipt goes, through `createAIProxy`'s public `formats` option (`litellmFormats` in `server.mjs`); the
signing, the hashes and every verifier are untouched.

**LiteLLM facts checked on 2026-09-29 (source at tag `v1.103.0`, commit `c991f4b`):**

- Version: latest stable release [v1.103.0](https://github.com/BerriAI/litellm/releases/tag/v1.103.0) (GitHub,
  2026-09-28, not a pre-release; PyPI `litellm` 1.103.0, Python ≥ 3.10); only `v1.104.0-rc.1` came after, as a
  pre-release. Image `ghcr.io/berriai/litellm:v1.103.0` (amd64, arm64, cosign-signed, index digest
  `sha256:bd089afd…5fd7`); the official compose uses the floating `docker.litellm.ai/berriai/litellm:main-stable`, this
  package pins the version on purpose. Entry point `docker/prod_entrypoint.sh` → `litellm "$@"`, default `--port 4000`;
  health `GET /health/liveliness` ([official docker-compose.yml](https://github.com/BerriAI/litellm/blob/v1.103.0/docker-compose.yml)).
- Routes: [`proxy_server.py`](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/proxy_server.py) registers
  `/v1/chat/completions`, `/chat/completions`, `/openai/deployments/{model}/chat/completions`, the same for
  `/v1/embeddings`, and the WebSocket `/v1/realtime`;
  [`response_api_endpoints/endpoints.py`](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/response_api_endpoints/endpoints.py)
  `/v1/responses`, `/responses`, `/openai/v1/responses`, `/v1/responses/compact` and the WebSocket `/v1/responses`;
  [`anthropic_endpoints/endpoints.py`](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/anthropic_endpoints/endpoints.py)
  `/v1/messages` and `/v1/messages/count_tokens`.
- Keys: [`SpecialHeaders` in `_types.py`](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/_types.py):
  `Authorization`, `API-Key`, `x-api-key`, `x-goog-api-key`, `Ocp-Apim-Subscription-Key`, `x-litellm-api-key`, plus
  `litellm_key_header_name`; keys are expected to start with `sk-`
  ([`user_api_key_auth.py`](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/auth/user_api_key_auth.py)).
  Docs: [virtual keys](https://docs.litellm.ai/docs/proxy/virtual_keys),
  [Docker quick start](https://docs.litellm.ai/docs/proxy/docker_quick_start),
  [call hooks](https://docs.litellm.ai/docs/proxy/call_hooks).
- The answer's `model`: `_override_openai_response_model` in
  [`common_request_processing.py`](https://github.com/BerriAI/litellm/blob/v1.103.0/litellm/proxy/common_request_processing.py)
  restamps it to the name the client asked for, except after a fallback (the group that answered is kept) and a few
  other cases; `anthropic_endpoints/streaming_model_restamp.py` does the same for Anthropic streams.
- Streams: Chat is `data: {json}\n\n` chunks ended by `data: [DONE]\n\n`, and the `include_usage` chunk carries
  `choices: [{"index":0,"delta":{}}]`; Responses events are **`data:` lines only** (no `event:` line), ended by
  `data: [DONE]`; Messages are Anthropic's native `event:`/`data:` events. SSE keepalives are off by default:
  `sse_keepalive_ping_interval_seconds` sends `: ping` comments, `anthropic_sse_ping_interval_seconds` sends
  `event: ping` (`litellm/constants.py`, `proxy/common_utils/sse_keepalive.py`).
- Response headers: every answer carries `x-litellm-call-id`, `x-litellm-model-id`, `x-litellm-version`,
  `x-litellm-response-cost` and more, plus `llm_provider-*` copies of the upstream's headers (`get_custom_headers` in
  `common_request_processing.py`).

**Measured on 2026-09-29 (macOS, no Docker):** `pip install 'litellm[proxy]==1.103.0'` (Python 3.12), a local proxy
whose models point at the fake upstream, and `e2e.mjs`: all 18 checks passed (6 raw calls; 11 through `openai` 7.23.0
and `@anthropic-ai/sdk` 0.128.0 in strict mode, Chat, Responses and Messages each streamed and not, Messages also with
Claude Code's `Authorization: Bearer`; 1 control). The
stream shapes above are what that run showed. **`docker-compose.yml` and `Dockerfile` were not run here** (no Docker on
this machine): the image tag, entry point and health check are checked against the source above, and the sidecar image is built
as the new-api package's is (with one more named build context).
