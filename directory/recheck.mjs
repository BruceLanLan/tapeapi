#!/usr/bin/env node
// The provider directory (https://tapeapi.fun/directory/): the format check of site/directory/providers.json and its daily
// recheck, which writes site/directory/status.json. See directory/README.md.
// 服务方目录：site/directory/providers.json 的格式检查与每日复核（写 site/directory/status.json）。见 directory/README.md。
//
//   node directory/recheck.mjs --validate                 # a pull request: the format only, no network
//   node directory/recheck.mjs --recheck [--write]        # daily: tapeapi-doctor on every entry, status.json updated
//
// A listing means one thing: the name passed TapeAPI's automated checks (tapeapi-doctor). It is not a recommendation, a
// guarantee or an audit; each provider answers for its own service, prices and compliance.
// What a provider submits is its name and nothing it could exaggerate: no description, no prices, no logo, no rank.
// Everything a reader sees is read from the chain and the service by tapeapi-doctor. The order is the names' own
// (chain, processor, #ID), never a placement anyone can buy. A failing entry is flagged, never removed automatically.
// 列出只表示一件事：这个名字通过了 TapeAPI 的自动检查（tapeapi-doctor）。不代表推荐、担保或审计；服务质量、价格与合规由服务方自己负责。
// 服务方提交的只有名字，没有任何可以夸大的内容：没有简介、价格、标志、排名。读者看到的一切都由 tapeapi-doctor 从链上和服务本身读出。
// 顺序由名字本身决定（链、处理器、#ID），不是任何人能买到的位置。失败只标记，从不自动删除。
import { readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseTapeName, createTapeAPI, rpcUrlsFor, TapeAPIError } from '../sdk/src/index.js'
import { diagnose } from '../sdk/src/doctor.js'

export const PROVIDERS_FILE = fileURLToPath(new URL('../site/directory/providers.json', import.meta.url))
export const STATUS_FILE = fileURLToPath(new URL('../site/directory/status.json', import.meta.url))
export const ENTRY_FIELDS = Object.freeze(['name', 'added', 'contact'])
export const FLAGS = Object.freeze(['ok', 'failing', 'stale', 'undecided'])
/** Consecutive failing daily rechecks after which an entry is flagged `stale` (a human then proposes removal). */
export const STALE_AFTER = 7
/**
 * JSON-RPC HTTP requests one name may use in one recheck (a batch counts once). Measured 2026-09-30 on BNB Chain with
 * the default three nodes and quorum 2: 36 requests (42 calls, some batched) for a name that gets through every on-chain
 * check; every chain read happens before the `ai-field` check, so a service that passes everything needs the same. The
 * rest is headroom for a node that fails and a retry. A name that reaches the cap is `undecided`, never `failing`.
 * 2.0: the default-mode step (defaultModeStatus) uses what the doctor leaves of the same cap: 24 requests on the conform
 * fake chain (3 nodes, with a cpuAt scan the shipped processor table spares processor 1013), so on BNB Chain about 56
 * of 60 together, unmeasured; when it runs short only `defaultMode` says `rpc-budget`, never the flag.
 * 一个名字在一次复核里最多可用的 JSON-RPC HTTP 请求数（批量请求算一次）。2026-09-30 在 BNB Chain 实测（默认三个节点、quorum 2）：
 * 通过全部链上检查的名字用 36 次（42 个调用，部分合批）；所有链上读取都在 `ai-field` 检查之前，全部通过的服务也一样。其余是给
 * 节点故障与重试的余量。达到上限的名字记为 `undecided`，绝不记为 `failing`。2.0：默认模式一步用诊断剩下的同一上限：conform 假链上 24 次
 * （3 个节点，含 1013 号处理器可由随附处理器表省掉的 cpuAt 扫描），BNB Chain 上两者合计约 56/60，未实测；不够时只有 defaultMode 记
 * rpc-budget，标记不受影响。
 */
export const RPC_BUDGET_PER_NAME = 60
const DOCTOR_VERSION = JSON.parse(readFileSync(new URL('../sdk/package.json', import.meta.url), 'utf8')).version

