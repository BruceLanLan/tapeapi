// The TAP-10 conformance mode, 1.5: the messaging path (TAP-10 §12.2 and §14.4).
// api.chain.tapeSendKey resolves the endpoint as TAP-10 §12.2 and reads the key as §14.4 steps 1-3 (fresh pinned block,
// strict agreement, eth_chainId, the hub accepted, circuits not changed, the key checks); api.chain.channelKeys reads the
// channel record as the private-channels draft §3.3 (TAPI-26 §3.1 under TAP-10's read rules); neither judges activation
// or opening (§12.2). tapesend.js refuses chainIds above 2^53 - 1 under conform: 'tap10' (§12.1). Offline: every RPC goes
// to the conform chain (helpers/conform-chain.mjs). GOLDEN TAP10-0 (default-mode-trace.test.mjs) pins that the 1.x resolution
// (conform: false since 2.0, when the conformance mode became the default) is unchanged.
// TAP-10 一致模式 1.5：消息路径。tapeSendKey 按 §12.2 解析端点、按 §14.4 第 1–3 步读密钥；channelKeys 按私密通道草稿 §3.3 读记录；
// 两者都不判激活与开通。tapesend.js 在 conform: 'tap10' 下拒绝大于 2^53 − 1 的 chainId。全部离线；默认模式不变由黄金测试钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createTapeAPI, MANIFEST_KEY, CHANNEL_KEYS_KEY, MAINNET, CHAINS, TAP10_SEALS, TAP10_MAX_CHAIN_ID, TAP10_HUB_BOOT, TAP10_HUB_HISTORY, TapeAPIError, sig, channel, canonicalJSON, tapesend } from '../src/index.js'
import { createConformChain, ADDR, HUB_OWNER, defaultUpgraded } from './helpers/conform-chain.mjs'
import { utf8ToBytes, checksumAddress } from '../src/abi.js'

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
// 2.0: the default-mode controls are the 1.x resolution, conform: false / 2.0：默认模式对照即 1.x 的解析，conform: false
const defaultApi = (chain, o = {}) => createTapeAPI({ conform: false, rpcUrls: RPC, fetch: chain.fetch, clock: () => T, quiet: true, onWarning: () => {}, ...o })
const isStatus = (code, status, re) => (e) => {
  assert.ok(e instanceof TapeAPIError, String(e)); assert.equal(e.code, code, e.message); assert.equal(e.data?.status, status, e.message)
  if (re) assert.match(e.message, re)
  return true
}
const since = (chain, from) => chain.conform.log.slice(from)
const log0 = since

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
    // The fake chain's block (62,000,000) is below the hub's creation block: no Upgraded scan, the slot alone (T-b tests below)
    // 假链区块低于中枢创建块：不扫描日志，只看实现槽（日志扫描的测试见下）
    assert.deepEqual(k.tap10.hub, { implementation: TAP10_SEALS[56].hub.toLowerCase(), accepted: true, basis: 'slot',
      upgraded: { status: 'unavailable', from: TAP10_HUB_HISTORY[56].createdAt, to: k.tap10.pinned.number, reason: `the pinned block ${k.tap10.pinned.number} is before the hub's creation block ${TAP10_HUB_HISTORY[56].createdAt}` } })
    assert.ok(!log0(chain, from).some((x) => x.method === 'eth_getLogs'))
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
  // and a conform: false parent gives conform: false sub-clients (2.0: false is passed on, not undefined, which is now the
  // conformance mode) / conform: false 的父客户端给出 conform: false 的子客户端（2.0：传 false，因为 undefined 现在就是一致模式）
  const plain = createTapeAPI({ conform: false, rpcUrls: urls(56), fetch, quiet: true, onWarning: () => {}, chains: { 8453: { rpcUrls: urls(8453) } } })
  assert.equal((await plain.forChain(8453).chain.tapeSendKey(worlds[8453].c.container)).tap10, undefined)
  // 2.0 (D-4): a parent that leaves conform out gives conformance sub-clients / 2.0：不传 conform 的父客户端给出一致模式的子客户端
  worlds[8453].chain.setSeal({ beaconImplementation: TAP10_SEALS[8453].circuitImplementation })
  const byDefault = createTapeAPI({ rpcUrls: urls(56), fetch, clock: () => T, quiet: true, chains: { 8453: { rpcUrls: urls(8453) } } })
  assert.equal((await byDefault.forChain(8453).chain.tapeSendKey(worlds[8453].c.container)).tap10.circuits, 'ok')
})

