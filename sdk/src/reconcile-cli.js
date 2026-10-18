// `tapeapi reconcile` on the command line (@experimental; Node only): the usage and prices the receipts on this machine
// claim, set row by row against a bill file the operator exported (CSV, JSON or JSON lines). Two local files, no
// network, no key. It reports three kinds of fact, each with the line it comes from: match, missing (on one side only),
// and mismatch (a field that differs from what the receipt claims). It decides nothing about who is right.
// The file functions come in as io.host (receipts-cli.js hostOf). / 文件函数经 io.host 传入。
// tapeapi reconcile 命令行部分（实验性；仅 Node）：本机回执声称的用量与价格，与运营者导出的账单文件逐行对账。只读两个本地文件、
// 不联网、不需要密钥。只报告三类事实（匹配、缺失、与回执声称不一致），每条带出处行；不判定谁对。
import { modelEntryOf, formatOfMethod, MANIFEST_FIELD } from './ai.js'
import { NOTES } from './connect.js'
import {
  T, parseOptions, commonOptions, loadSource, filterRecords, ui, usageExit, usage, redactKeeping, keepOf, clean, shellWord, iso,
  parseTime, snapshotsFor, at, shown, table, padTo, hostOf,
} from './receipts-cli.js'

/** What a bill column can stand for. / 账单列可以表示的字段。 */
export const BILL_KEYS = Object.freeze(['id', 'model', 'prompt', 'completion', 'amount', 'time'])
/**
 * Column-name presets. new-api: the field names of the JSON its GET /api/log/self returns (data.items; model/log.go,
 * read in its source code, not yet checked against a real instance): upstream_request_id, model_name, prompt_tokens,
 * completion_tokens, quota (a raw quota integer: --amount-scale is new-api's quota_per_unit) and created_at (unix
 * seconds). It is not new-api's web CSV export: that file has localized headers (Time, Model, Input Tokens, ...), a
 * formatted Cost string and request_id rather than upstream_request_id, so the preset never matches it (exit 2); name
 * its columns with --map. Whether upstream_request_id holds the answer id a receipt carries is not known; rows it does
 * not join are joined on time, model and tokens.
 * 列名预设。new-api：其 GET /api/log/self 返回的 JSON（data.items）的字段名（取自源码，尚未用真实实例核对）。不是网页端的 CSV
 * 导出：那份文件表头是本地化的显示标题、Cost 是格式化后的字符串、id 列是 request_id，预设对它永远匹配不上（退出 2），请用 --map。
 */
export const BILL_PRESETS = Object.freeze({
  'new-api': Object.freeze({ id: 'upstream_request_id', model: 'model_name', prompt: 'prompt_tokens', completion: 'completion_tokens', amount: 'quota', time: 'created_at' }),
})
const DEFAULT_WINDOW = 120

export const CNOTES = Object.freeze({
  facts: T('This lists facts and decides nothing: a difference is a question to raise with the provider, with the two lines it comes from.',
    '本工具只列事实、不下结论：每条差异都带出处行，是可以向服务方询问的问题。'),
  preset: T("new-api preset: the field names of the JSON new-api's GET /api/log/self returns (data.items), read in its source code, not yet checked against a real instance. new-api's web CSV export is not that file (localized headers, a formatted Cost, request_id): name its columns with --map.",
    'new-api 预设：new-api 的 GET /api/log/self 返回的 JSON（data.items）的字段名，取自其源码，尚未用真实实例核对。new-api 网页端导出的 CSV 不是这份文件（表头本地化、Cost 已格式化、id 列为 request_id）：请用 --map 指定它的列。'),
})

