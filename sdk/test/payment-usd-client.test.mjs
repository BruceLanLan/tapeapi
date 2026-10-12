// @experimental Client side of the TAP draft "Payment Vouchers" (TAPs#52), end to end against the real provider over
// HTTP: quotes only from verified envelopes (item 3), the reference-rate check before signing, the voucher's `rate` and
// v of 27/28 (item 5), the charge record check of §8.3 with the halt until a reread and an F2 read, and the handling of
// `reason` (item 6). A "provider fault" is simulated by a proxy that holds the signer key and re-signs what it changes.
// 草稿的客户端，经 HTTP 对真实提供者端到端：报价只取自已验信封、签名前对照参考汇率、凭证的 `rate` 与 v 27/28、§8.3 的计费记录核对
// （不符即停，直到重读与读 F2）、`reason` 的处理。"提供者过错"由持有签名钥匙、改完重签的代理模拟。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTapeAPI, parseUnits, usdPricing as U, TapeAPIError } from '../src/index.js'
import { privateKeyToAddress, signDigest, delegationDigest, signResponse } from '../src/sig.js'
import { createProvider, memoryQuoteStore } from '../../server/src/index.js'
import { createFakeChain, ADDR } from './helpers/fake-chain.mjs'
import { installPool } from './helpers/v3-pool.mjs'

const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32), CONSUMER_KEY = '0x' + '33'.repeat(32), SESSION_KEY = '0x' + '44'.repeat(32)
const holder = privateKeyToAddress(HOLDER_KEY), signer = privateKeyToAddress(SIGNER_KEY), consumer = privateKeyToAddress(CONSUMER_KEY), sessionAddr = privateKeyToAddress(SESSION_KEY)
const RPC = ['http://rpc1', 'http://rpc2', 'http://rpc3']
const POOL = '0x' + 'a1'.repeat(20), USDT = U.DEFAULT_USD_TOKENS[0]
const nowS = () => Math.floor(Date.now() / 1000)
const code = (c) => (e) => e instanceof TapeAPIError && e.code === c

let chain, provider, manifest, quoteStore, providerRate, meter
const USDP = { methods: { search: '0.01' }, toleranceBps: 200, maxQuoteS: 120, rateSources: [{ type: 'v3-twap', pool: POOL, usd: USDT, window: 1800 }] }
function buildManifest(usdPricing = USDP) {
  const expires = nowS() + 300 * 86400
  return {
    tapeapi: '0.1', name: 'USD client', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
    delegation: { expires, sig: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires }), HOLDER_KEY) },
    endpoints: { live: ['http://127.0.0.1:1/tapeapi/v1'], async: false },
    methods: [
      { name: 'free', priceBEM: '0', params: {}, returns: {} },
      { name: 'search', priceBEM: '100', params: {}, returns: {} },
      { name: 'bem', priceBEM: '0.0001', params: {}, returns: {} },
    ],
    payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 },
    usdPricing,
  }
}
async function startProvider() {
  const p = createProvider({
    manifest, signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: chain.fetch, escrowCacheMs: 0, allowHttp: true, minVoucherLifeS: 0,
    allowMemoryStore: true, quoteStore, store: meter, usdRate: async () => ({ rate: providerRate, asOf: nowS() - 5 }),
    methods: { free: async () => ({ ok: 1 }), search: async () => ({ hits: ['a'] }), bem: async () => ({ hits: [] }) },
  })
  const srv = await p.listen(0)
  manifest.endpoints.live = [`http://127.0.0.1:${srv.address().port}/tapeapi/v1`]
  chain.writeFile(ADDR.container, '/.well-known/tapeapi.json', JSON.stringify(manifest))
  return p
}
// A provider restart with a new rate: its quotes are gone unless the quote store is kept; the meter (store) is kept.
// 提供者以新汇率重启：报价表不保留则报价全失；计量（store）保留。
async function restart(rate, { keepQuotes = false } = {}) {
  await provider.close()
  providerRate = rate
  if (!keepQuotes) quoteStore = memoryQuoteStore()
  provider = await startProvider()
}
const lastOnProvider = async () => BigInt((await provider.store.get(consumer, ADDR.container))?.cumulative ?? '0')
const BASE = { rpcUrls: RPC, quorum: 2, chainId: 56, directory: ADDR.directory, escrow: ADDR.escrow, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, allowHttp: true, conform: false }  // conform: false: 1.x behaviour; 2.0 default is conform: 'tap10'
// A client whose provider traffic goes through `edit` (it may change and re-sign an envelope); bodies are recorded.
// 提供者流量经过 `edit` 的客户端（可改动并重签信封）；记录请求体。
function client({ edit, ...extra } = {}) {
  const sent = []
  const api = createTapeAPI({
    ...BASE, ...extra,
    fetch: chain.fetchWith(async (url, init) => {
      if (init?.method === 'POST') sent.push(JSON.parse(init.body))
      const r = await fetch(url, init)
      if (!edit) return r
      const env = await r.json()
      const req = JSON.parse(init.body)
      const before = JSON.stringify(env)
      const out = edit(env, req)
      if (JSON.stringify(out) === before) return new Response(before, { status: r.status, headers: { 'content-type': 'application/json' } })
      out.sig = signResponse({ container: out.container, id: out.id, method: req.method, params: req.params ?? {}, ok: out.ok, body: out.ok ? out.result : out.error, ts: out.ts }, SIGNER_KEY)
      return new Response(JSON.stringify(out), { status: r.status, headers: { 'content-type': 'application/json' } })
    }),
  })
  return { api, sent }
}

