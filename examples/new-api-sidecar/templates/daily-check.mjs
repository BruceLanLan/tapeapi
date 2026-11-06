#!/usr/bin/env node
// The daily check of a relay's TapeAPI listing, for the operator's OWN GitHub Actions (tapeapi-daily-check.yml, next to
// this file): tapeapi-doctor by name with the default resolution of 2.0 (TAP-10 / TAP-11, conform: 'tap10'), and the
// price converter's --check against the operator's own new-api price list. It reads only: no key, no token, no
// transaction. It prints a Markdown report with the next command for every problem, and says by its exit status
// whether to alert. EXPERIMENTAL, like pricing-convert.mjs: not part of @tapeapi/sdk or @tapeapi/server.
// 中转站 TapeAPI 条目的每日检查，给运营者**自己的** GitHub Actions 用（同目录 tapeapi-daily-check.yml）：按名字运行 tapeapi-doctor，
// 用 2.0 的默认解析（TAP-10 / TAP-11，conform: 'tap10'）；再用价目转换器的 --check 对照运营者自己 new-api 的价目。只读：不用任何密钥、
// 令牌，不发交易。输出 Markdown 报告，每个问题给出下一条命令；退出码说明要不要告警。实验性，同 pricing-convert.mjs。
//
//   node daily-check.mjs --name 42.1013.tape [--pricing-url https://api.example.com/api/pricing | --pricing pricing.json]
//        [--models models.json] [--meta models.newapi-source.json] [--status status.json]
//        [--doctor-json report.json] [--rpc url,url,...] [--warn-days 30] [--escalate-days 14]
//        [--delegation-warn-days 7] [--delegation-escalate-days 3] [--now <unix seconds>]
//
// What alerts / 什么会告警 (G7 thresholds / 阈值):
//   escalate (exit 1)  a doctor check failed; the name is not activated (since 2.0 the default client answers "unpaid":
//                      a failure, not a warning); the activation ends within --escalate-days (14), the delegation
//                      within --delegation-escalate-days (3);
//                      the price list drifted from the published table (pricing_version, a price, a model, a scope
//                      signal); the price check could not run with the files given.
//                      doctor 有检查失败；名字未激活（2.0 起默认客户端得到 unpaid，是失败不是警告）；激活在 14 天内、委托在 3 天内到期；
//                      价目与已发布的价目表有漂移；价目检查用给定的文件无法运行。
//   warn (exit 4)      the activation ends within --warn-days (30), the delegation within --delegation-warn-days (7):
//                      since 3.0 the console signs 30-day delegations by default, so 30 would alert on day one.
//                      激活在 30 天内、委托在 7 天内到期（3.0 起操作台默认签 30 天委托，按 30 天阈值第一天就会告警）。
//   undecided (exit 3) the chain, the network or the price list could not be read: nothing was decided; run it again.
//                      Not an alert by itself. / 读不到链、网络或价目：没有结论，请重跑。本身不告警。
//   ok (exit 0)        nothing to do (notes, such as a doctor warning about prices, are listed, not alerted).
//                      无事可做（价目提示之类的说明会列出，但不告警）。
//   2                  a usage mistake. / 用法错误。
import { readFileSync, writeFileSync, mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTapeAPI, rpcUrlsFor, operatorOf } from '@tapeapi/sdk'
import { diagnose, DOCTOR_CHECKS } from '../../../sdk/src/doctor.js'
import { run as convertRun } from '../pricing-convert.mjs'

/** The first seven doctor checks: the identity (name to delegation), read from the chain and the manifest.
 *  doctor 的前七项：身份（名字到委托），读链与清单。 */
export const IDENTITY_CHECKS = Object.freeze(DOCTOR_CHECKS.slice(0, 7))
export const WARN_DAYS = 30
export const ESCALATE_DAYS = 14
// The delegation's own thresholds (3.0: the console signs 30 days by default; the doctor warns from 7 days left).
// 委托自己的阈值（3.0：操作台默认签 30 天；doctor 剩 7 天起警告）。
export const DELEGATION_WARN_DAYS = 7
export const DELEGATION_ESCALATE_DAYS = 3
const LEVELS = ['ok', 'notice', 'undecided', 'warn', 'escalate']
export const EXIT = Object.freeze({ ok: 0, notice: 0, undecided: 3, warn: 4, escalate: 1 })
const RANK = Object.fromEntries(LEVELS.map((l, i) => [l, i]))
const DAY = 86_400

