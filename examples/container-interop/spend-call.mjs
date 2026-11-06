// Scenario (a): container A's agent calls container B's PAID method, inside a limit A's holder signed (EXPERIMENTAL, phase 1,
// local chains and tests only: the escrow contract is not audited and not deployed, so this is not available on mainnet).
//
//   A  = the principal container #11: its holder signs the offer's order, the mandate and, if it wants, the revocation.
//   A' = A's agent container #12, running examples/agent-service/agent.mjs with the spend limiter: it holds a fresh agentKey
//        per order, and its calls to B carry vouchers signed with that key only through the limiter.
//   B  = the provider container #13: a priced method; it settles the vouchers on the escrow like any provider does.
//
// What the limit is made of: the mandate's scope names B and a cap; the holder funds ONE channel (A -> B) with that cap and
// authorises the agentKey as a session key on it. So the agent runtime cannot sign above `claimedAtStart + cap`, and a leaked
// key reaches only that channel; and the limiter refuses a call priced above a per-call ceiling (10% of the cap by default).
// Nothing in B knows about the mandate: B sees a valid voucher from a session key, as it would from any payer.
// 场景 (a)：容器 A 的代理调用容器 B 的**付费**方法，在 A 的持有人签署的上限之内（实验性，阶段 1，只在本地链与测试里；托管合约没有
// 经过审计、也没有部署，主网不可用）。A = 委托方容器 #11（其持有人签授权书）；A' = A 的代理容器 #12（带限额器的运行时，每单一把新钥匙）；
// B = 服务容器 #13（收费方法，像任何服务一样结算凭证）。上限的构成：授权书的 scope 写明 B 与 cap；持有人只给这一条通道（A -> B）
// 注入 cap，并把 agentKey 授权为其上的会话钥匙。B 并不知道授权书的存在：它看到的是会话钥匙签的有效凭证。
//
// FAKE KEYS ONLY. Funded mandates are signed here through the test helpers' fixture signer (`mandateMsg`), as the spend tests do:
// this file never opts out of the SDK's phase-0 gate itself, and a real holder signs the same typed data in a wallet.
import { receiptOfCall } from '../agent-service/agent.mjs'
import { createInteropWorld, KEYS, P, AG, S, S2 } from './world.mjs'
import { verifyReceipt } from './receipts.mjs'
import { offerMsg, mandateOf, mandateMsg, addrOf, BEM_TOKEN, revocationFile } from '../../sdk/test/helpers/agent-chain.mjs'

export const ESCROW = '0x00000000000000000000000000000000000E5C71'   // the escrow the providers name (a fixture address)
export const PRICE = 10_000n                                         // 0.0001 BEM, 8 decimals: the providers' price per call
export const HOLDER = addrOf(KEYS.principalHolder)
const SETTLER = addrOf(KEYS.providerHolder)                          // whoever sends settle: anyone may
const TASK = { kind: 'paid-reads', spec: 'read the block height from B, paying per call' }
const DAY = 86_400
const D48 = 48 * 3600

/**
 * The task A's agent runs: `n` paid calls to `target` (B by default). `hooks[i]` runs before call i (a test's way to move the
 * world mid-order). Every outcome is recorded as data; a refusal is a reason code, never a thrown error out of the task.
 */
export function paidReadsTask({ n = 3, target = S, method = 'blockNumber', hooks = {} } = {}) {
  return {
    needsProviders: true,
    async run(_task, ctx) {
      const results = []
      for (let i = 0; i < n; i++) {
        if (hooks[i]) await hooks[i]()
        try {
          const r = await ctx.call(target, method, {})
          results.push(Number.isSafeInteger(r?.blockNumber) ? { ok: true, blockNumber: r.blockNumber } : { ok: false, reason: 'bad-answer' })
        } catch (e) { results.push({ ok: false, reason: e?.data?.reason ?? e?.code ?? 'error' }) }
      }
      return { kind: 'paid-reads', results }
    },
  }
}

/**
 * A world where B's `blockNumber` costs PRICE per call and A's agent runtime (#12) has the spend limiter.
 *   cap           the cap the mandate will carry, in prices (default 10): it only decides the per-call ceiling below
 *   maxCallPrice  the runtime's per-call ceiling. Undefined: the runtime's own default (10% of the cap) when the cap is at least
 *                 10 prices, one price when it is fewer (a ceiling is never above the cap, and one call must be possible);
 *                 null: always the runtime's default, whatever the cap (a price above it is refused before any request)
 */
