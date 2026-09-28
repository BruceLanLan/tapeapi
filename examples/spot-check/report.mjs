#!/usr/bin/env node
// Turn spot-check records (JSON lines from probe.mjs) into plain tables: per probe, what was measured next to what the
// published tokenizers and known answers give, and whether each signed receipt verified. It states numbers, not
// conclusions: there is no verdict, no score and no ranking. A neutral legend says how to read each column.
// 把抽检记录（probe.mjs 输出的 JSON 行）整理成纯文本表格：每个探测的测量值与公开分词器、已知答案给出的值并列，以及每张签名回执
// 是否核验通过。只陈述数字，不下结论：没有结论、没有评分、没有排名。附中立的图例说明每一列怎么读。
//
//   node examples/spot-check/report.mjs results.jsonl [more.jsonl ...] [--markdown]
//   cat results.jsonl | node examples/spot-check/report.mjs -
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const median = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2 }
const distinct = (xs) => [...new Set(xs.filter((x) => x !== null && x !== undefined))]
const show = (xs) => { const d = distinct(xs); return d.length ? d.join('/') : '-' }
const signed = (n) => (n > 0 ? `+${n}` : String(n))
const ms = (n) => (n === null || n === undefined ? '-' : String(Math.round(n)))
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return [...t].length > n ? [...t].slice(0, n - 1).join('') + '…' : t }

/** Parse JSON lines, skipping blank lines; a line that is not JSON is reported, not fatal. / 解析 JSON 行。 */
export function parseRecords(text) {
  const records = [], bad = []
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return
    try { records.push(JSON.parse(line)) } catch { bad.push(i + 1) }
  })
  return { records, bad }
}

function table(head, rows, markdown) {
  if (markdown) return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`)].join('\n')
  const w = head.map((h, i) => Math.max([...String(h)].length, ...rows.map((r) => [...String(r[i])].length)))
  const line = (r) => r.map((c, i) => String(c) + ' '.repeat(w[i] - [...String(c)].length)).join('  ').trimEnd()
  return [line(head), line(w.map((n) => '-'.repeat(n))), ...rows.map(line)].join('\n')
}

export const LEGEND = `How to read this report
- Every number comes from the records: what the service answered and reported, next to values computed locally from
  published tokenizer files (probes.json, tokenizers.mjs) or fixed known answers. Nothing here is a judgement.
- "receipts": signed usage receipts whose verification held (signature by the manifest's signer, request and response
  hashes, usage, price) out of the calls made. A verified receipt binds the numbers to the service that signed them; it
  does not show which model produced the answer.
- "reported - local": the prompt tokens the service reported for a token probe minus the count of that probe's text
  under one tokenizer family. The difference includes the service's fixed per-request overhead (chat template, any
  hidden system prompt), so a single value means little on its own.
- "spread": the largest minus the smallest "reported - local" of a family across the token probes (all runs). A spread
  of 0 means the reported counts moved by exactly the amounts that family's tokenizer gives for these texts.
