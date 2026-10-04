#!/usr/bin/env node
// Block Height Agent: an EXPERIMENTAL container-agent runtime (phase 0). It is the example's server entry; the runtime itself is
// agent.mjs. Sets up like examples/reader-service (env, manifest placeholders, start-up banner), then serves task_offer,
// task_mandate, task_deliver and task_status. In dev mode (no DELEGATION_SIG) it serves a dev manifest and an ephemeral signer.
// 区块高度代理：实验性的容器代理运行时（阶段 0）的服务入口，运行时本身在 agent.mjs。外壳与 reader-service 相同。
//
//   node examples/agent-service/index.mjs              (dev: ephemeral signer, :8799)
//   CONTAINER=0x... CIRCUITS=0x... TOKEN_ID=... SIGNER_KEY=... DELEGATION_SIG=... DELEGATION_EXPIRES=... PUBLIC_URL=https://...
//
// The agent reads BNB Smart Chain through RPC_URLS (default: the SDK's nodes of three operators; the mandate checks need nodes of
// at least two operators) and calls ONLY the providers a mandate lists. Orders live in memory: a restart forgets them.
// READ_METHOD names the method it calls on those providers (default blockNumber, as examples/reader-service serves it).
import { readFile } from 'node:fs/promises'
import { createProvider } from '@tapeapi/server'
import { createTapeAPI } from '@tapeapi/sdk'
import { exampleEnv, applyEnvToManifest, startProvider, rpcSummary } from '../_lib/service.mjs'
import { createAgentService } from './agent.mjs'

const manifest = JSON.parse(await readFile(new URL('manifest.json', import.meta.url), 'utf8'))
const env = exampleEnv('agent', { port: 8799 })
const { RPC_URLS, QUORUM, CHAIN_ID, PROD, SIGNER_KEY, log } = env
applyEnvToManifest(manifest, env)

// the agent's own consumer client: it reads the chain for the checks and resolves the providers in scope
// 代理自己的消费者客户端：为核验读链，并解析授权书里列出的服务
const api = createTapeAPI({ rpcUrls: RPC_URLS, quorum: QUORUM, chainId: CHAIN_ID })
const service = createAgentService({ api, container: manifest.container, readMethod: process.env.READ_METHOD || undefined, log })

const provider = createProvider({
  manifest, signerKey: SIGNER_KEY, dev: !PROD, chainId: CHAIN_ID, log,
  methods: service.methods,
})

await startProvider(provider, env, {
  lines: [
    rpcSummary(RPC_URLS, QUORUM),
    'EXPERIMENTAL (1.7): phase 0, enforcement none: a mandate is a signed statement, not a gate',
    ...manifest.methods.map((m) => `method   ${m.name}`),
  ],
})
