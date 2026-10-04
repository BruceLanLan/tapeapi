#!/usr/bin/env node
// The principal's side of a container-agent job (EXPERIMENTAL, 1.7, phase 0): a script, not a CLI. It walks one task through the
// phase-0 protocol of @tapeapi/sdk/agent: sign an offer, get the agent's signed accept (with a fresh agentKey), sign the mandate for
// that key, receive the signed delivery, verify the whole thread, sign a verdict, and (only with --pay) build the payment as UNSIGNED
// transactions and verify it from the recipient's side. Run it:
//
//   node examples/agent-service/hire.mjs                 the job on the SDK's fake chain, everything in this process
//   node examples/agent-service/hire.mjs --same-holder   the agent container has the same holder: a self-hire, and it is flagged
//   node examples/agent-service/hire.mjs --pay           also the payment branch: unsigned transactions only (see below)
//
// TEST KEYS ONLY. The keys this script signs with are the fake chain's fixtures (demo-world.mjs: 0x11…, 0x22…): they exist on no real
// chain. Never use a real wallet's key with this example, never paste one into it, and never reuse a fixture key on a real chain.
// A real principal signs the same typed data in a wallet (eth_signTypedData_v4 over taskOfferTypedData / mandateTypedData /
// taskVerdictTypedData, which this script prints) instead of calling the sign functions: that is the one seam, `signer`.
// 仅限测试密钥：本脚本签名用的是假链夹具（demo-world.mjs）；它们在任何真链上都不存在。绝不要把真实钱包的私钥用在这个示例里，
// 也不要把夹具密钥用到真链上。真实的委托方在钱包里签同样的 typed data（本脚本会打印），那就是唯一的接缝 `signer`。
//
// The payment branch (--pay) never signs, never broadcasts, never grants an allowance and sends no transaction: it BUILDS the transfer
// (`transferToContainer`) and the TapeSend message that carries it (`encodeContent` with the verdictHash in the body, then
// `tapesend.sendTx`), prints every field of both unsigned transactions (a wallet cannot read an execute() calldata, so the fields are
// written out), and drives `paymentOrder` (record the transfer, confirm it, check the message carries it). The recipient is only ever
// the container the CHAIN names for the agent's circuit; no address is read from a task, a deliverable or any answer. In the demo the
// human with the wallet is simulated by the fake chain (demo-world.mjs `wallet`); on a real chain that step is yours.
// 付费支线（--pay）从不签名、不广播、不授权额度、不发交易：只构造转账与携带它的 TapeSend 消息，逐字段打印两笔未签交易；
// 收款方只取自链上为代理电路给出的容器，绝不取自任务、交付物或任何回答里的地址。演示里持钱包的人由假链模拟，真链上那一步由你自己完成。
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { tapesend } from '@tapeapi/sdk'
import * as agent from '@tapeapi/sdk/agent'
import { receiptOfCall } from './agent.mjs'

const {
  MODE_PAY, VERDICT_ACCEPT, VERDICT_REJECT, taskHashOf, jsonHashOf, taskOfferTypedData, signTaskOffer, offerHashOf, mandateTypedData, signMandate,
  mandateHashOf, taskVerdictTypedData, signTaskVerdict, verdictHashOf, plainText, forWallet, createPaymentKit, paymentOrder, encodeContent, validateAgentMember,
} = agent
const ZERO = '0x' + '00'.repeat(20)
const ZERO32 = '0x' + '00'.repeat(32)

/** The signer seam: signs with a local TEST key. A real principal replaces these three with a wallet's eth_signTypedData_v4. */
export function testSigner(testKey) {
  return {
    offer: (chainId, hub, offer) => signTaskOffer(chainId, hub, offer, testKey),
    mandate: (chainId, hub, mandate) => signMandate(chainId, hub, mandate, testKey),
    verdict: (chainId, hub, verdict) => signTaskVerdict(chainId, hub, verdict, testKey),
  }
}

