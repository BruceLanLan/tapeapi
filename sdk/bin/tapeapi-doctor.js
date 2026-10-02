#!/usr/bin/env node
// tapeapi-doctor (@experimental): the provider-side check of an AI service on TapeAPI, from a TapeOut name, a container
// address or a sidecar's URL to a receipt that verifies (sdk/src/doctor.js lists the checks). Every failed check says what
// is missing, where to fix it and the next command, in English and Chinese; the exit status is for CI. Reads only: it
// signs nothing, sends no transaction, and its one request per endpoint carries a key that cannot be valid unless
// --key-env names the operator's own. Its own command, not a mode of tapeapi-verify, whose exit 0 means "stopped".
// tapeapi-doctor（实验性）：服务方对自己 AI 服务的逐项检查，失败时用中英双语给出缺什么、去哪改、下一条命令；退出码供 CI 使用。只读。
//
//   npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v1.5.0/tapeapi-sdk-1.5.0.tgz tapeapi-doctor 42.1013.tape
//   node sdk/bin/tapeapi-doctor.js --offline http://127.0.0.1:8080      (from a checkout / 从检出运行)
import { readFileSync, realpathSync, existsSync } from 'node:fs'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTapeAPI, rpcUrlsFor, operatorOf, CHAINS, chainByKey } from '../src/index.js'
import { diagnose, formatReport, redactSecret, doctorCommands } from '../src/doctor.js'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const DEFAULT_RPC = rpcUrlsFor(56)
const self = (() => { try { return realpathSync(fileURLToPath(import.meta.url)) } catch { return null } })()

/** How this command was run, so the commands the report names paste as they are (ONB2-1, ONB2-3). / 本命令的运行方式。 */
export function howRun(file = self, cwd = process.cwd(), version = VERSION) {
  if (!file) return {}
  const trial = join(dirname(file), '..', '..', 'examples', 'relay-trial', 'trial.mjs')
  const rel = (p) => { const r = relative(cwd, p); return r && !isAbsolute(r) ? r.split('\\').join('/') : p }
  if (existsSync(trial)) return { run: 'checkout', bin: rel(file), trial: rel(trial) }
  return { run: /[\\/]_npx[\\/]/.test(file) ? 'npx' : 'installed', version }
}
const CMDS = doctorCommands(howRun())

const USAGE = `tapeapi-doctor ${VERSION} (experimental): check an AI service on TapeAPI, step by step, from the provider's side.
检查 TapeAPI 上的 AI 服务（服务方视角），逐项给出结论与中英双语的修复提示。

Usage: ${CMDS.doctor('[options] <target>')}

14 checks, in order: name, circuit, container, activation, manifest-file, manifest-format, delegation, ai-field, prices,
endpoints, reach, cors, receipt, receipt-lookup. "activation" (TAP-10 §6.3) only warns: an unpaid name still has its site
files, but a TAP-11 client answers "unpaid" and does not resolve the service; --strict makes that warning fail too.
14 项检查，依次为：名字、电路、容器、激活、清单文件、清单格式、委托、ai 字段、价目表、端点、可访问、CORS、回执、按 id 取回执。
“激活”（TAP-10 §6.3）只警告：未付费的名字站点文件仍可读，但按 TAP-11 的客户端会得到 unpaid、不解析此服务；--strict 时这个警告也算失败。

  <target>             your TapeOut name (42.1013.tape is an example name; on X Layer or Base with its area code,
                       1.2.344.tape), your container address (0x...), or your sidecar's URL (https://api.example.com;
                       http only on 127.0.0.1 / localhost)
  --offline            URL only: do not read the chain (a local or throwaway identity, e.g. the local trial)
  --key-env <VAR>      also make one real call per endpoint with the API key held in environment variable VAR (your
                       own key: your gateway charges it a few input tokens and 1 output token, 16 on
                       openai-responses, whose minimum is 16). The key goes only to the host you name (for a name:
                       the hosts of its signed endpoints), only over https, and is shown as *** in every report.
                       Without it, the one request per endpoint carries a key that cannot be valid: no tokens are
                       spent, unless your gateway accepts any key (then the same few tokens; the doctor warns)
  --allow-http         with --key-env: allow sending your key over plain http to a loopback sidecar
                       (127.0.0.1 / localhost) only
  --model <id>         the model for those requests (default: the first model of each format in your price table)
  --origin <url>       the Origin sent in the CORS checks (default https://example.org)
  --json               print the report as JSON on stdout (for CI and scripts)
  --lang <en|zh|both>  language of the text report (default both)
  --strict             a warning fails too (exit 1)
  --timeout <s>        per HTTP request (default 15)
  --rpc <url,url,...>  BNB Chain nodes; each chain read needs 2 to agree (default: ${DEFAULT_RPC.length} public nodes of distinct operators)
  --rpc-xlayer <urls>  X Layer nodes      --rpc-base <urls>  Base nodes
  --version, --help

No service yet? Run the local trial first (no key, no circuit, no cost):
还没有自己的服务？先跑本地试跑（不需要密钥、电路，也不花钱）：
  ${CMDS.trial}

Exit status: 0 every check passed (warnings allowed unless --strict); 1 a check failed; 2 a usage mistake; 3 the
chain or the network could not be read (a timeout, a refused connection, DNS), so nothing was decided: run it again.
退出码：0 全部通过（除非 --strict，否则允许警告）；1 有检查失败；2 用法错误；3 链或网络读不到（超时、拒绝连接、DNS）、无法判定：请重试。
`

