// A container agent's runtime, phase 0 (EXPERIMENTAL, 1.7): four TapeAPI methods built on `@tapeapi/sdk/agent`.
//   task_offer    verify the principal's signed offer, announce a FRESH agentKey for this order, answer with a signed accept
//   task_mandate  verify the signed mandate (createAgentKit.verifyMandate); only an `ok` one starts the work
//   task_deliver  the signed delivery: deliverable hash, hash-only receipts of every upstream call, their hash
//   task_status   where an order stands; the deliverable itself, and a signed revocation message, travel here
// Phase 0 has NO enforcement: a mandate is the holder's signed, checkable statement and nothing stops this agent (or an
// upstream) from doing anything. This runtime follows it because it is written to, and says so (`enforcement: 'none'`).
// Not a createProvider feature and not part of server/src: `ctx.call` below is this example's own wrapper.
// 容器代理的运行时（阶段 0，实验性）：基于 @tapeapi/sdk/agent 的四个方法。阶段 0 没有任何强制执行：授权书是持有人签的、可核验的
// 声明，没有东西阻止代理或上游做任何事；本运行时照它办事，是因为它被这样写，并如实说明。`ctx.call` 是本示例自己的包装，不是
// createProvider 的功能，也不在 server/src 里。
//
// What this file never does / 本文件从不做的事:
//   - take an instruction from task text, from a deliverable or from an upstream answer: all of it is DATA, rendered with
//     plainText (TAP-10 §16) wherever a person or a log could read it, and never used to choose a service, a method or an address;
//   - call a container that is not in mandate.scope[].provider (ctx.call refuses it before any request is made);
//   - sign a `tape.agent/*` result for a revoked or no-longer-valid mandate;
//   - keep or use the agentKey's secret: phase 0 only BINDS the key (nothing asks the agent to sign with it), so the secret
//     is dropped the moment its address is derived, and one key is made per order and never again.
import { sig, abi, mcp } from '@tapeapi/sdk'
import { createAgentKit, plainText, jsonHashOf, taskHashOf, normalizeTaskOffer, normalizeMandate, createSpendLimiter, spendStatement, hashOnlyReceiptProblem, FUNDING_PATHS } from '@tapeapi/sdk/agent'

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const HASH32 = /^0x[0-9a-fA-F]{64}$/
const KIND_RE = /^[a-z0-9][a-z0-9._/-]{0,63}$/

/** An error a consumer reads: BAD_REQUEST (a code the provider runtime knows) with the reasons in `data`. */
export function refuse(reason, message, data = {}) {
  return Object.assign(new Error(String(message).slice(0, 400)), { code: 'BAD_REQUEST', data: { reason, enforcement: 'none', ...data } })
}
const codesOf = (problems) => problems.map((p) => p.code).join(', ')
const brief = (problems) => problems.slice(0, 8).map((p) => ({ code: p.code, message: String(p.message).slice(0, 300) }))

/**
 * The receipt of one api.call(): a TAPI-21 v1 receipt (service identity, request, answer, signature) that anyone can check
 * again. The agent's own `accept` and `deliver` messages are such receipts; so, in hash-only form (mcp.hashReceipt), is the
 * evidence of every upstream call. / 一次 api.call() 的回执。
 */
export function receiptOfCall(svc, method, params, r) {
  return mcp.receiptOf({
    envelope: { container: svc.container, id: r.id, ts: r.ts, ok: true, result: r.result, ...(r.block != null ? { block: r.block } : {}), sig: r.sig },
    method, params, circuits: svc.manifest.circuits, tokenId: svc.manifest.tokenId,
  })
}

/**
 * The example task: read the block height from every provider the mandate lists and answer with all of it. Deterministic,
 * harmless and free: the method is fixed here (default `blockNumber`, as examples/reader-service serves it), never taken from
 * the task text, and the numbers it gets back are only numbers.
 * 示例任务：向授权书列出的每个服务读区块高度，把全部答案交上。方法在这里写死，不取自任务文本；拿回来的只是数字。
 */
export function blockHeightTask({ readMethod = 'blockNumber' } = {}) {
  return {
    needsProviders: true,
    async run(task, ctx) {
      if (task.chain !== undefined && task.chain !== 'bsc') throw refuse('unsupported-chain', `this agent reads BNB Smart Chain only, not ${plainText(String(task.chain), 32)}`)
      const answers = []
      for (const [i, provider] of ctx.providers.entries()) {
        // phase 1, restart: the providers called before a restart are not called (paid) again; their receipts are kept,
        // their answers were not (receipts are hash-only), so they are listed without a number
        // 阶段 1 的重启：重启前已调用的 provider 不再调用（不再付费）；回执保留、答案没有（回执只含哈希），列出但不写数字
        if (i < ctx.resumed.calls) { answers.push({ provider, blockNumber: null, answeredBeforeRestart: true }); continue }
        const r = await ctx.call(provider, readMethod, {})
        const n = r?.blockNumber
        if (!Number.isSafeInteger(n) || n < 0) throw refuse('bad-upstream-answer', `${provider} did not answer a block number`)
        answers.push({ provider, blockNumber: n })
      }
      const numbers = answers.map((a) => a.blockNumber).filter((n) => n !== null)
      return { kind: 'chain.block-height', chain: 'bsc', blockNumber: numbers.length ? Math.max(...numbers) : null, answers }
    },
  }
}

