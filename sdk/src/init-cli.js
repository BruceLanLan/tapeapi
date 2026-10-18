// `tapeapi init` on the command line (@experimental; outside the compatibility promise): the operator's wizard, from
// nothing to live, in the steps of the AI providers guide ("From zero to live") and the relay runbook. Each step prints
// what YOU do (where, and who pays: you, never us), the command that checks it, then runs that check read-only (the
// doctor's diagnose(), connectReport(), the price table files) and says DONE, TODO (waiting for you; exit 0), FAIL or
// "could not be read", ending with the next command. It never asks for a key, password or token, never reads .env,
// uploads nothing, pays nothing and sends no transaction; it does not operate a wallet, a circuit, a container, an
// activation or a server for anyone. FORMATS has no default: the formats your gateway really serves must be chosen
// explicitly (no answer = exit 2; all four = a second confirmation), because the manifest is a public statement on chain.
// tapeapi init 命令行部分（实验性，不受兼容承诺约束）：运营者向导，按 AI 服务方指南"从零到上线"与中转运行手册的步骤，从零到上线。
// 每一步打印你要做的事（在哪里做、谁付钱：你，从不是我们）、检查它的命令，再只读地运行检查（doctor 的 diagnose()、connectReport()、
// 价目表文件），给出 DONE、TODO（等你去做，退出码 0）、FAIL 或"读不到"，并以下一条命令结尾。它从不索要密钥、密码或令牌，从不读
// .env，不上传、不付款、不发交易；不替任何人操作钱包、电路、容器、激活或服务器。FORMATS 没有默认值：必须显式选择你的网关真正提供的
// 格式（不选即退出 2；选四种要二次确认），因为清单是链上的公开声明。
// Like every module under src/, it imports nothing Node-only: the file functions come in as io.host (sdk/bin/tapeapi.js
// passes node:fs and node:path), the terminal questions as io.ask. / 与 src/ 下所有模块一样不引用仅限 Node 的模块。
import { createTapeAPI, rpcUrlsFor, operatorOf, parseTapeName, chainByKey } from './index.js'
import { diagnose, formatReport, doctorCommands } from './doctor.js'
import { redactOutput } from './connect-cli.js'
import { connectReport, NOTES, FORMAT_NAMES } from './connect.js'
import { T, hostOf, at, shown, clean, shellWord, usage, parseOptions, commonOptions, ui, table, usageExit } from './receipts-cli.js'
import { readPriceTable, sourceFacts, CONVERTER_PATH } from './prices-cli.js'

export const STATE_FILE = 'tapeapi-init.json'
export const ENV_FILE = '.env'
export const MODELS_FILE = 'models.json'
export const CONSOLE = 'https://tapeapi.fun/console/'
export const TAPEOUT = 'https://tapeout.net'
/** The upstreams this version writes a configuration for. / 本版本能写出配置的上游。 */
export const UPSTREAMS = Object.freeze(['new-api'])
/** The steps, 0 to 7, in the order of the guide. / 步骤 0 到 7，按指南顺序。 */
export const STEPS = Object.freeze([
  { id: 'trial', title: T('Local trial: no key, no circuit, no cost', '本地试跑：不需要密钥、电路，也不花钱') },
  { id: 'circuit', title: T('Buy a circuit on TapeOut', '在 TapeOut 买一个电路') },
  { id: 'activate', title: T('Open the container, then activate the name', '开通容器，再激活名字') },
  { id: 'sidecar', title: T('Configure and start the sidecar in front of your gateway', '配置旁路，并在网关前面启动它') },
  { id: 'console-key', title: T('Service key and delegation, in the holder console', '持有人操作台：服务密钥与委托') },
  { id: 'publish', title: T('Publish the manifest, in the holder console', '持有人操作台：发布清单') },
  { id: 'users', title: T('Tell your users, and be a user once yourself', '告诉你的用户，并自己当一次用户') },
  { id: 'daily', title: T('Daily check, alerts and renewals, in your own accounts', '每日检查、告警与续期（在你自己的账号里）') },
])
const LAST = STEPS.length - 1
/** The API paths of each format, for the question "have you tested it". / 每种格式的接口路径。 */
export const FORMAT_PATHS = Object.freeze({ 'openai-chat': 'POST /v1/chat/completions', 'openai-responses': 'POST /v1/responses', 'anthropic-messages': 'POST /v1/messages', 'openai-embeddings': 'POST /v1/embeddings' })
/** What setup mode may still miss when step 3 is done: what the console gives in step 4. / 第 3 步完成时设置模式还可以缺的变量。 */
// The console gives them all in its steps 3 and 4 (the wizard's step 4): the service key with CIRCUITS, TOKEN_ID and
// CONTAINER, then the delegation. / 操作台在其第 3、4 步（向导第 4 步）给出这些：服务密钥连同 CIRCUITS、TOKEN_ID、CONTAINER，然后是委托。
export const SETUP_LATER = Object.freeze(['SIGNER_KEY (secret)', 'CIRCUITS', 'TOKEN_ID', 'CONTAINER', 'DELEGATION_EXPIRES', 'DELEGATION_SIG'])
// Compared by the variable's name: a sidecar may annotate it ('SIGNER_KEY (secret)') or not. / 按变量名比较：旁路可能带注释也可能不带。
const varName = (m) => String(m).replace(/\s*\(.*\)\s*$/, '').trim()
const SETUP_LATER_NAMES = Object.freeze(SETUP_LATER.map(varName))
/** The keys of an --answers file (nothing secret can be given). / --answers 文件可用的键（不能给任何机密）。 */
export const ANSWER_KEYS = Object.freeze(['name', 'upstream', 'sidecarUrl', 'formats', 'confirmAllFormats', 'priceReportRead'])
const SECRETISH = /key|token|secret|sig|password|passwd|mnemonic|seed|cookie|session/i

// The fixed sentences of the first screen and of every step that costs money. / 第一屏与每个花钱步骤的固定句子。
export const INOTES = Object.freeze({
  boundary: T('Experimental, outside the compatibility promise. It prints what you do and checks it read-only: it asks for no key, password or token, never reads your .env, uploads nothing, pays nothing and sends no transaction; it does not operate your wallet, circuit, container, activation or server for you.',
    '实验性，不受兼容承诺约束。它打印你要做的事，并只读地检查：不索要任何密钥、密码或令牌，从不读你的 .env，不上传、不付款、不发交易；不替你操作钱包、电路、容器、激活或服务器。'),
  receipt: T(`A receipt proves only what its signer says. ${NOTES.receipt.en}`, `回执只证明签名方所说的内容。${NOTES.receipt.zh}`),
  money: T('Every step that costs money is paid by you, from your own wallet or account: you pay it yourself; we do not advance it, pay it for you or refund it.',
    '每个花钱的步骤都由你自己的钱包或账号支付：由你自己付，我们不垫付、不代付、不报销。'),
})
const PAY = T('you pay it yourself; we do not advance it', '由你自己付，我们不垫付')
export const ALL_FORMATS_NOTE = T(`All four formats (${FORMAT_NAMES.join(', ')}) will be written into the manifest you publish on chain: a public statement that your gateway serves every one of them, and its history on chain cannot be deleted. Choose all four only if you have tested each of them through your own gateway.`,
  `四种格式（${FORMAT_NAMES.join('、')}）都会写进你在链上发布的清单：这是"你的网关四种都在提供"的公开声明，链上历史删不掉。只有四种都经你自己的网关实测过，才选四种。`)

export function initUsage(cmd = 'tapeapi') {
  return `${cmd} init (experimental / 实验性): the operator's wizard, from nothing to live, step by step (0 to ${LAST}).
运营者向导：从零到上线，逐步进行（第 0 到 ${LAST} 步）。

Usage: ${cmd} init [--dir <path>] [--step <0-${LAST}>] [--renew] [--name <tape name>] [--sidecar-url <https://...>]
                 [--formats <list>] [--confirm-all-formats] [--upstream new-api] [--answers <file>] [--yes]
                 [--rpc <urls>] [--json] [--lang en|zh|both] [--no-color]

  Steps / 步骤:
${STEPS.map((s, i) => `    [${i}/${LAST}] ${s.title.en} / ${s.title.zh}`).join('\n')}

  --dir <path>         the folder of your sidecar's docker-compose.yml (default: here). The wizard keeps its answers
                       and the result of each step in ${STATE_FILE} there (nothing secret), writes ${ENV_FILE} there
                       once if there is none (secrets left EMPTY, mode 600) and never reads an existing one; it
                       writes it again for a corrected --sidecar-url only while it is exactly as the wizard wrote it
                       旁路 docker-compose.yml 所在的文件夹（默认当前目录）。向导把答案与每步结果存在其中的 ${STATE_FILE}（不含任何机密）；
                       没有 ${ENV_FILE} 时写出一次（机密留空、权限 600），已有的从不读取；只有它仍与向导写出时完全一样时，
                       才会按更正后的 --sidecar-url 重写
  --step <k>           run step k (default: the first step not done yet); every run runs one step
  --renew              step ${LAST} with the renewal of the delegation first
  --name <name>        your TapeOut name, <#ID>.<processor>.tape (from step 1 on)
  --sidecar-url <url>  your sidecar's public https origin, no path (step 3 on)
  --formats <list>     REQUIRED from step 3 on, no default: the API formats your gateway REALLY serves and you have
                       tested, comma-separated among ${FORMAT_NAMES.join(', ')}, or all.
                       All four (or "all") need --confirm-all-formats too: they all go into the manifest on chain,
                       whose history cannot be deleted. Not chosen: exit 2
                       第 3 步起必填，没有默认值：你的网关真正提供、且你实测过的 API 格式。四种（或 all）还需要 --confirm-all-formats：
                       它们都会写进链上清单，历史删不掉。不选：退出 2
  --upstream new-api   the gateway in front of which the sidecar stands (this version: new-api only). Steps 3 and 4
                       need it: without a terminal, no --upstream is exit 2 (it is not assumed)
                       旁路所在的网关（本版本只支持 new-api）。第 3、4 步需要它：没有终端时不给 --upstream 即退出 2（不替你假定）
  --answers <file>     answers as JSON: ${ANSWER_KEYS.join(', ')} (nothing secret: a key-like name is refused).
                       priceReportRead: true says you read every line of the price conversion report; --yes does not
  --yes                no questions: the defaults where there are some; a question without a default is exit 2
  --rpc <url,url,...>  BNB Chain nodes, at least 2 operators (default: ${rpcUrlsFor(56).length} public nodes of distinct operators)
  --rpc-xlayer <urls>  X Layer nodes      --rpc-base <urls>  Base nodes
  --json               one JSON object on stdout (no questions)     --lang <en|zh|both>  (default both)     --no-color
  --help

Questions are asked only on a terminal without --yes, --answers or --json; none of them is a key, a password, a token
or a wallet secret. Output redaction as tapeapi connect's.
只在终端里、且没有 --yes、--answers、--json 时提问；没有一个问题是密钥、密码、令牌或钱包机密。输出脱敏同 tapeapi connect。
${INOTES.receipt.en}
${INOTES.receipt.zh}
${INOTES.money.en}
${INOTES.money.zh}
Exit status: 0 the step is done, or it waits for you (TODO: the next command is printed); 1 its check failed; 2 a usage
mistake or a missing answer (FORMATS not chosen among them); 3 the chain or the sidecar could not be read: run it again.
退出码：0 本步完成，或在等你去做（TODO，会打印下一条命令）；1 本步检查失败；2 用法错误或缺答案（包括没有选择 FORMATS）；3 链或旁路读不到：请重试。
`
}