before(async () => {
  chain = createFakeChain()
  chain.state.headTime = Math.floor(Date.now() / 1000)   // one fixed head time for all nodes (see usd-pricing.test.mjs)
  chain.setOwner(4246, holder); chain.setAccount(4246, ADDR.container)
  chain.setChannel(consumer, ADDR.container, parseUnits('100000'))
  chain.setSession(consumer, ADDR.container, sessionAddr, 1900000000)
  installPool(chain, { pool: POOL, usd: USDT, rate: 0.0004 })
  quoteStore = memoryQuoteStore()
  meter = (await import('../../server/src/index.js')).memoryStore()
  providerRate = '0.0004'
  manifest = buildManifest()
  provider = await startProvider()
})
after(async () => { await provider.close() })

test('item 3/5: the first call asks for a quote without a voucher, checks it against the pools, signs with its rate; the record is checked; the next call uses the quote of the record', async () => {
  const { api, sent } = client()
  const svc = await api.resolve(ADDR.container)
  const payer = api.payer({ consumer, sessionKey: SESSION_KEY })
  const r = await api.call(svc, 'search', {}, { payer })
  assert.deepEqual(r.result.hits, ['a'])
  assert.equal(sent.length, 2, 'one PAYMENT_REQUIRED for the quote, then the paid call')
  assert.equal(sent[0].voucher, undefined)
  assert.equal(sent[1].voucher.rate, '0.0004'); assert.equal(sent[1].voucher.cumulative, '2500000000')
  assert.ok(['1b', '1c'].includes(sent[1].voucher.sig.slice(-2)), 'v is 27 or 28')
  assert.equal(payer.cumulativeOf(svc), 2500000000n)
  assert.equal(r.result.charge.amount.amount, '25.00000000')
  const r2 = await api.call(svc, 'search', {}, { payer })
  assert.equal(sent.length, 3, 'the quote in the charge record serves the next call: no extra round trip')
  assert.equal(sent[2].voucher.cumulative, '5000000000'); assert.equal(r2.result.charge.cumulative, '5000000000')
  // a BEM-priced method of the same service: its record is checked too / 同一服务的 BEM 计价方法：记录同样核对
  const r3 = await api.call(svc, 'bem', {}, { payer })
  assert.deepEqual(r3.result.charge.amount, { currency: 'BEM', amount: '0.00010000' })
  assert.equal(sent[3].voucher.rate, undefined)
  // a free method sends no voucher and expects no record / 免费方法不带凭证、不要记录
  assert.deepEqual((await api.call(svc, 'free', {}, { payer })).result, { ok: 1 })
})

