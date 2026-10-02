// The TAP-10 conformance mode, 1.5: the messaging path (rows 17, 18, 21 of the Opus draft's table, docs/DESIGN-tap10-conform.md).
// api.chain.tapeSendKey resolves the endpoint as TAP-10 §12.2 and reads the key as §14.4 steps 1-3 (fresh pinned block,
// strict agreement, eth_chainId, the hub accepted, circuits not changed, the key checks); api.chain.channelKeys reads the
// channel record as the private-channels draft §3.3 (TAPI-26 §3.1 under TAP-10's read rules); neither judges activation
// or opening (§12.2). tapesend.js refuses chainIds above 2^53 - 1 under conform: 'tap10' (§12.1). Offline: every RPC goes
// to the conform chain (helpers/conform-chain.mjs). GOLDEN TAP10-0 (default-mode-trace.test.mjs) pins that the default mode
// is unchanged.
// TAP-10 一致模式 1.5：消息路径。tapeSendKey 按 §12.2 解析端点、按 §14.4 第 1–3 步读密钥；channelKeys 按私密通道草稿 §3.3 读记录；
// 两者都不判激活与开通。tapesend.js 在 conform: 'tap10' 下拒绝大于 2^53 − 1 的 chainId。全部离线；默认模式不变由黄金测试钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createTapeAPI, MANIFEST_KEY, CHANNEL_KEYS_KEY, MAINNET, CHAINS, TAP10_SEALS, TAP10_MAX_CHAIN_ID, TapeAPIError, sig, channel, canonicalJSON, tapesend } from '../src/index.js'
import { createConformChain, ADDR, HUB_OWNER } from './helpers/conform-chain.mjs'
import { utf8ToBytes } from '../src/abi.js'

const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32), OTHER_KEY = '0x' + '33'.repeat(32)
const holder = sig.privateKeyToAddress(HOLDER_KEY), signer = sig.privateKeyToAddress(SIGNER_KEY)
const RPC = ['http://rpc1', 'http://rpc2', 'http://rpc3']
const T = 1_790_000_000
const EXPIRES = T + 30 * 86_400
const hex = (b) => '0x' + Buffer.from(b).toString('hex')
const KEY = hex(channel.generateKeyPair().publicKey)

// A circuit with a manifest, a channel record and a usable TapeSend key / 带清单、通道记录与可用 TapeSend 密钥的电路
function world({ chainId = 56, tokenId = 4246, record = true, key = KEY } = {}) {
  const chain = createConformChain({ chainId })
  chain.state.headTime = T
  const c = chain.circuit(tokenId, { holder })
  chain.writeFile(c.container, MANIFEST_KEY, JSON.stringify({
    tapeapi: '0.1', name: 'Conform', circuits: c.circuits, tokenId: c.tokenId, container: c.container, signer,
    delegation: { expires: EXPIRES, sig: sig.signDigest(sig.delegationDigest(chainId, MAINNET.hub, { container: c.container, signer, expires: EXPIRES }), HOLDER_KEY) },
    endpoints: { live: ['https://api.example.com/tapeapi/v1'], async: false }, methods: [{ name: 'ping', priceBEM: '0', params: {}, returns: {} }],
  }))
  const id = channel.generateIdentity()
  const keys = { container: c.container, x25519: hex(id.x25519.publicKey), ed25519: hex(id.ed25519.publicKey), inbox: {}, issued: T - 60, expires: T + 86_400 }
  const recordText = canonicalJSON({ tapechannel: '1', chainId, ...keys, sig: sig.signDigest(sig.channelKeysDigest(chainId, MAINNET.hub, keys), HOLDER_KEY) })
  if (record) chain.writeFile(c.container, CHANNEL_KEYS_KEY, recordText)
  if (key) chain.setTapeSendKey(c.container, { circuits: c.circuits, tokenId, key, holder })
  // the hub's own derivation, for the default-mode controls below / 默认模式对照用的 hub 推导
  chain.setAccount(tokenId, c.container)
  return { chain, c, keys, recordText }
}
const conformApi = (chain, o = {}) => createTapeAPI({ conform: 'tap10', rpcUrls: RPC, fetch: chain.fetch, clock: () => T, quiet: true, onWarning: () => {}, ...o })
const defaultApi = (chain, o = {}) => createTapeAPI({ rpcUrls: RPC, fetch: chain.fetch, clock: () => T, quiet: true, onWarning: () => {}, ...o })
const isStatus = (code, status, re) => (e) => {
  assert.ok(e instanceof TapeAPIError, String(e)); assert.equal(e.code, code, e.message); assert.equal(e.data?.status, status, e.message)
  if (re) assert.match(e.message, re)
  return true
}
const since = (chain, from) => chain.conform.log.slice(from)

// ── chains.js: the §13.8 constants, read back on chain / chains.js 的 §13.8 常量，链上核对 ─────────────────────────────
test('TAP10_SEALS equals what the chains answered on 2026-10-02 (fixtures/tap10-seal-onchain.json) and TAP-10\'s Deployments', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/tap10-seal-onchain.json', import.meta.url), 'utf8'))
  const lc = (a) => String(a).toLowerCase()
  assert.deepEqual(Object.keys(TAP10_SEALS).map(Number).sort((a, b) => a - b), [56, 196, 8453])
  for (const id of [56, 196, 8453]) {
    const s = TAP10_SEALS[id], r = fx.chains[id], c = CHAINS[id]
    assert.equal(r.chainIdAnswer, id)
    assert.equal(lc(s.circuitBeacon), r.beacon, `${id} beacon`)
    assert.equal(lc(s.circuitImplementation), r.circuitImplementation)
    assert.equal(lc(s.circuitImplementation), r.beaconImplementation, `${id}: the beacon runs circuitImplementation`)
    assert.equal(s.circuitCodehash, r.circuitCodehash)
    assert.equal(r.processor0Codehash, r.circuitCodehash, `${id}: processor 0 has the processor proxy code hash`)
    assert.equal(lc(s.hub), r.hubImpl, `${id} hub implementation`)
    assert.equal(lc(s.factory), r.factoryImpl)
    assert.equal(r.beaconOwner, lc(c.factory), `${id}: the factory owns the beacon`)
    assert.equal(r.hubFactory, lc(c.factory)); assert.equal(r.hubOwner, lc(HUB_OWNER))
    assert.equal(r.factoryIsSealed, '0'); assert.equal(r.hubIsSealed, '0')
    // the same values as the sentinel's lists (which may grow rollback entries; TAP10_SEALS.hub is the current one only)
    assert.equal(lc(s.hub), c.expectedImpl[lc(c.hub)][0]); assert.equal(lc(s.factory), c.expectedImpl[lc(c.factory)][0])
    assert.ok(Object.isFrozen(s))
  }
  assert.equal(TAP10_MAX_CHAIN_ID, 2n ** 53n - 1n)
})

