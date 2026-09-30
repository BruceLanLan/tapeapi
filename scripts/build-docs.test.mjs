// The docs site (site/docs/) must say what the guides say, render every construct the guides use, and link nowhere
// broken. Run `node scripts/build-docs.mjs` after editing a guide, and commit the result.
// 文档站必须与指南一致、正确渲染指南用到的每种写法、没有断链。改了指南后运行 node scripts/build-docs.mjs 并提交结果。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, posix } from 'node:path'
import { build, blocks, inline, listFiles, HAND_WRITTEN, ROOT, OUT } from './build-docs.mjs'

const files = build()
const md = (text) => blocks(text.split('\n'), { href: (h) => h, headings: [], ids: new Set() })

test('build-docs: the committed site/docs/ is exactly a fresh build (run node scripts/build-docs.mjs)', () => {
  for (const [p, content] of files) {
    const path = join(ROOT, OUT, p)
    assert.ok(existsSync(path), `${OUT}/${p} is missing: run node scripts/build-docs.mjs`)
    assert.equal(readFileSync(path, 'utf8'), content, `${OUT}/${p} is stale: run node scripts/build-docs.mjs`)
  }
  for (const p of listFiles(join(ROOT, OUT)).map((x) => x.split('\\').join('/'))) {
    assert.ok(files.has(p) || HAND_WRITTEN.has(p), `${OUT}/${p} is not produced by the build`)
  }
})

test('build-docs: every guide is on the site, in both languages', () => {
  const en = readdirSync(join(ROOT, 'docs/guides')).filter((f) => f.endsWith('.md') && f !== 'README.md')
  const zh = readdirSync(join(ROOT, 'docs/guides/zh-CN')).filter((f) => f.endsWith('.md') && f !== 'README.md')
  assert.deepEqual(zh.sort(), en.sort(), 'every English guide has a Chinese one')
  const html = [...files.keys()].join('\n')
  for (const f of en) {
    const page = f === 'introduction.md' ? 'index' : f.replace(/\.md$/, '')
    for (const lang of ['en', 'zh']) assert.match(html, new RegExp(`^${lang}/${page}\\.html$`, 'm'), `${lang}/${page}.html`)
  }
})

