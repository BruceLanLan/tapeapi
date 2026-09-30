// Independent review of security 1.1 (commit c7eb524), findings SECR-1 to SECR-7, each as regression tests.
// 安全加固 1.1（提交 c7eb524）独立审查的发现 SECR-1 至 SECR-7，逐项写成回归测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTapeAPI, MANIFEST_KEY, MAINNET, CHAINS, TapeAPIError, security, createRpc } from '../src/index.js'
import * as sig from '../src/sig.js'
import { createFakeChain, ADDR } from './helpers/fake-chain.mjs'

const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32), OTHER_KEY = '0x' + '33'.repeat(32), SIGNER2_KEY = '0x' + '44'.repeat(32)
const holder = sig.privateKeyToAddress(HOLDER_KEY), signer = sig.privateKeyToAddress(SIGNER_KEY), signer2 = sig.privateKeyToAddress(SIGNER2_KEY)
const RPC = ['http://rpc1', 'http://rpc2', 'http://rpc3']
const NAME = '4246.7.tape'
const nowS = () => Math.floor(Date.now() / 1000)
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })

function manifestFor({ expires = nowS() + 30 * 86400, signerAddr = signer, holderKey = HOLDER_KEY } = {}) {
  const container = ADDR.container
  return {
    tapeapi: '0.1', name: 'SECR', circuits: ADDR.circuits, tokenId: '4246', container, signer: signerAddr,
    delegation: { expires, sig: sig.signDigest(sig.delegationDigest(56, ADDR.hub, { container, signer: signerAddr, expires }), holderKey) },
    endpoints: { live: ['https://api.example.com/tapeapi/v1'], async: false },
    methods: [{ name: 'ping', priceBEM: '0', params: {}, returns: {} }],
  }
}
function fakeService(manifest = manifestFor()) {
  const chain = createFakeChain()
  chain.setOwner(4246, holder); chain.setAccount(4246, ADDR.container)
  chain.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify(manifest))
  return chain
}
const put = (chain, m) => chain.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify(m))
const testClient = (fetch, o = {}) => createTapeAPI({ rpcUrls: RPC, quorum: 2, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, factory: ADDR.factory, fetch, onWarning: () => {}, ...o })
const contentDigest = (m) => sig.manifestContentDigest(56, ADDR.hub, { container: ADDR.container, contentHash: sig.manifestContentHash(m) })
// every eth_getCode on every node fails (eth_getCode is never batched) / 所有节点的 eth_getCode 都失败（它从不入批）
const failingGetCode = (inner) => async (url, init) => {
  const b = JSON.parse(init.body)
  if (!Array.isArray(b) && b.method === 'eth_getCode') return json({ jsonrpc: '2.0', id: b.id, error: { code: -32000, message: 'boom' } })
  return inner(url, init)
}

// ---------------------------------------------------------------- SECR-1 ----
test('FIXED SECR-1: without requireContentSig, an error while checking contentSig (eth_getCode failing) is the warning CONTENT_SIG_UNCHECKED and the resolution succeeds, as in 1.1.0', async () => {
  const m = manifestFor(); m.contentSig = sig.signDigest(contentDigest(m), OTHER_KEY)   // not the holder: falls through to EIP-1271
  const chain = fakeService(m)
  const warnings = []
  const svc = await testClient(failingGetCode(chain.fetch), { onWarning: (w) => warnings.push(w) }).resolve(NAME)
  assert.deepEqual(svc.contentSig, { valid: false, checked: false })
  assert.deepEqual(warnings.map((w) => w.code), ['CONTENT_SIG_UNCHECKED'])
  assert.equal(svc.warnings[0].cause, 'RPC_ERROR')
  assert.deepEqual(svc.verified, { delegation: true, holder })
  // with requireContentSig the error is thrown as it came (an RPC failure, not a verdict) / 开启时原样抛出
  await assert.rejects(testClient(failingGetCode(chain.fetch), { requireContentSig: true }).resolve(NAME), (e) => e instanceof TapeAPIError && e.code === 'RPC_ERROR' && /eth_getCode/.test(e.message))
  // with every node answering, the same signature is CONTENT_SIG_INVALID as before / 节点都正常时，仍是 CONTENT_SIG_INVALID
  const ok = await testClient(chain.fetch).resolve(NAME)
  assert.deepEqual(ok.contentSig, { valid: false })
  assert.equal(ok.warnings[0].code, 'CONTENT_SIG_INVALID')
})

