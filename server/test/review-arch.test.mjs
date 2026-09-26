// Architecture review, provider runtime and RPC items. Every `FIXED <id>` test replays the original scenario and
// asserts the CORRECT behaviour. Relay items live in examples/relay-service/ and examples/cloudflare-worker/.
// 架构审查中提供者运行时与 RPC 部分。每个 `FIXED <id>` 测试重放原场景并断言正确行为。中继部分见 examples 下两个目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createProvider, memoryStore } from '../src/index.js'
import { createRpc } from '../../sdk/src/rpc.js'
import { privateKeyToAddress, signDigest, delegationDigest } from '../../sdk/src/sig.js'
import { ADDR } from '../../sdk/test/helpers/fake-chain.mjs'
import { exampleEnv } from '../../examples/_lib/service.mjs'

const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32)
const signer = privateKeyToAddress(SIGNER_KEY)
const nowS = () => Math.floor(Date.now() / 1000)
const manifest = ({ expires = nowS() + 86400, price = '0', dev } = {}) => ({
  tapeapi: '0.1', name: 'Arch', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
  delegation: { expires, sig: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires }), HOLDER_KEY) },
  endpoints: { live: ['https://api.example.com/tapeapi/v1'], async: false },
  methods: [{ name: 'ping', priceBEM: price, params: {}, returns: { pong: 'boolean' } }],
  ...(price !== '0' ? { payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 } } : {}),
  ...(dev ? { dev: true } : {}),
})
const mk = (m, extra = {}) => createProvider({ minVoucherLifeS: 0, manifest: m, signerKey: SIGNER_KEY, log: () => {}, methods: { ping: async () => ({ pong: true }) }, ...extra })

// ------------------------------------------------------------------------------------------------ A1 ----
test('FIXED A1: a priced, non-dev provider on the default in-memory meter warns at creation; an explicit store, allowMemoryStore, a dev or a free service does not', () => {
  const warned = []
  const warn = (...a) => warned.push(a.join(' '))
  mk(manifest({ price: '0.001' }), { warn })
  assert.equal(warned.length, 1, 'one warning at creation')
  assert.match(warned[0], /in-memory meter/)
  assert.match(warned[0], /lost on restart/)
  assert.match(warned[0], /serves the same voucher again/)
  mk(manifest({ price: '0.001' }), { warn, store: memoryStore() })             // the operator chose a store / 运营者自己选了 store
  mk(manifest({ price: '0.001' }), { warn, allowMemoryStore: true })           // tests, single-process demos / 测试、单进程演示
  mk(manifest({ price: '0.001', dev: true }), { warn })                        // a dev manifest is not production / dev 清单不是生产
  mk(manifest({ price: '0.001' }), { warn, allowHttp: true })
  mk(manifest(), { warn })                                                     // nothing to meter / 没有计量
  assert.equal(warned.length, 1, 'none of those warn')
  // Without `warn` it goes to console.warn, not the silent default `log` / 没有 warn 时走 console.warn，而不是默认静默的 log
  const orig = console.warn; const seen = []
  console.warn = (...a) => seen.push(a.join(' '))
  try { mk(manifest({ price: '0.001' })) } finally { console.warn = orig }
  assert.equal(seen.length, 1); assert.match(seen[0], /^\[tapeapi\/server\] priced methods on the in-memory meter/)
})