// ── tapesend.js, TAP-10 §12.1 ─────────────────────────────────────────────────────────────────────────────────────
test("tapesend under conform: 'tap10' refuses a chainId above 2^53 - 1 everywhere (TAP-10 §12.1); without it the bound stays 2^64 - 1", () => {
  const A = '0x86DDaEF00401E3F10418398D67D7189fc458eA95', B = '0x19366c3c69ffeb3b286d9fa6cc5e616375baafd3', HUB = MAINNET.hub
  const max = 2n ** 53n - 1n, over = 2n ** 53n
  const badInput = (re) => (e) => e instanceof TapeAPIError && e.data.reason === 'bad-input' && (!re || re.test(e.message))
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

// ── T-b: TAP-10 §13.8, the hub's Upgraded logs / 中枢的 Upgraded 日志 ────────────────────
// "When log-capable nodes are available, a client SHOULD read every Upgraded log of the hub and accept the hub only if
// every implementation it names is the boot implementation or listed under Deployments (current or replaced)."
const HEAD = 126_300_000   // above every hub's creation block / 高于各链中枢的创建块
const scanWorld = (o) => { const w = world(o); w.chain.state.block = HEAD; return w }
const getLogs = (log) => log.filter((x) => x.method === 'eth_getLogs')
const cs = checksumAddress

test('TAP10_HUB_HISTORY: the creation blocks and Upgraded logs read on chain (fixtures/tap10-hub-history-onchain.json), and TAP-10\'s Deployments', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/tap10-hub-history-onchain.json', import.meta.url), 'utf8'))
  const lc = (a) => String(a).toLowerCase()
  assert.equal(lc(TAP10_HUB_BOOT), fx.boot); assert.equal(fx.hub, lc(MAINNET.hub))
  assert.deepEqual(Object.keys(TAP10_HUB_HISTORY).map(Number).sort((a, b) => a - b), [56, 196, 8453])
  for (const id of [56, 196, 8453]) {
    const h = TAP10_HUB_HISTORY[id], r = fx.chains[id]
    assert.equal(h.createdAt, r.createdAt, `${id} creation block`)
    // the constructor's Upgraded(boot) is at the creation block / 构造时的 Upgraded(boot) 在创建块
    assert.deepEqual([r.logs[0].block, r.logs[0].implementation], [h.createdAt, fx.boot], `${id} boot log`)
    // the current implementation is listed first, the replaced ones after / 当前实现在前，已替换的在后
    assert.equal(lc(h.listed[0]), lc(TAP10_SEALS[id].hub))
    assert.ok(Object.isFrozen(h) && Object.isFrozen(h.listed))
    // review A1: the second anchor, the Upgraded to the current implementation, was read on chain too; every log read names
    // the boot implementation or one TAP-10 lists, in order / 第二个锚点（升级到当前实现）同样在链上读到；每条日志都是 boot 或列出的实现
    assert.ok(r.logs.some((l) => l.implementation === lc(TAP10_SEALS[id].hub) && l.block > h.createdAt), `${id}: Upgraded(current) read on chain`)
    for (const l of r.logs) assert.ok([fx.boot, ...h.listed.map(lc)].includes(l.implementation), `${id} ${l.block}`)
    assert.deepEqual(r.logs.map((l) => [l.block, l.logIndex]), [...r.logs].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex).map((l) => [l.block, l.logIndex]), `${id} order`)
  }
  // BNB Smart Chain: v3 current since block 122623031, v2 and v1 replaced (TAP-10 Deployments) / BSC：v3 自 122623031 起为当前
  assert.deepEqual(TAP10_HUB_HISTORY[56].listed.map(lc), ['0x80afe7b77f2dfd08e9feab7675780bac34a7ee85', '0x7df03218910e0f37fc3a8da8792831ab7580340f', '0xf5f18e3fe811b9b382c90539d14440654e789d92'])
  // the whole BSC history read on chain: boot, v1, v2, v3 (current since 122623031) / BSC 的全部历史：boot、v1、v2、v3
  assert.deepEqual(fx.chains[56].logs.map((l) => [l.block, l.implementation]), [[122571550, fx.boot], [122571622, lc(TAP10_HUB_HISTORY[56].listed[2])], [122573605, lc(TAP10_HUB_HISTORY[56].listed[1])], [122623031, lc(TAP10_SEALS[56].hub)]])
  assert.deepEqual([fx.chains[196].logs[1].block, fx.chains[8453].logs[1].block], [71019488, 51499091])
  for (const id of [196, 8453]) assert.equal(TAP10_HUB_HISTORY[id].listed.length, 1)
})

