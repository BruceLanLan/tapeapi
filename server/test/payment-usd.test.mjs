// @experimental Provider side of the TAP draft "Payment Vouchers" (TAPs#52) for a manifest with `usdPricing`: quotes
// (§4.4), the checks and reasons of §5.2, error.data of §6, the charge record of §7, cross-instance honouring, the
// strict v, and F2–F4 from configuration. Items 7, 8, 9 and 15 of the implementation plan.
// 草稿的提供者侧：报价、§5.2 的检查与 reason、§6 的 error.data、§7 的计费记录、跨实例兑现、严格 v、由配置提供 F2–F4。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProvider, memoryQuoteStore } from '../src/index.js'
import { sig, parseUnits, usdPricing as U, TapeAPIError } from '@tapeapi/sdk'
import { createFakeChain, ADDR } from '../../sdk/test/helpers/fake-chain.mjs'
import { installPool } from '../../sdk/test/helpers/v3-pool.mjs'
import { virtualClock } from '../../sdk/test/helpers/clock.mjs'

const { privateKeyToAddress, signDigest, voucherDigest, recoverResponseSigner } = sig
const T0 = 1_789_000_000
const SIGNER_KEY = '0x' + '22'.repeat(32), CONSUMER_KEY = '0x' + '33'.repeat(32), SESSION_KEY = '0x' + '44'.repeat(32), STRANGER_KEY = '0x' + '55'.repeat(32)
const signer = privateKeyToAddress(SIGNER_KEY), consumer = privateKeyToAddress(CONSUMER_KEY), sessionAddr = privateKeyToAddress(SESSION_KEY)
const RPC = ['http://rpc1', 'http://rpc2', 'http://rpc3']
const USDT = U.DEFAULT_USD_TOKENS[0]
const POOL = '0x' + 'a1'.repeat(20)

const manifestWith = (usdPricing) => ({
  tapeapi: '0.1', name: 'USD', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
  endpoints: { live: ['http://127.0.0.1:1/tapeapi/v1'], async: false },
  methods: [
    { name: 'free', priceBEM: '0', params: {}, returns: {} },
    { name: 'search', priceBEM: '100', params: {}, returns: {} },
    { name: 'bem', priceBEM: '0.0001', params: {}, returns: {} },
    { name: 'str', priceBEM: '100', params: {}, returns: {} },
    { name: 'own', priceBEM: '100', params: {}, returns: {} },
  ],
  payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 },
  ...(usdPricing === undefined ? {} : { usdPricing }),
})
const USDP = { methods: { search: '0.01', str: '0.01', own: '0.01' }, toleranceBps: 200, maxQuoteS: 120, rateSources: [{ type: 'v3-twap', pool: POOL, usd: USDT, window: 1800 }] }
const handlers = {
  free: async () => ({ ok: 1 }),
  search: async (_p, ctx) => ({ hits: [], seen: ctx.charge.toString() }),
  bem: async () => ({ hits: [] }),
  str: async () => 'plain',
  own: async () => ({ charge: 'mine' }),
}
function setup({ usdRate, minVoucherLifeS = 0, quoteStore, settlementFacts, extra = {} } = {}) {
  const chain = createFakeChain()
  chain.setChannel(consumer, ADDR.container, parseUnits('1000'))
  chain.setSession(consumer, ADDR.container, sessionAddr, 1900000000)
  const pool = installPool(chain, { pool: POOL, usd: USDT, rate: 0.0004 })
  chain.state.headTime = T0
  const p = createProvider({ manifest: manifestWith(USDP), signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: chain.fetch, escrowCacheMs: 0, allowHttp: true, minVoucherLifeS, allowMemoryStore: true, methods: handlers, usdRate, quoteStore, settlementFacts, ...extra })
  return { chain, pool, p }
}
const voucher = (cumulative, { key = SESSION_KEY, expires = T0 + 3600, rate, provider = ADDR.container } = {}) => {
  const v = { consumer, provider, cumulative: String(cumulative), expires }
  return { ...v, sig: signDigest(voucherDigest(56, ADDR.escrow, v), key), signer: privateKeyToAddress(key), ...(rate === undefined ? {} : { rate }) }
}
const verifies = (env, method) => recoverResponseSigner({ container: env.container, id: env.id, method, params: {}, ok: env.ok, body: env.ok ? env.result : env.error, ts: env.ts }, env.sig) === signer
let n = 0
const call = async (p, method, v) => { const r = await p.invoke({ id: `u${++n}`, method, params: {}, ...(v === undefined ? {} : { voucher: v }) }, { ip: '10.0.0.1' }); assert.ok(verifies(r.env, method), 'every answer is signed'); return r }
const fixedRate = (rate, asOf = T0 - 10) => async () => ({ rate, asOf })

