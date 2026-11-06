// @experimental The called app's side of a visitor grant:
// verifyVisitorGrant (pure apart from the injected chain reads and store), a memory store for counting, replay and
// revocation, the wrapper that puts the check in front of a provider's method handlers and writes the grant record
// `result.grant` into the signed answer, the free method `grant_revoke`, and the chain reads built from an SDK client.
// Outside the package's compatibility promise; a PROTOTYPE, not a TAP. Its format text is spec/TAPI-28.md (Experimental);
// where the two differ, the code is authoritative.
// 被调用方 B 一侧：verifyVisitorGrant、计数 / 去重 / 撤销的内存存储、把核验放在处理器前面并把授权记录
// `result.grant` 写进签名回答的包装、免费方法 grant_revoke、由 SDK 客户端构造的读链函数。实验性原型，不是 TAP；格式说明见
// spec/TAPI-28.md，两者不一致时以代码为准。
//
// Refusals are TAP-13 §6 `BAD_REQUEST` with the reason as a message prefix `grant: <reason>` and NO error.data (the §6
// table gives BAD_REQUEST no data). New codes (GRANT_REQUIRED, BAD_GRANT) wait for an Application TAP.
// 拒绝一律是 BAD_REQUEST，原因写成 message 前缀 `grant: <原因>`，不带 error.data；新错误码等 Application TAP。
//
// What this does NOT do: / 没有做的事：
//  - the chain reads are the injected `chain` functions. chainReadsFromApi reads through the SDK's TAP-10 site status
//    (api.siteStatus: identity and site status at one TAP-10 pinned block, as the 2.0 default resolution reads them), with
//    a <= 60 s cache (TAP-10 §11's window): a name the 2.0 default refuses as not-opened or unpaid is refused here too
//    (grant: caller-not-opened / caller-unpaid, and audience-* for this service). It reads no manifest.
//    读链函数由调用方注入；chainReadsFromApi 经 SDK 的 TAP-10 站点状态读取（钉块，与 2.0 默认解析相同），缓存不超过 60 秒：
//    2.0 默认因 not-opened、unpaid 拒绝的名字，这里同样拒绝。
//  - the rate-limit key grant:<caller>:<user> is the store's (`take`; grantMethods' option perGrantWindow, off by default:
//    maxCalls is already a cap), keyed on what the check PROVED (the visitor's signature and the caller's name), never on
//    fields as sent. Refunding the IP's free budget for a call with a verified grant, and counting bad grants in fail:ip,
//    live inside the reference server's limiter, which this module cannot reach without changing the server: not done.
//    限流键 grant:<caller>:<user> 放在存储里（take；grantMethods 的 perGrantWindow 选项，默认关：maxCalls 本身就是上限），
//    按核验已证明的身份分桶，绝不按请求原样的字段。为验过授权的免费调用退还 IP 免费额度、坏授权计入 fail:ip 在服务端限流器内部，
//    不改服务端就做不到，未做。
//  - the count is committed when the handler's result is accepted, just BEFORE the provider signs it: a result the
//    provider then refuses to send (over 1 MiB, the delegation lapsing mid-call) uses one call. The wrapper checks the
//    canonical form first, so only those two remain. / 计次在签名前提交；之后才被服务端拒发的结果会多计一次（两种情形）。
//    The provider's handler timeout is not one of them (FIXED G-6): grantMethods' own deadline (timeoutMs, below the
//    provider's) releases the call first. / 服务端的处理器超时不在其中：grantMethods 自己的时限（小于服务端的）先释放。
//  - Workers KV is eventually consistent: memoryGrantStore is exact in ONE process only. / 内存存储只在单进程内精确
//  - memoryGrantStore keeps revocations, counts and replay records IN MEMORY: a restart loses them, including the
//    "for good" revocation of step 11 (a caller whose holder changed). A production service persists `revoke` and
//    `revokeBefore`. The revocations are bounded (maxRevocations, default 100 000): a revocation is dropped once every
//    grant it can refuse has expired; a hash revoked through grant_revoke whose grant was never presented has no known
//    expiry and is kept until then; when the store is full, a new revocation is refused (INTERNAL), never an old one dropped.
//    Those revocations of hashes never presented have a budget of their own (maxUnseenRevocations, default half; IR-1).
//    从未出现过的哈希的撤销有单独的预算（maxUnseenRevocations，默认一半）。
//    内存存储：撤销、计数、去重都只在内存里，进程重启即丢失（包括第 11 步的“永久”撤销）；生产服务须持久化 revoke 与 revokeBefore。
//    撤销有上限（默认 10 万条）：它能拒绝的授权全部过期后即清理；经 grant_revoke 撤销、授权从未出现过的哈希不知道到期时间，一直保留；
//    存满时拒绝新的撤销（INTERNAL），绝不丢弃旧的。
//  - an answer lost after delivery (FIXED G-3): when the provider has signed an answer and is about to send it
//    (@tapeapi/server's experimental ctx.onSigned), grantMethods keeps that signed envelope in the store, keyed by
//    (grant hash, id) and bound to the request (method, params). If the answer never reaches the caller and the SDK's
//    stable `call` retries the SAME id, the retry passes steps 1-6 (the call proof proves the grant's callerKey signed it)
//    and step 7 finds the kept envelope: the provider sends it again byte for byte (ctx.resend): not signed again, not
//    counted again, the receipt unchanged. Kept at most until min(the grant's expiry + 600 s, the answer's ts + 300 s:
//    a client refuses an older ts anyway), bounded (maxAnswers, maxAnswerBytes; the oldest is dropped first); only an
//    answer the provider actually signed and passed is kept. Without it (an envelope dropped, another params, a provider
//    without ctx.onSigned / ctx.resend, maxAnswers: 0) the retry is answered `grant: replayed` as before.
//    交付后回答丢失：服务端签好、即将发出回答时，grantMethods 把这份已签信封按（授权哈希, id）存进存储，并绑定请求（method、params）。
//    回答没有到达、SDK 用同一个 id 重试时，重试先过第 1–6 步（调用证明证明是授权里的 callerKey 签的），第 7 步找到这份信封，
//    服务端原样重发：不重签、不再计次，回执不变。最长保留到 min(授权到期 + 600 秒, 回答 ts + 300 秒)，有上限（旧的先丢）；
//    只保留服务端真正签出、且各项检查无误的回答。找不到时（已丢弃、params 不同、服务端没有这两个钩子、maxAnswers 为 0）照旧答 grant: replayed。
import { TapeAPIError } from '@tapeapi/sdk'
import { canonicalJSON } from '@tapeapi/sdk/canon'
import { isAddress, eqAddr, checksumAddress, toHex, encodeParams, bytesToHex, selector, keccak256, utf8ToBytes } from '@tapeapi/sdk/abi'
import { recoverAddress } from '@tapeapi/sdk/sig'
import { parseTapeName } from '@tapeapi/sdk/chains'
import {
  GRANT_FORMAT_VERSION, GRANT_SKEW_S, MAX_GRANT_LIFE_S, MAX_USER_SIG_BYTES, normalizeGrant, statementMatches, grantHashOf, grantDigest,
  recoverCallProofSigner, normalizeGrantRevocation, grantRevocationDigest, hashGrantRevocation, makeGrant,
} from './interop-sig.js'

