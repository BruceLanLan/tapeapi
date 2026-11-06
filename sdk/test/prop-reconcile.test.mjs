// Property: tapeapi reconcile's matching (reconcile-cli.js `reconcile`, pure) counts exactly what was constructed. Each
// iteration builds N receipt/bill pairs that agree, then applies random damage whose effect is known in advance:
//   a bill row dropped        -> its receipt is missing on the bill side (receipts-only)
//   a receipt dropped         -> its row is missing on the receipt side (bill-only)
//   a row's tokens edited beyond the tolerance, or its model renamed -> mismatch (matched by id, with the difference)
//   a row's tokens edited within the tolerance -> still a match
//   a row without its id      -> matched by time, model and tokens (basis time-model-tokens)
//   a receipt repeated        -> counted once, as a duplicate
// Every pair has its own model, so a row whose receipt was dropped cannot fall onto another receipt by time. A second
// property drops that: one model, rows without ids, receipts spaced wider than twice the window, and every row must find
// the receipt nearest in time. The order of the rows and of the receipts is random throughout.
// A failure prints its seed; PROP_SEED=<n> PROP_RUNS=1 node --test sdk/test/prop-reconcile.test.mjs replays one iteration.
// 性质：对账匹配的计数与构造完全一致（丢行、丢回执、超出/未超出容差的修改、改模型名、去掉 id、重复回执）。第二条性质：同一模型、
// 账单行无 id、回执间隔大于两倍窗口，每行都要配到时间最近的回执。行与回执的顺序随机。
import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcile } from '../src/reconcile-cli.js'
import { forAll, runsOf, seedOf } from './helpers/prng.mjs'

const CONTAINER = '0x' + '7c'.repeat(20)
const T0 = 1_790_000_000
function receipt(r, k, { model, prompt, completion, t }) {
  return {
    source: `receipts.jsonl:${k + 1}`,
    envelope: {
      id: `rcpt-${k}-${r.int(1e9)}`, ok: true, method: 'openai_chat', container: CONTAINER, ts: t,
      params: { path: '/v1/chat/completions', requestSha256: r.hex(32).slice(2) },
      result: { status: 200, model, usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }, prices: [{ currency: 'USD', amount: '0.00000100' }], modelMatchedBy: 'response', responseSha256: r.hex(32).slice(2), stream: false, complete: true },
      sig: r.hex(65),
    },
  }
}
const row = (k, c, o = {}) => ({ source: `bill.csv:${k + 2}`, id: c.envelope.id, model: c.envelope.result.model, prompt: c.envelope.result.usage.prompt_tokens, completion: c.envelope.result.usage.completion_tokens, time: c.envelope.ts, ...o })

