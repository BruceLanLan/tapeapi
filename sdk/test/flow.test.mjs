// 端到端：假链 + 真 provider（进程内 http）/ End-to-end: fake chain + real provider over in-process http.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTapeAPI, TapeAPIError, parseUnits, validateManifest, MANIFEST_PATH, registryKey, MANIFEST_KEY } from '../src/index.js'
import { sha256 } from '@noble/hashes/sha256'
import { toHex, utf8ToBytes, eqAddr } from '../src/abi.js'
import { privateKeyToAddress, signDigest, delegationDigest, signResponse, voucherDigest } from '../src/sig.js'
import * as sig from '../src/sig.js'
import { createProvider } from '../../server/src/index.js'
import { createFakeChain, ADDR, ZERO_HASH } from './helpers/fake-chain.mjs'

const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32), CONSUMER_KEY = '0x' + '33'.repeat(32), SESSION_KEY = '0x' + '44'.repeat(32)
const holder = privateKeyToAddress(HOLDER_KEY), signer = privateKeyToAddress(SIGNER_KEY), consumer = privateKeyToAddress(CONSUMER_KEY), sessionAddr = privateKeyToAddress(SESSION_KEY)
const RPC = ['http://rpc1', 'http://rpc2', 'http://rpc3']
const PRICE = parseUnits('0.0001')
const nowS = () => Math.floor(Date.now() / 1000)
const EXPIRES = nowS() + 300 * 86400 // within the 366-day cap / 在 366 天上限内
const P = { circuits: ADDR.circuits, tokenId: '4246' }
let chain, provider, manifest, api

function buildManifest(expires = EXPIRES) {
  return {
    tapeapi: '0.1', name: 'TapeOut Reader', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer,
    delegation: { expires, sig: signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires }), HOLDER_KEY) },
    endpoints: { live: ['http://127.0.0.1:0/tapeapi/v1'], async: false },
    methods: [
      { name: 'blockNumber', priceBEM: '0', params: {}, returns: { blockNumber: 'number' } },
      { name: 'circuitHolder', priceBEM: '0.0001', params: { circuits: 'address', tokenId: 'string' }, returns: { holder: 'address' } },
      { name: 'boom', priceBEM: '0', params: {}, returns: {} },
      { name: 'echo', priceBEM: '0', params: {}, returns: {} },
    ],
    payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 },
  }
}
// 测试端点是 http，故 provider 与 client 都需 allowHttp / test endpoints are http, so both sides opt in with allowHttp
const BASE = { rpcUrls: RPC, quorum: 2, chainId: 56, directory: ADDR.directory, escrow: ADDR.escrow, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, allowHttp: true }
const client = (extra = {}) => createTapeAPI({ ...BASE, fetch: chain.fetchWith(), ...extra })
// 在 provider HTTP 前插一层中间人 / a MITM layer in front of the provider's HTTP (RPC still goes to the fake chain)
const mitm = (edit, extra = {}) => createTapeAPI({ ...BASE, ...extra, fetch: chain.fetchWith(async (url, init) => edit(url, init, () => fetch(url, init))) })
const okJson = (obj) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } })

before(async () => {
  chain = createFakeChain()
  chain.setOwner(4246, holder); chain.setAccount(4246, ADDR.container)
  chain.register({ label: 'reader', container: ADDR.container, tokenId: 4246 })
  chain.setChannel(consumer, ADDR.container, parseUnits('1'))            // v2: one channel toward this provider / 通向该提供者的通道
  chain.setSession(consumer, ADDR.container, sessionAddr, 1900000000)  // sessions are per channel / 会话按通道
  chain.setContribution(ADDR.container, 100) // provider opted in to 1% / 提供者自设 1%
  manifest = buildManifest()
  provider = createProvider({ minVoucherLifeS: 0, 
    manifest, signerKey: SIGNER_KEY, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: chain.fetch, allowHttp: true,
    methods: {
      blockNumber: async (_p, ctx) => ({ blockNumber: ctx.block }),
      circuitHolder: async (p, ctx) => ({ holder: chain.state.owners.get(String(p.tokenId)) || null, paidBy: ctx.consumer }),
      boom: async () => { throw new Error('secret internal detail') },
      echo: async (p) => ({ echo: p }),
    },
  })
  const srv = await provider.listen(0)
  manifest.endpoints.live = [`http://127.0.0.1:${srv.address().port}/tapeapi/v1`]
  chain.writeFile(ADDR.container, '/.well-known/tapeapi.json', JSON.stringify(manifest))
  api = client()
})
after(async () => { await provider.close() })