test('T-b: with log-capable nodes, one eth_getLogs over the whole history under strict agreement; every implementation listed: ok, basis slot+logs', async () => {
  for (const chainId of [56, 8453, 196]) {
    const { chain, c } = scanWorld({ chainId })
    const api = conformApi(chain, { chainId })
    const from = chain.conform.log.length
    const k = await api.chain.tapeSendKey(c.container)
    const h = TAP10_HUB_HISTORY[chainId]
    assert.deepEqual(k.tap10.hub, { implementation: TAP10_SEALS[chainId].hub.toLowerCase(), accepted: true, basis: 'slot+logs',
      upgraded: { status: 'ok', from: h.createdAt, to: k.tap10.pinned.number, implementations: [TAP10_HUB_BOOT, ...[...h.listed].reverse()].map((a) => cs(a)) } }, String(chainId))
    const logs = getLogs(since(chain, from))
    assert.deepEqual(logs.map((x) => x.url).sort(), RPC, 'strict: every node was asked, once')
  }
  // the filter: the hub, the Upgraded topic, from the creation block to the pinned block / 过滤条件
  const { chain, c } = scanWorld()
  const seen = []
  const fetch = (u, i) => { const b = JSON.parse(i.body); for (const r of [b].flat()) if (r.method === 'eth_getLogs') seen.push(r.params[0]); return chain.fetch(u, i) }
  const k = await conformApi(chain, { fetch }).chain.tapeSendKey(c.container)
  assert.deepEqual(seen[0], { address: MAINNET.hub, topics: ['0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b'], fromBlock: '0x' + TAP10_HUB_HISTORY[56].createdAt.toString(16), toBlock: '0x' + k.tap10.pinned.number.toString(16) })
})

