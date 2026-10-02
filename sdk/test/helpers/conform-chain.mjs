// A TAP-10 chain on top of the fake chain, for the conformance mode (conform: 'tap10'). fake-chain.mjs itself is not
// touched (every other test uses it): this wraps its fetch and answers, by ADDRESS as well as selector, the reads TAP-10
// adds, and hands everything else to the fake chain as before.
// 在假链之上的 TAP-10 链，供一致模式测试。fake-chain.mjs 本身不动（其它测试都在用）：这里包住它的 fetch，按**地址**与选择器
// 回答 TAP-10 新增的读取，其余原样交给假链。
//
//   factory (CHAINS[id].factory)   cpuCount(), cpuAt(n) from `processors` (index = processor number; past the end reverts).
//                                  isCPU goes to the fake chain (true unless setCounterfeit).
//   opener  (CHAINS[id].opener)    accountOf(circuits, #ID): the ERC-6551 derivation with this chain's registry and container
//                                  implementation (as the real opener), unless overridden; isOpened (true unless set).
//                                  The hub's accountOf has the same selector and still goes to the fake chain, which answers
//                                  setAccount() or the zero address: a client that reads the hub instead of the opener fails.
//   DomainBinding (CHAINS[id].binding)  isLive(name, container), isContainerLive(container) (true, false or 'revert': an
//                                  implementation without it, like 0x4E86…), containerPaidUntil, monthlyFee. Activated by default.
//   eth_blockNumber                per URL: st.block − setHeadLag(url, n); eth_chainId per URL: setChainIdAnswer(url, id).
//                                  setHeadLag(url, n, { state: true }): that node also lacks every block above its head, as a
//                                  lagging geth does: a block above it is null, a state read at one is "header not found".
//   ERC-1967 slots                 the fake chain's: chains.js expectedImpl unless setImplementation (useLegacyBinding()
//                                  puts the previous DomainBinding 0x4E8684Ea… in place and makes isContainerLive revert).
//   TAP-10 §13.8 (1.5, the messaging path)  circuitBeacon.implementation() and .owner(), factory.isSealed(), hub.isSealed()
//                                  and hub.owner(), by address and raw selector (abi.js does not list them): chains.js
//                                  TAP10_SEALS, the factory as the beacon's owner, nothing sealed, the hub owner TAP-10 lists.
//                                  setSeal({ beaconImplementation, beaconOwner, factorySealed, hubSealed, hubOwner }) takes an
//                                  address, a number or a raw 32-byte word (to test non-canonical answers), or 'revert'.
//   setCallFault(url, read, kind)  one node's fault for one kind of read only (ownerOf, isValidSignature, eth_getCode, ...),
//                                  to test strict agreement read by read.
// Every request is logged in `log` as { url, method, to, fn, block } (block: the block parameter of a state read), and
// `index` for a cpuAt read.
import { createFakeChain, eachCall, ADDR } from './fake-chain.mjs'
import { functionBySelector, decodeCall, encodeReturn, ZERO_ADDRESS, selector } from '../../src/abi.js'
import { CHAINS, TAP10_SEALS } from '../../src/chains.js'
import { erc6551Account } from '../../src/security.js'

export const LEGACY_BINDING = '0x4e8684eaea48b524245b2191dee451eaa1c1ca94'   // BSC DomainBinding before 2026-09-13, no isContainerLive
export const HUB_OWNER = '0x571d447f4f24688eC35Ccf07f1D6993655F6aF15'           // TAP-10 Deployments, every chain, until sealed
// The §13.8 reads, by raw selector / §13.8 的读取，按原始选择器
const RAW = Object.fromEntries(['implementation()', 'owner()', 'isSealed()'].map((sig) => [selector(sig), sig.slice(0, -2)]))
// Names for the log only (EIP-1271 goes on to the fake chain) / 只用于日志的名字（EIP-1271 仍交给假链）
const LOG_NAMES = { ...RAW, [selector('isValidSignature(bytes32,bytes)')]: 'isValidSignature' }
const wordOf = (v) => (typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v) ? v.toLowerCase()
  : '0x' + (typeof v === 'string' ? v.slice(2).toLowerCase().padStart(64, '0') : BigInt(v).toString(16).padStart(64, '0')))
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })

