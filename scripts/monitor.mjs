#!/usr/bin/env node
// Read-only monitor for the live TapeAPI services. Sends no transactions, holds no keys.
// For each service: GET health, resolve it from the chain exactly as a client would (SDK, 3 public BSC nodes of distinct operators, quorum 2),
// check that the on-chain manifest's signer is the one the service answers with, count the days until its delegation
// expires, and make one real call whose signed envelope the SDK verifies. Also GET the website and the docs.
// Relay async delivery: post one test frame to a random room, let the relay sit idle for ASYNC_WAIT_S (60 s), and read
// it back through a brand-new client -- the check that would have caught RELAY-1 (see checkRelayAsync below).
// Activation (TAP-10 §6.3, TAP-11): a service's name must be activated on chain (DomainBinding isLive(name, container) or
// isContainerLive(container)), else a TAP-11 client gets "unpaid" and does not resolve it. The monitor reports it per service:
// not activated = a WARNING only (the service still answers and its site files stay readable, so it must not turn the
// scheduled run red); activated = the paid-until date and the days left (containerPaidUntil): under 14 days a warning,
// under 3 days (or past) a problem; unreadable = a warning.
// Exit 0 when everything is healthy, 1 when anything is down, a delegation expires in fewer than 14 days, or an activation
// that exists expires in fewer than 3 days. Warnings (listed under "Notes") never change the exit code.
// 2.0: the client is the SDK's default, the TAP-10 conformance mode, so a failed resolve names what is wrong in e.data.status and the
// monitor sorts on it instead of calling every failure the same: not-opened (the container was never opened), unpaid (the payment
// lapsed: no default client resolves the service) and store-changed (the site store or payment contract runs an implementation the
// SDK does not list) are problems, the last two raised as ALERTs at the top of the report; unavailable (the nodes could not
// answer, after the retry) is counted on its own as a node problem; unsupported (the monitor's own target form) and every other
// status is a problem that names its status. The implementation-slot check reads the two site proxies' ERC-1967 slots through
// api.siteStatus (the same judgement the SDK's resolve makes), whether or not the resolve worked. A resolve that works records
// the default client's outcome ('resolved') in chain.conform, and the report says it per service ("Default-mode resolution").
//
//   node scripts/monitor.mjs                     Markdown report on stdout (used as the GitHub issue body)
//   node scripts/monitor.mjs --json              the raw results and the evaluation as JSON
//   node scripts/monitor.mjs --async-wait-s=N    idle time of the relay async check (default 60; env ASYNC_WAIT_S)
//
// 只读监控：不发交易、不持有任何密钥。对每个服务：取健康检查；像客户端一样用 SDK 从链上解析它（3 家不同运营方的公共节点、quorum 2）；
// 核对链上清单的 signer 与服务实际使用的一致；计算委托到期天数；做一次真实调用并由 SDK 验签。另外检查官网与文档。
// 中继异步投递：往随机房间发一帧测试帧，让中继闲置 ASYNC_WAIT_S（60 秒），再用全新的客户端读回——能抓住 RELAY-1 的那项检查。
// 激活（TAP-10 §6.3、TAP-11）：服务的名字必须在链上激活（DomainBinding 的 isLive(名字, 容器) 或 isContainerLive(容器)），否则按 TAP-11
// 的客户端得到 unpaid、不解析它。监控对每个服务报告：未激活只是警告（服务照常应答、站点文件仍可读取，不能让定时任务变红）；
// 已激活则给出到期日与剩余天数（containerPaidUntil）：不足 14 天警告，不足 3 天（或已过期）算问题；读不到则警告。
// 全部健康退出码 0；任何服务不可用、委托不足 14 天到期、或已有的激活不足 3 天到期，退出码 1。警告（列在 Notes 下）不改变退出码。
// 2.0：客户端用 SDK 的默认（TAP-10 一致模式），解析失败时 e.data.status 说明原因，监控按它分类而不是一律同样处理：not-opened（容器从未
// 开通）、unpaid（付费到期：任何默认客户端都不再解析该服务）、store-changed（站点存储或付费合约运行着 SDK 未列出的实现）都算问题，
// 后两者在报告顶部作为 ALERT 醒目告警；unavailable（节点在重试后仍无法回答）单独计数为节点问题；unsupported（监控自己的目标写法）和
// 其它状态都是写明状态的问题。实现槽检查经 api.siteStatus 读两个站点代理的 ERC-1967 槽（与 SDK 的 resolve 同一判定），无论解析成功与否都做。
// 解析成功时把默认客户端的结果（'resolved'）记在 chain.conform，报告逐个服务写明（"Default-mode resolution"）。
import { fileURLToPath } from 'node:url'
import { rpcUrlsFor } from '../sdk/src/rpc-defaults.js'

// The SDK's defaults: three distinct operators (NodeReal, Alchemy, 48 Club) / SDK 默认：三家运营方
export const RPC_URLS = rpcUrlsFor(56)
export const PROCESSOR = '0xe02c26c7432A7121168AA9B610DE24eCf9a1a414'   // processor 1013
export const HEALTH_PATH = '/tapeapi/v1/health'
export const WARN_DAYS = 14
// An activation with fewer days left than this is a problem (exit 1); fewer than WARN_DAYS is a warning.
// 已激活的名字剩余天数少于此值算问题（退出码 1）；少于 WARN_DAYS 为警告。
export const ACTIVATION_FAIL_DAYS = 3
const DAY_S = 86400
// How long the relay async check leaves the room idle. Cloudflare evicts an idle Durable Object within seconds to about
// fifteen, so 60 s is well past the point where an in-memory room (RELAY-1) is gone. / 异步检查让房间闲置的时长：
// Cloudflare 几秒到十几秒回收空闲的 Durable Object，60 秒远超只在内存里的房间（RELAY-1）消失的时间点。
export const ASYNC_WAIT_S = 60
// The service the async check posts to / 异步检查投递的服务
export const ASYNC_SERVICE = 'relay'

export const randomRoom = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')