// ------------------------------------------------------------------------------------------------ A3 ----
test('FIXED A3: a delegation that lapses while serving stops every signed answer (unsigned 503 DELEGATION_INVALID), and health/stats expose delegationExpires', async () => {
  const p = mk(manifest({ expires: nowS() + 3600 }))
  const exp = p.manifest.delegation.expires
  const call = (id) => p.handleRequest(new Request('https://api.example.com/tapeapi/v1/ping', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, params: {} }) }), { clientIp: '1.2.3.4' })
  const health = async () => (await p.handleRequest(new Request('https://api.example.com/tapeapi/v1/health'), { clientIp: '1.2.3.4' })).json()
  // Before: served, signed, and the expiry is advertised / 过期前：正常签名服务，并公布过期时间
  const ok = await (await call('a')).json()
  assert.equal(ok.ok, true); assert.match(ok.sig, /^0x[0-9a-f]{130}$/)
  assert.deepEqual(await health().then((h) => [h.ok, h.delegationExpires]), [true, exp])
  assert.equal(p.stats().delegationExpires, exp)
  // The delegation lapses while the process runs (time travel through the manifest the provider keeps).
  // 进程运行中委托过期（通过 provider 持有的清单"穿越时间"）。
  p.manifest.delegation.expires = nowS()                                       // now >= expires: what a consumer rejects / 消费者拒收的边界
  const res = await call('b')
  assert.equal(res.status, 503)
  const body = await res.json()
  assert.equal(body.ok, false); assert.equal(body.error.code, 'DELEGATION_INVALID')
  assert.equal(body.sig, undefined, 'nothing is signed with a key whose authority lapsed')
  assert.equal(body.container, undefined, 'not an envelope at all')
  const h = await health()
  assert.equal(h.ok, false, 'health says so'); assert.equal(h.delegationExpires, p.manifest.delegation.expires)
  assert.equal(p.stats().delegationExpires, p.manifest.delegation.expires)
  assert.ok(p.stats().delegationLapsed >= 1)
  // invoke() directly (custom transports) refuses the same way / 直接调用 invoke() 同样拒绝
  const out = await p.invoke({ id: 'c', method: 'ping', params: {} })
  assert.equal(out.status, 503); assert.equal(out.env, undefined); assert.equal(out.unsigned.error.code, 'DELEGATION_INVALID')
  // The node:http path too / node:http 路径同样
  const srv = await p.listen(0)
  try {
    const base = `http://127.0.0.1:${srv.address().port}/tapeapi/v1`
    const r = await fetch(`${base}/ping`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'd', params: {} }) })
    assert.equal(r.status, 503); const j = await r.json()
    assert.equal(j.error.code, 'DELEGATION_INVALID'); assert.equal(j.sig, undefined)
    const hh = await (await fetch(`${base}/health`)).json()
    assert.equal(hh.ok, false); assert.equal(hh.delegationExpires, p.manifest.delegation.expires)
    // Re-signed in place: serving resumes without a restart / 就地重签：无需重启即恢复服务
    p.manifest.delegation.expires = nowS() + 3600
    const again = await (await fetch(`${base}/ping`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'e', params: {} }) })).json()
    assert.equal(again.ok, true)
  } finally { await p.close() }
  // A dev manifest has no delegation: nothing lapses, delegationExpires is null / dev 清单没有委托：不过期，值为 null
  const d = mk({ ...manifest(), delegation: null, dev: true })
  assert.equal(d.stats().delegationExpires, null)
  assert.equal((await (await d.handleRequest(new Request('https://api.example.com/tapeapi/v1/health'))).json()).delegationExpires, null)
})

// ------------------------------------------------------------------------------------------------ A5 ----
test('FIXED A5: createRpc warns once when quorum equals the node count (no spare node); 2-of-3, quiet, dev and test sets stay silent', () => {
  const warned = []
  const warn = (m) => warned.push(m)
  const fetch = async () => { throw new Error('never called at creation') }
  const tag = `${process.pid}-${Date.now()}`
  const set = [`https://one-${tag}.node.org`, `https://two-${tag}.node.org`]
  createRpc({ urls: set, quorum: 2, fetch, warn })
  assert.equal(warned.length, 1)
  assert.match(warned[0], /quorum 2 of 2 nodes leaves no spare; any single node failure stops reads/)
  assert.ok(!warned[0].includes(tag), 'no URL in the message (it may carry an API key)')
  createRpc({ urls: [...set].reverse(), quorum: 2, fetch, warn })              // same set: said once per process / 同一集合只说一次
  createRpc({ urls: [...set, `https://three-${tag}.node.org`], quorum: 2, fetch, warn })   // 2-of-3 has a spare / 三取二有余量
  createRpc({ urls: [`https://q1-${tag}.node.org`, `https://q2-${tag}.node.org`], quorum: 2, fetch, warn, quiet: true })
  createRpc({ urls: ['http://rpc1', 'http://rpc2'], quorum: 2, fetch, warn })  // plain http: a local / test setup
  createRpc({ urls: ['https://a.invalid', 'https://b.example'], quorum: 2, fetch, warn })   // RFC 6761 reserved names
  createRpc({ urls: [`https://solo-${tag}.node.org`], quorum: 2, fetch, warn, allowSingleNode: true })   // an explicit dev clamp
  createRpc({ urls: [`https://solo-${tag}.node.org`], quorum: 1, fetch, warn }) // quorum 1 asked for no agreement at all
  assert.equal(warned.length, 1, 'none of those warn')
})

