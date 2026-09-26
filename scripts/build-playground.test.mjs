// The playground (site/playground/) runs the SDK from vendor/, which Pages serves as committed. It must be exactly what
// scripts/build-playground.mjs builds from sdk/src and node_modules, load nothing from another origin, and every import
// in it must resolve. Run `node scripts/build-playground.mjs` after changing the SDK, and commit the result.
// 调试台从 vendor/ 运行 SDK，Pages 按提交的内容提供。它必须与脚本由 sdk/src 和 node_modules 构建的结果完全一致、不从其他来源
// 加载任何东西，且其中每个导入都能解析。改了 SDK 后运行 node scripts/build-playground.mjs 并提交结果。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, posix } from 'node:path'
import { build, importsOf, listFiles, ROOT, OUT, VENDOR, PAGE, MAP_BEGIN, MAP_END } from './build-playground.mjs'

const files = build()
const HAND_WRITTEN = new Set(['playground.css', 'playground.js'])
const page = readFileSync(join(ROOT, OUT, PAGE), 'utf8')
const importMap = () => {
  const m = /<script type="importmap">([^]*?)<\/script>/.exec(page)
  assert.ok(m, 'index.html has an import map')
  return JSON.parse(m[1]).imports
}

test('build-playground: the committed vendor/ and import map are exactly a fresh build (run node scripts/build-playground.mjs)', () => {
  for (const [p, content] of files) {
    const path = join(ROOT, OUT, p)
    assert.ok(existsSync(path), `${OUT}/${p} is missing: run node scripts/build-playground.mjs`)
    assert.equal(readFileSync(path, 'utf8'), content, `${OUT}/${p} is stale: run node scripts/build-playground.mjs`)
  }
  for (const p of listFiles(join(ROOT, OUT))) {
    assert.ok(files.has(p) || HAND_WRITTEN.has(p), `${OUT}/${p} is not produced by the build`)
  }
})

test('build-playground: the vendored SDK is sdk/src byte for byte, and the whole of what index.js imports', () => {
  const sdk = [...files.keys()].filter((p) => p.startsWith(`${VENDOR}/tapeapi-sdk/`) && p.endsWith('.js'))
  assert.ok(sdk.includes(`${VENDOR}/tapeapi-sdk/index.js`))
  for (const p of sdk) assert.equal(files.get(p), readFileSync(join(ROOT, 'sdk/src', posix.basename(p)), 'utf8'), p)
  for (const p of files.keys()) {
    if (!p.endsWith('.js')) continue
    assert.doesNotMatch(files.get(p), /from\s*['"]node:|\brequire\s*\(/, `${p}: Node-only code in the browser bundle`)
    assert.doesNotMatch(files.get(p), /sourceMappingURL=/, `${p}: points at a source map that is not vendored`)
  }
})

test('build-playground: licenses travel with the code', () => {
  for (const dir of ['tapeapi-sdk', 'noble-hashes', 'noble-curves', 'noble-ciphers']) {
    const lic = files.get(`${VENDOR}/${dir}/LICENSE`)
    assert.ok(lic && /MIT License|Permission is hereby granted/.test(lic), `${VENDOR}/${dir}/LICENSE`)
  }
  assert.match(files.get(`${VENDOR}/noble-hashes/utils.js`), /noble-hashes - MIT License/)
  assert.match(files.get(`${VENDOR}/noble-curves/abstract/weierstrass.js`), /noble-curves - MIT License/)
})

test('build-playground: every import of every module resolves to a vendored file', () => {
  const imports = importMap()
  const modules = [...files.keys()].filter((p) => p.endsWith('.js')).concat('playground.js')
  const read = (p) => files.get(p) ?? readFileSync(join(ROOT, OUT, p), 'utf8')
  let checked = 0
  for (const p of modules) {
    for (const spec of importsOf(read(p))) {
      let target
      if (spec.startsWith('./') || spec.startsWith('../')) target = posix.normalize(posix.join(posix.dirname(p), spec))
      else {
        assert.ok(Object.hasOwn(imports, spec), `${p}: bare import ${spec} is not in the import map`)
        target = posix.normalize(imports[spec])
      }
      assert.ok(files.has(target) || existsSync(join(ROOT, OUT, target)), `${p}: ${spec} -> ${target} does not exist`)
      checked++
    }
  }
  assert.ok(checked > 50, `only ${checked} imports found: the import parser is missing statements`)
  for (const [spec, to] of Object.entries(imports)) {
    assert.match(to, /^\.\/vendor\//, `import map entry ${spec} must point into ./vendor/`)
    assert.ok(files.has(posix.normalize(to)), `import map entry ${spec} -> ${to} does not exist`)
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

test('build-playground: the page loads nothing from another origin (DeWEB SPEC 8)', () => {
  const external = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i
  for (const [, tag, url] of page.matchAll(/<(script|link|img|iframe|source|video|audio)\b[^>]*?\s(?:src|href)="([^"]*)"/gi)) {
    assert.ok(!external.test(url), `index.html: <${tag}> loads ${url}`)
  }
  const importAt = page.indexOf('<script type="importmap">'), moduleAt = page.indexOf('<script type="module"')
  assert.ok(importAt > 0 && moduleAt > importAt, 'the import map comes before the first module script')
  assert.ok(page.indexOf(MAP_BEGIN) < importAt && page.indexOf(MAP_END) > importAt, 'the import map sits between the markers')
  const css = readFileSync(join(ROOT, OUT, 'playground.css'), 'utf8')
  assert.doesNotMatch(css, /@import|url\(\s*['"]?(?:[a-z]+:|\/\/)/i, 'playground.css loads nothing')
  for (const spec of importsOf(readFileSync(join(ROOT, OUT, 'playground.js'), 'utf8'))) {
    assert.ok(spec.startsWith('./'), `playground.js imports ${spec}: only local modules`)
  }
})