// The one list to extend. `probe` is a free method whose answer the SDK verifies against the on-chain signer;
// `check` says whether the verified result looks right.
// 要扩展就改这一处。`probe` 是一个免费方法，SDK 按链上 signer 验签；`check` 判断验过签的结果是否合理。
export const SERVICES = [
  {
    name: 'api', label: '11.1013.tape', base: 'https://api.tapeapi.fun', circuits: PROCESSOR, tokenId: 11,
    probe: {
      method: 'blockNumber', params: () => ({}),
      check: (r) => Number.isInteger(r?.blockNumber) && r.blockNumber > 0,
      detail: (r) => `block ${r?.blockNumber}`,
    },
  },
  {
    name: 'relay', label: '12.1013.tape', base: 'https://relay.tapeapi.fun', circuits: PROCESSOR, tokenId: 12,
    probe: {
      // A random room nobody posted to: TAPI-26 says the answer is no frames and epoch null, and it creates nothing.
      // 一个没人发过消息的随机房间：TAPI-26 规定答案是无帧、epoch 为 null，且不会创建房间。
      method: 'relayRecv', params: () => ({ room: randomRoom(), after: -1, waitMs: 0 }),
      check: (r) => Array.isArray(r?.frames) && r.frames.length === 0,
      detail: (r) => `empty room, ${Array.isArray(r?.frames) ? r.frames.length : '?'} frames`,
    },
  },
]
export const PAGES = [
  { name: 'website', url: 'https://tapeapi.fun/' },
  { name: 'docs', url: 'https://tapeapi.fun/docs/' },
]

// ---------------------------------------------------------------- pure helpers (unit-tested, no network) / 纯函数

const lc = (a) => (typeof a === 'string' ? a.toLowerCase() : a)
const short = (a) => (typeof a === 'string' && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a ?? '-'))
const msg = (e) => String(e?.code ? `${e.code}: ${e.message}` : e?.message ?? e).replace(/\s+/g, ' ').slice(0, 200)

/** Whole days from `now` to `expires` (both unix seconds), rounded down; negative once expired. */
export function daysUntil(expires, now) { return Math.floor((expires - now) / DAY_S) }

/** The expiry that bites first: the on-chain manifest's (what clients check) or the service's own (what it enforces). */
export function effectiveExpiry(svc) {
  const xs = [svc?.chain?.expires, svc?.health?.delegationExpires].filter((x) => Number.isFinite(x))
  return xs.length ? Math.min(...xs) : null
}

const dateOf = (t) => new Date(t * 1000).toISOString().slice(0, 10)

/**
 * What the activation of one service result means for the evaluation: { problems[], warnings[] }.
 * Not activated is a warning, never a problem: under TAP-11 a client answers "unpaid" and does not resolve the service, but the
 * service itself is up and its site files stay readable (TAP-10 §6.3), and the 30-minute run must not stay red for it.
 * 未激活只是警告、绝不算问题：按 TAP-11，客户端得到 unpaid、不解析该服务，但服务本身可用、站点文件仍可读取；30 分钟一次的运行不能为此一直变红。
 */
export function activationFindings(s, now, warnDays = WARN_DAYS) {
  const out = { problems: [], warnings: [] }
  const a = s?.activation
  if (!a || a.skipped) return out          // not read (the chain row already says why) / 没读（链上那一行已说明原因）
  const n = s.name
  if (a.error) { out.warnings.push(`${n}: activation could not be read (${a.error}); whether ${s.label ?? n} is activated is unknown`); return out }
  if (!a.live) {
    out.warnings.push(`${n}: ${s.label ?? n} is not activated (isLive and isContainerLive are false): under TAP-11 a client gets "unpaid" and does not resolve this service; the service still answers and its site files stay readable (TAP-10 §6.3).${a.feeText ? ` monthlyFee() now: ${a.feeText} per 30 days.` : ''}`)
    return out
  }
  if (!Number.isFinite(a.paidUntil)) return out    // activated, expiry not readable: nothing to count / 已激活，到期时间读不到：无从计算
  const days = daysUntil(a.paidUntil, now)
  if (a.paidUntil <= now) out.problems.push(`${n}: activation EXPIRED ${dateOf(a.paidUntil)}; TAP-11 clients get "unpaid" until it is paid again`)
  else if (days < ACTIVATION_FAIL_DAYS) out.problems.push(`${n}: activation expires in ${days} days (${dateOf(a.paidUntil)}); pay it now or TAP-11 clients get "unpaid"`)
  else if (days < warnDays) out.warnings.push(`${n}: activation expires in ${days} days (${dateOf(a.paidUntil)}); pay the next month soon`)
  return out
}

/** The activation cell of the services table. / 服务表里的激活一栏。 */
function activationCell(s, now) {
  const a = s.activation
  if (!a) return '-'
  if (a.skipped) return 'skipped'
  if (a.error) return `unreadable (${a.error})`
  if (!a.live) return `NOT ACTIVATED (TAP-11: unpaid)${a.feeText ? `, monthlyFee ${a.feeText} / 30 d` : ''}`
  return Number.isFinite(a.paidUntil) ? `active until ${dateOf(a.paidUntil)} (${daysUntil(a.paidUntil, now)} d)` : 'active (paid-until unknown)'
}

/**
 * What a failed on-chain resolve means, by the TAP-10 outcome name the SDK puts in e.data.status (chain.status):
 * { problems[], alerts[], unavailable }. No status (an older result, or an error that is not a TapeAPIError) keeps the one
 * line it always had. `alerts` are problems too (they are in `problems` as well): the report puts them at the top.
 * 链上解析失败的含义，按 SDK 放在 e.data.status 里的 TAP-10 结果名（chain.status）分类。没有 status（旧结果、不是 TapeAPIError 的错误）
 * 保持原来的一行。alerts 同时也是 problems，报告把它们放在最上面。
 */
