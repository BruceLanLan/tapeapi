#!/usr/bin/env node
// Web2 适配器：把 adapter.config.json 里描述的 REST 端点变成 TapeAPI 方法（签名、计费由 @tapeapi/server 完成）。
// Web2 adapter: turns the REST endpoints described in adapter.config.json into TapeAPI methods
// (signing and metering are handled by @tapeapi/server; adapter.mjs maps params -> HTTP -> result).
import { readFile } from 'node:fs/promises'
import { createProvider } from '@tapeapi/server'
import { sig } from '@tapeapi/sdk'
import { buildMethods, manifestMethods } from './adapter.mjs'
import { exampleEnv, applyEnvToManifest, startProvider } from '../_lib/service.mjs'

const here = new URL('.', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('manifest.json', here), 'utf8'))
const config = JSON.parse(await readFile(new URL(process.env.ADAPTER_CONFIG || 'adapter.config.json', here), 'utf8'))

// ---- env ----
const env = exampleEnv('adapter', { port: 8788 })
const { RPC_URLS, QUORUM, CHAIN_ID, SIGNER_KEY, log, store } = env
// 方法表先从配置生成，再做占位符替换 —— 顺序反过来的话 applyEnvToManifest 的 FREE_ALL 会作用在
// 清单里那份即将被覆盖的方法表上。/ Generate the method table from the config first: the other way round,
// applyEnvToManifest's FREE_ALL pass would act on the method table that is about to be replaced.
manifest.methods = manifestMethods(config)
applyEnvToManifest(manifest, env)

// Only the upstream key is handed to the adapter: a ${NAME} in the config can expand to nothing else (H-HOSTED-1).
// 只把上游密钥交给适配器：配置里的 ${NAME} 不可能展开成别的任何东西（H-HOSTED-1）。
const methods = buildMethods(config, { log, env: { UPSTREAM_API_KEY: process.env.UPSTREAM_API_KEY } })

const provider = createProvider({
  manifest, signerKey: SIGNER_KEY, dev: manifest.dev === true, rpcUrls: RPC_URLS, quorum: QUORUM, chainId: CHAIN_ID,
  allowSingleNode: manifest.dev, // dev 允许单节点；生产 urls 少于 quorum 直接拒绝启动 / single node only in dev (review M-11)
  log, store, methods,
})

await startProvider(provider, env, {
  lines: manifest.methods.map(m =>
    `method   ${m.name.padEnd(12)} ${m.priceBEM} BEM  <- ${config.methods[m.name].method || 'GET'} ${config.methods[m.name].url}`),
})
