// Differential test for the experimental USD pricing (TAP draft "Payment Vouchers", PR TapeOutProtocol/TAPs#52): a
// manifest WITHOUT `usdPricing` must behave exactly as 1.8.1 did. The fixture was recorded from the code at 3ca5fac (the
// 1.8.1 payment code, before any USD pricing) with RECORD_GOLDEN=1; every later run compares byte for byte: the status,
// the whole signed envelope (body, ts, sig) on the provider side, and on the client side every request body the SDK sent
// (vouchers included), every value it returned and every error it threw.
// 实验性美元计价的差分测试：不带 `usdPricing` 的清单必须与 1.8.1 逐字节相同。夹具在 3ca5fac（加美元计价之前的 1.8.1 付费代码）
// 上以 RECORD_GOLDEN=1 录制；之后每次运行逐字节比较：提供者侧的状态码与整个签名信封，客户端侧 SDK 发出的每个请求体（含凭证）、
// 返回的每个值与抛出的每个错误。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createProvider } from '../src/index.js'
import { createTapeAPI, sig, parseUnits, TapeAPIError, canonicalJSON } from '@tapeapi/sdk'
import { createFakeChain, ADDR } from '../../sdk/test/helpers/fake-chain.mjs'
import { virtualClock } from '../../sdk/test/helpers/clock.mjs'

const { privateKeyToAddress, signDigest, voucherDigest, delegationDigest } = sig
const FIXTURE = new URL('./fixtures/payment-golden-1.8.1.json', import.meta.url)
const RECORD = process.env.RECORD_GOLDEN === '1'
const T0 = 1_789_000_000
const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32), CONSUMER_KEY = '0x' + '33'.repeat(32), SESSION_KEY = '0x' + '44'.repeat(32), STRANGER_KEY = '0x' + '55'.repeat(32)
const holder = privateKeyToAddress(HOLDER_KEY), signer = privateKeyToAddress(SIGNER_KEY), consumer = privateKeyToAddress(CONSUMER_KEY), sessionAddr = privateKeyToAddress(SESSION_KEY)
const PRICE = parseUnits('0.0001')
const RPC = ['http://rpc1', 'http://rpc2', 'http://rpc3']

function manifestFor(endpoint) {
  const expires = T0 + 300 * 86400
  return {
    tapeapi: '0.1', name: 'Golden', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
    delegation: { expires, sig: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires }), HOLDER_KEY) },
    endpoints: { live: [endpoint], async: false },
    methods: [
      { name: 'free', priceBEM: '0', params: {}, returns: {} },
      { name: 'paid', priceBEM: '0.0001', params: {}, returns: {} },
      { name: 'paidString', priceBEM: '0.0001', params: {}, returns: {} },
      { name: 'paidCharge', priceBEM: '0.0001', params: {}, returns: {} },
      { name: 'paidBoom', priceBEM: '0.0001', params: {}, returns: {} },
    ],
    payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 },
  }
}
const handlers = {
  free: async (_p, ctx) => ({ block: ctx.block }),
  paid: async (_p, ctx) => ({ consumer: ctx.consumer, cumulative: ctx.cumulative.toString() }),
  paidString: async () => 'a plain string result',
  paidCharge: async () => ({ charge: 'the method uses this name itself' }),
  paidBoom: async () => { throw new Error('upstream failed') },
}
const voucher = (cumulative, { key = SESSION_KEY, expires = T0 + 3600, provider = ADDR.container, vByte } = {}) => {
  const v = { consumer, provider, cumulative: String(cumulative), expires }
  let s = signDigest(voucherDigest(56, ADDR.escrow, v), key)
  if (vByte === 'v01') s = s.slice(0, 130) + (parseInt(s.slice(130), 16) - 27).toString(16).padStart(2, '0')
  return { ...v, sig: s, signer: privateKeyToAddress(key) }
}

function freshChain() {
  const chain = createFakeChain()
  chain.setOwner(4246, holder); chain.setAccount(4246, ADDR.container)
  chain.register({ label: 'golden', container: ADDR.container, tokenId: 4246 })
  chain.setChannel(consumer, ADDR.container, parseUnits('0.001'))
  chain.setSession(consumer, ADDR.container, sessionAddr, 1900000000)
  chain.setContribution(ADDR.container, 100)
  return chain
}

