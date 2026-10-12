// Container agents (@experimental), PLAN-1.8-2.0 §3.1 T-a: without a `resolve` option the kit resolves the agent and the
// providers as TAP-11 §2 says (pinned block, strict reads) through the conformance mode made from its own client
// (conform-sibling.js): the same nodes, RPC client, fetch and clock, never allChains, no other chain. With `resolve` the
// caller's function is used unchanged. A client whose contracts TAP-10 does not list (the fake chain of agent.test.mjs)
// keeps its own resolve, and kit.resolution says which. Each case named T-a-xx was checked by removing the line that
// implements it (the test turns red). Offline: every RPC goes to the conform chain (helpers/conform-chain.mjs).
// 容器代理 T-a：不给 resolve 时，kit 用自己客户端建立的一致模式按 TAP-11 §2 解析代理与上游服务（钉块、严格读），节点、RPC 客户端、
// fetch 与时钟相同，绝不开 allChains、不访问别的链；给了 resolve 就原样用调用方的。合约不是 TAP-10 列出的客户端（agent.test.mjs
// 的假链）保留自己的 resolve，kit.resolution 写明是哪一种。每条 T-a-xx 都做过反向检查。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as agent from '@tapeapi/sdk/agent'
import { createTapeAPI, MANIFEST_KEY, MAINNET, CHAINS, sig } from '../src/index.js'
import { CONFORM_SIBLINGS } from '../src/conform-sibling.js'
import { createConformChain, createConformWorlds } from './helpers/conform-chain.mjs'
import { standardWorld, happyThread, providerReceipt, mandateOf, offerMsg, acceptMsg, KEYS, addrOf, NOW } from './helpers/agent-chain.mjs'

const { createAgentKit, jsonHashOf } = agent
const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32)
const holder = sig.privateKeyToAddress(HOLDER_KEY), signer = sig.privateKeyToAddress(SIGNER_KEY)
const RPC = ['http://rpc1', 'http://rpc2', 'http://rpc3']
const T = 1_790_000_000
const EXPIRES = T + 30 * 86_400
const codes = (r) => r.problems.map((p) => p.code)

function manifestOf(c, chainId = 56, holderKey = HOLDER_KEY) {
  return {
    tapeapi: '0.1', name: 'Provider', circuits: c.circuits, tokenId: c.tokenId, container: c.container, signer,
    delegation: { expires: EXPIRES, sig: sig.signDigest(sig.delegationDigest(chainId, MAINNET.hub, { container: c.container, signer, expires: EXPIRES }), holderKey) },
    endpoints: { live: ['https://api.example.com/tapeapi/v1'], async: false },
    methods: [{ name: 'read', priceBEM: '0', params: {}, returns: {} }],
  }
}
// A provider the TAP-10 way (processor 7, #4246, opened and activated by default) with a manifest, on chain `chainId`
// 一个 TAP-10 方式的上游服务（7 号处理器 #4246，默认已开通、已激活），带清单
function provide(chain, chainId = 56, tokenId = 4246) {
  chain.state.headTime = T
  const c = chain.circuit(tokenId, { holder })
  chain.writeFile(c.container, MANIFEST_KEY, JSON.stringify(manifestOf(c, chainId)))
  chain.setAccount(tokenId, c.container)   // the hub's derivation, which the default mode reads / 默认模式读取的 hub 推导
  return c
}
function world() {
  const chain = createConformChain()
  return { chain, c: provide(chain) }
}
const base = { clock: () => T, quiet: true, onWarning: () => {} }
// the kit's client: the default mode, mainnet addresses, the conform chain's nodes / kit 的客户端：默认模式
// conform: false: 1.x behaviour; 2.0 default is conform: 'tap10' (the kit's client here is the 1.x default client)
const clientOf = (chain, o = {}) => createTapeAPI({ conform: false, rpcUrls: RPC, fetch: chain.fetch, ...base, ...o })
// One receipt of the provider, in the mandate's scope and window / 上游服务的一个回执，在授权书的范围与时间窗内
function evidenceOf(c) {
  const r = providerReceipt({ container: c.container, signerKey: SIGNER_KEY, ts: T, tokenId: Number(c.tokenId) })
  const mandate = mandateOf({ scope: [{ provider: c.container, token: '0x' + '00'.repeat(20), cap: '0' }], notBefore: T - 60, expires: T + 86_400 })
  return [{ receipts: [r], receiptsHash: jsonHashOf([r]) }, { mandate }]
}
// what only a TAP-10 resolution reads: the payment contract's isContainerLive and the opener's isOpened
// 只有 TAP-10 解析才读的：付费合约的 isContainerLive 与开通器的 isOpened
const tap10Reads = (chain) => chain.conform.log.filter((x) => x.fn === 'isContainerLive' || x.fn === 'isOpened')

