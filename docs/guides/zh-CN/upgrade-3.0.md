# 从 2.x 升级到 3.0

TapeAPI 3.0.0 已于 2026-11-06 发布。本页列出它的五项破坏性修改、各自会让什么坏掉，以及保留 2.x 行为的选项；
这里没有列出的，在 3.0 里与 2.x 一样工作。3.0.0 发布后，2.x 继续获得 6 个月的安全修复（见下文"支持期限"）。
从 1.x 升级的，请先读[升级到 2.0](upgrade-2.0.md)。

## 谁需要做什么

大多数代码不用改。只有下面某一条符合你的情况，才需要动手：

- 你在 **Node.js 20** 上安装或运行这些包。
- 你调用 **`createAIProxy`** 时 `formats` 漏掉了某个内置格式，并依赖这种格式的请求不带回执地到达上游。
- 你**从网页里**调用 **`createMcpProxy`** 代理（或 `examples/mcp-proxy`），包括用持有人操作台 `https://tapeapi.fun/console/`
  发布工具清单的那一步。
- 你运行 **`tapeapi-verify`**（或 `tapeapi connect --proxy`），并希望核验不了的回执只记日志、回答照常交给客户端，而不是变成错误。
- 你在上游 MCP 服务器前面运行 **`createMcpProxy`** 或 **`tapeapi-mcp`**，而上游对 `server/discover` 的回答不规范，或者你统计上游收到的请求数。

只用 `createTapeAPI()` 调用服务、读取回执、使用通道或群聊、调用公共服务 `api.tapeapi.fun`（包括它的 MCP 端点）的客户端，在 Node.js 22 或更高版本上什么都不用改。

## 3.0 保留什么

承诺的三个等级不变：**Stable（稳定）**（3.x 之内没有破坏性修改；新增内容可以出现在任何次版本里）、**Experimental（实验性）**
（`@experimental`，可能在次版本里改变，每次修改都写进更新日志）与 **Internal（内部）**。按 3.0 文档写的代码，在所有 3.x 版本里都能继续工作，
正如按 2.0 文档写的代码在所有 2.x 版本里一样。破坏性修改只出现在新的大版本里。

## 破坏性修改

在代码里搜索第一列的名字。除第一行外，每一行都有退回 2.x 行为的办法。

| 位置 | 2.x | 3.0 | 保留 2.x 行为 |
|---|---|---|---|
| 每个包的 `engines`、CI | Node.js 20 或更高；CI 测 20 与 22 | Node.js 22 或更高；CI 测 22 与 24 | 没有：留在 2.x |
| `createAIProxy({ formats })` | `formats` 漏掉的内置格式的计量路径，不带回执地转给上游 | 回 HTTP 400 `bad_path`，绝不转发 | `refuseOtherFormats: false` |
| `createMcpProxy` | 接受任何浏览器 `Origin`，回答带 CORS `*` | `Origin` 不在 `allowedOrigins` 里的请求回 HTTP 403 | `allowedOrigins: '*'`（`examples/mcp-proxy` 里为 `ALLOWED_ORIGINS=*`） |
| `tapeapi-verify` | 核验不了的回执只记日志，回答照常交出（除非给 `--strict`） | 客户端收到错误（HTTP 502，流式则在末尾收到错误事件） | `--no-strict` |
| `createMcpProxy`、`tapeapi-mcp` | 用 `initialize` 打开上游 | 先问上游 `server/discover`；上游提供 MCP 2026-07-28 就用它，否则用 `initialize` | `upstreamNegotiation: 'legacy'`，`tapeapi-mcp --upstream-negotiation legacy` |

### 1. Node.js 22 或更高

每个包（`@tapeapi/sdk`、`@tapeapi/server`、`@tapeapi/interop`、`@tapeapi/passport`、`@tapeapi/policy-circuit`）现在都声明
`"engines": { "node": ">=22" }`，CI 测 Node.js 22 与 24，不再测 20 与 22。Node.js 20 不再测试。代码在运行时不检查版本，所以在
Node.js 20 上安装只会警告（除非你打开了 npm 的 `engine-strict`），但在那里出的问题我们不会当作缺陷修。浏览器、Deno、Bun 与
Cloudflare Workers 不受影响：它们都不读 `engines`。如果你在某个包里运行 `npm test`，现在跑的是 `node --test "test/*.test.mjs"`；
旧的 `node --test test` 在 Node.js 22 上已经不能用。

