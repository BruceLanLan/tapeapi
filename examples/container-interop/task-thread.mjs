// Scenario (b): container A sends container B a task thread; B delivers; A accepts or rejects (EXPERIMENTAL, phase 0).
//
//   A = the principal container #11 (its holder signs the offer, the mandate and the verdict).
//   B = the agent container #12 (its manifest signer signs the accept and the delivery, as answers of its methods).
//   S = a provider container #13 that B reads for the task: B's evidence is S's hash-only receipts.
//
// The thread is the one of examples/agent-service (`tape.agent/*`, TAP-18 = TapeOutProtocol/TAPs#47: merged as Draft, and not an adopted
// standard); what this file adds is A's side of the ACCEPTANCE. The SDK's thread check proves who signed what and that the
// pieces belong together; it does not look inside the deliverable. So A does its own check before it signs a verdict: the
// deliverable must hash to what B signed, and every number in it must be the body of a receipt S signed. A deliverable that
// fails it is rejected, and B's signed delivery stays on record as B's own statement.
// 场景 (b)：容器 A 向容器 B 发任务线程；B 交付；A 验收或拒收（实验性，阶段 0）。线程格式就是 agent-service 的那一套
// （`tape.agent/*`，TAP-18，即 TapeOutProtocol/TAPs#47，已合并为 Draft）；本文件补的是 A 一侧的**验收**：SDK 的线程核验证明"谁签了什么、各部分是否
// 属于同一个线程"，不看交付物的内部。所以 A 在签裁决之前自己核对：交付物要哈希到 B 签过的值，里面的每个数都要是 S 签过的某张回执的
// 回答体。不合格就拒收；B 签过的交付仍然留在记录里，是 B 自己的陈述。
import { jsonHashOf, taskHashOf, MODE_PAY, VERDICT_ACCEPT, VERDICT_REJECT, verdictHashOf, offerHashOf, mandateHashOf, signMandateRevocation, plainText } from '@tapeapi/sdk/agent'
import { receiptOfCall, blockHeightTask } from '../agent-service/agent.mjs'
import { testSigner, threadLines } from '../agent-service/hire.mjs'
import { P, AG, S, KEYS } from './world.mjs'
import { verifyReceipt } from './receipts.mjs'

const ZERO = '0x' + '00'.repeat(20)
const ZERO32 = '0x' + '00'.repeat(32)
export const TASK = { kind: 'chain.block-height', chain: 'bsc', spec: 'Read the BNB Smart Chain block height from provider S' }

/** A container B whose delivery is wrong on purpose: every number it reports is `offset` above what S answered. */
export function misreportingTask({ offset = 1, readMethod = 'blockNumber' } = {}) {
  const honest = blockHeightTask({ readMethod })
  return {
    needsProviders: true,
    async run(task, ctx) {
      const d = await honest.run(task, ctx)
      return { ...d, blockNumber: d.blockNumber + offset, answers: d.answers.map((a) => ({ ...a, blockNumber: a.blockNumber + offset })) }
    },
  }
}

/**
 * A's own check of a delivery, before it signs a verdict. `delivered` is B's signed `tape.agent/deliver` result and
 * `deliverable` the data B handed over (shown with plainText wherever a person could read it, never obeyed).
 * Returns { ok, problems: [{ code, message }] }.
 */
export async function checkDeliverable({ api, deliverable, delivered, scope = [S], readMethod = 'blockNumber' }) {
  const problems = []
  const add = (code, message) => problems.push({ code, message })
  let h = null
  try { h = jsonHashOf(deliverable) } catch (e) { add('deliverable-no-canonical-form', plainText(e.message, 160)) }
  if (h !== null && h !== delivered.deliverableHash) add('deliverable-hash-mismatch', 'the deliverable is not the one B signed the hash of')
  const answers = Array.isArray(deliverable?.answers) ? deliverable.answers : []
  if (answers.length === 0) add('no-answers', 'the deliverable lists no answers')
  const receipts = Array.isArray(delivered.receipts) ? delivered.receipts : []
  if (receipts.length !== answers.length) add('receipt-count', `${answers.length} answer(s), ${receipts.length} receipt(s)`)
  const used = new Set()
  for (const [i, a] of answers.entries()) {
    const provider = String(a?.provider ?? '').toLowerCase()
    if (!scope.some((s) => s.toLowerCase() === provider)) { add('answer-provider-out-of-scope', `answers[${i}] names a container the mandate does not list`); continue }
    if (!Number.isSafeInteger(a.blockNumber)) { add('answer-not-a-number', `answers[${i}] is not a block number`); continue }
    // the receipt whose body is exactly what the deliverable says that provider answered
    let matched = false
    for (const [j, r] of receipts.entries()) {
      if (used.has(j) || String(r?.service?.container ?? '').toLowerCase() !== provider) continue
      const v = await verifyReceipt(api, r, { container: provider, method: readMethod, params: {}, result: { blockNumber: a.blockNumber } })
      if (v.ok) { used.add(j); matched = true; break }
    }
    if (!matched) add('answer-not-in-receipts', `answers[${i}] (${plainText(String(a.blockNumber), 20)}) is not the body of any receipt of ${a.provider}: nothing S signed says so`)
  }
  return { ok: problems.length === 0, problems }
}

/**
 * The whole thread. Returns every message and every check; it throws when B refuses a call (a TapeAPIError with `data`).
 *   world     createInteropWorld({ channels: false, ... }) (or any agent-service demo world)
 *   signer    { offer, mandate, verdict }: testSigner(KEYS.principalHolder) by default (a wallet's seam in real use)
 *   revokeBeforeDelivery   A sends a signed revocation to B (task_status) before it asks for the delivery
 */
