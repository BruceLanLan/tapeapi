[English](../consume.md) | 中文

# 调用服务

本指南介绍应用如何找到一个 TapeAPI 服务、调用它，并确认回答是真实的。它使用 `@tapeapi/sdk`，可运行于
Node 20+、浏览器、DeWEB 站点和 Cloudflare Workers。

## 1. 试用

### 一次性准备

这些包尚未发布到 npm，所以要在仓库的克隆里操作（Node.js 20 或更高版本）：

```bash
git clone https://github.com/BruceLanLan/tapeapi.git && cd tapeapi && npm install
```

或者只把 SDK 装进你自己的项目，从 GitHub 版本发布页安装（不是 npm 仓库）：

```bash
npm install https://github.com/BruceLanLan/tapeapi/releases/download/v0.5.0/tapeapi-sdk-0.5.0.tgz
```

把下面的脚本保存为 `.mjs` 文件，**放在 `tapeapi` 目录之内**，然后用 `node <文件>.mjs` 运行。`@tapeapi/sdk` 通过仓库的
workspace 解析，保存在其它任何位置的脚本都会以 `ERR_MODULE_NOT_FOUND` 失败。

### 调用线上的公共服务

一个免费的公共服务运行在 `https://api.tapeapi.fun`，TapeOut 名称为 `11.1013.tape`。用 curl：

```bash
curl -s https://api.tapeapi.fun/tapeapi/v1/bnbUsd -H 'content-type: application/json' -d '{"id":"1","params":{}}'
```

curl 会显示签名信封（`result`、`container`、`ts`、`block`、`sig`），但不会验证它。SDK 从链上解析服务，并在返回之前
验证回答：

```js
import { createTapeAPI } from '@tapeapi/sdk'

const api = createTapeAPI({
  rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-mainnet.public.blastapi.io', 'https://rpc-bsc.48.club'],
  quorum: 2,
})
const svc = await api.resolve('11.1013.tape')
const { result, verified } = await api.call(svc, 'bnbUsd', {})
console.log(result, verified)
```

