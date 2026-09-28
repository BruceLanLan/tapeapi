// FIXED RC-8 (review 2026-09-29, O P1-5): the "run it locally" examples of docs/guides/provide.md (both languages) and
// server/README.md, run as written against a local dev manifest (an http endpoint, no delegation). Since G1 S2 a
// manifest's own `dev` field switches nothing, so without `dev: true` in the code they failed with MANIFEST_INVALID
// "endpoint must be https". Each block runs in its own process, from a temporary directory holding manifest.json; only
// the port is changed (0: any free port), and lines are appended that print the port and close the server.
// FIXED RC-8：provide.md（中英）与 server/README.md 的本地运行示例按原文、对本地 dev 清单运行。S2 之后清单自己的 dev 字段不起作用，
// 代码里不写 dev: true 就报 MANIFEST_INVALID。每段代码在独立进程里、从放着 manifest.json 的临时目录运行，只改端口。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { privateKeyToAddress } from '../../sdk/src/sig.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const KEY = '0x' + '42'.repeat(32)
const MANIFEST = {
  tapeapi: '0.1', name: 'Local test', circuits: '0x' + '00'.repeat(20), tokenId: '0', container: '0x' + '00'.repeat(20), signer: privateKeyToAddress(KEY),
  delegation: null, endpoints: { live: ['http://127.0.0.1:8787/tapeapi/v1'], async: false },
  payment: { escrow: '0x' + '00'.repeat(20), unit: 'BEM', decimals: 8 },
  dev: true,   // as in examples/reader-service/manifest.json / 与示例清单相同
}
const firstJs = (file) => /```js\n([\s\S]*?)```/.exec(readFileSync(join(ROOT, file), 'utf8'))[1]

for (const file of ['docs/guides/provide.md', 'docs/guides/zh-CN/provide.md', 'server/README.md']) {
  test(`FIXED RC-8: the local-run example of ${file} starts as written on a dev manifest`, () => {
    const code = firstJs(file)
    assert.match(code, /createProvider\(/)
    assert.match(code, /await provider\.listen\(8787\)/)
    const dir = mkdtempSync(join(tmpdir(), 'tapeapi-rc8-'))
    try {
      symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'))
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
      // the methods the example implements; one of them priced, as a reader's would be / 示例实现的方法，其中一个收费
      const names = [...code.matchAll(/(\w+): async \(/g)].map((m) => m[1])
      const methods = names.map((name, i) => ({ name, priceBEM: i ? '0.0001' : '0', params: {}, returns: {} }))
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...MANIFEST, methods }))
      const run = code.replace('await provider.listen(8787)', 'const server = await provider.listen(0)') +
        '\nconsole.log("STARTED", server.address().port)\nserver.close()\n'
      writeFileSync(join(dir, 'run.mjs'), run)
      const r = spawnSync(process.execPath, ['run.mjs'], { cwd: dir, env: { ...process.env, SIGNER_KEY: KEY }, encoding: 'utf8', timeout: 30_000 })
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /STARTED \d+/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}