test('resolve by label, container and {circuits,tokenId} verifies delegation against ownerOf', async () => {
  for (const target of ['reader', ADDR.container, { circuits: ADDR.circuits, tokenId: '4246' }]) {
    const svc = await api.resolve(target)
    assert.equal(svc.container.toLowerCase(), ADDR.container)
    assert.deepEqual(svc.verified, { delegation: true, holder: holder })
    assert.equal(svc.manifest.name, 'TapeOut Reader')
    assert.equal(svc.contribution, 100) // read from escrow.contributionOf(container) / 从链上读取
  }
  await assert.rejects(api.resolve('nobody'), (e) => e.code === 'NOT_FOUND')
})
test('resolve: contribution is 0 for an escrow without contributionOf (v0.1 / alternative deployment)', async () => {
  const legacy = '0x' + '41'.repeat(20)
  const c2 = createFakeChain(); c2.setOwner(4246, holder); c2.setAccount(4246, ADDR.container); c2.register({ label: 'reader', container: ADDR.container, tokenId: 4246 })
  c2.markLegacyEscrow(legacy); c2.setContribution(ADDR.container, 100) // set on the fake, but this escrow reverts / 旧托管 revert
  const m = buildManifest(); m.payment.escrow = legacy; m.endpoints.live = manifest.endpoints.live
  c2.writeFile(ADDR.container, '/.well-known/tapeapi.json', JSON.stringify(m))
  const api2 = createTapeAPI({ ...BASE, fetch: c2.fetch })
  const svc = await api2.resolve('reader')
  assert.equal(svc.contribution, 0)
  // and the escrow-specific read goes to the manifest's escrow, not the SDK default / 读取的是清单里的托管地址
  assert.ok(c2.state.calls.some(c => c.name === 'contributionOf' && c.to.toLowerCase() === legacy))
})
test('resolve rejects a delegation signed by a non-holder', async () => {
  const bad = buildManifest()
  bad.delegation.sig = signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires: bad.delegation.expires }), CONSUMER_KEY)
  // 走链路径：把坏清单写进站点 / on-chain path with a bad manifest file
  const c2 = createFakeChain(); c2.setOwner(4246, holder); c2.setAccount(4246, ADDR.container); c2.register({ label: 'reader', container: ADDR.container, tokenId: 4246 }); c2.writeFile(ADDR.container, '/.well-known/tapeapi.json', JSON.stringify(bad))
  const api2 = createTapeAPI({ ...BASE, fetch: c2.fetch })
  await assert.rejects(api2.resolve('reader'), (e) => e instanceof TapeAPIError && e.code === 'DELEGATION_INVALID')
  const expired = buildManifest(1); c2.writeFile(ADDR.container, '/.well-known/tapeapi.json', JSON.stringify(expired))
  await assert.rejects(api2.resolve('reader'), (e) => e.code === 'DELEGATION_INVALID' && /expired/.test(e.message))
  // TAP-20 §3.4 / §3.6 step 5: more than 366 days ahead is refused at resolution / 超过 366 天在解析时拒绝
  const far = buildManifest(nowS() + 400 * 86400); c2.writeFile(ADDR.container, '/.well-known/tapeapi.json', JSON.stringify(far))
  await assert.rejects(api2.resolve('reader'), (e) => e.code === 'DELEGATION_INVALID' && /366 days/.test(e.message))
})
test('TAP-20 §3.6 step 4: ownerOf reverting (no such circuit) is MANIFEST_INVALID, not DELEGATION_INVALID', async () => {
  const c3 = createFakeChain(); c3.setAccount(4246, ADDR.container)   // container exists, token 4246 has no owner / 无持有人
  c3.writeFile(ADDR.container, '/.well-known/tapeapi.json', JSON.stringify(buildManifest()))
  const api3 = createTapeAPI({ ...BASE, fetch: c3.fetch })
  await assert.rejects(api3.resolve(ADDR.container), (e) => e.code === 'MANIFEST_INVALID' && /reverted/.test(e.message))
})
test('M-06: { dev } targets need createTapeAPI({ dev: true }); dev with RPC still checks the holder; dev never relaxes on-chain manifests', async () => {
  // (a) default configuration cannot reach dev resolution / 默认配置无法进入 dev
  await assert.rejects(api.resolve({ dev: manifest }), (e) => e.code === 'MANIFEST_INVALID' && /dev resolve disabled/.test(e.message))
  await assert.rejects(api.resolve({ dev: 'http://127.0.0.1:1' }), (e) => e.code === 'MANIFEST_INVALID' && /dev resolve disabled/.test(e.message))
  // (b) dev client WITH rpcUrls: holder is read from chain, a non-holder delegation is rejected / 有 RPC 的 dev 客户端照样比对 holder
  const devRpc = client({ dev: true })
  const ok = await devRpc.resolve({ dev: manifest })
  assert.deepEqual(ok.verified, { delegation: true, holder, dev: true, checked: true })
  const forged = buildManifest(); forged.delegation.sig = signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires: forged.delegation.expires }), CONSUMER_KEY)
  await assert.rejects(devRpc.resolve({ dev: forged }), (e) => e.code === 'DELEGATION_INVALID')
  // dev: true does not weaken an on-chain source / dev 不影响链上来源
  assert.deepEqual((await devRpc.resolve('reader')).verified, { delegation: true, holder })
  // (c) dev client WITHOUT rpc: signature recovered, holder unchecked and flagged / 无 RPC 时只恢复签名并标记未检查
  const devNoRpc = createTapeAPI({ dev: true, chainId: 56, escrow: ADDR.escrow, directory: ADDR.directory, hub: ADDR.hub })
  const svc = await devNoRpc.resolve({ dev: manifest })
  assert.deepEqual(svc.verified, { delegation: true, holder, dev: true, checked: false })
  const byUrl = await devNoRpc.resolve({ dev: manifest.endpoints.live[0].replace('/tapeapi/v1', '') })
  assert.equal(byUrl.manifest.signer, signer)
  const svc2 = await devNoRpc.resolve({ dev: { ...manifest, delegation: undefined } })
  assert.deepEqual(svc2.verified, { delegation: false, holder: null, dev: true })
  assert.equal(svc.contribution, 0); assert.equal(svc2.contribution, 0) // dev-sourced manifests never touch the escrow / dev 清单不读托管
})
test('M-10 / M-11: https-only endpoints outside dev, strict quorum, manifest limits', async () => {
  const strict = createTapeAPI({ ...BASE, allowHttp: false, fetch: chain.fetchWith() })
  await assert.rejects(strict.resolve('reader'), (e) => e.code === 'MANIFEST_INVALID' && /https/.test(e.message))
  assert.throws(() => createTapeAPI({ ...BASE, rpcUrls: ['http://rpc1'], quorum: 2, fetch: chain.fetch }), (e) => e.code === 'RPC_UNAVAILABLE' && /allowSingleNode/.test(e.message))
  const single = createTapeAPI({ ...BASE, rpcUrls: ['http://rpc1'], quorum: 2, allowSingleNode: true, fetch: chain.fetch })
  assert.equal(single.rpc.quorum, 1); assert.equal(single.rpc.degraded, true)
  const good = buildManifest(); good.endpoints.live = ['https://api.example.com/tapeapi/v1/']
  assert.equal(validateManifest(good).endpoints.live[0], 'https://api.example.com/tapeapi/v1')
  const cases = [
    [(m) => { m.endpoints.live = ['https://api.example.com/v1?x=1'] }, /query/],
    [(m) => { m.endpoints.live = ['https://user:pw@api.example.com/v1'] }, /credentials/],
    [(m) => { m.name = 'n'.repeat(65) }, /64 code points/],
    [(m) => { m.methods = [] }, /non-empty/],
    [(m) => { m.methods[0].name = 'a'.repeat(65) }, /method\.name/],
    [(m) => { m.methods[0].name = '__proto__' }, /method\.name/],
    // TAP-20 §3.3 field rules (traceability D12) / 逐字段规则
    [(m) => { delete m.endpoints.async }, /async must be a boolean/],
    [(m) => { m.endpoints.live = [] }, /non-empty unless async/],
    [(m) => { delete m.methods[0].priceBEM }, /priceBEM must be a decimal string/],
    [(m) => { m.methods[0].priceBEM = 0 }, /priceBEM must be a decimal string/],
    [(m) => { delete m.methods[0].returns }, /returns must be an object/],
    [(m) => { m.methods[0].description = 'd'.repeat(257) }, /256 code points/],
    [(m) => { m.tokenId = '04246' }, /no leading zeros/],
    [(m) => { m.tokenId = 4246 }, /decimal string/],
    [(m) => { m.tokenId = (2n ** 256n).toString() }, /uint256/],
    [(m) => { m.signer = m.signer.slice(0, 2) + m.signer.slice(2).split('').map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join('') }, /EIP-55/],
  ]
  for (const [mutate, re] of cases) { const m = buildManifest(); m.endpoints.live = ['https://api.example.com/v1']; mutate(m); assert.throws(() => validateManifest(m), (e) => e.code === 'MANIFEST_INVALID' && re.test(e.message), String(re)) }
  // accepted: no name, an async-only service, a 64-code-point name of astral characters (128 UTF-16 units)
  // 可接受：没有 name、只走 async 的服务、64 个码点的星芒字符名（128 个 UTF-16 单元）
  const noName = buildManifest(); noName.endpoints.live = ['https://api.example.com/v1']; delete noName.name
  assert.ok(validateManifest(noName))
  const asyncOnly = buildManifest(); asyncOnly.endpoints = { live: [], async: true }
  assert.deepEqual(validateManifest(asyncOnly).endpoints, { live: [], async: true })
  const astral = buildManifest(); astral.endpoints.live = ['https://api.example.com/v1']; astral.name = '\u{1F600}'.repeat(64)
  assert.ok(validateManifest(astral))
  const lower = buildManifest(); lower.endpoints.live = ['https://api.example.com/v1']; lower.signer = lower.signer.toLowerCase()
  assert.ok(validateManifest(lower))
  // the 366-day bound moved to resolution, where it is DELEGATION_INVALID (TAP-20 §3.6 step 5)
  // 366 天上限移到解析阶段，报 DELEGATION_INVALID
  const far = buildManifest(); far.endpoints.live = ['https://api.example.com/v1']; far.delegation.expires = nowS() + 400 * 86400
  assert.ok(validateManifest(far), 'not a schema rule')
})
test('free call: signed envelope verified against manifest.signer; INTERNAL is generic', async () => {
  const svc = await api.resolve('reader')
  const r = await api.call(svc, 'blockNumber', {})
  assert.equal(r.verified, true); assert.equal(r.result.blockNumber, 62_000_000); assert.equal(r.block, 62_000_000)
  assert.ok(Number.isInteger(r.ts) && /^0x[0-9a-f]{130}$/i.test(r.sig))
  await assert.rejects(api.call(svc, 'nope', {}), (e) => e.code === 'METHOD_NOT_FOUND')
  await assert.rejects(api.call(svc, 'a'.repeat(65), {}), (e) => e.code === 'METHOD_NOT_FOUND')
  await assert.rejects(api.call(svc, 'boom', {}), (e) => e.code === 'INTERNAL' && e.signed === true && e.message === 'internal error')
  await assert.rejects(api.call(svc, 'echo', [1]), (e) => e.code === 'BAD_REQUEST')
})
test('paid call requires payer; session-key payer produces monotonically increasing vouchers', async () => {
  const svc = await api.resolve('reader')
  await assert.rejects(api.call(svc, 'circuitHolder', P), (e) => e.code === 'PAYMENT_REQUIRED')
  const payer = api.payer({ consumer, sessionKey: SESSION_KEY })
  const r1 = await api.call(svc, 'circuitHolder', P, { payer })
  assert.equal(r1.result.holder, holder); assert.equal(r1.result.paidBy, consumer); assert.equal(r1.verified, true)
  assert.equal(payer.cumulativeOf(svc), PRICE); assert.equal(payer.inflightOf(svc), 0)
  const r2 = await api.call(svc, 'circuitHolder', P, { payer })
  assert.equal(r2.result.holder, holder); assert.equal(payer.cumulativeOf(svc), 2n * PRICE)
  const pending = await provider.pendingSettlements()
  assert.equal(pending.length, 1)
  assert.equal(pending[0].cumulative, (2n * PRICE).toString()); assert.equal(pending[0].consumer, consumer)
  const tx = provider.settleTx(pending[0])
  assert.equal(tx.to, ADDR.escrow); assert.equal(tx.data, api.tx.settle(pending[0]).data)
})
test('payer with wallet-style signTypedData (consumer signs directly)', async () => {
  const svc = await api.resolve('reader')
  const { voucherDigest } = await import('../src/sig.js')
  let seen
  const payer = api.payer({ consumer, signTypedData: async (td) => { seen = td; return signDigest(voucherDigest(56, td.domain.verifyingContract, td.message), CONSUMER_KEY) } })
  payer.setCumulative(svc, 2n * PRICE) // 接续上一测试的累计 / continue from previous cumulative
  const r = await api.call(svc, 'circuitHolder', P, { payer })
  assert.equal(r.result.holder, holder)
  assert.equal(seen.primaryType, 'Voucher'); assert.equal(seen.domain.name, 'TapeAPIEscrow'); assert.equal(seen.message.cumulative, (3n * PRICE).toString())
})
test('H-05 resync: a payer that is behind the provider (reload) gets BAD_VOUCHER + lastCumulative, resyncs and retries once', async () => {
  const svc = await api.resolve('reader')
  const payer = api.payer({ consumer, sessionKey: SESSION_KEY }) // 从 0 开始，落后于 provider / starts at 0, behind provider
  const before = BigInt((await provider.pendingSettlements())[0].cumulative)
  const r = await api.call(svc, 'circuitHolder', P, { payer })
  assert.equal(r.verified, true)
  assert.equal(payer.cumulativeOf(svc), before + PRICE)
  assert.equal((await provider.pendingSettlements())[0].cumulative, (before + PRICE).toString())
  // a payer whose stale voucher is rejected but the error carries no lastCumulative fails cleanly / 无 lastCumulative 时直接失败并释放
  const noData = mitm(async (url, init, next) => {
    const res = await next(); const j = await res.json()
    if (j.ok === false && j.error?.code === 'BAD_VOUCHER') { delete j.error.data; return okJson(j) } // 签名随之失效 -> BAD_SIGNATURE / signature no longer verifies
    return okJson(j)
  })
  const stale = noData.payer({ consumer, sessionKey: SESSION_KEY })
  await assert.rejects(noData.call(svc, 'circuitHolder', P, { payer: stale }), (e) => e.code === 'BAD_SIGNATURE')
  assert.equal(stale.cumulativeOf(svc), 0n); assert.equal(stale.inflightOf(svc), 0)
})
test('H-05 concurrency: Promise.all of paid calls all succeed; issuance is serialised and the counter ends consistent', async () => {
  const svc = await api.resolve('reader')
  const payer = api.payer({ consumer, sessionKey: SESSION_KEY })
  await api.call(svc, 'circuitHolder', P, { payer }) // sync with the provider first / 先同步一次
  const base = payer.cumulativeOf(svc)
  const rs = await Promise.all([1, 2, 3, 4].map(() => api.call(svc, 'circuitHolder', P, { payer })))
  assert.ok(rs.every(r => r.verified && r.result.holder === holder))
  assert.equal(payer.inflightOf(svc), 0)
  const last = BigInt((await provider.pendingSettlements())[0].cumulative)
  assert.equal(payer.cumulativeOf(svc), last)               // local == provider / 本地与提供者一致
  assert.ok(last >= base + 4n * PRICE && last <= base + 5n * PRICE, `last=${last} base=${base}`) // at most one resync retry / 至多一次重试
  const again = await api.call(svc, 'circuitHolder', P, { payer })
  assert.equal(again.verified, true); assert.equal(payer.cumulativeOf(svc), last + PRICE)
})
test('H-05 transport failure: the reservation is released, no gap is signed into the next voucher', async () => {
  const svc = await api.resolve('reader')
  let failNext = false, seen = 0
  const flaky = mitm(async (url, init, next) => { seen++; if (failNext) { failNext = false; throw new Error('ECONNRESET') } return next() })
  const payer = flaky.payer({ consumer, sessionKey: SESSION_KEY })
  await flaky.call(svc, 'circuitHolder', P, { payer })
  const base = payer.cumulativeOf(svc)
  failNext = true
  await assert.rejects(flaky.call(svc, 'circuitHolder', P, { payer }), (e) => e.code === 'PROVIDER_UNAVAILABLE')
  assert.equal(payer.cumulativeOf(svc), base); assert.equal(payer.inflightOf(svc), 0)
  const n = seen
  const r = await flaky.call(svc, 'circuitHolder', P, { payer })
  assert.equal(r.verified, true); assert.equal(seen, n + 1) // single request, no retry needed / 一次请求即成功
  assert.equal(payer.cumulativeOf(svc), base + PRICE)         // exactly +price: the failed call is not paid for / 失败的调用没有被计费
  assert.equal((await provider.pendingSettlements())[0].cumulative, (base + PRICE).toString())
})
test('H-05 consumed-but-lost: provider served the request, response lost; next voucher is corrected via lastCumulative', async () => {
  const svc = await api.resolve('reader')
  let dropNext = false
  const lossy = mitm(async (url, init, next) => { const res = await next(); if (dropNext) { dropNext = false; throw new Error('socket hang up') } return res })
  const payer = lossy.payer({ consumer, sessionKey: SESSION_KEY })
  await lossy.call(svc, 'circuitHolder', P, { payer })
  const base = payer.cumulativeOf(svc)
  dropNext = true
  await assert.rejects(lossy.call(svc, 'circuitHolder', P, { payer }), (e) => e.code === 'PROVIDER_UNAVAILABLE')
  assert.equal(payer.cumulativeOf(svc), base) // released locally, but the provider did consume it / 本地释放，但提供者已入账
  assert.equal((await provider.pendingSettlements())[0].cumulative, (base + PRICE).toString())
  const r = await lossy.call(svc, 'circuitHolder', P, { payer }) // signs base+p -> BAD_VOUCHER(last=base+p) -> resync -> base+2p
  assert.equal(r.verified, true)
  assert.equal(payer.cumulativeOf(svc), base + 2n * PRICE)
  assert.equal((await provider.pendingSettlements())[0].cumulative, (base + 2n * PRICE).toString())
})
test('H-05 store: committed cumulative persists across payer instances (reload), no resync round-trip needed', async () => {
  const svc = await api.resolve('reader')
  const kv = new Map(); const store = { get: async (k) => kv.get(k) ?? null, set: async (k, v) => { kv.set(k, v) } }
  const a = api.payer({ consumer, sessionKey: SESSION_KEY, store })
  await api.call(svc, 'circuitHolder', P, { payer: a })
  const committed = a.cumulativeOf(svc)
  assert.equal([...kv.values()][0], committed.toString())
  let requests = 0
  const counting = mitm(async (url, init, next) => { requests++; return next() })
  const b = counting.payer({ consumer, sessionKey: SESSION_KEY, store }) // fresh instance, same store / 新实例，同一 store
  const r = await counting.call(svc, 'circuitHolder', P, { payer: b })
  assert.equal(r.verified, true); assert.equal(requests, 1) // continued from the store, no BAD_VOUCHER retry / 从 store 接续，无需重试
  assert.equal(b.cumulativeOf(svc), committed + PRICE)
  assert.throws(() => api.payer({ consumer, sessionKey: SESSION_KEY, store: { get() {} } }), (e) => e.code === 'BAD_VOUCHER')
})
// H-04：提供者的 reserve/commit 只为交付了的结果计费，客户端必须跟着释放，否则消费者为失败的调用付钱。
// The provider bills only a delivered result, so the client must release too — otherwise the consumer pays for a
// call the provider never metered, and the gap is burned forever.
test('H-04: a signed non-payment error does not advance the local cumulative (the provider did not bill it)', async () => {
  const SIGNER2 = '0x' + '77'.repeat(32), C2 = '0x' + '88'.repeat(20)
  const signer2 = privateKeyToAddress(SIGNER2)
  const expires = nowS() + 300 * 86400
  let fail = true
  const m2 = {
    tapeapi: '0.1', name: 'Flaky', circuits: ADDR.circuits, tokenId: '4246', container: C2, signer: signer2,
    delegation: { expires, sig: signDigest(delegationDigest(56, ADDR.hub, { container: C2, signer: signer2, expires }), HOLDER_KEY) },
    endpoints: { live: ['http://127.0.0.1:0/tapeapi/v1'], async: false },
    methods: [{ name: 'circuitHolder', priceBEM: '0.0001', params: {}, returns: {} }],
    payment: { escrow: ADDR.escrow, unit: 'BEM', decimals: 8 },
  }
  const p2 = createProvider({ minVoucherLifeS: 0, 
    manifest: m2, signerKey: SIGNER2, rpcUrls: RPC, quorum: 2, chainId: 56, fetch: chain.fetch, escrowCacheMs: 0, allowHttp: true, log: () => {},
    methods: { circuitHolder: async () => { if (fail) throw new Error('upstream 502'); return { holder } } },
  })
  const srv = await p2.listen(0)
  m2.endpoints.live = [`http://127.0.0.1:${srv.address().port}/tapeapi/v1`]
  try {
    chain.setChannel(consumer, C2, parseUnits('1'))
    chain.setSession(consumer, C2, sessionAddr, 1900000000)   // the key must be authorised on C2's channel too / 该密钥需在 C2 通道上授权
    const svc = await client({ dev: true }).resolve({ dev: m2 })
    const payer = api.payer({ consumer, sessionKey: SESSION_KEY })
    await assert.rejects(api.call(svc, 'circuitHolder', {}, { payer }), (e) => e.code === 'INTERNAL' && e.signed === true)
    assert.equal(payer.cumulativeOf(svc), 0n)          // 失败的调用没有被计费 / the failed call is on nobody's meter
    assert.equal(payer.inflightOf(svc), 0)
    assert.deepEqual(await p2.pendingSettlements(), [])
    fail = false
    const r = await api.call(svc, 'circuitHolder', {}, { payer })
    assert.equal(r.verified, true)
    assert.equal(payer.cumulativeOf(svc), PRICE)       // 正好一次调用的价格 / exactly one call's price
    assert.equal((await p2.pendingSettlements())[0].cumulative, PRICE.toString())
  } finally { await p2.close() }
})
test('H-07: the local cumulative is per escrow — changing payment.escrow does not re-sign the history', async () => {
  const svcA = await api.resolve('reader')
  const other = '0x' + '41'.repeat(20)
  const svcB = { ...svcA, manifest: { ...svcA.manifest, payment: { ...svcA.manifest.payment, escrow: other } } }
  const kv = new Map(); const store = { get: async (k) => kv.get(k) ?? null, set: async (k, v) => { kv.set(k, v) } }
  const payer = api.payer({ consumer, sessionKey: SESSION_KEY, store })
  await payer.setCumulative(svcA, 5000n * PRICE)
  assert.equal(payer.cumulativeOf(svcA), 5000n * PRICE)
  assert.equal(payer.cumulativeOf(svcB), 0n, 'another escrow starts from zero, not from the old escrow history')
  const v = await payer.voucherFor(svcB, PRICE)
  assert.equal(v.cumulative, PRICE.toString())
  // 凭证确实绑定新托管，且计数键与签名用的是同一个地址 / the voucher is bound to the new escrow the counter is keyed on
  const { voucherDigest: vd, recoverAddress } = await import('../src/sig.js')
  assert.equal(recoverAddress(vd(56, other, { ...v, cumulative: BigInt(v.cumulative) }), v.sig), sessionAddr)
  assert.equal(kv.size, 2, 'two escrows, two persisted counters')
})
test('H-01: voucher.expires is bounded by ttl alone -- sessionExpiry no longer clamps it', async () => {
  const svc = await api.resolve('reader')
  const t0 = nowS()
  // 会话早于凭证到期是正常情况：settle() 只要求会话在它执行的那一刻有效，撤销后还有 REVOKE_DELAY = 24h。
  // 过去 SDK 把 expires 截到 sessionExpiry，于是那 24 小时宽限期在端到端路径上永远用不到。
  // A session that ends before the voucher does is fine: settle() only requires the session to be live
  // when it runs, and a revoke leaves REVOKE_DELAY = 24h. The SDK used to clamp expires down to
  // sessionExpiry, which made that grace period unreachable end to end.
  const shortSession = api.payer({ consumer, sessionKey: SESSION_KEY, ttl: 3600, sessionExpiry: t0 + 60 })
  const vShort = await shortSession.voucherFor(svc, PRICE)
  assert.ok(vShort.expires >= t0 + 3600 && vShort.expires <= nowS() + 3600,
    `expires ${vShort.expires} must be now + ttl, not the session end ${t0 + 60}`)

  // 会话远在凭证之后：同样只受 ttl 约束 / a session far beyond the voucher: still bounded by ttl only
  const longSession = api.payer({ consumer, sessionKey: SESSION_KEY, ttl: 600, sessionExpiry: t0 + 30 * 86400 })
  const vLong = await longSession.voucherFor(svc, PRICE)
  assert.ok(vLong.expires >= t0 + 600 && vLong.expires <= nowS() + 600, 'expires is now + ttl')

  // 不传 sessionExpiry 时行为完全相同 / omitting sessionExpiry changes nothing
  const noSession = api.payer({ consumer, sessionKey: SESSION_KEY, ttl: 600 })
  const vNone = await noSession.voucherFor(svc, PRICE)
  assert.equal(vNone.expires - t0 <= 601, true)
  assert.ok(Math.abs(vNone.expires - vLong.expires) <= 1, 'sessionExpiry does not change the issued expiry')
})
test('H-01: sessionExpiry is still honoured for a session that has already lapsed', async () => {
  const svc = await api.resolve('reader')
  const lapsed = api.payer({ consumer, sessionKey: SESSION_KEY, sessionExpiry: nowS() - 1 })
  // 已失效的会话签出的凭证永远结算不掉，因此在本地拒绝签发。
  // A lapsed session can sign nothing that will ever settle, so issuing is refused locally.
  await assert.rejects(() => lapsed.voucherFor(svc, PRICE), (e) => e.code === 'BAD_VOUCHER' && /session key expired/.test(e.message))
  await assert.rejects(() => lapsed.reserve(svc, PRICE), (e) => e.code === 'BAD_VOUCHER')
  // 边界：恰好等于当前秒仍然可用（会话此刻仍然有效）/ boundary: exactly now is still usable (the session is live this second)
  const edge = api.payer({ consumer, sessionKey: SESSION_KEY, ttl: 300, sessionExpiry: nowS() })
  const v = await edge.voucherFor(svc, PRICE)
  assert.ok(v.expires > nowS(), 'a session that is live this second still issues a full-ttl voucher')
  // sessionExpiry 只在使用 session key 时有意义；钱包签名路径忽略它 / it only applies to session keys
  const { voucherDigest: vd2 } = await import('../src/sig.js')
  const wallet = api.payer({ consumer, sessionExpiry: nowS() - 1, ttl: 300,
    signTypedData: async (td) => signDigest(vd2(56, td.domain.verifyingContract, td.message), CONSUMER_KEY) })
  const vw = await wallet.voucherFor(svc, PRICE)
  assert.ok(vw.expires > nowS(), 'a consumer-signed voucher is not affected by sessionExpiry')
})
test('M-16: a hand-assembled service (no verified delegation) cannot be called', async () => {
  const svc = await api.resolve('reader')
  await assert.rejects(api.call({ manifest: svc.manifest, container: svc.container }, 'blockNumber', {}),
    (e) => e.code === 'DELEGATION_INVALID' && /api\.resolve/.test(e.message))
  await assert.rejects(api.call({ ...svc, verified: { delegation: false, holder: null } }, 'blockNumber', {}),
    (e) => e.code === 'DELEGATION_INVALID')
})
test('an over-long or empty id is the caller`s mistake, refused before the request', async () => {
  const svc = await api.resolve('reader')
  for (const id of ['', 'x'.repeat(129), 7]) {
    await assert.rejects(api.call(svc, 'blockNumber', {}, { id }), (e) => e.code === 'BAD_REQUEST' && /1\.\.128/.test(e.message), String(id))
  }
})
test('tx builders produce calldata for escrow and directory', async () => {
  const { abi } = await import('../src/index.js')
  assert.equal(api.tx.fund(ADDR.container, 5n).data, abi.encodeCall('fund', [ADDR.container, 5n]))
  assert.equal(api.tx.fund(ADDR.container, 5n).to, ADDR.escrow)
  assert.equal(api.tx.requestWithdraw(ADDR.container, 7n).data, abi.encodeCall('requestWithdraw', [ADDR.container, 7n]))
  assert.equal(api.tx.withdraw(ADDR.container).data, abi.encodeCall('withdraw', [ADDR.container]))
  const auth = api.tx.authorizeSession(ADDR.container, sessionAddr, 1900000000)
  assert.equal(auth.data.slice(0, 10), abi.selector('authorizeSession'))
  assert.deepEqual([...abi.decodeCall('authorizeSession', auth.data)].map(String), [abi.checksumAddress(ADDR.container), sessionAddr, '1900000000'])
  assert.equal(api.tx.deposit, undefined); assert.equal(api.tx.setAllowance, undefined) // v1 builders are gone / v1 构造器已移除
  const reg = api.tx.register({ circuits: ADDR.circuits, tokenId: '4246', label: 'reader', manifestPath: '/.well-known/tapeapi.json', value: 10n ** 16n })
  assert.equal(reg.to, ADDR.directory); assert.equal(reg.value, '0x2386f26fc10000')
  const args = abi.decodeCall('register', reg.data)
  assert.equal(abi.bytes32ToLabel(args[2]), 'reader'); assert.equal(args[3], '/.well-known/tapeapi.json')
})
test('tx.setContribution builds setContribution(address,uint256,uint16) calldata and validates bps', async () => {
  const { abi, MAX_CONTRIBUTION_BPS, RECOMMENDED_CONTRIBUTION_BPS } = await import('../src/index.js')
  assert.equal(MAX_CONTRIBUTION_BPS, 5000); assert.equal(RECOMMENDED_CONTRIBUTION_BPS, 100)
  const tx = api.tx.setContribution({ circuits: ADDR.circuits, tokenId: '4246', bps: 100 })
  assert.equal(tx.to, ADDR.escrow); assert.equal(tx.value, '0x0')
  assert.equal(abi.signatureOf('setContribution'), 'setContribution(address,uint256,uint16)')
  assert.equal(tx.data.slice(0, 10), abi.selector('setContribution'))
  const args = abi.decodeCall('setContribution', tx.data)
  assert.equal(args[0].toLowerCase(), ADDR.circuits); assert.equal(args[1], 4246n); assert.equal(args[2], 100n)
  // escrow override for services on another deployment / 可指定其它托管
  assert.equal(api.tx.setContribution({ circuits: ADDR.circuits, tokenId: 1, bps: 0, escrow: '0x' + '41'.repeat(20) }).to, '0x' + '41'.repeat(20))
  for (const bad of [5001, -1, 1.5, 'x']) assert.throws(() => api.tx.setContribution({ circuits: ADDR.circuits, tokenId: 1, bps: bad }), (e) => e.code === 'ABI_INVALID')
  assert.equal(abi.signatureOf('contributionOf'), 'contributionOf(address)'); assert.equal(abi.signatureOf('treasury'), 'treasury()')
  assert.equal(await api.chain.escrow.treasury(), abi.checksumAddress(ADDR.treasury))
})
test('tampered envelope is rejected with BAD_SIGNATURE', async () => {
  const svc = await api.resolve('reader')
  const evil = mitm(async (url, init, next) => { const j = await (await next()).json(); j.result.blockNumber = 1; return okJson(j) })
  await assert.rejects(evil.call(svc, 'blockNumber', {}), (e) => e.code === 'BAD_SIGNATURE')
})
test('M-07: a signed error relabelled ok=true fails; a signed answer replayed for another method/params fails', async () => {
  const svc = await api.resolve('reader')
  // (1) flip ok on a signed INTERNAL error: same body bytes, must not verify / 把签名的错误信封改标成成功
  const flip = mitm(async (url, init, next) => { const j = await (await next()).json(); if (j.ok === false) { j.ok = true; j.result = j.error; delete j.error } return okJson(j) })
  await assert.rejects(flip.call(svc, 'boom', {}), (e) => e.code === 'BAD_SIGNATURE')
  // (2) replay: capture the envelope for echo {x:2} and serve it for echo {x:1} and for blockNumber {} (same fixed id) / 同 id 换问题重放
  let captured = null
  const replay = mitm(async (url, init, next) => { if (captured) return okJson(captured); const j = await (await next()).json(); captured = j; return okJson(j) })
  const first = await replay.call(svc, 'echo', { x: 2 }, { id: 'fixed-id' })
  assert.deepEqual(first.result, { echo: { x: 2 } })
  await assert.rejects(replay.call(svc, 'echo', { x: 1 }, { id: 'fixed-id' }), (e) => e.code === 'BAD_SIGNATURE')
  await assert.rejects(replay.call(svc, 'blockNumber', {}, { id: 'fixed-id' }), (e) => e.code === 'BAD_SIGNATURE')
  const same = await replay.call(svc, 'echo', { x: 2 }, { id: 'fixed-id' }) // identical request -> the cached answer still verifies
  assert.deepEqual(same.result, { echo: { x: 2 } })
})
test('M-09: envelope ts outside the freshness window is rejected (maxSkewS, default 300)', async () => {
  const svc = await api.resolve('reader')
  // provider-side re-signing with a stale ts (uses the signer key) / 用 signer key 重新签一个过期 ts 的信封
  const restamp = (skew, extra) => mitm(async (url, init, next) => {
    const req = JSON.parse(init.body); const j = await (await next()).json()
    j.ts = nowS() - skew
    j.sig = signResponse({ container: j.container, id: j.id, method: req.method, params: req.params, ok: j.ok, body: j.ok ? j.result : j.error, ts: j.ts }, SIGNER_KEY)
    return okJson(j)
  }, extra)
  await assert.rejects(restamp(1000).call(svc, 'blockNumber', {}), (e) => e.code === 'BAD_SIGNATURE' && /freshness/.test(e.message))
  const r = await restamp(100).call(svc, 'blockNumber', {}) // 100 s old is within ±300 s / 100 秒内可接受
  assert.equal(r.verified, true)
  await assert.rejects(restamp(100, { maxSkewS: 60 }).call(svc, 'blockNumber', {}), (e) => e.code === 'BAD_SIGNATURE' && /±60s/.test(e.message)) // configurable / 可配置
})
test('M-08: a response body carrying __proto__ is rejected before verification', async () => {
  const svc = await api.resolve('reader')
  const inject = mitm(async (url, init, next) => { const text = await (await next()).text(); return okJson(text.replace('"result":{', '"result":{"__proto__":{"polluted":true},')) })
  await assert.rejects(inject.call(svc, 'blockNumber', {}), (e) => e.code === 'PROVIDER_UNAVAILABLE' && /forbidden key/.test(e.message))
  assert.equal(({}).polluted, undefined)
  const huge = mitm(async () => okJson('{"id":"x","ok":true,"result":"' + 'a'.repeat(1024 * 1024 + 10) + '"}'))
  await assert.rejects(huge.call(svc, 'blockNumber', {}), (e) => e.code === 'PROVIDER_UNAVAILABLE' && /exceeds limit/.test(e.message))
})

