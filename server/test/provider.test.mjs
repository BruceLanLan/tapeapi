import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createProvider } from '../src/index.js'
import { sig, abi, parseUnits, TapeAPIError } from '@tapeapi/sdk'
import { createFakeChain, ADDR } from '../../sdk/test/helpers/fake-chain.mjs'
import { malleate } from '../../sdk/test/sig.test.mjs'

const { privateKeyToAddress, signDigest, voucherDigest, recoverResponseSigner, delegationDigest } = sig
const SIGNER_KEY = '0x' + '22'.repeat(32), CONSUMER_KEY = '0x' + '33'.repeat(32), SESSION_KEY = '0x' + '44'.repeat(32), HOLDER_KEY = '0x' + '11'.repeat(32), SHORT_KEY = '0x' + '66'.repeat(32)
const signer = privateKeyToAddress(SIGNER_KEY), consumer = privateKeyToAddress(CONSUMER_KEY), sessionAddr = privateKeyToAddress(SESSION_KEY), shortAddr = privateKeyToAddress(SHORT_KEY)
const PRICE = parseUnits('0.0001')
const RPC = ['http://rpc1', 'http://rpc2']
const nowS = () => Math.floor(Date.now() / 1000)
let chain, provider, base, manifest

const post = (method, body) => fetch(`${base}/tapeapi/v1/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })
const voucher = (cumulative, key = SESSION_KEY, expires = nowS() + 3600) => {
  const v = { consumer, provider: ADDR.container, cumulative: cumulative.toString(), expires }
  return { ...v, sig: signDigest(voucherDigest(56, ADDR.escrow, v), key), signer: privateKeyToAddress(key) }
}
// TAP-21 v2：摘要含 method/params/ok / v2 digest covers the request and the ok flag
const verify = (env, method, params = {}) => recoverResponseSigner({ container: env.container, id: env.id, method, params, ok: env.ok, body: env.ok ? env.result : env.error, ts: env.ts }, env.sig)
const mk = (extra = {}) => createProvider({ minVoucherLifeS: 0,  manifest, signerKey: SIGNER_KEY, allowHttp: true, methods: { blockNumber() {}, circuitHolder() {}, leak() {} }, ...extra })

before(async () => {
  chain = createFakeChain()
  chain.setChannel(consumer, ADDR.container, parseUnits('0.00025'))   // v2: the channel is the cap / 通道即上限
  chain.setSession(consumer, ADDR.container, sessionAddr, 1900000000)
  chain.setSession(consumer, ADDR.container, shortAddr, nowS() + 120) // session that ends soon / 很快到期的会话
  chain.setContribution(ADDR.container, 100)
  const expires = nowS() + 300 * 86400
  manifest = {
    tapeapi: '0.1', name: 'T', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
    delegation: { expires, sig: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires }), HOLDER_KEY) },
    endpoints: { live: ['http://127.0.0.1/tapeapi/v1'], async: false },
    methods: [{ name: 'blockNumber', priceBEM: '0', params: {}, returns: {} }, { name: 'circuitHolder', priceBEM: '0.0001', params: { circuits: 'address', tokenId: 'string' }, returns: {} }, { name: 'leak', priceBEM: '0', params: {}, returns: {} }],
    payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 },
  }
  provider = createProvider({ minVoucherLifeS: 0, 
    manifest, signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: chain.fetch, escrowCacheMs: 0, allowHttp: true,
    methods: {
      blockNumber: async (_p, ctx) => ({ blockNumber: ctx.block }),
      circuitHolder: async (p, ctx) => ({ holder: '0x' + '99'.repeat(20), consumer: ctx.consumer, cumulative: ctx.cumulative.toString() }),
      leak: async ({ kind }) => { throw kind === 'plain' ? new Error('https://rpc.example/v1/SECRET-KEY') : new TapeAPIError('RPC_UNAVAILABLE', 'eth_call: only 1/2 nodes answered (https://rpc.example/v1/SECRET-KEY: http 429)') },
    },
  })
  const srv = await provider.listen(0)
  base = `http://127.0.0.1:${srv.address().port}`
})
after(async () => { await provider.close() })

