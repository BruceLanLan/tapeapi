# 旁路前面的计费层

写给已经有自己的账户、余额和 API 密钥，并把 TapeAPI 签名旁路放在它们后面的运营方。旁路负责签名，你的计费层负责扣费。本页说明
两者怎样衔接、转发前冻结多少、记录什么、对用户怎么说。本页只讲 TapeAPI 的工具：TapeAPI 不运营、不托管、不登记、也不担保任何
这类服务，本页的任何内容都不收款、不付款。

这里新增的都是**实验性**功能（2.5，不在兼容承诺之内）：SDK 的 `ai.amountOf`、`ai.pricesOf`、`ai.maxAmountOf`、
`ai.maxPricesOf`、`ai.completionLimitOf`，旁路选项 `upstreamResponseHeaders`（`UPSTREAM_RESPONSE_HEADERS`），以及 new-api 旁路
的 `RECEIPT_LOOKUPS_PER_MIN`。不调用、不设置就不生效；没有用到它们的旁路行为不变。

请先读[接入 AI 服务](ai-providers.md)：那里讲旁路、委托和价目表的设置。

## 拓扑

```
用户 ──► 你的计费层 ──► TapeAPI 旁路 ──► 上游（new-api、LiteLLM、厂商接口）
         密钥、余额、      为 FORMATS 启用的格式
         冻结、结算        的每个回答签名
```

- 计费层鉴别用户、冻结额度，把请求**逐字节**转给旁路，再按返回的回执结算。它不改动转发的请求正文（回执绑定 `requestSha256`，
  即旁路收到的字节的哈希），也不改动转交的回答（回执绑定 `responseSha256`）。
- 回执原样转交：整体回答的 `x-tapeapi-receipt` 响应头，以及事件流里的 `: tapeapi-receipt …` 注释。如果计费层过滤响应头，要保留
  `x-tapeapi-receipt`，并把它列进 `access-control-expose-headers`，否则浏览器客户端读不到。
- 旁路自己不做鉴权。只让计费层能访问它（内网或回环地址），不要暴露在公网上。
- 用户可以自己核验每张回执（`tapeapi-verify` 或 `ai.createVerifyingFetch`）。你数据库里的标记只是你的记录，不是核验：除非已经用
  `ai.verifyUsageReceipt` 对照链上清单核验过签名，否则不要显示"签名已核验"。

## FORMATS 必须与计费范围一致

旁路的 `FORMATS` 应当正好是你的计费层计费、你的上游真正提供的 API 格式，价目表里每个模型的 `formats` 也只写这些。三处要一致：

| 位置 | 内容 |
|---|---|
| 你的计费层 | 计费的路径（`/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/embeddings`） |
| 旁路的 `FORMATS` | `openai-chat`、`openai-responses`、`anthropic-messages`、`openai-embeddings` |
| 价目表（`models.json`，发布在链上） | 每个模型的 `formats` |

计费层计费、但 `FORMATS` 没有启用的路径拿不到回执：旁路对它回 HTTP 400 `bad_path`（2.1 起），你就没有结算依据。旁路发布了、
计费层却不转发的格式，是链上一条你的服务做不到的公开声明。`tapeapi init`（2.3）会要求明确选择 `FORMATS`，并与清单比对。

## 按回执扣费

按回执里的金额扣费（`result.prices`，8 位小数，向上取整），用你计价的那个币种。要按用量和价目表重算时，用 SDK 自己的规则，不要
自己抄一份：

```js
import { amountOf, pricesOf } from '@tapeapi/sdk/ai'

const entry = models.find((m) => m.id === receipt.result.model)  // 或用 ai.modelEntryOf，它也匹配别名
const usdt = entry.prices.find((p) => p.currency === 'USDT')
const charge = amountOf(usdt, receipt.result.usage)              // '0.00357500'，与旁路签名的完全一致
```

扣费前至少检查：回执的 `requestSha256` 等于你转发的字节的 SHA-256；整体回答的 `responseSha256` 等于你收到的字节的 SHA-256
（`ai.sha256Hex`）。没有回执时（上游失败、流在结束前断开、价目表里没有上游报告的模型），扣多少要事先定好，并写进你的条款。

## 冻结额度怎么定

固定一个很小的冻结额度，一次调用就可能花掉远超冻结的钱，多个并发调用会把余额打成很大的负数。应当按请求估算：