/** Canonical order: chain, processor, #ID, all numeric. / 规范顺序：链、处理器、#ID，均按数值。 */
export function orderKey(name) {
  const p = parseTapeName(name)
  return [BigInt(p.chainId), BigInt(p.processor), BigInt(p.tokenId)]
}
const cmp = (a, b) => { const x = orderKey(a), y = orderKey(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0 }

/**
 * The format rules of providers.json. Returns a list of problems ([] when valid). / providers.json 的格式规则。
 * @param {unknown} doc
 * @returns {string[]}
 */
export function validateDirectory(doc) {
  const problems = []
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['the file must be a JSON object { "version": 1, "providers": [...] }']
  const extra = Object.keys(doc).filter((k) => k !== 'version' && k !== 'providers')
  if (extra.length) problems.push(`unknown top-level field(s): ${extra.join(', ')}`)
  if (doc.version !== 1) problems.push('version must be 1')
  if (!Array.isArray(doc.providers)) return [...problems, 'providers must be an array']
  const seen = new Set()
  doc.providers.forEach((e, i) => {
    const at = `providers[${i}]`
    if (!e || typeof e !== 'object' || Array.isArray(e)) { problems.push(`${at} must be an object`); return }
    const unknown = Object.keys(e).filter((k) => !ENTRY_FIELDS.includes(k))
    if (unknown.length) problems.push(`${at}: field(s) ${unknown.join(', ')} are not accepted: an entry is a name, a date and an optional contact; everything else is read from the chain`)
    const p = typeof e.name === 'string' ? parseTapeName(e.name) : null
    if (!p || p.error) problems.push(`${at}.name must be a TapeOut name (42.1013.tape): ${p?.error ?? JSON.stringify(e.name)}`)
    else if (p.name !== e.name) problems.push(`${at}.name must be written canonically: ${p.name}`)
    else if (seen.has(e.name)) problems.push(`${at}: ${e.name} is listed twice`)
    else seen.add(e.name)
    if (typeof e.added !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.added) || Number.isNaN(Date.parse(e.added))) problems.push(`${at}.added must be a date YYYY-MM-DD`)
    if (e.contact !== undefined && (typeof e.contact !== 'string' || e.contact.length > 200 || !/^https:\/\/[^\s]+$/.test(e.contact))) problems.push(`${at}.contact, when given, must be an https URL of at most 200 characters`)
  })
  const names = doc.providers.map((e) => e?.name).filter((n) => typeof n === 'string' && parseTapeName(n)?.name === n)
  if (names.length === doc.providers.length) {
    const sorted = [...names].sort(cmp)
    const at = names.findIndex((n, i) => n !== sorted[i])
    if (at >= 0) problems.push(`providers must be in the names' order (chain, processor, #ID); ${names[at]} is out of place: the order is never a ranking`)
  }
  return problems
}

// The last decided verdict of a previous status (older files have no `verdict`). / 上一次确定的结论（旧文件没有 verdict）。
const lastVerdict = (prev) => prev?.verdict ?? (prev && prev.flag !== 'undecided' ? prev.flag : null)
const lastVerdictAt = (prev) => prev?.verdictAt ?? (prev && prev.flag !== 'undecided' ? prev.checkedAt ?? null : null)

/**
 * The next status of one entry from today's doctor report and yesterday's status. / 由今天的诊断报告与昨天的状态得到新状态。
 * flag: ok | failing | stale (failing STALE_AFTER days in a row) | undecided (the chain or the network could not be read:
 * yesterday's verdict stands, kept in `verdict` / `verdictAt`, and a failing or stale flag is not cleared).
 * flag：ok | failing | stale（连续 STALE_AFTER 天失败）| undecided（读不到链或网络：保留前一天的结论，记在 verdict / verdictAt，
 * failing 或 stale 不会被清除）。
 */
