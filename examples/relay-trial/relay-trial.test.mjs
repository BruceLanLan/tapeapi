// The local trial (examples/relay-trial/trial.mjs) runs end to end: the doctor passes against the local sidecar, the
// users' calls verify, tapeapi-verify reports OK, and an altered answer is refused. Everything on 127.0.0.1, free ports.
// 本地试跑端到端运行：诊断对本地旁路通过，用户调用核验通过，tapeapi-verify 报 OK，被改动的回答被拒绝。全部在 127.0.0.1 的空闲端口。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runTrial, missingDependencies } from './trial.mjs'

test('runTrial: every step passes, and the doctor ran its service checks for real', async () => {
  const lines = []
  const r = await runTrial({ say: (s) => lines.push(s), lang: 'en' })
  assert.equal(r.ok, true, lines.join('\n'))
  assert.deepEqual(r.steps.map((s) => s.step), ['doctor', 'call', 'call', 'call', 'verify', 'tamper'])
  for (const id of ['manifest-format', 'delegation', 'ai-field', 'prices', 'endpoints', 'reach', 'cors', 'receipt', 'receipt-lookup']) {
    assert.equal(r.report.checks.find((c) => c.id === id).status, 'pass', id)
  }
  const out = lines.join('\n')
  assert.match(out, /refused \(responseSha256 does not match/)
  assert.match(out, /TapeAPI hosts nothing and pays for nothing/)
})

test('the command exits 0 and prints both languages by default', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./trial.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { out += d })
  const code = await new Promise((ok) => child.on('exit', ok))
  assert.equal(code, 0, out)
  assert.match(out, /The trial passed\./); assert.match(out, /试跑通过。/)
})

test('FIXED ONB2-2: without npm ci the trial says to run it at the repository root, not ERR_MODULE_NOT_FOUND', async () => {
  const e = Object.assign(new Error("Cannot find package '@tapeapi/sdk' imported from trial.mjs"), { code: 'ERR_MODULE_NOT_FOUND' })
  const m = missingDependencies(e)
  assert.match(m, /npm ci --no-audit --no-fund/); assert.match(m, /repository root/); assert.match(m, /仓库根目录/)
  assert.ok(!m.includes('ERR_MODULE_NOT_FOUND'))
  assert.equal(missingDependencies(new Error('something else')), null)
  // the imports that can fail are inside the guard: nothing is imported statically but Node's own modules
  // 可能失败的导入都在保护之内：静态导入的只有 Node 自带模块
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(fileURLToPath(new URL('./trial.mjs', import.meta.url)), 'utf8')
  for (const [, from] of src.matchAll(/^import .* from '([^']+)'/gm)) assert.match(from, /^node:/, from)
})
