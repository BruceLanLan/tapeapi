[English](../agents.md) | 中文

# AI 智能体

`exposeTapeAPI` 通过 WebMCP 的 `document.modelContext`，把任何 TapeAPI 服务变成浏览器中的 AI 智能体可以调用的工具。
智能体永远不会收到页面单方面声称的内容：每次调用都经过 SDK，因此每个回答都是一个信封，并已对照电路持有者在链上授权的
密钥完成验证。被篡改或未签名的回答到达智能体时是一个错误。

```js
import { createTapeAPI } from '@tapeapi/sdk'
import { exposeTapeAPI } from '@tapeapi/sdk/webmcp'

const api = createTapeAPI({
  rpcUrls: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io'],
  quorum: 2,
})
const handle = await exposeTapeAPI(api, '0x<container>')     // 默认只暴露免费方法
// handle.tools, handle.skipped, handle.refresh(), handle.dispose()
```

## 费用

除非页面传入预算，否则付费方法不会被暴露：

```js
await exposeTapeAPI(api, '0x<container>', {
  paid: { payer, maxPriceBEM: '0.001', budgetBEM: '0.05', confirm: async ({ method, priceBEM }) => window.confirm(`Pay ${priceBEM} BEM for ${method}?`) },
})
```

- `maxPriceBEM` 限制单次调用的金额，`budgetBEM` 限制总额，`confirm` 可以在每次付费调用前征询用户本人。
- 涨价永远不会被支付：调用以 `PRICE_CHANGED` 失败，该工具会被撤下，直到用户本人调用 `api.acceptPrice(svc, method)`
  和 `handle.refresh()`。

## 桌面智能体

`manifestToTools(manifest, opts)` 是不依赖 DOM 的纯函数部分：Node MCP 服务器可以用它向桌面智能体提供同样的工具。

## 试一试

```bash
node examples/reader-service/index.mjs
```

然后为本仓库启动一个静态服务，在浏览器中打开 [`examples/webmcp/`](../../../examples/webmcp/)；其 README 对演示有说明。
