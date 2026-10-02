// The TAP-10 conformance mode, 1.4: the resolution path (createTapeAPI({ conform: 'tap10' }), pin: 'tap10',
// api.siteStatus). docs/DESIGN-tap10-conform.md, rows 1-6, 9-11, 13-16 and 22 of the Opus draft's table. Offline: every
// RPC goes to the conform chain (helpers/conform-chain.mjs), a fake chain that also answers the opener, the DomainBinding,
// cpuCount and per-node heads, by address. GOLDEN TAP10-0 (default-mode-trace.test.mjs) pins that none of this changes
// the default mode.
// TAP-10 一致模式 1.4：解析路径。全部离线：RPC 都发往 conform 链（在假链上按地址回答开通器、DomainBinding、cpuCount 与各节点头块）。
// 默认模式不受影响由黄金测试 TAP10-0 钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTapeAPI, createRpc, MANIFEST_KEY, CHANNEL_KEYS_KEY, MAINNET, CHAINS, TapeAPIError, sig, channel, canonicalJSON, parseTapeInput } from '../src/index.js'
import { createConformChain, LEGACY_BINDING, ADDR } from './helpers/conform-chain.mjs'
import { createFakeChain } from './helpers/fake-chain.mjs'

const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32), OTHER_KEY = '0x' + '33'.repeat(32)
const holder = sig.privateKeyToAddress(HOLDER_KEY), signer = sig.privateKeyToAddress(SIGNER_KEY)
const RPC = ['http://rpc1', 'http://rpc2', 'http://rpc3']
const T = 1_790_000_000
const EXPIRES = T + 30 * 86_400

function manifestOf(c, chainId = 56, { key = HOLDER_KEY, ...over } = {}) {
  return {
    tapeapi: '0.1', name: 'Conform', circuits: c.circuits, tokenId: c.tokenId, container: c.container, signer,
    delegation: { expires: EXPIRES, sig: sig.signDigest(sig.delegationDigest(chainId, MAINNET.hub, { container: c.container, signer, expires: EXPIRES }), key) },
    endpoints: { live: ['https://api.example.com/tapeapi/v1'], async: false },
    methods: [{ name: 'ping', priceBEM: '0', params: {}, returns: {} }], ...over,
  }
}
// A valid TAP-10 service: processor 7, #4246, opened, activated (the conform chain's defaults), with a manifest
// 一个有效的 TAP-10 服务：7 号处理器 #4246，已开通、已激活（conform 链的默认），带清单
function world({ chainId = 56, tokenId = 4246, manifest = true, ...m } = {}) {
  const chain = createConformChain({ chainId })
  chain.state.headTime = T
  const c = chain.circuit(tokenId, { holder })
  if (manifest) chain.writeFile(c.container, MANIFEST_KEY, typeof manifest === 'string' ? manifest : JSON.stringify(manifestOf(c, chainId, m)))
  return { chain, c }
}
const conformApi = (chain, o = {}) => createTapeAPI({ conform: 'tap10', rpcUrls: RPC, fetch: chain.fetch, clock: () => T, quiet: true, onWarning: () => {}, ...o })
const isStatus = (code, status, re) => (e) => {
  assert.ok(e instanceof TapeAPIError, String(e)); assert.equal(e.code, code, e.message); assert.equal(e.data?.status, status, e.message)
  if (re) assert.match(e.message, re)
  return true
}
const fnsOf = (chain) => chain.conform.log.filter((x) => x.fn).map((x) => x.fn)

// ── options / 选项 ──────────────────────────────────────────────────────────────────────────────────────────────────
test('conform: only the string \'tap10\'; it implies pin: \'tap10\' and refuses any other explicit pin; it needs the chain\'s own site contracts', () => {
  const { chain } = world()
  const inv = (re) => (e) => e instanceof TapeAPIError && e.code === 'INVALID_ARGUMENT' && re.test(e.message)
  for (const v of [true, 'TAP10', 'tap10@1.2', 1, 0, '', {}]) assert.throws(() => conformApi(chain, { conform: v }), inv(/conform: pass 'tap10'/), String(v))
  for (const pin of [false, 'latest', true, { tag: 'finalized' }, {}]) assert.throws(() => conformApi(chain, { pin }), inv(/cannot be combined with another pin option/), JSON.stringify(pin))
  assert.doesNotThrow(() => conformApi(chain, { pin: 'tap10' }))
  // the fake chain's own addresses have no accepted implementations: always store-changed, so refused now
  // 假链自己的地址没有接受列表：只会永远 store-changed，所以现在就拒绝
  assert.throws(() => conformApi(chain, { siteRegistry: ADDR.siteRegistry }), inv(/accepts only the siteRegistry proxies TAP-10 lists/))
  assert.throws(() => conformApi(chain, { binding: '0x' + '12'.repeat(20) }), inv(/accepts only the binding proxies/))
  assert.throws(() => conformApi(chain, { chainId: 97 }), inv(/./))
  assert.throws(() => createTapeAPI({ pin: 'tap10', chainId: 97, rpcUrls: RPC, fetch: chain.fetch, quiet: true }), inv(/'tap10' needs a TapeOut chain/))
  assert.deepEqual([56, 196, 8453].map((id) => CHAINS[id].tap10MaxPinLag), [400, 300, 150], 'TAP-10 §2.1 max pin lag')
  assert.deepEqual([56, 196, 8453].map((id) => CHAINS[id].maxPinLagBlocks), [266, 600, 150], 'the security-1.1 values are unchanged')
})

