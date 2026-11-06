// The daily check template (E9): daily-check.mjs weighs a doctor report (the default resolution of 2.0) and the price
// converter's --check into ok / warn / action needed / undecided, with the next command; tapeapi-daily-check.yml runs it
// in the operator's own GitHub account with every action pinned to a commit SHA and no secret. Network-free: the doctor
// report is a saved one (a real report of the chain demo, local port normalised), the price list a fixture.
// 每日检查模板：daily-check.mjs 把 doctor 报告（2.0 默认解析）与价目 --check 合成正常/预警/需要处理/未定，并给出下一条命令；
// tapeapi-daily-check.yml 在运营者自己的 GitHub 账号里运行它，每个 action 都钉到提交 SHA，不用任何机密。不联网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { evaluate, formatMarkdown, main, runDoctor, runPriceCheck, delegationDaysOf, activationDaysOf, activationEndDaysOf, monthlyFeeWeiOf, IDENTITY_CHECKS, EXIT } from './daily-check.mjs'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const REPORT = JSON.parse(readFileSync(here('../fixtures/doctor-report.sample.json'), 'utf8'))
const PRICING = here('../fixtures/new-api-pricing.sample.json')
const MODELS = here('../fixtures/new-api-pricing.sample.models.json')
const tmp = mkdtempSync(join(tmpdir(), 'daily-check-'))
test.after(() => rmSync(tmp, { recursive: true, force: true }))
const NOW = Math.floor(Date.parse('2026-10-13T00:00:00Z') / 1000)
const DAY = 86_400
const iso = (s) => new Date(s * 1000).toISOString().slice(0, 10)
/** The saved report with some checks replaced. / 替换了部分检查的报告副本。 */
const report = (patch = {}, extra = {}) => ({ ...structuredClone(REPORT), ...extra, checks: REPORT.checks.map((c) => (patch[c.id] ? { ...c, ...patch[c.id] } : structuredClone(c))) })
const levels = (r) => r.items.map((i) => `${i.level} ${i.what}`)
const capture = async (argv, o = {}) => { let out = '', err = ''; const code = await main(argv, { out: (t) => { out += t }, err: (t) => { err += t }, ...o }); return { code, out, err } }

