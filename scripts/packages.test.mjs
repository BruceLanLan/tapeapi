// Publish-readiness of @tapeapi/sdk and @tapeapi/server: package.json fields, exports and types that resolve to real
// files, declarations that name every runtime export, every "@tapeapi/sdk/<subpath>" the repo documents, and the exact
// file list `npm pack` would publish. Network-free.
// 发布就绪检查：package.json 字段、exports 与 types 指向真实文件、声明覆盖全部运行时导出、仓库文档里用到的每个子路径、
// 以及 `npm pack` 将发布的确切文件列表。不联网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJSON = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'))
const PKGS = { sdk: readJSON('sdk/package.json'), server: readJSON('server/package.json') }
const REPO = 'https://github.com/BruceLanLan/tapeapi'

// Every export value is { types, default } (types first, as TypeScript requires) except ./package.json.
const targetsOf = (value) => (typeof value === 'string' ? { default: value } : value)

for (const [dir, pkg] of Object.entries(PKGS)) {
  test(`${pkg.name}: publishable package.json`, () => {
    assert.equal(pkg.private, undefined, 'a published package must not be private')
    assert.deepEqual(pkg.publishConfig, { access: 'public' }, 'scoped packages publish as restricted without access: public')
    assert.match(pkg.name, /^@tapeapi\/(sdk|server)$/)
    assert.match(pkg.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
    assert.equal(pkg.license, 'MIT')
    assert.equal(pkg.type, 'module')
    assert.equal(pkg.author, 'Bruce (@BruceLanLan)')
    assert.equal(pkg.repository?.type, 'git')
    assert.ok(String(pkg.repository?.url).includes('github.com/BruceLanLan/tapeapi.git'), 'repository.url')
    assert.equal(pkg.repository?.directory, dir)
    assert.equal(pkg.homepage, 'https://tapeapi.fun/docs/')
    assert.equal(pkg.bugs?.url, `${REPO}/issues`)
    assert.equal(pkg.engines?.node, '>=20')
    assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.includes('tapeapi'))
    assert.deepEqual(pkg.files, ['src', 'types', 'README.md', 'LICENSE'], 'files whitelist')
    for (const f of ['README.md', 'LICENSE']) assert.ok(existsSync(join(ROOT, dir, f)), `${dir}/${f} must exist inside the package`)
    assert.equal(readFileSync(join(ROOT, dir, 'LICENSE'), 'utf8'), readFileSync(join(ROOT, 'LICENSE'), 'utf8'), `${dir}/LICENSE is a copy of the root LICENSE`)
  })

  test(`${pkg.name}: exports and types resolve to files inside the whitelist`, () => {
    assert.ok(pkg.exports && typeof pkg.exports === 'object')
    assert.ok(existsSync(join(ROOT, dir, pkg.main)), `main ${pkg.main}`)
    assert.ok(existsSync(join(ROOT, dir, pkg.types)), `types ${pkg.types}`)
    assert.equal(targetsOf(pkg.exports['.']).default, pkg.main)
    assert.equal(targetsOf(pkg.exports['.']).types, pkg.types)
    for (const [sub, value] of Object.entries(pkg.exports)) {
      if (sub === './package.json') { assert.equal(value, './package.json'); continue }
      const t = targetsOf(value)
      assert.deepEqual(Object.keys(t), ['types', 'default'], `${sub}: { types, default }, types first`)
      assert.match(t.default, /^\.\/src\/.+\.js$/, `${sub} default`)
      assert.match(t.types, /^\.\/types\/.+\.d\.ts$/, `${sub} types`)
      assert.ok(existsSync(join(ROOT, dir, t.default)), `${sub} -> ${t.default} exists`)
      assert.ok(existsSync(join(ROOT, dir, t.types)), `${sub} -> ${t.types} exists`)
    }
  })

  test(`${pkg.name}: npm pack publishes only src, types, README, LICENSE and package.json`, () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: join(ROOT, dir), encoding: 'utf8', env: { ...process.env, npm_config_workspace: '', npm_config_workspaces: '' },
    })
    const [info] = JSON.parse(out)
    const files = info.files.map((f) => f.path).sort()
    for (const f of files) {
      assert.ok(/^(src\/[a-z0-9-]+\.js|types\/[a-z0-9-]+\.d\.ts|README\.md|LICENSE|package\.json)$/.test(f), `unexpected file in the tarball: ${f}`)
    }
    for (const f of ['package.json', 'README.md', 'LICENSE']) assert.ok(files.includes(f), `${f} is packed`)
    const srcOnDisk = readdirSync(join(ROOT, dir, 'src')).filter((f) => f.endsWith('.js')).map((f) => `src/${f}`)
    for (const f of srcOnDisk) assert.ok(files.includes(f), `${f} is packed`)
    assert.ok(info.unpackedSize < 1024 * 1024, `unpacked size ${info.unpackedSize} under 1 MiB`)
  })
}

