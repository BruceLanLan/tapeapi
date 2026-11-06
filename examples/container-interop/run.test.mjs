// The command-line entry (run.mjs) and a scan of this directory's own source and README: what the example promises about
// itself (no key, no network, no transaction, no phase-0 opt-out, no word it should not use) is checked, not only written.
// 命令行入口（run.mjs），以及对本目录源码与 README 的扫描：示例对自己的承诺（没有密钥、没有网络、没有交易、不绕过阶段 0、不用不该用的词）
// 是被检查的，不只是写下来。
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { main } from './run.mjs'
import { restoreTime } from './world.mjs'

afterEach(restoreTime)
const DIR = fileURLToPath(new URL('.', import.meta.url))
const files = readdirSync(DIR)
const sources = files.filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))
const quiet = () => {
  const out = []
  return { out, stdout: (l) => out.push(l) }
}

test('run.mjs: all three scenarios end as designed (exit 0), and say it is the fake chain', async () => {
  const q = quiet()
  assert.equal(await main(['all'], { stdout: q.stdout }), 0)
  const text = q.out.join('\n')
  assert.match(text, /FAKE chain: nothing is on BNB Smart Chain/)
  assert.match(text, /\(a\) .*\n[\s\S]*\(b\) .*\n[\s\S]*\(b\) .*misreports[\s\S]*\(c\) /)
  assert.match(text, /thread state Settled/)
  assert.match(text, /thread state Rejected/)
  assert.match(text, /the request text appears in none: true/)
  assert.match(text, /\nok$/)
})

test('run.mjs: --cap and --calls: more calls than the cap end as designed, with the extra calls refused', async () => {
  const q = quiet()
  assert.equal(await main(['spend', '--cap', '2', '--calls', '4'], { stdout: q.stdout }), 0)
  assert.equal(q.out.filter((l) => /refused before any request \(spend-cap-exceeded\)/.test(l)).length, 2)
})

test('run.mjs: usage mistakes exit 2 and print nothing of the scenarios', async () => {
  const err = console.error
  console.error = () => {}
  try {
    for (const argv of [[], ['nope'], ['spend', '--bogus'], ['spend', '--cap', '0'], ['spend', '--cap', 'x'], ['spend', '--calls', '-1']]) {
      const q = quiet()
      assert.equal(await main(argv, { stdout: q.stdout }), 2, JSON.stringify(argv))
      assert.deepEqual(q.out, [])
    }
  } finally { console.error = err }
})

test('the source: no private key, no transaction, no network, no phase-0 opt-out, no host but .example', () => {
  const forbidden = [
    [/allowFunds/, 'opts out of the SDK\'s phase-0 gate'],
    [/eth_sendTransaction|sendRawTransaction|eth_sign\b|personal_sign|signTypedData_v4\s*\(/, 'sends or asks a wallet to sign'],
    [/sendtx\.mjs|createSender|SETTLER_KEY|SIGNER_KEY|process\.env/, 'reads a key or an environment variable'],
    [/\bfetch\s*\(/, 'calls fetch directly (every request goes through the world\'s in-process fetch)'],
    [/\blisten\s*\(/, 'opens a port'],
  ]
  for (const n of sources) {
    const text = readFileSync(DIR + n, 'utf8')
    for (const [re, why] of forbidden) assert.equal(re.test(text), false, `${n}: ${why}`)
    // a 64-hex literal is a fixture of repeated bytes, never a key of anyone's
    for (const m of text.matchAll(/0x([0-9a-fA-F]{2})\1{31}\b/g)) assert.ok(m[0])
    for (const m of text.matchAll(/\b0x[0-9a-fA-F]{64}\b/g)) assert.match(m[0], /^0x([0-9a-f]{2})\1{31}$/i, `${n}: ${m[0]} is not a repeated-byte fixture`)
    // a URL names a ".example" host; the only other thing here is "https://" inside a comment about the HTTPS endpoint
    for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) assert.match(m[1], /\.example$|^tapeapi\.fun$/, `${n}: ${m[0]}`)
  }
})

test('the README: both languages, the three scenarios, and no wording the project does not use', () => {
  const text = readFileSync(DIR + 'README.md', 'utf8')
  for (const h of ['## 先读这几句 / Read this first', '## (a) ', '## (b) ', '## (c) ', '## 与 TAP-10 来源隔离的关系', '## 缺口']) assert.ok(text.includes(h), h)
  // what each scenario does not show, and the escrow's state, are written in both languages
  assert.match(text, /托管合约没有经过审计，也没有部署，主网不可用/)
  assert.match(text, /unaudited and not deployed: it is not available on mainnet/)
  assert.match(text, /不证明回答是对的/)
  assert.match(text, /not which model or code is behind the container/)
  // wording: no claim of certification, partnership, review passed, adoption, audit or mainnet readiness
  const banned = [/认证/, /合作伙伴/, /通过审核/, /通过采纳/, /成为标准/, /已审计/, /主网可用/, /\bcertified\b/i, /\bpartner(ship)?s?\b/i, /\bapproved\b/i, /\badopted\b/i, /(?<![a-z])audited\b/i, /mainnet[- ]ready/i, /production[- ]ready/i, /\bwill ship\b/i]
  for (const re of banned) assert.equal(re.test(text), false, `README: ${re}`)
  // no internal file named (the staging script's scan keeps other projects' names out of every public file)
  for (const re of [/docs\/(DESIGN|PLAN|research|STRATEGY)/, /interop-plan/, /final-design/, /HANDOFF/]) assert.equal(re.test(text), false, `README: ${re}`)
})

test('the gaps table: thirteen rows, each ending in exactly one of the three verdicts', () => {
  const text = readFileSync(DIR + 'README.md', 'utf8')
  const rows = text.split('\n').filter((l) => /^\| \d+ \|/.test(l))
  assert.equal(rows.length, 13)
  const verdicts = ['需要新规范 / needs a new specification', '只需 SDK / SDK only', '只需示例 / example only']
  for (const r of rows) assert.equal(verdicts.filter((v) => r.trimEnd().endsWith(v + ' |')).length, 1, r.slice(0, 60))
  assert.deepEqual(rows.map((r) => Number(r.match(/^\| (\d+) /)[1])), Array.from({ length: 13 }, (_, i) => i + 1))
})
