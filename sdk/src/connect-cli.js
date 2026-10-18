// `tapeapi connect` on the command line (@experimental; Node only): arguments, the client, colors, redaction, --json and
// --proxy (tapeapi-verify run as a child process, its output untouched). The card itself is connect.js.
// tapeapi connect 命令行部分（实验性；仅 Node）：参数、客户端、颜色、脱敏、--json 与 --proxy（以子进程运行 tapeapi-verify，输出原样）。
import { createTapeAPI, rpcUrlsFor, operatorOf, parseTapeName, CHAINS, chainByKey } from './index.js'
import { redactSecret } from './doctor.js'
import { connectReport, renderConnect, NOTES, MCP_NOTES, SNIPPET_TOOLS, MCP_SNIPPET_TOOLS, FORMAT_NAMES } from './connect.js'

const DEFAULT_PORT = 8790
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const isTarget = (s) => ADDRESS_RE.test(s) || (() => { const p = parseTapeName(s); return !!p && !p.error })()
const shellWord = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`)
// Environment variables whose values are never printed, whatever prints them (a gateway's echo, a manifest field).
// 其值绝不出现在输出里的环境变量（无论来自网关回显还是清单字段）。
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|SIG|SIGNATURE|MNEMONIC|SEED)$/i
// --tool values: the AI tools, then Claude Desktop (MCP tool services only). / --tool 的取值：AI 工具，再加 Claude Desktop（仅 MCP 工具服务）。
const TOOL_NAMES = [...Object.keys(SNIPPET_TOOLS), ...MCP_SNIPPET_TOOLS.filter((t) => !Object.hasOwn(SNIPPET_TOOLS, t))]

export function connectUsage(cmd = 'tapeapi') {
  return `${cmd} connect (experimental / 实验性): resolve an AI service, show it, and print client settings for the API formats its manifest declares.
解析一个 AI 服务并显示它，只为其清单声明的 API 格式给出客户端配置。
An MCP tool service (no ai field, an mcp field: TAPI-20 §3.8; experimental) gets Claude Code and Claude Desktop MCP
settings instead: through tapeapi-mcp, and its declared endpoint direct.
MCP 工具服务（没有 ai 字段、有 mcp 字段：TAPI-20 §3.8；实验性）改为给出 Claude Code 与 Claude Desktop 的 MCP 配置：经 tapeapi-mcp，以及直连其声明的端点。

Usage: ${cmd} connect <name> [options]

  <name>               the service's TapeOut name (42.1013.tape is an example name; 1.2.344.tape on X Layer) or its
                       container address. You get it from the provider; this command lists, ranks and picks no service
                       名字从服务方处取得；本命令不列出、不排序、不挑选任何服务
  --tool <t>           only the settings for one tool: ${TOOL_NAMES.join(', ')}
                       or all (default); a tool whose format the manifest does not declare is a usage mistake (exit 2)
  --format <f>         only one API format: ${FORMAT_NAMES.join(', ')}
  --proxy              after the card, run tapeapi-verify for this service (its output as it is; Ctrl-C stops it);
                       for an MCP tool service, tapeapi-mcp instead (stdio; the card goes to stderr, stdout is its JSON-RPC)
  --port <n>           with --proxy: the local port (default ${DEFAULT_PORT})
  --strict, --log <file>, --request-usage
                       with --proxy: passed to tapeapi-verify as they are
  --rpc <url,url,...>  BNB Chain nodes, at least 2 operators (default: ${rpcUrlsFor(56).length} public nodes of distinct operators)
  --rpc-xlayer <urls>  X Layer nodes      --rpc-base <urls>  Base nodes
  --dev <url>          TESTING ONLY: a local sidecar's manifest, no on-chain identity check (as tapeapi-verify --dev)
  --json               one JSON object on stdout (no --proxy)
  --lang <en|zh|both>  language of the text (default both)
  --no-color           no colors (also: NO_COLOR set, or stdout not a terminal)
  --help

