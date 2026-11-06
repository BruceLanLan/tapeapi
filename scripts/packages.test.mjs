// Publish-readiness of @tapeapi/sdk, @tapeapi/server, @tapeapi/interop, @tapeapi/passport and @tapeapi/policy-circuit: package.json fields, exports and types that resolve to real
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
// interop (3.0 candidate): the visitor grants, a package of their own next to the SDK (experimental; never an SDK release).
// interop（3.0 候选）：访客授权，SDK 旁边的独立包（实验性；从未随 SDK 发布）。
// passport (3.0 candidate): the Agent Passport resolver, a package of its own (experimental, follows the open TAPs #83
// draft at cae25e6; its own version, 0.x, not the SDK's). / passport（3.0 候选）：Agent 护照解析，独立包（实验性，依据未合并的
// TAPs #83 草案；有自己的 0.x 版本号，不随 SDK 的版本号）。
// policy-circuit (3.0 candidate): policy circuits after the Policy Circuit Gate TAP draft (TAPs #84, not merged), a package of
// its own at its own version (0.1.0, experimental), never part of an SDK release.
// policy-circuit（3.0 候选）：按 Policy Circuit Gate TAP 草稿（TAPs #84，未合并）的策略电路，独立包、独立版本（0.1.0，实验性），从不随 SDK 发布。
const PKGS = { sdk: readJSON('sdk/package.json'), server: readJSON('server/package.json'), interop: readJSON('interop/package.json'), passport: readJSON('passport/package.json'), 'policy-circuit': readJSON('policy-circuit/package.json') }
const REPO = 'https://github.com/BruceLanLan/tapeapi'

// Every export value is { types, default } (types first, as TypeScript requires) except ./package.json.
const targetsOf = (value) => (typeof value === 'string' ? { default: value } : value)