export function chainFailure(s) {
  const out = { problems: [], alerts: [], unavailable: false, kind: null }
  const c = s?.chain ?? {}
  if (!c.error) return out
  const n = s.name
  const impls = (list) => (Array.isArray(list) ? list.filter((i) => i && i.accepted === false).map((i) => `${i.role} ${i.proxy} runs ${i.implementation}`).join('; ') : '')
  switch (c.status) {
    case undefined: case null: out.problems.push(`${n}: on-chain resolve failed (${c.error})`); return out
    case 'unpaid': {
      out.kind = 'unpaid'
      const line = `${n}: UNPAID: ${s.label ?? n} is no longer activated on chain (isLive and isContainerLive are false): the paid period has run out or was never paid, and no TAP-11 client resolves this service until the holder activates it again (DomainBinding.bind; TAP-10 §6.3) (${c.error})`
      out.problems.push(line); out.alerts.push(line); return out
    }
    case 'store-changed': {
      out.kind = 'storeChanged'
      const which = impls(c.implementations)
      const line = `${n}: STORE-CHANGED: the site store or payment contract was upgraded to an implementation this SDK does not list${which ? ` (${which})` : ''}: SDK clients refuse to read ${s.label ?? n} until the SDK lists the new implementation (TAP-10 §6.1); check what TapeOut deployed before anything else (${c.error})`
      out.problems.push(line); out.alerts.push(line); return out
    }
    case 'not-opened': out.kind = 'notOpened'; out.problems.push(`${n}: NOT OPENED: the container of ${s.label ?? n} has not been opened (TAP-10 §6.2); the service cannot be resolved (${c.error})`); return out
    case 'unavailable': out.kind = 'unavailable'; out.unavailable = true; out.problems.push(`${n}: chain nodes unavailable: the on-chain resolve got no answer it could adopt after the retry (${c.error}); this is the nodes, not the service`); return out
    case 'unsupported': out.kind = 'unsupported'; out.problems.push(`${n}: the monitor's target for ${s.label ?? n} is not a form this client resolves (unsupported): fix SERVICES in scripts/monitor.mjs (${c.error})`); return out
    default: out.kind = 'other'; out.problems.push(`${n}: on-chain resolve failed [${c.status}] (${c.error})`); return out
  }
}

/**
 * The implementation-slot check of one service result (s.slots, from checkSlots): { problems[], alerts[], warnings[], unavailable }.
 * An unaccepted implementation is store-changed whatever the resolve said; when the resolve already said store-changed it is not
 * said twice. A slot read that failed is a warning (the resolve line carries the outage itself).
 * 一个服务结果的实现槽检查（s.slots，来自 checkSlots）。不被接受的实现无论解析怎么说都是 store-changed；解析已经说过就不重复。读不到只是警告。
 */
export function slotFindings(s) {
  const out = { problems: [], alerts: [], warnings: [], unavailable: false }
  const k = s?.slots
  if (!k) return out
  const n = s.name
  if (k.error) { out.warnings.push(`${n}: implementation slots of the site store and payment contract could not be read (${k.error})`); out.unavailable = k.status === 'unavailable'; return out }
  const bad = Array.isArray(k.implementations) ? k.implementations.filter((i) => i && i.accepted === false) : []
  if (bad.length && s.chain?.status !== 'store-changed') {
    const line = `${n}: STORE-CHANGED: ${bad.map((i) => `${i.role} ${i.proxy} runs implementation ${i.implementation}`).join('; ')}, which this SDK does not list: SDK clients refuse to read ${s.label ?? n} until the SDK lists it (TAP-10 §6.1)`
    out.problems.push(line); out.alerts.push(line)
  }
  return out
}

/**
 * results: { services: [{ name, label, health: { status, ok, signer, delegationExpires, latencyMs, error },
 *                         chain: { signer, expires, conform?, error, status? }, call: { method, ok, skipped, error },
 *                         activation?: { live, paidUntil, feeText, error, skipped },
 *                         slots?: { status, implementations: [{ role, proxy, implementation, accepted }], error } }],
 *            pages: [{ name, url, status, error }] }
 * now: unix seconds.  Returns { healthy, problems[], warnings[] }, plus `alerts[]` (the problems to put first: unpaid, store-changed)
 * and `counts` ({ unpaid, storeChanged, notOpened, unavailable, unsupported, other }: services per kind) only when there are any.
 * chain.status (the SDK's e.data.status) sorts a failed resolve, see chainFailure(); chain.error without it is the plain line.
 * `activation` is judged by activationFindings(): only an activation that expires in fewer than 3 days is a problem; every other
 * finding (not activated, fewer than 14 days, unreadable) is a warning, and a missing or skipped one says nothing.
 * activation 由 activationFindings() 判断：只有已激活且不足 3 天到期才算问题，其余（未激活、不足 14 天、读不到）都是警告；缺失或跳过则不说话。
 */
