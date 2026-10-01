// Multi-chain (workstream E): the chain registry, names with area codes, the per-chain delegation domain and resolution
// on X Layer / Base, all network-free. The addresses are pinned against what the nodes answered on 2026-09-28
// (fixtures/chains-onchain.json, recorded by `node scripts/probe-chains.mjs --record`).
// 多链（工作线 E）：链注册表、带区号的名字、按链区分的委托域，以及在 X Layer / Base 上的解析，全部离线。地址对照 2026-09-28
// 节点的回答钉住（fixtures/chains-onchain.json，由 `node scripts/probe-chains.mjs --record` 录制）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  createTapeAPI, createRpc, MAINNET, CHAINS, CHAIN_IDS, HOME_CHAIN_ID, chainById, chainByArea, chainByKey, parseTapeName, formatTapeName,
  isNameShaped, RPC_DEFAULTS, rpcUrlsFor, operatorOf, MANIFEST_KEY,
} from '../src/index.js'
import * as chainsModule from '../src/chains.js'
import { checksumAddress, toHex } from '../src/abi.js'
import { privateKeyToAddress, signDigest, delegationDigest, domainSeparator, delegationDomain } from '../src/sig.js'
import { createFakeChain, ADDR } from './helpers/fake-chain.mjs'
import { problemsOf, FIXTURE, L2_SITE } from './helpers/chain-facts.mjs'

const HUB = '0xe61A9C7213a6Aa616C246a2B569e555B417b25ee'
const recorded = JSON.parse(readFileSync(FIXTURE, 'utf8'))

// ── registry / 注册表 ────────────────────────────────────────────────────────────────────────────────────────────
test('CHAINS: BNB Smart Chain, X Layer and Base, with TapeKit config.js addresses; MAINNET is CHAINS[56]', () => {
  assert.deepEqual(CHAIN_IDS, [56, 196, 8453])
  assert.equal(HOME_CHAIN_ID, 56)
  assert.deepEqual(CHAIN_IDS.map((id) => [CHAINS[id].key, CHAINS[id].area, CHAINS[id].name]), [['bnb', null, 'BNB Smart Chain'], ['xlayer', 2, 'X Layer'], ['base', 3, 'Base']])
  for (const k of ['hub', 'factory', 'siteRegistry']) assert.equal(CHAINS[56][k], MAINNET[k], `MAINNET.${k}`)
  // TapeKit kernel/src/config.js, commit 1050950d / TapeKit 的地址
  assert.equal(CHAINS[56].opener.toLowerCase(), '0x021745de2f42a7839d96f2d3634d0294487d81f1')
  assert.equal(CHAINS[56].binding.toLowerCase(), '0x861ee183de2bbe4a6ecf9d15812c123b566a3db7')
  for (const id of [196, 8453]) {
    const c = CHAINS[id]
    assert.equal(c.factory.toLowerCase(), '0x1f09daefa827f02cbb40967cc91b259763760761')
    assert.equal(c.opener.toLowerCase(), '0x536add8f30f03b69f6fbf29d425a816a0dc50106')
    assert.equal(c.siteRegistry.toLowerCase(), '0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6')
    assert.equal(c.binding.toLowerCase(), '0x68809fd2fb343aa57d0aeb7f33defe477c9666f9')
    assert.equal(c.payments, false, 'payments stay on BNB Smart Chain')
    assert.equal(c.finality, 'safe')
  }
  assert.equal(CHAINS[56].payments, true)
  // One DeWebHub proxy address everywhere; per-chain implementations (TapeKit send/module/src/chain.js)
  // 各链同一个 DeWebHub 代理地址；实现按链不同
  for (const id of CHAIN_IDS) assert.equal(CHAINS[id].hub, HUB)
  assert.deepEqual(CHAIN_IDS.map((id) => CHAINS[id].expectedImpl[HUB.toLowerCase()]), [
    ['0x80afe7b77f2dfd08e9feab7675780bac34a7ee85'], ['0xdcc57797089ebd9f26e686379a4323f353a3f9c6'], ['0x38a2d320b8984bbac9b0a2691b6c0fd829a23867']])
  for (const id of CHAIN_IDS) {
    const c = CHAINS[id]
    for (const k of ['factory', 'opener', 'hub', 'siteRegistry', 'binding', 'erc6551Registry', 'accountImplementation']) assert.equal(c[k], checksumAddress(c[k]), `${id} ${k} is checksummed`)
    for (const [proxy, impls] of Object.entries(c.expectedImpl)) { assert.equal(proxy, proxy.toLowerCase()); for (const i of impls) assert.equal(i, i.toLowerCase()) }
    assert.deepEqual(c.delegation, { chainId: id, verifyingContract: c.hub }, 'the delegation domain is (this chain, its DeWebHub)')
    assert.ok(Object.isFrozen(c) && Object.isFrozen(c.expectedImpl) && Object.isFrozen(c.delegation))
  }
  assert.equal(chainById('196'), CHAINS[196]); assert.equal(chainById(97), null); assert.equal(chainById('x'), null)
  assert.equal(chainByArea(null), CHAINS[56]); assert.equal(chainByArea(2), CHAINS[196]); assert.equal(chainByArea(3), CHAINS[8453])
  for (const a of [0, 1, 4, 99]) assert.equal(chainByArea(a), null)
  assert.equal(chainByKey('XLayer'), CHAINS[196]); assert.equal(chainByKey('nope'), null)
  // chains.js is a leaf: no imports / 叶子模块：不导入任何东西
  assert.doesNotMatch(readFileSync(new URL('../src/chains.js', import.meta.url), 'utf8'), /^\s*import\s/m)
  assert.ok(Object.keys(chainsModule).includes('CHAINS'))
})

