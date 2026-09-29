// The relay's store: rooms of opaque frames, and long-poll waiters. No node: imports, so the same core runs under
// Node, Deno or a Worker. (On Cloudflare, isolates do not share memory: a production relay there keeps each room
// in a Durable Object. The logic below is what that object would run.)
// 中继的存储：若干房间的不透明帧，加上长轮询的等待者。没有 node: 依赖，同一份核心可跑在 Node、Deno 或 Worker 里。
// （Cloudflare 的隔离实例之间不共享内存，那里的生产中继应把每个房间放进一个 Durable Object，里面跑的就是下面这套逻辑。）
//
// What the relay can see: room names (hashes that reveal no identity), frame sizes, timing, and the IP of whoever
// polls or posts. What it cannot see: content, or who is talking -- frames are TAP-26 ciphertext end to end.
// 中继能看到：房间名（不泄露身份的哈希）、帧大小、时间、以及收发方的 IP。看不到：内容，以及谁在和谁说话。
const ROOM_RE = /^[0-9a-f]{64}$/
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/
// The first byte of a wire message: 0x01 handshake (accept / ready), 0x02 frame, 0x03 sealed invite (TAP-26),
// 0x04 epoch message, 0x05 group message (TAP-27). The relay reads the handshake type, to keep its free path
// honest, and the type byte of 0x03 / 0x04, to keep them from being flushed; everything else is ciphertext to it.
// 线路消息首字节：0x01 握手、0x02 帧、0x03 密封邀请（TAP-26）、0x04 纪元消息、0x05 群消息（TAP-27）。中继识别握手类型
// 以守住免费通道，识别 0x03 / 0x04 的类型字节以免它们被冲掉；其余对它都是密文。
const WIRE_HANDSHAKE = 0x01
// Invites (0x03) and epoch messages (0x04) are what a peer needs to START reading: lose one and the channel or the
// group never begins. They sit in a ring of their own that frames (0x02, 0x05) cannot push out (arch B2).
// 邀请（0x03）与纪元消息（0x04）是对端开始读取所需的东西：丢一条，通道或群就永远开不了头。
// 它们放在自己的环里，帧（0x02、0x05）挤不掉（arch B2）。
const KEPT = new Set([0x03, 0x04])
const wireType = (b64) => { try { return atob(b64.slice(0, 4)).charCodeAt(0) } catch { return -1 } }
// 0x01 followed by a JSON object whose `t` is accept or ready: the only thing the free path carries (review M-4)
// 0x01 之后是 `t` 为 accept 或 ready 的 JSON 对象：免费通道只承载这个
const isHandshake = (b64) => {
  try {
    const bin = atob(b64)
    if (bin.charCodeAt(0) !== WIRE_HANDSHAKE) return false
    const msg = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin.slice(1), (c) => c.charCodeAt(0))))
    return !!msg && typeof msg === 'object' && (msg.t === 'accept' || msg.t === 'ready')
  } catch { return false }
}