export function evaluate(results, now = Math.floor(Date.now() / 1000), { warnDays = WARN_DAYS } = {}) {
  const problems = []
  const warnings = []
  const alerts = []
  const counts = {}
  const count = (k) => { counts[k] = (counts[k] ?? 0) + 1 }
  for (const s of results?.services ?? []) {
    const n = s.name
    const h = s.health ?? {}
    const c = s.chain ?? {}
    if (h.error || h.status !== 200) problems.push(`${n}: health check failed (${h.error ?? `HTTP ${h.status}`})`)
    else if (h.ok !== true) problems.push(`${n}: health answers ok=${JSON.stringify(h.ok)}`)
    const cf = chainFailure(s)
    problems.push(...cf.problems); alerts.push(...cf.alerts)
    const sf = slotFindings(s)
    problems.push(...sf.problems); alerts.push(...sf.alerts); warnings.push(...sf.warnings)
    if (cf.kind) count(cf.kind)
    if (sf.alerts.length) count('storeChanged')
    if (sf.unavailable && !cf.unavailable) count('unavailable')
    if (c.signer && h.signer && lc(c.signer) !== lc(h.signer)) problems.push(`${n}: signer mismatch, chain ${c.signer} vs service ${h.signer}`)
    else if (c.signer && !h.error && h.status === 200 && !h.signer) problems.push(`${n}: health reports no signer`)
    const exp = effectiveExpiry(s)
    if (exp == null) { if (!c.error && !h.error) problems.push(`${n}: delegation expiry unknown`) }
    else if (exp <= now) problems.push(`${n}: delegation EXPIRED ${new Date(exp * 1000).toISOString().slice(0, 10)}; every answer is rejected until the holder re-signs it`)
    else if (daysUntil(exp, now) < warnDays) problems.push(`${n}: delegation expires in ${daysUntil(exp, now)} days (${new Date(exp * 1000).toISOString().slice(0, 10)}); re-sign it now`)
    if (Number.isFinite(c.expires) && Number.isFinite(h.delegationExpires) && c.expires !== h.delegationExpires) {
      warnings.push(`${n}: service reports delegationExpires ${h.delegationExpires}, on-chain manifest says ${c.expires}`)
    }
    const af = activationFindings(s, now, warnDays)
    problems.push(...af.problems)
    warnings.push(...af.warnings)
    const k = s.call ?? {}
    if (!k.skipped && (k.error || k.ok !== true)) problems.push(`${n}: verified ${k.method ?? 'call'} failed (${k.error ?? 'unexpected result'})`)
  }
  for (const p of results?.pages ?? []) {
    if (p.error || p.status !== 200) problems.push(`${p.name}: ${p.url} ${p.error ?? `HTTP ${p.status}`}`)
  }
  // Skipped only when the relay could not be resolved from the chain, which its own row already reports.
  // 只有中继无法从链上解析时才跳过，那一行已经报告了。
  const a = results?.relayAsync
  if (a && !a.skipped && a.ok !== true) {
    problems.push(`${a.name ?? ASYNC_SERVICE}: async delivery ${a.kind === 'unreachable' ? 'unreachable' : 'failed'} after ${a.waitS ?? '?'} s idle (${a.error ?? 'unexpected result'})`)
  }
  return { healthy: problems.length === 0, problems, warnings, ...(alerts.length ? { alerts } : {}), ...(Object.keys(counts).length ? { counts } : {}) }
}

/** The async check's idle time in ms: `--async-wait-s=N` wins over env ASYNC_WAIT_S, else ASYNC_WAIT_S (60). */
export function asyncWaitMs({ argv = process.argv, env = process.env } = {}) {
  const arg = argv.find((x) => x.startsWith('--async-wait-s='))
  const raw = arg !== undefined ? arg.slice('--async-wait-s='.length) : env.ASYNC_WAIT_S
  if (raw === undefined || raw === '') return ASYNC_WAIT_S * 1000
  const n = Number(raw)
  // A typo must not quietly turn the check into a 0 s one (which would pass even with RELAY-1): refuse it.
  // 写错的值不能悄悄变成 0 秒（那样即使 RELAY-1 也会通过）：直接拒绝。
  if (!/^\d+(\.\d+)?$/.test(String(raw).trim()) || !Number.isFinite(n) || n > 600) throw new Error(`async wait must be 0..600 seconds, got ${JSON.stringify(raw)}`)
  return Math.round(n * 1000)
}

/**
 * A random test frame the relay accepts: wire type 0x03 (a sealed invite, TAPI-26), then random bytes, 64 to 200 bytes
 * in all, base64. 0x03 is what RELAY-1 lost first (invites) and sits in the relay's protected ring, so a busy room
 * could not push it out. / 中继接受的随机测试帧：线路类型 0x03（密封邀请），其后是随机字节，共 64 到 200 字节，base64。
 * 0x03 正是 RELAY-1 最先丢的东西（邀请），且放在中继的受保护环里，不会被繁忙房间挤掉。
 */
export function testFrame() {
  const len = 64 + (crypto.getRandomValues(new Uint8Array(1))[0] % 137)    // 64..200
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  bytes[0] = 0x03
  return { bytes, b64: Buffer.from(bytes).toString('base64') }
}

// Failures below the relay's answer: the request never got a signed reply. They are retried; anything the relay
// actually answered (a signed error, a wrong result) is not. / 中继回答之前的失败：请求没拿到签名回答，会重试；
// 中继确实回答了的（签名错误、结果不对）不重试。
const NET_CODES = new Set(['PROVIDER_UNAVAILABLE', 'RPC_UNAVAILABLE', 'RPC_ERROR', 'RPC_DISAGREE', 'QUORUM_FAILED'])
// An answer, in at most 120 characters, for a problem line. JSON.stringify gives undefined for undefined and throws on a
// BigInt or a cycle; neither may end the monitor without a report (FIXED P101-2).
// 用于问题行的回答，至多 120 字符。JSON.stringify 对 undefined 返回 undefined、对 BigInt 或循环引用抛错；都不能让监控没有报告就结束。
function show(x) {
  let s
  try { s = JSON.stringify(x) } catch { s = undefined }
  return String(s ?? x).slice(0, 120)
}

export function isNetworkError(e) {
  if (e?.code) return NET_CODES.has(e.code)
  return e?.name === 'TypeError' || e?.name === 'AbortError' || e?.name === 'TimeoutError' || /fetch failed|timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket|network/i.test(String(e?.message ?? e))
}

/**
 * Judges what the fresh client read against what was posted. `sent`: { bytes, epoch }; `got`: relayRecv's result.
 * Returns null when it is exactly the one frame, same bytes, same epoch; else why not, in words.
 * 把全新客户端读到的与发出的比对：恰好一帧、字节相同、纪元相同则返回 null，否则用文字说明原因。
 */
export function judgeAsync(sent, got) {
  const frames = Array.isArray(got?.frames) ? got.frames : null
  // A signed envelope without `result` is a failure in words, never a TypeError (FIXED P101-2)
  // 没有 `result` 的签名信封是用文字说明的失败，绝不是 TypeError
  if (got === undefined) return 'relayRecv answered with no result (undefined), not { frames, next, epoch }'
  if (!frames) return `unexpected result ${show(got)}`
  const ep = got.epoch ?? null
  if (frames.length === 0) {
    return ep === null ? '0 frames, epoch null: the relay lost the room while idle'
      : `0 frames, epoch ${ep} instead of ${sent.epoch}: the relay lost the room while idle and re-created it`
  }
  if (ep !== sent.epoch) return `epoch changed from ${sent.epoch} to ${ep}: the room was re-created while idle`
  if (frames.length !== 1) return `${frames.length} frames, expected exactly 1`
  let back
  try { back = Buffer.from(String(frames[0]?.frame ?? ''), 'base64') } catch { back = null }
  if (!back || Buffer.compare(back, Buffer.from(sent.bytes)) !== 0) return `frame bytes differ from what was sent (${sent.bytes.length} bytes sent, ${back?.length ?? 0} read)`
  return null
}

