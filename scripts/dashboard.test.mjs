// The "My services" dashboard (site/dashboard/) runs the playground's vendored SDK by relative path. Offline checks:
// it loads nothing from another origin, its import map is the playground's (so a rebuild of vendor/ cannot leave it
// behind), every import resolves, it never asks a wallet for more than an address, and the pure helpers in lib.js
// behave. / “我的服务”面板用相对路径加载调试台 vendor/ 里的 SDK。离线检查：不从其他来源加载、import map 与调试台一致、
// 每个导入都能解析、只向钱包要地址、lib.js 的纯函数行为正确。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importsOf } from './build-playground.mjs'
import {
  parseInput, classifyExpiry, healthUrl, sameAddress, cleanList, loadList, saveList, addTo, removeFrom,
  STORAGE_KEY, PUBLIC_EXAMPLES, MAX_SERVICES, WARN_DAYS,
} from '../site/dashboard/lib.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SITE = join(ROOT, 'site')
const DIR = join(SITE, 'dashboard')
const read = (p) => readFileSync(join(SITE, p), 'utf8')
const html = read('dashboard/index.html')
const js = read('dashboard/dashboard.js')
const css = read('dashboard/dashboard.css')
const mapOf = (page) => {
  const m = /<script type="importmap">([^]*?)<\/script>/.exec(page)
  assert.ok(m, 'the page has an import map')
  return JSON.parse(m[1]).imports
}