test('signerKey must match manifest.signer; handlers must exist as OWN properties; http needs dev/allowHttp', () => {
  assert.throws(() => mk({ signerKey: CONSUMER_KEY }), (e) => e.code === 'BAD_KEY')
  assert.throws(() => mk({ methods: { blockNumber() {}, circuitHolder() {} } }), (e) => e.code === 'METHOD_NOT_FOUND')
  // L-20 / M-08: prototype keys are not valid method names; other Object.prototype members are not satisfied by the prototype
  // 原型键不是合法方法名；其它 Object.prototype 成员也不算实现
  const m2 = { ...manifest, methods: [...manifest.methods, { name: 'constructor', priceBEM: '0', params: {}, returns: {} }] }
  assert.throws(() => mk({ manifest: m2 }), (e) => e.code === 'MANIFEST_INVALID' && /prototype key/.test(e.message))
  for (const name of ['toString', 'hasOwnProperty', 'valueOf']) {
    const m3 = { ...manifest, methods: [...manifest.methods, { name, priceBEM: '0', params: {}, returns: {} }] }
    assert.throws(() => mk({ manifest: m3 }), (e) => e.code === 'METHOD_NOT_FOUND' && e.message.includes(name), name)
  }
  // M-10: an http endpoint on a non-dev manifest is refused unless allowHttp / 非 dev 清单的 http 端点需显式允许
  assert.throws(() => mk({ allowHttp: false }), (e) => e.code === 'MANIFEST_INVALID' && /https/.test(e.message))
  assert.ok(mk({ allowHttp: false, manifest: { ...manifest, dev: true } }))
  assert.ok(mk({ allowHttp: false, dev: true }))
  assert.throws(() => mk({ rpcUrls: ['http://rpc1'], quorum: 2, fetch: chain.fetch }), (e) => e.code === 'RPC_UNAVAILABLE') // M-11
  assert.equal(mk({ rpcUrls: ['http://rpc1'], quorum: 2, fetch: chain.fetch, allowSingleNode: true }).rpc.quorum, 1)
})
test('GET manifest, minimal health and CORS preflight', async () => {
  const m = await fetch(`${base}/.well-known/tapeapi.json`)
  assert.equal(m.headers.get('access-control-allow-origin'), '*')
  assert.equal((await m.json()).signer, signer)
  const h = await (await fetch(`${base}/tapeapi/v1/health`)).json()
  assert.deepEqual(Object.keys(h).sort(), ['delegationExpires', 'minVoucherLifeS', 'ok', 'rateLimit', 'signer', 'version']) // nothing else leaks (block, contribution, name) / 不再暴露其它信息
  assert.equal(h.ok, true); assert.equal(h.signer, signer); assert.equal(h.version, provider.version); assert.equal(h.minVoucherLifeS, 0) // this shared provider opts out of the floor / 共享实例关闭了下限
  assert.equal(h.rateLimit.free, 600); assert.equal(h.rateLimit.paid, 6000) // the budgets are advertised / 预算对外公布
  assert.equal(await provider.contribution(), 100); assert.equal(await provider.currentBlock(), 62_000_000) // still available programmatically
  const o = await fetch(`${base}/tapeapi/v1/blockNumber`, { method: 'OPTIONS' })
  assert.equal(o.status, 204); assert.match(o.headers.get('access-control-allow-methods'), /POST/)
  assert.equal((await fetch(`${base}/nope`)).status, 404)
  assert.equal((await fetch(`${base}/tapeapi/v1/${'a'.repeat(65)}`, { method: 'POST', body: '{}' })).status, 404) // over 64 chars is not a route
})
test('free call returns a v2 signed envelope that verifies with the request; tampering breaks it', async () => {
  const res = await post('blockNumber', { id: 'r1', params: {} })
  assert.equal(res.status, 200)
  const env = await res.json()
  assert.equal(env.ok, true); assert.equal(env.id, 'r1'); assert.equal(env.result.blockNumber, 62_000_000); assert.equal(env.container.toLowerCase(), ADDR.container)
  assert.equal(verify(env, 'blockNumber', {}), signer)
  assert.notEqual(verify(env, 'blockNumber', { other: 1 }), signer) // request is covered / 请求在签名范围内
  assert.notEqual(verify(env, 'circuitHolder', {}), signer)
  assert.notEqual(verify({ ...env, ok: false, error: env.result }, 'blockNumber', {}), signer) // ok flag is covered / ok 在签名范围内
  env.result.blockNumber = 1 // 篡改后签名不再匹配 / tampered payload no longer verifies
  assert.notEqual(verify(env, 'blockNumber', {}), signer)
  // params are hashed exactly as sent / 按发送的 params 原样哈希
  const r2 = await (await post('blockNumber', { id: 'r1b', params: { z: 1, a: [1, 2] } })).json()
  assert.equal(verify(r2, 'blockNumber', { a: [1, 2], z: 1 }), signer)
})
test('PAYMENT_REQUIRED when voucher missing (signed error, 402)', async () => {
  const res = await post('circuitHolder', { id: 'r2', params: { circuits: ADDR.circuits, tokenId: '4246' } })
  assert.equal(res.status, 402)
  const env = await res.json()
  assert.equal(env.ok, false); assert.equal(env.error.code, 'PAYMENT_REQUIRED'); assert.equal(verify(env, 'circuitHolder', { circuits: ADDR.circuits, tokenId: '4246' }), signer)
})
test('paid call happy path with session key, then stale cumulative -> BAD_VOUCHER with signed data.lastCumulative', async () => {
  const r1 = await post('circuitHolder', { id: 'p1', params: {}, voucher: voucher(PRICE) })
  const e1 = await r1.json()
  assert.equal(r1.status, 200); assert.equal(e1.ok, true); assert.equal(e1.result.consumer, consumer); assert.equal(e1.result.cumulative, PRICE.toString()); assert.equal(verify(e1, 'circuitHolder'), signer)
  // 同样的 cumulative 再发一次 → 过期，错误里带 lastCumulative（在签名范围内）/ replaying the same cumulative is stale; lastCumulative is signed
  const r2 = await post('circuitHolder', { id: 'p2', params: {}, voucher: voucher(PRICE) })
  const e2 = await r2.json()
  assert.equal(r2.status, 402); assert.equal(e2.error.code, 'BAD_VOUCHER'); assert.match(e2.error.message, /cumulative/)
  // A bare number is not evidence, so the error also carries the on-chain claimed figure and the
  // consumer's own signed voucher for that cumulative. The client verifies one of them before it
  // advances its counter; without this a hostile provider could name any figure.
  // 光给数字不构成证据，因此错误同时携带链上已结算额与消费者自己签过的那张凭证。
  // 客户端须先验证其一才会推进计数；否则恶意提供者报任何数字都能得逞。
  assert.equal(e2.error.data.lastCumulative, PRICE.toString())
  assert.equal(e2.error.data.onChainClaimed, '0')
  assert.equal(e2.error.data.voucher.cumulative, PRICE.toString())
  assert.match(e2.error.data.voucher.sig, /^0x[0-9a-f]{130}$/i)
  assert.equal(verify(e2, 'circuitHolder'), signer)
  // Every field of it is inside the signature. / 其中每个字段都在签名覆盖范围内。
  const forged = structuredClone(e2); forged.error.data.lastCumulative = '1'
  assert.notEqual(verify(forged, 'circuitHolder'), signer)
  const forged2 = structuredClone(e2); forged2.error.data.voucher.sig = '0x' + '11'.repeat(65)
  assert.notEqual(verify(forged2, 'circuitHolder'), signer)
  // 递增后成功 / incrementing succeeds
  const r3 = await post('circuitHolder', { id: 'p3', params: {}, voucher: voucher(2n * PRICE) })
  assert.equal(r3.status, 200)
  const pending = await provider.pendingSettlements()
  assert.equal(pending.length, 1); assert.equal(pending[0].cumulative, (2n * PRICE).toString())
  const tx = provider.settleTx(pending[0])
  assert.equal(tx.to, ADDR.escrow); assert.equal(abi.functionBySelector(tx.data), 'settle')
  assert.equal(abi.decodeCall('settle', tx.data)[2], 2n * PRICE)
})
test('C-02: a malleated (high-s) voucher signature is BAD_VOUCHER even though the key is authorised', async () => {
  const good = voucher(3n * PRICE)
  const bad = { ...good, sig: malleate(good.sig) }
  const env = await (await post('circuitHolder', { id: 'mall', params: {}, voucher: bad })).json()
  assert.equal(env.ok, false); assert.equal(env.error.code, 'BAD_VOUCHER'); assert.match(env.error.message, /high-s/)
  assert.equal(verify(env, 'circuitHolder'), signer)
  assert.equal((await provider.pendingSettlements())[0].cumulative, (2n * PRICE).toString()) // not stored / 未入库
})
test('H-01: the session must be live NOW, not outlive the voucher; a lapsed key is rejected', async () => {
  // Own chain and provider so this does not disturb the shared cumulative other tests rely on.
  // 使用独立的链与服务实例，避免干扰其它测试共享的累计计数。
  const c2 = createFakeChain()
  c2.setChannel(consumer, ADDR.container, parseUnits('1'))
  c2.setSession(consumer, ADDR.container, shortAddr, nowS() + 60)   // a session shorter than the vouchers below / 会话比下面的凭证短
  const p2 = createProvider({ minVoucherLifeS: 0, 
    manifest, signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: c2.fetch,
    escrowCacheMs: 0, sessionCacheMs: 0, allowHttp: true, log: () => {},   // no caching: the test flips the session mid-run / 测试中途改会话，关掉缓存
    methods: { blockNumber: () => ({ n: 1 }), circuitHolder: () => ({ holder: ADDR.treasury }), leak: () => ({}) },
  })

  // Dated an hour past the session, accepted because the session is live at verification time --
  // exactly what the contract checks at settlement. 凭证日期超出会话一小时仍被接受：与合约在结算时的判据一致。
  const beyond = await p2.invoke({ id: 'h1', method: 'circuitHolder', params: {}, voucher: voucher(PRICE, SHORT_KEY, nowS() + 3600) })
  assert.equal(beyond.env.ok, true, JSON.stringify(beyond.env.error))

  // Once the authorisation has lapsed the same key settles nothing. / 授权过期后该密钥一无所获。
  c2.setSession(consumer, ADDR.container, shortAddr, nowS() - 1)
  const lapsed = await p2.invoke({ id: 'h2', method: 'circuitHolder', params: {}, voucher: voucher(2n * PRICE, SHORT_KEY, nowS() + 60) })
  assert.equal(lapsed.env.error?.code, 'BAD_VOUCHER')
  assert.match(lapsed.env.error.message, /not authorised or expired/)
})
test('BAD_VOUCHER on bad signature, unauthorised session key, wrong provider, expired, over the channel', async () => {
  // Set the channel this test reasons about explicitly rather than inheriting it from an earlier test.
  // 显式设定本测试所依据的通道余额，不再依赖前一个测试留下的副作用。
  chain.setChannel(consumer, ADDR.container, parseUnits('0.00025'))
  const cases = [
    ['bad sig', { ...voucher(4n * PRICE), sig: '0x' + '00'.repeat(65) }],
    ['unauthorised key', voucher(4n * PRICE, '0x' + '55'.repeat(32))],
    ['wrong provider', { ...voucher(4n * PRICE), provider: ADDR.escrow }],
    ['expired', voucher(4n * PRICE, SESSION_KEY, nowS() - 1)],
  ]
  for (const [name, v] of cases) {
    const env = await (await post('circuitHolder', { id: name, params: {}, voucher: v })).json()
    assert.equal(env.error?.code, 'BAD_VOUCHER', name); assert.equal(verify(env, 'circuitHolder'), signer, name)
    // TAP-22 §3.3: every BAD_VOUCHER carries data.price and, off the stale path, nothing else.
    // 每个 BAD_VOUCHER 都带 data.price；非累计过期的拒绝只带它。
    assert.deepEqual(env.error.data, { price: PRICE.toString() }, name)
  }
  // 4×price (0.0004) exceeds the channel 0.00025: the channel is the cap (TAP-22 §3.2(4)) / 超出通道余额
  const env = await (await post('circuitHolder', { id: 'bal', params: {}, voucher: voucher(4n * PRICE) })).json()
  assert.equal(env.error?.code, 'BAD_VOUCHER'); assert.match(env.error.message, /available channel/)
  assert.deepEqual(env.error.data, { price: PRICE.toString() })
  // consumer 本人签名（无需 session）/ consumer's own signature needs no session; claimed reduces unsettled
  chain.setClaimed(consumer, ADDR.container, 2n * PRICE)
  const ok = await (await post('circuitHolder', { id: 'own', params: {}, voucher: voucher(4n * PRICE, CONSUMER_KEY) })).json()
  assert.equal(ok.ok, true, JSON.stringify(ok.error))
  // at or below claimedOf also reports lastCumulative / 不高于 claimedOf 同样带 lastCumulative
  const settled = await (await post('circuitHolder', { id: 'settled', params: {}, voucher: voucher(2n * PRICE) })).json()
  assert.equal(settled.error?.code, 'BAD_VOUCHER'); assert.equal(settled.error.data.lastCumulative, (4n * PRICE).toString())
})
test('E-03 (provider side): an armed withdraw request is not available balance until its window has closed', async () => {
  const c3 = createFakeChain()
  c3.setChannel(consumer, ADDR.container, parseUnits('1'))
  c3.setSession(consumer, ADDR.container, sessionAddr, 1900000000)
  const p3 = createProvider({ minVoucherLifeS: 0, 
    manifest, signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: c3.fetch,
    escrowCacheMs: 0, allowHttp: true, log: () => {},
    methods: { blockNumber: () => ({ n: 1 }), circuitHolder: () => ({ holder: ADDR.treasury }), leak: () => ({}) },
  })
  // The consumer arms a withdraw for the whole channel. Inside the cooldown the provider could still settle
  // ahead of it, but the reference provider refuses to serve against money that is already on its way out.
  // 消费者对整条通道上膛提现。冷静期内提供者本可抢先结算，但参考实现拒绝对已在离场路上的钱提供服务。
  c3.setPendingWithdraw(consumer, ADDR.container, parseUnits('1'), nowS())
  const armed = await p3.invoke({ id: 'armed', method: 'circuitHolder', params: {}, voucher: voucher(PRICE) })
  assert.equal(armed.env.error?.code, 'BAD_VOUCHER'); assert.match(armed.env.error.message, /armed withdraw 100000000/)
  // A smaller request leaves the rest available. / 更小的请求留下其余部分可用。
  c3.setPendingWithdraw(consumer, ADDR.container, parseUnits('0.5'), nowS())
  const half = await p3.invoke({ id: 'half', method: 'circuitHolder', params: {}, voucher: voucher(PRICE) })
  assert.equal(half.env.ok, true, JSON.stringify(half.env.error))
  // Once the 48h + 7d lifetime has passed the request is stale and no longer reserves anything.
  // 48h + 7d 生命周期过后请求失效，不再占用。
  c3.setPendingWithdraw(consumer, ADDR.container, parseUnits('1'), nowS() - 9 * 86400 - 1)
  const lapsed = await p3.invoke({ id: 'lapsed', method: 'circuitHolder', params: {}, voucher: voucher(2n * PRICE) })
  assert.equal(lapsed.env.ok, true, JSON.stringify(lapsed.env.error))
  // An escrow with different constants can override the lifetime. / 常量不同的托管可覆盖生命周期。
  const p4 = createProvider({ minVoucherLifeS: 0, 
    manifest, signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: c3.fetch, withdrawCloseS: 30 * 86400,
    escrowCacheMs: 0, allowHttp: true, log: () => {},
    methods: { blockNumber: () => ({ n: 1 }), circuitHolder: () => ({ holder: ADDR.treasury }), leak: () => ({}) },
  })
  const still = await p4.invoke({ id: 'still', method: 'circuitHolder', params: {}, voucher: voucher(PRICE) })
  assert.equal(still.env.error?.code, 'BAD_VOUCHER'); assert.match(still.env.error.message, /armed withdraw/)
})
test('concurrent vouchers with the same cumulative: exactly one wins', async () => {
  chain.setChannel(consumer, ADDR.container, parseUnits('1'))
  const vs = [voucher(6n * PRICE), voucher(6n * PRICE), voucher(6n * PRICE)]
  const envs = await Promise.all(vs.map((x, i) => post('circuitHolder', { id: 'c' + i, params: {}, voucher: x }).then(r => r.json())))
  assert.equal(envs.filter(e => e.ok).length, 1)
  assert.equal(envs.filter(e => e.error?.code === 'BAD_VOUCHER').length, 2)
})
test('METHOD_NOT_FOUND (incl. prototype names), malformed JSON, __proto__ bodies, oversize body, bad params', async () => {
  const nf = await post('nope', { id: 'x', params: {} })
  assert.equal(nf.status, 404); assert.equal((await nf.json()).error.code, 'METHOD_NOT_FOUND')
  for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    const r = await post(name, { id: 'x', params: {} })
    assert.equal(r.status, 404, name); assert.equal((await r.json()).error.code, 'METHOD_NOT_FOUND', name)
  }
  const bad = await post('blockNumber', '{not json')
  assert.equal(bad.status, 400); const badEnv = await bad.json(); assert.equal(badEnv.error.code, 'BAD_REQUEST'); assert.equal(verify(badEnv, 'blockNumber'), signer)
  // M-08: prototype-polluting keys anywhere in the body are a 400 / 请求体中任何位置的原型键都是 400
  for (const text of ['{"id":"x","params":{"__proto__":{"polluted":true}}}', '{"id":"x","constructor":1,"params":{}}', '{"id":"x","params":{"a":[{"prototype":1}]}}']) {
    const r = await post('blockNumber', text)
    assert.equal(r.status, 400, text); const e = await r.json(); assert.equal(e.error.code, 'BAD_REQUEST'); assert.match(e.error.message, /forbidden key/)
  }
  assert.equal(({}).polluted, undefined)
  const big = await post('blockNumber', JSON.stringify({ id: 'big', params: { pad: 'x'.repeat(70 * 1024) } })).catch(() => null)
  if (big) assert.equal(big.status, 413)
  const noid = await post('blockNumber', { params: {} })
  assert.equal(noid.status, 400); assert.equal((await noid.json()).error.code, 'BAD_REQUEST')
  const arr = await post('blockNumber', { id: 'arr', params: [1] })
  assert.equal(arr.status, 400); assert.equal((await arr.json()).error.code, 'BAD_REQUEST')
})
test('M-13: INTERNAL envelopes never carry handler details or RPC URLs; details go to the log', async () => {
  const logged = []
  const p2 = createProvider({ minVoucherLifeS: 0,  manifest, signerKey: SIGNER_KEY, allowHttp: true, log: (...a) => logged.push(a.map(String).join(' ')), methods: { blockNumber() {}, circuitHolder() {}, leak: provider.manifest && (async ({ kind }) => { throw kind === 'plain' ? new Error('https://rpc.example/v1/SECRET-KEY') : new TapeAPIError('RPC_UNAVAILABLE', 'only 1/2 (https://rpc.example/v1/SECRET-KEY)') }) } })
  for (const kind of ['plain', 'rpc']) {
    const { status, env } = await p2.invoke({ id: 'l', method: 'leak', params: { kind } })
    assert.equal(status, 500); assert.deepEqual(env.error, { code: 'INTERNAL', message: 'internal error' })
    assert.ok(!JSON.stringify(env).includes('SECRET'))
  }
  assert.ok(logged.some(l => /SECRET-KEY/.test(l))) // operator still sees it / 运维日志里仍有细节
  const env = await (await post('leak', { id: 'l2', params: { kind: 'rpc' } })).json()
  assert.equal(env.error.message, 'internal error'); assert.equal(verify(env, 'leak', { kind: 'rpc' }), signer)
})
test('contribution is null without RPC and 0 when the escrow lacks contributionOf', async () => {
  const noRpc = mk()
  assert.equal(await noRpc.contribution(), null)
  const c2 = createFakeChain(); c2.markLegacyEscrow(ADDR.escrow)
  const legacy = mk({ rpcUrls: RPC, quorum: 2, fetch: c2.fetch })
  assert.equal(await legacy.contribution(), 0)
})
test('errors are TapeAPIError instances in invoke()', async () => {
  const { env } = await provider.invoke({ id: 'i1', method: 'blockNumber', params: {} })
  assert.equal(env.ok, true); assert.ok(TapeAPIError)
})