// ── tapeSendKey ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('tapeSendKey (TAP-10 §12.2, §14.4): one fresh pinned block, every read strict, the container from the opener, the hub state at the same block', async () => {
  const { chain, c } = world()
  const api = conformApi(chain)
  for (const target of [c.container, { circuits: c.circuits, tokenId: 4246 }]) {
    const from = chain.conform.log.length
    const k = await api.chain.tapeSendKey(target)
    assert.equal(k.staticPublic, KEY); assert.equal(k.container, c.container); assert.equal(k.tokenId, '4246')
    assert.equal(k.holder, holder); assert.equal(k.opened, true); assert.equal(k.chainsBitmap, '111'); assert.equal(k.version, 1)
    assert.equal(k.tap10.version, '1.1'); assert.equal(k.tap10.status, 'ok'); assert.equal(k.tap10.circuits, 'ok')
    assert.deepEqual(k.tap10.hub, { implementation: TAP10_SEALS[56].hub.toLowerCase(), accepted: true })
    assert.deepEqual(k.tap10.seal, { factory: false, hub: false })   // nothing is sealed (TAP-10 Deployments)
    assert.equal(k.tap10.endpoint, '0x' + '00'.repeat(4) + (56).toString(16).padStart(16, '0') + c.container.slice(2).toLowerCase())
    assert.equal(k.tap10.pinned.maxLag, 400)
    const log = since(chain, from)
    // every state read at the one pinned block, by its hash / 每个状态读取都在同一钉块
    const reads = log.filter((x) => x.block !== null)
    for (const r of reads) assert.deepEqual(r.block, { blockHash: k.tap10.pinned.hash, requireCanonical: true }, `${r.method} ${r.fn}`)
    // strict: every read went to every node / 严格共识：每个读取都发给每个节点
    for (const fn of ['keyFor', 'isCPU', 'accountOf', 'ownerOf', 'isOpened', 'implementation', 'isSealed', 'owner']) {
      assert.deepEqual([...new Set(log.filter((x) => x.fn === fn).map((x) => x.url))].sort(), RPC, fn)
    }
    // the container from the opener, never the hub's accountOf / 容器取自开通器
    assert.ok(log.filter((x) => x.fn === 'accountOf').every((x) => x.to === CHAINS[56].opener.toLowerCase()))
    // §12.2: neither the site store nor the payment contract is read / 不读站点存储与付费合约
    for (const a of [CHAINS[56].siteRegistry, CHAINS[56].binding]) assert.ok(!log.some((x) => x.to === a.toLowerCase()), a)
    assert.ok(!log.some((x) => ['isLive', 'isContainerLive', 'fileInfo'].includes(x.fn)))
  }
  // the default mode on the same chain: hub.accountOf, no strict, no hub state / 同一链上的默认模式
  const from = chain.conform.log.length
  const d = await defaultApi(chain).chain.tapeSendKey(c.container)
  assert.equal(d.staticPublic, KEY); assert.equal(d.tap10, undefined)
  assert.ok(!since(chain, from).some((x) => x.fn === 'isSealed' || x.method === 'eth_chainId'))
})

test('strict agreement and the strict chain check: one node down or one node on another chain stops the messaging path, not the default mode', async () => {
  const { chain, c } = world()
  chain.setFault('http://rpc3', 'http500')
  assert.equal((await defaultApi(chain).chain.tapeSendKey(c.container)).staticPublic, KEY)
  await assert.rejects(conformApi(chain).chain.tapeSendKey(c.container), isStatus('RPC_UNAVAILABLE', 'unavailable', /only 2\/3/))
  await assert.rejects(conformApi(chain).chain.channelKeys(c.container), isStatus('RPC_UNAVAILABLE', 'unavailable'))
  // resolve reads the holder strictly too (TAP-11 §2.2, in 1.5.0: conform-strict-holder.test.mjs); siteStatus keeps
  // default agreement / resolve 也严格读取持有人；siteStatus 仍用默认共识
  await assert.rejects(conformApi(chain).resolve('4246.7'), isStatus('RPC_UNAVAILABLE', 'unavailable', /only 2\/3/))
  assert.equal((await conformApi(chain).siteStatus('4246.7')).container, c.container)
  chain.setFault('http://rpc3', null)
  // §5.4: a node on another chain is a disagreement, every node on another chain is wrong-chain / 一个节点在别的链即分歧，全部即 wrong-chain
  chain.setChainIdAnswer('http://rpc2', 97)
  await assert.rejects(conformApi(chain).chain.tapeSendKey(c.container), isStatus('RPC_DISAGREE', 'unavailable'))
  for (const u of RPC) chain.setChainIdAnswer(u, 97)
  await assert.rejects(conformApi(chain).chain.tapeSendKey(c.container), isStatus('INVALID_ARGUMENT', 'wrong-chain', /eth_chainId 97, not 56/))
  for (const u of RPC) chain.setChainIdAnswer(u, null)
  // siteStatus's default-agreement check does not count for messaging: the strict one is sent again, once per client;
  // resolve's check is that strict one since 1.5.0 (Fable review, finding 3) and is shared
  // siteStatus 的默认共识检查不算：严格检查另发一次，每个客户端一次；1.5.0 起 resolve 的检查就是这个严格检查，共用
  const api = conformApi(chain)
  await api.siteStatus('4246.7')
  let from = chain.conform.log.length
  await api.chain.tapeSendKey(c.container); await api.chain.tapeSendKey(c.container)
  assert.equal(since(chain, from).filter((x) => x.method === 'eth_chainId').length, RPC.length, 'one strict eth_chainId, to every node')
  const shared = conformApi(chain)
  await shared.resolve('4246.7')
  from = chain.conform.log.length
  await shared.chain.tapeSendKey(c.container)
  assert.equal(since(chain, from).filter((x) => x.method === 'eth_chainId').length, 0, "resolve's strict check counts for messaging")
})

