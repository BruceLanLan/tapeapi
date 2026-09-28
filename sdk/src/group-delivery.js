// TAP-27 delivery in one call: the owner posts an epoch message AND the invites, the member checks its inbox.
//
// A group uses two kinds of room, and an application that knows only one of them sets up a group nobody joins:
//   group room   groupRoom(gid) = group.room: epoch messages (0x04) and group messages (0x05)
//   inbox room   channel.inboxRoom(CONTAINER, chainId), one per member: the sealed invite (0x03) that tells a new
//                member the group exists. Derived from the member's container address (the ERC-6551 account, never
//                the holder's wallet) and its chainId: another address or chainId is another room, and the member
//                reads nothing at all.
// deliverGroupUpdate() posts the invites to each new member's inbox room and the epoch message to the group room,
// over a relay and / or ChannelBus, and reports every post. checkGroupInvites() reads the member's inbox room with a
// cursor per room that carries the relay's room epoch, and opens what it finds.
//
// TAP-27 一步投递：群主同时投出纪元消息与邀请，成员检查自己的收件房间。
// 群用到两种房间，应用只知道其中一种，就会建出一个谁也进不来的群：
//   群房间     groupRoom(gid) = group.room：纪元消息（0x04）与群消息（0x05）
//   收件房间   channel.inboxRoom(容器地址, chainId)，每个成员一个：密封邀请（0x03），告诉新成员这个群存在。由成员的**容器**
//              地址（ERC-6551 账户，绝不是持有人钱包）与 chainId 推导；地址或 chainId 不同就是另一个房间，成员什么也读不到。
// deliverGroupUpdate() 把邀请投进每个新成员的收件房间、把纪元消息投进群房间（中继和 / 或 ChannelBus），逐条报告结果。
// checkGroupInvites() 读取成员的收件房间，按房间保存带中继房间纪元的游标，并打开读到的邀请。
import { TapeAPIError } from './errors.js'
import { encodeCall } from './abi.js'
import { inboxRoom, openFromInbox, toBase64, fromBase64, toHex, CHANNELBUS_MAX_WIRE, INVITE_KIND } from './channel.js'
import { openGroupInvite, GROUP_INVITE_KIND } from './group.js'
import { x25519 } from '@noble/curves/ed25519'

export const DELIVERY_ERROR = 'GROUP_DELIVERY'
const WIRE_INVITE = 0x03
const MAX_PAGES = 64                  // pages one check reads from one relay (a relay answer is at most 512 KiB) / 单次检查最多读的页数

const fail = (msg, extra) => { throw new TapeAPIError(DELIVERY_ERROR, msg, extra) }
const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const list = (x) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x])
const hexN = (n) => '0x' + n.toString(16)

// One relay, as { api, svc, payer }: api is a TapeAPI client (createTapeAPI), svc the resolved relay service.
// 一个中继：api 为 TapeAPI 客户端，svc 为解析出的中继服务。
function checkRelay(r, i) {
  if (!r || typeof r.api?.call !== 'function') fail(`relay[${i}] needs { api, svc }: api is a TapeAPI client (createTapeAPI)`)
  if (!r.svc || typeof r.svc !== 'object') fail(`relay[${i}] needs svc, the resolved relay service (await api.resolve('12.1013.tape'))`)
  return r
}
const relayName = (r) => String(r.svc.container ?? r.svc.name ?? 'relay').toLowerCase()

// What went wrong, in a form an application can act on. The relay limits invites and epoch messages (0x03 / 0x04) per
// source per room (8 per 10 minutes on the reference relay): that answer is BAD_REQUEST "too many invites / epoch
// messages ... retry in N s". / 失败原因，给出应用可据以行动的形式。中继对 0x03 / 0x04 按来源按房间限流。
function describe(e) {
  const out = { code: e?.code ?? 'ERROR', message: String(e?.message ?? e) }
  if (/too many invites/.test(out.message)) {
    out.rateLimited = true
    const m = /retry in (\d+) s/.exec(out.message)
    if (m) out.retryAfterS = Number(m[1])
  }
  return out
}

