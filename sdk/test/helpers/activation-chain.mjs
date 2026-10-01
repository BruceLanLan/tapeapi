// 在假链外面包一层 DomainBinding 的激活读取（TAP-10 §6.3）：isLive、isContainerLive、containerPaidUntil、monthlyFee。
// fake-chain.mjs 本身不动（别的测试也在用）；这里只在 fetch 层截住发往本链 DomainBinding 的 eth_call，其余原样交给假链。
// A DomainBinding on top of the fake chain (TAP-10 §6.3): isLive, isContainerLive, containerPaidUntil, monthlyFee. The fake
// chain itself is untouched (other tests use it); this wraps its fetch and answers only the eth_calls sent to the chain's
// DomainBinding, everything else goes to the fake chain as before.
//
// Default: the container is activated (isContainerLive true, paid for 30 days), so a test that is not about activation
// sees every check pass. setActivation() changes it:
//   names           [[on-chain name, container], ...] for which isLive is true (the name must match character for character)
//   containerLive   true | false | 'revert'  ('revert': an implementation that lacks isContainerLive, TAP-10 §6.3)
//   isLiveReverts   true: isLive itself reverts
//   paidUntil       containerPaidUntil, seconds (0: never paid)
//   fee             monthlyFee, wei; null: the call reverts
//   failure         null | 'http500' | 'rpcerror': every DomainBinding read fails at the node (a network failure), nothing else
import { createFakeChain, eachCall } from './fake-chain.mjs'
import { functionBySelector, decodeCall, encodeReturn } from '../../src/abi.js'
import { CHAINS } from '../../src/chains.js'

const FNS = new Set(['isLive', 'isContainerLive', 'containerPaidUntil', 'monthlyFee'])
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })

export function createActivationChain(opts = {}) {
  const chain = createFakeChain(opts)
  const chainId = opts.chainId ?? 56
  const binding = CHAINS[chainId].binding.toLowerCase()
  const act = { names: new Set(), containerLive: true, isLiveReverts: false, paidUntil: Math.floor(Date.now() / 1000) + 30 * 86_400, fee: 10n ** 16n, failure: null, calls: [] }
  const key = (name, container) => `${name}\n${container.toLowerCase()}`
  chain.activation = act
  chain.binding = binding
  chain.setActivation = ({ names, ...rest } = {}) => {
    if (names) act.names = new Set(names.map(([n, c]) => key(n, c)))
    Object.assign(act, rest)
  }
  /** Not activated: both reads false, the fee 0.01 coin. / 未激活：两个读取都为假。 */
  chain.setUnactivated = (rest = {}) => chain.setActivation({ names: [], containerLive: false, paidUntil: 0, ...rest })

  const revert = (req) => json({ jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted' } })
  const reply = (req, result) => json({ jsonrpc: '2.0', id: req.id, result })
  const inner = chain.fetch
  async function one(url, init) {
    const req = JSON.parse(init.body)
    const call = req.method === 'eth_call' ? req.params?.[0] : null
    const fn = call && String(call.to).toLowerCase() === binding ? functionBySelector(call.data) : null
    // A node fault of the fake chain (timeout, disagree, ...) applies as to any read: the fake chain answers it / 节点故障照旧由假链处理
    if (!fn || !FNS.has(fn) || chain.state.faults.has(url)) return inner(url, init)
    const args = Array.from(decodeCall(fn, call.data))
    act.calls.push({ url, fn, args })
    if (act.failure === 'http500') return new Response('boom', { status: 500 })
    if (act.failure === 'rpcerror') return json({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'node says no' } })
    switch (fn) {
      case 'isLive':
        if (act.isLiveReverts) return revert(req)
        return reply(req, encodeReturn('isLive', [act.names.has(key(args[0], args[1]))]))
      case 'isContainerLive':
        if (act.containerLive === 'revert') return revert(req)
        return reply(req, encodeReturn('isContainerLive', [act.containerLive === true]))
      case 'containerPaidUntil': return reply(req, encodeReturn('containerPaidUntil', [BigInt(act.paidUntil)]))
      case 'monthlyFee':
        if (act.fee === null) return revert(req)
        return reply(req, encodeReturn('monthlyFee', [BigInt(act.fee)]))
      default: return revert(req)
    }
  }
  chain.fetch = async (url, init = {}) => (Array.isArray(JSON.parse(init.body)) ? eachCall(url, init, one) : one(url, init))
  chain.fetchWith = (real = globalThis.fetch.bind(globalThis)) => (url, init) => (String(url).startsWith('http://rpc') ? chain.fetch(String(url), init) : real(url, init))
  return chain
}
