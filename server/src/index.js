// @tapeapi/server：Provider 运行时 / Provider runtime: manifest, health, paid+free method dispatch, signed envelopes.
import { createRpc, TapeAPIError, validateManifest, safeParseJSON, canonicalJSON, parseUnits, METHOD_NAME_RE, abi, sig } from '@tapeapi/sdk'

const { encodeCall, decodeReturn, isAddress, eqAddr, checksumAddress } = abi
const { voucherDigest, recoverAddress, signResponse, privateKeyToAddress } = sig
// A literal, not a package.json read: `createRequire` is a node:module import, and importing it at module scope
// would stop this runtime loading on Cloudflare Workers, Deno or a browser. A test asserts the two agree.
// 写成字面量而不是读 package.json：`createRequire` 属于 node:module，在模块顶层导入会让这套运行时无法在
// Cloudflare Workers、Deno 或浏览器里加载。有测试断言两者一致。
export const VERSION = '1.0.0-rc.2'
const now = () => Math.floor(Date.now() / 1000)
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// 默认内存 store / Default in-memory voucher store.
export function memoryStore() {
  const m = new Map()
  const k = (c, p) => `${c.toLowerCase()}:${p.toLowerCase()}`
  return {
    async get(c, p) { return m.get(k(c, p)) || null },
    async set(c, p, rec) { m.set(k(c, p), rec) },
    async all() { return [...m.values()] },
    // Atomic monotonic write-back: store `rec` only if it moves the counter up, and say whether it did.
    // Read-then-write is not good enough -- it is the classic lost update, and across two processes it is also
    // how one voucher gets served twice (x402's "248 grants from one payment"). A store that spans instances
    // MUST implement this as one statement, e.g. SQL `UPDATE ... WHERE cumulative < ?`.
    // 原子单调写回：仅当推高了计数器才写入，并返回是否推高。读后写不够用——那是经典的丢失更新，
    // 跨进程时还正是"一张凭证被服务两次"的成因。跨实例的 store MUST 用单条语句实现，例如 SQL 的条件更新。
    async advance(c, p, rec) {
      const key = k(c, p)
      const cur = m.get(key)
      if (cur && BigInt(cur.cumulative) >= BigInt(rec.cumulative)) return false
      m.set(key, rec)
      return true
    },
  }
}