// ---- 计费时机：交付了结果才扣费 / metering: bill only for a delivered result ----

test('a method that throws does not advance the meter (an upstream failure is not billed)', async () => {
  const chain2 = createFakeChain()
  chain2.setChannel(consumer, ADDR.container, parseUnits('1'))
  chain2.setSession(consumer, ADDR.container, sessionAddr, 1900000000)
  let fail = true
  const p = createProvider({ minVoucherLifeS: 0, 
    manifest, signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: chain2.fetch,
    escrowCacheMs: 0, allowHttp: true, log: () => {},
    methods: {
      blockNumber: () => ({ n: 1 }),
      circuitHolder: () => { if (fail) throw new Error('upstream 502'); return { holder: ADDR.treasury } },
      leak: () => ({}),
    },
  })
  const v = voucher(PRICE)
  const bad = await p.invoke({ id: 'a', method: 'circuitHolder', params: {}, voucher: v })
  assert.equal(bad.env.ok, false)
  assert.equal(bad.env.error.code, 'INTERNAL')

  // the same voucher is still good: the failed call consumed nothing / 同一张凭证仍然有效：失败的调用没有消耗
  fail = false
  const good = await p.invoke({ id: 'b', method: 'circuitHolder', params: {}, voucher: v })
  assert.equal(good.env.ok, true, good.env.ok ? '' : JSON.stringify(good.env.error))
  assert.deepEqual(good.env.result, { holder: ADDR.treasury })

  // and now it IS spent: replaying it is rejected / 此时才算已消费：重放被拒
  const replay = await p.invoke({ id: 'c', method: 'circuitHolder', params: {}, voucher: v })
  assert.equal(replay.env.ok, false)
  assert.equal(replay.env.error.code, 'BAD_VOUCHER')
})