test('every address is on chain as recorded 2026-09-28: code present, implementation slot as expected, hub.accountOf == opener.accountOf', () => {
  assert.deepEqual(Object.keys(recorded.chains).map(Number), CHAIN_IDS)
  for (const id of CHAIN_IDS) {
    const f = recorded.chains[id]
    assert.deepEqual(problemsOf(id, f), [], `chain ${id}`)
    // the implementation each proxy answered is the one chains.js pins / 每个代理答的实现就是 chains.js 钉住的
    for (const name of ['factory', 'hub', 'siteRegistry', 'binding']) assert.ok(f.contracts[name].implementation, `${id} ${name} is a proxy`)
    for (const name of ['opener', 'erc6551Registry', 'accountImplementation']) assert.equal(f.contracts[name].implementation, null, `${id} ${name} is not a proxy`)
    assert.equal(f.hubOwner, '0x571d447f4f24688ec35ccf07f1d6993655f6af15')
  }
  // Processor 0 is the same contract address on X Layer and Base, and its #1 has a different container on each: a
  // (circuits, tokenId) pair names no chain by itself. / 0 号处理器在 X Layer 与 Base 上地址相同，#1 的容器却不同。
  assert.equal(recorded.chains[196].processor0, recorded.chains[8453].processor0)
  assert.notEqual(recorded.chains[196].hubAccountOf, recorded.chains[8453].hubAccountOf)
  // A site on X Layer, with no TapeAPI manifest (yet) / X Layer 上的一个网站，尚无 TapeAPI 清单
  const site = recorded.chains[L2_SITE.chainId].site
  assert.equal(site.name, '1.2.230.tape')
  assert.ok(site.size > 0 && /^0x[0-9a-f]{64}$/.test(site.sha256Hash))
  assert.equal(site.manifestSize, 0)
})

test('a changed implementation is a problem the probe reports / 实现变了，探针会报告', () => {
  const f = structuredClone(recorded.chains[8453])
  f.contracts.hub.implementation = '0x' + '99'.repeat(20)
  f.hubAccountOf = '0x' + '98'.repeat(20)
  const p = problemsOf(8453, f)
  assert.ok(p.some((x) => /hub implementation 0x9999/.test(x)) && p.some((x) => /hub\.accountOf/.test(x)), p.join('; '))
})