// ---- 恶意提供者：无证据的 resync / a hostile provider cannot move the local counter ----

test('a provider that reports a huge lastCumulative without proof cannot drain the payer', async () => {
  // 攻击：提供者对任意凭证回 BAD_VOUCHER，并谎报一个天文数字的 lastCumulative。
  // 若客户端无条件采纳，下一张凭证就会签到那个数字，合约按额度截断后足额支付——
  // 一次调用榨干消费者的全部额度，成本只是一个约 11 美元的身份。
  // Attack: answer any voucher with BAD_VOUCHER and name an enormous lastCumulative. A client that
  // adopts it unconditionally signs the next voucher at that figure; settle clamps it to the
  // allowance and pays in full, draining the consumer in one call for the price of one identity.
  const HUGE = (10n ** 30n).toString()
  const hostile = mitm(async (url, init, next) => {
    const res = await next(); const j = await res.json()
    if (j.ok === false && j.error?.code === 'BAD_VOUCHER') {
      j.error.data = { lastCumulative: HUGE, onChainClaimed: '0' }   // 数字够大，但拿不出证据 / no proof
      return okJson(j)
    }
    if (j.ok === true) { // 先逼出一次 BAD_VOUCHER / force the stale path
      return okJson({ ...j, ok: false, error: { code: 'BAD_VOUCHER', message: 'stale', data: { lastCumulative: HUGE, onChainClaimed: '0' } } })
    }
    return okJson(j)
  })
  const svc = await hostile.resolve('reader')
  const payer = hostile.payer({ consumer, sessionKey: SESSION_KEY })
  await assert.rejects(hostile.call(svc, 'circuitHolder', P, { payer }), (e) => e.code === 'BAD_SIGNATURE' || e.code === 'BAD_VOUCHER')
  assert.equal(payer.cumulativeOf(svc), 0n, 'the counter must not move on an unproved claim')
  assert.equal(payer.inflightOf(svc), 0, 'and nothing may be left reserved')
})

