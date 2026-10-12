// @experimental USD pricing (TAP draft "Payment Vouchers", TAPs#52): manifest member, exact conversion, quotes, the
// strict-v voucher recovery, and the reference-rate arithmetic, against the draft's own vectors.
// 实验性美元计价：清单成员、精确换算、报价、凭证严格 v 恢复、参考汇率算术，对照草稿自带的向量。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { usdPricing as U, sig, TapeAPIError } from '../src/index.js'

const vec = (name) => JSON.parse(readFileSync(new URL(`../../spec/vectors/${name}`, import.meta.url), 'utf8'))
const V = vec('tapi-22-usd.json')
const code = (c, re) => (e) => e instanceof TapeAPIError && e.code === c && (!re || re.test(e.message))
const USDT = '0x55d398326f99059fF775485246999027B3197955'

test('§4.3 conversion: every vector case, exact integers; every refused input is refused', () => {
  for (const c of V.conversion.cases) {
    const r = U.convertUsd(c)
    assert.equal(r.U.toString(), c.U, c.name); assert.equal(r.R.toString(), c.R, c.name); assert.equal(r.P.toString(), c.P, c.name)
    assert.equal(r.converted.toString(), c.converted, c.name); assert.equal(r.charge.toString(), c.charge, c.name); assert.equal(r.capped, c.capped, c.name)
    assert.deepEqual(U.amountObject(r.charge, 'BEM'), c.bem, c.name); assert.deepEqual(U.amountObject(r.U, 'USD'), c.usd, c.name)
  }
  for (const c of V.conversion.invalid) {
    const want = { priceUSD: 'MANIFEST_INVALID', rate: 'BAD_QUOTE', priceBEM: 'MANIFEST_INVALID' }[c.refused]
    assert.throws(() => U.convertUsd(c), code(want), c.name)
  }
  // reverse check: one more base unit of price moves the rounding / 反向检查：价格多 1 个单位，进位随之改变
  assert.equal(U.convertUsd({ priceUSD: '0.01', rate: '0.0004', priceBEM: '100' }).charge, 2500000000n)
  assert.equal(U.convertUsd({ priceUSD: '0.01000001', rate: '0.0004', priceBEM: '100' }).charge, 2500002500n)
  assert.equal(U.convertUsd({ priceUSD: '0.01', rate: '0.000400000000000001', priceBEM: '100' }).charge, 2500000000n)  // ceil, not floor
})

test('§3.1 / item 15: a voucher signature with v of 0 or 1 is refused by recoverVoucherSigner, while TAP-13 envelopes keep accepting it', () => {
  const vv = V.voucher
  for (const c of vv.cases) {
    assert.equal(sig.recoverVoucherSigner(56, vv.domain.verifyingContract, c, c.sig), c.recoversTo, c.name)
    assert.equal('0x' + Buffer.from(sig.voucherDigest(56, vv.domain.verifyingContract, c)).toString('hex'), c.digest, c.name)
  }
  const first = vv.cases[0]
  for (const e of vv.refusedEncodingsOfCase1) assert.throws(() => sig.recoverVoucherSigner(56, vv.domain.verifyingContract, first, e.sig), code('BAD_SIGNATURE'), e.name)
  // the default recovery is unchanged: v 0/1 still reads as 27/28 (TAP-13 §5) / 默认恢复不变
  const v01 = vv.refusedEncodingsOfCase1.find((e) => e.name.startsWith('v written as 0 or 1')).sig
  assert.equal(sig.recoverAddress(first.digest, v01), first.recoversTo)
  assert.equal(sig.parseSignature(v01).v, first.sig.endsWith('1b') ? 27 : 28)
  assert.throws(() => sig.parseSignature(v01, { strictV: true }), code('BAD_SIGNATURE', /27 or 28/))
  assert.equal(U.normaliseV(v01), first.sig)
  assert.equal(U.normaliseV(first.sig), first.sig)
})

