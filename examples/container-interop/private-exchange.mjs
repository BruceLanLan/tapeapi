// Scenario (c): two containers talk in a private channel, and B answers a request with a signed receipt (EXPERIMENTAL).
//
//   A = the principal container #11, B = the service container #16. Each publishes a channel record its HOLDER authorised
//   (TAPI-26 §3.1); the relay (#15) is an ordinary TapeAPI service that stores ciphertext per room.
//
//   1. each side reads the other's channel keys from the chain (`api.chain.channelKeys`: current holder only);
//   2. A seals an invite to B's inbox room and posts it; B opens it, accepts; A completes; B confirms (three Diffie-Hellmans:
//      mutual authentication, forward secrecy);
//   3. A seals a request into the channel; B answers INSIDE the channel with the TAPI-21 envelope its own provider signs for it
//      (exactly what its HTTPS endpoint would sign: B's manifest signer, the request's id, method and params, the body, the time);
//   4. A checks the envelope against B's published signer and keeps it as a receipt, in full or hash-only.
//
// Labels: `labels: 'v2'` is the TAPI-26 v2 version (labels `tape-channel/…`, Stable (v2) and the SDK's default since 2.0; it is
// passed explicitly so the example reads the same on 1.8.1). Both sides pass the same value; the SDK never switches by itself, and
// a mismatch fails closed.
// What this is not: the request/answer framing below (`{ t: 'call' | 'answer', … }`) is this example's own, not a specification;
// the receipt is not bound to the channel (TAPI-21 covers container, id, method, params, body and time, not the channel id), and
// B never sees a mandate or a grant here: the receipt says "B answered this", not "B checked that A was entitled to ask".
// 场景 (c)：两个容器在私密通道里交换消息，B 在通道里回一张签名回执（实验性）。A = 委托方容器 #11，B = 服务容器 #16，各自发布由**持有人**
// 授权的通道记录；中继（#15）只是按房间存密文的普通 TapeAPI 服务。握手之后 A 把请求封进通道，B 在通道**内部**回答：就是它自己的
// provider 为这个请求签的 TAPI-21 信封（与它的 HTTPS 端点会签的完全一样）。A 用 B 当前发布的 signer 核验，并留作回执（完整或只含哈希）。
// 它不是什么：下面的请求/回答成帧是本示例自己的，不是规范；回执没有绑定通道（TAPI-21 覆盖容器、id、方法、参数、回答体与时间，不含通道号）；
// B 在这里看不到授权书或授权：回执说"B 回答了这个"，不说"B 核对过 A 有权问"。
import { channel, mcp } from '@tapeapi/sdk'
import { plainText } from '@tapeapi/sdk/agent'
import { P, B, RELAY, RELAY_URL, B_ORIGIN } from './world.mjs'
import { verifyReceipt } from './receipts.mjs'

const METHOD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const ID_RE = /^[\x21-\x7e]{1,128}$/

/** a relay link: `send` posts a wire message to `outbound`, `poll` reads `inbound` (no long poll: the relay is in this process) */
function link(api, service, inbound, outbound) { return channel.relayTransport({ api, service, inbound, outbound, waitMs: 0 }) }

/**
 * Establish the channel. `labels` is A's version and `bLabels` B's (a test of the mismatch passes two different values).
 * Returns { a: { session, api }, b: { session, api }, cid, steps } or throws the SDK's CHANNEL_INVALID.
 */
