// `tapeapi prices convert|check|show` on the command line (@experimental; outside the compatibility promise). An entry,
// not a converter: `convert` and `check` run new-api's price converter, examples/new-api-sidecar/pricing-convert.mjs
// (`tapeapi-newapi-prices`), with the arguments as given (`check` adds its --check), its rules, output and exit status
// (0 / 1 drift / 2) unchanged; the converter stays in examples/ and exists in a checkout only, so outside one these two
// print the clone command. `show` reads files on this machine only: a price table and the source record the converter
// wrote next to it (models.newapi-source.json), and prints them with who fetched the price list and what is not
// verified. No network, no key, nothing uploaded, nothing paid.
// tapeapi prices 命令行部分（实验性，不受兼容承诺约束）。只是入口，不是转换器：convert 与 check 原样运行 new-api 价目转换器
// （examples/new-api-sidecar/pricing-convert.mjs，参数原样传入，check 加上它的 --check），规则、输出与退出码都不变；转换器留在
// examples/，只在检出里有，所以检出之外这两个子命令打印克隆命令。show 只读本机文件：价目表与转换器在它旁边写下的来源记录，并写明
// 取价身份与未核实的部分。不联网、不需要密钥、不上传、不付款。
// Like every module under src/, it imports nothing Node-only: the file functions come in as io.host, the converter as
// io.converter (sdk/bin/tapeapi.js loads it from the checkout). / 与 src/ 下所有模块一样不引用仅限 Node 的模块。
import { redactOutput, redactEnv } from './connect-cli.js'
import { NOTES } from './connect.js'
import { priceHints } from './doctor.js'
import { T, hostOf, at, shown, clean, shellWord, usage, parseOptions, commonOptions, ui, table, usageExit, redactKeeping } from './receipts-cli.js'

/** The converter's name in its source records (pricing-convert.mjs TOOL). / 转换器在来源记录里的名字。 */
export const CONVERTER_TOOL = 'tapeapi-newapi-prices'
/** Where the converter is, in a checkout. / 转换器在检出里的位置。 */
export const CONVERTER_PATH = 'examples/new-api-sidecar/pricing-convert.mjs'
export const CLONE = 'git clone https://github.com/BruceLanLan/tapeapi.git && cd tapeapi && npm ci --no-audit --no-fund'
/** The source record next to a price table, named as the converter names it (models.json -> models.newapi-source.json). */
export const sourceRecordOf = (models) => (models.endsWith('.json') ? models.slice(0, -5) : models) + '.newapi-source.json'

export const PNOTES = Object.freeze({
  entry: T(`An entry for ${CONVERTER_PATH} (${CONVERTER_TOOL}): its rules, output and exit status as they are. It reads files only: save GET /api/pricing and GET /api/status of your own new-api first.`,
    `${CONVERTER_PATH}（${CONVERTER_TOOL}）的入口：规则、输出与退出码原样不变。它只读文件：先自己存下你自己的 new-api 的 GET /api/pricing 与 GET /api/status。`),
  unverified: T("unverified: USD here is new-api's quota dollar (model_ratio x 1000000 / quota_per_unit), read from new-api's source code and not yet checked against a real instance; for display only, not what a user pays.",
    '未核实：这里的 USD 是 new-api 的额度美元（倍率 x 1000000 / quota_per_unit），读自 new-api 源码，尚未在真实实例上核对；仅作展示，不是用户实际支付的金额。'),
  fetchedAs: T('fetched as (who fetched /api/pricing): its content depends on it. Fetch it anonymously, or as an ordinary user, never as an administrator.',
    '取价身份（谁取的 /api/pricing）：内容取决于它。请匿名取，或用普通用户取，绝不用管理员。'),
  publish: T('Once published on chain (holder console step 5) the table is a public statement whose history cannot be deleted: read every REFUSED, REVIEW and NOTE line before publishing.',
    '在链上发布（操作台第 5 步）之后，价目表是公开声明，历史删不掉：发布前逐条阅读每一行 REFUSED、REVIEW 与 NOTE。'),
})