/** every reason a service gives, in the order it checks them / 全部拒绝原因，按核验顺序 */
export const GRANT_REASONS = Object.freeze([
  'required', 'malformed', 'wrong-audience', 'method-out-of-scope', 'expired', 'statement-mismatch', 'bad-proof', 'replayed',
  'bad-user-signature', 'revoked', 'audience-holder-changed', 'audience-not-opened', 'audience-unpaid', 'caller-name-mismatch', 'caller-holder-changed', 'caller-not-opened', 'caller-unpaid',
  'voucher-not-allowed', 'rate-limited', 'exhausted',
])
// The TAP-10 site statuses (§6.2) a resolved name can have besides 'ok', as the 2.0 default refuses them.
// 解析到的名字除 ok 之外可能的 TAP-10 站点状态（§6.2），即 2.0 默认会拒绝的那些。
const SITE_REFUSALS = Object.freeze(['not-opened', 'unpaid'])
const GRANT_MODES = new Set(['required', 'optional'])
/** the free method that takes a GrantRevocation (a revocation the called service itself enforces) / 接收撤销的免费方法 */
export const GRANT_REVOKE_METHOD = 'grant_revoke'
/** the result member the service writes; a handler may not use it / 服务写入的结果成员，处理器不得自用 */
export const GRANT_RESULT_MEMBER = 'grant'
// the handlers grantMethods made (grantManifestProblems' second argument, IR-6) / grantMethods 造出的处理器
const WRAPPED = new WeakSet()
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

/** A refusal as the service signs it: BAD_REQUEST, `grant: <reason>`, no data / 服务签发的拒绝 */
export function grantRefusal(reason, detail) {
  return new TapeAPIError('BAD_REQUEST', `grant: ${reason}${detail ? ` (${String(detail).slice(0, 200)})` : ''}`)
}
/** The reason of a refusal (from a signed BAD_REQUEST's message), or null / 从签名的 BAD_REQUEST 读出原因 */
export function grantReasonOf(e) {
  if (!e || e.code !== 'BAD_REQUEST' || typeof e.message !== 'string') return null
  const m = /^grant: ([a-z-]+)/.exec(e.message)
  return m && GRANT_REASONS.includes(m[1]) ? m[1] : null
}

/**
 * Manifest checks for the methods that take grants: a method descriptor's `grant` member is "required" or
 * "optional"; such a method is free (a grant and a voucher are never accepted together); `grant_revoke` is free and takes none.
 * "Only methods that return a visitor's own data take a grant" cannot be checked by a program: it is the operator's.
 * 清单检查：grant 成员只能是 required / optional；带它的方法必须免费（授权与凭证不并存）；grant_revoke 免费且不带 grant。"公开数据不要授权"无法机检。
 */
export function grantManifestProblems(manifest, { methods = null } = {}) {
  const out = []
  for (const d of manifest?.methods ?? []) {
    // FIXED IR-6 (review 2026-10-22): a handler of a method that takes grants, not wrapped by grantMethods, serves anyone
    // 带 grant 的方法、处理器却没被 grantMethods 包装：谁都能调用
    if (methods && GRANT_MODES.has(d.grant) && typeof methods[d.name] === 'function' && !WRAPPED.has(methods[d.name])) out.push(`${d.name}: takes a grant but its handler is not wrapped by grantMethods: it would serve anyone without checking the grant`)
    if (d.grant !== undefined && !GRANT_MODES.has(d.grant)) out.push(`${d.name}: grant must be "required" or "optional"`)
    if (d.grant !== undefined && d.priceBEM !== undefined && d.priceBEM !== '0' && !/^0(\.0+)?$/.test(String(d.priceBEM))) out.push(`${d.name}: a method that takes a grant must be free (no grant with a voucher)`)
    if (d.name === GRANT_REVOKE_METHOD && (d.grant !== undefined || !/^0(\.0+)?$/.test(String(d.priceBEM ?? '0')))) out.push(`${GRANT_REVOKE_METHOD} must be free and take no grant`)
  }
  return out
}

// ---------- the store: count, replay, revocation / 存储：计数、去重、撤销 ----------
/**
 * In-memory store, exact within one process, lost on restart. Interface (any store may implement it):
 *   isRevoked(user, hash, notBefore, expires) -> bool    revoke(user, hashes, expires?)    revokeBefore(user, t)
 *   delivered(hash, id) -> bool                      reserve(hash, id, maxCalls, expires) -> lease | null (exhausted)
 *   inFlight(hash, id) -> bool                       (optional, IR-3: a call with this (hash, id) is in progress)
 *   lease: { used, commit(), release() }             usedOf(hash) -> number
 *   take(key, calls, windowS) -> 0 | retryAfterS    (optional: only for grantMethods' perGrantWindow)
 *   keepAnswer(hash, id, env, { until, req })        answerOf(hash, id) -> { env, req } | null
 *                                                    (optional: the signed answer kept for a retry of the same id, G-3)
 * `(hash, id)` is recorded as delivered only at commit(): a call that failed on a chain read can be retried with the same
 * id (check 8, replay). / 只在 commit() 时记录 (hash, id) 已交付，读链失败后同 id 重试不被误判为重放。
 * Revocations are bounded (FIXED G-2): one by hash is dropped when its grant has expired (`expires`, given with the revocation
 * or learned when the grant is first presented: a hash commits to its expiry); a revokedBefore when every grant it refuses
 * has expired (t + 7 days + skew). Beyond `maxRevocations` a new revocation is refused (INTERNAL), never an old one dropped.
 * 撤销有上限：按哈希的撤销在授权到期后清理（到期时间随撤销给出，或在授权首次出现时得知：哈希绑定到期时间）；revokedBefore 在它能拒绝的
 * 授权全部过期后清理。超过 maxRevocations 时拒绝新的撤销（INTERNAL），绝不丢弃旧的。
 */
