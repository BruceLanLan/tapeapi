// @experimental Findings of the independent review of the payment-voucher implementation (TAPs#52), as tests:
// FIXED M1 (two svc objects / two api instances must not stack in-flight vouchers), M2 (the client caps the charge end to
// end), M3 (quote validity end to end, strict-v resync proof), S1 (an unsigned rate mismatch is "path or provider"),
// S2 (consent to a USD price rise), S3 (probe hints compared), S8 (a halt survives a reread without usdPricing).
// 独立审查的发现写成测试：M1 两个 svc 对象 / 两个 api 实例不得叠加在途凭证；M2 客户端端到端封顶；M3 报价有效性与严格 v 的重同步证明；
// S1 未签名的 rate 不符归为"路径或提供者"；S2 美元价上涨需同意；S3 探测提示比对；S8 重读后去掉 usdPricing 也不绕过停止。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTapeAPI, parseUnits, usdPricing as U, TapeAPIError } from '../src/index.js'
import { privateKeyToAddress, signDigest, delegationDigest, signResponse } from '../src/sig.js'
import { selector } from '../src/abi.js'
import { createProvider, memoryQuoteStore, memoryStore } from '../../server/src/index.js'
import { createFakeChain, ADDR } from './helpers/fake-chain.mjs'
import { installPool } from './helpers/v3-pool.mjs'
import { virtualClock } from './helpers/clock.mjs'

const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32), CONSUMER_KEY = '0x' + '33'.repeat(32), SESSION_KEY = '0x' + '44'.repeat(32)
const holder = privateKeyToAddress(HOLDER_KEY), signer = privateKeyToAddress(SIGNER_KEY), consumer = privateKeyToAddress(CONSUMER_KEY), sessionAddr = privateKeyToAddress(SESSION_KEY)
const RPC = ['http://rpc1', 'http://rpc2', 'http://rpc3']
const POOL = '0x' + 'a1'.repeat(20), USDT = U.DEFAULT_USD_TOKENS[0]
const C = 2500000000n                       // 0.01 USD at 0.0004 USD/BEM / 0.01 美元按 0.0004 换算
const CAP = 10000000000n                    // priceBEM "100"
const nowS = () => Math.floor(Date.now() / 1000)
const code = (c) => (e) => e instanceof TapeAPIError && e.code === c
const CLAIMED_OF = selector('claimedOf')