export async function openChannel({ world, labels = 'v2', bLabels = labels, print = () => {} } = {}) {
  const steps = []
  const say = (m) => { steps.push(m); print(m) }
  const now = world.clock()
  const apiA = world.principalApi, apiB = world.apiFor()
  const [relayA, relayB] = await Promise.all([apiA.resolve(RELAY), apiB.resolve(RELAY)])
  const idA = world.identities.a.id, idB = world.identities.b.id
  const selfA = { container: P, chainId: 56, staticSecret: idA.x25519.secretKey }
  const selfB = { container: B, chainId: 56, staticSecret: idB.x25519.secretKey }

  // 1. keys from the chain: authorised by the CURRENT holder, or refused (a sold circuit's old keys stop working)
  const kB = await apiA.chain.channelKeys(B)
  say(`1. A read B's channel keys from the chain (holder ${kB.holder}); x25519 ${kB.x25519.slice(0, 10)}…`)

  // 2. A -> B inbox: a sealed invite (only B's key opens it; nothing in it names A to the relay)
  const { invite, pending } = channel.createInvite({ self: selfA, peer: kB, relays: [{ url: RELAY_URL, container: RELAY }], now, labels })
  const sealed = channel.sealInvite(invite, { to: { container: B, chainId: 56, staticPublic: kB.x25519 }, labels })
  const inboxB = channel.inboxRoom(B, 56, { labels })
  const rooms = channel.roomsFor(pending.cid, { labels })
  await link(apiA, relayA, rooms.toInitiator, inboxB).send(sealed)
  say(`2. A posted a sealed invite (${sealed.length} bytes) to B's inbox room ${inboxB.slice(0, 10)}…`)

  // 3. B reads its inbox, opens the invite with ITS version's labels, looks A up on the chain and accepts
  // (the inbox room keeps every invite posted to it: this example takes the latest, a real container opens each one it can)
  const got = await link(apiB, relayB, inboxB, inboxB).poll(0)
  const invites = got.map((g) => channel.decodeWire(g).sealedInvite).filter(Boolean)
  if (!invites.length) throw new Error('B found no invite in its inbox room')
  const wire = invites.at(-1)
  const opened = channel.openInvite(wire, { self: selfB, labels: bLabels })
  const kA = await apiB.chain.channelKeys(opened.from.container)
  const { accept, session: bSession } = channel.acceptInvite({ self: selfB, peer: kA, invite: opened, now, labels: bLabels, seen: new Set() })
  const bRooms = channel.roomsFor(opened.cid, { labels: bLabels })
  await link(apiB, relayB, bRooms.toResponder, bRooms.toInitiator).send(channel.encodeWire(accept))
  say(`3. B opened the invite, read A's keys from the chain (holder ${kA.holder}), and posted its accept`)

  // 4. A completes (checks B's confirmation tag) and answers `ready`; B confirms and may now read A's frames
  const aLink = link(apiA, relayA, rooms.toInitiator, rooms.toResponder)
  const acc = await aLink.poll(0)
  const { ready, session: aSession } = channel.completeInvite(pending, channel.decodeWire(acc[0]).handshake, { now })
  await aLink.send(channel.encodeWire(ready))
  const rd = await link(apiB, relayB, bRooms.toResponder, bRooms.toInitiator).poll(0)
  bSession.confirm(channel.decodeWire(rd[0]).handshake, { now })
  say(`4. handshake complete: channel ${aSession.cid.slice(0, 10)}… (labels ${aSession.labels}), confirmed on both sides`)

  const a = { session: aSession, api: apiA, link: link(apiA, relayA, aSession.rooms.inbound, aSession.rooms.outbound) }
  const b = { session: bSession, api: apiB, link: link(apiB, relayB, bSession.rooms.inbound, bSession.rooms.outbound) }
  return { a, b, cid: aSession.cid, steps }
}

/** one frame of text each way: seal, post, poll, open (the transports carry bytes; nothing here is trusted until opened) */
export async function sendText(from, to, text) {
  await from.link.send(channel.encodeWire(from.session.seal(text)))
  const wires = await to.link.poll(0)
  // the room also holds the handshake messages posted before (a new reader starts at the beginning): only frames are opened
  return wires.map((w) => channel.decodeWire(w).frame).filter(Boolean).map((f) => to.session.open(f, { text: true }).data)
}

/**
 * B's side of one request: the text is data. It is a `{ t: 'call', id, method, params }`; B hands it to its OWN provider as the
 * HTTPS request it would have received, and returns what that provider signed. Nothing in the text selects a container or an
 * address; the method must be one B's provider serves, or the provider signs METHOD_NOT_FOUND.
 */
export async function answerCall({ b, text }) {
  let req
  try { req = JSON.parse(text) } catch { throw new Error('B: the frame is not JSON') }
  if (!req || req.t !== 'call' || typeof req.method !== 'string' || !METHOD_RE.test(req.method) || typeof req.id !== 'string' || !ID_RE.test(req.id)) throw new Error('B: not a call')
  const params = req.params && typeof req.params === 'object' && !Array.isArray(req.params) ? req.params : {}
  const res = await b.provider.handleRequest(new Request(`${B_ORIGIN}/tapeapi/v1/${req.method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: req.id, params }),
  }), { clientIp: '127.0.0.1' })
  return { t: 'answer', envelope: await res.json() }
}

/**
 * A request/answer round over an open channel. Returns { request, answer, receipt, hashOnly, check } where `check` is the
 * verifier's result for the envelope (see receipts.mjs): the receipt is only kept when it verifies.
 */
export async function callOverChannel({ world, chan, method = 'quote', params = { sku: 'widget-7', qty: 12 }, id = `c-${Math.random().toString(36).slice(2, 10)}`, print = () => {} }) {
  const request = { t: 'call', id, method, params }
  const [text] = await sendText(chan.a, chan.b, JSON.stringify(request))
  print(`5. A -> B (in the channel): ${plainText(text, 120)}`)
  const answer = await answerCall({ b: world.b, text })
  const [back] = await sendText(chan.b, chan.a, JSON.stringify(answer))
  const got = JSON.parse(back)
  const env = got.envelope
  print(`6. B -> A (in the channel): ok ${env?.ok}, signed by container ${env?.container}`)
  const svc = await chan.a.api.resolve(B)
  const receipt = mcp.receiptOf({ envelope: env, method, params, circuits: svc.manifest.circuits, tokenId: svc.manifest.tokenId })
  const check = await verifyReceipt(chan.a.api, receipt, { container: B, id, method, params, result: env.ok ? env.result : env.error })
  print(`7. A checked the envelope against B's published signer: ${check.ok ? 'ok, signer ' + check.signer : 'REFUSED: ' + check.problems.join('; ')}`)
  return { request, answer: got, receipt, hashOnly: mcp.hashReceipt(receipt), check, envelope: env }
}

/** everything the relay holds, as text: what an operator (or anyone who reads its rooms) could search */
export function relayHoldings(world) { return world.relay.core.dump().map((f) => Buffer.from(f, 'base64').toString('latin1')) }
