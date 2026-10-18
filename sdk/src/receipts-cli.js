// `tapeapi receipts tail|show|export` on the command line (@experimental; Node only). Reads receipt files on this machine
// only: the JSON lines `tapeapi-verify --log` appends (or bare receipt envelopes, one per line or in a .json file). No
// network, no key, nothing uploaded. `show` replays the checks of one receipt offline against a manifest snapshot (the
// manifest the service published, saved next to the receipts or given with --manifest); without one it decides nothing
// (exit 3) and fetches nothing. Shared with `tapeapi reconcile` (reconcile-cli.js): the reader, the filters, the output.
// tapeapi receipts 命令行部分（实验性；仅 Node）。只读本机的回执文件：tapeapi-verify --log 追加的 JSON 行（或裸回执信封）。
// 不联网、不需要密钥、不上传。show 用清单快照（服务发布的清单，存在回执旁或用 --manifest 指定）离线重放一张回执的核验；没有快照就
// 不判定（退出 3），也不去取。读取、过滤与输出部分与 tapeapi reconcile 共用。
// Like every module under src/, it imports nothing Node-only: the file functions come in as `host` (sdk/bin/tapeapi.js
// passes node:fs and node:path; see hostOf). / 与 src/ 下所有模块一样不引用仅限 Node 的模块：文件函数经 host 传入。
import { verifyUsageReceipt, formatOfMethod } from './ai.js'
import { redactEnv, redactKeyShapes } from './connect-cli.js'
import { NOTES } from './connect.js'

export const T = (en, zh) => ({ en, zh })
export const VERIFY_PAGE = 'https://tapeapi.fun/verify/'
/** A manifest snapshot next to the receipts: manifest.json or <anything>.manifest.json. / 回执旁的清单快照文件名。 */
export const MANIFEST_FILE = /(^|\.)manifest\.json$/i
/** The columns of `receipts export`, in this order (CSV header and JSON keys). / export 的列，按此顺序。 */
export const EXPORT_COLUMNS = Object.freeze(['ts', 'logged_at', 'id', 'container', 'format', 'path', 'status', 'stream', 'complete', 'model',
  'prompt_tokens', 'completion_tokens', 'cache_read', 'cache_write', 'amount', 'currency', 'prices', 'ok', 'problems', 'source'])