let chain, provider, manifest, quoteStore, providerRate, meter
const USDP = () => ({ methods: { search: '0.01' }, toleranceBps: 200, maxQuoteS: 120, rateSources: [{ type: 'v3-twap', pool: POOL, usd: USDT, window: 1800 }] })
function buildManifest(usdPricing = USDP()) {
  const expires = nowS() + 300 * 86400
  return {
    tapeapi: '0.1', name: 'USD review', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
    delegation: { expires, sig: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires }), HOLDER_KEY) },
    endpoints: { live: ['http://127.0.0.1:1/tapeapi/v1'], async: false },
    methods: [
      { name: 'search', priceBEM: '100', params: {}, returns: {} },
      { name: 'bem', priceBEM: '0.0001', params: {}, returns: {} },
    ],
    payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 },
    ...(usdPricing ? { usdPricing } : {}),
  }
}
async function startProvider() {
  const p = createProvider({
    manifest, signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: chain.fetch, escrowCacheMs: 0, allowHttp: true, minVoucherLifeS: 0,
    allowMemoryStore: true, quoteStore, store: meter, usdRate: async () => ({ rate: providerRate, asOf: nowS() - 5 }),
    methods: { search: async () => ({ hits: ['a'] }), bem: async () => ({ hits: [] }) },
  })
  const srv = await p.listen(0)
  manifest.endpoints.live = [`http://127.0.0.1:${srv.address().port}/tapeapi/v1`]
  chain.writeFile(ADDR.container, '/.well-known/tapeapi.json', JSON.stringify(manifest))
  return p
}
async function restart(rate, { keepQuotes = false } = {}) {
  await provider.close()
  providerRate = rate
  if (!keepQuotes) quoteStore = memoryQuoteStore()
  provider = await startProvider()
}
const lastOnProvider = async () => BigInt((await provider.store.get(consumer, ADDR.container))?.cumulative ?? '0')
const BASE = { rpcUrls: RPC, quorum: 2, chainId: 56, directory: ADDR.directory, escrow: ADDR.escrow, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, allowHttp: true, conform: false }  // conform: false: 1.x behaviour; 2.0 default is conform: 'tap10'
// A client whose provider traffic goes through `edit` (it re-signs what it changes: a provider fault or a test vector),
// may hold a paid request back (`hold(body)` returns ms), and logs F2 reads and sent bodies in order.
// 提供者流量经过 `edit`（改动后重签）、可压住付费请求（`hold(body)` 返回毫秒）、按顺序记录 F2 读取与发出的请求体的客户端。
function client({ edit, hold, log = [], ...extra } = {}) {
  const sent = []
  const inner = chain.fetchWith(async (url, init) => {
    if (init?.method === 'POST') {
      const b = JSON.parse(init.body)
      sent.push(b); log.push(b.voucher ? `voucher:${b.voucher.cumulative}` : 'probe')
      const ms = hold?.(b); if (ms) await new Promise((r) => setTimeout(r, ms))
    }
    const r = await fetch(url, init)
    if (!edit) return r
    const env = await r.json(), req = JSON.parse(init.body), before = JSON.stringify(env)
    const out = edit(env, req)
    if (JSON.stringify(out) !== before) out.sig = signResponse({ container: out.container, id: out.id, method: req.method, params: req.params ?? {}, ok: out.ok, body: out.ok ? out.result : out.error, ts: out.ts }, SIGNER_KEY)
    return new Response(JSON.stringify(out), { status: r.status, headers: { 'content-type': 'application/json' } })
  })
  const api = createTapeAPI({
    ...BASE, ...extra,
    fetch: (url, init) => {
      if (String(url).startsWith('http://rpc') && typeof init?.body === 'string' && init.body.includes(CLAIMED_OF.slice(2))) log.push('F2')
      return inner(url, init)
    },
  })
  return { api, sent, log }
}

before(async () => {
  chain = createFakeChain()
  chain.setOwner(4246, holder); chain.setAccount(4246, ADDR.container)
  chain.setChannel(consumer, ADDR.container, parseUnits('100000'))
  chain.setSession(consumer, ADDR.container, sessionAddr, 1900000000)
  installPool(chain, { pool: POOL, usd: USDT, rate: 0.0004 })
  quoteStore = memoryQuoteStore()
  meter = memoryStore()
  providerRate = '0.0004'
  manifest = buildManifest()
  provider = await startProvider()
})
after(async () => { await provider.close() })

