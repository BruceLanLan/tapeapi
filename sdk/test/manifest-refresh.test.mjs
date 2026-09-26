// 提供者改价后，持旧清单的消费者还能不能用。扩展性审查 2026-09-21 发现这里是永久死锁。
// Can a consumer holding an older manifest survive a price change? The extensibility audit of 2026-09-21 found
// a permanent deadlock here: `resync` no-ops whenever the provider's lastCumulative is not ahead of ours, which
// is exactly the case after a price RISE, so the retry re-signed the same stale price for ever.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTapeAPI, TapeAPIError, parseUnits, MANIFEST_KEY } from '../src/index.js'
import { privateKeyToAddress, signDigest, delegationDigest } from '../src/sig.js'
import { createProvider } from '../../server/src/index.js'
import { createFakeChain, ADDR } from './helpers/fake-chain.mjs'

const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32)
const CONSUMER_KEY = '0x' + '33'.repeat(32), SESSION_KEY = '0x' + '44'.repeat(32)
const CONSUMER2_KEY = '0x' + '55'.repeat(32), SESSION2_KEY = '0x' + '66'.repeat(32)
const holder = privateKeyToAddress(HOLDER_KEY), signer = privateKeyToAddress(SIGNER_KEY)
const consumer = privateKeyToAddress(CONSUMER_KEY), sessionAddr = privateKeyToAddress(SESSION_KEY)
const consumer2 = privateKeyToAddress(CONSUMER2_KEY), session2Addr = privateKeyToAddress(SESSION2_KEY)
const RPC = ['http://rpc1', 'http://rpc2']
const EXPIRES = Math.floor(Date.now() / 1000) + 300 * 86400
const CHEAP = '0.0001', DEAR = '0.005'

let chain, provider, srv, api, port

const manifestAt = (priceBEM, endpoints, signer = privateKeyToAddress(SIGNER_KEY)) => ({
  tapeapi: '0.1', name: 'Priced Reader', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
  delegation: { expires: EXPIRES, sig: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires: EXPIRES }), HOLDER_KEY) },
  endpoints: { live: endpoints, async: false },
  methods: [{ name: 'quote', priceBEM, params: {}, returns: { v: 'number' } }],
  payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 },
})
const publish = (m) => chain.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify(m))

before(async () => {
  chain = createFakeChain()
  chain.setOwner(4246, holder); chain.setAccount(4246, ADDR.container)
  chain.setChannel(consumer, ADDR.container, parseUnits('10'))
  chain.setSession(consumer, ADDR.container, sessionAddr, 1900000000)
  chain.setChannel(consumer2, ADDR.container, parseUnits('10'))
  chain.setSession(consumer2, ADDR.container, session2Addr, 1900000000)
  provider = createProvider({
    minVoucherLifeS: 0, manifest: manifestAt(CHEAP, ['http://127.0.0.1:1/tapeapi/v1']), signerKey: SIGNER_KEY,
    rpcUrls: RPC, quorum: 2, chainId: 56, fetch: chain.fetch, allowHttp: true, escrowCacheMs: 0, log: () => {},
    methods: { quote: async () => ({ v: 1 }) },
  })
  srv = await provider.listen(0)
  port = srv.address().port
  const url = `http://127.0.0.1:${port}/tapeapi/v1`
  provider.manifest.endpoints.live = [url]
  publish(manifestAt(CHEAP, [url]))
  api = createTapeAPI({ rpcUrls: RPC, quorum: 2, chainId: 56, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, escrow: ADDR.escrow, allowHttp: true, fetch: chain.fetchWith() })
})
after(() => srv?.close())

