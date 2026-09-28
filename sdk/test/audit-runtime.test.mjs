// Adversarial audit of the SDK's stale-manifest recovery and endpoint failover (docs/AUDIT-runtime-2.md).
// Tests named F-xx DEMONSTRATE a weakness (they pass while it exists); tests named P-xx confirm a property holds.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTapeAPI, parseUnits, MANIFEST_KEY } from '../src/index.js'
import { privateKeyToAddress, signDigest, delegationDigest } from '../src/sig.js'
import { createProvider } from '../../server/src/index.js'
import { createFakeChain, ADDR } from './helpers/fake-chain.mjs'

const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32)
const CONSUMER_KEY = '0x' + '33'.repeat(32), SESSION_KEY = '0x' + '44'.repeat(32)
const holder = privateKeyToAddress(HOLDER_KEY), signer = privateKeyToAddress(SIGNER_KEY)
const consumer = privateKeyToAddress(CONSUMER_KEY), sessionAddr = privateKeyToAddress(SESSION_KEY)
const RPC = ['http://rpc1', 'http://rpc2']
const EXPIRES = Math.floor(Date.now() / 1000) + 300 * 86400
const CONTAINER_B = '0x' + '61'.repeat(20)

const manifestAt = (priceBEM, endpoints, { container = ADDR.container, tokenId = '4246', methods } = {}) => ({
  tapeapi: '0.1', name: 'Audit', circuits: ADDR.circuits, tokenId, container, signer,
  delegation: { expires: EXPIRES, sig: signDigest(delegationDigest(56, ADDR.hub, { container, signer, expires: EXPIRES }), HOLDER_KEY) },
  endpoints: { live: endpoints, async: false },
  methods: methods || [{ name: 'quote', priceBEM, params: {}, returns: {} }],
  payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 },
})

// A client-side chain (manifests, holder) and a separate provider-side chain (channels), so RPC counts are the client's own.
async function world({ providerPrice, chainPrice, handler = async () => ({ v: 1 }) }) {
  const cc = createFakeChain()
  cc.setOwner(4246, holder); cc.setAccount(4246, ADDR.container)
  const pc = createFakeChain()
  pc.setChannel(consumer, ADDR.container, parseUnits('100'))
  pc.setSession(consumer, ADDR.container, sessionAddr, 1900000000)
  const provider = createProvider({
    minVoucherLifeS: 0, manifest: manifestAt(providerPrice, ['http://127.0.0.1:1/tapeapi/v1']), signerKey: SIGNER_KEY,
    rpcUrls: RPC, quorum: 2, chainId: 56, fetch: pc.fetch, allowHttp: true, escrowCacheMs: 0, log: () => {}, rateLimit: false,
    methods: { quote: handler },
  })
  const srv = await provider.listen(0)
  const url = `http://127.0.0.1:${srv.address().port}/tapeapi/v1`
  provider.manifest.endpoints.live = [url]
  cc.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify(manifestAt(chainPrice, [url])))
  const sent = []
  const rpcCount = { n: 0 }
  const fetchImpl = cc.fetchWith(async (u, init) => { try { sent.push(JSON.parse(init.body)) } catch { /* */ } return fetch(u, init) })
  const counted = (u, init) => { if (String(u).startsWith('http://rpc')) rpcCount.n++; return fetchImpl(u, init) }
  const api = createTapeAPI({ rpcUrls: RPC, quorum: 2, chainId: 56, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, escrow: ADDR.escrow, allowHttp: true, fetch: counted, rpcTimeoutMs: 300 })
  const payer = api.payer({ consumer, sessionKey: SESSION_KEY })
  return { cc, pc, provider, srv, url, api, payer, sent, rpcCount, close: () => new Promise((r) => srv.close(r)) }
}