export const RNOTES = Object.freeze({
  files: T('Experimental, outside the compatibility promise. It reads files on this machine only: no network, no key, nothing uploaded.',
    '实验性，不受兼容承诺约束。只读本机文件：不联网、不需要密钥、不上传任何东西。'),
  page: T(`To check a receipt's hashes, paste it with its request and response bytes at ${VERIFY_PAGE} (a receipt passed on with those bytes contains that conversation).`,
    `要核对回执的哈希，把回执连同请求与回答字节贴到 ${VERIFY_PAGE}（连同这些字节一起交出的回执就包含那段对话）。`),
  snapshot: T("The snapshot is taken as given: whether its signer is the service's delegated key is a chain read (tapeapi-verify made it when the receipt arrived), not made here.",
    '快照按原样采用：它的签名地址是否为服务委托的密钥要读链才能确认（收到回执时 tapeapi-verify 读过），这里不读。'),
  // Printed right under the replay verdict, so a VERIFIED is never read without its limit (review B-2).
  // 紧接在重放结论下一行打印，使"通过"不会脱离它的限定被读到（审查 B-2）。
  verdict: T("(snapshot taken as given: whether its signer is the service's currently delegated key was not checked on chain here)",
    '（快照按原样采用：签名地址是否为服务当前委托的钥匙，这里未读链核对）'),
})

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
// Text from a file shown on a terminal: no control characters (an escape sequence would act on the terminal).
// 来自文件、显示在终端上的文本：去掉控制字符（转义序列会作用于终端）。
// eslint-disable-next-line no-control-regex
export const clean = (v) => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?') : '')
export const shellWord = (s) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`)
export const iso = (s) => new Date(s * 1000).toISOString().replace('.000Z', 'Z')
export const usage = (en, zh) => Object.assign(new Error(en), { zh, usage: true })

/**
 * A time given on the command line or found in a file, in unix seconds, or null: an integer (seconds; 13 digits or more
 * are milliseconds), an ISO date (2026-10-01, midnight UTC) or date and time. / 命令行或文件里的时间，换成 unix 秒。
 */
export function parseTime(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v >= 1e12 ? Math.floor(v / 1000) : Math.floor(v)
  if (typeof v !== 'string' || !v.trim()) return null
  const s = v.trim()
  if (/^\d+(\.\d+)?$/.test(s)) return parseTime(Number(s))
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s)
  return Number.isFinite(t) ? Math.floor(t / 1000) : null
}

/**
 * Output redaction, S1's rules (connect-cli.js: the values of secret-named environment variables, then key shapes),
 * except for what a receipt itself carries: its two hashes (64 hex digits, which the long-hex rule would blank), and its
 * id unless it holds an sk- token, a Bearer token or a 0x + 64 hex value. Addresses and signatures are never touched by
 * those rules. / 输出脱敏用 S1 的规则；回执本身带的两个哈希与 id（除非 id 里有 sk-、Bearer 或 0x 加 64 位十六进制）不脱敏。
 */
export function keepable(v) {
  if (typeof v !== 'string' || v.length < 32) return false
  if (/^[0-9a-fA-F]{64}$/.test(v)) return true
  return !/sk-|bearer|0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/i.test(v)
}
export function redactKeeping(text, keep = [], env = process.env) {
  let t = redactEnv(String(text), env)
  const marks = []
  ;[...new Set(keep)].filter(keepable).sort((a, b) => b.length - a.length).forEach((v, i) => {
    if (!t.includes(v)) return
    const m = `\u0000${i}\u0000`
    t = t.split(v).join(m); marks.push([m, v])
  })
  t = redactKeyShapes(t)
  for (const [m, v] of marks) t = t.split(m).join(v)
  return t
}
/** What a record carries that is not redacted (see redactKeeping). / 记录里不脱敏的值。 */
export function keepOf(recs) {
  const out = []
  for (const r of recs) {
    const e = r.envelope
    if (!isObj(e)) continue
    out.push(e.id, e.params?.requestSha256, e.result?.responseSha256)
  }
  return out.filter((v) => typeof v === 'string')
}

// ---------------------------------------------------------------------------------------------------------------
// Reading / 读取
// ---------------------------------------------------------------------------------------------------------------
/**
 * The file functions this module uses, from node:fs and node:path (or stand-ins in a test), and the working directory.
 * 本模块用到的文件函数（来自 node:fs 与 node:path，测试里可替换）与工作目录。
 * @param {{ readFileSync, readdirSync, statSync, writeFileSync, join, dirname, relative, isAbsolute }} fsAndPath
 */
export function hostOf(fsAndPath, cwd = process.cwd()) {
  for (const k of ['readFileSync', 'readdirSync', 'statSync', 'writeFileSync', 'join', 'dirname', 'relative', 'isAbsolute']) {
    if (typeof fsAndPath?.[k] !== 'function') throw new TypeError(`io.host needs ${k} (node:fs and node:path): sdk/bin/tapeapi.js passes them`)
  }
  return { ...fsAndPath, cwd }
}
/** The receipt files a --receipts path names: the file, or a directory's *.jsonl / *.json (not manifests), sorted. */
export function receiptFiles(path, h) {
  const st = h.statSync(path)
  if (!st.isDirectory()) return { dir: h.dirname(path), files: [path] }
  const files = h.readdirSync(path).filter((n) => /\.jsonl?$/i.test(n) && !MANIFEST_FILE.test(n)).sort().map((n) => h.join(path, n)).filter((f) => h.statSync(f).isFile())
  return { dir: path, files }
}
/** A path given on the command line, against the working directory. / 命令行给出的路径，相对工作目录。 */
export const at = (p, h) => (h.isAbsolute(p) ? p : h.join(h.cwd, p))
/** How a file is named in the output: relative to the working directory when inside it. / 输出里文件的写法。 */
export const shown = (file, h) => { const r = h.relative(h.cwd, file); return r && !r.startsWith('..') && !h.isAbsolute(r) ? r : file }

/**
 * Every receipt in `files`. A line of `tapeapi-verify --log` (it has `receipt` and `ok`) gives { logged, envelope }; a
 * bare envelope (it has `sig` and `result`) gives { logged: null, envelope }. Other lines are counted as skipped, with
 * where they are. A .json file holding one value (an object or an array) is read whole.
 * files 里的全部回执。tapeapi-verify --log 的一行给出 logged 与 envelope；裸信封只有 envelope；其它行记为跳过并给出位置。
 */
export function readRecords(files, h) {
  const records = [], skipped = []
  const take = (v, file, where) => {
    const source = `${shown(file, h)}:${where}`
    if (isObj(v) && 'receipt' in v && 'ok' in v) {
      const logged = { ts: typeof v.ts === 'string' ? v.ts : null, ok: v.ok === true, method: v.method, path: v.path, status: v.status, stream: v.stream, format: v.format,
        sidecarError: v.sidecarError === true, problems: Array.isArray(v.problems) ? v.problems.filter((p) => typeof p === 'string') : [] }
      records.push({ source, logged, envelope: isObj(v.receipt) ? v.receipt : null })
    } else if (isObj(v) && typeof v.sig === 'string' && isObj(v.result)) records.push({ source, logged: null, envelope: v })
    else skipped.push(source)
  }
  for (const file of files) {
    const text = h.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    if (/\.json$/i.test(file)) {
      let whole
      try { whole = JSON.parse(text) } catch { whole = undefined }
      if (whole !== undefined) { (Array.isArray(whole) ? whole : [whole]).forEach((v, i) => take(v, file, Array.isArray(whole) ? `[${i}]` : 1)); continue }
    }
    text.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return
      let v
      try { v = JSON.parse(line) } catch { skipped.push(`${shown(file, h)}:${i + 1}`); return }
      take(v, file, i + 1)
    })
  }
  return { records, skipped }
}

/**
 * Manifest snapshots: the --manifest file, or every manifest.json / *.manifest.json in `dir`. Each is { source, manifest }.
 * A file that is not a JSON object with a container is listed in `bad`. / 清单快照：--manifest 指定的文件，或 dir 里的快照。
 */
export function readManifests({ file = null, dir = null } = {}, h) {
  const names = file ? [file] : (() => { try { return h.readdirSync(dir).filter((n) => MANIFEST_FILE.test(n)).sort().map((n) => h.join(dir, n)) } catch { return [] } })()
  const manifests = [], bad = []
  for (const f of names) {
    let m
    try { m = JSON.parse(h.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) } catch { m = null }
    if (isObj(m) && typeof m.container === 'string') manifests.push({ source: shown(f, h), manifest: m })
    else bad.push(shown(f, h))
  }
  return { manifests, bad }
}
/** The snapshots for a container (any case). / 某容器的快照。 */
export const snapshotsFor = (manifests, container) => manifests.filter((m) => typeof container === 'string' && m.manifest.container.toLowerCase() === container.toLowerCase())

/** When a record was made: the receipt's signed time, else the log line's time. / 记录的时间：回执签名时间，否则日志行时间。 */
export const timeOf = (rec) => (Number.isSafeInteger(rec.envelope?.ts) ? rec.envelope.ts : parseTime(rec.logged?.ts))

/** The fields of a record, as text and numbers for the columns of export (EXPORT_COLUMNS). / 记录的各列。 */
export function rowOf(rec) {
  const e = isObj(rec.envelope) ? rec.envelope : null, r = isObj(e?.result) ? e.result : null, u = isObj(r?.usage) ? r.usage : null
  const prices = Array.isArray(r?.prices) ? r.prices.filter(isObj) : null
  const n = (v) => (Number.isSafeInteger(v) ? v : '')
  return {
    ts: Number.isSafeInteger(e?.ts) ? iso(e.ts) : '',
    logged_at: clean(rec.logged?.ts ?? ''),
    id: clean(e?.id ?? ''),
    container: clean(e?.container ?? ''),
    format: clean((e && formatOfMethod(e.method)?.name) ?? rec.logged?.format ?? ''),
    path: clean(e?.params?.path ?? rec.logged?.path ?? ''),
    status: n(r?.status ?? rec.logged?.status),
    stream: typeof r?.stream === 'boolean' ? r.stream : '',
    complete: typeof r?.complete === 'boolean' ? r.complete : '',
    model: clean(r?.model ?? ''),
    prompt_tokens: n(u?.prompt_tokens), completion_tokens: n(u?.completion_tokens), cache_read: n(u?.cache_read_tokens), cache_write: n(u?.cache_write_tokens),
    amount: clean(prices?.[0]?.amount ?? ''), currency: clean(prices?.[0]?.currency ?? ''),
    prices: prices ? prices.map((p) => `${clean(p.amount)} ${clean(p.currency)}`).join(' / ') : '',
    ok: rec.logged ? rec.logged.ok : '',
    problems: clean((rec.logged?.problems ?? []).join('; ')),
    source: rec.source,
  }
}

/**
 * Keep the records that pass the filters: containers (a set of lower-case addresses), model (exact), since / until (unix
 * seconds; since inclusive, until exclusive), fail (only those the log marked failed, or with no receipt).
 * 按条件过滤：容器、模型（精确）、起止时间（含起不含止）、只看失败。
 */
export function filterRecords(recs, { containers = null, model = null, since = null, until = null, fail = false } = {}) {
  return recs.filter((rec) => {
    const e = rec.envelope
    if (containers && !(typeof e?.container === 'string' && containers.has(e.container.toLowerCase()))) return false
    if (model !== null && e?.result?.model !== model) return false
    const t = timeOf(rec)
    if (since !== null && !(t !== null && t >= since)) return false
    if (until !== null && !(t !== null && t < until)) return false
    if (fail && !(rec.logged ? rec.logged.ok !== true : !e)) return false
    return true
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Arguments and output / 参数与输出
// ---------------------------------------------------------------------------------------------------------------
/**
 * A small option parser: `spec` maps --flag to 'bool' or 'value' (and an alias to its flag name); returns
 * { opts, positional }. Unknown options and a missing value are usage mistakes.
 * 小型参数解析：未知选项与缺值都是用法错误。
 */
export function parseOptions(argv, spec) {
  const opts = {}, positional = []
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], v
    const eq = a.startsWith('--') ? a.indexOf('=') : -1
    if (eq > 0) { v = a.slice(eq + 1); a = a.slice(0, eq) }
    let kind = spec[a]
    if (typeof kind === 'string' && kind.startsWith('-')) { a = kind; kind = spec[a] }
    if (kind === undefined) {
      if (a.startsWith('-') && a !== '-') throw usage(`unknown option ${a}`, `未知选项 ${a}`)
      positional.push(a); continue
    }
    if (kind === 'bool') { if (v !== undefined) throw usage(`${a} takes no value`, `${a} 不带值`); opts[a] = true; continue }
    if (v === undefined) { if (i + 1 >= argv.length) throw usage(`${a} needs a value`, `${a} 需要一个值`); v = argv[++i] }
    opts[a] = v
  }
  return { opts, positional }
}
export function commonOptions(opts) {
  const lang = opts['--lang'] ?? 'both'
  if (!['en', 'zh', 'both'].includes(lang)) throw usage('--lang must be en, zh or both', '--lang 只能是 en、zh 或 both')
  return { lang, json: opts['--json'] === true, noColor: opts['--no-color'] === true }
}
/** --since / --until as unix seconds; a usage mistake when not a time. / 起止时间。 */
export function timeOptions(opts) {
  const out = {}
  for (const [flag, key] of [['--since', 'since'], ['--until', 'until']]) {
    if (opts[flag] === undefined) { out[key] = null; continue }
    const t = parseTime(opts[flag])
    if (t === null) throw usage(`${flag} must be a date (2026-10-01), a date and time (2026-10-01T08:00:00Z) or unix seconds`, `${flag} 必须是日期（2026-10-01）、日期时间（2026-10-01T08:00:00Z）或 unix 秒`)
    out[key] = t
  }
  return out
}

/**
 * The terminal helpers for one run: labels and sentences in the chosen language, colors on the marks only (so that
 * removing them gives the uncolored text), the next line. / 一次运行的输出助手：按语言输出标签与句子，只给标记上色，下一条命令。
 */
export function ui({ lang = 'both', color = false } = {}) {
  const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
  const lab = (t) => (lang === 'en' || t.en === t.zh ? t.en : lang === 'zh' ? t.zh : `${t.en} / ${t.zh}`)
  const say = (t, indent = '') => (lang === 'en' ? [indent + t.en] : lang === 'zh' ? [indent + t.zh] : [indent + t.en, indent + t.zh])
  const nextWord = lang === 'en' ? 'next:' : lang === 'zh' ? '下一条命令:' : 'next: / 下一条命令:'
  const experimental = lang === 'en' ? '(experimental)' : lang === 'zh' ? '（实验性）' : '(experimental / 实验性)'
  return { lang, lab, say, experimental, green: paint('32'), red: paint('31'), yellow: paint('33'), bold: paint('1'), next: (cmd) => `${nextWord} ${cmd}` }
}
/** Columns padded to the widest cell; nothing is cut (ids and addresses are copied). / 按最宽单元格补齐，不截断。 */
export function table(rows, indent = '  ') {
  const w = []
  for (const r of rows) r.forEach((c, i) => { w[i] = Math.max(w[i] ?? 0, width(c)) })
  return rows.map((r) => indent + r.map((c, i) => (i === r.length - 1 ? String(c) : String(c) + ' '.repeat(w[i] - width(c)))).join('  ').trimEnd())
}
/** Columns a text takes on a terminal: colors take none, CJK and full-width characters two. / 文本在终端上占的列数。 */
export function width(s) {
  let n = 0
  for (const ch of String(s).replace(/\x1b\[[0-9;]*m/g, '')) n += /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1 // eslint-disable-line no-control-regex
  return n
}
export const padTo = (s, n) => String(s) + ' '.repeat(Math.max(0, n - width(s)))
/** A usage mistake: both languages on stderr, the help, and the next command; exit 2. / 用法错误：双语写到 stderr，退出 2。 */
export function usageExit({ e, prog, help, cmd, stderr, say }) {
  say(stderr, `${prog}: ${e.message}\n${prog}: ${e.zh ?? e.message}\n\n${help}\nnext: / 下一条命令: ${cmd} --help\n`)
  return { exitCode: 2 }
}

// ---------------------------------------------------------------------------------------------------------------
// Replay / 离线重放
// ---------------------------------------------------------------------------------------------------------------
const UNCHECKED = {
  request: T('request hash: give --request <file>, the exact bytes sent (salted by tapeapi-verify unless --no-salt)', '请求哈希：用 --request <文件> 给出发送的确切字节（tapeapi-verify 默认加盐，除非 --no-salt）'),
  response: T('response hash: give --response <file>, the exact bytes received', '回答哈希：用 --response <文件> 给出收到的确切字节'),
  id: T("the answer's own id, model and usage: they need the response bytes", '回答自己的 id、模型与用量：需要回答字节'),
  complete: T('whether the answer completed: it needs the response bytes', '回答是否完整：需要回答字节'),
  freshness: T('the time window: applied when the receipt arrives, not to an old receipt', '时间窗口：收到回执时检查，不适用于旧回执'),
}
const uncheckedKeys = (list) => [...new Set(list.map((k) => (k === 'model' || k === 'usage' ? 'id' : k)))].filter((k) => UNCHECKED[k])

/**
 * Replay the checks of one receipt (ai.verifyUsageReceipt, pure) against the snapshots for its container: the signature
 * and its signer, the container, the method and path, the price table, and the hashes when the bytes are given; no
 * time window. With no snapshot for the container: decided false. When no snapshot names its container but exactly one
 * was given, that one is used (a changed container then shows as a problem, not as "undecided").
 * 用该容器的快照离线重放一张回执的核验：签名与签名地址、容器、方法与路径、价目表；给了字节就核对哈希；不检查时间窗口。
 */
export function replay(rec, manifests, { requestBytes, responseBytes } = {}) {
  const e = rec.envelope
  let cands = snapshotsFor(manifests, e?.container)
  if (!cands.length && manifests.length === 1) cands = manifests
  if (!cands.length) return { decided: false, snapshots: manifests.length }
  let best = null
  for (const m of cands) {
    const v = verifyUsageReceipt({ envelope: e, manifest: m.manifest, ...(requestBytes !== undefined ? { requestBytes } : {}), ...(responseBytes !== undefined ? { responseBytes } : {}) })
    if (!best || (v.ok && !best.v.ok)) best = { m, v }
    if (v.ok) break
  }
  const { v, m } = best
  return { decided: true, ok: v.ok, problems: v.problems, warnings: v.warnings, unchecked: uncheckedKeys(v.unchecked), snapshot: m.source, signer: typeof m.manifest.signer === 'string' ? m.manifest.signer : null, signerCheckedOnChain: false, tried: cands.length }
}

// ---------------------------------------------------------------------------------------------------------------
// tapeapi receipts
// ---------------------------------------------------------------------------------------------------------------
export function receiptsUsage(cmd = 'tapeapi') {
  return `${cmd} receipts (experimental / 实验性): list, show and export the usage receipts saved on this machine.
