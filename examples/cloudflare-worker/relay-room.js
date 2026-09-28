// One relay room per Durable Object. Worker isolates do not share memory, so a relay whose rooms lived in the
// isolate would split one room into several, and a frame posted through one isolate would never reach a peer
// polling through another. A Durable Object is a single instance per name, globally: every isolate that asks for
// room R talks to the same object, which is exactly the property a room needs.
// 每个中继房间一个 Durable Object。Worker 隔离实例之间不共享内存，房间若放在隔离实例里，一个房间会被拆成好几份，
// 经由一个实例发出的帧，永远到不了经由另一个实例轮询的对端。Durable Object 按名字全局唯一：所有问房间 R 的实例
// 都在和同一个对象说话，这正是房间需要的性质。
//
// Frames are written to the object's Durable Object storage (FIXED RELAY-1). Cloudflare evicts an idle object within
// seconds, and until 2026-09-29 the frames went with it: a room meant to live 15 minutes lived about ten seconds, so
// invites, group epochs and anything posted to a peer that was not polling at that moment were lost. Now a recreated
// object restores its room -- same epoch, same indices, both rings -- so clients' cursors keep working, and only a
// real expiry (15 minutes idle, 10 for a handshake-only room) clears the room and its storage. What is stored is what
// the relay was given: TAP-26 / TAP-27 ciphertext, the room name, indices and timestamps. No source (IP address or
// paying consumer) is ever written to storage.
// 帧写进对象的 Durable Object 存储（FIXED RELAY-1）。空闲对象几秒到十几秒内就会被 Cloudflare 回收，2026-09-29 之前帧随之
// 消失：设计 15 分钟的房间实际只活十几秒，邀请、群纪元消息以及发给当时不在轮询的对端的一切都丢了。现在对象重建时恢复房间——
// 纪元、序号、两个环都不变——客户端游标照常可用；只有真正过期（闲置 15 分钟，仅握手房间 10 分钟）才清除房间及其存储。
// 存的就是中继收到的东西：TAP-26 / TAP-27 密文、房间名、序号与时间戳。来源（IP 地址或付费消费者）从不写入存储。
//
// Storage layout, one object = one room: `m` holds { room, epoch, next, touched, handshakeOnly }, and every frame has a
// key of its own, `f:<i>` -> the base64 frame (a room holds up to 256 + 64 frames of ~22 KB, far past one value's
// limit). A frame and `m` are written in one put, and a frame a full ring shifts out is deleted in the same turn; the
// answer to relaySend leaves only after the write. Which ring a frame belongs to follows from its wire type, as in send.
// `touched` from reads is written at most once a minute, so a room that is only polled may, after an eviction, expire
// up to a minute early. Not stored, on purpose: the long-poll waiters (open requests of this instance, which cannot
// outlive it, and an object is not evicted while one is open) and the per-source budget for 0x03 / 0x04 (keeping it
// would put IP addresses at rest; an eviction resets it only after the object has been idle, which a flooder does not
// choose, and the per-IP new-room and request limits still apply).
// 存储布局，一个对象就是一个房间：`m` 存 { room, epoch, next, touched, handshakeOnly }，每帧单独一个键 `f:<i>` -> base64 帧
// （一个房间最多 256 + 64 帧、每帧约 22 KB，远超单值上限）。一帧与 `m` 在同一次 put 里写入，满环移出的帧在同一轮删除；
// relaySend 的回答在写入之后才发出。帧属于哪个环由线路类型决定，与 send 一致。读取带来的 `touched` 至多每分钟写一次，因此只被
// 轮询的房间在对象回收后最多提早一分钟过期。刻意不存：长轮询等待者（本实例上打开的请求，活不过实例；有请求打开时对象也不会被
// 回收）与 0x03 / 0x04 的按来源额度（存下来就等于把 IP 地址落盘；回收只发生在对象闲置之后，不由刷量者决定，按 IP 的新建房间
// 与请求限额照样有效）。
//
// Expiry runs on a Durable Object alarm (arch A2). A live object is not evicted while traffic keeps it warm, so
// without one an expired room -- and its frames -- stayed in memory as long as anyone kept polling it. The alarm is
// armed by a post and re-armed only while the room still holds something; an empty object sets none and goes idle.
// Alarms are kept in storage, so one still fires after an eviction: the object is recreated, restores the room, and
// the sweep clears it and its storage once it has expired.
// 过期由 Durable Object 的 alarm 驱动（arch A2）。有流量的对象不会被回收，没有 alarm 时，过期房间及其帧会一直留在内存里，
// 只要有人还在轮询。alarm 由投递设置，仅在房间里还有东西时重设；空对象不设 alarm，就此闲置。alarm 保存在存储里，对象被回收后
// 照样触发：对象重建、恢复房间，房间过期后由清理连同存储一起清除。
import { createRelayCore } from '../relay-service/relay-core.mjs'

export const SWEEP_MS = 5 * 60 * 1000