test('FIXED SECR-1: on the default options (the chain\'s own contracts, sentinel warn) a resolution 1.1.0 accepts is not refused when the slots cannot be read and contentSig cannot be checked', async () => {
  const C56 = CHAINS[56]
  const container = security.erc6551Account({ registry: C56.erc6551Registry, implementation: C56.accountImplementation, chainId: 56, tokenContract: ADDR.circuits, tokenId: 4246 })
  const expires = nowS() + 30 * 86400
  const m = { ...manifestFor(), container, delegation: { expires, sig: sig.signDigest(sig.delegationDigest(56, MAINNET.hub, { container, signer, expires }), HOLDER_KEY) } }
  m.contentSig = sig.signDigest(sig.manifestContentDigest(56, MAINNET.hub, { container, contentHash: sig.manifestContentHash(m) }), OTHER_KEY)
  const chain = createFakeChain()
  chain.setOwner(4246, holder); chain.setAccount(4246, container); chain.writeFile(container, MANIFEST_KEY, JSON.stringify(m))
  for (const u of RPC) chain.setFault(u, 'nostorage')
  const warnings = []
  const svc = await createTapeAPI({ rpcUrls: RPC, quorum: 2, fetch: failingGetCode(chain.fetch), onWarning: (w) => warnings.push(w.code) }).resolve(NAME)
  assert.deepEqual(warnings.sort(), ['CONTENT_SIG_UNCHECKED', 'IMPL_UNREAD'])
  assert.equal(svc.sentinel.container, 'match')
  assert.deepEqual(svc.contentSig, { valid: false, checked: false })
})

// ---------------------------------------------------------------- SECR-2 ----
const VICTIM = '0x' + '99'.repeat(20)
const req = { method: 'getBalance', params: { addr: '0x1' } }
const blk = { chainId: 1, blockNumber: 100, blockHash: '0x' + 'ab'.repeat(32) }
const envOf = (key, container, id, ts, result) => ({ container, signer: sig.privateKeyToAddress(key), id, ts, result, sig: sig.signResponse({ container, id, method: req.method, params: req.params, ok: true, body: result, ts }, key) })

test('FIXED SECR-2: a record whose signers are not confirmed is never valid: a forger signing two envelopes that name a victim\'s container gets valid: false, signaturesConsistent: true', async () => {
  const a = envOf(OTHER_KEY, VICTIM, 'r1', 1000, { ...blk, result: { v: 1 } })
  const b = envOf(OTHER_KEY, VICTIM, 'r2', 1001, { ...blk, result: { v: 2 } })
  const rec = security.contradictionRecord({ ...req, a, b })
  const bare = await security.verifyContradiction(rec)
  assert.equal(bare.valid, false)
  assert.match(bare.reason, /^signer unverified/)
  assert.equal(bare.signaturesConsistent, true)
  assert.equal(bare.signersChecked, false)
  assert.equal(bare.kind, 'self')
  // signerOf throwing is unverified too, never valid / signerOf 抛错同样是未核实
  const threw = await security.verifyContradiction(rec, { signerOf: async () => { throw new Error('offline') } })
  assert.equal(threw.valid, false); assert.equal(threw.signaturesConsistent, true); assert.match(threw.reason, /offline/)
  // the victim's real signer: the forgery is refuted / 受害者真正的签名者：伪造被驳回
  const refuted = await security.verifyContradiction(rec, { signerOf: async () => signer })
  assert.equal(refuted.valid, false); assert.equal(refuted.signaturesConsistent, undefined)
  // the signer the container really delegates to: valid / 容器确实委托的签名者：成立
  const real = await security.verifyContradiction(rec, { signerOf: async () => sig.privateKeyToAddress(OTHER_KEY) })
  assert.deepEqual(real, { valid: true, kind: 'self', weak: false, block: blk, signaturesConsistent: true, signersChecked: true })
  // a broken signature is not "consistent" / 坏签名不算"自洽"
  const tampered = JSON.parse(JSON.stringify(rec)); tampered.envelopes[1].result.result.v = 3
  assert.equal((await security.verifyContradiction(tampered)).signaturesConsistent, undefined)
})