const base = () => ({
  methods: [{ name: 'free', priceBEM: '0' }, { name: 'search', priceBEM: '100' }, { name: 'zero', priceBEM: '0.00' }],
  usdPricing: { methods: { search: '0.01' }, toleranceBps: 200, maxQuoteS: 120, rateSources: [{ type: 'v3-twap', pool: '0x' + '0b'.repeat(20), usd: USDT, window: 1800 }] },
})
test('§4.1 usdPricing: valid member normalised; each rule of the table refuses; unknown source types and dollar tokens are ignored', () => {
  assert.equal(U.validateUsdPricing({ methods: [] }), null)
  const ok = U.validateUsdPricing(base())
  assert.deepEqual(ok.methods, { search: '0.01' }); assert.equal(ok.toleranceBps, 200); assert.equal(ok.maxQuoteS, 120); assert.equal(ok.rateSources.length, 1)
  const bad = (edit, re) => { const m = base(); edit(m); assert.throws(() => U.validateUsdPricing(m), code('MANIFEST_INVALID', re)); assert.ok(U.usdPricingOf(m).error) }
  bad((m) => { m.usdPricing = [] }, /object/)
  bad((m) => { m.usdPricing.methods = {} }, /non-empty/)
  bad((m) => { m.usdPricing.methods = { nope: '1' } }, /not a method/)
  bad((m) => { m.usdPricing.methods = { free: '1' } }, /not a priced method/)
  bad((m) => { m.usdPricing.methods = { zero: '1' } }, /not a priced method/)      // "0.00" is free: zero in value / 数值为零即免费
  bad((m) => { m.usdPricing.methods = { search: '0' } }, /not zero/)
  bad((m) => { m.usdPricing.methods = { search: '0.000000001' } }, /USD price/)
  bad((m) => { m.usdPricing.methods = { search: 1 } }, /USD price/)
  bad((m) => { m.usdPricing.methods = { search: '1e-2' } }, /USD price/)
  bad((m) => { m.usdPricing.methods = JSON.parse('{"__proto__":"1"}') }, /not allowed|not a method/)
  for (const t of [0, 2001, 1.5, '200']) bad((m) => { m.usdPricing.toleranceBps = t }, /toleranceBps/)
  for (const t of [0, 901, '120']) bad((m) => { m.usdPricing.maxQuoteS = t }, /maxQuoteS/)
  bad((m) => { m.usdPricing.rateSources = [] }, /non-empty/)
  bad((m) => { m.usdPricing.rateSources[0].window = 599 }, /window/)
  bad((m) => { m.usdPricing.rateSources[0].window = 86401 }, /window/)
  bad((m) => { m.usdPricing.rateSources[0].pool = '0x12' }, /pool/)
  bad((m) => { m.usdPricing.rateSources[0].usd = U.BEM_ADDRESS }, /BEM itself/)
  // §4.5: an element of an unknown type is ignored; if none remains the member is invalid / 未知类型忽略；一个不剩即无效
  bad((m) => { m.usdPricing.rateSources = [{ type: 'chainlink', feed: '0x' }] }, /no rate source/)
  bad((m) => { m.usdPricing.rateSources[0].usd = '0x' + '0c'.repeat(20) }, /no rate source/)
  const m = base(); m.usdPricing.rateSources.push({ type: 'chainlink', feed: 'x' })
  assert.equal(U.validateUsdPricing(m).rateSources.length, 1)
  const unknownUsd = base(); unknownUsd.usdPricing.rateSources[0].usd = '0x' + '0c'.repeat(20)
  assert.equal(U.validateUsdPricing(unknownUsd, { usdTokens: ['0x' + '0c'.repeat(20)] }).rateSources.length, 1, 'a caller list recognises it')
  assert.equal(U.validateUsdPricing(unknownUsd, { usdTokens: null }).rateSources.length, 1, 'null skips the filter (a provider on its own manifest)')
})

test('§4.4 quotes: the vector envelopes carry valid quotes; every rule refuses', () => {
  const ts = 1789000000
  for (const c of V.envelopes.cases) {
    const q = c.ok ? c.body.charge.quote : c.body.data.quote
    assert.deepEqual(U.validateQuote(q, { maxQuoteS: V.envelopes.manifestExcerpt.usdPricing.maxQuoteS, ts: c.ts }), q, c.name)
  }
  const q = { rate: '0.0004', asOf: ts - 30, validUntil: ts + 90 }
  assert.deepEqual(U.validateQuote(q, { maxQuoteS: 120, ts }), q)
  const bad = (edit, re, o = { maxQuoteS: 120, ts }) => { const x = { ...q }; edit(x); assert.throws(() => U.validateQuote(x, o), code('BAD_QUOTE', re)) }
  bad((x) => { x.rate = '0' }, /non-zero/)
  bad((x) => { x.rate = '0.0000000000000000001' }, /18 fraction/)
  bad((x) => { x.rate = 4e-4 }, /rate/)
  bad((x) => { x.extra = 1 }, /exactly/)
  bad((x) => { delete x.asOf }, /exactly/)
  bad((x) => { x.asOf = ts + 1 }, /later than/)
  bad((x) => { x.validUntil = x.asOf }, /before validUntil/)
  bad((x) => { x.validUntil = x.asOf + 121 }, /maxQuoteS/)
  bad((x) => { x.asOf = 1.5 }, /asOf/)
})

