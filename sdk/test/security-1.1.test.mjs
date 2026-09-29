// Security 1.1 (docs/DESIGN-security-1.1.md): each item as tests. SEC11-1 pinned block with freshness, SEC11-2 identity-root
// sentinel, SEC11-3 manifest content signature, SEC11-4 contradiction evidence, SEC11-5 random second opinion, SEC11-6
// delegation floor. The resolve budget is asserted in resolve-rounds.test.mjs.
// 安全加固 1.1：每一项写成测试。SEC11-1 钉块与新鲜度，SEC11-2 身份根哨兵，SEC11-3 清单内容签名，SEC11-4 矛盾证据，
// SEC11-5 随机抽查，SEC11-6 委托下限。解析的请求预算在 resolve-rounds.test.mjs 里断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createTapeAPI, MANIFEST_KEY, MAINNET, CHAINS, IMPL_SLOT, TapeAPIError, security, createRpc } from '../src/index.js'
import * as sig from '../src/sig.js'
import { createFakeChain, ADDR } from './helpers/fake-chain.mjs'

const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32), OTHER_KEY = '0x' + '33'.repeat(32)
const holder = sig.privateKeyToAddress(HOLDER_KEY), signer = sig.privateKeyToAddress(SIGNER_KEY)
const RPC = ['http://rpc1', 'http://rpc2', 'http://rpc3']
const NAME = '4246.7.tape'
const nowS = () => Math.floor(Date.now() / 1000)
const C56 = CHAINS[56]
// The container ERC-6551 derives for (ADDR.circuits, 4246) on BNB Smart Chain / BSC 上按 ERC-6551 推导出的容器
const REAL = security.erc6551Account({ registry: C56.erc6551Registry, implementation: C56.accountImplementation, chainId: 56, tokenContract: ADDR.circuits, tokenId: 4246 })

function manifestFor({ container = ADDR.container, hub = ADDR.hub, expires = nowS() + 30 * 86400, holderKey = HOLDER_KEY, extra = {} } = {}) {
  return {
    tapeapi: '0.1', name: 'Security 1.1', circuits: ADDR.circuits, tokenId: '4246', container, signer,
    delegation: { expires, sig: sig.signDigest(sig.delegationDigest(56, hub, { container, signer, expires }), holderKey) },
    endpoints: { live: ['https://api.example.com/tapeapi/v1'], async: false },
    methods: [{ name: 'ping', priceBEM: '0', params: {}, returns: {} }],
    ...extra,
  }
}
function fakeService({ container = ADDR.container, hub = ADDR.hub, manifest } = {}) {
  const chain = createFakeChain()
  chain.setOwner(4246, holder); chain.setAccount(4246, container)
  chain.writeFile(container, MANIFEST_KEY, JSON.stringify(manifest ?? manifestFor({ container, hub })))
  return chain
}
// A client on test contracts (no sentinel: chains.js knows none of them) / 测试合约上的客户端（chains.js 不认识，无哨兵）
const testClient = (fetch, o = {}) => createTapeAPI({ rpcUrls: RPC, quorum: 2, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, factory: ADDR.factory, fetch, ...o })
// A client on the chain's own contracts: the default configuration / 用本链自己合约的客户端：默认配置
const ownClient = (fetch, o = {}) => createTapeAPI({ rpcUrls: RPC, quorum: 2, fetch, ...o })
const invalid = (re) => (e) => e instanceof TapeAPIError && e.code === 'INVALID_ARGUMENT' && (!re || re.test(e.message))

// ---------------------------------------------------------------- SEC11-1 pinned block ----
test('CONFIRMED SEC11-1: by default nothing is pinned (chains.js pin: latest): every read is at "latest" and no block is asked for', async () => {
  const chain = fakeService()
  const svc = await testClient(chain.fetch).resolve(NAME)
  assert.equal(svc.pinned, undefined)
  assert.ok(chain.state.reads.length > 0)
  assert.ok(chain.state.reads.every((r) => r.block === 'latest'), 'every read at latest, as in 1.0')
  assert.ok(!chain.state.requests.some((r) => r.calls.includes('eth_getBlockByNumber')))
})

test('FIXED SEC11-1: with pin, every read of one resolution is made at one block hash that nodes of two operators confirmed (EIP-1898)', async () => {
  const chain = fakeService()
  const svc = await testClient(chain.fetch, { pin: true }).resolve(NAME)
  const want = { blockHash: chain.blockHash(chain.state.block - 2), requireCanonical: true }
  assert.deepEqual(svc.pinned, { number: chain.state.block - 2, hash: want.blockHash, tag: 'finalized', by: 'hash', timestamp: svc.pinned.timestamp })
  assert.ok(chain.state.reads.length >= 6 * 3)
  for (const r of chain.state.reads) assert.deepEqual(r.block, want, `${r.url} ${r.fn ?? r.method}`)
  // by number: the hex block number, never a tag / 按块号：十六进制块号，绝不是标签
  const c2 = fakeService()
  const byNumber = await testClient(c2.fetch, { pin: { by: 'number' } }).resolve(NAME)
  assert.equal(byNumber.pinned.by, 'number')
  for (const r of c2.state.reads) assert.equal(r.block, '0x' + (c2.state.block - 2).toString(16))
  // an L2 client starts from `safe` / L2 客户端从 safe 开始
  const c3 = fakeService()
  const l2 = testClient(c3.fetch, { chainId: 8453, pin: true })
  await assert.rejects(l2.resolve({ circuits: ADDR.circuits, tokenId: 4246, chainId: 8453 }), (e) => e.code === 'DELEGATION_INVALID', 'the manifest was signed for chain 56')
  assert.ok(c3.state.reads.every((r) => r.block.blockHash === c3.blockHash(c3.state.block - 40)), 'safe = head - 40 on the fake chain')
})