It reads the chain and the manifest only: no transaction, no key or password asked for, nothing uploaded, nothing paid.
Output redaction: the value of an environment variable named *KEY, *TOKEN, *SECRET, *SIG, ... (unless it reads as
ordinary text: under 8 characters, with a space, or a plain word under 16), and anything shaped like a key (sk-...,
0x and 64 hex digits, a long hex run, the token after Bearer) is shown as ***; the rest of the manifest is shown as it is.
只读链与清单：不发交易、不索要任何密钥或密码、不上传、不付款。
输出脱敏：名为 *KEY、*TOKEN、*SECRET、*SIG 等的环境变量的值（读起来是普通文本的除外：少于 8 个字符、含空格、或少于 16 个字符的纯单词），
以及形似密钥的字符串（sk-…、0x 加 64 位十六进制、长十六进制串、Bearer 后的令牌）显示为 ***；清单其余内容原样显示。
Exit status: 0 done; 1 the service is unavailable or cannot be used; 2 a usage mistake (also --tool / --format naming a
format the manifest does not declare); 3 could not be read (the chain, or the --dev manifest): run it again.
退出码：0 完成；1 服务不可用或无法使用；2 用法错误（--tool / --format 点名了清单未声明的格式也算）；3 读不到（链或 --dev 清单）：请重试。
`
}

const usage = (en, zh) => Object.assign(new Error(en), { zh })
export function parseConnectArgs(argv) {
  const o = { target: null, dev: null, tool: 'all', format: undefined, proxy: false, port: null, strict: false, log: null, requestUsage: false, rpc: null, chainRpc: {}, json: false, lang: 'both', color: true, help: false }
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], v
    const eq = a.startsWith('--') ? a.indexOf('=') : -1
    if (eq > 0) { v = a.slice(eq + 1); a = a.slice(0, eq) }
    const value = () => {
      if (v !== undefined) return v
      if (i + 1 >= argv.length) throw usage(`${a} needs a value`, `${a} 需要一个值`)
      return argv[++i]
    }
    const urls = () => value().split(',').map((s) => s.trim()).filter(Boolean)
    switch (a) {
      case '--help': case '-h': o.help = true; break
      case '--proxy': o.proxy = true; break
      case '--strict': o.strict = true; break
      case '--request-usage': o.requestUsage = true; break
      case '--json': o.json = true; break
      case '--no-color': o.color = false; break
      case '--log': o.log = value(); break
      case '--dev': o.dev = value(); break
      case '--tool': o.tool = value(); if (o.tool !== 'all' && !TOOL_NAMES.includes(o.tool)) throw usage(`--tool must be one of ${TOOL_NAMES.join(', ')} or all`, `--tool 只能是 ${TOOL_NAMES.join('、')} 或 all`); break
      case '--format': o.format = value(); if (!FORMAT_NAMES.includes(o.format)) throw usage(`--format must be one of ${FORMAT_NAMES.join(', ')}`, `--format 只能是 ${FORMAT_NAMES.join('、')}`); break
      case '--port': o.port = Number(value()); if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw usage('--port must be 0 to 65535', '--port 必须是 0 到 65535'); break
      case '--lang': o.lang = value(); if (!['en', 'zh', 'both'].includes(o.lang)) throw usage('--lang must be en, zh or both', '--lang 只能是 en、zh 或 both'); break
      case '--rpc': o.rpc = urls(); break
      case '--rpc-xlayer': case '--rpc-base': o.chainRpc[chainByKey(a.slice(6)).chainId] = urls(); break
      default:
        if (a.startsWith('-')) throw usage(`unknown option ${a}`, `未知选项 ${a}`)
        if (o.target) throw usage('give one service only', '只能给一个服务')
        o.target = a
    }
  }
  if (o.help) return o
  if (o.target && o.dev) throw usage('give a service or --dev, not both', '服务与 --dev 只能给一个')
  if (!o.target && !o.dev) throw usage('no service: give its TapeOut name, which you get from the provider. The directory https://tapeapi.fun/directory/ lists the providers that registered themselves, in file order: no ranking, no picks', '没有服务：请给出它的 TapeOut 名字，名字从服务方处取得。目录 https://tapeapi.fun/directory/ 按文件顺序列出自己登记的服务方：不排序、不挑选')
  if (o.target && !isTarget(o.target)) throw usage(`${o.target} is not a TapeOut name (42.1013.tape, 1.2.344.tape) or a container address`, `${o.target} 不是 TapeOut 名字（42.1013.tape、1.2.344.tape）或容器地址`)
  if (o.proxy && o.json) throw usage('--json describes the service and starts nothing; --proxy runs tapeapi-verify, whose --log file is the machine-readable output', '--json 只描述服务、不启动任何东西；--proxy 运行 tapeapi-verify，机器可读的输出是它的 --log 文件')
  for (const [flag, on] of [['--port', o.port !== null], ['--strict', o.strict], ['--log', o.log !== null], ['--request-usage', o.requestUsage]]) {
    if (on && !o.proxy) throw usage(`${flag} applies with --proxy only`, `${flag} 只与 --proxy 一起使用`)
  }
  for (const [what, list] of [['--rpc', o.rpc], ...Object.entries(o.chainRpc).map(([id, l]) => [`--rpc-${CHAINS[id].key}`, l])]) {
    if (list && new Set(list.map(operatorOf)).size < 2) throw usage(`${what} needs nodes of at least 2 independent operators (every chain read must be agreed by 2)`, `${what} 至少需要 2 家独立运营方的节点（每次读链须 2 家一致）`)
  }
  return o
}

/**
 * Whether the value of a secret-named environment variable is redacted (FIXED C-1). Not when it reads as ordinary text:
 * shorter than 8 characters (as redactSecret), any whitespace inside ("in 1  out 2"), or a plain word of letters and
 * - _ . shorter than 16 characters ("production", "staging-eu"), which would blank ordinary words of the card. Every
 * other value is: 16 characters or more, or one with a digit or another sign (a password, a token, a key).
 * 名字像机密的环境变量，其值是否脱敏。读起来是普通文本时不脱敏：短于 8 个字符（同 redactSecret）、中间有空白、或少于 16 个字符的纯字母
 * 单词（可含 - _ .，如 "production"）——否则会把卡片上的普通词替换掉。其余一律脱敏：16 个字符及以上，或含数字或其它符号的值。
 */
export function envValueIsSecret(v) {
  if (typeof v !== 'string') return false
  const bare = v.trim().replace(/^bearer\s+/i, '').trim()
  if (bare.length < 8 || /\s/.test(bare)) return false
  return !(bare.length < 16 && /^[A-Za-z][A-Za-z_.-]*$/.test(bare))
}
/** Every value of a secret-looking environment variable, replaced by *** in `value` (deeply). / 把形似机密的环境变量值替换为 ***。 */
export function redactEnv(value, env = process.env) {
  let out = value
  for (const [k, v] of Object.entries(env ?? {})) if (SECRET_NAME.test(k) && envValueIsSecret(v)) out = redactSecret(out, v)
  return out
}
/**
 * Strings shaped like a key, replaced by *** wherever they come from (a manifest field, an echo; FIXED C-1), whether or
 * not this machine's environment holds them: an `sk-` token (16 characters or more after `sk-`), a 32-byte hex value
 * (0x and 64 hex digits exactly: a private key's shape), a bare hex run of 32 digits or more with a letter a-f in it,
 * and the token after `Bearer `. Not an address (0x and 40 hex digits), not a longer 0x value (a signature), not a
 * decimal number, not `Bearer $API_KEY`.
 * 形似密钥的字符串一律替换为 ***（不论来自清单字段还是回显，也不论本机环境里有没有）：sk- 令牌（sk- 之后至少 16 个字符）、32 字节十六进制
 * （0x 加恰好 64 位：私钥的形状）、至少 32 位且含 a-f 字母的裸十六进制串、Bearer 后面的令牌。不替换地址（0x 加 40 位）、更长的 0x 值
 * （签名）、十进制数、Bearer $API_KEY。
 */
const KEY_SHAPES = [
  [/(?<![\w-])sk-[A-Za-z0-9_-]{16,}/g, '***'],
  [/(?<![0-9A-Za-z])0x[0-9a-fA-F]{64}(?![0-9A-Za-z])/g, '***'],
  [/(?<![0-9A-Za-z])(?=[0-9]*[a-fA-F])[0-9a-fA-F]{32,}(?![0-9A-Za-z])/g, '***'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/g, '$1 ***'],
]
export function redactKeyShapes(text) {
  let out = String(text)
  for (const [re, by] of KEY_SHAPES) out = out.replace(re, by)
  return out
}
/**
 * What every line of output goes through: the environment's secret values, then key shapes. `keep`: a public value the
 * key-shape rule would blank and that is shown as it is (an MCP tool service's mcp.toolsSha256, 64 hex digits published
 * on chain, as S3 keeps a receipt's hashes); the environment rule still applies to it.
 * 每段输出都经过：环境机密值，再按形状。keep：按形状规则会被替换、但原样显示的公开值（MCP 工具服务链上发布的 mcp.toolsSha256，
 * 同 S3 保留回执哈希）；环境机密值规则对它照样适用。
 */
export const redactOutput = (text, env = process.env, keep = null) => {
  const t = redactEnv(text, env)
  return keep ? t.split(keep).map(redactKeyShapes).join(keep) : redactKeyShapes(t)
}

/**
 * Run `tapeapi connect` with `argv`. Returns { exitCode } or, with --proxy, { child } (the tapeapi-verify run's exit).
 * io: cmd (how `tapeapi` is written in printed commands), version, verifyBin, runChild(file, args), stdout / stderr
 * (write functions), env, isTTY, apiOptions (merged into createTapeAPI's options: tests pass a fake chain's fetch).
 * 运行 tapeapi connect。io 注入打印用的命令写法、版本、verify 路径、子进程运行器、输出、环境与 createTapeAPI 的附加选项（测试用假链）。
 */
export async function runConnect(argv, io = {}) {
  const { cmd = 'tapeapi', version = '', verifyBin, mcpBin, runChild, env = process.env, apiOptions = {} } = io
  const stdout = io.stdout ?? ((s) => process.stdout.write(s))
  const stderr = io.stderr ?? ((s) => process.stderr.write(s))
  const isTTY = io.isTTY ?? process.stdout.isTTY === true
  let keep = null
  const say = (write, text) => write(redactOutput(text, env, keep))
  let o
  try { o = parseConnectArgs(argv) } catch (e) {
    say(stderr, `tapeapi connect: ${e.message}\ntapeapi connect: ${e.zh ?? e.message}\n\n${connectUsage(cmd)}\nnext: / 下一条命令: ${cmd} connect --help\n`)
    return { exitCode: 2 }
  }
  if (o.help) { say(stdout, connectUsage(cmd)); return { exitCode: 0 } }
  const color = o.color && isTTY && !o.json && (env.NO_COLOR === undefined || env.NO_COLOR === '')
  const port = o.port ?? DEFAULT_PORT
  const proxyCommand = `${cmd} connect ${o.dev ? `--dev ${shellWord(o.dev)}` : shellWord(o.target)} --proxy${o.port !== null && o.port !== DEFAULT_PORT ? ` --port ${o.port}` : ''}`
  const chains = Object.fromEntries(Object.entries(o.chainRpc).map(([id, urls]) => [id, { rpcUrls: urls }]))
  const api = o.dev ? createTapeAPI({ dev: true, ...apiOptions }) : createTapeAPI({ rpcUrls: o.rpc ?? rpcUrlsFor(56), quorum: 2, chains, conform: 'tap10', ...apiOptions })
  const r = await connectReport(o.target, { api, dev: o.dev, tool: o.tool, format: o.format, port, proxyCommand, version: version || undefined })
  if (r.kind === 'mcp') keep = r.service.mcp.toolsSha256
  // --port, --strict, --log and --request-usage are tapeapi-verify's: with an MCP tool service they are a usage mistake.
  // --port、--strict、--log、--request-usage 属于 tapeapi-verify：用于 MCP 工具服务即为用法错误。
  const verifyOnly = [['--port', o.port !== null], ['--strict', o.strict], ['--log', o.log !== null], ['--request-usage', o.requestUsage]].filter(([, on]) => on).map(([f]) => f)
  if (r.kind === 'mcp' && verifyOnly.length) {
    say(stderr, `tapeapi connect: ${verifyOnly.join(', ')}: tapeapi-verify's options; this is an MCP tool service, whose --proxy runs tapeapi-mcp\ntapeapi connect: ${verifyOnly.join('、')} 是 tapeapi-verify 的选项；这是 MCP 工具服务，其 --proxy 运行 tapeapi-mcp\nnext: / 下一条命令: ${cmd} connect ${o.dev ? `--dev ${shellWord(o.dev)}` : shellWord(o.target)} --proxy\n`)
    return { exitCode: 2 }
  }
  // The command for the last line of a non-zero exit, pasteable as it is. / 非 0 退出最后一行的命令，可直接粘贴。
  const target = o.dev ?? o.target
  const again = `${cmd} connect ${argv.map(shellWord).join(' ')}`
  const [next, nextHint] = r.exitCode === 0 ? [null, null]
    : r.exitCode === 3 ? [again, { en: 'Nothing was decided; run it again (other nodes: --rpc):', zh: '无法判定；请重试（换节点：--rpc）：' }]
      : r.exitCode === 2 && r.status !== 'not-declared' ? [`${cmd} connect --help`, { en: 'Check the name and the options (--rpc: nodes of this chain):', zh: '检查名字与选项（--rpc：这条链的节点）：' }]
      : r.exitCode === 2 ? [`${cmd} connect ${o.dev ? `--dev ${shellWord(o.dev)}` : shellWord(o.target)}`, r.kind === 'mcp' ? { en: 'Without --tool / --format, every setting its mcp field allows:', zh: '不带 --tool / --format，列出其 mcp 字段允许的全部配置：' } : { en: 'Without --tool / --format, every format the manifest declares:', zh: '不带 --tool / --format，列出清单声明的全部格式：' }]
        : [`${cmd} doctor ${o.dev ? `--offline ${shellWord(o.dev)}` : shellWord(o.target)}`, { en: 'Your own service? The doctor checks it step by step and says what is missing:', zh: '是你自己的服务？doctor 逐项检查并说明缺什么：' }]
  if (o.json) {
    const L = (t) => (o.lang === 'en' ? t?.en : o.lang === 'zh' ? t?.zh : t) ?? null
    say(stdout, JSON.stringify({
      tool: 'tapeapi', command: 'connect', version, experimental: true, target, resolution: r.resolution, ok: r.ok, exitCode: r.exitCode, status: r.status,
      reason: L(r.reason), detail: r.detail, service: r.service, formats: r.formats, snippets: r.snippets.map((s) => ({ ...s, title: L(s.title) })),
      notes: Object.fromEntries(Object.entries(r.kind === 'mcp' ? MCP_NOTES : NOTES).map(([k, t]) => [k, L(t)])), next, kind: r.kind,
    }, null, 2) + '\n')
    return { exitCode: r.exitCode }
  }
  // An MCP tool service's --proxy: tapeapi-mcp speaks JSON-RPC on stdout, so the card and the start line go to stderr
  // (where tapeapi-mcp logs) and stdout carries its protocol only. / MCP 工具服务的 --proxy：tapeapi-mcp 在 stdout 上说 JSON-RPC，
  // 所以卡片与启动行写到 stderr（tapeapi-mcp 也在那里记日志），stdout 只有它的协议。
  const mcpProxy = o.proxy && r.kind === 'mcp' && r.exitCode === 0
  say(mcpProxy ? stderr : stdout, renderConnect(r, { lang: o.lang, color, version, next, nextHint }) + '\n')
  if (!o.proxy || r.exitCode !== 0) return { exitCode: r.exitCode }
  if (mcpProxy) {
    const margs = [...(o.rpc ? ['--rpc', o.rpc.join(',')] : []), ...Object.entries(o.chainRpc).flatMap(([id, urls]) => [`--rpc-${CHAINS[id].key}`, urls.join(',')]), ...(o.dev ? ['--dev', o.dev] : [o.target])]
    const start = o.lang === 'en' ? 'starting tapeapi-mcp (stdio; it waits for an MCP client on stdin; Ctrl-C stops it):' : o.lang === 'zh' ? '启动 tapeapi-mcp（stdio；在标准输入上等待 MCP 客户端；Ctrl-C 停止）：' : 'starting tapeapi-mcp (stdio; it waits for an MCP client on stdin; Ctrl-C stops it) / 启动 tapeapi-mcp（stdio；在标准输入上等待 MCP 客户端；Ctrl-C 停止）:'
    say(stderr, `\n${start} tapeapi-mcp ${margs.map(shellWord).join(' ')}\n`)
    return { child: await runChild(mcpBin, margs) }
  }
  // --proxy: tapeapi-verify as it is (the options given, in a fixed order); nothing is written to stderr before it.
  // --proxy：原样运行 tapeapi-verify（按固定顺序传入给出的选项）；在它之前不向 stderr 写任何字节。
  const args = [...(o.dev ? ['--dev', o.dev] : [o.target]), ...(o.port !== null ? ['--port', String(o.port)] : []), ...(o.strict ? ['--strict'] : []), ...(o.log !== null ? ['--log', o.log] : []), ...(o.requestUsage ? ['--request-usage'] : []),
    ...(o.rpc ? ['--rpc', o.rpc.join(',')] : []), ...Object.entries(o.chainRpc).flatMap(([id, urls]) => [`--rpc-${CHAINS[id].key}`, urls.join(',')])]
  say(stdout, `\n${o.lang === 'en' ? 'starting tapeapi-verify (Ctrl-C stops it):' : o.lang === 'zh' ? '启动 tapeapi-verify（Ctrl-C 停止）：' : 'starting tapeapi-verify (Ctrl-C stops it) / 启动 tapeapi-verify（Ctrl-C 停止）:'} tapeapi-verify ${args.map(shellWord).join(' ')}\n`)
  return { child: await runChild(verifyBin, args) }
}
