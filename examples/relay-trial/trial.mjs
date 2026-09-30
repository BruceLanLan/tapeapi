#!/usr/bin/env node
// The local trial for an AI relay: before buying anything, see the whole path work on this machine, with no API key, no
// circuit, no container and no gas. One command starts the new-api package's own sidecar entry
// (examples/new-api-sidecar/server.mjs) in front of the repository's FAKE upstream (examples/ai-proxy/fake-upstream.mjs:
// no real model, no real key; it stands for your new-api, LiteLLM or model server), with a throwaway identity and the
// example price table, then:
//   1. runs tapeapi-doctor against the sidecar (offline: the identity is not on chain), the same check you will run
//      against your TapeOut name once you are live;
//   2. calls it the way your users' apps do, through the SDK's verifying fetch (a plain answer, a stream, Anthropic
//      Messages), and shows one signed receipt;
//   3. starts tapeapi-verify, the proxy your Claude Code and Codex users run, and sends one call through it;
//   4. alters one byte of a signed answer and shows that the receipt check catches it.
// Everything listens on 127.0.0.1 on free ports and stops at the end (--keep leaves it running).
// 中转站的本地试跑：在花任何钱之前，在本机看整条路径跑通，不需要 API 密钥、电路、容器，也不花 gas。一条命令启动 new-api 包自己的
// 旁路入口，放在仓库的**模拟**上游前面（没有真实模型、没有真实密钥；它代表你的 new-api、LiteLLM 或模型服务），用一次性身份与
// 示例价目表，然后：1. 用 tapeapi-doctor 检查旁路（离线：身份不在链上），上线后你对自己的 TapeOut 名字跑的是同一个检查；
// 2. 像你的用户的应用那样经由 SDK 的核验 fetch 调用它（普通回答、流式、Anthropic Messages），并展示一份签名回执；
// 3. 启动 tapeapi-verify（你的 Claude Code、Codex 用户运行的代理），经由它发一次调用；4. 改动签名回答的一个字节，展示回执核验能发现。
// 全部只监听 127.0.0.1 的空闲端口，结束时关闭（--keep 让它继续运行）。
//
//   npm ci --no-audit --no-fund             # once, at the repository root / 在仓库根目录，一次
//   node examples/relay-trial/trial.mjs [--keep] [--lang en|zh|both]
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const MAIN = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
/**
 * A dependency that is not installed, in words (review ONB2-2): a fresh clone has no node_modules until `npm ci`.
 * Returns the message, or null for any other error. / 依赖未安装时的提示：新克隆在 npm ci 之前没有 node_modules。其它错误返回 null。
 */
export function missingDependencies(e) {
  if (e?.code !== 'ERR_MODULE_NOT_FOUND') return null
  return 'The repository\'s dependencies are not installed. Run this once at the repository root, then run the trial again:\n' +
    '仓库的依赖还没有安装。先在仓库根目录运行一次下面的命令，再重新运行试跑：\n\n  npm ci --no-audit --no-fund\n'
}
// Imported here, not at the top, so that a missing dependency gets the message above instead of a stack trace.
// 在这里而不是文件顶部导入：缺依赖时给出上面的提示，而不是一段调用栈。
let createTapeAPI, ai, diagnose, formatReport, startStack, DEMO_KEY
try {
  ;({ createTapeAPI, ai } = await import('@tapeapi/sdk'))
  ;({ diagnose, formatReport } = await import('../../sdk/src/doctor.js'))
  ;({ startStack } = await import('../new-api-sidecar/smoke.mjs'))
  ;({ DEMO_KEY } = await import('../ai-proxy/fake-upstream.mjs'))
} catch (e) {
  const m = missingDependencies(e)
  if (!m) throw e
  if (MAIN) { console.error(m); process.exit(1) }
  throw new Error(m, { cause: e })
}

const VERIFY_BIN = fileURLToPath(new URL('../../sdk/bin/tapeapi-verify.js', import.meta.url))
const enc = new TextEncoder()

