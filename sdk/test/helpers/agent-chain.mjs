// Container agents (1.7, experimental): a fake chain with what the shared fake does not model (transactions and
// receipts, the hub's inbox and Sent logs, ERC-20 decimals), plus fixtures: a principal container, an agent container
// with a resolvable manifest, provider containers, and builders for the six thread messages.
// Wraps createFakeChain; the shared helper is untouched. / 包装共享假链，不改动它。
import { createFakeChain, ADDR, eachCall, MAINNET_FACTORY } from './fake-chain.mjs'
import { CHAINS } from '../../src/chains.js'
import { createTapeAPI } from '../../src/index.js'
import * as sig from '../../src/sig.js'
import { encodeParams, decodeParams, hexToBytes, toHex, bytesToHex, keccak256, concatBytes, selector, utf8ToBytes } from '../../src/abi.js'
import { receiptOf, hashReceipt } from '../../src/mcp.js'
import { endpoint, encodePublic } from '../../src/tapesend.js'
import * as A from '../../src/agent-sig.js'
import { jsonHashOf, taskHashOf } from '../../src/agent-sig.js'
import { MANDATES_KEY, MANDATES_FORMAT } from '../../src/agent-verify.js'
import { SENT_TOPIC, TRANSFER_TOPIC, encodeContent } from '../../src/agent-pay.js'

export const RPC = ['http://rpc1', 'http://rpc2']
// The client reads the mainnet site store's address: the fake chain answers its ERC-1967 slot with an implementation
// TAP-10 accepts (chains.js expectedImpl), as the kit's TAP-10 §6.1 check requires. / 用主网站点存储地址：假链对其实现槽给出接受的实现
export const SITE_STORE = CHAINS[56].siteRegistry
// TAP-10 §4.3 step 4: the kit derives a container with the chain's container opener (chains.js), which this fake answers
// like the hub: by (circuits, #ID). / 开通器推导容器，与 hub 一样按 (电路, #ID) 作答
export const OPENER = CHAINS[56].opener
// The factory's processor table: numbers 0 to 7, number 7 the circuits of this chain (TAP-10 §4.3 step 3)
// 工厂的处理器表：0 到 7 号，7 号是本假链的电路
export const PROCESSOR_COUNT = 8
export const PROCESSOR = 7
export const HEAD_TIME = 1_800_000_000
export const KEYS = {
  principalHolder: '0x' + '11'.repeat(32), agentSigner: '0x' + '22'.repeat(32), agentHolder: '0x' + '44'.repeat(32),
  providerHolder: '0x' + '66'.repeat(32), providerSigner: '0x' + '55'.repeat(32), agentKey: '0x' + '77'.repeat(32), stranger: '0x' + '99'.repeat(32),
}
export const addrOf = (k) => sig.privateKeyToAddress(k)
export const P = '0x86DDaEF00401E3F10418398D67D7189fc458eA95'   // principal container, #11
export const AG = '0x' + 'a6'.repeat(20)                        // agent container, #12
export const S = '0x' + '5e'.repeat(20)                         // provider container, #13
export const S2 = '0x' + '5f'.repeat(20)                        // another provider, #14 (not in scope)
export const TOKEN = '0x' + 'b0'.repeat(20)                     // an ERC-20 / 一个 ERC-20
const pad = (a) => '0x' + '00'.repeat(12) + a.slice(2).toLowerCase()
const u256 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0')