test('boot: an invalid usdPricing refuses to start; a USD method needs a rate source; quoteValidS is bounded by maxQuoteS', () => {
  const clock = virtualClock({ start: T0 * 1000 })
  try {
    const base = { signerKey: SIGNER_KEY, allowHttp: true, allowMemoryStore: true, methods: handlers }
    assert.throws(() => createProvider({ ...base, manifest: manifestWith({ ...USDP, toleranceBps: 0 }), usdRate: fixedRate('1') }), (e) => e.code === 'MANIFEST_INVALID' && /toleranceBps/.test(e.message))
    assert.throws(() => createProvider({ ...base, manifest: manifestWith({ ...USDP, methods: { free: '1' } }), usdRate: fixedRate('1') }), (e) => e.code === 'MANIFEST_INVALID')
    assert.throws(() => createProvider({ ...base, manifest: manifestWith(USDP) }), (e) => e.code === 'INVALID_ARGUMENT' && /rpcUrls|usdRate/.test(e.message))
    assert.throws(() => createProvider({ ...base, manifest: manifestWith(USDP), usdRate: fixedRate('1'), quoteValidS: 121 }), (e) => e.code === 'INVALID_ARGUMENT' && /quoteValidS/.test(e.message))
    assert.throws(() => createProvider({ ...base, manifest: manifestWith(USDP), usdRate: fixedRate('1'), settlementFacts: { amountPaid() {} } }), (e) => e.code === 'INVALID_ARGUMENT' && /settlementFacts/.test(e.message))
    // the warning about a per-process quote store / 关于进程内报价表的警告
    const warned = []
    createProvider({ ...base, allowMemoryStore: false, store: { get: async () => null, set: async () => {}, all: async () => [], advance: async () => true }, manifest: manifestWith(USDP), usdRate: fixedRate('1'), warn: (m) => warned.push(m) })
    assert.ok(warned.some((m) => /quote store/.test(m)))
  } finally { clock.restore() }
})

test('PAYMENT_REQUIRED (§6): a USD-priced method carries price at the quote, priceUSD, the quote and minVoucherLifeS; a BEM-priced one price and minVoucherLifeS', async () => {
  const clock = virtualClock({ start: T0 * 1000 })
  try {
    const { p } = setup({ usdRate: fixedRate('0.0004'), minVoucherLifeS: 300 })
    const r = await call(p, 'search')
    assert.equal(r.status, 402); assert.equal(r.env.error.code, 'PAYMENT_REQUIRED')
    const d = r.env.error.data
    assert.deepEqual(Object.keys(d), ['price', 'priceUSD', 'quote', 'minVoucherLifeS'])
    assert.equal(d.price, '2500000000'); assert.deepEqual(d.priceUSD, { currency: 'USD', amount: '0.01000000' }); assert.equal(d.minVoucherLifeS, 300)
    assert.deepEqual(U.validateQuote(d.quote, { maxQuoteS: 120, ts: r.env.ts }), { rate: '0.0004', asOf: T0 - 10, validUntil: T0 + 110 })
    const b = await call(p, 'bem')
    assert.deepEqual(b.env.error.data, { price: '10000', minVoucherLifeS: 300 })
    // without a minimum, no minVoucherLifeS / 没有下限就不写
    const { p: p0 } = setup({ usdRate: fixedRate('0.0004') })
    assert.deepEqual(Object.keys((await call(p0, 'search')).env.error.data), ['price', 'priceUSD', 'quote'])
  } finally { clock.restore() }
})