// Usage mistakes in both languages: --lang is not read yet (ONB2-7) / 用法错误双语
const usage = (en, zh) => Object.assign(new Error(en), { zh })
function parseArgs(argv) {
  const o = { target: null, offline: false, allowHttp: false, keyEnv: null, model: null, origin: null, json: false, lang: 'both', strict: false, timeout: 15, rpc: null, chainRpc: {} }
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], v
    const eq = a.startsWith('--') ? a.indexOf('=') : -1
    if (eq > 0) { v = a.slice(eq + 1); a = a.slice(0, eq) }
    const value = () => {
      if (v !== undefined) return v
      if (i + 1 >= argv.length) throw usage(`${a} needs a value`, `${a} 需要一个值`)
      return argv[++i]
    }
    switch (a) {
      case '--help': case '-h': o.help = true; break
      case '--version': case '-v': o.version = true; break
      case '--offline': o.offline = true; break
      case '--allow-http': o.allowHttp = true; break
      case '--json': o.json = true; break
      case '--strict': o.strict = true; break
      case '--key-env': o.keyEnv = value(); if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(o.keyEnv)) throw usage('--key-env takes the NAME of an environment variable, not the key itself', '--key-env 接收环境变量的名字，而不是密钥本身'); break
      case '--model': o.model = value(); break
      case '--origin': o.origin = value(); if (!/^https?:\/\/[^/\s]+$/.test(o.origin)) throw usage('--origin must be an origin, like https://example.org', '--origin 必须是一个源，例如 https://example.org'); break
      case '--lang': o.lang = value(); if (!['en', 'zh', 'both'].includes(o.lang)) throw usage('--lang must be en, zh or both', '--lang 只能是 en、zh 或 both'); break
      case '--timeout': o.timeout = Number(value()); if (!Number.isFinite(o.timeout) || o.timeout <= 0) throw usage('--timeout must be a positive number of seconds', '--timeout 必须是正数（秒）'); break
      case '--rpc': o.rpc = value().split(',').map((s) => s.trim()).filter(Boolean); break
      case '--rpc-xlayer': case '--rpc-base': o.chainRpc[chainByKey(a.slice(6)).chainId] = value().split(',').map((s) => s.trim()).filter(Boolean); break
      default:
        if (a.startsWith('-')) throw usage(`unknown option ${a}`, `未知选项 ${a}`)
        if (o.target) throw usage('give one target only', '只能给一个检查对象')
        o.target = a
    }
  }
  if (o.target && /^http:\/\//i.test(o.target)) {
    let h = ''
    try { h = new URL(o.target).hostname } catch { throw usage(`${o.target} is not a URL`, `${o.target} 不是网址`) }
    if (!/^(127\.0\.0\.1|localhost|\[::1\])$/.test(h)) throw usage('http is accepted only on 127.0.0.1 / localhost; a public sidecar must be https', '只有 127.0.0.1 / localhost 接受 http；公开的旁路必须用 https')
  }
  if (o.offline && o.target && !/^https?:\/\//i.test(o.target)) throw usage('--offline applies to a sidecar URL only: a name or a container is read on chain', '--offline 只用于旁路地址：名字或容器要读链')
  if (o.allowHttp && o.target && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(o.target)) throw usage('--allow-http applies to a loopback sidecar URL only (http://127.0.0.1:PORT or http://localhost:PORT)', '--allow-http 只用于回环地址上的旁路（http://127.0.0.1:端口 或 http://localhost:端口）')
  return o
}

