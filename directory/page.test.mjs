// The provider directory's page (site/directory/), its links from the rest of the site, and the two workflows that keep
// it: the page script runs here against a small stand-in DOM, the workflows are read as text (and parsed when PyYAML is
// available). No network, no browser.
// 服务方目录页面、站内入口与维护它的两个工作流：页面脚本在一个小型替身 DOM 上运行；工作流按文本检查（有 PyYAML 时再解析）。不联网、不用浏览器。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import vm from 'node:vm'
import { parseTapeName, CHAINS } from '../sdk/src/index.js'
import { versionRefs } from '../scripts/version-assets.mjs'
import { RPC_BUDGET_PER_NAME, STALE_AFTER } from './recheck.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const html = read('site/directory/index.html')
const js = read('site/directory/directory.js')
const css = read('site/directory/directory.css')

const NOTICE_ZH = '只代表通过了 TapeAPI 的自动检查（tapeapi-doctor），不代表推荐、担保或审计；服务质量、价格与合规由服务方自己负责。'
const NOTICE_EN = "A listing only means the service passed TapeAPI's automated checks (tapeapi-doctor), not a recommendation, a guarantee or an audit; each provider answers for its own service quality, prices and compliance."

// ---- a stand-in DOM: just what directory.js uses / 替身 DOM：只实现 directory.js 用到的部分 ----
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.own = ''; this.on = {} }
  appendChild(c) { if (c.tag === '#fragment') { for (const k of c.children) this.appendChild(k) } else { this.children.push(c); c.parent = this } return c }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null }
  set textContent(v) { this.children = []; this.own = String(v) }
  get textContent() { return this.own + this.children.map((c) => c.textContent).join('') }
  addEventListener(t, f) { (this.on[t] ||= []).push(f) }
  fire(t) { for (const f of this.on[t] || []) f({}) }
  all(pred, out = []) { for (const c of this.children) { if (c instanceof El) { if (pred(c)) out.push(c); c.all(pred, out) } } return out }
  // The text of one language, as the page shows it: the other language's spans left out. / 某种语言下显示的文字。
  shown(lang) { return this.own + this.children.map((c) => (c instanceof El ? (c.attrs.lang && c.attrs.lang !== lang ? '' : c.shown(lang)) : c.textContent)).join('') }
}
const text = (s) => ({ tag: '#text', textContent: String(s) })
function makeDocument() {
  const doc = new El('#document')
  const byId = {}
  for (const id of ['lang-btn', 'theme-btn', 'list', 'checked']) byId[id] = new El(id === 'list' ? 'section' : id === 'checked' ? 'time' : 'button')
  Object.assign(doc, {
    documentElement: new El('html'), title: 'TapeAPI Provider Directory',
    createElement: (t) => new El(t), createTextNode: text, createDocumentFragment: () => new El('#fragment'),
    getElementById: (id) => byId[id] ?? null,
  })
  return { doc, byId }
}
/** Run the page script: without a document (the pure part only), or booted in a stand-in page. / 运行页面脚本。 */
async function runScript({ boot = false, files = {}, language = 'en-US', stored = null } = {}) {
  const ctx = { Promise, Object, Array, String, Number, Date, isNaN, JSON, RegExp, Error }
  let page = null
  if (boot) {
    page = makeDocument()
    Object.assign(ctx, {
      document: page.doc, addEventListener() {}, navigator: { language, languages: [language] },
      localStorage: { getItem: () => stored, setItem() { throw new Error('private window') } },
      matchMedia: () => ({ matches: false }),
      fetch: async (url) => (url in files
        ? { ok: files[url] !== 404, status: files[url] === 404 ? 404 : 200, json: async () => files[url] }
        : { ok: false, status: 404, json: async () => ({}) }),
    })
  }
  vm.createContext(ctx)
  vm.runInContext(js, ctx, { filename: 'directory.js' })
  if (boot) {
    page.doc.fire('DOMContentLoaded')
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
  }
  return { D: ctx.TapeDirectory, page }
}

const status = (providers, checkedAt = '2026-10-02T03:20:11.000Z') => ({ version: 1, doctor: '1.2.0', checkedAt, providers })
// Objects made inside the script's context have its own Array prototype: compare them as plain data.
// 脚本上下文里创建的对象有自己的 Array 原型：按纯数据比较。
const clone = (x) => JSON.parse(JSON.stringify(x))
const listed = (...names) => ({ version: 1, providers: names.map((n) => ({ name: n, added: '2026-10-01' })) })