/** Start tapeapi-verify --dev in front of the sidecar on a free port. / 在旁路前面、空闲端口上启动 tapeapi-verify --dev。 */
async function startVerify(sidecarUrl) {
  const child = spawn(process.execPath, [VERIFY_BIN, '--dev', sidecarUrl, '--port', '0'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => { err += d })
  const url = await new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error(`tapeapi-verify did not start:\n${err}`)), 15_000)
    const on = () => { const m = /listening on (http:\/\/\S+)/.exec(err); if (m) { clearTimeout(t); child.stderr.off('data', on); ok(m[1]) } }
    child.stderr.on('data', on); child.once('exit', (c) => { clearTimeout(t); no(new Error(`tapeapi-verify exited (${c}):\n${err}`)) })
  })
  return { url, stderr: () => err, close: () => new Promise((ok) => { child.once('exit', ok); child.kill('SIGTERM') }) }
}

/**
 * Run the trial. Returns { ok, steps: [{ step, ok, text }] }; `say` prints as it goes.
 * 运行试跑。返回 { ok, steps }；say 边跑边打印。
 */
export async function runTrial({ say = () => {}, lang = 'both', keep = false } = {}) {
  // A block: both languages on lines of their own. Inline (Li): joined by " / ". / 段落：两种语言各占一行；行内（Li）：以 " / " 连接。
  const L = (en, zh) => (lang === 'en' ? en : lang === 'zh' ? zh : `${en}\n${zh.replace(/^\n/, '')}`)
  const Li = (en, zh) => (lang === 'en' ? en : lang === 'zh' ? zh : `${en} / ${zh}`)
  const steps = []
  const step = (name, ok, text) => { steps.push({ step: name, ok, text }); say(`${ok ? 'OK  ' : 'FAIL'} ${text}`) }
  const stack = await startStack({ env: { SERVICE_NAME: 'Local trial relay' } })
  let verify = null
  try {
    const url = stack.sidecar.url
    say(L(`\n== 0. Started on this machine: a FAKE upstream (stands for your gateway; no real model, no key) at ${stack.fake.baseUrl}`, `\n== 0. 已在本机启动：模拟上游（代表你的网关；没有真实模型、没有密钥）${stack.fake.baseUrl}`))
    say(L(`       and the signing sidecar in front of it at ${url} (throwaway identity: nothing on chain)`, `       以及它前面的签名旁路 ${url}（一次性身份：链上什么都没有）`))

    // 1. The doctor, offline. / 诊断（离线）。
    say(L('\n== 1. tapeapi-doctor --offline (the check you will run against your TapeOut name later)', '\n== 1. tapeapi-doctor --offline（上线后你对自己的 TapeOut 名字跑的是同一个检查）'))
    const report = await diagnose(url, { offline: true })
    say(formatReport(report, { lang }))
    step('doctor', report.exitCode === 0, Li(`doctor: ${report.counts.pass} passed, ${report.counts.fail} failed (identity checks skipped: not on chain)`, `诊断：${report.counts.pass} 项通过，${report.counts.fail} 项失败（身份项跳过：不在链上）`))

    // 2. As your users' apps call it: the SDK's verifying fetch. / 像用户的应用那样调用：SDK 的核验 fetch。
    say(L('\n== 2. Calls as your users\' apps make them (OpenAI / Anthropic SDK shape), every receipt verified', '\n== 2. 像用户的应用那样调用（OpenAI / Anthropic SDK 的请求），每份回执都核验'))
    const api = createTapeAPI({ dev: true })
    const svc = await api.resolve({ dev: url })
    const reports = []
    const vfetch = ai.createVerifyingFetch({ api, service: svc, onReport: (r) => reports.push(r) })
    const epOf = (f) => svc.manifest[ai.MANIFEST_FIELD].endpoints.find((e) => e.format === f).baseUrl
    const oa = { authorization: `Bearer ${DEMO_KEY}`, 'content-type': 'application/json' }
    const an = { 'x-api-key': DEMO_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    const calls = [
      { label: 'OpenAI Chat', url: `${epOf('openai-chat')}/chat/completions`, headers: oa, body: { model: 'gpt-5-mini', messages: [{ role: 'user', content: 'Hello from the local trial' }] } },
      { label: 'OpenAI Chat, streamed', url: `${epOf('openai-chat')}/chat/completions`, headers: oa, body: { model: 'deepseek-chat', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'Stream this please' }] } },
      { label: 'Anthropic Messages, streamed', url: `${epOf('anthropic-messages')}/v1/messages`, headers: an, body: { model: 'claude-sonnet-4-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'Hi from Claude Code' }] } },
    ]
    let shown = null
    for (const c of calls) {
      const before = reports.length
      const res = await vfetch(c.url, { method: 'POST', headers: c.headers, body: JSON.stringify(c.body) })
      await res.arrayBuffer()   // read to the end: a stream's receipt is checked at its end / 读完：流的回执在结尾核验
      const r = reports[before]
      const rc = r?.receipt?.result
      const ok = res.status === 200 && !!r?.ok && !!rc?.prices
      step('call', ok, `${c.label.padEnd(29)} HTTP ${res.status}  model=${rc?.model}  tokens=${rc?.usage ? `${rc.usage.prompt_tokens}+${rc.usage.completion_tokens}` : '-'}  ${rc?.prices ? rc.prices.map((p) => `${p.amount} ${p.currency}`).join(' / ') : 'unpriced'}  ${Li('receipt', '回执')} ${r?.ok ? Li('verified', '核验通过') : `FAILED ${r?.problems?.join('; ')}`}`)
      shown ??= r?.receipt
    }
    if (shown) {
      say(L('\n   One signed receipt, as your users receive it (header x-tapeapi-receipt, or an SSE comment in a stream):', '\n   一份签名回执，用户收到的就是它（响应头 x-tapeapi-receipt，流里是一行 SSE 注释）：'))
      say(JSON.stringify(shown, null, 2).split('\n').map((l) => `   ${l}`).join('\n'))
      say(L('   It proves who answered (signer), which request and response bytes (hashes), and what usage and price were claimed; not which model actually ran.', '   它证明谁回答的（签名者）、哪些请求与回答字节（哈希）、声称了多少用量与价格；不证明实际运行的是哪个模型。'))
    }

    // 3. Through tapeapi-verify, as a Claude Code user. / 经由 tapeapi-verify，像 Claude Code 用户那样。
    say(L('\n== 3. Through tapeapi-verify, the local proxy your Claude Code / Codex users run', '\n== 3. 经由 tapeapi-verify（你的 Claude Code / Codex 用户在本机运行的代理）'))
    verify = await startVerify(url)
    const before = verify.stderr().length
    const vr = await fetch(`${verify.url}/v1/messages`, { method: 'POST', headers: an, body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'Hi through tapeapi-verify' }] }) })
    await vr.arrayBuffer()
    let line = ''
    for (let i = 0; i < 200 && !line; i++) { line = verify.stderr().slice(before).split('\n').find((l) => /\] (OK|FAIL)/.test(l)) ?? ''; if (!line) await new Promise((ok) => setTimeout(ok, 10)) }
    step('verify', vr.status === 200 && /\] OK/.test(line), `${Li('what a Claude Code user sees on stderr', 'Claude Code 用户在 stderr 看到的')}:\n       ${line.replace(/^\[tapeapi-verify\] /, '').trim()}`)

    // 4. An altered answer is caught. / 被改动的回答会被发现。
    say(L('\n== 4. One byte of a signed answer altered on the way: the receipt check catches it', '\n== 4. 签名回答在途中被改动一个字节：回执核验会发现'))
    const reqBytes = enc.encode(JSON.stringify(calls[0].body))
    const res = await fetch(calls[0].url, { method: 'POST', headers: calls[0].headers, body: reqBytes })
    const bytes = new Uint8Array(await res.arrayBuffer())
    const envelope = ai.decodeReceiptHeader(res.headers.get(ai.RECEIPT_HEADER))
    const good = ai.verifyUsageReceipt({ envelope, manifest: svc.manifest, requestBytes: reqBytes, responseBytes: bytes, path: '/v1/chat/completions', status: res.status, stream: false, maxSkewS: 300 })
    const altered = bytes.slice(); const at = new TextDecoder().decode(altered).indexOf('Hi!'); altered[at >= 0 ? at + 2 : altered.length - 3] ^= 1
    const bad = ai.verifyUsageReceipt({ envelope, manifest: svc.manifest, requestBytes: reqBytes, responseBytes: altered, path: '/v1/chat/completions', status: res.status, stream: false, maxSkewS: 300 })
    step('tamper', good.ok && !bad.ok, `${Li('original answer', '原始回答')}: ${good.ok ? Li('verified', '核验通过') : 'NOT verified'}; ${Li('altered answer', '改动后的回答')}: ${bad.ok ? 'verified (WRONG)' : `${Li('refused', '被拒绝')} (${bad.problems.join('; ')})`}`)

    const ok = steps.every((s) => s.ok)
    say(L(`\n== ${ok ? 'The trial passed.' : 'The trial FAILED.'} Next, on your own server (you pay and run everything; TapeAPI hosts nothing and pays for nothing):`, `\n== ${ok ? '试跑通过。' : '试跑失败。'}接下来在你自己的服务器上（费用与运行都由你自己承担；TapeAPI 不托管、不代付任何东西）：`))
    for (const [en, zh] of [
      ['1. Buy a TapeOut circuit on https://tapeout.net and open its container.', '1. 在 https://tapeout.net 购买一枚 TapeOut 电路并开通容器。'],
      ['2. Run the sidecar in front of your gateway: examples/new-api-sidecar (or litellm-sidecar, ai-proxy).', '2. 在你的网关前面运行旁路：examples/new-api-sidecar（或 litellm-sidecar、ai-proxy）。'],
      ['3. Holder console https://tapeapi.fun/console/ steps 3 to 5: service key, delegation, publish the manifest.', '3. 持有人操作台 https://tapeapi.fun/console/ 第 3 到 5 步：服务密钥、委托、发布清单。'],
      ['4. Check it: node sdk/bin/tapeapi-doctor.js <your TapeOut name>', '4. 检查：node sdk/bin/tapeapi-doctor.js <你的 TapeOut 名字>'],
      ['5. Full checklist: docs/guides/ai-providers.md, "From zero to live".', '5. 完整清单：docs/guides/zh-CN/ai-providers.md 的“从零到上线”。'],
    ]) say(L(en, zh))
    if (keep) {
      say(L(`\nStill running (Ctrl-C to stop). Try: curl -si ${epOf('openai-chat')}/chat/completions -H 'authorization: Bearer ${DEMO_KEY}' -H 'content-type: application/json' -d '{"model":"gpt-5-mini","messages":[{"role":"user","content":"hi"}]}'`, `\n仍在运行（Ctrl-C 停止）。试试上面的 curl 命令。`))
      say(`   ANTHROPIC_BASE_URL=${verify.url}    OPENAI_BASE_URL=${verify.url}/v1`)
      await new Promise((ok) => { process.once('SIGINT', ok); process.once('SIGTERM', ok) })
    }
    return { ok, steps, report }
  } finally {
    await verify?.close()
    await stack.close()
  }
}

if (MAIN) {
  const args = process.argv.slice(2)
  const lang = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : 'both'
  if (!['en', 'zh', 'both'].includes(lang) || args.some((a) => a.startsWith('-') && !['--keep', '--lang'].includes(a))) {
    console.error('usage: node examples/relay-trial/trial.mjs [--keep] [--lang en|zh|both]'); process.exit(2)
  }
  try {
    const r = await runTrial({ say: (s) => console.log(s), lang, keep: args.includes('--keep') })
    process.exit(r.ok ? 0 : 1)
  } catch (e) { console.error(`trial: ${e?.stack || e}`); process.exit(1) }
}