async function main() {
  let opts
  try { opts = parseArgs(process.argv.slice(2)) } catch (e) { process.stderr.write(`tapeapi-doctor: ${e.message}\ntapeapi-doctor: ${e.zh ?? e.message}\n\n${USAGE}`); process.exit(2) }
  if (opts.help) { process.stdout.write(USAGE); return }
  if (opts.version) { process.stdout.write(`${VERSION}\n`); return }
  if (!opts.target) { process.stderr.write(`tapeapi-doctor: no target: give your TapeOut name, your container address or your sidecar's URL\ntapeapi-doctor: 没有检查对象：请给出你的 TapeOut 名字、容器地址或旁路地址\n\n${USAGE}`); process.exit(2) }
  let key = null
  if (opts.keyEnv) {
    key = process.env[opts.keyEnv]
    if (!key) { process.stderr.write(`tapeapi-doctor: the environment variable ${opts.keyEnv} is empty\ntapeapi-doctor: 环境变量 ${opts.keyEnv} 是空的\n`); process.exit(2) }
  }
  const urlMode = /^https?:\/\//i.test(opts.target)
  const rpcUrls = opts.rpc ?? DEFAULT_RPC
  if (new Set(rpcUrls.map(operatorOf)).size < 2) { process.stderr.write('tapeapi-doctor: --rpc needs nodes of at least 2 independent operators (every chain read must be agreed by 2)\ntapeapi-doctor: --rpc 至少需要 2 家独立运营方的节点（每次读链须 2 家一致）\n'); process.exit(2) }
  for (const [id, urls] of Object.entries(opts.chainRpc)) {
    if (new Set(urls.map(operatorOf)).size < 2) { process.stderr.write(`tapeapi-doctor: --rpc-${CHAINS[id].key} needs nodes of at least 2 independent operators\ntapeapi-doctor: --rpc-${CHAINS[id].key} 至少需要 2 家独立运营方的节点\n`); process.exit(2) }
  }
  const chains = Object.fromEntries(Object.entries(opts.chainRpc).map(([id, urls]) => [id, { rpcUrls: urls }]))
  // URL mode reads the sidecar's own manifest (a dev-sourced resolve, which still checks the holder on chain).
  // 地址模式读取旁路自己的清单（dev 来源的解析，仍在链上核对持有人）。
  const api = urlMode && opts.offline ? null : createTapeAPI({ rpcUrls, quorum: 2, chains, ...(urlMode ? { dev: true } : {}) })
  let report
  try {
    report = await diagnose(opts.target, { api, offline: opts.offline, key, ...(opts.allowHttp ? { allowHttp: true } : {}), model: opts.model ?? undefined, origin: opts.origin ?? undefined, timeoutMs: opts.timeout * 1000, commands: CMDS })
  } catch (e) {
    process.stderr.write(`tapeapi-doctor: ${redactSecret(String(e?.message ?? e), key)}\n`)
    process.exit(e?.code === 'INVALID_ARGUMENT' ? 2 : 3)
  }
  let exit = report.exitCode
  if (opts.strict && exit === 0 && report.counts.warn) exit = 1
  if (opts.json) {
    // No key in the report: every text is redacted (diagnose does it; again here). / 报告里没有密钥：每段文字都已脱敏（diagnose 做过，这里再做一次）。
    process.stdout.write(JSON.stringify(redactSecret({ tool: 'tapeapi-doctor', version: VERSION, target: report.target, mode: report.mode, chainId: report.chainId, ok: exit === 0, exitCode: exit, strict: opts.strict, counts: report.counts, checks: report.checks }, key), null, 2) + '\n')
  } else {
    process.stdout.write(redactSecret(formatReport(report, { lang: opts.lang, version: VERSION }), key) + '\n')
    if (opts.strict && report.exitCode === 0 && exit === 1) process.stdout.write(`${opts.lang === 'zh' ? '--strict：警告按失败计' : opts.lang === 'en' ? '--strict: warnings count as failures' : '--strict: warnings count as failures / 警告按失败计'}\n`)
  }
  process.exit(exit)
}

const argv1 = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) } catch { return null } })()
if (self && self === argv1) main().catch((e) => { process.stderr.write(`tapeapi-doctor: fatal: ${e?.stack || e}\n`); process.exit(3) })