export function nextStatus(prev, report, at) {
  const ids = (s) => report.checks.filter((c) => c.status === s).map((c) => c.id)
  const base = { checkedAt: at, exitCode: report.exitCode, failed: ids('fail'), warned: ids('warn'), undecided: ids('error') }
  if (report.exitCode === 3) {
    return {
      ...base, flag: prev?.flag === 'ok' || !prev ? 'undecided' : prev.flag, consecutiveFailures: prev?.consecutiveFailures ?? 0, since: prev?.since ?? at,
      verdict: lastVerdict(prev), verdictAt: lastVerdictAt(prev),
    }
  }
  const failing = report.exitCode !== 0
  const consecutiveFailures = failing ? (prev?.consecutiveFailures ?? 0) + 1 : 0
  const flag = !failing ? 'ok' : consecutiveFailures >= STALE_AFTER ? 'stale' : 'failing'
  const before = lastVerdict(prev)
  const changed = !before || (before === 'ok') !== (flag === 'ok')
  return { ...base, flag, consecutiveFailures, since: changed ? at : prev.since, verdict: flag, verdictAt: at }
}

/**
 * A fetch that counts JSON-RPC HTTP requests and refuses once `limit` is reached, for one name's chain client.
 * 计数 JSON-RPC HTTP 请求、达到 `limit` 后拒绝的 fetch，每个名字的链客户端各用一个。
 */
export function rpcMeter(limit = RPC_BUDGET_PER_NAME, inner = (...a) => globalThis.fetch(...a)) {
  let used = 0, exceeded = false
  const fetch = async (url, init) => {
    if (used >= limit) { exceeded = true; throw new TapeAPIError('RPC_UNAVAILABLE', `the recheck's budget of ${limit} rpc requests for this name is spent`) }
    used++
    return inner(url, init)
  }
  return { fetch, get used() { return used }, get exceeded() { return exceeded } }
}

/**
 * Recheck every entry with tapeapi-doctor (no key: free), one chain client per name on a metered fetch.
 * 用 tapeapi-doctor 复核每一条（不带密钥：免费），每个名字一个链客户端，走计数的 fetch。
 * 2.0: with `defaultApiFor`, each entry's status also gets `defaultMode` (defaultModeStatus below), on the same meter.
 * 2.0：给了 `defaultApiFor` 时，每条状态还会追加 `defaultMode`（见下面的 defaultModeStatus），用同一个计数器。
 * @param {{ doc: object, previous?: object, diagnoseFn?: Function, apiFor?: (fetch: Function) => object, defaultApiFor?: ((fetch: Function) => object) | null, rpcBudget?: number, now?: () => string }} o
 */
export async function recheck({ doc, previous = null, diagnoseFn = diagnose, apiFor = () => undefined, defaultApiFor = null, rpcBudget = RPC_BUDGET_PER_NAME, now = () => new Date().toISOString() }) {
  const problems = validateDirectory(doc)
  if (problems.length) throw new Error(`providers.json is not valid:\n  ${problems.join('\n  ')}`)
  const at = now()
  const out = { version: 1, doctor: DOCTOR_VERSION, checkedAt: at, rpcBudgetPerName: rpcBudget, providers: {} }
  for (const e of doc.providers) {
    const meter = rpcMeter(rpcBudget)
    let report
    try { report = await diagnoseFn(e.name, { api: apiFor(meter.fetch) }) } catch (err) { report = { exitCode: 3, checks: [{ id: 'name', status: 'error', detail: String(err?.message || err) }] } }
    // The flag is the doctor's alone: the meter is read here, before the default-mode step below uses it.
    // 标记只由诊断决定：在下面的默认模式一步用到计数器之前，先在这里读取它。
    const exceeded = meter.exceeded, used = meter.used
    // A spent budget decides nothing about the service: whatever the doctor concluded after it, the entry is undecided.
    // 预算用完不能说明服务的任何问题：无论诊断之后得出什么，这一条都记为无法判定。
    if (exceeded) report = { exitCode: 3, checks: [...report.checks.filter((c) => c.status !== 'fail'), { id: 'rpc-budget', status: 'error' }] }
    const status = { ...nextStatus(previous?.providers?.[e.name] ?? null, report, at), rpcRequests: used }
    if (defaultApiFor) {
      // A client that cannot even be made is no conclusion, never a failure of the recheck. / 连客户端都建不起来只是没有结论，绝不让复核失败。
      let dapi, made = null
      try { dapi = defaultApiFor(meter.fetch) } catch (err) { made = err }
      status.defaultMode = made
        ? { status: 'unavailable', rpcRequests: 0, detail: String(made?.message || made).replace(/\s+/g, ' ').slice(0, 200) }
        : await defaultModeStatus(e.name, dapi, meter, used)
    }
    out.providers[e.name] = status
  }
  return out
}

