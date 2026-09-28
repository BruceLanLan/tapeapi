# @tapeapi/server

Provider runtime for [TapeAPI](https://tapeapi.fun): serve your methods as a TapeAPI service. It parses requests,
signs every answer (TAP-21), rate-limits, and for paid methods checks and meters EIP-712 vouchers (TAP-22). You write
plain functions. Runs on Node (`listen`) and on any fetch runtime such as Cloudflare Workers (`handleRequest`).

> **Pre-alpha.** Interfaces may change before 1.0.0. See the [changelog](https://github.com/BruceLanLan/tapeapi/blob/main/CHANGELOG.md).

**Stability (1.0).** `createProvider`, the AI sidecar (`@tapeapi/server/ai-proxy`) and the MCP endpoint and proxy
(`@tapeapi/server/mcp`, `@tapeapi/server/mcp-proxy`) are Stable. The payment side (escrow, voucher store, settlement
helpers) is `@experimental`. Upgrading from 0.x: [docs/guides/upgrade-1.0.md](https://github.com/BruceLanLan/tapeapi/blob/main/docs/guides/upgrade-1.0.md).

## Install

Not on npm yet: install both packages from the GitHub release, the SDK first (the server depends on `@tapeapi/sdk`,
which npm would otherwise look for in the registry):

```bash
npm install https://github.com/BruceLanLan/tapeapi/releases/download/v1.0.0-rc.2/tapeapi-sdk-1.0.0-rc.2.tgz
npm install https://github.com/BruceLanLan/tapeapi/releases/download/v1.0.0-rc.2/tapeapi-server-1.0.0-rc.2.tgz
```

Built from https://github.com/BruceLanLan/tapeapi (folder `server/`). ES modules; Node 20+. TypeScript declarations
are included.

## Run a service

```js
import { readFile } from 'node:fs/promises'
import { createProvider } from '@tapeapi/server'

const provider = createProvider({
  manifest: JSON.parse(await readFile('manifest.json', 'utf8')),   // your TAP-20 manifest
  signerKey: process.env.SIGNER_KEY,                               // the key your holder delegated
  dev: true,                                                       // local run (http, no delegation); remove to go live
  rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-mainnet.public.blastapi.io', 'https://rpc-bsc.48.club'],
  quorum: 2,
  methods: { blockNumber: async (_params, ctx) => ({ blockNumber: ctx.block }) },
})
await provider.listen(8787)
// Cloudflare Workers: export default { fetch: (request) => provider.handleRequest(request) }
```

## Call one (with @tapeapi/sdk)

```js
import { createTapeAPI } from '@tapeapi/sdk'

const api = createTapeAPI({
  rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-mainnet.public.blastapi.io', 'https://rpc-bsc.48.club'],
  quorum: 2,
})
const svc = await api.resolve('11.1013.tape')
const { result, verified } = await api.call(svc, 'bnbUsd', {})
console.log(result.bnbUsd, verified)
```

## Docs

- [Run a service](https://tapeapi.fun/docs/en/provide.html)
- [Public API](https://tapeapi.fun/docs/en/public-api.html) (a live service built on this runtime)
- [All docs](https://tapeapi.fun/docs/) · [Examples](https://github.com/BruceLanLan/tapeapi/tree/main/examples) · [Conformance suite](https://github.com/BruceLanLan/tapeapi/tree/main/conformance)

## License

MIT