test('a price RISE does not deadlock a consumer holding the old manifest', async () => {
  const svc = await api.resolve(ADDR.container)
  const payer = api.payer({ consumer, sessionKey: SESSION_KEY })
  assert.equal(svc.manifest.methods[0].priceBEM, CHEAP)
  await api.call(svc, 'quote', {}, { payer })          // pays the cheap price / 按旧价付
  const afterFirst = payer.cumulativeOf(svc)
  assert.equal(afterFirst, parseUnits(CHEAP))

  // The holder republishes at 50x and the provider starts charging it. The consumer still holds the old manifest.
  // 持有人把价格提到 50 倍并重新发布，提供者开始按新价收费；消费者手里还是旧清单。
  const url = svc.manifest.endpoints.live[0]
  await new Promise((r) => srv.close(r))
  provider = createProvider({
    minVoucherLifeS: 0, manifest: manifestAt(DEAR, [url]), signerKey: SIGNER_KEY,
    rpcUrls: RPC, quorum: 2, chainId: 56, fetch: chain.fetch, allowHttp: true, escrowCacheMs: 0, log: () => {},
    methods: { quote: async () => ({ v: 1 }) },
  })
  srv = await provider.listen(port)
  publish(manifestAt(DEAR, [url]))

  // Before the first fix this threw BAD_VOUCHER for ever. Now the client learns the new price from the chain and
  // refuses to pay it without consent (runtime audit F-08); with consent it pays, exactly once.
  // 第一版修复之前这里会永远抛 BAD_VOUCHER。现在客户端从链上得知新价格，未经同意拒绝支付；同意后恰好付一次。
  await assert.rejects(api.call(svc, 'quote', {}, { payer }), (e) => e.code === 'PRICE_CHANGED')
  assert.equal(svc.manifest.methods[0].priceBEM, DEAR, 'the cached manifest was re-read from the chain')
  api.acceptPrice(svc, 'quote')
  const r = await api.call(svc, 'quote', {}, { payer })
  assert.equal(r.verified, true)
  assert.equal(svc.manifest.methods[0].priceBEM, DEAR, 'the cached manifest was re-read from the chain')
  assert.equal(payer.cumulativeOf(svc), afterFirst + parseUnits(DEAR), 'and the new price was paid, exactly once')
  // a third call at the new price still works / 第三次调用照常
  await api.call(svc, 'quote', {}, { payer })
  assert.equal(payer.cumulativeOf(svc), afterFirst + 2n * parseUnits(DEAR))
})