test('CONFIRMED SECR-2 (documented): a blockPinned statement is the whole result, so a varying field (fetchedAt) makes honest answers differ: only for methods the block fully determines', async () => {
  const p = { blockPinned: { blockNumber: 5, blockHash: '0x' + 'cd'.repeat(32) } }
  const a = envOf(OTHER_KEY, VICTIM, 'x1', 2000, { ...p, price: 1, fetchedAt: 2000 })
  const b = envOf(OTHER_KEY, VICTIM, 'x2', 2001, { ...p, price: 1, fetchedAt: 2001 })
  assert.notEqual(security.statementHash(a.result), security.statementHash(b.result))
  const r = await security.verifyContradiction(security.contradictionRecord({ ...req, a, b }))
  assert.equal(r.valid, false, 'and never valid without signerOf')
})

// ---------------------------------------------------------------- SECR-3 ----
test('FIXED SECR-3: with pin, a node that has not reached the pinned block ("header not found") did not answer: 2 of 3 still resolve', async () => {
  const chain = fakeService()
  chain.setFault('http://rpc3', 'lag:5')
  const svc = await testClient(chain.fetch, { pin: true }).resolve(NAME)
  assert.equal(svc.pinned.number, chain.state.block - 2)
  assert.ok(chain.state.reads.some((r) => r.url === 'http://rpc3'), 'rpc3 was still asked')
  // by number too / 按块号也一样
  assert.equal((await testClient(chain.fetch, { pin: { by: 'number' } }).resolve(NAME)).pinned.by, 'number')
  // two lagging nodes: the pin is the block two operators reached, and rpc1 (ahead) answers there too
  // 两个落后节点：钉的是两家运营方都到达的区块，领先的 rpc1 也在那里作答
  chain.setFault('http://rpc2', 'lag:5')
  assert.equal((await testClient(chain.fetch, { pin: { tag: 'latest' } }).resolve(NAME)).pinned.number, chain.state.block - 5)
})

test('FIXED SECR-3: quorum is not weakened: a node that has the pinned block and answers differently, or reverts where others answer, is still RPC_DISAGREE', async () => {
  const chain = fakeService()
  chain.setFault('http://rpc3', 'lag:5')
  chain.setFault('http://rpc2', 'disagree')
  await assert.rejects(testClient(chain.fetch, { pin: true }).resolve(NAME), (e) => e.code === 'RPC_DISAGREE')
  chain.setFault('http://rpc2', null)
  // rpc2 reverts ownerOf at the pinned block while rpc1 answers / rpc2 在钉块上对 ownerOf 回滚，rpc1 正常作答
  const OWNER_OF = '0x6352211e'
  const reverting = async (url, init) => {
    const b = JSON.parse(init.body)
    if (url !== 'http://rpc2') return chain.fetch(url, init)
    const list = Array.isArray(b) ? b : [b]
    if (!list.some((r) => r.method === 'eth_call' && r.params[0].data.startsWith(OWNER_OF))) return chain.fetch(url, init)
    const out = await Promise.all(list.map(async (r) => (r.method === 'eth_call' && r.params[0].data.startsWith(OWNER_OF)
      ? { jsonrpc: '2.0', id: r.id, error: { code: 3, message: 'execution reverted' } }
      : (await chain.fetch(url, { ...init, body: JSON.stringify(r) })).json())))
    return json(Array.isArray(b) ? out : out[0])
  }
  await assert.rejects(testClient(reverting, { pin: true }).resolve(NAME), (e) => e.code === 'RPC_DISAGREE')
})