export function reconcileUsage(cmd = 'tapeapi') {
  return `${cmd} reconcile (experimental / 实验性): the usage and prices your receipts claim, set row by row against a bill file.
把回执声称的用量与价格，与账单文件逐行对账。

Usage: ${cmd} reconcile --receipts <file|dir> --bill <file> [--preset new-api | --map <key>=<column>,...] [options]

  --receipts <path>    the file tapeapi-verify --log wrote, or a directory of them (also --log <path>)
  --bill <file>        the bill or usage file from the provider: CSV (with a header line), JSON (an array, or
                       { data: [...] }, or { data: { items: [...] } }) or JSON lines (.jsonl) (also --relay-export <file>)
                       服务方的账单 / 用量文件：CSV（带表头）、JSON 或 JSON 行
  --preset new-api     the field names of the JSON new-api's GET /api/log/self returns (data.items):
                       ${Object.entries(BILL_PRESETS['new-api']).map(([k, v]) => `${k}=${v}`).join(', ')}
                       (from its source code, not yet checked against a real instance). Used without asking when the
                       bill has them all, apart from id and amount. new-api's web CSV export has other headers
                       (localized; Cost formatted, not a comparable amount; request_id): name them with --map
                       new-api 的 /api/log/self JSON 字段名；网页端导出的 CSV 请用 --map
  --map <k>=<col>,...  name the columns yourself (over the preset): ${BILL_KEYS.join(', ')}. model, prompt and completion
                       are needed, and id or time        自己指定列名（覆盖预设）
  --amount-scale <n>   how many bill amount units make one unit of the receipt's currency (new-api: quota_per_unit,
                       from its /api/status). Without it, amounts are not compared
                       多少个账单金额单位等于回执币种的 1 个单位（new-api：quota_per_unit）。不给就不比较金额
  --currency <c>       the receipt currency the bill is in (default: each receipt's first price)
  --tolerance-amount <x>
                       amounts agree within x bill units (default: under one unit of the bill value's last decimal place)
  --tolerance-tokens <n>
                       token counts agree within n (default 0)
  --window <s>         a row without a joining id is joined to a receipt of the same model and tokens signed within s
                       seconds (default ${DEFAULT_WINDOW})
  --manifest <file>    a manifest snapshot (default: manifest.json, *.manifest.json next to the receipts): with it, a
                       model and its aliases count as the same model      有快照时，模型与其别名算同一个模型
  --service <s>, --container <addr>, --model <id>, --since <t>, --until <t>
                       the same filters as receipts; --since / --until apply to the bill's time column too
  --json               one JSON object on stdout     --lang <en|zh|both>   (default both)     --no-color
  --help

It reads the two files only: no network, no key, nothing uploaded. Every difference names the receipt line and the bill
line it comes from; a difference is a fact to raise with the provider, not a verdict.
只读这两个文件：不联网、不需要密钥、不上传。每条差异都给出回执行与账单行；差异是可以向服务方询问的事实，不是结论。
Exit status: 0 every receipt and every bill row match; 1 something is missing or differs; 2 a usage mistake (also a
column named that the bill does not have); 3 nothing to compare (no receipt claiming usage and no bill row).
退出码：0 全部匹配；1 有缺失或不一致；2 用法错误（点名了账单里没有的列也算）；3 没有可比较的内容（没有声称用量的回执，也没有账单行）。
`
}

const SPEC = {
  '--receipts': 'value', '--log': '--receipts', '--bill': 'value', '--relay-export': '--bill', '--preset': 'value', '--map': 'value', '--amount-scale': 'value',
  '--currency': 'value', '--tolerance-amount': 'value', '--tolerance-tokens': 'value', '--window': 'value', '--manifest': 'value',
  '--service': 'value', '--container': 'value', '--model': 'value', '--since': 'value', '--until': 'value',
  '--json': 'bool', '--lang': 'value', '--no-color': 'bool', '--help': 'bool', '-h': '--help',
}

// ---------------------------------------------------------------------------------------------------------------
// The bill file / 账单文件
// ---------------------------------------------------------------------------------------------------------------
/**
 * CSV (RFC 4180): quoted cells with "" for a quote and line breaks inside, CRLF or LF, a leading BOM. Each record is
 * { cells, line } where line is the line it starts on. Throws on an unclosed quote.
 * 解析 CSV（RFC 4180）；每条记录带它起始的行号。引号未闭合时抛错。
 */
export function parseCsv(text) {
  const s = String(text).replace(/^\uFEFF/, '')
  const out = []
  let row = [], cell = '', quoted = false, inCell = false, line = 1, start = 1
  const endRow = () => { row.push(cell); if (!(row.length === 1 && row[0] === '' && !inCell)) out.push({ cells: row, line: start }); row = []; cell = ''; inCell = false }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++ } else quoted = false }
      else { if (c === '\n') line++; cell += c }
      continue
    }
    if (c === '"' && cell === '' && !inCell) { quoted = true; inCell = true; continue }
    if (c === ',') { row.push(cell); cell = ''; inCell = false; continue }
    if (c === '\r' && s[i + 1] === '\n') continue
    if (c === '\n' || c === '\r') { endRow(); line++; start = line; continue }
    cell += c; inCell = true
  }
  if (quoted) throw new Error(`a quote opened on line ${start} is never closed`)
  if (cell !== '' || row.length || inCell) endRow()
  return out
}

