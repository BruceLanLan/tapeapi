// The playground (site/playground/) runs the SDK from vendor/<hash>/, which Pages serves as committed. It must be exactly
// what scripts/build-playground.mjs builds from sdk/src and node_modules, load nothing from another origin, and every
// import in it must resolve. The directory is named by a hash of its content, so a changed file is a new URL and a cache
// can never pair two releases; every page that loads the tree points at that one directory. Run
// `node scripts/build-playground.mjs` after changing the SDK, and commit the result.
// 调试台从 vendor/<hash>/ 运行 SDK，Pages 按提交的内容提供。它必须与脚本由 sdk/src 和 node_modules 构建的结果完全一致、
// 不从其他来源加载任何东西，且其中每个导入都能解析。目录以内容哈希命名：文件变了网址就变，缓存不可能把两次发版混在一起；
// 加载这棵树的每个页面都指向这唯一的目录。改了 SDK 后运行 node scripts/build-playground.mjs 并提交结果。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, posix } from 'node:path'
import {
  build, graph, vendorTree, vendorHash, importsOf, listFiles, retarget, sitePages,
  ROOT, SITE, OUT, VENDOR, PAGE, MAP_BEGIN, MAP_END, HASH_LEN,
} from './build-playground.mjs'

const { files, hash } = build()
const DIR = `${VENDOR}/${hash}`                       // playground/vendor/<hash>, relative to site/
const HAND_WRITTEN = new Set(['playground/playground.css'])
const readSite = (p) => readFileSync(join(ROOT, SITE, p), 'utf8')
const page = readSite(PAGE)
const importMap = () => {
  const m = /<script type="importmap">([^]*?)<\/script>/.exec(page)
  assert.ok(m, 'index.html has an import map')
  return JSON.parse(m[1]).imports
}

test('build-playground: the committed vendor/ and every page that loads it are exactly a fresh build (run node scripts/build-playground.mjs)', () => {
  for (const [p, content] of files) {
    const path = join(ROOT, SITE, p)
    assert.ok(existsSync(path), `${SITE}/${p} is missing: run node scripts/build-playground.mjs`)
    assert.equal(readFileSync(path, 'utf8'), content, `${SITE}/${p} is stale: run node scripts/build-playground.mjs`)
  }
  for (const p of listFiles(join(ROOT, SITE, OUT)).map((f) => `${OUT}/${f}`)) {
    assert.ok(files.has(p) || HAND_WRITTEN.has(p), `${SITE}/${p} is not produced by the build`)
  }
  // The pages that load the tree are among the outputs, so a stale path in any of them fails above.
  // 加载这棵树的页面都在输出里，任何一个里的旧路径都会在上面失败。
  for (const p of ['playground/index.html', 'playground/playground.js', 'verify/index.html', 'verify/verify.js', 'verify/lib.js', 'dashboard/index.html', 'dashboard/dashboard.js', 'dashboard/lib.js']) {
    assert.ok(files.has(p), `${p} is rewritten by the build`)
  }
})

test('build-playground: vendor/ holds exactly one directory, named by the content hash of the tree', () => {
  assert.match(hash, new RegExp(`^[0-9a-f]{${HASH_LEN}}$`))
  assert.deepEqual(readdirSync(join(ROOT, SITE, VENDOR)), [hash], 'old directories are removed: run node scripts/build-playground.mjs')
  const tree = new Map([...files].filter(([p]) => p.startsWith(`${DIR}/`)).map(([p, c]) => [p.slice(DIR.length + 1), c]))
  assert.equal(vendorHash(tree), hash, 'the name is the hash of what is in it')
  for (const p of files.keys()) {
    if (p.startsWith(`${VENDOR}/`)) assert.ok(p.startsWith(`${DIR}/`), `${p}: every vendored file is under vendor/${hash}/`)
  }
})