test('TAP-10 §12.2: an unactivated, not-opened container on a changed site store still has its TapeSend key; the channel record (a site file) stops only at store-changed', async () => {
  const { chain, c, keys } = world()
  chain.setUnactivated()
  chain.setOpened(c.circuits, 4246, false)
  const api = conformApi(chain)
  await assert.rejects(api.resolve('4246.7.tape'), isStatus('SITE_STATUS', 'not-opened'))
  chain.setOpened(c.circuits, 4246, true)
  await assert.rejects(api.resolve('4246.7.tape'), isStatus('SITE_STATUS', 'unpaid'))
  assert.equal((await api.siteStatus('4246.7.tape')).status, 'unpaid')
  // the same unactivated container: its record and its key read as usual / 同一个未激活容器：记录与密钥照常可读
  assert.equal((await api.chain.channelKeys(c.container)).x25519, keys.x25519)
  assert.equal((await api.chain.tapeSendKey(c.container)).staticPublic, KEY)
  chain.setOpened(c.circuits, 4246, false)
  const k = await api.chain.tapeSendKey(c.container)
  assert.equal(k.opened, false, 'opened is reported, not required (only the sender must be opened; the hub enforces it)')
  assert.equal((await api.chain.channelKeys(c.container, { fresh: true })).holder, holder)
  // a changed DomainBinding: resolve and the record stop (store-changed), the key does not / 付费合约变更：解析与记录停止，密钥不停
  chain.setImplementation(CHAINS[56].binding, '0x' + 'cd'.repeat(20))
  await assert.rejects(api.resolve('4246.7.tape'), isStatus('CONTRACT_UNKNOWN', 'store-changed'))
  await assert.rejects(api.chain.channelKeys(c.container, { fresh: true }), isStatus('CONTRACT_UNKNOWN', 'store-changed', /binding .* the channel record, a site file, is not read/))
  assert.equal((await api.chain.tapeSendKey(c.container)).staticPublic, KEY)
  chain.setImplementation(CHAINS[56].binding, CHAINS[56].expectedImpl[CHAINS[56].binding.toLowerCase()][0])
  chain.setImplementation(CHAINS[56].siteRegistry, '0x' + 'ce'.repeat(20))
  await assert.rejects(api.chain.channelKeys(c.container, { fresh: true }), isStatus('CONTRACT_UNKNOWN', 'store-changed', /siteRegistry/))
  assert.equal((await api.chain.tapeSendKey(c.container)).staticPublic, KEY)
})

test('TAP-10 §13.8: a hub implementation other than the current one is hub-changed, whatever the sentinel says', async () => {
  const { chain, c } = world()
  for (const impl of ['0x7dF03218910E0F37FC3A8DA8792831ab7580340F', '0xC0D28CA8689248B0bed26cC0aa328CF16Aa4401e', '0x' + 'ee'.repeat(20)]) {   // v2 (replaced), the boot implementation, an unknown one
    chain.setImplementation(MAINNET.hub, impl)
    for (const sentinel of ['off', 'warn', 'strict']) {
      await assert.rejects(conformApi(chain, { sentinel }).chain.tapeSendKey(c.container), isStatus('CONTRACT_UNKNOWN', 'hub-changed', new RegExp(`implementation ${impl.toLowerCase()}`)), `${impl} ${sentinel}`)
    }
    // the channel record does not read the hub (the draft §3.3) / 通道记录不读中枢
    assert.equal((await conformApi(chain).chain.channelKeys(c.container)).holder, holder)
  }
  // a configured hub other than TAP-10's is refused up front / 配置了 TAP-10 之外的中枢：创建时就拒绝
  assert.throws(() => conformApi(chain, { hub: ADDR.hub }), (e) => e.code === 'INVALID_ARGUMENT' && /accepts only the DeWEB hub TAP-10 lists/.test(e.message))
  assert.doesNotThrow(() => conformApi(chain, { hub: MAINNET.hub.toLowerCase() }))
})

test('TAP-10 §13.8: circuits-changed is kept by the client even when the beacon reads back right; a new client, or another chain, starts clean', async () => {
  const { chain, c } = world()
  const api = conformApi(chain)
  assert.equal((await api.chain.tapeSendKey(c.container)).tap10.circuits, 'ok')
  chain.setSeal({ beaconImplementation: '0x' + '9a'.repeat(20) })
  await assert.rejects(api.chain.tapeSendKey(c.container), isStatus('CONTRACT_UNKNOWN', 'circuits-changed', /no longer runs/))
  chain.setSeal({ beaconImplementation: TAP10_SEALS[56].circuitImplementation })
  await assert.rejects(api.chain.tapeSendKey(c.container), isStatus('CONTRACT_UNKNOWN', 'circuits-changed'), 'sticky')
  assert.equal((await conformApi(chain).chain.tapeSendKey(c.container)).tap10.circuits, 'ok', 'a new client')
  // a revert and a non-canonical word are "not in effect" too / 回滚与非规范字同样算未生效
  for (const v of ['revert', '0x' + 'ff'.repeat(12) + TAP10_SEALS[56].circuitImplementation.slice(2).toLowerCase()]) {
    chain.setSeal({ beaconImplementation: v })
    await assert.rejects(conformApi(chain).chain.tapeSendKey(c.container), isStatus('CONTRACT_UNKNOWN', 'circuits-changed'), String(v))
  }
})