test('T-a-01: without resolve the kit resolves a provider as TAP-11 §2 says (the conformance mode: pinned, strict), with the same verdict as an explicit resolve on a healthy provider', async () => {
  const { chain, c } = world()
  const api = clientOf(chain)
  const kit = createAgentKit(api, { clock: () => T })
  assert.equal(kit.resolution, 'tap10')
  const r = await kit.verifyEvidence(...evidenceOf(c))
  assert.deepEqual(r.problems, [])
  assert.equal(r.receipts[0].answeredBy, true)
  // the TAP-10 reads were made, each at a pinned block (EIP-1898 object), none at 'latest' / TAP-10 读取都钉在块上
  const reads = tap10Reads(chain)
  assert.ok(reads.length >= 2, JSON.stringify(reads))
  for (const x of reads) assert.ok(x.block && typeof x.block === 'object' && /^0x[0-9a-f]{64}$/.test(x.block.blockHash), JSON.stringify(x))
  // only the client's own nodes were asked / 只问了客户端自己的节点
  assert.deepEqual([...new Set(chain.conform.log.map((x) => x.url))].sort(), RPC)

  // the same evidence with the caller's own default-mode resolve: the same verdict, but no TAP-10 read at all
  // 同样的证据、调用方自己的默认模式 resolve：结论相同，但完全没有 TAP-10 读取
  const { chain: chain2, c: c2 } = world()
  const plain = clientOf(chain2)
  const kit2 = createAgentKit(clientOf(chain2), { clock: () => T, resolve: (x) => plain.resolve(x) })
  assert.equal(kit2.resolution, 'caller')
  const r2 = await kit2.verifyEvidence(...evidenceOf(c2))
  assert.deepEqual(r2.problems, [])
  assert.equal(r2.receipts[0].answeredBy, true)
  assert.deepEqual(tap10Reads(chain2), [])
})

test('T-a-02: the result differs where TAP-10 does: a container that is not opened, or not activated, is provider-unresolvable by default and resolves with an explicit default-mode resolve', async () => {
  for (const [what, spoil] of [
    ['not-opened', (chain, c) => chain.setOpened(c.circuits, c.tokenId, false)],
    ['unpaid', (chain) => chain.setUnactivated()],
  ]) {
    const { chain, c } = world()
    spoil(chain, c)
    const api = clientOf(chain)
    const r = await createAgentKit(api, { clock: () => T }).verifyEvidence(...evidenceOf(c))
    assert.deepEqual(codes(r), ['provider-unresolvable'], what)
    assert.match(r.problems[0].message, new RegExp(what), what)
    assert.equal(r.receipts[0].answeredBy, false, what)
    const plain = clientOf(chain)
    const r2 = await createAgentKit(api, { clock: () => T, resolve: (x) => plain.resolve(x) }).verifyEvidence(...evidenceOf(c))
    assert.deepEqual(r2.problems, [], what)
    assert.equal(r2.receipts[0].answeredBy, true, what)
  }
})