```js
import { completionLimitOf, maxPricesOf, modelEntryOf } from '@tapeapi/sdk/ai'

const body = JSON.parse(requestText)
const entry = modelEntryOf(models, body.model, 'openai-chat')
if (!entry) return refuse(400, 'unknown model')
const completion = completionLimitOf(body, 'openai-chat') ?? MODEL_MAX_OUTPUT[entry.id]   // 请求没写：用模型自身的上限
if (completion > HARD_CAP_COMPLETION) return refuse(400, 'max_tokens above this service\'s cap')
const prompt = promptTokenBound(body)        // 你自己分词器的计数，或保守估计（见下），再加余量
const hold = maxPricesOf(entry, { promptTokens: prompt, completionTokens: completion })
// hold: [{ currency: 'USDT', amount: '0.50900000' }, ...]：原子地冻结，转发，再按回执结算
```

`maxAmountOf` 把每个提示 token 按 `input`、`cacheRead`、`cacheWrite`、`cacheWrite1h` 中最高的价计（缓存写可能比输入贵），把每个
补全 token 按 `output`、`reasoning` 中较高的价计，对总和向上取整一次：只要实际用量在给定计数以内，它不会低于回执的金额。
`completionLimitOf` 读出请求声明的上限：Chat Completions 取 `max_completion_tokens` 与 `max_tokens` 中较大的，再乘以 `n`；
Responses 取 `max_output_tokens`；Messages 取 `max_tokens`（包含思考预算）；Embeddings 为 0；请求没有声明时为 `null`。

**单靠价目表限不住的情况。** 冻结额度只在计数可靠时成立：

- **无视 `max_tokens` 的模型。** 有些上游模型会超过请求设定的上限。这种调用，价目表上的任何算术都限不住。请自己设硬上限（只接受
  不超过某个值的补全上限，超过就拒绝或改写请求），按回执的 `completion_tokens` 结算，并事先定好回执金额超过冻结额时怎么办（补扣
  差额并允许有上限的负余额，或者自己承担）。
- **没算到的提示 token。** 上游可能加隐藏系统提示词（按输入计费）、对话模板、工具定义、图片、音频或文件。对字节级分词器来说，请求
  里文本的 UTF-8 字节数大致是文本本身 token 数的上界，但对上面这些都不成立。每次调用留余量，图片和文件按上游自己的规则计，或者
  限制它们的大小。
- **上游报告的模型。** 回执按上游报告的模型计价，它可能与请求的不同（别名，或另一个模型）。如果价目表里有上游可能报告的更贵的
  条目，就按最贵的冻结，或者拒绝报告模型与请求模型不一致的回答。
- **并发。** 冻结必须是原子操作，所有未结冻结额之和不能超过余额。按用户限制并发，而不是按密钥：一个用户可以创建很多密钥。

## 回执补查

回答本身带着回执，那一份是主要的。旁路另外在内存里保留每张回执一小时（`RECEIPT_TTL_S`；重启即丢），由免费的 `receipt` 方法
提供，并按客户端 IP 限流：默认每分钟 10 次。计费层从同一个地址补查时，全站共用一个桶；请设置 `RECEIPT_LOOKUPS_PER_MIN`（new-api
和 LiteLLM 旁路 2.5 起支持；Cloudflare Worker 原本就读取它），例如 600。设为 `0` 则拒绝所有补查，与 Worker 相同；设为 `off` 则不单独限流（只受 `RATE_IP` 约束）。其它值进入设置模式并点名该变量。优先从回答里
读回执，补查只用于连接中断后的补救。

## 上游响应头

上游响应头可能透露你的渠道、供应方或成本。把 `UPSTREAM_RESPONSE_HEADERS`（或 `createAIProxy` 的 `upstreamResponseHeaders`）设成
允许用户看到的上游头，例如 `x-request-id`：其余上游头一律去掉。有两个始终保留：`content-type`（只保留媒体类型与 `charset`、
`boundary` 参数，其它参数可能带出白名单要藏的东西），以及 `retry-after`（客户端在 429、503 时靠它退避）。旁路自己的头（回执、CORS）
照旧加上。响应头不属于回执，所以开不开，回执和回答字节都一样。不设置或留空即不开白名单，与以前一样全部转交；除这两个之外一个都不转，
就设成 `content-type`。它只过滤响应头：回答正文（`id` 的格式、
上游报告的 `model`、用量字段）原样透传，因为回执签的就是这些字节。