const INIT_SPEC = {
  '--dir': 'value', '--step': 'value', '--renew': 'bool', '--name': 'value', '--sidecar-url': 'value', '--formats': 'value', '--confirm-all-formats': 'bool',
  '--upstream': 'value', '--answers': 'value', '--yes': 'bool', '-y': '--yes', '--rpc': 'value', '--rpc-xlayer': 'value', '--rpc-base': 'value',
  '--json': 'bool', '--lang': 'value', '--no-color': 'bool', '--help': 'bool', '-h': '--help',
}
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const yes = (s) => /^\s*(y|yes|是)\s*$/i.test(String(s ?? ''))

/**
 * The formats chosen, from --formats, an --answers value or the state file: { formats, four }, in the SDK's order. Throws
 * a usage error naming FORMATS for nothing chosen (an empty value, an empty list) and for an unknown name. "all" means the
 * four, exactly as the sidecar's selectFormats reads it (comma or space separated, a name twice counts once).
 * 所选格式：按 SDK 的顺序给出 { formats, four }。什么都没选（空值、空列表）或名字不认识：用法错误并点名 FORMATS。
 */
export function chooseFormats(value) {
  const none = () => usage(`FORMATS is not chosen: name the API formats your gateway REALLY serves and that you have tested, comma-separated among ${FORMAT_NAMES.join(', ')} (--formats openai-chat, for a gateway whose channels are OpenAI Chat compatible only). There is no default and no fallback to all: the manifest is a public statement on chain, and a sidecar left without FORMATS publishes all four.`,
    `没有选择 FORMATS：请写出你的网关真正提供、且你实测过的 API 格式，逗号分隔，取值 ${FORMAT_NAMES.join('、')}（渠道只兼容 OpenAI Chat 的网关：--formats openai-chat）。没有默认值，也不回落到 all：清单是链上的公开声明，没设 FORMATS 的旁路会发布全部四种。`)
  if (value === undefined || value === null) throw none()
  const asked = Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean) : typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean) : null
  if (!asked) throw usage('formats must be a list of format names or a comma-separated string', 'formats 须为格式名列表或逗号分隔的字符串')
  if (!asked.length) throw none()
  if (asked.length === 1 && asked[0].toLowerCase() === 'all') return { formats: [...FORMAT_NAMES], four: true }
  const unknown = asked.filter((n) => !FORMAT_NAMES.includes(n))
  if (unknown.length) throw usage(`FORMATS names ${unknown.map((n) => JSON.stringify(clean(n))).join(', ')}, which the sidecar does not know: choose among ${FORMAT_NAMES.join(', ')}`, `FORMATS 里的 ${unknown.map((n) => JSON.stringify(clean(n))).join('、')} 旁路不认识：请在 ${FORMAT_NAMES.join('、')} 中选择`)
  const formats = FORMAT_NAMES.filter((n) => asked.includes(n))
  return { formats, four: formats.length === FORMAT_NAMES.length }
}

/** A sidecar URL: an https origin without a path (http only on 127.0.0.1 / localhost). / 旁路地址。 */
export function checkSidecarUrl(s) {
  let u
  try { u = new URL(String(s)) } catch { throw usage(`--sidecar-url ${JSON.stringify(clean(s))} is not a URL: give your sidecar's public https origin, like https://api.example.com`, `--sidecar-url ${JSON.stringify(clean(s))} 不是网址：请给出旁路的公网 https 根地址，例如 https://api.example.com`) }
  const loop = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loop)) throw usage('--sidecar-url must be https (http only on 127.0.0.1 / localhost)', '--sidecar-url 必须是 https（只有 127.0.0.1 / localhost 可用 http）')
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || u.username || u.password) throw usage('--sidecar-url must be a bare origin: no path, query, fragment or credentials (the sidecar\'s PUBLIC_URL)', '--sidecar-url 只写到域名：不带路径、查询串、片段或凭据（即旁路的 PUBLIC_URL）')
  return u.origin
}
function checkName(s) {
  const p = parseTapeName(String(s))
  if (!p || p.error) throw usage(`${JSON.stringify(clean(s))} is not a TapeOut name: <#ID>.<processor>.tape (on X Layer or Base <#ID>.<area>.<processor>.tape)${p?.error ? `; ${p.error}` : ''}`, `${JSON.stringify(clean(s))} 不是 TapeOut 名字：<#ID>.<处理器>.tape（X Layer 或 Base 上为 <#ID>.<区号>.<处理器>.tape）`)
  return String(s).trim()
}

/**
 * The .env the wizard writes once, for the new-api package (examples/new-api-sidecar): the names env.example uses; the
 * values of the wizard's own answers (PUBLIC_URL, FORMATS, TAPE_NAME); every secret and every value the holder console
 * gives left EMPTY for the operator to fill in. / 向导写出一次的 .env：机密与操作台给出的值一律留空，由运营者自己填。
 */
export function envSkeleton({ sidecarUrl, formats, name = null }) {
  return [
    '# Written once by tapeapi init (experimental), for examples/new-api-sidecar. Values left EMPTY are yours to fill in;',
    '# the wizard never reads this file again. Never commit it, never show it in a screen share. chmod 600.',
    '# 由 tapeapi init（实验性）为 examples/new-api-sidecar 写出一次。留空的值由你自己填；向导之后从不读取本文件。不要提交、不要在屏幕共享里显示它。',
    '',
    '# new-api: a long random secret for its logins: run `openssl rand -hex 32` and paste the result yourself.',
    '# new-api 登录用的随机密钥：自己运行 openssl rand -hex 32 并粘贴结果。',
    'SESSION_SECRET=',
    '',
    '# The public https origin of the sidecar (your answer to the wizard). / 旁路的公网 https 根地址（你在向导里的回答）。',
    `PUBLIC_URL=${sidecarUrl}`,
    '',
    `# Identity: public values the holder console (${CONSOLE}) shows in step 3. / 身份：持有人操作台第 3 步显示的公开值。`,
    'CIRCUITS=',
    'TOKEN_ID=',
    'CONTAINER=',
    '',
    '# The API formats your gateway REALLY serves, as you chose them in the wizard. Only these go into the manifest,',
    '# a public statement on chain whose history cannot be deleted. / 你在向导里选择的、网关真正提供的格式。只有它们写进链上清单。',
    `FORMATS=${formats.join(',')}`,
    '',
    '# SECRET. The service key from step 3 of the holder console, pasted by you (or SIGNER_KEY_FILE: a file holding it,',
    '# chmod 600). Nobody else should see it. / 机密。操作台第 3 步的服务密钥，由你自己粘贴（或用 SIGNER_KEY_FILE 指向存放它的文件）。',
    'SIGNER_KEY=',
    '',
    '# From step 4 of the holder console (the delegation you sign with your wallet). / 操作台第 4 步（你用钱包签的委托）。',
    'DELEGATION_EXPIRES=',
    'DELEGATION_SIG=',
    '',
    name ? `TAPE_NAME=${name}` : '# TAPE_NAME=<#ID>.<processor>.tape',
    'SIDECAR_BIND=127.0.0.1',
    'SIDECAR_PORT=8080',
    '',
  ].join('\n')
}

/**
 * The lines of a doctor report for some of its checks, as formatReport prints them (numbers kept), or the whole report.
 * 医生报告里某些检查项的行（与 formatReport 相同，保留编号），或整份报告。
 */
export function doctorLines(report, { ids = null, lang = 'both', last = true } = {}) {
  const lines = formatReport(report, { lang }).split('\n')
  if (!ids) return lines
  const out = []
  let keep = false, i = -1
  for (const l of lines.slice(1)) {
    if (/^\s?\d+ (PASS|WARN|FAIL|SKIP|ERR )  /.test(l)) { i++; keep = ids.includes(report.checks[i]?.id) }
    else if (!/^ {3,}/.test(l)) keep = false
    if (keep) out.push(l)
  }
  if (last) out.push(lines[lines.length - 1])
  return out
}
/** The checks of a report that ran (not skipped): what the wizard quotes. / 报告中实际运行（未跳过）的检查。 */
const ran = (report) => report.checks.filter((c) => c.status !== 'skip').map((c) => c.id)
const byId = (report, id) => report?.checks?.find((c) => c.id === id) ?? null
const undecided = (report, ids) => report.exitCode === 3 || (ids ?? report.checks.map((c) => c.id)).some((id) => byId(report, id)?.status === 'error')
/**
 * What setup mode is missing: the doctor's structured `setup` field on the manifest-format check (2.3, review C-1), else
 * (a doctor without it) its English detail; null when not setup mode.
 * 设置模式缺什么：先读 doctor 在 manifest-format 检查上的结构化 setup 字段（2.3，审查 C-1）；没有该字段时退回解析英文 detail。
 */