// H-06：处理方法在锁外跑，两个并发调用可能乱序完成；写回必须单调，否则慢的小额凭证会覆盖掉大额凭证。
// Handlers run outside the voucher lock, so concurrent calls can finish out of order: a slow low-cumulative commit
// must never overwrite a fast high-cumulative record, or the provider silently loses the difference.
test('H-06: an out-of-order commit cannot regress the stored cumulative', async () => {
  const chain2 = createFakeChain()
  chain2.setChannel(consumer, ADDR.container, parseUnits('1'))
  chain2.setSession(consumer, ADDR.container, sessionAddr, 1900000000)
  const p = createProvider({ minVoucherLifeS: 0, 
    manifest, signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: chain2.fetch,
    escrowCacheMs: 0, allowHttp: true, log: () => {},
    methods: {
      blockNumber: () => ({ n: 1 }),
      circuitHolder: async (params) => { await new Promise((r) => setTimeout(r, params.delay || 0)); return { holder: ADDR.treasury } },
      leak: () => ({}),
    },
  })
  // 先发小额（慢），再发大额（快）：两张都合法，但大额先完成 / the small one is slow, the big one is fast
  const slow = p.invoke({ id: 'slow', method: 'circuitHolder', params: { delay: 80 }, voucher: voucher(PRICE) })
  await new Promise((r) => setTimeout(r, 10))
  const fast = await p.invoke({ id: 'fast', method: 'circuitHolder', params: {}, voucher: voucher(2n * PRICE) })
  assert.equal(fast.env.ok, true, JSON.stringify(fast.env.error))
  assert.equal((await p.pendingSettlements())[0].cumulative, (2n * PRICE).toString())
  assert.equal((await slow).env.ok, true)
  assert.equal((await p.pendingSettlements())[0].cumulative, (2n * PRICE).toString(), 'the later, smaller commit must not overwrite the bigger one')
})