export function createAgentChain({ circuits = ADDR.circuits } = {}) {
  const chain = createFakeChain({ addr: { ...ADDR, circuits } })
  chain.state.headTime = HEAD_TIME
  const st = chain.state
  const inbox = new Map()   // endpoint (lowercase hex) -> entries
  const txs = new Map()     // hash -> { tx, receipt }
  const decimals = new Map([[TOKEN.toLowerCase(), 18]])
  const lies = new Map()    // url -> (method, params, honest) => answer
  const accounts = new Map() // `${circuits}:${id}` (lowercase) -> container
  let seq = 0
  const hash = () => '0x' + (++seq).toString(16).padStart(64, 'a')
  const timeOf = (n) => HEAD_TIME - (st.block - n)
  const CPU_COUNT = selector('cpuCount()'), CPU_AT = selector('cpuAt(uint256)')
  const PATH_COUNT = selector('pathCount(address)'), ACCOUNT_OF = selector('accountOf(address,uint256)'), IS_CPU = selector('isCPU(address)'), INBOX_COUNT = selector('inboxCount(bytes32)'), INBOX_PAGE = selector('inboxPage(bytes32,uint256,uint256)'), DECIMALS = selector('decimals()')
  const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } })
  function honest(req) {
    const p = req.params
    if (req.method === 'eth_getTransactionReceipt') {
      const t = txs.get(String(p[0]).toLowerCase())
      return { result: t ? { transactionHash: p[0], status: '0x' + t.receipt.status.toString(16), blockNumber: '0x' + t.receipt.blockNumber.toString(16), logs: t.receipt.logs.map((l) => ({ ...l, blockNumber: '0x' + l.blockNumber.toString(16), logIndex: '0x' + l.logIndex.toString(16) })) } : null }
    }
    if (req.method === 'eth_getTransactionByHash') {
      const t = txs.get(String(p[0]).toLowerCase())
      return { result: t ? { hash: p[0], from: t.tx.from, to: t.tx.to, value: '0x' + BigInt(t.tx.value).toString(16), blockNumber: '0x' + t.receipt.blockNumber.toString(16) } : null }
    }
    const toFactory = req.method === 'eth_call' && [ADDR.factory, MAINNET_FACTORY].some((f) => f.toLowerCase() === String(p[0].to).toLowerCase())
    if (toFactory && p[0].data === CPU_COUNT) return { result: u256(PROCESSOR_COUNT) }
    if (toFactory && String(p[0].data).startsWith(CPU_AT)) {
      const [i] = decodeParams(['uint256'], hexToBytes('0x' + p[0].data.slice(10)))
      if (i < BigInt(PROCESSOR_COUNT)) return { result: pad(i === BigInt(PROCESSOR) ? circuits : '0x' + 'c0'.repeat(19) + i.toString(16).padStart(2, '0')) }
    }
    if (req.method === 'eth_call' && [ADDR.hub, OPENER].some((a) => a.toLowerCase() === String(p[0].to).toLowerCase())) {
      const data = p[0].data
      // Like the real hub (TAP-10 §13.5, Appendix A), accountOf derives an address for ANY #ID, minted or not; the shared
      // fake answers zero for an unknown #ID, which would hide a recipient that nobody holds. / 与真 hub 一致：任何 #ID 都推导地址
      if (data.startsWith(ACCOUNT_OF)) {
        const [c, id] = decodeParams(['address', 'uint256'], hexToBytes('0x' + data.slice(10)))
        // keyed by (circuits, #ID), as the hub derives it: a circuits/#ID mix-up is never found / 按 (电路, #ID) 查
        const known = accounts.get(`${c.toLowerCase()}:${id}`)
        return { result: pad(known ?? ('0x' + toHex(keccak256(utf8ToBytes(`derived:${c.toLowerCase()}:${id}`))).slice(26))) }
      }
      if (data.startsWith(INBOX_COUNT)) { const [to] = decodeParams(['bytes32'], hexToBytes('0x' + data.slice(10))); return { result: u256((inbox.get(to.toLowerCase()) ?? []).length) } }
      if (data.startsWith(INBOX_PAGE)) {
        const [to, start, n] = decodeParams(['bytes32', 'uint256', 'uint256'], hexToBytes('0x' + data.slice(10)))
        const list = (inbox.get(to.toLowerCase()) ?? []).slice(Number(start), Number(start) + Math.min(Number(n), 200))
        const words = [u256(32), u256(list.length), ...list.flatMap((e) => [pad(e.from), u256(e.blockNumber), u256(e.timestamp), e.digest])]
        return { result: '0x' + words.map((w) => w.slice(2)).join('') }
      }
    }
    // SiteRegistry.pathCount(container): how many files the container has (TAP-11 §2.2 step 3 picks a store by it)
    if (req.method === 'eth_call' && String(p[0].data).startsWith(PATH_COUNT)) {
      const [c] = decodeParams(['address'], hexToBytes('0x' + p[0].data.slice(10)))
      return { result: u256([...st.files.keys()].filter((k) => k.startsWith(c.toLowerCase() + ':')).length) }
    }
    // factory.isCPU: true only for the circuits this chain was made with (and not marked counterfeit), as the real factory
    // answers false for any other address / 工厂只认本假链配置的电路
    if (req.method === 'eth_call' && String(p[0].data).startsWith(IS_CPU) && [ADDR.factory, MAINNET_FACTORY].some((f) => f.toLowerCase() === String(p[0].to).toLowerCase())) {
      const [c] = decodeParams(['address'], hexToBytes('0x' + p[0].data.slice(10)))
      return { result: u256(c.toLowerCase() === circuits.toLowerCase() && !st.notCPU.has(c.toLowerCase()) ? 1 : 0) }
    }
    if (req.method === 'eth_call' && p[0].data === DECIMALS && decimals.has(String(p[0].to).toLowerCase())) return { result: u256(decimals.get(String(p[0].to).toLowerCase())) }
    return null
  }
  async function one(url, init) {
    const req = JSON.parse(init.body)
    const h = honest(req)
    const lie = lies.get(url)
    if (h) {
      const result = lie ? lie(req.method, req.params, h.result) : h.result
      return json({ jsonrpc: '2.0', id: req.id, result })
    }
    if (lie) {
      const r = await chain.fetch(url, init)
      const body = await r.json()
      const out = lie(req.method, req.params, body.result)
      if (out !== undefined) { delete body.error; body.result = out }
      return json(body)
    }
    return chain.fetch(url, init)
  }
  const fetch = (url, init) => (Array.isArray(JSON.parse(init.body)) ? eachCall(url, init, one) : one(url, init))

  const x = {
    chain, st, fetch, txs, inbox, decimals, timeOf,
    /** a node that answers differently: fn(method, params, honest) => answer / 撒谎的节点 */
    lie(url, fn) { if (fn) lies.set(url, fn); else lies.delete(url) },
    api(extra = {}) { return createTapeAPI({ rpcUrls: RPC, quorum: 2, chainId: 56, hub: ADDR.hub, siteRegistry: SITE_STORE, factory: ADDR.factory, fetch, onWarning: () => {}, clock: () => NOW, ...extra }) },
    container(c, tokenId, holderKey) { chain.setContainerToken(c, { tokenId, circuits }); x.setAccount(tokenId, c); chain.setOwner(tokenId, addrOf(holderKey)) },
    /** the hub's accountOf(circuits, tokenId); defaults to this chain's circuits / hub 的推导结果 */
    setAccount(tokenId, c, cs = circuits) { accounts.set(`${cs.toLowerCase()}:${tokenId}`, c); chain.setAccount(tokenId, c) },
    // a container with a resolvable TAP-11 manifest / 带可解析清单的容器
    service(c, tokenId, { holderKey, signerKey, name = 'svc', agent, expires = nowS() + 30 * 86400 } = {}) {
      x.container(c, tokenId, holderKey)
      const signer = addrOf(signerKey)
      const m = {
        tapeapi: '0.1', name, circuits, tokenId: String(tokenId), container: c, signer,
        delegation: { expires, sig: sig.signDigest(sig.delegationDigest(56, ADDR.hub, { container: c, signer, expires }), holderKey) },
        endpoints: { live: ['https://svc.example/tapeapi/v1'], async: false },
        methods: [{ name: 'task_offer', priceBEM: '0', params: {}, returns: {} }, { name: 'read', priceBEM: '0', params: {}, returns: {} }],
        ...(agent ? { agent } : {}),
      }
      chain.writeFile(c, '.well-known/tapeapi.json', JSON.stringify(m))
      return m
    },
    // ---- transactions / 交易 ----
    tx({ from, to, value = 0n, block, status = 1, logs = [] }) {
      const h = hash()
      const ls = logs.map((l, i) => ({ address: l.address.toLowerCase(), topics: l.topics.map((t) => t.toLowerCase()), data: l.data.toLowerCase(), blockNumber: block, logIndex: i, transactionHash: h }))
      txs.set(h, { tx: { from: from.toLowerCase(), to: to ? to.toLowerCase() : null, value: BigInt(value) }, receipt: { status, blockNumber: block, logs: ls } })
      return h
    },
    erc20Transfer({ token = TOKEN, payer, to, amount, wallet = payer, txTo = token, block, status = 1 }) {
      return x.tx({ from: wallet, to: txTo, block, status, logs: [{ address: token, topics: [TRANSFER_TOPIC, pad(payer), pad(to)], data: u256(amount) }] })
    },
    nativeTransfer({ wallet, to, amount, block, status = 1 }) { return x.tx({ from: wallet, to, value: BigInt(amount), block, status }) },
    // a TapeSend message: the inbox entry, the Sent log (in eth_getLogs and in the block's receipts) and its transaction
    send({ from, wallet, to, content, payload, ref = '0x' + '00'.repeat(32), block, txTo = ADDR.hub, extraLogs = [] }) {
      const ep = toHex(endpoint(to, 56)).toLowerCase()
      const pl = payload ?? encodePublic(content ?? encodeContent({ body: 'hello' }))
      const list = inbox.get(ep) ?? []; inbox.set(ep, list)
      const index = list.length
      const digest = toHex(keccak256(concatBytes(hexToBytes(ref), keccak256(pl))))
      list.push({ from, blockNumber: block, timestamp: timeOf(block), digest })
      const data = toHex(encodeParams(['uint256', 'uint256', 'bytes'], [BigInt(index), 0n, pl]))
      const sent = { address: ADDR.hub, topics: [SENT_TOPIC, ep, pad(from), ref], data }
      const h = x.tx({ from: wallet, to: txTo, block, logs: [sent, ...extraLogs] })
      const rec = txs.get(h).receipt.logs[0]
      st.logs.push({ ...rec })
      return { index, tx: h }
    },
  }
  return x
}
// One fixed "now" for every fixture and every client of these tests (createTapeAPI and createAgentKit get it as their
// clock): no assertion may depend on the wall clock, or a second boundary crossed under load makes a test fail at random.
// 所有夹具与客户端共用一个固定的"现在"：断言不得依赖墙钟，否则负载下跨秒边界会随机失败。
export const NOW = 1_791_000_000
export const nowS = () => NOW