export function setupMissing(report) {
  const c = byId(report, 'manifest-format')
  if (!c || c.status !== 'fail') return null
  const s = c.setup
  if (s && typeof s === 'object' && Array.isArray(s.missing)) {
    return typeof s.problem === 'string' && s.problem ? { missing: [], problem: s.problem } : { missing: s.missing.filter((m) => typeof m === 'string'), problem: null }
  }
  if (typeof c.detail !== 'string') return null
  const m = /the sidecar is in SETUP MODE: (.*?)(?:; its signing address is 0x[0-9a-fA-F]{40})?$/.exec(c.detail)
  if (!m) return null
  return m[1].startsWith('missing ') ? { missing: m[1].slice(8).split(', ').filter(Boolean), problem: null } : { missing: [], problem: m[1] }
}
const declared = (report) => (Array.isArray(report?.manifest?.ai?.endpoints) ? [...new Set(report.manifest.ai.endpoints.map((e) => e?.format))] : null)
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x))

/**
 * Run `tapeapi init` with `argv`. Returns { exitCode }.
 * io: cmd (how `tapeapi` is written in printed commands), version, host (node:fs and node:path functions), commands
 * (doctorCommands() for the way it runs: the trial command), ask(question) -> Promise<string> (a terminal; null: no
 * questions), stdout / stderr, env, isTTY, cwd, apiOptions (merged into createTapeAPI's options: tests pass a fake
 * chain), diagnoseOptions (merged into diagnose's: tests allow loopback http endpoints), now (ISO time for the state).
 * 运行 tapeapi init。io 注入命令写法、版本、文件函数、提问函数（终端；null 即不提问）、输出、环境与测试用的假链选项。
 */