列出、查看与导出本机保存的用量回执。

Usage:
  ${cmd} receipts tail   --receipts <file|dir> [-n 20] [--fail] [filters] [--json]
  ${cmd} receipts show   <id> --receipts <file|dir> [--manifest <file>] [--request <file>] [--response <file>] [--json]
  ${cmd} receipts export --receipts <file|dir> [filters] [--format csv|json] [--out <file>]

  --receipts <path>    the file tapeapi-verify --log wrote (JSON lines), or a directory of such files (*.jsonl, *.json);
                       bare receipt envelopes are read too. Also --log <path>
                       tapeapi-verify --log 写的文件（JSON 行），或放这些文件的目录；裸回执信封也能读
  --service <s>        only one service: its container address, or the name in a manifest snapshot (the log itself
                       holds no names)        只看一个服务：容器地址，或清单快照里的名字（日志本身不含名字）
  --container <addr>   only this container       --model <id>   only this model (exact)
  --since <t>, --until <t>
                       signed at or after / before: 2026-10-01, 2026-10-01T08:00:00Z or unix seconds
  -n <count>           tail: how many, the last ones (default 20)     --fail   tail: only calls the log marks failed
  --manifest <file>    show: the manifest to check against. Default: manifest.json or *.manifest.json next to the
                       receipts (save the manifest the service publishes there). None: nothing is decided (exit 3)
                       show：核对所依据的清单。默认：回执旁的 manifest.json 或 *.manifest.json（把服务发布的清单存在那里）。没有就不判定（退出 3）
  --request <file>, --response <file>
                       show: the exact bytes sent and received, to check the two hashes. tapeapi-verify salts a
                       request by default, so the bytes it sent are not the client's: only a run with --no-salt leaves
                       request bytes that can be checked later      show：发送与收到的确切字节，用来核对两个哈希。tapeapi-verify
                       默认给请求加盐，发出的字节与客户端的不同：只有用 --no-salt 运行时，事后才有可核对的请求字节
  --format csv|json    export (default csv; also --csv, --json). Columns, in this order: ${EXPORT_COLUMNS.join(', ')}
  --out <file>         export: write there (mode 600) instead of stdout
  --json               one JSON object on stdout     --lang <en|zh|both>   (default both)     --no-color
  --help