/** Days left in a doctor detail: the delegation's "N days left" / "N day(s) left". / 委托剩余天数。 */
export function delegationDaysOf(detail) {
  const m = /\b(\d+) day(?:s|\(s\))? left\b/.exec(String(detail ?? ''))
  return m ? Number(m[1]) : null
}
/** The activation's end in a doctor detail ("paid until YYYY-MM-DD", containerPaidUntil), as days from `now`.
 *  Read from the text: the fallback for a doctor older than 2.2, which gives no number for it (activationEndDaysOf).
 *  激活的到期日（从文字读出），换算成距 now 的天数：只给 2.2 之前没有结构化字段的 doctor 用（见 activationEndDaysOf）。 */
export function activationDaysOf(detail, now) {
  const m = /\bpaid until (\d{4}-\d{2}-\d{2})\b/.exec(String(detail ?? ''))
  if (!m) return null
  const t = Date.parse(`${m[1]}T00:00:00Z`) / 1000
  return Number.isFinite(t) ? Math.floor((t - now) / DAY) : null
}

/** Days of activation left in a doctor's `activation` check: its structured `paidUntilSeconds` (tapeapi-doctor --json,
 *  2.2 on) when it is a number, else the "paid until" date of its detail. / 激活剩余天数：优先读 2.2 起的结构化字段
 *  paidUntilSeconds，没有时才从说明文字读日期。 */
export function activationEndDaysOf(check, now) {
  const t = check?.paidUntilSeconds
  if (Number.isSafeInteger(t) && t > 0) return Math.floor((t - now) / DAY)
  return activationDaysOf(check?.detail, now)
}
/** monthlyFee() in wei from the `activation` check's structured `monthlyFeeWei` (2.2 on), as a bigint; null when absent.
 *  月费（wei），取自 2.2 起的结构化字段 monthlyFeeWei；没有时为 null。 */
export function monthlyFeeWeiOf(check) {
  const v = check?.monthlyFeeWei
  return typeof v === 'string' && /^\d{1,78}$/.test(v) ? BigInt(v) : null
}

/**
 * Weigh a doctor report and a price check into one level, with one item per finding.
 * 把 doctor 报告与价目检查合成一个级别，每个发现一项。
 * @param {{ doctor: { exitCode: number, checks?: object[], resolution?: string|null, error?: string },
 *           price?: { code: number, text: string }|null, name?: string, now?: number, warnDays?: number, escalateDays?: number,
 *           delegationWarnDays?: number, delegationEscalateDays?: number }} o
 * @returns {{ level: string, exitCode: number, items: Array<{ level: string, what: string, detail: string, next?: string }> }}
 */