test(`property (d1): random drops and edits -> matched / missing / mismatch counts exactly as constructed (${runsOf()} iterations, seed ${seedOf(0xd1)})`, async () => {
  const seen = new Set()
  await forAll(import.meta.url, (r) => {
    const n = 1 + r.int(30), tol = r.pick([0, 0, 5, 50])
    const receipts = [], rows = []
    const want = { match: 0, receiptsOnly: 0, billOnly: 0, mismatch: 0, byTime: 0, duplicates: 0 }
    for (let k = 0; k < n; k++) {
      const rec = receipt(r, k, { model: `model-${k}`, prompt: r.int(100_000), completion: r.int(10_000), t: T0 + r.int(86_400 * 3) })
      const fate = r.pick(['ok', 'ok', 'ok', 'dropRow', 'dropReceipt', 'editFar', 'editNear', 'rename', 'noId', 'dup'])
      seen.add(fate)
      const keepReceipt = fate !== 'dropReceipt'
      if (keepReceipt) receipts.push(rec)
      if (fate === 'dup') { receipts.push(structuredClone(rec)); want.duplicates++ }
      if (fate === 'dropRow') { want.receiptsOnly++; continue }
      const u = rec.envelope.result.usage
      let x
      if (fate === 'editFar') { const f = r.pick(['prompt', 'completion']); x = row(k, rec, { [f]: (f === 'prompt' ? u.prompt_tokens : u.completion_tokens) + (r.bool() ? 1 : -1) * (tol + 1 + r.int(100)) }); want.mismatch++ }
      else if (fate === 'editNear') { x = row(k, rec, { prompt: Math.max(0, u.prompt_tokens + r.range(-tol, tol)) }); if (Math.abs(x.prompt - u.prompt_tokens) > tol) throw new Error('generator'); want.match++ }
      else if (fate === 'rename') { x = row(k, rec, { model: `other-${k}` }); want.mismatch++ }
      else if (fate === 'noId') { x = row(k, rec, { id: '', time: rec.envelope.ts + r.range(-120, 120) }); want.match++; want.byTime++ }
      else if (fate === 'dropReceipt') { x = row(k, rec); want.billOnly++ }
      else { x = row(k, rec); want.match++ }
      rows.push(x)
    }
    const res = reconcile(r.shuffle(receipts), r.shuffle(rows), { toleranceTokens: tol })
    const got = { match: res.counts.match, receiptsOnly: res.counts.missing.receiptsOnly, billOnly: res.counts.missing.billOnly, mismatch: res.counts.mismatch, byTime: res.items.filter((i) => i.basis === 'time-model-tokens').length, duplicates: res.duplicates }
    assert.deepEqual(got, want)
    assert.equal(res.items.length, want.match + want.mismatch + want.receiptsOnly + want.billOnly, 'every receipt and every row appears exactly once')
    for (const it of res.items.filter((i) => i.class === 'mismatch')) assert.ok(it.differences.length >= 1 && it.differences.every((d) => ['model', 'prompt_tokens', 'completion_tokens'].includes(d.field)))
  }, { seed: seedOf(0xd1) })
  if (runsOf() >= 50) assert.equal(seen.size, 8, 'every kind of damage was drawn')
})

test(`property (d2): rows without ids, one model: each row finds the receipt nearest in time within the window, and one outside every window is missing (${runsOf()} iterations, seed ${seedOf(0xd2)})`, async () => {
  const WINDOW = 120
  await forAll(import.meta.url, (r) => {
    const n = 1 + r.int(20)
    let t = T0
    const receipts = Array.from({ length: n }, (_, k) => receipt(r, k, { model: 'same', prompt: 100, completion: 10, t: (t += 2 * WINDOW + 1 + r.int(500)) }))
    // receipt times spaced > 2 × window: the receipt within the window of a row is unique / 回执间隔大于两倍窗口
    for (let k = 1; k < n; k++) if (receipts[k].envelope.ts - receipts[k - 1].envelope.ts <= 2 * WINDOW) throw new Error('generator')
    const rows = [], expect = new Map()
    let lost = 0
    for (const [k, rec] of receipts.entries()) {
      if (r.p(0.2)) continue
      const off = r.range(-WINDOW, WINDOW)
      const x = row(k, rec, { id: '', time: rec.envelope.ts + off })
      rows.push(x); expect.set(x.source, rec.envelope.id)
    }
    if (r.bool()) { rows.push({ source: 'bill.csv:999', id: '', model: 'same', prompt: 100, completion: 10, time: T0 - WINDOW - 1 - r.int(1000) }); lost++ }
    const res = reconcile(r.shuffle(receipts), r.shuffle(rows), { window: WINDOW })
    for (const it of res.items.filter((i) => i.class === 'match')) {
      assert.equal(it.basis, 'time-model-tokens')
      assert.equal(res.claimList.find((c) => c.row?.source === it.bill.source)?.id, expect.get(it.bill.source), `${it.bill.source} is paired with its own receipt`)
    }
    assert.equal(res.counts.match, expect.size)
    assert.deepEqual(res.counts.missing, { receiptsOnly: n - expect.size, billOnly: lost })
  }, { seed: seedOf(0xd2) })
})