// The fix for a cache that pairs a new index.js with an old ai.js: any change to any vendored file must move the whole tree.
// 针对缓存把新 index.js 配旧 ai.js 的问题：任何 vendor 文件的任何改动都必须让整棵树换目录。
test('build-playground: changing any SDK file (or any vendored file, or a path) changes the directory name', () => {
  const g = graph()
  const sdkSources = [...g.files.keys()].filter((p) => p.startsWith('sdk/src/'))
  assert.ok(sdkSources.length >= 20, `only ${sdkSources.length} SDK files in the graph`)
  const real = (p) => readFileSync(join(ROOT, p), 'utf8')
  const seen = new Set([hash])
  // Through the whole build, as a release would: one SDK file gains a byte. / 走完整的构建，像发版一样：一个 SDK 文件多一个字节。
  for (const src of sdkSources) {
    const changed = build({ read: (p) => (p === src ? `${real(p)} ` : real(p)) })
    assert.notEqual(changed.hash, hash, `${src} changed but vendor/${hash}/ kept its name`)
    assert.ok(!seen.has(changed.hash), `${src}: two different trees share the name ${changed.hash}`)
    seen.add(changed.hash)
    for (const [p, content] of changed.files) {
      if (/\.(?:js|html)$/.test(p) && !p.startsWith(`${VENDOR}/`)) {
        assert.doesNotMatch(content, new RegExp(`vendor/${hash}/`), `${p} still points at the old directory after ${src} changed`)
      }
    }
  }
  // Every other vendored file (the @noble code, the licenses), a single byte flipped in place, and a renamed path.
  // 其余每个 vendor 文件（@noble 代码、许可证）、原地改一个字节、以及改名。
  const tree = vendorTree(g)
  for (const [p, content] of tree) {
    const flipped = content.slice(0, -1) + (content.at(-1) === '\n' ? '\r' : '\n')
    assert.notEqual(vendorHash(new Map(tree).set(p, flipped)), hash, `${p}: a changed byte must change the name`)
  }
  const renamed = new Map([...tree].map(([p, c]) => [p === 'tapeapi-sdk/ai.js' ? 'tapeapi-sdk/ai2.js' : p, c]))
  assert.notEqual(vendorHash(renamed), hash, 'a renamed file must change the name')
})