/** The site statuses TAP-10 §6.2 names that api.siteStatus returns (never throws). / siteStatus 返回（不抛出）的站点状态。 */
export const SITE_STATUSES = Object.freeze(['ok', 'unpaid', 'not-opened', 'store-changed', 'no-such-cpu', 'no-such-token', 'not-tapeout'])

/**
 * 2.0 (E20): what a client in the SDK's default mode (the TAP-10 conformance mode) says of one name, appended to the
 * entry's status as `defaultMode`. It never changes `flag`, `verdict`, `consecutiveFailures`, `rpcRequests` or
 * newlyFailing(): the flag stays the doctor's under the 1.x resolution. It is api.siteStatus (TAP-10 identity and site
 * status at one pinned block: opened, activated, the site store and payment contract implementations), not a full
 * resolve: the doctor has already checked the manifest and the delegation. It shares the name's RPC meter, so the cap of
 * RPC_BUDGET_PER_NAME holds for both; what is left after the doctor is all it may use.
 * { status, rpcRequests, implementations? (store-changed only), reason? ('rpc-budget' when the budget ran out), detail? }.
 * `status` is a site status (SITE_STATUSES), or, when siteStatus threw, the TAP name it carried ('unavailable',
 * 'unsupported', 'stale-block', 'wrong-chain', 'input-error', ...; 'unavailable' when it carried none).
 * 2.0（E20）：SDK 默认模式（TAP-10 一致模式）的客户端对这个名字的结论，作为 `defaultMode` 追加到条目状态里。它从不改变 flag、verdict、
 * consecutiveFailures、rpcRequests 或 newlyFailing()：标记仍是诊断按 1.x 解析得出的。它是 api.siteStatus（在一个钉块上的 TAP-10 身份与
 * 站点状态：是否开通、是否激活、站点存储与付费合约的实现），不是完整解析：清单与委托诊断已经检查过。它与诊断共用这个名字的 RPC 计数器，
 * RPC_BUDGET_PER_NAME 的上限对两者合计成立；诊断用剩的就是它能用的全部。
 */
export async function defaultModeStatus(name, api, meter, before = meter.used) {
  const spent = () => (meter.exceeded ? { reason: 'rpc-budget' } : {})
  try {
    if (!api || typeof api.siteStatus !== 'function') throw new TapeAPIError('RPC_UNAVAILABLE', 'no default-mode client')
    const v = await api.siteStatus(name)
    const status = SITE_STATUSES.includes(v?.status) ? v.status : 'unavailable'
    const out = { status, rpcRequests: meter.used - before }
    if (status === 'store-changed' && Array.isArray(v.implementations)) {
      out.implementations = v.implementations.map((i) => ({ role: String(i.role), proxy: String(i.proxy), implementation: String(i.implementation), accepted: i.accepted === true }))
    }
    return out
  } catch (err) {
    const st = typeof err?.data?.status === 'string' ? err.data.status : 'unavailable'
    return { status: meter.exceeded ? 'unavailable' : st, rpcRequests: meter.used - before, ...spent(), detail: String(err?.message || err).replace(/\s+/g, ' ').slice(0, 200) }
  }
}

/**
 * The chain client of one name's recheck. 2.0: conform: false, the 1.x resolution (deprecated, one DEPRECATED warning per client),
 * because the directory's labels are not accepted by the conformance mode that is now the default (decision D-3): the listing
 * has to stay available to them. The warning goes to `onWarning` (default: the SDK's console warning). What a 2.0 default
 * client says of the name is recorded beside the flag, in `defaultMode` (directoryDefaultApi, defaultModeStatus).
 * 一个名字复核用的链客户端。2.0：conform: false，即 1.x 的解析（已弃用，每个客户端一次 DEPRECATED 警告），因为目录标签在现在作为默认的
 * 一致模式下会被拒（决定 D-3）：目录必须对它们保持可用。警告交给 `onWarning`（默认：SDK 的控制台警告）。2.0 默认客户端对这个名字的
 * 结论另记在标记旁边的 `defaultMode` 里（directoryDefaultApi、defaultModeStatus）。
 */
