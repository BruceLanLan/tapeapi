// `tapeapi receipts statement` (@experimental, 3.0; Node only through io.host): a spend statement made from the receipts
// on this machine. Per service, model and UTC day: the receipts, the usage and the prices they claim; with --policy and
// --mandate, the caps of your own policy file and of a mandate alongside. It is the agent's (or the buyer's) own summary:
// nothing signs it. Each receipt it adds up was signed by its service and proves only what that service claimed.
// The agent kit's spendStatement / spendEvidence (phase 1, M7) are a different thing: the channel's claimedOf at
// delivery, read on an escrow channel and put in a signed deliver result. They need an escrow; this reads receipts only,
// so it does not reuse them. Totals are counted as `tapeapi reconcile` counts them (policy.js claimOf, one receipt once
// by signature, the same --since / --until), so the two agree on the same files.
// tapeapi receipts statement（实验性，3.0）：用本机回执生成的花费声明。按服务、模型、UTC 日列出回执、声称的用量与价格；给了
// --policy / --mandate 时把你自己的策略文件与授权书的上限并列。这是代理（或买家）自己的汇总，没有任何签名；它加总的每张回执由各自的
// 服务签名，只证明该服务声称了什么。agent 套件的 spendStatement / spendEvidence（阶段 1）是另一回事：交付时通道的 claimedOf，要有
// 托管通道；这里只读回执，因此不复用它们。合计与 tapeapi reconcile 的计法相同，同样的文件两者一致。
import { NOTES } from './connect.js'
import {
  T, parseOptions, commonOptions, loadSource, filterRecords, ui, usageExit, usage, redactKeeping, keepOf, clean, iso, at, shown, table, hostOf,
} from './receipts-cli.js'
import { claimOf, mandateOf, mandateSpend, policyOf, policyCheck } from './reconcile-checks.js'
import { mandateLines, policyLines } from './reconcile-cli.js'
import { openSent, windowSpend } from './budget.js'
import { units8, fromUnits8, windowOf } from './policy.js'

export const STATEMENT_FORMAT = 'tapeapi-statement/1'
export const SNOTES = Object.freeze({
  unsigned: T("This statement is your own summary of the receipts on this machine: nothing signs it, and anyone you show it to has only your word for it. Each receipt it adds up was signed by its service and proves only what that service claimed (usage and price), not what was paid and not which model ran.",
    '这份声明是你对本机回执的自己的汇总：没有任何签名，你给别人看时，别人只能凭你的话。它加总的每张回执由各自的服务签名，只证明该服务声称了什么（用量与价格），不证明实际付了多少，也不证明实际运行的是哪个模型。'),
  kit: T("Not the agent kit's spendStatement / spendEvidence: those state an escrow channel's claimedOf at delivery (phase 1) inside a signed deliver result; this reads receipts only and needs no escrow.",
    '不是 agent 套件的 spendStatement / spendEvidence：那两者是交付时托管通道的 claimedOf（阶段 1），写在签名的交付结果里；这里只读回执，不需要托管。'),
  open: T('Calls written down as sent by a client-side budget with no verified receipt are listed at their worst case. They are not claims, and they are not in the totals.',
    '客户端预算记为已发出、但没有核验过的回执的调用，按最坏情况列出。它们不是声称，不计入合计。'),
  caps: T("The caps are your own (the policy file) or the mandate's, set next to what the receipts claim in the period; windows count the receipts in the period only. Nothing here enforces them.",
    '上限来自你自己的策略文件或授权书，与期间内回执声称的数并列；窗口只计期间内的回执。这里不执行任何限制。'),
})

/**
 * The statement, pure: `records` (readRecords, already filtered to the period), `sent` (the sent lines of a budget
 * store), `allRecords` (every record read: a receipt outside the period may still answer a sent line), `from` / `to`
 * (unix seconds), `rules` (policyOf) and `mandate` (mandateOf) with `mandateOpts` (mandateSpend's). / 声明本身（纯函数）。
 */