test('A2-01: a provider-reported onChainClaimed is not proof; the SDK reads claimedOf itself', async () => {
  const svc = await api.resolve('reader')
  const payer = api.payer({ consumer, sessionKey: SESSION_KEY })
  const big = 10n ** 20n
  // The provider says "the chain already shows this much claimed" -- but the chain says 0.
  // 提供者声称"链上已结算到这么多"——但链上是 0。
  await assert.rejects(payer.resync(svc, big.toString(), { onChainClaimed: big.toString() }), (e) => e.code === 'BAD_VOUCHER' && /without proof/.test(e.message))
  assert.equal(payer.cumulativeOf(svc), 0n)
  // Once the chain itself shows it, the same call is accepted. / 链上真有了，同样的调用即被接受。
  chain.setClaimed(consumer, ADDR.container, big)
  try { assert.equal(await payer.resync(svc, big.toString(), {}), big) } finally { chain.setClaimed(consumer, ADDR.container, 0) }
})
test('a forged voucher in the evidence is rejected: only our own signature counts', async () => {
  const svc = await api.resolve('reader')
  const payer = api.payer({ consumer, sessionKey: SESSION_KEY })
  const other = '0x' + 'ab'.repeat(32)   // 一把我们从未授权的密钥 / a key we never authorised
  const big = 10n ** 20n
  const expires = Math.floor(Date.now() / 1000) + 3600
  const v = { consumer, provider: svc.container, cumulative: big, expires }
  const sig = signDigest(voucherDigest(56, ADDR.escrow, v), other)
  await assert.rejects(
    payer.resync(svc, big.toString(), { voucher: { cumulative: big.toString(), expires, sig }, onChainClaimed: '0' }),
    (e) => e.code === 'BAD_VOUCHER' && /without proof/.test(e.message),
  )
  assert.equal(payer.cumulativeOf(svc), 0n)
})