test('FIXED M1: two svc objects of one container (resolve twice), several concurrent calls, and one payer on two api instances: in-flight vouchers never stack, nothing is paid twice', async () => {
  // the path holds back the first paid request of each round, so a stacked voucher would reach the provider first
  // 路径压住每轮第一个付费请求：叠加的凭证会先到提供者
  let holdNext = false
  const hold = (b) => { if (b.voucher && holdNext) { holdNext = false; return 250 } return 0 }
  const one = client({ hold })
  const svc1 = await one.api.resolve(ADDR.container), svc2 = await one.api.resolve(ADDR.container)
  assert.notEqual(svc1, svc2, 'two objects')
  const payer = one.api.payer({ consumer, sessionKey: SESSION_KEY })
  await payer.setCumulative(svc1, await lastOnProvider())
  await one.api.call(svc1, 'search', {}, { payer })                 // warm the quote / 先拿到报价
  let start = payer.cumulativeOf(svc1)
  holdNext = true
  const N = 4
  const res = await Promise.allSettled(Array.from({ length: N }, (_, i) => one.api.call(i % 2 ? svc2 : svc1, 'search', {}, { payer })))
  for (const r of res) assert.equal(r.status, 'fulfilled', r.reason?.message)
  const cums = res.map((r) => BigInt(r.value.result.charge.cumulative)).sort((a, b) => (a < b ? -1 : 1))
  assert.deepEqual(cums, Array.from({ length: N }, (_, i) => start + BigInt(i + 1) * C))
  for (const r of res) assert.equal(r.value.result.charge.amount.amount, '25.00000000')
  assert.equal(payer.cumulativeOf(svc2), start + BigInt(N) * C)
  assert.equal(await lastOnProvider(), start + BigInt(N) * C, 'the provider holds exactly N charges: nothing paid twice')
  // one payer handed to two api instances / 同一 payer 交给两个 api 实例
  const two = client({ hold })
  const svc3 = await two.api.resolve(ADDR.container)
  start = payer.cumulativeOf(svc1)
  holdNext = true
  const r2 = await Promise.all([one.api.call(svc1, 'search', {}, { payer }), two.api.call(svc3, 'search', {}, { payer }), one.api.call(svc2, 'search', {}, { payer })])
  assert.deepEqual(r2.map((r) => BigInt(r.result.charge.cumulative)).sort((a, b) => (a < b ? -1 : 1)), [start + C, start + 2n * C, start + 3n * C])
  assert.equal(await lastOnProvider(), start + 3n * C)
})

test('FIXED M2: at a rate where the conversion exceeds priceBEM the client signs last + cap, the record says capped, approve sees charge === cap', async () => {
  try {
    await restart('0.00001')                              // 0.01 USD = 1000 BEM, above the cap of 100 / 超过上限 100
    const asked = []
    const c = client({ usdPricing: { reference: async () => 0.00001, approve: async (x) => { asked.push(x); return true } } })
    const svc = await c.api.resolve(ADDR.container)
    const payer = c.api.payer({ consumer, sessionKey: SESSION_KEY })
    const last = await lastOnProvider()
    await payer.setCumulative(svc, last)
    const r = await c.api.call(svc, 'search', {}, { payer })
    assert.equal(c.sent.at(-1).voucher.cumulative, (last + CAP).toString())
    assert.equal(r.result.charge.capped, true); assert.equal(r.result.charge.amount.amount, '100.00000000')
    assert.equal(asked[0].charge, CAP); assert.equal(asked[0].cap, CAP)
  } finally { await restart('0.0004') }
})

test('FIXED M3: a cached quote near its validUntil is not used (a probe first); an expired, a future-dated or an extra-member quote is BAD_QUOTE and no voucher is sent', async () => {
  const clock = virtualClock({ start: Date.now() })
  try {
    await restart('0.0004')
    const c = client()
    const svc = await c.api.resolve(ADDR.container)
    const payer = c.api.payer({ consumer, sessionKey: SESSION_KEY })
    await payer.setCumulative(svc, await lastOnProvider())
    await c.api.call(svc, 'search', {}, { payer })            // probe + paid; the record's quote is cached / 记录里的报价被缓存
    await c.api.call(svc, 'search', {}, { payer })
    const n = c.sent.length
    assert.equal(c.sent[n - 1].voucher !== undefined && c.sent[n - 2].voucher !== undefined, true, 'the cached quote served the second call')
    clock.advance(113_000)                                    // the cached quote is within 3 s of validUntil / 离 validUntil 不到 3 秒
    await c.api.call(svc, 'search', {}, { payer })
    assert.equal(c.sent[n].voucher, undefined, 'a probe first'); assert.ok(c.sent[n + 1].voucher)
    // quotes the client must refuse, each re-signed by the provider's key / 客户端必须拒绝的报价（以提供者钥匙重签）
    for (const [what, mk] of [
      ['expired on arrival', (q, ts) => ({ rate: q.rate, asOf: ts - 200, validUntil: ts - 81 })],
      ['asOf after ts', (q, ts) => ({ ...q, asOf: ts + 1, validUntil: ts + 60 })],
      ['an extra member', (q) => ({ ...q, note: 'x' })],
    ]) {
      const bad = client({ edit: (env) => { if (!env.ok && env.error.code === 'PAYMENT_REQUIRED') env.error.data.quote = mk(env.error.data.quote, env.ts); return env } })
      const s = await bad.api.resolve(ADDR.container)
      await assert.rejects(bad.api.call(s, 'search', {}, { payer: bad.api.payer({ consumer, sessionKey: SESSION_KEY }) }), code('BAD_QUOTE'), what)
      assert.ok(bad.sent.every((b) => !b.voucher), `${what}: no voucher`)
    }
  } finally { clock.restore(); await restart('0.0004') }   // the provider's quotes were dated on the virtual clock / 提供者的报价按虚拟时钟记时
})