test('FIXED SECR-3: only pinned state reads treat "no such block" as no answer; at a tag (the default) it is still an answer, and "not currently canonical" is always one', async () => {
  const mk = (third) => async (url, init) => {
    const b = JSON.parse(init.body)
    const one = (r) => (url === 'http://rpc3' ? { jsonrpc: '2.0', id: r.id, error: third } : { jsonrpc: '2.0', id: r.id, result: '0x' + '00'.repeat(31) + '01' })
    return json(Array.isArray(b) ? b.map(one) : one(b))
  }
  const call = (third, block) => createRpc({ urls: RPC, quorum: 2, fetch: mk(third), disagreeRetryMs: 0 }).ethCall(ADDR.hub, '0x12345678', block)
  const pinned = { blockHash: '0x' + 'b1'.repeat(32), requireCanonical: true }
  for (const third of [{ code: -32000, message: 'header for hash 0xb1 not found' }, { code: -32000, message: 'header not found' }, { code: -32001, message: 'resource not found' }, { code: -32000, message: 'unknown block' }]) {
    assert.equal(await call(third, pinned), '0x' + '00'.repeat(31) + '01', third.message)
    assert.equal(await call(third, '0x10'), '0x' + '00'.repeat(31) + '01', third.message)
    await assert.rejects(call(third, 'latest'), (e) => e.code === 'RPC_DISAGREE', `latest: ${third.message} is an answer, as in 1.1.0`)
  }
  await assert.rejects(call({ code: -32000, message: 'hash 0xb1 is not currently canonical' }, pinned), (e) => e.code === 'RPC_DISAGREE')
  await assert.rejects(call({ code: 3, message: 'execution reverted: block not found' }, pinned), (e) => e.code === 'RPC_DISAGREE', 'a revert is an answer')
  // two of three without the block: fewer than quorum answered, RPC_UNAVAILABLE (never a result from one node)
  // 三个里两个没有该块：作答不足法定数，RPC_UNAVAILABLE（绝不凭一个节点给结果）
  const twoMissing = async (url, init) => {
    const b = JSON.parse(init.body)
    return json(url === 'http://rpc1' ? { jsonrpc: '2.0', id: b.id, result: '0x01' } : { jsonrpc: '2.0', id: b.id, error: { code: -32000, message: 'header not found' } })
  }
  await assert.rejects(createRpc({ urls: RPC, quorum: 2, fetch: twoMissing }).call('eth_getStorageAt', [ADDR.hub, '0x0', pinned]), (e) => e.code === 'RPC_UNAVAILABLE' && /pinned block/.test(e.message))
  // eth_getLogs is not a pinned state read: its errors keep their 1.1.0 meaning / eth_getLogs 不是钉块状态读取
  await assert.rejects(createRpc({ urls: RPC, quorum: 2, fetch: twoMissing, disagreeRetryMs: 0 }).call('eth_getLogs', [{ blockHash: pinned.blockHash }]), (e) => e.code === 'RPC_DISAGREE')
})

