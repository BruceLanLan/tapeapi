// relay.tape on Cloudflare Workers: the TapeAPI face (identity, signed answers, metering, rate limiting) runs in
// the Worker; each room is a Durable Object, so every isolate sees the same room.
// Cloudflare Workers 上的 relay.tape：TapeAPI 那一面（身份、签名回答、计费、限流）跑在 Worker 里；
// 每个房间是一个 Durable Object，所有隔离实例看到的是同一个房间。
import { createProvider } from '@tapeapi/server'
import { relayManifestMethods, sourceOf } from '../relay-service/relay-core.mjs'
import { d1Store } from './d1-store.js'
export { RelayRoom } from './relay-room.js'

const ROOM_RE = /^[0-9a-f]{64}$/
// 2-of-3: one node down, rate limiting or refusing a method still leaves a quorum (arch A5).
// 三取二：一个节点宕机、限流或拒绝某方法时仍有法定数。
const DEFAULT_RPC_URLS = 'https://bsc-rpc.publicnode.com,https://bsc-dataseed.bnbchain.org,https://bsc-dataseed1.defibit.io'
let provider = null

// New rooms per client IP per minute (arch A2). Every new room name is a new Durable Object, so without this one
// address can mint objects as fast as it can post. The count lives in the ISOLATE: an address spread over many
// isolates gets this budget in each, and an isolate restart forgets it. A global budget needs shared state (a
// Durable Object keyed by IP, or Cloudflare's rate-limiting binding); this one only takes the cheap flood off.
// A post to a room this isolate has already seen is never refused by it. A relayRecv creates no room (relay-core)
// but does wake the object for its name; the provider's per-IP limiter is what bounds that.
// 每个客户端 IP 每分钟可新建的房间数（arch A2）。每个新房间名就是一个新的 Durable Object，没有这一层，一个地址投递多快就能
// 造出多少对象。计数在**隔离实例**里：分散到多个实例的地址在每个实例各得一份额度，实例重启即清零。全局额度需要共享状态
// （按 IP 分的 Durable Object，或 Cloudflare 的限流绑定）；这里只挡掉廉价的洪水。relayRecv 不建房间，但会唤醒该名字的对象，
// 那由运行时的按 IP 限流约束。向本实例已见过的房间投递不受此限。
function roomBudget(perMinute, max = 50_000) {
  const seen = new Map()     // ip -> { n, reset }
  const known = new Set()    // rooms this isolate has posted to / 本实例投递过的房间
  return {
    check(ip, room) {
      const b = seen.get(ip)
      if (perMinute && !known.has(room) && b && Date.now() < b.reset && b.n >= perMinute) throw Object.assign(new Error(`too many new rooms from this address; retry in ${Math.ceil((b.reset - Date.now()) / 1000)} s`), { code: 'BAD_REQUEST' })
    },
    count(ip, room, created) {
      known.delete(room); known.add(room)
      while (known.size > max) known.delete(known.values().next().value)
      if (!created) return
      let b = seen.get(ip)
      if (!b || Date.now() >= b.reset) { b = { n: 0, reset: Date.now() + 60_000 }; seen.delete(ip); seen.set(ip, b) }
      b.n++
      while (seen.size > max) seen.delete(seen.keys().next().value)
    },
  }
}

async function forward(env, room, path, body) {
  if (typeof room !== 'string' || !ROOM_RE.test(room)) throw Object.assign(new Error('room must be 32 bytes of lowercase hex'), { code: 'BAD_REQUEST' })
  const stub = env.ROOMS.get(env.ROOMS.idFromName(room))
  const res = await stub.fetch(`https://room${path}`, { method: 'POST', body: JSON.stringify(body) })
  const j = await res.json()
  if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code === 'BAD_REQUEST' ? 'BAD_REQUEST' : 'INTERNAL' })
  return j
}

export function buildRelay(env) {
  const price = env.RELAY_PRICE_BEM || '0'
  // A priced relay meters in D1 (arch A1). In isolate memory every isolate keeps its own meter, so one voucher is
  // served once per isolate, and a recycled isolate forgets what it has not settled.
  // 收费中继在 D1 里计量（arch A1）。放在隔离实例内存里，每个实例各有一份计量，一张凭证每个实例各服务一次，
  // 实例被回收时还没结算的也随之遗忘。
  if (price !== '0' && !env.DB) throw new Error('a priced relay needs the D1 binding DB for its meter (see wrangler-relay.toml and d1-store.js)')
  const newRooms = roomBudget(Number(env.RATE_NEW_ROOMS ?? 60))
  const post = async (room, path, body, ctx) => {
    const ip = ctx?.clientIp || 'unknown'
    newRooms.check(ip, room)                             // before idFromName / 在 idFromName 之前
    const out = await forward(env, room, path, { ...body, source: sourceOf(ctx) })
    newRooms.count(ip, room, out.i === 0)                // index 0: this post created the room / 序号 0：本次投递建了房间
    return out
  }
  const manifest = {
    tapeapi: '0.1', name: env.SERVICE_NAME || 'relay.tape',
    circuits: env.CIRCUITS, tokenId: String(env.TOKEN_ID), container: env.CONTAINER, signer: env.SIGNER_ADDRESS,
    delegation: { expires: Number(env.DELEGATION_EXPIRES), sig: env.DELEGATION_SIG },
    endpoints: { live: [`${env.PUBLIC_URL.replace(/\/+$/, '')}/tapeapi/v1`], async: false },
    methods: relayManifestMethods({ priceBEM: price }),
    ...(price !== '0' && env.ESCROW ? { payment: { escrow: env.ESCROW, unit: 'BEM', decimals: 8 } } : {}),
  }
  return createProvider({
    manifest, signerKey: env.SIGNER_KEY,
    rpcUrls: (env.RPC_URLS || DEFAULT_RPC_URLS).split(','),
    quorum: 2, chainId: 56,
    store: env.DB ? d1Store(env.DB) : undefined,
    rateLimit: { windowMs: 60_000, free: Number(env.RATE_FREE || 600), paid: Number(env.RATE_PAID || 6000) },
    methods: {
      relaySend: async ({ room, frame }, ctx) => post(room, '/send', { room, frame }, ctx),
      relayHandshake: async ({ room, frame }, ctx) => post(room, '/handshake', { room, frame }, ctx),
      relayRecv: async ({ room, after = -1, waitMs = 0, epoch }) => forward(env, room, '/recv', { room, after, waitMs, ...(epoch !== undefined ? { epoch } : {}) }),
    },
  })
}

export default {
  async fetch(request, env) {
    if (!provider) provider = buildRelay(env)
    return provider.handleRequest(request, { clientIp: request.headers.get('cf-connecting-ip') })
  },
}
