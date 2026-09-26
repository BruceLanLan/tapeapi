#!/usr/bin/env node
// Build an import map for loading the SDK straight into a browser, with no bundler: walk every static import from
// sdk/src/index.js, resolve each bare specifier with Node's own resolver (the "import" condition, i.e. the ESM
// build), and map it to its file under /node_modules. What the browser then loads is exactly the SDK source.
// 不用打包工具，为浏览器直接加载 SDK 生成 import map：从 sdk/src/index.js 出发遍历所有静态 import，
// 用 Node 自己的解析器解析每个裸说明符，映射到 /node_modules 下的文件。浏览器加载的就是 SDK 源码本身。
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../../', import.meta.url))

// Resolve a bare specifier the way a BROWSER build would: package.json "exports" with the conditions browser >
// import > default, never "node" or "require". Node's own resolver would pick node-only files (e.g. @noble/hashes'
// cryptoNode.js, which imports node:crypto) that a browser never loads.
// 按浏览器的方式解析裸说明符：package.json 的 exports，条件顺序 browser > import > default，绝不用 node/require。
// Node 自带的解析器会选中浏览器永远不会加载的 Node 专用文件。
function resolveBrowser(spec) {
  const parts = spec.split('/')
  const pkg = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  const sub = '.' + spec.slice(pkg.length)
  const dir = path.join(root, 'node_modules', pkg)
  const pj = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  let target = pj.exports ? (pj.exports[sub] ?? pj.exports[sub + '.js']) : null
  const pick = (t) => {
    if (typeof t === 'string') return t
    if (t && typeof t === 'object') for (const c of ['browser', 'import', 'default']) if (c in t) { const r = pick(t[c]); if (r) return r }
    return null
  }
  target = pick(target) || (sub === '.' ? (pj.module || pj.main) : sub + '.js')
  if (!target) throw new Error(`cannot resolve ${spec} for the browser`)
  return pathToFileURL(path.join(dir, target)).href
}
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g
const imports = {}
const seen = new Set()
const queue = [pathToFileURL(path.join(root, 'sdk/src/index.js')).href]
while (queue.length) {
  const url = queue.pop()
  if (seen.has(url)) continue
  seen.add(url)
  const src = readFileSync(fileURLToPath(url), 'utf8')
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] || m[2]
    if (spec.startsWith('node:')) throw new Error(`${fileURLToPath(url)} imports ${spec}: not browser-clean`)
    const resolved = spec.startsWith('.') ? new URL(spec, url).href : resolveBrowser(spec)
    if (!spec.startsWith('.')) imports[spec] = '/' + path.relative(root, fileURLToPath(resolved)).split(path.sep).join('/')
    queue.push(resolved)
  }
}
writeFileSync(new URL('importmap.json', import.meta.url), JSON.stringify({ imports }, null, 2) + '\n')
const bytes = [...seen].reduce((n, u) => n + readFileSync(fileURLToPath(u)).length, 0)
console.log(`${Object.keys(imports).length} bare specifiers, ${seen.size} modules, ${(bytes / 1024).toFixed(1)} KiB of source loaded`)
// Inline the map into index.html: import maps must be inline to work in every browser. / import map 必须内联才能在所有浏览器生效。
writeFileSync(new URL('index.html', import.meta.url), `<!doctype html>
<meta charset="utf-8">
<title>TapeAPI browser smoke</title>
<script type="importmap">${JSON.stringify({ imports })}</script>
<pre id="out">running…</pre>
<script type="module" src="./smoke.mjs"></script>
`)
