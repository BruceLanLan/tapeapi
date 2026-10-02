// The TAP-10 conformance mode, 1.5: the rest of the resolution path. Input without chain information on every chain
// (allChains, TAP-10 §4.1: `ambiguous`, a chain that cannot be read reported instead of not-tapeout) and the processor
// number of a container address or processor contract#ID (§4.3 step 3: the shipped snapshot checked by one cpuAt, then a
// paged, capped, resumable scan). Offline: three conform chains behind one fetch (helpers/conform-chain.mjs). GOLDEN TAP10-0
// (default-mode-trace.test.mjs) pins that none of this changes the default mode.
// TAP-10 一致模式 1.5：解析路径的其余部分。无链信息的输入在所有链上解析（allChains，§4.1：ambiguous；读不到的链报其状态而不报
// not-tapeout），以及容器地址或处理器合约#ID 的处理器号（§4.3 第 3 步：随版本的快照经一次 cpuAt 核实，然后分页、限量、可续的扫描）。
// 全部离线：三条 conform 链共用一个 fetch。默认模式不受影响由黄金测试 TAP10-0 钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTapeAPI, MANIFEST_KEY, MAINNET, CHAINS, TapeAPIError, sig } from '../src/index.js'
import { PROCESSORS_SNAPSHOT } from '../src/processors-snapshot.js'
import { createConformChain, createConformWorlds } from './helpers/conform-chain.mjs'

const HOLDER_KEY = '0x' + '11'.repeat(32), SIGNER_KEY = '0x' + '22'.repeat(32)
const holder = sig.privateKeyToAddress(HOLDER_KEY), signer = sig.privateKeyToAddress(SIGNER_KEY)
const T = 1_790_000_000
const EXPIRES = T + 30 * 86_400
const GENESIS = '0x50A994E71615474b55559fF4F500928fbc339DD9'   // processor 0 on BNB Smart Chain (TAP-10 Test Cases)
const L2_ONE = '0x0565EA48CA41Ae559d8d491dbb0a9ec945DB551b'    // processor 1 on Base AND on X Layer (TAP-10 §4.1)
const common = { clock: () => T, quiet: true, onWarning: () => {} }

const manifestOf = (c, chainId) => ({
  tapeapi: '0.1', name: 'AllChains', circuits: c.circuits, tokenId: c.tokenId, container: c.container, signer,
  delegation: { expires: EXPIRES, sig: sig.signDigest(sig.delegationDigest(chainId, MAINNET.hub, { container: c.container, signer, expires: EXPIRES }), HOLDER_KEY) },
  endpoints: { live: ['https://api.example.com/tapeapi/v1'], async: false },
  methods: [{ name: 'ping', priceBEM: '0', params: {}, returns: {} }],
})
const fill = (first) => Array.from({ length: 8 }, (_, i) => first[i] ?? '0x' + (0x70 + i).toString(16).repeat(20))
// BNB Smart Chain with 8 processors (L2_ONE is not one of them), Base and X Layer with L2_ONE as processor 1
// BNB 链 8 个处理器（不含 L2_ONE），Base 与 X Layer 的 1 号处理器都是 L2_ONE
function worlds() {
  const w = createConformWorlds({ processors: { 56: fill({ 0: GENESIS }), 196: fill({ 1: L2_ONE }), 8453: fill({ 1: L2_ONE }) }, headTime: T })
  w.chains[56].setCounterfeit(L2_ONE)
  // a site on chain `id`: processor `processor`, #tokenId, with a manifest / 在某条链上建一个带清单的站点
  w.site = (id, tokenId = 1, processor = 1) => {
    const c = w.chains[id].circuit(tokenId, { processor, holder })
    w.chains[id].writeFile(c.container, MANIFEST_KEY, JSON.stringify(manifestOf(c, id)))
    return c
  }
  w.api = (o = {}) => createTapeAPI(w.options({ conform: 'tap10', allChains: true, ...common, ...o }))
  return w
}
const isStatus = (code, status, re) => (e) => {
  assert.ok(e instanceof TapeAPIError, String(e)); assert.equal(e.code, code, e.message); assert.equal(e.data?.status, status, e.message)
  if (re) assert.match(e.message, re)
  return true
}
const statuses = (chains) => Object.fromEntries(chains.map((c) => [c.chainId, c.status]))