test('§4.5 reference rate arithmetic: mean tick toward negative infinity, both orientations, the median, the one-sided check', () => {
  const rs = V.rateSource
  for (const s of rs.constructed) {
    const t = U.meanTick(s.tickCumulatives, s.window)
    assert.equal(t.toString(), s.meanTick, s.name)
    const r = U.rateFromTick(t, s)
    assert.ok(Math.abs(r - s.rate) / s.rate < 1e-9, s.name)
  }
  assert.ok(Math.abs(U.median(rs.constructed.slice(0, 2).map((s) => s.rate)) - rs.referenceOfFirstTwo) < 1e-12)
  for (const c of rs.checks) assert.equal(U.quotePasses(c.rate, rs.referenceOfFirstTwo, c.toleranceBps), c.accepted, c.name)
  for (const r of rs.recordedReads.reads) assert.equal(U.meanTick(r.tickCumulatives, r.window).toString(), r.meanTick)
  // toward negative infinity, not toward zero / 向负无穷取整，而不是向零
  assert.equal(U.meanTick([0n, -1n], 1800), -1n)
  assert.equal(U.meanTick([0n, 1n], 1800), 0n)
  assert.equal(U.median([3, 1, 2]), 2); assert.equal(U.median([]), null); assert.equal(U.median([1, 2, 3, 10]), 2.5)
  assert.equal(U.formatRate(26.657), '26.657'); assert.equal(U.formatRate(0.0004), '0.0004')
  assert.equal(U.quotePasses('0.98', 1, 200), true); assert.equal(U.quotePasses('0.979', 1, 200), false); assert.equal(U.quotePasses('5', 1, 1), true)
})

test('§4.5 observe codec: encoder is selector 0x883bdbfd with [window, 0]; decoder is strict and sign-extends int56', () => {
  assert.equal(U.encodeObserve(1800), '0x883bdbfd' + (32).toString(16).padStart(64, '0') + '2'.padStart(64, '0') + (1800).toString(16).padStart(64, '0') + '0'.repeat(64))
  const w = (n) => (BigInt.asUintN(256, BigInt(n))).toString(16).padStart(64, '0')
  const enc = (a, b) => '0x' + w(64) + w(64 + 32 * 3) + w(2) + w(a) + w(b) + w(2) + w(0) + w(0)
  assert.deepEqual(U.decodeObserve(enc(-1004931584399n, -1005405166621n)), [-1004931584399n, -1005405166621n])
  assert.throws(() => U.decodeObserve(enc(1n << 55n, 0n)), code('ABI_INVALID', /int56/))
  assert.throws(() => U.decodeObserve('0x' + w(64)), code('ABI_INVALID'))
  assert.throws(() => U.decodeObserve('0x12'), code('ABI_INVALID'))
})

