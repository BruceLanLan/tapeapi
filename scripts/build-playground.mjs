#!/usr/bin/env node
// Vendor the SDK into the developer playground (tapeapi.fun/playground/), so the page runs the very code a developer
// installs, with no CDN and no build step on Pages.
// 把 SDK 放进开发者调试台（tapeapi.fun/playground/）：页面运行的就是开发者安装的同一份代码，不用 CDN，Pages 也不需要构建。
//
//   node scripts/build-playground.mjs    writes site/playground/vendor/ and the import map in site/playground/index.html
//                                        (commit the result: Pages runs no build)
//                                        写出 site/playground/vendor/ 与 index.html 里的 import map（请提交结果：Pages 不执行构建）
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
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs'
import { join, dirname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const OUT = 'site/playground'
export const VENDOR = 'vendor'
export const ENTRY = 'sdk/src/index.js'
export const PAGE = 'index.html'
export const MAP_BEGIN = '<!-- importmap:begin'
export const MAP_END = '<!-- importmap:end -->'

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

// Where each source lands under vendor/: one directory per package (three of them ship a utils.js).
// 每个包放一个目录（三个包都有 utils.js）。
const SDK_DIR = 'tapeapi-sdk'
const dirOf = (pkg) => pkg.replace(/^@/, '').replace('/', '-')   // @noble/hashes -> noble-hashes

/** Walk the import graph from sdk/src/index.js. / 从 sdk/src/index.js 遍历导入图。 */
export function graph() {
  const files = new Map()   // repo path -> vendored path (under OUT)
  const specs = new Map()   // bare specifier -> vendored path (under OUT)
  const pkgs = new Set()
  const vendoredPath = (repoPath) => {
    if (repoPath.startsWith('sdk/src/')) return `${VENDOR}/${SDK_DIR}/${repoPath.slice('sdk/src/'.length)}`
    const m = /^node_modules\/(@[^/]+\/[^/]+)\/(.+)$/.exec(repoPath)
    if (!m) throw new Error(`cannot vendor ${repoPath}`)
    const [, pkg, rest] = m
    // Keep the path below the package's esm/ directory, so relative imports between its files still line up.
    // 保留 esm/ 之下的路径，包内文件之间的相对导入仍然对得上。
    if (!rest.startsWith('esm/')) throw new Error(`${repoPath}: expected an ESM file under esm/`)
    pkgs.add(pkg)
    return `${VENDOR}/${dirOf(pkg)}/${rest.slice('esm/'.length)}`
  }
  const queue = [ENTRY]
  while (queue.length) {
    const file = queue.shift()
    if (files.has(file)) continue
    const abs = join(ROOT, file)
    if (!existsSync(abs)) throw new Error(`${file} does not exist`)
    files.set(file, vendoredPath(file))
    const code = readFileSync(abs, 'utf8')
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

/** The import map block that sits between the markers in index.html. / index.html 标记之间的 import map 块。 */
export function importMapBlock({ specs, pkgs }) {
  const versions = [`@tapeapi/sdk ${JSON.parse(readFileSync(join(ROOT, 'sdk/package.json'), 'utf8')).version}`, ...pkgs.map((p) => `${p} ${readPkg(p).version}`)]
  const imports = Object.fromEntries(sortedEntries(specs).map(([k, v]) => [k, `./${v}`]))
  return `${MAP_BEGIN}: generated by scripts/build-playground.mjs (${versions.join(', ')}); do not edit by hand -->\n`
    + `<script type="importmap">\n${JSON.stringify({ imports }, null, 2)}\n</script>\n${MAP_END}`
}

/** Splice a fresh import map into the page's text. / 把新的 import map 拼进页面文本。 */
export function withImportMap(html, block) {
  const a = html.indexOf(MAP_BEGIN), b = html.indexOf(MAP_END)
  if (a < 0 || b < a) throw new Error(`${OUT}/${PAGE} must contain the markers "${MAP_BEGIN} ... -->" and "${MAP_END}"`)
  return html.slice(0, a) + block + html.slice(b + MAP_END.length)
}

/** Build everything in memory: Map<path under site/playground/, content>. / 在内存中构建：路径 → 内容。 */
export function build() {
  const g = graph()
  const out = new Map()
  for (const [src, dest] of sortedEntries(g.files)) {
    out.set(dest, readFileSync(join(ROOT, src), 'utf8').replace(SOURCE_MAP_RE, '\n'))
  }
  out.set(`${VENDOR}/${SDK_DIR}/LICENSE`, readFileSync(join(ROOT, 'LICENSE'), 'utf8'))
  for (const pkg of g.pkgs) out.set(`${VENDOR}/${dirOf(pkg)}/LICENSE`, readFileSync(join(ROOT, 'node_modules', pkg, 'LICENSE'), 'utf8'))
  out.set(PAGE, withImportMap(readFileSync(join(ROOT, OUT, PAGE), 'utf8'), importMapBlock(g)))
  return new Map(sortedEntries(out))
}

export function listFiles(dir, base = dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).sort().flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? listFiles(p, base) : [posix.join(...p.slice(base.length + 1).split(/[\\/]/))]
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = build()
  rmSync(join(ROOT, OUT, VENDOR), { recursive: true, force: true })
  for (const [p, content] of files) {
    mkdirSync(dirname(join(ROOT, OUT, p)), { recursive: true })
    writeFileSync(join(ROOT, OUT, p), content)
  }
  console.log(`wrote ${files.size} files to ${OUT}/`)
}