// ── RPC defaults / 默认节点 ──────────────────────────────────────────────────────────────────────────────────────
test('RPC_DEFAULTS[196]: OKX (two URLs) and dRPC, two operators and no spare; [8453]: four operators', () => {
  assert.deepEqual(RPC_DEFAULTS[196].map((n) => [n.url, n.operator]), [
    ['https://rpc.xlayer.tech', 'okx'], ['https://xlayerrpc.okx.com', 'okx'], ['https://xlayer.drpc.org', 'drpc']])
  assert.deepEqual(RPC_DEFAULTS[8453].map((n) => [n.url, n.operator]), [
    ['https://mainnet.base.org', 'coinbase'], ['https://base-rpc.publicnode.com', 'allnodes'], ['https://base.drpc.org', 'drpc'], ['https://base.gateway.tenderly.co', 'tenderly']])
  for (const id of CHAIN_IDS) for (const n of RPC_DEFAULTS[id]) assert.equal(operatorOf(n.url), n.operator, `${n.url}: the table and operatorOf agree`)
  assert.deepEqual(rpcUrlsFor(196), RPC_DEFAULTS[196].map((n) => n.url))
  // Who forwards whom (measured 2026-09-28): the chain-specific entries win over the generic ones
  // 谁转发谁（2026-09-28 实测）：按链的条目优先于通用条目
  assert.equal(operatorOf('https://196.rpc.thirdweb.com'), 'okx', 'thirdweb forwards OKX on X Layer')
  assert.equal(operatorOf('https://8453.rpc.thirdweb.com'), 'drpc')
  assert.equal(operatorOf('https://56.rpc.thirdweb.com'), 'drpc')
  assert.equal(operatorOf('https://xlayer-mainnet.rpc.sentio.xyz'), 'okx', "Sentio's X Layer node answers with OKX's words")
  assert.equal(operatorOf('https://base.rpc.sentio.xyz'), 'sentio')
  assert.equal(operatorOf('https://developer-access-mainnet.base.org'), 'coinbase')
  assert.equal(operatorOf('https://gateway.tenderly.co/public/base'), 'tenderly')
  assert.equal(operatorOf('https://base-public.nodies.app'), 'pokt')
  // X Layer: 2 operators, so quorum 2 has no spare, and createRpc says so once / 两家：quorum 2 没有余量，createRpc 提示一次
  const said = []
  const x = createRpc({ urls: rpcUrlsFor(196), quorum: 2, fetch: async () => { throw new Error('offline') }, warn: (m) => said.push(m) })
  assert.deepEqual([x.quorum, x.operators], [2, ['okx', 'drpc']])
  assert.equal(said.length, 1); assert.match(said[0], /quorum 2 of 2 operators leaves no spare/)
  assert.throws(() => createRpc({ urls: rpcUrlsFor(196), quorum: 3, fetch: async () => {} }), /at least 3 independent operators, got 2/)
  const b = createRpc({ urls: rpcUrlsFor(8453), quorum: 2, fetch: async () => { throw new Error('offline') }, warn: (m) => said.push(m) })
  assert.deepEqual([b.quorum, b.operators.length, said.length], [2, 4, 1], 'Base: 2 of 4, no warning')
})

test('X Layer: OKX alone cannot answer a read; one OKX URL down is absorbed by the other', async () => {
  const [okx1, okx2, drpc] = rpcUrlsFor(196)
  const answers = (down) => async (url, init) => {
    if (down.includes(url)) throw new Error('down')
    const r = JSON.parse(init.body)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: '0x01' }))
  }
  const rpc = (down) => createRpc({ urls: rpcUrlsFor(196), quorum: 2, quiet: true, disagreeRetryMs: -1, fetch: answers(down) })
  assert.equal(await rpc([okx1]).ethCall('0x' + '11'.repeat(20), '0x'), '0x01')
  await assert.rejects(rpc([drpc]).ethCall('0x' + '11'.repeat(20), '0x'), (e) => e.code === 'RPC_UNAVAILABLE' && /only 1\/2 operators answered/.test(e.message))
  await assert.rejects(rpc([okx1, okx2]).ethCall('0x' + '11'.repeat(20), '0x'), (e) => e.code === 'RPC_UNAVAILABLE')
})