[调试台](https://tapeapi.fun/playground/)在浏览器里运行同一份 SDK，无需安装任何东西；[公共 API](public-api.md) 列出了
公共服务的全部方法。

### 在本地运行服务

启动最小示例服务。它通过公共节点读取 BNB Chain，并用一把临时密钥签名：

```bash
node examples/reader-service/index.mjs          # :8787
```

```js
import { createTapeAPI } from '@tapeapi/sdk'

const api = createTapeAPI({ dev: true })          // dev：接受没有链上清单的本地 http:// 服务
const svc = await api.resolve({ dev: 'http://127.0.0.1:8787' })
const { result, block, verified } = await api.call(svc, 'blockNumber', {})
console.log(result.blockNumber, block, verified)
```

`api.call` 只有在签名信封检查通过后才返回。如果回答在传输中被篡改、由另一把密钥签名，或已是五分钟以前的回答，你得到的是
`TapeAPIError`，永远不会是结果。

## 2. 在 BNB Chain 上解析真实服务

在主网上，SDK 所信任的一切都从链上读取，并经由多个必须达成一致的 RPC 节点：

```js
const api = createTapeAPI({
  rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-mainnet.public.blastapi.io', 'https://rpc-bsc.48.club'],
  quorum: 2,
})

const byName = await api.resolve('11.1013.tape')                   // <#ID>.<processor>.tape
const byContainer = await api.resolve('0x<container address>')
const byCircuit = await api.resolve({ circuits: '0x<processor contract>', tokenId: '11' })
```

TapeOut 名称 `<#ID>.<processor>.tape` 同样从链上读取：处理器编号给出处理器合约（`factory.cpuAt`），该合约加上 `#ID`
给出容器（`DeWebHub.accountOf`）。它不比 `{ circuits, tokenId }` 形式多引入任何信任；上面三种形式经过同样的检查。

解析（[TAP-20 §3.6](../../../spec/TAP-20.md)）依次执行：

1. 从电路推导出容器（`DeWebHub.accountOf`），并检查处理器确实是 TapeOut 的处理器（`factory.isCPU`），使伪造的 NFT
   无法冒充服务；
2. 从容器的站点读取 `.well-known/tapeapi.json`，并对照链上数据检查其长度和 SHA-256；
3. 校验清单；
4. 对照**当前**持有者，检查电路持有者对服务签名密钥的 EIP-712 委托。

解析出的服务会被缓存；SDK 大约每小时重读一次，并在签名或价格不再匹配时立即重读。`api.refresh(svc)` 可强制重读。

## 3. 处理错误

每一种失败都是带有稳定 `code` 的 `TapeAPIError`：

```js
import { TapeAPIError } from '@tapeapi/sdk'

try {
  await api.call(svc, 'quote', { symbol: 'BNB' })
} catch (e) {
  if (!(e instanceof TapeAPIError)) throw e
  console.error(e.code, e.message, e.signed ? '(signed by the service)' : '')
}
```

| 错误码 | 含义 | 应对 |
|---|---|---|
| `RPC_UNAVAILABLE` | 作答的 RPC 节点少于法定人数。 | 重试；增加节点。 |
| `RPC_DISAGREE` | 节点返回了不同的字节。 | 重试；若持续出现，说明某个节点落后或在说谎。 |
| `MANIFEST_INVALID` | 没有清单、清单有误，或其字节与链上不符。 | 该服务没有（正确地）发布。 |
| `DELEGATION_INVALID` | 签名密钥未获当前持有者授权，或委托已过期。 | 提供者必须续期。 |
| `BAD_SIGNATURE` | 回答不是由被委托的密钥签名的。 | 不要使用它。SDK 会重读一次清单，以防密钥已轮换。 |
| `METHOD_NOT_FOUND` | 清单中没有该方法。 | 检查 `svc.manifest.methods`。 |
| `PRICE_CHANGED` | 价格涨到了你已接受的价格之上。 | 先征询你的用户，再调用 `api.acceptPrice(svc, method)` 或传入 `{ maxPrice }`。 |
| `QUORUM_FAILED` | `callQuorum` 中的提供者未达成一致。 | 视为没有回答。 |

完整列表见 [TAP-21](../../../spec/TAP-21.md)。服务发出的错误同样带签名（`e.signed`）。

## 4. 要求多个提供者之间达成一致

单个服务的签名回答只能证明是谁说的，不能证明它是真的。对于重要的数值，请向多个独立提供者询问同一个区块，只接受
逐字节相同的结果：

```js
const [a, b] = await Promise.all([api.resolve('0x<container A>'), api.resolve('0x<container B>')])
const first = await api.call(a, 'bnbUsd', {})
const block = first.result.blockPinned.blockNumber            // 把每个提供者都固定到同一个区块
const q = await api.callQuorum([a, b], 'bnbUsd', { block }, { quorum: 2 })
console.log(q.result, 'agreed by', q.agreed)                  // 否则抛出 TapeAPIError('QUORUM_FAILED')
```

只有描述以 `[quorum]` 开头的方法才能这样比较；`[no-quorum]` 方法（带随机 id 的报价、`latest` 读取）按设计就会
各不相同。使用单一来源数值的协议仍应施加边界检查、新鲜度检查和熔断机制。

## 5. 为调用付费

免费方法无需任何东西。付费方法需要一张由消费者签名的凭证（[TAP-22](../../../spec/TAP-22.md)）：

```js
const consumer = '0x<your address>'                             // 签署凭证的钱包账户
const payer = api.payer({
  consumer,
  signTypedData: (typed) => wallet.request({ method: 'eth_signTypedData_v4', params: [consumer, JSON.stringify(typed)] }),
})
const r = await api.call(svc, 'pairPrice', { pair: '0x…' }, { payer })
```

为避免每次调用都弹出钱包提示，可以一次性授权一把会话密钥（`api.tx.authorizeSession(svc, sessionAddress,
expires)`），然后改为传入 `{ consumer, sessionKey, sessionExpiry }`。为通道充值需要两笔交易，由 SDK 为你的钱包构建：
先 `api.tx.approve({ amount })`，再 `api.tx.fund(svc, amount)`。

你只付提供者标明的价格：TapeAPI 不在消费者这一侧加任何费用。维护贡献（如果提供者保留它）从提供者的所得中划出
（[`docs/FEES.md`](../../FEES.md)）。规范目前用 BEM 结算；下一版托管计划支持 BNB Smart Chain 上的 BEM、BNB（包装为
WBNB）、USDT、USDC、ETH 与 USD1。

> 托管合约尚未部署，因此付费服务还没有在主网上线。以上内容都可以针对示例运行（本地使用 `FREE_ALL=1` 跳过付费）。

SDK 只在收到经过验证的回答之后才推进本地计量，并在提供者的计数不一致时自动重新同步。传入 `store: { get, set }`
可在重启之间保留计量。

## 6. 在浏览器或 DeWEB 站点中使用

SDK 是普通的 ES 模块。在 DeWEB 站点上，按相对路径导入它，并用 import map 映射 `@noble/*`；完整页面见
[`examples/demo-site/`](../../../examples/demo-site/)，更多代码片段见
[`examples/consumer-snippets.md`](../../../examples/consumer-snippets.md)。

## 不使用 SDK 进行验证

任何语言都可以检查回答。对于发往容器 `c` 的方法 `m` 的请求 `{ id, params }`，服务使用 EIP-191 `personal_sign`
对以下内容签名：

```
digest = keccak256( "TAPI-1/resp/v2" ‖ c ‖ keccak256(id) ‖ keccak256(canonicalJSON({method: m, params}))
                    ‖ uint8(ok) ‖ keccak256(canonicalJSON(result or error)) ‖ uint64BE(ts) )
```

恢复出签名者（只接受低 s），将其与 `manifest.signer` 比较，检查持有者的委托指明的正是该签名者，并且
`|now - ts| <= 300`。规范 JSON 的定义见 [TAP-21](../../../spec/TAP-21.md)；测试向量和一个独立的 Python 实现位于
[`spec/vectors/`](../../../spec/vectors/)。