test('E9-1: the saved report of a healthy name is ok; the identity is the doctor\'s first seven checks', () => {
  assert.deepEqual([...IDENTITY_CHECKS], ['name', 'circuit', 'container', 'activation', 'manifest-file', 'manifest-format', 'delegation'])
  const r = evaluate({ doctor: REPORT, price: { code: 0, text: 'no drift' }, name: '42.7.tape', now: NOW })
  assert.equal(r.level, 'notice', JSON.stringify(levels(r)))
  assert.equal(r.exitCode, 0)
  assert.deepEqual(r.identity, { passed: 7, of: 7, other: [] })
  // The doctor's own price hint (output below input) is a note, not an alert. / doctor 自己的价目提示只是说明，不告警。
  assert.ok(r.items.some((i) => i.level === 'notice' && i.what === 'prices' && /swapped\?/.test(i.detail)))
  const md = formatMarkdown(r, { name: '42.7.tape', when: new Date(NOW * 1000) })
  assert.match(md, /^## TapeAPI daily check: 42\.7\.tape$/m)
  assert.match(md, /Identity \(the doctor's first 7 checks, name to delegation\): 7 of 7 pass\./)
  assert.match(md, /not which model ran/)
})

// 3.0 candidate: the console signs 30 days by default, so the delegation has thresholds of its own (7 and 3 days); with
// the activation's 30 and 14, a fresh 30-day delegation would alert on its first day. The flags still choose any value.
// 3.0 候选：操作台默认签 30 天，委托有自己的阈值（7 天、3 天）；若沿用激活的 30、14 天，新签的 30 天委托第一天就会告警。
test('E9-2: the delegation: 7 days or fewer warns, 3 or fewer needs action (the doctor\'s two wordings); a fresh 30-day one is quiet', () => {
  assert.equal(delegationDaysOf('90 days left, until 2027-01-11; signed by the holder 0xabc'), 90)
  assert.equal(delegationDaysOf('3 day(s) left, until 2026-10-16'), 3)
  assert.equal(delegationDaysOf('no delegation'), null)
  const at = (status, detail) => evaluate({ doctor: report({ delegation: { status, detail } }), now: NOW })
  assert.equal(at('pass', '31 days left, until 2026-11-13').items.some((i) => i.what === 'delegation'), false)
  for (const d of [29, 20, 8]) assert.equal(at('pass', `${d} days left, until 2026-11-11`).items.some((i) => i.what === 'delegation'), false, `${d} days`)
  const w = at('warn', '7 day(s) left, until 2026-10-20')
  assert.equal(w.level, 'warn')
  assert.equal(w.exitCode, EXIT.warn)
  assert.match(w.items.find((i) => i.what === 'delegation').next, /holder console step 4 \("renew"\).*step 5 publishes the manifest again \(one transaction, your gas\)/)
  assert.equal(at('warn', '4 day(s) left, until 2026-10-17').level, 'warn')
  assert.equal(at('warn', '3 day(s) left, until 2026-10-16').level, 'escalate')
  assert.equal(at('warn', '0 day(s) left, until 2026-10-13').exitCode, 1)
  // The old thresholds stay reachable / 旧阈值仍可选：delegationWarnDays 30, delegationEscalateDays 14
  const old = (detail) => evaluate({ doctor: report({ delegation: { status: 'pass', detail } }), now: NOW, delegationWarnDays: 30, delegationEscalateDays: 14 }).items.find((i) => i.what === 'delegation')?.level
  assert.equal(old('30 days left, until 2026-11-12'), 'warn'); assert.equal(old('14 days left, until 2026-10-27'), 'escalate'); assert.equal(old('31 days left, until 2026-11-13'), undefined)
})

test('E9-3: activation: not activated is a failure (2.0 default), and its end date warns at 30 days, needs action at 14', () => {
  const unpaid = evaluate({ doctor: report({ activation: { status: 'warn', detail: '42.7.tape is not activated: isLive and isContainerLive are both false.', fix: 'Activate it on DomainBinding ...' } }), now: NOW })
  assert.equal(unpaid.level, 'escalate')
  assert.match(unpaid.items.find((i) => i.what === 'activation').detail, /a failure, not a warning/)
  assert.deepEqual(unpaid.identity.other, ['activation warn'])
  const paid = (days) => evaluate({ doctor: report({ activation: { status: 'pass', detail: `activated: isLive and isContainerLive are true; paid until ${iso(NOW + days * DAY)} (containerPaidUntil)` } }), now: NOW })
  assert.equal(activationDaysOf(`activated: x; paid until ${iso(NOW + 45 * DAY)} (containerPaidUntil)`, NOW), 45)
  assert.equal(paid(45).items.some((i) => i.what === 'activation'), false)
  assert.equal(paid(30).level, 'warn')
  assert.equal(paid(14).level, 'escalate')
  assert.match(paid(14).items.find((i) => i.what === 'activation').next, /you pay it and the gas; read monthlyFee\(\) on chain when you pay/)
  // No date in the doctor's words: a note to look monthly, not a guess. / doctor 没给日期：提示每月看一次，不猜。
  assert.equal(evaluate({ doctor: REPORT, now: NOW }).items.find((i) => i.what === 'activation').level, 'notice')
})

test('E9-3b: the 2.2 structured fields come first: paidUntilSeconds over the detail, and a monthlyFeeWei that is not 0 warns', () => {
  // A detail that says 45 days while the structured field says 10: the field wins. / 文字说 45 天、字段说 10 天：以字段为准。
  const check = (o) => ({ status: 'pass', detail: `activated: isContainerLive(container) is true; paid until ${iso(NOW + 45 * DAY)} (containerPaidUntil)`, paidUntil: null, monthlyFeeWei: '0', ...o })
  assert.equal(activationEndDaysOf(check({ paidUntilSeconds: NOW + 10 * DAY }), NOW), 10)
  assert.equal(activationEndDaysOf(check({ paidUntilSeconds: null }), NOW), 45)
  assert.equal(activationEndDaysOf({ detail: 'activated: x' }, NOW), null)
  assert.equal(evaluate({ doctor: report({ activation: check({ paidUntilSeconds: NOW + 10 * DAY }) }), now: NOW }).level, 'escalate')
  assert.equal(evaluate({ doctor: report({ activation: check({ paidUntilSeconds: NOW + 25 * DAY }) }), now: NOW }).level, 'warn')
  // monthlyFeeWei: '0' says nothing; not 0 is a warning (exit 4, the issue); malformed is ignored. / 为 0 不提示；非 0 预警。
  assert.equal(monthlyFeeWeiOf(check({})), 0n)
  assert.equal(monthlyFeeWeiOf({ monthlyFeeWei: '12x' }), null)
  assert.equal(monthlyFeeWeiOf({}), null)
  assert.equal(evaluate({ doctor: report({ activation: check({ paidUntilSeconds: NOW + 90 * DAY }) }), now: NOW }).items.some((i) => i.what === 'monthly fee'), false)
  const fee = evaluate({ doctor: report({ activation: check({ paidUntilSeconds: NOW + 90 * DAY, monthlyFeeWei: '1000000000000000' }) }), now: NOW })
  assert.equal(fee.level, 'warn')
  assert.equal(fee.exitCode, EXIT.warn)
  assert.match(fee.items.find((i) => i.what === 'monthly fee').detail, /1000000000000000 wei per 30 days, not 0/)
})

test('E9-4: a failed check needs action and carries the doctor\'s own next command; blocked ones are not repeated', () => {
  const r = evaluate({ doctor: report({ reach: { status: 'fail', detail: 'https://tape.example.com: connection refused', fix: { en: 'Check your reverse proxy.', zh: '检查反向代理。' }, next: 'tapeapi-doctor https://tape.example.com' }, cors: { status: 'blocked', detail: 'needs reach' } }, { exitCode: 1 }), now: NOW })
  assert.equal(r.level, 'escalate')
  const reach = r.items.find((i) => i.what === 'reach')
  assert.equal(reach.next, 'tapeapi-doctor https://tape.example.com')
  assert.equal(r.items.some((i) => i.what === 'cors'), false)
})

test('E9-5: a chain or network that could not be read decides nothing (undecided, no alert) unless something else needs action', () => {
  const r = evaluate({ doctor: { exitCode: 3, checks: [], error: 'fetch failed' }, now: NOW })
  assert.equal(r.level, 'undecided')
  assert.equal(r.exitCode, 3)
  assert.match(r.items[0].next, /run it again later/)
  assert.equal(evaluate({ doctor: { exitCode: 3, checks: [] }, price: { code: 1, text: 'DRIFT price-changed: x' }, now: NOW }).level, 'escalate')
  assert.equal(evaluate({ doctor: report({ delegation: { status: 'warn', detail: '5 day(s) left, until x' } }), price: { code: 3, text: 'GET failed' }, now: NOW }).level, 'warn')
})

test('E9-6: the price check: drift needs action with the steps in order; unreadable is undecided; a bad file needs action', async () => {
  const clean = await runPriceCheck({ pricing: PRICING, models: MODELS })
  assert.equal(clean.code, 0, clean.text)
  assert.match(clean.text, /no drift/)
  const site = JSON.parse(readFileSync(PRICING, 'utf8'))
  site.data[0].model_ratio = Number(site.data[0].model_ratio) * 2
  const changed = join(tmp, 'pricing-changed.json')
  writeFileSync(changed, JSON.stringify(site))
  // The source record sits next to the published table, as --out wrote it. / 来源记录与已发布的价目表在一起。
  const drift = await runPriceCheck({ pricing: changed, models: MODELS })
  assert.equal(drift.code, 1)
  assert.match(drift.text, /DRIFT price-changed/)
  const r = evaluate({ doctor: REPORT, price: drift, now: NOW })
  assert.equal(r.level, 'escalate')
  assert.match(r.items.find((i) => i.what === 'price drift').next, /publish the new table first \(holder console step 5, your gas\), then commit models\.json and models\.newapi-source\.json here/)
  // Fetched from the operator's own site: an answer that is not 200, or no answer, decides nothing.
  // 从运营者自己的站点取：非 200 或没有回答都不下结论。
  const no = await runPriceCheck({ pricingUrl: 'https://api.example.com/api/pricing', models: MODELS, fetch: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }) } })
  assert.deepEqual(no, { code: 3, text: 'GET https://api.example.com/api/pricing failed (ENOTFOUND)' })
  const blocked = await runPriceCheck({ pricingUrl: 'https://api.example.com/api/pricing', models: MODELS, fetch: async () => new Response('challenge', { status: 403 }) })
  assert.equal(blocked.code, 3)
  const fetched = await runPriceCheck({ pricingUrl: 'https://api.example.com/api/pricing', models: MODELS, fetch: async (url) => { assert.equal(url, 'https://api.example.com/api/pricing'); return new Response(readFileSync(PRICING)) } })
  assert.equal(fetched.code, 0, fetched.text)
  const bad = await runPriceCheck({ pricing: PRICING, models: join(tmp, 'missing.json') })
  assert.equal(bad.code, 2)
  assert.equal(evaluate({ doctor: REPORT, price: bad, now: NOW }).level, 'escalate')
  assert.equal(evaluate({ doctor: REPORT, price: null, now: NOW }).items.find((i) => i.what === 'prices' && /skipped/.test(i.detail)).level, 'notice')
})

