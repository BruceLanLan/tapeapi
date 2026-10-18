#!/usr/bin/env node
// tapeapi (@experimental): one entry for the TapeAPI command-line tools. Outside the compatibility promise: the command,
// its subcommands and their output may change or go away in any minor version.
//   tapeapi doctor|verify|mcp ...   the existing tapeapi-doctor / tapeapi-verify / tapeapi-mcp, run as a child process with
//                                   the arguments as given: output, exit status and stdin unchanged (the dispatcher writes
//                                   nothing itself, so tapeapi mcp's stdout stays JSON-RPC only). Those commands stay.
//   tapeapi connect <name>          resolve an AI service, show it, and print client settings for the API formats its
//                                   manifest declares (sdk/src/connect-cli.js); --proxy then runs tapeapi-verify.
//   tapeapi receipts tail|show|export   the receipts saved on this machine (sdk/src/receipts-cli.js); files only
//   tapeapi reconcile                   those receipts against a bill file (sdk/src/reconcile-cli.js); files only
//   tapeapi init                        the operator's wizard, step by step (sdk/src/init-cli.js); it prints what the
//                                       operator does and checks it read-only: no key asked for, nothing paid or sent
//   tapeapi prices convert|check|show   an entry for examples/new-api-sidecar/pricing-convert.mjs (a checkout only) and
//                                       a view of a price table and its source record (sdk/src/prices-cli.js)
// tapeapi（实验性）：TapeAPI 命令行的统一入口，不受兼容承诺约束。doctor|verify|mcp 以子进程原样运行现有命令（参数、输出、退出码、
// 标准输入都不变；分发器自己不写任何字节），原命令名保留。connect 解析一个 AI 服务、显示它，并只为其清单声明的格式给出客户端配置。
// receipts 列出、查看（离线重放核验）与导出本机回执；reconcile 把回执与账单文件逐行对账。两者只读本机文件、不联网。
// init 是运营者向导：逐步打印他要做的事并只读地检查，不索要密钥、不付款、不发交易；prices 是价目转换器的入口（只在检出里）与价目表查看。
//
//   node sdk/bin/tapeapi.js connect 42.1013.tape          (from a checkout / 从检出运行; 42.1013.tape is an example name)
import { spawn } from 'node:child_process'
import { readFileSync, realpathSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const self = (() => { try { return realpathSync(fileURLToPath(import.meta.url)) } catch { return null } })()
const BIN_DIR = dirname(fileURLToPath(import.meta.url))

/** The pure aliases: subcommand -> the bin it runs. / 纯别名：子命令 -> 它运行的命令。 */
export const ALIASES = Object.freeze({ doctor: 'tapeapi-doctor.js', verify: 'tapeapi-verify.js', mcp: 'tapeapi-mcp.js' })

/**
 * How `tapeapi` itself is written in the commands it prints (as tapeapi-doctor's howRun does): from a checkout a path
 * relative to the working directory, from the release package with npx, or installed.
 * 打印的命令里 tapeapi 本身的写法（与 tapeapi-doctor 的 howRun 一致）：检出时为相对路径，经 npx 从发布包，或已安装。
 */
export function tapeapiCommand(file = self, cwd = process.cwd(), version = VERSION) {
  if (!file) return 'tapeapi'
  if (existsSync(join(dirname(file), '..', '..', 'examples', 'relay-trial', 'trial.mjs'))) {
    const r = relative(cwd, file)
    const p = r && !isAbsolute(r) ? r.split('\\').join('/') : file
    return `node ${/[\s"'$`\\]/.test(p) ? JSON.stringify(p) : p}`
  }
  return /[\\/]_npx[\\/]/.test(file) ? `npx -y --package=https://github.com/BruceLanLan/tapeapi/releases/download/v${version}/tapeapi-sdk-${version}.tgz tapeapi` : 'tapeapi'
}

