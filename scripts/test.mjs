#!/usr/bin/env node
// Run every test file with node --test. The files are listed here rather than globbed: some directories are only in the
// internal repository, and the scripts/ tests are not under a test/ folder. `engines` promises Node >= 22. Extra
// arguments are passed to node --test.
// 用 node --test 运行全部测试文件。在这里列出文件而不用通配：有些目录只在内部仓库里，scripts/ 的测试也不在 test/ 目录下。
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  if (n === 'node_modules' || n.startsWith('.')) return []
  const p = join(dir, n)
  return statSync(p).isDirectory() ? walk(p) : [p]
})
// Some directories are only in the internal repository: they are run when present.
// 有些目录只在内部仓库：存在时才运行。
const files = [
  ...['sdk/test', 'server/test', 'interop/test', 'passport/test', 'policy-circuit/test', 'examples', 'conformance', 'hosting', 'directory'].filter((d) => existsSync(join(root, d))).flatMap((d) => walk(join(root, d))).filter((p) => p.endsWith('.test.mjs')),
  ...readdirSync(join(root, 'scripts')).filter((n) => n.endsWith('.test.mjs')).map((n) => join(root, 'scripts', n)),
].map((p) => relative(root, p)).sort()
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit' })
process.exit(r.status ?? 1)