It reads files only: no network, no key asked for, nothing uploaded. Output redaction as tapeapi connect's (secret-named
environment variables, key shapes); the hashes, ids and addresses a receipt carries are shown as they are.
只读文件：不联网、不索要密钥、不上传。输出脱敏同 tapeapi connect；回执本身带的哈希、id 与地址原样显示。
A receipt proves who signed which request and response bytes and what usage and price were claimed; it does not prove
which model ran. 回执证明谁签了哪些请求与回答字节、声称了多少用量与价格；不证明实际运行的是哪个模型。
Exit status: 0 done (show: the replayed checks passed); 1 show: a check failed; 2 a usage mistake (also an id not in the
files); 3 show: no manifest snapshot for the receipt, nothing decided.
退出码：0 完成（show：重放的核验通过）；1 show：有核验未通过；2 用法错误（id 不在文件里也算）；3 show：没有该回执的清单快照，无法判定。
`
}

const RECEIPTS_SPEC = {
  '--receipts': 'value', '--log': '--receipts', '--service': 'value', '--container': 'value', '--model': 'value', '--since': 'value', '--until': 'value',
  '-n': 'value', '--lines': '-n', '--fail': 'bool', '--manifest': 'value', '--request': 'value', '--response': 'value',
  '--format': 'value', '--csv': 'bool', '--out': 'value', '--json': 'bool', '--lang': 'value', '--no-color': 'bool', '--help': 'bool', '-h': '--help',
}

/**
 * Read the --receipts source and the snapshots, and resolve the filters. Throws a usage error. / 读取来源与快照并解析过滤条件。
 */
export function loadSource(opts, h) {
  const path = opts['--receipts']
  if (!path) throw usage(`--receipts <file|dir> is needed: the file tapeapi-verify --log wrote, or a directory of them`, `需要 --receipts <文件|目录>：tapeapi-verify --log 写的文件，或放这些文件的目录`)
  let src
  try { src = receiptFiles(at(path, h), h) } catch (e) { throw usage(`cannot read ${path}: ${e.code ?? e.message}`, `读不了 ${path}：${e.code ?? e.message}`) }
  let records, skipped
  try { ({ records, skipped } = readRecords(src.files, h)) } catch (e) { throw usage(`cannot read ${e.path ?? path}: ${e.code ?? e.message}`, `读不了 ${e.path ?? path}：${e.code ?? e.message}`) }
  if (opts['--manifest'] !== undefined) {
    try { h.statSync(at(opts['--manifest'], h)) } catch (e) { throw usage(`cannot read --manifest ${opts['--manifest']}: ${e.code ?? e.message}`, `读不了 --manifest ${opts['--manifest']}：${e.code ?? e.message}`) }
  }
  const { manifests, bad } = readManifests({ file: opts['--manifest'] !== undefined ? at(opts['--manifest'], h) : null, dir: src.dir }, h)
  if (opts['--manifest'] !== undefined && !manifests.length) throw usage(`--manifest ${opts['--manifest']} is not a manifest (a JSON object with a container)`, `--manifest ${opts['--manifest']} 不是清单（带 container 的 JSON 对象）`)
  let containers = null
  for (const [flag, v] of [['--container', opts['--container']], ['--service', opts['--service']]]) {
    if (v === undefined) continue
    let set
    if (ADDRESS_RE.test(v)) set = new Set([v.toLowerCase()])
    else if (flag === '--container') throw usage('--container must be an address (0x and 40 hex digits)', '--container 必须是地址（0x 加 40 位十六进制）')
    else {
      const hit = manifests.filter((m) => typeof m.manifest.name === 'string' && m.manifest.name.toLowerCase() === v.toLowerCase())
      if (!hit.length) throw usage(`no manifest snapshot next to the receipts is named ${JSON.stringify(v)}; the log holds container addresses, not names: give --service <container address>`, `回执旁没有名为 ${JSON.stringify(v)} 的清单快照；日志里只有容器地址、没有名字：请用 --service <容器地址>`)
      set = new Set(hit.map((m) => m.manifest.container.toLowerCase()))
    }
    containers = containers ? new Set([...containers].filter((c) => set.has(c))) : set
  }
  const filters = { containers, model: opts['--model'] ?? null, ...timeOptions(opts) }
  return { path, src, records, skipped, manifests, badManifests: bad, filters }
}

/**
 * Run `tapeapi receipts` with `argv`. Returns { exitCode }. io: host (node:fs and node:path functions, see hostOf), cmd,
 * version, stdout / stderr (write functions), env, isTTY, cwd. / 运行 tapeapi receipts；io 注入文件函数、命令写法、版本、输出、
 * 环境、是否终端、工作目录。
 */
export async function runReceipts(argv, io = {}) {
  const { cmd = 'tapeapi', version = '', env = process.env } = io
  const h = hostOf(io.host, io.cwd ?? process.cwd())
  const stdout = io.stdout ?? ((s) => process.stdout.write(s))
  const stderr = io.stderr ?? ((s) => process.stderr.write(s))
  const isTTY = io.isTTY ?? process.stdout.isTTY === true
  let keep = []
  const say = (write, text) => write(redactKeeping(text, keep, env))
  const help = receiptsUsage(cmd)
  const [sub, ...rest] = argv
  let parsed, common, src
  try {
    if (sub === '--help' || sub === '-h' || sub === 'help') { say(stdout, help); return { exitCode: 0 } }
    if (!['tail', 'show', 'export'].includes(sub)) throw usage(sub === undefined ? 'no subcommand: tail, show or export' : `unknown subcommand ${JSON.stringify(sub)}: tail, show or export`, sub === undefined ? '没有子命令：tail、show 或 export' : `未知子命令 ${JSON.stringify(sub)}：tail、show 或 export`)
    parsed = parseOptions(rest, RECEIPTS_SPEC)
    if (parsed.opts['--help']) { say(stdout, help); return { exitCode: 0 } }
    common = commonOptions(parsed.opts)
    const o = parsed.opts
    const allowed = { tail: ['-n', '--fail'], show: ['--manifest', '--request', '--response'], export: ['--format', '--csv', '--out'] }
    for (const [s, flags] of Object.entries(allowed)) for (const f of flags) if (s !== sub && o[f] !== undefined && !(f === '--manifest')) throw usage(`${f} applies to receipts ${s} only`, `${f} 只用于 receipts ${s}`)
    if (sub === 'show' ? parsed.positional.length !== 1 : parsed.positional.length) throw usage(sub === 'show' ? 'give one receipt id: receipts show <id>' : `unexpected ${JSON.stringify(parsed.positional[0])}`, sub === 'show' ? '请给出一个回执 id：receipts show <id>' : `多余的参数 ${JSON.stringify(parsed.positional[0])}`)
    if (sub === 'tail' && o['-n'] !== undefined && !/^\d+$/.test(o['-n'])) throw usage('-n must be a whole number', '-n 必须是整数')
    if (sub === 'export') {
      if (o['--format'] !== undefined && !['csv', 'json'].includes(o['--format'])) throw usage('--format must be csv or json', '--format 只能是 csv 或 json')
      if ([o['--format'] !== undefined, o['--csv'] === true, o['--json'] === true].filter(Boolean).length > 1) throw usage('give one of --format, --csv, --json', '--format、--csv、--json 只能给一个')
    }
    src = loadSource(o, h)
  } catch (e) {
    if (!e.usage) throw e
    return usageExit({ e, prog: `${cmd} receipts`, help, cmd: `${cmd} receipts`, stderr, say })
  }
  const o = parsed.opts
  const U = ui({ lang: common.lang, color: !common.noColor && isTTY && !common.json && (env.NO_COLOR === undefined || env.NO_COLOR === '') && sub !== 'export' })
  keep = keepOf(src.records)
  const head = `tapeapi receipts ${sub}${version ? ` ${version}` : ''} ${U.experimental}`
  const srcLine = (all) => {
    const n = [all.length, all.filter((r) => r.envelope).length, all.filter((r) => r.logged && !r.logged.ok).length, src.skipped.length]
    const where = n[3] ? ` (${src.skipped.slice(0, 5).join(', ')}${n[3] > 5 ? ', …' : ''})` : ''
    const en = `${n[0]} records, ${n[1]} receipts, ${n[2]} marked failed${n[3] ? `, ${n[3]} lines skipped${where}` : ''}`
    const zh = `${n[0]} 条记录，${n[1]} 张回执，${n[2]} 条标记失败${n[3] ? `，${n[3]} 行跳过${where}` : ''}`
    return `${clean(src.path)}   ${U.lang === 'zh' ? zh : en}`
  }

  if (sub === 'tail' || sub === 'export') {
    const recs = filterRecords(src.records, { ...src.filters, fail: o['--fail'] === true })
    if (sub === 'export') {
      const fmt = o['--format'] ?? (o['--json'] ? 'json' : 'csv')
      const rows = recs.map(rowOf)
      const text = fmt === 'csv'
        ? [EXPORT_COLUMNS.join(','), ...rows.map((r) => EXPORT_COLUMNS.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n'
        : JSON.stringify({ tool: 'tapeapi', command: 'receipts export', version, experimental: true, ok: true, exitCode: 0, source: src.path, columns: EXPORT_COLUMNS, items: rows, skipped: src.skipped, next: null }, null, 2) + '\n'
      if (o['--out'] !== undefined) {
        h.writeFileSync(at(o['--out'], h), redactKeeping(text, keep, env), { mode: 0o600 })
        say(stderr, `${head}: ${rows.length} ${U.lang === 'zh' ? '行写入' : 'rows written to'} ${o['--out']} (${fmt})\n`)
      } else say(stdout, text)
      return { exitCode: 0 }
    }
    const n = o['-n'] !== undefined ? Number(o['-n']) : 20
    const last = n === 0 ? [] : recs.slice(-n)
    if (common.json) {
      say(stdout, JSON.stringify({ tool: 'tapeapi', command: 'receipts tail', version, experimental: true, ok: true, exitCode: 0, source: src.path,
        counts: { records: src.records.length, matching: recs.length, shown: last.length, skipped: src.skipped.length }, skipped: src.skipped, items: last.map(rowOf), next: null }, null, 2) + '\n')
      return { exitCode: 0 }
    }
    const out = [head, `  ${srcLine(src.records)}`]
    if (!last.length) out.push(...U.say(T('No receipt matches.', '没有符合条件的回执。'), '  '))
    else {
      const L = (en, zh) => (U.lang === 'en' ? en : U.lang === 'zh' ? zh : en)
      const rows = [[L('signed at', '签名时间'), 'ok', L('path', '路径'), L('model', '模型'), 'in', 'out', 'cache_r', L('price', '价格'), 'id', L('problems', '问题')]]
      for (const rec of last) {
        const r = rowOf(rec)
        const mark = rec.logged ? (rec.logged.ok ? U.green('OK  ') : U.red('FAIL')) : '--  '
        rows.push([r.ts || r.logged_at || '-', mark, r.path || '-', r.model || '-', r.prompt_tokens === '' ? '-' : r.prompt_tokens, r.completion_tokens === '' ? '-' : r.completion_tokens, r.cache_read === '' ? '-' : r.cache_read, r.prices || '-', r.id || '-', r.problems])
      }
      out.push(...table(rows))
      out.push(...U.say(T("ok: the verdict tapeapi-verify logged when the call was made ('--' for a bare receipt). receipts show <id> replays one receipt's checks.",
        'ok：调用时 tapeapi-verify 记录的结论（裸回执为 "--"）。receipts show <id> 重放一张回执的核验。'), '  '))
    }
    out.push(...U.say(NOTES.receipt), ...U.say(RNOTES.page), ...U.say(RNOTES.files))
    say(stdout, out.join('\n') + '\n')
    return { exitCode: 0 }
  }

  // show <id>
  const id = parsed.positional[0]
  const recs = filterRecords(src.records, src.filters).filter((r) => r.envelope?.id === id)
  if (!recs.length) {
    const e = usage(`no receipt with id ${JSON.stringify(id)} in ${src.path}${src.filters.containers || src.filters.model || src.filters.since !== null || src.filters.until !== null ? ' (with the filters given)' : ''}`, `${src.path} 里没有 id 为 ${JSON.stringify(id)} 的回执${src.filters.containers || src.filters.model || src.filters.since !== null || src.filters.until !== null ? '（按给出的过滤条件）' : ''}`)
    say(stderr, `${cmd} receipts: ${e.message}\n${cmd} receipts: ${e.zh}\nnext: / 下一条命令: ${cmd} receipts tail --receipts ${shellWord(src.path)}\n`)
    return { exitCode: 2 }
  }
  let bytes = {}
  try {
    for (const [flag, key] of [['--request', 'requestBytes'], ['--response', 'responseBytes']]) if (o[flag] !== undefined) bytes[key] = new Uint8Array(h.readFileSync(at(o[flag], h)))
  } catch (e) {
    return usageExit({ e: usage(`cannot read ${e.path ?? 'a bytes file'}: ${e.code ?? e.message}`, `读不了 ${e.path ?? '字节文件'}：${e.code ?? e.message}`), prog: `${cmd} receipts`, help, cmd: `${cmd} receipts`, stderr, say })
  }
  const results = recs.map((rec) => ({ rec, row: rowOf(rec), replay: replay(rec, src.manifests, bytes) }))
  const exitCode = results.some((x) => x.replay.decided && !x.replay.ok) ? 1 : results.some((x) => !x.replay.decided) ? 3 : 0
  const showCmd = `${cmd} receipts show ${shellWord(id)} --receipts ${shellWord(src.path)}`
  const next = exitCode === 3 ? `${showCmd} --manifest <manifest.json>` : exitCode === 1 ? `${cmd} receipts tail --receipts ${shellWord(src.path)} --fail` : null
  if (common.json) {
    say(stdout, JSON.stringify({ tool: 'tapeapi', command: 'receipts show', version, experimental: true, ok: exitCode === 0, exitCode, id,
      items: results.map((x) => ({ source: x.rec.source, fields: x.row, receipt: x.rec.envelope, logged: x.rec.logged ? { ts: x.rec.logged.ts, ok: x.rec.logged.ok, problems: x.rec.logged.problems } : null, replay: x.replay })),
      notes: { receipt: pick(U, NOTES.receipt), snapshot: pick(U, RNOTES.snapshot), page: pick(U, RNOTES.page) }, next }, null, 2) + '\n')
    return { exitCode }
  }
  const out = [head]
  const lab = (t) => padTo(U.lab(t), U.lang === 'both' ? 36 : U.lang === 'zh' ? 14 : 18)
  results.forEach((x, i) => {
    const { rec, row: r, replay: v } = x
    const e = rec.envelope
    if (results.length > 1) out.push('', `  [${i + 1}/${results.length}]`)
    out.push(`  ${lab(T('source', '出处'))}${rec.source}`,
      `  ${lab(T('id', 'id'))}${r.id}`,
      `  ${lab(T('container', '容器'))}${r.container}`,
      `  ${lab(T('format and path', '格式与路径'))}${r.format || clean(e.method)}  POST ${r.path}`,
      `  ${lab(T('signed at', '签名时间'))}${r.ts}${Number.isSafeInteger(e.ts) ? `  (ts ${e.ts})` : ''}`,
      `  ${lab(T('status', '状态'))}HTTP ${r.status}  stream ${r.stream}  complete ${r.complete}`,
      `  ${lab(T('model', '模型'))}${r.model || 'null'}${e.result?.modelMatchedBy ? `  (matched by ${clean(e.result.modelMatchedBy)})` : ''}`,
      `  ${lab(T('usage', '用量'))}${isObj(e.result?.usage) ? Object.entries(e.result.usage).map(([k, n]) => `${clean(k)}=${isObj(n) ? clean(JSON.stringify(n)) : clean(n)}`).join('  ') : 'null'}`,
      `  ${lab(T('prices claimed', '声称的价格'))}${r.prices || 'null'}`,
      `  ${lab(T('requestSha256', '请求哈希'))}${clean(e.params?.requestSha256)}`,
      `  ${lab(T('responseSha256', '回答哈希'))}${clean(e.result?.responseSha256)}`,
      `  ${lab(T('signature', '签名'))}${clean(e.sig)}`)
    if (rec.logged) out.push(`  ${lab(T('logged verdict', '记录的结论'))}${rec.logged.ok ? U.green('OK') : U.red('FAIL')}  (tapeapi-verify, ${clean(rec.logged.ts) || '-'})${rec.logged.problems.length ? `  ${clean(rec.logged.problems.join('; '))}` : ''}`)
    out.push('')
    if (!v.decided) {
      out.push(`  ${U.yellow(U.lab(T('replay: CANNOT DECIDE', '离线重放：无法判定')))}`,
        ...U.say(v.snapshots ? T(`none of the ${v.snapshots} manifest snapshots is for container ${r.container}; nothing is fetched to fill the gap.`, `${v.snapshots} 份清单快照里没有容器 ${r.container} 的；不会联网去补。`)
          : T('no manifest snapshot: none was given (--manifest) and there is none next to the receipts (manifest.json, *.manifest.json); nothing is fetched to fill the gap.', '没有清单快照：没有给出 --manifest，回执旁也没有（manifest.json、*.manifest.json）；不会联网去补。'), '    '))
      return
    }
    out.push(`  ${v.ok ? U.green(U.lab(T('replay: VERIFIED', '离线重放：通过'))) : U.red(U.lab(T('replay: FAILED', '离线重放：未通过')))}   ${U.lab(T('against', '依据'))} ${v.snapshot}${v.signer ? `  signer ${clean(v.signer)}` : ''}${v.tried > 1 ? `  (${v.tried} snapshots for this container)` : ''}`,
      ...U.say(RNOTES.verdict, '    '))
    const checked = [T('signature and signer', '签名与签名地址'), T('container', '容器'), T('method and path', '方法与路径'), T('price table', '价目表'),
      ...(bytes.requestBytes ? [T('request hash', '请求哈希')] : []), ...(bytes.responseBytes ? [T('response hash, id, model, usage', '回答哈希、id、模型、用量')] : [])]
    out.push(`    ${U.lab(T('checked', '已核'))}: ${checked.map((t) => (U.lang === 'zh' ? t.zh : t.en)).join(', ')}`)
    for (const p of v.problems) out.push(`    ${U.red(U.lab(T('problem', '问题')))}: ${clean(p)}`)
    for (const w of v.warnings) out.push(`    ${U.yellow(U.lab(T('warning', '提示')))}: ${clean(w)}`)
    for (const k of v.unchecked) out.push(`    ${U.lab(T('not checked', '未核'))}: ${U.lang === 'zh' ? UNCHECKED[k].zh : UNCHECKED[k].en}`)
  })
  out.push('', ...U.say(RNOTES.snapshot), ...U.say(NOTES.receipt), ...U.say(RNOTES.page), ...U.say(RNOTES.files))
  if (next) out.push(U.next(next))
  say(stdout, out.join('\n') + '\n')
  return { exitCode }
}
const pick = (U, t) => (U.lang === 'en' ? t.en : U.lang === 'zh' ? t.zh : t)

/** One CSV cell (RFC 4180), with a leading = + - @ neutralised so a spreadsheet does not run it. / 一个 CSV 单元格。 */
export function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v)
  if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-\d+(\.\d+)?$/.test(s))) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