test('FIXED M3: a stale proof whose v is 0/1 is not evidence under the draft: no resync, no second voucher', async () => {
  const c = client({ edit: (env) => {
    if (!env.ok && env.error.data?.reason === 'stale' && env.error.data.voucher) { const s = env.error.data.voucher.sig; env.error.data.voucher.sig = s.slice(0, 130) + (parseInt(s.slice(130), 16) - 27).toString(16).padStart(2, '0') }
    return env
  } })
  const svc = await c.api.resolve(ADDR.container)
  const payer = c.api.payer({ consumer, sessionKey: SESSION_KEY })       // starts at 0, behind the provider / 从 0 开始，落后于提供者
  assert.ok(await lastOnProvider() > 0n)
  await assert.rejects(c.api.call(svc, 'search', {}, { payer }), (e) => code('BAD_VOUCHER')(e) && /without proof/.test(e.message))
  assert.equal(c.sent.filter((b) => b.voucher).length, 1)
  assert.equal(payer.cumulativeOf(svc), 0n)
})

test('S1: a record whose rate differs from the voucher (the rate is not signed) is unbound, "path or provider", not a provider fault', async () => {
  const c = client({ edit: (env) => { if (env.ok && env.result?.charge) env.result.charge.rate = '0.00041'; return env } })
  const svc = await c.api.resolve(ADDR.container)
  const payer = c.api.payer({ consumer, sessionKey: SESSION_KEY })
  await payer.setCumulative(svc, await lastOnProvider())
  await assert.rejects(c.api.call(svc, 'search', {}, { payer }), (e) => code('CHARGE_MISMATCH')(e) && e.data.kind === 'unbound' && /cannot tell/.test(e.message))
})

test('S2: a rise of the USD price needs consent (PRICE_CHANGED), given by maxPriceUSD or api.acceptPrice', async () => {
  const c = client()
  const svc = await c.api.resolve(ADDR.container)
  const payer = c.api.payer({ consumer, sessionKey: SESSION_KEY })
  await payer.setCumulative(svc, await lastOnProvider())
  await c.api.call(svc, 'search', {}, { payer })
  try {
    manifest = { ...buildManifest({ ...USDP(), methods: { search: '0.02' } }) }
    await restart('0.0004')
    await c.api.refresh(svc)
    const sentBefore = c.sent.length
    await assert.rejects(c.api.call(svc, 'search', {}, { payer }), (e) => code('PRICE_CHANGED')(e) && e.data.priceUSD === '0.02' && e.data.acceptedUSD === '0.01000000')
    assert.equal(c.sent.length, sentBefore, 'nothing sent')
    const r = await c.api.call(svc, 'search', {}, { payer, maxPriceUSD: '0.02' })
    assert.equal(r.result.charge.price.amount, '0.02000000')
    // a lower price passes silently; a rise again needs consent, which acceptPrice gives / 降价静默；再涨需同意
    manifest = { ...buildManifest({ ...USDP(), methods: { search: '0.03' } }) }
    await restart('0.0004'); await c.api.refresh(svc)
    await assert.rejects(c.api.call(svc, 'search', {}, { payer }), code('PRICE_CHANGED'))
    c.api.acceptPrice(svc, 'search')
    assert.equal((await c.api.call(svc, 'search', {}, { payer })).result.charge.price.amount, '0.03000000')
  } finally {
    manifest = buildManifest(); await restart('0.0004')
  }
})