test('§4.5: a quote further below the reference than the tolerance is refused before any voucher is signed; above passes; a smaller client tolerance binds', async () => {
  try {
    await restart('0.000391')                       // 2.25 % below the pool's 0.0004 / 比池子低 2.25%
    const { api, sent } = client()
    const svc = await api.resolve(ADDR.container)
    const payer = api.payer({ consumer, sessionKey: SESSION_KEY })
    await assert.rejects(api.call(svc, 'search', {}, { payer }), (e) => code('RATE_REFUSED')(e) && e.data.toleranceBps === 200)
    assert.ok(sent.every((b) => !b.voucher), 'no voucher left the client')
    assert.equal(payer.cumulativeOf(svc), 0n)
    await restart('0.000395')                       // 1.25 % below: passes at 200 bps, not at 100 / 低 1.25%
    const strict = client({ usdPricing: { toleranceBps: 100 } })
    const s2 = await strict.api.resolve(ADDR.container)
    await assert.rejects(strict.api.call(s2, 'search', {}, { payer: strict.api.payer({ consumer, sessionKey: SESSION_KEY }) }), code('RATE_REFUSED'))
    const loose = client()
    const s3 = await loose.api.resolve(ADDR.container)
    const p3 = loose.api.payer({ consumer, sessionKey: SESSION_KEY })
    await p3.setCumulative(s3, await lastOnProvider())
    const ok = await loose.api.call(s3, 'search', {}, { payer: p3 })
    assert.equal(ok.result.charge.rate, '0.000395')
    await restart('0.0005')                         // above the reference: cheaper for the client, passes / 高于参考：更便宜，通过
    const hi = client(); const s4 = await hi.api.resolve(ADDR.container); const p4 = hi.api.payer({ consumer, sessionKey: SESSION_KEY })
    await p4.setCumulative(s4, BigInt(ok.result.charge.cumulative))
    assert.equal((await hi.api.call(s4, 'search', {}, { payer: p4 })).result.charge.rate, '0.0005')
    // the client's own reference (for example one its user confirmed) replaces the pools / 客户端自己的参考汇率
    const own = client({ usdPricing: { reference: async () => 0.001 } }); const s5 = await own.api.resolve(ADDR.container)
    await assert.rejects(own.api.call(s5, 'search', {}, { payer: own.api.payer({ consumer, sessionKey: SESSION_KEY }) }), code('RATE_REFUSED'))
  } finally { await restart('0.0004') }
})

test('§8.3 item 2: a signed record with a wrong amount is a provider fault: CHARGE_MISMATCH, nothing committed, no voucher until a reread and an F2 read', async () => {
  let tamper = true
  const { api, sent } = client({ edit: (env) => { if (tamper && env.ok && env.result?.charge) { env.result.charge.amount.amount = '30.00000000' } return env } })
  const svc = await api.resolve(ADDR.container)
  const payer = api.payer({ consumer, sessionKey: SESSION_KEY })
  const start = await lastOnProvider()
  await payer.setCumulative(svc, start)
  await assert.rejects(api.call(svc, 'search', {}, { payer }), (e) => code('CHARGE_MISMATCH')(e) && e.data.kind === 'fault' && e.signed === true && e.data.result.hits[0] === 'a')
  assert.equal(payer.cumulativeOf(svc), start, 'last is not raised from that record')
  tamper = false
  // while halted, a reread that fails sends nothing / 停止期间重读失败则什么都不发
  chain.writeFile(ADDR.container, '/.well-known/tapeapi.json', '{"not": "a manifest"}')
  const sentBefore = sent.length
  await assert.rejects(api.call(svc, 'search', {}, { payer }))
  assert.equal(sent.length, sentBefore, 'no request, no voucher, before the service is reread')
  chain.writeFile(ADDR.container, '/.well-known/tapeapi.json', JSON.stringify(manifest))
  const reads = chain.state.reads.length
  const ok = await api.call(svc, 'search', {}, { payer })
  // the next call reread the service and read claimedOf (F2) first; the provider then refused the stale figure and the
  // client resynced on the provider's proof, the consumer's own voucher / 下一次调用先重读并读 F2；随后按提供者附的自签凭证重新同步
  assert.ok(chain.state.reads.slice(reads).some((x) => x.fn === 'claimedOf'))
  assert.equal(ok.result.charge.cumulative, (start + 2n * 2500000000n).toString())
  assert.ok(sent.length >= 3)
})

