// Adversarial audit of the provider runtime (docs/AUDIT-runtime-2.md). Each test DEMONSTRATES a finding: it passes
// while the weakness exists and is expected to fail once the fix lands (then invert or delete it).
// 运行时对抗审计。每个测试都在弱点存在时通过；修复后应失败（届时反转或删除）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { createProvider } from '../src/index.js'
import { sig, parseUnits } from '@tapeapi/sdk'
import { createFakeChain, ADDR } from '../../sdk/test/helpers/fake-chain.mjs'

const { privateKeyToAddress, signDigest, voucherDigest, delegationDigest, randomPrivateKey } = sig
const SIGNER_KEY = '0x' + '22'.repeat(32), CONSUMER_KEY = '0x' + '33'.repeat(32), HOLDER_KEY = '0x' + '11'.repeat(32)
const signer = privateKeyToAddress(SIGNER_KEY), consumer = privateKeyToAddress(CONSUMER_KEY)
const PRICE = parseUnits('0.0001')
const RPC = ['http://rpc1', 'http://rpc2']
const nowS = () => Math.floor(Date.now() / 1000)

const manifestFor = (extra = {}) => {
  const expires = nowS() + 300 * 86400
  return {
    tapeapi: '0.1', name: 'Audit', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
    delegation: { expires, sig: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires }), HOLDER_KEY) },
    endpoints: { live: ['http://127.0.0.1/tapeapi/v1'], async: false },
    methods: [{ name: 'free', priceBEM: '0', params: {}, returns: {} }, { name: 'paid', priceBEM: '0.0001', params: {}, returns: {} }],
    payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 },
    ...extra,
  }
}
const voucherBy = (key, cumulative, consumerAddr = privateKeyToAddress(key)) => {
  const v = { consumer: consumerAddr, provider: ADDR.container, cumulative: cumulative.toString(), expires: nowS() + 3600 }
  return { ...v, sig: signDigest(voucherDigest(56, ADDR.escrow, v), key) }
}
function mk(extra = {}) {
  const chain = extra.chain || createFakeChain()
  chain.setChannel(consumer, ADDR.container, parseUnits('1'))
  const p = createProvider({
    minVoucherLifeS: 0, manifest: manifestFor(), signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: chain.fetch,
    allowHttp: true, log: () => {}, escrowCacheMs: 0,
    methods: { free: async () => ({ ok: 1 }), paid: async () => ({ ok: 2 }) },
    ...extra,
  })
  return { p, chain }
}
const reqF = (m, body, headers = {}) => new Request(`https://api.example.com/tapeapi/v1/${m}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })

// ---------------------------------------------------------------------------------------------- F-01
test('FIXED F-01: unverified traffic to a PAID method (no voucher, junk voucher, missing id) spends the free budget', async () => {
  const { p } = mk({ rateLimit: { windowMs: 60_000, free: 2, paid: 3, ip: 1_000_000 } })
  const ip = '6.6.6.6'
  const outs = []
  for (let i = 0; i < 4; i++) outs.push(await p.invoke({ id: `n${i}`, method: 'paid', params: {} }, { ip }))
  assert.equal(outs.filter((o) => o.rateLimited).length, 2, 'two PAYMENT_REQUIRED answers, then the free budget is spent')
  // Junk vouchers keep failing verification; once the IP has also failed enough, it is refused before recovery.
  // 垃圾凭证不断验证失败；该 IP 失败次数也够多之后，会在恢复签名之前就被拒绝。
  const junk = []
  for (let i = 0; i < 30; i++) junk.push(await p.invoke({ id: `j${i}`, method: 'paid', params: {}, voucher: { junk: true } }, { ip }))
  assert.ok(junk.slice(-5).every((o) => o.rateLimited), 'after the failure budget, junk is refused up front')
  assert.ok((await p.invoke({ method: 'free', params: {} }, { ip })).rateLimited, 'a missing id is unverified work too')
})

test('F-01b: a fresh self-signed voucher per request buys 6 uncached eth_calls + ecrecover + a signature, outside every budget but the IP ceiling', async () => {
  const { p, chain } = mk({ rateLimit: { windowMs: 60_000, free: 2, paid: 3, ip: 1_000_000 } })
  const before = chain.state.calls.length
  const K = 20
  for (let i = 0; i < K; i++) {
    const key = randomPrivateKey()                      // attacker: a new identity per request, no funds anywhere
    const out = await p.invoke({ id: `a${i}`, method: 'paid', params: {}, voucher: voucherBy(key, 1) }, { ip: '6.6.6.7' })
    assert.equal(out.env.error.code, 'BAD_VOUCHER'); assert.ok(!out.rateLimited)
  }
  const perReq = (chain.state.calls.length - before) / K
  // channelOf + claimedOf + pendingWithdraw, each asked of both quorum nodes = 6 eth_calls per junk request
  assert.equal(perReq, 6, `eth_calls per unauthenticated request: ${perReq}`)
})

// ---------------------------------------------------------------------------------------------- F-02
test('FIXED F-02: the bucket map is bounded by rateLimit.max (the oldest buckets go first)', async () => {
  const { p } = mk({ rateLimit: { windowMs: 3_600_000, free: 1, paid: 1, ip: 1_000_000, max: 10 } })
  assert.equal((await p.invoke({ id: 'v1', method: 'free' }, { ip: 'victim' })).status, 200)
  assert.ok((await p.invoke({ id: 'v2', method: 'free' }, { ip: 'victim' })).rateLimited)
  for (let i = 0; i < 2000; i++) await p.invoke({ id: 'x', method: 'free' }, { ip: `10.0.${i >> 8}.${i & 255}` })
  assert.equal((await p.invoke({ id: 'v3', method: 'free' }, { ip: 'victim' })).status, 200, 'the victim bucket was evicted: the map never exceeded max')
})

test('F-02b: once the map is past max, every request scans the whole map (per-request cost grows with distinct IPs)', { skip: !process.env.AUDIT_TIMING && 'timing-based demonstration; set AUDIT_TIMING=1' }, async (t) => {
  // ip: -1 is accepted unvalidated and makes every request an immediate unsigned 429 after ONE rateLimited() call,
  // which isolates the limiter's own cost from signing. (Unvalidated negative budgets are themselves Info I-05.)
  const { p } = mk({ rateLimit: { windowMs: 3_600_000, free: 1, paid: 1, ip: -1, max: 100 } })
  const hit = (ip) => p.handleRequest(reqF('free', '{}'), { clientIp: ip })
  const time = async (tag, n) => { const t0 = process.hrtime.bigint(); for (let i = 0; i < n; i++) await hit(`${tag}${i}`); return Number(process.hrtime.bigint() - t0) / 1e6 / n }
  const small = await time('warm', 500)                 // map grows 0 -> 500
  for (let i = 0; i < 40_000; i++) await hit(`fill${i}`)
  const large = await time('late', 500)                 // map ~40,500
  t.diagnostic(`per-request ms at ~0.5k buckets: ${small.toFixed(3)}, at ~40k buckets: ${large.toFixed(3)}, ratio ${(large / small).toFixed(1)}x`)
  assert.ok(large > small * 3, `expected linear-scan slowdown, got ${small} -> ${large}`)
})

// ---------------------------------------------------------------------------------------------- F-03
test('FIXED F-03: clientIpHeader "x-forwarded-for" keys on the LAST hop, the one the trusted proxy appended', async () => {
  const { p } = mk({ rateLimit: { windowMs: 60_000, free: 1, paid: 1, ip: 1 }, clientIpHeader: 'x-forwarded-for' })
  const srv = await p.listen(0)
  try {
    const url = `http://127.0.0.1:${srv.address().port}/tapeapi/v1/free`
    const codes = []
    for (let i = 0; i < 4; i++) {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i}, 198.51.100.7` }, body: JSON.stringify({ id: `x${i}` }) })
      codes.push(r.status); await r.arrayBuffer()
    }
    assert.deepEqual(codes, [200, 429, 429, 429], 'the real client (198.51.100.7) is one client, whatever it writes on the left')
  } finally { await p.close() }
})

test('FIXED F-04: handleRequest ignores a client-sent cf-connecting-ip and honours clientIpHeader', async () => {
  const { p } = mk({ rateLimit: { windowMs: 60_000, free: 1, paid: 1, ip: 1 }, clientIpHeader: 'x-real-ip' })
  const codes = []
  for (let i = 0; i < 4; i++) codes.push((await p.handleRequest(reqF('free', { id: `c${i}` }, { 'cf-connecting-ip': `1.2.3.${i}`, 'x-real-ip': '9.9.9.9' }))).status)
  assert.deepEqual(codes, [200, 429, 429, 429], 'rotating a header the operator did not configure changes nothing')
})

test('F-04b: without clientIp and without the header, every caller shares the bucket "unknown": one client locks out all', async () => {
  const { p } = mk({ rateLimit: { windowMs: 60_000, free: 2, paid: 10, ip: 12 } })
  for (let i = 0; i < 12; i++) await p.handleRequest(reqF('free', { id: `a${i}` }))  // attacker
  const victim = await p.handleRequest(reqF('free', { id: 'victim' }))               // unrelated consumer
  assert.equal(victim.status, 429)
})

// ---------------------------------------------------------------------------------------------- F-05
test('FIXED F-05: both entry points count the body limit in bytes', async () => {
  const bodyLimit = 1024
  const { p } = mk({ bodyLimit, rateLimit: false })
  const body = JSON.stringify({ id: 'b', params: { pad: 'é'.repeat(700) } })   // ~720 chars, ~1420 bytes
  assert.ok(body.length <= bodyLimit && Buffer.byteLength(body) > bodyLimit)
  const viaFetch = await p.handleRequest(reqF('free', body))
  const srv = await p.listen(0)
  try {
    const viaNode = await fetch(`http://127.0.0.1:${srv.address().port}/tapeapi/v1/free`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    assert.equal(viaFetch.status, 413); assert.equal(viaNode.status, 413)
  } finally { await p.close() }
})