export function receiptStatement({ records, sent = [], released = [], allRecords = records, from, to, rules = null, mandate = null, mandateOpts = {} } = {}) {
  const seen = new Set()
  const claims = []
  let notClaims = 0, duplicates = 0
  for (const rec of records) {
    const e = rec.envelope
    if (!e || typeof e !== 'object') continue
    const key = typeof e.sig === 'string' ? e.sig : JSON.stringify(e)
    if (seen.has(key)) { duplicates++; continue }
    seen.add(key)
    const c = claimOf(rec)
    if (c) claims.push(c); else notClaims++
  }
  const add = (acc, c) => {
    acc.receipts++; acc.promptTokens += c.prompt ?? 0; acc.completionTokens += c.completion ?? 0
    let priced = false
    for (const p of c.prices ?? []) {
      const u = units8(typeof p.amount === 'string' ? p.amount : '')
      if (u === null || typeof p.currency !== 'string') continue
      acc.units[p.currency] = (acc.units[p.currency] ?? 0n) + u; priced = true
    }
    if (!priced) acc.unpriced++
  }
  const blank = (k) => ({ ...k, receipts: 0, promptTokens: 0, completionTokens: 0, units: {}, unpriced: 0 })
  const done = (x) => { const { units, ...rest } = x; return { ...rest, amounts: Object.fromEntries(Object.entries(units).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, fromUnits8(v)])) } }
  const groups = new Map(), services = new Map(), totals = blank({})
  for (const c of claims) {
    const service = c.container ?? null, model = c.model ?? null, day = c.t === null ? null : windowOf('day', c.t)
    const gk = JSON.stringify([service?.toLowerCase() ?? null, model, day]), sk = service?.toLowerCase() ?? null
    if (!groups.has(gk)) groups.set(gk, blank({ service, model, day }))
    if (!services.has(sk)) services.set(sk, blank({ service }))
    add(groups.get(gk), c); add(services.get(sk), c); add(totals, c)
  }
  const inPeriod = (t) => (from === null || from === undefined || t >= from) && (to === null || to === undefined || t < to)
  const open = openSent(sent, allRecords.filter((r) => r.envelope), released).filter((s) => inPeriod(s.ts))
  const openUnits = {}
  for (const s of open) for (const p of s.worstCase) openUnits[p.currency] = (openUnits[p.currency] ?? 0n) + units8(p.amount)
  let policy = null
  if (rules) {
    const facts = policyCheck(claims, rules)
    policy = facts.map((f) => {
      const rule = f.rule
      let windows = []
      if (rule.period !== 'call') {
        const keys = new Set()
        for (const c of claims) { const w = windowOf(rule.period, c.t); if (w !== null) keys.add(w) }
        for (const s of open) keys.add(windowOf(rule.period, s.ts))
        windows = [...keys].sort().map((w) => {
          const h = windowSpend(rule, claims, open, w)
          const cur = (x) => ({ calls: x.calls, promptTokens: x.prompt, completionTokens: x.completion, ...(rule.currency ? { amount: fromUnits8(x.amount) } : {}) })
          return { window: w, claimed: cur(h.claimed), worstCase: cur(h.worstCase) }
        }).filter((x) => x.claimed.calls || x.worstCase.calls)
      }
      const max = Object.fromEntries(['maxAmount', 'maxCalls', 'maxPromptTokens', 'maxCompletionTokens'].filter((k) => rule[k] !== undefined).map((k) => [k, k === 'maxAmount' ? `${rule.maxAmount} ${rule.currency}` : rule[k]]))
      return { rule: rule.name, service: rule.service, model: rule.model, period: rule.period, max, receipts: f.receipts, windowCount: f.windows, windows, over: f.over, noTime: f.noTime }
    })
  }
  const spend = mandate ? mandateSpend(claims, mandate, mandateOpts) : null
  const order = (a, b) => (JSON.stringify([a.service, a.day, a.model]) < JSON.stringify([b.service, b.day, b.model]) ? -1 : 1)
  return {
    format: STATEMENT_FORMAT, signed: false, from: from ?? null, to: to ?? null,
    counts: { records: records.length, claims: claims.length, notClaims, duplicates, openSent: open.length },
    groups: [...groups.values()].map(done).sort(order), services: [...services.values()].map(done).sort(order), totals: done(totals),
    open: { calls: open.length, worstCase: Object.fromEntries(Object.entries(openUnits).map(([k, v]) => [k, fromUnits8(v)])), sources: open.map((s) => s.source) },
    policy, mandate: spend, claimList: claims,
  }
}