export function evaluate({ doctor, price = null, name = '<your name>', now = Math.floor(Date.now() / 1000), warnDays = WARN_DAYS, escalateDays = ESCALATE_DAYS,
  delegationWarnDays = DELEGATION_WARN_DAYS, delegationEscalateDays = DELEGATION_ESCALATE_DAYS }) {
  const items = []
  const add = (level, what, detail, next) => items.push({ level, what, detail: String(detail ?? '').trim(), ...(next ? { next: String(next).trim() } : {}) })
  const byDays = (days, w = warnDays, e = escalateDays) => (days === null ? null : days <= e ? 'escalate' : days <= w ? 'warn' : null)
  const doctorCmd = `tapeapi-doctor ${name}`
  const checks = Array.isArray(doctor?.checks) ? doctor.checks : []

  if (doctor?.exitCode === 3 || (doctor?.error && !checks.length)) add('undecided', 'doctor', `the chain or the network could not be read, so nothing was decided${doctor?.error ? `: ${doctor.error}` : ''}`, `run it again later: ${doctorCmd}`)
  for (const c of checks) {
    const next = c.next || c.fix
    const text = typeof next === 'object' && next ? next.en : next
    if (c.status === 'fail') add('escalate', c.id, c.detail, text || `see ${doctorCmd}`)
    else if (c.id === 'activation' && c.status === 'warn') add('escalate', 'activation', `${c.detail} (since 2.0 the default client answers "unpaid" and resolves nothing: a failure, not a warning)`, text)
    else if (c.status === 'warn' && c.id !== 'delegation') add('notice', c.id, c.detail, text)
    if (c.id === 'delegation' && (c.status === 'pass' || c.status === 'warn')) {
      const days = delegationDaysOf(c.detail)
      const level = byDays(days, delegationWarnDays, delegationEscalateDays)
      if (level) add(level, 'delegation', `${days} day(s) left (${c.detail})`, 'renew: holder console step 4 ("renew"), set the new DELEGATION_EXPIRES and DELEGATION_SIG on the sidecar, then step 5 publishes the manifest again (one transaction, your gas)')
    }
    if (c.id === 'activation') {
      // The fee is 0 on chain today; once it is not, paying the activation again costs money: say so in an alert.
      // 今天链上月费为 0；一旦不是 0，再次激活就要花钱：以预警说出来。
      const fee = monthlyFeeWeiOf(c)
      if (fee !== null && fee > 0n) add('warn', 'monthly fee', `monthlyFee() is ${fee} wei per 30 days, not 0 (read from the chain by the doctor; the owner of DomainBinding can change it at any time)`, 'paying the activation again costs months x this fee, plus gas, from the wallet that holds the circuit; decide before the activation ends')
    }
    if (c.id === 'activation' && c.status === 'pass') {
      const days = activationEndDaysOf(c, now)
      const level = byDays(days)
      if (level) add(level, 'activation', `paid for ${days} more day(s) (${c.detail})`, 'pay the activation again before it ends (DomainBinding bind, from the wallet that holds the circuit; you pay it and the gas; read monthlyFee() on chain when you pay)')
      else if (days === null) add('notice', 'activation', `activated; this doctor does not show until when (${c.detail})`, 'look at the activation\'s end date once a month')
    }
  }
  if (doctor?.resolution && doctor.resolution !== 'tap10') add('notice', 'resolution', `the doctor resolved the name the ${doctor.resolution} way, not with the default of 2.0`)

  if (!price) add('notice', 'prices', 'price check skipped: no price list given (set NEW_API_PRICING_URL to run it)')
  else if (price.code === 0) add('ok', 'prices', price.text)
  else if (price.code === 1) add('escalate', 'price drift', price.text, 'convert the price list again (node examples/new-api-sidecar/pricing-convert.mjs pricing.json --status status.json --usd-exchange-rate <your rate> --out models.json), read the report line by line, publish the new table first (holder console step 5, your gas), then commit models.json and models.newapi-source.json here')
  else if (price.code === 3) add('undecided', 'prices', price.text, 'run it again later; a bot check in front of new-api may refuse a request from GitHub')
  else if (price.code !== 0) add('escalate', 'prices', `the price check could not run: ${price.text}`, 'check models.json and models.newapi-source.json in this repository (they come from pricing-convert.mjs --out)')

  const level = items.reduce((l, i) => (RANK[i.level] > RANK[l] ? i.level : l), 'ok')
  // The identity at a glance: the first seven checks, name to delegation. / 身份一览：前七项，从名字到委托。
  const seen = checks.filter((c) => IDENTITY_CHECKS.includes(c.id))
  const identity = { passed: seen.filter((c) => c.status === 'pass').length, of: IDENTITY_CHECKS.length, other: seen.filter((c) => c.status !== 'pass').map((c) => `${c.id} ${c.status}`) }
  return { level, exitCode: EXIT[level], items, identity }
}

/** The report, in Markdown. / Markdown 报告。 */
export function formatMarkdown({ level, items, identity }, { name, when = new Date() } = {}) {
  const head = { ok: 'OK: nothing to do', notice: 'OK: nothing to do (notes below)', undecided: 'UNDECIDED: could not read the chain, the network or the price list; nothing was decided', warn: 'WARNING: something ends soon', escalate: 'ACTION NEEDED' }[level]
  const lines = [`## TapeAPI daily check: ${name}`, '', `**${head}** (${when.toISOString().slice(0, 16).replace('T', ' ')} UTC)`, '']
  if (identity) lines.push(`Identity (the doctor's first ${identity.of} checks, name to delegation): ${identity.passed} of ${identity.of} pass${identity.other.length ? `; ${identity.other.join(', ')}` : ''}.`, '')
  if (items.length) {
    lines.push('| level | what | detail | next |', '|---|---|---|---|')
    const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, '<br>')
    for (const i of [...items].sort((a, b) => RANK[b.level] - RANK[a.level])) lines.push(`| ${i.level} | ${cell(i.what)} | ${cell(i.detail)} | ${cell(i.next)} |`)
    lines.push('')
  }
  lines.push(`Run the doctor yourself: \`tapeapi-doctor ${name}\`. A receipt proves who signed which bytes and the usage and price claimed, not which model ran.`)
  return lines.join('\n') + '\n'
}