export function directoryApi(fetch, { onWarning } = {}) {
  return createTapeAPI({ rpcUrls: rpcUrlsFor(56), quorum: 2, fetch, conform: false, ...(onWarning ? { onWarning } : {}) })
}

/**
 * The client of the default-mode step (defaultModeStatus): the SDK's default, the TAP-10 conformance mode (no `conform`
 * option, so no DEPRECATED warning), on the same nodes, quorum and metered fetch as directoryApi.
 * 默认模式一步（defaultModeStatus）用的客户端：SDK 的默认，即 TAP-10 一致模式（不传 conform，所以没有 DEPRECATED 警告），节点、法定数与
 * 计数的 fetch 与 directoryApi 相同。
 */
export function directoryDefaultApi(fetch) {
  return createTapeAPI({ rpcUrls: rpcUrlsFor(56), quorum: 2, fetch })
}

/** Entries that stopped passing today (the job fails so a maintainer sees them). / 今天新近不再通过的条目。 */
export function newlyFailing(previous, status) {
  return Object.entries(status.providers).filter(([n, s]) => (s.flag === 'failing' || s.flag === 'stale') && lastVerdict(previous?.providers?.[n]) === 'ok').map(([n]) => n)
}

async function main() {
  const args = process.argv.slice(2)
  const doc = JSON.parse(readFileSync(PROVIDERS_FILE, 'utf8'))
  if (args.includes('--validate')) {
    const problems = validateDirectory(doc)
    for (const p of problems) console.error(`directory: ${p}`)
    console.log(problems.length ? `directory: ${problems.length} problem(s)` : `directory: ${doc.providers.length} entr${doc.providers.length === 1 ? 'y' : 'ies'}, format ok`)
    process.exit(problems.length ? 1 : 0)
  }
  if (args.includes('--recheck')) {
    let previous = null
    try { previous = JSON.parse(readFileSync(STATUS_FILE, 'utf8')) } catch { /* first run */ }
    const status = await recheck({ doc, previous, apiFor: (fetch) => directoryApi(fetch), defaultApiFor: (fetch) => directoryDefaultApi(fetch) })
    for (const [name, s] of Object.entries(status.providers)) console.log(`${s.flag.padEnd(9)} ${name}  rpc ${s.rpcRequests}/${status.rpcBudgetPerName}${s.failed.length ? `  failed: ${s.failed.join(', ')}` : ''}${s.consecutiveFailures ? `  (${s.consecutiveFailures} day(s))` : ''}${s.defaultMode ? `  default mode: ${s.defaultMode.status}${s.defaultMode.reason ? ` (${s.defaultMode.reason})` : ''}, rpc ${s.defaultMode.rpcRequests}` : ''}`)
    // An empty directory is not rewritten every day for a new timestamp alone. / 空目录不会只为新的时间戳每天重写。
    const worthWriting = doc.providers.length > 0 || Object.keys(previous?.providers ?? {}).length > 0
    if (args.includes('--write') && worthWriting) writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2) + '\n')
    if (!doc.providers.length) console.log('directory: no entries to recheck')
    // The job fails when an entry newly stops passing, so a human sees it. / 有条目新近不再通过时任务失败，让人看到。
    process.exit(newlyFailing(previous, status).length ? 1 : 0)
  }
  console.error('usage: node directory/recheck.mjs --validate | --recheck [--write]'); process.exit(2)
}

const self = (() => { try { return realpathSync(fileURLToPath(import.meta.url)) } catch { return null } })()
const argv1 = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) } catch { return null } })()
if (self && self === argv1) main().catch((e) => { console.error(`directory: ${e?.stack || e}`); process.exit(2) })
