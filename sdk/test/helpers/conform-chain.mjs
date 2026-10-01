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
//   ERC-1967 slots                 the fake chain's: chains.js expectedImpl unless setImplementation (useLegacyBinding()
//                                  puts the previous DomainBinding 0x4E8684Ea… in place and makes isContainerLive revert).
// Every request is logged in `log` as { url, method, to, fn, block } (block: the block parameter of a state read).
import { createFakeChain, eachCall, ADDR } from './fake-chain.mjs'
import { functionBySelector, decodeCall, encodeReturn, ZERO_ADDRESS } from '../../src/abi.js'
import { CHAINS } from '../../src/chains.js'
import { erc6551Account } from '../../src/security.js'

export const LEGACY_BINDING = '0x4e8684eaea48b524245b2191dee451eaa1c1ca94'   // BSC DomainBinding before 2026-09-13, no isContainerLive
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
    paidUntil: new Map(), fee: 0n, heads: new Map(), chainIds: new Map(), log: [],
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
    setHeadLag(url, n) { if (n) st.heads.set(url, n); else st.heads.delete(url) },
    setChainIdAnswer(url, id) { if (id == null) st.chainIds.delete(url); else st.chainIds.set(url, id) },
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
    const fn = call ? functionBySelector(call.data) : null
    const blockArg = { eth_call: 1, eth_getCode: 1, eth_getStorageAt: 2 }[req.method]
    st.log.push({ url, method: req.method, to: to ?? (req.method === 'eth_getStorageAt' ? lc(req.params[0]) : null), fn, block: blockArg === undefined ? null : (req.params?.[blockArg] ?? 'latest') })
    // A node fault of the fake chain applies as to any read: the fake chain answers it / 节点故障照旧由假链处理
    if (chain.state.faults.has(url)) return inner(url, init)
    if (req.method === 'eth_blockNumber') return reply(req, '0x' + (chain.state.block - (st.heads.get(url) ?? 0)).toString(16))
    if (req.method === 'eth_chainId' && st.chainIds.has(url)) return reply(req, '0x' + st.chainIds.get(url).toString(16))
    if (!call) return inner(url, init)
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

export { ADDR, ZERO_ADDRESS }