test('FIXED F-05b: handleRequest stops reading at the hard cap instead of buffering an arbitrarily large body', async () => {
  const { p } = mk({ bodyLimit: 1024, rateLimit: false })
  let pulled = 0
  const total = 32 * 1024 * 1024
  const stream = new ReadableStream({
    pull(c) { if (pulled >= total) return c.close(); const chunk = new Uint8Array(1024 * 1024).fill(0x20); pulled += chunk.length; c.enqueue(chunk) },
  })
  const r = await p.handleRequest(new Request('https://api.example.com/tapeapi/v1/free', { method: 'POST', body: stream, duplex: 'half' }))
  assert.equal(r.status, 413)
  assert.ok(pulled <= 6 * 1024 * 1024, `stopped near the 4 MiB cap (${pulled} bytes pulled), not after all ${total}`)
})

// ---------------------------------------------------------------------------------------------- F-06
test('FIXED F-06: a paid result that cannot be signed is NOT billed; the consumer gets a signed INTERNAL', async () => {
  const chain = createFakeChain()
  const { p } = mk({ chain, rateLimit: false, methods: { free: async () => ({}), paid: async () => ({ at: new Date(0) }) } })
  const out = await p.invoke({ id: 'd1', method: 'paid', params: {}, voucher: voucherBy(CONSUMER_KEY, PRICE) }, { ip: 'x' })
  assert.equal(out.env.ok, false); assert.equal(out.env.error.code, 'INTERNAL')
  assert.equal(await p.store.get(consumer, ADDR.container), null, 'the meter did not advance')
})