test('T-a-03: fail-closed on the pinned implementations (TAP-10 §6.1): a payment contract running an implementation TAP-10 does not list makes the provider unresolvable by default (store-changed); a default-mode resolve does not read it', async () => {
  const { chain, c } = world()
  chain.setImplementation(CHAINS[56].binding, '0x' + '99'.repeat(20))
  const api = clientOf(chain)
  const r = await createAgentKit(api, { clock: () => T }).verifyEvidence(...evidenceOf(c))
  assert.deepEqual(codes(r), ['provider-unresolvable'])
  assert.match(r.problems[0].message, /store-changed/)
  const plain = clientOf(chain)
  const r2 = await createAgentKit(api, { clock: () => T, resolve: (x) => plain.resolve(x) }).verifyEvidence(...evidenceOf(c))
  assert.deepEqual(r2.problems, [])
})

test('T-a-04: the conformance resolution inherits the client: the same RPC client (nodes, quorum, timeout, fetch), no client of its own without nodes, and a conformance-mode client is used as it is', () => {
  const { chain } = world()
  const api = clientOf(chain, { rpcTimeoutMs: 1234 })
  const sibling = CONFORM_SIBLINGS.get(api)()
  assert.notEqual(sibling, api)
  assert.equal(sibling.rpc, api.rpc, 'the very RPC client of the caller')
  assert.equal(CONFORM_SIBLINGS.get(api)(), sibling, 'made once per client')
  // a client without nodes: so is its sibling (the kit then refuses as before, needRpc) / 没有节点的客户端：同胞也没有
  const bare = createTapeAPI({ conform: false, fetch: async () => { throw new Error('no network') } })
  assert.equal(CONFORM_SIBLINGS.get(bare)().rpc, null)
  // a client already in the conformance mode is its own resolution: nothing else is made / 已是一致模式的客户端就是它自己
  const strict = createTapeAPI({ conform: 'tap10', rpcUrls: RPC, fetch: chain.fetch, ...base })
  assert.equal(CONFORM_SIBLINGS.get(strict)(), strict)
  assert.equal(createAgentKit(strict).resolution, 'tap10')
  // since 2.0 a client made without `conform` is in that mode too: it is its own resolution / 2.0 起不给 conform 的客户端也是一致模式
  const dflt = createTapeAPI({ rpcUrls: RPC, fetch: chain.fetch, ...base })
  assert.equal(CONFORM_SIBLINGS.get(dflt)(), dflt)
  assert.equal(createAgentKit(dflt).resolution, 'tap10')
})

test('T-a-05: privacy: the conformance resolution never reads other chains, even for a client created with allChains: true and nodes for every chain', async () => {
  const w = createConformWorlds({ headTime: T })
  const c = provide(w.chains[56])
  const api = createTapeAPI(w.options({ conform: false, ...base, allChains: true }))   // conform: false: 1.x behaviour; 2.0 default is conform: 'tap10'
  const kit = createAgentKit(api, { clock: () => T })
  assert.equal(kit.resolution, 'tap10')
  const r = await kit.verifyEvidence(...evidenceOf(c))
  assert.deepEqual(r.problems, [])
  assert.ok(w.sent(56) > 0)
  assert.equal(w.sent(196), 0, 'no request to X Layer')
  assert.equal(w.sent(8453), 0, 'no request to Base')
  // and another chain is refused before any request, never routed to a default node / 别的链在发请求之前即被拒绝
  const sibling = CONFORM_SIBLINGS.get(api)()
  assert.throws(() => sibling.forChain(196), (e) => e.code === 'INVALID_ARGUMENT' && e.data?.status === 'unsupported')
  assert.equal(w.sent(196), 0)
})