// ── names / 名字 ─────────────────────────────────────────────────────────────────────────────────────────────────
test('names: BNB Smart Chain names carry no area code, other chains do (TapeKit kernel/src/name.js); round trips', () => {
  const p = (s) => { const r = parseTapeName(s); return r && !r.error ? [r.tokenId, r.area, r.processor, r.chainId, r.name] : r }
  for (const s of ['1.2.344', '1.2.344.tape', ' 1.2.344.tape ']) assert.deepEqual(p(s), ['1', 2, '344', 196, '1.2.344.tape'], s)
  assert.deepEqual(p('1.3.0'), ['1', 3, '0', 8453, '1.3.0.tape'])
  assert.deepEqual(p('7.3.12.tape'), ['7', 3, '12', 8453, '7.3.12.tape'])
  for (const s of ['4246.0', '4246.0.tape']) assert.deepEqual(p(s), ['4246', null, '0', 56, '4246.0.tape'], s)
  assert.deepEqual(p('11.1013.tape'), ['11', null, '1013', 56, '11.1013.tape'])
  // formatting, and parse(format(x)) === x on every chain / 格式化，且每条链上 parse(format(x)) === x
  assert.equal(formatTapeName({ tokenId: 1n, processor: 344n, chainId: 196 }), '1.2.344.tape')
  assert.equal(formatTapeName({ tokenId: '1', processor: '5', chainId: 8453 }), '1.3.5.tape')
  assert.equal(formatTapeName({ tokenId: 4246, processor: 0 }), '4246.0.tape')
  assert.equal(formatTapeName({ tokenId: 1, processor: 344, chainId: 196 }, { suffix: false }), '1.2.344')
  for (const chainId of CHAIN_IDS) for (const [tokenId, processor] of [[1n, 0n], [4246n, 7n], [10n ** 18n, 10n ** 9n]]) {
    const name = formatTapeName({ tokenId, processor, chainId })
    assert.deepEqual(p(name), [tokenId.toString(), CHAINS[chainId].area, processor.toString(), chainId, name])
    assert.deepEqual(p(formatTapeName({ tokenId, processor, chainId }, { suffix: false })), [tokenId.toString(), CHAINS[chainId].area, processor.toString(), chainId, name])
  }
  for (const bad of [{ tokenId: 0, processor: 1 }, { tokenId: 1, processor: -1 }, { tokenId: '01', processor: 1 }, { tokenId: 1, processor: 1, chainId: 97 }, { tokenId: 'x', processor: 1 }, { tokenId: '1000000000000000001', processor: 1 }, { tokenId: 1, processor: 1000000001 }, { tokenId: String(2n ** 255n), processor: 0 }]) {
    assert.throws(() => formatTapeName(bad), RangeError, JSON.stringify(bad))
  }
})

test('names: TapeKit rejections, and every non-canonical spelling, are errors, never labels', () => {
  // TapeKit kernel/test/unit.test.mjs rejects these; so do we / TapeKit 拒绝的写法，我们同样拒绝
  const tapekit = ['1.0.5', '1.1.5', '1.4.5', '1.02.5', '#1@1.5', '#1@9.5', '1.2.3.4', '0.2.5', '1.2.05']
  // TapeKit accepts these address-bar spellings; TAPI-20 §3.6 takes the canonical form only / 地址栏写法：规范只收规范形式
  const spellings = ['#1@2.344', '1@2.344', 'tape://1.2.344.tape/', 'web+tape://1.2.344.tape/a', '1.2.344.TAPE', '1.2.344.', '4246.0.', '04246.0', '#4246@0']
  for (const s of [...tapekit, ...spellings]) {
    assert.ok(isNameShaped(s), `${s} is name-shaped`)
    const r = parseTapeName(s)
    assert.ok(r && typeof r.error === 'string', s)
  }
  assert.match(parseTapeName('1.0.5').error, /area codes 0 and 1 are reserved/)
  assert.match(parseTapeName('1.1.5').error, /reserved/)
  assert.match(parseTapeName('1.4.5').error, /area code 4 is not assigned.*2 = X Layer, 3 = Base/)
  assert.match(parseTapeName('1.02.5').error, /canonical form/)
  for (const s of ['reader', 'tapeapi-public', '0x' + '11'.repeat(20), 'a.b.tape', '1a.2', '', '1']) assert.equal(parseTapeName(s), null, `${s} is not name-shaped`)
})

// ── resolution on X Layer / Base, network-free / X Layer 与 Base 上的解析（离线） ──────────────────────────────────
const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32)
const holder = privateKeyToAddress(HOLDER_KEY), signer = privateKeyToAddress(SIGNER_KEY)
const nowS = () => Math.floor(Date.now() / 1000)
const X_CONTAINER = '0x' + '62'.repeat(20), B_CONTAINER = '0x' + '63'.repeat(20)