export function memoryGrantStore({ clock = () => Math.floor(Date.now() / 1000), maxRevocations = 100_000, maxUnseenRevocations, maxRateKeys = 100_000, maxAnswers = 1_000, maxAnswerBytes = 16 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxRevocations) || maxRevocations < 1) throw new TapeAPIError('INVALID_ARGUMENT', 'maxRevocations must be a positive integer')
  // FIXED IR-1 (review 2026-10-22): revocations of grant hashes this service never saw have no known expiry and are never
  // pruned, and anyone can make keys to sign them: they get a budget of their own (default half), so that a flood of
  // them cannot stop a visitor from revoking a grant this service has seen, or by date.
  // 本服务从未见过的哈希的撤销没有已知到期时间、永不清理，且谁都能造钥匙签它们：给它们单独的预算（默认一半），
  // 这样它们塞不满整张表，访客仍能撤销本服务见过的授权或按日期撤销。
  const maxUnseen = maxUnseenRevocations ?? Math.max(1, Math.floor(maxRevocations / 2))
  if (!Number.isSafeInteger(maxUnseen) || maxUnseen < 1) throw new TapeAPIError('INVALID_ARGUMENT', 'maxUnseenRevocations must be a positive integer')
  let unseen = 0                          // entries of `revoked` whose expiry is null / 到期时间未知的条数
  if (!Number.isSafeInteger(maxRateKeys) || maxRateKeys < 1) throw new TapeAPIError('INVALID_ARGUMENT', 'maxRateKeys must be a positive integer')
  if (!Number.isSafeInteger(maxAnswers) || maxAnswers < 0) throw new TapeAPIError('INVALID_ARGUMENT', 'maxAnswers must be a non-negative integer (0 keeps none)')
  if (!Number.isSafeInteger(maxAnswerBytes) || maxAnswerBytes < 0) throw new TapeAPIError('INVALID_ARGUMENT', 'maxAnswerBytes must be a non-negative integer')
  // signed answers kept for a retry of the same id (G-3): `${hash}:${id}` -> { env, req, until, bytes }, oldest first;
  // dropping one only means its retry is answered "replayed". / 为同 id 重试保留的已签回答；丢掉一份只意味着它的重试答 replayed。
  const answers = new Map()
  let answerBytes = 0
  const dropAnswer = (k) => { const a = answers.get(k); if (a) { answerBytes -= a.bytes; answers.delete(k) } }
  // the rate-limit windows: key -> { w, cur, prev } (a sliding window from two fixed ones); bounded: past maxRateKeys the
  // oldest key is dropped, which only forgets its count. / 限流窗口（两个固定窗口拼成的滑动窗口）；有上限，超出时丢弃最早的键，只是忘掉计数。
  const windows = new Map()
  const revoked = new Map()               // `${user}:${hash}` (lower case) -> the grant's expires, or null (not known yet)
  const before = new Map()                // user -> revokedBefore
  const counts = new Map()                // hash -> { committed, inflight: Set(id), expires }
  const done = new Map()                  // `${hash}:${id}` -> expires
  const prune = () => {
    const now = clock()
    for (const [k, exp] of done) if (exp + GRANT_SKEW_S * 2 < now) done.delete(k)
    for (const [h, c] of counts) if (c.expires + GRANT_SKEW_S * 2 < now && !c.inflight.size) counts.delete(h)
  }
  // Revocations that can refuse nothing any more: their grant expired. At most once a minute, or when full.
  // 已经拒绝不了任何东西的撤销：授权已过期。至多每分钟一次，或存满时。
  let prunedAt = -Infinity
  const pruneRevocations = (force = false) => {
    const now = clock()
    if (!force && now - prunedAt < 60) return
    prunedAt = now
    for (const [k, exp] of revoked) if (exp !== null && exp + GRANT_SKEW_S * 2 < now) revoked.delete(k)
    for (const [u, t] of before) if (t + MAX_GRANT_LIFE_S + GRANT_SKEW_S * 2 < now) before.delete(u)
  }
  const room = (n) => {
    if (revoked.size + before.size + n <= maxRevocations) return
    pruneRevocations(true)
    if (revoked.size + before.size + n > maxRevocations) throw new TapeAPIError('INTERNAL', `this service's revocation store is full (${maxRevocations} entries): the revocation was not recorded; retry later`)
  }
  return {
    isRevoked(user, hash, notBefore, expires) {
      const u = user.toLowerCase(), k = `${u}:${hash}`
      if (revoked.has(k)) {
        if (revoked.get(k) === null && Number.isSafeInteger(expires)) { revoked.set(k, expires); unseen-- }
        return true
      }
      return before.has(u) && notBefore < before.get(u)
    },
    revoke(user, hashes, expires = null) {
      pruneRevocations()
      // the expiry of each hash: given, or known from a grant this service has counted (IR-1) / 到期时间：给出的，或计过次的授权的
      const expOf = (h) => Number.isSafeInteger(expires) ? expires : counts.get(h)?.expires ?? null
      const fresh = hashes.filter((h) => !revoked.has(`${user.toLowerCase()}:${h}`))
      const newUnseen = fresh.filter((h) => expOf(h) === null).length
      if (newUnseen && unseen + newUnseen > maxUnseen) {
        pruneRevocations(true)
        throw new TapeAPIError('INTERNAL', `this service's store for revocations of grants it has not seen is full (${maxUnseen} entries): the revocation was not recorded; retry later`)
      }
      room(fresh.length)
      for (const h of hashes) {
        const k = `${user.toLowerCase()}:${h}`, had = revoked.has(k), was = revoked.get(k) ?? null
        const now = expOf(h) ?? was
        if (had && was === null && now !== null) unseen--
        if (!had && now === null) unseen++
        revoked.set(k, now)
      }
    },
    revokeBefore(user, t) {
      pruneRevocations()
      const u = user.toLowerCase()
      if (t <= (before.get(u) ?? 0)) return
      if (!before.has(u)) room(1)
      before.set(u, t)
    },
    /** how many revocations are kept (tests, monitoring) / 当前保存的撤销条数 */
    revocations() { return { byHash: revoked.size, before: before.size, unseen } },
    /**
     * One call against the window of `key` (at most `calls` per `windowS` seconds, sliding): 0 when it fits (and it is
     * counted), else the seconds to wait (and nothing is counted). / 计入窗口：放得下返回 0 并计数，否则返回需等待的秒数、不计数。
     */
    take(key, calls, windowS) {
      const now = clock(), w = Math.floor(now / windowS)
      let e = windows.get(key)
      if (!e) {
        e = { w, cur: 0, prev: 0 }
        windows.set(key, e)
        while (windows.size > maxRateKeys) windows.delete(windows.keys().next().value)
      } else if (e.w !== w) { e.prev = e.w === w - 1 ? e.cur : 0; e.cur = 0; e.w = w }
      const into = (now - w * windowS) / windowS
      if (e.prev * (1 - into) + e.cur + 1 > calls) return Math.max(1, (w + 1) * windowS - now)
      e.cur++
      return 0
    },
    /** how many rate-limit keys are kept / 当前保存的限流键数 */
    rateKeys() { return windows.size },
    /** keep a signed answer for a retry of (hash, id) until `until`, bound to the request hash `req` / 保留已签回答 */
    keepAnswer(hash, id, env, { until, req }) {
      const k = `${hash}:${id}`, now = clock()
      dropAnswer(k)
      for (const [key, a] of answers) if (a.until < now) dropAnswer(key)
      const bytes = JSON.stringify(env).length * 2         // UTF-16, an upper bound of what it holds / 上界
      if (!maxAnswers || until < now || bytes > maxAnswerBytes) return false
      while (answers.size >= maxAnswers || answerBytes + bytes > maxAnswerBytes) dropAnswer(answers.keys().next().value)
      answers.set(k, { env, req, until, bytes })
      answerBytes += bytes
      return true
    },
    answerOf(hash, id) {
      const k = `${hash}:${id}`, a = answers.get(k)
      if (!a) return null
      if (a.until < clock()) { dropAnswer(k); return null }
      return { env: a.env, req: a.req }
    },
    /** how many answers are kept, and their size / 当前保留的回答数与大小 */
    answers() { return { count: answers.size, bytes: answerBytes } },
    delivered(hash, id) { return done.has(`${hash}:${id}`) },
    /** FIXED IR-3: a call with this (hash, id) is in progress / 该 (hash, id) 的调用正在进行 */
    inFlight(hash, id) { return !!counts.get(hash)?.inflight.has(id) },
    usedOf(hash) { return counts.get(hash)?.committed ?? 0 },
    reserve(hash, id, maxCalls, expires) {
      prune()
      let c = counts.get(hash)
      if (!c) { c = { committed: 0, inflight: new Set(), expires }; counts.set(hash, c) }
      if (c.inflight.has(id) || done.has(`${hash}:${id}`)) return { replayed: true }
      if (c.committed + c.inflight.size >= maxCalls) return null
      c.inflight.add(id)
      const used = c.committed + c.inflight.size
      let open = true
      return {
        used,
        commit() { if (!open) return; open = false; c.inflight.delete(id); c.committed++; done.set(`${hash}:${id}`, expires) },
        release() { if (!open) return; open = false; c.inflight.delete(id) },
      }
    },
  }
}