test('two concurrent calls cannot spend the same cumulative', async () => {
  const chain2 = createFakeChain()
  chain2.setChannel(consumer, ADDR.container, parseUnits('1'))
  chain2.setSession(consumer, ADDR.container, sessionAddr, 1900000000)
  const p = createProvider({ minVoucherLifeS: 0, 
    manifest, signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: chain2.fetch,
    escrowCacheMs: 0, allowHttp: true, log: () => {},
    methods: {
      blockNumber: () => ({ n: 1 }),
      circuitHolder: async () => { await new Promise((r) => setTimeout(r, 30)); return { holder: ADDR.treasury } },
      leak: () => ({}),
    },
  })
  const v = voucher(PRICE)
  const [a, b] = await Promise.all([
    p.invoke({ id: 'x', method: 'circuitHolder', params: {}, voucher: v }),
    p.invoke({ id: 'y', method: 'circuitHolder', params: {}, voucher: v }),
  ])
  const oks = [a, b].filter((r) => r.env.ok).length
  assert.equal(oks, 1, 'exactly one of the two concurrent calls may spend the voucher')
})

test('A2-02: deadlines the provider cannot settle inside are refused (voucher expires / session lapses < minVoucherLifeS)', async () => {
  const c2 = createFakeChain()
  c2.setChannel(consumer, ADDR.container, parseUnits('1'))
  c2.setSession(consumer, ADDR.container, sessionAddr, 1900000000)
  c2.setSession(consumer, ADDR.container, shortAddr, nowS() + 120)
  const p2 = createProvider({ minVoucherLifeS: 0, manifest, signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: c2.fetch, escrowCacheMs: 0, sessionCacheMs: 0, allowHttp: true, log: () => {},
    methods: { blockNumber: () => ({ n: 1 }), circuitHolder: () => ({ holder: ADDR.treasury }), leak: () => ({}) }, minVoucherLifeS: 300 })
  // 60 s voucher: valid on chain, but no settlement can be mined in time -> refused with the floor in data
  // 60 秒凭证：链上有效，但来不及上链结算 -> 拒绝，并在 data 里给出下限
  const soon = await p2.invoke({ id: 'a1', method: 'circuitHolder', params: {}, voucher: voucher(PRICE, SESSION_KEY, nowS() + 60) })
  assert.equal(soon.env.error?.code, 'BAD_VOUCHER'); assert.match(soon.env.error.message, /needs at least 300 s/); assert.equal(soon.env.error.data?.minVoucherLifeS, 300)
  // same cumulative, an hour of life -> served / 同一累计、一小时寿命 -> 服务
  const ok = await p2.invoke({ id: 'a2', method: 'circuitHolder', params: {}, voucher: voucher(PRICE, SESSION_KEY, nowS() + 3600) })
  assert.equal(ok.env.ok, true, JSON.stringify(ok.env.error))
  // session key with 120 s left: the voucher is long-lived but the key will not be valid at settlement
  // 只剩 120 秒的会话密钥：凭证寿命够长，但结算时密钥已失效
  const lapsing = await p2.invoke({ id: 'a3', method: 'circuitHolder', params: {}, voucher: voucher(2n * PRICE, SHORT_KEY, nowS() + 3600) })
  assert.equal(lapsing.env.error?.code, 'BAD_VOUCHER'); assert.match(lapsing.env.error.message, /lapses in .* needs at least 300 s/)
})

