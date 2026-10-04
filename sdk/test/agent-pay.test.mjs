// Container agents, phase 0 payment (1.7, @experimental): TAP-10 §16 content with asset attachments, the fifteen steps
// of TAP-10 §19 (read-only), unsigned transfers whose recipient only the chain names, and the order §19 needs.
// Adversarial cases are named FIXED CP-xx; each was checked by removing the line that implements it.
// 阶段 0 付款：§16 内容与资产附件、§19 十五步只读核验、收款地址只来自链上的待签交易、§19 要求的操作顺序。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as agent from '@tapeapi/sdk/agent'
import { keccak256, utf8ToBytes, toHex, decodeParams, hexToBytes } from '../src/abi.js'
import { encodePublic } from '../src/tapesend.js'
import { standardWorld, KEYS, addrOf, P, AG, S, TOKEN, ADDR } from './helpers/agent-chain.mjs'

const { createPaymentKit, encodeContent, decodeContent, paymentOrder } = agent
const HP = addrOf(KEYS.principalHolder)          // the principal's holder wallet / 委托方持有人钱包
const HEAD = 62_000_000
const MB = HEAD - 100                             // the message's block (final) / 消息所在区块（已终局）
const te = (s) => new TextEncoder().encode(s)

// One paid message: a transfer at `tb`, then a message at `mb` attaching it. / 一笔转账与附带它的消息
function paid(x, { kind = 'erc20', amount = '1000', tb = MB - 10, mb = MB, transfer = {}, message = {}, attachment = {} } = {}) {
  const tx = kind === 'erc20'
    ? x.erc20Transfer({ payer: HP, to: AG, amount, block: tb, ...transfer })
    : x.nativeTransfer({ wallet: HP, to: AG, amount, block: tb, ...transfer })
  const a = { type: kind, chainId: 56, ...(kind === 'erc20' ? { token: TOKEN.toLowerCase() } : {}), amount, tx, ...attachment }
  const sent = x.send({ from: P, wallet: HP, to: AG, content: encodeContent({ body: 'payment for acceptance 0xabc', attachments: [a] }), block: mb, ...message })
  return { tx, a, index: sent.index }
}
async function check(x, index, opts) {
  const pay = createPaymentKit(x.api(), opts)
  const msg = await pay.readMessage({ recipient: AG, inboxIndex: index })
  assert.equal(msg.status, 'ok')
  return { pay, msg, results: await pay.verifyAttachments(msg) }
}
const resultOf = async (x, index) => (await check(x, index)).results[0].result

test('FIXED CP-01: TAP-10 §16 content: build, decode, and every decoding rule in order', () => {
  const a = { type: 'erc20', chainId: 56, token: TOKEN, amount: '5', tx: '0x' + 'ab'.repeat(32) }
  const d = decodeContent(encodeContent({ subject: 'paid', body: 'for 0xabc', ts: 1, attachments: [a] }))
  assert.equal(d.status, 'ok'); assert.equal(d.message.body, 'for 0xabc'); assert.equal(d.attachments[0].token, TOKEN.toLowerCase())
  assert.equal(decodeContent(Uint8Array.of(0xef, 0xbb, 0xbf, ...te('{"v":1,"kind":"message","body":""}'))).status, 'damaged')
  assert.equal(decodeContent(te('{"v":1,"kind":"message","body":"","body":"x"}')).status, 'damaged')
  assert.equal(decodeContent(te('{"v":2,"kind":"message","body":""}')).status, 'unsupported')
  assert.equal(decodeContent(te('{"v":1,"kind":"other","body":""}')).status, 'unsupported')
  assert.equal(decodeContent(te('{"v":1,"kind":"message"}')).status, 'damaged')
  assert.equal(decodeContent(te('[1]')).status, 'damaged')
  assert.equal(decodeContent(te('{"v":1,"kind":"message","body":"' + '['.repeat(0) + '","x":' + '['.repeat(40) + ']'.repeat(40) + '}')).status, 'damaged')
  assert.equal(decodeContent(te('{"v":1,"kind":"message","body":"\\ud800"}')).status, 'damaged')
  assert.equal(decodeContent(Uint8Array.of(0xff, 0xfe)).status, 'damaged')
  // attachments never damage a message: invalid ones are dropped and counted, beyond the fourth count, a non-array is one
  const many = { v: 1, kind: 'message', body: '', attachments: [a, { ...a, amount: '01' }, { type: 'image', mime: 'image/png', data: 'AA==', w: 1, h: 1 }, { ...a, tx: '0x12' }, a, a] }
  const dm = decodeContent(te(JSON.stringify(many)))
  assert.equal(dm.status, 'ok'); assert.equal(dm.attachments.length, 1); assert.equal(dm.images, 1); assert.equal(dm.dropped, 2 + 2)
  assert.equal(decodeContent(te('{"v":1,"kind":"message","body":"","attachments":{}}')).dropped, 1)
  assert.equal([...decodeContent(te(JSON.stringify({ v: 1, kind: 'message', body: '', subject: 'x'.repeat(300) }))).message.subject].length, 200)
  assert.throws(() => encodeContent({ attachments: [{ ...a, amount: '0' }] }), (e) => e.code === 'INVALID_ARGUMENT')
  assert.throws(() => encodeContent({ attachments: [a, a] }), /repeats/)
})