这一项没有选项。要留在 Node.js 20，就留在 2.x。

### 2. `createAIProxy` 拒绝它不提供的格式

当 `formats` 漏掉某个内置格式（OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、OpenAI Embeddings）时，发往这种格式
计量路径的请求（例如只提供 `openai-chat` 的旁路收到 `POST /v1/messages`）现在回 HTTP 400 `bad_path`，带 `x-tapeapi-sidecar-error`
请求头，绝不转发。2.x 里它会到达你的上游、不带回执地回来，客户端分不清签了名的回答与没签名的回答。

- 如果上游确实提供这种格式，把它加进 `formats`：它就有回执了。
- 如果你依赖这种透传，传 `refuseOtherFormats: false`。

```js
// 3.0：POST /v1/messages 回 400 bad_path
createAIProxy({ ...opts, formats: ['openai-chat'] })
// 2.x 的透传，不带回执
createAIProxy({ ...opts, formats: ['openai-chat'], refuseOtherFormats: false })
```

不计量的路径（`/v1/models`、`/v1/messages/count_tokens` 等）照旧透传；用默认 `formats`（四种全开）的旁路什么都不拒绝。
`examples/` 里的旁路模板本来就拒绝这类路径（它们打开了这个选项，并带一句提到 `FORMATS` 的提示），行为不变。
这个选项本身仍是 `@experimental`，改的只是默认值。

### 3. `createMcpProxy` 拒绝你没列出的浏览器来源

MCP Streamable HTTP 要求服务器校验 `Origin` 请求头。运行在你自己机器上、挡在有副作用的工具（文件、shell、数据库）前面的代理，
在 CORS `*` 下可以被你打开的任何网页调用。3.0 起，发往 `/mcp`、带有不在 `allowedOrigins` 里的 `Origin` 的请求，在任何东西运行之前
就回 HTTP 403（一个不带 id 的 JSON-RPC 错误），预检（`OPTIONS`）也一样。

- 桌面 MCP 客户端（Claude Desktop、Claude Code、Cursor 等）和 `curl` 不发 `Origin`，照旧得到回答。它们的回答不再带
  `access-control-allow-origin: *`（并带 `vary: origin`），这只有浏览器会读。
- 要允许某个网页，列出它的确切来源：`allowedOrigins: ['https://app.example']`。
- 持有人操作台 `https://tapeapi.fun/console/` 在你的浏览器里读 `tools/list`，所以用它发布期间，请列出 `https://tapeapi.fun`。
- 要恢复 2.x 的行为（任何来源、CORS `*`），传 `allowedOrigins: '*'`。`['*']`（数组）仍被当作错误拒绝。

```js
createMcpProxy({ ...opts, allowedOrigins: ['https://tapeapi.fun'] })   // 操作台可以读 tools/list
createMcpProxy({ ...opts, allowedOrigins: '*' })                         // 2.x：任何来源
```

`examples/mcp-proxy/index.mjs` 里的变量是 `ALLOWED_ORIGINS`：逗号分隔的来源，或 `ALLOWED_ORIGINS=*` 表示任何来源。Cloudflare Worker 模板 `examples/mcp-proxy/worker.js`
在 `ALLOWED_ORIGINS` 没有列出来源时仍接受任何来源。`createMcpEndpoint` 不变：默认仍是任何来源，现在也接受 `'*'`（见下文"哪些不变"）。

### 4. `tapeapi-verify` 默认严格

核验不了的回执现在是客户端看得到的错误：JSON 回答回 HTTP 502（`receipt_invalid`，`x-should-retry: false`），流式回答则以符合该格式的
错误事件代替最后一个事件，与 `@tapeapi/sdk/ai` 的 `createVerifyingFetch` 早就做的一样。以前要 `--strict` 才有的拒绝，现在也默认打开：