const USAGE = `tapeapi ${VERSION} (experimental / 实验性): one entry for the TapeAPI command-line tools.
TapeAPI 命令行工具的统一入口。实验性：不受兼容承诺约束，任一次版本都可能改动或移除。

Usage: tapeapi <command> [arguments]

  doctor ...           the same as tapeapi-doctor ...  (the provider's step-by-step check / 服务方逐项自检)
  verify ...           the same as tapeapi-verify ...  (the local verifying proxy / 本地核验代理)
  mcp ...              the same as tapeapi-mcp ...     (the local MCP server / 本地 MCP 服务器)
                       arguments, output and exit status exactly as the original command; those commands stay
                       参数、输出与退出码与原命令完全相同；原命令名保留
  connect <name>       resolve an AI service, show it, and print client settings for the formats its manifest declares;
                       --proxy then starts tapeapi-verify for it. tapeapi connect --help for its options
                       解析一个 AI 服务并显示它，只为其清单声明的格式给出客户端配置；--proxy 随后为它启动 tapeapi-verify
                       an MCP tool service (mcp field): MCP settings, and --proxy starts tapeapi-mcp (experimental)
                       MCP 工具服务（mcp 字段）：给出 MCP 配置，--proxy 启动 tapeapi-mcp（实验性）
  receipts tail|show|export
                       the receipts saved on this machine: list them, show one and replay its checks offline (against
                       a manifest snapshot), export them as CSV or JSON. tapeapi receipts --help for the options
                       本机保存的回执：列出、查看一张并离线重放核验（依据清单快照）、导出为 CSV 或 JSON
  reconcile            the usage and prices your receipts claim, set row by row against a bill file: match, missing,
                       mismatch, each with its lines. tapeapi reconcile --help for the options
                       把回执声称的用量与价格与账单文件逐行对账：匹配、缺失、不一致，各带出处行
                       receipts and reconcile read files only: no network, no key
                       receipts 与 reconcile 只读本机文件：不联网、不需要密钥
  init                 the operator's wizard, step by step from nothing to live: what you do, where, who pays (you),
                       and a read-only check of it. FORMATS has no default. tapeapi init --help for the steps
                       运营者向导，从零到上线逐步进行：你做什么、在哪里做、谁付钱（你自己），并只读地检查。FORMATS 没有默认值
  prices convert|check|show
                       new-api's price list into the price table (convert, check: the converter in a checkout, as it
                       is) and a view of the table with its source record (show). tapeapi prices --help
                       把 new-api 的价目转成价目表（convert、check：检出里的转换器，原样运行），查看价目表与来源记录（show）
  --version, --help

Exit status of connect / connect 的退出码: 0 done; 1 the service is unavailable or cannot be used (the reason is shown);
2 a usage mistake; 3 the chain or the network could not be read, nothing was decided: run it again.
0 完成；1 服务不可用或无法使用（会写明原因）；2 用法错误；3 链或网络读不到、无法判定：请重试。
receipts / reconcile: 0 done (all checks passed, all rows match); 1 a check failed, or something is missing or differs;
2 a usage mistake; 3 nothing could be decided (no manifest snapshot, nothing to compare).
0 完成（核验通过、全部匹配）；1 核验未通过，或有缺失、不一致；2 用法错误；3 无法判定（没有清单快照、没有可比较的内容）。
init: 0 the step is done or waits for you (TODO); 1 its check failed; 2 a usage mistake or a missing answer (FORMATS not
chosen among them); 3 could not be read. prices: the converter's 0 / 1 drift / 2; show 0 / 2.
init：0 本步完成或在等你去做（TODO）；1 本步检查失败；2 用法错误或缺答案（包括没有选择 FORMATS）；3 读不到。prices：沿用转换器的 0 / 1 漂移 / 2；show 为 0 / 2。
`

/**
 * Run `file` with `args` as a child process sharing this one's stdin, stdout and stderr; resolve to its exit. SIGINT,
 * SIGTERM and SIGHUP sent to this process are passed on to the child and do not stop this one: the child decides (a
 * Ctrl-C in a terminal reaches both; the tools' own handlers exit at once, so a second copy changes nothing).
 * 以子进程运行 file，共用标准输入输出；返回它的退出。发给本进程的 SIGINT、SIGTERM、SIGHUP 转给子进程，本进程不因此退出，由子进程决定
 * （终端里的 Ctrl-C 同时到达两者；这些工具自己的处理函数立即退出，多收到一次不改变结果）。
 */
export function runChild(file, args) {
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, [file, ...args], { stdio: 'inherit' })
    const forward = (sig) => () => { try { child.kill(sig) } catch { /* gone */ } }
    const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => [s, forward(s)])
    for (const [s, h] of handlers) process.on(s, h)
    const done = () => { for (const [s, h] of handlers) process.off(s, h) }
    child.once('error', (e) => { done(); fail(e) })
    child.once('exit', (code, signal) => { done(); ok({ code, signal }) })
  })
}