test('§19 ok: an ERC-20 straight from the wallet, the native coin straight from the wallet, an ERC-20 through the payer\'s container', async () => {
  {
    const x = standardWorld(); const { index } = paid(x)
    const { results } = await check(x, index)
    assert.equal(results[0].result, 'ok'); assert.equal(results[0].payer, HP); assert.equal(results[0].wallet, HP)
    assert.equal(results[0].known, false, 'the SDK ships no token list: shown neutrally unless the client knows the token')
  }
  {
    const x = standardWorld(); const { index } = paid(x, { kind: 'native', amount: '7' })
    assert.equal(await resultOf(x, index), 'ok')
  }
  {
    // TAP-10 §19 step 10: out of the sender's own container counts as paid by the sender when tx.from is the sending wallet
    const x = standardWorld(); const { index } = paid(x, { transfer: { payer: P, wallet: HP, txTo: P } })
    assert.equal(await resultOf(x, index), 'ok')
  }
})

test('FIXED CP-02: the native coin through a container cannot be verified (step 5: unverifiable)', async () => {
  const x = standardWorld()
  const { index } = paid(x, { kind: 'native', transfer: { wallet: HP, to: P } })   // the wallet's tx goes to its own container / 交易发往自己的容器
  assert.equal(await resultOf(x, index), 'unverifiable')
})

test('FIXED CP-03: a transfer to anyone but the message\'s recipient container is no payment (step 6: mismatch)', async () => {
  const x = standardWorld()
  const { index } = paid(x, { transfer: { to: S } })
  assert.equal(await resultOf(x, index), 'mismatch')
  const y = standardWorld()
  const r = paid(y, { amount: '1000', attachment: { amount: '999' } })
  assert.equal(await resultOf(y, r.index), 'mismatch')
})

test('FIXED CP-04: a transfer more than 3,600 s before the message is stale; exactly 3,600 s is still ok', async () => {
  const x = standardWorld()
  const r1 = paid(x, { tb: MB - 3601, mb: MB })     // one block per second in the fake chain / 假链一秒一块
  assert.equal(await resultOf(x, r1.index), 'stale')
  const y = standardWorld()
  const r2 = paid(y, { tb: MB - 3600, mb: MB })
  assert.equal(await resultOf(y, r2.index), 'ok')
})

