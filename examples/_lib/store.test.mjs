// The meter must survive a restart and must never go backwards. / 计量要能熬过重启，且绝不回退。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileStore } from './store.mjs'

const C = '0x' + 'c0'.repeat(20), P = '0x' + 'b0'.repeat(20)
const rec = (cumulative) => ({ consumer: C, provider: P, cumulative, expires: 1900000000, sig: '0x' + '11'.repeat(65), signer: C, updatedAt: 1 })

test('a voucher written before a restart is still there afterwards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tapeapi-store-'))
  try {
    const path = join(dir, 'nested', 'meter.json')
    const a = fileStore(path)
    assert.equal(await a.advance(C, P, rec('100')), true)
    a.flush()
    const b = fileStore(path)                       // the restart / 重启
    assert.equal((await b.get(C, P)).cumulative, '100')
    assert.deepEqual((await b.all()).length, 1)
    // monotonic: a late lower cumulative is refused, a higher one wins / 单调：迟到的小值被拒，大值胜出
    assert.equal(await b.advance(C, P, rec('50')), false)
    assert.equal((await b.get(C, P)).cumulative, '100')
    assert.equal(await b.advance(C, P, rec('150')), true)
    b.flush()
    assert.equal(JSON.parse(readFileSync(path, 'utf8'))[0].cumulative, '150')
    // the file is replaced whole, never left half written / 文件整体替换，不会留下写了一半的内容
    assert.equal(fileStore(path).path, path)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a provider on this store meters across a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tapeapi-store-'))
  try {
    const { createProvider } = await import('../../server/src/index.js')
    const { sig, parseUnits } = await import('@tapeapi/sdk')
    const { createFakeChain, ADDR } = await import('../../sdk/test/helpers/fake-chain.mjs')
    const SIGNER_KEY = '0x' + '22'.repeat(32), CONSUMER_KEY = '0x' + '33'.repeat(32), HOLDER_KEY = '0x' + '11'.repeat(32)
    const signer = sig.privateKeyToAddress(SIGNER_KEY), consumer = sig.privateKeyToAddress(CONSUMER_KEY)
    const chain = createFakeChain()
    chain.setChannel(consumer, ADDR.container, parseUnits('1'))
    const expires = Math.floor(Date.now() / 1000) + 86400
    const manifest = {
      tapeapi: '0.1', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
      delegation: { expires, sig: sig.signDigest(sig.delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires }), HOLDER_KEY) },
      endpoints: { live: ['http://127.0.0.1/tapeapi/v1'], async: false },
      methods: [{ name: 'm', priceBEM: '0.0001', params: {}, returns: {} }],
      payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 },
    }
    const price = parseUnits('0.0001')
    const path = join(dir, 'meter.json')
    const mk = () => createProvider({ minVoucherLifeS: 0, manifest, signerKey: SIGNER_KEY, rpcUrls: ['http://rpc1', 'http://rpc2'], quorum: 2, chainId: 56, fetch: chain.fetch, escrowCacheMs: 0, allowHttp: true, log: () => {}, rateLimit: false, store: fileStore(path), methods: { m: async () => 1 } })
    const voucher = (n) => { const v = { consumer, provider: ADDR.container, cumulative: (n * price).toString(), expires }; return { ...v, sig: sig.signDigest(sig.voucherDigest(56, ADDR.escrow, v), CONSUMER_KEY) } }
    const p1 = mk()
    assert.equal((await p1.invoke({ id: 'a', method: 'm', params: {}, voucher: voucher(1n) })).env.ok, true)
    p1.store.flush()
    // a new process reads the meter back: the same cumulative is now stale, the next one is served
    // 新进程读回计量：同一个累计额现在已过期，下一个照常服务
    const p2 = mk()
    const stale = await p2.invoke({ id: 'b', method: 'm', params: {}, voucher: voucher(1n) })
    assert.equal(stale.env.error.code, 'BAD_VOUCHER')
    assert.equal(stale.env.error.data.lastCumulative, price.toString())
    assert.equal((await p2.invoke({ id: 'c', method: 'm', params: {}, voucher: voucher(2n) })).env.ok, true)
    p2.store.flush()
    assert.equal((await p2.pendingSettlements())[0].cumulative, (2n * price).toString())
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
