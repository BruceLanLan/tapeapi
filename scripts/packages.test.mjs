// Publish-readiness of @tapeapi/sdk and @tapeapi/server: package.json fields, exports and types that resolve to real
// files, declarations that name every runtime export, every "@tapeapi/sdk/<subpath>" the repo documents, and the exact
// file list `npm pack` would publish. Network-free.
// 发布就绪检查：package.json 字段、exports 与 types 指向真实文件、声明覆盖全部运行时导出、仓库文档里用到的每个子路径、
// 以及 `npm pack` 将发布的确切文件列表。不联网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, statSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
    assert.deepEqual(pkg.files, dir === 'sdk' ? ['src', 'types', 'bin', 'README.md', 'LICENSE'] : ['src', 'types', 'README.md', 'LICENSE'], 'files whitelist')
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
      assert.ok(/^(src\/[a-z0-9-]+\.js|types\/[a-z0-9-]+\.d\.ts|bin\/tapeapi-(doctor|mcp|verify)\.js|README\.md|LICENSE|package\.json)$/.test(f), `unexpected file in the tarball: ${f}`)
    }
    for (const f of ['package.json', 'README.md', 'LICENSE']) assert.ok(files.includes(f), `${f} is packed`)
    const srcOnDisk = readdirSync(join(ROOT, dir, 'src')).filter((f) => f.endsWith('.js')).map((f) => `src/${f}`)
    for (const f of srcOnDisk) assert.ok(files.includes(f), `${f} is packed`)
    // A guard against packing something by mistake (the file list is checked above), not a performance budget: the tgz
    // is about 300 KB, and a browser loads only the modules it imports. Raised from 1 MiB in 1.2.1 (security, doctor and
    // group format 2 took the SDK to about 1.06 MB). / 防止误打包的护栏（文件清单已在上面逐项检查），不是性能预算：tgz 约
    // 300 KB，浏览器只加载它引用的模块。1.2.1 由 1 MiB 提到 1.5 MiB（安全加固、诊断与群聊格式 2 使 SDK 约 1.06 MB）。
    assert.ok(info.unpackedSize < 1.5 * 1024 * 1024, `unpacked size ${info.unpackedSize} under 1.5 MiB`)
  })

  // 1.6 release integrity: the packed list IS the package.json `files` whitelist (plus package.json), no more and no
  // less, and nothing that must never ship is in it, whatever the whitelist says. A new directory under src/ cannot
  // slip into a tarball, and a file the whitelist promises cannot be left out.
  // 1.6 发布完整性：打包清单恰好等于 package.json 的 `files` 白名单（加 package.json），不多不少；无论白名单怎么写，
  // 不该出现的东西都不能出现。src/ 下新增的目录不会悄悄进入 tarball，白名单承诺的文件也不会漏掉。
  test(`${pkg.name}: the packed list equals the files whitelist, with no test, fixture, env, key, tarball or staging file`, () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: join(ROOT, dir), encoding: 'utf8', env: { ...process.env, npm_config_workspace: '', npm_config_workspaces: '' },
    })
    const packed = JSON.parse(out)[0].files.map((f) => f.path).sort()
    const expected = new Set(['package.json'])
    const walk = (rel) => {
      const abs = join(ROOT, dir, rel)
      if (!statSync(abs).isDirectory()) { expected.add(rel); return }
      for (const n of readdirSync(abs)) if (n !== 'node_modules' && n !== '.DS_Store') walk(`${rel}/${n}`)
    }
    for (const entry of pkg.files) walk(entry)
    assert.deepEqual(packed, [...expected].sort(), 'npm pack --dry-run lists exactly the files whitelist')
    const NEVER = /(^|\/)(node_modules|tests?|fixtures?|\.git|\.github)(\/|$)|\.test\.m?js$|(^|\/)\.env|\.(tgz|key|pem|log|map)$|STAGING-REPORT|\.DS_Store/i
    assert.deepEqual(packed.filter((f) => NEVER.test(f)), [], 'nothing that must never ship')
  })

  // Packing the same tree twice with the same toolchain gives the same bytes: npm stamps every entry with a fixed time
  // (1985-10-26), sorts them, and zeroes owner and group. This catches a build step or a generated file that would
  // make the tarball differ run to run. It does NOT claim the bytes match across Node/npm versions: the tar inside is
  // identical, but the gzip layer is compressor-dependent (Node 22 / npm 10 vs Node 26 / npm 11 measured 2026-10-04:
  // same tar, different .tgz), so the published SHA256SUMS is the checksum of record, not a rebuild. (Node 22.22.3 / npm 10.9.8
  // rebuilt v1.5.0's sdk and server tarballs from a different checkout, byte for byte equal to the published assets.)
  // 同一工具链下对同一棵树打包两次，字节相同：npm 给每个条目写固定时间（1985-10-26）、排序并清零属主。这能抓出让 tarball 每次不同的
  // 构建步骤或生成文件。它不声称跨 Node/npm 版本字节一致：里面的 tar 相同，但 gzip 层取决于压缩器（Node 22 / npm 10 与
  // Node 26 / npm 11 实测：tar 相同、.tgz 不同），所以发布的 SHA256SUMS 才是校验依据，而不是重新构建。
  test(`${pkg.name}: two npm packs of the same tree are byte-identical (same toolchain)`, () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tapeapi-pack-'))
    try {
      const pack = (n) => {
        const to = join(tmp, String(n))
        mkdirSync(to)
        execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', to], {
          cwd: join(ROOT, dir), stdio: 'pipe', env: { ...process.env, npm_config_workspace: '', npm_config_workspaces: '' },
        })
        const [name] = readdirSync(to)
        return readFileSync(join(to, name))
      }
      assert.ok(pack(1).equals(pack(2)), 'the two tarballs differ')
    } finally { rmSync(tmp, { recursive: true, force: true }) }
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
  const m = /^\^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/.exec(range)
  assert.ok(m, `server depends on @tapeapi/sdk by a caret range, got ${range}`)
  const v = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/.exec(PKGS.sdk.version)
  assert.ok(v, `sdk version ${PKGS.sdk.version} is semver`)
  const [maj, min, pat] = v.slice(1, 4).map(Number)
  const [rMaj, rMin, rPat] = m.slice(1, 4).map(Number)
  // A pre-release range (^1.0.0-rc.1) matches pre-releases of that same version only, as npm's semver does: the SDK must
  // be that exact pre-release (we ship the two together). / 预发布范围只匹配同一版本的预发布（与 npm semver 一致）：两包同发，要求完全一致。
  if (m[4] !== undefined || v[4] !== undefined) {
    assert.equal(PKGS.sdk.version, range.slice(1), `@tapeapi/sdk ${PKGS.sdk.version} must be the server's pre-release ${range}`)
    return
  }
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
    ['sdk', 'group', { default: './src/group-public.js', types: './types/group.d.ts' }],
    ['sdk', 'group-delivery', { default: './src/group-delivery.js', types: './types/group-delivery.d.ts' }],
    ['sdk', 'tapesend', { default: './src/tapesend.js', types: './types/tapesend.d.ts' }],
    ['server', '.', PKGS.server.exports['.']],
    ['server', './mcp', PKGS.server.exports['./mcp']],
    ['server', './mcp-proxy', PKGS.server.exports['./mcp-proxy']],
    ['server', './ai-proxy', PKGS.server.exports['./ai-proxy']],
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