## 模型名

回执里的 `model` 是签名方声称上游报告的名字。如果旁路和上游之间有东西改写模型名（例如把上游名字映射成你价目表 id 的代理），回执
里就是改写后的名字。格式允许这样做，但不能让它不可见：

- **公开说明**：在价目页或条款里写明"回执中的 model 是我们价目表的 id，不是上游原样返回的名字"。
- **两个名字都记下来**：每次调用都在你自己的记录里写下请求的模型，以及改写之前上游报告的模型，审计或纠纷时两者都能查到。
- **绝不声称回执能证明上游跑的是哪个模型。** 回执证明的是谁签的名、针对哪些确切的请求字节与哪个回答（回答的字节；流式回答取其事件数据）、声称了多少用量和价格；它不证明
  上游的模型或渠道。

## 对用户怎么说

页脚或条款的建议文案（把 `<运营方>` 换成你的名字）：

> 回执为 TapeAPI 格式，由 `<运营方>` 签发。TapeAPI 不运营、不担保本服务。

不要把 TapeAPI 的名字或标志用得像是它在运营、检查或推荐你的服务；不要把回执说成上游模型的证明；界面上的"已核验"只在用户自己的
客户端核验过签名时才这样写，并说明这一点。

## 旁路从 2.0 升级到 2.4

适用于从 2.0.0 部署的旁路（new-api 一键包、LiteLLM 一键包或 Cloudflare Worker）。固定部署的版本（带 SHA-256 的发布包，或某个
标签的提交），看更新日志，升级后运行 `tapeapi doctor <名字>`。

| 版本 | 对旁路运营方的影响 | 要做什么 |
|---|---|---|
| 2.1.0 | `FORMATS`：设置后只发布并签名这些格式，未启用格式的计量路径回 HTTP 400 `bad_path`；不设置则与 2.0.0 一样发布四种，并在日志和 `/tapeapi/v1/health` 里给出 `WARNING`；名字不认识、或模型的 `formats` 列了未启用的格式，进入设置模式。`pricing-convert.mjs` 把 new-api 的 `/api/pricing` 转成 `models.json`。`tapeapi connect` | 把 `FORMATS` 设成上游真正提供、计费层计费的格式；格式有变化就重新发布清单。用转换器代替自己写的换算脚本。 |
| 2.2.0 | `tapeapi receipts` 与 `tapeapi reconcile`（含 `--preset new-api`）；doctor 的 `paidUntil`、`monthlyFeeWei` 字段 | 用回执和自己的账本或上游账单对账。 |
| 2.3.0 | `tapeapi init`（要求选择 `FORMATS` 并与清单比对）和 `tapeapi prices convert|check|show`；doctor 会报告处于设置模式的旁路及其 `missing`、`problem` | 在每日检查里用 `prices check` 发现价格漂移。 |
| 2.4.0 | AI 旁路没有变化（只有 MCP 工具方法） | 无。 |
| 2.5.0 | 本页的实验性辅助函数和选项（`ai.amountOf`、`ai.pricesOf`、`ai.maxAmountOf`、`ai.maxPricesOf`、`ai.completionLimitOf`、`RECEIPT_LOOKUPS_PER_MIN`、`UPSTREAM_RESPONSE_HEADERS`）；`tapeapi reconcile` 逐个请求对照回执，输出上限用同一个 `ai.completionLimitOf` 读取；MCP 2026-07-28 只涉及 MCP 入口（AI 旁路没有变化）；默认值不变 | 可选：`RECEIPT_LOOKUPS_PER_MIN`、`UPSTREAM_RESPONSE_HEADERS`。new-api 与 LiteLLM 旁路从 2.5 起读取这两个变量（2.4 不读）：compose 文件里留着的坏值现在会让旁路进入设置模式（所有 `/v1/*` 答 503，`/tapeapi/v1/health` 点名该变量），升级前请检查这两项。计费层改用 SDK 的辅助函数，不再自己抄价格规则。导出账本时用用户能在 `--map` 里指定的列名：见[回执对账·给运营者](reconcile.md#给运营者给用户能对账的行)。 |

回执格式（TAPI-21）、清单的 `ai` 字段（TAPI-20）及其测试向量在 2.0 到 2.4 之间都没有变化：2.0 旁路签的回执 2.4 客户端能核验，
反过来也一样。
