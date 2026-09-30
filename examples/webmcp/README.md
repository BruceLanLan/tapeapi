# TapeAPI → WebMCP

Any TapeAPI service becomes a set of tools an AI agent in the browser can call, through WebMCP's
`document.modelContext`. The agent never gets what a page merely claims: each call goes through the SDK, so the
answer is a TAPI-21 envelope verified against the signer the circuit's holder delegated on chain (TAPI-20). A tampered
or unsigned answer reaches the agent as an error, never as a result.

任何 TapeAPI 服务都能变成浏览器里 AI 代理可调用的一组工具（WebMCP 的 `document.modelContext`）。代理拿到的永远不是页面的
一面之词：每次调用都走 SDK，回答是按电路持有人在链上授权的签名者验过签的 TAPI-21 信封。被篡改或未签名的回答对代理是错误，
绝不是结果。

## Use it in a page / 在页面里用

```js
import { createTapeAPI } from '@tapeapi/sdk'
import { exposeTapeAPI } from '@tapeapi/sdk/webmcp'   // sdk/src/webmcp.js

const api = createTapeAPI({ rpcUrls: [/* ≥ 3 BSC nodes */], quorum: 2 })
const handle = await exposeTapeAPI(api, '0x<container>')          // free methods only, by default
// handle.tools, handle.skipped, handle.refresh(), handle.dispose()
```

**Money / 钱.** Priced methods are not exposed unless the page passes
`paid: { payer, maxPriceBEM, budgetBEM, methods?, confirm? }`: a per-call cap, a total budget, and optionally a
`confirm` hook that asks the human before each paid call. A price rise is never paid: the call fails with
`PRICE_CHANGED` and the tool is withdrawn until the human calls `api.acceptPrice(svc, method)` and `handle.refresh()`.
不传 `paid`（单次上限、总预算，可选的逐次确认）就不暴露收费方法；涨价永远不付：调用以 `PRICE_CHANGED` 失败，工具被撤下，
直到人调用 `api.acceptPrice` 并刷新。

`manifestToTools(manifest, opts)` is the pure part (no DOM): a Node MCP server can reuse it to offer the same tools
to a desktop agent. / 纯函数部分，Node 的 MCP 服务器可复用它给桌面代理提供同样的工具。

## Try the demo / 试用演示

From the repository root (after `npm install`):

```bash
node examples/reader-service/index.mjs
```

```bash
python3 -m http.server 8799 --bind 127.0.0.1
```

Open `http://127.0.0.1:8799/examples/webmcp/` and press **Expose tools**. In a browser with WebMCP enabled the tools
are registered on the native `document.modelContext`, where an in-browser agent can list and call them. Without
WebMCP the page registers them on a local stand-in, so you can still read each tool's schema and call it the way an
agent would, but no agent can discover them.
打开页面按 **Expose tools**。启用了 WebMCP 的浏览器会把工具注册到原生 `document.modelContext`，浏览器里的代理能列出并调用；
没有 WebMCP 时注册到本地替身，你仍能查看每个工具的结构并像代理一样调用，但代理发现不了它们。

The reader-service runs in development mode (a local HTTP manifest, no on-chain identity), and the tool descriptions
say so. / 读取服务以开发模式运行（本地 HTTP 清单，没有链上身份），工具说明里会如实标注。

## What was tested / 测过什么

`sdk/test/webmcp.test.mjs` (16 tests) runs a real signed provider and the SDK against a fake chain, through both
WebMCP shapes (the W3C draft's `registerTool(tool, { signal })` and Chrome's preview `registerTool` /
`unregisterTool` with JSON-string input): verified results, a tampered answer refused, priced methods hidden by
default, budget and concurrency limits, price rises refused, manifest refresh. The demo page has been loaded in a
browser without native WebMCP (local stand-in path). No test has run against a browser's native WebMCP
implementation yet.
`sdk/test/webmcp.test.mjs`（16 个测试）用真实签名的提供者与 SDK、在假链上覆盖两种 WebMCP 接口形状。演示页已在没有原生
WebMCP 的浏览器里加载过（本地替身路径）。尚未在浏览器的原生 WebMCP 实现上测试过。