test('a paid USD call at a quoted rate: the charge record (§7) is signed in the result; the client check of §8.3 passes; the next voucher builds on cumulative', async () => {
  const clock = virtualClock({ start: T0 * 1000 })
  try {
    const { p } = setup({ usdRate: fixedRate('0.0004') })
    await call(p, 'search')   // states the quote / 说出报价
    const v1 = voucher(2500000000n, { rate: '0.0004' })
    const r = await call(p, 'search', v1)
    assert.equal(r.status, 200, JSON.stringify(r.env.error))
    const ch = r.env.result.charge
    assert.deepEqual(ch, { consumer, cumulative: '2500000000', amount: { currency: 'BEM', amount: '25.00000000' }, price: { currency: 'USD', amount: '0.01000000' }, rate: '0.0004', rateAsOf: T0 - 10, quote: { rate: '0.0004', asOf: T0 - 10, validUntil: T0 + 110 } })
    assert.equal(r.env.result.seen, '2500000000', 'ctx.charge is the charge of this call')
    assert.deepEqual(U.checkChargeRecord(ch, { voucher: v1, last: 0n, usd: { priceUSD: '0.01', priceBEM: '100' } }), { ok: true })
    // a client that signs for more pays the difference, and the record says so (§5.3) / 多签的部分照收，记录如实写
    const r2 = await call(p, 'search', voucher(2500000000n + 2600000000n, { rate: '0.0004' }))
    assert.equal(r2.env.result.charge.amount.amount, '26.00000000')
    // a BEM-priced method of the same service: a record without the USD members / 同一服务的 BEM 计价方法：没有 USD 成员的记录
    const r3 = await call(p, 'bem', voucher(5100000000n + 10000n))
    assert.deepEqual(r3.env.result.charge, { consumer, cumulative: '5100010000', amount: { currency: 'BEM', amount: '0.00010000' } })
    assert.deepEqual((await p.store.all())[0].cumulative, '5100010000')
  } finally { clock.restore() }
})