export async function runInit(argv, io = {}) {
  const { cmd = 'tapeapi', version = '', env = process.env, apiOptions = {}, diagnoseOptions = {} } = io
  const stdout = io.stdout ?? ((s) => process.stdout.write(s))
  const stderr = io.stderr ?? ((s) => process.stderr.write(s))
  const isTTY = io.isTTY ?? process.stdout.isTTY === true
  const say = (write, text) => write(redactOutput(text, env))
  const help = initUsage(cmd)
  const fail2 = (e) => usageExit({ e, prog: `${cmd} init`, help, cmd: `${cmd} init`, stderr, say })
  // A missing answer or FORMATS: both languages and the next command, without the whole help. / 缺答案：双语与下一条命令。
  const missing2 = (e, next, extra = null) => {
    say(stderr, `${cmd} init: ${e.message}\n${cmd} init: ${e.zh ?? e.message}\n${extra ? `${extra.en}\n${extra.zh}\n` : ''}next: / 下一条命令: ${next}\n`)
    return { exitCode: 2 }
  }

  let o, common, h, dir, state, fileAnswers = {}, step
  const chainRpc = {}
  try {
    const p = parseOptions(argv, INIT_SPEC)
    o = p.opts
    if (o['--help']) { say(stdout, help); return { exitCode: 0 } }
    if (p.positional.length) throw usage(`unexpected ${JSON.stringify(clean(p.positional[0]))}`, `多余的参数 ${JSON.stringify(clean(p.positional[0]))}`)
    common = commonOptions(o)
    h = hostOf(io.host, io.cwd ?? process.cwd())
    dir = at(o['--dir'] ?? '.', h)
    let st
    try { st = h.statSync(dir) } catch { st = null }
    if (!st?.isDirectory()) throw usage(`--dir ${o['--dir'] ?? '.'} is not a folder: create it first (the folder of your sidecar's docker-compose.yml)`, `--dir ${o['--dir'] ?? '.'} 不是文件夹：请先创建它（旁路 docker-compose.yml 所在的文件夹）`)
    state = readState(h.join(dir, STATE_FILE), h)
    if (o['--answers'] !== undefined) fileAnswers = readAnswers(at(o['--answers'], h), h)
    if (o['--step'] !== undefined && !/^[0-9]$/.test(o['--step'])) throw usage(`--step must be 0 to ${LAST}`, `--step 只能是 0 到 ${LAST}`)
    step = o['--renew'] ? LAST : o['--step'] !== undefined ? Number(o['--step']) : firstOpen(state)
    if (step > LAST) throw usage(`--step must be 0 to ${LAST}`, `--step 只能是 0 到 ${LAST}`)
    if (o['--renew'] && o['--step'] !== undefined && Number(o['--step']) !== LAST) throw usage(`--renew is step ${LAST}`, `--renew 就是第 ${LAST} 步`)
    for (const [flag, key] of [['--rpc', 'bsc'], ['--rpc-xlayer', 'xlayer'], ['--rpc-base', 'base']]) {
      if (o[flag] === undefined) continue
      const urls = o[flag].split(',').map((s) => s.trim()).filter(Boolean)
      if (new Set(urls.map(operatorOf)).size < 2) throw usage(`${flag} needs nodes of at least 2 independent operators (every chain read must be agreed by 2)`, `${flag} 至少需要 2 家独立运营方的节点（每次读链须 2 家一致）`)
      chainRpc[key] = urls
    }
  } catch (e) {
    if (!e.usage) throw e
    return fail2(e)
  }

  // Answers: the flags, then --answers, then what the state file kept. / 答案：命令行参数优先，其次 --answers，再次状态文件。
  const A = { ...state.answers, ...fileAnswers }
  if (o['--name'] !== undefined) A.name = o['--name']
  if (o['--sidecar-url'] !== undefined) A.sidecarUrl = o['--sidecar-url']
  if (o['--upstream'] !== undefined) A.upstream = o['--upstream']
  if (o['--formats'] !== undefined) { A.formats = o['--formats']; delete A.confirmAllFormats }
  if (o['--confirm-all-formats']) A.confirmAllFormats = true
  if (fileAnswers.formats !== undefined && o['--formats'] === undefined && fileAnswers.confirmAllFormats === undefined) delete A.confirmAllFormats
  const interactive = typeof io.ask === 'function' && !o['--yes'] && o['--answers'] === undefined && !common.json
  const ask = async (q) => clean(await io.ask(redactOutput(q, env))).trim()
  const L = (t) => (common.lang === 'en' ? t.en : common.lang === 'zh' ? t.zh : `${t.en} / ${t.zh}`)
  const extraFlags = [...(o['--dir'] !== undefined ? ['--dir', o['--dir']] : []), ...(['--rpc', '--rpc-xlayer', '--rpc-base'].flatMap((f) => (o[f] !== undefined ? [f, o[f]] : [])))]
  const initCmd = (k, more = []) => `${cmd} init --step ${k}${[...more, ...extraFlags].length ? ` ${[...more, ...extraFlags].map(shellWord).join(' ')}` : ''}`
  // After a missing answer nothing is saved: the next command repeats the answers given on this command line (except
  // FORMATS, which the caller names). / 缺答案时什么都不保存：下一条命令重复本次命令行给出的答案（FORMATS 除外，由调用处给出）。
  const given = (skip = []) => [['--name', o['--name']], ['--upstream', o['--upstream']], ['--sidecar-url', o['--sidecar-url']], ['--answers', o['--answers']]].filter(([f, v]) => v !== undefined && v !== '' && !skip.includes(f)).flat()
  const again2 = (more, skip = []) => initCmd(step, [...more, ...given([...skip, ...more.filter((x) => x.startsWith('--'))])])

  // Check what was given, whatever the step. / 不论哪一步，先检查给出的答案。
  let chosen = null
  try {
    if (A.name !== undefined && A.name !== null && A.name !== '') A.name = checkName(A.name)
    else delete A.name
    if (A.sidecarUrl !== undefined && A.sidecarUrl !== null && A.sidecarUrl !== '') A.sidecarUrl = checkSidecarUrl(A.sidecarUrl)
    else delete A.sidecarUrl
    if (A.upstream !== undefined && !UPSTREAMS.includes(A.upstream)) throw usage(`--upstream ${JSON.stringify(clean(A.upstream))}: this version writes the configuration of the new-api package only (examples/new-api-sidecar). For LiteLLM follow examples/litellm-sidecar/README.md and set FORMATS there to the formats you tested`, `--upstream ${JSON.stringify(clean(A.upstream))}：本版本只为 new-api 一键包（examples/new-api-sidecar）写配置。LiteLLM 请按 examples/litellm-sidecar/README.md 操作，并在那里把 FORMATS 设为你实测过的格式`)
    if (o['--formats'] !== undefined || fileAnswers.formats !== undefined || state.answers.formats !== undefined) chosen = chooseFormats(A.formats)
  } catch (e) {
    if (!e.usage) throw e
    return /FORMATS/.test(e.message) ? missing2(e, again2(['--formats', 'openai-chat'])) : fail2(e)
  }

  // What this step needs, asked on a terminal or exit 2. / 本步需要的答案：在终端里问，否则退出 2。
  const needName = [2, 5, 6, 7].includes(step)
  const needSidecar = [3, 4].includes(step)
  const needFormats = step >= 3
  try {
    if (!A.name && (needName || step === 1) && interactive) {
      const v = await ask(`${L(T('Your TapeOut name (<#ID>.<processor>.tape), empty to fill in later', '你的 TapeOut 名字（<#ID>.<处理器>.tape），留空则稍后再填'))}: `)
      if (v) A.name = checkName(v)
    }
    if (!A.name && needName) return missing2(usage('no TapeOut name: give --name <#ID>.<processor>.tape (step 1 is buying the circuit that has it)', '没有 TapeOut 名字：请用 --name <#ID>.<处理器>.tape 给出（第 1 步就是买到带这个名字的电路）'), again2(['--name', '<#ID>.<processor>.tape']))
    // No default without a terminal (review C-4): the .env written is new-api's, so a LiteLLM operator must not get it
    // silently; like FORMATS, the gateway is said, never assumed. / 没有终端时没有缺省（审查 C-4）：写出的是 new-api 的 .env，
    // 不能悄悄给 LiteLLM 运营者；与 FORMATS 一样，网关要明说，不替人假定。
    if (needSidecar && !A.upstream) {
      if (!interactive) return missing2(usage('no gateway: give --upstream new-api (the only one this version writes a configuration for; for LiteLLM follow examples/litellm-sidecar/README.md instead)', '没有网关：请用 --upstream new-api 给出（本版本只为它写配置；LiteLLM 请改按 examples/litellm-sidecar/README.md 操作）'), again2(['--upstream', 'new-api']))
      const v = await ask(`${L(T('Your gateway', '你的网关'))} [new-api]: `)
      if (v && !UPSTREAMS.includes(v)) throw usage(`this version writes the configuration of the new-api package only, not ${JSON.stringify(v)}`, `本版本只为 new-api 一键包写配置，不支持 ${JSON.stringify(v)}`)
      A.upstream = 'new-api'
    }
    if (needSidecar && !A.sidecarUrl) {
      if (interactive) A.sidecarUrl = checkSidecarUrl(await ask(`${L(T("Your sidecar's public https origin, no path (PUBLIC_URL)", '旁路的公网 https 根地址，不带路径（PUBLIC_URL）'))}: `))
      else return missing2(usage("no sidecar address: give --sidecar-url https://<your sidecar's host> (the PUBLIC_URL of the sidecar, a bare origin)", '没有旁路地址：请用 --sidecar-url https://<旁路的域名> 给出（旁路的 PUBLIC_URL，只写到域名）'), again2(['--sidecar-url', 'https://api.example.com']))
    }
    if (needFormats && !chosen) {
      if (!interactive) return missing2(rethrowFormats(), again2(['--formats', 'openai-chat']))
      // One by one: only what you have tested. / 逐个确认：只选你实测过的。
      say(stderr, `${L(T('FORMATS: answer y only for a format you have tested through your own gateway. The manifest is a public statement on chain.', 'FORMATS：只对经你自己的网关实测过的格式回答 y。清单是链上的公开声明。'))}\n`)
      const picked = []
      for (const f of FORMAT_NAMES) if (yes(await ask(`  ${L(T(`Have you tested that your gateway really serves ${f} (${FORMAT_PATHS[f]})?`, `你实测过你的网关真正提供 ${f}（${FORMAT_PATHS[f]}）吗？`))} [y/N] `))) picked.push(f)
      chosen = chooseFormats(picked)
      A.formats = chosen.formats
      delete A.confirmAllFormats
    }
    if (needFormats && chosen.four && A.confirmAllFormats !== true) {
      if (interactive) {
        say(stderr, `${ALL_FORMATS_NOTE.en}\n${ALL_FORMATS_NOTE.zh}\n`)
        if (yes(await ask(`  ${L(T('Write all four into the manifest?', '把四种都写进清单？'))} [y/N] `))) A.confirmAllFormats = true
      }
      if (A.confirmAllFormats !== true) {
        // The next command is the narrow one: declaring less than you serve is the safe mistake. / 下一条命令给窄的那个：少声明是安全的错误。
        return missing2(usage('all four formats were chosen without a second confirmation', '选了全部四种格式，但没有二次确认'), again2(['--formats', 'openai-chat']),
          T(`${ALL_FORMATS_NOTE.en} Only if you tested all four, confirm it: add --confirm-all-formats ("confirmAllFormats": true in --answers, or y on a terminal). Otherwise give only the ones you tested, as the next command does for openai-chat.`, `${ALL_FORMATS_NOTE.zh}只有四种都实测过，才确认：加 --confirm-all-formats（或在 --answers 里写 "confirmAllFormats": true，或在终端里回答 y）。否则只写你实测过的格式，如下一条命令对 openai-chat 的写法。`))
      }
    }
  } catch (e) {
    if (!e.usage) throw e
    return /FORMATS/.test(e.message) ? missing2(e, again2(['--formats', 'openai-chat'])) : fail2(e)
  }
  if (chosen) A.formats = chosen.formats

  const U = ui({ lang: common.lang, color: !common.noColor && isTTY && !common.json && (env.NO_COLOR === undefined || env.NO_COLOR === '') })
  const chains = Object.fromEntries(Object.entries(chainRpc).filter(([k]) => k !== 'bsc').map(([k, urls]) => [chainByKey(k).chainId, { rpcUrls: urls }]))
  const base = { rpcUrls: chainRpc.bsc ?? rpcUrlsFor(56), quorum: 2, chains }
  const ctx = {
    U, cmd, A, h, dir, env, state, interactive, ask, L, initCmd,
    commands: { ...(io.commands ?? doctorCommands()), doctor: (t) => `${cmd} doctor ${t}` },
    api: () => createTapeAPI({ ...base, conform: 'tap10', ...apiOptions }),
    api1x: () => createTapeAPI({ ...base, ...apiOptions, conform: false }),
    apiUrl: () => createTapeAPI({ ...base, dev: true, ...apiOptions }),
    diag: diagnoseOptions, fetch: io.fetch, renew: !!o['--renew'], json: common.json,
  }
  let r
  try { r = await STEP_RUN[step](ctx) } catch (e) {
    if (e?.usage) return /FORMATS/.test(e.message) ? missing2(e, again2(['--formats', 'openai-chat'])) : missing2(e, e.next ?? again2([]))
    if (e?.code === 'INVALID_ARGUMENT') return fail2(usage(String(e.message), String(e.message)))
    r = { status: 'ERR', exitCode: 3, quote: [], you: [], verdict: T(`could not be read, nothing decided: ${clean(e?.message ?? e)}`, `读不到，无法判定：${clean(e?.message ?? e)}`) }
  }
  r.next ??= r.status === 'DONE' || r.status === 'SKIP' ? (step < LAST ? initCmd(step + 1) : `${cmd} doctor ${A.name} --strict`) : initCmd(step, r.again ?? [])

  // Keep the answers (nothing secret) and the result of this step. / 保存答案（不含机密）与本步结果。
  // priceReportRead is not kept: the state keeps the price content it was given for (priceReportFor), so a new
  // conversion of changed prices asks again. / 不保存 priceReportRead：只记它对应的价目内容哈希，价目变了要重新确认。
  const keepAnswers = Object.fromEntries(ANSWER_KEYS.filter((k) => k !== 'priceReportRead' && A[k] !== undefined).map((k) => [k, A[k]]))
  const steps = { ...state.steps, [step]: { status: r.status, exitCode: r.exitCode, at: io.now?.() ?? new Date().toISOString() } }
  const priceReportFor = r.priceReportFor ?? state.priceReportFor ?? null
  const envRec = ctx.envRecord ?? state.env ?? null
  h.writeFileSync(h.join(dir, STATE_FILE), JSON.stringify({ tool: 'tapeapi init', experimental: true, note: 'answers and step results only; nothing secret', answers: keepAnswers, ...(priceReportFor ? { priceReportFor } : {}), ...(envRec ? { env: envRec } : {}), steps }, null, 2) + '\n')

  const s = STEPS[step]
  if (common.json) {
    const P = (t) => (t ? (common.lang === 'en' ? t.en : common.lang === 'zh' ? t.zh : t) : null)
    say(stdout, JSON.stringify({
      tool: 'tapeapi', command: 'init', version, experimental: true, ok: r.exitCode === 0, exitCode: r.exitCode, dir: shown(dir, h), state: shown(h.join(dir, STATE_FILE), h),
      step: { index: step, id: s.id, title: P(s.title), status: r.status, who: P(r.who), you: (r.you ?? []).map(P), checks: (r.checks ?? []).map(({ quote, note, ...c }) => ({ ...c, ...(note ? { note: P(note) } : {}) })), written: r.written ?? [], formats: needFormats ? A.formats : undefined, verdict: P(r.verdict) },
      steps: STEPS.map((x, i) => ({ index: i, id: x.id, status: steps[i]?.status ?? null })),
      notes: { boundary: P(INOTES.boundary), receipt: P(INOTES.receipt), money: P(INOTES.money), ...(needFormats && chosen?.four ? { allFormats: P(ALL_FORMATS_NOTE) } : {}) }, next: r.next,
    }, null, 2) + '\n')
    return { exitCode: r.exitCode }
  }
  const mark = (st) => (st === 'DONE' ? U.green('DONE') : st === 'TODO' ? U.yellow('TODO') : st === 'FAIL' ? U.red('FAIL') : st === 'ERR' ? U.red('ERR ') : st === 'SKIP' ? 'SKIP' : '    ')
  const out = [`${cmd} init${version ? ` ${version}` : ''} ${U.experimental}   dir ${clean(shown(dir, h))}   state ${clean(shown(h.join(dir, STATE_FILE), h))}`]
  out.push(...U.say(INOTES.boundary), ...U.say(INOTES.receipt), ...U.say(INOTES.money), '')
  STEPS.forEach((x, i) => out.push(`  [${i}/${LAST}] ${mark(steps[i]?.status)}  ${U.lab(x.title)}${i === step ? `   <- ${U.lab(T('this run', '本次'))}` : ''}`))
  out.push('', U.bold(`[${step}/${LAST}] ${U.lab(s.title)}`))
  if (r.who) out.push(...U.say(r.who, '      '))
  if (r.lines?.length) out.push('', ...r.lines)
  if (r.you?.length) {
    out.push('', `  ${U.yellow('TODO')}  ${U.lab(T('You, not us (we do not see these values)', '你自己做（我们不看这些值）'))}:`)
    r.you.forEach((t, i) => { const [first, ...more] = U.say(t); out.push(`        ${i + 1}. ${first}`, ...more.map((m) => `           ${m}`)) })
  }
  // Each check with what the doctor said under it (its own quote), or one quote after them all. / 每个检查下面是它自己的 doctor 原话。
  for (const c of r.checks ?? []) {
    out.push('', `  ${U.lab(T('check', '检查'))}:  ${c.command}${c.note ? `   ${U.lab(c.note)}` : ''}`)
    if (c.quote?.length) out.push(...c.quote.map((l) => `  | ${l}`))
  }
  if (r.quote?.length) out.push(...r.quote.map((l) => `  | ${l}`))
  out.push('')
  const [v1, ...vMore] = U.say(r.verdict)
  out.push(`  ${mark(r.status)}  [${step}/${LAST}] ${v1}`, ...vMore.map((m) => `        ${m}`))
  out.push(`  ${U.next(r.next)}`)
  say(stdout, out.join('\n') + '\n')
  return { exitCode: r.exitCode }
}