function manifestOn(chainId, container, { domainChainId = chainId, verifyingContract = HUB, methods } = {}) {
  const expires = nowS() + 30 * 86400
  return {
    tapeapi: '0.1', name: `svc on ${chainId}`, circuits: ADDR.circuits, tokenId: '4246', container, signer,
    delegation: { expires, sig: signDigest(delegationDigest(domainChainId, verifyingContract, { container, signer, expires }), HOLDER_KEY) },
    endpoints: { live: [`https://svc${chainId}.example.com/tapeapi/v1`], async: false },
    methods: methods ?? [{ name: 'ping', priceBEM: '0', params: {}, returns: {} }, { name: 'paid', priceBEM: '0.01', params: {}, returns: {} }],
    payment: { escrow: '0x' + '41'.repeat(20), unit: 'BEM', decimals: 8 },
  }
}
// Three fake chains behind one fetch: host rpc56-*, rpc196-*, rpc8453-* / 三条假链共用一个 fetch，按主机区分
function world({ x = {}, base = {} } = {}) {
  const chains = {
    56: createFakeChain(),
    196: createFakeChain({ chainId: 196, addr: { ...ADDR, factory: CHAINS[196].factory } }),
    8453: createFakeChain({ chainId: 8453, addr: { ...ADDR, factory: CHAINS[8453].factory } }),
  }
  for (const c of Object.values(chains)) c.setOwner(4246, holder)
  chains[196].setAccount(4246, X_CONTAINER); chains[196].setContainerToken(X_CONTAINER, { tokenId: 4246 })
  chains[8453].setAccount(4246, B_CONTAINER); chains[8453].setContainerToken(B_CONTAINER, { tokenId: 4246 })
  chains[56].setAccount(4246, ADDR.container)
  chains[196].writeFile(X_CONTAINER, MANIFEST_KEY, JSON.stringify(x.manifest ?? manifestOn(196, X_CONTAINER)))
  if (base.manifest !== null) chains[8453].writeFile(B_CONTAINER, MANIFEST_KEY, JSON.stringify(base.manifest ?? manifestOn(8453, B_CONTAINER)))
  const asked = { 56: 0, 196: 0, 8453: 0, other: [] }
  const fetch = async (url, init) => {
    const m = /^http:\/\/rpc(56|196|8453)-/.exec(String(url))
    if (m) { asked[m[1]]++; return chains[m[1]].fetch(String(url), init) }
    asked.other.push(String(url))
    throw new Error(`no route to ${url}`)
  }
  const opts = (extra = {}) => ({
    rpcUrls: ['http://rpc56-a', 'http://rpc56-b'], quorum: 2, fetch, hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, factory: ADDR.factory,
    chains: { 196: { rpcUrls: ['http://rpc196-a', 'http://rpc196-b'] }, 8453: { rpcUrls: ['http://rpc8453-a', 'http://rpc8453-b'] } },
    ...extra,
  })
  return { chains, asked, fetch, opts, api: createTapeAPI(opts()) }
}

test('resolve: an X Layer name is read on X Layer only, with the delegation domain (196, DeWebHub); svc carries chainId', async () => {
  const { api, asked } = world()
  const svc = await api.resolve('4246.2.7.tape')
  assert.equal(svc.chainId, 196)
  assert.equal(svc.container.toLowerCase(), X_CONTAINER)
  assert.deepEqual(svc.verified, { delegation: true, holder: checksumAddress(holder) })
  assert.equal(asked[56], 0, 'no BNB Smart Chain node was asked')
  assert.ok(asked[196] > 0)
  assert.equal(asked[8453], 0)
  // the suffix-less name, the pair with its chainId, and { chainId, container } are the same service
  // 不带后缀的名字、带 chainId 的二元组、{ chainId, container } 都是同一个服务
  for (const t of ['4246.2.7', { chainId: 196, circuits: ADDR.circuits, tokenId: '4246' }, { chainId: 196, container: X_CONTAINER }]) {
    const s = await api.resolve(t)
    assert.deepEqual([s.chainId, s.container.toLowerCase()], [196, X_CONTAINER], JSON.stringify(t))
  }
  // Base (area 3) / Base（区号 3）
  const b = await api.resolve('4246.3.7.tape')
  assert.deepEqual([b.chainId, b.container.toLowerCase()], [8453, B_CONTAINER])
  // BNB Smart Chain services still carry chainId 56 / BNB 上的服务同样带 chainId 56
  assert.equal(api.forChain(56), api)
  assert.equal(api.forChain('196'), api.forChain(196), 'one client per chain')
  assert.equal(api.forChain(196).chainId, 196)
  assert.deepEqual(api.forChain(196).addresses, { hub: HUB, siteRegistry: CHAINS[196].siteRegistry, factory: CHAINS[196].factory, directory: undefined, escrow: undefined })
  assert.throws(() => api.forChain(97), (e) => e.code === 'INVALID_ARGUMENT' && /not a TapeOut chain/.test(e.message))
  await assert.rejects(api.resolve({ chainId: 97, container: X_CONTAINER }), (e) => e.code === 'INVALID_ARGUMENT')
  await assert.rejects(api.resolve('4246.4.7.tape'), (e) => e.code === 'MANIFEST_INVALID' && /area code 4/.test(e.message))
})