export function createConformChain({ chainId = 56, processors } = {}) {
  const c = CHAINS[chainId]
  const chain = createFakeChain({ chainId, addr: { ...ADDR, factory: c.factory } })
  const lc = (a) => String(a).toLowerCase()
  const st = {
    // processor number -> processor contract; 7 is ADDR.circuits (the fake chain's circuits), the others distinct
    // 处理器号 -> 处理器合约；7 号是 ADDR.circuits，其余各不相同
    processors: processors ?? Array.from({ length: 8 }, (_, i) => (i === 7 ? ADDR.circuits : '0x' + (0x70 + i).toString(16).repeat(20))),
    accounts: new Map(), opened: new Map(), live: new Set(), containerLive: new Map(), defaultLive: true,
    paidUntil: new Map(), fee: 0n, heads: new Map(), headState: new Set(), chainIds: new Map(), log: [], callFaults: new Map(),
    seal: { beaconImplementation: TAP10_SEALS[chainId].circuitImplementation, beaconOwner: c.factory, factorySealed: 0, hubSealed: 0, hubOwner: HUB_OWNER },
  }
  const key = (circuits, tokenId) => `${lc(circuits)}:${BigInt(tokenId)}`
  const derive = (circuits, tokenId) => erc6551Account({ registry: c.erc6551Registry, implementation: c.accountImplementation, chainId, tokenContract: circuits, tokenId })
  Object.assign(chain, {
    conform: st, chainId,
    /** The container the opener derives (and the real ERC-6551 address unless overridden) / 开通器推导的容器 */
    containerOf: (circuits, tokenId) => st.accounts.get(key(circuits, tokenId)) ?? derive(circuits, tokenId),
    setOpenerAccount(circuits, tokenId, container) { st.accounts.set(key(circuits, tokenId), container) },
    setOpened(circuits, tokenId, yes) { st.opened.set(key(circuits, tokenId), yes) },
    setProcessors(list) { st.processors = list },
    /** names: [[on-chain name, container]] for which isLive is true / isLive 为真的 [名字, 容器] */
    setLiveName(name, container, yes = true) { const k = `${name}\n${lc(container)}`; if (yes) st.live.add(k); else st.live.delete(k) },
    /** true | false | 'revert' for one container, or for every container when `container` is null / 某容器或全部容器 */
    setContainerLive(container, v) { if (container === null) st.defaultLive = v; else st.containerLive.set(lc(container), v) },
    setUnactivated() { st.defaultLive = false; st.live.clear(); st.containerLive.clear() },
    useLegacyBinding() { chain.setImplementation(c.binding, LEGACY_BINDING); st.defaultLive = 'revert'; st.containerLive.clear() },
    setHeadLag(url, n, { state = false } = {}) { if (n) st.heads.set(url, n); else st.heads.delete(url); if (n && state) st.headState.add(url); else st.headState.delete(url) },
    setChainIdAnswer(url, id) { if (id == null) st.chainIds.delete(url); else st.chainIds.set(url, id) },
    setSeal(over) { Object.assign(st.seal, over) },
    /** One node's answer to one kind of read only: `read` is a function name as logged ('ownerOf', 'isValidSignature') or a
     *  method ('eth_getCode'); `kind` 'http500' (no answer), 'rpcerror' (-32000, not an answer under TAP-10 §1), 'revert', or
     *  { result } (another answer); null clears it. `data`: only eth_calls whose calldata contains this hex (e.g. one digest).
     *  某节点只对某一种读取作答异常；null 清除。data：只对调用数据含这段十六进制的 eth_call（例如某个摘要）。 */
    setCallFault(url, read, kind, { data = null } = {}) {
      const k = `${url}\n${read}`
      if (kind == null) st.callFaults.delete(k); else st.callFaults.set(k, { kind, data: data && String(data).toLowerCase().replace(/^0x/, '') })
    },
  })
  // A service the TAP-10 way: circuit #tokenId of processor `processor`, its container derived by the opener, a holder.
  // TAP-10 方式的服务：处理器 processor 的电路 #tokenId，容器由开通器推导，有持有人。
  chain.circuit = (tokenId, { processor = 7, holder = null } = {}) => {
    const circuits = st.processors[processor]
    const container = chain.containerOf(circuits, tokenId)
    chain.setContainerToken(container, { circuits, tokenId, chainId })
    if (holder) chain.setOwner(tokenId, holder)
    return { circuits, container, tokenId: String(tokenId), processor: String(processor) }
  }

  const reply = (req, result) => json({ jsonrpc: '2.0', id: req.id, result })
  const revert = (req) => json({ jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted' } })
  const inner = chain.fetch
  async function one(url, init) {
    const req = JSON.parse(init.body)
    const call = req.method === 'eth_call' ? req.params?.[0] : null
    const to = call ? lc(call.to) : null
    const fn = call ? (functionBySelector(call.data) ?? RAW[String(call.data).slice(0, 10).toLowerCase()] ?? null) : null
    const logged = call ? (fn ?? LOG_NAMES[String(call.data).slice(0, 10).toLowerCase()] ?? null) : null
    const blockArg = { eth_call: 1, eth_getCode: 1, eth_getStorageAt: 2 }[req.method]
    st.log.push({ url, method: req.method, to: to ?? (req.method === 'eth_getStorageAt' ? lc(req.params[0]) : null), fn: logged, block: blockArg === undefined ? null : (req.params?.[blockArg] ?? 'latest'), ...(fn === 'cpuAt' ? { index: Number(decodeCall('cpuAt', call.data)[0]) } : {}) })
    // A node fault of the fake chain applies as to any read: the fake chain answers it / 节点故障照旧由假链处理
    if (chain.state.faults.has(url)) return inner(url, init)
    // A fault of one node for one kind of read only (setCallFault) / 某节点只对某一种读取的故障
    const cf = st.callFaults.get(`${url}\n${logged ?? req.method}`)
    if (cf !== undefined && (!cf.data || String(call?.data ?? '').toLowerCase().includes(cf.data))) {
      if (cf.kind === 'http500') return new Response('boom', { status: 500 })
      if (cf.kind === 'rpcerror') return json({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'node says no' } })
      if (cf.kind === 'revert') return revert(req)
      return reply(req, cf.kind.result)
    }
    if (req.method === 'eth_blockNumber') return reply(req, '0x' + (chain.state.block - (st.heads.get(url) ?? 0)).toString(16))
    // A node behind the pinned block (setHeadLag with state) / 落后于钉块的节点
    if (st.headState.has(url)) {
      const head = chain.state.block - st.heads.get(url)
      if (req.method === 'eth_getBlockByNumber' && /^0x[0-9a-f]+$/i.test(String(req.params?.[0])) && Number(BigInt(req.params[0])) > head) return reply(req, null)
      const b = blockArg === undefined ? null : req.params?.[blockArg]
      const n = b && typeof b === 'object' ? (b.blockHash ? parseInt(b.blockHash.slice(4), 16) : Number(BigInt(b.blockNumber))) : (/^0x[0-9a-f]+$/i.test(String(b)) ? Number(BigInt(b)) : null)
      if (n !== null && n > head) return json({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: b?.blockHash ? `header for hash ${b.blockHash} not found` : 'header not found' } })
    }
    if (req.method === 'eth_chainId' && st.chainIds.has(url)) return reply(req, '0x' + st.chainIds.get(url).toString(16))
    if (!call) return inner(url, init)
    // §13.8 / 封存状态
    const sealAnswer = (v) => (v === 'revert' ? revert(req) : reply(req, wordOf(v)))
    if (to === lc(TAP10_SEALS[chainId].circuitBeacon) && fn === 'implementation') return sealAnswer(st.seal.beaconImplementation)
    if (to === lc(TAP10_SEALS[chainId].circuitBeacon) && fn === 'owner') return sealAnswer(st.seal.beaconOwner)
    if (to === lc(c.factory) && fn === 'isSealed') return sealAnswer(st.seal.factorySealed)
    if (to === lc(c.hub) && fn === 'isSealed') return sealAnswer(st.seal.hubSealed)
    if (to === lc(c.hub) && fn === 'owner') return sealAnswer(st.seal.hubOwner)
    if (RAW[String(call.data).slice(0, 10).toLowerCase()]) return revert(req)
    const args = fn ? Array.from(decodeCall(fn, call.data)) : []
    if (to === lc(c.factory) && fn === 'cpuCount') return reply(req, encodeReturn('cpuCount', [BigInt(st.processors.length)]))
    if (to === lc(c.factory) && fn === 'cpuAt') {
      const n = Number(args[0])
      return n < st.processors.length ? reply(req, encodeReturn('cpuAt', [st.processors[n]])) : revert(req)
    }
    if (to === lc(c.opener) && fn === 'accountOf') return reply(req, encodeReturn('accountOf', [chain.containerOf(args[0], args[1])]))
    if (to === lc(c.opener) && fn === 'isOpened') return reply(req, encodeReturn('isOpened', [st.opened.get(key(args[0], args[1])) ?? true]))
    if (to === lc(c.binding)) {
      if (fn === 'isLive') return reply(req, encodeReturn('isLive', [st.live.has(`${args[0]}\n${lc(args[1])}`)]))
      if (fn === 'isContainerLive') {
        const v = st.containerLive.get(lc(args[0])) ?? st.defaultLive
        return v === 'revert' ? revert(req) : reply(req, encodeReturn('isContainerLive', [v === true]))
      }
      if (fn === 'containerPaidUntil') return reply(req, encodeReturn('containerPaidUntil', [BigInt(st.paidUntil.get(lc(args[0])) ?? 0)]))
      if (fn === 'monthlyFee') return reply(req, encodeReturn('monthlyFee', [st.fee]))
      return revert(req)
    }
    return inner(url, init)
  }
  chain.fetch = async (url, init = {}) => (Array.isArray(JSON.parse(init.body)) ? eachCall(url, init, one) : one(url, init))
  chain.fetchWith = (real = globalThis.fetch.bind(globalThis)) => (url, init) => (String(url).startsWith('http://rpc') ? chain.fetch(String(url), init) : real(url, init))
  return chain
}

