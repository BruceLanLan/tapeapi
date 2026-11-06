// Scenario (c), end to end on the SDK's fake chain: containers A and B in a private channel (TAPI-26 v2 labels, the default since 2.0) over an
// in-process relay; B answers a request with a receipt it signs inside the channel (EXPERIMENTAL). Nothing leaves this process;
// every key is a fixture. One world per test.
// 场景 (c) 的端到端测试（SDK 假链）：容器 A 与 B 在私密通道（TAPI-26 v2 标签，2.0 起的默认）里经进程内中继交换消息；B 在通道里回签名回执。
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { channel, mcp, sig, TapeAPIError } from '@tapeapi/sdk'
import { createInteropWorld, restoreTime, P, B } from './world.mjs'
import { openChannel, callOverChannel, sendText, answerCall, relayHoldings } from './private-exchange.mjs'
import { verifyReceipt } from './receipts.mjs'

afterEach(restoreTime)

test('c: two containers, a v2 channel over the relay, a request in and a signed receipt back; the relay holds ciphertext only', async () => {
  const w = await createInteropWorld()
  const lines = []
  const chan = await openChannel({ world: w, print: (l) => lines.push(l) })
  assert.equal(chan.a.session.labels, 'v2')
  assert.equal(chan.b.session.labels, 'v2')
  assert.equal(chan.a.session.cid, chan.b.session.cid)
  assert.equal(chan.a.session.transcript, chan.b.session.transcript)
  assert.equal(chan.b.session.peer.container.toLowerCase(), P.toLowerCase())
  assert.equal(chan.a.session.peer.container.toLowerCase(), B.toLowerCase())

  const r = await callOverChannel({ world: w, chan, params: { sku: 'widget-7', qty: 12 }, id: 'req-1' })
  assert.equal(r.check.ok, true, r.check.problems.join('; '))
  assert.equal(r.check.container.toLowerCase(), B.toLowerCase())
  assert.equal(r.check.signer.toLowerCase(), w.b.signer.toLowerCase(), 'signed by the signer B\'s manifest publishes')
  assert.deepEqual(r.envelope.result, { sku: 'widget-7', qty: 12, unitPriceCents: 250, totalCents: 3000, reference: 'Q-1' })
  assert.deepEqual(w.b.quotes, [{ sku: 'widget-7', qty: 12 }], 'B\'s own method ran once')

  // the receipt works without the channel: a third party who is shown it (in full, or hash-only) checks it against the chain
  const third = w.apiFor()
  assert.equal((await verifyReceipt(third, r.receipt, { container: B, id: 'req-1', method: 'quote', params: { sku: 'widget-7', qty: 12 } })).ok, true)
  assert.equal(r.hashOnly.v, 2)
  assert.equal((await verifyReceipt(third, r.hashOnly, { container: B, id: 'req-1', method: 'quote', params: { sku: 'widget-7', qty: 12 }, result: r.envelope.result })).ok, true)
  assert.equal(JSON.stringify(r.hashOnly).includes('widget'), false, 'the hash-only form shows neither the request nor the answer')
  // and it says nothing about the channel it travelled in (TAPI-21 covers container, id, method, params, body and time)
  assert.equal(JSON.stringify(r.receipt).includes(chan.cid), false)

  // the relay stored five wire messages (sealed invite, accept, ready, request, answer): none shows the request or the answer
  const held = relayHoldings(w)
  assert.equal(held.length, 5)
  for (const leak of ['widget', 'quote', 'sku', 'totalCents', 'Q-1', 'req-1', 'tape.channel/invite']) assert.ok(held.every((t) => !t.includes(leak)), `no "${leak}" on the relay`)
  // v2 rooms are not the v1 rooms: a v1 reader of B's inbox finds nothing. Both versions are named: since 2.0 the default
  // (no `labels`) is v2, so comparing against the default would compare v2 with itself.
  // v2 房间不是 v1 房间。两边都显式写版本：2.0 起不传 labels 即 v2。
  assert.notEqual(channel.inboxRoom(B, 56, { labels: 'v2' }), channel.inboxRoom(B, 56, { labels: 'v1' }))
  assert.equal(channel.inboxRoom(B, 56), channel.inboxRoom(B, 56, { labels: 'v2' }), 'the 2.0 default is v2')
  assert.equal(lines.length, 4, 'the handshake is four narrated steps')
  w.close()
})

test('c: both ways: B can also send first, and frames keep their order; a replayed or tampered frame is refused', async () => {
  const w = await createInteropWorld()
  const chan = await openChannel({ world: w })
  assert.deepEqual(await sendText(chan.b, chan.a, 'hello from B'), ['hello from B'])
  assert.deepEqual(await sendText(chan.a, chan.b, 'hello from A'), ['hello from A'])
  // a frame the channel already delivered is not delivered again
  const f = chan.a.session.seal('once')
  assert.equal(chan.b.session.open(f, { text: true }).data, 'once')
  assert.throws(() => chan.b.session.open(f), (e) => e instanceof TapeAPIError && e.code === 'CHANNEL_INVALID' && /replayed, duplicated or reordered/.test(e.message))
  // a frame with one bit changed does not authenticate
  const g = chan.a.session.seal('twice')
  const bad = Uint8Array.from(g); bad[bad.length - 1] ^= 1
  assert.throws(() => chan.b.session.open(bad), (e) => e.code === 'CHANNEL_INVALID' && /failed authentication/.test(e.message))
  // a frame of this channel is not a frame of another channel with the same parties
  const other = await openChannel({ world: w })   // a second channel between the same two containers
  assert.notEqual(other.cid, chan.cid)
  assert.throws(() => other.b.session.open(g), (e) => e.code === 'CHANNEL_INVALID')
  w.close()
})