test('FIXED SEC11-1: a pinned block older than maxAgeS, or ahead of the clock, is RPC_STALE; the clock option is what is read', async () => {
  const chain = fakeService()
  const t0 = nowS()
  chain.state.headTime = t0
  // BSC: maxPinAgeS 180 (chains.js); the finalized block is 2 s old at t0 / BSC 的时限为 180 秒；t0 时 finalized 块 2 秒旧
  await testClient(chain.fetch, { pin: true, clock: () => t0 + 170 }).resolve(NAME)
  await assert.rejects(testClient(chain.fetch, { pin: true, clock: () => t0 + 179 }).resolve(NAME), (e) => e.code === 'RPC_STALE' && e.data.ageS === 181 && e.data.maxAgeS === 180)
  await assert.rejects(testClient(chain.fetch, { pin: { maxAgeS: 30 }, clock: () => t0 + 40 }).resolve(NAME), (e) => e.code === 'RPC_STALE')
  // a block from the future (by more than maxSkewS) / 来自未来的区块（超过 maxSkewS）
  await assert.rejects(testClient(chain.fetch, { pin: true, clock: () => t0 - 400 }).resolve(NAME), (e) => e.code === 'RPC_STALE' && /ahead/.test(e.message))
  // a cached pin is checked again on every use / 缓存的区块每次使用都重新检查
  let t = t0
  const api = testClient(chain.fetch, { pin: { cacheS: 3600 }, clock: () => t })
  await api.resolve(NAME)
  const asked = chain.state.requests.filter((r) => r.calls.includes('eth_getBlockByNumber')).length
  t = t0 + 100; await api.resolve(NAME)
  assert.equal(chain.state.requests.filter((r) => r.calls.includes('eth_getBlockByNumber')).length, asked, 'the pin was reused')
  t = t0 + 200; await assert.rejects(api.resolve(NAME), (e) => e.code === 'RPC_STALE')
})

test('FIXED SEC11-1: confirmedBlock takes the highest block two operators reached, never one node\'s tag; two hashes for one number are RPC_DISAGREE', async () => {
  const chain = fakeService()
  const rpc = createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch })
  const head = chain.state.block
  // 1rpc answered finalized = latest − 5000 on BSC: one node far behind does not drag the pin back
  chain.setTagLag('http://rpc1', 'finalized', 5000)
  assert.equal((await rpc.confirmedBlock('finalized')).number, head - 2)
  // one node far AHEAD cannot pull it forward either: two operators must have reached it
  // 一个节点远远超前也拉不动：必须有两家运营方都已到达
  chain.setTagLag('http://rpc1', 'finalized', 0)
  chain.setTagLag('http://rpc2', 'finalized', 7)
  const b = await rpc.confirmedBlock('finalized')
  assert.equal(b.number, head - 2)
  assert.equal(b.hash, chain.blockHash(head - 2))
  // a node on another fork: its hash for the chosen block differs from the others' / 另一条分叉上的节点
  chain.setTagLag('http://rpc2', 'finalized', 2)
  chain.setFault('http://rpc3', 'fork')
  await assert.rejects(rpc.confirmedBlock('finalized'), (e) => e.code === 'RPC_DISAGREE')
  chain.setFault('http://rpc3', null)
  // fewer than two operators answer / 作答的运营方不足两家
  chain.setFault('http://rpc1', 'http500'); chain.setFault('http://rpc2', 'http500')
  await assert.rejects(rpc.confirmedBlock('finalized'), (e) => e.code === 'RPC_UNAVAILABLE')
  await assert.rejects(rpc.confirmedBlock('pending'), invalid(/finalized/))
})

