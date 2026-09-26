// Architecture review, relay core item B2. The `FIXED <id>` test replays the original scenario and asserts the
// CORRECT behaviour. / 架构审查中继核心 B2：重放原场景并断言正确行为。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createProvider } from '../../server/src/index.js'
import { privateKeyToAddress } from '../../sdk/src/sig.js'
import { ADDR } from '../../sdk/test/helpers/fake-chain.mjs'
import { createRelayCore, relayMethods, relayManifestMethods } from './relay-core.mjs'

const b64 = (type, n = 40, fill = 7) => Buffer.from(Uint8Array.of(type, ...new Array(n).fill(fill))).toString('base64')
const ROOM = 'ab'.repeat(32)
const type = (f) => Buffer.from(f, 'base64')[0]
const drain = async (core, room) => {   // every frame, across as many polls as the byte budget needs / 按字节预算分页读完
  const all = []; let after = -1, epoch
  for (let k = 0; k < 100; k++) {
    const out = await core.recv(room, after, 0, epoch)
    if (!out.frames.length) break
    all.push(...out.frames); after = out.next; epoch = out.epoch
  }
  return all
}

// ------------------------------------------------------------------------------------------------ B2 ----
test('FIXED B2: 0x03 invites and 0x04 epoch messages survive a flood of 0x02 / 0x05 frames, still in posting order; 0x03 / 0x04 posts are capped per source per room', async () => {
  let t = 1_000_000
  const core = createRelayCore({ maxRecvBytes: 1_000, now: () => t })          // small budget: recv pages across both rings / 小预算：跨两个环分页
  const invite = b64(0x03, 60, 1), epochMsg = b64(0x04, 120, 2)
  core.send(ROOM, b64(0x02, 10, 9), { source: 'ip:9' })                         // one frame before the invite / 邀请之前的一帧
  assert.equal(core.send(ROOM, invite, { source: 'ip:1' }).i, 1)
  assert.equal(core.send(ROOM, epochMsg, { source: 'ip:2' }).i, 2)
  // The original attack: 300 frames, for free on a free relay, used to push both out of the 256-frame room.
  // 原攻击：300 帧（免费中继上不花钱），曾把两者挤出 256 帧的房间。
  for (let k = 0; k < 300; k++) core.send(ROOM, b64(k % 2 ? 0x05 : 0x02, 30, k & 0xff), { source: 'ip:6' })
  const got = await drain(core, ROOM)
  const idx = got.map((f) => f.i)
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b), 'posting order across both rings')
  assert.equal(new Set(idx).size, idx.length, 'no frame twice')
  assert.deepEqual(got.filter((f) => type(f.frame) === 0x03 || type(f.frame) === 0x04).map((f) => [f.i, f.frame]), [[1, invite], [2, epochMsg]], 'the invite and the epoch message are still there')
  assert.equal(got.filter((f) => type(f.frame) === 0x02 || type(f.frame) === 0x05).length, 256, 'frames keep their own 256 bound')
  assert.equal(got[got.length - 1].i, 302)
  assert.equal(core.dump().length, 258, 'dump() sees both rings')
  // A cursor in the middle resumes correctly across the merge / 从中间的游标继续，合并后依然正确
  const mid = got[10].i
  assert.deepEqual((await core.recv(ROOM, mid, 0)).frames[0].i, got[11].i)

  // Per source per room: 8 per 10-minute window, then refused (BAD_REQUEST, like the handshake cap); others unaffected.
  // 每个来源每个房间：每 10 分钟 8 条，之后拒绝；其他来源不受影响。
  const R2 = 'cd'.repeat(32)
  for (let k = 0; k < 8; k++) core.send(R2, b64(0x03, 60, k), { source: 'ip:1' })
  assert.throws(() => core.send(R2, b64(0x03, 60, 99), { source: 'ip:1' }), (e) => e.code === 'BAD_REQUEST' && /too many invites/.test(e.message))
  assert.throws(() => core.send(R2, b64(0x04, 120, 99), { source: 'ip:1' }), (e) => e.code === 'BAD_REQUEST', '0x04 shares the budget')
  core.send(R2, b64(0x02, 10, 1), { source: 'ip:1' })                           // frames are not capped here / 帧不受此限
  core.send(R2, b64(0x03, 60, 1), { source: 'ip:3' })
  t += 600_000
  core.send(R2, b64(0x03, 60, 1), { source: 'ip:1' })                           // a new window / 新窗口
  // An unidentified caller counts as one source for the whole room / 无法识别的调用方对整个房间算作同一个来源
  const R3 = 'ef'.repeat(32)
  for (let k = 0; k < 8; k++) core.send(R3, b64(0x03, 60, k))
  assert.throws(() => core.send(R3, b64(0x03, 60, 9)), (e) => e.code === 'BAD_REQUEST')

  // The protected ring is bounded too: 64, oldest first, and only 0x03 / 0x04 can push them out.
  // 受保护环同样有界：64 条，先丢最旧的，只有 0x03 / 0x04 能挤掉它们。
  const R4 = '12'.repeat(32)
  for (let s = 0; s < 9; s++) for (let k = 0; k < 8; k++) core.send(R4, b64(0x03, 60, k), { source: `ip:${s}` })
  const kept = (await drain(core, R4)).map((f) => f.i)
  assert.equal(kept.length, 64); assert.equal(kept[0], 8, 'the 8 oldest were dropped')
})

