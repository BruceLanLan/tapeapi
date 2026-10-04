// A complete local world for the container-agent example: the SDK's FAKE chain (a test helper: nothing is on BNB Smart Chain, nothing
// leaves this process), the principal container #11, the agent container #12 running agent.mjs, and two provider containers
// (#13 listed in the mandate, #14 not), each served in-process by createProvider (no ports). Used by hire.mjs and by the tests.
// FAKE KEYS, FOR THIS FAKE CHAIN ONLY: the holder and signer keys below are the test helper's fixtures (0x11…, 0x22…). They exist on no
// real chain and guard nothing. Never put a real wallet's key anywhere near this example, and never reuse one of these on a real chain.
// 容器代理示例的完整本地世界：SDK 的假链（测试辅助；链上什么都没有，也不出本进程）、委托方容器 #11、运行 agent.mjs 的代理容器 #12、
// 两个服务容器（#13 在授权书里，#14 不在），都由 createProvider 在进程内提供（不占端口）。**密钥是假链专用的夹具**：它们在任何真链上都不存在、
// 不保护任何东西；绝不要把真实钱包的私钥放进这个示例，也不要把这些密钥用到真链上。
import { readFileSync } from 'node:fs'
import { createProvider } from '@tapeapi/server'
import { abi } from '@tapeapi/sdk'
import { createAgentKit, EXECUTE_SELECTOR, TRANSFER_SELECTOR } from '@tapeapi/sdk/agent'
import { standardWorld, KEYS, addrOf, P, AG, S, S2, TOKEN, ADDR, NOW } from '../../sdk/test/helpers/agent-chain.mjs'
import { createAgentService } from './agent.mjs'

export { KEYS, P, AG, S, S2, TOKEN, ADDR, addrOf, NOW }
const { decodeParams, hexToBytes } = abi
const MANIFEST_PATH = '.well-known/tapeapi.json'
const AGENT_MANIFEST = JSON.parse(readFileSync(new URL('manifest.json', import.meta.url), 'utf8'))

// TIME. The world has one clock, fixed at the helper's NOW (2026-10-03) and moved only by world.advance(seconds): nothing in it reads the
// wall clock, so no result depends on which second a test runs in. The SDK clients, the agent runtime, hire.mjs and the payment order are
// handed `world.clock` explicitly. createProvider alone cannot be given a clock (it signs each answer with Date.now), so Date.now is held at
// the same time while a world is open, and world.close() puts the real one back. The fake chain's fixtures (delegations, manifests) are
// dated from the same NOW, which is also why a demo on real time would stop working one day: the fake chain has its own calendar.
// 时间：世界只有一个时钟，固定在夹具的 NOW，只由 world.advance 推进，不读墙钟。SDK 客户端、运行时、hire.mjs、付款顺序都显式拿到 world.clock；
// createProvider 无法注入时钟（它用 Date.now 签回答），所以世界开着时 Date.now 也被钉在同一时刻，world.close() 复原。
const realNow = Date.now
/** put the real Date.now back (a test's afterEach; world.close() does the same) */
export const restoreTime = () => { Date.now = realNow }
let clockS = NOW
const clock = () => clockS

/**
 * @param {object} o
 *   sameHolder   the agent container has the principal's holder (a self-hire: hire.mjs and the SDK both say so)
 *   agentOptions extra options for createAgentService (clock, maxCalls, tasks, ...)
 *   readMethod   the method the providers serve and the agent calls (default blockNumber, as examples/reader-service)
 */