test('FIXED MC-1: a delegation signed for another chain is refused: the domain chainId separates chains that share one hub address', async () => {
  // The holder signed for BNB Smart Chain (domain 56, same hub address); the X Layer client checks (196, hub).
  // 持有人签的是 BNB 的域（56，同一个中枢地址）；X Layer 客户端按 (196, 中枢) 核对。
  const { api } = world({ x: { manifest: manifestOn(196, X_CONTAINER, { domainChainId: 56 }) } })
  await assert.rejects(api.resolve('4246.2.7.tape'), (e) => e.code === 'DELEGATION_INVALID' && /signed by/.test(e.message))
  // ...and one signed for Base does not pass on X Layer either / Base 的也不能在 X Layer 通过
  const w2 = world({ x: { manifest: manifestOn(196, X_CONTAINER, { domainChainId: 8453 }) } })
  await assert.rejects(w2.api.resolve('4246.2.7.tape'), (e) => e.code === 'DELEGATION_INVALID')
  // a verifyingContract other than the hub (e.g. the SiteRegistry) is refused too / 其它 verifyingContract 同样拒绝
  const w3 = world({ x: { manifest: manifestOn(196, X_CONTAINER, { verifyingContract: CHAINS[196].siteRegistry }) } })
  await assert.rejects(w3.api.resolve('4246.2.7.tape'), (e) => e.code === 'DELEGATION_INVALID')
})

test('delegation domain separators per chain (TAPI-20 §6.2 vectors)', () => {
  const d = { container: '0x0000000000000000000000000000000000000002', signer: '0x0000000000000000000000000000000000000003', expires: 1790000000 }
  const got = CHAIN_IDS.map((id) => [id, toHex(domainSeparator(delegationDomain(id, CHAINS[id].delegation.verifyingContract))), toHex(delegationDigest(id, CHAINS[id].delegation.verifyingContract, d))])
  assert.deepEqual(got, [
    [56, '0xa73ee348b5672f12dbc174f66a7d162c69e0d64befdba88475d9d7e3c0fd3ac7', '0xf0ef7315ef455303fb4a7d8a301ca84f25e9fbd0641e931cdb01e7f7e8bcaa9a'],   // TAPI-20 §6.2 as published
    [196, '0xf9c5be6dcd7d4cfdf9c57717c7d6a7e04bccd499d2a7f3fcfdc603cc7f1f3ad6', '0xf4f57ad38c3efd363cbd271e3fc9fa7a54a1302db7f6adcc202a53f8a7cd529a'],
    [8453, '0xab3b0c6f3cecceb9d441893c56616889d71cf893f74296dc2229a6f241238516', '0x741c7e6412012f5134d127404641a4eb294c77e30a7b19104aece30efe1be9b9'],
  ])
})

test('the processor cache is per chain: a CPU on X Layer is not taken for one on Base', async () => {
  const { api, chains } = world()
  chains[8453].setCounterfeit(ADDR.circuits)
  assert.equal((await api.resolve('4246.2.7.tape')).chainId, 196)
  await assert.rejects(api.resolve('4246.3.7.tape'), (e) => e.code === 'MANIFEST_INVALID' && /not a TapeOut processor/.test(e.message))
})