for (const [dir, pkg] of Object.entries(PKGS)) {
  test(`${pkg.name}: publishable package.json`, () => {
    assert.equal(pkg.private, undefined, 'a published package must not be private')
    assert.deepEqual(pkg.publishConfig, { access: 'public' }, 'scoped packages publish as restricted without access: public')
    assert.equal(pkg.name, `@tapeapi/${dir}`)
    assert.match(pkg.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
    assert.equal(pkg.license, 'MIT')
    assert.equal(pkg.type, 'module')
    assert.equal(pkg.author, 'Bruce (@BruceLanLan)')
    assert.equal(pkg.repository?.type, 'git')
    assert.ok(String(pkg.repository?.url).includes('github.com/BruceLanLan/tapeapi.git'), 'repository.url')
    assert.equal(pkg.repository?.directory, dir)
    assert.equal(pkg.homepage, 'https://tapeapi.fun/docs/')
    assert.equal(pkg.bugs?.url, `${REPO}/issues`)
    assert.equal(pkg.engines?.node, '>=22')
    // FIXED N9: `node --test test` takes the directory for a module on Node 22 (MODULE_NOT_FOUND); the glob is quoted so
    // node, not the shell, expands it, on sh and cmd alike. / N9：Node 22 把 `node --test test` 当成模块（MODULE_NOT_FOUND）；
    // 通配加了引号，由 node 而不是 shell 展开，sh 与 cmd 都一样。
    assert.equal(pkg.scripts?.test, 'node --test "test/*.test.mjs"', 'npm test in the package')
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
      timeout: 300_000, killSignal: 'SIGKILL',
    })
    const [info] = JSON.parse(out)
    const files = info.files.map((f) => f.path).sort()
    for (const f of files) {
      assert.ok(/^(src\/[a-z0-9-]+\.js|types\/[a-z0-9-]+\.d\.ts|bin\/tapeapi(-(doctor|mcp|verify))?\.js|README\.md|LICENSE|package\.json)$/.test(f), `unexpected file in the tarball: ${f}`)
    }
    for (const f of ['package.json', 'README.md', 'LICENSE']) assert.ok(files.includes(f), `${f} is packed`)
    const srcOnDisk = readdirSync(join(ROOT, dir, 'src')).filter((f) => f.endsWith('.js')).map((f) => `src/${f}`)
    for (const f of srcOnDisk) assert.ok(files.includes(f), `${f} is packed`)
    // A guard against packing something by mistake (the file list is checked above), not a performance budget: the tgz
    // is about 300 KB, and a browser loads only the modules it imports. Raised from 1 MiB in 1.2.1 (security, doctor and
    // group format 2 took the SDK to about 1.06 MB). / 防止误打包的护栏（文件清单已在上面逐项检查），不是性能预算：tgz 约
    // 300 KB，浏览器只加载它引用的模块。1.2.1 由 1 MiB 提到 1.5 MiB（安全加固、诊断与群聊格式 2 使 SDK 约 1.06 MB）。
    // Raised again from 1.5 MiB to 1.75 MiB (1,835,008 bytes): 1.7 / 1.8 added the agent subpath and the escrow token
    // reads, and the unpacked size was at 1,570,928 of 1,572,864, about 1.9 KB short of the old limit. Comments and
    // features stay; the limit moves. / 再由 1.5 MiB 提到 1.75 MiB（1,835,008 字节）：1.7 / 1.8 增加了 agent 子路径与托管代币读取，
    // 解包后 1,570,928 字节，离原上限 1,572,864 只剩约 1.9 KB。注释与功能保留，调整的是上限。
    // Raised from 1.75 MiB to 2 MiB (2,097,152 bytes) on the internal phase-1 branch: the key vault and the spend
    // limiter's restart took the unpacked size from 1,809,793 to 1,837,096, 2 KB over the old limit. The same reasoning:
    // a guard, not a budget. / 内部阶段 1 分支上由 1.75 MiB 提到 2 MiB：钥匙保险箱与限额器的重启恢复使解包大小由 1,809,793
    // 增至 1,837,096，超出原上限 2 KB。理由同上：护栏，不是预算。
    // The experimental USD pricing of the payment-voucher TAP draft (usd-pricing.js and its types, about 30 KB) needed the
    // same raise on its branch (1,840,007 bytes); merged, both sit under 2 MiB. / 付费凭证草稿的实验性美元计价在其分支上同样需要提到 2 MiB。
    // Raised from 2 MiB to 2.25 MiB (2,359,296 bytes) for 2.1.0: the `tapeapi` command and `tapeapi connect` (bin/tapeapi.js,
    // src/connect.js, src/connect-cli.js, types/connect.d.ts) are a real new feature, and with them the unpacked size is
    // 2,078,664 bytes, 18,488 bytes (under 20 KB) short of the old limit, so the next small change would trip it. This
    // test exists to catch an accidental bloat (a stray directory, a fixture, a bundle), which the file list above
    // already pins file by file; it is still a guard, not a budget. / 2.1.0 由 2 MiB 提到 2.25 MiB（2,359,296 字节）：
    // `tapeapi` 命令与 `tapeapi connect` 是真实的新功能，加上之后解包 2,078,664 字节，离原上限只剩 18,488 字节（不足 20 KB），
    // 下一个小改动就会撞线。本测试防的是意外膨胀（误打包的目录、夹具、打包产物），上面的文件清单已逐个钉住；仍是护栏，不是预算。
    // Raised from 2.25 MiB to 2.5 MiB (2,621,440 bytes) in 2.5.0: 2.4.0 packs 2,304,644 bytes; the
    // billing-layer helpers (2,311,911), MCP 2026-07-28 (2,309,633) and the reconcile checks (2,350,724) each stay under
    // the old limit alone, and merged they pack 2,362,980 bytes, 3,684 over. Real features, no stray file (the whitelist
    // test below still pins every file); the same reasoning: a guard, not a budget. / 2.5.0 中由 2.25 MiB 提到
    // 2.5 MiB：2.4.0 解包 2,304,644 字节；计费层辅助、MCP 2026-07-28、对账检查三条线各自都在原上限以内，合并后 2,362,980 字节，
    // 超出 3,684 字节。都是真实功能，没有误打包的文件（下面的白名单测试仍逐个钉住）；理由同上：护栏，不是预算。
    // During the 3.0 work, the experimental interop subpath (then sdk/src/interop-*.js, types/interop.d.ts; held back
    // from 2.1 to 2.4) joined it and the unpacked size was 2,474,871 bytes, still under this limit; the same reasoning. /
    // 3.0 开发期间先放回 2.1 至 2.4 扣下的实验性 interop 子路径，解包 2,474,871 字节，仍在此上限以内；理由同上。
    // Then the client-side budget (budget.js, policy.js, statement-cli.js) and the phase 1 close-out / session scan took it
    // to 2,579,392 bytes, 42,048 under this limit; the same reasoning. /
    // 随后客户端预算（budget.js、policy.js、statement-cli.js）与阶段 1 的分步收尾、会话扫描使解包为 2,579,392 字节，距上限 42,048；理由同上。
    // With the review fixes (budget, interop, agent kit) on 2.5.0: 2,609,940 bytes, 11,500 under this limit; not raised. /
    // 在 2.5.0 之上加入预算、互通、代理工具包的评审修复后：解包 2,609,940 字节，距上限 11,500；护栏未提高。
    // Then the interop code moved out to its own package, @tapeapi/interop (107,354 bytes unpacked; never in an SDK release):
    // the SDK packs 2,507,479 bytes, 113,961 under this limit, which is unchanged. / 随后 interop 代码移到独立包 @tapeapi/interop
    // （解包 107,354 字节；从未随 SDK 发布）：SDK 解包 2,507,479 字节，距上限 113,961；护栏不变。
    // With the experimental x402-batch backend (prototype) and the receiptRef / priceRef proposal merged, the SDK packs
    // 2,561,058 bytes, 60,382 under this limit, which is unchanged. / 并入 x402-batch 原型与 receiptRef / priceRef 提案后，
    // SDK 解包 2,561,058 字节，距上限 60,382；护栏不变。
    // 3.0 candidate: api.chain.processorNumber (1,464 bytes) and the passport command lines (tapeapi passport, doctor /
    // connect / init --passport: passport-cli.js, passport-view.js and the glue, 27,388 bytes) take the SDK to
    // 2,591,374 bytes, 30,066 under this limit, which is unchanged; the resolver itself is @tapeapi/passport. Measured
    // again before 3.0.0 (npm pack --dry-run, 2026-10-29): 2,593,875 bytes, 27,565 under this limit; not raised. /
    // 3.0 候选：processorNumber 与护照命令行部分使 SDK 解包为 2,591,374 字节，距上限 30,066；护栏不变，解析器本身在 @tapeapi/passport。
    // 3.0.0 之前重测（npm pack --dry-run，2026-10-29）：2,593,875 字节，距上限 27,565；护栏未提高。
    // Raised from 2.5 MiB to 3 MiB (3,145,728 bytes) for 3.0.0: at 2,593,875 bytes the margin was 27,565, so the next
    // small feature or comment would trip it; nothing is packed by mistake (the whitelist above still pins every file),
    // and moving the passport command text out to @tapeapi/passport would save only about 8 to 20 KB. The same
    // reasoning: a guard, not a budget. / 3.0.0 由 2.5 MiB 提到 3 MiB（3,145,728 字节）：2,593,875 字节时只剩 27,565，
    // 下一个小功能或注释就会撞线；没有误打包的文件（上面的白名单仍逐个钉住），把护照命令文字移到 @tapeapi/passport 也只省约
    // 8 至 20 KB。理由同上：护栏，不是预算。
    assert.ok(info.unpackedSize < 3 * 1024 * 1024, `unpacked size ${info.unpackedSize} under 3 MiB`)
    // The passport package has a guard of its own (132,063 bytes unpacked at 0.1.0, measured 2026-10-29): the draft's
    // vectors (880,934 bytes) must never be packed. / 护照包自己的护栏（0.1.0 解包 132,063 字节，2026-10-29 实测）：草案向量（880,934 字节）绝不能被打包。
    if (dir === 'passport') assert.ok(info.unpackedSize < 192 * 1024, `passport unpacked size ${info.unpackedSize} under 192 KiB`)
    // policy-circuit has a guard of its own: 113,302 bytes unpacked at 0.1.0 (38,617 packed; measured 2026-10-29); the SDK's guard is untouched.
    // The vendored vectors (118,460 bytes), the five .tapnet files and the Python reference stay in test/ and are never packed.
    // policy-circuit 有自己的护栏：0.1.0 解包 113,302 字节（2026-10-29 实测）；SDK 的护栏不变。测试向量、.tapnet 与 Python 参考实现只在 test/，从不打包。
    if (dir === 'policy-circuit') {
      assert.ok(info.unpackedSize < 160 * 1024, `policy-circuit unpacked size ${info.unpackedSize} under 160 KiB`)
      assert.deepEqual(files.filter((f) => /\.(json|tapnet|py)$/.test(f) && f !== 'package.json'), [], 'no vector, policy file or Python reference in the tarball')
    }
  })

  // 1.6 release integrity: the packed list IS the package.json `files` whitelist (plus package.json), no more and no
  // less, and nothing that must never ship is in it, whatever the whitelist says. A new directory under src/ cannot
  // slip into a tarball, and a file the whitelist promises cannot be left out.
  // 1.6 发布完整性：打包清单恰好等于 package.json 的 `files` 白名单（加 package.json），不多不少；无论白名单怎么写，
  // 不该出现的东西都不能出现。src/ 下新增的目录不会悄悄进入 tarball，白名单承诺的文件也不会漏掉。
  test(`${pkg.name}: the packed list equals the files whitelist, with no test, fixture, env, key, tarball or staging file`, () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: join(ROOT, dir), encoding: 'utf8', env: { ...process.env, npm_config_workspace: '', npm_config_workspaces: '' },
      timeout: 300_000, killSignal: 'SIGKILL',
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
          timeout: 300_000, killSignal: 'SIGKILL',
        })
        const [name] = readdirSync(to)
        return readFileSync(join(to, name))
      }
      assert.ok(pack(1).equals(pack(2)), 'the two tarballs differ')
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  })
}