test('FIXED CP-05: another message to the same recipient between the transfer and the attachment message is not-first', async () => {
  {
    const x = standardWorld()
    const tx = x.erc20Transfer({ payer: HP, to: AG, amount: '1000', block: MB - 10 })
    x.send({ from: P, wallet: HP, to: AG, block: MB - 5 })                  // same container / 同一容器
    const { index } = x.send({ from: P, wallet: HP, to: AG, block: MB, content: encodeContent({ body: '', attachments: [{ type: 'erc20', chainId: 56, token: TOKEN, amount: '1000', tx }] }) })
    assert.equal(await resultOf(x, index), 'not-first')
  }
  {
    // the same container written by another wallet (the circuit changed hands): the container rule alone decides
    const x = standardWorld()
    const tx = x.erc20Transfer({ payer: HP, to: AG, amount: '1000', block: MB - 10 })
    x.send({ from: P, wallet: addrOf(KEYS.stranger), to: AG, block: MB - 5 })
    const { index } = x.send({ from: P, wallet: HP, to: AG, block: MB, content: encodeContent({ body: '', attachments: [{ type: 'erc20', chainId: 56, token: TOKEN, amount: '1000', tx }] }) })
    assert.equal(await resultOf(x, index), 'not-first')
  }
  {
    const x = standardWorld()
    const Q = '0x' + 'c9'.repeat(20)
    const tx = x.erc20Transfer({ payer: HP, to: AG, amount: '1000', block: MB - 10 })
    x.send({ from: Q, wallet: HP, to: AG, block: MB - 5 })                  // another container, the same wallet / 同一钱包
    const { index } = x.send({ from: P, wallet: HP, to: AG, block: MB, content: encodeContent({ body: '', attachments: [{ type: 'erc20', chainId: 56, token: TOKEN, amount: '1000', tx }] }) })
    assert.equal(await resultOf(x, index), 'not-first')
  }
  {
    const x = standardWorld()
    const tx = x.erc20Transfer({ payer: HP, to: AG, amount: '1000', block: MB - 10 })
    x.send({ from: '0x' + 'c8'.repeat(20), wallet: addrOf(KEYS.stranger), to: AG, block: MB - 5 })   // an unrelated sender / 无关的发件人
    x.send({ from: P, wallet: HP, to: AG, block: MB - 20 })                 // before the transfer: does not count / 转账之前：不算
    const { index } = x.send({ from: P, wallet: HP, to: AG, block: MB, content: encodeContent({ body: '', attachments: [{ type: 'erc20', chainId: 56, token: TOKEN, amount: '1000', tx }] }) })
    assert.equal(await resultOf(x, index), 'ok')
  }
})

test('FIXED CP-06: late (transfer after the message), third-party (someone else paid), indirect (message not sent to the hub, or with an NFT move)', async () => {
  const x = standardWorld()
  assert.equal(await resultOf(x, paid(x, { tb: MB + 1, mb: MB }).index), 'late')
  const y = standardWorld()
  assert.equal(await resultOf(y, paid(y, { transfer: { payer: addrOf(KEYS.stranger), wallet: addrOf(KEYS.stranger) } }).index), 'third-party')
  const z = standardWorld()
  assert.equal(await resultOf(z, paid(z, { message: { txTo: '0x' + 'de'.repeat(20) } }).index), 'indirect')
  const w = standardWorld()
  const nft = { address: '0x' + 'aa'.repeat(20), topics: [agent.TRANSFER_TOPIC, '0x' + '00'.repeat(32), '0x' + '00'.repeat(32), '0x' + '00'.repeat(31) + '01'], data: '0x' }
  assert.equal(await resultOf(w, paid(w, { message: { extraLogs: [nft] } }).index), 'indirect')
})

test('FIXED CP-07: pending (above the finalized block), mismatch (no transaction, a reverted one), crowded (more than 60 entries since)', async () => {
  const x = standardWorld()
  assert.equal(await resultOf(x, paid(x, { mb: HEAD - 1, tb: HEAD - 5 }).index), 'pending')
  const y = standardWorld()
  assert.equal(await resultOf(y, paid(y, { transfer: { status: 0 } }).index), 'mismatch')
  const z = standardWorld()
  const ghost = '0x' + '77'.repeat(32)
  const { index } = z.send({ from: P, wallet: HP, to: AG, block: MB, content: encodeContent({ body: '', attachments: [{ type: 'erc20', chainId: 56, token: TOKEN, amount: '1', tx: ghost }] }) })
  assert.equal(await resultOf(z, index), 'mismatch')
  const c = standardWorld()
  const tx = c.erc20Transfer({ payer: HP, to: AG, amount: '1000', block: MB - 100 })
  for (let i = 0; i < 61; i++) c.send({ from: '0x' + (0x100 + i).toString(16).padStart(40, '0'), wallet: addrOf(KEYS.stranger), to: AG, block: MB - 90 + i })
  const last = c.send({ from: P, wallet: HP, to: AG, block: MB, content: encodeContent({ body: '', attachments: [{ type: 'erc20', chainId: 56, token: TOKEN, amount: '1000', tx }] }) })
  assert.equal(await resultOf(c, last.index), 'crowded')
})