// ── the switch / 开关 ─────────────────────────────────────────────────────────────────────────────────────────────
test('FIXED review F2: only allChains === true turns it on; any other value is ignored, never refused (1.4 ignored the option)', async () => {
  const w = worlds()
  const c = w.site(8453)
  for (const v of [false, null, undefined, 'yes', 'true', 1, 0, {}]) {
    const api = w.api({ allChains: v })
    await assert.rejects(api.siteStatus(c.container), isStatus('INVALID_ARGUMENT', 'unsupported'), JSON.stringify(v))
  }
  assert.equal(w.sent(196) + w.sent(8453), 0, 'none of them searched another chain')
  assert.equal((await w.api({ allChains: true }).siteStatus(c.container)).chainId, 8453)
})

test('FIXED review M1: a configuration mistake in chains[id] is thrown as it is, not reported as a chain that could not be decided', async () => {
  const w = worlds()
  const c = w.site(8453)
  const api = w.api({ chains: { 196: { rpcUrls: w.urls(196) }, 8453: { rpcUrls: ['http://one'] } } })
  for (const p of [api.siteStatus(c.container), api.resolve(c.container)]) {
    await assert.rejects(p, (e) => e instanceof TapeAPIError && e.code === 'INVALID_ARGUMENT' && /^quorum 2 needs/.test(e.message)
      && !/could not be decided/.test(e.message) && e.data?.chains === undefined)
  }
})

test('design risk 3: without allChains nothing is sent to Base or X Layer for input without chain information; with it, Base is read and the input found', async () => {
  const w = worlds()
  const c = w.site(8453)
  const off = createTapeAPI(w.options({ conform: 'tap10', ...common }))
  await assert.rejects(off.resolve(c.container), (e) => isStatus('INVALID_ARGUMENT', 'unsupported', /allChains: true/)(e))
  await assert.rejects(off.siteStatus(`${L2_ONE}#1`), isStatus('INVALID_ARGUMENT', 'unsupported', /allChains: true/))
  await assert.rejects(off.resolve(`${L2_ONE}#1`), isStatus('INVALID_ARGUMENT', 'unsupported'))
  assert.equal(w.sent(196) + w.sent(8453), 0, 'no request to another chain')
  // the default resolve never reads the switch: a container string with allChains: true reads this chain only
  // 默认 resolve 从不读这个开关：开了 allChains 的默认客户端解析容器字符串时只读本链
  const def = createTapeAPI(w.options({ allChains: true, ...common }))
  await assert.rejects(def.resolve(c.container))
  assert.equal(w.sent(196) + w.sent(8453), 0, 'the default resolve sent nothing to another chain')
  assert.ok(w.sent(56) > 0)
  // with the switch / 开启后
  const s = await w.api().siteStatus(c.container)
  assert.equal(s.status, 'ok'); assert.equal(s.chainId, 8453); assert.equal(s.name, '1.3.1.tape'); assert.equal(s.container, c.container)
  assert.deepEqual(s.chains, [{ chainId: 56, status: 'not-tapeout' }, { chainId: 196, status: 'not-tapeout' }, { chainId: 8453, status: 'ok' }])
  // siteStatus runs the TAP-10 path in any mode, so a default client with allChains searches too (documented)
  // siteStatus 在任何模式下都走 TAP-10 路径，所以开了 allChains 的默认客户端同样搜索（已写入文档）
  assert.equal((await def.siteStatus(c.container)).chainId, 8453)
})