test('§5.2 reasons, in order, each with the hints of §6; the stale ones carry the proof', async () => {
  const clock = virtualClock({ start: T0 * 1000 })
  try {
    const { p, chain } = setup({ usdRate: fixedRate('0.0004') })
    const S = setup({ usdRate: fixedRate('0.0004'), minVoucherLifeS: 600 }), strict = S.p
    await call(p, 'search'); await call(strict, 'search')
    const reason = async (prov, v, method = 'search') => { const r = await call(prov, method, v); assert.equal(r.env.error?.code, 'BAD_VOUCHER', JSON.stringify(r.env)); const d = r.env.error.data; assert.equal(d.price, method === 'search' ? '2500000000' : '10000'); if (method === 'search') { assert.ok(d.quote); assert.ok(d.priceUSD) } return d }
    assert.equal((await reason(p, 'nope')).reason, 'malformed')
    assert.equal((await reason(p, { ...voucher(2500000000n, { rate: '0.0004' }), cumulative: '02500000000' })).reason, 'malformed', 'a leading zero is malformed here (1.8.1 accepted it)')
    assert.equal((await reason(p, { ...voucher(2500000000n, { rate: '0.0004' }), expires: '1' })).reason, 'malformed')
    assert.equal((await reason(p, voucher(2500000000n, { rate: '0.0004', provider: '0x' + '61'.repeat(20) }))).reason, 'provider')
    assert.equal((await reason(p, voucher(2500000000n, { rate: '0.0004', expires: T0 - 1 }))).reason, 'expired')
    const life = await reason(strict, voucher(2500000000n, { rate: '0.0004', expires: T0 + 60 }))
    assert.equal(life.reason, 'lifetime'); assert.equal(life.minVoucherLifeS, 600)
    S.chain.setSession(consumer, ADDR.container, privateKeyToAddress(STRANGER_KEY), T0 + 100)
    const life2 = await reason(strict, voucher(2500000000n, { rate: '0.0004', key: STRANGER_KEY }))
    assert.equal(life2.reason, 'lifetime', "the signer key's authorisation lapses too soon")
    assert.equal((await reason(p, voucher(2500000000n, { rate: '0.0004', key: '0x' + '77'.repeat(32) }))).reason, 'signature')
    // item 15: v written as 0/1 is refused in a voucher / v 写成 0/1 的凭证被拒
    const good = voucher(2500000000n, { rate: '0.0004' })
    const v01 = { ...good, sig: good.sig.slice(0, 130) + (parseInt(good.sig.slice(130), 16) - 27).toString(16).padStart(2, '0') }
    const sv = await reason(p, v01); assert.equal(sv.reason, 'signature')
    assert.equal((await reason(p, voucher(2500000000n))).reason, 'rate', 'no rate')
    assert.equal((await reason(p, voucher(2500000000n, { rate: '0.00035' }))).reason, 'rate', 'a rate never quoted')
    assert.equal((await reason(p, voucher(2500000000n, { rate: '0.00040' }))).reason, 'rate', 'rates compare as strings')
    assert.equal((await reason(p, voucher(2499999999n, { rate: '0.0004' }))).reason, 'insufficient')
    assert.equal((await reason(p, voucher(parseUnits('2000'), { rate: '0.0004' }))).reason, 'funds')
    assert.equal((await call(p, 'search', good)).status, 200)
    const st = await reason(p, good)
    assert.equal(st.reason, 'stale'); assert.equal(st.lastCumulative, '2500000000'); assert.equal(st.onChainClaimed, '0')
    assert.deepEqual(st.voucher, { cumulative: good.cumulative, expires: good.expires, sig: good.sig })
    const ins = await reason(p, voucher(2500000001n, { rate: '0.0004' }))
    assert.equal(ins.reason, 'insufficient'); assert.equal(ins.lastCumulative, '2500000000')
    // the amount paid on chain (F2) makes everything at or below it stale, even after a restart / 链上已付的部分一律 stale
    chain.state.claimed.set(`${consumer.toLowerCase()}:${ADDR.container.toLowerCase()}`, 9000000000n)
    const st2 = await reason(p, voucher(8000000000n, { rate: '0.0004' }))
    assert.equal(st2.reason, 'stale'); assert.equal(st2.onChainClaimed, '9000000000')
    // every refusal names one of the nine reasons / 每个拒绝都给出九个值之一
    for (const r of ['malformed', 'provider', 'expired', 'lifetime', 'signature', 'rate', 'stale', 'insufficient', 'funds']) assert.ok(U.BAD_VOUCHER_REASONS.includes(r))
  } finally { clock.restore() }
})

test('§4.4 quotes: honoured until validUntil, refused after; a superseded quote is still honoured; capped is recorded', async () => {
  const clock = virtualClock({ start: T0 * 1000 })
  try {
    let rate = '0.0004', asOf = T0 - 10
    const { p } = setup({ usdRate: async () => ({ rate, asOf }) })
    await call(p, 'search')
    clock.advance(70_000)                                     // past half the life: the next answer states a new quote
    rate = '0.0005'; asOf = T0 + 60
    const pr = await call(p, 'search')
    assert.equal(pr.env.error.data.quote.rate, '0.0005')
    // the old quote (validUntil T0 + 110) is still honoured / 旧报价仍兑现
    const r1 = await call(p, 'search', voucher(2500000000n, { rate: '0.0004' }))
    assert.equal(r1.status, 200); assert.equal(r1.env.result.charge.rate, '0.0004'); assert.equal(r1.env.result.charge.rateAsOf, T0 - 10)
    assert.equal(r1.env.result.charge.quote.rate, '0.0005', 'the record carries the current quote for the next call')
    clock.advance(41_000)                                     // now T0 + 111: 0.0004 has lapsed
    const r2 = await call(p, 'search', voucher(5000000000n, { rate: '0.0004' }))
    assert.equal(r2.env.error.data.reason, 'rate')
    const r3 = await call(p, 'search', voucher(4500000000n, { rate: '0.0005' }))
    assert.equal(r3.status, 200)
    // capped: at a very low rate the conversion exceeds priceBEM and the cap is charged / 极低汇率时按上限收费并记 capped
    rate = '0.00001'; asOf = T0 + 311
    clock.advance(200_000)
    await call(p, 'search')
    const r4 = await call(p, 'search', voucher(4500000000n + 10000000000n, { rate: '0.00001' }))
    assert.equal(r4.status, 200, JSON.stringify(r4.env.error))
    assert.equal(r4.env.result.charge.capped, true); assert.equal(r4.env.result.charge.amount.amount, '100.00000000')
  } finally { clock.restore() }
})

