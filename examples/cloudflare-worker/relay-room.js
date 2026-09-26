// One relay room per Durable Object. Worker isolates do not share memory, so a relay whose rooms lived in the
// isolate would split one room into several, and a frame posted through one isolate would never reach a peer
// polling through another. A Durable Object is a single instance per name, globally: every isolate that asks for
// room R talks to the same object, which is exactly the property a room needs.
// 每个中继房间一个 Durable Object。Worker 隔离实例之间不共享内存，房间若放在隔离实例里，一个房间会被拆成好几份，
// 经由一个实例发出的帧，永远到不了经由另一个实例轮询的对端。Durable Object 按名字全局唯一：所有问房间 R 的实例
// 都在和同一个对象说话，这正是房间需要的性质。
//
// Frames live in memory only. If Cloudflare evicts an idle object, its frames go with it; TAP-26 receivers see the
// gap and the sequence check keeps the channel honest. A relay is a pipe, not storage.
// 帧只在内存里。空闲对象被回收时帧随之消失；TAP-26 的接收方会看到空洞，序号检查保证通道依然可信。中继是管道，不是存储。
//
// Expiry runs on a Durable Object alarm (arch A2). A live object is not evicted while traffic keeps it warm, so
// without one an expired room -- and its frames -- stayed in memory as long as anyone kept polling it. The alarm is
// armed by a post and re-armed only while the room still holds something; an empty object sets none and goes idle.
// 过期由 Durable Object 的 alarm 驱动（arch A2）。有流量的对象不会被回收，没有 alarm 时，过期房间及其帧会一直留在内存里，
// 只要有人还在轮询。alarm 由投递设置，仅在房间里还有东西时重设；空对象不设 alarm，就此闲置。
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

export class RelayRoom {
  constructor(state, env) {
    this.state = state
    this.sweepMs = positive(env?.RELAY_SWEEP_MS) ?? SWEEP_MS
    this.core = createRelayCore({ maxRooms: 1, roomTtlMs: positive(env?.RELAY_ROOM_TTL_MS) })
    this.armed = false
  }
  async arm() {
    const storage = this.state?.storage
    if (this.armed || typeof storage?.setAlarm !== 'function') return
    await storage.setAlarm(Date.now() + this.sweepMs)
    this.armed = true
  }
  async alarm() {
    this.armed = false
    this.core.sweep()
    if (this.core.size || this.core.waiting) await this.arm()
  }
  async fetch(request) {
    const path = new URL(request.url).pathname
    let body
    try { body = await request.json() } catch { return Response.json({ error: { code: 'BAD_REQUEST', message: 'body must be JSON' } }, { status: 400 }) }
    try {
      if (path === '/send' || path === '/handshake') {
        const out = this.core.send(body.room, body.frame, { handshakeOnly: path === '/handshake', source: typeof body.source === 'string' ? body.source : undefined })
        await this.arm()
        return Response.json(out)
      }
      if (path === '/recv') return Response.json(await this.core.recv(body.room, body.after ?? -1, body.waitMs ?? 0, body.epoch))
      return Response.json({ error: { code: 'NOT_FOUND', message: 'no such room operation' } }, { status: 404 })
    } catch (e) {
      return Response.json({ error: { code: e.code || 'INTERNAL', message: e.message } }, { status: e.code === 'BAD_REQUEST' ? 400 : 503 })
    }
  }
}