export async function runTaskThread({ world, signer = testSigner(KEYS.principalHolder), task = TASK, providers = [S], nonce = '1', print = () => {}, revokeBeforeDelivery = false, mutateTaskText } = {}) {
  const w = world
  const { chainId, hub } = w.principalKit
  const now = w.clock()
  const svc = await w.principalApi.resolve(AG)
  const call = async (method, params) => ({ r: await w.principalApi.call(svc, method, params), params })
  const say = (s) => print(s)

  // 1. A -> B: the offer (A's holder signs it); B checks it names B, and answers with the key it made for THIS order
  const offer = { principal: P, agent: AG, taskHash: taskHashOf(task), mode: MODE_PAY, feeToken: ZERO, fee: '0', deadline: now + 3600, exp: now + 900, nonce }
  const offerMsg = { v: 0, kind: 'tape.agent/offer', task, offer, sig: await signer.offer(chainId, hub, offer) }
  const offerHash = offerHashOf(chainId, hub, offer)
  const { r: acc, params: accParams } = await call('task_offer', { message: offerMsg })
  const acceptMsg = { v: 0, kind: 'tape.agent/accept', receipt: receiptOfCall(svc, 'task_offer', accParams, acc) }
  say(`1. A -> B offer ${offerHash.slice(0, 10)}…; B accepts, agentKey ${acc.result.agentKey} (made for this order)`)

  // 2. A -> B: the mandate: B may call these containers and no other (every cap 0 in phase 0: it is a statement, not a gate)
  const mandate = {
    principal: P, agent: AG, agentKey: acc.result.agentKey, mode: MODE_PAY, taskHash: offer.taskHash,
    scope: providers.map((provider) => ({ provider, token: ZERO, cap: '0' })), feeToken: ZERO, feeCap: '0',
    notBefore: now - 60, expires: now + 86_400, nonce, subdelegate: false,
  }
  const mandateMsg = { v: 0, kind: 'tape.agent/mandate', mandate, sig: await signer.mandate(chainId, hub, mandate) }
  const mandateHash = mandateHashOf(chainId, hub, mandate)
  const { r: started } = await call('task_mandate', { offerHash, message: mandateMsg })
  say(`2. A -> B mandate ${mandateHash.slice(0, 10)}…, scope ${providers.length} container(s); B verified it and started: ${started.result.state}`)

  if (revokeBeforeDelivery) {
    const revocation = { principal: P, mandateHashes: [mandateHash], revokedBefore: 0, issued: w.clock() }
    const revMsg = { v: 0, kind: 'tape.agent/revocation', revocation, sig: signMandateRevocation(chainId, hub, revocation, KEYS.principalHolder) }
    await call('task_status', { mandateHash, revocation: revMsg })
    say('   A -> B revocation (signed by A\'s holder): B stops and signs nothing more for this mandate')
  }

  // 3. B -> A: the delivery (a signed answer of B's task_deliver) and the deliverable (data, shown under the signed hash)
  const { r: del, params: delParams } = await call('task_deliver', { mandateHash })
  const deliverMsg = { v: 0, kind: 'tape.agent/deliver', receipt: receiptOfCall(svc, 'task_deliver', delParams, del) }
  const { r: st } = await call('task_status', { mandateHash, mandate: mandateMsg })
  const deliverable = st.result.deliverable
  say(`3. B -> A delivery: ${del.result.receipts.length} receipt(s) of S's answers; deliverable ${plainText(JSON.stringify(deliverable), 200)}`)

  // 4. A checks, as the SDK's thread check does (who signed what) and as only A can (is it what A asked for)
  const thread = [mutateTaskText ? { ...offerMsg, task: mutateTaskText(offerMsg.task) } : offerMsg, acceptMsg, mandateMsg, deliverMsg]
  const before = await w.principalKit.verifyTaskThread(thread)
  threadLines(before).forEach((l, i) => say((i === 0 ? '4. ' : '   ') + l.trimEnd()))
  const own = await checkDeliverable({ api: w.principalApi, deliverable, delivered: del.result, scope: providers })
  say(`   A's own check of the deliverable: ${own.ok ? 'ok' : 'FAILED ' + own.problems.map((p) => p.code).join(', ')}`)

  // 5. A -> B: the verdict (A's holder signs it): accept, or reject with a hash of the written reason
  const accepted = before.ok && before.state === 'Delivered' && own.ok
  const verdict = { mandateHash, deliverableHash: del.result.deliverableHash, verdict: accepted ? VERDICT_ACCEPT : VERDICT_REJECT, reasonHash: accepted ? ZERO32 : jsonHashOf(own.problems.length ? own.problems : [{ code: 'thread-not-ok' }]), issued: w.clock() }
  const verdictMsg = { v: 0, kind: 'tape.agent/acceptance', verdict, sig: await signer.verdict(chainId, hub, verdict) }
  const final = await w.principalKit.verifyTaskThread([...thread, verdictMsg])
  say(`5. A -> B verdict: ${accepted ? 'accepted' : 'rejected'} (verdictHash ${verdictHashOf(chainId, hub, verdict).slice(0, 10)}…); thread state ${final.state}`)
  return { messages: [...thread, verdictMsg], offerMsg, acceptMsg, mandateMsg, deliverMsg, verdictMsg, offerHash, mandateHash, deliverable, delivered: del.result, before, own, final, accepted, selfHire: final.selfHire }
}