// Provider side: invoke() directly, no HTTP, so nothing but the code under test decides the answer.
// 提供者侧：直接调用 invoke()，不经 HTTP，答案只由被测代码决定。
async function providerScenarios() {
  const out = []
  const clock = virtualClock({ start: T0 * 1000 })
  try {
    const chain = freshChain()
    const manifest = manifestFor('http://127.0.0.1:1/tapeapi/v1')
    const p = createProvider({ manifest, signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: chain.fetch, escrowCacheMs: 0, allowHttp: true, minVoucherLifeS: 0, allowMemoryStore: true, methods: handlers })
    const strict = createProvider({ manifest, signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: chain.fetch, escrowCacheMs: 0, allowHttp: true, minVoucherLifeS: 600, allowMemoryStore: true, methods: handlers })
    const run = async (name, prov, body) => {
      const r = await prov.invoke(body, { ip: '10.0.0.1' })
      out.push({ name, status: r.status ?? null, paid: r.paid ?? null, env: r.env ?? null, rateLimited: r.rateLimited ?? null })
    }
    const P1 = PRICE, P2 = 2n * PRICE, P3 = 3n * PRICE, P4 = 4n * PRICE, P5 = 5n * PRICE
    await run('free call', p, { id: 'g1', method: 'free', params: {} })
    await run('priced call without a voucher', p, { id: 'g2', method: 'paid', params: {} })
    await run('first voucher, session key', p, { id: 'g3', method: 'paid', params: {}, voucher: voucher(P1) })
    await run('the same cumulative again: stale', p, { id: 'g4', method: 'paid', params: {}, voucher: voucher(P1) })
    await run('insufficient: one base unit short', p, { id: 'g5', method: 'paid', params: {}, voucher: voucher(P2 - 1n) })
    await run('expired voucher', p, { id: 'g6', method: 'paid', params: {}, voucher: voucher(P2, { expires: T0 - 1 }) })
    await run('short lifetime under minVoucherLifeS 600', strict, { id: 'g7', method: 'paid', params: {}, voucher: voucher(P2, { expires: T0 + 60 }) })
    await run('signed by a key that is not authorised', p, { id: 'g8', method: 'paid', params: {}, voucher: voucher(P2, { key: STRANGER_KEY }) })
    await run('v written as 0/1 (accepted by 1.8.1)', p, { id: 'g9', method: 'paid', params: {}, voucher: voucher(P2, { vByte: 'v01' }) })
    await run('v written as 0/1 again, next figure', p, { id: 'g9b', method: 'paid', params: {}, voucher: voucher(P3, { vByte: 'v01' }) })
    await run('voucher for another provider', p, { id: 'g10', method: 'paid', params: {}, voucher: voucher(P4, { provider: '0x' + '61'.repeat(20) }) })
    await run('cumulative with a leading zero (accepted by 1.8.1)', p, { id: 'g11', method: 'paid', params: {}, voucher: { ...voucher(P4), cumulative: '0' + P4.toString() } })
    await run('over the channel', p, { id: 'g12', method: 'paid', params: {}, voucher: voucher(parseUnits('0.01')) })
    await run('the consumer signs itself', p, { id: 'g13', method: 'paid', params: {}, voucher: voucher(P5, { key: CONSUMER_KEY }) })
    await run('a priced result that is not an object', p, { id: 'g14', method: 'paidString', params: {}, voucher: voucher(6n * PRICE) })
    await run('a priced result with its own member "charge"', p, { id: 'g15', method: 'paidCharge', params: {}, voucher: voucher(7n * PRICE) })
    await run('signer member that does not match', p, { id: 'g16', method: 'paid', params: {}, voucher: { ...voucher(8n * PRICE), signer: '0x' + '77'.repeat(20) } })
    await run('handler throws: INTERNAL, nothing charged', p, { id: 'g17', method: 'paidBoom', params: {}, voucher: voucher(8n * PRICE) })
    await run('the same voucher again after INTERNAL is accepted', p, { id: 'g18', method: 'paid', params: {}, voucher: voucher(8n * PRICE) })
    await run('malformed voucher (not an object)', p, { id: 'g19', method: 'paid', params: {}, voucher: 'nope' })
    await run('malformed cumulative', p, { id: 'g20', method: 'paid', params: {}, voucher: { ...voucher(9n * PRICE), cumulative: '1e9' } })
    out.push({ name: 'store after the run', store: await p.store.all() })
  } finally { clock.restore() }
  return out
}