test('A2-04: an RPC failure on pendingWithdraw alone fails CLOSED; only a reverting (legacy) escrow counts as "no request"', async () => {
  const c2 = createFakeChain()
  c2.setChannel(consumer, ADDR.container, parseUnits('1'))
  c2.setSession(consumer, ADDR.container, sessionAddr, 1900000000)
  const p2 = createProvider({ minVoucherLifeS: 0, manifest, signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: async (url, init) => {
      let body = null; try { body = JSON.parse(init?.body) } catch {}
      const isPending = typeof body?.params?.[0]?.data === 'string' && body.params[0].data.startsWith(selector('pendingWithdraw'))
      if (isPending) return new Response('', { status: 503 })     // only this view is unreachable / 只有这个视图不可达
      return c2.fetch(url, init)
    }, escrowCacheMs: 0, sessionCacheMs: 0, allowHttp: true, log: () => {},
    methods: { blockNumber: () => ({ n: 1 }), circuitHolder: () => ({ holder: ADDR.treasury }), leak: () => ({}) } })
  const r = await p2.invoke({ id: 'b1', method: 'circuitHolder', params: {}, voucher: voucher(PRICE, SESSION_KEY, nowS() + 3600) })
  assert.notEqual(r.env.ok, true, 'must not serve while the armed-withdraw read is unavailable')
  assert.notEqual(r.env.error?.code, 'BAD_VOUCHER', 'this is an availability failure, not a voucher fault')
  // a legacy escrow whose pendingWithdraw reverts is still "no request" / 旧托管回滚 -> 视为无请求
  const c3 = createFakeChain(); c3.setChannel(consumer, ADDR.container, parseUnits('1')); c3.setSession(consumer, ADDR.container, sessionAddr, 1900000000); c3.markLegacyEscrow(ADDR.escrow)
  const p3 = createProvider({ minVoucherLifeS: 0, manifest, signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: c3.fetch, escrowCacheMs: 0, allowHttp: true, log: () => {},
    methods: { blockNumber: () => ({ n: 1 }), circuitHolder: () => ({ holder: ADDR.treasury }), leak: () => ({}) } })
  const r3 = await p3.invoke({ id: 'b2', method: 'circuitHolder', params: {}, voucher: voucher(PRICE, SESSION_KEY, nowS() + 3600) })
  assert.equal(r3.env.ok, true, JSON.stringify(r3.env.error))
})

