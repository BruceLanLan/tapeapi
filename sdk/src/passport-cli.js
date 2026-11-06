// `tapeapi passport` and the passport lines of `tapeapi-doctor --passport`, `tapeapi connect --passport` and `tapeapi init
// --passport` (@experimental, 3.0; outside the compatibility promise). The resolver is the separate package
// @tapeapi/passport, which follows an open TAP draft (TAPs pull request #83 at cae25e6, not merged); this module never
// imports it: sdk/bin passes the loaded module as io.passport (null when it is not installed). Read-only: no
// transaction, no key, no signature. Like every module under src/, it imports nothing Node-only.
// tapeapi passport 以及 doctor / connect / init 的护照部分（实验性，3.0）。解析器是独立包 @tapeapi/passport（依据未合并的
// TAPs PR #83 草案）；本模块从不导入它：由 sdk/bin 把加载好的模块作为 io.passport 传入（未安装时为 null）。只读：不发交易、不要密钥、不签名。
import { createTapeAPI, rpcUrlsFor, operatorOf } from './index.js'
import { redactEnv } from './connect-cli.js'
import { parseOptions, commonOptions, usage, usageExit, clean } from './receipts-cli.js'
import { PASSPORT_MISSING, passportExit, passportLines } from './passport-view.js'

export function passportUsage(cmd = 'tapeapi') {
  return `${cmd} passport (experimental / 实验性): resolve an Agent Passport, read-only, as the open draft TAPs #83 (head cae25e6, not merged) says.
按未合并的草案 TAPs #83（头 cae25e6）只读地解析 Agent 护照。

Usage: ${cmd} passport <agentId | name | processor#ID> [--json] [--lang en|zh|both] [--rpc <urls>]
                        [--logs-rpc <urls> --logs-from <block> [--logs-chunk <n>] [--logs-max <n>]]

  <agentId>            an ERC-8004 identity of the registry deployed on BNB Smart Chain (a decimal number)
  <name>               a TapeOut name on BNB Smart Chain, 4246.0.tape (an example)
  <processor#ID>       a processor contract and a circuit #ID, 0x...#4246
  --rpc <urls>         BNB Chain nodes, at least 2 operators (default: ${rpcUrlsFor(56).length} public nodes of distinct operators)
  --logs-rpc <urls>    log-capable nodes of at least 2 operators, for site operators (P-8) and the holder history (§7).
                       Without them both are reported as not checked, never as passed
                       能查日志的节点（至少 2 家）；没有它们时这两项报"未检查"，绝不当作已检查
  --logs-from <block>  where the log scan starts (default 0: complete, but far over the request budget on BNB Chain)
  --logs-chunk <n>     blocks per eth_getLogs (default 5000)      --logs-max <n>  requests at most (default 64)
  --json               one JSON object on stdout                  --help

A passport says only that one wallet holds both an ERC-8004 identity and a TapeOut circuit and published the link; not
which code the agent runs, nor that it is honest or safe. Reads only: no transaction, no key, no signature.
护照只说明同一个钱包持有 ERC-8004 身份与 TapeOut 电路、并公布了这一关联；不说明 agent 运行什么代码、是否诚实或安全。只读。
Exit status: 0 CONFIRMED; 1 not a passport, or not confirmed (the reason is shown); 2 a usage mistake, or
@tapeapi/passport not installed; 3 nothing could be read: run it again.
退出码：0 CONFIRMED；1 不是护照或尚未确认（会写明原因）；2 用法错误或未安装 @tapeapi/passport；3 读不到：请重试。
`
}
const SPEC = { '--json': 'bool', '--lang': 'value', '--rpc': 'value', '--logs-rpc': 'value', '--logs-from': 'value', '--logs-chunk': 'value', '--logs-max': 'value', '--help': 'bool', '-h': '--help', '--no-color': 'bool' }
const urlsOf = (flag, v) => {
  const urls = String(v).split(',').map((s) => s.trim()).filter(Boolean)
  if (new Set(urls.map(operatorOf)).size < 2) throw usage(`${flag} needs nodes of at least 2 independent operators (strict agreement)`, `${flag} 至少需要 2 家独立运营方的节点（严格共识）`)
  return urls
}
const whole = (flag, v, min) => { const n = Number(v); if (!/^[0-9]+$/.test(String(v)) || !Number.isSafeInteger(n) || n < min) throw usage(`${flag} must be a whole number of at least ${min}`, `${flag} 必须是不小于 ${min} 的整数`); return n }