test('FIXED SEC11-1: the pin option is checked when the client is made; sub-clients use their own chain\'s tag', async () => {
  assert.throws(() => createTapeAPI({ pin: 'yes' }), invalid(/pin/))
  assert.throws(() => createTapeAPI({ pin: { tag: 'pending' } }), invalid(/tag/))
  assert.throws(() => createTapeAPI({ pin: { maxAgeS: 0 } }), invalid(/maxAgeS/))
  assert.throws(() => createTapeAPI({ pin: { by: 'label' } }), invalid(/by/))
  assert.throws(() => createTapeAPI({ clock: 5 }), invalid(/clock/))
  await assert.rejects(createTapeAPI({ rpcUrls: RPC, fetch: fakeService().fetch, clock: () => Date.now() }).resolve(NAME), invalid(/milliseconds|Unix seconds/))
  // The root pins from an explicit `finalized`; its Base sub-client pins too, but from Base's own `safe`.
  // 根客户端显式从 finalized 钉块；它的 Base 子客户端同样钉块，但从 Base 自己的 safe 开始。
  const l2 = createFakeChain({ chainId: 8453 })
  const api = createTapeAPI({ rpcUrls: RPC, quorum: 2, fetch: l2.fetch, pin: { tag: 'finalized', maxAgeS: 60 }, chains: { 8453: { rpcUrls: ['http://b1', 'http://b2'] } } })
  await assert.rejects(api.resolve({ circuits: ADDR.circuits, tokenId: 1, chainId: 8453 }))
  const tags = l2.state.requests.filter((r) => r.url.startsWith('http://b') && r.calls.includes('eth_getBlockByNumber'))
  assert.ok(tags.length >= 2)
  assert.ok(l2.state.reads.length > 0 && l2.state.reads.every((r) => r.block.blockHash === l2.blockHash(l2.state.block - 40)), 'safe = head - 40')
})

// ---------------------------------------------------------------- SEC11-2 sentinel ----
function ownService(manifestExtra = {}) {
  const m = manifestFor({ container: REAL, hub: MAINNET.hub, extra: manifestExtra })
  const chain = createFakeChain()
  chain.setOwner(4246, holder); chain.setAccount(4246, REAL)
  chain.writeFile(REAL, MANIFEST_KEY, JSON.stringify(m))
  return chain
}

test('FIXED SEC11-2: on the chain\'s own contracts, resolve reads the DeWebHub and SiteRegistry implementation slots and re-derives the container locally; all known: no warning', async () => {
  const chain = ownService()
  const warnings = []
  const svc = await ownClient(chain.fetch, { onWarning: (w) => warnings.push(w) }).resolve(NAME)
  assert.deepEqual(warnings, [])
  assert.equal(svc.warnings, undefined)
  assert.equal(svc.sentinel.mode, 'warn')
  assert.equal(svc.sentinel.container, 'match')
  assert.deepEqual(svc.sentinel.implementations.map((x) => [x.role, x.proxy.toLowerCase(), x.implementation, x.expected]), [
    ['hub', MAINNET.hub.toLowerCase(), C56.expectedImpl[MAINNET.hub.toLowerCase()][0], true],
    ['siteRegistry', MAINNET.siteRegistry.toLowerCase(), C56.expectedImpl[MAINNET.siteRegistry.toLowerCase()][0], true],
  ])
  assert.ok(chain.state.reads.some((r) => r.method === 'eth_getStorageAt' && r.block === 'latest'))
  // A client on other contracts has no expected implementation to compare with: no sentinel at all.
  // 用其它合约的客户端没有可比对的实现：完全不启用哨兵。
  const t = fakeService()
  assert.equal((await testClient(t.fetch).resolve(NAME)).sentinel, undefined)
  assert.ok(!t.state.reads.some((r) => r.method === 'eth_getStorageAt'))
})

test('FIXED SEC11-2: an upgraded hub or SiteRegistry is reported (warn, the default) or refused (strict: CONTRACT_UNKNOWN); it is noticed, not prevented', async () => {
  const chain = ownService()
  const evil = '0x' + 'e7'.repeat(20)
  chain.setImplementation(MAINNET.siteRegistry, evil)
  const seen = []
  const svc = await ownClient(chain.fetch, { onWarning: (w) => seen.push(w.code) }).resolve(NAME)
  assert.deepEqual(seen, ['IMPL_UNKNOWN'])
  assert.equal(svc.warnings[0].code, 'IMPL_UNKNOWN')
  assert.equal(svc.warnings[0].implementation, evil)
  assert.equal(svc.warnings[0].role, 'siteRegistry')
  assert.deepEqual(svc.sentinel.implementations.map((x) => x.expected), [true, false])
  await assert.rejects(ownClient(chain.fetch, { sentinel: 'strict' }).resolve(NAME), (e) => e.code === 'CONTRACT_UNKNOWN' && e.data.implementation === evil)
  // 'off' reads nothing / 'off' 什么都不读
  const quiet = ownService()
  quiet.setImplementation(MAINNET.hub, evil)
  const off = await ownClient(quiet.fetch, { sentinel: 'off', onWarning: () => assert.fail('no warning when off') }).resolve(NAME)
  assert.equal(off.sentinel, undefined)
  assert.ok(!quiet.state.reads.some((r) => r.method === 'eth_getStorageAt'))
  assert.throws(() => createTapeAPI({ sentinel: 'loud' }), invalid(/sentinel/))
})