// ---- TAP-20 §3.2 / §3.6：无目录解析 + 清单完整性 / directory-free resolution + manifest integrity ----
// 没有 directory 的客户端配置 / client options with no directory at all
const NO_DIR = (({ directory, ...rest }) => rest)(BASE)
// 一条干净的链：holder、accountOf、清单文件，但不注册任何目录记录 / a clean chain with holder, accountOf and the manifest file, nothing registered anywhere
function freshChain(mutate) {
  const c2 = createFakeChain(); c2.setOwner(4246, holder); c2.setAccount(4246, ADDR.container)
  const m = buildManifest(); m.endpoints.live = manifest.endpoints.live
  mutate?.(m, c2)
  c2.writeFile(ADDR.container, MANIFEST_PATH, JSON.stringify(m))
  return c2
}
// 假链按节点记录：一次逻辑读取 = RPC.length 条记录 / the fake logs per node: one logical view == RPC.length entries
const PER = RPC.length
const calls = (c, name) => c.state.calls.filter((x) => x.name === name)
// The SDK sends the bare registry key (no leading slash), so compare against registryKey(path). / SDK 发裸键，按 registryKey 比较。
const readsAt = (c, path) => c.state.calls.filter((x) => (x.name === 'read' || x.name === 'fileInfo') && x.args[1] === registryKey(path))