// ── resolution / 解析 ───────────────────────────────────────────────────────────────────────────────────────────────
test('every TAP-10 input form of one name resolves to the same service, through the opener, at one pinned block hash', async () => {
  const { chain, c } = world()
  // The processor contract#ID string (`0x…#4246`) is input without chain information that needs every chain (allChains):
  // conform-allchains.test.mjs. / "处理器合约#ID"字符串是需要所有链的无链信息输入（allChains）：见 conform-allchains.test.mjs。
  const forms = ['4246.7.tape', '4246.7', '4246.7.TAPE', '#4246@7', '4246@7', 'tape://4246.7.tape/', 'TAPE://4246.7/docs/index.html', 'web+tape://4246.7.tape/', ' 4246.7.tape ',
    c.container, { circuits: c.circuits, tokenId: 4246 }, { chainId: 56, container: c.container }, { chainId: 56, circuits: c.circuits, tokenId: 4246 }]
  const api = conformApi(chain)
  for (const f of forms) {
    const from = chain.conform.log.length
    const svc = await api.resolve(f)
    assert.equal(svc.container, c.container, JSON.stringify(f))
    assert.deepEqual(svc.verified, { delegation: true, holder })
    assert.equal(svc.conform.status, 'resolved'); assert.equal(svc.conform.site, 'ok'); assert.equal(svc.conform.version, '1.1')
    assert.equal(svc.conform.name, '4246.7.tape', JSON.stringify(f))   // a container input finds the number (kept table or scan, 1.5)
    assert.equal(svc.conform.holder, holder); assert.equal(svc.conform.opened, true)
    assert.deepEqual(svc.conform.activation, { live: true, isLive: false, isContainerLive: true })
    assert.equal(svc.pinned.mode, 'tap10'); assert.equal(svc.pinned.by, 'hash'); assert.equal(svc.pinned.maxLag, 400); assert.equal(svc.pinned.lag, 2)
    // TAP-10 §5.3: every state read of this resolution at the one pinned block, by its hash / 本次解析的每个状态读取都在同一钉块（按哈希）
    const reads = chain.conform.log.slice(from).filter((x) => x.block !== null)
    assert.ok(reads.length >= 6)
    for (const r of reads) assert.deepEqual(r.block, { blockHash: svc.pinned.hash, requireCanonical: true }, `${r.method} ${r.fn}`)
  }
  // the container came from the opener; the hub's accountOf was never asked (the fake hub answers the zero address)
  // 容器来自开通器；hub 的 accountOf 从未被问到（假 hub 答零地址）
  const accountOf = chain.conform.log.filter((x) => x.fn === 'accountOf')
  assert.ok(accountOf.length > 0 && accountOf.every((x) => x.to === CHAINS[56].opener.toLowerCase()))
  for (const fn of ['cpuCount', 'cpuAt', 'isOpened', 'isLive', 'isContainerLive', 'ownerOf', 'fileInfo', 'read']) assert.ok(fnsOf(chain).includes(fn), fn)
  assert.ok(chain.conform.log.some((x) => x.method === 'eth_chainId'))
})

test('input errors: INVALID_ARGUMENT with data.status input-error, before any request; labels are not an input form', async () => {
  const { chain } = world()
  const api = conformApi(chain, { directory: ADDR.directory })
  for (const s of ['4246', 'label', 'golden', '04246.7', '0.7.tape', '1.0.5', '1.1.5', '1.4.5', '4246.7.', '#4246@7.', '1000000000000000001.7', `${ADDR.circuits}#0`, `${ADDR.circuits}#04246`, '', 42, null, { tokenId: 1 }]) {
    await assert.rejects(api.resolve(s), isStatus('INVALID_ARGUMENT', 'input-error'), JSON.stringify(s))
    await assert.rejects(api.siteStatus(s), isStatus('INVALID_ARGUMENT', 'input-error'), JSON.stringify(s))
  }
  assert.equal(chain.conform.log.length, 0, 'nothing was sent')
  assert.deepEqual(parseTapeInput('#1@3.1'), { kind: 'name', tokenId: '1', processor: '1', area: 3, chainId: 8453, name: '1.3.1.tape' })
})

test('identity outcomes: no-such-cpu, no-such-token and not-tapeout are NOT_FOUND with their TAP-10 names, told apart from no-manifest', async () => {
  const { chain, c } = world()
  const api = conformApi(chain)
  await assert.rejects(api.resolve('4246.8'), isStatus('NOT_FOUND', 'no-such-cpu', /^no-such-cpu: processor 8 does not exist/))
  await assert.rejects(api.resolve('999999999.7'), isStatus('NOT_FOUND', 'no-such-token'))
  // an address with no code here may be a container elsewhere (1.4: unsupported); a contract that claims to be a container
  // of this chain and is not one is not-tapeout / 本链无代码的地址可能是别处的容器（1.4：unsupported）；声称是本链容器却不是的合约为 not-tapeout
  await assert.rejects(api.resolve('0x000000000000000000000000000000000000dEaD'), isStatus('INVALID_ARGUMENT', 'unsupported'))
  const liar = '0x' + 'c2'.repeat(20)
  chain.setContainerToken(liar, { circuits: c.circuits, tokenId: 4246, chainId: 56 })
  await assert.rejects(api.resolve(liar), isStatus('NOT_FOUND', 'not-tapeout'))
  const fakeCpu = '0x' + 'fa'.repeat(20)
  chain.setContainerToken('0x' + 'c3'.repeat(20), { circuits: fakeCpu, tokenId: 1, chainId: 56 })
  chain.setCounterfeit(fakeCpu)
  await assert.rejects(api.resolve('0x' + 'c3'.repeat(20)), isStatus('NOT_FOUND', 'not-tapeout'))
  // control: the token exists and is activated but has no manifest / 对照：token 存在且已激活，但没有清单
  chain.circuit(5, { holder })
  await assert.rejects(api.resolve('5.7'), isStatus('MANIFEST_INVALID', 'no-manifest', /^no-manifest: .*chunkCount = 0/))
})