// ---------- chain reads / 读链 ----------
/**
 * The three reads verifyVisitorGrant needs, from an SDK client (`api`, createTapeAPI) and an RPC (`rpc`, createRpc;
 * only for EIP-1271 contract wallets: without it a contract wallet's signature is refused). The names and holders are
 * read as the 2.0 default resolution reads them: api.siteStatus, identity and TAP-10 §6.2 site status at one TAP-10
 * pinned block (in either mode of the client), cached at most `cacheS` (60 s, TAP-10 §11). A name that is not opened or
 * not activated comes back with that `status` and is refused by the check (caller-not-opened, caller-unpaid); a site
 * store or payment contract the SDK does not accept (store-changed) throws CONTRACT_UNKNOWN, as resolve does. An RPC
 * failure throws (the call fails without being counted), never "no".
 *   holderOf(container) -> { holder, status }                       this service's holder and site status
 *   resolveName(name)   -> { container, holder, status } | null     `<#ID>.<processor>.tape` on this chain; null: no such
 *                                                                   circuit or container here (no-such-*, not-tapeout)
 *   isValidSignature(address, digest, sig) -> bool          EIP-1271, an address without code is false
 * 由 SDK 客户端与 RPC 构造三个读链函数。名字与持有人按 2.0 默认解析的方式读取：api.siteStatus，在一个 TAP-10 钉块上读身份与站点状态，
 * 缓存不超过 60 秒。未开通或未激活的名字带着对应 status 返回，由核验拒绝；store-changed 抛出 CONTRACT_UNKNOWN。RPC 故障抛出（不计次），
 * 绝不当作"否"。
 */
