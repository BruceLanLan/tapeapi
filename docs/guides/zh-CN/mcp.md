[English](../mcp.md) | 中文

# 在 Claude、Cursor 等 MCP 客户端中使用 TapeAPI

公共服务的八个方法可以作为 [Model Context Protocol](https://modelcontextprotocol.io)（MCP）工具使用。在 Claude、Cursor
或任何 MCP 客户端里加一个网址，你的助手就能读取 BNB Smart Chain，而且每个回答都有签名，任何人事后都能对照链上核验。

有两种接入方式：

- **远程服务器** `https://api.tapeapi.fun/mcp`。无需安装。服务给每个回答签名；你或任何人事后都能用随附的链接核验。
- **本地命令** `tapeapi-mcp`。在你自己的电脑上运行，在模型看到结果之前先对照链上核验每个回答；服务的工具在链上被改动时，
  它会拒绝调用，直到你接受这次改动。

自己已经在运行 MCP 服务器？见 [Tape out 你自己的 MCP 服务器](#tape-out-你自己的-mcp-服务器)。

## 你得到什么

八个只读工具，免费，无需注册，没有密钥：`blockNumber`、`balance`、`tokenInfo`、`tokenBalance`、`nftOwner`、`pairPrice`、`bnbUsd`
和 `tapeName`。参数和返回值与[公共 API](public-api.md#方法)中的一致。

每个工具结果都带三样东西：

- **数据**，以文本和 `structuredContent` 两种形式给出。
- **一行来源说明**，模型可以直接引用：哪个服务签的名、它的容器和签名密钥、区块，以及核验链接
  `https://tapeapi.fun/verify/#r=...`。
- **回执**，在 `_meta["fun.tapeapi/receipt"]` 里：事后重新核验签名所需的一切，不必信任转交回执的人。

**为什么重要。** 在 MCP 里，工具结果就是服务器发来的任何内容，工具定义就是服务器今天列出的任何内容。两者都不说明由谁负责，
而且服务器可以在你批准之后改掉自己的工具。TapeAPI 服务是 TapeOut 上的一个电路。它的方法列在一份清单里，清单存放在容器的
链上站点中，只有电路的持有者能改写。每个回答都由持有者在链上委托的密钥签名，签名绑定你的请求：方法、参数和结果。

## 添加远程服务器

网址：`https://api.tapeapi.fun/mcp`。传输方式：MCP Streamable HTTP，无状态，只接受 POST。无需登录，没有密钥。

### Claude.ai 与 Claude Desktop

打开 **Settings > Connectors > Add custom connector**（设置 > 连接器 > 添加自定义连接器）。名称填 `TapeAPI`，网址填
`https://api.tapeapi.fun/mcp`，认证相关字段留空。能否使用自定义连接器取决于你的 Claude 套餐。

### Claude Code

```bash
claude mcp add --transport http tapeapi https://api.tapeapi.fun/mcp
```

### Cursor

把下面的内容加到 `~/.cursor/mcp.json`（所有项目）或 `.cursor/mcp.json`（单个项目）：

```json
{
  "mcpServers": {
    "tapeapi": { "url": "https://api.tapeapi.fun/mcp" }
  }
}
```

### VS Code

把下面的内容加到 `.vscode/mcp.json`：

```json
{
  "servers": {
    "tapeapi": { "type": "http", "url": "https://api.tapeapi.fun/mcp" }
  }
}
```

### 其他客户端

把网址作为 Streamable HTTP 服务器填进去即可。服务器对每个 POST 都用 `application/json` 回答；它不提供服务器到客户端的
推送流，所以 GET 会得到 HTTP 405。也可以直接用 curl 调用：

```bash
curl -s https://api.tapeapi.fun/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bnbUsd","arguments":{}}}'
```

### 试一试

问你的助手：*"现在 BNB 兑 USDT 的价格是多少？用 TapeAPI 查，并给我核验链接。"* 结果大致如下（链接已截短）：

```text
{"bnbUsd":"776.200189730784569077","pair":"0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE","blockPinned":{"blockNumber":124374250,...}}

Signed by TapeAPI service 11.1013.tape (container 0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8, signer
0xaB70dEe8e1CEabb1D10eDFeBcbe0c313c53cf154) at BNB Chain block 124374251. Anyone can verify this signature against
the chain with the link. Verify: https://tapeapi.fun/verify/#r=eyJ2IjoyLCJzZXJ2aWNl... (The link carries hashes only,
not the params or result.)
```

### 协议版本

远程服务器、签名代理的 `/mcp` 和本地命令都支持四个 MCP 版本。其中三个使用 `initialize` 握手：2025-11-25、2025-06-18 和
2025-03-26。第四个 2026-07-28 没有握手：每个请求在 `params._meta` 里自带版本和客户端能力。对 2026-07-28 的支持是**实验性**的
（2.5）：不在 2.x 兼容承诺之内，任何 2.x 版本都可能改动它。两种情况下调用之间都不保存会话，也不发 `Mcp-Session-Id`。

一个请求的 `params._meta` 里有键 `io.modelcontextprotocol/protocolVersion`、值不是三个旧版本之一、方法也不是
`initialize` 时，就按 2026-07-28 处理。旧版本的客户端都不发这个键，所以它们得到的回答与 2.4 完全相同：测试集回放从
2.4.0 版录下的 290 个回答（本地命令所用的服务器核心、远程服务器、签名代理，以及公共服务的 `/mcp` 和 `/mcp/pinned`），
要求逐字节一致；例外是带 `MCP-Protocol-Version: 2026-07-28` 请求头、正文却没有 2026-07-28 `_meta` 的请求的 5 个回答
（每个 HTTP 入口一个）：旧版客户端不会这样发，它现在被拒绝（见下文）。

2026-07-28 的请求得到什么：

| 请求 | 回答 | HTTP 状态 |
| --- | --- | --- |
| 不经 `initialize` 直接发 `tools/list`、`tools/call` 等方法 | 结果，带 `resultType: "complete"` 和 `_meta["io.modelcontextprotocol/serverInfo"]`（本服务器的名称和版本）。列表结果另带 `ttlMs: 0` 和 `cacheScope: "public"`。工具结果里，回执仍在 `_meta` 原来的位置，serverInfo 放在它旁边。 | 200 |
| `server/discover` | `supportedVersions`（先是 `2026-07-28`，再是三个旧版本）、`capabilities`（`tools`）、`instructions`、`ttlMs: 0`、`cacheScope: "public"`，`_meta` 里有 serverInfo | 200 |
| 本服务器没有的版本（例如 `2027-01-01`） | 错误 `-32022` "Unsupported protocol version"，`data: { supported, requested }` | 400 |
| 版本值不是字符串，或者没有 `io.modelcontextprotocol/clientCapabilities` 对象 | 错误 `-32602` | 400 |
| 请求头 `MCP-Protocol-Version`、`Mcp-Method` 或（对 `tools/call`、`prompts/get`、`resources/read`）`Mcp-Name` 缺失或与正文不一致。`Mcp-Name` 可以用 `=?base64?...?=` 形式，先解码再比较。 | 错误 `-32020` "Header mismatch" | 400 |
| 本服务器没有的方法 | 错误 `-32601` | 404 |

状态码和请求头检查只在 HTTP 上（远程服务器和签名代理）。本地命令（stdio）没有请求头，给出相同的 JSON-RPC 回答。两代协议
都能处理的客户端，无论哪种传输都会认出这是新版服务器：在 stdio 上它用 `server/discover` 探测会得到结果，在 HTTP 上它的
第一个请求要么成功，要么得到上表中的某个错误。

签名的内容一概不变。新增字段都在结果旁边：回执、签名信封、核验链接和 `toolsSha256` 在两代协议下都相同。

有几处是有意为之：

- 2026-07-28 的请求发 `ping` 仍然会得到回答，尽管该版本删掉了这个方法。
- 一个 JSON 数组里的多条旧版消息（批量）仍像以前一样逐条回答，HTTP 状态为 200。含 2026-07-28 消息、或带
  `MCP-Protocol-Version: 2026-07-28` 请求头的批量，以 HTTP 400 和 `-32600` 拒绝：2026-07-28 要求每个请求只有一条消息，批量会把
  消息带过上面的请求头校验。
- 带 `MCP-Protocol-Version: 2026-07-28` 请求头、正文却没有 2026-07-28 元数据的单条请求，是格式错误的 2026-07-28 请求：HTTP 400；
  它的 `Mcp-Method` 或 `Mcp-Name` 请求头（或 `_meta` 里的版本）与正文矛盾时为 `-32020`，否则为 `-32602`。信任这些请求头的网关
  就不会被误导。（2.4.0 把没有矛盾请求头的这种请求按旧版请求回答；旧版客户端不会发这个请求头值。无论请求头写什么，
  `initialize` 仍走旧版握手。）
- 所有入口都不检查 `Mcp-Param-*` 请求头。TapeAPI 的工具都没有声明 `x-mcp-header`。被代理的上游工具若声明了，代理的 `/mcp`
  既不要求这个请求头，也不拿它核对参数，而 2026-07-28 要求服务器这样做（「Server Behavior for Custom Headers」）：不要让代理前面
  的网关依据 `Mcp-Param-*` 请求头做决定；上游若依赖它们，请在上游自己核对。
- `initialize` 请求总是用三个旧版本之一回答，即使它带了 2026-07-28 的元数据。客户端随后按那个版本通信。
- `cacheScope` 固定为 `"public"`：没有哪个入口会按调用方给出不同的 `tools/list`。基于 `createMcpServer` 写的代码若按调用方
  过滤列表，就需要 `"private"`，这一版不提供。
- 2.5 之前，版本键的值若不是任何版本（`"latest"`、`"2026-7-28"`、更晚的日期、数字），会被当作旧版本请求回答。现在按
  2026-07-28 的要求拒绝。
- 签名代理连接上游时默认仍以 `initialize` 开场，与以前相同。设置 `upstreamNegotiation: 'auto'`（实验性）后，它先向上游发
  `server/discover`，上游支持 2026-07-28 就用它通信，所以只支持 2026-07-28 的上游也能代理；其它回答都会让它退回
  `initialize`。本地命令读取已 tape out 的 MCP 服务器的工具（从它的 `mcp.endpoint`）时，可以用
  `tapeapi-mcp --upstream-negotiation auto`（实验性，2.5；默认 `legacy` 与以前一样以 `initialize` 开场）按同样的规则选择。
  变的只是读取方式：工具仍须哈希到清单的 `mcp.toolsSha256`，钉住的是同一个摘要，每次调用仍走签名的 TapeAPI 路径。
  日志行会写明这次是怎样读取的。

三个旧版本继续支持，没有定下移除日期。MCP 项目的弃用政策给已弃用的功能至少十二个月。

我们没有逐个试过各种客户端。官方 TypeScript 客户端 v2（`@modelcontextprotocol/client` 2.3.1）在本机连过远程服务器、签名
代理、公共服务的 `/mcp` 和 `/mcp/pinned`，以及本地命令：默认模式（2025-11-25）和指定 2025-06-18、2025-03-26 时它用
`initialize` 连接，`auto` 模式和指定 `2026-07-28` 时它经由 `server/discover`、不发 `initialize` 连接；每种情况下都列出了工具
并调用成功。测试本身发送的是规范描述的请求。

2026-10-21 对照规范核对过，当时 2026-07-28 是最新版本：
[版本与旧服务器](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)、
[消息、错误码与 `_meta`](https://modelcontextprotocol.io/specification/2026-07-28/basic/index)、
[`server/discover`](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)、
[缓存](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching)、
[Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)、
[stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)、
[自 2025-11-25 以来的变化](https://modelcontextprotocol.io/specification/2026-07-28/changelog)。

## 本地核验命令

`tapeapi-mcp` 是 SDK 发布包里的一个本地 MCP 服务器（stdio），需要 Node.js 20 或以上。`npx` 从 GitHub Release 取得它，
不经过 npm 注册表：

```bash
npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v2.5.0/tapeapi-sdk-2.5.0.tgz tapeapi-mcp 11.1013.tape
```

它和远程服务器的不同之处：

- **它自己核验每个回答。** 它按 SDK 的方式从链上解析服务（每一步见[调用服务](consume.md)），然后对照持有者委托的密钥
  核验每个回答的签名，之后才把结果交给模型。
- **它钉住服务的工具定义。** 第一次使用时，它把每个服务的方法（名称、说明、参数、价格）和签名密钥记在
  `~/.tapeapi/mcp-pins.json`。如果持有者之后发布的清单里这些有变化，命令会拒绝对该服务的所有调用，什么都不发送，并说明
  改了什么。改动可能是正常更新，也可能是 rug pull；命令不做猜测。要接受改动，用 `--allow-changed` 重启一次命令，它会
  重新钉住新的定义。续签委托或更换端点不算改动。
- **它接受任何服务。** 把 `11.1013.tape` 换成另一个 TapeAPI 服务的 TapeOut 名称或容器地址，也可以同时列出多个。只有免费
  方法会成为工具。

`tapeapi-mcp --help` 列出其他选项：`--rpc` 指定你自己的 BNB Chain 节点，`--pin` 换一个钉住文件，`--no-pin` 只在本次
会话内钉住。

### Claude Desktop

打开 **Settings > Developer > Edit Config**（设置 > 开发者 > 编辑配置），把服务器加到 `claude_desktop_config.json`，
然后重启 Claude Desktop：

```json
{
  "mcpServers": {
    "tapeapi": {
      "command": "npx",
      "args": [
        "-y",
        "--package=https://github.com/BruceLanLan/tapeapi/releases/download/v2.5.0/tapeapi-sdk-2.5.0.tgz",
        "tapeapi-mcp",
        "11.1013.tape"
      ]
    }
  }
}
```

### Cursor

同样的条目放在 `~/.cursor/mcp.json` 或 `.cursor/mcp.json` 的 `mcpServers` 下：

```json
{
  "mcpServers": {
    "tapeapi": {
      "command": "npx",
      "args": [
        "-y",
        "--package=https://github.com/BruceLanLan/tapeapi/releases/download/v2.5.0/tapeapi-sdk-2.5.0.tgz",
        "tapeapi-mcp",
        "11.1013.tape"
      ]
    }
  }
}
```

### Claude Code

```bash
claude mcp add tapeapi -- npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v2.5.0/tapeapi-sdk-2.5.0.tgz tapeapi-mcp 11.1013.tape
```

### 远程还是本地

| | 远程服务器 | 本地命令 |
|---|---|---|
| 安装 | 无 | Node.js 20 或以上 |
| 谁核验签名 | 任何人，事后用链接核验 | 命令本身，在模型看到结果之前 |
| 工具列表 | 以服务器列出的为准 | 从链上清单读取并钉住；有变化时拒绝调用，直到你接受 |
| 服务 | `11.1013.tape` | 任何 TapeAPI 服务，按名称或容器地址指定 |
| 限流 | 按 IP 地址，同一地址后面的所有人共享 | 你自己的 IP 地址 |

## 读懂并核验回执

回执是一个小的 JSON 对象：

| 字段 | 含义 |
|---|---|
| `service` | `circuits` 和 `tokenId`（电路）、`container`（它的地址）和 `name`（TapeOut 名称） |
| `method`、`params` | 签名所绑定的请求 |
| `id`、`ts` | 请求 id，以及服务签名的时间（Unix 秒） |
| `ok` 以及 `result` 或 `error` | 回答；拒绝也有签名 |
| `block` | 服务签名时看到的链头 |
| `sig` | 服务对以上所有内容的签名（[TAPI-21](../../../spec/TAPI-21.md)） |

### 在浏览器里核验

打开核验链接。回执放在网址 `#` 之后的部分，浏览器从不把这部分发给服务器。`https://tapeapi.fun/verify/` 页面在你的
浏览器里从链上解析服务，从签名恢复签名者，对照持有者的委托核对，并显示结果。

### 链接的两种形态

- **只带哈希（默认）。** 链接里的回执把 `params` 与 `result`（或 `error`）换成签名所依据的两个哈希：`requestHash` 是规范化
  `{ method, params }` 的 keccak256，`bodyHash` 是规范化结果的 keccak256。核验页由它们重建 TAPI-21 摘要，所以能核对谁签的、
  哪个服务、什么时间，但拿到链接的人看不到问了什么、答了什么。`method` 按回执所写展示：它只经 `requestHash` 与参数一起绑定。
- **带原文**（`verifyLink(receipt, base, { content: true })`、服务端 `linkContent: true`、`tapeapi-mcp --link-content`）。
  整份回执都在链接里：核验页显示参数与结果，链接转给谁，谁也看得到。
- **哈希只能藏住猜不到的内容。** 取自小集合的参数（地址、token id、交易对）和简短的结果，可以通过对候选取哈希确认出来。
  这类调用的只带哈希链接，应当视同公开了调用内容。
- `_meta["fun.tapeapi/receipt"]` 里的回执始终是完整的：它交给发起调用的 MCP 客户端。
- 核验页是纯静态文件（`site/verify/`）；`verifyLink(receipt, base)` 的 `base` 可以填你自己部署的副本地址，在自己托管的页面上核验。

### 离线用 SDK 核验

把回执（`_meta["fun.tapeapi/receipt"]` 对象）存为 `receipt.json`。从 GitHub Release 安装 SDK，或者像
[调用服务](consume.md)里那样在仓库的克隆目录里操作：

```bash
npm install https://github.com/BruceLanLan/tapeapi/releases/download/v2.5.0/tapeapi-sdk-2.5.0.tgz
```

```js
import { readFile } from 'node:fs/promises'
import { createTapeAPI, sig } from '@tapeapi/sdk'

const r = JSON.parse(await readFile('receipt.json', 'utf8'))
const api = createTapeAPI({
  rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-mainnet.public.blastapi.io', 'https://rpc-bsc.48.club'],
  quorum: 2,
})
// 链上现在的服务：容器、链上清单、持有者对签名密钥的委托
const svc = await api.resolve({ circuits: r.service.circuits, tokenId: r.service.tokenId })
const signer = sig.recoverResponseSigner({
  container: svc.container, id: r.id, method: r.method, params: r.params,
  ok: r.ok, body: r.ok ? r.result : r.error, ts: r.ts,
}, r.sig)
const same = (a, b) => a.toLowerCase() === b.toLowerCase()
console.log(same(signer, svc.manifest.signer) && same(r.service.container, svc.container) ? 'valid' : 'NOT valid')
```

把结果改动一个字符，恢复出的签名者就会变，核验随之失败。这里比对的是服务**当前**的委托：如果持有者之后把签名委托给了
另一把密钥，较早的回执就对不上了。不用 SDK 核验，见[不使用 SDK 进行验证](consume.md#不使用-sdk-进行验证)。

## 限制

- **远程服务器为自己的回答作证。** 它负责签名，不替你核验。链接让任何人都能核验。本地命令则在模型看到结果之前自己核验每个回答。
- **没有回执的回答没有签名。** 服务被限流或委托已失效时，工具返回一个错误，不带回执，也没有链接，没有可以核验的东西。
- **限流沿用公共服务的规则：** 每个 IP 地址每分钟 600 次免费调用。Claude.ai 这样的托管客户端从自己的服务器发起调用，
  所以许多用户可能共用一个地址和它的额度。
- **公共工具都是对 BNB Smart Chain** 和 TapeOut 的读取。它们免费，不发送交易，不动用资金。
- **"有签名"证明的是谁回答了，不证明数据正确。** 重要的数值，请向另一个独立的提供者询问同一个区块
  （[价格与交叉核对](public-api.md#价格与交叉核对)）。
- **现货价格可以被操纵。** `pairPrice` 和 `bnbUsd` 来自一个资金池在某个区块的储备，一笔大额交易就能推动它们。不要单独
  用它们做任何攻击者能从操纵中获利的事。
- **结果是数据，不是指令。** 代币的名称和符号由部署代币的人随意决定，有签名不代表可以照着做。
- 公共服务尽力而为地运行，没有 SLA。

## 把你自己的 TapeAPI 服务变成 MCP 服务器

`@tapeapi/server/mcp` 里的 `createMcpEndpoint` 能把任何提供者变成远程 MCP 服务器。这些包还没有发布到 npm：从 GitHub 发布页
安装两个包，先装 SDK（见 [server README](../../../server/README.md#install)），或者在仓库的克隆目录里操作，和[运行服务](provide.md)
一样。公共服务就是这样做的
（[`examples/public-api/worker.js`](../../../examples/public-api/worker.js)）：

```js
import { createProvider } from '@tapeapi/server'
import { createMcpEndpoint, MCP_PATH } from '@tapeapi/server/mcp'

const provider = createProvider({ manifest, signerKey, rpcUrls, quorum: 2, methods })
const mcp = createMcpEndpoint({ provider, manifest: provider.manifest, name: '11.1013.tape' })

export default {
  fetch(request) {
    const clientIp = request.headers.get('cf-connecting-ip') || undefined
    if (new URL(request.url).pathname === MCP_PATH) return mcp.handleRequest(request, { clientIp })
    return provider.handleRequest(request, { clientIp })
  },
}
```

- 清单里每个免费方法都会成为一个工具。收费方法不会暴露。
- 每次工具调用都像普通调用一样经过 `provider.handleRequest`，所以结果是同样签名的信封，受同样的限流，并附带回执和核验链接。
- `/mcp` 是你服务器上的一条路由。加上它不需要改清单，也不改变链上任何东西。
- **公共服务不在清单里声明这条路由**（没有 `mcp` 字段），这是决定，不是还没做。清单的 `mcp` 字段（[TAPI-20 §3.8](../../../spec/TAPI-20.md)，
  以及 MCP 工具草案 TAPs #16）是为另一个方向写的：签名代理在前、真正的 MCP 服务器在后（见下文“Tape out 你自己的 MCP 服务器”），
  每个方法就是一个 MCP 工具，它的签名结果就是该工具的 MCP 结果（`{ content, ... }`）。`createMcpEndpoint` 方向相反：工具由方法生成，
  每个方法回答的是它自己的 JSON。若 `11.1013.tape` 声明了 `mcp`，`tapeapi connect` 会把它显示为 MCP 工具服务并给出 `tapeapi-mcp`
  的配置，而 `tapeapi-mcp` 会核验每个回答、然后拒绝把它当作工具结果展示。所以 `/mcp` 一直不声明。
- **2.4 起，公共 Worker 的代码提供符合 §3.8 的工具方法**（实验性）。另外八个免费方法 `tool_block_number`、`tool_balance`、
  `tool_token_info`、`tool_token_balance`、`tool_nft_owner`、`tool_pair_price`、`tool_bnb_usd`、`tool_tape_name` 做同样的读取，
  签名回答恰为 MCP 工具结果（`{ content: [{ type: "text", text }], structuredContent }`）。它们是第二个端点 `/mcp/pinned` 仅有的
  工具，清单要声明的正是这个端点：`mcp: { endpoint: ".../mcp/pinned", toolsSha256 }`。只有它们受这个摘要约束；REST 方法与 `/mcp`
  的回答与不设该变量时相同。这样 `tapeapi-mcp` 会展示这八个工具和它们的回答。两者都只在 Worker 设置了 `MCP_TOOLS_SHA256` 变量时出现，
  `/mcp/pinned` 由 `createMcpEndpoint({ ..., mcpResults: true, pinnedToolsSha256 })` 提供：自 2.5 起，工具摘要不等于该变量时，它的
  `tools/list` 按签名代理的方式拒绝（`-32603`，`data.code: "TOOLS_CHANGED"`）（见
  [`examples/public-api/worker.js`](../../../examples/public-api/worker.js)）。**代码已上线，工具是关着的**：`api.tapeapi.fun`
  从本仓库的 `main` 重新部署，所以从 2.4 起运行这份代码；但线上没有设置该变量，所以在有人手动设置之前，它既不提供工具方法，也不提供
  `/mcp/pinned`（回答与 2.3 相同，版本号除外）。在持有人随后发布这份清单之前，`11.1013.tape` 什么都不声明：`tapeapi connect 11.1013.tape`
  显示 `not-ai`，接入它请用本指南开头的配置。
- `@tapeapi/server/mcp` 为本端点的摘要提供实验性辅助函数：`await mcp.toolsSha256()`（客户端对其 `tools/list` 算出的摘要）、
  `listedMcpTools(manifest)`、`mcpToolsSha256(manifest)`，以及 `holdToToolsSha256(methods, { manifest, published })`——工具与已发布的
  摘要不再相符时，以签名的 `TOOLS_CHANGED` 拒绝这些工具对应的方法。用它们做出的声明，只有在你的方法本身回答 MCP 工具结果时才符合
  §3.8。如果你运行的是真正的 MCP 服务器，请改用下文的签名代理：`createMcpProxy` 自己算出你要发布的 `toolsSha256`，并自己让调用受它约束。
- `name` 是结果和回执里显示的 TapeOut 名称。
- 核验链接只带哈希；`linkContent: true` 让链接带上明文参数与结果。
- `mcpResults: true`（实验性，2.4）用于签名结果本身就是 MCP 工具结果（`{ content, structuredContent?, isError? }`）的方法：
  每个结果放在来源说明行之后，作为该工具结果交出（冒充该行的文本标注为工具自己的输出），而不是作为 JSON 文本。默认 false：
  结果都是数据，以 JSON 文本展示。

## Tape out 你自己的 MCP 服务器

这一节写给已经在运行 MCP 服务器的人。服务器和域名仍是你自己的。在它前面放一个签名代理，补上 MCP 缺少的东西：

- **链上身份。** 代理代表一个 TapeOut 电路的容器作答，所以谁在回答是一次链上查询，而不是一句自我声明。
- **钉在链上的工具定义。** 你容器链上站点里的清单带有 `mcp.toolsSha256`：对每个工具的名称、标题、说明、输入与输出
  schema 和 annotations 计算的 SHA-256（[TAPI-20 §3.8](../../../spec/TAPI-20.md)）。工具在用户批准之后被改掉（MCP 的
  "rug pull"）时，核对摘要的客户端会拒绝它们，代理自己也会停止服务。
- **每个结果都有签名。** 每次工具调用都得到一个签名的 TAPI-21 信封；经 `/mcp` 调用时还附带回执和核验链接，和上面的公共服务
  一样。

代理以及控制台对它的支持现在就能用。目前还没有任何第三方 MCP 服务器被 tape out。这些包还没有发布到 npm，所以请在仓库的
克隆目录里操作，和[运行服务](provide.md)一样。

### 1. 在你的服务器前面运行代理

代理就是 `@tapeapi/server/mcp-proxy` 里的 `createMcpProxy`。[`examples/mcp-proxy/`](../../../examples/mcp-proxy/)
可以用 Node 运行它，也可以部署成 Cloudflare Worker。先在本地试一下：不设置 `UPSTREAM_URL` 时，它会启动一个带两个工具
（`add` 和 `shout`）的小型演示 MCP 服务器，并包裹它。

```bash
npm install --no-audit --no-fund       # 在仓库根目录，只需一次
node examples/mcp-proxy/index.mjs      # http://127.0.0.1:8796，使用一次性的签名密钥
```

```bash
curl -s http://127.0.0.1:8796/.well-known/tapeapi.json
curl -s -X POST http://127.0.0.1:8796/tapeapi/v1/add -H 'content-type: application/json' -d '{"id":"1","params":{"a":2,"b":40}}'
curl -s -X POST http://127.0.0.1:8796/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"shout","arguments":{"text":"hi","times":2}}}'
```

代理有三条路由：

| 路由 | 是什么 |
|---|---|
| `GET /.well-known/tapeapi.json` | 清单：你的身份字段、每个工具对应的一个免费方法，以及 `mcp: { endpoint, toolsSha256 }` |
| `POST /tapeapi/v1/<工具名>` | 签名调用：传入 `{ id, params }`，返回 TAPI-21 信封，其中 `result` 是你的服务器给出的工具结果去掉 `_meta` |
| `POST /mcp` | 远程 MCP（Streamable HTTP，无状态）：`tools/list` 按你的服务器列出的样子返回工具；`tools/call` 返回你的服务器给出的内容，加一行来源说明，回执放在 `_meta` 里 |

要包裹你自己的服务器，把 `UPSTREAM_URL` 指向它的 Streamable HTTP 端点。服务器需要密钥时，设置
`UPSTREAM_AUTHORIZATION`：这是由你设定的固定请求头。调用方的请求头永远不会转发给你的服务器。

```bash
UPSTREAM_URL=https://your-server.example/mcp UPSTREAM_AUTHORIZATION="Bearer ..." node examples/mcp-proxy/index.mjs
```

上线时，代理需要一个属于你的 https 主机名，因为它的网址会写进链上清单：

- **Cloudflare Worker。** 在 `examples/mcp-proxy/wrangler.toml` 里设置 `UPSTREAM_URL`（Worker 名为
  `my-tapeapi-mcp-proxy`），然后用 `npx --yes wrangler@4.141.0 deploy -c examples/mcp-proxy/wrangler.toml` 部署。
  在 Cloudflare 后台给 Worker 添加自定义域名，并把变量 `PUBLIC_URL` 设为它。身份设置好之前，Worker 只回答
  `/tapeapi/v1/health`，其中给出由 secret `SIGNER_KEY` 推导出的签名地址：设置模式与
  [从手机上线](provide.md#2-从手机上线cloudflare-与持有者控制台)相同。
- **Node。** 在你自己的 https 反向代理后面运行 `examples/mcp-proxy/index.mjs`，在环境变量里设置 `PUBLIC_URL`、
  `SIGNER_KEY` 和下面的身份变量（`HOST` 和 `PORT` 决定监听位置，`NAME` 设置服务名称）。

身份的添加方式和任何 TapeAPI 服务完全一样：铸造电路并开通容器，在[持有者控制台](https://tapeapi.fun/console/)里填入
代理的网址，签署委托，把 `CIRCUITS`、`TOKEN_ID`、`CONTAINER`、`DELEGATION_EXPIRES` 和 `DELEGATION_SIG` 设为变量，
`SIGNER_KEY` 设为 secret。每一步见[运行服务](provide.md#2-从手机上线cloudflare-与持有者控制台)。

**浏览器与 `Origin`（2.5，实验性）。** 默认情况下 `/mcp` 对任何来源都以 CORS `*` 作答：不涉及 cookie、会话或调用方密钥，网页
得不到它直接调用拿不到的东西。但代理若在你自己的电脑（或内网）上运行，前面是有副作用的工具（文件、shell、数据库），情况就不同了：
你打开的任何网页都能经 `http://127.0.0.1:.../mcp` 调用这些工具。请给 `createMcpProxy` 设置 `allowedOrigins: ['https://app.example']`
（`examples/mcp-proxy/index.mjs` 里是变量 `ALLOWED_ORIGINS`，逗号分隔）：`Origin` 不在名单内的请求在执行任何东西之前就以 HTTP 403
拒绝（Streamable HTTP 的要求）；名单内的来源代替 `*` 回显；不带 `Origin` 的请求（桌面客户端、`curl`）照常作答。`createMcpEndpoint`
有同样的选项，公共 Worker 用变量 `MCP_ALLOWED_ORIGINS`。

### 2. 用持有者控制台发布清单

控制台的发布步骤会读取代理的 `/.well-known/tapeapi.json`。清单里有 `mcp` 字段时，控制台不听代理的一面之词：它在你的
浏览器里自己从 `mcp.endpoint` 读取 `tools/list`，按客户端的方法计算摘要。只有摘要等于代理报出的 `toolsSha256`、而且
每个方法都是其中一个工具，才会发布。在钱包请求签名之前，控制台会列出每个工具的名称和说明。请逐个读一遍：你是在用电路的
名义为这套工具担保。发布的清单里带有 `mcp` 字段。

然后把 `TOOLS_SHA256`（Worker 变量，或 Node 的环境变量）设为你发布的 `mcp.toolsSha256`。不设它，代理重启时会把启动时
读到的工具当作已发布的工具，而 Worker 的隔离实例随时可能被重启。设了它，重启之后被改过的工具同样会被拒绝。

### 3. 让用户接入

- **按网址接入。** 用户在 Claude、Cursor 或任何 MCP 客户端里添加 `https://<你的主机名>/mcp`，和本指南开头的公共服务
  一样。每个结果都带回执和核验链接。
- **用本地命令接入。** `tapeapi-mcp` 接受你的 TapeOut 名称（或容器地址），从链上解析你的服务，先把工具与链上的摘要核对，
  再按你的服务器定义的样子展示它们（v0.5.0 及以后）：

  ```bash
  # 42.1013.tape 是示例名：换成你的服务的 TapeOut 名字
  npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v2.5.0/tapeapi-sdk-2.5.0.tgz tapeapi-mcp 42.1013.tape
  ```

### 用 `tapeapi connect` 查看服务

`tapeapi connect <名字>`（实验性，对 MCP 工具服务 2.3 起，不受 2.x 兼容承诺约束）按链上的样子展示已 tape out 的 MCP 服务器。清单有 `mcp` 字段、
没有 `ai` 字段时，卡片写明“MCP 工具服务”，显示端点、清单里的免费方法（`tapeapi-mcp` 不提供收费方法；其中哪些是工具由端点的 `tools/list` 决定）与 `toolsSha256` 的前 8 位，再给出 Claude Code 与
Claude Desktop 的配置：经 `tapeapi-mcp`（每个回答在你的机器上核验），以及标明不核验的、直连声明端点的写法（直连的回答不是签名信封，不要当作已签名或已核验）。它只读链与清单：不访问端点，
任何配置都不含密钥。`--proxy` 为该服务运行 `tapeapi-mcp`（stdout 上是它的 JSON-RPC，卡片写到 stderr）。

```bash
# 在检出里（先在根目录 npm ci 一次）；42.1013.tape 是示例名
node sdk/bin/tapeapi.js connect 42.1013.tape
```

没有 `mcp` 字段的清单显示为不可用（`not-ai`）。公共服务 `11.1013.tape` 在持有人发布声明 `/mcp/pinned` 的清单之前就是这样（见上文
“把你自己的 TapeAPI 服务变成 MCP 服务器”），请用本指南开头的配置接入它。本命令不访问端点，所以那一行把清单里的免费方法列为“方法”而不是“工具”
（对那份清单是全部 16 个：工具方法也免费），也不说其中有几个是工具：工具是端点 `tools/list` 列出的那些方法（那里是 8 个），读取该列表的
`tapeapi-mcp` 只提供它们（2.4；2.3 里这一行标为“工具”）。

### 客户端核对什么

- **`tapeapi-mcp`** 在链上解析服务和持有者的委托。它从 `mcp.endpoint` 读取 `tools/list` 并计算摘要，与链上的
  `mcp.toolsSha256` 不同时，拒绝该服务的所有工具，什么都不发送。它把这个摘要连同方法和签名密钥一起钉在
  `~/.tapeapi/mcp-pins.json`。每次调用都走 `/tapeapi/v1/<工具名>`，信封的签名在模型看到结果之前按委托的密钥核验，并且
  绑定本次请求。
- **按网址连接 `/mcp` 的客户端自己什么都不核对。** 它依靠代理（工具与已发布的摘要不符时，代理拒绝服务），以及任何人事后都能
  在 `https://tapeapi.fun/verify/` 核验的回执。
- **工具报错也作为回答签名。** 你的服务器返回 `isError: true` 时，信封是 `ok: true`：签名证明的是你的服务器这样回答了。
  只有代理自己的拒绝才是 `ok: false`。

### 改了工具之后

工具定义的任何改动都会改变摘要，哪怕只改了说明里的一个词。代理在每次 `tools/list` 时重读工具，另外在距上次读取超过
60 秒后的第一次调用时重读。一旦与已发布的摘要不同：

- 每次调用都得到签名的 `TOOLS_CHANGED` 错误（HTTP 409，带 `data: { published, current }`）；
- `/mcp` 上的 `tools/list` 返回 JSON-RPC 错误，`/tapeapi/v1/health` 报告 `ok: false`。

这种状态一直持续到你发布新的工具集：

1. 确认这次改动是你自己做的。
2. 把 `TOOLS_SHA256` 设为新的摘要（拒绝里的 `current` 值，`/tapeapi/v1/health` 里也以 `upstreamToolsSha256` 给出），
   或者删掉它，然后重启或重新部署代理。`TOOLS_SHA256` 仍是旧摘要时，代理会拒绝 `tools/list`，控制台就读不到你的工具。
3. 像上面第 2 步那样，用持有者控制台重新发布清单。

从重启到发布之间，按网址连接 `/mcp` 的客户端已经能看到新工具；`tapeapi-mcp` 则会拒绝它们，因为它们与链上还不一致。
发布之后，`tapeapi-mcp` 在链上看到一个与它钉住的不同的新摘要，会拒绝你的服务，直到它的用户用 `--allow-changed` 重启一次
命令、接受这次改动。新的工具集只有经过这些用户同意才会到达他们那里。

### 它做不到什么

- **签名证明的是谁回答了、工具定义是已发布的那一套，不证明回答正确。** 摘要约束的是定义，不是行为：同一套定义下，服务器
  仍可能给出不同的回答。签名让这种情况可以追责，而不是不可能发生。你为放在自己电路后面的服务器担保。
- **只支持 Streamable HTTP 服务器。** 你的服务器必须通过 Streamable HTTP 提供 MCP；stdio 服务器需要先桥接成 HTTP。
  只代理工具：不代理 resources 和 prompts，没有服务器到客户端的推送流（对 `/mcp` 的 GET 得到 HTTP 405），sampling、
  elicitation 和进度通知都不转发。你的服务器的 `instructions` 也不转发，因为它不在摘要覆盖范围内。
- **工具名必须是 TAPI-20 的方法名**（`[A-Za-z_][A-Za-z0-9_]{0,63}`）。其他名字的工具仍会出现在 `tools/list` 里（摘要覆盖
  全部工具），但不能经代理调用。代理的启动日志会列出这些工具。
- **目前只有免费工具。** 每个工具都成为一个免费方法。付费调用要等托管合约通过审计（[路线图](../../ROADMAP.md)）。
- **控制台这一步需要 CORS。** 控制台在你的浏览器里从 `mcp.endpoint` 读取 `tools/list`，所以这个端点必须允许来自
  `https://tapeapi.fun` 的跨域请求。代理的 `/mcp` 已经允许。不要在它前面放任何会拦截 `OPTIONS` 请求或去掉 CORS 响应头的东西。
- **大小限制。** 你的服务器单次回答最多 1 MiB、20 秒。清单里每个方法的说明截到 256 个字符（Unicode 码点），完整文本由 `toolsSha256`
  钉住。控制台一笔交易最多发布 24 000 字节、64 个方法。
- **限流**按进程计算（Worker 按隔离实例计算）：默认每个 IP 地址每分钟 600 次免费调用。