const typedLines = (td) => [`typed data ${td.primaryType} (domain ${td.domain.name} ${td.domain.version}, chain ${td.domain.chainId}, hub ${td.domain.verifyingContract})`,
  ...Object.entries(td.message).map(([k, v]) => `  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)]

// What a principal sees before signing: the payload a wallet gets (forWallet: domain, types, primaryType and message, nothing else) and,
// apart from it, what only the console shows (the SDK's warnings and display: task text checked against its hash, dates in words).
// 签名之前看到的：钱包拿到的载荷（forWallet 只留四个键）与只给控制台看的 warnings、display。
// `expect` is the chain and hub THIS console is configured for (the principal's kit), never read from the payload it is about to show:
// forWallet refuses a payload for another chain or hub, which a payload rebuilt from its own domain could not notice.
// expect 是本控制台自己配置的链与 hub（来自委托方的 kit），绝不从待签载荷里取。
function showPrompt(print, title, td, expect) {
  const { payload, warnings, display } = forWallet(td, expect)
  print(title)
  typedLines(payload).forEach((l) => print('   ' + l))
  for (const w of warnings) print(`   console notice (not sent to the wallet): ${w}`)
  if (display) print(`   console display (not sent to the wallet): ${plainText(JSON.stringify(display), 400)}`)
  return payload
}

/** One check of a thread, as lines. Names on chain are shown as they are; a manifest's name is marked untrusted. */
export function threadLines(c) {
  const who = (i) => (i ? `${i.container}${i.name ? ` (${i.name})` : ''}` : 'unknown')
  const out = [`thread: state ${c.state}  ok ${c.ok}  enforcement ${c.enforcement}  selfHire ${c.selfHire}${c.selfHire ? ` (${c.selfHireReasons.join(', ')})` : ''}`,
    `  principal ${who(c.principal)}`, `  agent     ${who(c.agent)}${c.agent?.displayName ? `  manifest name, untrusted: "${plainText(c.agent.displayName.text, 64)}"` : ''}`]
  for (const p of c.problems) out.push(`  problem ${p.code}: ${plainText(p.message, 160)}`)
  if (c.evidence) out.push(`  evidence: ${c.evidence.receipts.length} receipt(s), ok ${c.evidence.ok}; proves: ${c.evidence.proves}; does NOT prove: ${c.evidence.doesNotProve.join('; ')}`)
  if (c.verdict) out.push(`  verdict ${c.verdict.verdict} (verdictHash ${c.verdict.verdictHash})`)
  return out
}

/**
 * The whole job. Returns every message and every check; throws when a call is refused (the agent's refusal is a TapeAPIError with the
 * reasons in `data`).
 *   api, kit        the principal's client and createAgentKit(api)
 *   agent           the agent's container;  principal  the principal's container
 *   signer          { offer, mandate, verdict }: see testSigner
 *   providers       the containers the mandate lists in scope (each with cap 0)
 *   task            the task object (data); default: read the BSC block height
 *   mandate         fields to override in the mandate (tests): signing refuses one that names an amount or an asset (AGENT_INVALID)
 *   expect          { chainId, hub } this console is configured for (default: the kit's); every wallet payload is checked against it
 *   offerFee        the offer's price statement (default '0'); never a payment
 *   pay             null, or { token, amount, route: 'wallet' | 'container', wallet }  (token and amount come from you, never from a text)
 */
export async function hire({ api, kit, agent: agentContainer, principal, signer, providers, task, mandate: mandateOver = {}, pay = null, print = () => {}, clock = () => Math.floor(Date.now() / 1000), nonce = '1', offerFee = '0', expect }) {
  const { chainId, hub } = kit
  // the chain and hub this console is configured for: given by the caller's configuration, by default the principal's own kit; forWallet checks
  // every payload against it (a payload built for another chain or hub is refused)
  expect ??= { chainId, hub }
  const now = clock()
  task ??= { kind: 'chain.block-height', chain: 'bsc', spec: 'Read the BNB Smart Chain block height from the listed providers' }
  const svc = await api.resolve(agentContainer)
  let member = null
  try { if (svc.manifest.agent) member = validateAgentMember(svc.manifest.agent) } catch { /* a bad agent member is only a missing hint */ }
  print(`agent ${svc.container}  manifest name (untrusted): "${plainText(svc.manifest.name, 64)}"  tasks: ${member ? member.tasks.map((t) => t.kind).join(', ') : 'not published'}`)
  const call = async (method, params) => ({ r: await api.call(svc, method, params), params })

  // 1. the offer: the principal's HOLDER signs it (a wallet, or here a test key)
  // Phase 0 names no asset anywhere: feeToken is the zero address. `fee` is only a price statement (default 0: the price is agreed
  // elsewhere, and the payment is a separate transfer the principal makes); a non-zero one makes the SDK attach a warning.
  const prompts = []   // what would go to a wallet, in order: the payloads forWallet returns, nothing else
  const offer = { principal, agent: agentContainer, taskHash: taskHashOf(task), mode: MODE_PAY, feeToken: ZERO, fee: offerFee, deadline: now + 3600, exp: now + 900, nonce }
  prompts.push(showPrompt(print, '1. offer: what a wallet would be asked to sign', taskOfferTypedData(chainId, hub, offer), expect))
  const offerMsg = { v: 0, kind: 'tape.agent/offer', task, offer, sig: await signer.offer(chainId, hub, offer) }
  const offerHash = offerHashOf(chainId, hub, offer)

  // 2. the agent's signed accept, with the key it made for THIS order
  const { r: acc, params: accParams } = await call('task_offer', { message: offerMsg })
  if (acc.result.kind !== 'tape.agent/accept' || acc.result.offerHash !== offerHash) throw new Error('the agent did not accept this offer')
  const acceptMsg = { v: 0, kind: 'tape.agent/accept', receipt: receiptOfCall(svc, 'task_offer', accParams, acc) }
  print(`2. accept: agentKey ${acc.result.agentKey} (made for this order), valid until ${acc.result.exp}`)

  // 3. the mandate names that agentKey; phase 0: every cap 0, scope = the providers the agent may call
  const mandate = {
    principal, agent: agentContainer, agentKey: acc.result.agentKey, mode: MODE_PAY, taskHash: offer.taskHash,
    scope: providers.map((provider) => ({ provider, token: ZERO, cap: '0' })), feeToken: ZERO, feeCap: '0',
    notBefore: now - 60, expires: now + 86_400, nonce, subdelegate: false, ...mandateOver,   // nonce: the offer's (the thread check requires it)
  }
  // the SDK refuses to build this payload (and signMandate refuses to sign it) for a mandate that names an amount, an asset or
  // sub-delegation: nothing here opts out of that phase-0 gate, so a poisoned caller cannot get a funded mandate signed through this script
  // `task`: the SDK checks the text against the mandate's taskHash and returns it for the console to show beside the prompt
  prompts.push(showPrompt(print, '3. mandate: what a wallet would be asked to sign (a statement, not a gate: enforcement none)', mandateTypedData(chainId, hub, mandate, { task }), expect))
  const mandateMsg = { v: 0, kind: 'tape.agent/mandate', mandate, sig: await signer.mandate(chainId, hub, mandate) }
  const mandateHash = mandateHashOf(chainId, hub, mandate)
  const { r: started } = await call('task_mandate', { offerHash, message: mandateMsg })
  print(`   the agent verified the mandate and started: state ${started.result.state}`)

  // 4. the delivery (a signed receipt) and the deliverable (data, checked against the signed hash)
  const { r: del, params: delParams } = await call('task_deliver', { mandateHash })
  const deliverMsg = { v: 0, kind: 'tape.agent/deliver', receipt: receiptOfCall(svc, 'task_deliver', delParams, del) }
  const { r: st } = await call('task_status', { mandateHash, mandate: mandateMsg })
  const deliverable = st.result.deliverable
  const hashOk = deliverable !== undefined && jsonHashOf(deliverable) === del.result.deliverableHash
  print(`4. delivery: ${del.result.receipts.length} upstream receipt(s), deliverable hash ${hashOk ? 'matches' : 'DOES NOT MATCH'}; deliverable (data): ${plainText(JSON.stringify(deliverable), 300)}`)

  // 5. the whole thread, then the verdict
  const thread = [offerMsg, acceptMsg, mandateMsg, deliverMsg]
  const before = await kit.verifyTaskThread(thread)
  threadLines(before).forEach((l, i) => print((i === 0 ? '5. ' : '   ') + l.trimEnd()))
  const accepted = before.ok && before.state === 'Delivered' && hashOk
  const verdict = { mandateHash, deliverableHash: del.result.deliverableHash, verdict: accepted ? VERDICT_ACCEPT : VERDICT_REJECT, reasonHash: ZERO32, issued: clock() }
  prompts.push(showPrompt(print, '6. verdict: what a wallet would be asked to sign', taskVerdictTypedData(chainId, hub, verdict), expect))
  const verdictMsg = { v: 0, kind: 'tape.agent/acceptance', verdict, sig: await signer.verdict(chainId, hub, verdict) }
  const verdictHash = verdictHashOf(chainId, hub, verdict)
  const final = await kit.verifyTaskThread([...thread, verdictMsg])
  threadLines(final).forEach((l) => print('   ' + l.trimEnd()))
  const out = { prompts, messages: [...thread, verdictMsg], offerHash, mandateHash, verdictHash, deliverable, before, final, accepted, selfHire: final.selfHire }
  if (pay && accepted) out.payment = await payBranch({ api, kit, agent: agentContainer, principal, pay, verdictHash, print, clock })
  return out
}

/**
 * The payment of an accepted job, phase 0: unsigned transactions and read-only verification. The recipient is the container the chain
 * derives from the agent container's own circuit (`identityOf` reads token(), then `recipientOf` re-reads it through isCPU and
 * hub.accountOf; identityOf already made the hub derive the very container the offer named), and nothing here takes an address from a text.
 */
export async function payBranch({ api, kit, agent: agentContainer, principal, pay, verdictHash, print = () => {}, clock = () => Math.floor(Date.now() / 1000) }) {
  const { wallet } = pay
  const pk = createPaymentKit(api)
  const target = await (async () => { const id = await kit.identityOf(agentContainer); return { circuits: id.circuits, tokenId: id.tokenId } })()
  const recipient = await pk.recipientOf(target)
  const direct = await pk.transferToContainer({ token: pay.token, amount: pay.amount, ...target })
  const unsigned = pay.route === 'container' ? pk.viaContainer({ from: principal, tx: direct }) : direct
  print('7. payment (UNSIGNED: nothing here signs or broadcasts; compare every field with your wallet before you sign)')
  print(`   route: ${pay.route === 'container' ? 'ERC-20 through the principal container (its holder signs execute())' : 'ERC-20 straight from the holder wallet'}`)
  for (const l of unsigned.summary) print('   ' + l)
  print(`   raw: to ${unsigned.to}  value ${unsigned.value}  data ${unsigned.data}`)
  const order = paymentOrder({ clock })
  // If the wallet's transfer reverts, is cancelled or is sped up under another hash, paymentOrder().dropTransfer / replaceTransfer say so (TAP-10 §20
  // step 4); this script only follows the happy path.
  const sent = await wallet.transfer({ to: unsigned.to, data: unsigned.data, value: unsigned.value })   // the human, in a wallet
  order.recordTransfer({ recipient: recipient.container, tx: sent.tx })
  order.confirmTransfer({ recipient: recipient.container, tx: sent.tx, blockTime: sent.blockTime })
  const attachment = { type: 'erc20', chainId: kit.chainId, token: pay.token, amount: String(pay.amount), tx: sent.tx }
  const content = encodeContent({ subject: 'payment', body: `payment for the verdict ${verdictHash}`, attachments: [attachment] })
  order.checkMessage({ recipient: recipient.container, attachments: [attachment] })
  const principalId = await kit.identityOf(principal)
  const sendTx = tapesend.sendTx({ hub: kit.hub, circuits: principalId.circuits, tokenId: principalId.tokenId, to: recipient.container, payload: tapesend.encodePublic(content) })
  print('   then the TapeSend message that carries it (UNSIGNED; the transfer must be the first thing sent to this recipient, within 3,600 s):')
  print(`   raw: to ${sendTx.to}  value ${sendTx.value}  data ${plainText(sendTx.data.slice(0, 74), 80)}… (${(sendTx.data.length - 2) / 2} bytes)`)
  const posted = await wallet.send(sendTx)                                                              // the human, in a wallet
  order.messageSent({ recipient: recipient.container, attachments: [attachment] })
  // the recipient's side: read the message from the chain, verify the payment (TAP-10 §19), and see the verdict it names
  const msg = await pk.readMessage({ recipient: recipient.container, inboxIndex: posted.inboxIndex })
  const results = await pk.verifyAttachments(msg)
  const names = typeof msg.message?.body === 'string' && msg.message.body.includes(verdictHash)
  print(`8. recipient check (TAP-10 §19): ${results.map((r) => r.result).join(', ')}; the message names the verdict: ${names}`)
  return { unsigned, sendTx, recipient, results, message: msg, namesVerdict: names, attachment }
}

// ---------------------------------------------------------------------------------------------------------------------
const USAGE = `hire.mjs: a container-agent job on the SDK's fake chain (EXPERIMENTAL, phase 0; test keys only)

  node examples/agent-service/hire.mjs [--same-holder] [--pay [--via-container]]

  --same-holder     the agent container has the principal's holder: a self-hire, which the checks report
  --pay             also build the payment as unsigned transactions and verify it from the recipient's side
  --via-container   with --pay: the ERC-20 goes through the principal container's execute() (default: from the holder wallet)

Exit status: 0 the job settled, 1 it did not or failed, 2 a usage mistake.
`
export async function main(argv = process.argv.slice(2), { stdout = (l) => console.log(l) } = {}) {
  const flags = new Set(argv)
  for (const a of flags) if (!['--same-holder', '--pay', '--via-container', '--help', '-h'].includes(a)) { console.error(`hire.mjs: unknown option ${a}\n\n${USAGE}`); return 2 }
  if (flags.has('--help') || flags.has('-h')) { stdout(USAGE); return 0 }
  if (flags.has('--via-container') && !flags.has('--pay')) { console.error(`hire.mjs: --via-container needs --pay\n\n${USAGE}`); return 2 }
  const { createDemoWorld, KEYS, P, AG, S, TOKEN } = await import('./demo-world.mjs')
  const world = await createDemoWorld({ sameHolder: flags.has('--same-holder') })
  try {
    stdout('container-agent job on the SDK\'s FAKE chain: nothing is on BNB Smart Chain, no real key, nothing leaves this process; its clock is fixed (the fake chain has its own calendar)')
    const r = await hire({
      api: world.principalApi, kit: world.principalKit, agent: AG, principal: P, signer: testSigner(KEYS.principalHolder), providers: [S], print: stdout, clock: world.clock,
      pay: flags.has('--pay') ? { token: TOKEN, amount: '1000000000000000000', route: flags.has('--via-container') ? 'container' : 'wallet', wallet: world.wallet } : null,
    })
    return r.final.ok && r.final.state === 'Settled' && (!r.payment || r.payment.results.every((x) => x.result === 'ok')) ? 0 : 1
  } finally { world.close() }
}
const self = (() => { try { return realpathSync(fileURLToPath(import.meta.url)) } catch { return null } })()
const argv1 = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) } catch { return null } })()
if (self && self === argv1) main().then((c) => process.exit(c), (e) => { console.error(`hire.mjs: ${e?.code ? e.code + ': ' : ''}${e?.message ?? e}`); process.exit(1) })