export function pricesUsage(cmd = 'tapeapi') {
  return `${cmd} prices (experimental / 实验性): turn new-api's price list into the price table, check it for drift, show it.
把 new-api 的价目转成价目表、检查是否漂移、显示价目表。

Usage:
  ${cmd} prices convert <pricing.json> --usd-exchange-rate <n> [--status <status.json> | --quota-per-unit <n>]
                 [--fetched-as anonymous|user] [--out models.json] [--exclude <model>]... [--video <model>]...
                 [--accept-ratio-37.5 <model>]...
  ${cmd} prices check   <pricing.json> --models <models.json> [--meta <models.newapi-source.json>] [--status <status.json>]
                 [--fetched-as anonymous|user]
  ${cmd} prices show    [--models <models.json>] [--meta <models.newapi-source.json>] [--json] [--lang en|zh|both]

  convert, check       run ${CONVERTER_PATH} (${CONVERTER_TOOL}) with these arguments as they are
                       (check = its --check); its rules, its output and its exit status are unchanged. It exists in a
                       checkout of the repository only: outside one, these print the clone command (exit 2).
                       ${cmd} prices convert --help prints the converter's own usage.
                       原样运行上述转换器（check 即它的 --check），规则、输出与退出码不变。它只在仓库检出里有：检出之外打印克隆命令（退出 2）。
  show                 the price table (default models.json) and the source record the converter wrote next to it
                       (default: the same name with .newapi-source.json): who fetched the price list, the rate,
                       quota_per_unit, what was refused or flagged, and the hints the holder console gives. Files only.
                       价目表（默认 models.json）与转换器写在它旁边的来源记录：取价身份、汇率、quota_per_unit、拒绝与待确认的模型、
                       操作台同款的提示。只读文件。

It reads files only: no network, no key asked for, nothing uploaded, nothing paid. Save /api/pricing and /api/status of
YOUR OWN new-api yourself, anonymously (no cookie, no token), or as an ordinary user, never as an administrator.
只读文件：不联网、不索要密钥、不上传、不付款。/api/pricing 与 /api/status 由你自己从你自己的 new-api 取下：匿名（不带 cookie 或令牌），
或用普通用户，绝不用管理员。
Exit status: convert and check, the converter's: 0 done, no drift; 1 drift (check); 2 the input or the options are
wrong (also: no converter here). show: 0 shown; 2 a usage mistake or a file that cannot be read.
退出码：convert 与 check 沿用转换器：0 完成、无漂移；1 有漂移（check）；2 输入或参数有误（没有转换器也算）。show：0 已显示；2 用法错误或文件读不到。
`
}

const SHOW_SPEC = { '--models': 'value', '--meta': 'value', '--json': 'bool', '--lang': 'value', '--no-color': 'bool', '--help': 'bool', '-h': '--help' }
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Read a price table and its source record (show; also tapeapi init step 3). Throws a usage error for a table that
 * cannot be read; a missing or foreign source record is `meta: null` with the reason.
 * 读取价目表与来源记录。价目表读不到即用法错误；来源记录缺失或不是转换器写的，meta 为 null 并给出原因。
 */
export function readPriceTable({ models = 'models.json', meta = null } = {}, h) {
  const file = at(models, h)
  let text
  try { text = h.readFileSync(file, 'utf8') } catch (e) { throw usage(`the price table ${models} cannot be read (${e.code || e.message})`, `价目表 ${models} 读不到（${e.code || e.message}）`) }
  let table
  try { table = JSON.parse(text.replace(/^\uFEFF/, '')) } catch (e) { throw usage(`the price table ${models} is not valid JSON: ${e.message}`, `价目表 ${models} 不是有效的 JSON：${e.message}`) }
  if (!Array.isArray(table)) throw usage(`the price table ${models} must be a JSON array of models (as the converter writes it)`, `价目表 ${models} 须为模型的 JSON 数组（转换器写出的形状）`)
  const metaFile = at(meta ?? sourceRecordOf(models), h)
  let record = null, why = null
  try {
    const r = JSON.parse(h.readFileSync(metaFile, 'utf8'))
    if (isObj(r) && r.tool === CONVERTER_TOOL) record = r
    else why = T(`${shown(metaFile, h)} was not written by ${CONVERTER_TOOL}`, `${shown(metaFile, h)} 不是 ${CONVERTER_TOOL} 写的`)
  } catch (e) {
    why = e?.code === 'ENOENT'
      ? T(`no source record (${shown(metaFile, h)}): a table written by hand, or converted without --out`, `没有来源记录（${shown(metaFile, h)}）：手写的价目表，或转换时没有用 --out`)
      : T(`the source record ${shown(metaFile, h)} cannot be read (${e?.code || e?.message})`, `来源记录 ${shown(metaFile, h)} 读不到（${e?.code || e?.message}）`)
  }
  return { file, metaFile, table, meta: record, why }
}