// ---------------------------------------------------------------------------------------------- F-08
test('FIXED F-08: a price rise published on chain is NOT paid without consent; maxPrice or acceptPrice() opts in', async () => {
  const w = await world({ providerPrice: '5', chainPrice: '0.0001' })
  try {
    const svc = await w.api.resolve(ADDR.container)
    assert.equal(svc.manifest.methods[0].priceBEM, '0.0001', 'what the caller looked at')
    w.cc.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify(manifestAt('5', [w.url])))   // ...and publishes 5 BEM
    await assert.rejects(w.api.call(svc, 'quote', {}, { payer: w.payer }), (e) => e.code === 'PRICE_CHANGED' && e.data.price === parseUnits('5').toString() && e.data.accepted === parseUnits('0.0001').toString())
    assert.equal(w.payer.cumulativeOf(svc), 0n, 'nothing was paid')
    // A blind retry does not slip through: the automatic re-read updated the manifest, not the consent.
    // 盲目重试也溜不过去：自动重读只更新了清单，没有更新同意。
    await assert.rejects(w.api.call(svc, 'quote', {}, { payer: w.payer }), (e) => e.code === 'PRICE_CHANGED')
    assert.equal(w.payer.cumulativeOf(svc), 0n)
    // A ceiling below the new price still refuses; one at or above it pays. / 上限低于新价仍拒绝，覆盖新价才付。
    await assert.rejects(w.api.call(svc, 'quote', {}, { payer: w.payer, maxPrice: parseUnits('4') }), (e) => e.code === 'PRICE_CHANGED')
    const r = await w.api.call(svc, 'quote', {}, { payer: w.payer, maxPrice: parseUnits('5') })
    assert.equal(r.verified, true)
    assert.equal(w.payer.cumulativeOf(svc), parseUnits('5'))
    assert.equal(w.api.acceptedPrice(svc, 'quote'), parseUnits('5'), 'paying under maxPrice records the consent')
  } finally { await w.close() }
})

// ---------------------------------------------------------------------------------------------- F-09
test('FIXED F-09: a provider that keeps quoting a price the chain does not show gets one re-read per interval, not one per call', async () => {
  const w = await world({ providerPrice: '0.0002', chainPrice: '0.0001' })
  try {
    const svc = await w.api.resolve(ADDR.container)
    const calls = 10
    const before = w.rpcCount.n
    for (let i = 0; i < calls; i++) await assert.rejects(w.api.call(svc, 'quote', {}, { payer: w.payer }), (e) => e.code === 'BAD_VOUCHER')
    const reads = w.rpcCount.n - before
    assert.ok(reads <= 10, `one re-read (10 requests) for ten failed calls, not ${reads}`)
    assert.ok(w.sent.filter((b) => b.voucher).length <= calls + 1, 'and one voucher per call, plus the single re-read retry')
  } finally { await w.close() }
})

test('FIXED F-10: N concurrent calls on one stale svc share a single refresh', async () => {
  const w = await world({ providerPrice: '0', chainPrice: '0' })
  try {
    const svc = await w.api.resolve(ADDR.container)
    svc.fetchedAt = 0                                   // older than the 1 h TTL
    const before = w.cc.state.calls.filter((c) => c.name === 'fileInfo').length
    await Promise.all(Array.from({ length: 20 }, (_, i) => w.api.call(svc, 'quote', {}, { id: `c${i}` })))
    const fileInfos = w.cc.state.calls.filter((c) => c.name === 'fileInfo').length - before
    assert.equal(fileInfos, 2, '20 calls -> 1 resolve (x2 quorum nodes)')
  } finally { await w.close() }
})

test('FIXED F-11: after a failed refresh, calls back off instead of each waiting out the dead RPC', async () => {
  const w = await world({ providerPrice: '0', chainPrice: '0' })
  try {
    const svc = await w.api.resolve(ADDR.container)
    svc.fetchedAt = 0
    w.cc.setFault('http://rpc1', 'timeout'); w.cc.setFault('http://rpc2', 'timeout')
    const lat = []
    for (let i = 0; i < 3; i++) { const t0 = Date.now(); const r = await w.api.call(svc, 'quote', {}, { id: `d${i}` }); lat.push(Date.now() - t0); assert.equal(r.verified, true) }
    assert.ok(lat[0] >= 280, `the first call paid the timeout once (${lat[0]} ms)`)
    assert.ok(lat[1] < 280 && lat[2] < 280, `the next calls did not: ${lat}`)
  } finally { w.cc.setFault('http://rpc1'); w.cc.setFault('http://rpc2'); await w.close() }
})