// Client side: the SDK against the real provider over HTTP, with every request body captured.
// 客户端侧：SDK 经 HTTP 调用真实提供者，记录每个请求体。
async function clientScenarios() {
  const out = []
  const clock = virtualClock({ start: T0 * 1000 })
  let p
  try {
    const chain = freshChain()
    const manifest = manifestFor('http://127.0.0.1:1/tapeapi/v1')
    p = createProvider({ manifest, signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: chain.fetch, escrowCacheMs: 0, allowHttp: true, minVoucherLifeS: 0, allowMemoryStore: true, methods: handlers })
    const srv = await p.listen(0)
    manifest.endpoints.live = [`http://127.0.0.1:${srv.address().port}/tapeapi/v1`]
    chain.writeFile(ADDR.container, '/.well-known/tapeapi.json', JSON.stringify(manifest))
    const sent = []
    const api = createTapeAPI({
      rpcUrls: RPC, quorum: 2, chainId: 56, directory: ADDR.directory, escrow: ADDR.escrow, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, allowHttp: true,
      conform: false, // 1.x behaviour; 2.0 default is conform: 'tap10'
      fetch: chain.fetchWith(async (url, init) => { if (init?.method === 'POST') sent.push({ url: String(url).replace(/:\d+\//, ':PORT/'), body: JSON.parse(init.body) }); return fetch(url, init) }),
    })
    const svc = await api.resolve(ADDR.container)
    const payer = api.payer({ consumer, sessionKey: SESSION_KEY, sessionExpiry: 1900000000 })
    const call = async (name, method, opts) => {
      const from = sent.length
      let value = null, error = null
      try { value = await api.call(svc, method, {}, { payer, ...opts }) } catch (e) { error = e instanceof TapeAPIError ? { code: e.code, message: e.message, data: e.data ?? null, signed: e.signed ?? null } : { thrown: String(e) } }
      out.push({ name, sent: sent.slice(from), value, error, committed: payer.cumulativeOf(svc).toString(), inflight: payer.inflightOf(svc) })
    }
    await call('free call', 'free', { id: 'c1' })
    await call('first priced call', 'paid', { id: 'c2' })
    await call('second priced call', 'paid', { id: 'c3' })
    await call('a priced result that is not an object', 'paidString', { id: 'c4' })
    await call('a priced result with its own member "charge"', 'paidCharge', { id: 'c5' })
    await call('handler throws', 'paidBoom', { id: 'c6' })
    await call('after the failure the counter is unchanged', 'paid', { id: 'c7' })
    // the provider's meter runs ahead of this payer: stale, resynced with the proof voucher, retried once
    // 提供者的计量领先于这个 payer：stale，用证明凭证重新同步后重试一次
    const payer2 = api.payer({ consumer, sessionKey: SESSION_KEY, sessionExpiry: 1900000000 })
    const from = sent.length
    let value = null, error = null
    try { value = await api.call(svc, 'paid', {}, { payer: payer2, id: 'c8' }) } catch (e) { error = { code: e.code, message: e.message, data: e.data ?? null } }
    out.push({ name: 'a second payer resyncs from the signed stale answer', sent: sent.slice(from), value, error, committed: payer2.cumulativeOf(svc).toString() })
  } finally { clock.restore(); if (p) await p.close() }
  return out
}

test('GOLDEN: a manifest without usdPricing behaves exactly as 1.8.1 (provider envelopes and SDK requests, byte for byte)', async () => {
  const got = JSON.parse(canonicalJSON({ provider: await providerScenarios(), client: await clientScenarios() }))
  if (RECORD) {
    mkdirSync(new URL('./fixtures/', import.meta.url), { recursive: true })
    writeFileSync(FIXTURE, JSON.stringify(got, null, 1) + '\n')
    return
  }
  assert.ok(existsSync(FIXTURE), 'fixture missing: record it with RECORD_GOLDEN=1 on the 1.8.1 code')
  const want = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  assert.equal(got.provider.length, want.provider.length)
  for (let i = 0; i < want.provider.length; i++) assert.deepEqual(got.provider[i], want.provider[i], `provider scenario ${want.provider[i].name}`)
  assert.equal(got.client.length, want.client.length)
  for (let i = 0; i < want.client.length; i++) assert.deepEqual(got.client[i], want.client[i], `client scenario ${want.client[i].name}`)
  assert.equal(canonicalJSON(got), canonicalJSON(want))
})