// ── TAP-10 §4.1 outcomes / §4.1 的结果 ───────────────────────────────────────────────────────────────────────────
test('ambiguous: a processor contract#ID that resolves on Base and on X Layer is INVALID_ARGUMENT with the candidates, whatever the third chain says', async () => {
  const w = worlds()
  w.site(196); w.site(8453)
  const api = w.api()
  const ambiguous = (e) => isStatus('INVALID_ARGUMENT', 'ambiguous', /resolves on X Layer \(1\.2\.1\.tape\) and Base \(1\.3\.1\.tape\); give the on-chain name/)(e)
    && assert.deepEqual(e.data.candidates.map((x) => [x.chainId, x.name, x.processor, x.tokenId, x.circuits]), [[196, '1.2.1.tape', '1', '1', L2_ONE], [8453, '1.3.1.tape', '1', '1', L2_ONE]]) === undefined
    && e.data.candidates.every((x) => x.status === 'ok')
  for (const input of [`${L2_ONE}#1`, `${L2_ONE.toLowerCase()}#1`, ` ${L2_ONE}#1 `]) {
    await assert.rejects(api.resolve(input), ambiguous, input)
    await assert.rejects(api.siteStatus(input), ambiguous, input)
  }
  await assert.rejects(api.resolve(`${L2_ONE}#1`), (e) => assert.deepEqual(statuses(e.data.chains), { 56: 'not-tapeout', 196: 'ok', 8453: 'ok' }) === undefined)
  // not-opened and unpaid still count as resolved: identity is what makes it ambiguous / 未开通、未激活仍算命中：判歧义的是身份
  w.chains[196].setUnactivated(); w.chains[8453].setOpened(L2_ONE, 1, false)
  await assert.rejects(api.resolve(`${L2_ONE}#1`), (e) => isStatus('INVALID_ARGUMENT', 'ambiguous')(e) && assert.deepEqual(statuses(e.data.chains), { 56: 'not-tapeout', 196: 'unpaid', 8453: 'not-opened' }) === undefined)
  // BNB Smart Chain cannot be read: still ambiguous / BNB 链读不到：仍然是 ambiguous
  w.down(56)
  await assert.rejects(api.resolve(`${L2_ONE}#1`), (e) => isStatus('INVALID_ARGUMENT', 'ambiguous')(e) && e.data.chains[0].status === 'unavailable')
  // the name with its area code resolves / 带区号的名字可以解析
  w.chains[196].setContainerLive(null, true)
  assert.equal((await api.resolve('1.2.1.tape')).chainId, 196)
})

