#!/usr/bin/env node
// DIAGNOSTIC TOOL, NOT PART OF THE SDK'S PUBLIC INTERFACE. Not published to npm: sdk/package.json "files" is
// ["src", "types", "bin", "README.md", "LICENSE"], and scripts/ is not in it (scripts/packages.test.mjs pins that list).
// It is published with the repository's other public scripts, not as part of the SDK package.
// 诊断工具，不属于 SDK 的公开接口。不放进 npm 包：sdk/package.json 的 files 只有 src、types、bin、README.md、LICENSE，不含 scripts/
// （scripts/packages.test.mjs 钉住了这份清单）。它随仓库的其它公开脚本一起公开，但不属于 SDK 包。
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
import { runAll, runAllConform, runAllDefault20 } from '../sdk/test/helpers/tap10-gap.mjs'

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
const { rows, structural, summary, fixture } = await runAll()
// 1.4/1.5: the same cases under createTapeAPI({ conform: 'tap10', allChains: true }) / 同样的用例在一致模式下（开 allChains）
const conform = await runAllConform()
// 2.0: the same cases under createTapeAPI() with neither option, the 2.0 default (allChains off) / 2.0 的默认（不开 allChains）
const default20 = await runAllDefault20()

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ tap: `${fixture.tap} v${fixture.version}`, summary, structural, rows, conform, default20 }, null, 2))
} else {
  console.log(`# Gap against ${fixture.tap} v${fixture.version} (Test Cases, access layer)\n`)
  console.log('The first table is the 1.x resolution (createTapeAPI({ conform: false }), the default mode before 2.0, deprecated in 2.0).\n')
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
  console.log(`\n## The conformance mode (createTapeAPI({ conform: 'tap10', allChains: true }), 1.4 and 1.5, @experimental)\n`)
  console.log('| Case | Input | 1.x (conform: false) | conform: \'tap10\' does | Verdict |')
  console.log('|---|---|---|---|---|')
  const byN = new Map(rows.map((r) => [r.n, r]))
  for (const r of conform.rows) {
    if (r.verdict === 'NOT-JUDGED') continue
    const was = byN.get(r.n)?.verdict === 'CONFORMS' ? 'conforms' : 'DIFFERS'
    console.log(`| ${r.id} | \`${esc(r.input)}\` | ${was} | ${esc(r.ours)} | ${r.verdict === 'CONFORMS' ? (was === 'DIFFERS' ? 'conforms (flipped)' : 'conforms') : 'DIFFERS'} |`)
  }
  console.log(`\nConformance mode: judged ${conform.summary.judged}; conforms: ${conform.summary.conforms}; differs: ${conform.summary.gaps}.`)
  console.log(`A full resolution in the conformance mode issues ${Object.entries(conform.structural.neverIssued).filter(([, v]) => !v).map(([k]) => k).join(', ')}.`)
  console.log(`\n## The 2.0 default (createTapeAPI() without conform; allChains off)\n`)
  console.log(`Judged ${default20.summary.judged}; conforms: ${default20.summary.conforms}; differs: ${default20.summary.gaps}` +
    (default20.summary.gaps ? ` (${default20.rows.filter((r) => r.verdict === 'GAP').map((r) => `${r.id}: ${esc(r.ours)}`).join('; ')}; each conforms with allChains: true)` : '') + '.')
}