test('site status in the order of TAP-10 §6.2: store-changed first (fail-closed, sentinel off too), then identity, not-opened, unpaid', async () => {
  const { chain, c } = world()
  const api = conformApi(chain, { sentinel: 'off' })
  chain.setImplementation(CHAINS[56].siteRegistry, '0x' + 'ab'.repeat(20))
  await assert.rejects(api.resolve('4246.7'), isStatus('CONTRACT_UNKNOWN', 'store-changed', /siteRegistry .* runs implementation 0xabab/))
  await assert.rejects(api.resolve('4246.8'), isStatus('CONTRACT_UNKNOWN', 'store-changed'), 'before no-such-cpu')
  chain.setImplementation(CHAINS[56].siteRegistry, CHAINS[56].expectedImpl[CHAINS[56].siteRegistry.toLowerCase()][0])
  chain.setImplementation(CHAINS[56].binding, '0x' + 'cd'.repeat(20))
  await assert.rejects(api.resolve('4246.7'), isStatus('CONTRACT_UNKNOWN', 'store-changed', /binding/))
  chain.setImplementation(CHAINS[56].binding, CHAINS[56].expectedImpl[CHAINS[56].binding.toLowerCase()][0])
  chain.setOpened(c.circuits, 4246, false)
  chain.setUnactivated()
  await assert.rejects(api.resolve('4246.7'), isStatus('SITE_STATUS', 'not-opened'), 'before unpaid')
  chain.setOpened(c.circuits, 4246, true)
  await assert.rejects(api.resolve('4246.7'), (e) => isStatus('SITE_STATUS', 'unpaid', /isLive and isContainerLive are both false/)(e)
    && e.data.container === c.container && e.data.holder === holder && e.data.activation.live === false)
  // either payment activates: the name for this container, or the container / 两种付款任一都能激活
  chain.setLiveName('4246.7.tape', c.container)
  assert.equal((await api.resolve('4246.7')).conform.activation.isLive, true)
  chain.setLiveName('4246.7.tape', c.container, false)
  chain.setLiveName('4246.7.tape', '0x' + '99'.repeat(20))     // someone paid for the name with another container: ignored
  await assert.rejects(api.resolve('4246.7'), isStatus('SITE_STATUS', 'unpaid'))
  chain.setContainerLive(c.container, true)
  assert.equal((await api.resolve('4246.7')).conform.activation.isContainerLive, true)
})

test('TAP-10 §6.3: on the previous DomainBinding (0x4E86…, still accepted) isContainerLive reverts and counts as false', async () => {
  const { chain, c } = world()
  chain.useLegacyBinding()
  const api = conformApi(chain)
  await assert.rejects(api.resolve('4246.7.tape'), (e) => isStatus('SITE_STATUS', 'unpaid')(e) && e.data.activation.isContainerLiveReverted === true
    && e.data.implementations.find((x) => x.role === 'binding').implementation === LEGACY_BINDING)
  chain.setLiveName('4246.7.tape', c.container)
  const svc = await api.resolve('4246.7.tape')
  assert.deepEqual(svc.conform.activation, { live: true, isLive: true, isContainerLive: false, isContainerLiveReverted: true })
})

test('1.5: a container address or processor contract#ID finds its processor number (TAP-10 §4.3 step 3), so isLive is asked and unpaid is a verdict', async () => {
  const { chain, c } = world()
  // paid for the name only: 1.4 could not ask isLive without the name and said unsupported; 1.5 finds processor 7
  // 只按名字付费：1.4 没有名字无法查询 isLive，报 unsupported；1.5 能找到 7 号处理器
  chain.setUnactivated(); chain.setLiveName('4246.7.tape', c.container)
  for (const input of [c.container, { circuits: c.circuits, tokenId: 4246 }, { chainId: 56, container: c.container }]) {
    const api = conformApi(chain)
    const svc = await api.resolve(input)
    assert.equal(svc.conform.name, '4246.7.tape', JSON.stringify(input)); assert.equal(svc.conform.processor, '7')
    assert.deepEqual(svc.conform.activation, { live: true, isLive: true, isContainerLive: false })
    assert.equal((await api.siteStatus(input)).status, 'ok')
  }
  chain.setLiveName('4246.7.tape', c.container, false)
  await assert.rejects(conformApi(chain).resolve(c.container), isStatus('SITE_STATUS', 'unpaid', /isLive and isContainerLive are both false/))
  chain.setContainerLive(null, 'revert')
  await assert.rejects(conformApi(chain).resolve(c.container), (e) => isStatus('SITE_STATUS', 'unpaid')(e) && e.data.activation.isContainerLiveReverted === true)
  // a TapeOut processor (isCPU) that is not in the factory's list is not-tapeout (§4.3 step 3) / 是处理器却不在工厂列表里即 not-tapeout
  const stray = '0x' + 'e7'.repeat(20)
  chain.setContainerToken('0x' + 'c4'.repeat(20), { circuits: stray, tokenId: 1, chainId: 56 })
  await assert.rejects(conformApi(chain).resolve('0x' + 'c4'.repeat(20)), isStatus('NOT_FOUND', 'not-tapeout'))
  assert.equal((await conformApi(chain).siteStatus({ circuits: stray, tokenId: 1 })).status, 'not-tapeout')
})

test('TAP-10 §4.1 without allChains: input that may belong to another chain is unsupported (never not-tapeout), a processor contract#ID string before any request', async () => {
  const { chain, c } = world()
  const api = conformApi(chain)
  const baseContainer = '0x4591b393399452eA24ECB10424CdBA194F1c4E64'           // a Base container: no code on this chain
  await assert.rejects(api.resolve(baseContainer), isStatus('INVALID_ARGUMENT', 'unsupported', /does not answer ERC-6551 token\(\) here on chain 56; it may be one on another chain.*allChains: true/))
  await assert.rejects(api.siteStatus(baseContainer), isStatus('INVALID_ARGUMENT', 'unsupported'))
  const other = '0x' + 'c1'.repeat(20)
  chain.setContainerToken(other, { circuits: c.circuits, tokenId: 4246, chainId: 8453 })
  await assert.rejects(api.resolve(other), isStatus('INVALID_ARGUMENT', 'unsupported', /answers token\(\) for chain 8453/))
  // a processor contract#ID string: TAP-10 resolves it only when exactly one chain does, which one chain cannot tell
  // "处理器合约#ID"字符串：TAP-10 只在恰好一条链命中时才解析，只读一条链无从得知
  const from = chain.conform.log.length
  for (const pair of [`${c.circuits}#4246`, '0x0565EA48CA41Ae559d8d491dbb0a9ec945DB551b#1']) {
    await assert.rejects(api.resolve(pair), isStatus('INVALID_ARGUMENT', 'unsupported', /resolves only when exactly one active chain resolves it.*allChains: true/))
    await assert.rejects(api.siteStatus(pair), isStatus('INVALID_ARGUMENT', 'unsupported'))
  }
  assert.equal(chain.conform.log.length, from, 'refused before any request')
  // a contract that claims THIS chain and fails a check is not-tapeout; an object form names its chain, so its verdict is
  // that chain's / 声称本链却通不过检查的合约是 not-tapeout；对象形式指明了链，结论就是那条链的
  const liar = '0x' + 'c2'.repeat(20)
  chain.setContainerToken(liar, { circuits: c.circuits, tokenId: 4246, chainId: 56 })
  await assert.rejects(api.resolve(liar), isStatus('NOT_FOUND', 'not-tapeout'))
  await assert.rejects(api.resolve({ chainId: 56, container: baseContainer }), isStatus('NOT_FOUND', 'not-tapeout'))
  const l2Processor = '0x0565EA48CA41Ae559d8d491dbb0a9ec945DB551b'
  chain.setCounterfeit(l2Processor)
  await assert.rejects(api.resolve({ circuits: l2Processor, tokenId: 1 }), isStatus('NOT_FOUND', 'not-tapeout'))
})

