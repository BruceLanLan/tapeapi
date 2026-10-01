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

## 本地核验命令

`tapeapi-mcp` 是 SDK 发布包里的一个本地 MCP 服务器（stdio），需要 Node.js 20 或以上。`npx` 从 GitHub Release 取得它，
不经过 npm 注册表：

```bash
npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.4.0/tapeapi-sdk-1.4.0.tgz tapeapi-mcp 11.1013.tape
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
        "--package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.4.0/tapeapi-sdk-1.4.0.tgz",
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
        "--package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.4.0/tapeapi-sdk-1.4.0.tgz",
        "tapeapi-mcp",
        "11.1013.tape"
      ]
    }
  }
}
```

### Claude Code

```bash
claude mcp add tapeapi -- npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.4.0/tapeapi-sdk-1.4.0.tgz tapeapi-mcp 11.1013.tape
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
npm install https://github.com/BruceLanLan/tapeapi/releases/download/v1.4.0/tapeapi-sdk-1.4.0.tgz
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
- `/mcp` 是你服务器上的一条路由，不属于清单，所以加上它不改变链上任何东西，也不需要重新发布清单。
- `name` 是结果和回执里显示的 TapeOut 名称。
- 核验链接只带哈希；`linkContent: true` 让链接带上明文参数与结果。

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
  npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.4.0/tapeapi-sdk-1.4.0.tgz tapeapi-mcp 42.1013.tape
  ```

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