/**
 * @param {object} o
 *   api            a createTapeAPI() client with rpcUrls (strict agreement needs nodes of two operators): reads the chain
 *                  for the mandate checks and resolves and calls the providers in scope
 *   container      this agent's own container (the offer must name it, the mandate must name it)
 *   kit            createAgentKit(api, ...) (default: one made from `api`)
 *   tasks          { [kind]: { needsProviders?, run(task, ctx) } } (default: the block-height task)
 *   clock          () => Unix seconds
 *   acceptTtlS     how long an accept stays open for the mandate (default 3600)
 *   deliverTtlS    how long a delivery waits for a verdict (default 86400)
 *   maxOrders, maxCalls  bounds: orders kept in memory, upstream calls per order
 *   log            (line) => void; counterparty text in it is always plainText
 *   spend          @experimental phase 1 (M4, local chains only; the internal phase-1 draft, the agent's own limit):
 *                  { allowEscrows, store, maxCallPrice }. Without it this runtime is phase 0 exactly. With it, a
 *                  mandate that names funds is checked with { enforcement: 'escrow-channel' } (the escrows in allowEscrows
 *                  only: none is audited), the order's agentKey signs vouchers for the providers' priced methods through
 *                  api.payer({ consumer, sessionKey: agentKey }) wrapped by createSpendLimiter (records in `store`):
 *                  per provider no more than the cap from the channel's claimedOf at the start, at most maxCallPrice a
 *                  call (one amount, or { [provider]: amount }; a provider without one gets 10% of its cap, rounded
 *                  down, and none at all when that is 0: set it then; at most the cap; a price above it refuses the
 *                  call and never stops the order), the channel the work started on only; every call is preceded by the check again, and a provider
 *                  that names another escrow, another consumer or a revoked or expired mandate stops the order.
 *                  The key's secret is kept for such an order only, and dropped at delivery, revocation or stop.
 *                  With `vault` too (phase 1, restart: a KeyVault, e.g. passphraseKeyVault from state.mjs's
 *                  persistenceFromEnv) and a persistent `store`, each spend order survives a restart: its agent key is
 *                  kept SEALED in the store (never in the clear), and so is the order's record (offer and task text,
 *                  mandate, receipts, deliverable), sealed by the same vault for its chain, container, offer, key and
 *                  task, so that a record changed on disk does not open; with the payer's counters. recover() on a new
 *                  runtime over the same store (call it before serving: until it has run, every method refuses,
 *                  `recovering`) resumes every order whose record, sealed key and a fresh check agree (the limiter's
 *                  resume), and never one that was stopped, revoked or expired. The sealed key and the record are
 *                  destroyed when the order ends (delivered, revoked, stopped, failed). Without a vault nothing is
 *                  persisted. The store must never be restored from a backup or a snapshot (the internal phase-1
 *                  draft §10.9.3: a rollback revives what was stopped, revoked or delivered).
 */