/**
 * Owner: post what a membership change needs, to the rooms it needs to go to, and report every post.
 *
 *   deliverGroupUpdate({ group, update, invite, relay, bus })
 *     group   the owner's handle (createGroup / resumeGroup)
 *     update  what createGroup, addMembers, removeMembers, rotate or resumeGroup returned ({ epochWire, added }).
 *             Omitted: repost the current epoch message (group.epochWire), for §3.5's periodic repost.
 *     invite  who gets an invite in their inbox room: 'new' (default: update.added, the members this epoch brought
 *             in), 'all' (every member but the owner: after a relay forgot its rooms), 'none', or a list of
 *             containers / { container, chainId } that must be in the current roster
 *     relay   { api, svc, payer? } or a list of them: relaySend through api.call (payer: a channel for a priced relay)
 *     bus     { address, sendTx } or a list: a ChannelBus; sendTx(tx) => txHash is the caller's wallet (the SDK holds
 *             none), tx = { to, data, value, gas } as busTransport builds it. One transaction per room.
 *     throwOnError  default true: any failed post throws GROUP_DELIVERY after every post was tried, with
 *             e.data = { groupEpoch, deliveries }. false: returns { ok: false, ... } instead. Never silent.
 *   -> { ok, groupEpoch, room, deliveries: [{ what: 'invite' | 'epoch', room, container?, chainId?, via: 'relay' | 'bus',
 *         relay? | bus?, ok, i?, epoch?, txHash?, error? }] }
 *      `i` and `epoch` are the relay's answer: the frame's index in that room and the room's epoch (not the group's).
 *
 * Order: invites first, then the epoch message (§3.5). Each invite is sealed once per member and the same bytes go to
 * every transport, so a member reading two of them sees one invite twice, not two invites.
 * 群主：把成员变动需要的东西投到该去的房间，逐条报告。顺序：先邀请、后纪元消息。每个成员的邀请只密封一次，同样的字节发往
 * 每个传输。任何一条失败，在全部尝试之后抛出 GROUP_DELIVERY（e.data 含每条结果）；throwOnError: false 时明确返回 ok: false。
 */
