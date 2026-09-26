// The deployed ChannelBus, replayed from a read-only mainnet recording (scripts/night.mjs bus <address> --record).
// Every on-chain claim gets a recorded-mainnet test, not only the fake chain. Skipped until the recording exists.
// 已部署的 ChannelBus，回放只读录制的主网数据。链上的每个说法都要有录制主网的测试。录制文件出现之前跳过。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { MAINNET } from '../src/index.js'
import { checksumAddress } from '../src/abi.js'

const file = new URL('./fixtures/mainnet-channelbus.json', import.meta.url)
const fx = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
const cfg = JSON.parse(readFileSync(new URL('../../site/console/channelbus.json', import.meta.url), 'utf8'))

test('mainnet ChannelBus: the recorded code is the tested build, byte for byte', { skip: !fx && 'not deployed yet: no sdk/test/fixtures/mainnet-channelbus.json' }, () => {
  assert.equal(fx.chainId, 56)
  assert.equal(fx.code.toLowerCase(), cfg.runtime.toLowerCase(), 'the console deploys exactly the build contracts/test/ConsoleBytecode.t.sol checks')
  for (const c of cfg.checks) assert.equal(fx.constants[c.name], String(c.expect), c.name)
})

test('mainnet ChannelBus: the SDK names the recorded address, and only that one', { skip: !fx && 'not deployed yet' }, () => {
  assert.equal(MAINNET.channelBus, checksumAddress(fx.address), 'MAINNET.channelBus is the recorded deployment, EIP-55')
})