test('a quote is honoured by every instance that shares the quote store; a separate store does not know it (§4.4)', async () => {
  const clock = virtualClock({ start: T0 * 1000 })
  try {
    const shared = memoryQuoteStore()
    const meter = (() => { const m = new Map(); return { get: async (c) => m.get(c.toLowerCase()) ?? null, set: async (c, _p, r) => { m.set(c.toLowerCase(), r) }, all: async () => [...m.values()], advance: async (c, _p, r) => { const cur = m.get(c.toLowerCase()); if (cur && BigInt(cur.cumulative) >= BigInt(r.cumulative)) return false; m.set(c.toLowerCase(), r); return true } } })()
    const a = setup({ usdRate: fixedRate('0.0004'), quoteStore: shared, extra: { store: meter } }).p
    const b = setup({ usdRate: fixedRate('0.0003'), quoteStore: shared, extra: { store: meter } }).p
    const c = setup({ usdRate: fixedRate('0.0003') }).p
    await call(a, 'search')                                   // A states 0.0004 / A 报出 0.0004
    const r = await call(b, 'search', voucher(2500000000n, { rate: '0.0004' }))
    assert.equal(r.status, 200, JSON.stringify(r.env.error)); assert.equal(r.env.result.charge.rateAsOf, T0 - 10)
    assert.equal((await call(c, 'search', voucher(2500000000n, { rate: '0.0004' }))).env.error.data.reason, 'rate', 'reverse check: an unshared store refuses')
    // the shared meter: A sees what B accepted / 共享计量：A 看得见 B 收下的
    assert.equal((await call(a, 'search', voucher(2500000000n, { rate: '0.0004' }))).env.error.data.reason, 'stale')
  } finally { clock.restore() }
})

test('§5.3: a priced result that is not an object, or that uses "charge", is INTERNAL and charges nothing; the next voucher is accepted against the same last', async () => {
  const clock = virtualClock({ start: T0 * 1000 })
  try {
    const logs = []
    const { p } = setup({ usdRate: fixedRate('0.0004'), extra: { log: (...a) => logs.push(a.map(String).join(' ')) } })
    await call(p, 'search')
    const r1 = await call(p, 'str', voucher(2500000000n, { rate: '0.0004' }))
    assert.equal(r1.status, 500); assert.equal(r1.env.error.code, 'INTERNAL')
    const r2 = await call(p, 'own', voucher(2500000000n, { rate: '0.0004' }))
    assert.equal(r2.env.error.code, 'INTERNAL')
    assert.ok(logs.some((l) => /JSON object/.test(l)) && logs.some((l) => /reserves/.test(l)))
    const r3 = await call(p, 'search', voucher(2500000000n, { rate: '0.0004' }))
    assert.equal(r3.status, 200); assert.equal(r3.env.result.charge.amount.amount, '25.00000000')
  } finally { clock.restore() }
})

test('the default rate: the median of the manifest\'s own pools read under node agreement, asOf the block time; a failing source restates the last valid quote, then INTERNAL', async () => {
  const clock = virtualClock({ start: T0 * 1000 })
  try {
    const { p, pool } = setup()
    const r = await call(p, 'search')
    const q = r.env.error.data.quote
    assert.ok(Math.abs(Number(q.rate) - 0.0004) / 0.0004 < 2e-4, q.rate)
    assert.equal(q.asOf, T0); assert.equal(q.validUntil, T0 + 120)
    assert.equal(r.env.error.data.price, U.convertUsd({ priceUSD: '0.01', rate: q.rate, priceBEM: '100' }).charge.toString())
    pool.fail('OLD')
    clock.advance(65_000)                                     // past half: a new read is tried, fails, the last quote is restated
    assert.deepEqual((await call(p, 'search')).env.error.data.quote, q)
    clock.advance(60_000)                                     // past validUntil: no quote can be stated
    const r3 = await call(p, 'search')
    assert.equal(r3.env.error.code, 'INTERNAL')
  } finally { clock.restore() }
})

