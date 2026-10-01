#!/usr/bin/env node
// DIAGNOSTIC TOOL, NOT PART OF THE SDK'S PUBLIC INTERFACE. Not published to npm: sdk/package.json "files" is
// ["src", "types", "bin", "README.md", "LICENSE"], and scripts/ is not in it (scripts/packages.test.mjs pins that list).
// It is not on the public whitelist of scripts/stage-public.mjs either; adding it there is a decision for the maintainers.
// 诊断工具，不属于 SDK 的公开接口。不放进 npm 包：sdk/package.json 的 files 只有 src、types、bin、README.md、LICENSE，不含 scripts/
// （scripts/packages.test.mjs 钉住了这份清单）。也不在 scripts/stage-public.mjs 的公开白名单里，是否加入由维护者决定。
//
// "Where are we against TAP-10?": runs the test cases the official TAP-10 v1.1 carries (sdk/test/fixtures/tap10-test-cases.json,
// the 'Test Cases / Access layer' table, nothing added) through this SDK's entry points and prints, per case, the TAP-10
// expectation, what the SDK does, and whether they agree. Fully offline: every RPC goes to the in-process fake chain
// (sdk/test/helpers/fake-chain.mjs) and the global fetch is replaced by a thrower while it runs. It changes no SDK behaviour.
// The logic lives in sdk/test/helpers/tap10-gap.mjs (as scripts/probe-chains.mjs does with chain-facts.mjs), so that
// sdk/test/tap10-gap.test.mjs, which pins today's results, and this table cannot drift apart.
// 把官方 TAP-10 v1.1 自带的测试用例（Test Cases 访问层表，未增一例）跑在我们 SDK 的入口上，逐例给出 TAP-10 期望、SDK 实际所做
// 与是否一致。完全离线：RPC 都走进程内假链，运行期间全局 fetch 被替换为抛错函数。不改变 SDK 的任何行为。逻辑放在
// sdk/test/helpers/tap10-gap.mjs（与 scripts/probe-chains.mjs 和 chain-facts.mjs 同样的做法），使钉住当前结果的测试与这张表不会各走各的。
//
//   node scripts/tap10-gap.mjs           Markdown table + summary on stdout / 在标准输出打印 Markdown 表与小结
//   node scripts/tap10-gap.mjs --json    the raw rows as JSON / 原始结果（JSON）
import { runAll, runAllConform } from '../sdk/test/helpers/tap10-gap.mjs'

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
const { rows, structural, summary, fixture } = await runAll()
// 1.4: the same cases under createTapeAPI({ conform: 'tap10' }) / 同样的用例在一致模式下
const conform = await runAllConform()

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ tap: `${fixture.tap} v${fixture.version}`, summary, structural, rows, conform }, null, 2))
} else {
  console.log(`# Gap against ${fixture.tap} v${fixture.version} (Test Cases, access layer)\n`)
  console.log('| Case | Input | TAP-10 expects | This SDK does | Verdict | Strength | Source |')
  console.log('|---|---|---|---|---|---|---|')
  for (const r of rows) {
    const verdict = r.verdict === 'CONFORMS' ? 'conforms' : r.verdict === 'GAP' ? 'DIFFERS' : 'not judged offline'
    console.log(`| ${r.id} | \`${esc(r.input)}\` | ${esc(r.expected)} | ${esc(r.verdict === 'NOT-JUDGED' ? r.needsChainReason : r.ours)} | ${verdict} | ${esc(r.tag ?? '')} | ${esc(r.source)} |`)
  }
  console.log(`\nCounting basis: ${summary.rows} table rows, expanded to ${summary.cases} cases (one per input).`)
  console.log(`Judged offline: ${summary.judged}; conforms: ${summary.conforms}; differs: ${summary.gaps}; not judged (needs mainnet state): ${summary.notJudged}.`)
  console.log('A "conforms" verdict covers only what is judged offline; the on-chain halves (container, opened, site status, payment) of rows 1, 7, 8 and 9 are not judged.')
  console.log(`\nStructural finding (qualifies those on-chain halves): a full resolution of a valid service issued the reads ${JSON.stringify(structural.calls)}; ` +
    `of the TAP-10 reads cpuCount, isOpened, isLive, isContainerLive it never issued: ${Object.entries(structural.neverIssued).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}.`)
  console.log(`\n## The conformance mode (createTapeAPI({ conform: 'tap10' }), 1.4, @experimental)\n`)
  console.log('| Case | Input | Default mode | conform: \'tap10\' does | Verdict |')
  console.log('|---|---|---|---|---|')
  const byN = new Map(rows.map((r) => [r.n, r]))
  for (const r of conform.rows) {
    if (r.verdict === 'NOT-JUDGED') continue
    const was = byN.get(r.n)?.verdict === 'CONFORMS' ? 'conforms' : 'DIFFERS'
    console.log(`| ${r.id} | \`${esc(r.input)}\` | ${was} | ${esc(r.ours)} | ${r.verdict === 'CONFORMS' ? (was === 'DIFFERS' ? 'conforms (flipped)' : 'conforms') : 'DIFFERS (1.5)'} |`)
  }
  console.log(`\nConformance mode: judged ${conform.summary.judged}; conforms: ${conform.summary.conforms}; differs: ${conform.summary.gaps} (reverse resolution and input without chain information on every chain, planned for 1.5).`)
  console.log(`A full resolution in the conformance mode issues ${Object.entries(conform.structural.neverIssued).filter(([, v]) => !v).map(([k]) => k).join(', ')}.`)
}
