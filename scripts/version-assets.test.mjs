// Every page's local stylesheets and scripts carry the hash of their current content (scripts/version-assets.mjs).
// Run `node scripts/version-assets.mjs` after editing a .css or .js file under site/, and commit the result.
// 每个页面的本地样式表与脚本都带着其当前内容的哈希。改了 site/ 下的 .css 或 .js 后运行 node scripts/version-assets.mjs 并提交。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { versionRefs, pages, assetHash, ROOT } from './version-assets.mjs'

test('version-assets: every page under site/ is stamped with current hashes (run node scripts/version-assets.mjs)', () => {
  const all = pages()
  assert.ok(all.length >= 20, `found only ${all.length} pages`)
  for (const p of all) {
    const html = readFileSync(p, 'utf8')
    assert.equal(versionRefs(html, dirname(p)), html, `${relative(ROOT, p)} is stale: run node scripts/version-assets.mjs`)
    for (const m of html.matchAll(/\b(?:href|src)="([^"]+\.(?:css|js))(\?[^"]*)?"/g)) {
      if (/^(?:[a-z]+:|\/\/)/i.test(m[1])) continue
      assert.match(m[2] || '', /^\?v=[0-9a-f]{10}$/, `${relative(ROOT, p)}: ${m[1]} has no content hash`)
    }
  }
})

test('version-assets: stamps local refs, restamps old hashes, leaves external URLs alone, refuses a missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'va-'))
  writeFileSync(join(dir, 'a.css'), 'body{}')
  writeFileSync(join(dir, 'b.js'), 'x=1')
  const h = (s) => assetHash(Buffer.from(s))
  const html = '<link href="a.css"><script src="b.js?v=0000000000"></script><script src="https://cdn.example/x.js"></script><link href="//cdn.example/y.css">'
  assert.equal(versionRefs(html, dir, dir),
    `<link href="a.css?v=${h('body{}')}"><script src="b.js?v=${h('x=1')}"></script><script src="https://cdn.example/x.js"></script><link href="//cdn.example/y.css">`)
  assert.equal(versionRefs('<link href="/a.css">', join(dir, 'sub'), dir), `<link href="/a.css?v=${h('body{}')}">`)
  assert.throws(() => versionRefs('<link href="gone.css">', dir, dir), /missing file/)
})

// Module imports (2026-09-28): a page's own modules stamp their relative imports, leaves first; vendored code is left
// alone so one module is never loaded under two URLs. / 页面自身模块的相对导入加戳，先叶子后根；vendor 不动，避免同一模块两个网址。
test('stampModule: relative imports get the hash of the stamped dependency, vendor imports stay, a second run changes nothing, a cycle is an error', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, readFileSync: rd } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join: j } = await import('node:path')
  const { stampModule, assetHash } = await import('./version-assets.mjs')
  const d = mkdtempSync(j(tmpdir(), 'va-'))
  mkdirSync(j(d, 'vendor'))
  writeFileSync(j(d, 'vendor', 'sdk.js'), "import { x } from './errors.js'\nexport const y = x\n")
  writeFileSync(j(d, 'vendor', 'errors.js'), 'export const x = 1\n')
  writeFileSync(j(d, 'leaf.js'), 'export const leaf = 1\n')
  writeFileSync(j(d, 'lib.js'), "import { leaf } from './leaf.js'\nimport { y } from './vendor/sdk.js'\nexport const lib = leaf + y\n")
  writeFileSync(j(d, 'page.js'), "import * as L from './lib.js'\nconst later = () => import('./leaf.js')\n")
  const memo = new Map()
  const lib = stampModule(j(d, 'lib.js'), memo)
  assert.match(lib, new RegExp(`from './leaf\\.js\\?v=${assetHash(rd(j(d, 'leaf.js')))}'`))
  assert.match(lib, /from '\.\/vendor\/sdk\.js'\n/, 'vendored import left unstamped')
  const page = stampModule(j(d, 'page.js'), memo)
  assert.match(page, new RegExp(`from './lib\\.js\\?v=${assetHash(lib)}'`), 'the hash is of the STAMPED dependency')
  assert.match(page, /import\('\.\/leaf\.js\?v=[0-9a-f]{10}'\)/)
  writeFileSync(j(d, 'page.js'), page); writeFileSync(j(d, 'lib.js'), lib)
  assert.equal(stampModule(j(d, 'page.js'), new Map()), page, 'idempotent')
  writeFileSync(j(d, 'a.js'), "import './b.js'\n"); writeFileSync(j(d, 'b.js'), "import './a.js'\n")
  assert.throws(() => stampModule(j(d, 'a.js'), new Map()), /import cycle/)
})

test('site modules: every relative import outside vendor/ carries the current hash (run scripts/version-assets.mjs)', async () => {
  const { readFileSync: rd } = await import('node:fs')
  const { stampModule, modules } = await import('./version-assets.mjs')
  const memo = new Map()
  for (const m of modules()) assert.equal(rd(m, 'utf8'), stampModule(m, memo), `${m} is not stamped; run node scripts/version-assets.mjs`)
})