test('a client whose own chain is X Layer resolves BNB names on BNB Smart Chain; its defaults are X Layer\'s', async () => {
  const w = world()
  const x = createTapeAPI({ chainId: 196, rpcUrls: ['http://rpc196-a', 'http://rpc196-b'], fetch: w.fetch, chains: { 56: { rpcUrls: ['http://rpc56-a', 'http://rpc56-b'], hub: ADDR.hub, siteRegistry: ADDR.siteRegistry, factory: ADDR.factory } } })
  assert.deepEqual(x.addresses, { hub: HUB, siteRegistry: CHAINS[196].siteRegistry, factory: CHAINS[196].factory, directory: undefined, escrow: undefined })
  assert.equal((await x.resolve('4246.2.7.tape')).chainId, 196)
  assert.equal((await x.resolve(X_CONTAINER)).chainId, 196, 'a bare container is read on the client\'s own chain')
  // BNB: the mainnet-style manifest is on chain 56 / BNB 上的清单
  w.chains[56].writeFile(ADDR.container, MANIFEST_KEY, JSON.stringify({ ...manifestOn(56, ADDR.container, { verifyingContract: ADDR.hub }) }))
  const bnb = await x.resolve('4246.7.tape')
  assert.deepEqual([bnb.chainId, bnb.container.toLowerCase()], [56, ADDR.container])
  assert.equal(x.forChain(56).forChain(196), x, 'a sub-client routes other chains back through the client that made it')
})

test('an L2 service: free calls go through its chain\'s client, priced ones are refused (payments are BNB-only), price consent is per chain', async () => {
  const { api, fetch } = world()
  const svc = await api.resolve('4246.2.7.tape')
  await assert.rejects(api.call(svc, 'paid'), (e) => e.code === 'PAYMENT_REQUIRED' && /X Layer: TapeAPI payments run on BNB Smart Chain only/.test(e.message))
  assert.equal(api.acceptedPrice(svc, 'paid'), 10n ** 6n, 'the price seen at resolve is recorded by the X Layer client')
  assert.deepEqual(api.acceptPrice(svc), { ping: 0n, paid: 10n ** 6n })
  // The free call reaches the service endpoint (no provider here: the transport failure proves the route)
  // 免费调用到达服务端点（此处没有 provider：传输失败证明了路径）
  await assert.rejects(api.call(svc, 'ping'), (e) => e.code === 'PROVIDER_UNAVAILABLE')
  // refresh re-reads on X Layer / refresh 在 X Layer 上重读
  const before = svc.fetchedAt
  await api.refresh(svc)
  assert.equal(svc.chainId, 196); assert.ok(svc.fetchedAt >= before)
  void fetch
})

test('chainOfContainer: the chain whose token() names itself; null when none; an outage is not a "no"', async () => {
  const w = world()
  assert.equal(await w.api.chainOfContainer(X_CONTAINER), 196)
  assert.equal(await w.api.chainOfContainer(B_CONTAINER), 8453)
  assert.equal(await w.api.chainOfContainer('0x' + '77'.repeat(20)), null)
  // a container whose token() names another chain is not a container of this one / token() 指向别的链就不是本链容器
  w.chains[56].setContainerToken(X_CONTAINER, { tokenId: 4246, chainId: 196 })
  assert.equal(await w.api.chainOfContainer(X_CONTAINER), 196)
  for (const u of ['http://rpc8453-a', 'http://rpc8453-b']) w.chains[8453].setFault(u, 'timeout')
  await assert.rejects(w.api.chainOfContainer('0x' + '77'.repeat(20)), (e) => e.code === 'RPC_UNAVAILABLE')
  assert.equal(await w.api.chainOfContainer(X_CONTAINER), 196, 'found on one chain: an outage elsewhere does not matter')
  await assert.rejects(w.api.chainOfContainer('nope'), (e) => e.code === 'INVALID_ARGUMENT')
})

test('with no chains option, an L2 name is read through that chain\'s SDK defaults', async () => {
  const x = createFakeChain({ chainId: 196, addr: { ...ADDR, factory: CHAINS[196].factory } })
  x.setOwner(4246, holder); x.setAccount(4246, X_CONTAINER)
  x.writeFile(X_CONTAINER, MANIFEST_KEY, JSON.stringify(manifestOn(196, X_CONTAINER)))
  const seen = new Set()
  const api = createTapeAPI({ rpcUrls: ['http://rpc1', 'http://rpc2'], fetch: (url, init) => { seen.add(String(url)); return x.fetch(String(url), init) } })
  assert.equal((await api.resolve('4246.2.7.tape')).chainId, 196)
  assert.deepEqual([...seen].sort(), [...rpcUrlsFor(196)].sort())
})