test('§7 / §8.3 charge record: built and checked; each mismatch is classified', () => {
  const voucher = { consumer: '0x' + 'aa'.repeat(20), cumulative: '5833333334', rate: '0.0003' }
  const usd = { priceUSD: '0.01', priceBEM: '100' }
  const rec = U.chargeRecord({ consumer: voucher.consumer, cumulative: voucher.cumulative, amount: 3333333334n, usd: { priceUSD: '0.01', rate: '0.0003', rateAsOf: 5, capped: false }, quote: { rate: '0.0003', asOf: 5, validUntil: 9 } })
  assert.deepEqual(rec.amount, { currency: 'BEM', amount: '33.33333334' }); assert.equal('capped' in rec, false)
  assert.deepEqual(U.checkChargeRecord(rec, { voucher, last: 2500000000n, usd }), { ok: true })
  const k = (edit, kind) => { const r = structuredClone(rec); edit(r); assert.equal(U.checkChargeRecord(r, { voucher, last: 2500000000n, usd }).kind, kind) }
  k((r) => { r.consumer = '0x' + 'bb'.repeat(20) }, 'unbound')
  k((r) => { r.cumulative = '1' }, 'unbound')
  k((r) => { r.amount.amount = '33.33333335' }, 'fault')
  k((r) => { r.price.amount = '0.02000000' }, 'fault')
  k((r) => { r.rate = '0.0004' }, 'unbound')   // rate is not signed: path or provider (review S1)
  k((r) => { r.capped = true }, 'fault')
  k((r) => { delete r.rateAsOf }, 'fault')
  assert.equal(U.checkChargeRecord(undefined, { voucher, last: 0n }).kind, 'unbound')
  // capped must be present exactly when the conversion caps / capped 恰在换算封顶时出现
  const capped = U.chargeRecord({ consumer: voucher.consumer, cumulative: '10000000000', amount: 10000000000n, usd: { priceUSD: '1', rate: '0.0001', rateAsOf: 5, capped: true }, quote: { rate: '0.0001', asOf: 5, validUntil: 9 } })
  assert.equal(capped.capped, true)
  assert.deepEqual(U.checkChargeRecord(capped, { voucher: { ...voucher, cumulative: '10000000000', rate: '0.0001' }, last: 0n, usd: { priceUSD: '1', priceBEM: '100' } }), { ok: true })
  const notCapped = structuredClone(capped); delete notCapped.capped
  assert.equal(U.checkChargeRecord(notCapped, { voucher: { ...voucher, cumulative: '10000000000', rate: '0.0001' }, last: 0n, usd: { priceUSD: '1', priceBEM: '100' } }).kind, 'fault')
})

test('§3.2 wire form: what is malformed', () => {
  const v = { consumer: '0x' + 'aa'.repeat(20), provider: '0x' + 'bb'.repeat(20), cumulative: '1', expires: 5, sig: '0x' + '11'.repeat(65) }
  assert.equal(U.voucherWireProblem(v), null)
  for (const [k, x] of [['cumulative', '01'], ['cumulative', '-1'], ['cumulative', (1n << 256n).toString()], ['expires', -1], ['expires', 2 ** 53], ['sig', '0x' + '11'.repeat(64)], ['signer', 'x'], ['rate', 1], ['consumer', '0x1']]) {
    assert.notEqual(U.voucherWireProblem({ ...v, [k]: x }), null, `${k} ${x}`)
  }
  assert.equal(U.voucherWireProblem({ ...v, cumulative: ((1n << 256n) - 1n).toString() }), null)
})

// The draft's own vector files (TapeOutProtocol/TAPs#52, assets/tap-draft-payment-vouchers/: conversion.json,
// voucher.json, envelopes.json, rate-source.json, generated by the draft's self-contained gen.mjs) and this implementation
// agree member for member, except their `note`: the SHA-256 of each file's canonical JSON without `note` is pinned here.
// 草稿自带的向量文件与本实现逐成员一致（`note` 除外）：这里固定了每个文件去掉 `note` 后规范 JSON 的 SHA-256。
test('the reference implementation reproduces the draft vectors exactly (canonical hashes pinned)', async () => {
  const { sha256 } = await import('@noble/hashes/sha256')
  const { bytesToHex, utf8ToBytes } = await import('@noble/hashes/utils')
  const { canonicalJSON } = await import('../src/canon.js')
  const pinned = {
    conversion: '05c49e701f2b46e9cdb2f8cdb94ff945fd2ec175b3469b9437dc039ac9b86575',
    voucher: 'f514d75d2a38d5cffd222d32049ccd434bbe27e48ff56994fa5473e8444d13e1',
    envelopes: 'ffbf53a91d358a7aef2289a8db235ad689447b5743457c4c4b29f0da38148da9',
    rateSource: '26db6963c3ec0ca022f546a364e13702e27359892fc6741a2b5b36235fe6b449',
  }
  for (const [k, h] of Object.entries(pinned)) assert.equal(bytesToHex(sha256(utf8ToBytes(canonicalJSON(V[k])))), h, k)
})