/** The implementation-slot cell of the services table. / 服务表里的实现槽一栏。 */
function slotsCell(s) {
  const k = s.slots
  if (!k) return '-'
  if (k.error) return `unreadable (${k.error})`
  const list = Array.isArray(k.implementations) ? k.implementations : []
  if (!list.length) return k.status ? `not read (${k.status})` : '-'
  const bad = list.filter((i) => i.accepted === false)
  return bad.length ? `CHANGED ${bad.map((i) => `${i.role} ${short(i.implementation)}`).join(', ')}` : `ok (${list.length} accepted)`
}

/**
 * One line: the TAP-10 outcome of the default client's resolve per service ('resolved', or the status it failed with), or
 * null when no result says (results from before 2.0). / 一行：默认客户端对每个服务解析的 TAP-10 结果；没有任何结果说明时为 null。
 */
export function defaultModeLine(results) {
  const parts = (results?.services ?? []).map((s) => {
    const c = s.chain ?? {}
    const st = typeof c.conform === 'string' ? c.conform : c.error ? (typeof c.status === 'string' ? c.status : null) : null
    return st ? `${s.name} ${st}` : null
  }).filter(Boolean)
  return parts.length ? `Default-mode resolution (TAP-10): ${parts.join(', ')}.` : null
}

/** The Markdown report: one table for the services, one for the pages, then the problems. Alerts come first. */
export function report(results, evaluation, now = Math.floor(Date.now() / 1000)) {
  const when = new Date(now * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  const L = []
  const alerts = evaluation.alerts ?? []
  L.push(`## TapeAPI monitor: ${evaluation.healthy ? 'all healthy' : `${evaluation.problems.length} problem(s)${alerts.length ? `, ${alerts.length} ALERT(s)` : ''}`}`, '', `Checked ${when}.`, '')
  // unpaid and store-changed: every default client stops resolving the service, so they head the report / 它们让所有默认客户端不再解析服务，所以排在报告最前
  if (alerts.length) L.push('**ALERT**', '', ...alerts.map((p) => `> ${p}`), '')
  const c0 = evaluation.counts
  if (c0) L.push(`Chain read failures by status: ${Object.entries(c0).map(([k, v]) => `${k} ${v}`).join(', ')}.`, '')
  // 2.0: what the default client's resolve said of each service (T2) / 2.0：默认客户端对每个服务的解析结论（T2）
  const dm = defaultModeLine(results)
  if (dm) L.push(dm, '')
  L.push('| Service | Health | Latency | Signer (chain = service) | Delegation expires | Activation | Verified call | Impl slots |')
  L.push('|---|---|---|---|---|---|---|---|')
  for (const s of results.services) {
    const h = s.health ?? {}; const c = s.chain ?? {}; const k = s.call ?? {}
    const health = h.error ? `DOWN (${h.error})` : h.status !== 200 ? `DOWN (HTTP ${h.status})` : h.ok === true ? 'up' : `ok=${h.ok}`
    const lat = Number.isFinite(h.latencyMs) ? `${h.latencyMs} ms` : '-'
    const signer = c.error ? `chain: ${c.error}` : !h.signer ? short(c.signer) + ' (service: none)'
      : lc(c.signer) === lc(h.signer) ? `${short(h.signer)} match` : `MISMATCH ${short(c.signer)} / ${short(h.signer)}`
    const exp = effectiveExpiry(s)
    const expiry = exp == null ? '-' : `${new Date(exp * 1000).toISOString().slice(0, 10)} (${daysUntil(exp, now)} d)`
    const call = k.skipped ? 'skipped' : k.ok ? `${k.method} ok${k.detail ? `, ${k.detail}` : ''}${Number.isFinite(k.latencyMs) ? ` (${k.latencyMs} ms)` : ''}` : `${k.method ?? 'call'} FAILED${k.error ? ` (${k.error})` : ''}`
    L.push(`| ${s.name} \`${s.label}\` | ${health} | ${lat} | ${signer} | ${expiry} | ${activationCell(s, now)} | ${call} | ${slotsCell(s)} |`.replace(/\n/g, ' '))
  }
  L.push('', '| Page | Status | Latency |', '|---|---|---|')
  for (const p of results.pages) L.push(`| ${p.url} | ${p.error ? `DOWN (${p.error})` : p.status} | ${Number.isFinite(p.latencyMs) ? `${p.latencyMs} ms` : '-'} |`)
  const a = results.relayAsync
  if (a) {
    // DOWN: never got an answer (as a service's health); FAILED: answered, but not the frame that was posted (as a call).
    // DOWN：拿不到回答（同服务的健康检查）；FAILED：回答了，但不是发出的那一帧（同验签调用）。
    const res = a.skipped ? `skipped${a.error ? ` (${a.error})` : ''}` : a.ok ? `ok, ${a.detail ?? '1 frame'}`
      : a.kind === 'unreachable' ? `DOWN (${a.error})` : `FAILED (${a.error ?? 'unexpected result'})`
    L.push('', '| Check | Result | Idle |', '|---|---|---|')
    L.push(`| relay async delivery \`${a.label ?? ''}\` | ${res} | ${Number.isFinite(a.waitS) ? `${a.waitS} s` : '-'} |`.replace(/\n/g, ' '))
  }
  L.push('')
  const rest = evaluation.problems.filter((p) => !alerts.includes(p))
  if (rest.length) L.push('**Problems**', '', ...rest.map((p) => `- ${p}`), '')
  if (evaluation.warnings.length) L.push('Notes', '', ...evaluation.warnings.map((p) => `- ${p}`), '')
  return L.join('\n').trimEnd()
}

// ---------------------------------------------------------------- network / 网络

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** Public nodes and edges are flaky: one retry before a step counts as failed. / 公共节点不稳：失败前重试一次。 */
export async function retry(fn, { tries = 2, pauseMs = 2000, retryIf = () => true } = {}) {
  let last
  for (let i = 0; i < tries; i++) {
    try { return await fn(i) } catch (e) { last = e; if (!retryIf(e)) break; if (i < tries - 1) await sleep(pauseMs) }
  }
  throw last
}
// A resolve that got a definite TAP-10 answer (unpaid, not-opened, store-changed, ...) is not retried: asking again changes
// nothing. Only a read that could not be adopted (unavailable, stale-block) or an error without a status is. / 拿到确定的 TAP-10
// 答案（unpaid、not-opened、store-changed……）不重试，再问也不会变；只有读不到或不能采用的（unavailable、stale-block）以及没有 status 的错误才重试。
export const RETRYABLE_STATUS = new Set(['unavailable', 'stale-block'])
export const retryableResolve = (e) => { const st = e?.data?.status; return typeof st !== 'string' || RETRYABLE_STATUS.has(st) }

async function timedFetch(url, timeoutMs = 15000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs)
  const t0 = performance.now()
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json, text/html' }, redirect: 'follow' })
    const text = await res.text()
    return { res, text, latencyMs: Math.round(performance.now() - t0) }
  } finally { clearTimeout(t) }
}