test('§8.3 item 1: a result without a record, or with another cumulative, is unbound: CHARGE_MISMATCH, nothing raised', async () => {
  const { api } = client({ edit: (env) => { if (env.ok && env.result?.charge) delete env.result.charge; return env } })
  const svc = await api.resolve(ADDR.container)
  const payer = api.payer({ consumer, sessionKey: SESSION_KEY })
  const start = await lastOnProvider()
  await payer.setCumulative(svc, start)
  await assert.rejects(api.call(svc, 'search', {}, { payer }), (e) => code('CHARGE_MISMATCH')(e) && e.data.kind === 'unbound')
  assert.equal(payer.cumulativeOf(svc), start)
})

test('item 6: `rate` retries once with the quote of the refusal; `stale` resyncs on the proof and retries; an unknown reason is a refusal', async () => {
  // the provider forgets its quotes (a restart on a per-process store): the cached quote is no longer honoured
  // 提供者忘了它的报价（进程内存储下重启）：缓存的报价不再兑现
  const { api, sent } = client()
  const svc = await api.resolve(ADDR.container)
  const payer = api.payer({ consumer, sessionKey: SESSION_KEY })
  await payer.setCumulative(svc, await lastOnProvider())
  await api.call(svc, 'search', {}, { payer })
  const before = sent.length
  await restart('0.00041')
  await api.refresh(svc)
  const r = await api.call(svc, 'search', {}, { payer })
  assert.equal(r.result.charge.rate, '0.00041')
  assert.equal(sent.length - before, 2, 'refused for rate once, retried once with the quote of the refusal')
  assert.equal(sent[before].voucher.rate, '0.0004'); assert.equal(sent[before + 1].voucher.rate, '0.00041')
  // stale: a second payer for the same consumer starts at 0 / 同一消费者的第二个 payer 从 0 开始
  const payer2 = api.payer({ consumer, sessionKey: SESSION_KEY })
  const r2 = await api.call(svc, 'search', {}, { payer: payer2 })
  assert.equal(payer2.cumulativeOf(svc).toString(), r2.result.charge.cumulative)
  // an unknown reason / 不认识的 reason
  const odd = client({ edit: (env) => { if (!env.ok && env.error.code === 'BAD_VOUCHER') env.error.data.reason = 'weird'; return env } })
  const s3 = await odd.api.resolve(ADDR.container)
  await assert.rejects(odd.api.call(s3, 'search', {}, { payer: odd.api.payer({ consumer, sessionKey: SESSION_KEY }) }), (e) => code('BAD_VOUCHER')(e) && e.data.unknownReason === true)
  await restart('0.0004')
})

test('§3.1: a wallet that returns v of 0 or 1 is rewritten to 27 or 28 before sending', async () => {
  const { api, sent } = client()
  const svc = await api.resolve(ADDR.container)
  const { voucherDigest } = await import('../src/sig.js')
  const payer = api.payer({
    consumer, signTypedData: async (td) => {
      const s = signDigest(voucherDigest(56, td.domain.verifyingContract, { ...td.message, cumulative: BigInt(td.message.cumulative) }), CONSUMER_KEY)
      return s.slice(0, 130) + (parseInt(s.slice(130), 16) - 27).toString(16).padStart(2, '0')
    },
  })
  await payer.setCumulative(svc, await lastOnProvider())
  const r = await api.call(svc, 'search', {}, { payer })
  assert.ok(['1b', '1c'].includes(sent.at(-1).voucher.sig.slice(-2)))
  assert.ok(r.result.charge)
})

