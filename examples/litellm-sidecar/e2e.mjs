#!/usr/bin/env node
// End to end against a REAL LiteLLM Proxy: the official `openai` and `@anthropic-ai/sdk` packages (devDependencies of
// the repository root), streamed and not, through ai.createVerifyingFetch in strict mode (an unverified answer throws),
// plus the raw calls of smoke.mjs checked byte for byte. LiteLLM's models point at the repository's FAKE upstream
// (examples/ai-proxy/fake-upstream.mjs): no real model, no real key. Not part of `npm test` (it needs LiteLLM).
// 对着**真实的** LiteLLM Proxy 端到端：官方 openai 与 @anthropic-ai/sdk 包，流式与非流式，经 strict 模式的 ai.createVerifyingFetch
// （核验不过就抛出），外加 smoke.mjs 的原始调用按字节核验。LiteLLM 的模型指向仓库的**模拟**上游：没有真实模型、没有真实密钥。
// 不在 npm test 里（需要 LiteLLM）。
//
// Either start LiteLLM here (pip install 'litellm[proxy]==1.103.0'; the script writes the config and starts the fake):
//   LITELLM_BIN=$(which litellm) node examples/litellm-sidecar/e2e.mjs
// or use one already running whose model_names are those of models.example.json (e.g. docker compose with a config
// pointing at `node examples/ai-proxy/fake-upstream.mjs`):
//   LITELLM_URL=http://127.0.0.1:4000 LITELLM_KEY=<a key it accepts> node examples/litellm-sidecar/e2e.mjs
// 要么由脚本启动 LiteLLM（LITELLM_BIN），要么使用已经在运行的（LITELLM_URL 与 LITELLM_KEY）。
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTapeAPI, ai, sig } from '@tapeapi/sdk'
import { startFakeUpstream, DEMO_KEY } from '../ai-proxy/fake-upstream.mjs'
import { startStack, callAndVerify, streamProblems, CALLS } from './smoke.mjs'
import { startSidecar as startPlainSidecar } from '../new-api-sidecar/server.mjs'

/** A LiteLLM config whose model_names are models.example.json's ids, all served by the fake upstream. / 指向模拟上游的配置。 */
export function fakeConfig(fakeBaseUrl, masterKey) {
  const root = fakeBaseUrl.replace(/\/v1$/, '')
  const openai = (name, model = name) => `  - model_name: ${name}\n    litellm_params: { model: "openai/${model}", api_base: "${fakeBaseUrl}", api_key: "${DEMO_KEY}" }\n`
  return 'model_list:\n' + openai('gpt-5-mini') + openai('deepseek-chat') + openai('text-embedding-3-small') +
    `  - model_name: claude-sonnet-4-5\n    litellm_params: { model: "anthropic/claude-sonnet-4-5-20250929", api_base: "${root}", api_key: "${DEMO_KEY}" }\n` +
    `general_settings:\n  master_key: "${masterKey}"\n`
}

async function waitFor(url, ms) {
  const until = Date.now() + ms
  for (;;) {
    try { if ((await fetch(url)).ok) return } catch { /* not up yet */ }
    if (Date.now() > until) throw new Error(`${url} did not answer within ${ms / 1000} s`)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

/** A LiteLLM Proxy started from LITELLM_BIN in front of a fresh fake upstream. / 由 LITELLM_BIN 启动的 LiteLLM。 */
async function startLiteLLM(bin) {
  const fake = await startFakeUpstream()
  const dir = mkdtempSync(join(tmpdir(), 'litellm-e2e-'))
  const key = `sk-e2e-${sig.randomPrivateKey().slice(2, 26)}`
  writeFileSync(join(dir, 'config.yaml'), fakeConfig(fake.baseUrl, key))
  const port = 40_000 + Math.floor(Math.random() * 10_000)
  // Local only: no outbound proxy for loopback, and the bundled cost map instead of a download at start.
  // 只在本机：回环地址不走出站代理；用内置的价格表，不在启动时下载。
  const env = { ...process.env, LITELLM_LOCAL_MODEL_COST_MAP: 'True', NO_PROXY: '*', no_proxy: '*' }
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[k]
  const child = spawn(bin, ['--config', join(dir, 'config.yaml'), '--host', '127.0.0.1', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (b) => { log += b }); child.stderr.on('data', (b) => { log += b })
  const exited = new Promise((r) => child.once('exit', r))
  const close = async () => {
    child.kill('SIGTERM')
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))])
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await fake.close(); rmSync(dir, { recursive: true, force: true })
  }
  try { await waitFor(`http://127.0.0.1:${port}/health/liveliness`, 180_000) } catch (e) { await close(); throw new Error(`${e.message}\n${log.slice(-2000)}`) }
  return { url: `http://127.0.0.1:${port}`, key, close }
}