test('TAP-20 §3.2 (a): a container resolves with NO directory configured; manifest is read from the SiteRegistry only', async () => {
  const c2 = freshChain()
  const api2 = createTapeAPI({ ...NO_DIR, fetch: c2.fetch })
  assert.equal(api2.addresses.directory, undefined)
  const svc = await api2.resolve(ADDR.container)
  assert.deepEqual(svc.verified, { delegation: true, holder })
  assert.equal(svc.manifest.name, 'TapeOut Reader'); assert.equal(svc.container.toLowerCase(), ADDR.container)
  // no directory call of any kind / 没有任何目录调用
  assert.equal(calls(c2, 'serviceOf').length, 0); assert.equal(calls(c2, 'resolve').length, 0)
  // fileInfo AND read both hit the SiteRegistry at the fixed path / fileInfo 与 read 都打到 SiteRegistry 的固定路径
  for (const name of ['fileInfo', 'read']) {
    const c = calls(c2, name); assert.equal(c.length, PER, name)
    for (const x of c) { assert.ok(eqAddr(x.to, ADDR.siteRegistry)); assert.ok(eqAddr(x.args[0], ADDR.container)); assert.equal(x.args[1], MANIFEST_KEY) }  // registry sees the bare key / 注册表收到裸键
  }
  // §3.6 step 3 ran: accountOf(manifest.circuits, manifest.tokenId) / 第 3 步跑过
  assert.ok(calls(c2, 'accountOf').some((c) => eqAddr(c.to, ADDR.hub) && eqAddr(c.args[0], ADDR.circuits) && c.args[1] === 4246n))
  // the integrity record is the real one / 完整性记录是真实值
  const bytes = c2.state.files.get(`${ADDR.container}:${MANIFEST_KEY}`).bytes
  assert.deepEqual(svc.file, { size: bytes.length, sha256Hash: toHex(sha256(bytes)), updatedAt: 1n })
  // a directory that IS configured but has no record for the container is not an obstacle either / 配了目录但未注册也不阻塞
  const api3 = createTapeAPI({ ...BASE, fetch: c2.fetch })
  assert.equal((await api3.resolve(ADDR.container)).manifest.name, 'TapeOut Reader')
  // directory-only reads still say so explicitly / 目录读取本身仍明确报错
  await assert.rejects(async () => api2.chain.serviceOf(ADDR.container), (e) => e.code === 'MANIFEST_INVALID' && /directory/.test(e.message))
  await assert.rejects(api2.resolve('reader'), (e) => e.code === 'MANIFEST_INVALID' && /directory/.test(e.message))
})
test('TAP-20 §3.2 (b): { circuits, tokenId } resolves with NO directory', async () => {
  const c2 = freshChain()
  const api2 = createTapeAPI({ ...NO_DIR, fetch: c2.fetch })
  const svc = await api2.resolve({ circuits: ADDR.circuits, tokenId: '4246' })
  assert.deepEqual(svc.verified, { delegation: true, holder }); assert.equal(svc.container.toLowerCase(), ADDR.container)
  assert.equal(calls(c2, 'serviceOf').length, 0); assert.equal(calls(c2, 'resolve').length, 0)
  assert.equal(calls(c2, 'fileInfo').length, PER); assert.equal(calls(c2, 'read').length, PER)
  assert.equal(readsAt(c2, MANIFEST_PATH).length, 2 * PER)
})
test('TAP-20 §3.2 (c): a label goes through the directory, but the manifest bytes come from the SiteRegistry at the fixed path, never from the directory record', async () => {
  // 目录记录指向一个诱饵路径；那里放着另一份合法清单 / the directory record points at a decoy path holding a different, valid manifest
  const c2 = freshChain((_m, c) => c.register({ label: 'reader', container: ADDR.container, tokenId: 4246, manifestPath: '/decoy.json' }))
  const decoy = buildManifest(); decoy.endpoints.live = manifest.endpoints.live; decoy.name = 'Decoy'
  c2.writeFile(ADDR.container, '/decoy.json', JSON.stringify(decoy))
  const api2 = createTapeAPI({ ...BASE, fetch: c2.fetch })
  const svc = await api2.resolve('reader')
  assert.equal(svc.manifest.name, 'TapeOut Reader')
  assert.equal(calls(c2, 'resolve').length, PER); assert.ok(calls(c2, 'resolve').every((x) => eqAddr(x.to, ADDR.directory)))
  assert.equal(readsAt(c2, '/decoy.json').length, 0)
  assert.equal(readsAt(c2, MANIFEST_PATH).length, 2 * PER)
  for (const x of readsAt(c2, MANIFEST_PATH)) assert.ok(eqAddr(x.to, ADDR.siteRegistry))
})
test('TAP-20 §3.2 (d): manifest bytes whose sha256 differs from fileInfo.sha256Hash are rejected MANIFEST_INVALID', async () => {
  // (d1) index says one hash, bytes are another / 索引哈希与字节不符
  const c2 = freshChain(); c2.setFileInfo(ADDR.container, MANIFEST_PATH, { sha256Hash: '0x' + 'ab'.repeat(32) })
  await assert.rejects(createTapeAPI({ ...NO_DIR, fetch: c2.fetch }).resolve(ADDR.container), (e) => e instanceof TapeAPIError && e.code === 'MANIFEST_INVALID' && /sha256/.test(e.message))
  // (d2) index is intact, the assembled bytes are not (same length, one byte flipped: the SiteRegistry mis-assembly case)
  // 索引完好、拼出来的字节坏了（等长、翻一个字节）：这正是 quorum 挡不住而 fileInfo 能挡住的那种故障
  const c3 = freshChain()
  const good = c3.state.files.get(`${ADDR.container}:${MANIFEST_KEY}`).bytes
  const bad = Uint8Array.from(good); bad[bad.length - 2] ^= 0x01
  c3.setFileBytes(ADDR.container, MANIFEST_PATH, bad)
  await assert.rejects(createTapeAPI({ ...NO_DIR, fetch: c3.fetch }).resolve(ADDR.container), (e) => e.code === 'MANIFEST_INVALID' && /sha256/.test(e.message))
  // and the same file resolves once the index matches the bytes again / 索引恢复一致后即可解析
  c3.setFileInfo(ADDR.container, MANIFEST_PATH, { sha256Hash: toHex(sha256(bad)) })
  await assert.rejects(createTapeAPI({ ...NO_DIR, fetch: c3.fetch }).resolve(ADDR.container), (e) => e.code === 'MANIFEST_INVALID' && !/sha256|fileInfo\.size/.test(e.message)) // flipped byte breaks JSON, not the hash
})
test('TAP-20 §3.2 (e): manifest bytes whose length differs from fileInfo.size are rejected MANIFEST_INVALID', async () => {
  const c2 = freshChain()
  const n = c2.state.files.get(`${ADDR.container}:${MANIFEST_KEY}`).bytes.length
  for (const size of [n + 1, n - 1]) {
    c2.setFileInfo(ADDR.container, MANIFEST_PATH, { size })
    await assert.rejects(createTapeAPI({ ...NO_DIR, fetch: c2.fetch }).resolve(ADDR.container), (e) => e.code === 'MANIFEST_INVALID' && /fileInfo\.size/.test(e.message), String(size))
  }
  // a truncated read with a truthful index is caught the same way / 索引真实、读取被截断，同样被挡
  const c3 = freshChain()
  const good = c3.state.files.get(`${ADDR.container}:${MANIFEST_KEY}`).bytes
  c3.setFileBytes(ADDR.container, MANIFEST_PATH, good.subarray(0, good.length - 1))
  await assert.rejects(createTapeAPI({ ...NO_DIR, fetch: c3.fetch }).resolve(ADDR.container), (e) => e.code === 'MANIFEST_INVALID' && /fileInfo\.size/.test(e.message))
  // a declared size over the 64 KiB cap is refused before read() / 声明长度超上限时不去 read
  const c4 = freshChain(); c4.setFileInfo(ADDR.container, MANIFEST_PATH, { size: 64 * 1024 + 1 })
  await assert.rejects(createTapeAPI({ ...NO_DIR, fetch: c4.fetch }).resolve(ADDR.container), (e) => e.code === 'MANIFEST_INVALID' && /limit/.test(e.message))
  assert.equal(calls(c4, 'read').length, 0)
  // no manifest at all (size 0): MANIFEST_INVALID, not a crash, and read() is never attempted (on mainnet it would revert)
  // 没有清单：干净地 MANIFEST_INVALID，且不会去 read（主网上会回滚）
  const c5 = createFakeChain(); c5.setOwner(4246, holder); c5.setAccount(4246, ADDR.container)
  await assert.rejects(createTapeAPI({ ...NO_DIR, fetch: c5.fetch }).resolve(ADDR.container), (e) => e.code === 'MANIFEST_INVALID' && /no file/.test(e.message))
  assert.equal(calls(c5, 'read').length, 0)
  // index present but read() reverts (file vanished between the two calls): still MANIFEST_INVALID, not RPC_ERROR
  // 索引在、read() 回滚（两次调用之间文件没了）：仍是 MANIFEST_INVALID 而非 RPC_ERROR
  const c6 = freshChain(); c6.setFileBytes(ADDR.container, MANIFEST_PATH, null)
  await assert.rejects(createTapeAPI({ ...NO_DIR, fetch: c6.fetch }).resolve(ADDR.container), (e) => e.code === 'MANIFEST_INVALID' && /reverted/.test(e.message))
})
test('TAP-20 §3.2 (f): an all-zero fileInfo.sha256Hash (TapeKit no-hash state) is rejected as unverified', async () => {
  const c2 = freshChain(); c2.setFileInfo(ADDR.container, MANIFEST_PATH, { sha256Hash: ZERO_HASH })
  await assert.rejects(createTapeAPI({ ...NO_DIR, fetch: c2.fetch }).resolve(ADDR.container), (e) => e.code === 'MANIFEST_INVALID' && /unverified/.test(e.message))
  assert.equal(calls(c2, 'read').length, 0) // never even read / 根本不读
})
test('TAP-20 §3.6 step 3 (g): manifest.container must equal hub.accountOf(manifest.circuits, manifest.tokenId) for label, container AND pair inputs', async () => {
  const other = '0x' + '61'.repeat(20)
  // the hub says (circuits, 4246) lives at `other`; the file at ADDR.container claims ADDR.container, and the directory agrees with the file
  // hub 说 (circuits, 4246) 的容器是 other；ADDR.container 上的清单自称 ADDR.container，目录记录也附和清单
  const c2 = freshChain((_m, c) => { c.setAccount(4246, other); c.register({ label: 'reader', container: ADDR.container, tokenId: 4246 }) })
  const api2 = createTapeAPI({ ...BASE, fetch: c2.fetch })
  await assert.rejects(api2.resolve(ADDR.container), (e) => e.code === 'MANIFEST_INVALID' && /accountOf/.test(e.message))
  await assert.rejects(api2.resolve('reader'), (e) => e.code === 'MANIFEST_INVALID' && /accountOf/.test(e.message))
  await assert.rejects(api2.resolve({ circuits: ADDR.circuits, tokenId: '4246' }), (e) => e.code === 'MANIFEST_INVALID')
  // a manifest that names a different container than the one it lives in / 清单自称另一个容器
  const c3 = freshChain((m) => { m.container = other })
  await assert.rejects(createTapeAPI({ ...NO_DIR, fetch: c3.fetch }).resolve(ADDR.container), (e) => e.code === 'MANIFEST_INVALID' && /does not match resolved container/.test(e.message))
})