export function chainReadsFromApi(api, { rpc = null, chainId = 56, clock = () => Math.floor(Date.now() / 1000), cacheS = 60, maxCacheEntries = 10_000 } = {}) {
  if (typeof api?.siteStatus !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', 'chainReadsFromApi needs an SDK client (createTapeAPI) with siteStatus')
  if (!Number.isSafeInteger(maxCacheEntries) || maxCacheEntries < 1) throw new TapeAPIError('INVALID_ARGUMENT', 'maxCacheEntries must be a positive integer')
  const cache = new Map()
  const cached = async (key, f) => {
    const hit = cache.get(key)
    if (hit && clock() - hit.at < cacheS) return hit.value
    const value = await f()
    // FIXED IR-12 (review 2026-10-22): bounded. The keys are chosen by the requester (a caller name, a visitor address):
    // unbounded, every new one stayed in memory for good. Past maxCacheEntries the oldest entry goes (it is read again).
    // 有上限：键由请求方决定（调用方名字、访客地址），过去每个新键都永久留在内存里。超过上限时丢弃最旧的（下次重读）。
    cache.delete(key)
    cache.set(key, { at: clock(), value })
    while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value)
    return value
  }
  return {
    holderOf: (container) => cached(`h:${container.toLowerCase()}`, async () => {
      const v = await api.siteStatus({ chainId, container })
      if (!resolvedStatus(v)) throw siteFailure(container, v)
      return { holder: checksumAddress(v.holder), status: v.status }
    }),
    resolveName: (name) => cached(`n:${name}`, async () => {
      const p = parseTapeName(name)
      if (!p || p.error || p.chainId !== chainId) return null
      const v = await api.siteStatus(name)
      if (v.status === 'store-changed') throw siteFailure(name, v)
      if (!resolvedStatus(v) || !isAddress(v.container) || /^0x0{40}$/i.test(v.container)) return null
      return { container: checksumAddress(v.container), holder: checksumAddress(v.holder), status: v.status }
    }),
    async isValidSignature(address, digest, sigHex) {
      if (!rpc) return false
      // FIXED IR-5: eth_getCode cached per address (<= cacheS): a forged grant for one address costs one read per window
      // 按地址缓存 eth_getCode：同一地址的伪造授权每个窗口只读一次
      if (await cached(`c:${address.toLowerCase()}`, async () => String(await rpc.call('eth_getCode', [address, 'latest'])) === '0x')) return false
      // A "yes" for (address, digest, sig) is cached too (<= cacheS), as the holders are: a revoked grant of a contract
      // wallet, now refused after the signature (IR-2), costs one eth_call per window, not one per request. A "no" is
      // never cached: a wallet that approves the digest afterwards (a multisig collecting signatures) is asked again.
      // “是”的答案同样缓存：合约钱包被撤销的授权每个窗口只问一次。“否”不缓存：之后才同意该摘要的钱包（多签）会被重新询问。
      const key = `v:${address.toLowerCase()}:${toHex(digest)}:${toHex(keccak256(utf8ToBytes(sigHex.toLowerCase())))}`
      const hit = cache.get(key)
      if (hit && clock() - hit.at < cacheS) return true
      const data = selector('isValidSignature(bytes32,bytes)') + bytesToHex(encodeParams(['bytes32', 'bytes'], [toHex(digest), sigHex]))
      let out
      try { out = String(await rpc.ethCall(address, data, 'latest')).toLowerCase() } catch (e) { if (/revert/i.test(String(e?.message))) return false; throw e }
      const yes = out.length >= 66 && out.slice(0, 66) === '0x1626ba7e' + '0'.repeat(56)
      if (yes) await cached(key, async () => true)
      return yes
    },
  }
}

// A site status that reached a circuit with a holder (ok, or one the default refuses: not-opened, unpaid).
// 身份解析到有持有人的电路的站点状态（ok，或默认会拒绝的 not-opened、unpaid）。
const resolvedStatus = (v) => !!v && (v.status === 'ok' || SITE_REFUSALS.includes(v.status)) && isAddress(v.holder)
const siteFailure = (what, v) => new TapeAPIError(v?.status === 'store-changed' ? 'CONTRACT_UNKNOWN' : 'NOT_FOUND', `${what}: TAP-10 site status ${v?.status ?? 'unknown'}`, { data: { status: v?.status ?? null } })
// The status a chain read reports (a custom reader that reports none vouches for 'ok'), checked against the TAP-10 names.
// 读链函数报告的状态（不报告的自定义读取函数视为 ok），只认 TAP-10 的名字。
function siteStatusOf(v) {
  const st = v && typeof v === 'object' && v.status !== undefined ? v.status : 'ok'
  if (st !== 'ok' && !SITE_REFUSALS.includes(st)) throw new TapeAPIError('INTERNAL', `a chain read reported the site status ${JSON.stringify(st)}, which the grant check does not know`)
  return st
}

// ECDSA first; a malformed signature is refused without asking EIP-1271; a well-formed one that recovers to someone
// else, or a longer one, is asked of the address under EIP-1271 (TAP-11 §4.4's rule, reused). / ECDSA 优先，再问 1271
async function signedBy(address, digest, sigHex, chain) {
  if (typeof sigHex !== 'string' || !new RegExp(`^0x(?:[0-9a-fA-F]{2}){65,${MAX_USER_SIG_BYTES}}$`).test(sigHex)) return false
  if (sigHex.length === 132) {
    let r = null
    try { r = recoverAddress(digest, sigHex) } catch { return false }
    if (eqAddr(r, address)) return true
  }
  return chain.isValidSignature ? !!(await chain.isValidSignature(address, digest, sigHex)) : false
}

// what a kept answer is bound to: the request's method and params, canonical / 保留的回答绑定的请求
const requestKey = (method, params) => toHex(keccak256(utf8ToBytes(canonicalJSON({ method, params }))))
/** how long a signed answer is kept for a retry, after its ts: a client refuses an older ts (TAPI-21 ±300 s) / 回答保留时长 */
export const GRANT_ANSWER_KEEP_S = GRANT_SKEW_S

/**
 * The called app's check of a request's top-level `grant` (steps 1-13; cheap checks first, chain
 * reads last: names and holders are first read at step 10, after the visitor's signature (an EIP-1271 wallet is asked at
 * step 8; an ECDSA signature needs no read); the first failure stops). Returns { ok: false, reason, detail } or { ok: true, hash, message, lease,
 * record } where `lease` must be committed once the answer is delivered (or released) and `record` is what the handler
 * sees as ctx.grant. A chain-read failure THROWS (nothing is reserved; the same id may be retried). A refusal
 * `replayed` may carry `resend`: the envelope signed for this very request at its first delivery (G-3).
 *   o.chainId, o.hub        the service's chain and its DeWEB hub (the grant domain)
 *   o.me = { container, name }   this service: its container and its canonical name
 *   o.manifest              this service's manifest (the methods that take a grant)
 *   o.method, o.id, o.params     the request as the provider parsed it (the params it signs over)
 *   o.voucherSent           whether the request carried a `voucher` member
 *   o.now, o.store, o.chain (holderOf, resolveName, isValidSignature)
 *   o.window                { calls, windowS } or absent: the rate-limit window of (caller, user); needs store.take
 * B 侧核验（第 1–13 步，廉价在前、读链在后：名字与持有人从第 10 步才读，在用户签名之后（合约钱包在第 8 步问链，ECDSA 不读链）；第一个失败即停）。读链失败抛出，不预留，同 id 可重试。
 */