test('FIXED G1-M7: the channel-record floor is shared with the other chains\' clients and keyed <chainId>:<container>', async () => {
  const { channelKeysDigest } = await import('../src/sig.js')
  const { canonicalJSON } = await import('../src/canon.js')
  const { generateIdentity } = await import('../src/channel.js')
  const { CHANNEL_KEYS_KEY } = await import('../src/index.js')
  const w = world()
  const nowS = Math.floor(Date.now() / 1000)
  const publish = (issued) => {
    const id = generateIdentity()
    const keys = { container: X_CONTAINER, x25519: toHex(id.x25519.publicKey), ed25519: toHex(id.ed25519.publicKey), inbox: {}, issued, expires: nowS + 86400 }
    const record = { tapechannel: '1', container: X_CONTAINER, chainId: 196, ...keys, sig: signDigest(channelKeysDigest(196, CHAINS[196].hub, keys), HOLDER_KEY) }
    w.chains[196].writeFile(X_CONTAINER, CHANNEL_KEYS_KEY, canonicalJSON(record))
    return record
  }
  const floor = new Map()
  const old = publish(nowS - 3600)
  const api = createTapeAPI(w.opts({ channelRecordFloor: floor }))
  const rec = await api.forChain(196).chain.channelKeys(X_CONTAINER)
  assert.equal(rec.chainId, 196)
  assert.equal(floor.get(`196:${X_CONTAINER.toLowerCase()}`), old.issued, 'the X Layer client wrote to the store it was given')
  publish(nowS - 60)
  await api.forChain(196).chain.channelKeys(X_CONTAINER, { fresh: true })
  // after a restart, the old record put back is refused on X Layer too / 重启后，放回的旧记录在 X Layer 上同样被拒绝
  w.chains[196].writeFile(X_CONTAINER, CHANNEL_KEYS_KEY, canonicalJSON(old))
  const restarted = createTapeAPI(w.opts({ channelRecordFloor: floor }))
  await assert.rejects(restarted.forChain(196).chain.channelKeys(X_CONTAINER), /older than a record already seen/)
  // a 0.x store (keyed by the container alone) is read once and moved under the new key / 0.x 的键读一次并迁移
  const legacy = new Map([[X_CONTAINER.toLowerCase(), nowS - 60]])
  await assert.rejects(createTapeAPI(w.opts({ channelRecordFloor: legacy })).forChain(196).chain.channelKeys(X_CONTAINER), /older than a record already seen/)
  assert.equal(legacy.get(`196:${X_CONTAINER.toLowerCase()}`), nowS - 60)
})

// TAP-10 §3.1 ranges, applied in every mode from 1.4 (an erratum: such a name cannot exist on chain). Until 1.3 a #ID or
// processor number of up to 78 digits parsed, and resolve() then asked the chain about it.
// TAP-10 §3.1 的范围，自 1.4 起所有模式都适用（勘误：这样的名字在链上不可能存在）。1.3 之前最多 78 位都能解析，resolve() 还会去问链。
test('FIXED TAP10-RANGE: #ID <= 10^18 and processor number <= 10^9 in every mode; an out-of-range name is an error before any request', async () => {
  const ok = (s) => { const r = parseTapeName(s); return r && !r.error }
  assert.ok(ok('1000000000000000000.1000000000.tape'))
  assert.ok(ok('1000000000000000000.2.1000000000'))
  for (const s of ['1000000000000000001.0', '1.1000000000001', '1.2.1000000001', '1' + '0'.repeat(77) + '.0.tape', '4246.' + '9'.repeat(78)]) {
    const r = parseTapeName(s)
    assert.ok(r && /out of range: a TapeOut name has 1 <= #ID <= 10\^18 and 0 <= processor number <= 10\^9 \(TAP-10 §3\.1\)/.test(r.error), s)
  }
  let sent = 0
  const api = createTapeAPI({ rpcUrls: ['http://rpc1', 'http://rpc2'], quorum: 2, quiet: true, fetch: async () => { sent++; throw new Error('no request expected') } })
  await assert.rejects(api.resolve('1000000000000000001.0.tape'), (e) => e.code === 'MANIFEST_INVALID' && /out of range/.test(e.message))
  await assert.rejects(api.resolve('1.1000000001'), (e) => e.code === 'MANIFEST_INVALID' && /out of range/.test(e.message))
  assert.equal(sent, 0)
})
