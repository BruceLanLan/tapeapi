[English](../reconcile.md) | 中文

# 回执对账（实验性）

你向一个对每次回答都签用量回执的服务购买了 AI 调用，`tapeapi-verify --log` 把这些回执留在了你的机器上。本篇把它们与
你手里的其它材料逐项对照：服务方的账单、你发出的请求、你为代理签的授权书、你自己的花费限额。这里的一切都是
`tapeapi reconcile`，属实验性，不受兼容承诺约束，任何次版本都可能改变或移除。

**它做什么，绝不做什么。**只读本机文件：不联网、不需要密钥、不上传、没有遥测。它只列事实，每条带出处的回执行（用到账单行
或请求文件时也带上）。它不下结论：差异是可以拿着出处行去问服务方的问题。**回执只证明签名方说了什么**：谁签了哪些请求字节与
哪个回答（回答的字节；流式回答取其事件数据）、声称了多少用量与价格。它不证明实际运行的是哪个模型，这里的任何检查也无法判断实际运行的是哪个模型。

```sh
# 装好 SDK 之后；在检出里用 node sdk/bin/tapeapi.js reconcile … 效果相同
tapeapi reconcile --receipts ~/.tapeapi/receipts.jsonl --bill usage.csv               # 与账单对账
tapeapi reconcile --receipts ~/.tapeapi/receipts.jsonl --requests ~/.tapeapi/requests   # 每个请求的事实
tapeapi reconcile --receipts ~/.tapeapi/receipts.jsonl --mandate mandate.json --token-decimals 18
tapeapi reconcile --receipts ~/.tapeapi/receipts.jsonl --policy my-limits.json
```

这些选项可以在一次运行里同时使用。除非给了 `--requests`、`--mandate` 或 `--policy`，否则需要 `--bill`。
`--json` 输出一个对象（`counts`、`items`、`checks`、`mandate`、`policy`、`notes`、`next`）。

## 与账单对账

服务方的账单或用量文件（带表头的 CSV、JSON 或 JSON 行）与回执逐行对应：有 id 列就按 id，否则按时间、模型与 token 数。
每张回执、每行账单最终是匹配、只在一边出现（缺失），或不一致（某字段与回执声称的不同），两边的出处行都会给出。用 `--map`
指定账单的列：

```sh
tapeapi reconcile --receipts receipts.jsonl --bill bill.csv \
  --map id=request_id,model=model,prompt=input_tokens,completion=output_tokens,time=created_at,amount=cost \
  --amount-scale 1
```

`model`、`prompt`、`completion` 必须指定，另需 `id` 或 `time`。只有给了 `--amount-scale`（多少个账单单位等于回执币种的
1 个单位）才比较 `amount`。`--preset new-api` 指的是 new-api 的 `GET /api/log/self` 返回的 JSON 字段名，它是什么、
不是什么见 [AI 服务方指南](ai-providers.md)。没有为任何其它服务方准备预设：请自己指定列。不带时区的时间（`2026-10-22 10:00:00`）一律按 UTC 读，账单与 `--since` / `--until` 都是如此。

## 与 new-api 对账