// ── pinned block / 钉块 ─────────────────────────────────────────────────────────────────────────────────────────────
test('TAP-10 §5.3: Q-th highest operator head minus 2, each operator at its lowest head; stale-block by block lag, no clock', async () => {
  const { chain } = world()
  const head = chain.state.block
  const rpc = (urls) => createRpc({ urls, quorum: 2, fetch: chain.fetch, quiet: true })
  chain.setHeadLag('http://rpc2', 5); chain.setHeadLag('http://rpc3', 9)
  let b = await rpc(RPC).tap10Block({ maxLag: 400 })
  assert.equal(b.number, head - 5 - 2); assert.equal(b.lag, 7); assert.equal(b.tag, 'tap10')
  assert.deepEqual(b.heads, { rpc1: head, rpc2: head - 5, rpc3: head - 9 })
  assert.equal(b.hash, chain.blockHash(head - 7))
  // two URLs of one operator count once, at the lower head / 同一运营方的两个 URL 只计一次，取较低的头块
  chain.setHeadLag('http://rpc1/b', 30)
  b = await rpc(['http://rpc1/a', 'http://rpc1/b', 'http://rpc2']).tap10Block({ maxLag: 400 })
  assert.deepEqual(b.heads, { rpc1: head - 30, rpc2: head - 5 }); assert.equal(b.number, head - 30 - 2); assert.equal(b.lag, 27)
  // one operator far ahead: the pin lag is measured against it / 一家运营方远远领先：滞后按它计算
  chain.setHeadLag('http://rpc2', 500); chain.setHeadLag('http://rpc3', 500)
  await assert.rejects(rpc(RPC).tap10Block({ maxLag: 400 }), isStatus('RPC_STALE', 'stale-block', /502 blocks behind/))
  const api = conformApi(chain, { clock: () => T - 300 * 86_400 })   // a clock 300 days off changes nothing / 时钟错 300 天也无关
  await assert.rejects(api.resolve('4246.7'), isStatus('RPC_STALE', 'stale-block'))
  chain.setHeadLag('http://rpc2', 0); chain.setHeadLag('http://rpc3', 0)
  assert.equal((await api.resolve('4246.7')).pinned.lag, 2)
})

test('the TAP-10 pin is not rpc.blockNumber(): heads 120 blocks apart are refused there (maxHeadSpread 64) and fine on Base (max lag 150)', async () => {
  const { chain, c } = world({ chainId: 8453 })
  chain.setHeadLag('http://rpc2', 120)
  const r = createRpc({ urls: RPC, quorum: 2, fetch: chain.fetch, quiet: true })
  await assert.rejects(r.blockNumber(), (e) => e.code === 'RPC_DISAGREE')
  const b = await r.tap10Block({ maxLag: CHAINS[8453].tap10MaxPinLag })
  assert.equal(b.lag, 2)        // Q = 2 of 3 operators: rpc1 and rpc3 at head / 3 家中 Q = 2：rpc1 与 rpc3 在头块
  chain.setHeadLag('http://rpc2', 160); chain.setHeadLag('http://rpc3', 160)
  await assert.rejects(r.tap10Block({ maxLag: 150 }), isStatus('RPC_STALE', 'stale-block', /162 blocks behind/))
  chain.setHeadLag('http://rpc2', 120); chain.setHeadLag('http://rpc3', 0)
  const svc = await createTapeAPI({ conform: 'tap10', chainId: 8453, rpcUrls: ['http://rpc1', 'http://rpc2'], fetch: chain.fetch, clock: () => T, quiet: true, onWarning: () => {} }).resolve('4246.3.7')
  assert.equal(svc.container, c.container); assert.equal(svc.pinned.lag, 122); assert.equal(svc.pinned.maxLag, 150)
})

