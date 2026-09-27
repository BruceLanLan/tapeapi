[English](../mcp.md) | 中文

# 在 Claude、Cursor 等 MCP 客户端中使用 TapeAPI

公共服务的八个方法可以作为 [Model Context Protocol](https://modelcontextprotocol.io)（MCP）工具使用。在 Claude、Cursor
或任何 MCP 客户端里加一个网址，你的助手就能读取 BNB Smart Chain，而且每个回答都有签名，任何人事后都能对照链上核验。

有两种接入方式：

- **远程服务器** `https://api.tapeapi.fun/mcp`。无需安装。服务给每个回答签名；你或任何人事后都能用随附的链接核验。
- **本地命令** `tapeapi-mcp`。在你自己的电脑上运行，在模型看到结果之前先对照链上核验每个回答；服务的工具在链上被改动时，
  它会拒绝调用，直到你接受这次改动。

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
the chain with the link. Verify: https://tapeapi.fun/verify/#r=eyJ2IjoxLCJzZXJ2aWNl...
```

## 本地核验命令

`tapeapi-mcp` 是 SDK 发布包里的一个本地 MCP 服务器（stdio），需要 Node.js 20 或以上。`npx` 从 GitHub Release 取得它，
不经过 npm 注册表：

```bash
npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v0.3.0/tapeapi-sdk-0.3.0.tgz tapeapi-mcp 11.1013.tape
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
        "--package=https://github.com/BruceLanLan/tapeapi/releases/download/v0.3.0/tapeapi-sdk-0.3.0.tgz",
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
        "--package=https://github.com/BruceLanLan/tapeapi/releases/download/v0.3.0/tapeapi-sdk-0.3.0.tgz",
        "tapeapi-mcp",
        "11.1013.tape"
      ]
    }
  }
}
```

### Claude Code

```bash
claude mcp add tapeapi -- npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v0.3.0/tapeapi-sdk-0.3.0.tgz tapeapi-mcp 11.1013.tape
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
| `sig` | 服务对以上所有内容的签名（[TAP-21](../../../spec/TAP-21.md)） |

### 在浏览器里核验

打开核验链接。回执放在网址 `#` 之后的部分，浏览器从不把这部分发给服务器。`https://tapeapi.fun/verify/` 页面在你的
浏览器里从链上解析服务，从签名恢复签名者，对照持有者的委托核对，并显示结果。

### 离线用 SDK 核验

把回执（`_meta["fun.tapeapi/receipt"]` 对象）存为 `receipt.json`。从 GitHub Release 安装 SDK，或者像
[调用服务](consume.md)里那样在仓库的克隆目录里操作：

```bash
npm install https://github.com/BruceLanLan/tapeapi/releases/download/v0.3.0/tapeapi-sdk-0.3.0.tgz
```

```js
import { readFile } from 'node:fs/promises'
import { createTapeAPI, sig } from '@tapeapi/sdk'

const r = JSON.parse(await readFile('receipt.json', 'utf8'))
const api = createTapeAPI({
  rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-dataseed1.ninicoin.io'],
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
- Pre-alpha。公共服务尽力而为地运行，没有 SLA。

## 把你自己的 TapeAPI 服务变成 MCP 服务器

`@tapeapi/server/mcp` 里的 `createMcpEndpoint` 能把任何提供者变成远程 MCP 服务器。这些包还没有发布到 npm，服务端包也还没有
发布文件，所以请在仓库的克隆目录里操作，和[运行服务](provide.md)一样。公共服务就是这样做的
（[`examples/public-api/worker.js`](../../../examples/public-api/worker.js)）：

```js
import { createProvider } from '@tapeapi/server'
import { createMcpEndpoint, MCP_PATH } from '@tapeapi/server/mcp'

const provider = createProvider({ manifest, signerKey, rpcUrls, quorum: 2, methods })
const mcp = createMcpEndpoint({ provider, manifest: provider.manifest, identity: { name: '42.1013.tape' } })

export default {
  fetch(request) {
    const clientIp = request.headers.get('cf-connecting-ip') || undefined
    if (new URL(request.url).pathname === MCP_PATH) return mcp.handle(request, { clientIp })
    return provider.handleRequest(request, { clientIp })
  },
}
```

- 清单里每个免费方法都会成为一个工具。收费方法不会暴露。
- 每次工具调用都像普通调用一样经过 `provider.handleRequest`，所以结果是同样签名的信封，受同样的限流，并附带回执和核验链接。
- `/mcp` 是你服务器上的一条路由，不属于清单，所以加上它不改变链上任何东西，也不需要重新发布清单。
- `identity.name` 是结果和回执里显示的 TapeOut 名称。