- 写法宽松的计量路径（`/v1//messages`）和清单没有声明的格式，回 HTTP 400，不转发；
- 给了 `--request-usage` 时，改不了的正文被拒绝（`usage_request_skipped`）；
- 服务方返回的不带回执的 HTTP 错误（旁路自己用 `x-tapeapi-sidecar-error` 标记的错误除外）变成 HTTP 502。

要 2.x 的行为（失败只记日志、回答照常交出），加 `--no-strict`。用 `tapeapi connect --proxy` 时，同一个参数会转给 `tapeapi-verify`。
`--strict` 仍然接受、不起作用，所以已保存的、写了它的 Claude Code 或 Codex 设置照样能用；`tapeapi connect` 两个同时给是用法错误。

```bash
tapeapi-verify 42.1013.tape --no-strict              # 42.1013.tape 是示例名字
tapeapi connect 42.1013.tape --proxy --no-strict
```

加 `--no-strict` 之前，先查回执为什么核验不了：常见原因是时钟偏差超过 300 秒（`--max-skew`），或旁路的价格表、签名者与它链上的清单不一致。

### 5. MCP 签名代理与上游协商协议版本

`createMcpProxy`（以及 `examples/mcp-proxy`）现在先给上游发 `server/discover`，上游提供 MCP 2026-07-28 就用它；错误回答、HTTP 4xx
或超时没有回答，就像以前一样退回 `initialize`。只会 2026-07-28 的上游现在不用任何选项就能接。`tapeapi-mcp` 从已流片的 MCP 服务器的
`mcp.endpoint` 读取工具时也这样做。

你可能注意到的：

- 启动时对每个上游多一次请求；
- 这第一次请求遇到网络失败，报为失败，而不是退回；
- 对 `server/discover` 回了一个没有列出任何协议版本的结果的上游，在启动时被拒绝。

调用不受影响：调用总是走签名的 TapeAPI 路径，而且无论哪种方式，工具的哈希都必须等于同一个 `mcp.toolsSha256`。要保留 2.x 的握手：

```js
createMcpProxy({ ...opts, upstreamNegotiation: 'legacy' })
```

```bash
tapeapi-mcp --upstream-negotiation legacy
```

## 哪些不变

下面这些与 2.x 一样。每一项都在 3.0 考虑过，是有意保留的。

- **`conform: false`**（1.x 的解析）整个 3.x 都保留，最早 4.0 才移除。它仍是弃用状态，每个客户端报一次警告；用自己的地址、本地链或 fork，就靠它。
- **`labels: 'v1'`**（私密通道与群聊的第 1 版）保留。以第 1 版为默认的 1.x 获得安全修复到 2027-04-12，所以 3.0 不切断 1.x 的对端：
  至少保留到那一天。