test('a head that has not arrived within the grace period after Q operators answered is not waited for', async () => {
  const { chain } = world()
  // rpc3 answers eth_blockNumber after 3 s, everything else at once / rpc3 的 eth_blockNumber 3 秒后才答，其余立即作答
  const fetch = async (url, init) => {
    if (url === 'http://rpc3' && JSON.parse(init.body).method === 'eth_blockNumber') await new Promise((r) => setTimeout(r, 3000))
    return chain.fetch(url, init)
  }
  const t0 = Date.now()
  const b = await createRpc({ urls: RPC, quorum: 2, fetch, quiet: true }).tap10Block({ maxLag: 400, graceMs: 200 })
  assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`)
  assert.deepEqual(Object.keys(b.heads).sort(), ['rpc1', 'rpc2'])
})

// ── chain check and answers / 链检查与回答 ─────────────────────────────────────────────────────────────────────────
test('TAP-10 §5.4: one eth_chainId per client before any adopted read (siteStatus by default agreement, resolve strict); wrong-chain is INVALID_ARGUMENT', async () => {
  const { chain, c } = world()
  for (const u of RPC) chain.setChainIdAnswer(u, 97)
  const api = conformApi(chain)
  await assert.rejects(api.resolve('4246.7'), isStatus('INVALID_ARGUMENT', 'wrong-chain', /answer eth_chainId 97, not 56/))
  await assert.rejects(api.siteStatus('4246.7'), isStatus('INVALID_ARGUMENT', 'wrong-chain'))
  assert.equal(fnsOf(chain).length, 0, 'no eth_call was adopted')
  // one node on another chain: a disagreement, refused (never a majority) / 一个节点在别的链上：分歧，拒绝（绝不按多数）
  chain.setChainIdAnswer('http://rpc3', 97); chain.setChainIdAnswer('http://rpc1', null); chain.setChainIdAnswer('http://rpc2', null)
  await assert.rejects(api.resolve('4246.7'), isStatus('RPC_DISAGREE', 'unavailable', /eth_chainId/))
  await assert.rejects(api.siteStatus('4246.7'), isStatus('RPC_DISAGREE', 'unavailable', /eth_chainId/))
  assert.equal(fnsOf(chain).length, 0, 'still no eth_call adopted')
  // rpc3 down: siteStatus's chain check is by default agreement (1.4 design decision), so it goes on; resolve's is strict
  // since 1.5.0, as the messaging path's (Fable review, finding 3), so it stops before any state is read
  // rpc3 宕机：siteStatus 的链检查用默认共识，照常；resolve 的链检查 1.5.0 起与消息路径一样用严格共识，在读任何状态之前就停下
  chain.setChainIdAnswer('http://rpc3', null)
  chain.setFault('http://rpc3', 'http500')
  assert.equal((await api.siteStatus('4246.7')).container, c.container)
  const before = chain.conform.log.length
  await assert.rejects(api.resolve('4246.7'), isStatus('RPC_UNAVAILABLE', 'unavailable', /eth_chainId: only 2\/3 nodes answered .*strict agreement \(TAP-10 §5.2\).* = 3 operators/))
  assert.ok(!chain.conform.log.slice(before).some((x) => x.method === 'eth_call' || x.method === 'eth_getStorageAt'), 'no state read before the strict chain check')
  chain.setFault('http://rpc3', null)
  // each check once per client: the strict one now succeeds, then neither is sent again / 两种检查各自每个客户端一次
  await api.resolve('4246.7')
  const n = chain.conform.log.filter((x) => x.method === 'eth_chainId').length
  await api.resolve('4246.7'); await api.siteStatus('4246.7'); await api.chain.tapeSendKey(c.container).catch(() => {})
  assert.equal(chain.conform.log.filter((x) => x.method === 'eth_chainId').length, n, 'checked once per client')
})

test('TAP-10 §1: only a result or a revert is an answer; another JSON-RPC error is a node failure, not a disagreement', async () => {
  const { chain, c } = world()
  const urls = [...RPC, 'http://rpc4']
  chain.setFault('http://rpc4', 'rpcerror')
  // the default mode counts "node says no" (-32000) as an answer and refuses the read / 默认模式把它当回答并拒绝该读取
  await assert.rejects(createTapeAPI({ rpcUrls: urls, fetch: chain.fetch, quiet: true, clock: () => T }).resolve('4246.7'), (e) => e.code === 'RPC_DISAGREE')
  const svc = await conformApi(chain, { rpcUrls: urls }).resolve('4246.7')
  assert.equal(svc.container, c.container)
})

// ── caching / 缓存 ─────────────────────────────────────────────────────────────────────────────────────────────────
test('across resolutions only the processor table is kept: the holder, opened, activation and implementations are read again at a new pin', async () => {
  const { chain, c } = world()
  const api = conformApi(chain)
  await api.resolve('4246.7')
  const from = chain.conform.log.length
  chain.mine(3)
  const again = await api.resolve('4246.7')
  const fns = chain.conform.log.slice(from).filter((x) => x.fn).map((x) => x.fn)
  for (const fn of ['accountOf', 'ownerOf', 'isOpened', 'isLive', 'isContainerLive', 'fileInfo', 'read']) assert.ok(fns.includes(fn), fn)
  assert.ok(!fns.includes('cpuCount') && !fns.includes('cpuAt'), 'the processor table is kept (TAP-10 §4.3)')
  assert.equal(chain.conform.log.slice(from).filter((x) => x.method === 'eth_getStorageAt').length, 3 * 3, 'SiteRegistry, DomainBinding and hub slots on each node')
  assert.equal(again.pinned.number, chain.state.block - 2)
  chain.setUnactivated()
  await assert.rejects(api.resolve('4246.7'), isStatus('SITE_STATUS', 'unpaid'), 'no 300-second cache in between')
  chain.setContainerLive(null, true)
  chain.setOwner(4246, '0x' + '98'.repeat(20))
  await assert.rejects(api.resolve('4246.7'), isStatus('DELEGATION_INVALID', 'delegation-invalid'))
  void c
})

test('call(): a kept service is reread after 60 s, and a verdict (unpaid) ends it instead of being served from the cache', async () => {
  const { chain } = world()
  let t = T
  let provider = 0
  const fetch = async (url, init) => (String(url).startsWith('http://rpc') ? chain.fetch(url, init) : (provider++, new Response('{}', { status: 500 })))
  const api = createTapeAPI({ conform: 'tap10', rpcUrls: RPC, fetch, clock: () => t, quiet: true, onWarning: () => {} })
  const svc = await api.resolve('4246.7')
  t += 61
  chain.setUnactivated()
  await assert.rejects(api.call(svc, 'ping', {}), isStatus('SITE_STATUS', 'unpaid'))
  assert.equal(provider, 0, 'the provider was not called')
  // a transient failure still falls back to the kept manifest (the existing back-off) / 暂时性故障仍沿用缓存
  chain.setContainerLive(null, true)
  for (const u of RPC) chain.setFault(u, 'http500')
  t += 61
  await assert.rejects(api.call(svc, 'ping', {}), (e) => e.code !== 'SITE_STATUS')
  assert.equal(provider, 1, 'served from the kept manifest')
})

// ── the manifest (TAP-11 §2.2 steps 3-6) / 清单 ──────────────────────────────────────────────────────────────────
test('the manifest: chunkCount 0 is no-manifest, no-hash, incomplete, a byte order mark and invalid UTF-8 are refused, another identity is manifest-invalid', async () => {
  const cases = [
    ['chunkCount 0 with a size', (w) => w.chain.setFileInfo(w.c.container, MANIFEST_KEY, { chunkCount: 0 }), 'MANIFEST_INVALID', 'no-manifest'],
    ['zero hash', (w) => w.chain.setFileInfo(w.c.container, MANIFEST_KEY, { sha256Hash: '0x' + '00'.repeat(32) }), 'MANIFEST_INVALID', 'no-hash'],
    ['size mismatch', (w) => w.chain.setFileInfo(w.c.container, MANIFEST_KEY, { size: 10 }), 'MANIFEST_INVALID', 'incomplete'],
    ['bytes changed', (w) => w.chain.setFileBytes(w.c.container, MANIFEST_KEY, '{"x":1}'.padEnd(Number(w.chain.state.files.get(`${w.c.container.toLowerCase()}:${MANIFEST_KEY}`).info.size), ' ')), 'MANIFEST_INVALID', 'incomplete'],
    ['byte order mark', (w) => w.chain.writeFile(w.c.container, MANIFEST_KEY, Uint8Array.from([0xef, 0xbb, 0xbf, ...Buffer.from(JSON.stringify(manifestOf(w.c)))])), 'MANIFEST_INVALID', 'manifest-invalid'],
    ['invalid UTF-8', (w) => w.chain.writeFile(w.c.container, MANIFEST_KEY, Uint8Array.from([...Buffer.from(JSON.stringify(manifestOf(w.c, 56, { name: 'ab' }))).map((x, i, a) => (a[i - 1] === 0x61 && x === 0x62 ? 0xc3 : x))])), 'MANIFEST_INVALID', 'manifest-invalid'],
    ['another container', (w) => w.chain.writeFile(w.c.container, MANIFEST_KEY, JSON.stringify(manifestOf({ ...w.c, container: '0x' + '61'.repeat(20) }))), 'MANIFEST_INVALID', 'manifest-invalid'],
    ['another #ID', (w) => w.chain.writeFile(w.c.container, MANIFEST_KEY, JSON.stringify(manifestOf({ ...w.c, tokenId: '4247' }))), 'MANIFEST_INVALID', 'manifest-invalid'],
    ['delegation by someone else', (w) => w.chain.writeFile(w.c.container, MANIFEST_KEY, JSON.stringify(manifestOf(w.c, 56, { key: OTHER_KEY }))), 'DELEGATION_INVALID', 'delegation-invalid'],
    ['not a manifest', (w) => w.chain.writeFile(w.c.container, MANIFEST_KEY, '{"tapeapi":"0.1"}'), 'MANIFEST_INVALID', 'manifest-invalid'],
  ]
  for (const [what, mutate, code, status] of cases) {
    const w = world()
    mutate(w)
    await assert.rejects(conformApi(w.chain).resolve('4246.7'), isStatus(code, status), what)
  }
  // the default mode decodes leniently and drops a byte order mark (TAP-11 Backwards Compatibility) / 默认模式宽松解码
  const w = world()
  w.chain.writeFile(w.c.container, MANIFEST_KEY, Uint8Array.from([0xef, 0xbb, 0xbf, ...Buffer.from(JSON.stringify(manifestOf(w.c)))]))
  w.chain.setAccount(4246, w.c.container)
  const svc = await createTapeAPI({ rpcUrls: RPC, fetch: w.chain.fetch, quiet: true, clock: () => T, sentinel: 'off' }).resolve('4246.7')
  assert.equal(svc.container, w.c.container)
})

// ── what the conformance mode does not gate: messaging (TAP-10 §12.2) / 一致模式不限制消息 ─────────────────────────
test('activation is a site rule only: an unactivated container is unpaid to resolve and siteStatus, while its channel record and TapeSend key read as before', async () => {
  const { chain, c } = world()
  chain.setUnactivated()
  chain.setAccount(4246, c.container)   // the hub's derivation (the messaging reads use the opener since 1.5) / hub 推导（1.5 起消息读取用开通器）
  const id = channel.generateIdentity()
  const hex = (b) => '0x' + Buffer.from(b).toString('hex')
  const keys = { container: c.container, x25519: hex(id.x25519.publicKey), ed25519: hex(id.ed25519.publicKey), inbox: {}, issued: T - 60, expires: T + 86_400 }
  chain.writeFile(c.container, CHANNEL_KEYS_KEY, canonicalJSON({ tapechannel: '1', chainId: 56, ...keys, sig: sig.signDigest(sig.channelKeysDigest(56, MAINNET.hub, keys), HOLDER_KEY) }))
  chain.setTapeSendKey(c.container, { circuits: c.circuits, tokenId: 4246, key: '0x' + '5a'.repeat(32), holder })
  const api = conformApi(chain)
  await assert.rejects(api.resolve('4246.7.tape'), isStatus('SITE_STATUS', 'unpaid'))
  assert.equal((await api.siteStatus('4246.7.tape')).status, 'unpaid')
  const k = await api.chain.channelKeys(c.container)
  assert.equal(k.x25519, hex(id.x25519.publicKey)); assert.equal(k.holder, holder)
  const t = await api.chain.tapeSendKey(c.container)
  assert.equal(t.staticPublic, '0x' + '5a'.repeat(32))
  // the same with a not-opened container / 未开通的容器也一样
  chain.setOpened(c.circuits, 4246, false)
  await assert.rejects(api.resolve('4246.7.tape'), isStatus('SITE_STATUS', 'not-opened'))
  assert.equal((await api.chain.channelKeys(c.container, { fresh: true })).holder, holder)
})

// ── siteStatus in any mode / 任何模式下的 siteStatus ─────────────────────────────────────────────────────────────────
test('api.siteStatus works on a default client too, returns every site status without throwing, and reads no manifest', async () => {
  const { chain, c } = world({ manifest: false })
  const api = createTapeAPI({ rpcUrls: RPC, fetch: chain.fetch, quiet: true, clock: () => T })
  let s = await api.siteStatus('#4246@7')
  assert.equal(s.status, 'ok'); assert.equal(s.container, c.container); assert.equal(s.name, '4246.7.tape'); assert.equal(s.pinned.maxLag, 400)
  assert.ok(!fnsOf(chain).includes('fileInfo'))
  assert.equal((await api.siteStatus('4246.8')).status, 'no-such-cpu')
  assert.equal((await api.siteStatus('9.7')).status, 'no-such-token')
  await assert.rejects(api.siteStatus('0x000000000000000000000000000000000000dEaD'), isStatus('INVALID_ARGUMENT', 'unsupported'))
  chain.setUnactivated()
  s = await api.siteStatus('4246.7')
  assert.equal(s.status, 'unpaid'); assert.deepEqual(s.activation, { live: false, isLive: false, isContainerLive: false })
  chain.setImplementation(CHAINS[56].binding, '0x' + 'cd'.repeat(20))
  assert.equal((await api.siteStatus('4246.7')).status, 'store-changed')
  await assert.rejects(api.siteStatus('4246'), isStatus('INVALID_ARGUMENT', 'input-error'))
  // the default resolve is unchanged on the same client: no TAP-10 reads / 同一客户端的默认 resolve 不变：没有 TAP-10 读取
  chain.writeFile(c.container, MANIFEST_KEY, JSON.stringify(manifestOf(c))); chain.setAccount(4246, c.container)
  const from = chain.conform.log.length
  const svc = await api.resolve('4246.7')
  assert.equal(svc.conform, undefined)
  const fns = chain.conform.log.slice(from).map((x) => x.fn)
  for (const fn of ['cpuCount', 'isOpened', 'isLive', 'isContainerLive']) assert.ok(!fns.includes(fn), fn)
})

// ── other chains / 其它链 ─────────────────────────────────────────────────────────────────────────────────────────
test('forChain passes the conformance mode on: Base and X Layer sub-clients read the TAP-10 way with their own contracts', async () => {
  const worlds = { 56: world(), 196: world({ chainId: 196 }), 8453: world({ chainId: 8453 }) }
  const fetch = (url, init) => worlds[Number(/^http:\/\/rpc(\d+)-/.exec(url)[1])].chain.fetch(url, init)
  const urls = (id) => [`http://rpc${id}-a`, `http://rpc${id}-b`]
  const api = createTapeAPI({ conform: 'tap10', rpcUrls: urls(56), fetch, clock: () => T, quiet: true, onWarning: () => {}, chains: { 196: { rpcUrls: urls(196) }, 8453: { rpcUrls: urls(8453) } } })
  for (const [id, name, label] of [[8453, '4246.3.7.tape', '#4246@3.7'], [196, '4246.2.7.tape', 'tape://4246.2.7/']]) {
    const w = worlds[id]
    const svc = await api.resolve(label)
    assert.equal(svc.chainId, id); assert.equal(svc.container, w.c.container); assert.equal(svc.conform.name, name)
    assert.equal(svc.pinned.maxLag, CHAINS[id].tap10MaxPinLag)
    const log = w.chain.conform.log
    for (const fn of ['cpuCount', 'isOpened', 'isLive', 'isContainerLive']) assert.ok(log.some((x) => x.fn === fn), `${id} ${fn}`)
    for (const x of log.filter((y) => y.fn === 'isOpened' || y.fn === 'accountOf')) assert.equal(x.to, CHAINS[id].opener.toLowerCase())
    for (const x of log.filter((y) => y.fn === 'isLive')) assert.equal(x.to, CHAINS[id].binding.toLowerCase())
    w.chain.setUnactivated()
    await assert.rejects(api.resolve(name), isStatus('SITE_STATUS', 'unpaid'))
    assert.equal((await api.forChain(id).siteStatus(name)).status, 'unpaid')
  }
  assert.equal(worlds[56].chain.conform.log.length, 0, 'nothing was read on BNB Smart Chain')
  // a sub-client given another pin is refused, as the parent would be / 子客户端被给了别的钉块选项同样被拒
  const bad = createTapeAPI({ conform: 'tap10', rpcUrls: urls(56), fetch, quiet: true, chains: { 8453: { rpcUrls: urls(8453), pin: true } } })
  await assert.rejects(bad.resolve('4246.3.7'), isStatus('INVALID_ARGUMENT', 'input-error', /cannot be combined/))
})