test('dependencies: exact @noble versions, server and interop take the sdk by a range its current version satisfies', () => {
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
  // interop imports the SDK's public entries and @noble/hashes, both declared, the @noble pin the SDK's own.
  // interop 只导入 SDK 的公开入口与 @noble/hashes，二者都已声明，@noble 的版本与 SDK 的相同。
  assert.deepEqual([...new Set(bare('interop'))].sort(), ['@noble/hashes', '@tapeapi/sdk'])
  assert.deepEqual(Object.keys(PKGS.interop.dependencies).sort(), ['@noble/hashes', '@tapeapi/sdk'])
  assert.equal(PKGS.interop.dependencies['@noble/hashes'], PKGS.sdk.dependencies['@noble/hashes'])
  assert.equal(PKGS.interop.dependencies['@tapeapi/sdk'], PKGS.server.dependencies['@tapeapi/sdk'], 'interop and server take the same SDK range')
  // policy-circuit imports the SDK's public entries and @noble/hashes, as interop does; its version is its own (0.1.0).
  // policy-circuit 与 interop 一样只导入 SDK 的公开入口与 @noble/hashes；版本独立（0.1.0）。
  const pcPkg = PKGS['policy-circuit']
  assert.deepEqual([...new Set(bare('policy-circuit'))].sort(), ['@noble/hashes', '@tapeapi/sdk'])
  assert.deepEqual(Object.keys(pcPkg.dependencies).sort(), ['@noble/hashes', '@tapeapi/sdk'])
  assert.equal(pcPkg.dependencies['@noble/hashes'], PKGS.sdk.dependencies['@noble/hashes'])
  assert.equal(pcPkg.dependencies['@tapeapi/sdk'], PKGS.server.dependencies['@tapeapi/sdk'], 'policy-circuit and server take the same SDK range')
  assert.equal(pcPkg.version, '0.1.0', 'policy-circuit is versioned on its own (experimental)')
  // 3.0: interop has its own version too, 0.x (experimental, never in an SDK release), attached to the same release.
  // 3.0：interop 也用自己的版本号 0.x（实验性，从未随 SDK 发布），tgz 挂在同一个发布上。
  assert.match(PKGS.interop.version, /^0\.\d+\.\d+$/, 'interop is versioned on its own, 0.x (experimental)')
  // passport: the same imports and pins as interop, but a version of its own (0.x while the draft is a pull request), and
  // the draft head and vectors SHA-256 it follows recorded in package.json. / passport：导入与钉住同 interop，版本号独立。
  assert.deepEqual([...new Set(bare('passport'))].sort(), ['@noble/hashes', '@tapeapi/sdk'])
  assert.deepEqual(Object.keys(PKGS.passport.dependencies).sort(), ['@noble/hashes', '@tapeapi/sdk'])
  assert.equal(PKGS.passport.dependencies['@noble/hashes'], PKGS.sdk.dependencies['@noble/hashes'])
  assert.equal(PKGS.passport.dependencies['@tapeapi/sdk'], PKGS.server.dependencies['@tapeapi/sdk'], 'passport and server take the same SDK range')
  assert.match(PKGS.passport.version, /^0\.\d+\.\d+$/, 'passport stays 0.x while its draft is an open pull request')
  assert.deepEqual(PKGS.passport.tapeapi?.draft, { repo: 'TapeOutProtocol/TAPs', pr: 83, head: 'cae25e6df54ad2e2e38e185304de55f92792966d', vectorsSha256: '7720772c05d60062f48daa7c1d2ab6f45affc3d05425126d9de9b00a4ff8fca4' })
  assert.equal(PKGS.server.version, PKGS.sdk.version, 'the SDK and the server are released together, at one version (the release tag)')
  const range = PKGS.server.dependencies['@tapeapi/sdk']
  const m = /^\^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/.exec(range)
  assert.ok(m, `server depends on @tapeapi/sdk by a caret range, got ${range}`)
  const v = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/.exec(PKGS.sdk.version)
  assert.ok(v, `sdk version ${PKGS.sdk.version} is semver`)
  const [maj, min, pat] = v.slice(1, 4).map(Number)
  const [rMaj, rMin, rPat] = m.slice(1, 4).map(Number)
  // A pre-release range (^1.0.0-rc.1, or ^3.0.0-0 for every 3.0.0 pre-release) matches pre-releases of that same
  // version only, as npm's semver does; caretSatisfies below follows it (R30B-11: an RC needs the range widened first).
  // 预发布范围只匹配同一版本的预发布（与 npm semver 一致），由下面的 caretSatisfies 判断（R30B-11：发 RC 要先放宽范围）。
  if (m[4] !== undefined || v[4] !== undefined) {
    assert.ok(caretSatisfies(PKGS.sdk.version, range), `@tapeapi/sdk ${PKGS.sdk.version} must satisfy the server's pre-release range ${range}`)
    return
  }
  // ^0.x.y pins the minor below 1.0.0 / 1.0.0 之前 ^0.x.y 锁定次版本
  const ok = rMaj > 0 ? maj === rMaj && (min > rMin || (min === rMin && pat >= rPat)) : maj === 0 && min === rMin && pat >= rPat
  assert.ok(ok, `@tapeapi/sdk ${PKGS.sdk.version} must satisfy the server's ${range}`)
})

