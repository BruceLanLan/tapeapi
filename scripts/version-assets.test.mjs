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