export async function verifyVisitorGrant(wire, o) {
  const no = (reason, detail) => ({ ok: false, reason, detail })
  // 1 shape, v, chainId / 形状
  if (!isPlainObject(wire)) return no('malformed', 'grant must be an object')
  if (Object.keys(wire).sort().join() !== 'chainId,message,proof,userSig,v') return no('malformed', 'grant must have exactly v, chainId, message, userSig, proof')
  if (wire.v !== GRANT_FORMAT_VERSION) return no('malformed', `v must be ${GRANT_FORMAT_VERSION}`)
  if (wire.chainId !== o.chainId) return no('malformed', `chainId must be ${o.chainId}`)
  let m
  try { m = normalizeGrant(wire.message, { wire: true }) } catch (e) { return no('malformed', e.message) }
  if (typeof wire.userSig !== 'string' || !new RegExp(`^0x(?:[0-9a-fA-F]{2}){65,${MAX_USER_SIG_BYTES}}$`).test(wire.userSig)) return no('malformed', 'userSig must be 0x and 65 to 1024 bytes')
  const p = wire.proof
  if (!isPlainObject(p) || Object.keys(p).sort().join() !== 'sig,ts' || !Number.isSafeInteger(p.ts) || p.ts < 0 || typeof p.sig !== 'string') return no('malformed', 'proof must be { ts, sig }')
  // 2 the audience is me: container and name, compared as they are (no chain read here; the holder is read after the
  // visitor's signature, FIXED G-4) / 受众是我：容器与名字只做比对（这里不读链；持有人在用户签名之后才读）
  if (!eqAddr(m.audience, o.me.container) || m.audienceName !== o.me.name) return no('wrong-audience', `this service is ${o.me.name}`)
  // 3 the method is granted, and every granted method is one of mine that takes a grant / 方法在范围内
  const takes = (name) => (o.manifest?.methods ?? []).some((d) => d.name === name && GRANT_MODES.has(d.grant))
  if (!m.methods.includes(o.method) || !takes(o.method)) return no('method-out-of-scope', o.method)
  const foreign = m.methods.find((x) => !takes(x))
  if (foreign) return no('method-out-of-scope', `${foreign} takes no grant here`)
  // 4 time window / 时间窗
  if (o.now + GRANT_SKEW_S < m.notBefore || o.now >= m.expires) return no('expired', `valid ${m.notBefore}..${m.expires}, now ${o.now}`)
  // 5 the statement, rebuilt and compared character for character / 逐字重建比对
  if (!statementMatches(m)) return no('statement-mismatch')
  const hash = grantHashOf(o.chainId, o.hub, m)
  // FIXED IR-2 (review 2026-10-22): the revocation (now step 9) is checked after the visitor's signature (step 8). Before it,
  // anyone could forge a grant naming any `user` and read `revoked` against a later refusal: a probe of that visitor's
  // revokedBefore here. / 撤销改在访客签名之后检查；之前任何人都能伪造写着任意 user 的授权，探出该访客在此的 revokedBefore。
  const revokedHere = () => o.store.isRevoked(m.user, hash, m.notBefore, m.expires)
  // 6 the call proof: the caller's key signed THIS request (id, method, params) within the skew / 调用证明
  if (Math.abs(p.ts - o.now) > GRANT_SKEW_S) return no('bad-proof', 'proof ts is out of the window')
  const signer = recoverCallProofSigner({ audience: o.me.container, grantHash: hash, id: o.id, method: o.method, params: o.params, ts: p.ts }, p.sig)
  if (!signer || !eqAddr(signer, m.callerKey)) return no('bad-proof')
  // 7 replay: (hash, id) already delivered. FIXED G-3: when the store kept the answer signed for THIS request (same
  // method and params; the proof above shows the grant's callerKey sent it), it is handed back to be sent again as it
  // was; otherwise "replayed". / 已交付即重放；存储里有为同一请求签好的回答时交回原样重发，否则 replayed。
  if (await o.store.delivered(hash, o.id)) {
    const kept = typeof o.store.answerOf === 'function' ? await o.store.answerOf(hash, o.id) : null
    // never for a grant revoked since (IR-2) / 此后被撤销的授权不重发
    if (kept && kept.req === requestKey(o.method, o.params) && !(await revokedHere())) return { ...no('replayed'), resend: kept.env }
    return no('replayed')
  }
  // FIXED IR-3: the same (hash, id) still in progress is a replay now, before any read or the window / 进行中的同一 (hash, id) 在此即为重放
  if (typeof o.store.inFlight === 'function' && await o.store.inFlight(hash, o.id)) return no('replayed')
  // 8 the visitor signed it (ECDSA, or EIP-1271 for a contract wallet) / 用户签名
  if (!(await signedBy(m.user, grantDigest(o.chainId, o.hub, m), wire.userSig, o.chain))) return no('bad-user-signature')
  // 9 (was 6; IR-2) revoked here (by hash, or by revokedBefore) / 本地撤销表
  if (await revokedHere()) return no('revoked')
  // 10 my current holder is the one the visitor saw (FIXED G-4: read after every cheap check and the visitor's
  // signature, so a grant that fails them costs no read) / 我当前的持有人就是访客看到的那个：排在全部廉价检查与用户签名之后才读
  const mine = await o.chain.holderOf(o.me.container)
  const myHolder = typeof mine === 'string' ? mine : mine?.holder
  if (!eqAddr(m.audienceHolder, myHolder)) return no('audience-holder-changed')
  // the 2.0 default refuses this service when it is not opened or not activated: so does the grant (FIXED, TAP-10 §6.2)
  // 2.0 默认会拒绝未开通、未激活的服务：授权同样拒绝
  const myStatus = siteStatusOf(mine)
  if (myStatus !== 'ok') return no(`audience-${myStatus}`, `${o.me.name} is ${myStatus} (TAP-10 §6.2)`)
  // 11 the caller: its name resolves to its container, and its holder is the one the visitor saw / 调用方身份
  const a = await o.chain.resolveName(m.callerName)
  if (!a || !eqAddr(a.container, m.caller)) return no('caller-name-mismatch')
  if (!eqAddr(a.holder, m.callerHolder)) {
    // for good: A coming back to the old holder does not restore it (#29 item 4) / 永久撤销
    await o.store.revoke(m.user, [hash], m.expires)
    return no('caller-holder-changed')
  }
  // the caller's name as the 2.0 default resolves it: not opened or not activated is refused (TAP-10 §6.2)
  // 调用方名字按 2.0 默认解析：未开通或未激活即拒绝
  const callerStatus = siteStatusOf(a)
  if (callerStatus !== 'ok') return no(`caller-${callerStatus}`, `${m.callerName} is ${callerStatus} (TAP-10 §6.2)`)
  // 12 no grant together with a voucher (the statement says "includes no payment") / 禁止与凭证并存
  if (o.voucherSent) return no('voucher-not-allowed')
  // the rate-limit key grant:<caller>:<user>, across all grants of the pair, only when the operator set a window; keyed on
  // what steps 8-11 proved, so nobody can spend a visitor's window with a grant the visitor did not sign
  // 限流键 grant:<caller>:<user>（同一对的全部授权共用），只在运营者配置了窗口时；按第 8–11 步已证明的身份分桶，别人无法用访客没签的授权耗掉它
  if (o.window) {
    const wait = await o.store.take(`grant:${m.caller.toLowerCase()}:${m.user.toLowerCase()}`, o.window.calls, o.window.windowS)
    if (wait) return no('rate-limited', `at most ${o.window.calls} calls in ${o.window.windowS} s for this caller and visitor; retry in ${wait} s`)
  }
  // 13 the count: reserve now, commit on delivery, release on failure / 配额租约
  const lease = await o.store.reserve(hash, o.id, m.maxCalls, m.expires)
  if (lease?.replayed) return no('replayed')
  if (!lease) return no('exhausted', `${m.maxCalls} calls used`)
  const record = { hash, user: m.user, caller: m.caller, callerName: m.callerName, callerKey: m.callerKey, methods: [...m.methods], used: lease.used, maxCalls: m.maxCalls, expires: m.expires }
  return { ok: true, hash, message: m, lease, record }
}