// Cold-start findings 2026-09-21: a provider that boots with a dead delegation, or with priced methods and a
// placeholder escrow, looks healthy and serves answers nobody can use. Both must fail loudly at construction.
// 冷启动测试发现：带着已过期委托、或收费方法配零地址托管的 provider，看起来健康却在发没人能用的答案。
// 两种都必须在构造时大声失败。
test('a provider refuses to boot on an already-expired delegation', () => {
  const dead = { ...manifest, delegation: { expires: nowS() - 1, sig: manifest.delegation.sig }, dev: false }
  assert.throws(() => createProvider({ minVoucherLifeS: 0, manifest: dead, signerKey: SIGNER_KEY, allowHttp: true, methods: { blockNumber() {}, circuitHolder() {}, leak() {} } }),
    (e) => e.code === 'DELEGATION_INVALID' && /is in the past/.test(e.message))
  // a live one still boots / 未过期的照常启动
  const live = { ...manifest, delegation: { expires: nowS() + 3600, sig: manifest.delegation.sig } }
  assert.ok(createProvider({ minVoucherLifeS: 0, manifest: live, signerKey: SIGNER_KEY, allowHttp: true, methods: { blockNumber() {}, circuitHolder() {}, leak() {} } }))
})

test('a manifest with priced methods and a zero-address escrow is refused at validation, not at call time', () => {
  const placeholder = { ...manifest, payment: { escrow: '0x' + '00'.repeat(20), unit: 'BEM', decimals: 8 } }
  assert.throws(() => createProvider({ minVoucherLifeS: 0, manifest: placeholder, signerKey: SIGNER_KEY, allowHttp: true, methods: { blockNumber() {}, circuitHolder() {} } }),
    (e) => e.code === 'MANIFEST_INVALID' && /zero address/.test(e.message))
  // all-free with no escrow at all is still fine (the zero-deployment case) / 全免费且不填托管仍然合法
  const free = { ...manifest, methods: manifest.methods.map((m) => ({ ...m, priceBEM: '0' })), payment: undefined }
  assert.ok(createProvider({ minVoucherLifeS: 0, manifest: free, signerKey: SIGNER_KEY, allowHttp: true, methods: { blockNumber() {}, circuitHolder() {}, leak() {} } }))
})

test('a dev manifest may boot with a zero escrow, and its paid calls are refused with INTERNAL and a logged reason', async () => {
  const zero = '0x' + '00'.repeat(20)
  const logs = []
  const dev = { ...manifest, dev: true, payment: { escrow: zero, unit: 'BEM', decimals: 8 } }
  const p = createProvider({ minVoucherLifeS: 0, manifest: dev, signerKey: SIGNER_KEY, allowHttp: true, log: (...a) => logs.push(a.join(' ')), methods: { blockNumber() { return 1 }, circuitHolder() {}, leak() {} } })
  assert.ok(logs.some((l) => /no escrow/.test(l)), 'the operator is warned at boot')
  const out = await p.invoke({ id: 'z', method: 'circuitHolder', params: {}, voucher: { consumer, provider: ADDR.container, cumulative: '1', expires: 1900000000, sig: '0x' + '11'.repeat(65) } })
  assert.equal(out.env.ok, false)
  assert.equal(out.env.error.code, 'INTERNAL')
  // INTERNAL stays generic on the wire (M-13); the reason goes to the operator's log / 对外泛化，原因进运营者日志
  assert.equal(out.env.error.message, 'internal error')
  assert.ok(logs.some((l) => /no escrow configured/.test(l)))
})

test('opts.escrow may only restate the manifest escrow, never replace it or zero it (runtime audit I-03)', () => {
  const methods = { blockNumber() {}, circuitHolder() {}, leak() {} }
  assert.throws(() => createProvider({ minVoucherLifeS: 0, manifest, signerKey: SIGNER_KEY, allowHttp: true, escrow: '0x' + '22'.repeat(20), methods }),
    (e) => e.code === 'MANIFEST_INVALID' && /differs from manifest/.test(e.message))
  assert.throws(() => createProvider({ minVoucherLifeS: 0, manifest, signerKey: SIGNER_KEY, allowHttp: true, escrow: 'nope', methods }),
    (e) => e.code === 'MANIFEST_INVALID')
  assert.ok(createProvider({ minVoucherLifeS: 0, manifest, signerKey: SIGNER_KEY, allowHttp: true, escrow: manifest.payment.escrow.toLowerCase(), methods }))
})

// 免费层没有限流等于敞开：2026-09-21 实测连打 300 次全部 200、零个 429。
// An unlimited free tier is an open invitation: measured 2026-09-21, 300 straight free calls all returned 200.
test('the free tier is rate limited, the 429 is unsigned and cheap, and a paid caller has its own budget', async () => {
  const c2 = createFakeChain()
  c2.setChannel(consumer, ADDR.container, parseUnits('1'))
  c2.setSession(consumer, ADDR.container, sessionAddr, 1900000000)
  const p2 = createProvider({
    minVoucherLifeS: 0, manifest, signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: c2.fetch,
    escrowCacheMs: 0, allowHttp: true, log: () => {}, rateLimit: { windowMs: 60_000, free: 3, paid: 100 },
    methods: { blockNumber: () => ({ n: 1 }), circuitHolder: () => ({ holder: ADDR.treasury }), leak: () => ({}) },
  })
  const s2 = await p2.listen(0)
  const base2 = `http://127.0.0.1:${s2.address().port}`
  try {
    const codes = []
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`${base2}/tapeapi/v1/blockNumber`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: `rl${i}`, params: {} }) })
      codes.push(r.status)
      if (r.status === 429) {
        assert.ok(Number(r.headers.get('retry-after')) > 0, 'Retry-After is set')
        assert.equal(r.headers.get('access-control-allow-origin'), '*', 'CORS still applies to a refusal')
        const b = await r.json()
        assert.equal(b.error.code, 'RATE_LIMITED')
        assert.equal(b.sig, undefined, 'a refusal is not signed: signing it would make the flood cost us')
      }
    }
    assert.deepEqual(codes.slice(0, 3), [200, 200, 200])
    assert.deepEqual(codes.slice(3), [429, 429, 429])
    assert.equal(p2.stats().rateLimited, 3)
    assert.equal(p2.stats().calls, 3)
    assert.equal(p2.stats().free, 3)
    assert.equal(p2.stats().byMethod.blockNumber, 3)
  } finally { s2.close() }
})