// The three TapeOut chains behind one fetch, routed by URL (http://rpc<chainId>-<a|b|c>, three operators each), for input
// without chain information (allChains, TAP-10 §4.1). `options()` gives createTapeAPI options with every chain's nodes;
// `down(id)` makes every node of a chain fail; `sent(id)` counts the requests that reached a chain.
// 三条 TapeOut 链共用一个 fetch，按 URL 路由（每条链三家运营方），用于无链信息的输入（allChains）。options() 给出带各链节点的
// createTapeAPI 选项；down(id) 让一条链的所有节点失败；sent(id) 统计到达某条链的请求数。
export function createConformWorlds({ processors = {}, headTime } = {}) {
  const chains = Object.fromEntries([56, 196, 8453].map((id) => [id, createConformChain({ chainId: id, processors: processors[id] })]))
  if (headTime !== undefined) for (const c of Object.values(chains)) c.state.headTime = headTime
  const urls = (id) => ['a', 'b', 'c'].map((x) => `http://rpc${id}-${x}`)
  const fetch = async (url, init) => {
    const m = /^http:\/\/rpc(\d+)-/.exec(String(url))
    if (!m || !chains[m[1]]) throw new Error(`offline: no route to ${url}`)
    return chains[m[1]].fetch(String(url), init)
  }
  const options = (o = {}) => ({ rpcUrls: urls(56), fetch, chains: { 196: { rpcUrls: urls(196) }, 8453: { rpcUrls: urls(8453) } }, ...o })
  const down = (id, kind = 'http500') => { for (const u of urls(id)) chains[id].setFault(u, kind) }
  const sent = (id) => chains[id].conform.log.length
  return { chains, fetch, urls, options, down, sent }
}

export { ADDR, ZERO_ADDRESS }