// ---------------------------------------------------------------- SECR-4 ----
test('FIXED SECR-4: the delegation floor is per signer: a holder who replaces the signer with a shorter delegation is accepted; the same signer\'s shorter delegation is refused', async () => {
  const t = nowS()
  const store = new Map()
  const chain = fakeService(manifestFor({ expires: t + 360 * 86400 }))
  const api = testClient(chain.fetch, { delegationFloor: store })
  await api.resolve(NAME)
  put(chain, manifestFor({ expires: t + 30 * 86400, signerAddr: signer2 }))
  assert.equal((await api.resolve(NAME)).manifest.signer, signer2, 'a new signer starts its own floor')
  assert.equal(store.size, 2)
  // the same signer, shorter: an older manifest put back / 同一签名者、更短：被放回的旧清单
  put(chain, manifestFor({ expires: t + 20 * 86400, signerAddr: signer2 }))
  const err = await api.resolve(NAME).then(() => assert.fail('accepted'), (e) => e)
  assert.equal(err.code, 'DELEGATION_INVALID')
  assert.deepEqual(err.data, { expires: t + 20 * 86400, floor: t + 30 * 86400, chainId: 56, container: ADDR.container, holder, signer: signer2 })
  // the holder shortened it on purpose: clearDelegationFloor(error.data) accepts it again / 持有人有意缩短：清除后再次接受
  assert.equal(await api.clearDelegationFloor(err.data), true)
  assert.equal((await api.resolve(NAME)).manifest.delegation.expires, t + 20 * 86400)
  assert.equal(store.get(`56:${ADDR.container.toLowerCase()}:${holder.toLowerCase()}:${signer2.toLowerCase()}`), t + 20 * 86400)
  assert.equal(await api.clearDelegationFloor({ container: ADDR.container, holder, signer: sig.privateKeyToAddress(OTHER_KEY) }), false)
  await assert.rejects(api.clearDelegationFloor({ container: 'x', holder, signer }), (e) => e.code === 'INVALID_ARGUMENT')
  assert.equal(await testClient(chain.fetch).clearDelegationFloor({ container: ADDR.container, holder, signer }), false, 'no floor configured')
})

test('FIXED SECR-4: a { get, set } store without delete is cleared by setting 0; CONFIRMED limit: an earlier signer\'s delegation put back is not refused', async () => {
  const t = nowS()
  const m = new Map()
  const store = { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v) } }
  const oldA = manifestFor({ expires: t + 360 * 86400 })
  const chain = fakeService(oldA)
  const api = testClient(chain.fetch, { delegationFloor: store })
  await api.resolve(NAME)
  put(chain, manifestFor({ expires: t + 30 * 86400, signerAddr: signer2 }))
  await api.resolve(NAME)
  // documented limit (TAPI-20 §8): whoever writes the site can put signer A's manifest back / 已写明的局限
  put(chain, oldA)
  assert.equal((await api.resolve(NAME)).manifest.signer, signer)
  put(chain, manifestFor({ expires: t + 10 * 86400 }))
  await assert.rejects(api.resolve(NAME), (e) => e.code === 'DELEGATION_INVALID')
  assert.equal(await api.clearDelegationFloor({ container: ADDR.container, holder, signer }), true)
  assert.equal(m.get(`56:${ADDR.container.toLowerCase()}:${holder.toLowerCase()}:${signer.toLowerCase()}`), 0)
  await api.resolve(NAME)
  assert.equal(m.get(`56:${ADDR.container.toLowerCase()}:${holder.toLowerCase()}:${signer.toLowerCase()}`), t + 10 * 86400, 'cleared to 0, then raised by the accepted resolve')
})

// ---------------------------------------------------------------- SECR-5 ----
test('FIXED SECR-5: eth_getStorageAt never joins an eth_call batch, so a node refusing it cannot stop eth_call batching; P101-3 is unchanged for eth_call batches', async () => {
  const sent = []
  let refuseAll = false
  const fetch = async (url, init) => {
    const b = JSON.parse(init.body)
    sent.push({ url, batch: Array.isArray(b), methods: (Array.isArray(b) ? b : [b]).map((r) => r.method) })
    if (Array.isArray(b) && (refuseAll || b.some((r) => r.method === 'eth_getStorageAt'))) return json({ error: 'batch refused' }, 403)
    const one = (r) => ({ jsonrpc: '2.0', id: r.id, result: '0x' + '00'.repeat(32) })
    return json(Array.isArray(b) ? b.map(one) : one(b))
  }
  const rpc = createRpc({ urls: ['http://rpc1', 'http://rpc2'], quorum: 2, fetch })
  const burst = () => Promise.all([rpc.ethCall(ADDR.hub, '0x01'), rpc.ethCall(ADDR.hub, '0x02'), rpc.call('eth_getStorageAt', [ADDR.hub, '0x0', 'latest']), rpc.call('eth_getStorageAt', [ADDR.hub, '0x1', 'latest'])])
  for (let i = 0; i < 3; i++) {
    sent.length = 0
    await burst()
    for (const u of ['http://rpc1', 'http://rpc2']) {
      const mine = sent.filter((s) => s.url === u)
      assert.deepEqual(mine.filter((s) => s.batch).map((s) => s.methods), [['eth_call', 'eth_call']], `${u} round ${i}`)
      assert.equal(mine.filter((s) => !s.batch && s.methods[0] === 'eth_getStorageAt').length, 2)
    }
  }
  // P101-3: a node that answers "no" to an eth_call batch gets calls alone from then on / 对 eth_call 批量作答说"不"的节点，此后逐个发送
  refuseAll = true
  await Promise.all([rpc.ethCall(ADDR.hub, '0x01'), rpc.ethCall(ADDR.hub, '0x02')])
  refuseAll = false
  sent.length = 0
  await Promise.all([rpc.ethCall(ADDR.hub, '0x01'), rpc.ethCall(ADDR.hub, '0x02')])
  assert.ok(sent.every((s) => !s.batch), 'permanent after an answered refusal of an eth_call batch')
})