export function statementUsage(cmd = 'tapeapi') {
  return `${cmd} receipts statement (experimental / 实验性): a spend statement from the receipts on this machine.
用本机回执生成的花费声明。

Usage:
  ${cmd} receipts statement --receipts <file|dir> --from <t> --to <t> [--policy <file>] [--mandate <file>
      [--token-decimals <n>] [--mandate-currency <c>] [--near <f>]] [--service <s>] [--container <addr>] [--model <id>] [--json]

  --receipts <path>    receipt files: tapeapi-verify --log lines, bare receipt envelopes, or a client-side budget's store
                       (createVerifyingFetch({ policy, budgetStore })). Also --log      回执文件；也可以是客户端预算的存储文件
  --from <t>, --to <t> the period, signed at or after --from and before --to (2026-10-01, 2026-10-01T08:00:00Z or unix
                       seconds; also --since, --until)       期间：签名时间不早于 --from、早于 --to
  --policy <file>      your own policy file (the one tapeapi reconcile --policy reads): its caps alongside, per window
  --mandate <file>     a mandate: its caps per provider alongside (as tapeapi reconcile --mandate; --token-decimals to compare)
  --json               one JSON object on stdout     --lang <en|zh|both>   (default both)     --no-color     --help

Per service, model and UTC day: the receipts, the tokens and the prices they claim, counted as tapeapi reconcile counts
them. Nothing signs the statement: it is your own summary. Files only: no network, no key, nothing uploaded.
按服务、模型、UTC 日：回执数、声称的 token 与价格，计法与 tapeapi reconcile 相同。声明没有任何签名，是你自己的汇总。只读文件：不联网、
不需要密钥、不上传。
Exit status: 0 done; 2 a usage mistake.   退出码：0 完成；2 用法错误。
`
}

const SPEC = {
  '--receipts': 'value', '--log': '--receipts', '--from': '--since', '--to': '--until', '--since': 'value', '--until': 'value', '--service': 'value', '--container': 'value', '--model': 'value',
  '--policy': 'value', '--mandate': 'value', '--token-decimals': 'value', '--mandate-currency': 'value', '--near': 'value',
  '--json': 'bool', '--lang': 'value', '--no-color': 'bool', '--help': 'bool', '-h': '--help',
}