/** The wrapper's own deadline for a call with a grant, below @tapeapi/server's default handlerTimeoutMs (25 s) / 包装器自己的时限 */
export const GRANT_HANDLER_TIMEOUT_MS = 20_000

/**
 * Put the grant check in front of a provider's handlers (createProvider's `methods`). Needs the provider to pass
 * `ctx.request` (the request's top-level members other than method and params; @tapeapi/server does since this
 * experimental change). For a request with a `grant`: verify it, run the handler with `ctx.grant`, and return the
 * handler's object result with the grant record `grant: { hash, caller, user, used, maxCalls }` added, which the
 * provider then signs. A handler returning a non-object, or using the member `grant` itself, is answered INTERNAL
 * and the call is not counted. Without a `grant`: a method whose descriptor says grant "required" is refused; any other
 * runs exactly as before (ctx.grant is null).
 * A call with a grant has its own deadline, `timeoutMs` (FIXED G-6; default GRANT_HANDLER_TIMEOUT_MS, 20 s): when the check
 * and the handler together take longer, the call is released and answered INTERNAL, and a handler that finishes later is
 * never counted. Set it BELOW the provider's handlerTimeoutMs (25 s by default): the provider's own timeout cannot reach
 * the wrapper, and a handler that outlived it used to be counted for an answer that was never sent.
 * `perGrantWindow: { calls, windowS }` (off by default; maxCalls already caps each grant) also limits, per (caller, visitor),
 * the calls with a verified grant over a sliding window, across all their grants: one more is refused `grant: rate-limited`
 * and not counted (a call that then fails still used its place in the window).
 *   o = { chainId, hub, name, store, chain, clock, timeoutMs, perGrantWindow }
 * 把授权核验放在处理器前面；带授权的请求在结果里写入授权记录，由服务端签名。处理器返回非对象或自用 grant 成员 → INTERNAL，不计次。
 * 带授权的调用有自己的时限 timeoutMs（默认 20 秒）：核验加处理器超时即释放、答 INTERNAL，之后才完成的处理器绝不计次。
 * 须小于服务端的 handlerTimeoutMs（默认 25 秒）：服务端的超时够不到包装器，过去超时后才完成的处理器会为没发出的回答计一次。
 * perGrantWindow（默认关）按（调用方, 访客）在滑动窗口内限量，跨该对的全部授权；超出答 grant: rate-limited，不计次。
 */