test('FIXED A5: every example default is a 2-of-3 set with bsc-rpc.publicnode.com and the bsc-dataseed hosts', () => {
  const DEFAULT = ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io']
  const e = exampleEnv('x', { port: 1, env: { SIGNER_KEY } })
  assert.deepEqual(e.RPC_URLS, DEFAULT); assert.equal(e.QUORUM, 2)
  for (const f of ['../../examples/relay-service/index.mjs', '../../examples/cloudflare-worker/relay-worker.js', '../../examples/cloudflare-worker/worker.js', '../../examples/cloudflare-worker/wrangler.toml']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8')
    assert.ok(src.includes(DEFAULT.join(',')), `${f} defaults to the 2-of-3 set`)
    assert.ok(!/ninicoin/.test(src), `${f} adds no other URL`)
  }
})

// ----------------------------------------------------------------------------------------------- B17 ----
test('FIXED B17: node:http and fetch entry points give byte-identical answers for health, manifest, a signed call, a rate-limited call, oversize body, bad JSON, method mismatch, lapsed delegation, OPTIONS', async () => {
  // One clock for both, so `ts`, the (deterministic) signature and "retry in Ns" agree byte for byte.
  // 两边共用一个时钟，`ts`、（确定性的）签名与 "retry in Ns" 才能逐字节一致。
  const realNow = Date.now, T = realNow()
  Date.now = () => T
  const expires = nowS() + 86400
  const opts = { bodyLimit: 1024, rateLimit: { windowMs: 60_000, free: 4, paid: 10, ip: 100 } }
  const viaNode = mk(manifest({ expires }), opts), viaFetch = mk(manifest({ expires }), opts)
  try {
    const srv = await viaNode.listen(0)
    const base = `http://127.0.0.1:${srv.address().port}`
    const HEADERS = ['content-type', 'retry-after', 'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-max-age']
    const both = async (label, path, init = {}) => {
      const a = await fetch(`${base}${path}`, init)
      const b = await viaFetch.handleRequest(new Request(`https://api.example.com${path}`, init), { clientIp: '127.0.0.1' })
      const [ta, tb] = [await a.text(), await b.text()]
      assert.equal(a.status, b.status, `${label}: status`)
      assert.equal(ta, tb, `${label}: body`)
      for (const h of HEADERS) assert.equal(a.headers.get(h), b.headers.get(h), `${label}: ${h}`)
      if (a.status !== 204) assert.equal(a.headers.get('content-length'), String(Buffer.byteLength(ta)), `${label}: content-length`)
      return { status: a.status, body: ta ? JSON.parse(ta) : null, retryAfter: a.headers.get('retry-after') }
    }
    const post = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })
    // Nothing below spends budget until the signed call; then each unverified call spends one of the 4 free.
    // 签名调用之前的都不花预算；之后每个未经验证的调用花掉 4 个免费额度中的一个。
    assert.equal((await both('health', '/tapeapi/v1/health')).body.ok, true)
    assert.equal((await both('manifest', '/.well-known/tapeapi.json')).body.signer, signer)
    const pre = await both('OPTIONS', '/tapeapi/v1/ping', { method: 'OPTIONS' })
    assert.equal(pre.status, 204); assert.equal(pre.body, null)
    assert.equal((await both('GET on a method', '/tapeapi/v1/ping')).status, 405)
    assert.equal((await both('no route', '/nope', post({}))).status, 404)
    const signed = await both('signed call', '/tapeapi/v1/ping', post({ id: 's1', params: {} }))
    assert.equal(signed.status, 200); assert.deepEqual(signed.body.result, { pong: true }); assert.match(signed.body.sig, /^0x[0-9a-f]{130}$/)
    const bad = await both('bad JSON', '/tapeapi/v1/ping', post('{oops'))
    assert.equal(bad.status, 400); assert.equal(bad.body.error.code, 'BAD_REQUEST'); assert.match(bad.body.sig, /^0x/)
    const big = await both('oversize body', '/tapeapi/v1/ping', post({ id: 'big', pad: 'x'.repeat(2048) }))
    assert.equal(big.status, 413); assert.match(big.body.error.message, /too large/)
    const mismatch = await both('method mismatch', '/tapeapi/v1/ping', post({ id: 'mm', method: 'other', params: {} }))
    assert.equal(mismatch.status, 400); assert.match(mismatch.body.error.message, /does not match the path/)
    const limited = await both('rate-limited call', '/tapeapi/v1/ping', post({ id: 'rl', params: {} }))
    assert.equal(limited.status, 429); assert.equal(limited.body.error.code, 'RATE_LIMITED'); assert.equal(limited.retryAfter, '60'); assert.equal(limited.body.sig, undefined, 'unsigned')
    // The delegation lapses while both run (arch A3) / 两边运行中委托过期
    viaNode.manifest.delegation.expires = viaFetch.manifest.delegation.expires = nowS() - 1
    const lapsed = await both('lapsed delegation', '/tapeapi/v1/ping', post({ id: 'lp', params: {} }))
    assert.equal(lapsed.status, 503); assert.equal(lapsed.body.error.code, 'DELEGATION_INVALID'); assert.equal(lapsed.body.sig, undefined)
    assert.equal((await both('health after lapse', '/tapeapi/v1/health')).body.ok, false)
    assert.deepEqual(viaNode.stats(), viaFetch.stats(), 'the same counters on both')
    // A method the Fetch spec forbids in a Request still gets the 405 every other non-POST gets.
    // Fetch 规范不允许的方法照样得到与其他非 POST 相同的 405。
    const { default: http } = await import('node:http')
    const trace = await new Promise((resolve, reject) => http.request(`${base}/tapeapi/v1/ping`, { method: 'TRACE' }, (res) => { let d = ''; res.on('data', (c) => { d += c }); res.on('end', () => resolve([res.statusCode, d])) }).on('error', reject).end())
    assert.deepEqual(trace, [405, JSON.stringify({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'use POST' } })])
  } finally { Date.now = realNow; await viaNode.close() }
})

