#!/usr/bin/env node
// tapeapi-doctor (@experimental): the provider-side check of an AI service on TapeAPI. Give it your TapeOut name, your
// container address or your sidecar's URL; it checks in order: the name resolves -> the circuit exists -> the container
// is opened -> the manifest file is on chain -> its format -> the delegation (days left) -> the ai field -> the price
// table -> the endpoints -> reachable (TLS, sidecar ready) -> CORS -> a real request gets a receipt that verifies -> the
// receipt lookup. Every check says pass or fail and, when it fails, what is missing, where to fix it and the next
// command, in English and Chinese. The exit status is for CI. Reads only: it signs nothing, sends no transaction, and
// its one request per endpoint uses a key that cannot be valid (no tokens spent, unless your gateway accepts any key:
// then a few input tokens and 1 to 16 output tokens per endpoint) unless --key-env names your own.
// tapeapi-doctor（实验性）：服务方对自己 TapeAPI AI 服务的检查。给它你的 TapeOut 名字、容器地址或旁路地址，按顺序检查：名字能解析
// -> 电路存在 -> 容器已开通 -> 链上有清单文件 -> 清单格式 -> 委托（剩余天数）-> ai 字段 -> 价目表 -> 端点 -> 可访问（TLS、旁路就绪）
// -> CORS -> 真实请求拿到可核验的回执 -> 按 id 取回执。每一项给出通过或失败，失败时用中英双语说明缺什么、去哪改、下一条命令。
// 退出码供 CI 使用。只读：不签任何东西、不发交易；每个端点一个请求，用的是不可能有效的密钥（不消耗 token；除非你的网关接受任意密钥，
// 那样每个端点会消耗几个输入 token 加 1 到 16 个输出 token），除非 --key-env 指定你自己的。
//
// Why its own command and not a mode of tapeapi-verify: tapeapi-verify is the users' long-running proxy, whose exit
// status 0 means "stopped normally"; a CI check needs 0 to mean "everything passed". Two audiences, two commands.
// 为什么单独成命令、不做成 tapeapi-verify 的模式：tapeapi-verify 是用户常驻的代理，退出码 0 表示“正常停止”；CI 检查需要 0 表示
// “全部通过”。两类用户，两个命令。
//
//   node sdk/bin/tapeapi-doctor.js 42.1013.tape          (42.1013.tape is an example name / 示例名)
//   node sdk/bin/tapeapi-doctor.js https://api.example.com
//   node sdk/bin/tapeapi-doctor.js --offline http://127.0.0.1:8080

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTapeAPI, rpcUrlsFor, operatorOf, CHAINS, chainByKey } from '../src/index.js'
import { diagnose, formatReport, redactSecret } from '../src/doctor.js'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const DEFAULT_RPC = rpcUrlsFor(56)

const USAGE = `tapeapi-doctor ${VERSION} (experimental): check an AI service on TapeAPI, step by step, from the provider's side.
检查 TapeAPI 上的 AI 服务（服务方视角），逐项给出结论与中英双语的修复提示。

Usage: tapeapi-doctor [options] <target>

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
  node examples/relay-trial/trial.mjs

Exit status: 0 every check passed (warnings allowed unless --strict); 1 a check failed; 2 a usage mistake; 3 the
chain or the network could not be read (a timeout, a refused connection, DNS), so nothing was decided: run it again.
退出码：0 全部通过（除非 --strict，否则允许警告）；1 有检查失败；2 用法错误；3 链或网络读不到（超时、拒绝连接、DNS）、无法判定：请重试。
`

