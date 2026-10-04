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
import { createAgentKit, plainText, jsonHashOf, normalizeTaskOffer, normalizeMandate } from '@tapeapi/sdk/agent'

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
      for (const provider of ctx.providers) {
        const r = await ctx.call(provider, readMethod, {})
        const n = r?.blockNumber
        if (!Number.isSafeInteger(n) || n < 0) throw refuse('bad-upstream-answer', `${provider} did not answer a block number`)
        answers.push({ provider, blockNumber: n })
      }
      return { kind: 'chain.block-height', chain: 'bsc', blockNumber: Math.max(...answers.map((a) => a.blockNumber)), answers }
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
 */
export function createAgentService({ api, container, kit, tasks, clock = () => Math.floor(Date.now() / 1000), acceptTtlS = 3600, deliverTtlS = 86_400, maxOrders = 1000, maxCalls = 8, readMethod, log = () => {} } = {}) {
  if (!api || !abi.isAddress(container)) throw new Error('createAgentService needs { api, container }')
  kit ??= createAgentKit(api, { clock })
  tasks ??= { 'chain.block-height': blockHeightTask({ readMethod }) }
  const orders = new Map()        // offerHash -> order
  const byMandate = new Map()     // mandateHash -> order
  const issuedKeys = new Set()    // every agentKey ever announced: never announced twice
  const mine = (a) => abi.eqAddr(a, container)

  const orderOf = (hash, what) => {
    if (typeof hash !== 'string' || !HASH32.test(hash)) throw refuse('bad-request', `${what} must be a 32-byte 0x hash`)
    return (what === 'mandateHash' ? byMandate : orders).get(hash.toLowerCase())
  }
  const signedMandate = (order) => ({ mandate: order.mandateMsg.mandate, sig: order.mandateMsg.sig })

  // The check made before EVERY step that signs or does something for the principal: the mandate must still verify and must
  // not be revoked (the principal's site file is read each time, and so is every revocation message received). A revocation
  // that cannot be read (revocation-unavailable) stops the work too: fail closed. At the moment of the check only: phase 0 has
  // no enforcement, a revocation published a millisecond later is not seen. / 每一步之前的检查，失败关闭。
  async function stillValid(order) {
    if (order.state === 'revoked') throw refuse('mandate-revoked', 'the principal revoked this mandate: nothing more is done or signed for it', { revoked: order.revoked })
    const c = await kit.verifyMandate(signedMandate(order), { agentKey: order.agentKey, agent: container, revocations: order.revocations })
    if (c.revocation?.revoked) {
      order.state = 'revoked'; order.revoked = { at: c.revocation.at, via: c.revocation.via }
      log(`order ${order.offerHash.slice(0, 10)} revoked (${c.revocation.via}); stopped`)
      throw refuse('mandate-revoked', 'the principal revoked this mandate: nothing more is done or signed for it', { revoked: order.revoked })
    }
    if (!c.ok) throw refuse('mandate-not-valid', `the mandate no longer verifies: ${codesOf(c.problems)}`, { problems: brief(c.problems) })
    return c
  }

  // ctx.call: the ONLY way a task reaches another container. Scope first (no request for a container the mandate does not
  // list), then the validity check, then the verified call; the answer is returned as data and its hash-only receipt kept.
  // ctx.call：任务触达其它容器的唯一途径。
  function contextOf(order, receipts) {
    const scope = new Set(order.mandate.scope.map((s) => s.provider.toLowerCase()))
    return {
      providers: order.mandate.scope.map((s) => s.provider),
      async call(provider, method, params = {}) {
        if (!abi.isAddress(provider) || !scope.has(provider.toLowerCase())) throw refuse('out-of-scope', `${plainText(String(provider), 44)} is not a provider in the mandate's scope: not called`)
        await stillValid(order)
        if (receipts.length >= maxCalls) throw refuse('too-many-calls', `at most ${maxCalls} upstream calls per order`)
        const svc = await api.resolve(provider)
        if (!abi.eqAddr(svc.container, provider)) throw refuse('provider-mismatch', `resolved ${svc.container}, not ${provider}`)
        const r = await api.call(svc, method, params)          // free methods only: no payer is given
        receipts.push(mcp.hashReceipt(receiptOfCall(svc, method, params, r)))
        return r.result
      },
    }
  }

  async function work(order) {
    const receipts = []
    try {
      const def = tasks[order.task.kind]
      const deliverable = await def.run(structuredClone(order.task), contextOf(order, receipts))
      jsonHashOf(deliverable)                                  // must have a canonical form
      order.deliverable = deliverable; order.receipts = receipts
      if (order.state === 'working') order.state = 'ready'
    } catch (e) {
      if (order.state !== 'revoked') order.state = 'failed'
      order.failure = { reason: e?.data?.reason ?? 'task-failed', message: plainText(String(e?.message ?? e), 300) }
      log(`order ${order.offerHash.slice(0, 10)} ${order.state}: ${plainText(order.failure.message, 120)}`)
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
      let agentKey
      do { agentKey = sig.privateKeyToAddress(sig.randomPrivateKey()) } while (issuedKeys.has(agentKey.toLowerCase()))
      issuedKeys.add(agentKey.toLowerCase())
      const now = clock()
      const order = { offerHash: check.offerHash, offerMsg: message, offer: normalizeTaskOffer(message.offer), task: message.task, principal: check.principal, agentKey, acceptExp: now + acceptTtlS, state: 'accepted', revocations: [] }
      orders.set(order.offerHash, order)
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
        const c = await kit.verifyMandate({ mandate: message.mandate, sig: message.sig }, { agentKey: order.agentKey, agent: container, revocations: order.revocations })
        if (!c.ok) throw refuse('mandate-refused', `the mandate does not verify, so no work starts: ${codesOf(c.problems)}`, { problems: brief(c.problems) })
        const m = c.mandate
        if (tasks[order.task.kind].needsProviders && m.scope.length === 0) throw refuse('scope-empty', 'this task reads other containers: the mandate must list them in scope')
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
      await stillValid(order)                                  // the last check before the signature
      const receipts = order.receipts
      order.state = 'delivered'
      return { kind: 'tape.agent/deliver', mandateHash: order.mandateHash, deliverableHash: jsonHashOf(order.deliverable), receipts, receiptsHash: jsonHashOf(receipts), exp: clock() + deliverTtlS }
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
    order.state = 'revoked'; order.revoked = { at: c.revocation.at, via: 'message' }
    log(`order ${order.offerHash.slice(0, 10)} revoked by message; stopped`)
    return order.revoked
  }

  function statusOf(order) {
    const out = { state: order.state, offerHash: order.offerHash, enforcement: 'none', taskKind: plainText(order.task.kind, 64), title: plainText(order.task.spec ?? order.task.kind, 120) }
    if (order.mandateHash) out.mandateHash = order.mandateHash
    if (order.deliverable !== undefined) out.deliverableHash = jsonHashOf(order.deliverable)
    if (order.receipts) out.receiptCount = order.receipts.length
    if (order.failure) out.failure = order.failure
    if (order.revoked) out.revoked = order.revoked
    return out
  }

  return {
    methods: views,
    /** the direct-message path, for a host that receives revocations some other way: the order is found by its mandateHash */
    async receiveRevocation(mandateHash, message) {
      const order = orderOf(mandateHash, 'mandateHash')
      if (!order) throw refuse('unknown-mandate', 'this agent holds no such mandate')
      return receiveRevocation(order, message)
    },
    /** what this runtime knows of an order (for logs and tests): never the key's secret, which is not kept */
    order(hash) { return orders.get(String(hash).toLowerCase()) ?? byMandate.get(String(hash).toLowerCase()) ?? null },
    issuedKeys: () => [...issuedKeys],
    kit, container,
  }
}