test('settlementFacts: F2, F3 and F4 from configuration, no escrow reads', async () => {
  const clock = virtualClock({ start: T0 * 1000 })
  try {
    const asked = []
    const facts = {
      amountPaid: async (c) => { asked.push(['F2', c]); return 2500000000n },
      fundsAvailable: async (c) => { asked.push(['F4', c]); return 3000000000n },
      keyAuthorisedUntil: async (c, k) => { asked.push(['F3', c, k]); return BigInt(T0 + 7200) },
    }
    const { p, chain } = setup({ usdRate: fixedRate('0.0004'), settlementFacts: facts })
    await call(p, 'search')
    const before = chain.state.reads.filter((x) => x.method === 'eth_call' && ['channelOf', 'claimedOf', 'sessionExpiry', 'pendingWithdraw'].includes(x.fn)).length
    assert.equal((await call(p, 'search', voucher(2500000000n, { rate: '0.0004' }))).env.error.data.reason, 'stale', 'F2 says 25 BEM is already paid')
    const ok = await call(p, 'search', voucher(5000000000n, { rate: '0.0004' }))
    assert.equal(ok.status, 200, JSON.stringify(ok.env.error)); assert.equal(ok.env.result.charge.amount.amount, '25.00000000')
    assert.equal((await call(p, 'search', voucher(5500000001n + 2500000000n, { rate: '0.0004' }))).env.error.data.reason, 'funds', 'F4: 30 BEM above the 25 paid')
    assert.ok(asked.some((a) => a[0] === 'F3' && a[2] === sessionAddr))
    const after = chain.state.reads.filter((x) => x.method === 'eth_call' && ['channelOf', 'claimedOf', 'sessionExpiry', 'pendingWithdraw'].includes(x.fn)).length
    assert.equal(after, before, 'no escrow function was read')
    // reverse check: the same calls without settlementFacts read the escrow / 反向检查：不配置时读托管
    const plain = setup({ usdRate: fixedRate('0.0004') })
    await call(plain.p, 'search')
    await call(plain.p, 'search', voucher(2500000000n, { rate: '0.0004' }))
    assert.ok(plain.chain.state.reads.some((x) => x.fn === 'claimedOf') && plain.chain.state.reads.some((x) => x.fn === 'sessionExpiry'))
  } finally { clock.restore() }
})

test('a manifest without usdPricing keeps 1.8.1: no reason, no charge record, v 0/1 accepted (the golden test covers every byte)', async () => {
  const clock = virtualClock({ start: T0 * 1000 })
  try {
    const chain = createFakeChain()
    chain.setChannel(consumer, ADDR.container, parseUnits('1000'))
    chain.setSession(consumer, ADDR.container, sessionAddr, 1900000000)
    const p = createProvider({ manifest: manifestWith(undefined), signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: chain.fetch, escrowCacheMs: 0, allowHttp: true, minVoucherLifeS: 0, allowMemoryStore: true, methods: handlers })
    const good = voucher(10000n)
    const v01 = { ...good, sig: good.sig.slice(0, 130) + (parseInt(good.sig.slice(130), 16) - 27).toString(16).padStart(2, '0') }
    const r = await p.invoke({ id: 'x1', method: 'bem', params: {}, voucher: v01 }, { ip: '1.1.1.1' })
    assert.equal(r.status, 200); assert.deepEqual(r.env.result, { hits: [] })
    const s = await p.invoke({ id: 'x2', method: 'bem', params: {}, voucher: v01 }, { ip: '1.1.1.1' })
    assert.equal(s.env.error.code, 'BAD_VOUCHER'); assert.equal('reason' in s.env.error.data, false)
  } finally { clock.restore() }
})

test('FIXED M3 (review r): a voucher is valid while now ≤ expires, inclusive; one second later it is expired', async () => {
  const clock = virtualClock({ start: T0 * 1000 })
  try {
    const { p } = setup({ usdRate: fixedRate('0.0004') })
    await call(p, 'search')
    assert.equal((await call(p, 'search', voucher(2500000000n, { rate: '0.0004', expires: T0 - 1 }))).env.error.data.reason, 'expired')
    const r = await call(p, 'search', voucher(2500000000n, { rate: '0.0004', expires: T0 }))
    assert.equal(r.status, 200, JSON.stringify(r.env.error))
  } finally { clock.restore() }
})

