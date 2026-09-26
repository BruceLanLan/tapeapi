#!/usr/bin/env node
// Write site/console/channelbus.json from the tested ChannelBus build (contracts/out-forge, the default profile that
// `forge test` exercises). The console page deploys exactly these bytes, and contracts/test/ConsoleBytecode.t.sol
// fails if they ever differ from the contract, so the page cannot drift from what was tested.
// 从经过测试的 ChannelBus 构建（contracts/out-forge）生成 site/console/channelbus.json。操作页部署的正是这些字节；
// 若它们与合约不一致，contracts/test/ConsoleBytecode.t.sol 会失败，因此页面不会与测试过的版本脱节。
//
//   cd contracts && forge build && cd .. && node scripts/build-console.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const art = JSON.parse(readFileSync(`${root}contracts/out-forge/ChannelBus.sol/ChannelBus.json`, 'utf8'))
const meta = art.metadata || {}
if (meta.settings?.evmVersion !== 'paris' || !String(meta.compiler?.version).startsWith('0.8.28')) {
  console.error('refusing: the artifact is not the default-profile build (solc 0.8.28, paris); run `forge build` in contracts/')
  process.exit(1)
}
if (art.deployedBytecode.immutableReferences && Object.keys(art.deployedBytecode.immutableReferences).length) {
  console.error('refusing: ChannelBus has immutables, so the runtime code on chain would not equal the artifact')
  process.exit(1)
}
const out = {
  contract: 'ChannelBus',
  source: 'https://github.com/BruceLanLan/tapeapi/blob/main/contracts/src/ChannelBus.sol',
  compiler: meta.compiler.version,
  evmVersion: meta.settings.evmVersion,
  optimizerRuns: meta.settings.optimizer?.runs ?? null,
  chainId: 56,
  creation: art.bytecode.object,
  runtime: art.deployedBytecode.object,
  // cast sig "MAX_WIRE()" / "MAX_BATCH()"; the values TAP-26 §3.7 fixes / TAP-26 §3.7 规定的常量
  checks: [{ call: '0x1d5cb38c', name: 'MAX_WIRE', expect: 16448 }, { call: '0x950bff9f', name: 'MAX_BATCH', expect: 16 }],
}
writeFileSync(`${root}site/console/channelbus.json`, JSON.stringify(out, null, 2) + '\n')
console.log(`wrote site/console/channelbus.json: ${(out.creation.length - 2) / 2} creation bytes, ${(out.runtime.length - 2) / 2} runtime bytes`)
