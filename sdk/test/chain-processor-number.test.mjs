// api.chain.processorNumber (@experimental, 3.0, for @tapeapi/passport): TAP-10 §4.3 step 3 through the client's
// processor table, at a pinned block. Conform chain only (helpers/conform-chain.mjs), no network.
// api.chain.processorNumber（实验性，3.0，供 @tapeapi/passport 用）：经客户端处理器表查处理器号，钉块读取。只用 conform 假链。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTapeAPI } from '../src/index.js'
import { createConformChain } from './helpers/conform-chain.mjs'

const RPC = ['http://rpc1', 'http://rpc2', 'http://rpc3']
const api = (chain) => createTapeAPI({ conform: 'tap10', rpcUrls: RPC, fetch: chain.fetch, clock: () => 1_790_000_000, quiet: true, onWarning: () => {} })
const cpuAts = (chain) => chain.conform.log.filter((x) => x.fn === 'cpuAt').length

test('processorNumber: the number as a string, at a given pin or a new TAP-10 pin; null when the factory list does not name it', async () => {
  const chain = createConformChain()
  const a = api(chain)
  const pin = await a.rpc.tap10Block({ maxLag: 400 })
  const seventh = chain.conform.processors[7]
  assert.equal(await a.chain.processorNumber(seventh, { at: pin }), '7')
  const before = cpuAts(chain)
  assert.equal(await a.chain.processorNumber(seventh), '7', 'kept: no further cpuAt read')
  assert.equal(cpuAts(chain), before)
  assert.equal(await a.chain.processorNumber(chain.conform.processors[2]), '2')
  assert.equal(await api(chain).chain.processorNumber('0x' + 'e7'.repeat(20), { at: pin }), null)
  await assert.rejects(a.chain.processorNumber('nope'), (e) => e.code === 'INVALID_ARGUMENT')
  await assert.rejects(a.chain.processorNumber(seventh, { at: { number: 1 } }), (e) => e.code === 'INVALID_ARGUMENT')
})

test('processorNumber: a list longer than one resolution may scan is RPC_UNAVAILABLE (never null), and goes on next time', async () => {
  const list = Array.from({ length: 300 }, (_, i) => '0x' + (0x1000 + i).toString(16).padStart(40, '0'))
  const chain = createConformChain({ chainId: 56, processors: list })
  const a = api(chain)
  await assert.rejects(a.chain.processorNumber(list[299]), (e) => e.code === 'RPC_UNAVAILABLE' && e.data?.status === 'unavailable')
  assert.equal(await a.chain.processorNumber(list[299]), '299')
})