test('TAP-10 §13.8 seal status is read and reported, never required; a factory seal once seen and then lost stays lost', async () => {
  const { chain, c } = world()
  const api = conformApi(chain)
  chain.setSeal({ factorySealed: 1, hubSealed: 1, hubOwner: 0 })
  assert.deepEqual((await api.chain.tapeSendKey(c.container)).tap10.seal, { factory: true, hub: true })
  // the beacon owned by someone other than the factory: the factory seal is not in effect, and is now lost for this client
  // 信标的 owner 不是工厂：工厂封存不生效，本客户端从此视为已失去
  chain.setSeal({ beaconOwner: '0x' + '12'.repeat(20) })
  assert.deepEqual((await api.chain.tapeSendKey(c.container)).tap10.seal, { factory: false, hub: true, factoryLost: true })
  chain.setSeal({ beaconOwner: CHAINS[56].factory })
  assert.deepEqual((await api.chain.tapeSendKey(c.container)).tap10.seal, { factory: false, hub: true, factoryLost: true }, 'kept as lost')
  // isSealed must be exactly 1; a hub owner word with upper bits set is not 0 / isSealed 须恰为 1；高位非零的 owner 字不是 0
  const fresh = conformApi(chain)
  chain.setSeal({ factorySealed: 2, hubOwner: '0x' + '01' + '00'.repeat(31) })
  assert.deepEqual((await fresh.chain.tapeSendKey(c.container)).tap10.seal, { factory: false, hub: false })
  chain.setSeal({ factorySealed: 'revert', hubSealed: 'revert', hubOwner: 'revert' })
  assert.deepEqual((await fresh.chain.tapeSendKey(c.container)).tap10.seal, { factory: false, hub: false })
})

test('tapeSendKey outcomes: hub-mismatch, no-key, key-stale, bad-key (TAP-10 §12.2, §14.4 steps 2-3) and the identity outcomes', async () => {
  const { chain, c } = world()
  const api = conformApi(chain)
  // the hub answers for another container than the opener derives / hub 回答的容器与开通器推导的不同
  chain.setTapeSendKey('0x' + 'd1'.repeat(20), { circuits: c.circuits, tokenId: 4246, key: KEY, holder })
  chain.setContainerToken(c.container, { circuits: c.circuits, tokenId: 4246 })
  await assert.rejects(api.chain.tapeSendKey(c.container), isStatus('CHANNEL_INVALID', 'hub-mismatch'))
  await assert.rejects(api.chain.tapeSendKey({ circuits: c.circuits, tokenId: 4246 }), isStatus('CHANNEL_INVALID', 'hub-mismatch'))
  // usable false: never published (version 0) or revoked / changed hands / 从未发布，或已撤销、已易主
  chain.setTapeSendKey(c.container, { circuits: c.circuits, tokenId: 4246, key: KEY, holder, usable: false, version: 0 })
  await assert.rejects(api.chain.tapeSendKey(c.container), isStatus('NOT_FOUND', 'no-key'))
  chain.setTapeSendKey(c.container, { circuits: c.circuits, tokenId: 4246, key: KEY, holder, usable: false, version: 3 })
  await assert.rejects(api.chain.tapeSendKey(c.container), isStatus('NOT_FOUND', 'key-stale'))
  // §14.4 step 3, which the default mode leaves to the handshake: low order (u = 0, 1, p - 1), top bit, not canonical
  // 第 3 步（默认模式留给握手时才查）：低阶点、最高位、非规范
  const p = 2n ** 255n - 19n
  const le = (n) => '0x' + Buffer.from(Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn))).toString('hex')
  for (const bad of [le(0n), le(1n), le(p - 1n), le(p), '0x' + '00'.repeat(31) + '80']) {
    chain.setTapeSendKey(c.container, { circuits: c.circuits, tokenId: 4246, key: bad, holder })
    await assert.rejects(api.chain.tapeSendKey(c.container), isStatus('CHANNEL_INVALID', 'bad-key', /TAP-10 §14\.4 step 3/), bad)
    assert.equal((await defaultApi(chain).chain.tapeSendKey(c.container)).staticPublic, bad, 'the default mode is unchanged')
  }
  chain.setTapeSendKey(c.container, { circuits: c.circuits, tokenId: 4246, key: KEY, holder, suite: 2 })
  await assert.rejects(api.chain.tapeSendKey(c.container), isStatus('CHANNEL_INVALID', 'bad-key', /suite 2/))
  chain.setTapeSendKey(c.container, { circuits: c.circuits, tokenId: 4246, key: KEY, holder })
  // identity (TAP-10 §4.3): a contract that only claims to be the container, a container of this chain naming a
  // counterfeit processor, no such token / 身份：只是声称的合约、本链容器指向仿冒处理器、没有该 token
  const liar = '0x' + 'c2'.repeat(20)
  chain.setContainerToken(liar, { circuits: c.circuits, tokenId: 4246 })
  await assert.rejects(api.chain.tapeSendKey(liar), isStatus('CHANNEL_INVALID', 'not-tapeout', /§4\.3 step 4/))
  await assert.rejects(api.chain.tapeSendKey({ circuits: c.circuits, tokenId: 99 }), isStatus('NOT_FOUND', 'no-such-token'))
  chain.setCounterfeit(c.circuits)
  await assert.rejects(api.chain.tapeSendKey(c.container), isStatus('CHANNEL_INVALID', 'not-tapeout', /isCPU is false/))
  chain.setCounterfeit(c.circuits, false)
  for (const bad of ['nope', { circuits: c.circuits, tokenId: 0 }, { circuits: c.circuits, tokenId: 10n ** 18n + 1n }, null]) {
    await assert.rejects(api.chain.tapeSendKey(bad), isStatus('INVALID_ARGUMENT', 'input-error'), JSON.stringify(String(bad)))
  }
})

