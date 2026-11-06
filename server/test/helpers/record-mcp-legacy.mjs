#!/usr/bin/env node
// Records server/test/fixtures/mcp-legacy-2.4.0.json: the exact answers of a source tree's MCP entry points to the
// legacy cases of mcp-legacy-cases.mjs. Run against the release/2.4.0 tree; nothing is written into that tree.
//   node server/test/helpers/record-mcp-legacy.mjs <tree> [out.json]
// 录制夹具：某个源码树的 MCP 入口对旧版用例的原样回答。对 release/2.4.0 的代码树运行；不向该树写任何东西。
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { buildTargets, runAll, RECORDED_FROM, FROZEN_MS } from './mcp-legacy-cases.mjs'

const tree = resolve(process.argv[2] || fileURLToPath(new URL('../../..', import.meta.url)))
const out = process.argv[3] || fileURLToPath(new URL('../fixtures/mcp-legacy-2.4.0.json', import.meta.url))
const from = (p) => import(pathToFileURL(resolve(tree, p)).href)

const sdk = await from('sdk/src/index.js')
const server = await from('server/src/index.js')
const { createMcpEndpoint } = await from('server/src/mcp.js')
const { createMcpProxy } = await from('server/src/mcp-proxy.js')
const { default: worker } = await from('examples/public-api/worker.js')
const { targets, close } = await buildTargets({ mcp: sdk.mcp, sig: sdk.sig, MAINNET: sdk.MAINNET, TapeAPIError: sdk.TapeAPIError, createProvider: server.createProvider, createMcpEndpoint, createMcpProxy, worker })
const exchanges = await runAll(targets)
await close()
writeFileSync(out, JSON.stringify({ recordedFrom: RECORDED_FROM, sdkVersion: sdk.VERSION ?? null, serverVersion: server.VERSION, frozenMs: FROZEN_MS, exchanges }, null, 1) + '\n')
console.error(`${exchanges.length} exchanges from ${tree} -> ${out}`)
