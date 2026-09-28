#!/usr/bin/env node
// Stamp every local stylesheet and script a page loads with a hash of its content: `href="style.css?v=<hash>"`.
// Cloudflare serves .css and .js with a 4-hour browser cache while HTML revalidates on every visit, so after a change a
// returning visitor got the new page with the old stylesheet (2026-09-27, the site redesign). A new hash is a new URL.
//   node scripts/version-assets.mjs    rewrites site/**/*.html in place (build-docs.mjs stamps its own pages the same way)
// 给页面加载的每个本地样式表和脚本加上内容哈希：`href="style.css?v=<hash>"`。Cloudflare 让 .css/.js 在浏览器缓存 4 小时，
// HTML 每次都重新验证，于是改版后回访者拿到新页面配旧样式表（2026-09-27 网站改版）。哈希变了，网址就变了。
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SITE = join(ROOT, 'site')

export const assetHash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 10)

// A local reference: relative or root-absolute, no scheme, no protocol-relative `//`. / 本地引用：相对或以 / 开头，不含协议。
const REF = /\b(href|src)="((?!\/\/)(?![a-z][a-z0-9+.-]*:)[^"?#]+\.(?:css|js))(?:\?v=[0-9a-f]*)?"/gi

/** Stamp the references in one page. `pageDir` is the page's directory; a missing file is an error. */
export function versionRefs(html, pageDir, siteRoot = SITE) {
  return html.replace(REF, (_, attr, ref) => {
    const file = ref.startsWith('/') ? join(siteRoot, ref) : join(pageDir, ref)
    if (!existsSync(file)) throw new Error(`${attr}="${ref}" points at a missing file (${relative(ROOT, file)})`)
    return `${attr}="${ref}?v=${assetHash(readFileSync(file))}"`
  })
}

// A static relative import in a page's own module (vendored code excluded): `from './lib.js'` / `import('./lib.js')`. A module imported by
// another is cached for 4 hours like any script, so a new console.js next to a stale lib.js would fail to load: the
// import is stamped too, leaves first, so a change anywhere below a page changes the page's own reference.
// 页面自身模块里的静态相对导入。被导入的模块同样缓存 4 小时，新的 console.js 配旧的 lib.js 会加载失败；因此导入也加戳，
// 先叶子后根，任何下层文件变了，页面引用的网址也跟着变。
const IMPORT = /(\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)(['"])(\.{1,2}\/[^'"?#]+\.js)(?:\?v=[0-9a-f]*)?\2/gm

/** Stamp one module's relative imports, recursively; returns its final bytes. `memo` maps file -> final text. */
export function stampModule(file, memo = new Map(), stack = []) {
  if (memo.has(file)) return memo.get(file)
  if (stack.includes(file)) throw new Error(`import cycle: ${[...stack, file].map((f) => relative(ROOT, f)).join(' -> ')}`)
  const src = readFileSync(file, 'utf8')
  const out = src.replace(IMPORT, (whole, lead, q, ref) => {
    const dep = join(dirname(file), ref)
    // Vendored code imports its siblings unstamped; a stamped URL here would load a second copy of the same module
    // (and break instanceof across the two). / vendor 内部互相导入不带戳，这里加戳会加载同一模块的第二份副本。
    if (dep.split(sep).includes('vendor')) return whole
    if (!existsSync(dep)) throw new Error(`import ${ref} in ${relative(ROOT, file)} points at a missing file`)
    return `${lead}${q}${ref}?v=${assetHash(stampModule(dep, memo, [...stack, file]))}${q}`
  })
  memo.set(file, out)
  return out
}

/** Every module under site/ outside vendor/ (vendored code keeps its own import map). / site/ 下 vendor 以外的全部模块。 */
export function modules(dir = SITE) {
  return readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return n === 'vendor' || n.startsWith('.') ? [] : modules(p)
    return n.endsWith('.js') ? [p] : []
  })
}

/** Every HTML page under site/, vendored code excluded. / site/ 下全部 HTML 页面，不含 vendor。 */
export function pages(dir = SITE) {
  return readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return n === 'vendor' || n.startsWith('.') ? [] : pages(p)
    return n.endsWith('.html') ? [p] : []
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let changed = 0
  const memo = new Map()
  for (const m of modules()) {
    const before = readFileSync(m, 'utf8')
    const after = stampModule(m, memo)
    if (after !== before) { writeFileSync(m, after); changed++; console.log(`stamped ${relative(ROOT, m).split(sep).join('/')}`) }
  }
  for (const p of pages()) {
    const before = readFileSync(p, 'utf8')
    const after = versionRefs(before, dirname(p))
    if (after !== before) { writeFileSync(p, after); changed++; console.log(`stamped ${relative(ROOT, p).split(sep).join('/')}`) }
  }
  console.log(`${changed} file(s) changed`)
}