test('build-playground: the vendored SDK is sdk/src byte for byte, and the whole of what index.js imports', () => {
  const sdk = [...files.keys()].filter((p) => p.startsWith(`${DIR}/tapeapi-sdk/`) && p.endsWith('.js'))
  assert.ok(sdk.includes(`${DIR}/tapeapi-sdk/index.js`))
  for (const p of sdk) assert.equal(files.get(p), readFileSync(join(ROOT, 'sdk/src', posix.basename(p)), 'utf8'), p)
  for (const p of sdk) assert.equal(readSite(p), readFileSync(join(ROOT, 'sdk/src', posix.basename(p)), 'utf8'), `${p} on disk`)
  assert.equal(sdk.length, [...graph().files.keys()].filter((p) => p.startsWith('sdk/src/')).length)
  for (const p of files.keys()) {
    if (!p.startsWith(`${VENDOR}/`) || !p.endsWith('.js')) continue
    assert.doesNotMatch(files.get(p), /from\s*['"]node:|\brequire\s*\(/, `${p}: Node-only code in the browser bundle`)
    assert.doesNotMatch(files.get(p), /sourceMappingURL=/, `${p}: points at a source map that is not vendored`)
  }
})

test('build-playground: the vendored @noble files are the installed package files, byte for byte (less a source-map line)', () => {
  let n = 0
  for (const [src, dest] of graph().files) {
    if (!src.startsWith('node_modules/')) continue
    const orig = readFileSync(join(ROOT, src), 'utf8')
    assert.equal(readSite(`${DIR}/${dest}`), orig.replace(/\n?\/\/# sourceMappingURL=[^\n]*\n?$/, '\n'), dest)
    n++
  }
  assert.ok(n >= 20, `only ${n} @noble files`)
})

test('build-playground: licenses travel with the code', () => {
  for (const dir of ['tapeapi-sdk', 'noble-hashes', 'noble-curves', 'noble-ciphers']) {
    const lic = files.get(`${DIR}/${dir}/LICENSE`)
    assert.ok(lic && /MIT License|Permission is hereby granted/.test(lic), `${DIR}/${dir}/LICENSE`)
  }
  assert.match(files.get(`${DIR}/noble-hashes/utils.js`), /noble-hashes - MIT License/)
  assert.match(files.get(`${DIR}/noble-curves/abstract/weierstrass.js`), /noble-curves - MIT License/)
})

test('build-playground: every import of every module resolves to a vendored file', () => {
  const imports = importMap()
  const modules = [...files.keys()].filter((p) => p.startsWith(`${VENDOR}/`) && p.endsWith('.js')).concat('playground/playground.js')
  const read = (p) => files.get(p) ?? readSite(p)
  let checked = 0
  for (const p of modules) {
    for (const s of importsOf(read(p))) {
      const spec = s.replace(/\?v=[0-9a-f]{10}$/, '')
      let target
      if (spec.startsWith('./') || spec.startsWith('../')) target = posix.normalize(posix.join(posix.dirname(p), spec))
      else {
        assert.ok(Object.hasOwn(imports, spec), `${p}: bare import ${spec} is not in the import map`)
        target = posix.normalize(posix.join(OUT, imports[spec]))
      }
      assert.ok(files.has(target) || existsSync(join(ROOT, SITE, target)), `${p}: ${spec} -> ${target} does not exist`)
      checked++
    }
  }
  assert.ok(checked > 50, `only ${checked} imports found: the import parser is missing statements`)
  for (const [spec, to] of Object.entries(imports)) {
    assert.ok(to.startsWith(`./vendor/${hash}/`), `import map entry ${spec} must point into ./vendor/${hash}/`)
    assert.ok(files.has(posix.normalize(posix.join(OUT, to))), `import map entry ${spec} -> ${to} does not exist`)
  }
})

// One module, one URL: every page reaches every vendored module under the same site path, inside the one directory.
// 同一模块只有一个网址：每个页面都经同一个站点路径、在唯一的目录里拿到每个 vendor 模块。
test('build-playground: across the playground, the verify page and the dashboard, each module has exactly one URL', () => {
  const mapOf = (file) => JSON.parse(/<script type="importmap">([^]*?)<\/script>/.exec(readSite(file))[1]).imports
  const urls = new Map()   // path under the vendor directory -> set of site paths it was loaded from
  for (const [pageFile, entry] of [['playground/index.html', 'playground/playground.js'], ['verify/index.html', 'verify/verify.js'], ['dashboard/index.html', 'dashboard/dashboard.js']]) {
    const map = mapOf(pageFile)
    const seen = new Set()
    const walk = (file) => {
      if (seen.has(file)) return
      seen.add(file)
      const m = /^playground\/vendor\/([^/]+)\/(.+)$/.exec(file)
      if (m) {
        assert.equal(m[1], hash, `${pageFile} loads ${file}, outside vendor/${hash}/`)
        if (!urls.has(m[2])) urls.set(m[2], new Set())
        urls.get(m[2]).add(file)
      }
      for (const s of importsOf(readSite(file))) {
        const spec = s.replace(/\?v=[0-9a-f]{10}$/, '')
        const target = spec.startsWith('./') || spec.startsWith('../')
          ? posix.normalize(posix.join(posix.dirname(file), spec))
          : posix.normalize(posix.join(posix.dirname(pageFile), map[spec] ?? assert.fail(`${file}: ${spec} is not in ${pageFile}'s import map`)))
        assert.ok(existsSync(join(ROOT, SITE, target)), `${file}: ${spec} -> ${target} does not exist`)
        walk(target)
      }
    }
    walk(entry)
    assert.ok(seen.has(`${DIR}/tapeapi-sdk/index.js`), `${pageFile} loads the SDK`)
  }
  assert.ok(urls.size > 40, `only ${urls.size} vendored modules reached`)
  for (const [mod, from] of urls) assert.equal(from.size, 1, `${mod} is loaded under ${[...from].join(' and ')}`)
})

test('build-playground: nothing under site/ (outside the generated docs) points at a vendor directory other than the current one', () => {
  for (const f of sitePages()) {
    const text = readSite(f)
    assert.equal(retarget(text, hash), text, `${f} points at an old vendor path: run node scripts/build-playground.mjs`)
  }
})

test('build-playground: the import parser ignores examples in comments and reads multi-line imports', () => {
  const code = [
    '/**', ' * import { ed25519 } from \'@noble/curves/ed25519\';', ' */',
    "import {\n  a,\n  b,\n} from './abi.js'",
    "export * as sig from './sig.js'",
    "import './side-effect.js'",
    "export const x = typeof globalThis === 'object'",
    "  // import { nope } from './comment.js'",
  ].join('\n')
  assert.deepEqual(importsOf(code), ['./abi.js', './sig.js', './side-effect.js'])
})

test('build-playground: retarget rewrites only paths into a package directory, old hash or none, and is idempotent', () => {
  const h = 'abcdef0123'
  assert.equal(retarget("from './vendor/tapeapi-sdk/index.js'", h), `from './vendor/${h}/tapeapi-sdk/index.js'`)
  assert.equal(retarget('"../playground/vendor/0123456789/noble-hashes/utils.js"', h), `"../playground/vendor/${h}/noble-hashes/utils.js"`)
  assert.equal(retarget(retarget('vendor/noble-curves/x.js', h), h), `vendor/${h}/noble-curves/x.js`)
  assert.equal(retarget('vendored under vendor/. and (../playground/vendor/)', h), 'vendored under vendor/. and (../playground/vendor/)')
})

test('build-playground: the page loads nothing from another origin (DeWEB SPEC 8)', () => {
  const external = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i
  for (const [, tag, url] of page.matchAll(/<(script|link|img|iframe|source|video|audio)\b[^>]*?\s(?:src|href)="([^"]*)"/gi)) {
    assert.ok(!external.test(url), `index.html: <${tag}> loads ${url}`)
  }
  const importAt = page.indexOf('<script type="importmap">'), moduleAt = page.indexOf('<script type="module"')
  assert.ok(importAt > 0 && moduleAt > importAt, 'the import map comes before the first module script')
  assert.ok(page.indexOf(MAP_BEGIN) < importAt && page.indexOf(MAP_END) > importAt, 'the import map sits between the markers')
  const css = readSite('playground/playground.css')
  assert.doesNotMatch(css, /@import|url\(\s*['"]?(?:[a-z]+:|\/\/)/i, 'playground.css loads nothing')
  for (const spec of importsOf(readSite('playground/playground.js'))) {
    assert.ok(spec.startsWith('./'), `playground.js imports ${spec}: only local modules`)
  }
})