export async function deliverGroupUpdate({ group, update, invite = 'new', relay, bus, throwOnError = true, random } = {}) {
  if (!group || group.isOwner !== true || typeof group.inviteFor !== 'function') fail('deliverGroupUpdate needs the owner\'s group handle (createGroup / resumeGroup)')
  const relays = list(relay).map(checkRelay)
  const buses = list(bus).map((b, i) => {
    if (!b || !isAddr(b.address)) fail(`bus[${i}] needs { address, sendTx }: address is the ChannelBus contract`)
    if (typeof b.sendTx !== 'function') fail(`bus[${i}].sendTx is required: the SDK holds no wallet (sendTx(tx) => txHash)`)
    return b
  })
  if (!relays.length && !buses.length) fail('name at least one transport: relay { api, svc } or bus { address, sendTx }')
  const epochWire = update?.epochWire ?? group.epochWire
  if (!(epochWire instanceof Uint8Array) || epochWire[0] !== 0x04) fail('no epoch message to deliver: pass the update that createGroup / addMembers / removeMembers / rotate / resumeGroup returned')
  if (epochWire.length > CHANNELBUS_MAX_WIRE) fail('epoch message too large for one wire message')
  if (toHex(epochWire.subarray(1, 17)) !== group.gid) fail('this epoch message belongs to another group: pass the update this group returned')

  // Who is invited: always the roster's entries, so the inbox room comes from the container and chainId the owner signed.
  // 邀请谁：总是取名单里的条目，使收件房间来自群主签过的容器地址与 chainId。
  const roster = group.members
  const ownerRef = group.roster?.owner
  const inRoster = (t) => {
    const c = typeof t === 'string' ? t : t?.container
    if (!isAddr(c)) fail(`invite: ${JSON.stringify(t)} is not a container address`)
    const chainId = typeof t === 'object' && t.chainId !== undefined ? t.chainId : undefined
    const m = roster.find((x) => same(x.container, c) && (chainId === undefined || x.chainId === chainId))
    if (!m) fail(`invite: ${c}${chainId !== undefined ? ` on chain ${chainId}` : ''} is not in the current roster. Invites go to the CONTAINER (the ERC-6551 account the channel record names), never the holder's wallet; add the member first (addMembers)`)
    return m
  }
  let targets
  if (invite === 'new') targets = list(update?.added).map(inRoster)
  else if (invite === 'all') targets = roster.filter((m) => !(ownerRef && same(m.container, ownerRef.container) && m.chainId === (ownerRef.chainId ?? 56)))
  else if (invite === 'none') targets = []
  else if (Array.isArray(invite)) targets = invite.map(inRoster)
  else fail("invite must be 'new', 'all', 'none' or a list of members")

  const deliveries = []
  async function post(what, room, wire, extra) {
    for (const r of relays) {
      const d = { what, room, ...extra, via: 'relay', relay: relayName(r) }
      try {
        const res = (await r.api.call(r.svc, 'relaySend', { room, frame: toBase64(wire) }, r.payer ? { payer: r.payer } : {}))?.result
        if (!res || !Number.isInteger(res.i)) throw new TapeAPIError('BAD_RESPONSE', `relaySend answered ${JSON.stringify(res)}, not { i, epoch }`)
        Object.assign(d, { ok: true, i: res.i, epoch: res.epoch ?? null })
      } catch (e) { Object.assign(d, { ok: false, error: describe(e) }) }
      deliveries.push(d)
    }
    for (const b of buses) {
      const d = { what, room, ...extra, via: 'bus', bus: b.address.toLowerCase() }
      try {
        // As busTransport.tx builds it: ChannelBus.send(room, wire), no estimate round trip.
        // 与 busTransport.tx 相同：ChannelBus.send(room, wire)，不做 gas 估算往返。
        const tx = { to: b.address, data: encodeCall('send', ['0x' + room, wire]), value: '0x0', gas: hexN(50_000 + 40 * wire.length) }
        const txHash = await b.sendTx(tx)
        if (txHash === undefined || txHash === null || txHash === false) throw new TapeAPIError('BAD_RESPONSE', 'sendTx returned nothing: return the transaction hash, or throw')
        Object.assign(d, { ok: true, txHash })
      } catch (e) { Object.assign(d, { ok: false, error: describe(e) }) }
      deliveries.push(d)
    }
  }

  for (const m of targets) {
    const room = inboxRoom(m.container, m.chainId)
    let wire
    try { wire = group.inviteFor(m, random ? { random } : {}) } catch (e) {
      deliveries.push({ what: 'invite', room, container: m.container, chainId: m.chainId, via: null, ok: false, error: describe(e) })
      continue
    }
    await post('invite', room, wire, { container: m.container, chainId: m.chainId })
  }
  await post('epoch', group.room, epochWire, {})

  const bad = deliveries.filter((d) => !d.ok)
  const out = { ok: bad.length === 0, groupEpoch: group.epoch, room: group.room, deliveries }
  if (bad.length && throwOnError) {
    const first = bad[0]
    const where = first.what === 'invite' ? `the invite for ${first.container} (inbox room ${first.room})` : `the epoch message (group room ${first.room})`
    fail(`${bad.length} of ${deliveries.length} group posts failed; first: ${where} via ${first.via ?? 'sealing'}: ${first.error.message}${first.error.rateLimited ? ' (the relay limits invites / epoch messages per source per room: wait and deliver again)' : ''}`, { data: out })
  }
  return out
}

