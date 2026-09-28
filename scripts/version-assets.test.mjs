// Every page's local stylesheets and scripts carry the hash of their current content (scripts/version-assets.mjs).
// Run `node scripts/version-assets.mjs` after editing a .css or .js file under site/, and commit the result.
// 每个页面的本地样式表与脚本都带着其当前内容的哈希。改了 site/ 下的 .css 或 .js 后运行 node scripts/version-assets.mjs 并提交。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { versionRefs, pages, stylesheets, inlineFonts, assetHash, ROOT } from './version-assets.mjs'

test('version-assets: every page under site/ is stamped with current hashes (run node scripts/version-assets.mjs)', () => {
  const all = pages()
  assert.ok(all.length >= 20, `found only ${all.length} pages`)
  for (const p of all) {
    const html = readFileSync(p, 'utf8')
    assert.equal(versionRefs(html, dirname(p)), html, `${relative(ROOT, p)} is stale: run node scripts/version-assets.mjs`)
    for (const m of html.matchAll(/\b(?:href|src)="([^"]+\.(?:css|js|woff2))(\?[^"]*)?"/g)) {
      if (/^(?:[a-z]+:|\/\/)/i.test(m[1])) continue
      assert.match(m[2] || '', /^\?v=[0-9a-f]{10}$/, `${relative(ROOT, p)}: ${m[1]} has no content hash`)
    }
  }
})

// Fonts (2026-09-29): the homepage's faces left style.css for fonts/*.woff2; every url() to a font carries its hash, and a
// preload names the very URL the stylesheet asks for (else the browser downloads the font twice).
// 字体：首页字体从 style.css 移到 fonts/*.woff2；每个指向字体的 url() 都带哈希，预加载的网址与样式表请求的完全一致（否则下载两次）。
test('version-assets: every stylesheet under site/ is stamped, and every font it or a page names carries a content hash', () => {
  const all = stylesheets()
  assert.ok(all.some((c) => c.endsWith(join('site', 'style.css'))) && all.length >= 4, `found ${all.length} stylesheets`)
  for (const c of [...all, ...pages()]) {
    const text = readFileSync(c, 'utf8')
    assert.equal(versionRefs(text, dirname(c)), text, `${relative(ROOT, c)} is stale: run node scripts/version-assets.mjs`)
    const css = c.endsWith('.css') ? text : [...text.matchAll(/<style\b[^>]*>([^]*?)<\/style>/g)].map((m) => m[1]).join('\n')   // a page: its own <style> only
    for (const m of css.matchAll(/url\((['"]?)([^'")]*?\.woff2)(\?[^'")]*)?\1\)/g)) {
      assert.match(m[3] || '', /^\?v=[0-9a-f]{10}$/, `${relative(ROOT, c)}: url(${m[2]}) has no content hash`)
    }
  }
  const css = readFileSync(join(ROOT, 'site', 'style.css'), 'utf8')
  assert.doesNotMatch(css, /url\(data:/, 'style.css embeds no font: they are files, so the first paint waits for 27 KB, not 93 KB')
  const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1])
  assert.equal(faces.length, 4)
  for (const f of faces) assert.match(f, /font-display:\s*swap/, 'every face swaps in: text paints before its font arrives')
  const home = readFileSync(join(ROOT, 'site', 'index.html'), 'utf8')
  const preloads = [...home.matchAll(/<link rel="preload" href="([^"]+)" as="font" type="font\/woff2" crossorigin>/g)].map((m) => m[1])
  assert.ok(preloads.length >= 1, 'the homepage preloads its display face')
  for (const href of preloads) assert.ok(css.includes(`url(${href})`), `preload ${href} is not the URL style.css asks for`)
})

test('inlineFonts: the self-contained copy of style.css carries the very bytes of each font file and no url() to a file', () => {
  const dir = join(ROOT, 'site')
  const css = readFileSync(join(dir, 'style.css'), 'utf8')
  const inlined = inlineFonts(css, dir)
  const urls = [...inlined.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1])
  assert.equal(urls.length, 4)
  for (const u of urls) assert.match(u, /^data:font\/woff2;base64,/)
  for (const [, ref] of css.matchAll(/url\((fonts\/[^)?]+)\?v=[0-9a-f]{10}\)/g)) {
    assert.ok(inlined.includes(readFileSync(join(dir, ref)).toString('base64')), `${ref} inlined byte for byte`)
  }
  const d = mkdtempSync(join(tmpdir(), 'va-'))
  assert.throws(() => inlineFonts('@font-face { src: url(fonts/gone.woff2) }', d), /missing file/)
})

test('version-assets: stamps local refs, restamps old hashes, leaves external URLs alone, refuses a missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'va-'))
  writeFileSync(join(dir, 'a.css'), 'body{}')
  writeFileSync(join(dir, 'b.js'), 'x=1')
  const h = (s) => assetHash(Buffer.from(s))
  writeFileSync(join(dir, 'f.woff2'), 'wOF2')
  const html = '<link href="a.css"><script src="b.js?v=0000000000"></script><script src="https://cdn.example/x.js"></script><link href="//cdn.example/y.css">'
  assert.equal(versionRefs(html, dir, dir),
    `<link href="a.css?v=${h('body{}')}"><script src="b.js?v=${h('x=1')}"></script><script src="https://cdn.example/x.js"></script><link href="//cdn.example/y.css">`)
  const css = '@font-face{src:url(f.woff2?v=0000000000)} @font-face{src:url("f.woff2")} x{background:url(data:font/woff2;base64,AA==)} y{src:url(https://cdn.example/z.woff2)}'
  assert.equal(versionRefs(css, dir, dir),
    `@font-face{src:url(f.woff2?v=${h('wOF2')})} @font-face{src:url("f.woff2?v=${h('wOF2')}")} x{background:url(data:font/woff2;base64,AA==)} y{src:url(https://cdn.example/z.woff2)}`)
  assert.equal(versionRefs('<link rel="preload" href="f.woff2" as="font">', dir, dir), `<link rel="preload" href="f.woff2?v=${h('wOF2')}" as="font">`)
  assert.throws(() => versionRefs('a{src:url(gone.woff2)}', dir, dir), /missing file/)
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

// The vendored SDK is not content-stamped inside (see stampModule), so its files must be revalidated on every load.
// vendor 内部不加内容戳，所以每次加载都要重新验证。
test('_headers: the vendored SDK is revalidated on every load (no 4-hour cache that could mix two releases)', async () => {
  const { readFileSync: rd } = await import('node:fs')
  const { join: j } = await import('node:path')
  const { SITE } = await import('./version-assets.mjs')
  const text = rd(j(SITE, '_headers'), 'utf8')
  assert.match(text, /^\/playground\/vendor\/\*\n  Cache-Control: public, max-age=0, must-revalidate$/m)
})