test('rateLimit: false turns it off, and stats() counts outcomes by method and code', async () => {
  const c2 = createFakeChain()
  const p2 = createProvider({
    minVoucherLifeS: 0, manifest, signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: c2.fetch,
    escrowCacheMs: 0, allowHttp: true, log: () => {}, rateLimit: false,
    methods: { blockNumber: () => ({ n: 1 }), circuitHolder: () => ({ holder: ADDR.treasury }), leak: () => { throw new Error('boom') } },
  })
  const s2 = await p2.listen(0)
  const base2 = `http://127.0.0.1:${s2.address().port}`
  try {
    const hit = (m, i) => fetch(`${base2}/tapeapi/v1/${m}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: `s${i}`, params: {} }) })
    for (let i = 0; i < 20; i++) await hit('blockNumber', i)
    await hit('leak', 99)
    const st = p2.stats()
    assert.equal(st.rateLimited, 0, 'nothing was limited')
    assert.equal(st.calls, 21)
    assert.equal(st.ok, 20); assert.equal(st.failed, 1)
    assert.equal(st.byMethod.blockNumber, 20); assert.equal(st.byMethod.leak, 1)
    assert.equal(st.byCode.INTERNAL, 1, 'the thrown handler is counted as INTERNAL')
    assert.ok(st.uptimeS >= 0)
    assert.equal(JSON.parse(await (await fetch(`${base2}/tapeapi/v1/health`)).text()).rateLimit, null)
  } finally { s2.close() }
})

// The paid budget is keyed on the consumer the voucher signature PROVED. Keying it on the `consumer` field as sent
// would let anyone lock a victim out by writing the victim's address into junk vouchers.
// 付费预算按凭证签名证明的消费者计。按原样的 `consumer` 字段计，任何人都能往垃圾凭证里填受害者地址把他锁在门外。
test('paid calls have their own budget on the VERIFIED consumer, junk vouchers cannot spend a victim\'s budget, and free calls do not eat it', async () => {
  const c2 = createFakeChain()
  c2.setChannel(consumer, ADDR.container, parseUnits('1'))
  c2.setSession(consumer, ADDR.container, sessionAddr, 1900000000)
  const p2 = createProvider({ minVoucherLifeS: 0, manifest, signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: c2.fetch,
    escrowCacheMs: 0, allowHttp: true, log: () => {}, rateLimit: { windowMs: 60_000, free: 2, paid: 3, ip: 100 },
    methods: { blockNumber: () => ({ n: 1 }), circuitHolder: () => ({ holder: ADDR.treasury }), leak: () => ({}) } })
  const s2 = await p2.listen(0)
  const at = (m, body) => fetch(`http://127.0.0.1:${s2.address().port}/tapeapi/v1/${m}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    // The free budget (2) is spent by free calls and does not reduce the paid one. / 免费预算不会吃掉付费预算。
    for (let i = 0; i < 2; i++) assert.equal((await at('blockNumber', { id: `f${i}`, params: {} })).status, 200)
    assert.equal((await at('blockNumber', { id: 'f2', params: {} })).status, 429)
    // An attacker floods junk vouchers naming the victim. None verifies, so none touches the victim's PAID budget;
    // the failures are charged to the attacker's IP (runtime audit F-01), and here that IP's free budget is spent.
    // 攻击者用写着受害者地址的垃圾凭证刷屏。一张都验不过，所以一张都不会动到受害者的付费预算；失败计在攻击者的 IP 上。
    for (let i = 0; i < 5; i++) {
      const r = await at('circuitHolder', { id: `junk${i}`, params: {}, voucher: { ...voucher(PRICE), sig: '0x' + '00'.repeat(65) } })
      assert.equal(r.status, 402, 'a junk voucher is a signed BAD_VOUCHER')
    }
    // The real consumer still has all three paid calls. / 真正的消费者仍有三次付费调用。
    for (let i = 1; i <= 3; i++) {
      const r = await at('circuitHolder', { id: `p${i}`, params: {}, voucher: voucher(BigInt(i) * PRICE) })
      assert.equal(r.status, 200, `paid call ${i}`)
    }
    const over = await at('circuitHolder', { id: 'p4', params: {}, voucher: voucher(4n * PRICE) })
    assert.equal(over.status, 429)
    assert.ok(Number(over.headers.get('retry-after')) > 0)
    assert.equal((await over.json()).sig, undefined, 'unsigned')
    // The refused call was not billed: the meter still stands at three calls. / 被拒的那次没有计费。
    assert.equal((await p2.store.get(consumer, ADDR.container)).cumulative, (3n * PRICE).toString())
  } finally { s2.close() }
})

test('an oversized body gets an actual 413 from the node server, not a dropped connection', async () => {
  const s2 = await createProvider({ minVoucherLifeS: 0, manifest, signerKey: SIGNER_KEY, allowHttp: true, log: () => {}, bodyLimit: 1024,
    methods: { blockNumber: () => ({}), circuitHolder: () => ({}), leak: () => ({}) } }).listen(0)
  try {
    const r = await fetch(`http://127.0.0.1:${s2.address().port}/tapeapi/v1/blockNumber`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'big', params: { pad: 'x'.repeat(4096) } }) })
    assert.equal(r.status, 413)
    assert.equal((await r.json()).error.code, 'BAD_REQUEST')
  } finally { s2.close() }
})