test('build-docs: no raw markdown reaches a page, and every internal link and anchor resolves', () => {
  for (const [p, content] of files) {
    if (!p.endsWith('.html') || p === 'index.html') continue
    const article = content.slice(content.indexOf('<article>'), content.indexOf('</article>'))
    const text = article.replace(/<pre[^]*?<\/pre>/g, '').replace(/<code>[^]*?<\/code>/g, '').replace(/<[^>]+>/g, '')
    for (const leak of ['**', '|---', '](', '```', '`']) assert.ok(!text.includes(leak), `${p}: raw markdown ${leak}`)
    assert.ok(!/\u0000/.test(content), `${p}: an unrestored placeholder`)
    assert.ok(!/^\s*#{1,4}\s/m.test(text), `${p}: raw markdown heading`)
    const ids = new Set([...content.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]))
    for (const [, href] of content.matchAll(/ href="([^"]+)"/g)) {
      if (/^(https?:|mailto:)/.test(href)) continue
      if (href === '/') { assert.ok(existsSync(join(ROOT, 'site/index.html'))); continue }
      if (href === '/favicon.svg') { assert.ok(existsSync(join(ROOT, 'site/favicon.svg'))); continue }   // the site's icon, outside docs/ / 站点图标，不在 docs/ 下
      const [path, hash] = href.replace(/\?v=[0-9a-f]{10}(?=#|$)/, '').split('#')   // a content hash (version-assets.mjs) is not part of the path
      if (!path) { assert.ok(ids.has(decodeURIComponent(hash)), `${p}: anchor #${hash} does not exist`); continue }
      // A page is linked without .html, as the server serves it (ONB2-11). / 页面链接不带 .html，与服务器一致。
      const at = posix.normalize(posix.join(posix.dirname(p), path))
      const target = at.endsWith('/') ? `${at}index.html` : files.has(at) || HAND_WRITTEN.has(at) ? at : `${at}.html`
      assert.ok(files.has(target) || HAND_WRITTEN.has(target), `${p}: link ${href} -> ${target} does not exist`)
      if (hash && files.has(target)) assert.ok(files.get(target).includes(` id="${decodeURIComponent(hash)}"`), `${p}: ${href} anchor missing`)
    }
  }
})

test('build-docs: links to repository files go to GitHub and point at files that exist', () => {
  for (const [p, content] of files) {
    for (const [, url] of content.matchAll(/href="https:\/\/github\.com\/BruceLanLan\/tapeapi\/(?:blob|tree)\/main\/([^"#]+)/g)) {
      assert.ok(existsSync(join(ROOT, url)), `${p}: ${url} does not exist in the repository`)
    }
  }
})

test('build-docs: the renderer handles the constructs the guides use', () => {
  // Nested bullets inside an ordered list, and a fenced block indented inside a list item (provide.md).
  const nested = md('1. **One.** first\n2. Two:\n   - a;\n   - b.\n3. Three:\n   ```bash\n   echo 0x<key>\n   ```\n4. Four.')
  assert.match(nested, /^<ol><li><strong>One\.<\/strong> first<\/li><li>Two:\n<ul><li>a;<\/li><li>b\.<\/li><\/ul><\/li><li><p>Three:<\/p>\n<div class="code"><pre data-lang="bash"><code>echo 0x&lt;key&gt;<\/code><\/pre><\/div><\/li><li>Four\.<\/li><\/ol>$/)
  // A table whose cell holds a pipe inside code. / 单元格代码里含竖线的表格。
  assert.match(md('| A | B |\n|---|---|\n| `a | b` | c |'), /<td><code>a \| b<\/code><\/td><td>c<\/td>/)
  // Hard-wrapped Chinese joins without a space; English with one. / 中文硬换行不加空格，英文加。
  assert.equal(md('中文第一行\n第二行'), '<p>中文第一行第二行</p>')
  assert.equal(md('first line\nsecond'), '<p>first line second</p>')
  // Code spans are literal; HTML in text is escaped. / 代码按字面；正文里的 HTML 被转义。
  assert.equal(inline('`**x**` and <b> [`c`](u)', { href: (h) => h }), '<code>**x**</code> and &lt;b&gt; <a href="u"><code>c</code></a>')
  assert.match(md('> **Note.** one\n> two'), /^<blockquote><p><strong>Note\.<\/strong> one two<\/p><\/blockquote>$/)
})

// FIXED DOCS-1 (1.0 review): Markdown link reference definitions ("[1.0.0]: https://…") produce no output, but the
// builder printed the changelog's 15 of them as one paragraph, which also made the page scroll sideways at 360 px.
// FIXED DOCS-1：Markdown 的链接定义行不应输出；构建器把更新日志末尾的 15 行拼成一段正文，手机宽度下还会横向滚动。
test('FIXED DOCS-1: link reference definitions are not rendered as text', async () => {
  const { renderPage } = await import('./build-docs.mjs')
  const html = renderPage('changelog', 'en').body
  assert.equal(typeof html, 'string')
  assert.match(html, /1\.0\.0/)
  assert.doesNotMatch(html, /\[Unreleased\]: https:\/\//)
  assert.doesNotMatch(html, /compare\/v1\.0\.0-rc\.5\.\.\.v1\.0\.0/)
})

test('FIXED ONB2-11: pages link each other without .html, like the sitemap, and the sitemap lists every page in both languages', () => {
  const sitemap = readFileSync(join(ROOT, 'site/sitemap.xml'), 'utf8')
  const locs = new Set([...sitemap.matchAll(/<loc>https:\/\/tapeapi\.fun\/([^<]*)<\/loc>/g)].map((m) => m[1]))
  for (const p of files.keys()) {
    if (!p.endsWith('.html') || p === 'index.html') continue
    const [lang, file] = p.split('/')
    assert.ok(locs.has(`docs/${lang}/${file === 'index.html' ? '' : file.replace(/\.html$/, '')}`), `the sitemap lists docs/${lang}/${file}`)
    for (const [, href] of files.get(p).matchAll(/ (?:href|data-other)="([^"]+)"/g)) {
      if (/^(https?:|mailto:|#|\/)/.test(href) || /\.(css|js|svg)(\?|$)/.test(href)) continue
      assert.ok(!/\.html(#|$)/.test(href), `${p}: ${href} names .html`)
    }
  }
  assert.ok(locs.has('docs/en/upgrade-1.0') && locs.has('docs/zh/upgrade-1.0'))
  for (const [, href] of readFileSync(join(ROOT, 'site/index.html'), 'utf8').matchAll(/href="(docs\/[^"]*)"/g)) assert.ok(!/\.html(#|$)/.test(href), `site/index.html: ${href}`)
})