test('§4.5 readReferenceRates on a chain: one block agreed by the nodes, every read pinned to its hash, the median; failures named, never guessed', async () => {
  const { createFakeChain } = await import('./helpers/fake-chain.mjs')
  const { installPool } = await import('./helpers/v3-pool.mjs')
  const { createRpc } = await import('../src/index.js')
  const chain = createFakeChain()
  chain.state.headTime = Math.floor(Date.now() / 1000)   // one fixed head time for all three nodes: a read that straddles a second must not make them disagree under load
  const P1 = '0x' + 'a1'.repeat(20), P2 = '0x' + 'a2'.repeat(20), P3 = '0x' + 'a3'.repeat(20), P4 = '0x' + 'a4'.repeat(20)
  const USD6 = '0x' + 'c6'.repeat(20)
  const p1 = installPool(chain, { pool: P1, usd: USDT, rate: 26.657 })
  installPool(chain, { pool: P2, usd: USD6, usdDecimals: 6, bemIsToken0: true, rate: 26.70 })
  const p3 = installPool(chain, { pool: P3, usd: USDT, rate: 26.68, remainder: -7n })
  installPool(chain, { pool: P4, usd: '0x' + 'c7'.repeat(20), rate: 1 })     // its token1 is BEM, its token0 not the named usd
  const rpc = createRpc({ urls: ['http://rpc1', 'http://rpc2', 'http://rpc3'], quorum: 2, fetch: chain.fetch })
  const src = (pool, usd = USDT, window = 1800) => ({ type: 'v3-twap', pool, usd, window })
  const r = await U.readReferenceRates(rpc, [src(P1), src(P2, USD6), src(P3)], { maxAgeS: 120 })
  const rates = r.sources.map((s) => s.rate)
  for (const [x, want] of [[rates[0], 26.657], [rates[1], 26.70], [rates[2], 26.68]]) assert.ok(Math.abs(x - want) / want < 2e-4, `${x} ~ ${want}`)
  assert.equal(r.reference, U.median(rates))
  assert.equal(r.sources[1].bemIsToken0, true); assert.equal(r.sources[1].usdDecimals, 6)
  // every state read of this call was pinned to the agreed block's hash, never to a tag / 每个状态读取都钉在共识块的哈希上
  const reads = chain.state.reads.filter((x) => x.method === 'eth_call')
  assert.ok(reads.length >= 3 * 4 * 2)
  for (const x of reads) assert.deepEqual(x.block, { blockHash: r.block.hash, requireCanonical: true })
  assert.deepEqual(p1.state.observed.slice(0, 1), [1800])
  // a pool that cannot answer the window, wrong tokens: no rate, with the reason / 读不出窗口、代币不符：没有汇率并说明原因
  p3.fail('OLD')
  const r2 = await U.readReferenceRates(rpc, [src(P1), src(P3), src(P4, '0x' + 'c8'.repeat(20))])
  assert.equal(r2.sources[1].reason, 'observe'); assert.equal(r2.sources[1].rate, undefined)
  assert.equal(r2.sources[2].reason, 'tokens')
  assert.equal(r2.reference, r2.sources[0].rate, 'the median of the one rate left')
  const none = await U.readReferenceRates(rpc, [src(P3)])
  assert.equal(none.reference, null)
  // a stale pinned block is refused, not used / 过旧的钉块被拒绝
  await assert.rejects(U.readReferenceRates(rpc, [src(P1)], { block: { number: 1, hash: '0x' + 'b1'.repeat(32), timestamp: Math.floor(Date.now() / 1000) - 500 }, maxAgeS: 120 }), code('RPC_STALE'))
  // nodes that disagree on the pool's answer: an error, never a rate / 节点对池子回答不一致：报错而不是给出汇率
  chain.state.faults.set('http://rpc2', 'disagree')
  await assert.rejects(U.readReferenceRates(rpc, [src(P1)]), (e) => e instanceof TapeAPIError && /RPC_/.test(e.code))
  chain.state.faults.delete('http://rpc2')
  // reverse check: moving the pool's price moves the reference / 反向检查：池子价格变，参考汇率随之变
  p1.setRate(20)
  const r3 = await U.readReferenceRates(rpc, [src(P1)])
  assert.ok(Math.abs(r3.reference - 20) / 20 < 2e-4)
})
