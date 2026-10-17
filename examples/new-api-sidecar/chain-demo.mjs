#!/usr/bin/env node
// The whole path on one machine, with a FAKE chain: a fake new-api (fake-new-api.mjs, its own process) -> the price
// table converted from its GET /api/pricing (pricing-convert.mjs) -> the signing sidecar declaring openai-chat only
// (server.mjs, FORMATS=openai-chat) -> the manifest written to an in-process fake chain under a TapeOut name -> checked
// by tapeapi-doctor (both resolutions) and the SDK through that name, and by tapeapi-verify. No Docker, no real new-api, no key, no gas,
// nothing on a real chain; only 127.0.0.1.
// 一台机器上走完整条路径，用的是**假链**：模拟 new-api（fake-new-api.mjs，独立进程）-> 由它的 GET /api/pricing 转换出的价目表
// （pricing-convert.mjs）-> 只声明 openai-chat 的签名旁路（server.mjs，FORMATS=openai-chat）-> 清单写进进程内假链、挂在一个
// TapeOut 名字下 -> 由 tapeapi-doctor 与 SDK 按名字核验，再由 tapeapi-verify 核验。不用 Docker，没有真实 new-api、没有密钥、
// 不花 gas，真实链上什么都没有；只用 127.0.0.1。
//
// What it shows / 它证明什么: the converted table is accepted by the sidecar and by clients; the manifest declares exactly
// the openai-chat endpoint; a name on the (fake) chain resolves to it with its delegation; tapeapi-doctor passes by name;
// receipts verify (plain and streamed) with USD prices from the converted table; an altered byte is refused; a path of a
// format left out is refused by the sidecar (HTTP 400 naming FORMATS); the converter's --check is clean, then exits 1
// once the site changes a price.
// What it does not show / 不证明什么: anything about the real new-api (its auth, CORS, redemption, logs: E3 needs a real
// instance), a real chain, or which model actually ran (a receipt never proves that).
//
//   npm ci --no-audit --no-fund                      # once, at the repository root / 在仓库根目录，一次
//   node examples/new-api-sidecar/chain-demo.mjs     # exit 0 when every step passed / 每一步都通过时退出码 0
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTapeAPI, ai, sig, MAINNET } from '@tapeapi/sdk'
import { diagnose, formatReport } from '../../sdk/src/doctor.js'
import { createConformChain } from '../../sdk/test/helpers/conform-chain.mjs'
import { DEMO_KEY } from '../ai-proxy/fake-upstream.mjs'
import { startSidecar } from './server.mjs'
import { callAndVerify } from './smoke.mjs'
import { SAMPLE_PRICING } from './fake-new-api.mjs'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const VERIFY_BIN = here('../../sdk/bin/tapeapi-verify.js')
const CONVERT = here('pricing-convert.mjs')
const NAME = '42.7.tape'   // processor 7 is the fake chain's circuits contract / 假链上 7 号处理器就是它的电路合约
const RPC = ['http://rpc1', 'http://rpc2', 'http://rpc3']
const enc = new TextEncoder()

/** Start a program and wait for the line that says where it listens. / 启动程序，等它说出监听地址的那一行。 */
function startChild(args, re, stream = 'stdout') {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let text = ''
  child[stream].setEncoding('utf8')
  child[stream].on('data', (d) => { text += d })
  return new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error(`${args[0]} did not start:\n${text}`)), 15_000)
    const on = () => { const m = re.exec(text); if (m) { clearTimeout(t); child[stream].off('data', on); ok({ url: m[1], out: () => text, close: () => new Promise((r) => { if (child.exitCode !== null) return r(); child.once('exit', r); child.kill('SIGTERM') }) }) } }
    child[stream].on('data', on)
    child.once('exit', (c) => { clearTimeout(t); no(new Error(`${args[0]} exited (${c}):\n${text}`)) })
  })
}

/**
 * Run it. Returns { ok, steps: [{ step, ok, text }] }.
 * @param {{ say?: (line: string) => void }} [o]
 */
