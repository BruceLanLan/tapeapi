# AI agents

`exposeTapeAPI` turns any TapeAPI service into tools an AI agent in the browser can call, through WebMCP's
`document.modelContext`. The agent never receives what a page merely claims: every call goes through the SDK, so each
answer is an envelope verified against the key the circuit's holder authorised on chain. A tampered or unsigned answer
reaches the agent as an error.

```js
import { createTapeAPI } from '@tapeapi/sdk'
import { exposeTapeAPI } from '@tapeapi/sdk/webmcp'

const api = createTapeAPI({
  rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-dataseed1.ninicoin.io'],
  quorum: 2,
})
const handle = await exposeTapeAPI(api, '0x<container>')     // free methods only, by default
// handle.tools, handle.skipped, handle.refresh(), handle.dispose()
```

## Money

Paid methods are not exposed unless the page passes a budget:

```js
await exposeTapeAPI(api, '0x<container>', {
  paid: { payer, maxPriceBEM: '0.001', budgetBEM: '0.05', confirm: async ({ method, priceBEM }) => window.confirm(`Pay ${priceBEM} BEM for ${method}?`) },
})
```

- `maxPriceBEM` caps each call, `budgetBEM` caps the total, and `confirm` can ask the human before each paid call.
- A price rise is never paid: the call fails with `PRICE_CHANGED` and the tool is withdrawn until the human calls
  `api.acceptPrice(svc, method)` and `handle.refresh()`.

## Desktop agents

`manifestToTools(manifest, opts)` is the pure part, with no DOM: a Node MCP server can use it to offer the same tools
to a desktop agent.

## Try it

```bash
node examples/reader-service/index.mjs
```

Then serve the repository and open [`examples/webmcp/`](../../examples/webmcp/) in a browser; its README explains the
demo.