test('FIXED B2: the relay methods key the 0x03 budget on the proven consumer, else the client IP the runtime vouches for', async () => {
  const core = createRelayCore()
  const SIGNER_KEY = '0x' + '22'.repeat(32)
  const manifest = {
    tapeapi: '0.1', name: 'relay.tape', circuits: ADDR.circuits, tokenId: '4246', container: ADDR.container, signer: privateKeyToAddress(SIGNER_KEY),
    delegation: null, dev: true, endpoints: { live: ['http://127.0.0.1:1/tapeapi/v1'], async: false }, methods: relayManifestMethods({ priceBEM: '0' }),
  }
  const p = createProvider({ manifest, signerKey: SIGNER_KEY, allowHttp: true, log: () => {}, methods: relayMethods(core) })
  let n = 0
  const post = (ip) => p.invoke({ id: `r${n++}`, method: 'relaySend', params: { room: ROOM, frame: b64(0x03, 60, n & 0xff) } }, { ip })
  for (let k = 0; k < 8; k++) assert.equal((await post('10.0.0.1')).env.ok, true)
  const refused = (await post('10.0.0.1')).env
  assert.equal(refused.ok, false); assert.equal(refused.error.code, 'BAD_REQUEST'); assert.match(refused.error.message, /too many invites/)
  assert.equal((await post('10.0.0.2')).env.ok, true, 'another address still reaches the inbox')
  // A paid call counts against the consumer its voucher proved, not its IP / 付费调用按凭证证明的消费者计，而不是 IP
  const m = relayMethods(core)
  const R = '34'.repeat(32)
  for (let k = 0; k < 8; k++) await m.relaySend({ room: R, frame: b64(0x03, 60, k) }, { consumer: '0x' + 'aa'.repeat(20), clientIp: `10.1.0.${k}` })
  await assert.rejects(m.relaySend({ room: R, frame: b64(0x03, 60, 9) }, { consumer: '0x' + 'AA'.repeat(20), clientIp: '10.9.9.9' }), (e) => e.code === 'BAD_REQUEST')
})

test('FIXED R3-epoch-null: a client echoing the null epoch it saw for a room that did not exist yet is served from the start', async () => {
  // TAP-26 §3.5: a client MUST send the epoch it last saw; for a missing room that is null. Found by the relay
  // conformance suite, 2026-09-25. / 客户端必须带上上次看到的纪元；房间不存在时就是 null。由中继一致性套件发现。
  const core = createRelayCore()
  const room = 'ab'.repeat(32)
  const first = await core.recv(room, -1, 0)
  assert.equal(first.epoch, null)
  await core.send(room, 'AgAA')
  const again = await core.recv(room, 5, 0, null)            // a stale cursor with the null epoch / 旧游标加 null 纪元
  assert.equal(again.frames.length, 1, 'read from the start, as for any other epoch that differs')
  assert.match(again.epoch, /^[0-9a-f]{1,32}$/)
  await assert.rejects(core.recv(room, -1, 0, 'NOT-HEX'), /epoch must be/)
})