test('FIXED CP-08: nodes that do not serve logs: the payload comes from the block\'s receipts (TAP-10 §18.3), for a fresh and an old message alike', async () => {
  for (const mb of [MB, HEAD - 23_000_000]) {   // now, and months ago (0.45 s blocks) / 现在与数月之前
    const x = standardWorld()
    x.chain.setFault('http://rpc1', 'nologs'); x.chain.setFault('http://rpc2', 'nologs')
    const { index } = paid(x, { mb, tb: mb - 10 })
    assert.equal(await resultOf(x, index), 'ok', String(mb))
    assert.ok(x.st.requests.some((r) => r.calls.includes('eth_getBlockReceipts')))
  }
})

test('FIXED CP-09: a repeated transaction is counted once; only the message\'s own attachments, from a message read from the chain, are verified', async () => {
  const x = standardWorld()
  const tx = x.erc20Transfer({ payer: HP, to: AG, amount: '1000', block: MB - 10 })
  const a = { type: 'erc20', chainId: 56, token: TOKEN.toLowerCase(), amount: '1000', tx }
  const content = te(JSON.stringify({ v: 1, kind: 'message', body: '', attachments: [a, a] }))   // a second attachment, same tx
  const { index } = x.send({ from: P, wallet: HP, to: AG, block: MB, payload: encodePublic(content) })
  const { pay, msg, results } = await check(x, index)
  assert.deepEqual(results.map((r) => r.result), ['ok', 'repeat'])
  await assert.rejects(pay.verifyAttachment(msg, { ...a, amount: '2000' }), /not one of this message/)
  await assert.rejects(pay.verifyAttachment({ ...msg }, a), /readMessage result/)
})

test('FIXED CP-10: one operator that lies about a receipt or a transaction cannot make a payment ok', async () => {
  const x = standardWorld()
  const { index, tx } = paid(x, { amount: '1000', attachment: { amount: '5000' } })   // the honest answer is mismatch
  x.lie('http://rpc2', (method, params, honest) => {
    if (method === 'eth_getTransactionReceipt' && params[0] === tx) return { ...honest, logs: honest.logs.map((l) => ({ ...l, data: '0x' + (5000).toString(16).padStart(64, '0') })) }
    return honest
  })
  assert.equal(await resultOf(x, index), 'unavailable')
  const y = standardWorld()
  const r = paid(y)
  y.lie('http://rpc1', (method, params, honest) => (method === 'eth_getTransactionByHash' && params[0] === r.tx ? null : honest))
  assert.equal(await resultOf(y, r.index), 'unavailable')
})

test('FIXED CP-11: unsigned transfers: the recipient only from the chain by name or circuit, transfer only, never approve, native only from a wallet', async () => {
  const x = standardWorld()
  const pay = createPaymentKit(x.api())
  const t = await pay.transferToContainer({ name: '12.7.tape', token: TOKEN, amount: '1000' })
  assert.equal(t.to.toLowerCase(), TOKEN.toLowerCase()); assert.equal(t.value, '0x0')
  assert.equal(t.data.slice(0, 10), agent.TRANSFER_SELECTOR)
  assert.equal(decodeParams(['address', 'uint256'], hexToBytes('0x' + t.data.slice(10)))[0].toLowerCase(), AG.toLowerCase())
  assert.equal(t.recipient.name, '12.7.tape')
  assert.ok(t.summary.some((l) => l.includes('18 decimals')))
  assert.ok(t.summary.some((l) => l.includes(AG.slice(2, 10)) || l.toLowerCase().includes(AG.slice(2, 10))))
  const byCircuit = await pay.transferToContainer({ circuits: ADDR.circuits, tokenId: 12, token: TOKEN, amount: 5n })
  assert.equal(byCircuit.recipient.container.toLowerCase(), AG.toLowerCase())
  for (const k of ['to', 'container', 'recipient', 'address']) {
    await assert.rejects(pay.transferToContainer({ [k]: S, token: TOKEN, amount: '1' }), (e) => e.code === 'INVALID_ARGUMENT' && e.data?.reason === 'recipient-not-from-chain', k)
  }
  const n = await pay.nativeToContainer({ name: '12.7.tape', amount: '7' })
  assert.equal(n.to.toLowerCase(), AG.toLowerCase()); assert.equal(n.value, '0x7'); assert.equal(n.data, '0x'); assert.equal('gas' in n, false)
  const via = pay.viaContainer({ from: P, tx: t })
  assert.equal(via.to.toLowerCase(), P.toLowerCase()); assert.equal(via.value, '0x0')
  assert.equal(agent.EXECUTE_SELECTOR, toHex(keccak256(utf8ToBytes('execute(address,uint256,bytes,uint8)'))).slice(0, 10))
  assert.ok(via.summary.some((l) => l.startsWith('call: execute(')))
  assert.throws(() => pay.viaContainer({ from: P, tx: n }), (e) => e.data?.reason === 'native-via-container-unverifiable')
  const approve = '0x095ea7b3' + '00'.repeat(12) + S.slice(2) + 'ff'.repeat(32)
  assert.throws(() => pay.viaContainer({ from: P, tx: { to: TOKEN, data: approve, value: '0x0' } }), (e) => e.data?.reason === 'only-transfer')
  for (const name of Object.keys(pay)) assert.doesNotMatch(name, /approve|permit|allowance|^sign|^send(Tx|Transaction)?$|broadcast/i, name)
  x.chain.setCounterfeit(ADDR.circuits)
  await assert.rejects(createPaymentKit(x.api()).transferToContainer({ name: '12.7.tape', token: TOKEN, amount: '1' }), (e) => e.data?.reason === 'not-tapeout')
})

