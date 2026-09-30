// Provider behaviour the traceability pass found missing or off by one.
// Each test names its drift id. / 可追溯性检查发现的缺失或差一的提供者行为；每条注明对应的漂移编号。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProvider } from '../src/index.js'
import { sig, parseUnits, TapeAPIError } from '@tapeapi/sdk'
import { createFakeChain, ADDR } from '../../sdk/test/helpers/fake-chain.mjs'

const { privateKeyToAddress, signDigest, voucherDigest, delegationDigest } = sig
const SIGNER_KEY = '0x' + '22'.repeat(32), CONSUMER_KEY = '0x' + '33'.repeat(32), HOLDER_KEY = '0x' + '11'.repeat(32)
const signer = privateKeyToAddress(SIGNER_KEY), consumer = privateKeyToAddress(CONSUMER_KEY)
const PRICE = parseUnits('0.0001')
const nowS = () => Math.floor(Date.now() / 1000)

function setup(methods, extra = {}) {
  const chain = createFakeChain()
  chain.setChannel(consumer, ADDR.container, parseUnits('1'))
  const expires = nowS() + 300 * 86400
  const manifest = {
    tapeapi: '0.1', name: 'T', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
    delegation: { expires, sig: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires }), HOLDER_KEY) },
    endpoints: { live: ['http://127.0.0.1/tapeapi/v1'], async: false },
    methods: Object.keys(methods).map((name) => ({ name, priceBEM: '0.0001', params: {}, returns: {} })),
    payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 },
  }
  const p = createProvider({
    minVoucherLifeS: 0, manifest, signerKey: SIGNER_KEY, rpcUrls: ['http://rpc1', 'http://rpc2'], quorum: 2, chainId: 56,
    fetch: chain.fetch, escrowCacheMs: 0, allowHttp: true, log: () => {}, rateLimit: false, methods, ...extra,
  })
  return { p, chain }
}
// Signed by the consumer itself (no session key) / 由消费者本人签名（不走会话密钥）
const voucher = (cumulative, expires = nowS() + 3600) => {
  const v = { consumer, provider: ADDR.container, cumulative: cumulative.toString(), expires }
  return { ...v, sig: signDigest(voucherDigest(56, ADDR.escrow, v), CONSUMER_KEY) }
}

test('D5/D6: PAYMENT_REQUIRED carries data.price in base units', async () => {
  const { p } = setup({ m: async () => 1 })
  const out = await p.invoke({ id: 'a', method: 'm', params: {} })
  assert.equal(out.env.error.code, 'PAYMENT_REQUIRED')
  assert.equal(out.env.error.data.price, PRICE.toString())
  assert.match(out.env.error.data.price, /^(0|[1-9]\d*)$/, 'a decimal string of base units: no dot, no leading zeros')
})

test('D13: a voucher is valid while now <= expires, the same inclusive boundary as the escrow', async (t) => {
  // Freeze the clock: the test and the provider must agree on which second "now" is.
  // 冻结时钟：测试与提供者必须对"现在"是哪一秒达成一致。
  const frozen = Date.now()
  t.mock.method(Date, 'now', () => frozen)
  const { p } = setup({ m: async () => 1 })
  const edge = await p.invoke({ id: 'b', method: 'm', params: {}, voucher: voucher(PRICE, nowS()) })
  assert.equal(edge.env.ok, true, JSON.stringify(edge.env.error))
  const past = await p.invoke({ id: 'c', method: 'm', params: {}, voucher: voucher(2n * PRICE, nowS() - 1) })
  assert.equal(past.env.error.code, 'BAD_VOUCHER')
  assert.match(past.env.error.message, /expired/)
  // and pendingSettlements still offers the expires == now voucher / 且 expires == now 的凭证仍在待结算里
  const pending = await p.pendingSettlements()
  assert.equal(pending.length, 1)
})

test('D10: a handler that outruns handlerTimeoutMs is a signed INTERNAL, and the caller is not billed', async () => {
  const { p } = setup({ slow: () => new Promise((r) => setTimeout(() => r(1), 2000)) }, { handlerTimeoutMs: 50 })
  const t0 = Date.now()
  const out = await p.invoke({ id: 'd', method: 'slow', params: {}, voucher: voucher(PRICE) })
  assert.ok(Date.now() - t0 < 1500)
  assert.equal(out.env.error.code, 'INTERNAL')
  assert.equal(await p.store.get(consumer, ADDR.container), null, 'nothing billed')
})

test('D10: a result over 1 MiB is a signed INTERNAL, and the caller is not billed', async () => {
  const { p } = setup({ big: async () => ({ blob: 'x'.repeat(1024 * 1024) }), small: async () => ({ ok: 1 }) })
  const out = await p.invoke({ id: 'e', method: 'big', params: {}, voucher: voucher(PRICE) })
  assert.equal(out.env.error.code, 'INTERNAL')
  assert.equal(await p.store.get(consumer, ADDR.container), null, 'nothing billed')
  // multi-byte characters count as bytes, not UTF-16 units / 多字节字符按字节计
  const { p: p2 } = setup({ wide: async () => ({ blob: '中'.repeat(400 * 1024) }) })   // 400 Ki chars = 1.2 MiB
  assert.equal((await p2.invoke({ id: 'f', method: 'wide', params: {}, voucher: voucher(PRICE) })).env.error.code, 'INTERNAL')
})