/** Run `tapeapi receipts statement` with `argv` (the words after `statement`). io as runReceipts. Returns { exitCode }. */
export async function runStatement(argv, io = {}) {
  const { cmd = 'tapeapi', version = '', env = process.env } = io
  const h = hostOf(io.host, io.cwd ?? process.cwd())
  const stdout = io.stdout ?? ((s) => process.stdout.write(s))
  const stderr = io.stderr ?? ((s) => process.stderr.write(s))
  const isTTY = io.isTTY ?? process.stdout.isTTY === true
  let keep = []
  const say = (write, text) => write(redactKeeping(text, keep, env))
  const help = statementUsage(cmd)
  let o, common, src, rules = null, mandate = null, mandateOpts = {}
  try {
    const parsed = parseOptions(argv, SPEC)
    o = parsed.opts
    if (o['--help']) { say(stdout, help); return { exitCode: 0 } }
    if (parsed.positional.length) throw usage(`unexpected ${JSON.stringify(parsed.positional[0])}`, `多余的参数 ${JSON.stringify(parsed.positional[0])}`)
    common = commonOptions(o)
    if (o['--since'] === undefined || o['--until'] === undefined) throw usage('--from <t> and --to <t> are needed: the period of the statement', '需要 --from <时间> 与 --to <时间>：声明的期间')
    for (const f of ['--token-decimals', '--mandate-currency', '--near']) if (o[f] !== undefined && o['--mandate'] === undefined) throw usage(`${f} applies with --mandate only`, `${f} 只与 --mandate 一起使用`)
    if (o['--token-decimals'] !== undefined) {
      if (!/^\d+$/.test(o['--token-decimals']) || Number(o['--token-decimals']) > 77) throw usage('--token-decimals must be a whole number, at most 77', '--token-decimals 必须是不超过 77 的整数')
      mandateOpts.tokenDecimals = Number(o['--token-decimals'])
    }
    if (o['--near'] !== undefined) {
      const n = Number(o['--near'])
      if (!/^\d+(\.\d+)?$/.test(o['--near']) || !(n > 0 && n <= 1)) throw usage('--near must be a fraction above 0 and at most 1, such as 0.8', '--near 必须是大于 0、不超过 1 的比例，例如 0.8')
      mandateOpts.near = n
    }
    if (o['--mandate-currency'] !== undefined) mandateOpts.currency = o['--mandate-currency']
    src = loadSource(o, h)
    if (src.filters.since !== null && src.filters.until !== null && src.filters.since >= src.filters.until) throw usage('--from must be before --to', '--from 必须早于 --to')
    const readJson = (flag, what, zh) => {
      try { return JSON.parse(h.readFileSync(at(o[flag], h), 'utf8').replace(/^\uFEFF/, '')) } catch (e) { throw usage(`cannot read the ${what} ${o[flag]}: ${e.code ?? e.message}`, `读不了${zh} ${o[flag]}：${e.code ?? e.message}`) }
    }
    if (o['--policy'] !== undefined) { const v = readJson('--policy', 'policy', '策略文件'); try { rules = policyOf(v) } catch (e) { throw usage(`${o['--policy']}: ${e.message}`, `${o['--policy']}：${e.message}`) } }
    if (o['--mandate'] !== undefined) { const v = readJson('--mandate', 'mandate', '授权书'); try { mandate = mandateOf(v) } catch (e) { throw usage(`${o['--mandate']} is not a mandate: ${e.message}`, `${o['--mandate']} 不是授权书：${e.message}`) } }
  } catch (e) {
    if (!e.usage) throw e
    return usageExit({ e, prog: `${cmd} receipts statement`, help, cmd: `${cmd} receipts statement`, stderr, say })
  }
  const U = ui({ lang: common.lang, color: !common.noColor && isTTY && !common.json && (env.NO_COLOR === undefined || env.NO_COLOR === '') })
  keep = keepOf(src.records)
  const { since, until } = src.filters
  const records = filterRecords(src.records, src.filters).filter((r) => r.envelope)
  const cf = src.filters.containers, mf = src.filters.model
  const sent = (src.sent ?? []).filter((s) => (!cf || (s.container && cf.has(s.container.toLowerCase()))) && (mf === null || s.models.includes(mf)))
  const st = receiptStatement({ records, sent, released: src.released ?? [], allRecords: src.records, from: since, to: until, rules, mandate, mandateOpts })
  const { claimList: _claims, ...statement } = st
  const policyFile = rules ? shown(at(o['--policy'], h), h) : null, mandateFile = mandate ? shown(at(o['--mandate'], h), h) : null
  if (common.json) {
    const L = (t) => (U.lang === 'en' ? t.en : U.lang === 'zh' ? t.zh : t)
    say(stdout, JSON.stringify({
      tool: 'tapeapi', command: 'receipts statement', version, experimental: true, ok: true, exitCode: 0, source: src.path, skipped: src.skipped,
      statement: { ...statement, policy: statement.policy && { source: policyFile, rules: statement.policy }, mandate: statement.mandate && { source: mandateFile, ...statement.mandate } },
      notes: { unsigned: L(SNOTES.unsigned), kit: L(SNOTES.kit), receipt: L(NOTES.receipt), ...(statement.open.calls ? { open: L(SNOTES.open) } : {}), ...(rules || mandate ? { caps: L(SNOTES.caps) } : {}) }, next: null,
    }, null, 2) + '\n')
    return { exitCode: 0 }
  }
  const v = (x) => (x === null || x === undefined ? 'null' : clean(x))
  const amounts = (a) => Object.entries(a).map(([c, n]) => `${n} ${clean(c)}`).join(' / ') || '-'
  const out = [`tapeapi receipts statement${version ? ` ${version}` : ''} ${U.experimental}   ${U.lab(T('your own summary, signed by nothing', '你自己的汇总，没有任何签名'))}`]
  out.push(`  ${U.lab(T('period', '期间'))}: ${iso(since)} .. ${iso(until)}  (${U.lab(T('from inclusive, to exclusive', '含起点，不含终点'))})`)
  out.push(`  ${U.lab(T('receipts', '回执'))}: ${clean(src.path)}   ${U.lang === 'zh' ? `期间内 ${statement.counts.claims} 张声称用量，${statement.counts.notClaims} 张未声称用量${statement.counts.duplicates ? `，${statement.counts.duplicates} 张重复` : ''}${src.skipped.length ? `，${src.skipped.length} 行跳过` : ''}`
    : `${statement.counts.claims} claiming usage in the period, ${statement.counts.notClaims} claiming none${statement.counts.duplicates ? `, ${statement.counts.duplicates} duplicates` : ''}${src.skipped.length ? `, ${src.skipped.length} lines skipped` : ''}`}`)
  out.push('')
  if (!statement.groups.length) out.push(...U.say(T('No receipt claims usage in the period.', '期间内没有声称用量的回执。'), '  '))
  else {
    const L = (en, zh) => (U.lang === 'zh' ? zh : en)
    out.push(...table([[L('service', '服务'), L('model', '模型'), L('day (UTC)', '日期 (UTC)'), L('receipts', '回执'), 'in', 'out', L('claimed', '声称的价格')],
      ...statement.groups.map((g) => [v(g.service), v(g.model), v(g.day), String(g.receipts), String(g.promptTokens), String(g.completionTokens), `${amounts(g.amounts)}${g.unpriced ? `  (${g.unpriced} ${L('unpriced', '张无价格')})` : ''}`])]))
    out.push('', `  ${U.bold(U.lab(T('per service', '按服务')))}`)
    out.push(...table(statement.services.map((x) => [v(x.service), `${x.receipts} ${L('receipts', '张回执')}`, `in ${x.promptTokens}`, `out ${x.completionTokens}`, amounts(x.amounts)]), '    '))
    const t = statement.totals
    out.push(`  ${U.bold(U.lab(T('total', '合计')))}: ${t.receipts} ${L('receipts', '张回执')}  in ${t.promptTokens}  out ${t.completionTokens}  ${amounts(t.amounts)}`)
  }
  if (statement.open.calls) {
    out.push('', `  ${U.yellow(U.lab(T(`SENT, NO VERIFIED RECEIPT: ${statement.open.calls} (worst case ${amounts(statement.open.worstCase)}; not in the totals)`, `已发出、没有核验过的回执：${statement.open.calls} 次（最坏情况 ${amounts(statement.open.worstCase)}；不计入合计）`)))}`)
    for (const s of statement.open.sources.slice(0, 20)) out.push(`    ${s}`)
    if (statement.open.sources.length > 20) out.push(`    … ${statement.open.sources.length - 20}`)
  }
  if (statement.policy) {
    out.push('', ...policyLines(statement.policy.map((p, i) => ({ rule: rules[i], receipts: p.receipts, windows: p.windowCount, over: p.over, noTime: p.noTime })), U, v, policyFile))
    for (const p of statement.policy) for (const w of p.windows) {
      const c = w.claimed, x = w.worstCase
      out.push(`      ${clean(p.rule)} ${clean(w.window)}: ${U.lab(T('claimed', '声称'))} ${c.calls} ${U.lang === 'zh' ? '次' : 'calls'}${c.amount !== undefined ? ` ${c.amount}` : ''} in ${c.promptTokens} out ${c.completionTokens}${x.calls ? `; ${U.lab(T('sent, no receipt', '已发出无回执'))} ${x.calls}${x.amount !== undefined ? ` ≤ ${x.amount}` : ''}` : ''}   max ${Object.values(p.max).map(clean).join(', ')}`)
    }
  }
  if (statement.mandate) out.push('', ...mandateLines(statement.mandate, U, v, mandateFile))
  out.push('', ...U.say(SNOTES.unsigned, '  '), ...U.say(SNOTES.kit, '  '), ...U.say(NOTES.receipt, '  '))
  if (statement.open.calls) out.push(...U.say(SNOTES.open, '  '))
  if (rules || mandate) out.push(...U.say(SNOTES.caps, '  '))
  say(stdout, out.join('\n') + '\n')
  return { exitCode: 0 }
}
