// Differential test: the JS evaluator against the TAP-02 reference evaluator the draft vendors (Python, standard library),
// 2,000 beats per example policy with random states (daily-cap's 33 latches included) and words, half of them structured
// near the policies' limits. Runs when python3 is on PATH; otherwise it is skipped, and says so.
// 差分测试：JS 求值器对照草稿附带的 TAP-02 参考求值器（Python 标准库），每个示例策略 2,000 拍，随机状态与请求字（一半贴近上限）。
// 有 python3 时运行，没有则跳过并写明原因。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as pc from '@tapeapi/policy-circuit'

const POLICIES = fileURLToPath(new URL('./vectors/policies/', import.meta.url))
const DRIVER = fileURLToPath(new URL('./policy-circuit-diff-ref.py', import.meta.url))
const probe = spawnSync('python3', ['-I', '-c', 'import sys; print(sys.version_info[:2] >= (3, 9))'], { encoding: 'utf8', timeout: 300_000, killSignal: 'SIGKILL' })
const python = !probe.error && probe.status === 0 && probe.stdout.trim() === 'True'
const PER_POLICY = 2000

test('the JS evaluator agrees with the draft\'s Python TAP-02 reference on 10,000 random beats', { skip: python ? false : 'python3 (3.9+) is not available: the differential test is skipped' }, () => {
  let seed = 84
  const rnd = (n) => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) % n }
  const bytes = (n) => Uint8Array.from({ length: n }, () => rnd(256))
  const hex = (b) => Buffer.from(b).toString('hex')
  const cases = [], mine = []
  for (const name of ['daily-cap', 'allowlist', 'time-window', 'deny-all', 'per-asset-limits']) {
    const c = pc.loadPolicyCircuit(new Uint8Array(readFileSync(POLICIES + name + '.tapnet')))
    for (let i = 0; i < PER_POLICY; i++) {
      const w = bytes(16)
      if (i % 2 === 0) {
        // structured: small amounts and classes, the kinds, a few days, any hour and weekday / 结构化：小金额、类别、种类、几天、任意时与星期
        w.fill(0)
        const amount = rnd(3000)
        w[0] = amount & 255; w[1] = amount >> 8; w[5] = rnd(4); w[6] = rnd(4); w[7] = rnd(8)
        const day = 20750 + rnd(3); w[8] = day & 255; w[9] = day >> 8; w[10] = rnd(24) | (rnd(7) << 5)
        if (rnd(10) === 0) w[4] = 1   // overflow / 溢出位
      }
      const st = bytes(c.stateBytes)
      cases.push({ policy: name, state: hex(st), word: hex(w) })
      const r = c.step(st, w)
      mine.push([hex(r.state), hex(r.outputs)])
    }
  }
  const run = spawnSync('python3', ['-I', DRIVER, POLICIES], { input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 1 << 28, timeout: 300_000, killSignal: 'SIGKILL' })
  assert.equal(run.status, 0, run.stderr)
  const ref = JSON.parse(run.stdout)
  assert.equal(ref.length, cases.length)
  const diffs = cases.map((c, i) => (ref[i][0] === mine[i][0] && ref[i][1] === mine[i][1] ? null : { ...c, ref: ref[i], js: mine[i] })).filter(Boolean)
  assert.deepEqual(diffs.slice(0, 3), [], `${diffs.length} of ${cases.length} beats differ`)
  console.log(`# policy-circuit differential: ${cases.length} beats, 0 differences against the Python TAP-02 reference`)
})
