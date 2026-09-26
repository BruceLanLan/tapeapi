// Every shipped example must boot with no environment at all, exactly as the README quickstart runs it.
// A boot-time validation rule once broke 7 of 10 examples silently because nothing booted them
// (traceability review #3, D19). This test is that missing check.
// 每个示例都必须在零环境变量下启动，与 README 快速上手完全一致。曾有一条启动校验悄悄弄坏了 10 个里的 7 个，
// 因为没有任何测试真的启动它们（TRACEABILITY.md #3）。本测试补上这一环。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const EXAMPLES = fileURLToPath(new URL('..', import.meta.url))
const entries = readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(EXAMPLES, d.name, 'index.mjs')) && existsSync(join(EXAMPLES, d.name, 'manifest.json')))
  .map((d) => d.name)

function boot(name) {
  return new Promise((resolve, reject) => {
    // Only PATH and HOME: no ESCROW, no RPC keys, no delegation / 只给 PATH 与 HOME
    const child = spawn(process.execPath, [join(EXAMPLES, name, 'index.mjs')], {
      cwd: join(EXAMPLES, name),
      env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: '0', HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${name} did not print its manifest URL in 15 s:\n${out}`)) }, 15_000)
    const onData = (b) => {
      out += b
      const m = out.match(/manifest (http:\/\/127\.0\.0\.1:\d+)\/\.well-known\/tapeapi\.json/)
      if (m) { clearTimeout(timer); resolve({ child, base: m[1], out }) }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`${name} exited with ${code} before listening:\n${out}`)) })
  })
}

test('there are examples to boot', () => assert.ok(entries.length >= 8, entries.join(', ')))

for (const name of entries) {
  test(`example ${name} boots with no environment and serves its manifest`, async () => {
    const { child, base } = await boot(name)
    try {
      const res = await fetch(`${base}/.well-known/tapeapi.json`)
      assert.equal(res.status, 200)
      const m = await res.json()
      assert.equal(m.dev, true, 'a no-env boot is a dev manifest')
      assert.ok(m.endpoints.live[0].startsWith(base), `advertised endpoint ${m.endpoints.live[0]} follows the real port`)
      // A priced method without a voucher gets the spec's PAYMENT_REQUIRED, not a crash.
      // 没带凭证调用收费方法，得到规范里的 PAYMENT_REQUIRED，而不是崩溃。
      const priced = m.methods.find((x) => x.priceBEM && x.priceBEM !== '0')
      if (priced) {
        const r = await fetch(`${m.endpoints.live[0]}/${priced.name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'boot', params: {} }) })
        const body = await r.json()
        assert.equal(body.ok, false)
        assert.equal(body.error.code, 'PAYMENT_REQUIRED')
      }
    } finally {
      child.removeAllListeners('exit')
      child.kill('SIGTERM')
    }
  })
}