export function createRelayCore({
  maxFrameB64 = 22_000,        // a 16 KiB TAP-26 frame plus framing, base64-encoded / 16 KiB 帧加封装后的 base64
  maxFramesPerRoom = 256,
  // The protected ring for 0x03 / 0x04, and how many of them one source may post to one room per window. The window
  // is an invite's RECOMMENDED lifetime, so flushing the ring within it takes maxKeptPerRoom / maxKeptPerSource
  // distinct sources. A caller the relay cannot identify counts as one source for the whole room (arch B2).
  // 0x03 / 0x04 的受保护环，以及每个来源每个窗口内可向一个房间投递的条数。窗口取邀请的推荐寿命，因此要在其内冲掉整个环，
  // 需要 maxKeptPerRoom / maxKeptPerSource 个不同来源。中继无法识别的调用方对整个房间算作同一个来源。
  maxKeptPerRoom = 64,
  maxKeptPerSource = 8,
  keptWindowMs = 600_000,
  maxSourcesPerRoom = 256,
  // Idle rooms vanish (a relay is not storage), but not before an invite's RECOMMENDED 600 s lifetime has run:
  // an accept posted while the initiator is briefly offline must still be there (traceability D22).
  // 空闲房间自动消失（中继不是存储），但不早于邀请推荐的 600 秒寿命：发起方短暂离线时投递的 accept 必须还在。
  roomTtlMs = 900_000,
  maxRooms = 10_000,
  maxWaiters = 5_000,               // long-polls held open at once, across all rooms / 同时挂起的长轮询总数
  maxHandshakePerRoom = 8,
  // Rooms the free handshake path may create at once, their own lifetime and frame size. A free path that could
  // create rooms without limit would let anyone fill a priced relay's room table for nothing (review M-4).
  // 免费握手通道可同时创建的房间数、其寿命与帧大小。若不设限，任何人都能免费塞满收费中继的房间表。
  maxHandshakeRooms = 1_000,
  handshakeRoomTtlMs = 10 * 60 * 1000,
  maxHandshakeB64 = 2_048,          // largest free handshake frame, base64 characters / 免费握手帧的最大长度（base64 字符）
  // Below the provider runtime's handler timeout (25 s), or a full-length poll is answered with INTERNAL
  // instead of an empty result. / 必须低于运行时的处理超时（25 秒），否则满时长的轮询会得到 INTERNAL 而不是空结果。
  maxWaitMs = 20_000,
  // One answer must fit the TAP-21 response cap (1 MiB): a room holding many full frames would otherwise make
  // every poll fail, the cursor never advance, and the channel die. The client polls again from `next`.
  // 单次回答必须放得进 TAP-21 的 1 MiB 上限：否则攒了很多大帧的房间会让每次轮询都失败、游标永不前进、通道死掉。
  maxRecvBytes = 512 * 1024,
  now = () => Date.now(),
  // Optional storage adapter (FIXED RELAY-1). Called synchronously with what changed: `put` (a frame was taken, and
  // `dropped` is the index a full ring shifted out), `touch` (a read touched the room) and `drop` (the sweep removed an
  // expired room). The Node relay passes none and keeps everything in memory; the Worker's RelayRoom writes these to
  // Durable Object storage and hands the room back through `restore` when Cloudflare recreates the object. Only the
  // core knows which frame a ring pushed out and which rooms a sweep removed, so the hook sits here rather than a copy
  // of the ring rules in the Worker.
  // 可选的存储适配层：同步告知变化——`put`（收下一帧，`dropped` 是满环移出的序号）、`touch`（读取触碰了房间）、
  // `drop`（清理删掉了过期房间）。Node 中继不传，一切仍在内存里；Worker 的 RelayRoom 把它们写进 Durable Object 存储，
  // 对象被 Cloudflare 重建时经 `restore` 交回房间。只有核心知道环挤掉了哪一帧、清理删了哪些房间，所以挂钩放在这里，
  // 而不是在 Worker 里再抄一份环的规则。
  // A host that writes asynchronously sends with `pending: true` and then calls `commit(room, i)` once the write landed
  // or `abort(room, i)` if it failed (FIXED P101-4). A pending frame is read by no one (a read stops before it) and
  // wakes no one; abort takes it back out -- its index if nothing came after it, the frame a full ring shifted out for
  // it, the per-source count -- so a client's retry after the error is the only copy.
  // 异步写入的宿主以 `pending: true` 发送，写入落地后调用 `commit(room, i)`，失败则调用 `abort(room, i)`（FIXED P101-4）。
  // 暂存的帧谁也读不到（读取停在它之前），也不唤醒任何人；abort 把它撤出——其后没有别的帧时连序号一起、满环为它移出的帧、
  // 按来源的计数——因此客户端在错误之后的重试是唯一的一份。
  onChange = null,
  random = () => { const b = new Uint8Array(8); globalThis.crypto.getRandomValues(b); return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('') },
} = {}) {
  // Rooms are created ONLY by send. A long-poll on a room that does not exist yet waits in `waiters`, which is
  // bounded on its own and does not pin anything: before this, free polls on made-up names created rooms that the
  // sweep could never evict, until the relay refused every send (audit M-1).
  // 房间只由 send 创建。对尚不存在的房间的长轮询在 `waiters` 里等待，它有独立上限、也不会钉住任何东西：此前，
  // 对随便编的房间名发免费轮询会创建清理永远清不掉的房间，直到中继拒绝所有发送。
  //
  // Every room gets a random `epoch` when it is created. Indices restart at 0 in a re-created room, so a client
  // that remembered index N would otherwise skip the first N+1 frames of the new room; with the epoch it notices
  // and starts over (audit H-1).
  // 每个房间创建时得到一个随机 `epoch`。重建的房间序号从 0 开始，记住序号 N 的客户端否则会跳过新房间的前 N+1 帧；
  // 有了纪元，它能察觉并从头读。
  const rooms = new Map()      // room -> { frames: [{ i, frame }], kept: [{ i, frame }], sources, next, epoch, touched }
  const waiters = new Map()    // room -> Set<wake>
  let waiting = 0
  const bad = (msg) => Object.assign(new Error(msg), { code: 'BAD_REQUEST' })
  const checkName = (name) => { if (typeof name !== 'string' || !ROOM_RE.test(name)) throw bad('room must be 32 bytes of lowercase hex') }
  const meta = (r) => ({ epoch: r.epoch, next: r.next, touched: r.touched, handshakeOnly: r.handshakeOnly })
  const touch = (r, name) => { r.touched = now(); if (onChange && name) onChange({ type: 'touch', room: name, meta: meta(r) }); return r }
  const expired = (r, t) => t - r.touched > (r.handshakeOnly ? handshakeRoomTtlMs : roomTtlMs)
  // Only EXPIRED rooms are ever evicted. When the relay is full of live rooms it refuses new ones instead of
  // throwing away frames other channels have not collected yet (audit M-2).
  // 只清理已过期的房间。中继被活跃房间占满时拒绝新建房间，而不是扔掉其他通道还没取走的帧。
  let handshakeRooms = 0
  function sweep() {
    const t = now()
    for (const [k, r] of rooms) {
      if (expired(r, t)) { if (r.handshakeOnly) handshakeRooms--; rooms.delete(k); if (onChange) onChange({ type: 'drop', room: k }) }
    }
  }
  // Both rings in posting order: `i` comes from one counter, so a merge by `i` is the order the relay took them in.
  // 两个环按投递顺序合并：`i` 出自同一个计数器，按 `i` 合并即中继收到它们的顺序。
  const inOrder = (r) => {
    const a = r.frames, b = r.kept
    if (!b.length) return a
    const out = []; let x = 0, y = 0
    while (x < a.length || y < b.length) out.push(y >= b.length || (x < a.length && a[x].i < b[y].i) ? a[x++] : b[y++])
    return out
  }
  function wake(name) {
    const set = waiters.get(name)
    if (!set) return
    waiters.delete(name)
    for (const w of set) w()
  }
  return {
    // `source` is who posted, as the host vouches for it (the proven consumer of a paid call, else the client IP);
    // it only keys the 0x03 / 0x04 budget and is never stored with a frame.
    // `source` 是宿主担保的投递者（付费调用已证明的消费者，否则是客户端 IP）；只用于 0x03 / 0x04 的额度，不随帧保存。
    send(roomName, frame, { handshakeOnly = false, source, pending = false } = {}) {
      checkName(roomName)
      if (typeof frame !== 'string' || !frame || frame.length % 4 || !B64_RE.test(frame)) throw bad('frame must be non-empty base64')
      if (frame.length > maxFrameB64) throw bad(`frame larger than ${maxFrameB64} base64 characters`)
      // The free handshake path carries TAP-26 wire type 0x01 only (accept / ready), a few per room.
      // 免费握手通道只承载 TAP-26 的 0x01 线路类型（accept / ready），每个房间只允许若干条。
      if (handshakeOnly) {
        if (frame.length > maxHandshakeB64) throw bad('a handshake message is small; this is not one')
        if (!isHandshake(frame)) throw bad('relayHandshake carries handshake messages only (0x01 + an accept/ready JSON object)')
        const r0 = rooms.get(roomName)
        if (r0 && r0.frames.filter((f) => wireType(f.frame) === WIRE_HANDSHAKE).length >= maxHandshakePerRoom) throw bad('too many handshake messages in this room')
      }
      let r = rooms.get(roomName)
      const created = !r, adopted = !!r && r.handshakeOnly && !handshakeOnly
      if (!r) {
        if (rooms.size >= maxRooms) sweep()
        if (rooms.size >= maxRooms) throw Object.assign(new Error('relay is full'), { code: 'UNAVAILABLE' })
        if (handshakeOnly) {
          if (handshakeRooms >= maxHandshakeRooms) sweep()
          if (handshakeRooms >= maxHandshakeRooms) throw Object.assign(new Error('too many handshake-only rooms; try again shortly'), { code: 'UNAVAILABLE' })
          handshakeRooms++
        }
        r = { frames: [], kept: [], sources: new Map(), next: 0, epoch: random(), touched: now(), handshakeOnly, staged: new Map() }
        rooms.set(roomName, r)
      } else if (r.handshakeOnly && !handshakeOnly) {
        r.handshakeOnly = false; handshakeRooms--   // a paid post adopts the room / 付费消息接管该房间
      }
      const kept = KEPT.has(wireType(frame))
      let budget = null
      if (kept) {
        const t = now(), who = String(source ?? '')
        let b = r.sources.get(who)
        if (!b || t >= b.reset) { b = { n: 0, reset: t + keptWindowMs }; r.sources.delete(who); r.sources.set(who, b) }
        if (b.n >= maxKeptPerSource) throw bad(`too many invites / epoch messages from this source in this room; retry in ${Math.ceil((b.reset - t) / 1000)} s`)
        b.n++
        budget = b
        while (r.sources.size > maxSourcesPerRoom) r.sources.delete(r.sources.keys().next().value)
      }
      touch(r)
      const i = r.next++
      const ring = kept ? r.kept : r.frames
      const entry = pending ? { i, frame, pending: true } : { i, frame }
      ring.push(entry)
      const out = ring.length > (kept ? maxKeptPerRoom : maxFramesPerRoom) ? ring.shift() : undefined   // oldest first; TAP-26 reports the gap / 丢最旧的，TAP-26 会报告空洞
      if (pending) (r.staged ??= new Map()).set(i, { entry, ring, out, budget, created, adopted })
      if (onChange) onChange({ type: 'put', room: roomName, meta: meta(r), frame: { i, frame }, dropped: out?.i })
      if (!pending) wake(roomName)
      return { i, epoch: r.epoch }
    },
    // A pending frame's write landed: readers may have it now (FIXED P101-4). / 暂存帧的写入已落地：现在可以读了。
    commit(roomName, i) {
      const r = rooms.get(roomName), st = r?.staged?.get(i)
      if (!st) return false
      r.staged.delete(i)
      delete st.entry.pending
      wake(roomName)
      return true
    },
    // A pending frame's write failed: take it back out, as if it had never been sent (FIXED P101-4).
    // 暂存帧的写入失败：撤出，如同从未发送。
    abort(roomName, i) {
      const r = rooms.get(roomName), st = r?.staged?.get(i)
      if (!st) return false
      r.staged.delete(i)
      const at = st.ring.indexOf(st.entry)
      if (at >= 0) st.ring.splice(at, 1)
      // The frame the ring shifted out for it goes back in index order (a host deletes it from storage only after the write
      // landed). / 环为它移出的帧按序号放回（宿主只在写入落地之后才从存储删除它）。
      if (st.out) { const k = st.ring.findIndex((f) => f.i > st.out.i); st.ring.splice(k < 0 ? st.ring.length : k, 0, st.out) }
      if (st.budget && st.budget.n > 0) st.budget.n--
      if (r.next === i + 1) r.next = i                  // nothing came after it / 其后没有别的帧
      if (st.adopted) { r.handshakeOnly = true; handshakeRooms++ }
      if (st.created && !r.frames.length && !r.kept.length && !r.staged.size) {
        rooms.delete(roomName)
        if (r.handshakeOnly) handshakeRooms--
      }
      return true
    },
    async recv(roomName, after = -1, waitMs = 0, epoch) {
      checkName(roomName)
      if (!Number.isInteger(after) || after < -1) throw bad('after must be an integer >= -1')
      if (!Number.isInteger(waitMs) || waitMs < 0) throw bad('waitMs must be a non-negative integer')
      // null is what a client last saw for a room that did not exist yet: it differs from any epoch, so the room is read
      // from the start (conformance run, 2026-09-25). / null 是客户端在房间尚不存在时看到的值：与任何纪元都不同，从头读。
      if (epoch !== undefined && epoch !== null && (typeof epoch !== 'string' || !/^[0-9a-f]{1,32}$/.test(epoch))) throw bad('epoch must be the hex string (or null) a previous answer returned')
      const wait = Math.min(waitMs, maxWaitMs)
      const pick = () => {
        const r = rooms.get(roomName)
        if (!r) return { frames: [], next: after, epoch: null }
        touch(r, roomName)
        // A cursor from another epoch refers to a room that no longer exists: read this one from the start.
        // 另一个纪元的游标指向已不存在的房间：从头读这个房间。
        const from = epoch !== undefined && epoch !== r.epoch ? -1 : after
        // Hand back a prefix that fits maxRecvBytes; `next` says where to continue. At least one frame always
        // goes out, so a channel can never be wedged by its own backlog.
        // 只回一个放得下的前缀，`next` 指明从哪继续；至少回一帧，使积压永远卡不死通道。
        const frames = []
        let bytes = 0
        for (const f of inOrder(r)) {
          if (f.pending) break                   // not written yet: nothing at or after it is handed out / 尚未写入：它及其后都不交出
          if (f.i <= from) continue
          bytes += f.frame.length + 32
          if (frames.length && bytes > maxRecvBytes) break
          frames.push(f)
        }
        return { frames, next: frames.length ? frames[frames.length - 1].i : from, epoch: r.epoch }
      }
      const out = pick()
      if (out.frames.length || wait === 0 || waiting >= maxWaiters) return out
      waiting++
      try {
        await new Promise((resolve) => {
          const done = () => { clearTimeout(timer); resolve() }
          const timer = setTimeout(() => { waiters.get(roomName)?.delete(done); resolve() }, wait)
          let set = waiters.get(roomName)
          if (!set) { set = new Set(); waiters.set(roomName, set) }
          set.add(done)
        })
      } finally { waiting-- }
      if (waiters.get(roomName)?.size === 0) waiters.delete(roomName)
      return pick()
    },
    sweep,
    // Hands back a room the storage adapter kept (FIXED RELAY-1): same epoch, same indices, each frame in the ring its
    // wire type puts it in. A room already past its lifetime is not restored (false): the caller clears its storage.
    // Nothing else changes: no touch, no hook, no wake.
    // 交回存储适配层保存的房间：纪元与序号不变，每帧按线路类型回到它的环。已超过寿命的房间不恢复（返回 false），由调用方清掉存储。
    restore(roomName, { epoch, next, touched, handshakeOnly = false, frames = [] }) {
      checkName(roomName)
      if (rooms.has(roomName) || typeof epoch !== 'string' || !Number.isInteger(next) || next < 0 || !Number.isFinite(touched)) return false
      const r = { frames: [], kept: [], sources: new Map(), next, epoch, touched, handshakeOnly: !!handshakeOnly, staged: new Map() }
      if (expired(r, now())) return false
      for (const f of [...frames].filter((f) => Number.isInteger(f?.i) && f.i >= 0 && f.i < next && typeof f.frame === 'string').sort((a, b) => a.i - b.i)) {
        (KEPT.has(wireType(f.frame)) ? r.kept : r.frames).push({ i: f.i, frame: f.frame })
      }
      // Only if storage held more than a ring allows (it never should): keep the newest, as send would have.
      // 仅当存储里多于环的上限（本不应发生）：留最新的，与 send 一致。
      r.frames.splice(0, Math.max(0, r.frames.length - maxFramesPerRoom))
      r.kept.splice(0, Math.max(0, r.kept.length - maxKeptPerRoom))
      if (r.handshakeOnly) handshakeRooms++
      rooms.set(roomName, r)
      return true
    },
    // For tests and operators: every stored frame, so one can check that nothing readable is kept.
    // 供测试与运维使用：列出所有存储的帧，用来确认没有保存任何可读内容。
    dump() { return [...rooms.values()].flatMap((r) => inOrder(r).map((f) => f.frame)) },
    get size() { return rooms.size },
    get waiting() { return waiting },
  }
}

