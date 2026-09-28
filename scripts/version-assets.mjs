#!/usr/bin/env node
// Stamp every local stylesheet, script and font a page loads with a hash of its content: `href="style.css?v=<hash>"`,
// `url(fonts/x.woff2?v=<hash>)` in stylesheets (and a page's own <style>), `href="fonts/x.woff2?v=<hash>"` in a preload.
// Cloudflare serves .css and .js with a 4-hour browser cache while HTML revalidates on every visit, so after a change a
// returning visitor got the new page with the old stylesheet (2026-09-27, the site redesign). A new hash is a new URL.
//   node scripts/version-assets.mjs    rewrites site/**/*.css, *.js and *.html in place, stylesheets first, so a new font changes
//                                      its stylesheet's hash and so the page's (build-docs.mjs stamps its own pages the same way)
// 给页面加载的每个本地样式表、脚本和字体加上内容哈希：`href="style.css?v=<hash>"`，样式表（及页面自己的 <style>）里的
// `url(fonts/x.woff2?v=<hash>)`，预加载的 `href="fonts/x.woff2?v=<hash>"`。先处理样式表，字体变了，样式表和页面的哈希也跟着变。Cloudflare 让 .css/.js 在浏览器缓存 4 小时，
// HTML 每次都重新验证，于是改版后回访者拿到新页面配旧样式表（2026-09-27 网站改版）。哈希变了，网址就变了。
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SITE = join(ROOT, 'site')

export const assetHash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 10)

// A local reference: relative or root-absolute, no scheme, no protocol-relative `//`. / 本地引用：相对或以 / 开头，不含协议。
const REF = /\b(href|src)="((?!\/\/)(?![a-z][a-z0-9+.-]*:)[^"?#]+\.(?:css|js|woff2))(?:\?v=[0-9a-f]*)?"/gi
// A font in a stylesheet: `url(fonts/x.woff2)`, quoted or not; data: URIs and other schemes are left alone.
// 样式表里的字体：`url(fonts/x.woff2)`，带不带引号均可；data: 与其他协议不动。
const FONT_URL = /\burl\((['"]?)((?!\/\/)(?![a-z][a-z0-9+.-]*:)[^'"()?#]+\.woff2)(?:\?v=[0-9a-f]*)?\1\)/gi

/** Stamp the references in one page or stylesheet. `baseDir` is its directory; a missing file is an error. */
export function versionRefs(text, baseDir, siteRoot = SITE) {
  const hashOf = (what, ref) => {
    const file = ref.startsWith('/') ? join(siteRoot, ref) : join(baseDir, ref)
    if (!existsSync(file)) throw new Error(`${what} points at a missing file (${relative(ROOT, file)})`)
    return assetHash(readFileSync(file))
  }
  return text
    .replace(REF, (_, attr, ref) => `${attr}="${ref}?v=${hashOf(`${attr}="${ref}"`, ref)}"`)
    .replace(FONT_URL, (_, q, ref) => `url(${q}${ref}?v=${hashOf(`url(${ref})`, ref)}${q})`)
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
export function pages(dir = SITE, ext = '.html') {
  return readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return n === 'vendor' || n.startsWith('.') ? [] : pages(p, ext)
    return n.endsWith(ext) ? [p] : []
  })
}

/** Every stylesheet under site/, vendored code excluded. / site/ 下全部样式表，不含 vendor。 */
export const stylesheets = (dir = SITE) => pages(dir, '.css')

/**
 * The stylesheet with every local woff2 `url()` replaced by a data URI of the file's bytes (the ?v= stamp dropped), for a
 * copy that must be self-contained (the DeWEB copy of the homepage, scripts/publish-site.mjs). A missing file is an error.
 * 把样式表里每个本地 woff2 `url()` 换成该文件字节的 data URI（去掉 ?v= 戳），供必须自包含的副本使用（首页的 DeWEB 副本）。
 */
export function inlineFonts(css, cssDir) {
  return css.replace(FONT_URL, (_, q, ref) => {
    const file = join(cssDir, ref)
    if (ref.startsWith('/') || !existsSync(file)) throw new Error(`url(${ref}) points at a missing file (${relative(ROOT, file)})`)
    return `url(data:font/woff2;base64,${readFileSync(file).toString('base64')})`
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let changed = 0
  const memo = new Map()
  for (const c of stylesheets()) {
    const before = readFileSync(c, 'utf8')
    const after = versionRefs(before, dirname(c))
    if (after !== before) { writeFileSync(c, after); changed++; console.log(`stamped ${relative(ROOT, c).split(sep).join('/')}`) }
  }
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