// R30B-11: does `version` satisfy the caret range `range`, as npm's semver decides it (no includePrerelease)? A small
// local copy of the rule (semver is not a dependency): a pre-release version matches only a range whose own version is
// a pre-release of the same major.minor.patch, and is not lower than it; `^3.0.0` does not match `3.0.0-rc.1`, `^3.0.0-0`
// does. / version 是否满足插入号范围 range（与 npm semver 相同，不含 includePrerelease）。semver 不是依赖，这里是一份小的本地实现：
// 预发布版本只匹配"自身也是同一 major.minor.patch 的预发布、且不高于它"的范围；`^3.0.0` 不匹配 `3.0.0-rc.1`，`^3.0.0-0` 匹配。
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
function comparePre(a, b) {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1   // a release is above its pre-releases
  const x = a.split('.'), y = b.split('.')
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1
    if (y[i] === undefined) return 1
    const nx = /^\d+$/.test(x[i]), ny = /^\d+$/.test(y[i])
    if (nx && ny && Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]) ? -1 : 1
    if (nx !== ny) return nx ? -1 : 1          // numeric identifiers sort below alphanumeric ones
    if (!nx && x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  }
  return 0
}
function caretSatisfies(version, range) {
  const v = SEMVER_RE.exec(String(version)), r = /^\^(.+)$/.exec(String(range))
  const b = r && SEMVER_RE.exec(r[1])
  if (!v || !b) return false
  const [vt, bt] = [v.slice(1, 4).map(Number), b.slice(1, 4).map(Number)]
  const sameTuple = vt.every((n, i) => n === bt[i])
  if (v[4] !== undefined && !(sameTuple && b[4] !== undefined)) return false
  const cmp = (vt[0] - bt[0]) || (vt[1] - bt[1]) || (vt[2] - bt[2]) || comparePre(v[4], b[4])
  if (cmp < 0) return false
  // the upper bound: the first non-zero of major, minor, patch is kept / 上界：major、minor、patch 中第一个非零的保持不变
  if (bt[0] > 0) return vt[0] === bt[0]
  if (bt[1] > 0) return vt[0] === 0 && vt[1] === bt[1]
  return vt[0] === 0 && vt[1] === 0 && vt[2] === bt[2]
}