test('page: head, title, stamped assets, the shared header and a footer, like the status page', () => {
  assert.match(html, /^<!doctype html>\n<html lang="en">/)
  assert.match(html, /<title>TapeAPI Provider Directory<\/title>/)
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/)
  assert.equal(versionRefs(html, join(ROOT, 'site/directory')), html, 'stamped with current hashes (?v=)')
  for (const f of ['../status/status.css', 'directory.css', 'directory.js']) assert.match(html, new RegExp(`"${f.replace(/[.]/g, '\\.')}\\?v=[0-9a-f]{10}"`), f)
  assert.doesNotMatch(html, /type="module"/, 'a classic script, like the status page')
  const nav = (page) => /<nav class="hd-nav"[^]*?<\/nav>/.exec(page)[0].replace(/ aria-current="page"/g, '').replace(/href="\.\/"/g, 'href="../status/"')
  assert.equal(nav(html), nav(read('site/status/index.html')), 'the same header navigation as the other pages')
  assert.match(html, /id="lang-btn"[^]*id="theme-btn"/)
  assert.match(html, /<footer class="foot">[^]*href="\.\.\/"[^]*<\/footer>/)
  // Every local link resolves; the only other origins are the repository and tapeapi.fun metadata. / 本地链接都存在。
  for (const [, r] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (/^https:\/\/(github\.com\/BruceLanLan\/tapeapi(\/|$)|tapeapi\.fun\/)/.test(r) || r.startsWith('#') || r === '/favicon.svg') continue
    assert.doesNotMatch(r, /^(?:[a-z]+:)?\/\//i, `${r}: another origin`)
    const p = join(ROOT, 'site/directory', r.split(/[?#]/)[0])
    assert.ok(existsSync(p.endsWith('/') ? join(p, 'index.html') : p) || existsSync(p + '.html'), `${r} does not exist`)
  }
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|document\.write/, 'text only, never HTML')
})

test('page: the notice sits above the list, in both languages, word for word', () => {
  const at = html.indexOf('id="list"')
  for (const s of [NOTICE_ZH, NOTICE_EN.replace(/'/g, "'")]) {
    const i = html.indexOf(s)
    assert.ok(i > 0, `missing: ${s}`)
    assert.ok(i < at, 'above the list')
  }
  assert.match(html, /<p lang="zh">只代表通过了/)
  assert.match(html, /<p lang="en">A listing only means/)
})

test('page: no promotional wording anywhere in the directory (only the negations Bruce wrote)', () => {
  const ALLOWED = [/不代表推荐/g, /不设推荐位/g, /not a recommendation/gi, /no featured places/gi]
  const BANNED = /推荐|认证|官方合作|合作伙伴|精选|最佳|排行|recommend|certif|official partner|partner|endors|featured|sponsor|best|top-rated|trusted|verified provider/i
  const files = ['site/directory/index.html', 'site/directory/directory.js', 'site/directory/directory.css', 'directory/README.md', 'directory/recheck.mjs', '.github/ISSUE_TEMPLATE/service_listing.yml']
  for (const f of files) {
    let t = read(f)
    for (const re of ALLOWED) t = t.replace(re, '')
    const m = BANNED.exec(t)
    assert.equal(m, null, `${f}: "${m?.[0]}" near: ${m ? t.slice(Math.max(0, m.index - 40), m.index + 40) : ''}`)
  }
})

test('page: the recheck command is the guide\'s doctor, with the entry\'s name', async () => {
  const { D } = await runScript()
  const guide = read('docs/guides/ai-providers.md')
  assert.ok(guide.includes(`${D.DOCTOR} <your name>`), 'the same package URL and command as the guide')
  assert.ok(read('docs/guides/zh-CN/ai-providers.md').includes(`${D.DOCTOR} <你的名字>`))
  assert.ok(html.includes(`${D.DOCTOR} &lt;name&gt;`), 'the page\'s steps name the same command')
  assert.ok(read('directory/README.md').includes(`${D.DOCTOR} <your name>`))
})

test('model: the chain comes from the name, as the SDK reads it', async () => {
  const { D } = await runScript()
  for (const n of ['42.1013.tape', '1.2.344.tape', '5.3.7.tape', '11.1013.tape']) {
    const p = parseTapeName(n)
    assert.equal(D.chainOf(n)[1], CHAINS[p.chainId].name, n)
  }
})

test('model: providers.json\'s order is kept (no sorting here), flags map to states, nothing unsafe is shown', async () => {
  const { D } = await runScript()
  const m = clone(D.model(
    { version: 1, providers: [
      { name: '9.1013.tape', added: '2026-10-01', contact: 'javascript:alert(1)' },
      { name: '42.1013.tape', added: '2026-10-01', contact: 'https://github.com/example' },
      { name: '3.2.1.tape', added: '2026-10-02' },
      { name: '7.1013.tape', added: '2026-10-03' },
      { name: '8.1013.tape', added: '2026-10-03' },
    ] },
    status({
      '9.1013.tape': { flag: 'ok', checkedAt: '2026-10-02T03:20:00Z', since: '2026-10-01T03:20:00Z', failed: [], undecided: [] },
      '42.1013.tape': { flag: 'failing', checkedAt: '2026-10-02T03:21:00Z', since: '2026-10-02T03:21:00Z', failed: ['cors', 'receipt'], consecutiveFailures: 2 },
      '3.2.1.tape': { flag: 'undecided', checkedAt: '2026-10-02T03:22:00Z', verdict: 'ok', verdictAt: '2026-10-01T03:22:00Z', undecided: ['circuit'] },
      '7.1013.tape': { flag: 'stale', checkedAt: '2026-10-02T03:23:00Z', failed: ['delegation'], consecutiveFailures: 7 },
      'gone.tape': { flag: 'ok' },
    })))
  assert.equal(m.empty, false)
  assert.equal(m.checkedAt, '2026-10-02 03:20 UTC')
  assert.deepEqual(m.entries.map((e) => e.name), ['9.1013.tape', '42.1013.tape', '3.2.1.tape', '7.1013.tape', '8.1013.tape'])
  assert.deepEqual(m.entries.map((e) => [e.flag, e.state]), [['ok', 'up'], ['failing', 'down'], ['undecided', 'warn'], ['stale', 'down'], ['none', 'checking']])
  assert.equal(m.entries[0].contact, null, 'only an https contact is linked')
  assert.equal(m.entries[1].contact, 'https://github.com/example')
  assert.deepEqual(m.entries[1].failed, ['cors', 'receipt'])
  assert.equal(m.entries[1].checkedAt, '2026-10-02 03:21 UTC')
  assert.deepEqual(m.entries[2].verdict, ['通过', 'Passing'], 'undecided shows yesterday\'s verdict')
  assert.equal(m.entries[2].verdictAt, '2026-10-01 03:22 UTC')
  assert.equal(m.entries[4].checkedAt, null, 'listed but not rechecked yet')
  assert.ok(m.entries.every((e) => e.command === `${D.DOCTOR} ${e.name}`))
  assert.equal(D.model(listed('1.1013.tape'), null).entries[0].flag, 'none', 'no status.json yet')
  assert.equal(D.model({ version: 1, providers: [] }, null).empty, true)
})

test('render: the empty directory says so and gives the two steps; entries show name, chain, state, time and command', async () => {
  const { D } = await runScript()
  const { doc } = makeDocument()
  const box = new El('section')
  D.render(doc, box, D.model({ version: 1, providers: [] }, status({}, null)), false)
  assert.match(box.shown('zh'), /还没有服务方上架[^]*tapeapi-doctor[^]*退出码 0[^]*服务登记表[^]*拉取请求[^]*providers\.json/)
  assert.match(box.shown('en'), /No provider is listed yet[^]*tapeapi-doctor[^]*exit status 0[^]*pull request[^]*service listing form/)
  assert.ok(box.all((e) => e.tag === 'a' && e.attrs.href === '#how').length === 1, 'links to the full steps')
  assert.ok(html.includes('id="how"'))

  D.render(doc, box, D.model(listed('11.1013.tape', '1.2.344.tape'), status({ '11.1013.tape': { flag: 'ok', checkedAt: '2026-10-02T03:20:00Z', since: '2026-10-02T03:20:00Z', failed: [] } })), false)
  const cards = box.all((e) => e.tag === 'article')
  assert.deepEqual(cards.map((c) => c.attrs['data-name']), ['11.1013.tape', '1.2.344.tape'])
  const en = cards[0].shown('en'), zh = cards[0].shown('zh')
  for (const s of ['11.1013.tape', 'BNB Smart Chain', 'Passing', 'Last recheck', '2026-10-02 03:20 UTC', `${D.DOCTOR} 11.1013.tape`, 'Recheck it yourself with tapeapi-doctor']) assert.ok(en.includes(s), s)
  for (const s of ['通过', '最后复核', '用 tapeapi-doctor 自己复核']) assert.ok(zh.includes(s), s)
  assert.ok(!en.includes('通过') && !zh.includes('Passing'), 'one language at a time')
  assert.match(cards[1].shown('en'), /X Layer[^]*Not yet rechecked/)

  D.render(doc, box, null, true)
  assert.match(box.shown('en'), /Could not read providers\.json/)
})

test('boot: language from the browser, <html lang> and <title> follow the switch; the list is drawn from the two files', async () => {
  const { page } = await runScript({ boot: true, language: 'zh-CN', files: { 'providers.json': { version: 1, providers: [] }, 'status.json': 404 } })
  const root = page.doc.documentElement
  assert.equal(root.getAttribute('data-lang'), 'zh')
  assert.equal(root.lang, 'zh-CN'); assert.equal(page.doc.title, 'TapeAPI 服务方目录')
  assert.match(page.byId.list.shown('zh'), /还没有服务方上架/)
  page.byId['lang-btn'].fire('click')
  assert.equal(root.getAttribute('data-lang'), 'en')
  assert.equal(root.lang, 'en'); assert.equal(page.doc.title, 'TapeAPI Provider Directory')
  assert.equal(page.byId['lang-btn'].textContent, '中文')

  const two = await runScript({ boot: true, files: { 'providers.json': listed('11.1013.tape'), 'status.json': status({ '11.1013.tape': { flag: 'failing', checkedAt: '2026-10-02T03:20:00Z', failed: ['cors'], consecutiveFailures: 1 } }) } })
  assert.equal(two.page.doc.documentElement.lang, 'en')
  assert.match(two.page.byId.list.shown('en'), /11\.1013\.tape[^]*Failing[^]*cors/)
  assert.equal(two.page.byId.checked.textContent, '2026-10-02 03:20 UTC')
})

test('page: nothing is wider than a 375 px phone: long names and commands wrap or scroll inside their box', () => {
  assert.match(css, /pre\.cmd, \.notes pre \{[^}]*max-width: 100%[^}]*overflow-x: auto[^}]*white-space: pre-wrap[^}]*overflow-wrap: anywhere/)
  assert.match(css, /\.card \.name \{[^}]*overflow-wrap: anywhere/)
  assert.match(css, /\.notice p \{[^}]*overflow-wrap: anywhere/)
  const status = read('site/status/status.css')
  assert.match(status, /\.cards \{[^}]*minmax\(min\(100%, 380px\), 1fr\)/, 'the card grid never asks for more than the screen')
  assert.match(status, /\.card \{[^}]*min-width: 0/)
  assert.match(css, /@media \(max-width: 380px\)/)
})

test('page, README and workflow state the same RPC cap and stale threshold as recheck.mjs', () => {
  for (const [f, re] of [['site/directory/index.html', /at most (\d+) JSON-RPC requests per name/], ['site/directory/index.html', /每个名字最多 (\d+) 次 JSON-RPC 请求/],
    ['directory/README.md', /At most \*\*(\d+) JSON-RPC requests per name\*\*/], ['directory/README.md', /每个名字最多 (\d+) 次 JSON-RPC 请求/],
    ['.github/workflows/directory-recheck.yml', /At most (\d+) JSON-RPC requests per name/]]) {
    assert.equal(Number(re.exec(read(f))?.[1]), RPC_BUDGET_PER_NAME, `${f}: ${re}`)
  }
  assert.match(html, new RegExp(`Failing ${STALE_AFTER} daily rechecks in a row`))
  assert.match(html, new RegExp(`连续 ${STALE_AFTER} 次每日复核未通过`))
  assert.match(read('directory/README.md'), new RegExp(`failing ${STALE_AFTER} daily rechecks in a row`))
})

test('site: served with one frame-forbidding policy, in the sitemap, linked from the homepage and both guides', () => {
  const rule = /^\/directory\/\*\n((?:[ \t]+.+\n?)+)/m.exec(read('site/_headers'))
  assert.ok(rule, '_headers has a /directory/* rule')
  assert.deepEqual(rule[1].trim().split('\n').map((l) => l.trim()), ["Content-Security-Policy: frame-ancestors 'none'"])
  assert.match(read('site/sitemap.xml'), /<loc>https:\/\/tapeapi\.fun\/directory\/<\/loc>/)
  const home = read('site/index.html')
  assert.match(home, /<a href="directory\/"><span lang="zh">服务方目录<\/span><span lang="en">Provider directory<\/span><\/a>/)
  assert.match(home, /<p lang="zh">(?:(?!<\/p>)[^])*<a href="directory\/">服务方目录<\/a>/, 'the footer, in Chinese')
  assert.match(home, /<p lang="en">(?:(?!<\/p>)[^])*<a href="directory\/">Provider directory<\/a>/, 'the footer, in English')
  assert.match(read('docs/guides/ai-providers.md'), /\[provider directory\]\(https:\/\/tapeapi\.fun\/directory\/\)/)
  assert.match(read('docs/guides/zh-CN/ai-providers.md'), /\[服务方目录\]\(https:\/\/tapeapi\.fun\/directory\/\)/)
})

// ---- the workflows / 工作流 ----
const recheckYml = read('.github/workflows/directory-recheck.yml')
const ciYml = read('.github/workflows/ci.yml')

test('workflow: the daily recheck runs once a day, read-only on chain, with no secret, and commits status.json only', () => {
  assert.equal(existsSync(join(ROOT, 'directory/daily-recheck.yml.draft')), false, 'the draft is gone')
  for (const y of [recheckYml, ciYml]) { assert.doesNotMatch(y, /\t/, 'no tabs'); for (const l of y.split('\n')) assert.equal((l.match(/^ */)[0].length) % 2, 0, `odd indentation: ${l}`) }
  const crons = [...recheckYml.matchAll(/cron: '([^']+)'/g)].map((m) => m[1])
  assert.equal(crons.length, 1)
  assert.match(crons[0], /^\d{1,2} \d{1,2} \* \* \*$/, 'once a day')
  assert.match(recheckYml, /^on:\n  schedule:\n    - cron: '[^']+'.*\n  workflow_dispatch:\n\n/m, 'a schedule and a manual run; no pull_request or push trigger')
  assert.match(recheckYml, /^permissions:\n  contents: write +#.*\n\n/m, 'contents: write and nothing else')
  assert.doesNotMatch(recheckYml, /secrets\.|\$\{\{\s*env\.|_KEY|TOKEN:/, 'no secret, no key')
  assert.match(recheckYml, /if: github\.repository == 'BruceLanLan\/tapeapi'/)
  assert.match(recheckYml, /node directory\/recheck\.mjs --recheck --write/)
  assert.deepEqual([...recheckYml.matchAll(/git add ([^\n]+)/g)].map((m) => m[1].trim()), ['site/directory/status.json'])
  assert.match(recheckYml, /user\.email '41898282\+github-actions\[bot\]@users\.noreply\.github\.com'/, 'committed by the Actions bot, not as a person')
  assert.doesNotMatch(recheckYml, /BruceLanLan@users/)
  assert.match(recheckYml, /timeout-minutes: \d+/)
  assert.match(recheckYml, /concurrency:\n  group: directory-recheck/)
})

test('workflow: CI validates providers.json on every pull request, format only (no doctor, no RPC)', () => {
  const job = /\n  directory:\n([^]*?)(?=\n  [a-z-]+:\n|$)/.exec(ciYml)?.[1]
  assert.ok(job, 'ci.yml has a directory job')
  const steps = job.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  assert.match(steps, /run: node directory\/recheck\.mjs --validate/)
  assert.doesNotMatch(steps, /tapeapi-doctor|--recheck|secrets\./)
  assert.match(ciYml, /^on:\n  push:\n    branches: \[main\]\n  pull_request:\n/m, 'no paths filter at the top: it would apply to the test job too')
  assert.match(ciYml, /^permissions:\n  contents: read\n/m)
})

test('workflow: both files parse as YAML with the expected shape (when PyYAML is available)', (t) => {
  const py = spawnSync('python3', ['-c', `
import sys, json, yaml
out = {}
for f in sys.argv[1:]:
    d = yaml.safe_load(open(f))
    on = d.get('on', d.get(True))
    out[f] = {'jobs': sorted(d['jobs']), 'on': sorted(on), 'permissions': d['permissions'], 'cron': [c['cron'] for c in (on.get('schedule') or [])]}
print(json.dumps(out))
`, join(ROOT, '.github/workflows/directory-recheck.yml'), join(ROOT, '.github/workflows/ci.yml')], { encoding: 'utf8' })
  if (py.status !== 0) { t.skip(`PyYAML not available: ${(py.stderr || '').trim().split('\n').pop()}`); return }
  const out = Object.values(JSON.parse(py.stdout))
  assert.deepEqual(out[0], { jobs: ['recheck'], on: ['schedule', 'workflow_dispatch'], permissions: { contents: 'write' }, cron: ['17 3 * * *'] })
  assert.deepEqual(out[1].jobs, ['directory', 'test'])
  assert.deepEqual(out[1].permissions, { contents: 'read' })
})