/**
 * The rows of a bill file, as { header, rows: [{ values, source }], kind }. / 账单文件的各行。
 */
export function readBill(file, h) {
  const text = h.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  const name = shown(file, h)
  if (/\.jsonl$/i.test(file)) {
    const rows = []
    text.split(/\r?\n/).forEach((l, i) => {
      if (!l.trim()) return
      let v
      try { v = JSON.parse(l) } catch { throw new Error(`line ${i + 1} is not JSON`) }
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`line ${i + 1} is not a JSON object`)
      rows.push({ values: v, source: `${name}:${i + 1}` })
    })
    return { kind: 'JSON lines', header: [...new Set(rows.flatMap((r) => Object.keys(r.values)))], rows }
  }
  if (/\.json$/i.test(file) || /^\s*[[{]/.test(text)) {
    let v
    try { v = JSON.parse(text) } catch (e) { if (/\.json$/i.test(file)) throw new Error(`not JSON (${e.message})`); v = undefined }
    if (v !== undefined) {
      const list = Array.isArray(v) ? v : Array.isArray(v?.data) ? v.data : Array.isArray(v?.data?.items) ? v.data.items : Array.isArray(v?.items) ? v.items : null
      if (!list) throw new Error('a JSON bill is an array of rows, or { data: [...] }, or { data: { items: [...] } }')
      const rows = list.map((x, i) => {
        if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error(`row [${i}] is not a JSON object`)
        return { values: x, source: `${name}:[${i}]` }
      })
      return { kind: 'JSON', header: [...new Set(rows.flatMap((r) => Object.keys(r.values)))], rows }
    }
  }
  const recs = parseCsv(text)
  if (!recs.length) return { kind: 'CSV', header: [], rows: [] }
  const header = recs[0].cells.map((h) => h.trim())
  return { kind: 'CSV', header, rows: recs.slice(1).map((r) => ({ values: Object.fromEntries(header.map((h, i) => [h, r.cells[i] ?? ''])), source: `${name}:${r.line}` })) }
}

/** --map k=col,k=col -> { k: col }. / 解析 --map。 */
export function parseMap(s) {
  const out = {}
  for (const part of String(s).split(',').map((x) => x.trim()).filter(Boolean)) {
    const eq = part.indexOf('=')
    const k = eq > 0 ? part.slice(0, eq).trim() : '', col = eq > 0 ? part.slice(eq + 1).trim() : ''
    if (!BILL_KEYS.includes(k) || !col) throw usage(`--map takes <key>=<column> pairs, keys ${BILL_KEYS.join(', ')}: ${JSON.stringify(part)}`, `--map 的格式是 <键>=<列名>，键为 ${BILL_KEYS.join('、')}：${JSON.stringify(part)}`)
    out[k] = col
  }
  return out
}

/**
 * Which column stands for what: the preset (given, or found in the header), then --map over it. A preset's id and
 * amount columns are dropped when the bill lacks them; any other named column the bill lacks is a usage mistake.
 * 列的对应关系：预设（指定的，或表头里找到的），再以 --map 覆盖。预设的 id 与 amount 列账单里没有就去掉；其它点名而账单没有的列是用法错误。
 */
export function columnsFor(header, { preset = null, map = null } = {}) {
  const has = new Set(header)
  let base = {}, presetName = null, detected = false
  if (preset) {
    if (!Object.hasOwn(BILL_PRESETS, preset)) throw usage(`--preset must be one of ${Object.keys(BILL_PRESETS).join(', ')}`, `--preset 只能是 ${Object.keys(BILL_PRESETS).join('、')}`)
    base = { ...BILL_PRESETS[preset] }; presetName = preset
  } else if (!map) {
    for (const [name, cols] of Object.entries(BILL_PRESETS)) {
      if (['model', 'prompt', 'completion', 'time'].every((k) => has.has(cols[k]))) { base = { ...cols }; presetName = name; detected = true; break }
    }
  }
  const dropped = []
  if (presetName) for (const k of ['id', 'amount']) if (!map?.[k] && !has.has(base[k])) { dropped.push(base[k]); delete base[k] }
  const cols = { ...base, ...(map ?? {}) }
  if (!presetName && !map) throw usage(`name the bill's columns: --map model=<column>,prompt=<column>,completion=<column>,time=<column>[,id=<column>][,amount=<column>], or --preset new-api. Its header: ${header.slice(0, 30).join(', ')}`,
    `请指定账单的列：--map model=<列>,prompt=<列>,completion=<列>,time=<列>[,id=<列>][,amount=<列>]，或 --preset new-api。它的表头：${header.slice(0, 30).join(', ')}`)
  const missing = Object.entries(cols).filter(([, c]) => !has.has(c)).map(([k, c]) => `${k}=${c}`)
  if (missing.length) throw usage(`the bill has no column ${missing.join(', ')}; its header: ${header.slice(0, 30).join(', ')}`, `账单里没有这些列：${missing.join(', ')}；它的表头：${header.slice(0, 30).join(', ')}`)
  const lack = ['model', 'prompt', 'completion'].filter((k) => !cols[k])
  if (lack.length) throw usage(`--map must name ${lack.join(', ')}`, `--map 必须指定 ${lack.join('、')}`)
  if (!cols.id && !cols.time) throw usage('--map must name id or time: a row is joined to a receipt by its id, or by time, model and tokens', '--map 必须指定 id 或 time：账单行按 id，或按时间、模型与 token 数与回执对应')
  return { cols, preset: presetName, detected, dropped }
}

const int = (v) => { const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : ''; return /^-?\d+$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : null }
function decimal(v) {
  const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v.trim() : ''
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null
  return { text: s, value: Number(s), places: s.includes('.') ? s.split('.')[1].length : 0 }
}

// ---------------------------------------------------------------------------------------------------------------
// Reconciliation (pure) / 对账（纯函数）
// ---------------------------------------------------------------------------------------------------------------
/**
 * Set the receipts against the bill rows. receipts: records with an envelope (receipts-cli readRecords); rows: bill
 * rows already mapped ({ source, id, model, prompt, completion, amount, time }); o: window, toleranceTokens,
 * amountScale (null: amounts not compared), currency, toleranceAmount, manifests (for aliases).
 * Returns { items, counts, claims, noClaim, duplicates }; each item is { class: match | missing | mismatch, side?,
 * basis?, receipt?, bill?, differences? }.
 * 回执与账单行对账。返回 items 与计数；每项为 match / missing / mismatch，带依据、两边出处与差异。
 */
export function reconcile(receipts, rows, o = {}) {
  const { window = DEFAULT_WINDOW, toleranceTokens = 0, amountScale = null, currency = null, toleranceAmount = null, manifests = [] } = o
  const seen = new Set()
  let duplicates = 0
  const claims = [], noClaim = []
  for (const rec of receipts) {
    const e = rec.envelope
    if (!e || typeof e !== 'object') continue
    const key = typeof e.sig === 'string' ? e.sig : JSON.stringify(e)
    if (seen.has(key)) { duplicates++; continue }
    seen.add(key)
    const r = e.result, u = r?.usage
    if (!(Number.isInteger(r?.status) && r.status >= 200 && r.status < 300 && u && typeof u === 'object')) { noClaim.push(rec); continue }
    claims.push({ rec, id: typeof e.id === 'string' ? e.id : '', model: typeof r.model === 'string' ? r.model : null, prompt: Number.isSafeInteger(u.prompt_tokens) ? u.prompt_tokens : null,
      completion: Number.isSafeInteger(u.completion_tokens) ? u.completion_tokens : null, prices: Array.isArray(r.prices) ? r.prices : null,
      t: Number.isSafeInteger(e.ts) ? e.ts : null, format: formatOfMethod(e.method)?.name, container: e.container, used: false })
  }
  const sameModel = (c, m) => {
    if (c.model === m) return true
    if (typeof m !== 'string' || c.model === null) return false
    for (const s of snapshotsFor(manifests, c.container)) {
      const models = s.manifest?.[MANIFEST_FIELD]?.models
      const a = modelEntryOf(models, c.model, c.format), b = modelEntryOf(models, m, c.format)
      if (a && a === b) return true
    }
    return false
  }
  const near = (a, b) => (a === null || b === null ? Infinity : Math.abs(a - b))
  const tokensClose = (c, row) => c.prompt !== null && row.prompt !== null && c.completion !== null && row.completion !== null &&
    Math.abs(c.prompt - row.prompt) <= toleranceTokens && Math.abs(c.completion - row.completion) <= toleranceTokens
  const byId = new Map()
  for (const c of claims) { if (!c.id) continue; if (!byId.has(c.id)) byId.set(c.id, []); byId.get(c.id).push(c) }
  const pairs = []
  const unmatched = []
  // 1. By id, in file order. / 先按 id，按文件顺序。
  for (const row of rows) {
    const cands = row.id ? (byId.get(row.id) ?? []).filter((c) => !c.used) : []
    if (!cands.length) { unmatched.push(row); continue }
    const c = cands.reduce((a, b) => (near(b.t, row.time) < near(a.t, row.time) ? b : a))
    c.used = true; pairs.push({ c, row, basis: 'id' })
  }
  // 2. The rest by time, model and tokens: the nearest receipt in time within the window. / 其余按时间、模型与 token 数。
  const rest = []
  for (const row of [...unmatched].sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity))) {
    let best = null
    if (row.time !== null) {
      for (const c of claims) {
        if (c.used || near(c.t, row.time) > window || !sameModel(c, row.model) || !tokensClose(c, row)) continue
        if (!best || near(c.t, row.time) < near(best.t, row.time)) best = c
      }
    }
    if (best) { best.used = true; pairs.push({ c: best, row, basis: 'time-model-tokens' }) } else rest.push(row)
  }
  const items = []
  for (const { c, row, basis } of pairs) {
    const differences = []
    if (!sameModel(c, row.model)) differences.push({ field: 'model', receipt: c.model, bill: row.model })
    for (const [field, a, b] of [['prompt_tokens', c.prompt, row.prompt], ['completion_tokens', c.completion, row.completion]]) {
      if (a === null || b === null ? a !== b : Math.abs(a - b) > toleranceTokens) differences.push({ field, receipt: a, bill: b })
    }
    let amount = null
    if (amountScale !== null && row.amount !== undefined) {
      const p = c.prices ? (currency ? c.prices.find((x) => x?.currency === currency) : c.prices[0]) : null
      const claimed = p && typeof p.amount === 'string' ? Number(p.amount) : null
      const inBill = claimed === null ? null : claimed * amountScale
      const tol = toleranceAmount ?? (row.amount ? 10 ** -row.amount.places : 0)
      amount = { receipt: p ? `${p.amount} ${p.currency}` : null, receiptInBillUnits: inBill === null ? null : round(inBill), bill: row.amount?.text ?? null }
      const agree = inBill !== null && row.amount !== null && (toleranceAmount !== null ? Math.abs(inBill - row.amount.value) <= tol + 1e-12 : Math.abs(inBill - row.amount.value) < tol - 1e-12)
      if (!agree) differences.push({ field: 'amount', receipt: amount.receipt, receiptInBillUnits: amount.receiptInBillUnits, bill: amount.bill, difference: inBill !== null && row.amount !== null ? round(row.amount.value - inBill) : null })
    }
    items.push({ class: differences.length ? 'mismatch' : 'match', basis, receipt: claimView(c), bill: billView(row), ...(amount ? { amount } : {}), differences })
  }
  for (const c of claims) if (!c.used) items.push({ class: 'missing', side: 'receipts-only', receipt: claimView(c) })
  for (const row of rest) items.push({ class: 'missing', side: 'bill-only', bill: billView(row) })
  const counts = {
    match: items.filter((x) => x.class === 'match').length,
    missing: { receiptsOnly: items.filter((x) => x.side === 'receipts-only').length, billOnly: items.filter((x) => x.side === 'bill-only').length },
    mismatch: items.filter((x) => x.class === 'mismatch').length,
  }
  return { items, counts, claims: claims.length, noClaim: noClaim.length, duplicates }
}
const round = (x) => Math.round(x * 1e10) / 1e10
const claimView = (c) => ({ source: c.rec.source, id: c.id, signedAt: c.t === null ? null : iso(c.t), model: c.model, prompt_tokens: c.prompt, completion_tokens: c.completion,
  prices: c.prices ? c.prices.map((p) => `${p?.amount} ${p?.currency}`).join(' / ') : null, loggedOk: c.rec.logged ? c.rec.logged.ok : null })