test('R30B-11: caretSatisfies follows npm semver for caret ranges, pre-releases included', () => {
  const yes = [['3.0.0', '^3.0.0'], ['3.2.1', '^3.0.0'], ['3.0.0-rc.1', '^3.0.0-0'], ['3.0.0-rc.1', '^3.0.0-rc.1'], ['3.0.0-rc.2', '^3.0.0-rc.1'],
    ['3.0.0-rc.10', '^3.0.0-rc.9'], ['3.0.0-beta', '^3.0.0-alpha'], ['3.0.0', '^3.0.0-0'], ['3.4.0', '^3.0.0-0'], ['0.1.5', '^0.1.0'], ['0.0.3', '^0.0.3']]
  const no = [['3.0.0-rc.1', '^3.0.0'], ['3.1.0-rc.1', '^3.0.0-0'], ['3.0.0-rc.1', '^3.0.0-rc.2'], ['3.0.0-1', '^3.0.0-alpha'], ['4.0.0', '^3.0.0'],
    ['2.9.9', '^3.0.0'], ['4.0.0-0', '^3.0.0-0'], ['0.2.0', '^0.1.0'], ['0.0.4', '^0.0.3'], ['3.0.0', '~3.0.0'], ['3.0', '^3.0.0'], ['3.0.0', '^3']]
  for (const [v, r] of yes) assert.equal(caretSatisfies(v, r), true, `${v} satisfies ${r}`)
  for (const [v, r] of no) assert.equal(caretSatisfies(v, r), false, `${v} does not satisfy ${r}`)
})