test('FIXED CP-12: the payment order: nothing else to that recipient before the attachment message, within 3,600 s, a transfer never reused', () => {
  let now = 1_000
  const o = paymentOrder({ clock: () => now })
  const tx = '0x' + '12'.repeat(32)
  o.recordTransfer({ recipient: AG, tx })
  assert.throws(() => o.recordTransfer({ recipient: AG, tx }), (e) => e.data?.reason === 'transfer-repeated')
  assert.throws(() => o.checkMessage({ recipient: AG, attachments: [] }), (e) => e.data?.reason === 'not-first')
  assert.equal(o.checkMessage({ recipient: S, attachments: [] }), true, 'other recipients are unaffected')
  o.confirmTransfer({ recipient: AG, tx, blockTime: 1_000 })
  assert.equal(o.deadline(AG), 1_000 + 3600)
  now = 1_000 + 3601
  assert.throws(() => o.checkMessage({ recipient: AG, attachments: [{ tx }] }), (e) => e.data?.reason === 'stale')
  now = 1_000 + 3600
  assert.equal(o.checkMessage({ recipient: AG, attachments: [{ tx }] }), true)
  o.messageSent({ recipient: AG, attachments: [{ tx }] })
  assert.equal(o.checkMessage({ recipient: AG, attachments: [] }), true)
  assert.throws(() => o.checkMessage({ recipient: AG, attachments: [{ tx: '0x' + '34'.repeat(32) }] }), (e) => e.data?.reason === 'unknown-transfer')
})

test('the token list is the client\'s own: tokenAllowed decides whether ok is shown as known', async () => {
  const x = standardWorld()
  const { index } = paid(x)
  const { results } = await check(x, index, { tokenAllowed: (t) => t.toLowerCase() === TOKEN.toLowerCase() })
  assert.equal(results[0].known, true)
  assert.throws(() => createPaymentKit(x.api(), { tokenAllowed: [TOKEN] }), (e) => e.code === 'INVALID_ARGUMENT')
})

test('an attachment for another chain is other-chain; a payment kit refuses a single-node client', async () => {
  const x = standardWorld()
  const tx = x.erc20Transfer({ payer: HP, to: AG, amount: '1', block: MB - 10 })
  const { index } = x.send({ from: P, wallet: HP, to: AG, block: MB, content: encodeContent({ body: '', attachments: [{ type: 'erc20', chainId: 8453, token: TOKEN, amount: '1', tx }] }) })
  assert.equal(await resultOf(x, index), 'other-chain')
  const solo = createPaymentKit(x.api({ rpcUrls: ['http://rpc1'], allowSingleNode: true }))
  await assert.rejects(solo.readMessage({ recipient: AG, inboxIndex: 0 }), /two operators/)
})

// ---- review 2026-10-04 (Fable, r17-core d493bac): findings written as tests / 审查发现写成测试 ----