// ── channelKeys ───────────────────────────────────────────────────────────────────────────────────────────────────
test('channelKeys (the private-channels draft §3.3): strict at a fresh pinned block, the opener, both site-store implementations, no activation', async () => {
  const { chain, c, keys } = world()
  const api = conformApi(chain)
  const from = chain.conform.log.length
  const r = await api.chain.channelKeys(c.container)
  assert.equal(r.x25519, keys.x25519); assert.equal(r.holder, holder); assert.equal(r.keys, 'tape-channel/v1')
  assert.equal(r.tap10.status, 'ok'); assert.deepEqual(r.tap10.implementations.map((x) => [x.role, x.accepted]), [['siteRegistry', true], ['binding', true]])
  const log = since(chain, from)
  for (const x of log.filter((y) => y.block !== null)) assert.deepEqual(x.block, { blockHash: r.tap10.pinned.hash, requireCanonical: true }, `${x.method} ${x.fn}`)
  for (const fn of ['token', 'isCPU', 'accountOf', 'ownerOf', 'fileInfo', 'read']) assert.deepEqual([...new Set(log.filter((x) => x.fn === fn).map((x) => x.url))].sort(), RPC, fn)
  assert.ok(log.filter((x) => x.fn === 'accountOf').every((x) => x.to === CHAINS[56].opener.toLowerCase()))
  for (const fn of ['isLive', 'isContainerLive', 'isOpened', 'keyFor']) assert.ok(!log.some((x) => x.fn === fn), fn)
  // the record goes into the cache like the default mode's, a copy each time / 与默认模式一样进入缓存，每次给副本
  const again = await api.chain.channelKeys(c.container)
  assert.deepEqual(again, r); again.tap10.pinned.number = 0
  assert.notEqual((await api.chain.channelKeys(c.container)).tap10.pinned.number, 0)
})

test('channelKeys outcomes: not-found, no-hash, incomplete, a byte order mark (accepted by the default mode) and the record checks are CHANNEL_INVALID with a status, cached with it', async () => {
  const { chain, c, recordText } = world()
  const api = () => conformApi(chain, { identityCacheS: 0 })
  chain.writeFile(c.container, CHANNEL_KEYS_KEY, new Uint8Array([0xef, 0xbb, 0xbf, ...utf8ToBytes(recordText)]))
  assert.equal((await defaultApi(chain).chain.channelKeys(c.container)).holder, holder, 'the default mode strips the mark (unchanged)')
  await assert.rejects(api().chain.channelKeys(c.container), isStatus('CHANNEL_INVALID', 'record-invalid', /byte order mark/))
  chain.writeFile(c.container, CHANNEL_KEYS_KEY, new Uint8Array([...utf8ToBytes(recordText.slice(0, -1)), 0xff, 0x7d]))
  await assert.rejects(api().chain.channelKeys(c.container), isStatus('CHANNEL_INVALID', 'record-invalid'))
  chain.writeFile(c.container, CHANNEL_KEYS_KEY, recordText)
  chain.setFileInfo(c.container, CHANNEL_KEYS_KEY, { sha256Hash: '0x' + '00'.repeat(32) })
  await assert.rejects(api().chain.channelKeys(c.container), isStatus('CHANNEL_INVALID', 'no-hash'))
  chain.writeFile(c.container, CHANNEL_KEYS_KEY, recordText)
  chain.setFileBytes(c.container, CHANNEL_KEYS_KEY, recordText.replace('"1"', '"2"'))
  await assert.rejects(api().chain.channelKeys(c.container), isStatus('CHANNEL_INVALID', 'incomplete'))
  chain.setFileInfo(c.container, CHANNEL_KEYS_KEY, { size: 5000 })
  await assert.rejects(api().chain.channelKeys(c.container), isStatus('CHANNEL_INVALID', 'record-invalid', /1 to 4096/))
  // signed by someone else / 别人签的
  const other = JSON.parse(recordText)
  const { tapechannel: _t, chainId: _c, sig: _s, ...k } = other
  chain.writeFile(c.container, CHANNEL_KEYS_KEY, canonicalJSON({ ...other, sig: sig.signDigest(sig.channelKeysDigest(56, MAINNET.hub, k), OTHER_KEY) }))
  await assert.rejects(api().chain.channelKeys(c.container), isStatus('CHANNEL_INVALID', 'record-invalid', /not authorised by the current holder/))
  // no file; and a verdict served from the cache keeps its status / 没有文件；缓存给出的结论保留其状态
  const cached = conformApi(chain)
  chain.state.files.delete(`${c.container.toLowerCase()}:${CHANNEL_KEYS_KEY}`)
  await assert.rejects(cached.chain.channelKeys(c.container), isStatus('CHANNEL_INVALID', 'not-found', /chunkCount = 0/))
  const before = chain.conform.log.length
  await assert.rejects(cached.chain.channelKeys(c.container), isStatus('CHANNEL_INVALID', 'not-found'))
  assert.equal(chain.conform.log.length, before, 'served from the cache')
  // a node failure is never cached (the draft §3.3) / 节点故障绝不缓存
  const flaky = conformApi(chain)
  chain.writeFile(c.container, CHANNEL_KEYS_KEY, recordText)
  chain.setFault('http://rpc2', 'http500')
  await assert.rejects(flaky.chain.channelKeys(c.container), isStatus('RPC_UNAVAILABLE', 'unavailable'))
  chain.setFault('http://rpc2', null)
  assert.equal((await flaky.chain.channelKeys(c.container)).holder, holder)
})