// ── pin: 'tap10' alone, proofs, sentinel / 单独的 pin: 'tap10'、证明、哨兵 ─────────────────────────────────────────────
test("pin: 'tap10' alone: the default resolution at a TAP-10 pinned block (no site status, no data.status)", async () => {
  const { chain, c } = world()
  chain.setAccount(4246, c.container)
  chain.setUnactivated()
  const api = createTapeAPI({ pin: 'tap10', rpcUrls: RPC, fetch: chain.fetch, quiet: true, clock: () => T - 300 * 86_400, onWarning: () => {} })
  const svc = await api.resolve('4246.7')
  assert.deepEqual({ ...svc.pinned, hash: undefined, timestamp: undefined }, { number: chain.state.block - 2, hash: undefined, timestamp: undefined, tag: 'tap10', by: 'hash', mode: 'tap10', lag: 2, maxLag: 400 })
  assert.equal(svc.conform, undefined)
  assert.ok(!fnsOf(chain).includes('isLive'))
  for (const r of chain.conform.log.filter((x) => x.block !== null)) assert.deepEqual(r.block, { blockHash: svc.pinned.hash, requireCanonical: true })
})

test('proofs stack on the conformance mode and use its pinned block (design row 22)', async () => {
  const { chain } = world()
  const svc = await conformApi(chain, { proofs: true }).resolve('4246.7')
  assert.equal(svc.proofs.block, svc.pinned.number)
  assert.equal(svc.proofs.mode, 'warn')
  assert.ok(svc.warnings.some((w) => w.code === 'PROOF_UNAVAILABLE'))
  await assert.rejects(conformApi(chain, { proofs: 'strict' }).resolve('4246.7'), isStatus('PROOF_UNAVAILABLE', 'unavailable'))
})

