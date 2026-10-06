[English](../ai-providers.md) | 中文

# 接入 AI 服务

你已经在运营 AI 接口：用 new-api 搭的中转站、网关、聚合商，或者自己部署的开源模型。TapeAPI 在它前面加一个签名旁路。
你的接口、密钥和计费完全不变；你的用户照旧用官方 SDK，只改 base URL。

本指南面向在上游服务商条款范围内合规经营的服务方（见[合规](#合规)）。

## 从零到上线

从什么都没有（没有电路、没有容器）开始，每一步都先检查通过再做下一步。每一步的费用与运行都由你自己承担：TapeAPI 不托管任何人的
旁路，也不代付电路、容器或 gas。本指南里的 `42.1013.tape` 是示例名，链上没有以它发布的服务。命令里请换成你自己的 TapeOut 名字和
旁路地址。

第 0 步需要本仓库的检出，并在它的根目录安装一次依赖（Node.js 20 或以上）：

```sh
git clone https://github.com/BruceLanLan/tapeapi.git && cd tapeapi
npm ci --no-audit --no-fund
```

第 1 到 7 步的检查用 `tapeapi-doctor`（实验性），1.2.0 起随 SDK 的发布包提供。表里的每个 `tapeapi-doctor` 都指下面这条命令，
在任何目录都能运行，不需要克隆仓库：

```sh
npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.8.0/tapeapi-sdk-1.8.0.tgz tapeapi-doctor <你的名字>
```

在检出的根目录里，`node sdk/bin/tapeapi-doctor.js <你的名字>` 效果相同。两种方式下，报告给出的下一条命令都按你的运行方式书写。

| # | 步骤 | 在哪里做（谁付费） | 检查 | 你应该看到 |
|---|---|---|---|---|
| 0 | 在本机看整条路径跑通：不需要密钥、电路，也不花钱 | 本仓库的检出，先在根目录运行 `npm ci`（见上） | `node examples/relay-trial/trial.mjs` | 打印“试跑通过。” |
| 1 | 取得一枚 TapeOut 电路 | [tapeout.net](https://tapeout.net)（由你购买） | `tapeapi-doctor <你的名字>` | `name`、`circuit` 通过 |
| 2 | 开通它的容器 | tapeout.net（一笔交易，gas 由你支付） | `tapeapi-doctor <你的名字>` | `container` 通过；第 2b 步之前 `activation` 警告；`manifest-file` 失败，第 5 步之前本该如此 |
| 2b | 激活名字（[TAP-10 §6.3](https://github.com/TapeOutProtocol/TAPs)）：不激活，按 TAP-11 的客户端会得到 `unpaid`、不解析你的服务 | 持有人的钱包在你所在链的 DomainBinding 上调用 `bind("<你的名字>", <你的容器>, <月数>)`，`msg.value` = 月数 × `monthlyFee()`（费用以 BNB、OKB 或 ETH 计，连同 gas 由你自己支付）；诊断会打印确切的调用和它刚从链上读到的费用，费用随时可能变化 | `tapeapi-doctor <你的名字>` | `activation` 通过，并显示付费至哪一天 |
| 3 | 在你的服务器上、你的 HTTPS 反向代理后面，把旁路放在你的网关前面运行 | [见下文](#选择旁路的运行方式)（你的服务器） | `tapeapi-doctor --offline https://api.example.com` | 报告列出设置模式下还缺的变量 |
| 4 | 服务密钥与委托；把值填进 `.env` 并重启旁路 | [持有人操作台](https://tapeapi.fun/console/)第 3、4 步（不收费、不花 gas） | `tapeapi-doctor https://api.example.com` | `delegation`、`reach`、`receipt` 通过；`manifest-file` 警告“尚未发布上链” |
| 5 | 发布清单（含价目表） | 操作台第 5 步（一笔交易，gas 由你支付） | `tapeapi-doctor <你的名字>` | 全部通过：退出码 0 |
| 6 | 告诉你的用户 | [你的用户要做什么](#你的用户要做什么) | 在用户机器上运行 `tapeapi-verify <你的名字>` | 每次调用一行 `OK` |
| 7 | 每 90 天续期委托，并让激活保持有效 | 操作台第 4 步“续期”；按第 2b 步再次付费 | `tapeapi-doctor <你的名字>`，在你的 CI 里每天跑 | 到期前 30 天起 `delegation` 警告；名字不再有效时 `activation` 警告 |

`tapeapi-doctor` 按顺序检查：名字能解析、电路存在、容器已开通、名字已激活（TAP-10 §6.3；只警告：站点文件仍可读，但按 TAP-11 的客户端会得到 `unpaid`、不解析这个服务）、链上有清单文件、清单格式、委托（及剩余天数）、`ai` 字段、价目表、
端点、端点可访问（TLS、旁路已退出设置模式、它签名用的密钥）、CORS、真实请求拿到可核验的回执、按 id 取回执。那次请求不花钱：
它带一个不可能有效的密钥，你的网关拒绝它，旁路对这个拒绝同样签回执。如果你的网关接受任意密钥，它就会真的作答，每次运行每个端点
会花掉你几个输入 token 加 1 个输出 token（`openai-responses` 为 16 个，这是它的下限），`receipt` 检查随之警告你修好网关鉴权。
`--key-env VAR` 会用你自己的密钥在每个端点再做一次同样大小的真实调用，费用按你的网关计。这把密钥只发往被检查的主机（你给出的 URL；
名字则为其已签名 `endpoints.live` 的主机），绝不发往清单指定的其它主机，且只走 https（仅对回环地址上的旁路、并加 `--allow-http`
时允许 http）；报告里的每段文字（含 `--json`）都把它显示为 `***`，即使网关把它回显出来。每项失败都用中英双语说明缺什么、去哪改、
下一条命令。退出码：0 通过（允许警告；`--strict` 时警告也算失败），1 有检查失败，2 用法错误，3 链或网络读不到（超时、拒绝连接、
DNS：请重试）；`--json` 输出供 CI 使用的报告；`--lang en` 或 `--lang zh` 只输出一种语言。它只读：不签任何东西、不发交易。
给它旁路地址时，它探测的就是这个地址，而不是旁路提供的清单里发布的地址；两者不同时会警告。它是实验性的：检查项与输出在 1.x
版本里仍可能变化。

全部检查通过后，你可以自己提一个拉取请求，把服务的名字加进 `site/directory/providers.json`，登记到[服务方目录](https://tapeapi.fun/directory/)
（步骤见 [`directory/`](https://github.com/BruceLanLan/tapeapi/tree/main/directory)）。目录每天对每一条重新运行诊断并显示结果。
登记只代表通过了自动检查，不代表推荐、担保或审计；不登记，你的服务照样可用。

## 你得到什么

- **链上身份。** 服务就是一枚 TapeOut 电路的容器。谁在回答，查链就知道；换域名、换服务器，用户按链上记录自动跟随。
- **钉在链上的价目表。** 清单的 `ai` 字段（[TAPI-20 §3.9](../../../spec/TAPI-20.md)）列出每种 API 格式一个端点，以及你的价目表：
  每个模型、每个币种一个价格，按每百万 token 计，需要时再加缓存价与推理价。任何人都能重算一次调用应当多少钱。
- **每次调用一份签名的用量回执**（[TAPI-21 §3.5](../../../spec/TAPI-21.md)）：模型、token 数、各币种金额、回答是否完整，以及确切的
  请求字节与回应字节的哈希，由电路持有人委托的密钥签名。回执随回答一起送达（一个响应头，或官方 SDK 会忽略的 SSE 注释），
  不读回执的客户端什么都不受影响。唯一的例外：在旁路签名点之前出现以 U+FEFF 开头的行的流不会得到回执，因为各客户端对这种行的
  读法不同，没有哪份回执能说明它们看到了什么。
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
| **LiteLLM Proxy** | docker-compose 一键包：LiteLLM（带它的 PostgreSQL）加上它前面的旁路，都只在回环地址上，由你的 HTTPS 反向代理对外；价目表的 `id` 就是 LiteLLM 的 `model_name` | [`examples/litellm-sidecar/`](../../../examples/litellm-sidecar/) |

旁路放在网关**前面**，不嵌进网关里面：new-api 的文本转发没有钩子，LiteLLM 的回调拿到的是解析后的 Python 对象、不是回执要证明的字节；而且放在前面，回执覆盖的才是你向自己用户收取的价格与用量。

### new-api 一键包速览

```sh
git clone https://github.com/BruceLanLan/tapeapi.git && cd tapeapi/examples/new-api-sidecar
cp env.example .env && cp models.example.json models.json     # 两个都要填
docker compose up -d
```

在这个目录里，检出自带的诊断是 `node ../../sdk/bin/tapeapi-doctor.js`；表里的 `npx` 写法在任何目录都能用。

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

### 用控制台发布价目表

操作台第 5 步发布旁路的清单，包括 `ai` 字段：

1. **预览（可选，不需要钱包）。** 在第 5 步粘贴或上传 `models.json`（旁路的价目表，一个模型数组）、`ai` 字段本身，或整份清单。
   `models.json` 里没有接口地址，页面按第 4 步的服务网址为每种格式补上一个端点，与旁路的做法完全相同（OpenAI 各格式加 `/v1`，
   Anthropic Messages 就是服务根）。页面按与 SDK 的 `validateAIField` 相同的规则（TAPI-20 §3.9）核对，并列成表：每种接口格式及其
   地址；每个模型的 id、别名，以及各币种的输入、输出、缓存读、缓存写、1 小时缓存写与推理价格，单位都是每 1M tokens。清单没有单列的
   价格以灰色斜体显示规范给它的值（缓存价缺省取 `input`，1 小时缓存写取 `cacheWrite`，推理取 `output`）。
2. **只提示，不拦截。** 表格里高亮、表格下面列出可能填错的地方：价格为 0；价格远高于任何模型（按币种，例如每 1M tokens 高于
   1,000 USDT：是不是漏了小数点？）；输出价低于输入价；缓存读比输入贵；客户端会忽略的端点；`USD`（只作展示）；价目表太大、一笔
   交易装不下。这些都不会阻止发布，由你决定。
3. **核对并发布。** 页面读取旁路提供的清单，照旧逐项核对，并按 SDK 的规则核对 `ai` 字段；如果你预览过价目表，服务提供的必须与它
   一字不差。页面再展示一次价目表，然后请钱包确认那一笔 `SiteRegistry.putFile` 交易。第 4 步的委托只覆盖签名密钥，把价格写上链的
   是这笔交易。
4. **回读核对。** 交易上链后，页面像每个客户端一样从链上读回清单（长度与 SHA-256 对照 SiteRegistry），确认链上的字节（包括价目表）
   正是它发出的。

价格在所有链上都只是公示，不结算。操作台可以在 BNB Chain、X Layer 与 Base 上发布；X Layer 与 Base 上支付暂不开放，页面会写明：
那里的价目表只作展示。按 TAPI-20 §3.9，币种 `BNB`、`USDT`、`USDC`、`ETH`、`USD1` 指 BNB Chain 上的代币。

**续期。** 在委托的最后 30 天内续期：操作台第 4 步选“续期”（服务密钥不变），设置新的 `DELEGATION_EXPIRES` 与 `DELEGATION_SIG`，
重启旁路，再发布一次清单。委托过期后服务会停止，直到续期。

## 你的用户要做什么

密钥和 SDK 都不变，只把 base URL 换成你清单里对应格式的端点：

| 客户端 | base URL |
|---|---|
| OpenAI SDK 与各类 OpenAI 兼容工具 | `https://api.example.com/v1` |
| Anthropic SDK、Claude Code（`ANTHROPIC_BASE_URL`） | `https://api.example.com`（SDK 自己加 `/v1`） |
| Codex（`OPENAI_BASE_URL`，或 `config.toml` 里的 `base_url` 加 `wire_api = "responses"`） | `https://api.example.com/v1` |

**核验回执。** 开发者包裹官方 SDK 的 fetch；之后每个回答都会对照链上清单核验（signer、价目表、确切字节），核验失败就报错，从不静默吞掉：

```js
import OpenAI from 'openai'
import { createTapeAPI, rpcUrlsFor, ai } from '@tapeapi/sdk'

const api = createTapeAPI({ rpcUrls: rpcUrlsFor(56) })            // 不同运营方的 BNB Chain 节点，两家一致才算
const svc = await api.resolve('42.1013.tape')                    // 你的服务的 TapeOut 名字（这里是示例名）
const fetch = ai.createVerifyingFetch({ api, service: svc })
const baseURL = svc.manifest.ai.endpoints.find((e) => e.format === 'openai-chat').baseUrl
const client = new OpenAI({ baseURL, apiKey: process.env.API_KEY, fetch })  // 用户在你这里的密钥，照旧
```

请原样使用清单里的 `baseUrl`。发往任何其它主机（`localhost` 对 `127.0.0.1`、端口不同）的计量路径请求，会在发送之前以
`INVALID_ARGUMENT` 拒绝，并写明期望的端点；`strict: false` 时照常发出，`onReport` 报告 `not verified: endpoint mismatch`。
计量路径的宽松写法（`/v1//chat/completions`、`/v1/chat/%63ompletions`、结尾多一个 `/`）也一样，OpenAI 与 Anthropic 照样会回答它们：
报告为 `not verified: path mismatch`。
流式回答同样会核验。流在最终事件、`[DONE]` 或连接关闭时结束（先到者为准）；在默认的 `strict: true` 下，结束的那一段要等结束
之前到达的回执核验通过才放出，核验不过的流会让 SDK 的迭代器抛出 `RECEIPT_INVALID`。`strict: false` 时不扣留任何内容，结论交给
`onReport`。回执核对的是流在结束那一点的样子，与网络怎样把字节切成块无关。strict 下流只转交到结束处并在那里关闭，结束之后的
内容不会到达应用；连接在某个事件中途关闭的流，或含以 U+FEFF 开头的行的流（SDK 与回执规则对这两者的读法不同），以
`RECEIPT_INVALID` 失败。`strict: false` 时这些只报告出来，结束之后的事件也一样（下面的 `tapeapi-verify` 同样如此）。
对手里的整条流调用 `verifyUsageReceipt({ responseBytes })` 会对其中每个事件取哈希（TAPI-21 §3.5），所以对结束之后还有事件的流，
它的结论可能与流式核验不同。strict 下，核验不过的整体（非流式）回答会变成一个 HTTP 502：按该 API 的错误格式，code 为 `RECEIPT_INVALID`，
带 `x-should-retry: false` 与 `x-tapeapi-verify-error: RECEIPT_INVALID` 两个头；官方 SDK 抛出 `APIError` 且不重试，自己调用
这个 fetch 的代码检查 `res.ok`。付费调用在其它 5xx 上是否自动重试，由你自己决定（SDK 的 `maxRetries`）。

**Claude Code 与 Codex 用户**自己读不到回执。他们在本机运行核验代理 `tapeapi-verify`，把客户端指向它。`tapeapi-verify`
会一直在前台运行，所以客户端要在第二个终端里启动：

```sh
# 终端 1。42.1013.tape 是示例名：换成你的服务的 TapeOut 名字
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

照原样用示例名运行会停在 “no file at /.well-known/tapeapi.json”：链上没有以 `42.1013.tape` 发布的服务。还没有自己的服务？
先跑本地试跑（[从零到上线](#从零到上线)第 0 步）：它会让这个代理对着本地旁路跑一遍。

它在链上解析你的服务，回答原样透传，每次调用打印一行结论；加 `--strict` 时，核验失败会变成客户端看得到的错误。单份回执也可以贴到
[核验页](https://tapeapi.fun/verify/)。这些都需要你的清单已经上链（操作台第 5 步，见上文）。

**请求加盐（两者默认开启）。** 回执带 `requestSha256`，即确切请求字节的 SHA-256，而官方 SDK 每次都用同样的方式序列化请求。于是
短提示词（"是"、一个要做嵌入的词、已知问题清单里的一问）可以通过对猜测取哈希，从别人分享的回执上确认出来。所以 `createVerifyingFetch`
与 `tapeapi-verify` 会在回执路径上每个请求正文的 JSON 文本之后追加 64 个随机空白字符（空格、制表、换行、回车，共 128 个随机比特），
回执按实际发出的字节核验。

- **为什么不影响提示词缓存：** JSON 允许值之后出现空白（RFC 8259 §2），上游解析出的请求完全相同。这些空白在所有字符串之外，
  不属于任何消息，也不会变成 token；缓存（OpenAI 的自动前缀缓存、Anthropic 的 `cache_control` 断点）按解析后提示词的 token 取键，
  而 token 完全一样。
- **不增加、也不修改任何字段。** 尤其是 `user`（OpenAI）和 `metadata.user_id`（Anthropic，Claude Code 本来就会设置）保持客户端
  写的样子：网关靠它们把同一段对话路由到同一个账号，缓存才能命中。
- **不处理的：** 压缩过的正文（`Content-Encoding` 不是 `identity`，追加会破坏它）、非 JSON 正文，以及所有不出回执的路径。
  `salt: false` / `--no-salt` 完全按客户端写的字节发送。
- 如果客户端与旁路之间有代理重新序列化请求，字节本来就会变；这时回执核验会在 `requestSha256` 上失败，这样的代理因此会暴露出来。
- **尚未实测：** 按 JSON 语法，所有上游都必须接受尾随空白，测试也对参考旁路验证过；对 OpenAI Chat、OpenAI Responses、
  Anthropic Messages 线上接口的实测还没有做。

## 流式 Chat 的用量：三条路

OpenAI Chat 的流只有在请求把 `stream_options.include_usage` 设为 `true` 时才报告 token 用量：流的末尾会多一个块，`choices: []`，带着用量。
官方 `openai` 包不会自己设它（写作时为 7.x），所以普通的 `chat.completions.create({ stream: true })` 根本拿不到用量。本节说的就是这种情形：
流式调用 `/v1/chat/completions` 的 OpenAI Chat 客户端（`openai` 各语言 SDK 与说同一种 API 的工具）。Claude Code（Anthropic Messages）与
Codex（OpenAI Responses）不受影响：它们的流不论要不要都带用量，回执的用量会与之比对。Embeddings 不流式。

| | 谁向上游要用量 | 应用是否收到用量块 | 回执的用量是否与流比对 |
|---|---|---|---|
| 1. 默认 | 旁路自己 | 否：旁路把它去掉 | 否：列入 `unchecked` |
| 2. 应用自己要 | 应用，在它的请求里 | 是，多一个块 | 是 |
| 3. `requestUsage` / `--request-usage` | 核验方，在请求的字节里 | 是，多一个块 | 是 |

### 1. 默认：旁路替你要，你比对不了

流式请求没要用量时，旁路向上游发一份要用量的副本，从由此多出的那个块里读到用量，并把这个块从你的客户端收到的内容里去掉，所以你拿到的恰好是你要的回答。
回执写 `usageInjected: true`，并给出旁路读到的用量。你的客户端从没见过那个块，没有东西可以拿来比对这个数：它的报告把用量列入 `unchecked`
（"usage (usageInjected: the answer the client received lacks the usage chunk the sidecar read)"），核验页也会说用量没有比较。

- **能保证的：** 签名方、模型、回答是否完成，以及请求与响应的哈希确实是你发出与收到的字节的哈希。价格按回执里的用量重算。
- **不能保证的：** 用量这个数。它是旁路的一句陈述，你手里没有任何东西能反驳它：旁路可以签一个更高的数，其余所有检查照样通过。整体（非流式）
  回答与其它 API 格式没有这个缺口。

### 2. 自己要用量

在请求里设 `stream_options: { include_usage: true }`（Python：`stream_options={"include_usage": True}`）。旁路看到请求已经要了，就不注入、
不去掉、也不设 `usageInjected`。用量块是回执所哈希的流的一部分，也是应用收到的内容的一部分，核验的客户端因此会拿回执的用量与它比对。
不花任何费用，也不需要我们的任何选项：

```js
const stream = await client.chat.completions.create({
  model: 'your-model', stream: true,
  stream_options: { include_usage: true },        // 最后一个块 choices: []，带着用量
  messages: [{ role: 'user', content: 'Hello' }],
})
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '')
```

### 3. 让核验方替你要：`requestUsage`

应用不想改，或者改不了（一个从不设 `stream_options` 的工具）时，由核验方替它设这个成员。`createVerifyingFetch({ requestUsage: true })`，或
`tapeapi-verify --request-usage`（1.6.0 起），默认关；只有 `true` 才会开启这个选项。

```js
const fetch = ai.createVerifyingFetch({ api, service: svc, requestUsage: true })
```

```sh
tapeapi-verify --request-usage 42.1013.tape        # 启动方式见“你的用户要做什么”
```

效果与第 2 条相同：旁路什么都不注入，用量块在应用收到的、被签名的流里。这个选项做什么、不做什么：

- **只在旁路本来会改的地方改请求：** 没有把 `stream_options.include_usage` 设为 `true` 的流式 OpenAI Chat 请求。已经要了用量的请求、
  不是流的请求、其它 API 格式，都原样发送。
- **只改字节里的一处，其余字节一概保留。** 没有 `stream_options`：在最后一个成员之后加 `,"stream_options":{"include_usage":true}`。
  有 `stream_options` 对象但没有 `include_usage`：在它里面加 `,"include_usage":true`。`include_usage` 是别的值（`false`、`null`、`"true"`……）：
  把值替换成 `true`。`stream_options` 不是对象（`null`、数组、字符串）：整个值替换成 `{"include_usage":true}`。改写结果在发送前要对照旁路自己的规则
  自检。然后加盐、发出；`requestSha256` 是最终发出的字节的哈希。
- **改不安全时不改：** 压缩过的正文；Content-Type 不是 JSON；正文不是 UTF-8 或以字节序标记开头；自定义格式没有给出要设的成员；顶层或
  `stream_options` 里有重复的键；改写结果没通过自检。在 `strict` 下（`createVerifyingFetch` 的默认），SDK 在发送任何东西之前抛
  `INVALID_ARGUMENT`（`data.reason` 写明原因），`tapeapi-verify --strict` 回 HTTP 400（`usage_request_skipped`，带 `x-should-retry: false`）且不转发。
  非 strict 时请求原样发出，报告写 `usageRequestSkipped: <原因>`，用量与第 1 条一样是 `unchecked`。
- **报告。** 选项开启时每份报告带 `usageRequested`：这个 fetch 设了成员为 `true`，没设为 `false`（应用自己要了、不是 Chat 流，或改写被跳过）。
  选项关闭时没有这个字段。`tapeapi-verify` 把同样的字段写进 `--log`，并在结论行打印 `usage=asked` 或 `usage-request-skipped=<原因>`。
  要了用量而流里没有（上游没发，或途中有人去掉了），会有一条相应的警告。

**应用会看到什么（第 2、3 条）。** `[DONE]` 之前多一个块，`choices: []`，带着用量；客户端什么都不剥。不先检查列表是否为空就读 `chunk.choices[0]`
的代码会在这个块上出错（JavaScript SDK 里是 `TypeError`），改读 `chunk.choices[0]?.delta`。`openai` 包的 `.stream()` 助手照常工作，
`finalChatCompletion().usage` 有值。不剥块的理由：这样应用手里的字节恰好就是回执所哈希的字节，存档的流还能离线核验（核验页、争议）。

**第 2、3 条保证什么，不保证什么。** 回执里的用量就是应用收到的、被签名的流里的用量，与整体回答已有的标准相同。旁路在回执里写一个数、在流里发另一个数，
核验会失败（`RECEIPT_INVALID`）；在两处都夸大用量的旁路，则是把它签进了一个你可以拿给别人看的回答：可归责，而不是不可能。两条路都不能说明上游
真正数了多少：签回执的旁路同时也产出这个流。请照实告诉你的用户。

**局限，以及第 3 条为什么默认关。**

- JSON 正文配了非 JSON 的 Content-Type 时，客户端会跳过，但旁路不看 Content-Type，照样注入：这次调用的用量无法核验，strict 下会在本地被拒绝。
- 不理会 `include_usage` 的上游不会发用量块：此时回执以用量 `null` 通过，报告会给出警告。
- 如果你的上游不认 `stream_options`、所以你的旁路不替客户端要用量（参考旁路没有这个开关，只有传入自定义 `formats`、让其中 Chat 适配器没有
  `prepareUpstream` 这一条路），客户端一旦开了第 2 或第 3 条，就会从你的上游收到 HTTP 400。明明请求已经要了用量、
  却把用量块去掉的旁路，在 `strict` 下会通不过核验（按规则是对的，但损失了可用性）。
- 盐现在也会到达这类请求的上游（重新序列化请求的旁路以前会把它丢掉）：它是 JSON 文本之后的空白，JSON 允许。
- `strict` 下，官方 SDK 可能把 `INVALID_ARGUMENT` 当作连接错误包装起来，并按 `maxRetries` 重试（未实测；每次重试都不会发出任何请求）。

## 费用

没有强制协议费，今天协议也不收任何费用：`ai` 字段里的价格只是公示、不结算，付费调用用的托管合约还没有部署（要先通过独立审计）。
以后付费调用经由 TapeAPI 托管合约结算时，默认从服务方所得中扣 1% 作为维护贡献（用户的价格不变）；任何服务方都可以为自己的服务
把它设为 0，运营方没有费率开关。见 [`docs/FEES.md`](../../FEES.md)。

## 局限

- 回执证明谁回答的、声称了什么，不证明运行的是哪个模型（见上）。
- 流式 OpenAI Chat 回答的用量，只有请求要了用量（`stream_options.include_usage`，由应用或由 `requestUsage` 设置）才会被核验；默认情况下它只是旁路的一句陈述（见[上文](#流式-chat-的用量三条路)）。
- 带回执的格式：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、OpenAI Embeddings。`/v1` 下的其它路径原样透传、不带回执。
  暂不支持：Gemini 原生接口、WebSocket 模式（Realtime、Responses WebSocket）、Batch。
- 回执在旁路内存里保留一小时（可配置）；随回答送达的那一份才是主要的。免费的 `receipt` 方法按 IP 单独限流。如果你的上游回答 id
  可以猜（Ollama 的是 `chatcmpl-` 加一个小于 999 的数，旁路日志会提示），请打开 `requireRequestHash`（`RECEIPT_REQUIRE_HASH=1`），
  让取回执必须同时给出请求哈希。
- 旁路自己不做鉴权：用户的密钥原样交给你的网关，由网关决定。
- 旁路会把客户端的会话头（`x-claude-code-session-id`、`session-id`、`thread-id`）转发给你的网关（客户端期望如此）；拿到它们的
  一方能把同一用户的请求串成一段会话。设 `FORWARD_SESSION_HEADERS=0`（`forwardSessionHeaders: false`）即不转发；用户也可以在
  自己这一侧用 `tapeapi-verify --strip-session-headers` 做到同样的事。

## 合规

TapeAPI 面向**在上游服务商条款范围内合规经营**的服务方。身份、价目与信誉在链上，不被任何单一平台绑架；但本协议**不**提供、
也**不**帮助规避上游服务商的封禁或地区限制。

## 安全

- 旁路经手用户的 API 密钥。请自己运行，放在你自己的机器或账户上；不要交给任何第三方托管。
- 服务密钥（`SIGNER_KEY`）为每份回执签名。不要让它进 git、聊天或截图；一旦泄露，在操作台生成新密钥并重签委托，而不是续期。
- 旁路不保存提示词或回答：它只把签过名的回执（哈希、模型、token 数、金额）保留一小时，别无其它。

为 TapeOut 做一个服务层的想法来自 [@Theairresearch](https://x.com/Theairresearch/status/2101640697426448632)。