test('c: labels fail closed: A on v2 and B on v1 (or the other way round) never get a channel, and the SDK says which labels', async () => {
  for (const [labels, bLabels] of [['v2', 'v1'], ['v1', 'v2']]) {
    const w = await createInteropWorld()
    await assert.rejects(openChannel({ world: w, labels, bLabels }), (e) => e instanceof TapeAPIError && e.code === 'CHANNEL_INVALID' && e.data?.labels === bLabels && e.data?.peerLabels === labels)
    w.close()
  }
})

test('c: the receipt: every way an answer can be made not to verify is refused (a stranger\'s key, another request, another body, another id)', async () => {
  const w = await createInteropWorld()
  const chan = await openChannel({ world: w })
  const r = await callOverChannel({ world: w, chan, params: { sku: 'widget-7', qty: 12 }, id: 'req-1' })
  const api = chan.a.api
  const want = { container: B, id: 'req-1', method: 'quote', params: { sku: 'widget-7', qty: 12 } }
  assert.equal((await verifyReceipt(api, r.receipt, want)).ok, true)

  // 1. an envelope for B signed by a key B's manifest does not publish (anyone can write B's address into an envelope)
  const forged = { ...r.envelope, sig: sig.signResponse({ container: B, id: 'req-1', method: 'quote', params: want.params, ok: true, body: r.envelope.result, ts: r.envelope.ts }, '0x' + '99'.repeat(32)) }
  const f = await verifyReceipt(api, mcp.receiptOf({ envelope: forged, method: 'quote', params: want.params, circuits: r.receipt.service.circuits, tokenId: r.receipt.service.tokenId }), want)
  assert.equal(f.ok, false); assert.match(f.problems.join(' '), /signed by .* the container publishes/)
  // 2. B's real answer to ANOTHER request, replayed as the answer to this one
  const second = await callOverChannel({ world: w, chan, params: { sku: 'widget-7', qty: 1 }, id: 'req-2' })
  const swapped = await verifyReceipt(api, second.receipt, want)
  assert.equal(swapped.ok, false); assert.match(swapped.problems.join(' '), /answers request id/)
  const sameId = await verifyReceipt(api, { ...second.receipt, id: 'req-1' }, want)
  assert.equal(sameId.ok, false, 'relabelling the id breaks the signature')
  // 3. the answer's body edited after it was signed
  const edited = mcp.receiptOf({ envelope: { ...r.envelope, result: { ...r.envelope.result, totalCents: 1 } }, method: 'quote', params: want.params, circuits: r.receipt.service.circuits, tokenId: r.receipt.service.tokenId })
  const e = await verifyReceipt(api, edited, want)
  assert.equal(e.ok, false)
  // 4. it is the receipt of the call A made, not of any call: the params A sent are part of what is checked
  const p = await verifyReceipt(api, r.receipt, { ...want, params: { sku: 'widget-7', qty: 13 } })
  assert.equal(p.ok, false); assert.match(p.problems.join(' '), /not the request that was made/)
  w.close()
})

test('c: B\'s side treats the frame as data: a method it does not serve is a signed METHOD_NOT_FOUND; a malformed call is refused unsigned', async () => {
  const w = await createInteropWorld()
  const chan = await openChannel({ world: w })
  // a method B's provider does not serve: B's provider signs the refusal, and that signed refusal verifies too
  const r = await callOverChannel({ world: w, chan, method: 'task_offer', params: { message: { kind: 'tape.agent/offer' } }, id: 'req-x' })
  assert.equal(r.envelope.ok, false)
  assert.equal(r.envelope.error.code, 'METHOD_NOT_FOUND')
  assert.equal(r.check.ok, true, 'a signed refusal is also an answer B signed')
  assert.deepEqual(w.b.quotes, [], 'B ran nothing')
  // a method name that is not a method name never reaches the provider as a path
  for (const text of ['{"t":"call","id":"x","method":"../health","params":{}}', '{"t":"call","id":"","method":"quote"}', '{"t":"nope"}', 'not json']) {
    await assert.rejects(answerCall({ b: w.b, text }), /B: /)
  }
  // params that are not an object are not passed on as such
  const q = await answerCall({ b: w.b, text: '{"t":"call","id":"y","method":"quote","params":[1]}' })
  assert.equal(q.envelope.ok, true)
  assert.deepEqual(w.b.quotes, [{ sku: '', qty: 1 }])
  w.close()
})

test('c: identity: the keys must be authorised by the CURRENT holder: a sold circuit\'s channel record is refused, and nothing is posted', async () => {
  const w = await createInteropWorld()
  w.x.chain.setOwner(16, '0x' + '99'.repeat(20))             // B's circuit changed hands since the record was signed
  await assert.rejects(openChannel({ world: w }), (e) => e instanceof TapeAPIError && e.code === 'CHANNEL_INVALID' && /current holder/.test(e.message))
  assert.equal(relayHoldings(w).length, 0, 'A posted no invite to a container whose keys it could not verify')
  w.close()
})

test('c: a relay that delivers frames out of order: the later one opens (a gap is reported), the earlier one is then refused', async () => {
  const w = await createInteropWorld()
  const chan = await openChannel({ world: w })
  const f1 = chan.a.session.seal('first'), f2 = chan.a.session.seal('second')
  const second = chan.b.session.open(f2, { text: true })
  assert.deepEqual([second.data, second.skipped], ['second', 1])
  assert.throws(() => chan.b.session.open(f1), (e) => e.code === 'CHANNEL_INVALID' && /replayed, duplicated or reordered/.test(e.message))
  w.close()
})