test('the sentinel keeps the hub and the local ERC-6551 check of the opener\'s derivation; SiteRegistry and DomainBinding belong to the TAP-10 check', async () => {
  const { chain, c } = world()
  let svc = await conformApi(chain).resolve('4246.7')
  assert.deepEqual(svc.sentinel.implementations.map((x) => x.role), ['hub'])
  assert.equal(svc.sentinel.container, 'match')
  chain.setImplementation(MAINNET.hub, '0x' + 'ee'.repeat(20))
  svc = await conformApi(chain).resolve('4246.7')
  assert.deepEqual(svc.warnings.map((w) => w.code), ['IMPL_UNKNOWN'])
  await assert.rejects(conformApi(chain, { sentinel: 'strict' }).resolve('4246.7'), isStatus('CONTRACT_UNKNOWN', 'hub-changed'))
  chain.setImplementation(MAINNET.hub, CHAINS[56].expectedImpl[MAINNET.hub.toLowerCase()][0])
  // an opener that derives another address than ERC-6551 / 开通器推导出与 ERC-6551 不同的地址
  const moved = '0x' + '6b'.repeat(20)
  chain.setOpenerAccount(c.circuits, 4246, moved)
  chain.writeFile(moved, MANIFEST_KEY, JSON.stringify(manifestOf({ ...c, container: moved })))
  svc = await conformApi(chain).resolve('4246.7')
  assert.equal(svc.sentinel.container, 'mismatch'); assert.deepEqual(svc.warnings.map((w) => w.code), ['CONTAINER_MISMATCH'])
  await assert.rejects(conformApi(chain, { sentinel: 'strict' }).resolve('4246.7'), isStatus('MANIFEST_INVALID', 'container-mismatch'))
})