test('T-b: an Upgraded log naming an unlisted implementation is hub-changed even with the current implementation in the slot, and it sticks', async () => {
  const EVIL = '0x' + 'e7'.repeat(20)
  const { chain, c } = scanWorld()
  const h = TAP10_HUB_HISTORY[56]
  // the owner upgraded to EVIL, rewrote storage and restored v3 in one transaction / 一笔交易里升级到 EVIL、改存储、再恢复 v3
  chain.setUpgradedLogs([...defaultUpgraded(56), { block: h.createdAt + 1000, logIndex: 4, implementation: EVIL, tx: '0x' + 'ab'.repeat(32) }, { block: h.createdAt + 1000, logIndex: 5, implementation: TAP10_SEALS[56].hub }])
  const store = new Map()
  await assert.rejects(conformApi(chain, { sealStatusStore: store }).chain.tapeSendKey(c.container), (e) => {
    isStatus('CONTRACT_UNKNOWN', 'hub-changed', /an Upgraded log .* at block 122572550 .* names implementation 0xE7e7.*neither the boot implementation nor one TAP-10 lists/i)(e)
    assert.deepEqual(e.data.upgradedLog, { block: h.createdAt + 1000, logIndex: 4, tx: '0x' + 'ab'.repeat(32), implementation: cs(EVIL) })
    assert.equal(e.data.implementation, TAP10_SEALS[56].hub.toLowerCase(), 'the slot shows the current one')
    return true
  })
  // kept: later the nodes refuse logs, the slot is fine, still hub-changed (same store, a new client) / 粘住
  for (const u of RPC) chain.setLogFault(u, 'refuse')
  await assert.rejects(conformApi(chain, { sealStatusStore: store }).chain.tapeSendKey(c.container), isStatus('CONTRACT_UNKNOWN', 'hub-changed', /Upgraded log/))
  assert.equal(store.get(`56:${MAINNET.hub.toLowerCase()}`).upgradedLog.implementation, cs(EVIL))
  // a client without that store sees only the slot: accepted, and it says so / 没有该存储的客户端只看实现槽，并注明
  const fresh = await conformApi(chain).chain.tapeSendKey(c.container)
  assert.deepEqual([fresh.tap10.hub.accepted, fresh.tap10.hub.basis, fresh.tap10.hub.upgraded.status], [true, 'slot', 'unavailable'])
  // a stored log naming an implementation this SDK lists (v2, replaced) does not count: judged again on every read
  // 存储里指向本 SDK 已列出实现（v2，已替换）的日志不算：每次重新判断
  const listed = new Map([[`56:${MAINNET.hub.toLowerCase()}`, { upgradedLog: { block: 1, logIndex: 0, tx: '0x00', implementation: TAP10_HUB_HISTORY[56].listed[1] } }]])
  assert.equal((await conformApi(chain, { sealStatusStore: listed }).chain.tapeSendKey(c.container)).tap10.hub.accepted, true)
  // replaced implementations (v1, v2) in the history are accepted; only the slot must be the current one / 历史里的 v1、v2 可接受
  for (const u of RPC) chain.setLogFault(u, null)
  chain.setUpgradedLogs(defaultUpgraded(56))
  assert.equal((await conformApi(chain).chain.tapeSendKey(c.container)).tap10.hub.upgraded.status, 'ok')
})

