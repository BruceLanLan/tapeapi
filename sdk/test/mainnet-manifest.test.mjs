// TAPI-20 §6.1 mainnet vector: the live manifest of 11.1013.tape (api.tapeapi.fun), recorded read-only at one block by
// scripts/record-mainnet-manifest.mjs (sdk/test/fixtures/mainnet-11-1013-manifest.json). The recorded answers are
// replayed through the SDK's real resolve path with no network, with the clock set to that block's timestamp: the
// fixture pins the state at that block, and the delegation it carries expires in December. spec/vectors/verify.py checks
// the same fixture independently, and the TAPI-20 §6.1 table must quote its values.
// TAPI-20 §6.1 主网向量：11.1013.tape 的线上清单，在一个区块上只读录制。录下的回答无网络地回放给 SDK 真正的解析路径，
// 时钟设为该区块的时间戳：fixture 钉的是那个区块上的状态，其中的委托 12 月到期。verify.py 独立核对同一个 fixture，
// TAPI-20 §6.1 的表格必须引用它的数值。
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createTapeAPI, abi, sig } from '../src/index.js'

const fx = JSON.parse(readFileSync(new URL('./fixtures/mainnet-11-1013-manifest.json', import.meta.url), 'utf8'))
const spec = readFileSync(new URL('../../spec/TAPI-20.md', import.meta.url), 'utf8')
const byCall = new Map(Object.values(fx.calls).map((c) => [`${c.to.toLowerCase()}:${c.data.toLowerCase()}`, c]))
const served = new Set()
const replayFetch = async (url, init) => {
  const req = JSON.parse(init.body)
  const c = req.method === 'eth_call' ? byCall.get(`${String(req.params[0].to).toLowerCase()}:${req.params[0].data.toLowerCase()}`) : null
  if (c) served.add(c.data)
  const body = c ? { jsonrpc: '2.0', id: req.id, result: c.result } : { jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted (not in fixture)' } }
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}
// Only Date is mocked: the RPC layer's timeouts keep real timers. / 只模拟 Date：RPC 层的超时仍用真实计时器。
const at = async (unixS, fn) => {
  mock.timers.enable({ apis: ['Date'], now: unixS * 1000 })
  try { return await fn() } finally { mock.timers.reset() }
}
const api = () => createTapeAPI({ rpcUrls: ['https://a.invalid', 'https://b.invalid'], quorum: 2, fetch: replayFetch })

test('TAPI-20 §6.1: the fixture was read under the operator quorum at one pinned block', () => {
  assert.equal(fx.chainId, 56)
  assert.equal(fx.rpc.quorum, 2)
  assert.ok(fx.rpc.operators.length >= 2)
  assert.match(fx.rpc.blockParam, /EIP-1898/)
  assert.match(fx.block.hash, /^0x[0-9a-f]{64}$/)
  assert.ok(Number.isInteger(fx.block.number) && fx.block.number > 0)
  assert.match(fx.note, /renew/)
  for (const [name, c] of Object.entries(fx.calls)) assert.ok(c.operators.length >= fx.rpc.quorum, `${name}: answered by ${c.operators}`)
})

test('TAPI-20 §6.1: resolve("11.1013.tape") replays offline to the recorded service, delegation verified against the holder', async () => {
  served.clear()
  const svc = await at(fx.block.timestamp, () => api().resolve(fx.name))
  assert.equal(svc.container, fx.container)
  assert.equal(svc.manifest.circuits.toLowerCase(), fx.circuits.toLowerCase())
  assert.equal(svc.manifest.tokenId, fx.tokenId)
  assert.equal(svc.verified.delegation, true)
  assert.equal(svc.verified.holder, fx.holder)
  assert.equal(svc.manifest.signer, fx.manifest.signer)
  assert.deepEqual(svc.manifest.delegation, fx.manifest.delegation)
  assert.equal(svc.file.size, fx.manifest.size)
  assert.equal(svc.file.sha256Hash, fx.manifest.sha256Hash.toLowerCase())
  // Every recorded call was needed, and nothing outside the fixture was asked. / 每个录下的调用都用到了，没有问过 fixture 之外的东西。
  assert.equal(served.size, byCall.size)
})

test('TAPI-20 §6.1: the manifest bytes hash to fileInfo.sha256Hash, and the circuit is processor 1013 on the factory', () => {
  const call = (fn) => Object.values(fx.calls).find((c) => c.data.startsWith(abi.selector(fn)))
  const bytes = Buffer.from(abi.decodeReturn('read', call('read').result).slice(2), 'hex')
  const info = abi.decodeReturn('fileInfo', call('fileInfo').result)
  assert.equal(BigInt(bytes.length), info.size)
  assert.equal(Number(info.size), fx.manifest.size)
  assert.equal(info.contentType, fx.manifest.contentType)
  assert.equal(info.sha256Hash.toLowerCase(), fx.manifest.sha256Hash.toLowerCase())
  assert.equal('0x' + createHash('sha256').update(bytes).digest('hex'), fx.manifest.bytesSha256)
  assert.equal(abi.decodeReturn('cpuAt', call('cpuAt').result).toLowerCase(), fx.circuits.toLowerCase())
  assert.equal(abi.decodeReturn('isCPU', call('isCPU').result), true)
  const m = JSON.parse(bytes.toString('utf8'))
  assert.equal(m.container.toLowerCase(), fx.container.toLowerCase())
})

test('TAPI-20 §6.1: the delegation digest recovers to ownerOf at that block (§3.4, done here without resolve)', () => {
  const d = { container: fx.container, signer: fx.manifest.signer, expires: fx.manifest.delegation.expires }
  const digest = sig.delegationDigest(56, '0xe61A9C7213a6Aa616C246a2B569e555B417b25ee', d)
  assert.equal(sig.recoverAddress(digest, fx.manifest.delegation.sig), fx.holder)
  const owner = abi.decodeReturn('ownerOf', Object.values(fx.calls).find((c) => c.data.startsWith(abi.selector('ownerOf'))).result)
  assert.equal(owner.toLowerCase(), fx.holder.toLowerCase())
})

test('TAPI-20 §6.1: the pin is a block, not a date: past delegation.expires the same bytes are DELEGATION_INVALID', async () => {
  await assert.rejects(at(fx.manifest.delegation.expires + 1, () => api().resolve(fx.name)), (e) => e.code === 'DELEGATION_INVALID')
})

test('TAPI-20 §6.1: both halves of the spec table quote the fixture', () => {
  const i = spec.indexOf('\n---\n\n# TAPI-20')
  const halves = [spec.slice(spec.indexOf('### 6.1'), spec.indexOf('### 6.2')), spec.slice(spec.indexOf('### 6.1', i), spec.indexOf('### 6.2', i))]
  for (const t of halves) {
    for (const want of [fx.circuits, fx.container, fx.holder, fx.manifest.signer, fx.manifest.sha256Hash, fx.block.hash, String(fx.manifest.delegation.expires)]) {
      assert.ok(t.toLowerCase().includes(want.toLowerCase()), `§6.1 does not quote ${want}`)
    }
    assert.ok(t.includes(fx.block.number.toLocaleString('en-US')) || t.includes(String(fx.block.number)), `§6.1 does not quote block ${fx.block.number}`)
    assert.ok(t.includes(String(fx.manifest.size)), `§6.1 does not quote size ${fx.manifest.size}`)
    assert.ok(!/TODO/.test(t), '§6.1 still has a TODO')
  }
})