test('D4: an INTERNAL may carry revert bytes (chain state, TAP-23 §3.3) and nothing else', async () => {
  const { p } = setup({
    reverts: async () => { throw new TapeAPIError('INTERNAL', 'upstream https://rpc.example/KEY said revert', { data: { revert: '0x08C379A0' } }) },
    leaky: async () => { throw new TapeAPIError('INTERNAL', 'https://rpc.example/KEY', { data: { revert: 'not hex', url: 'https://rpc.example/KEY' } }) },
  })
  const r = await p.invoke({ id: 'g', method: 'reverts', params: {}, voucher: voucher(PRICE) })
  assert.deepEqual(r.env.error, { code: 'INTERNAL', message: 'execution reverted', data: { revert: '0x08c379a0' } })
  const l = await p.invoke({ id: 'h', method: 'leaky', params: {}, voucher: voucher(PRICE) })
  assert.deepEqual(l.env.error, { code: 'INTERNAL', message: 'internal error' })
})

test('D14: a body method that disagrees with the path is BAD_REQUEST; an omitted one is filled from the path', async () => {
  const { p } = setup({ m: async () => 1, other: async () => 2 })
  const srv = await p.listen(0)
  const base = `http://127.0.0.1:${srv.address().port}/tapeapi/v1`
  const post = (path, body) => fetch(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
  try {
    const wrong = await post('m', { id: 'x', method: 'other', params: {} })
    assert.equal(wrong.error.code, 'BAD_REQUEST')
    assert.match(wrong.error.message, /does not match the path/)
    const omitted = await post('m', { id: 'y', params: {} })
    assert.equal(omitted.error.code, 'PAYMENT_REQUIRED', 'reached the method: no method field is fine')
    const req = new Request(`${base}/m`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'z', method: 'other', params: {} }) })
    assert.equal((await (await p.handleRequest(req, { clientIp: '1.1.1.1' })).json()).error.code, 'BAD_REQUEST', 'the fetch entry agrees')
  } finally { await p.close() }
})

test('D11: settlement deadline is min(expires, sessionExpiry); dueSettlements names what must be settled now', async () => {
  const SESSION_KEY = '0x' + '44'.repeat(32), session = privateKeyToAddress(SESSION_KEY)
  const CONSUMER2_KEY = '0x' + '55'.repeat(32), consumer2 = privateKeyToAddress(CONSUMER2_KEY)
  const { p, chain } = setup({ m: async () => 1 }, { sessionCacheMs: 0 })
  const t = nowS()
  chain.setSession(consumer, ADDR.container, session, t + 1200)              // session lapses long before the voucher
  const v1 = { consumer, provider: ADDR.container, cumulative: PRICE.toString(), expires: t + 86400 }
  const r1 = await p.invoke({ id: 's1', method: 'm', params: {}, voucher: { ...v1, sig: signDigest(voucherDigest(56, ADDR.escrow, v1), SESSION_KEY) } })
  assert.equal(r1.env.ok, true, JSON.stringify(r1.env.error))
  chain.setChannel(consumer2, ADDR.container, parseUnits('1'))
  const v2 = { consumer: consumer2, provider: ADDR.container, cumulative: PRICE.toString(), expires: t + 86400 }
  const r2 = await p.invoke({ id: 's2', method: 'm', params: {}, voucher: { ...v2, sig: signDigest(voucherDigest(56, ADDR.escrow, v2), CONSUMER2_KEY) } })
  assert.equal(r2.env.ok, true, JSON.stringify(r2.env.error))

  const pending = await p.pendingSettlements()
  assert.equal(pending[0].consumer.toLowerCase(), consumer.toLowerCase(), 'soonest deadline first')
  assert.equal(pending[0].deadline, t + 1200, 'the session, not the voucher, sets the deadline')
  assert.equal(pending[1].deadline, t + 86400)

  // margin 1800 s: only the session-bound voucher is due / 余量 1800 秒：只有受会话约束的那张到期
  let due = await p.dueSettlements({ marginS: 1800 })
  assert.deepEqual(due.map((d) => [d.consumer.toLowerCase(), d.reason]), [[consumer.toLowerCase(), 'deadline']])
  // consumer2 requests a withdraw: its voucher is due at once, whatever the deadline / 请求提现：立即到期
  chain.setPendingWithdraw(consumer2, ADDR.container, parseUnits('1'), t)
  due = await p.dueSettlements({ marginS: 1800 })
  assert.deepEqual(due.map((d) => d.reason).sort(), ['deadline', 'withdraw-requested'])
  // once the escrow has paid it, it is no longer due / 链上已结算的不再到期
  chain.setClaimed(consumer, ADDR.container, PRICE)
  due = await p.dueSettlements({ marginS: 1800 })
  assert.deepEqual(due.map((d) => d.reason), ['withdraw-requested'])
  assert.equal(p.settleTx(due[0]).to, ADDR.escrow)
})

test('D16: when an in-flight reservation is the highest figure, the stale answer proves it with that voucher', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const { p } = setup({ m: async () => { await gate; return 1 } })
  const a = voucher(PRICE)
  const inflight = p.invoke({ id: 'a', method: 'm', params: {}, voucher: a })     // held, not billed yet / 在途
  await new Promise((r) => setTimeout(r, 20))
  // a second payer instance that does not know about the in-flight call signs the same figure
  // 不知道在途调用的第二个付款实例签了同一个数字
  const b = await p.invoke({ id: 'b', method: 'm', params: {}, voucher: voucher(PRICE) })
  assert.equal(b.env.error.code, 'BAD_VOUCHER')
  assert.equal(b.env.error.data.lastCumulative, PRICE.toString())
  assert.equal(b.env.error.data.onChainClaimed, '0')
  assert.deepEqual(b.env.error.data.voucher, { cumulative: a.cumulative, expires: a.expires, sig: a.sig }, 'the in-flight voucher is the proof')
  release()
  assert.equal((await inflight).env.ok, true)
})