// ---------------------------------------------------------------- SECR-6 ----
test('FIXED SECR-6: an async onMismatch or onError that rejects never becomes an unhandledRejection', async () => {
  let unhandled = 0
  const onUnhandled = () => { unhandled++ }
  process.on('unhandledRejection', onUnhandled)
  try {
    const svc = (c, h, origin) => ({ container: c, verified: { holder: h }, manifest: { signer, endpoints: { live: [origin] }, methods: [{ name: 'm', priceBEM: '0' }] } })
    const A = svc('0x' + '01'.repeat(20), '0x' + 'a1'.repeat(20), 'https://a.example'), B = svc('0x' + '02'.repeat(20), '0x' + 'a2'.repeat(20), 'https://b.example')
    const answer = (v) => ({ id: 'i', ts: 1, result: { ...blk, result: { v } }, sig: '0x' })
    const mismatch = security.withSpotCheck({ call: async (s) => answer(s === B ? 2 : 1) }, { rate: 1, alternates: [B], onMismatch: async () => { throw new Error('async reporter') } })
    await mismatch.call(A, 'm', {})
    const noAlt = security.withSpotCheck({ call: async () => answer(1) }, { rate: 1, alternates: [], onError: async () => { throw new Error('async onError') } })
    await noAlt.call(A, 'm', {})
    const waited = security.withSpotCheck({ call: async () => answer(1) }, { rate: 1, alternates: [], wait: true, onError: () => Promise.reject(new Error('rejected')) })
    assert.equal((await waited.call(A, 'm', {})).spotCheck.error.code, 'QUORUM_FAILED')
    const sync = security.withSpotCheck({ call: async () => answer(1) }, { rate: 1, alternates: [], wait: true, onError: () => { throw new Error('sync') } })
    await sync.call(A, 'm', {})
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(unhandled, 0)
  } finally { process.off('unhandledRejection', onUnhandled) }
})

// ---------------------------------------------------------------- SECR-7 ----
test('FIXED SECR-7: a cached pin found stale is dropped: once the nodes move on, the next resolution pins anew instead of failing until cacheS runs out', async () => {
  const chain = fakeService()
  const t0 = nowS()
  chain.state.headTime = t0
  let t = t0
  const api = testClient(chain.fetch, { pin: { cacheS: 3600, maxAgeS: 100 }, clock: () => t })
  const first = await api.resolve(NAME)
  t = t0 + 10; chain.state.block += 3; chain.state.headTime = t
  assert.equal((await api.resolve(NAME)).pinned.number, first.pinned.number, 'reused within cacheS while fresh')
  // the clock passes maxAgeS while the cached block does not move / 时钟越过 maxAgeS，缓存的区块不变
  t = t0 + 200
  await assert.rejects(api.resolve(NAME), (e) => e.code === 'RPC_STALE')
  // the chain moves on: a new pin, not the cached stale one / 链继续前进：重新钉块，而不是用缓存的过期区块
  chain.state.block += 400; chain.state.headTime = t
  const again = await api.resolve(NAME)
  assert.equal(again.pinned.number, chain.state.block - 2)
})