test('FIXED I-06: a TTL refresh that removes the method fails the call instead of paying for a stale definition', async () => {
  const w = await world({ providerPrice: '0.0001', chainPrice: '0.0001' })
  try {
    const svc = await w.api.resolve(ADDR.container)
    w.cc.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify(manifestAt('0', [w.url], { methods: [{ name: 'other', priceBEM: '0', params: {}, returns: {} }] })))
    svc.fetchedAt = 0
    await assert.rejects(w.api.call(svc, 'quote', {}, { payer: w.payer }), (e) => e.code === 'METHOD_NOT_FOUND' && /removed/.test(e.message))
    assert.equal(w.payer.cumulativeOf(svc), 0n, 'nothing paid')
  } finally { await w.close() }
})

// ---------------------------------------------------------------------------------------------- properties
test('P-02: the price-hint retry keeps the request id and signs at the CHAIN price (with consent); the hint never becomes the price', async () => {
  const w = await world({ providerPrice: '0.0003', chainPrice: '0.0001' })
  try {
    const svc = await w.api.resolve(ADDR.container)
    w.cc.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify(manifestAt('0.0003', [w.url])))   // holder publishes the rise
    const r = await w.api.call(svc, 'quote', {}, { payer: w.payer, id: 'same-id', maxPrice: parseUnits('0.001') })
    const bodies = w.sent.filter((b) => b.id === 'same-id')
    assert.equal(bodies.length, 2)
    assert.equal(bodies[0].voucher.cumulative, parseUnits('0.0001').toString())
    assert.equal(bodies[1].voucher.cumulative, parseUnits('0.0003').toString(), 'retry at the re-read price, from the same floor')
    assert.equal(r.id, 'same-id')
  } finally { await w.close() }
})

test('P-03: refresh() refuses a label that now points at a different (fully valid) container', async () => {
  const w = await world({ providerPrice: '0', chainPrice: '0' })
  try {
    const DIR = ADDR.directory
    const api = createTapeAPI({ rpcUrls: RPC, quorum: 2, chainId: 56, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, directory: DIR, escrow: ADDR.escrow, allowHttp: true, fetch: w.cc.fetchWith() })
    w.cc.register({ label: 'audit', container: ADDR.container, tokenId: 4246 })
    const svc = await api.resolve('audit')
    // A second, genuine service: its own token, container and valid manifest; the label is re-pointed to it.
    w.cc.setOwner(4247, holder); w.cc.setAccount(4247, CONTAINER_B)
    w.cc.writeFile(CONTAINER_B, MANIFEST_KEY, JSON.stringify(manifestAt('0', [w.url], { container: CONTAINER_B, tokenId: '4247' })))
    w.cc.register({ label: 'audit', container: CONTAINER_B, tokenId: 4247 })
    assert.equal((await api.resolve('audit')).container.toLowerCase(), CONTAINER_B.toLowerCase(), 'B resolves cleanly on its own')
    await assert.rejects(api.refresh(svc), (e) => e.code === 'MANIFEST_INVALID' && /different service/.test(e.message))
    assert.equal(svc.container.toLowerCase(), ADDR.container.toLowerCase(), 'the handle is untouched')
  } finally { await w.close() }
})