test('groupVerifier (TAPI-27) goes through the same record read; store-changed throws (a member is never dropped for it)', async () => {
  const { chain, c, keys } = world()
  chain.setUnactivated()
  const verify = conformApi(chain).groupVerifier()
  const from = chain.conform.log.length
  assert.equal(await verify({ container: c.container, chainId: 56, x25519: keys.x25519, ed25519: keys.ed25519 }), true)
  assert.ok(since(chain, from).some((x) => x.method === 'eth_chainId'), 'the strict chain check ran')
  chain.setImplementation(CHAINS[56].siteRegistry, '0x' + 'ce'.repeat(20))
  await assert.rejects(verify({ container: c.container, chainId: 56, x25519: keys.x25519, ed25519: keys.ed25519 }, { fresh: true }), isStatus('CONTRACT_UNKNOWN', 'store-changed'))
})

// ── forChain ──────────────────────────────────────────────────────────────────────────────────────────────────────
test('forChain passes the messaging path on: a Base sub-client checks Base\'s hub and beacon; a sticky status on one chain does not touch another', async () => {
  const worlds = { 56: world(), 8453: world({ chainId: 8453 }), 196: world({ chainId: 196 }) }
  const fetch = (url, init) => worlds[Number(/^http:\/\/rpc(\d+)-/.exec(url)[1])].chain.fetch(url, init)
  const urls = (id) => [`http://rpc${id}-a`, `http://rpc${id}-b`]
  const api = createTapeAPI({ conform: 'tap10', rpcUrls: urls(56), fetch, clock: () => T, quiet: true, onWarning: () => {}, chains: { 196: { rpcUrls: urls(196) }, 8453: { rpcUrls: urls(8453) } } })
  for (const id of [8453, 196]) {
    const w = worlds[id]
    const k = await api.forChain(id).chain.tapeSendKey(w.c.container)
    assert.equal(k.chainId, id); assert.equal(k.staticPublic, KEY)
    assert.equal(k.tap10.hub.implementation, TAP10_SEALS[id].hub.toLowerCase())
    assert.equal(k.tap10.endpoint.slice(10, 26), BigInt(id).toString(16).padStart(16, '0'))
    const log = w.chain.conform.log
    assert.ok(log.some((x) => x.fn === 'implementation' && x.to === TAP10_SEALS[id].circuitBeacon.toLowerCase()), `${id}: the chain's own beacon`)
    assert.ok(log.filter((x) => x.fn === 'accountOf').every((x) => x.to === CHAINS[id].opener.toLowerCase()))
    assert.equal((await api.forChain(id).chain.channelKeys(w.c.container)).chainId, id)
  }
  worlds[8453].chain.setSeal({ beaconImplementation: '0x' + '9a'.repeat(20) })
  await assert.rejects(api.forChain(8453).chain.tapeSendKey(worlds[8453].c.container), isStatus('CONTRACT_UNKNOWN', 'circuits-changed'))
  assert.equal((await api.forChain(196).chain.tapeSendKey(worlds[196].c.container)).tap10.circuits, 'ok', 'X Layer is not affected')
  assert.equal((await api.chain.tapeSendKey(worlds[56].c.container)).tap10.circuits, 'ok', 'nor BNB Smart Chain')
  // and a default parent gives default sub-clients / 默认的父客户端给出默认的子客户端
  const plain = createTapeAPI({ rpcUrls: urls(56), fetch, quiet: true, chains: { 8453: { rpcUrls: urls(8453) } } })
  assert.equal((await plain.forChain(8453).chain.tapeSendKey(worlds[8453].c.container)).tap10, undefined)
})