test('dependencies: exact @noble versions, server takes the sdk by a range its current version satisfies', () => {
  for (const pkg of Object.values(PKGS)) {
    for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
      if (name.startsWith('@noble/')) assert.match(spec, /^\d+\.\d+\.\d+$/, `${pkg.name}: ${name} pinned exactly, got ${spec}`)
      assert.ok(!/^(file|link|workspace):/.test(spec), `${pkg.name}: ${name} ${spec} cannot be published`)
    }
    assert.equal(pkg.devDependencies, undefined, `${pkg.name}: no devDependencies`)
  }
  // Every @noble import in the SDK source is a declared dependency; the server imports nothing but the SDK.
  const bare = (dir) => readdirSync(join(ROOT, dir, 'src')).flatMap((f) => [...readFileSync(join(ROOT, dir, 'src', f), 'utf8').matchAll(/from '((?:@[^/']+\/)?[^./'][^/']*)/g)].map((m) => m[1]))
  for (const name of new Set(bare('sdk'))) assert.ok(PKGS.sdk.dependencies[name], `sdk imports ${name}: declare it`)
  assert.deepEqual([...new Set(bare('server'))], ['@tapeapi/sdk'])
  assert.deepEqual(Object.keys(PKGS.server.dependencies), ['@tapeapi/sdk'])
  const range = PKGS.server.dependencies['@tapeapi/sdk']
  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range)
  assert.ok(m, `server depends on @tapeapi/sdk by a caret range, got ${range}`)
  const [maj, min, pat] = PKGS.sdk.version.split('.').map(Number)
  const [rMaj, rMin, rPat] = m.slice(1).map(Number)
  // ^0.x.y pins the minor below 1.0.0 / 1.0.0 之前 ^0.x.y 锁定次版本
  const ok = rMaj > 0 ? maj === rMaj && (min > rMin || (min === rMin && pat >= rPat)) : maj === 0 && min === rMin && pat >= rPat
  assert.ok(ok, `@tapeapi/sdk ${PKGS.sdk.version} must satisfy the server's ${range}`)
})

// Names a .d.ts declares as values (types excluded), following `export * as` and `export { } from`.
function declaredValues(file) {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const names = new Set()
  for (const m of text.matchAll(/^export\s+declare\s+(?:function|const|class|let)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1])
  for (const m of text.matchAll(/^export\s+\*\s+as\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1])
  for (const m of text.matchAll(/^export\s+\{([^}]*)\}\s+from/gm)) {
    for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop(); if (n) names.add(n) }
  }
  return names
}

test('declarations name every runtime export of every subpath', async () => {
  const cases = [
    ...Object.entries(PKGS.sdk.exports).filter(([s]) => s !== './package.json').map(([s, v]) => ['sdk', s, v]),
    ['sdk', 'group', { default: './src/group.js', types: './types/group.d.ts' }],
    ['sdk', 'tapesend', { default: './src/tapesend.js', types: './types/tapesend.d.ts' }],
    ['server', '.', PKGS.server.exports['.']],
  ]
  for (const [dir, sub, value] of cases) {
    const runtime = Object.keys(await import(pathToFileURL(join(ROOT, dir, value.default)).href)).sort()
    const declared = declaredValues(join(ROOT, dir, value.types))
    const missing = runtime.filter((n) => !declared.has(n))
    const extra = [...declared].filter((n) => !runtime.includes(n))
    assert.deepEqual(missing, [], `${dir} ${sub}: runtime exports missing from ${value.types}`)
    assert.deepEqual(extra, [], `${dir} ${sub}: ${value.types} declares names the module does not export`)
  }
})

// Every "@tapeapi/sdk/<subpath>" or "@tapeapi/server/<subpath>" in docs, examples, site and READMEs must be exported,
// or a reader copying the snippet gets ERR_PACKAGE_PATH_NOT_EXPORTED once the package comes from npm.
test('every documented @tapeapi/<pkg>/<subpath> import is in the exports map', () => {
  const SKIP = new Set(['node_modules', '.git', 'lib', 'out', 'cache', 'broadcast'])
  const EXT = /\.(m?js|ts|md|html|json)$/
  const found = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (SKIP.has(name)) continue
      const p = join(d, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (EXT.test(name) && st.size < 2 * 1024 * 1024) {
        const text = readFileSync(p, 'utf8')
        for (const m of text.matchAll(/@tapeapi\/(sdk|server)\/([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)/g)) {
          found.push({ pkg: m[1], sub: `./${m[2]}`, where: relative(ROOT, p) })
        }
      }
    }
  }
  for (const d of ['docs', 'examples', 'site', 'sdk', 'server', 'conformance', 'scripts', 'spec']) if (existsSync(join(ROOT, d))) walk(join(ROOT, d))
  for (const f of readdirSync(ROOT)) if (f.endsWith('.md')) {
    for (const m of readFileSync(join(ROOT, f), 'utf8').matchAll(/@tapeapi\/(sdk|server)\/([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)/g)) found.push({ pkg: m[1], sub: `./${m[2]}`, where: f })
  }
  const bad = found.filter(({ pkg, sub }) => !(sub in PKGS[pkg].exports)).map(({ pkg, sub, where }) => `@tapeapi/${pkg}${sub.slice(1)} in ${where}`)
  assert.deepEqual([...new Set(bad)], [])
  assert.ok(found.some((x) => x.sub === './webmcp'), 'the scan sees the documented @tapeapi/sdk/webmcp import')
})