async function checkHealth(svc) {
  try {
    return await retry(async () => {
      const { res, text, latencyMs } = await timedFetch(svc.base + HEALTH_PATH)
      if (res.status !== 200) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
      let j; try { j = JSON.parse(text) } catch { throw new Error('health is not JSON') }
      return { status: res.status, ok: j.ok, signer: j.signer ?? null, delegationExpires: Number.isFinite(j.delegationExpires) ? j.delegationExpires : null, version: j.version ?? null, latencyMs }
    })
  } catch (e) { return { status: e.status ?? null, error: msg(e) } }
}

/**
 * Is `name` (the on-chain name, with `.tape`) activated for `container`? Reuses the doctor's activationStatus (sdk/src/doctor.js).
 * Never throws: a chain that cannot be read gives { error }, which evaluate() turns into a warning, so it cannot sink the other checks.
 * Cost: activationStatus reads in sequence isLive(name, container), isContainerLive(container), then containerPaidUntil(container)
 * when activated or monthlyFee() when not: 3 eth_calls per service, 6 per run (2 services), each one quorum round over the SDK's 3
 * nodes. They are awaited one after the other, so rpc.js does not batch them: at most 6 extra requests per node per run, and 2 x 48
 * runs a day = about 288 per node per day, a few percent of what a public node allows; the whole check is retried once on a failure
 * (worst case 12 per node per run). Nothing is cached: the answer must be the chain's current one.
 * 激活检查：复用 doctor 的 activationStatus。从不抛错：读不到链就返回 { error }，由 evaluate() 记为警告，拖不垮其它检查。
 * 成本：依次读 isLive(名字, 容器)、isContainerLive(容器)，再按结果读 containerPaidUntil(已激活) 或 monthlyFee()(未激活)：每服务 3 次
 * eth_call，每次运行 6 次（2 个服务），每次都在 SDK 的 3 个节点上过一轮法定数；它们依次 await，所以 rpc.js 不会合并批量：
 * 每个节点每次运行最多多 6 个请求，每天 48 次运行约 288 个/节点，只占公共节点配额的很小一部分；失败时整项重试一次（最坏每次 12 个）。不缓存。
 * `name` must be the canonical name: SERVICES[].label is (11.1013.tape), and the tests lock the labels. / label 就是规范名，测试锁定了它。
 */
export async function checkActivation(api, { name, container }, { pauseMs = 2000 } = {}) {
  try {
    const [{ activationStatus, formatNative }, { CHAINS }] = await Promise.all([import('../sdk/src/doctor.js'), import('../sdk/src/index.js')])
    const a = await retry(() => activationStatus(api, api.chainId, { name, container }), { pauseMs })
    // No bigint in the results: --json prints them with JSON.stringify. / 结果里不留 bigint：--json 用 JSON.stringify 输出。
    return {
      live: a.live, isLive: a.isLive, isContainerLive: a.isContainerLive, isLiveReverted: a.isLiveReverted,
      paidUntil: a.paidUntil, feeWei: a.fee === null ? null : String(a.fee),
      feeText: a.fee === null ? null : formatNative(a.fee, CHAINS[api.chainId]?.currency ?? ''), binding: a.binding,
    }
  } catch (e) { return { error: msg(e) } }
}

/**
 * The implementation-slot check (the precondition of 2.0's conformance default): the ERC-1967 implementation of the site store
 * and of the payment contract (DomainBinding), as api.siteStatus reads them at a TAP-10 pinned block and judges them against the
 * implementations this SDK lists (chains.js expectedImpl). siteStatus never throws a site status, so this works whether or not the
 * resolve does. Never throws: { status, implementations: [{ role, proxy, implementation, accepted }] } or { error, status }.
 * Cost: one identity round on the SDK's nodes per service per run, retried once on a failure.
 * 实现槽检查（2.0 翻默认的前置条件）：站点存储与付费合约（DomainBinding）的 ERC-1967 实现，由 api.siteStatus 在 TAP-10 钉块上读出，
 * 并与本 SDK 列出的实现（chains.js expectedImpl）比对。siteStatus 不抛站点状态，所以解析成败与否都能做。从不抛错。
 * 成本：每服务每次运行在 SDK 的节点上多一轮身份读取，失败时重试一次。
 */
export async function checkSlots(api, target, { pauseMs = 2000 } = {}) {
  try {
    const v = await retry(() => api.siteStatus(target), { pauseMs, retryIf: retryableResolve })
    return {
      status: v?.status ?? null,
      implementations: Array.isArray(v?.implementations) ? v.implementations.map((i) => ({ role: i.role, proxy: i.proxy, implementation: i.implementation, accepted: i.accepted === true })) : null,
    }
  } catch (e) { return { error: msg(e), status: e?.data?.status ?? 'unavailable' } }
}