// A cursor for one relay room: { after, epoch }. `after` is the last index read; `epoch` the room epoch the relay
// named when we read it, null before it named one. A stored { after >= 0, epoch: null } is a cursor taken from
// somewhere else (another room, or saved without its epoch): reading from it could skip the invite at index 0, so it
// starts over. / 一个中继房间的游标。`after >= 0` 却没有 epoch 的游标来自别处（别的房间，或存时丢了 epoch）：
// 按它读可能跳过序号 0 的邀请，因此从头读。
function normCursor(c) {
  if (!c || typeof c !== 'object' || !Number.isInteger(c.after) || c.after < -1) return { after: -1, epoch: null }
  if (typeof c.epoch !== 'string' || !/^[0-9a-f]{1,32}$/.test(c.epoch)) return { after: -1, epoch: null }
  return { after: c.after, epoch: c.epoch }
}

/**
 * Member: read this container's inbox room on each relay and open the group invites found there.
 *
 *   checkGroupInvites({ self, identity, relay, cursors, waitMs, holder, checkSelf })
 *     self      { container, chainId }: the member's CONTAINER address (the ERC-6551 account its channel record names),
 *               NOT the holder's wallet, and the chain it lives on (default 56). Anything else is another room.
 *     identity  the channel identity whose keys the record publishes (channel.generateIdentity()); or self.staticSecret
 *     relay     { api, svc } or a list of them
 *     cursors   where the cursor of each room is kept: any { get(key), set(key, value) }, sync or async (a Map works;
 *               back it with a file or a database to survive restarts). Key: `relay:<relay container>:<room>`; value:
 *               { after, epoch }. Default: a new Map, so every call reads the room from the start.
 *     waitMs    long-poll for the first read on each relay (default 0: answer at once)
 *     holder    optional: the holder's wallet; if it equals self.container, the call is refused (wallet given for container)
 *     checkSelf optional: true (use relay[0].api) or a TapeAPI client. Reads this container's channel record and
 *               refuses unless it publishes this identity's X25519 key on this chainId: catches a wallet address, a
 *               wrong chainId or a stale identity file before a silent empty read.
 *   -> { ok, room, container, chainId, invites: [{ invite, i, relay }], skipped, skippedBy, failed }
 *      invites  one per distinct sealed invite (the same bytes on two relays count once), oldest first
 *      skipped  frames that were not a group invite for us: skippedBy = { unreadable, channelInvite, otherKind, notSealed }
 *               (channelInvite: a TAP-26 channel invite in the same inbox; handle it with channel.acceptInvite)
 *      failed   relays that could not be read: [{ relay, error }]; `ok` is false when any failed. When every relay
 *               failed, the call throws GROUP_DELIVERY instead.
 * An invite says only where to look: joinGroup with the owner's keys from the chain (api.chain.channelKeys(invite.owner.container)).
 * 成员：在每个中继上读取本容器的收件房间，打开其中的入群邀请。self 必须是**容器**地址与它所在链的 chainId。游标按房间保存，
 * 带中继返回的房间纪元，首次读取用 after: -1、epoch: null。打不开的帧跳过并计数。所有中继都读不了时抛出 GROUP_DELIVERY。
 */