// ── tapesend.js, TAP-10 §12.1 ─────────────────────────────────────────────────────────────────────────────────────
test("tapesend under conform: 'tap10' refuses a chainId above 2^53 - 1 everywhere (TAP-10 §12.1); without it the bound stays 2^64 - 1", () => {
  const A = '0x86DDaEF00401E3F10418398D67D7189fc458eA95', B = '0x19366c3c69ffeb3b286d9fa6cc5e616375baafd3', HUB = MAINNET.hub
  const max = 2n ** 53n - 1n, over = 2n ** 53n
  const badInput = (re) => (e) => e instanceof TapeAPIError && e.reason === 'bad-input' && (!re || re.test(e.message))
  const ep = (id, c) => '0x' + '00'.repeat(4) + id.toString(16).padStart(16, '0') + c.slice(2).toLowerCase()
  // endpoint() / 端点
  assert.equal(tapesend.endpoint(A, over).length, 32, 'default: up to 2^64 - 1, as in 1.4')
  assert.throws(() => tapesend.endpoint(A, over, { conform: 'tap10' }), badInput(/2\^53 - 1.*TAP-10 §12\.1/))
  assert.deepEqual(tapesend.endpoint(A, max, { conform: 'tap10' }), tapesend.endpoint(A, max))
  assert.throws(() => tapesend.endpoint(ep(over, A), 56, { conform: 'tap10' }), badInput(/TAP-10 §12\.1/), 'a 32-byte endpoint carries its chain')
  assert.equal(tapesend.endpoint(ep(over, A)).length, 32)
  assert.throws(() => tapesend.endpoint(A, 56, { conform: true }), badInput(/conform: pass 'tap10'/))
  // seal, open, messageId, sendTx / 封装、打开、消息 ID、发送交易
  const kb = channel.generateKeyPair()
  const content = utf8ToBytes('{"v":1,"kind":"message","body":"hi"}')
  const base = { content, recipients: [kb.publicKey], to: B, from: A, hub: HUB }
  const sealed = tapesend.seal({ ...base, chainId: 56, toChainId: 8453, conform: 'tap10' })
  assert.deepEqual(tapesend.open({ payload: sealed, secretKey: kb.secretKey, to: B, from: A, hub: HUB, chainId: 56, toChainId: 8453, conform: 'tap10' }).content, content)
  assert.deepEqual(tapesend.open({ payload: sealed, secretKey: kb.secretKey, to: B, from: A, hub: HUB, chainId: 56, toChainId: 8453 }).content, content, 'the same bytes with or without the option')
  assert.throws(() => tapesend.seal({ ...base, chainId: 56, toChainId: over, conform: 'tap10' }), badInput())
  assert.throws(() => tapesend.seal({ ...base, chainId: over, conform: 'tap10' }), badInput())
  assert.ok(tapesend.seal({ ...base, chainId: over }).length > 0, 'default unchanged')
  assert.throws(() => tapesend.open({ payload: sealed, secretKey: kb.secretKey, to: ep(over, B), from: A, hub: HUB, conform: 'tap10' }), badInput())
  assert.equal(tapesend.messageId({ chainId: 56, toChainId: 8453, hub: HUB, to: B, inboxIndex: 1, conform: 'tap10' }), tapesend.messageId({ chainId: 56, toChainId: 8453, hub: HUB, to: B, inboxIndex: 1 }))
  assert.throws(() => tapesend.messageId({ chainId: over, hub: HUB, to: B, inboxIndex: 1, conform: 'tap10' }), badInput())
  assert.throws(() => tapesend.messageId({ chainId: 56, toChainId: over, hub: HUB, to: B, inboxIndex: 1, conform: 'tap10' }), badInput())
  assert.throws(() => tapesend.messageId({ chainId: 'x', hub: HUB, to: B, inboxIndex: 1, conform: 'tap10' }), badInput(/whole number/))
  const tx = { hub: HUB, circuits: '0x50a994e71615474b55559ff4f500928fbc339dd9', tokenId: 1, to: B, payload: sealed }
  assert.deepEqual(tapesend.sendTx({ ...tx, toChainId: 8453, conform: 'tap10' }), tapesend.sendTx({ ...tx, toChainId: 8453 }))
  assert.throws(() => tapesend.sendTx({ ...tx, toChainId: over, conform: 'tap10' }), badInput())
  assert.throws(() => tapesend.sendTx({ ...tx, chainId: over, conform: 'tap10' }), badInput())
  assert.equal(tapesend.sendTx({ ...tx, toChainId: over }).to, HUB, 'default unchanged')
})

// ── review fixes (Fable, Sonnet on f63944f) / 审查修正 ───────────────────────────────────────────────────────────
test('FIXED review-msg-1: input that may belong to another chain is unsupported on the messaging path as in resolve (TAP-10 §4.1), never not-tapeout, never cached', async () => {
  const { chain, c } = world()
  const api = conformApi(chain)
  const dead = '0x000000000000000000000000000000000000dEaD'
  const elsewhere = '0x' + 'c4'.repeat(20)
  chain.setContainerToken(elsewhere, { circuits: c.circuits, tokenId: 4246, chainId: 8453 })
  for (const target of [dead, elsewhere]) {
    await assert.rejects(api.resolve(target), isStatus('INVALID_ARGUMENT', 'unsupported'))
    await assert.rejects(api.chain.tapeSendKey(target), isStatus('INVALID_ARGUMENT', 'unsupported'))
    for (let i = 0; i < 2; i++) {
      const from = chain.conform.log.length
      await assert.rejects(api.chain.channelKeys(target), isStatus('INVALID_ARGUMENT', 'unsupported'), `${target} call ${i}`)
      assert.ok(since(chain, from).some((x) => x.fn === 'token'), `${target} call ${i}: read again, not served from a cache`)
    }
  }
  // a processor contract#ID whose contract is no processor here, as resolve says / 处理器合约在本链不是处理器：与 resolve 相同
  chain.setCounterfeit(c.circuits)
  await assert.rejects(api.chain.tapeSendKey({ circuits: c.circuits, tokenId: 4246 }), isStatus('INVALID_ARGUMENT', 'unsupported'))
  await assert.rejects(api.resolve(`${c.circuits}#4246`), isStatus('INVALID_ARGUMENT', 'unsupported'))
  // once the address is a container here, it reads (nothing negative was kept) / 之后成了本链容器即可读（没有保留否定结论）
  chain.setCounterfeit(c.circuits, false)
  assert.equal((await api.chain.channelKeys(c.container)).holder, holder)
})

test('FIXED review-msg-2: channelKeys sends no eth_call to the site store when it is store-changed (TAP-10 §6.1 MUST NOT read the site), as resolve', async () => {
  for (const proxy of [CHAINS[56].siteRegistry, CHAINS[56].binding]) {
    const { chain, c } = world()
    chain.setImplementation(proxy, '0x' + 'cd'.repeat(20))
    const api = conformApi(chain)
    let from = chain.conform.log.length
    await assert.rejects(api.chain.channelKeys(c.container), isStatus('CONTRACT_UNKNOWN', 'store-changed'))
    const site = (log) => log.filter((x) => x.method === 'eth_call' && x.to === CHAINS[56].siteRegistry.toLowerCase())
    assert.equal(site(since(chain, from)).length, 0, proxy)
    from = chain.conform.log.length
    await assert.rejects(api.resolve('4246.7'), isStatus('CONTRACT_UNKNOWN', 'store-changed'))
    assert.equal(site(since(chain, from)).length, 0, `resolve, ${proxy}`)
  }
})

test('FIXED review-msg-4: a verdict served from the identity cache is a copy; changing a caught error\'s data does not change the next one', async () => {
  const { chain, c } = world()
  const api = conformApi(chain)
  chain.state.files.delete(`${c.container.toLowerCase()}:${CHANNEL_KEYS_KEY}`)
  const first = await api.chain.channelKeys(c.container).catch((e) => e)
  assert.equal(first.data.status, 'not-found')
  first.data.status = 'tampered'
  const second = await api.chain.channelKeys(c.container).catch((e) => e)
  assert.equal(second.data.status, 'not-found')
  second.data.status = 'tampered again'
  assert.equal((await api.chain.channelKeys(c.container).catch((e) => e)).data.status, 'not-found')
})