// createProvider 的选项 / createProvider options:
//   manifest, signerKey, methods   必填三件套；methods 必须为清单里每个方法提供一个处理函数
//                                  the required trio; `methods` needs one handler per manifest method
//   rpcUrls, quorum, timeoutMs, fetch, allowSingleNode   链读（无 rpcUrls 则不读链，收费方法无法校验凭证）
//                                  chain reads; without rpcUrls there are none, and vouchers cannot be checked
//   dev / allowHttp                接受 http:// 端点（仅开发）/ accept http:// endpoints (development only)
//   escrow, chainId                覆盖清单里的托管合约与链 / override the manifest's escrow and chain
//   store                          凭证存储，默认进程内存 / voucher store, in-process memory by default
//   allowMemoryStore, warn         非 dev 的收费服务用默认内存 store 时会 console.warn（或 warn）；allowMemoryStore: true 表示有意为之
//                                  a non-dev priced service on the default in-memory store console.warns (or calls
//                                  `warn`); allowMemoryStore: true says you meant it (arch A1)
//   log, bodyLimit
//   escrowCacheMs, sessionCacheMs, blockCacheMs, contributionCacheMs, cacheMax   链读缓存 / chain-read caches
//   withdrawCloseS                 提现请求可执行窗口的关闭时间，默认 9d = WITHDRAW_COOLDOWN (48h) + WITHDRAW_WINDOW (7d)；
//                                  只有把这两个常量设成别的值的托管合约才需要覆盖它。
//                                  When a withdraw request stops being executable; only an escrow deployed with
//                                  different constants needs to override the 9-day default.
export function createProvider(opts = {}) {
  // 1.0 (review G1 S4): as in createTapeAPI, the RPC timeout is `rpcTimeoutMs` (beside handlerTimeoutMs, requestTimeoutMs,
  // headersTimeoutMs). / 与 createTapeAPI 一致，RPC 超时叫 rpcTimeoutMs。
  if (Object.prototype.hasOwnProperty.call(opts, 'timeoutMs')) throw new TapeAPIError('INVALID_ARGUMENT', 'the option `timeoutMs` of createProvider was renamed `rpcTimeoutMs` in 1.0 (the timeout of one RPC request): see docs/guides/upgrade-1.0.md')
  const { signerKey, methods = {}, rpcUrls = [], quorum = 2, fetch: fetchImpl, rpcTimeoutMs: timeoutMs } = opts
  if (!signerKey) throw new TapeAPIError('INVALID_ARGUMENT', 'signerKey required')
  const manifest = opts.manifest // 保留引用，方便调用方后续补 endpoints / keep the reference (caller may patch endpoints later)
  // 1.0 (review G1 S2): `dev` alone relaxes the payment checks (priced methods without an escrow, the in-memory meter
  // warning); `allowHttp` only allows http endpoints (dev implies it). A manifest's own `dev` field switches nothing:
  // it is published data, not configuration. / `dev` 只由 opts.dev 决定；allowHttp 只管 http；清单里的 dev 字段不再起作用。
  const devMode = opts.dev === true
  const allowHttp = devMode || opts.allowHttp === true
  const normalized = validateManifest(manifest, { requireDelegation: false, allowHttp })
  // An already-expired delegation serves responses that every consumer rejects. Refuse to boot rather than
  // look healthy for hours. The consumer side keeps its own, more precise DELEGATION_INVALID.
  // 已过期的委托会一直发出所有消费者都拒绝的响应。宁可拒绝启动，也不要看起来健康地空转几小时。
  // （冷启动测试 2026-09-21 发现）
  if (manifest?.delegation && Number.isInteger(manifest.delegation.expires) && manifest.delegation.expires <= Math.floor(Date.now() / 1000)) {
    throw new TapeAPIError('DELEGATION_INVALID', `manifest.delegation.expires ${manifest.delegation.expires} is in the past; re-sign the delegation before serving`)
  }
  // ...and the same once it lapses WHILE serving (arch A3): a process that booted in time kept signing answers every
  // consumer rejects. Read live from the manifest, which the operator may re-sign in place. Nothing is signed after
  // it: the refusal is an unsigned 503 DELEGATION_INVALID, the code a consumer would give.
  // ……运行中过期也一样（arch A3）：按时启动的进程此前会继续签发所有消费者都拒绝的回答。每次都从清单现读，运营者可以就地重签。
  // 过期后什么都不签：拒绝是未签名的 503 DELEGATION_INVALID，与消费者给出的错误码相同。
  const delegationExpires = () => (Number.isInteger(manifest?.delegation?.expires) ? manifest.delegation.expires : null)
  const delegationLapsed = () => { const x = delegationExpires(); return x != null && x <= now() }
  const lapsedError = () => ({ ok: false, error: { code: 'DELEGATION_INVALID', message: `this provider's delegation expired at ${delegationExpires()}; the holder must re-sign it`, data: { delegationExpires: delegationExpires() } } })
  const signerAddr = privateKeyToAddress(signerKey)
  if (!eqAddr(signerAddr, manifest.signer)) throw new TapeAPIError('BAD_KEY', `signerKey derives ${signerAddr} but manifest.signer is ${manifest.signer}`)
  const chainId = opts.chainId ?? 56
  // Consumers sign vouchers against the escrow the MANIFEST names (it is the EIP-712 verifyingContract), so an
  // override may only restate it. A different one would verify no voucher, and a zero one would dodge the
  // zero-escrow refusal above (runtime audit I-03).
  // 消费者按清单里的托管签凭证（EIP-712 verifyingContract），覆盖值只能与之相同；不同的验不过任何凭证，零地址会绕过上面的拒绝。
  if (opts.escrow != null) {
    if (!isAddress(opts.escrow)) throw new TapeAPIError('INVALID_ARGUMENT', `opts.escrow ${opts.escrow} is not an address`)
    if (normalized.payment.escrow && !eqAddr(opts.escrow, normalized.payment.escrow)) {
      throw new TapeAPIError('INVALID_ARGUMENT', `opts.escrow ${opts.escrow} differs from manifest payment.escrow ${normalized.payment.escrow}; consumers sign against the manifest's`)
    }
  }
  const escrow = opts.escrow ?? normalized.payment.escrow
  const anyPriced = normalized.methods.some((x) => x.priceBEM !== '0')
  const hasEscrow = escrow != null && !eqAddr(escrow, '0x0000000000000000000000000000000000000000')
  if (anyPriced && !hasEscrow && !devMode) throw new TapeAPIError('MANIFEST_INVALID', 'priced methods need a real escrow (payment.escrow or opts.escrow), or createProvider({ dev: true }) for local testing')
  const container = checksumAddress(manifest.container)
  const store = opts.store || memoryStore()
  const rpc = rpcUrls.length ? createRpc({ urls: rpcUrls, quorum, timeoutMs, fetch: fetchImpl, allowSingleNode: opts.allowSingleNode === true }) : null
  const bodyLimit = opts.bodyLimit ?? 64 * 1024
  const hardBodyCap = Math.max(bodyLimit * 64, 4 * 1024 * 1024)
  // TAP-21 §3.2: providers MUST cap the response body at 1 MiB and SHOULD answer within 30 s.
  // TAP-21 §3.2：响应体 MUST 不超过 1 MiB，SHOULD 在 30 秒内作答。
  const RESPONSE_LIMIT = 1024 * 1024
  const handlerTimeoutMs = Number(opts.handlerTimeoutMs ?? 25_000)   // drained and refused below this, cut off above it / 此值以下读完再拒，以上直接断开
  const escrowCacheMs = opts.escrowCacheMs ?? 30_000
  const sessionCacheMs = opts.sessionCacheMs ?? 60_000
  const blockCacheMs = opts.blockCacheMs ?? 3_000
  // A2-02: vouchers and session keys are dated by the consumer. Anything that dies before this provider can
  // mine a settlement is free service. Both deadlines must have at least this much life left at verification;
  // the operator's settler cadence MUST be shorter than this value (see pendingSettlements / settleTx).
  // A2-02：凭证与会话密钥的期限都由消费者选。在本提供者来得及上链结算前就失效的，等于白干。
  // 两个期限在校验时都必须至少还剩这么久；运营方的结算频率 MUST 短于此值。
  const minVoucherLifeS = Number(opts.minVoucherLifeS ?? 300)
  // Rate limiting. Free methods carry no identity and no cost, so without this a provider's free tier is an
  // open invitation: one laptop saturates it. Paid calls carry the consumer address, which is a far better key
  // than an IP, so they get their own, higher budget. 0 on either disables that half.
  // 限流。免费方法既没有身份也没有成本，没有这一层，提供者的免费层就是敞开的：一台笔记本就能打满。
  // 付费调用带着消费者地址，这个键比 IP 好得多，因此单独给一份更高的预算。任一项为 0 即关闭该半边。
  const rl = opts.rateLimit === false ? null : {
    windowMs: Number(opts.rateLimit?.windowMs ?? 60_000),
    free: Number(opts.rateLimit?.free ?? 600),
    paid: Number(opts.rateLimit?.paid ?? 6000),
    max: Number(opts.rateLimit?.max ?? 50_000),
  }
  // A per-IP flood ceiling applied before the body is read. It must sit above free + paid, or one consumer making
  // its paid calls and a few free ones would be refused by its own IP; several consumers behind one NAT share it.
  // 在读 body 之前按 IP 生效的洪水上限。它必须高于免费加付费，否则一个消费者在付费调用之外再发几个免费请求，
  // 就会被自己的 IP 拒绝；同一 NAT 后面的多个消费者共享这个上限。
  if (rl) rl.ip = Number(opts.rateLimit?.ip ?? rl.free + rl.paid)
  // Numbers, validated at boot: a negative budget would refuse everything and NaN would silently switch a half off.
  // 0 is allowed and means "this half is off". / 启动时校验：负数会拒绝一切，NaN 会悄悄关掉某一半；0 表示关闭该半边。
  if (rl) {
    for (const k of ['free', 'paid', 'ip', 'max']) if (!Number.isInteger(rl[k]) || rl[k] < 0) throw new TapeAPIError('INVALID_ARGUMENT', `rateLimit.${k} must be a non-negative integer`)
    if (!Number.isInteger(rl.windowMs) || rl.windowMs <= 0) throw new TapeAPIError('INVALID_ARGUMENT', 'rateLimit.windowMs must be a positive integer')
  }
  // Which header identifies the caller when the process sits behind a proxy. UNSET BY DEFAULT: trusting a
  // client-settable header without a trusted proxy in front turns the limiter into a no-op, since the attacker
  // picks its own key. Set it to 'cf-connecting-ip' behind Cloudflare, 'x-forwarded-for' behind exactly ONE proxy of
  // your own. For a list-valued header the LAST entry is used -- the one your proxy appended; the leftmost is
  // whatever the client wrote (runtime audit F-03).
  // 进程位于代理之后时用哪个头识别调用方。默认不设。Cloudflare 后面设 'cf-connecting-ip'，恰好一层自建代理后面设
  // 'x-forwarded-for'。列表形式的头取**最后**一项，即你的代理追加的那一项；最左边那项是客户端自己写的。
  const clientIpHeader = typeof opts.clientIpHeader === 'string' ? opts.clientIpHeader.toLowerCase() : null
  const lastHop = (v) => { const parts = String(v || '').split(',').map((x) => x.trim()).filter(Boolean); return parts.length ? parts[parts.length - 1] : '' }
  const FAIL_BUDGET = 20   // failed paid attempts per window before an IP out of free budget is refused up front / 每窗口失败的付费尝试次数上限
  if (!Number.isInteger(minVoucherLifeS) || minVoucherLifeS < 0) throw new TapeAPIError('INVALID_ARGUMENT', 'minVoucherLifeS must be a non-negative integer')
  const contributionCacheMs = opts.contributionCacheMs ?? 60_000
  const cacheMax = opts.cacheMax ?? 10_000
  const log = opts.log || (() => {})
  // Boot warnings the operator should see before a consumer does / 运营者应当先于消费者看到的启动警告
  if (anyPriced && !hasEscrow) log('dev manifest with priced methods and no escrow: paid calls are refused with INTERNAL until ESCROW is set (or run with FREE_ALL=1)')
  const delegationLeft = Number.isInteger(manifest?.delegation?.expires) ? manifest.delegation.expires - Math.floor(Date.now() / 1000) : null
  if (delegationLeft != null && delegationLeft < 7 * 86400) log(`delegation expires in ${Math.floor(delegationLeft / 3600)} h; every response is rejected after that, re-sign it soon`)
  // Without an atomic `advance`, two processes behind one URL lose meter updates to each other and can serve the
  // same voucher twice. That is a revenue loss for the provider, not a fund-safety problem for the consumer, but
  // it must not be silent: say it at boot and report it in stats().
  // 没有原子的 `advance`，同一个 URL 后面的两个进程会互相丢失计量更新，并可能把同一张凭证服务两次。
  // 那是提供者的收入损失，不是消费者的资金安全问题，但不能悄无声息：启动时说明，并在 stats() 里报告。
  const singleInstance = typeof store.advance !== 'function'
  if (singleInstance) log('store has no advance(): run ONE instance of this provider, or supply a store whose advance() is atomic')
  // A priced, non-dev service on the default meter (arch A1): unsettled vouchers die with the process, and every
  // instance or isolate behind the URL keeps its own meter and serves the same voucher again. Said out loud, not
  // through `log` (which is silent by default).
  // 非 dev 的收费服务用默认计量（arch A1）：未结算凭证随进程消失，URL 后面的每个实例或隔离实例各有一份计量，
  // 会把同一张凭证再服务一次。直接说出来，而不是经由默认静默的 `log`。
  if (anyPriced && !opts.store && !devMode && opts.allowMemoryStore !== true) {
    (opts.warn || ((...a) => console.warn('[tapeapi/server]', ...a)))('priced methods on the in-memory meter: unsettled vouchers are lost on restart, and each instance behind this URL serves the same voucher again. Pass a persistent store with an atomic advance() (e.g. D1), or allowMemoryStore: true if you mean it')
  }

  // 只接受 methods 的自有属性，拒绝原型链上的 constructor/toString 等（L-20 / M-08）/ own properties only
  if (!isPlainObject(methods)) throw new TapeAPIError('INVALID_ARGUMENT', 'methods must be an object')
  for (const m of normalized.methods) {
    if (!METHOD_NAME_RE.test(m.name) || !hasOwn(methods, m.name) || typeof methods[m.name] !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', `no handler for manifest method ${m.name}`)
  }
  const methodDef = (name) => (typeof name === 'string' && METHOD_NAME_RE.test(name) && hasOwn(methods, name)) ? (normalized.methods.find(m => m.name === name) || null) : null

  // ---- 链读带缓存 / cached chain reads ----
  const needRpc = () => { if (!rpc) throw new TapeAPIError('INTERNAL', 'rpcUrls not configured'); return rpc }
  async function view(to, name, args) { return decodeReturn(name, await needRpc().ethCall(to, encodeCall(name, args))) }
  const cache = new Map()
  function sweep() { // 过期淘汰，避免随 consumer 数无限增长（M-14）/ evict expired entries so the map cannot grow unbounded
    if (cache.size < cacheMax) return
    const t = Date.now()
    for (const [k, v] of cache) if (v.exp <= t) cache.delete(k)
    if (cache.size >= cacheMax) for (const k of [...cache.keys()].slice(0, cache.size - cacheMax + 1)) cache.delete(k)
  }
  async function cached(key, ttl, fn) {
    const hit = cache.get(key)
    if (hit && hit.exp > Date.now()) return hit.v
    const v = await fn(); sweep(); cache.set(key, { v, exp: Date.now() + ttl }); return v
  }
  let lastBlock = 0
  async function currentBlock() {
    if (!rpc) return 0
    try { lastBlock = await cached('block', blockCacheMs, () => rpc.blockNumber()) } catch (e) { log('block fetch failed', e.message) }
    return lastBlock
  }
  const WITHDRAW_CLOSE_S = BigInt(opts.withdrawCloseS ?? 9 * 86400) // WITHDRAW_COOLDOWN (48h) + WITHDRAW_WINDOW (7d)，见上面的选项说明 / see the options note above
  // 该通道上待执行的提现请求；escrow 无 pendingWithdraw（替代部署）视为无请求 / pending withdraw on this channel; escrows without the view count as none.
  async function pendingWithdrawOf(consumer) {
    try { const [amount, requestedAt] = await view(escrow, 'pendingWithdraw', [consumer, container]); return { amount, requestedAt } }
    catch (e) {
      // A2-04: fail CLOSED. Only a proven "no such function" (the call itself reverted, i.e. an escrow that
      // predates pendingWithdraw) counts as "no request"; a transport / quorum failure must not switch the
      // §3.2(4) `channel − armed` rule off while everything else keeps serving.
      // A2-04：失败即拒绝。只有确证"没有这个函数"（调用本身回滚，即旧版托管）才算"无请求"；
      // 传输或 quorum 失败不能在其它一切照常服务时悄悄关掉 §3.2(4) 的 `channel − armed` 规则。
      if (e instanceof TapeAPIError && e.code === 'RPC_ERROR' && /execution reverted/i.test(e.message)) return { amount: 0n, requestedAt: 0n }
      throw e
    }
  }
  // v2 escrow (TAP-22 §3.2(4)): the (consumer, this container) channel is the cap -- there is no allowance and no
  // shared balance to reason about. An armed withdraw request is subtracted while it is inside its lifetime
  // [requestedAt, requestedAt + 48h + 7d]: inside the cooldown the provider can still settle ahead of it, but
  // once it is executable the requested amount can leave in the same block as our settle (E-03), so serving
  // against it is extending credit with no cover.
  // v2 托管：(消费者, 本容器) 通道即上限——没有额度、没有共享余额。生命周期内的提现请求从可用额中扣除：
  // 冷静期内提供者仍可抢先结算，但一旦可执行，该金额可在结算同一区块离开（E-03），对其提供服务等于无担保赊账。
  const escrowState = (consumer) => cached(`escrow:${consumer.toLowerCase()}`, escrowCacheMs, async () => {
    const [channel, claimed, pending] = await Promise.all([
      view(escrow, 'channelOf', [consumer, container]), view(escrow, 'claimedOf', [consumer, container]),
      pendingWithdrawOf(consumer),
    ])
    const armed = pending.amount > 0n && BigInt(now()) <= pending.requestedAt + WITHDRAW_CLOSE_S ? pending.amount : 0n
    const available = channel > armed ? channel - armed : 0n
    return { channel, claimed, pendingWithdraw: pending, armed, available }
  })
  // sessions are per channel: (consumer, this container, key) / 会话按通道：(消费者, 本容器, 密钥)
  const sessionExpiry = (consumer, key) => cached(`sess:${consumer.toLowerCase()}:${key.toLowerCase()}`, sessionCacheMs, () => view(escrow, 'sessionExpiry', [consumer, container, key]))

  // 本容器在 escrow 上自设的贡献比例（万分比）。无 RPC 或 RPC 不可用 → null；escrow 无此函数（v0.1 部署）→ 0。
  // This container's opt-in contribution (bps) on the escrow. null when unreadable (no RPC / RPC down); 0 when the
  // escrow predates contributionOf (call reverts).
  async function contribution() {
    if (!rpc) return null
    try { return Number(await cached('contribution', contributionCacheMs, () => view(escrow, 'contributionOf', [container]))) }
    catch (e) {
      if (e instanceof TapeAPIError && (e.code === 'RPC_ERROR' || e.code === 'ABI_INVALID')) return 0
      log('contribution read failed', e.message); return null
    }
  }

  // ---- voucher 校验（按 consumer 串行）/ voucher verification, serialised per consumer ----
  const locks = new Map()
  // consumer|provider -> { cumulative, voucher } held by an in-flight call. The voucher is kept so that when the
  // in-flight figure is the highest, the stale answer can still prove it (D16).
  // 在途调用占用的 { 累计额, 凭证 }；保留凭证，使在途数字最高时过期回答仍能给出证明。
  // consumer|provider -> Set of { cumulative, voucher }: EVERY in-flight call, not only the latest. With one slot a
  // failing later call released the slot of a slower earlier one, and the same cumulative could then be served twice
  // (review M-3). / 每个在途调用都登记，而不只是最新的一个；否则失败的后一个调用会释放较慢的前一个调用的占位。
  const reserved = new Map()
  const heldOf = (key) => { let top = null; for (const r of reserved.get(key) ?? []) if (!top || r.cumulative > top.cumulative) top = r; return top }
  function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => {}).then(() => { if (locks.get(key) === tail) locks.delete(key) }) // 链空即清理 / drop idle locks
    locks.set(key, tail)
    return next
  }
  async function verifyVoucher(v, price) {
    // TAP-22 §3.2: every BAD_VOUCHER carries data.price, so a consumer holding a stale manifest can always tell,
    // whatever else was wrong with the voucher. / 每个 BAD_VOUCHER 都带 data.price，持旧清单的消费者总能察觉。
    const bad = (msg, extra) => { throw new TapeAPIError('BAD_VOUCHER', msg, { ...extra, data: { ...(extra?.data || {}), price: price.toString() } }) }
    if (!isPlainObject(v)) bad('voucher missing')
    if (!isAddress(v.consumer) || !isAddress(v.provider)) bad('voucher.consumer/provider must be addresses')
    if (!eqAddr(v.provider, container)) bad('voucher.provider is not this container')
    if (typeof v.cumulative !== 'string' || !/^\d+$/.test(v.cumulative)) bad('voucher.cumulative must be decimal string')
    // TAP-22 §3.1: valid while now ≤ expires, the same inclusive boundary the escrow uses / 与托管合约同一个包含边界
    if (!Number.isInteger(v.expires) || v.expires < now()) bad('voucher expired')
    if (v.expires - now() < minVoucherLifeS) bad(`voucher expires in ${v.expires - now()} s; this provider needs at least ${minVoucherLifeS} s to settle`, { data: { minVoucherLifeS } })
    const cumulative = BigInt(v.cumulative)
    let recovered
    // recoverAddress 与合约 ECDSA.recover 一致：高 s / 坏 v 直接拒绝（C-02）/ low-s and v ∈ {27,28} enforced (review C-02)
    if (!hasEscrow) throw new TapeAPIError('INTERNAL', 'this provider has no escrow configured, so it cannot take payment; the operator must set ESCROW')
    try { recovered = recoverAddress(voucherDigest(chainId, escrow, v), v.sig) } catch (e) { bad(`bad voucher signature: ${e.message}`) }
    if (v.signer && !eqAddr(v.signer, recovered)) bad('voucher.signer does not match signature')
    if (!eqAddr(recovered, v.consumer)) {
      // H-01: the session must be live NOW on THIS channel, which is exactly what `settle` checks; it need not
      // outlive the voucher. v2 has no revoke: a key is bounded by one channel and lapses by itself.
      // H-01：会话须在此刻、在**本通道**上有效，与合约 `settle` 判据一致；无需覆盖凭证寿命。v2 没有撤销。
      const exp = BigInt(await sessionExpiry(v.consumer, recovered))
      if (exp < BigInt(now())) bad(`session key ${recovered} not authorised or expired`)
      if (exp - BigInt(now()) < BigInt(minVoucherLifeS)) bad(`session key ${recovered} lapses in ${exp - BigInt(now())} s; this provider needs at least ${minVoucherLifeS} s to settle`, { data: { minVoucherLifeS } })
    }
    const key = `${v.consumer.toLowerCase()}|${container.toLowerCase()}`
    return withLock(v.consumer.toLowerCase(), async () => {
      const { channel, claimed, armed, available } = await escrowState(v.consumer)
      // An in-flight call has already claimed its slice of the meter but is not billed yet; count it so two
      // concurrent calls cannot both spend the same cumulative.
      // 在途调用已占用计量但尚未计费；一并计入，避免两个并发调用花同一个 cumulative。
      // Reservation FIRST, then the store, both after the escrow read: a call commits (store.advance, outside this lock)
      // and only then drops its reservation, so whichever of the two we miss, the other shows it. Reading the store
      // before the escrow read let a call that committed and cleared during that read be missed twice, and the same
      // cumulative was served twice (found 2026-09-29 when batched RPC reads made the escrow read yield longer).
      // 先读在途预留、再读 store，且都在读托管之后：调用先提交（store.advance，在锁外）再撤预留，所以两者至少能看到一个。
      // 以前在读托管之前读 store，读托管期间提交并撤预留的调用两边都看不到，同一个 cumulative 被服务两次
      // （2026-09-29 发现：批量 RPC 让读托管的让出时间变长）。
      const inflight = heldOf(key)
      const prev = await store.get(v.consumer, container)
      // E-05: the store may lag the chain (restart, new instance); a voucher at or below claimedOf can never settle.
      // E-05：本地 store 可能落后于链上（重启、扩容）；不高于 claimedOf 的凭证永远无法结算。
      const stored = prev ? BigInt(prev.cumulative) : 0n
      const held = inflight?.cumulative ?? 0n
      let last = stored > claimed ? stored : claimed
      if (held > last) last = held
      // 过期累计：把 lastCumulative 连同**消费者自己签过的那张凭证**一起放进已签名的错误负载。
      // 光给数字是不够的：客户端无法分辨真相与谎言，恶意提供者报一个天文数字就能让对方签出一张
      // 榨干额度的凭证。附上原凭证后，客户端可以用自己的签名验证这个数字确实是它许诺过的。
      // 链上已结算的部分（claimed）无需证据——任何人都能自行读链核对。
      // The stale-cumulative error carries the number AND the consumer's own signed voucher for it.
      // The number alone is not enough: a client cannot tell truth from a lie, and a hostile provider
      // that reports an enormous value would make the client sign a voucher draining its allowance.
      // With the voucher attached the client verifies its own signature over that figure. The
      // on-chain part (claimed) needs no proof: anyone can read it.
      // Whichever figure won -- the stored meter or an in-flight reservation -- is proven by the consumer's voucher
      // for exactly that figure, so a second payer instance racing an in-flight call can still resync (D16).
      // 无论胜出的是已存计量还是在途预留，都用消费者对恰好该数字签的凭证来证明，使与在途调用竞争的第二个付款实例也能重新同步。
      const proof = inflight && held === last && held > claimed ? inflight.voucher
        : prev && BigInt(prev.cumulative) === last ? { cumulative: prev.cumulative, expires: prev.expires, sig: prev.sig }
        : undefined
      // `price` lets a consumer tell a stale PRICE from a stale COUNTER. Without it the two are
      // indistinguishable, and a consumer holding a manifest from before a price rise retries at the old price
      // for ever. The client treats this number as a hint and re-reads the manifest from the chain; it is never
      // authority, so naming a huge price here buys a provider nothing.
      // `price` 让消费者能区分"价格旧了"和"计数器旧了"。没有它两者无法分辨，持有涨价前清单的消费者会一直
      // 按旧价重试。客户端只把这个数字当提示，随后从链上重读清单；它不是权威，所以在这里报一个天价毫无用处。
      const stale = { data: { lastCumulative: last.toString(), onChainClaimed: claimed.toString(), price: price.toString(), ...(proof ? { voucher: proof } : {}) } }
      if (cumulative <= claimed) bad(`cumulative ${cumulative} already settled on-chain (claimed ${claimed})`, stale)
      if (cumulative < last + price) bad(`cumulative ${cumulative} < last ${last} + price ${price}`, stale)
      // TAP-22 §3.2(4): cumulative − claimedOf ≤ channelOf − armed. / 累计额 − 已结算 ≤ 通道余额 − 已上膛的提现。
      if (cumulative - claimed > available) bad(`unsettled ${cumulative - claimed} exceeds the available channel ${available} (channel ${channel}, armed withdraw ${armed})`)
      // Reserve now, bill later: the meter only advances once the method has actually produced a result.
      // Otherwise an upstream 502 would be charged to the consumer.
      // 先预留、后计费：方法真正产出结果后才推进计量；否则上游 502 也会被扣费。
      const mine = { cumulative, voucher: { cumulative: cumulative.toString(), expires: v.expires, sig: v.sig } }
      if (!reserved.has(key)) reserved.set(key, new Set())
      reserved.get(key).add(mine)
      const record = { consumer: checksumAddress(v.consumer), provider: container, cumulative: cumulative.toString(), expires: v.expires, sig: v.sig, signer: recovered, updatedAt: now() }
      const clear = () => { const s = reserved.get(key); if (s) { s.delete(mine); if (!s.size) reserved.delete(key) } }
      return {
        consumer: checksumAddress(v.consumer), signer: recovered, cumulative,
        // 处理方法在锁外执行，两个并发调用可能乱序完成；写回必须重新拿锁并且只许单调上升，
        // 否则慢的小额凭证会覆盖掉快的大额凭证，provider 少收钱（H-06）。
        // Handlers run outside the lock, so two concurrent calls can finish out of order: the write-back retakes the
        // lock and is monotonic, otherwise a slow low-cumulative call overwrites a fast high-cumulative record and
        // the provider silently loses the difference (review H-06).
        commit: async () => {
          try {
            if (typeof store.advance === 'function') {
              await store.advance(v.consumer, container, record)   // one atomic statement; no lock needed / 单条原子语句，无需加锁
            } else {
              await withLock(v.consumer.toLowerCase(), async () => {
                const cur = await store.get(v.consumer, container)
                if (!cur || BigInt(cur.cumulative) < cumulative) await store.set(v.consumer, container, record)
              })
            }
          } finally { clear() }
        },
        release: clear,
      }
    })
  }

  // ---- 信封 / envelopes (TAP-21 v2: digest covers {method, params} and ok) ----
  // TOOLS_CHANGED: an MCP-bound service whose upstream tools no longer match the manifest's toolsSha256 (TAP-20 §3.8).
  // TOOLS_CHANGED：上游工具与清单 toolsSha256 不再相符的 MCP 绑定服务（TAP-20 §3.8）。
  const STATUS = { PAYMENT_REQUIRED: 402, BAD_VOUCHER: 402, METHOD_NOT_FOUND: 404, BAD_REQUEST: 400, INTERNAL: 500, TOOLS_CHANGED: 409 }
  function envelope({ id, method, params }, ok, payload, block) {
    const ts = now()
    const env = ok ? { id, ok: true, result: payload } : { id, ok: false, error: payload }
    Object.assign(env, { container, ts, block })
    env.sig = signResponse({ container, id, method, params, ok, body: payload, ts }, signerKey)
    return env
  }
  function send(res, status, obj) {
    const body = JSON.stringify(obj)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...CORS })
    res.end(body)
  }
  const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,accept', 'access-control-max-age': '86400' }

  // 对外错误：INTERNAL 一律泛化，细节只进日志（M-13）/ outward errors: INTERNAL is always generic, details go to log
  function errorPayload(e) {
    const known = (c) => typeof c === 'string' && hasOwn(STATUS, c)
    const code = known(e?.code) ? e.code : 'INTERNAL'
    if (code === 'INTERNAL') {
      log('internal error', e)
      // A handler may attach the revert bytes of a call it made (TAP-23 §3.3): that is chain state anyone can
      // reproduce, not an upstream detail, so it is the one thing an INTERNAL may carry. Nothing else passes.
      // 处理器可附上它所做调用的 revert 字节（TAP-23 §3.3）：那是人人可复现的链上状态，不是上游细节，是 INTERNAL 唯一可携带的内容。
      const revert = e instanceof TapeAPIError ? e.data?.revert : undefined
      if (typeof revert === 'string' && revert.length <= 2 + 2 * 4096 && /^0x(?:[0-9a-fA-F]{2})*$/.test(revert)) return { code, message: 'execution reverted', data: { revert: revert.toLowerCase() } }
      return { code, message: 'internal error' }
    }
    const out = { code, message: e.message || code }
    if (isPlainObject(e.data)) out.data = e.data
    return out
  }

  const utf8Length = (str) => new TextEncoder().encode(str).length

  // TAP-21 §3.2: what an answer to a parsed request object is signed over. An invalid `id` (missing, not a string,
  // empty, over 128 UTF-16 units) is not trusted, and neither are the params beside it: ("", {}). Params with no
  // canonical form: (id, {}). Otherwise the request's own (id, params). One helper for the normal path and the crash
  // path, so a spec-conformant client verifies every answer (spec review SD-1).
  // TAP-21 §3.2：对已解析请求对象的回答签在什么之上。无效 `id`（缺失、非字符串、空、超过 128 个 UTF-16 单元）不可信，
  // 它旁边的 params 也不可信：("", {})。没有规范形式的 params：(id, {})。否则就是请求自己的 (id, params)。
  // 正常路径与崩溃路径共用一个函数，使按规范实现的客户端能验证每一个回答。
  function bindingOf(body, method) {
    const id = typeof body?.id === 'string' && body.id.length >= 1 && body.id.length <= 128 ? body.id : ''
    let params = id && isPlainObject(body?.params) ? body.params : {}
    let paramsError = null
    try { canonicalJSON({ method, params }) } catch (e) { paramsError = e; params = {} }
    return { req: { id, method, params }, paramsError }
  }

  // 执行一次调用（不含 HTTP）/ Execute one call (transport-agnostic).
  // `ip` is the caller identity the HTTP layer vouches for. A return of { rateLimited: seconds } means "answer with an
  // unsigned 429", never an envelope. / `ip` 由 HTTP 层给出；返回 { rateLimited } 表示回未签名的 429，而不是信封。
  // A return of { status, unsigned } (the delegation lapsed, arch A3) means "answer `unsigned` as it is, unsigned".
  // 返回 { status, unsigned }（委托已过期）表示原样回 `unsigned`，不签名。
  async function invoke(body, { ip = 'unknown', sentMethod } = {}) {
    if (delegationLapsed()) return { status: 503, unsigned: lapsedError(), paid: false }   // arch A3
    const method = typeof body?.method === 'string' ? body.method : ''
    // A request whose params have no canonical form cannot be answered with an envelope bound to them. Check it
    // BEFORE any handler runs, and bind the refusal to empty params (runtime audit F-07). An invalid id binds to
    // ("", {}) (TAP-21 §3.2, SD-1). / 参数没有规范形式的请求，无法用绑定这些参数的信封作答。在任何处理器运行之前
    // 检查，拒绝时绑定空参数。无效 id 绑定 ("", {})。
    const { req, paramsError } = bindingOf(body, method)
    const { id, params } = req
    const block = await currentBlock()
    let lease = null
    let verified = false
    // Unverified work -- a malformed request, an unknown method, a free method, a paid method without a valid
    // voucher -- is paid for out of the IP's free budget. Only a voucher that verifies moves a call to the paid
    // budget (runtime audit F-01). / 未经验证的工作都从该 IP 的免费预算里扣；只有验过的凭证才让调用改走付费预算。
    const spendFree = () => (rl ? rateLimited(`free:${ip}`, rl.free) : 0)
    try {
      if (!id) { const w = spendFree(); if (w) return { rateLimited: w }; throw new TapeAPIError('BAD_REQUEST', 'id (string, 1..128 chars) required') }
      if (paramsError) { const w = spendFree(); if (w) return { rateLimited: w }; throw new TapeAPIError('BAD_REQUEST', `params have no canonical form: ${paramsError.message}`) }
      // TAP-21 §3.1: a body `method` that disagrees with the path is refused, never silently overwritten (D14)
      // 与路径不一致的 body `method` 被拒绝，而不是被悄悄覆盖
      if (sentMethod !== undefined && sentMethod !== method) { const w = spendFree(); if (w) return { rateLimited: w }; throw new TapeAPIError('BAD_REQUEST', 'body method does not match the path') }
      if (body.params != null && !isPlainObject(body.params)) { const w = spendFree(); if (w) return { rateLimited: w }; throw new TapeAPIError('BAD_REQUEST', 'params must be a JSON object') }
      const def = methodDef(method)
      // validateManifest 已经用同一个解析器校验过每个 priceBEM，这里不会再抛 / already validated above
      const price = def ? parseUnits(def.priceBEM || '0') : 0n
      if (price === 0n) { const w = spendFree(); if (w) return { rateLimited: w } }
      if (!def) throw new TapeAPIError('METHOD_NOT_FOUND', `unknown method ${method.slice(0, 64)}`)
      const ctx = { consumer: null, block, manifest, method: def, price, clientIp: ip }
      if (price > 0n) {
        // An IP that has spent its free budget AND keeps presenting vouchers that fail is refused before the costly
        // part (signature recovery, uncached chain reads). A paying consumer whose vouchers verify is never affected.
        // 既耗尽了免费预算、又不断提交验不过的凭证的 IP，在昂贵的部分之前就被拒绝；凭证能验过的付费消费者从不受影响。
        if (rl && overBudget(`fail:${ip}`, FAIL_BUDGET) && overBudget(`free:${ip}`, rl.free)) return { rateLimited: retryAfter(`fail:${ip}`) }
        if (!body.voucher) { const w = spendFree(); if (w) return { rateLimited: w }; throw new TapeAPIError('PAYMENT_REQUIRED', `${def.name} costs ${def.priceBEM} BEM per call`, { data: { price: price.toString() } }) }
        try { lease = await verifyVoucher(body.voucher, price) }
        catch (e) { if (rl) { rateLimited(`fail:${ip}`, Infinity); rateLimited(`free:${ip}`, Infinity) } throw e }
        verified = true
        ctx.consumer = lease.consumer; ctx.voucherSigner = lease.signer; ctx.cumulative = lease.cumulative
        // Keyed on the consumer the voucher signature PROVED, never on the `consumer` field as sent: an unverified
        // field would let anyone exhaust a victim's budget by writing the victim's address into junk vouchers.
        // 按凭证签名已证明的消费者计，绝不按请求里原样的 `consumer` 字段。
        if (rl && rl.paid) {
          const wait = rateLimited(`paid:${String(lease.consumer).toLowerCase()}`, rl.paid)
          if (wait) { lease.release(); lease = null; return { rateLimited: wait } }
        }
      }
      let timer
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new TapeAPIError('INTERNAL', `handler ${def.name} exceeded ${handlerTimeoutMs} ms`)), handlerTimeoutMs) })
      let result
      try { result = await Promise.race([methods[def.name](params, ctx), timeout]) } finally { clearTimeout(timer) }
      // Lapsed while the handler ran: sign nothing and bill nothing (arch A3) / 处理期间过期：不签名、不计费
      if (delegationLapsed()) { if (lease) lease.release(); return { status: 503, unsigned: lapsedError(), paid: false } }
      // Sign FIRST, bill second: a result that cannot be signed (no canonical form) must not be charged for
      // (runtime audit F-06). / 先签名、后计费：签不了名的结果不能收钱。
      const env = envelope(req, true, result ?? null, block)
      // Nor is a result too large to send (TAP-21 §3.2, 1 MiB) / 超过 1 MiB 发不出去的结果也不收钱
      if (utf8Length(JSON.stringify(env)) > RESPONSE_LIMIT) throw new TapeAPIError('INTERNAL', `response of ${def.name} exceeds ${RESPONSE_LIMIT} bytes`)
      if (lease) await lease.commit()   // bill only for a delivered result / 交付了结果才计费
      return { status: 200, env, paid: verified }
    } catch (e) {
      if (lease) lease.release()        // the caller is not charged for a failed call / 失败的调用不计费
      const payload = errorPayload(e)
      return { status: STATUS[payload.code], env: envelope(req, false, payload, block), paid: false }
    }
  }

  // ---- node:http entry point: a thin adapter over handleRequest() (arch B17) ----
  // Routing, limiter, health and error mapping live ONCE, in handleRequest(); this only converts an IncomingMessage
  // into a Request and the Response back. Two copies had drifted before: the delegation-expiry fix (arch A3) had to
  // land in both.
  // ---- node:http 入口：handleRequest() 之上的薄适配层（arch B17）----
  // 路由、限流、health 与错误映射只在 handleRequest() 里写一次；这里只把 IncomingMessage 转成 Request、再把 Response 写回。
  // 两份实现曾经不同步过：委托过期的修复（arch A3）得两处都改。
  // The Fetch spec refuses these in a Request. Any method other than GET / POST / OPTIONS gets the same 404 / 405, so a
  // stand-in keeps the answer. / Fetch 规范不允许 Request 用这几个方法；GET / POST / OPTIONS 以外的方法答案都一样，换一个即可。
  const FETCH_FORBIDDEN = new Set(['CONNECT', 'TRACE', 'TRACK'])
  // Exported as it is, so it never rejects: whoever wires http.createServer(p.handler) gets an answer, not an unhandled
  // rejection (review R2-5). / 原样导出，因此绝不 reject：直接用 http.createServer(p.handler) 的人得到回答，而不是未处理的拒绝。
  function handler(req, res) {
    return nodeRequest(req, res).catch((e) => {
      // A logger or a response that throws here must not turn into a rejection either (review R3-6).
      // 这里的日志或响应本身抛错，也不能变成拒绝。
      try { log('handler crash', e) } catch { /* the logger is broken; the answer still goes out / 日志坏了，回答照发 */ }
      try { if (!res.headersSent) send(res, 500, { ok: false, error: { code: 'INTERNAL', message: 'internal error' } }); else res.destroy() }
      catch { try { res.destroy() } catch { /* nothing left to do / 已无可做 */ } }
    })
  }
  async function nodeRequest(req, res) {
    let url
    try { url = new URL(req.url, 'http://localhost') }
    catch { return send(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'unparsable request target' } }) }   // e.g. port 99999 (review R3-6)
    // An absolute-form target may carry user:pass@, which a fetch Request refuses to hold; nothing here uses it
    // (review R2-5). / 绝对形式的请求目标可能带 user:pass@，fetch 的 Request 不接受；这里也用不到它。
    url.username = ''; url.password = ''
    // Identity as it always was here: the configured proxy header's last hop, else the socket peer -- never a header
    // nobody configured (runtime audit F-03 / F-04). Handed over as clientIp, so handleRequest reads no header itself.
    // 身份与以往一致：配置过的代理头的最后一跳，否则是 socket 对端；绝不用未配置的头。作为 clientIp 交给 handleRequest。
    const ip = (clientIpHeader && lastHop(req.headers[clientIpHeader])) || req.socket?.remoteAddress || 'unknown'
    const method = FETCH_FORBIDDEN.has(req.method) ? 'PUT' : req.method
    const headers = new Headers()
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) { try { headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]) } catch { /* not a fetch header */ } }
    // Pulled only when handleRequest reads it (highWaterMark 0), so a request refused before the body -- 404, 405,
    // 429, 503 -- reads none of it, as before. The byte count and both caps are readRequestText's; cancelling at the
    // hard cap destroys the socket, and a client abort surfaces as a read error ("malformed request").
    // 只有 handleRequest 读取时才拉取（highWaterMark 0），在读 body 之前就被拒的请求一个字节也不读。字节计数与两道上限都在
    // readRequestText 里；超过硬上限时取消即销毁 socket，客户端中途断开表现为读取错误。
    let chunks = null
    const body = method === 'GET' || method === 'HEAD' ? null : new ReadableStream({
      async pull(c) {
        chunks ??= req[Symbol.asyncIterator]()
        const { done, value } = await chunks.next()
        if (done) c.close(); else c.enqueue(value)
      },
      cancel() { req.destroy() },
    }, { highWaterMark: 0 })
    const r = await handleRequest(new Request(url, { method, headers, body, duplex: 'half' }), { clientIp: ip })
    const out = Buffer.from(await r.arrayBuffer())
    const head = Object.fromEntries(r.headers)
    if (r.status !== 204) head['content-length'] = String(out.length)
    // Written even if the socket is gone (a hard-cap cut-off): Node drops it, and the promise still settles.
    // socket 已断开（硬上限截断）时照样写：Node 会丢弃，promise 照常了结。
    res.writeHead(r.status, head)
    res.end(out)
  }

  // Fixed window, bounded map. Not distributed: two processes each get their own budget, which is stated in
  // TAP-21 §3.4 rather than papered over. / 固定窗口、有界表。不跨进程共享：两个进程各有一份预算，这一点写进规范而不是假装没有。
  const buckets = new Map()
  function rateLimited(key, budget) {
    if (!rl || !budget) return 0
    const nowMs = Date.now()
    let b = buckets.get(key)
    if (!b || nowMs >= b.reset) { b = { n: 0, reset: nowMs + rl.windowMs }; buckets.set(key, b) }
    b.n++
    // Hard bound: drop the oldest buckets (Map keeps insertion order), expired or not. Losing an old bucket only
    // forgets its count; an unbounded map is a memory leak under many distinct IPs (runtime audit F-02).
    // 硬上限：丢掉最早的桶（Map 保持插入顺序），无论是否过期。丢一个旧桶只是忘掉它的计数；无界的表在大量不同 IP 下就是内存泄漏。
    while (buckets.size > rl.max) buckets.delete(buckets.keys().next().value)
    return b.n > budget ? Math.max(1, Math.ceil((b.reset - nowMs) / 1000)) : 0
  }
  const overBudget = (key, budget) => { const b = buckets.get(key); return !!b && Date.now() < b.reset && b.n >= budget }
  const retryAfter = (key) => { const b = buckets.get(key); return b ? Math.max(1, Math.ceil((b.reset - Date.now()) / 1000)) : 1 }
  const stats = { singleInstance, started: Math.floor(Date.now() / 1000), calls: 0, ok: 0, failed: 0, free: 0, paid: 0, rateLimited: 0, delegationLapsed: 0, byMethod: Object.create(null), byCode: Object.create(null) }
  // health 只暴露 signer、版本与服务参数；委托过期后 ok 为 false（arch A3）/ signer, version and serving parameters; ok is false once the delegation lapsed
  const health = () => ({ ok: !delegationLapsed(), signer: signerAddr, version: VERSION, minVoucherLifeS, delegationExpires: delegationExpires(), rateLimit: rl ? { windowMs: rl.windowMs, free: rl.free, paid: rl.paid, ip: rl.ip } : null })
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1 }

  // ---- Fetch-API entry point: Cloudflare Workers, Deno, Bun, or a Node http server you wire up yourself ----
  // The one implementation of routing and the limiter (handler() adapts node:http onto it), with no node: dependency.
  // The caller supplies the client identity, because there is no socket here: on Workers that is
  // request.headers.get('cf-connecting-ip'), which the edge sets and a client cannot forge.
  // ---- Fetch API 入口：Cloudflare Workers、Deno、Bun，或你自己接的 Node 服务器 ----
  // 路由与限流的唯一实现（handler() 把 node:http 适配到这里），不依赖任何 node: 模块。
  // 客户端身份由调用方给出，因为这里没有 socket：在 Workers 上就是 cf-connecting-ip，由边缘设置、客户端伪造不了。
  // Byte-counted and hard-capped: `request.text()` measures UTF-16 units and buffers everything first, so a large
  // body was read in full before the limit was even checked (runtime audit F-05).
  // 按字节计数并设硬上限：`request.text()` 数的是 UTF-16 单元，而且会先把全部内容读进来，大请求体会在检查上限之前被完整读入。
  let warnedNoIp = false
  async function readRequestText(request) {
    if (!request.body) return ''
    const reader = request.body.getReader()
    const chunks = []; let n = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      n += value.byteLength
      if (n > hardBodyCap) { try { await reader.cancel() } catch { /* ignore */ } throw new TapeAPIError('BAD_REQUEST', 'request body too large') }
      if (n <= bodyLimit) chunks.push(value)
    }
    if (n > bodyLimit) throw new TapeAPIError('BAD_REQUEST', 'request body too large')
    const out = new Uint8Array(n); let o = 0
    for (const c of chunks) { out.set(c, o); o += c.byteLength }
    return new TextDecoder().decode(out)
  }

  async function handleRequest(request, { clientIp } = {}) {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const json = (status, body, extra) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS, ...extra } })
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
    if (request.method === 'GET' && path === '/.well-known/tapeapi.json') return json(200, manifest)
    if (request.method === 'GET' && path === '/tapeapi/v1/health') return json(200, health())
    const m = /^\/tapeapi\/v1\/([A-Za-z_][A-Za-z0-9_]{0,63})$/.exec(path)
    if (!m) return json(404, { ok: false, error: { code: 'NOT_FOUND', message: 'no such route' } })
    if (request.method !== 'POST') return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'use POST' } })
    if (delegationLapsed()) { stats.delegationLapsed++; return json(503, lapsedError()) }   // arch A3
    // Identity comes from the host (a Worker passes the edge's cf-connecting-ip as clientIp) or from a configured
    // proxy header -- never from a header the client could have written itself (runtime audit F-04).
    // 身份来自宿主（Worker 把边缘设置的 cf-connecting-ip 作为 clientIp 传入）或配置过的代理头，绝不来自客户端能自己写的头。
    const ip = clientIp || (clientIpHeader && lastHop(request.headers.get(clientIpHeader))) || 'unknown'
    if (!clientIp && !clientIpHeader && !warnedNoIp) { warnedNoIp = true; log('handleRequest called without clientIp and no clientIpHeader is set: every caller shares one rate-limit bucket') }
    const tooMany = (wait) => {
      stats.rateLimited++
      return json(429, { ok: false, error: { code: 'RATE_LIMITED', message: `too many requests; retry in ${wait}s`, data: { retryAfterS: wait } } }, { 'retry-after': String(wait) })
    }
    if (rl) { const wait = rateLimited(`ip:${ip}`, rl.ip); if (wait) return tooMany(wait) }
    let body
    try {
      const raw = await readRequestText(request)
      body = safeParseJSON(raw, { code: 'BAD_REQUEST' })
      if (!isPlainObject(body)) throw new TapeAPIError('BAD_REQUEST', 'body must be object')
    } catch (e) {
      const message = e instanceof TapeAPIError ? e.message : 'malformed request'
      if (rl) { const w = rateLimited(`free:${ip}`, rl.free); if (w) return tooMany(w) }   // unverified work / 未经验证的工作
      return json(/too large/.test(message) ? 413 : 400, envelope({ id: '', method: m[1], params: {} }, false, { code: 'BAD_REQUEST', message }, lastBlock))
    }
    const sentMethod = body.method
    body.method = m[1]
    let out
    try { out = await invoke(body, { ip, sentMethod }) }
    catch (e) {
      log('invoke crashed', e)
      // Bound to the same (id, params) the answer would have carried, so the client that sent it can verify it
      // (TAP-21 §3.2, SD-1). / 与正常回答相同的 (id, params) 绑定，发出请求的客户端才能验证它。
      out = { status: 500, env: envelope(bindingOf(body, m[1]).req, false, { code: 'INTERNAL', message: 'internal error' }, lastBlock), paid: false }
    }
    if (out.rateLimited) return tooMany(out.rateLimited)
    if (out.unsigned) { stats.delegationLapsed++; return json(out.status, out.unsigned) }   // lapsed mid-request / 请求途中过期
    const { status, env } = out
    stats.calls++
    bump(stats.byMethod, m[1])
    if (env?.ok) stats.ok++; else { stats.failed++; bump(stats.byCode, env?.error?.code || 'INTERNAL') }
    if (out.paid) stats.paid++; else stats.free++
    return json(status, env)
  }

  let server = null
  // `node:http` is imported here, not at module scope, so the rest of the runtime loads anywhere fetch exists.
  // listen() is the only Node-only entry point; Workers use handleRequest() instead.
  // `node:http` 在这里导入而不是在模块顶层，因此运行时的其余部分在任何有 fetch 的地方都能加载。
  // listen() 是唯一的 Node 专用入口；Workers 用 handleRequest()。
  async function listen(port = 0, host = '127.0.0.1') {
    const { default: http } = await import('node:http')
    server = http.createServer(handler)
    // A request gets 30 s end to end, headers 15 s, instead of Node's 300 s default: a drip-fed body otherwise holds a
    // socket for five minutes (runtime audit I-02). / 整个请求 30 秒、请求头 15 秒，而不是 Node 默认的 300 秒。
    server.requestTimeout = opts.requestTimeoutMs ?? 30_000
    server.headersTimeout = Math.min(server.requestTimeout, opts.headersTimeoutMs ?? 15_000)
    return new Promise((resolve, reject) => server.once('error', reject).listen(port, host, () => resolve(server)))
  }
  function close() { return new Promise((r) => (server ? server.close(() => r()) : r())) }

  // 待结算凭证 / vouchers worth settling (latest per consumer). Expired ones are reported via log, not silently dropped.
  // A voucher signed by a session key settles only while BOTH it and the session are live (TAP-22 §3.2), so its
  // deadline is min(expires, sessionExpiry); a consumer-signed voucher's deadline is its expires. Sorted soonest first.
  // 会话密钥签的凭证只有在凭证与会话都有效时才能结算，截止时间为 min(expires, sessionExpiry)；按截止时间升序。
  async function pendingSettlements() {
    if (typeof store.all !== 'function') throw new TapeAPIError('INTERNAL', 'store.all() not implemented')
    const t = now()
    const all = (await store.all()).filter(v => BigInt(v.cumulative) > 0n)
    const withDeadline = await Promise.all(all.map(async (v) => {
      let deadline = v.expires
      if (rpc && v.signer && !eqAddr(v.signer, v.consumer)) {
        try { deadline = Math.min(v.expires, Number(await sessionExpiry(v.consumer, v.signer))) } catch (e) { log('sessionExpiry read failed; using voucher expiry', e.message) }
      }
      return { ...v, deadline }
    }))
    const lost = withDeadline.filter(v => v.deadline < t)   // inclusive boundary: deadline == now still settles / 包含边界
    if (lost.length) log('expired unsettled vouchers', lost.map(v => `${v.consumer}:${v.cumulative}`).join(', '))
    return withDeadline.filter(v => v.deadline >= t).sort((x, y) => x.deadline - y.deadline)
      .map(({ consumer, provider, cumulative, expires, sig, deadline }) => ({ consumer, provider, cumulative, expires, sig, deadline }))
  }

  // What an operator must settle NOW (TAP-22 §3.3.1): vouchers above what the escrow already paid whose deadline is
  // within `marginS`, and every voucher on a channel with an armed withdraw request (settle before availableAt).
  // The runtime holds no wallet: send each `settleTx(v)` with your own key, on a timer shorter than marginS.
  // 运营者此刻必须结算的：高于已结算额、且截止时间在 marginS 之内的凭证，以及所有挂着提现请求的通道上的凭证
  // （须在 availableAt 之前结算）。运行时不持有钱包：用你自己的密钥发送每个 `settleTx(v)`，定时周期短于 marginS。
  async function dueSettlements({ marginS = Math.max(2 * minVoucherLifeS, 600) } = {}) {
    needRpc()
    const t = now()
    const due = []
    for (const v of await pendingSettlements()) {
      // one consumer whose escrow cannot be read must not keep everyone else's vouchers from settling (review L-5)
      // 某个消费者的托管读不出来，不能挡住其他人的凭证结算
      let st
      try { st = await escrowState(v.consumer) } catch (e) { log(`dueSettlements: cannot read the escrow for ${v.consumer}, skipped this run`, e.message); continue }
      const { claimed, armed } = st
      if (BigInt(v.cumulative) <= claimed) continue            // already settled on chain / 链上已结算
      const reason = armed > 0n ? 'withdraw-requested' : v.deadline - t <= marginS ? 'deadline' : null
      if (reason) due.push({ ...v, reason })
    }
    return due
  }
  const settleTx = (v) => ({ to: escrow, data: encodeCall('settle', [v.consumer, v.provider, BigInt(v.cumulative), BigInt(v.expires), v.sig]), value: '0x0' })

  return { handler, handleRequest, listen, close, invoke, stats: () => ({ ...stats, byMethod: { ...stats.byMethod }, byCode: { ...stats.byCode }, uptimeS: Math.floor(Date.now() / 1000) - stats.started, delegationExpires: delegationExpires() }), pendingSettlements, dueSettlements, settleTx, contribution, currentBlock, manifest, container, signer: signerAddr, escrow, chainId, store, rpc, version: VERSION, get server() { return server } }
}