export async function createSpendWorld({ n = 3, cap = 10n, target = S, hooks, maxCallPrice, ...rest } = {}) {
  const ceiling = maxCallPrice === undefined ? (BigInt(cap) < 10n ? PRICE.toString() : null) : maxCallPrice
  return createInteropWorld({
    channels: false, spend: { escrow: ESCROW, holderBalance: 10n ** 12n },
    agentOptions: { tasks: { 'paid-reads': paidReadsTask({ n, target, hooks }) }, spend: ceiling === null ? {} : { maxCallPrice: String(ceiling) } },
    ...rest,
  })
}

/** B settles the vouchers it holds, as its operator's settler would. Returns what each transaction did. */
export async function settleAll(world) {
  const p = world.providerAt('https://provider-1.example')
  const out = []
  for (const v of await p.pendingSettlements()) { try { out.push(world.escrow.send(SETTLER, p.settleTx(v))) } catch (e) { out.push(e.revert ?? e.message) } }
  return out
}

/**
 * The whole order, narrated. Returns { steps, ... } where `steps` is the call sequence the README prints.
 *   cap          the mandate's cap, in prices (default 10)
 *   expiresInS   the mandate's and the session's life (default one day)
 *   settleBefore B settles its vouchers before A's agent delivers (default true: the spend statement then reconciles)
 *   afterWork    async (ctx) => void: runs after the work and before the delivery (revoke, close out early...)
 */
