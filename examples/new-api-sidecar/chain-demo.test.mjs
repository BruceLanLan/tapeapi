// The local whole-path demo (chain-demo.mjs): fake new-api -> converted price table -> sidecar with FORMATS=openai-chat ->
// manifest on an in-process fake chain -> tapeapi-doctor and the SDK by name, tapeapi-verify, tamper, drift check.
// Every step must pass, and the program exits 0. Loopback only.
// 本地整条路径演示：每一步都必须通过，程序退出码 0。只用回环地址。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runDemo } from './chain-demo.mjs'
import { startFakeNewApi } from './fake-new-api.mjs'

test('chain demo: every step passes, in order', async () => {
  const r = await runDemo()
  assert.deepEqual(r.steps.map((s) => s.step), ['upstream', 'convert', 'sidecar', 'doctor', 'doctor-no-conform', 'sdk-plain', 'sdk-streamed', 'sdk-verifying-fetch', 'tamper', 'format-off', 'verify', 'check'])
  for (const s of r.steps) assert.ok(s.ok, `${s.step}: ${s.text}`)
  assert.equal(r.ok, true)
  // The manifest declares openai-chat only; doctor passed by name on the fake chain. / 清单只声明 openai-chat；doctor 按名字通过。
  assert.match(r.steps.find((s) => s.step === 'sidecar').text, /manifest endpoints \["openai-chat"\]/)
  // FIXED D-1: a format left out is a refusal (HTTP 400 naming FORMATS), not a silent pass-through counted as success.
  // 未启用的格式是拒绝（400，点名 FORMATS），而不是被当成成功的静默透传。
  assert.match(r.steps.find((s) => s.step === 'format-off').text, /HTTP 400, refused by the sidecar naming FORMATS, not forwarded, no receipt/)
  assert.equal(r.report.exitCode, 0)
  assert.equal(r.report.checks.find((c) => c.id === 'endpoints').status, 'pass')
  // The four output-below-input models are the doctor's price hints too. / 四个输出价低于输入价的模型也是 doctor 的价格提示。
  assert.equal((r.report.checks.find((c) => c.id === 'prices').detail.match(/swapped\?/g) || []).length, 4)
})

test('chain demo: runs as a program and exits 0', () => {
  const p = spawnSync(process.execPath, [fileURLToPath(new URL('chain-demo.mjs', import.meta.url))], { encoding: 'utf8' })
  assert.equal(p.status, 0, p.stdout + p.stderr)
  assert.match(p.stdout, /chain demo passed/)
  assert.match(p.stdout, /not which model ran/)
})

test('fake new-api: /api/pricing and /api/status have the shape the converter reads; other paths are 404', async () => {
  const s = await startFakeNewApi()
  try {
    const pricing = await (await fetch(`${s.url}/api/pricing`)).json()
    assert.equal(pricing.success, true); assert.ok(Array.isArray(pricing.data)); assert.equal(typeof pricing.pricing_version, 'string')
    assert.equal((await (await fetch(`${s.url}/api/status`)).json()).data.usd_exchange_rate, 7)
    assert.equal((await fetch(`${s.url}/api/user/self`)).status, 404)
  } finally { await s.close() }
})