如果服务方用的是 [new-api](https://github.com/QuantumNous/new-api)（前面有没有[签名旁路](../../../examples/new-api-sidecar/README.md)都一样），
它的接口返回的用量日志就是 `--preset new-api` 能直接读的账单。用你自己的凭据把它导出成文件，再对账：

```sh
# 你自己的行：用控制台的凭据（控制台请求所带的令牌；较新版本是带 usage:read 作用域的 `nap_` 访问令牌）；转发密钥（sk-…）在这条路由上会被拒绝
curl -sS -H "Authorization: Bearer <你的控制台令牌>" "https://<服务方>/api/log/self" -o newapi-log.json
# 或者只有转发密钥时：该密钥最近的行，字段相同
curl -sS -H "Authorization: Bearer sk-…" "https://<服务方>/api/log/token" -o newapi-log.json
# quota_per_unit 在 GET /api/status 里（data.quota_per_unit；new-api 默认 500000，站点可以改）
tapeapi reconcile --receipts receipts.jsonl --bill newapi-log.json --preset new-api --amount-scale 500000
```

`quota` 是原始整数；`--amount-scale <quota_per_unit>` 把回执的币种折算成它，默认容差是不到 1 个额度。日志是分页的：用那个控制台日志页
发出的日期参数缩小范围（从浏览器开发者工具里复制它的请求；各版本不同），让要对的行放进一次回答里，或者每存一页就跑一次
`reconcile`。`--since` 与 `--until` 对两个文件都生效。

这依据什么、不依据什么：字段名（`data.items` 里的 `upstream_request_id`、`model_name`、`prompt_tokens`、`completion_tokens`、
`quota`、`created_at`，或裸的 `data` 数组）取自 new-api 的源码，**尚未用真实实例核对**；`upstream_request_id` 是不是回执里的回答
id 并不知道，按它对不上的行会在 `--window`（默认 120 秒）内按时间、模型与 token 数对应。**控制台的 CSV 导出（日志页的"导出"）是另一份
文件**：表头是本地化的显示标题、`Cost` 是格式化后的字符串而不是可比较的数、id 列是 `request_id` 而不是 `upstream_request_id`，所以
预设对它匹配不上（退出码 2，并显示它的表头）；和其它账单一样，用 `--map` 指定它的列。仓库里的模拟 new-api
（`examples/new-api-sidecar/fake-new-api.mjs`）提供这种日志形状，`reconcile-new-api.test.mjs` 在 127.0.0.1 上走完整条路径
（旁路、`tapeapi-verify --log`、导出、`reconcile`：全部按 id 对上、缺 id 的行、不一致的行、两边各缺一行）；它只是模拟，
不说明真实实例会返回什么。

## 每个请求的事实

回执带的是确切请求字节的哈希（`requestSha256`），不是请求本身。如果你还留有这些字节，`--requests <目录>` 会把它们与回执
对应起来：目录里 SHA-256 等于某张回执 `requestSha256` 的文件，给出该回执的请求事实（字节数、请求的模型、输出上限，以及
*请求类别*）。文件名不重要；对不上任何回执的文件只计数。

| 列出的事实 | 依据 | 能说明什么 | 不能说明什么 |
|---|---|---|---|
| `prompt-tokens-spread`（同一模型） | 同一类别的请求（除 `model`、`stream`、`stream_options`、输出上限、`temperature`、`top_p`、`seed`、`user`、`metadata` 外 JSON 相同） | 同一模型的回执对同一提示词声称了不同的 `prompt_tokens`（超出 `--tolerance-tokens`，默认 0） | 原因：上游加了内容、缓存、模板改动等 |
| `prompt-tokens-spread`（跨模型） | 同一类别、多个模型 | 差值超过 `--prompt-spread`（默认 16）时把各模型的数并列 | 单独看说明不了什么：各模型的分词器与对话模板本来就不同 |
| `prompt-tokens-above-request-bytes` | 请求的字节数 | 回执声称的输入 token 多于请求的字节数（分词器很少对每字节文本切出超过一个 token；对话模板每条消息另加几个） | 多出来的 token 是什么；以 URL 给出的图片或文件字节很少却计很多 token，这类请求被列出是正常的 |
| `completion-above-request-limit` | `ai.completionLimitOf` 读出的上限（与计费层估冻结额度的规则相同）：`max_completion_tokens` 与 `max_tokens` 取较大者再乘 `n`（Chat）、`max_output_tokens`（Responses）、`max_tokens`（Anthropic） | `completion_tokens` 超过请求设的上限，旁边列出 `reasoning_tokens` | 服务方是否把推理 token 算在上限内：那要看它自己的文档 |
| `model-names-vary` | 请求的模型 | 同一个请求模型对应的回执模型名，按流式与非流式分开 | 哪个名字（如果有的话）是实际运行的模型 |
| `model-name-differs-from-bill` | 对上的账单行与清单快照 | 回执与其账单行的模型名不同，而快照把两者列为别名（所以对账时算同一个模型） | 同上 |

**请求字节必须是实际发出的字节。**`tapeapi-verify` 默认给每个请求加盐（在末尾追加空白，使短提示词的哈希无法被猜出），
这时客户端保存的字节就不是回执哈希的那份字节，不会有文件对得上。加盐之后保存的字节，或 `tapeapi-verify` 以 `--no-salt`
运行时的字节，才对得上（这时你把回执交给谁，谁就能猜出短提示词的哈希）。`--log` 文件本身从不保存提示词。

`tapeapi-verify --save-requests <目录>`（实验性，2.5；**默认关闭**）替你保存这些字节：它发出的每个计量请求（含盐）在
`<目录>` 里存成一个 `<sha256>.request` 文件，之后把这个目录交给 `--requests <目录>`。

> **隐私。** 保存下来的文件就是明文的对话：提示词、附带的文件、工具输出，客户端发出的一切。回执与 `--log` 文件都不含这些。
> `tapeapi-verify` 以 700 权限创建目录，已有目录若组或其他人能打开就拒绝启动（退出 1），每个文件以 600 权限写入；但备份、
> 同步文件夹或多人共用的机器仍可能复制它们。只在要核对的那些调用期间打开，用完删除。Windows 上不设置这些权限。

没有请求字节时，账单可以用三个可选的 `--map` 键给出同样的事实：`request`（值相同的行属同一请求类别）、`request_bytes`、
`max_tokens`；这时账单的 `model` 列被当作请求的模型。两者都没有时，`--no-salt` 日志里 `requestSha256` 相同的回执算同一
类别（只有字节完全相同的请求才会这样），模型名按回执旁清单快照里的价目表条目分组。

除非用 `--fail-on` 要求（见下），发现不改变退出码；`--json` 里有 `checks.counts`，`checks.checked` 记录每项检查有多少张回执具备所需的输入。

## 与授权书对照

如果代理按一份授权书替你花钱（见 [容器代理](container-agents.md)），`--mandate <文件>` 把回执声称的花费与它对照。文件是
JSON 形式的授权书，可以是裸对象，也可以是 `{ "mandate": { … } }`；不读它的签名。对每个 scope 项，取容器等于该项
`provider`、签名时间在 `[notBefore, expires)` 内的回执，按该项的币种求和，与上限对照：

- 上限以该项代币的基本单位计：给出 `--token-decimals <n>` 才比较（不给只列花费、不比较）。列表里的代币币种是 `BEM` 或
  `USDT`，其它代币用 `--mandate-currency <c>` 指定；
- 结果是 `below-cap`、`near-cap`（从 `--near` 开始，默认 0.8）、`at-cap` 或 `above-cap`，带比例与回执行；
- 不在 scope 里的容器的回执、不在有效期内的回执单独列出；
- 阶段 0 的授权书不写金额（上限都是 0）：只列花费，从不比较。

这是事后的可见性。调用时没有执行任何限制，回执里的价格是签名方声称的价格。

## 你自己的限额

`--policy <文件>` 读取你为自己写的限额。它不是平台规则，`reconcile` 也不执行任何限制：只列出回执声称超过它的时间窗口。（同一个文件也可以在你自己的进程里、在调用发出之前拒绝调用：见下文。）

```json
{
  "tapeapiPolicy": 1,
  "note": "我自己的限额",
  "rules": [
    { "name": "单次回答", "model": "*", "period": "call", "maxCompletionTokens": 4096 },
    { "name": "每天", "service": "0x…容器地址…", "period": "day", "maxAmount": "2.5", "currency": "USD" },
    { "name": "本月", "period": "month", "maxCalls": 5000, "maxPromptTokens": 20000000 }
  ]
}
```

`service` 是容器地址或 `"*"`，`model` 是回执里写的模型名或 `"*"`，`period` 是 `call`、`day`、`month`（UTC）或 `total`
之一。每条规则至少设 `maxAmount`（至多 8 位小数的十进制字符串，需带 `currency`）、`maxCalls`、`maxPromptTokens`、
`maxCompletionTokens` 中的一项。未知的键是错误（退出 2），拼错的限额不会被悄悄忽略。

### 每次调用之前读同一个文件（客户端预算，实验性，3.0）

`createVerifyingFetch({ policy })` 读同一份策略，当一次调用的最坏情况会让覆盖它的某条规则超出限额时，**在发出之前**拒绝它。规则按
服务（容器）与模型（请求的名字、价目表条目的 id 或别名，或 `"*"`）覆盖调用。

```js
import { readFileSync, appendFileSync, chmodSync } from 'node:fs'
import { ai } from '@tapeapi/sdk'

const policy = JSON.parse(readFileSync('my-limits.json', 'utf8'))
const fetch = ai.createVerifyingFetch({ api, service, policy,
  budgetStore: ai.budgetFileStore('spend.jsonl', { readFileSync, appendFileSync, chmodSync }) })
```

- **最坏情况**：对模型条目的每个币种求 `ai.maxAmountOf`，提示 token 上界取请求的字节数，补全取请求声明的输出上限
  （`ai.completionLimitOf`）。与之相加的是：规则窗口里核验无误的回执已经声称的数，以及每个已记为发出、却没有核验无误回执的调用
  （上游失败、回执核验不符、中途崩溃）的最坏情况。
- **拒绝**（不论 `strict`）：`BUDGET_EXCEEDED`，`data: { reason: 'budget-cap', rule, period, window, limit, currency, cap,
  spent, worstCase }`。覆盖该调用的规则无法给出上界时一律拒绝，`INVALID_ARGUMENT` 加 `data.reason`：`budget-no-limit`（请求没设
  `max_tokens` / `max_completion_tokens` / `max_output_tokens`）、`budget-no-price`（价目表没有该模型）、`budget-no-currency`
  （没有规则币种的价格）、`budget-unreadable-request`（正文不是 JSON 对象）、`budget-store-unwritable`（记不下来，所以不发送）。
- **存储**（`budgetFileStore`）是一个只追加的 JSON 行文件，权限 600：核验无误的回执信封（`tapeapi receipts` 与
  `tapeapi reconcile --receipts` 原样读取），每次调用在发出之前写下的一行 `{"tapeapiSent": 1, …}`，以及调用以确定的、不声称任何数的
  失败结束（不带回执的 HTTP 4xx 或 5xx）时写下的一行 `{"tapeapiReleased": 1, …}`，它撤下该调用的最坏情况（回执读取器跳过这两种行）。
  超时、连接断开、回执核验不符都不算确定：调用继续计入。
  重启后重新读文件，计数仍在。不给 `budgetStore` 时存在内存里：重启即忘。

**它不是什么。** 它只是你自己进程里的便利，不是任何别人可以依赖的执行：你可以关掉它、改文件，或在一个文件上放两个预算（两个进程，或同一进程里两个带 `policy` 的 fetch：
每次调用之前各自读取对方新追加的行；给 `budgetFileStore` 传了 `writeFileSync` 与 `unlinkSync` 时（`tapeapi-verify --budget-store` 就是这样）还在锁文件 `<存储>.lock` 之内依次判定；同一进程里请用 `budget:` 共用一个 `ai.createBudget()`），服务方也不受它约束。它限制的是回执**声称**的价格，不是任何人实际付的钱。最坏情况只在计数可靠时成立：隐藏的系统提示、
图片、工具定义、无视 `max_tokens` 的模型、按另一个上报模型计价的回答，都可能让回执声称的数超过最坏情况；下一次调用会看到它并被拒绝。
只有发往清单端点的调用会被计入（默认的 strict 本来就拒绝其它调用）。

本地代理读同一个文件：`tapeapi-verify <服务> --policy my-limits.json --budget-store spend.jsonl`。被拒绝的调用得到 HTTP 400（code 为
`budget_exceeded`；无法给出上界时为 `budget_no_limit` 等），带 `x-should-retry: false`，与代理其它转发前的拒绝一致，不转发。

## 花费声明（实验性，3.0）

`tapeapi receipts statement` 按服务、模型、UTC 日汇总一段期间内回执声称的数，并把你的策略与授权书的上限并列：

```sh
tapeapi receipts statement --receipts spend.jsonl --from 2026-10-01 --to 2026-11-01 --policy my-limits.json \
  --mandate mandate.json --token-decimals 18 [--json] [--lang en|zh]
```

它的计法与 `reconcile` 相同（一张回执只计一次，`--from` / `--to` 就是 `--since` / `--until`），同样的文件，合计与 reconcile
一致：授权书的 `spent`、每个策略窗口的合计。预算记为已发出、却没有核验无误回执的调用，按最坏情况列在合计旁边，不计入合计。

**它没有签名。** 这是你对本机回执的自己的汇总；你给谁看，谁就只能凭你的话。其中每张回执由各自的服务签名，只证明该服务声称了什么。
它不是 agent 套件的 `spendStatement` / `spendEvidence`（阶段 1）：那两者是写在签名交付结果里的托管通道 `claimedOf`，需要托管；
这里只读回执。

## 给运营者：给用户能对账的行

如果你运营服务并有自己的账本，导出时用 `--map` 能指定的列即可；`tapeapi receipts export` 的列名就很合适：

| `--map` 键 | 导出的列 | 说明 |
|---|---|---|
| `id` | 回答的 id，与回执里的一致 | 账单行与回执精确对应 |
| `time` | 调用时间（unix 秒或 ISO 8601） | 没有 id 时用来对应 |
| `model` | 用户请求的模型 | 请求里写的名字 |
| `prompt`、`completion` | 你计费的 token 数 | 全部输入与全部输出 token，口径与回执相同 |
| `amount` | 你收取的金额，单一币种 | 配合 `--amount-scale` |
| `request`、`request_bytes`、`max_tokens` | 可选 | 用户不保存请求字节也能做请求检查 |

用户随后运行例如
`tapeapi reconcile --receipts receipts.jsonl --bill ledger.csv --map id=id,model=model,prompt=prompt_tokens,completion=completion_tokens,time=ts,amount=amount --amount-scale 1`。
你签的回执本身（每行一个 JSON 信封）可以直接交给 `--receipts` 读取。不打算为任何一家服务方做预设：列名由你决定，由用户指定。

## 退出码

`0` 每张回执与每行账单都匹配（不给 `--bill` 时：报告已生成）；`1` 有缺失或不一致；`2` 用法错误（点名了账单里没有的列、
授权书或策略文件读不了或不合格）；`3` 没有可比较的内容。发现、授权书与策略的事实不改变退出码，除非你要求：

`--fail-on <种类>`（实验性，2.5）以逗号分隔点名 `findings`（任何发现）、`mandate-above-cap`（某个 scope 项超出上限）、
`policy`（某个时间窗口超出你的规则）。原本会退出 `0`、而点名的一类被列出时，退出码为 `4`；`1`、`2`、`3` 不变。这时 `--json`
多一个 `failOn: { kinds, counts, listed }`，文本输出最后多一行计数。永远不会被列出的种类算用法错误（`2`）：没有 `--policy`
却点名 `policy`；没有 `--mandate` 与 `--token-decimals` 却点名 `mandate-above-cap`（不给小数位就不比较上限）。它给需要据此
停下的脚本或 CI 步骤用；退出 `4` 仍然只表示"列出了"，不表示"错了"。

```sh
tapeapi reconcile --receipts receipts.jsonl --requests requests/ --policy my-limits.json --fail-on findings,policy
```