export async function runSpendCall({ world, cap = 10n, expiresInS = DAY, settleBefore = true, afterWork, nonce = '1', print = () => {} } = {}) {
  const w = world
  const steps = []
  const say = (actor, what, detail = {}) => { const s = { n: steps.length + 1, actor, what, ...detail }; steps.push(s); print(`${String(s.n).padStart(2)}. [${actor}] ${what}`) ; return s }
  const capUnits = cap * PRICE
  const svc = await w.principalApi.resolve(AG)
  const call = (method, params) => w.principalApi.call(svc, method, params)
  const expires = Math.floor(w.clock()) + expiresInS

  // 1. the offer: A's holder signs it; A' answers with a signed accept and the agentKey it made for this order
  const offer = offerMsg({ task: TASK, mode: 1, nonce })
  const accR = await call('task_offer', { message: offer })
  const acc = accR.result
  say('A -> A\'', 'offer (signed by A\'s holder); A\' accepts with a fresh agentKey', { agentKey: acc.agentKey, offerHash: acc.offerHash })

  // 2. the mandate: B in scope with a cap, naming the agentKey; the holder funds that one channel and authorises the key
  const m = mandateOf({ task: TASK, agentKey: acc.agentKey, mode: 1, nonce, scope: [{ provider: S, token: BEM_TOKEN, cap: capUnits.toString() }], expires })
  const msg = mandateMsg(m)
  say('A', `mandate signed: scope = [B], cap ${capUnits} (${cap} calls at ${PRICE}), expires ${expires}`, { mandateHash: null })
  const plan = await w.principalKit.holderPlan(m, { holder: HOLDER, path: 'holder', history: [], signed: { mandate: m, sig: msg.sig } })
  for (const step of plan.steps) w.escrow.send(HOLDER, step.tx)
  const applied = await w.principalKit.afterPlan(plan, m)
  if (applied.problems.length) throw new Error(`the funding plan was not applied: ${applied.problems.map((p) => p.code).join(', ')}`)
  say('A (wallet)', `funding plan applied: ${plan.steps.map((s) => s.kind).join(', ')}`, { kinds: plan.steps.map((s) => s.kind) })

  // 3. the mandate goes to A'; it checks it against the chain (channel funded, key authorised, cap) and starts
  const started = (await call('task_mandate', { offerHash: acc.offerHash, message: msg })).result
  const mandateHash = started.mandateHash
  steps[1].mandateHash = mandateHash
  say('A\'', `verified the mandate against the chain: enforcement ${started.enforcement}; work starts`, { enforcement: started.enforcement })
  const order = w.service.order(mandateHash)
  await order.work
  const results = order.deliverable?.results ?? []
  results.forEach((r, i) => say('A\' -> B', r.ok ? `call ${i + 1}: blockNumber, one voucher of ${PRICE} (answered: ${r.blockNumber})` : `call ${i + 1}: refused before any request (${r.reason})`, { ok: r.ok, reason: r.reason }))
  if (afterWork) await afterWork({ world: w, mandateHash, mandate: m, plan, order })
  if (settleBefore) say('B', `settles the vouchers it holds on the escrow: ${(await settleAll(w)).join(', ') || 'nothing to settle'}`)

  // 4. the delivery, signed by A'; the thread (A can show it to anyone) and what the check says about it
  const delParams = { mandateHash }
  const delR = await w.principalApi.call(svc, 'task_deliver', delParams)
  const stated = (delR.result.spend ?? []).map((x) => `claimed ${x.claimedAtStart} -> ${x.claimedAtDelivery}, spent ${x.spent}`).join('; ') || 'none'
  say('A\' -> A', `delivery: ${delR.result.receipts.length} hash-only receipt(s) of B's answers; spend statement: ${stated}`)
  const thread = [offer, { v: 0, kind: 'tape.agent/accept', receipt: receiptOfCall(svc, 'task_offer', { message: offer }, accR) }, msg, { v: 0, kind: 'tape.agent/deliver', receipt: receiptOfCall(svc, 'task_deliver', delParams, delR) }]
  const check = await w.principalKit.verifyTaskThread(thread, { enforcement: 'escrow-channel' })
  // The check reads the chain NOW: it is a point-in-time check of the funded channel, so it is meaningful while the channel
  // still holds funds and the session is live: once the cap is fully settled or A has closed out, it says channel-empty or
  // session-missing and the thread stays in Accepted (see README, "Gaps").
  const spendItems = (check.evidence?.spend?.items ?? []).map((i) => `${i.provider.slice(0, 8)}…: ${i.reconciled ?? 'not reconciled'}, paid now ${i.spentNow} for ${i.calls} receipted call(s)`)
  say('A', `thread check: state ${check.state}, ok ${check.ok}, enforcement ${check.enforcement}${check.ok ? '' : '; problems ' + check.problems.map((p) => p.code).join(', ')}${spendItems.length ? '; ' + spendItems.join('; ') : ''}`)

  // 5. the receipts, checked one by one against what B publishes now (what `api.call` did, again, later)
  const receiptChecks = []
  for (const r of delR.result.receipts) receiptChecks.push(await verifyReceipt(w.principalApi, r, { container: S, method: 'blockNumber', params: {} }))
  say('A', `receipts: ${receiptChecks.filter((c) => c.ok).length}/${receiptChecks.length} signed by B's published signer for method blockNumber with params {}`)
  return { steps, offer, accept: acc, mandate: m, mandateMsg: msg, mandateHash, plan, started, order, results, delivered: delR.result, thread, check, receiptChecks, upstream: w.upstreamCalls() }
}

/** A closes the channel out after the order: request the whole channel back, wait out the cooldown, withdraw. */
export async function closeOut(world, { mandate, plan }) {
  let c
  try { c = await world.principalKit.closeOut(mandate, { holder: HOLDER, path: 'holder', history: plan.record }) } catch (e) {
    if (e?.code === 'INVALID_ARGUMENT' && /nothing to close/.test(e.message)) return { steps: [], returned: 0n }   // the cap was spent in full
    throw e
  }
  const before = world.escrow.balanceOf(HOLDER)
  world.escrow.send(HOLDER, c.steps[0].tx)
  world.advance(D48)
  world.escrow.send(HOLDER, c.steps[1].tx)
  return { steps: c.steps.map((s) => s.kind), returned: world.escrow.balanceOf(HOLDER) - before }
}

/**
 * A's holder revokes by publishing the list on A's site (what a verifier and A' read at every step): the named mandates, and/or
 * every mandate of A whose `notBefore` is earlier than `before` (a Unix time; default the world's clock now).
 */
export function revokeOnSite(world, { mandateHashes = [], before = 0 } = {}) { return revocationFile(world.x, { mandateHashes, revokedBefore: before }) }

export { S, S2, P, AG }
