#!/usr/bin/env node
// Checksums for a release: the SHA-256 of every *.tgz in a directory, written as SHA256SUMS (GNU coreutils format), and a
// bilingual block to paste into the GitHub Release notes. The packages are installed from release tgz URLs, not from npm,
// so these hashes are the integrity evidence a user can check. Pure Node, no dependencies, no network; it reads the
// directory and writes one file in it.
// 发布校验值：对目录里每个 *.tgz 计算 SHA-256，写成 SHA256SUMS（GNU coreutils 格式），并输出一段可粘贴进 GitHub Release 说明的
// 中英文校验段。两个包从 Release 的 tgz 链接安装、不在 npm 上，所以这些哈希是用户能核对的完整性依据。纯 Node，无依赖，不联网；
// 只读目录，并在其中写一个文件。
//
//   node scripts/release-checksums.mjs <dir>            writes <dir>/SHA256SUMS, prints the release-notes block
//   node scripts/release-checksums.mjs <dir> --no-write  prints only (nothing is written)
//
// Run it on the exact files that `gh release create` uploads, and upload SHA256SUMS with them.
// 对 `gh release create` 要上传的那几个文件运行，并把 SHA256SUMS 一起上传。
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync, lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SUMS_NAME = 'SHA256SUMS'

// The regular *.tgz files directly inside `dir` (not subdirectories, not symlinks), sorted by name in code-point order so
// the output does not depend on the locale. / `dir` 直接包含的普通 *.tgz 文件（不含子目录与符号链接），按码点排序，输出不受区域设置影响。
export function listTarballs(dir) {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.tgz') && lstatSync(join(dir, n)).isFile())
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

// [{ name, sha256 }] for those files. A name with a newline, carriage return or backslash is refused: GNU's format
// escapes those and a pasted line would not mean what it says. / 含换行、回车或反斜杠的文件名一律拒绝：GNU 格式对它们要转义，粘贴出的行会失真。
export function checksums(dir) {
  return listTarballs(dir).map((name) => {
    if (/[\n\r\\]/.test(name)) throw new Error(`refusing a file name that GNU SHA256SUMS would have to escape: ${JSON.stringify(name)}`)
    return { name, sha256: createHash('sha256').update(readFileSync(join(dir, name))).digest('hex') }
  })
}

// `sha256sum` / `shasum -a 256` text-mode lines: <64 hex>, two spaces, <name>, newline. / 文本模式：64 位十六进制、两个空格、文件名、换行。
export const sumsFile = (rows) => rows.map((r) => `${r.sha256}  ${r.name}\n`).join('')

// The block to paste under the release notes, English first (the README is English-first; the Chinese is its twin).
// 粘贴到发布说明里的段落：英文在前（README 英文为先），中文与之对应。
export function notesBlock(rows) {
  return [
    '### Verify the download / 校验下载',
    '',
    'The packages are installed from these release files (they are not on npm), so check them first: put `SHA256SUMS` and the `.tgz` files in one folder and run `shasum -a 256 -c SHA256SUMS` (on Linux, `sha256sum -c SHA256SUMS`). Every line must end in `OK`.',
    '',
    '安装用的是这个 Release 里的文件（不在 npm 上），请先校验：把 `SHA256SUMS` 与 `.tgz` 文件放进同一个文件夹，运行 `shasum -a 256 -c SHA256SUMS`（Linux 用 `sha256sum -c SHA256SUMS`），每一行都必须以 `OK` 结尾。',
    '',
    '```',
    sumsFile(rows).trimEnd(),
    '```',
    '',
  ].join('\n')
}

function main(argv) {
  const args = argv.slice(2)
  const write = !args.includes('--no-write')
  const dirs = args.filter((a) => !a.startsWith('--'))
  const unknown = args.filter((a) => a.startsWith('--') && a !== '--no-write')
  if (dirs.length !== 1 || unknown.length) {
    console.error('usage: node scripts/release-checksums.mjs <directory with the .tgz files> [--no-write]')
    return 2
  }
  const dir = resolve(dirs[0])
  let rows
  try { rows = checksums(dir) } catch (e) { console.error(String(e.message || e)); return 2 }
  if (rows.length === 0) { console.error(`no .tgz file in ${dir}: nothing to checksum`); return 1 }
  if (write) {
    writeFileSync(join(dir, SUMS_NAME), sumsFile(rows))
    console.error(`wrote ${join(dir, SUMS_NAME)} (${rows.length} file${rows.length === 1 ? '' : 's'})`)
  }
  process.stdout.write(notesBlock(rows))
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv)