test('FIXED F-1: no transfer to a container nobody holds: the hub derives an address for any #ID, so ownerOf must exist (no-such-token)', async () => {
  const x = standardWorld()
  const pay = createPaymentKit(x.api())
  // the helper's hub derives an address for every #ID, as the real hub does / 辅助假链的 hub 对任何 #ID 都推导地址
  assert.equal((await pay.recipientOf({ circuits: ADDR.circuits, tokenId: 1200 }).catch((e) => e)).data?.reason, 'no-such-token')
  for (const target of [{ name: '1200.7.tape' }, { name: '999.7.tape' }, { circuits: ADDR.circuits, tokenId: 424242 }]) {
    await assert.rejects(pay.transferToContainer({ ...target, token: TOKEN, amount: '1' }), (e) => e.data?.reason === 'no-such-token', JSON.stringify(target))
    await assert.rejects(pay.nativeToContainer({ ...target, amount: '1' }), (e) => e.data?.reason === 'no-such-token', JSON.stringify(target))
  }
  const ok = await pay.transferToContainer({ name: '12.7.tape', token: TOKEN, amount: '1' })
  assert.equal(ok.recipient.holder, addrOf(KEYS.agentHolder))
  assert.ok(ok.summary.some((l) => l.includes('held by ' + addrOf(KEYS.agentHolder))))
})

test('FIXED F-2: viaContainer wraps only the unedited transfer transferToContainer built; its recipient is the container the chain named, and the summary says so', async () => {
  const x = standardWorld()
  const pay = createPaymentKit(x.api())
  const t = await pay.transferToContainer({ name: '12.7.tape', token: TOKEN, amount: '5' })
  const via = pay.viaContainer({ from: P, tx: t })
  assert.ok(via.summary.some((l) => l.startsWith('recipient container: ') && l.toLowerCase().includes(AG.slice(2, 12).toLowerCase())))
  assert.equal(via.recipient.container, t.recipient.container)
  const attacker = '0x' + 'ba'.repeat(20)
  const handMade = { to: TOKEN, value: '0x0', data: agent.TRANSFER_SELECTOR + '00'.repeat(12) + attacker.slice(2) + (5).toString(16).padStart(64, '0'), recipient: t.recipient }
  assert.throws(() => pay.viaContainer({ from: P, tx: handMade }), (e) => e.data?.reason === 'recipient-not-from-chain')
  assert.throws(() => pay.viaContainer({ from: P, tx: { ...t, data: handMade.data } }), (e) => e.data?.reason === 'recipient-not-from-chain')
  assert.throws(() => pay.viaContainer({ from: P, tx: { ...t } }), (e) => e.data?.reason === 'recipient-not-from-chain', 'a copy is not the object built')
  const t2 = await pay.transferToContainer({ name: '12.7.tape', token: TOKEN, amount: '5' })
  t2.data = handMade.data   // edited in place / 原地改写
  assert.throws(() => pay.viaContainer({ from: P, tx: t2 }), (e) => e.data?.reason === 'recipient-not-from-chain')
  const t3 = await pay.transferToContainer({ name: '12.7.tape', token: TOKEN, amount: '5' })
  t3.recipient = { ...t3.recipient, container: attacker }
  assert.throws(() => pay.viaContainer({ from: P, tx: t3 }), (e) => e.data?.reason === 'recipient-not-from-chain')
})

test('FIXED F-8b: the payment order can drop a reverted or cancelled transfer and follow a sped-up one (TAP-10 §20 step 4)', () => {
  const o = paymentOrder({ clock: () => 1 })
  const tx = '0x' + '21'.repeat(32), by = '0x' + '22'.repeat(32)
  o.recordTransfer({ recipient: AG, tx })
  assert.throws(() => o.dropTransfer({ recipient: AG, tx, reason: 'maybe' }), (e) => e.code === 'INVALID_ARGUMENT')
  o.dropTransfer({ recipient: AG, tx, reason: 'reverted' })
  assert.equal(o.checkMessage({ recipient: AG, attachments: [] }), true, 'a reverted transfer no longer blocks the recipient')
  assert.throws(() => o.recordTransfer({ recipient: AG, tx }), (e) => e.data?.reason === 'transfer-repeated', 'never recorded again')
  const tx2 = '0x' + '23'.repeat(32)
  o.recordTransfer({ recipient: AG, tx: tx2 })
  o.replaceTransfer({ recipient: AG, tx: tx2, by })
  assert.throws(() => o.checkMessage({ recipient: AG, attachments: [{ tx: tx2 }] }), (e) => e.data?.reason === 'not-first' || e.data?.reason === 'unknown-transfer')
  assert.equal(o.checkMessage({ recipient: AG, attachments: [{ tx: by }] }), true)
})