test('FIXED F-07: params with no canonical form are refused BEFORE the handler runs, with a signed BAD_REQUEST on both paths', async () => {
  let ran = 0
  const { p } = mk({ rateLimit: false, methods: { free: async () => { ran++; return {} }, paid: async () => ({}) } })
  for (const raw of ['{"id":"a","params":{"x":1e400}}', '{"id":"b","params":{"x":-0}}', '{"id":"c","params":{"x":12345678901234567890}}']) {
    const r = await p.handleRequest(reqF('free', raw))
    const env = await r.json()
    assert.equal(r.status, 400, raw); assert.equal(env.error.code, 'BAD_REQUEST'); assert.match(env.sig, /^0x[0-9a-f]{130}$/i)
  }
  assert.equal(ran, 0, 'the handler never ran')
  const srv = await p.listen(0)
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/tapeapi/v1/free`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"d","params":{"x":1e400}}' })
    assert.equal(r.status, 400); assert.match((await r.json()).sig, /^0x[0-9a-f]{130}$/i, 'signed, not an unsigned 500')
  } finally { await p.close() }
})

// ---------------------------------------------------------------------------------------------- stats / misc
test('FIXED I-01: stats count a call as paid only when a voucher actually verified', async () => {
  const { p } = mk({ rateLimit: { windowMs: 60_000, free: 5, paid: 5, ip: 100 } })
  await p.handleRequest(reqF('free', { id: 'a', voucher: 'junk' }), { clientIp: 'i1' })
  await p.handleRequest(reqF('paid', { id: 'b', params: {}, voucher: voucherBy(CONSUMER_KEY, PRICE) }), { clientIp: 'i1' })
  const st = p.stats()
  assert.equal(st.paid, 1, 'only the verified paid call'); assert.equal(st.free, 1)
})

test('FIXED I-02: the node server bounds a request to 30 s end to end and 15 s for headers', async () => {
  const { p } = mk({ rateLimit: false })
  const srv = await p.listen(0)
  try {
    assert.equal(srv.requestTimeout, 30_000)
    assert.equal(srv.headersTimeout, 15_000)
  } finally { await p.close() }
})

test('P-01 (property): readBody settles exactly once on abort, on drain-then-413, and on hard-cap cut-off', async () => {
  const { p } = mk({ rateLimit: false, bodyLimit: 1024 })   // hard cap = max(64 KiB, 4 MiB) = 4 MiB
  let settled = 0, rejected = 0
  const srv = http.createServer((req, res) => { p.handler(req, res).then(() => settled++, () => rejected++) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  try {
    // (a) aborted mid-upload
    const s = net.connect(port, '127.0.0.1'); await new Promise((r) => s.once('connect', r)); s.on('error', () => {})
    s.write('POST /tapeapi/v1/free HTTP/1.1\r\nHost: x\r\nContent-Length: 5000\r\n\r\n' + 'a'.repeat(2000)); await new Promise((r) => setTimeout(r, 100)); s.destroy()
    // (b) over the limit, under the cap: drained, 413
    const r1 = await fetch(`http://127.0.0.1:${port}/tapeapi/v1/free`, { method: 'POST', body: 'x'.repeat(200_000) }); assert.equal(r1.status, 413); await r1.arrayBuffer()
    // (c) over the hard cap: socket destroyed
    await assert.rejects(fetch(`http://127.0.0.1:${port}/tapeapi/v1/free`, { method: 'POST', body: 'x'.repeat(5 * 1024 * 1024) }).then((r) => r.arrayBuffer()))
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(rejected, 0, 'no unhandled rejection escaped handler()')
    assert.equal(settled, 3, 'every one of the three requests settled its handler() promise')
  } finally { srv.close() }
})