export async function checkChainAndCall(api, svc, { pauseMs = 2000 } = {}) {
  let resolved
  const chain = {}
  // In parallel with everything else: it reads the chain only. / 与其余全部并行：只读链。
  const slotsP = checkSlots(api, { circuits: svc.circuits, tokenId: svc.tokenId }, { pauseMs })
  try {
    resolved = await retry(() => api.resolve({ circuits: svc.circuits, tokenId: svc.tokenId }), { pauseMs, retryIf: retryableResolve })
    chain.container = resolved.container
    // 2.0: the TAP-10 outcome of the default client's resolve ('resolved'); absent when the client resolved the 1.x way.
    // 2.0：默认客户端解析的 TAP-10 结果（'resolved'）；客户端按 1.x 解析时没有。
    if (typeof resolved.conform?.status === 'string') chain.conform = resolved.conform.status
    chain.signer = resolved.manifest.signer
    chain.expires = resolved.manifest.delegation?.expires ?? null
    chain.endpoints = resolved.manifest.endpoints?.live ?? []
  } catch (e) {
    chain.error = msg(e)
    // e.data.status is the TAP-10 / TAP-11 outcome name (not-opened, unpaid, store-changed, unavailable, unsupported, ...)
    if (typeof e?.data?.status === 'string') chain.status = e.data.status
    if (Array.isArray(e?.data?.implementations)) chain.implementations = e.data.implementations
    if (typeof e?.data?.container === 'string') chain.container = e.data.container
  }
  const call = { method: svc.probe.method }
  if (!resolved) return { chain, call: { ...call, skipped: true }, activation: { skipped: true }, slots: await slotsP }
  // In parallel with the verified call: it uses the chain, the call uses the service. / 与验签调用并行：它用链，调用用服务。
  const activationP = checkActivation(api, { name: svc.label, container: resolved.container }, { pauseMs })
  try {
    const t0 = performance.now()
    const out = await retry(() => api.call(resolved, svc.probe.method, svc.probe.params(), { timeoutMs: 20000 }), { pauseMs })
    call.latencyMs = Math.round(performance.now() - t0)
    call.ok = out?.verified === true && svc.probe.check(out.result)
    call.detail = svc.probe.detail(out?.result)
    if (!call.ok) call.error = out?.verified !== true ? 'envelope not verified' : `unexpected result ${JSON.stringify(out?.result).slice(0, 120)}`
  } catch (e) { call.ok = false; call.error = msg(e) }
  return { chain, call, activation: await activationP, slots: await slotsP }
}

async function checkPage(p) {
  try {
    return await retry(async () => {
      const { res, latencyMs } = await timedFetch(p.url)
      if (res.status !== 200) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
      return { ...p, status: res.status, latencyMs }
    })
  } catch (e) { return { ...p, status: e.status ?? null, error: msg(e) } }
}

/**
 * Relay async delivery (RELAY-1). A relay that keeps its rooms only in memory passes every unit test and every
 * immediate read-back, and still loses everything once Cloudflare evicts the idle Durable Object, a few seconds later.
 * So: post one test frame to a random room, wait `waitMs` with nobody touching the room, then read it back through
 * `recv`, which in run() is a brand-new client with nothing shared with the sender. Pass = exactly that one frame, the
 * same bytes, under the epoch relaySend answered.
 * Cost: relaySend is a free method on relay.tapeapi.fun (price 0), the frame is ~100 bytes, the relay drops the room
 * 15 minutes after the last touch, and the monitor posts one frame per 30-minute run: negligible against the free
 * quota. No keys, no transactions: the monitor stays read-only on chain.
 * Network-layer failures (no signed answer: fetch failed, timeout, provider/RPC unavailable) are retried, `tries` in
 * all, `pauseMs` apart; an answer that is wrong is not retried. Each send attempt uses a fresh room and frame, so a post
 * that landed although its answer was lost cannot leave a second frame behind. The wait starts after the send that
 * succeeded.
 * send(params) / recv(params) return what api.call returns ({ verified, result }).
 * Returns { ok, kind?: 'wrong' | 'unreachable', error?, detail?, waitS, room?, attempts }.
 *
 * 中继异步投递（RELAY-1）。只把房间放在内存里的中继能通过所有单元测试和所有立即读回，但 Cloudflare 几秒后回收空闲的 Durable
 * Object 时就全部丢失。所以：往随机房间发一帧测试帧，等 `waitMs`、期间没人碰这个房间，再经 `recv` 读回——run() 里它是与发送方
 * 毫无共享的全新客户端。通过 = 恰好那一帧、字节相同、纪元与 relaySend 回答的一致。
 * 成本：relaySend 在 relay.tapeapi.fun 上是免费方法（价格 0），帧约 100 字节，房间在最后一次触碰 15 分钟后被中继清除，监控每 30
 * 分钟只发 1 帧：对免费额度的影响可以忽略。不持有密钥、不发交易：监控对链上仍是只读。
 * 网络层失败（没拿到签名回答：fetch failed、超时、提供者或 RPC 不可用）会重试，共 `tries` 次、间隔 `pauseMs`；回答了但不对的不重试。
 * 每次发送尝试都换新房间和新帧，这样即使一次投递已到达而回答丢了，也不会留下第二帧。等待从成功的那次发送之后开始计时。
 */