test('FIXED SEC11-2: hub.accountOf that differs from the local ERC-6551 derivation is CONTAINER_MISMATCH (strict: MANIFEST_INVALID)', async () => {
  // The nodes (or an upgraded hub) say the pair derives a container ERC-6551 does not: the manifest agrees with them.
  // 节点（或升级后的 hub）说该二元组推导出的容器与 ERC-6551 不同，清单也跟着写。
  const bogus = '0x' + '6b'.repeat(20)
  const chain = createFakeChain()
  chain.setOwner(4246, holder); chain.setAccount(4246, bogus)
  chain.writeFile(bogus, MANIFEST_KEY, JSON.stringify(manifestFor({ container: bogus, hub: MAINNET.hub })))
  const seen = []
  const svc = await ownClient(chain.fetch, { onWarning: (w) => seen.push(w) }).resolve(NAME)
  assert.equal(svc.sentinel.container, 'mismatch')
  assert.equal(seen[0].code, 'CONTAINER_MISMATCH')
  assert.equal(seen[0].local, REAL)
  await assert.rejects(ownClient(chain.fetch, { sentinel: 'strict' }).resolve(NAME), (e) => e.code === 'MANIFEST_INVALID' && /ERC-6551/.test(e.message))
})

test('FIXED SEC11-2: slots a node will not read are IMPL_UNREAD in warn mode (resolve still succeeds) and an error in strict mode; errors are not cached', async () => {
  const chain = ownService()
  for (const u of RPC) chain.setFault(u, 'nostorage')
  const seen = []
  const api = ownClient(chain.fetch, { onWarning: (w) => seen.push(w.code) })
  const svc = await api.resolve(NAME)
  assert.deepEqual(seen, ['IMPL_UNREAD'])
  assert.equal(svc.sentinel.implementations, null)
  await assert.rejects(ownClient(chain.fetch, { sentinel: 'strict' }).resolve(NAME), (e) => e.code === 'RPC_UNAVAILABLE')
  for (const u of RPC) chain.setFault(u, null)
  const again = await api.resolve(NAME)
  assert.deepEqual(again.sentinel.implementations.map((x) => x.expected), [true, true], 'read again, not a cached failure')
})

test('FIXED SEC11-2: without onWarning a warning goes to console.warn once per distinct message', async () => {
  const chain = ownService()
  chain.setImplementation(MAINNET.hub, '0x' + 'e8'.repeat(20))
  const logged = []
  const real = console.warn
  console.warn = (...a) => logged.push(a.join(' '))
  try {
    await ownClient(chain.fetch).resolve(NAME)
    await ownClient(chain.fetch).resolve(NAME)
  } finally { console.warn = real }
  assert.equal(logged.filter((l) => /IMPL_UNKNOWN/.test(l)).length, 1)
})

// ---------------------------------------------------------------- SEC11-3 content signature ----
const contentSigned = (m, key = HOLDER_KEY, hub = ADDR.hub) => ({ ...m, contentSig: sig.signDigest(sig.manifestContentDigest(56, hub, { container: m.container, contentHash: sig.manifestContentHash(m) }), key) })

test('FIXED SEC11-3: a holder contentSig over the published manifest verifies; the same bytes without it resolve exactly as in 1.0', async () => {
  const signed = contentSigned(manifestFor())
  const chain = fakeService({ manifest: signed })
  const svc = await testClient(chain.fetch, { requireContentSig: true }).resolve(NAME)
  assert.deepEqual(svc.contentSig, { valid: true })
  assert.deepEqual(svc.verified, { delegation: true, holder })
  // no field, no option: nothing new on the result / 没有字段、没有选项：结果上没有任何新东西
  const plain = await testClient(fakeService().fetch).resolve(NAME)
  assert.equal(plain.contentSig, undefined)
  assert.equal(plain.warnings, undefined)
})

test('FIXED SEC11-3: an endpoint swapped under a valid delegation fails the content signature: a warning by default, MANIFEST_INVALID with requireContentSig', async () => {
  // Whoever can write the site changes endpoints (or ai.baseUrl) and keeps the holder's delegation and contentSig.
  // 能写站点的人改了端点（或 ai.baseUrl），保留持有人的委托与内容签名。
  const signed = contentSigned(manifestFor())
  const swapped = { ...signed, endpoints: { live: ['https://attacker.example/tapeapi/v1'], async: false } }
  const chain = fakeService({ manifest: swapped })
  const seen = []
  const svc = await testClient(chain.fetch, { onWarning: (w) => seen.push(w.code) }).resolve(NAME)
  assert.deepEqual(svc.contentSig, { valid: false })
  assert.deepEqual(seen, ['CONTENT_SIG_INVALID'])
  await assert.rejects(testClient(chain.fetch, { requireContentSig: true }).resolve(NAME), (e) => e.code === 'MANIFEST_INVALID' && /contentSig is signed by/.test(e.message))
  // stripping the field is caught only by requireContentSig / 删掉字段只有 requireContentSig 能发现
  const { contentSig, ...stripped } = swapped
  const c2 = fakeService({ manifest: stripped })
  await assert.rejects(testClient(c2.fetch, { requireContentSig: true }).resolve(NAME), (e) => e.code === 'MANIFEST_INVALID' && /no contentSig/.test(e.message))
  // signed by someone else (the hot signer, not the holder) / 由别人（热签名者而非持有人）签署
  const bySigner = fakeService({ manifest: contentSigned(manifestFor(), SIGNER_KEY) })
  await assert.rejects(testClient(bySigner.fetch, { requireContentSig: true }).resolve(NAME), (e) => e.code === 'MANIFEST_INVALID')
  // a garbled field / 乱码字段
  const garbled = fakeService({ manifest: { ...manifestFor(), contentSig: 'yes' } })
  await assert.rejects(testClient(garbled.fetch, { requireContentSig: true }).resolve(NAME), (e) => e.code === 'MANIFEST_INVALID' && /65 to 1024 bytes/.test(e.message))
  assert.throws(() => createTapeAPI({ requireContentSig: 'yes' }), invalid(/requireContentSig/))
})