test('E9-7: the doctor runs by name with the default resolution of 2.0 (conform: tap10), and never throws', async () => {
  const seen = []
  const r = await runDoctor('42.1013.tape', { createApi: (o) => { seen.push(o); throw Object.assign(new Error('fetch failed'), { code: 'NETWORK' }) } })
  assert.equal(seen[0].conform, 'tap10')
  assert.equal(seen[0].quorum, 2)
  assert.ok(seen[0].rpcUrls.length >= 2)
  assert.equal(r.exitCode, 3)
  assert.equal((await runDoctor('42.1013.tape', { createApi: () => { throw Object.assign(new Error('bad'), { code: 'INVALID_ARGUMENT' }) } })).exitCode, 2)
})

test('E9-8: the command: exit 0 / 1 / 3 / 4 with a Markdown report; usage mistakes are 2', async () => {
  const doc = join(tmp, 'report.json')
  writeFileSync(doc, JSON.stringify(REPORT))
  const ok = await capture(['--name', '42.7.tape', '--doctor-json', doc, '--pricing', PRICING, '--models', MODELS, '--now', String(NOW)])
  assert.equal(ok.code, 0, ok.err)
  assert.match(ok.out, /\*\*OK: nothing to do \(notes below\)\*\* \(2026-10-13 00:00 UTC\)/)
  const soon = join(tmp, 'soon.json')
  writeFileSync(soon, JSON.stringify(report({ delegation: { status: 'warn', detail: '5 day(s) left, until 2026-10-18' } })))
  assert.equal((await capture(['--name', '42.7.tape', '--doctor-json', soon])).code, 4)
  const later = join(tmp, 'later.json')
  writeFileSync(later, JSON.stringify(report({ delegation: { status: 'pass', detail: '21 days left, until 2026-11-03' } })))
  assert.equal((await capture(['--name', '42.7.tape', '--doctor-json', later, '--now', String(NOW)])).code, 0)
  assert.equal((await capture(['--name', '42.7.tape', '--doctor-json', later, '--now', String(NOW), '--delegation-warn-days', '30', '--delegation-escalate-days', '14'])).code, 4)
  const down = join(tmp, 'down.json')
  writeFileSync(down, JSON.stringify({ exitCode: 3, checks: [] }))
  const und = await capture(['--name', '42.7.tape', '--doctor-json', down])
  assert.equal(und.code, 3)
  assert.match(und.out, /UNDECIDED/)
  for (const argv of [[], ['--name', 'example.com'], ['--name', '42.7.tape', '--pricing-url', 'http://api.example.com/api/pricing', '--models', MODELS], ['--name', '42.7.tape', '--pricing', PRICING], ['--name', '42.7.tape', '--escalate-days', '40'], ['--name', '42.7.tape', '--delegation-escalate-days', '9'], ['--name', '42.7.tape', '--delegation-warn-days', 'x'], ['--name', '42.7.tape', '--rpc', 'https://a.example/x,https://a.example/y'], ['--bogus']]) {
    const r = await capture(argv)
    assert.equal(r.code, 2, `${argv.join(' ')}: ${r.out}`)
    assert.match(r.err, /^daily-check: /)
  }
  // Run as a program, too (the workflow's way). / 也按程序方式运行（工作流的方式）。
  const p = spawnSync(process.execPath, [here('daily-check.mjs'), '--name', '42.7.tape', '--doctor-json', doc], { encoding: 'utf8', timeout: 300_000, killSignal: 'SIGKILL' })
  assert.equal(p.status, 0, p.stderr)
  assert.match(p.stdout, /TapeAPI daily check: 42\.7\.tape/)
})