// The two TapeAPI methods a relay exposes. Senders pay per frame (the operator sets the price, possibly 0);
// receiving is free and long-polls, so a frame reaches a waiting peer one round trip after it is posted.
// 中继对外暴露的两个 TapeAPI 方法。发送方按帧付费（价格由运营方定，可以是 0）；接收免费且长轮询，
// 因此一帧在发出后一个往返就能到达正在等待的对端。
// The source a post counts against for 0x03 / 0x04 (arch B2): the consumer a paid voucher proved, else the IP the
// provider runtime vouches for. / 0x03 / 0x04 额度所计的来源：付费凭证证明的消费者，否则是运行时担保的 IP。
export const sourceOf = (ctx) => (ctx?.consumer ? `c:${String(ctx.consumer).toLowerCase()}` : ctx?.clientIp ? `ip:${ctx.clientIp}` : undefined)

export function relayMethods(core) {
  return {
    relaySend: async ({ room, frame }, ctx) => core.send(room, frame, { source: sourceOf(ctx) }),
    // Handshake messages are free even on a priced relay: the responder has to send `accept` before it can be
    // expected to have funded anything, and without this a priced relay cannot start a channel at all.
    // 即使中继收费，握手消息也免费：响应方必须先发出 `accept`，此时它还没有理由已经充值。
    relayHandshake: async ({ room, frame }, ctx) => core.send(room, frame, { handshakeOnly: true, source: sourceOf(ctx) }),
    relayRecv: async ({ room, after = -1, waitMs = 0, epoch }) => core.recv(room, after, waitMs, epoch),
  }
}

export function relayManifestMethods({ priceBEM = '0' } = {}) {
  return [
    { name: 'relaySend', priceBEM: String(priceBEM), params: { room: 'hex32', frame: 'base64' }, returns: { i: 'number', epoch: 'hex' } },
    { name: 'relayHandshake', priceBEM: '0', params: { room: 'hex32', frame: 'base64' }, returns: { i: 'number', epoch: 'hex' } },
    { name: 'relayRecv', priceBEM: '0', params: { room: 'hex32', after: 'number', waitMs: 'number', epoch: 'hex?' }, returns: { frames: 'array', next: 'number', epoch: 'hex|null' } },
  ]
}