test('FIXED R2-5: an absolute-form request target with user:pass@ is served as before, and the exported handler never rejects', async () => {
  const { connect } = await import('node:net')
  const { createServer } = await import('node:http')
  const raw = (port, lines) => new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1', () => s.end(lines.join('\r\n') + '\r\n\r\n'))
    let buf = ''; s.on('data', (d) => { buf += d }); s.on('end', () => resolve(buf)); s.on('error', reject)
  })
  const logged = []
  const p = mk(manifest(), { log: (...a) => logged.push(a.join(' ')) })
  const srv = await p.listen(0)
  try {
    const out = await raw(srv.address().port, ['GET http://u:p@api.example.com/tapeapi/v1/health HTTP/1.1', 'Host: api.example.com', 'Connection: close'])
    assert.match(out, /^HTTP\/1\.1 200 /, out.split('\r\n')[0])
    assert.match(out, /"ok":true/)
    assert.equal(logged.filter((l) => /handler crash/.test(l)).length, 0, 'no crash logged')
  } finally { await p.close() }
  // Wired straight into http.createServer: a request that makes the adapter throw still gets an answer.
  // 直接接进 http.createServer：让适配层抛错的请求照样得到回答。
  const q = mk(manifest(), { log: () => {} })
  const bare = createServer(q.handler)
  await new Promise((r) => bare.listen(0, '127.0.0.1', r))
  const unhandled = []
  const onUnhandled = (e) => unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  try {
    const out = await raw(bare.address().port, ['GET /tapeapi/v1/health HTTP/1.1', 'Host: [bad', 'Connection: close'])
    assert.match(out, /^HTTP\/1\.1 (200|400|500) /, out.split('\r\n')[0])
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(unhandled.length, 0, 'no unhandled rejection')
  } finally { process.off('unhandledRejection', onUnhandled); await new Promise((r) => bare.close(r)) }
})

test('FIXED R3-6: a broken logger cannot make the exported handler reject; an unparsable target is a 400', async () => {
  const { connect } = await import('node:net')
  const { createServer } = await import('node:http')
  const raw = (port, lines) => new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1', () => s.end(lines.join('\r\n') + '\r\n\r\n'))
    let buf = ''; s.on('data', (d) => { buf += d }); s.on('end', () => resolve(buf)); s.on('error', reject)
  })
  let broken = false
  const p = mk(manifest(), { log: () => { if (broken) throw new Error('logger is broken') } })
  broken = true                                                       // breaks after boot / 启动后才坏
  const bare = createServer(p.handler)
  await new Promise((r) => bare.listen(0, '127.0.0.1', r))
  const unhandled = []
  const onUnhandled = (e) => unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  try {
    const out = await raw(bare.address().port, ['GET http://h:99999/tapeapi/v1/health HTTP/1.1', 'Host: h', 'Connection: close'])
    assert.match(out, /^HTTP\/1\.1 400 /, out.split('\r\n')[0])
    assert.match(out, /BAD_REQUEST/)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(unhandled.length, 0, 'no unhandled rejection')
  } finally { process.off('unhandledRejection', onUnhandled); await new Promise((r) => bare.close(r)) }
})
