#!/usr/bin/env node
// Vendor the SDK into the developer playground (tapeapi.fun/playground/), so the page runs the very code a developer
// installs, with no CDN and no build step on Pages.
// 把 SDK 放进开发者调试台（tapeapi.fun/playground/）：页面运行的就是开发者安装的同一份代码，不用 CDN，Pages 也不需要构建。
//
//   node scripts/build-playground.mjs    writes site/playground/vendor/<hash>/, the import map in site/playground/index.html,
//                                        and every vendor path in the pages that load it (commit the result: Pages runs no build)
//                                        写出 site/playground/vendor/<hash>/、index.html 里的 import map，以及加载它的页面里
//                                        的每个 vendor 路径（请提交结果：Pages 不执行构建）
//
// What is copied: the transitive import graph of sdk/src/index.js (only what it imports, nothing Node-only), and the
// @noble files that graph reaches, resolved through each package's `exports` with the browser (non-`node`) condition.
// Files are copied byte for byte, license headers included, except that a trailing `//# sourceMappingURL=` line is
// dropped (the .map files are not vendored, and a browser would ask for them). Each package's LICENSE is copied beside
// it; the SDK gets the repository's LICENSE. Bare specifiers (`@noble/hashes/sha3`, `@noble/hashes/utils.js`, ...) are
// left as they are and answered by an import map spliced between two markers in index.html: one exact entry for every
// specifier the graph uses. The output is deterministic, and scripts/build-playground.test.mjs fails when the committed
// files differ from a fresh build. No dependencies.
// 复制内容：sdk/src/index.js 的传递导入图（只含它导入的文件，没有仅限 Node 的代码），以及该图用到的 @noble 文件（按各包
// `exports` 的浏览器条件解析，不取 `node`）。文件逐字节复制、保留许可证头，唯一的改动是去掉末尾的 `//# sourceMappingURL=`
// 一行（没有附带 .map 文件，浏览器会去请求它）。每个包旁边放它的 LICENSE；SDK 用仓库根目录的 LICENSE。裸说明符保持原样，
// 由拼进 index.html 两个标记之间的 import map 解析：图里用到的每个说明符一条精确映射。输出确定；已提交文件与重新构建不一致时，
// scripts/build-playground.test.mjs 失败。无依赖。
//
// Why a content-hashed directory (2026-09-29). The vendored modules import each other by relative path without a content
// stamp, on purpose: one module must never be loaded under two URLs, and the files must stay byte for byte what sdk/src
// and @noble hold, so anyone can check the page's code. But Cloudflare's Browser Cache TTL rewrites the Cache-Control of
// every .js to 4 hours, whatever site/_headers says, so after a release a returning visitor could get the new index.js
// with a cached old ai.js. So the whole tree lives in ONE directory named by a hash of every vendored file:
// vendor/<hash10>/{tapeapi-sdk,noble-hashes,noble-curves,noble-ciphers}/. A URL under it always means the same bytes,
// whatever any cache holds, and a release that changes any file moves every URL at once. One hash for the tree rather
// than one per package: @noble packages reach each other through bare specifiers (the import map, inside the HTML, which
// is revalidated), so per-package directories would also be correct, but one prefix is one thing to rewrite and to test;
// the cost is that @noble is fetched again when only the SDK changes. The pages that load the tree (playground, verify,
// dashboard) are rewritten here to the current directory: their import maps are regenerated from the playground's, the
// verify page's policy gets the new map's hash, and every `.../vendor/<pkg>/` or `.../vendor/<old hash>/<pkg>/` path
// literal in their scripts is pointed at the new one. The files in the repository are always the deployable result,
// and a second run changes nothing.
// 为什么用按内容哈希命名的目录（2026-09-29）：vendor 模块之间用不带内容戳的相对路径互相导入，这是有意的：同一模块不能以两个
// 网址加载，文件也必须与 sdk/src、@noble 逐字节相同，任何人都能核对页面代码。但 Cloudflare 的 Browser Cache TTL 会把所有
// .js 的 Cache-Control 改成 4 小时，不管 site/_headers 怎么写，于是发版后回访者可能拿到新的 index.js 配缓存的旧 ai.js。
// 所以整棵树放在一个以全部 vendor 文件的哈希命名的目录里：vendor/<hash10>/{tapeapi-sdk,noble-*}/。这个目录下的网址永远对应
// 同样的字节，不管缓存里有什么；任何文件改变，所有网址一起换。整棵树一个哈希而不是每个包一个：@noble 各包之间通过裸说明符
// （import map，在每次都重新验证的 HTML 里）互相引用，分包也正确，但一个前缀只需改写和测试一处；代价是只改 SDK 时 @noble
// 也要重新下载。加载这棵树的页面（调试台、核验页、我的服务）也由本脚本改写：import map 按调试台的重新生成，核验页的策略换成
// 新 map 的哈希，脚本里的 `.../vendor/<包>/` 或 `.../vendor/<旧哈希>/<包>/` 路径一律指向新目录。仓库里的文件永远是可直接部署的
// 结果，运行两次结果不变。
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs'
import { join, dirname, posix } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SITE = 'site'                     // every output path below is relative to site/ / 下面的输出路径都相对 site/
export const OUT = 'playground'
export const VENDOR = 'playground/vendor'
export const ENTRY = 'sdk/src/index.js'
export const PAGE = 'playground/index.html'
export const MAP_BEGIN = '<!-- importmap:begin'
export const MAP_END = '<!-- importmap:end -->'
export const HASH_LEN = 10