/** tapeapi-doctor by name, the default resolution of 2.0 (conform: 'tap10'). Never throws. / 按名字运行 doctor（2.0 默认解析）。 */
export async function runDoctor(name, { createApi = createTapeAPI, rpcUrls = rpcUrlsFor(56), timeoutMs = 15_000, fetch } = {}) {
  try {
    const api = createApi({ rpcUrls, quorum: 2, conform: 'tap10' })
    const rep = await diagnose(name, { api, timeoutMs, ...(fetch ? { fetch } : {}) })
    return { exitCode: rep.exitCode, checks: rep.checks, counts: rep.counts, resolution: rep.resolution ?? 'tap10' }
  } catch (e) {
    return { exitCode: e?.code === 'INVALID_ARGUMENT' ? 2 : 3, checks: [], error: String(e?.message ?? e) }
  }
}

/** The converter's --check, on a price list file or one fetched from the operator's own new-api. Never throws.
 *  价目转换器的 --check：用文件，或从运营者自己的 new-api 取下来的价目。从不抛出。 */
export async function runPriceCheck({ pricing, pricingUrl, models, meta, status, fetch = globalThis.fetch, timeoutMs = 20_000 }) {
  let dir = null
  try {
    let file = pricing
    if (!file) {
      let res
      try { res = await fetch(pricingUrl, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } }) } catch (e) { return { code: 3, text: `GET ${pricingUrl} failed (${e?.cause?.code || e?.name || e?.message || e})` } }
      if (!res.ok) return { code: 3, text: `GET ${pricingUrl} answered HTTP ${res.status}` }
      dir = mkdtempSync(join(tmpdir(), 'tapeapi-daily-'))
      file = join(dir, 'pricing.json')
      writeFileSync(file, Buffer.from(await res.arrayBuffer()))
    }
    let text = ''
    const code = convertRun(['--check', file, '--models', models, ...(meta ? ['--meta', meta] : []), ...(status ? ['--status', status] : [])], { out: (t) => { text += t }, err: (t) => { text += t } })
    return { code, text: text.trim() }
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}

