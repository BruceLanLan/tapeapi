// The 1.0 release-candidate review, P2 items fixed during the observation period (no interface changes). Each
// `FIXED P2-<source><n>` test failed before its fix. Static scans over the shipped source live here; behavioural
// regressions sit next to the code they cover.
// 1.0 候选版审查的 P2 项（观察期内修复，不改接口）。每个 `FIXED P2-<来源><编号>` 测试在修复之前都失败。对发布源码的静态扫描放在这里；
// 行为回归测试放在所覆盖代码的测试旁边。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const SHIPPED = ['sdk/src', 'sdk/bin', 'server/src']
const sources = (dirs = SHIPPED) => dirs.flatMap((d) => readdirSync(join(ROOT, d)).filter((n) => n.endsWith('.js')).map((n) => `${d}/${n}`))
const read = (f) => readFileSync(join(ROOT, f), 'utf8')

// FIXED P2-O11: an import or a top-level helper that nothing uses (tapeapi-verify's isObj; mcp-proxy's abi and
// safeParseJSON imports). Counted on the raw text, so a name only mentioned in a comment passes: no false alarms.
// 没有人使用的导入或顶层辅助函数。按原文计数，只在注释里出现的名字也算用到：不会误报。
test('FIXED P2-O11: every import and top-level declaration in the shipped source is used', () => {
  const unused = []
  for (const f of sources()) {
    const src = read(f), names = []
    for (const m of src.matchAll(/^import\s+\{([^}]*)\}\s+from/gm)) for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop().trim(); if (n) names.push(n) }
    for (const m of src.matchAll(/^import\s+\*\s+as\s+([\w$]+)/gm)) names.push(m[1])
    for (const m of src.matchAll(/^import\s+([\w$]+)\s*(?:,|from)/gm)) names.push(m[1])
    for (const m of src.matchAll(/^(?:const|let|function|async function|class)\s+([\w$]+)/gm)) names.push(m[1])
    for (const n of names) {
      const uses = src.match(new RegExp(`(?<![\\w$])${n.replace(/\$/g, '\\$')}(?![\\w$])`, 'g')) || []
      if (uses.length < 2) unused.push(`${f}: ${n}`)
    }
  }
  assert.deepEqual(unused, [])
})

// FIXED P2-O8: the refusals of a 0.x option name pointed at docs/guides/upgrade-1.0.md, a path the npm package does not
// contain; two (`identity`, a relay client's `svc`) pointed nowhere. Every one now names the page on the website.
// 0.x 旧选项名的拒绝消息曾指向 npm 包里没有的 docs/guides/upgrade-1.0.md，有两处没给链接；现在都给网站上的页面。
const UPGRADE_URL = 'https://tapeapi.fun/docs/en/upgrade-1.0'
test('FIXED P2-O8: every "renamed in 1.0" refusal links the upgrade guide on the website, not a path outside the package', async () => {
  const bad = []
  for (const f of sources()) {
    read(f).split('\n').forEach((line, i) => {
      if (/renamed in 1\.0|renamed `\w+` in 1\.0/.test(line) && /TapeAPIError\(|invalid\(|const renamed/.test(line) && !line.includes(UPGRADE_URL)) bad.push(`${f}:${i + 1}`)
      if (/['"`][^'"`]*docs\/guides\/[^'"`]*['"`]/.test(line) && !/^\s*(\/\/|\*)/.test(line)) bad.push(`${f}:${i + 1} docs/guides path in a string`)
    })
  }
  assert.deepEqual(bad, [])
  const { createTapeAPI } = await import('../src/index.js')
  assert.throws(() => createTapeAPI({ timeoutMs: 1 }), (e) => e.code === 'INVALID_ARGUMENT' && e.message.includes(UPGRADE_URL))
})

// FIXED P2-O9: "rpcUrls not configured" did not say how to configure them. / 没说怎么配置。
test('FIXED P2-O9: a client with no nodes says how to give it some', async () => {
  const { createTapeAPI } = await import('../src/index.js')
  await assert.rejects(createTapeAPI({}).chain.ownerOf('0x' + '33'.repeat(20), 1), (e) => e.code === 'INVALID_ARGUMENT' && /^rpcUrls not configured/.test(e.message) && /rpcUrls: rpcUrlsFor\(56\)/.test(e.message))
})

// FIXED P2-O18: the SDK's own code still read deprecated top-level aliases of TapeAPIError (rpc.js `e?.tooLarge`,
// `reason?.tooLarge`; bus-privacy.js `e?.refusals`), which 2.0 removes; the existing scan missed the `?.` spelling.
// channel.js is frozen for 1.x and keeps its reads (listed for 2.0). / SDK 自己的代码仍读已弃用的顶层别名（2.0 会删）；
// 原有扫描漏了 ?. 写法。channel.js 在 1.x 冻结，保留其读取（列入 2.0 待办）。
test('FIXED P2-O18: the shipped source reads e.data.*, never a deprecated top-level alias of TapeAPIError (channel.js aside)', () => {
  const ALIAS = /\b(e|err|error|reason|cause)\??\.(tooLarge|rpcCode|rpcRevert|rpcData|agreed|disagreed|quorum|refusals)\b/g
  const hits = []
  for (const f of sources(['sdk/src', 'server/src']).filter((f) => !/\/(channel|errors)\.js$/.test(f))) {
    const t = read(f)
    for (const m of t.matchAll(ALIAS)) hits.push(`${f}:${t.slice(0, m.index).split('\n').length} ${m[0]}`)
  }
  assert.deepEqual(hits, [])
})