test('TAP-22 §3.4 (D15): tx builders given a resolved service use ITS escrow, not the configured one', () => {
  const other = '0x' + 'e5'.repeat(20)
  const svc = { container: ADDR.container, manifest: { container: ADDR.container, payment: { escrow: other, unit: 'BEM', decimals: 8 } } }
  for (const t of [api.tx.fund(svc, 5n), api.tx.requestWithdraw(svc, 5n), api.tx.cancelWithdraw(svc), api.tx.withdraw(svc), api.tx.authorizeSession(svc, ADDR.container, 1900000000)]) {
    assert.equal(t.to, other)
    assert.ok(t.data.toLowerCase().includes(ADDR.container.slice(2).toLowerCase()), 'the provider argument is the service container')
  }
  // a bare address still means the configured escrow / 直接给地址仍用配置的托管
  assert.equal(api.tx.fund(ADDR.container, 5n).to.toLowerCase(), ADDR.escrow.toLowerCase())
  // a free service has no escrow to fund / 免费服务没有可充值的托管
  const free = { container: ADDR.container, manifest: { container: ADDR.container, payment: { escrow: null } } }
  assert.throws(() => api.tx.fund(free, 1n), (e) => e.code === 'MANIFEST_INVALID' && /takes no payment/.test(e.message))
  assert.throws(() => api.chain.escrow.channelOf(ADDR.container, free), (e) => e.code === 'MANIFEST_INVALID' && /takes no payment/.test(e.message), 'reads say the same')
})