function parseArgs(argv) {
  const o = { target: null, offline: false, allowHttp: false, keyEnv: null, model: null, origin: null, json: false, lang: 'both', strict: false, timeout: 15, rpc: null, chainRpc: {} }
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], v
    const eq = a.startsWith('--') ? a.indexOf('=') : -1
    if (eq > 0) { v = a.slice(eq + 1); a = a.slice(0, eq) }
    const value = () => {
      if (v !== undefined) return v
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`)
      return argv[++i]
    }
    switch (a) {
      case '--help': case '-h': o.help = true; break
      case '--version': case '-v': o.version = true; break
      case '--offline': o.offline = true; break
      case '--allow-http': o.allowHttp = true; break
      case '--json': o.json = true; break
      case '--strict': o.strict = true; break
      case '--key-env': o.keyEnv = value(); if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(o.keyEnv)) throw new Error('--key-env takes the NAME of an environment variable, not the key itself'); break
      case '--model': o.model = value(); break
      case '--origin': o.origin = value(); if (!/^https?:\/\/[^/\s]+$/.test(o.origin)) throw new Error('--origin must be an origin, like https://example.org'); break
      case '--lang': o.lang = value(); if (!['en', 'zh', 'both'].includes(o.lang)) throw new Error('--lang must be en, zh or both'); break
      case '--timeout': o.timeout = Number(value()); if (!Number.isFinite(o.timeout) || o.timeout <= 0) throw new Error('--timeout must be a positive number of seconds'); break
      case '--rpc': o.rpc = value().split(',').map((s) => s.trim()).filter(Boolean); break
      case '--rpc-xlayer': case '--rpc-base': o.chainRpc[chainByKey(a.slice(6)).chainId] = value().split(',').map((s) => s.trim()).filter(Boolean); break
      default:
        if (a.startsWith('-')) throw new Error(`unknown option ${a}`)
        if (o.target) throw new Error('name one target')
        o.target = a
    }
  }
  if (o.target && /^http:\/\//i.test(o.target)) {
    let h = ''
    try { h = new URL(o.target).hostname } catch { throw new Error(`${o.target} is not a URL`) }
    if (!/^(127\.0\.0\.1|localhost|\[::1\])$/.test(h)) throw new Error('http is accepted only on 127.0.0.1 / localhost; a public sidecar must be https')
  }
  if (o.offline && o.target && !/^https?:\/\//i.test(o.target)) throw new Error('--offline applies to a sidecar URL only: a name or a container is read on chain')
  if (o.allowHttp && o.target && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(o.target)) throw new Error('--allow-http applies to a loopback sidecar URL only (http://127.0.0.1:PORT or http://localhost:PORT)')
  return o
}

async function main() {
  let opts
  try { opts = parseArgs(process.argv.slice(2)) } catch (e) { process.stderr.write(`tapeapi-doctor: ${e.message}\n\n${USAGE}`); process.exit(2) }
  if (opts.help) { process.stdout.write(USAGE); return }
  if (opts.version) { process.stdout.write(`${VERSION}\n`); return }
  if (!opts.target) { process.stderr.write(`tapeapi-doctor: name what to check\n\n${USAGE}`); process.exit(2) }
  let key = null
  if (opts.keyEnv) {
    key = process.env[opts.keyEnv]
    if (!key) { process.stderr.write(`tapeapi-doctor: the environment variable ${opts.keyEnv} is empty\n`); process.exit(2) }
  }
  const urlMode = /^https?:\/\//i.test(opts.target)
  const rpcUrls = opts.rpc ?? DEFAULT_RPC
  if (new Set(rpcUrls.map(operatorOf)).size < 2) { process.stderr.write('tapeapi-doctor: --rpc needs nodes of at least 2 independent operators (every chain read must be agreed by 2)\n'); process.exit(2) }
  for (const [id, urls] of Object.entries(opts.chainRpc)) {
    if (new Set(urls.map(operatorOf)).size < 2) { process.stderr.write(`tapeapi-doctor: --rpc-${CHAINS[id].key} needs nodes of at least 2 independent operators\n`); process.exit(2) }
  }
  const chains = Object.fromEntries(Object.entries(opts.chainRpc).map(([id, urls]) => [id, { rpcUrls: urls }]))
  // URL mode reads the sidecar's own manifest (a dev-sourced resolve, which still checks the holder on chain).
  // 地址模式读取旁路自己的清单（dev 来源的解析，仍在链上核对持有人）。
  const api = urlMode && opts.offline ? null : createTapeAPI({ rpcUrls, quorum: 2, chains, ...(urlMode ? { dev: true } : {}) })
  let report
  try {
    report = await diagnose(opts.target, { api, offline: opts.offline, key, ...(opts.allowHttp ? { allowHttp: true } : {}), model: opts.model ?? undefined, origin: opts.origin ?? undefined, timeoutMs: opts.timeout * 1000 })
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
    if (opts.strict && report.exitCode === 0 && exit === 1) process.stdout.write('--strict: warnings count as failures / 警告按失败计\n')
  }
  process.exit(exit)
}

const self = (() => { try { return realpathSync(fileURLToPath(import.meta.url)) } catch { return null } })()
const argv1 = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) } catch { return null } })()
if (self && self === argv1) main().catch((e) => { process.stderr.write(`tapeapi-doctor: fatal: ${e?.stack || e}\n`); process.exit(3) })