test('T-b: logs unavailable (refused, a short range, too few operators) or disputed: the slot alone, said in the result, never hub-changed', async () => {
  const { chain, c } = scanWorld()
  const api = conformApi(chain)
  // every node refuses, as the BNB Chain dataseed does / 全部拒绝
  for (const u of RPC) chain.setLogFault(u, 'refuse')
  let from = chain.conform.log.length
  const k = await api.chain.tapeSendKey(c.container)
  assert.deepEqual([k.staticPublic, k.tap10.hub.accepted, k.tap10.hub.basis, k.tap10.hub.upgraded.status], [KEY, true, 'slot', 'unavailable'])
  assert.match(k.tap10.hub.upgraded.reason, /^RPC_UNAVAILABLE: eth_getLogs: only 0\/3/)
  assert.equal(getLogs(since(chain, from)).length, 3)
  // not asked again for 300 s / 300 秒内不再询问
  from = chain.conform.log.length
  const again = await api.chain.tapeSendKey(c.container)
  assert.deepEqual([again.tap10.hub.basis, getLogs(since(chain, from)).length], ['slot', 0])
  assert.equal(again.tap10.hub.upgraded.reason, k.tap10.hub.upgraded.reason)
  // one node with a short range (48 Club) is enough to make a strict read unavailable / 一个节点区间受限即不可用
  for (const u of RPC) chain.setLogFault(u, null)
  chain.setLogFault('http://rpc3', 'range')
  assert.equal((await conformApi(chain).chain.tapeSendKey(c.container)).tap10.hub.upgraded.status, 'unavailable')
  // a node with pruned history answers []: it did not answer (no anchor), it does not vouch for an empty history
  // 历史被裁剪的节点答 []：不算作答（没有锚点），不能替空历史作保
  chain.setLogFault('http://rpc3', 'empty')
  const pruned = await conformApi(chain).chain.tapeSendKey(c.container)
  assert.equal(pruned.tap10.hub.upgraded.status, 'unavailable')
  assert.match(pruned.tap10.hub.upgraded.reason, /rpc3.*no Upgraded\(boot\) at the hub's creation block/)
  // every node pruned, all agreeing on []: still no answer, never "no upgrade ever" / 全部被裁剪、一致答 []：仍不算作答
  for (const u of RPC) chain.setLogFault(u, 'empty')
  assert.equal((await conformApi(chain).chain.tapeSendKey(c.container)).tap10.hub.upgraded.status, 'unavailable')
  for (const u of RPC) chain.setLogFault(u, null)
  chain.setLogFault('http://rpc3', 'empty')
  // ...and with a fourth operator, strict agreement still has three: the scan completes without it / 有第四家时仍有三家，扫描完成
  const four = await conformApi(chain, { rpcUrls: [...RPC, 'http://rpc4'] }).chain.tapeSendKey(c.container)
  assert.deepEqual([four.tap10.hub.basis, four.tap10.hub.upgraded.status], ['slot+logs', 'ok'])
  // one node invents an unlisted implementation: a disagreement, unavailable, never hub-changed / 单个节点编造：分歧，不可用，绝不 hub-changed
  chain.setLogFault('http://rpc3', { logs: [...defaultUpgraded(56), { block: TAP10_HUB_HISTORY[56].createdAt + 50, logIndex: 1, implementation: '0x' + 'e7'.repeat(20) }] })
  const store = new Map()
  const lied = await conformApi(chain, { sealStatusStore: store }).chain.tapeSendKey(c.container)
  assert.deepEqual([lied.tap10.hub.accepted, lied.tap10.hub.basis], [true, 'slot'])
  assert.match(lied.tap10.hub.upgraded.reason, /^RPC_DISAGREE/)
  assert.equal(store.get(`56:${MAINNET.hub.toLowerCase()}`)?.upgradedLog, undefined, 'nothing kept')
  // a log of another contract or topic in an answer: that node did not answer / 回答里夹着别的合约或 topic 的日志：该节点不算作答
  chain.setLogFault('http://rpc3', { logs: [...defaultUpgraded(56), { block: TAP10_HUB_HISTORY[56].createdAt + 50, implementation: TAP10_HUB_BOOT, address: '0x' + '12'.repeat(20) }] })
  assert.match((await conformApi(chain).chain.tapeSendKey(c.container)).tap10.hub.upgraded.reason, /rpc3.*a log outside the filter/)
})

// Review of T-b (2026-10-08): A2, A3, B1, B2. Each was checked by removing the line that implements it.
// T-b 审查：A2、A3、B1、B2，每条都做过反向检查。
test('FIXED T-b-A2: a node whose history lacks the Upgraded to the current implementation did not answer: unavailable, history incomplete', async () => {
  const { chain, c } = scanWorld()
  chain.setUpgradedLogs(defaultUpgraded(56).filter((l) => l.implementation.toLowerCase() !== TAP10_SEALS[56].hub.toLowerCase()))
  const k = await conformApi(chain).chain.tapeSendKey(c.container)
  assert.deepEqual([k.tap10.hub.accepted, k.tap10.hub.basis, k.tap10.hub.upgraded.status], [true, 'slot', 'unavailable'])
  assert.match(k.tap10.hub.upgraded.reason, /no Upgraded to the current implementation: history incomplete/)
})

test('FIXED T-b-B1: logs that are not the filter\'s answer make that node not answer (removed, outside the range, another topic 0, a topic 1 with high bits); of two unlisted logs the earlier is reported', async () => {
  const EVIL = '0x' + 'e7'.repeat(20)
  const h = TAP10_HUB_HISTORY[56]
  const unanswered = async (setup, re) => {
    const { chain, c } = scanWorld()
    setup(chain)
    const store = new Map()
    const k = await conformApi(chain, { sealStatusStore: store }).chain.tapeSendKey(c.container)
    assert.deepEqual([k.tap10.hub.accepted, k.tap10.hub.basis, k.tap10.hub.upgraded.status], [true, 'slot', 'unavailable'], String(re))
    assert.match(k.tap10.hub.upgraded.reason, re)
    assert.equal(store.get(`56:${MAINNET.hub.toLowerCase()}`)?.upgradedLog, undefined, 'nothing kept')
  }
  const extra = (o) => (chain) => chain.setUpgradedLogs([...defaultUpgraded(56), { block: h.createdAt + 7, logIndex: 1, implementation: EVIL, ...o }])
  const answered = (logs) => (chain) => { for (const u of RPC) chain.setLogFault(u, { logs: [...defaultUpgraded(56), ...logs] }) }
  await unanswered(extra({ removed: true }), /a log outside the filter/)
  await unanswered(extra({ topics: ['0x' + '99'.repeat(32), '0x' + EVIL.slice(2).padStart(64, '0')] }), /a log outside the filter/)
  await unanswered(extra({ topics: ['0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b', '0x' + 'ff'.repeat(12) + EVIL.slice(2)] }), /topic 1 is not an address word/)
  await unanswered(answered([{ block: HEAD + 10, logIndex: 0, implementation: EVIL }]), new RegExp(`a log at block ${HEAD + 10}, outside ${h.createdAt}\\.\\.\\d+`))
  await unanswered(answered([{ block: h.createdAt - 1, logIndex: 0, implementation: EVIL }]), new RegExp(`a log at block ${h.createdAt - 1}, outside`))
  // two unlisted implementations, answered in reverse order: the earlier is the one reported and kept
  // 两个未列出的实现、倒序作答：报告并保留较早的那条
  const { chain, c } = scanWorld()
  const late = { block: h.createdAt + 2000, logIndex: 0, implementation: '0x' + 'd4'.repeat(20), tx: '0x' + 'cd'.repeat(32) }
  const early = { block: h.createdAt + 1000, logIndex: 3, implementation: EVIL, tx: '0x' + 'ab'.repeat(32) }
  for (const u of RPC) chain.setLogFault(u, { logs: [...defaultUpgraded(56), late, early] })
  const store = new Map()
  await assert.rejects(conformApi(chain, { sealStatusStore: store }).chain.tapeSendKey(c.container), (e) => {
    isStatus('CONTRACT_UNKNOWN', 'hub-changed')(e)
    assert.deepEqual(e.data.upgradedLog, { block: early.block, logIndex: 3, tx: early.tx, implementation: cs(EVIL) })
    return true
  })
  // a stored record later than the scan's: the scan's earlier one replaces it; an earlier stored one stays
  // 存储的记录晚于扫描的：换成扫描的较早那条；存储的更早：保留
  const key = `56:${MAINNET.hub.toLowerCase()}`
  const later = new Map([[key, { upgradedLog: { block: h.createdAt + 5000, logIndex: 0, tx: '0x01', implementation: cs('0x' + 'd5'.repeat(20)) } }]])
  await assert.rejects(conformApi(chain, { sealStatusStore: later }).chain.tapeSendKey(c.container), (e) => e.data?.upgradedLog?.block === early.block)
  assert.equal(later.get(key).upgradedLog.block, early.block)
  const earlier = new Map([[key, { upgradedLog: { block: h.createdAt + 500, logIndex: 0, tx: '0x02', implementation: cs('0x' + 'd6'.repeat(20)) } }]])
  await assert.rejects(conformApi(chain, { sealStatusStore: earlier }).chain.tapeSendKey(c.container), (e) => e.data?.upgradedLog?.block === h.createdAt + 500)
})

test('FIXED T-b-A3: a stored upgradedLog that is not of the shape this client writes is no record (never hub-changed "at block undefined"); a real one is written over it', async () => {
  const EVIL = '0x' + 'e7'.repeat(20)
  const key = `56:${MAINNET.hub.toLowerCase()}`
  const good = { block: 122_572_000, logIndex: 0, tx: '0x' + 'ab'.repeat(32), implementation: cs(EVIL) }
  for (const bad of [{ implementation: 'hello' }, { ...good, implementation: 'hello' }, { ...good, block: 'abc' }, { ...good, block: 1.5 }, { ...good, logIndex: -1 }, { ...good, logIndex: '0' }, { ...good, tx: 7 }, { block: 1, logIndex: 0, implementation: EVIL }, 'x']) {
    const { chain, c } = scanWorld()
    const store = new Map([[key, { upgradedLog: bad }]])
    const k = await conformApi(chain, { sealStatusStore: store }).chain.tapeSendKey(c.container)
    assert.deepEqual([k.tap10.hub.accepted, k.tap10.hub.upgraded.status], [true, 'ok'], JSON.stringify(bad))
  }
  // the well-formed record still sticks / 形状正确的记录仍然粘住
  const { chain, c } = scanWorld()
  await assert.rejects(conformApi(chain, { sealStatusStore: new Map([[key, { upgradedLog: good }]]) }).chain.tapeSendKey(c.container), isStatus('CONTRACT_UNKNOWN', 'hub-changed', /at block 122572000/))
  // a malformed record and a real unlisted log: the real one is reported and stored / 形状错误的记录加真实的未列出日志：报告并存储真实的
  const real = { block: TAP10_HUB_HISTORY[56].createdAt + 9, logIndex: 2, implementation: EVIL, tx: '0x' + 'ef'.repeat(32) }
  chain.setUpgradedLogs([...defaultUpgraded(56), real])
  const store = new Map([[key, { upgradedLog: { block: 'abc', implementation: '0x' + 'd4'.repeat(20) } }]])
  await assert.rejects(conformApi(chain, { sealStatusStore: store }).chain.tapeSendKey(c.container), (e) => e.data?.upgradedLog?.block === real.block)
  assert.equal(store.get(key).upgradedLog.block, real.block)
})

test('FIXED T-b-B2: every chain the conformance mode accepts has a hub history whose current implementation comes first', () => {
  assert.deepEqual(Object.keys(TAP10_SEALS).sort(), Object.keys(TAP10_HUB_HISTORY).sort())
  for (const id of Object.keys(TAP10_SEALS).map(Number)) {
    const h = TAP10_HUB_HISTORY[id]
    assert.ok(Number.isSafeInteger(h.createdAt) && h.listed.length > 0 && h.listed[0].toLowerCase() === TAP10_SEALS[id].hub.toLowerCase(), String(id))
    assert.doesNotThrow(() => conformApi(createConformChain({ chainId: id }), { chainId: id }), String(id))
  }
})

test('T-b: the default mode never scans: tapeSendKey on the same chain sends no eth_getLogs (GOLDEN TAP10-0 pins the rest)', async () => {
  const { chain, c } = scanWorld()
  const from = chain.conform.log.length
  const d = await defaultApi(chain).chain.tapeSendKey(c.container)
  assert.equal(d.staticPublic, KEY); assert.equal(d.tap10, undefined)
  assert.ok(!since(chain, from).some((x) => x.method === 'eth_getLogs' || x.method === 'eth_chainId'))
  // channelKeys in the conformance mode reads no hub state either / 一致模式的 channelKeys 也不读中枢状态
  const f2 = chain.conform.log.length
  await conformApi(chain).chain.channelKeys(c.container)
  assert.ok(!since(chain, f2).some((x) => x.method === 'eth_getLogs'))
})
