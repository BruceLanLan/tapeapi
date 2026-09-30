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
 * 一个名字在一次复核里最多可用的 JSON-RPC HTTP 请求数（批量请求算一次）。2026-09-30 在 BNB Chain 实测（默认三个节点、quorum 2）：
 * 通过全部链上检查的名字用 36 次（42 个调用，部分合批）；所有链上读取都在 `ai-field` 检查之前，全部通过的服务也一样。其余是给
 * 节点故障与重试的余量。达到上限的名字记为 `undecided`，绝不记为 `failing`。
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
 * @param {{ doc: object, previous?: object, diagnoseFn?: Function, apiFor?: (fetch: Function) => object, rpcBudget?: number, now?: () => string }} o
 */
export async function recheck({ doc, previous = null, diagnoseFn = diagnose, apiFor = () => undefined, rpcBudget = RPC_BUDGET_PER_NAME, now = () => new Date().toISOString() }) {
  const problems = validateDirectory(doc)
  if (problems.length) throw new Error(`providers.json is not valid:\n  ${problems.join('\n  ')}`)
  const at = now()
  const out = { version: 1, doctor: DOCTOR_VERSION, checkedAt: at, rpcBudgetPerName: rpcBudget, providers: {} }
  for (const e of doc.providers) {
    const meter = rpcMeter(rpcBudget)
    let report
    try { report = await diagnoseFn(e.name, { api: apiFor(meter.fetch) }) } catch (err) { report = { exitCode: 3, checks: [{ id: 'name', status: 'error', detail: String(err?.message || err) }] } }
    // A spent budget decides nothing about the service: whatever the doctor concluded after it, the entry is undecided.
    // 预算用完不能说明服务的任何问题：无论诊断之后得出什么，这一条都记为无法判定。
    if (meter.exceeded) report = { exitCode: 3, checks: [...report.checks.filter((c) => c.status !== 'fail'), { id: 'rpc-budget', status: 'error' }] }
    out.providers[e.name] = { ...nextStatus(previous?.providers?.[e.name] ?? null, report, at), rpcRequests: meter.used }
  }
  return out
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
    const status = await recheck({ doc, previous, apiFor: (fetch) => createTapeAPI({ rpcUrls: rpcUrlsFor(56), quorum: 2, fetch }) })
    for (const [name, s] of Object.entries(status.providers)) console.log(`${s.flag.padEnd(9)} ${name}  rpc ${s.rpcRequests}/${status.rpcBudgetPerName}${s.failed.length ? `  failed: ${s.failed.join(', ')}` : ''}${s.consecutiveFailures ? `  (${s.consecutiveFailures} day(s))` : ''}`)
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