test('§4.1 and options: an invalid usdPricing (an unrecognised dollar token) refuses the USD method only; approve can decline; settlementFacts.token is F1', async () => {
  const other = client({ usdPricing: { usdTokens: ['0x' + 'c9'.repeat(20)] } })
  const svc = await other.api.resolve(ADDR.container)
  const payer = other.api.payer({ consumer, sessionKey: SESSION_KEY })
  await assert.rejects(other.api.call(svc, 'search', {}, { payer }), (e) => code('MANIFEST_INVALID')(e) && /search/.test(e.message))
  assert.equal(other.sent.length, 0)
  await payer.setCumulative(svc, await lastOnProvider())
  assert.ok((await other.api.call(svc, 'bem', {}, { payer })).result.charge, 'the BEM-priced method is still paid')
  const asked = []
  const no = client({ usdPricing: { approve: async (x) => { asked.push(x); return false } } })
  const s2 = await no.api.resolve(ADDR.container)
  await assert.rejects(no.api.call(s2, 'search', {}, { payer: no.api.payer({ consumer, sessionKey: SESSION_KEY }) }), code('PAYMENT_DECLINED'))
  assert.equal(asked[0].charge, 2500000000n); assert.equal(asked[0].priceUSD, '0.01'); assert.equal(asked[0].cap, 10000000000n)
  assert.ok(no.sent.every((b) => !b.voucher))
  const f1 = client({ settlementFacts: { token: async () => '0x' + '0e'.repeat(20) } })
  const s3 = await f1.api.resolve(ADDR.container)
  await assert.rejects(f1.api.call(s3, 'search', {}, { payer: f1.api.payer({ consumer, sessionKey: SESSION_KEY }) }), code('UNSUPPORTED_PAYMENT_TOKEN'))
  assert.throws(() => createTapeAPI({ ...BASE, usdPricing: { toleranceBps: 3000 } }), code('INVALID_ARGUMENT'))
})

test('§8.2: concurrent priced calls to one service go one at a time, so a slow first request cannot make the provider sign a combined amount', async () => {
  // a path that holds the FIRST paid request back: had the client stacked both vouchers, the provider would see the
  // higher one first / 把第一个付费请求压住的路径：若客户端叠加两张凭证，提供者会先看到较高的那张
  let firstPaid = true
  const sent = []
  const api = createTapeAPI({
    ...BASE,
    fetch: chain.fetchWith(async (url, init) => {
      if (init?.method === 'POST') {
        const b = JSON.parse(init.body)
        sent.push(b)
        if (b.voucher && firstPaid) { firstPaid = false; await new Promise((r) => setTimeout(r, 300)) }
      }
      return fetch(url, init)
    }),
  })
  const svc = await api.resolve(ADDR.container)
  const payer = api.payer({ consumer, sessionKey: SESSION_KEY })
  const start = await lastOnProvider()
  await payer.setCumulative(svc, start)
  const [a, b] = await Promise.all([api.call(svc, 'search', {}, { payer }), api.call(svc, 'search', {}, { payer })])
  const cums = [a, b].map((r) => BigInt(r.result.charge.cumulative)).sort((x, y) => (x < y ? -1 : 1))
  const c = 2500000000n
  assert.deepEqual(cums, [start + c, start + 2n * c])
  for (const r of [a, b]) assert.equal(r.result.charge.amount.amount, '25.00000000')
  assert.equal(payer.cumulativeOf(svc), start + 2n * c)
  const paid = sent.filter((x) => x.voucher).map((x) => BigInt(x.voucher.cumulative))
  assert.deepEqual(paid, [start + c, start + 2n * c], 'the second voucher was signed after the first answer')
})