// ---------- thread fixtures / 线程夹具 ----------
let receiptSeq = 0   // deterministic request ids / 确定性的请求 id
export const TASK = { kind: 'report.attested-read', spec: 'BEM holders at block 1', deliverables: ['report.json'], deadline: 1 }
const hub = ADDR.hub
export function offerMsg({ task = TASK, principal = P, agent = AG, exp = nowS() + 3600, nonce = '1', key = KEYS.principalHolder, mode = 0, ...rest } = {}) {
  const offer = { principal, agent, taskHash: taskHashOf(task), mode, feeToken: '0x' + '00'.repeat(20), fee: '0', deadline: nowS() + 86400, exp, nonce, ...rest }
  return { v: 0, kind: 'tape.agent/offer', task, offer, sig: A.signTaskOffer(56, hub, offer, key) }
}
export function agentReceipt({ kind, result, method, params = {}, ts = nowS(), container = AG, signerKey = KEYS.agentSigner, tokenId = 12, circuits = ADDR.circuits }) {
  const body = { kind: 'tape.agent/' + kind, ...result }
  const id = 'r-' + (++receiptSeq)
  const env = { container, id, ts, ok: true, result: body, sig: sig.signResponse({ container, id, method, params, ok: true, body, ts }, signerKey) }
  return receiptOf({ envelope: env, method, params, circuits, tokenId })
}
export function acceptMsg({ offerHash, agentKey = addrOf(KEYS.agentKey), exp = nowS() + 3600, ...o }) {
  return { v: 0, kind: 'tape.agent/accept', receipt: agentReceipt({ kind: 'accept', method: 'task_offer', params: { offerHash }, result: { offerHash, agentKey, exp }, ...o }) }
}
export function mandateOf({ principal = P, agent = AG, agentKey = addrOf(KEYS.agentKey), task = TASK, scope = [{ provider: S, token: '0x' + '00'.repeat(20), cap: '0' }], feeCap = '0', notBefore = nowS() - 60, expires = nowS() + 86400, nonce = '1', subdelegate = false, mode = 0 } = {}) {
  return { principal, agent, agentKey, mode, taskHash: taskHashOf(task), scope, feeToken: '0x' + '00'.repeat(20), feeCap, notBefore, expires, nonce, subdelegate }
}
// fixtures sign any mandate (allowFunds): what is under test is the verifier / 夹具可签任何授权书：被测的是核验方
export function mandateMsg(m = mandateOf(), key = KEYS.principalHolder) { return { v: 0, kind: 'tape.agent/mandate', mandate: m, sig: A.signMandate(56, hub, m, key, { allowFunds: true }) } }
export function providerReceipt({ container = S, signerKey = KEYS.providerSigner, ts = nowS(), method = 'read', params = { block: 1 }, result = { holders: 3 }, tokenId = 13 } = {}) {
  const id = 'p-' + (++receiptSeq)
  const env = { container, id, ts, ok: true, result, sig: sig.signResponse({ container, id, method, params, ok: true, body: result, ts }, signerKey) }
  return hashReceipt(receiptOf({ envelope: env, method, params, circuits: ADDR.circuits, tokenId }))
}
export function deliverMsg({ mandateHash, receipts = [providerReceipt()], deliverable = { report: 'three holders' }, exp = nowS() + 3600, receiptsHash, ...o }) {
  const result = { mandateHash, deliverableHash: jsonHashOf(deliverable), receiptsHash: receiptsHash ?? jsonHashOf(receipts), receipts, exp }
  return { v: 0, kind: 'tape.agent/deliver', receipt: agentReceipt({ kind: 'deliver', method: 'task_deliver', params: { mandateHash }, result, ...o }) }
}
export function verdictMsg({ mandateHash, deliverableHash, verdict = 1, issued = nowS(), key = KEYS.principalHolder }) {
  const v = { mandateHash, deliverableHash, verdict, reasonHash: '0x' + '00'.repeat(32), issued }
  return { v: 0, kind: 'tape.agent/acceptance', verdict: v, sig: A.signTaskVerdict(56, hub, v, key) }
}
export function revocationMsg({ principal = P, mandateHashes = [], revokedBefore = 0, issued = nowS(), key = KEYS.principalHolder }) {
  const r = { principal, mandateHashes, revokedBefore, issued }
  return { v: 0, kind: 'tape.agent/revocation', revocation: r, sig: A.signMandateRevocation(56, hub, r, key) }
}
export function revocationFile(x, { principal = P, mandateHashes = [], revokedBefore = 0, issued = nowS(), key = KEYS.principalHolder, mutate } = {}) {
  const r = { principal, mandateHashes, revokedBefore, issued }
  let f = { 'tapeapi-mandates': MANDATES_FORMAT, chainId: 56, revocation: r, sig: A.signMandateRevocation(56, hub, r, key) }
  if (mutate) f = mutate(f)
  x.chain.writeFile(principal, MANDATES_KEY, JSON.stringify(f))
  return f
}
/** principal #11, agent #12 (own holder, signer), provider #13 in scope, provider #14 outside it */
export function standardWorld(opts = {}) {
  const x = createAgentChain(opts)
  x.container(P, 11, KEYS.principalHolder)
  x.service(AG, 12, { holderKey: opts.agentHolderKey ?? KEYS.agentHolder, signerKey: opts.agentSignerKey ?? KEYS.agentSigner, name: opts.agentName ?? 'Report agent', agent: opts.agentMember })
  x.service(S, 13, { holderKey: KEYS.providerHolder, signerKey: KEYS.providerSigner, name: 'Provider' })
  x.service(S2, 14, { holderKey: KEYS.providerHolder, signerKey: KEYS.providerSigner, name: 'Other provider' })
  return x
}
/** offer -> accept -> mandate -> deliver -> acceptance, all valid; returns the messages and their hashes */
export function happyThread({ m = mandateOf(), deliverOpts = {}, verdict = 1 } = {}) {
  const offer = offerMsg({ mode: m.mode })
  const offerHash = A.offerHashOf(56, hub, offer.offer)
  const accept = acceptMsg({ offerHash, agentKey: m.agentKey })
  const mandate = mandateMsg(m)
  const mandateHash = A.mandateHashOf(56, hub, m)
  const deliver = deliverMsg({ mandateHash, ...deliverOpts })
  const acceptance = verdictMsg({ mandateHash, deliverableHash: deliver.receipt.result.deliverableHash, verdict })
  return { offer, accept, mandate, deliver, acceptance, offerHash, mandateHash, messages: [offer, accept, mandate, deliver, acceptance] }
}
export { ADDR, utf8ToBytes, bytesToHex }