test('the provider cannot invent a price: the chain is the authority', async () => {
  const svc = await api.resolve(ADDR.container)
  const payer = api.payer({ consumer, sessionKey: SESSION_KEY })
  const onChain = svc.manifest.methods[0].priceBEM
  // A hostile provider quotes an enormous price in its rejection. The client must re-read the chain and pay
  // what the holder actually published, not what the provider asked for.
  // 恶意提供者在拒绝里报一个天价。客户端必须重读链上清单，按持有人真正发布的价格付，而不是它要的价。
  const signedAmounts = []
  const greedy = createTapeAPI({
    rpcUrls: RPC, quorum: 2, chainId: 56, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, escrow: ADDR.escrow, allowHttp: true,
    fetch: chain.fetchWith(async (url, init) => {
      try { const b = JSON.parse(init.body); if (b?.voucher?.cumulative) signedAmounts.push(BigInt(b.voucher.cumulative)) } catch { /* not a call */ }
      const res = await fetch(url, init); const j = await res.json()
      if (j.ok === true) {
        const lie = { ...j, ok: false, error: { code: 'BAD_VOUCHER', message: 'pay more', data: { lastCumulative: '0', onChainClaimed: '0', price: parseUnits('9999').toString() } } }
        return new Response(JSON.stringify(lie), { status: 402, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify(j), { status: res.status, headers: { 'content-type': 'application/json' } })
    }),
  })
  const svc2 = await greedy.resolve(ADDR.container)
  const payer2 = greedy.payer({ consumer, sessionKey: SESSION_KEY })
  await assert.rejects(greedy.call(svc2, 'quote', {}, { payer: payer2 }), (e) => e instanceof TapeAPIError)
  assert.equal(svc2.manifest.methods[0].priceBEM, onChain, 'the quoted price never becomes the manifest price')
  // Every voucher this client signed must be a multiple of the on-chain price, never the invented one.
  // 这个客户端签出的每一张凭证都必须是链上价格的倍数，绝不会是被编造的那个价。
  const invented = parseUnits('9999')
  assert.ok(signedAmounts.length > 0, 'the attempt really was made')
  for (const v of signedAmounts) assert.ok(v < invented, `signed ${v}, which is the invented price`)
  assert.equal(payer.cumulativeOf(svc) % parseUnits(onChain), 0n, 'the honest payer is untouched')
})

test('refresh() re-reads in place, and refuses to turn into a different service', async () => {
  const svc = await api.resolve(ADDR.container)
  const url = svc.manifest.endpoints.live[0]
  publish(manifestAt('0.25', [url]))
  await api.refresh(svc)
  assert.equal(svc.manifest.methods[0].priceBEM, '0.25')
  assert.equal(svc.container, ADDR.container)
  publish(manifestAt(DEAR, [url]))                 // put it back for the other tests / 还原
  await api.refresh(svc)
  await assert.rejects(api.refresh({ manifest: svc.manifest, container: svc.container, verified: svc.verified }),
    (e) => e.code === 'MANIFEST_INVALID' && /no target/.test(e.message))
})

test('a dead first endpoint fails over to the next one', async () => {
  const svc = await api.resolve(ADDR.container)
  const live = svc.manifest.endpoints.live[0]
  // port 1 is closed on every platform / 1 端口在任何平台都不会有人监听
  svc.manifest.endpoints.live = ['http://127.0.0.1:1/tapeapi/v1', live]
  const payer = api.payer({ consumer: consumer2, sessionKey: SESSION2_KEY })
  const r = await api.call(svc, 'quote', {}, { payer, manifestTtlMs: 0 })
  assert.equal(r.verified, true, 'the second endpoint served it')
  // all endpoints dead -> one clear error naming how many were tried / 全挂时报清楚试了几个
  svc.manifest.endpoints.live = ['http://127.0.0.1:1/tapeapi/v1', 'http://127.0.0.1:2/tapeapi/v1']
  await assert.rejects(api.call(svc, 'quote', {}, { payer, manifestTtlMs: 0 }),
    (e) => e.code === 'PROVIDER_UNAVAILABLE' && /all 2 endpoint/.test(e.message))
  svc.manifest.endpoints.live = [live]
})

// Restart the provider on the same port with a new price and/or signer, and publish the matching manifest.
// 在同一端口用新价格和/或新签名密钥重启提供者，并发布对应清单。
async function restart(priceBEM, signerKey = SIGNER_KEY) {
  const url = `http://127.0.0.1:${port}/tapeapi/v1`
  srv.closeAllConnections?.()   // drop keep-alive sockets, or the next fetch lands on a dead one / 断开保活连接
  await new Promise((r) => srv.close(r))
  await new Promise((r) => setTimeout(r, 50))   // let the client pool see the FIN / 让客户端连接池看到 FIN
  const m = manifestAt(priceBEM, [url], privateKeyToAddress(signerKey))
  provider = createProvider({
    minVoucherLifeS: 0, manifest: m, signerKey,
    rpcUrls: RPC, quorum: 2, chainId: 56, fetch: chain.fetch, allowHttp: true, escrowCacheMs: 0, log: () => {},
    methods: { quote: async () => ({ v: 1 }) },
  })
  srv = await provider.listen(port)
  publish(manifestAt(priceBEM, [url], privateKeyToAddress(signerKey)))
}

test('a method that goes from free to priced heals: PAYMENT_REQUIRED -> re-read -> consent gate (traceability D5)', async () => {
  await restart('0')
  const svc = await api.resolve(ADDR.container)
  await api.call(svc, 'quote', {})                       // free, no payer / 免费，不需要 payer
  await restart(CHEAP)
  // The consumer's copy says free, so it sends no voucher; the provider's PAYMENT_REQUIRED carries data.price.
  // Before the fix the SDK threw it and re-read nothing until the 1-hour TTL.
  // 消费者手里的清单说免费，所以不带凭证；提供者的 PAYMENT_REQUIRED 带 data.price。修复前 SDK 直接抛出，一小时内不重读。
  await assert.rejects(api.call(svc, 'quote', {}), (e) => e.code === 'PRICE_CHANGED')
  assert.equal(svc.manifest.methods[0].priceBEM, CHEAP, 're-read from the chain')
  api.acceptPrice(svc, 'quote')
  await assert.rejects(api.call(svc, 'quote', {}), (e) => e.code === 'PAYMENT_REQUIRED' && /pass \{ payer \}/.test(e.message))
  const payer = api.payer({ consumer: consumer2, sessionKey: SESSION2_KEY })
  assert.equal((await api.call(svc, 'quote', {}, { payer })).verified, true)
})

test('a signer rotation heals in one call: the chain confirms the new key and the same envelope is kept, billed once (D8)', async () => {
  await restart(CHEAP)
  const svc = await api.resolve(ADDR.container)
  const payer = api.payer({ consumer: consumer2, sessionKey: SESSION2_KEY })
  await api.call(svc, 'quote', {}, { payer, manifestTtlMs: 0 })
  const NEW_KEY = '0x' + '77'.repeat(32)
  await restart(CHEAP, NEW_KEY)
  const before = payer.cumulativeOf(svc)
  const r = await api.call(svc, 'quote', {}, { payer, manifestTtlMs: 0 })
  assert.equal(r.verified, true)
  assert.equal(svc.manifest.signer, privateKeyToAddress(NEW_KEY))
  assert.equal(payer.cumulativeOf(svc), before + parseUnits(CHEAP), 'one call, one price')
  // A wrong signer that the chain does NOT confirm is still BAD_SIGNATURE, and costs at most one re-read.
  // 链上并未确认的错误签名者仍然是 BAD_SIGNATURE，且最多换来一次重读。
  const svc2 = await api.resolve(ADDR.container)
  await restart(CHEAP, SIGNER_KEY)
  publish(manifestAt(CHEAP, svc2.manifest.endpoints.live, privateKeyToAddress(NEW_KEY)))   // chain still says NEW / 链上仍是 NEW
  await assert.rejects(api.call(svc2, 'quote', {}, { payer, manifestTtlMs: 0 }), (e) => e.code === 'BAD_SIGNATURE')
  await restart(CHEAP)   // restore / 还原
})

test('unsigned JSON (a CDN error page, an unsigned 404) is PROVIDER_UNAVAILABLE, not BAD_SIGNATURE (D9)', async () => {
  const cdn = createTapeAPI({
    rpcUrls: RPC, quorum: 2, chainId: 56, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, escrow: ADDR.escrow, allowHttp: true,
    fetch: chain.fetchWith(async () => new Response(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'no such route' } }), { status: 404, headers: { 'content-type': 'application/json' } })),
  })
  const svc = await cdn.resolve(ADDR.container)
  const payer = cdn.payer({ consumer: consumer2, sessionKey: SESSION2_KEY })
  await assert.rejects(cdn.call(svc, 'quote', {}, { payer, manifestTtlMs: 0 }), (e) => e.code === 'PROVIDER_UNAVAILABLE' && e.httpStatus === 404)
})

test('TAP-21 §3.2: an oversize request is a signed BAD_REQUEST bound to id "" and reported as the caller error, not BAD_SIGNATURE (D21)', async () => {
  await restart('0')
  const svc = await api.resolve(ADDR.container)
  // 70 KB of params: over the provider's 64 KiB body limit, so it answers 413 signed over id "" and params {}
  // 70 KB 参数：超过提供者 64 KiB 的请求体上限，于是它以绑定 id "" 与 params {} 的签名回 413
  await assert.rejects(api.call(svc, 'quote', { blob: 'x'.repeat(70_000) }, { manifestTtlMs: 0 }),
    (e) => e.code === 'BAD_REQUEST' && e.signed === true && e.httpStatus === 413)
  // params that have no canonical form are refused locally, before any request / 非规范参数在本地、发请求前拒绝
  await assert.rejects(api.call(svc, 'quote', { n: 2 ** 60 }, { manifestTtlMs: 0 }), (e) => e.code === 'BAD_REQUEST' && /canonical/.test(e.message) && e.signed === undefined)
  await restart(CHEAP)
})