export async function runDemo({ say = () => {} } = {}) {
  const steps = []
  const step = (name, ok, text) => { steps.push({ step: name, ok: !!ok, text }); say(`${ok ? 'OK  ' : 'FAIL'} ${name}: ${text}`) }
  const dir = mkdtempSync(join(tmpdir(), 'tapeapi-chain-demo-'))
  const sitePricing = join(dir, 'site-pricing.json')
  writeFileSync(sitePricing, readFileSync(SAMPLE_PRICING))
  let upstream = null, sidecar = null, verify = null
  try {
    // 1. The fake new-api, as its own process. / 模拟 new-api，独立进程。
    upstream = await startChild([here('fake-new-api.mjs'), '--port', '0', '--pricing', sitePricing], /listening on (http:\/\/\S+)/)
    step('upstream', true, `fake new-api at ${upstream.url} (relay ${upstream.url}/v1; GET /api/pricing from a sample with placeholder names)`)

    // 2. Its price list, saved and converted, as an operator does (the rate confirmed explicitly). / 像运营者那样存下并转换。
    const save = async (p, f) => { const r = await fetch(upstream.url + p); writeFileSync(join(dir, f), Buffer.from(await r.arrayBuffer())); return join(dir, f) }
    const pricing = await save('/api/pricing', 'pricing.json'), status = await save('/api/status', 'status.json')
    const modelsFile = join(dir, 'models.json')
    const conv = spawnSync(process.execPath, [CONVERT, pricing, '--status', status, '--usd-exchange-rate', '7', '--out', modelsFile], { encoding: 'utf8' })
    const table = conv.status === 0 ? JSON.parse(readFileSync(modelsFile, 'utf8')) : []
    step('convert', conv.status === 0 && table.length > 0, conv.status === 0 ? `${table.length} model(s) priced in USD (display), ${(conv.stderr.match(/^REFUSED /mg) || []).length} refused with a reason, ${(conv.stderr.match(/^REVIEW /mg) || []).length} flagged for the operator` : conv.stderr.trim())
    if (conv.status !== 0) return { ok: false, steps }

    // 3. The fake chain, the TAP-10 way (the SDK's own test chain: factory, opener, DomainBinding, implementation slots):
    // circuit #42 of processor 7 owned by a fresh holder, its container opened and activated. Then the sidecar,
    // openai-chat only, with that identity. / 假链（SDK 自己的测试链，按 TAP-10）：7 号处理器的 42 号电路归新持有人，容器已开通并激活；
    // 然后是只声明 openai-chat、使用该身份的旁路。
    const holderKey = sig.randomPrivateKey(), signerKey = sig.randomPrivateKey()
    const now = Math.floor(Date.now() / 1000), expires = now + 90 * 86_400
    const chain = createConformChain()
    chain.state.headTime = now
    const c = chain.circuit(42, { holder: sig.privateKeyToAddress(holderKey) })
    chain.setAccount('42', c.container); chain.setCode(c.container)
    const delegationSig = sig.signDigest(sig.delegationDigest(56, MAINNET.hub, { container: c.container, signer: sig.privateKeyToAddress(signerKey), expires }), holderKey)
    sidecar = await startSidecar({
      env: { UPSTREAM_BASE_URL: `${upstream.url}/v1`, MODELS_FILE: modelsFile, FORMATS: 'openai-chat', SERVICE_NAME: 'Local demo relay', CIRCUITS: c.circuits, TOKEN_ID: '42', CONTAINER: c.container, DELEGATION_EXPIRES: String(expires), DELEGATION_SIG: delegationSig, SIGNER_KEY: signerKey },
      port: 0, host: '127.0.0.1', quiet: true, localPublicUrl: true, log: () => {},
    })
    const manifestText = await (await fetch(`${sidecar.url}/.well-known/tapeapi.json`)).text()
    const manifest = JSON.parse(manifestText)
    const formats = manifest.ai?.endpoints?.map((e) => e.format) ?? []
    step('sidecar', sidecar.state.ok && formats.length === 1 && formats[0] === 'openai-chat', `${sidecar.url}: manifest endpoints ${JSON.stringify(formats)}, ${manifest.ai?.models?.length ?? 0} model(s), signer ${manifest.signer}`)

    // 4. The manifest published as the container's file. Two clients read the chain: the TAP-10 / TAP-11 resolution
    // (conform: 'tap10', the default since 2.0) and the 1.x one (conform: false, what --no-conform runs).
    // 清单作为容器的文件发布。两个客户端读链：TAP-10 / TAP-11 解析（2.0 起的默认）与 1.x 解析（--no-conform）。
    chain.writeFile(c.container, '.well-known/tapeapi.json', manifestText)
    const base = { rpcUrls: RPC, quorum: 2, allowHttp: true, clock: () => now, quiet: true, onWarning: () => {}, fetch: (url, init) => (String(url).startsWith('http://rpc') ? chain.fetch(String(url), init) : globalThis.fetch(url, init)) }
    const api = createTapeAPI({ ...base, conform: 'tap10' }), apiOld = createTapeAPI({ ...base, conform: false })

    // 5. tapeapi-doctor by name, against the fake chain, in both resolutions. / 按名字跑 tapeapi-doctor，读假链，两种解析各一次。
    let report = null
    for (const [label, client] of [['doctor', api], ['doctor-no-conform', apiOld]]) {
      const rep = await diagnose(NAME, { api: client, allowHttp: true, fetch: globalThis.fetch })
      report ??= rep
      const notPass = rep.checks.filter((x) => x.status !== 'pass').map((x) => `${x.id} ${x.status} (${x.detail})`)
      step(label, rep.exitCode === 0, `tapeapi-doctor ${NAME} (fake chain, ${client === api ? "conform: 'tap10'" : 'conform: false'}): exit ${rep.exitCode}, ${rep.counts.pass} passed${notPass.length ? `; ${notPass.join(', ')}` : ''}`)
      if (rep.exitCode !== 0) say(formatReport(rep, { lang: 'en' }))
    }

    // 6. The SDK by name: the name resolved on the fake chain (delegation checked), then a plain and a streamed call, each
    // receipt checked with ai.verifyUsageReceipt against that on-chain manifest. createVerifyingFetch accepts http
    // endpoints only for a service resolved in development mode (a named service must be https), so it runs in that mode.
    // SDK 按名字：在假链上解析名字（核对委托），再做普通与流式调用，每份回执用 ai.verifyUsageReceipt 按链上清单核验。
    // createVerifyingFetch 只在开发模式下接受 http 端点（按名字解析的服务必须是 https），所以它以开发模式运行。
    const svc = await api.resolve(NAME)
    const model = table[0].id
    const headers = { authorization: `Bearer ${DEMO_KEY}`, 'content-type': 'application/json' }
    for (const [label, body] of [['plain', { model, messages: [{ role: 'user', content: 'Hello from the chain demo' }] }], ['streamed', { model, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'Stream this please' }] }]]) {
      const { res, envelope, verdict } = await callAndVerify({ manifest: svc.manifest, format: 'openai-chat', path: '/v1/chat/completions', body })
      const rc = envelope?.result
      step(`sdk-${label}`, svc.verified?.delegation === true && res.status === 200 && verdict.ok && rc?.prices?.[0]?.currency === 'USD', `resolved ${NAME} on the fake chain (delegation ${svc.verified?.delegation === true ? 'verified' : 'NOT verified'}); HTTP ${res.status}, model ${rc?.model}, tokens ${rc?.usage ? `${rc.usage.prompt_tokens}+${rc.usage.completion_tokens}` : '-'}, ${rc?.prices ? rc.prices.map((p) => `${p.amount} ${p.currency}`).join(' / ') : 'unpriced'}, receipt ${verdict.ok ? 'verified' : `FAILED ${verdict.problems.join('; ')}`}`)
    }
    const dev = await createTapeAPI({ dev: true }).resolve({ dev: sidecar.url })
    const reports = []
    const vfetch = ai.createVerifyingFetch({ api: createTapeAPI({ dev: true }), service: dev, onReport: (r) => reports.push(r) })
    const vres = await vfetch(`${dev.manifest.ai.endpoints[0].baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'Through createVerifyingFetch' }] }) })
    await vres.arrayBuffer()
    step('sdk-verifying-fetch', vres.status === 200 && reports[0]?.ok === true && dev.manifest.signer === svc.manifest.signer, `createVerifyingFetch (development mode, same signer as on chain): HTTP ${vres.status}, receipt ${reports[0]?.ok ? 'verified' : `FAILED ${reports[0]?.problems?.join('; ')}`}`)
    const chat = svc.manifest.ai.endpoints.find((e) => e.format === 'openai-chat').baseUrl

    // 7. One byte altered: refused. / 改动一个字节：被拒绝。
    const reqBytes = enc.encode(JSON.stringify({ model, messages: [{ role: 'user', content: 'Hi' }] }))
    const res = await fetch(`${chat}/chat/completions`, { method: 'POST', headers, body: reqBytes })
    const bytes = new Uint8Array(await res.arrayBuffer())
    const envelope = ai.decodeReceiptHeader(res.headers.get(ai.RECEIPT_HEADER))
    const check = (b) => ai.verifyUsageReceipt({ envelope, manifest: svc.manifest, requestBytes: reqBytes, responseBytes: b, path: '/v1/chat/completions', status: res.status, stream: false, maxSkewS: 300 })
    const altered = bytes.slice(); altered[Math.floor(altered.length / 2)] ^= 1
    const good = check(bytes), bad = check(altered)
    step('tamper', good.ok && !bad.ok, `original ${good.ok ? 'verified' : 'NOT verified'}; one byte altered: ${bad.ok ? 'verified (WRONG)' : `refused (${bad.problems.join('; ')})`}`)

    // 8. A format left out: refused by the sidecar (HTTP 400 naming FORMATS), never passed through without a receipt.
    // 未启用的格式：旁路拒绝（HTTP 400，点名 FORMATS），绝不无回执透传。
    const off = await fetch(`${sidecar.url}/v1/responses`, { method: 'POST', headers, body: JSON.stringify({ model, input: 'hi' }) })
    const offText = await off.text()
    let offBody = null
    try { offBody = JSON.parse(offText) } catch { /* not JSON: the step fails / 不是 JSON：这一步失败 */ }
    const refusedOff = off.status === 400 && off.headers.get(ai.SIDECAR_ERROR_HEADER) === '1' && !off.headers.get(ai.RECEIPT_HEADER) && offBody?.error?.code === 'bad_path' && /FORMATS/.test(offBody?.error?.message ?? '')
    step('format-off', refusedOff, `POST /v1/responses (not in FORMATS): HTTP ${off.status}${refusedOff ? ', refused by the sidecar naming FORMATS, not forwarded, no receipt' : ` (expected 400 naming FORMATS): ${offText.slice(0, 160)}`}`)

    // 9. tapeapi-verify (URL mode: it reads names from the real chain only, and this demo's chain is fake).
    // tapeapi-verify（地址模式：它只从真实链读名字，本演示的链是假的）。
    verify = await startChild([VERIFY_BIN, '--dev', sidecar.url, '--port', '0'], /listening on (http:\/\/\S+)/, 'stderr')
    const before = verify.out().length
    const vr = await fetch(`${verify.url}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hi through tapeapi-verify' }] }) })
    await vr.arrayBuffer()
    let line = ''
    for (let i = 0; i < 300 && !line; i++) { line = verify.out().slice(before).split('\n').find((l) => /\] (OK|FAIL)/.test(l)) ?? ''; if (!line) await new Promise((ok) => setTimeout(ok, 10)) }
    step('verify', vr.status === 200 && /\] OK/.test(line), `tapeapi-verify --dev ${sidecar.url}: ${line.replace(/^\[tapeapi-verify\] /, '').trim() || '(no verdict line)'}`)

    // 10. The converter's drift check: clean, then the site changes one price. / 漂移检查：先无漂移，再让站点改一个价。
    const runCheck = () => spawnSync(process.execPath, [CONVERT, '--check', pricing, '--models', modelsFile], { encoding: 'utf8' })
    const clean = runCheck()
    const changed = JSON.parse(readFileSync(sitePricing, 'utf8'))
    const target = changed.data.find((m) => m.model_name === model)
    target.model_ratio = Number(target.model_ratio) * 2
    writeFileSync(sitePricing, JSON.stringify(changed))
    await save('/api/pricing', 'pricing.json')
    const drifted = runCheck()
    step('check', clean.status === 0 && drifted.status === 1 && /DRIFT price-changed/.test(drifted.stderr), `--check before: exit ${clean.status}; after the site doubled ${model}'s ratio: exit ${drifted.status} (${(drifted.stderr.match(/^DRIFT [^:]+/m) || ['no drift line'])[0]})`)

    return { ok: steps.every((s) => s.ok), steps, report }
  } finally {
    await verify?.close()
    await sidecar?.close()
    await upstream?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const r = await runDemo({ say: (l) => console.log(l) })
    console.log(r.ok ? 'chain demo passed (fake new-api, fake chain: receipts prove who signed which bytes and the claimed usage and price, not which model ran)' : 'chain demo FAILED')
    process.exit(r.ok ? 0 : 1)
  } catch (e) { console.error(`chain demo: ${e?.stack || e}`); process.exit(1) }
}