test('FIXED S4: quote requests (priced, no voucher) have their own budget; they neither use nor are refused by the free budget', async () => {
  const clock = virtualClock({ start: T0 * 1000 })
  try {
    const { p } = setup({ usdRate: fixedRate('0.0004'), extra: { rateLimit: { free: 2, quote: 2, paid: 100 } } })
    const ask = (method) => p.invoke({ id: `rl${++n}`, method, params: {} }, { ip: '10.9.9.9' })
    assert.equal((await ask('search')).status, 402); assert.equal((await ask('search')).status, 402)
    assert.ok((await ask('search')).rateLimited, 'the third quote request is over its budget')
    assert.equal((await ask('free')).status, 200); assert.equal((await ask('free')).status, 200)   // the free budget is untouched / 免费预算未被占用
    assert.ok((await ask('free')).rateLimited)
    // a service without usdPricing keeps 1.8.1: PAYMENT_REQUIRED spends the free budget / 不带 usdPricing 的服务保持 1.8.1
    const chain = createFakeChain()
    const plain = createProvider({ manifest: manifestWith(undefined), signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: chain.fetch, allowHttp: true, minVoucherLifeS: 0, allowMemoryStore: true, methods: handlers, rateLimit: { free: 2, quote: 50, paid: 100 } })
    const ask2 = (method) => plain.invoke({ id: `rl${++n}`, method, params: {} }, { ip: '10.9.9.8' })
    assert.equal((await ask2('bem')).status, 402); assert.equal((await ask2('free')).status, 200)
    assert.ok((await ask2('free')).rateLimited)
    assert.throws(() => setup({ usdRate: fixedRate('0.0004'), extra: { rateLimit: { quote: -1 } } }), (e) => e.code === 'INVALID_ARGUMENT' && /quote/.test(e.message))
  } finally { clock.restore() }
})

test('FIXED S5: a refusal before the signature checks out derives no quote, and a failed derivation leaves the BAD_VOUCHER a BAD_VOUCHER (price at the cap, no quote)', async () => {
  const clock = virtualClock({ start: T0 * 1000 })
  try {
    let asked = 0, fail = true
    const { p } = setup({ usdRate: async () => { asked++; if (fail) throw new Error('source down'); return { rate: '0.0004', asOf: T0 - 10 } } })
    const m = await call(p, 'search', 'nope')
    assert.equal(m.env.error.code, 'BAD_VOUCHER'); assert.equal(m.env.error.data.reason, 'malformed')
    assert.deepEqual(m.env.error.data, { reason: 'malformed', price: '10000000000', priceUSD: { currency: 'USD', amount: '0.01000000' } })
    assert.equal(asked, 0, 'no derivation for an unauthenticated refusal')
    const r = await call(p, 'search', voucher(2500000000n, { rate: '0.0004' }))      // signed, then refused for rate
    assert.equal(r.env.error.code, 'BAD_VOUCHER'); assert.equal(r.env.error.data.reason, 'rate'); assert.equal(r.env.error.data.quote, undefined)
    assert.equal(asked, 1)
    // PAYMENT_REQUIRED stays strict: it cannot be answered without a quote / PAYMENT_REQUIRED 仍然严格
    assert.equal((await call(p, 'search')).env.error.code, 'INTERNAL')
    fail = false
    assert.ok((await call(p, 'search')).env.error.data.quote)
  } finally { clock.restore() }
})

test('FIXED S8: memoryQuoteStore keeps one namespace per service', async () => {
  const s = memoryQuoteStore()
  const q = { rate: '0.0004', asOf: 1, validUntil: 9 }
  await s.put(q, '0x' + 'aa'.repeat(20))
  assert.deepEqual(await s.get('0.0004', '0x' + 'AA'.repeat(20)), q)
  assert.equal(await s.get('0.0004', '0x' + 'bb'.repeat(20)), null)
})