test('a holder can delegate from a wallet: typed data for signTypedData, and an EIP-1271 contract holder', async () => {
  // Before this, the only way to produce a delegation was to hand a raw private key to a script: a holder whose
  // circuit sits in MetaMask or a Ledger could not complete provider setup at all, and a Safe never could.
  // 在此之前，产生委托的唯一办法是把私钥交给脚本：电路在 MetaMask 或 Ledger 里的持有人根本没法完成服务搭建，多签更不可能。
  const expires = nowS() + 30 * 86400
  const td = sig.delegationTypedData(56, ADDR.hub, { container: ADDR.container, signer, expires })
  assert.equal(td.primaryType, 'Delegation')
  assert.equal(td.domain.verifyingContract, ADDR.hub)
  assert.deepEqual(td.message, { container: ADDR.container, signer, expires })
  // what a wallet signs over must be exactly the digest the protocol verifies / 钱包签的必须正是协议校验的那个摘要
  assert.equal(toHex(sig.typedDigest(td.domain, sig.hashDelegation(td.message))), toHex(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires })))

  // A contract holder (Safe) signs nothing itself: it answers EIP-1271 for a signature it accepts.
  // 合约持有人自己不签名：它对认可的签名按 EIP-1271 作答。
  const c3 = createFakeChain()
  const safe = '0x' + '5a'.repeat(20)
  c3.setOwner(4246, safe); c3.setAccount(4246, ADDR.container)
  const m = buildManifest()
  m.delegation.sig = signDigest(delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires: m.delegation.expires }), CONSUMER_KEY)
  c3.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify(m))
  const api3 = createTapeAPI({ ...BASE, fetch: c3.fetch })
  await assert.rejects(api3.resolve(ADDR.container), (e) => e.code === 'DELEGATION_INVALID', 'no code at the holder: still ECDSA only')
  c3.setContractHolder(safe, delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires: m.delegation.expires }))
  const svc = await api3.resolve(ADDR.container)
  assert.equal(svc.verified.delegation, true)
  assert.equal(svc.verified.holder.toLowerCase(), safe)
})

test('an async-only service says so instead of crashing inside the request loop', async () => {
  const chain2 = createFakeChain()
  chain2.setOwner(4246, holder); chain2.setAccount(4246, ADDR.container)
  const m = buildManifest()
  m.endpoints = { live: [], async: true }
  chain2.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify(m))
  const api2 = createTapeAPI({ ...BASE, fetch: chain2.fetch })
  const svc = await api2.resolve(ADDR.container)
  await assert.rejects(api2.call(svc, 'blockNumber', {}), (e) => e.code === 'PROVIDER_UNAVAILABLE' && /no live endpoint/.test(e.message))
})

test('the funding path starts with the approval the escrow needs', () => {
  const tx = api.tx.approve({ amount: parseUnits('10') })
  assert.equal(tx.to.toLowerCase(), '0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a', 'BEM by default')
  assert.ok(tx.data.startsWith('0x095ea7b3'), 'approve(address,uint256)')
  assert.ok(tx.data.toLowerCase().includes(ADDR.escrow.slice(2).toLowerCase()), 'the configured escrow is the spender')
  // never an unlimited allowance: the spender may be an escrow the provider chose (review H-1)
  // 绝不无限授权：被授权方可能是服务方选定的托管合约
  assert.throws(() => api.tx.approve(), /needs an amount/)
  assert.throws(() => api.tx.approve({ amount: 2n ** 256n - 1n }), /bounded/)
})