// Local smoke tests only (smoke-local.mjs): RELAY_SWEEP_MS shortens the alarm interval and RELAY_ROOM_TTL_MS the
// room lifetime, so a sweep can be watched in seconds. Unset in production: a TTL below 600 s would drop an accept
// before the invite it answers has expired (traceability D22).
// 仅供本地冒烟测试（smoke-local.mjs）：RELAY_SWEEP_MS 缩短 alarm 间隔，RELAY_ROOM_TTL_MS 缩短房间寿命，几秒内就能看到清理。
// 生产环境不要设置：TTL 低于 600 秒会在邀请过期前就丢掉对它的 accept（traceability D22）。
// At most a day: a mis-set huge value would otherwise make every setAlarm an Invalid Date and every post fail (review R2).
// 至多一天：误设的超大值会让 setAlarm 得到无效日期，每次投递都失败。
const positive = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 86_400_000 ? n : undefined }

// `touched` written by a read at most this often / 读取带来的 `touched` 至多这么久写一次
export const TOUCH_WRITE_MS = 60_000

export class RelayRoom {
  constructor(state, env) {
    this.state = state
    const storage = state?.storage
    // The older test stand-ins have no storage, or alarms only: such an object keeps its room in memory, as before.
    // 较早的测试替身没有 storage 或只有 alarm：这样的对象照旧把房间放在内存里。
    this.storage = ['get', 'put', 'delete', 'list', 'deleteAll'].every((k) => typeof storage?.[k] === 'function') ? storage : null
    this.sweepMs = positive(env?.RELAY_SWEEP_MS) ?? SWEEP_MS
    this.pending = []
    this.savedTouched = 0
    this.core = createRelayCore({ maxRooms: 1, roomTtlMs: positive(env?.RELAY_ROOM_TTL_MS), onChange: this.storage ? (ev) => this.record(ev) : null })
    this.armed = false
    // Nothing is served until the room is back. / 房间恢复之前不处理任何请求。
    const restore = () => this.restore()
    this.ready = this.storage ? (typeof state.blockConcurrencyWhile === 'function' ? state.blockConcurrencyWhile(restore) : restore()) : Promise.resolve()
  }
  async restore() {
    const m = await this.storage.get('m')
    if (typeof this.storage.getAlarm === 'function') this.armed = (await this.storage.getAlarm()) != null
    if (!m) return
    const listed = await this.storage.list({ prefix: 'f:' })
    const frames = [...listed].map(([k, frame]) => ({ i: Number(k.slice(2)), frame }))
    let ok = false
    try { ok = this.core.restore(m.room, { ...m, frames }) } catch { ok = false }
    // Expired while evicted, or unreadable: clear it. deleteAll may take the alarm with it, so the next post sets one.
    // 回收期间已过期或无法读取：清掉。deleteAll 可能连 alarm 一起删，所以下一次投递重新设置。
    if (!ok) { await this.storage.deleteAll(); this.armed = false; return }
    this.savedTouched = m.touched
    await this.arm()                                             // a restored room always has an alarm / 恢复的房间一定有 alarm
  }
  // Issued at once, awaited by flush() before the answer leaves. put(object) is one atomic write; a delete issued in the
  // same turn is coalesced with it. / 立即发出，回答发出前由 flush() 等待。put(对象) 是一次原子写入，同一轮发出的删除与它合并。
  record(ev) {
    const s = this.storage
    if (ev.type === 'put') {
      this.savedTouched = ev.meta.touched
      this.pending.push(s.put({ [`f:${ev.frame.i}`]: ev.frame.frame, m: { room: ev.room, ...ev.meta } }))
      if (ev.dropped !== undefined) this.pending.push(s.delete(`f:${ev.dropped}`))
    } else if (ev.type === 'touch') {
      if (ev.meta.touched - this.savedTouched < TOUCH_WRITE_MS) return
      this.savedTouched = ev.meta.touched
      this.pending.push(s.put('m', { room: ev.room, ...ev.meta }))
    } else if (ev.type === 'drop') {
      this.savedTouched = 0
      this.armed = false
      this.pending.push(s.deleteAll())
    }
  }
  async flush() { while (this.pending.length) await Promise.all(this.pending.splice(0)) }
  async arm() {
    const storage = this.state?.storage
    if (this.armed || typeof storage?.setAlarm !== 'function') return
    await storage.setAlarm(Date.now() + this.sweepMs)
    this.armed = true
  }
  async alarm() {
    await this.ready
    this.armed = false
    this.core.sweep()
    await this.flush()
    if (this.core.size || this.core.waiting) await this.arm()
  }
  async fetch(request) {
    await this.ready
    const path = new URL(request.url).pathname
    let body
    try { body = await request.json() } catch { return Response.json({ error: { code: 'BAD_REQUEST', message: 'body must be JSON' } }, { status: 400 }) }
    try {
      if (path === '/send' || path === '/handshake') {
        let out
        try { out = this.core.send(body.room, body.frame, { handshakeOnly: path === '/handshake', source: typeof body.source === 'string' ? body.source : undefined }) } finally { await this.flush() }
        await this.arm()
        return Response.json(out)
      }
      if (path === '/recv') {
        let out
        try { out = await this.core.recv(body.room, body.after ?? -1, body.waitMs ?? 0, body.epoch) } finally { await this.flush() }
        return Response.json(out)
      }
      return Response.json({ error: { code: 'NOT_FOUND', message: 'no such room operation' } }, { status: 404 })
    } catch (e) {
      return Response.json({ error: { code: e.code || 'INTERNAL', message: e.message } }, { status: e.code === 'BAD_REQUEST' ? 400 : 503 })
    }
  }
}