test('FIXED SEC11-3: a contract holder signs the content under EIP-1271, and every check is made at the pinned block', async () => {
  const safe = '0x' + '5a'.repeat(20)
  const m0 = manifestFor()
  const expires = m0.delegation.expires
  const m = { ...m0, delegation: { expires, sig: '0x' + 'ab'.repeat(70) } }
  const contentDigest = sig.manifestContentDigest(56, ADDR.hub, { container: ADDR.container, contentHash: sig.manifestContentHash(m) })
  const published = { ...m, contentSig: '0x' + 'cd'.repeat(70) }
  const chain = createFakeChain()
  chain.setOwner(4246, safe); chain.setAccount(4246, ADDR.container)
  chain.setContractHolder(safe, sig.delegationDigest(56, ADDR.hub, { container: ADDR.container, signer, expires }), contentDigest)
  chain.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify(published))
  const svc = await testClient(chain.fetch, { requireContentSig: true, pin: true }).resolve(NAME)
  assert.deepEqual(svc.contentSig, { valid: true })
  const at = { blockHash: chain.blockHash(chain.state.block - 2), requireCanonical: true }
  const getCode = chain.state.reads.filter((r) => r.method === 'eth_getCode')
  assert.ok(getCode.length > 0)
  for (const r of chain.state.reads) assert.deepEqual(r.block, at)
})

test('FIXED SEC11-3: spec/vectors/tap-20-content.json matches the SDK (verify.py checks it independently)', () => {
  const v = JSON.parse(readFileSync(new URL('../../spec/vectors/tap-20-content.json', import.meta.url), 'utf8'))
  assert.equal(v.typeHash, sig.MANIFEST_CONTENT_TYPE)
  assert.equal(v.field, 'contentSig')
  for (const c of v.cases) {
    assert.equal(sig.recoverAddress(c.digest, c.sig), v.holderAddress)
    assert.equal('0x' + Buffer.from(sig.manifestContentHash(c.manifest)).toString('hex'), c.contentHash)
    assert.equal('0x' + Buffer.from(sig.manifestContentHash(c.published)).toString('hex'), c.contentHash, 'contentSig is outside the hash')
    assert.equal('0x' + Buffer.from(sig.manifestContentDigest(v.domain.chainId, v.domain.verifyingContract, { container: c.manifest.container, contentHash: c.contentHash })).toString('hex'), c.digest)
  }
  assert.notEqual(v.moved.recoversTo, v.holderAddress)
  // the typed data a wallet signs gives the same digest / 钱包签的类型化数据得出同一摘要
  const td = sig.manifestContentTypedData(56, v.domain.verifyingContract, { container: v.cases[0].manifest.container, manifest: v.cases[0].manifest })
  assert.equal(td.message.contentHash, v.cases[0].contentHash)
  assert.equal(td.primaryType, 'ManifestContent')
})