test('one chain resolves a processor contract#ID while another cannot be decided: that chain\'s status, never a guess (unavailable, store-changed, wrong-chain)', async () => {
  const w = worlds()
  w.site(8453)   // processor 1 exists on X Layer too, but has no #1 there / X Layer 也有 1 号处理器，但没有 #1
  const pair = `${L2_ONE}#1`
  // everything readable: Base / 都读得到：Base
  let svc = await w.api().resolve(pair)
  assert.equal(svc.chainId, 8453); assert.equal(svc.conform.name, '1.3.1.tape'); assert.equal(svc.pinned.maxLag, 150)
  assert.deepEqual(statuses(svc.conform.chains), { 56: 'not-tapeout', 196: 'no-such-token', 8453: 'ok' })
  // X Layer down / X Layer 宕机
  w.down(196)
  const decided = (code, status) => (e) => isStatus(code, status, /\[0x0565.*#1 resolves on Base \(1\.3\.1\.tape\), but TAP-10 §4\.1 adopts a processor contract#ID only when no other chain resolves it, and X Layer could not be decided\]/)(e)
    && e.data.chainId === 196 && e.data.candidates.length === 1 && e.data.candidates[0].chainId === 8453 && e.data.chains.length === 3
  await assert.rejects(w.api().resolve(pair), decided('RPC_UNAVAILABLE', 'unavailable'))
  await assert.rejects(w.api().siteStatus(pair), decided('RPC_UNAVAILABLE', 'unavailable'))
  w.down(196, null)
  // X Layer's site store runs an implementation that is not accepted / X Layer 的站点存储实现不被接受
  w.chains[196].setImplementation(CHAINS[196].siteRegistry, '0x' + 'ab'.repeat(20))
  await assert.rejects(w.api().resolve(pair), (e) => isStatus('CONTRACT_UNKNOWN', 'store-changed')(e) && e.data.chainId === 196 && e.data.candidates[0].chainId === 8453 && e.data.chains[1].status === 'store-changed')
  const s = await w.api().siteStatus(pair)
  assert.equal(s.status, 'store-changed'); assert.equal(s.chainId, 196)
  assert.deepEqual(statuses(s.chains), { 56: 'not-tapeout', 196: 'store-changed', 8453: 'ok' })
  assert.deepEqual(s.candidates.map((x) => [x.chainId, x.name]), [[8453, '1.3.1.tape']], 'FIXED review L4: siteStatus names the chain that resolved, as resolve does')
  w.chains[196].setImplementation(CHAINS[196].siteRegistry, CHAINS[196].expectedImpl[CHAINS[196].siteRegistry.toLowerCase()][0])
  // X Layer's nodes are on another chain / X Layer 的节点在别的链上
  for (const u of w.urls(196)) w.chains[196].setChainIdAnswer(u, 1)
  await assert.rejects(w.api().resolve(pair), decided('INVALID_ARGUMENT', 'wrong-chain'))
  for (const u of w.urls(196)) w.chains[196].setChainIdAnswer(u, null)
  assert.equal((await w.api().resolve(pair)).chainId, 8453)
})

test('none resolves: the status of a chain that could not be read, never not-tapeout; otherwise no-such-token or not-tapeout after every chain', async () => {
  const w = worlds()
  const dead = '0x000000000000000000000000000000000000dEaD'
  await assert.rejects(w.api().resolve(dead), (e) => isStatus('NOT_FOUND', 'not-tapeout', /on any TapeOut chain \(read: 56, 196, 8453\)/)(e)
    && assert.deepEqual(statuses(e.data.chains), { 56: 'not-tapeout', 196: 'not-tapeout', 8453: 'not-tapeout' }) === undefined)
  const s = await w.api().siteStatus(dead)
  assert.equal(s.status, 'not-tapeout'); assert.equal(s.chains.length, 3)
  w.down(8453)
  await assert.rejects(w.api().resolve(dead), (e) => isStatus('RPC_UNAVAILABLE', 'unavailable', /resolves on no chain that could be read, and TAP-10 §4\.1 forbids not-tapeout while Base could not be decided/)(e) && e.data.chainId === 8453 && e.data.candidates === undefined)
  await assert.rejects(w.api().siteStatus(dead), isStatus('RPC_UNAVAILABLE', 'unavailable'))
  w.down(8453, null)
  // the processor exists on Base and X Layer, #9 on neither / 处理器在 Base 与 X Layer 上都有，#9 都没有
  await assert.rejects(w.api().resolve(`${L2_ONE}#9`), (e) => isStatus('NOT_FOUND', 'no-such-token')(e) && e.data.chainId === 196)
})

test('a container address resolves on the one chain it belongs to, whatever the other chains say, at one pinned block of that chain (no second resolution)', async () => {
  const w = worlds()
  const c = w.site(8453)
  w.down(196)
  const api = w.api()
  const from = w.sent(8453)
  const svc = await api.resolve(c.container)
  assert.equal(svc.chainId, 8453); assert.equal(svc.container, c.container); assert.equal(svc.conform.name, '1.3.1.tape')
  assert.deepEqual(statuses(svc.conform.chains), { 56: 'not-tapeout', 196: 'unavailable', 8453: 'ok' })
  const reads = w.chains[8453].conform.log.slice(from).filter((x) => x.block !== null)
  assert.ok(reads.some((x) => x.fn === 'read'), 'the manifest was read on Base')
  for (const r of reads) assert.deepEqual(r.block, { blockHash: svc.pinned.hash, requireCanonical: true }, `${r.method} ${r.fn}`)
  assert.equal(w.chains[8453].conform.log.slice(from).filter((x) => x.fn === 'token').length, w.chains[8453].conform.log.slice(from).filter((x) => x.fn === 'isOpened').length, 'identity read once (one round)')
  // refresh goes back through the same search / 刷新同样经过所有链搜索
  w.down(196, null)
  await api.refresh(svc)
  assert.equal(svc.chainId, 8453); assert.equal(svc.conform.chains[1].status, 'not-tapeout')
})

test('FORCHAIN: forChain passes allChains on, so a Base sub-client searches every chain too (without it Base would silently answer unsupported)', async () => {
  const w = worlds()
  w.site(196); w.site(8453)
  const parent = w.api()
  await assert.rejects(parent.forChain(8453).siteStatus(`${L2_ONE}#1`), isStatus('INVALID_ARGUMENT', 'ambiguous'))
  await assert.rejects(parent.forChain(196).resolve(`${L2_ONE}#1`), isStatus('INVALID_ARGUMENT', 'ambiguous'))
  const c = w.chains[8453].circuit(2, { processor: 1, holder })
  w.chains[196].setCounterfeit(L2_ONE)   // processor 1 only on Base from now on / 此后只在 Base 上是处理器
  w.chains[8453].writeFile(c.container, MANIFEST_KEY, JSON.stringify(manifestOf(c, 8453)))
  assert.equal((await parent.forChain(196).resolve(c.container)).chainId, 8453, 'an X Layer sub-client finds the Base container')
  // control: the parent without the switch / 对照：父客户端未开开关
  const without = createTapeAPI(w.options({ conform: 'tap10', ...common }))
  await assert.rejects(without.forChain(8453).siteStatus(`${L2_ONE}#1`), isStatus('INVALID_ARGUMENT', 'unsupported'))
})

test('warnings of identity are reported only for the chain chosen: none for an ambiguous input, once for the chosen chain', async () => {
  const w = worlds()
  const seen = []
  const onWarning = (x) => seen.push(x.code)
  // the opener derives another address than ERC-6551 on both L2s (the sentinel warns about it)
  // 两条 L2 上开通器推导的地址都与 ERC-6551 不同（哨兵会就此警告）
  for (const id of [196, 8453]) {
    const moved = '0x' + (id === 196 ? '6b' : '6c').repeat(20)
    w.chains[id].setOpenerAccount(L2_ONE, 1, moved)
    w.chains[id].setOwner(1, holder)
    w.chains[id].writeFile(moved, MANIFEST_KEY, JSON.stringify(manifestOf({ circuits: L2_ONE, tokenId: '1', container: moved }, id)))
  }
  await assert.rejects(w.api({ onWarning }).resolve(`${L2_ONE}#1`), (e) => isStatus('INVALID_ARGUMENT', 'ambiguous')(e)
    && e.data.candidates.every((x) => x.warnings.length === 1 && x.warnings[0].code === 'CONTAINER_MISMATCH'))
  assert.deepEqual(seen, [], 'no warning reported from either candidate (FIXED review L3: they are in data.candidates[i].warnings)')
  // sentinel: 'strict' fails closed on each chain: container-mismatch, TapeAPI's own status, in `chains`
  // sentinel: 'strict' 在每条链上 fail-closed：chains 里是 TapeAPI 自己的状态 container-mismatch
  await assert.rejects(w.api({ onWarning, sentinel: 'strict' }).resolve(`${L2_ONE}#1`), (e) => isStatus('MANIFEST_INVALID', 'container-mismatch')(e)
    && assert.deepEqual(statuses(e.data.chains), { 56: 'not-tapeout', 196: 'container-mismatch', 8453: 'container-mismatch' }) === undefined)
  w.chains[196].setCounterfeit(L2_ONE)
  const svc = await w.api({ onWarning }).resolve(`${L2_ONE}#1`)
  assert.equal(svc.chainId, 8453); assert.equal(svc.sentinel.container, 'mismatch')
  assert.deepEqual(seen, ['CONTAINER_MISMATCH']); assert.deepEqual(svc.warnings.map((x) => x.code), ['CONTAINER_MISMATCH'])
})

// ── the processor number (TAP-10 §4.3 step 3) / 处理器号 ──────────────────────────────────────────────────────────
const SNAP = PROCESSORS_SNAPSHOT[56]
const cpuAtReads = (chain, from = 0) => chain.conform.log.slice(from).filter((x) => x.fn === 'cpuAt')
const indices = (reads) => [...new Set(reads.map((x) => x.index))].sort((a, b) => a - b)
const bsc = (processors) => {
  const chain = createConformChain({ chainId: 56, processors })
  chain.state.headTime = T
  return { chain, api: () => createTapeAPI({ conform: 'tap10', rpcUrls: ['http://rpc1', 'http://rpc2', 'http://rpc3'], fetch: chain.fetch, ...common }) }
}

test('the snapshot shipped with the SDK: at least the 1,174 / 263 / 101 processors of 2026-10-01 (UTC; append-only), each chain with its own factory and the operators it was read with', () => {
  // lower bounds, not exact counts: a regenerated snapshot only grows (TAP-10 §1) / 下限而非精确值：重新生成的快照只会变长
  for (const [id, atLeast] of [[56, 1174], [196, 263], [8453, 101]]) assert.ok(PROCESSORS_SNAPSHOT[id].count >= atLeast, `${id}: ${PROCESSORS_SNAPSHOT[id].count}`)
  for (const id of [56, 196, 8453]) {
    const t = PROCESSORS_SNAPSHOT[id]
    assert.equal(t.chainId, id); assert.equal(t.factory, CHAINS[id].factory.toLowerCase()); assert.equal(t.list.length, t.count)
    assert.ok(Number.isSafeInteger(t.block) && /^0x[0-9a-f]{64}$/.test(t.blockHash) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(t.generatedAt), 'UTC')
    assert.ok(t.operators.length >= 2 && t.operators.every((o) => typeof o === 'string'), 'two or more operators')
    assert.equal(new Set(t.list).size, t.count, 'no duplicates')
    for (const a of t.list) assert.match(a, /^0x[0-9a-f]{40}$/)
    assert.ok(Object.isFrozen(t.list))
  }
  assert.equal(SNAP.list[0], GENESIS.toLowerCase(), 'processor 0 is Genesis CPU (TAP-10 Test Cases)')
  assert.equal(PROCESSORS_SNAPSHOT[196].list[1], L2_ONE.toLowerCase()); assert.equal(PROCESSORS_SNAPSHOT[8453].list[1], L2_ONE.toLowerCase())
})

test('a snapshot hit costs one cpuAt at the pinned block, and no cpuCount', async () => {
  const { chain, api } = bsc([...SNAP.list])
  const c = chain.circuit(4246, { processor: 0, holder })
  const s = await api().siteStatus(c.container)
  assert.equal(s.name, '4246.0.tape'); assert.equal(s.processor, '0'); assert.equal(s.status, 'ok')
  assert.deepEqual(indices(cpuAtReads(chain)), [0])
  assert.ok(!chain.conform.log.some((x) => x.fn === 'cpuCount'))
  for (const r of cpuAtReads(chain)) assert.deepEqual(r.block, { blockHash: s.pinned.hash, requireCanonical: true })
  // a processor deep in the table: still one read / 表中靠后的处理器：仍然一次读取
  const deep = chain.circuit(7, { processor: 1100, holder })
  const from = chain.conform.log.length
  assert.equal((await api().siteStatus({ circuits: deep.circuits, tokenId: 7 })).name, '7.1100.tape')
  assert.deepEqual(indices(cpuAtReads(chain, from)), [1100])
})

test('a processor created after the snapshot: only the new numbers are scanned, once the chain agrees with the snapshot (cpuCount, its last entry)', async () => {
  const fresh = ['0x' + 'a1'.repeat(20), '0x' + 'a2'.repeat(20)]
  const { chain, api } = bsc([...SNAP.list, ...fresh])
  const c = chain.circuit(3, { processor: SNAP.count + 1, holder })
  const client = api()
  const s = await client.siteStatus(c.container)
  assert.equal(s.name, `3.${SNAP.count + 1}.tape`)
  assert.deepEqual(indices(cpuAtReads(chain)), [SNAP.count - 1, SNAP.count, SNAP.count + 1])
  // another new one later: only what was not scanned yet / 之后又新建一个：只扫还没扫过的
  chain.setProcessors([...SNAP.list, ...fresh, '0x' + 'a3'.repeat(20)])
  const d = chain.circuit(4, { processor: SNAP.count + 2, holder })
  const from = chain.conform.log.length
  assert.equal((await client.siteStatus(d.container)).name, `4.${SNAP.count + 2}.tape`)
  assert.deepEqual(indices(cpuAtReads(chain, from)), [SNAP.count + 2])
  // a name of a processor found by the scan reads neither cpuCount nor cpuAt again (the kept table, §4.3)
  // 扫描找到的处理器，其名字不再读 cpuCount 与 cpuAt（保留的表）
  const from2 = chain.conform.log.length
  assert.equal((await client.siteStatus(`3.${SNAP.count + 1}`)).container, c.container)
  assert.ok(!chain.conform.log.slice(from2).some((x) => x.fn === 'cpuCount' || x.fn === 'cpuAt'))
})

test('a chain that disagrees with the snapshot (fewer processors, another entry) is scanned from 0 instead', async () => {
  // the fake world: 8 processors, none from the snapshot / 假链：8 个处理器，都不在快照里
  let { chain, api } = bsc(undefined)
  const c = chain.circuit(5, { processor: 6, holder })
  assert.equal((await api().siteStatus(c.container)).name, '5.6.tape')
  assert.deepEqual(indices(cpuAtReads(chain)), [0, 1, 2, 3, 4, 5, 6, 7, SNAP.count - 1])
  // entries 0 and 1 swapped: the snapshot says Genesis is 0, cpuAt(0) says otherwise / 交换 0 与 1：快照说 Genesis 是 0 号，链上不是
  ;({ chain, api } = bsc([SNAP.list[1], SNAP.list[0], ...SNAP.list.slice(2)]))
  const g = chain.circuit(4246, { processor: 1, holder })
  const s = await api().siteStatus({ circuits: GENESIS, tokenId: 4246 })
  assert.equal(s.name, '4246.1.tape'); assert.equal(s.container, g.container)
  assert.deepEqual(indices(cpuAtReads(chain)), [0, 1, 2, 3, 4, 5, 6, 7], 'the hit was checked, then a scan from 0 found it in the first page')
})

test('the scan is capped per resolution (256 numbers, pages of 8) and resumes where it stopped: unavailable until found, never a cold scan of every number', async () => {
  const many = Array.from({ length: 600 }, (_, i) => '0x' + (0x100000 + i).toString(16).padStart(40, 'b'))
  const { chain, api } = bsc(many)
  const c = chain.circuit(9, { processor: 590, holder })
  const client = api()
  let from = 0
  for (const next of [256, 512]) {
    await assert.rejects(client.siteStatus(c.container), (e) => isStatus('RPC_UNAVAILABLE', 'unavailable', /not among the \d+ read so far.*goes on from there next time/)(e)
      && assert.deepEqual(e.data.scan, { from: 0, next, count: 600 }) === undefined)
    const read = indices(cpuAtReads(chain, from)).filter((i) => i !== SNAP.count - 1)
    assert.ok(read.length <= 256, `${read.length} numbers in one resolution`)
    from = chain.conform.log.length
  }
  const s = await client.siteStatus(c.container)
  assert.equal(s.name, '9.590.tape')
  assert.deepEqual(indices(cpuAtReads(chain, from)), Array.from({ length: 80 }, (_, k) => 512 + k), 'resumed at 512, stopped after the page that holds 590 (584-591)')
  // concurrent lookups share one scan and skip nothing / 并发查找共用一次扫描，不漏编号
  const { chain: chain2, api: api2 } = bsc(many.slice(0, 40))
  const a = chain2.circuit(1, { processor: 11, holder }), b = chain2.circuit(2, { processor: 37, holder })
  const both = api2()
  const [sa, sb] = await Promise.all([both.siteStatus(a.container), both.siteStatus(b.container)])
  assert.equal(sa.name, '1.11.tape'); assert.equal(sb.name, '2.37.tape')
})

test('FIXED review F1: siteStatus on a default client resolves a processor contract#ID string on its own chain, as 1.4 did (only the conformance mode refuses it without allChains)', async () => {
  const { chain, api: _api } = bsc(undefined)
  const c = chain.circuit(4246, { processor: 7, holder })
  const api = createTapeAPI({ rpcUrls: ['http://rpc1', 'http://rpc2', 'http://rpc3'], fetch: chain.fetch, quiet: true, clock: () => T })
  const s = await api.siteStatus(`${c.circuits}#4246`)
  assert.equal(s.status, 'ok'); assert.equal(s.container, c.container); assert.equal(s.chainId, 56)
  assert.equal(s.name, '4246.7.tape', '1.4 said null: the processor number is found since 1.5')
  // Requests: 1.4.0 sent, on this world, per method across the 3 nodes: eth_blockNumber 3, eth_chainId 3,
  // eth_getBlockByNumber 3, eth_getStorageAt 6, isCPU 3, accountOf 3, ownerOf 3, isOpened 3, isContainerLive 3 (30 in all).
  // Each is unchanged; what 1.5 adds is the processor-number lookup (cpuCount, cpuAt) and isLive, now that the name is known.
  // 请求：1.4.0 在这个世界里按方法（3 个节点合计）发出上面这些（共 30 个），每项不变；1.5 只多出处理器号查找（cpuCount、cpuAt）与 isLive。
  const count = {}
  for (const x of chain.conform.log) { const k = x.fn ?? x.method; count[k] = (count[k] ?? 0) + 1 }
  const v14 = { eth_blockNumber: 3, eth_chainId: 3, eth_getBlockByNumber: 3, eth_getStorageAt: 6, isCPU: 3, accountOf: 3, ownerOf: 3, isOpened: 3, isContainerLive: 3 }
  for (const [k, n] of Object.entries(v14)) assert.equal(count[k], n, k)
  assert.deepEqual(Object.keys(count).filter((k) => !(k in v14)).sort(), ['cpuAt', 'cpuCount', 'isLive'])
  // not a processor here: unsupported, as in 1.4 (it may be one on another chain) / 在本链不是处理器：与 1.4 一样 unsupported
  chain.setCounterfeit(c.circuits)   // a fresh client: a true isCPU is kept for good / 新客户端：isCPU 为真会被永久记住
  await assert.rejects(createTapeAPI({ rpcUrls: ['http://rpc1', 'http://rpc2', 'http://rpc3'], fetch: chain.fetch, quiet: true, clock: () => T }).siteStatus(`${c.circuits}#4246`), isStatus('INVALID_ARGUMENT', 'unsupported', /is not a TapeOut processor here/))
  // the conformance mode refuses it before any request / 一致模式在任何请求之前拒绝
  const from = chain.conform.log.length
  await assert.rejects(_api().siteStatus(`${c.circuits}#4246`), isStatus('INVALID_ARGUMENT', 'unsupported', /allChains: true/))
  assert.equal(chain.conform.log.length, from)
})

test('FIXED review L1: with proofs, a container address asks for the cpuAt proof of the processor number it found', async () => {
  const { chain, api } = bsc(undefined)
  const c = chain.circuit(4246, { processor: 7, holder })
  chain.writeFile(c.container, MANIFEST_KEY, JSON.stringify(manifestOf(c, 56)))
  const svc = await createTapeAPI({ conform: 'tap10', proofs: true, rpcUrls: ['http://rpc1', 'http://rpc2', 'http://rpc3'], fetch: chain.fetch, ...common }).resolve(c.container)
  assert.equal(svc.conform.processor, '7')
  assert.ok(svc.proofs.unavailable.some((x) => x.read === 'cpuAt'), JSON.stringify(svc.proofs.unavailable.map((x) => x.read)))
  void api
})

test('FIXED review L2: a full processor table stops the scan where it could not keep numbers: unavailable, never a wrong not-tapeout later', async () => {
  const many = Array.from({ length: 20 }, (_, i) => '0x' + (0x200000 + i).toString(16).padStart(40, 'c'))
  const { chain } = bsc(many)
  const far = chain.circuit(1, { processor: 12, holder }), near = chain.circuit(2, { processor: 9, holder })
  const api = createTapeAPI({ conform: 'tap10', _processorTableMax: 4, rpcUrls: ['http://rpc1', 'http://rpc2', 'http://rpc3'], fetch: chain.fetch, ...common })
  const full = (e) => isStatus('RPC_UNAVAILABLE', 'unavailable', /processor table this client keeps is full \(4 entries\)/)(e) && e.data.scan.full === true && e.data.scan.next === 0
  await assert.rejects(api.siteStatus(far.container), full)
  // 1.5 before the fix had moved past 9 without keeping it, and answered not-tapeout here / 修复前已越过 9 号且没保留，这里会误报 not-tapeout
  await assert.rejects(api.siteStatus(near.container), full)
  // processors 0-3 were kept, so a container of one of them still resolves / 0–3 号已保留，它们的容器照常解析
  const kept = chain.circuit(3, { processor: 2, holder })
  assert.equal((await api.siteStatus(kept.container)).name, '3.2.tape')
})
