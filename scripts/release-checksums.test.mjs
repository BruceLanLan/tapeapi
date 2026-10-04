// scripts/release-checksums.mjs: SHA-256 of every *.tgz in a directory as GNU SHA256SUMS, plus the bilingual release-notes
// block. Fake tarballs in a temporary directory; no network.
// scripts/release-checksums.mjs：对目录里每个 *.tgz 计算 SHA-256，写成 GNU 格式的 SHA256SUMS，并给出中英文发布说明段落。
// 用临时目录里的假 tgz，不联网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { checksums, sumsFile, notesBlock, listTarballs } from './release-checksums.mjs'

const SCRIPT = fileURLToPath(new URL('./release-checksums.mjs', import.meta.url))
const sha = (s) => createHash('sha256').update(s).digest('hex')
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' // SHA-256("abc"), FIPS 180-2 example
const tmp = () => mkdtempSync(join(tmpdir(), 'tapeapi-sums-'))
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })

test('hashes are SHA-256 of the file bytes, listed by name in code-point order', () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'tapeapi-sdk-1.6.0.tgz'), 'abc')
    writeFileSync(join(dir, 'tapeapi-server-1.6.0.tgz'), Buffer.from([0, 255, 1, 2, 3]))
    writeFileSync(join(dir, 'B-upper.tgz'), 'x')
    const rows = checksums(dir)
    assert.deepEqual(rows.map((r) => r.name), ['B-upper.tgz', 'tapeapi-sdk-1.6.0.tgz', 'tapeapi-server-1.6.0.tgz'], 'uppercase sorts before lowercase, whatever the locale')
    assert.equal(rows[1].sha256, ABC)
    assert.equal(rows[2].sha256, sha(Buffer.from([0, 255, 1, 2, 3])))
    assert.equal(sumsFile(rows), `${sha('x')}  B-upper.tgz\n${ABC}  tapeapi-sdk-1.6.0.tgz\n${rows[2].sha256}  tapeapi-server-1.6.0.tgz\n`)
    for (const line of sumsFile(rows).trimEnd().split('\n')) assert.match(line, /^[0-9a-f]{64} {2}[^ \n]+\.tgz$/, 'GNU text-mode line: hash, two spaces, name')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('files that are not release tarballs are ignored: other extensions, subdirectories, symlinks, SHA256SUMS itself', () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'tapeapi-sdk-1.6.0.tgz'), 'abc')
    writeFileSync(join(dir, 'README.md'), 'not a tarball')
    writeFileSync(join(dir, 'tapeapi-sdk-1.6.0.tar'), 'tar, not tgz')
    writeFileSync(join(dir, 'tapeapi-sdk-1.6.0.tgz.asc'), 'signature file')
    writeFileSync(join(dir, 'notes.TGZ'), 'wrong case')
    writeFileSync(join(dir, 'SHA256SUMS'), 'stale')
    mkdirSync(join(dir, 'nested.tgz'))
    writeFileSync(join(dir, 'nested.tgz', 'inner.tgz'), 'inside a directory')
    symlinkSync(join(dir, 'tapeapi-sdk-1.6.0.tgz'), join(dir, 'link.tgz'))
    assert.deepEqual(listTarballs(dir), ['tapeapi-sdk-1.6.0.tgz'])
    assert.deepEqual(checksums(dir), [{ name: 'tapeapi-sdk-1.6.0.tgz', sha256: ABC }])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an empty directory has no checksums, and the command fails without writing anything', () => {
  const dir = tmp()
  try {
    assert.deepEqual(checksums(dir), [])
    writeFileSync(join(dir, 'README.md'), 'only a non-tarball')
    const r = run(dir)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /no \.tgz file/)
    assert.equal(r.stdout, '')
    assert.deepEqual(readdirSync(dir), ['README.md'], 'SHA256SUMS was not created')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the command writes SHA256SUMS and prints the bilingual block; a second run gives the same file', () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'tapeapi-sdk-1.6.0.tgz'), 'abc')
    writeFileSync(join(dir, 'tapeapi-server-1.6.0.tgz'), 'def')
    const r = run(dir)
    assert.equal(r.status, 0, r.stderr)
    const file = readFileSync(join(dir, 'SHA256SUMS'), 'utf8')
    assert.equal(file, `${ABC}  tapeapi-sdk-1.6.0.tgz\n${sha('def')}  tapeapi-server-1.6.0.tgz\n`)
    assert.equal(r.stdout, notesBlock(checksums(dir)))
    for (const needle of ['shasum -a 256 -c SHA256SUMS', 'sha256sum -c SHA256SUMS', '校验', 'Verify', '不在 npm 上', 'not on npm', ABC, sha('def')]) assert.ok(r.stdout.includes(needle), `block mentions ${needle}`)
    assert.ok(r.stdout.endsWith('```\n'), 'ends with the fenced hash list')
    assert.equal(run(dir).status, 0)
    assert.equal(readFileSync(join(dir, 'SHA256SUMS'), 'utf8'), file, 'SHA256SUMS never lists itself, so a rerun is identical')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('--no-write prints the block and writes nothing; bad usage exits 2', () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'a.tgz'), 'abc')
    const r = run(dir, '--no-write')
    assert.equal(r.status, 0)
    assert.ok(r.stdout.includes(`${ABC}  a.tgz`))
    assert.equal(existsSync(join(dir, 'SHA256SUMS')), false)
    assert.equal(run().status, 2)
    assert.equal(run(dir, dir).status, 2)
    assert.equal(run(dir, '--nope').status, 2)
    assert.equal(run(join(dir, 'does-not-exist')).status, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a file name GNU would have to escape is refused', () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'back\\slash.tgz'), 'abc')
    assert.throws(() => checksums(dir), /escape/)
    assert.equal(run(dir).status, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// The reader's side: the file this script writes is what `shasum -a 256 -c` (or sha256sum -c) accepts, and a changed byte fails.
// 读者这一侧：本脚本写出的文件能被 `shasum -a 256 -c`（或 sha256sum -c）接受，改一个字节就失败。
test('the written SHA256SUMS passes the system checker, and a tampered file fails it', (t) => {
  const probe = spawnSync('shasum', ['-a', '256', '--version'], { encoding: 'utf8' })
  const [cmd, args] = probe.status === 0 ? ['shasum', ['-a', '256', '-c', 'SHA256SUMS']] : ['sha256sum', ['-c', 'SHA256SUMS']]
  if (spawnSync(cmd, ['--version'], { encoding: 'utf8' }).error) { t.skip('neither shasum nor sha256sum is installed'); return }
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'tapeapi-sdk-1.6.0.tgz'), Buffer.alloc(100000, 7))
    writeFileSync(join(dir, 'tapeapi-server-1.6.0.tgz'), 'second file')
    assert.equal(run(dir).status, 0)
    const ok = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8' })
    assert.equal(ok.status, 0, ok.stdout + ok.stderr)
    assert.equal((ok.stdout.match(/: OK$/gm) || []).length, 2)
    writeFileSync(join(dir, 'tapeapi-server-1.6.0.tgz'), 'second filE')
    const bad = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8' })
    assert.notEqual(bad.status, 0)
    assert.match(bad.stdout, /tapeapi-server-1\.6\.0\.tgz: FAILED/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