/** Leave with the child's status, or by the same signal. / 以子进程的退出码退出，或以同一信号结束。 */
function exitLike({ code, signal }) {
  if (signal) { process.kill(process.pid, signal); return }
  process.exit(code ?? 1)
}

async function main(argv) {
  const [sub, ...rest] = argv
  if (sub && Object.hasOwn(ALIASES, sub)) return exitLike(await runChild(join(BIN_DIR, ALIASES[sub]), rest))
  const cmd = tapeapiCommand()
  if (sub === 'connect') {
    const { runConnect } = await import('../src/connect-cli.js')
    const r = await runConnect(rest, { cmd, version: VERSION, verifyBin: join(BIN_DIR, ALIASES.verify), mcpBin: join(BIN_DIR, ALIASES.mcp), runChild })
    if (r.child) return exitLike(r.child)
    // stdout may be a pipe written asynchronously: let the card reach it before leaving. / stdout 可能是异步写的管道：先让卡片写完再退出。
    await new Promise((ok) => process.stdout.write('', ok))
    return process.exit(r.exitCode)
  }
  if (sub === 'receipts' || sub === 'reconcile') {
    // The file functions the two modules use (src/ imports nothing Node-only). / 两个模块用到的文件函数。
    const host = { readFileSync, readdirSync, statSync, writeFileSync, join, dirname, relative, isAbsolute }
    const r = sub === 'receipts'
      ? await (await import('../src/receipts-cli.js')).runReceipts(rest, { cmd, version: VERSION, host })
      : await (await import('../src/reconcile-cli.js')).runReconcile(rest, { cmd, version: VERSION, host })
    await new Promise((ok) => process.stdout.write('', ok))
    return process.exit(r.exitCode)
  }
  if (sub === 'init' || sub === 'prices') {
    const host = { readFileSync, readdirSync, statSync, writeFileSync, join, dirname, relative, isAbsolute }
    let r
    if (sub === 'prices') {
      // The converter is part of a checkout (examples/), not of the package: loaded only when it is there and needed.
      // 转换器属于检出（examples/），不在安装包里：只在存在且需要时加载。
      const file = join(BIN_DIR, '..', '..', 'examples', 'new-api-sidecar', 'pricing-convert.mjs')
      const converter = ['convert', 'check'].includes(rest[0]) && existsSync(file) ? await import(pathToFileURL(file).href) : null
      r = await (await import('../src/prices-cli.js')).runPrices(rest, { cmd, version: VERSION, host, converter })
    } else {
      // The doctor's own way of writing the trial command (checkout, npx, installed), and questions on a terminal only.
      // 本地试跑命令按 doctor 的写法（检出、npx、已安装）；只在终端里提问。
      const { howRun } = await import('./tapeapi-doctor.js')
      const { doctorCommands } = await import('../src/doctor.js')
      const ask = process.stdin.isTTY && process.stderr.isTTY ? async (q) => {
        const { createInterface } = await import('node:readline/promises')
        const rl = createInterface({ input: process.stdin, output: process.stderr })
        try { return await rl.question(q) } finally { rl.close() }
      } : null
      r = await (await import('../src/init-cli.js')).runInit(rest, { cmd, version: VERSION, host, ask, commands: doctorCommands(howRun(join(BIN_DIR, 'tapeapi-doctor.js'))) })
    }
    await new Promise((ok) => process.stdout.write('', ok))
    return process.exit(r.exitCode)
  }
  if (sub === '--help' || sub === '-h' || sub === 'help') { process.stdout.write(USAGE); return }
  if (sub === '--version' || sub === '-v') { process.stdout.write(`${VERSION}\n`); return }
  const what = sub === undefined ? ['no command given', '没有给出子命令'] : [`unknown command ${JSON.stringify(sub)}`, `未知子命令 ${JSON.stringify(sub)}`]
  process.stderr.write(`tapeapi: ${what[0]}\ntapeapi: ${what[1]}\n\n${USAGE}\nnext: / 下一条命令: ${cmd} --help\n`)
  process.exit(2)
}

const argv1 = (() => { try { return process.argv[1] && realpathSync(process.argv[1]) } catch { return null } })()
if (self && self === argv1) main(process.argv.slice(2)).catch((e) => { process.stderr.write(`tapeapi: fatal: ${e?.stack || e}\nnext: / 下一条命令: ${tapeapiCommand()} --help\n`); process.exit(3) })