export function createAgentService({ api, container, kit, tasks, clock = () => Math.floor(Date.now() / 1000), acceptTtlS = 3600, deliverTtlS = 86_400, maxOrders = 1000, maxCalls = 8, readMethod, log = () => {}, spend } = {}) {
  if (!api || !abi.isAddress(container)) throw new Error('createAgentService needs { api, container }')
  // phase 1 (M4, experimental): the escrows to trust (none is audited) and the spend limiter / 阶段 1：信任的托管与花费限额器
  const chainId = Number(api.chainId)
  // phase 1, restart: with a vault (and a persistent store) every spend order is kept sealed across a restart
  // 阶段 1 的重启：有保险箱（与持久化存储）时每个 spend 单跨重启保存（钥匙只以密文）
  const persist = Boolean(spend?.vault)
  if (persist && !spend.store) throw new Error('spend.vault needs spend.store: a store that outlives the process')
  const limiter = spend ? createSpendLimiter({ store: spend.store, clock, ...(persist ? { vault: spend.vault } : {}) }) : null
  // review p1-restart: maxCallPrice is checked here by the limiter's own rule (a payer over a stand-in that signs nothing),
  // so that a bad one fails at construction, never after an order started / 审查 p1-restart：构造时就用限额器自己的规则检查 maxCallPrice
  if (limiter && spend.maxCallPrice != null) createSpendLimiter({}).payer({ chainId: chainId > 0 ? chainId : 1, payer: { reserve() {}, cumulativeOf() {}, signer: container, consumer: container }, maxPrice: spend.maxCallPrice })
  // the payer's counters live in the same store, so that a resumed payer carries on from what it signed / 付款器计数也在同一存储
  const payerStore = persist ? { get: (k) => spend.store.get(`tapeapi-agent-payer:${k}`), set: (k, v) => spend.store.set(`tapeapi-agent-payer:${k}`, v) } : undefined
  kit ??= spend ? createAgentKit(api, { clock, allowEscrows: spend.allowEscrows ?? [] }) : createAgentKit(api, { clock })
  tasks ??= { 'chain.block-height': blockHeightTask({ readMethod }) }
  const orders = new Map()        // offerHash -> order
  const byMandate = new Map()     // mandateHash -> order
  const issuedKeys = new Set()    // every agentKey ever announced: never announced twice
  const mine = (a) => abi.eqAddr(a, container)
  // review p1-restart: with persistence, nothing is served until recover() has run once: a request served before it would
  // give a kept offer a second key (one order, one key) / 审查 p1-restart：持久化时 recover() 跑完之前不服务（否则同一报价会拿到第二把钥匙）
  let recovered = false

  const orderOf = (hash, what) => {
    if (typeof hash !== 'string' || !HASH32.test(hash)) throw refuse('bad-request', `${what} must be a 32-byte 0x hash`)
    return (what === 'mandateHash' ? byMandate : orders).get(hash.toLowerCase())
  }
  const signedMandate = (order) => ({ mandate: order.mandateMsg.mandate, sig: order.mandateMsg.sig })
  // phase 1: a funded order's checks ask for escrow-channel enforcement on the path the principal funded / 阶段 1 的核验选项
  const spendOpts = (order) => (order.spend ? { enforcement: 'escrow-channel', fundingPath: order.fundingPath } : {})
  // the key's secret and its payer are dropped once nothing more is to be signed / 不再签名时丢掉钥匙与付款器
  // (the secret lives here, never on the order object that order() hands out) / 密钥只在这里，不在 order() 交出的对象上
  const secrets = new WeakMap()
  const dropKey = (order) => { secrets.delete(order); if (order.spend) order.payer = null }   // a phase-0 order is left as it was

  // ---- phase 1, restart: the order's record on the store, sealed (the key is the limiter's, sealed apart) ----
  // review p1-restart: the record is sealed by the vault too (AEAD), for the context of this chain, container, offer,
  // agent key and task: a record changed on disk, or another order's record copied over it, does not open, so nothing in
  // it (receipts, deliverable) is ever signed as this agent's own unless this runtime wrote it. On disk:
  // { v: 2, offerHash, agentKey, taskHash, sealed } (the three names in the clear are the context; changing one only makes
  // the record not open). The index of offer hashes stays in the clear: an entry without a record is dropped.
  // 阶段 1 的重启：订单记录也由保险箱封存（AEAD），context 绑定链、容器、报价、代理钥匙与任务：盘上被改或换成别单的记录打不开，
  // 记录里的回执、交付物只有本运行时写的才会被签成自己的。盘上：{ v: 2, offerHash, agentKey, taskHash, sealed }（明文的三项就是
  // context，改了只会打不开）。offer 哈希的索引保持明文：没有记录的索引项被删除。
  const ORDER_RECORD_V = 2
  const orderKey = (h) => `tapeapi-agent-order:${chainId}:${container.toLowerCase()}:${h}`
  const indexKey = `tapeapi-agent-orders:${chainId}:${container.toLowerCase()}`
  const orderContext = ({ offerHash, agentKey, taskHash }) => `tapeapi-agent-order/v1/${chainId}/${container.toLowerCase()}/${offerHash}/${agentKey.toLowerCase()}/${taskHash}`
  const utf8 = new TextEncoder(), fromUtf8 = new TextDecoder('utf-8', { fatal: true })
  let storeQueue = Promise.resolve()
  const inStore = (fn) => { const p = storeQueue.then(fn, fn); storeQueue = p.catch(() => {}); return p }
  async function readIndex() {
    const raw = await spend.store.get(indexKey)
    if (raw == null || raw === '') return []
    const list = JSON.parse(raw)
    if (!Array.isArray(list) || !list.every((h) => typeof h === 'string' && HASH32.test(h))) throw new Error('the order index is not a list of offer hashes')
    return list
  }
  const recordOf = (order) => ({
    v: ORDER_RECORD_V, offerHash: order.offerHash, offerMsg: order.offerMsg, agentKey: order.agentKey, acceptExp: order.acceptExp, state: order.state, revocations: order.revocations,
    ...(order.mandateMsg ? { mandateMsg: order.mandateMsg, mandateHash: order.mandateHash, fundingPath: order.fundingPath } : {}),
    receipts: order.receipts ?? order.partialReceipts ?? [],
    ...(order.state === 'ready' ? { deliverable: order.deliverable } : {}),
  })
  async function saveOrder(order) {
    if (!order.persisted) return
    const rec = JSON.stringify(recordOf(order))
    const names = { offerHash: order.offerHash, agentKey: order.agentKey.toLowerCase(), taskHash: order.offer.taskHash }
    await inStore(async () => {
      // sealed in the queue, so that the records are written in the order they were saved / 在队列里封存，按保存顺序写入
      const sealed = await spend.vault.seal(utf8.encode(rec), { context: orderContext(names) })
      if (typeof sealed !== 'string' || sealed === '') throw new Error('the key vault must seal to a non-empty string')
      await spend.store.set(orderKey(order.offerHash), JSON.stringify({ v: ORDER_RECORD_V, ...names, sealed }))
      const list = await readIndex()
      if (!list.includes(order.offerHash)) { list.push(order.offerHash); await spend.store.set(indexKey, JSON.stringify(list)) }
    })
  }
  async function dropRecord(offerHash) {
    await inStore(async () => {
      if (typeof spend.store.delete === 'function') await spend.store.delete(orderKey(offerHash)); else await spend.store.set(orderKey(offerHash), '')
      const list = await readIndex()
      if (list.includes(offerHash)) await spend.store.set(indexKey, JSON.stringify(list.filter((h) => h !== offerHash)))
    })
  }
  // the order ended (delivered, revoked, stopped, failed): its sealed key and its record are destroyed, in this order (the
  // record is written before the key is sealed, task_offer): a sealed key never outlives its record, and a record left
  // without its key (a crash in between) is dropped by recover (spend-key-lost)
  // 订单结束：先销毁封存的钥匙、再删订单记录（接单时先写记录再封存钥匙）：密文绝不比记录活得久；中间崩溃留下的无钥匙记录由 recover 删除
  async function finish(order) {
    if (!order.persisted) return
    order.persisted = false
    try { await limiter.forgetKey({ chainId, agentKey: order.agentKey }) } catch (e) { log(`order ${order.offerHash.slice(0, 10)}: the sealed key could not be destroyed: ${plainText(String(e?.message ?? e), 120)}`) }
    try { await dropRecord(order.offerHash) } catch (e) { log(`order ${order.offerHash.slice(0, 10)}: the order record could not be removed: ${plainText(String(e?.message ?? e), 120)}`) }
  }
  const persistLater = (order) => saveOrder(order).catch((e) => log(`order ${order.offerHash.slice(0, 10)}: not saved (a restart would lose it): ${plainText(String(e?.message ?? e), 120)}`))
  // phase 1: what the channel holds now; at delivery it does not matter (the work is done; the principal may be closing out)
  // 阶段 1：通道此刻的状态；交付时无关（活已干完，委托方可能正在收尾）
  const CHANNEL_STATE = new Set(['withdraw-pending', 'channel-empty', 'channel-exceeds-cap', 'fee-channel-short'])
  async function stopOrder(order, reasons) {
    order.state = 'stopped'; order.stopped = { reasons: [...reasons] }; dropKey(order)
    log(`order ${order.offerHash.slice(0, 10)} stopped (${reasons.join(', ')})`)
    await finish(order)
  }

  // The check made before EVERY step that signs or does something for the principal: the mandate must still verify and must
  // not be revoked (the principal's site file is read each time, and so is every revocation message received). A revocation
  // that cannot be read (revocation-unavailable) stops the work too: fail closed. At the moment of the check only: phase 0 has
  // no enforcement, a revocation published a millisecond later is not seen. / 每一步之前的检查，失败关闭。
  async function stillValid(order, { delivering = false } = {}) {
    if (order.state === 'revoked') throw refuse('mandate-revoked', 'the principal revoked this mandate: nothing more is done or signed for it', { revoked: order.revoked })
    if (order.state === 'stopped') throw refuse('spend-stopped', `this order was stopped (${order.stopped.reasons.join(', ')}): nothing more is done or signed for it`, { enforcement: 'escrow-channel', stopped: order.stopped })
    const c = await kit.verifyMandate(signedMandate(order), { agentKey: order.agentKey, agent: container, revocations: order.revocations, ...spendOpts(order) })
    // phase 1: the check against what the work started on; another escrow, consumer or mandate stops the order for good
    // 阶段 1：与开工时比对；换了托管、consumer 或授权书即永久停工
    if (order.spend) {
      const r = await limiter.recheck({ chainId, check: c })
      if (r.stopped && !c.revocation?.revoked) {
        await stopOrder(order, r.stopped.reasons)
        throw refuse('spend-stopped', `stopped: ${r.stopped.reasons.join(', ')}`, { enforcement: 'escrow-channel', stopped: order.stopped })
      }
    }
    if (c.revocation?.revoked) {
      dropKey(order)
      order.state = 'revoked'; order.revoked = { at: c.revocation.at, via: c.revocation.via }
      log(`order ${order.offerHash.slice(0, 10)} revoked (${c.revocation.via}); stopped`)
      await finish(order)
      throw refuse('mandate-revoked', 'the principal revoked this mandate: nothing more is done or signed for it', { revoked: order.revoked })
    }
    // a spend order delivers whatever its channels hold now: a channel spent to the cap or a close-out under way is not a
    // reason to withhold the signed delivery (a revocation, another holder or an expired mandate still is)
    // spend 单交付时不看通道此刻的余额与提现请求（撤销、换持有人、过期仍然拒绝）
    const blocking = delivering && order.spend ? c.problems.filter((p) => !CHANNEL_STATE.has(p.code)) : c.problems
    if (!c.ok && blocking.length) throw refuse('mandate-not-valid', `the mandate no longer verifies: ${codesOf(blocking)}`, { problems: brief(blocking) })
    return c
  }

  // ctx.call: the ONLY way a task reaches another container. Scope first (no request for a container the mandate does not
  // list), then the validity check, then the verified call; the answer is returned as data and its hash-only receipt kept.
  // ctx.call：任务触达其它容器的唯一途径。
  function contextOf(order, receipts) {
    const scope = new Set(order.mandate.scope.map((s) => s.provider.toLowerCase()))
    return {
      providers: order.mandate.scope.map((s) => s.provider),
      // phase 1, restart: how many calls the order made before a restart (their receipts are kept), and per capped
      // provider what the key may have signed out since the start (`signed`: the spend record's hi − base, written
      // before each voucher left) with the receipts kept for it. A call paid just before the process died may have no
      // receipt (signed above the receipts' prices): a task that knows its prices can skip it instead of paying again
      // 阶段 1 的重启：重启前已做的调用数（回执保留），以及每个带金额 provider 自开工以来钥匙可能签出的金额（限额记录的 hi − base，
      // 每张凭证离开前写入）与为它保留的回执数。进程死前刚付费的调用可能没有回执：知道单价的任务可以据此跳过，不再重付
      resumed: order.resumed ?? { calls: 0, providers: [] },
      async call(provider, method, params = {}) {
        if (!abi.isAddress(provider) || !scope.has(provider.toLowerCase())) throw refuse('out-of-scope', `${plainText(String(provider), 44)} is not a provider in the mandate's scope: not called`)
        await stillValid(order)
        if (receipts.length >= maxCalls) throw refuse('too-many-calls', `at most ${maxCalls} upstream calls per order`)
        // phase 1: one resolved service per provider for the whole order, refreshed in place by api.call, so the SDK's
        // price consent holds across calls (a price above the one first accepted is PRICE_CHANGED); a fresh resolve per
        // call would accept each new price as if seen for the first time / 阶段 1：整单每个 provider 只解析一次，价格同意才跨调用有效
        const svc = order.spend ? (order.services.get(provider.toLowerCase()) ?? await api.resolve(provider)) : await api.resolve(provider)
        if (order.spend) order.services.set(provider.toLowerCase(), svc)
        if (!abi.eqAddr(svc.container, provider)) throw refuse('provider-mismatch', `resolved ${svc.container}, not ${provider}`)
        // phase 0: free methods only (no payer); phase 1: the limited payer of this order / 阶段 0 只调免费方法；阶段 1 用本单的限额付款器
        const r = order.payer ? await api.call(svc, method, params, { payer: order.payer }) : await api.call(svc, method, params)
        receipts.push(mcp.hashReceipt(receiptOfCall(svc, method, params, r)))
        if (order.persisted) await persistLater(order)            // a paid call's receipt survives a restart / 付过钱的调用的回执跨重启保留
        return r.result
      },
    }
  }

  async function work(order) {
    const receipts = order.partialReceipts ?? []
    order.partialReceipts = receipts
    try {
      const def = tasks[order.task.kind]
      const deliverable = await def.run(structuredClone(order.task), contextOf(order, receipts))
      jsonHashOf(deliverable)                                  // must have a canonical form
      order.deliverable = deliverable; order.receipts = receipts
      if (order.state === 'working') { order.state = 'ready'; await persistLater(order) }
    } catch (e) {
      if (order.state !== 'revoked') order.state = 'failed'
      order.failure = { reason: e?.data?.reason ?? 'task-failed', message: plainText(String(e?.message ?? e), 300) }
      log(`order ${order.offerHash.slice(0, 10)} ${order.state}: ${plainText(order.failure.message, 120)}`)
      if (order.state === 'failed') { dropKey(order); await finish(order) }
    }
  }

  const views = {
    async task_offer(params) {
      const message = params?.message
      if (!isObj(message) || message.kind !== 'tape.agent/offer') throw refuse('message-malformed', 'params.message must be a tape.agent/offer message')
      const check = await kit.verifyTaskThread([message])
      if (!check.ok || check.state !== 'Offered') throw refuse('offer-refused', `the offer did not verify (state ${check.state}): ${codesOf(check.problems)}`, { problems: brief(check.problems) })
      if (!mine(message.offer.agent)) throw refuse('agent-mismatch', `the offer is for ${plainText(String(message.offer.agent), 44)}, not for this agent (${container})`)
      const kind = message.task?.kind
      if (typeof kind !== 'string' || !KIND_RE.test(kind) || !Object.hasOwn(tasks, kind)) throw refuse('unsupported-task', `this agent does not do tasks of kind ${plainText(String(kind), 64)}`, { supported: Object.keys(tasks) })
      // from here to the end of the method nothing is awaited: two offers that arrive together cannot both pass this point
      const known = orders.get(check.offerHash)
      if (known) {
        if (known.state === 'revoked') throw refuse('mandate-revoked', 'the principal revoked this order')
        return { kind: 'tape.agent/accept', offerHash: known.offerHash, agentKey: known.agentKey, exp: known.acceptExp }   // the same order: the same key
      }
      if (orders.size >= maxOrders) throw refuse('busy', 'this agent holds as many orders as it keeps in memory')
      // a fresh key for this order, never reused; only its address is kept (phase 0 binds the key, nothing signs with it)
      let agentKey, keySecret
      if (!limiter) { do { agentKey = sig.privateKeyToAddress(sig.randomPrivateKey()) } while (issuedKeys.has(agentKey.toLowerCase())) }
      // phase 1: the secret is kept in memory for the mandate that may fund this key, and dropped if it names no funds
      // 阶段 1：密钥留在内存里，等可能为它出资的授权书；授权书不带金额即丢掉
      else { do { keySecret = sig.randomPrivateKey(); agentKey = sig.privateKeyToAddress(keySecret) } while (issuedKeys.has(agentKey.toLowerCase())) }
      issuedKeys.add(agentKey.toLowerCase())
      const now = clock()
      const order = { offerHash: check.offerHash, offerMsg: message, offer: normalizeTaskOffer(message.offer), task: message.task, principal: check.principal, agentKey, acceptExp: now + acceptTtlS, state: 'accepted', revocations: [] }
      if (keySecret) secrets.set(order, keySecret)
      orders.set(order.offerHash, order)
      // the limiter's record of the key is made before the key is announced: a key without one never signs
      // 钥匙公布之前先建限额记录：没有记录的钥匙永不签名
      if (limiter) {
        try { await limiter.accept({ chainId, agentKey }) } catch (e) { orders.delete(order.offerHash); throw refuse('spend-refused', plainText(String(e.message), 300)) }
        // phase 1, restart: the order recorded, then the key sealed in the store, both before the key is announced (the
        // record first: a sealed key never exists without its record, review p1-restart)
        // 阶段 1 的重启：钥匙公布之前先记下订单、再把钥匙封存进存储（先记录：没有记录的密文永不存在）
        if (persist) {
          try {
            order.persisted = true
            await saveOrder(order)
            await limiter.keepKey({ chainId, agentKey, secret: keySecret })
          } catch (e) {
            orders.delete(order.offerHash); await finish(order).catch(() => {})
            throw refuse('spend-refused', `the order could not be kept for a restart: ${plainText(String(e?.message ?? e), 300)}`)
          }
        }
      }
      log(`offer ${order.offerHash.slice(0, 10)} accepted: ${plainText(kind, 64)} for ${check.principal.container}${check.selfHire ? ' (self-hire: ' + check.selfHireReasons.join(', ') + ')' : ''}`)
      return { kind: 'tape.agent/accept', offerHash: order.offerHash, agentKey, exp: order.acceptExp }
    },

    async task_mandate(params) {
      const order = orderOf(params?.offerHash, 'offerHash')
      if (!order) throw refuse('unknown-offer', 'this agent accepted no such offer')
      const message = params?.message
      if (!isObj(message) || message.kind !== 'tape.agent/mandate' || !isObj(message.mandate)) throw refuse('message-malformed', 'params.message must be a tape.agent/mandate message')
      if (order.state === 'revoked') throw refuse('mandate-revoked', 'the principal revoked this order')
      if (order.mandateMsg) {
        if (jsonHashOf(message) === order.mandateMsgHash) return statusOf(order)   // the same mandate again: the same answer
        throw refuse('order-has-mandate', 'this order already has a mandate')
      }
      if (order.state !== 'accepted' || order.verifying) throw refuse('wrong-state', `the order is ${order.verifying ? 'verifying a mandate' : order.state}`)
      if (clock() > order.acceptExp) throw refuse('accept-expired', `the accept expired at ${order.acceptExp}`)
      order.verifying = true
      try {
        // The fields compared with the offer come first and need no chain read: a mandate that names another principal, task, mode or
        // nonce is refused before verifyMandate records its nonce, so a mistaken one does not use up the offer's nonce (the corrected
        // mandate carries the same one). A malformed mandate is left to verifyMandate to report.
        // 先比对与报价一致的字段（不读链）：写错的授权书在记录 nonce 之前就被拒，不会用掉报价的 nonce。
        let pre = null
        try { pre = normalizeMandate(message.mandate) } catch { /* verifyMandate reports mandate-malformed */ }
        if (pre) {
          const mismatch = []
          if (!abi.eqAddr(pre.principal, order.offer.principal)) mismatch.push('principal')
          if (pre.taskHash !== order.offer.taskHash) mismatch.push('taskHash')
          if (pre.mode !== order.offer.mode) mismatch.push('mode')
          if (pre.nonce !== order.offer.nonce) mismatch.push('nonce')    // the mandate's nonce is the offer's: one mandate serves one thread
          if (mismatch.length) throw refuse('mandate-mismatch', `the mandate's ${mismatch.join(', ')} differ from the offer`)
        }
        // Nothing starts unless this is `ok`: signed by the CURRENT holder of the principal, the agentKey announced for THIS
        // order, this agent, a window that holds now, every cap 0, not revoked, nonce not reused.
        // phase 1: the path the principal funded the channels on (holder: its wallet, container: the principal), checked
        // 阶段 1：委托方出资的路径
        const fundingPath = limiter && params.fundingPath !== undefined ? params.fundingPath : undefined
        if (fundingPath !== undefined && !['holder', 'container'].includes(fundingPath)) throw refuse('bad-request', 'fundingPath must be holder or container')
        const c = await kit.verifyMandate({ mandate: message.mandate, sig: message.sig }, { agentKey: order.agentKey, agent: container, revocations: order.revocations, ...(limiter ? { enforcement: 'escrow-channel', ...(fundingPath ? { fundingPath } : {}) } : {}) })
        if (!c.ok) throw refuse('mandate-refused', `the mandate does not verify, so no work starts: ${codesOf(c.problems)}`, { problems: brief(c.problems) })
        const m = c.mandate
        if (tasks[order.task.kind].needsProviders && m.scope.length === 0) throw refuse('scope-empty', 'this task reads other containers: the mandate must list them in scope')
        if (limiter && c.enforcement === 'escrow-channel') {
          // phase 1, restart: the mandate is recorded before the start, so that a restart in between can still start it
          // (recover: a record with a mandate whose spend record has not started) / 阶段 1 的重启：开工前先记下授权书
          if (order.persisted) {
            try { await saveOrder({ ...order, mandateMsg: message, mandateHash: c.mandateHash, fundingPath: c.fundingPath, state: 'working' }) } catch (e) { throw refuse('spend-refused', `the order could not be kept for a restart: ${plainText(String(e?.message ?? e), 300)}`, { enforcement: 'escrow-channel' }) }
          }
          // phase 1: the check that starts the work pins each capped channel; the key signs through the limiter only
          // 阶段 1：开工核验钉住每条带金额的通道；钥匙只经限额器签名
          try { await limiter.start({ chainId, check: c }) } catch (e) {
            if (order.persisted) await saveOrder(order).catch(() => {})       // back to the accepted record / 记录退回已接单
            throw refuse('spend-refused', plainText(String(e.message), 300), { enforcement: 'escrow-channel' })
          }
          order.spend = true; order.fundingPath = c.fundingPath; order.services = new Map()
          order.payer = limiter.payer({ chainId, payer: api.payer({ consumer: c.consumer, sessionKey: secrets.get(order), sessionExpiry: m.expires, ...(payerStore ? { store: payerStore } : {}) }), maxPrice: spend.maxCallPrice, signed: { mandate: message.mandate, sig: message.sig } })
        } else { dropKey(order); await finish(order) }        // phase 0: nothing to keep / 阶段 0：无需保存
        order.mandate = m; order.mandateMsg = message; order.mandateMsgHash = jsonHashOf(message); order.mandateHash = c.mandateHash
        order.state = 'working'
        byMandate.set(order.mandateHash, order)
        order.work = work(order)
        log(`mandate ${order.mandateHash.slice(0, 10)} verified: work started on ${plainText(order.task.kind, 64)}`)
        return statusOf(order)
      } finally { order.verifying = false }
    },

    async task_deliver(params) {
      const order = orderOf(params?.mandateHash, 'mandateHash')
      if (!order) throw refuse('unknown-mandate', 'this agent holds no such mandate')
      await order.work
      if (order.state === 'revoked') throw refuse('mandate-revoked', 'the principal revoked this mandate: nothing more is signed for it', { revoked: order.revoked })
      if (order.state === 'failed') throw refuse(order.failure.reason, `the task failed: ${order.failure.message}`)
      const c = await stillValid(order, { delivering: true })  // the last check before the signature
      // phase 1 (M7): what each capped channel paid since the check that started the work, read at this last check;
      // signed with the delivery (not under receiptsHash). A channel this check could not read is left out, never made up;
      // when none could be read there is no statement at all (no `spend: []`), which the verifier reports as spend-evidence-absent.
      // 阶段 1（M7）：开工以来每条带金额通道付出的金额，取这最后一次核验的读数；随交付签名（不在 receiptsHash 里）；读不到的通道不写；一条都读不到就不带 spend（不写空数组），核验方报 spend-evidence-absent
      let statement
      if (order.spend) {
        const rec = await limiter.record({ chainId, agentKey: order.agentKey })
        if (rec?.state === 'started') statement = spendStatement(rec, c)
      }
      const receipts = order.receipts
      order.state = 'delivered'
      dropKey(order)                                           // nothing more is signed with it / 不再用它签任何东西
      await finish(order)                                      // its sealed key and record are destroyed / 销毁密文与记录
      return { kind: 'tape.agent/deliver', mandateHash: order.mandateHash, deliverableHash: jsonHashOf(order.deliverable), receipts, receiptsHash: jsonHashOf(receipts), exp: clock() + deliverTtlS, ...(statement?.length ? { spend: statement } : {}) }
    },

    async task_status(params) {
      let order = null
      if (params?.mandateHash !== undefined) order = orderOf(params.mandateHash, 'mandateHash')
      else if (params?.offerHash !== undefined) order = orderOf(params.offerHash, 'offerHash')
      else throw refuse('bad-request', 'name the order by offerHash or mandateHash')
      if (!order) throw refuse('unknown-order', 'this agent holds no such order')
      if (params.revocation !== undefined) await receiveRevocation(order, params.revocation)
      const out = statusOf(order)
      // The deliverable goes only to whoever presents the signed mandate itself (a bearer secret: phase 0 has no caller identity).
      if (params.mandate !== undefined && order.mandateMsg && jsonHashOf(params.mandate) === order.mandateMsgHash && order.deliverable !== undefined) out.deliverable = order.deliverable
      return out
    },
  }

  // A signed revocation received directly (the same one the principal may also publish on its site). Kept only when it verifies
  // against the current holder AND covers this order's mandate; a message that does neither is refused and kept nowhere, so
  // junk cannot make later checks fail. / 收到的撤销消息：核验通过且覆盖本单授权书才保留。
  async function receiveRevocation(order, message) {
    if (!order.mandateMsg) throw refuse('no-mandate-yet', 'a revocation can only be applied to an order that has a mandate')
    if (!isObj(message) || !isObj(message.revocation)) throw refuse('message-malformed', 'revocation must be a tape.agent/revocation message')
    const signed = { revocation: message.revocation, sig: message.sig }
    const c = await kit.verifyMandate(signedMandate(order), { agentKey: order.agentKey, agent: container, readSite: false, revocations: [signed] })
    if (!c.revocation?.revoked) {
      const own = c.problems.filter((p) => ['not-signed-by-holder', 'message-malformed', 'revocation-mismatch'].includes(p.code))
      throw refuse('revocation-refused', own.length ? `the revocation does not verify: ${codesOf(own)}` : 'the revocation does not cover this mandate', { problems: brief(own) })
    }
    order.revocations.push(signed)
    dropKey(order)
    order.state = 'revoked'; order.revoked = { at: c.revocation.at, via: 'message' }
    log(`order ${order.offerHash.slice(0, 10)} revoked by message; stopped`)
    // review p1m4: the limiter's record says so too, so that nothing sharing its store signs for this key again; the order
    // is revoked here whatever the store does (the key is already dropped) / 审查 p1m4：限额器记录也停工；本地无论如何已撤销
    // (phase 1, restart: the stop destroys the sealed key; finish destroys it again and drops the order's record)
    // （阶段 1 的重启：停工销毁封存的钥匙；finish 再销毁一次并删掉订单记录）
    if (order.spend) {
      try { await limiter.stop({ chainId, agentKey: order.agentKey, reason: 'spend-revoked' }) } catch (e) { log(`order ${order.offerHash.slice(0, 10)}: the spend record could not be stopped: ${plainText(String(e?.message ?? e), 120)}`) }
    }
    await finish(order)
    return order.revoked
  }

  function statusOf(order) {
    const out = { state: order.state, offerHash: order.offerHash, enforcement: order.spend ? 'escrow-channel' : 'none', taskKind: plainText(order.task.kind, 64), title: plainText(order.task.spec ?? order.task.kind, 120) }
    if (order.mandateHash) out.mandateHash = order.mandateHash
    if (order.deliverable !== undefined) out.deliverableHash = jsonHashOf(order.deliverable)
    if (order.receipts) out.receiptCount = order.receipts.length
    if (order.failure) out.failure = order.failure
    if (order.revoked) out.revoked = order.revoked
    if (order.stopped) out.stopped = order.stopped
    return out
  }

  // ---- phase 1, restart: resuming the orders a previous process of this runtime kept (recover) ----
  // Fail closed at every step: a record that is not what this runtime writes, a sealed key that does not open or is
  // another's, a mandate that does not match its record, or a fresh check that finds a stop: the order is not resumed and
  // nothing is signed; a stop is written and destroys the key (the limiter), other refusals keep the files as they are.
  // 阶段 1 的重启：恢复前一个进程保存的订单。每一步都失败关闭：记录不是本运行时写的、密文打不开或是别人的、授权书与记录不符、
  // 新的核验发现停工条件：不恢复、不签任何东西；停工会写入并销毁钥匙（限额器），其它拒绝保持文件原样。
  const corrupt = (why) => Object.assign(new Error(`the order record is corrupt (${why}): not resumed, nothing signed; the files are kept`), { data: { reason: 'order-record-corrupt' } })
  // the sealed record on disk: its form, then opened for its context / 盘上的密封记录：先查形式，再按 context 打开
  async function openRecord(raw, offerHash) {
    let env
    try { env = JSON.parse(raw) } catch { throw corrupt('not JSON') }
    if (!isObj(env) || env.v !== ORDER_RECORD_V || env.offerHash !== offerHash || !abi.isAddress(env.agentKey) || env.agentKey !== env.agentKey.toLowerCase() || typeof env.taskHash !== 'string' || !HASH32.test(env.taskHash) || typeof env.sealed !== 'string') throw corrupt('not a sealed record of this order')
    let bytes
    try { bytes = await spend.vault.open(env.sealed, { context: orderContext(env) }) } catch (e) {
      throw Object.assign(new Error(`the order record does not open (${plainText(String(e?.data?.reason ?? e?.message ?? e), 80)}): a wrong passphrase or key, a record changed on disk, or another order's record; not resumed, nothing signed, the files are kept (restart with the right passphrase)`), { data: { reason: 'order-record-unreadable' } })
    }
    let rec
    try { rec = JSON.parse(fromUtf8.decode(bytes)) } catch { throw corrupt('its sealed content is not JSON') }
    checkRecord(rec, env)
    return rec
  }
  function checkRecord(rec, env) {
    const offerHash = env.offerHash
    if (!isObj(rec) || rec.v !== ORDER_RECORD_V || rec.offerHash !== offerHash) throw corrupt('not a record of this order')
    if (!abi.isAddress(rec.agentKey) || !abi.eqAddr(rec.agentKey, env.agentKey) || !isObj(rec.offerMsg) || rec.offerMsg.kind !== 'tape.agent/offer' || !isObj(rec.offerMsg.task)) throw corrupt('no agent key or offer')
    let offer
    try { offer = normalizeTaskOffer(rec.offerMsg.offer) } catch { throw corrupt('a malformed offer') }
    let taskHash
    try { taskHash = taskHashOf(rec.offerMsg.task) } catch { throw corrupt('a malformed task') }
    if (offer.taskHash !== env.taskHash || taskHash !== env.taskHash) throw corrupt('the offer is not of this task')
    if (!['accepted', 'working', 'ready'].includes(rec.state) || !Number.isSafeInteger(rec.acceptExp) || !Array.isArray(rec.revocations) || !Array.isArray(rec.receipts)) throw corrupt('its state')
    // review p1-restart, in depth (the seal already holds them): every receipt is a hash-only receipt of a provider in the
    // mandate's scope, no more than maxCalls; a ready order has a deliverable with a canonical form
    // 审查 p1-restart，纵深防御（封存已经保证）：每张回执都是 scope 内 provider 的只含哈希回执，不超过 maxCalls；ready 的单有交付物且有规范形式
    if (rec.receipts.length > maxCalls || (rec.state === 'accepted' && rec.receipts.length > 0)) throw corrupt('its receipts')
    for (const r of rec.receipts) if (hashOnlyReceiptProblem(r)) throw corrupt('a receipt that is not a hash-only receipt')
    if (rec.state !== 'accepted') {
      if (!isObj(rec.mandateMsg) || !isObj(rec.mandateMsg.mandate) || typeof rec.mandateMsg.sig !== 'string' || typeof rec.mandateHash !== 'string' || !HASH32.test(rec.mandateHash)) throw corrupt('no mandate')
      if (rec.fundingPath !== undefined && !FUNDING_PATHS.includes(rec.fundingPath)) throw corrupt('its funding path')
      let m
      try { m = normalizeMandate(rec.mandateMsg.mandate) } catch { throw corrupt('a malformed mandate') }
      // the mandate binds the key and the task: a record whose offer, key or mandate were changed does not resume
      // 授权书绑定钥匙与任务：offer、钥匙或授权书被改过的记录不恢复
      if (!abi.eqAddr(m.agentKey, rec.agentKey) || m.taskHash !== taskHashOf(rec.offerMsg.task)) throw corrupt('the mandate is not of this key and task')
      const scope = new Set(m.scope.map((x) => x.provider.toLowerCase()))
      if (!rec.receipts.every((r) => scope.has(r.service.container.toLowerCase()))) throw corrupt('a receipt of a provider outside the mandate\'s scope')
      if (rec.state === 'ready') {
        if (rec.deliverable === undefined) throw corrupt('a ready order without its deliverable')
        try { jsonHashOf(rec.deliverable) } catch { throw corrupt('a deliverable without a canonical form') }
      }
    }
    const kind = rec.offerMsg.task.kind
    if (typeof kind !== 'string' || !Object.hasOwn(tasks, kind)) throw corrupt('a task this runtime does not do')
  }
  // a record whose sealed key is gone (a crash between destroying the key and the record, or a stop whose record drop
  // failed) can never resume: it is dropped (the limiter's record stays) / 密文已不在的记录永远无法恢复：删除（限额记录保留）
  const resumeKey = async (offerHash, o) => {
    try { return await limiter.resume(o) } catch (e) {
      if (e?.data?.stopped || e?.data?.reason === 'spend-key-lost') await dropRecord(offerHash).catch(() => {})
      throw e
    }
  }
  async function recoverOne(offerHash) {
    const raw = await spend.store.get(orderKey(offerHash))
    if (raw == null || raw === '') { await dropRecord(offerHash); throw Object.assign(new Error('no order record (the order ended): nothing to resume'), { data: { reason: 'order-ended' } }) }
    const rec = await openRecord(raw, offerHash)
    const offer = normalizeTaskOffer(rec.offerMsg.offer)
    const order = { offerHash, offerMsg: rec.offerMsg, offer, task: rec.offerMsg.task, principal: { container: offer.principal }, agentKey: abi.checksumAddress(rec.agentKey), acceptExp: rec.acceptExp, state: 'accepted', revocations: rec.revocations, persisted: true }
    if (rec.state === 'accepted') {
      if (clock() > rec.acceptExp) { await finish(order); throw Object.assign(new Error(`the accept expired at ${rec.acceptExp} before a mandate came: not resumed; its sealed key is destroyed`), { data: { reason: 'accept-expired' } }) }
      const r = await resumeKey(offerHash, { chainId, agentKey: order.agentKey })
      secrets.set(order, r.secret)
    } else {
      const signed = { mandate: rec.mandateMsg.mandate, sig: rec.mandateMsg.sig }
      // a fresh check, exactly as every step makes it (the site's revocations are read again) / 新的核验，与每一步相同
      const c = await kit.verifyMandate(signed, { agentKey: order.agentKey, agent: container, revocations: rec.revocations, enforcement: 'escrow-channel', ...(rec.fundingPath ? { fundingPath: rec.fundingPath } : {}) })
      if (c.mandateHash !== rec.mandateHash) throw corrupt('its mandate hash')
      // a restart between recording the mandate and the start: start it now, only from an ok check (a new start)
      // 记下授权书与开工之间的重启：现在开工，只凭 ok 的核验（等同新的开工）
      const sr = await limiter.record({ chainId, agentKey: order.agentKey })
      if (sr?.state === 'accepted' && !sr.stopped) {
        if (!c.ok || c.enforcement !== 'escrow-channel') throw Object.assign(new Error(`the work had not started and the mandate does not verify now (${codesOf(c.problems)}): not resumed`), { data: { reason: 'mandate-not-valid' } })
        await limiter.start({ chainId, check: c })
      }
      // a stop (written now, or found): the order ended for good; the limiter destroyed the sealed key / 停工：订单终止
      const r = await resumeKey(offerHash, { chainId, agentKey: order.agentKey, check: c })
      const m = c.mandate
      secrets.set(order, r.secret)
      Object.assign(order, { mandate: m, mandateMsg: rec.mandateMsg, mandateMsgHash: jsonHashOf(rec.mandateMsg), mandateHash: rec.mandateHash, spend: true, fundingPath: rec.fundingPath ?? c.fundingPath, services: new Map() })
      order.payer = limiter.payer({ chainId, payer: api.payer({ consumer: r.record.consumer, sessionKey: r.secret, sessionExpiry: m.expires, ...(payerStore ? { store: payerStore } : {}) }), maxPrice: spend.maxCallPrice, signed })
      byMandate.set(order.mandateHash, order)
      if (rec.state === 'ready') { order.state = 'ready'; order.deliverable = rec.deliverable; order.receipts = rec.receipts; order.work = Promise.resolve() } else {
        // the task runs again from its start; the receipts of the calls made before the restart are kept (they were paid)
        // 任务从头再跑；重启前调用的回执保留（已付费）
        order.state = 'working'; order.partialReceipts = [...rec.receipts]
        const receiptsTo = (p) => rec.receipts.filter((x) => abi.eqAddr(x.service.container, p)).length
        order.resumed = { calls: rec.receipts.length, providers: r.record.providers.map((p) => ({ provider: p.provider, signed: (BigInt(p.hi) - BigInt(p.base)).toString(), receipts: receiptsTo(p.provider) })) }
      }
    }
    issuedKeys.add(order.agentKey.toLowerCase())
    orders.set(offerHash, order)
    if (order.state === 'working') order.work = work(order)
    log(`order ${offerHash.slice(0, 10)} resumed after a restart (${order.state})`)
    return order
  }

  // every method refuses until recover() has run, when persistence is on / 持久化时 recover() 跑完之前每个方法都拒绝
  const notYet = () => refuse('recovering', 'this agent is resuming the orders it kept across a restart: try again in a moment')
  const methods = persist ? Object.fromEntries(Object.entries(views).map(([name, fn]) => [name, async (params) => { if (!recovered) throw notYet(); return fn(params) }])) : views
  return {
    methods,
    /**
     * phase 1, restart: resume the spend orders this runtime's store kept, after a restart (call once, before serving: with
     * persistence on, every method refuses with `recovering` until it has run).
     * { persistence, recovered: [offerHash], refused: [{ offerHash, reason, message }] }; without a vault nothing is kept
     * and nothing is resumed. / 阶段 1 的重启：重启后恢复存储里的 spend 单（开始服务之前调用一次）。
     */
    async recover() {
      const out = { persistence: persist, recovered: [], refused: [] }
      if (!persist) { log('persistence is off (no key vault): no order is resumed after a restart'); return out }
      let list
      try { list = await readIndex() } catch (e) { out.refused.push({ offerHash: null, reason: 'order-index-corrupt', message: plainText(String(e?.message ?? e), 300) }); recovered = true; return out }
      for (const h of list) {
        if (orders.has(h)) continue
        try { await recoverOne(h); out.recovered.push(h) } catch (e) {
          const reason = e?.data?.reason ?? e?.code ?? 'recover-failed'
          out.refused.push({ offerHash: h, reason, message: plainText(String(e?.message ?? e), 300) })
          log(`order ${h.slice(0, 10)} not resumed (${reason}): ${plainText(String(e?.message ?? e), 160)}`)
        }
      }
      recovered = true
      return out
    },
    /** the direct-message path, for a host that receives revocations some other way: the order is found by its mandateHash */
    async receiveRevocation(mandateHash, message) {
      if (persist && !recovered) throw notYet()
      const order = orderOf(mandateHash, 'mandateHash')
      if (!order) throw refuse('unknown-mandate', 'this agent holds no such mandate')
      return receiveRevocation(order, message)
    },
    /** what this runtime knows of an order (for logs and tests): never the key's secret, which is not kept */
    order(hash) { return orders.get(String(hash).toLowerCase()) ?? byMandate.get(String(hash).toLowerCase()) ?? null },
    issuedKeys: () => [...issuedKeys],
    kit, container, limiter,
  }
}