export async function checkRelayAsync({ send, recv, waitMs = ASYNC_WAIT_S * 1000, tries = 3, pauseMs = 3000, wait = sleep, newRoom = randomRoom, newFrame = testFrame } = {}) {
  const waitS = Math.round(waitMs / 100) / 10
  const attempts = { send: 0, recv: 0 }
  const netRetry = async (fn, key) => {
    let last
    for (let i = 0; i < tries; i++) {
      attempts[key]++
      try { return await fn() } catch (e) {
        last = e
        if (!isNetworkError(e)) throw Object.assign(e, { answered: true })
        if (i < tries - 1) await wait(pauseMs)
      }
    }
    throw last
  }
  const fail = (kind, error, extra = {}) => ({ ok: false, kind, error, waitS, attempts, ...extra })
  // 1. post / 发送
  let sent
  try {
    sent = await netRetry(async () => {
      const room = newRoom(); const f = newFrame()
      const out = await send({ room, frame: f.b64 })
      return { room, bytes: f.bytes, out }
    }, 'send')
  } catch (e) {
    return e.answered ? fail('wrong', `relaySend: ${msg(e)}`) : fail('unreachable', `relaySend: ${msg(e)}`)
  }
  const { room, bytes, out: so } = sent
  if (so?.verified !== true) return fail('wrong', 'relaySend: envelope not verified', { room })
  const epoch = so.result?.epoch
  if (!Number.isInteger(so.result?.i) || typeof epoch !== 'string') return fail('wrong', `relaySend answered ${so.result === undefined ? 'with no result (undefined)' : show(so.result)}, not { i, epoch }`, { room })
  // 2. leave the room idle / 让房间闲置
  await wait(waitMs)
  // 3. read back through a fresh client / 用全新客户端读回
  let ro
  try {
    ro = await netRetry(() => recv({ room, after: -1, epoch: null, waitMs: 0 }), 'recv')
  } catch (e) {
    return e.answered ? fail('wrong', `relayRecv: ${msg(e)}`, { room }) : fail('unreachable', `relayRecv: ${msg(e)}`, { room })
  }
  if (ro?.verified !== true) return fail('wrong', 'relayRecv: envelope not verified', { room })
  const why = judgeAsync({ bytes, epoch }, ro.result)
  if (why) return fail('wrong', why, { room })
  return { ok: true, detail: `1 frame (${bytes.length} bytes, type 0x03) read back by a fresh client, epoch unchanged`, waitS, room, attempts }
}

/**
 * The monitor's chain client: the SDK's default, the TAP-10 conformance mode (no `conform` option), so what the monitor
 * reports is what every 2.0 default client gets (T2: "our two services resolve in the conformance mode"). Never
 * conform: false: the tests lock it.
 * 监控的链客户端：SDK 的默认，即 TAP-10 一致模式（不传 conform），所以监控报告的就是每个 2.0 默认客户端得到的结果（T2："我们自己的两个服务
 * 在一致模式下 resolved"）。绝不用 conform: false：测试锁定了这一点。
 */
export async function monitorClient({ rpcUrls = RPC_URLS, fetch } = {}) {
  const { createTapeAPI } = await import('../sdk/src/index.js')
  return createTapeAPI({ rpcUrls, quorum: 2, rpcTimeoutMs: 25000, ...(fetch ? { fetch } : {}) })
}

export async function run({ services = SERVICES, pages = PAGES, rpcUrls = RPC_URLS, asyncWait = ASYNC_WAIT_S * 1000 } = {}) {
  const newClient = () => monitorClient({ rpcUrls })
  const api = await newClient()
  // The async check starts first and runs alongside the others: its send goes out now, its read after the idle wait,
  // so the run takes about max(other checks, wait) rather than their sum.
  // 异步检查最先开始、与其它检查并行：现在发送，闲置期满再读，整次运行约为 max(其它检查, 等待) 而不是二者之和。
  const asyncSvc = services.find((s) => s.name === ASYNC_SERVICE)
  const asyncP = asyncSvc ? (async () => {
    const base = { name: asyncSvc.name, label: asyncSvc.label }
    let relay
    // Resolve failing is reported on the relay's own row; the check is skipped, as a verified call is.
    // 解析失败已在中继自己那行报告；本检查跳过，与验签调用一致。
    try { relay = await retry(() => api.resolve({ circuits: asyncSvc.circuits, tokenId: asyncSvc.tokenId })) } catch (e) { return { ...base, skipped: true, error: `resolve failed: ${msg(e)}` } }
    const r = await checkRelayAsync({
      waitMs: asyncWait,
      send: (p) => api.call(relay, 'relaySend', p, { timeoutMs: 20000 }),
      // A new client per attempt, resolving the relay itself: call() routes a service back through the client that
      // resolved it, so reusing `relay` would not be a fresh client at all.
      // 每次尝试一个新客户端、自己解析中继：call() 会把服务路由回解析它的那个客户端，复用 `relay` 就根本不是全新客户端。
      recv: async (p) => {
        const fresh = await newClient()
        const svc = await fresh.resolve({ circuits: asyncSvc.circuits, tokenId: asyncSvc.tokenId })
        return fresh.call(svc, 'relayRecv', p, { timeoutMs: 20000 })
      },
    })
    return { ...base, ...r }
  })() : null
  const svcResults = await Promise.all(services.map(async (svc) => {
    const [health, cc] = await Promise.all([checkHealth(svc), checkChainAndCall(api, svc)])
    return { name: svc.name, label: svc.label, base: svc.base, health, ...cc }
  }))
  const pageResults = await Promise.all(pages.map(checkPage))
  const out = { checkedAt: new Date().toISOString(), services: svcResults, pages: pageResults }
  if (asyncP) out.relayAsync = await asyncP
  return out
}

async function main() {
  const json = process.argv.includes('--json')
  let results
  try { results = await run({ asyncWait: asyncWaitMs() }) } catch (e) {
    // The monitor itself broke (e.g. the SDK failed to load): that is a failure too, and the report says why.
    const text = `## TapeAPI monitor: the monitor itself failed\n\n${msg(e)}\n`
    process.stdout.write(json ? JSON.stringify({ healthy: false, problems: [`monitor crashed: ${msg(e)}`] }, null, 2) + '\n' : text)
    process.exitCode = 1
    return
  }
  const now = Math.floor(Date.now() / 1000)
  const evaluation = evaluate(results, now)
  process.stdout.write(json ? JSON.stringify({ ...results, ...evaluation }, null, 2) + '\n' : report(results, evaluation, now) + '\n')
  // exitCode, not exit(): stdout to a pipe is asynchronous on macOS and exit() could cut the report short.
  process.exitCode = evaluation.healthy ? 0 : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main()