export function grantMethods(methods, o) {
  if (!o || typeof o.name !== 'string' || !o.store || !o.chain || !isAddress(o.hub) || !Number.isSafeInteger(o.chainId)) throw new TapeAPIError('INVALID_ARGUMENT', 'grantMethods(methods, { chainId, hub, name, store, chain, clock })')
  const clock = o.clock ?? (() => Math.floor(Date.now() / 1000))
  const timeoutMs = o.timeoutMs ?? GRANT_HANDLER_TIMEOUT_MS
  const window = o.perGrantWindow ?? null
  if (window !== null && (!isPlainObject(window) || !Number.isSafeInteger(window.calls) || window.calls < 1 || !Number.isSafeInteger(window.windowS) || window.windowS < 1)) throw new TapeAPIError('INVALID_ARGUMENT', 'grantMethods: perGrantWindow must be { calls, windowS } (positive integers)')
  if (window !== null && typeof o.store.take !== 'function') throw new TapeAPIError('INVALID_ARGUMENT', 'grantMethods: perGrantWindow needs a store with take(key, calls, windowS)')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TapeAPIError('INVALID_ARGUMENT', 'grantMethods: timeoutMs must be a positive integer (milliseconds), below the provider\'s handlerTimeoutMs')
  const out = {}
  for (const [name, handler] of Object.entries(methods)) {
    out[name] = async (params, ctx) => {
      if (!ctx?.request || typeof ctx.request !== 'object') throw new TapeAPIError('INTERNAL', 'this provider does not pass ctx.request, which @tapeapi/interop needs')
      const def = ctx.method
      const raw = ctx.request.grant
      if (raw === undefined) {
        if (def?.grant === 'required') throw grantRefusal('required')
        return handler(params, { ...ctx, grant: null })
      }
      // FIXED G-6: the check and the handler race the wrapper's own deadline; past it the lease is released and nothing
      // that finishes later is counted. / 核验与处理器和包装器自己的时限竞速；超时即释放，之后完成的一律不计次。
      let lease = null, late = false, timer
      const work = (async () => {
        const v = await verifyVisitorGrant(raw, {
          chainId: o.chainId, hub: o.hub, me: { container: ctx.manifest.container, name: o.name }, manifest: ctx.manifest,
          method: def.name, id: ctx.request.id, params, voucherSent: ctx.request.voucher !== undefined, now: clock(), store: o.store, chain: o.chain, window,
        })
        if (!v.ok) {
          // FIXED G-3: the answer of the first delivery, sent again byte for byte by the provider / 首次交付的回答，由服务端原样重发
          if (v.resend && typeof ctx.resend === 'function') return ctx.resend(v.resend)
          throw grantRefusal(v.reason, v.detail)
        }
        lease = v.lease
        if (late) { await v.lease.release(); return undefined }
        let result
        try { result = await handler(params, { ...ctx, grant: v.record }) } catch (e) { v.lease.release(); throw e }
        if (late) { await v.lease.release(); return undefined }
        if (!isPlainObject(result) || hasOwn(result, GRANT_RESULT_MEMBER)) { v.lease.release(); throw new TapeAPIError('INTERNAL', `method ${def.name} must return a JSON object without a "grant" member: the grant record goes there`) }
        const answer = { ...result, grant: { hash: v.hash, caller: v.message.caller, user: v.message.user, used: v.lease.used, maxCalls: v.message.maxCalls } }
        try { canonicalJSON(answer) } catch (e) { v.lease.release(); throw new TapeAPIError('INTERNAL', `result of ${def.name} has no canonical form: ${e.message}`) }
        await v.lease.commit()
        // FIXED G-3: keep the envelope once the provider has signed it and is sending it (never a result it then refused)
        // 服务端签好并发出时保留这份信封（服务端随后拒发的结果不保留）
        if (typeof ctx.onSigned === 'function' && typeof o.store.keepAnswer === 'function') {
          const id = ctx.request.id, req = requestKey(def.name, params), expires = v.message.expires
          ctx.onSigned((env) => o.store.keepAnswer(v.hash, id, env, { until: Math.min(expires + 2 * GRANT_SKEW_S, env.ts + GRANT_ANSWER_KEEP_S), req }))
        }
        return answer
      })()
      work.catch(() => {})                 // after the deadline nobody awaits it / 超时后无人等待它
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          late = true
          if (lease) lease.release()
          reject(new TapeAPIError('INTERNAL', `method ${def.name} with a visitor grant took over ${timeoutMs} ms: released, not counted`))
        }, timeoutMs)
      })
      try { return await Promise.race([work, deadline]) } finally { clearTimeout(timer) }
    }
    WRAPPED.add(out[name])
  }
  return out
}

/**
 * The free method `grant_revoke` (revocation tier 1): params { revocation: GrantRevocation, sig }. Anyone may deliver it;
 * it takes effect only if `revocation.user` signed it (ECDSA or EIP-1271). The signed answer is the receipt:
 * { revoked: { user, grantHashes, revokedBefore, issued, hash } }. It binds this one service only.
 * 免费方法 grant_revoke：任何人可投递，只有 user 签名成立才生效；签名回答即回执。只约束这一个服务。
 */
export function grantRevokeHandler({ chainId, hub, store, chain, clock = () => Math.floor(Date.now() / 1000) }) {
  return async (params) => {
    let r
    try { r = normalizeGrantRevocation(params?.revocation) } catch (e) { throw grantRefusal('malformed', e.message) }
    if (r.issued > clock() + GRANT_SKEW_S) throw grantRefusal('malformed', 'issued lies in the future')
    if (!(await signedBy(r.user, grantRevocationDigest(chainId, hub, r), params?.sig, chain))) throw grantRefusal('bad-user-signature')
    if (r.grantHashes.length) await store.revoke(r.user, r.grantHashes)
    if (r.revokedBefore > 0) await store.revokeBefore(r.user, r.revokedBefore)
    return { revoked: { ...r, hash: toHex(hashGrantRevocation(r)) } }
  }
}

/**
 * The calling app's builder, with the identities read from the chain (never from the request): A's own container and
 * holder from its name, B's holder from B's container. Then makeGrant. / 调用方的构造辅助：身份全部读链，然后 makeGrant
 *   o = { chain, callerName, audience, audienceName, user, callerKey, methods, maxCalls, lifeS?, lang?, now, nonce? }
 */
export async function prepareGrant(o) {
  const a = await o.chain.resolveName(o.callerName)
  if (!a) throw new TapeAPIError('GRANT_INVALID', `${o.callerName} does not resolve to a container on this chain`)
  const b = await o.chain.resolveName(o.audienceName)
  if (!b || !eqAddr(b.container, o.audience)) throw new TapeAPIError('GRANT_INVALID', `${o.audienceName} does not resolve to ${o.audience}`)
  // a name the 2.0 default refuses (not-opened, unpaid) is refused here too, as the service would / 默认会拒绝的名字这里同样拒绝
  for (const [name, v] of [[o.callerName, a], [o.audienceName, b]]) { const st = siteStatusOf(v); if (st !== 'ok') throw new TapeAPIError('GRANT_INVALID', `${name} is ${st} (TAP-10 §6.2): a grant naming it would be refused`, { data: { status: st } }) }
  return makeGrant({ ...o, caller: a.container, callerHolder: a.holder, audienceHolder: b.holder })
}