test('dashboard: the page references only local files', () => {
  const refs = [...html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/g)].map((m) => m[1])
  assert.ok(refs.length >= 5)
  for (const r of refs) {
    assert.doesNotMatch(r, /^(?:[a-z][a-z0-9+.-]*:)?\/\//i, `${r}: another origin`)
    if (r.startsWith('data:')) continue
    const path = r.split(/[?#]/)[0]
    if (path.startsWith('/')) { assert.equal(path, '/', r); continue }   // only the homepage link may be absolute / 只有首页链接
    const target = posix.normalize(posix.join('dashboard/', path))
    const file = target.endsWith('/') ? `${target}index.html` : target
    assert.ok(existsSync(join(SITE, file)), `${r} -> site/${file} does not exist`)
  }
  for (const [name, text] of [['index.html', html], ['dashboard.js', js], ['dashboard.css', css], ['lib.js', read('dashboard/lib.js')]]) {
    assert.doesNotMatch(text, /@import|url\(\s*['"]?(?:https?:)?\/\//i, `${name}: remote stylesheet or asset`)
    assert.doesNotMatch(text, /claude/i, `${name}: the page is for outside developers`)
  }
  // No absolute URL in the script: its nodes are the SDK's rpcUrlsFor(56) (three operators), from the vendored SDK.
  // 脚本里没有绝对 URL：节点取自 vendor 的 SDK 的 rpcUrlsFor(56)（三家运营方）。
  const urls = [...js.matchAll(/https?:\/\/[^\s'"`)]+/g)].map((m) => m[0])
  assert.deepEqual(urls, [])
  assert.match(js, /const RPC_URLS = rpcUrlsFor\(56\)/)
})

test('dashboard: the import map is the playground\'s, read from ../playground/vendor/, and every entry exists', () => {
  const mine = mapOf(html)
  const theirs = mapOf(read('playground/index.html'))
  const expected = Object.fromEntries(Object.entries(theirs).map(([k, v]) => [k, v.replace(/^\.\/vendor\//, '../playground/vendor/')]))
  assert.deepEqual(mine, expected, 'copy the import map from site/playground/index.html, with ./vendor/ -> ../playground/vendor/')
  for (const [spec, to] of Object.entries(mine)) {
    assert.match(to, /^\.\.\/playground\/vendor\//, spec)
    assert.ok(existsSync(join(DIR, to)), `${spec} -> ${to} does not exist`)
  }
})

test('dashboard: every import of the page scripts and the vendored SDK they load resolves', () => {
  const map = mapOf(html)
  const seen = new Set()
  const walk = (file) => {   // file: path relative to site/ / 相对 site/ 的路径
    if (seen.has(file)) return
    seen.add(file)
    for (const spec of importsOf(read(file))) {
      let target
      // a relative import carries a content stamp (scripts/version-assets.mjs) / 相对导入带内容戳
      if (spec.startsWith('./') || spec.startsWith('../')) target = posix.normalize(posix.join(posix.dirname(file), spec.replace(/\?v=[0-9a-f]{10}$/, '')))
      else {
        assert.ok(Object.hasOwn(map, spec), `${file}: bare import ${spec} is not in the dashboard's import map`)
        target = posix.normalize(posix.join('dashboard/', map[spec]))
      }
      assert.ok(existsSync(join(SITE, target)), `${file}: ${spec} -> site/${target} does not exist`)
      walk(target)
    }
  }
  assert.match(html, /<script type="module" src="dashboard\.js\?v=[0-9a-f]{10}"><\/script>/)
  walk('dashboard/dashboard.js')
  assert.ok(seen.has('dashboard/lib.js') && seen.has('playground/vendor/tapeapi-sdk/index.js'))
  assert.ok(seen.size > 20, `only ${seen.size} modules reached`)
})

test('dashboard: read-only: the wallet is asked for its address and nothing else', () => {
  const methods = [...js.matchAll(/method:\s*'([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(methods, ['eth_requestAccounts'])
  const codeOnly = js.replace(/(^|\s)\/\/[^\n]*/g, '$1')   // comments may name what the page does NOT do / 注释里可以写本页不做的事
  assert.doesNotMatch(codeOnly, /eth_sign|personal_sign|eth_sendTransaction|eth_signTypedData|wallet_switchEthereumChain|wallet_addEthereumChain|\.payer\(|\.tx\./)
  assert.doesNotMatch(codeOnly, /privateKey|randomPrivateKey/)
  // Network text reaches the page as text: innerHTML only for this file's own strings. / 网络内容只作文本。
  const inner = [...js.matchAll(/innerHTML\s*=/g)]
  assert.equal(inner.length, 1)
  assert.match(js, /n\.innerHTML = t\(n\.getAttribute\('data-i18n'\)\)/)
  assert.match(js, /createTapeAPI\(\{ rpcUrls: RPC_URLS, quorum: QUORUM, rpcTimeoutMs: 4000 \}\)/)
  assert.match(js, /const QUORUM = 2\b/)
})

test('dashboard: every data-i18n key has both languages, and theme/language use the shared storage keys', () => {
  const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1])
  assert.ok(keys.length >= 15)
  const zh = js.slice(js.indexOf('  zh: {'), js.indexOf('  en: {'))
  const en = js.slice(js.indexOf('  en: {'), js.indexOf('\nconst root'))
  for (const k of new Set([...keys, 'reconnect'])) {
    const re = new RegExp(`(?:^|[\\s{,])(?:'${k.replace('.', '\\.')}'|${/^[a-z]+$/i.test(k) ? k : '\\0'}):`)
    assert.match(zh, re, `zh: ${k}`)
    assert.match(en, re, `en: ${k}`)
  }
  assert.match(html, /get\('tapeapi\.theme'\)/)
  assert.match(html, /get\('tapeapi\.lang'\)/)
  assert.match(js, /put\('tapeapi\.lang', lang\)/)
  assert.match(js, /put\('tapeapi\.theme', next\)/)
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1/)
})

test('lib: parseInput reads names and container addresses, and nothing else', () => {
  assert.deepEqual(parseInput('11.1013.tape'), { kind: 'name', key: '11.1013.tape', id: '11', processor: '1013' })
  assert.deepEqual(parseInput('  012.01013.TAPE '), { kind: 'name', key: '12.1013.tape', id: '12', processor: '1013' })
  assert.equal(parseInput('0.1013.tape'), null, '#ID starts at 1')
  const a = '0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE'
  assert.deepEqual(parseInput(a), { kind: 'container', key: a.toLowerCase() })
  for (const bad of ['', '   ', '11.1013', 'x.1013.tape', '11.1013.tape.evil', '0x1234', `${a}00`, 'api.tapeapi.fun', '1'.repeat(16) + '.1.tape', null, undefined, 11, {}, 'a'.repeat(200)]) {
    assert.equal(parseInput(bad), null, String(bad))
  }
})

test('lib: classifyExpiry: amber under 14 days, red once expired', () => {
  const now = 1_800_000_000
  const day = 86400
  assert.equal(WARN_DAYS, 14)
  assert.deepEqual(classifyExpiry(now + 30 * day, now), { days: 30, state: 'ok' })
  assert.deepEqual(classifyExpiry(now + 14 * day, now), { days: 14, state: 'ok' })
  assert.deepEqual(classifyExpiry(now + 14 * day - 1, now), { days: 13, state: 'warn' })
  assert.deepEqual(classifyExpiry(now + 60, now), { days: 0, state: 'warn' })
  assert.deepEqual(classifyExpiry(now, now), { days: 0, state: 'expired' })
  assert.deepEqual(classifyExpiry(now - 1, now), { days: -1, state: 'expired' })
  assert.deepEqual(classifyExpiry(now - 3 * day, now), { days: -3, state: 'expired' })
  for (const x of [null, undefined, NaN, Infinity, '1800000000']) assert.deepEqual(classifyExpiry(x, now), { days: null, state: 'unknown' })
  assert.equal(classifyExpiry(Math.floor(Date.now() / 1000) + 20 * day).state, 'ok', 'defaults to now')
})

test('lib: healthUrl maps a live endpoint to /tapeapi/v1/health, https only', () => {
  assert.equal(healthUrl('https://api.tapeapi.fun/tapeapi/v1'), 'https://api.tapeapi.fun/tapeapi/v1/health')
  assert.equal(healthUrl('https://api.tapeapi.fun/tapeapi/v1/'), 'https://api.tapeapi.fun/tapeapi/v1/health')
  assert.equal(healthUrl('https://relay.tapeapi.fun'), 'https://relay.tapeapi.fun/tapeapi/v1/health')
  assert.equal(healthUrl('https://example.com/svc/tapeapi/v1'), 'https://example.com/svc/tapeapi/v1/health')
  assert.equal(healthUrl('http://127.0.0.1:8787/tapeapi/v1'), 'http://127.0.0.1:8787/tapeapi/v1/health')
  for (const bad of ['http://api.example.com/tapeapi/v1', 'javascript:alert(1)', 'ftp://x/tapeapi/v1', 'https://u:p@x.com/tapeapi/v1', 'not a url', '', null, 42]) {
    assert.equal(healthUrl(bad), null, String(bad))
  }
})

test('lib: storage load and save survive bad data and never throw', () => {
  const mem = (v) => { const m = new Map(v === undefined ? [] : [[STORAGE_KEY, v]]); return { getItem: (k) => m.get(k) ?? null, setItem: (k, x) => m.set(k, String(x)), m } }
  assert.deepEqual(loadList(mem()), [])
  assert.deepEqual(loadList(null), [])
  assert.deepEqual(loadList({ getItem: () => { throw new Error('SecurityError') } }), [])
  for (const bad of ['', '{', 'null', '"11.1013.tape"', '42', '{"services":"11.1013.tape"}', '{"v":1}', 'true']) assert.deepEqual(loadList(mem(bad)), [], bad)
  assert.deepEqual(loadList(mem('[1,null,"11.1013.tape","11.1013.tape","junk",{"x":1},"012.1013.tape"]')), ['11.1013.tape', '12.1013.tape'])
  assert.deepEqual(loadList(mem(JSON.stringify({ v: 1, services: ['12.1013.tape', '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'] }))), ['12.1013.tape', '0x' + 'a'.repeat(40)])
  const many = Array.from({ length: 80 }, (_, i) => `${i + 1}.1013.tape`)
  assert.equal(loadList(mem(JSON.stringify(many))).length, MAX_SERVICES)

  const s = mem()
  assert.deepEqual(saveList(s, ['11.1013.tape', 'bad', '11.1013.tape', ...PUBLIC_EXAMPLES]), ['11.1013.tape', '12.1013.tape'])
  assert.deepEqual(JSON.parse(s.m.get(STORAGE_KEY)), { v: 1, services: ['11.1013.tape', '12.1013.tape'] })
  assert.deepEqual(loadList(s), ['11.1013.tape', '12.1013.tape'], 'round trip')
  assert.equal(saveList({ setItem: () => { throw new Error('QuotaExceededError') } }, ['11.1013.tape']), null)
  assert.equal(STORAGE_KEY, 'tapeapi.dashboard')
  assert.deepEqual([...PUBLIC_EXAMPLES], ['11.1013.tape', '12.1013.tape'])
})

test('lib: add, remove, dedupe, and same-address checks', () => {
  let r = addTo([], '11.1013.tape')
  assert.deepEqual(r, { list: ['11.1013.tape'], added: true, reason: null })
  r = addTo(r.list, ' 011.1013.tape ')
  assert.deepEqual(r, { list: ['11.1013.tape'], added: false, reason: 'dup' })
  assert.equal(addTo(r.list, 'nope').reason, 'bad')
  assert.equal(addTo(Array.from({ length: MAX_SERVICES }, (_, i) => `${i + 1}.1.tape`), '999.1.tape').reason, 'full')
  assert.deepEqual(removeFrom(['11.1013.tape', '12.1013.tape'], '11.1013.tape'), ['12.1013.tape'])
  assert.deepEqual(removeFrom('garbage', '11.1013.tape'), [])
  assert.deepEqual(cleanList(['12.1013.tape', 'x', '12.1013.tape']), ['12.1013.tape'])
  const a = '0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE'
  assert.equal(sameAddress(a, a.toLowerCase()), true)
  assert.equal(sameAddress(a, '0x' + '0'.repeat(40)), false)
  assert.equal(sameAddress(a, null), false)
  assert.equal(sameAddress('0x12', '0x12'), false)
})

// FIXED RC-1 (review 2026-09-29): S4 renamed createTapeAPI's per-node timeout to rpcTimeoutMs and refuses the old name,
// but the dashboard still passed timeoutMs, so the page failed on load. Every page script is checked, not just this one.
// FIXED RC-1：S4 把 createTapeAPI 的单节点超时改名为 rpcTimeoutMs 并拒绝旧名字，面板仍传 timeoutMs，页面一加载就失败。
test('FIXED RC-1: no page script passes the removed createTapeAPI option timeoutMs', async () => {
  const { readdirSync, statSync, readFileSync: rd } = await import('node:fs')
  const { join: j } = await import('node:path')
  const site = SITE
  const bad = []
  const walk = (d) => { for (const n of readdirSync(d)) { const p = j(d, n); if (statSync(p).isDirectory()) { if (n !== 'vendor') walk(p) } else if (n.endsWith('.js')) { const t = rd(p, 'utf8'); for (const m of t.matchAll(/createTapeAPI\(\s*\{[^}]*\btimeoutMs\s*:/g)) bad.push(`${p}: ${m[0].slice(0, 80)}`) } } }
  walk(site)
  assert.deepEqual(bad, [])
})
