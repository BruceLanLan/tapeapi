// handleRequest()：不依赖 node:http 的 Fetch API 入口（Cloudflare Workers / Deno / Bun）。
// The Fetch-API entry point, which is what lets this runtime exist on Cloudflare Workers, Deno or Bun.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createProvider, memoryStore, VERSION } from '../src/index.js'
import { createFakeChain, ADDR } from '../../sdk/test/helpers/fake-chain.mjs'
import { privateKeyToAddress, signDigest, delegationDigest } from '../../sdk/src/sig.js'
import { readFileSync } from 'node:fs'

const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32)
const signer = privateKeyToAddress(SIGNER_KEY)
const EXPIRES = Math.floor(Date.now() / 1000) + 86400
const RPC = ['http://rpc1', 'http://rpc2']

const manifest = () => ({
  tapeapi: '0.1', name: 'Worker Reader', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
  delegation: { expires: EXPIRES, sig: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires: EXPIRES }), HOLDER_KEY) },
  endpoints: { live: ['https://api.example.com/tapeapi/v1'], async: false },
  methods: [{ name: 'blockNumber', priceBEM: '0', params: {}, returns: { blockNumber: 'number' } }],
})
const mk = (extra = {}) => createProvider({
  minVoucherLifeS: 0, manifest: manifest(), signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56,
  fetch: createFakeChain().fetch, log: () => {}, methods: { blockNumber: async (_p, ctx) => ({ blockNumber: ctx.block }) }, ...extra,
})
const req = (url, init) => new Request(`https://api.example.com${url}`, init)
const post = (m, body, headers) => req(`/tapeapi/v1/${m}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

test('VERSION is a literal and still matches package.json (no node:module import at module scope)', () => {
  assert.equal(VERSION, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
})

test('handleRequest serves the manifest, health, a signed free call, and the error routes', async () => {
  const p = mk()
  const man = await p.handleRequest(req('/.well-known/tapeapi.json'))
  assert.equal(man.status, 200)
  assert.equal(man.headers.get('access-control-allow-origin'), '*')
  assert.equal((await man.json()).signer, signer)

  const h = await (await p.handleRequest(req('/tapeapi/v1/health'))).json()
  assert.equal(h.ok, true); assert.equal(h.version, VERSION); assert.equal(h.rateLimit.free, 600)

  const r = await p.handleRequest(post('blockNumber', { id: 'w1', params: {} }))
  assert.equal(r.status, 200)
  const env = await r.json()
  assert.equal(env.ok, true); assert.equal(env.id, 'w1')
  assert.match(env.sig, /^0x[0-9a-f]{130}$/i)

  // `health` also matches the method-name grammar, so a POST to it is dispatched as a method and rejected as
  // one -- the same as the node http path. / `health` 同样符合方法名语法，POST 会被当方法派发并按方法拒绝，与 node 路径一致。
  const asMethod = await p.handleRequest(post('health', { id: 'h', params: {} }))
  assert.equal((await asMethod.json()).error.code, 'METHOD_NOT_FOUND')
  assert.equal((await p.handleRequest(req('/tapeapi/v1/blockNumber'))).status, 405)
  assert.equal((await p.handleRequest(req('/nope'))).status, 404)
  assert.equal((await p.handleRequest(req('/tapeapi/v1/blockNumber', { method: 'OPTIONS' }))).status, 204)
  const badJson = await p.handleRequest(req('/tapeapi/v1/blockNumber', { method: 'POST', body: '{oops' }))
  assert.equal(badJson.status, 400)
  assert.equal((await badJson.json()).error.code, 'BAD_REQUEST')
})

test('handleRequest rate limits on the identity the host supplies, never on a header a client can forge', async () => {
  const p = mk({ rateLimit: { windowMs: 60_000, free: 2, paid: 10 } })
  // The host passes the identity (a Worker hands over the edge's cf-connecting-ip); a header alone is not trusted.
  // 身份由宿主传入（Worker 交出边缘设置的 cf-connecting-ip）；单凭一个请求头不被信任。
  const call = (ip) => p.handleRequest(post('blockNumber', { id: 'x', params: {} }, { 'cf-connecting-ip': ip }), { clientIp: ip })
  assert.equal((await call('1.1.1.1')).status, 200)
  assert.equal((await call('1.1.1.1')).status, 200)
  const limited = await call('1.1.1.1')
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers.get('retry-after')) > 0)
  assert.equal((await limited.json()).error.code, 'RATE_LIMITED')
  // a different caller has its own budget / 另一个调用方有自己的预算
  assert.equal((await call('2.2.2.2')).status, 200)
  // the header is ignored in favour of the identity the host vouches for / 以宿主担保的身份为准，忽略请求头
  assert.equal((await p.handleRequest(post('blockNumber', { id: 'y', params: {} }, { 'cf-connecting-ip': '2.2.2.2' }), { clientIp: '1.1.1.1' })).status, 429)
  // and without clientIp, a forged header does not buy a fresh budget / 没有 clientIp 时，伪造请求头换不来新的预算
  const codes = []
  for (let i = 0; i < 4; i++) codes.push((await p.handleRequest(post('blockNumber', { id: `z${i}`, params: {} }, { 'cf-connecting-ip': `9.9.9.${i}` }))).status)
  assert.deepEqual(codes, [200, 200, 429, 429])
})

test('memoryStore.advance is an atomic monotonic write-back, and a store without it is reported', async () => {
  const s = memoryStore()
  const rec = (n) => ({ consumer: 'c', provider: 'p', cumulative: String(n), expires: 1, sig: '0x', signer: 's', updatedAt: 1 })
  assert.equal(await s.advance('c', 'p', rec(10)), true)
  assert.equal(await s.advance('c', 'p', rec(20)), true)
  assert.equal(await s.advance('c', 'p', rec(15)), false, 'a lower cumulative must not win')
  assert.equal(await s.advance('c', 'p', rec(20)), false, 'nor an equal one')
  assert.equal((await s.get('c', 'p')).cumulative, '20')
  // The race the fallback loses: many concurrent advances, highest must survive.
  // 回退路径会输掉的竞争：大量并发推进，最高的那个必须留下。
  const s2 = memoryStore()
  await Promise.all([...Array(200)].map((_, i) => s2.advance('c', 'p', rec(i + 1))))
  assert.equal((await s2.get('c', 'p')).cumulative, '200')

  assert.equal(mk().stats().singleInstance, false, 'the default store is instance-safe')
  const legacy = { get: s.get, set: s.set, all: s.all }
  assert.equal(mk({ store: legacy }).stats().singleInstance, true, 'a store without advance() is flagged')
})