test('T-a-06: with resolve, the caller\'s function is used as it is and no conformance client is made; a client whose contracts TAP-10 does not list keeps its own resolve, and kit.resolution says so', async () => {
  const { chain } = world()
  const api = clientOf(chain)
  let made = 0
  const real = CONFORM_SIBLINGS.get(api)
  CONFORM_SIBLINGS.set(api, () => { made++; return real() })
  assert.equal(createAgentKit(api, { resolve: (x) => api.resolve(x) }).resolution, 'caller')
  assert.equal(made, 0)
  assert.equal(createAgentKit(api).resolution, 'tap10')
  assert.equal(made, 1)

  // the fake chain of agent.test.mjs (its own hub and factory): the client's resolve, as in 1.8, the same requests and verdict
  // agent.test.mjs 的假链（自己的中枢与工厂）：用客户端自己的 resolve，与 1.8 相同的请求与结论
  const run = async (withResolve) => {
    const x = standardWorld()
    const sent = []
    const api2 = x.api({ fetch: (url, init) => { sent.push(String(init.body).replace(/"id":\d+/g, '')); return x.fetch(url, init) } })
    const kit = createAgentKit(api2, { clock: () => NOW, ...(withResolve ? { resolve: (c) => api2.resolve(c) } : {}) })
    const r = await kit.verifyTaskThread(happyThread().messages)
    return { resolution: kit.resolution, r, sent }
  }
  const a = await run(false), b = await run(true)
  assert.equal(a.resolution, 'client')
  assert.equal(b.resolution, 'caller')
  assert.equal(a.r.state, 'Settled')
  assert.deepEqual(a.r.problems, [])
  assert.deepEqual(a.sent, b.sent)
})

test('T-a-07: the agent too: an agent container that is not opened is agent-unresolvable by default (an offer and an accept under the real hub\'s domain); an explicit default-mode resolve accepts the thread', async () => {
  const thread = (chain) => {
    chain.state.headTime = NOW
    const p = chain.circuit(11, { holder: addrOf(KEYS.principalHolder) })
    const ag = chain.circuit(12, { holder: addrOf(KEYS.agentHolder) })
    chain.writeFile(ag.container, MANIFEST_KEY, JSON.stringify(manifestOf(ag, 56, KEYS.agentHolder)))
    chain.setAccount(12, ag.container)
    const offer = offerMsg({ principal: p.container, agent: ag.container })
    offer.sig = agent.signTaskOffer(56, MAINNET.hub, offer.offer, KEYS.principalHolder)   // the real hub's domain / 真中枢的域
    const accept = acceptMsg({ offerHash: agent.offerHashOf(56, MAINNET.hub, offer.offer), container: ag.container, signerKey: SIGNER_KEY, tokenId: 12, circuits: ag.circuits })
    return { ag, messages: [offer, accept] }
  }
  // healthy: both ways accept the thread / 正常时两种方式都接受
  {
    const chain = createConformChain()
    const { messages } = thread(chain)
    const api = clientOf(chain, { clock: () => NOW })
    const r = await createAgentKit(api, { clock: () => NOW }).verifyTaskThread(messages)
    assert.deepEqual(r.problems, [])
    assert.equal(r.state, 'Accepted')
    assert.ok(tap10Reads(chain).length > 0)
  }
  const chain = createConformChain()
  const { ag, messages } = thread(chain)
  chain.setOpened(ag.circuits, ag.tokenId, false)
  const api = clientOf(chain, { clock: () => NOW })
  const r = await createAgentKit(api, { clock: () => NOW }).verifyTaskThread(messages)
  assert.deepEqual(codes(r), ['agent-unresolvable'])
  assert.match(r.problems[0].message, /not-opened/)
  const plain = clientOf(chain, { clock: () => NOW })
  const r2 = await createAgentKit(api, { clock: () => NOW, resolve: (x) => plain.resolve(x) }).verifyTaskThread(messages)
  assert.deepEqual(r2.problems, [])
  assert.equal(r2.state, 'Accepted')
})