export async function checkGroupInvites({ self, identity, relay, cursors = new Map(), waitMs = 0, holder, checkSelf } = {}) {
  if (!self || !isAddr(self.container)) fail('self.container must be the member\'s CONTAINER address (the ERC-6551 account), not the holder\'s wallet')
  const chainId = self.chainId ?? 56
  if (!Number.isInteger(chainId) || chainId < 1) fail('self.chainId must be a positive integer (the chain the container lives on)')
  if (holder !== undefined && isAddr(holder) && same(holder, self.container)) {
    fail(`self.container ${self.container} is the holder's wallet. Invites are sealed to the CONTAINER's inbox room: pass the container address (the ERC-6551 account of the circuit, as in its channel record), not the wallet that holds the circuit`)
  }
  const staticSecret = self.staticSecret ?? identity?.x25519?.secretKey
  if (!(staticSecret instanceof Uint8Array) || staticSecret.length !== 32) fail('identity.x25519.secretKey (or self.staticSecret) is required: the channel identity whose X25519 key the channel record publishes')
  if (typeof cursors?.get !== 'function' || typeof cursors?.set !== 'function') fail('cursors must have get(key) and set(key, value) (a Map works)')
  const relays = list(relay).map(checkRelay)
  if (!relays.length) fail('relay { api, svc } is required')
  const room = inboxRoom(self.container, chainId)

  if (checkSelf) {
    const api = checkSelf === true ? relays[0].api : checkSelf
    if (typeof api?.chain?.channelKeys !== 'function') fail('checkSelf needs a TapeAPI client (createTapeAPI) with chain.channelKeys')
    if (api.chainId !== undefined && api.chainId !== chainId) fail(`self.chainId is ${chainId} but the client reads chain ${api.chainId}: the inbox room depends on the chainId the container lives on`)
    let rec
    try { rec = await api.chain.channelKeys(self.container) } catch (e) {
      if (e?.code === 'NOT_FOUND') fail(`${self.container} is not a TapeOut container on chain ${chainId} (${e.message}). Is it the holder's wallet? Pass the container address`, { cause: e })
      throw e
    }
    const mine = '0x' + toHex(x25519.getPublicKey(staticSecret))
    if (!same(rec.x25519, mine)) fail(`the channel record of ${self.container} publishes x25519 ${rec.x25519}, not this identity's ${mine}: a stale identity file, or keys not yet published (publishChannelKeys). Invites are sealed to the published key`)
  }

  const me = { container: self.container, chainId, staticSecret }
  const invites = [], seen = new Set(), failed = []
  const skippedBy = { unreadable: 0, channelInvite: 0, otherKind: 0, notSealed: 0 }
  for (const r of relays) {
    const key = `relay:${relayName(r)}:${room}`
    let cur = normCursor(await cursors.get(key))
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const ans = (await r.api.call(r.svc, 'relayRecv', { room, after: cur.after, waitMs: page === 0 ? waitMs : 0, epoch: cur.epoch }, { timeoutMs: (page === 0 ? waitMs : 0) + 10_000 }))?.result ?? {}
        // No room (never posted, or forgotten after 15 idle minutes): nothing to read, and the next room starts at 0.
        // 没有房间（从未投递，或空闲 15 分钟后被遗忘）：没什么可读，下一个房间从 0 开始。
        if (typeof ans.epoch !== 'string') { cur = { after: -1, epoch: null }; break }
        if (ans.epoch !== cur.epoch) cur = { after: -1, epoch: ans.epoch }   // a re-created room: read it from the start / 重建的房间：从头读
        let moved = false
        for (const f of Array.isArray(ans.frames) ? ans.frames : []) {
          if (!Number.isInteger(f?.i) || f.i <= cur.after) continue
          cur = { after: f.i, epoch: cur.epoch }
          moved = true
          let wire
          try { wire = fromBase64(f.frame) } catch { skippedBy.unreadable++; continue }
          if (wire[0] !== WIRE_INVITE) { skippedBy.notSealed++; continue }
          const id = toHex(wire)
          if (seen.has(id)) continue
          let obj
          try { obj = openFromInbox(wire, { self: me }) } catch { skippedBy.unreadable++; continue }
          if (obj.kind === INVITE_KIND) { skippedBy.channelInvite++; continue }
          if (obj.kind !== GROUP_INVITE_KIND) { skippedBy.otherKind++; continue }
          let inv
          try { inv = openGroupInvite(wire, { self: me }) } catch { skippedBy.unreadable++; continue }
          seen.add(id)
          invites.push({ invite: inv, i: f.i, relay: relayName(r) })
        }
        if (!moved) break
      }
      await cursors.set(key, cur)
    } catch (e) {
      failed.push({ relay: relayName(r), error: describe(e) })
    }
  }
  if (failed.length === relays.length) fail(`could not read inbox room ${room} on any relay: ${failed.map((f) => `${f.relay}: ${f.error.message}`).join('; ')}`, { data: { room, failed } })
  const skipped = Object.values(skippedBy).reduce((a, b) => a + b, 0)
  return { ok: failed.length === 0, room, container: self.container.toLowerCase(), chainId, invites, skipped, skippedBy, failed }
}