/** What a source record says, in fields: the facts `show` and `init` print. / 来源记录说了什么。 */
export function sourceFacts(meta) {
  if (!meta) return null
  const s = isObj(meta.source) ? meta.source : {}
  return {
    fetchedAs: typeof s.fetched_as === 'string' ? s.fetched_as : null,
    usdExchangeRate: meta.usd_exchange_rate ?? null,
    quotaPerUnit: meta.quota_per_unit ?? null,
    quotaPerUnitFrom: meta.quota_per_unit_from ?? null,
    contentSha256: typeof s.content_sha256 === 'string' ? s.content_sha256 : null,
    buildMarker: s.newapi_build_marker ?? null,
    selfUseMode: meta.self_use_mode_enabled ?? null,
    converted: Array.isArray(meta.converted) ? meta.converted.length : 0,
    refused: Array.isArray(meta.refused) ? meta.refused.map((r) => ({ id: clean(r?.id), code: clean(r?.code), en: clean(r?.en) })) : [],
    review: Array.isArray(meta.review) ? meta.review.map((r) => ({ id: clean(r?.id), code: clean(r?.code), en: clean(r?.en) })) : [],
    note: typeof meta.note === 'string' ? clean(meta.note) : null,
  }
}
const fetchedAsLabel = (v) => (v === 'anonymous' ? T('anonymous (stated)', '匿名（已说明）') : v === 'user' ? T('a logged-in ordinary user (stated)', '登录的普通用户（已说明）') : T('NOT STATED: convert again with --fetched-as anonymous|user', '未说明：请加 --fetched-as anonymous|user 重新转换'))

/**
 * Run `tapeapi prices` with `argv`. Returns { exitCode }.
 * io: cmd, version, host (node:fs and node:path functions, see receipts-cli hostOf), converter (the module
 * pricing-convert.mjs exports, or null outside a checkout), stdout / stderr (write functions), env, isTTY, cwd.
 * 运行 tapeapi prices。io 注入命令写法、版本、文件函数、转换器模块（检出之外为 null）、输出与环境。
 */