// R30B-11: a 3.x RC is internal only unless every package that depends on the SDK accepts it: with the SDK at a
// pre-release, a range such as ^3.0.0 does not match, and npm would go to the registry for @tapeapi/sdk (a 404, or
// whatever someone else published under that name). A 3.x RC stays internal unless every package that depends on the SDK accepts it. / 3.x 的 RC 只在内部用，除非每个依赖 SDK
// 的包都接受它：SDK 是预发布时，^3.0.0 之类的范围不匹配，npm 会去 registry 找 @tapeapi/sdk。
test('R30B-11: when the SDK is a pre-release, the server and every 0.x package take it by a range that matches it', () => {
  const sdk = PKGS.sdk.version
  const ranges = Object.entries(PKGS).filter(([dir]) => dir !== 'sdk').map(([dir, p]) => [dir, p.dependencies?.['@tapeapi/sdk']])
  assert.deepEqual(ranges.map(([dir]) => dir), ['server', 'interop', 'passport', 'policy-circuit'])
  for (const [dir, range] of ranges) {
    assert.equal(typeof range, 'string', `${dir} depends on @tapeapi/sdk`)
    assert.ok(caretSatisfies(sdk, range), `${dir}: @tapeapi/sdk ${range} does not match the SDK's ${sdk}; ${SEMVER_RE.exec(sdk)?.[4] ? `a pre-release needs the range widened first (for example ^${sdk.replace(/-.*/, '')}-0), or the RC stays internal` : 'the same release must satisfy it'}`)
  }
  // The same check on what an RC would look like, so the rule is exercised even while the SDK is a release.
  // 用 RC 的样子再查一遍，即使 SDK 现在是正式版，这条规则也被执行到。
  assert.equal(caretSatisfies('3.0.0-rc.1', '^3.0.0'), false, 'today\'s ranges would not take an RC')
  assert.equal(caretSatisfies('3.0.0-rc.1', '^3.0.0-0'), true, 'widened, they would')
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
    ['interop', '.', PKGS.interop.exports['.']],
    ['passport', '.', PKGS.passport.exports['.']],
    ['passport', './feedback', PKGS.passport.exports['./feedback']],
    ['policy-circuit', '.', PKGS['policy-circuit'].exports['.']],
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
  // Frozen on purpose: the published visitor-grant vector file must stay byte-identical, and its note names the SDK subpath
  // the code had before it became @tapeapi/interop; the test that rebuilds the file carries the same string.
  // 有意不改：已发布的访客授权向量文件须逐字节不变，其 note 仍写代码成为 @tapeapi/interop 之前的 SDK 子路径；重建它的测试带着同一字符串。
  const FROZEN = new Set(['spec/vectors/interop-visitor-grant.json', 'interop/test/interop.test.mjs'])
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (SKIP.has(name)) continue
      const p = join(d, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (EXT.test(name) && st.size < 2 * 1024 * 1024) {
        const text = readFileSync(p, 'utf8')
        for (const m of text.matchAll(/@tapeapi\/(sdk|server|interop|passport|policy-circuit)\/([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)/g)) {
          const where = relative(ROOT, p)
          if (FROZEN.has(where) && m[0] === ['@tapeapi', 'sdk', 'interop'].join('/')) continue   // written so that this file does not match itself
          found.push({ pkg: m[1], sub: `./${m[2]}`, where })
        }
      }
    }
  }
  for (const d of ['docs', 'examples', 'site', 'sdk', 'server', 'interop', 'passport', 'policy-circuit', 'conformance', 'scripts', 'spec']) if (existsSync(join(ROOT, d))) walk(join(ROOT, d))
  for (const f of readdirSync(ROOT)) if (f.endsWith('.md')) {
    for (const m of readFileSync(join(ROOT, f), 'utf8').matchAll(/@tapeapi\/(sdk|server|interop|passport|policy-circuit)\/([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)/g)) found.push({ pkg: m[1], sub: `./${m[2]}`, where: f })
  }
  const bad = found.filter(({ pkg, sub }) => !(sub in PKGS[pkg].exports)).map(({ pkg, sub, where }) => `@tapeapi/${pkg}${sub.slice(1)} in ${where}`)
  assert.deepEqual([...new Set(bad)], [])
  assert.ok(found.some((x) => x.sub === './webmcp'), 'the scan sees the documented @tapeapi/sdk/webmcp import')
})

// spec/proposals/ is not in the public copy, so nothing that ships may send a reader there: the
// packed files of every package and the public vectors name a proposal in words (3.0.0 rehearsal: the receipt-reference
// proposal was cited by file in sdk, server and spec/vectors). / spec/proposals/ 不进公开副本，所以发布的文件与公开向量不得指向它。
test('nothing that ships cites a file under spec/proposals/ (not in the public copy)', () => {
  const hits = []
  const scan = (p) => {
    if (statSync(p).isDirectory()) { for (const name of readdirSync(p)) if (name !== 'node_modules') scan(join(p, name)) }
    else if (/\.(m?js|ts|json|py|md)$/.test(p) && readFileSync(p, 'utf8').includes('spec/proposals/')) hits.push(relative(ROOT, p))
  }
  for (const [dir, pkg] of Object.entries(PKGS)) for (const f of [...pkg.files, 'package.json']) if (existsSync(join(ROOT, dir, f))) scan(join(ROOT, dir, f))
  scan(join(ROOT, 'spec/vectors'))
  assert.deepEqual([...new Set(hits)], [])
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

// The same rule for interop, passport and policy-circuit (3.0): each depends on @tapeapi/sdk, so it is never installed by
// name from npm; its README names the SDK's tgz first, then its own, from the same release. From 3.0 a release has one
// tag, the SDK's (and the server's) version, and these three hang on it with their own version in the file name
// (`v3.0.0/tapeapi-interop-0.1.0.tgz`), as the release tooling writes and checks them; so
// "one release" means one tag, not one version. `installProblems` lists what is wrong with an Install section.
// 同样的规则用于 interop、passport、policy-circuit（3.0）：都依赖 @tapeapi/sdk，从不按名字从 npm 安装；README 先写同一发布的
// SDK tgz，再写本包的。3.0 起一次发布只有一个标签（SDK 与 server 的版本），这三个包挂在它上面、文件名用自己的版本
// （`v3.0.0/tapeapi-interop-0.1.0.tgz`），与发布工具写入与核对的规则相同；所以"同一发布"是同一个标签，不是同一个版本号。
const RELEASE_URL = /https:\/\/github\.com\/BruceLanLan\/tapeapi\/releases\/download\/v([^/\s]+)\/tapeapi-(sdk|server|interop|passport|policy-circuit)-([^/\s]+?)\.tgz/g
const TAGGED = new Set(['sdk', 'server'])   // released at the tag's version / 按标签版本发布
function installProblems(install, pkg, versions = { sdk: PKGS.sdk.version, [pkg]: PKGS[pkg].version }) {
  const urls = [...install.matchAll(RELEASE_URL)].map((m) => ({ tag: m[1], pkg: m[2], version: m[3] }))
  if (!urls.length) return ['no release address']
  const out = []
  if (urls[0].pkg !== 'sdk') out.push('the SDK first')
  if (!urls.some((u) => u.pkg === pkg)) out.push(`the ${pkg} tgz is named`)
  const tags = new Set(urls.map((u) => u.tag))
  if (tags.size !== 1) out.push(`all from one release, one tag (${[...tags].map((t) => `v${t}`).join(', ')})`)
  if (!tags.has(versions.sdk)) out.push(`the tag is the SDK's version, v${versions.sdk}`)
  for (const u of urls) {
    const want = TAGGED.has(u.pkg) ? u.tag : versions[u.pkg]
    if (u.version !== want) out.push(`tapeapi-${u.pkg}-${u.version}.tgz on v${u.tag}: its file name carries ${want ?? 'its own version'}`)
  }
  return out
}
const installOf = (pkg) => {
  const readme = readFileSync(join(ROOT, `${pkg}/README.md`), 'utf8')
  assert.doesNotMatch(readme, new RegExp(String.raw`npm (i|install) @tapeapi\/${pkg}\b`))
  const install = /## Install\n([\s\S]*?)\n## /.exec(readme)[1]
  assert.doesNotMatch(install, /Not in a release yet|npm ci/, `${pkg}/README.md: it ships in the release from 3.0.0`)
  assert.match(install, /[Ee]xperimental and outside the compatibility promise/, `${pkg}/README.md`)
  return install
}

// The release-day README of the 3.0.0 rehearsal (2026-10-29), which the old `${tag}/${version}` check refused; and the
// mistakes the rule must still catch. / 3.0.0 彩排时按规则改好的 README（旧的 `${tag}/${version}` 判断把它判为失败），
// 以及规则仍须抓住的错误。
test('installProblems: the 3.0 install lines (one tag, the 0.x package under its own version) pass; a wrong address fails', () => {
  const V = { sdk: '3.0.0', interop: '0.1.0', passport: '0.1.0', 'policy-circuit': '0.1.0' }
  const at = (tag, pkg, v) => `npm install ${REPO}/releases/download/v${tag}/tapeapi-${pkg}-${v}.tgz`
  const section = (...lines) => `Experimental.\n\n\`\`\`bash\n${lines.join('\n')}\n\`\`\`\n`
  for (const pkg of ['interop', 'passport', 'policy-circuit']) {
    assert.deepEqual(installProblems(section(at('3.0.0', 'sdk', '3.0.0'), at('3.0.0', pkg, '0.1.0')), pkg, V), [], pkg)
  }
  const bad = (pkg, ...lines) => installProblems(section(...lines), pkg, V)
  assert.match(bad('interop', at('3.0.0', 'sdk', '3.0.0'), at('3.0.0', 'interop', '3.0.0')).join(), /tapeapi-interop-3\.0\.0\.tgz on v3\.0\.0: its file name carries 0\.1\.0/, 'the 2.x form')
  assert.match(bad('interop', at('3.0.0', 'sdk', '3.0.0'), at('2.5.0', 'interop', '0.1.0')).join(), /one tag \(v3\.0\.0, v2\.5\.0\)/, 'two releases')
  assert.match(bad('passport', at('3.0.0', 'passport', '0.1.0'), at('3.0.0', 'sdk', '3.0.0')).join(), /the SDK first/)
  assert.match(bad('passport', at('3.0.0', 'sdk', '3.0.0')).join(), /the passport tgz is named/)
  assert.match(bad('policy-circuit', at('3.0.1', 'sdk', '3.0.1'), at('3.0.1', 'policy-circuit', '0.1.0')).join(), /the tag is the SDK's version, v3\.0\.0/, 'a tag other than sdk/package.json')
  assert.match(bad('policy-circuit', at('3.0.0', 'sdk', '3.0.1'), at('3.0.0', 'policy-circuit', '0.1.0')).join(), /tapeapi-sdk-3\.0\.1\.tgz on v3\.0\.0/, 'the SDK under another version than its tag')
  assert.deepEqual(installProblems('Not in a release yet.\n', 'interop', V), ['no release address'])
})

test('interop: installed from a release after the SDK of the same release, never `npm i @tapeapi/interop`', () => {
  assert.deepEqual(installProblems(installOf('interop'), 'interop'), [])
})

test('passport: installed from a release after the SDK of the same release, never `npm i @tapeapi/passport`; the vectors stay a test fixture', () => {
  assert.deepEqual(installProblems(installOf('passport'), 'passport'), [])
  // The passport guide (en, zh-CN) gives the same two lines. / 护照指南（中英）给出同样的两行。
  for (const [f, head] of [['docs/guides/passport.md', 'Install'], ['docs/guides/zh-CN/passport.md', '安装']]) {
    const install = new RegExp(`## ${head}\\n([\\s\\S]*?)\\n## `).exec(readFileSync(join(ROOT, f), 'utf8'))[1]
    assert.deepEqual(installProblems(install, 'passport'), [], f)
    assert.doesNotMatch(install, /not in a release|npm ci|还没有进入|检出/, f)
  }
  assert.ok(existsSync(join(ROOT, 'passport/test/fixtures/vectors.json')), 'the vectors are a fixture of the tests')
  assert.ok(!PKGS.passport.files.some((f) => /test|fixture/.test(f)))
})

test('policy-circuit: installed from a release after the SDK of the same release, never `npm i @tapeapi/policy-circuit`', () => {
  assert.deepEqual(installProblems(installOf('policy-circuit'), 'policy-circuit'), [])
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