- **`allChains` 仍默认关闭。** 打开它会把你的查询发给其它链的公共节点。所以与 TAP-11 §2.1 的已知例外仍在：不开 `allChains` 时，
  "处理器合约#ID"字符串被拒绝（`unsupported`）；见[升级到 2.0](upgrade-2.0.md#已知例外不开-allchains-时的处理器合约idtap-11-21)。
- **公共 MCP 端点仍接受任何 `Origin`。** 提供 `api.tapeapi.fun/mcp` 与 `/mcp/pinned` 的 `createMcpEndpoint` 保持默认：任何来源、
  CORS `*`。这不符合 MCP Streamable HTTP 的"服务器 MUST 校验 Origin 请求头"，我们像对待 TAP-11 §2.1 的例外一样如实写出。理由：
  这些工具只读、免费、不收任何凭据，网页调用它们得到的，不用浏览器也一样能得到；校验来源只会让用它们的网页坏掉。运行有副作用工具的服务器
  应该用 `createMcpProxy`（3.0 起拒绝未列出的来源），或者自己传 `allowedOrigins`。
- **`sentinel` 仍是 `'warn'`。** SDK 没有列出的 hub 实现只报告、不拒绝。站点存储与付款合约在默认模式下本来就失败关闭（`store-changed`）。
- **没有任何 TAP 收紧成为默认。** 2.x 承诺过：TAP-10 或 TAP-11 的收紧先作为可选 profile 提供，到 3.0 才成为默认。3.0.0 之前没有出现
  收紧：`CONFORM_PROFILE` 仍是 `'tap10@1.1+tap11@draft'`，解析结果与 2.x 完全一样。3.x 沿用同一条规则：放宽与新增状态名在次版本里生效，
  收紧先作为可选 profile，到 4.0 才成为默认。
- **线路格式与冻结常量。** TAPI-20 至 TAPI-27 的线路格式与冻结常量一个字节都不变：3.0 客户端照样核验 1.x、2.x 的每份清单、委托、
  签名响应与回执，以及它们的向量。
- **同样不变的：** `parseUnits` / `formatUnits` 仍默认 8 位小数（BEM）；`createAIProxy` 仍默认转发客户端的会话头（`forwardSessionHeaders`）。

## 新的实验性包

3.0 在 SDK 旁边带上三个包，都是 **0.1.0 版**，各有自己的版本号（发布标签是 `@tapeapi/sdk` 与 `@tapeapi/server` 的版本）。三个包都
**不在兼容承诺之内**：可能在任何一次发布中改变或撤下，上面的稳定承诺不覆盖它们。每个包都要与 SDK 从同一次发布安装。

- **`@tapeapi/interop`**：应用之间的访客授权，一个原型（不涉及付款，不是 TAP）。[应用与容器互通](interop.md)
- **`@tapeapi/passport`**：Agent Passport 的只读解析器，跟随一份未合并的草稿（TAPs pull request #83，已提交、评审中；本包实现的是它在头 `cae25e6` 时的文字，草稿此后已有更新）。[Agent 护照](passport.md)
- **`@tapeapi/policy-circuit`**：重跑写成 `tapnet/1` 电路的支出规则，跟随一份未合并的草稿（TAPs pull request #84，已提交，目前转为 draft PR）；
  它是链下核查，只约束去核查它的一方。[策略电路](policy-circuit.md)

## 托管代币核对（实验性）

付费调用与托管合约是实验性的，而且**托管合约未经审计、未部署**，所以没有任何线上服务收费，今天没有人受影响。写在这里，是因为它改变了
付费调用的行为。

2.x 只有 `listen()` 在启动时读取托管的 `token()`，Worker 要自己等 `checkEscrowToken()`。3.0 起，`handleRequest()` 与 `invoke()` 在首个
付费调用之前运行这项核对，每条路径都一样。托管持有别的代币、托管没有 `token()`、节点读不出来，这三种情况都以未签名的 HTTP 503
`UNSUPPORTED_PAYMENT_TOKEN` 拒绝付费调用（`data.reason` 为 `escrow-token-mismatch`、`escrow-no-token` 或 `escrow-token-unreadable`）：
不签名、不计费，免费方法照常回答。被拒的调用计入调用方的免费预算。确定的答案（`ok`、`mismatch`、`skipped`）在实例存续期间保留，
你自己调用 `provider.checkEscrowToken()` 得到的也是它，所以代币不一致在实例存续期间一直如此（不要重试）。托管没有 `token()` 和读取失败
（`escrow-no-token`、`escrow-token-unreadable`）在下一次付费调用时重读，都绝不当作一致。

以下情况跳过这项核对，付费调用不经核对照常进行：没有收费的方法；没有托管；配置了 `settlementFacts`（不读结算合约）或 `enforcement`
（由执行后端自己核对通道与代币）；没有 `rpcUrls`；不在 BNB 智能链上又没给 `createProvider({ escrowToken })`。`dev: true` 也跳过。
见[运行服务](provide.md)。

## 支持期限

| 版本 | 安全修复 |
|---|---|
| 3.x | 是：当前的大版本。 |
| 0.x 包（interop、passport、policy-circuit） | 没有支持期：实验性的；修复只出现在新的 0.x 版本里，旧的 0.x 版本不打补丁。 |
| 2.x | 只修安全问题，期限为 3.0.0 发布日（2026-11-06）之后 6 个月，即到 2027-05-06。 |
| 1.x | 只修安全问题，到 2027-04-12（2.0.0 之后 6 个月）。不因 3.0 缩短。 |

完整的策略见 [SECURITY.md](../../../SECURITY.md)。
