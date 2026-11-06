// sign-delegation.mjs without --expires proposes 30 days, as the holder console does since 3.0 (it was 365 days); an
// explicit --expires is used as given (90 days here). Only the typed data is printed: no key, no signature.
// 不给 --expires 时提议 30 天（3.0 起与操作台一致，原为 365 天）；显式给的 --expires 原样使用。只打印待签内容，不用私钥。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./sign-delegation.mjs', import.meta.url))
const ARGS = ['--container', '0x' + '61'.repeat(20), '--signer', '0x' + '62'.repeat(20)]
const run = (extra = []) => {
  const env = { ...process.env }; delete env.HOLDER_KEY; delete env.DELEGATION_EXPIRES; delete env.DELEGATION_SIG
  const r = spawnSync(process.execPath, [SCRIPT, ...ARGS, ...extra], { encoding: 'utf8', env, timeout: 300_000, killSignal: 'SIGKILL' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout).typedData.message.expires
}

test('sign-delegation: 30 days from now by default; an explicit --expires (90 days) is kept', () => {
  const before = Math.floor(Date.now() / 1000)
  const expires = Number(run())
  const after = Math.floor(Date.now() / 1000)
  assert.ok(expires >= before + 30 * 86400 && expires <= after + 30 * 86400, `${expires} is 30 days ahead`)
  const ninety = before + 90 * 86400
  assert.equal(Number(run(['--expires', String(ninety)])), ninety)
})