export async function runPrices(argv, io = {}) {
  const { cmd = 'tapeapi', version = '', env = process.env, converter = null } = io
  const stdout = io.stdout ?? ((s) => process.stdout.write(s))
  const stderr = io.stderr ?? ((s) => process.stderr.write(s))
  const isTTY = io.isTTY ?? process.stdout.isTTY === true
  const say = (write, text) => write(redactOutput(text, env))
  const help = pricesUsage(cmd)
  const [sub, ...rest] = argv
  if (sub === undefined || sub === '--help' || sub === '-h' || sub === 'help') {
    if (sub === undefined) return usageExit({ e: usage('no subcommand: convert, check or show', '没有子命令：convert、check 或 show'), prog: `${cmd} prices`, help, cmd: `${cmd} prices`, stderr, say })
    say(stdout, help); return { exitCode: 0 }
  }
  if (sub === 'convert' || sub === 'check') {
    const label = `${cmd} prices ${sub}${version ? ` ${version}` : ''} (experimental / 实验性)`
    if (!converter || typeof converter.run !== 'function') {
      say(stderr, `${label}: the converter ${CONVERTER_PATH} is not here: it is part of a checkout of the repository, not of the package.\n`
        + `${label}: 这里没有转换器 ${CONVERTER_PATH}：它属于仓库检出，不在安装包里。\n`
        + `Run it from a checkout / 请在检出里运行: ${CLONE} && node sdk/bin/tapeapi.js prices ${[sub, ...rest].map(shellWord).join(' ')}\n`
        + `next: / 下一条命令: ${CLONE}\n`)
      return { exitCode: 2 }
    }
    if (sub === 'convert' && rest.includes('--check')) {
      return usageExit({ e: usage(`--check belongs to ${cmd} prices check`, `--check 属于 ${cmd} prices check`), prog: `${cmd} prices convert`, help, cmd: `${cmd} prices`, stderr, say })
    }
    const asked = sub === 'check' ? ['--check', ...rest] : rest
    const helpOnly = rest.includes('--help') || rest.includes('-h')
    if (!helpOnly) say(stderr, `${label}: ${PNOTES.entry.en}\n${label}: ${PNOTES.entry.zh}\n`)
    // The converter's own output, byte for byte, except the value of a secret-named environment variable (redactEnv):
    // the key-shape rule would blank new-api's build marker and the content hash, which are hex and not secret.
    // 转换器自己的输出逐字节原样，只替换形似机密的环境变量的值：按形状的规则会把 new-api 构建标记与内容哈希（十六进制、非机密）替换掉。
    let out = '', err = ''
    const code = converter.run(asked, { out: (t) => { out += t }, err: (t) => { err += t } })
    if (out) stdout(redactEnv(out, env))
    if (err) stderr(redactEnv(err, env))
    if (helpOnly) return { exitCode: code }
    if (code === 0 || code === 1) say(stderr, `${PNOTES.unverified.en}\n${PNOTES.unverified.zh}\n${PNOTES.publish.en}\n${PNOTES.publish.zh}\n`)
    if (code === 1) say(stderr, `next: / 下一条命令: ${cmd} prices ${sub} ${rest.map(shellWord).join(' ')}\n`)
    else if (code !== 0) say(stderr, `next: / 下一条命令: ${cmd} prices ${sub} --help\n`)
    return { exitCode: code }
  }
  if (sub !== 'show') {
    return usageExit({ e: usage(`unknown subcommand ${JSON.stringify(sub)}: convert, check or show`, `未知子命令 ${JSON.stringify(sub)}：convert、check 或 show`), prog: `${cmd} prices`, help, cmd: `${cmd} prices`, stderr, say })
  }

  // ---- show ----
  let o, common, src
  let h
  try {
    h = hostOf(io.host, io.cwd ?? process.cwd())
    const p = parseOptions(rest, SHOW_SPEC)
    if (p.opts['--help']) { say(stdout, help); return { exitCode: 0 } }
    if (p.positional.length) throw usage(`unexpected ${JSON.stringify(p.positional[0])}: give the table with --models`, `多余的参数 ${JSON.stringify(p.positional[0])}：价目表用 --models 给出`)
    o = p.opts
    common = commonOptions(o)
    src = readPriceTable({ models: o['--models'] ?? 'models.json', meta: o['--meta'] ?? null }, h)
  } catch (e) {
    if (!e.usage) throw e
    return usageExit({ e, prog: `${cmd} prices show`, help, cmd: `${cmd} prices`, stderr, say })
  }
  const U = ui({ lang: common.lang, color: !common.noColor && isTTY && !common.json && (env.NO_COLOR === undefined || env.NO_COLOR === '') })
  const facts = sourceFacts(src.meta)
  // new-api's build marker and the content hash are hex, not secrets: kept as they are (receipts-cli redactKeeping).
  // new-api 构建标记与内容哈希是十六进制、不是机密：原样保留。
  const keep = [facts?.buildMarker, facts?.contentSha256].filter((v) => typeof v === 'string')
  const sayShow = (write, text) => write(redactKeeping(text, keep, env))
  const models = src.table.filter(isObj).map((m) => {
    const p = (Array.isArray(m.prices) ? m.prices : []).find(isObj) ?? {}
    return { id: clean(m.id), aliases: Array.isArray(m.aliases) ? m.aliases.map(clean) : [], formats: Array.isArray(m.formats) ? m.formats.map(clean) : null,
      currency: clean(p.currency), input: clean(p.input), output: clean(p.output), cacheRead: p.cacheRead === undefined ? null : clean(p.cacheRead), cacheWrite: p.cacheWrite === undefined ? null : clean(p.cacheWrite) }
  })
  let hints = []
  try { hints = priceHints({ models: src.table.filter((m) => isObj(m) && Array.isArray(m.prices)).map((m) => ({ ...m, prices: m.prices.filter(isObj) })) }) } catch { hints = [] }
  const pick = (t) => (U.lang === 'en' ? t.en : U.lang === 'zh' ? t.zh : t)
  if (common.json) {
    sayShow(stdout, JSON.stringify({ tool: 'tapeapi', command: 'prices show', version, experimental: true, ok: true, exitCode: 0, models: shown(src.file, h), sourceRecord: src.meta ? shown(src.metaFile, h) : null,
      source: facts ? { ...facts, fetchedAs: facts.fetchedAs, fetchedAsStated: facts.fetchedAs !== null } : null, sourceMissing: src.meta ? null : pick(src.why),
      items: models, hints: hints.map((x) => pick(x)), notes: { prices: pick(NOTES.prices), unverified: pick(PNOTES.unverified), fetchedAs: pick(PNOTES.fetchedAs), publish: pick(PNOTES.publish) }, next: null }, null, 2) + '\n')
    return { exitCode: 0 }
  }
  const lines = [`${cmd} prices show${version ? ` ${version}` : ''} ${U.experimental}   ${clean(shown(src.file, h))}   ${models.length} ${U.lang === 'zh' ? '个模型' : models.length === 1 ? 'model' : 'models'}`]
  lines.push(...U.say(NOTES.prices))
  lines.push('')
  if (facts) {
    const rows = [
      [U.lab(T('source record', '来源记录')), `${clean(shown(src.metaFile, h))}   (${CONVERTER_TOOL}, ${U.lang === 'zh' ? '实验性' : 'experimental'})`],
      [U.lab(T('fetched as', '取价身份')), U.lab(fetchedAsLabel(facts.fetchedAs))],
      ['usd_exchange_rate', `${clean(facts.usdExchangeRate)}   ${U.lab(T('(confirmed when converted; only for the CNY comparison)', '（转换时已确认；只用于人民币对照）'))}`],
      ['quota_per_unit', `${clean(facts.quotaPerUnit)}   ${U.lab(T(`(from ${clean(facts.quotaPerUnitFrom ?? 'not recorded')})`, `（来自 ${clean(facts.quotaPerUnitFrom ?? '未记录')}）`))}`],
      [U.lab(T('price content', '价目内容')), facts.contentSha256 ? `${facts.contentSha256.slice(0, 12)}...   ${U.lab(T('(the hash prices check compares)', '（prices check 比对的哈希）'))}` : '-'],
      [U.lab(T('new-api build marker', 'new-api 构建标记')), `${clean(facts.buildMarker ?? '-')}   ${U.lab(T('(a constant of new-api\'s source, not a price version)', '（new-api 源码里的常量，不是价目版本）'))}`],
      [U.lab(T('converted / refused / flagged', '已转换 / 拒绝 / 待确认')), `${facts.converted} / ${facts.refused.length} / ${facts.review.length}`],
    ]
    if (facts.selfUseMode !== null) rows.push(['self_use_mode_enabled', String(facts.selfUseMode === true)])
    lines.push(...table(rows))
    lines.push(...U.say(PNOTES.fetchedAs, '  '))
    if (facts.fetchedAs === null) lines.push(`  ${U.yellow('WARN')}  ${U.lab(fetchedAsLabel(null))}`)
    lines.push(...U.say(PNOTES.unverified, '  '))
    if (facts.note) lines.push(`  NOTE  ${facts.note}`)
  } else {
    lines.push(`  ${U.lab(T('source record', '来源记录'))}: ${U.lab(src.why)}`)
  }
  lines.push('')
  const cell = (v, d) => (v === null ? d : v)
  lines.push(...table([
    [U.lab(T('model', '模型')), U.lab(T('aliases', '别名')), U.lab(T('currency', '币种')), 'input', 'output', 'cacheRead', 'cacheWrite', U.lab(T('formats', '格式'))],
    ...models.map((m) => [m.id, m.aliases.length ? m.aliases.join(',') : '-', m.currency || '-', m.input || '-', m.output || '-', cell(m.cacheRead, '(=input)'), cell(m.cacheWrite, '(=input)'), m.formats ? m.formats.join(',') : U.lab(T('(all declared)', '（全部已声明格式）'))]),
  ]))
  if (facts?.refused.length) {
    lines.push('', `  ${U.lab(T('refused (not in the table)', '拒绝（不在价目表里）'))}:`)
    for (const r of facts.refused) lines.push(`    ${r.id}  ${r.code}: ${r.en}`)
  }
  if (facts?.review.length) {
    lines.push('', `  ${U.lab(T('flagged for you to confirm', '待你确认'))}:`)
    for (const r of facts.review) lines.push(`    ${r.id}  ${r.code}: ${r.en}`)
  }
  const shownHints = hints.map((x) => U.lab(x))
  lines.push('', `  ${U.lab(T('hints', '提示'))}: ${shownHints.length ? '' : U.lab(T('none', '无'))}`)
  for (const x of shownHints) lines.push(`    ${x}`)
  lines.push(...U.say(PNOTES.publish))
  sayShow(stdout, lines.join('\n') + '\n')
  return { exitCode: 0 }
}