test('S3: a probe whose price differs from the client\'s own conversion is reported (PAYMENT_HINT_MISMATCH); the client pays its own figure', async () => {
  const warnings = []
  const c = client({ onWarning: (w) => warnings.push(w), edit: (env) => { if (!env.ok && env.error.code === 'PAYMENT_REQUIRED') env.error.data.price = '1'; return env } })
  const svc = await c.api.resolve(ADDR.container)
  const payer = c.api.payer({ consumer, sessionKey: SESSION_KEY })
  const last = await lastOnProvider()
  await payer.setCumulative(svc, last)
  await c.api.call(svc, 'search', {}, { payer })
  assert.ok(warnings.some((w) => w.code === 'PAYMENT_HINT_MISMATCH' && w.stated === '1' && w.computed === C.toString()))
  assert.equal(c.sent.at(-1).voucher.cumulative, (last + C).toString())
})

test('S8: after CHARGE_MISMATCH, a reread that drops usdPricing does not bypass the halt: F2 is read before the next voucher', async () => {
  let tamper = true
  const c = client({ edit: (env) => { if (tamper && env.ok && env.result?.charge) env.result.charge.amount.amount = '30.00000000'; return env } })
  const svc = await c.api.resolve(ADDR.container)
  const payer = c.api.payer({ consumer, sessionKey: SESSION_KEY })
  await payer.setCumulative(svc, await lastOnProvider())
  await assert.rejects(c.api.call(svc, 'search', {}, { payer }), code('CHARGE_MISMATCH'))
  tamper = false
  try {
    chain.writeFile(ADDR.container, '/.well-known/tapeapi.json', JSON.stringify({ ...buildManifest(null), endpoints: manifest.endpoints }))   // usdPricing removed / 去掉 usdPricing
    await c.api.refresh(svc)                                  // the reread (a TTL refresh would do the same) / 重读
    assert.equal(svc.manifest.usdPricing, undefined)
    c.log.length = 0
    await c.api.call(svc, 'bem', {}, { payer })
    const firstVoucher = c.log.findIndex((x) => x.startsWith('voucher:'))
    assert.ok(c.log.indexOf('F2') >= 0 && c.log.indexOf('F2') < firstVoucher, `F2 before the voucher: ${c.log.join(' ')}`)
    assert.equal(svc.manifest.usdPricing, undefined)
  } finally { chain.writeFile(ADDR.container, '/.well-known/tapeapi.json', JSON.stringify(manifest)) }
})

// ---- the focused re-check of the overpayment fix / 多付修复的聚焦复核 ----
const PBEM = 10000n                         // priceBEM "0.0001" of `bem` / `bem` 的价格

