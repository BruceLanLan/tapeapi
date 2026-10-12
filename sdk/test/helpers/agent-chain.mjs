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
  // phase 1, M3: opener.isOpened per #ID (default true), a container's execute as eth_call simulates it, ERC-20 allowances
  // 阶段 1 的 M3：按 #ID 的 isOpened（默认 true）、容器 execute 的模拟、ERC-20 额度
  const opened = new Map()      // `${tokenId}` -> boolean
  const executes = new Map()    // container (lowercase) -> { fee, gate, owner }
  const allowances = new Map()  // `${token}:${owner}:${spender}` (lowercase) -> bigint
  const simulations = []       // every simulated execute: { from, value, block } / 每次模拟的 execute
  const natives = new Map()     // address (lowercase) -> native coin balance (default 10 coins) / 原生币余额（默认 10 个）
  const accounts = new Map() // `${circuits}:${id}` (lowercase) -> container
  // review p1m3 recheck: escrows whose channels are their own (the shared fake keys channels by (consumer, provider) on
  // every escrow); escrow (lowercase) -> Map(`${consumer}:${provider}` -> { channel, claimed, pending, sessions })
  // 复核：通道按托管各自保存的托管（共享假链对所有托管只按 (consumer, provider) 保存）
  const ownChannels = new Map()
  let seq = 0
  const hash = () => '0x' + (++seq).toString(16).padStart(64, 'a')
  const timeOf = (n) => HEAD_TIME - (st.block - n)
  const CPU_COUNT = selector('cpuCount()'), CPU_AT = selector('cpuAt(uint256)')
  const IS_OPENED = selector('isOpened(address,uint256)'), EXECUTE = selector('execute(address,uint256,bytes,uint8)'), ALLOWANCE = selector('allowance(address,address)')
  const CHANNEL_OF = selector('channelOf(address,address)'), CLAIMED_OF = selector('claimedOf(address,address)'), SESSION_EXPIRY = selector('sessionExpiry(address,address,address)'), PENDING_WITHDRAW = selector('pendingWithdraw(address,address)')
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
      if (data.startsWith(IS_OPENED) && String(p[0].to).toLowerCase() === OPENER.toLowerCase()) {
        const [, id] = decodeParams(['address', 'uint256'], hexToBytes('0x' + data.slice(10)))
        return { result: u256(opened.get(String(id)) === false ? 0 : 1) }
      }
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
    // a container's execute (ERC-6551), as eth_call simulates it: owner only, the TapeOut fee or a revert
    // 0xafd49700(paid, required), then a gate (payment, listing) as raw revert data / 容器 execute 的模拟
    if (req.method === 'eth_call' && String(p[0].data).startsWith(EXECUTE) && executes.has(String(p[0].to).toLowerCase())) {
      const e = executes.get(String(p[0].to).toLowerCase())
      const paid = BigInt(p[0].value ?? 0)
      simulations.push({ from: String(p[0].from ?? '').toLowerCase(), value: paid, block: p[1] })
      const revert = (data) => ({ error: { code: 3, message: 'execution reverted', data } })
      // a value the sender cannot pay: what geth-style nodes answer, not a revert / 付不起的 value：节点答 insufficient funds，不是回滚
      if (paid > (natives.get(String(p[0].from ?? '').toLowerCase()) ?? 10n ** 19n)) return { error: { code: -32000, message: 'insufficient funds for gas * price + value' } }
      if (e.owner && String(p[0].from ?? '').toLowerCase() !== e.owner.toLowerCase()) return revert(selector('NotOwner()'))
      if (paid < BigInt(e.fee ?? 0)) return revert('0xafd49700' + u256(paid).slice(2) + u256(e.fee).slice(2))
      if (e.gate) return revert(e.gate)
      return { result: '0x' }
    }
    if (req.method === 'eth_call' && ownChannels.has(String(p[0].to).toLowerCase())) {
      const book = ownChannels.get(String(p[0].to).toLowerCase())
      const data = String(p[0].data)
      const of = (n) => { const a = decodeParams(Array(n).fill('address'), hexToBytes('0x' + data.slice(10))).map((v) => v.toLowerCase()); return { c: book.get(`${a[0]}:${a[1]}`) ?? { channel: 0n, claimed: 0n, pending: [0n, 0n], sessions: new Map() }, a } }
      if (data.startsWith(CHANNEL_OF)) return { result: u256(of(2).c.channel) }
      if (data.startsWith(CLAIMED_OF)) return { result: u256(of(2).c.claimed) }
      if (data.startsWith(PENDING_WITHDRAW)) { const c = of(2).c; return { result: u256(c.pending[0]) + u256(c.pending[1]).slice(2) } }
      if (data.startsWith(SESSION_EXPIRY)) { const { c, a } = of(3); return { result: u256(c.sessions.get(a[2]) ?? 0n) } }
    }
    if (req.method === 'eth_getBalance') return { result: '0x' + (natives.get(String(p[0]).toLowerCase()) ?? 10n ** 19n).toString(16) }
    if (req.method === 'eth_call' && String(p[0].data).startsWith(ALLOWANCE)) {
      const [o, sp] = decodeParams(['address', 'address'], hexToBytes('0x' + p[0].data.slice(10)))
      return { result: u256(allowances.get(`${String(p[0].to).toLowerCase()}:${o.toLowerCase()}:${sp.toLowerCase()}`) ?? 0n) }
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
    if (h?.error) return json({ jsonrpc: '2.0', id: req.id, error: h.error })
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
    chain, st, fetch, txs, inbox, decimals, timeOf, simulations,
    /** a node that answers differently: fn(method, params, honest) => answer / 撒谎的节点 */
    lie(url, fn) { if (fn) lies.set(url, fn); else lies.delete(url) },
    // ---- phase 1, M3 / 阶段 1 的 M3 ----
    setOpened(tokenId, yes) { opened.set(String(tokenId), yes) },
    /** the container's execute: { fee (the TapeOut fee, smallest unit), gate (revert data), owner (the only caller) } */
    setExecute(container, conf) { if (conf) executes.set(container.toLowerCase(), conf); else executes.delete(container.toLowerCase()) },
    /** the native coin balance of `a` (eth_getBalance; a simulated execute with more value fails) / 原生币余额 */
    setNative(a, v) { natives.set(a.toLowerCase(), BigInt(v)) },
    /** review p1m3 recheck: the channel (consumer, provider) on `escrow` alone; once called, every channel read on that
     *  escrow is answered from its own book (0 when not set) / 只属于该托管的通道；调用后该托管的通道读取都按它自己的账本作答 */
    escrowChannel(escrow, consumer, provider, { channel = '0', session = 0, pending = null, claimed = '0' } = {}, key = addrOf(KEYS.agentKey)) {
      const e = escrow.toLowerCase()
      if (!ownChannels.has(e)) ownChannels.set(e, new Map())
      const k = `${consumer.toLowerCase()}:${provider.toLowerCase()}`
      const c = ownChannels.get(e).get(k) ?? { channel: 0n, claimed: 0n, pending: [0n, 0n], sessions: new Map() }
      c.channel = BigInt(channel); c.claimed = BigInt(claimed); c.pending = pending ? [BigInt(pending[0]), BigInt(pending[1])] : [0n, 0n]
      c.sessions.set(key.toLowerCase(), BigInt(session))
      ownChannels.get(e).set(k, c)
    },
    setAllowance(token, owner, spender, v) { allowances.set(`${token.toLowerCase()}:${owner.toLowerCase()}:${spender.toLowerCase()}`, BigInt(v)) },
    /** a SessionAuthorized(consumer, provider, key, expires) log of `escrow` in block `block` / 托管的 SessionAuthorized 日志 */
    sessionLog({ escrow, consumer, provider, key, expires, block = st.block - 10 }) {
      const T = toHex(keccak256(utf8ToBytes('SessionAuthorized(address,address,address,uint64)')))
      st.logs.push({ address: escrow.toLowerCase(), topics: [T, pad(consumer), pad(provider), pad(key)], data: u256(expires), blockNumber: block, logIndex: st.logs.length, transactionHash: hash() })
    },
    // 1.x behaviour; 2.0 default is conform: 'tap10'
    api(extra = {}) { return createTapeAPI({ conform: false, rpcUrls: RPC, quorum: 2, chainId: 56, hub: ADDR.hub, siteRegistry: SITE_STORE, factory: ADDR.factory, fetch, onWarning: () => {}, clock: () => NOW, ...extra }) },
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
// ---------- phase 1 (experimental): escrows and channels / 阶段 1：托管与通道 ----------
export const BEM_TOKEN = '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a'   // the fake chain answers decimals() 8 for it
/** a service's manifest names `escrow` (payment.escrow), or none when null / 服务清单写上托管，null 为不写 */
export function nameEscrow(x, c, escrow) {
  const key = `${c.toLowerCase()}:.well-known/tapeapi.json`
  const m = JSON.parse(new TextDecoder().decode(x.st.files.get(key).bytes))
  if (escrow) m.payment = { escrow, unit: 'BEM', decimals: 8 }; else delete m.payment
  x.chain.writeFile(c, '.well-known/tapeapi.json', JSON.stringify(m))
}
/** an escrow contract: it has code (unless code false) and token() names `token` (null: no token()) / 托管合约 */
export function escrowContract(x, escrow, token, { code = true } = {}) { x.chain.setEscrowToken(escrow, token); x.chain.setCode(escrow, code) }
/** a channel (consumer, provider) as the escrow reports it; `key`'s session ends at `session` / 托管报告的一条通道 */
export function channelState(x, consumer, provider, { channel = '0', session = 0, pending = null, claimed = '0' } = {}, key = addrOf(KEYS.agentKey)) {
  x.chain.setChannel(consumer, provider, channel)
  x.chain.setSession(consumer, provider, key, session)
  if (pending) x.chain.setPendingWithdraw(consumer, provider, pending[0], pending[1])
  x.chain.setClaimed(consumer, provider, claimed)
}
export { ADDR, utf8ToBytes, bytesToHex }