test('every error of the conformance mode carries data.status; an outage is unavailable', async () => {
  const { chain } = world()
  for (const u of RPC) chain.setFault(u, 'http500')
  await assert.rejects(conformApi(chain).resolve('4246.7'), isStatus('RPC_UNAVAILABLE', 'unavailable'))
  await assert.rejects(conformApi(chain).siteStatus('4246.7'), isStatus('RPC_UNAVAILABLE', 'unavailable'))
  // the default mode's errors carry no data.status (GOLDEN TAP10-0 pins them all) / 默认模式的错误不带 data.status
  const f = createFakeChain()
  await assert.rejects(createTapeAPI({ rpcUrls: RPC, fetch: f.fetch, quiet: true }).resolve('4246.8'), (e) => e.code === 'NOT_FOUND' && e.data === undefined)
})

test('FIXED review-2: a contract whose token() names an out-of-range #ID is not-tapeout, a TapeAPIError, never a bare RangeError', async () => {
  const { chain, c } = world()
  const api = conformApi(chain)
  await api.resolve('4246.7')   // processor 7 is now in the kept table, so a name would be formatted / 7 号处理器已在表中，会去格式化名字
  for (const [i, tokenId] of [[1, 10n ** 19n], [2, 0n], [3, 2n ** 256n - 1n]]) {
    const liar = '0x' + `d${i}`.repeat(20)
    chain.setContainerToken(liar, { circuits: c.circuits, tokenId, chainId: 56 })
    await assert.rejects(api.resolve(liar), (e) => !(e instanceof RangeError) && isStatus('NOT_FOUND', 'not-tapeout')(e))
    assert.equal((await api.siteStatus(liar)).status, 'not-tapeout')
  }
  // { circuits, tokenId } out of range is an input error / 超出范围的 { circuits, tokenId } 是输入错误
  for (const tokenId of [0, 10n ** 18n + 1n, '1' + '0'.repeat(30)]) await assert.rejects(api.siteStatus({ circuits: c.circuits, tokenId }), isStatus('INVALID_ARGUMENT', 'input-error'))
})

test('FIXED review (regression): conform: undefined, null and false are the default mode, as 1.3 ignored them; a sub-client too', async () => {
  const { chain, c } = world()
  chain.setAccount(4246, c.container)
  chain.setUnactivated()   // the default mode does not check activation / 默认模式不查激活
  for (const conform of [undefined, null, false]) {
    const api = createTapeAPI({ conform, rpcUrls: RPC, fetch: chain.fetch, quiet: true, clock: () => T, onWarning: () => {} })
    const svc = await api.resolve('4246.7')
    assert.equal(svc.conform, undefined, String(conform)); assert.equal(svc.pinned, undefined)
    await assert.rejects(api.resolve('#4246@7'), (e) => e.code === 'MANIFEST_INVALID' && e.data === undefined)
    // pin options that conform: 'tap10' refuses stay fine / conform: 'tap10' 拒绝的钉块选项照常可用
    assert.doesNotThrow(() => createTapeAPI({ conform, pin: false, rpcUrls: RPC, fetch: chain.fetch, quiet: true }))
    assert.doesNotThrow(() => createTapeAPI({ conform, pin: true, rpcUrls: RPC, fetch: chain.fetch, quiet: true }).forChain(8453))
  }
})

test('isCPU in the conformance mode and siteStatus is read under the TAP-10 rule (only results and reverts are answers), at the pinned block', async () => {
  const { chain, c } = world()
  const urls = [...RPC, 'http://rpc4']
  chain.setFault('http://rpc4', 'rpcerror')   // -32000 "node says no": a node failure here, a disagreement under the default rule
  for (const api of [conformApi(chain, { rpcUrls: urls }), createTapeAPI({ rpcUrls: urls, fetch: chain.fetch, quiet: true, clock: () => T })]) {
    const s = await api.siteStatus({ circuits: c.circuits, tokenId: 4246 })
    assert.equal(s.status, 'ok'); assert.equal(s.container, c.container)
  }
  const isCPU = chain.conform.log.filter((x) => x.fn === 'isCPU')
  assert.ok(isCPU.length > 0 && isCPU.every((x) => x.block && x.block.blockHash))
})