function rethrowFormats() { try { chooseFormats(undefined) } catch (e) { return e } }
/** The first step not done yet (0 with no state). / 第一个尚未完成的步骤。 */
function firstOpen(state) {
  for (let i = 0; i <= LAST; i++) if (!['DONE', 'SKIP'].includes(state.steps?.[i]?.status)) return i
  return LAST
}
// What the wizard wrote into .env and the file's stat right after (review C-3): nothing secret, all of it follows from
// the answers. It lets a later run tell, without reading the file, that the .env is still exactly the wizard's (same
// inode, size, mtime and ctime: no key filled in, no chmod) and so may be written again for corrected answers.
// 向导写进 .env 的内容来源与写出后的 stat（审查 C-3）：不含机密，全部由答案推出。之后的运行据此在不读文件的前提下判断 .env 仍原封
// 未动（同一 inode、大小、mtime、ctime：没填密钥、没 chmod），才可以按更正后的答案重写。
function envRecordOf(v) {
  if (!isObj(v)) return null
  const num = (x) => typeof x === 'number' && Number.isFinite(x)
  if (typeof v.publicUrl !== 'string' || typeof v.formats !== 'string' || !(v.name === null || typeof v.name === 'string') || !['size', 'mtimeMs', 'ctimeMs', 'ino'].every((k) => num(v[k]))) return null
  return { publicUrl: v.publicUrl, formats: v.formats, name: v.name, size: v.size, mtimeMs: v.mtimeMs, ctimeMs: v.ctimeMs, ino: v.ino }
}
const envRecordFor = (st, { url, formats, name }) => ({ publicUrl: url, formats: formats.join(','), name: name ?? null, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino })
const untouched = (st, rec) => !!rec && st.size === rec.size && st.mtimeMs === rec.mtimeMs && st.ctimeMs === rec.ctimeMs && st.ino === rec.ino
function readState(file, h) {
  let text
  try { text = h.readFileSync(file, 'utf8') } catch (e) { if (e?.code === 'ENOENT') return { answers: {}, steps: {}, priceReportFor: null, env: null }; throw usage(`${file} cannot be read (${e?.code || e?.message})`, `${file} 读不到（${e?.code || e?.message}）`) }
  let j
  try { j = JSON.parse(text) } catch { j = null }
  if (!isObj(j) || j.tool !== 'tapeapi init') throw usage(`${shown(file, h)} is not a tapeapi init state file: move it away, or give another --dir`, `${shown(file, h)} 不是 tapeapi init 的状态文件：请移走它，或换一个 --dir`)
  const answers = isObj(j.answers) ? Object.fromEntries(ANSWER_KEYS.filter((k) => k !== 'priceReportRead' && j.answers[k] !== undefined).map((k) => [k, j.answers[k]])) : {}
  const steps = isObj(j.steps) ? Object.fromEntries(Object.entries(j.steps).filter(([k, v]) => /^[0-9]$/.test(k) && isObj(v)).map(([k, v]) => [k, { status: clean(v.status), exitCode: v.exitCode, at: clean(v.at) }])) : {}
  const priceReportFor = typeof j.priceReportFor === 'string' && /^[0-9a-f]{64}$/.test(j.priceReportFor) ? j.priceReportFor : null
  return { answers, steps, priceReportFor, env: envRecordOf(j.env) }
}
function readAnswers(file, h) {
  let j
  try { j = JSON.parse(h.readFileSync(file, 'utf8')) } catch (e) { throw usage(`the answers file ${shown(file, h)} cannot be read as JSON (${e?.code || e?.message})`, `答案文件 ${shown(file, h)} 无法按 JSON 读取（${e?.code || e?.message}）`) }
  if (!isObj(j)) throw usage('the answers file must be a JSON object', '答案文件须为 JSON 对象')
  for (const k of Object.keys(j)) {
    if (ANSWER_KEYS.includes(k)) continue
    if (SECRETISH.test(k)) throw usage(`the answers file has ${JSON.stringify(clean(k))}: the wizard never takes a key, token, signature, password or seed. Remove it, and put such values only where the sidecar reads them, yourself`, `答案文件里有 ${JSON.stringify(clean(k))}：向导从不接收密钥、令牌、签名、密码或助记词。请删掉它；这类值只由你自己放在旁路读取的地方`)
    throw usage(`the answers file has an unknown key ${JSON.stringify(clean(k))}: ${ANSWER_KEYS.join(', ')}`, `答案文件里有未知的键 ${JSON.stringify(clean(k))}：可用 ${ANSWER_KEYS.join('、')}`)
  }
  if (j.confirmAllFormats !== undefined && typeof j.confirmAllFormats !== 'boolean') throw usage('confirmAllFormats must be true or false', 'confirmAllFormats 只能是 true 或 false')
  if (j.priceReportRead !== undefined && typeof j.priceReportRead !== 'boolean') throw usage('priceReportRead must be true or false', 'priceReportRead 只能是 true 或 false')
  return j
}

// Runs the doctor's diagnose(); its throw for an argument is a usage mistake, any other is "could not be read".
// 运行 doctor 的 diagnose()。
async function doctor(ctx, target, o) {
  return diagnose(target, { commands: ctx.commands, ...(ctx.fetch ? { fetch: ctx.fetch } : {}), ...o, ...ctx.diag })
}
const quoteLang = (ctx) => ctx.U.lang