test('FIXED F-10 / A1: an indirect earlier message is skipped (its container is still compared): nobody can turn later payments into unavailable, a Safe-held correspondent\'s greeting included', async () => {
  const pay = (x, a) => ({ type: 'erc20', chainId: 56, token: TOKEN, amount: '1000', tx: a })
  {
    // a stranger's container, relayed through a contract, writes between the transfer and the payment message
    // (r17 review t7: ok on d493bac, unavailable on 51d9ae8, ok again here) / 陌生人经合约中继的一条来信
    const x = standardWorld()
    const tx = x.erc20Transfer({ payer: HP, to: AG, amount: '1000', block: MB - 10 })
    x.send({ from: '0x' + 'c7'.repeat(20), wallet: addrOf(KEYS.stranger), to: AG, block: MB - 5, txTo: '0x' + 'de'.repeat(20) })
    const { index } = x.send({ from: P, wallet: HP, to: AG, block: MB, content: encodeContent({ body: '', attachments: [pay(x, tx)] }) })
    assert.equal(await resultOf(x, index), 'ok')
  }
  {
    // the ordinary case: provider #13 is held by a Safe, says hello through it (EOA -> Safe -> hub: indirect), then the
    // principal pays as usual / 常规部署：Safe 持有的通信方经 Safe 发一句问候，随后委托方正常付款
    const x = standardWorld()
    const safe = '0x' + '5a'.repeat(20)
    x.chain.setOwner(13, safe); x.chain.setCode(safe)
    const tx = x.erc20Transfer({ payer: HP, to: AG, amount: '1000', block: MB - 10 })
    x.send({ from: S, wallet: addrOf(KEYS.stranger), to: AG, block: MB - 5, txTo: safe })
    const { index } = x.send({ from: P, wallet: HP, to: AG, block: MB, content: encodeContent({ body: '', attachments: [pay(x, tx)] }) })
    const { pay: kit, results } = await check(x, index)
    assert.equal(results[0].result, 'ok')
    assert.equal((await kit.sendingWallet({ recipient: AG, inboxIndex: index - 1 })).indirect, true, 'the greeting is indirect')
  }
  {
    // an indirect earlier message from the payer's own container is still not-first (the container rule)
    const x = standardWorld()
    const tx = x.erc20Transfer({ payer: HP, to: AG, amount: '1000', block: MB - 10 })
    x.send({ from: P, wallet: HP, to: AG, block: MB - 5, txTo: '0x' + 'de'.repeat(20) })
    const { index } = x.send({ from: P, wallet: HP, to: AG, block: MB, content: encodeContent({ body: '', attachments: [pay(x, tx)] }) })
    assert.equal(await resultOf(x, index), 'not-first')
  }
})

// ---- second review (Fable, r17-core 51d9ae8) / 第二轮审查 ----

test('FIXED B3: the viaContainer summary is written from what was built: an edited name or holder on the recipient never reaches it', async () => {
  const x = standardWorld()
  const pay = createPaymentKit(x.api())
  const t = await pay.transferToContainer({ name: '12.7.tape', token: TOKEN, amount: '5' })
  t.recipient.name = '1.7.tape'; t.recipient.holder = '0x' + 'ba'.repeat(20)
  const via = pay.viaContainer({ from: P, tx: t })
  const line = via.summary.find((l) => l.startsWith('recipient container: '))
  assert.ok(line.includes('(12.7.tape)') && line.includes(addrOf(KEYS.agentHolder)), line)
  assert.equal(via.recipient.name, '12.7.tape')
})

test('FIXED B4: a #ID is a decimal string without leading zeros, a safe integer or a bigint, 1 or more; anything else is INVALID_ARGUMENT', async () => {
  const x = standardWorld()
  const pay = createPaymentKit(x.api())
  for (const tokenId of ['1e3', 1.5, {}, -1, 0, '0x0c', '012', 2n ** 256n]) {
    await assert.rejects(pay.recipientOf({ circuits: ADDR.circuits, tokenId }), (e) => e.code === 'INVALID_ARGUMENT', String(tokenId))
  }
  assert.equal((await pay.recipientOf({ circuits: ADDR.circuits, tokenId: '12' })).container.toLowerCase(), AG.toLowerCase())
  assert.equal((await pay.recipientOf({ circuits: ADDR.circuits, tokenId: 12n })).container.toLowerCase(), AG.toLowerCase())
})