test('FIXED review-msg-5: the conformance mode takes only the factory and opener TAP-10 lists for the chain (TAP-10 §2.2)', () => {
  const { chain } = world()
  const inv = (re) => (e) => e instanceof TapeAPIError && e.code === 'INVALID_ARGUMENT' && re.test(e.message)
  assert.throws(() => conformApi(chain, { factory: ADDR.factory }), inv(/uses only the factory TAP-10 lists for chain 56.*§2\.2/))
  assert.throws(() => conformApi(chain, { opener: '0x' + '0e'.repeat(20) }), inv(/uses only the opener TAP-10 lists/))
  assert.doesNotThrow(() => conformApi(chain, { factory: CHAINS[56].factory.toLowerCase(), opener: CHAINS[56].opener }))
  assert.doesNotThrow(() => defaultApi(chain, { factory: ADDR.factory, opener: '0x' + '0e'.repeat(20) }), 'the default mode is unchanged')
  // a sub-client is held to its own chain's addresses / 子客户端按它自己那条链的地址
  const api = conformApi(chain, { chains: { 8453: { rpcUrls: RPC, factory: CHAINS[56].factory } } })
  assert.throws(() => api.forChain(8453), inv(/factory TAP-10 lists for chain 8453/))
})

test('FIXED review-msg-6: tapesend.endpoint takes a third argument of null or false as "not in the conformance mode", as 1.4 ignored it', () => {
  const A = '0x86DDaEF00401E3F10418398D67D7189fc458eA95'
  const want = tapesend.endpoint(A, 2n ** 60n)
  for (const third of [undefined, null, false, {}, { conform: null }, { conform: false }]) assert.deepEqual(tapesend.endpoint(A, 2n ** 60n, third), want, String(third))
})

test('sealStatusStore keeps the sticky §13.8 statuses across clients and restarts (key chainId:hub); without it, per client instance', async () => {
  const { chain, c } = world()
  const store = new Map()
  const a = conformApi(chain, { sealStatusStore: store })
  chain.setSeal({ beaconImplementation: '0x' + '9a'.repeat(20) })
  await assert.rejects(a.chain.tapeSendKey(c.container), isStatus('CONTRACT_UNKNOWN', 'circuits-changed'))
  const key = `56:${MAINNET.hub.toLowerCase()}`
  assert.deepEqual(Object.keys(store.get(key)).sort(), ['circuitsChangedAt', 'factorySealLost', 'factorySealSeen' + 'At'].sort())
  assert.equal(store.get(key).circuitsChangedAt, chain.state.block - 2)
  chain.setSeal({ beaconImplementation: TAP10_SEALS[56].circuitImplementation })
  // a new client on the same store ("after a restart") keeps it; one without it starts clean
  // 用同一存储的新客户端（相当于重启之后）保留它；不用存储的新客户端从头开始
  await assert.rejects(conformApi(chain, { sealStatusStore: store }).chain.tapeSendKey(c.container), isStatus('CONTRACT_UNKNOWN', 'circuits-changed', new RegExp(`seen at block ${chain.state.block - 2}`)))
  assert.equal((await conformApi(chain).chain.tapeSendKey(c.container)).tap10.circuits, 'ok')
  // an async store works too / 异步存储同样可用
  const later = { m: new Map(), async get(k) { return this.m.get(k) }, async set(k, v) { this.m.set(k, v) } }
  later.m.set(key, { circuitsChangedAt: 1, factorySealSeenAt: null, factorySealLost: false })
  await assert.rejects(conformApi(chain, { sealStatusStore: later }).chain.tapeSendKey(c.container), isStatus('CONTRACT_UNKNOWN', 'circuits-changed'))
  assert.throws(() => conformApi(chain, { sealStatusStore: {} }), (e) => e.code === 'INVALID_ARGUMENT' && /sealStatusStore/.test(e.message))
})

test('a contract holder: EIP-1271 approval of the record is read strictly (eth_getCode and isValidSignature to every node) at the pinned block', async () => {
  const { chain, c, keys } = world({ record: false })
  const safe = '0x' + '5a'.repeat(20)
  chain.setOwner(4246, safe)
  const digest = sig.channelKeysDigest(56, MAINNET.hub, keys)
  chain.setContractHolder(safe, digest)
  chain.writeFile(c.container, CHANNEL_KEYS_KEY, canonicalJSON({ tapechannel: '1', chainId: 56, ...keys, sig: '0x' + 'ab'.repeat(100) }))
  const api = conformApi(chain)
  const from = chain.conform.log.length
  const r = await api.chain.channelKeys(c.container)
  assert.equal(r.holder.toLowerCase(), safe)
  const log = since(chain, from)
  for (const pick of [(x) => x.method === 'eth_getCode' && x.to === null, (x) => x.fn === 'isValidSignature']) {
    const hits = log.filter(pick)
    assert.deepEqual([...new Set(hits.map((x) => x.url))].sort(), RPC)
    for (const x of hits) assert.deepEqual(x.block, { blockHash: r.tap10.pinned.hash, requireCanonical: true })
  }
  // the holder no longer approves: record-invalid / 持有人不再认可即 record-invalid
  chain.state.contractHolders.set(safe, new Set())
  await assert.rejects(conformApi(chain).chain.channelKeys(c.container), isStatus('CHANNEL_INVALID', 'record-invalid', /not authorised/))
})

test('a record whose read() reverts while fileInfo answers is incomplete', async () => {
  const { chain, c } = world()
  chain.setFileBytes(c.container, CHANNEL_KEYS_KEY, null)
  await assert.rejects(conformApi(chain).chain.channelKeys(c.container), isStatus('CHANNEL_INVALID', 'incomplete', /read\(\) reverted/))
})