- "reported delta - local delta": (reported tokens of a probe - reported tokens of tok-base in the same run) minus
  (the family's count of the probe text - its count of the tok-base text). The fixed overhead cancels here; 0 means the
  two differences are equal.
- Families whose tokenizers are not published (Claude, Gemini) have no row; their reported counts are in the records.
- "expected found": how many answers contain the fixed expected string. "answers": distinct answer hashes (sha256).
- Times are milliseconds measured by the prober, network included. Tokens per second = completion tokens over the time
  from the first body chunk to the end of the stream.
- Anyone can rerun the same probe set; the provider can answer with its own measurements. Read raw records first.`

/**
 * The report text for a list of records. / 根据记录生成报告文本。
 * @param {object[]} records
 * @param {{ markdown?: boolean, legend?: boolean }} [o]
 */
export function renderReport(records, { markdown = false, legend = true } = {}) {
  const out = []
  const groups = new Map()
  for (const r of records) {
    const k = [r.service?.container ?? r.service?.target, r.format, r.requestedModel, r.probesVersion].join('|')
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }
  const h = (s) => (markdown ? `### ${s}` : `== ${s}`)
  for (const recs of groups.values()) {
    const f = recs[0], s = f.service ?? {}
    out.push(markdown ? `## ${s.name ?? s.target}` : `### ${s.name ?? s.target}`)
    out.push(`service   ${s.target}  container ${s.container}  signer ${s.signer}${s.dev ? '  [dev: identity not checked on chain]' : s.holder ? `  holder ${s.holder}` : ''}${s.chainId !== undefined ? `  chain ${s.chainId}` : ''}`)
    const runs = distinct(recs.map((r) => r.run)).length
    const times = recs.map((r) => r.ts).sort()
    out.push(`format    ${f.format}   requested model ${f.requestedModel}   probe set ${f.probesVersion}   runs ${runs}   calls ${recs.length}   ${times[0]} .. ${times[times.length - 1]}`)
    const models = new Map()
    for (const r of recs) { const m = r.reportedModel ?? '(none)'; models.set(m, (models.get(m) ?? 0) + 1) }
    out.push(`reported model   ${[...models].map(([m, n]) => `${m} (${n})`).join(', ')}`)
    const ok = recs.filter((r) => r.receiptVerification?.ok).length
    const none = recs.filter((r) => !r.receipt).length
    out.push(`receipts   verified ${ok}, not verified ${recs.length - ok - none}, no receipt ${none}${recs.some((r) => r.error) ? `, transport errors ${recs.filter((r) => r.error).length}` : ''}`)
    out.push('')

    // Per probe / 每个探测
    const probeIds = distinct(recs.map((r) => r.probeId))
    const byProbe = (id) => recs.filter((r) => r.probeId === id)
    out.push(h('Per probe'))
    out.push(table(['probe', 'calls', 'receipts', 'HTTP', 'prompt tokens', 'completion tokens', 'answers', 'expected found', 'median ms'], probeIds.map((id) => {
      const rs = byProbe(id)
      const exp = rs.filter((r) => r.measurements?.expectedFound !== undefined)
      return [id, rs.length, `${rs.filter((r) => r.receiptVerification?.ok).length}/${rs.length}`, show(rs.map((r) => r.http?.status)),
        show(rs.map((r) => r.measurements?.promptTokens)), show(rs.map((r) => r.measurements?.completionTokens)),
        distinct(rs.map((r) => r.answer?.sha256)).length || '-', exp.length ? `${exp.filter((r) => r.measurements.expectedFound).length}/${exp.length}` : '-', ms(median(rs.map((r) => r.http?.totalMs)))]
    }), markdown))
    out.push('')

    // Token probes / token 探测
    const tokRecs = recs.filter((r) => r.probeKind === 'tokens' && r.measurements?.reportedMinusLocal)
    const tokIds = distinct(tokRecs.map((r) => r.probeId))
    const fams = distinct(tokRecs.flatMap((r) => Object.keys(r.measurements.reportedMinusLocal)))
    if (tokIds.length && fams.length) {
      out.push(h('Token probes: reported prompt tokens - local count of the probe text'))
      out.push(table(['family', ...tokIds, 'spread'], fams.map((fam) => {
        const all = tokRecs.map((r) => r.measurements.reportedMinusLocal[fam]).filter(Number.isInteger)
        return [fam, ...tokIds.map((id) => show(tokRecs.filter((r) => r.probeId === id).map((r) => r.measurements.reportedMinusLocal[fam])).split('/').map((x) => (x === '-' ? x : signed(Number(x)))).join('/')),
          all.length ? Math.max(...all) - Math.min(...all) : '-']
      }), markdown))
      out.push(`reported prompt tokens: ${tokIds.map((id) => `${id} ${show(tokRecs.filter((r) => r.probeId === id).map((r) => r.measurements.promptTokens))}`).join(', ')}`)
      out.push('')
      const deltaRecs = tokRecs.filter((r) => r.measurements.reportedDeltaMinusLocalDelta)
      const deltaIds = distinct(deltaRecs.map((r) => r.probeId))
      if (deltaIds.length) {
        out.push(h('Token probes: reported delta - local delta (against tok-base in the same run)'))
        out.push(table(['family', ...deltaIds], fams.map((fam) => [fam, ...deltaIds.map((id) => show(deltaRecs.filter((r) => r.probeId === id).map((r) => r.measurements.reportedDeltaMinusLocalDelta[fam])).split('/').map((x) => (x === '-' ? x : signed(Number(x)))).join('/'))]), markdown))
        out.push(`reported delta: ${deltaIds.map((id) => `${id} ${show(deltaRecs.filter((r) => r.probeId === id).map((r) => r.measurements.reportedDelta))}`).join(', ')}`)
        out.push('')
      }
    }

    // Log probabilities / 对数概率
    const lp = recs.filter((r) => r.probeKind === 'logprobs' && r.measurements)
    if (lp.length) {
      out.push(h('Log probabilities'))
      const rows = lp.map((r) => {
        const toks = (r.measurements.logprobs ?? []).map((t) => JSON.stringify(t.token)).join(' ')
        const vm = r.measurements.vocabularyMembership
        return [r.run, r.measurements.logprobsReturned ? 'yes' : 'no', toks || '-', vm ? Object.entries(vm).map(([fam, xs]) => `${fam}:${xs.map((x) => (x === true ? 'in' : x === false ? 'out' : '?')).join(',')}`).join(' ') : 'no tokenizer files cached']
      })
      out.push(table(['run', 'returned', 'first tokens', 'in vocabulary'], rows, markdown))
      out.push('')
    }

    // Timing / 时间
    const tm = recs.filter((r) => r.probeKind === 'timing' && r.http)
    if (tm.length) {
      out.push(h('Streamed answer timing'))
      out.push(table(['probe', 'calls', 'streamed', 'first chunk ms (median)', 'total ms (median)', 'output tokens/s (median)'], distinct(tm.map((r) => r.probeId)).map((id) => {
        const rs = tm.filter((r) => r.probeId === id)
        return [id, rs.length, `${rs.filter((r) => r.http.stream).length}/${rs.length}`, ms(median(rs.map((r) => r.http.firstChunkMs))), ms(median(rs.map((r) => r.http.totalMs))), median(rs.map((r) => r.measurements?.outputTokensPerSecond)) ?? '-']
      }), markdown))
      out.push('')
    }

    // Answers of the statement probes, first run / 陈述类探测的回答（第一轮）
    const said = recs.filter((r) => r.probeKind === 'answer' && r.answer && r.run === Math.min(...recs.map((x) => x.run)))
    if (said.length) {
      out.push(h('Answers (first run, as recorded)'))
      out.push(table(['probe', 'stop', 'answer'], said.map((r) => [r.probeId, r.answer.stopReason ?? '-', r.answer.text !== undefined ? clip(r.answer.text, 100) : `(sha256 ${r.answer.sha256.slice(0, 16)}…)`]), markdown))
      out.push('')
    }

    // Receipts that did not verify / 未通过核验的回执
    const bad = recs.filter((r) => r.receiptVerification && !r.receiptVerification.ok)
    if (bad.length) {
      out.push(h('Receipt verification problems'))
      for (const r of bad) out.push(`- run ${r.run} ${r.probeId}: ${r.receiptVerification.problems.join('; ')}`)
      out.push('')
    }
  }
  if (legend) out.push(LEGEND)
  return out.join('\n') + '\n'
}

async function main(argv) {
  const markdown = argv.includes('--markdown')
  const files = argv.filter((a) => a !== '--markdown')
  if (!files.length || argv.includes('--help')) { process.stderr.write('usage: node examples/spot-check/report.mjs <results.jsonl ...|-> [--markdown]\n'); return files.length ? 0 : 2 }
  let text = ''
  for (const f of files) text += (f === '-' ? readFileSync(0, 'utf8') : readFileSync(f, 'utf8')) + '\n'
  const { records, bad } = parseRecords(text)
  if (bad.length) process.stderr.write(`[report] ${bad.length} line(s) are not JSON and were skipped\n`)
  if (!records.length) { process.stderr.write('[report] no records\n'); return 1 }
  process.stdout.write(renderReport(records, { markdown }))
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stderr.write(`[report] ${e.message}\n`); process.exit(1) })