// FIXED RC-12 (review 2026-09-29, O P1-9 / F P1-3): `npm i @tapeapi/server` is a 404: neither package is on npm. Tried
// in a scratch project (2026-09-29, npm 10.9.8): the server's tgz alone fails (npm looks up its dependency @tapeapi/sdk in
// the registry: E404), while the SDK's tgz and then the server's tgz from the same release (or both in one command)
// install and import, and `npm ci` from the resulting lock works. So each release carries both files, and the docs say
// to install both, the SDK first. / 单独装 server 的 tgz 会失败（npm 去 registry 找 @tapeapi/sdk）；先装同一发布的 SDK tgz 再装
// server tgz（或一条命令同时装）可行。所以每次发布两个文件都上传，文档写两行安装命令，SDK 在前。
test('FIXED RC-12: the server is installed from the release, after the SDK from the same release, never `npm i @tapeapi/server`', () => {
  const RELEASE = /https:\/\/github\.com\/BruceLanLan\/tapeapi\/releases\/download\/(v[^/]+)\/tapeapi-(sdk|server)-([^/\s]+)\.tgz/g
  const readme = readFileSync(join(ROOT, 'server/README.md'), 'utf8')
  assert.doesNotMatch(readme, /npm (i|install) @tapeapi\/server\b/)
  const install = /## Install\n([\s\S]*?)\n## /.exec(readme)[1]
  const urls = [...install.matchAll(RELEASE)].map((m) => ({ tag: m[1], pkg: m[2], version: m[3] }))
  assert.deepEqual(urls.map((u) => u.pkg), ['sdk', 'server'], 'the SDK first, then the server')
  assert.equal(new Set(urls.map((u) => `${u.tag}/${u.version}`)).size, 1, 'both from one release')
  for (const f of ['docs/guides/mcp.md', 'docs/guides/zh-CN/mcp.md']) {
    const t = readFileSync(join(ROOT, f), 'utf8')
    assert.doesNotMatch(t, /server package has no release file|服务端包也还没有\s*发布文件/, f)
  }
})

// Release integrity (1.6): a tag such as actions/checkout@v4 can be moved by whoever controls that repository, and
// these workflows run with a write-capable token (directory-recheck commits to the public repository). So every
// third-party action is pinned to a 40-hex commit SHA, with the tag it was read from in a comment, and every workflow
// declares its permissions and none runs on pull_request_target. Bumping a pin is a reviewed change.
// 发布完整性（1.6）：actions/checkout@v4 这样的标签可以被该仓库的控制者移动，而这些工作流带着可写的令牌运行（directory-recheck 会
// 向公开仓库提交）。所以每个第三方 action 都钉在 40 位提交 SHA 上，注释里写明它来自哪个标签；每个工作流都声明权限，且没有
// pull_request_target。升级钉住的版本是一次需要审阅的改动。
test('workflows: every action is pinned to a commit SHA, permissions are declared, no pull_request_target', () => {
  const dir = join(ROOT, '.github/workflows')
  const names = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))
  assert.ok(names.length >= 3, 'the scan sees the workflows')
  let pinned = 0
  for (const name of names) {
    const text = readFileSync(join(dir, name), 'utf8')
    assert.match(text, /^permissions:\n  [a-z-]+: (read|write)\b/m, `${name}: top-level permissions are declared`)
    assert.doesNotMatch(text, /pull_request_target/, `${name}: no pull_request_target`)
    for (const m of text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/gm)) {
      if (m[1].startsWith('./')) continue
      assert.match(m[1], /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$/, `${name}: ${m[1]} must be pinned to a commit SHA`)
      assert.match(m[2], /^\s+# v\d+(\.\d+)*\s*$/, `${name}: ${m[1]} carries its tag in a comment`)
      pinned++
    }
  }
  assert.ok(pinned >= 10, `${pinned} pinned uses`)
})