class UsageError extends Error {}
function parseArgs(argv) {
  const o = { warnDays: WARN_DAYS, escalateDays: ESCALATE_DAYS, delegationWarnDays: DELEGATION_WARN_DAYS, delegationEscalateDays: DELEGATION_ESCALATE_DAYS }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => { if (i + 1 >= argv.length || argv[i + 1] === '') throw new UsageError(`${a} needs a value`); return argv[++i] }
    switch (a) {
      case '--name': o.name = value().trim(); break
      case '--pricing': o.pricing = value(); break
      case '--pricing-url': o.pricingUrl = value().trim(); break
      case '--models': o.models = value(); break
      case '--meta': o.meta = value(); break
      case '--status': o.status = value(); break
      case '--doctor-json': o.doctorJson = value(); break
      case '--rpc': o.rpc = value().split(',').map((s) => s.trim()).filter(Boolean); break
      case '--warn-days': o.warnDays = Number(value()); break
      case '--escalate-days': o.escalateDays = Number(value()); break
      case '--delegation-warn-days': o.delegationWarnDays = Number(value()); break
      case '--delegation-escalate-days': o.delegationEscalateDays = Number(value()); break
      case '--now': o.now = Number(value()); break
      case '--help': case '-h': o.help = true; break
      default: throw new UsageError(`unknown argument ${a}`)
    }
  }
  if (o.help) return o
  // A TapeOut name: the daily check runs by name, as clients resolve it. / 按名字检查，与客户端解析方式相同。
  if (!o.name || !/^[0-9][0-9.]*\.tape$/i.test(o.name)) throw new UsageError('--name must be your TapeOut name, such as 42.1013.tape (an example name)')
  if (o.pricing && o.pricingUrl) throw new UsageError('give --pricing or --pricing-url, not both')
  if (o.pricingUrl && !/^https:\/\//i.test(o.pricingUrl)) throw new UsageError('--pricing-url must be https, such as https://api.example.com/api/pricing')
  if ((o.pricing || o.pricingUrl) && !o.models) throw new UsageError('the price check needs --models <the published models.json>')
  const FLAG = { warnDays: '--warn-days', escalateDays: '--escalate-days', delegationWarnDays: '--delegation-warn-days', delegationEscalateDays: '--delegation-escalate-days' }
  for (const k of Object.keys(FLAG)) if (!Number.isInteger(o[k]) || o[k] < 0) throw new UsageError(`${FLAG[k]} must be a whole number of days`)
  if (o.escalateDays > o.warnDays) throw new UsageError('--escalate-days must not exceed --warn-days')
  if (o.delegationEscalateDays > o.delegationWarnDays) throw new UsageError('--delegation-escalate-days must not exceed --delegation-warn-days')
  if (o.now !== undefined && !Number.isInteger(o.now)) throw new UsageError('--now must be a Unix time in seconds')
  if (o.rpc && new Set(o.rpc.map(operatorOf)).size < 2) throw new UsageError('--rpc needs nodes of at least 2 independent operators (every chain read must be agreed by 2)')
  return o
}
const USAGE = `usage: node daily-check.mjs --name <your TapeOut name> [--pricing-url <https://.../api/pricing> | --pricing <file>]
         [--models models.json] [--meta models.newapi-source.json] [--status status.json] [--doctor-json <file>]
         [--rpc url,url,...] [--warn-days 30] [--escalate-days 14] [--delegation-warn-days 7] [--delegation-escalate-days 3]
         [--now <unix seconds>]
exit: 0 ok, 4 warning (within --warn-days or --delegation-warn-days), 1 action needed, 3 undecided (could not read), 2 usage mistake
(experimental; reads only: no key, no token, no transaction)`

/** The command: prints the report on `out`, returns the exit code. / 命令：在 out 上输出报告，返回退出码。 */
export async function main(argv, { out = (t) => process.stdout.write(t), err = (t) => process.stderr.write(t), fetch = globalThis.fetch, createApi } = {}) {
  let o
  try { o = parseArgs(argv) } catch (e) { if (!(e instanceof UsageError)) throw e; err(`daily-check: ${e.message}\n${USAGE}\n`); return 2 }
  if (o.help) { out(USAGE + '\n'); return 0 }
  const now = o.now ?? Math.floor(Date.now() / 1000)
  let doctor
  if (o.doctorJson) {
    // A report saved by `tapeapi-doctor --json` (2.0 and later run the default resolution). / 由 tapeapi-doctor --json 存下的报告。
    try { doctor = JSON.parse(readFileSync(o.doctorJson, 'utf8')) } catch (e) { err(`daily-check: --doctor-json ${o.doctorJson} cannot be read (${e.code || e.message})\n`); return 2 }
  } else doctor = await runDoctor(o.name, { ...(o.rpc ? { rpcUrls: o.rpc } : {}), ...(createApi ? { createApi } : {}), fetch })
  if (doctor.exitCode === 2) { err(`daily-check: the doctor refused the name: ${doctor.error ?? 'usage'}\n`); return 2 }
  const price = o.pricing || o.pricingUrl ? await runPriceCheck({ pricing: o.pricing, pricingUrl: o.pricingUrl, models: o.models, meta: o.meta, status: o.status, fetch }) : null
  const r = evaluate({ doctor, price, name: o.name, now, warnDays: o.warnDays, escalateDays: o.escalateDays, delegationWarnDays: o.delegationWarnDays, delegationEscalateDays: o.delegationEscalateDays })
  out(formatMarkdown(r, { name: o.name, when: new Date(now * 1000) }))
  return r.exitCode
}

const isMain = (() => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false } })()
if (isMain) process.exitCode = await main(process.argv.slice(2))