async function main() {
  const { default: OpenAI } = await import('openai')
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  let litellm
  if (process.env.LITELLM_URL) litellm = { url: process.env.LITELLM_URL.replace(/\/+$/, ''), key: process.env.LITELLM_KEY || '', close: async () => {} }
  else if (process.env.LITELLM_BIN) litellm = await startLiteLLM(process.env.LITELLM_BIN)
  else { console.error('[e2e] set LITELLM_BIN (a litellm executable) or LITELLM_URL and LITELLM_KEY (a running proxy); see the header of this file'); process.exit(2) }
  const stack = await startStack({ upstreamBaseUrl: `${litellm.url}/v1` })
  let failed = 0
  const line = (good, label, detail) => { if (!good) failed++; console.log(`[e2e] ${good ? 'OK  ' : 'FAIL'} ${label.padEnd(36)} ${detail}`) }
  try {
    console.log(`[e2e] client -> sidecar ${stack.sidecar.url} -> LiteLLM at ${litellm.url} -> fake upstream`)
    // 1. Raw calls, every receipt checked over the exact bytes. / 原始调用，按确切字节核验每一份回执。
    const auth = (format) => (format === 'anthropic-messages' ? { 'x-api-key': litellm.key } : { authorization: `Bearer ${litellm.key}` })
    for (const c of CALLS) {
      const { res, stream, envelope, verdict, responseBytes } = await callAndVerify({ manifest: stack.manifest, ...c, headers: auth(c.format) })
      const r = envelope?.result
      const extra = stream ? streamProblems({ path: c.path, body: c.body, responseBytes }) : []
      const problems = [...verdict.problems, ...extra]
      // LiteLLM's own headers pass through the sidecar. / LiteLLM 自己的响应头经旁路原样到达。
      if (c === CALLS[0]) console.log(`[e2e]      x-litellm-version: ${res.headers.get('x-litellm-version')}`)
      line(res.status === 200 && verdict.ok && !!r?.prices && r.complete === true && !problems.length, `raw ${c.label}`,
        `HTTP ${res.status} model=${r?.model} tokens=${r?.usage ? `${r.usage.prompt_tokens}+${r.usage.completion_tokens}` : '-'} ${r?.prices ? r.prices.map((p) => `${p.amount} ${p.currency}`).join(' / ') : 'unpriced'}${problems.length ? `  problems: ${problems.join('; ')}` : ''}`)
    }
    // 2. The official SDKs, strict: an answer whose receipt does not verify throws. / 官方 SDK，strict：回执核验不过即抛出。
    const api = createTapeAPI({ dev: true })
    const service = await api.resolve({ dev: stack.sidecar.url })
    const reports = []
    const vf = ai.createVerifyingFetch({ api, service, onReport: (r) => reports.push(r) })
    const oa = new OpenAI({ baseURL: `${stack.sidecar.url}/v1`, apiKey: litellm.key, fetch: vf, maxRetries: 0 })
    const an = new Anthropic({ baseURL: stack.sidecar.url, apiKey: litellm.key, fetch: vf, maxRetries: 0 })
    // As Claude Code sends it with ANTHROPIC_AUTH_TOKEN: Authorization: Bearer, no x-api-key. / 与 Claude Code 用 ANTHROPIC_AUTH_TOKEN 时相同。
    const anBearer = new Anthropic({ baseURL: stack.sidecar.url, apiKey: null, authToken: litellm.key, fetch: vf, maxRetries: 0 })
    const settle = () => new Promise((r) => setTimeout(r, 50))
    const sdkCase = async (label, run) => {
      reports.length = 0
      let out, error = null
      try { out = await run(); await settle() } catch (e) { error = e }
      const r = reports.at(-1)
      const good = !error && reports.length === 1 && r.ok
      line(good, label, error ? `threw ${error.code ?? ''} ${error.message}` : `${r?.stream ? 'stream' : 'json  '} model=${r?.receipt?.result.model} usage=${JSON.stringify(r?.receipt?.result.usage)} ${out ?? ''}${r && !r.ok ? `  problems: ${r.problems.join('; ')}` : ''}`)
    }
    const text = async (s, pick) => { let t = ''; for await (const e of s) t += pick(e) ?? ''; return JSON.stringify(t) }
    await sdkCase('openai chat.completions', async () => JSON.stringify((await oa.chat.completions.create({ model: 'gpt-5-mini', messages: [{ role: 'user', content: 'hello' }] })).choices[0].message.content))
    await sdkCase('openai chat.completions stream', async () => text(await oa.chat.completions.create({ model: 'deepseek-chat', stream: true, messages: [{ role: 'user', content: 'stream please' }] }), (c) => c.choices[0]?.delta?.content))
    await sdkCase('openai chat.completions stream+usage', async () => text(await oa.chat.completions.create({ model: 'deepseek-chat', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'stream please' }] }), (c) => c.choices[0]?.delta?.content))
    await sdkCase('openai responses', async () => JSON.stringify((await oa.responses.create({ model: 'gpt-5-mini', input: 'hello' })).output_text))
    await sdkCase('openai responses stream', async () => text(await oa.responses.create({ model: 'gpt-5-mini', stream: true, input: 'hello' }), (e) => (e.type === 'response.output_text.delta' ? e.delta : '')))
    await sdkCase('openai responses.stream()', async () => JSON.stringify((await oa.responses.stream({ model: 'gpt-5-mini', input: 'hello' }).finalResponse()).output_text))
    await sdkCase('openai embeddings', async () => `dims=${(await oa.embeddings.create({ model: 'text-embedding-3-small', input: 'tape out' })).data[0].embedding.length}`)
    await sdkCase('anthropic messages', async () => JSON.stringify((await an.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] })).content[0].text))
    await sdkCase('anthropic messages stream', async () => text(await an.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hello' }] }), (e) => (e.type === 'content_block_delta' ? e.delta.text : '')))
    await sdkCase('anthropic stream, Bearer (Claude Code)', async () => text(await anBearer.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hello' }] }), (e) => (e.type === 'content_block_delta' ? e.delta.text : '')))
    await sdkCase('anthropic messages.stream()', async () => JSON.stringify((await an.messages.stream({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }).finalMessage()).content[0].text))
    // 3. Control: the same sidecar without litellmFormats (the new-api package's, plain ai.FORMATS) puts the Responses
    // receipt after LiteLLM's `data: [DONE]`, and a strict client refuses the stream. / 对照：不带 litellmFormats 时严格客户端拒绝。
    const plain = await startStack({ upstreamBaseUrl: `${litellm.url}/v1`, start: startPlainSidecar })
    try {
      const svc = await api.resolve({ dev: plain.sidecar.url })
      const client = new OpenAI({ baseURL: `${plain.sidecar.url}/v1`, apiKey: litellm.key, fetch: ai.createVerifyingFetch({ api, service: svc, onReport: () => {} }), maxRetries: 0 })
      let code = null
      try { for await (const e of await client.responses.create({ model: 'gpt-5-mini', stream: true, input: 'hello' })) void e } catch (e) { code = e.code ?? e.message }
      line(code === 'RECEIPT_INVALID', 'control: plain ai.FORMATS, responses', code === 'RECEIPT_INVALID' ? 'refused as expected (RECEIPT_INVALID): the adjustment is needed' : `expected RECEIPT_INVALID, got ${code ?? 'a verified stream'}`)
    } finally { await plain.close() }
  } finally { await stack.close(); await litellm.close() }
  console.log(failed ? `[e2e] ${failed} check(s) FAILED` : '[e2e] every receipt verified, through LiteLLM and both official SDKs')
  process.exit(failed ? 1 : 0)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main()