// ---------------------------------------------------------------------------------------------- failover
test('I-07: failover after host 1 billed but its reply was lost -- host 2 (own store) serves AND meters the same voucher', async () => {
  const w = await world({ providerPrice: '0.0001', chainPrice: '0.0001' })
  try {
    // host 1 = the real provider behind a proxy that eats the reply (a 502 page after the upstream answered)
    const host1 = 'http://host1.invalid/tapeapi/v1'
    w.cc.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify(manifestAt('0.0001', [host1, w.url])))
    const p2 = createProvider({ minVoucherLifeS: 0, manifest: manifestAt('0.0001', [w.url]), signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: w.pc.fetch, allowHttp: true, escrowCacheMs: 0, log: () => {}, rateLimit: false, methods: { quote: async () => ({ v: 2 }) } })
    const s2 = await p2.listen(0)
    const host2 = `http://127.0.0.1:${s2.address().port}/tapeapi/v1`
    w.cc.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify(manifestAt('0.0001', [host1, host2])))
    const inner = w.cc.fetchWith()
    const api = createTapeAPI({ rpcUrls: RPC, quorum: 2, chainId: 56, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, escrow: ADDR.escrow, allowHttp: true,
      fetch: async (u, init) => {
        if (String(u).startsWith(host1)) { const r = await fetch(String(u).replace(host1, w.url), init); await r.arrayBuffer(); return new Response('<html>502 Bad Gateway</html>', { status: 502 }) }
        return inner(u, init)
      } })
    const svc = await api.resolve(ADDR.container)
    const r = await api.call(svc, 'quote', {}, { payer: w.payer })
    assert.deepEqual(r.result, { v: 2 })
    const a = await w.provider.store.get(consumer, ADDR.container), b = await p2.store.get(consumer, ADDR.container)
    assert.equal(a.cumulative, b.cumulative, 'both hosts metered cumulative ' + a.cumulative)
    assert.equal(a.sig, b.sig, 'with the very same voucher -- only one can settle on chain, so the provider served twice for one payment')
    await new Promise((r2) => s2.close(r2))
  } finally { await w.close() }
})

test('P-04: a SIGNED error from host 1 ends the loop -- host 2 is never asked', async () => {
  const w = await world({ providerPrice: '0', chainPrice: '0', handler: async () => { const { TapeAPIError } = await import('../src/index.js'); throw new TapeAPIError('BAD_REQUEST', 'no') } })
  try {
    let host2Hits = 0
    const host2 = 'http://host2.invalid/tapeapi/v1'
    w.cc.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify(manifestAt('0', [w.url, host2])))
    const inner = w.cc.fetchWith()
    const api = createTapeAPI({ rpcUrls: RPC, quorum: 2, chainId: 56, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, escrow: ADDR.escrow, allowHttp: true,
      fetch: (u, init) => { if (String(u).startsWith(host2)) { host2Hits++; return Promise.reject(new Error('should not be called')) } return inner(u, init) } })
    const svc = await api.resolve(ADDR.container)
    await assert.rejects(api.call(svc, 'quote', {}), (e) => e.code === 'BAD_REQUEST' && e.signed === true)
    assert.equal(host2Hits, 0)
  } finally { await w.close() }
})

test('I-08: host 1 answers a non-JSON 429 and host 2 is unreachable -> reported as RATE_LIMITED, not PROVIDER_UNAVAILABLE', async () => {
  const w = await world({ providerPrice: '0', chainPrice: '0' })
  try {
    const h1 = 'http://h1.invalid/tapeapi/v1', h2 = 'http://h2.invalid/tapeapi/v1'
    w.cc.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify(manifestAt('0', [h1, h2])))
    const inner = w.cc.fetchWith()
    const api = createTapeAPI({ rpcUrls: RPC, quorum: 2, chainId: 56, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, escrow: ADDR.escrow, allowHttp: true,
      fetch: async (u, init) => {
        if (String(u).startsWith(h1)) return new Response('Too Many Requests', { status: 429 })
        if (String(u).startsWith(h2)) throw new TypeError('fetch failed')
        return inner(u, init)
      } })
    const svc = await api.resolve(ADDR.container)
    await assert.rejects(api.call(svc, 'quote', {}), (e) => e.code === 'RATE_LIMITED')
  } finally { await w.close() }
})
