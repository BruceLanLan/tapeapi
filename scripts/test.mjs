#!/usr/bin/env node
// Run every test file with node --test. Node 20's test runner does not expand ** globs (Node 22 does), so the files are
// listed here; `engines` promises Node >= 20. Extra arguments are passed to node --test.
// 用 node --test 运行全部测试文件。Node 20 的测试运行器不展开 ** 通配（Node 22 才支持），所以在这里列出文件。
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
// hosting/ is only in the internal repository until it ships; so is directory/ (the provider directory draft).
// hosting/ 上线前只在内部仓库；directory/（服务方目录草稿）也是。
const files = [
  ...['sdk/test', 'server/test', 'examples', 'conformance', 'hosting', 'directory'].filter((d) => existsSync(join(root, d))).flatMap((d) => walk(join(root, d))).filter((p) => p.endsWith('.test.mjs')),
  ...readdirSync(join(root, 'scripts')).filter((n) => n.endsWith('.test.mjs')).map((n) => join(root, 'scripts', n)),
].map((p) => relative(root, p)).sort()
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit' })
process.exit(r.status ?? 1)