test('I-03 FIXED: opts.escrow = 0x0 is refused; a delegation near expiry boots with a warning', () => {
  const zero = '0x' + '00'.repeat(20)
  assert.throws(() => mk({ escrow: zero }), (e) => e.code === 'INVALID_ARGUMENT', 'an override may only restate the manifest escrow')
  const expires = nowS() + 2
  const m = manifestFor({ delegation: { expires, sig: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires }), HOLDER_KEY) } })
  const logs = []
  assert.ok(mk({ manifest: m, log: (...a) => logs.push(a.join(' ')) }).p, 'still boots: the delegation is valid right now')
  assert.ok(logs.some((l) => /delegation expires in/.test(l)), 'but the operator is told it is about to lapse')
})

test('P-05 (property): unknown methods and junk vouchers on FREE methods do spend the free budget; the paid 429 is not billed', async () => {
  const { p } = mk({ rateLimit: { windowMs: 60_000, free: 2, paid: 1, ip: 1000 } })
  assert.equal((await p.invoke({ id: 'u1', method: 'nope' }, { ip: 'q' })).env.error.code, 'METHOD_NOT_FOUND')
  assert.equal((await p.invoke({ id: 'u2', method: 'free', voucher: { junk: 1 } }, { ip: 'q' })).status, 200)
  assert.ok((await p.invoke({ id: 'u3', method: 'free' }, { ip: 'q' })).rateLimited)
  // paid budget 1: the second verified call is refused with an unsigned 429 and its reservation released
  assert.equal((await p.invoke({ id: 'p1', method: 'paid', voucher: voucherBy(CONSUMER_KEY, PRICE) }, { ip: 'q' })).status, 200)
  assert.ok((await p.invoke({ id: 'p2', method: 'paid', voucher: voucherBy(CONSUMER_KEY, 2n * PRICE) }, { ip: 'q' })).rateLimited)
  assert.equal((await p.store.get(consumer, ADDR.container)).cumulative, PRICE.toString())
})