const billView = (r) => ({ source: r.source, id: r.id || null, time: r.time === null ? null : iso(r.time), model: r.model, prompt_tokens: r.prompt, completion_tokens: r.completion, amount: r.amount === undefined ? undefined : r.amount?.text ?? null })

// ---------------------------------------------------------------------------------------------------------------
// tapeapi reconcile
// ---------------------------------------------------------------------------------------------------------------
/**
 * Run `tapeapi reconcile` with `argv`. Returns { exitCode }. io as runReceipts. / 运行 tapeapi reconcile。
 */
export async function runReconcile(argv, io = {}) {
  const { cmd = 'tapeapi', version = '', env = process.env } = io
  const h = hostOf(io.host, io.cwd ?? process.cwd())
  const stdout = io.stdout ?? ((s) => process.stdout.write(s))
  const stderr = io.stderr ?? ((s) => process.stderr.write(s))
  const isTTY = io.isTTY ?? process.stdout.isTTY === true
  let keep = []
  const say = (write, text) => write(redactKeeping(text, keep, env))
  const help = reconcileUsage(cmd)
  let o, common, src, bill, cols, num
  try {
    const parsed = parseOptions(argv, SPEC)
    o = parsed.opts
    if (o['--help']) { say(stdout, help); return { exitCode: 0 } }
    if (parsed.positional.length) throw usage(`unexpected ${JSON.stringify(parsed.positional[0])}`, `多余的参数 ${JSON.stringify(parsed.positional[0])}`)
    common = commonOptions(o)
    if (!o['--bill']) throw usage('--bill <file> is needed: the bill or usage file from the provider (CSV, JSON or JSON lines)', '需要 --bill <文件>：服务方的账单或用量文件（CSV、JSON 或 JSON 行）')
    num = {}
    for (const [flag, key, min, intOnly] of [['--window', 'window', 0, false], ['--tolerance-tokens', 'toleranceTokens', 0, true], ['--amount-scale', 'amountScale', Number.MIN_VALUE, false], ['--tolerance-amount', 'toleranceAmount', 0, false]]) {
      if (o[flag] === undefined) continue
      const v = Number(o[flag])
      if (!/^\d+(\.\d+)?$/.test(o[flag]) || !(v >= min) || (intOnly && !Number.isInteger(v))) throw usage(`${flag} must be a ${intOnly ? 'whole ' : ''}number${min > 0 ? ' above 0' : ''}`, `${flag} 必须是${min > 0 ? '大于 0 的' : ''}${intOnly ? '整数' : '数'}`)
      num[key] = v
    }
    if (o['--tolerance-amount'] !== undefined && o['--amount-scale'] === undefined) throw usage('--tolerance-amount applies with --amount-scale only', '--tolerance-amount 只与 --amount-scale 一起使用')
    if (o['--currency'] !== undefined && o['--amount-scale'] === undefined) throw usage('--currency applies with --amount-scale only', '--currency 只与 --amount-scale 一起使用')
    src = loadSource(o, h)
    try { bill = readBill(at(o['--bill'], h), h) } catch (e) { throw usage(`cannot read the bill ${o['--bill']}: ${e.code ?? e.message}`, `读不了账单 ${o['--bill']}：${e.code ?? e.message}`) }
    cols = columnsFor(bill.header, { preset: o['--preset'] ?? null, map: o['--map'] !== undefined ? parseMap(o['--map']) : null })
  } catch (e) {
    if (!e.usage) throw e
    return usageExit({ e, prog: `${cmd} reconcile`, help, cmd: `${cmd} reconcile`, stderr, say })
  }
  const U = ui({ lang: common.lang, color: !common.noColor && isTTY && !common.json && (env.NO_COLOR === undefined || env.NO_COLOR === '') })
  keep = keepOf(src.records)
  const { since, until } = src.filters
  // The bill's rows, mapped; --since / --until apply to its time column too (a row with no time is kept).
  // 账单行按列映射；--since / --until 同样作用于它的时间列（没有时间的行保留）。
  const rows = bill.rows.map((r) => {
    const v = (k) => (cols.cols[k] ? r.values[cols.cols[k]] : undefined)
    return { source: r.source, id: cols.cols.id ? clean(v('id')).trim() : '', model: clean(v('model')).trim(), prompt: int(v('prompt')), completion: int(v('completion')),
      ...(cols.cols.amount ? { amount: decimal(v('amount')) } : {}), time: cols.cols.time ? parseTime(typeof v('time') === 'string' ? v('time') : v('time') ?? '') : null }
  }).filter((r) => (since === null || r.time === null || r.time >= since) && (until === null || r.time === null || r.time < until) && (!src.filters.model || r.model === src.filters.model))
  const receipts = filterRecords(src.records, src.filters).filter((r) => r.envelope)
  const amountScale = num.amountScale ?? null
  const res = reconcile(receipts, rows, { ...num, amountScale: cols.cols.amount ? amountScale : null, currency: o['--currency'] ?? null, toleranceAmount: num.toleranceAmount ?? null, manifests: src.manifests })
  const differs = res.counts.mismatch + res.counts.missing.receiptsOnly + res.counts.missing.billOnly
  const exitCode = !res.claims && !rows.length ? 3 : differs ? 1 : 0
  const first = res.items.find((x) => x.class === 'mismatch' && x.receipt?.id) ?? res.items.find((x) => x.side === 'receipts-only' && x.receipt?.id)
  const next = exitCode === 0 ? null : exitCode === 1 && first ? `${cmd} receipts show ${shellWord(first.receipt.id)} --receipts ${shellWord(src.path)}` : `${cmd} receipts tail --receipts ${shellWord(src.path)}`
  const amounts = !cols.cols.amount ? { compared: false, why: 'no amount column' } : amountScale === null ? { compared: false, why: 'no --amount-scale' }
    : { compared: true, scale: amountScale, currency: o['--currency'] ?? null, tolerance: num.toleranceAmount ?? 'under one unit of the last decimal place' }
  if (common.json) {
    const L = (t) => (U.lang === 'en' ? t.en : U.lang === 'zh' ? t.zh : t)
    say(stdout, JSON.stringify({
      tool: 'tapeapi', command: 'reconcile', version, experimental: true, ok: exitCode === 0, exitCode,
      receipts: { source: src.path, records: src.records.length, claims: res.claims, claimNone: res.noClaim, duplicates: res.duplicates, skipped: src.skipped },
      bill: { source: shown(at(o['--bill'], h), h), kind: bill.kind, rows: rows.length, columns: cols.cols, preset: cols.preset, presetDetected: cols.detected, presetUnverified: cols.preset === 'new-api', droppedPresetColumns: cols.dropped },
      join: { id: cols.cols.id ?? null, window: num.window ?? DEFAULT_WINDOW, toleranceTokens: num.toleranceTokens ?? 0 }, amounts, counts: res.counts, items: res.items,
      notes: { facts: L(CNOTES.facts), receipt: L(NOTES.receipt), prices: L(NOTES.prices), ...(cols.preset === 'new-api' ? { preset: L(CNOTES.preset) } : {}) }, next,
    }, null, 2) + '\n')
    return { exitCode }
  }
  const out = [`tapeapi reconcile${version ? ` ${version}` : ''} ${U.experimental}   ${U.lab(T('files only, nothing sent anywhere', '只读文件，不向任何地方发送'))}`]
  const lab = (t) => padTo(U.lab(t), U.lang === 'both' ? 26 : U.lang === 'zh' ? 10 : 12)
  out.push(`  ${lab(T('receipts', '回执'))}${clean(src.path)}   ${U.lang === 'zh' ? `${src.records.length} 条记录，${res.claims} 张声称用量，${res.noClaim} 张未声称用量（失败的调用，不参与对账）${res.duplicates ? `，${res.duplicates} 张重复` : ''}${src.skipped.length ? `，${src.skipped.length} 行跳过` : ''}`
    : `${src.records.length} records, ${res.claims} claiming usage, ${res.noClaim} claiming none (failed calls, not compared)${res.duplicates ? `, ${res.duplicates} duplicates` : ''}${src.skipped.length ? `, ${src.skipped.length} lines skipped` : ''}`}`)
  out.push(`  ${lab(T('bill', '账单'))}${clean(shown(at(o['--bill'], h), h))}   ${rows.length} ${U.lang === 'zh' ? '行' : 'rows'} (${bill.kind})`)
  out.push(`  ${lab(T('columns', '列'))}${Object.entries(cols.cols).map(([k, c]) => `${k}=${clean(c)}`).join(', ')}${cols.preset ? `   (${U.lab(cols.detected ? T(`${cols.preset} preset, found in the header`, `${cols.preset} 预设，从表头识别`) : T(`${cols.preset} preset`, `${cols.preset} 预设`))})` : ''}${cols.dropped.length ? `   ${U.lab(T('not in the bill', '账单里没有'))}: ${cols.dropped.join(', ')}` : ''}`)
  out.push(`  ${lab(T('joined on', '匹配依据'))}${cols.cols.id ? `${U.lab(T('id column', 'id 列'))} ${clean(cols.cols.id)}${U.lang === 'zh' ? '；' : '; '}${U.lab(T('else', '否则'))} ` : ''}${U.lab(T(`time ±${num.window ?? DEFAULT_WINDOW} s × model × tokens (±${num.toleranceTokens ?? 0})`, `时间 ±${num.window ?? DEFAULT_WINDOW} 秒 × 模型 × token 数（±${num.toleranceTokens ?? 0}）`))}`)
  out.push(`  ${lab(T('amounts', '金额'))}${amounts.compared ? U.lab(T(`bill ÷ ${amountScale} = ${o['--currency'] ?? "the receipt's first currency"}`, `账单 ÷ ${amountScale} = ${o['--currency'] ?? '回执的第一个币种'}`))
    : U.lab(amounts.why === 'no amount column' ? T('not compared: no amount column', '不比较：没有金额列') : T('not compared: give --amount-scale', '不比较：请给出 --amount-scale'))}`)
  out.push('')
  const mark = (cls) => (cls === 'match' ? U.green : U.yellow)
  out.push(...table([
    [mark('match')(U.lab(T('MATCH', '匹配'))), String(res.counts.match), ''],
    [mark('missing')(U.lab(T('MISSING', '缺失'))), String(res.counts.missing.receiptsOnly + res.counts.missing.billOnly), U.lab(T(`${res.counts.missing.receiptsOnly} in the receipts with no bill row, ${res.counts.missing.billOnly} bill row${res.counts.missing.billOnly === 1 ? '' : 's'} with no receipt`, `${res.counts.missing.receiptsOnly} 张回执在账单里没有对应行，${res.counts.missing.billOnly} 行账单没有对应回执`))],
    [mark('mismatch')(U.lab(T('MISMATCH', '不一致'))), String(res.counts.mismatch), U.lab(T('differs from what the receipt claims', '与回执声称不一致'))],
  ]))
  const v = (x) => (x === null || x === undefined ? 'null' : clean(x))
  const rLine = (r) => `${r.source}  ${r.signedAt ?? '-'}  id ${v(r.id)}  ${v(r.model)}  in ${v(r.prompt_tokens)} out ${v(r.completion_tokens)}  ${r.prices ? clean(r.prices) : 'price null'}${r.loggedOk === false ? `  (${U.lab(T('the log marks this receipt failed', '日志把这张回执标为失败'))})` : ''}`
  const bLine = (b) => `${b.source}  ${b.time ?? '-'}${b.id ? `  id ${v(b.id)}` : ''}  ${v(b.model)}  in ${v(b.prompt_tokens)} out ${v(b.completion_tokens)}${b.amount !== undefined ? `  amount ${v(b.amount)}` : ''}`
  const mism = res.items.filter((x) => x.class === 'mismatch')
  if (mism.length) {
    out.push('', `  ${U.yellow(U.lab(T('MISMATCH: differs from what the receipt claims', '不一致：与回执声称不一致')))}`)
    for (const x of mism) {
      out.push(`    ${U.lab(T('receipt', '回执'))} ${rLine(x.receipt)}`, `    ${U.lab(T('bill', '账单'))} ${bLine(x.bill)}   (${U.lab(x.basis === 'id' ? T('joined by id', '按 id 匹配') : T('joined by time, model and tokens', '按时间、模型与 token 数匹配'))})`)
      for (const d of x.differences) {
        out.push(`      ${d.field}: ${U.lab(T('receipt', '回执'))} ${v(d.receipt)}${d.field === 'amount' && d.receiptInBillUnits !== null ? ` (= ${d.receiptInBillUnits} ${U.lab(T('in bill units', '个账单单位'))})` : ''}, ${U.lab(T('bill', '账单'))} ${v(d.bill)}${d.difference !== undefined && d.difference !== null ? `, ${U.lab(T('difference', '差额'))} ${d.difference}` : ''}`)
      }
    }
  }
  const onlyR = res.items.filter((x) => x.side === 'receipts-only'), onlyB = res.items.filter((x) => x.side === 'bill-only')
  if (onlyR.length) {
    out.push('', `  ${U.yellow(U.lab(T('MISSING: a receipt, and no bill row for it', '缺失：有回执，账单里没有对应行')))}`)
    for (const x of onlyR) out.push(`    ${rLine(x.receipt)}`)
  }
  if (onlyB.length) {
    out.push('', `  ${U.yellow(U.lab(T('MISSING: a bill row, and no receipt for it (a call not made through tapeapi-verify, or not logged?)', '缺失：有账单行，没有对应回执（没有经过 tapeapi-verify，或没有记录？）')))}`)
    for (const x of onlyB) out.push(`    ${bLine(x.bill)}`)
  }
  out.push('', ...U.say(CNOTES.facts, '  '), ...U.say(NOTES.receipt, '  '), ...U.say(NOTES.prices, '  '))
  if (cols.preset === 'new-api') out.push(...U.say(CNOTES.preset, '  '))
  if (next) out.push(U.next(next))
  say(stdout, out.join('\n') + '\n')
  return { exitCode }
}