// ---------------------------------------------------------------- SEC11-4 contradiction evidence ----
const AV = JSON.parse(readFileSync(new URL('../../spec/vectors/tap-23-attested.json', import.meta.url), 'utf8'))
const attestedManifest = (p) => ({
  tapeapi: '0.1', name: `TAP-23 vector provider ${p.tag}`, circuits: '0x0000000000000000000000000000000000000c1c', tokenId: p.tag === 'A' ? '1' : '2',
  container: p.container, signer: p.signerAddress, endpoints: { live: [p.endpoint], async: false }, methods: [AV.descriptor], payment: { escrow: null, unit: 'BEM', decimals: 8 },
})
async function quorumError(c) {
  const fetch = async (url) => {
    const side = url.startsWith(AV.providers[0].endpoint) ? c.a : c.b
    return new Response(JSON.stringify(side.envelope), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const api = createTapeAPI({ chainId: 56, dev: true, maxSkewS: 1e12, fetch })
  const services = [await api.resolve({ dev: attestedManifest(AV.providers[0]) }), await api.resolve({ dev: attestedManifest(AV.providers[1]) })]
  try { await api.callQuorum(services, AV.request.method, AV.request.params, { id: AV.request.id }) } catch (e) { return e }
  assert.fail('expected a disagreement')
}

test('FIXED SEC11-4: ATTEST_DISAGREE carries both signed envelopes and the request; they make a ContradictionRecord anyone can check', async () => {
  const c = AV.cases.find((x) => x.expect === 'ATTEST_DISAGREE' && x.a.envelope.result.blockHash === x.b.envelope.result.blockHash && x.a.envelope.result.result !== x.b.envelope.result.result)
  assert.ok(c, 'the vectors hold a same-block, different-result case')
  const e = await quorumError(c)
  assert.equal(e.code, 'ATTEST_DISAGREE')
  assert.deepEqual(e.data.request, { method: AV.request.method, params: AV.request.params })
  assert.equal(e.data.envelopes.length, 2)
  assert.deepEqual(e.data.envelopes.map((x) => x.group).sort(), [0, 1])
  for (const x of e.data.envelopes) assert.equal(x.ok, true)
  // the 1.0 fields are unchanged / 1.0 的字段不变
  assert.deepEqual(e.agreed, [])
  assert.equal(e.groups.length, 2)
  const [rec] = security.contradictionsOf(e)
  assert.equal(rec.tapeapiContradiction, 1)
  assert.equal(rec.requestHash, sig.responseRequestHash(AV.request))
  assert.deepEqual(rec.block, { chainId: 1, blockNumber: AV.request.params.block, blockHash: c.a.envelope.result.blockHash.toLowerCase() })
  // without signerOf the signatures are consistent but bind no one yet (FIXED SECR-2) / 没有 signerOf：签名自洽，但尚未约束任何人
  const check = await security.verifyContradiction(JSON.parse(JSON.stringify(rec)))
  assert.deepEqual({ ...check, reason: undefined }, { valid: false, reason: undefined, signaturesConsistent: true, signersChecked: false, kind: 'cross', weak: false, block: rec.block })
  // with the signers confirmed / 确认签名者
  const signerOf = (container) => AV.providers.find((p) => p.container.toLowerCase() === container.toLowerCase()).signerAddress
  assert.deepEqual(await security.verifyContradiction(rec, { signerOf }), { valid: true, kind: 'cross', weak: false, block: rec.block, signaturesConsistent: true, signersChecked: true })
  assert.equal((await security.verifyContradiction(rec, { signerOf: () => holder })).valid, false)
})

test('FIXED SEC11-4: a record whose envelopes were altered, whose blocks differ or whose results agree is not a contradiction', async () => {
  const c = AV.cases.find((x) => x.expect === 'ATTEST_DISAGREE' && x.a.envelope.result.blockHash === x.b.envelope.result.blockHash && x.a.envelope.result.result !== x.b.envelope.result.result)
  const [rec] = security.contradictionsOf(await quorumError(c))
  const copy = () => JSON.parse(JSON.stringify(rec))
  const r1 = copy(); r1.envelopes[1].result.result = r1.envelopes[0].result.result
  assert.equal((await security.verifyContradiction(r1)).valid, false, 'altered result: the signature no longer recovers')
  const r2 = copy(); r2.request.params = { ...r2.request.params, block: 1 }
  assert.equal((await security.verifyContradiction(r2)).valid, false, 'another request')
  const r3 = copy(); r3.envelopes[0].signer = r3.envelopes[1].signer
  assert.equal((await security.verifyContradiction(r3)).valid, false, 'wrong signer')
  assert.equal((await security.verifyContradiction({ ...copy(), envelopes: [rec.envelopes[0]] })).valid, false)
  assert.equal((await security.verifyContradiction(null)).valid, false)
  // different blocks: the vectors' blockHash counterexample yields no record / 不同区块：不产生记录
  const diffBlock = AV.cases.find((x) => x.expect === 'ATTEST_DISAGREE' && x.a.envelope.result.blockHash !== x.b.envelope.result.blockHash)
  if (diffBlock) assert.deepEqual(security.contradictionsOf(await quorumError(diffBlock)), [])
  assert.throws(() => security.contradictionRecord({ method: 'read', params: {}, a: rec.envelopes[0], b: rec.envelopes[0] }), invalid(/same thing/))
})

test('FIXED SEC11-4: one signer contradicting itself at one block is kind "self"; a blockPinned result is supported; blockRef "number" is weak', async () => {
  const container = '0x' + 'c0'.repeat(20)
  const method = 'bnbUsd', params = { pair: 'BNB/USD' }
  const env = (result, id, ts) => ({ container, signer, id, ts, result, sig: sig.signResponse({ container, id, method, params, ok: true, body: result, ts }, SIGNER_KEY) })
  const pin = { blockNumber: 100, blockHash: '0x' + 'aa'.repeat(32) }
  const a = env({ price: '600.1', blockPinned: pin }, 'r1', 1790000000)
  const b = env({ price: '999.9', blockPinned: pin }, 'r2', 1790000005)
  const rec = security.contradictionRecord({ method, params, a, b })
  const signerOf = () => signer
  assert.deepEqual(await security.verifyContradiction(rec, { signerOf }), { valid: true, kind: 'self', weak: false, block: { blockNumber: 100, blockHash: pin.blockHash }, signaturesConsistent: true, signersChecked: true })
  const w = env({ price: '999.9', blockPinned: { ...pin, blockRef: 'number' } }, 'r3', 1790000006)
  assert.equal((await security.verifyContradiction(security.contradictionRecord({ method, params, a, b: w }), { signerOf })).weak, true)
  // no block inside the signed result: no record / 签名结果里没有区块：不构成记录
  assert.throws(() => security.contradictionRecord({ method, params, a: env({ price: '1' }, 'x', 1), b: env({ price: '2' }, 'y', 1) }), invalid(/name their block/))
})

// ---------------------------------------------------------------- SEC11-5 second opinion ----
function signingProviders(answers) {
  // Two services with different containers, holders, signers and origins; each answers `answers[tag]`.
  // 两个容器、持有人、签名者、来源都不同的服务。
  const P = [
    { tag: 'A', key: '0x' + '44'.repeat(32), holderKey: '0x' + '61'.repeat(32), container: '0x' + 'a1'.repeat(20), url: 'https://a.example/v1' },
    { tag: 'B', key: '0x' + '55'.repeat(32), holderKey: '0x' + '62'.repeat(32), container: '0x' + 'b2'.repeat(20), url: 'https://b.example/v1' },
    { tag: 'C', key: '0x' + '66'.repeat(32), holderKey: '0x' + '61'.repeat(32), container: '0x' + 'c3'.repeat(20), url: 'https://c.example/v1' },   // A's holder
  ]
  const calls = []
  const fetch = async (url, init) => {
    const p = P.find((x) => url.startsWith(x.url))
    const body = JSON.parse(init.body)
    calls.push(p.tag)
    const ts = nowS(), result = answers[p.tag]
    return new Response(JSON.stringify({ id: body.id, ok: true, result, ts, container: p.container, sig: sig.signResponse({ container: p.container, id: body.id, method: body.method, params: body.params, ok: true, body: result, ts }, p.key) }), { headers: { 'content-type': 'application/json' } })
  }
  const manifest = (p, price = '0') => {
    const s = sig.privateKeyToAddress(p.key), expires = nowS() + 86400
    return { tapeapi: '0.1', circuits: '0x' + '0c'.repeat(20), tokenId: '1', container: p.container, signer: s,
      delegation: { expires, sig: sig.signDigest(sig.delegationDigest(56, MAINNET.hub, { container: p.container, signer: s, expires }), p.holderKey) },
      endpoints: { live: [p.url], async: false }, methods: [{ name: 'price', priceBEM: price, params: {}, returns: {} }], ...(price !== '0' ? { payment: { escrow: '0x' + '40'.repeat(20) } } : {}) }
  }
  return { P, calls, fetch, manifest }
}

test('FIXED SEC11-5: rate 0 (the default) never asks twice; rate p asks one independent provider and compares bytes', async () => {
  const pin = { blockNumber: 7, blockHash: '0x' + '77'.repeat(32) }
  const t = signingProviders({ A: { v: 1, blockPinned: pin }, B: { v: 2, blockPinned: pin }, C: { v: 1, blockPinned: pin } })
  const api = createTapeAPI({ dev: true, fetch: t.fetch })
  const [a, b, c] = await Promise.all(t.P.map((p) => api.resolve({ dev: t.manifest(p) })))
  const off = security.withSpotCheck(api, { alternates: [b, c] })
  for (let i = 0; i < 5; i++) await off.call(a, 'price')
  assert.deepEqual(t.calls, ['A', 'A', 'A', 'A', 'A'])
  t.calls.length = 0
  const mismatches = []
  const on = security.withSpotCheck(api, { rate: 0.25, random: () => 0.1, alternates: [b, c], onMismatch: (o) => mismatches.push(o), wait: true })
  const r = await on.call(a, 'price')
  assert.deepEqual(r.result, { v: 1, blockPinned: pin }, 'the caller\'s answer is never changed')
  // C shares A's holder (TAP-23 §3.5), so only B is independent / C 与 A 同一持有人，只有 B 独立
  assert.deepEqual(t.calls, ['A', 'B'])
  assert.equal(r.spotCheck.same, false)
  assert.equal(r.spotCheck.checked, b.container)
  assert.equal(mismatches.length, 1)
  assert.equal((await security.verifyContradiction(mismatches[0].record)).kind, 'cross')
  // random above the rate: no second call / 随机数高于概率：不问第二家
  t.calls.length = 0
  await security.withSpotCheck(api, { rate: 0.25, random: () => 0.5, alternates: [b] }).call(a, 'price')
  assert.deepEqual(t.calls, ['A'])
})

test('FIXED SEC11-5: no independent free alternate is an onError report, never a failed call; a priced alternate is skipped unless allowPaid', async () => {
  const t = signingProviders({ A: { v: 1 }, B: { v: 1 }, C: { v: 1 } })
  const api = createTapeAPI({ dev: true, fetch: t.fetch })
  const a = await api.resolve({ dev: t.manifest(t.P[0]) })
  const c = await api.resolve({ dev: t.manifest(t.P[2]) })
  const pricedB = await api.resolve({ dev: t.manifest(t.P[1], '0.001') })
  const errors = []
  const r = await security.withSpotCheck(api, { rate: 1, random: () => 0, alternates: [c, pricedB], onError: (e) => errors.push(e), wait: true }).call(a, 'price')
  assert.deepEqual(r.result, { v: 1 })
  assert.equal(r.spotCheck.error.code, 'QUORUM_FAILED')
  assert.equal(errors.length, 1)
  // background mode reports the same way and returns at once / 后台模式同样报告，并立即返回
  const bg = []
  await security.withSpotCheck(api, { rate: 1, random: () => 0, alternates: [c], onError: (e) => bg.push(e) }).call(a, 'price')
  await new Promise((res) => setTimeout(res, 10))
  assert.equal(bg.length, 1)
  assert.throws(() => security.withSpotCheck(api, { rate: 2 }), invalid(/rate/))
  assert.throws(() => security.withSpotCheck({}, {}), invalid())
})

// ---------------------------------------------------------------- SEC11-6 delegation floor ----
test('CONFIRMED SEC11-6: without delegationFloor a manifest put back with an older delegation is accepted (1.0 behaviour); FIXED with it', async () => {
  const t = nowS()
  const newer = manifestFor({ expires: t + 60 * 86400 })
  const older = manifestFor({ expires: t + 30 * 86400 })
  const chain = fakeService({ manifest: newer })
  const plain = testClient(chain.fetch)
  const floored = testClient(chain.fetch, { delegationFloor: true })
  await plain.resolve(NAME); await floored.resolve(NAME)
  chain.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify(older))
  assert.equal((await plain.resolve(NAME)).manifest.delegation.expires, t + 30 * 86400, '1.0: accepted')
  await assert.rejects(floored.resolve(NAME), (e) => e.code === 'DELEGATION_INVALID' && e.data.floor === t + 60 * 86400)
  // A new holder starts a new floor: a circuit that changed hands is not locked out by its old holder's delegations.
  // 新持有人从新的下限开始：转手的电路不会被旧持有人的委托锁死。
  const NEW_HOLDER = '0x' + '77'.repeat(32)
  chain.setOwner(4246, sig.privateKeyToAddress(NEW_HOLDER))
  chain.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify(manifestFor({ expires: t + 10 * 86400, holderKey: NEW_HOLDER })))
  assert.equal((await floored.resolve(NAME)).verified.holder, sig.privateKeyToAddress(NEW_HOLDER))
})