test('P-06 (parity): handler() and handleRequest() agree on status and error code for the same requests (except F-05)', async () => {
  const cases = [
    ['POST', 'free', JSON.stringify({ id: 'a' })], ['POST', 'free', '{oops'], ['POST', 'free', '[]'], ['POST', 'free', JSON.stringify({ params: {} })],
    ['POST', 'nope', JSON.stringify({ id: 'b' })], ['POST', 'paid', JSON.stringify({ id: 'c' })], ['POST', 'paid', JSON.stringify({ id: 'd', voucher: { x: 1 } })],
    ['POST', 'free', '{"id":"e","__proto__":{}}'], ['POST', 'free', '{"id":"f","id":"g"}'], ['POST', 'free', JSON.stringify({ id: 'h', params: [] })],
    ['POST', 'free', JSON.stringify({ id: 'x'.repeat(129) })], ['POST', 'free', JSON.stringify({ id: 'i', pad: 'x'.repeat(70_000) })],
    ['GET', 'free', null], ['POST', 'bad-name', '{}'], ['OPTIONS', 'free', null],
  ]
  const run = async (fn) => {
    const { p } = mk({ rateLimit: { windowMs: 60_000, free: 6, paid: 5, ip: 12 } })
    const out = []
    for (const [method, m, body] of cases) out.push(await fn(p, method, m, body))
    return out
  }
  const viaFetch = await run(async (p, method, m, body) => { const r = await p.handleRequest(new Request(`https://x.example/tapeapi/v1/${m}`, { method, body })); const t = await r.text(); return `${r.status}:${t ? (JSON.parse(t).error?.code ?? 'ok') : ''}` })
  const viaNode = await run(async (p, method, m, body) => {
    if (!p.server) await p.listen(0)
    const r = await fetch(`http://127.0.0.1:${p.server.address().port}/tapeapi/v1/${m}`, { method, body }); const t = await r.text()
    if (cases.indexOf(cases.find((c) => c[2] === body && c[1] === m && c[0] === method)) === cases.length - 1) await p.close()
    return `${r.status}:${t ? (JSON.parse(t).error?.code ?? 'ok') : ''}`
  })
  assert.deepEqual(viaNode, viaFetch)
})