/** The input of `tapeapi passport`: an agentId, a name or processor#ID. / 命令的输入。 */
export function passportInput(s) {
  const t = String(s ?? '').trim()
  if (/^(0|[1-9][0-9]{0,77})$/.test(t)) return { agentId: t }
  const m = /^(0x[0-9a-fA-F]{40})#([1-9][0-9]{0,18})$/.exec(t)
  if (m) return { circuit: { processor: m[1], tokenId: m[2] } }
  if (/^[1-9][0-9]*\.(0|[1-9][0-9]*)(\.tape)?$/.test(t)) return { name: t.endsWith('.tape') ? t : `${t}.tape` }
  throw usage(`${JSON.stringify(clean(t).slice(0, 80))} is not an agentId, a name (4246.0.tape) or processor#ID (0x...#4246)`, `${JSON.stringify(clean(t).slice(0, 80))} 不是 agentId、名字（4246.0.tape）或 处理器#ID（0x...#4246）`)
}

/** `tapeapi passport ...` with io: { cmd, version, passport (the module or null), env, stdout, stderr, apiOptions }. */
export async function runPassport(argv, io = {}) {
  const { cmd = 'tapeapi', version = '', env = process.env, apiOptions = {} } = io
  const stdout = io.stdout ?? ((s) => process.stdout.write(s))
  const stderr = io.stderr ?? ((s) => process.stderr.write(s))
  // Only the environment's secret values are blanked: everything printed is public chain data (addresses, block hashes,
  // the draft head), which the key-shape rule of connect would blank. / 只遮环境机密值：输出都是公开的链上数据。
  const say = (write, text) => write(redactEnv(text, env))
  const help = passportUsage(cmd)
  let o, common, input, rpc = null, logs = 'off'
  try {
    const p = parseOptions(argv, SPEC); o = p.opts
    if (o['--help']) { say(stdout, help); return { exitCode: 0 } }
    common = commonOptions(o)
    if (p.positional.length !== 1) throw usage('give one agentId, name or processor#ID', '请给出一个 agentId、名字或 处理器#ID')
    input = passportInput(p.positional[0])
    if (o['--rpc'] !== undefined) rpc = urlsOf('--rpc', o['--rpc'])
    if (o['--logs-rpc'] !== undefined) logs = { urls: urlsOf('--logs-rpc', o['--logs-rpc']), ...(o['--logs-from'] !== undefined ? { fromBlock: whole('--logs-from', o['--logs-from'], 0) } : {}), ...(o['--logs-chunk'] !== undefined ? { chunk: whole('--logs-chunk', o['--logs-chunk'], 1) } : {}), ...(o['--logs-max'] !== undefined ? { maxRequests: whole('--logs-max', o['--logs-max'], 1) } : {}) }
    else if (['--logs-from', '--logs-chunk', '--logs-max'].some((f) => o[f] !== undefined)) throw usage('--logs-from, --logs-chunk and --logs-max go with --logs-rpc', '--logs-from、--logs-chunk、--logs-max 要与 --logs-rpc 一起用')
  } catch (e) {
    if (!e.usage) throw e
    return usageExit({ e, prog: `${cmd} passport`, help, cmd: `${cmd} passport`, stderr, say })
  }
  if (!io.passport) {
    say(stderr, `${cmd} passport: ${PASSPORT_MISSING.en}\n${cmd} passport: ${PASSPORT_MISSING.zh}\n`)
    return { exitCode: 2 }
  }
  const api = createTapeAPI({ rpcUrls: rpc ?? rpcUrlsFor(56), quorum: 2, quiet: true, ...apiOptions })
  // The resolver throws only INVALID_ARGUMENT, before any read (an agentId above 2^256 - 1, a #ID above 10^18, a name out
  // of range): a usage mistake, exit 2 (FIXED R30-S1: a stack trace and exit 3, "run it again").
  // 解析器只在读取之前抛 INVALID_ARGUMENT（agentId 超过 2^256 - 1、#ID 超过 10^18、名字超出范围）：用法错误，退出码 2。
  let res
  try { res = await io.passport.resolvePassport(input, { api, logs, ...(apiOptions.fetch ? { fetch: apiOptions.fetch } : {}) }) } catch (e) {
    if (e?.code !== 'INVALID_ARGUMENT') throw e
    return usageExit({ e: usage(e.message, e.message), prog: `${cmd} passport`, help, cmd: `${cmd} passport`, stderr, say })
  }
  const exitCode = passportExit(res)
  const notes = [io.passport.PASSPORT_NOTES.experimental, io.passport.PASSPORT_NOTES.receipt]
  if (common.json) {
    const { snapshot, ...rest } = res
    say(stdout, JSON.stringify({ tool: 'tapeapi', command: 'passport', version, experimental: true, input, exitCode, ...rest }, (k, v) => (typeof v === 'bigint' ? String(v) : v), 2) + '\n')
    return { exitCode }
  }
  const L = (en, zh) => (common.lang === 'en' ? en : common.lang === 'zh' ? zh : `${en} / ${zh}`)
  say(stdout, [`${cmd} passport ${version} (${L('experimental', '实验性')})`, ...passportLines(res, { lang: common.lang, notes })].join('\n') + '\n')
  return { exitCode }
}