// ---------------------------------------------------------------------------------------------------------------
// The steps / 各步
// ---------------------------------------------------------------------------------------------------------------
const STEP_RUN = [
  // [0] Local trial: printed, not run, not checked. / 本地试跑：只打印，不运行、不检查。
  async (ctx) => ({
    status: 'SKIP', exitCode: 0,
    who: T('Who does it, who pays: you, on your own machine; nothing is paid, no key and no circuit are needed.', '谁做、谁付钱：你，在你自己的机器上；不花钱，不需要密钥或电路。'),
    you: [T(`Optional: run ${ctx.commands.trial} ; its last line says "The trial passed."`, `可选：运行 ${ctx.commands.trial} ；最后一行是 "The trial passed."`)],
    verdict: T('optional: the wizard does not run the trial for you and does not check it.', '可选：向导不替你运行本地试跑，也不检查它。'),
  }),

  // [1] The circuit. / 电路。
  async (ctx) => {
    const who = T(`Who does it, who pays: you, at ${TAPEOUT}, from your own wallet: the circuit and its gas, ${PAY.en}. The wizard does not choose a processor for you.`, `谁做、谁付钱：你，在 ${TAPEOUT}，用你自己的钱包：电路与 gas ${PAY.zh}。向导不替你选处理器。`)
    const you = [T(`Buy a circuit at ${TAPEOUT}. Its TapeOut name is <#ID>.<processor>.tape (on X Layer or Base <#ID>.<area>.<processor>.tape).`, `在 ${TAPEOUT} 买一个电路。它的 TapeOut 名字是 <#ID>.<处理器>.tape（X Layer 或 Base 上为 <#ID>.<区号>.<处理器>.tape）。`)]
    if (!ctx.A.name) return { status: 'TODO', exitCode: 0, who, you: [...you, T('Then run this step again with --name <your name>.', '然后加上 --name <你的名字> 再运行本步。')], verdict: T('waiting for you: no name yet.', '等你去做：还没有名字。'), again: ['--name', '<#ID>.<processor>.tape'] }
    const report = await doctor(ctx, ctx.A.name, { api: ctx.api() })
    const ids = ['name', 'circuit']
    const base = { who, you, checks: [{ command: ctx.commands.doctor(ctx.A.name), exitCode: report.exitCode, failing: ids.filter((id) => byId(report, id)?.status !== 'pass') }], quote: doctorLines(report, { ids, lang: quoteLang(ctx) }) }
    if (undecided(report, ids)) return { ...base, status: 'ERR', exitCode: 3, verdict: T('the chain could not be read: nothing decided; run it again (other nodes: --rpc).', '链读不到：无法判定；请重试（换节点：--rpc）。') }
    if (ids.every((id) => byId(report, id)?.status === 'pass')) return { ...base, status: 'DONE', exitCode: 0, verdict: T('the name resolves, and its circuit has a holder (see "circuit" above: it should be your wallet).', '名字能解析，电路有持有人（见上面的"电路"一项：应当是你的钱包）。') }
    return { ...base, status: 'TODO', exitCode: 0, verdict: T('not yet: the name does not resolve to a circuit with a holder (see the check above).', '还没有：名字没有解析到有持有人的电路（见上面的检查）。') }
  },

  // [2] Container, then activation, before anything else. / 先开通容器、再激活。
  async (ctx) => {
    const who = T(`Who does it, who pays: you, at ${TAPEOUT} and in the wallet that holds the circuit: opening the container, the activation (months x monthlyFee(), read on chain when you pay) and the gas, ${PAY.en}. Activate before anything else: since 2.0 a name that is not activated fails for every client.`,
      `谁做、谁付钱：你，在 ${TAPEOUT} 与持有电路的钱包里：开通容器、激活（月数 × monthlyFee()，付款时从链上读取）与 gas ${PAY.zh}。先激活再做别的：自 2.0 起，未激活的名字对所有客户端都是失败。`)
    const ids = ['name', 'circuit', 'container', 'activation']
    const report = await doctor(ctx, ctx.A.name, { api: ctx.api() })
    const base = { who, you: [T(`Open the container of ${ctx.A.name} at ${TAPEOUT}, then activate the name: the doctor's "fix" line below says the call and the contract when it is not activated.`, `在 ${TAPEOUT} 开通 ${ctx.A.name} 的容器，再激活名字：未激活时，下面 doctor 的"修复"一行写明要调用什么、在哪个合约。`)],
      checks: [{ command: ctx.commands.doctor(ctx.A.name), exitCode: report.exitCode, failing: ids.filter((id) => byId(report, id)?.status !== 'pass') }], quote: doctorLines(report, { ids, lang: quoteLang(ctx) }) }
    if (undecided(report, ids)) return { ...base, status: 'ERR', exitCode: 3, verdict: T('the chain could not be read: nothing decided; run it again (other nodes: --rpc).', '链读不到：无法判定；请重试（换节点：--rpc）。') }
    if (!['name', 'circuit'].every((id) => byId(report, id)?.status === 'pass')) return { ...base, status: 'TODO', exitCode: 0, verdict: T('step 1 is not done: the name does not resolve to a circuit with a holder.', '第 1 步还没完成：名字没有解析到有持有人的电路。'), next: ctx.initCmd(1) }
    if (byId(report, 'container')?.status !== 'pass') return { ...base, status: 'TODO', exitCode: 0, verdict: T('waiting for you: open the container first (see the check above).', '等你去做：先开通容器（见上面的检查）。') }
    if (byId(report, 'activation')?.status !== 'pass') return { ...base, status: 'TODO', exitCode: 0, verdict: T('waiting for you: activate first, then check again. The wizard does not pay, sign or send any transaction.', '等你去做：先激活，再复检。向导不付款、不签名、不发送任何交易。') }
    return { ...base, status: 'DONE', exitCode: 0, verdict: T('the container is opened and the name is activated.', '容器已开通，名字已激活。') }
  },

  // [3] The sidecar: .env written once (secrets empty), the price table, setup mode. / 旁路：写出 .env、价目表、设置模式。
  async (ctx) => {
    const { U, A, h, dir } = ctx
    const url = A.sidecarUrl, formats = A.formats
    const who = T(`Who does it, who pays: you, on your own server (or your own Cloudflare account); a server costs what your provider charges, ${PAY.en}. TapeAPI hosts no sidecar.`, `谁做、谁付钱：你，在你自己的服务器（或你自己的 Cloudflare 账号）上；服务器费用按你的服务商收取，${PAY.zh}。TapeAPI 不托管任何旁路。`)
    const lines = table([
      [U.lab(T('gateway', '网关')), `${A.upstream}   (examples/new-api-sidecar)`],
      ['FORMATS', `${formats.join(',')}   ${U.lab(T('(you stated: tested through your gateway; the manifest declares only these)', '（你声明的：经你的网关实测过；清单只声明这些）'))}`],
      [U.lab(T('public url', '对外地址')), `${url}   (PUBLIC_URL)`],
    ])
    if (formats.length === FORMAT_NAMES.length) lines.push(...U.say(ALL_FORMATS_NOTE, '  '))
    // The price table and its source record (files only). / 价目表与来源记录（只读文件）。
    let prices = null, priceStatus = 'TODO', priceReportFor = null
    const modelsPath = h.join(dir, MODELS_FILE)
    let broken = null
    try { prices = readPriceTable({ models: modelsPath }, h) } catch (e) {
      prices = null
      let there = false
      try { h.statSync(modelsPath); there = true } catch { there = false }
      if (there) broken = e?.usage ? T(e.message, e.zh ?? e.message) : T(String(e?.message ?? e), String(e?.message ?? e))
    }
    const you = []
    let needRead = false
    if (prices) {
      const f = sourceFacts(prices.meta)
      lines.push(...table([[U.lab(T('price table', '价目表')), `${clean(shown(prices.file, h))}   ${prices.table.length} ${U.lab(T('models', '个模型'))}${f ? `   ${U.lab(T('fetched as', '取价身份'))} ${f.fetchedAs ?? U.lab(T('NOT STATED', '未说明'))}   ${f.refused.length} ${U.lab(T('refused', '拒绝'))}, ${f.review.length} ${U.lab(T('flagged', '待确认'))}` : `   ${U.lab(prices.why)}`}`]]))
      if (f) {
        // Read once per price content: a new conversion of changed prices asks again. / 每份价目内容确认一次。
        const read = A.priceReportRead === true || (!!f.contentSha256 && ctx.state.priceReportFor === f.contentSha256)
        if (!read && ctx.interactive) {
          if (yes(await ctx.ask(`  ${ctx.L(T(`Have you read every REFUSED, REVIEW and NOTE line of the conversion report (${ctx.cmd} prices show --models ${shown(prices.file, h)})?`, `转换报告的每一行 REFUSED、REVIEW 与 NOTE 你都逐条看过了吗（${ctx.cmd} prices show --models ${shown(prices.file, h)}）？`))} [y/N] `))) A.priceReportRead = true
        }
        if (read || A.priceReportRead === true) { priceStatus = 'DONE'; priceReportFor = f.contentSha256 } else needRead = true
        if (f.fetchedAs === null) you.push(T('The price list was converted without --fetched-as: convert it again saying who fetched it (anonymous, or an ordinary user; never an administrator).', '价目转换时没有 --fetched-as：请注明取价身份后重新转换（匿名，或普通用户；绝不用管理员）。'))
      } else priceStatus = 'DONE'
    } else if (broken) {
      you.push(T(`Price table: ${broken.en}; convert it again (${ctx.cmd} prices convert ... --out ${shown(modelsPath, h)}) or fix it.`, `价目表：${broken.zh}；请重新转换（${ctx.cmd} prices convert ... --out ${shown(modelsPath, h)}）或修好它。`))
    } else {
      you.push(T(`Price table: save GET /api/pricing and GET /api/status of YOUR OWN new-api yourself, anonymously (no cookie, no token): curl -s https://<your new-api>/api/pricing > pricing.json && curl -s https://<your new-api>/api/status > status.json ; then ${ctx.cmd} prices convert pricing.json --status status.json --usd-exchange-rate <usd_exchange_rate of your /api/status> --fetched-as anonymous --out ${shown(modelsPath, h)} and read every line of its report (it runs ${CONVERTER_PATH}, in a checkout).`,
        `价目表：自己匿名（不带 cookie 或令牌）存下你自己的 new-api 的 GET /api/pricing 与 GET /api/status：curl -s https://<你的 new-api>/api/pricing > pricing.json && curl -s https://<你的 new-api>/api/status > status.json ；再运行 ${ctx.cmd} prices convert pricing.json --status status.json --usd-exchange-rate <你的 /api/status 里的 usd_exchange_rate> --fetched-as anonymous --out ${shown(modelsPath, h)}，并逐条阅读它的报告（它运行检出里的 ${CONVERTER_PATH}）。`))
    }
    if (needRead) {
      const e = usage('the price conversion report is not confirmed as read: say "priceReportRead": true in --answers, or answer y on a terminal; --yes does not count (the report says what was refused and what you must confirm before the table goes on chain)',
        '没有确认已阅读价目转换报告：在 --answers 里写 "priceReportRead": true，或在终端里回答 y；--yes 不算（报告写明了哪些被拒绝、哪些需要你在价目表上链前确认）')
      e.next = `${ctx.cmd} prices show --models ${shellWord(shown(prices.file, h))}`
      throw e
    }
    // .env: never read. Written once; written again only while it is still exactly the wizard's (its stat as recorded:
    // nothing filled in) and the answers it came from changed, so a wrong PUBLIC_URL can be corrected (review C-3).
    // .env：从不读取。只写一次；仅当它仍原封未动（stat 与记录一致：什么都没填）且它所依据的答案变了，才再写一次，以便更正错的 PUBLIC_URL（审查 C-3）。
    const envPath = h.join(dir, ENV_FILE)
    const written = []
    let envStat = null
    try { envStat = h.statSync(envPath) } catch { envStat = null }
    const rec = ctx.state.env
    const changed = !!rec && (rec.publicUrl !== url || rec.formats !== formats.join(',') || rec.name !== (A.name ?? null))
    const rewrite = !!envStat && changed && untouched(envStat, rec)
    if (!envStat || rewrite) {
      h.writeFileSync(envPath, envSkeleton({ sidecarUrl: url, formats, name: A.name ?? null }), rewrite ? { mode: 0o600 } : { mode: 0o600, flag: 'wx' })
      ctx.envRecord = envRecordFor(h.statSync(envPath), { url, formats, name: A.name })
      written.push(shown(envPath, h))
      if (rewrite) lines.push('', ...U.say(T(`  ${shown(envPath, h)} written again: it was still exactly as the wizard wrote it (nothing filled in), and your answers changed (PUBLIC_URL ${rec.publicUrl} -> ${url}${rec.formats !== formats.join(',') ? `, FORMATS ${rec.formats} -> ${formats.join(',')}` : ''}).`, `  ${shown(envPath, h)} 已重写：它仍与向导写出时完全一样（什么都没填），而你的回答变了（PUBLIC_URL ${rec.publicUrl} -> ${url}${rec.formats !== formats.join(',') ? `，FORMATS ${rec.formats} -> ${formats.join(',')}` : ''}）。`)))
      lines.push('', `  ${U.lab(T('Written', '已写出'))}: ${clean(shown(envPath, h))}   (mode 600)`,
        ...U.say(T('    left EMPTY on purpose: SESSION_SECRET, SIGNER_KEY, DELEGATION_EXPIRES, DELEGATION_SIG, and CIRCUITS, TOKEN_ID, CONTAINER (the console shows them in step 4 of this wizard)', '    刻意留空：SESSION_SECRET、SIGNER_KEY、DELEGATION_EXPIRES、DELEGATION_SIG，以及 CIRCUITS、TOKEN_ID、CONTAINER（本向导第 4 步由操作台给出）')),
        ...U.say(T(`    set from your answers: PUBLIC_URL, FORMATS (= ${formats.join(',')})${A.name ? ', TAPE_NAME' : ''}, SIDECAR_BIND, SIDECAR_PORT`, `    按你的回答填写：PUBLIC_URL、FORMATS（= ${formats.join(',')}）${A.name ? '、TAPE_NAME' : ''}、SIDECAR_BIND、SIDECAR_PORT`)))
    } else {
      lines.push('', ...U.say(T(`  ${shown(envPath, h)} exists: the wizard did not read it and did not change it (it may hold your keys).`, `  ${shown(envPath, h)} 已存在：向导没有读取、也没有改动它（里面可能有你的密钥）。`)))
      if (rec && rec.publicUrl !== url) you.push(T(`The wizard wrote PUBLIC_URL=${rec.publicUrl} into ${shown(envPath, h)}, and the file has changed since, so it is not written again: if PUBLIC_URL should be ${url}, correct it there yourself and restart the sidecar.`, `向导曾在 ${shown(envPath, h)} 里写入 PUBLIC_URL=${rec.publicUrl}，此后文件已被改动，所以不再重写：如果 PUBLIC_URL 应为 ${url}，请自己在其中改正并重启旁路。`))
      you.push(T(`Make sure ${shown(envPath, h)} says FORMATS=${formats.join(',')} (the wizard does not open it); a sidecar without FORMATS publishes all four.`, `确认 ${shown(envPath, h)} 里写的是 FORMATS=${formats.join(',')}（向导不打开它）；没有 FORMATS 的旁路会发布全部四种。`))
    }
    you.push(
      T(`SESSION_SECRET: run openssl rand -hex 32 and paste the result into ${shown(envPath, h)} yourself.`, `SESSION_SECRET：运行 openssl rand -hex 32，自己把结果填进 ${shown(envPath, h)}。`),
      T(`In the folder of examples/new-api-sidecar's docker-compose.yml (with this ${ENV_FILE} and ${MODELS_FILE}): docker compose up -d && docker compose logs -f tapeapi-sidecar   (SETUP MODE is expected now)`, `在 examples/new-api-sidecar 的 docker-compose.yml 所在文件夹（放好这个 ${ENV_FILE} 与 ${MODELS_FILE}）：docker compose up -d && docker compose logs -f tapeapi-sidecar（现在显示设置模式是正常的）`),
      T(`Your reverse proxy: ${url} -> 127.0.0.1:8080 for every path (proxy_buffering off); new-api's console on a hostname of its own -> 127.0.0.1:3000, with /v1/ blocked there.`, `反向代理：${url} 的所有路径 -> 127.0.0.1:8080（关闭缓冲）；new-api 控制台用单独的域名 -> 127.0.0.1:3000，并在那里屏蔽 /v1/。`),
    )
    const report = await doctor(ctx, url, { offline: true })
    const check = { command: ctx.commands.doctor(`--offline ${url}`), exitCode: report.exitCode, failing: report.checks.filter((c) => c.status === 'fail').map((c) => c.id) }
    const base = { who, lines, you, written, checks: [check], quote: doctorLines(report, { ids: ran(report), lang: quoteLang(ctx) }), priceReportFor }
    if (undecided(report)) return { ...base, status: 'ERR', exitCode: 3, verdict: T(`${url} could not be read: nothing decided (the doctor's lines above say why); run it again.`, `${url} 读不到：无法判定（原因见上面 doctor 的输出）；请重试。`) }
    const sm = setupMissing(report)
    const worst = (st) => (st === 'DONE' ? priceStatus : st)
    if (sm && sm.problem) return { ...base, status: 'FAIL', exitCode: 1, verdict: T(`the sidecar answers but its configuration is wrong: ${sm.problem}`, `旁路有应答，但配置有误：${sm.problem}`) }
    if (sm) {
      const other = sm.missing.filter((m) => !SETUP_LATER_NAMES.includes(varName(m)))
      if (!other.length) {
        const st = worst('DONE')
        return { ...base, status: st, exitCode: 0, verdict: st === 'DONE' ? T('exit 1 is the expected result here: the only failure is "manifest-format" in SETUP MODE, and only what the console gives in the next step is missing (SIGNER_KEY, CIRCUITS, TOKEN_ID, CONTAINER, DELEGATION_EXPIRES, DELEGATION_SIG).', '这里退出码 1 正是预期：唯一失败项是设置模式下的 "manifest-format"，缺的只有下一步由操作台给出的变量（SIGNER_KEY、CIRCUITS、TOKEN_ID、CONTAINER、DELEGATION_EXPIRES、DELEGATION_SIG）。') : T('the sidecar is in setup mode as expected; the price table is still to do (see above).', '旁路如预期处于设置模式；价目表还没做（见上）。') }
      }
      return { ...base, status: 'FAIL', exitCode: 1, verdict: T(`the sidecar is missing ${other.join(', ')}: the ${ENV_FILE} it reads is not the one with your answers, or they were removed. Set them and restart.`, `旁路缺少 ${other.join('、')}：它读取的 ${ENV_FILE} 不是写有你回答的那一份，或这些值被删了。补上后重启。`) }
    }
    if (report.exitCode === 0 || report.checks.every((c) => c.status !== 'fail')) {
      const d = declared(report)
      if (d && !sameSet(d, formats)) return { ...base, status: 'FAIL', exitCode: 1, verdict: T(`the sidecar already serves a manifest declaring ${d.join(', ')}, not ${formats.join(', ')}: set FORMATS=${formats.join(',')} in ${ENV_FILE} and restart.`, `旁路已经提供清单，声明的是 ${d.join('、')}，不是 ${formats.join('、')}：在 ${ENV_FILE} 里设 FORMATS=${formats.join(',')} 后重启。`) }
      return { ...base, status: worst('DONE'), exitCode: 0, verdict: T('the sidecar is already past setup mode; go on.', '旁路已经过了设置模式；继续。') }
    }
    return { ...base, status: 'FAIL', exitCode: 1, verdict: T(`not done yet: ${url} does not reach a sidecar in setup mode (the doctor's fix above says what to change).`, `本步未完成：${url} 到不了处于设置模式的旁路（上面 doctor 的修复说明了要改什么）。`) }
  },

  // [4] The holder console: the service key and the delegation (stop screen sharing). / 操作台：服务密钥与委托。
  async (ctx) => {
    const url = ctx.A.sidecarUrl, formats = ctx.A.formats
    const who = T(`Who does it, who pays: you, in the holder console ${CONSOLE}, opened in the browser of the wallet that holds the circuit; signing the delegation costs no gas.`, `谁做、谁付钱：你，在持有人操作台 ${CONSOLE}（在持有电路的钱包 App 内置浏览器里打开）；签委托不花 gas。`)
    const you = [
      T('Stop screen sharing before you open console step 3: it shows the service key once.', '打开操作台第 3 步之前先停止屏幕共享：它会把服务密钥明文显示一次。'),
      T(`Console step 3: put the service key in ${ENV_FILE} as SIGNER_KEY yourself (or in a file named by SIGNER_KEY_FILE, chmod 600), with the CIRCUITS, TOKEN_ID and CONTAINER the page shows. We never see the key; do not send it to anyone.`, `操作台第 3 步：自己把服务密钥填进 ${ENV_FILE} 的 SIGNER_KEY（或放进 SIGNER_KEY_FILE 指向的文件，chmod 600），连同页面显示的 CIRCUITS、TOKEN_ID、CONTAINER。我们不看这个密钥；不要发给任何人。`),
      T(`Console step 4: service URL ${url}; sign the delegation with your wallet (no gas, 90 days); put DELEGATION_EXPIRES and DELEGATION_SIG in ${ENV_FILE}; docker compose up -d.`, `操作台第 4 步：服务地址填 ${url}；用钱包签委托（不花 gas，90 天）；把 DELEGATION_EXPIRES 与 DELEGATION_SIG 填进 ${ENV_FILE}；docker compose up -d。`),
    ]
    const report = await doctor(ctx, url, { api: ctx.apiUrl() })
    const base = { who, you, checks: [{ command: ctx.commands.doctor(url), note: T('(it reads the signer from /tapeapi/v1/health, never your .env)', '（它从 health 读签名地址，从不读你的 .env）'), exitCode: report.exitCode, failing: report.checks.filter((c) => c.status === 'fail').map((c) => c.id) }], quote: doctorLines(report, { ids: ran(report), lang: quoteLang(ctx) }) }
    if (undecided(report)) return { ...base, status: 'ERR', exitCode: 3, verdict: T('the sidecar or the chain could not be read: nothing decided; run it again.', '旁路或链读不到：无法判定；请重试。') }
    const sm = setupMissing(report)
    if (sm && !sm.problem) return { ...base, status: 'TODO', exitCode: 0, verdict: T(`waiting for you: the sidecar is still in setup mode, missing ${sm.missing.join(', ')}.`, `等你去做：旁路仍处于设置模式，缺少 ${sm.missing.join('、')}。`) }
    if (report.exitCode !== 0) return { ...base, status: 'FAIL', exitCode: 1, verdict: T("not done yet: see the failed checks above and the doctor's fix lines.", '本步未完成：见上面失败的检查与 doctor 的修复说明。') }
    const d = declared(report)
    if (d && !sameSet(d, formats)) return { ...base, status: 'FAIL', exitCode: 1, verdict: T(`the sidecar's manifest declares ${d.join(', ')}, but you chose ${formats.join(', ')}: set FORMATS=${formats.join(',')} in ${ENV_FILE} and restart before you publish anything.`, `旁路的清单声明的是 ${d.join('、')}，但你选择的是 ${formats.join('、')}：发布之前在 ${ENV_FILE} 里设 FORMATS=${formats.join(',')} 并重启。`) }
    return { ...base, status: 'DONE', exitCode: 0, verdict: T(`the sidecar signs with the delegated key, and its manifest declares exactly ${formats.join(', ')}.`, `旁路用受委托的密钥签名，清单恰好声明 ${formats.join('、')}。`) }
  },

  // [5] Publish (one transaction, his gas), then the doctor by name in both resolutions. / 发布，再按名字两种解析各跑一次。
  async (ctx) => {
    const name = ctx.A.name, formats = ctx.A.formats
    const who = T(`Who does it, who pays: you, in console step 5, from the wallet that holds the circuit: one transaction, its gas ${PAY.en}. Once on chain the manifest is a public statement, and its history cannot be deleted.`, `谁做、谁付钱：你，在操作台第 5 步，用持有电路的钱包：一笔交易，gas ${PAY.zh}。上链之后清单就是公开声明，历史删不掉。`)
    const you = [
      T(`Before the wallet asks: the console's preview must list exactly these formats: ${formats.join(', ')}. Anything else: stop, fix FORMATS in ${ENV_FILE}, restart, and look again.`, `钱包请求签名之前：操作台预览列出的格式必须恰好是 ${formats.join('、')}。不是的话：停下，改 ${ENV_FILE} 里的 FORMATS、重启后再看。`),
      T('Then run this step again: it runs the doctor by name twice (the default resolution and --no-conform).', '然后再运行本步：它按名字跑两次 doctor（默认解析与 --no-conform）。'),
    ]
    const r1 = await doctor(ctx, name, { api: ctx.api() })
    const r2 = await doctor(ctx, name, { api: ctx.api1x() })
    const base = { who, you, checks: [
      { command: ctx.commands.doctor(name), exitCode: r1.exitCode, failing: r1.checks.filter((c) => c.status === 'fail').map((c) => c.id), quote: doctorLines(r1, { ids: ran(r1), lang: quoteLang(ctx) }) },
      { command: ctx.commands.doctor(`${name} --no-conform`), exitCode: r2.exitCode, failing: r2.checks.filter((c) => c.status === 'fail').map((c) => c.id), quote: [doctorLines(r2, { lang: quoteLang(ctx) }).pop()] },
    ] }
    if (undecided(r1) || undecided(r2)) return { ...base, status: 'ERR', exitCode: 3, verdict: T('the chain or the sidecar could not be read: nothing decided; run it again.', '链或旁路读不到：无法判定；请重试。') }
    const mf = byId(r1, 'manifest-file')
    if (mf && mf.status !== 'pass' && /not published|no file|nothing is published/i.test(String(mf.detail))) return { ...base, status: 'TODO', exitCode: 0, verdict: T('waiting for you: the manifest is not on chain yet (console step 5).', '等你去做：清单还没上链（操作台第 5 步）。') }
    if (byId(r1, 'activation')?.status === 'fail') return { ...base, status: 'TODO', exitCode: 0, verdict: T('waiting for you: the name is not activated (step 2).', '等你去做：名字未激活（第 2 步）。'), next: ctx.initCmd(2) }
    const d = declared(r1)
    if (d && !sameSet(d, formats)) return { ...base, status: 'FAIL', exitCode: 1, verdict: T(`the manifest on chain declares ${d.join(', ')}, but you chose ${formats.join(', ')}: set FORMATS, restart, and publish again (console step 5; one more transaction, ${PAY.en}).`, `链上清单声明的是 ${d.join('、')}，但你选择的是 ${formats.join('、')}：改 FORMATS、重启，再发布一次（操作台第 5 步；再一笔交易，${PAY.zh}）。`) }
    if (r1.exitCode === 0 && r2.exitCode === 0) return { ...base, status: 'DONE', exitCode: 0, verdict: T('both runs exit 0: read their last lines aloud if someone is helping you.', '两次都是退出码 0：有人在帮你的话，把最后一行念给对方听即可。') }
    return { ...base, status: 'FAIL', exitCode: 1, verdict: T("not done yet: see the failed checks above and the doctor's fix lines.", '本步未完成：见上面失败的检查与 doctor 的修复说明。') }
  },

  // [6] Users: connect, as a user would. / 用户：像用户那样 connect。
  async (ctx) => {
    const name = ctx.A.name
    const who = T('Who does it, who pays: you, with a user-level token of your own gateway; what that call uses is billed by your gateway, to you. We never see the token.', '谁做、谁付钱：你，用你自己网关的用户级令牌；这次调用的用量由你的网关计费，记在你自己账上。我们不看这个令牌。')
    const you = [
      T(`Your users run ${ctx.cmd} connect ${name}: it prints client settings only for the formats your manifest declares.`, `你的用户运行 ${ctx.cmd} connect ${name}：它只为你的清单声明的格式给出客户端配置。`),
      T(`Be a user once: in one terminal ${ctx.cmd} connect ${name} --proxy ; in another, make one call through it with your own user-level token in API_KEY. The proxy's line must start with OK.`, `自己当一次用户：在一个终端运行 ${ctx.cmd} connect ${name} --proxy ；在另一个终端用你自己的用户级令牌（放在 API_KEY）经它调用一次。代理那一行必须以 OK 开头。`),
      INOTES.receipt,
    ]
    const r = await connectReport(name, { api: ctx.api(), proxyCommand: `${ctx.cmd} connect ${name} --proxy` })
    const base = { who, you, checks: [{ command: `${ctx.cmd} connect ${name}`, exitCode: r.exitCode }], quote: [ctx.L(T(`connect: ${r.status}${r.formats.length ? `; formats ${r.formats.join(', ')}` : ''}${r.reason ? `; ${r.reason.en}` : ''}`, `connect：${r.status}${r.formats.length ? `；格式 ${r.formats.join('、')}` : ''}${r.reason ? `；${r.reason.zh}` : ''}`))] }
    if (r.exitCode === 3) return { ...base, status: 'ERR', exitCode: 3, verdict: T('the chain could not be read: nothing decided; run it again.', '链读不到：无法判定；请重试。') }
    if (r.exitCode !== 0) return { ...base, status: 'FAIL', exitCode: 1, verdict: T('a user cannot use the service yet (the reason is above).', '用户还用不了这个服务（原因见上）。') }
    // connect also shows an MCP tool service as usable (TAPI-20 §3.8); this wizard sets up an AI service. / connect 也把 MCP 工具服务显示为可用；本向导搭建的是 AI 服务。
    if (r.kind === 'mcp') return { ...base, status: 'FAIL', exitCode: 1, verdict: T('the published manifest is an MCP tool service (an mcp field, no ai field), not the AI service this wizard sets up.', '发布的清单是 MCP 工具服务（有 mcp 字段、没有 ai 字段），不是本向导搭建的 AI 服务。') }
    return { ...base, status: 'DONE', exitCode: 0, verdict: T('a user can resolve and use the service; the one call through the proxy is yours to make.', '用户能解析并使用这个服务；经代理的那一次调用由你自己来做。') }
  },

  // [7] Daily check, alerts, renewals: printed, and the doctor run once with --strict semantics. / 每日检查与续期。
  async (ctx) => {
    const name = ctx.A.name
    const who = T(`Who does it, who pays: you, in your own GitHub account or on your own server; alerts go to you only. Renewing the delegation (one transaction to publish again) and the activation (months x monthlyFee()) cost gas and fees: ${PAY.en}. We do not run your checks, receive your alerts or renew anything for you.`,
      `谁做、谁付钱：你，在你自己的 GitHub 账号或服务器上；告警只发给你。续委托（重新发布的一笔交易）与续激活（月数 × monthlyFee()）要花 gas 与费用：${PAY.zh}。我们不替你跑检查、不接收你的告警、不替你续任何东西。`)
    const renew = T(`Renew the delegation every 90 days (the doctor warns with fewer than 30 days left): console step 4 "Renew", put the new DELEGATION_EXPIRES and DELEGATION_SIG in ${ENV_FILE}, docker compose up -d, then console step 5 "publish again". If you think SIGNER_KEY leaked, do not renew: generate a new key in console step 3 and redo steps 3 to 5.`,
      `每 90 天续一次委托（剩不到 30 天时 doctor 会警告）：操作台第 4 步"续期"，把新的 DELEGATION_EXPIRES 与 DELEGATION_SIG 填进 ${ENV_FILE}，docker compose up -d，再在操作台第 5 步"重新发布"。若怀疑 SIGNER_KEY 泄露，不要续期：在操作台第 3 步生成新密钥，重做第 3 到 5 步。`)
    const you = [
      ...(ctx.renew ? [renew] : []),
      T(`Daily: ${ctx.cmd} doctor ${name} --json --strict   (exit 0, or look at it)`, `每天：${ctx.cmd} doctor ${name} --json --strict   （退出码 0，否则去看一下）`),
      T(`Daily: save /api/pricing and /api/status yourself, then ${ctx.cmd} prices check pricing.json --models ${MODELS_FILE} --status status.json --fetched-as anonymous   (exit 1: the prices drifted; change the chain first, console step 5, then your site)`, `每天：自己存下 /api/pricing 与 /api/status，再运行 ${ctx.cmd} prices check pricing.json --models ${MODELS_FILE} --status status.json --fetched-as anonymous   （退出码 1：价目漂移；先改链上，操作台第 5 步，再改站点）`),
      ...(ctx.renew ? [] : [renew]),
      T(`The activation: renew it before it runs out, from the wallet that holds the circuit (the doctor's activation line says until when; read monthlyFee() on chain when you pay).`, `激活：到期前用持有电路的钱包续期（doctor 的激活一项写明付费到何时；付款时从链上读取 monthlyFee()）。`),
    ]
    const report = await doctor(ctx, name, { api: ctx.api() })
    const notPass = report.checks.filter((c) => c.status === 'warn' || c.status === 'fail' || c.status === 'error').map((c) => c.id)
    const base = { who, you, checks: [{ command: ctx.commands.doctor(`${name} --strict`), exitCode: report.exitCode === 0 && report.counts?.warn ? 1 : report.exitCode, failing: notPass }],
      quote: doctorLines(report, { ids: ['delegation', 'activation', ...notPass], lang: quoteLang(ctx) }) }
    if (undecided(report)) return { ...base, status: 'ERR', exitCode: 3, verdict: T('the chain or the sidecar could not be read: nothing decided; run it again.', '链或旁路读不到：无法判定；请重试。') }
    if (report.exitCode !== 0) return { ...base, status: 'FAIL', exitCode: 1, verdict: T('a check fails today: see above (the doctor says what to do).', '今天有检查失败：见上（doctor 写明了要做什么）。') }
    if (report.counts?.warn) return { ...base, status: 'TODO', exitCode: 0, verdict: T('a warning today (with --strict the daily check exits 1): see above; a delegation warning means renew now.', '今天有警告（加 --strict 的每日检查会退出 1）：见上；委托警告即现在就要续期。') }
    return { ...base, status: 'DONE', exitCode: 0, verdict: T('every check is clean today. Keep the daily check running in your own account.', '今天各项检查都没有问题。把每日检查放在你自己的账号里持续运行。') }
  },
]