// ---- the workflow template ----
const WF = readFileSync(here('tapeapi-daily-check.yml'), 'utf8')
const CI = readFileSync(here('../../../.github/workflows/ci.yml'), 'utf8')

test('E9-9: every action in the template is pinned to a 40-hex commit with its tag, the same SHAs as ci.yml', () => {
  const uses = [...WF.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/gm)]
  assert.ok(uses.length >= 3)
  const ciPins = new Map([...CI.matchAll(/uses:\s*([^@\s]+)@([0-9a-f]{40})/g)].map((m) => [m[1], m[2]]))
  for (const [, ref, rest] of uses) {
    assert.match(ref, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/, `${ref} must be pinned to a commit SHA`)
    assert.match(rest, /^\s+# v\d+(\.\d+)*\s*$/, `${ref} carries its tag in a comment`)
    const [action, sha] = ref.split('@')
    assert.equal(sha, ciPins.get(action), `${action}: the same commit as the repository's own ci.yml`)
  }
  // Only GitHub's own actions: nothing else runs with the job's token. / 只用 GitHub 自己的 action。
  for (const [, ref] of uses) assert.match(ref, /^actions\//)
})

test('E9-10: the template runs in the operator\'s account with no secret, least permissions, once a day, and a pinned TapeAPI', () => {
  assert.match(WF, /^permissions:\n {2}contents: read\b.*\n {2}issues: write\b/m)
  assert.doesNotMatch(WF, /secrets\./, 'no secret is read')
  assert.doesNotMatch(WF, /SIGNER_KEY\s*[:=]|admin[_ ]token\s*[:=]|\bsk-[A-Za-z0-9]/i, 'no key or token is set or asked for')
  assert.doesNotMatch(WF, /pull_request_target|\bpull_request\b/)
  assert.match(WF, /^ {4}- cron: '\d{1,2} \d{1,2} \* \* \*'/m, 'once a day')
  assert.match(WF, /^ {2}TAPEAPI_COMMIT: REPLACE_WITH_A_40_HEX_COMMIT_OF_BRUCELANLAN_TAPEAPI$/m)
  assert.match(WF, /grep -Eq '\^\[0-9a-f\]\{40\}\$'/, 'a placeholder commit stops the run with a sentence')
  assert.match(WF, /repository: BruceLanLan\/tapeapi\n {10}ref: \$\{\{ env\.TAPEAPI_COMMIT \}\}/)
  assert.equal((WF.match(/persist-credentials: false/g) || []).length, 2)
  assert.match(WF, /npm ci --no-audit --no-fund --ignore-scripts/)
  assert.match(WF, /TAPE_NAME: \$\{\{ vars\.TAPE_NAME \}\}/)
  assert.match(WF, /daily-check\.mjs --name "\$TAPE_NAME"/)
  // The alert goes to the operator's own repository only. / 告警只发到运营者自己的仓库。
  for (const m of WF.matchAll(/gh issue \w+[^\n]*/g)) assert.match(m[0], /--repo "\$GITHUB_REPOSITORY"/, m[0])
  assert.doesNotMatch(WF, /curl |wget |webhook|mailto|@tapeapi\.fun|tapeapi\.fun/i, 'no other channel and no TapeAPI host')
})

test('E9-11: no ${{ }} expression inside a run script (values reach scripts through env only)', () => {
  const lines = WF.split('\n')
  let runIndent = -1
  for (const [i, line] of lines.entries()) {
    const indent = line.match(/^ */)[0].length
    if (runIndent >= 0 && line.trim() && indent <= runIndent) runIndent = -1
    if (runIndent >= 0) assert.doesNotMatch(line, /\$\{\{/, `line ${i + 1} is in a run script: ${line.trim()}`)
    const m = /^( *)(?:- )?run: \|\s*$/.exec(line)
    if (m) runIndent = m[1].length + (line.trimStart().startsWith('- ') ? 2 : 0)
    else if (/^\s*(?:- )?run: /.test(line)) assert.doesNotMatch(line, /\$\{\{/, `line ${i + 1}`)
  }
})

test('E9-12: the template is valid YAML with the expected jobs and steps (when python3 has PyYAML)', (t) => {
  const probe = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8', timeout: 300_000, killSignal: 'SIGKILL' })
  if (probe.status !== 0) return t.skip('python3 with PyYAML is not available')
  const r = spawnSync('python3', ['-c', 'import sys, yaml, json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', here('tapeapi-daily-check.yml')], { encoding: 'utf8', timeout: 300_000, killSignal: 'SIGKILL' })
  assert.equal(r.status, 0, r.stderr)
  const wf = JSON.parse(r.stdout)
  // PyYAML reads the bare key `on` as true (YAML 1.1); GitHub reads it as "on". / PyYAML 把 on 读成 true。
  const on = wf.on ?? wf.true
  assert.equal(on.schedule.length, 1)
  assert.ok('workflow_dispatch' in on)
  assert.deepEqual(wf.permissions, { contents: 'read', issues: 'write' })
  const steps = wf.jobs.check.steps
  assert.deepEqual(steps.map((s) => s.name ?? s.uses.split('@')[0]), ['Check the settings', 'actions/checkout', 'actions/checkout', 'actions/setup-node', 'Install (the lockfile of that commit, no install scripts)', 'Daily check', 'Find the open alert issue', 'Alert (open the issue, or comment on it)', 'Resolve (close the issue)', 'Fail when action is needed'])
  assert.equal(steps[2].with.repository, 'BruceLanLan/tapeapi')
  assert.equal(wf.jobs.check['timeout-minutes'], 15)
})