export async function createDemoWorld({ sameHolder = false, agentOptions = {}, readMethod = 'blockNumber' } = {}) {
  clockS = NOW
  Date.now = () => clockS * 1000
  const x = standardWorld({ ...(sameHolder ? { agentHolderKey: KEYS.principalHolder } : {}), agentMember: AGENT_MANIFEST.agent })
  const rows = {}                                                      // host -> { calls: [{ method, params }] }
  const hosts = new Map()                                              // origin -> provider
  const manifestOf = (c) => JSON.parse(new TextDecoder().decode(x.chain.state.files.get(`${c.toLowerCase()}:${MANIFEST_PATH}`).bytes))
  // Each container gets its own origin and the methods it really serves; the delegation (container, signer, expires) is untouched
  // so it still verifies. / 每个容器有自己的源与真正提供的方法；委托不动，仍然有效。
  const rewrite = (c, origin, methods) => {
    const m = { ...manifestOf(c), endpoints: { live: [`${origin}/tapeapi/v1`], async: false }, methods }
    x.chain.writeFile(c, MANIFEST_PATH, JSON.stringify(m))
    return m
  }
  const free = (name) => ({ name, priceBEM: '0', params: {}, returns: {} })
  const mAG = rewrite(AG, 'https://agent.example', AGENT_MANIFEST.methods)
  const mS = rewrite(S, 'https://provider-1.example', [free(readMethod)])
  const mS2 = rewrite(S2, 'https://provider-2.example', [free(readMethod)])

  let head = 62_000_000
  const provider = (m, key, methods) => createProvider({ manifest: m, signerKey: key, dev: true, methods, rateLimit: false, log: () => {} })
  const tracked = (host, fn) => async (params, ctx) => { (rows[host] ??= { calls: [] }).calls.push({ params }); return fn(params, ctx) }
  hosts.set('https://provider-1.example', provider(mS, KEYS.providerSigner, { [readMethod]: tracked('provider-1', async () => ({ blockNumber: head++ })) }))
  hosts.set('https://provider-2.example', provider(mS2, KEYS.providerSigner, { [readMethod]: tracked('provider-2', async () => ({ blockNumber: head++ })) }))

  // one fetch for everything: the nodes of the fake chain, and each container's endpoint served in-process
  // 一个 fetch 管所有：假链的节点，以及每个容器在进程内提供的端点
  const requests = []
  const fetch = async (url, init) => {
    const u = String(url)
    requests.push(u)
    for (const [origin, p] of hosts) if (u.startsWith(origin + '/')) return p.handleRequest(new Request(u, init), { clientIp: '127.0.0.1' })
    return x.fetch(url, init)
  }
  const apiFor = () => x.api({ fetch, clock })
  const agentApi = apiFor()
  const service = createAgentService({ api: agentApi, container: AG, readMethod, clock, ...agentOptions })
  hosts.set('https://agent.example', provider(mAG, KEYS.agentSigner, service.methods))

  const principalApi = apiFor()
  const principalKit = createAgentKit(principalApi, { clock })

  // ---- the human with a wallet, simulated on the fake chain (the only part that is not the example's own code) ----
  // A real wallet signs and broadcasts the unsigned transaction a script printed and the human reads field by field. Here the fake chain
  // "includes" it: this decodes the transaction's own calldata (so a transaction that is not what was shown would not do what was shown) and
  // writes the result into the fake chain. Nothing is signed and nothing is broadcast. / 钱包里的人，在假链上模拟；不签名、不广播。
  const wallet = {
    holder: addrOf(KEYS.principalHolder),
    transfer(tx) {
      const block = x.st.block - 110
      const data = String(tx.data).toLowerCase()
      let payer = null, token = tx.to, inner = data, txTo = tx.to
      if (data.startsWith(EXECUTE_SELECTOR)) {              // through the principal's container: execute(token, 0, transfer(...), 0)
        const [to, , d] = decodeParams(['address', 'uint256', 'bytes', 'uint8'], hexToBytes('0x' + data.slice(10)))
        token = to; inner = String(d).toLowerCase(); payer = tx.to
      } else payer = wallet.holder
      if (!inner.startsWith(TRANSFER_SELECTOR)) throw new Error('the demo wallet only includes ERC-20 transfers')
      const [to, amount] = decodeParams(['address', 'uint256'], hexToBytes('0x' + inner.slice(10)))
      const hash = x.erc20Transfer({ token, payer, to, amount, wallet: wallet.holder, txTo, block })
      return { tx: hash, blockTime: x.timeOf(block) }
    },
    send(tx) {                                                // the hub's send(circuits, tokenId, to, ref, payload)
      const [, tokenId, to, ref, payload] = decodeParams(['address', 'uint256', 'bytes32', 'bytes32', 'bytes'], hexToBytes('0x' + String(tx.data).slice(10)))
      const from = x.st.accounts.get(String(tokenId))
      const recipient = abi.checksumAddress('0x' + String(to).slice(-40))
      const r = x.send({ from, wallet: wallet.holder, to: recipient, payload, ref, block: x.st.block - 100 })
      return { inboxIndex: r.index, tx: r.tx }
    },
  }
  return {
    x, keys: KEYS, clock, advance: (seconds) => { clockS += seconds }, close: restoreTime, fetch, requests, rows, service, hosts, wallet, principalApi, principalKit, agentApi, kit: service.kit,
    containers: { principal: P, agent: AG, provider: S, other: S2 }, token: TOKEN, readMethod,
    /** who the agent called: how many method calls each provider host answered / 代理调用了谁 */
    upstreamCalls: () => Object.fromEntries(Object.entries(rows).map(([h, r]) => [h, r.calls.length])),
  }
}
