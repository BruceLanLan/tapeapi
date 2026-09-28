[English](../ai-providers.md) | 中文

# 接入 AI 服务

你已经在运营 AI 接口：用 new-api 搭的中转站、网关、聚合商，或者自己部署的开源模型。TapeAPI 在它前面加一个签名旁路。
你的接口、密钥和计费完全不变；你的用户照旧用官方 SDK，只改 base URL。

本指南面向在上游服务商条款范围内合规经营的服务方（见[合规](#合规)）。

## 你得到什么

- **链上身份。** 服务就是一枚 TapeOut 电路的容器。谁在回答，查链就知道；换域名、换服务器，用户按链上记录自动跟随。
- **钉在链上的价目表。** 清单的 `ai` 字段（[TAP-20 §3.9](../../../spec/TAP-20.md)）列出每种 API 格式一个端点，以及你的价目表：
  每个模型、每个币种一个价格，按每百万 token 计，需要时再加缓存价与推理价。任何人都能重算一次调用应当多少钱。
- **每次调用一份签名的用量回执**（[TAP-21 §3.5](../../../spec/TAP-21.md)）：模型、token 数、各币种金额、回答是否完整，以及确切的
  请求字节与回应字节的哈希，由电路持有人委托的密钥签名。回执随回答一起送达（一个响应头，或官方 SDK 会忽略的 SSE 注释），
  不读回执的客户端什么都不受影响。
- **不托管任何东西。** TapeAPI 不持有你的密钥、资金或流量。旁路跑在你自己的机器上；身份和价目表在链上，不经过我们的任何服务器就能读取。
- **用户不用改代码。** OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 与 OpenAI Embeddings 逐字节透传，流式也一样。
  Claude Code、Codex 和官方 SDK 照常使用。

## 回执证明什么，不证明什么

回执证明的是：**谁回答的**（链上 signer）、**针对哪些确切的请求字节**、**给出了哪些确切的回应字节**、**声称了多少用量与价格**。
它**不**证明实际运行的是哪个模型：服务方可以把便宜模型的回答标成贵模型。签名带来的是这种替换**可追责**：回执不可抵赖，
抽检（任何人发测试题、公开结果）会留下证据。请对你的用户如实说明这一点。

## 选择旁路的运行方式

同一个旁路（`@tapeapi/server/ai-proxy` 的 `createAIProxy`）有几种包装。无论选哪种，都由你自己运行：它经手用户的 API 密钥，
所以 TapeAPI 永远不替你托管。

| 你在用 | 选这个 | 位置 |
|---|---|---|
| **new-api** | docker-compose 一键包：new-api 加上它前面的旁路，两者都只在回环地址上，由你的 HTTPS 反向代理对外 | [`examples/new-api-sidecar/`](../../../examples/new-api-sidecar/) |
| 任何 OpenAI 或 Anthropic 兼容接口，有服务器 | Node：示例入口，或把 `createAIProxy` 嵌进你自己的服务（它是 fetch 风格的处理函数） | [`examples/ai-proxy/index.mjs`](../../../examples/ai-proxy/index.mjs) |
| 这类接口，没有自己的服务器 | Cloudflare Worker，放在你自己的主机名上、你的接口前面 | [`examples/ai-proxy/worker.js`](../../../examples/ai-proxy/worker.js) |
| LiteLLM Proxy | 计划做成 LiteLLM 回调插件；在那之前，把 Node 或 Worker 版旁路放在 LiteLLM 前面 | 暂无 |

旁路放在网关**前面**，不嵌进网关里面：new-api 的文本转发没有钩子；而且放在前面，回执覆盖的才是你向自己用户收取的价格与用量。

### new-api 一键包速览

```sh
git clone https://github.com/BruceLanLan/tapeapi.git && cd tapeapi/examples/new-api-sidecar
cp env.example .env && cp models.example.json models.json     # 两个都要填
docker compose up -d
```

你的反向代理把 `https://api.example.com` 转给旁路（`127.0.0.1:8080`），把 new-api 的网页控制台用单独的主机名转给 `127.0.0.1:3000`。
身份变量设齐之前，旁路处于设置模式，并说明缺了什么。完整步骤、反向代理设置、如何把旁路加进已有的 new-api 部署、
以及如何不用 Docker 在本地试一遍，见一键包的 [README](../../../examples/new-api-sidecar/README.md)。

## 价目表

价目表是一个 JSON 数组；旁路把它发布在清单里，并按它为每份回执计价：

```json
[
  { "id": "claude-sonnet-4-5", "aliases": ["claude-sonnet-4-5-20250929"], "prices": [
    { "currency": "USDT", "unit": "1M tokens", "input": "3", "output": "15", "cacheRead": "0.3", "cacheWrite": "3.75", "cacheWrite1h": "6" }
  ] },
  { "id": "text-embedding-3-small", "formats": ["openai-embeddings"], "prices": [
    { "currency": "USDT", "unit": "1M tokens", "input": "0.02", "output": "0" }
  ] }
]
```

- 币种：`BEM`、`BNB`、`USDT`、`USDC`、`ETH`、`USD1`，或仅作展示的 `USD`；每个币种一项。
- 价格是按每百万 token 计的十进制字符串：`input` 与 `output`，可选 `cacheRead`、`cacheWrite`、`cacheWrite1h` 与 `reasoning`。
- 回执按上游**报告的**模型名，精确匹配每个 `id` 与别名。如果你的网关会改写模型名，把上游报告的名字写进 `aliases`，否则这些回执没有价格。
- **价格只是公示，现在不结算。** 用户照旧按现在的方式付费给你；回执里的金额是一个可以核对的声明，不是一笔付款。

## 身份与发布清单

身份的步骤与任何 TapeAPI 服务相同（见[运行服务](provide.md)），在持有人操作台 [tapeapi.fun/console](https://tapeapi.fun/console/)
完成：连接持有电路的钱包，生成服务密钥（它就是旁路的 `SIGNER_KEY`），签委托（操作台从旁路设置模式的健康检查里读出签名地址；
委托有效 90 天），然后把清单发布上链。

**现状：** 持有人操作台目前还不能发布带 `ai` 字段的清单。它的发布步骤只接受自己构造的字段（外加形状完全符合的 `mcp` 字段），
所以会拒绝旁路的清单，不发交易。生成密钥、签委托可以照常进行，旁路也会照常签回执；但清单上链之前，按 TapeOut 名字解析服务的
客户端找不到它。情况变化时本指南会更新。

**续期。** 在委托的最后 30 天内续期：操作台第 4 步选“续期”（服务密钥不变），设置新的 `DELEGATION_EXPIRES` 与 `DELEGATION_SIG`，
重启旁路，再发布一次清单。委托过期后服务会停止，直到续期。

## 你的用户要做什么

密钥和 SDK 都不变，只把 base URL 换成你清单里对应格式的端点：

| 客户端 | base URL |
|---|---|
| OpenAI SDK 与各类 OpenAI 兼容工具 | `https://api.example.com/v1` |
| Anthropic SDK、Claude Code（`ANTHROPIC_BASE_URL`） | `https://api.example.com`（SDK 自己加 `/v1`） |
| Codex（`config.toml` 里的 `base_url`，`wire_api = "responses"`） | `https://api.example.com/v1` |

**核验回执。** 开发者包裹官方 SDK 的 fetch；之后每个回答都会对照链上清单核验（signer、价目表、确切字节），核验失败就报错，从不静默吞掉：

```js
import OpenAI from 'openai'
import { createTapeAPI, rpcUrlsFor, ai } from '@tapeapi/sdk'

const api = createTapeAPI({ rpcUrls: rpcUrlsFor(56) })            // 不同运营方的 BNB Chain 节点，两家一致才算
const svc = await api.resolve('42.1013.tape')                    // 你的服务的 TapeOut 名字
const fetch = ai.createVerifyingFetch({ api, service: svc })
const baseURL = svc.manifest.ai.endpoints.find((e) => e.format === 'openai-chat').baseUrl
const client = new OpenAI({ baseURL, apiKey: process.env.RELAY_KEY, fetch })
```

**Claude Code 与 Codex 用户**自己读不到回执。他们在本机运行核验代理 `tapeapi-verify`，把客户端指向它：

```sh
npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v0.6.0/tapeapi-sdk-0.6.0.tgz tapeapi-verify 42.1013.tape
ANTHROPIC_BASE_URL=http://127.0.0.1:8790 claude          # Codex：OPENAI_BASE_URL=http://127.0.0.1:8790/v1 codex
```

它在链上解析你的服务，字节原样透传，每次调用打印一行结论；加 `--strict` 时，核验失败会变成客户端看得到的错误。单份回执也可以贴到
[核验页](https://tapeapi.fun/verify/)。这些都需要你的清单已经上链（见上面的现状）。

## 费用

没有强制协议费，今天协议也不收任何费用：`ai` 字段里的价格只是公示、不结算，付费调用用的托管合约还没有部署（要先通过独立审计）。
以后付费调用经由 TapeAPI 托管合约结算时，默认从服务方所得中扣 1% 作为维护贡献（用户的价格不变）；任何服务方都可以为自己的服务
把它设为 0，运营方没有费率开关。见 [`docs/FEES.md`](../../FEES.md)。

## 局限

- 回执证明谁回答的、声称了什么，不证明运行的是哪个模型（见上）。
- 带回执的格式：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、OpenAI Embeddings。`/v1` 下的其它路径原样透传、不带回执。
  暂不支持：Gemini 原生接口、WebSocket 模式（Realtime、Responses WebSocket）、Batch。
- 回执在旁路内存里保留一小时；随回答送达的那一份才是主要的。
- 旁路自己不做鉴权：用户的密钥原样交给你的网关，由网关决定。

## 合规

TapeAPI 面向**在上游服务商条款范围内合规经营**的服务方。身份、价目与信誉在链上，不被任何单一平台绑架；但本协议**不**提供、
也**不**帮助规避上游服务商的封禁或地区限制。

## 安全

- 旁路经手用户的 API 密钥。请自己运行，放在你自己的机器或账户上；不要交给任何第三方托管。
- 服务密钥（`SIGNER_KEY`）为每份回执签名。不要让它进 git、聊天或截图；一旦泄露，在操作台生成新密钥并重签委托，而不是续期。
- 旁路不保存提示词或回答：它只把签过名的回执（哈希、模型、token 数、金额）保留一小时，别无其它。

为 TapeOut 做一个服务层的想法来自 [@Theairresearch](https://x.com/Theairresearch/status/2101640697426448632)。