// Import and re-export statements, anchored at the start of a line so an example inside a JSDoc comment
// (` * import { ed25519 } from '@noble/curves/ed25519'`) is not taken for one. The clause may span lines.
// 导入与再导出语句，锚定在行首，JSDoc 注释里的示例不会被当成导入。语句可以跨行。
const FROM_RE = /^[ \t]*(?:import|export)\s+(?:type\s+)?[\w\s*{},$]*?\s*from\s*(['"])([^'"\n]+)\1/gm
const BARE_IMPORT_RE = /^[ \t]*import\s*(['"])([^'"\n]+)\1/gm
const SOURCE_MAP_RE = /\n?\/\/# sourceMappingURL=[^\n]*\n?$/

/** Every module specifier a file imports or re-exports from, in order. / 文件导入或再导出的全部模块说明符，按出现顺序。 */
export function importsOf(code) {
  const found = []
  for (const re of [FROM_RE, BARE_IMPORT_RE]) for (const m of code.matchAll(re)) found.push({ at: m.index, spec: m[2] })
  return found.sort((a, b) => a.at - b.at).map((x) => x.spec)
}

const isRelative = (s) => s.startsWith('./') || s.startsWith('../')
const readPkg = (name) => JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8'))
const readRepo = (p) => readFileSync(join(ROOT, p), 'utf8')

// `exports` target for the browser: `import`, then `default`, never `node` (which picks cryptoNode.js).
// 浏览器用的 exports 目标：先 `import`，再 `default`，绝不取 `node`（那会选中 cryptoNode.js）。
function browserTarget(entry) {
  if (typeof entry === 'string') return entry
  if (!entry || typeof entry !== 'object') return null
  for (const k of ['browser', 'import', 'default']) {
    if (k in entry) { const t = browserTarget(entry[k]); if (t) return t }
  }
  return null
}

/** '@noble/hashes/sha3' -> { pkg: '@noble/hashes', file: 'esm/sha3.js' } / 裸说明符解析到包内文件 */
export function resolveBare(spec) {
  const m = /^(@[^/]+\/[^/]+)(?:\/(.+))?$/.exec(spec)
  if (!m) throw new Error(`unsupported bare specifier ${spec}`)
  const [, pkg, sub] = m
  const exp = readPkg(pkg).exports
  if (!exp) throw new Error(`${pkg} has no exports map`)
  const key = sub ? `./${sub}` : '.'
  const entry = exp[key] ?? (key.endsWith('.js') ? exp[key.slice(0, -3)] : exp[`${key}.js`])
  const target = browserTarget(entry)
  if (!target) throw new Error(`${pkg} does not export ${key} for the browser (spec ${spec})`)
  return { pkg, file: posix.normalize(target.replace(/^\.\//, '')) }
}

// Where each source lands under vendor/<hash>/: one directory per package (three of them ship a utils.js).
// 每个包在 vendor/<hash>/ 下放一个目录（三个包都有 utils.js）。
export const SDK_DIR = 'tapeapi-sdk'
const dirOf = (pkg) => pkg.replace(/^@/, '').replace('/', '-')   // @noble/hashes -> noble-hashes

/**
 * Walk the import graph from sdk/src/index.js. Paths in `files` and `specs` are relative to vendor/<hash>/.
 * `read(repoPath)` reads a source (a test passes a changed copy). / 从 sdk/src/index.js 遍历导入图；路径相对 vendor/<hash>/。
 */
export function graph(read = readRepo) {
  const files = new Map()   // repo path -> path under vendor/<hash>/
  const specs = new Map()   // bare specifier -> path under vendor/<hash>/
  const pkgs = new Set()
  const vendoredPath = (repoPath) => {
    if (repoPath.startsWith('sdk/src/')) return `${SDK_DIR}/${repoPath.slice('sdk/src/'.length)}`
    const m = /^node_modules\/(@[^/]+\/[^/]+)\/(.+)$/.exec(repoPath)
    if (!m) throw new Error(`cannot vendor ${repoPath}`)
    const [, pkg, rest] = m
    // Keep the path below the package's esm/ directory, so relative imports between its files still line up.
    // 保留 esm/ 之下的路径，包内文件之间的相对导入仍然对得上。
    if (!rest.startsWith('esm/')) throw new Error(`${repoPath}: expected an ESM file under esm/`)
    pkgs.add(pkg)
    return `${dirOf(pkg)}/${rest.slice('esm/'.length)}`
  }
  const queue = [ENTRY]
  while (queue.length) {
    const file = queue.shift()
    if (files.has(file)) continue
    if (!existsSync(join(ROOT, file))) throw new Error(`${file} does not exist`)
    files.set(file, vendoredPath(file))
    const code = read(file)
    if (/from\s*['"]node:|\brequire\s*\(|\bimport\s*\(\s*['"]/.test(code.replace(/\/\*[^]*?\*\/|\/\/[^\n]*/g, ''))) {
      throw new Error(`${file} uses node:, require() or a dynamic import: it cannot run in the browser as a plain module`)
    }
    for (const spec of importsOf(code)) {
      let target
      if (isRelative(spec)) target = posix.normalize(posix.join(posix.dirname(file), spec))
      else {
        const { pkg, file: inPkg } = resolveBare(spec)
        target = `node_modules/${pkg}/${inPkg}`
        specs.set(spec, vendoredPath(target))
      }
      queue.push(target)
    }
  }
  return { files, specs, pkgs: [...pkgs].sort() }
}

const sortedEntries = (m) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

/** The vendored tree: Map<path under vendor/<hash>/, content>, sorted. / vendor 树：路径（相对 vendor/<hash>/）→ 内容。 */
export function vendorTree(g, read = readRepo) {
  const out = new Map()
  for (const [src, dest] of g.files) out.set(dest, read(src).replace(SOURCE_MAP_RE, '\n'))
  out.set(`${SDK_DIR}/LICENSE`, read('LICENSE'))
  for (const pkg of g.pkgs) out.set(`${dirOf(pkg)}/LICENSE`, read(`node_modules/${pkg}/LICENSE`))
  return new Map(sortedEntries(out))
}

/**
 * The directory name: the first 10 hex digits of a SHA-256 over every (path, length, content) of the tree, in path order.
 * Any byte of any file, or any path, changes it. / 目录名：按路径顺序对每个（路径、长度、内容）做 SHA-256，取前 10 位十六进制。
 */
export function vendorHash(tree) {
  const h = createHash('sha256')
  for (const [p, content] of sortedEntries(tree)) {
    const bytes = Buffer.from(content, 'utf8')
    h.update(`${p}\0${bytes.length}\0`).update(bytes)
  }
  return h.digest('hex').slice(0, HASH_LEN)
}

/** The playground's import map entries for a tree in vendor/<hash>/. / 调试台 import map 的条目。 */
export const importsFor = (specs, hash) => Object.fromEntries(sortedEntries(specs).map(([k, v]) => [k, `./vendor/${hash}/${v}`]))

/** The import map block that sits between the markers in index.html. / index.html 标记之间的 import map 块。 */
export function importMapBlock({ specs, pkgs }, hash, read = readRepo) {
  const versions = [`@tapeapi/sdk ${JSON.parse(read('sdk/package.json')).version}`, ...pkgs.map((p) => `${p} ${readPkg(p).version}`)]
  return `${MAP_BEGIN}: generated by scripts/build-playground.mjs (${versions.join(', ')}); do not edit by hand -->\n`
    + `<script type="importmap">${mapBody(importsFor(specs, hash))}</script>\n${MAP_END}`
}

/** The exact text between `<script type="importmap">` and `</script>`. / import map 标签之间的准确文本。 */
export const mapBody = (imports) => `\n${JSON.stringify({ imports }, null, 2)}\n`

/** Splice a fresh import map into the page's text. / 把新的 import map 拼进页面文本。 */
export function withImportMap(html, block) {
  const a = html.indexOf(MAP_BEGIN), b = html.indexOf(MAP_END)
  if (a < 0 || b < a) throw new Error(`${SITE}/${PAGE} must contain the markers "${MAP_BEGIN} ... -->" and "${MAP_END}"`)
  return html.slice(0, a) + block + html.slice(b + MAP_END.length)
}

// A path into the vendored tree, with or without an (old) hash directory: `vendor/tapeapi-sdk/`, `vendor/0123456789/noble-hashes/`.
// Only a path that names a package directory matches, so prose like "vendored under vendor/." is left alone.
// 指向 vendor 树的路径，带不带（旧的）哈希目录都算；只有后面跟着包目录才匹配，正文里的 "vendor/." 不动。
export const VENDOR_REF = new RegExp(`\\bvendor/(?:[0-9a-f]{${HASH_LEN}}/)?(?=(?:${SDK_DIR}|noble-[a-z]+)/)`, 'g')

/** Point every vendor path in a page or script at vendor/<hash>/. / 把页面或脚本里的 vendor 路径都指向 vendor/<hash>/。 */
export const retarget = (text, hash) => text.replace(VENDOR_REF, `vendor/${hash}/`)

const IMPORT_MAP_RE = /(<script type="importmap">)([^]*?)(<\/script>)/g
const CSP_RE = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/g

/**
 * A page outside the playground that uses the playground's tree: its import map becomes the playground's, read from its
 * own directory, and a page policy that allows the map by hash gets the new hash. / 调试台以外使用这棵树的页面：import map
 * 换成调试台的（按本页目录改写相对路径）；页面策略按哈希放行 map 的，换成新哈希。
 */
export function withPageMap(html, file, playgroundImports) {
  const maps = [...html.matchAll(IMPORT_MAP_RE)]
  if (maps.length !== 1) throw new Error(`${SITE}/${file}: expected exactly one <script type="importmap">, found ${maps.length}`)
  const up = posix.relative(posix.dirname(file), OUT)           // e.g. '../playground'
  const imports = Object.fromEntries(Object.entries(playgroundImports).map(([k, v]) => [k, `${up}/${v.replace(/^\.\//, '')}`]))
  const body = mapBody(imports)
  let out = html.replace(IMPORT_MAP_RE, (_, open, __, close) => `${open}${body}${close}`)
  const policies = [...out.matchAll(CSP_RE)]
  if (policies.length > 1) throw new Error(`${SITE}/${file}: more than one Content-Security-Policy <meta>`)
  if (policies.length && /'sha256-/.test(policies[0][1])) {
    const hashes = policies[0][1].match(/'sha256-[A-Za-z0-9+/=]+'/g)
    if (hashes.length !== 1) throw new Error(`${SITE}/${file}: the policy must allow exactly one inline script (the import map) by hash`)
    const fresh = `'sha256-${createHash('sha256').update(body).digest('base64')}'`
    out = out.replace(CSP_RE, (tag) => tag.replace(hashes[0], fresh))
  }
  return out
}

/** Every .js and .html under site/ that the vendored tree's consumers live in: not vendor/ itself, not the generated docs/. */
export function sitePages(dir = join(ROOT, SITE), base = dir) {
  return readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return n === 'vendor' || n === 'docs' || n.startsWith('.') ? [] : sitePages(p, base)
    return /\.(?:js|html)$/.test(n) ? [posix.join(...p.slice(base.length + 1).split(/[\\/]/))] : []
  })
}

/**
 * Build everything in memory: { files: Map<path under site/, content>, hash }. `read` reads sources (sdk/src, node_modules,
 * LICENSE); the pages are always read from disk. / 在内存中构建：{ files: 路径（相对 site/）→ 内容, hash }。
 */
export function build({ read = readRepo } = {}) {
  const g = graph(read)
  const tree = vendorTree(g, read)
  const hash = vendorHash(tree)
  const out = new Map()
  for (const [p, content] of tree) out.set(`${VENDOR}/${hash}/${p}`, content)
  const imports = importsFor(g.specs, hash)
  for (const file of sitePages()) {
    const before = readRepo(`${SITE}/${file}`)
    const hasMap = before.includes('<script type="importmap">')
    const uses = hasMap || new RegExp(VENDOR_REF.source).test(before)
    if (!uses) continue
    let after = before
    if (file === PAGE) after = withImportMap(before, importMapBlock(g, hash, read))
    else if (hasMap) after = withPageMap(before, file, imports)
    out.set(file, retarget(after, hash))
  }
  return { files: new Map(sortedEntries(out)), hash }
}

export function listFiles(dir, base = dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).sort().flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? listFiles(p, base) : [posix.join(...p.slice(base.length + 1).split(/[\\/]/))]
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { files, hash } = build()
  // Only the current directory stays, holding only what the build produced. / 只保留当前目录，且其中只有构建产出的文件。
  const vendorAbs = join(ROOT, SITE, VENDOR)
  let removed = 0
  for (const n of existsSync(vendorAbs) ? readdirSync(vendorAbs) : []) {
    if (n !== hash) { rmSync(join(vendorAbs, n), { recursive: true, force: true }); removed++ }
  }
  for (const f of listFiles(join(vendorAbs, hash))) {
    if (!files.has(`${VENDOR}/${hash}/${f}`)) { rmSync(join(vendorAbs, hash, f)); removed++ }
  }
  let changed = 0
  for (const [p, content] of files) {
    const path = join(ROOT, SITE, p)
    if (existsSync(path) && readFileSync(path, 'utf8') === content) continue
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    changed++
  }
  console.log(`vendor/${hash}/: wrote ${changed} of ${files.size} files under ${SITE}/, removed ${removed} old entries`)
}