test('FIXED P1: a svc resolved before usdPricing (1.8.1 path) and one resolved after, one payer: the 1.8.1 voucher waits for the draft voucher in flight, nothing is paid twice', async () => {
  const log = []
  let kick = null
  // when the draft voucher (it carries `rate`) goes out, hold it and start the 1.8.1 call of the other svc
  // 草稿凭证（带 `rate`）发出时压住它，同时发起另一个 svc 的 1.8.1 调用
  const hold = (b) => { if (b.voucher?.rate && kick) { const k = kick; kick = null; setTimeout(k, 0); return 300 } return 0 }
  const c = client({ hold, log })
  try {
    chain.writeFile(ADDR.container, '/.well-known/tapeapi.json', JSON.stringify({ ...buildManifest(null), endpoints: manifest.endpoints }))
    const svc1 = await c.api.resolve(ADDR.container)
    assert.equal(svc1.manifest.usdPricing, undefined)
    chain.writeFile(ADDR.container, '/.well-known/tapeapi.json', JSON.stringify(manifest))
    const svc2 = await c.api.resolve(ADDR.container)
    assert.ok(svc2.manifest.usdPricing)
    const payer = c.api.payer({ consumer, sessionKey: SESSION_KEY })
    await payer.setCumulative(svc1, await lastOnProvider())
    await c.api.call(svc2, 'search', {}, { payer })          // warm the quote / 先拿报价
    const start = payer.cumulativeOf(svc1)
    const p1 = new Promise((res) => { kick = () => res(c.api.call(svc1, 'bem', {}, { payer })) })
    const r2 = await c.api.call(svc2, 'search', {}, { payer })
    await p1
    assert.equal(r2.result.charge.amount.amount, '25.00000000')
    assert.equal((await lastOnProvider()) - start, C + PBEM, 'exactly the two charges')
    assert.equal(payer.cumulativeOf(svc1), start + C + PBEM)
  } finally { chain.writeFile(ADDR.container, '/.well-known/tapeapi.json', JSON.stringify(manifest)) }
})

test('FIXED S-a: a halt raised through svc1 holds for svc2 of the same container: F2 is read before svc2\'s next voucher', async () => {
  let tamper = true
  const c = client({ edit: (env) => { if (tamper && env.ok && env.result?.charge) env.result.charge.amount.amount = '30.00000000'; return env } })
  const svc1 = await c.api.resolve(ADDR.container), svc2 = await c.api.resolve(ADDR.container)
  assert.notEqual(svc1, svc2)
  const payer = c.api.payer({ consumer, sessionKey: SESSION_KEY })
  await payer.setCumulative(svc1, await lastOnProvider())
  await assert.rejects(c.api.call(svc1, 'search', {}, { payer }), code('CHARGE_MISMATCH'))
  tamper = false
  c.log.length = 0
  await c.api.call(svc2, 'search', {}, { payer })
  const firstVoucher = c.log.findIndex((x) => x.startsWith('voucher:'))
  assert.ok(c.log.indexOf('F2') >= 0 && c.log.indexOf('F2') < firstVoucher, c.log.join(' '))
})

test('FIXED S-d: the halt is also on the payer: another api instance using the same payer reads F2 before its next voucher', async () => {
  let tamper = true
  const one = client({ edit: (env) => { if (tamper && env.ok && env.result?.charge) env.result.charge.amount.amount = '30.00000000'; return env } })
  const two = client()
  const s1 = await one.api.resolve(ADDR.container), s2 = await two.api.resolve(ADDR.container)
  const payer = one.api.payer({ consumer, sessionKey: SESSION_KEY })
  await payer.setCumulative(s1, await lastOnProvider())
  await assert.rejects(one.api.call(s1, 'search', {}, { payer }), code('CHARGE_MISMATCH'))
  tamper = false
  assert.ok(payer.haltOf(s2))
  two.log.length = 0
  await two.api.call(s2, 'search', {}, { payer })
  const firstVoucher = two.log.findIndex((x) => x.startsWith('voucher:'))
  assert.ok(two.log.indexOf('F2') >= 0 && two.log.indexOf('F2') < firstVoucher, two.log.join(' '))
  assert.equal(payer.haltOf(s2), null, 'cleared after the reread and the F2 read')
})