test('FIXED B5: the test chain knows the hub derivation per (circuits, #ID) and the factory only its own circuits: a circuits/#ID mix-up is refused', async () => {
  const x = standardWorld()
  const pay = createPaymentKit(x.api())
  for (const circuits of [ADDR.hub, '0x' + '51'.repeat(20)]) {
    await assert.rejects(pay.recipientOf({ circuits, tokenId: 12 }), (e) => e.data?.reason === 'not-tapeout', circuits)
  }
})

test('describeTx gives the amount in whole tokens too, by decimal arithmetic', async () => {
  const x = standardWorld()
  const t = await createPaymentKit(x.api()).transferToContainer({ name: '12.7.tape', token: TOKEN, amount: '1500000000000000001' })
  assert.ok(t.summary.some((l) => l.includes('1500000000000000001 (smallest unit, 18 decimals) = 1.500000000000000001 tokens')))
})

// ---- third review / 第三轮审查 ----

test('FIXED C1: whole-token amounts for 0, 1, 2, 6, 8 and 18 decimals and for 2^256 - 1; without decimals the summary says it could not read them', async () => {
  const { formatUnits } = await import('../src/manifest.js')
  const max = (2n ** 256n - 1n).toString()
  const cases = [
    [5n, 0, '5'], [10n, 0, '10'], [0n, 0, '0'], [max, 0, max],
    [15n, 1, '1.5'], [10n, 1, '1'], [0n, 1, '0'],
    [105n, 2, '1.05'], [5n, 2, '0.05'],
    [1500000n, 6, '1.5'], [1n, 6, '0.000001'],
    [12345678n, 8, '0.12345678'], [100000000n, 8, '1'],
    [10n ** 18n, 18, '1'], [1n, 18, '0.000000000000000001'],
    [max, 18, '115792089237316195423570985008687907853269984665640564039457.584007913129639935'],
  ]
  for (const [wei, d, want] of cases) assert.equal(formatUnits(wei, d), want, `${wei} / ${d}`)
  for (const [d, n] of [[0, '10'], [2, '105']]) {
    const x = standardWorld(); x.decimals.set(TOKEN.toLowerCase(), d)
    const t = await createPaymentKit(x.api()).transferToContainer({ name: '12.7.tape', token: TOKEN, amount: n })
    assert.ok(t.summary.some((l) => l.includes(`${n} (smallest unit, ${d} decimals) = ${formatUnits(BigInt(n), d)} tokens`)), t.summary.join('\n'))
  }
  const y = standardWorld(); y.decimals.delete(TOKEN.toLowerCase())   // decimals() reverts / 读不到
  const t = await createPaymentKit(y.api()).transferToContainer({ name: '12.7.tape', token: TOKEN, amount: '10' })
  assert.ok(t.summary.some((l) => l.includes('10 (smallest unit; decimals() could not be read)')))
})

test('FIXED C2: decimals() above 255 (256, 2^31, 2^64, 2^255) is no valid answer: the summary says so (not "could not be read"), nothing throws', async () => {
  for (const d of [256n, 2n ** 31n, 2n ** 64n, 2n ** 255n]) {
    const x = standardWorld()
    x.lie('http://rpc1', (method, params, honest) => (method === 'eth_call' && params[0].data === '0x313ce567' ? '0x' + d.toString(16).padStart(64, '0') : honest))
    x.lie('http://rpc2', (method, params, honest) => (method === 'eth_call' && params[0].data === '0x313ce567' ? '0x' + d.toString(16).padStart(64, '0') : honest))
    const t = await createPaymentKit(x.api()).transferToContainer({ name: '12.7.tape', token: TOKEN, amount: '10' })
    assert.ok(t.summary.some((l) => l.includes('decimals() gave no valid answer')), String(d))
    assert.ok(!t.summary.some((l) => l.includes('could not be read')), String(d))
  }
})

test('FIXED C5: formatUnits refuses decimals outside 0..255 or not whole (closed off; no caller reaches it)', async () => {
  const { formatUnits } = await import('../src/manifest.js')
  for (const d of [-1, 256, 1.5, NaN, 'x', 2 ** 31]) assert.throws(() => formatUnits(1n, d), (e) => e.code === 'INVALID_ARGUMENT', String(d))
  assert.equal(formatUnits(15n, '1'), '1.5')
  assert.equal(formatUnits(12345678n), '0.12345678')
})
