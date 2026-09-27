# @tapeapi/sdk

JavaScript SDK for [TapeAPI](https://tapeapi.fun): find a service on BNB Smart Chain by name, call it, and get an
answer whose signature is checked against the key the service's holder delegated on chain. Paid methods use
EIP-712 vouchers against an escrow; nothing is signed or sent without you.

> **Pre-alpha.** Interfaces may change before 1.0.0. See the [changelog](https://github.com/BruceLanLan/tapeapi/blob/main/CHANGELOG.md).

## Install

```bash
npm i @tapeapi/sdk
```

Published from https://github.com/BruceLanLan/tapeapi (folder `sdk/`). ES modules only; Node 20+, browsers,
Cloudflare Workers and Deno. TypeScript declarations are included.

## Example

```js
import { createTapeAPI } from '@tapeapi/sdk'

const api = createTapeAPI({
  rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-dataseed1.ninicoin.io'],
  quorum: 2,                                        // every chain read must be agreed by 2 nodes
})
const svc = await api.resolve('11.1013.tape')       // the public service: <#ID>.<processor>.tape
const { result, verified } = await api.call(svc, 'bnbUsd', {})
console.log(result.bnbUsd, verified)                // price of BNB in USDT, signature verified
```

`api.callQuorum([svcA, svcB], method, params)` asks independent providers and accepts only an answer they agree on.

## Subpaths

| Import | What |
| --- | --- |
| `@tapeapi/sdk` | `createTapeAPI`, `createRpc`, `TapeAPIError`, `MAINNET`, `BUS_RPC_URLS`, and the `abi`, `sig`, `channel`, `group`, `tapesend`, `webmcp` namespaces |
| `@tapeapi/sdk/webmcp` | `exposeTapeAPI`, `manifestToTools`: a service's methods as WebMCP tools for in-browser agents |
| `@tapeapi/sdk/channel` | TAP-26 private channels (invites, relay and ChannelBus transports) |
| `@tapeapi/sdk/rpc`, `/abi`, `/sig`, `/canon`, `/manifest` | the building blocks |

## Docs

- [Call a service](https://tapeapi.fun/docs/en/consume.html)
- [Public API](https://tapeapi.fun/docs/en/public-api.html) (`11.1013.tape`, free)
- [Agents and WebMCP](https://tapeapi.fun/docs/en/agents.html)
- [Private channels](https://tapeapi.fun/docs/en/channels.html)
- [All docs](https://tapeapi.fun/docs/) · [Playground](https://tapeapi.fun/playground/) · [Specifications](https://github.com/BruceLanLan/tapeapi/tree/main/spec)

## License

MIT