test('FIXED S-b: a released draft lease wakes the next draft reserve, which signs on the committed figure; a reserve that waits too long is PAYMENT_BUSY', async () => {
  const c = client()
  const svc = await c.api.resolve(ADDR.container)
  const payer = c.api.payer({ consumer, sessionKey: SESSION_KEY })
  await payer.setCumulative(svc, 1000n)
  const a = await payer.reserve(svc, 10n, { rate: '0.0004' })
  let bDone = false
  const b = payer.reserve(svc, 10n, { rate: '0.0004' }).then((l) => { bDone = true; return l })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(bDone, false, 'waits while a is in flight')
  a.release()
  const lb = await b
  assert.equal(lb.next, 1010n, 'signed on the committed figure, not stacked on the released one')
  assert.equal(lb.voucher.rate, '0.0004')
  const busy = payer.reserve(svc, 10n, { rate: '0.0004', waitMs: 40 })
  await assert.rejects(busy, code('PAYMENT_BUSY'))
  lb.commit()
  const lc = await payer.reserve(svc, 10n, { rate: '0.0004', waitMs: 40 })
  assert.equal(lc.next, 1020n); lc.release()
  // a 1.8.1 reserve still stacks on a 1.8.1 lease (unchanged), and waits only for a draft one / 1.8.1 预留仍叠加，只等草稿凭证
  const x = await payer.reserve(svc, 10n), y = await payer.reserve(svc, 10n)
  assert.deepEqual([x.next, y.next], [1020n, 1030n]); x.release(); y.release()
})

test('FIXED S-f: a quote carried by another signed error code is not taken; the next call does not use it', async () => {
  let inject = true
  const c = client({ edit: (env) => {
    if (inject && env.ok && env.result?.charge) { inject = false; return { ...env, ok: false, result: undefined, error: { code: 'INTERNAL', message: 'x', data: { quote: { rate: '0.0005', asOf: env.ts - 1, validUntil: env.ts + 118 } } } } }
    return env
  } })
  const svc = await c.api.resolve(ADDR.container)
  const payer = c.api.payer({ consumer, sessionKey: SESSION_KEY })
  await payer.setCumulative(svc, await lastOnProvider())
  await assert.rejects(c.api.call(svc, 'search', {}, { payer }), code('INTERNAL'))
  await payer.setCumulative(svc, await lastOnProvider())
  const from = c.sent.length
  await c.api.call(svc, 'search', {}, { payer })
  assert.ok(c.sent.slice(from).every((x) => x.voucher?.rate !== '0.0005'), 'no voucher named the injected rate')
})

// ---- final re-check / 终轮复核 ----
test('FIXED (final re-check 3): a provider that fails the charge check again right after a reread gets PAYMENT_HALTED, without another reread, chain read or request', async () => {
  const c = client({ edit: (env) => { if (env.ok && env.result?.charge) env.result.charge.amount.amount = '30.00000000'; return env } })
  const svc = await c.api.resolve(ADDR.container)
  const payer = c.api.payer({ consumer, sessionKey: SESSION_KEY })
  await payer.setCumulative(svc, await lastOnProvider())
  await assert.rejects(c.api.call(svc, 'search', {}, { payer }), code('CHARGE_MISMATCH'))
  await assert.rejects(c.api.call(svc, 'search', {}, { payer }), code('CHARGE_MISMATCH'))   // unhalted once, failed again
  c.log.length = 0
  const sent = c.sent.length
  await assert.rejects(c.api.call(svc, 'search', {}, { payer }), (e) => code('PAYMENT_HALTED')(e) && e.data.retryAfterS > 0)
  assert.equal(c.sent.length, sent, 'no request'); assert.ok(!c.log.includes('F2'), 'no chain read')
})

test('FIXED (final re-check 1/2): a 1.8.1 reserve waiting for a draft voucher times out as PAYMENT_BUSY with a neutral message', async () => {
  const c = client()
  const svc = await c.api.resolve(ADDR.container)
  const payer = c.api.payer({ consumer, sessionKey: SESSION_KEY })
  await payer.setCumulative(svc, 1000n)
  const a = await payer.reserve(svc, 10n, { rate: '0.0004' })
  await assert.rejects(payer.reserve(svc, 10n, { waitMs: 40 }), (e) => code('PAYMENT_BUSY')(e) && !/draft/i.test(e.message))
  a.release()
  const b = await payer.reserve(svc, 10n, { waitMs: 40 }); assert.equal(b.next, 1010n); b.release()
})