test('FIXED SEC11-6: the floor lives in an injectable { get, set } store, shared by every chain\'s client, and only moves after a resolve passed', async () => {
  const t = nowS()
  const store = new Map()
  const chain = fakeService({ manifest: manifestFor({ expires: t + 50 * 86400 }) })
  await testClient(chain.fetch, { delegationFloor: store }).resolve(NAME)
  assert.deepEqual([...store.entries()], [[`56:${ADDR.container}:${holder.toLowerCase()}:${signer.toLowerCase()}`, t + 50 * 86400]])
  // a restarted client with the same store refuses the older manifest / 用同一存储重启的客户端拒绝更旧的清单
  chain.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify(manifestFor({ expires: t + 20 * 86400 })))
  await assert.rejects(testClient(chain.fetch, { delegationFloor: store }).resolve(NAME), (e) => e.code === 'DELEGATION_INVALID')
  // a resolve that fails for another reason does not move the floor / 因其它原因失败的解析不抬高下限
  const bad = manifestFor({ expires: t + 90 * 86400, holderKey: OTHER_KEY })
  chain.writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify(bad))
  await assert.rejects(testClient(chain.fetch, { delegationFloor: store }).resolve(NAME), (e) => e.code === 'DELEGATION_INVALID' && /signed by/.test(e.message))
  assert.equal(store.get(`56:${ADDR.container}:${holder.toLowerCase()}:${signer.toLowerCase()}`), t + 50 * 86400)
  assert.throws(() => createTapeAPI({ delegationFloor: 'yes' }), invalid(/delegationFloor/))
  const api = createTapeAPI({ rpcUrls: RPC, fetch: chain.fetch, delegationFloor: store })
  assert.equal(typeof api.forChain(196).resolve, 'function')
})

test('security namespace: IMPL_SLOT is the ERC-1967 slot, and the local derivation matches every chain the SDK knows', () => {
  assert.equal(IMPL_SLOT, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc')
  const facts = JSON.parse(readFileSync(new URL('./fixtures/chains-onchain.json', import.meta.url), 'utf8'))
  for (const [id, f] of Object.entries(facts.chains)) {
    const c = CHAINS[id]
    // processor 0, #1, recorded on chain 2026-09-28 / 链上记录的 0 号处理器 #1
    assert.equal(security.erc6551Account({ registry: c.erc6551Registry, implementation: c.accountImplementation, chainId: Number(id), tokenContract: f.processor0, tokenId: 1 }).toLowerCase(), f.hubAccountOf, id)
  }
  // TAP-20 §6.1: 11.1013.tape / TAP-20 §6.1 的主网向量
  assert.equal(security.erc6551Account({ registry: C56.erc6551Registry, implementation: C56.accountImplementation, chainId: 56, tokenContract: '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414', tokenId: 11 }), '0x1b2A657BcBa9D3229f57aC2f4FcbEE2AA756aAe8')
  assert.throws(() => security.erc6551Account({ registry: 'x' }), invalid(/registry/))
})
